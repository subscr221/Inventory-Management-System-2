import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getServiceOrderById } from '../read/projections/service_order.js';
import { getBomById, getBomLines } from '../read/projections/bom.js';
import {
  JOBWORK_MATERIAL_RECEIVED,
  JOB_WORK_STOCK_CLASS,
  RECEIVING_HANDOFF,
  orderAcceptsReceipt,
} from './jobwork-receipt.js';
import { kitLineMatchesConsumption } from './custody-ledger.js';
import { assertActorAtSite } from './actor-site.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getLocationById, getLocationByCode } from '../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';
import { getPurchaseOrderByRef } from '../read/projections/erp_purchase_order.js';
import { getWeighbridgeEventsByCorrelationId } from '../read/projections/weighbridge_event.js';
import type { WeighbridgeEvent } from '../read/projections/weighbridge_event.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import { getGrnById, insertGrnHeader } from '../read/projections/grn.js';
import type { Grn } from '../read/projections/grn.js';
import { insertGrnLine } from '../read/projections/grn_line.js';
import {
  insertPutawayTask,
  getPutawayTaskById,
  markPutawayReleased,
} from '../read/projections/putaway_task.js';
import { findCrossDockDemandMatch } from '../read/projections/erp_sales_order.js';
import { insertCrossDockTask } from '../read/projections/cross_dock_task.js';
import { isCrossDockQuantityCapacity } from './cross-dock.js';
import { applyLotSerialValidation } from './lot-serial-validation.js';
import { applyStockBalanceProjection } from './stock-balance.js';
import { applyInventoryValuationProjection } from './inventory-valuation.js';

/**
 * Central receiving compliance seam (Story 3.4). Split like every other seam: assert* runs BEFORE any
 * DB write (a malformed goods.received/goods.putaway_released event consumes no idempotency key);
 * apply* runs INSIDE the event transaction, so the GRN line, the stock movement it drives, and the
 * domain_events insert commit or roll back together.
 *
 * The gate-token chain (AD-2) is consumed here: receiving opens only against a Story 3.3 accepted
 * weighment for the Story 3.2 binding token. The stock movement is posted through a synthetic
 * stock.received view fed to the existing Story 2.2/2.3/2.8 projection helpers so lot auto-create,
 * serial receipt, owner-party gating, and NUMERIC precision are all inherited (never duplicated).
 * This seam NEVER writes any erp_* projection - the ERP remains the PO system of record (AC6).
 */

const RECEIVING_STREAM_TYPES = new Set(['receiving']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UNIT_COST_REGEX = /^\d+(\.\d+)?$/;
/**
 * The currency the inventory books are kept in. The platform has no configurable books currency:
 * valuation carries no currency column and supplier invoices accept INR only
 * (SUPPORTED_CURRENCIES in supplier-invoice.ts), so INR it is until multi-currency is designed.
 */
const BOOKS_CURRENCY = 'INR';
const NUMERIC_REGEX = /^\d{1,15}(\.\d{1,3})?$/;

/**
 * Pilot Ruling B: the third source document. Customer-owned job-work material is received against
 * the job-work (service) order plus the customer's challan - no purchase order, weighbridge
 * optional. It is a KIND of goods.received, not a parallel pipeline: only the purchase-order steps
 * are skipped, everything from the expiry check onward is the one Story 3.4 / 9.2 path.
 */
export const JOBWORK_CHALLAN_SOURCE = 'JOBWORK_CHALLAN';
/** The GRN route is store-assistant only; with no gate chain behind it this kind holds that on every door. */
const JOBWORK_CHALLAN_RECEIVER_ROLES = new Set(['store_assistant']);

const QC_HOLD_ZONE_CODE = 'ZONE-QC-HOLD';
const DISCREPANCY_TARGET_ROLE = 'unloading_supervisor';
const QC_INSPECTION_TARGET_ROLE = 'qc_inspector';

/** DOA transaction types gating the AC7 expired-lot quarantine and the AC3 held-putaway release. */
const QUARANTINE_DOA_TYPE = 'receiving.quarantine';
const PUTAWAY_RELEASE_DOA_TYPE = 'receiving.putaway_release';
/** AC3/AC7: only a named receiving supervisor may authorize a quarantine or release a held task. */
const RECEIVING_APPROVER_ROLES = new Set(['unloading_supervisor', 'warehouse_manager']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return isNonEmptyString(value) && UUID_REGEX.test(value);
}

function localYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Normalizes a positive NUMERIC quantity (number or numeric string) to a string, or null. */
function normalizeQty(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? String(value) : null;
  if (typeof value === 'string') {
    const s = value.trim();
    return NUMERIC_REGEX.test(s) && !/^0+(\.0+)?$/.test(s) ? s : null;
  }
  return null;
}

function receivingEventType(
  envelope: EventEnvelope,
): 'goods.received' | 'goods.putaway_released' | null {
  if (!RECEIVING_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (envelope.event_type === 'goods.received') return 'goods.received';
  if (envelope.event_type === 'goods.putaway_released') return 'goods.putaway_released';
  return null;
}

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/** Resolves an active holder of `role` (honoring an active vacation delegation), or null. */
async function resolveActiveHolder(role: string, client: PoolClient): Promise<string | null> {
  const holder = await findRoleHolder(role, client);
  if (!holder) return null;
  const delegation = await findActiveDelegation(holder.user_id, localYmd(new Date()), client);
  return delegation?.delegate_user_id ?? holder.user_id;
}

/**
 * AC7 quarantine approval (Task 5.3.4). The scan-first store assistant captures the expired-lot
 * quarantine receipt; the supervisor authority is verified to be a real, resolvable DOA holder. A
 * governing band must exist AND its role (or a fallback authority) must have an active holder;
 * otherwise APPROVAL_REQUIRED. Resolves the Task 7.2 (create = store_assistant only) vs Task 5.3.4
 * tension in favor of the scan-first UX while still gating on a resolvable DOA authority.
 */
async function assertQuarantineApproval(client: PoolClient): Promise<void> {
  const entry = await findMatchingDoaEntry(QUARANTINE_DOA_TYPE, 0, client);
  if (!entry)
    throw new AppError(
      403,
      'APPROVAL_REQUIRED',
      'An expired-lot quarantine receipt requires a DOA-governed supervisor approval',
      { transaction_type: QUARANTINE_DOA_TYPE },
    );
  let approver = await resolveActiveHolder(entry.role, client);
  if (!approver) {
    for (const e of await listActiveDoaEntries(QUARANTINE_DOA_TYPE, client)) {
      if (e.role === entry.role) continue;
      approver = await resolveActiveHolder(e.role, client);
      if (approver) break;
    }
  }
  if (!approver)
    throw new AppError(
      403,
      'APPROVAL_REQUIRED',
      'No active supervisor could be resolved to approve the quarantine receipt',
      { transaction_type: QUARANTINE_DOA_TYPE },
    );
}

/**
 * AC3 held-putaway release approval (Task 6.1). The release endpoint is already supervisor-only; this
 * is defense-in-depth: a governing band must exist AND the authenticated actor must be an authorized
 * receiving supervisor (so a direct event POST cannot bypass the endpoint RBAC).
 */
async function assertReleaseApproval(actorRole: string, client: PoolClient): Promise<void> {
  const entry = await findMatchingDoaEntry(PUTAWAY_RELEASE_DOA_TYPE, 0, client);
  if (!entry || !RECEIVING_APPROVER_ROLES.has(actorRole)) {
    throw new AppError(
      403,
      'APPROVAL_REQUIRED',
      'Releasing a held putaway task requires a DOA-resolved receiving supervisor approval',
      {
        transaction_type: PUTAWAY_RELEASE_DOA_TYPE,
        actor_role: actorRole,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// goods.received
// ---------------------------------------------------------------------------

/**
 * Pre-transaction shape validation (Story 3.4, Task 5.2). Runs before any DB write. Does NOT resolve
 * any DB reference - existence/tolerance/QC-hold checks all live in the in-transaction apply.
 */
export function assertGoodsReceivedShape(envelope: EventEnvelope): void {
  if (receivingEventType(envelope) !== 'goods.received') return;
  const p = envelope.payload;
  // Pilot Ruling B: a customer challan receipt names no purchase order and the weighbridge ticket
  // is optional. Every other source document keeps the Story 3.4 shape below untouched.
  const challanReceipt = p['source_document'] === JOBWORK_CHALLAN_SOURCE;

  if (challanReceipt) {
    if (p['correlation_id'] !== undefined && p['correlation_id'] !== null) {
      if (!isUuid(p['correlation_id']))
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'correlation_id (weighbridge ticket) must be a UUID when supplied',
        );
    }
  } else if (!isUuid(p['correlation_id']))
    throw new AppError(
      400,
      'RECEIVING_BINDING_TOKEN_REQUIRED',
      'correlation_id (binding token) is required and must be a UUID',
    );
  if (!isUuid(p['grn_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'grn_id is required and must be a UUID');
  if (!isUuid(p['grn_line_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'grn_line_id is required and must be a UUID');
  if (challanReceipt) {
    // No purchase order, and no cost basis either: customer-owned stock is never valued, so a
    // unit_cost on it is refused rather than silently ignored.
    for (const field of ['po_ref_ext', 'line_no', 'unit_cost']) {
      if (p[field] !== undefined && p[field] !== null)
        throw new AppError(
          400,
          'INVALID_PARAMS',
          `${field} must not be supplied on a ${JOBWORK_CHALLAN_SOURCE} receipt`,
          { field },
        );
    }
    if (p['stock_class'] !== JOB_WORK_STOCK_CLASS)
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `a ${JOBWORK_CHALLAN_SOURCE} receipt must carry stock_class '${JOB_WORK_STOCK_CLASS}'`,
        { stock_class: p['stock_class'] ?? null },
      );
    // Cross-dock matches OWNED stock to open sales demand; customer material has neither.
    if (p['cross_dock'] === true)
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `cross_dock is not available on a ${JOBWORK_CHALLAN_SOURCE} receipt`,
        { field: 'cross_dock' },
      );
  } else {
    if (!isNonEmptyString(p['po_ref_ext']))
      throw new AppError(400, 'INVALID_PARAMS', 'po_ref_ext is required');
    p['po_ref_ext'] = (p['po_ref_ext'] as string).trim();

    const lineNo = p['line_no'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0)
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'line_no is required and must be a positive integer',
      );
  }
  if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
  p['sku'] = (p['sku'] as string).trim();

  const normalizedQty = normalizeQty(p['received_qty']);
  if (normalizedQty === null)
    throw new AppError(
      400,
      'RECEIVING_QTY_REQUIRED',
      'received_qty is required and must be a positive NUMERIC value',
    );
  p['received_qty'] = normalizedQty;

  if (!challanReceipt && p['source_document'] !== 'PO' && p['source_document'] !== 'ASN')
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `source_document must be 'PO', 'ASN' or '${JOBWORK_CHALLAN_SOURCE}'`,
    );

  if (!isNonEmptyString(p['target_location_id']) && !isNonEmptyString(p['target_location_code'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'target_location_id or target_location_code is required',
    );
  }

  // Pilot B4: unit_cost is optional (the PO line price is the default cost basis), but a supplied
  // value feeds Story 2.4 valuation, so it must be a non-negative number or plain decimal string.
  // Validated WITHOUT rewriting the payload: a NUMERIC travels as a string, so the stored event
  // keeps the exact decimal that was submitted. Only the stock.received view built in the applier
  // converts it, because the valuation seam consumes a number.
  if (p['unit_cost'] !== undefined && p['unit_cost'] !== null) {
    const raw = p['unit_cost'];
    const unitCost =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && UNIT_COST_REGEX.test(raw)
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(unitCost) || unitCost < 0)
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'unit_cost must be a non-negative number when supplied',
      );
  }

  if (p['expiry_date'] !== undefined && p['expiry_date'] !== null) {
    if (typeof p['expiry_date'] !== 'string' || !DATE_REGEX.test(p['expiry_date'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'expiry_date must be a YYYY-MM-DD string when supplied',
      );
    }
  }

  if (p['quarantine_approved'] === true && !isNonEmptyString(p['quarantine_reason_code'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'quarantine_reason_code is required when quarantine_approved is true',
    );
  }

  if (p['cross_dock'] !== undefined && typeof p['cross_dock'] !== 'boolean') {
    throw new AppError(400, 'INVALID_PARAMS', 'cross_dock must be a boolean when supplied');
  }
  const hasStagingId = p['staging_zone_id'] !== undefined;
  const hasStagingCode = p['staging_zone_code'] !== undefined;
  const hasCrossDockTaskId = p['cross_dock_task_id'] !== undefined;
  if (p['cross_dock'] !== true && (hasStagingId || hasStagingCode || hasCrossDockTaskId)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'cross-dock-only fields require cross_dock to be true',
    );
  }
  if (p['cross_dock'] === true) {
    if (hasStagingId === hasStagingCode) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'exactly one of staging_zone_id or staging_zone_code is required when cross_dock is true',
      );
    }
    if (hasStagingId && !isUuid(p['staging_zone_id'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'staging_zone_id must be a UUID when supplied');
    }
    if (hasStagingCode && !isNonEmptyString(p['staging_zone_code'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'staging_zone_code must be non-empty when supplied',
      );
    }
    if (!isUuid(p['cross_dock_task_id'])) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'cross_dock_task_id is required and must be a server-generated UUID when cross_dock is true',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// goods.received against a customer challan (Pilot Ruling B)
// ---------------------------------------------------------------------------

/**
 * The gates a customer challan receipt passes IN PLACE OF the purchase order, inside the event
 * transaction so the REST route, the events door and the edge all get the same answer. Returns the
 * receiving site (the order's site - there may be no weighment to name one).
 *
 * The order's existence, status, site and customer binding are re-derived under the order lock by
 * the Story 9.2 seam gates further down (assertJobworkReceiptOwnership, then the custody applier);
 * the read here is what THIS seam needs before it can post anything: a site, the expected items
 * and the duplicate-challan check.
 */
async function assertJobworkChallanReceipt(
  envelope: EventEnvelope,
  sku: string,
  accepted: WeighbridgeEvent | null,
  client: PoolClient,
): Promise<{ site_id: string; site_code_ext: string }> {
  const p = envelope.payload;
  const actor = envelope.metadata.actor;
  if (!JOBWORK_CHALLAN_RECEIVER_ROLES.has(actor.role)) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `This operation is restricted to roles: ${[...JOBWORK_CHALLAN_RECEIVER_ROLES].join(', ')}`,
      { actor_role: actor.role },
    );
  }
  const refuse = (message: string, details: Record<string, unknown>): never => {
    throw new AppError(409, 'SOURCE_DOCUMENT_REQUIRED', message, { sku, ...details });
  };
  if (!isUuid(p['service_order_id'])) {
    refuse(
      'Customer material can only be received against a confirmed service order (service_order_id is required)',
      { service_order_id: p['service_order_id'] ?? null },
    );
  }
  const serviceOrderId = p['service_order_id'] as string;
  if (
    !isNonEmptyString(p['challan_number_ext']) ||
    typeof p['challan_date'] !== 'string' ||
    !DATE_REGEX.test(p['challan_date'])
  ) {
    refuse(
      'Customer material can only be received with the inbound challan (challan_number_ext and a YYYY-MM-DD challan_date are required)',
      { service_order_id: serviceOrderId },
    );
  }
  const order = await getServiceOrderById(serviceOrderId, client);
  if (!order || !orderAcceptsReceipt(order.status)) {
    return refuse(
      order
        ? `A job_work receipt requires a confirmed service order; this order is ${order.status}`
        : 'A job_work receipt requires a confirmed service order; none exists for service_order_id',
      { service_order_id: serviceOrderId, ...(order ? { status: order.status } : {}) },
    );
  }
  await assertActorAtSite(
    actor.location_id,
    order.site_id,
    { service_order_id: serviceOrderId },
    client,
  );
  if (accepted && accepted.site_id !== order.site_id) {
    refuse('The weighbridge ticket belongs to a different site than the service order', {
      service_order_id: serviceOrderId,
      order_site_id: order.site_id,
      ticket_site_id: accepted.site_id,
    });
  }
  // A ticket weighed against a purchase order vouches for THAT delivery, not for customer material.
  // Every ticket the gate and weighbridge issue today is PO-bound (po_ref_ext is mandatory there),
  // so until they support job-work a challan receipt is ticketless in practice.
  if (accepted && isNonEmptyString(accepted.po_ref_ext)) {
    throw new AppError(
      409,
      'RECEIVING_TICKET_PO_BOUND',
      'The weighbridge ticket was issued against a purchase order and cannot be attached to a customer challan receipt',
      { correlation_id: accepted.correlation_id, ticket_po_ref_ext: accepted.po_ref_ext },
    );
  }
  const site = await getLocationById(order.site_id, client);
  if (!site || site.status !== 'active') {
    throw new AppError(
      400,
      'LOCATION_NOT_FOUND',
      'The service order site is not registered or not active',
      { site_id: order.site_id },
    );
  }

  // Expected materials. A service order carries no material lines of its own; what the customer is
  // expected to send is the customer-supplied (or still untagged) lines of the CURRENT revision of
  // its kit BOM - the same predicate custody consumption later posts against. An order with NO kit
  // BOM (one migrated in already confirmed; the Story 9.1 confirm gate makes it impossible
  // otherwise) names no expected items, so there is nothing to hold the sku against.
  const bom = order.kit_bom_id ? await getBomById(order.kit_bom_id, client) : null;
  const lines = bom?.current_revision_id ? await getBomLines(bom.current_revision_id, client) : [];
  if (order.kit_bom_id && !lines.some((line) => kitLineMatchesConsumption(line, sku))) {
    throw new AppError(
      409,
      'KIT_LINE_MISMATCH',
      'The sku is not a customer-supplied line on the current revision of the order kit BOM',
      {
        service_order_id: serviceOrderId,
        kit_bom_id: order.kit_bom_id ?? null,
        kit_bom_revision_id: bom?.current_revision_id ?? null,
        sku,
      },
    );
  }

  // The duplicate-challan check needs the RESOLVED lot, which only exists once the stock view has
  // been through lot validation - so the lock is taken here and the check runs further down.
  await lockJobworkChallan(order.customer_party_code, p['challan_number_ext'] as string, client);
  return { site_id: order.site_id, site_code_ext: site.location_code };
}

function challanLockKey(customerPartyCode: string, challanNumber: string): string {
  return `jobwork-challan:${customerPartyCode}:${challanNumber.trim().toUpperCase()}`;
}

/** Serializes every receipt of one customer's challan, on either receiving path, until commit. */
async function lockJobworkChallan(
  customerPartyCode: string,
  challanNumber: string,
  client: PoolClient,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    challanLockKey(customerPartyCode, challanNumber),
  ]);
}

/**
 * Duplicate challan: one receipt per customer, challan number (trimmed, case-insensitive), sku and
 * LOT. A challan may list several items and several lots (heats) of one item, one GRN line each;
 * the same lot twice - or a non-lot item twice - is the same paper keyed again. The lot compared is
 * the RESOLVED lot number (payload lot_id, or the lot the Story 2.3 helpers auto-resolved), which
 * is what jobwork_material_receipt.lot_id stores. Counted against custody receipts from EITHER
 * receiving path and across all of the customer's orders; the caller holds lockJobworkChallan. A
 * genuine replay never reaches here - persistEvent answers it from the stored event.
 */
async function assertChallanNotDuplicate(
  challan: { customerPartyCode: string; challanNumber: string; sku: string; lotId: string | null },
  serviceOrderId: string,
  client: PoolClient,
): Promise<void> {
  const duplicate = await client.query(
    `SELECT r.receipt_id, r.service_order_id
       FROM jobwork_material_receipt r
       JOIN service_order so ON so.service_order_id = r.service_order_id
      WHERE so.customer_party_code = $1 AND upper(btrim(r.challan_number_ext)) = $2
        AND r.sku = $3 AND r.lot_id IS NOT DISTINCT FROM $4::text
      LIMIT 1`,
    [
      challan.customerPartyCode,
      challan.challanNumber.trim().toUpperCase(),
      challan.sku,
      challan.lotId,
    ],
  );
  if (duplicate.rows.length > 0) {
    throw new AppError(
      409,
      'JOBWORK_CHALLAN_DUPLICATE',
      'This customer challan has already been received for this item and lot',
      {
        service_order_id: serviceOrderId,
        customer_party_code: challan.customerPartyCode,
        challan_number_ext: challan.challanNumber.trim(),
        sku: challan.sku,
        lot_id: challan.lotId,
        existing_receipt_id: duplicate.rows[0]!['receipt_id'] as string,
        existing_service_order_id: duplicate.rows[0]!['service_order_id'] as string,
      },
    );
  }
}

/**
 * A GRN header is written by its FIRST line and never overwritten (insertGrnHeader), so a later
 * line carrying a different source document, purchase order or site would silently ride a header
 * that does not describe it - a challan line under a PO header, or the reverse. Refused here for
 * every kind. For a customer challan GRN the header has no order column, so the order is read back
 * from the custody receipts of the lines already on it. A second line that matches its header is
 * untouched, exactly as before.
 */
async function assertGrnHeaderMatches(
  p: Record<string, unknown>,
  poRef: string | null,
  siteId: string,
  client: PoolClient,
): Promise<void> {
  const header = await getGrnById(p['grn_id'] as string, client);
  if (!header) return;
  const mismatch = (field: string, existing: unknown, supplied: unknown): never => {
    throw new AppError(
      409,
      'GRN_HEADER_MISMATCH',
      `This GRN already exists with a different ${field}; a line must match the header it joins`,
      { grn_id: header.grn_id, field, existing, supplied },
    );
  };
  if (header.source_document !== p['source_document'])
    mismatch('source_document', header.source_document, p['source_document'] ?? null);
  if (header.po_ref_ext !== poRef) mismatch('po_ref_ext', header.po_ref_ext, poRef);
  if (header.site_id !== siteId) mismatch('site_id', header.site_id, siteId);
  if (header.source_document === JOBWORK_CHALLAN_SOURCE) {
    const orders = await client.query(
      `SELECT DISTINCT r.service_order_id
         FROM grn_line gl JOIN jobwork_material_receipt r ON r.grn_line_id = gl.grn_line_id
        WHERE gl.grn_id = $1`,
      [header.grn_id],
    );
    const other = orders.rows.find((row) => row['service_order_id'] !== p['service_order_id']);
    if (other) mismatch('service_order_id', other['service_order_id'], p['service_order_id']);
  }
}

/** The neutral band of a receipt with no purchase order line (Pilot Ruling B): never over, never short. */
const NO_PO_BAND: Record<string, unknown> = { is_over: false, is_short: false, erp_overlap: '0' };

/**
 * The AC5/AC6 tolerance band for one PO line, computed entirely in PostgreSQL NUMERIC. Serializes
 * concurrent receipts on the same PO line BEFORE reading the cumulative sum so two lines cannot
 * both pass the band and over-receive.
 */
async function readPoReceiptBand(
  poRef: string,
  matchedLineNo: number,
  receivedQty: string,
  client: PoolClient,
): Promise<Record<string, unknown>> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${poRef}:${matchedLineNo}`]);
  const calc = await client.query(
    // Pilot triage 2026-09-13 (13.2 ledger): the band counts what the ERP had ALREADY received
    // against the line before the platform first saw it (legacy_received_qty, frozen at first sync)
    // plus the platform's own GRN lines. The ERP's CURRENT open_qty is never trusted for the band:
    // "sometimes" someone retypes a platform GRN into the ERP, so open_qty may or may not reflect
    // platform receipts. When it implies more received than the frozen legacy figure, that excess is
    // reported as erp_receipt_overlap_qty (and logged) for reconciliation - fail-closed, never a
    // second door for the same hundred kilos.
    `WITH pol AS (
        SELECT ordered_qty, open_qty, legacy_received_qty,
               over_receipt_tolerance_pct, under_receipt_tolerance_pct
          FROM erp_purchase_order_line WHERE po_number_ext = $1 AND line_no = $2
      ),
      cum AS (
        SELECT (SELECT COALESCE(SUM(received_qty), 0)
                  FROM grn_line WHERE po_ref_ext = $1 AND line_no = $2 AND status <> 'rejected')
               + $3::numeric + pol.legacy_received_qty AS cumulative
          FROM pol
      )
      SELECT
        cum.cumulative::text AS cumulative,
        pol.ordered_qty::text AS ordered,
        pol.legacy_received_qty::text AS legacy_received,
        GREATEST((pol.ordered_qty - pol.open_qty) - pol.legacy_received_qty, 0)::text AS erp_overlap,
        (cum.cumulative > pol.ordered_qty * (1 + COALESCE(pol.over_receipt_tolerance_pct, 0) / 100)) AS is_over,
        (cum.cumulative < pol.ordered_qty) AS is_short,
        (pol.ordered_qty - cum.cumulative)::text AS shortage
      FROM pol, cum`,
    [poRef, matchedLineNo, receivedQty],
  );
  if (calc.rows.length === 0) {
    // The PO line matched by sku above must exist; a concurrent PO close is the only way here.
    throw new AppError(
      404,
      'RECEIVING_PO_NOT_FOUND',
      `PO line ${matchedLineNo} for "${poRef}" is no longer available`,
      { po_ref_ext: poRef, line_no: matchedLineNo },
    );
  }
  return calc.rows[0]! as Record<string, unknown>;
}

/** In-transaction projection (Story 3.4, Task 5.3). See the seam header for the AD-2 chain rationale. */
export async function applyGoodsReceivedProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (receivingEventType(envelope) !== 'goods.received') return;
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload;

  // Pilot Ruling B: a customer challan receipt has no purchase order, and its weighbridge ticket
  // is optional. ticketId is the ticket to validate (always present on a PO/ASN receipt);
  // correlationId (the envelope's own when there is no ticket) only threads notifications and the
  // nested custody event. headerCorrelationId is what the GRN header STORES: the gate-dwell view
  // joins gate events to grn.correlation_id, and on the events and edge doors the envelope's
  // correlation id is caller-chosen, so a ticketless challan receipt stores NULL - never that.
  const challanReceipt = p['source_document'] === JOBWORK_CHALLAN_SOURCE;
  const correlationId = isNonEmptyString(p['correlation_id'])
    ? (p['correlation_id'] as string)
    : envelope.metadata.correlation_id;
  const ticketId: string | null =
    challanReceipt && !isNonEmptyString(p['correlation_id']) ? null : correlationId;
  const headerCorrelationId: string | null = challanReceipt ? ticketId : correlationId;
  const poRef = challanReceipt ? null : (p['po_ref_ext'] as string);
  const sku = p['sku'] as string;
  const receivedQty = normalizeQty(p['received_qty']);
  if (receivedQty === null)
    throw new AppError(
      400,
      'RECEIVING_QTY_REQUIRED',
      'received_qty is required and must be a positive NUMERIC value',
    );

  // 1. Resolve the accepted weighment for the binding token (AC1, AD-2 chain). Only a Story 3.3
  //    'accepted' weighment opens receiving; a token whose weighments are all 'tolerance_breach' is
  //    blocked from silent receipt.
  //    Pilot Ruling B: on a customer challan receipt the ticket is optional, but a SUPPLIED ticket
  //    is held to exactly the same two checks.
  let accepted: WeighbridgeEvent | null = null;
  if (ticketId !== null) {
    const weighments = await getWeighbridgeEventsByCorrelationId(ticketId, client);
    if (weighments.length === 0) {
      throw new AppError(
        404,
        'RECEIVING_BINDING_TOKEN_NOT_FOUND',
        `No weighbridge event exists for binding token "${ticketId}"`,
        { correlation_id: ticketId },
      );
    }
    accepted = weighments.find((w) => w.status === 'accepted') ?? null;
    if (!accepted) {
      throw new AppError(
        409,
        'RECEIVING_WEIGHT_NOT_ACCEPTED',
        'The binding token has no accepted weighment; receipt is blocked pending tolerance review',
        { correlation_id: ticketId },
      );
    }
  }

  // 1b. The receiving site. A PO/ASN receipt is at the site of its accepted weighment. A customer
  //     challan receipt (Pilot Ruling B) is at the site of its job-work order - the role, site,
  //     expected-item and duplicate-challan gates all run here, before any PO-free step below.
  const challanSite = challanReceipt
    ? await assertJobworkChallanReceipt(envelope, sku, accepted, client)
    : null;
  const siteId = challanSite?.site_id ?? accepted!.site_id;
  const siteCodeExt = challanSite?.site_code_ext ?? accepted!.site_code_ext;
  await assertGrnHeaderMatches(p, poRef, siteId, client);

  // 2. Resolve the open PO from the Story 2.9 projection and match the scanned SKU to a PO line (AC4).
  //    Skipped entirely when there is no purchase order (Pilot Ruling B).
  let po: Awaited<ReturnType<typeof getPurchaseOrderByRef>> = null;
  let matchedLineNo: number | null = null;
  if (poRef !== null) {
    po = await getPurchaseOrderByRef(poRef, client);
    if (!po)
      throw new AppError(
        404,
        'RECEIVING_PO_NOT_FOUND',
        `No open PO projection row exists for "${poRef}"`,
        { po_ref_ext: poRef },
      );
    const poLine = po.lines.find((l) => l.sku === sku);
    if (!poLine)
      throw new AppError(
        400,
        'ITEM_PO_MISMATCH',
        `Scanned SKU "${sku}" matches no line of PO "${poRef}"`,
        { po_ref_ext: poRef, sku },
      );
    matchedLineNo = poLine.line_no;
  }

  const item = await getItemBySku(sku, client);
  if (!item || item.status !== 'active')
    throw new AppError(
      404,
      'ITEM_NOT_FOUND',
      `No active item master record exists for sku "${sku}"`,
      { sku },
    );
  const uom = item.uom;

  const occurredAt = envelope.metadata.occurred_at
    ? new Date(envelope.metadata.occurred_at)
    : new Date();
  const businessDate = localYmd(occurredAt);
  // Pilot Ruling B: with no gate or weighbridge chain behind it, the receiver of record on a
  // customer challan receipt is always the authenticated actor, whichever door it came through.
  const receivedBy =
    !challanReceipt && isUuid(p['received_by'])
      ? (p['received_by'] as string)
      : envelope.metadata.actor.user_id;
  if (challanReceipt) p['received_by'] = receivedBy;
  const sourceDocument = (p['source_document'] as Grn['source_document']) ?? 'PO';
  const sourceRefExt = isNonEmptyString(p['source_ref_ext'])
    ? (p['source_ref_ext'] as string)
    : null;
  const stockClass = isNonEmptyString(p['stock_class']) ? (p['stock_class'] as string) : 'owned';

  // 2b. Story 9.2 (FR-JW-03): customer material rides THIS flow, never a parallel receipt route.
  //     A job_work receipt REQUIRES the confirmed service order and the inbound challan
  //     (number, date, quantity); absence is 409 SOURCE_DOCUMENT_REQUIRED. Existence, status,
  //     site, and customer binding are re-derived under lock by the seam gates below
  //     (assertJobworkReceiptOwnership on the stock hand-off, then the custody applier) - this
  //     block only shapes the hand-off.
  const jobWork = stockClass === JOB_WORK_STOCK_CLASS;
  let jobWorkCustomer: string | null = null;
  if (jobWork) {
    if (!isUuid(p['service_order_id'])) {
      throw new AppError(
        409,
        'SOURCE_DOCUMENT_REQUIRED',
        'Customer material can only be received against a confirmed service order (service_order_id is required)',
        { sku, stock_class: stockClass },
      );
    }
    if (!isNonEmptyString(p['challan_number_ext']) || !isNonEmptyString(p['challan_date'])) {
      throw new AppError(
        409,
        'SOURCE_DOCUMENT_REQUIRED',
        'Customer material can only be received with the inbound challan (challan_number_ext and challan_date are required)',
        { sku, service_order_id: p['service_order_id'] },
      );
    }
    if (normalizeQty(p['challan_qty']) === null) {
      throw new AppError(
        409,
        'SOURCE_DOCUMENT_REQUIRED',
        'Customer material can only be received with the inbound challan quantity (challan_qty must be a positive NUMERIC value)',
        { sku, service_order_id: p['service_order_id'] },
      );
    }
    // The customer binding travels on the stock view as owner_party_code (the consignment idiom)
    // so the stock-surface gate verifies it against the order under lock. Derived from the order
    // when the clerk did not supply one; a supplied value must still match (AC7).
    const order = await getServiceOrderById(p['service_order_id'] as string, client);
    if (order && !isNonEmptyString(p['owner_party_code']))
      p['owner_party_code'] = order.customer_party_code;
    // Pilot Ruling B (R10): the purchase-order job_work path shares the challan lock and the
    // duplicate check below with the customer challan kind (which locked in its own gate), so one
    // paper challan cannot be received once through each path. An unknown order takes no lock -
    // the seam gates below refuse it.
    if (order) {
      jobWorkCustomer = order.customer_party_code;
      if (!challanReceipt)
        await lockJobworkChallan(jobWorkCustomer, p['challan_number_ext'] as string, client);
    }
  }

  // 3. Tolerance band (AC5/AC6) computed entirely in PostgreSQL NUMERIC against the Story 2.9 PO line.
  //    Serialize concurrent receipts on the same PO line BEFORE reading the cumulative sum so two
  //    lines cannot both pass the band and over-receive.
  //    Pilot Ruling B: a customer challan receipt has no PO line, so there is no band to compute;
  //    its quantity control is the Story 9.2 challan variance, recorded by the custody applier.
  const band: Record<string, unknown> =
    poRef === null
      ? NO_PO_BAND
      : await readPoReceiptBand(poRef, matchedLineNo!, receivedQty, client);
  const isOver = band['is_over'] === true;
  const isShort = band['is_short'] === true;
  const erpOverlap = band['erp_overlap'] as string;
  if (Number(erpOverlap) > 0) {
    // The stored event carries what THIS process derived; the route echoes it on the response.
    envelope.payload['erp_receipt_overlap_qty'] = erpOverlap;
    console.warn(
      `receiving ${poRef} line ${matchedLineNo}: the ERP's open_qty implies ${erpOverlap} more received than the frozen legacy figure ${band['legacy_received'] as string} - a platform GRN was recorded in the ERP as well; the band counted legacy plus platform receipts only (cumulative ${band['cumulative'] as string} of ${band['ordered'] as string}), reconcile the ERP`,
    );
  }

  // AC5: over-receipt is a committed business outcome, NOT a rollback. Record the rejected line and a
  //      durable discrepancy notification, then let the handler surface RECEIPT_TOLERANCE_EXCEEDED.
  if (isOver) {
    const rejectionReason = `Cumulative received ${band['cumulative'] as string} exceeds the over-receipt band for PO ${poRef} line ${matchedLineNo} (ordered ${band['ordered'] as string})`;
    await insertGrnHeader(
      {
        grn_id: p['grn_id'] as string,
        correlation_id: headerCorrelationId,
        po_ref_ext: poRef,
        source_document: sourceDocument,
        source_ref_ext: sourceRefExt,
        site_id: siteId,
        site_code_ext: siteCodeExt,
        status: 'open',
        received_by: receivedBy,
        business_date: businessDate,
        // Story 3.8: the capture instant backs the GRN-fallback leg of the AC3 gate-dwell interval.
        received_at: occurredAt.toISOString(),
        source_event_id: eventId,
      },
      client,
    );
    await insertGrnLine(
      {
        grn_line_id: p['grn_line_id'] as string,
        grn_id: p['grn_id'] as string,
        po_ref_ext: poRef,
        line_no: matchedLineNo,
        sku,
        lot_id: isNonEmptyString(p['lot_id']) ? (p['lot_id'] as string) : null,
        expiry_date: isNonEmptyString(p['expiry_date']) ? (p['expiry_date'] as string) : null,
        received_qty: receivedQty,
        uom,
        stock_class: stockClass,
        weighbridge_correlation_id: ticketId,
        qc_hold: false,
        shortage_variance_qty: '0',
        target_location_id: null,
        status: 'rejected',
        rejection_reason: rejectionReason,
        source_event_id: eventId,
      },
      client,
    );
    await emitNotificationInTransaction(
      {
        target: { role: DISCREPANCY_TARGET_ROLE, location_id: siteId },
        event_type: 'receipt_tolerance_exceeded',
        status_verb: 'Receipt tolerance exceeded',
        object_type: 'grn_line',
        object_id: p['grn_line_id'] as string,
        actor_label: 'Receiving',
        next_step: rejectionReason,
        actor: envelope.metadata.actor,
        correlation_id: correlationId,
      },
      client,
    );
    return;
  }

  const shortageVariance = isShort ? (band['shortage'] as string) : '0';

  // 4. Expiry check (AC7). A back-dated expiry is a hard reject unless a DOA-approved quarantine.
  const expiryDate = isNonEmptyString(p['expiry_date']) ? (p['expiry_date'] as string) : null;
  let quarantined = false;
  if (expiryDate && expiryDate < businessDate) {
    if (p['quarantine_approved'] !== true) {
      throw new AppError(
        400,
        'LOT_EXPIRED',
        `expiry_date ${expiryDate} is earlier than the receiving business date ${businessDate}`,
        { sku, expiry_date: expiryDate },
      );
    }
    await assertQuarantineApproval(client);
    quarantined = true;
  }

  // 5. QC-hold routing (AC3). A BIS-licensed or quarantine-required item (or the AC7 quarantine path)
  //    posts into the site ZONE-QC-HOLD with a held putaway task and a qc_inspector notification.
  const needsQcHold =
    item.bis_licence_required === true || item.quarantine_required === true || quarantined;
  let target: LocationRegisterEntry | null;
  if (needsQcHold) {
    target = await getLocationByCode(QC_HOLD_ZONE_CODE, client);
    if (
      !target ||
      target.status !== 'active' ||
      target.quarantine !== true ||
      target.site_id !== siteId
    ) {
      throw new AppError(
        404,
        'RECEIVING_QC_HOLD_ZONE_NOT_FOUND',
        `Site has no active ${QC_HOLD_ZONE_CODE} quarantine location`,
        { site_id: siteId },
      );
    }
  } else {
    target = isUuid(p['target_location_id'])
      ? await getLocationById(p['target_location_id'] as string, client)
      : await getLocationByCode(p['target_location_code'] as string, client);
    if (!target || target.status !== 'active' || target.site_id !== siteId) {
      throw new AppError(
        400,
        'LOCATION_NOT_FOUND',
        'The receiving target location is not registered or not active',
        {
          target_location_id: isNonEmptyString(p['target_location_id'])
            ? (p['target_location_id'] as string)
            : null,
          target_location_code: isNonEmptyString(p['target_location_code'])
            ? (p['target_location_code'] as string)
            : null,
        },
      );
    }
  }
  const qcHold = needsQcHold;
  const lineStatus: 'posted' | 'quarantined' = quarantined ? 'quarantined' : 'posted';
  const putawayStatus: 'ready' | 'held' = needsQcHold ? 'held' : 'ready';
  const crossDockRequested = p['cross_dock'] === true;
  let stagingZone: LocationRegisterEntry | null = null;
  if (crossDockRequested) {
    stagingZone = isUuid(p['staging_zone_id'])
      ? await getLocationById(p['staging_zone_id'] as string, client)
      : await getLocationByCode(p['staging_zone_code'] as string, client);
    if (
      !stagingZone ||
      stagingZone.status !== 'active' ||
      stagingZone.level !== 'zone' ||
      stagingZone.zone_type !== 'staging' ||
      stagingZone.site_id !== siteId
    ) {
      throw new AppError(
        400,
        'CROSS_DOCK_STAGING_INVALID',
        'The selected cross-dock staging location must be an active staging zone at the receiving site',
      );
    }
  }

  // Pilot B4: an owned receipt is valued at the PO line's unit price unless the line carries its
  // own unit_cost. The resolved cost is written back onto the payload BEFORE the domain_events
  // insert, so the persisted goods.received event is self-contained: a replay re-applies the same
  // cost even if the ERP later re-syncs a different price onto the PO line projection. Non-owned
  // classes (consignment, vmi, job_work, offcut) carry no Ind AS 2 cost basis and are left alone.
  //
  // The default applies ONLY when the PO price is a safe cost basis: the PO is in the books
  // currency (a foreign price is not a rupee cost and nothing here converts it), the price is
  // above zero (0 is an unpriced placeholder, not a cost), and the item is not valued by
  // specific_identification (that method needs serials at the valuation seam, and such an item was
  // receivable without them before B4). Otherwise the receipt moves stock exactly as before B4 and
  // no cost is written onto the event. An explicit unit_cost from the caller is never second-guessed.
  // The cost is read as the PO's NUMERIC text - money stays a string on the event, never a float.
  if (
    stockClass === 'owned' &&
    (p['unit_cost'] === undefined || p['unit_cost'] === null) &&
    po !== null &&
    po.currency === BOOKS_CURRENCY &&
    item.valuation_method !== 'specific_identification'
  ) {
    const price = await client.query(
      `SELECT unit_price::text AS unit_price FROM erp_purchase_order_line
        WHERE po_number_ext = $1 AND line_no = $2 AND unit_price > 0`,
      [po.po_number_ext, matchedLineNo],
    );
    if (price.rows.length > 0) p['unit_cost'] = price.rows[0]['unit_price'] as string;
  }

  // 6. Post the stock movement through a synthetic stock.received view so all existing Story 2.2/2.3/
  //    2.8 enforcement (lot auto-create from expiry_date, serial receipt, owner-party gate, NUMERIC
  //    precision) applies uniformly. The raw goods.received envelope (stream 'receiving') is a no-op
  //    for those helpers, so it must NOT be passed to them directly.
  const stockView: EventEnvelope = {
    ...envelope,
    event_id: eventId,
    stream_type: 'inventory',
    event_type: 'stock.received',
    payload: {
      sku,
      target_location_id: target.location_id,
      quantity: receivedQty,
      ...(isNonEmptyString(p['lot_id']) ? { lot_id: p['lot_id'] } : {}),
      ...(expiryDate ? { expiry_date: expiryDate } : {}),
      ...(Array.isArray(p['serials']) ? { serials: p['serials'] } : {}),
      stock_class: stockClass,
      ...(isNonEmptyString(p['owner_party_code'])
        ? { owner_party_code: p['owner_party_code'] }
        : {}),
      ...(p['unit_cost'] !== undefined && p['unit_cost'] !== null
        ? { unit_cost: Number(p['unit_cost']) }
        : {}),
      // Story 9.2 AC7: the stock-surface ownership gate binds a job_work receipt to its order.
      ...(jobWork ? { service_order_id: p['service_order_id'] } : {}),
      business_stream: item.business_stream,
    },
  };
  // Story 9.2 (FR-JW-03): only THIS hand-off may post job_work stock. A Symbol key cannot arrive
  // in a JSON body, so the stock-surface gate distinguishes the receiving flow from a direct
  // stock.received without trusting any payload field.
  if (jobWork) {
    (stockView as unknown as Record<symbol, unknown>)[RECEIVING_HANDOFF] = true;
  }
  await applyLotSerialValidation(stockView, client, eventId);
  await applyStockBalanceProjection(stockView, client);
  // Pilot B4: the GRN is the valuated movement (Story 2.4 AC1 "or from GRNs"). The top-level
  // valuation seam gates on stream 'inventory', so - exactly like the two helpers above - the raw
  // goods.received envelope is a no-op for it and the view must be passed instead. The seam itself
  // skips non-owned stock classes and an unpriced receipt, inside this same transaction.
  await applyInventoryValuationProjection(stockView, client, eventId);

  // 7. Persist the GRN header, GRN line, and putaway task (posted/quarantined lines only). NEVER
  //    writes any erp_* projection (AC6). The lot_id may have been auto-resolved onto the view above.
  const resolvedLotId = isNonEmptyString(stockView.payload['lot_id'])
    ? (stockView.payload['lot_id'] as string)
    : null;
  // Duplicate challan, now that the lot is resolved. Nothing above is committed: a refusal here
  // rolls the stock movement back with the rest of the transaction.
  if (jobWork && jobWorkCustomer !== null) {
    await assertChallanNotDuplicate(
      {
        customerPartyCode: jobWorkCustomer,
        challanNumber: p['challan_number_ext'] as string,
        sku,
        lotId: resolvedLotId,
      },
      p['service_order_id'] as string,
      client,
    );
  }
  let nonqualificationReason: string | null = null;
  let matchedOrderLineId: string | null = null;
  let matchedLotUuid: string | null = null;
  if (crossDockRequested) {
    if (needsQcHold)
      nonqualificationReason =
        quarantined || item.quarantine_required ? 'quarantine_required' : 'qc_blocked';
    else if (stockClass !== 'owned') nonqualificationReason = 'non_owned_stock';
    else if (!resolvedLotId) nonqualificationReason = 'lot_required';
    else if (!isCrossDockQuantityCapacity(receivedQty))
      nonqualificationReason = 'quantity_out_of_pick_range';
    else {
      const lot = await client.query(
        `SELECT lot_id FROM lot_master WHERE lot_number = $1 AND sku = $2 AND quality_hold_status = 'none' FOR UPDATE`,
        [resolvedLotId, sku],
      );
      if (lot.rows.length === 0) nonqualificationReason = 'lot_required';
      else {
        matchedLotUuid = lot.rows[0]!['lot_id'] as string;
        const demand = await findCrossDockDemandMatch(sku, siteId, receivedQty, client);
        if (demand) matchedOrderLineId = demand.id;
        else {
          const anyDemand = await client.query(
            `SELECT 1 FROM erp_sales_order WHERE sku = $1 AND ship_from_site_id = $2 AND status = 'open' LIMIT 1`,
            [sku, siteId],
          );
          nonqualificationReason =
            anyDemand.rows.length === 0 ? 'no_open_demand' : 'insufficient_single_line_demand';
        }
      }
    }
  }
  const qualifiedCrossDock = matchedOrderLineId !== null && matchedLotUuid !== null;
  await insertGrnHeader(
    {
      grn_id: p['grn_id'] as string,
      correlation_id: headerCorrelationId,
      po_ref_ext: poRef,
      source_document: sourceDocument,
      source_ref_ext: sourceRefExt,
      site_id: siteId,
      site_code_ext: siteCodeExt,
      status: 'posted',
      received_by: receivedBy,
      business_date: businessDate,
      // Story 3.8: the capture instant backs the GRN-fallback leg of the AC3 gate-dwell interval.
      received_at: occurredAt.toISOString(),
      source_event_id: eventId,
    },
    client,
  );
  await insertGrnLine(
    {
      grn_line_id: p['grn_line_id'] as string,
      grn_id: p['grn_id'] as string,
      po_ref_ext: poRef,
      line_no: matchedLineNo,
      sku,
      lot_id: resolvedLotId,
      expiry_date: expiryDate,
      received_qty: receivedQty,
      uom,
      stock_class: stockClass,
      weighbridge_correlation_id: ticketId,
      qc_hold: qcHold,
      shortage_variance_qty: shortageVariance,
      target_location_id: target.location_id,
      status: lineStatus,
      rejection_reason: null,
      cross_dock: qualifiedCrossDock,
      matched_dispatch_order_line_id: matchedOrderLineId,
      cross_dock_nonqualification_reason: nonqualificationReason,
      source_event_id: eventId,
    },
    client,
  );

  // 7b. Story 9.2 (FR-JW-03, FR-JW-05): the order-linked custody record, persisted as its own
  //     jobwork.material_received domain event INSIDE this transaction (the bis-licence-expiry
  //     nested-persistEvent precedent). The custody applier re-derives the order under lock,
  //     computes the challan variance, and fires confirmed -> in_process on the first receipt.
  //     QC hold and custody COMPOSE: this row is written at receipt, not at putaway release, so a
  //     quarantined customer lot is in custody from the moment it enters the building.
  if (jobWork) {
    const receiptId = isUuid(p['receipt_id']) ? (p['receipt_id'] as string) : randomUUID();
    await persistEvent(
      {
        stream_type: 'jobwork',
        stream_id: p['service_order_id'] as string,
        event_type: JOBWORK_MATERIAL_RECEIVED,
        payload: {
          service_order_id: p['service_order_id'],
          receipt_id: receiptId,
          grn_line_id: p['grn_line_id'],
          challan_number_ext: (p['challan_number_ext'] as string).trim(),
          challan_date: p['challan_date'],
          sku,
          lot_id: resolvedLotId,
          received_qty: receivedQty,
          challan_qty: normalizeQty(p['challan_qty']) as string,
          // Story 9.5 (Binding decision 7): the Section 143 challan class rides the GRN body when
          // the clerk supplies it; the 9.2 receipt applier defaults an absent value to 'input'.
          ...(p['challan_class'] !== undefined ? { challan_class: p['challan_class'] } : {}),
          uom,
          site_id: siteId,
          received_by: receivedBy,
        },
        metadata: {
          ...envelope.metadata,
          correlation_id: correlationId,
          causation_id: eventId,
        },
        // Natural idempotency key: one custody record per GRN line. A replay of the custody
        // event with this key returns the stored event from persistEvent's short-circuit
        // (no second row, no second transition attempt).
        idempotency_key: `${JOBWORK_MATERIAL_RECEIVED}:${p['grn_line_id'] as string}`,
      },
      undefined,
      client,
    );
  }

  if (qualifiedCrossDock) {
    await insertCrossDockTask(
      {
        cross_dock_task_id: p['cross_dock_task_id'] as string,
        grn_line_id: p['grn_line_id'] as string,
        dispatch_order_line_id: matchedOrderLineId!,
        sku,
        lot_id: matchedLotUuid!,
        quantity: receivedQty,
        site_id: siteId,
        from_location_id: target.location_id,
        staging_zone_id: stagingZone!.location_id,
        created_by: receivedBy,
        created_at: occurredAt.toISOString(),
        correlation_id: correlationId,
        source_event_id: eventId,
      },
      client,
    );
  } else {
    await insertPutawayTask(
      {
        putaway_task_id: randomUUID(),
        grn_line_id: p['grn_line_id'] as string,
        sku,
        lot_id: resolvedLotId,
        quantity: receivedQty,
        from_location_id: target.location_id,
        site_id: siteId,
        status: putawayStatus,
        owner_role: needsQcHold ? QC_INSPECTION_TARGET_ROLE : null,
        source_event_id: eventId,
      },
      client,
    );
  }

  // AC3: the held putaway task plus this qc_inspector notification ARE the interim QC-inspection task
  //      representation (the durable QC inspection table is Epic 8).
  if (needsQcHold) {
    await emitNotificationInTransaction(
      {
        target: { role: QC_INSPECTION_TARGET_ROLE, location_id: siteId },
        event_type: 'qc_hold_placed',
        status_verb: 'QC hold placed',
        object_type: 'grn_line',
        object_id: p['grn_line_id'] as string,
        actor_label: 'Receiving',
        next_step: `Inspect ${sku}${resolvedLotId ? ` lot ${resolvedLotId}` : ''} held in ${QC_HOLD_ZONE_CODE}`,
        actor: envelope.metadata.actor,
        correlation_id: correlationId,
      },
      client,
    );
  }
}

// ---------------------------------------------------------------------------
// goods.putaway_released (Task 6, AC3)
// ---------------------------------------------------------------------------

export function assertGoodsPutawayReleasedShape(envelope: EventEnvelope): void {
  if (receivingEventType(envelope) !== 'goods.putaway_released') return;
  const p = envelope.payload;
  if (!isUuid(p['putaway_task_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'putaway_task_id is required and must be a UUID');
  if (!isUuid(p['grn_line_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'grn_line_id is required and must be a UUID');
  if (!isNonEmptyString(p['reason_code']))
    throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required');
  p['reason_code'] = (p['reason_code'] as string).trim();
}

export async function applyGoodsPutawayReleasedProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (receivingEventType(envelope) !== 'goods.putaway_released') return;
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload;

  const putawayTaskId = p['putaway_task_id'] as string;
  const task = await getPutawayTaskById(putawayTaskId, client);
  if (!task)
    throw new AppError(
      404,
      'PUTAWAY_TASK_NOT_FOUND',
      `No putaway task exists for "${putawayTaskId}"`,
      { putaway_task_id: putawayTaskId },
    );
  if (task.status !== 'held') {
    throw new AppError(
      409,
      'PUTAWAY_TASK_NOT_HELD',
      `Putaway task "${putawayTaskId}" is ${task.status}; only a held task can be released`,
      { putaway_task_id: putawayTaskId, status: task.status },
    );
  }

  // AC3: the release is DOA-gated - a governing band must exist AND the actor must be an authorized
  //      receiving supervisor. The reason_code rides the event payload into the standard audit path.
  await assertReleaseApproval(envelope.metadata.actor.role, client);

  // The release approver identity is always the authenticated actor, never trusted from the payload
  // (mirrors received_by/weighed_by/gate_officer_id) - edge.ts and the REST handler both force
  // metadata.actor.user_id to the authenticated user, so this is the only trustworthy source.
  const releasedBy = envelope.metadata.actor.user_id;
  const released = await markPutawayReleased(
    putawayTaskId,
    releasedBy,
    p['reason_code'] as string,
    eventId,
    client,
  );
  if (!released) {
    throw new AppError(
      409,
      'PUTAWAY_TASK_NOT_HELD',
      `Putaway task "${putawayTaskId}" was released by a concurrent request`,
      { putaway_task_id: putawayTaskId },
    );
  }
}

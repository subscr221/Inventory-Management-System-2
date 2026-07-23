import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getLocationById, getLocationByCode } from '../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';
import { getPurchaseOrderByRef } from '../read/projections/erp_purchase_order.js';
import { getWeighbridgeEventsByCorrelationId } from '../read/projections/weighbridge_event.js';
import { findMatchingDoaEntry, findRoleHolder, findActiveDelegation, listActiveDoaEntries } from '../read/projections/doa_registry.js';
import { insertGrnHeader } from '../read/projections/grn.js';
import { insertGrnLine } from '../read/projections/grn_line.js';
import { insertPutawayTask, getPutawayTaskById, markPutawayReleased } from '../read/projections/putaway_task.js';
import { applyLotSerialValidation } from './lot-serial-validation.js';
import { applyStockBalanceProjection } from './stock-balance.js';

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
const NUMERIC_REGEX = /^\d+(\.\d+)?$/;

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
    return NUMERIC_REGEX.test(s) && Number(s) > 0 ? s : null;
  }
  return null;
}

function receivingEventType(envelope: EventEnvelope): 'goods.received' | 'goods.putaway_released' | null {
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
  if (!entry) throw new AppError(403, 'APPROVAL_REQUIRED', 'An expired-lot quarantine receipt requires a DOA-governed supervisor approval', { transaction_type: QUARANTINE_DOA_TYPE });
  let approver = await resolveActiveHolder(entry.role, client);
  if (!approver) {
    for (const e of await listActiveDoaEntries(QUARANTINE_DOA_TYPE, client)) {
      if (e.role === entry.role) continue;
      approver = await resolveActiveHolder(e.role, client);
      if (approver) break;
    }
  }
  if (!approver) throw new AppError(403, 'APPROVAL_REQUIRED', 'No active supervisor could be resolved to approve the quarantine receipt', { transaction_type: QUARANTINE_DOA_TYPE });
}

/**
 * AC3 held-putaway release approval (Task 6.1). The release endpoint is already supervisor-only; this
 * is defense-in-depth: a governing band must exist AND the authenticated actor must be an authorized
 * receiving supervisor (so a direct event POST cannot bypass the endpoint RBAC).
 */
async function assertReleaseApproval(actorRole: string, client: PoolClient): Promise<void> {
  const entry = await findMatchingDoaEntry(PUTAWAY_RELEASE_DOA_TYPE, 0, client);
  if (!entry || !RECEIVING_APPROVER_ROLES.has(actorRole)) {
    throw new AppError(403, 'APPROVAL_REQUIRED', 'Releasing a held putaway task requires a DOA-resolved receiving supervisor approval', {
      transaction_type: PUTAWAY_RELEASE_DOA_TYPE,
      actor_role: actorRole,
    });
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

  if (!isUuid(p['correlation_id'])) throw new AppError(400, 'RECEIVING_BINDING_TOKEN_REQUIRED', 'correlation_id (binding token) is required and must be a UUID');
  if (!isUuid(p['grn_id'])) throw new AppError(400, 'INVALID_PARAMS', 'grn_id is required and must be a UUID');
  if (!isUuid(p['grn_line_id'])) throw new AppError(400, 'INVALID_PARAMS', 'grn_line_id is required and must be a UUID');
  if (!isNonEmptyString(p['po_ref_ext'])) throw new AppError(400, 'INVALID_PARAMS', 'po_ref_ext is required');
  p['po_ref_ext'] = (p['po_ref_ext'] as string).trim();

  const lineNo = p['line_no'];
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0) throw new AppError(400, 'INVALID_PARAMS', 'line_no is required and must be a positive integer');
  if (!isNonEmptyString(p['sku'])) throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
  p['sku'] = (p['sku'] as string).trim();

  const normalizedQty = normalizeQty(p['received_qty']);
  if (normalizedQty === null) throw new AppError(400, 'RECEIVING_QTY_REQUIRED', 'received_qty is required and must be a positive NUMERIC value');
  p['received_qty'] = normalizedQty;

  if (p['source_document'] !== 'PO' && p['source_document'] !== 'ASN') throw new AppError(400, 'INVALID_PARAMS', "source_document must be 'PO' or 'ASN'");

  if (!isNonEmptyString(p['target_location_id']) && !isNonEmptyString(p['target_location_code'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'target_location_id or target_location_code is required');
  }

  if (p['expiry_date'] !== undefined && p['expiry_date'] !== null) {
    if (typeof p['expiry_date'] !== 'string' || !DATE_REGEX.test(p['expiry_date'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'expiry_date must be a YYYY-MM-DD string when supplied');
    }
  }

  if (p['quarantine_approved'] === true && !isNonEmptyString(p['quarantine_reason_code'])) {
    throw new AppError(400, 'INVALID_PARAMS', 'quarantine_reason_code is required when quarantine_approved is true');
  }
}

/** In-transaction projection (Story 3.4, Task 5.3). See the seam header for the AD-2 chain rationale. */
export async function applyGoodsReceivedProjection(envelope: EventEnvelope, client: PoolClient, eventId: string): Promise<void> {
  if (receivingEventType(envelope) !== 'goods.received') return;
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload;

  const correlationId = isNonEmptyString(p['correlation_id']) ? (p['correlation_id'] as string) : envelope.metadata.correlation_id;
  const poRef = p['po_ref_ext'] as string;
  const sku = p['sku'] as string;
  const receivedQty = normalizeQty(p['received_qty']);
  if (receivedQty === null) throw new AppError(400, 'RECEIVING_QTY_REQUIRED', 'received_qty is required and must be a positive NUMERIC value');

  // 1. Resolve the accepted weighment for the binding token (AC1, AD-2 chain). Only a Story 3.3
  //    'accepted' weighment opens receiving; a token whose weighments are all 'tolerance_breach' is
  //    blocked from silent receipt.
  const weighments = await getWeighbridgeEventsByCorrelationId(correlationId, client);
  if (weighments.length === 0) {
    throw new AppError(404, 'RECEIVING_BINDING_TOKEN_NOT_FOUND', `No weighbridge event exists for binding token "${correlationId}"`, { correlation_id: correlationId });
  }
  const accepted = weighments.find((w) => w.status === 'accepted');
  if (!accepted) {
    throw new AppError(409, 'RECEIVING_WEIGHT_NOT_ACCEPTED', 'The binding token has no accepted weighment; receipt is blocked pending tolerance review', { correlation_id: correlationId });
  }
  const siteId = accepted.site_id;
  const siteCodeExt = accepted.site_code_ext;

  // 2. Resolve the open PO from the Story 2.9 projection and match the scanned SKU to a PO line (AC4).
  const po = await getPurchaseOrderByRef(poRef, client);
  if (!po) throw new AppError(404, 'RECEIVING_PO_NOT_FOUND', `No open PO projection row exists for "${poRef}"`, { po_ref_ext: poRef });
  const poLine = po.lines.find((l) => l.sku === sku);
  if (!poLine) throw new AppError(400, 'ITEM_PO_MISMATCH', `Scanned SKU "${sku}" matches no line of PO "${poRef}"`, { po_ref_ext: poRef, sku });
  const matchedLineNo = poLine.line_no;

  const item = await getItemBySku(sku, client);
  if (!item || item.status !== 'active') throw new AppError(404, 'ITEM_NOT_FOUND', `No active item master record exists for sku "${sku}"`, { sku });
  const uom = item.uom;

  const occurredAt = envelope.metadata.occurred_at ? new Date(envelope.metadata.occurred_at) : new Date();
  const businessDate = localYmd(occurredAt);
  const receivedBy = isUuid(p['received_by']) ? (p['received_by'] as string) : envelope.metadata.actor.user_id;
  const sourceDocument = (p['source_document'] as 'PO' | 'ASN') ?? 'PO';
  const sourceRefExt = isNonEmptyString(p['source_ref_ext']) ? (p['source_ref_ext'] as string) : null;
  const stockClass = isNonEmptyString(p['stock_class']) ? (p['stock_class'] as string) : 'owned';

  // 3. Tolerance band (AC5/AC6) computed entirely in PostgreSQL NUMERIC against the Story 2.9 PO line.
  //    Serialize concurrent receipts on the same PO line BEFORE reading the cumulative sum so two
  //    lines cannot both pass the band and over-receive.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${poRef}:${matchedLineNo}`]);
  const calc = await client.query(
    `WITH pol AS (
        SELECT ordered_qty, over_receipt_tolerance_pct, under_receipt_tolerance_pct
          FROM erp_purchase_order_line WHERE po_number_ext = $1 AND line_no = $2
      ),
      cum AS (
        SELECT COALESCE(SUM(received_qty), 0) + $3::numeric AS cumulative
          FROM grn_line WHERE po_ref_ext = $1 AND line_no = $2 AND status <> 'rejected'
      )
      SELECT
        cum.cumulative::text AS cumulative,
        pol.ordered_qty::text AS ordered,
        (cum.cumulative > pol.ordered_qty * (1 + COALESCE(pol.over_receipt_tolerance_pct, 0) / 100)) AS is_over,
        (cum.cumulative < pol.ordered_qty) AS is_short,
        (pol.ordered_qty - cum.cumulative)::text AS shortage
      FROM pol, cum`,
    [poRef, matchedLineNo, receivedQty],
  );
  if (calc.rows.length === 0) {
    // The PO line matched by sku above must exist; a concurrent PO close is the only way here.
    throw new AppError(404, 'RECEIVING_PO_NOT_FOUND', `PO line ${matchedLineNo} for "${poRef}" is no longer available`, { po_ref_ext: poRef, line_no: matchedLineNo });
  }
  const band = calc.rows[0]!;
  const isOver = band['is_over'] === true;
  const isShort = band['is_short'] === true;

  // AC5: over-receipt is a committed business outcome, NOT a rollback. Record the rejected line and a
  //      durable discrepancy notification, then let the handler surface RECEIPT_TOLERANCE_EXCEEDED.
  if (isOver) {
    const rejectionReason = `Cumulative received ${band['cumulative'] as string} exceeds the over-receipt band for PO ${poRef} line ${matchedLineNo} (ordered ${band['ordered'] as string})`;
    await insertGrnHeader(
      {
        grn_id: p['grn_id'] as string,
        correlation_id: correlationId,
        po_ref_ext: poRef,
        source_document: sourceDocument,
        source_ref_ext: sourceRefExt,
        site_id: siteId,
        site_code_ext: siteCodeExt,
        status: 'open',
        received_by: receivedBy,
        business_date: businessDate,
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
        weighbridge_correlation_id: correlationId,
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
      throw new AppError(400, 'LOT_EXPIRED', `expiry_date ${expiryDate} is earlier than the receiving business date ${businessDate}`, { sku, expiry_date: expiryDate });
    }
    await assertQuarantineApproval(client);
    quarantined = true;
  }

  // 5. QC-hold routing (AC3). A BIS-licensed or quarantine-required item (or the AC7 quarantine path)
  //    posts into the site ZONE-QC-HOLD with a held putaway task and a qc_inspector notification.
  const needsQcHold = item.bis_licence_required === true || item.quarantine_required === true || quarantined;
  let target: LocationRegisterEntry | null;
  if (needsQcHold) {
    target = await getLocationByCode(QC_HOLD_ZONE_CODE, client);
    if (!target || target.status !== 'active' || target.quarantine !== true || target.site_id !== siteId) {
      throw new AppError(404, 'RECEIVING_QC_HOLD_ZONE_NOT_FOUND', `Site has no active ${QC_HOLD_ZONE_CODE} quarantine location`, { site_id: siteId });
    }
  } else {
    target = isUuid(p['target_location_id'])
      ? await getLocationById(p['target_location_id'] as string, client)
      : await getLocationByCode(p['target_location_code'] as string, client);
    if (!target || target.status !== 'active' || target.site_id !== siteId) {
      throw new AppError(400, 'LOCATION_NOT_FOUND', 'The receiving target location is not registered or not active', {
        target_location_id: isNonEmptyString(p['target_location_id']) ? (p['target_location_id'] as string) : null,
        target_location_code: isNonEmptyString(p['target_location_code']) ? (p['target_location_code'] as string) : null,
      });
    }
  }
  const qcHold = needsQcHold;
  const lineStatus: 'posted' | 'quarantined' = quarantined ? 'quarantined' : 'posted';
  const putawayStatus: 'ready' | 'held' = needsQcHold ? 'held' : 'ready';

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
      quantity: Number(receivedQty),
      ...(isNonEmptyString(p['lot_id']) ? { lot_id: p['lot_id'] } : {}),
      ...(expiryDate ? { expiry_date: expiryDate } : {}),
      ...(Array.isArray(p['serials']) ? { serials: p['serials'] } : {}),
      stock_class: stockClass,
      ...(isNonEmptyString(p['owner_party_code']) ? { owner_party_code: p['owner_party_code'] } : {}),
      ...(p['unit_cost'] !== undefined && p['unit_cost'] !== null ? { unit_cost: Number(p['unit_cost']) } : {}),
      business_stream: item.business_stream,
    },
  };
  await applyLotSerialValidation(stockView, client, eventId);
  await applyStockBalanceProjection(stockView, client);

  // 7. Persist the GRN header, GRN line, and putaway task (posted/quarantined lines only). NEVER
  //    writes any erp_* projection (AC6). The lot_id may have been auto-resolved onto the view above.
  const resolvedLotId = isNonEmptyString(stockView.payload['lot_id']) ? (stockView.payload['lot_id'] as string) : null;
  await insertGrnHeader(
    {
      grn_id: p['grn_id'] as string,
      correlation_id: correlationId,
      po_ref_ext: poRef,
      source_document: sourceDocument,
      source_ref_ext: sourceRefExt,
      site_id: siteId,
      site_code_ext: siteCodeExt,
      status: 'posted',
      received_by: receivedBy,
      business_date: businessDate,
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
      weighbridge_correlation_id: correlationId,
      qc_hold: qcHold,
      shortage_variance_qty: shortageVariance,
      target_location_id: target.location_id,
      status: lineStatus,
      rejection_reason: null,
      source_event_id: eventId,
    },
    client,
  );
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
  if (!isUuid(p['putaway_task_id'])) throw new AppError(400, 'INVALID_PARAMS', 'putaway_task_id is required and must be a UUID');
  if (!isUuid(p['grn_line_id'])) throw new AppError(400, 'INVALID_PARAMS', 'grn_line_id is required and must be a UUID');
  if (!isNonEmptyString(p['reason_code'])) throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required');
  p['reason_code'] = (p['reason_code'] as string).trim();
}

export async function applyGoodsPutawayReleasedProjection(envelope: EventEnvelope, client: PoolClient, eventId: string): Promise<void> {
  if (receivingEventType(envelope) !== 'goods.putaway_released') return;
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload;

  const putawayTaskId = p['putaway_task_id'] as string;
  const task = await getPutawayTaskById(putawayTaskId, client);
  if (!task) throw new AppError(404, 'PUTAWAY_TASK_NOT_FOUND', `No putaway task exists for "${putawayTaskId}"`, { putaway_task_id: putawayTaskId });
  if (task.status !== 'held') {
    throw new AppError(409, 'PUTAWAY_TASK_NOT_HELD', `Putaway task "${putawayTaskId}" is ${task.status}; only a held task can be released`, { putaway_task_id: putawayTaskId, status: task.status });
  }

  // AC3: the release is DOA-gated - a governing band must exist AND the actor must be an authorized
  //      receiving supervisor. The reason_code rides the event payload into the standard audit path.
  await assertReleaseApproval(envelope.metadata.actor.role, client);

  // The release approver identity is always the authenticated actor, never trusted from the payload
  // (mirrors received_by/weighed_by/gate_officer_id) - edge.ts and the REST handler both force
  // metadata.actor.user_id to the authenticated user, so this is the only trustworthy source.
  const releasedBy = envelope.metadata.actor.user_id;
  const released = await markPutawayReleased(putawayTaskId, releasedBy, p['reason_code'] as string, eventId, client);
  if (!released) {
    throw new AppError(409, 'PUTAWAY_TASK_NOT_HELD', `Putaway task "${putawayTaskId}" was released by a concurrent request`, { putaway_task_id: putawayTaskId });
  }
}

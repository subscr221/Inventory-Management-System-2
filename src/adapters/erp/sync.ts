import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';
import { getItemBySku } from '../../read/projections/item_master.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import {
  upsertPurchaseOrderHeader,
  upsertPurchaseOrderLine,
  closePurchaseOrdersNotIn,
} from '../../read/projections/erp_purchase_order.js';
import {
  upsertSalesOrderLine,
  closeSalesOrdersNotIn,
} from '../../read/projections/erp_sales_order.js';
import {
  markSyncAttempt,
  markSyncSuccess,
  markSyncFailure,
  raiseException,
  resolveOpenExceptionsByGrain,
} from '../../read/projections/integration_exception.js';
import { emitNotification } from '../../notify/emit.js';

/**
 * ERP inbound sync adapter (Story 2.9). This is the ONLY component that talks to the external ERP.
 * These reference projections are NOT event-sourced - the adapter writes them by DIRECT SQL upsert
 * (mirroring src/adapters/iam/scim.ts), never through persistEvent (which would trip
 * assertInventoryTagging and every other inventory seam and is defensively closed to any `erp`
 * stream by the persistEvent bypass guard). ERP remains master for PO/SO lifecycle.
 *
 * Live ERP transport (polling, message queue, file drop) is per-deployment configuration and out of
 * scope here; the sync entry point is the in-process `runErpSync` function exercised through the
 * POST /api/v1/erp/sync synthetic trigger, mirroring the Phase-1 synthetic-job pattern.
 *
 * Per-record isolation (AC5): each PO (header plus its lines) and each SO line is validated and
 * upserted inside its OWN SAVEPOINT, so one malformed record's ROLLBACK TO SAVEPOINT cannot discard
 * a good record and a good record is never left half-applied. A failing record is routed to the
 * integration_exception queue with a stable error_code and its source snapshot; the batch continues
 * with NO batch-level abort. source_system is server-set to 'ERP' and last_synced_at to now() on
 * every write (server-set helpers), never trusted from the source payload.
 */

// System-actor convention (src/adapters/iam/scim.ts): a sentinel UUID for non-user-attributable
// system activity. Used only for the non-blocking stale/failure alert's notification actor, whose
// location_id must be a UUID per the notification envelope validator.
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

const MAX_QUANTITY = 1e12;
const MAX_PRICE = 1e12;
const MAX_TOLERANCE_PCT = 1e6;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Per-projection transaction advisory-lock keys. Two overlapping sync cycles for the same projection
// would otherwise cross-close each other's present rows (each soft-closes what is absent from ITS
// feed). A pg_advisory_xact_lock serializes the read-decide-persist window per projection and is
// released automatically on COMMIT/ROLLBACK. Values are arbitrary stable constants.
const ADVISORY_LOCK_KEYS: Record<'purchase_orders' | 'sales_orders', number> = {
  purchase_orders: 2_090_001,
  sales_orders: 2_090_002,
};

export const ERP_ERROR_CODES = {
  SOURCE_SYSTEM_READ_ONLY: 'SOURCE_SYSTEM_READ_ONLY',
  ERP_SYNC_STALE: 'ERP_SYNC_STALE',
  /** Story 5.6 (FR-B-17): recorded on every exception raised by an inbound BOM record. */
  BOM_INBOUND_SYNC_REJECTED: 'BOM_INBOUND_SYNC_REJECTED',
} as const;

// ---------------------------------------------------------------------------
// Source record shapes (as delivered by the ERP transport / synthetic trigger)
// ---------------------------------------------------------------------------

export interface SourcePurchaseOrderLine {
  line_no: number;
  sku: string;
  ordered_qty: number;
  open_qty: number;
  unit_price: number;
  over_receipt_tolerance_pct?: number | null;
  under_receipt_tolerance_pct?: number | null;
}

export interface SourcePurchaseOrder {
  po_number_ext: string;
  supplier_ref_ext: string;
  currency: string;
  expected_delivery_date?: string | null;
  lines: SourcePurchaseOrderLine[];
}

export interface SourceSalesOrderLine {
  so_number_ext: string;
  line_no: number;
  sku: string;
  quantity: number;
  required_by?: string | null;
  ship_to_ext?: string | null;
  ship_from_site_code_ext: string;
}

/**
 * Story 5.6 (FR-B-17, AD-4): an inbound BOM record as the ERP feed delivers it. Deliberately
 * loose - the platform is the system of record for BOM structure, so an inbound record is NEVER
 * parsed into a structural change; it is snapshotted verbatim onto the exception queue.
 */
export interface SourceBomRecord {
  bom_ref: string;
  parent_sku?: string;
  lines?: unknown[];
}

export interface ErpSyncBatch {
  purchase_orders?: SourcePurchaseOrder[];
  sales_orders?: SourceSalesOrderLine[];
  boms?: SourceBomRecord[];
}

/** One unconditionally rejected inbound BOM record (Story 5.6, AC 5). */
export interface RejectedBomRecord {
  bom_ref: string;
  bom_id: string | null;
  exception_id: string;
  conflict_reason: string;
  source_snapshot: unknown;
  /** true when raiseException INSERTED a new open row; false when it refreshed an existing one. */
  newly_opened: boolean;
}

export interface ErpSyncResult {
  purchase_orders?: { applied: number; failed: number };
  sales_orders?: { applied: number; failed: number };
  boms?: { applied: number; failed: number; rejected: RejectedBomRecord[] };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isBoundedNumber(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

async function assertSkuActive(sku: unknown, client: PoolClient): Promise<string> {
  if (!isNonEmptyString(sku)) {
    throw new AppError(400, 'INVALID_PARAMS', 'sku is required and must be a non-empty string', {
      sku: sku ?? null,
    });
  }
  const item = await getItemBySku(sku, client);
  if (!item || item.status !== 'active') {
    throw new AppError(
      400,
      'ITEM_NOT_FOUND',
      `No active item master record exists for sku "${sku}"`,
      { sku },
    );
  }
  return sku;
}

async function withSavepoint<T>(
  client: PoolClient,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

function errorCodeOf(err: unknown): string {
  return err instanceof AppError ? err.errorCode : 'INVALID_PARAMS';
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Per-record validation + upsert
// ---------------------------------------------------------------------------

async function applyPurchaseOrder(po: SourcePurchaseOrder, client: PoolClient): Promise<void> {
  if (!isNonEmptyString(po.po_number_ext))
    throw new AppError(400, 'INVALID_PARAMS', 'po_number_ext is required');
  if (!isNonEmptyString(po.supplier_ref_ext))
    throw new AppError(400, 'INVALID_PARAMS', 'supplier_ref_ext is required');
  if (!isNonEmptyString(po.currency))
    throw new AppError(400, 'INVALID_PARAMS', 'currency is required');
  if (
    po.expected_delivery_date !== undefined &&
    po.expected_delivery_date !== null &&
    !isLocalDate(po.expected_delivery_date)
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'expected_delivery_date must be a real YYYY-MM-DD date',
    );
  }
  if (!Array.isArray(po.lines) || po.lines.length === 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'a purchase order must carry at least one line');
  }
  // Validate every line BEFORE any write so a malformed line isolates at the PO grain (whole-PO
  // atomic): the whole PO is rejected and no partial header/line rows survive.
  const seenLineNos = new Set<number>();
  for (const line of po.lines) {
    if (!isPositiveInt(line.line_no))
      throw new AppError(400, 'INVALID_PARAMS', 'line_no must be a positive integer');
    if (seenLineNos.has(line.line_no))
      throw new AppError(400, 'INVALID_PARAMS', `duplicate line_no ${line.line_no}`);
    seenLineNos.add(line.line_no);
    await assertSkuActive(line.sku, client);
    if (!isBoundedNumber(line.ordered_qty, MAX_QUANTITY))
      throw new AppError(400, 'INVALID_PARAMS', 'ordered_qty must be a non-negative finite number');
    if (!isBoundedNumber(line.open_qty, MAX_QUANTITY))
      throw new AppError(400, 'INVALID_PARAMS', 'open_qty must be a non-negative finite number');
    if (line.open_qty > line.ordered_qty)
      throw new AppError(400, 'INVALID_PARAMS', 'open_qty may not exceed ordered_qty');
    if (!isBoundedNumber(line.unit_price, MAX_PRICE))
      throw new AppError(400, 'INVALID_PARAMS', 'unit_price must be a non-negative finite number');
    if (
      line.over_receipt_tolerance_pct !== undefined &&
      line.over_receipt_tolerance_pct !== null &&
      !isBoundedNumber(line.over_receipt_tolerance_pct, MAX_TOLERANCE_PCT)
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'over_receipt_tolerance_pct must be a non-negative finite number when supplied',
      );
    }
    if (
      line.under_receipt_tolerance_pct !== undefined &&
      line.under_receipt_tolerance_pct !== null &&
      !isBoundedNumber(line.under_receipt_tolerance_pct, MAX_TOLERANCE_PCT)
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'under_receipt_tolerance_pct must be a non-negative finite number when supplied',
      );
    }
  }

  await upsertPurchaseOrderHeader(
    {
      po_number_ext: po.po_number_ext,
      supplier_ref_ext: po.supplier_ref_ext,
      currency: po.currency,
      expected_delivery_date: po.expected_delivery_date ?? null,
      source_snapshot: po,
    },
    client,
  );
  for (const line of po.lines) {
    await upsertPurchaseOrderLine(
      {
        po_number_ext: po.po_number_ext,
        line_no: line.line_no,
        sku: line.sku,
        ordered_qty: line.ordered_qty,
        open_qty: line.open_qty,
        unit_price: line.unit_price,
        over_receipt_tolerance_pct: line.over_receipt_tolerance_pct ?? null,
        under_receipt_tolerance_pct: line.under_receipt_tolerance_pct ?? null,
      },
      client,
    );
  }
}

async function applySalesOrderLine(so: SourceSalesOrderLine, client: PoolClient): Promise<void> {
  if (!isNonEmptyString(so.so_number_ext))
    throw new AppError(400, 'INVALID_PARAMS', 'so_number_ext is required');
  if (!isPositiveInt(so.line_no))
    throw new AppError(400, 'INVALID_PARAMS', 'line_no must be a positive integer');
  await assertSkuActive(so.sku, client);
  if (!isBoundedNumber(so.quantity, MAX_QUANTITY))
    throw new AppError(400, 'INVALID_PARAMS', 'quantity must be a non-negative finite number');
  if (so.required_by !== undefined && so.required_by !== null && !isLocalDate(so.required_by)) {
    throw new AppError(400, 'INVALID_PARAMS', 'required_by must be a real YYYY-MM-DD date');
  }
  if (!isNonEmptyString(so.ship_from_site_code_ext))
    throw new AppError(400, 'INVALID_PARAMS', 'ship_from_site_code_ext is required');
  const site = await getLocationByCode(so.ship_from_site_code_ext, client);
  if (!site || site.status !== 'active' || site.level !== 'site') {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `ship_from_site_code_ext "${so.ship_from_site_code_ext}" is not an active site`,
      {
        ship_from_site_code_ext: so.ship_from_site_code_ext,
      },
    );
  }
  await upsertSalesOrderLine(
    {
      so_number_ext: so.so_number_ext,
      line_no: so.line_no,
      sku: so.sku,
      quantity: String(so.quantity),
      required_by: so.required_by ?? null,
      ship_to_ext: so.ship_to_ext ?? null,
      ship_from_site_id: site.location_id,
      ship_from_site_code_ext: so.ship_from_site_code_ext,
      source_snapshot: so,
    },
    client,
  );
}

/**
 * Story 5.6 (FR-B-17, AD-4): rejects ONE inbound BOM record. EVERY inbound BOM record is rejected
 * unconditionally - there is no comparison step, no "identical record" shortcut, and no code path
 * here that reads or writes bom, bom_revision or bom_line. `applied` is always 0.
 *
 * A rejection is a deliberate OUTCOME, not a failure: the caller must NOT roll back to a savepoint
 * around it or the exception row written here would be discarded.
 *
 * bom_id is resolved best-effort for the event payload only, with a plain SELECT that neither
 * locks nor mutates the BOM row.
 */
async function rejectInboundBom(
  record: SourceBomRecord,
  index: number,
  client: PoolClient,
): Promise<RejectedBomRecord> {
  const bomRef =
    typeof record?.bom_ref === 'string' && record.bom_ref.trim().length > 0
      ? record.bom_ref
      : `bom#${index}`;
  const reason =
    'BOM structure is mastered by this platform (AD-4, INT-ERP-01). The inbound record was rejected and queued for the BOM Administrator; no BOM was modified.';

  // Best-effort id resolution for the audit payload. bom_ref may be a platform bom_id or an
  // ERP-side reference this platform has never seen - both are legal, and NULL is a valid answer.
  let bomId: string | null = null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bomRef)) {
    const found = await client.query('SELECT bom_id FROM bom WHERE bom_id = $1', [bomRef]);
    bomId = (found.rows[0]?.bom_id as string | undefined) ?? null;
  }

  const newlyOpened = await raiseException(
    {
      record_type: 'bom',
      source_system: 'ERP',
      error_code: ERP_ERROR_CODES.BOM_INBOUND_SYNC_REJECTED,
      source_record_ref: bomRef,
      reason,
      details: { source_snapshot: record, bom_id: bomId },
    },
    client,
  );

  // raiseException returns only the inserted/refreshed discriminator by design (shared Story 2.9
  // code with callers that depend on the boolean), so the id is read back on the same client.
  const exceptionRow = await client.query(
    `SELECT exception_id FROM integration_exception
      WHERE source_system = 'ERP' AND record_type = 'bom' AND source_record_ref = $1
        AND error_code = $2 AND status = 'open'`,
    [bomRef, ERP_ERROR_CODES.BOM_INBOUND_SYNC_REJECTED],
  );

  return {
    bom_ref: bomRef,
    bom_id: bomId,
    exception_id: (exceptionRow.rows[0]?.exception_id as string | undefined) ?? '',
    conflict_reason: reason,
    source_snapshot: record,
    newly_opened: newlyOpened,
  };
}

// ---------------------------------------------------------------------------
// Sync entry point (in-process; driven by the POST /api/v1/erp/sync trigger)
// ---------------------------------------------------------------------------

/**
 * Processes one inbound ERP sync batch. Marks the attempt heartbeat before processing, applies each
 * record under its own SAVEPOINT (per-record isolation), soft-closes records that dropped out of the
 * feed, marks the success heartbeat and clears any stale-sync alert on completion. An infrastructure
 * failure (not a per-record rejection) rolls back the batch, records a failed heartbeat, raises a
 * deduped ERP_SYNC_STALE exception, and emits a one-time non-blocking ops alert.
 */
export async function runErpSync(batch: ErpSyncBatch): Promise<ErpSyncResult> {
  const syncsPo = Object.prototype.hasOwnProperty.call(batch, 'purchase_orders');
  const syncsSo = Object.prototype.hasOwnProperty.call(batch, 'sales_orders');
  const syncsBom = Object.prototype.hasOwnProperty.call(batch, 'boms');
  const result: ErpSyncResult = {};

  // Attempt heartbeats stamped on their own statements (before the batch transaction) so they
  // survive a rollback of the batch itself.
  if (syncsPo) await markSyncAttempt('purchase_orders');
  if (syncsSo) await markSyncAttempt('sales_orders');

  const pool = getPool();
  const client = await pool.connect();
  let savepointSeq = 0;
  // Records successfully applied per projection. A cycle that applied zero records (an empty batch,
  // or a batch whose every record failed validation) must NOT soft-close the open book, must NOT
  // stamp a fresh success heartbeat, and must NOT clear the stale alert - otherwise a no-data or
  // all-rejected cycle reports a healthy, fresh, silently-emptied projection.
  const appliedPo = { count: 0 };
  const appliedSo = { count: 0 };
  try {
    await client.query('BEGIN');
    // Serialize the read-decide-persist window per projection against a concurrent cycle.
    if (syncsPo)
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEYS.purchase_orders]);
    if (syncsSo)
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEYS.sales_orders]);

    if (syncsPo) {
      const purchaseOrders = batch.purchase_orders ?? [];
      let applied = 0;
      let failed = 0;
      for (let index = 0; index < purchaseOrders.length; index++) {
        const po = purchaseOrders[index]!;
        try {
          await withSavepoint(client, `sp_${savepointSeq++}`, () => applyPurchaseOrder(po, client));
          applied += 1;
          // The record synced cleanly: drain any prior open exception for it (regardless of the
          // error code it previously failed with), so a corrected record leaves the queue.
          await resolveOpenExceptionsByGrain(
            { record_type: 'purchase_order', source_record_ref: po.po_number_ext },
            client,
          ).catch(() => undefined);
        } catch (err) {
          failed += 1;
          // A natural ref keeps distinct malformed records from colliding under NULLS NOT DISTINCT;
          // when po_number_ext is missing, fall back to the batch position so each still queues.
          const ref = typeof po?.po_number_ext === 'string' ? po.po_number_ext : `po#${index}`;
          // Best-effort: a failure inside the exception write must never abort the whole batch and
          // discard already-applied good records.
          await raiseException(
            {
              record_type: 'purchase_order',
              source_record_ref: ref,
              error_code: errorCodeOf(err),
              reason: reasonOf(err),
              details: { source_record: po },
            },
            client,
          ).catch(() => undefined);
        }
      }
      if (applied > 0) {
        const presentRefs = purchaseOrders
          .map((po) => po?.po_number_ext)
          .filter((ref): ref is string => typeof ref === 'string');
        await closePurchaseOrdersNotIn(presentRefs, client);
      }
      appliedPo.count = applied;
      result.purchase_orders = { applied, failed };
    }

    if (syncsSo) {
      const salesOrders = batch.sales_orders ?? [];
      let applied = 0;
      let failed = 0;
      for (let index = 0; index < salesOrders.length; index++) {
        const so = salesOrders[index]!;
        try {
          await withSavepoint(client, `sp_${savepointSeq++}`, () =>
            applySalesOrderLine(so, client),
          );
          applied += 1;
          await resolveOpenExceptionsByGrain(
            { record_type: 'sales_order', source_record_ref: `${so.so_number_ext}:${so.line_no}` },
            client,
          ).catch(() => undefined);
        } catch (err) {
          failed += 1;
          const ref =
            typeof so?.so_number_ext === 'string'
              ? `${so.so_number_ext}:${so?.line_no ?? '?'}`
              : `so#${index}`;
          await raiseException(
            {
              record_type: 'sales_order',
              source_record_ref: ref,
              error_code: errorCodeOf(err),
              reason: reasonOf(err),
              details: { source_record: so },
            },
            client,
          ).catch(() => undefined);
        }
      }
      if (applied > 0) {
        const present = salesOrders.filter(
          (so) => typeof so?.so_number_ext === 'string' && Number.isInteger(so?.line_no),
        );
        await closeSalesOrdersNotIn(
          present.map((so) => so.so_number_ext),
          present.map((so) => so.line_no),
          client,
        );
      }
      appliedSo.count = applied;
      result.sales_orders = { applied, failed };
    }

    if (syncsBom) {
      // Story 5.6 (AC 5): BOM structure is OUTBOUND-only. Every inbound record is rejected, so
      // `applied` is always 0 and there is NO heartbeat, soft-close or advisory lock for this
      // domain - none of it applies to a feed nothing is applied from.
      const boms = batch.boms ?? [];
      const rejected: RejectedBomRecord[] = [];
      for (let index = 0; index < boms.length; index++) {
        // Per-record SAVEPOINT for isolation of an INFRASTRUCTURE failure only. The rejection
        // itself is the successful outcome and commits; rolling it back would discard the
        // exception row the BOM Administrator needs.
        try {
          const outcome = await withSavepoint(client, `sp_${savepointSeq++}`, () =>
            rejectInboundBom(boms[index]!, index, client),
          );
          rejected.push(outcome);
        } catch (err) {
          // The queue write itself failed. Never abort the batch and discard already-applied
          // good records; the record simply does not appear in the rejected list. Log it so a
          // silently-lost rejection is at least visible to operators.
          console.error('[erp-sync] inbound BOM rejection queue write failed', err);
        }
      }
      result.boms = { applied: 0, failed: boms.length, rejected };
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Infrastructure failure of the sync cycle itself (not a per-record rejection). Record failed
    // heartbeats and raise a deduped stale alert on fresh statements, then re-throw.
    if (syncsPo) await markSyncFailure('purchase_orders', reasonOf(err)).catch(() => undefined);
    if (syncsSo) await markSyncFailure('sales_orders', reasonOf(err)).catch(() => undefined);
    for (const projection of [
      ...(syncsPo ? ['purchase_orders'] : []),
      ...(syncsSo ? ['sales_orders'] : []),
    ]) {
      await raiseErpSyncStale(projection, `ERP sync cycle failed: ${reasonOf(err)}`).catch(
        () => undefined,
      );
    }
    throw err;
  } finally {
    client.release();
  }

  // Success heartbeats + clear any open stale alert (the fresh in-threshold sync resolves it), only
  // for a projection that actually applied at least one record. Guarded best-effort so a heartbeat
  // write failing after a committed batch marks the projection failed/stale rather than throwing an
  // unhandled error over already-persisted data.
  if (syncsPo && appliedPo.count > 0) {
    try {
      await markSyncSuccess('purchase_orders');
      await resolveOpenExceptionsByGrain({
        record_type: 'sync_batch',
        source_record_ref: 'purchase_orders',
        error_code: 'ERP_SYNC_STALE',
      });
    } catch (err) {
      await markSyncFailure('purchase_orders', reasonOf(err)).catch(() => undefined);
      await raiseErpSyncStale(
        'purchase_orders',
        `ERP sync heartbeat failed: ${reasonOf(err)}`,
      ).catch(() => undefined);
    }
  }
  if (syncsSo && appliedSo.count > 0) {
    try {
      await markSyncSuccess('sales_orders');
      await resolveOpenExceptionsByGrain({
        record_type: 'sync_batch',
        source_record_ref: 'sales_orders',
        error_code: 'ERP_SYNC_STALE',
      });
    } catch (err) {
      await markSyncFailure('sales_orders', reasonOf(err)).catch(() => undefined);
      await raiseErpSyncStale('sales_orders', `ERP sync heartbeat failed: ${reasonOf(err)}`).catch(
        () => undefined,
      );
    }
  }

  return result;
}

/**
 * Raises the deduped ERP_SYNC_STALE alert for a projection (record_type = 'sync_batch') and emits a
 * one-time non-blocking ops notification only when a NEW open exception was created - so repeated
 * stale reads or repeated failures never re-notify while an alert is already open (AC3). Uses
 * emitNotification (NOT emitNotificationInTransaction) because a sync-freshness alert is not part of
 * a business write. Callers that already hold a transaction client may pass it for the exception row.
 */
export async function raiseErpSyncStale(
  projectionName: string,
  reason: string,
  client?: PoolClient,
): Promise<void> {
  const created = await raiseException(
    {
      record_type: 'sync_batch',
      source_record_ref: projectionName,
      error_code: 'ERP_SYNC_STALE',
      reason,
      details: { projection: projectionName },
    },
    client,
  );
  if (created) {
    await emitNotification({
      target: { role: 'inventory_controller', location_id: null },
      event_type: 'integration_exception',
      status_verb: 'Stale',
      object_type: 'erp_projection',
      object_id: projectionName,
      actor_label: 'ERP sync',
      next_step: reason,
      actor: { user_id: SYSTEM_ACTOR_ID, role: 'system', location_id: SYSTEM_ACTOR_ID },
    });
  }
}

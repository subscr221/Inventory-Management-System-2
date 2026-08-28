import type { QueryExecutor } from './outbox';

/**
 * Story 7.8 (FR-M-17, Binding Decision 11): the device-side worklist cache and the per-stream
 * version cursor (Binding Decision 2).
 *
 * applyWorklistSnapshot replaces the cached rows with a fresh server snapshot. The one rule that
 * matters: for a stream that still has UNSETTLED outbox rows (pending_sync or syncing), the
 * existing local_head_version is KEPT, because those rows already claimed versions above the
 * server head and a refresh must not hand out the same version twice; otherwise the cursor is
 * re-seeded from the server stream_version. nextStreamVersion reads and bumps the cursor in one
 * statement and returns the new value, which the builders stamp as event_version.
 */
export interface WorklistClosure {
  work_order_id: string;
  origin: string;
  fault_code: string;
  cause_code: string;
  remedy_code: string;
  closed_at: string;
}

export interface WorklistMeter {
  meter_id: string;
  meter_code: string;
  unit: string;
  current_reading: string;
}

export interface WorklistReservation {
  reservation_id: string;
  sku: string;
  quantity: string;
  location_id: string;
  stream_version: number;
}

export interface WorklistWorkOrder {
  work_order_id: string;
  origin: string;
  status: string;
  priority: string | null;
  due_date: string;
  sla_resolution_due_at: string | null;
  warranty_flagged: boolean;
  stream_version: number;
  asset: { asset_id: string; asset_tag: string; name: string; criticality: string };
  recent_closures: WorklistClosure[];
  reservations: WorklistReservation[];
  meters: WorklistMeter[];
}

export interface WorklistSnapshot {
  fetched_at: string;
  total: number;
  truncated: boolean;
  closure_codes: { fault: string[]; cause: string[]; remedy: string[] };
  work_orders: WorklistWorkOrder[];
}

export interface CachedWorkOrderRow {
  work_order_id: string;
  asset_id: string;
  asset_tag: string;
  asset_name: string;
  origin: string;
  status: string;
  priority: string | null;
  due_date: string;
  warranty_flagged: number;
  stream_version: number;
  local_head_version: number;
  recent_closures: string;
  meters: string;
  fetched_at: string;
}

export interface CachedReservationRow {
  reservation_id: string;
  work_order_id: string;
  sku: string;
  quantity: string;
  location_id: string;
  stream_version: number;
  local_head_version: number;
  fetched_at: string;
}

export type CachedStreamTable = 'cached_work_order' | 'cached_spare_reservation';

const STREAM_ID_COLUMN: Record<CachedStreamTable, string> = {
  cached_work_order: 'work_order_id',
  cached_spare_reservation: 'reservation_id',
};

async function unsettledStreamIds(db: QueryExecutor): Promise<Set<string>> {
  const rows = await db.getAll<{ stream_id: string }>(
    `SELECT DISTINCT stream_id FROM edge_outbox WHERE local_status IN ('pending_sync', 'syncing')`,
  );
  return new Set(rows.map((row) => row.stream_id));
}

async function existingHeads(
  db: QueryExecutor,
  table: CachedStreamTable,
): Promise<Map<string, number>> {
  const idColumn = STREAM_ID_COLUMN[table];
  const rows = await db.getAll<{ id: string; local_head_version: number }>(
    `SELECT ${idColumn} AS id, local_head_version FROM ${table}`,
  );
  return new Map(rows.map((row) => [row.id, row.local_head_version]));
}

export async function applyWorklistSnapshot(
  db: QueryExecutor,
  snapshot: WorklistSnapshot,
): Promise<void> {
  const apply = async (tx: QueryExecutor): Promise<void> => {
    const unsettled = await unsettledStreamIds(tx);
    const workOrderHeads = await existingHeads(tx, 'cached_work_order');
    const reservationHeads = await existingHeads(tx, 'cached_spare_reservation');
    const headFor = (
      heads: Map<string, number>,
      streamId: string,
      serverVersion: number,
    ): number => {
      const existing = heads.get(streamId);
      return unsettled.has(streamId) && existing !== undefined ? existing : serverVersion;
    };

    await tx.execute(`DELETE FROM cached_work_order`);
    await tx.execute(`DELETE FROM cached_spare_reservation`);
    await tx.execute(`DELETE FROM cached_closure_code`);

    for (const workOrder of snapshot.work_orders) {
      await tx.execute(
        `INSERT INTO cached_work_order (
          id, work_order_id, asset_id, asset_tag, asset_name, origin, status, priority, due_date,
          warranty_flagged, stream_version, local_head_version, recent_closures, meters, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workOrder.work_order_id,
          workOrder.work_order_id,
          workOrder.asset.asset_id,
          workOrder.asset.asset_tag,
          workOrder.asset.name,
          workOrder.origin,
          workOrder.status,
          workOrder.priority,
          workOrder.due_date,
          workOrder.warranty_flagged ? 1 : 0,
          workOrder.stream_version,
          headFor(workOrderHeads, workOrder.work_order_id, workOrder.stream_version),
          JSON.stringify(workOrder.recent_closures),
          JSON.stringify(workOrder.meters),
          snapshot.fetched_at,
        ],
      );
      for (const reservation of workOrder.reservations) {
        await tx.execute(
          `INSERT INTO cached_spare_reservation (
            id, reservation_id, work_order_id, sku, quantity, location_id, stream_version,
            local_head_version, fetched_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reservation.reservation_id,
            reservation.reservation_id,
            workOrder.work_order_id,
            reservation.sku,
            reservation.quantity,
            reservation.location_id,
            reservation.stream_version,
            headFor(reservationHeads, reservation.reservation_id, reservation.stream_version),
            snapshot.fetched_at,
          ],
        );
      }
    }
    for (const kind of ['fault', 'cause', 'remedy'] as const) {
      for (const code of snapshot.closure_codes[kind]) {
        await tx.execute(
          `INSERT INTO cached_closure_code (id, kind, code, fetched_at) VALUES (?, ?, ?, ?)`,
          [`${kind}:${code}`, kind, code, snapshot.fetched_at],
        );
      }
    }
  };

  // Run the read-modify-write in a single transaction when the driver exposes one (PowerSync), so
  // a malformed snapshot or a concurrent nextStreamVersion bump can never leave the cache wiped or
  // re-seed a lowered cursor (Task 8.3: the cursor is never lowered while a stream has unsettled
  // rows, and the snapshot is never half-applied).
  if (db.writeTransaction) {
    await db.writeTransaction(apply);
  } else {
    await apply(db);
  }
}

export async function readCachedWorkOrders(db: QueryExecutor): Promise<CachedWorkOrderRow[]> {
  return db.getAll<CachedWorkOrderRow>(
    `SELECT work_order_id, asset_id, asset_tag, asset_name, origin, status, priority, due_date,
            warranty_flagged, stream_version, local_head_version, recent_closures, meters, fetched_at
       FROM cached_work_order
      ORDER BY priority ASC, due_date ASC, work_order_id ASC`,
  );
}

export async function readCachedReservations(
  db: QueryExecutor,
  workOrderId: string,
): Promise<CachedReservationRow[]> {
  return db.getAll<CachedReservationRow>(
    `SELECT reservation_id, work_order_id, sku, quantity, location_id, stream_version,
            local_head_version, fetched_at
       FROM cached_spare_reservation
      WHERE work_order_id = ?
      ORDER BY sku ASC, reservation_id ASC`,
    [workOrderId],
  );
}

export async function readClosureCatalogue(
  db: QueryExecutor,
): Promise<{ fault: string[]; cause: string[]; remedy: string[] }> {
  const rows = await db.getAll<{ kind: string; code: string }>(
    `SELECT kind, code FROM cached_closure_code ORDER BY kind ASC, rowid ASC`,
  );
  const catalogue = { fault: [] as string[], cause: [] as string[], remedy: [] as string[] };
  for (const row of rows) {
    if (row.kind === 'fault' || row.kind === 'cause' || row.kind === 'remedy') {
      catalogue[row.kind].push(row.code);
    }
  }
  return catalogue;
}

/**
 * Reads local_head_version, increments it, and returns the new value in a SINGLE statement
 * (UPDATE ... RETURNING), so the read and the bump are atomic with respect to a second capture on
 * the device (Task 8.3). The cursor is seeded from the worklist stream_version and bumped per
 * capture; a stream that is not cached throws.
 */
export async function nextStreamVersion(
  db: QueryExecutor,
  table: CachedStreamTable,
  id: string,
): Promise<number> {
  const idColumn = STREAM_ID_COLUMN[table];
  const rows = await db.getAll<{ local_head_version: number }>(
    `UPDATE ${table} SET local_head_version = local_head_version + 1 WHERE ${idColumn} = ? RETURNING local_head_version`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`nextStreamVersion: ${table} ${id} is not cached on this device`);
  return row.local_head_version;
}

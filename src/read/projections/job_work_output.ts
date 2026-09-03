import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 9.4 (FR-JW-11): one row per job-work output lot, with the "open-to-dispatch" quantity
 * tracked via dispatched_quantity. This is the job-work-specific equivalent of the sales-order-
 * bound dispatch_order_status: no sales-order line exists for a job-work order, so that projection
 * cannot be reused (see src/compliance/jobwork-dispatch.ts header comment).
 */
export interface JobWorkOutputRow {
  output_id: string;
  service_order_id: string;
  lot_id: string;
  lot_number: string;
  sku: string;
  quantity: string;
  dispatched_quantity: string;
  uom: string;
  site_id: string;
  recorded_by: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `output_id, service_order_id, lot_id, lot_number, sku, quantity::text AS quantity,
  dispatched_quantity::text AS dispatched_quantity, uom, site_id, recorded_by, source_event_id,
  created_at, updated_at`;

export interface InsertJobWorkOutputInput {
  output_id: string;
  service_order_id: string;
  lot_id: string;
  lot_number: string;
  sku: string;
  quantity: string;
  uom: string;
  site_id: string;
  recorded_by: string;
  source_event_id: string;
}

export async function insertJobWorkOutput(
  input: InsertJobWorkOutputInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO job_work_output (
       output_id, service_order_id, lot_id, lot_number, sku, quantity, uom, site_id, recorded_by,
       source_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10)`,
    [
      input.output_id,
      input.service_order_id,
      input.lot_id,
      input.lot_number,
      input.sku,
      input.quantity,
      input.uom,
      input.site_id,
      input.recorded_by,
      input.source_event_id,
    ],
  );
}

export async function getJobWorkOutputByLotId(
  lotId: string,
  client: PoolClient,
  forUpdate: boolean = false,
): Promise<JobWorkOutputRow | null> {
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await client.query(
    `SELECT ${COLUMNS} FROM job_work_output WHERE lot_id = $1${lockClause}`,
    [lotId],
  );
  return (result.rows[0] as JobWorkOutputRow) ?? null;
}

export async function listJobWorkOutputsByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<JobWorkOutputRow[]> {
  if (!UUID_REGEX.test(serviceOrderId)) return [];
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM job_work_output WHERE service_order_id = $1 ORDER BY created_at ASC`,
    [serviceOrderId],
  );
  return result.rows as JobWorkOutputRow[];
}

/** Bounded by chk_job_work_output_dispatched_bounds; the caller has already gated the amount. */
export async function incrementJobWorkOutputDispatched(
  outputId: string,
  dispatchedDelta: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE job_work_output
        SET dispatched_quantity = dispatched_quantity + $2::numeric, updated_at = now()
      WHERE output_id = $1`,
    [outputId, dispatchedDelta],
  );
}

import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 9.6 (FR-JW-12): the ONE-per-order ERP billing feed with a lifecycle
 * (pending -> acknowledged | exception). Created by the billing_feed_generated applier, flipped by
 * the acknowledgment applier and the retry-window sweep. Money is NUMERIC(18,4) text, quantities
 * NUMERIC(18,3) text - never floated by a caller.
 */

export type JobWorkBillingFeedStatus = 'pending' | 'acknowledged' | 'exception';
export type JobWorkMeasuredBasis = 'per_piece' | 'per_kg' | 'per_hour' | 'lumpsum';

export interface JobWorkBillingFeedRow {
  feed_id: string;
  service_order_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  measured_basis: JobWorkMeasuredBasis;
  measured_quantity: string;
  currency: string;
  total_value: string;
  status: JobWorkBillingFeedStatus;
  open_to_dispatch_qty: string;
  first_sent_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledged_ref_ext: string | null;
  exception_raised_at: string | null;
  alert_sent_at: string | null;
  site_id: string;
  generated_by: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InsertBillingFeedInput {
  feed_id: string;
  service_order_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  measured_basis: JobWorkMeasuredBasis;
  measured_quantity: string;
  currency: string;
  total_value: string;
  open_to_dispatch_qty: string;
  first_sent_at: string;
  site_id: string;
  generated_by: string;
  source_event_id: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = `feed_id, service_order_id, idempotency_key, payload, measured_basis,
  measured_quantity::text AS measured_quantity, currency, total_value::text AS total_value, status,
  open_to_dispatch_qty::text AS open_to_dispatch_qty, first_sent_at, acknowledged_at, acknowledged_by,
  acknowledged_ref_ext, exception_raised_at, alert_sent_at, site_id, generated_by, source_event_id,
  created_at, updated_at`;

const toIso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function mapRow(row: Record<string, unknown>): JobWorkBillingFeedRow {
  return {
    ...(row as unknown as JobWorkBillingFeedRow),
    first_sent_at: toIso(row['first_sent_at']) as string,
    acknowledged_at: toIso(row['acknowledged_at']),
    exception_raised_at: toIso(row['exception_raised_at']),
    alert_sent_at: toIso(row['alert_sent_at']),
    created_at: toIso(row['created_at']) as string,
    updated_at: toIso(row['updated_at']) as string,
  };
}

/** Plain INSERT: a duplicate order, source event or feed id surfaces as 23505 for the seam. */
export async function insertBillingFeed(
  input: InsertBillingFeedInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO job_work_billing_feed (
       feed_id, service_order_id, idempotency_key, payload, measured_basis, measured_quantity,
       currency, total_value, status, open_to_dispatch_qty, first_sent_at, site_id, generated_by,
       source_event_id
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::numeric, $7, $8::numeric, 'pending', $9::numeric,
               $10::timestamptz, $11, $12, $13)`,
    [
      input.feed_id,
      input.service_order_id,
      input.idempotency_key,
      JSON.stringify(input.payload),
      input.measured_basis,
      input.measured_quantity,
      input.currency,
      input.total_value,
      input.open_to_dispatch_qty,
      input.first_sent_at,
      input.site_id,
      input.generated_by,
      input.source_event_id,
    ],
  );
}

export async function getBillingFeedById(
  feedId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<JobWorkBillingFeedRow | null> {
  if (!UUID_REGEX.test(feedId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_billing_feed WHERE feed_id = $1${lockClause}`,
    [feedId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

export async function getBillingFeedByOrder(
  serviceOrderId: string,
  client?: PoolClient,
): Promise<JobWorkBillingFeedRow | null> {
  if (!UUID_REGEX.test(serviceOrderId)) return null;
  const result = await runner(client).query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_billing_feed WHERE service_order_id = $1`,
    [serviceOrderId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as Record<string, unknown>) : null;
}

/**
 * Sweep candidates (Task 7.2): `pending` feeds whose first_sent_at is at or before the cutoff,
 * oldest first, bounded. The lock is a NOWAIT-free FOR UPDATE inside the sweep's own transaction.
 */
export async function listBillingFeedsDueForSweep(
  params: { cutoff: string; batchSize: number },
  client: PoolClient,
): Promise<JobWorkBillingFeedRow[]> {
  const result = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM job_work_billing_feed
      WHERE status = 'pending' AND first_sent_at <= $1::timestamptz
      ORDER BY first_sent_at ASC, feed_id ASC
      LIMIT $2
      FOR UPDATE`,
    [params.cutoff, params.batchSize],
  );
  return result.rows.map((row) => mapRow(row as Record<string, unknown>));
}

/** Guarded flip: matches only while the feed is still not acknowledged. Returns whether it flipped. */
export async function markBillingFeedAcknowledged(
  feedId: string,
  ack: { acknowledged_at: string; acknowledged_by: string; acknowledged_ref_ext: string },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    // Acknowledging an `exception` feed RESOLVES that exception, so the stamps come off with it
    // (fixed 2026-09-06). Leaving them set kept a resolved feed on the exception queue and left the
    // Story 1.11 escalation still hopping to the site head for a feed ERP had already answered.
    `UPDATE job_work_billing_feed
        SET status = 'acknowledged', acknowledged_at = $2::timestamptz, acknowledged_by = $3::uuid,
            acknowledged_ref_ext = $4, exception_raised_at = NULL, alert_sent_at = NULL,
            updated_at = now()
      WHERE feed_id = $1 AND status <> 'acknowledged'`,
    [feedId, ack.acknowledged_at, ack.acknowledged_by, ack.acknowledged_ref_ext],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Guarded flip: matches only while the feed is still `pending`. Returns whether it flipped. */
export async function markBillingFeedException(
  feedId: string,
  stamps: { exception_raised_at: string; alert_sent_at: string },
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE job_work_billing_feed
        SET status = 'exception', exception_raised_at = $2::timestamptz, alert_sent_at = $3::timestamptz,
            updated_at = now()
      WHERE feed_id = $1 AND status = 'pending'`,
    [feedId, stamps.exception_raised_at, stamps.alert_sent_at],
  );
  return (result.rowCount ?? 0) === 1;
}

export interface BillingReconciliationRow extends JobWorkBillingFeedRow {
  order_number_ext: string;
  customer_party_code: string;
}

/** The reconciliation report base (Task 8.3): every feed NOT acknowledged, site-scoped. */
export async function listUnacknowledgedBillingFeeds(
  params: { siteIds: string[] | null },
  client?: PoolClient,
): Promise<BillingReconciliationRow[]> {
  const conditions = [`f.status <> 'acknowledged'`];
  const values: unknown[] = [];
  if (params.siteIds !== null) {
    const sites = params.siteIds.filter((s) => UUID_REGEX.test(s));
    if (sites.length === 0) return [];
    values.push(sites);
    conditions.push(`f.site_id = ANY($1::uuid[])`);
  }
  const result = await runner(client).query(
    `SELECT f.feed_id, f.service_order_id, f.idempotency_key, f.payload, f.measured_basis,
            f.measured_quantity::text AS measured_quantity, f.currency, f.total_value::text AS total_value,
            f.status, f.open_to_dispatch_qty::text AS open_to_dispatch_qty, f.first_sent_at,
            f.acknowledged_at, f.acknowledged_by, f.acknowledged_ref_ext, f.exception_raised_at,
            f.alert_sent_at, f.site_id, f.generated_by, f.source_event_id, f.created_at, f.updated_at,
            o.order_number_ext, o.customer_party_code
       FROM job_work_billing_feed f
       JOIN service_order o ON o.service_order_id = f.service_order_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY f.first_sent_at ASC, f.feed_id ASC`,
    values,
  );
  return result.rows.map((row) => ({
    ...mapRow(row as Record<string, unknown>),
    order_number_ext: (row as Record<string, unknown>)['order_number_ext'] as string,
    customer_party_code: (row as Record<string, unknown>)['customer_party_code'] as string,
  }));
}

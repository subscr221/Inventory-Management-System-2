import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Outbound IRN coverage read model (Story 11.2). One row per dispatch order, recording which
 * invoice covers it. Binding decision 2: a dispatch order IS an erp_sales_order row, and ERP raises
 * MULTIPLE invoices against the same order, so dispatch_order_id is the primary key and
 * invoice_number_ext / so_number_ext are attributes, never keys. Derived state ONLY: rows are
 * written by the dispatch.irn_recorded applier in the same transaction as the event, one coverage
 * row per listed dispatch order.
 */

export interface DispatchIrnRow {
  dispatch_order_id: string;
  invoice_number_ext: string;
  irn_ext: string;
  so_number_ext: string;
  irp_acknowledged_at: string | null;
  site_id: string;
  recorded_by: string;
  source_event_id: string;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const COLUMNS = `dispatch_order_id, invoice_number_ext, irn_ext, so_number_ext,
       irp_acknowledged_at, site_id, recorded_by, source_event_id, correlation_id,
       created_at, updated_at`;

function mapRow(row: Record<string, unknown>): DispatchIrnRow {
  return {
    dispatch_order_id: row['dispatch_order_id'] as string,
    invoice_number_ext: row['invoice_number_ext'] as string,
    irn_ext: row['irn_ext'] as string,
    so_number_ext: row['so_number_ext'] as string,
    irp_acknowledged_at: (row['irp_acknowledged_at'] as string | null) ?? null,
    site_id: row['site_id'] as string,
    recorded_by: row['recorded_by'] as string,
    source_event_id: row['source_event_id'] as string,
    correlation_id: (row['correlation_id'] as string | null) ?? null,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export interface InsertDispatchIrnCoverageInput {
  dispatch_order_id: string;
  invoice_number_ext: string;
  irn_ext: string;
  so_number_ext: string;
  irp_acknowledged_at?: string | null;
  site_id: string;
  recorded_by: string;
  source_event_id: string;
  correlation_id?: string | null;
}

/** Inserts ONE coverage row. Callers loop over the coverage list inside the event transaction. */
export async function insertDispatchIrnCoverage(
  input: InsertDispatchIrnCoverageInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO dispatch_irn
       (dispatch_order_id, invoice_number_ext, irn_ext, so_number_ext, irp_acknowledged_at,
        site_id, recorded_by, source_event_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.dispatch_order_id,
      input.invoice_number_ext,
      input.irn_ext,
      input.so_number_ext,
      input.irp_acknowledged_at ?? null,
      input.site_id,
      input.recorded_by,
      input.source_event_id,
      input.correlation_id ?? null,
    ],
  );
}

export interface SupersedeDispatchIrnInput {
  dispatch_order_id: string;
  irn_ext: string;
  irp_acknowledged_at?: string | null;
  recorded_by: string;
  source_event_id: string;
  correlation_id?: string | null;
}

/**
 * Supersedes the IRN on an existing coverage row (review decision D1, 2026-09-09): the SAME invoice
 * re-recorded with a DIFFERENT IRN - the IRP cancel-and-regenerate case - replaces the stored IRN in
 * place and stamps the superseding event. The invoice number itself is never changed here; a
 * different invoice is a DISPATCH_IRN_CONFLICT in the applier, not an update. This is the ONLY
 * UPDATE path on dispatch_irn, and it runs on the caller's client inside the event transaction.
 */
export async function supersedeDispatchIrn(
  input: SupersedeDispatchIrnInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE dispatch_irn
        SET irn_ext = $2,
            irp_acknowledged_at = $3,
            recorded_by = $4,
            source_event_id = $5,
            correlation_id = $6,
            updated_at = now()
      WHERE dispatch_order_id = $1`,
    [
      input.dispatch_order_id,
      input.irn_ext,
      input.irp_acknowledged_at ?? null,
      input.recorded_by,
      input.source_event_id,
      input.correlation_id ?? null,
    ],
  );
}

/**
 * Full coverage row by dispatch order (pool-scoped). Used by the GET /irn route, which must answer
 * for ONE dispatch order only.
 */
export async function getDispatchIrn(
  dispatchOrderId: string,
  client?: PoolClient,
): Promise<DispatchIrnRow | null> {
  const result = await runner(client).query(
    `SELECT ${COLUMNS} FROM dispatch_irn WHERE dispatch_order_id = $1`,
    [dispatchOrderId],
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]!) : null;
}

/**
 * Direct primary-key presence lookup for the gate. The gate already holds the dispatch order id and
 * coverage is stored at exactly that grain, so no join is needed on the hot path. Runs on the
 * caller's client so the check happens inside the same locked transaction as the event persist.
 */
export async function dispatchIrnPresent(
  dispatchOrderId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM dispatch_irn WHERE dispatch_order_id = $1`, [
    dispatchOrderId,
  ]);
  return result.rows.length > 0;
}

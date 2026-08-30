import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Production scrap declaration read model (Story 6.3, FR-MO-08). Derived state only: rows are
 * rebuildable by replaying production_order.scrap_declared events, and mutation happens exclusively
 * through persistEvent, which applies this projection inside the SAME transaction as the
 * domain_events insert. Append-only - no update or delete accessor exists because app_user holds
 * no such privilege.
 *
 * A declaration relieves WIP and moves NO stock (Binding Decision 10). relieved_value is the value
 * actually drained from the order's open postings at their issued cost, computed in SQL NUMERIC.
 */

export interface ProductionScrapDeclarationRow {
  scrap_id: string;
  production_order_id: string;
  /** Exact decimal string (NUMERIC(18,6)); never a JS number. */
  scrap_quantity: string;
  uom: string;
  reason_code: string;
  /** Exact decimal string (NUMERIC(14,3)); never a JS number. */
  relieved_value: string;
  business_date: string;
  declared_by: string;
  declared_at: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const SCRAP_COLUMNS = `scrap_id, production_order_id, scrap_quantity, uom, reason_code,
       relieved_value, business_date, declared_by, declared_at, source_event_id, created_at`;

function mapRow(row: Record<string, unknown>): ProductionScrapDeclarationRow {
  const iso = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);
  const day = (value: unknown): string =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return {
    scrap_id: row['scrap_id'] as string,
    production_order_id: row['production_order_id'] as string,
    scrap_quantity: String(row['scrap_quantity']),
    uom: row['uom'] as string,
    reason_code: row['reason_code'] as string,
    relieved_value: String(row['relieved_value']),
    business_date: day(row['business_date']),
    declared_by: row['declared_by'] as string,
    declared_at: iso(row['declared_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: iso(row['created_at']),
  };
}

export interface InsertScrapDeclarationInput {
  scrap_id: string;
  production_order_id: string;
  scrap_quantity: string;
  uom: string;
  reason_code: string;
  relieved_value: string;
  business_date: string;
  declared_by: string;
  declared_at: string;
  source_event_id: string;
}

export async function insertScrapDeclaration(
  input: InsertScrapDeclarationInput,
  client: PoolClient,
): Promise<ProductionScrapDeclarationRow> {
  const result = await client.query(
    `INSERT INTO production_scrap_declaration (
      scrap_id, production_order_id, scrap_quantity, uom, reason_code, relieved_value,
      business_date, declared_by, declared_at, source_event_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING ${SCRAP_COLUMNS}`,
    [
      input.scrap_id,
      input.production_order_id,
      input.scrap_quantity,
      input.uom,
      input.reason_code,
      input.relieved_value,
      input.business_date,
      input.declared_by,
      input.declared_at,
      input.source_event_id,
    ],
  );
  return mapRow(result.rows[0]!);
}

export interface ListScrapDeclarationsParams {
  orderId: string;
  limit?: number | undefined;
  offset?: number | undefined;
  client?: PoolClient;
}

export async function listScrapDeclarationsByOrder(
  params: ListScrapDeclarationsParams,
): Promise<ProductionScrapDeclarationRow[]> {
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await runner(params.client).query(
    `SELECT ${SCRAP_COLUMNS} FROM production_scrap_declaration
      WHERE production_order_id = $1
      ORDER BY created_at ASC, scrap_id ASC
      LIMIT $2 OFFSET $3`,
    [params.orderId, limit, offset],
  );
  return result.rows.map(mapRow);
}

/** The cumulative declared scrap quantity of an order, settled in SQL NUMERIC. */
export async function getScrappedQuantity(orderId: string, client: PoolClient): Promise<string> {
  const result = await client.query(
    `SELECT COALESCE(SUM(scrap_quantity), 0)::text AS scrapped
       FROM production_scrap_declaration WHERE production_order_id = $1`,
    [orderId],
  );
  return String(result.rows[0]!['scrapped']);
}

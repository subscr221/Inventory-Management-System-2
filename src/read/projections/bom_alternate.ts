import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 5.5 approved-alternate / ad-hoc-substitution read model (FR-B-12). One row per alternate
 * on a Released BOM line. origin 'approved' rows come from bom.alternate_defined; origin 'ad_hoc'
 * rows come from bom.substitution_approved and carry their DOA evidence.
 */
export interface BomAlternateRow {
  bom_alternate_id: string;
  bom_id: string;
  revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  alternate_item_id: string;
  alternate_sku: string | null;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  origin: 'approved' | 'ad_hoc';
  doa_entry_id: string | null;
  approver_actor_id: string | null;
  defined_by: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

// node-pg parses DATE columns as local-midnight JS Dates, which toISOString() shifts one calendar
// day back on any east-of-UTC server. Every read selects the date columns as ::text so the
// contract type (string, YYYY-MM-DD) is what actually leaves the database and the API.
const ALTERNATE_DATE_COLUMNS = `
  bom_alternate_id, bom_id, revision_id, bom_line_id, line_no, component_item_id,
  alternate_item_id, alternate_sku, priority, effective_from::text AS effective_from,
  effective_to::text AS effective_to, origin, doa_entry_id, approver_actor_id, defined_by,
  source_event_id, created_at, updated_at`;

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export async function insertBomAlternate(
  row: Omit<BomAlternateRow, 'created_at' | 'updated_at'>,
  client: PoolClient,
): Promise<void> {
  // is_released_structure is stamped true: alternates are only ever created on released revisions
  // of released BOMs (the compliance seam enforces both), so every row is released structure for
  // the PowerSync bucket. updateBomStatus clears it on hold/obsolete.
  await client.query(
    `INSERT INTO bom_alternate (bom_alternate_id, bom_id, revision_id, bom_line_id, line_no, component_item_id, alternate_item_id, alternate_sku, priority, effective_from, effective_to, origin, doa_entry_id, approver_actor_id, is_released_structure, defined_by, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15, $16)`,
    [
      row.bom_alternate_id,
      row.bom_id,
      row.revision_id,
      row.bom_line_id,
      row.line_no,
      row.component_item_id,
      row.alternate_item_id,
      row.alternate_sku,
      row.priority,
      row.effective_from,
      row.effective_to,
      row.origin,
      row.doa_entry_id,
      row.approver_actor_id,
      row.defined_by,
      row.source_event_id,
    ],
  );
}

export async function getAlternateById(
  bomAlternateId: string,
  client?: PoolClient,
): Promise<BomAlternateRow | null> {
  if (!UUID_REGEX.test(bomAlternateId)) return null;
  const result = await runner(client).query(
    `SELECT ${ALTERNATE_DATE_COLUMNS} FROM bom_alternate WHERE bom_alternate_id = $1`,
    [bomAlternateId],
  );
  return (result.rows[0] as BomAlternateRow) ?? null;
}

export async function getAlternatesByBomLine(
  bomLineId: string,
  client?: PoolClient,
): Promise<BomAlternateRow[]> {
  if (!UUID_REGEX.test(bomLineId)) return [];
  const result = await runner(client).query(
    `SELECT ${ALTERNATE_DATE_COLUMNS} FROM bom_alternate WHERE bom_line_id = $1 ORDER BY priority ASC, effective_from ASC`,
    [bomLineId],
  );
  return result.rows as BomAlternateRow[];
}

export async function getAlternatesByBom(
  bomId: string,
  client?: PoolClient,
): Promise<BomAlternateRow[]> {
  if (!UUID_REGEX.test(bomId)) return [];
  const result = await runner(client).query(
    `SELECT ${ALTERNATE_DATE_COLUMNS} FROM bom_alternate WHERE bom_id = $1 ORDER BY component_item_id ASC, priority ASC, effective_from ASC`,
    [bomId],
  );
  return result.rows as BomAlternateRow[];
}

/**
 * AC 1's "available to execution in priority order" accessor: the alternates whose effectivity
 * window is open on the given IST business date, priority ASC. The date comparison happens in
 * PostgreSQL DATE arithmetic, never in JS.
 */
export async function getOpenAlternatesForLineOnDate(
  bomLineId: string,
  istDate: string,
  client?: PoolClient,
): Promise<BomAlternateRow[]> {
  if (!UUID_REGEX.test(bomLineId)) return [];
  // Format-only validation would let '2026-99-99' through to the ::date cast as a raw 500; the
  // round-trip check rejects calendar-impossible dates before they reach PostgreSQL.
  if (!isDateString(istDate)) return [];
  const result = await runner(client).query(
    `SELECT ${ALTERNATE_DATE_COLUMNS} FROM bom_alternate
      WHERE bom_line_id = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY priority ASC, effective_from ASC`,
    [bomLineId, istDate],
  );
  return result.rows as BomAlternateRow[];
}

/**
 * Batched form of getOpenAlternatesForLineOnDate for the explosion walk, so a multi-thousand-line
 * BOM costs one round trip instead of one per requirement row. Per-line ordering (priority ASC,
 * then effective_from ASC) is preserved by the single global ORDER BY.
 */
export async function getOpenAlternatesForLinesOnDate(
  bomLineIds: string[],
  istDate: string,
  client?: PoolClient,
): Promise<BomAlternateRow[]> {
  const valid = bomLineIds.filter((id) => UUID_REGEX.test(id));
  if (valid.length === 0 || !isDateString(istDate)) return [];
  const result = await runner(client).query(
    `SELECT ${ALTERNATE_DATE_COLUMNS} FROM bom_alternate
      WHERE bom_line_id = ANY($1::uuid[])
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY priority ASC, effective_from ASC`,
    [valid, istDate],
  );
  return result.rows as BomAlternateRow[];
}

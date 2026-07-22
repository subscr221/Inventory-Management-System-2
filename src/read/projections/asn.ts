import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Minimal ASN reference projection accessor (Story 3.4, INT-SUP-02). Like the Story 2.9 ERP
 * projection this is reference data, NOT event-sourced: the upsert helpers are used directly by the
 * ASN intake endpoint (src/api/v1/asn.ts), never through persistEvent. expiry_date is read through
 * to_char(...,'YYYY-MM-DD'); expected_qty is bound/returned as a NUMERIC string.
 */
export interface Asn {
  asn_number_ext: string;
  po_ref_ext: string;
  supplier_ref_ext: string;
  site_id: string;
  status: string;
  source_snapshot: unknown;
  created_at: string;
  updated_at: string;
}

export interface AsnLine {
  asn_number_ext: string;
  line_no: number;
  sku: string;
  expected_qty: string;
  lot_number: string | null;
  serial_number: string | null;
  expiry_date: string | null;
}

export interface AsnWithLines extends Asn {
  lines: AsnLine[];
}

export interface UpsertAsnHeaderInput {
  asn_number_ext: string;
  po_ref_ext: string;
  supplier_ref_ext: string;
  site_id: string;
  status?: string;
  source_snapshot?: unknown;
}

export interface UpsertAsnLineInput {
  asn_number_ext: string;
  line_no: number;
  sku: string;
  expected_qty: number | string;
  lot_number?: string | null;
  serial_number?: string | null;
  expiry_date?: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function ts(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const HEADER_COLUMNS = `asn_number_ext, po_ref_ext, supplier_ref_ext, site_id, status, source_snapshot,
       created_at, updated_at`;

const LINE_COLUMNS = `asn_number_ext, line_no, sku, expected_qty::text AS expected_qty, lot_number,
       serial_number, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date`;

function mapHeader(row: Record<string, unknown>): Asn {
  return {
    asn_number_ext: row['asn_number_ext'] as string,
    po_ref_ext: row['po_ref_ext'] as string,
    supplier_ref_ext: row['supplier_ref_ext'] as string,
    site_id: row['site_id'] as string,
    status: row['status'] as string,
    source_snapshot: row['source_snapshot'] ?? null,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

function mapLine(row: Record<string, unknown>): AsnLine {
  return {
    asn_number_ext: row['asn_number_ext'] as string,
    line_no: Number(row['line_no']),
    sku: row['sku'] as string,
    expected_qty: String(row['expected_qty']),
    lot_number: (row['lot_number'] as string | null) ?? null,
    serial_number: (row['serial_number'] as string | null) ?? null,
    expiry_date: (row['expiry_date'] as string | null) ?? null,
  };
}

/** The ASN header plus its lines (single-header, multi-line assembly), or null when unknown. */
export async function getAsnByNumber(asnNumberExt: string, client?: PoolClient): Promise<AsnWithLines | null> {
  const q = runner(client);
  const headerResult = await q.query(`SELECT ${HEADER_COLUMNS} FROM asn WHERE asn_number_ext = $1`, [asnNumberExt]);
  if (headerResult.rows.length === 0) return null;
  const header = mapHeader(headerResult.rows[0]!);
  const lineResult = await q.query(`SELECT ${LINE_COLUMNS} FROM asn_line WHERE asn_number_ext = $1 ORDER BY line_no`, [asnNumberExt]);
  return { ...header, lines: lineResult.rows.map(mapLine) };
}

/** Upserts an ASN header by asn_number_ext. Re-transmitting an unchanged ASN stays idempotent. */
export async function upsertAsnHeader(input: UpsertAsnHeaderInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO asn
       (asn_number_ext, po_ref_ext, supplier_ref_ext, site_id, status, source_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (asn_number_ext) DO UPDATE SET
       po_ref_ext = EXCLUDED.po_ref_ext,
       supplier_ref_ext = EXCLUDED.supplier_ref_ext,
       site_id = EXCLUDED.site_id,
       status = EXCLUDED.status,
       source_snapshot = EXCLUDED.source_snapshot,
       updated_at = now()`,
    [
      input.asn_number_ext,
      input.po_ref_ext,
      input.supplier_ref_ext,
      input.site_id,
      input.status ?? 'open',
      input.source_snapshot === undefined ? null : JSON.stringify(input.source_snapshot),
    ],
  );
}

/** Upserts an ASN line by (asn_number_ext, line_no). expected_qty bound as a string for precision. */
export async function upsertAsnLine(input: UpsertAsnLineInput, client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO asn_line
       (asn_number_ext, line_no, sku, expected_qty, lot_number, serial_number, expiry_date)
     VALUES ($1, $2, $3, $4::numeric, $5, $6, $7)
     ON CONFLICT (asn_number_ext, line_no) DO UPDATE SET
       sku = EXCLUDED.sku,
       expected_qty = EXCLUDED.expected_qty,
       lot_number = EXCLUDED.lot_number,
       serial_number = EXCLUDED.serial_number,
       expiry_date = EXCLUDED.expiry_date,
       updated_at = now()`,
    [
      input.asn_number_ext,
      input.line_no,
      input.sku,
      String(input.expected_qty),
      input.lot_number ?? null,
      input.serial_number ?? null,
      input.expiry_date ?? null,
    ],
  );
}

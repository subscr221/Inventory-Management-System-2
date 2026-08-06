import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export interface SupplierInvoiceRow {
  invoice_id: string;
  supplier_id: string;
  supplier_gstin_ext: string;
  invoice_number_ext: string;
  invoice_number_normalized: string;
  invoice_date: string;
  financial_year_start: number;
  po_id: string | null;
  site_id: string | null;
  business_stream: string | null;
  status: 'unmatched' | 'captured';
  currency: string;
  recipient_gstin_ext: string | null;
  irn_ext: string | null;
  subtotal: string | null;
  cgst_total: string | null;
  sgst_total: string | null;
  igst_total: string | null;
  cess_total: string | null;
  total_value: string | null;
  msme_classification_at_capture: string | null;
  statutory_due_date: string | null;
  statutory_due_rule_version: string | null;
  duplicate_of_invoice_id: string | null;
  duplicate_override_reason: string | null;
  capture_method: 'manual' | 'file' | null;
  ingestion_id: string | null;
  captured_by: string;
  captured_at: string;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface SupplierInvoiceLineRow {
  invoice_line_id: string;
  invoice_id: string;
  line_no: number;
  po_line_id: string | null;
  sku: string;
  quantity: string;
  uom: string;
  unit_price: string;
  taxable_value: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  cess_amount: string;
  line_total: string;
}

export interface SupplierInvoiceIngestionRow {
  ingestion_id: string;
  source_format: 'pdf' | 'csv' | 'xml';
  attachment_ref: string;
  sha256_hash: string;
  detected_mime: string;
  byte_size: string;
  extracted_draft: Record<string, unknown>;
  review_status: 'review-required' | 'reviewed';
  uploaded_by: string;
  uploaded_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  correction_summary: Record<string, unknown> | null;
  resulting_invoice_id: string | null;
  correlation_id: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSupplierInvoiceById(
  invoiceId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<SupplierInvoiceRow | null> {
  if (!UUID_REGEX.test(invoiceId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT * FROM supplier_invoice WHERE invoice_id = $1${lockClause}`,
    [invoiceId],
  );
  return (result.rows[0] as SupplierInvoiceRow) ?? null;
}

/**
 * The authoritative duplicate-grain lookup (AC3): supplier GSTIN + normalized invoice number +
 * Indian financial year, restricted to non-overridden rows (mirrors the partial unique index
 * uq_supplier_invoice_duplicate_grain exactly). Used both for the seam's pre-check and for the
 * unique-index-violation fallback (Task 3.7) so a concurrent loser gets the same detail shape.
 */
export async function getSupplierInvoiceByDuplicateGrain(
  supplierGstinExt: string,
  invoiceNumberNormalized: string,
  financialYearStart: number,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<SupplierInvoiceRow | null> {
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT * FROM supplier_invoice
     WHERE supplier_gstin_ext = $1
       AND invoice_number_normalized = $2
       AND financial_year_start = $3
       AND duplicate_of_invoice_id IS NULL
     LIMIT 1${lockClause}`,
    [supplierGstinExt, invoiceNumberNormalized, financialYearStart],
  );
  return (result.rows[0] as SupplierInvoiceRow) ?? null;
}

export async function getSupplierInvoiceLines(
  invoiceId: string,
  client?: PoolClient,
): Promise<SupplierInvoiceLineRow[]> {
  if (!UUID_REGEX.test(invoiceId)) return [];
  const r = runner(client);
  const result = await r.query(
    `SELECT * FROM supplier_invoice_line WHERE invoice_id = $1 ORDER BY line_no ASC`,
    [invoiceId],
  );
  return result.rows as SupplierInvoiceLineRow[];
}

export interface ListSupplierInvoicesParams {
  status?: SupplierInvoiceRow['status'] | undefined;
  supplierId?: string | undefined;
  siteId?: string | undefined;
  invoiceDate?: string | undefined;
  financialYearStart?: number | undefined;
  search?: string | undefined;
  permittedSites?: { wildcard: boolean; locations: Set<string> } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * AC7: site-scoped users never receive cross-site invoices; unmatched rows with a null site are
 * visible only to wildcard procurement readers. The site filter therefore ANDs a NULL-site
 * exclusion onto every non-wildcard read rather than merely restricting to permitted site ids.
 */
export async function listSupplierInvoices(
  params: ListSupplierInvoicesParams,
  client?: PoolClient,
): Promise<SupplierInvoiceRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.supplierId) {
    if (!UUID_REGEX.test(params.supplierId)) return [];
    conditions.push(`supplier_id = $${idx++}`);
    values.push(params.supplierId);
  }
  if (params.siteId) {
    if (!UUID_REGEX.test(params.siteId)) return [];
    conditions.push(`site_id = $${idx++}`);
    values.push(params.siteId);
  }
  if (params.invoiceDate) {
    conditions.push(`invoice_date = $${idx++}`);
    values.push(params.invoiceDate);
  }
  if (params.financialYearStart !== undefined) {
    conditions.push(`financial_year_start = $${idx++}`);
    values.push(params.financialYearStart);
  }
  if (params.search) {
    const escaped = params.search.replace(/[%_\\]/g, '\\$&');
    conditions.push(`(invoice_number_ext ILIKE $${idx} ESCAPE '\\')`);
    values.push(`%${escaped}%`);
    idx += 1;
  }
  if (params.permittedSites && !params.permittedSites.wildcard) {
    const sites = [...params.permittedSites.locations].filter((s) => UUID_REGEX.test(s));
    if (sites.length === 0) return [];
    conditions.push(`site_id = ANY($${idx++}::uuid[])`);
    values.push(sites);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await r.query(
    `SELECT * FROM supplier_invoice ${where} ORDER BY created_at DESC, invoice_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as SupplierInvoiceRow[];
}

export interface InsertSupplierInvoiceInput {
  invoice_id: string;
  supplier_id: string;
  supplier_gstin_ext: string;
  invoice_number_ext: string;
  invoice_number_normalized: string;
  invoice_date: string;
  financial_year_start: number;
  po_id: string | null;
  site_id: string | null;
  business_stream: string | null;
  status: 'unmatched' | 'captured';
  currency: string;
  recipient_gstin_ext: string | null;
  irn_ext: string | null;
  subtotal: string | null;
  cgst_total: string | null;
  sgst_total: string | null;
  igst_total: string | null;
  cess_total: string | null;
  total_value: string;
  msme_classification_at_capture: string | null;
  statutory_due_date: string | null;
  statutory_due_rule_version: string | null;
  duplicate_of_invoice_id: string | null;
  duplicate_override_reason: string | null;
  capture_method: 'manual' | 'file';
  ingestion_id: string | null;
  captured_by: string;
  captured_at: string;
  correlation_id: string | null;
  source_event_id: string;
}

export async function insertSupplierInvoice(
  row: InsertSupplierInvoiceInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO supplier_invoice (
      invoice_id, supplier_id, supplier_gstin_ext, invoice_number_ext, invoice_number_normalized,
      invoice_date, financial_year_start, po_id, site_id, business_stream, status, currency,
      recipient_gstin_ext, irn_ext, subtotal, cgst_total, sgst_total, igst_total, cess_total,
      total_value, msme_classification_at_capture, statutory_due_date, statutory_due_rule_version,
      duplicate_of_invoice_id, duplicate_override_reason, capture_method, ingestion_id,
      captured_by, captured_at, correlation_id, source_event_id
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::numeric,$16::numeric,$17::numeric,
      $18::numeric,$19::numeric,$20::numeric,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
    )`,
    [
      row.invoice_id,
      row.supplier_id,
      row.supplier_gstin_ext,
      row.invoice_number_ext,
      row.invoice_number_normalized,
      row.invoice_date,
      row.financial_year_start,
      row.po_id,
      row.site_id,
      row.business_stream,
      row.status,
      row.currency,
      row.recipient_gstin_ext,
      row.irn_ext,
      row.subtotal,
      row.cgst_total,
      row.sgst_total,
      row.igst_total,
      row.cess_total,
      row.total_value,
      row.msme_classification_at_capture,
      row.statutory_due_date,
      row.statutory_due_rule_version,
      row.duplicate_of_invoice_id,
      row.duplicate_override_reason,
      row.capture_method,
      row.ingestion_id,
      row.captured_by,
      row.captured_at,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export interface InsertSupplierInvoiceLineInput {
  invoice_line_id: string;
  invoice_id: string;
  line_no: number;
  po_line_id: string | null;
  sku: string;
  quantity: number;
  uom: string;
  unit_price: number;
  taxable_value: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  cess_amount: number;
  line_total: number;
}

export async function insertSupplierInvoiceLine(
  row: InsertSupplierInvoiceLineInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO supplier_invoice_line (
      invoice_line_id, invoice_id, line_no, po_line_id, sku, quantity, uom, unit_price,
      taxable_value, cgst_amount, sgst_amount, igst_amount, cess_amount, line_total
    ) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8::numeric,$9::numeric,$10::numeric,$11::numeric,
      $12::numeric,$13::numeric,$14::numeric)`,
    [
      row.invoice_line_id,
      row.invoice_id,
      row.line_no,
      row.po_line_id,
      row.sku,
      row.quantity,
      row.uom,
      row.unit_price,
      row.taxable_value,
      row.cgst_amount,
      row.sgst_amount,
      row.igst_amount,
      row.cess_amount,
      row.line_total,
    ],
  );
}

/**
 * Recomputes header GST/monetary totals from the persisted lines entirely in PostgreSQL NUMERIC
 * (Task 3.6) and returns the SQL-computed total_value so the caller can compare the client's
 * submitted total exactly at paise scale - never a JS float sum.
 */
export async function recomputeSupplierInvoiceTotals(
  invoiceId: string,
  client: PoolClient,
): Promise<{
  subtotal: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  cess_total: string;
  total_value: string;
}> {
  const result = await client.query(
    `UPDATE supplier_invoice AS si SET
       subtotal = agg.subtotal,
       cgst_total = agg.cgst_total,
       sgst_total = agg.sgst_total,
       igst_total = agg.igst_total,
       cess_total = agg.cess_total,
       total_value = agg.total_value,
       updated_at = now()
     FROM (
       SELECT
         COALESCE(SUM(taxable_value), 0) AS subtotal,
         COALESCE(SUM(cgst_amount), 0) AS cgst_total,
         COALESCE(SUM(sgst_amount), 0) AS sgst_total,
         COALESCE(SUM(igst_amount), 0) AS igst_total,
         COALESCE(SUM(cess_amount), 0) AS cess_total,
         COALESCE(SUM(line_total), 0) AS total_value
       FROM supplier_invoice_line WHERE invoice_id = $1
     ) agg
     WHERE si.invoice_id = $1
     RETURNING si.subtotal, si.cgst_total, si.sgst_total, si.igst_total, si.cess_total, si.total_value`,
    [invoiceId],
  );
  return result.rows[0] as {
    subtotal: string;
    cgst_total: string;
    sgst_total: string;
    igst_total: string;
    cess_total: string;
    total_value: string;
  };
}

export async function updateSupplierInvoicePoLink(
  invoiceId: string,
  poId: string,
  siteId: string,
  businessStream: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE supplier_invoice
       SET status = 'captured', po_id = $2, site_id = $3, business_stream = $4, updated_at = now()
     WHERE invoice_id = $1`,
    [invoiceId, poId, siteId, businessStream],
  );
}

// ---------------------------------------------------------------------------
// Ingestion (file-review) accessors
// ---------------------------------------------------------------------------

export async function getSupplierInvoiceIngestionById(
  ingestionId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<SupplierInvoiceIngestionRow | null> {
  if (!UUID_REGEX.test(ingestionId)) return null;
  const r = runner(client);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await r.query(
    `SELECT * FROM supplier_invoice_ingestion WHERE ingestion_id = $1${lockClause}`,
    [ingestionId],
  );
  return (result.rows[0] as SupplierInvoiceIngestionRow) ?? null;
}

export interface InsertSupplierInvoiceIngestionInput {
  ingestion_id: string;
  source_format: 'pdf' | 'csv' | 'xml';
  attachment_ref: string;
  sha256_hash: string;
  detected_mime: string;
  byte_size: number;
  extracted_draft: unknown;
  uploaded_by: string;
  uploaded_at: string;
  correlation_id: string | null;
  source_event_id: string;
}

export async function insertSupplierInvoiceIngestion(
  row: InsertSupplierInvoiceIngestionInput,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO supplier_invoice_ingestion (
      ingestion_id, source_format, attachment_ref, sha256_hash, detected_mime, byte_size,
      extracted_draft, uploaded_by, uploaded_at, correlation_id, source_event_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.ingestion_id,
      row.source_format,
      row.attachment_ref,
      row.sha256_hash,
      row.detected_mime,
      row.byte_size,
      JSON.stringify(row.extracted_draft),
      row.uploaded_by,
      row.uploaded_at,
      row.correlation_id,
      row.source_event_id,
    ],
  );
}

export async function markSupplierInvoiceIngestionReviewed(
  ingestionId: string,
  reviewedBy: string,
  reviewedAt: string,
  correctionSummary: unknown,
  resultingInvoiceId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE supplier_invoice_ingestion
     SET review_status = 'reviewed', reviewed_by = $2, reviewed_at = $3,
         correction_summary = $4, resulting_invoice_id = $5, updated_at = now()
     WHERE ingestion_id = $1`,
    [
      ingestionId,
      reviewedBy,
      reviewedAt,
      JSON.stringify(correctionSummary ?? {}),
      resultingInvoiceId,
    ],
  );
}

export interface ListSupplierInvoiceIngestionsParams {
  reviewStatus?: SupplierInvoiceIngestionRow['review_status'] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listSupplierInvoiceIngestions(
  params: ListSupplierInvoiceIngestionsParams,
  client?: PoolClient,
): Promise<SupplierInvoiceIngestionRow[]> {
  const r = runner(client);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.reviewStatus) {
    conditions.push(`review_status = $${idx++}`);
    values.push(params.reviewStatus);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit =
    Number.isInteger(params.limit) && params.limit! > 0 ? Math.min(params.limit!, 200) : 50;
  const offset = Number.isInteger(params.offset) && params.offset! >= 0 ? params.offset! : 0;
  const result = await r.query(
    `SELECT * FROM supplier_invoice_ingestion ${where} ORDER BY created_at DESC, ingestion_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as SupplierInvoiceIngestionRow[];
}

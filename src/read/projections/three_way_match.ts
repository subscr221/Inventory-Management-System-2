import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Three-way match read model (Story 4.5, FR-P-07).
 *
 * The comparison itself lives here as SQL, not as TypeScript: every quantity and money value is
 * exact PostgreSQL NUMERIC and crosses the wire as a string, so no JS float ever participates in
 * a payment-blocking decision (the Story 4.4 DOA lesson). The applier in
 * src/compliance/three-way-match.ts calls computeMatchVariance inside the persistEvent
 * transaction and stores its verbatim output as the match record's variance_detail.
 */

export interface ThreeWayMatchRow {
  match_id: string;
  invoice_id: string;
  po_id: string;
  site_id: string | null;
  business_stream: string | null;
  status: 'passed' | 'blocked' | 'lifted';
  error_code: string | null;
  variance_detail: unknown;
  tolerance_rule_version: string;
  lifted_note_id: string | null;
  lifted_note_type: 'credit_note' | 'debit_note' | null;
  run_by: string;
  recorded_at: string;
  lifted_at: string | null;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const THREE_WAY_MATCH_COLUMNS = `match_id, invoice_id, po_id, site_id, business_stream,
       status, error_code, variance_detail, tolerance_rule_version, lifted_note_id,
       lifted_note_type, run_by, recorded_at, lifted_at, source_event_id, created_at, updated_at`;

export async function getMatchById(
  matchId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<ThreeWayMatchRow | null> {
  if (!UUID_REGEX.test(matchId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${THREE_WAY_MATCH_COLUMNS} FROM three_way_match WHERE match_id = $1${lockClause}`,
    [matchId],
  );
  return (result.rows[0] as ThreeWayMatchRow) ?? null;
}

/** The most recent match RUN for an invoice. Earlier runs stay queryable through listMatches. */
export async function getLatestMatchByInvoiceId(
  invoiceId: string,
  client?: PoolClient,
  forUpdate: boolean = false,
): Promise<ThreeWayMatchRow | null> {
  if (!UUID_REGEX.test(invoiceId)) return null;
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const result = await runner(client).query(
    `SELECT ${THREE_WAY_MATCH_COLUMNS} FROM three_way_match
     WHERE invoice_id = $1
     ORDER BY recorded_at DESC, match_id DESC
     LIMIT 1${lockClause}`,
    [invoiceId],
  );
  return (result.rows[0] as ThreeWayMatchRow | undefined) ?? null;
}

export interface ListMatchesParams {
  invoiceId?: string | undefined;
  poId?: string | undefined;
  status?: ThreeWayMatchRow['status'] | undefined;
  permittedSites?: { wildcard: boolean; locations: Set<string> } | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listMatches(
  params: ListMatchesParams,
  client?: PoolClient,
): Promise<ThreeWayMatchRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.invoiceId) {
    if (!UUID_REGEX.test(params.invoiceId)) return [];
    conditions.push(`invoice_id = $${idx++}`);
    values.push(params.invoiceId);
  }
  if (params.poId) {
    if (!UUID_REGEX.test(params.poId)) return [];
    conditions.push(`po_id = $${idx++}`);
    values.push(params.poId);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  // Site scoping mirrors listSupplierInvoices: a non-wildcard reader never sees a null-site row,
  // so a match against an invoice whose site could not be resolved stays wildcard-only.
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
  const result = await runner(client).query(
    `SELECT ${THREE_WAY_MATCH_COLUMNS} FROM three_way_match ${where}
     ORDER BY recorded_at DESC, match_id ASC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset],
  );
  return result.rows as ThreeWayMatchRow[];
}

// ---------------------------------------------------------------------------
// The match computation (exact NUMERIC, entirely in SQL)
// ---------------------------------------------------------------------------

export interface MatchLineComparison {
  line_no: number;
  sku: string;
  po_qty: string;
  received_qty: string;
  invoice_qty: string;
  qty_variance_pct: string;
  po_unit_price: string;
  invoice_unit_price: string;
  price_variance_pct: string;
  /** Set only when the line fails: 'quantity' | 'price' | 'ambiguous_sku'. */
  failure_reason?: string;
}

export interface MatchComparison {
  lines: MatchLineComparison[];
  /** Invoice lines that resolve to no PO line at all - a failure, never a crash. */
  unmatched_invoice_lines: Array<{ line_no: number; sku: string; quantity: string }>;
  invoice_total_value: string;
  matched_line_value_total: string;
  invoice_value_variance_abs: string;
  /** Computed in SQL NUMERIC against the configured absolute tolerance - never a JS float. */
  invoice_value_within_tolerance: boolean;
  grn_ids: string[];
}

interface MatchToleranceInput {
  quantityTolerancePercent: number;
  priceTolerancePercent: number;
  invoiceValueToleranceAbsolute: number;
}

/**
 * Compares PO, receipt and invoice for one (invoice, PO) pair.
 *
 * Quantity agreement is expressed as ONE percent per line: the largest pairwise difference among
 * ordered, received and invoiced quantity, relative to the ordered quantity. A single number keeps
 * the tolerance rule expressible as one configured percent while still failing when any leg of the
 * triangle disagrees.
 *
 * Receipts are aggregated at SKU grain across every GRN bound to the PO, counting only 'posted'
 * and 'quarantined' lines - quarantined stock was physically received and its QC disposition is
 * Epic 8's problem, while 'rejected' was never received. Where one SKU appears on more than one PO
 * line the SKU-grain aggregate cannot be attributed to a single line, so those lines fail closed
 * with 'ambiguous_sku' rather than silently double-counting the receipt.
 *
 * Every pass/fail decision is computed IN THE SQL as a boolean against the tolerance parameters on
 * the unrounded NUMERIC expressions (Binding Decision 8). The rounded pct strings below are
 * display/audit values only; TypeScript never compares them.
 */
export async function computeMatchVariance(
  invoiceId: string,
  poId: string,
  tolerances: MatchToleranceInput,
  client: PoolClient,
): Promise<MatchComparison> {
  const linesResult = await client.query(
    `WITH received AS (
       SELECT gl.sku, SUM(gl.received_qty) AS received_qty
       FROM grn_line gl
       JOIN grn g ON g.grn_id = gl.grn_id
       WHERE g.po_id = $2 AND gl.status IN ('posted', 'quarantined')
       GROUP BY gl.sku
     ),
     po_sku_lines AS (
       SELECT sku, COUNT(*) AS line_count FROM purchase_order_line WHERE po_id = $2 GROUP BY sku
     ),
     invoiced AS (
       SELECT
         pol.po_line_id,
         SUM(sil.quantity) AS invoice_qty,
         SUM(sil.quantity * sil.unit_price) AS invoice_extended,
         SUM(sil.line_total) AS invoice_line_value
       FROM purchase_order_line pol
       JOIN supplier_invoice_line sil
         ON sil.invoice_id = $1
        AND (sil.po_line_id = pol.po_line_id
             OR (sil.po_line_id IS NULL AND sil.line_no = pol.line_no AND sil.sku = pol.sku))
       WHERE pol.po_id = $2
       GROUP BY pol.po_line_id
     )
     SELECT
       pol.line_no,
       pol.sku,
       pol.ordered_qty::text                              AS po_qty,
       COALESCE(r.received_qty, 0)::text                  AS received_qty,
       COALESCE(i.invoice_qty, 0)::text                   AS invoice_qty,
       pol.unit_price::text                               AS po_unit_price,
       CASE
         WHEN COALESCE(i.invoice_qty, 0) = 0 THEN 0
         ELSE round(i.invoice_extended / i.invoice_qty, 4)
       END::text                                          AS invoice_unit_price,
       round(
         100 * GREATEST(
           ABS(COALESCE(r.received_qty, 0) - pol.ordered_qty),
           ABS(COALESCE(i.invoice_qty, 0) - pol.ordered_qty),
           ABS(COALESCE(i.invoice_qty, 0) - COALESCE(r.received_qty, 0))
         ) / NULLIF(pol.ordered_qty, 0),
         6
       )::text                                            AS qty_variance_pct,
       CASE
         WHEN pol.unit_price = 0 THEN
           CASE WHEN COALESCE(i.invoice_extended, 0) = 0 THEN 0 ELSE 100 END
         ELSE round(
           100 * ABS(
             (CASE
                WHEN COALESCE(i.invoice_qty, 0) = 0 THEN 0
                ELSE round(i.invoice_extended / i.invoice_qty, 4)
              END) - pol.unit_price
           ) / pol.unit_price,
           6
         )
       END::text                                          AS price_variance_pct,
       -- The DECISION columns: unrounded NUMERIC compared to the configured tolerances in SQL.
       -- ordered_qty carries chk_po_line_qty_positive (> 0), so the NULLIF guard never yields NULL.
       (100 * GREATEST(
         ABS(COALESCE(r.received_qty, 0) - pol.ordered_qty),
         ABS(COALESCE(i.invoice_qty, 0) - pol.ordered_qty),
         ABS(COALESCE(i.invoice_qty, 0) - COALESCE(r.received_qty, 0))
       ) / pol.ordered_qty) <= $3::numeric                AS qty_within_tolerance,
       (CASE
         WHEN pol.unit_price = 0 THEN
           CASE WHEN COALESCE(i.invoice_extended, 0) = 0 THEN 0 ELSE 100 END
         ELSE
           100 * ABS(
             (CASE
                WHEN COALESCE(i.invoice_qty, 0) = 0 THEN 0
                ELSE i.invoice_extended / i.invoice_qty
              END) - pol.unit_price
           ) / pol.unit_price
       END) <= $4::numeric                                AS price_within_tolerance,
       COALESCE(i.invoice_line_value, 0)::text            AS matched_line_value,
       (psl.line_count > 1)                               AS ambiguous_sku
     FROM purchase_order_line pol
     LEFT JOIN received r ON r.sku = pol.sku
     LEFT JOIN invoiced i ON i.po_line_id = pol.po_line_id
     JOIN po_sku_lines psl ON psl.sku = pol.sku
     WHERE pol.po_id = $2
     ORDER BY pol.line_no ASC`,
    [invoiceId, poId, tolerances.quantityTolerancePercent, tolerances.priceTolerancePercent],
  );

  // Invoice lines that resolve to no PO line: neither by po_line_id nor by the line_no fallback.
  // A file-review capture can produce these; they are a match failure, never a crash.
  const orphanResult = await client.query(
    `SELECT sil.line_no, sil.sku, sil.quantity::text AS quantity
     FROM supplier_invoice_line sil
     WHERE sil.invoice_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM purchase_order_line pol
         WHERE pol.po_id = $2
           AND (sil.po_line_id = pol.po_line_id
                OR (sil.po_line_id IS NULL AND sil.line_no = pol.line_no AND sil.sku = pol.sku))
       )
     ORDER BY sil.line_no ASC`,
    [invoiceId, poId],
  );

  const headerResult = await client.query(
    `SELECT
       COALESCE(si.total_value, 0)::text AS invoice_total_value,
       COALESCE(m.matched_total, 0)::text AS matched_line_value_total,
       ABS(COALESCE(si.total_value, 0) - COALESCE(m.matched_total, 0))::text AS variance_abs,
       ABS(COALESCE(si.total_value, 0) - COALESCE(m.matched_total, 0)) <= $3::numeric
         AS invoice_value_within_tolerance
     FROM supplier_invoice si
     LEFT JOIN (
       SELECT SUM(sil.line_total) AS matched_total
       FROM supplier_invoice_line sil
       WHERE sil.invoice_id = $1
         AND EXISTS (
           SELECT 1 FROM purchase_order_line pol
           WHERE pol.po_id = $2
             AND (sil.po_line_id = pol.po_line_id
                  OR (sil.po_line_id IS NULL AND sil.line_no = pol.line_no AND sil.sku = pol.sku))
         )
     ) m ON true
     WHERE si.invoice_id = $1`,
    [invoiceId, poId, tolerances.invoiceValueToleranceAbsolute],
  );

  const grnResult = await client.query(
    `SELECT DISTINCT g.grn_id
     FROM grn g
     JOIN grn_line gl ON gl.grn_id = g.grn_id AND gl.status IN ('posted', 'quarantined')
     WHERE g.po_id = $1
     ORDER BY g.grn_id ASC`,
    [poId],
  );

  const lines: MatchLineComparison[] = (linesResult.rows as Record<string, unknown>[]).map(
    (row) => {
      const line: MatchLineComparison = {
        line_no: row['line_no'] as number,
        sku: row['sku'] as string,
        po_qty: row['po_qty'] as string,
        received_qty: row['received_qty'] as string,
        invoice_qty: row['invoice_qty'] as string,
        qty_variance_pct: row['qty_variance_pct'] as string,
        po_unit_price: row['po_unit_price'] as string,
        invoice_unit_price: row['invoice_unit_price'] as string,
        price_variance_pct: row['price_variance_pct'] as string,
      };
      // The pass/fail decision arrives from SQL as exact NUMERIC booleans (inclusive at the
      // boundary, AC2). No JS float participates in it.
      if (row['ambiguous_sku'] === true) line.failure_reason = 'ambiguous_sku';
      else if (row['qty_within_tolerance'] !== true) line.failure_reason = 'quantity';
      else if (row['price_within_tolerance'] !== true) line.failure_reason = 'price';
      return line;
    },
  );

  const header = (headerResult.rows[0] as Record<string, unknown>) ?? {};

  return {
    lines,
    unmatched_invoice_lines: (orphanResult.rows as Record<string, unknown>[]).map((row) => ({
      line_no: row['line_no'] as number,
      sku: row['sku'] as string,
      quantity: row['quantity'] as string,
    })),
    invoice_total_value: (header['invoice_total_value'] as string) ?? '0',
    matched_line_value_total: (header['matched_line_value_total'] as string) ?? '0',
    invoice_value_variance_abs: (header['variance_abs'] as string) ?? '0',
    invoice_value_within_tolerance: header['invoice_value_within_tolerance'] === true,
    grn_ids: (grnResult.rows as Record<string, unknown>[]).map((r) => r['grn_id'] as string),
  };
}

// ---------------------------------------------------------------------------
// Writers (called only from the compliance applier, inside persistEvent)
// ---------------------------------------------------------------------------

export interface InsertThreeWayMatchInput {
  match_id: string;
  invoice_id: string;
  po_id: string;
  site_id: string | null;
  business_stream: string | null;
  status: 'passed' | 'blocked';
  error_code: string | null;
  variance_detail: unknown;
  tolerance_rule_version: string;
  run_by: string;
  recorded_at: string;
  source_event_id: string;
}

export async function insertThreeWayMatch(
  input: InsertThreeWayMatchInput,
  client: PoolClient,
): Promise<number> {
  // ON CONFLICT DO NOTHING: a replayed or spoofed three_way_match.recorded event carrying an
  // existing match_id must not abort the persistEvent transaction with a raw 23505. The rowCount
  // tells the applier whether the row was actually written, so it can skip the invoice
  // match_status mirror update when the match_id already existed.
  const result = await client.query(
    `INSERT INTO three_way_match (
       match_id, invoice_id, po_id, site_id, business_stream, status, error_code,
       variance_detail, tolerance_rule_version, run_by, recorded_at, source_event_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
     ON CONFLICT (match_id) DO NOTHING`,
    [
      input.match_id,
      input.invoice_id,
      input.po_id,
      input.site_id,
      input.business_stream,
      input.status,
      input.error_code,
      JSON.stringify(input.variance_detail),
      input.tolerance_rule_version,
      input.run_by,
      input.recorded_at,
      input.source_event_id,
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * AC3: the ONLY transition out of 'blocked'. Guarded on status = 'blocked' in the predicate as
 * well as in the applier, so a racing second note cannot lift an already-lifted match.
 */
export async function liftThreeWayMatch(
  matchId: string,
  noteId: string,
  noteType: 'credit_note' | 'debit_note',
  liftedAt: string,
  client: PoolClient,
): Promise<number> {
  const result = await client.query(
    `UPDATE three_way_match
        SET status = 'lifted', lifted_note_id = $2, lifted_note_type = $3, lifted_at = $4,
            updated_at = now()
      WHERE match_id = $1 AND status = 'blocked'`,
    [matchId, noteId, noteType, liftedAt],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Payment clearance eligibility (AC3)
// ---------------------------------------------------------------------------

export interface ClearanceEligibleInvoiceRow {
  invoice_id: string;
  invoice_number_ext: string;
  supplier_id: string;
  supplier_legal_name: string;
  po_id: string;
  po_number_ext: string;
  match_id: string;
  match_status: 'passed' | 'lifted';
  total_value: string;
  statutory_due_date: string | null;
  msme_classification_at_capture: string | null;
}

/**
 * The clearance feed's row set: captured invoices whose latest match passed, or was blocked and
 * subsequently lifted by a credit or debit note. Everything else - blocked matches AND invoices
 * that were never matched at all - is omitted, which IS the payment block (AC3: payment executes
 * in ERP, so withholding clearance is the only lever this system has).
 *
 * `permittedSites` scopes the interactive read (the /eligible route). The feed BUILDER calls this
 * without it: the ERP clearance feed is a global deliverable, matching the msme_ageing_feed
 * precedent.
 */
export async function listClearanceEligibleInvoices(
  client: PoolClient,
  permittedSites?: { wildcard: boolean; locations: Set<string> },
): Promise<ClearanceEligibleInvoiceRow[]> {
  const conditions: string[] = [
    `si.status = 'captured'`,
    `si.match_status IN ('passed', 'lifted')`,
  ];
  const values: unknown[] = [];
  // Site scoping mirrors listMatches: a non-wildcard reader never sees a null-site invoice.
  if (permittedSites && !permittedSites.wildcard) {
    const sites = [...permittedSites.locations].filter((s) => UUID_REGEX.test(s));
    if (sites.length === 0) return [];
    values.push(sites);
    conditions.push(`si.site_id = ANY($${values.length}::uuid[])`);
  }
  const result = await client.query(
    `SELECT
       si.invoice_id,
       si.invoice_number_ext,
       si.supplier_id,
       s.legal_name AS supplier_legal_name,
       si.po_id,
       po.po_number_ext,
       m.match_id,
       si.match_status,
       COALESCE(si.total_value, 0)::text AS total_value,
       si.statutory_due_date::text AS statutory_due_date,
       si.msme_classification_at_capture
     FROM supplier_invoice si
     JOIN supplier s ON s.supplier_id = si.supplier_id
     JOIN purchase_order po ON po.po_id = si.po_id
     JOIN LATERAL (
       SELECT t.match_id
       FROM three_way_match t
       WHERE t.invoice_id = si.invoice_id
       ORDER BY t.recorded_at DESC, t.match_id DESC
       LIMIT 1
     ) m ON true
     WHERE ${conditions.join(' AND ')}
     ORDER BY si.invoice_id ASC`,
    values,
  );
  return result.rows as ClearanceEligibleInvoiceRow[];
}

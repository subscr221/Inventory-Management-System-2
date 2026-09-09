import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { dateColumnToString } from './site_gstin.js';
import type { Rule28Basis } from './branch_transfer_valuation_config.js';

/**
 * Branch transfer valuation and GST document read models (Story 11.5). Both are derived state
 * written ONLY by the transfer-seam appliers inside the event transaction:
 *   - branch_transfer_valuation: one row per inter-GSTIN transfer (sibling of transfer_request,
 *     Binding Decision 3), created at transfer_request.created and re-valued by
 *     transfer_request.valuation_overridden.
 *   - branch_transfer_gst_document: one row per (transfer, kind), written by
 *     transfer_request.gst_document_recorded.
 */

/**
 * Which path produced the recorded value. `declared` is the create-time path where the creator
 * supplied `declared_unit_value` outright: the audit trail must record a human's figure as
 * declared, never as system-derived `config_default` (code review D3). `override` is written ONLY
 * by the gst_officer re-valuation UPDATE below, which hard-codes it.
 */
export type BasisSource = 'config_default' | 'declared' | 'override';
export type GstDocumentKind = 'tax_invoice' | 'e_way_bill';
export const GST_DOCUMENT_KINDS: readonly GstDocumentKind[] = ['tax_invoice', 'e_way_bill'];

export interface BranchTransferValuationRow {
  transfer_request_id: string;
  from_site_id: string;
  to_site_id: string;
  from_gstin_ext: string;
  to_gstin_ext: string;
  business_date: string;
  valuation_config_id: string | null;
  valuation_basis: Rule28Basis;
  basis_source: BasisSource;
  cost_plus_percent: string | null;
  declared_unit_value: string | null;
  unit_value: string;
  taxable_value: string;
  currency: string;
  overridden_by: string | null;
  override_reason_code: string | null;
  valued_at: string;
  source_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface BranchTransferGstDocumentRow {
  document_id: string;
  transfer_request_id: string;
  document_kind: GstDocumentKind;
  document_number_ext: string;
  irn_ext: string | null;
  irp_acknowledged_at: string | null;
  ewb_valid_until: string | null;
  issued_at: string;
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

function tsOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : ts(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const VALUATION_COLUMNS = `transfer_request_id, from_site_id, to_site_id, from_gstin_ext, to_gstin_ext,
       business_date, valuation_config_id, valuation_basis, basis_source, cost_plus_percent,
       declared_unit_value, unit_value, taxable_value, currency, overridden_by, override_reason_code,
       valued_at, source_event_id, created_at, updated_at`;

function mapValuation(row: Record<string, unknown>): BranchTransferValuationRow {
  return {
    transfer_request_id: row['transfer_request_id'] as string,
    from_site_id: row['from_site_id'] as string,
    to_site_id: row['to_site_id'] as string,
    from_gstin_ext: row['from_gstin_ext'] as string,
    to_gstin_ext: row['to_gstin_ext'] as string,
    business_date: dateColumnToString(row['business_date']),
    valuation_config_id: (row['valuation_config_id'] as string | null) ?? null,
    valuation_basis: row['valuation_basis'] as Rule28Basis,
    basis_source: row['basis_source'] as BasisSource,
    cost_plus_percent: strOrNull(row['cost_plus_percent']),
    declared_unit_value: strOrNull(row['declared_unit_value']),
    unit_value: String(row['unit_value']),
    taxable_value: String(row['taxable_value']),
    currency: row['currency'] as string,
    overridden_by: (row['overridden_by'] as string | null) ?? null,
    override_reason_code: (row['override_reason_code'] as string | null) ?? null,
    valued_at: ts(row['valued_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export interface InsertBranchTransferValuationInput {
  transfer_request_id: string;
  from_site_id: string;
  to_site_id: string;
  from_gstin_ext: string;
  to_gstin_ext: string;
  business_date: string;
  valuation_config_id: string | null;
  valuation_basis: Rule28Basis;
  /**
   * `config_default` (the default) when the value came from the resolved dated configuration, or
   * `declared` when the creator supplied `declared_unit_value`. Never `override` - that is the
   * exclusive property of overrideBranchTransferValuation.
   */
  basis_source?: Exclude<BasisSource, 'override'>;
  cost_plus_percent: string | null;
  declared_unit_value: string | null;
  unit_value: string;
  taxable_value: string;
  valued_at: string;
  source_event_id: string;
}

/** Inserts the create-time valuation row inside the transfer_request.created transaction. */
export async function insertBranchTransferValuation(
  input: InsertBranchTransferValuationInput,
  client: PoolClient,
): Promise<BranchTransferValuationRow> {
  const result = await client.query(
    `INSERT INTO branch_transfer_valuation
       (transfer_request_id, from_site_id, to_site_id, from_gstin_ext, to_gstin_ext, business_date,
        valuation_config_id, valuation_basis, basis_source, cost_plus_percent, declared_unit_value,
        unit_value, taxable_value, valued_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${VALUATION_COLUMNS}`,
    [
      input.transfer_request_id,
      input.from_site_id,
      input.to_site_id,
      input.from_gstin_ext,
      input.to_gstin_ext,
      input.business_date,
      input.valuation_config_id,
      input.valuation_basis,
      input.basis_source ?? 'config_default',
      input.cost_plus_percent,
      input.declared_unit_value,
      input.unit_value,
      input.taxable_value,
      input.valued_at,
      input.source_event_id,
    ],
  );
  return mapValuation(result.rows[0]!);
}

export interface OverrideBranchTransferValuationInput {
  transfer_request_id: string;
  /**
   * The configuration row the override actually resolved against, or null when the officer's basis
   * needs none. Re-stamped because an override may land on a different dated window (or a basis
   * with a different cost_plus_percent) than the CREATE-time resolution: leaving the create-time id
   * in place while writing the override's cost_plus_percent makes the row internally inconsistent
   * as an audit record (code review P9).
   */
  valuation_config_id: string | null;
  valuation_basis: Rule28Basis;
  cost_plus_percent: string | null;
  declared_unit_value: string | null;
  unit_value: string;
  taxable_value: string;
  overridden_by: string;
  override_reason_code: string;
  valued_at: string;
  source_event_id: string;
}

/**
 * Re-values the row on the officer's basis (basis_source = 'override'). The ONLY UPDATE path on
 * branch_transfer_valuation; runs on the caller's client under the transfer row lock.
 */
export async function overrideBranchTransferValuation(
  input: OverrideBranchTransferValuationInput,
  client: PoolClient,
): Promise<BranchTransferValuationRow> {
  const result = await client.query(
    `UPDATE branch_transfer_valuation
        SET valuation_config_id = $2,
            valuation_basis = $3,
            basis_source = 'override',
            cost_plus_percent = $4,
            declared_unit_value = $5,
            unit_value = $6,
            taxable_value = $7,
            overridden_by = $8,
            override_reason_code = $9,
            valued_at = $10,
            source_event_id = $11,
            updated_at = now()
      WHERE transfer_request_id = $1
      RETURNING ${VALUATION_COLUMNS}`,
    [
      input.transfer_request_id,
      input.valuation_config_id,
      input.valuation_basis,
      input.cost_plus_percent,
      input.declared_unit_value,
      input.unit_value,
      input.taxable_value,
      input.overridden_by,
      input.override_reason_code,
      input.valued_at,
      input.source_event_id,
    ],
  );
  return mapValuation(result.rows[0]!);
}

/** The valuation row for a transfer, or null when the transfer is not an inter-GSTIN supply. */
export async function getBranchTransferValuation(
  transferRequestId: string,
  client?: PoolClient,
): Promise<BranchTransferValuationRow | null> {
  const result = await runner(client).query(
    `SELECT ${VALUATION_COLUMNS} FROM branch_transfer_valuation WHERE transfer_request_id = $1`,
    [transferRequestId],
  );
  return result.rows.length > 0 ? mapValuation(result.rows[0]!) : null;
}

const DOCUMENT_COLUMNS = `document_id, transfer_request_id, document_kind, document_number_ext, irn_ext,
       irp_acknowledged_at, ewb_valid_until, issued_at, site_id, recorded_by, source_event_id,
       correlation_id, created_at, updated_at`;

function mapDocument(row: Record<string, unknown>): BranchTransferGstDocumentRow {
  return {
    document_id: row['document_id'] as string,
    transfer_request_id: row['transfer_request_id'] as string,
    document_kind: row['document_kind'] as GstDocumentKind,
    document_number_ext: row['document_number_ext'] as string,
    irn_ext: (row['irn_ext'] as string | null) ?? null,
    irp_acknowledged_at: tsOrNull(row['irp_acknowledged_at']),
    ewb_valid_until: tsOrNull(row['ewb_valid_until']),
    issued_at: ts(row['issued_at']),
    site_id: row['site_id'] as string,
    recorded_by: row['recorded_by'] as string,
    source_event_id: row['source_event_id'] as string,
    correlation_id: (row['correlation_id'] as string | null) ?? null,
    created_at: ts(row['created_at']),
    updated_at: ts(row['updated_at']),
  };
}

export interface InsertBranchTransferGstDocumentInput {
  transfer_request_id: string;
  document_kind: GstDocumentKind;
  document_number_ext: string;
  irn_ext: string | null;
  irp_acknowledged_at: string | null;
  ewb_valid_until: string | null;
  issued_at: string;
  site_id: string;
  recorded_by: string;
  source_event_id: string;
  correlation_id: string | null;
}

/** Inserts ONE document row inside the recording event's transaction. */
export async function insertBranchTransferGstDocument(
  input: InsertBranchTransferGstDocumentInput,
  client: PoolClient,
): Promise<BranchTransferGstDocumentRow> {
  const result = await client.query(
    `INSERT INTO branch_transfer_gst_document
       (transfer_request_id, document_kind, document_number_ext, irn_ext, irp_acknowledged_at,
        ewb_valid_until, issued_at, site_id, recorded_by, source_event_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${DOCUMENT_COLUMNS}`,
    [
      input.transfer_request_id,
      input.document_kind,
      input.document_number_ext,
      input.irn_ext,
      input.irp_acknowledged_at,
      input.ewb_valid_until,
      input.issued_at,
      input.site_id,
      input.recorded_by,
      input.source_event_id,
      input.correlation_id,
    ],
  );
  return mapDocument(result.rows[0]!);
}

/** Every document recorded for a transfer, tax invoice first. */
export async function listBranchTransferGstDocuments(
  transferRequestId: string,
  client?: PoolClient,
): Promise<BranchTransferGstDocumentRow[]> {
  const result = await runner(client).query(
    `SELECT ${DOCUMENT_COLUMNS} FROM branch_transfer_gst_document
      WHERE transfer_request_id = $1
      ORDER BY CASE document_kind WHEN 'tax_invoice' THEN 0 ELSE 1 END, document_kind ASC`,
    [transferRequestId],
  );
  return result.rows.map(mapDocument);
}

/** The document of one kind for a transfer, or null. */
export async function getBranchTransferGstDocument(
  transferRequestId: string,
  kind: GstDocumentKind,
  client?: PoolClient,
): Promise<BranchTransferGstDocumentRow | null> {
  const result = await runner(client).query(
    `SELECT ${DOCUMENT_COLUMNS} FROM branch_transfer_gst_document
      WHERE transfer_request_id = $1 AND document_kind = $2`,
    [transferRequestId, kind],
  );
  return result.rows.length > 0 ? mapDocument(result.rows[0]!) : null;
}

/** True when ANY GST document exists for the transfer (the VALUATION_LOCKED predicate). */
export async function branchTransferHasGstDocument(
  transferRequestId: string,
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM branch_transfer_gst_document WHERE transfer_request_id = $1 LIMIT 1`,
    [transferRequestId],
  );
  return result.rows.length > 0;
}

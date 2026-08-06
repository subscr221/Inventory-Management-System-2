import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import type { SupplierInvoiceLineInput } from '../events/schema.js';
import {
  getSupplierInvoiceById,
  getSupplierInvoiceByDuplicateGrain,
  insertSupplierInvoice,
  insertSupplierInvoiceLine,
  recomputeSupplierInvoiceTotals,
  updateSupplierInvoicePoLink,
  getSupplierInvoiceIngestionById,
  insertSupplierInvoiceIngestion,
  markSupplierInvoiceIngestionReviewed,
} from '../read/projections/supplier_invoice.js';
import type { SupplierInvoiceRow } from '../read/projections/supplier_invoice.js';
import { getSupplierById } from '../read/projections/supplier.js';
import { getPurchaseOrderById, getPurchaseOrderLines } from '../read/projections/purchase_order.js';
import type { PurchaseOrderRow, PurchaseOrderLineRow } from '../read/projections/purchase_order.js';
import { getSupplierMsmeContext, computeStatutoryDueDate } from './msme.js';

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
const SUPPLIER_INVOICE_EVENT_TYPES = new Set([
  'invoice_ingestion.staged',
  'invoice_ingestion.reviewed',
  'supplier_invoice.captured',
  'supplier_invoice.unmatched_recorded',
  'supplier_invoice.po_linked',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/i;
// Same statutory GSTIN grammar as src/compliance/supplier.ts (state code + PAN + entity + Z + check).
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
// An IRN is the 64-character hex hash assigned by the e-invoice registry.
const IRN_REGEX = /^[0-9a-f]{64}$/i;
const MAX_NUMERIC_14_2 = 999_999_999_999.99;
const MAX_NUMERIC_14_3 = 99_999_999_999.999;
const MAX_NUMERIC_14_4 = 9_999_999_999.9999;
const MAX_NUMERIC_14_2_PAISE = 99_999_999_999_999;
const SOURCE_FORMATS = new Set(['pdf', 'csv', 'xml']);
// Foreign currency is deferred by the Binding Scope Decisions - INR is the only legal value here.
const SUPPORTED_CURRENCIES = new Set(['INR']);
// Bounds that keep indexed text under the btree row-size ceiling and domain_events payloads sane.
const MAX_INVOICE_NUMBER_LENGTH = 200;
const MAX_ATTACHMENT_REF_LENGTH = 512;
const MAX_DETECTED_MIME_LENGTH = 255;
const MAX_SKU_LENGTH = 100;
const MAX_UOM_LENGTH = 32;
const MAX_OVERRIDE_REASON_LENGTH = 1000;
const MAX_INVOICE_LINES = 1000;
// Plausibility window for invoice_date: statutory registers reject far-future dates outright and
// anything predating GST-era record keeping.
const MIN_INVOICE_DATE = '2000-01-01';
const MAX_FUTURE_INVOICE_DATE_DAYS = 7;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

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

function hasScale(value: number, scale: number): boolean {
  // Round-trip through the scaled integer: any value representable at this scale survives
  // unchanged, while a fixed epsilon would reject legitimate amounts (123.45 * 100 carries
  // ~2e-12 of float error, far above Number.EPSILON-sized tolerances).
  const factor = 10 ** scale;
  return Math.round(value * factor) / factor === value;
}

function hasNumericScale(value: unknown, scale: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && hasScale(value, scale);
}

/** Exact paise from a shape-validated 2-decimal JSON number (never used on raw input). */
function paiseFromNumber(value: number): number {
  return Math.round(value * 100);
}

/**
 * Exact paise from a PostgreSQL NUMERIC(14,2) string. Parsed digit-wise, never through a float,
 * so the comparison against a submitted total is authoritative (Task 3.6).
 */
function paiseFromDbString(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new AppError(500, 'INTERNAL_ERROR', `Unparseable NUMERIC value from database: ${value}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const frac = Number(((match[3] ?? '') + '00').slice(0, 2));
  return sign * (whole * 100 + frac);
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

/**
 * Preserves invoice_number_ext exactly after an outer trim (Binding Scope Decisions); never
 * removes internal spaces, slashes, hyphens, punctuation, or leading zeros - those may be legally
 * significant on a GST invoice.
 */
export function normalizeInvoiceNumberExt(raw: string): string {
  return raw.trim();
}

/**
 * Unicode-safe uppercase of the outer-trimmed value (Binding Scope Decisions). NFC canonical
 * composition first, so composed and decomposed spellings of the same character produce the same
 * duplicate-grain key; no characters are added or removed.
 */
export function normalizeInvoiceNumber(raw: string): string {
  return raw.trim().normalize('NFC').toUpperCase();
}

/**
 * Plausibility window on top of strict calendar validation: an invoice register must not accept
 * dates before GST-era record keeping or more than a few days in the future relative to the
 * event's occurred_at (never the server wall clock, which would break replay determinism).
 */
function assertInvoiceDatePlausible(invoiceDate: string, occurredAt: string): void {
  if (invoiceDate < MIN_INVOICE_DATE) {
    reject('INVALID_PARAMS', `invoice_date must not be before ${MIN_INVOICE_DATE}`, {
      invoice_date: invoiceDate,
    });
  }
  const occurred = new Date(occurredAt);
  if (!Number.isNaN(occurred.getTime())) {
    const limit = new Date(occurred.getTime() + MAX_FUTURE_INVOICE_DATE_DAYS * 24 * 60 * 60 * 1000);
    const limitDate = limit.toISOString().slice(0, 10);
    if (invoiceDate > limitDate) {
      reject(
        'INVALID_PARAMS',
        `invoice_date must not be more than ${MAX_FUTURE_INVOICE_DATE_DAYS} days in the future`,
        { invoice_date: invoiceDate, limit: limitDate },
      );
    }
  }
}

/**
 * Indian financial year (April 1 - March 31 IST by default) derived from invoice_date and the
 * configured start month - never from upload or event time (Binding Scope Decisions).
 */
export function computeFinancialYearStart(
  invoiceDate: string,
  startMonth: number = config.supplierInvoice.financialYearStartMonth,
): number {
  const match = DATE_REGEX.exec(invoiceDate);
  if (!match) throw new AppError(400, 'INVALID_PARAMS', 'invoice_date must be a YYYY-MM-DD date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= startMonth ? year : year - 1;
}

export function supplierInvoiceEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!SUPPLIER_INVOICE_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

function assertLineShape(line: Record<string, unknown>, lineNo: number): void {
  if (
    line['po_line_id'] !== undefined &&
    line['po_line_id'] !== null &&
    !isUuid(line['po_line_id'])
  ) {
    reject('INVALID_PARAMS', `Line ${lineNo}: po_line_id must be a UUID when supplied`);
  }
  if (!isNonEmptyString(line['sku']) || line['sku'].trim().length > MAX_SKU_LENGTH) {
    reject(
      'INVALID_PARAMS',
      `Line ${lineNo}: sku is required and must be a non-empty string of at most ${MAX_SKU_LENGTH} characters`,
    );
  }
  if (
    !hasNumericScale(line['quantity'], 3) ||
    (line['quantity'] as number) <= 0 ||
    (line['quantity'] as number) > MAX_NUMERIC_14_3
  ) {
    reject(
      'INVALID_PARAMS',
      `Line ${lineNo}: quantity is required and must be positive with at most 3 decimals`,
    );
  }
  if (!isNonEmptyString(line['uom']) || line['uom'].trim().length > MAX_UOM_LENGTH) {
    reject(
      'INVALID_PARAMS',
      `Line ${lineNo}: uom is required and must be a non-empty string of at most ${MAX_UOM_LENGTH} characters`,
    );
  }
  if (
    !hasNumericScale(line['unit_price'], 4) ||
    (line['unit_price'] as number) < 0 ||
    (line['unit_price'] as number) > MAX_NUMERIC_14_4
  ) {
    reject(
      'INVALID_PARAMS',
      `Line ${lineNo}: unit_price is required and must be non-negative with at most 4 decimals`,
    );
  }
  if (
    !hasNumericScale(line['taxable_value'], 2) ||
    (line['taxable_value'] as number) < 0 ||
    (line['taxable_value'] as number) > MAX_NUMERIC_14_2
  ) {
    reject(
      'INVALID_PARAMS',
      `Line ${lineNo}: taxable_value is required and must be non-negative with at most 2 decimals`,
    );
  }
  for (const field of ['cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount'] as const) {
    const value = line[field];
    if (value === undefined || value === null) continue;
    if (
      !hasNumericScale(value, 2) ||
      (value as number) < 0 ||
      (value as number) > MAX_NUMERIC_14_2
    ) {
      reject(
        'INVALID_PARAMS',
        `Line ${lineNo}: ${field} must be non-negative with at most 2 decimals`,
      );
    }
  }
  if (
    !hasNumericScale(line['line_total'], 2) ||
    (line['line_total'] as number) < 0 ||
    (line['line_total'] as number) > MAX_NUMERIC_14_2
  ) {
    reject(
      'INVALID_PARAMS',
      `Line ${lineNo}: line_total is required and must be non-negative with at most 2 decimals`,
    );
  }

  // GST composition: CGST/SGST (intra-state) and IGST (inter-state) are mutually exclusive heads.
  const cgstPaise = paiseFromNumber((line['cgst_amount'] as number | null | undefined) ?? 0);
  const sgstPaise = paiseFromNumber((line['sgst_amount'] as number | null | undefined) ?? 0);
  const igstPaise = paiseFromNumber((line['igst_amount'] as number | null | undefined) ?? 0);
  const cessPaise = paiseFromNumber((line['cess_amount'] as number | null | undefined) ?? 0);
  if (igstPaise > 0 && (cgstPaise > 0 || sgstPaise > 0)) {
    reject('INVALID_PARAMS', `Line ${lineNo}: a line cannot carry IGST together with CGST or SGST`);
  }

  // Line arithmetic (AC6): taxable_value plus all tax heads must equal line_total exactly at
  // paise scale - integer arithmetic on shape-validated 2-decimal values, never float sums.
  const taxablePaise = paiseFromNumber(line['taxable_value'] as number);
  const totalPaise = paiseFromNumber(line['line_total'] as number);
  if (taxablePaise + cgstPaise + sgstPaise + igstPaise + cessPaise !== totalPaise) {
    reject(
      'INVOICE_TOTAL_MISMATCH',
      `Line ${lineNo}: taxable_value plus GST amounts must equal line_total`,
      {
        line_no: lineNo,
        taxable_value: line['taxable_value'],
        cgst_amount: line['cgst_amount'] ?? 0,
        sgst_amount: line['sgst_amount'] ?? 0,
        igst_amount: line['igst_amount'] ?? 0,
        cess_amount: line['cess_amount'] ?? 0,
        line_total: line['line_total'],
      },
    );
  }
}

function assertLinesShape(lines: unknown, invoiceId: unknown): Record<string, unknown>[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    reject('INVOICE_LINE_REQUIRED', 'A supplier invoice requires at least one line item', {
      invoice_id: invoiceId,
    });
  }
  if (lines.length > MAX_INVOICE_LINES) {
    reject('INVALID_PARAMS', `A supplier invoice may carry at most ${MAX_INVOICE_LINES} lines`, {
      invoice_id: invoiceId,
      line_count: lines.length,
    });
  }
  let lineNo = 0;
  let sumTotalPaise = 0;
  for (const line of lines as Record<string, unknown>[]) {
    lineNo += 1;
    if (typeof line !== 'object' || line === null) {
      reject('INVALID_PARAMS', `Line ${lineNo}: must be an object`);
    }
    assertLineShape(line, lineNo);
    // Each line_total is individually bounded to NUMERIC(14,2); bound the running SUM too so the
    // header recompute cannot hit a PostgreSQL numeric overflow (22003) mid-transaction.
    sumTotalPaise += paiseFromNumber(line['line_total'] as number);
    if (sumTotalPaise > MAX_NUMERIC_14_2_PAISE) {
      reject('INVALID_PARAMS', 'The sum of line totals exceeds the supported invoice value range', {
        invoice_id: invoiceId,
      });
    }
  }
  return lines as Record<string, unknown>[];
}

function assertHeaderTotalShape(p: Record<string, unknown>): void {
  if (
    !hasNumericScale(p['total_value'], 2) ||
    (p['total_value'] as number) < 0 ||
    (p['total_value'] as number) > MAX_NUMERIC_14_2
  ) {
    reject(
      'INVALID_PARAMS',
      'total_value is required and must be non-negative with at most 2 decimals',
    );
  }
  for (const field of [
    'subtotal',
    'cgst_total',
    'sgst_total',
    'igst_total',
    'cess_total',
  ] as const) {
    const value = p[field];
    if (value === undefined || value === null) continue;
    if (
      !hasNumericScale(value, 2) ||
      (value as number) < 0 ||
      (value as number) > MAX_NUMERIC_14_2
    ) {
      reject('INVALID_PARAMS', `${field} must be non-negative with at most 2 decimals`);
    }
  }
}

/**
 * Field-format rules shared by manual capture, unmatched recording, and the reviewed-file
 * corrected header: currency vocabulary (INR only - FX is deferred by the Binding Scope
 * Decisions), recipient GSTIN grammar, IRN grammar, and text length bounds.
 */
function assertCommonInvoiceFieldShape(p: Record<string, unknown>): void {
  if ((p['invoice_number_ext'] as string).trim().length > MAX_INVOICE_NUMBER_LENGTH) {
    reject(
      'INVALID_PARAMS',
      `invoice_number_ext must be at most ${MAX_INVOICE_NUMBER_LENGTH} characters`,
    );
  }
  if (p['currency'] !== undefined && p['currency'] !== null) {
    if (typeof p['currency'] !== 'string' || !SUPPORTED_CURRENCIES.has(p['currency'])) {
      reject('INVALID_PARAMS', 'currency must be INR (foreign currency invoices are deferred)', {
        currency: p['currency'],
      });
    }
  }
  if (
    p['recipient_gstin_ext'] !== undefined &&
    p['recipient_gstin_ext'] !== null &&
    (typeof p['recipient_gstin_ext'] !== 'string' || !GSTIN_REGEX.test(p['recipient_gstin_ext']))
  ) {
    reject('INVALID_PARAMS', 'recipient_gstin_ext must be a valid 15-character GSTIN', {
      recipient_gstin_ext: p['recipient_gstin_ext'],
    });
  }
  if (
    p['irn_ext'] !== undefined &&
    p['irn_ext'] !== null &&
    (typeof p['irn_ext'] !== 'string' || !IRN_REGEX.test(p['irn_ext']))
  ) {
    reject('INVALID_PARAMS', 'irn_ext must be a 64-character hex e-invoice IRN', {
      irn_ext: p['irn_ext'],
    });
  }
  if (
    isNonEmptyString(p['duplicate_override_reason']) &&
    p['duplicate_override_reason'].trim().length > MAX_OVERRIDE_REASON_LENGTH
  ) {
    reject(
      'INVALID_PARAMS',
      `duplicate_override_reason must be at most ${MAX_OVERRIDE_REASON_LENGTH} characters`,
    );
  }
}

/**
 * Payload actor fields are documented "server-set from auth; never trusted from the client"
 * (src/events/schema.ts). The immutable event log must never record an actor that contradicts
 * the authenticated envelope actor, so any mismatch is rejected outright rather than corrected.
 */
function assertPayloadActorMatchesEnvelope(
  p: Record<string, unknown>,
  envelope: EventEnvelope,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const value = p[field];
    if (value === undefined || value === null) continue;
    if (value !== envelope.metadata.actor.user_id) {
      reject('INVALID_PARAMS', `${field} must match the authenticated actor`, {
        [field]: value,
        actor_user_id: envelope.metadata.actor.user_id,
      });
    }
  }
}

function assertInvoiceIngestionStagedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['ingestion_id']))
    reject('INVALID_PARAMS', 'ingestion_id is required and must be a UUID');
  if (typeof p['source_format'] !== 'string' || !SOURCE_FORMATS.has(p['source_format'])) {
    reject('INVOICE_SOURCE_FORMAT_UNSUPPORTED', 'source_format must be pdf, csv, or xml');
  }
  if (
    !isNonEmptyString(p['attachment_ref']) ||
    p['attachment_ref'].trim().length > MAX_ATTACHMENT_REF_LENGTH
  ) {
    reject(
      'INVALID_PARAMS',
      `attachment_ref is required and must be a non-empty string of at most ${MAX_ATTACHMENT_REF_LENGTH} characters`,
    );
  }
  if (typeof p['sha256_hash'] !== 'string' || !SHA256_REGEX.test(p['sha256_hash'])) {
    reject('INVOICE_PROVENANCE_INVALID', 'sha256_hash must be a 64-character hex SHA-256 digest');
  }
  if (
    !isNonEmptyString(p['detected_mime']) ||
    p['detected_mime'].trim().length > MAX_DETECTED_MIME_LENGTH
  ) {
    reject(
      'INVALID_PARAMS',
      `detected_mime is required and must be a non-empty string of at most ${MAX_DETECTED_MIME_LENGTH} characters`,
    );
  }
  if (
    !Number.isInteger(p['byte_size']) ||
    (p['byte_size'] as number) <= 0 ||
    (p['byte_size'] as number) > Number.MAX_SAFE_INTEGER
  ) {
    reject(
      'INVALID_PARAMS',
      'byte_size is required and must be a positive integer within the safe integer range',
    );
  }
  if (
    typeof p['extracted_draft'] !== 'object' ||
    p['extracted_draft'] === null ||
    Array.isArray(p['extracted_draft'])
  ) {
    reject('INVOICE_PROVENANCE_INVALID', 'extracted_draft is required and must be a JSON object');
  }
}

function assertInvoiceIngestionReviewedShape(
  p: Record<string, unknown>,
  envelope: EventEnvelope,
): void {
  if (!isUuid(p['ingestion_id']))
    reject('INVALID_PARAMS', 'ingestion_id is required and must be a UUID');
  const header = p['corrected_header'];
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    reject('INVALID_PARAMS', 'corrected_header is required and must be a JSON object');
  }
  const h = header as Record<string, unknown>;
  if (!isUuid(h['supplier_id']))
    reject('INVALID_PARAMS', 'corrected_header.supplier_id is required and must be a UUID');
  if (!isNonEmptyString(h['invoice_number_ext'])) {
    reject(
      'INVALID_PARAMS',
      'corrected_header.invoice_number_ext is required and must be a non-empty string',
    );
  }
  if (!isDateString(h['invoice_date'])) {
    reject(
      'INVALID_PARAMS',
      'corrected_header.invoice_date is required and must be a valid YYYY-MM-DD calendar date',
    );
  }
  if (h['po_id'] !== undefined && h['po_id'] !== null && !isUuid(h['po_id'])) {
    reject('INVALID_PARAMS', 'corrected_header.po_id must be a UUID when supplied');
  }
  assertHeaderTotalShape(h);
  assertCommonInvoiceFieldShape(h);
  assertInvoiceDatePlausible(h['invoice_date'] as string, envelope.metadata.occurred_at);
  assertPayloadActorMatchesEnvelope(p, envelope, ['reviewed_by']);
  if (
    h['duplicate_override_reason'] !== undefined &&
    h['duplicate_override_reason'] !== null &&
    !isNonEmptyString(h['duplicate_override_reason'])
  ) {
    reject(
      'INVOICE_DUPLICATE_OVERRIDE_REASON_REQUIRED',
      'duplicate_override_reason must be a non-empty string when supplied',
    );
  }
  assertLinesShape(p['corrected_lines'], p['ingestion_id']);
}

function assertSupplierInvoiceCapturedShape(
  p: Record<string, unknown>,
  envelope: EventEnvelope,
): void {
  if (!isUuid(p['invoice_id']))
    reject('INVALID_PARAMS', 'invoice_id is required and must be a UUID');
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!isUuid(p['po_id']))
    reject('INVALID_PARAMS', 'po_id is required and must be a UUID for a captured invoice');
  if (!isNonEmptyString(p['invoice_number_ext'])) {
    reject('INVALID_PARAMS', 'invoice_number_ext is required and must be a non-empty string');
  }
  if (!isDateString(p['invoice_date'])) {
    reject(
      'INVALID_PARAMS',
      'invoice_date is required and must be a valid YYYY-MM-DD calendar date',
    );
  }
  const method = p['capture_method'];
  if (method !== 'manual' && method !== 'file') {
    reject('INVALID_PARAMS', 'capture_method is required and must be manual or file');
  }
  if (method === 'file' && !isUuid(p['ingestion_id'])) {
    reject(
      'INVALID_PARAMS',
      'ingestion_id is required and must be a UUID when capture_method is file',
    );
  }
  if (
    p['duplicate_override_reason'] !== undefined &&
    p['duplicate_override_reason'] !== null &&
    !isNonEmptyString(p['duplicate_override_reason'])
  ) {
    reject(
      'INVOICE_DUPLICATE_OVERRIDE_REASON_REQUIRED',
      'duplicate_override_reason must be a non-empty string when supplied',
    );
  }
  assertHeaderTotalShape(p);
  assertCommonInvoiceFieldShape(p);
  assertInvoiceDatePlausible(p['invoice_date'] as string, envelope.metadata.occurred_at);
  assertPayloadActorMatchesEnvelope(p, envelope, ['captured_by', 'uploaded_by']);
  assertLinesShape(p['lines'], p['invoice_id']);
}

function assertSupplierInvoiceUnmatchedRecordedShape(
  p: Record<string, unknown>,
  envelope: EventEnvelope,
): void {
  if (!isUuid(p['invoice_id']))
    reject('INVALID_PARAMS', 'invoice_id is required and must be a UUID');
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (p['po_id'] !== undefined && p['po_id'] !== null) {
    reject('INVALID_PARAMS', 'An unmatched invoice must not reference a purchase order');
  }
  if (!isNonEmptyString(p['invoice_number_ext'])) {
    reject('INVALID_PARAMS', 'invoice_number_ext is required and must be a non-empty string');
  }
  if (!isDateString(p['invoice_date'])) {
    reject(
      'INVALID_PARAMS',
      'invoice_date is required and must be a valid YYYY-MM-DD calendar date',
    );
  }
  const method = p['capture_method'];
  if (method !== 'file') {
    // AC1 scopes manual capture to a native PO; an unmatched invoice arises only from confirmed
    // file ingestion in this story, so a "manual unmatched" combination is rejected in the seam
    // (no HTTP route offers it - only a crafted direct event could).
    reject(
      'INVALID_PARAMS',
      'capture_method must be file: an unmatched invoice arises only from reviewed file ingestion',
    );
  }
  if (!isUuid(p['ingestion_id'])) {
    reject(
      'INVALID_PARAMS',
      'ingestion_id is required and must be a UUID when capture_method is file',
    );
  }
  if (
    p['duplicate_override_reason'] !== undefined &&
    p['duplicate_override_reason'] !== null &&
    !isNonEmptyString(p['duplicate_override_reason'])
  ) {
    reject(
      'INVOICE_DUPLICATE_OVERRIDE_REASON_REQUIRED',
      'duplicate_override_reason must be a non-empty string when supplied',
    );
  }
  assertHeaderTotalShape(p);
  assertCommonInvoiceFieldShape(p);
  assertInvoiceDatePlausible(p['invoice_date'] as string, envelope.metadata.occurred_at);
  assertPayloadActorMatchesEnvelope(p, envelope, ['captured_by', 'uploaded_by']);
  assertLinesShape(p['lines'], p['invoice_id']);
}

function assertSupplierInvoicePoLinkedShape(
  p: Record<string, unknown>,
  envelope: EventEnvelope,
): void {
  if (!isUuid(p['invoice_id']))
    reject('INVALID_PARAMS', 'invoice_id is required and must be a UUID');
  if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
  assertPayloadActorMatchesEnvelope(p, envelope, ['linked_by']);
}

export function assertSupplierInvoiceShape(envelope: EventEnvelope): void {
  const type = supplierInvoiceEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'invoice_ingestion.staged':
      assertInvoiceIngestionStagedShape(p);
      assertPayloadActorMatchesEnvelope(p, envelope, ['uploaded_by']);
      break;
    case 'invoice_ingestion.reviewed':
      assertInvoiceIngestionReviewedShape(p, envelope);
      break;
    case 'supplier_invoice.captured':
      assertSupplierInvoiceCapturedShape(p, envelope);
      break;
    case 'supplier_invoice.unmatched_recorded':
      assertSupplierInvoiceUnmatchedRecordedShape(p, envelope);
      break;
    case 'supplier_invoice.po_linked':
      assertSupplierInvoicePoLinkedShape(p, envelope);
      break;
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

async function loadActiveSupplierOrReject(
  supplierId: string,
  client: PoolClient,
): Promise<{ supplier_id: string; gstin_ext: string | null; status: string }> {
  const supplier = await getSupplierById(supplierId, client);
  if (!supplier)
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId }, 404);
  if (supplier.status !== 'active') {
    reject(
      'SUPPLIER_NOT_ACTIVE',
      'Supplier must be active to capture an invoice',
      {
        supplier_id: supplierId,
        status: supplier.status,
      },
      409,
    );
  }
  return supplier;
}

async function loadIssuedOrConfirmedPoOrReject(
  poId: string,
  client: PoolClient,
): Promise<PurchaseOrderRow> {
  const po = await getPurchaseOrderById(poId, client, true);
  if (!po) reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  if (po.status !== 'issued' && po.status !== 'confirmed') {
    reject(
      'PO_NOT_ISSUED',
      'Only an issued or confirmed purchase order can back an invoice',
      {
        po_id: poId,
        status: po.status,
      },
      409,
    );
  }
  return po;
}

/**
 * Task 3.5: on capture against a PO, EVERY line must anchor to a line of that PO (`requireAll`),
 * so no unanchored SKUs or amounts ride on a PO-backed invoice. At link time (AC4) the invoice
 * lines pre-exist from file review and may legitimately carry no po_line_id, so only lines that
 * do reference one are checked for membership and SKU agreement. SKUs compare trimmed, matching
 * what buildLineRows stores.
 */
function assertLinesBelongToPo(
  lines: Record<string, unknown>[],
  poLines: PurchaseOrderLineRow[],
  requireAll: boolean,
): void {
  const byLineId = new Map(poLines.map((l) => [l.po_line_id, l]));
  for (const line of lines) {
    const poLineId = line['po_line_id'] as string | undefined;
    if (poLineId === undefined || poLineId === null) {
      if (!requireAll) continue;
      reject(
        'INVOICE_PO_LINE_MISMATCH',
        'Every line of a PO-backed invoice must reference a po_line_id on that purchase order',
        { sku: line['sku'] },
        409,
      );
    }
    const poLine = byLineId.get(poLineId);
    if (!poLine || poLine.sku.trim() !== (line['sku'] as string).trim()) {
      reject(
        'INVOICE_PO_LINE_MISMATCH',
        'Invoice line does not match a line on the linked purchase order',
        {
          po_line_id: poLineId,
          sku: line['sku'],
        },
        409,
      );
    }
  }
}

function buildLineRows(
  lines: Record<string, unknown>[],
  invoiceId: string,
): Parameters<typeof insertSupplierInvoiceLine>[0][] {
  return lines.map((line, index) => ({
    invoice_line_id: randomUUID(),
    invoice_id: invoiceId,
    line_no: index + 1,
    po_line_id: (line['po_line_id'] as string | undefined) ?? null,
    sku: (line['sku'] as string).trim(),
    quantity: line['quantity'] as number,
    uom: (line['uom'] as string).trim(),
    unit_price: line['unit_price'] as number,
    taxable_value: line['taxable_value'] as number,
    cgst_amount: (line['cgst_amount'] as number) ?? 0,
    sgst_amount: (line['sgst_amount'] as number) ?? 0,
    igst_amount: (line['igst_amount'] as number) ?? 0,
    cess_amount: (line['cess_amount'] as number) ?? 0,
    line_total: line['line_total'] as number,
  }));
}

/** Authoritative paise-scale comparison: DB NUMERIC string vs submitted number, no float sums. */
function moneyEqual(dbValue: string, submitted: number): boolean {
  return paiseFromDbString(dbValue) === paiseFromNumber(submitted);
}

/**
 * Inserts the lines, recomputes all header totals in SQL, then verifies the submitted
 * total_value AND every submitted GST head against the SQL sums (AC1: the GST breakup is a
 * validated match-ready field, not a silently-overwritten hint - the immutable event and the
 * projection must never disagree).
 */
async function insertLinesAndVerifyTotals(
  invoiceId: string,
  lineRows: ReturnType<typeof buildLineRows>,
  p: Record<string, unknown>,
  client: PoolClient,
): Promise<void> {
  for (const row of lineRows) {
    await insertSupplierInvoiceLine(row, client);
  }
  const totals = await recomputeSupplierInvoiceTotals(invoiceId, client);
  if (!moneyEqual(totals.total_value, p['total_value'] as number)) {
    reject(
      'INVOICE_TOTAL_MISMATCH',
      'Submitted total_value does not match the sum of line totals',
      {
        invoice_id: invoiceId,
        submitted_total_value: p['total_value'],
        computed_total_value: totals.total_value,
      },
    );
  }
  for (const field of [
    'subtotal',
    'cgst_total',
    'sgst_total',
    'igst_total',
    'cess_total',
  ] as const) {
    const submitted = p[field];
    if (submitted === undefined || submitted === null) continue;
    if (!moneyEqual(totals[field], submitted as number)) {
      reject(
        'INVOICE_TOTAL_MISMATCH',
        `Submitted ${field} does not match the sum of the corresponding line amounts`,
        {
          invoice_id: invoiceId,
          field,
          submitted: submitted,
          computed: totals[field],
        },
      );
    }
  }
}

/**
 * AC3/AC6: a duplicate override is a distinct RBAC capability, enforced INSIDE the seam so
 * neither the file-review confirm path nor a direct POST /api/v1/events can self-authorize one
 * by merely including a reason. The check is capability-based (module scope), never a role name
 * (Binding Scope Decisions), and runs on the transaction client so it sees governed assignments.
 */
async function assertOverrideAuthorized(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM user_role_assignments
     WHERE user_id = $1
       AND (module = 'procurement.duplicate-override' OR module = '*')
       AND function_scope = 'write'
     LIMIT 1`,
    [envelope.metadata.actor.user_id],
  );
  if (result.rows.length === 0) {
    reject(
      'FUNCTION_ACCESS_DENIED',
      'duplicate_override_reason requires the procurement.duplicate-override write capability',
      { actor_user_id: envelope.metadata.actor.user_id },
      403,
    );
  }
}

/**
 * Duplicate lookup shared by the manual and reviewed-file capture paths (Task 3.6 / AC3). Throws
 * DUPLICATE_EVENT with the full existing-invoice detail on the ordinary path; returns the
 * server-derived duplicate_of_invoice_id when a non-empty override reason authorizes the write.
 */
async function resolveDuplicateOrThrow(
  supplierGstinExt: string,
  invoiceNumberNormalized: string,
  financialYearStart: number,
  overrideReason: string | undefined,
  client: PoolClient,
): Promise<string | null> {
  const existing = await getSupplierInvoiceByDuplicateGrain(
    supplierGstinExt,
    invoiceNumberNormalized,
    financialYearStart,
    client,
    true,
  );
  if (!existing) {
    if (overrideReason) {
      // Review decision (2026-08-06): an evidenced override with nothing to override is rejected
      // outright rather than silently downgraded to an ordinary capture that drops the reason.
      reject(
        'INVOICE_NO_DUPLICATE_TO_OVERRIDE',
        'No existing invoice matches this duplicate grain; use the ordinary capture endpoint',
        {
          supplier_gstin_ext: supplierGstinExt,
          invoice_number_normalized: invoiceNumberNormalized,
          financial_year_start: financialYearStart,
        },
        409,
      );
    }
    return null;
  }
  if (!overrideReason) {
    reject(
      'DUPLICATE_EVENT',
      'An invoice with this supplier GSTIN, invoice number, and financial year already exists',
      {
        existing_invoice_id: existing.invoice_id,
        invoice_number_ext: existing.invoice_number_ext,
        status: existing.status,
        supplier_id: existing.supplier_id,
        financial_year_start: existing.financial_year_start,
      },
      409,
    );
  }
  return existing.invoice_id;
}

async function applyInvoiceIngestionStaged(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  await insertSupplierInvoiceIngestion(
    {
      ingestion_id: p['ingestion_id'] as string,
      source_format: p['source_format'] as 'pdf' | 'csv' | 'xml',
      attachment_ref: (p['attachment_ref'] as string).trim(),
      sha256_hash: (p['sha256_hash'] as string).toLowerCase(),
      detected_mime: (p['detected_mime'] as string).trim(),
      byte_size: p['byte_size'] as number,
      extracted_draft: p['extracted_draft'],
      uploaded_by: envelope.metadata.actor.user_id,
      uploaded_at: envelope.metadata.occurred_at,
      correlation_id: envelope.metadata.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );
}

async function applyInvoiceIngestionReviewed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const ingestionId = p['ingestion_id'] as string;

  const ingestion = await getSupplierInvoiceIngestionById(ingestionId, client, true);
  if (!ingestion) {
    reject(
      'INVOICE_PROVENANCE_INVALID',
      'Referenced ingestion not found',
      { ingestion_id: ingestionId },
      404,
    );
  }
  if (ingestion.review_status !== 'review-required') {
    reject(
      'INVOICE_ALREADY_REVIEWED',
      'This ingestion has already been reviewed',
      {
        ingestion_id: ingestionId,
        review_status: ingestion.review_status,
      },
      409,
    );
  }

  const header = p['corrected_header'] as Record<string, unknown>;
  const lines = p['corrected_lines'] as Record<string, unknown>[];
  const now = envelope.metadata.occurred_at;
  const invoiceId = randomUUID();
  const correlationId = envelope.metadata.correlation_id ?? randomUUID();
  const poId = header['po_id'] as string | undefined;

  let businessStream: string | undefined;
  if (poId) {
    const po = await loadIssuedOrConfirmedPoOrReject(poId, client);
    businessStream = po.business_stream;
  }

  const nestedPayload: Record<string, unknown> = {
    invoice_id: invoiceId,
    supplier_id: header['supplier_id'],
    invoice_number_ext: header['invoice_number_ext'],
    invoice_date: header['invoice_date'],
    currency: header['currency'],
    recipient_gstin_ext: header['recipient_gstin_ext'],
    irn_ext: header['irn_ext'],
    lines,
    subtotal: header['subtotal'],
    cgst_total: header['cgst_total'],
    sgst_total: header['sgst_total'],
    igst_total: header['igst_total'],
    cess_total: header['cess_total'],
    total_value: header['total_value'],
    capture_method: 'file',
    ingestion_id: ingestionId,
    duplicate_override_reason: header['duplicate_override_reason'],
    captured_by: envelope.metadata.actor.user_id,
  };

  if (poId) {
    nestedPayload['po_id'] = poId;
    nestedPayload['business_stream'] = businessStream;
  }

  // The ingestion row is marked reviewed BEFORE the nested capture event persists so the seam's
  // review-state gate (insertCapturedOrUnmatchedInvoice) can require review_status = 'reviewed'
  // and a matching resulting_invoice_id for EVERY file-captured invoice - including this one.
  // Both statements share the transaction client, so they still commit or roll back together.
  await markSupplierInvoiceIngestionReviewed(
    ingestionId,
    envelope.metadata.actor.user_id,
    now,
    p['correction_summary'],
    invoiceId,
    client,
  );

  await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: invoiceId,
      event_type: poId ? 'supplier_invoice.captured' : 'supplier_invoice.unmatched_recorded',
      event_id: randomUUID(),
      payload: nestedPayload,
      metadata: {
        correlation_id: correlationId,
        causation_id: eventId,
        actor: envelope.metadata.actor,
        occurred_at: now,
      },
    },
    undefined,
    client,
  );
}

/**
 * Shared header-plus-lines insert for both supplier_invoice.captured (PO-backed) and
 * supplier_invoice.unmatched_recorded (no PO). `poContext` is null for the unmatched path.
 */
async function insertCapturedOrUnmatchedInvoice(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  status: 'captured' | 'unmatched',
  poContext: { po: PurchaseOrderRow; poLines: PurchaseOrderLineRow[] } | null,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const invoiceId = p['invoice_id'] as string;

  const existingById = await getSupplierInvoiceById(invoiceId, client, true);
  if (existingById) {
    reject(
      'DUPLICATE_EVENT',
      'A supplier invoice with this invoice_id already exists',
      {
        invoice_id: invoiceId,
        existing_status: existingById.status,
      },
      409,
    );
  }

  const supplier = await loadActiveSupplierOrReject(p['supplier_id'] as string, client);
  if (!isNonEmptyString(supplier.gstin_ext)) {
    reject(
      'INVALID_PARAMS',
      'Supplier has no governed GSTIN on record',
      {
        supplier_id: supplier.supplier_id,
      },
      409,
    );
  }
  const supplierGstinExt = supplier.gstin_ext as string;

  if (poContext && poContext.po.supplier_id !== supplier.supplier_id) {
    reject(
      'INVOICE_PO_SUPPLIER_MISMATCH',
      'The invoice supplier does not match the purchase order supplier',
      {
        supplier_id: supplier.supplier_id,
        po_supplier_id: poContext.po.supplier_id,
      },
      409,
    );
  }

  // AC2/AC6: a file-captured invoice is only legal when its ingestion exists, has been reviewed,
  // and was reviewed into THIS invoice. Enforced here - not only in the HTTP flow - so a direct
  // POST /api/v1/events cannot post an invoice against a nonexistent or still-pending ingestion.
  if (p['capture_method'] === 'file') {
    const ingestion = await getSupplierInvoiceIngestionById(
      p['ingestion_id'] as string,
      client,
      true,
    );
    if (!ingestion) {
      reject(
        'INVOICE_PROVENANCE_INVALID',
        'Referenced ingestion not found',
        { ingestion_id: p['ingestion_id'] },
        404,
      );
    }
    if (ingestion.review_status !== 'reviewed' || ingestion.resulting_invoice_id !== invoiceId) {
      reject(
        'INVOICE_PROVENANCE_INVALID',
        'A file-captured invoice requires a reviewed ingestion that resolved to this invoice',
        {
          ingestion_id: p['ingestion_id'],
          review_status: ingestion.review_status,
          resulting_invoice_id: ingestion.resulting_invoice_id,
        },
        409,
      );
    }
  }

  const lines = assertLinesShape(p['lines'], invoiceId);
  if (poContext) {
    // Manual capture must anchor every line to the PO (Task 3.5); a reviewed file capture may
    // carry extraction lines with no po_line_id, mirroring the link-time contract.
    assertLinesBelongToPo(lines, poContext.poLines, p['capture_method'] === 'manual');
  }

  const invoiceNumberExt = normalizeInvoiceNumberExt(p['invoice_number_ext'] as string);
  const invoiceNumberNormalized = normalizeInvoiceNumber(invoiceNumberExt);
  const invoiceDate = p['invoice_date'] as string;
  const financialYearStart = computeFinancialYearStart(invoiceDate);
  const overrideReason = isNonEmptyString(p['duplicate_override_reason'])
    ? (p['duplicate_override_reason'] as string).trim()
    : undefined;

  if (overrideReason) await assertOverrideAuthorized(envelope, client);

  const duplicateOfInvoiceId = await resolveDuplicateOrThrow(
    supplierGstinExt,
    invoiceNumberNormalized,
    financialYearStart,
    overrideReason,
    client,
  );

  const now = envelope.metadata.occurred_at;
  const capturedBy = envelope.metadata.actor.user_id;

  // Story 4.6 AC3a: immutable capture-time MSME snapshot, anchored on invoice_date (calendar-date
  // arithmetic, never elapsed milliseconds), via the single accessor and dated rule contract. A
  // suspended-pending-reverification supplier still stamps (conservative treatment, AC7);
  // non-MSME suppliers keep all three fields null.
  const msmeCtx = await getSupplierMsmeContext(supplier.supplier_id, client);
  const msmeStamp =
    msmeCtx &&
    msmeCtx.msme_classification !== null &&
    (msmeCtx.msme_status === 'active' || msmeCtx.msme_status === 'suspended-pending-reverification')
      ? {
          msme_classification_at_capture: msmeCtx.msme_classification,
          statutory_due_date: computeStatutoryDueDate(invoiceDate, msmeCtx.credit_period_days),
          statutory_due_rule_version: msmeCtx.rule_version,
        }
      : {
          msme_classification_at_capture: null,
          statutory_due_date: null,
          statutory_due_rule_version: null,
        };

  // No 23505 catch here: the serial invoice_id collision is already rejected by the
  // getSupplierInvoiceById pre-check above, and a concurrent supplier_invoice_pkey race must
  // propagate to src/events/store.ts's constraint mapping. Swallowing it would return from an
  // ABORTED transaction and turn every later statement into a 25P02 failure.
  await insertSupplierInvoice(
    {
      invoice_id: invoiceId,
      supplier_id: supplier.supplier_id,
      supplier_gstin_ext: supplierGstinExt,
      invoice_number_ext: invoiceNumberExt,
      invoice_number_normalized: invoiceNumberNormalized,
      invoice_date: invoiceDate,
      financial_year_start: financialYearStart,
      po_id: poContext ? poContext.po.po_id : null,
      site_id: poContext ? poContext.po.site_id : null,
      business_stream: poContext ? poContext.po.business_stream : null,
      status,
      currency: typeof p['currency'] === 'string' ? (p['currency'] as string) : 'INR',
      recipient_gstin_ext: (p['recipient_gstin_ext'] as string | undefined) ?? null,
      irn_ext: (p['irn_ext'] as string | undefined) ?? null,
      subtotal: p['subtotal'] !== undefined ? String(p['subtotal']) : null,
      cgst_total: p['cgst_total'] !== undefined ? String(p['cgst_total']) : null,
      sgst_total: p['sgst_total'] !== undefined ? String(p['sgst_total']) : null,
      igst_total: p['igst_total'] !== undefined ? String(p['igst_total']) : null,
      cess_total: p['cess_total'] !== undefined ? String(p['cess_total']) : null,
      total_value: String(p['total_value'] as number),
      msme_classification_at_capture: msmeStamp.msme_classification_at_capture,
      statutory_due_date: msmeStamp.statutory_due_date,
      statutory_due_rule_version: msmeStamp.statutory_due_rule_version,
      duplicate_of_invoice_id: duplicateOfInvoiceId,
      duplicate_override_reason: duplicateOfInvoiceId ? (overrideReason as string) : null,
      capture_method: p['capture_method'] as 'manual' | 'file',
      ingestion_id: (p['ingestion_id'] as string | undefined) ?? null,
      captured_by: capturedBy,
      captured_at: now,
      correlation_id: envelope.metadata.correlation_id ?? null,
      source_event_id: eventId,
    },
    client,
  );

  const lineRows = buildLineRows(lines, invoiceId);
  await insertLinesAndVerifyTotals(invoiceId, lineRows, p, client);
}

async function applySupplierInvoiceCaptured(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const po = await loadIssuedOrConfirmedPoOrReject(p['po_id'] as string, client);
  const poLines = await getPurchaseOrderLines(po.po_id, client);

  if (envelope.payload['business_stream'] !== po.business_stream) {
    reject(
      'BUSINESS_STREAM_MISMATCH',
      'business_stream does not match the linked purchase order',
      {
        po_id: po.po_id,
        po_business_stream: po.business_stream,
        payload_business_stream: envelope.payload['business_stream'],
      },
      409,
    );
  }

  await insertCapturedOrUnmatchedInvoice(envelope, client, eventId, 'captured', { po, poLines });
}

async function applySupplierInvoiceUnmatchedRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  await insertCapturedOrUnmatchedInvoice(envelope, client, eventId, 'unmatched', null);
}

async function applySupplierInvoicePoLinked(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const invoiceId = p['invoice_id'] as string;
  const poId = p['po_id'] as string;

  const invoice = await getSupplierInvoiceById(invoiceId, client, true);
  if (!invoice)
    reject(
      'SUPPLIER_INVOICE_NOT_FOUND',
      'Supplier invoice not found',
      { invoice_id: invoiceId },
      404,
    );
  if (invoice.status !== 'unmatched') {
    reject(
      'INVOICE_NOT_UNMATCHED',
      'Only an unmatched invoice can be linked to a purchase order',
      {
        invoice_id: invoiceId,
        status: invoice.status,
      },
      409,
    );
  }

  const po = await loadIssuedOrConfirmedPoOrReject(poId, client);
  if (po.supplier_id !== invoice.supplier_id) {
    reject(
      'INVOICE_PO_SUPPLIER_MISMATCH',
      'The invoice supplier does not match the purchase order supplier',
      {
        supplier_id: invoice.supplier_id,
        po_supplier_id: po.supplier_id,
      },
      409,
    );
  }
  if (envelope.payload['business_stream'] !== po.business_stream) {
    reject(
      'BUSINESS_STREAM_MISMATCH',
      'business_stream does not match the linked purchase order',
      {
        po_id: po.po_id,
        po_business_stream: po.business_stream,
        payload_business_stream: envelope.payload['business_stream'],
      },
      409,
    );
  }

  const poLines = await getPurchaseOrderLines(po.po_id, client);
  const invoiceLinesResult = await client.query(
    `SELECT po_line_id, sku FROM supplier_invoice_line WHERE invoice_id = $1`,
    [invoiceId],
  );
  assertLinesBelongToPo(invoiceLinesResult.rows as Record<string, unknown>[], poLines, false);

  // Story 4.6 AC3a (amended by review decision 2): the MSME snapshot is immutable after capture.
  // The po_link path no longer re-stamps msme_classification_at_capture / statutory_due_date /
  // statutory_due_rule_version; a supplier that gains MSME status between capture and link keeps
  // the capture-time nulls. The three MSME fields are absent from updateSupplierInvoicePoLink.
  await updateSupplierInvoicePoLink(invoiceId, po.po_id, po.site_id, po.business_stream, client);
}

export async function applySupplierInvoiceProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = supplierInvoiceEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'invoice_ingestion.staged':
      await applyInvoiceIngestionStaged(envelope, client, eventId);
      break;
    case 'invoice_ingestion.reviewed':
      await applyInvoiceIngestionReviewed(envelope, client, eventId);
      break;
    case 'supplier_invoice.captured':
      await applySupplierInvoiceCaptured(envelope, client, eventId);
      break;
    case 'supplier_invoice.unmatched_recorded':
      await applySupplierInvoiceUnmatchedRecorded(envelope, client, eventId);
      break;
    case 'supplier_invoice.po_linked':
      await applySupplierInvoicePoLinked(envelope, client);
      break;
  }
}

/**
 * Task 3.6 concurrency fallback: when the partial unique index uq_supplier_invoice_duplicate_grain
 * rejects a concurrent second writer, the caller (src/events/store.ts) has already rolled back its
 * transaction, so this runs a fresh, safe query against supplier_invoice directly (not the generic
 * domain_events lookup) and returns the SAME detail shape as the seam's own pre-check.
 */
export async function resolveSupplierInvoiceDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // When the outer envelope is invoice_ingestion.reviewed, the invoice fields live in
  // corrected_header, not at the payload top level - fall through to it so the 409 detail is
  // never an empty object for the file-review path.
  const header =
    typeof payload['corrected_header'] === 'object' && payload['corrected_header'] !== null
      ? (payload['corrected_header'] as Record<string, unknown>)
      : payload;
  const supplierId = header['supplier_id'] ?? payload['supplier_id'];
  const invoiceNumberExt = header['invoice_number_ext'] ?? payload['invoice_number_ext'];
  const invoiceDate = header['invoice_date'] ?? payload['invoice_date'];
  if (
    typeof supplierId !== 'string' ||
    typeof invoiceNumberExt !== 'string' ||
    typeof invoiceDate !== 'string'
  ) {
    return null;
  }
  const invoiceNumberNormalized = normalizeInvoiceNumber(invoiceNumberExt);
  let financialYearStart: number;
  try {
    financialYearStart = computeFinancialYearStart(invoiceDate);
  } catch {
    return null;
  }
  // The attempted grain is always reportable, even when the concurrent winner has not committed
  // yet and the fresh lookup below cannot see its row - a 409 with an empty detail object would
  // leave the loser unable to identify what it collided with.
  const attemptedGrain: Record<string, unknown> = {
    supplier_id: supplierId,
    invoice_number_ext: invoiceNumberExt,
    invoice_number_normalized: invoiceNumberNormalized,
    financial_year_start: financialYearStart,
  };
  const supplier = await getSupplierById(supplierId);
  if (!supplier || !supplier.gstin_ext) return attemptedGrain;
  const existing = await getSupplierInvoiceByDuplicateGrain(
    supplier.gstin_ext,
    invoiceNumberNormalized,
    financialYearStart,
  );
  if (!existing) return attemptedGrain;
  return {
    existing_invoice_id: existing.invoice_id,
    invoice_number_ext: existing.invoice_number_ext,
    status: existing.status,
    supplier_id: existing.supplier_id,
    financial_year_start: existing.financial_year_start,
  };
}

export type { SupplierInvoiceRow, SupplierInvoiceLineInput };

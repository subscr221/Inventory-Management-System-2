import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { getGrnByIdForUpdate, linkGrnToPurchaseOrder } from '../read/projections/grn.js';
import { getPurchaseOrderById } from '../read/projections/purchase_order.js';
import {
  getSupplierInvoiceById,
  updateSupplierInvoiceMatchStatus,
} from '../read/projections/supplier_invoice.js';
import {
  computeMatchVariance,
  getMatchById,
  getLatestMatchByInvoiceId,
  insertThreeWayMatch,
  liftThreeWayMatch,
  listClearanceEligibleInvoices,
} from '../read/projections/three_way_match.js';
import {
  buildPaymentClearanceFeedPayload,
  insertPaymentClearanceFeed,
} from '../adapters/erp/payment-clearance-feed.js';

/**
 * Three-way match compliance module (Story 4.5, FR-P-06 / FR-P-07 / FR-AC-13).
 *
 * Owns the procurement and financial side of goods receipt: binding a GRN to a native Story 4.4
 * purchase order, running the PO/receipt/invoice comparison, blocking payment clearance when the
 * comparison falls outside the configured tolerances, and lifting that block through a credit or
 * debit note. Physical receiving capture stays entirely with Story 3.4 - this module consumes its
 * events and never re-implements them.
 *
 * Authorization-relevant invariants live HERE, not in the route handlers: a direct
 * POST /api/v1/events must hit exactly the same guards (the Story 4.7 review lesson).
 *
 * The match RESULT is server-computed, never client-asserted. The applier recomputes the
 * comparison inside the persistEvent transaction and writes its own findings back onto
 * envelope.payload before the domain_events insert, so a spoofed "passed" payload is physically
 * incapable of reaching the event log.
 */

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
export const THREE_WAY_MATCH_EVENT_TYPES = new Set([
  'grn.po_linked',
  'three_way_match.recorded',
  'supplier_invoice.credit_note_recorded',
  'supplier_invoice.debit_note_recorded',
  'payment_clearance_feed.recorded',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Positive money with at most two decimal places - the scale supplier_invoice totals carry. */
const AMOUNT_REGEX = /^\d{1,12}(\.\d{1,2})?$/;
/** A PO must be live for a receipt or a match to bind to it. */
const BINDABLE_PO_STATUSES = new Set(['issued', 'confirmed']);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}

export function threeWayMatchEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!THREE_WAY_MATCH_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access, consumes no idempotency key)
// ---------------------------------------------------------------------------

export function assertThreeWayMatchShape(envelope: EventEnvelope): void {
  const type = threeWayMatchEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'grn.po_linked':
      if (!isUuid(p['grn_id'])) reject('INVALID_PARAMS', 'grn_id is required and must be a UUID');
      if (!isUuid(p['po_id'])) reject('INVALID_PARAMS', 'po_id is required and must be a UUID');
      assertActorField(envelope, p, 'linked_by');
      break;
    case 'three_way_match.recorded':
      if (!isUuid(p['match_id']))
        reject('INVALID_PARAMS', 'match_id is required and must be a UUID');
      if (!isUuid(p['invoice_id']))
        reject('INVALID_PARAMS', 'invoice_id is required and must be a UUID');
      assertActorField(envelope, p, 'run_by');
      break;
    case 'supplier_invoice.credit_note_recorded':
    case 'supplier_invoice.debit_note_recorded':
      if (!isUuid(p['note_id'])) reject('INVALID_PARAMS', 'note_id is required and must be a UUID');
      if (!isUuid(p['invoice_id']))
        reject('INVALID_PARAMS', 'invoice_id is required and must be a UUID');
      if (!isUuid(p['match_id']))
        reject('INVALID_PARAMS', 'match_id is required and must be a UUID');
      if (!isNonEmptyString(p['note_number_ext']))
        reject('INVALID_PARAMS', 'note_number_ext is required');
      if (
        typeof p['amount'] !== 'string' ||
        !AMOUNT_REGEX.test(p['amount']) ||
        Number(p['amount']) <= 0
      ) {
        reject(
          'INVALID_PARAMS',
          'amount must be a positive decimal string with at most two decimal places',
          { amount: p['amount'] },
        );
      }
      if (!isNonEmptyString(p['reason']))
        reject('INVALID_PARAMS', 'reason is required and must be non-empty');
      assertActorField(envelope, p, 'recorded_by');
      break;
    case 'payment_clearance_feed.recorded':
      if (!isUuid(p['feed_id'])) reject('INVALID_PARAMS', 'feed_id is required and must be a UUID');
      if (typeof p['generated_at'] !== 'string' || Number.isNaN(Date.parse(p['generated_at']))) {
        reject('INVALID_PARAMS', 'generated_at is required and must be an ISO timestamp');
      }
      break;
  }
}

/**
 * Story 4.7 lesson: a payload actor field that disagrees with the envelope actor is an attempt to
 * attribute a statutory action to someone else. Absent is fine - the applier stamps it from the
 * envelope - but present-and-different is rejected outright.
 */
function assertActorField(
  envelope: EventEnvelope,
  p: Record<string, unknown>,
  field: string,
): void {
  const claimed = p[field];
  if (claimed === undefined || claimed === null) return;
  if (claimed !== envelope.metadata.actor.user_id) {
    reject('INVALID_PARAMS', `${field} must match the authenticated actor`, { [field]: claimed });
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  // Plain SELECT - never FOR UPDATE on domain_events (the app_user grant set makes that a 42501).
  // Serialization comes from the FOR UPDATE taken on the entity row inside each applier.
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyThreeWayMatchProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = threeWayMatchEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'grn.po_linked':
      await applyGrnPoLinked(envelope, client);
      break;
    case 'three_way_match.recorded':
      await applyThreeWayMatchRecorded(envelope, client, eventId);
      break;
    case 'supplier_invoice.credit_note_recorded':
      await applyNoteRecorded(envelope, client, 'credit_note');
      break;
    case 'supplier_invoice.debit_note_recorded':
      await applyNoteRecorded(envelope, client, 'debit_note');
      break;
    case 'payment_clearance_feed.recorded':
      await applyPaymentClearanceFeedRecorded(envelope, client);
      break;
  }
}

async function applyGrnPoLinked(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const grnId = p['grn_id'] as string;
  const poId = p['po_id'] as string;

  const grn = await getGrnByIdForUpdate(grnId, client);
  if (!grn) reject('GRN_NOT_FOUND', 'GRN not found', { grn_id: grnId }, 404);

  // AC4 (procurement-side variant): a receipt can only be bound to a purchase order that exists
  // and is live. A draft, pending-approval, approved or rejected PO is not a source document.
  // FOR UPDATE serializes against any concurrent PO state change (Review 4.5 P5).
  const po = await getPurchaseOrderById(poId, client, true);
  if (!po || !BINDABLE_PO_STATUSES.has(po.status)) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'A GRN must reference an issued or confirmed purchase order',
      { grn_id: grnId, po_id: poId, po_status: po?.status ?? null },
      409,
    );
  }
  // First stamp wins. A re-link to the SAME PO is an idempotent no-op; a re-link to a different
  // one is rejected rather than silently ignored, so the caller learns the binding did not move.
  if (grn.po_id !== null && grn.po_id !== poId) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'This GRN is already linked to a different purchase order',
      { grn_id: grnId, po_id: poId, linked_po_id: grn.po_id, detail: 'already_linked' },
      409,
    );
  }
  // Review 4.5 P12 (deferred 2026-08-06): the user's chosen check (po_ref_ext supplier
  // correspondence) needs an ERP-side identifier that matches the governed supplier's namespace.
  // erp_purchase_order carries only supplier_ref_ext (the ERP's own supplier code), and the
  // governed supplier carries gstin_ext + owner_party_code - three different namespaces with no
  // direct mapping in the current schema (see ownership.ts:221-226 for the same lesson). A real
  // correspondence check needs a dedicated mapping table (ERP supplier_ref_ext <-> governed
  // supplier_id/gstin), which is a separate work item. Until that mapping exists, the applier
  // can only enforce the spec-mandated PO existence + status check, which is the "deferred"
  // resolution logged to deferred-work.md.

  p['linked_by'] = envelope.metadata.actor.user_id;
  p['po_number_ext'] = po.po_number_ext;
  await linkGrnToPurchaseOrder(grnId, poId, client);
}

async function applyThreeWayMatchRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const matchId = p['match_id'] as string;
  const invoiceId = p['invoice_id'] as string;

  // (a) The invoice is the entity this run serializes on.
  const invoice = await getSupplierInvoiceById(invoiceId, client, true);
  if (!invoice) {
    reject('SUPPLIER_INVOICE_NOT_FOUND', 'Invoice not found', { invoice_id: invoiceId }, 404);
  }
  // Story 4.7's explicit consumer contract: a match attempt against an invoice that is still
  // unmatched (no PO bound) is rejected, not silently treated as a zero-line match.
  if (invoice.status !== 'captured' || invoice.po_id === null) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'A three-way match requires an invoice captured against a purchase order',
      { invoice_id: invoiceId, invoice_status: invoice.status, detail: 'unmatched' },
      409,
    );
  }
  const poId = invoice.po_id;

  const po = await getPurchaseOrderById(poId, client);
  if (!po) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'The purchase order referenced by this invoice no longer exists',
      { invoice_id: invoiceId, po_id: poId, detail: 'po_not_found' },
      409,
    );
  }

  // (b) At least one POSTED receipt against the same PO. An open GRN is still being captured.
  const postedGrns = await client.query(
    `SELECT grn_id FROM grn WHERE po_id = $1 AND status = 'posted' ORDER BY grn_id ASC`,
    [poId],
  );
  if (postedGrns.rows.length === 0) {
    reject(
      'SOURCE_DOCUMENT_REQUIRED',
      'A three-way match requires at least one posted goods receipt against the purchase order',
      { invoice_id: invoiceId, po_id: poId, detail: 'no_grn' },
      409,
    );
  }

  // (c)-(d) The comparison, entirely in SQL NUMERIC. Every per-line and header pass/fail
  // decision is computed in SQL against the configured tolerances (Binding Decision 8): this
  // module never turns a NUMERIC-as-string into a JS number to decide tolerance.
  const tolerances = {
    quantityTolerancePercent: config.threeWayMatch.quantityTolerancePercent,
    priceTolerancePercent: config.threeWayMatch.priceTolerancePercent,
    invoiceValueToleranceAbsolute: config.threeWayMatch.invoiceValueToleranceAbsolute,
  };
  const comparison = await computeMatchVariance(invoiceId, poId, tolerances, client);

  const toleranceSnapshot = {
    quantity_pct: String(tolerances.quantityTolerancePercent),
    price_pct: String(tolerances.priceTolerancePercent),
    invoice_value_abs: String(tolerances.invoiceValueToleranceAbsolute),
    rule_version: config.threeWayMatch.ruleVersion,
  };
  const lineFailures = comparison.lines.filter((l) => l.failure_reason !== undefined);
  // A PO with no lines at all cannot be matched to anything - fail closed rather than passing a
  // vacuous comparison (the Story 4.4 "fail closed when a guard cannot resolve" lesson).
  const passed =
    comparison.lines.length > 0 &&
    lineFailures.length === 0 &&
    comparison.unmatched_invoice_lines.length === 0 &&
    comparison.invoice_value_within_tolerance;

  const varianceDetail = {
    lines: comparison.lines,
    unmatched_invoice_lines: comparison.unmatched_invoice_lines,
    invoice_total_value: comparison.invoice_total_value,
    matched_line_value_total: comparison.matched_line_value_total,
    invoice_value_variance_abs: comparison.invoice_value_variance_abs,
    invoice_value_within_tolerance: comparison.invoice_value_within_tolerance,
    tolerance_snapshot: toleranceSnapshot,
  };
  const status: 'passed' | 'blocked' = passed ? 'passed' : 'blocked';
  const errorCode = passed ? null : 'MATCH_OUT_OF_TOLERANCE';

  // (e) The record. Payload is overwritten with the SERVER's findings before the domain_events
  // insert, so the stored event and the projection can never disagree and a spoofed result is
  // discarded rather than trusted.
  p['po_id'] = poId;
  p['grn_ids'] = comparison.grn_ids;
  p['result'] = status;
  if (errorCode === null) delete p['error_code'];
  else p['error_code'] = errorCode;
  p['variance_detail'] = varianceDetail;
  p['tolerance_snapshot'] = toleranceSnapshot;
  p['run_by'] = envelope.metadata.actor.user_id;

  // (f) Idempotent on match_id; a re-run after a lift is a NEW match_id, never an overwrite.
  // Review 4.5 P2: when the row was already present (a replayed event carrying the same
  // match_id), the original projection row is canonical and the invoice mirror must NOT be
  // overwritten with the new computation, or the mirror desynchronizes from the row.
  const inserted = await insertThreeWayMatch(
    {
      match_id: matchId,
      invoice_id: invoiceId,
      po_id: poId,
      site_id: invoice.site_id,
      business_stream: invoice.business_stream,
      status,
      error_code: errorCode,
      variance_detail: varianceDetail,
      tolerance_rule_version: config.threeWayMatch.ruleVersion,
      run_by: envelope.metadata.actor.user_id,
      recorded_at: envelope.metadata.occurred_at,
      source_event_id: eventId,
    },
    client,
  );
  if (inserted === 0) return;
  await updateSupplierInvoiceMatchStatus(invoiceId, status, client);
}

async function applyNoteRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  noteType: 'credit_note' | 'debit_note',
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const noteId = p['note_id'] as string;
  const matchId = p['match_id'] as string;
  const invoiceId = p['invoice_id'] as string;
  const noteNumberExt = (p['note_number_ext'] as string).trim();
  const amount = p['amount'] as string;

  // Notes are immutable once recorded. There is no note table (they are additive events only), so
  // identity is enforced against the event log itself. Review 4.5 P8: a same-note_id replay
  // carrying a DIFFERENT match_id / invoice_id / note_number_ext / amount is a real mismatch and
  // must 409; a faithful replay is the same-shape no-op it has always been.
  const existingNoteResult = await client.query(
    `SELECT event_id, payload
       FROM domain_events
      WHERE event_type IN ('supplier_invoice.credit_note_recorded', 'supplier_invoice.debit_note_recorded')
        AND payload->>'note_id' = $1
      LIMIT 1`,
    [noteId],
  );
  if (existingNoteResult.rows.length > 0) {
    const existingPayload = (existingNoteResult.rows[0] as Record<string, unknown>)[
      'payload'
    ] as Record<string, unknown>;
    if (
      existingPayload['match_id'] !== matchId ||
      existingPayload['invoice_id'] !== invoiceId ||
      (existingPayload['note_number_ext'] as string | undefined)?.trim() !== noteNumberExt ||
      existingPayload['amount'] !== amount ||
      ((existingPayload['note_type'] as string | undefined) ?? null) !==
        ((p['note_type'] as string | undefined) ?? null)
    ) {
      reject(
        'DUPLICATE_EVENT',
        'A note with this note_id already exists with different fields',
        { note_id: noteId, existing_event_id: existingNoteResult.rows[0]['event_id'] },
        409,
      );
    }
    return;
  }

  // Review 4.5 P9: one physical note (same note_number_ext for this invoice) must be recordable
  // exactly once. A second note with a different server-generated note_id and the same
  // note_number_ext would lift a DIFFERENT blocked match today - a real payment-clearing hazard.
  const duplicateNumberResult = await client.query(
    `SELECT 1 FROM domain_events
      WHERE event_type IN ('supplier_invoice.credit_note_recorded', 'supplier_invoice.debit_note_recorded')
        AND payload->>'invoice_id' = $1
        AND btrim(payload->>'note_number_ext') = $2
      LIMIT 1`,
    [invoiceId, noteNumberExt],
  );
  if (duplicateNumberResult.rows.length > 0) {
    reject(
      'DUPLICATE_EVENT',
      'A note with this invoice and note_number_ext already exists',
      { invoice_id: invoiceId, note_number_ext: noteNumberExt },
      409,
    );
  }

  // Review 4.5 P1: take the invoice lock FIRST so a concurrent match run cannot interleave
  // between the match lock and the mirror update. We also re-verify the match is the LATEST run
  // for this invoice; a note against a superseded blocked match would otherwise flip the mirror
  // to 'lifted' while a newer blocked run is the authoritative one.
  const invoice = await getSupplierInvoiceById(invoiceId, client, true);
  if (!invoice) {
    reject('SUPPLIER_INVOICE_NOT_FOUND', 'Invoice not found', { invoice_id: invoiceId }, 404);
  }
  const match = await getMatchById(matchId, client, true);
  if (!match) {
    reject('MATCH_NOT_FOUND', 'Three-way match not found', { match_id: matchId }, 404);
  }
  if (match.invoice_id !== invoiceId) {
    reject('INVALID_PARAMS', 'match_id does not belong to this invoice', {
      match_id: matchId,
      invoice_id: invoiceId,
    });
  }
  // AC3: only a BLOCKED match can be lifted. An already-lifted or passed match rejects, so a
  // second note cannot re-lift and a note can never be used to reverse a clean match.
  if (match.status !== 'blocked') {
    reject(
      'MATCH_NOT_BLOCKED',
      'Only a blocked three-way match can be lifted by a credit or debit note',
      { match_id: matchId, match_status: match.status },
      409,
    );
  }
  // Supersession guard: refuse to lift a match that is NOT the latest run for this invoice. A
  // new blocked run would otherwise leave the mirror saying 'lifted' while the latest row is
  // 'blocked' and the clearance feed would authorize payment against a blocked invoice.
  const latest = await getLatestMatchByInvoiceId(invoiceId, client, true);
  if (latest && latest.match_id !== matchId) {
    reject(
      'MATCH_NOT_BLOCKED',
      'A newer three-way match exists for this invoice; lift that one instead',
      { match_id: matchId, latest_match_id: latest.match_id, latest_status: latest.status },
      409,
    );
  }

  const lifted = await liftThreeWayMatch(
    matchId,
    noteId,
    noteType,
    envelope.metadata.occurred_at,
    client,
  );
  if (lifted === 0) {
    reject(
      'MATCH_NOT_BLOCKED',
      'The three-way match was lifted concurrently',
      {
        match_id: matchId,
      },
      409,
    );
  }
  await updateSupplierInvoiceMatchStatus(invoiceId, 'lifted', client);
  p['recorded_by'] = envelope.metadata.actor.user_id;
  p['note_type'] = noteType;
}

async function applyPaymentClearanceFeedRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;

  // The ledger row is derived and inserted HERE, inside the persistEvent transaction, so a
  // replayed event rebuilds the row and a direct POST /api/v1/events cannot create a clearance
  // event without the payload that authorizes it (AD-4, msme.ts precedent).
  const rows = await listClearanceEligibleInvoices(client);
  const payload = buildPaymentClearanceFeedPayload(
    rows,
    p['generated_at'] as string,
    envelope.metadata.correlation_id ?? null,
  );
  const inserted = await insertPaymentClearanceFeed(
    {
      feed_id: p['feed_id'] as string,
      payload: payload as unknown as Record<string, unknown>,
      row_count: rows.length,
    },
    client,
  );
  if (inserted === 0) return;
  p['row_count'] = rows.length;
  p['correlation_id'] = envelope.metadata.correlation_id ?? null;
}

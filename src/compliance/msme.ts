import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import type { EventEnvelope } from '../events/store.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { updateSupplierMsmeFields } from '../read/projections/supplier.js';
import { queryMsmeAgeing, insertMsmeAgeingFeed } from '../read/projections/msme_ageing.js';
import { buildMsmeAgeingFeedPayload } from '../adapters/erp/msme-ageing-feed.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';

/**
 * MSME compliance module (Story 4.6, FR-P-09).
 *
 * Udyam registration lifecycle (verify / re-verify / suspend on lapsed revalidation), the dated
 * MSMED 2006 s.15 statutory due-date rule, statutory breach flagging, and the ERP ageing feed
 * ledger applier. All state changes flow through persistEvent on the closed 'procurement' stream;
 * the daily compliance check is a pure cycle function callable from the synthetic HTTP trigger
 * now and a real scheduler later (planning-jobs.ts precedent - no cron exists in Phase 1).
 */

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
export const MSME_EVENT_TYPES = new Set([
  'supplier.msme_verified',
  'supplier.msme_suspended',
  'supplier_invoice.statutory_breach_flagged',
  'msme_ageing_feed.recorded',
]);

export const UDYAM_REGEX = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const MSME_CLASSIFICATIONS = new Set(['micro', 'small', 'medium']);

/** MSMED 2006 s.15: the agreed credit period can never push the due date past 45 days. */
const STATUTORY_CEILING_DAYS = 45;
/** MSMED 2006 s.2(b)/s.15: 15 days from the day of acceptance where no agreement exists. */
const APPOINTED_DAY_RULE_DAYS = 15;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isDateString(value: unknown): value is string {
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

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}

export function msmeEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!MSME_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Dated statutory due-date rule (MSMED 2006 s.15)
// ---------------------------------------------------------------------------

/** Pure calendar-date addition - strict YYYY-MM-DD in and out, no elapsed-millisecond arithmetic. */
function addCalendarDays(date: string, days: number): string {
  const match = DATE_REGEX.exec(date)!;
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  const d = new Date(base);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** IST = UTC+5:30. Shift the instant, then read back with UTC getters (gate.ts precedent). */
export function istCalendarDate(isoTimestamp: string): string {
  const ist = new Date(new Date(isoTimestamp).getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The statutory payment due date for an MSME supplier, anchored on a calendar date (PO
 * confirmation IST business date, or invoice_date for invoices - two anchors, one calculator).
 *
 * Agreement definition (documented assumption, Story 4.6 Task 4.2): a positive supplier
 * credit_period_days means a written agreement exists - the agreed date is anchor + credit
 * period, capped by the 45-day s.15 ceiling. A null or non-positive credit period means no
 * agreement: 15 days from the anchor (the appointed-day rule).
 */
export function computeStatutoryDueDate(
  anchorDate: string,
  creditPeriodDays: number | null,
): string {
  if (!isDateString(anchorDate)) {
    reject('INVALID_PARAMS', 'anchor date must be a YYYY-MM-DD calendar date', {
      anchor_date: anchorDate,
    });
  }
  const hasAgreement =
    creditPeriodDays !== null && Number.isInteger(creditPeriodDays) && creditPeriodDays > 0;
  const days = hasAgreement
    ? Math.min(creditPeriodDays, STATUTORY_CEILING_DAYS)
    : APPOINTED_DAY_RULE_DAYS;
  return addCalendarDays(anchorDate, days);
}

/**
 * The single MSME registry accessor (Story 4.7 Task 7 contract: downstream stories reuse this
 * accessor and the dated rule contract rather than adding a competing MSME registry).
 */
export interface SupplierMsmeContext {
  msme_status: 'active' | 'suspended-pending-reverification' | null;
  msme_classification: 'micro' | 'small' | 'medium' | null;
  credit_period_days: number;
  rule_version: string;
}

export async function getSupplierMsmeContext(
  supplierId: string,
  client: PoolClient,
): Promise<SupplierMsmeContext | null> {
  const result = await client.query(
    `SELECT msme_status, msme_classification, credit_period_days FROM supplier WHERE supplier_id = $1`,
    [supplierId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as Record<string, unknown>;
  return {
    msme_status: row['msme_status'] as SupplierMsmeContext['msme_status'],
    msme_classification: row['msme_classification'] as SupplierMsmeContext['msme_classification'],
    credit_period_days: row['credit_period_days'] as number,
    rule_version: config.msme.ruleVersion,
  };
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertMsmeShape(envelope: EventEnvelope): void {
  const type = msmeEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'supplier.msme_verified':
      assertMsmeVerifiedShape(p);
      break;
    case 'supplier.msme_suspended':
      assertMsmeSuspendedShape(p);
      break;
    case 'supplier_invoice.statutory_breach_flagged':
      assertStatutoryBreachFlaggedShape(p);
      break;
    case 'msme_ageing_feed.recorded':
      assertAgeingFeedRecordedShape(p);
      break;
  }
}

function assertMsmeVerifiedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (typeof p['udyam_number_ext'] !== 'string' || !UDYAM_REGEX.test(p['udyam_number_ext'])) {
    reject('UDYAM_INVALID', 'udyam_number_ext must match the format UDYAM-XX-00-0000000', {
      udyam_number_ext: p['udyam_number_ext'],
    });
  }
  // Certificate mismatch: a verification without a certificate reference, or without the
  // classification the certificate carries, cannot be saved - the supplier stays untagged (AC6).
  if (
    typeof p['msme_classification'] !== 'string' ||
    !MSME_CLASSIFICATIONS.has(p['msme_classification'])
  ) {
    reject(
      'UDYAM_INVALID',
      'msme_classification must be micro, small, or medium as recorded on the Udyam certificate',
      { msme_classification: p['msme_classification'] },
    );
  }
  if (!isNonEmptyString(p['certificate_reference'])) {
    reject(
      'UDYAM_INVALID',
      'certificate_reference to the uploaded Udyam certificate is required for verification',
      { certificate_reference: p['certificate_reference'] },
    );
  }
  if (!isIsoTimestamp(p['verified_at']))
    reject('INVALID_PARAMS', 'verified_at is required and must be an ISO timestamp');
  if (!isDateString(p['revalidation_due_date']))
    reject('INVALID_PARAMS', 'revalidation_due_date must be a YYYY-MM-DD calendar date');
  // Udyam revalidation is annual; reject back-dated or absurdly-far-future dates so a verify
  // event with a yesterday-due date cannot bypass the AC5 lead-time alert window.
  if (isDateString(p['revalidation_due_date'])) {
    const today = istCalendarDate(new Date().toISOString());
    if ((p['revalidation_due_date'] as string) < today) {
      reject(
        'UDYAM_INVALID',
        'revalidation_due_date must be today or in the future',
        { revalidation_due_date: p['revalidation_due_date'] },
      );
    }
  }
}

function assertMsmeSuspendedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (p['reason'] !== 'revalidation-lapsed')
    reject('INVALID_PARAMS', 'reason must be revalidation-lapsed', { reason: p['reason'] });
  if (!isDateString(p['lapsed_on']))
    reject('INVALID_PARAMS', 'lapsed_on must be a YYYY-MM-DD calendar date');
}

function assertStatutoryBreachFlaggedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['invoice_id']))
    reject('INVALID_PARAMS', 'invoice_id is required and must be a UUID');
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!isDateString(p['statutory_due_date']))
    reject('INVALID_PARAMS', 'statutory_due_date must be a YYYY-MM-DD calendar date');
  if (!isDateString(p['detected_on']))
    reject('INVALID_PARAMS', 'detected_on must be a YYYY-MM-DD calendar date');
}

function assertAgeingFeedRecordedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['feed_id'])) reject('INVALID_PARAMS', 'feed_id is required and must be a UUID');
  if (
    typeof p['row_count'] !== 'number' ||
    !Number.isInteger(p['row_count']) ||
    p['row_count'] < 0
  ) {
    reject('INVALID_PARAMS', 'row_count must be a non-negative integer');
  }
  if (!isIsoTimestamp(p['generated_at']))
    reject('INVALID_PARAMS', 'generated_at is required and must be an ISO timestamp');
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

export async function applyMsmeProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = msmeEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'supplier.msme_verified':
      await applyMsmeVerified(envelope, client);
      break;
    case 'supplier.msme_suspended':
      await applyMsmeSuspended(envelope, client);
      break;
    case 'supplier_invoice.statutory_breach_flagged':
      await applyStatutoryBreachFlagged(envelope, client);
      break;
    case 'msme_ageing_feed.recorded':
      await applyMsmeAgeingFeedRecorded(envelope, client);
      break;
  }
}

async function applyMsmeVerified(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;

  const existing = await client.query(`SELECT 1 FROM supplier WHERE supplier_id = $1 FOR UPDATE`, [
    supplierId,
  ]);
  if (existing.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId }, 404);
  }

  // Verify and re-verify share this applier: re-verification moves a suspended supplier back to
  // active and stamps the fresh revalidation due date.
  await updateSupplierMsmeFields(
    supplierId,
    {
      udyam_number_ext: p['udyam_number_ext'] as string,
      msme_classification: p['msme_classification'] as 'micro' | 'small' | 'medium',
      msme_certificate_reference: p['certificate_reference'] as string,
      msme_status: 'active',
      udyam_verified_at: p['verified_at'] as string,
      udyam_revalidation_due_date: p['revalidation_due_date'] as string,
    },
    client,
  );
}

async function applyMsmeSuspended(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;

  const existing = await client.query(
    `SELECT msme_status FROM supplier WHERE supplier_id = $1 FOR UPDATE`,
    [supplierId],
  );
  if (existing.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId }, 404);
  }
  const row = existing.rows[0] as Record<string, unknown>;
  // Only an active MSME flag can lapse; a replayed or racing suspension is a no-op. Statutory
  // due dates already stamped on open POs and invoices are deliberately NOT touched
  // (conservative treatment, AC7).
  if (row['msme_status'] !== 'active') return;

  await updateSupplierMsmeFields(
    supplierId,
    { msme_status: 'suspended-pending-reverification' },
    client,
  );
}

async function applyStatutoryBreachFlagged(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const invoiceId = p['invoice_id'] as string;

  const existing = await client.query(
    `SELECT statutory_breach, statutory_due_date::text AS statutory_due_date FROM supplier_invoice WHERE invoice_id = $1 FOR UPDATE`,
    [invoiceId],
  );
  if (existing.rows.length === 0) {
    reject('SUPPLIER_INVOICE_NOT_FOUND', 'Invoice not found', { invoice_id: invoiceId }, 404);
  }
  const row = existing.rows[0] as Record<string, unknown>;
  if (row['statutory_breach'] === true) return;

  await client.query(
    `UPDATE supplier_invoice SET statutory_breach = true, updated_at = now() WHERE invoice_id = $1`,
    [invoiceId],
  );

  // AD-17: a statutory breach escalation is a statutory communication - transactional entry
  // point, failures propagate and roll the breach flag back with the event.
  const dueDate = p['statutory_due_date'] as string;
  await emitNotificationInTransaction(
    {
      target: { role: 'finance_compliance_officer' },
      event_type: 'msme_statutory_breach',
      status_verb: 'breached',
      object_type: 'supplier_invoice',
      object_id: invoiceId,
      actor_label: `Supplier ${p['supplier_id']}`,
      next_step: `Statutory due date ${dueDate} passed unpaid - MSMED s.16 interest accrues from ${addCalendarDays(dueDate, 1)}`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

async function applyMsmeAgeingFeedRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const generatedAt = p['generated_at'] as string;

  // The ledger row is derived and inserted HERE, inside the persistEvent transaction (the
  // po_outbound_message-inside-applyPoIssued pattern), so a replayed event rebuilds the row and a
  // direct POST /api/v1/events cannot create an event without its ledger row.
  const ageingRows = await queryMsmeAgeing(
    istCalendarDate(generatedAt),
    config.msme.interestRatePercentAnnual,
    client,
  );
  const payload = buildMsmeAgeingFeedPayload(
    ageingRows,
    generatedAt,
    envelope.metadata.correlation_id ?? null,
  );
  await insertMsmeAgeingFeed(
    {
      feed_id: p['feed_id'] as string,
      payload: payload as unknown as Record<string, unknown>,
      row_count: ageingRows.length,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Daily compliance check (Story 4.6 Task 9) - synthetic HTTP trigger, scheduler-ready
// ---------------------------------------------------------------------------

export type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

export interface MsmeComplianceActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface MsmeComplianceScope {
  business_date: string;
  actor: MsmeComplianceActor;
  auditCtx?: AuditCtx;
}

export interface MsmeComplianceCheckResult {
  business_date: string;
  revalidation_alerts: Array<{ supplier_id: string; revalidation_due_date: string }>;
  suspended: Array<{ supplier_id: string; lapsed_on: string }>;
  breaches_flagged: Array<{
    invoice_id: string;
    supplier_id: string;
    statutory_due_date: string;
  }>;
}

function msmeEventMetadata(scope: MsmeComplianceScope): EventEnvelope['metadata'] {
  // Anchor occurred_at on the scope's business_date so a manual replay for a past date
  // produces events dated at the start of that business day, not at the wall-clock moment
  // the sweep ran. Downstream ordering by occurred_at and the audit timeline stay aligned.
  return {
    correlation_id: randomUUID(),
    actor: {
      user_id: scope.actor.user_id,
      role: scope.actor.role,
      location_id: scope.actor.location_id,
    },
    occurred_at: `${scope.business_date}T00:00:00.000Z`,
  };
}

/**
 * Three idempotent-per-day sweeps: revalidation-window alerts (AC5), lapse suspension (AC7),
 * statutory breach flagging (AC8). Interest itself accrues in the ageing computation (Task 7),
 * never as a stored balance.
 */
export async function runMsmeComplianceCheck(
  scope: MsmeComplianceScope,
): Promise<MsmeComplianceCheckResult> {
  if (!isDateString(scope.business_date)) {
    reject('INVALID_PARAMS', 'business_date must be a YYYY-MM-DD calendar date', {
      business_date: scope.business_date,
    });
  }

  const pool = getPool();
  const result: MsmeComplianceCheckResult = {
    business_date: scope.business_date,
    revalidation_alerts: [],
    suspended: [],
    breaches_flagged: [],
  };

  // Sweep 1 (AC5): revalidation window opening. Dedupe on the notification.created payload so a
  // supplier already alerted for the same due date is not re-notified on every daily run.
  const windowRows = await pool.query(
    `SELECT supplier_id, legal_name, udyam_revalidation_due_date::text AS due_date
     FROM supplier
     WHERE msme_status = 'active'
       AND udyam_revalidation_due_date >= $1::date
       AND udyam_revalidation_due_date <= $1::date + $2::integer
     ORDER BY udyam_revalidation_due_date ASC, supplier_id ASC`,
    [scope.business_date, config.msme.revalidationLeadDays],
  );
  for (const raw of windowRows.rows as Record<string, unknown>[]) {
    const supplierId = raw['supplier_id'] as string;
    const dueDate = raw['due_date'] as string;
    const already = await pool.query(
      `SELECT 1 FROM domain_events
       WHERE event_type = 'notification.created'
         AND payload->>'object_type' = 'supplier_udyam_revalidation'
         AND payload->>'object_id' = $1
         AND payload->>'next_step' LIKE '%' || $2 || '%'
       LIMIT 1`,
      [supplierId, dueDate],
    );
    if (already.rows.length > 0) continue;

    // AD-17: the revalidation alert is a statutory communication - transactional entry point.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await emitNotificationInTransaction(
        {
          target: { role: 'procurement_officer' },
          event_type: 'msme_revalidation_due',
          status_verb: 'due',
          object_type: 'supplier_udyam_revalidation',
          object_id: supplierId,
          actor_label: `Supplier ${raw['legal_name']}`,
          next_step: `Re-verify the Udyam registration before ${dueDate} or the MSME flag lapses`,
        actor: scope.actor,
        // Same anchor as msmeEventMetadata: a replayed check for a past business date produces
        // an alert dated at the start of that business day, not at wall-clock now.
        occurred_at: `${scope.business_date}T00:00:00.000Z`,
        },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    result.revalidation_alerts.push({ supplier_id: supplierId, revalidation_due_date: dueDate });
  }

  // Sweep 2 (AC7): lapse. The applier flips msme_status, so tomorrow's run no longer matches;
  // the idempotency key makes a same-day re-run a 2xx no-op replay.
  const lapsedRows = await pool.query(
    `SELECT supplier_id, udyam_revalidation_due_date::text AS lapsed_on
     FROM supplier
     WHERE msme_status = 'active'
       AND udyam_revalidation_due_date < $1::date
     ORDER BY udyam_revalidation_due_date ASC, supplier_id ASC`,
    [scope.business_date],
  );
  for (const raw of lapsedRows.rows as Record<string, unknown>[]) {
    const supplierId = raw['supplier_id'] as string;
    const lapsedOn = raw['lapsed_on'] as string;
    await persistEvent(
      {
        stream_type: 'procurement',
        stream_id: supplierId,
        event_type: 'supplier.msme_suspended',
        payload: { supplier_id: supplierId, reason: 'revalidation-lapsed', lapsed_on: lapsedOn },
        metadata: msmeEventMetadata(scope),
        idempotency_key: `msme-suspend-${supplierId}-${lapsedOn}`,
      },
      scope.auditCtx,
    );
    result.suspended.push({ supplier_id: supplierId, lapsed_on: lapsedOn });
  }

  // Sweep 3 (AC8): statutory breach. The applier sets statutory_breach = true (excluded from
  // tomorrow's candidate set) and emits the finance-compliance escalation in-transaction.
  const breachRows = await pool.query(
    `SELECT invoice_id, supplier_id, statutory_due_date::text AS due_date
     FROM supplier_invoice
     WHERE statutory_breach = false
       AND statutory_due_date IS NOT NULL
       AND statutory_due_date < $1::date
     ORDER BY statutory_due_date ASC, invoice_id ASC`,
    [scope.business_date],
  );
  for (const raw of breachRows.rows as Record<string, unknown>[]) {
    const invoiceId = raw['invoice_id'] as string;
    const supplierId = raw['supplier_id'] as string;
    const dueDate = raw['due_date'] as string;
    await persistEvent(
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: 'supplier_invoice.statutory_breach_flagged',
        payload: {
          invoice_id: invoiceId,
          supplier_id: supplierId,
          statutory_due_date: dueDate,
          detected_on: scope.business_date,
        },
        metadata: msmeEventMetadata(scope),
        idempotency_key: `msme-breach-${invoiceId}-${dueDate}`,
      },
      scope.auditCtx,
    );
    result.breaches_flagged.push({
      invoice_id: invoiceId,
      supplier_id: supplierId,
      statutory_due_date: dueDate,
    });
  }

  return result;
}

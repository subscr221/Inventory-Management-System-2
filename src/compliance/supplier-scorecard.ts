import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import {
  insertScorecardMetric,
  computeSignedDayDelta,
  computeMatchPriceVariance,
  getPoConfirmedEventId,
} from '../read/projections/supplier_scorecard_metric.js';
import { businessDaysBetween, toIstCalendarDate } from '../lib/business-days.js';
import { config } from '../config/index.js';

/**
 * Supplier scorecard compliance module (Story 4.2, FR-P-03).
 *
 * The seam - not the HTTP route - is the enforcement layer for every scorecard metric write:
 * shape validation (metric kind enum, strict UUIDs, NUMERIC-as-string scale, calendar-date
 * rollover), the supplier-active gate, reference-entity resolution, VALUE RE-DERIVATION, and
 * replay idempotency all run inside persistEvent so a direct POST /api/v1/events cannot bypass
 * them. The applier resolves reference_entity_id per metric kind (grn, three_way_match,
 * purchase_order) under FOR UPDATE locks, verifies existence/status/supplier correspondence,
 * re-computes value_num, business_date and reference_event_id from the governed projections,
 * and rejects any payload disagreement (the Story 4.7 derive-again-reject precedent). The route
 * is a convenience entry point; its computed value is a candidate, never trusted. The projection
 * is append-only: a correction is a NEW row carrying supersedes_metric_id, never an UPDATE. All
 * NUMERIC arithmetic runs in PostgreSQL; value_num passes through as a string and is cast in SQL.
 */

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
const SCORECARD_EVENT_TYPE = 'supplier_scorecard.metric_recorded';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * Signed NUMERIC(14,6)-as-string: at most 8 integer digits so precision 14 with scale 6 can
 * never overflow in the projection INSERT, at most 6 decimal places.
 */
const VALUE_NUM_REGEX = /^-?\d{1,8}(\.\d{1,6})?$/;

export const SCORECARD_METRIC_KINDS = new Set([
  'on_time_delivery',
  'quality_acceptance',
  'price_variance',
  'responsiveness',
]);

/** Context keys each metric kind must carry for drill-through transparency (Task 3.2). */
const REQUIRED_CONTEXT_KEYS: Record<string, string[]> = {
  on_time_delivery: ['received_date', 'promised_delivery_date'],
  quality_acceptance: ['disposition'],
  price_variance: ['variance_pct'],
  responsiveness: ['issued_at', 'confirmed_at'],
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value) && value !== NIL_UUID;
}

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Reject rollover dates (31 February), epoch-zero, and sentinel far-future years.
  if (year < 1971 || year > 9998) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}

export function supplierScorecardEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (envelope.event_type !== SCORECARD_EVENT_TYPE) return null;
  return envelope.event_type;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access, never consumes an idempotency key)
// ---------------------------------------------------------------------------

export function assertSupplierScorecardShape(envelope: EventEnvelope): void {
  if (!supplierScorecardEventType(envelope)) return;
  const p = envelope.payload as Record<string, unknown>;

  if (!isUuid(p['metric_id']))
    reject('INVALID_PARAMS', 'metric_id is required and must be a non-nil RFC-4122 UUID');
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a non-nil RFC-4122 UUID');
  const metricKind = p['metric_kind'];
  if (typeof metricKind !== 'string' || !SCORECARD_METRIC_KINDS.has(metricKind)) {
    reject(
      'INVALID_PARAMS',
      'metric_kind must be one of on_time_delivery, quality_acceptance, price_variance, responsiveness',
      { metric_kind: metricKind },
    );
  }
  if (!isUuid(p['reference_event_id']))
    reject('INVALID_PARAMS', 'reference_event_id is required and must be a non-nil RFC-4122 UUID');
  if (!isUuid(p['reference_entity_id']))
    reject('INVALID_PARAMS', 'reference_entity_id is required and must be a non-nil RFC-4122 UUID');
  if (typeof p['value_num'] !== 'string' || !VALUE_NUM_REGEX.test(p['value_num'])) {
    reject(
      'INVALID_PARAMS',
      'value_num must be a NUMERIC string with at most 8 integer digits and 6 decimal places',
      { value_num: p['value_num'] },
    );
  }
  if (!isDateString(p['business_date'])) {
    reject('INVALID_PARAMS', 'business_date must be a valid YYYY-MM-DD calendar date', {
      business_date: p['business_date'],
    });
  }
  if (p['supersedes_metric_id'] !== undefined && !isUuid(p['supersedes_metric_id'])) {
    reject('INVALID_PARAMS', 'supersedes_metric_id must be a non-nil RFC-4122 UUID when present');
  }
  const context = p['context'];
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    reject('INVALID_PARAMS', 'context must be a JSON object');
  }
  const requiredKeys = REQUIRED_CONTEXT_KEYS[metricKind as string] ?? [];
  for (const key of requiredKeys) {
    if ((context as Record<string, unknown>)[key] === undefined) {
      reject('INVALID_PARAMS', `context.${key} is required for metric_kind ${metricKind}`, {
        metric_kind: metricKind,
        missing_key: key,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

// The plain-SELECT variant (src/compliance/purchase-order.ts precedent). Never FOR UPDATE on
// domain_events - that variant in src/compliance/supplier.ts is a known live 42501 defect.
async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applySupplierScorecardProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (!supplierScorecardEventType(envelope)) return;
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;
  const metricKind = p['metric_kind'] as string;
  const referenceEntityId = p['reference_entity_id'] as string;

  const supplier = await client.query(
    `SELECT status FROM supplier WHERE supplier_id = $1 FOR UPDATE`,
    [supplierId],
  );
  if (supplier.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId }, 404);
  }
  const status = (supplier.rows[0] as Record<string, unknown>)['status'];
  if (status !== 'active') {
    reject(
      'SUPPLIER_NOT_ACTIVE',
      'Scorecard metrics can only be recorded for active suppliers',
      { supplier_id: supplierId, status },
      409,
    );
  }

  // Epic 8 hook (Task 7.4): quality acceptance has no legitimate source until qc.lot_dispositioned
  // lands. The applier is a deliberate no-op so nothing can fabricate quality data early.
  if (metricKind === 'quality_acceptance') {
    console.debug(
      `[scorecard] quality_acceptance metric applier is a no-op until Epic 8 lands (supplier ${supplierId})`,
    );
    return;
  }

  // AC7 correction chain: supersedes_metric_id must point at an existing row of the SAME supplier
  // and metric kind, otherwise the chain semantics are fabricated.
  if (p['supersedes_metric_id'] !== undefined) {
    const superseded = await client.query(
      `SELECT supplier_id, metric_kind FROM supplier_scorecard_metric WHERE metric_id = $1`,
      [p['supersedes_metric_id']],
    );
    if (superseded.rows.length === 0) {
      reject(
        'SCORECARD_SUPERSEDES_NOT_FOUND',
        'supersedes_metric_id does not reference an existing scorecard metric',
        { supersedes_metric_id: p['supersedes_metric_id'] },
        409,
      );
    }
    const row = superseded.rows[0] as Record<string, unknown>;
    if (row['supplier_id'] !== supplierId || row['metric_kind'] !== metricKind) {
      reject(
        'SCORECARD_SUPERSEDES_MISMATCH',
        'supersedes_metric_id must reference a metric of the same supplier and metric kind',
        {
          supersedes_metric_id: p['supersedes_metric_id'],
          expected_supplier_id: supplierId,
          expected_metric_kind: metricKind,
        },
        409,
      );
    }
  }

  // AC6: re-derive the metric from the governed projections inside this transaction. The source
  // rows are locked FOR UPDATE so the derivation cannot race a concurrent source mutation.
  const derived = await deriveMetric(metricKind, referenceEntityId, supplierId, client);

  if (p['value_num'] !== derived.valueNum) {
    reject(
      'SCORECARD_DERIVATION_MISMATCH',
      'value_num disagrees with the seam re-derivation from the source projection',
      { field: 'value_num', submitted: p['value_num'], derived: derived.valueNum },
      409,
    );
  }
  if (p['business_date'] !== derived.businessDate) {
    reject(
      'SCORECARD_DERIVATION_MISMATCH',
      'business_date disagrees with the seam re-derivation from the source projection',
      { field: 'business_date', submitted: p['business_date'], derived: derived.businessDate },
      409,
    );
  }
  if (p['reference_event_id'] !== derived.referenceEventId) {
    reject(
      'SCORECARD_DERIVATION_MISMATCH',
      'reference_event_id disagrees with the event that produced the value',
      {
        field: 'reference_event_id',
        submitted: p['reference_event_id'],
        derived: derived.referenceEventId,
      },
      409,
    );
  }

  // Server-set attribution and server-derived drill-through context; never trusted from the
  // client (three-way-match precedent).
  p['recorded_by'] = envelope.metadata.actor.user_id;
  p['context'] = derived.context;

  // Idempotent on metric_id plus the partial (reference_event_id, metric_kind) replay guard; a
  // duplicate ordinary insert is a rowCount-0 no-op, mirroring the 4.5 ON CONFLICT DO NOTHING
  // pattern. Correction rows (supersedes set) are admitted by the partial index.
  await insertScorecardMetric(
    {
      metric_id: p['metric_id'] as string,
      supplier_id: supplierId,
      metric_kind: metricKind as
        'on_time_delivery' | 'quality_acceptance' | 'price_variance' | 'responsiveness',
      reference_event_id: derived.referenceEventId,
      reference_entity_id: referenceEntityId,
      value_num: derived.valueNum,
      context: derived.context,
      business_date: derived.businessDate,
      source_event_id: eventId,
      supersedes_metric_id: (p['supersedes_metric_id'] as string | undefined) ?? null,
      recorded_by: envelope.metadata.actor.user_id,
    },
    client,
  );
}

interface DerivedMetric {
  valueNum: string;
  businessDate: string;
  referenceEventId: string;
  context: Record<string, unknown>;
}

/**
 * Per-kind resolution and re-derivation. Every branch locks the source rows it reads, verifies
 * existence, lifecycle status and supplier correspondence, and computes the authoritative value
 * in PostgreSQL NUMERIC (business-day counting excepted - that calendar arithmetic lives in the
 * single src/lib/business-days.ts helper per Task 5). Any disagreement with the payload is a
 * stable 409, never a silent overwrite.
 */
async function deriveMetric(
  metricKind: string,
  referenceEntityId: string,
  supplierId: string,
  client: PoolClient,
): Promise<DerivedMetric> {
  if (metricKind === 'on_time_delivery') {
    const grnRes = await client.query(
      `SELECT grn_id, po_id, business_date::text AS business_date, source_event_id
       FROM grn WHERE grn_id = $1 FOR UPDATE`,
      [referenceEntityId],
    );
    if (grnRes.rows.length === 0) {
      reject('GRN_NOT_FOUND', 'GRN not found', { grn_id: referenceEntityId }, 404);
    }
    const grn = grnRes.rows[0] as Record<string, unknown>;
    if (!grn['po_id']) {
      reject(
        'GRN_NOT_LINKED',
        'GRN must be bound to a native PO before an on-time metric can be recorded',
        { grn_id: referenceEntityId },
        409,
      );
    }
    const po = await lockPurchaseOrder(grn['po_id'] as string, supplierId, client);
    if (po.status !== 'issued' && po.status !== 'confirmed') {
      reject(
        'PO_NOT_ISSUED',
        'On-time delivery is only measured against issued or confirmed POs',
        { po_id: po.poId, status: po.status },
        409,
      );
    }
    if (!po.promisedDate) {
      reject(
        'PO_PROMISE_DATE_MISSING',
        'The linked PO carries no promised_delivery_date; this receipt is excluded from the on-time metric',
        { po_id: po.poId },
        409,
      );
    }
    const receivedDate = grn['business_date'] as string;
    const valueNum = await computeSignedDayDelta(receivedDate, po.promisedDate, client);
    return {
      valueNum,
      businessDate: receivedDate,
      referenceEventId: grn['source_event_id'] as string,
      context: {
        received_date: receivedDate,
        promised_delivery_date: po.promisedDate,
        po_id: po.poId,
        grn_id: referenceEntityId,
      },
    };
  }

  if (metricKind === 'price_variance') {
    const matchRes = await client.query(
      `SELECT match_id, po_id, invoice_id, status, recorded_at, source_event_id
       FROM three_way_match WHERE match_id = $1 FOR UPDATE`,
      [referenceEntityId],
    );
    if (matchRes.rows.length === 0) {
      reject('MATCH_NOT_FOUND', 'Three-way match not found', { match_id: referenceEntityId }, 404);
    }
    const match = matchRes.rows[0] as Record<string, unknown>;
    if (match['status'] !== 'passed' && match['status'] !== 'blocked') {
      reject(
        'MATCH_NOT_FINAL',
        'Price variance is measured from passed or blocked matches only',
        { match_id: referenceEntityId, status: match['status'] },
        409,
      );
    }
    const po = await lockPurchaseOrder(match['po_id'] as string, supplierId, client);
    const variance = await computeMatchPriceVariance(referenceEntityId, client);
    const valueNum = variance?.mean_pct ?? '0.000000';
    return {
      valueNum,
      businessDate: toIstCalendarDate(new Date(match['recorded_at'] as string | Date)),
      referenceEventId: match['source_event_id'] as string,
      context: {
        variance_pct: valueNum,
        match_id: referenceEntityId,
        po_id: po.poId,
        invoice_id: match['invoice_id'],
        line_count: variance?.contributing_lines ?? 0,
      },
    };
  }

  if (metricKind === 'responsiveness') {
    const po = await lockPurchaseOrder(referenceEntityId, supplierId, client);
    if (po.status !== 'confirmed' || !po.issuedAt || !po.confirmedAt) {
      reject(
        'PO_NOT_CONFIRMED',
        'Responsiveness is measured from confirmed POs carrying both issued_at and confirmed_at',
        { po_id: po.poId, status: po.status },
        409,
      );
    }
    const referenceEventId = await getPoConfirmedEventId(po.poId, client);
    if (!referenceEventId) {
      reject(
        'PO_NOT_CONFIRMED',
        'No purchase_order.confirmed event exists for this PO',
        { po_id: po.poId },
        409,
      );
    }
    const holidays = config.scorecard.responsivenessHolidayCalendar;
    const businessDays = businessDaysBetween(
      new Date(po.issuedAt),
      new Date(po.confirmedAt),
      holidays,
    );
    return {
      valueNum: `${businessDays}.000000`,
      businessDate: toIstCalendarDate(new Date(po.confirmedAt)),
      referenceEventId,
      context: {
        po_id: po.poId,
        issued_at: new Date(po.issuedAt).toISOString(),
        confirmed_at: new Date(po.confirmedAt).toISOString(),
        business_days: businessDays,
        holiday_count: holidays.length,
      },
    };
  }

  // Unreachable: assertSupplierScorecardShape already rejected unknown kinds pre-transaction.
  return reject('INVALID_PARAMS', `Unsupported metric_kind ${metricKind}`, {
    metric_kind: metricKind,
  });
}

interface LockedPurchaseOrder {
  poId: string;
  supplierId: string;
  status: string;
  promisedDate: string | null;
  issuedAt: string | Date | null;
  confirmedAt: string | Date | null;
}

/** FOR UPDATE read of the PO row plus the payload-supplier correspondence check. */
async function lockPurchaseOrder(
  poId: string,
  payloadSupplierId: string,
  client: PoolClient,
): Promise<LockedPurchaseOrder> {
  const poRes = await client.query(
    `SELECT po_id, supplier_id, status, promised_delivery_date::text AS promised,
            issued_at, confirmed_at
     FROM purchase_order WHERE po_id = $1 FOR UPDATE`,
    [poId],
  );
  if (poRes.rows.length === 0) {
    reject('PO_NOT_FOUND', 'Purchase order not found', { po_id: poId }, 404);
  }
  const row = poRes.rows[0] as Record<string, unknown>;
  if (row['supplier_id'] !== payloadSupplierId) {
    reject(
      'SCORECARD_SUPPLIER_MISMATCH',
      'The payload supplier_id does not own the referenced source document',
      {
        po_id: poId,
        submitted_supplier_id: payloadSupplierId,
        source_supplier_id: row['supplier_id'],
      },
      409,
    );
  }
  return {
    poId,
    supplierId: row['supplier_id'] as string,
    status: row['status'] as string,
    promisedDate: (row['promised'] as string | null) ?? null,
    issuedAt: (row['issued_at'] as string | Date | null) ?? null,
    confirmedAt: (row['confirmed_at'] as string | Date | null) ?? null,
  };
}

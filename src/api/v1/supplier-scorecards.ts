import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getSupplierById } from '../../read/projections/supplier.js';
import { getGrnById } from '../../read/projections/grn.js';
import { getPurchaseOrderById } from '../../read/projections/purchase_order.js';
import { getMatchById } from '../../read/projections/three_way_match.js';
import { getQcLotDispositionById } from '../../read/projections/qc_lot_disposition.js';
import {
  getScorecardSummary,
  listScorecardMetrics,
  listScorecardTransactions,
  computeSignedDayDelta,
  computeMatchPriceVariance,
  getPoPromisedDateText,
  getPoConfirmedEventId,
} from '../../read/projections/supplier_scorecard_metric.js';
import type { SupplierScorecardMetricRow } from '../../read/projections/supplier_scorecard_metric.js';
import { businessDaysBetween, toIstCalendarDate } from '../../lib/business-days.js';
import { config } from '../../config/index.js';

/**
 * Story 4.2: supplier performance scorecard HTTP surface - the consolidated scorecard read, the
 * drill-through read, and the three thin metric write routes (on-time delivery, price variance,
 * responsiveness) plus the Story 8.3 quality-acceptance route, whose only legitimate source -
 * a qc_lot_disposition row - exists now that lot disposition has landed.
 *
 * The write routes are convenience entry points, not enforcement points: they load the source
 * record, compute the candidate value in SQL NUMERIC, and call persistEvent. The compliance seam
 * (src/compliance/supplier-scorecard.ts) enforces supplier-active, metric-kind, calendar-date,
 * NUMERIC shape and replay idempotency - a direct POST /api/v1/events hits the same gates.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Strict integer: Number.parseInt would happily accept "10abc" (Story 4.7 lesson). */
const INTEGER_REGEX = /^\d+$/;
const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const METRIC_KINDS = [
  'on_time_delivery',
  'quality_acceptance',
  'price_variance',
  'responsiveness',
] as const;

function isCalendarDate(value: string): boolean {
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1971 || year > 9998) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  const eventLocationId = auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId;
  return { userId, role, auditLocationId, eventLocationId };
}

function auditCtxFor(
  req: IncomingMessage,
  actor: ActorContext,
  httpStatus: number,
): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: httpStatus,
  };
}

function eventMetadata(
  actor: ActorContext,
  occurredAt: string,
): {
  correlation_id: string;
  actor: { user_id: string; role: string; location_id: string };
  occurred_at: string;
} {
  return {
    correlation_id: randomUUID(),
    actor: {
      user_id: actor.userId,
      role: actor.role,
      location_id: actor.eventLocationId,
    },
    occurred_at: occurredAt,
  };
}

interface ScorecardQueryFilters {
  metricKind?: SupplierScorecardMetricRow['metric_kind'] | undefined;
  sinceDate?: string | undefined;
  untilDate?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** Shared query-string validation for both reads. Returns null after sending the 400. */
function parseScorecardFilters(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
): ScorecardQueryFilters | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const filters: ScorecardQueryFilters = {};

  const metricKind = url.searchParams.get('metric_kind');
  if (metricKind !== null) {
    if (!(METRIC_KINDS as readonly string[]).includes(metricKind)) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        `metric_kind must be one of: ${METRIC_KINDS.join(', ')}`,
        { metric_kind: metricKind },
      );
      return null;
    }
    filters.metricKind = metricKind as SupplierScorecardMetricRow['metric_kind'];
  }

  for (const [param, key] of [
    ['since', 'sinceDate'],
    ['until', 'untilDate'],
  ] as const) {
    const value = url.searchParams.get(param);
    if (value !== null) {
      if (!isCalendarDate(value)) {
        sendRequestError(
          req,
          res,
          400,
          'INVALID_PARAMS',
          `${param} must be a valid YYYY-MM-DD calendar date`,
          { [param]: value },
        );
        return null;
      }
      filters[key] = value;
    }
  }

  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    if (!INTEGER_REGEX.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > 200) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be an integer 1-200', {
        limit: limitParam,
      });
      return null;
    }
    filters.limit = Number(limitParam);
  }
  const offsetParam = url.searchParams.get('offset');
  if (offsetParam !== null) {
    if (!INTEGER_REGEX.test(offsetParam) || Number(offsetParam) > 10000) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be an integer 0-10000', {
        offset: offsetParam,
      });
      return null;
    }
    filters.offset = Number(offsetParam);
  }
  return filters;
}

// ---------------------------------------------------------------------------
// GET /api/v1/supplier-scorecards/:supplierId
// ---------------------------------------------------------------------------

export const getSupplierScorecardBase: RouteHandler = async (req, res, params) => {
  const supplierId = params['supplierId'];
  if (!supplierId || !UUID_REGEX.test(supplierId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId must be a UUID', {
      supplier_id: supplierId,
    });
    return;
  }
  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', {
      supplier_id: supplierId,
    });
    return;
  }

  const generatedAt = new Date().toISOString();
  const summary = await getScorecardSummary(supplierId);

  // Default 365-day trend window anchored on the IST calendar (business_date is IST); the series
  // is served newest-first from the projection.
  const since = toIstCalendarDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  const metrics = {} as Record<string, unknown>;
  for (const kind of METRIC_KINDS) {
    const trend = summary?.[kind];
    if (kind === 'quality_acceptance' && trend && 'state' in trend) {
      // AC2: first-class no-data shape - never a fabricated zero, no series attached.
      metrics[kind] = trend;
      continue;
    }
    const series = await listScorecardMetrics({
      supplierId,
      metricKind: kind,
      sinceDate: since,
      limit: 200,
    });
    metrics[kind] = {
      ...(trend as Record<string, unknown>),
      series: series.map((row) => ({
        metric_id: row.metric_id,
        value_num: row.value_num,
        business_date: row.business_date,
        reference_entity_id: row.reference_entity_id,
        context: row.context,
        supersedes_metric_id: row.supersedes_metric_id,
      })),
    };
  }

  sendJson(res, 200, { supplier_id: supplierId, generated_at: generatedAt, metrics });
};

// ---------------------------------------------------------------------------
// GET /api/v1/supplier-scorecards/:supplierId/transactions
// ---------------------------------------------------------------------------

export const listSupplierScorecardTransactionsBase: RouteHandler = async (req, res, params) => {
  const supplierId = params['supplierId'];
  if (!supplierId || !UUID_REGEX.test(supplierId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId must be a UUID', {
      supplier_id: supplierId,
    });
    return;
  }
  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', {
      supplier_id: supplierId,
    });
    return;
  }
  const filters = parseScorecardFilters(req, res);
  if (!filters) return;

  const rows = await listScorecardTransactions(supplierId, filters);
  sendJson(res, 200, { supplier_id: supplierId, row_count: rows.length, transactions: rows });
};

// ---------------------------------------------------------------------------
// POST /api/v1/grns/:grnId/scorecard/on-time (AC1 write path)
// ---------------------------------------------------------------------------

export const recordOnTimeDeliveryMetricBase: RouteHandler = async (req, res, params) => {
  const grnId = params['grnId'];
  if (!grnId || !UUID_REGEX.test(grnId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'grnId must be a UUID', { grn_id: grnId });
    return;
  }
  const grn = await getGrnById(grnId);
  if (!grn) {
    sendRequestError(req, res, 404, 'GRN_NOT_FOUND', 'GRN not found', { grn_id: grnId });
    return;
  }
  if (!grn.po_id) {
    sendRequestError(
      req,
      res,
      409,
      'GRN_NOT_LINKED',
      'GRN must be bound to a native PO before an on-time metric can be recorded',
      { grn_id: grnId },
    );
    return;
  }
  const po = await getPurchaseOrderById(grn.po_id);
  if (!po) {
    sendRequestError(req, res, 404, 'PO_NOT_FOUND', 'Linked PO not found', { po_id: grn.po_id });
    return;
  }
  if (po.status !== 'issued' && po.status !== 'confirmed') {
    sendRequestError(
      req,
      res,
      409,
      'PO_NOT_ISSUED',
      'On-time delivery is only measured against issued or confirmed POs',
      { po_id: po.po_id, status: po.status },
    );
    return;
  }
  // AC1: a PO without a promised date contributes no on-time data - rejected, never a
  // fabricated zero. A receipt that predates confirmation (promised date not yet stamped) is
  // excluded the same way. Read as ::text so the DATE stays a calendar string.
  const promisedDate = await getPoPromisedDateText(po.po_id);
  if (!promisedDate) {
    sendRequestError(
      req,
      res,
      409,
      'PO_PROMISE_DATE_MISSING',
      'The linked PO carries no promised_delivery_date; this receipt is excluded from the on-time metric',
      { po_id: po.po_id },
    );
    return;
  }

  // Signed day delta computed as SQL DATE arithmetic, NUMERIC-as-string end to end.
  const valueNum = await computeSignedDayDelta(grn.business_date, promisedDate);

  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: grn.po_id,
      event_type: 'supplier_scorecard.metric_recorded',
      event_id: randomUUID(),
      payload: {
        metric_id: randomUUID(),
        supplier_id: po.supplier_id,
        metric_kind: 'on_time_delivery',
        reference_event_id: grn.source_event_id,
        reference_entity_id: grn.grn_id,
        value_num: valueNum,
        context: {
          received_date: grn.business_date,
          promised_delivery_date: promisedDate,
          po_id: po.po_id,
          grn_id: grn.grn_id,
        },
        business_date: grn.business_date,
      },
      metadata: eventMetadata(actor, occurredAt),
      idempotency_key: `scorecard-on-time-${grn.grn_id}`,
    },
    auditCtxFor(req, actor, 201),
  );

  sendJson(res, 201, {
    event_id: persisted.event_id,
    supplier_id: po.supplier_id,
    metric_kind: 'on_time_delivery',
    value_num: valueNum,
    grn_id: grn.grn_id,
    po_id: po.po_id,
  });
};

// ---------------------------------------------------------------------------
// POST /api/v1/three-way-match/:matchId/scorecard/price-variance (AC3 write path)
// ---------------------------------------------------------------------------

export const recordPriceVarianceMetricBase: RouteHandler = async (req, res, params) => {
  const matchId = params['matchId'];
  if (!matchId || !UUID_REGEX.test(matchId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'matchId must be a UUID', {
      match_id: matchId,
    });
    return;
  }
  const match = await getMatchById(matchId);
  if (!match) {
    sendRequestError(req, res, 404, 'MATCH_NOT_FOUND', 'Three-way match not found', {
      match_id: matchId,
    });
    return;
  }
  if (match.status !== 'passed' && match.status !== 'blocked') {
    sendRequestError(
      req,
      res,
      409,
      'MATCH_NOT_FINAL',
      'Price variance is measured from passed or blocked matches only',
      { match_id: matchId, status: match.status },
    );
    return;
  }
  const po = await getPurchaseOrderById(match.po_id);
  if (!po) {
    sendRequestError(req, res, 404, 'PO_NOT_FOUND', 'Matched PO not found', {
      po_id: match.po_id,
    });
    return;
  }

  // Mean of the per-line signed price variance, computed in PostgreSQL NUMERIC from the stored
  // variance_detail (AC3). Zero-variance matches contribute '0.000000'; line_count is the count
  // of lines that actually contributed to the mean (invoice_qty > 0), keeping the drill-through
  // context consistent with the arithmetic.
  const variance = await computeMatchPriceVariance(matchId);
  const valueNum = variance?.mean_pct ?? '0.000000';
  const lineCount = variance?.contributing_lines ?? 0;

  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: match.po_id,
      event_type: 'supplier_scorecard.metric_recorded',
      event_id: randomUUID(),
      payload: {
        metric_id: randomUUID(),
        supplier_id: po.supplier_id,
        metric_kind: 'price_variance',
        reference_event_id: match.source_event_id,
        reference_entity_id: match.match_id,
        value_num: valueNum,
        context: {
          variance_pct: valueNum,
          match_id: match.match_id,
          po_id: match.po_id,
          invoice_id: match.invoice_id,
          line_count: lineCount,
        },
        business_date: toIstCalendarDate(new Date(match.recorded_at)),
      },
      metadata: eventMetadata(actor, occurredAt),
      idempotency_key: `scorecard-price-variance-${match.match_id}`,
    },
    auditCtxFor(req, actor, 201),
  );

  sendJson(res, 201, {
    event_id: persisted.event_id,
    supplier_id: po.supplier_id,
    metric_kind: 'price_variance',
    value_num: valueNum,
    match_id: match.match_id,
    po_id: match.po_id,
  });
};

// ---------------------------------------------------------------------------
// POST /api/v1/purchase-orders/:poId/scorecard/responsiveness (AC4 write path)
// ---------------------------------------------------------------------------

export const recordResponsivenessMetricBase: RouteHandler = async (req, res, params) => {
  const poId = params['poId'];
  if (!poId || !UUID_REGEX.test(poId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'poId must be a UUID', { po_id: poId });
    return;
  }
  const po = await getPurchaseOrderById(poId);
  if (!po) {
    sendRequestError(req, res, 404, 'PO_NOT_FOUND', 'PO not found', { po_id: poId });
    return;
  }
  if (po.status !== 'confirmed' || !po.issued_at || !po.confirmed_at) {
    sendRequestError(
      req,
      res,
      409,
      'PO_NOT_CONFIRMED',
      'Responsiveness is measured from confirmed POs carrying both issued_at and confirmed_at',
      { po_id: poId, status: po.status },
    );
    return;
  }

  // The single source of business-day arithmetic (AC4): IST calendar, Monday-Saturday week,
  // configured holidays removed. Integer count crosses the wire as a NUMERIC string.
  const holidays = config.scorecard.responsivenessHolidayCalendar;
  const businessDays = businessDaysBetween(
    new Date(po.issued_at),
    new Date(po.confirmed_at),
    holidays,
  );
  const valueNum = `${businessDays}.000000`;

  // AC7: reference_event_id is the purchase_order.confirmed event that produced the value -
  // purchase_order.source_event_id is stamped once at draft and would point at the wrong event.
  const confirmedEventId = await getPoConfirmedEventId(poId);
  if (!confirmedEventId) {
    sendRequestError(
      req,
      res,
      409,
      'PO_NOT_CONFIRMED',
      'No purchase_order.confirmed event exists for this PO',
      { po_id: poId },
    );
    return;
  }

  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: po.po_id,
      event_type: 'supplier_scorecard.metric_recorded',
      event_id: randomUUID(),
      payload: {
        metric_id: randomUUID(),
        supplier_id: po.supplier_id,
        metric_kind: 'responsiveness',
        reference_event_id: confirmedEventId,
        reference_entity_id: po.po_id,
        value_num: valueNum,
        context: {
          po_id: po.po_id,
          issued_at: po.issued_at,
          confirmed_at: po.confirmed_at,
          business_days: businessDays,
          holiday_count: holidays.length,
        },
        business_date: toIstCalendarDate(new Date(po.confirmed_at)),
      },
      metadata: eventMetadata(actor, occurredAt),
      idempotency_key: `scorecard-responsiveness-${po.po_id}`,
    },
    auditCtxFor(req, actor, 201),
  );

  sendJson(res, 201, {
    event_id: persisted.event_id,
    supplier_id: po.supplier_id,
    metric_kind: 'responsiveness',
    value_num: valueNum,
    po_id: po.po_id,
    business_days: businessDays,
  });
};

/**
 * Story 8.3 (AC 8): the quality-acceptance write route Story 4.2 deliberately left unbuilt. Its
 * source is a qc_lot_disposition row, which is why it could not exist before lot disposition
 * landed.
 *
 * The caller supplies supplier_id: a QC inspection task carries no supplier link (the job-work
 * order that would provide one is Epic 9), so the platform does not invent one. Everything else -
 * the value, the business date and the reference event - is derived from the governed projection
 * here and re-derived under lock by the seam, which rejects a disagreement with
 * SCORECARD_DERIVATION_MISMATCH and a conditional_release or split reference with
 * SCORECARD_REFERENCE_INVALID.
 */
export const recordQualityAcceptanceMetricBase: RouteHandler = async (req, res, params) => {
  const dispositionId = params['dispositionId'];
  if (!dispositionId || !UUID_REGEX.test(dispositionId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'dispositionId must be a UUID', {
      disposition_id: dispositionId,
    });
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const supplierId = body['supplier_id'];
  if (typeof supplierId !== 'string' || !UUID_REGEX.test(supplierId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplier_id must be a UUID', {
      supplier_id: supplierId ?? null,
    });
    return;
  }
  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', {
      supplier_id: supplierId,
    });
    return;
  }
  const disposition = await getQcLotDispositionById(dispositionId);
  if (!disposition) {
    sendRequestError(req, res, 404, 'DISPOSITION_NOT_FOUND', 'Lot disposition not found', {
      disposition_id: dispositionId,
    });
    return;
  }
  if (disposition.disposition !== 'accept' && disposition.disposition !== 'reject') {
    sendRequestError(
      req,
      res,
      409,
      'SCORECARD_REFERENCE_INVALID',
      'Quality acceptance is measured from accept and reject dispositions only',
      { disposition_id: dispositionId, disposition: disposition.disposition },
    );
    return;
  }

  const valueNum = disposition.disposition === 'accept' ? '1.000000' : '0.000000';
  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: disposition.lot_id,
      event_type: 'supplier_scorecard.metric_recorded',
      event_id: randomUUID(),
      payload: {
        metric_id: randomUUID(),
        supplier_id: supplierId,
        metric_kind: 'quality_acceptance',
        reference_event_id: disposition.source_event_id,
        reference_entity_id: disposition.disposition_id,
        value_num: valueNum,
        context: {
          disposition: disposition.disposition,
          disposition_id: disposition.disposition_id,
          lot_id: disposition.lot_id,
          task_id: disposition.task_id,
          quantity: disposition.quantity,
        },
        business_date: toIstCalendarDate(new Date(disposition.decided_at)),
      },
      metadata: eventMetadata(actor, occurredAt),
      idempotency_key: `scorecard-quality-acceptance-${disposition.disposition_id}`,
    },
    auditCtxFor(req, actor, 201),
  );

  // The idempotency key is derived from disposition_id alone, so a replay with a different
  // supplier_id in the body must still report the supplier_id that was actually persisted, not
  // the (discarded) value from this request's body.
  const persistedPayload = persisted.payload as Record<string, unknown>;
  sendJson(res, 201, {
    event_id: persisted.event_id,
    supplier_id: persistedPayload['supplier_id'] as string,
    metric_kind: 'quality_acceptance',
    value_num: persistedPayload['value_num'] as string,
    disposition_id: disposition.disposition_id,
    disposition: disposition.disposition,
  });
};

// ---------------------------------------------------------------------------
// RBAC-wrapped handlers. Reads are procurement/read, writes procurement/write - no role-name
// literal appears anywhere in this file.
// ---------------------------------------------------------------------------

export const getSupplierScorecardHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(getSupplierScorecardBase);

export const listSupplierScorecardTransactionsHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listSupplierScorecardTransactionsBase);

export const recordOnTimeDeliveryMetricHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(recordOnTimeDeliveryMetricBase);

export const recordPriceVarianceMetricHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(recordPriceVarianceMetricBase);

export const recordResponsivenessMetricHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(recordResponsivenessMetricBase);

export const recordQualityAcceptanceMetricHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(recordQualityAcceptanceMetricBase);

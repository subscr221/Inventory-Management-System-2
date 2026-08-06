import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { config } from '../../config/index.js';
import { queryMsmeAgeing, getMsmeAgeingFeedById } from '../../read/projections/msme_ageing.js';
import { isDateString, istCalendarDate, runMsmeComplianceCheck } from '../../compliance/msme.js';

/**
 * Story 4.6: MSME compliance HTTP surface - the classification-tagged ageing report (AC3/AC8),
 * the ERP ageing feed run (AC4), and the daily compliance check (AC5/AC7/AC8). The feed run and
 * daily check are synthetic HTTP triggers (planning-jobs precedent): no cron exists in Phase 1,
 * a real scheduler calls these endpoints later, and tests drive cycles explicitly.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

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

// ---------------------------------------------------------------------------
// GET /api/v1/compliance/msme/ageing?as_of=YYYY-MM-DD
// ---------------------------------------------------------------------------

export const msmeAgeingReportBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const asOfParam = url.searchParams.get('as_of');
  if (asOfParam !== null && !isDateString(asOfParam)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'as_of must be a YYYY-MM-DD calendar date', {
      as_of: asOfParam,
    });
    return;
  }
  const asOf = asOfParam ?? istCalendarDate(new Date().toISOString());

  const rows = await queryMsmeAgeing(asOf, config.msme.interestRatePercentAnnual);
  sendJson(res, 200, {
    as_of: asOf,
    rule_version: config.msme.ruleVersion,
    interest_rate_percent_annual: config.msme.interestRatePercentAnnual,
    row_count: rows.length,
    rows,
  });
};

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/msme/ageing-feed/run
// ---------------------------------------------------------------------------

export const runMsmeAgeingFeedBase: RouteHandler = async (req, res, _params) => {
  const actor = actorContext(req);
  const generatedAt = new Date().toISOString();
  const asOf = istCalendarDate(generatedAt);

  // The applier re-derives the ageing and inserts the ledger row inside the persistEvent
  // transaction; this pre-count only fills the event payload's row_count.
  const rows = await queryMsmeAgeing(asOf, config.msme.interestRatePercentAnnual);
  const feedId = randomUUID();

  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: feedId,
      event_type: 'msme_ageing_feed.recorded',
      event_id: randomUUID(),
      payload: {
        feed_id: feedId,
        row_count: rows.length,
        generated_at: generatedAt,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: generatedAt,
      },
    },
    auditCtxFor(req, actor, 201),
  );

  const feed = await getMsmeAgeingFeedById(feedId);
  sendJson(res, 201, {
    event_id: persisted.event_id,
    feed_id: feedId,
    row_count: feed?.row_count ?? rows.length,
    recorded_at: feed?.recorded_at ?? null,
  });
};

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/msme/daily-check
// ---------------------------------------------------------------------------

export const runMsmeDailyCheckBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const businessDateRaw = body['business_date'];
  if (businessDateRaw !== undefined && !isDateString(businessDateRaw)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'business_date must be a YYYY-MM-DD calendar date',
      { business_date: businessDateRaw },
    );
    return;
  }
  const businessDate =
    (businessDateRaw as string | undefined) ?? istCalendarDate(new Date().toISOString());

  const actor = actorContext(req);
  const result = await runMsmeComplianceCheck({
    business_date: businessDate,
    actor: {
      user_id: actor.userId,
      role: actor.role,
      location_id: actor.eventLocationId,
    },
    auditCtx: auditCtxFor(req, actor, 200),
  });
  sendJson(res, 200, result);
};

export const msmeAgeingReportHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(msmeAgeingReportBase);

export const runMsmeAgeingFeedHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(runMsmeAgeingFeedBase);

export const runMsmeDailyCheckHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(runMsmeDailyCheckBase);

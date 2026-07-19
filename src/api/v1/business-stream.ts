import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import {
  createTaggingRule,
  findConflictingRule,
  findActiveTaggingRule,
  listBusinessStreams,
} from '../../read/projections/business_stream_config.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Sentinel used ONLY for the domain-event envelope's actor.location_id when the acting admin's
// authorizing assignment is enterprise-wide ('*'), which is not a UUID. The audit_log.location_id
// (TEXT) has no such constraint, so it records the real '*' assignment value. Duplicated from
// src/api/v1/doa.ts (the Story 1.4 source of this pattern) rather than extracted, to avoid
// touching reviewed 1.4 code; if a third consumer appears, extract to a shared module then.
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

interface ActorContext {
  userId: string;
  role: string;
  /** The authorizing assignment's location as-is ('*' or a UUID) - used for the audit log row. */
  auditLocationId: string;
  /** UUID-safe location for the domain-event envelope actor ('*' becomes the zero-UUID sentinel). */
  eventLocationId: string;
}

/** Derives the acting admin's identity from the server's own auth/RBAC decision, never the body. */
function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  const eventLocationId = auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId;
  return { userId, role, auditLocationId, eventLocationId };
}

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): WriteAuditCtx {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidStringLength(value: string, maxLength: number = 256): boolean {
  return value.length <= maxLength;
}

function isValidDateString(value: string): boolean {
  if (!DATE_REGEX.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().startsWith(value);
}

// -----------------------------------------------------------------------------------------------
// Task 3.1 - POST /api/v1/business-streams/rules
//
// Creates a dated tagging-applicability rule. There is deliberately NO PATCH/DELETE for rules:
// they are dated configuration ("statutory thresholds as dated configuration files, not
// hard-coded" - ARCHITECTURE-SPINE Consistency Conventions). Correcting a rule means adding a new
// rule with a new effective_from; end-dating or soft-delete is a future compliance-admin-console
// concern, not this story's. Do not add a silent mutation path here.
// -----------------------------------------------------------------------------------------------
const createTaggingRuleBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['transaction_type'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transaction_type is required and must be a non-empty string');
    return;
  }
  if (!isValidStringLength(body['transaction_type'], 256)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transaction_type must not exceed 256 characters');
    return;
  }
  const costCentreRequired = body['cost_centre_required'] ?? false;
  const projectCodeRequired = body['project_code_required'] ?? false;
  if (typeof costCentreRequired !== 'boolean' || typeof projectCodeRequired !== 'boolean') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cost_centre_required and project_code_required must be booleans');
    return;
  }
  if (!isNonEmptyString(body['effective_from']) || !isValidDateString(body['effective_from'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'effective_from is required and must be a valid YYYY-MM-DD date');
    return;
  }
  const effectiveFrom = body['effective_from'];
  let effectiveTo: string | null = null;
  if (body['effective_to'] !== undefined && body['effective_to'] !== null) {
    if (!isNonEmptyString(body['effective_to']) || !isValidDateString(body['effective_to'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'effective_to must be a valid YYYY-MM-DD date or null');
      return;
    }
    if (body['effective_to'] < effectiveFrom) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'effective_to must not be before effective_from');
      return;
    }
    effectiveTo = body['effective_to'];
  }
  const transactionType = body['transaction_type'];

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`transaction_tagging_rules:${transactionType}`]);

    const conflict = await findConflictingRule(transactionType, effectiveFrom, effectiveTo, client);
    if (conflict) {
      await client.query('ROLLBACK');
      sendRequestError(
        req,
        res,
        409,
        'TAGGING_RULE_CONFLICT',
        `An existing rule (${conflict.rule_id}) for "${transactionType}" overlaps the requested date range`,
        { conflicting_rule_id: conflict.rule_id, effective_from: conflict.effective_from, effective_to: conflict.effective_to },
      );
      return;
    }

    const rule = await createTaggingRule(
      {
        transaction_type: transactionType,
        cost_centre_required: costCentreRequired,
        project_code_required: projectCodeRequired,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
      },
      client,
    );
    await persistEvent(
      {
        stream_type: 'business_stream_config',
        stream_id: rule.rule_id,
        event_type: 'business_stream_config.rule_created',
        payload: { rule },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    await client.query('COMMIT');
    sendJson(res, 201, rule);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// Task 3.2 - GET /api/v1/business-streams/rules?transaction_type=&as_of_date=
// -----------------------------------------------------------------------------------------------
const getTaggingRuleBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const transactionType = url.searchParams.get('transaction_type');
  const asOfDateRaw = url.searchParams.get('as_of_date');

  if (!transactionType) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transaction_type query parameter is required');
    return;
  }
  let asOfDate: string | undefined;
  if (asOfDateRaw !== null) {
    if (!isValidDateString(asOfDateRaw)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'as_of_date must be a valid YYYY-MM-DD date');
      return;
    }
    asOfDate = asOfDateRaw;
  }

  const rule = await findActiveTaggingRule(transactionType, asOfDate);
  if (!rule) {
    sendRequestError(req, res, 404, 'NOT_FOUND', `No tagging rule is effective for "${transactionType}"`);
    return;
  }
  sendJson(res, 200, rule);
};

// -----------------------------------------------------------------------------------------------
// Task 3.3 - GET /api/v1/business-streams
// -----------------------------------------------------------------------------------------------
const listBusinessStreamsBase: RouteHandler = async (_req, res, _params) => {
  const streams = await listBusinessStreams();
  sendJson(res, 200, { streams });
};

export const createTaggingRuleHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'write' })(createTaggingRuleBase);
export const getTaggingRuleHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'read' })(getTaggingRuleBase);
export const listBusinessStreamsHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'read' })(listBusinessStreamsBase);

import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';
import {
  listNotificationsForUser,
  countUnreadForUser,
  markNotificationRead,
  markNotificationActedUpon,
  getNotification,
  listPreferencesForUser,
  setPreference,
  upsertPushSubscription,
  deletePushSubscription,
  resolveEscalationDef,
} from '../../read/projections/notification.js';
import type { NotificationStatus } from '../../read/projections/notification.js';

// EXPERIENCE.md section 13.2, Table 2. Preferences for event types outside this list may still
// exist (any module can emitNotification() with a new event_type) - GET merges these known
// defaults with whatever rows the user already has, it does not restrict which types can be set.
const KNOWN_EVENT_TYPES = ['approval_received', 'goods_received', 'sync_complete', 'qc_hold_placed'];

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? '';
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  return { userId, role, auditLocationId };
}

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): WriteAuditCtx {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'GET',
    http_status: httpStatus,
  };
}

function isValidStatus(value: string | null): value is NotificationStatus {
  return value === 'created' || value === 'read' || value === 'acted_upon' || value === 'expired';
}

const listNotificationsBase: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const status = url.searchParams.get('status');
  if (status !== null && !isValidStatus(status)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of created, read, acted_upon, expired');
    return;
  }
  const limitRaw = url.searchParams.get('limit');
  let limit = 50;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be a positive integer');
      return;
    }
    limit = Math.min(parsed, 200);
  }
  const offsetRaw = url.searchParams.get('offset');
  let offset = 0;
  if (offsetRaw !== null) {
    const parsed = Number(offsetRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'offset must be a non-negative integer');
      return;
    }
    offset = parsed;
  }

  const notifications = await listNotificationsForUser(actor.userId, {
    eventType: url.searchParams.get('type') ?? undefined,
    status: status ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
    limit,
    offset,
  });
  sendJson(res, 200, { notifications });
};

const getUnreadCountBase: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  const count = await countUnreadForUser(actor.userId);
  sendJson(res, 200, { unread_count: count });
};

const VALID_ACTIONS = new Set(['read', 'acted_upon']);

const updateNotificationBase: RouteHandler = async (req, res, params) => {
  const notificationId = params['id'];
  if (!notificationId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'notification id is required');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const action = body?.['action'];
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'action must be "read" or "acted_upon"');
    return;
  }

  const actor = actorContext(req);
  const existing = await getNotification(notificationId);
  if (!existing || existing.target_user_id !== actor.userId) {
    throw new AppError(404, 'NOT_FOUND', `No notification "${notificationId}" for this user`);
  }

  const updated =
    action === 'read' ? await markNotificationRead(notificationId, actor.userId) : await markNotificationActedUpon(notificationId, actor.userId);
  if (!updated) {
    throw new AppError(409, 'INVALID_STATE_TRANSITION', `Notification "${notificationId}" cannot transition to "${action}" from its current status`);
  }
  sendJson(res, 200, updated);
};

const acknowledgeNotificationBase: RouteHandler = async (req, res, params) => {
  const notificationId = params['id'];
  if (!notificationId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'notification id is required');
    return;
  }
  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await getNotification(notificationId, client);
    if (!existing || existing.target_user_id !== actor.userId) {
      throw new AppError(404, 'NOT_FOUND', `No notification "${notificationId}" for this user`);
    }

    const acted = await markNotificationActedUpon(notificationId, actor.userId, client);
    // Acknowledgment resolves the escalation clock for the WHOLE alert (any one recipient
    // acknowledging is sufficient - AC2), not just this recipient's own notification row.
    const escalationResolved = await resolveEscalationDef(existing.source_event_id, client);

    await logAuditEntry(client, {
      ...auditCtxFor(req, actor, 200),
      event_id: null,
      error_code: null,
      details: { notification_id: notificationId, source_event_id: existing.source_event_id, escalation_resolved: escalationResolved },
    });

    await client.query('COMMIT');
    sendJson(res, 200, { notification: acted ?? existing, escalation_resolved: escalationResolved });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getPreferencesBase: RouteHandler = async (req, res) => {
  const actor = actorContext(req);
  const existing = await listPreferencesForUser(actor.userId);
  const byType = new Map(existing.map((p) => [p.event_type, p.opted_in]));
  const merged = new Set([...KNOWN_EVENT_TYPES, ...byType.keys()]);
  const preferences = Array.from(merged).map((eventType) => ({
    event_type: eventType,
    // Opt-in by default off (DPDP/GDPR - EXPERIENCE.md section 10) when no row exists yet.
    opted_in: byType.get(eventType) ?? false,
  }));
  sendJson(res, 200, { preferences });
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const putPreferencesBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['event_type']) || typeof body['opted_in'] !== 'boolean') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'event_type (string) and opted_in (boolean) are required');
    return;
  }
  const actor = actorContext(req);
  await setPreference(actor.userId, body['event_type'], body['opted_in']);
  sendJson(res, 200, { event_type: body['event_type'], opted_in: body['opted_in'] });
};

const createPushSubscriptionBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const keys = body?.['keys'] as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['endpoint']) || !keys || !isNonEmptyString(keys['p256dh']) || !isNonEmptyString(keys['auth'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'endpoint and keys.p256dh/keys.auth are required (standard PushSubscription JSON shape)');
    return;
  }
  const actor = actorContext(req);
  const subscription = await upsertPushSubscription(actor.userId, body['endpoint'], keys['p256dh'] as string, keys['auth'] as string);
  sendJson(res, 201, subscription);
};

const deletePushSubscriptionBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'endpoint query parameter is required');
    return;
  }
  const actor = actorContext(req);
  const deleted = await deletePushSubscription(actor.userId, endpoint);
  sendJson(res, 200, { deleted });
};

export const listNotificationsHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'read' })(listNotificationsBase);
export const getUnreadCountHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'read' })(getUnreadCountBase);
export const updateNotificationHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'write' })(updateNotificationBase);
export const acknowledgeNotificationHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'write' })(
  acknowledgeNotificationBase,
);
export const getPreferencesHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'read' })(getPreferencesBase);
export const putPreferencesHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'write' })(putPreferencesBase);
export const createPushSubscriptionHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'write' })(
  createPushSubscriptionBase,
);
export const deletePushSubscriptionHandler: RouteHandler = requireRole({ module: 'notification', functionScope: 'write' })(
  deletePushSubscriptionBase,
);

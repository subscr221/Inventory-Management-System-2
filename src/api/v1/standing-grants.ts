import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import {
  requireRole,
  permittedLocationsForModuleScope,
  EMPLOYEE_MODULE,
} from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import { getPool } from '../../config/db.js';
import { toIstCalendarDate } from '../../lib/business-days.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';
import {
  getGrantById,
  getGrantLabel,
  lastIssueAt,
  lastLimitUseAt,
  listGrants,
  listPendingFinanceSites,
  monthToDateIssued,
  standingApprovalText,
  upsertPruneInterval,
  getPruneSetting,
  type StandingGrantRow,
} from '../../read/projections/standing_grant.js';
import { getItemGroupByCode } from '../../read/projections/item_group.js';
import { isResolvedFinanceApprover } from '../../compliance/standing-grant.js';

/**
 * Story 4.8 (Task 3): the standing approval and self-approval limit routes. Online only (D11):
 * assign, finance decision and revoke are server calls that persist one standing_grant event each;
 * every authority and separation-of-duties guard lives in the compliance seam
 * (src/compliance/standing-grant.ts), so this file shapes requests and responses only.
 *
 * Gate: the base `employee` hat or `procurement`, because the right to assign or decide comes from
 * the DOA registry (D3), not from a module. A caller with no authority gets the seam's precise
 * 403 (GRANT_ASSIGNER_NOT_AUTHORIZED, GRANT_FINANCE_NOT_RESOLVED), not a generic module denial.
 * No response words a grant as "No approval required" or grades a person (EXPERIENCE.md voice table).
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PRUNE_INTERVAL_DAYS = 365;

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

function bodyObject(req: IncomingMessage): Record<string, unknown> {
  const body = getParsedBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'INVALID_PARAMS', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export interface GrantView extends StandingGrantRow {
  grantee_name: string;
  scope_label: string;
  standing_approval_text: string | null;
}

async function toView(grant: StandingGrantRow): Promise<GrantView> {
  const label = await getGrantLabel(grant);
  return {
    ...grant,
    grantee_name: label.grantee_name,
    scope_label: label.scope_label,
    standing_approval_text:
      grant.grant_kind === 'standing_approval'
        ? standingApprovalText(grant.grant_ref, label.grantee_name, label.scope_label)
        : null,
  };
}

async function loadOr404(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  id: string | undefined,
): Promise<StandingGrantRow | null> {
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'grant id must be a UUID');
    return null;
  }
  const grant = await getGrantById(id);
  if (!grant) {
    sendRequestError(req, res, 404, 'GRANT_NOT_FOUND', 'Standing grant not found', {
      grant_id: id,
    });
    return null;
  }
  return grant;
}

/** One lifecycle event on an existing grant, then the refreshed grant. */
async function persistDecision(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  grant: StandingGrantRow,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const actor = actorContext(req);
  const persisted = await persistEvent(
    {
      stream_type: 'standing_grant',
      stream_id: grant.grant_id,
      event_type: eventType,
      event_id: randomUUID(),
      payload: { grant_id: grant.grant_id, ...payload },
      metadata: {
        correlation_id: grant.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 200),
  );
  const refreshed = await getGrantById(grant.grant_id);
  sendJson(res, 200, {
    event_id: persisted.event_id,
    grant: refreshed ? await toView(refreshed) : null,
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/standing-grants
// ---------------------------------------------------------------------------

export const assignGrantBase: RouteHandler = async (req, res, _params) => {
  const body = bodyObject(req);
  const actor = actorContext(req);
  const kind = body['grant_kind'] ?? 'standing_approval';

  const payload: Record<string, unknown> = {
    grant_kind: kind,
    grantee_user_id: body['grantee_user_id'],
    site_id: body['site_id'],
  };
  if (body['scope_sku'] !== undefined) payload['scope_sku'] = body['scope_sku'];
  if (body['scope_item_group_id'] !== undefined) {
    payload['scope_item_group_id'] = body['scope_item_group_id'];
  }
  if (typeof body['scope_item_group_code'] === 'string') {
    const group = await getItemGroupByCode(body['scope_item_group_code'].trim());
    if (!group) {
      throw new AppError(400, 'GRANT_SCOPE_INVALID', 'No item group has that code', {
        scope_item_group_code: body['scope_item_group_code'],
      });
    }
    payload['scope_item_group_id'] = group.item_group_id;
  }
  if (body['monthly_qty_cap'] !== undefined) payload['monthly_qty_cap'] = body['monthly_qty_cap'];
  if (body['limit_amount'] !== undefined) payload['limit_amount'] = body['limit_amount'];
  if (body['end_date'] !== undefined) payload['end_date'] = body['end_date'];

  const grantId = randomUUID();
  const persisted = await persistEvent(
    {
      stream_type: 'standing_grant',
      stream_id: grantId,
      event_type: 'standing_grant.assigned',
      event_id: randomUUID(),
      payload: { grant_id: grantId, ...payload },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 201),
  );
  const created = await getGrantById(grantId);
  sendJson(res, 201, {
    event_id: persisted.event_id,
    grant: created ? await toView(created) : null,
  });
};

export const financeApproveGrantBase: RouteHandler = async (req, res, params) => {
  const grant = await loadOr404(req, res, params?.['id']);
  if (!grant) return;
  await persistDecision(req, res, grant, 'standing_grant.finance_approved', {});
};

export const financeRejectGrantBase: RouteHandler = async (req, res, params) => {
  const grant = await loadOr404(req, res, params?.['id']);
  if (!grant) return;
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  await persistDecision(req, res, grant, 'standing_grant.finance_rejected', {
    reason: body?.['reason'],
  });
};

/** The assigner revokes alone and instantly: no second approver (AC 5). */
export const revokeGrantBase: RouteHandler = async (req, res, params) => {
  const grant = await loadOr404(req, res, params?.['id']);
  if (!grant) return;
  await persistDecision(req, res, grant, 'standing_grant.revoked', { revoke_reason: 'assigner' });
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listGrantsBase: RouteHandler = async (req, res, _params) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const assignedBy = url.searchParams.get('assigned_by');
  const heldBy = url.searchParams.get('held_by');
  const pendingFinance = url.searchParams.get('pending_finance');
  const chosen = [assignedBy, heldBy, pendingFinance].filter((v) => v !== null);
  if (chosen.length !== 1 || chosen[0] !== 'me') {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'Pass exactly one of assigned_by=me, held_by=me or pending_finance=me',
    );
  }
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  if (limitParam && (!Number.isInteger(limit) || limit! <= 0)) {
    throw new AppError(400, 'INVALID_PARAMS', 'limit must be a positive integer');
  }

  let grants: StandingGrantRow[];
  if (assignedBy) {
    grants = await listGrants({ assignedBy: authContext.userId, ...(limit ? { limit } : {}) });
  } else if (heldBy) {
    grants = await listGrants({ heldBy: authContext.userId, ...(limit ? { limit } : {}) });
  } else {
    // Only grants this caller could decide: pending, at a site where they resolve as finance.
    const today = toIstCalendarDate(new Date());
    const siteIds: string[] = [];
    for (const siteId of await listPendingFinanceSites()) {
      if (await isResolvedFinanceApprover(authContext.userId, siteId, today)) siteIds.push(siteId);
    }
    grants = await listGrants({
      pendingFinance: true,
      siteIds,
      excludePartyUserId: authContext.userId,
      ...(limit ? { limit } : {}),
    });
  }
  sendJson(res, 200, { grants: await Promise.all(grants.map(toView)) });
};

/** Read access: the assigner, the grantee, a finance approver of the site, or a procurement reader. */
async function assertGrantReadAccess(req: IncomingMessage, grant: StandingGrantRow): Promise<void> {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (
    authContext.userId === grant.assigner_user_id ||
    authContext.userId === grant.grantee_user_id
  ) {
    return;
  }
  const scope = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');
  if (scope.wildcard || scope.locations.has(grant.site_id)) return;
  if (
    await isResolvedFinanceApprover(
      authContext.userId,
      grant.site_id,
      toIstCalendarDate(new Date()),
    )
  ) {
    return;
  }
  throw new AppError(403, 'FUNCTION_ACCESS_DENIED', 'You cannot view this grant', {
    grant_id: grant.grant_id,
  });
}

export const getGrantBase: RouteHandler = async (req, res, params) => {
  const grant = await loadOr404(req, res, params?.['id']);
  if (!grant) return;
  await assertGrantReadAccess(req, grant);
  const view = await toView(grant);
  const month = toIstCalendarDate(new Date()).slice(0, 7);
  const usage =
    grant.grant_kind === 'standing_approval'
      ? {
          cap: grant.monthly_qty_cap,
          month,
          month_to_date_issued: await monthToDateIssued(grant.grant_id, month),
          last_used_at: await lastIssueAt(grant.grant_id),
        }
      : { limit_amount: grant.limit_amount, last_used_at: await lastLimitUseAt(grant.grant_id) };
  sendJson(res, 200, { grant: view, usage });
};

// ---------------------------------------------------------------------------
// PUT /api/v1/standing-grants/prune-setting
// ---------------------------------------------------------------------------

export const putPruneSettingBase: RouteHandler = async (req, res, _params) => {
  const body = bodyObject(req);
  const days = body['prune_interval_days'];
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > MAX_PRUNE_INTERVAL_DAYS
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `prune_interval_days must be a whole number of days from 1 to ${MAX_PRUNE_INTERVAL_DAYS}`,
    );
  }
  const actor = actorContext(req);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await upsertPruneInterval(actor.userId, days, client);
    await logAuditEntry(client, {
      ...auditCtxFor(req, actor, 200),
      event_id: null,
      error_code: 'standing_grant.prune_setting_changed',
      details: { assigner_user_id: actor.userId, prune_interval_days: days },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  sendJson(res, 200, { setting: await getPruneSetting(actor.userId) });
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const assignGrantHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'write',
  locationId: (_params, body) => {
    const siteId = (body as Record<string, unknown> | undefined)?.['site_id'];
    return typeof siteId === 'string' && UUID_REGEX.test(siteId) ? siteId : undefined;
  },
})(assignGrantBase);

export const financeApproveGrantHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'write',
})(financeApproveGrantBase);

export const financeRejectGrantHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'write',
})(financeRejectGrantBase);

export const revokeGrantHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'write',
})(revokeGrantBase);

export const listGrantsHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'read',
})(listGrantsBase);

export const getGrantHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'read',
})(getGrantBase);

export const putPruneSettingHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'write',
})(putPruneSettingBase);

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import type { AuthContext } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import {
  ITEM_GROUP_CODE_REGEX,
  ITEM_GROUP_STATUSES,
  addItemGroupRecipient,
  createItemGroup,
  deleteItemGroupIfNeverUsed,
  getItemGroupByCode,
  getItemGroupRightRow,
  getItemGroupRights,
  listActiveItemsByGroup,
  listItemGroupRecipients,
  listItemGroupRights,
  listItemGroups,
  listUngroupedActiveItems,
  removeItemGroupRecipient,
  updateItemGroup,
  upsertItemGroupRights,
} from '../../read/projections/item_group.js';
import type {
  ItemGroup,
  ItemGroupRightRow,
  ItemGroupRights,
  ItemGroupStatus,
} from '../../read/projections/item_group.js';
import {
  ITEM_GROUP_GRANTOR_ROLES,
  ITEM_GROUP_MAINTAINER_ROLE,
  assertHoldsAnyRole,
  assertItemGroupRight,
  notifyItemGroupChange,
} from '../../compliance/item-group-authority.js';

// Same sentinel as src/api/v1/items.ts: the event envelope's actor.location_id must be a UUID even
// when the authorizing assignment is enterprise-wide ('*').
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

/**
 * The audit row and the event envelope should name the role the action actually belongs to. The
 * inventory write gate can authorize a `warehouse_manager` assignment for a caller who also holds
 * `inventory_controller`, and attributing an item group change to `warehouse_manager` would
 * misreport who did it. So the authorized assignment is used when its role is one of
 * `preferredRoles` (its location is then the one the gate actually checked); otherwise the first
 * assignment holding a preferred role is used. Routes with no module gate (rights and recipients)
 * carry no authorized assignment and rely on that second lookup. There is deliberately no
 * fallback to an arbitrary role: attributing to an unrelated role is worse than the gate's own.
 */
function actorContext(req: IncomingMessage, preferredRoles: readonly string[] = []): ActorContext {
  const authContext = getAuthContext(req);
  const authorized = getAuthorizedAssignment(req) ?? undefined;
  const assignment =
    authorized && preferredRoles.includes(authorized.role)
      ? authorized
      : (authContext?.roles.find((r) => preferredRoles.includes(r.role)) ?? authorized);
  const auditLocationId = assignment?.locationId ?? '*';
  return {
    userId: authContext?.userId ?? NO_LOCATION_UUID,
    role: assignment?.role ?? '',
    auditLocationId,
    eventLocationId: auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId,
  };
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

function requireAuth(req: IncomingMessage): AuthContext {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  return authContext;
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  return typeof err === 'object' && err !== null
    ? (err as { code?: string; constraint?: string })
    : {};
}

/** Name of the violated UNIQUE constraint (23505), or null. */
function constraintOf(err: unknown): string | null {
  const e = pgError(err);
  return e.code === '23505' ? (e.constraint ?? null) : null;
}

/**
 * Name of the violated CHECK constraint (23514), or null. chk_item_group_code, _name and _status
 * are reachable from a request body, so they are bad input (400), not a server fault (500).
 */
function checkViolationOf(err: unknown): string | null {
  const e = pgError(err);
  return e.code === '23514' ? (e.constraint ?? null) : null;
}

/** True when `err` is a foreign key violation (23503) on the named constraint. */
function isForeignKeyViolation(err: unknown, constraint: string): boolean {
  const e = pgError(err);
  return e.code === '23503' && e.constraint === constraint;
}

/**
 * Runs `work` in one transaction (BEGIN, COMMIT, ROLLBACK on any error). The ROLLBACK is itself
 * guarded: on a dropped connection it rejects, and the original error is the one worth reporting.
 */
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('item group ROLLBACK failed (original error is rethrown):', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

function eventMetadata(actor: ActorContext, correlationId: string) {
  return {
    correlation_id: correlationId,
    actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
    occurred_at: new Date().toISOString(),
  };
}

function notifyActor(actor: ActorContext) {
  return { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId };
}

function bodyObject(req: IncomingMessage): Record<string, unknown> {
  const body = getParsedBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'INVALID_PARAMS', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 120) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'name must be a non-empty string of at most 120 characters',
    );
  }
  return value.trim();
}

/**
 * A code that cannot name a group is bad input (400 INVALID_PARAMS), the same answer create gives
 * for the same string; 404 ITEM_GROUP_NOT_FOUND is reserved for a well-formed code that is unknown,
 * so a caller can tell the two apart. The rejected value is reported in details, not interpolated.
 */
function parseCodeParam(params: Record<string, string>): string {
  const code = params['code'];
  if (!code || !ITEM_GROUP_CODE_REGEX.test(code)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'code must be 2-32 characters of A-Z, 0-9, "_" or "-", starting with a letter or digit',
      { code: code ?? null },
    );
  }
  return code;
}

async function requireGroup(
  code: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<ItemGroup> {
  const group = await getItemGroupByCode(code, client, forUpdate);
  if (!group) {
    throw new AppError(404, 'ITEM_GROUP_NOT_FOUND', `No item group exists for code "${code}"`, {
      code,
    });
  }
  return group;
}

// -----------------------------------------------------------------------------------------------
// Groups
// -----------------------------------------------------------------------------------------------

const listUngroupedBase: RouteHandler = async (_req, res) => {
  const items = await listUngroupedActiveItems();
  sendJson(res, 200, { items, count: items.length });
};

const listGroupsBase: RouteHandler = async (_req, res) => {
  sendJson(res, 200, { item_groups: await listItemGroups() });
};

const getGroupBase: RouteHandler = async (_req, res, params) => {
  sendJson(res, 200, await requireGroup(parseCodeParam(params)));
};

const listGroupItemsBase: RouteHandler = async (_req, res, params) => {
  const group = await requireGroup(parseCodeParam(params));
  sendJson(res, 200, {
    item_group: group,
    items: await listActiveItemsByGroup(group.item_group_id),
  });
};

const createGroupBase: RouteHandler = async (req, res) => {
  const authContext = requireAuth(req);
  const body = bodyObject(req);
  const code = body['code'];
  if (typeof code !== 'string' || !ITEM_GROUP_CODE_REGEX.test(code)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'code must be 2-32 characters of A-Z, 0-9, "_" or "-", starting with a letter or digit',
    );
  }
  const name = parseName(body['name']);
  const actor = actorContext(req, [ITEM_GROUP_MAINTAINER_ROLE]);
  try {
    const group = await inTransaction(async (client) => {
      await assertItemGroupRight(authContext, 'create', client);
      const created = await createItemGroup({ code, name }, client);
      const correlationId = randomUUID();
      await persistEvent(
        {
          stream_type: 'item_group',
          stream_id: created.item_group_id,
          event_type: 'item_group.created',
          payload: { item_group: created },
          metadata: eventMetadata(actor, correlationId),
        },
        auditCtxFor(req, actor, 201),
        client,
      );
      await notifyItemGroupChange(client, {
        actor: notifyActor(actor),
        status_verb: 'Created',
        object_type: 'item_group',
        object_id: created.code,
        correlation_id: correlationId,
      });
      return created;
    });
    sendJson(res, 201, group);
  } catch (err) {
    const constraint = constraintOf(err);
    if (constraint === 'uq_item_group_code') {
      throw new AppError(
        409,
        'DUPLICATE_ITEM_GROUP_CODE',
        `Item group code "${code}" already exists`,
        {
          code,
        },
      );
    }
    if (constraint === 'uq_item_group_name_ci') {
      throw new AppError(
        409,
        'DUPLICATE_ITEM_GROUP_NAME',
        `Item group name "${name}" already exists`,
        {
          name,
        },
      );
    }
    const check = checkViolationOf(err);
    if (check) {
      throw new AppError(400, 'INVALID_PARAMS', 'Item group code or name is not acceptable', {
        constraint: check,
      });
    }
    throw err;
  }
};

function isGroupStatus(value: unknown): value is ItemGroupStatus {
  return typeof value === 'string' && (ITEM_GROUP_STATUSES as readonly string[]).includes(value);
}

const updateGroupBase: RouteHandler = async (req, res, params) => {
  const authContext = requireAuth(req);
  const code = parseCodeParam(params);
  const body = bodyObject(req);
  const unknownKeys = Object.keys(body).filter((k) => k !== 'name' && k !== 'status');
  if (unknownKeys.length > 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'Only name and status may be changed', {
      rejected_fields: unknownKeys,
    });
  }
  const patch: { name?: string; status?: ItemGroupStatus } = {};
  if (body['name'] !== undefined) patch.name = parseName(body['name']);
  if (body['status'] !== undefined) {
    if (!isGroupStatus(body['status'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'status must be one of active, inactive');
    }
    patch.status = body['status'];
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'At least one of name or status is required');
  }
  const actor = actorContext(req, [ITEM_GROUP_MAINTAINER_ROLE]);
  try {
    const after = await inTransaction(async (client) => {
      await assertItemGroupRight(authContext, 'edit', client);
      // Locked: without FOR UPDATE a concurrent delete between the read and the update makes
      // updateItemGroup return null, and the status comparison below then throws a TypeError 500.
      const before = await requireGroup(code, client, true);
      const updated = await updateItemGroup(code, patch, client);
      if (!updated) {
        throw new AppError(404, 'ITEM_GROUP_NOT_FOUND', `No item group exists for code "${code}"`, {
          code,
        });
      }
      const correlationId = randomUUID();
      await persistEvent(
        {
          stream_type: 'item_group',
          stream_id: before.item_group_id,
          event_type: 'item_group.updated',
          payload: { item_group_id: before.item_group_id, code, before, after: updated },
          metadata: eventMetadata(actor, correlationId),
        },
        auditCtxFor(req, actor, 200),
        client,
      );
      let verb = 'Updated';
      if (before.status === 'active' && updated.status === 'inactive') verb = 'Deactivated';
      else if (before.status === 'inactive' && updated.status === 'active') verb = 'Reactivated';
      await notifyItemGroupChange(client, {
        actor: notifyActor(actor),
        status_verb: verb,
        object_type: 'item_group',
        object_id: code,
        correlation_id: correlationId,
      });
      return updated;
    });
    sendJson(res, 200, after);
  } catch (err) {
    if (constraintOf(err) === 'uq_item_group_name_ci') {
      throw new AppError(409, 'DUPLICATE_ITEM_GROUP_NAME', 'Item group name already exists', {
        name: patch.name ?? null,
      });
    }
    const check = checkViolationOf(err);
    if (check) {
      throw new AppError(400, 'INVALID_PARAMS', 'Item group name or status is not acceptable', {
        constraint: check,
      });
    }
    throw err;
  }
};

const deleteGroupBase: RouteHandler = async (req, res, params) => {
  const authContext = requireAuth(req);
  const code = parseCodeParam(params);
  const actor = actorContext(req, [ITEM_GROUP_MAINTAINER_ROLE]);
  const inUse = () =>
    new AppError(
      409,
      'ITEM_GROUP_IN_USE',
      `Item group ${code} has had items assigned; deactivate it instead`,
      { code },
    );
  await inTransaction(async (client) => {
    await assertItemGroupRight(authContext, 'delete', client);
    await requireGroup(code, client, true);
    // ever_assigned is the fast path (D9), but any row that reached item_master.item_group_id
    // without going through the assignment handler (a restored dump, a projection replay) leaves
    // the flag false, and the FK RESTRICT then raises 23503. Both mean the same thing to a caller.
    let deleted;
    try {
      deleted = await deleteItemGroupIfNeverUsed(code, client);
    } catch (err) {
      if (isForeignKeyViolation(err, 'fk_item_master_item_group')) throw inUse();
      throw err;
    }
    if (!deleted) {
      throw inUse();
    }
    const correlationId = randomUUID();
    await persistEvent(
      {
        stream_type: 'item_group',
        stream_id: deleted.item_group_id,
        event_type: 'item_group.deleted',
        payload: { item_group_id: deleted.item_group_id, code, before: deleted },
        metadata: eventMetadata(actor, correlationId),
      },
      auditCtxFor(req, actor, 204),
      client,
    );
    await notifyItemGroupChange(client, {
      actor: notifyActor(actor),
      status_verb: 'Deleted',
      object_type: 'item_group',
      object_id: code,
      correlation_id: correlationId,
    });
  });
  sendNoContent(res);
};

// -----------------------------------------------------------------------------------------------
// Rights (CEO or Finance Head only)
// -----------------------------------------------------------------------------------------------

/**
 * Granting a right or adding a recipient needs an active user; revoking a right or removing a
 * recipient must NOT, or a deactivated user's rows could never be cleaned up - exactly the user
 * whose access most needs withdrawing. Either way the id must name a real user.
 */
async function requireUser(
  userId: string,
  client: PoolClient,
  mustBeActive: boolean,
): Promise<void> {
  if (UUID_REGEX.test(userId)) {
    const result = await client.query(
      mustBeActive
        ? `SELECT 1 FROM users WHERE user_id = $1 AND active = true`
        : `SELECT 1 FROM users WHERE user_id = $1`,
      [userId],
    );
    if (result.rows.length > 0) return;
  }
  throw new AppError(
    400,
    'USER_NOT_FOUND',
    mustBeActive ? 'No active user matches the given user id' : 'No user matches the given user id',
    { user_id: userId },
  );
}

/**
 * Answer shape of PUT /api/v1/item-groups/rights/:userId. A revoke removes the row, so there is no
 * `granted_by` or `updated_at` to report; saying so with an explicit type is honest, where stuffing
 * nulls into `ItemGroupRightRow` broke that contract for every client reading `updated_at`.
 */
type RightsResponse =
  ItemGroupRightRow | (ItemGroupRights & { user_id: string; granted_by: null; updated_at: null });

function rightsResponse(
  userId: string,
  rights: ItemGroupRights,
  row: ItemGroupRightRow | null,
): RightsResponse {
  return row ?? { user_id: userId, ...rights, granted_by: null, updated_at: null };
}

const listRightsBase: RouteHandler = async (req, res) => {
  assertHoldsAnyRole(requireAuth(req), ITEM_GROUP_GRANTOR_ROLES);
  sendJson(res, 200, { rights: await listItemGroupRights() });
};

const putRightsBase: RouteHandler = async (req, res, params) => {
  const authContext = requireAuth(req);
  assertHoldsAnyRole(authContext, ITEM_GROUP_GRANTOR_ROLES);
  const targetUserId = params['userId'] ?? '';
  const body = bodyObject(req);
  const rights = { create: false, edit: false, delete: false };
  for (const key of ['create', 'edit', 'delete'] as const) {
    if (typeof body[key] !== 'boolean') {
      throw new AppError(400, 'INVALID_PARAMS', `${key} is required and must be a boolean`);
    }
    rights[key] = body[key];
  }
  const actor = actorContext(req, ITEM_GROUP_GRANTOR_ROLES);
  const granting = rights.create || rights.edit || rights.delete;
  // Owner ruling 2026-10-06: a grantor may not GRANT to themselves. A user holding `ceo` or
  // `finance_controller` together with `inventory_controller` would otherwise award themselves
  // create, edit and delete and then use them, which is the separation the rights split creates.
  // Revoking your own rights is allowed: it only reduces access, and an offboarding grantor must be
  // able to drop what they hold.
  if (granting && targetUserId === actor.userId) {
    throw new AppError(
      403,
      'SELF_GRANT_NOT_PERMITTED',
      'Item group rights cannot be granted to yourself',
      { user_id: targetUserId },
    );
  }
  const result = await inTransaction(async (client) => {
    await requireUser(targetUserId, client, granting);
    if (granting) {
      const holds = await client.query(
        `SELECT 1 FROM user_role_assignments WHERE user_id = $1 AND role = $2 LIMIT 1`,
        [targetUserId, ITEM_GROUP_MAINTAINER_ROLE],
      );
      if (holds.rows.length === 0) {
        throw new AppError(
          400,
          'GRANTEE_NOT_INVENTORY_CONTROLLER',
          'Item group rights can only be granted to an inventory_controller holder',
          { user_id: targetUserId },
        );
      }
    }
    const before = await getItemGroupRights(targetUserId, client);
    // Owner ruling 2026-10-06: a no-op writes nothing, as the recipient paths already do. Without
    // this, revoking from a user who holds no right emitted an event and one notification per
    // Table 2 holder on every call, repeatable at will.
    if (
      before.create === rights.create &&
      before.edit === rights.edit &&
      before.delete === rights.delete
    ) {
      return rightsResponse(targetUserId, rights, await getItemGroupRightRow(targetUserId, client));
    }
    const row = await upsertItemGroupRights(targetUserId, rights, actor.userId, client);
    const correlationId = randomUUID();
    await persistEvent(
      {
        stream_type: 'item_group',
        stream_id: targetUserId,
        event_type: granting ? 'item_group_right.granted' : 'item_group_right.revoked',
        payload: { user_id: targetUserId, before, after: { ...rights } },
        metadata: eventMetadata(actor, correlationId),
      },
      auditCtxFor(req, actor, 200),
      client,
    );
    await notifyItemGroupChange(client, {
      actor: notifyActor(actor),
      status_verb: granting ? 'Rights granted' : 'Rights revoked',
      object_type: 'item_group_right',
      object_id: targetUserId,
      correlation_id: correlationId,
    });
    return rightsResponse(targetUserId, rights, row);
  });
  sendJson(res, 200, result);
};

// -----------------------------------------------------------------------------------------------
// Recipient list (CEO or Finance Head only)
// -----------------------------------------------------------------------------------------------

const listRecipientsBase: RouteHandler = async (req, res) => {
  assertHoldsAnyRole(requireAuth(req), ITEM_GROUP_GRANTOR_ROLES);
  sendJson(res, 200, { recipients: await listItemGroupRecipients() });
};

const addRecipientBase: RouteHandler = async (req, res) => {
  const authContext = requireAuth(req);
  assertHoldsAnyRole(authContext, ITEM_GROUP_GRANTOR_ROLES);
  const userId = bodyObject(req)['user_id'];
  if (typeof userId !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'user_id is required and must be a string');
  }
  const actor = actorContext(req, ITEM_GROUP_GRANTOR_ROLES);
  const row = await inTransaction(async (client) => {
    await requireUser(userId, client, true);
    const { row: recipient, added } = await addItemGroupRecipient(userId, actor.userId, client);
    const correlationId = randomUUID();
    if (added) {
      await persistEvent(
        {
          stream_type: 'item_group',
          stream_id: userId,
          event_type: 'item_group_recipient.added',
          payload: { user_id: userId },
          metadata: eventMetadata(actor, correlationId),
        },
        auditCtxFor(req, actor, 201),
        client,
      );
      await notifyItemGroupChange(client, {
        actor: notifyActor(actor),
        status_verb: 'Recipient added',
        object_type: 'item_group_recipient',
        object_id: userId,
        correlation_id: correlationId,
      });
    }
    return recipient;
  });
  sendJson(res, 201, row);
};

const removeRecipientBase: RouteHandler = async (req, res, params) => {
  const authContext = requireAuth(req);
  assertHoldsAnyRole(authContext, ITEM_GROUP_GRANTOR_ROLES);
  const userId = params['userId'] ?? '';
  const actor = actorContext(req, ITEM_GROUP_GRANTOR_ROLES);
  await inTransaction(async (client) => {
    await requireUser(userId, client, false);
    const removed = await removeItemGroupRecipient(userId, client);
    if (!removed) return;
    const correlationId = randomUUID();
    await persistEvent(
      {
        stream_type: 'item_group',
        stream_id: userId,
        event_type: 'item_group_recipient.removed',
        payload: { user_id: userId },
        metadata: eventMetadata(actor, correlationId),
      },
      auditCtxFor(req, actor, 204),
      client,
    );
    await notifyItemGroupChange(client, {
      actor: notifyActor(actor),
      status_verb: 'Recipient removed',
      object_type: 'item_group_recipient',
      object_id: userId,
      correlation_id: correlationId,
    });
  });
  sendNoContent(res);
};

// -----------------------------------------------------------------------------------------------
// Handlers (Table 1 gates). Rights and recipient routes carry no module gate: ceo and
// finance_controller are provisioned on different modules, so the handler checks the role.
// -----------------------------------------------------------------------------------------------

const readGate = requireRole({ module: 'inventory', functionScope: 'read' });
const writeGate = requireRole({ module: 'inventory', functionScope: 'write' });

export const listUngroupedItemsHandler: RouteHandler = readGate(listUngroupedBase);
export const listItemGroupRightsHandler: RouteHandler = listRightsBase;
export const putItemGroupRightsHandler: RouteHandler = putRightsBase;
export const listItemGroupRecipientsHandler: RouteHandler = listRecipientsBase;
export const addItemGroupRecipientHandler: RouteHandler = addRecipientBase;
export const removeItemGroupRecipientHandler: RouteHandler = removeRecipientBase;
export const listItemGroupsHandler: RouteHandler = readGate(listGroupsBase);
export const createItemGroupHandler: RouteHandler = writeGate(createGroupBase);
export const listItemGroupItemsHandler: RouteHandler = readGate(listGroupItemsBase);
export const getItemGroupHandler: RouteHandler = readGate(getGroupBase);
export const updateItemGroupHandler: RouteHandler = writeGate(updateGroupBase);
export const deleteItemGroupHandler: RouteHandler = writeGate(deleteGroupBase);

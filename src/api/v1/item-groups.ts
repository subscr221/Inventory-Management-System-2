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
import type { ItemGroup, ItemGroupStatus } from '../../read/projections/item_group.js';
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
 * Routes with no requireRole module gate (rights and recipients) carry no authorized assignment,
 * so the actor role falls back to the first of the caller's roles that is in `preferredRoles`.
 */
function actorContext(req: IncomingMessage, preferredRoles: readonly string[] = []): ActorContext {
  const authContext = getAuthContext(req);
  const assignment =
    getAuthorizedAssignment(req) ??
    authContext?.roles.find((r) => preferredRoles.includes(r.role)) ??
    undefined;
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

function constraintOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    return (err as { constraint?: string }).constraint ?? null;
  }
  return null;
}

/** Runs `work` in one transaction (BEGIN, COMMIT, ROLLBACK on any error). */
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
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

function parseCodeParam(params: Record<string, string>): string {
  const code = params['code'];
  if (!code || !ITEM_GROUP_CODE_REGEX.test(code)) {
    throw new AppError(
      404,
      'ITEM_GROUP_NOT_FOUND',
      `No item group exists for code "${code ?? ''}"`,
      { code: code ?? null },
    );
  }
  return code;
}

async function requireGroup(code: string, client?: PoolClient): Promise<ItemGroup> {
  const group = await getItemGroupByCode(code, client);
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
  const actor = actorContext(req);
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
  const actor = actorContext(req);
  try {
    const after = await inTransaction(async (client) => {
      await assertItemGroupRight(authContext, 'edit', client);
      const before = await requireGroup(code, client);
      const updated = (await updateItemGroup(code, patch, client))!;
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
    throw err;
  }
};

const deleteGroupBase: RouteHandler = async (req, res, params) => {
  const authContext = requireAuth(req);
  const code = parseCodeParam(params);
  const actor = actorContext(req);
  await inTransaction(async (client) => {
    await assertItemGroupRight(authContext, 'delete', client);
    await requireGroup(code, client);
    const deleted = await deleteItemGroupIfNeverUsed(code, client);
    if (!deleted) {
      throw new AppError(
        409,
        'ITEM_GROUP_IN_USE',
        `Item group ${code} has had items assigned; deactivate it instead`,
        { code },
      );
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

async function requireActiveUser(userId: string, client: PoolClient): Promise<void> {
  if (UUID_REGEX.test(userId)) {
    const result = await client.query(`SELECT 1 FROM users WHERE user_id = $1 AND active = true`, [
      userId,
    ]);
    if (result.rows.length > 0) return;
  }
  throw new AppError(400, 'USER_NOT_FOUND', 'No active user matches the given user id', {
    user_id: userId,
  });
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
  const result = await inTransaction(async (client) => {
    await requireActiveUser(targetUserId, client);
    const granting = rights.create || rights.edit || rights.delete;
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
    return row ?? { user_id: targetUserId, ...rights, granted_by: actor.userId, updated_at: null };
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
    await requireActiveUser(userId, client);
    const added = await addItemGroupRecipient(userId, actor.userId, client);
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
    return (await listItemGroupRecipients(client)).find((r) => r.user_id === userId)!;
  });
  sendJson(res, 201, row);
};

const removeRecipientBase: RouteHandler = async (req, res, params) => {
  const authContext = requireAuth(req);
  assertHoldsAnyRole(authContext, ITEM_GROUP_GRANTOR_ROLES);
  const userId = params['userId'] ?? '';
  const actor = actorContext(req, ITEM_GROUP_GRANTOR_ROLES);
  await inTransaction(async (client) => {
    await requireActiveUser(userId, client);
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

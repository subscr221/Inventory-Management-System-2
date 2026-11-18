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
  ITEM_GROUP_GRANTER_ROLES,
  ITEM_GROUP_MAINTAINER_ROLE,
  ITEM_GROUP_SELF_GRANT_ROLE,
  assertHoldsAnyRole,
  assertItemGroupRight,
  notifyItemGroupChange,
} from '../../compliance/item-group-authority.js';

/**
 * Story 2.10 item group master API (Table 1). Writes follow src/api/v1/items.ts: BEGIN, authority
 * check, projection write, persistEvent (event + audit row), notification fan-out, COMMIT, all in
 * one transaction. Events are route-only (D7) on stream `item_group`: the group id for group
 * events, the target user id for rights and recipient-list events.
 */

// Domain-event actor.location_id must be a UUID; an enterprise-wide '*' assignment maps to this
// sentinel while the audit row keeps the real '*' (src/api/v1/items.ts precedent).
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_TYPE = 'item_group';

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

/**
 * The actor is stamped under the role that authorizes the action: the route's authorized
 * assignment when it is one of `roles`, otherwise the caller's first assignment holding one.
 */
function actorFor(req: IncomingMessage, roles: readonly string[]): ActorContext {
  const authContext = getAuthContext(req);
  const authorized = getAuthorizedAssignment(req);
  const assignment =
    authorized && roles.includes(authorized.role)
      ? authorized
      : authContext?.roles.find((r) => roles.includes(r.role));
  const auditLocationId = assignment?.locationId ?? '*';
  return {
    userId: authContext?.userId ?? NO_LOCATION_UUID,
    role: assignment?.role ?? '',
    auditLocationId,
    eventLocationId: UUID_REGEX.test(auditLocationId) ? auditLocationId : NO_LOCATION_UUID,
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

/** Persists one item group event with its audit row and tells everyone (AC 7), in `client`'s transaction. */
async function recordChange(
  req: IncomingMessage,
  client: PoolClient,
  actor: ActorContext,
  httpStatus: number,
  event: { stream_id: string; event_type: string; payload: Record<string, unknown> },
  notice: { status_verb: string; object_type: string; object_id: string },
): Promise<void> {
  const correlationId = randomUUID();
  const eventActor = {
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.eventLocationId,
  };
  await persistEvent(
    {
      stream_type: STREAM_TYPE,
      stream_id: event.stream_id,
      event_type: event.event_type,
      payload: event.payload,
      metadata: {
        correlation_id: correlationId,
        actor: eventActor,
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, httpStatus),
    client,
  );
  await notifyItemGroupChange(client, {
    actor: eventActor,
    event_type: event.event_type,
    ...notice,
    correlation_id: correlationId,
  });
}

/** Runs `work` in one transaction on a pooled client; rolls back and rethrows on any error. */
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

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function bodyObject(req: IncomingMessage): Record<string, unknown> {
  const body = getParsedBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'INVALID_PARAMS', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 120) {
    throw new AppError(400, 'INVALID_PARAMS', 'name must be a string of 1-120 characters');
  }
  return value.trim();
}

function parseStatus(value: unknown): ItemGroupStatus {
  if (typeof value !== 'string' || !(ITEM_GROUP_STATUSES as readonly string[]).includes(value)) {
    throw new AppError(400, 'INVALID_PARAMS', 'status must be one of active, inactive');
  }
  return value as ItemGroupStatus;
}

function parseCodeParam(value: string | undefined): string {
  if (!value || !ITEM_GROUP_CODE_REGEX.test(value)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'code must be 2-32 characters: upper-case letters, digits, "_" or "-", starting with a letter or digit',
    );
  }
  return value;
}

function parseUserIdParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function notFound(code: string): AppError {
  return new AppError(404, 'ITEM_GROUP_NOT_FOUND', `No item group exists with code "${code}"`, {
    code,
  });
}

/** Maps the two unique indexes to their stable 409 codes; anything else is rethrown. */
function mapUniqueViolation(err: unknown, code: string, name: string | undefined): never {
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr?.code === '23505' && pgErr.constraint === 'uq_item_group_code') {
    throw new AppError(
      409,
      'DUPLICATE_ITEM_GROUP_CODE',
      `Item group code "${code}" already exists`,
      {
        code,
      },
    );
  }
  if (pgErr?.code === '23505' && pgErr.constraint === 'uq_item_group_name_ci') {
    throw new AppError(
      409,
      'DUPLICATE_ITEM_GROUP_NAME',
      `An item group named "${name ?? ''}" already exists (names are unique ignoring case)`,
      { name: name ?? null },
    );
  }
  throw err;
}

/** 400 USER_NOT_FOUND unless the user exists and is active. */
async function assertActiveUser(userId: string, client: PoolClient): Promise<void> {
  const result = await client.query(`SELECT active FROM users WHERE user_id = $1`, [userId]);
  if (result.rows.length === 0 || result.rows[0]!['active'] !== true) {
    throw new AppError(400, 'USER_NOT_FOUND', 'No active user exists with that user_id', {
      user_id: userId,
    });
  }
}

// -----------------------------------------------------------------------------------------------
// Reads (inventory read)
// -----------------------------------------------------------------------------------------------

const listUngroupedBase: RouteHandler = async (_req, res) => {
  const items = await listUngroupedActiveItems();
  sendJson(res, 200, { items, count: items.length });
};

const listItemGroupsBase: RouteHandler = async (_req, res) => {
  sendJson(res, 200, { item_groups: await listItemGroups() });
};

const getItemGroupBase: RouteHandler = async (_req, res, params) => {
  const code = parseCodeParam(params['code']);
  const group = await getItemGroupByCode(code);
  if (!group) throw notFound(code);
  sendJson(res, 200, group);
};

const listGroupItemsBase: RouteHandler = async (_req, res, params) => {
  const code = parseCodeParam(params['code']);
  const group = await getItemGroupByCode(code);
  if (!group) throw notFound(code);
  sendJson(res, 200, {
    item_group: group,
    items: await listActiveItemsByGroup(group.item_group_id),
  });
};

// -----------------------------------------------------------------------------------------------
// Group writes (inventory write + inventory_controller + the named right)
// -----------------------------------------------------------------------------------------------

const createItemGroupBase: RouteHandler = async (req, res) => {
  const body = bodyObject(req);
  const code = body['code'];
  if (typeof code !== 'string' || !ITEM_GROUP_CODE_REGEX.test(code)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'code must be 2-32 characters: upper-case letters, digits, "_" or "-", starting with a letter or digit',
    );
  }
  const name = parseName(body['name']);
  const actor = actorFor(req, [ITEM_GROUP_MAINTAINER_ROLE]);
  const group = await inTransaction(async (client) => {
    await assertItemGroupRight(getAuthContext(req), 'create', client);
    let created: ItemGroup;
    try {
      created = await createItemGroup({ code, name, status: 'active' }, client);
    } catch (err) {
      mapUniqueViolation(err, code, name);
    }
    await recordChange(
      req,
      client,
      actor,
      201,
      {
        stream_id: created.item_group_id,
        event_type: 'item_group.created',
        payload: { item_group: created },
      },
      { status_verb: 'Item group created', object_type: 'item_group', object_id: created.code },
    );
    return created;
  });
  sendJson(res, 201, group);
};

const updateItemGroupBase: RouteHandler = async (req, res, params) => {
  const code = parseCodeParam(params['code']);
  const body = bodyObject(req);
  const extra = Object.keys(body).filter((k) => k !== 'name' && k !== 'status');
  if (extra.length > 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'Only name and status may be changed', {
      rejected_fields: extra,
    });
  }
  const patch: { name?: string; status?: ItemGroupStatus } = {};
  if (body['name'] !== undefined) patch.name = parseName(body['name']);
  if (body['status'] !== undefined) patch.status = parseStatus(body['status']);
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'At least one of name or status is required');
  }
  const actor = actorFor(req, [ITEM_GROUP_MAINTAINER_ROLE]);
  const group = await inTransaction(async (client) => {
    await assertItemGroupRight(getAuthContext(req), 'edit', client);
    const before = await getItemGroupByCode(code, client, { forUpdate: true });
    if (!before) throw notFound(code);
    // A patch that leaves name and status as stored changes nothing: no write, event or notice.
    if (
      (patch.name === undefined || patch.name === before.name) &&
      (patch.status === undefined || patch.status === before.status)
    ) {
      return before;
    }
    let after: ItemGroup;
    try {
      // The row is locked FOR UPDATE above, so the update cannot miss it.
      after = (await updateItemGroup(code, patch, client))!;
    } catch (err) {
      mapUniqueViolation(err, code, patch.name);
    }
    const verb =
      before.status !== after.status
        ? after.status === 'inactive'
          ? 'Item group deactivated'
          : 'Item group reactivated'
        : 'Item group updated';
    await recordChange(
      req,
      client,
      actor,
      200,
      {
        stream_id: before.item_group_id,
        event_type: 'item_group.updated',
        payload: { item_group_id: before.item_group_id, code, before, after },
      },
      { status_verb: verb, object_type: 'item_group', object_id: code },
    );
    return after;
  });
  sendJson(res, 200, group);
};

const deleteItemGroupBase: RouteHandler = async (req, res, params) => {
  const code = parseCodeParam(params['code']);
  const actor = actorFor(req, [ITEM_GROUP_MAINTAINER_ROLE]);
  await inTransaction(async (client) => {
    await assertItemGroupRight(getAuthContext(req), 'delete', client);
    const existing = await getItemGroupByCode(code, client, { forUpdate: true });
    if (!existing) throw notFound(code);
    const deleted = await deleteItemGroupIfNeverUsed(code, client);
    if (!deleted) {
      throw new AppError(
        409,
        'ITEM_GROUP_IN_USE',
        `Item group ${code} has had items assigned; deactivate it instead`,
        { code },
      );
    }
    await recordChange(
      req,
      client,
      actor,
      204,
      {
        stream_id: deleted.item_group_id,
        event_type: 'item_group.deleted',
        payload: { item_group: deleted },
      },
      { status_verb: 'Item group deleted', object_type: 'item_group', object_id: code },
    );
  });
  sendNoContent(res);
};

// -----------------------------------------------------------------------------------------------
// Rights and recipient list (ceo or finance_controller, checked in the handler)
// -----------------------------------------------------------------------------------------------

const listRightsBase: RouteHandler = async (req, res) => {
  assertHoldsAnyRole(getAuthContext(req), ITEM_GROUP_GRANTER_ROLES);
  sendJson(res, 200, { rights: await listItemGroupRights() });
};

const putRightsBase: RouteHandler = async (req, res, params) => {
  assertHoldsAnyRole(getAuthContext(req), ITEM_GROUP_GRANTER_ROLES);
  const userId = parseUserIdParam(params['userId'], 'userId');
  const body = bodyObject(req);
  for (const field of ['create', 'edit', 'delete']) {
    if (typeof body[field] !== 'boolean') {
      throw new AppError(400, 'INVALID_PARAMS', 'create, edit and delete are required booleans', {
        field,
      });
    }
  }
  const after = {
    create: body['create'] as boolean,
    edit: body['edit'] as boolean,
    delete: body['delete'] as boolean,
  };
  const granting = after.create || after.edit || after.delete;
  const authContext = getAuthContext(req);
  // Owner ruling 2026-10-02: only a ceo holder may grant rights to themselves.
  if (
    granting &&
    userId === authContext?.userId.toLowerCase() &&
    !authContext.roles.some((r) => r.role === ITEM_GROUP_SELF_GRANT_ROLE)
  ) {
    throw new AppError(
      403,
      'ITEM_GROUP_SELF_GRANT_REFUSED',
      'Item group rights cannot be granted to yourself',
      { user_id: userId },
    );
  }
  const actor = actorFor(req, ITEM_GROUP_GRANTER_ROLES);
  const row = await inTransaction(async (client) => {
    // A revoke never needs an active user or the role: rights left on someone who was deactivated
    // or lost the role must stay removable.
    if (granting) {
      await assertActiveUser(userId, client);
      const holds = await client.query(
        `SELECT 1 FROM user_role_assignments WHERE user_id = $1 AND role = $2 LIMIT 1`,
        [userId, ITEM_GROUP_MAINTAINER_ROLE],
      );
      if (holds.rows.length === 0) {
        throw new AppError(
          400,
          'GRANTEE_NOT_INVENTORY_CONTROLLER',
          'Item group rights may only be granted to an inventory_controller holder',
          { user_id: userId },
        );
      }
    }
    const before = await getItemGroupRights(userId, client, { forUpdate: true });
    if (
      before.create === after.create &&
      before.edit === after.edit &&
      before.delete === after.delete
    ) {
      // Nothing changes: no write, event or notice. Report the stored row, or the empty rights.
      const existing = (await listItemGroupRights(client)).find((r) => r.user_id === userId);
      return (
        existing ?? {
          user_id: userId,
          ...after,
          granted_by: actor.userId,
          updated_at: new Date().toISOString(),
        }
      );
    }
    // none to some is a grant, some to none a revoke, some to a different some a change.
    const hadAny = before.create || before.edit || before.delete;
    const rightsEvent = !granting
      ? { event_type: 'item_group_right.revoked', status_verb: 'Item group rights revoked' }
      : hadAny
        ? { event_type: 'item_group_right.changed', status_verb: 'Item group rights changed' }
        : { event_type: 'item_group_right.granted', status_verb: 'Item group rights granted' };
    const stored = await upsertItemGroupRights(userId, after, actor.userId, client);
    await recordChange(
      req,
      client,
      actor,
      200,
      {
        stream_id: userId,
        event_type: rightsEvent.event_type,
        payload: { user_id: userId, before, after },
      },
      {
        status_verb: rightsEvent.status_verb,
        object_type: 'item_group_right',
        object_id: userId,
      },
    );
    return (
      stored ?? {
        user_id: userId,
        ...after,
        granted_by: actor.userId,
        updated_at: new Date().toISOString(),
      }
    );
  });
  sendJson(res, 200, row);
};

const listRecipientsBase: RouteHandler = async (req, res) => {
  assertHoldsAnyRole(getAuthContext(req), ITEM_GROUP_GRANTER_ROLES);
  sendJson(res, 200, { recipients: await listItemGroupRecipients() });
};

const addRecipientBase: RouteHandler = async (req, res) => {
  assertHoldsAnyRole(getAuthContext(req), ITEM_GROUP_GRANTER_ROLES);
  const userId = parseUserIdParam(bodyObject(req)['user_id'], 'user_id');
  const actor = actorFor(req, ITEM_GROUP_GRANTER_ROLES);
  const row = await inTransaction(async (client) => {
    await assertActiveUser(userId, client);
    const added = await addItemGroupRecipient(userId, actor.userId, client);
    if (!added) {
      throw new AppError(
        409,
        'ITEM_GROUP_RECIPIENT_EXISTS',
        'That user is already on the item group recipient list',
        { user_id: userId },
      );
    }
    await recordChange(
      req,
      client,
      actor,
      201,
      { stream_id: userId, event_type: 'item_group_recipient.added', payload: { user_id: userId } },
      {
        status_verb: 'Item group recipient added',
        object_type: 'item_group_recipient',
        object_id: userId,
      },
    );
    return added;
  });
  sendJson(res, 201, row);
};

const removeRecipientBase: RouteHandler = async (req, res, params) => {
  assertHoldsAnyRole(getAuthContext(req), ITEM_GROUP_GRANTER_ROLES);
  const userId = parseUserIdParam(params['userId'], 'userId');
  const actor = actorFor(req, ITEM_GROUP_GRANTER_ROLES);
  await inTransaction(async (client) => {
    if (!(await removeItemGroupRecipient(userId, client))) {
      throw new AppError(
        404,
        'ITEM_GROUP_RECIPIENT_NOT_FOUND',
        'That user is not on the item group recipient list',
        { user_id: userId },
      );
    }
    await recordChange(
      req,
      client,
      actor,
      204,
      {
        stream_id: userId,
        event_type: 'item_group_recipient.removed',
        payload: { user_id: userId },
      },
      {
        status_verb: 'Item group recipient removed',
        object_type: 'item_group_recipient',
        object_id: userId,
      },
    );
  });
  sendNoContent(res);
};

const inventoryRead = requireRole({ module: 'inventory', functionScope: 'read' });
const inventoryWrite = requireRole({ module: 'inventory', functionScope: 'write' });

export const listUngroupedItemsHandler: RouteHandler = inventoryRead(listUngroupedBase);
export const listItemGroupsHandler: RouteHandler = inventoryRead(listItemGroupsBase);
export const getItemGroupHandler: RouteHandler = inventoryRead(getItemGroupBase);
export const listItemGroupItemsHandler: RouteHandler = inventoryRead(listGroupItemsBase);
export const createItemGroupHandler: RouteHandler = inventoryWrite(createItemGroupBase);
export const updateItemGroupHandler: RouteHandler = inventoryWrite(updateItemGroupBase);
export const deleteItemGroupHandler: RouteHandler = inventoryWrite(deleteItemGroupBase);
// Routes 2-6 carry no module gate: ceo and finance_controller are provisioned on different
// modules. The router's global authentication runs first; the handler checks the role.
export const listItemGroupRightsHandler: RouteHandler = listRightsBase;
export const putItemGroupRightsHandler: RouteHandler = putRightsBase;
export const listItemGroupRecipientsHandler: RouteHandler = listRecipientsBase;
export const addItemGroupRecipientHandler: RouteHandler = addRecipientBase;
export const removeItemGroupRecipientHandler: RouteHandler = removeRecipientBase;

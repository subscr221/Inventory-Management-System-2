import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';
import type { ItemMaster } from './item_master.js';
import { listActiveItemsByGroupId } from './item_master.js';

/**
 * Item group master (Story 2.10). code is the API-facing identifier; item_group_id is the event
 * stream_id and the item_master.item_group_id foreign key target. Other modules (Story 4.8 grant
 * scope) read groups and call the assignability guard through this module only (AD-14).
 */

export const ITEM_GROUP_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
export const ITEM_GROUP_STATUSES = ['active', 'inactive'] as const;
export type ItemGroupStatus = (typeof ITEM_GROUP_STATUSES)[number];
export const ITEM_GROUP_RIGHTS = ['create', 'edit', 'delete'] as const;
export type ItemGroupRight = (typeof ITEM_GROUP_RIGHTS)[number];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ItemGroup {
  item_group_id: string;
  code: string;
  name: string;
  status: ItemGroupStatus;
  ever_assigned: boolean;
  created_at: string;
  updated_at: string;
}

export interface ItemGroupRights {
  user_id: string;
  create: boolean;
  edit: boolean;
  delete: boolean;
  granted_by: string;
  updated_at: string;
}

export interface ItemGroupRecipient {
  user_id: string;
  added_by: string;
  added_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const GROUP_COLUMNS = `item_group_id, code, name, status, ever_assigned, created_at, updated_at`;

function mapGroup(row: Record<string, unknown>): ItemGroup {
  return {
    item_group_id: row['item_group_id'] as string,
    code: row['code'] as string,
    name: row['name'] as string,
    status: row['status'] as ItemGroupStatus,
    ever_assigned: row['ever_assigned'] as boolean,
    created_at: iso(row['created_at']),
    updated_at: iso(row['updated_at']),
  };
}

function mapRights(row: Record<string, unknown>): ItemGroupRights {
  return {
    user_id: row['user_id'] as string,
    create: row['can_create'] as boolean,
    edit: row['can_edit'] as boolean,
    delete: row['can_delete'] as boolean,
    granted_by: row['granted_by'] as string,
    updated_at: iso(row['updated_at']),
  };
}

function mapRecipient(row: Record<string, unknown>): ItemGroupRecipient {
  return {
    user_id: row['user_id'] as string,
    added_by: row['added_by'] as string,
    added_at: iso(row['added_at']),
  };
}

// -----------------------------------------------------------------------------------------------
// Groups
// -----------------------------------------------------------------------------------------------

export async function createItemGroup(
  input: { code: string; name: string; status: ItemGroupStatus },
  client?: PoolClient,
): Promise<ItemGroup> {
  const result = await runner(client).query(
    `INSERT INTO item_group (code, name, status) VALUES ($1, $2, $3) RETURNING ${GROUP_COLUMNS}`,
    [input.code, input.name, input.status],
  );
  return mapGroup(result.rows[0]!);
}

/** Applies a name and/or status change by code; null when the code is unknown. */
export async function updateItemGroup(
  code: string,
  patch: { name?: string; status?: ItemGroupStatus },
  client?: PoolClient,
): Promise<ItemGroup | null> {
  const result = await runner(client).query(
    `UPDATE item_group
        SET name = COALESCE($2, name), status = COALESCE($3, status), updated_at = now()
      WHERE code = $1
      RETURNING ${GROUP_COLUMNS}`,
    [code, patch.name ?? null, patch.status ?? null],
  );
  return result.rows.length > 0 ? mapGroup(result.rows[0]!) : null;
}

/**
 * Deletes a group only while it has never had an item assigned (D9). Returns the deleted row, or
 * null when nothing was deleted (unknown code, or a group that was ever used).
 */
export async function deleteItemGroupIfNeverUsed(
  code: string,
  client?: PoolClient,
): Promise<ItemGroup | null> {
  const result = await runner(client).query(
    `DELETE FROM item_group WHERE code = $1 AND ever_assigned = false RETURNING ${GROUP_COLUMNS}`,
    [code],
  );
  return result.rows.length > 0 ? mapGroup(result.rows[0]!) : null;
}

/** Sets the never-cleared ever_assigned flag on the first assignment (D9). */
export async function markEverAssigned(groupId: string, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `UPDATE item_group SET ever_assigned = true WHERE item_group_id = $1 AND ever_assigned = false`,
    [groupId],
  );
}

export async function getItemGroupByCode(
  code: string,
  client?: PoolClient,
  options: { forUpdate?: boolean } = {},
): Promise<ItemGroup | null> {
  const result = await runner(client).query(
    `SELECT ${GROUP_COLUMNS} FROM item_group WHERE code = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [code],
  );
  return result.rows.length > 0 ? mapGroup(result.rows[0]!) : null;
}

export async function getItemGroupById(
  itemGroupId: string,
  client?: PoolClient,
): Promise<ItemGroup | null> {
  if (!UUID_REGEX.test(itemGroupId)) return null;
  const result = await runner(client).query(
    `SELECT ${GROUP_COLUMNS} FROM item_group WHERE item_group_id = $1`,
    [itemGroupId],
  );
  return result.rows.length > 0 ? mapGroup(result.rows[0]!) : null;
}

export async function listItemGroups(client?: PoolClient): Promise<ItemGroup[]> {
  const result = await runner(client).query(
    `SELECT ${GROUP_COLUMNS} FROM item_group ORDER BY code`,
  );
  return result.rows.map(mapGroup);
}

/** Active items carrying the group, ordered by SKU. */
export async function listActiveItemsByGroup(
  itemGroupId: string,
  client?: PoolClient,
): Promise<ItemMaster[]> {
  return listActiveItemsByGroupId(itemGroupId, client);
}

/** Active items with no group (AC 5), ordered by SKU - the tool for grouping every item. */
export async function listUngroupedActiveItems(client?: PoolClient): Promise<ItemMaster[]> {
  return listActiveItemsByGroupId(null, client);
}

/**
 * The one shared guard (D6): a reference must name an existing, active group. Owns
 * ITEM_GROUP_NOT_FOUND and ITEM_GROUP_INACTIVE for item assignment and for Story 4.8's
 * scope_item_group_id. With a client, the row is read FOR NO KEY UPDATE so a concurrent deactivate
 * or delete waits for the caller's transaction. It is the same lock level markEverAssigned's
 * UPDATE takes, so two first assignments queue instead of deadlocking on a FOR SHARE upgrade.
 */
export async function assertItemGroupAssignable(
  itemGroupId: unknown,
  client?: PoolClient,
): Promise<ItemGroup> {
  if (typeof itemGroupId !== 'string' || !UUID_REGEX.test(itemGroupId)) {
    throw new AppError(400, 'ITEM_GROUP_NOT_FOUND', 'Item group does not exist', {
      item_group_id: typeof itemGroupId === 'string' ? itemGroupId : null,
    });
  }
  const result = await runner(client).query(
    `SELECT ${GROUP_COLUMNS} FROM item_group WHERE item_group_id = $1${client ? ' FOR NO KEY UPDATE' : ''}`,
    [itemGroupId],
  );
  if (result.rows.length === 0) {
    throw new AppError(400, 'ITEM_GROUP_NOT_FOUND', 'Item group does not exist', {
      item_group_id: itemGroupId,
    });
  }
  const group = mapGroup(result.rows[0]!);
  if (group.status !== 'active') {
    throw new AppError(
      400,
      'ITEM_GROUP_INACTIVE',
      `Item group ${group.code} is inactive and takes no new assignment`,
      { item_group_id: itemGroupId, code: group.code },
    );
  }
  return group;
}

// -----------------------------------------------------------------------------------------------
// Rights (D3)
// -----------------------------------------------------------------------------------------------

/** The user's rights; a user with no row holds none. */
export async function getItemGroupRights(
  userId: string,
  client?: PoolClient,
  options: { forUpdate?: boolean } = {},
): Promise<{ create: boolean; edit: boolean; delete: boolean }> {
  const result = await runner(client).query(
    `SELECT can_create, can_edit, can_delete FROM item_group_right
      WHERE user_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  const row = result.rows[0];
  return {
    create: row ? (row['can_create'] as boolean) : false,
    edit: row ? (row['can_edit'] as boolean) : false,
    delete: row ? (row['can_delete'] as boolean) : false,
  };
}

/** Stores the rights; all three false removes the row (the revoke). Returns the stored row or null. */
export async function upsertItemGroupRights(
  userId: string,
  rights: { create: boolean; edit: boolean; delete: boolean },
  grantedBy: string,
  client?: PoolClient,
): Promise<ItemGroupRights | null> {
  if (!rights.create && !rights.edit && !rights.delete) {
    await runner(client).query(`DELETE FROM item_group_right WHERE user_id = $1`, [userId]);
    return null;
  }
  const result = await runner(client).query(
    `INSERT INTO item_group_right (user_id, can_create, can_edit, can_delete, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET can_create = EXCLUDED.can_create, can_edit = EXCLUDED.can_edit,
           can_delete = EXCLUDED.can_delete, granted_by = EXCLUDED.granted_by, updated_at = now()
     RETURNING user_id, can_create, can_edit, can_delete, granted_by, updated_at`,
    [userId, rights.create, rights.edit, rights.delete, grantedBy],
  );
  return mapRights(result.rows[0]!);
}

export async function listItemGroupRights(client?: PoolClient): Promise<ItemGroupRights[]> {
  const result = await runner(client).query(
    `SELECT user_id, can_create, can_edit, can_delete, granted_by, updated_at
       FROM item_group_right ORDER BY user_id`,
  );
  return result.rows.map(mapRights);
}

// -----------------------------------------------------------------------------------------------
// Recipient list (AC 7)
// -----------------------------------------------------------------------------------------------

export async function listItemGroupRecipients(client?: PoolClient): Promise<ItemGroupRecipient[]> {
  const result = await runner(client).query(
    `SELECT user_id, added_by, added_at FROM item_group_recipient ORDER BY added_at, user_id`,
  );
  return result.rows.map(mapRecipient);
}

/** Active users on the recipient list (the AC 7 fan-out), ordered by user id. */
export async function listActiveItemGroupRecipientIds(client?: PoolClient): Promise<string[]> {
  const result = await runner(client).query(
    `SELECT r.user_id FROM item_group_recipient r JOIN users u ON u.user_id = r.user_id
      WHERE u.active ORDER BY r.user_id`,
  );
  return result.rows.map((row) => row['user_id'] as string);
}

/** Adds the user; null when already on the list. */
export async function addItemGroupRecipient(
  userId: string,
  addedBy: string,
  client?: PoolClient,
): Promise<ItemGroupRecipient | null> {
  const result = await runner(client).query(
    `INSERT INTO item_group_recipient (user_id, added_by) VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id, added_by, added_at`,
    [userId, addedBy],
  );
  return result.rows.length > 0 ? mapRecipient(result.rows[0]!) : null;
}

/** Removes the user; false when they were not on the list. */
export async function removeItemGroupRecipient(
  userId: string,
  client?: PoolClient,
): Promise<boolean> {
  const result = await runner(client).query(`DELETE FROM item_group_recipient WHERE user_id = $1`, [
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

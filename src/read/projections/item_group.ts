import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { AppError } from '../../middleware/error.js';
import { ITEM_COLUMNS, mapRow } from './item_master.js';
import type { ItemMaster } from './item_master.js';

/**
 * Item group master read model (Story 2.10). item_group_id is the internal UUID (and the
 * item_group event stream_id); code is the unique, URL-safe, API-facing identifier. A group that
 * has ever had an item assigned keeps ever_assigned = true forever, so a group emptied later is
 * still refused for deletion (D9) and must be deactivated instead.
 */

export const ITEM_GROUP_STATUSES = ['active', 'inactive'] as const;
export type ItemGroupStatus = (typeof ITEM_GROUP_STATUSES)[number];

export const ITEM_GROUP_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

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
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export interface ItemGroupRightRow extends ItemGroupRights {
  user_id: string;
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

const GROUP_COLUMNS = 'item_group_id, code, name, status, ever_assigned, created_at, updated_at';

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

export async function createItemGroup(
  input: { code: string; name: string },
  client?: PoolClient,
): Promise<ItemGroup> {
  const result = await runner(client).query(
    `INSERT INTO item_group (code, name) VALUES ($1, $2) RETURNING ${GROUP_COLUMNS}`,
    [input.code, input.name],
  );
  return mapGroup(result.rows[0]!);
}

/** Applies a name and/or status change by code; null when the code is unknown. */
export async function updateItemGroup(
  code: string,
  patch: { name?: string; status?: ItemGroupStatus },
  client?: PoolClient,
): Promise<ItemGroup | null> {
  const sets: string[] = [];
  const values: unknown[] = [code];
  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`name = $${values.length}`);
  }
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (sets.length === 0) return getItemGroupByCode(code, client);
  const result = await runner(client).query(
    `UPDATE item_group SET ${sets.join(', ')}, updated_at = now() WHERE code = $1 RETURNING ${GROUP_COLUMNS}`,
    values,
  );
  return result.rows.length > 0 ? mapGroup(result.rows[0]!) : null;
}

/** Deletes the group only when no item was ever assigned; returns the deleted row or null. */
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

/** Sets ever_assigned on first assignment; never cleared (D9). */
export async function markEverAssigned(groupId: string, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `UPDATE item_group SET ever_assigned = true, updated_at = CASE WHEN ever_assigned THEN updated_at ELSE now() END
     WHERE item_group_id = $1`,
    [groupId],
  );
}

/**
 * Reads a group by code. `forUpdate` (only meaningful with a client) takes the row write lock, so
 * a handler that goes on to update or delete the row cannot have it changed or removed underneath
 * it between the check and the write.
 */
export async function getItemGroupByCode(
  code: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<ItemGroup | null> {
  const result = await runner(client).query(
    `SELECT ${GROUP_COLUMNS} FROM item_group WHERE code = $1${client && forUpdate ? ' FOR UPDATE' : ''}`,
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
    `SELECT ${GROUP_COLUMNS} FROM item_group ORDER BY code ASC`,
  );
  return result.rows.map(mapGroup);
}

// Item rows are read in one query with item_master.ts's own ITEM_COLUMNS and mapper, so a group
// or ungrouped listing costs one round trip and one snapshot regardless of how many items match.
export async function listActiveItemsByGroup(
  itemGroupId: string,
  client?: PoolClient,
): Promise<ItemMaster[]> {
  const result = await runner(client).query(
    `SELECT ${ITEM_COLUMNS} FROM item_master
      WHERE item_group_id = $1 AND status = 'active' ORDER BY sku ASC`,
    [itemGroupId],
  );
  return result.rows.map(mapRow);
}

export async function listUngroupedActiveItems(client?: PoolClient): Promise<ItemMaster[]> {
  const result = await runner(client).query(
    `SELECT ${ITEM_COLUMNS} FROM item_master
      WHERE item_group_id IS NULL AND status = 'active' ORDER BY sku ASC`,
  );
  return result.rows.map(mapRow);
}

/**
 * Shared guard (D6): the one place that decides whether a value may be written to
 * item_master.item_group_id (or to Story 4.8's scope_item_group_id). Returns the active group.
 * Non-UUID and unknown ids are both ITEM_GROUP_NOT_FOUND. With a client the row is read
 * FOR UPDATE, not FOR SHARE: the assignment path calls markEverAssigned on this same row straight
 * afterwards, and two share locks both waiting to upgrade to a write lock deadlock (40P01).
 */
export async function assertItemGroupAssignable(
  itemGroupId: unknown,
  client?: PoolClient,
): Promise<ItemGroup> {
  if (typeof itemGroupId !== 'string' || !UUID_REGEX.test(itemGroupId)) {
    throw new AppError(400, 'ITEM_GROUP_NOT_FOUND', 'item_group_id does not match any item group', {
      item_group_id: typeof itemGroupId === 'string' ? itemGroupId : null,
    });
  }
  const result = await runner(client).query(
    `SELECT ${GROUP_COLUMNS} FROM item_group WHERE item_group_id = $1${client ? ' FOR UPDATE' : ''}`,
    [itemGroupId],
  );
  if (result.rows.length === 0) {
    throw new AppError(400, 'ITEM_GROUP_NOT_FOUND', 'item_group_id does not match any item group', {
      item_group_id: itemGroupId,
    });
  }
  const group = mapGroup(result.rows[0]!);
  if (group.status !== 'active') {
    throw new AppError(400, 'ITEM_GROUP_INACTIVE', `Item group ${group.code} is inactive`, {
      item_group_id: itemGroupId,
      code: group.code,
    });
  }
  return group;
}

// ------------------------------------------------------------------------------------------
// Rights and recipient list
// ------------------------------------------------------------------------------------------

function mapRights(row: Record<string, unknown>): ItemGroupRightRow {
  return {
    user_id: row['user_id'] as string,
    create: row['can_create'] as boolean,
    edit: row['can_edit'] as boolean,
    delete: row['can_delete'] as boolean,
    granted_by: row['granted_by'] as string,
    updated_at: iso(row['updated_at']),
  };
}

const RIGHT_COLUMNS = 'user_id, can_create, can_edit, can_delete, granted_by, updated_at';

/** Rights of one user; a user with no row holds no right. */
export async function getItemGroupRights(
  userId: string,
  client?: PoolClient,
): Promise<ItemGroupRights> {
  const result = await runner(client).query(
    `SELECT ${RIGHT_COLUMNS} FROM item_group_right WHERE user_id = $1`,
    [userId],
  );
  if (result.rows.length === 0) return { create: false, edit: false, delete: false };
  const row = mapRights(result.rows[0]!);
  return { create: row.create, edit: row.edit, delete: row.delete };
}

/** The stored rights row for one user, or null when the user holds no right. */
export async function getItemGroupRightRow(
  userId: string,
  client?: PoolClient,
): Promise<ItemGroupRightRow | null> {
  const result = await runner(client).query(
    `SELECT ${RIGHT_COLUMNS} FROM item_group_right WHERE user_id = $1`,
    [userId],
  );
  return result.rows.length > 0 ? mapRights(result.rows[0]!) : null;
}

export async function listItemGroupRights(client?: PoolClient): Promise<ItemGroupRightRow[]> {
  const result = await runner(client).query(
    `SELECT ${RIGHT_COLUMNS} FROM item_group_right ORDER BY updated_at ASC, user_id ASC`,
  );
  return result.rows.map(mapRights);
}

/** Stores the rights for a user; all-false removes the row (revoke). Returns the stored row or null. */
export async function upsertItemGroupRights(
  userId: string,
  rights: ItemGroupRights,
  grantedBy: string,
  client?: PoolClient,
): Promise<ItemGroupRightRow | null> {
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
     RETURNING ${RIGHT_COLUMNS}`,
    [userId, rights.create, rights.edit, rights.delete, grantedBy],
  );
  return mapRights(result.rows[0]!);
}

export async function listItemGroupRecipients(client?: PoolClient): Promise<ItemGroupRecipient[]> {
  const result = await runner(client).query(
    `SELECT user_id, added_by, added_at FROM item_group_recipient ORDER BY added_at ASC, user_id ASC`,
  );
  return result.rows.map((row) => ({
    user_id: row['user_id'] as string,
    added_by: row['added_by'] as string,
    added_at: iso(row['added_at']),
  }));
}

/**
 * Adds a user to the recipient list. `added` is false when the user was already on it, and the
 * row always comes back: the conflict branch is a no-op UPDATE rather than DO NOTHING, because
 * DO NOTHING returns nothing and a concurrent uncommitted insert is invisible to a follow-up
 * SELECT on this snapshot.
 */
export async function addItemGroupRecipient(
  userId: string,
  addedBy: string,
  client?: PoolClient,
): Promise<{ row: ItemGroupRecipient; added: boolean }> {
  const result = await runner(client).query(
    `INSERT INTO item_group_recipient (user_id, added_by) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET added_by = item_group_recipient.added_by
     RETURNING user_id, added_by, added_at, (xmax = 0) AS inserted`,
    [userId, addedBy],
  );
  const row = result.rows[0]!;
  return {
    row: {
      user_id: row['user_id'] as string,
      added_by: row['added_by'] as string,
      added_at: iso(row['added_at']),
    },
    added: row['inserted'] === true,
  };
}

/** Removes a user from the recipient list; returns false when absent. */
export async function removeItemGroupRecipient(
  userId: string,
  client?: PoolClient,
): Promise<boolean> {
  const result = await runner(client).query(`DELETE FROM item_group_recipient WHERE user_id = $1`, [
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

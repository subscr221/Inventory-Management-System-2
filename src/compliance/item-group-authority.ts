import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import type { AuthContext } from '../middleware/context.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getItemGroupRights } from '../read/projections/item_group.js';
import type { ItemGroupRights } from '../read/projections/item_group.js';

/**
 * Story 2.10 authority and notification helpers for the item group master.
 *
 * Role membership lives in user_role_assignments (provisioned through SCIM or the roles file);
 * the per-person create/edit/delete rights are the small item_group_right projection (D3), checked
 * in the handler like the edge dispatch role gates. No new RBAC module.
 */

export const ITEM_GROUP_MAINTAINER_ROLE = 'inventory_controller';
export const ITEM_GROUP_GRANTOR_ROLES = ['ceo', 'finance_controller'] as const;

/**
 * Ruling roles notified of every item group change (Table 2 of Story 2.10): inventory controller,
 * CEO, Finance Head, finance team (finance_controller + cfo), site head, store controller.
 */
export const ITEM_GROUP_NOTIFY_ROLES = [
  'inventory_controller',
  'ceo',
  'finance_controller',
  'cfo',
  'site_head',
  'store_controller',
] as const;

/** 403 FUNCTION_ACCESS_DENIED unless the caller holds at least one of `roles` (any assignment). */
export function assertHoldsAnyRole(authContext: AuthContext, roles: readonly string[]): void {
  if (!authContext.roles.some((r) => roles.includes(r.role))) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', 'Not authorized for this item group action', {
      required_roles: [...roles],
    });
  }
}

/**
 * The caller must hold `inventory_controller` AND the named item group right. Role is checked
 * first so `warehouse_manager` and everyone else gets FUNCTION_ACCESS_DENIED, not a right error.
 */
export async function assertItemGroupRight(
  authContext: AuthContext,
  right: keyof ItemGroupRights,
  client: PoolClient,
): Promise<void> {
  assertHoldsAnyRole(authContext, [ITEM_GROUP_MAINTAINER_ROLE]);
  const rights = await getItemGroupRights(authContext.userId, client);
  if (!rights[right]) {
    throw new AppError(
      403,
      'ITEM_GROUP_RIGHT_REQUIRED',
      `The item group "${right}" right has not been granted to you`,
      { right },
    );
  }
}

export interface ItemGroupNotifyInput {
  actor: { user_id: string; role: string; location_id: string };
  /** What changed, e.g. 'created', 'updated', 'deleted', 'rights granted'. */
  status_verb: string;
  /** 'item_group', 'item', 'item_group_right' or 'item_group_recipient'. */
  object_type: string;
  object_id: string;
  correlation_id: string;
}

/**
 * Resolves the recipients of one item group change: active holders of every Table 2 role (any
 * location), every user on the recipient list, and the actor, de-duplicated into one set.
 */
export async function resolveItemGroupRecipients(
  client: PoolClient,
  actorUserId: string,
): Promise<string[]> {
  const result = await client.query(
    `SELECT user_id FROM (
       SELECT a.user_id FROM user_role_assignments a
         JOIN users u ON u.user_id = a.user_id AND u.active = true
        WHERE a.role = ANY($1::text[])
       UNION
       SELECT r.user_id FROM item_group_recipient r
         JOIN users u ON u.user_id = r.user_id AND u.active = true
       UNION
       SELECT $2::uuid
     ) recipients
     ORDER BY user_id`,
    [[...ITEM_GROUP_NOTIFY_ROLES], actorUserId],
  );
  return result.rows.map((row) => row['user_id'] as string);
}

/**
 * Emits exactly one notification per recipient user (user-targeted, Story 4.3) inside the caller's
 * open transaction, so a rollback emits nothing. Returns the recipient ids.
 */
export async function notifyItemGroupChange(
  client: PoolClient,
  input: ItemGroupNotifyInput,
): Promise<string[]> {
  const recipients = await resolveItemGroupRecipients(client, input.actor.user_id);
  for (const userId of recipients) {
    await emitNotificationInTransaction(
      {
        target: { role: 'item_group_watcher', user_id: userId },
        event_type: 'item_group_change',
        status_verb: input.status_verb,
        object_type: input.object_type,
        object_id: input.object_id,
        actor: input.actor,
        correlation_id: input.correlation_id,
      },
      client,
    );
  }
  return recipients;
}

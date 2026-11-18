import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import type { AuthContext } from '../middleware/context.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import {
  getItemGroupRights,
  listActiveItemGroupRecipientIds,
} from '../read/projections/item_group.js';
import type { ItemGroupRight } from '../read/projections/item_group.js';

/**
 * Story 2.10 authority over item groups (D3). Role membership stays in user_role_assignments
 * (provisioned through SCIM or the roles file); the per-person create / edit / delete rights are
 * the item_group_right projection. The role checks run in the handler, filtered across ALL of
 * the caller's assignments - the edge role-gate shape (src/api/v1/edge.ts), not a new mechanism.
 */

export const ITEM_GROUP_MAINTAINER_ROLE = 'inventory_controller';
/** Owner ruling 2026-10-02: only the CEO or the Finance Head grants rights or keeps the list. */
export const ITEM_GROUP_GRANTER_ROLES = ['ceo', 'finance_controller'] as const;
/** Owner ruling 2026-10-02: the one granter role that may grant item group rights to itself. */
export const ITEM_GROUP_SELF_GRANT_ROLE = 'ceo';
/** Story 2.10 Table 2: role holders told of every item group change, at every location. */
export const ITEM_GROUP_NOTIFIED_ROLES = [
  'inventory_controller',
  'ceo',
  'finance_controller',
  'cfo',
  'site_head',
  'store_controller',
] as const;

/** Throws 403 FUNCTION_ACCESS_DENIED unless the caller holds one of `roles` on any module. */
export function assertHoldsAnyRole(
  authContext: AuthContext | undefined,
  roles: readonly string[],
): void {
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (!authContext.roles.some((r) => roles.includes(r.role))) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `Requires one of: ${roles.join(', ')}`, {
      required_roles: [...roles],
    });
  }
}

/**
 * Requires the inventory_controller role, then the named right on the caller's own
 * item_group_right row. 403 FUNCTION_ACCESS_DENIED or 403 ITEM_GROUP_RIGHT_REQUIRED.
 */
export async function assertItemGroupRight(
  authContext: AuthContext | undefined,
  right: ItemGroupRight,
  client: PoolClient,
): Promise<void> {
  assertHoldsAnyRole(authContext, [ITEM_GROUP_MAINTAINER_ROLE]);
  const rights = await getItemGroupRights(authContext!.userId, client);
  if (!rights[right]) {
    throw new AppError(
      403,
      'ITEM_GROUP_RIGHT_REQUIRED',
      `The item group ${right} right has not been granted to you`,
      { right },
    );
  }
}

export interface ItemGroupChangeNotice {
  /** The domain event the change wrote, e.g. item_group.created or item.updated. */
  event_type: string;
  actor: { user_id: string; role: string; location_id: string };
  status_verb: string;
  object_type: string;
  object_id: string;
  correlation_id: string;
}

/**
 * AC 7: one in-app notification per user, in the caller's transaction, to the union of the
 * active Table 2 role holders (any location - groups are global), the active users on the
 * recipient list, and the actor (ruling round 3). The union is keyed by user id, so a user who
 * qualifies several ways is told once. Resolved after the change, so a user just removed from
 * the list is not told.
 */
export async function notifyItemGroupChange(
  client: PoolClient,
  notice: ItemGroupChangeNotice,
): Promise<number> {
  // user id -> the reason recorded as the delivery's target_role (first reason wins).
  const reasons = new Map<string, string>();
  const holders = await client.query(
    `SELECT a.user_id, a.role
       FROM user_role_assignments a JOIN users u ON u.user_id = a.user_id
      WHERE u.active AND a.role = ANY($1::text[])
      ORDER BY array_position($1::text[], a.role), a.user_id`,
    [[...ITEM_GROUP_NOTIFIED_ROLES]],
  );
  for (const row of holders.rows) {
    const userId = row['user_id'] as string;
    if (!reasons.has(userId)) reasons.set(userId, row['role'] as string);
  }
  for (const userId of await listActiveItemGroupRecipientIds(client)) {
    if (!reasons.has(userId)) reasons.set(userId, 'item_group_recipient');
  }
  if (!reasons.has(notice.actor.user_id)) reasons.set(notice.actor.user_id, notice.actor.role);

  for (const [userId, role] of reasons) {
    await emitNotificationInTransaction(
      {
        target: { role, user_id: userId },
        event_type: notice.event_type,
        status_verb: notice.status_verb,
        object_type: notice.object_type,
        object_id: notice.object_id,
        actor: notice.actor,
        correlation_id: notice.correlation_id,
      },
      client,
    );
  }
  return reasons.size;
}

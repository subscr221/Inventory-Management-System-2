import { randomUUID } from 'node:crypto';
import { persistEvent } from '../../events/store.js';
import {
  upsertUser,
  replaceRoleAssignments,
  deactivateUser,
  getUserIdByExternalId,
} from '../../read/projections/users.js';
import type { RoleAssignment } from '../../read/projections/users.js';
import { AppError } from '../../middleware/error.js';

export interface ProvisionUserRequest {
  externalId: string;
  email: string;
  displayName?: string | null;
  roles: RoleAssignment[];
}

// Sentinel identity for system-initiated (non-user-attributable) events, e.g. SCIM
// provisioning. Not a real user - satisfies the UUID convention on metadata.actor without
// inventing a non-UUID wildcard that would break other consumers of the event envelope.
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

function systemActorMetadata() {
  return {
    correlation_id: randomUUID(),
    actor: {
      user_id: SYSTEM_ACTOR_ID,
      role: 'scim_system',
      location_id: SYSTEM_ACTOR_ID,
    },
    occurred_at: new Date().toISOString(),
  };
}

/** Provisions (or reactivates) a user with the given role assignments. Emits `user.provisioned`. */
export async function provisionUser(input: ProvisionUserRequest): Promise<string> {
  const userId = await upsertUser({
    externalId: input.externalId,
    email: input.email,
    displayName: input.displayName ?? null,
    roles: input.roles,
  });
  await replaceRoleAssignments(userId, input.roles);

  await persistEvent({
    stream_type: 'user',
    stream_id: userId,
    event_type: 'user.provisioned',
    payload: {
      external_id: input.externalId,
      email: input.email,
      display_name: input.displayName ?? null,
      roles: input.roles,
    },
    metadata: systemActorMetadata(),
  });

  return userId;
}

/** Replaces a user's role assignments. Emits `user.roles_updated`. */
export async function updateUserRoles(externalId: string, roles: RoleAssignment[]): Promise<void> {
  const userId = await getUserIdByExternalId(externalId);
  if (!userId) {
    throw new AppError(404, 'NOT_FOUND', `No user found with externalId "${externalId}"`);
  }

  await replaceRoleAssignments(userId, roles);

  await persistEvent({
    stream_type: 'user',
    stream_id: userId,
    event_type: 'user.roles_updated',
    payload: { external_id: externalId, roles },
    metadata: systemActorMetadata(),
  });
}

/** Deactivates a user so their next request fails authentication. Emits `user.deprovisioned`. */
export async function deprovisionUser(externalId: string): Promise<void> {
  const userId = await getUserIdByExternalId(externalId);
  if (!userId) {
    throw new AppError(404, 'NOT_FOUND', `No user found with externalId "${externalId}"`);
  }

  const deactivated = await deactivateUser(externalId);
  if (!deactivated) {
    throw new AppError(404, 'NOT_FOUND', `No user found with externalId "${externalId}"`);
  }

  await persistEvent({
    stream_type: 'user',
    stream_id: userId,
    event_type: 'user.deprovisioned',
    payload: { external_id: externalId },
    metadata: systemActorMetadata(),
  });
}

import { randomUUID } from 'node:crypto';
import { persistEvent } from '../../events/store.js';
import { getPool } from '../../config/db.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';
import {
  upsertUserWithRoles,
  replaceRoleAssignments,
  deactivateUser,
  reactivateUser as reactivateUserRow,
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

// Role recorded in the EVENT ENVELOPE actor for SCIM-emitted events (pre-existing convention from
// Story 1.2 event streams). The AUDIT LOG actor uses the spec-mandated values below instead.
const SCIM_SYSTEM_ROLE = 'scim_system';

// Audit-log actor values per Task 6.3: role 'system', location_id '*'. The event envelope cannot
// use these (its metadata.actor.location_id must be a UUID per validateEnvelope), but audit_log
// has no such constraint - location_id is TEXT and '*' is the spec's system-wide marker.
const AUDIT_SYSTEM_ROLE = 'system';
const AUDIT_SYSTEM_LOCATION = '*';

function systemActorMetadata() {
  return {
    correlation_id: randomUUID(),
    actor: {
      user_id: SYSTEM_ACTOR_ID,
      role: SCIM_SYSTEM_ROLE,
      location_id: SYSTEM_ACTOR_ID,
    },
    occurred_at: new Date().toISOString(),
  };
}

// Audit context for SCIM-emitted events. Without this, persistEvent writes the domain event but no
// audit_log row (Task 6.3), so directory changes (provision/deprovision/role change/reactivate)
// would be invisible to the statutory edit log. The actor is the SCIM system principal; the
// trace_id is threaded from the originating HTTP request when available for end-to-end correlation.
// http_status records what the client actually receives: 201 for provisioning, 200 for PATCH flows.
function systemAuditCtx(endpoint: string, method: string, httpStatus: number, traceId?: string) {
  return {
    trace_id: traceId ?? randomUUID(),
    user_id: SYSTEM_ACTOR_ID,
    role: AUDIT_SYSTEM_ROLE,
    location_id: AUDIT_SYSTEM_LOCATION,
    endpoint,
    method,
    http_status: httpStatus,
  };
}

const SCIM_USERS_ENDPOINT = '/api/v1/scim/v2/Users';

/**
 * Writes a standalone audit entry (event_id null) for a mutating SCIM request that resulted in an
 * idempotent no-op - AC1 requires an edit-log record for ANY mutating API request, including ones
 * that changed nothing (e.g. re-deprovisioning an already-inactive user).
 */
async function logNoOpAuditEntry(endpoint: string, method: string, traceId: string | undefined, detail: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await logAuditEntry(client, {
      ...systemAuditCtx(endpoint, method, 200, traceId),
      event_id: null,
      error_code: null,
      details: { no_op: true, reason: detail },
    });
  } finally {
    client.release();
  }
}

/** Provisions (or reactivates) a user with the given role assignments. Emits `user.provisioned`. */
export async function provisionUser(input: ProvisionUserRequest, traceId?: string): Promise<string> {
  // Directory row + role assignments are written in one transaction (see upsertUserWithRoles).
  // The audit event is emitted after that transaction commits; if it fails the caller gets a 500
  // and the directory is already updated - acceptable for now, tracked as a follow-up to bring
  // the event into the same transaction as the directory write.
  const userId = await upsertUserWithRoles({
    externalId: input.externalId,
    email: input.email,
    displayName: input.displayName ?? null,
    roles: input.roles,
  });

  await persistEvent(
    {
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
    },
    systemAuditCtx(SCIM_USERS_ENDPOINT, 'POST', 201, traceId),
  );

  return userId;
}

/** Reactivates a previously deprovisioned user. Emits `user.reactivated` only on a real change. */
export async function reactivateUser(externalId: string, traceId?: string): Promise<void> {
  const userId = await getUserIdByExternalId(externalId);
  if (!userId) {
    throw new AppError(404, 'NOT_FOUND', `No user found with externalId "${externalId}"`);
  }

  const reactivated = await reactivateUserRow(externalId);
  if (reactivated) {
    await persistEvent(
      {
        stream_type: 'user',
        stream_id: userId,
        event_type: 'user.reactivated',
        payload: { external_id: externalId },
        metadata: systemActorMetadata(),
      },
      systemAuditCtx(`${SCIM_USERS_ENDPOINT}/${externalId}`, 'PATCH', 200, traceId),
    );
  } else {
    // Already active: idempotent no-op, no duplicate event - but the mutating request itself
    // still gets an edit-log record (AC1).
    await logNoOpAuditEntry(`${SCIM_USERS_ENDPOINT}/${externalId}`, 'PATCH', traceId, 'reactivate: user already active');
  }
}

/** Replaces a user's role assignments. Emits `user.roles_updated`. */
export async function updateUserRoles(externalId: string, roles: RoleAssignment[], traceId?: string): Promise<void> {
  const userId = await getUserIdByExternalId(externalId);
  if (!userId) {
    throw new AppError(404, 'NOT_FOUND', `No user found with externalId "${externalId}"`);
  }

  await replaceRoleAssignments(userId, roles);

  await persistEvent(
    {
      stream_type: 'user',
      stream_id: userId,
      event_type: 'user.roles_updated',
      payload: { external_id: externalId, roles },
      metadata: systemActorMetadata(),
    },
    systemAuditCtx(`${SCIM_USERS_ENDPOINT}/${externalId}`, 'PATCH', 200, traceId),
  );
}

/** Deactivates a user so their next request fails authentication. Emits `user.deprovisioned`. */
export async function deprovisionUser(externalId: string, traceId?: string): Promise<void> {
  const userId = await getUserIdByExternalId(externalId);
  if (!userId) {
    throw new AppError(404, 'NOT_FOUND', `No user found with externalId "${externalId}"`);
  }

  const deactivated = await deactivateUser(externalId);
  if (deactivated) {
    await persistEvent(
      {
        stream_type: 'user',
        stream_id: userId,
        event_type: 'user.deprovisioned',
        payload: { external_id: externalId },
        metadata: systemActorMetadata(),
      },
      systemAuditCtx(`${SCIM_USERS_ENDPOINT}/${externalId}`, 'PATCH', 200, traceId),
    );
  } else {
    // Already inactive: idempotent no-op, no duplicate event - but still edit-logged (AC1).
    await logNoOpAuditEntry(`${SCIM_USERS_ENDPOINT}/${externalId}`, 'PATCH', traceId, 'deprovision: user already inactive');
  }
}

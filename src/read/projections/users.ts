import { randomUUID } from 'node:crypto';
import { getPool } from '../../config/db.js';

export interface RoleAssignment {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

export interface UserWithRoles {
  userId: string;
  externalId: string;
  email: string;
  displayName: string | null;
  active: boolean;
  roles: RoleAssignment[];
}

export interface ProvisionUserInput {
  externalId: string;
  email: string;
  displayName?: string | null;
  roles: RoleAssignment[];
}

/**
 * Provisions a user and their role assignments atomically in a single transaction: creates a new
 * directory row (or reactivates + refreshes an existing one matched by external_id) and replaces
 * all role rows. Doing both in one transaction removes the concurrent delete/insert role race and
 * the partial-directory-state window that separate calls would leave. Returns the internal user_id.
 */
export async function upsertUserWithRoles(input: ProvisionUserInput): Promise<string> {
  const pool = getPool();
  const client = await pool.connect();
  const newUserId = randomUUID();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO users (user_id, external_id, email, display_name, active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (external_id) DO UPDATE
         SET email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             active = true,
             deprovisioned_at = NULL
       RETURNING user_id`,
      [newUserId, input.externalId, input.email, input.displayName ?? null],
    );
    const userId = result.rows[0]!['user_id'] as string;

    await client.query('DELETE FROM user_role_assignments WHERE user_id = $1', [userId]);
    for (const role of input.roles) {
      await client.query(
        `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, role.role, role.module, role.functionScope, role.locationId],
      );
    }

    await client.query('COMMIT');
    return userId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Replaces all role assignments for a user with the provided list (delete + insert, transactional). */
export async function replaceRoleAssignments(userId: string, roles: RoleAssignment[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_role_assignments WHERE user_id = $1', [userId]);
    for (const role of roles) {
      await client.query(
        `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, role.role, role.module, role.functionScope, role.locationId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deactivates an active user by external_id. Returns false if no matching ACTIVE user was found
 * (already deprovisioned or absent), which lets callers stay idempotent and avoid emitting a
 * duplicate `user.deprovisioned` event on a repeat/concurrent deprovision.
 */
export async function deactivateUser(externalId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE users SET active = false, deprovisioned_at = now() WHERE external_id = $1 AND active = true RETURNING user_id`,
    [externalId],
  );
  return result.rows.length > 0;
}

/**
 * Reactivates a previously deprovisioned user by external_id. Returns false if no matching
 * INACTIVE user was found (already active or absent), so callers avoid emitting a duplicate
 * `user.reactivated` event on a repeat reactivation.
 */
export async function reactivateUser(externalId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE users SET active = true, deprovisioned_at = NULL WHERE external_id = $1 AND active = false RETURNING user_id`,
    [externalId],
  );
  return result.rows.length > 0;
}

/**
 * Looks up an active user and their current role assignments by external_id (IdP subject).
 * Returns null if the user does not exist or has been deprovisioned (active = false).
 * Always queries fresh - no caching - so deprovisioning takes effect on the very next call.
 */
export async function lookupActiveUserWithRoles(externalId: string): Promise<UserWithRoles | null> {
  const pool = getPool();
  const userResult = await pool.query(
    `SELECT user_id, external_id, email, display_name, active FROM users WHERE external_id = $1 AND active = true`,
    [externalId],
  );
  if (userResult.rows.length === 0) {
    return null;
  }
  const row = userResult.rows[0]!;

  const rolesResult = await pool.query(
    `SELECT role, module, function_scope, location_id FROM user_role_assignments WHERE user_id = $1`,
    [row['user_id']],
  );

  return {
    userId: row['user_id'] as string,
    externalId: row['external_id'] as string,
    email: row['email'] as string,
    displayName: row['display_name'] as string | null,
    active: row['active'] as boolean,
    roles: rolesResult.rows.map((r) => ({
      role: r['role'] as string,
      module: r['module'] as string,
      functionScope: r['function_scope'] as 'read' | 'write',
      locationId: r['location_id'] as string,
    })),
  };
}

/** Returns the internal user_id for a given external_id, regardless of active status, or null if not found. */
export async function getUserIdByExternalId(externalId: string): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT user_id FROM users WHERE external_id = $1`, [externalId]);
  return result.rows.length > 0 ? (result.rows[0]!['user_id'] as string) : null;
}

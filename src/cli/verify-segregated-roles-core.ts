import type pg from 'pg';

/**
 * Go-live verification for role pairs that exist ONLY to separate duties (Story 9.7 Task 0).
 *
 * A separation-of-duties control is not implemented by writing an approval check; it is implemented
 * by the check PLUS two different real people holding the two roles. This module verifies the
 * second half, which no unit test and no code review can see, because it is data in the running
 * environment rather than logic in the repository.
 *
 * Everything here is READ-ONLY. It provisions nothing: users arrive through SCIM and DOA bands
 * through the Story 1.4 registry API, both of which are administrative acts against a live system.
 *
 * WHY EACH CHECK EXISTS - every one of these has a failure mode that leaves the guard looking
 * healthy while the control is absent:
 *
 *   - ROLE_UNHELD: `resolveApprover` (src/api/v1/indents.ts:66-95) resolves the approver from the
 *     holders of the banded role. With no holder it returns a null approver and the seam refuses
 *     APPROVAL_UNRESOLVED, so an unprovisioned approver role blocks every above-band posting and an
 *     unheld setter role blocks the posting outright. That is fail-closed and correct, but it is an
 *     outage discovered by an operator at the worst moment unless it is checked beforehand.
 *   - ROLES_SHARE_HOLDER: one person holding both roles satisfies every code path in the system
 *     while the control does not exist. This is the failure the whole pair exists to prevent.
 *   - DOA_BAND_MISSING: with no active band for the transaction type, `findMatchingDoaEntry`
 *     matches nothing, `resolveApprover` reports no approval required, and the posting proceeds
 *     UNSIGNED at any value.
 *   - DOA_TYPE_MULTI_ROLE: `resolveApprover` falls back to the holder of any OTHER role banded
 *     under the same transaction type when the matched band's role has no holder. A second role on
 *     the type therefore silently resolves the second signature to somebody else, with every test
 *     still green.
 *   - DELEGATION_COLLAPSES_PAIR: `resolveApprover` honours active vacation delegations, so a
 *     delegation from the approver to the setter (or the reverse) hands both halves back to one
 *     person for the life of the delegation.
 */

export interface SegregatedRolePair {
  /** The DOA transaction type whose band the approver signs. */
  transactionType: string;
  /** The role that sets the value being approved. */
  setterRole: string;
  /** The role that co-signs it. Must be the ONLY role banded on `transactionType`. */
  approverRole: string;
  /** Why the pair must stay on two people, quoted back in operator-facing output. */
  reason: string;
}

/**
 * The pairs this deployment must satisfy before go-live. Story 9.7 (FR-JW-09/10) adds the first:
 * the finance controller sets the offcut acquisition rate and the CFO co-signs it above the band.
 * With no rate tolerance anywhere (the 2026-09-05 ruling removed the band on the rate itself),
 * this separation is the ONLY control over what the processor pays a customer for their offcut.
 */
export const SEGREGATED_ROLE_PAIRS: readonly SegregatedRolePair[] = [
  {
    transactionType: 'jobwork.offcut_acquisition',
    setterRole: 'finance_controller',
    approverRole: 'cfo',
    reason:
      'the finance controller sets the offcut acquisition rate and the CFO co-signs it, so nobody both prices a customer offcut and approves paying for it',
  },
];

export type SegregationViolationCode =
  | 'ROLE_UNHELD'
  | 'ROLES_SHARE_HOLDER'
  | 'DOA_BAND_MISSING'
  | 'DOA_TYPE_MULTI_ROLE'
  | 'DELEGATION_COLLAPSES_PAIR';

export interface SegregationViolation {
  code: SegregationViolationCode;
  transaction_type: string;
  /** Operator-facing sentence naming the fix, not just the fault. */
  message: string;
  details: Record<string, unknown>;
}

export interface SegregatedPairReport {
  transaction_type: string;
  setter_role: string;
  approver_role: string;
  setter_holder_user_ids: string[];
  approver_holder_user_ids: string[];
  active_band_count: number;
  ok: boolean;
}

export interface VerifySegregatedRolesResult {
  pairs: SegregatedPairReport[];
  violations: SegregationViolation[];
  ok: boolean;
}

interface HolderRow {
  user_id: string;
  external_id: string;
}

/** Active holders of a role, deduplicated: one user may hold a role at several locations. */
async function activeHoldersOf(pool: pg.Pool, role: string): Promise<HolderRow[]> {
  const result = await pool.query(
    `SELECT DISTINCT u.user_id, u.external_id
       FROM user_role_assignments a
       JOIN users u ON u.user_id = a.user_id
      WHERE a.role = $1 AND u.active = true
      ORDER BY u.external_id ASC`,
    [role],
  );
  return result.rows as HolderRow[];
}

async function activeBandRolesOf(pool: pg.Pool, transactionType: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT role FROM doa_registry_entries
      WHERE transaction_type = $1 AND active = true
      ORDER BY role ASC`,
    [transactionType],
  );
  return (result.rows as { role: string }[]).map((row) => row.role);
}

async function activeBandCount(pool: pg.Pool, transactionType: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM doa_registry_entries
      WHERE transaction_type = $1 AND active = true`,
    [transactionType],
  );
  return (result.rows[0] as { n: number }).n;
}

/**
 * Delegations that hand one side of the pair to a holder of the other side, today. Both directions
 * are checked: `resolveApprover` substitutes the delegate for the delegator, so a delegation from
 * the approver to the setter is the collapse, and one from the setter to the approver puts the same
 * person on both ends of any posting the delegate makes.
 */
async function collapsingDelegations(
  pool: pg.Pool,
  setterIds: string[],
  approverIds: string[],
  today: string,
): Promise<{ delegator_user_id: string; delegate_user_id: string; end_date: string }[]> {
  if (setterIds.length === 0 || approverIds.length === 0) return [];
  const result = await pool.query(
    `SELECT delegator_user_id, delegate_user_id, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM doa_vacation_delegations
      WHERE active = true
        AND start_date <= $3::date AND end_date >= $3::date
        AND (
          (delegator_user_id = ANY($1::uuid[]) AND delegate_user_id = ANY($2::uuid[]))
          OR (delegator_user_id = ANY($2::uuid[]) AND delegate_user_id = ANY($1::uuid[]))
        )
      ORDER BY end_date ASC`,
    [approverIds, setterIds, today],
  );
  return result.rows as { delegator_user_id: string; delegate_user_id: string; end_date: string }[];
}

/**
 * Verifies every declared pair. Returns the findings rather than throwing: the CLI decides the exit
 * code, and an integration test can assert on the structure.
 *
 * `today` is passed in so a test can exercise a delegation window without waiting for the calendar
 * (the Story 8.7 sweep idiom).
 */
export async function verifySegregatedRoles(
  pool: pg.Pool,
  pairs: readonly SegregatedRolePair[] = SEGREGATED_ROLE_PAIRS,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<VerifySegregatedRolesResult> {
  const reports: SegregatedPairReport[] = [];
  const violations: SegregationViolation[] = [];

  for (const pair of pairs) {
    const before = violations.length;
    const setters = await activeHoldersOf(pool, pair.setterRole);
    const approvers = await activeHoldersOf(pool, pair.approverRole);
    const setterIds = setters.map((row) => row.user_id);
    const approverIds = approvers.map((row) => row.user_id);

    for (const [role, holders] of [
      [pair.setterRole, setters],
      [pair.approverRole, approvers],
    ] as const) {
      if (holders.length === 0) {
        violations.push({
          code: 'ROLE_UNHELD',
          transaction_type: pair.transactionType,
          message: `No active user holds "${role}". Assign it through SCIM before go-live: ${pair.reason}.`,
          details: { role },
        });
      }
    }

    const shared = setters.filter((row) => approverIds.includes(row.user_id));
    if (shared.length > 0) {
      violations.push({
        code: 'ROLES_SHARE_HOLDER',
        transaction_type: pair.transactionType,
        message: `"${pair.setterRole}" and "${pair.approverRole}" are held by the same user, so the separation does not exist. Move one role to a different person: ${pair.reason}.`,
        details: {
          setter_role: pair.setterRole,
          approver_role: pair.approverRole,
          shared_user_ids: shared.map((row) => row.user_id),
          shared_external_ids: shared.map((row) => row.external_id),
        },
      });
    }

    const bandRoles = await activeBandRolesOf(pool, pair.transactionType);
    const bands = await activeBandCount(pool, pair.transactionType);
    if (bands === 0) {
      violations.push({
        code: 'DOA_BAND_MISSING',
        transaction_type: pair.transactionType,
        message: `No active DOA band governs "${pair.transactionType}", so postings of any value proceed unsigned. Register a band for "${pair.approverRole}".`,
        details: { approver_role: pair.approverRole },
      });
    }
    const foreignRoles = bandRoles.filter((role) => role !== pair.approverRole);
    if (foreignRoles.length > 0) {
      violations.push({
        code: 'DOA_TYPE_MULTI_ROLE',
        transaction_type: pair.transactionType,
        message: `"${pair.transactionType}" carries bands for roles other than "${pair.approverRole}". Approver resolution falls back across roles within one transaction type, so the second signature can resolve to one of these instead. Deactivate them or move them to their own transaction type.`,
        details: { approver_role: pair.approverRole, foreign_roles: foreignRoles },
      });
    }

    const delegations = await collapsingDelegations(pool, setterIds, approverIds, today);
    if (delegations.length > 0) {
      violations.push({
        code: 'DELEGATION_COLLAPSES_PAIR',
        transaction_type: pair.transactionType,
        message: `An active vacation delegation puts "${pair.setterRole}" and "${pair.approverRole}" back on one person. Delegate to somebody outside the pair for the rest of the window.`,
        details: { delegations },
      });
    }

    reports.push({
      transaction_type: pair.transactionType,
      setter_role: pair.setterRole,
      approver_role: pair.approverRole,
      setter_holder_user_ids: setterIds,
      approver_holder_user_ids: approverIds,
      active_band_count: bands,
      ok: violations.length === before,
    });
  }

  return { pairs: reports, violations, ok: violations.length === 0 };
}

/** Operator-facing rendering, shared by the CLI so the format is covered by the same tests. */
export function formatSegregatedRolesReport(result: VerifySegregatedRolesResult): string {
  const lines: string[] = [];
  for (const pair of result.pairs) {
    lines.push(
      `${pair.ok ? 'OK  ' : 'FAIL'} ${pair.transaction_type}: ${pair.setter_role} (${pair.setter_holder_user_ids.length} holder(s)) signed off by ${pair.approver_role} (${pair.approver_holder_user_ids.length} holder(s)), ${pair.active_band_count} active band(s)`,
    );
  }
  for (const violation of result.violations) {
    lines.push(`  ${violation.code}: ${violation.message}`);
  }
  lines.push(
    result.ok
      ? 'All segregated role pairs are provisioned on separate users.'
      : `${result.violations.length} violation(s). This deployment is NOT ready for go-live.`,
  );
  return lines.join('\n');
}

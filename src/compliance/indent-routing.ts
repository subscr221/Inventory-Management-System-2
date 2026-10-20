import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';

/**
 * Story 4.10: per-line approval routing for a requisition. Every line resolves its own DOA band on
 * its own value (AC 2); the approver is the band role's holder or that holder's active delegate,
 * exactly as Story 4.3 resolved the header. Roles are read from the registry only (AD-3) - this
 * module names none.
 */
export const INDENT_DOA_TYPE = 'indent_approval';

export interface RoutableLine {
  requested_qty?: unknown;
  unit_price_estimate?: unknown;
}

export interface LineRoute {
  approval_route: 'doa' | 'standing_approval' | 'self_approval';
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  requires_approval: boolean;
  line_value: number;
}

/** Story 4.8 seam: a line index already routed by a grant skips DOA resolution. */
export type PreRouted = Map<number, { approval_route: LineRoute['approval_route'] }>;

/** requested_qty * unit_price_estimate rounded to 4 decimals; a null price is a zero value (D2). */
export function lineValueOf(line: RoutableLine): number {
  const qty = typeof line.requested_qty === 'number' ? line.requested_qty : 0;
  const price = typeof line.unit_price_estimate === 'number' ? line.unit_price_estimate : 0;
  return Number((qty * price).toFixed(4));
}

async function resolveLineApprover(
  transactionType: string,
  value: number,
  lineNo: number,
  client?: PoolClient,
): Promise<{ approverActorId: string; doaEntryId: string }> {
  const doaEntry = await findMatchingDoaEntry(transactionType, value, client);
  if (!doaEntry) {
    // AC 6: no band, no store - the raise is refused before anything is persisted.
    throw new AppError(
      409,
      'INDENT_APPROVAL_BAND_MISSING',
      `Line ${lineNo} (value ${value}) matches no active approval band`,
      { line_no: lineNo, line_value: value, transaction_type: transactionType },
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const tryHolder = async (role: string): Promise<string | null> => {
    const holder = await findRoleHolder(role, client);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today, client);
    return delegation?.delegate_user_id ?? holder.user_id;
  };
  let approver = await tryHolder(doaEntry.role);
  if (!approver) {
    for (const e of await listActiveDoaEntries(transactionType, client)) {
      if (e.role === doaEntry.role) continue;
      approver = await tryHolder(e.role);
      if (approver) break;
    }
  }
  if (!approver) {
    throw new AppError(
      409,
      'APPROVAL_UNRESOLVED',
      'Approval is required but no active approver could be resolved',
      { transaction_type: transactionType, line_no: lineNo },
    );
  }
  return { approverActorId: approver, doaEntryId: doaEntry.entry_id };
}

export async function routeIndentLines(
  lines: RoutableLine[],
  client?: PoolClient,
  preRouted?: PreRouted,
): Promise<LineRoute[]> {
  const routes: LineRoute[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (typeof lines[i] !== 'object' || lines[i] === null) {
      throw new AppError(400, 'INVALID_PARAMS', `Line ${i + 1}: must be an object`);
    }
    const value = lineValueOf(lines[i]!);
    const pre = preRouted?.get(i);
    if (pre) {
      routes.push({
        approval_route: pre.approval_route,
        approver_actor_id: null,
        doa_entry_id: null,
        requires_approval: false,
        line_value: value,
      });
      continue;
    }
    const r = await resolveLineApprover(INDENT_DOA_TYPE, value, i + 1, client);
    routes.push({
      approval_route: 'doa',
      approver_actor_id: r.approverActorId,
      doa_entry_id: r.doaEntryId,
      requires_approval: true,
      line_value: value,
    });
  }
  return routes;
}

/** Header approver for compatibility (D5): the highest-value DOA line, ties to the lowest line_no. */
export function headerApproverOf(routes: LineRoute[]): {
  approver_actor_id: string | null;
  doa_entry_id: string | null;
} {
  let best: LineRoute | null = null;
  for (const r of routes) {
    if (r.approval_route !== 'doa') continue;
    if (!best || r.line_value > best.line_value) best = r;
  }
  return {
    approver_actor_id: best?.approver_actor_id ?? null,
    doa_entry_id: best?.doa_entry_id ?? null,
  };
}

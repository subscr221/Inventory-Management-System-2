import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from '../middleware/error.js';
import { INDENT_DOA_TYPE, resolveLineApprover } from '../compliance/indent-routing.js';
import { logAuditEntry } from '../read/projections/audit_log.js';

/**
 * Story 4.9: indents stored before the fallback existed can hold a pending DOA line with no
 * approver (NOT_RESOLVED_APPROVER for everyone). Report mode only reads. Apply mode re-resolves
 * each line through the same resolver as capture (band, else the department_head fallback) in its
 * own transaction and audits it; a line that cannot be resolved stays listed as an exception.
 */
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export interface StuckLine {
  indent_line_id: string;
  indent_id: string;
  line_no: number;
  line_value: string;
}

export interface ReresolveResult {
  stuck: StuckLine[];
  fixed: Array<StuckLine & { approver_actor_id: string; fallback_reason: string | null }>;
  exceptions: Array<StuckLine & { error_code: string; message: string }>;
  skipped: Array<StuckLine & { reason: string }>;
}

const STUCK_SQL = `SELECT l.indent_line_id, l.indent_id, l.line_no, l.line_value::text AS line_value
  FROM indent_line l JOIN indent i ON i.indent_id = l.indent_id
  WHERE l.line_status = 'pending' AND l.approver_actor_id IS NULL
    AND l.approval_route = 'doa' AND i.status = 'raised'
  ORDER BY i.created_at, l.line_no`;

export async function reresolveStuckIndents(
  pool: Pool,
  opts: { apply: boolean },
): Promise<ReresolveResult> {
  const stuck = (await pool.query(STUCK_SQL)).rows as StuckLine[];
  const result: ReresolveResult = { stuck, fixed: [], exceptions: [], skipped: [] };
  if (!opts.apply) return result;
  for (const line of stuck) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT i.requester_user_id FROM indent_line l JOIN indent i ON i.indent_id = l.indent_id
          WHERE l.indent_line_id = $1 AND l.line_status = 'pending' AND l.approver_actor_id IS NULL
            AND l.approval_route = 'doa' AND i.status = 'raised' FOR UPDATE OF l`,
        [line.indent_line_id],
      );
      if (locked.rowCount === 0) {
        await client.query('ROLLBACK');
        result.skipped.push({ ...line, reason: 'no longer stuck or not raised' });
        continue;
      }
      const r = await resolveLineApprover(
        INDENT_DOA_TYPE,
        line.line_value,
        line.line_no,
        client,
        locked.rows[0].requester_user_id as string,
      );
      await client.query(
        `UPDATE indent_line SET approver_actor_id = $2, doa_entry_id = $3::uuid, fallback_reason = $4
         WHERE indent_line_id = $1`,
        [line.indent_line_id, r.approverActorId, r.doaEntryId, r.fallbackReason],
      );
      await client.query(
        `UPDATE indent SET approver_actor_id = (
           SELECT approver_actor_id::uuid FROM indent_line WHERE indent_id = $1 AND approval_route = 'doa'
           ORDER BY line_value DESC, line_no LIMIT 1)
         WHERE indent_id = $1 AND approver_actor_id IS NULL`,
        [line.indent_id],
      );
      await logAuditEntry(client, {
        trace_id: randomUUID(),
        user_id: SYSTEM_USER,
        role: 'system',
        location_id: '*',
        endpoint: 'cli:reresolve-stuck-indents',
        method: 'POST',
        event_id: null,
        http_status: 200,
        error_code: null,
        details: {
          action: 'indent.line.reresolved',
          indent_id: line.indent_id,
          indent_line_id: line.indent_line_id,
          line_no: line.line_no,
          approver_actor_id: r.approverActorId,
          doa_entry_id: r.doaEntryId,
          fallback_reason: r.fallbackReason,
        },
      });
      await client.query('COMMIT');
      result.fixed.push({
        ...line,
        approver_actor_id: r.approverActorId,
        fallback_reason: r.fallbackReason,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      result.exceptions.push({
        ...line,
        error_code: err instanceof AppError ? err.errorCode : 'UNEXPECTED',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  }
  return result;
}

export function formatReresolveReport(r: ReresolveResult, apply: boolean): string {
  const out = [`Stuck indent lines (pending, no approver): ${r.stuck.length}`];
  for (const l of r.stuck)
    out.push(`  indent ${l.indent_id} line ${l.line_no} value ${l.line_value}`);
  if (!apply)
    return [...out, 'Report mode: nothing changed. Re-run with --apply to route them.'].join('\n');
  out.push(`Re-resolved: ${r.fixed.length}`);
  out.push(`Skipped (no longer stuck or not raised): ${r.skipped.length}`);
  out.push(`Exceptions (unchanged): ${r.exceptions.length}`);
  for (const e of r.exceptions)
    out.push(`  indent ${e.indent_id} line ${e.line_no}: ${e.error_code} ${e.message}`);
  return out.join('\n');
}

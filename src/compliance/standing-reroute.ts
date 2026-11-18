import { getPool } from '../config/db.js';
import { AppError } from '../middleware/error.js';
import {
  getIndentById,
  getIndentLines,
  rerouteLineToDoa,
  updateIndentStatus,
} from '../read/projections/indent.js';
import { logAuditEntry } from '../read/projections/audit_log.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { deriveIndentStatus } from './indent.js';
import { INDENT_DOA_TYPE, resolveLineApprover } from './indent-routing.js';

/**
 * Story 4.8 (D8, AC 3): a line whose standing approval lapsed (over the monthly cap, revoked,
 * expired) falls back to the normal DOA approval path - never rejected, never silently approved.
 *
 * It runs in its OWN committed transaction, after the stores issue that discovered the lapse has
 * been refused and rolled back: the issue transaction holds the line locks and its rollback would
 * otherwise take the reroute with it. Each line is re-checked under the lock and handled in its own
 * savepoint, so one line whose DOA approver cannot be resolved (Story 4.9 owns that fallback) is
 * reported and left as it was while the others move.
 */

export interface RerouteResult {
  rerouted: string[];
  failed: Array<{ indent_line_id: string; error_code: string }>;
}

export interface RerouteActor {
  user_id: string;
  role: string;
  location_id: string;
}

export async function rerouteLapsedLinesToDoa(
  indentId: string,
  lapsed: Array<{ indent_line_id: string; reason?: string; standing_grant_id?: string | null }>,
  actor: RerouteActor,
  correlationId: string | null,
): Promise<RerouteResult> {
  const result: RerouteResult = { rerouted: [], failed: [] };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const indent = await getIndentById(indentId, client, true);
    if (!indent) {
      await client.query('ROLLBACK');
      return result;
    }
    const lines = await getIndentLines(indentId, client, true);
    const now = new Date().toISOString();
    for (const item of lapsed) {
      const line = lines.find((l) => l.indent_line_id === item.indent_line_id);
      // Re-read under the lock: a line already moved or decided elsewhere is left alone.
      if (!line || line.approval_route !== 'standing_approval') continue;
      await client.query('SAVEPOINT standing_reroute');
      try {
        const route = await resolveLineApprover(
          INDENT_DOA_TYPE,
          line.line_value,
          line.line_no,
          client,
        );
        const updated = await rerouteLineToDoa(client, line.indent_line_id, {
          approver_actor_id: route.approverActorId,
          doa_entry_id: route.doaEntryId,
        });
        if (!updated) {
          await client.query('RELEASE SAVEPOINT standing_reroute');
          continue;
        }
        line.approval_route = 'doa';
        line.line_status = 'pending';
        line.decided_at = null;
        line.decided_by = null;
        line.approver_actor_id = route.approverActorId;
        line.doa_entry_id = route.doaEntryId;
        await logAuditEntry(client, {
          trace_id: correlationId ?? '',
          user_id: actor.user_id,
          role: actor.role,
          location_id: actor.location_id,
          endpoint: `/indents/${indentId}/issue`,
          method: 'POST',
          event_id: null,
          http_status: 409,
          error_code: 'indent.line_rerouted',
          details: {
            indent_id: indentId,
            indent_line_id: line.indent_line_id,
            line_no: line.line_no,
            sku: line.sku,
            standing_grant_id: line.standing_grant_id,
            reason: item.reason ?? 'standing_approval_lapsed',
            approver_actor_id: route.approverActorId,
            doa_entry_id: route.doaEntryId,
          },
        });
        await emitNotificationInTransaction(
          {
            target: { role: actor.role, user_id: route.approverActorId },
            event_type: 'approval_received',
            status_verb: 'awaiting',
            object_type: 'indent',
            object_id: indentId,
            actor_label: `Indent ${indent.indent_number_ext}`,
            next_step: `Line ${line.line_no} ${line.sku} needs your approval: its standing approval no longer covers it`,
            actor,
            ...(correlationId ? { correlation_id: correlationId } : {}),
            occurred_at: now,
          },
          client,
        );
        await client.query('RELEASE SAVEPOINT standing_reroute');
        result.rerouted.push(line.indent_line_id);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT standing_reroute');
        result.failed.push({
          indent_line_id: item.indent_line_id,
          error_code: err instanceof AppError ? err.errorCode : 'REROUTE_FAILED',
        });
      }
    }
    if (
      result.rerouted.length > 0 &&
      (indent.status === 'raised' || indent.status === 'approved')
    ) {
      const derived = deriveIndentStatus(lines);
      if (derived.status !== indent.status) {
        await updateIndentStatus(
          indentId,
          derived.status,
          {
            decided_at: derived.decided_at,
            decided_by: /^[0-9a-f-]{36}$/i.test(derived.decided_by ?? '')
              ? derived.decided_by
              : null,
            rejection_reason: derived.rejection_reason,
          },
          client,
        );
      }
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

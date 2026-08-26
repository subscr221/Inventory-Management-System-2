import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { emitNotification } from '../notify/emit.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { getAssetById } from '../read/projections/asset.js';
import {
  getExaminationById,
  listOverdueExaminationsDue,
} from '../read/projections/statutory_examination.js';

/**
 * Story 7.6 statutory examination scan cycle (FR-M-14, AC1 / AC2). A pure function driven by the
 * authenticated POST trigger in src/api/v1/maintenance.ts, mirroring src/maintenance/calibration-jobs.ts
 * (Binding Decision 8). There is deliberately NO scheduler, no timer and no container: the only
 * setInterval in the process is the Story 1.11 notification dispatcher, and every other periodic
 * cycle in this codebase is a POST with an explicit business_date.
 *
 * business_date is the ONLY notion of "today" inside the job (the src/maintenance/pm-jobs.ts
 * header). Wall-clock time is used solely for flagged_at, which is a TIMESTAMPTZ instant with an
 * explicit offset. Every date comparison happens in SQL DATE arithmetic, never in JS.
 *
 * Each examination is processed in its OWN transaction: the row it decides on is locked FOR UPDATE
 * and the resulting event is persisted through persistEvent on that SAME client, so two concurrent
 * scans serialize into exactly one overdue flip. A lost race rejects
 * DUPLICATE_STATUTORY_EXAMINATION_OVERDUE from the seam and is skipped rather than failing the
 * whole scan (the Story 7.5 breach-scan pattern). Notifications are emitted AFTER the transaction
 * commits, using the non-throwing emitNotification (AD-17), so a notification failure can never
 * roll back an overdue flip.
 *
 * The register carries no asset location (assets are enterprise-scoped per AD-9), so the overdue
 * notification is emitted with location_id null, which targets EVERY holder of the supervisor role
 * regardless of location (src/notify/emit.ts). Scoping it to the location of whoever happened to run
 * the scan would silently drop the AC1 lockout alert for every asset outside that location while
 * still counting as delivered - the Notification Contract's '<asset location>' cannot be honoured
 * literally, and the unscoped fan-out is the option that reaches the people who can act on it.
 *
 * Write counters and delivery counters are kept SEPARATE in the result, so a dropped notification
 * stays visible instead of hiding behind the write count (the Story 7.2 and 7.4 lesson). A row that
 * fails is recorded and skipped rather than thrown out of the scan: the flips already committed are
 * real, and losing the result body would leave the operator with locked assets and no idea which.
 */

export type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

export interface StatutoryScanActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface StatutoryScanScope {
  business_date: string;
  asset_id?: string | undefined;
  actor: StatutoryScanActor;
  auditCtx?: AuditCtx | undefined;
}

export interface StatutoryScanResult {
  business_date: string;
  examinations_evaluated: number;
  examinations_overdue: number;
  notifications_delivered: number;
  notifications_dropped: number;
  overdue_examination_ids: string[];
  /** Grains this pass could not settle. Never silently empty: a skipped row is a visible one. */
  examinations_failed: string[];
}

const ESCALATION_WINDOW_SECONDS = 300;
const SUPERVISOR_ROLE = 'maintenance_supervisor';
const MANAGER_ROLE = 'maintenance_manager';

function isAppErrorWithCode(err: unknown, code: string): boolean {
  return err instanceof AppError && err.errorCode === code;
}

/** Runs `work` inside its own transaction, rolling back unless it signals success. */
async function inTransaction<T>(
  work: (client: PoolClient) => Promise<T | null>,
): Promise<T | null> {
  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A rollback failure on an already-aborted connection must not mask the original error.
      }
    }
    client.release();
  }
}

/**
 * The overdue flip contract (AC1 / AC2): every compliant statutory examination whose next_due_date
 * is strictly before business_date is flipped to 'overdue', which locks the asset from use (AC1)
 * and blocks trade weighment on the device (AC2). A re-stamp committed between the scope read and
 * the row lock re-checks status under the lock and is skipped; a concurrent scan's flip is skipped
 * via the DUPLICATE_STATUTORY_EXAMINATION_OVERDUE catch. No staged pre-due alerts exist (Binding
 * Decision 9); the overdue flip emits the escalating notification.
 */
export async function runStatutoryExaminationScan(
  scope: StatutoryScanScope,
): Promise<StatutoryScanResult> {
  const due = await listOverdueExaminationsDue(scope.business_date, undefined, scope.asset_id);

  const overdueExaminationIds: string[] = [];
  const examinationsFailed: string[] = [];
  let notificationsDelivered = 0;
  let notificationsDropped = 0;

  for (const examination of due) {
    const flaggedAt = new Date().toISOString();
    const correlationId = randomUUID();

    let flipped = false;
    try {
      flipped =
        (await inTransaction(async (client) => {
          // Lock the examination row so a concurrent scan (or a re-stamp) for this grain
          // serializes: the loser waits, then sees the flip the winner committed and skips it.
          const locked = await getExaminationById(examination.examination_id, client, true);
          if (!locked) return null;
          if (locked.status !== 'compliant') return null;
          if (locked.next_due_date !== examination.next_due_date) return null;
          if (scope.business_date <= locked.next_due_date) return null;

          await persistEvent(
            {
              stream_type: 'maintenance',
              stream_id: locked.examination_id,
              event_type: 'maintenance.statutory_examination_overdue',
              payload: {
                examination_id: locked.examination_id,
                asset_id: locked.asset_id,
                examination_type: locked.examination_type,
                next_due_date: locked.next_due_date,
                business_date: scope.business_date,
                flagged_at: flaggedAt,
              },
              metadata: {
                correlation_id: correlationId,
                actor: scope.actor,
                occurred_at: flaggedAt,
              },
              idempotency_key: randomUUID(),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            scope.auditCtx,
            client,
          );
          return true;
        })) === true;
    } catch (err: unknown) {
      // A concurrent scan won the race to the flip. Nothing was persisted by this pass, so nothing
      // may be counted or notified - but one lost race must not fail the whole scan.
      if (isAppErrorWithCode(err, 'DUPLICATE_STATUTORY_EXAMINATION_OVERDUE')) continue;
      // Any other rejected grain is recorded and skipped for the same reason: earlier rows in this
      // pass have already COMMITTED their overdue flips, and throwing here would return a bodyless
      // 500 that loses overdue_examination_ids and both counters - leaving assets locked with
      // nothing to say which ones. A non-AppError is a programming or infrastructure fault, not a
      // grain-level rejection, and still aborts.
      if (err instanceof AppError) {
        examinationsFailed.push(examination.examination_id);
        continue;
      }
      throw err;
    }
    if (!flipped) continue;
    overdueExaminationIds.push(examination.examination_id);

    // Everything below runs AFTER the flip has committed, so it must not be able to abort the scan
    // either: a transient failure reading the asset for the label costs the notification, not the
    // remaining rows and not the result body.
    try {
      const asset = await getAssetById(examination.asset_id);
      const emitted = await emitNotification({
        // location_id null targets every holder of the role: assets carry no location (AD-9), and
        // scoping to the scan runner's location would drop the alert everywhere else.
        target: { role: SUPERVISOR_ROLE, location_id: null },
        event_type: 'statutory_examination_overdue',
        status_verb: 'Overdue',
        object_type: 'statutory_examination',
        object_id: examination.examination_id,
        // A human-readable subject, never a raw id (the 7.2 Group 4 patch).
        actor_label: `${asset?.asset_name ?? examination.asset_id} (${asset?.asset_tag ?? ''}), ${examination.examination_type}`,
        next_step: 'Schedule re-examination; the asset is locked until re-examined',
        actor: scope.actor,
        correlation_id: correlationId,
        occurred_at: flaggedAt,
        escalation: {
          target_role: MANAGER_ROLE,
          acknowledgment_window_seconds: ESCALATION_WINDOW_SECONDS,
        },
      });
      if (emitted.ok) notificationsDelivered += 1;
      else notificationsDropped += 1;
    } catch {
      notificationsDropped += 1;
    }
  }

  return {
    business_date: scope.business_date,
    examinations_evaluated: due.length,
    examinations_overdue: overdueExaminationIds.length,
    notifications_delivered: notificationsDelivered,
    notifications_dropped: notificationsDropped,
    overdue_examination_ids: overdueExaminationIds,
    examinations_failed: examinationsFailed,
  };
}

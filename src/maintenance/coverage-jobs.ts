import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { emitNotification } from '../notify/emit.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { getAssetById } from '../read/projections/asset.js';
import { COVERAGE_STAGES } from '../compliance/maintenance-coverage.js';
import { getCoverageById, listCoverageStagesDue } from '../read/projections/asset_coverage.js';
import { getCoverageAlertForStage } from '../read/projections/asset_coverage_alert.js';

/**
 * Story 7.7 coverage expiry scan cycle (FR-M-10, AC 1). A pure function driven by the authenticated
 * POST trigger in src/api/v1/maintenance.ts, structurally cloned from
 * src/maintenance/calibration-jobs.ts. There is deliberately NO scheduler, no timer and no
 * container: the only setInterval in the process is the Story 1.11 notification dispatcher, and
 * every other periodic cycle in this codebase is a POST with an explicit business_date.
 *
 * business_date is the ONLY notion of "today" inside the job. Wall-clock time is used solely for
 * flagged_at, occurred_at and audit timestamps, which are TIMESTAMPTZ instants with explicit
 * offsets. Every date comparison happens in SQL DATE arithmetic, never in JS.
 *
 * Each coverage stage is processed in its OWN transaction: the coverage row it decides on is locked
 * FOR UPDATE and the resulting event is persisted through persistEvent on that SAME client, so two
 * concurrent scans serialize into exactly one alert rather than racing to the unique index. The
 * index remains the backstop, and a lost race is skipped rather than failing the whole scan.
 * Notifications are emitted AFTER the transaction commits, using the non-throwing emitNotification
 * (AD-17), so a notification failure can never roll back an alert.
 *
 * Write counters and delivery counters are kept SEPARATE in the result, so a dropped notification
 * stays visible instead of hiding behind the write count (the Story 7.2 and 7.4 lesson).
 */

export type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

export interface CoverageJobActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface CoverageScanScope {
  business_date: string;
  asset_id?: string | undefined;
  actor: CoverageJobActor;
  auditCtx?: AuditCtx | undefined;
}

export interface CoverageScanResult {
  business_date: string;
  coverages_evaluated: number;
  alerts_raised: number;
  notifications_delivered: number;
  notifications_dropped: number;
  /**
   * Stages whose alert row committed but whose message was intentionally withheld, because a more
   * urgent stage for the same coverage had already been notified in this run. Without this counter
   * a healthy run and a run that silently lost two emissions produce the identical result, which
   * defeats the write-versus-delivery separation this job header calls load-bearing.
   */
  notifications_suppressed: number;
  alert_ids: string[];
}

/** The 30-day stage is the last warning before the contract lapses, so it alone escalates. */
const ESCALATING_STAGE_DAYS = 30;
const ACKNOWLEDGMENT_WINDOW_SECONDS = 86400;
/**
 * The story persona receives the alert and the override authority escalates. location_id is null
 * on purpose: the asset register is company-wide (AD-9) and carries no location, so a
 * location-scoped target would silently reach nobody outside the scan actor's own site (the Story
 * 7.6 Group B lesson).
 */
const COVERAGE_ROLE = 'maintenance_manager';
const ESCALATION_ROLE = 'maintenance_supervisor';

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
 * AC 1: the staged 90/60/30-day expiry warnings across AMC, warranty and insurance coverages.
 *
 * Catch-up is structural, not special-cased: listCoverageStagesDue asks which stages are DUE and
 * UNFIRED, so a scan skipped for several days fires every missed stage on the next run, most urgent
 * first, and a second scan on the same business_date fires nothing because every due stage already
 * occupies its grain. An equality test on the day count would silently drop a stage whenever the
 * job is not run daily.
 *
 * There is no expiry-flip pass here (unlike the Story 7.5 twin): a lapsed coverage has no status
 * column to flip - it simply stops satisfying the active-warranty predicate, which is evaluated in
 * SQL against business_date at work-order creation time. Coverages are append-only, and a renewal
 * is a new row with its own fresh set of stages (Binding Decision 5).
 *
 * Every coverage in force is scanned, including several of one type on one asset, because that is a
 * legal shape under the (asset_id, coverage_type, lower(reference_number_ext)) uniqueness grain. A
 * consequence, logged in deferred-work rather than fixed here: a renewal recorded before the old
 * contract lapses leaves BOTH rows eligible, so the superseded contract still raises its remaining
 * unfired stages.
 */
export async function runCoverageExpiryScan(scope: CoverageScanScope): Promise<CoverageScanResult> {
  const filters = { asset_id: scope.asset_id ?? null };

  const dueStages = await listCoverageStagesDue(scope.business_date, COVERAGE_STAGES, filters);

  // dueStages is the CROSS JOIN of coverages against the stage array, so its length is a stage
  // count, not a coverage count: one contract with three due stages is ONE coverage evaluated.
  const coveragesEvaluated = new Set(dueStages.map((d) => d.coverage_id)).size;

  const alertIds: string[] = [];
  let notificationsSuppressed = 0;
  let notificationsDelivered = 0;
  let notificationsDropped = 0;
  // Review decision D5: the alert table is a LEDGER, the notification is a MESSAGE, and conflating
  // them turned one contract into a pile of pages. Every due and unfired stage still gets its grain
  // row, so catch-up stays structural and a skipped scan never loses a stage - but only the most
  // urgent stage actually flagged for a coverage in this run is notified. Without this, a coverage
  // recorded inside the 90-day window (a 45-day insurance cover note is legal under
  // chk_asset_coverage_dates) fires 90, 60 and 30 simultaneously on its first scan, three
  // notifications for a contract nobody has had a chance to act on, one of them carrying the
  // maintenance_supervisor escalation clock. dueStages is ordered stage_days ASC within a coverage,
  // so the first stage that commits for a coverage IS its most urgent one.
  const notifiedCoverages = new Set<string>();

  for (const due of dueStages) {
    const flaggedAt = new Date().toISOString();
    const correlationId = randomUUID();
    const alertId = randomUUID();

    let flagged = false;
    try {
      flagged =
        (await inTransaction(async (client) => {
          // Lock the coverage so a concurrent scan for this grain serializes: the loser waits,
          // then sees the alert the winner committed and skips it.
          const locked = await getCoverageById(due.coverage_id, client, true);
          if (!locked) return null;
          // A renewal or correction that moved the expiry date since the list read invalidates the
          // stage this pass selected; the next scan recomputes it from the new date.
          if (locked.expiry_date !== due.expiry_date) return null;

          const existing = await getCoverageAlertForStage(due.coverage_id, due.stage_days, client);
          if (existing) return null;

          await persistEvent(
            {
              stream_type: 'maintenance',
              stream_id: alertId,
              event_type: 'maintenance.coverage_expiry_flagged',
              payload: {
                alert_id: alertId,
                coverage_id: locked.coverage_id,
                asset_id: locked.asset_id,
                coverage_type: locked.coverage_type,
                stage_days: due.stage_days,
                expiry_date: locked.expiry_date,
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
      // Every rejection applyCoverageExpiryFlagged can raise means "this one stage is no longer
      // alertable", never "the run is broken": DUPLICATE_COVERAGE_ALERT is a lost race to
      // uq_asset_coverage_alert_stage, and COVERAGE_NOT_FOUND, COVERAGE_ALREADY_EXPIRED and
      // COVERAGE_DERIVATION_MISMATCH all mean the row moved between the list read and the lock.
      // Nothing was persisted by this pass in any of those cases, so nothing may be counted or
      // notified - but one skipped stage must not abort a scan and strand the alert_ids of every
      // stage already committed.
      if (
        isAppErrorWithCode(err, 'DUPLICATE_COVERAGE_ALERT') ||
        isAppErrorWithCode(err, 'COVERAGE_NOT_FOUND') ||
        isAppErrorWithCode(err, 'COVERAGE_ALREADY_EXPIRED') ||
        isAppErrorWithCode(err, 'COVERAGE_DERIVATION_MISMATCH')
      ) {
        continue;
      }
      throw err;
    }
    if (!flagged) continue;
    alertIds.push(alertId);

    // The grain row is committed either way; only the message is suppressed, and the suppression
    // is counted so it never hides behind the write count.
    if (notifiedCoverages.has(due.coverage_id)) {
      notificationsSuppressed += 1;
      continue;
    }
    notifiedCoverages.add(due.coverage_id);

    // BP4: the asset read and the emission sit INSIDE the tolerant block. The alert row for this
    // stage is already committed, so letting a transient pool failure here propagate would 500 the
    // whole scan and discard alert_ids for every stage already written - and a re-run would then
    // skip those stages as already fired and never notify on them. A failure to notify is exactly
    // what notifications_dropped exists to report.
    let emitted: { ok: boolean };
    try {
      const asset = await getAssetById(due.asset_id);
      emitted = await emitNotification({
        target: { role: COVERAGE_ROLE, location_id: null },
        event_type: 'coverage_expiry_due',
        status_verb: 'Due',
        object_type: 'asset_coverage',
        object_id: alertId,
        // A human-readable subject, never a raw id (the 7.2 Group 4 patch).
        actor_label: `${asset?.asset_name ?? due.asset_id} (${asset?.asset_tag ?? 'unknown tag'}), ${due.coverage_type} ${due.reference_number_ext}, ${due.days_remaining} days remaining`,
        next_step: 'Renew the contract or record a new coverage',
        actor: scope.actor,
        correlation_id: correlationId,
        occurred_at: flaggedAt,
        // Escalating a quarter-out reminder is noise; the 30-day stage is the last warning before
        // the contract lapses, so only that one carries an acknowledgment window.
        ...(due.stage_days === ESCALATING_STAGE_DAYS
          ? {
              escalation: {
                target_role: ESCALATION_ROLE,
                acknowledgment_window_seconds: ACKNOWLEDGMENT_WINDOW_SECONDS,
              },
            }
          : {}),
      });
    } catch {
      emitted = { ok: false };
    }
    if (emitted.ok) notificationsDelivered += 1;
    else notificationsDropped += 1;
  }

  return {
    business_date: scope.business_date,
    coverages_evaluated: coveragesEvaluated,
    alerts_raised: alertIds.length,
    notifications_delivered: notificationsDelivered,
    notifications_dropped: notificationsDropped,
    notifications_suppressed: notificationsSuppressed,
    alert_ids: alertIds,
  };
}

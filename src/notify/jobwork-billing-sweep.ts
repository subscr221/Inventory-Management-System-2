import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import {
  listBillingFeedsDueForSweep,
  markBillingFeedException,
} from '../read/projections/job_work_billing_feed.js';
import type { JobWorkBillingFeedRow } from '../read/projections/job_work_billing_feed.js';
import { billingFeedRetryWindowElapsed } from '../adapters/erp/job-work-billing-feed.js';
import { emitNotificationInTransaction } from './emit.js';

// A billing feed sitting unacknowledged past its retry window is a system-driven lifecycle
// transition, not a user action - the exact Story 8.4/8.7/9.5 SYSTEM_ACTOR fixed-identity idiom.
const SYSTEM_ACTOR = {
  user_id: '00000000-0000-0000-0000-000000000000',
  role: 'system_jobwork_billing_retry',
  location_id: '00000000-0000-0000-0000-000000000000',
};

/**
 * One sweep at a time across app instances (the 8.7 constant-key idiom, a DISTINCT key from the
 * clock sweep's 9505). The cycle is a read-decide-persist window over the feed stamps, so two
 * overlapping ticks would both read "still pending" and both notify.
 */
const JOBWORK_BILLING_SWEEP_LOCK_KEY = 9506;

/**
 * Notification targets (Story 9.6 Task 7.3). Role LABELS follow the codebase: every Epic 9 fixture
 * and the DOA registry know the coordinator as `jobwork_coordinator` (never `job_work_coordinator`,
 * the 9.5 disclosure). The escalation tier is the site head through the EXISTING Story 1.11
 * runEscalationCycle machinery.
 */
export const JOBWORK_BILLING_COORDINATOR_ROLE = 'jobwork_coordinator';
export const JOBWORK_BILLING_SITE_HEAD_ROLE = 'site_head';
/** Notification business category (preference matching). */
export const JOBWORK_BILLING_EXCEPTION_EVENT_TYPE = 'jobwork_billing_feed_exception';

export interface JobWorkBillingFeedSweepResult {
  /** Feeds that received the exception alert in this tick (always equals `exceptions`). */
  alerted: number;
  /** Feeds flipped from `pending` to `exception` in this tick. */
  exceptions: number;
  /** Due feeds whose transition failed and was rolled back to its savepoint (retried next tick). */
  failed: number;
  /** True when the tick itself could not run (connection or transaction failure). */
  cycleFailed: boolean;
  /** True when another instance held the sweep lock and this tick did no work. */
  skippedLocked: boolean;
  /** Due feeds a concurrent acknowledgment flipped out of `pending` before this tick could act. */
  skippedRaced: number;
  /** True when the candidate query filled its whole batch (more feeds due than this tick took). */
  truncated: boolean;
}

function describeFeed(row: JobWorkBillingFeedRow): string {
  return `billing feed ${row.feed_id} for order ${row.service_order_id} (${row.total_value} ${row.currency}, sent ${row.first_sent_at})`;
}

/**
 * Story 9.6 (FR-JW-12, AC 5): the billing-feed retry-window sweep, cloned from
 * runJobworkClockSweepCycle: one BEGIN/COMMIT under a transaction-scoped advisory lock, per-row
 * SAVEPOINT isolation (one poisoned feed row must never stop billing alerts for every other order -
 * the 8.4 lesson), a bounded batch, and the failed/cycleFailed distinction.
 *
 * A `pending` feed whose first_sent_at is STRICTLY older than billingRetryWindowMs flips to
 * `exception`, sets exception_raised_at AND alert_sent_at in the same guarded UPDATE, and emits ONE
 * notification to the site's job-work coordinator carrying an `escalation` definition so the
 * EXISTING Story 1.11 runEscalationCycle hops it to the site head when it goes unactioned. The
 * status flip is what makes re-alerting the same feed on the next tick impossible: the candidate
 * query only ever selects `pending` rows, and alert_sent_at records when the alert went out.
 *
 * The flip and the stamps are plain projection UPDATEs, not domain events (the 8.4 retention
 * precedent, disclosed): the notification.created event persisted here carries the feed_id, so the
 * sweep's history is still in the event store. Retries never mint events (Binding decision 14): a
 * retry re-sends the SAME feed row, and nothing here creates a second billable line. `now` may be
 * passed by tests to exercise the window without waiting real time.
 */
export async function runJobWorkBillingFeedSweepCycle(
  opts: { now?: string } = {},
): Promise<JobWorkBillingFeedSweepResult> {
  const client = await getPool().connect();
  let exceptions = 0;
  let failed = 0;
  let skippedRaced = 0;
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [
      JOBWORK_BILLING_SWEEP_LOCK_KEY,
    ]);
    if (!(lock.rows[0] as { acquired: boolean }).acquired) {
      await client.query('ROLLBACK');
      return {
        alerted: 0,
        exceptions: 0,
        failed: 0,
        cycleFailed: false,
        skippedLocked: true,
        skippedRaced: 0,
        truncated: false,
      };
    }

    const now = opts.now ?? new Date().toISOString();
    const retryWindowMs = config.jobwork.billingRetryWindowMs;
    const cutoff = new Date(new Date(now).getTime() - retryWindowMs).toISOString();
    const cycleCorrelationId = randomUUID();
    const due = await listBillingFeedsDueForSweep(
      { cutoff, batchSize: config.jobwork.billingSweepBatchSize },
      client,
    );

    for (const feed of due) {
      // Re-check the predicate against the parameterised window (the 8.4 lesson): the SQL cutoff
      // is inclusive, the window is strict.
      if (!billingFeedRetryWindowElapsed({ firstSentAt: feed.first_sent_at, now, retryWindowMs })) {
        continue;
      }
      await client.query('SAVEPOINT jobwork_billing_feed');
      try {
        const flipped = await markBillingFeedException(
          feed.feed_id,
          { exception_raised_at: now, alert_sent_at: now },
          client,
        );
        if (flipped) {
          const windowHours = Math.round((retryWindowMs / 3_600_000) * 100) / 100;
          await emitNotificationInTransaction(
            {
              // Site-scoped (the 9.5 chunks 3/4 lesson): a null location targets every holder.
              target: { role: JOBWORK_BILLING_COORDINATOR_ROLE, location_id: feed.site_id },
              event_type: JOBWORK_BILLING_EXCEPTION_EVENT_TYPE,
              status_verb: 'Billing feed unacknowledged past its retry window',
              object_type: 'job_work_billing_feed',
              object_id: feed.feed_id,
              actor_label: `Service order ${feed.service_order_id}`,
              next_step: `ERP has not acknowledged ${describeFeed(feed)} within ${windowHours} hours; the feed is in the exception queue - re-send it to ERP and record the acknowledgment, or investigate the invoice`,
              actor: SYSTEM_ACTOR,
              correlation_id: cycleCorrelationId,
              causation_id: null,
              occurred_at: now,
              escalation: {
                target_role: JOBWORK_BILLING_SITE_HEAD_ROLE,
                acknowledgment_window_seconds: config.jobwork.clockEscalationWindowSeconds,
              },
            },
            client,
          );
          exceptions += 1;
        } else {
          // The guarded UPDATE matched nothing: an acknowledgment landed between the candidate
          // SELECT and here. Counted, never reported as success for a row nothing was done to.
          skippedRaced += 1;
          console.warn(
            `jobwork billing sweep: feed ${feed.feed_id} left pending before its exception could be recorded; skipped`,
          );
        }
        await client.query('RELEASE SAVEPOINT jobwork_billing_feed');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT jobwork_billing_feed');
        await client.query('RELEASE SAVEPOINT jobwork_billing_feed');
        failed += 1;
        console.error(
          `Job-work billing feed exception transition failed for ${feed.feed_id}; skipped, will be retried next cycle:`,
          err,
        );
      }
    }

    await client.query('COMMIT');
    if (failed > 0) {
      console.error(
        `Job-work billing feed sweep completed with ${failed} failed row(s) out of ${due.length}.`,
      );
    }
    const truncated = due.length >= config.jobwork.billingSweepBatchSize;
    if (truncated) {
      console.warn(
        `Job-work billing feed sweep filled its batch of ${config.jobwork.billingSweepBatchSize}; more feeds are due than this tick could take.`,
      );
    }
    return {
      alerted: exceptions,
      exceptions,
      failed,
      cycleFailed: false,
      skippedLocked: false,
      skippedRaced,
      truncated,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(
      'Job-work billing feed sweep failed - rolled back, rows will be swept again next cycle:',
      err,
    );
    return {
      alerted: 0,
      exceptions: 0,
      failed: 0,
      cycleFailed: true,
      skippedLocked: false,
      skippedRaced: 0,
      truncated: false,
    };
  } finally {
    client.release();
  }
}

import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import {
  listReturnClocksDueForSweep,
  markReturnClockBreached,
  stampReturnClockAlerts,
} from '../read/projections/jobwork_return_clock.js';
import type { JobworkReturnClockReportRow } from '../read/projections/jobwork_return_clock.js';
import { deemedSupplyQty, dueClockSweepStage } from '../compliance/jobwork-return-clock.js';
import { listRetainedOffcutHoldingsForOrderSku } from '../read/projections/job_work_offcut_holding.js';
import type { ClockSweepStage } from '../compliance/jobwork-return-clock.js';
import { emitNotificationInTransaction } from './emit.js';

// A return clock reaching its breach window or expiring is a system-driven statutory lifecycle
// transition, not a user action - the exact Story 8.4/8.7 SYSTEM_ACTOR fixed-identity idiom.
const SYSTEM_ACTOR = {
  user_id: '00000000-0000-0000-0000-000000000000',
  role: 'system_jobwork_clock_expiry',
  location_id: '00000000-0000-0000-0000-000000000000',
};

/**
 * One sweep at a time across app instances (the 8.7 constant-key idiom, distinct key). The cycle
 * is a read-decide-persist window over the clock stamps, so two overlapping ticks would both read
 * "not yet alerted" and both notify.
 */
const JOBWORK_CLOCK_SWEEP_LOCK_KEY = 9505;

/**
 * Notification targets (Story 9.5 Task 2.2 / 3.3). Role LABELS follow the codebase: every Epic 9
 * fixture and the DOA registry know the coordinator as `jobwork_coordinator` (the story text's
 * `job_work_coordinator` spelling has no holder anywhere - disclosed). compliance_officer and
 * site_head are the AC3/AC5 named recipients; site_head is resolved scoped to the order's site.
 */
export const JOBWORK_CLOCK_COORDINATOR_ROLE = 'jobwork_coordinator';
export const JOBWORK_CLOCK_COMPLIANCE_ROLE = 'compliance_officer';
export const JOBWORK_CLOCK_SITE_HEAD_ROLE = 'site_head';
/** Notification business categories (preference matching), one per statutory stage class. */
export const JOBWORK_CLOCK_BREACH_WINDOW_EVENT_TYPE = 'jobwork_return_clock_breach_window';
export const JOBWORK_CLOCK_DEEMED_SUPPLY_EVENT_TYPE = 'jobwork_return_clock_deemed_supply';

export interface JobworkClockSweepResult {
  /** Clocks that received a breach-window alert (90-day or 30-day stage) in this tick. */
  alerted: number;
  /** Clocks flipped to `breached` with a deemed supply recorded in this tick. */
  breached: number;
  /** Due clocks whose transition failed and was rolled back to its savepoint (retried next tick). */
  failed: number;
  /** True when the tick itself could not run (connection or transaction failure). */
  cycleFailed: boolean;
  /** True when another instance held the sweep lock and this tick did no work. */
  skippedLocked: boolean;
  /**
   * Story 9.5 code review (chunks 3/4): due clocks a concurrent tick had already flipped out of a
   * live status before this one could record the breach. Counted rather than silently ignored - the
   * branch used to report as success for a row nothing had been done to.
   */
  skippedRaced: number;
  /**
   * True when the candidate query filled its whole batch, so more clocks are due than this tick
   * could take. Without it a backlog above `clockSweepBatchSize` drained one batch per interval with
   * no operational signal, and past-expiry rows sort first, so the 90 and 30-day WARNINGS are the
   * ones deferred behind clocks that have already breached.
   */
  truncated: boolean;
  /**
   * Story 9.7 AC 8: clocks whose alert or breach notice named retained contractual offcut on the
   * same (order, sku). Counted, never added to any quantity - see the comment at the call site.
   */
  offcutRetained: number;
}

function describeClock(row: JobworkReturnClockReportRow): string {
  return `order ${row.order_number_ext}, challan ${row.challan_number_ext} (${row.challan_class}), ${row.sku}`;
}

/**
 * Story 9.5 (FR-JW-14, FR-AC-11; AC 3, 4, 5): the CGST Section 143 return-clock sweep, modeled on
 * runRetentionExpiryCycle / runBisLicenceExpiryCycle: one BEGIN/COMMIT under a transaction-scoped
 * advisory lock, per-row SAVEPOINT isolation (one poisoned clock must never silently stop ALL
 * statutory alerting - the 8.4 lesson), a bounded batch, and the failed/cycleFailed distinction.
 *
 * ONE pass, three arms evaluated TIGHTEST-FIRST per row (dueClockSweepStage):
 *   1. expiry passed: flip to `breached`, freeze deemed_supply_qty = challan - reconciled - loss
 *      (loss is Section 143(5) accounted waste, never deemed supply), notify the compliance officer
 *      AND the site head (AC 5's terminal targets), and SKIP both alerts;
 *   2. inside the inner (30-day) window and not yet stamped: ONE alert, BOTH stamps set;
 *   3. inside the outer (90-day) window and not yet stamped: one alert, the 90-day stamp set.
 * A challan keyed in eleven months late therefore produces one alert, not two in the same second,
 * and a clock already expired when first seen goes straight to breached.
 *
 * Each alert is TWO notification events (EmitNotificationInput.target is single-role; there is no
 * fan-out helper): the coordinator's copy carries no escalation; the compliance officer's copy
 * carries `escalation: { target_role: site_head, acknowledgment_window_seconds }` so the EXISTING
 * Story 1.11 runEscalationCycle hops it when it goes unactioned (AC 4 - no new escalation code).
 * The stamp and the emissions commit together inside the row's SAVEPOINT, so a crash between them
 * cannot double-send.
 *
 * The breach flip and the stamps are plain projection UPDATEs, not domain events (the Story 8.4
 * retention precedent for later stages, disclosed in the story record): the notification.created
 * events persisted here carry the clock_id and stage, so the sweep's history is still in the event
 * store. `today` is the IST calendar date resolved once per tick (the 8.7 idiom); tests may pass
 * it explicitly to exercise the calendar without waiting real time.
 */
export async function runJobworkClockSweepCycle(
  opts: { today?: string } = {},
): Promise<JobworkClockSweepResult> {
  const client = await getPool().connect();
  let alerted = 0;
  let breached = 0;
  let failed = 0;
  let skippedRaced = 0;
  let offcutRetained = 0;
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [
      JOBWORK_CLOCK_SWEEP_LOCK_KEY,
    ]);
    if (!(lock.rows[0] as { acquired: boolean }).acquired) {
      await client.query('ROLLBACK');
      return {
        alerted: 0,
        breached: 0,
        failed: 0,
        cycleFailed: false,
        skippedLocked: true,
        skippedRaced: 0,
        truncated: false,
        offcutRetained: 0,
      };
    }

    const today = opts.today ?? toIstCalendarDate(new Date());
    const now = new Date().toISOString();
    const leadDays1 = config.jobwork.clockLeadDays1;
    const leadDays2 = config.jobwork.clockLeadDays2;
    const cycleCorrelationId = randomUUID();
    const due = await listReturnClocksDueForSweep(
      { today, leadDays1, leadDays2, batchSize: config.jobwork.clockSweepBatchSize },
      client,
    );

    for (const clock of due) {
      const stage: ClockSweepStage | null = dueClockSweepStage({
        today,
        expiryDate: clock.expiry_date,
        status: clock.status,
        alert90SentAt: clock.alert_90_sent_at,
        alert30SentAt: clock.alert_30_sent_at,
        leadDays1,
        leadDays2,
      });
      if (stage === null) continue;

      await client.query('SAVEPOINT jobwork_clock_stage');
      try {
        // Story 9.7 AC 8: contractual offcut retained on this (order, sku) is STILL the customer's
        // material and its Section 143 exposure is still open, so every notice this sweep sends
        // names it. It reaches the coordinator whether or not the order has CLOSED, because closure
        // does not end a clock and capture drained the custody balance precisely so closure could
        // happen.
        //
        // CRITICAL (BSD-11, Task 8.3): the retained quantity is SURFACED, never added to the
        // arithmetic. Capture deliberately does not call reconcileReturnClocks, so this quantity is
        // still outstanding on the clock and already counts toward deemed_supply_qty below. Adding
        // it again would overstate the Section 143 exposure on every ITC-04 extract. The clock is
        // the single accounting authority; this is a pointer to where the material physically is.
        const retainedOffcut = await listRetainedOffcutHoldingsForOrderSku(
          clock.service_order_id,
          clock.sku,
          client,
        );
        const offcutNote =
          retainedOffcut.length === 0
            ? ''
            : ` Retained contractual offcut on this sku: ${retainedOffcut
                .map((row) => `${row.quantity} ${row.uom} in lot ${row.lot_id}`)
                .join(
                  ', ',
                )} - already counted on this clock, dispose of it (return or acquire) to close the exposure.`;
        if (retainedOffcut.length > 0) offcutRetained += 1;
        if (stage === 'breached') {
          const deemed = deemedSupplyQty(clock.challan_qty, clock.reconciled_qty, clock.loss_qty);
          const flipped = await markReturnClockBreached(clock.clock_id, deemed, now, client);
          if (flipped) {
            const nextStep = `Deemed supply of ${deemed} ${clock.uom} ${clock.sku} under CGST s.143: report in ITC-04 for ${describeClock(clock)}; clock expired ${clock.expiry_date}.${offcutNote}`;
            // Story 9.5 code review (chunks 3/4): every copy is scoped to the clock's site. A null
            // location_id targets every holder of the role in the enterprise (src/notify/emit.ts:8),
            // so the compliance copy was carrying this order's number, external challan number, sku
            // and outstanding quantity to officers at sites holding no read assignment on it - the
            // very disclosure both report routes 403 to prevent. The site-head copy was already
            // scoped, two lines away.
            for (const target of [
              { role: JOBWORK_CLOCK_COMPLIANCE_ROLE, location_id: clock.site_id },
              { role: JOBWORK_CLOCK_SITE_HEAD_ROLE, location_id: clock.site_id },
            ]) {
              await emitNotificationInTransaction(
                {
                  target,
                  event_type: JOBWORK_CLOCK_DEEMED_SUPPLY_EVENT_TYPE,
                  status_verb: 'Return clock breached',
                  object_type: 'jobwork_return_clock',
                  object_id: clock.clock_id,
                  actor_label: `Service order ${clock.order_number_ext}`,
                  next_step: nextStep,
                  actor: SYSTEM_ACTOR,
                  correlation_id: cycleCorrelationId,
                  causation_id: null,
                  occurred_at: now,
                },
                client,
              );
            }
            breached += 1;
          } else {
            // The guarded UPDATE matched nothing: another tick flipped this clock between the
            // candidate SELECT and here. Previously this branch emitted nothing, counted nothing and
            // logged nothing, so the tick reported total success for a row it did not handle.
            skippedRaced += 1;
            console.warn(
              `jobwork clock sweep: clock ${clock.clock_id} was already flipped out of a live status before its breach could be recorded; skipped`,
            );
          }
        } else {
          const isInner = stage === 'alert_30';
          const windowDays = isInner ? leadDays2 : leadDays1;
          const outstanding = deemedSupplyQty(
            clock.challan_qty,
            clock.reconciled_qty,
            clock.loss_qty,
          );
          const nextStep = `Return or dispatch ${outstanding} ${clock.uom} ${clock.sku} before ${clock.expiry_date} for ${describeClock(clock)}, or it becomes a deemed supply under CGST s.143 (${windowDays}-day warning).${offcutNote}`;
          const shared = {
            event_type: JOBWORK_CLOCK_BREACH_WINDOW_EVENT_TYPE,
            status_verb: `Return clock expires in ${windowDays} days or less`,
            object_type: 'jobwork_return_clock',
            object_id: clock.clock_id,
            actor_label: `Service order ${clock.order_number_ext}`,
            next_step: nextStep,
            actor: SYSTEM_ACTOR,
            correlation_id: cycleCorrelationId,
            causation_id: null,
            occurred_at: now,
          };
          await emitNotificationInTransaction(
            {
              ...shared,
              // Site-scoped for the same reason as the breach copies above.
              target: { role: JOBWORK_CLOCK_COORDINATOR_ROLE, location_id: clock.site_id },
            },
            client,
          );
          await emitNotificationInTransaction(
            {
              ...shared,
              target: { role: JOBWORK_CLOCK_COMPLIANCE_ROLE, location_id: clock.site_id },
              escalation: {
                target_role: JOBWORK_CLOCK_SITE_HEAD_ROLE,
                acknowledgment_window_seconds: config.jobwork.clockEscalationWindowSeconds,
              },
            },
            client,
          );
          // Tightest-stage-wins: the inner stage stamps BOTH columns so the outer tier can never
          // fire a second alert for the same clock on a later tick.
          await stampReturnClockAlerts(
            clock.clock_id,
            { alert_90: true, alert_30: isInner },
            now,
            client,
          );
          alerted += 1;
        }
        await client.query('RELEASE SAVEPOINT jobwork_clock_stage');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT jobwork_clock_stage');
        await client.query('RELEASE SAVEPOINT jobwork_clock_stage');
        failed += 1;
        console.error(
          `Job-work return clock ${stage} transition failed for ${clock.clock_id}; skipped, will be retried next cycle:`,
          err,
        );
      }
    }

    await client.query('COMMIT');
    if (failed > 0) {
      console.error(
        `Job-work return clock sweep completed with ${failed} failed row(s) out of ${due.length}.`,
      );
    }
    const truncated = due.length >= config.jobwork.clockSweepBatchSize;
    if (truncated) {
      console.warn(
        `Job-work return clock sweep filled its batch of ${config.jobwork.clockSweepBatchSize}; more clocks are due than this tick could take. Past-expiry clocks sort first, so breach-window warnings are the ones being deferred.`,
      );
    }
    return {
      alerted,
      breached,
      failed,
      cycleFailed: false,
      skippedLocked: false,
      skippedRaced,
      truncated,
      offcutRetained,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(
      'Job-work return clock sweep failed - rolled back, rows will be swept again next cycle:',
      err,
    );
    return {
      alerted: 0,
      breached: 0,
      failed: 0,
      cycleFailed: true,
      skippedLocked: false,
      skippedRaced: 0,
      truncated: false,
      offcutRetained: 0,
    };
  } finally {
    client.release();
  }
}

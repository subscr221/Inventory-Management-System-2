import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import { persistEvent, type EventEnvelope } from '../events/store.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { listActiveBisLicencesForExpirySweep } from '../read/projections/compliance_bis_licence.js';
import {
  BIS_LICENCE_EXPIRY_FLAGGED,
  BIS_LICENCE_EXPIRY_STAGES,
  dueBisLicenceExpiryStages,
} from './master-data.js';

// Story 8.7 (FR-Q-11, AC 2): a licence expiry alert is a system-driven lifecycle transition, not a
// user action, so there is no human actor to stamp - the exact Story 8.4/7.7 SYSTEM_ACTOR pattern.
const SYSTEM_ACTOR = {
  user_id: '00000000-0000-0000-0000-000000000000',
  role: 'system_compliance_licence_expiry',
  location_id: '00000000-0000-0000-0000-000000000000',
};

/**
 * One sweep at a time across app instances. The cycle is a read-decide-persist window over the
 * alert ledger, so two overlapping ticks (a cycle that outruns its own interval, or a second
 * instance) would both read "not yet flagged" and both notify. Same hashtext-free constant-key
 * idiom as ADVISORY_LOCK_KEYS in src/adapters/erp/sync.ts.
 */
const BIS_LICENCE_EXPIRY_LOCK_KEY = 8707;

export interface BisLicenceExpiryCycleResult {
  /** Alert rows (stage flags + expiry flips) actually persisted in this tick. */
  flagged: number;
  /** Candidate stage transitions that were due but whose persist failed and was skipped. */
  failed: number;
  /** Stages persisted without a notification because a more urgent stage notified instead (BSD-5). */
  suppressedStages: number;
  /** True when the tick itself could not run (connection or transaction failure). */
  cycleFailed: boolean;
  /** True when another instance held the sweep lock and this tick did no work. */
  skippedLocked: boolean;
}

export function calendarDaysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/**
 * Story 8.7 (FR-Q-11, AC 2): the 90/60/30-day BIS licence expiry sweep, cloning the
 * runRetentionExpiryCycle structure (BSD-5). One BEGIN/COMMIT under a transaction-scoped advisory
 * lock, per-row SAVEPOINT isolation so one poisoned row cannot roll back the whole tick, a bounded
 * batch (config.quality.bisLicenceExpiryBatchSize), and the failed/cycleFailed result distinction
 * (the 8.4 sweep-robustness lesson).
 *
 * For each active-status licence, every missed stage in [90, 60, 30] gets flagged in the same pass
 * (catch-up, the Story 7.7 pattern) via one compliance.bis_licence_expiry_flagged event per stage;
 * an expired window (valid_to < today) flags stage_days = 0 INSTEAD of the day-count stages, which
 * the applier uses to flip status to 'expired'. Stages are ordered most-urgent-last.
 *
 * BSD-5's "one notification per licence per cycle" is enforced in the applier, not here: the ledger
 * gets a row for every missed stage, but applyBisLicenceExpiryFlagged notifies only for the stage
 * that is currently the MOST urgent due stage for that licence (recomputed from valid_to under the
 * transaction), so the remaining rows are silent. suppressedStages counts them.
 *
 * All events in one cycle share a single correlation_id so an auditor can group a sweep.
 */
export async function runBisLicenceExpiryCycle(): Promise<BisLicenceExpiryCycleResult> {
  const client = await getPool().connect();
  let flagged = 0;
  let failed = 0;
  let suppressedStages = 0;
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [
      BIS_LICENCE_EXPIRY_LOCK_KEY,
    ]);
    if (!(lock.rows[0] as { acquired: boolean }).acquired) {
      await client.query('ROLLBACK');
      return {
        flagged: 0,
        failed: 0,
        suppressedStages: 0,
        cycleFailed: false,
        skippedLocked: true,
      };
    }

    const today = toIstCalendarDate(new Date());
    const cycleCorrelationId = randomUUID();
    const candidates = await listActiveBisLicencesForExpirySweep(
      config.quality.bisLicenceExpiryBatchSize,
      today,
      BIS_LICENCE_EXPIRY_STAGES[0],
      // Stage 0 is included so an expired window is still picked up once its day-count stages are
      // all recorded; without it a licence that ran through 90/60/30 could never reach the flip.
      [...BIS_LICENCE_EXPIRY_STAGES, 0],
      client,
    );

    for (const licence of candidates) {
      // Ordered most-urgent-last: [90, 60, 30] for a live window, [0] alone once expired.
      const stagesToFlag = dueBisLicenceExpiryStages(calendarDaysBetween(today, licence.valid_to));
      let persistedForLicence = 0;
      for (const stageDays of stagesToFlag) {
        await client.query('SAVEPOINT bis_licence_expiry_flag');
        try {
          const envelope: EventEnvelope = {
            stream_type: 'compliance',
            stream_id: licence.licence_id,
            event_type: BIS_LICENCE_EXPIRY_FLAGGED,
            payload: {
              licence_id: licence.licence_id,
              stage_days: stageDays,
            },
            metadata: {
              correlation_id: cycleCorrelationId,
              causation_id: null,
              actor: SYSTEM_ACTOR,
              occurred_at: new Date().toISOString(),
            },
          };
          await persistEvent(envelope, undefined, client);
          await client.query('RELEASE SAVEPOINT bis_licence_expiry_flag');
          flagged += 1;
          persistedForLicence += 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT bis_licence_expiry_flag');
          await client.query('RELEASE SAVEPOINT bis_licence_expiry_flag');
          failed += 1;
          console.error(
            `BIS licence expiry flag failed for ${licence.licence_id} stage ${stageDays}; skipped, will be retried next cycle:`,
            err,
          );
        }
      }
      // Every persisted stage but the most urgent one is silent (BSD-5).
      if (persistedForLicence > 1) suppressedStages += persistedForLicence - 1;
    }

    await client.query('COMMIT');
    if (failed > 0) {
      console.error(`BIS licence expiry cycle completed with ${failed} failed row(s).`);
    }
    return { flagged, failed, suppressedStages, cycleFailed: false, skippedLocked: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(
      'BIS licence expiry cycle failed - rolled back, rows will be swept again next cycle:',
      err,
    );
    return {
      flagged: 0,
      failed: 0,
      suppressedStages: 0,
      cycleFailed: true,
      skippedLocked: false,
    };
  } finally {
    client.release();
  }
}

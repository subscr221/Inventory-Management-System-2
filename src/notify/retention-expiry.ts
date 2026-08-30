import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import { QC_RETENTION_SAMPLE_DISPOSED } from '../compliance/quality.js';
import { listQcRetentionSamplesDueForDisposal } from '../read/projections/qc_retention_sample.js';

// Same fixed system identity the notification expiry sweep uses - a retention sample reaching its
// alert window is a system-driven lifecycle transition, not a user action, so there is no human
// actor to stamp (Story 8.4 Task 2: qc.retention_sample_disposed carries no disposed_by).
const SYSTEM_ACTOR = {
  user_id: '00000000-0000-0000-0000-000000000000',
  role: 'system_qc_retention_expiry',
  location_id: '00000000-0000-0000-0000-000000000000',
};

export interface RetentionExpiryCycleResult {
  /** Samples actually transitioned to `disposal_pending` and alerted in this tick. */
  disposalPending: number;
  /** Samples that were due but whose transition failed and was skipped. */
  failed: number;
  /** True when the tick itself could not run (connection or transaction failure). */
  cycleFailed: boolean;
}

/**
 * Story 8.4 (FR-Q-08, AC 5): the 30-day retention-sample expiry alert. Every sample still
 * `retained` whose expires_on falls inside config.quality.retentionExpiryAlertLeadDays gets one
 * recorded qc.retention_sample_disposed event; the applier flips it to `disposal_pending` and
 * emits the operator notification in the same transaction. Physical disposal is Phase 2 / Epic 16 -
 * this story records the event, the status and the alert.
 *
 * Each sample is isolated behind its own SAVEPOINT. The sweep originally ran the whole batch in one
 * undivided transaction, which meant a single failing row rolled back every sample already
 * transitioned in that tick and returned a result indistinguishable from "nothing was due" - so one
 * deterministically poisoned row silently stopped ALL retention alerting, hourly, forever. Now a bad
 * row is rolled back to its savepoint, counted, and left for the next tick; the rest still commit.
 *
 * The batch is bounded (config.quality.retentionExpiryBatchSize) so a backlog - the first tick after
 * downtime, or a release cohort reaching expiry together - cannot lock the whole table in one
 * transaction. A tick that fills its batch simply continues on the next tick.
 *
 * Idempotent by construction: the candidate query and the guarded UPDATE both require
 * `status = 'retained'`, so an already-flipped row is never re-swept or re-alerted.
 *
 * Called on a low-frequency interval (config.quality.retentionExpiryIntervalMs) from src/server.ts,
 * or directly by tests - which control cycle timing explicitly rather than racing a background
 * timer.
 */
export async function runRetentionExpiryCycle(): Promise<RetentionExpiryCycleResult> {
  const client = await getPool().connect();
  let disposalPending = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    const due = await listQcRetentionSamplesDueForDisposal(
      config.quality.retentionExpiryAlertLeadDays,
      client,
      config.quality.retentionExpiryBatchSize,
    );

    for (const sample of due) {
      await client.query('SAVEPOINT retention_sample_disposal');
      try {
        await persistEvent(
          {
            stream_type: 'qc',
            stream_id: sample.retention_sample_id,
            event_type: QC_RETENTION_SAMPLE_DISPOSED,
            payload: {
              retention_sample_id: sample.retention_sample_id,
              lot_id: sample.lot_id,
              disposed_at: new Date().toISOString(),
            },
            metadata: {
              correlation_id: randomUUID(),
              causation_id: sample.source_event_id,
              actor: SYSTEM_ACTOR,
              occurred_at: new Date().toISOString(),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          undefined,
          client,
        );
        await client.query('RELEASE SAVEPOINT retention_sample_disposal');
        disposalPending += 1;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT retention_sample_disposal');
        await client.query('RELEASE SAVEPOINT retention_sample_disposal');
        failed += 1;
        console.error(
          `QC retention-sample disposal failed for ${sample.retention_sample_id}; skipped, will be retried next cycle:`,
          err,
        );
      }
    }

    await client.query('COMMIT');
    if (failed > 0) {
      console.error(
        `QC retention-sample expiry cycle completed with ${failed} failed row(s) out of ${due.length}.`,
      );
    }
    return { disposalPending, failed, cycleFailed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(
      'QC retention-sample expiry cycle failed - rolled back, rows will be swept again next cycle:',
      err,
    );
    // Distinguishable from a healthy empty tick: a caller (or an operator dashboard) can tell
    // "nothing was due" from "the sweep is broken", which the previous {disposalPending: 0} could
    // not.
    return { disposalPending: 0, failed: 0, cycleFailed: true };
  } finally {
    client.release();
  }
}

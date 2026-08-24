import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { emitNotification } from '../notify/emit.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { getLocationById } from '../read/projections/location_register.js';
import {
  getSpareCatalogueByGrain,
  listCriticalSpareGrains,
} from '../read/projections/maintenance_spare_catalogue.js';
import {
  getSpareReservationById,
  listOverdueReturns,
} from '../read/projections/maintenance_spare_reservation.js';
import { getSpareAlertForDay } from '../read/projections/maintenance_spare_alert.js';
import { getOwnedOnHandAndBelowMin } from '../read/projections/stock_balance.js';

/**
 * Story 7.4 spares job cycles (FR-M-08, FR-M-09). Pure functions driven by the authenticated POST
 * trigger in src/api/v1/maintenance.ts, mirroring src/maintenance/pm-jobs.ts and the Story 2.7
 * planning jobs. There is deliberately NO scheduler and no timer: "same-day breach alert" means
 * the alert carries the scan's business_date, and the scan is run daily by the operator or an
 * external scheduler. Every job is idempotent, so a duplicate invocation is harmless.
 *
 * business_date is the ONLY notion of "today" inside a job; wall-clock time is used solely for
 * flagged_at, occurred_at and audit timestamps. That keeps the jobs deterministic and testable
 * without clock mocking.
 *
 * Each grain is processed in its OWN transaction: the row it decides on is locked FOR UPDATE and
 * the resulting event is persisted through persistEvent on that SAME client (persistEvent accepts
 * an external client and then leaves the BEGIN/COMMIT to the caller), so two concurrent scans
 * serialize into exactly one alert rather than racing to the unique index. The index remains the
 * backstop. Notifications are emitted AFTER the transaction commits, using the non-throwing
 * emitNotification (AD-17), so a notification failure can never roll back an alert.
 */

export type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

export interface SpareJobActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface SpareJobScope {
  business_date: string;
  location_id?: string | undefined;
  sku?: string | undefined;
  actor: SpareJobActor;
  auditCtx?: AuditCtx | undefined;
}

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

// ---------------------------------------------------------------------------
// AC 3: critical-spares min-max breach scan (FR-M-09)
// ---------------------------------------------------------------------------

export interface SpareBreachScanResult {
  business_date: string;
  grains_evaluated: number;
  breaches_flagged: number;
  notifications_sent: number;
  alert_ids: string[];
}

/**
 * Compares owned on-hand against the configured minimum for every critical catalogued spare in
 * scope and raises one alert per breached grain per business_date.
 *
 * on_hand is the comparison basis, NOT `available`, matching runReplenishmentCheck: a spare that
 * is fully reserved but physically present in the store is not a stockout, and alerting on it
 * would fire on every large reservation. The comparison runs in SQL NUMERIC, never in JS floats.
 */
export async function runCriticalSpareBreachScan(
  scope: SpareJobScope,
): Promise<SpareBreachScanResult> {
  const grains = await listCriticalSpareGrains({
    location_id: scope.location_id ?? null,
    sku: scope.sku ?? null,
  });
  const alertIds: string[] = [];
  let notificationsSent = 0;

  for (const grain of grains) {
    const flaggedAt = new Date().toISOString();
    const correlationId = randomUUID();
    const alertId = randomUUID();

    let flagged = false;
    let onHandAtCheck = '0';
    try {
      flagged =
        (await inTransaction(async (client) => {
          // Lock the catalogue row so a concurrent scan for this grain serializes: the loser waits,
          // then sees the alert the winner committed and skips it.
          const locked = await getSpareCatalogueByGrain(grain.sku, grain.location_id, client, true);
          if (!locked || locked.min_level === null || !locked.is_critical) return null;

          // The scan's facts come from the ledger, not from anywhere else - on_hand is summed in
          // SQL NUMERIC and the at-or-below comparison is settled by the same query.
          const balance = await getOwnedOnHandAndBelowMin(
            locked.sku,
            locked.location_id,
            locked.min_level,
            client,
          );
          onHandAtCheck = balance.on_hand;
          if (!balance.below) return null;

          // Same-day guard: a re-run for a still-breached grain is a no-op, not a duplicate and
          // not an error. uq_maintenance_spare_alert_day is the concurrency backstop behind it.
          const existing = await getSpareAlertForDay(
            'min_breach',
            locked.sku,
            locked.location_id,
            null,
            scope.business_date,
            client,
          );
          if (existing) return null;

          await persistEvent(
            {
              stream_type: 'maintenance',
              stream_id: alertId,
              event_type: 'maintenance.critical_spare_breach_flagged',
              payload: {
                alert_id: alertId,
                sku: locked.sku,
                location_id: locked.location_id,
                on_hand_at_check: onHandAtCheck,
                min_level: locked.min_level,
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
      // A concurrent scan won the race to the unique index. Nothing was persisted by this pass,
      // so nothing may be counted or notified - but one lost race must not fail the whole scan.
      if (isAppErrorWithCode(err, 'DUPLICATE_SPARE_ALERT')) continue;
      throw err;
    }
    if (!flagged) continue;
    alertIds.push(alertId);

    const location = await getLocationById(grain.location_id);
    const emitted = await emitNotification({
      target: { role: 'maintenance_storekeeper', location_id: grain.location_id },
      event_type: 'critical_spare_breach',
      status_verb: 'Breached',
      object_type: 'spare',
      object_id: alertId,
      actor_label: `${grain.sku} at ${location?.location_code ?? grain.location_id}`,
      next_step: `On hand ${onHandAtCheck} is at or below the minimum ${grain.min_level}. Raise a replenishment order.`,
      actor: scope.actor,
      correlation_id: correlationId,
      occurred_at: flaggedAt,
    });
    if (emitted.ok) notificationsSent += 1;
  }

  return {
    business_date: scope.business_date,
    grains_evaluated: grains.length,
    breaches_flagged: alertIds.length,
    notifications_sent: notificationsSent,
    alert_ids: alertIds,
  };
}

// ---------------------------------------------------------------------------
// AC 2: overdue three-working-day spare returns (FR-M-08)
// ---------------------------------------------------------------------------

export interface OverdueReturnSweepResult {
  business_date: string;
  reservations_swept: number;
  escalations_raised: number;
  reservation_ids: string[];
}

/**
 * Flags every issued or partially returned spare whose frozen return_due_date has passed. This is
 * what stops return_due_date from being a dead column: FR-M-08's "returns due within 3 working
 * days" is only a real deadline if something reads it.
 *
 * reservations_swept and escalations_raised are SEPARATE counters, so a dropped notification stays
 * visible instead of being hidden behind the write count (the Story 7.2 lesson).
 */
export async function runOverdueReturnSweep(
  scope: SpareJobScope,
): Promise<OverdueReturnSweepResult> {
  const reservations = await listOverdueReturns(scope.business_date, {
    location_id: scope.location_id ?? null,
    sku: scope.sku ?? null,
  });
  const sweptIds: string[] = [];
  let escalationsRaised = 0;

  for (const reservation of reservations) {
    const flaggedAt = new Date().toISOString();
    const correlationId = randomUUID();
    const alertId = randomUUID();

    let flagged = false;
    try {
      flagged =
        (await inTransaction(async (client) => {
          // Re-read under lock: a return committed between the list read and this write must not
          // produce a phantom overdue alert.
          const locked = await getSpareReservationById(reservation.reservation_id, client, true);
          if (!locked || locked.return_due_date === null) return null;
          if (locked.status !== 'issued' && locked.status !== 'partially_returned') return null;
          if (locked.return_due_date >= scope.business_date) return null;

          const existing = await getSpareAlertForDay(
            'return_overdue',
            locked.sku,
            locked.location_id,
            locked.reservation_id,
            scope.business_date,
            client,
          );
          if (existing) return null;

          await persistEvent(
            {
              stream_type: 'maintenance',
              stream_id: alertId,
              event_type: 'maintenance.spare_return_overdue_flagged',
              payload: {
                alert_id: alertId,
                reservation_id: locked.reservation_id,
                sku: locked.sku,
                location_id: locked.location_id,
                return_due_date: locked.return_due_date,
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
      if (isAppErrorWithCode(err, 'DUPLICATE_SPARE_ALERT')) continue;
      throw err;
    }
    if (!flagged) continue;
    sweptIds.push(reservation.reservation_id);

    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: reservation.location_id },
      event_type: 'spare_return_overdue',
      status_verb: 'Overdue',
      object_type: 'spare_reservation',
      object_id: reservation.reservation_id,
      actor_label: `${reservation.sku} on work order ${reservation.work_order_id}`,
      next_step: `Due back on ${reservation.return_due_date}. Recover the spare or record the return.`,
      actor: scope.actor,
      correlation_id: correlationId,
      occurred_at: flaggedAt,
      escalation: { target_role: 'maintenance_manager', acknowledgment_window_seconds: 86400 },
    });
    if (emitted.ok) escalationsRaised += 1;
  }

  return {
    business_date: scope.business_date,
    reservations_swept: sweptIds.length,
    escalations_raised: escalationsRaised,
    reservation_ids: sweptIds,
  };
}

import { randomUUID } from 'node:crypto';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { emitNotification } from '../notify/emit.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { listSilentMeters } from '../read/projections/asset_meter.js';
import { listDuePlans } from '../read/projections/maintenance_plan.js';
import type { MaintenancePlanRow } from '../read/projections/maintenance_plan.js';
import {
  getWorkOrderByCycle,
  listGraceExpiredWorkOrders,
} from '../read/projections/maintenance_work_order.js';
import { getPlanById } from '../read/projections/maintenance_plan.js';
import { getAssetById } from '../read/projections/asset.js';
import { getMeterById } from '../read/projections/asset_meter.js';

/**
 * Story 7.2 preventive-maintenance job cycles (FR-M-02, FR-M-03). These are pure functions driven
 * by the authenticated POST triggers in src/api/v1/maintenance.ts, mirroring the Story 2.7
 * planning jobs and the src/notify cycle pattern. There is deliberately NO scheduler and no timer:
 * "monthly reconciliation" means the reconciliation job run monthly by the operator or an external
 * scheduler, and every job here is idempotent so a duplicate invocation is harmless.
 *
 * business_date is the ONLY notion of "today" inside a job; wall-clock time is used solely for
 * occurred_at and audit timestamps. That keeps the jobs deterministic and testable without clock
 * mocking.
 *
 * Jobs never mutate through raw SQL. They read committed read models, decide, and write through
 * persistEvent, which applies the projection inside the same transaction as the domain_events
 * insert. Notifications are emitted AFTER the state change has committed, using the non-throwing
 * emitNotification (AD-17), so a notification failure can never roll back an overdue transition.
 */

export type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

export interface MaintenanceJobActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface MaintenanceJobScope {
  business_date: string;
  asset_id?: string | undefined;
  actor: MaintenanceJobActor;
  auditCtx?: AuditCtx | undefined;
}

/** Adds whole days to an ISO date, in UTC, so no local-timezone shift can move a due date. */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  const base = Date.UTC(y!, m! - 1, d!);
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

function isAppErrorWithCode(err: unknown, code: string): boolean {
  return err instanceof AppError && err.errorCode === code;
}

// ---------------------------------------------------------------------------
// AC 1: generate work orders for plans that have come due
// ---------------------------------------------------------------------------

export interface PmGenerationResult {
  business_date: string;
  plans_evaluated: number;
  work_orders_generated: number;
  work_order_ids: string[];
  skipped_existing: number;
}

export async function runPmGeneration(scope: MaintenanceJobScope): Promise<PmGenerationResult> {
  const plans = await listDuePlans(scope.business_date, undefined, scope.asset_id);
  const workOrderIds: string[] = [];
  let skippedExisting = 0;

  for (const plan of plans) {
    // Catch-up loop: a plan can be several cycles behind its business_date (a meter that jumped
    // several thresholds at once, or a calendar plan several intervals behind the run date).
    // Each persist advances the cursor by exactly one interval in the same transaction, so the
    // plan may still be due afterwards; keep generating until it is not. That makes a re-run on
    // the same business_date generate nothing, which is the Task 5.2 promise.
    let current = plan;
    let cycles = 0;
    // Safety cap: a pathological combination of caps (a meter plan with interval 0.0001 and a
    // huge jump) could otherwise loop ~1e18 times; 1000 cycles per plan per run bounds the work,
    // and the plan simply stays due for a later run.
    const MAX_CATCH_UP_CYCLES = 1000;
    while (cycles < MAX_CATCH_UP_CYCLES) {
      cycles += 1;
      const cycleKey = cycleKeyFor(current);
      if (cycleKey === null) break;

      // Cheap pre-filter for the ordinary re-run case; the seam repeats this check under a lock
      // and uq_maintenance_work_order_cycle is the concurrency backstop. A work order existing
      // for the CURRENT cursor can only mean a manually edited row (the seam always advances in
      // the same transaction), so stop rather than loop.
      const existing = await getWorkOrderByCycle(current.plan_id, cycleKey);
      if (existing) {
        skippedExisting += 1;
        break;
      }

      // A calendar plan is due on its own next_due_date; a meter plan becomes due the moment its
      // meter crosses the threshold, so the work order is dated the day the job noticed.
      const dueDate =
        current.plan_type === 'calendar'
          ? (current.next_due_date ?? scope.business_date)
          : scope.business_date;
      const workOrderId = randomUUID();

      try {
        await persistEvent(
          {
            stream_type: 'maintenance',
            stream_id: workOrderId,
            event_type: 'maintenance.work_order_generated',
            payload: {
              work_order_id: workOrderId,
              plan_id: current.plan_id,
              asset_id: current.asset_id,
              due_date: dueDate,
              grace_until_date: addDays(dueDate, current.grace_period_days),
              generated_for_cycle: cycleKey,
              business_date: scope.business_date,
            },
            metadata: {
              correlation_id: randomUUID(),
              actor: scope.actor,
              occurred_at: new Date().toISOString(),
            },
            idempotency_key: randomUUID(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          scope.auditCtx,
        );
        workOrderIds.push(workOrderId);
      } catch (err: unknown) {
        // A concurrent run won this cycle. That is the correct outcome (exactly one work order),
        // not a job failure. The winner advanced the cursor, so the re-check below continues the
        // catch-up from the next cycle.
        if (isAppErrorWithCode(err, 'DUPLICATE_WORK_ORDER')) {
          skippedExisting += 1;
          continue;
        }
        // INVALID_PARAMS here means this plan's cycle overflowed the 4-digit date horizon
        // (grace_until_date rendered a 5-digit year) - a plan anchored years beyond any real
        // lifetime. The plan stays due and visible via GET /plans, but one pathological plan
        // must never abort the whole run.
        if (isAppErrorWithCode(err, 'INVALID_PARAMS')) {
          continue;
        }
        throw err;
      }

      // The cursor advanced one interval in the same transaction; re-read the plan (and its
      // meter) to check whether it is still due, so the next cycle key comes from the current
      // cursor.
      const refreshed = await getPlanById(current.plan_id);
      if (!refreshed) break;
      if (refreshed.plan_type === 'calendar') {
        if (!refreshed.next_due_date || refreshed.next_due_date > scope.business_date) break;
      } else {
        if (!refreshed.next_due_meter) break;
        const meter = refreshed.meter_id === null ? null : await getMeterById(refreshed.meter_id);
        if (!meter) break;
        // NUMERIC values are exactly representable as doubles for realistic readings (per the
        // accessor header); the comparison mirrors listDuePlans' SQL predicate.
        if (Number(meter.current_reading) < Number(refreshed.next_due_meter)) break;
      }
      current = refreshed;
    }
  }

  return {
    business_date: scope.business_date,
    plans_evaluated: plans.length,
    work_orders_generated: workOrderIds.length,
    work_order_ids: workOrderIds,
    skipped_existing: skippedExisting,
  };
}

/**
 * The anti-double-generation key for one due cycle: the ISO due date for a calendar plan, the
 * serialized due-meter threshold for a meter plan. Both are stable strings that change only when
 * the plan's cursor advances.
 */
function cycleKeyFor(plan: MaintenancePlanRow): string | null {
  if (plan.plan_type === 'calendar') return plan.next_due_date;
  return plan.next_due_meter;
}

// ---------------------------------------------------------------------------
// AC 2: transition grace-expired work orders to overdue and escalate
// ---------------------------------------------------------------------------

export interface GraceSweepResult {
  business_date: string;
  work_orders_swept: number;
  escalations_raised: number;
  work_order_ids: string[];
}

export async function runGraceWindowSweep(scope: MaintenanceJobScope): Promise<GraceSweepResult> {
  const workOrders = await listGraceExpiredWorkOrders(
    scope.business_date,
    undefined,
    scope.asset_id,
  );
  const sweptIds: string[] = [];
  let escalationsRaised = 0;

  for (const workOrder of workOrders) {
    const occurredAt = new Date().toISOString();
    const correlationId = randomUUID();
    try {
      await persistEvent(
        {
          stream_type: 'maintenance',
          stream_id: workOrder.work_order_id,
          event_type: 'maintenance.work_order_overdue',
          payload: {
            work_order_id: workOrder.work_order_id,
            plan_id: workOrder.plan_id,
            asset_id: workOrder.asset_id,
            grace_until_date: workOrder.grace_until_date,
            business_date: scope.business_date,
          },
          metadata: {
            correlation_id: correlationId,
            actor: scope.actor,
            occurred_at: occurredAt,
          },
          idempotency_key: randomUUID(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        scope.auditCtx,
      );
    } catch (err: unknown) {
      // A completion won the race between the list read and this write: the applier rejected
      // with WORK_ORDER_NOT_OPEN, so nothing was persisted and nothing may be notified or
      // counted. Move on - one late completion cannot fail the whole sweep.
      if (isAppErrorWithCode(err, 'WORK_ORDER_NOT_OPEN')) continue;
      throw err;
    }
    sweptIds.push(workOrder.work_order_id);

    // The escalation target is carried as DATA on the plan (escalation_role), so no role name is
    // branched on here (FR-DOA-01 / eslint no-hardcoded-role-in-workflow). The Notification
    // Contract label names the asset and the plan, so the asset name is resolved (with the id as
    // fallback when the row is missing).
    const plan = workOrder.plan_id === null ? null : await getPlanById(workOrder.plan_id);
    if (plan === null) continue;
    const planAsset = await getAssetById(plan.asset_id);
    const emitted = await emitNotification({
      target: { role: plan.escalation_role },
      event_type: 'pm_work_order_overdue',
      status_verb: 'overdue',
      object_type: 'maintenance_work_order',
      object_id: workOrder.work_order_id,
      actor_label: `PM plan ${plan.plan_name} - ${planAsset?.asset_name ?? `asset ${plan.asset_id}`}`,
      next_step: 'Reschedule or reassign this preventive maintenance work order.',
      actor: scope.actor,
      correlation_id: correlationId,
      occurred_at: occurredAt,
    });
    if (emitted.ok) escalationsRaised += 1;
  }

  return {
    business_date: scope.business_date,
    work_orders_swept: sweptIds.length,
    escalations_raised: escalationsRaised,
    work_order_ids: sweptIds,
  };
}

// ---------------------------------------------------------------------------
// AC 5: reconcile meters and raise silent-meter alerts
// ---------------------------------------------------------------------------

export interface MeterReconciliationResult {
  business_date: string;
  meters_evaluated: number;
  meters_flagged: number;
  meter_ids: string[];
  alerts_raised: number;
}

export async function runMeterReconciliation(
  scope: MaintenanceJobScope,
): Promise<MeterReconciliationResult> {
  const meters = await listSilentMeters(scope.business_date, undefined, scope.asset_id);
  const flaggedIds: string[] = [];
  let alertsRaised = 0;

  for (const meter of meters) {
    const occurredAt = new Date().toISOString();
    const correlationId = randomUUID();
    try {
      await persistEvent(
        {
          stream_type: 'maintenance',
          stream_id: meter.meter_id,
          event_type: 'maintenance.meter_silent_flagged',
          payload: {
            meter_id: meter.meter_id,
            asset_id: meter.asset_id,
            business_date: scope.business_date,
            last_reading_at: meter.last_reading_at,
            silent_after_days: meter.silent_after_days,
          },
          metadata: {
            correlation_id: correlationId,
            actor: scope.actor,
            occurred_at: occurredAt,
          },
          idempotency_key: randomUUID(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        scope.auditCtx,
      );
    } catch (err: unknown) {
      // A reading landed (or an overlapping run won) between the list read and this write: the
      // applier re-checked the silent predicate under the lock and rejected with METER_NOT_SILENT,
      // so nothing was persisted and no second alert may be raised (the "re-run raises no second
      // escalation" binding decision). Move on.
      if (isAppErrorWithCode(err, 'METER_NOT_SILENT')) continue;
      throw err;
    }
    flaggedIds.push(meter.meter_id);

    // The alert target is carried as DATA on the meter (alert_role). The label names the asset
    // and the meter per the Notification Contract; alerts_raised exposes a dropped delivery the
    // same way the sweep's escalations_raised does (AD-17: a failure never rolls back the flag).
    const meterAsset = await getAssetById(meter.asset_id);
    const emitted = await emitNotification({
      target: { role: meter.alert_role },
      event_type: 'meter_silent',
      status_verb: 'flagged',
      object_type: 'asset_meter',
      object_id: meter.meter_id,
      actor_label: `Meter ${meter.meter_code} - ${meterAsset?.asset_name ?? `asset ${meter.asset_id}`}`,
      next_step: 'Submit a current reading or investigate why this meter stopped reporting.',
      actor: scope.actor,
      correlation_id: correlationId,
      occurred_at: occurredAt,
    });
    if (emitted.ok) alertsRaised += 1;
  }

  return {
    business_date: scope.business_date,
    meters_evaluated: meters.length,
    meters_flagged: flaggedIds.length,
    meter_ids: flaggedIds,
    alerts_raised: alertsRaised,
  };
}

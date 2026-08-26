import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { getAssetById, lockAssetById } from '../read/projections/asset.js';
import { getMeterById } from '../read/projections/asset_meter.js';
import {
  advancePlanCalendarDue,
  advancePlanMeterDue,
  getPlanById,
  getPlanByName,
  insertPlan,
} from '../read/projections/maintenance_plan.js';
import {
  getWorkOrderByCycle,
  getWorkOrderById,
  insertWorkOrder,
  setWorkOrderCompleted,
  setWorkOrderCosts,
  setWorkOrderOverdue,
} from '../read/projections/maintenance_work_order.js';
import { upsertMaintenanceAssetCost } from '../read/projections/maintenance_asset_cost.js';
// Story 7.7 (FR-M-11): the chargeable-work gate reads the reason-coded override grain.
import { getWarrantyOverrideByWorkOrder } from '../read/projections/maintenance_warranty_override.js';
import {
  getExaminationByAssetAndType,
  setStatutoryExaminationStatus,
} from '../read/projections/statutory_examination.js';

/**
 * Story 7.2 compliance seam for PM plans and their work orders (FR-M-02). Structurally mirrors
 * src/compliance/asset.ts. Every read-then-write takes FOR UPDATE on the row it is about to
 * change, and the generation applier advances the plan's due cursor in the SAME transaction as
 * the work-order insert so a plan can never emit two work orders for one cycle.
 *
 * Story 7.6 (FR-M-15) added the additive cost arm to applyWorkOrderCompleted, and Story 7.7
 * (FR-M-11, AC 3) added the chargeable-work gate ahead of it: a warranty-flagged work order cannot
 * be completed without a recorded reason-coded override, enforced in the seam so a direct event
 * cannot bypass it (AD-12).
 */

const MAINTENANCE_STREAM_TYPES = new Set(['maintenance']);
const MAINTENANCE_PLAN_EVENT_TYPES = new Set([
  'maintenance.plan_defined',
  'maintenance.work_order_generated',
  'maintenance.work_order_overdue',
  'maintenance.work_order_completed',
]);

const PLAN_TYPES = new Set(['calendar', 'meter']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// Story 7.6 (FR-M-15): the cost columns are NUMERIC(14,3), so a cost string can carry at most 11
// integer digits and 3 decimals - a wider value would overflow the column as an unmapped 22003 500.
// Costs are exact decimal strings end to end; they are never converted to a JS float.
const COST_NUMERIC_REGEX = /^\d{1,11}(\.\d{1,3})?$/;
// Day-count cap for the interval fields: 100000 days is ~274 years, far beyond any real PM plan,
// and keeps PostgreSQL date arithmetic (and the jobs' JS addDays) inside their ranges - the
// INTEGER-column range alone (2^31-1 days, ~5.8M years) overflows both.
const MAX_INTERVAL_DAYS = 100000;
// 4-digit safety horizon for plan dates. The cursor advances by interval_days every cycle, so any
// finite horizon is eventually passed; bounding the definition (~974 years from now) keeps the
// overflow unreachable within any conceivable plan lifetime, and the generation job additionally
// skips (rather than aborts on) a plan whose cycle overflows anyway.
const MAX_PLAN_HORIZON = '2999-12-31';

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value))
  );
}

/**
 * Adds whole days to an ISO date, in UTC, so no local-timezone shift can move a due date. Mirrors
 * the job's addDays: the seam recomputes the derived grace_until_date from the plan row.
 */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  const base = Date.UTC(y!, m! - 1, d!);
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

/**
 * The plan columns are NUMERIC(18,4): a value beyond the range or with more than 4 decimal
 * places either raises an unmapped 22003 (raw 500) or is silently rounded in the projected row
 * while the event payload keeps the original - the same event/row disagreement the seam's text
 * normalization exists to prevent. NUMERIC(18,4) holds up to 99999999999999.9999, so strict
 * `< 1e14` is exactly the representable bound (1e14 itself overflows the column).
 */
function fitsNumeric184(value: number): boolean {
  const scaled = value * 10000;
  return value < 1e14 && Math.abs(scaled - Math.round(scaled)) <= 1e-9;
}

export function maintenancePlanEventType(envelope: EventEnvelope): string | null {
  if (!MAINTENANCE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!MAINTENANCE_PLAN_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertMaintenancePlanShape(envelope: EventEnvelope): void {
  const type = maintenancePlanEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'maintenance.plan_defined':
      assertPlanDefinedShape(p);
      break;
    case 'maintenance.work_order_generated':
      assertWorkOrderGeneratedShape(p);
      break;
    case 'maintenance.work_order_overdue':
      assertWorkOrderOverdueShape(p);
      break;
    case 'maintenance.work_order_completed':
      assertWorkOrderCompletedShape(p);
      break;
  }
}

function assertPlanDefinedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['plan_id'])) reject('INVALID_PARAMS', 'plan_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isNonEmptyString(p['plan_name']))
    reject('INVALID_PARAMS', 'plan_name is required and must be a non-empty string');
  if (!isNonEmptyString(p['plan_type']) || !PLAN_TYPES.has(p['plan_type'] as string)) {
    reject('INVALID_PARAMS', 'plan_type is required and must be one of: calendar, meter', {
      plan_type: p['plan_type'],
    });
  }
  const grace = p['grace_period_days'];
  if (!Number.isInteger(grace) || (grace as number) < 0 || (grace as number) > MAX_INTERVAL_DAYS) {
    reject(
      'INVALID_PARAMS',
      `grace_period_days must be an integer of 0 or more, at most ${MAX_INTERVAL_DAYS}`,
      {
        grace_period_days: grace,
      },
    );
  }
  if (!isNonEmptyString(p['escalation_role']))
    reject('INVALID_PARAMS', 'escalation_role is required and must be a non-empty string');
  if (!isIsoDate(p['anchor_date']))
    reject('INVALID_PARAMS', 'anchor_date is required and must be an ISO date (YYYY-MM-DD)', {
      anchor_date: p['anchor_date'],
    });
  // A plan anchored beyond the safety horizon would overflow the 4-digit date range while the
  // cursor advances (see MAX_PLAN_HORIZON); reject the definition here instead of bricking the
  // generation job thousands of cycles later.
  if ((p['anchor_date'] as string) > MAX_PLAN_HORIZON) {
    reject('INVALID_PARAMS', `anchor_date must not be after ${MAX_PLAN_HORIZON}`, {
      anchor_date: p['anchor_date'],
    });
  }

  if (p['plan_type'] === 'calendar') {
    const intervalDays = p['interval_days'];
    if (
      !Number.isInteger(intervalDays) ||
      (intervalDays as number) <= 0 ||
      (intervalDays as number) > MAX_INTERVAL_DAYS
    ) {
      reject(
        'INVALID_PARAMS',
        `interval_days must be a positive integer of at most ${MAX_INTERVAL_DAYS} for a calendar plan`,
        {
          interval_days: intervalDays,
        },
      );
    }
    if (!isIsoDate(p['next_due_date']))
      reject('INVALID_PARAMS', 'next_due_date must be an ISO date for a calendar plan', {
        next_due_date: p['next_due_date'],
      });
    // The first due cycle cannot precede the anchor: a backdated override makes the plan
    // born-due with an already-expired grace window (instantly sweepable).
    if ((p['next_due_date'] as string) < (p['anchor_date'] as string)) {
      reject('INVALID_PARAMS', 'next_due_date must not be before anchor_date', {
        next_due_date: p['next_due_date'],
        anchor_date: p['anchor_date'],
      });
    }
    if ((p['next_due_date'] as string) > MAX_PLAN_HORIZON) {
      reject('INVALID_PARAMS', `next_due_date must not be after ${MAX_PLAN_HORIZON}`, {
        next_due_date: p['next_due_date'],
      });
    }
    // The first generated grace window is next_due_date + grace_period_days; beyond the 4-digit
    // ceiling it renders a 5-digit year the seam rejects, bricking the plan at every generation
    // run. Reject the definition here instead (the anchor + interval derivation that overflows
    // is already a clean 400 at the seam's isIsoDate check).
    if (addDays(p['next_due_date'] as string, grace as number) > '9999-12-31') {
      reject('INVALID_PARAMS', 'next_due_date plus grace_period_days must not exceed 9999-12-31', {
        next_due_date: p['next_due_date'],
        grace_period_days: grace,
      });
    }
    if (p['meter_id'] != null || p['interval_meter_units'] != null || p['next_due_meter'] != null) {
      reject('INVALID_PARAMS', 'a calendar plan must not carry meter fields');
    }
  } else {
    if (!isUuid(p['meter_id']))
      reject('INVALID_PARAMS', 'meter_id is required and must be a UUID for a meter plan');
    const intervalUnits = p['interval_meter_units'];
    if (
      typeof intervalUnits !== 'number' ||
      !Number.isFinite(intervalUnits) ||
      intervalUnits <= 0 ||
      !fitsNumeric184(intervalUnits as number)
    ) {
      reject(
        'INVALID_PARAMS',
        'interval_meter_units must be a positive number fitting NUMERIC(18,4) for a meter plan',
        {
          interval_meter_units: intervalUnits,
        },
      );
    }
    // next_due_meter is OPTIONAL: when omitted, applyPlanDefined derives it from the meter row
    // read under FOR UPDATE (the "falls due one interval after the meter's reading at definition
    // time" contract, race-free). An explicit body override still wins.
    const nextDueMeter = p['next_due_meter'];
    if (nextDueMeter !== null && nextDueMeter !== undefined) {
      if (
        typeof nextDueMeter !== 'number' ||
        !Number.isFinite(nextDueMeter) ||
        nextDueMeter < 0 ||
        !fitsNumeric184(nextDueMeter as number)
      ) {
        reject(
          'INVALID_PARAMS',
          'next_due_meter must be a non-negative number fitting NUMERIC(18,4) for a meter plan',
          {
            next_due_meter: nextDueMeter,
          },
        );
      }
      // The cursor advances by interval_meter_units in SQL (advancePlanMeterDue); the sum must
      // stay inside NUMERIC(18,4) or the first generation run rolls back with an unmapped 22003
      // and the plan is bricked.
      if ((nextDueMeter as number) + (intervalUnits as number) >= 1e14) {
        reject(
          'INVALID_PARAMS',
          'next_due_meter plus interval_meter_units must stay below NUMERIC(18,4) range',
          {
            next_due_meter: nextDueMeter,
            interval_meter_units: intervalUnits,
          },
        );
      }
    }
    if (p['interval_days'] != null || p['next_due_date'] != null) {
      reject('INVALID_PARAMS', 'a meter plan must not carry calendar fields');
    }
  }
}

function assertWorkOrderGeneratedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['work_order_id']))
    reject('INVALID_PARAMS', 'work_order_id is required and must be a UUID');
  if (!isUuid(p['plan_id'])) reject('INVALID_PARAMS', 'plan_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isIsoDate(p['due_date']))
    reject('INVALID_PARAMS', 'due_date is required and must be an ISO date', {
      due_date: p['due_date'],
    });
  if (!isIsoDate(p['grace_until_date']))
    reject('INVALID_PARAMS', 'grace_until_date is required and must be an ISO date', {
      grace_until_date: p['grace_until_date'],
    });
  if (!isIsoDate(p['business_date']))
    reject('INVALID_PARAMS', 'business_date is required and must be an ISO date', {
      business_date: p['business_date'],
    });
  // The work order table enforces grace_until_date >= due_date (chk_maintenance_work_order_grace);
  // validating here keeps a malformed direct-event envelope a stable 400 instead of an unmapped
  // 23514 500. ISO date strings compare lexicographically.
  if ((p['grace_until_date'] as string) < (p['due_date'] as string)) {
    reject('INVALID_PARAMS', 'grace_until_date must not be before due_date', {
      due_date: p['due_date'],
      grace_until_date: p['grace_until_date'],
    });
  }
  if (!isNonEmptyString(p['generated_for_cycle']))
    reject('INVALID_PARAMS', 'generated_for_cycle is required and must be a non-empty string');
}

function assertWorkOrderOverdueShape(p: Record<string, unknown>): void {
  if (!isUuid(p['work_order_id']))
    reject('INVALID_PARAMS', 'work_order_id is required and must be a UUID');
  if (p['plan_id'] != null && !isUuid(p['plan_id']))
    reject('INVALID_PARAMS', 'plan_id must be a UUID when present');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (!isIsoDate(p['grace_until_date']))
    reject('INVALID_PARAMS', 'grace_until_date is required and must be an ISO date', {
      grace_until_date: p['grace_until_date'],
    });
  if (!isIsoDate(p['business_date']))
    reject('INVALID_PARAMS', 'business_date is required and must be an ISO date', {
      business_date: p['business_date'],
    });
}

function assertWorkOrderCompletedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['work_order_id']))
    reject('INVALID_PARAMS', 'work_order_id is required and must be a UUID');
  if (!isUuid(p['asset_id'])) reject('INVALID_PARAMS', 'asset_id is required and must be a UUID');
  if (typeof p['completed_at'] !== 'string' || Number.isNaN(Date.parse(p['completed_at']))) {
    reject('INVALID_PARAMS', 'completed_at is required and must be an ISO timestamp', {
      completed_at: p['completed_at'],
    });
  }
  // Story 7.6 (FR-M-15): optional additive cost fields, NUMERIC strings. A declared non-string or
  // a string that fails the regex is rejected INVALID_COST, never coerced (the wire-boolean lesson
  // applied to costs). Absent fields mean the completion carries no cost and the cost path is
  // skipped; total_cost / capitalization_flagged are applier-derived and only ever appear on
  // persisted write-backs, so a forged declaration is checked in the applier, not here.
  const laborCost = p['labor_cost'];
  if (laborCost !== undefined && laborCost !== null) {
    if (typeof laborCost !== 'string' || !COST_NUMERIC_REGEX.test(laborCost)) {
      reject('INVALID_COST', 'labor_cost must be a NUMERIC string with at most 3 decimals', {
        labor_cost: laborCost,
      });
    }
  }
  const partsCost = p['parts_cost'];
  if (partsCost !== undefined && partsCost !== null) {
    if (typeof partsCost !== 'string' || !COST_NUMERIC_REGEX.test(partsCost)) {
      reject('INVALID_COST', 'parts_cost must be a NUMERIC string with at most 3 decimals', {
        parts_cost: partsCost,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyMaintenancePlanProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = maintenancePlanEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'maintenance.plan_defined':
      await applyPlanDefined(envelope, client);
      break;
    case 'maintenance.work_order_generated':
      await applyWorkOrderGenerated(envelope, client);
      break;
    case 'maintenance.work_order_overdue':
      await applyWorkOrderOverdue(envelope, client);
      break;
    case 'maintenance.work_order_completed':
      await applyWorkOrderCompleted(envelope, client);
      break;
  }
}

async function applyPlanDefined(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const assetId = p['asset_id'] as string;
  const planType = p['plan_type'] as 'calendar' | 'meter';

  const asset = await getAssetById(assetId, client);
  if (!asset) {
    reject('ASSET_NOT_FOUND', 'Asset not found', { asset_id: assetId }, 404);
  }

  const meterId = planType === 'meter' ? (p['meter_id'] as string) : null;
  let nextDueMeterValue = p['next_due_meter'] as number | null | undefined;
  if (meterId !== null) {
    // FOR UPDATE: when the payload omits next_due_meter, the first due threshold is derived from
    // THIS locked row below, so a reading committing between a handler pre-read and the persist
    // can no longer define the plan already-due.
    const meter = await getMeterById(meterId, client, true);
    if (!meter) {
      reject('METER_NOT_FOUND', 'Meter not found', { meter_id: meterId }, 404);
    }
    // A plan can only be driven by a meter mounted on its own asset; otherwise the plan would
    // schedule maintenance on one machine from another machine's usage.
    if (meter.asset_id !== assetId) {
      reject('PLAN_METER_MISMATCH', 'The meter belongs to a different asset', {
        meter_id: meterId,
        meter_asset_id: meter.asset_id,
        plan_asset_id: assetId,
      });
    }
    // Derive the first due threshold from the locked meter when the envelope omits it; the
    // explicit override (validated in the shape assert) still wins.
    if (nextDueMeterValue === null || nextDueMeterValue === undefined) {
      nextDueMeterValue = Number(meter.current_reading) + (p['interval_meter_units'] as number);
    }
  }

  const planName = (p['plan_name'] as string).trim();
  const existing = await getPlanByName(assetId, planName, client, true);
  if (existing) {
    reject(
      'DUPLICATE_PLAN',
      'A plan with this name already exists on this asset',
      { asset_id: assetId, plan_name: planName, existing_plan_id: existing.plan_id },
      409,
    );
  }

  await insertPlan(
    {
      plan_id: p['plan_id'] as string,
      asset_id: assetId,
      plan_name: planName,
      plan_type: planType,
      interval_days: planType === 'calendar' ? (p['interval_days'] as number) : null,
      meter_id: meterId,
      interval_meter_units: planType === 'meter' ? (p['interval_meter_units'] as number) : null,
      grace_period_days: p['grace_period_days'] as number,
      escalation_role: (p['escalation_role'] as string).trim(),
      anchor_date: p['anchor_date'] as string,
      next_due_date: planType === 'calendar' ? (p['next_due_date'] as string) : null,
      next_due_meter: planType === 'meter' ? (nextDueMeterValue as number) : null,
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

async function applyWorkOrderGenerated(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const now = new Date().toISOString();
  const planId = p['plan_id'] as string;
  const cycleKey = p['generated_for_cycle'] as string;
  const dueDate = p['due_date'] as string;

  const plan = await getPlanById(planId, client, true);
  if (!plan) {
    reject('PLAN_NOT_FOUND', 'Maintenance plan not found', { plan_id: planId }, 404);
  }

  // The payload must describe the plan's CURRENT due cycle: a calendar cycle is its own
  // next_due_date, a meter cycle its next_due_meter. Anything else is either a stale concurrent
  // envelope (the winner already advanced the cursor) or a forgery - both must never rewrite the
  // schedule. Reject with the same code the generation job already handles so a racing winner is
  // counted as skipped rather than failing the run.
  const cycleMatches =
    plan.plan_type === 'calendar'
      ? dueDate === plan.next_due_date && cycleKey === plan.next_due_date
      : cycleKey === plan.next_due_meter;
  if (!cycleMatches) {
    reject('DUPLICATE_WORK_ORDER', "The payload does not match the plan's current due cycle", {
      plan_id: planId,
      expected_cycle: plan.plan_type === 'calendar' ? plan.next_due_date : plan.next_due_meter,
      generated_for_cycle: cycleKey,
    });
  }

  // Task 5.2 derivation, enforced server-side: a meter plan's work order is dated the day the job
  // noticed (the business_date), and the grace window is always due_date + the plan's own
  // grace_period_days. A direct envelope cannot date a work order in the past with an expired
  // window (immediately sweepable) or extend a window beyond the plan's configuration.
  if (plan.plan_type === 'meter' && dueDate !== (p['business_date'] as string)) {
    reject('INVALID_PARAMS', 'due_date must be the business_date for a meter plan', {
      plan_id: planId,
      due_date: dueDate,
      business_date: p['business_date'],
    });
  }
  const expectedGrace = addDays(dueDate, plan.grace_period_days);
  if (p['grace_until_date'] !== expectedGrace) {
    reject('INVALID_PARAMS', 'grace_until_date must equal due_date + grace_period_days', {
      plan_id: planId,
      due_date: dueDate,
      grace_period_days: plan.grace_period_days,
      expected_grace_until_date: expectedGrace,
      grace_until_date: p['grace_until_date'],
    });
  }

  // The anti-double-generation key. uq_maintenance_work_order_cycle is the concurrency backstop;
  // this pre-check under the plan's FOR UPDATE lock gives the stable DUPLICATE_WORK_ORDER.
  const existing = await getWorkOrderByCycle(planId, cycleKey, client, true);
  if (existing) {
    reject(
      'DUPLICATE_WORK_ORDER',
      'A work order already exists for this plan cycle',
      {
        plan_id: planId,
        generated_for_cycle: cycleKey,
        existing_work_order_id: existing.work_order_id,
      },
      409,
    );
  }

  await insertWorkOrder(
    {
      work_order_id: p['work_order_id'] as string,
      plan_id: planId,
      // The plan row is the authoritative asset binding (it was validated at plan_defined time);
      // a direct-event envelope cannot hang a work order on a foreign asset.
      asset_id: plan.asset_id,
      origin: 'preventive',
      due_date: dueDate,
      grace_until_date: p['grace_until_date'] as string,
      generated_for_cycle: cycleKey,
      created_at: now,
      updated_at: now,
    },
    client,
  );

  // Advancing the cursor in the SAME transaction is what makes the generation job safe to re-run:
  // the plan is no longer due for this cycle the moment the work order exists. The cursor check
  // above guarantees the payload due date equals the plan's cursor, so advancing from the plan row
  // is identical to the payload value and cannot be skewed by a forged envelope.
  if (plan.plan_type === 'calendar') {
    await advancePlanCalendarDue(planId, plan.next_due_date!, client);
  } else {
    await advancePlanMeterDue(planId, client);
  }
}

async function applyWorkOrderOverdue(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const workOrderId = p['work_order_id'] as string;

  const workOrder = await getWorkOrderById(workOrderId, client, true);
  if (!workOrder) {
    reject('WORK_ORDER_NOT_FOUND', 'Work order not found', { work_order_id: workOrderId }, 404);
  }
  // A completion that commits between the sweep's read and this write must win: reject with a
  // catchable code rather than silently returning, so the caller neither persists a work_order_
  // overdue event AFTER a completion nor raises an escalation for completed work. The job catches
  // the code and moves on, so one late completion cannot fail the whole sweep.
  if (workOrder.status !== 'open') {
    reject('WORK_ORDER_NOT_OPEN', 'The work order is not open; nothing to sweep', {
      work_order_id: workOrderId,
      status: workOrder.status,
    });
  }
  // The grace window defines WHEN overdue is reachable; a direct envelope cannot mark an open
  // work order overdue before its window expires. Strictly-after matches the spec Task 4.4
  // predicate (grace_until_date < businessDate) that the sweep's list uses. ISO date strings
  // compare lexicographically.
  if ((p['business_date'] as string) <= workOrder.grace_until_date) {
    reject('INVALID_PARAMS', 'business_date must be on or after grace_until_date to sweep', {
      work_order_id: workOrderId,
      grace_until_date: workOrder.grace_until_date,
      business_date: p['business_date'],
    });
  }

  await setWorkOrderOverdue(
    workOrderId,
    envelope.metadata.occurred_at ?? new Date().toISOString(),
    client,
  );
}

async function applyWorkOrderCompleted(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const workOrderId = p['work_order_id'] as string;
  const declaredAssetId = p['asset_id'] as string;

  // Locking contract step 1: the asset row, FOR UPDATE. The payload declares asset_id; the work
  // order's binding is re-verified below under the work order's own lock, and a mismatch rejects
  // COST_DERIVATION_MISMATCH (a completion can never hang costs or a stamp flip on a foreign asset).
  const assetExists = await lockAssetById(declaredAssetId, client);
  if (!assetExists) {
    reject('ASSET_NOT_FOUND', 'Asset not found', { asset_id: declaredAssetId }, 404);
  }

  // Locking contract step 2: the weighbridge statutory examination row for this asset, if it
  // exists. Binding Decision 6: a completed work order on a weighbridge asset invalidates the
  // stamp (re-stamp required, AC2). Conservative Phase-1: ANY completed work order flips it, and
  // the lock serializes the flip against a concurrent re-stamp.
  const weighbridgeExamination = await getExaminationByAssetAndType(
    declaredAssetId,
    'weighbridge_legal_metrology',
    client,
    true,
  );

  // Locking contract step 6: the work order row, FOR UPDATE. Read after the asset and the
  // weighbridge row so every multi-row applier in this story acquires those locks in the same
  // fixed order; a rejection below rolls back the earlier row touches with no residue.
  const workOrder = await getWorkOrderById(workOrderId, client, true);
  if (!workOrder) {
    reject('WORK_ORDER_NOT_FOUND', 'Work order not found', { work_order_id: workOrderId }, 404);
  }
  if (workOrder.asset_id !== declaredAssetId) {
    reject(
      'COST_DERIVATION_MISMATCH',
      'Declared asset_id does not match the work order',
      {
        work_order_id: workOrderId,
        declared_asset_id: declaredAssetId,
        derived_asset_id: workOrder.asset_id,
      },
      409,
    );
  }
  if (workOrder.status === 'completed') {
    reject(
      'WORK_ORDER_ALREADY_COMPLETED',
      'This work order is already completed',
      { work_order_id: workOrderId, completed_at: workOrder.completed_at },
      409,
    );
  }
  // An overdue work order CAN be completed - late completion is normal maintenance reality and
  // must not be blocked.

  // Story 7.7 (FR-M-11, AC 3): the chargeable-work gate. Completion IS the charge event in this
  // codebase (the Story 7.6 cost arm posts labor_cost, parts_cost and total_cost only here), so a
  // warranty-flagged work order cannot be completed until a reason-coded override is recorded -
  // regardless of whether cost fields are present (Binding Decision 1). Enforced HERE under the
  // work order's own lock, not only in completeWorkOrderBase, so the direct-event and future edge
  // upload paths cannot bypass it (AD-12). The override read is a plain SELECT under the lock
  // already held, so the asset -> weighbridge examination -> work order order is unchanged.
  if (workOrder.warranty_flagged === true) {
    const override = await getWarrantyOverrideByWorkOrder(workOrderId, client);
    if (!override) {
      reject(
        'APPROVAL_REQUIRED',
        'This work order is warranty-flagged: record a reason-coded override before completing it',
        {
          work_order_id: workOrderId,
          warranty_coverage_id: workOrder.warranty_coverage_id,
        },
        403,
      );
    }
  }

  await setWorkOrderCompleted(
    workOrderId,
    envelope.metadata.occurred_at ?? new Date().toISOString(),
    envelope.metadata.actor.user_id,
    client,
  );

  // Story 7.6 (FR-M-15): the additive cost path runs only when cost fields are present. All
  // arithmetic runs in PostgreSQL NUMERIC; costs enter and leave as exact decimal strings, never a
  // JS float (the Story 5.6 BOM cost rollup pattern). total_cost and capitalization_flagged are
  // DERIVED here and written back onto the persisted payload; a forged declared value that
  // disagrees rejects COST_DERIVATION_MISMATCH (a declared-but-unchecked field is a silent
  // corruption channel).
  // An explicit null means "no cost on this completion", exactly as an absent field does: treating
  // null as present derived '0' + '0' and wrote a phantom zero-cost rollup row that also moved the
  // asset's last-closure pointer to a completion carrying no cost data at all.
  const declaredTotalCost = p['total_cost'];
  const declaredCapitalizationFlagged = p['capitalization_flagged'];
  const hasCostFields =
    (p['labor_cost'] !== undefined && p['labor_cost'] !== null) ||
    (p['parts_cost'] !== undefined && p['parts_cost'] !== null);
  if (!hasCostFields) {
    // total_cost and capitalization_flagged are DERIVED fields. With no labor_cost and no
    // parts_cost there is nothing to derive them from, so a declared value cannot be checked - and
    // an unchecked declared field is the silent corruption channel the direct POST /api/v1/events
    // path exists to exploit. Reject rather than persist a fabricated capitalization decision.
    if (declaredTotalCost !== undefined && declaredTotalCost !== null) {
      reject(
        'COST_DERIVATION_MISMATCH',
        'total_cost is derived and cannot be declared without labor_cost or parts_cost',
        { work_order_id: workOrderId, declared_total_cost: declaredTotalCost },
        409,
      );
    }
    if (declaredCapitalizationFlagged !== undefined && declaredCapitalizationFlagged !== null) {
      reject(
        'COST_DERIVATION_MISMATCH',
        'capitalization_flagged is derived and cannot be declared without labor_cost or parts_cost',
        {
          work_order_id: workOrderId,
          declared_capitalization_flagged: declaredCapitalizationFlagged,
        },
        409,
      );
    }
  }
  if (hasCostFields) {
    const laborCost = (p['labor_cost'] as string | null | undefined) ?? '0';
    const partsCost = (p['parts_cost'] as string | null | undefined) ?? '0';
    // A declared total_cost reaches the comparison as a query parameter, so it must be a NUMERIC
    // string before it gets there; anything else would surface as an unmapped 22P02 500.
    if (declaredTotalCost !== undefined && declaredTotalCost !== null) {
      if (typeof declaredTotalCost !== 'string' || !COST_NUMERIC_REGEX.test(declaredTotalCost)) {
        reject('INVALID_COST', 'total_cost must be a NUMERIC string with at most 3 decimals', {
          total_cost: declaredTotalCost,
        });
      }
    }
    const threshold = config.maintenance.capitalizationThreshold;
    // The declared/derived comparison runs in SQL NUMERIC, not as a JS string compare: PostgreSQL
    // renders ('10.5'::numeric + '0'::numeric)::text as '10.5', so a client echoing back the
    // projection's own '10.500' was rejected for a numerically identical value.
    const derived = await client.query(
      `SELECT ($1::numeric + $2::numeric)::text AS total_cost,
              (($1::numeric + $2::numeric) > $3::numeric) AS capitalization_flagged,
              ($4::numeric IS NULL OR ($1::numeric + $2::numeric) = $4::numeric) AS total_cost_matches`,
      [laborCost, partsCost, threshold, declaredTotalCost === undefined ? null : declaredTotalCost],
    );
    const totalCost = derived.rows[0]!['total_cost'] as string;
    const capitalizationFlagged = derived.rows[0]!['capitalization_flagged'] === true;

    if (derived.rows[0]!['total_cost_matches'] !== true) {
      reject(
        'COST_DERIVATION_MISMATCH',
        'Declared total_cost does not match labor_cost + parts_cost',
        {
          work_order_id: workOrderId,
          declared_total_cost: declaredTotalCost,
          derived_total_cost: totalCost,
        },
        409,
      );
    }
    if (
      declaredCapitalizationFlagged !== undefined &&
      declaredCapitalizationFlagged !== null &&
      declaredCapitalizationFlagged !== capitalizationFlagged
    ) {
      reject(
        'COST_DERIVATION_MISMATCH',
        'Declared capitalization_flagged does not match the threshold comparison',
        {
          work_order_id: workOrderId,
          declared_capitalization_flagged: declaredCapitalizationFlagged,
          derived_capitalization_flagged: capitalizationFlagged,
        },
        409,
      );
    }

    const written = await setWorkOrderCosts(
      workOrderId,
      laborCost,
      partsCost,
      totalCost,
      capitalizationFlagged,
      client,
    );
    if (!written) {
      reject('WORK_ORDER_NOT_FOUND', 'Work order not found', { work_order_id: workOrderId }, 404);
    }
    await upsertMaintenanceAssetCost(
      {
        asset_id: workOrder.asset_id,
        labor_cost: laborCost,
        parts_cost: partsCost,
        total_cost: totalCost,
        work_order_id: workOrderId,
        closed_at: envelope.metadata.occurred_at ?? new Date().toISOString(),
      },
      client,
    );

    p['total_cost'] = totalCost;
    p['capitalization_flagged'] = capitalizationFlagged;
  }

  // Binding Decision 6: a completed work order on a weighbridge asset invalidates the stamp. Only a
  // COMPLIANT stamp flips (an already-overdue stamp stays overdue; the scan's own grain guard owns
  // that path).
  if (weighbridgeExamination && weighbridgeExamination.status === 'compliant') {
    await setStatutoryExaminationStatus(weighbridgeExamination.examination_id, 'overdue', client);
  }
}

/**
 * Concurrency fallback for uq_maintenance_plan_name: returns the SAME detail shape as the seam's
 * pre-check (DUPLICATE_PLAN with existing_plan_id).
 */
export async function resolvePlanDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const assetId = typeof payload['asset_id'] === 'string' ? payload['asset_id'] : null;
  const planName =
    typeof payload['plan_name'] === 'string' && payload['plan_name'].trim() !== ''
      ? payload['plan_name'].trim()
      : null;
  const attempted: Record<string, unknown> = { asset_id: assetId, plan_name: planName };
  if (assetId !== null && planName !== null) {
    const existing = await getPlanByName(assetId, planName);
    if (existing) {
      return { asset_id: assetId, plan_name: planName, existing_plan_id: existing.plan_id };
    }
  }
  return attempted;
}

/**
 * Concurrency fallback for uq_maintenance_work_order_cycle: returns the SAME detail shape as the
 * seam's pre-check (DUPLICATE_WORK_ORDER with existing_work_order_id).
 */
export async function resolveWorkOrderDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const planId = typeof payload['plan_id'] === 'string' ? payload['plan_id'] : null;
  const cycleKey =
    typeof payload['generated_for_cycle'] === 'string' ? payload['generated_for_cycle'] : null;
  const attempted: Record<string, unknown> = { plan_id: planId, generated_for_cycle: cycleKey };
  if (planId !== null && cycleKey !== null) {
    const existing = await getWorkOrderByCycle(planId, cycleKey);
    if (existing) {
      return {
        plan_id: planId,
        generated_for_cycle: cycleKey,
        existing_work_order_id: existing.work_order_id,
      };
    }
  }
  return attempted;
}

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import {
  getJobworkReturnClockById,
  insertJobworkReturnClock,
  lockReturnClocksWithCapacity,
  updateReturnClockClassification,
  updateReturnClockCounters,
} from '../read/projections/jobwork_return_clock.js';
import type {
  ChallanClass,
  JobworkReturnClockRow,
  ReturnClockStatus,
} from '../read/projections/jobwork_return_clock.js';
import { qtyFromScaled, qtyToScaled } from './custody-statement.js';

/**
 * Story 9.5: the CGST Section 143 return-clock seam (FR-AC-11, FR-JW-14).
 *
 * Section 143(1): inputs sent to a job worker must be received back by the principal, or supplied
 * from the job worker's place of business, within ONE YEAR of being sent out; capital goods within
 * THREE YEARS. Otherwise the goods are deemed supplied by the principal on the day they were sent.
 * Its proviso exempts moulds and dies, jigs and fixtures, and tools from any return period at all -
 * a `tooling_exempt` class is deliberately NOT in the pilot because nothing on the Story 9.2
 * kit-BOM receipt path can receive an asset; the challan_class CHECK is where it slots in later.
 * Section 143(5): waste and scrap generated during the job work may be supplied by the job worker
 * (or the principal) on payment of tax - it is accounted material, never deemed supply, hence the
 * separate loss_qty counter (Binding decision 6).
 *
 * The clock stops when goods LEAVE the job worker: dispatch of processed output (9.4, apportioned
 * back into input-sku quantities), a return of unconsumed material (9.5 custody.return_recorded),
 * accounted loss (9.4, loss_qty). Story 9.6 offcut CAPTURE deliberately does NOT reconcile here
 * (revised 2026-09-05): the material is still the customer's until disposal and the clock must keep
 * running against it; Story 9.7 stops it at disposal. Consumption into WIP
 * stops NOTHING (the bracket is still on the floor). A count_adjustment is a verification
 * discrepancy, not a movement out, and never reaches this helper.
 *
 * LOCK ORDER (the 7.4 rule, extended): every caller already holds the order advisory lock and the
 * order row FOR UPDATE, and has written its ledger row; the clock rows are locked LAST, here.
 *
 * All arithmetic is exact scaled-integer on NUMERIC(18,3) strings (custody-statement.ts helpers),
 * never Number() (the repeated 9.2/9.3/9.4 finding).
 */

export const INPUT_CLOCK_DAYS = 365;
export const CAPITAL_GOODS_CLOCK_DAYS = 1095;
export const DEFAULT_CHALLAN_CLASS: ChallanClass = 'input';
export const CHALLAN_CLASSES: ReadonlySet<string> = new Set<ChallanClass>([
  'input',
  'capital_goods',
]);

export function isChallanClass(value: unknown): value is ChallanClass {
  return typeof value === 'string' && CHALLAN_CLASSES.has(value);
}

/** Calendar days on the clock for a challan class (365 inputs, 1095 capital goods). */
export function returnClockDays(challanClass: ChallanClass): number {
  return challanClass === 'capital_goods' ? CAPITAL_GOODS_CLOCK_DAYS : INPUT_CLOCK_DAYS;
}

/**
 * The expiry date the SQL insert will produce, computed in pure UTC calendar arithmetic so a unit
 * test can pin the 365/1095-day boundary without a database. The persisted value is computed by
 * PostgreSQL (`challan_date + make_interval(days => n)`); this function exists to assert equality
 * with it, and for callers that need the date before the row exists.
 */
export function returnClockExpiryDate(challanDate: string, challanClass: ChallanClass): string {
  const [y, m, d] = challanDate.split('-').map(Number) as [number, number, number];
  const expiry = new Date(Date.UTC(y, m - 1, d + returnClockDays(challanClass)));
  return expiry.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier); pure UTC arithmetic. */
export function calendarDaysUntil(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export type ClockSweepStage = 'breached' | 'alert_30' | 'alert_90';

/**
 * The single-pass, TIGHTEST-STAGE-WINS predicate behind the Task 2.2 sweep, parameterized so unit
 * tests exercise real boundaries rather than asserting the config against itself (the 8.4 lesson).
 *
 * Boundaries (disclosed per the 9.2/9.4 "strictly over vs at-boundary" convention):
 * - breached when today is STRICTLY after expiry_date (the goods may still come back ON the last day);
 * - the 30-day stage is due when today >= expiry_date - leadDays2 (at-boundary fires);
 * - the 90-day stage is due when today >= expiry_date - leadDays1 (at-boundary fires).
 * A clock already stamped at a tier is never re-swept at that tier; a clock first seen inside the
 * tighter window produces ONE alert (the tighter one) and the caller stamps BOTH.
 */
export function dueClockSweepStage(input: {
  today: string;
  expiryDate: string;
  status: ReturnClockStatus;
  alert90SentAt: string | null;
  alert30SentAt: string | null;
  leadDays1: number;
  leadDays2: number;
}): ClockSweepStage | null {
  if (input.status !== 'open' && input.status !== 'partially_reconciled') return null;
  const daysToExpiry = calendarDaysUntil(input.today, input.expiryDate);
  if (daysToExpiry < 0) return 'breached';
  // Story 9.5 code review (chunk 2): once the clock is inside the TIGHTER window, the looser stage
  // can never fire. Previously a row with alert_30_sent_at set and alert_90_sent_at null (a
  // partially-failed stamp, or a lead reconfigured downward) skipped the 30-day arm on its stamp
  // check and then SATISFIED the 90-day arm, sending a "90 days remaining" warning with twelve days
  // left. Tightest-stage-wins is now a property of the predicate, not an assumption about callers.
  if (daysToExpiry <= input.leadDays2) {
    return input.alert30SentAt === null ? 'alert_30' : null;
  }
  if (daysToExpiry <= input.leadDays1 && input.alert90SentAt === null) return 'alert_90';
  return null;
}

/** challan - reconciled - loss: loss is accounted waste under Section 143(5), never deemed supply. */
export function deemedSupplyQty(
  challanQty: string,
  reconciledQty: string,
  lossQty: string,
): string {
  const outstanding = qtyToScaled(challanQty) - qtyToScaled(reconciledQty) - qtyToScaled(lossQty);
  return qtyFromScaled(outstanding < 0n ? 0n : outstanding);
}

/** Status after a counter move; a breached clock stays breached (its deemed supply is recorded). */
export function returnClockStatusAfter(
  current: ReturnClockStatus,
  challanQty: string,
  reconciledQty: string,
  lossQty: string,
): ReturnClockStatus {
  if (current === 'breached') return 'breached';
  const accounted = qtyToScaled(reconciledQty) + qtyToScaled(lossQty);
  if (accounted >= qtyToScaled(challanQty)) return 'reconciled';
  return accounted > 0n ? 'partially_reconciled' : 'open';
}

export interface FifoAllocation {
  clock_id: string;
  quantity: bigint;
}

/**
 * FIFO allocation of a scaled quantity across clocks presented in challan_date order, each with its
 * remaining capacity (scaled). Pure, so the "older challan fills first" property is unit-testable.
 */
export function allocateFifo(
  clocks: { clock_id: string; capacity: bigint }[],
  quantity: bigint,
): { allocations: FifoAllocation[]; unallocated: bigint } {
  const allocations: FifoAllocation[] = [];
  let remaining = quantity;
  for (const clock of clocks) {
    if (remaining <= 0n) break;
    if (clock.capacity <= 0n) continue;
    const take = clock.capacity < remaining ? clock.capacity : remaining;
    allocations.push({ clock_id: clock.clock_id, quantity: take });
    remaining -= take;
  }
  return { allocations, unallocated: remaining };
}

export type ReconcileCounter = 'reconciled_qty' | 'loss_qty';
/** The only ledger categories that stop the clock. `offcut` is forward-declared for Story 9.6. */
export type ReconcileCategory = 'dispatch' | 'return' | 'loss' | 'offcut';

export interface ReconcileReturnClocksInput {
  serviceOrderId: string;
  sku: string;
  /** Positive NUMERIC(18,3) string in the challan's unit. */
  quantity: string;
  counter: ReconcileCounter;
  category: ReconcileCategory;
  /**
   * strict: refuse INVALID_PARAMS when the quantity exceeds the outstanding clock capacity for the
   * sku (a RETURN of more than was ever challaned is a data-entry error, fail closed). Non-strict
   * (dispatch, loss): reconcile up to capacity and report the remainder - those quantities are
   * derived from the RECEIVED balance, which may legitimately exceed the challan (an over-tolerance
   * receipt), and a clock-accounting mismatch must never block the physical movement or strand the
   * closure gate. Never over-reconciles in either mode.
   */
  strict: boolean;
}

export interface ReconcileReturnClocksResult {
  /** Quantity actually applied to clock counters. */
  allocated: string;
  /** Quantity with no clock capacity left to absorb it (always "0.000" in strict mode). */
  unallocated: string;
  clocks_touched: string[];
}

function capacityOf(row: JobworkReturnClockRow): bigint {
  return qtyToScaled(row.challan_qty) - qtyToScaled(row.reconciled_qty) - qtyToScaled(row.loss_qty);
}

/**
 * Story 9.5 Task 1.3: moves `quantity` onto the FIFO-oldest clocks for (order, sku) under the
 * counter the category dictates. Called INSIDE the posting applier's transaction (an additive call,
 * never a new transaction) from exactly four categories: dispatch (9.4), return (9.5), loss (9.4,
 * loss_qty) and the forward-declared 9.6 offcut (reconciled_qty for both retain-and-buy and
 * retain-free). Consumption and count_adjustment must never call it.
 */
export async function reconcileReturnClocks(
  input: ReconcileReturnClocksInput,
  client: PoolClient,
): Promise<ReconcileReturnClocksResult> {
  // Story 9.5 code review (chunk 2): AppError, not a bare Error. A bare Error escaping an applier
  // is an unclassified 500 the error middleware cannot describe; every other refusal in this file
  // carries a code. This is a programming error rather than a caller error, hence 500, but a
  // classified one.
  if (input.category === 'loss' && input.counter !== 'loss_qty') {
    throw new AppError(500, 'INTERNAL_ERROR', 'reconcileReturnClocks: loss must move loss_qty', {
      category: input.category,
      counter: input.counter,
    });
  }
  if (input.category !== 'loss' && input.counter !== 'reconciled_qty') {
    throw new AppError(
      500,
      'INTERNAL_ERROR',
      `reconcileReturnClocks: ${input.category} must move reconciled_qty`,
      { category: input.category, counter: input.counter },
    );
  }
  const requested = qtyToScaled(input.quantity);
  if (requested <= 0n) {
    return { allocated: '0.000', unallocated: '0.000', clocks_touched: [] };
  }

  const rows = await lockReturnClocksWithCapacity(input.serviceOrderId, input.sku, client);
  const { allocations, unallocated } = allocateFifo(
    rows.map((row) => ({ clock_id: row.clock_id, capacity: capacityOf(row) })),
    requested,
  );
  if (input.strict && unallocated > 0n) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'The quantity exceeds the outstanding return-clock capacity for this sku on this order',
      {
        service_order_id: input.serviceOrderId,
        sku: input.sku,
        category: input.category,
        requested_qty: input.quantity,
        clock_capacity_qty: qtyFromScaled(requested - unallocated),
        shortfall_qty: qtyFromScaled(unallocated),
      },
    );
  }

  const byId = new Map(rows.map((row) => [row.clock_id, row]));
  for (const allocation of allocations) {
    const row = byId.get(allocation.clock_id)!;
    const reconciled =
      input.counter === 'reconciled_qty'
        ? qtyFromScaled(qtyToScaled(row.reconciled_qty) + allocation.quantity)
        : row.reconciled_qty;
    const loss =
      input.counter === 'loss_qty'
        ? qtyFromScaled(qtyToScaled(row.loss_qty) + allocation.quantity)
        : row.loss_qty;
    await updateReturnClockCounters(
      row.clock_id,
      {
        reconciled_qty: reconciled,
        loss_qty: loss,
        status: returnClockStatusAfter(row.status, row.challan_qty, reconciled, loss),
      },
      client,
    );
  }

  return {
    allocated: qtyFromScaled(requested - unallocated),
    unallocated: qtyFromScaled(unallocated),
    clocks_touched: allocations.map((a) => a.clock_id),
  };
}

/**
 * Story 9.5 code review (chunk 1): the roles that may correct a challan classification. This is a
 * COMPLIANCE correction to a statutory clock, not an operator edit of a receipt - the receipt itself
 * stays immutable (9.2) and only the derived clock moves. `jobwork_coordinator` is deliberately not
 * here: the coordinator is the party the breach alerts are addressed to, and letting the alerted
 * party push its own deadline out three years is the segregation-of-duties hole the 8.4 review
 * closed elsewhere.
 */
export const CHALLAN_RECLASSIFICATION_ROLES: ReadonlySet<string> = new Set([
  'compliance_officer',
  'site_head',
]);

export interface CorrectChallanClassificationInput {
  clockId: string;
  challanClass: ChallanClass;
  /** Sites the caller may write to; null is the wildcard read/write scope. */
  permittedSiteIds: string[] | null;
  /** The IST calendar date the route resolved, so the retro-expiry guard agrees with the sweep. */
  today: string;
}

/**
 * Moves a return clock onto the challan class it should have carried, recomputing `expiry_date` from
 * the STORED `challan_date` in SQL. `challan_class` is optional on the 9.2 receipt payload and
 * defaults to 'input' (Binding decision 7, fail toward the shorter clock), the receipt is immutable,
 * and nothing else can move the clock - so without this a capital good received without the field
 * breaches at day 365 instead of day 1095 and freezes a deemed supply into ITC-04 two years early.
 *
 * Refuses once `deemed_supply_recorded_at` is set: at that point the row has already been reported
 * as a deemed supply and reclassifying it would rewrite a filed tax position rather than correct a
 * data-entry slip. That refusal is INVALID_STATE_TRANSITION (the Story 9.1 code), not a new one.
 * Re-applying the class the clock already carries is a no-op that returns the row unchanged, so a
 * retried request is safe.
 */
export async function correctChallanClassification(
  input: CorrectChallanClassificationInput,
  client?: PoolClient,
): Promise<JobworkReturnClockRow> {
  const clock = await getJobworkReturnClockById(input.clockId, client);
  if (!clock) {
    throw new AppError(404, 'NOT_FOUND', `Return clock "${input.clockId}" not found`);
  }
  if (input.permittedSiteIds !== null && !input.permittedSiteIds.includes(clock.site_id)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No write assignment grants access to site "${clock.site_id}"`,
    );
  }
  if (clock.challan_class === input.challanClass) return clock;
  if (clock.deemed_supply_recorded_at !== null) {
    throw new AppError(
      409,
      'INVALID_STATE_TRANSITION',
      'This challan has already been recorded as a deemed supply and can no longer be reclassified',
      {
        clock_id: clock.clock_id,
        challan_class: clock.challan_class,
        deemed_supply_qty: clock.deemed_supply_qty,
        deemed_supply_recorded_at: clock.deemed_supply_recorded_at,
      },
    );
  }
  // Story 9.5 code review (chunk 2): refuse a correction that lands the expiry in the past. Moving
  // capital_goods back to input on a challan older than a year recomputes expiry to a date already
  // gone, and the next sweep tick freezes a deemed supply with no warning at correction time. A
  // reclassification is a data-entry correction; declaring a breach is the sweep's job.
  const newExpiry = returnClockExpiryDate(clock.challan_date, input.challanClass);
  if (calendarDaysUntil(input.today, newExpiry) < 0) {
    throw new AppError(
      409,
      'INVALID_STATE_TRANSITION',
      'Reclassifying this challan would set an expiry date that has already passed; the clock would breach immediately',
      {
        clock_id: clock.clock_id,
        challan_date: clock.challan_date,
        current_expiry_date: clock.expiry_date,
        would_expire_on: newExpiry,
      },
    );
  }
  const moved = await updateReturnClockClassification(
    input.clockId,
    input.challanClass,
    returnClockDays(input.challanClass),
    client,
  );
  if (!moved) {
    // The guard in the UPDATE lost a race with the sweep's breach flip between the read above and
    // the write; the deemed supply now exists, so the same refusal applies.
    throw new AppError(
      409,
      'INVALID_STATE_TRANSITION',
      'This challan has already been recorded as a deemed supply and can no longer be reclassified',
      { clock_id: clock.clock_id, challan_class: clock.challan_class },
    );
  }
  const updated = await getJobworkReturnClockById(input.clockId, client);
  return updated ?? clock;
}

/**
 * Story 9.5 Task 1.2: the clock row for one receipt, inserted by the 9.2 receipt applier in the
 * SAME transaction as the receipt row (Binding decision 1). A 23505 on uq_jobwork_return_clock_receipt
 * is classified by the caller like its other receipt duplicates.
 */
export async function openReturnClockForReceipt(
  input: {
    receipt_id: string;
    service_order_id: string;
    sku: string;
    challan_qty: string;
    challan_class: ChallanClass;
    challan_date: string;
    site_id: string;
  },
  client: PoolClient,
): Promise<string> {
  const clockId = randomUUID();
  await insertJobworkReturnClock(
    {
      clock_id: clockId,
      receipt_id: input.receipt_id,
      service_order_id: input.service_order_id,
      sku: input.sku,
      challan_qty: input.challan_qty,
      challan_class: input.challan_class,
      challan_date: input.challan_date,
      clock_days: returnClockDays(input.challan_class),
      site_id: input.site_id,
    },
    client,
  );
  return clockId;
}

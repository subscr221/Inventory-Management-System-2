/**
 * Job-work ERP billing feed contract (Story 9.6, AC4 / FR-JW-12).
 *
 * This module defines the ERP adapter boundary for the measured job-work billing feed consumed by
 * the ERP-side invoicing run (AD-11: the ERP GL is the book of record; this platform is the
 * subledger and raises the billing TRIGGER, never the tax invoice). The adapter owns the payload
 * SHAPE and the pure money / measured-basis arithmetic only; the feed row, its lifecycle
 * (pending / acknowledged / exception) and the retry-window sweep live in
 * src/compliance/jobwork-billing.ts and src/notify/jobwork-billing-sweep.ts. Live transmission to
 * the ERP system is per-deployment configuration and is NOT implemented here (identical philosophy
 * to po-outbound.ts and msme-ageing-feed.ts); acknowledgment arrives as an INBOUND command on this
 * platform's own API (Binding decision 8).
 *
 * Money arithmetic is scaled-integer BigInt at FOUR decimals (the NUMERIC(18,4) rate columns);
 * quantities stay at the three-decimal custody-statement scale. Never `Number()` on a NUMERIC
 * string - the repeated 9.2 / 9.3 / 9.4 finding.
 */

import { AppError } from '../../middleware/error.js';
import { qtyToScaled } from '../../compliance/custody-statement.js';
import type { CustodyLedgerEntryRow } from '../../read/projections/custody_ledger_entry.js';
import type { JobworkMaterialReceiptRow } from '../../read/projections/jobwork_material_receipt.js';
import type { ServiceOrderRow } from '../../read/projections/service_order.js';
import type { JobWorkMeasuredBasis } from '../../read/projections/job_work_billing_feed.js';

// ---------------------------------------------------------------------------
// Money (four-decimal scaled integers)
// ---------------------------------------------------------------------------

export const MONEY_SCALE = 4;
const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE);
const QTY_SCALE = 3;

/** Parses a NUMERIC string (optional sign, up to 4 decimals) into a scaled BigInt. */
export function moneyToScaled(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Not a NUMERIC money string: "${value}"`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = unsigned.split('.');
  if (frac.length > MONEY_SCALE) {
    throw new TypeError(`Money string carries more than ${MONEY_SCALE} decimals: "${value}"`);
  }
  const padded = (frac + '0'.repeat(MONEY_SCALE)).slice(0, MONEY_SCALE);
  const scaled = BigInt(whole || '0') * MONEY_FACTOR + BigInt(padded);
  return negative ? -scaled : scaled;
}

/** Formats a scaled BigInt back to a canonical NUMERIC(18,4) string ("12.5000"). */
export function moneyFromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / MONEY_FACTOR;
  const frac = (abs % MONEY_FACTOR).toString().padStart(MONEY_SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

export function moneyAdd(a: string, b: string): string {
  return moneyFromScaled(moneyToScaled(a) + moneyToScaled(b));
}

/**
 * quantity (3 decimals) x rate (4 decimals) = an exact 7-decimal product, rounded HALF UP to the
 * 4-decimal money scale. Exported and parameterised so a unit test can pin the rounding boundary.
 */
export function billableValueOf(quantity: string, rate: string): string {
  const product = qtyToScaled(quantity) * moneyToScaled(rate); // scale 3 + 4 = 7
  const divisor = 10n ** BigInt(QTY_SCALE); // back to scale 4
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + divisor / 2n) / divisor;
  return moneyFromScaled(negative ? -rounded : rounded);
}

// ---------------------------------------------------------------------------
// Measured basis (Binding decision 12)
// ---------------------------------------------------------------------------

export interface MeasuredBasisInput {
  basisType: JobWorkMeasuredBasis;
  /** SUM(job_work_dispatch.dispatched_quantity) for the order, NUMERIC(18,3) text. */
  dispatchedTotal: string;
  /** Caller-supplied for per_hour only (no machine-time source exists in the pilot). */
  measuredHours?: string | undefined;
}

/**
 * per_piece and per_kg bill the dispatched total; lumpsum bills exactly one unit; per_hour has no
 * system source in the pilot and is refused INVALID_PARAMS without caller-supplied measured_hours.
 * Pure, so the unit test can walk every arm.
 */
export function resolveMeasuredBasis(input: MeasuredBasisInput): {
  measured_basis: JobWorkMeasuredBasis;
  measured_quantity: string;
} {
  switch (input.basisType) {
    case 'per_piece':
    case 'per_kg':
      return { measured_basis: input.basisType, measured_quantity: input.dispatchedTotal };
    case 'lumpsum':
      return { measured_basis: 'lumpsum', measured_quantity: '1.000' };
    case 'per_hour': {
      const hours = input.measuredHours;
      if (
        typeof hours !== 'string' ||
        !/^\d{1,15}(\.\d{1,3})?$/.test(hours) ||
        !/[1-9]/.test(hours)
      ) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          'A per_hour price basis requires caller-supplied measured_hours (a strictly positive NUMERIC string with at most 3 decimals); no machine-time source exists in the pilot',
          { field: 'measured_hours', basis_type: 'per_hour', value: hours ?? null },
        );
      }
      return { measured_basis: 'per_hour', measured_quantity: hours };
    }
    // The DDL deliberately leaves basis_type OPEN ("enforced in the seam, not a CHECK, because
    // FR-JW-01 does not close the vocabulary"), so an unrecognised value is reachable and must be a
    // classified refusal rather than an undefined that dies on NOT NULL as a 500 (fixed 2026-09-06).
    default:
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `Unsupported price basis "${String(input.basisType)}": this order cannot be billed`,
        { basis_type: input.basisType },
      );
  }
}

// ---------------------------------------------------------------------------
// Retry window (AC 5)
// ---------------------------------------------------------------------------

/**
 * True when a `pending` feed has sat STRICTLY longer than the retry window without acknowledgment
 * (exactly-at-window does NOT flip, the 9.2 / 9.4 boundary convention). Parameterised so the unit
 * test fails it rather than asserting config against itself (the 8.4 lesson).
 */
export function billingFeedRetryWindowElapsed(input: {
  firstSentAt: string;
  now: string;
  retryWindowMs: number;
}): boolean {
  const age = new Date(input.now).getTime() - new Date(input.firstSentAt).getTime();
  return age > input.retryWindowMs;
}

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

export interface JobWorkBillingChallanReference {
  receipt_id: string;
  challan_number_ext: string;
  challan_date: string;
  challan_class: 'input' | 'capital_goods';
  sku: string;
  challan_qty: string;
  uom: string;
}

export interface JobWorkBillingDispatchLine {
  dispatch_id: string;
  lot_number: string;
  sku: string;
  dispatched_quantity: string;
  uom: string;
  dispatched_at: string;
}

/** FR-JW-07: the processor's own material added to the customer's job, billable. */
export interface JobWorkBillingOwnMaterialLine {
  entry_id: string;
  sku: string;
  lot_id: string | null;
  quantity: string;
  uom: string;
  business_date: string;
}

export interface JobWorkBillingFeedPayload {
  feed_type: 'job_work_billing';
  feed_id: string;
  service_order_id: string;
  order_number_ext: string;
  customer_party_code: string;
  customer_name: string;
  site_id: string;
  challan_references: JobWorkBillingChallanReference[];
  price_basis: ServiceOrderRow['price_basis'];
  measured_basis: JobWorkMeasuredBasis;
  measured_quantity: string;
  /** measured_quantity x price_basis.rate, at the money scale. */
  service_value: string;
  dispatch_lines: JobWorkBillingDispatchLine[];
  own_material_lines: JobWorkBillingOwnMaterialLine[];
  // Story 9.6 revised 2026-09-05: no retain-and-buy lines. Offcut is captured unvalued and disposed
  // of later (Story 9.7); its buyback reaches ERP as a CREDIT NOTE against this invoice, never as a
  // line on the feed that raised it.
  total_value: string;
  currency: string;
  /** Binding decision 18: summed (quantity - dispatched_quantity) over the order's outputs. */
  open_to_dispatch_qty: string;
  idempotency_key: string;
  generated_at: string;
  correlation_id: string | null;
}

export interface BuildBillingFeedInput {
  feedId: string;
  order: ServiceOrderRow;
  receipts: JobworkMaterialReceiptRow[];
  dispatches: JobWorkBillingDispatchLine[];
  ownMaterialRows: CustodyLedgerEntryRow[];
  measured: { measured_basis: JobWorkMeasuredBasis; measured_quantity: string };
  openToDispatchQty: string;
  idempotencyKey: string;
  generatedAt: string;
  correlationId: string | null;
}

/**
 * The price-basis rate is stored as a JSON number by Story 9.1; it is re-serialised here through
 * the exact-decimal path so the service value never floats. A rate with more than four decimals
 * is refused rather than truncated.
 */
export function priceBasisRateAsMoney(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AppError(400, 'INVALID_PARAMS', 'price_basis.rate must be a finite positive number');
  }
  const text = rate.toString();
  if (/e/i.test(text)) {
    throw new AppError(400, 'INVALID_PARAMS', 'price_basis.rate is outside the exact money range', {
      rate,
    });
  }
  // The docstring above promised a refusal rather than truncation, but delegating straight to
  // moneyToScaled threw a bare TypeError, which the error middleware turns into a 500 (fixed
  // 2026-09-06). The refusal is now the classified 400 it always claimed to be.
  try {
    return moneyFromScaled(moneyToScaled(text));
  } catch {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `price_basis.rate carries more than ${MONEY_SCALE} decimals and cannot be billed exactly`,
      { rate },
    );
  }
}

export function buildJobWorkBillingFeedPayload(
  input: BuildBillingFeedInput,
): JobWorkBillingFeedPayload {
  const { order } = input;
  if (!order.price_basis) {
    throw new AppError(409, 'BILLING_NOT_READY', 'The order carries no price basis to bill from', {
      service_order_id: order.service_order_id,
      reason: 'price_basis_missing',
    });
  }
  const currency = order.price_basis.currency;
  const serviceValue = billableValueOf(
    input.measured.measured_quantity,
    priceBasisRateAsMoney(order.price_basis.rate),
  );
  return {
    feed_type: 'job_work_billing',
    feed_id: input.feedId,
    service_order_id: order.service_order_id,
    order_number_ext: order.order_number_ext,
    customer_party_code: order.customer_party_code,
    customer_name: order.customer_name,
    site_id: order.site_id,
    challan_references: input.receipts.map((r) => ({
      receipt_id: r.receipt_id,
      challan_number_ext: r.challan_number_ext,
      challan_date: r.challan_date,
      challan_class: r.challan_class,
      sku: r.sku,
      challan_qty: r.challan_qty,
      uom: r.uom,
    })),
    price_basis: order.price_basis,
    measured_basis: input.measured.measured_basis,
    measured_quantity: input.measured.measured_quantity,
    service_value: serviceValue,
    dispatch_lines: input.dispatches,
    own_material_lines: input.ownMaterialRows.map((r) => ({
      entry_id: r.entry_id,
      sku: r.sku,
      lot_id: r.lot_id,
      quantity: r.quantity_delta,
      uom: r.uom,
      business_date: r.business_date,
    })),
    total_value: serviceValue,
    currency,
    open_to_dispatch_qty: input.openToDispatchQty,
    idempotency_key: input.idempotencyKey,
    generated_at: input.generatedAt,
    correlation_id: input.correlationId,
  };
}

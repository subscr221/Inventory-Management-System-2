import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { applyStockReceipt } from '../read/projections/stock_balance.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';

/**
 * Story 8.3 (FR-Q-05, AC 2 and AC 4): the QC-owned stock relabel used by the partial split and by
 * the NCR downgrade outcome. It moves owned on-hand quantity from one lot NUMBER to another,
 * grain by grain, inside the caller's transaction.
 *
 * Why this is not an Epic 2 ledger call: applyStockIssue and applyStockAllocation splice
 * qcGateExclusionSql into their drain windows, so QC-gated stock is invisible to them by design.
 * A split is the one move that legitimately operates ON gated stock, so the debit side is written
 * here directly. The credit side is the ordinary applyStockReceipt upsert.
 *
 * Fail-closed invariants (Annex requirements 5 and 6):
 * - Every parent grain is locked FOR UPDATE in balance_id order before anything is read or written,
 *   so two concurrent splits of one lot serialize.
 * - A parent grain with a non-zero `allocated` rejects: a QC-gated lot should never be allocated,
 *   so this is a corrupted-state guard, not a workflow branch.
 * - The available total is compared as an exact scaled integer, never a float.
 *
 * lot_trace carries a UNIQUE index on event_id (idx_lot_trace_event_id), so exactly ONE trace row
 * can exist per event. The relabel therefore writes the parent-side negative entry only, and the
 * child-side provenance lives in qc_lot_split (split) or qc_ncr.downgrade_lot_id (downgrade)
 * together with the domain event itself.
 */

/** NUMERIC(18,6): every quantity is handled as an integer count of micro-units. */
const SCALE = 6;
const DECIMAL_REGEX = /^-?(0|[1-9]\d{0,11})(\.\d{1,6})?$/;

/** Exact decimal-string to scaled BigInt. Never Number, parseFloat or toFixed. */
export function toScaledQuantity(value: string): bigint {
  if (!DECIMAL_REGEX.test(value)) {
    throw new AppError(500, 'QC_QUANTITY_UNPARSEABLE', 'Quantity is not a NUMERIC(18,6) decimal', {
      value,
    });
  }
  const negative = value.startsWith('-');
  const magnitude = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = magnitude.split('.');
  const padded = (fraction + '0'.repeat(SCALE)).slice(0, SCALE);
  const scaled = BigInt(whole!) * 10n ** BigInt(SCALE) + BigInt(padded === '' ? '0' : padded);
  return negative ? -scaled : scaled;
}

/** Scaled BigInt back to the canonical NUMERIC(18,6) decimal string. */
export function fromScaledQuantity(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(SCALE);
  const whole = magnitude / divisor;
  const fraction = (magnitude % divisor).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export interface RelabelLotQuantityInput {
  parent_lot_id: string;
  parent_lot_number: string;
  /** The SKU the parent's stock rows are keyed by. */
  sku: string;
  target_lot_id: string;
  target_lot_number: string;
  /** The SKU the relabelled quantity lands under (differs from `sku` only for a downgrade). */
  target_sku: string;
  quantity: string;
}

export interface ParentGrain {
  balance_id: string;
  location_id: string;
  location_code: string | null;
  on_hand: string;
  allocated: string;
}

/**
 * Locks and returns the parent lot's owned grains in a deterministic order. Exposed so a caller
 * that relabels a lot in several steps (the split's N children) locks and validates ONCE, before
 * any write, and can report INSUFFICIENT_STOCK with no partial effect.
 */
export async function lockOwnedLotGrains(
  sku: string,
  lotNumber: string,
  client: PoolClient,
): Promise<ParentGrain[]> {
  const result = await client.query(
    `SELECT balance_id, location_id, location_code, on_hand::text AS on_hand,
            allocated::text AS allocated
       FROM stock_balance
      WHERE sku = $1 AND lot_id = $2 AND stock_class = 'owned'
      ORDER BY balance_id
        FOR UPDATE`,
    [sku, lotNumber],
  );
  return result.rows.map((row) => ({
    balance_id: (row as Record<string, unknown>)['balance_id'] as string,
    location_id: (row as Record<string, unknown>)['location_id'] as string,
    location_code: ((row as Record<string, unknown>)['location_code'] as string | null) ?? null,
    on_hand: String((row as Record<string, unknown>)['on_hand']),
    allocated: String((row as Record<string, unknown>)['allocated']),
  }));
}

/**
 * The unallocated owned on-hand of a lot as a scaled integer, rejecting a lot that carries any
 * allocation. `grains` must already be locked by lockOwnedLotGrains.
 */
export function availableScaled(
  grains: ParentGrain[],
  context: Record<string, unknown>,
): bigint {
  let total = 0n;
  for (const grain of grains) {
    if (toScaledQuantity(grain.allocated) !== 0n) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        'The lot carries allocated stock and cannot be relabelled',
        { ...context, balance_id: grain.balance_id, allocated: grain.allocated },
      );
    }
    total += toScaledQuantity(grain.on_hand);
  }
  return total;
}

/**
 * Moves `quantity` from the parent lot number onto the target lot number, draining the locked
 * grains in order and receiving the same quantity at the same location. Mutates the passed
 * `grains` so a caller relabelling several children in sequence sees the remaining balances.
 */
export async function relabelLotQuantity(
  input: RelabelLotQuantityInput,
  grains: ParentGrain[],
  client: PoolClient,
): Promise<void> {
  let remaining = toScaledQuantity(input.quantity);
  if (remaining <= 0n) {
    throw new AppError(500, 'QC_SPLIT_INVALID', 'Relabel quantity must be positive', {
      quantity: input.quantity,
    });
  }
  for (const grain of grains) {
    if (remaining === 0n) break;
    const available = toScaledQuantity(grain.on_hand);
    if (available === 0n) continue;
    const take = available < remaining ? available : remaining;
    const takeText = fromScaledQuantity(take);
    await client.query(
      `UPDATE stock_balance SET on_hand = on_hand - $2::numeric, updated_at = now()
        WHERE balance_id = $1`,
      [grain.balance_id, takeText],
    );
    await applyStockReceipt(
      {
        sku: input.target_sku,
        location_id: grain.location_id,
        location_code: grain.location_code,
        lot_id: input.target_lot_number,
        stock_class: 'owned',
        quantity: takeText,
      },
      client,
    );
    grain.on_hand = fromScaledQuantity(available - take);
    remaining -= take;
  }
  if (remaining !== 0n) {
    // lockOwnedLotGrains + availableScaled are checked before the first write, so reaching this is
    // a coding error, not a user-facing state.
    throw new AppError(
      500,
      'QC_SPLIT_INVALID',
      'The relabel drained fewer units than requested after the availability check',
      { parent_lot_number: input.parent_lot_number, shortfall: fromScaledQuantity(remaining) },
    );
  }
}

/**
 * The business stream a lot's existing trace was written under. lot_trace.business_stream is NOT
 * NULL and the QC events that relabel a lot carry no business stream of their own (they are
 * decisions on an already-tagged task), so the parent's own trace is the only non-fabricated
 * source. Returns null when the lot has no trace history, in which case the caller skips the trace
 * entry rather than inventing a stream.
 */
export async function resolveLotBusinessStream(
  lotId: string,
  client: PoolClient,
): Promise<string | null> {
  const result = await client.query(
    `SELECT business_stream FROM lot_trace WHERE lot_id = $1 ORDER BY timestamp DESC, trace_id LIMIT 1`,
    [lotId],
  );
  return result.rows.length > 0
    ? ((result.rows[0] as Record<string, unknown>)['business_stream'] as string)
    : null;
}

/**
 * Writes the ONE parent-side trace entry a relabelling event may hold (lot_trace carries a UNIQUE
 * index on event_id). `quantity` is the total moved off the parent by this event. Silently skips
 * when the lot has no resolvable business stream.
 */
export async function appendRelabelTrace(
  input: {
    lot_id: string;
    sku: string;
    event_id: string;
    event_type: string;
    quantity: string;
    occurred_at: string;
    location_id: string | null;
    location_code: string | null;
  },
  client: PoolClient,
): Promise<void> {
  const businessStream = await resolveLotBusinessStream(input.lot_id, client);
  if (businessStream === null) return;
  await appendTraceEntry(
    {
      lot_id: input.lot_id,
      event_id: input.event_id,
      event_type: input.event_type,
      sku: input.sku,
      location_id: input.location_id,
      location_code: input.location_code,
      quantity_change: `-${input.quantity}`,
      business_stream: businessStream,
      timestamp: input.occurred_at,
    },
    client,
  );
}

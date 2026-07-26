import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { persistEvent } from '../events/store.js';
import { getSalesOrderLineById, type ErpSalesOrderRow } from '../read/projections/erp_sales_order.js';
import { getVelocityClass } from '../read/projections/velocity_class.js';
import type { PickLineInput } from '../events/schema.js';

/**
 * Story 3.6 Task 4: pick task generation. Loads Story 2.9 sales-order lines as Phase-1 outbound
 * demand, selects lots by FEFO (stock_balance joined to lot_master, expiry ASC NULLS LAST,
 * lot_number ASC tiebreaker), resolves each lot's bin (preferring the Story 3.5 velocity-class
 * preferred bin when a lot sits in several bins), sequences bins per zone by
 * location_register.pick_sequence (location_code lexicographic fallback), and emits one
 * pick_task.created event per generated task through persistEvent - so the projection insert and
 * the stock allocation (Task 5.3 apply) commit atomically with the domain event.
 */

export interface GeneratePickTasksInput {
  dispatchOrderLineIds: string[];
  strategy: 'single' | 'batch' | 'wave' | 'zone';
  waveId?: string | undefined;
  batchId?: string | undefined;
  siteId: string;
  createdBy: string;
  actor: { user_id: string; role: string; location_id: string };
}

export interface GeneratePickTasksResult {
  pickTaskIds: string[];
  pickLineIds: string[];
}

interface LotAllocation {
  lotUuid: string;
  lotNumber: string;
  locationId: string;
  zoneId: string;
  quantity: string;
  binSequence: number | null;
  locationCode: string;
}

interface AllocatedLine {
  line: ErpSalesOrderRow;
  allocations: LotAllocation[];
}

interface FefoCandidateRow {
  lot_uuid: string;
  lot_number: string;
  location_id: string;
  location_code: string;
  zone_id: string | null;
  available: string;
  bin_pick_sequence: number | null;
}

/** Project quantities as integer micro-units (NUMERIC(18,6) -> 6 decimal places) to avoid JS float rounding. */
const QUANTITY_SCALE = 6;
const QUANTITY_FACTOR = 1_000_000n;

function numericToMicro(value: string | number): bigint {
  const s = typeof value === 'number' ? value.toString() : value;
  const clean = s.trim();
  const [intPart = '0', fracPart = ''] = clean.split('.');
  const frac = (fracPart + '0'.repeat(QUANTITY_SCALE)).slice(0, QUANTITY_SCALE);
  const sign = clean.startsWith('-') ? -1n : 1n;
  return sign * (BigInt(intPart.replace('-', '')) * QUANTITY_FACTOR + BigInt(frac));
}

function microToNumeric(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = (abs / QUANTITY_FACTOR).toString();
  const frac = (abs % QUANTITY_FACTOR).toString().padStart(QUANTITY_SCALE, '0');
  const num = `${whole}.${frac}`;
  return negative ? `-${num}` : num;
}

function isNonNegativeMicro(value: string | number): boolean {
  try {
    return numericToMicro(value) >= 0n;
  } catch {
    return false;
  }
}

/**
 * FEFO candidates for a SKU at a site: owned stock with availability, joined to lot_master for
 * expiry ordering and to location_register for the bin's pick_sequence and zone ancestor. The
 * zone ancestor walks the bin -> rack -> aisle -> zone parent chain.
 */
async function fefoCandidates(sku: string, siteId: string, client: PoolClient): Promise<FefoCandidateRow[]> {
  const result = await client.query(
    `WITH RECURSIVE zone_of AS (
       SELECT lr.location_id AS start_id, lr.location_id, lr.level, lr.parent_location_id
         FROM location_register lr
        WHERE lr.site_id = $2
       UNION ALL
       SELECT z.start_id, parent.location_id, parent.level, parent.parent_location_id
         FROM location_register parent
         JOIN zone_of z ON z.parent_location_id = parent.location_id
        WHERE z.level <> 'zone' AND parent.site_id = $2
     )
     SELECT lm.lot_id AS lot_uuid,
            lm.lot_number,
            sb.location_id,
            lr.location_code,
            zr.location_id AS zone_id,
            sb.available::text AS available,
            lr.pick_sequence AS bin_pick_sequence,
            lm.expiry_date
       FROM stock_balance sb
       JOIN lot_master lm ON lm.lot_number = sb.lot_id AND lm.sku = sb.sku
       JOIN location_register lr ON lr.location_id = sb.location_id AND lr.site_id = $2
       LEFT JOIN LATERAL (
         SELECT z.location_id FROM zone_of z WHERE z.start_id = lr.location_id AND z.level = 'zone' LIMIT 1
       ) zr ON true
       WHERE sb.sku = $1
         AND sb.stock_class = 'owned'
         AND sb.available > 0
         AND lm.quality_hold_status = 'none'
         AND (lm.expiry_date IS NULL OR lm.expiry_date >= CURRENT_DATE)
         AND lr.status = 'active'
         AND lr.quarantine = false
         AND lr.access_restricted = false
       ORDER BY lm.expiry_date ASC NULLS LAST, lm.lot_number ASC, lr.pick_sequence ASC NULLS LAST, lr.location_code ASC`,
    [sku, siteId],
  );
  return result.rows as FefoCandidateRow[];
}

/**
 * Greedy FEFO allocation for one dispatch-order line. `consumed` tracks quantities already taken
 * by earlier lines in the same generation run (the DB rows only change when the events apply).
 * All-or-nothing per line: a shortfall rejects INSUFFICIENT_STOCK_FOR_PICK.
 */
async function allocateForLine(
  line: ErpSalesOrderRow,
  siteId: string,
  consumed: Map<string, bigint>,
  client: PoolClient,
): Promise<LotAllocation[]> {
  if (!isNonNegativeMicro(line.quantity) || numericToMicro(line.quantity) === 0n) {
    throw new AppError(400, 'PICK_TASK_INVALID_PAYLOAD', 'Dispatch-order line quantity must be a positive numeric value', {
      dispatch_order_line_id: line.id,
      quantity: line.quantity,
    });
  }
  const candidates = await fefoCandidates(line.sku, siteId, client);

  // Story 3.5 consumption: when a lot is stored in several bins, prefer the velocity-class
  // preferred bin for this (sku, site) - the first read of velocity data for pick-path use.
  const velocity = await getVelocityClass(line.sku, siteId, client);
  const preferredLocationId = velocity?.preferred_location_id ?? null;
  const byLot = new Map<string, FefoCandidateRow[]>();
  for (const c of candidates) {
    const rows = byLot.get(c.lot_uuid) ?? [];
    rows.push(c);
    byLot.set(c.lot_uuid, rows);
  }
  const ordered: FefoCandidateRow[] = [];
  const seenLots = new Set<string>();
  for (const c of candidates) {
    if (seenLots.has(c.lot_uuid)) continue;
    seenLots.add(c.lot_uuid);
    const rows = [...(byLot.get(c.lot_uuid) ?? [])];
    rows.sort((a, b) => {
      const aPref = a.location_id === preferredLocationId ? 0 : 1;
      const bPref = b.location_id === preferredLocationId ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      const aSeq = a.bin_pick_sequence ?? Number.MAX_SAFE_INTEGER;
      const bSeq = b.bin_pick_sequence ?? Number.MAX_SAFE_INTEGER;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.location_code.localeCompare(b.location_code);
    });
    ordered.push(...rows);
  }

  let remaining = numericToMicro(line.quantity.toString());
  const allocations: LotAllocation[] = [];
  for (const c of ordered) {
    if (remaining <= 0n) break;
    const key = `${c.lot_number}\0${c.location_id}`;
    const alreadyConsumed = consumed.get(key) ?? 0n;
    const available = numericToMicro(c.available) - alreadyConsumed;
    if (available <= 0n) continue;
    if (!c.zone_id) {
      throw new AppError(409, 'PICK_TASK_INVALID_PAYLOAD', `Bin "${c.location_code}" has no zone ancestor; cannot route the pick`, {
        location_id: c.location_id,
      });
    }
    // Review pass 2: truncate to milli precision. stock_balance.available is NUMERIC(18,6) while
    // pick quantities persist into NUMERIC(14,3), so an untruncated take from a bin holding
    // sub-milli availability produced a quantity this story's own shape assert then rejected.
    const rawTake = available < remaining ? available : remaining;
    const take = (rawTake / 1000n) * 1000n;
    if (take <= 0n) continue;
    consumed.set(key, alreadyConsumed + take);
    allocations.push({
      lotUuid: c.lot_uuid,
      lotNumber: c.lot_number,
      locationId: c.location_id,
      zoneId: c.zone_id,
      quantity: microToNumeric(take),
      binSequence: c.bin_pick_sequence,
      locationCode: c.location_code,
    });
    remaining -= take;
  }

  if (remaining > 0n) {
    const detail = candidates.length === 0
      ? 'No pickable stock found for this SKU at the site; stock may exist in restricted or quarantined bins'
      : `Shortfall of ${microToNumeric(remaining)} after allocating from ${allocations.length} lot-location(s)`;
    throw new AppError(409, 'INSUFFICIENT_STOCK_FOR_PICK', detail, {
      dispatch_order_line_id: line.id,
      sku: line.sku,
      requested_quantity: line.quantity,
      shortfall_quantity: microToNumeric(remaining),
    });
  }

  return allocations;
}

/** Ascending bin pick-sequence within each zone (AC1's observable "optimized path"). */
function sequenceWithinZones(allocations: LotAllocation[]): Map<LotAllocation, number> {
  const byZone = new Map<string, LotAllocation[]>();
  for (const a of allocations) {
    const list = byZone.get(a.zoneId) ?? [];
    list.push(a);
    byZone.set(a.zoneId, list);
  }
  const sequenced = new Map<LotAllocation, number>();
  for (const list of byZone.values()) {
    list.sort((a, b) => {
      const aSeq = a.binSequence ?? Number.MAX_SAFE_INTEGER;
      const bSeq = b.binSequence ?? Number.MAX_SAFE_INTEGER;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.locationCode.localeCompare(b.locationCode);
    });
    list.forEach((a, i) => sequenced.set(a, i + 1));
  }
  return sequenced;
}

interface TaskDraft {
  dispatchOrderId: string;
  sku: string;
  zoneId: string;
  waveId: string | null;
  batchId: string | null;
  strategy: 'single' | 'batch' | 'wave' | 'zone';
  lines: Array<{ allocation: LotAllocation; dispatchOrderLineId: string; sku: string; pickSequence: number }>;
}

async function persistTask(
  draft: TaskDraft,
  input: GeneratePickTasksInput,
  client: PoolClient,
): Promise<{ pickTaskId: string; pickLineIds: string[] }> {
  const pickTaskId = randomUUID();
  const pickLines: PickLineInput[] = draft.lines.map((l) => ({
    pick_line_id: randomUUID(),
    dispatch_order_line_id: l.dispatchOrderLineId,
    sku: l.sku,
    directed_lot_id: l.allocation.lotUuid,
    directed_quantity: l.allocation.quantity,
    location_id: l.allocation.locationId,
    pick_sequence: l.pickSequence,
  }));
  const total = draft.lines.reduce((sum, l) => sum + numericToMicro(l.allocation.quantity), 0n);
  const first = draft.lines[0]!;

  await persistEvent(
    {
      stream_type: 'warehouse',
      stream_id: pickTaskId,
      event_type: 'pick_task.created',
      payload: {
        pick_task_id: pickTaskId,
        dispatch_order_id: draft.dispatchOrderId,
        sku: draft.sku,
        quantity: microToNumeric(total),
        lot_id: first.allocation.lotUuid,
        location_id: first.allocation.locationId,
        pick_sequence: first.pickSequence,
        strategy: draft.strategy,
        wave_id: draft.waveId,
        batch_id: draft.batchId,
        zone_id: draft.zoneId,
        pick_lines: pickLines,
        created_by: input.createdBy,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: input.actor,
        occurred_at: new Date().toISOString(),
      },
    },
    undefined,
    client,
  );

  return { pickTaskId, pickLineIds: pickLines.map((l) => l.pick_line_id) };
}

export async function generatePickTasks(input: GeneratePickTasksInput, client: PoolClient): Promise<GeneratePickTasksResult> {
  if (input.dispatchOrderLineIds.length === 0) {
    throw new AppError(400, 'DISPATCH_ORDER_LINE_NOT_FOUND', 'dispatchOrderLineIds must not be empty');
  }

  // (a) Load and validate every dispatch-order line up front. Lock the open sales-order rows by
  // their UUID surrogate so concurrent generation runs for the same lines cannot both pass this
  // gate and create duplicate pick tasks.
  const lines: ErpSalesOrderRow[] = [];
  await client.query(
    `SELECT id FROM erp_sales_order WHERE id = ANY($1::uuid[]) AND status = 'open' FOR UPDATE`,
    [input.dispatchOrderLineIds],
  );
  for (const id of input.dispatchOrderLineIds) {
    const line = await getSalesOrderLineById(id, client);
    if (!line || line.status !== 'open') {
      throw new AppError(404, 'DISPATCH_ORDER_LINE_NOT_FOUND', `No open sales-order line exists for "${id}"`, {
        dispatch_order_line_id: id,
      });
    }
    if (line.ship_from_site_id !== input.siteId) {
      throw new AppError(409, 'DISPATCH_ORDER_LINE_NOT_FOUND', `Sales-order line "${id}" does not ship from site "${input.siteId}"`, {
        dispatch_order_line_id: id,
        ship_from_site_id: line.ship_from_site_id,
      });
    }
    // Review pass 2: generation must be idempotent. Nothing marks a demand line consumed - the
    // FOR UPDATE above only serializes concurrent runs, it does not stop a second run from
    // re-allocating the same demand - so a repeated submission previously produced a second task
    // holding a second allocation for the same order line. An existing live pick line for this
    // order line is the consumption record.
    const existing = await client.query(
      `SELECT 1
         FROM pick_line pl
         JOIN pick_task pt ON pt.pick_task_id = pl.pick_task_id
        WHERE pl.dispatch_order_line_id = $1
          AND pl.status <> 'cancelled'
          AND pt.status <> 'cancelled'
        LIMIT 1`,
      [id],
    );
    if (existing.rows.length > 0) {
      throw new AppError(409, 'PICK_TASK_ALREADY_GENERATED', `Pick tasks already exist for sales-order line "${id}"`, {
        dispatch_order_line_id: id,
      });
    }
    lines.push(line);
  }

  // (b)-(c) FEFO allocation per line with shared in-run availability tracking.
  const consumed = new Map<string, bigint>();
  const allocated: AllocatedLine[] = [];
  for (const line of lines) {
    allocated.push({ line, allocations: await allocateForLine(line, input.siteId, consumed, client) });
  }

  // (d) Sequence bins within each zone across the whole generation run.
  const allAllocations = allocated.flatMap((a) => a.allocations);
  const sequenced = sequenceWithinZones(allAllocations);

  // (e) Group into task drafts per strategy.
  const drafts: TaskDraft[] = [];
  const waveId = input.strategy === 'wave' ? (input.waveId ?? randomUUID()) : null;
  const batchId = input.strategy === 'batch' ? (input.batchId ?? randomUUID()) : null;

  if (input.strategy === 'single' || input.strategy === 'wave') {
    // One task per dispatch-order line; the task's zone is its first allocation's zone.
    for (const { line, allocations } of allocated) {
      if (allocations.length === 0) continue;
      drafts.push({
        dispatchOrderId: line.id,
        sku: line.sku,
        zoneId: allocations[0]!.zoneId,
        waveId,
        batchId: null,
        strategy: input.strategy,
        lines: allocations.map((allocation) => ({
          allocation,
          dispatchOrderLineId: line.id,
          sku: line.sku,
          pickSequence: sequenced.get(allocation)!,
        })),
      });
    }
  } else if (input.strategy === 'batch') {
    // ONE consolidated task per (sku, zone) group. dispatch_order_id references the FIRST
    // contributing order line (documented choice: pick_line.dispatch_order_line_id preserves
    // per-order sortation, AC2).
    const groups = new Map<string, TaskDraft>();
    for (const { line, allocations } of allocated) {
      for (const allocation of allocations) {
        const key = `${line.sku}\0${allocation.zoneId}`;
        let draft = groups.get(key);
        if (!draft) {
          draft = {
            dispatchOrderId: line.id,
            sku: line.sku,
            zoneId: allocation.zoneId,
            waveId: null,
            batchId,
            strategy: 'batch',
            lines: [],
          };
          groups.set(key, draft);
        }
        draft.lines.push({ allocation, dispatchOrderLineId: line.id, sku: line.sku, pickSequence: sequenced.get(allocation)! });
      }
    }
    drafts.push(...groups.values());
  } else {
    // zone strategy (AC4): one task per zone per dispatch order, assignable per zone operator.
    const groups = new Map<string, TaskDraft>();
    for (const { line, allocations } of allocated) {
      for (const allocation of allocations) {
        const key = `${line.id}\0${allocation.zoneId}`;
        let draft = groups.get(key);
        if (!draft) {
          draft = {
            dispatchOrderId: line.id,
            sku: line.sku,
            zoneId: allocation.zoneId,
            waveId: null,
            batchId: null,
            strategy: 'zone',
            lines: [],
          };
          groups.set(key, draft);
        }
        draft.lines.push({ allocation, dispatchOrderLineId: line.id, sku: line.sku, pickSequence: sequenced.get(allocation)! });
      }
    }
    drafts.push(...groups.values());
  }

  // (f) Persist one pick_task.created event per draft; the Task 5.3 apply inserts the projection
  // rows and allocates stock inside the caller's transaction.
  const pickTaskIds: string[] = [];
  const pickLineIds: string[] = [];
  for (const draft of drafts) {
    draft.lines.sort((a, b) => a.pickSequence - b.pickSequence);
    const persisted = await persistTask(draft, input, client);
    pickTaskIds.push(persisted.pickTaskId);
    pickLineIds.push(...persisted.pickLineIds);
  }

  return { pickTaskIds, pickLineIds };
}

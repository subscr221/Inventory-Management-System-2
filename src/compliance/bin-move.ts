import type { PoolClient } from 'pg';
import type { StockBinMovedEnvelope } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { getItemBySku } from '../read/projections/item_master.js';
import { getLocationById } from '../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { applyStockIssue, applyStockReceipt } from '../read/projections/stock_balance.js';
import { assertActorAtSite } from './actor-site.js';
import { VALID_STOCK_CLASSES } from './stock-balance.js';
import { binOfSiteFault, isQuarantineLocation, lotRelocationHold } from './stock-relocation.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUANTITY_REGEX = /^\d+(\.\d+)?$/;
// Review R7(b): the move is class-preserving (issue and receipt carry the same class), so every
// class the platform holds stock under is movable, the segregated ones included. Read at call
// time: stock-balance.ts and this module sit on an import cycle through the event store.

/**
 * Pilot G3 (owner default ruling 2026-09-20): who may move stock between bins. The storekeeping
 * roles only - warehouse_manager and inventory_controller are deliberately absent (segregation of
 * duties: whoever counts stock must not also move it). Its own constant, so changing who may put
 * away never silently changes who may move stock. Enforced at the REST route, at the events door
 * and, through metadata.actor.role, in the applier below; the edge door refuses the event outright.
 */
export const BIN_MOVE_ROLES: readonly string[] = ['store_assistant', 'stock_locator'];

/** Pilot G3: pre-transaction shape validation for stock.bin_moved (non-DB, consumes no key). */
export function assertStockBinMovedShape(envelope: StockBinMovedEnvelope): void {
  const p = envelope.payload as unknown as Record<string, unknown>;
  for (const field of ['site_id', 'from_location_id', 'to_location_id']) {
    if (typeof p[field] !== 'string' || !UUID_REGEX.test(p[field] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', `${field} is required and must be a UUID`);
    }
  }
  if (typeof p['sku'] !== 'string' || p['sku'] === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
  }
  const quantity = typeof p['quantity'] === 'number' ? String(p['quantity']) : p['quantity'];
  if (typeof quantity !== 'string' || !QUANTITY_REGEX.test(quantity) || Number(quantity) <= 0) {
    throw new AppError(
      400,
      'BIN_MOVE_QUANTITY_INVALID',
      'quantity is required and must be greater than zero',
    );
  }
  if (
    (p['from_location_id'] as string).toLowerCase() ===
    (p['to_location_id'] as string).toLowerCase()
  ) {
    throw new AppError(
      400,
      'BIN_MOVE_SAME_LOCATION',
      'A bin move needs two different bins: from_location_id equals to_location_id',
    );
  }
  if (p['lot_id'] !== undefined && p['lot_id'] !== null && typeof p['lot_id'] !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a lot number string when supplied');
  }
  if (p['stock_class'] !== undefined && !VALID_STOCK_CLASSES.has(p['stock_class'] as string)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `stock_class must be one of: ${[...VALID_STOCK_CLASSES].join(', ')}`,
    );
  }
  if (
    p['serials'] !== undefined &&
    (!Array.isArray(p['serials']) ||
      p['serials'].length === 0 ||
      !p['serials'].every((s) => typeof s === 'string' && s !== '') ||
      new Set(p['serials']).size !== p['serials'].length)
  ) {
    throw new AppError(
      400,
      'BIN_MOVE_SERIALS_INVALID',
      'serials must be a non-empty array of distinct serial numbers when supplied',
    );
  }
}

async function requireBinOfSite(
  locationId: string,
  siteId: string,
  end: 'from' | 'to',
  client: PoolClient,
): Promise<LocationRegisterEntry> {
  const location = await getLocationById(locationId, client);
  if (!location) {
    throw new AppError(404, 'BIN_MOVE_LOCATION_NOT_FOUND', `Location ${locationId} not found`, {
      end,
      location_id: locationId,
    });
  }
  const fault = binOfSiteFault(location, siteId);
  if (fault) {
    throw new AppError(
      409,
      'BIN_MOVE_LOCATION_INVALID',
      `Location ${location.location_code} cannot be the ${end} end of this move: both ends must be active bins of the same site`,
      { end, location_code: location.location_code, reason: fault },
    );
  }
  return location;
}

/**
 * Pilot G3 (owner ruling 2026-09-20): in-transaction apply for stock.bin_moved - a same-site
 * bin-to-bin relocation. Every rule lives HERE, not in the REST handler, so a direct POST /events
 * on the warehouse stream is refused by the same rules. The balance moves with the mechanism the
 * putaway completion uses (applyStockIssue with `relocation` + applyStockReceipt in this
 * transaction): last_issue_at is not reset, and because the event is not on a valuation stream the
 * move is valuation-neutral. A refusal rolls the whole event back, so nothing is half-moved.
 */
export async function applyStockBinMovedProjection(
  envelope: StockBinMovedEnvelope,
  client: PoolClient,
): Promise<void> {
  const p = envelope.payload;
  const lotNumber = p.lot_id ?? null;
  const stockClass = p.stock_class ?? 'owned';
  const quantity = String(p.quantity);

  await assertActorAtSite(envelope.metadata.actor.location_id, p.site_id, { sku: p.sku }, client);

  // Review R1: the role wall, repeated here because the doors authorize on module plus write alone
  // (the pick_task.completed precedent). Both doors that admit this event stamp actor.role from the
  // bin-move assignment that authorized it.
  if (!BIN_MOVE_ROLES.includes(envelope.metadata.actor.role)) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `Moving stock between bins is restricted to roles: ${BIN_MOVE_ROLES.join(', ')}`,
      { actor_role: envelope.metadata.actor.role },
    );
  }

  // Step 1: both ends are active bins of the one site (the putaway destination rule, shared).
  const from = await requireBinOfSite(p.from_location_id, p.site_id, 'from', client);
  const to = await requireBinOfSite(p.to_location_id, p.site_id, 'to', client);

  // Step 2: the lot key must match the item - a lot-controlled item moves as a lot, a plain item
  // has only the lot-less balance.
  const item = await getItemBySku(p.sku, client);
  if (!item) {
    throw new AppError(404, 'BIN_MOVE_ITEM_NOT_FOUND', `Item ${p.sku} not found`, { sku: p.sku });
  }
  if (item.lot_controlled && lotNumber === null) {
    throw new AppError(
      400,
      'BIN_MOVE_LOT_REQUIRED',
      `Item ${p.sku} is lot-controlled: the move must name the lot`,
      { sku: p.sku },
    );
  }
  if (!item.lot_controlled && lotNumber !== null) {
    throw new AppError(
      400,
      'BIN_MOVE_LOT_NOT_ALLOWED',
      `Item ${p.sku} is not lot-controlled: the move must not name a lot`,
      { sku: p.sku, lot_id: lotNumber },
    );
  }
  if (lotNumber !== null && !(await getLotByNumberAndSku(lotNumber, p.sku, client))) {
    throw new AppError(404, 'BIN_MOVE_LOT_NOT_FOUND', `Lot ${lotNumber} not found for ${p.sku}`, {
      sku: p.sku,
      lot_id: lotNumber,
    });
  }

  // Step 3: QC policy, the same rule as the putaway completion (stock-relocation.ts).
  let heldLot = false;
  if (lotNumber !== null) {
    const hold = await lotRelocationHold(p.sku, lotNumber, client);
    heldLot = hold.qcGated || hold.manuallyHeld;
    if (
      (hold.qcGated || hold.manuallyHeld) &&
      !(await isQuarantineLocation(to.location_id, client))
    ) {
      throw new AppError(
        409,
        'BIN_MOVE_QC_HOLD_QUARANTINE_REQUIRED',
        `Lot ${lotNumber} is under QC hold and may only be moved into a quarantine bin, not ${to.location_code}`,
        { sku: p.sku, lot_id: lotNumber, location_code: to.location_code },
      );
    }
  }

  // Step 4: only AVAILABLE stock at the exact (sku, bin, lot, class) grain is movable - allocated
  // or picked quantity is promised to an order and stays where the pick expects it. The row lock
  // serialises concurrent moves; applyStockIssue below would drain across lots for a lot-less key,
  // so the exact-grain check is made here first.
  // Review R7(a): BOTH ends are locked first, in location order, so an A-to-B move and a B-to-A
  // move queue behind one another instead of deadlocking on each other's receipt row.
  await client.query(
    `SELECT balance_id FROM stock_balance
      WHERE sku = $1 AND location_id = ANY($2::uuid[]) AND stock_class = $3
      ORDER BY location_id, balance_id
      FOR UPDATE`,
    [p.sku, [from.location_id, to.location_id], stockClass],
  );
  const source = await client.query(
    `SELECT COALESCE(SUM(available), 0)::text AS available,
            COALESCE(SUM(available), 0) >= $5::numeric AS sufficient
       FROM (SELECT available FROM stock_balance
              WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text
                AND stock_class = $4
              FOR UPDATE) grain`,
    [p.sku, from.location_id, lotNumber, stockClass, quantity],
  );
  if (source.rows[0]!['sufficient'] !== true) {
    throw new AppError(
      409,
      'BIN_MOVE_INSUFFICIENT_AVAILABLE',
      `Only ${source.rows[0]!['available'] as string} of ${p.sku} is available to move at ${from.location_code}; allocated or picked stock cannot be moved`,
      {
        sku: p.sku,
        location_code: from.location_code,
        lot_id: lotNumber,
        stock_class: stockClass,
        requested_quantity: quantity,
        available_quantity: source.rows[0]!['available'],
      },
    );
  }

  // Step 4b (review R5): what an OPEN task still needs from this bin is not movable either. A
  // putaway task reserves its quantity at its exact (sku, bin, lot) grain; a replenishment task is
  // lot-less and drains owned stock, so it reserves against the bin's owned stock of the SKU as a
  // whole. Moving only the surplus keeps PUTAWAY_OVERRIDE_REASON_REQUIRED meaningful and never
  // leaves a task to fail INSUFFICIENT_STOCK later.
  const putawayTasks = await client.query(
    `SELECT putaway_task_id, quantity::text AS quantity FROM putaway_task
      WHERE sku = $1 AND from_location_id = $2 AND lot_id IS NOT DISTINCT FROM $3::text
        AND status IN ('ready', 'held')`,
    [p.sku, from.location_id, lotNumber],
  );
  const replenishmentTasks =
    stockClass === 'owned'
      ? await client.query(
          `SELECT replenishment_task_id, quantity::text AS quantity FROM replenishment_task
            WHERE sku = $1 AND from_location_id = $2 AND status = 'ready'`,
          [p.sku, from.location_id],
        )
      : { rows: [] as Record<string, unknown>[] };
  if (putawayTasks.rows.length > 0 || replenishmentTasks.rows.length > 0) {
    const movable = await client.query(
      `WITH reserved AS (
         SELECT (SELECT COALESCE(SUM(q::numeric), 0) FROM unnest($2::text[]) q) AS putaway,
                (SELECT COALESCE(SUM(q::numeric), 0) FROM unnest($3::text[]) q) AS replenishment
       )
       SELECT GREATEST(0, LEAST($1::numeric - putaway,
                CASE WHEN replenishment = 0 THEN $1::numeric
                     ELSE (SELECT COALESCE(SUM(available), 0) FROM stock_balance
                            WHERE sku = $4 AND location_id = $5 AND stock_class = $6)
                          - putaway - replenishment END))::text AS movable,
              GREATEST(0, LEAST($1::numeric - putaway,
                CASE WHEN replenishment = 0 THEN $1::numeric
                     ELSE (SELECT COALESCE(SUM(available), 0) FROM stock_balance
                            WHERE sku = $4 AND location_id = $5 AND stock_class = $6)
                          - putaway - replenishment END)) >= $7::numeric AS sufficient
         FROM reserved`,
      [
        source.rows[0]!['available'],
        putawayTasks.rows.map((r) => r['quantity']),
        replenishmentTasks.rows.map((r) => r['quantity']),
        p.sku,
        from.location_id,
        stockClass,
        quantity,
      ],
    );
    const movableQuantity = movable.rows[0]!['movable'] as string;
    if (movable.rows[0]!['sufficient'] !== true) {
      throw new AppError(
        409,
        'BIN_MOVE_STOCK_RESERVED_BY_TASK',
        `Only ${movableQuantity} of ${p.sku} at ${from.location_code} is free to move: the rest is needed by an open putaway or replenishment task`,
        {
          sku: p.sku,
          location_code: from.location_code,
          lot_id: lotNumber,
          requested_quantity: quantity,
          movable_quantity: movableQuantity,
          putaway_task_ids: putawayTasks.rows.map((r) => r['putaway_task_id']),
          replenishment_task_ids: replenishmentTasks.rows.map((r) => r['replenishment_task_id']),
        },
      );
    }
  }

  // Step 5: serials. serial_master carries the serial's current location, so a serial-controlled
  // item moves by naming exactly the serials that leave the source bin (one per unit).
  const serials = p.serials ?? [];
  if (
    item.serial_controlled !== serials.length > 0 ||
    (serials.length > 0 && serials.length !== Number(quantity))
  ) {
    throw new AppError(
      400,
      'BIN_MOVE_SERIALS_INVALID',
      item.serial_controlled
        ? `Item ${p.sku} is serial-controlled: name one serial per unit moved`
        : `Item ${p.sku} is not serial-controlled: the move must not name serials`,
      { sku: p.sku, quantity, serial_count: serials.length },
    );
  }
  if (serials.length > 0) {
    const moved = await client.query(
      `UPDATE serial_master
          SET current_location_id = $4, current_location_code = $5, updated_at = now()
        WHERE sku = $1 AND serial_number = ANY($2::text[]) AND current_location_id = $3
          AND lot_id IS NOT DISTINCT FROM $6::text AND current_quantity > 0
        RETURNING serial_number`,
      [p.sku, serials, from.location_id, to.location_id, to.location_code, lotNumber],
    );
    if (moved.rows.length !== serials.length) {
      const found = new Set(moved.rows.map((r: Record<string, unknown>) => r['serial_number']));
      throw new AppError(
        409,
        'BIN_MOVE_SERIALS_INVALID',
        `Not every serial is in stock at ${from.location_code} under this lot`,
        { sku: p.sku, serials_not_at_source: serials.filter((s) => !found.has(s)) },
      );
    }
  }

  // Step 6: relocate. qc_gate_relocation is set only for the held-lot-into-quarantine case admitted
  // in Step 3 (gated or held by hand - the drain window hides both since review R6).
  await applyStockIssue(
    {
      sku: p.sku,
      location_id: from.location_id,
      lot_id: lotNumber,
      stock_class: stockClass,
      quantity,
      relocation: true,
      ...(heldLot ? { qc_gate_relocation: true } : {}),
    },
    client,
  );
  await applyStockReceipt(
    {
      sku: p.sku,
      location_id: to.location_id,
      location_code: to.location_code,
      lot_id: lotNumber,
      stock_class: stockClass,
      quantity,
    },
    client,
  );
}

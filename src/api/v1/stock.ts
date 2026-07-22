import type { RouteHandler } from '../../middleware/error.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule } from '../../middleware/rbac.js';
import { getItemBySku } from '../../read/projections/item_master.js';
import { getStockBalancesBySku } from '../../read/projections/stock_balance.js';
import type { StockBalance } from '../../read/projections/stock_balance.js';
import { listAgreements } from '../../read/projections/ownership_agreement.js';

// Mirrors src/api/v1/items.ts: SKU is API-facing (URL path segment), so keep it URL-safe.
const SKU_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface ClassBalance {
  stock_class: string;
  /** Story 2.8: owner-party supplier code for consignment/vmi classes, from the active agreement. */
  owner_party_code: string | null;
  on_hand: number;
  allocated: number;
  available: number;
  in_transit: number;
}

interface LocationBalance {
  location_id: string;
  location_code: string | null;
  on_hand: number;
  allocated: number;
  available: number;
  in_transit: number;
  /** Story 2.8: per-stock-class breakdown (closes the Story 2.2 merged-across-class defer). */
  classes: ClassBalance[];
}

/**
 * GET /api/v1/stock/:sku (Story 2.2, AC1): per-location balances plus a consolidated total,
 * answered from the stock_balance projection - never by replaying the event stream. Rows are
 * stored at sku+location+lot grain; the response aggregates per location. Location scoping
 * mirrors the events read path: a non-wildcard caller sees only balances at locations their
 * inventory role grants, and the consolidated total sums only what they can see.
 */
const getStockBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku || !SKU_REGEX.test(sku)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter must be 1-64 URL-safe characters');
    return;
  }
  const item = await getItemBySku(sku);
  if (!item) {
    sendRequestError(req, res, 404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${sku}"`, { sku });
    return;
  }

  let rows: StockBalance[] = await getStockBalancesBySku(sku);
  const authContext = getAuthContext(req);
  if (authContext) {
    const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
    if (!wildcard) rows = rows.filter((row) => locations.has(row.location_id));
  }

  // Story 2.8: resolve owner-party codes for consignment/vmi classes from the active agreements
  // so a class entry always names the supplier that owns the stock (AC1).
  const { wildcard: agreementWildcard, locations: agreementLocations } = authContext ? permittedLocationsForModule(authContext.roles, 'inventory') : { wildcard: true, locations: new Set<string>() };
  const agreements = await listAgreements({ sku, active: true, location_any: agreementWildcard ? null : [...agreementLocations] });
  const ownerByGrain = new Map<string, string>();
  for (const agreement of agreements) {
    ownerByGrain.set(`${agreement.location_id}|${agreement.stock_class}`, agreement.owner_party_code);
  }

  const byLocation = new Map<string, LocationBalance>();
  for (const row of rows) {
    const entry = byLocation.get(row.location_id) ?? {
      location_id: row.location_id,
      location_code: row.location_code,
      on_hand: 0,
      allocated: 0,
      available: 0,
      in_transit: 0,
      classes: [] as ClassBalance[],
    };
    entry.location_code = entry.location_code ?? row.location_code;
    if (row.stock_class === 'owned') {
      entry.on_hand += row.on_hand;
      entry.allocated += row.allocated;
      entry.available += row.available;
      entry.in_transit += row.in_transit;
    }
    let classEntry = entry.classes.find((c) => c.stock_class === row.stock_class);
    if (!classEntry) {
      classEntry = {
        stock_class: row.stock_class,
        owner_party_code: ownerByGrain.get(`${row.location_id}|${row.stock_class}`) ?? null,
        on_hand: 0,
        allocated: 0,
        available: 0,
        in_transit: 0,
      };
      entry.classes.push(classEntry);
    }
    classEntry.on_hand += row.on_hand;
    classEntry.allocated += row.allocated;
    classEntry.available += row.available;
    classEntry.in_transit += row.in_transit;
    byLocation.set(row.location_id, entry);
  }

  // Task 3.4: deterministic ordering - location_code when available, otherwise location_id.
  const locations = [...byLocation.values()].sort((a, b) =>
    (a.location_code ?? a.location_id).localeCompare(b.location_code ?? b.location_id, 'en', { sensitivity: 'base' }),
  );
  for (const entry of locations) {
    entry.classes.sort((a, b) => a.stock_class.localeCompare(b.stock_class, 'en', { sensitivity: 'base' }));
  }

  const consolidated = locations.reduce(
    (totals, entry) => ({
      on_hand: totals.on_hand + entry.on_hand,
      allocated: totals.allocated + entry.allocated,
      available: totals.available + entry.available,
      in_transit: totals.in_transit + entry.in_transit,
    }),
    { on_hand: 0, allocated: 0, available: 0, in_transit: 0 },
  );

  // Story 2.8: consolidated per-class totals across visible locations, deterministically ordered.
  const byClassTotals = new Map<string, { stock_class: string; on_hand: number; allocated: number; available: number; in_transit: number }>();
  for (const entry of locations) {
    for (const classEntry of entry.classes) {
      const totals = byClassTotals.get(classEntry.stock_class) ?? {
        stock_class: classEntry.stock_class,
        on_hand: 0,
        allocated: 0,
        available: 0,
        in_transit: 0,
      };
      totals.on_hand += classEntry.on_hand;
      totals.allocated += classEntry.allocated;
      totals.available += classEntry.available;
      totals.in_transit += classEntry.in_transit;
      byClassTotals.set(classEntry.stock_class, totals);
    }
  }
  const consolidatedByClass = [...byClassTotals.values()].sort((a, b) =>
    a.stock_class.localeCompare(b.stock_class, 'en', { sensitivity: 'base' }),
  );

  sendJson(res, 200, { sku, locations, consolidated, consolidated_by_class: consolidatedByClass });
};

export const getStockHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getStockBase);

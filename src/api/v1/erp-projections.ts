import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getParsedBody } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule } from '../../middleware/rbac.js';
import { config } from '../../config/index.js';
import { getPurchaseOrderByRef } from '../../read/projections/erp_purchase_order.js';
import { listSalesOrders } from '../../read/projections/erp_sales_order.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import { getFreshness } from '../../read/projections/integration_exception.js';
import { runErpSync, raiseErpSyncStale } from '../../adapters/erp/sync.js';
import type { ErpSyncBatch } from '../../adapters/erp/sync.js';

/**
 * ERP inbound reference projection read API (Story 2.9). GET handlers are read-only projections of
 * ERP-mastered PO and SO data (INT-ERP-01); every write verb on these paths is rejected
 * SOURCE_SYSTEM_READ_ONLY (the router 404s unregistered methods, so an explicit handler is required
 * to return the stable code). Every read response carries staleness metadata computed in SQL from the
 * erp_sync_state heartbeat; a stale response performs the AC3 deduped operational alert write. The
 * POST /api/v1/erp/sync trigger is the Phase-1 synthetic driver for the in-process sync adapter.
 */

const PO_REF_REGEX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const SITE_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Only the ERP service account and a system administrator may drive an inbound sync. Recorded here
// for the access-matrix sync (the matrix has no explicit INT-ERP-01 read-projection row yet).
const ERP_SYNC_ROLES = ['svc_erp_adapter', 'system_administrator'];

function assertRoleAllowed(req: IncomingMessage, allowedRoles: string[], functionScope: 'read' | 'write'): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) => (r.module === 'inventory' || r.module === '*') && r.functionScope === functionScope && allowedRoles.includes(r.role),
  );
  if (!ok) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/erp/purchase-orders/:poNumber
// ---------------------------------------------------------------------------

const getPurchaseOrderBase: RouteHandler = async (req, res, params) => {
  const poNumber = params['poNumber'];
  if (!poNumber || !PO_REF_REGEX.test(poNumber)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'poNumber path parameter must be 1-64 URL-safe characters');
    return;
  }
  // Purchase orders are not location-grained in the source contract, so PO GET uses module/function
  // scope only (requireRole wrapper); downstream receiving performs its own location authorization.
  const po = await getPurchaseOrderByRef(poNumber);
  if (!po) {
    sendRequestError(req, res, 404, 'NOT_FOUND', `No ERP purchase-order projection exists for "${poNumber}"`);
    return;
  }
  const freshness = await getFreshness('purchase_orders', config.erp.freshnessMs);
  if (freshness.stale) {
    // Best-effort: the stale alert is a side effect of a read; its failure must not 500 a successful GET.
    await raiseErpSyncStale('purchase_orders', 'ERP purchase-order projection is stale (served past the freshness threshold)').catch(() => undefined);
  }
  sendJson(res, 200, {
    po_number_ext: po.po_number_ext,
    supplier_ref_ext: po.supplier_ref_ext,
    currency: po.currency,
    expected_delivery_date: po.expected_delivery_date,
    status: po.status,
    source_system: po.source_system,
    last_synced_at: po.last_synced_at,
    stale: freshness.stale,
    last_synced_at_age_seconds: freshness.last_synced_at_age_seconds,
    lines: po.lines.map((line) => ({
      line_no: line.line_no,
      sku: line.sku,
      ordered_qty: line.ordered_qty,
      open_qty: line.open_qty,
      unit_price: line.unit_price,
      over_receipt_tolerance_pct: line.over_receipt_tolerance_pct,
      under_receipt_tolerance_pct: line.under_receipt_tolerance_pct,
      source_system: line.source_system,
      last_synced_at: line.last_synced_at,
    })),
  });
};

// ---------------------------------------------------------------------------
// GET /api/v1/erp/sales-orders?site=site-A&status=open
// ---------------------------------------------------------------------------

const listSalesOrdersBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const site = url.searchParams.get('site');
  const status = url.searchParams.get('status');

  if (status !== null && status !== 'open' && status !== 'closed') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "status filter must be 'open' or 'closed'");
    return;
  }

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  let shipFromSiteCode: string | null = null;
  let locationAny: string[] | null = null;

  if (site !== null) {
    if (!SITE_CODE_REGEX.test(site)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'site filter must be 1-64 URL-safe characters');
      return;
    }
    const location = await getLocationByCode(site);
    if (!location || location.status !== 'active' || location.level !== 'site') {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', `site "${site}" is not an active site`);
      return;
    }
    if (!wildcard && !locations.has(location.location_id)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', `No inventory assignment grants access to site "${site}"`);
      return;
    }
    shipFromSiteCode = site;
  } else if (!wildcard) {
    // No site filter: scope the list to the caller's permitted sites. An empty permitted set means
    // the caller sees an empty list, never every site.
    locationAny = [...locations];
    if (locationAny.length === 0) {
      const freshness = await getFreshness('sales_orders', config.erp.freshnessMs);
      if (freshness.stale) {
        await raiseErpSyncStale('sales_orders', 'ERP sales-order projection is stale (served past the freshness threshold)').catch(() => undefined);
      }
      sendJson(res, 200, { sales_orders: [], stale: freshness.stale, last_synced_at_age_seconds: freshness.last_synced_at_age_seconds });
      return;
    }
  }

  const rows = await listSalesOrders({ ship_from_site_code_ext: shipFromSiteCode, status, location_any: locationAny });
  const freshness = await getFreshness('sales_orders', config.erp.freshnessMs);
  if (freshness.stale) {
    await raiseErpSyncStale('sales_orders', 'ERP sales-order projection is stale (served past the freshness threshold)').catch(() => undefined);
  }
  sendJson(res, 200, {
    sales_orders: rows.map((row) => ({
      so_number_ext: row.so_number_ext,
      line_no: row.line_no,
      sku: row.sku,
      quantity: row.quantity,
      required_by: row.required_by,
      ship_to: row.ship_to_ext,
      ship_from_site_code: row.ship_from_site_code_ext,
      status: row.status,
      source_system: row.source_system,
      last_synced_at: row.last_synced_at,
    })),
    stale: freshness.stale,
    last_synced_at_age_seconds: freshness.last_synced_at_age_seconds,
  });
};

// ---------------------------------------------------------------------------
// POST /api/v1/erp/sync  (Phase-1 synthetic inbound-sync trigger)
// ---------------------------------------------------------------------------

const erpSyncTriggerBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, ERP_SYNC_ROLES, 'write');
  const body = getParsedBody(req) as ErpSyncBatch | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body must be a JSON object with purchase_orders and/or sales_orders');
    return;
  }
  if (body.purchase_orders !== undefined && !Array.isArray(body.purchase_orders)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'purchase_orders must be an array when supplied');
    return;
  }
  if (body.sales_orders !== undefined && !Array.isArray(body.sales_orders)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sales_orders must be an array when supplied');
    return;
  }
  const result = await runErpSync(body);
  sendJson(res, 200, result);
};

// ---------------------------------------------------------------------------
// Read-only enforcement (AC4): every write verb on the projection routes
// ---------------------------------------------------------------------------

export const erpReadOnlyRejectHandler: RouteHandler = async () => {
  throw new AppError(405, 'SOURCE_SYSTEM_READ_ONLY', 'ERP reference data is read-only on this platform; corrections are made in the ERP and arrive on the next sync');
};

export const getPurchaseOrderHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(getPurchaseOrderBase);
export const listSalesOrdersHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(listSalesOrdersBase);
export const erpSyncTriggerHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(erpSyncTriggerBase);

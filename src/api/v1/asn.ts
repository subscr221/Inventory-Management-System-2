import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getParsedBody } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import { getPurchaseOrderByRef } from '../../read/projections/erp_purchase_order.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import { upsertAsnHeader, upsertAsnLine, getAsnByNumber } from '../../read/projections/asn.js';

/**
 * Minimal ASN intake (Story 3.4, INT-SUP-02). A supplier/EDI direct-upsert of expected receiving
 * lines against an open Story 2.9 PO. This is reference data, NOT an event - it does not go through
 * persistEvent. The receiving flow (src/api/v1/receiving.ts / the PWA form) pre-populates from it.
 */

const ASN_WRITE_ROLES = ['store_assistant', 'svc_supplier_edi'];
const ASN_READ_ROLES = ['store_assistant', 'unloading_supervisor', 'warehouse_manager'];

function assertRoleAllowed(req: IncomingMessage, allowedRoles: string[], functionScope: 'read' | 'write'): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) => (r.module === 'receiving' || r.module === '*') && (functionScope === 'read' || r.functionScope === 'write') && allowedRoles.includes(r.role),
  );
  if (!ok) throw new AppError(403, 'FUNCTION_ACCESS_DENIED', `This operation is restricted to roles: ${allowedRoles.join(', ')}`);
}

function assertSiteAccess(req: IncomingMessage, siteId: string, scope: 'read' | 'write'): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const receivingScope = permittedLocationsForModuleScope(authContext.roles, 'receiving', scope);
  if (!receivingScope.wildcard && !receivingScope.locations.has(siteId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No ${scope} assignment grants access to site "${siteId}"`);
  }
}

interface AsnLineInput {
  line_no: number;
  sku: string;
  expected_qty: number | string;
  lot_number?: string | null;
  serial_number?: string | null;
  expiry_date?: string | null;
}

const NUMERIC_REGEX = /^\d+(\.\d+)?$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function validateLine(raw: unknown, index: number): AsnLineInput {
  if (typeof raw !== 'object' || raw === null) throw new AppError(400, 'INVALID_PARAMS', `lines[${index}] must be an object`);
  const l = raw as Record<string, unknown>;
  const lineNo = l['line_no'];
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0) throw new AppError(400, 'INVALID_PARAMS', `lines[${index}].line_no must be a positive integer`);
  if (typeof l['sku'] !== 'string' || l['sku'].trim().length === 0) throw new AppError(400, 'INVALID_PARAMS', `lines[${index}].sku is required`);
  const qty = l['expected_qty'];
  const qtyStr = typeof qty === 'number' ? String(qty) : typeof qty === 'string' ? qty.trim() : '';
  if (!NUMERIC_REGEX.test(qtyStr) || Number(qtyStr) <= 0) throw new AppError(400, 'INVALID_PARAMS', `lines[${index}].expected_qty must be a positive NUMERIC value`);
  const expiry = l['expiry_date'];
  if (expiry !== undefined && expiry !== null && (typeof expiry !== 'string' || !DATE_REGEX.test(expiry))) throw new AppError(400, 'INVALID_PARAMS', `lines[${index}].expiry_date must be YYYY-MM-DD when supplied`);
  return {
    line_no: lineNo,
    sku: (l['sku'] as string).trim(),
    expected_qty: qtyStr,
    lot_number: typeof l['lot_number'] === 'string' ? l['lot_number'] : null,
    serial_number: typeof l['serial_number'] === 'string' ? l['serial_number'] : null,
    expiry_date: typeof expiry === 'string' ? expiry : null,
  };
}

const createAsnBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, ASN_WRITE_ROLES, 'write');
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const asnNumberExt = typeof body['asn_number_ext'] === 'string' ? body['asn_number_ext'].trim() : '';
  if (!asnNumberExt) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asn_number_ext is required');
    return;
  }
  const poRef = typeof body['po_ref_ext'] === 'string' ? body['po_ref_ext'].trim() : '';
  if (!poRef) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'po_ref_ext is required');
    return;
  }
  const siteCode = typeof body['site_code_ext'] === 'string' ? body['site_code_ext'].trim() : '';
  if (!siteCode) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'site_code_ext is required to scope the ASN to a site');
    return;
  }
  const rawLines = Array.isArray(body['lines']) ? body['lines'] : [];
  if (rawLines.length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lines is required and must be a non-empty array');
    return;
  }
  const lines = rawLines.map((l, i) => validateLine(l, i));

  const po = await getPurchaseOrderByRef(poRef);
  if (!po) {
    sendRequestError(req, res, 404, 'ASN_PO_NOT_FOUND', `ASN references PO "${poRef}" which is not on the open-PO projection`);
    return;
  }
  const site = await getLocationByCode(siteCode);
  if (!site || site.status !== 'active' || site.level !== 'site') {
    sendRequestError(req, res, 404, 'RECEIVING_SITE_NOT_FOUND', `No active site exists for "${siteCode}"`);
    return;
  }
  assertSiteAccess(req, site.location_id, 'write');

  const existing = await getAsnByNumber(asnNumberExt);
  if (existing) {
    assertSiteAccess(req, existing.site_id, 'write');
    if (existing.site_id !== site.location_id) {
      sendRequestError(req, res, 409, 'ASN_SITE_MISMATCH', `ASN "${asnNumberExt}" is already bound to a different site and cannot be re-posted against "${siteCode}"`);
      return;
    }
  }

  const supplierRef = typeof body['supplier_ref_ext'] === 'string' && body['supplier_ref_ext'].trim().length > 0 ? body['supplier_ref_ext'].trim() : po.supplier_ref_ext;

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await upsertAsnHeader(
      {
        asn_number_ext: asnNumberExt,
        po_ref_ext: poRef,
        supplier_ref_ext: supplierRef,
        site_id: site.location_id,
        status: 'open',
        source_snapshot: body,
      },
      client,
    );
    for (const line of lines) {
      await upsertAsnLine({ asn_number_ext: asnNumberExt, ...line }, client);
    }
    await client.query('COMMIT');
    committed = true;
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const saved = await getAsnByNumber(asnNumberExt);
  sendJson(res, 201, saved!);
};

const getAsnBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, ASN_READ_ROLES, 'read');
  const asnNumberExt = params['asnNumberExt'];
  if (!asnNumberExt) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'asnNumberExt path parameter is required');
    return;
  }
  const asn = await getAsnByNumber(asnNumberExt);
  if (!asn) {
    sendRequestError(req, res, 404, 'ASN_NOT_FOUND', `No ASN exists for "${asnNumberExt}"`);
    return;
  }
  assertSiteAccess(req, asn.site_id, 'read');
  sendJson(res, 200, asn);
};

export const createAsnHandler: RouteHandler = requireRole({ module: 'receiving', functionScope: 'write' })(createAsnBase);
export const getAsnHandler: RouteHandler = requireRole({ module: 'receiving', functionScope: 'read' })(getAsnBase);

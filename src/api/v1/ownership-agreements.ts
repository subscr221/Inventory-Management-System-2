import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { getAgreementByGrain, listAgreements } from '../../read/projections/ownership_agreement.js';
import type { OwnershipAgreementRow } from '../../read/projections/ownership_agreement.js';
import { OWNERSHIP_CONFIG_ROLES, SUPPLIER_OWNED_STOCK_CLASSES } from '../../compliance/ownership.js';

/**
 * Ownership agreement admin API (Story 2.8). Agreements are the SKU-location-class registry that
 * anchors consignment/VMI receipts to an owner party and carries the VMI minimum. Writes flow
 * through persistEvent (ownership.agreement_set) so the registry row, the domain event, and the
 * audit entry commit atomically; the projection upsert itself lives in the ownership compliance
 * seam. Mirrors the Story 2.7 planning-params handler structure.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Story 2.8 agreement-config roles: same allowlist as the Story 2.7 planning config (recorded for
// the access-matrix sync - the matrix has no FR-I-10 row yet).
const OWNERSHIP_WRITE_ROLES = OWNERSHIP_CONFIG_ROLES;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  const eventLocationId = auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId;
  return { userId, role, auditLocationId, eventLocationId };
}

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'PUT',
    http_status: httpStatus,
  };
}

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

function assertWriteLocationAccess(req: IncomingMessage, locationId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const { wildcard, locations } = permittedLocationsForModuleScope(authContext.roles, 'inventory', 'write');
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(403, 'LOCATION_ACCESS_DENIED', `No write assignment grants access to location "${locationId}"`);
  }
}

function agreementToJson(row: OwnershipAgreementRow): Record<string, unknown> {
  return {
    agreement_id: row.agreement_id,
    sku: row.sku,
    location_id: row.location_id,
    stock_class: row.stock_class,
    owner_party_code: row.owner_party_code,
    vmi_min_qty: row.vmi_min_qty,
    active: row.active,
    business_stream: row.business_stream,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// PUT /api/v1/ownership-agreements/:sku/:locationId/:stockClass
// ---------------------------------------------------------------------------

const putAgreementBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  const locationId = params['locationId'];
  const stockClass = params['stockClass'];
  if (!sku || !SKU_REGEX.test(sku)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'sku path parameter must be 1-64 URL-safe characters');
    return;
  }
  if (!locationId || !UUID_REGEX.test(locationId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'locationId path parameter must be a UUID');
    return;
  }
  if (!stockClass || !SUPPLIER_OWNED_STOCK_CLASSES.has(stockClass)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "stockClass path parameter must be 'consignment' or 'vmi'");
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  if (!isNonEmptyString(body['business_stream'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'business_stream is required');
    return;
  }

  assertRoleAllowed(req, OWNERSHIP_WRITE_ROLES, 'write');
  assertWriteLocationAccess(req, locationId);

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Reuse the existing grain's agreement_id so config edits keep a stable identity (and the
    // ownership seam's partial-edit preservation applies). FOR UPDATE serializes concurrent edits.
    const existing = await getAgreementByGrain(sku, locationId, stockClass, client, true);
    const agreementId = existing?.agreement_id ?? randomUUID();
    // owner_party_code is required on create; optional (preserved) on edit. The seam's shape
    // assert enforces the code format, so only presence is decided here.
    const ownerPartyCode = typeof body['owner_party_code'] === 'string' ? body['owner_party_code'].trim() : body['owner_party_code'] ?? existing?.owner_party_code;
    if (ownerPartyCode === undefined) {
      throw new AppError(400, 'INVALID_PARAMS', 'owner_party_code is required when creating an ownership agreement');
    }
    const effectiveActive = body['active'] === undefined ? (existing?.active ?? true) : body['active'];
    const effectiveVmiMinQty = body['vmi_min_qty'] === undefined ? existing?.vmi_min_qty : body['vmi_min_qty'];
    if (stockClass === 'vmi' && effectiveActive !== false && (effectiveVmiMinQty === undefined || effectiveVmiMinQty === null)) {
      throw new AppError(400, 'VMI_MIN_NOT_CONFIGURED', 'vmi_min_qty is required for an active vmi ownership agreement', { sku, location_id: locationId });
    }

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: agreementId,
        event_type: 'ownership.agreement_set',
        payload: {
          agreement_id: agreementId,
          sku,
          location_id: locationId,
          stock_class: stockClass,
          owner_party_code: ownerPartyCode,
          ...(body['vmi_min_qty'] !== undefined ? { vmi_min_qty: body['vmi_min_qty'] } : {}),
          ...(body['active'] !== undefined ? { active: body['active'] } : {}),
          business_stream: body['business_stream'],
          set_by_actor_id: actor.userId,
        },
        metadata: {
          correlation_id: getTraceId(req) ?? randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, existing ? 200 : 201),
      client,
    );

    const saved = await getAgreementByGrain(sku, locationId, stockClass, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, existing ? 200 : 201, agreementToJson(saved!));
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/ownership-agreements
// ---------------------------------------------------------------------------

const listAgreementsBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, OWNERSHIP_WRITE_ROLES, 'read');
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const locationId = url.searchParams.get('location_id');
  const sku = url.searchParams.get('sku');
  const stockClass = url.searchParams.get('stock_class');
  const activeParam = url.searchParams.get('active');
  if (stockClass && !SUPPLIER_OWNED_STOCK_CLASSES.has(stockClass)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "stock_class filter must be 'consignment' or 'vmi'");
    return;
  }
  if (activeParam !== null && activeParam !== 'true' && activeParam !== 'false') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', "active filter must be 'true' or 'false'");
    return;
  }

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  let locationAny: string[] | null = null;
  if (!wildcard) {
    if (locationId && !locations.has(locationId)) {
      sendRequestError(req, res, 403, 'LOCATION_ACCESS_DENIED', 'No access to the specified location_id');
      return;
    }
    if (!locationId) locationAny = [...locations];
  }

  const rows = await listAgreements({
    location_id: locationId,
    location_any: locationAny,
    sku,
    stock_class: stockClass,
    active: activeParam === null ? null : activeParam === 'true',
  });
  sendJson(res, 200, { agreements: rows.map(agreementToJson) });
};

export const putOwnershipAgreementHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'write' })(putAgreementBase);
export const listOwnershipAgreementsHandler: RouteHandler = requireRole({ module: 'inventory', functionScope: 'read' })(listAgreementsBase);

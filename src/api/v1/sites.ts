import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';
import { GSTIN_REGEX } from '../../compliance/supplier.js';
import { isValidCalendarDate } from '../../lib/business-days.js';
import {
  insertSiteGstin,
  listSiteGstins,
  closeSiteGstin,
  siteExistsInLocationRegister,
} from '../../read/projections/site_gstin.js';

// ---------------------------------------------------------------------------
// Story 11.5 (Task 1.4): site GSTIN registration routes. A site's GSTIN is dated configuration
// (Binding Decision 2), written directly through the projection (the transaction_tagging_rules
// precedent: configuration, not a domain event) inside one transaction with its audit row.
//
// Code review E2-P (2026-09-09): registering a GSTIN is a CENTRAL, head-office act performed once
// per site from a registration certificate - site staff never see the document - so the write
// routes are gated on an EXPLICIT wildcard (`*`) assignment rather than on the caller's site.
// The explicitness is the point: no-check-by-accident and no-check-on-purpose are the same code
// with very different lifespans. One central POST reclassifies the tax position of two whole sites
// (a taxable inter-GSTIN movement silently becoming intra_gstin, with no tax invoice, no IRN and
// no e-way bill), so the ruling ships bundled with (a) an existence check on the site id, and
// (b) a close-window route, without which a wrong GSTIN is permanent - the DDL's gist EXCLUDE
// constraint refuses any overlapping correction.
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_GSTIN_ROLES = ['finance_controller', 'gst_officer'];

export interface GstConfigActor {
  userId: string;
  role: string;
  locationId: string;
}

/**
 * The GST-configuration function gate.
 *
 * `central: true` (every write route) additionally requires the satisfying assignment to carry the
 * wildcard location `*`. Privilege AND scope come from the SAME assignment, exactly as the
 * offcut-valuation and dispatch-IRN doors in src/api/v1/events.ts.
 *
 * Q19: a `write` assignment satisfies a `read` requirement (the middleware/rbac.ts
 * satisfiesFunctionScope rule). Without this a gst_officer provisioned with `inventory:write` only
 * could POST a configuration and then be refused 403 on the GET of the row they had just created.
 */
export function assertGstConfigRole(
  req: IncomingMessage,
  functionScope: 'read' | 'write',
  allowedRoles: string[] = SITE_GSTIN_ROLES,
  options: { central?: boolean } = {},
): GstConfigActor {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const candidates = authContext.roles.filter(
    (r) =>
      (r.module === 'inventory' || r.module === '*') &&
      (r.functionScope === functionScope ||
        (functionScope === 'read' && r.functionScope === 'write')) &&
      allowedRoles.includes(r.role),
  );
  if (candidates.length === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `This operation is restricted to roles: ${allowedRoles.join(', ')}`,
      { required_roles: allowedRoles },
    );
  }
  const match = options.central
    ? candidates.find((r) => r.locationId === '*')
    : (candidates[0] as (typeof candidates)[number] | undefined);
  if (!match) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'GST registration and valuation configuration are central acts: they require an all-sites (*) assignment, not a site-scoped one',
      { required_roles: allowedRoles, required_location_scope: '*' },
    );
  }
  return { userId: authContext.userId, role: match.role, locationId: match.locationId };
}

function siteIdParam(params: Record<string, string>): string {
  const raw = params['siteId'];
  if (typeof raw !== 'string' || !UUID_REGEX.test(raw)) {
    throw new AppError(400, 'INVALID_PARAMS', 'siteId must be a valid UUID');
  }
  return raw.toLowerCase();
}

function registrationIdParam(params: Record<string, string>): string {
  const raw = params['registrationId'];
  if (typeof raw !== 'string' || !UUID_REGEX.test(raw)) {
    throw new AppError(400, 'INVALID_PARAMS', 'registrationId must be a valid UUID');
  }
  return raw.toLowerCase();
}

/**
 * Q11: the length bound is applied to the TRIMMED value (a 200-character value with three leading
 * spaces used to be accepted at 203 and then either truncated or rejected by the column), and an
 * explicitly empty string resolves to null on a field documented as optional rather than being
 * refused.
 */
function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a string when supplied`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 200) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be at most 200 characters`);
  }
  return trimmed;
}

/**
 * Q11: the first two digits of a GSTIN ARE the state code, and that is what decides IGST versus
 * CGST + SGST. A state_code_ext that contradicts them is a mis-registration that would be read
 * back as authoritative, so it is refused rather than stored beside a GSTIN that disagrees.
 */
function assertStateCodeMatchesGstin(stateCode: string | null, gstin: string): string | null {
  if (stateCode === null) return null;
  const gstinStateCode = gstin.slice(0, 2);
  const normalised = /^[0-9]{1,2}$/.test(stateCode) ? stateCode.padStart(2, '0') : stateCode;
  if (normalised !== gstinStateCode) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `state_code_ext ${stateCode} contradicts the state code ${gstinStateCode} carried by the GSTIN`,
      { state_code_ext: stateCode, gstin_state_code: gstinStateCode },
    );
  }
  return normalised;
}

export function parseDateWindow(b: Record<string, unknown>): {
  effective_from: string;
  effective_to: string | null;
} {
  const from = b['effective_from'];
  if (typeof from !== 'string' || !isValidCalendarDate(from)) {
    throw new AppError(400, 'INVALID_PARAMS', 'effective_from is required (YYYY-MM-DD)');
  }
  const to = b['effective_to'];
  if (to !== undefined && to !== null) {
    if (typeof to !== 'string' || !isValidCalendarDate(to)) {
      throw new AppError(400, 'INVALID_PARAMS', 'effective_to must be YYYY-MM-DD or null');
    }
    if (to < from) {
      throw new AppError(400, 'INVALID_PARAMS', 'effective_to must not precede effective_from');
    }
  }
  return { effective_from: from, effective_to: (to as string | undefined) ?? null };
}

export function requireIdempotencyKey(b: Record<string, unknown>): string {
  // 8.7 D8 (#AD-16): a state-changing route requires a client-supplied idempotency key.
  const key = b['idempotency_key'] ?? b['idempotencyKey'];
  if (typeof key !== 'string' || !key.trim()) {
    throw new AppError(400, 'INVALID_PARAMS', 'idempotency_key is required', {
      field: 'idempotency_key',
    });
  }
  return key.trim();
}

/** The date a close route sets as the last day the window is effective. */
export function requireCloseDate(b: Record<string, unknown>): string {
  const to = b['effective_to'];
  if (typeof to !== 'string' || !isValidCalendarDate(to)) {
    throw new AppError(400, 'INVALID_PARAMS', 'effective_to is required (YYYY-MM-DD)', {
      field: 'effective_to',
    });
  }
  return to;
}

// ---------------------------------------------------------------------------
// Q7: idempotency-key resolution.
//
// The replay lookup used to key on the RAW `req.url` and to ignore both the request body and the
// actor, so (1) the same key with a DIFFERENT body returned the old row with `replayed: true` and
// the new registration was silently never made, (2) a trailing slash, a query string or an
// upper-case UUID in the path was a separate replay namespace and the retry inserted a second row,
// and (3) one key could create configurations for many GSTIN pairs.
//
// The lookup is now keyed on the NORMALISED pathname, scoped to the acting user, and compared
// against a canonical hash of the request body. `endpoint` stays a plain text equality predicate
// alongside `details->>'idempotency_key'`, so idx_audit_log_endpoint_idempotency_key still serves
// it.
// ---------------------------------------------------------------------------

/** The pathname with the query string dropped, trailing slashes stripped and case folded. */
export function auditEndpoint(req: IncomingMessage): string {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  } catch {
    pathname = req.url ?? '/';
  }
  const trimmed = pathname.replace(/\/+$/, '');
  return (trimmed === '' ? '/' : trimmed).toLowerCase();
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalise(source[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * A stable sha256 over the request body with object keys sorted, excluding the idempotency key
 * itself (it is the lookup, not part of what was asked for).
 */
export function canonicalRequestHash(b: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...b };
  delete rest['idempotency_key'];
  delete rest['idempotencyKey'];
  return createHash('sha256')
    .update(JSON.stringify(canonicalise(rest)))
    .digest('hex');
}

/**
 * The id this (endpoint, actor, key) already created, or null for a first attempt. A key re-used
 * with a different body is refused 409 IDEMPOTENCY_KEY_REUSED rather than answering with the row
 * the earlier body created.
 *
 * An audit row written before this patch carries no `request_hash`; it cannot be compared, so it is
 * accepted as a replay rather than being reported as a conflict.
 */
export async function findIdempotentReplay(
  client: PoolClient,
  args: {
    endpoint: string;
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    idField: string;
  },
): Promise<string | null> {
  const result = await client.query(
    `SELECT details->>$4::text AS resource_id, details->>'request_hash' AS request_hash
       FROM audit_log
      WHERE endpoint = $1 AND method = 'POST' AND error_code IS NULL
        AND details->>'idempotency_key' = $2
        AND user_id = $3::uuid
      ORDER BY created_at DESC
      LIMIT 1`,
    [args.endpoint, args.idempotencyKey, args.userId, args.idField],
  );
  const row = result.rows[0];
  if (!row) return null;
  const storedHash = row['request_hash'] as string | null;
  if (storedHash !== null && storedHash !== args.requestHash) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency_key was already used on this endpoint with a different request body',
      { idempotency_key: args.idempotencyKey, endpoint: args.endpoint },
    );
  }
  return (row['resource_id'] as string | null) ?? null;
}

/**
 * Q9: the gist EXCLUDE constraints (excl_site_gstin_window,
 * excl_branch_transfer_valuation_config_window) raise SQLSTATE 23P01. Two concurrent writers can
 * interleave past the projection's read-then-write pre-check, and the loser surfaced as a raw 500
 * instead of the overlap refusal these routes already define.
 */
export function mapWindowExclusionViolation(
  err: unknown,
  code: string,
  message: string,
  details: Record<string, unknown>,
): unknown {
  if (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === '23P01' &&
    !(err instanceof AppError)
  ) {
    return new AppError(409, code, message, details);
  }
  return err;
}

const postSiteGstinBase: RouteHandler = async (req, res, params) => {
  const actor = assertGstConfigRole(req, 'write', SITE_GSTIN_ROLES, { central: true });
  const siteId = siteIdParam(params);
  const b = (getParsedBody(req) ?? {}) as Record<string, unknown>;
  const idempotencyKey = requireIdempotencyKey(b);
  const requestHash = canonicalRequestHash(b);
  const endpoint = auditEndpoint(req);

  const gstin = b['gstin_ext'];
  if (typeof gstin !== 'string' || !GSTIN_REGEX.test(gstin.trim().toUpperCase())) {
    throw new AppError(400, 'INVALID_PARAMS', 'gstin_ext must be a valid 15-character GSTIN');
  }
  const gstinExt = gstin.trim().toUpperCase();
  const stateCode = assertStateCodeMatchesGstin(
    optionalText(b['state_code_ext'], 'state_code_ext'),
    gstinExt,
  );
  const window = parseDateWindow(b);

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    // Q10: site_gstin.site_id has no FK (there is no site table - a site "is" a level = 'site'
    // location_register row by convention), so a one-digit typo in the path used to return 201 and
    // create a permanently orphaned registration while the intended site kept failing
    // SITE_GSTIN_MISSING at transfer create with nothing pointing at the cause.
    if (!(await siteExistsInLocationRegister(siteId, client))) {
      throw new AppError(
        400,
        'SITE_NOT_FOUND',
        `No location_register row belongs to site ${siteId}; a GSTIN cannot be registered against it`,
        { site_id: siteId },
      );
    }
    const replayedId = await findIdempotentReplay(client, {
      endpoint,
      userId: actor.userId,
      idempotencyKey,
      requestHash,
      idField: 'registration_id',
    });
    if (replayedId) {
      const rows = await listSiteGstins(siteId, client);
      const existing = rows.find((r) => r.registration_id === replayedId);
      if (existing) {
        await client.query('COMMIT');
        committed = true;
        sendJson(res, 200, { registration: existing, replayed: true });
        return;
      }
    }
    const registration = await insertSiteGstin(
      {
        site_id: siteId,
        gstin_ext: gstinExt,
        legal_name_ext: optionalText(b['legal_name_ext'], 'legal_name_ext'),
        state_code_ext: stateCode,
        effective_from: window.effective_from,
        effective_to: window.effective_to,
        created_by: actor.userId,
      },
      client,
    );
    await logAuditEntry(client, {
      trace_id: getTraceId(req) ?? '',
      user_id: actor.userId,
      role: actor.role,
      location_id: actor.locationId,
      endpoint,
      method: 'POST',
      event_id: null,
      http_status: 201,
      error_code: null,
      details: {
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        registration_id: registration.registration_id,
        site_id: siteId,
        gstin_ext: registration.gstin_ext,
      },
    });
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 201, { registration });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw mapWindowExclusionViolation(
      err,
      'GSTIN_CONFIG_OVERLAP',
      `Site ${siteId} already has a GSTIN registration effective over part of this window`,
      { site_id: siteId },
    );
  } finally {
    client.release();
  }
};

/**
 * E2-P (b): closes an OPEN registration window by stamping `effective_to`.
 *
 * Only an open-ended (effective_to IS NULL) window may be closed, and only to a date on or after
 * its own effective_from. That is what makes closing safe: the resulting range is a strict subset
 * of the range that was already there, so it can neither overlap a sibling window (the gist
 * EXCLUDE constraint) nor invert. An already-closed window is refused rather than re-stamped - a
 * closed window is corrected by registering the next one, not by moving the old boundary.
 */
const closeSiteGstinBase: RouteHandler = async (req, res, params) => {
  const actor = assertGstConfigRole(req, 'write', SITE_GSTIN_ROLES, { central: true });
  const siteId = siteIdParam(params);
  const registrationId = registrationIdParam(params);
  const b = (getParsedBody(req) ?? {}) as Record<string, unknown>;
  const idempotencyKey = requireIdempotencyKey(b);
  const requestHash = canonicalRequestHash(b);
  const endpoint = auditEndpoint(req);
  const effectiveTo = requireCloseDate(b);

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const replayedId = await findIdempotentReplay(client, {
      endpoint,
      userId: actor.userId,
      idempotencyKey,
      requestHash,
      idField: 'registration_id',
    });
    if (replayedId === registrationId) {
      const rows = await listSiteGstins(siteId, client);
      const existing = rows.find((r) => r.registration_id === registrationId);
      if (existing) {
        await client.query('COMMIT');
        committed = true;
        sendJson(res, 200, { registration: existing, replayed: true });
        return;
      }
    }
    const registration = await closeSiteGstin(registrationId, siteId, effectiveTo, client);
    await logAuditEntry(client, {
      trace_id: getTraceId(req) ?? '',
      user_id: actor.userId,
      role: actor.role,
      location_id: actor.locationId,
      endpoint,
      method: 'POST',
      event_id: null,
      http_status: 200,
      error_code: null,
      details: {
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        registration_id: registration.registration_id,
        site_id: siteId,
        gstin_ext: registration.gstin_ext,
        effective_to: registration.effective_to,
      },
    });
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 200, { registration });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw mapWindowExclusionViolation(
      err,
      'GSTIN_CONFIG_OVERLAP',
      `Closing registration ${registrationId} would overlap another registration for site ${siteId}`,
      { site_id: siteId, registration_id: registrationId },
    );
  } finally {
    client.release();
  }
};

const getSiteGstinBase: RouteHandler = async (req, res, params) => {
  assertGstConfigRole(req, 'read');
  const siteId = siteIdParam(params);
  const registrations = await listSiteGstins(siteId);
  sendJson(res, 200, { site_id: siteId, registrations });
};

export const postSiteGstinHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(postSiteGstinBase);

export const closeSiteGstinHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(closeSiteGstinBase);

export const getSiteGstinHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(getSiteGstinBase);

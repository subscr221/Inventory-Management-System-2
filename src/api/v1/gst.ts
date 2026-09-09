import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import { getParsedBody, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { getPool } from '../../config/db.js';
import { logAuditEntry } from '../../read/projections/audit_log.js';
import { GSTIN_REGEX } from '../../compliance/supplier.js';
import { isPositiveDecimal } from '../../compliance/transfer-request.js';
import {
  insertValuationConfig,
  listValuationConfigs,
  findValuationConfigById,
  closeValuationConfig,
  isRule28Basis,
} from '../../read/projections/branch_transfer_valuation_config.js';
import {
  assertGstConfigRole,
  auditEndpoint,
  canonicalRequestHash,
  findIdempotentReplay,
  mapWindowExclusionViolation,
  parseDateWindow,
  requireCloseDate,
  requireIdempotencyKey,
} from './sites.js';

// ---------------------------------------------------------------------------
// Story 11.5 (Task 2.3): per-GSTIN-pair branch transfer valuation configuration routes. Dated
// configuration written directly through the projection inside one transaction with its audit
// row (the site_gstin route is the sibling). Roles: finance_controller or gst_officer.
//
// Code review E2-P (2026-09-09): configuring a GSTIN pair, like registering a GSTIN, is a CENTRAL
// head-office act - it decides the taxable value of every future movement on that pair - so the
// write routes require an EXPLICIT wildcard (`*`) assignment, and a window that was set wrong is
// corrected by closing it through the close route below (the gist EXCLUDE constraint refuses any
// overlapping correction).
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gstinField(b: Record<string, unknown>, field: string): string {
  const value = b[field];
  if (typeof value !== 'string' || !GSTIN_REGEX.test(value.trim().toUpperCase())) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a valid 15-character GSTIN`);
  }
  return value.trim().toUpperCase();
}

/**
 * Q13: a GSTIN query parameter is trimmed BEFORE it is upper-cased, exactly as the POST path
 * normalises it. Without the trim a GSTIN that registered successfully was refused on the GET
 * whenever the client left a trailing space.
 */
function gstinQueryParam(raw: string, field: string): string {
  const normalised = raw.trim().toUpperCase();
  if (!GSTIN_REGEX.test(normalised)) {
    throw new AppError(400, 'INVALID_PARAMS', `${field} must be a valid GSTIN`);
  }
  return normalised;
}

function configIdParam(params: Record<string, string>): string {
  const raw = params['configId'];
  if (typeof raw !== 'string' || !UUID_REGEX.test(raw)) {
    throw new AppError(400, 'INVALID_PARAMS', 'configId must be a valid UUID');
  }
  return raw.toLowerCase();
}

/**
 * Q12: cost_plus_percent normalises IDENTICALLY whether the JSON carried a number or a numeric
 * string. A string used to be passed through with only `.trim()`, so "110.1234567" either rounded
 * silently at the NUMERIC(7,3) column or raised a raw 22003; and the bound was checked on the
 * value as supplied, so 9999.9996 passed the `> 9999` test and then overflowed the column once
 * rounded. Both branches now round to the column's scale FIRST and the bounds are checked on the
 * rounded value.
 */
function parseCostPlusPercent(raw: unknown): string {
  const refuse = (): never => {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'cost_plus_percent must be a number between 100 and 9999 inclusive (the Rule 30 cost-plus percentage), with at most 3 decimal places of precision retained',
    );
  };
  if (!isPositiveDecimal(raw)) return refuse();
  const rounded = Number(raw).toFixed(3);
  const value = Number(rounded);
  if (!Number.isFinite(value) || value < 100 || value > 9999) return refuse();
  return rounded;
}

const postValuationConfigBase: RouteHandler = async (req, res, _params) => {
  const actor = assertGstConfigRole(req, 'write', undefined, { central: true });
  const b = (getParsedBody(req) ?? {}) as Record<string, unknown>;
  const idempotencyKey = requireIdempotencyKey(b);
  const requestHash = canonicalRequestHash(b);
  const endpoint = auditEndpoint(req);

  const fromGstin = gstinField(b, 'from_gstin_ext');
  const toGstin = gstinField(b, 'to_gstin_ext');
  if (fromGstin === toGstin) {
    throw new AppError(400, 'INVALID_PARAMS', 'from_gstin_ext and to_gstin_ext must differ');
  }
  const basis = b['default_basis'];
  if (!isRule28Basis(basis)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'default_basis must be one of open_market_value, like_kind_quality, cost_plus, invoice_value_full_itc',
    );
  }
  const eligible = b['recipient_full_itc_eligible'] ?? false;
  if (typeof eligible !== 'boolean') {
    throw new AppError(400, 'INVALID_PARAMS', 'recipient_full_itc_eligible must be a boolean');
  }
  if (basis === 'invoice_value_full_itc' && !eligible) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'a default of invoice_value_full_itc requires recipient_full_itc_eligible to be true',
    );
  }
  const costPlusPercent = parseCostPlusPercent(b['cost_plus_percent'] ?? 110);
  const window = parseDateWindow(b);

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
      idField: 'config_id',
    });
    if (replayedId) {
      const rows = await listValuationConfigs(
        { from_gstin_ext: fromGstin, to_gstin_ext: toGstin },
        client,
      );
      const existing = rows.find((r) => r.config_id === replayedId);
      if (existing) {
        await client.query('COMMIT');
        committed = true;
        sendJson(res, 200, { config: existing, replayed: true });
        return;
      }
    }
    const valuationConfig = await insertValuationConfig(
      {
        from_gstin_ext: fromGstin,
        to_gstin_ext: toGstin,
        default_basis: basis,
        recipient_full_itc_eligible: eligible,
        cost_plus_percent: costPlusPercent,
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
        config_id: valuationConfig.config_id,
        from_gstin_ext: fromGstin,
        to_gstin_ext: toGstin,
        default_basis: basis,
      },
    });
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 201, { config: valuationConfig });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw mapWindowExclusionViolation(
      err,
      'VALUATION_CONFIG_OVERLAP',
      `A valuation configuration for ${fromGstin} to ${toGstin} already covers part of this window`,
      { from_gstin_ext: fromGstin, to_gstin_ext: toGstin },
    );
  } finally {
    client.release();
  }
};

/**
 * E2-P (b): closes an OPEN configuration window by stamping `effective_to`. Only an open-ended
 * window may be closed, and only to a date on or after its own effective_from, so the resulting
 * range is a strict subset of the committed one and can neither overlap a sibling window nor
 * invert. Central act, same explicit-wildcard gate, idempotency_key required like its siblings.
 */
const closeValuationConfigBase: RouteHandler = async (req, res, params) => {
  const actor = assertGstConfigRole(req, 'write', undefined, { central: true });
  const configId = configIdParam(params);
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
      idField: 'config_id',
    });
    if (replayedId === configId) {
      const existing = await findValuationConfigById(configId, client);
      if (existing) {
        await client.query('COMMIT');
        committed = true;
        sendJson(res, 200, { config: existing, replayed: true });
        return;
      }
    }
    const valuationConfig = await closeValuationConfig(configId, effectiveTo, client);
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
        config_id: valuationConfig.config_id,
        from_gstin_ext: valuationConfig.from_gstin_ext,
        to_gstin_ext: valuationConfig.to_gstin_ext,
        effective_to: valuationConfig.effective_to,
      },
    });
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 200, { config: valuationConfig });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw mapWindowExclusionViolation(
      err,
      'VALUATION_CONFIG_OVERLAP',
      `Closing valuation configuration ${configId} would overlap another window for the same pair`,
      { config_id: configId },
    );
  } finally {
    client.release();
  }
};

const getValuationConfigBase: RouteHandler = async (req, res, _params) => {
  assertGstConfigRole(req, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const filter: { from_gstin_ext?: string; to_gstin_ext?: string } = {};
  const from = url.searchParams.get('from_gstin_ext');
  const to = url.searchParams.get('to_gstin_ext');
  if (from !== null) filter.from_gstin_ext = gstinQueryParam(from, 'from_gstin_ext');
  if (to !== null) filter.to_gstin_ext = gstinQueryParam(to, 'to_gstin_ext');
  const configs = await listValuationConfigs(filter);
  sendJson(res, 200, { configs });
};

export const postValuationConfigHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(postValuationConfigBase);

export const closeValuationConfigHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(closeValuationConfigBase);

export const getValuationConfigHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(getValuationConfigBase);

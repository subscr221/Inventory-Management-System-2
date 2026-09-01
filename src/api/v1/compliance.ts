import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent, findEventByIdempotencyKey } from '../../events/store.js';
import { actorContext, auditCtxFor, auditRejectedAttempt, replayIdOrReject } from './quality.js';
import {
  BIS_LICENCE_RECORDED,
  BIS_LICENCE_UPDATED,
  LABEL_VERSION_DRAFTED,
  LABEL_VERSION_APPROVED,
  LABEL_MASTER_APPROVAL_DOA_TYPE,
  isUuid,
  isIsoDate,
  requireItemExists,
  requireLocationExists,
  requireNoOverlap,
  resolveComplianceAuthority,
} from '../../compliance/master-data.js';
import {
  BIS_LICENCE_TYPES,
  getBisLicenceById,
  listBisLicences,
} from '../../read/projections/compliance_bis_licence.js';
import { getLabelMasterById, listLabelMasters } from '../../read/projections/label_master.js';

/**
 * Story 8.7 REST surface for the BIS licence register and Legal Metrology label masters
 * (FR-Q-11, FR-Q-14). Module `compliance` on every route. Handler pattern is the quality.ts
 * idiom verbatim (BSD-7): shape checks that make a 400 cheap, a DOA pre-check that turns an
 * unauthorized label approval into an audited 403 before persistEvent, then persistEvent - the
 * seam in src/compliance/master-data.ts re-derives every guard under lock (AD-12).
 *
 * Scope decision (Story 8.7 code review): the BIS licence register and the label masters are
 * ENTERPRISE-WIDE compliance master data, not site-tenanted. Every route is guarded by module
 * `compliance` alone and deliberately passes no `locationId` resolver, so a compliance-scoped user
 * reads and writes the whole register regardless of their assigned site. A licence's `site_id` is
 * the SCOPE OF THE LICENCE (which site it covers, NULL = all sites), never an access-control
 * boundary. If the register ever becomes multi-tenant, every route here needs a location resolver
 * and the list routes need a permitted-locations filter.
 */

const AUDITED_REJECTIONS = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_UNRESOLVED',
  'ITEM_NOT_FOUND',
  'LOCATION_NOT_FOUND',
  'BIS_LICENCE_OVERLAP',
  'BIS_LICENCE_EXISTS',
  'BIS_LICENCE_NOT_FOUND',
  'LABEL_VERSION_EXISTS',
  'LABEL_VERSION_NOT_DRAFT',
  'LABEL_MASTER_NOT_FOUND',
  'COMPLIANCE_DERIVATION_MISMATCH',
  // Story 8.7 code review: every applier-raised refusal on these routes belongs here, or a
  // refused statutory decision leaves no audit row (the 8.3 NCR_EXISTS omission lesson).
  'LABEL_APPROVAL_SOD_VIOLATION',
  'LABEL_VERSION_APPROVAL_CONFLICT',
  'APPROVAL_AUTHORITY_MISMATCH',
  'BIS_LICENCE_STAGE_NOT_DUE',
  'DUPLICATE_EVENT',
  'INVALID_PARAMS',
]);

/** Audits a rejection, but never lets an audit failure displace the original AppError. */
async function auditFailSafe(...args: Parameters<typeof auditRejectedAttempt>): Promise<void> {
  try {
    await auditRejectedAttempt(...args);
  } catch (auditErr) {
    console.error('compliance: audit of a rejected attempt failed:', auditErr);
  }
}

function sendAppError(req: IncomingMessage, res: Parameters<RouteHandler>[1], err: unknown): void {
  if (err instanceof AppError) {
    sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
    return;
  }
  throw err;
}

function requireBody(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
): Record<string, unknown> | null {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return null;
  }
  return body;
}

/**
 * Story 8.7 code review (D8): state-changing routes REQUIRE a client-supplied idempotency key.
 * Auto-minting one per request is not idempotency - a dropped response followed by a retry would
 * mint a second key and write a second licence, so the route would manufacture the duplicate it
 * claims to prevent.
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = body['idempotency_key'];
  if (typeof key !== 'string' || key.trim() === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'idempotency_key is required', {
      field: 'idempotency_key',
    });
  }
  return key.trim();
}

/** Rejects fields the route does not accept, so a silently-ignored field never returns 200. */
function rejectUnacceptedFields(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (body[field] !== undefined) {
      throw new AppError(400, 'INVALID_PARAMS', `${field} is not accepted on this route`, {
        field,
      });
    }
  }
}

/** A bounded, trimmed sku filter; a blank ?sku= is a client error, never a silent full scan. */
function optionalSkuFilter(url: URL): string | undefined {
  const raw = url.searchParams.get('sku');
  if (raw === null) return undefined;
  const sku = raw.trim();
  if (sku === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'sku must not be blank', { field: 'sku' });
  }
  if (sku.length > 64) {
    throw new AppError(400, 'INVALID_PARAMS', 'sku is too long', { field: 'sku' });
  }
  return sku;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/** Bounded pagination - an unpaginated register read grows without limit. */
function pagination(url: URL): { limit: number; offset: number } {
  const parse = (name: string, fallback: number, max: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new AppError(400, 'INVALID_PARAMS', `${name} must be an integer between 0 and ${max}`, {
        field: name,
      });
    }
    return value;
  };
  return {
    limit: Math.max(1, parse('limit', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)),
    offset: parse('offset', 0, Number.MAX_SAFE_INTEGER),
  };
}

function requireUuidParam(params: Record<string, string> | undefined, name: string): string {
  const value = params?.[name];
  if (!value || !isUuid(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a UUID`, { [name]: value ?? null });
  }
  return value;
}

// ---------------------------------------------------------------------------
// BIS licence register (AC 1, AC 2)
// ---------------------------------------------------------------------------

const createBisLicenceBase: RouteHandler = async (req, res, _params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    rejectUnacceptedFields(body, ['licence_id', 'status']);
    const idempotencyKey = requireIdempotencyKey(body);
    if (typeof body['licence_number'] !== 'string' || body['licence_number'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'licence_number is required');
    }
    if (!(BIS_LICENCE_TYPES as readonly string[]).includes(body['licence_type'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'licence_type must be cml or r_number');
    }
    if (typeof body['sku'] !== 'string' || body['sku'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
    }
    const siteId = (body['site_id'] as string | null | undefined) ?? null;
    if (siteId !== null && !isUuid(siteId)) {
      throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID or null');
    }
    if (!isIsoDate(body['valid_from'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'valid_from must be a valid ISO date');
    }
    if (!isIsoDate(body['valid_to'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'valid_to must be a valid ISO date');
    }
    if ((body['valid_to'] as string) < (body['valid_from'] as string)) {
      throw new AppError(400, 'INVALID_PARAMS', 'valid_to must be on or after valid_from');
    }

    // A retry of a SUCCESSFUL create must replay, not trip the very overlap the first call
    // created. persistEvent is the idempotency authority; these pre-checks only make a genuine
    // first-time rejection cheap, so they stand down once the key has already produced an event.
    const isRetry = (await findEventByIdempotencyKey(idempotencyKey)) !== null;
    if (!isRetry) {
      await requireItemExists(body['sku'] as string);
      await requireLocationExists(siteId);
      await requireNoOverlap(
        body['sku'] as string,
        siteId,
        body['valid_from'] as string,
        body['valid_to'] as string,
        null,
      );
    }

    const licenceId = randomUUID();
    const persisted = await persistEvent(
      {
        stream_type: 'compliance',
        stream_id: licenceId,
        event_type: BIS_LICENCE_RECORDED,
        payload: {
          licence_id: licenceId,
          licence_number: (body['licence_number'] as string).trim(),
          licence_type: body['licence_type'],
          sku: body['sku'],
          site_id: siteId,
          valid_from: body['valid_from'],
          valid_to: body['valid_to'],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    const persistedId = replayIdOrReject(persisted, BIS_LICENCE_RECORDED, 'licence_id');
    const licence = await getBisLicenceById(persistedId);
    // A replay is not a creation: 200 with the same event_id, the house idiom (BSD-7).
    sendJson(res, persistedId === licenceId ? 201 : 200, {
      event_id: persisted.event_id,
      licence,
    });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      // A failing audit write must never replace the contracted error with a 500.
      await auditFailSafe(req, actor, err, {
        sku: typeof body['sku'] === 'string' ? body['sku'].slice(0, 64) : null,
      });
    }
    sendAppError(req, res, err);
  }
};

const listBisLicencesBase: RouteHandler = async (req, res, _params) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { limit, offset } = pagination(url);
    const licences = await listBisLicences(optionalSkuFilter(url), limit, offset);
    sendJson(res, 200, { licences, limit, offset });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getBisLicenceBase: RouteHandler = async (req, res, params) => {
  try {
    const licenceId = requireUuidParam(params, 'licenceId');
    const licence = await getBisLicenceById(licenceId);
    if (!licence) {
      throw new AppError(404, 'BIS_LICENCE_NOT_FOUND', 'No licence found for this id', {
        licence_id: licenceId,
      });
    }
    sendJson(res, 200, { licence });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const updateBisLicenceBase: RouteHandler = async (req, res, params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let licenceId = '';
  try {
    licenceId = requireUuidParam(params, 'licenceId');
    // BSD-3: the register identity (number, type, sku, site) is immutable - PATCH carries the
    // window only. Silently dropping these and returning 200 would tell the caller their rename
    // succeeded. The applier's rejectDeclaredDerived guard is unreachable from here because the
    // route never forwards them, so the route owns the 400.
    const idempotencyKey = requireIdempotencyKey(body);
    for (const field of [
      'licence_id',
      'licence_number',
      'licence_type',
      'sku',
      'site_id',
      'status',
    ]) {
      if (body[field] !== undefined) {
        throw new AppError(400, 'INVALID_PARAMS', `${field} is immutable and cannot be patched`, {
          field,
        });
      }
    }
    if (body['valid_from'] === undefined && body['valid_to'] === undefined) {
      throw new AppError(400, 'INVALID_PARAMS', 'At least one of valid_from/valid_to is required');
    }
    if (body['valid_from'] !== undefined && !isIsoDate(body['valid_from'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'valid_from must be a valid ISO date');
    }
    if (body['valid_to'] !== undefined && !isIsoDate(body['valid_to'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'valid_to must be a valid ISO date');
    }
    const existing = await getBisLicenceById(licenceId);
    if (!existing) {
      throw new AppError(404, 'BIS_LICENCE_NOT_FOUND', 'No licence found for this id', {
        licence_id: licenceId,
      });
    }
    const validFrom = (body['valid_from'] as string | undefined) ?? existing.valid_from;
    const validTo = (body['valid_to'] as string | undefined) ?? existing.valid_to;
    if (validTo < validFrom) {
      throw new AppError(400, 'INVALID_PARAMS', 'valid_to must be on or after valid_from');
    }
    await requireNoOverlap(existing.sku, existing.site_id, validFrom, validTo, licenceId);

    const persisted = await persistEvent(
      {
        stream_type: 'compliance',
        stream_id: licenceId,
        event_type: BIS_LICENCE_UPDATED,
        payload: {
          licence_id: licenceId,
          valid_from: body['valid_from'],
          valid_to: body['valid_to'],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );
    const persistedId = replayIdOrReject(persisted, BIS_LICENCE_UPDATED, 'licence_id');
    const licence = await getBisLicenceById(persistedId);
    sendJson(res, 200, { event_id: persisted.event_id, licence });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      // A failing audit write must never replace the contracted error with a 500.
      await auditFailSafe(req, actor, err, { licence_id: licenceId });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// Legal Metrology label masters (AC 3, AC 4)
// ---------------------------------------------------------------------------

const draftLabelMasterBase: RouteHandler = async (req, res, _params) => {
  const body = requireBody(req, res);
  if (!body) return;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  try {
    rejectUnacceptedFields(body, ['label_id', 'status', 'approved_by', 'approved_at']);
    const idempotencyKey = requireIdempotencyKey(body);
    if (typeof body['sku'] !== 'string' || body['sku'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'sku is required');
    }
    if (typeof body['label_version'] !== 'string' || body['label_version'].trim() === '') {
      throw new AppError(400, 'INVALID_PARAMS', 'label_version is required');
    }
    await requireItemExists(body['sku'] as string);

    const labelId = randomUUID();
    const persisted = await persistEvent(
      {
        stream_type: 'compliance',
        stream_id: labelId,
        event_type: LABEL_VERSION_DRAFTED,
        payload: {
          label_id: labelId,
          sku: body['sku'],
          label_version: (body['label_version'] as string).trim(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );
    const persistedId = replayIdOrReject(persisted, LABEL_VERSION_DRAFTED, 'label_id');
    const label = await getLabelMasterById(persistedId);
    sendJson(res, persistedId === labelId ? 201 : 200, { event_id: persisted.event_id, label });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      // A failing audit write must never replace the contracted error with a 500.
      await auditFailSafe(req, actor, err, {
        sku: typeof body['sku'] === 'string' ? body['sku'].slice(0, 64) : null,
      });
    }
    sendAppError(req, res, err);
  }
};

const listLabelMastersBase: RouteHandler = async (req, res, _params) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { limit, offset } = pagination(url);
    const labels = await listLabelMasters(optionalSkuFilter(url), limit, offset);
    sendJson(res, 200, { labels, limit, offset });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getLabelMasterBase: RouteHandler = async (req, res, params) => {
  try {
    const labelId = requireUuidParam(params, 'labelId');
    const label = await getLabelMasterById(labelId);
    if (!label) {
      throw new AppError(404, 'LABEL_MASTER_NOT_FOUND', 'No label found for this id', {
        label_id: labelId,
      });
    }
    sendJson(res, 200, { label });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const approveLabelMasterBase: RouteHandler = async (req, res, params) => {
  // An array or scalar body must not be read as a field bag - index '0' is not an idempotency key.
  const rawBody = getParsedBody(req);
  const body: Record<string, unknown> =
    rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>)
      : {};
  const actor = actorContext(req);
  const now = new Date().toISOString();
  let labelId = '';
  try {
    labelId = requireUuidParam(params, 'labelId');
    rejectUnacceptedFields(body, [
      'label_id',
      'approved_by',
      'doa_entry_id',
      'governing_role',
      'delegation_applied',
      'status',
    ]);
    const idempotencyKey = requireIdempotencyKey(body);

    // Existence first: a nonexistent label is a 404, not a 403 about approval authority.
    const existing = await getLabelMasterById(labelId);
    if (!existing) {
      throw new AppError(404, 'LABEL_MASTER_NOT_FOUND', 'No label found for this id', {
        label_id: labelId,
      });
    }

    // DOA pre-check (BSD-4, AC 4): the 403 is a business rule raised AFTER the RBAC wrapper. The
    // seam re-derives the same authority under lock; this pre-check makes the audited rejection
    // cheap. It can only produce a FALSE POSITIVE the seam would not raise (a delegation
    // activating between this read and the transaction), never a false negative - the
    // in-transaction check is the authority.
    const authority = await resolveComplianceAuthority(LABEL_MASTER_APPROVAL_DOA_TYPE);
    if (authority.approver_user_id !== actor.userId) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Approving a label version requires the resolved DOA approver',
        {
          label_id: labelId,
          resolved_approver_user_id: authority.approver_user_id,
          governing_role: authority.governing_role,
        },
      );
    }

    const persisted = await persistEvent(
      {
        stream_type: 'compliance',
        stream_id: labelId,
        event_type: LABEL_VERSION_APPROVED,
        // BSD-4: the payload carries the SERVER-resolved approver fields so a replay is
        // deterministic after the DOA registry drifts. The applier re-derives them and refuses a
        // mismatch on first apply (AD-12), but a rebuild reads the captured values.
        payload: {
          label_id: labelId,
          approved_by: authority.approver_user_id,
          doa_entry_id: authority.doa_entry_id,
          governing_role: authority.governing_role,
          delegation_applied: authority.delegation_applied,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
        idempotency_key: idempotencyKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 200),
    );
    const persistedId = replayIdOrReject(persisted, LABEL_VERSION_APPROVED, 'label_id');
    const label = await getLabelMasterById(persistedId);
    sendJson(res, 200, { event_id: persisted.event_id, label });
  } catch (err: unknown) {
    if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
      // A failing audit write must never replace the contracted error with a 500.
      await auditFailSafe(req, actor, err, { label_id: labelId });
    }
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// RBAC-wrapped exports (server.ts registration surface)
// ---------------------------------------------------------------------------

export const createBisLicenceHandler = requireRole({
  module: 'compliance',
  functionScope: 'write',
})(createBisLicenceBase);
export const listBisLicencesHandler = requireRole({ module: 'compliance', functionScope: 'read' })(
  listBisLicencesBase,
);
export const getBisLicenceHandler = requireRole({ module: 'compliance', functionScope: 'read' })(
  getBisLicenceBase,
);
export const updateBisLicenceHandler = requireRole({
  module: 'compliance',
  functionScope: 'write',
})(updateBisLicenceBase);
export const draftLabelMasterHandler = requireRole({
  module: 'compliance',
  functionScope: 'write',
})(draftLabelMasterBase);
export const listLabelMastersHandler = requireRole({ module: 'compliance', functionScope: 'read' })(
  listLabelMastersBase,
);
export const getLabelMasterHandler = requireRole({ module: 'compliance', functionScope: 'read' })(
  getLabelMasterBase,
);
export const approveLabelMasterHandler = requireRole({
  module: 'compliance',
  functionScope: 'write',
})(approveLabelMasterBase);

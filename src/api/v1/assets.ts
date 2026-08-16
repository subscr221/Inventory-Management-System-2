import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getAssetById, listAssets } from '../../read/projections/asset.js';

/**
 * Story 7.1 REST surface: the company-wide maintainable asset register (FR-M-01, AD-9).
 * Duplicate detection lives in src/compliance/asset.ts, not here, so a direct
 * POST /api/v1/events cannot bypass it; these handlers own only the capture-time resolutions
 * (server-minted asset_id, actor stamping) and the response shape.
 *
 * The asset register is enterprise-scoped (AD-9: one register for everything), so no handler
 * applies a site filter.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const CRITICALITY_CLASSES = new Set(['critical', 'high', 'medium', 'low']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
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

function auditCtxFor(
  req: IncomingMessage,
  actor: ActorContext,
  httpStatus: number,
): Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'> {
  return {
    trace_id: getTraceId(req) ?? '',
    user_id: actor.userId,
    role: actor.role,
    location_id: actor.auditLocationId,
    endpoint: req.url ?? '',
    method: req.method ?? 'POST',
    http_status: httpStatus,
  };
}

function sendAppError(req: IncomingMessage, res: Parameters<RouteHandler>[1], err: unknown): void {
  if (err instanceof AppError) {
    sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
    return;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// POST /api/v1/assets
// ---------------------------------------------------------------------------

const createAssetBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const assetId = randomUUID();
  const now = new Date().toISOString();

  // Nullable capture fields are normalized exactly as the seam stores them (trimmed; whitespace-
  // only collapses to NULL) so the persisted event payload and the asset row never disagree on
  // serialization. fixed_asset_ref stays verbatim when non-empty per AC 2.
  const normalizeNullableString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

  try {
    const persisted = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'asset.registered',
        payload: {
          asset_id: assetId,
          asset_tag: body.asset_tag,
          asset_name: body.asset_name,
          criticality_class: body.criticality_class,
          serial_number: normalizeNullableString(body.serial_number),
          manufacturer: normalizeNullableString(body.manufacturer),
          model: normalizeNullableString(body.model),
          // AC 2: stored verbatim as a free identifier - no lookup is performed.
          fixed_asset_ref:
            typeof body.fixed_asset_ref === 'string' && body.fixed_asset_ref.trim() !== ''
              ? body.fixed_asset_ref
              : null,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: now,
        },
        // A blank or non-string idempotency key is "not supplied": passing '' through would make
        // two genuinely different registrations collide on the uq_idempotency row and collapse
        // into one replay of the first.
        idempotency_key:
          typeof body.idempotency_key === 'string' && body.idempotency_key.trim() !== ''
            ? body.idempotency_key
            : randomUUID(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      auditCtxFor(req, actor, 201),
    );

    // persistEvent returns ANY event already holding this idempotency key, regardless of stream
    // or event type. A legitimate replay is the same asset.registered event; anything else means
    // the client reused a key from a different write - surface a 409 instead of a phantom 201
    // built from a foreign event's payload.
    const persistedAssetId = (persisted.payload as { asset_id?: unknown } | undefined)?.asset_id;
    if (
      persisted.event_type !== 'asset.registered' ||
      typeof persistedAssetId !== 'string' ||
      !isUuid(persistedAssetId)
    ) {
      throw new AppError(
        409,
        'DUPLICATE_EVENT',
        'This idempotency key is already in use by a different event',
        {
          existing_event_id: persisted.event_id,
          existing_event_type: persisted.event_type,
        },
      );
    }

    // On an idempotent replay persistEvent returns the ORIGINAL event, whose asset_id is not the
    // one just minted - read back through the persisted payload so the response is the original
    // registration, never a phantom one (Story 5.2 phantom-success lesson).
    const asset = await getAssetById(persistedAssetId);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      asset: asset ?? null,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/assets/:assetId
// ---------------------------------------------------------------------------

const getAssetBase: RouteHandler = async (req, res, params) => {
  const assetId = params?.['assetId'];
  if (!assetId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'assetId is required');
    return;
  }

  const asset = await getAssetById(assetId);
  if (!asset) {
    sendRequestError(req, res, 404, 'ASSET_NOT_FOUND', 'Asset not found', {
      asset_id: assetId,
    });
    return;
  }

  sendJson(res, 200, { asset });
};

// ---------------------------------------------------------------------------
// GET /api/v1/assets
// ---------------------------------------------------------------------------

const listAssetsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const criticalityParam = url.searchParams.get('criticality_class');
  const search = url.searchParams.get('search');
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');

  let criticalityClass: 'critical' | 'high' | 'medium' | 'low' | undefined;
  if (criticalityParam) {
    if (!CRITICALITY_CLASSES.has(criticalityParam)) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        'criticality_class must be one of: critical, high, medium, low',
        { criticality_class: criticalityParam },
      );
      return;
    }
    criticalityClass = criticalityParam as 'critical' | 'high' | 'medium' | 'low';
  }

  const assets = await listAssets({
    criticality_class: criticalityClass,
    search: search ?? undefined,
    limit: limitRaw === null ? undefined : Number(limitRaw),
    offset: offsetRaw === null ? undefined : Math.min(Number(offsetRaw), Number.MAX_SAFE_INTEGER),
  });

  sendJson(res, 200, { assets });
};

export const createAssetHandler = requireRole({
  module: 'maintenance',
  functionScope: 'write',
})(createAssetBase);

export const getAssetHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(getAssetBase);

export const listAssetsHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(listAssetsBase);

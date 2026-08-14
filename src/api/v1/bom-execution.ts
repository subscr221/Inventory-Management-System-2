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
import { persistEvent, type PersistedEvent } from '../../events/store.js';
import { getPool } from '../../config/db.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getBomById, getBomLineById } from '../../read/projections/bom.js';
import { getItemById } from '../../read/projections/item_master.js';
import {
  getAlternatesByBom,
  getAlternatesByBomLine,
} from '../../read/projections/bom_alternate.js';
import { getExplosionById, getExplosionLines } from '../../read/projections/bom_explosion.js';
import { explodeBomForExecution } from '../../engineering/bom-explosion.js';
import { resolveApprover } from './indents.js';

/**
 * Story 5.5 REST surface: approved alternates, DOA-gated ad-hoc substitutions, and the explosion
 * run (FR-B-12, FR-B-07). Every state gate lives in src/compliance/bom-execution.ts, not here, so
 * a direct POST /api/v1/events cannot bypass it; these handlers own only the capture-time
 * resolutions (server-side ids, DOA approver, the explosion walk) and the response shape.
 *
 * BOM is enterprise-scoped (Story 5.4 binding decision), so no handler applies a site filter.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The DOA transaction_type governing ad-hoc substitution approval (AD-3). Exported so tests and
 * future callers name it rather than repeating the literal.
 */
export const BOM_SUBSTITUTION_DOA_TYPE = 'bom_substitution';

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  return {
    userId: authContext?.userId ?? NO_LOCATION_UUID,
    role: assignment?.role ?? '',
    auditLocationId: assignment?.locationId ?? '*',
  };
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

/**
 * AD-16 replay pre-check: an existing idempotency key returns the ORIGINAL event without
 * re-running any validation or authority gate, so a replay is indistinguishable from the original
 * success. persistEvent itself dedups on a key hit; this pre-check exists so the DOA authority
 * check cannot re-fire (403) for a non-approver retrying a successful key, and so a replayed body
 * that references different inputs cannot 404 before the dedup is reached.
 */
async function getEventByKey(idempotencyKey: string): Promise<PersistedEvent | null> {
  const result = await getPool().query(
    `SELECT event_id, stream_type, stream_id, event_type, event_version, payload, metadata,
            schema_version, idempotency_key, created_at
       FROM domain_events WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  );
  return (result.rows[0] as PersistedEvent) ?? null;
}

/**
 * Response built from the PERSISTED event's payload, never from the current request: on an
 * idempotent replay the persisted event is the ORIGINAL one, so the read-back must key off its
 * bom_line_id (Story 5.2 phantom-success lesson).
 */
async function sendAlternatesFromEvent(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  persisted: PersistedEvent,
): Promise<void> {
  const payload = persisted.payload as { bom_line_id?: unknown };
  const bomLineId = typeof payload.bom_line_id === 'string' ? payload.bom_line_id : null;
  if (!bomLineId) {
    sendRequestError(req, res, 500, 'INVALID_PARAMS', 'Persisted event is missing bom_line_id');
    return;
  }
  const alternates = await getAlternatesByBomLine(bomLineId);
  sendJson(res, 201, { bom_id: persisted.stream_id, bom_line_id: bomLineId, alternates });
}

/**
 * Resolves the BOM, its current released revision and the target line for both alternate paths.
 * Only shape and existence are checked here - release state, item activity, overlap, priority and
 * duplication are the compliance seam's job.
 */
async function resolveAlternateTarget(
  bomId: string,
  body: Record<string, unknown>,
): Promise<{
  revisionId: string;
  bomLineId: string;
  lineNo: number;
  componentItemId: string;
  alternateItemId: string;
  alternateSku: string | null;
}> {
  const bom = await getBomById(bomId);
  if (!bom) throw new AppError(404, 'BOM_NOT_FOUND', 'BOM not found', { bom_id: bomId });
  if (!bom.current_revision_id) {
    throw new AppError(409, 'BOM_NOT_RELEASED', 'BOM has no current revision', { bom_id: bomId });
  }

  const bomLineId = body['bom_line_id'];
  if (typeof bomLineId !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'bom_line_id is required');
  }
  const alternateItemId = body['alternate_item_id'];
  if (typeof alternateItemId !== 'string') {
    throw new AppError(400, 'INVALID_PARAMS', 'alternate_item_id is required');
  }

  const line = await getBomLineById(bomLineId);
  if (!line || line.revision_id !== bom.current_revision_id) {
    throw new AppError(404, 'BOM_LINE_NOT_FOUND', 'BOM line not found on the current revision', {
      bom_line_id: bomLineId,
      revision_id: bom.current_revision_id,
    });
  }
  if (line.component_item_id === null) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'A placeholder line has no component identity and cannot carry alternates',
      { bom_line_id: bomLineId },
    );
  }

  const alternateItem = await getItemById(alternateItemId);

  return {
    revisionId: bom.current_revision_id,
    bomLineId,
    // line_no and component_item_id are resolved SERVER-side from the line, never trusted from
    // the request body (the seam re-asserts the correspondence under lock).
    lineNo: line.line_no,
    componentItemId: line.component_item_id,
    alternateItemId,
    alternateSku: alternateItem?.sku ?? null,
  };
}

function readPriority(body: Record<string, unknown>): number {
  const priority = body['priority'];
  if (
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < 1 ||
    priority > 2147483647
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'priority must be an integer between 1 and 2147483647',
    );
  }
  return priority;
}

const defineAlternateBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const bomId = params?.bomId as string | undefined;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const actor = actorContext(req);
  const bomAlternateId = randomUUID();
  const idempotencyKey = (body['idempotency_key'] as string) ?? randomUUID();

  try {
    // Replay short-circuit first (AD-16): the original event is returned, so the request body -
    // which may differ from the original - is never validated or trusted on a key hit.
    if (typeof body['idempotency_key'] === 'string') {
      const existing = await getEventByKey(body['idempotency_key']);
      if (existing) {
        await sendAlternatesFromEvent(req, res, existing);
        return;
      }
    }

    const target = await resolveAlternateTarget(bomId, body);
    const priority = readPriority(body);
    const correlationId = body['correlation_id'] as string | undefined;

    const event = {
      stream_type: 'engineering',
      stream_id: bomId,
      event_type: 'bom.alternate_defined',
      payload: {
        bom_alternate_id: bomAlternateId,
        bom_id: bomId,
        revision_id: target.revisionId,
        bom_line_id: target.bomLineId,
        line_no: target.lineNo,
        component_item_id: target.componentItemId,
        alternate_item_id: target.alternateItemId,
        alternate_sku: target.alternateSku,
        priority,
        effective_from: body['effective_from'],
        effective_to: (body['effective_to'] as string | undefined) ?? null,
        origin: 'approved',
        correlation_id: correlationId,
      },
      metadata: {
        correlation_id: correlationId ?? randomUUID(),
        occurred_at: new Date().toISOString(),
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.auditLocationId,
        },
      },
      idempotency_key: idempotencyKey,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    await sendAlternatesFromEvent(req, res, persisted);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const approveSubstitutionBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const bomId = params?.bomId as string | undefined;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const actor = actorContext(req);
  const bomAlternateId = randomUUID();
  const idempotencyKey = (body['idempotency_key'] as string) ?? randomUUID();

  try {
    // Replay short-circuit BEFORE the DOA gate (AD-16): the approver authority check must not
    // re-fire for a non-approver retrying a successful key - the original 201 is returned.
    if (typeof body['idempotency_key'] === 'string') {
      const existing = await getEventByKey(body['idempotency_key']);
      if (existing) {
        await sendAlternatesFromEvent(req, res, existing);
        return;
      }
    }

    const target = await resolveAlternateTarget(bomId, body);
    const priority = readPriority(body);
    const correlationId = body['correlation_id'] as string | undefined;

    // AD-3: the approver resolves ONLY through the DOA registry, at capture time, so replay is
    // deterministic. Ad-hoc substitution approval is MANDATORY, so a missing governing entry must
    // fail closed - unlike optional-approval flows where requiresApproval: false skips approval.
    const approval = await resolveApprover(BOM_SUBSTITUTION_DOA_TYPE, 0);
    if (!approval.requiresApproval || !approval.approverActorId || !approval.doaEntryId) {
      throw new AppError(
        409,
        'APPROVAL_UNRESOLVED',
        'Ad-hoc substitution requires a governing DOA entry, and none is configured',
        { transaction_type: BOM_SUBSTITUTION_DOA_TYPE },
      );
    }
    if (approval.approverActorId !== actor.userId) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Ad-hoc substitution must be approved by the resolved DOA approver',
        { transaction_type: BOM_SUBSTITUTION_DOA_TYPE },
      );
    }

    const event = {
      stream_type: 'engineering',
      stream_id: bomId,
      event_type: 'bom.substitution_approved',
      payload: {
        bom_alternate_id: bomAlternateId,
        bom_id: bomId,
        revision_id: target.revisionId,
        bom_line_id: target.bomLineId,
        line_no: target.lineNo,
        component_item_id: target.componentItemId,
        alternate_item_id: target.alternateItemId,
        alternate_sku: target.alternateSku,
        priority,
        effective_from: body['effective_from'],
        effective_to: (body['effective_to'] as string | undefined) ?? null,
        origin: 'ad_hoc',
        doa_entry_id: approval.doaEntryId,
        approver_actor_id: approval.approverActorId,
        correlation_id: correlationId,
      },
      metadata: {
        correlation_id: correlationId ?? randomUUID(),
        occurred_at: new Date().toISOString(),
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.auditLocationId,
        },
      },
      idempotency_key: idempotencyKey,
    };

    // FR-AC-13: persistEvent's logAuditEntry writes the edit-log row for this approval.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    await sendAlternatesFromEvent(req, res, persisted);
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const explodeBomBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const bomId = params?.bomId as string | undefined;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();

  try {
    // The walk runs at CAPTURE time and its whole result is embedded in the payload, so the
    // applier persists it verbatim and replay is byte-deterministic.
    const result = await explodeBomForExecution({
      bom_id: bomId,
      quantity: body['quantity'] as string,
      occurred_at: occurredAt,
    });
    const correlationId = body['correlation_id'] as string | undefined;

    const event = {
      stream_type: 'engineering',
      stream_id: bomId,
      event_type: 'bom.exploded',
      payload: {
        explosion_id: result.explosion_id,
        bom_id: result.bom_id,
        revision_id: result.revision_id,
        order_quantity: result.order_quantity,
        business_date: result.business_date,
        depth_truncated: result.depth_truncated,
        requirements: result.requirements,
        correlation_id: correlationId,
      },
      metadata: {
        correlation_id: correlationId ?? randomUUID(),
        occurred_at: occurredAt,
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.auditLocationId,
        },
      },
      idempotency_key: (body['idempotency_key'] as string) ?? randomUUID(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    // On an idempotent replay persistEvent returns the ORIGINAL event, whose explosion_id is not
    // the one just minted - read the header back through the event so the response is the
    // original run, never a phantom empty one.
    const explosionId =
      (persisted.payload as { explosion_id?: string } | undefined)?.explosion_id ??
      result.explosion_id;
    const header = await getExplosionById(explosionId);
    const requirements = await getExplosionLines(explosionId);
    sendJson(res, 201, { ...header, requirements });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

const getExplosionBase: RouteHandler = async (req, res, params) => {
  const explosionId = params?.explosionId as string | undefined;
  if (!explosionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'explosionId is required');
    return;
  }
  const header = await getExplosionById(explosionId);
  if (!header) {
    sendRequestError(req, res, 404, 'INVALID_PARAMS', 'Explosion run not found');
    return;
  }
  const requirements = await getExplosionLines(explosionId);
  sendJson(res, 200, { ...header, requirements });
};

const listBomAlternatesBase: RouteHandler = async (req, res, params) => {
  const bomId = params?.bomId as string | undefined;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }
  const bom = await getBomById(bomId);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }
  // The alternates-by-component read model: approved alternates and approved ad-hoc substitutions
  // in one stream, grouped by component and ordered by priority.
  const alternates = await getAlternatesByBom(bomId);
  sendJson(res, 200, { bom_id: bomId, alternates });
};

export const defineAlternateHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(defineAlternateBase);

export const listBomAlternatesHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(listBomAlternatesBase);

export const approveSubstitutionHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(approveSubstitutionBase);

export const explodeBomHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(explodeBomBase);

export const getExplosionHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(getExplosionBase);

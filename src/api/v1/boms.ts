import type { IncomingMessage } from 'node:http';
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
import { randomUUID } from 'node:crypto';
import {
  getBomById,
  getBomRevisionByBomId,
  getBomLines,
  getBomStructure,
  listBoms,
  type BomRow,
} from '../../read/projections/bom.js';
import { getItemById } from '../../read/projections/item_master.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  return { userId, role, auditLocationId };
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

const draftBomBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);

  const bomId = (body.bom_id as string) ?? randomUUID();
  const parentItemId = body.parent_item_id as string;
  if (!parentItemId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'parent_item_id is required');
    return;
  }

  const parentItem = await getItemById(parentItemId);
  if (!parentItem) {
    sendRequestError(req, res, 404, 'BOM_ITEM_NOT_FOUND', 'Parent item not found');
    return;
  }

  const revisionCode = (body.revision_code as string) ?? 'A';
  const lines = body.lines as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    sendRequestError(req, res, 400, 'BOM_LINE_REQUIRED', 'At least one line is required');
    return;
  }

  const bomType = (body.bom_type as string) ?? 'production';
  const correlationId = body.correlation_id as string | undefined;
  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: bomId,
    event_type: 'bom.drafted',
    payload: {
      bom_id: bomId,
      parent_item_id: parentItemId,
      bom_type: bomType,
      revision_code: revisionCode,
      lines: lines.map((l) => ({
        line_no: l.line_no,
        component_item_id: l.component_item_id,
        output_class: l.output_class,
        quantity_per: l.quantity_per,
        line_uom: l.line_uom,
        uom_conversion_factor: l.uom_conversion_factor,
        scrap_percent: l.scrap_percent,
        expected_yield_percent: l.expected_yield_percent,
        is_phantom: l.is_phantom,
        phantom_source_bom_id: l.phantom_source_bom_id,
        effective_from: l.effective_from,
        effective_to: l.effective_to,
      })),
      correlation_id: correlationId,
    },
    metadata: {
      correlation_id: correlationId ?? randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.auditLocationId,
      },
    },
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 201));
    const bom = await getBomById(bomId);
    sendJson(res, 201, bom);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message);
      return;
    }
    throw err;
  }
};

const addBomLineBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);

  const bomId = params?.bomId as string;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const bom = await getBomById(bomId);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  if (bom.status !== 'draft') {
    sendRequestError(req, res, 409, 'BOM_NOT_DRAFT', 'Can only add lines to a draft BOM');
    return;
  }

  const revisionId = bom.current_revision_id;
  if (!revisionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'BOM has no current revision');
    return;
  }

  const bomLineId = (body.bom_line_id as string) ?? randomUUID();
  const line = {
    line_no: body.line_no as number,
    component_item_id: body.component_item_id as string,
    output_class: body.output_class as 'component' | 'co_product' | 'by_product',
    quantity_per: body.quantity_per as string,
    line_uom: body.line_uom as string,
    uom_conversion_factor: body.uom_conversion_factor as string,
    scrap_percent: body.scrap_percent as string | undefined,
    expected_yield_percent: body.expected_yield_percent as string | undefined,
    is_phantom: body.is_phantom as boolean,
    phantom_source_bom_id: body.phantom_source_bom_id as string | undefined,
    effective_from: body.effective_from as string,
    effective_to: body.effective_to as string | undefined,
  };

  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: bomId,
    event_type: 'bom_line.added',
    payload: {
      bom_id: bomId,
      revision_id: revisionId,
      bom_line_id: bomLineId,
      ...line,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.auditLocationId,
      },
    },
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 201));
    const updatedBom = await getBomById(bomId);
    sendJson(res, 200, updatedBom);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message);
      return;
    }
    throw err;
  }
};

const amendBomLineBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);

  const bomId = params?.bomId as string;
  const bomLineId = params?.bomLineId as string;

  if (!bomId || !bomLineId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId and bomLineId are required');
    return;
  }

  const bom = await getBomById(bomId);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  if (bom.status !== 'draft') {
    sendRequestError(req, res, 409, 'BOM_NOT_DRAFT', 'Can only amend lines on a draft BOM');
    return;
  }

  const revisionId = bom.current_revision_id;
  if (!revisionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'BOM has no current revision');
    return;
  }

  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: bomId,
    event_type: 'bom_line.amended',
    payload: {
      bom_id: bomId,
      revision_id: revisionId,
      bom_line_id: bomLineId,
      quantity_per: body.quantity_per as string | undefined,
      line_uom: body.line_uom as string | undefined,
      uom_conversion_factor: body.uom_conversion_factor as string | undefined,
      scrap_percent: body.scrap_percent as string | undefined,
      expected_yield_percent: body.expected_yield_percent as string | undefined,
      effective_from: body.effective_from as string | undefined,
      effective_to: body.effective_to as string | undefined,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.auditLocationId,
      },
    },
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 200));
    const updatedBom = await getBomById(bomId);
    sendJson(res, 200, updatedBom);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message);
      return;
    }
    throw err;
  }
};

const getBomBase: RouteHandler = async (req, res, params) => {
  const bomId = params?.bomId as string;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const bom = await getBomById(bomId);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  sendJson(res, 200, bom);
};

const listBomsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const status = url.searchParams.get('status') as BomRow['status'] | null;
  const businessStream = url.searchParams.get('business_stream') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;
  const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
  const offset = url.searchParams.get('offset')
    ? Number(url.searchParams.get('offset'))
    : undefined;

  const result = await listBoms({
    status: status ?? undefined,
    businessStream,
    search,
    limit,
    offset,
  });

  sendJson(res, 200, {
    data: result.rows,
    total: result.total,
    limit: limit ?? 200,
    offset: offset ?? 0,
  });
};

const getBomStructureBase: RouteHandler = async (req, res, params) => {
  const bomId = params?.bomId as string;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const bom = await getBomById(bomId);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  if (!bom.current_revision_id) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'BOM has no current revision');
    return;
  }

  const structure = await getBomStructure(bom.current_revision_id);
  const lines = await getBomLines(bom.current_revision_id);
  const revisions = await getBomRevisionByBomId(bomId);

  sendJson(res, 200, {
    bom,
    revisions,
    lines,
    structure,
  });
};

export const draftBomHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(draftBomBase);

export const addBomLineHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(addBomLineBase);

export const amendBomLineHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(amendBomLineBase);

export const getBomHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(getBomBase);

export const listBomsHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(listBomsBase);

export const getBomStructureHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(getBomStructureBase);

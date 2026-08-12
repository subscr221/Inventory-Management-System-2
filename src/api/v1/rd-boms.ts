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
import { getItemById } from '../../read/projections/item_master.js';
import {
  getBomById,
  getBomLines,
  getBomRevisionByBomId,
  type BomRow,
} from '../../read/projections/bom.js';
import {
  getBuildById,
  getAsBuiltLines,
  listBuilds,
  type RdBuildRecordRow,
} from '../../read/projections/rd_build.js';
import {
  getProductizationChecklist,
  RD_GATE_FUNCTIONS,
  type RdGateFunction,
} from '../../read/projections/rd_productization.js';
import type { RdAsBuiltLineInput } from '../../events/schema.js';
import { resolveApprover } from './indents.js';

/**
 * Story 5.4: R&D draft BOM regime handlers (FR-B-09 to FR-B-11). Copies the src/api/v1/ecos.ts
 * skeleton: envelopes ALWAYS stamp metadata.occurred_at, responses return the durable projection
 * state read back with persisted.stream_id (AD-16), and every identifier is server-minted -
 * accepting a client-supplied bom_id here would let a caller overwrite an unrelated BOM header.
 */

/**
 * DOA transaction types for the three fixed productization gate functions (AC 5). No monetary
 * band - resolved at value 0, the src/api/v1/suppliers.ts and Story 5.3 ECO_DOA_TYPE precedent.
 */
export const RD_PRODUCTIZATION_DOA_TYPES = {
  engineering: 'rd_productization_engineering',
  procurement: 'rd_productization_procurement',
  qc: 'rd_productization_qc',
} as const;

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

function actorMetadata(actor: ActorContext, correlationId: string | undefined) {
  return {
    correlation_id: correlationId ?? randomUUID(),
    occurred_at: new Date().toISOString(),
    actor: {
      user_id: actor.userId,
      role: actor.role,
      location_id: actor.auditLocationId,
    },
  };
}

/**
 * Resolves the revision whose lines a clone/productize copies: current_revision_id, falling back
 * to the earliest bom_revision row (mirrors the applier's resolveSourceRevisionId).
 */
async function resolveSourceRevision(
  bom: BomRow,
): Promise<{ revisionId: string } | { error: string }> {
  if (bom.current_revision_id) return { revisionId: bom.current_revision_id };
  const revisions = await getBomRevisionByBomId(bom.bom_id);
  if (revisions.length === 0) return { error: 'Source BOM has no revision to copy from' };
  return { revisionId: revisions[0]!.revision_id };
}

async function buildWithLines(
  build: RdBuildRecordRow,
): Promise<RdBuildRecordRow & { as_built_lines: unknown[] }> {
  const lines = await getAsBuiltLines(build.build_id);
  return { ...build, as_built_lines: lines };
}

// ---------------------------------------------------------------------------
// AC 3: clone a BOM to a new R&D draft
// ---------------------------------------------------------------------------

const cloneToRdBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);

  const sourceBomId = params?.bomId as string;
  if (!sourceBomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const source = await getBomById(sourceBomId);
  if (!source) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  const revision = await resolveSourceRevision(source);
  if ('error' in revision) {
    sendRequestError(req, res, 409, 'INVALID_PARAMS', revision.error, { bom_id: sourceBomId });
    return;
  }

  // line_ids are minted at CAPTURE time and stored in the payload so replay is deterministic.
  const sourceLines = await getBomLines(revision.revisionId);
  const lineIds = sourceLines.map(() => randomUUID());

  const correlationId = body.correlation_id as string | undefined;
  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
  const newBomId = randomUUID();
  const newRevisionId = randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: newBomId,
    event_type: 'rd_draft.cloned',
    payload: {
      source_bom_id: sourceBomId,
      source_revision_id: revision.revisionId,
      bom_id: newBomId,
      revision_id: newRevisionId,
      revision_code: 'A',
      parent_item_id: source.parent_item_id,
      parent_sku: source.parent_sku,
      parent_uom: source.parent_uom,
      // Copied from the source BOM's tag (FR-AC-01), never accepted from the request body.
      business_stream: source.business_stream,
      line_ids: lineIds,
      correlation_id: correlationId,
    },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    // AD-16: an idempotency-key hit returns the EXISTING event, which may carry a different
    // bom_id than this request minted.
    const effectiveBomId = persisted.stream_id ?? newBomId;
    const clone = await getBomById(effectiveBomId);
    const lines = clone?.current_revision_id ? await getBomLines(clone.current_revision_id) : [];
    sendJson(res, 201, { ...clone, lines });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// AC 4: draft-BOM build records and the as-built snapshot
// ---------------------------------------------------------------------------

interface AsBuiltLineBody {
  line_no?: number;
  draft_bom_line_id?: string;
  component_item_id?: string;
  is_placeholder?: boolean;
  free_text?: string;
  quantity_used?: string;
  line_uom?: string;
}

const recordBuildBase: RouteHandler = async (req, res, params) => {
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

  const revision = await resolveSourceRevision(bom);
  if ('error' in revision) {
    sendRequestError(req, res, 409, 'INVALID_PARAMS', revision.error, { bom_id: bomId });
    return;
  }

  const rawLines = body.as_built_lines as AsBuiltLineBody[] | undefined;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'as_built_lines is required and non-empty');
    return;
  }

  // component_sku resolves server-side from the item master for every non-placeholder line; the
  // client never supplies a SKU for a real item. The payload type is a discriminated union
  // (placeholder vs real line) that mirrors assertRdBuildRecordedShape.
  const resolvedLines: RdAsBuiltLineInput[] = [];
  let lineNo = 0;
  for (const line of rawLines) {
    lineNo += 1;
    const base = {
      line_no: line.line_no ?? lineNo,
      ...(line.draft_bom_line_id !== undefined && {
        draft_bom_line_id: line.draft_bom_line_id,
      }),
      quantity_used: line.quantity_used as string,
      line_uom: line.line_uom as string,
    };
    if (line.is_placeholder === true) {
      resolvedLines.push({
        ...base,
        is_placeholder: true,
        free_text: line.free_text as string,
      });
    } else {
      const componentItemId = line.component_item_id as string;
      if (!componentItemId) {
        // Mirrors assertRdBuildRecordedShape so the handler fails fast instead of a raw null
        // lookup below.
        sendRequestError(
          req,
          res,
          400,
          'INVALID_PARAMS',
          'component_item_id is required and must be a UUID',
        );
        return;
      }
      const item = await getItemById(componentItemId);
      if (!item) {
        sendRequestError(req, res, 404, 'BOM_ITEM_NOT_FOUND', 'Component item not found', {
          component_item_id: componentItemId,
        });
        return;
      }
      resolvedLines.push({
        ...base,
        is_placeholder: false,
        component_item_id: componentItemId,
        component_sku: item.sku,
      });
    }
  }

  const correlationId = body.correlation_id as string | undefined;
  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
  const buildId = randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: buildId,
    event_type: 'rd_build.recorded',
    payload: {
      build_id: buildId,
      bom_id: bomId,
      revision_id: revision.revisionId,
      build_ref: body.build_ref as string,
      // Derived server-side from the BOM, never accepted from a request body.
      business_stream: bom.business_stream,
      built_quantity: body.built_quantity as string,
      built_uom: body.built_uom as string,
      outcome: body.outcome as string | undefined,
      notes: body.notes as string | undefined,
      as_built_lines: resolvedLines,
      correlation_id: correlationId,
    },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    const effectiveBuildId = persisted.stream_id ?? buildId;
    const build = await getBuildById(effectiveBuildId);
    if (!build) {
      sendRequestError(req, res, 404, 'BUILD_NOT_FOUND', 'Build record not found');
      return;
    }
    sendJson(res, 201, await buildWithLines(build));
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

const listBuildsBase: RouteHandler = async (req, res, params) => {
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

  const url = new URL(req.url ?? '', 'http://localhost');
  const status = url.searchParams.get('status') as RdBuildRecordRow['status'] | null;
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  // \d+ guard: Number('abc') reaching LIMIT NaN is a raw 500, and echoing an unclamped limit
  // makes pagination metadata lie (Story 5.2 Group 2 patch).
  const limit = /^\d+$/.test(limitParam ?? '')
    ? Math.max(Math.min(Number(limitParam), 200), 1)
    : 200;
  const offset = /^\d+$/.test(offsetParam ?? '') ? Math.min(Number(offsetParam), 1_000_000) : 0;

  const result = await listBuilds({
    bomId,
    status: status ?? undefined,
    limit,
    offset,
  });

  sendJson(res, 200, {
    data: result.rows,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  });
};

const getBuildBase: RouteHandler = async (req, res, params) => {
  const buildId = params?.buildId as string;
  if (!buildId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'buildId is required');
    return;
  }

  const build = await getBuildById(buildId);
  if (!build) {
    sendRequestError(req, res, 404, 'BUILD_NOT_FOUND', 'Build record not found');
    return;
  }

  sendJson(res, 200, await buildWithLines(build));
};

const confirmBuildBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);

  const buildId = params?.buildId as string;
  if (!buildId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'buildId is required');
    return;
  }

  const build = await getBuildById(buildId);
  if (!build) {
    sendRequestError(req, res, 404, 'BUILD_NOT_FOUND', 'Build record not found');
    return;
  }

  const correlationId = body.correlation_id as string | undefined;
  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: buildId,
    event_type: 'rd_build.confirmed',
    payload: {
      build_id: buildId,
      correlation_id: correlationId,
    },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 200));
    const updated = await getBuildById(buildId);
    if (!updated) {
      sendRequestError(req, res, 404, 'BUILD_NOT_FOUND', 'Build record not found');
      return;
    }
    sendJson(res, 200, await buildWithLines(updated));
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// AC 5: productization gate
// ---------------------------------------------------------------------------

const signProductizationBase: RouteHandler = async (req, res, params) => {
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

  const gateFunction = body.gate_function as RdGateFunction;
  if (!(RD_GATE_FUNCTIONS as readonly string[]).includes(gateFunction)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'gate_function must be one of engineering, procurement, qc',
    );
    return;
  }

  const bom = await getBomById(bomId);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  // AC 5: the approver resolves from the one enterprise DOA registry at SIGN time and is stored
  // on the payload (AD-3, FR-DOA-01) - registry entries and role holders drift over time.
  const doaType = RD_PRODUCTIZATION_DOA_TYPES[gateFunction];
  const approval = await resolveApprover(doaType, 0);
  if (!approval.approverActorId) {
    sendRequestError(
      req,
      res,
      409,
      'APPROVAL_UNRESOLVED',
      'Approval is required but no active approver could be resolved',
      { transaction_type: doaType },
    );
    return;
  }

  // Two-status use of one code (Story 5.3 approveEcoHandler precedent): 403 for wrong approver,
  // 409 for gate-unmet (AC 5's mandated case, raised by the productize applier).
  if (approval.approverActorId !== actor.userId) {
    sendRequestError(
      req,
      res,
      403,
      'APPROVAL_REQUIRED',
      'Caller is not the resolved approver for this productization gate function',
      {
        gate_function: gateFunction,
        approver_actor_id: approval.approverActorId,
        caller_user_id: actor.userId,
      },
    );
    return;
  }

  const correlationId = body.correlation_id as string | undefined;
  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
  const signoffId = randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: bomId,
    event_type: 'rd_draft.productization_signed',
    payload: {
      signoff_id: signoffId,
      bom_id: bomId,
      gate_function: gateFunction,
      approver_actor_id: approval.approverActorId,
      doa_entry_id: approval.doaEntryId,
      notes: body.notes as string | undefined,
      correlation_id: correlationId,
    },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(event as any, auditCtxFor(req, actor, 200));
    const checklist = await getProductizationChecklist(bomId);
    sendJson(res, 200, checklist);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

const getProductizationGateBase: RouteHandler = async (req, res, params) => {
  const bomId = params?.bomId as string;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const checklist = await getProductizationChecklist(bomId);
  if (!checklist) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  sendJson(res, 200, checklist);
};

const productizeBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);

  const sourceBomId = params?.bomId as string;
  if (!sourceBomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const source = await getBomById(sourceBomId);
  if (!source) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  const revision = await resolveSourceRevision(source);
  if ('error' in revision) {
    sendRequestError(req, res, 409, 'INVALID_PARAMS', revision.error, { bom_id: sourceBomId });
    return;
  }

  const sourceLines = await getBomLines(revision.revisionId);
  const lineIds = sourceLines.map(() => randomUUID());

  const correlationId = body.correlation_id as string | undefined;
  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
  const newBomId = randomUUID();
  const newRevisionId = randomUUID();

  const event = {
    stream_type: 'engineering',
    stream_id: newBomId,
    event_type: 'rd_draft.productized',
    payload: {
      source_bom_id: sourceBomId,
      bom_id: newBomId,
      revision_id: newRevisionId,
      revision_code: 'A',
      parent_item_id: source.parent_item_id,
      parent_sku: source.parent_sku,
      parent_uom: source.parent_uom,
      business_stream: source.business_stream,
      line_ids: lineIds,
      correlation_id: correlationId,
    },
    metadata: actorMetadata(actor, correlationId),
    idempotency_key: idempotencyKey,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    const effectiveBomId = persisted.stream_id ?? newBomId;
    const production = await getBomById(effectiveBomId);
    const lines = production?.current_revision_id
      ? await getBomLines(production.current_revision_id)
      : [];
    sendJson(res, 201, { ...production, lines });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

export const cloneToRdHandler = requireRole({ module: 'engineering', functionScope: 'write' })(
  cloneToRdBase,
);

export const recordBuildHandler = requireRole({ module: 'engineering', functionScope: 'write' })(
  recordBuildBase,
);

export const listBuildsHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  listBuildsBase,
);

export const getBuildHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  getBuildBase,
);

export const confirmBuildHandler = requireRole({ module: 'engineering', functionScope: 'write' })(
  confirmBuildBase,
);

export const signProductizationHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(signProductizationBase);

export const getProductizationGateHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(getProductizationGateBase);

export const productizeHandler = requireRole({ module: 'engineering', functionScope: 'write' })(
  productizeBase,
);

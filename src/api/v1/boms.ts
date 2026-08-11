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
  getBomByParentItemId,
  getBomRevisionById,
  getBomRevisionByBomId,
  getBomLines,
  getBomLineById,
  getBomStructure,
  listBoms,
  type BomRow,
} from '../../read/projections/bom.js';
import { getReleaseGateChecklist } from '../../read/projections/release_gate_checklist.js';
import { getItemById } from '../../read/projections/item_master.js';
import { isReleasedItemMaster } from '../../compliance/bom.js';
import { toIstCalendarDate } from '../../lib/business-days.js';

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
      // FR-AC-01: business_stream derives server-side from the parent item master and is never
      // accepted from the request body. bom.drafted is registered requiresBusinessStream: true.
      business_stream: parentItem.business_stream,
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
      occurred_at: new Date().toISOString(),
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

  const revisionId = bom.current_revision_id;
  if (!revisionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'BOM has no current revision');
    return;
  }

  // Story 5.2 (FR-B-03): a released revision is immutable - takes precedence over the
  // Story 5.1 draft-only guard, which still covers the remaining non-draft header states.
  const revision = await getBomRevisionById(revisionId);
  if (revision?.revision_status === 'released') {
    sendRequestError(
      req,
      res,
      409,
      'IMMUTABLE_REVISION',
      'Released revisions are immutable - changes require an ECO',
    );
    return;
  }
  if (bom.status !== 'draft') {
    sendRequestError(req, res, 409, 'BOM_NOT_DRAFT', 'Can only add lines to a draft BOM');
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
      occurred_at: new Date().toISOString(),
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

  const revisionId = bom.current_revision_id;
  if (!revisionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'BOM has no current revision');
    return;
  }

  // Story 5.2 (FR-B-03): a released revision is immutable - takes precedence over the
  // Story 5.1 draft-only guard, which still covers the remaining non-draft header states.
  const revision = await getBomRevisionById(revisionId);
  if (revision?.revision_status === 'released') {
    sendRequestError(
      req,
      res,
      409,
      'IMMUTABLE_REVISION',
      'Released revisions are immutable - changes require an ECO',
    );
    return;
  }
  if (bom.status !== 'draft') {
    sendRequestError(req, res, 409, 'BOM_NOT_DRAFT', 'Can only amend lines on a draft BOM');
    return;
  }

  // Story 5.3 (deferred-work.md line 210): the handler pre-check must scope the line lookup to
  // the CURRENT revision, not just bom_line_id - once a BOM has a second revision (only possible
  // via an implemented ECO), a stale bom_line_id from an older, released revision must 404 here
  // rather than reach the applier at all.
  const targetLine = await getBomLineById(bomLineId);
  if (!targetLine || targetLine.revision_id !== revisionId) {
    sendRequestError(req, res, 404, 'BOM_LINE_NOT_FOUND', 'BOM line not found in this revision');
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
      occurred_at: new Date().toISOString(),
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

// ---------------------------------------------------------------------------
// Story 5.2: BOM Lifecycle and Immutability
// ---------------------------------------------------------------------------

type LifecycleEventType = 'bom.released' | 'bom.held' | 'bom.obsoleted';

function lifecycleHandler(eventType: LifecycleEventType): RouteHandler {
  return async (req, res, params) => {
    const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
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

    const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
    const payload: Record<string, unknown> = {
      bom_id: bomId,
      reason: body.reason as string | undefined,
      correlation_id: body.correlation_id as string | undefined,
    };
    if (eventType === 'bom.released') {
      payload.revision_id = bom.current_revision_id;
    }

    const event = {
      stream_type: 'engineering',
      stream_id: bomId,
      event_type: eventType,
      payload,
      metadata: {
        correlation_id: (body.correlation_id as string) ?? randomUUID(),
        occurred_at: new Date().toISOString(),
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
        sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
        return;
      }
      throw err;
    }
  };
}

const releaseBomBase: RouteHandler = lifecycleHandler('bom.released');
const holdBomBase: RouteHandler = lifecycleHandler('bom.held');
const obsoleteBomBase: RouteHandler = lifecycleHandler('bom.obsoleted');

const getReleaseGateBase: RouteHandler = async (req, res, params) => {
  const bomId = params?.bomId as string;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const checklist = await getReleaseGateChecklist(bomId);
  if (!checklist) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  sendJson(res, 200, checklist);
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_STRING_REGEX = /^\d+(\.\d+)?$/;

function isWellFormedComponent(component: unknown): boolean {
  if (!component || typeof component !== 'object') return false;
  const c = component as Record<string, unknown>;
  return (
    typeof c.component_item_id === 'string' &&
    UUID_REGEX.test(c.component_item_id) &&
    typeof c.quantity_per === 'string' &&
    DECIMAL_STRING_REGEX.test(c.quantity_per) &&
    typeof c.line_uom === 'string' &&
    c.line_uom.trim().length > 0
  );
}

interface KitComponentInput {
  component_item_id: string;
  quantity_per: string;
  line_uom: string;
  scrap_percent?: string;
  effective_from?: string;
}

interface KitInput {
  kit_ref: string;
  parent_item_id: string;
  revision_code?: string;
  components: KitComponentInput[];
}

const migrateLegacyKitsBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const kits = body.kits as KitInput[] | undefined;
  if (!Array.isArray(kits) || kits.length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'kits array is required and must be non-empty',
    );
    return;
  }
  if (kits.length > 500) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'kits array must not exceed 500 entries');
    return;
  }

  const actor = actorContext(req);
  const batchKey = (body.idempotency_key as string) ?? randomUUID();
  const businessDate = toIstCalendarDate(new Date());

  const migrated: Record<string, unknown>[] = [];
  const draftRemediation: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  // A second kit for the same parent WITHIN the batch reports skipped, never a constraint crash.
  const parentsInBatch = new Set<string>();

  for (const kit of kits) {
    const kitRef = typeof kit?.kit_ref === 'string' ? kit.kit_ref.trim() : '';
    const seenComponentIds = new Set<string>();
    const componentsWellFormed =
      Array.isArray(kit?.components) &&
      kit.components.every((component) => {
        if (!isWellFormedComponent(component)) return false;
        if (seenComponentIds.has(component.component_item_id)) return false;
        seenComponentIds.add(component.component_item_id);
        return true;
      });
    if (
      !kit ||
      kitRef.length === 0 ||
      typeof kit.parent_item_id !== 'string' ||
      !UUID_REGEX.test(kit.parent_item_id) ||
      !Array.isArray(kit.components) ||
      kit.components.length === 0 ||
      !componentsWellFormed
    ) {
      skipped.push({
        kit_ref: kitRef || null,
        skipped: 'invalid_kit',
        reason:
          'kit_ref, parent_item_id (UUID), and a non-empty components array with unique, well-formed entries are required',
      });
      continue;
    }

    const parentItem = await getItemById(kit.parent_item_id);
    if (!parentItem) {
      skipped.push({
        kit_ref: kitRef,
        skipped: 'parent_item_not_found',
        parent_item_id: kit.parent_item_id,
      });
      continue;
    }

    if (parentsInBatch.has(kit.parent_item_id)) {
      skipped.push({
        kit_ref: kitRef,
        skipped: 'bom_exists',
        parent_item_id: kit.parent_item_id,
      });
      continue;
    }
    const existingBom = await getBomByParentItemId(kit.parent_item_id);
    if (existingBom) {
      skipped.push({
        kit_ref: kitRef,
        skipped: 'bom_exists',
        parent_item_id: kit.parent_item_id,
        bom_id: existingBom.bom_id,
      });
      continue;
    }
    parentsInBatch.add(kit.parent_item_id);

    // Outcome is computed HERE, at capture time, and stored in the payload so replay is
    // deterministic - item-master statuses drift after the fact. Code review D1 resolution: an
    // inactive parent item ALSO forces draft_remediation (AC 5 extended to the header level), so
    // a Released BOM can never carry an inactive parent; flagged kits stay visible on the
    // migration-exceptions list for the Epic 13 sign-off gate.
    let allComponentsReleased = isReleasedItemMaster(parentItem);
    for (const component of kit.components) {
      const componentItem = await getItemById(component.component_item_id);
      if (!componentItem || !isReleasedItemMaster(componentItem)) {
        allComponentsReleased = false;
        break;
      }
    }
    const outcome = allComponentsReleased ? 'released' : 'draft_remediation';

    const bomId = randomUUID();
    const lines = kit.components.map((component, index) => ({
      line_no: index + 1,
      component_item_id: component.component_item_id,
      output_class: 'component',
      quantity_per: component.quantity_per,
      line_uom: component.line_uom,
      // ERP kits carry no conversion data: factor 1 so base_quantity_per = quantity_per.
      uom_conversion_factor: '1.00000000',
      scrap_percent: component.scrap_percent,
      is_phantom: false,
      effective_from: component.effective_from ?? businessDate,
    }));

    const event = {
      stream_type: 'engineering',
      stream_id: bomId,
      event_type: 'bom.migrated_from_kit',
      payload: {
        bom_id: bomId,
        parent_item_id: kit.parent_item_id,
        business_stream: parentItem.business_stream,
        kit_ref: kitRef,
        revision_code: kit.revision_code ?? 'A',
        outcome,
        lines,
        correlation_id: body.correlation_id as string | undefined,
      },
      metadata: {
        correlation_id: (body.correlation_id as string) ?? randomUUID(),
        occurred_at: new Date().toISOString(),
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.auditLocationId,
        },
      },
      idempotency_key: `${batchKey}:${kitRef}`,
    };

    try {
      // FR-AC-13: the migration-exempt release is distinguishable in the edit log.
      const migrationAuditCtx = {
        ...auditCtxFor(req, actor, 200),
        details: {
          migration_exempt: outcome === 'released',
          kit_ref: kitRef,
          outcome,
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const persisted = await persistEvent(event as any, migrationAuditCtx);
      const effectiveBomId = persisted.stream_id ?? bomId;
      if (effectiveBomId !== bomId) {
        // Idempotency replay: this kit_ref already produced a BOM (duplicate kit_ref in the batch,
        // or a re-run of the same batch under the same idempotency key). Report the existing BOM
        // as skipped rather than fabricating a phantom success entry.
        skipped.push({
          kit_ref: kitRef,
          skipped: 'bom_exists',
          parent_item_id: kit.parent_item_id,
          bom_id: effectiveBomId,
        });
        continue;
      }
      const bom = await getBomById(effectiveBomId);
      const entry = {
        kit_ref: kitRef,
        bom_id: effectiveBomId,
        parent_item_id: kit.parent_item_id,
        outcome,
        // FR-AC-13: the released path bypassed the gate via the migration exemption.
        migration_exempt: outcome === 'released',
        bom,
      };
      if (outcome === 'released') migrated.push(entry);
      else draftRemediation.push(entry);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        skipped.push({
          kit_ref: kitRef,
          skipped: err.errorCode === 'DUPLICATE_EVENT' ? 'bom_exists' : 'error',
          error_code: err.errorCode,
          reason: err.message,
        });
        parentsInBatch.delete(kit.parent_item_id);
        continue;
      }
      throw err;
    }
  }

  // Partial success is expected behavior, not an error.
  sendJson(res, 200, {
    migrated,
    draft_remediation: draftRemediation,
    skipped,
  });
};

const listMigrationExceptionsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const limit = /^\d+$/.test(limitParam ?? '') ? Math.min(Number(limitParam), 200) : 200;
  const offset = /^\d+$/.test(offsetParam ?? '') ? Number(offsetParam) : 0;

  const result = await listBoms({
    origin: 'legacy_kit',
    remediationFlag: true,
    limit,
    offset,
  });

  sendJson(res, 200, {
    data: result.rows,
    total: result.total,
    limit,
    offset,
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

export const releaseBomHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(releaseBomBase);

export const holdBomHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(holdBomBase);

export const obsoleteBomHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(obsoleteBomBase);

export const getReleaseGateHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(getReleaseGateBase);

export const migrateLegacyKitsHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(migrateLegacyKitsBase);

export const listMigrationExceptionsHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(listMigrationExceptionsBase);

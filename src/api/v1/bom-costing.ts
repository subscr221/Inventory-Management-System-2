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
import { getBomById, getBomLines } from '../../read/projections/bom.js';
import {
  getCostRollupById,
  getCostRollupLines,
  listCostRollupsByBom,
} from '../../read/projections/bom_cost_rollup.js';
import { compareCostRollups } from '../../read/projections/bom_cost_rollup_comparison.js';
import { rollUpBomCost } from '../../engineering/bom-cost-rollup.js';
import { SUPPLY_SOURCES } from '../../compliance/bom-costing.js';
import type { BomJobWorkKitTag } from '../../events/schema.js';

/**
 * Story 5.6 REST surface: dated cost-rollup snapshots with comparison, and job-work kit
 * supply-source tagging (FR-B-15, FR-B-16). Every state gate lives in
 * src/compliance/bom-costing.ts, not here, so a direct POST /api/v1/events cannot bypass it;
 * these handlers own only the capture-time resolutions (the rollup walk, server-side line_no and
 * revision_id) and the response shape.
 *
 * BOM is enterprise-scoped (Story 5.4 binding decision), so no handler applies a site filter.
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Integer guard plus clamp, echoing the clamped value (the module's limit/offset discipline). */
function readPaging(req: IncomingMessage): { limit: number; offset: number } {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const limitRaw = url.searchParams.get('limit');
  const offsetRaw = url.searchParams.get('offset');
  if (limitRaw !== null && !/^\d+$/.test(limitRaw)) {
    throw new AppError(400, 'INVALID_PARAMS', 'limit must be a non-negative integer');
  }
  if (offsetRaw !== null && !/^\d+$/.test(offsetRaw)) {
    throw new AppError(400, 'INVALID_PARAMS', 'offset must be a non-negative integer');
  }
  return {
    limit: limitRaw === null ? 50 : Math.min(Math.max(Number(limitRaw), 1), 200),
    // Clamp offset to a safe integer: an unbounded digit string above 2^53 loses precision to
    // scientific notation and overflows PostgreSQL's bigint OFFSET as a raw 500.
    offset: offsetRaw === null ? 0 : Math.min(Number(offsetRaw), Number.MAX_SAFE_INTEGER),
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/boms/:bomId/cost-rollups
// ---------------------------------------------------------------------------

const runCostRollupBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const bomId = params?.['bomId'];
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();

  try {
    // The walk runs at CAPTURE time and its whole result is embedded in the payload, so the
    // applier persists it verbatim and replay is byte-deterministic.
    const result = await rollUpBomCost({ bom_id: bomId, occurred_at: occurredAt });
    const correlationId = body['correlation_id'] as string | undefined;

    const event = {
      stream_type: 'engineering',
      stream_id: bomId,
      event_type: 'bom.cost_rollup_snapshotted',
      payload: {
        rollup_id: result.rollup_id,
        bom_id: result.bom_id,
        revision_id: result.revision_id,
        rollup_date: result.rollup_date,
        rate_basis: result.rate_basis,
        total_cost: result.total_cost,
        line_count: result.line_count,
        missing_rate_count: result.missing_rate_count,
        depth_truncated: result.depth_truncated,
        lines: result.lines,
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
    // On an idempotent replay persistEvent returns the ORIGINAL event, whose rollup_id is not the
    // one just minted - read the snapshot back through the event so the response is the original
    // run, never a phantom empty one (Story 5.2 phantom-success lesson).
    const rollupId =
      (persisted.payload as { rollup_id?: string } | undefined)?.rollup_id ?? result.rollup_id;
    const header = await getCostRollupById(rollupId);
    const lines = await getCostRollupLines(rollupId);
    sendJson(res, 201, { ...header, bom_id: persisted.stream_id, lines });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/boms/:bomId/cost-rollups
// ---------------------------------------------------------------------------

const listCostRollupsBase: RouteHandler = async (req, res, params) => {
  const bomId = params?.['bomId'];
  if (!bomId || !UUID_REGEX.test(bomId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId must be a UUID');
    return;
  }
  try {
    const bom = await getBomById(bomId);
    if (!bom) {
      sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found', { bom_id: bomId });
      return;
    }
    const paging = readPaging(req);
    const page = await listCostRollupsByBom(bomId, paging);
    sendJson(res, 200, {
      bom_id: bomId,
      cost_rollups: page.rows,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/bom-cost-rollups/compare?base=&compare=
// ---------------------------------------------------------------------------

const compareCostRollupsBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const base = url.searchParams.get('base');
  const compare = url.searchParams.get('compare');
  if (!base || !UUID_REGEX.test(base) || !compare || !UUID_REGEX.test(compare)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'base and compare query parameters are required and must be UUIDs',
    );
    return;
  }
  try {
    sendJson(res, 200, await compareCostRollups(base, compare));
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/bom-cost-rollups/:rollupId
// ---------------------------------------------------------------------------

const getCostRollupBase: RouteHandler = async (req, res, params) => {
  const rollupId = params?.['rollupId'];
  if (!rollupId || !UUID_REGEX.test(rollupId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'rollupId must be a UUID');
    return;
  }
  const header = await getCostRollupById(rollupId);
  if (!header) {
    sendRequestError(req, res, 404, 'COST_ROLLUP_NOT_FOUND', 'Cost rollup snapshot not found', {
      rollup_id: rollupId,
    });
    return;
  }
  const lines = await getCostRollupLines(rollupId);
  sendJson(res, 200, { ...header, lines });
};

// ---------------------------------------------------------------------------
// POST /api/v1/boms/:bomId/job-work-kit-tags
// ---------------------------------------------------------------------------

/**
 * Partial tagging is a legitimate authoring step, so this handler accepts a request that leaves
 * some component lines untagged. The completeness requirement of AC 4 is enforced at RELEASE, via
 * the kit-only `supply_source_missing` gate condition - a tag-time-only check would let an
 * untagged kit BOM release.
 */
const tagJobWorkKitBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }
  const bomId = params?.['bomId'];
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bomId is required');
    return;
  }

  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();

  try {
    const bom = await getBomById(bomId);
    if (!bom) throw new AppError(404, 'BOM_NOT_FOUND', 'BOM not found', { bom_id: bomId });
    if (bom.bom_type !== 'job_work_kit') {
      throw new AppError(
        409,
        'BOM_NOT_JOB_WORK_KIT',
        'Supply-source tagging applies only to job-work kit BOMs',
        { bom_id: bomId, bom_type: bom.bom_type },
      );
    }
    if (!bom.current_revision_id) {
      throw new AppError(409, 'INVALID_PARAMS', 'BOM has no current revision', { bom_id: bomId });
    }

    const rawTags = body['tags'];
    if (!Array.isArray(rawTags) || rawTags.length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'tags is required and must be a non-empty array');
    }

    // line_no and revision_id are resolved SERVER-side from the BOM header and its line rows,
    // never trusted from the request body (the seam re-asserts the scoping under lock).
    const lines = await getBomLines(bom.current_revision_id);
    const linesById = new Map(lines.map((line) => [line.bom_line_id, line]));
    const tags: BomJobWorkKitTag[] = [];
    for (const raw of rawTags as unknown[]) {
      const tag = (raw ?? {}) as Record<string, unknown>;
      const bomLineId = tag['bom_line_id'];
      const supplySource = tag['supply_source'];
      if (typeof supplySource !== 'string' || !SUPPLY_SOURCES.has(supplySource)) {
        throw new AppError(
          400,
          'INVALID_PARAMS',
          "supply_source must be one of 'company', 'customer', 'job_worker'",
          { supply_source: typeof supplySource === 'string' ? supplySource : null },
        );
      }
      if (typeof bomLineId !== 'string' || !linesById.has(bomLineId)) {
        throw new AppError(
          404,
          'BOM_LINE_NOT_FOUND',
          'BOM line not found on the current revision',
          {
            bom_line_id: typeof bomLineId === 'string' ? bomLineId : null,
            revision_id: bom.current_revision_id,
          },
        );
      }
      tags.push({
        bom_line_id: bomLineId,
        line_no: linesById.get(bomLineId)!.line_no,
        supply_source: supplySource as BomJobWorkKitTag['supply_source'],
      });
    }

    const correlationId = body['correlation_id'] as string | undefined;
    const event = {
      stream_type: 'engineering',
      stream_id: bomId,
      event_type: 'bom.job_work_kit_tagged',
      payload: {
        bom_id: bomId,
        revision_id: bom.current_revision_id,
        tags,
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
    const persistedRevision =
      (persisted.payload as { revision_id?: string } | undefined)?.revision_id ??
      bom.current_revision_id;
    const updated = await getBomLines(persistedRevision);
    sendJson(res, 201, {
      bom_id: persisted.stream_id,
      revision_id: persistedRevision,
      lines: updated.map((line) => ({
        bom_line_id: line.bom_line_id,
        line_no: line.line_no,
        component_sku: line.component_sku,
        output_class: line.output_class,
        supply_source: line.supply_source,
      })),
    });
  } catch (err: unknown) {
    sendAppError(req, res, err);
  }
};

export const runCostRollupHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(runCostRollupBase);

export const listCostRollupsHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(listCostRollupsBase);

export const compareCostRollupsHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(compareCostRollupsBase);

export const getCostRollupHandler = requireRole({
  module: 'engineering',
  functionScope: 'read',
})(getCostRollupBase);

export const tagJobWorkKitHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(tagJobWorkKitBase);

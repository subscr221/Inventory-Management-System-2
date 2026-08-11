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
import { getPool } from '../../config/db.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getBomById, getBomRevisionByBomId } from '../../read/projections/bom.js';
import {
  getEcoById,
  getEcoChangeLines,
  getEcoDispositions,
  listEcos,
  type EcoRow,
} from '../../read/projections/eco.js';
import { getEcoImpact } from '../../read/projections/where_used_impact.js';
import { getStockBalancesBySku } from '../../read/projections/stock_balance.js';
import { resolveApprover } from './indents.js';

/**
 * DOA transaction type for ECO approval resolution (AC 7). ECOs carry no monetary band -
 * resolved at value 0, the same zero-value precedent as src/api/v1/suppliers.ts:232.
 */
export const ECO_DOA_TYPE = 'eco_approval';

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

/** ECO-YYYY-<6-char suffix>, generated server-side at raise time (Open Question 1's default). */
function generateEcoNumber(): string {
  const year = new Date().getUTCFullYear();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `ECO-${year}-${suffix}`;
}

/** Next revision code letter (A, B, C, ...), following the draftBom/legacy-kit 'A' convention. */
function nextRevisionCode(existingRevisionCount: number): string {
  if (existingRevisionCount < 26) {
    return String.fromCharCode(65 + existingRevisionCount);
  }
  return `R${existingRevisionCount + 1}`;
}

const raiseEcoBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);

  const bomId = body.bom_id as string;
  if (!bomId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'bom_id is required');
    return;
  }

  const bom = await getBomById(bomId);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'BOM not found');
    return;
  }

  const targetRevisionId = (body.target_revision_id as string) ?? bom.current_revision_id;
  if (!targetRevisionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'BOM has no current revision');
    return;
  }

  const reason = body.reason as string | undefined;
  if (!reason) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason is required');
    return;
  }

  const changes = body.changes as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(changes) || changes.length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'At least one change is required');
    return;
  }

  // AC 7: the approver is resolved from the DOA registry at RAISE time and stored on the
  // payload, never re-resolved later - DOA registry entries and role holders drift over time.
  const approval = await resolveApprover(ECO_DOA_TYPE, 0);
  if (!approval.approverActorId) {
    sendRequestError(
      req,
      res,
      409,
      'APPROVAL_UNRESOLVED',
      'Approval is required but no active approver could be resolved',
      { transaction_type: ECO_DOA_TYPE },
    );
    return;
  }

  const correlationId = body.correlation_id as string | undefined;
  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();

  // eco_id and eco_number are generated server-side; caller-supplied values are ignored so a
  // duplicate or malformed identifier cannot surface as a raw unique-violation 500.
  const ecoId = randomUUID();
  const ecoNumber = generateEcoNumber();

  const event = {
    stream_type: 'engineering',
    stream_id: ecoId,
    event_type: 'eco.raised',
    payload: {
      eco_id: ecoId,
      eco_number: ecoNumber,
      bom_id: bomId,
      target_revision_id: targetRevisionId,
      // FR-AC-01 precedent: business_stream derives server-side from the target BOM and is
      // never accepted from the request body.
      business_stream: bom.business_stream,
      reason,
      changes: changes.map((c) => ({
        change_type: c.change_type,
        target_bom_line_id: c.target_bom_line_id,
        component_item_id: c.component_item_id,
        output_class: c.output_class,
        quantity_per: c.quantity_per,
        line_uom: c.line_uom,
        uom_conversion_factor: c.uom_conversion_factor,
        scrap_percent: c.scrap_percent,
        expected_yield_percent: c.expected_yield_percent,
        is_phantom: c.is_phantom,
        phantom_source_bom_id: c.phantom_source_bom_id,
        effective_from: c.effective_from,
        effective_to: c.effective_to,
      })),
      approver_actor_id: approval.approverActorId,
      doa_entry_id: approval.doaEntryId,
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
    const persisted = await persistEvent(event as any, auditCtxFor(req, actor, 201));
    // AD-16: always use persisted.stream_id, never the locally minted eco_id - an idempotency-key
    // hit returns the EXISTING event, which may carry a different eco_id than this request minted.
    const effectiveEcoId = persisted.stream_id ?? ecoId;
    const eco = await getEcoById(effectiveEcoId);
    sendJson(res, 201, eco);
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

const listEcosBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const bomId = url.searchParams.get('bom_id') ?? undefined;
  const status = url.searchParams.get('status') as EcoRow['status'] | null;
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  const limit = /^\d+$/.test(limitParam ?? '')
    ? Math.max(Math.min(Number(limitParam), 200), 1)
    : 200;
  const offset = /^\d+$/.test(offsetParam ?? '') ? Math.min(Number(offsetParam), 1_000_000) : 0;

  const result = await listEcos({
    bomId,
    status: status ?? undefined,
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

const getEcoBase: RouteHandler = async (req, res, params) => {
  const ecoId = params?.ecoId as string;
  if (!ecoId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'ecoId is required');
    return;
  }

  const eco = await getEcoById(ecoId);
  if (!eco) {
    sendRequestError(req, res, 404, 'ECO_NOT_FOUND', 'ECO not found');
    return;
  }

  const changes = await getEcoChangeLines(ecoId);
  const dispositions = eco.status === 'cancelled' ? [] : await getEcoDispositions(ecoId);

  sendJson(res, 200, { ...eco, changes, dispositions });
};

const getEcoImpactBase: RouteHandler = async (req, res, params) => {
  const ecoId = params?.ecoId as string;
  if (!ecoId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'ecoId is required');
    return;
  }

  const impact = await getEcoImpact(ecoId);
  if (!impact) {
    sendRequestError(req, res, 404, 'ECO_NOT_FOUND', 'ECO not found');
    return;
  }

  sendJson(res, 200, impact);
};

type SimpleEventType = 'eco.review_started' | 'eco.approved' | 'eco.cancelled';

function simpleTransitionHandler(eventType: SimpleEventType): RouteHandler {
  return async (req, res, params) => {
    const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
    const actor = actorContext(req);

    const ecoId = params?.ecoId as string;
    if (!ecoId) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'ecoId is required');
      return;
    }

    const eco = await getEcoById(ecoId);
    if (!eco) {
      sendRequestError(req, res, 404, 'ECO_NOT_FOUND', 'ECO not found');
      return;
    }

    // State is checked before authority so a cancelled (or otherwise non-approvable) ECO
    // surfaces ECO_STATE_INVALID (AC 8) for every caller, not just the resolved approver.
    if (eventType === 'eco.approved' && eco.status !== 'under_review') {
      sendRequestError(
        req,
        res,
        409,
        'ECO_STATE_INVALID',
        `Cannot approve an ECO in ${eco.status} state`,
        { eco_id: ecoId, status: eco.status },
      );
      return;
    }

    // AC 7: an approval attempt by a user outside the resolved chain is rejected. Checked here,
    // before building the envelope, mirroring transfer-requests.ts's approver-authority pattern.
    if (eventType === 'eco.approved' && eco.approver_actor_id !== actor.userId) {
      sendRequestError(
        req,
        res,
        403,
        'APPROVAL_REQUIRED',
        'Caller is not the resolved approver for this ECO',
        { caller_user_id: actor.userId },
      );
      return;
    }

    if (eventType === 'eco.cancelled' && !(body.cancel_reason as string | undefined)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'cancel_reason is required');
      return;
    }

    const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
    const payload: Record<string, unknown> = {
      eco_id: ecoId,
      correlation_id: body.correlation_id as string | undefined,
    };
    if (eventType === 'eco.approved') {
      payload.decision_note = body.decision_note as string | undefined;
    }
    if (eventType === 'eco.cancelled') {
      payload.cancel_reason = body.cancel_reason as string;
    }

    const event = {
      stream_type: 'engineering',
      stream_id: ecoId,
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
      const updatedEco = await getEcoById(ecoId);
      sendJson(res, 200, updatedEco);
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
        return;
      }
      throw err;
    }
  };
}

const startEcoReviewBase: RouteHandler = simpleTransitionHandler('eco.review_started');
const approveEcoBase: RouteHandler = simpleTransitionHandler('eco.approved');
const cancelEcoBase: RouteHandler = simpleTransitionHandler('eco.cancelled');

interface DispositionInput {
  lot_id: string;
  sku: string;
  location_id: string;
  disposition: 'use_up' | 'scrap' | 'rework';
  rework_reference?: string;
  notes?: string;
}

const recordEcoDispositionsBase: RouteHandler = async (req, res, params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);

  const ecoId = params?.ecoId as string;
  if (!ecoId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'ecoId is required');
    return;
  }

  const eco = await getEcoById(ecoId);
  if (!eco) {
    sendRequestError(req, res, 404, 'ECO_NOT_FOUND', 'ECO not found');
    return;
  }

  const bom = await getBomById(eco.bom_id);
  if (!bom) {
    sendRequestError(req, res, 404, 'BOM_NOT_FOUND', 'ECO target BOM not found');
    return;
  }

  const dispositions = body.dispositions as DispositionInput[] | undefined;
  if (!Array.isArray(dispositions) || dispositions.length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'dispositions is required and non-empty');
    return;
  }

  // The handler resolves on_hand_qty server-side from stock_balance and never accepts it from
  // the body. The affected set is the ECO parent SKU's owned, lot-tracked, on-hand rows (Dev
  // Notes binding); a disposition for any other SKU would neither satisfy DISPOSITION_REQUIRED
  // nor record anything meaningful, so it is rejected here.
  const resolved: Array<{
    lot_id: string;
    sku: string;
    location_id: string;
    on_hand_qty: string;
    disposition: 'use_up' | 'scrap' | 'rework';
    rework_reference: string | undefined;
    notes: string | undefined;
  }> = [];
  for (const d of dispositions) {
    if (d.sku !== bom.parent_sku) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        'Disposition SKU does not match the ECO target BOM parent SKU',
        { sku: d.sku, parent_sku: bom.parent_sku },
      );
      return;
    }
    const balances = await getStockBalancesBySku(d.sku);
    const match = balances.find((b) => b.lot_id === d.lot_id && b.location_id === d.location_id);
    if (!match) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        'No stock balance found for the given lot_id, sku, and location_id',
        { lot_id: d.lot_id, sku: d.sku, location_id: d.location_id },
      );
      return;
    }
    // The exact NUMERIC text comes from the database, not from the JS-coerced balance row, so
    // the recorded quantity keeps its stored scale (exact-decimal-strings binding rule).
    const exactBalance = await getPool().query(
      `SELECT on_hand::text AS on_hand FROM stock_balance
        WHERE sku = $1 AND lot_id = $2 AND location_id = $3 AND stock_class = 'owned' LIMIT 1`,
      [d.sku, d.lot_id, d.location_id],
    );
    resolved.push({
      lot_id: d.lot_id,
      sku: d.sku,
      location_id: d.location_id,
      on_hand_qty: (exactBalance.rows[0]?.on_hand as string | undefined) ?? String(match.on_hand),
      disposition: d.disposition,
      rework_reference: d.rework_reference,
      notes: d.notes,
    });
  }

  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
  const correlationId = body.correlation_id as string | undefined;

  const event = {
    stream_type: 'engineering',
    stream_id: ecoId,
    event_type: 'eco.stock_disposition_recorded',
    payload: {
      eco_id: ecoId,
      dispositions: resolved,
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
    await persistEvent(event as any, auditCtxFor(req, actor, 200));
    const updatedEco = await getEcoById(ecoId);
    const updatedDispositions = await getEcoDispositions(ecoId);
    sendJson(res, 200, { ...updatedEco, dispositions: updatedDispositions });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

const implementEcoBase: RouteHandler = async (req, res, params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const actor = actorContext(req);

  const ecoId = params?.ecoId as string;
  if (!ecoId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'ecoId is required');
    return;
  }

  const eco = await getEcoById(ecoId);
  if (!eco) {
    sendRequestError(req, res, 404, 'ECO_NOT_FOUND', 'ECO not found');
    return;
  }

  // new_revision_id and new_revision_code are computed at CAPTURE time and stored in the payload
  // so replay is deterministic - revision counts drift over time (the same rule Story 5.2
  // applied to the legacy-kit migration outcome field).
  const existingRevisions = await getBomRevisionByBomId(eco.bom_id);
  const newRevisionId = randomUUID();
  const newRevisionCode = nextRevisionCode(existingRevisions.length);

  const idempotencyKey = (body.idempotency_key as string) ?? randomUUID();
  const correlationId = body.correlation_id as string | undefined;

  const event = {
    stream_type: 'engineering',
    stream_id: ecoId,
    event_type: 'eco.implemented',
    payload: {
      eco_id: ecoId,
      new_revision_id: newRevisionId,
      new_revision_code: newRevisionCode,
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
    await persistEvent(event as any, auditCtxFor(req, actor, 200));
    const updatedEco = await getEcoById(ecoId);
    // Dev Note (binding): lots with lot_id IS NULL are excluded from the disposition set
    // (uq_eco_disposition_lot cannot key them); record the exclusion visibly rather than silently.
    const bom = await getBomById(updatedEco?.bom_id ?? '');
    let excludedLotCount = 0;
    if (bom) {
      const excludedResult = await getPool().query(
        `SELECT COUNT(*)::int AS cnt FROM stock_balance
          WHERE sku = $1 AND on_hand > 0 AND lot_id IS NULL`,
        [bom.parent_sku],
      );
      excludedLotCount = (excludedResult.rows[0]?.cnt as number) ?? 0;
    }
    sendJson(res, 200, { ...updatedEco, excluded_lot_count: excludedLotCount });
  } catch (err: unknown) {
    if (err instanceof AppError) {
      sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
      return;
    }
    throw err;
  }
};

export const raiseEcoHandler = requireRole({ module: 'engineering', functionScope: 'write' })(
  raiseEcoBase,
);

export const listEcosHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  listEcosBase,
);

export const getEcoHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  getEcoBase,
);

export const getEcoImpactHandler = requireRole({ module: 'engineering', functionScope: 'read' })(
  getEcoImpactBase,
);

export const startEcoReviewHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(startEcoReviewBase);

export const approveEcoHandler = requireRole({ module: 'engineering', functionScope: 'write' })(
  approveEcoBase,
);

export const recordEcoDispositionsHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(recordEcoDispositionsBase);

export const implementEcoHandler = requireRole({
  module: 'engineering',
  functionScope: 'write',
})(implementEcoBase);

export const cancelEcoHandler = requireRole({ module: 'engineering', functionScope: 'write' })(
  cancelEcoBase,
);

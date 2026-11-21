import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import { getPool } from '../../config/db.js';
import { getPurchaseOrderByRef } from '../../read/projections/erp_purchase_order.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import { getGateEventById } from '../../read/projections/gate_event.js';
import { getGrnById } from '../../read/projections/grn.js';
import { getGrnLineById } from '../../read/projections/grn_line.js';
import { getPutawayTaskByGrnLine } from '../../read/projections/putaway_task.js';
import {
  getReceivingExceptionBySource,
  listReceivingExceptions,
  readOverToleranceFacts,
} from '../../read/projections/receiving_exception.js';
import type { ReceivingExceptionStatus } from '../../read/projections/receiving_exception.js';
import {
  actorContext,
  assertRoleAllowed,
  assertSiteAccess,
  auditCtxFor,
  receivingScope,
} from './receiving.js';
import { gateEventToJson } from './gate.js';

// Story 3.19: the unloading supervisor's exception commands. Receiving write alone is not enough
// (store_assistant holds it too), so every handler also checks the resolver role allowlist.
const RESOLVER_ROLES = ['unloading_supervisor', 'warehouse_manager'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 500;
const PO_REF_MAX = 64;
const STATUSES = new Set(['open', 'sent_to_procurement', 'resolved']);

function readNote(body: Record<string, unknown> | undefined, key: string): string | null {
  const raw = body?.[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string')
    throw new AppError(400, 'INVALID_PARAMS', `${key} must be a string when supplied`);
  const value = raw.trim();
  if (value.length > NOTE_MAX)
    throw new AppError(400, 'INVALID_PARAMS', `${key} must be at most ${NOTE_MAX} characters`);
  return value.length > 0 ? value : null;
}

function pathUuid(params: Record<string, string>, key: string): string {
  const v = params[key]?.toLowerCase();
  if (!v || !UUID_REGEX.test(v))
    throw new AppError(400, 'INVALID_PARAMS', `${key} path parameter must be a UUID`);
  return v;
}

function bodyOf(req: IncomingMessage): Record<string, unknown> | undefined {
  return getParsedBody(req) as Record<string, unknown> | undefined;
}

async function loadResolvableGateEvent(req: IncomingMessage, gateEventId: string) {
  const existing = await getGateEventById(gateEventId);
  if (!existing)
    throw new AppError(404, 'GATE_EVENT_NOT_FOUND', `No gate event exists for "${gateEventId}"`, {
      gate_event_id: gateEventId,
    });
  assertSiteAccess(req, existing.site_id, 'write');
  if (existing.binding_status !== 'unmatched' || existing.status !== 'open')
    throw new AppError(
      409,
      'GATE_EVENT_NOT_UNMATCHED',
      'Only an open unmatched gate event can be resolved',
      { gate_event_id: gateEventId },
    );
  return existing;
}

const matchPoBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, RESOLVER_ROLES, 'write');
  const gateEventId = pathUuid(params, 'gateEventId');
  const body = bodyOf(req);
  const poRef = typeof body?.['po_ref_ext'] === 'string' ? body['po_ref_ext'].trim() : '';
  if (!poRef || poRef.length > PO_REF_MAX) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      `po_ref_ext is required (1 to ${PO_REF_MAX} characters)`,
    );
    return;
  }
  const note = readNote(body, 'note');
  const existing = await loadResolvableGateEvent(req, gateEventId);
  const po = await getPurchaseOrderByRef(poRef);
  if (!po || po.status !== 'open')
    throw new AppError(409, 'PO_NOT_OPEN', `No open PO exists for "${poRef}"`, {
      po_ref_ext: poRef,
    });
  const actor = actorContext(req);
  await persistEvent(
    {
      stream_type: 'gate',
      stream_id: gateEventId,
      event_type: 'gate.matched',
      payload: {
        gate_event_id: gateEventId,
        po_ref_ext: poRef,
        match_note: note,
        matched_by: actor.userId,
      },
      metadata: {
        correlation_id: existing.correlation_id,
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 200),
  );
  const saved = await getGateEventById(gateEventId);
  const exception = await getReceivingExceptionBySource('unmatched_vehicle', gateEventId);
  sendJson(res, 200, { gate_event: gateEventToJson(saved!), exception });
};

const sendToProcurementBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, RESOLVER_ROLES, 'write');
  const gateEventId = pathUuid(params, 'gateEventId');
  const note = readNote(bodyOf(req), 'note');
  const existing = await loadResolvableGateEvent(req, gateEventId);
  if (existing.resolved_at)
    throw new AppError(
      409,
      'GATE_EVENT_ALREADY_RESOLVED',
      'This gate event was already sent to procurement',
      { gate_event_id: gateEventId },
    );
  const actor = actorContext(req);
  await persistEvent(
    {
      stream_type: 'gate',
      stream_id: gateEventId,
      event_type: 'gate.sent_to_procurement',
      payload: { gate_event_id: gateEventId, note, sent_by: actor.userId },
      metadata: {
        correlation_id: existing.correlation_id,
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 200),
  );
  const saved = await getGateEventById(gateEventId);
  const exception = await getReceivingExceptionBySource('unmatched_vehicle', gateEventId);
  sendJson(res, 200, { gate_event: gateEventToJson(saved!), exception });
};

const acceptWithinBandBase: RouteHandler = async (req, res, params) => {
  assertRoleAllowed(req, RESOLVER_ROLES, 'write');
  const grnLineId = pathUuid(params, 'grnLineId');
  const note = readNote(bodyOf(req), 'note');
  const actor = actorContext(req);
  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT l.status, l.line_condition, l.po_ref_ext, l.resolved_at, l.source_event_id, g.site_id
         FROM grn_line l JOIN grn g ON g.grn_id = l.grn_id
        WHERE l.grn_line_id = $1 FOR UPDATE OF l`,
      [grnLineId],
    );
    if (locked.rows.length === 0)
      throw new AppError(404, 'GRN_LINE_NOT_FOUND', `No GRN line exists for "${grnLineId}"`, {
        grn_line_id: grnLineId,
      });
    const row = locked.rows[0]!;
    assertSiteAccess(req, row['site_id'] as string, 'write');
    if (row['status'] !== 'rejected' || row['line_condition'] !== 'GOOD' || !row['po_ref_ext'])
      throw new AppError(
        409,
        'GRN_LINE_NOT_REJECTED',
        'Only a GOOD line rejected over tolerance can be accepted within the band',
        { grn_line_id: grnLineId },
      );
    if (row['resolved_at'])
      throw new AppError(409, 'GRN_LINE_ALREADY_RESOLVED', 'This GRN line is already resolved', {
        grn_line_id: grnLineId,
      });
    // Takes the PO line advisory lock; the goods.received applier re-takes it and re-checks the cap.
    const facts = await readOverToleranceFacts(grnLineId, client);
    if (!facts)
      throw new AppError(
        404,
        'RECEIVING_PO_NOT_FOUND',
        'The PO line behind this GRN line is gone',
        {
          grn_line_id: grnLineId,
        },
      );
    if (Number(facts.accept_qty) <= 0)
      throw new AppError(
        409,
        'RECEIPT_BAND_EXHAUSTED',
        'The PO line has no room left inside the over-receipt band',
        { grn_line_id: grnLineId },
      );
    const original = await client.query(`SELECT payload FROM domain_events WHERE event_id = $1`, [
      row['source_event_id'],
    ]);
    if (original.rows.length === 0)
      throw new AppError(
        404,
        'GRN_LINE_NOT_FOUND',
        'The goods.received event behind this line is missing',
        { grn_line_id: grnLineId },
      );
    const payload = { ...(original.rows[0]!['payload'] as Record<string, unknown>) };
    for (const key of [
      'reason_code',
      'reason_detail',
      'reason_note',
      'reason_photo_ref',
      'serials',
      'serial_numbers',
      'erp_receipt_overlap_qty',
    ])
      delete payload[key];
    const acceptedLineId = randomUUID();
    payload['grn_line_id'] = acceptedLineId;
    payload['received_qty'] = facts.accept_qty;
    payload['line_condition'] = 'GOOD';
    payload['received_by'] = actor.userId;
    if (typeof payload['cross_dock_task_id'] === 'string')
      payload['cross_dock_task_id'] = randomUUID();
    const grnId = payload['grn_id'] as string;
    const correlationId = (payload['correlation_id'] as string | undefined) ?? randomUUID();
    const metadata = {
      correlation_id: correlationId,
      actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
      occurred_at: new Date().toISOString(),
    };
    await persistEvent(
      {
        stream_type: 'receiving',
        stream_id: grnId,
        event_type: 'goods.received',
        payload,
        metadata,
      },
      auditCtxFor(req, actor, 200),
      client,
    );
    await persistEvent(
      {
        stream_type: 'receiving',
        stream_id: grnId,
        event_type: 'goods.over_tolerance_accepted',
        payload: {
          grn_line_id: grnLineId,
          accepted_grn_line_id: acceptedLineId,
          accepted_qty: facts.accept_qty,
          excess_qty: facts.excess_qty,
          counted_qty: facts.counted_qty,
          ordered_qty: facts.ordered_qty,
          already_received_qty: facts.already_received_qty,
          tolerance_pct: facts.tolerance_pct,
          cap_qty: facts.cap_qty,
          note,
          resolved_by: actor.userId,
        },
        metadata,
      },
      auditCtxFor(req, actor, 200),
      client,
    );
    const acceptedLine = await getGrnLineById(acceptedLineId, client);
    const grn = acceptedLine ? await getGrnById(acceptedLine.grn_id, client) : null;
    const putaway = await getPutawayTaskByGrnLine(acceptedLineId, client);
    const exception = await getReceivingExceptionBySource('over_tolerance', grnLineId, client);
    await client.query('COMMIT');
    committed = true;
    sendJson(res, 200, { exception, grn, grn_line: acceptedLine, putaway_task: putaway });
  } catch (err) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const listExceptionsBase: RouteHandler = async (req, res) => {
  assertRoleAllowed(req, RESOLVER_ROLES, 'read');
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const status = url.searchParams.get('status');
  if (status !== null && !STATUSES.has(status)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      "status filter must be 'open', 'sent_to_procurement' or 'resolved'",
    );
    return;
  }
  const siteCode = url.searchParams.get('site');
  const scope = receivingScope(req, 'read');
  let siteId: string | null = null;
  let siteAny: string[] | null = null;
  if (siteCode) {
    const site = await getLocationByCode(siteCode);
    if (!site || site.status !== 'active' || site.level !== 'site')
      throw new AppError(
        404,
        'RECEIVING_SITE_NOT_FOUND',
        `No active site exists for "${siteCode}"`,
      );
    if (!scope.wildcard && !scope.locations.has(site.location_id))
      throw new AppError(
        403,
        'LOCATION_ACCESS_DENIED',
        `No read assignment grants access to site "${site.location_id}"`,
      );
    siteId = site.location_id;
  } else if (!scope.wildcard) {
    siteAny = [...scope.locations];
  }
  const exceptions = await listReceivingExceptions({
    siteId,
    siteAny,
    status: status as ReceivingExceptionStatus | null,
  });
  sendJson(res, 200, { exceptions });
};

const write = { module: 'receiving', functionScope: 'write' } as const;
const read = { module: 'receiving', functionScope: 'read' } as const;
export const matchGateEventToPoHandler: RouteHandler = requireRole(write)(matchPoBase);
export const sendGateEventToProcurementHandler: RouteHandler =
  requireRole(write)(sendToProcurementBase);
export const acceptWithinBandHandler: RouteHandler = requireRole(write)(acceptWithinBandBase);
export const listReceivingExceptionsHandler: RouteHandler = requireRole(read)(listExceptionsBase);

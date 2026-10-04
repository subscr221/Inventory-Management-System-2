import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getAuthContext, getParsedBody } from '../../middleware/context.js';
import type { AuthContext } from '../../middleware/context.js';
import {
  requireRole,
  assignmentCoversLocation,
  permittedLocationsForModule,
  permittedLocationsForModuleScope,
  EMPLOYEE_MODULE,
} from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { EventEnvelope } from '../../events/store.js';
import { getPool } from '../../config/db.js';
import {
  actorContext,
  auditCtxFor,
  auditRejectedAttempt,
  idempotencyKeyFrom,
  replayIdOrReject,
} from './quality.js';
import type { ActorContext } from './quality.js';
import {
  DAMAGE_CUSTODY_MODULES,
  DAMAGE_DECISION_MODULES,
  DAMAGE_INSPECTION_MODULES,
  DAMAGE_REPORTED,
  DAMAGE_UNITS_ARRIVED,
  DAMAGE_SENT_FOR_EXTERNAL_CHECK,
  DAMAGE_RETURNED_FROM_EXTERNAL_CHECK,
  DAMAGE_RETURNED_TO_STOCK,
  DAMAGE_INSPECTED,
  DAMAGE_WHOLE_LOT_DECIDED,
  DAMAGE_KEY_TURNED,
  DAMAGE_KEY_WITHDRAWN,
  DAMAGE_DISAGREED,
  DAMAGE_ESCALATION_DECIDED,
  DAMAGE_OUTCOME_RECORDED,
  DAMAGE_STREAM_TYPE,
  allowedDamageActions,
  damageAuthorityTypesFor,
  hasModuleWriteAt,
  isPendingStepAuthority,
} from '../../compliance/damage.js';
import type { DamageCaller } from '../../compliance/damage.js';
import {
  displayNamesFor,
  getDamageReportById,
  listDamageActions,
  listDamageReports,
  listOpenDamageReports,
} from '../../read/projections/damage_report.js';
import type { DamageReportRow, DamageStatus } from '../../read/projections/damage_report.js';

// ---------------------------------------------------------------------------
// Story 8.9: the damage-case routes. Thin shells (AD-12): each authorizes the hat, shapes the body
// and calls persistEvent; the state machine, the DOA authority and the separation rules all live in
// src/compliance/damage.ts, so the detail's allowed_actions and these routes cannot drift apart.
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAMAGE_READ_MODULES = [EMPLOYEE_MODULE, 'qc', 'warehouse', 'compliance'];
const DAMAGE_STATUSES: readonly DamageStatus[] = [
  'on_hold',
  'cleared',
  'awaiting_keys',
  'escalated',
  'outcome_final',
  'closed',
];
const MAX_LIST_LIMIT = 200;

/**
 * Refused decisions are statutory records (the 8.3 lesson: every code a route in THIS file can
 * surface is listed, none that it cannot).
 */
const AUDITED_REJECTIONS = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_UNRESOLVED',
  'SOD_VIOLATION',
  'LOCATION_ACCESS_DENIED',
  'DAMAGE_REPORT_NOT_FOUND',
  'DAMAGE_CASE_STATE_INVALID',
  'DAMAGE_CASE_LOCKED',
  'DAMAGE_PHYSICAL_STATE_INVALID',
  'DAMAGE_UNITS_OUT',
  'DAMAGE_OUTCOME_INVALID',
  'DAMAGE_OUTCOME_MISMATCH',
  'DAMAGE_KEY_ALREADY_TURNED',
  'DAMAGE_KEY_NOT_TURNED',
  'DAMAGE_WHOLE_LOT_NOT_PENDING',
  'DAMAGE_QUANTITY_INVALID',
  'DAMAGE_LOT_NOT_FOUND',
  'DEFECT_CODE_UNKNOWN',
  'HOLD_EXISTS',
  'DAMAGE_PHOTO_NOT_OWNED',
]);

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function bodyOf(req: IncomingMessage): Record<string, unknown> {
  const body = getParsedBody(req);
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) {
    throw new AppError(400, 'INVALID_PARAMS', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireAuth(req: IncomingMessage): AuthContext {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return authContext;
}

function callerOf(authContext: AuthContext): DamageCaller {
  return {
    userId: authContext.userId,
    roles: authContext.roles,
    coversLocation: (assignment, locationId) =>
      assignmentCoversLocation(
        assignment as Parameters<typeof assignmentCoversLocation>[0],
        locationId,
      ),
  };
}

function sendAppError(req: IncomingMessage, res: Parameters<RouteHandler>[1], err: unknown): void {
  if (err instanceof AppError) {
    sendRequestError(req, res, err.statusCode, err.errorCode, err.message, err.details);
    return;
  }
  throw err;
}

/** A trimmed optional string, or null; the shape assert bounds it. */
function optional(body: Record<string, unknown>, field: string): unknown {
  const value = body[field];
  return value === undefined || value === '' ? null : value;
}

/** Quantities are decimal strings on the wire; a JSON number is accepted and kept exact as text. */
function decimal(value: unknown): unknown {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
}

// ---------------------------------------------------------------------------
// Presentation (D11): display names, photo status, the replacement indent
// ---------------------------------------------------------------------------

export async function presentReport(row: DamageReportRow): Promise<Record<string, unknown>> {
  const names = await displayNamesFor([
    row.reporter_user_id,
    row.qc_key_user_id,
    row.finance_key_user_id,
    row.escalation_user_id,
    row.inspected_by,
  ]);
  const pool = getPool();
  const photo = row.photo_attachment_id
    ? await pool.query(`SELECT 1 FROM attachment WHERE attachment_id = $1`, [
        row.photo_attachment_id,
      ])
    : { rows: [] };
  const indent = row.replacement_indent_id
    ? await pool.query(`SELECT indent_number_ext, status FROM indent WHERE indent_id = $1`, [
        row.replacement_indent_id,
      ])
    : { rows: [] };
  return {
    ...row,
    reporter_display_name: names.get(row.reporter_user_id) ?? null,
    qc_key_display_name: row.qc_key_user_id ? (names.get(row.qc_key_user_id) ?? null) : null,
    finance_key_display_name: row.finance_key_user_id
      ? (names.get(row.finance_key_user_id) ?? null)
      : null,
    escalation_display_name: row.escalation_user_id
      ? (names.get(row.escalation_user_id) ?? null)
      : null,
    inspected_by_display_name: row.inspected_by ? (names.get(row.inspected_by) ?? null) : null,
    photo_status:
      row.photo_attachment_id === null ? null : photo.rows.length > 0 ? 'stored' : 'pending',
    replacement_indent_number:
      (indent.rows[0]?.['indent_number_ext'] as string | undefined) ?? null,
    replacement_status: (indent.rows[0]?.['status'] as string | undefined) ?? null,
  };
}

/**
 * D11: the reporter, a qc or warehouse holder at the case site, or the resolved DOA authority of
 * any damage type may read a case; anyone else is refused, never shown an empty case.
 */
export async function canSeeDamageReport(
  authContext: AuthContext,
  row: DamageReportRow,
): Promise<boolean> {
  if (row.reporter_user_id === authContext.userId) return true;
  for (const module of ['qc', 'warehouse']) {
    const scope = permittedLocationsForModule(authContext.roles, module);
    if (scope.wildcard || scope.locations.has(row.site_id)) return true;
  }
  return (await damageAuthorityTypesFor(authContext.userId)).length > 0;
}

// ---------------------------------------------------------------------------
// Capture (AC 1, 2, 5)
// ---------------------------------------------------------------------------

const createDamageReportBase: RouteHandler = async (req, res) => {
  const body = bodyOf(req);
  const actor = actorContext(req);
  const reportId = isUuid(body['report_id']) ? body['report_id'] : randomUUID();
  const siteId = body['site_id'];
  const envelope: EventEnvelope = {
    stream_type: DAMAGE_STREAM_TYPE,
    stream_id: reportId,
    event_type: DAMAGE_REPORTED,
    payload: {
      report_id: reportId,
      site_id: siteId,
      // D3: always the authenticated actor; the applier stamps it again.
      reporter_user_id: actor.userId,
      sku: body['sku'],
      lot_number: optional(body, 'lot_number'),
      quantity: decimal(body['quantity']),
      found_at: body['found_at'],
      bin_code: optional(body, 'bin_code'),
      reason_code: body['reason_code'],
      reason_note: optional(body, 'reason_note'),
      photo_attachment_id: body['photo_attachment_id'],
      whole_lot_requested: body['whole_lot_requested'] ?? false,
      replacement_indent_id: optional(body, 'replacement_indent_id'),
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: isUuid(siteId) ? siteId : actor.eventLocationId,
      },
      occurred_at: new Date().toISOString(),
    },
    idempotency_key: idempotencyKeyFrom(body),
  };
  // AD-16: a replay of the same idempotency key is 409 DUPLICATE_EVENT with the existing event id,
  // exactly like the edge door; never a check-then-act.
  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 201), undefined, {
    strictDuplicate: true,
  });
  const row = await getDamageReportById(replayIdOrReject(persisted, DAMAGE_REPORTED, 'report_id'));
  sendJson(res, 201, {
    event_id: persisted.event_id,
    report: row ? await presentReport(row) : null,
  });
};

/** D3: reporting is a base-hat act, site-scoped on the body's site. */
export const createDamageReportHandler = requireRole({
  module: EMPLOYEE_MODULE,
  functionScope: 'write',
  locationId: (_params, body) => {
    const siteId = (body as Record<string, unknown> | undefined)?.['site_id'];
    return isUuid(siteId) ? siteId : undefined;
  },
})(createDamageReportBase);

// ---------------------------------------------------------------------------
// Case actions: one shell for all ten
// ---------------------------------------------------------------------------

interface CaseActionSpec {
  eventType: string;
  /** Modules whose write assignment must cover the case site; null = the hat alone (DOA decides). */
  siteModules: readonly string[] | null;
  payload: (
    body: Record<string, unknown>,
    params: Record<string, string>,
  ) => Record<string, unknown>;
}

function caseActionBase(spec: CaseActionSpec): RouteHandler {
  return async (req, res, params) => {
    const actor: ActorContext = actorContext(req);
    let reportId: string | null = null;
    let siteId: string | undefined;
    try {
      const body = bodyOf(req);
      reportId = params?.['reportId'] ?? null;
      if (!isUuid(reportId)) throw new AppError(400, 'INVALID_PARAMS', 'reportId must be a UUID');
      const row = await getDamageReportById(reportId);
      if (!row) {
        throw new AppError(404, 'DAMAGE_REPORT_NOT_FOUND', 'The damage report does not resolve', {
          report_id: reportId,
        });
      }
      siteId = row.site_id;
      if (spec.siteModules !== null) {
        const authContext = requireAuth(req);
        if (!hasModuleWriteAt(callerOf(authContext), spec.siteModules, row.site_id)) {
          throw new AppError(
            403,
            'LOCATION_ACCESS_DENIED',
            `No write assignment grants this action at site "${row.site_id}"`,
            { site_id: row.site_id },
          );
        }
      }
      const eventId = randomUUID();
      const persisted = await persistEvent(
        {
          event_id: eventId,
          stream_type: DAMAGE_STREAM_TYPE,
          stream_id: reportId,
          event_type: spec.eventType,
          payload: { report_id: reportId, ...spec.payload(body, params ?? {}) },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: idempotencyKeyFrom(body),
        },
        auditCtxFor(req, actor, 201),
      );
      replayIdOrReject(persisted, spec.eventType, 'report_id');
      const refreshed = await getDamageReportById(reportId);
      sendJson(res, persisted.event_id === eventId ? 201 : 200, {
        event_id: persisted.event_id,
        report: refreshed ? await presentReport(refreshed) : null,
      });
    } catch (err: unknown) {
      if (err instanceof AppError && AUDITED_REJECTIONS.has(err.errorCode)) {
        await auditRejectedAttempt(req, actor, err, { report_id: reportId }, siteId);
      }
      sendAppError(req, res, err);
    }
  };
}

function keyParam(params: Record<string, string>): string {
  const key = params['key'];
  if (key !== 'qc' && key !== 'finance') {
    throw new AppError(400, 'INVALID_PARAMS', 'key must be qc or finance');
  }
  return key;
}

const custodyGate = requireRole({ module: [...DAMAGE_CUSTODY_MODULES], functionScope: 'write' });
const inspectionGate = requireRole({
  module: [...DAMAGE_INSPECTION_MODULES],
  functionScope: 'write',
});
const decisionGate = requireRole({ module: [...DAMAGE_DECISION_MODULES], functionScope: 'write' });

export const markArrivedHandler = custodyGate(
  caseActionBase({
    eventType: DAMAGE_UNITS_ARRIVED,
    siteModules: DAMAGE_CUSTODY_MODULES,
    payload: (body) => ({ note: optional(body, 'note') }),
  }),
);

export const sendExternalHandler = custodyGate(
  caseActionBase({
    eventType: DAMAGE_SENT_FOR_EXTERNAL_CHECK,
    siteModules: DAMAGE_CUSTODY_MODULES,
    payload: (body) => ({
      destination: body['destination'],
      reason: body['reason'],
      expected_return_date: optional(body, 'expected_return_date'),
      gate_pass_ref_ext: optional(body, 'gate_pass_ref_ext'),
    }),
  }),
);

export const markReturnedHandler = custodyGate(
  caseActionBase({
    eventType: DAMAGE_RETURNED_FROM_EXTERNAL_CHECK,
    siteModules: DAMAGE_CUSTODY_MODULES,
    payload: (body) => ({
      note: optional(body, 'note'),
      external_result_ref_ext: optional(body, 'external_result_ref_ext'),
    }),
  }),
);

export const markReturnedToStockHandler = custodyGate(
  caseActionBase({
    eventType: DAMAGE_RETURNED_TO_STOCK,
    siteModules: DAMAGE_CUSTODY_MODULES,
    payload: (body) => ({ note: optional(body, 'note') }),
  }),
);

export const inspectDamageHandler = inspectionGate(
  caseActionBase({
    eventType: DAMAGE_INSPECTED,
    siteModules: DAMAGE_INSPECTION_MODULES,
    payload: (body) => ({
      confirmed_quantity: decimal(body['confirmed_quantity']),
      defect_code: optional(body, 'defect_code'),
      note: optional(body, 'note'),
    }),
  }),
);

export const decideWholeLotHandler = decisionGate(
  caseActionBase({
    eventType: DAMAGE_WHOLE_LOT_DECIDED,
    siteModules: null,
    payload: (body) => ({ decision: body['decision'], reason: body['reason'] }),
  }),
);

export const turnKeyHandler = decisionGate(
  caseActionBase({
    eventType: DAMAGE_KEY_TURNED,
    siteModules: null,
    payload: (body, params) => ({
      key: keyParam(params),
      outcome: body['outcome'],
      price_reduction_pct: decimal(optional(body, 'price_reduction_pct')),
      note: optional(body, 'note'),
    }),
  }),
);

export const withdrawKeyHandler = decisionGate(
  caseActionBase({
    eventType: DAMAGE_KEY_WITHDRAWN,
    siteModules: null,
    payload: (body, params) => ({ key: keyParam(params), reason: body['reason'] }),
  }),
);

export const disagreeKeyHandler = decisionGate(
  caseActionBase({
    eventType: DAMAGE_DISAGREED,
    siteModules: null,
    payload: (body, params) => ({
      key: keyParam(params),
      proposed_outcome: body['proposed_outcome'],
      price_reduction_pct: decimal(optional(body, 'price_reduction_pct')),
      reason: body['reason'],
    }),
  }),
);

export const decideEscalationHandler = decisionGate(
  caseActionBase({
    eventType: DAMAGE_ESCALATION_DECIDED,
    siteModules: null,
    payload: (body) => ({
      outcome: body['outcome'],
      price_reduction_pct: decimal(optional(body, 'price_reduction_pct')),
      reason: body['reason'],
    }),
  }),
);

export const recordOutcomeHandler = decisionGate(
  caseActionBase({
    eventType: DAMAGE_OUTCOME_RECORDED,
    siteModules: null,
    payload: (body) => ({
      erp_document_ref_ext: body['erp_document_ref_ext'] ?? null,
      note: optional(body, 'note'),
    }),
  }),
);

// ---------------------------------------------------------------------------
// Reads (AC 8, D11)
// ---------------------------------------------------------------------------

const getDamageReportBase: RouteHandler = async (req, res, params) => {
  const authContext = requireAuth(req);
  const reportId = params?.['reportId'];
  if (!isUuid(reportId)) throw new AppError(400, 'INVALID_PARAMS', 'reportId must be a UUID');
  const row = await getDamageReportById(reportId);
  if (!row) {
    throw new AppError(404, 'DAMAGE_REPORT_NOT_FOUND', 'The damage report does not resolve', {
      report_id: reportId,
    });
  }
  if (!(await canSeeDamageReport(authContext, row))) {
    throw new AppError(403, 'FUNCTION_ACCESS_DENIED', 'This damage report is not visible to you', {
      report_id: reportId,
    });
  }
  const [report, allowed, history] = await Promise.all([
    presentReport(row),
    allowedDamageActions(row, callerOf(authContext)),
    listDamageActions(row.report_id),
  ]);
  sendJson(res, 200, { report, allowed_actions: allowed, history });
};

const listDamageReportsBase: RouteHandler = async (req, res) => {
  const authContext = requireAuth(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const view = url.searchParams.get('view') ?? 'mine';
  if (view !== 'mine' && view !== 'workbench') {
    throw new AppError(400, 'INVALID_PARAMS', 'view must be mine or workbench');
  }
  const siteParam = url.searchParams.get('site_id');
  if (siteParam !== null && !isUuid(siteParam)) {
    throw new AppError(400, 'INVALID_PARAMS', 'site_id must be a UUID');
  }
  const statusParam = url.searchParams.get('status');
  if (statusParam !== null && !DAMAGE_STATUSES.includes(statusParam as DamageStatus)) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `status must be one of: ${DAMAGE_STATUSES.join(', ')}`,
    );
  }
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam === null ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`,
    );
  }
  const common = {
    ...(siteParam !== null ? { siteId: siteParam } : {}),
    ...(statusParam !== null ? { status: statusParam as DamageStatus } : {}),
    limit,
  };

  let rows: DamageReportRow[];
  if (view === 'mine') {
    rows = await listDamageReports({ reporterUserId: authContext.userId, ...common });
  } else {
    // D11: cases at sites where the caller holds qc or warehouse, plus cases where the caller is the
    // resolved authority of a step still pending. Neither: refused, never a silent empty list.
    const sites = new Set<string>();
    let wildcard = false;
    for (const module of ['qc', 'warehouse']) {
      const scope = permittedLocationsForModuleScope(authContext.roles, module, 'read');
      wildcard ||= scope.wildcard;
      for (const id of scope.locations) sites.add(id);
    }
    const authorityTypes = await damageAuthorityTypesFor(authContext.userId);
    if (!wildcard && sites.size === 0 && authorityTypes.length === 0) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        'The damage workbench needs a QC or stores assignment or a damage DOA authority; use view=mine',
      );
    }
    const extra: string[] = [];
    if (authorityTypes.length > 0) {
      for (const row of await listOpenDamageReports()) {
        const acted =
          row.qc_key_user_id === authContext.userId ||
          row.finance_key_user_id === authContext.userId ||
          row.escalation_user_id === authContext.userId ||
          row.outcome_recorded_by === authContext.userId ||
          row.whole_lot_decided_by === authContext.userId;
        if (acted || (await isPendingStepAuthority(row, authContext.userId)))
          extra.push(row.report_id);
      }
    }
    rows = await listDamageReports({
      siteScope: { wildcard, sites: [...sites] },
      extraReportIds: extra,
      ...common,
    });
  }
  const reports = [];
  for (const row of rows) reports.push(await presentReport(row));
  sendJson(res, 200, { reports });
};

export const getDamageReportHandler = requireRole({
  module: DAMAGE_READ_MODULES,
  functionScope: 'read',
})(getDamageReportBase);

export const listDamageReportsHandler = requireRole({
  module: DAMAGE_READ_MODULES,
  functionScope: 'read',
})(listDamageReportsBase);

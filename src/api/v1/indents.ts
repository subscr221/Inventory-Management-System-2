import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import {
  requireRole,
  permittedLocationsForModuleScope,
  EMPLOYEE_MODULE,
} from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { randomUUID } from 'node:crypto';
import { config } from '../../config/index.js';

import {
  getIndentById,
  getIndentLines,
  getIndentWithCounts,
  listIndents,
  findOpenDuplicate,
} from '../../read/projections/indent.js';
import { routeIndentLines, headerApproverOf } from '../../compliance/indent-routing.js';
import { rerouteLapsedLinesToDoa } from '../../compliance/standing-reroute.js';
import { toIstCalendarDate } from '../../lib/business-days.js';
import {
  findActiveSelfApprovalLimit,
  getGrantById,
  getGrantLabel,
  monthToDateIssued,
  standingApprovalText,
} from '../../read/projections/standing_grant.js';
import { pendingLineIdsFor } from '../../compliance/indent.js';
import {
  normaliseIssueLines,
  assertHeaderIssuable,
  assertHeaderClosable,
  assertLineIssuable,
} from '../../compliance/indent-issue.js';
import { withOpenQty } from '../../read/projections/indent.js';
import {
  getIndentIssueById,
  getIndentIssueLines,
  listIndentIssuesByIndent,
} from '../../read/projections/indent_issue.js';
import { getLocationByCode } from '../../read/projections/location_register.js';
import type { IndentRow, IndentLineRow } from '../../read/projections/indent.js';
import type { IndentIssueLineRow } from '../../read/projections/indent_issue.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../../read/projections/doa_registry.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
export { INDENT_DOA_TYPE } from '../../compliance/indent-routing.js';

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

export async function resolveApprover(
  transactionType: string,
  value: number | string,
): Promise<{
  requiresApproval: boolean;
  approverActorId: string | null;
  doaEntryId: string | null;
}> {
  const doaEntry = await findMatchingDoaEntry(transactionType, value);
  if (!doaEntry) {
    return { requiresApproval: false, approverActorId: null, doaEntryId: null };
  }

  const today = new Date().toISOString().slice(0, 10);
  const tryHolder = async (role: string): Promise<string | null> => {
    const holder = await findRoleHolder(role);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today);
    return delegation?.delegate_user_id ?? holder.user_id;
  };

  let approver = await tryHolder(doaEntry.role);
  if (!approver) {
    const entries = await listActiveDoaEntries(transactionType);
    for (const e of entries) {
      if (e.role === doaEntry.role) continue;
      approver = await tryHolder(e.role);
      if (approver) break;
    }
  }

  if (!approver) {
    throw new AppError(
      409,
      'APPROVAL_UNRESOLVED',
      'Approval is required but no active approver could be resolved',
      { transaction_type: transactionType },
    );
  }
  return { requiresApproval: true, approverActorId: approver, doaEntryId: doaEntry.entry_id };
}

/**
 * Story 4.8 (Task 4.2, 5.2): what a screen needs to show a standing-approval line - the grant ref,
 * its monthly cap, the quantity issued against it this IST month (the "4 of 6 used" chip) and the
 * D9 sentence. All null for a line that does not ride a grant.
 */
export interface GrantLineView {
  standing_grant_ref: string | null;
  cap: string | null;
  month_to_date_issued: string | null;
  standing_approval_text: string | null;
}

const NO_GRANT_VIEW: GrantLineView = {
  standing_grant_ref: null,
  cap: null,
  month_to_date_issued: null,
  standing_approval_text: null,
};

export async function presentLines<T extends IndentLineRow>(
  lines: T[],
): Promise<Array<T & GrantLineView>> {
  const month = toIstCalendarDate(new Date()).slice(0, 7);
  const cache = new Map<string, GrantLineView>();
  const out: Array<T & GrantLineView> = [];
  for (const line of lines) {
    let view = NO_GRANT_VIEW;
    const gid = line.standing_grant_id;
    if (line.approval_route === 'standing_approval' && gid) {
      let cached = cache.get(gid);
      if (!cached) {
        const grant = await getGrantById(gid);
        if (grant) {
          const label = await getGrantLabel(grant);
          cached = {
            standing_grant_ref: grant.grant_ref,
            cap: grant.monthly_qty_cap,
            month_to_date_issued: await monthToDateIssued(gid, month),
            standing_approval_text: standingApprovalText(
              grant.grant_ref,
              label.grantee_name,
              label.scope_label,
            ),
          };
        } else {
          cached = NO_GRANT_VIEW;
        }
        cache.set(gid, cached);
      }
      view = cached;
    }
    out.push({ ...line, ...view });
  }
  return out;
}

/** D9: a slip line that rode a grant carries the sentence it printed, for the issue screen. */
function presentIssueLines(
  lines: IndentIssueLineRow[],
): Array<IndentIssueLineRow & { standing_approval_text: string | null }> {
  return lines.map((l) => ({
    ...l,
    standing_approval_text: l.standing_grant_id ? l.approval_basis : null,
  }));
}

function assertSiteReadAccess(req: IncomingMessage, siteId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');
  if (!scope.wildcard && !scope.locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No read assignment grants access to site "${siteId}"`,
    );
  }
}

/**
 * Story 1.15 (AC 4): procurement read at the indent's site reads any indent there; without it the
 * caller reads only an indent they raised (the base-role "My requests" detail). A procurement
 * reader scoped elsewhere keeps today's LOCATION_ACCESS_DENIED; a caller with no procurement read
 * at all gets the requester-ownership denial the withdraw route uses.
 */
function assertIndentReadAccess(req: IncomingMessage, indent: IndentRow): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');
  if (scope.wildcard || scope.locations.has(indent.site_id)) return;
  if (indent.requester_user_id === authContext.userId) return;
  if (scope.locations.size > 0) assertSiteReadAccess(req, indent.site_id);
  throw new AppError(403, 'FUNCTION_ACCESS_DENIED', 'Only the requester can view this indent', {
    indent_id: indent.indent_id,
  });
}

interface RaiseLineInput {
  sku: string;
  item_category: string;
  requested_qty: number;
  uom: string;
  unit_price_estimate?: number;
}

export const raiseIndentBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const lines = body.lines as RaiseLineInput[] | undefined;
  if (!Array.isArray(lines) || lines.length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INDENT_LINE_REQUIRED',
      'A requisition requires at least one line item',
    );
    return;
  }

  // AC 2: online duplicate pre-check. A potential duplicate is flagged with DUPLICATE_EVENT and
  // the raise proceeds only after explicit confirmation (confirm_duplicate: true).
  if (body.confirm_duplicate !== true) {
    for (const line of lines) {
      if (typeof line?.sku !== 'string') continue;
      const dup = await findOpenDuplicate(
        actor.userId,
        line.sku.trim(),
        config.indent.duplicateWindowDays,
      );
      if (dup) {
        sendRequestError(
          req,
          res,
          409,
          'DUPLICATE_EVENT',
          `You raised ${dup.indent_number_ext} on ${new Date(dup.created_at).toISOString().slice(0, 10)}. Are you raising a new indent or retrying?`,
          {
            duplicate_of_indent_id: dup.indent_id,
            duplicate_indent_number_ext: dup.indent_number_ext,
            duplicate_status: dup.status,
            sku: line.sku,
            confirmation_required: true,
          },
        );
        return;
      }
    }
  }

  // Story 4.10 (AC 2, AC 6): every line resolves its own DOA band on its own value; a line with no
  // band refuses the whole raise before anything is persisted. The header keeps the approver of
  // the highest-value line for compatibility (D5).
  // Story 4.8 (D6): a line covered by the requester's active standing approval, within its cap,
  // rides the grant; the grant id is decided here on the server, never read from the body.
  const routes = await routeIndentLines(lines, undefined, undefined, {
    requesterUserId: actor.userId,
    siteId: typeof body.site_id === 'string' ? body.site_id : '',
  });
  const approval = headerApproverOf(routes);
  const routedLines = lines.map((line, i) => ({
    ...line,
    approval_route: routes[i]!.approval_route,
    approver_actor_id: routes[i]!.approver_actor_id ?? undefined,
    doa_entry_id: routes[i]!.doa_entry_id ?? undefined,
    standing_grant_id: routes[i]!.standing_grant_id ?? undefined,
  }));

  // Story 8.9 (AC 5, D15): a damage replacement names its case, and its indent id was minted with
  // the report (the report names it back), so the client's id is kept for that raise only. Every
  // other raise keeps a server-minted id exactly as before.
  const damageReportId =
    typeof body.damage_report_id === 'string' ? body.damage_report_id : undefined;
  const indentId =
    damageReportId !== undefined &&
    typeof body.indent_id === 'string' &&
    UUID_REGEX.test(body.indent_id)
      ? body.indent_id
      : randomUUID();
  const now = new Date().toISOString();
  const eventId = randomUUID();

  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indentId,
      event_type: 'indent.raised',
      event_id: eventId,
      payload: {
        indent_id: indentId,
        requester_user_id: actor.userId,
        department_code: body.department_code,
        site_id: body.site_id,
        business_stream: body.business_stream,
        need_by_date: body.need_by_date,
        urgent: body.urgent === true,
        reason: body.reason ?? null,
        lines: routedLines,
        approver_actor_id: approval.approver_actor_id ?? undefined,
        doa_entry_id: approval.doa_entry_id ?? undefined,
        duplicate_confirmed: body.confirm_duplicate === true,
        ...(damageReportId !== undefined ? { damage_report_id: damageReportId } : {}),
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
    },
    auditCtxFor(req, actor, 201),
  );

  const indent = await getIndentWithCounts(indentId);
  const indentLines = await presentLines(await getIndentLines(indentId));

  if (routes.some((r) => r.requires_approval)) {
    // AC 6: the requisition carries APPROVAL_REQUIRED until the resolved authority acts.
    sendJson(res, 201, {
      event_id: persisted.event_id,
      error_code: 'APPROVAL_REQUIRED',
      message: 'Requisition raised and routed for approval',
      indent: indent ?? null,
      lines: indentLines,
      details: {
        indent_id: indentId,
        approver_actor_id: approval.approver_actor_id,
        doa_entry_id: approval.doa_entry_id,
      },
    });
    return;
  }

  sendJson(res, 201, {
    event_id: persisted.event_id,
    indent: indent ?? null,
    lines: indentLines,
  });
};

export const getIndentBase: RouteHandler = async (req, res, params) => {
  const indentId = params?.['indentId'];
  if (!indentId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'indentId is required');
    return;
  }

  const indent = await getIndentById(indentId);
  if (!indent) {
    sendRequestError(req, res, 404, 'INDENT_NOT_FOUND', 'Indent not found', {
      indent_id: indentId,
    });
    return;
  }
  assertIndentReadAccess(req, indent);

  const lines = await presentLines((await getIndentLines(indentId)).map(withOpenQty));
  sendJson(res, 200, { indent: await getIndentWithCounts(indentId), lines });
};

export const listIndentsBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const statusParam = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  const mine = url.searchParams.get('mine');
  // Story 4.11 (AC 8): the storekeeper's "Issues pending" inbox.
  const issuable = url.searchParams.get('issuable') === 'true';
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  const validStatuses: IndentRow['status'][] = [
    'raised',
    'pending-confirmation',
    'approved',
    'rejected',
    'ordered',
    'cancelled',
    'closed',
  ];
  let status: IndentRow['status'] | undefined;
  if (statusParam) {
    if ((validStatuses as string[]).includes(statusParam)) {
      status = statusParam as IndentRow['status'];
    } else {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        `status must be one of: ${validStatuses.join(', ')}`,
        {
          status: statusParam,
        },
      );
      return;
    }
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const offset = offsetParam ? Number.parseInt(offsetParam, 10) : undefined;
  if (
    (limitParam && (!Number.isInteger(limit) || limit! <= 0)) ||
    (offsetParam && (!Number.isInteger(offset) || offset! < 0))
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'limit must be a positive integer and offset a non-negative integer',
    );
    return;
  }

  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const procurementRead = permittedLocationsForModuleScope(
    authContext.roles,
    'procurement',
    'read',
  );
  const ownOnly = mine === 'true';
  if (issuable && !ownOnly) {
    // Story 4.11 (AC 8, D10; review): the stores inbox is scoped by the caller's warehouse write
    // sites only - a procurement reader does not widen it.
    const scope = permittedLocationsForModuleScope(authContext.roles, 'warehouse', 'write');
    if (!scope.wildcard && scope.locations.size === 0) {
      throw new AppError(403, 'FUNCTION_ACCESS_DENIED', 'No site grants access to the issue inbox');
    }
    const results = await listIndents({
      status,
      requesterUserId: undefined,
      search: search ?? undefined,
      permittedSites: scope,
      issuable: true,
      limit,
      offset,
    });
    sendJson(res, 200, { indents: results });
    return;
  }
  // Story 1.15 (D6): a base-role caller lists their own requisitions only, and says so; the list
  // is never silently narrowed. Own requests are visible at every site, so mine=true drops the
  // site filter.
  if (!ownOnly && !procurementRead.wildcard && procurementRead.locations.size === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Base role lists own requisitions only; pass mine=true',
    );
  }
  const permittedSites = ownOnly
    ? { wildcard: true, locations: new Set<string>() }
    : procurementRead;

  const actor = actorContext(req);
  const results = await listIndents({
    status,
    requesterUserId: ownOnly ? actor.userId : undefined,
    search: search ?? undefined,
    permittedSites,
    issuable,
    limit,
    offset,
  });

  // Story 4.8 (Task 6.3, EXPERIENCE.md): the estimated value of one's own requisitions is shown
  // only to a person holding a live self-approval limit; Story 1.15's no-number rule holds for
  // everyone else, so the figure is withheld rather than the list narrowed.
  if (ownOnly) {
    const limit = await findActiveSelfApprovalLimit(
      actor.userId,
      null,
      toIstCalendarDate(new Date()),
    );
    if (!limit) {
      sendJson(res, 200, { indents: results.map((r) => ({ ...r, estimated_value: null })) });
      return;
    }
  }
  sendJson(res, 200, { indents: results });
};

// ---------------------------------------------------------------------------
// Story 4.11: stores counter issue
// ---------------------------------------------------------------------------

/**
 * POST /indents/:indentId/issue. The body is validated with the seam's own rules, a
 * `location_code` is resolved to its id here (the event carries ids only), the guards are
 * pre-run for a clean early error, and the seam re-runs every one of them under the row locks
 * (AD-12). `issue_id` is client-supplied (generated once per form) so a retry after a timeout
 * returns the slip already written instead of issuing twice; absent, the server mints one.
 */
export const issueIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;
  assertWarehouseWriteAtSite(req, indent);
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const suppliedIssueId = body?.issue_id;
  if (
    suppliedIssueId !== undefined &&
    (typeof suppliedIssueId !== 'string' || !UUID_REGEX.test(suppliedIssueId))
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'issue_id must be a UUID when supplied');
    return;
  }
  if (typeof suppliedIssueId === 'string') {
    const prior = await getIndentIssueById(suppliedIssueId);
    if (prior) {
      if (prior.indent_id !== indent.indent_id) {
        sendRequestError(
          req,
          res,
          409,
          'INVALID_PARAMS',
          'issue_id belongs to another requisition',
        );
        return;
      }
      sendJson(res, 200, {
        event_id: prior.source_event_id,
        issue: { ...prior, lines: presentIssueLines(await getIndentIssueLines(prior.issue_id)) },
        slip_text: prior.slip_content ?? '',
        indent: await getIndentWithCounts(indent.indent_id),
        lines: await presentLines((await getIndentLines(indent.indent_id)).map(withOpenQty)),
        replayed: true,
      });
      return;
    }
  }
  const rawLines = Array.isArray(body?.lines) ? (body!.lines as unknown[]) : body?.lines;
  const resolvedLines: unknown[] = [];
  if (Array.isArray(rawLines)) {
    for (const raw of rawLines) {
      if (typeof raw !== 'object' || raw === null) {
        resolvedLines.push(raw);
        continue;
      }
      const line = { ...(raw as Record<string, unknown>) };
      if (typeof line['quantity'] === 'number' && Number.isFinite(line['quantity'])) {
        line['quantity'] = String(line['quantity']);
      }
      if (line['location_id'] === undefined && typeof line['location_code'] === 'string') {
        const code = line['location_code'].trim();
        const location = code.length > 0 ? await getLocationByCode(code) : null;
        if (!location) {
          sendRequestError(req, res, 404, 'LOCATION_NOT_FOUND', 'Unknown bin code', {
            indent_id: indent.indent_id,
            location_code: line['location_code'],
          });
          return;
        }
        line['location_id'] = location.location_id;
      }
      delete line['location_code'];
      resolvedLines.push(line);
    }
  }
  const inputs = normaliseIssueLines(Array.isArray(rawLines) ? resolvedLines : rawLines);
  assertHeaderIssuable(indent);
  const lines = await getIndentLines(indent.indent_id);
  for (const input of inputs) {
    const line = lines.find((l) => l.indent_line_id === input.indent_line_id);
    if (!line) {
      sendRequestError(
        req,
        res,
        404,
        'INDENT_LINE_NOT_FOUND',
        'Line does not belong to this indent',
        {
          indent_id: indent.indent_id,
          indent_line_id: input.indent_line_id,
        },
      );
      return;
    }
    assertLineIssuable(indent, line, input.quantity);
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const issueId = typeof suppliedIssueId === 'string' ? suppliedIssueId : randomUUID();
  let persisted;
  try {
    persisted = await persistEvent(
      {
        stream_type: 'procurement',
        stream_id: indent.indent_id,
        event_type: 'indent.issued',
        event_id: randomUUID(),
        payload: { indent_id: indent.indent_id, issue_id: issueId, lines: inputs },
        metadata: {
          correlation_id: indent.correlation_id ?? randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: now,
        },
      },
      auditCtxFor(req, actor, 201),
    );
  } catch (err) {
    // Story 4.8 (D8): the seam refused the issue because a standing approval no longer holds. That
    // transaction is rolled back; the lapsed lines go back to normal approval in a committed one
    // of their own, and the caller is told both facts. Never a rejection of the line.
    const lapsed = err instanceof AppError ? err.details['lapsed_lines'] : undefined;
    if (
      err instanceof AppError &&
      err.errorCode === 'STANDING_APPROVAL_LAPSED' &&
      Array.isArray(lapsed)
    ) {
      const outcome = await rerouteLapsedLinesToDoa(
        indent.indent_id,
        lapsed as Array<{
          indent_line_id: string;
          reason?: string;
          standing_grant_id?: string | null;
        }>,
        { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        indent.correlation_id,
      );
      throw new AppError(409, 'STANDING_APPROVAL_LAPSED', err.message, {
        ...err.details,
        rerouted_lines: outcome.rerouted,
        reroute_failed: outcome.failed,
      });
    }
    throw err;
  }
  const issue = await getIndentIssueById(issueId);
  sendJson(res, 201, {
    event_id: persisted.event_id,
    issue: issue
      ? { ...issue, lines: presentIssueLines(await getIndentIssueLines(issueId)) }
      : null,
    slip_text: issue?.slip_content ?? '',
    standing_approval_texts: issue
      ? presentIssueLines(await getIndentIssueLines(issueId))
          .map((l) => l.standing_approval_text)
          .filter((t): t is string => t !== null)
      : [],
    indent: await getIndentWithCounts(indent.indent_id),
    lines: await presentLines((await getIndentLines(indent.indent_id)).map(withOpenQty)),
  });
};

/** POST /indents/:indentId/lines/:lineId/close (AC 3). */
export const closeIndentLineBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;
  assertWarehouseWriteAtSite(req, indent);
  const lineId = params?.['lineId'];
  if (!lineId || !UUID_REGEX.test(lineId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'lineId must be a UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reason = body?.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INDENT_LINE_CLOSE_REASON_REQUIRED',
      'A reason is required to close the remainder',
      { indent_id: indent.indent_id, indent_line_id: lineId },
    );
    return;
  }
  if (reason.trim().length > 500) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason must be at most 500 characters');
    return;
  }
  assertHeaderClosable(indent);
  const line = (await getIndentLines(indent.indent_id)).find((l) => l.indent_line_id === lineId);
  if (!line) {
    sendRequestError(
      req,
      res,
      404,
      'INDENT_LINE_NOT_FOUND',
      'Line does not belong to this indent',
      {
        indent_id: indent.indent_id,
        indent_line_id: lineId,
      },
    );
    return;
  }
  assertLineIssuable(indent, line);

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.line_closed',
      event_id: randomUUID(),
      payload: {
        indent_id: indent.indent_id,
        indent_line_id: lineId,
        closed_reason: reason.trim(),
      },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );
  sendJson(res, 200, {
    event_id: persisted.event_id,
    indent: await getIndentWithCounts(indent.indent_id),
    lines: await presentLines((await getIndentLines(indent.indent_id)).map(withOpenQty)),
  });
};

/** GET /indents/:indentId/issues (AC 8): the slips of one requisition, oldest first. */
export const listIndentIssuesBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;
  assertIssueReadAccess(req, indent);
  sendJson(res, 200, { issues: await listIndentIssuesByIndent(indent.indent_id) });
};

/** GET /indents/issues/:issueId (AC 6): one slip with its text and lines. */
export const getIndentIssueBase: RouteHandler = async (req, res, params) => {
  const issueId = params?.['issueId'];
  if (!issueId || !UUID_REGEX.test(issueId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'issueId must be a UUID');
    return;
  }
  const issue = await getIndentIssueById(issueId);
  if (!issue) {
    sendRequestError(req, res, 404, 'INDENT_ISSUE_NOT_FOUND', 'Issue slip not found', {
      issue_id: issueId,
    });
    return;
  }
  const indent = await getIndentById(issue.indent_id);
  if (!indent) {
    sendRequestError(req, res, 404, 'INDENT_ISSUE_NOT_FOUND', 'Issue slip not found', {
      issue_id: issueId,
    });
    return;
  }
  assertIssueReadAccess(req, indent);
  sendJson(res, 200, {
    issue: { ...issue, lines: presentIssueLines(await getIndentIssueLines(issueId)) },
  });
};

/** Story 4.11 (D10): warehouse write at the requisition's site, read from the indent row. */
function assertWarehouseWriteAtSite(req: IncomingMessage, indent: IndentRow): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'warehouse', 'write');
  if (scope.wildcard || scope.locations.has(indent.site_id)) return;
  throw new AppError(
    403,
    'LOCATION_ACCESS_DENIED',
    `No warehouse write assignment grants access to site "${indent.site_id}"`,
    { indent_id: indent.indent_id, site_id: indent.site_id },
  );
}

/**
 * Story 4.11 (D10): a slip is readable by anyone with warehouse read at the site, by the
 * requester, and by procurement readers (the Story 1.15 rule).
 */
function assertIssueReadAccess(req: IncomingMessage, indent: IndentRow): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const warehouseRead = permittedLocationsForModuleScope(authContext.roles, 'warehouse', 'read');
  if (warehouseRead.wildcard || warehouseRead.locations.has(indent.site_id)) return;
  assertIndentReadAccess(req, indent);
}

async function loadIndentOr404(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  indentId: string | undefined,
): Promise<IndentRow | null> {
  if (!indentId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'indentId is required');
    return null;
  }
  const indent = await getIndentById(indentId);
  if (!indent) {
    sendRequestError(req, res, 404, 'INDENT_NOT_FOUND', 'Indent not found', {
      indent_id: indentId,
    });
    return null;
  }
  return indent;
}

/** AC 2 / AC 3: the requester confirms a duplicate-held indent as intentional. */
export const confirmIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const actor = actorContext(req);
  if (indent.requester_user_id !== actor.userId) {
    sendRequestError(
      req,
      res,
      403,
      'FUNCTION_ACCESS_DENIED',
      'Only the requester can confirm their held indent',
      {
        indent_id: indent.indent_id,
      },
    );
    return;
  }

  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.confirmed',
      event_id: randomUUID(),
      payload: { indent_id: indent.indent_id },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

/** AC 3: the requester withdraws a duplicate-held indent instead of confirming it. */
export const withdrawIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const actor = actorContext(req);
  if (indent.requester_user_id !== actor.userId) {
    sendRequestError(
      req,
      res,
      403,
      'FUNCTION_ACCESS_DENIED',
      'Only the requester can withdraw their held indent',
      {
        indent_id: indent.indent_id,
      },
    );
    return;
  }

  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.withdrawn',
      event_id: randomUUID(),
      payload: { indent_id: indent.indent_id },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

/**
 * Story 4.10 (Task 3.1, O4): the decided line ids are fixed HERE, before persistEvent - the body's
 * list as given, else every pending line the actor holds (as approver or active delegate). The
 * persisted event always carries the explicit list so a replay decides the same lines.
 */
async function resolveDecisionLineIds(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  indent: IndentRow,
  actorUserId: string,
  now: string,
): Promise<string[] | null> {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const given = body?.line_ids;
  if (given !== undefined) {
    if (!Array.isArray(given) || given.length === 0 || !given.every((v) => isUuid(v))) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        'line_ids must be a non-empty array of indent_line_id UUIDs',
        { indent_id: indent.indent_id },
      );
      return null;
    }
    return given as string[];
  }
  const held = await pendingLineIdsFor(indent, actorUserId, now);
  if (held.length > 0) return held;
  // Holding no pending line: name every line so the seam answers with the precise guard
  // (INDENT_ALREADY_DECIDED, SOD-01, NOT_RESOLVED_APPROVER) exactly as Story 4.3 clients expect.
  return (await getIndentLines(indent.indent_id)).map((l) => l.indent_line_id);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * AC 5 / AC 6 approval decision. SOD-01 (requester is not approver) and the DOA-resolution match
 * are enforced in the compliance seam (src/compliance/indent.ts), so a direct POST /api/v1/events
 * or an edge upload hits the same guards as this route.
 */
export const approveIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const lineIds = await resolveDecisionLineIds(req, res, indent, actor.userId, now);
  if (!lineIds) return;
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.approved',
      event_id: randomUUID(),
      payload: {
        indent_id: indent.indent_id,
        approver_actor_id: actor.userId,
        line_ids: lineIds,
      },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  sendJson(res, 200, {
    event_id: persisted.event_id,
    indent: await getIndentWithCounts(indent.indent_id),
    lines: await presentLines(await getIndentLines(indent.indent_id)),
  });
};

export const rejectIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reason = body?.rejection_reason;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INDENT_REJECTION_REASON_REQUIRED',
      'A rejection requires a non-empty rejection_reason',
      {
        indent_id: indent.indent_id,
      },
    );
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const lineIds = await resolveDecisionLineIds(req, res, indent, actor.userId, now);
  if (!lineIds) return;
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.rejected',
      event_id: randomUUID(),
      payload: {
        indent_id: indent.indent_id,
        rejection_reason: reason.trim(),
        approver_actor_id: actor.userId,
        line_ids: lineIds,
      },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  sendJson(res, 200, {
    event_id: persisted.event_id,
    indent: await getIndentWithCounts(indent.indent_id),
    lines: await presentLines(await getIndentLines(indent.indent_id)),
  });
};

export const cancelIndentBase: RouteHandler = async (req, res, params) => {
  const indent = await loadIndentOr404(req, res, params?.['indentId']);
  if (!indent) return;

  // Review decision: stock already left the store against this requisition, so it cannot be
  // cancelled; the remainder is closed line by line instead.
  const issuedLines = (await getIndentLines(indent.indent_id)).filter(
    (l) => Number(l.issued_qty) > 0,
  );
  if (issuedLines.length > 0) {
    sendRequestError(
      req,
      res,
      409,
      'INDENT_CANCEL_AFTER_ISSUE',
      'Stock was already issued against this requisition; close the remainder instead of cancelling',
      { indent_id: indent.indent_id, issued_line_count: issuedLines.length },
    );
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: indent.indent_id,
      event_type: 'indent.cancelled',
      event_id: randomUUID(),
      payload: {
        indent_id: indent.indent_id,
        cancelled_reason: typeof body?.cancelled_reason === 'string' ? body.cancelled_reason : null,
      },
      metadata: {
        correlation_id: indent.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getIndentById(indent.indent_id);
  sendJson(res, 200, { event_id: persisted.event_id, indent: updated });
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Story 1.15 (AC 1, D2, D3): raising is the one indent action the base role may take. The gate is
 * site-scoped on body.site_id, the same rule the edge door already applies to an offline
 * indent.raised; a non-UUID site_id is left to the compliance seam's INVALID_PARAMS.
 */
export const raiseIndentHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'write',
  locationId: (_params, body) => {
    const siteId = (body as Record<string, unknown> | undefined)?.['site_id'];
    return typeof siteId === 'string' && UUID_REGEX.test(siteId) ? siteId : undefined;
  },
})(raiseIndentBase);

export const getIndentHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement'],
  functionScope: 'read',
})(getIndentBase);

// Story 4.11 (AC 8): `warehouse` joins the list gate for the issuable inbox; without
// `issuable=true` a warehouse-only caller still gets the Story 1.15 FUNCTION_ACCESS_DENIED.
export const listIndentsHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement', 'warehouse'],
  functionScope: 'read',
})(listIndentsBase);

export const confirmIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(confirmIndentBase);

export const withdrawIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(withdrawIndentBase);

export const approveIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(approveIndentBase);

export const rejectIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(rejectIndentBase);

export const cancelIndentHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(cancelIndentBase);

/**
 * Story 4.11 (D10): issue and close are stores actions, module `warehouse` write at the
 * requisition's site. The site comes from the indent row (never the body), so the base handlers
 * run assertWarehouseWriteAtSite after loading it; the gate here only requires the module.
 */
export const issueIndentHandler = requireRole({
  module: 'warehouse',
  functionScope: 'write',
})(issueIndentBase);

export const closeIndentLineHandler = requireRole({
  module: 'warehouse',
  functionScope: 'write',
})(closeIndentLineBase);

export const listIndentIssuesHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement', 'warehouse'],
  functionScope: 'read',
})(listIndentIssuesBase);

export const getIndentIssueHandler = requireRole({
  module: [EMPLOYEE_MODULE, 'procurement', 'warehouse'],
  functionScope: 'read',
})(getIndentIssueBase);

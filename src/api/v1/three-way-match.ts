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
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getGrnById } from '../../read/projections/grn.js';
import { getSupplierInvoiceById } from '../../read/projections/supplier_invoice.js';
import {
  getMatchById,
  listMatches,
  listClearanceEligibleInvoices,
} from '../../read/projections/three_way_match.js';
import { getPaymentClearanceFeedById } from '../../adapters/erp/payment-clearance-feed.js';
import { getPool } from '../../config/db.js';

/**
 * Story 4.5: goods-receipt and three-way-match HTTP surface - binding a GRN to a native purchase
 * order, running the match, recording the credit/debit notes that lift a blocked match, and the
 * ERP payment-clearance feed run.
 *
 * Every authorization and state guard enforced here is ALSO enforced in
 * src/compliance/three-way-match.ts. These handlers exist for clean HTTP status codes and audit
 * context; they are not the security boundary (Story 4.7 review lesson: a direct
 * POST /api/v1/events bypasses route handlers entirely).
 */

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Strict integer: Number.parseInt would happily accept "10abc" (Story 4.7 lesson). */
const INTEGER_REGEX = /^\d+$/;
const AMOUNT_REGEX = /^\d{1,12}(\.\d{1,2})?$/;
const MATCH_STATUSES = ['passed', 'blocked', 'lifted'] as const;

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

function eventMetadata(
  actor: ActorContext,
  occurredAt: string,
): {
  correlation_id: string;
  actor: { user_id: string; role: string; location_id: string };
  occurred_at: string;
} {
  return {
    correlation_id: randomUUID(),
    actor: {
      user_id: actor.userId,
      role: actor.role,
      location_id: actor.eventLocationId,
    },
    occurred_at: occurredAt,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/grns/:grnId/link-po
// ---------------------------------------------------------------------------

export const linkGrnToPoBase: RouteHandler = async (req, res, params) => {
  const grnId = params['grnId'];
  if (!grnId || !UUID_REGEX.test(grnId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'grnId must be a UUID', { grn_id: grnId });
    return;
  }
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const poId = body['po_id'];
  if (typeof poId !== 'string' || !UUID_REGEX.test(poId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'po_id is required and must be a UUID', {
      po_id: poId,
    });
    return;
  }

  const grn = await getGrnById(grnId);
  if (!grn) {
    sendRequestError(req, res, 404, 'GRN_NOT_FOUND', 'GRN not found', { grn_id: grnId });
    return;
  }

  const actor = actorContext(req);
  const occurredAt = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: grnId,
      event_type: 'grn.po_linked',
      event_id: randomUUID(),
      payload: { grn_id: grnId, po_id: poId },
      metadata: eventMetadata(actor, occurredAt),
      idempotency_key: `grn-po-link-${grnId}-${poId}`,
    },
    auditCtxFor(req, actor, 201),
  );

  const linked = await getGrnById(grnId);
  sendJson(res, 201, {
    event_id: persisted.event_id,
    grn_id: grnId,
    po_id: linked?.po_id ?? poId,
    po_ref_ext: linked?.po_ref_ext ?? null,
  });
};

// ---------------------------------------------------------------------------
// POST /api/v1/three-way-match/run
// ---------------------------------------------------------------------------

export const runThreeWayMatchBase: RouteHandler = async (req, res, _params) => {
  const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
  const invoiceId = body['invoice_id'];
  if (typeof invoiceId !== 'string' || !UUID_REGEX.test(invoiceId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'invoice_id is required and must be a UUID', {
      invoice_id: invoiceId,
    });
    return;
  }
  const invoice = await getSupplierInvoiceById(invoiceId);
  if (!invoice) {
    sendRequestError(req, res, 404, 'SUPPLIER_INVOICE_NOT_FOUND', 'Invoice not found', {
      invoice_id: invoiceId,
    });
    return;
  }

  const actor = actorContext(req);
  const matchId = randomUUID();
  const occurredAt = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: invoiceId,
      event_type: 'three_way_match.recorded',
      event_id: randomUUID(),
      // The applier computes po_id, grn_ids, result, error_code and variance_detail inside the
      // transaction and writes them back onto this payload. Nothing the caller could assert about
      // the OUTCOME is accepted here - a match run only nominates the invoice to compare.
      payload: { match_id: matchId, invoice_id: invoiceId },
      metadata: eventMetadata(actor, occurredAt),
    },
    auditCtxFor(req, actor, 201),
  );

  // A blocked outcome is still HTTP 201: the match RECORD was created successfully. Only an
  // outright rejection (unmatched invoice, missing PO, no posted GRN) is a 409, and that is
  // thrown by the applier before any record exists.
  const match = await getMatchById(matchId);
  sendJson(res, 201, {
    event_id: persisted.event_id,
    match_id: matchId,
    invoice_id: invoiceId,
    po_id: match?.po_id ?? null,
    status: match?.status ?? null,
    error_code: match?.error_code ?? null,
    tolerance_rule_version: match?.tolerance_rule_version ?? null,
    variance_detail: match?.variance_detail ?? null,
    recorded_at: match?.recorded_at ?? null,
  });
};

// ---------------------------------------------------------------------------
// GET /api/v1/three-way-match  |  GET /api/v1/three-way-match/:matchId
// ---------------------------------------------------------------------------

export const listThreeWayMatchesBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const invoiceIdParam = url.searchParams.get('invoice_id');
  const poIdParam = url.searchParams.get('po_id');
  const statusParam = url.searchParams.get('status');
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  for (const [name, value] of [
    ['invoice_id', invoiceIdParam],
    ['po_id', poIdParam],
  ] as const) {
    if (value !== null && !UUID_REGEX.test(value)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', `${name} must be a UUID`, {
        [name]: value,
      });
      return;
    }
  }
  if (statusParam !== null && !(MATCH_STATUSES as readonly string[]).includes(statusParam)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      `status must be one of: ${MATCH_STATUSES.join(', ')}`,
      { status: statusParam },
    );
    return;
  }
  if (
    (limitParam !== null && !INTEGER_REGEX.test(limitParam)) ||
    (offsetParam !== null && !INTEGER_REGEX.test(offsetParam))
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'limit and offset must be integers with no trailing characters',
      { limit: limitParam, offset: offsetParam },
    );
    return;
  }
  const limit = limitParam !== null ? Number(limitParam) : undefined;
  const offset = offsetParam !== null ? Number(offsetParam) : undefined;
  if (limitParam !== null && limit! <= 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'limit must be a positive integer', {
      limit: limitParam,
    });
    return;
  }

  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const permittedSites = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');

  const matches = await listMatches({
    invoiceId: invoiceIdParam ?? undefined,
    poId: poIdParam ?? undefined,
    status: (statusParam as (typeof MATCH_STATUSES)[number] | null) ?? undefined,
    permittedSites,
    limit,
    offset,
  });
  sendJson(res, 200, { matches });
};

export const getThreeWayMatchBase: RouteHandler = async (req, res, params) => {
  const matchId = params['matchId'];
  if (!matchId || !UUID_REGEX.test(matchId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'matchId must be a UUID', {
      match_id: matchId,
    });
    return;
  }
  const match = await getMatchById(matchId);
  if (!match) {
    sendRequestError(req, res, 404, 'MATCH_NOT_FOUND', 'Three-way match not found', {
      match_id: matchId,
    });
    return;
  }
  // Site scoping mirrors the list route: a site-scoped reader never sees another site's match,
  // and a null-site match stays wildcard-only.
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');
  if (!scope.wildcard && (match.site_id === null || !scope.locations.has(match.site_id))) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      'No read assignment grants access to this match',
    );
  }
  sendJson(res, 200, { match });
};

// ---------------------------------------------------------------------------
// POST /api/v1/supplier-invoices/:invoiceId/credit-note  (and /debit-note)
// ---------------------------------------------------------------------------

function recordNoteBase(
  eventType: 'supplier_invoice.credit_note_recorded' | 'supplier_invoice.debit_note_recorded',
  noteType: 'credit_note' | 'debit_note',
): RouteHandler {
  return async (req, res, params) => {
    const invoiceId = params['invoiceId'];
    if (!invoiceId || !UUID_REGEX.test(invoiceId)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'invoiceId must be a UUID', {
        invoice_id: invoiceId,
      });
      return;
    }
    const body = (getParsedBody(req) as Record<string, unknown> | undefined) ?? {};
    const matchId = body['match_id'];
    const noteNumberExt = body['note_number_ext'];
    const amount = body['amount'];
    const reason = body['reason'];

    if (typeof matchId !== 'string' || !UUID_REGEX.test(matchId)) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'match_id is required and must be a UUID', {
        match_id: matchId,
      });
      return;
    }
    if (typeof noteNumberExt !== 'string' || noteNumberExt.trim().length === 0) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'note_number_ext is required');
      return;
    }
    // Money crosses this boundary as a string so a JS float never rounds a statutory amount.
    if (typeof amount !== 'string' || !AMOUNT_REGEX.test(amount) || Number(amount) <= 0) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        'amount must be a positive decimal string with at most two decimal places',
        { amount },
      );
      return;
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason is required and must be non-empty');
      return;
    }

    const invoice = await getSupplierInvoiceById(invoiceId);
    if (!invoice) {
      sendRequestError(req, res, 404, 'SUPPLIER_INVOICE_NOT_FOUND', 'Invoice not found', {
        invoice_id: invoiceId,
      });
      return;
    }

    const actor = actorContext(req);
    const noteId = randomUUID();
    const occurredAt = new Date().toISOString();
    const persisted = await persistEvent(
      {
        stream_type: 'procurement',
        stream_id: invoiceId,
        event_type: eventType,
        event_id: randomUUID(),
        payload: {
          note_id: noteId,
          invoice_id: invoiceId,
          match_id: matchId,
          note_number_ext: noteNumberExt.trim(),
          amount,
          reason: reason.trim(),
        },
        metadata: eventMetadata(actor, occurredAt),
      },
      auditCtxFor(req, actor, 201),
    );

    const match = await getMatchById(matchId);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      note_id: noteId,
      note_type: noteType,
      invoice_id: invoiceId,
      match_id: matchId,
      match_status: match?.status ?? null,
      lifted_at: match?.lifted_at ?? null,
    });
  };
}

export const recordCreditNoteBase = recordNoteBase(
  'supplier_invoice.credit_note_recorded',
  'credit_note',
);
export const recordDebitNoteBase = recordNoteBase(
  'supplier_invoice.debit_note_recorded',
  'debit_note',
);

// ---------------------------------------------------------------------------
// POST /api/v1/compliance/payment-clearance-feed/run
// ---------------------------------------------------------------------------

export const runPaymentClearanceFeedBase: RouteHandler = async (req, res, _params) => {
  const actor = actorContext(req);
  const generatedAt = new Date().toISOString();
  const feedId = randomUUID();

  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: feedId,
      event_type: 'payment_clearance_feed.recorded',
      event_id: randomUUID(),
      // row_count is stamped by the applier from the rows it actually cleared; the applier is the
      // only thing that decides which invoices are eligible.
      payload: { feed_id: feedId, generated_at: generatedAt },
      metadata: eventMetadata(actor, generatedAt),
    },
    auditCtxFor(req, actor, 201),
  );

  const client = await getPool().connect();
  try {
    const feed = await getPaymentClearanceFeedById(feedId, client);
    sendJson(res, 201, {
      event_id: persisted.event_id,
      feed_id: feedId,
      row_count: feed?.row_count ?? 0,
      payload: feed?.payload ?? null,
      recorded_at: feed?.recorded_at ?? null,
    });
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/compliance/payment-clearance-feed/eligible
// ---------------------------------------------------------------------------

export const listClearanceEligibleBase: RouteHandler = async (req, res, _params) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const permittedSites = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');
  const client = await getPool().connect();
  try {
    const rows = await listClearanceEligibleInvoices(client, permittedSites);
    sendJson(res, 200, { row_count: rows.length, rows });
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// RBAC-wrapped handlers. Reads are procurement/read, writes procurement/write - no role-name
// literal appears anywhere in this file.
// ---------------------------------------------------------------------------

export const linkGrnToPoHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(linkGrnToPoBase);

export const runThreeWayMatchHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(runThreeWayMatchBase);

export const listThreeWayMatchesHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listThreeWayMatchesBase);

export const getThreeWayMatchHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(getThreeWayMatchBase);

export const recordCreditNoteHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(recordCreditNoteBase);

export const recordDebitNoteHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(recordDebitNoteBase);

export const runPaymentClearanceFeedHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(runPaymentClearanceFeedBase);

export const listClearanceEligibleHandler: RouteHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listClearanceEligibleBase);

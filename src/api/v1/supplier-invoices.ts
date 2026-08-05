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
import { getPurchaseOrderById } from '../../read/projections/purchase_order.js';
import {
  getSupplierInvoiceById,
  getSupplierInvoiceLines,
  listSupplierInvoices,
  getSupplierInvoiceIngestionById,
  listSupplierInvoiceIngestions,
} from '../../read/projections/supplier_invoice.js';
import type { SupplierInvoiceIngestionRow } from '../../read/projections/supplier_invoice.js';
import type { SupplierInvoiceRow } from '../../read/projections/supplier_invoice.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

interface ActorContext {
  userId: string;
  role: string;
  auditLocationId: string;
  eventLocationId: string;
}

function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const assignment = getAuthorizedAssignment(req);
  const userId = authContext.userId;
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

function assertInvoiceReadAccess(req: IncomingMessage, invoice: SupplierInvoiceRow): void {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const scope = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');
  const visible = invoice.site_id
    ? scope.wildcard || scope.locations.has(invoice.site_id)
    : // AC7: an unmatched invoice with no derived site is visible only to wildcard readers until linked.
      scope.wildcard;
  if (!visible) {
    // Respond exactly as if the invoice does not exist: a 403 here would be an existence oracle,
    // confirming to a site-scoped reader that a hidden (cross-site or unmatched) invoice ID is real.
    throw new AppError(404, 'SUPPLIER_INVOICE_NOT_FOUND', 'Supplier invoice not found', {
      invoice_id: invoice.invoice_id,
    });
  }
}

interface CapturePayload {
  supplier_id: string;
  invoice_number_ext: string;
  invoice_date: string;
  po_id: string;
  currency?: string;
  recipient_gstin_ext?: string;
  irn_ext?: string;
  lines: unknown;
  subtotal?: number;
  cgst_total?: number;
  sgst_total?: number;
  igst_total?: number;
  cess_total?: number;
  total_value: number;
}

function buildCaptureBody(body: Record<string, unknown> | undefined): CapturePayload | null {
  if (!body) return null;
  if (
    typeof body['supplier_id'] !== 'string' ||
    typeof body['invoice_number_ext'] !== 'string' ||
    typeof body['invoice_date'] !== 'string' ||
    typeof body['po_id'] !== 'string' ||
    typeof body['total_value'] !== 'number'
  ) {
    return null;
  }
  return body as unknown as CapturePayload;
}

async function captureAgainstPo(
  req: IncomingMessage,
  res: Parameters<RouteHandler>[1],
  overrideReason: string | undefined,
): Promise<void> {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const capture = buildCaptureBody(body);
  if (!capture) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'supplier_id, invoice_number_ext, invoice_date, po_id, and total_value are required',
    );
    return;
  }

  const po = await getPurchaseOrderById(capture.po_id);
  if (!po) {
    sendRequestError(req, res, 404, 'PO_NOT_FOUND', 'Purchase order not found', {
      po_id: capture.po_id,
    });
    return;
  }

  const actor = actorContext(req);
  const invoiceId = randomUUID();
  const now = new Date().toISOString();

  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: invoiceId,
      event_type: 'supplier_invoice.captured',
      event_id: randomUUID(),
      payload: {
        invoice_id: invoiceId,
        supplier_id: capture.supplier_id,
        invoice_number_ext: capture.invoice_number_ext,
        invoice_date: capture.invoice_date,
        po_id: capture.po_id,
        // Task 5.1: the handler derives business_stream from the locked source PO; the client
        // never supplies it. The seam re-derives and rejects any disagreement.
        business_stream: po.business_stream,
        currency: capture.currency ?? 'INR',
        recipient_gstin_ext: capture.recipient_gstin_ext,
        irn_ext: capture.irn_ext,
        lines: capture.lines,
        subtotal: capture.subtotal,
        cgst_total: capture.cgst_total,
        sgst_total: capture.sgst_total,
        igst_total: capture.igst_total,
        cess_total: capture.cess_total,
        total_value: capture.total_value,
        capture_method: 'manual',
        duplicate_override_reason: overrideReason,
        captured_by: actor.userId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 201),
  );

  const invoice = await getSupplierInvoiceById(invoiceId);
  const lines = await getSupplierInvoiceLines(invoiceId);
  sendJson(res, 201, { event_id: persisted.event_id, supplier_invoice: invoice, lines });
}

export const captureSupplierInvoiceBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (body && body['duplicate_override_reason'] !== undefined) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'duplicate_override_reason is not accepted on the ordinary capture endpoint; use /supplier-invoices/duplicate-overrides',
    );
    return;
  }
  await captureAgainstPo(req, res, undefined);
};

export const captureDuplicateOverrideBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reason = body?.['duplicate_override_reason'];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    sendRequestError(
      req,
      res,
      400,
      'INVOICE_DUPLICATE_OVERRIDE_REASON_REQUIRED',
      'A duplicate override requires a non-empty duplicate_override_reason',
    );
    return;
  }
  await captureAgainstPo(req, res, reason.trim());
};

export const getSupplierInvoiceBase: RouteHandler = async (req, res, params) => {
  const invoiceId = params?.['invoiceId'];
  if (!invoiceId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'invoiceId is required');
    return;
  }
  const invoice = await getSupplierInvoiceById(invoiceId);
  if (!invoice) {
    sendRequestError(req, res, 404, 'SUPPLIER_INVOICE_NOT_FOUND', 'Supplier invoice not found', {
      invoice_id: invoiceId,
    });
    return;
  }
  assertInvoiceReadAccess(req, invoice);
  const lines = await getSupplierInvoiceLines(invoiceId);
  sendJson(res, 200, { supplier_invoice: invoice, lines });
};

export const listSupplierInvoicesBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const statusParam = url.searchParams.get('status');
  const validStatuses: SupplierInvoiceRow['status'][] = ['unmatched', 'captured'];
  let status: SupplierInvoiceRow['status'] | undefined;
  if (statusParam) {
    if ((validStatuses as string[]).includes(statusParam)) {
      status = statusParam as SupplierInvoiceRow['status'];
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

  const supplierId = url.searchParams.get('supplier_id') ?? undefined;
  const siteId = url.searchParams.get('site_id') ?? undefined;
  const invoiceDate = url.searchParams.get('invoice_date') ?? undefined;
  const financialYearStartParam = url.searchParams.get('financial_year_start');
  const search = url.searchParams.get('search') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');

  // invoice_date feeds a DATE comparison directly - reject non-calendar input here instead of
  // letting PostgreSQL raise 22007 as an unmapped 500.
  if (invoiceDate !== undefined && !isCalendarDate(invoiceDate)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'invoice_date must be a valid YYYY-MM-DD calendar date',
      { invoice_date: invoiceDate },
    );
    return;
  }

  // All-digits check before parseInt: "2025abc" and "1e3" must be rejected, not silently
  // truncated to a different query than the caller intended.
  if (financialYearStartParam && !/^\d+$/.test(financialYearStartParam)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'financial_year_start must be an integer');
    return;
  }
  const financialYearStart = financialYearStartParam
    ? Number.parseInt(financialYearStartParam, 10)
    : undefined;
  if (financialYearStartParam && !Number.isInteger(financialYearStart)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'financial_year_start must be an integer');
    return;
  }
  if ((limitParam && !/^\d+$/.test(limitParam)) || (offsetParam && !/^\d+$/.test(offsetParam))) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'limit must be a positive integer and offset a non-negative integer',
    );
    return;
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
  const permittedSites = permittedLocationsForModuleScope(authContext.roles, 'procurement', 'read');

  const results = await listSupplierInvoices({
    status,
    supplierId,
    siteId,
    invoiceDate,
    financialYearStart,
    search,
    permittedSites,
    limit,
    offset,
  });

  // AC7: null-site rows are excluded for non-wildcard readers by the site_id = ANY(...) filter
  // inside listSupplierInvoices; filtering again after LIMIT/OFFSET would silently drop page rows.
  sendJson(res, 200, { supplier_invoices: results });
};

export const linkSupplierInvoiceToPoBase: RouteHandler = async (req, res, params) => {
  const invoiceId = params?.['invoiceId'];
  if (!invoiceId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'invoiceId is required');
    return;
  }
  const invoice = await getSupplierInvoiceById(invoiceId);
  if (!invoice) {
    sendRequestError(req, res, 404, 'SUPPLIER_INVOICE_NOT_FOUND', 'Supplier invoice not found', {
      invoice_id: invoiceId,
    });
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const poId = body?.['po_id'];
  if (typeof poId !== 'string') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'po_id is required');
    return;
  }
  const po = await getPurchaseOrderById(poId);
  if (!po) {
    sendRequestError(req, res, 404, 'PO_NOT_FOUND', 'Purchase order not found', { po_id: poId });
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: invoiceId,
      event_type: 'supplier_invoice.po_linked',
      event_id: randomUUID(),
      payload: {
        invoice_id: invoiceId,
        po_id: poId,
        business_stream: po.business_stream,
        linked_by: actor.userId,
      },
      metadata: {
        correlation_id: invoice.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updated = await getSupplierInvoiceById(invoiceId);
  const lines = await getSupplierInvoiceLines(invoiceId);
  sendJson(res, 200, { event_id: persisted.event_id, supplier_invoice: updated, lines });
};

export const stageInvoiceIngestionBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (
    !body ||
    typeof body['source_format'] !== 'string' ||
    typeof body['attachment_ref'] !== 'string' ||
    typeof body['sha256_hash'] !== 'string' ||
    typeof body['detected_mime'] !== 'string' ||
    typeof body['byte_size'] !== 'number' ||
    typeof body['extracted_draft'] !== 'object' ||
    body['extracted_draft'] === null
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'source_format, attachment_ref, sha256_hash, detected_mime, byte_size, and extracted_draft are required',
    );
    return;
  }

  const actor = actorContext(req);
  const ingestionId = randomUUID();
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: ingestionId,
      event_type: 'invoice_ingestion.staged',
      event_id: randomUUID(),
      payload: {
        ingestion_id: ingestionId,
        source_format: body['source_format'],
        attachment_ref: body['attachment_ref'],
        sha256_hash: body['sha256_hash'],
        detected_mime: body['detected_mime'],
        byte_size: body['byte_size'],
        extracted_draft: body['extracted_draft'],
        uploaded_by: actor.userId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 201),
  );

  const ingestion = await getSupplierInvoiceIngestionById(ingestionId);
  sendJson(res, 201, { event_id: persisted.event_id, ingestion });
};

export const getInvoiceIngestionBase: RouteHandler = async (req, res, params) => {
  const ingestionId = params?.['ingestionId'];
  if (!ingestionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'ingestionId is required');
    return;
  }
  const ingestion = await getSupplierInvoiceIngestionById(ingestionId);
  if (!ingestion) {
    sendRequestError(req, res, 404, 'SUPPLIER_INVOICE_INGESTION_NOT_FOUND', 'Ingestion not found', {
      ingestion_id: ingestionId,
    });
    return;
  }
  sendJson(res, 200, { ingestion });
};

/**
 * The review queue (AC2): without this list a reviewer cannot discover pending work through the
 * REST contract this story delivers for the future central UI. Review decision (2026-08-06):
 * ingestion reads stay open to any procurement reader.
 */
export const listInvoiceIngestionsBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const reviewStatusParam = url.searchParams.get('review_status');
  const validStatuses: SupplierInvoiceIngestionRow['review_status'][] = [
    'review-required',
    'reviewed',
  ];
  let reviewStatus: SupplierInvoiceIngestionRow['review_status'] | undefined;
  if (reviewStatusParam) {
    if ((validStatuses as string[]).includes(reviewStatusParam)) {
      reviewStatus = reviewStatusParam as SupplierInvoiceIngestionRow['review_status'];
    } else {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        `review_status must be one of: ${validStatuses.join(', ')}`,
        { review_status: reviewStatusParam },
      );
      return;
    }
  }
  const limitParam = url.searchParams.get('limit');
  const offsetParam = url.searchParams.get('offset');
  if (
    (limitParam && (!/^\d+$/.test(limitParam) || Number.parseInt(limitParam, 10) <= 0)) ||
    (offsetParam && !/^\d+$/.test(offsetParam))
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
  const ingestions = await listSupplierInvoiceIngestions({
    reviewStatus,
    limit: limitParam ? Number.parseInt(limitParam, 10) : undefined,
    offset: offsetParam ? Number.parseInt(offsetParam, 10) : undefined,
  });
  sendJson(res, 200, { ingestions });
};

export const confirmInvoiceIngestionBase: RouteHandler = async (req, res, params) => {
  const ingestionId = params?.['ingestionId'];
  if (!ingestionId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'ingestionId is required');
    return;
  }
  const ingestion = await getSupplierInvoiceIngestionById(ingestionId);
  if (!ingestion) {
    sendRequestError(req, res, 404, 'SUPPLIER_INVOICE_INGESTION_NOT_FOUND', 'Ingestion not found', {
      ingestion_id: ingestionId,
    });
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const correctedHeader = body?.['corrected_header'];
  const correctedLines = body?.['corrected_lines'];
  if (
    typeof correctedHeader !== 'object' ||
    correctedHeader === null ||
    !Array.isArray(correctedLines)
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'corrected_header and corrected_lines are required',
    );
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();
  const persisted = await persistEvent(
    {
      stream_type: 'procurement',
      stream_id: ingestionId,
      event_type: 'invoice_ingestion.reviewed',
      event_id: randomUUID(),
      payload: {
        ingestion_id: ingestionId,
        corrected_header: { ...(correctedHeader as Record<string, unknown>) },
        corrected_lines: correctedLines,
        correction_summary: body?.['correction_summary'],
        reviewed_by: actor.userId,
      },
      metadata: {
        correlation_id: ingestion.correlation_id ?? randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: now,
      },
    },
    auditCtxFor(req, actor, 200),
  );

  const updatedIngestion = await getSupplierInvoiceIngestionById(ingestionId);
  sendJson(res, 200, { event_id: persisted.event_id, ingestion: updatedIngestion });
};

export const captureSupplierInvoiceHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(captureSupplierInvoiceBase);

// Duplicate override is a separate, RBAC-independently-assignable capability (Dev Notes: "never
// hard-code a role name; RBAC assignments determine who holds that capability"). Ordinary
// 'procurement' write access does not automatically grant it - a deployment must assign this
// distinct module scope to whichever role(s) it designates as evidenced-override holders.
export const captureDuplicateOverrideHandler = requireRole({
  module: 'procurement.duplicate-override',
  functionScope: 'write',
})(captureDuplicateOverrideBase);

export const getSupplierInvoiceHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(getSupplierInvoiceBase);

export const listSupplierInvoicesHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listSupplierInvoicesBase);

export const linkSupplierInvoiceToPoHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(linkSupplierInvoiceToPoBase);

export const stageInvoiceIngestionHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(stageInvoiceIngestionBase);

export const getInvoiceIngestionHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(getInvoiceIngestionBase);

export const listInvoiceIngestionsHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listInvoiceIngestionsBase);

export const confirmInvoiceIngestionHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(confirmInvoiceIngestionBase);

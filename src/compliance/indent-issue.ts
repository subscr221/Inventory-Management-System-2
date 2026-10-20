import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import type { IndentRow, IndentLineRow } from '../read/projections/indent.js';
import {
  getIndentById,
  getIndentLines,
  applyIndentLineIssue,
  closeIndentLine,
  openQtyOf,
} from '../read/projections/indent.js';
import {
  allocateIssueNumber,
  getIndentIssueById as getIssueById,
  insertIndentIssue,
  insertIndentIssueLine,
  listIndentIssuesByIndent,
  setIndentIssueSlip,
  type IndentIssueLineRow,
} from '../read/projections/indent_issue.js';
import { getLocationById } from '../read/projections/location_register.js';
import { isLocationDescendantOf } from './production-material.js';
import { getDoaEntry } from '../read/projections/doa_registry.js';
import { logAuditEntry } from '../read/projections/audit_log.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import { renderIssueSlip, type IssueSlipLine } from '../warehouse/document-renderer.js';
import { alreadyPersisted } from './indent.js';

/**
 * Story 4.11 compliance seam: stores counter issue against approved requisition lines, and the
 * closure of an open remainder with a reason. Kept apart from src/compliance/indent.ts (the
 * decision seam) so Story 4.8 hooks its issue-time grant check (D8) into one place.
 *
 * D2: the ledger movement is a NESTED `stock.issued` event persisted with the same client
 * (the purchase-order.ts `indent.ordered` precedent), so lot and serial validation, lot trace,
 * serial state, valuation outflow and the QC gate all run through their own seams. Calling
 * applyStockIssue directly would skip them.
 */

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
const INDENT_ISSUE_EVENT_TYPES = new Set(['indent.issued', 'indent.line_closed']);
const ISSUABLE_HEADER_STATES = new Set<IndentRow['status']>(['raised', 'approved']);
// Review decision: a remainder may be closed once the requisition is ordered ("remainder to
// purchase" is the canonical close reason); issuing against an ordered header stays refused.
const CLOSABLE_HEADER_STATES = new Set<IndentRow['status']>(['raised', 'approved', 'ordered']);
const MAX_ISSUE_LINES = 50;
const MAX_CLOSE_REASON_LENGTH = 500;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Positive NUMERIC(18,3) text: at most 12 integer digits (15 digits in all stay exact as a JS
// number for the nested stock.issued payload) and three decimals, not zero.
const QTY_REGEX = /^\d{1,12}(\.\d{1,3})?$/;

/** NUMERIC text to thousandths as a BigInt, so quantity comparisons never touch floats. */
function toMilli(value: string): bigint {
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt((frac + '000').slice(0, 3));
}

export function qtyExceeds(quantity: string, open: string): boolean {
  return toMilli(quantity) > toMilli(open);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveQty(value: unknown): value is string {
  return typeof value === 'string' && QTY_REGEX.test(value) && Number(value) > 0;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

export function indentIssueEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!INDENT_ISSUE_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

export interface IssueLineInput {
  indent_line_id: string;
  quantity: string;
  location_id: string;
  lot_id: string | null;
  serials: Array<{ serial_number: string }> | null;
  override_expired_lot: boolean;
  fefo_mode: 'fefo' | 'fifo' | null;
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

function normaliseIssueLine(raw: unknown, index: number): IssueLineInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    reject('INVALID_PARAMS', `lines[${index}] must be an object`, { index });
  }
  const line = raw as Record<string, unknown>;
  if (!isUuid(line['indent_line_id'])) {
    reject('INVALID_PARAMS', `lines[${index}].indent_line_id must be a UUID`, { index });
  }
  if (!isPositiveQty(line['quantity'])) {
    reject(
      'INVALID_PARAMS',
      `lines[${index}].quantity must be a positive numeric string with at most 3 decimals`,
      { index, quantity: line['quantity'] ?? null },
    );
  }
  if (!isUuid(line['location_id'])) {
    reject('INVALID_PARAMS', `lines[${index}].location_id must be a UUID`, { index });
  }
  if (
    line['lot_id'] !== undefined &&
    line['lot_id'] !== null &&
    !isNonEmptyString(line['lot_id'])
  ) {
    reject('INVALID_PARAMS', `lines[${index}].lot_id must be a non-empty string when supplied`, {
      index,
    });
  }
  let serials: Array<{ serial_number: string }> | null = null;
  if (line['serials'] !== undefined && line['serials'] !== null) {
    if (!Array.isArray(line['serials'])) {
      reject('INVALID_PARAMS', `lines[${index}].serials must be an array when supplied`, { index });
    }
    serials = (line['serials'] as unknown[]).map((s, j) => {
      const serialNumber =
        typeof s === 'object' && s !== null
          ? (s as Record<string, unknown>)['serial_number']
          : undefined;
      if (!isNonEmptyString(serialNumber)) {
        reject('INVALID_PARAMS', `lines[${index}].serials[${j}].serial_number is required`, {
          index,
        });
      }
      return { serial_number: serialNumber };
    });
    if (serials.length > 0) {
      const distinct = new Set(serials.map((x) => x.serial_number));
      if (distinct.size !== serials.length) {
        reject('INVALID_PARAMS', `lines[${index}].serials must not repeat a serial number`, {
          index,
        });
      }
      if (toMilli(line['quantity'] as string) !== BigInt(serials.length) * 1000n) {
        reject(
          'INVALID_PARAMS',
          `lines[${index}] lists ${serials.length} serial(s) but the quantity is ${String(line['quantity'])}`,
          { index, serial_count: serials.length, quantity: line['quantity'] },
        );
      }
    }
  }
  if (
    line['override_expired_lot'] !== undefined &&
    typeof line['override_expired_lot'] !== 'boolean'
  ) {
    reject('INVALID_PARAMS', `lines[${index}].override_expired_lot must be a boolean`, { index });
  }
  if (
    line['fefo_mode'] !== undefined &&
    line['fefo_mode'] !== null &&
    line['fefo_mode'] !== 'fefo' &&
    line['fefo_mode'] !== 'fifo'
  ) {
    reject('INVALID_PARAMS', `lines[${index}].fefo_mode must be "fefo" or "fifo"`, { index });
  }
  return {
    indent_line_id: line['indent_line_id'],
    quantity: line['quantity'],
    location_id: line['location_id'],
    lot_id: isNonEmptyString(line['lot_id']) ? line['lot_id'] : null,
    serials,
    override_expired_lot: line['override_expired_lot'] === true,
    fefo_mode:
      line['fefo_mode'] === 'fefo' || line['fefo_mode'] === 'fifo' ? line['fefo_mode'] : null,
  };
}

/** Exported so the route validates the body with the identical rules before persistEvent. */
export function normaliseIssueLines(raw: unknown): IssueLineInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    reject('INDENT_ISSUE_LINE_REQUIRED', 'At least one line is required to issue');
  }
  if (raw.length > MAX_ISSUE_LINES) {
    reject('INVALID_PARAMS', `An issue may carry at most ${MAX_ISSUE_LINES} lines`, {
      line_count: raw.length,
    });
  }
  const lines = raw.map(normaliseIssueLine);
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.indent_line_id)) {
      reject('INVALID_PARAMS', 'A line may appear only once per issue', {
        indent_line_id: l.indent_line_id,
      });
    }
    seen.add(l.indent_line_id);
  }
  return lines;
}

export function assertIndentIssueShape(envelope: EventEnvelope): void {
  const type = indentIssueEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['indent_id'])) reject('INVALID_PARAMS', 'indent_id must be a UUID');
  if (type === 'indent.issued') {
    if (!isUuid(p['issue_id'])) reject('INVALID_PARAMS', 'issue_id must be a UUID');
    normaliseIssueLines(p['lines']);
    return;
  }
  if (!isUuid(p['indent_line_id'])) reject('INVALID_PARAMS', 'indent_line_id must be a UUID');
  if (!isNonEmptyString(p['closed_reason'])) {
    reject('INDENT_LINE_CLOSE_REASON_REQUIRED', 'A reason is required to close the remainder');
  }
  if ((p['closed_reason'] as string).trim().length > MAX_CLOSE_REASON_LENGTH) {
    reject('INVALID_PARAMS', `closed_reason must be at most ${MAX_CLOSE_REASON_LENGTH} characters`);
  }
}

// ---------------------------------------------------------------------------
// Guards shared by the seam and the route pre-check
// ---------------------------------------------------------------------------

export function assertHeaderIssuable(indent: IndentRow): void {
  if (!ISSUABLE_HEADER_STATES.has(indent.status)) {
    reject(
      'INDENT_NOT_ISSUABLE',
      `Indent ${indent.indent_number_ext} is ${indent.status} and cannot be issued against`,
      { indent_id: indent.indent_id, status: indent.status },
      409,
    );
  }
}

/** A remainder can be closed while the requisition is open or ordered (not cancelled or closed). */
export function assertHeaderClosable(indent: IndentRow): void {
  if (!CLOSABLE_HEADER_STATES.has(indent.status)) {
    reject(
      'INDENT_NOT_ISSUABLE',
      `Indent ${indent.indent_number_ext} is ${indent.status}; its lines can no longer be closed`,
      { indent_id: indent.indent_id, status: indent.status },
      409,
    );
  }
}

/** Table 3: the line must be approved and still open; the quantity must fit the open quantity. */
export function assertLineIssuable(
  indent: IndentRow,
  line: IndentLineRow,
  quantity?: string,
): void {
  const details = {
    indent_id: indent.indent_id,
    indent_line_id: line.indent_line_id,
    line_no: line.line_no,
  };
  if (line.line_status !== 'approved') {
    reject(
      'INDENT_LINE_NOT_APPROVED',
      `Line ${line.line_no} is ${line.line_status}; only an approved line can be issued`,
      { ...details, line_status: line.line_status },
      409,
    );
  }
  if (line.issue_state === 'closed') {
    reject(
      'INDENT_LINE_CLOSED',
      `Line ${line.line_no} was closed: ${line.closed_reason ?? ''}`.trim(),
      { ...details, closed_reason: line.closed_reason },
      409,
    );
  }
  if (line.issue_state === 'issued') {
    reject(
      'INDENT_LINE_FULLY_ISSUED',
      `Line ${line.line_no} is fully issued (${line.issued_qty} of ${line.requested_qty})`,
      { ...details, requested_qty: line.requested_qty, issued_qty: line.issued_qty },
      409,
    );
  }
  if (quantity !== undefined) {
    const open = openQtyOf(line);
    if (qtyExceeds(quantity, open)) {
      reject(
        'INDENT_ISSUE_EXCEEDS_APPROVED',
        `Line ${line.line_no} has ${open} open; ${quantity} requested`,
        {
          ...details,
          requested_qty: line.requested_qty,
          issued_qty: line.issued_qty,
          open_qty: open,
          quantity,
        },
        409,
      );
    }
  }
}

/**
 * Table 2: the approval basis printed per issued line. The two non-DOA branches are Story 4.8's
 * seam: that story replaces them with its `standing_approval_text` (D9).
 */
export function approvalBasisText(line: IndentLineRow, doaRole: string | null): string {
  if (line.approval_route === 'standing_approval') {
    return 'Standing approval (grant pending Story 4.8)';
  }
  if (line.approval_route === 'self_approval') {
    return 'Within self-approval limit';
  }
  const role = doaRole ?? 'approver';
  const who = line.decided_by ?? line.approver_actor_id ?? 'unknown';
  const decided = line.decided_at ? new Date(line.decided_at) : null;
  const when =
    decided && !Number.isNaN(decided.getTime()) ? toIstCalendarDate(decided) : 'unknown date';
  return `Approved by ${role} (${who}) on ${when}`;
}

export async function approvalBasisOf(line: IndentLineRow): Promise<string> {
  const entry =
    line.approval_route !== 'standing_approval' &&
    line.approval_route !== 'self_approval' &&
    line.doa_entry_id
      ? await getDoaEntry(line.doa_entry_id)
      : null;
  return approvalBasisText(line, entry?.role ?? null);
}

// ---------------------------------------------------------------------------
// Appliers (inside the persist transaction)
// ---------------------------------------------------------------------------

async function applyIndentIssued(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;
  const issueId = p['issue_id'] as string;
  const inputs = normaliseIssueLines(p['lines']);
  // A retry carrying the same issue_id (the client fixes it once per form) must not issue twice.
  if (await getIssueById(issueId, client)) return;

  // Lock order: header, then lines, then the stock rows inside applyStockIssue.
  const indent = await getIndentById(indentId, client, true);
  if (!indent) reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  assertHeaderIssuable(indent);
  const lines = await getIndentLines(indentId, client, true);
  const byId = new Map(lines.map((l) => [l.indent_line_id, l]));

  // Every guard for every line BEFORE any write (all or nothing).
  const resolved: Array<{ input: IssueLineInput; line: IndentLineRow; location_code: string }> = [];
  for (const input of inputs) {
    const line = byId.get(input.indent_line_id);
    if (!line) {
      reject(
        'INDENT_LINE_NOT_FOUND',
        'Line does not belong to this indent',
        { indent_id: indentId, indent_line_id: input.indent_line_id },
        404,
      );
    }
    assertLineIssuable(indent, line, input.quantity);
    const location = await getLocationById(input.location_id, client);
    const underSite =
      location !== null &&
      (await isLocationDescendantOf(indent.site_id, location.location_id, client));
    if (!location || !underSite) {
      reject(
        'INDENT_ISSUE_BIN_OUTSIDE_SITE',
        `Bin ${input.location_id} is not under the requisition's site`,
        { indent_id: indentId, site_id: indent.site_id, location_id: input.location_id },
        409,
      );
    }
    resolved.push({ input, line, location_code: location.location_code });
  }

  const occurredAt = envelope.metadata.occurred_at;
  const earlier = await listIndentIssuesByIndent(indentId, client);
  const issueNumber = await allocateIssueNumber(
    Number(toIstCalendarDate(new Date(occurredAt)).slice(0, 4)),
    client,
  );
  await insertIndentIssue(
    {
      issue_id: issueId,
      issue_number_ext: issueNumber,
      indent_id: indentId,
      site_id: indent.site_id,
      issued_by: envelope.metadata.actor.user_id,
      issued_at: occurredAt,
      source_event_id: eventId,
      correlation_id: envelope.metadata.correlation_id ?? null,
    },
    client,
  );

  const slipLines: IssueSlipLine[] = [];
  for (const { input, line, location_code } of resolved) {
    // D2: the ledger movement, through every stock.issued seam, in this same transaction.
    const stockEventId = randomUUID();
    const stockPayload: Record<string, unknown> = {
      sku: line.sku,
      quantity: Number(input.quantity),
      target_location_id: input.location_id,
      stock_class: 'owned',
      business_stream: indent.business_stream,
      reference: { indent_id: indentId, indent_line_id: line.indent_line_id, issue_id: issueId },
    };
    if (input.lot_id !== null) stockPayload['lot_id'] = input.lot_id;
    if (input.serials !== null) stockPayload['serials'] = input.serials;
    if (input.override_expired_lot) stockPayload['override_expired_lot'] = true;
    if (input.fefo_mode !== null) stockPayload['fefo_mode'] = input.fefo_mode;
    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: line.indent_line_id,
        event_type: 'stock.issued',
        event_id: stockEventId,
        payload: stockPayload,
        metadata: {
          correlation_id: envelope.metadata.correlation_id ?? randomUUID(),
          causation_id: eventId,
          actor: envelope.metadata.actor,
          occurred_at: occurredAt,
        },
      },
      undefined,
      client,
    );

    const updated = await applyIndentLineIssue(client, line.indent_line_id, input.quantity);
    if (!updated) {
      reject(
        'INDENT_LINE_FULLY_ISSUED',
        `Line ${line.line_no} is no longer open for issue`,
        { indent_id: indentId, indent_line_id: line.indent_line_id },
        409,
      );
    }
    const basis = await approvalBasisOf(line);
    const issueLine: IndentIssueLineRow = {
      issue_line_id: randomUUID(),
      issue_id: issueId,
      indent_id: indentId,
      indent_line_id: line.indent_line_id,
      line_no: line.line_no,
      sku: line.sku,
      quantity: input.quantity,
      uom: line.uom,
      location_id: input.location_id,
      location_code,
      lot_id: input.lot_id,
      serials: input.serials,
      stock_issued_event_id: stockEventId,
      approval_basis: basis,
      standing_grant_id: null,
    };
    await insertIndentIssueLine(issueLine, client);
    await logAuditEntry(client, {
      trace_id: envelope.metadata.correlation_id ?? '',
      user_id: envelope.metadata.actor.user_id,
      role: envelope.metadata.actor.role,
      location_id: envelope.metadata.actor.location_id,
      endpoint: `/indents/${indentId}/issue`,
      method: 'POST',
      event_id: eventId,
      http_status: 201,
      error_code: 'indent.line_issued',
      details: {
        indent_id: indentId,
        indent_line_id: line.indent_line_id,
        line_no: line.line_no,
        sku: line.sku,
        quantity: input.quantity,
        location_id: input.location_id,
        lot_id: input.lot_id,
        issue_number_ext: issueNumber,
        stock_issued_event_id: stockEventId,
      },
    });
    slipLines.push({
      line_no: line.line_no,
      sku: line.sku,
      quantity: input.quantity,
      uom: line.uom,
      location_code,
      lot_id: input.lot_id,
      serial_count: input.serials?.length ?? 0,
      requested_qty: line.requested_qty,
      issued_to_date: updated.issued_qty,
      approval_basis: basis,
    });
  }

  const site = await getLocationById(indent.site_id, client);
  const slip = renderIssueSlip({
    issue_number_ext: issueNumber,
    site_id: site?.location_code ?? indent.site_id,
    indent_number_ext: indent.indent_number_ext,
    requester_user_id: indent.requester_user_id,
    department_code: indent.department_code,
    earlier_slips: earlier.map((s) => s.issue_number_ext),
    issued_by: envelope.metadata.actor.user_id,
    issued_at: occurredAt,
    lines: slipLines,
  });
  await setIndentIssueSlip(issueId, slip, client);
}

async function applyIndentLineClosed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;
  const lineId = p['indent_line_id'] as string;
  const reason = (p['closed_reason'] as string).trim();

  const indent = await getIndentById(indentId, client, true);
  if (!indent) reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  assertHeaderClosable(indent);
  const lines = await getIndentLines(indentId, client, true);
  const line = lines.find((l) => l.indent_line_id === lineId);
  if (!line) {
    reject(
      'INDENT_LINE_NOT_FOUND',
      'Line does not belong to this indent',
      { indent_id: indentId, indent_line_id: lineId },
      404,
    );
  }
  assertLineIssuable(indent, line);
  const now = envelope.metadata.occurred_at;
  const closed = await closeIndentLine(client, lineId, {
    closed_reason: reason,
    closed_at: now,
    closed_by: envelope.metadata.actor.user_id,
  });
  if (!closed) {
    reject(
      'INDENT_LINE_CLOSED',
      `Line ${line.line_no} is no longer open`,
      { indent_id: indentId, indent_line_id: lineId },
      409,
    );
  }
  await logAuditEntry(client, {
    trace_id: envelope.metadata.correlation_id ?? '',
    user_id: envelope.metadata.actor.user_id,
    role: envelope.metadata.actor.role,
    location_id: envelope.metadata.actor.location_id,
    endpoint: `/indents/${indentId}/lines/${lineId}/close`,
    method: 'POST',
    event_id: eventId,
    http_status: 200,
    error_code: 'indent.line_closed',
    details: {
      indent_id: indentId,
      indent_line_id: lineId,
      line_no: line.line_no,
      sku: line.sku,
      issued_qty: line.issued_qty,
      requested_qty: line.requested_qty,
      closed_reason: reason,
    },
  });
  await emitNotificationInTransaction(
    {
      target: { role: envelope.metadata.actor.role, user_id: indent.requester_user_id },
      event_type: 'indent_decision',
      status_verb: 'closed',
      object_type: 'indent',
      object_id: indentId,
      actor_label: `Indent ${indent.indent_number_ext}`,
      next_step: `Line ${line.line_no} ${line.sku} closed at stores after ${line.issued_qty} of ${line.requested_qty} issued. Reason: ${reason}`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: now,
    },
    client,
  );
}

export async function applyIndentIssueProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = indentIssueEventType(envelope);
  if (!type) return;
  if (type === 'indent.issued') {
    await applyIndentIssued(envelope, client, eventId);
    return;
  }
  await applyIndentLineClosed(envelope, client, eventId);
}

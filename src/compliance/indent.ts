import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import type { IndentRow } from '../read/projections/indent.js';
import {
  getIndentById,
  insertIndent,
  insertIndentLine,
  recomputeIndentEstimatedValue,
  updateIndentStatus,
  findOpenDuplicate,
  allocateIndentNumber,
} from '../read/projections/indent.js';
import { findActiveDelegation } from '../read/projections/doa_registry.js';
import { emitNotification, emitNotificationInTransaction } from '../notify/emit.js';

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
const INDENT_EVENT_TYPES = new Set([
  'indent.raised',
  'indent.duplicate_flagged',
  'indent.confirmed',
  'indent.withdrawn',
  'indent.approved',
  'indent.rejected',
  'indent.ordered',
  'indent.cancelled',
  'indent.closed',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

export function indentEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!INDENT_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertIndentShape(envelope: EventEnvelope): void {
  const type = indentEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'indent.raised':
      assertIndentRaisedShape(p);
      break;
    case 'indent.duplicate_flagged':
      if (!isUuid(p['indent_id']))
        reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
      if (!isUuid(p['duplicate_of_indent_id']))
        reject('INVALID_PARAMS', 'duplicate_of_indent_id is required and must be a UUID');
      break;
    case 'indent.confirmed':
    case 'indent.withdrawn':
    case 'indent.closed':
      if (!isUuid(p['indent_id']))
        reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
      break;
    case 'indent.approved':
      if (!isUuid(p['indent_id']))
        reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
      if (!isUuid(p['approver_actor_id']))
        reject('INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
      break;
    case 'indent.rejected':
      if (!isUuid(p['indent_id']))
        reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
      if (!isUuid(p['approver_actor_id']))
        reject('INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
      if (!isNonEmptyString(p['rejection_reason']))
        reject(
          'INDENT_REJECTION_REASON_REQUIRED',
          'A rejection requires a non-empty rejection_reason',
          {
            indent_id: p['indent_id'],
          },
        );
      break;
    case 'indent.ordered':
      if (!isUuid(p['indent_id']))
        reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
      if (!isUuid(p['purchase_order_id']))
        reject('INVALID_PARAMS', 'purchase_order_id is required and must be a UUID');
      if (
        p['expected_delivery_date'] !== undefined &&
        p['expected_delivery_date'] !== null &&
        !isDateString(p['expected_delivery_date'])
      ) {
        reject('INVALID_PARAMS', 'expected_delivery_date must be a YYYY-MM-DD date string');
      }
      break;
    case 'indent.cancelled':
      if (!isUuid(p['indent_id']))
        reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
      if (
        p['cancelled_reason'] !== undefined &&
        p['cancelled_reason'] !== null &&
        typeof p['cancelled_reason'] !== 'string'
      ) {
        reject('INVALID_PARAMS', 'cancelled_reason must be a string');
      }
      break;
  }
}

function assertIndentRaisedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['indent_id'])) reject('INVALID_PARAMS', 'indent_id is required and must be a UUID');
  if (!isUuid(p['requester_user_id']))
    reject('INVALID_PARAMS', 'requester_user_id is required and must be a UUID');
  if (!isNonEmptyString(p['department_code']))
    reject('INVALID_PARAMS', 'department_code is required and must be a non-empty string');
  if (!isUuid(p['site_id'])) reject('INVALID_PARAMS', 'site_id is required and must be a UUID');
  if (!isNonEmptyString(p['business_stream']))
    reject('INVALID_PARAMS', 'business_stream is required and must be a non-empty string');
  if (!isDateString(p['need_by_date']))
    reject('INVALID_PARAMS', 'need_by_date is required and must be a YYYY-MM-DD date string');
  if (p['urgent'] !== undefined && typeof p['urgent'] !== 'boolean') {
    reject('INVALID_PARAMS', 'urgent must be a boolean');
  }
  if (p['reason'] !== undefined && p['reason'] !== null && typeof p['reason'] !== 'string') {
    reject('INVALID_PARAMS', 'reason must be a string');
  }

  if (!Array.isArray(p['lines']) || (p['lines'] as unknown[]).length === 0) {
    reject('INDENT_LINE_REQUIRED', 'A requisition requires at least one line item', {
      indent_id: p['indent_id'],
    });
  }
  let lineNo = 0;
  for (const line of p['lines'] as Record<string, unknown>[]) {
    lineNo += 1;
    if (!isNonEmptyString(line['sku'])) {
      reject('INVALID_PARAMS', `Line ${lineNo}: sku is required and must be a non-empty string`);
    }
    if (!isNonEmptyString(line['item_category'])) {
      reject(
        'INVALID_PARAMS',
        `Line ${lineNo}: item_category is required and must be a non-empty string`,
      );
    }
    if (
      typeof line['requested_qty'] !== 'number' ||
      !Number.isFinite(line['requested_qty']) ||
      (line['requested_qty'] as number) <= 0
    ) {
      reject(
        'INVALID_PARAMS',
        `Line ${lineNo}: requested_qty is required and must be a positive number`,
      );
    }
    if (!isNonEmptyString(line['uom'])) {
      reject('INVALID_PARAMS', `Line ${lineNo}: uom is required and must be a non-empty string`);
    }
    if (
      line['unit_price_estimate'] !== undefined &&
      line['unit_price_estimate'] !== null &&
      (typeof line['unit_price_estimate'] !== 'number' ||
        !Number.isFinite(line['unit_price_estimate']) ||
        (line['unit_price_estimate'] as number) < 0)
    ) {
      reject('INVALID_PARAMS', `Line ${lineNo}: unit_price_estimate must be a non-negative number`);
    }
  }
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

/**
 * Idempotent-replay guard. Deliberately NOT `FOR UPDATE` (unlike the Story 4.1 twin it is
 * modelled on): app_user holds only INSERT, SELECT on the append-only domain_events table, so
 * `SELECT ... FOR UPDATE` fails 42501 for every caller. A plain existence check is sufficient -
 * the row lock that serializes concurrent writers is the indent-row FOR UPDATE each apply
 * handler takes immediately after this guard.
 */
async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applyIndentProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = indentEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'indent.raised':
      await applyIndentRaised(envelope, client, eventId);
      break;
    case 'indent.duplicate_flagged':
      await applyIndentDuplicateFlagged(envelope, client);
      break;
    case 'indent.confirmed':
      await applyIndentConfirmed(envelope, client);
      break;
    case 'indent.withdrawn':
      await applyIndentWithdrawn(envelope, client);
      break;
    case 'indent.approved':
      await applyIndentApproved(envelope, client);
      break;
    case 'indent.rejected':
      await applyIndentRejected(envelope, client);
      break;
    case 'indent.ordered':
      await applyIndentOrdered(envelope, client);
      break;
    case 'indent.cancelled':
      await applyIndentCancelled(envelope, client);
      break;
    case 'indent.closed':
      await applyIndentClosed(envelope, client);
      break;
  }
}

async function applyIndentRaised(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const existing = await getIndentById(indentId, client, true);
  if (existing) {
    reject(
      'DUPLICATE_EVENT',
      'An indent with this indent_id already exists',
      {
        indent_id: indentId,
        existing_status: existing.status,
      },
      409,
    );
  }

  const lines = p['lines'] as Record<string, unknown>[];
  const windowDays =
    typeof p['duplicate_window_days'] === 'number' && p['duplicate_window_days'] > 0
      ? (p['duplicate_window_days'] as number)
      : config.indent.duplicateWindowDays;

  // AC 2 / AC 3: unless the requester has already explicitly confirmed this raise as intentional
  // (duplicate_confirmed, set by the online confirmation flow), look for an open indent for the
  // same SKU by the same requester within the configured window. On a hit, the capture is HELD in
  // pending-confirmation - never dropped, never thrown - and the requester is notified (AC 3).
  let duplicateOf: string | null = null;
  if (p['duplicate_confirmed'] !== true) {
    for (const line of lines) {
      const dup = await findOpenDuplicate(
        p['requester_user_id'] as string,
        line['sku'] as string,
        windowDays,
        client,
        indentId,
      );
      if (dup) {
        duplicateOf = dup.indent_id;
        break;
      }
    }
  }

  const occurredAt = envelope.metadata.occurred_at;
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
  const year = new Date(occurredAt).getUTCFullYear();
  const indentNumber = await allocateIndentNumber(year, client);

  // TOCTOU guard: alreadyPersisted does a plain SELECT (no FOR UPDATE on domain_events), so two
  // concurrent transactions can both pass the guard and race to INSERT. Catch the unique constraint
  // violation (PostgreSQL 23505) and treat it as "already persisted" - return gracefully.
  try {
    await insertIndent(
      {
        indent_id: indentId,
        indent_number_ext: indentNumber,
        requester_user_id: p['requester_user_id'] as string,
        department_code: (p['department_code'] as string).trim(),
        site_id: p['site_id'] as string,
        business_stream: (p['business_stream'] as string).trim(),
        need_by_date: p['need_by_date'] as string,
        urgent: p['urgent'] === true,
        reason: typeof p['reason'] === 'string' ? p['reason'] : null,
        status: duplicateOf ? 'pending-confirmation' : 'raised',
        approver_actor_id: isUuid(p['approver_actor_id'])
          ? (p['approver_actor_id'] as string)
          : null,
        doa_entry_id: isUuid(p['doa_entry_id']) ? (p['doa_entry_id'] as string) : null,
        duplicate_of_indent_id: duplicateOf,
        correlation_id: envelope.metadata.correlation_id ?? null,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      // Unique constraint violation on indent_id - another transaction inserted first
      return;
    }
    throw err;
  }

  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    await insertIndentLine(
      {
        indent_line_id: randomUUID(),
        indent_id: indentId,
        line_no: lineNo,
        sku: (line['sku'] as string).trim(),
        item_category: (line['item_category'] as string).trim(),
        requested_qty: line['requested_qty'] as number,
        uom: (line['uom'] as string).trim(),
        unit_price_estimate:
          typeof line['unit_price_estimate'] === 'number'
            ? (line['unit_price_estimate'] as number)
            : null,
      },
      client,
    );
  }
  await recomputeIndentEstimatedValue(indentId, client);

  if (duplicateOf) {
    // Audit trail of the hold, committed atomically with the raise (same client/transaction).
    await persistEvent(
      {
        stream_type: 'procurement',
        stream_id: indentId,
        event_type: 'indent.duplicate_flagged',
        payload: {
          indent_id: indentId,
          duplicate_of_indent_id: duplicateOf,
        },
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

    // AC 3: informational duplicate-hold notice to the requester. Plain emitNotification - it
    // never throws, so the offline-synced capture can never be lost to a notification failure.
    await emitNotification({
      target: {
        role: envelope.metadata.actor.role,
        user_id: p['requester_user_id'] as string,
      },
      event_type: 'indent_duplicate_hold',
      status_verb: 'held',
      object_type: 'indent',
      object_id: indentId,
      actor_label: `Indent ${indentNumber}`,
      next_step: 'A similar open requisition already exists. Confirm this indent or withdraw it.',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: occurredAt,
    });
  }
}

async function applyIndentDuplicateFlagged(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  if (indent.status !== 'raised' && indent.status !== 'pending-confirmation') {
    reject(
      'INDENT_NOT_IN_RAISED',
      'Only an open indent can be duplicate-flagged',
      {
        indent_id: indentId,
        status: indent.status,
      },
      409,
    );
  }
  // Prevent overwriting an existing duplicate link with a different indent
  if (
    indent.status === 'pending-confirmation' &&
    indent.duplicate_of_indent_id &&
    indent.duplicate_of_indent_id !== (p['duplicate_of_indent_id'] as string)
  ) {
    reject(
      'INDENT_ALREADY_DUPLICATE_FLAGGED',
      'Indent is already flagged as a duplicate of a different indent',
      {
        indent_id: indentId,
        existing_duplicate_of: indent.duplicate_of_indent_id,
        attempted_duplicate_of: p['duplicate_of_indent_id'],
      },
      409,
    );
  }

  await updateIndentStatus(
    indentId,
    'pending-confirmation',
    { duplicate_of_indent_id: p['duplicate_of_indent_id'] as string },
    client,
  );
}

async function applyIndentConfirmed(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  if (indent.status !== 'pending-confirmation') {
    reject(
      'INDENT_NOT_IN_RAISED',
      'Only an indent held in pending-confirmation can be confirmed',
      {
        indent_id: indentId,
        status: indent.status,
      },
      409,
    );
  }

  await updateIndentStatus(indentId, 'raised', {}, client);
}

async function applyIndentWithdrawn(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  if (indent.status !== 'pending-confirmation') {
    reject(
      'INDENT_NOT_IN_RAISED',
      'Only an indent held in pending-confirmation can be withdrawn',
      {
        indent_id: indentId,
        status: indent.status,
      },
      409,
    );
  }

  await updateIndentStatus(
    indentId,
    'cancelled',
    { cancelled_reason: 'withdrawn_by_requester' },
    client,
  );
}

/**
 * Shared guards for the approve/reject decision pair (AC 5, AC 6). Runs in the SEAM - not only
 * the HTTP handler - so a direct POST /api/v1/events or an edge upload cannot bypass SOD-01 or
 * the DOA resolution check (the Story 4.1 hole this story closes for indents).
 */
async function assertDecisionAllowed(
  envelope: EventEnvelope,
  indent: IndentRow,
  client: PoolClient,
): Promise<void> {
  if (indent.status === 'pending-confirmation') {
    reject(
      'INDENT_PENDING_CONFIRMATION',
      'Indent is held pending duplicate confirmation and is not routed for approval',
      {
        indent_id: indent.indent_id,
        status: indent.status,
      },
      409,
    );
  }
  if (indent.status === 'approved' || indent.status === 'rejected') {
    reject(
      'INDENT_ALREADY_DECIDED',
      'Indent has already been decided',
      {
        indent_id: indent.indent_id,
        status: indent.status,
      },
      409,
    );
  }
  if (indent.status !== 'raised') {
    reject(
      'INDENT_NOT_IN_RAISED',
      'Only a raised indent can be decided',
      {
        indent_id: indent.indent_id,
        status: indent.status,
      },
      409,
    );
  }

  const actorId = envelope.metadata.actor.user_id;

  // SOD-01: the requester can never decide their own indent.
  if (actorId === indent.requester_user_id) {
    reject(
      'INDENT_RAISER_CANNOT_APPROVE',
      'The requester cannot approve or reject their own indent (SOD-01)',
      {
        indent_id: indent.indent_id,
        requester_user_id: indent.requester_user_id,
      },
      403,
    );
  }

  // The acting approver must be the DOA-resolved authority or an active delegate of that holder.
  // If approver_actor_id is null (no DOA entry matched), reject - any non-requester writer could
  // otherwise approve.
  if (!indent.approver_actor_id) {
    reject(
      'NOT_RESOLVED_APPROVER',
      'No DOA-resolved approver exists for this indent; approval is not permitted',
      {
        indent_id: indent.indent_id,
      },
      403,
    );
  }
  if (actorId !== indent.approver_actor_id) {
    const today = envelope.metadata.occurred_at.slice(0, 10);
    const delegation = await findActiveDelegation(indent.approver_actor_id, today, client);
    if (!delegation || delegation.delegate_user_id !== actorId) {
      reject(
        'NOT_RESOLVED_APPROVER',
        'The acting user is not the DOA-resolved approver for this indent',
        {
          indent_id: indent.indent_id,
          approver_actor_id: indent.approver_actor_id,
          acting_user_id: actorId,
        },
        403,
      );
    }
  }
}

async function applyIndentApproved(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  await assertDecisionAllowed(envelope, indent, client);

  const now = envelope.metadata.occurred_at;
  await updateIndentStatus(
    indentId,
    'approved',
    { decided_at: now, decided_by: envelope.metadata.actor.user_id },
    client,
  );

  // AC 5: the decision notification is part of the business fact (AD-17) - transactional, to the
  // requester directly, through the Story 1.11 foundation.
  await emitNotificationInTransaction(
    {
      target: {
        role: envelope.metadata.actor.role,
        user_id: indent.requester_user_id,
      },
      event_type: 'indent_decision',
      status_verb: 'approved',
      object_type: 'indent',
      object_id: indentId,
      actor_label: `Indent ${indent.indent_number_ext}`,
      next_step: 'A purchase order will be placed against this requisition',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: now,
    },
    client,
  );
}

async function applyIndentRejected(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  // AC 5: the reason is mandatory - checked before touching the projection.
  if (!isNonEmptyString(p['rejection_reason'])) {
    reject(
      'INDENT_REJECTION_REASON_REQUIRED',
      'A rejection requires a non-empty rejection_reason',
      {
        indent_id: indentId,
      },
    );
  }

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  await assertDecisionAllowed(envelope, indent, client);

  const now = envelope.metadata.occurred_at;
  const reason = (p['rejection_reason'] as string).trim();
  await updateIndentStatus(
    indentId,
    'rejected',
    { decided_at: now, decided_by: envelope.metadata.actor.user_id, rejection_reason: reason },
    client,
  );

  await emitNotificationInTransaction(
    {
      target: {
        role: envelope.metadata.actor.role,
        user_id: indent.requester_user_id,
      },
      event_type: 'indent_decision',
      status_verb: 'rejected',
      object_type: 'indent',
      object_id: indentId,
      actor_label: `Indent ${indent.indent_number_ext}`,
      next_step: `Rejection reason: ${reason}`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: now,
    },
    client,
  );
}

async function applyIndentOrdered(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  if (indent.status !== 'approved') {
    reject(
      'INDENT_NOT_IN_RAISED',
      'Only an approved indent can move to ordered',
      {
        indent_id: indentId,
        status: indent.status,
      },
      409,
    );
  }

  await updateIndentStatus(
    indentId,
    'ordered',
    {
      purchase_order_id: p['purchase_order_id'] as string,
      expected_delivery_date: isDateString(p['expected_delivery_date'])
        ? (p['expected_delivery_date'] as string)
        : null,
    },
    client,
  );
}

async function applyIndentCancelled(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  if (
    indent.status !== 'raised' &&
    indent.status !== 'pending-confirmation' &&
    indent.status !== 'approved'
  ) {
    reject(
      'INDENT_NOT_IN_RAISED',
      'Only an open, undecided or approved indent can be cancelled',
      {
        indent_id: indentId,
        status: indent.status,
      },
      409,
    );
  }

  await updateIndentStatus(
    indentId,
    'cancelled',
    { cancelled_reason: typeof p['cancelled_reason'] === 'string' ? p['cancelled_reason'] : null },
    client,
  );
}

async function applyIndentClosed(envelope: EventEnvelope, client: PoolClient): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const indentId = p['indent_id'] as string;

  const indent = await getIndentById(indentId, client, true);
  if (!indent) {
    reject('INDENT_NOT_FOUND', 'Indent not found', { indent_id: indentId }, 404);
  }
  if (indent.status !== 'ordered') {
    reject(
      'INDENT_NOT_IN_RAISED',
      'Only an ordered indent can be closed',
      {
        indent_id: indentId,
        status: indent.status,
      },
      409,
    );
  }

  await updateIndentStatus(indentId, 'closed', {}, client);
}

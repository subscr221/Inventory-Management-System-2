import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { alreadyPersisted } from './indent.js';
import { toIstCalendarDate } from '../lib/business-days.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import {
  getRdRequisitionById,
  insertRdRequisition,
  insertRdRequisitionLine,
  markRdRequisitionOwnerApproved,
  markRdRequisitionHeadApproved,
  rejectRdRequisition,
  committedRdValue,
  actualRdCost,
} from '../read/projections/rd_requisition.js';
import type {
  RdRequisitionRaisedPayload,
  RdRequisitionRaisedLine,
} from '../events/schema.js';

/**
 * Story 10.2 (FR-RD-04/05): R&D requisition raise/approve/reject seams. Shape asserts run
 * PRE-transaction in store.ts (no DB access, never consume an idempotency key); appliers mutate
 * projections ONLY inside the persistEvent transaction. The budget check locks the project row
 * FOR UPDATE so concurrent raises serialize; the R&D head is resolved through the DOA registry
 * (never a hard-coded role name).
 */

const RESEARCH_STREAM_TYPES = new Set(['research']);
const RD_REQUISITION_EVENT_TYPES = new Set([
  'rd_requisition.raised',
  'rd_requisition.approved',
  'rd_requisition.rejected',
]);

const RD_REQUISITION_ISSUE_TYPES = new Set(['consumable', 'project_material', 'equipment_custody']);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QTY_REGEX = /^\d{1,9}(\.\d{1,3})?$/;
const COST_REGEX = /^\d{1,9}(\.\d{1,4})?$/;
// NUMERIC(18,4) holds 14 integer digits; reject any line whose value approaches that bound.
const MAX_LINE_VALUE = 1e13;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: unknown }).code === '23505';
}

export function rdRequisitionEventType(envelope: EventEnvelope): string | null {
  if (!RESEARCH_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!RD_REQUISITION_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function assertOccurredAt(occurredAt: unknown): asserts occurredAt is string {
  if (
    !occurredAt ||
    typeof occurredAt !== 'string' ||
    Number.isNaN(new Date(occurredAt).getTime())
  ) {
    reject('INVALID_PARAMS', 'occurred_at is required and must be a valid ISO 8601 date string');
  }
}

function assertRaisedLine(line: unknown): asserts line is RdRequisitionRaisedLine {
  const l = line as Record<string, unknown>;
  if (!l || typeof l !== 'object') reject('INVALID_PARAMS', 'requisition line must be an object');
  if (!isUuid(l['line_id'])) reject('INVALID_PARAMS', 'line_id must be a UUID');
  if (!isNonEmptyString(l['sku'])) reject('INVALID_PARAMS', 'line sku is required');
  if (typeof l['requested_qty'] !== 'string' || !QTY_REGEX.test(l['requested_qty']) || Number(l['requested_qty']) <= 0) {
    reject('INVALID_PARAMS', 'requested_qty must be a positive decimal string (max 9 int digits, 3 decimals)');
  }
  if (!isNonEmptyString(l['uom'])) reject('INVALID_PARAMS', 'line uom is required');
  if (typeof l['unit_cost_estimate'] !== 'string' || !COST_REGEX.test(l['unit_cost_estimate']) || Number(l['unit_cost_estimate']) <= 0) {
    reject('INVALID_PARAMS', 'unit_cost_estimate must be a positive decimal string (max 9 int digits, 4 decimals)');
  }
  if (typeof l['issue_type'] !== 'string' || !RD_REQUISITION_ISSUE_TYPES.has(l['issue_type'])) {
    if (typeof l['issue_type'] !== 'string' || l['issue_type'].trim() === '') {
      reject('RD_ISSUE_TYPE_REQUIRED', 'line issue_type is required');
    }
    reject('INVALID_PARAMS', `issue_type must be one of ${[...RD_REQUISITION_ISSUE_TYPES].join(', ')}`);
  }
  const magnitude = Number(l['requested_qty']) * Number(l['unit_cost_estimate']);
  if (!Number.isFinite(magnitude) || magnitude >= MAX_LINE_VALUE) {
    reject('INVALID_PARAMS', 'line value would overflow NUMERIC(18,4)');
  }
}

export function assertRdRequisitionShape(envelope: EventEnvelope): void {
  const type = rdRequisitionEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;
  assertOccurredAt(envelope.metadata.occurred_at);

  switch (type) {
    case 'rd_requisition.raised': {
      if (!isUuid(p['requisition_id'])) reject('INVALID_PARAMS', 'requisition_id must be a UUID');
      if (!isNonEmptyString(p['project_code'])) reject('INVALID_PARAMS', 'project_code is required');
      if (!isUuid(p['requester_user_id'])) reject('INVALID_PARAMS', 'requester_user_id must be a UUID');
      if (p['business_stream'] !== 'research') {
        reject('INVALID_PARAMS', 'business_stream must be research');
      }
      const lines = p['lines'];
      if (!Array.isArray(lines) || lines.length === 0) {
        reject('RD_REQUISITION_LINE_REQUIRED', 'at least one requisition line is required');
      }
      for (const line of lines) assertRaisedLine(line);
      break;
    }
    case 'rd_requisition.approved':
    case 'rd_requisition.rejected': {
      if (!isUuid(p['requisition_id'])) reject('INVALID_PARAMS', 'requisition_id must be a UUID');
      if (type === 'rd_requisition.rejected') {
        if (!isNonEmptyString(p['rejection_reason'])) {
          reject('INVALID_PARAMS', 'rejection_reason is required on reject');
        }
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Client-aware twin of resolveApprover (src/api/v1/indents.ts) so the R&D head resolves inside the
 * raise transaction. Never hard-codes a role name: the DOA registry decides the role.
 */
export async function resolveHeadApproverInTransaction(
  client: PoolClient,
  requesterId: string,
): Promise<{ approverActorId: string; doaEntryId: string }> {
  const doaEntry = await findMatchingDoaEntry('rd_budget_breach', 0, client);
  if (!doaEntry) {
    reject('APPROVAL_UNRESOLVED', 'Approval is required but no active approver could be resolved', {
      transaction_type: 'rd_budget_breach',
    }, 409);
  }
  const today = toIstCalendarDate(new Date());
  const tryHolder = async (role: string): Promise<string | null> => {
    const holder = await findRoleHolder(role, client);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today, client);
    const candidate = delegation?.delegate_user_id ?? holder.user_id;
    // SOD-01: the requester must never be resolved as the head-leg approver of their own
    // requisition, even when they hold the head role - fall through to the escalation walk.
    if (candidate === requesterId) return null;
    return candidate;
  };
  let approver = await tryHolder(doaEntry.role);
  if (!approver) {
    const entries = await listActiveDoaEntries('rd_budget_breach', client);
    for (const entry of entries) {
      if (entry.role === doaEntry.role) continue;
      approver = await tryHolder(entry.role);
      if (approver) break;
    }
  }
  if (!approver) {
    reject('APPROVAL_UNRESOLVED', 'Approval is required but no active approver could be resolved', {
      transaction_type: 'rd_budget_breach',
    }, 409);
  }
  return { approverActorId: approver, doaEntryId: doaEntry.entry_id };
}

async function applyRaised(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as unknown as RdRequisitionRaisedPayload;

  const project = await client.query(
    `SELECT phase, owner_user_id, budget_amount, status FROM rd_project
     WHERE project_code = $1 FOR UPDATE`,
    [p.project_code],
  );
  if (project.rows.length === 0 || project.rows[0]!['status'] !== 'active') {
    reject('PROJECT_CODE_REQUIRED', 'An R&D requisition needs an active project code', {
      project_code: p.project_code,
    }, 409);
  }
  const ownerUserId = project.rows[0]!['owner_user_id'] as string;
  const budgetAmount = String(project.rows[0]!['budget_amount']);

  // Insert lines first so their NUMERIC line_value is available to the budget probe.
  try {
    for (const line of p.lines) {
      await insertRdRequisitionLine(
        {
          requisition_line_id: line.line_id,
          requisition_id: p.requisition_id,
          sku: line.sku,
          requested_qty: line.requested_qty,
          uom: line.uom,
          unit_cost_estimate: line.unit_cost_estimate,
          issue_type: line.issue_type,
          source_event_id: eventId,
        },
        client,
      );
    }
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      reject('DUPLICATE_EVENT', 'A requisition line with this line_id already exists', {
        requisition_id: p.requisition_id,
      }, 409);
    }
    throw err;
  }
  const newValue = await client.query(
    `SELECT COALESCE(SUM(line_value), 0)::text AS v FROM rd_requisition_line WHERE requisition_id = $1`,
    [p.requisition_id],
  );
  // NUMERIC(18,4) holds 14 integer digits: reject an aggregate that would overflow the header
  // insert before the insert is attempted (a raw numeric out-of-range would otherwise be a 500).
  if (Number(newValue.rows[0]!['v'] as string) >= 1e14) {
    reject('INVALID_PARAMS', 'aggregate requisition value would overflow NUMERIC(18,4)');
  }
  const committed = await committedRdValue(p.project_code, client);
  const actual = await actualRdCost(p.project_code, client);
  const breach = await client.query(
    `SELECT ($1::numeric + $2::numeric + $3::numeric) > $4::numeric AS breach`,
    [committed, actual, newValue.rows[0]!['v'] as string, budgetAmount],
  );
  const isBreach = breach.rows[0]!['breach'] === true;

  let status: 'approved' | 'approval_required' = 'approved';
  let approverActorId: string | null = null;
  let doaEntryId: string | null = null;
  let ownerApproverId: string | null = null;
  let ownerSponsorsOwnRequisition = false;
  if (isBreach) {
    status = 'approval_required';
    const head = await resolveHeadApproverInTransaction(client, p.requester_user_id);
    approverActorId = head.approverActorId;
    doaEntryId = head.doaEntryId;
    ownerSponsorsOwnRequisition = p.requester_user_id === ownerUserId;
    ownerApproverId = ownerSponsorsOwnRequisition ? null : ownerUserId;
  }

  try {
    await insertRdRequisition(
      {
        requisition_id: p.requisition_id,
        project_code: p.project_code,
        requester_user_id: p.requester_user_id,
        business_stream: p.business_stream,
        estimated_value: newValue.rows[0]!['v'] as string,
        status,
        budget_breach: isBreach,
        approver_actor_id: approverActorId,
        doa_entry_id: doaEntryId,
        owner_approver_id: ownerApproverId,
        source_event_id: eventId,
      },
      client,
    );
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      reject('DUPLICATE_EVENT', 'A requisition with this requisition_id already exists', {
        requisition_id: p.requisition_id,
      }, 409);
    }
    throw err;
  }

  if (ownerSponsorsOwnRequisition) {
    await markRdRequisitionOwnerApproved(p.requisition_id, p.requester_user_id, client);
  }
}

async function applyDecided(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload as Record<string, unknown>;
  const requisitionId = p['requisition_id'] as string;
  const decision = envelope.event_type === 'rd_requisition.approved' ? 'approved' : 'rejected';
  const actorId = envelope.metadata.actor.user_id;

  const req = await getRdRequisitionById(requisitionId, client, true);
  if (!req) {
    reject('RD_REQUISITION_NOT_FOUND', 'Requisition not found', { requisition_id: requisitionId }, 404);
  }
  if (req.status !== 'approval_required') {
    reject('RD_REQUISITION_ALREADY_DECIDED', 'Requisition is not pending approval', {
      requisition_id: requisitionId,
      status: req.status,
    }, 409);
  }
  if (actorId === req.requester_user_id) {
    reject('NOT_RESOLVED_APPROVER', 'The requester cannot approve or reject their own requisition (SOD-01)', {
      requisition_id: requisitionId,
    }, 403);
  }
  const isOwner = req.owner_approver_id !== null && actorId === req.owner_approver_id;
  const isHead = req.approver_actor_id !== null && actorId === req.approver_actor_id;
  if (!isOwner && !isHead) {
    reject('NOT_RESOLVED_APPROVER', 'The acting user is not a resolved approver for this requisition', {
      requisition_id: requisitionId,
      acting_user_id: actorId,
    }, 403);
  }

  if (decision === 'approved') {
    // A single act satisfies whichever leg(s) the actor holds. When the owner and the resolved
    // head are the SAME user, one signature satisfies both legs (the noted single-signoff case).
    if (isOwner) await markRdRequisitionOwnerApproved(requisitionId, actorId, client);
    if (isHead) await markRdRequisitionHeadApproved(requisitionId, actorId, client);
  } else {
    await rejectRdRequisition(requisitionId, actorId, p['rejection_reason'] as string, client);
  }
}

export async function applyRdRequisitionProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = rdRequisitionEventType(envelope);
  if (!type) return;
  switch (type) {
    case 'rd_requisition.raised':
      await applyRaised(envelope, client, eventId);
      break;
    case 'rd_requisition.approved':
    case 'rd_requisition.rejected':
      await applyDecided(envelope, client);
      break;
    default:
      break;
  }
}

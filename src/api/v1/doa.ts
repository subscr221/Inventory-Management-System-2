import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { getParsedBody, getAuthContext, getAuthorizedAssignment, getTraceId } from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { logTamperAttempt } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import { lookupActiveUserWithRoles } from '../../read/projections/users.js';
import {
  createDoaEntry,
  updateDoaEntry,
  getDoaEntry,
  findMatchingDoaEntry,
  transactionTypeIsGoverned,
  createVacationDelegation,
  findActiveDelegation,
  findRoleHolder,
  getExternalIdByUserId,
} from '../../read/projections/doa_registry.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Sentinel used ONLY for the domain-event envelope's actor.location_id when the acting admin's
// authorizing assignment is enterprise-wide ('*'), which is not a UUID. The audit_log.location_id
// (TEXT) has no such constraint, so it records the real '*' assignment value. See Story 1.4 Dev
// Notes: Event Envelope Actor.
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

type WriteAuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

interface ActorContext {
  userId: string;
  role: string;
  /** The authorizing assignment's location as-is ('*' or a UUID) - used for the audit log row. */
  auditLocationId: string;
  /** UUID-safe location for the domain-event envelope actor ('*' becomes the zero-UUID sentinel). */
  eventLocationId: string;
}

/** Derives the acting admin's identity from the server's own auth/RBAC decision, never the body. */
function actorContext(req: IncomingMessage): ActorContext {
  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  // requireRole runs before these handlers and rejects unauthenticated/unauthorized callers, so both
  // are present here; the fallbacks keep the types honest without inventing an identity.
  const userId = authContext?.userId ?? NO_LOCATION_UUID;
  const role = assignment?.role ?? '';
  const auditLocationId = assignment?.locationId ?? '*';
  const eventLocationId = auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId;
  return { userId, role, auditLocationId, eventLocationId };
}

function auditCtxFor(req: IncomingMessage, actor: ActorContext, httpStatus: number): WriteAuditCtx {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parses an optional numeric bound: absent/null becomes null; a non-finite number is a 400. */
function parseOptionalBound(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError(400, 'INVALID_PARAMS', `${name} must be a finite number or null`);
  }
  return value;
}

// -----------------------------------------------------------------------------------------------
// Task 2.1 - POST /api/v1/doa/entries
// -----------------------------------------------------------------------------------------------
const createDoaEntryBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['role']) || !isNonEmptyString(body['transaction_type'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'role and transaction_type are required non-empty strings');
    return;
  }
  const valueMin = parseOptionalBound(body['value_min'], 'value_min');
  const valueMax = parseOptionalBound(body['value_max'], 'value_max');
  if (valueMin !== null && valueMax !== null && valueMax <= valueMin) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'value_max must be greater than value_min');
    return;
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entry = await createDoaEntry(
      { role: body['role'], transaction_type: body['transaction_type'], value_min: valueMin, value_max: valueMax },
      client,
    );
    await persistEvent(
      {
        stream_type: 'doa_registry_entry',
        stream_id: entry.entry_id,
        event_type: 'doa_registry.entry_created',
        payload: { entry },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    await client.query('COMMIT');
    sendJson(res, 201, entry);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// Task 2.2 - PATCH /api/v1/doa/entries/:entryId
// -----------------------------------------------------------------------------------------------
const updateDoaEntryBase: RouteHandler = async (req, res, params) => {
  const entryId = params['entryId'];
  if (!entryId || !UUID_REGEX.test(entryId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'entryId must be a valid UUID');
    return;
  }
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body must be a JSON object');
    return;
  }

  // Build the validated patch from only the fields present in the body.
  const patch: { role?: string; transaction_type?: string; value_min?: number | null; value_max?: number | null; active?: boolean } = {};
  if (body['role'] !== undefined) {
    if (!isNonEmptyString(body['role'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'role must be a non-empty string');
      return;
    }
    patch.role = body['role'];
  }
  if (body['transaction_type'] !== undefined) {
    if (!isNonEmptyString(body['transaction_type'])) {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transaction_type must be a non-empty string');
      return;
    }
    patch.transaction_type = body['transaction_type'];
  }
  if (body['value_min'] !== undefined) patch.value_min = parseOptionalBound(body['value_min'], 'value_min');
  if (body['value_max'] !== undefined) patch.value_max = parseOptionalBound(body['value_max'], 'value_max');
  if (body['active'] !== undefined) {
    if (typeof body['active'] !== 'boolean') {
      sendRequestError(req, res, 400, 'INVALID_PARAMS', 'active must be a boolean');
      return;
    }
    patch.active = body['active'];
  }
  if (Object.keys(patch).length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'At least one updatable field is required');
    return;
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await getDoaEntry(entryId, client);
    if (!before) {
      throw new AppError(404, 'NOT_FOUND', `No DOA entry with id "${entryId}"`);
    }
    // Validate the value band against the MERGED (existing + patch) values, not the patch alone.
    const mergedMin = patch.value_min !== undefined ? patch.value_min : before.value_min;
    const mergedMax = patch.value_max !== undefined ? patch.value_max : before.value_max;
    if (mergedMin !== null && mergedMax !== null && mergedMax <= mergedMin) {
      throw new AppError(400, 'INVALID_PARAMS', 'value_max must be greater than value_min');
    }
    const after = await updateDoaEntry(entryId, patch, client);
    await persistEvent(
      {
        stream_type: 'doa_registry_entry',
        stream_id: entryId,
        event_type: 'doa_registry.entry_updated',
        payload: { entry_id: entryId, before, after },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 200),
      client,
    );
    await client.query('COMMIT');
    sendJson(res, 200, after);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// Task 3.1 - POST /api/v1/doa/delegations
// -----------------------------------------------------------------------------------------------
const createDelegationBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (
    !body ||
    !isNonEmptyString(body['delegator_external_id']) ||
    !isNonEmptyString(body['delegate_external_id']) ||
    !isNonEmptyString(body['start_date']) ||
    !isNonEmptyString(body['end_date'])
  ) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'delegator_external_id, delegate_external_id, start_date, end_date are required');
    return;
  }
  const startDate = body['start_date'];
  const endDate = body['end_date'];
  if (!DATE_REGEX.test(startDate) || Number.isNaN(Date.parse(startDate)) || !DATE_REGEX.test(endDate) || Number.isNaN(Date.parse(endDate))) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'start_date and end_date must be valid YYYY-MM-DD dates');
    return;
  }
  if (endDate < startDate) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'end_date must not be before start_date');
    return;
  }

  // Resolve both parties to active users. lookupActiveUserWithRoles returns null for a non-existent
  // OR deprovisioned user, giving us the resolution AND the active check the story requires in a
  // single reused query - a delegation naming a deprovisioned delegator/delegate is not creatable.
  const delegator = await lookupActiveUserWithRoles(body['delegator_external_id']);
  if (!delegator) {
    sendRequestError(req, res, 404, 'NOT_FOUND', `No active user with externalId "${body['delegator_external_id']}"`);
    return;
  }
  const delegate = await lookupActiveUserWithRoles(body['delegate_external_id']);
  if (!delegate) {
    sendRequestError(req, res, 404, 'NOT_FOUND', `No active user with externalId "${body['delegate_external_id']}"`);
    return;
  }

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delegation = await createVacationDelegation(
      { delegator_user_id: delegator.userId, delegate_user_id: delegate.userId, start_date: startDate, end_date: endDate },
      client,
    );
    await persistEvent(
      {
        stream_type: 'doa_vacation_delegation',
        stream_id: delegation.delegation_id,
        event_type: 'doa_registry.vacation_delegation_created',
        payload: {
          delegation_id: delegation.delegation_id,
          delegator_user_id: delegation.delegator_user_id,
          delegate_user_id: delegation.delegate_user_id,
          start_date: delegation.start_date,
          end_date: delegation.end_date,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 201),
      client,
    );
    await client.query('COMMIT');
    sendJson(res, 201, delegation);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// -----------------------------------------------------------------------------------------------
// Task 4 - POST /api/v1/doa/resolve (read-only)
// -----------------------------------------------------------------------------------------------
const resolveDoaBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['transaction_type'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transaction_type is required');
    return;
  }
  if (typeof body['value'] !== 'number' || !Number.isFinite(body['value'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'value is required and must be a finite number');
    return;
  }
  // as_of_date exists purely to make AC2's dated delegation window deterministically testable;
  // absent, resolution uses the current UTC date.
  let asOfDate: string;
  if (body['as_of_date'] === undefined) {
    asOfDate = new Date().toISOString().slice(0, 10);
  } else if (isNonEmptyString(body['as_of_date']) && DATE_REGEX.test(body['as_of_date']) && !Number.isNaN(Date.parse(body['as_of_date']))) {
    asOfDate = body['as_of_date'];
  } else {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'as_of_date must be a valid YYYY-MM-DD date');
    return;
  }

  const transactionType = body['transaction_type'];
  const value = body['value'];

  const entry = await findMatchingDoaEntry(transactionType, value);
  if (!entry) {
    sendRequestError(req, res, 404, 'NO_DOA_ENTRY_MATCH', `No DOA entry governs "${transactionType}" at value ${value}`);
    return;
  }
  const holder = await findRoleHolder(entry.role);
  if (!holder) {
    sendRequestError(req, res, 404, 'NO_APPROVER_FOUND', `No active user holds role "${entry.role}"`);
    return;
  }

  const delegation = await findActiveDelegation(holder.user_id, asOfDate);
  let approver: { user_id: string; external_id: string | null };
  let delegationApplied: boolean;
  let delegatedFrom: string | null;
  if (delegation) {
    approver = { user_id: delegation.delegate_user_id, external_id: await getExternalIdByUserId(delegation.delegate_user_id) };
    delegationApplied = true;
    delegatedFrom = holder.user_id;
  } else {
    approver = { user_id: holder.user_id, external_id: holder.external_id };
    delegationApplied = false;
    delegatedFrom = null;
  }

  sendJson(res, 200, {
    matched_entry: {
      entry_id: entry.entry_id,
      role: entry.role,
      transaction_type: entry.transaction_type,
      value_min: entry.value_min,
      value_max: entry.value_max,
    },
    approver,
    delegation_applied: delegationApplied,
    delegated_from: delegatedFrom,
  });
};

// -----------------------------------------------------------------------------------------------
// Task 5 - POST /api/v1/doa/workflow-config (synthetic spine-test scaffold)
//
// This is NOT a real workflow-configuration module (none exists yet - Epic 4 is unbuilt). It exists
// solely to make FR-DOA-01's "workflow config can never override the registry" invariant observable
// now, the same way Story 1.6's synthetic putaway event and Story 1.7's synthetic QC-result command
// made their spine invariants observable before their consuming modules existed.
// -----------------------------------------------------------------------------------------------
const workflowConfigBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body || !isNonEmptyString(body['transaction_type'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transaction_type is required');
    return;
  }
  const transactionType = body['transaction_type'];

  // Existence check (not a value-band match): if the DOA registry governs this transaction type at
  // all, a workflow config supplying its own approver mapping is a spine bypass attempt.
  if (await transactionTypeIsGoverned(transactionType)) {
    const actor = actorContext(req);
    const pool = getPool();
    const client = await pool.connect();
    try {
      // Reuse Story 1.3's tamper-attempt log: DOA_OVERRIDE_BLOCKED and AUDIT_LOG_TAMPER_ATTEMPT are
      // both "someone tried to bypass the compliance spine", so they share one record table rather
      // than adding a parallel one.
      await logTamperAttempt(client, {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.auditLocationId,
        endpoint: req.url ?? null,
        method: req.method ?? null,
        error_code: 'DOA_OVERRIDE_BLOCKED',
        details: { transaction_type: transactionType, reason: 'Workflow config attempted to override a DOA-governed transaction type' },
      });
    } finally {
      client.release();
    }
    sendRequestError(req, res, 409, 'DOA_OVERRIDE_BLOCKED', `Transaction type "${transactionType}" is governed by the DOA registry and cannot be overridden`);
    return;
  }

  // Ungoverned transaction type: the gate correctly does not fire. There is no real workflow-config
  // store to write to yet, so nothing is persisted - this branch only proves the negative case.
  sendJson(res, 200, { accepted: true });
};

export const createDoaEntryHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'write' })(createDoaEntryBase);
export const updateDoaEntryHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'write' })(updateDoaEntryBase);
export const createDelegationHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'write' })(createDelegationBase);
export const resolveDoaHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'read' })(resolveDoaBase);
export const workflowConfigHandler: RouteHandler = requireRole({ module: 'compliance', functionScope: 'write' })(workflowConfigBase);

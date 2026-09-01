import { SignJWT } from 'jose';
import { createSecretKey } from 'node:crypto';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson } from '../../middleware/error.js';
import {
  getAuthContext,
  getAuthorizedAssignment,
  getParsedBody,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import { validateEnvelope, persistEvent } from '../../events/store.js';
import {
  validateEdgeEnvelope,
  assertEdgeMaintenanceEventAllowed,
  // Story 6.4 (FR-MO-13, AC 6): the production-stream allowlist and the edit-log write its refusal
  // requires.
  assertEdgeProductionEventAllowed,
  assertEdgeQcEventAllowed,
  isPermanentUploadErrorCode,
  REBASE_SAFE_EVENT_TYPES,
} from '../../sync/upload.js';
import {
  findExistingEdgeEvent,
  getStreamHeadVersions,
  listStreamEventTypesAfter,
} from '../../sync/stream-heads.js';
import { logRejectionAudit } from '../../read/projections/audit_log.js';
import { raiseMaintenanceSyncConflict } from '../../maintenance/sync-conflicts.js';
import type { SyncConflictCause } from '../../maintenance/sync-conflicts.js';
import { notifyFaultReported } from '../../maintenance/fault-notifications.js';
import { ZoneIncompatibleWarning, zoneWarningEnvelope } from '../../compliance/inventory-master.js';
import { OWNERSHIP_CONFIG_ROLES } from '../../compliance/ownership.js';
import { config } from '../../config/index.js';
import type { AuthContext } from '../../middleware/context.js';
import { getCrossDockTaskById } from '../../read/projections/cross_dock_task.js';
import { assertCrossDockEventShape } from '../../compliance/cross-dock.js';
import { resolveApprover, INDENT_DOA_TYPE } from './indents.js';
import {
  countOpenWorkOrders,
  listOpenWorkOrdersForWorklist,
} from '../../read/projections/maintenance_work_order.js';
import { listRecentClosuresForAsset } from '../../read/projections/maintenance_work_order_closure.js';
import { listSpareReservations } from '../../read/projections/maintenance_spare_reservation.js';
import { listMeters } from '../../read/projections/asset_meter.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const PLANNING_EVENT_TYPES = new Set([
  'inventory_planning.params_set',
  'inventory_planning.safety_stock_computed',
  'replenishment.recommended',
  'obsolescence.flagged',
  'obsolescence.cleared',
  // Story 2.8: ownership agreements are location-scoped config; the payload location must be
  // write-permitted exactly like the planning events above.
  'ownership.agreement_set',
]);

/**
 * Story 3.7 SOD: frontline roles that may confirm pick lines but may perform no dispatch-side
 * action. Behaviour is exactly as Story 3.7 shipped it; the list is a named constant only so the
 * comparison reads through `.includes()` rather than as inline role literals, which the
 * doa/no-hardcoded-role-in-workflow lint rule rejects (it was failing `npm run lint` at HEAD).
 */
const DISPATCH_DENIED_FRONTLINE_ROLES = ['store_assistant', 'warehouse_operator'];
const CROSS_DOCK_EXECUTE_ROLES = ['store_assistant', 'warehouse_operator'];

function planningPayloadLocation(body: {
  stream_type: string;
  event_type: string;
  payload: Record<string, unknown>;
}): string | null {
  if (body.stream_type !== 'inventory' || !PLANNING_EVENT_TYPES.has(body.event_type)) return null;
  const locationId = body.payload['location_id'];
  return typeof locationId === 'string' ? locationId : null;
}

function assertPlanningPayloadWriteLocation(
  authContext: AuthContext,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  const locationId = planningPayloadLocation(body);
  if (!locationId) return;
  if (body.event_type === 'ownership.agreement_set') {
    const allowed = authContext.roles.some(
      (r) =>
        (r.module === 'inventory' || r.module === '*') &&
        r.functionScope === 'write' &&
        OWNERSHIP_CONFIG_ROLES.includes(r.role),
    );
    if (!allowed)
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        `This operation is restricted to roles: ${OWNERSHIP_CONFIG_ROLES.join(', ')}`,
      );
  }
  const { wildcard, locations } = permittedLocationsForModuleScope(
    authContext.roles,
    'inventory',
    'write',
  );
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No write assignment grants access to planning payload location "${locationId}"`,
    );
  }
}

function edgeSiteName(): string {
  return config.edge.siteName;
}

function powerSyncSecretKey(): ReturnType<typeof createSecretKey> {
  return createSecretKey(Buffer.from(config.powerSync.tokenSecret, 'utf-8'));
}

interface OperatingAssignment {
  role: string;
  locationId: string;
}

function selectOperatingAssignment(authContext: AuthContext): OperatingAssignment {
  const concrete = authContext.roles.filter((r) => r.locationId !== '*');
  const distinctLocations = new Set(concrete.map((r) => r.locationId));

  if (distinctLocations.size === 0) {
    throw new AppError(
      403,
      'EDGE_NO_CONCRETE_SITE',
      'No concrete operating location is assigned to this user; edge sync requires a specific site assignment',
    );
  }
  if (distinctLocations.size > 1) {
    throw new AppError(
      409,
      'EDGE_AMBIGUOUS_SITE',
      'Multiple concrete operating locations are assigned to this user; edge sync requires a single site',
    );
  }

  const locationId = [...distinctLocations][0]!;
  const assignment = concrete
    .filter((r) => r.locationId === locationId)
    .sort((a, b) =>
      [a.role, a.module, a.functionScope]
        .join('\0')
        .localeCompare([b.role, b.module, b.functionScope].join('\0')),
    )[0]!;
  return { role: assignment.role, locationId };
}

function resolveModuleFromBody(_params: Record<string, string>, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const streamType = (body as Record<string, unknown>)['stream_type'];
    if (typeof streamType === 'string') return streamType;
  }
  return '';
}

function resolveLocationFromBody(
  _params: Record<string, string>,
  body: unknown,
): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (record['stream_type'] === 'warehouse' && record['event_type'] === 'cross_dock_task.completed')
    return undefined;
  const metadata = record['metadata'];
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const actor = (metadata as Record<string, unknown>)['actor'];
  if (typeof actor !== 'object' || actor === null) return undefined;
  const locationId = (actor as Record<string, unknown>)['location_id'];
  return typeof locationId === 'string' ? locationId : undefined;
}

const edgeBootstrapBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

  const assignment = selectOperatingAssignment(authContext);

  sendJson(res, 200, {
    user_id: authContext.userId,
    user_name: authContext.displayName ?? authContext.externalId,
    site_id: assignment.locationId,
    site_name: edgeSiteName(),
    role: assignment.role,
    navigation: ['Dashboard', 'Frontline'],
    offline_ready: true,
  });
};

const powerSyncCredentialsBase: RouteHandler = async (req, res) => {
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');

  const assignment = selectOperatingAssignment(authContext);

  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    user_id: authContext.userId,
    role: assignment.role,
    site_id: assignment.locationId,
    site_name: edgeSiteName(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(authContext.externalId)
    .setIssuer(config.powerSync.tokenIssuer)
    .setAudience(config.powerSync.tokenAudience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + config.powerSync.tokenTtlSeconds)
    .sign(powerSyncSecretKey());

  sendJson(res, 200, {
    endpoint: config.powerSync.url,
    token,
    expires_in_seconds: config.powerSync.tokenTtlSeconds,
  });
};

const edgeEventUploadBase: RouteHandler = async (req, res) => {
  const body = getParsedBody(req);
  validateEnvelope(body);
  validateEdgeEnvelope(body);
  assertCrossDockEventShape(body);

  const authContext = getAuthContext(req);
  const assignment = getAuthorizedAssignment(req);
  if (!authContext || !assignment)
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  assertPlanningPayloadWriteLocation(authContext, body);

  // Story 7.8 (Binding Decision 10): an explicit event-type allowlist for the maintenance stream.
  // Return-to-service and every other central-only maintenance operation reject 403
  // CENTRAL_ONLY_OPERATION here, before any identity or version work.
  assertEdgeMaintenanceEventAllowed(body);
  // Story 8.1 (Binding Scope Decision 9): the same allowlist shape for the qc stream - plan
  // creation, approval, completion hand-off and conditional release are central-only.
  assertEdgeQcEventAllowed(body);
  // Story 6.4 (FR-MO-13, AC 6): the production stream's allowlist. Release, cancel and close are
  // central-only; close is caught by a payload predicate because it shares an event type with the
  // transitions a plant device legitimately records offline. AC 6 requires the REFUSAL itself to
  // reach the edit log - it never reaches persistEvent, so it is written here before rethrowing.
  try {
    assertEdgeProductionEventAllowed(body);
  } catch (err: unknown) {
    if (err instanceof AppError && err.errorCode === 'CENTRAL_ONLY_OPERATION') {
      await logRejectionAudit({
        trace_id: getTraceId(req) ?? '',
        user_id: authContext.userId,
        role: assignment.role,
        location_id: assignment.locationId,
        endpoint: req.url ?? '',
        method: req.method ?? 'POST',
        event_id: null,
        http_status: err.statusCode,
        error_code: err.errorCode,
        details: {
          stream_type: body.stream_type,
          stream_id: body.stream_id,
          production_order_id: body.payload?.['production_order_id'] ?? null,
          ...err.details,
        },
      });
    }
    throw err;
  }

  // Story 7.8 (Binding Decision 1, AD-16, Story 1.8 AC): a replayed edge submission is HTTP 409
  // DUPLICATE_EVENT with the existing event identity, on BOTH the sequential path (this SELECT)
  // and the race path (the uq_idempotency / domain_events_pkey 23505 mapper in persistEvent, which
  // throws 409 instead of returning the existing row because the persist below is strict). The
  // device connector already maps this to `synced`, so the device outcome is unchanged; the change
  // restores the route's own contract. The REST handlers keep their replayIdOrReject 2xx replay
  // contract untouched.
  const existing = await findExistingEdgeEvent(body);
  if (existing) {
    throw new AppError(409, 'DUPLICATE_EVENT', 'Event already exists', {
      existing_event_id: existing.event_id,
      existing_event_type: existing.event_type,
    });
  }

  body.metadata.actor.user_id = authContext.userId;
  body.metadata.actor.role = assignment.role;
  let auditRole = assignment.role;
  let auditLocationId = assignment.locationId;
  let authoritativeSiteId: string | null = null;
  if (body.stream_type === 'warehouse' && body.event_type === 'cross_dock_task.completed') {
    const taskId = body.payload['cross_dock_task_id'];
    if (
      typeof taskId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)
    ) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'cross_dock_task_id is required and must be a UUID',
      );
    }
    const task = await getCrossDockTaskById(taskId);
    if (!task) throw new AppError(404, 'CROSS_DOCK_TASK_NOT_FOUND', 'Cross-dock task not found');
    const permitted = permittedLocationsForModuleScope(authContext.roles, 'warehouse', 'write');
    if (!permitted.wildcard && !permitted.locations.has(task.site_id)) {
      throw new AppError(
        403,
        'LOCATION_ACCESS_DENIED',
        `No write assignment grants access to task site "${task.site_id}"`,
      );
    }
    const covering = authContext.roles.find(
      (role) =>
        (role.module === 'warehouse' || role.module === '*') &&
        role.functionScope === 'write' &&
        CROSS_DOCK_EXECUTE_ROLES.includes(role.role) &&
        (role.locationId === '*' || role.locationId === task.site_id),
    );
    if (!covering)
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        'Cross-dock completion requires an operator role',
      );
    body.metadata.actor.role = covering.role;
    body.metadata.actor.location_id = task.site_id;
    body.payload['completed_by'] = authContext.userId;
    // Server-owned deterministic projection IDs: override edge-generated random UUIDs
    // so replay never produces different pick_task/pick_line identifiers (Task 2).
    body.payload['pick_task_id'] = globalThis.crypto.randomUUID();
    body.payload['pick_line_id'] = globalThis.crypto.randomUUID();
    auditRole = covering.role;
    auditLocationId = task.site_id;
    authoritativeSiteId = task.site_id;
  }
  if (body.stream_type === 'gate' && body.event_type === 'gate.entered') {
    body.payload['gate_officer_id'] = authContext.userId;
  }
  // Story 3.3: the weighbridge operator identity is the authenticated actor, never trusted from the
  // edge payload (mirrors gate_officer_id above).
  if (body.stream_type === 'weighbridge' && body.event_type === 'weighbridge.recorded') {
    body.payload['weighed_by'] = authContext.userId;
  }
  // Story 3.4: the receiving store assistant identity is the authenticated actor, never trusted from
  // the edge payload (mirrors weighed_by/gate_officer_id above).
  if (body.stream_type === 'receiving' && body.event_type === 'goods.received') {
    body.payload['received_by'] = authContext.userId;
  }
  // Story 3.6: the picking operator identity is the authenticated actor, never trusted from the
  // edge payload (mirrors received_by/weighed_by/gate_officer_id above).
  if (body.stream_type === 'warehouse' && body.event_type === 'pick_line.confirmed') {
    body.payload['confirmed_by'] = authContext.userId;
  }
  if (body.stream_type === 'warehouse' && body.event_type === 'pick_task.completed') {
    body.payload['completed_by'] = authContext.userId;
  }
  // Story 3.7: the dispatch operator identity is the authenticated actor, never trusted from the
  // edge payload (mirrors pick_line.confirmed above).
  // Task 7.3 SOD guard: packing, document generation, and dispatch confirmation are all
  // dispatch_clerk/warehouse_manager(/inventory_controller for doc-gen) operations. Reject
  // store_assistant and warehouse_operator, who can confirm pick lines but not perform any
  // dispatch-side action, across all three event types (not just dispatch.dispatched).
  if (body.stream_type === 'warehouse' && body.event_type === 'dispatch.packed') {
    body.payload['packed_by'] = authContext.userId;
    const role = assignment.role;
    if (DISPATCH_DENIED_FRONTLINE_ROLES.includes(role)) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        `Role "${role}" is not authorized to pack a dispatch order`,
      );
    }
  }
  if (
    body.stream_type === 'warehouse' &&
    body.event_type === 'dispatch.shipping_documents_generated'
  ) {
    body.payload['generated_by'] = authContext.userId;
    const role = assignment.role;
    if (DISPATCH_DENIED_FRONTLINE_ROLES.includes(role)) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        `Role "${role}" is not authorized to generate shipping documents`,
      );
    }
  }
  if (body.stream_type === 'warehouse' && body.event_type === 'dispatch.dispatched') {
    body.payload['dispatched_by'] = authContext.userId;
    const role = assignment.role;
    if (DISPATCH_DENIED_FRONTLINE_ROLES.includes(role)) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        `Role "${role}" is not authorized to confirm dispatch`,
      );
    }
  }
  // Story 4.1: supplier creation identity is the authenticated actor. Supplier GSTIN uniqueness
  // is enforced inside the compliance seam (not here), so both HTTP and edge paths are guarded.
  if (body.stream_type === 'procurement' && body.event_type === 'supplier.registered') {
    body.payload['created_by'] = authContext.userId;
  }
  // Story 4.3: the requisition requester identity is the authenticated actor, never trusted from
  // the edge payload (mirrors created_by/weighed_by/gate_officer_id above). Duplicate detection,
  // approval routing, and SOD-01 all key off this server-set identity.
  if (body.stream_type === 'procurement' && body.event_type === 'indent.raised') {
    body.payload['requester_user_id'] = authContext.userId;
    // AC 6: DOA-resolved approval routing applies to offline-captured requisitions too - the
    // resolution happens here, at sync time, against the indent's estimated value. An unresolvable
    // approver throws APPROVAL_UNRESOLVED (409), a permanent code that settles the outbox row as
    // needs_attention rather than retrying forever.
    const rawLines = body.payload['lines'];
    let estimatedValue = 0;
    if (Array.isArray(rawLines)) {
      for (const line of rawLines as Array<Record<string, unknown>>) {
        const qty =
          typeof line?.['requested_qty'] === 'number' ? (line['requested_qty'] as number) : 0;
        const price =
          typeof line?.['unit_price_estimate'] === 'number'
            ? (line['unit_price_estimate'] as number)
            : 0;
        estimatedValue += qty * price;
      }
    }
    const approval = await resolveApprover(INDENT_DOA_TYPE, estimatedValue);
    if (approval.approverActorId) body.payload['approver_actor_id'] = approval.approverActorId;
    if (approval.doaEntryId) body.payload['doa_entry_id'] = approval.doaEntryId;
  }
  // Story 7.8: the maintenance identity block. Nothing in any of the five technician payloads
  // names the actor (fault reporter, status updater, meter reader, spares issuer and work-order
  // closer are all derived by their seams from metadata.actor.user_id, already overwritten from
  // auth above), so there is no payload field to stamp here - unlike every block above. The only
  // normalisation is the capture method: a device capture is MANUAL unless it says otherwise.
  if (body.stream_type === 'maintenance' && !body.metadata.capture_method) {
    body.metadata.capture_method = 'MANUAL';
  }
  if (authoritativeSiteId !== null) {
    body.metadata.actor.location_id = authoritativeSiteId;
  } else if (assignment.locationId !== '*') {
    body.metadata.actor.location_id = assignment.locationId;
  } else if (body.stream_type === 'inventory') {
    body.metadata.actor.location_id = NO_LOCATION_UUID;
  }
  if (
    body.stream_type === 'inventory' &&
    (body.payload['target_location_id'] !== undefined ||
      body.payload['target_location_code'] !== undefined)
  ) {
    body.payload['placement_confirmed'] = true;
  }

  // Story 7.8 (Binding Decisions 2 and 16): the head + 1 rule for a declared maintenance-stream
  // version. The store inserts ANY declared version (uq_stream_version only rejects a TAKEN one),
  // so a device whose local head ran ahead would otherwise land past the server head with a
  // silent gap; the handler is the gap guard. When the declared version is at or below the head
  // and EVERY event in the gap is rebase-safe (today: only the nightly work_order_overdue sweep),
  // the persist is retried ONCE with a DECLARED head + 1 - a collision on that retry (a human
  // change landing between the gap read and the insert) is a real STREAM_CONFLICT. Meter readings
  // omit the version and never enter this check.
  const declaredVersion = body.event_version;
  if (body.stream_type === 'maintenance' && declaredVersion !== undefined) {
    const heads = await getStreamHeadVersions([body.stream_id]);
    const head = heads.get(body.stream_id.toLowerCase()) ?? 0;
    if (declaredVersion !== head + 1) {
      let rebased = false;
      if (declaredVersion <= head) {
        const gap = await listStreamEventTypesAfter(body.stream_id, declaredVersion - 1);
        if (gap.length > 0 && gap.every((type) => REBASE_SAFE_EVENT_TYPES.has(type))) {
          body.event_version = head + 1;
          rebased = true;
        }
      }
      if (!rebased) {
        const conflict = new AppError(409, 'STREAM_CONFLICT', 'Event version conflict in stream', {
          stream_id: body.stream_id,
          event_version: declaredVersion,
          head_version: head,
        });
        throw await withMaintenanceSyncConflict(req, body, conflict, {
          reason: 'version_conflict',
          expected_version: declaredVersion,
          head_version: head,
        });
      }
    }
  }

  try {
    const persisted = await persistEvent(
      body,
      {
        trace_id: getTraceId(req) ?? '',
        user_id: authContext.userId,
        role: auditRole,
        location_id: auditLocationId,
        endpoint: req.url ?? '',
        method: req.method ?? 'POST',
        http_status: 201,
      },
      undefined,
      { strictDuplicate: true },
    );
    // Story 7.8 (Binding Decision 14): an edge-captured fault still reaches the supervisor
    // (FR-M-04) through the SAME post-persist helper the REST handler calls. The seam wrote the
    // derived asset_id back onto the persisted payload, so it is read from there.
    if (body.stream_type === 'maintenance' && body.event_type === 'maintenance.fault_reported') {
      const persistedPayload = persisted.payload as Record<string, unknown>;
      await notifyFaultReported({
        faultReportId: String(persistedPayload['fault_report_id']),
        assetId: String(persistedPayload['asset_id']),
        assetTag: String(persistedPayload['asset_tag']),
        actor: {
          user_id: body.metadata.actor.user_id,
          role: body.metadata.actor.role,
          location_id: body.metadata.actor.location_id,
        },
        occurredAt: body.metadata.occurred_at ?? new Date().toISOString(),
      });
    }
    sendJson(res, 201, persisted);
  } catch (err) {
    if (err instanceof ZoneIncompatibleWarning) {
      sendJson(res, 200, zoneWarningEnvelope(err, getTraceId(req) ?? ''));
      return;
    }
    if (err instanceof AppError && body.stream_type === 'maintenance') {
      if (err.errorCode === 'STREAM_CONFLICT') {
        // Decision 2: a version-less maintenance envelope (a meter reading) never raises a conflict
        // row; a STREAM_CONFLICT here is a transient server-side MAX+1 collision and is re-thrown
        // as-is without queueing.
        if (declaredVersion === undefined) {
          throw err;
        }
        // The retry (or a plain declared version) collided on uq_stream_version: a real conflict.
        // Report the version actually attempted (body.event_version, which is head + 1 after a
        // benign rebase), not declaredVersion (the stale pre-rebase value).
        const heads = await getStreamHeadVersions([body.stream_id]);
        const head = heads.get(body.stream_id.toLowerCase()) ?? 0;
        const attemptedVersion =
          body.event_version ?? declaredVersion ?? err.details['event_version'] ?? null;
        const conflict = new AppError(err.statusCode, err.errorCode, err.message, {
          ...err.details,
          event_version: attemptedVersion,
          head_version: head,
        });
        throw await withMaintenanceSyncConflict(req, body, conflict, {
          reason: 'version_conflict',
          expected_version: attemptedVersion ?? head + 1,
          head_version: head,
        });
      }
      // Binding Decision 4: a safety-flagged fault that met a PERMANENT rejection on replay (a
      // mistyped tag, ASSET_NOT_FOUND) would otherwise sit invisible on one tablet; queue it so the
      // FR-M-04 five-minute reach degrades to a supervisor nudge rather than to never.
      if (
        body.event_type === 'maintenance.fault_reported' &&
        body.payload['safety_flag'] === true &&
        isPermanentUploadErrorCode(err.errorCode)
      ) {
        throw await withMaintenanceSyncConflict(req, body, err, {
          reason: 'safety_fault_rejected',
          rejection_code: err.errorCode,
        });
      }
    }
    throw err;
  }
};

/**
 * Story 7.8: raises the sync-conflict queue row for a rejected maintenance upload and returns the
 * SAME error with details.conflict_id merged in. The raise runs after the failed persist has
 * rolled back; a failure to raise is logged and never masks the original rejection, which the
 * device must always receive unchanged.
 */
async function withMaintenanceSyncConflict(
  req: Parameters<RouteHandler>[0],
  body: Parameters<typeof raiseMaintenanceSyncConflict>[0],
  original: AppError,
  cause: SyncConflictCause,
): Promise<AppError> {
  try {
    const { conflict_id } = await raiseMaintenanceSyncConflict(body, cause, {
      trace_id: getTraceId(req) ?? '',
      endpoint: req.url ?? '',
      method: req.method ?? 'POST',
    });
    return new AppError(original.statusCode, original.errorCode, original.message, {
      ...original.details,
      conflict_id,
    });
  } catch (raiseErr: unknown) {
    console.warn(
      `[edge] sync-conflict raise failed for event ${String(body.event_id)} (trace ${getTraceId(req) ?? ''})`,
      raiseErr,
    );
    return original;
  }
}

/**
 * Story 7.8 (Binding Decision 11): the technician's offline working set. COMPANY-WIDE by
 * construction: work orders and the asset register carry no location (AD-9), so no site filter
 * exists to apply, and no PowerSync sync rule can express this read (sync-rules.yaml buckets by
 * actor location only). It is the Story 1.8 edge/bootstrap shape - a bounded read-model fetch the
 * device caches in localOnly tables. `total` and `truncated` are always present so a device that
 * did not receive every open work order can say so ("N more not loaded") instead of silently
 * refusing a capture against a work order it never saw.
 */
const edgeMaintenanceWorklistBase: RouteHandler = async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const limitRaw = url.searchParams.get('limit');
  let limit = 200;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 500) {
      throw new AppError(400, 'INVALID_PARAMS', 'limit must be an integer between 1 and 500', {
        limit: limitRaw,
      });
    }
    limit = Number(limitRaw);
  }

  const fetchedAt = new Date().toISOString();
  const [workOrders, total] = await Promise.all([
    listOpenWorkOrdersForWorklist(limit),
    countOpenWorkOrders(),
  ]);

  const assetIds = [...new Set(workOrders.map((row) => row.asset_id))];
  const closuresByAsset = new Map<string, unknown[]>();
  const metersByAsset = new Map<string, unknown[]>();
  for (const assetId of assetIds) {
    const [closures, meters] = await Promise.all([
      listRecentClosuresForAsset(assetId, { limit: 5, origin: 'breakdown' }),
      listMeters({ asset_id: assetId, limit: 500 }),
    ]);
    closuresByAsset.set(
      assetId,
      closures.map((closure) => ({
        work_order_id: closure.work_order_id,
        origin: closure.origin,
        fault_code: closure.fault_code,
        cause_code: closure.cause_code,
        remedy_code: closure.remedy_code,
        closed_at: closure.closed_at,
      })),
    );
    metersByAsset.set(
      assetId,
      meters.map((meter) => ({
        meter_id: meter.meter_id,
        meter_code: meter.meter_code,
        unit: meter.unit,
        current_reading: meter.current_reading,
      })),
    );
  }

  const reservationsByWorkOrder = new Map<
    string,
    Array<{ reservation_id: string; sku: string; quantity: string; location_id: string }>
  >();
  for (const workOrder of workOrders) {
    const reservations = await listSpareReservations({
      work_order_id: workOrder.work_order_id,
      status: 'reserved',
      limit: 500,
    });
    reservationsByWorkOrder.set(
      workOrder.work_order_id,
      reservations.map((reservation) => ({
        reservation_id: reservation.reservation_id,
        sku: reservation.sku,
        quantity: reservation.quantity,
        location_id: reservation.location_id,
      })),
    );
  }

  // ONE head read for every work-order and reservation stream on the page.
  const streamIds = [
    ...workOrders.map((row) => row.work_order_id),
    ...[...reservationsByWorkOrder.values()].flat().map((r) => r.reservation_id),
  ];
  const heads = await getStreamHeadVersions(streamIds);
  const headOf = (id: string): number => heads.get(id.toLowerCase()) ?? 0;

  sendJson(res, 200, {
    fetched_at: fetchedAt,
    total,
    truncated: total > workOrders.length,
    closure_codes: {
      fault: config.maintenance.closureCodes.fault,
      cause: config.maintenance.closureCodes.cause,
      remedy: config.maintenance.closureCodes.remedy,
    },
    work_orders: workOrders.map((row) => ({
      work_order_id: row.work_order_id,
      origin: row.origin,
      status: row.status,
      priority: row.priority,
      due_date: row.due_date,
      sla_resolution_due_at: row.sla_resolution_due_at,
      warranty_flagged: row.warranty_flagged,
      stream_version: headOf(row.work_order_id),
      asset: {
        asset_id: row.asset_id,
        asset_tag: row.asset_tag,
        name: row.asset_name,
        criticality: row.criticality_class,
      },
      recent_closures: closuresByAsset.get(row.asset_id) ?? [],
      reservations: (reservationsByWorkOrder.get(row.work_order_id) ?? []).map((reservation) => ({
        ...reservation,
        stream_version: headOf(reservation.reservation_id),
      })),
      meters: metersByAsset.get(row.asset_id) ?? [],
    })),
  });
};

export const edgeBootstrapHandler: RouteHandler = edgeBootstrapBase;
export const powerSyncCredentialsHandler: RouteHandler = powerSyncCredentialsBase;

export const edgeEventUploadHandler: RouteHandler = requireRole({
  module: resolveModuleFromBody,
  functionScope: 'write',
  locationId: resolveLocationFromBody,
})(edgeEventUploadBase);

export const edgeMaintenanceWorklistHandler: RouteHandler = requireRole({
  module: 'maintenance',
  functionScope: 'read',
})(edgeMaintenanceWorklistBase);

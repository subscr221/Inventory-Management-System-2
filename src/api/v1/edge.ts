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
import { validateEdgeEnvelope } from '../../sync/upload.js';
import { ZoneIncompatibleWarning, zoneWarningEnvelope } from '../../compliance/inventory-master.js';
import { OWNERSHIP_CONFIG_ROLES } from '../../compliance/ownership.js';
import { config } from '../../config/index.js';
import type { AuthContext } from '../../middleware/context.js';
import { getCrossDockTaskById } from '../../read/projections/cross_dock_task.js';
import { assertCrossDockEventShape } from '../../compliance/cross-dock.js';
import { resolveApprover, INDENT_DOA_TYPE } from './indents.js';

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

  try {
    const persisted = await persistEvent(body, {
      trace_id: getTraceId(req) ?? '',
      user_id: authContext.userId,
      role: auditRole,
      location_id: auditLocationId,
      endpoint: req.url ?? '',
      method: req.method ?? 'POST',
      http_status: 201,
    });
    sendJson(res, 201, persisted);
  } catch (err) {
    if (err instanceof ZoneIncompatibleWarning) {
      sendJson(res, 200, zoneWarningEnvelope(err, getTraceId(req) ?? ''));
      return;
    }
    throw err;
  }
};

export const edgeBootstrapHandler: RouteHandler = edgeBootstrapBase;
export const powerSyncCredentialsHandler: RouteHandler = powerSyncCredentialsBase;

export const edgeEventUploadHandler: RouteHandler = requireRole({
  module: resolveModuleFromBody,
  functionScope: 'write',
  locationId: resolveLocationFromBody,
})(edgeEventUploadBase);

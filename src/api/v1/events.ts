import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import { validateEnvelope, persistEvent, readStream } from '../../events/store.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedRole,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import {
  requireRole,
  permittedLocationsForModule,
  permittedLocationsForModuleScope,
} from '../../middleware/rbac.js';
import { auditConfig } from '../../config/audit.js';
import { getPool } from '../../config/db.js';
import { logTamperAttempt } from '../../read/projections/audit_log.js';
import { ZoneIncompatibleWarning, zoneWarningEnvelope } from '../../compliance/inventory-master.js';
import { OWNERSHIP_CONFIG_ROLES } from '../../compliance/ownership.js';

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

function planningPayloadLocation(body: {
  stream_type: string;
  event_type: string;
  payload: Record<string, unknown>;
}): string | null {
  if (body.stream_type !== 'inventory' || !PLANNING_EVENT_TYPES.has(body.event_type)) return null;
  const locationId = body.payload['location_id'];
  return typeof locationId === 'string' ? locationId : null;
}

const PAYLOAD_SITE_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE CENTRAL SITE GATE for the direct events door (added 2026-09-06 after a confirmed cross-site
 * write).
 *
 * The hole this closes, precisely, because every part of it looked correct in isolation:
 *   1. `requireRole` authorises this route against `metadata.actor.location_id`, and an attacker
 *      states their OWN honest location - one their grant genuinely satisfies - so RBAC passes.
 *   2. `postEventBase` then overwrites the actor from the authorising assignment, so the stored
 *      event and the audit row are truthful. Nothing is spoofed.
 *   3. The appliers compare the PAYLOAD's site to the resource ROW's site. An attacker names the
 *      target's site in the payload, so that comparison agrees with itself and never once involves
 *      the actor.
 * Nothing anywhere compared the RESOURCE's site to the actor's AUTHORISED location. Proven by
 * execution: a writer granted only at site B captured site A's customer offcut, and acknowledged
 * site A's billing feed with a fabricated ERP reference, both 201.
 *
 * The REST routes were never exposed - they call their own site assertions against the row they
 * loaded (`assertSiteWriteAccess` in service-orders.ts is the pattern). This is that assertion,
 * hoisted to the one door that lacked it, modelled on `assertPlanningPayloadWriteLocation` above.
 *
 * It binds payload site to the actor's grants. The appliers already bind payload site to row site.
 * Composed, the two bind ROW site to the actor - which is the property that was missing. An event
 * whose payload carries no `site_id` is not covered here and must be bound by its own applier; that
 * is why `jobwork.billing_feed_acknowledged` gained a `site_id` in the same change.
 */
function assertPayloadSiteWriteAccess(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  const siteId = body.payload['site_id'];
  if (typeof siteId !== 'string' || !PAYLOAD_SITE_UUID_REGEX.test(siteId)) return;
  const { wildcard, locations } = permittedLocationsForModuleScope(
    authContext.roles,
    body.stream_type,
    'write',
  );
  if (!wildcard && !locations.has(siteId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No write assignment grants access to site "${siteId}"`,
    );
  }
}

/**
 * Story 9.7 chunk C code review (2026-09-06): the finance-controller gate for naming (and revising)
 * the price of the customer's offcut was REST-route-only, so the direct POST /api/v1/events door -
 * which authorizes on module `jobwork` + `write` alone - let a user holding only a jobwork write
 * grant (e.g. `jobwork_coordinator`) price an acquisition, mint owned stock and raise a credit note
 * without ever holding the finance decision (Task 7.2). Privilege AND site scope come from the SAME
 * filtered assignment list, exactly like the route's requireFinanceControllerScope: deriving the
 * privilege from one assignment and the scope from another would let a controller at site A price
 * site B's offcut. The ownership.agreement_set role check above is the precedent for a door-level
 * function gate.
 */
/**
 * Story 9.8 (AC 9): the proposal JOINS this set - proposing an acquisition is the pricing decision
 * Story 9.7 Task 7.2 gated, only now it lands in a proposal row instead of a disposal.
 *
 * `jobwork.offcut_acquisition_approved` is deliberately NOT here. Its gate is a different one and it
 * cannot live on this door: the approver is the `cfo`, who holds no finance_controller assignment
 * (they are two separate real people by ruling - that separation IS the control), and the identity
 * that matters is the one FROZEN ON THE PROPOSAL ROW, which this door has not read. The applier
 * performs that check against the row, so both doors meet the identical wall.
 *
 * Story 9.9: `jobwork.offcut_revaluation_proposed` joins for exactly the reason the acquisition
 * proposal did - proposing a revaluation IS the pricing decision, only landing in a proposal row
 * instead of a delta document - and `jobwork.offcut_revaluation_approved` stays out for exactly the
 * reason its acquisition twin does. This omission was live for the length of one test run: the
 * story's task list named the seam, the routes and the schema, and not this door.
 */
const OFFCUT_VALUATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'jobwork.offcut_disposed',
  'jobwork.offcut_revalued',
  'jobwork.offcut_acquisition_proposed',
  'jobwork.offcut_revaluation_proposed',
]);
const OFFCUT_VALUATION_ROLES: ReadonlySet<string> = new Set(['finance_controller']);

function assertOffcutValuationFunctionAccess(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  if (body.stream_type !== 'jobwork' || !OFFCUT_VALUATION_EVENT_TYPES.has(body.event_type)) return;
  const valuingRoles = authContext.roles.filter(
    (r) =>
      (r.module === 'jobwork' || r.module === '*') &&
      r.functionScope === 'write' &&
      OFFCUT_VALUATION_ROLES.has(r.role),
  );
  if (valuingRoles.length === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Valuing an offcut disposal requires the finance controller role',
      { required_roles: [...OFFCUT_VALUATION_ROLES] },
    );
  }
  const siteId = body.payload['site_id'];
  if (typeof siteId === 'string') {
    const wildcard = valuingRoles.some((r) => r.locationId === '*');
    if (!wildcard && !valuingRoles.some((r) => r.locationId === siteId)) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        'No finance controller assignment grants access to the site of this order',
        { site_id: siteId, required_roles: [...OFFCUT_VALUATION_ROLES] },
      );
    }
  }
}

/**
 * Story 11.2 code review (2026-09-09): recording the outbound IRN lifts the statutory
 * IRN-before-dispatch block, and the REST route restricts it to dispatch_clerk / warehouse_manager.
 * This door authorised on module `warehouse` + `write` alone, so a warehouse_operator (who may
 * confirm pick lines but perform no dispatch-side action) could post dispatch.irn_recorded and
 * remove the wall the same role cannot pass on the route. Privilege AND site scope come from the
 * SAME assignment, exactly as the offcut-valuation gate above.
 */
const DISPATCH_IRN_EVENT_TYPE = 'dispatch.irn_recorded';
const DISPATCH_IRN_RECORDING_ROLES: ReadonlySet<string> = new Set([
  'dispatch_clerk',
  'warehouse_manager',
]);

/**
 * Edge-door sweep follow-up (2026-09-09), found by the parity arm written for the edge door.
 *
 * Story 3.7 Task 7.3 made packing, shipping-document generation and dispatch confirmation
 * dispatch-side actions, and the REST routes enforce that (DISPATCH_WRITE_ROLES and
 * DISPATCH_DOC_WRITE_ROLES in src/api/v1/dispatch.ts). The edge door enforced it too, first as a
 * denylist and now as these allowlists. THIS door had no gate for the three event types at all:
 * `dispatch.packed`, `dispatch.shipping_documents_generated` and `dispatch.dispatched` appeared
 * nowhere in this file, their payloads carry no `site_id` so assertPayloadSiteWriteAccess could
 * not bite, and src/compliance/dispatch.ts holds no role check either. Proven by execution: a
 * gate_officer posting dispatch.packed here passed authorisation entirely and was refused only by
 * business state (DISPATCH_ORDER_NOT_PICKED), so on a picked order it would have packed.
 *
 * Unlike the IRN gate above there is no site half: these payloads carry no site id, and resolving
 * one would mean reading the dispatch order inside the door. The edge door has the same limitation
 * and the same shape; the site scope for these three actions rests on the module assignment alone.
 */
const DISPATCH_SOD_ROLES: Readonly<Record<string, readonly string[]>> = {
  'dispatch.packed': ['dispatch_clerk', 'warehouse_manager'],
  'dispatch.dispatched': ['dispatch_clerk', 'warehouse_manager'],
  'dispatch.shipping_documents_generated': [
    'dispatch_clerk',
    'warehouse_manager',
    'inventory_controller',
  ],
};

function assertDispatchSodFunctionAccess(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  if (body.stream_type !== 'warehouse') return;
  const allowedRoles = DISPATCH_SOD_ROLES[body.event_type];
  if (!allowedRoles) return;
  const permitted = authContext.roles.some(
    (r) =>
      (r.module === 'warehouse' || r.module === '*') &&
      r.functionScope === 'write' &&
      allowedRoles.includes(r.role),
  );
  if (!permitted) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `Event "${body.event_type}" is a dispatch-side action restricted to specific roles`,
      { required_roles: [...allowedRoles] },
    );
  }
}

function assertDispatchIrnFunctionAccess(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  if (body.stream_type !== 'warehouse' || body.event_type !== DISPATCH_IRN_EVENT_TYPE) return;
  const recordingRoles = authContext.roles.filter(
    (r) =>
      (r.module === 'warehouse' || r.module === '*') &&
      r.functionScope === 'write' &&
      DISPATCH_IRN_RECORDING_ROLES.has(r.role),
  );
  if (recordingRoles.length === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Recording an IRN requires a dispatch clerk or warehouse manager assignment',
      { required_roles: [...DISPATCH_IRN_RECORDING_ROLES] },
    );
  }
  const siteId = body.payload['site_id'];
  if (typeof siteId === 'string') {
    const wildcard = recordingRoles.some((r) => r.locationId === '*');
    if (!wildcard && !recordingRoles.some((r) => r.locationId === siteId)) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        'No dispatch clerk or warehouse manager assignment grants access to the site of this order',
        { site_id: siteId, required_roles: [...DISPATCH_IRN_RECORDING_ROLES] },
      );
    }
  }
}

/**
 * Story 11.5 (Task 4.4): the gst_officer gate for the two branch-transfer GST event types. The
 * REST routes restrict the valuation override and the document recording to gst_officer; this door
 * authorises on module `inventory` + `write` alone, so without this gate a warehouse operator could
 * re-value a Schedule I supply or record a document that lifts the GST_DOCUMENTS_REQUIRED wall.
 * Privilege AND site scope come from the SAME assignment (the dispatch-IRN gate above is the
 * template); the payload site_id is the transfer's FROM site, bound to the row by the applier.
 */
const BRANCH_TRANSFER_GST_EVENT_TYPES: ReadonlySet<string> = new Set([
  'transfer_request.valuation_overridden',
  'transfer_request.gst_document_recorded',
]);
const BRANCH_TRANSFER_GST_ROLES: ReadonlySet<string> = new Set(['gst_officer']);

function assertBranchTransferGstFunctionAccess(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
  body: { stream_type: string; event_type: string; payload: Record<string, unknown> },
): void {
  if (body.stream_type !== 'inventory' || !BRANCH_TRANSFER_GST_EVENT_TYPES.has(body.event_type))
    return;
  const officerRoles = authContext.roles.filter(
    (r) =>
      (r.module === 'inventory' || r.module === '*') &&
      r.functionScope === 'write' &&
      BRANCH_TRANSFER_GST_ROLES.has(r.role),
  );
  if (officerRoles.length === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      'Branch transfer valuation and GST documents require a GST officer assignment',
      { required_roles: [...BRANCH_TRANSFER_GST_ROLES] },
    );
  }
  const siteId = body.payload['site_id'];
  if (typeof siteId === 'string') {
    const wildcard = officerRoles.some((r) => r.locationId === '*');
    if (!wildcard && !officerRoles.some((r) => r.locationId === siteId)) {
      throw new AppError(
        403,
        'FUNCTION_ACCESS_DENIED',
        'No GST officer assignment grants access to the source site of this transfer',
        { site_id: siteId, required_roles: [...BRANCH_TRANSFER_GST_ROLES] },
      );
    }
  }
}

/**
 * Story 11.5 chunk-2 code review: both REST routes (`POST /transfer-requests/{id}/valuation-override`
 * and `.../gst-documents`) call `requireIdempotencyKey` per the Story 8.7 D8 (#AD-16) convention, so
 * a retried post replays the SAME event. This door did not, and the envelope's `idempotency_key` is
 * optional - so the same override posted twice under two different event ids APPLIED TWICE. The
 * seam's `source_event_id` replay short-circuit does not catch that: it only recognises a replay of
 * the same id. Error code, message and details shape are copied from `requireIdempotencyKey` so the
 * two paths refuse identically.
 *
 * This is a shape requirement, not an authorisation one, so it runs outside the `authContext` block.
 */
function assertBranchTransferGstIdempotencyKey(body: {
  stream_type: string;
  event_type: string;
  idempotency_key?: string | null;
}): void {
  if (body.stream_type !== 'inventory' || !BRANCH_TRANSFER_GST_EVENT_TYPES.has(body.event_type))
    return;
  const key = body.idempotency_key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new AppError(400, 'INVALID_PARAMS', 'idempotency_key is required', {
      field: 'idempotency_key',
    });
  }
}

function assertPlanningPayloadWriteLocation(
  authContext: NonNullable<ReturnType<typeof getAuthContext>>,
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
  const metadata = (body as Record<string, unknown>)['metadata'];
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const actor = (metadata as Record<string, unknown>)['actor'];
  if (typeof actor !== 'object' || actor === null) return undefined;
  const locationId = (actor as Record<string, unknown>)['location_id'];
  return typeof locationId === 'string' ? locationId : undefined;
}

function resolveModuleFromParams(params: Record<string, string>): string {
  return params['streamType'] ?? '';
}

function referencesInventoryMasters(body: {
  stream_type: string;
  payload: Record<string, unknown>;
}): boolean {
  return (
    body.stream_type === 'inventory' &&
    (body.payload['sku'] !== undefined ||
      body.payload['target_location_id'] !== undefined ||
      body.payload['target_location_code'] !== undefined)
  );
}

const postEventBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req);
  validateEnvelope(body);

  if (body.stream_type === 'engineering' || body.stream_type === 'maintenance') {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_EVENT_STREAM',
      `Direct ${body.stream_type} stream writes are not permitted via the events API`,
    );
    return;
  }

  assertBranchTransferGstIdempotencyKey(body);

  const authContext = getAuthContext(req);
  const authorizedAssignment = getAuthorizedAssignment(req);
  const auditLocationId = authorizedAssignment?.locationId ?? body.metadata.actor.location_id;
  if (authContext) {
    assertPlanningPayloadWriteLocation(authContext, body);
    assertOffcutValuationFunctionAccess(authContext, body);
    assertDispatchIrnFunctionAccess(authContext, body);
    assertDispatchSodFunctionAccess(authContext, body);
    assertBranchTransferGstFunctionAccess(authContext, body);
    assertPayloadSiteWriteAccess(authContext, body);
    body.metadata.actor.user_id = authContext.userId;
    const authorizedRole = getAuthorizedRole(req);
    if (authorizedRole) {
      body.metadata.actor.role = authorizedRole;
    }
    if (authorizedAssignment) {
      if (authorizedAssignment.locationId !== '*') {
        body.metadata.actor.location_id = authorizedAssignment.locationId;
      } else if (referencesInventoryMasters(body)) {
        body.metadata.actor.location_id = NO_LOCATION_UUID;
      }
    }
  }

  // Defense-in-depth guard (Story 1.3, Decision 2). The audit log is startup-immutable, so the
  // process cannot normally be running with it disabled - this branch is unreachable in practice.
  // But `auditConfig.enabled` is a real boolean, so if the log is ever observed inactive at request
  // time we record the attempt to mutate without it and block, mirroring the config-endpoint path.
  if (!auditConfig.enabled) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await logTamperAttempt(client, {
        user_id: authContext?.userId ?? null,
        role: getAuthorizedRole(req) ?? null,
        location_id: auditLocationId,
        endpoint: req.url ?? null,
        method: req.method ?? null,
        error_code: 'AUDIT_LOG_DISABLED',
        details: { reason: 'Mutating request attempted while audit log inactive' },
      });
    } finally {
      client.release();
    }
    sendRequestError(
      req,
      res,
      423,
      'AUDIT_LOG_DISABLED',
      'No mutating operations are permitted while the audit log is inactive',
    );
    return;
  }

  const traceId = getTraceId(req) ?? '';
  const auditCtx = authContext
    ? {
        trace_id: traceId,
        user_id: authContext.userId,
        role: getAuthorizedRole(req) ?? '',
        location_id: auditLocationId,
        endpoint: req.url ?? '',
        method: req.method ?? 'POST',
        http_status: 201,
      }
    : undefined;

  // Story 2.1 (AC3): a zone-incompatible placement is a WARNING, not an error. The event was NOT
  // persisted; the 200 envelope tells the caller to resubmit with payload.placement_confirmed: true.
  try {
    const persisted = await persistEvent(body, auditCtx);
    sendJson(res, 201, persisted);
  } catch (err) {
    if (err instanceof ZoneIncompatibleWarning) {
      sendJson(res, 200, zoneWarningEnvelope(err, traceId));
      return;
    }
    throw err;
  }
};

const getStreamBase: RouteHandler = async (req, res, params) => {
  const streamType = params['streamType'];
  const streamId = params['streamId']?.toLowerCase();

  if (!streamType || !streamId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'streamType and streamId are required');
    return;
  }
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_REGEX.test(streamId)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'streamId must be a valid UUID');
    return;
  }

  const events = await readStream(streamType, streamId);

  // Location-scope the read: a caller only sees events that occurred at a location their role
  // grants them (module already checked by requireRole). A '*' location grant sees everything.
  // Note: filtering by location can return a non-contiguous slice of a stream's versions.
  const authContext = getAuthContext(req);
  const scoped = authContext
    ? (() => {
        const { wildcard, locations } = permittedLocationsForModule(authContext.roles, streamType);
        if (wildcard) return events;
        return events.filter((e) => locations.has(e.metadata.actor.location_id));
      })()
    : events;

  sendJson(res, 200, { events: scoped });
};

export const postEventHandler: RouteHandler = requireRole({
  module: resolveModuleFromBody,
  functionScope: 'write',
  locationId: resolveLocationFromBody,
})(postEventBase);

export const getStreamHandler: RouteHandler = requireRole({
  module: resolveModuleFromParams,
  functionScope: 'read',
})(getStreamBase);

import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole, permittedLocationsForModule } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { getPool } from '../../config/db.js';
import {
  lotNumberForUuid,
  classifyBranchTransfer,
  dispatchGateGstDocuments,
  isPositiveDecimal,
} from '../../compliance/transfer-request.js';
import { randomUUID } from 'node:crypto';
import { toIstCalendarDate } from '../../lib/business-days.js';
import { isRule28Basis } from '../../read/projections/branch_transfer_valuation_config.js';
import {
  getBranchTransferValuation,
  listBranchTransferGstDocuments,
  GST_DOCUMENT_KINDS,
} from '../../read/projections/branch_transfer_gst.js';
import { IRN_EXT_REGEX, normalizeIrnExt } from '../../compliance/irn.js';
import {
  getBranchTransferClassification,
  getBranchTransferClassifications,
} from '../../read/projections/branch_transfer_classification.js';
// Story 11.5 chunk-2 review Q17: ONE definition of the 8.7 D8 (#AD-16) idempotency-key guard,
// exported by the sibling GST route module rather than copied here.
import { requireIdempotencyKey } from './sites.js';

import type { TransferRequestRow } from '../../read/projections/transfer_request.js';
import {
  getTransferRequestById,
  getTransferRequests,
  getInTransitBalances,
} from '../../read/projections/transfer_request.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../../read/projections/doa_registry.js';
import { getInTransitByTransferRequest } from '../../read/projections/in_transit.js';
import { getItemBySku } from '../../read/projections/item_master.js';
import { getLocationById } from '../../read/projections/location_register.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRANSFER_REQUEST_DOA_TYPE = 'transfer_request';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

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

// Role allow-lists (Story 2.5 review). requireRole only enforces module+function scope; the story
// restricts these operations to specific roles.
const CREATE_ROLES = ['warehouse_manager', 'logistics_manager', 'store_assistant'];
const SHIP_RECEIVE_ROLES = ['warehouse_manager', 'store_assistant'];
// Story 11.5: the valuation override and GST document recording are gst_officer actions (Binding
// Decision 6, the access matrix of record). Transfer events live on `inventory`; no finance module.
const GST_OFFICER_ROLES = ['gst_officer'];
// Story 11.5 chunk-2 review Q21: free-text statutory fields carry a length cap so an unbounded
// string cannot be persisted into the event log. Deliberately NOT a catalogue - the set of legal
// reason codes is a product decision nobody has made; only the cap is uncontroversial.
const REASON_CODE_MAX_LENGTH = 200;
const DOCUMENT_NUMBER_EXT_MAX_LENGTH = 64;
const CREATE_REFUSED_FIELDS = new Set([
  'valuation_basis',
  'taxable_value',
  'unit_value',
  'from_gstin_ext',
  'to_gstin_ext',
  'basis_source',
]);

/**
 * Enforces that the caller holds at least one of `allowedRoles` with inventory write access.
 * requireRole has already confirmed module+function scope; this narrows to the named roles.
 */
function assertRoleAllowed(req: IncomingMessage, allowedRoles: string[]): void {
  const authContext = getAuthContext(req);
  const roles = authContext?.roles ?? [];
  const ok = roles.some(
    (r) =>
      (r.module === 'inventory' || r.module === '*') &&
      r.functionScope === 'write' &&
      allowedRoles.includes(r.role),
  );
  if (!ok) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `This operation is restricted to roles: ${allowedRoles.join(', ')}`,
    );
  }
}

/**
 * Enforces that the caller's inventory assignments grant access to `locationId` (or a wildcard).
 * Write handlers otherwise let any inventory writer move stock between sites they are not assigned
 * to (Story 2.5 review).
 */
function assertWriteLocationAccess(req: IncomingMessage, locationId: string): void {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  if (!wildcard && !locations.has(locationId)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No role assignment grants access to location "${locationId}"`,
    );
  }
}

/**
 * Story 11.5 chunk-2 review Q5/Q6. The two statutory GST routes took PRIVILEGE from one assignment
 * (`assertRoleAllowed`, which matches any assignment holding gst_officer) and SITE SCOPE from a
 * different one (`assertWriteLocationAccess`, which unions `permittedLocationsForModule` across ALL
 * inventory assignments and never applies `satisfiesFunctionScope`) - so a read-only assignment at
 * site B contributed site B to a statutory WRITE gate, and a gst_officer at site A could override
 * site B's valuation. This resolves privilege and scope from the SAME assignment, mirroring
 * `assertBranchTransferGstFunctionAccess` in `src/api/v1/events.ts`, and returns THAT assignment as
 * the audited actor so `metadata.actor.role` / `location_id` and the audit row name the assignment
 * that actually authorised the action rather than whichever one `requireRole` matched first (Q6).
 */
function gstOfficerActor(
  req: IncomingMessage,
  scope: { locationId: string; siteId: string },
): ActorContext {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  const officerAssignments = authContext.roles.filter(
    (r) =>
      (r.module === 'inventory' || r.module === '*') &&
      r.functionScope === 'write' &&
      GST_OFFICER_ROLES.includes(r.role),
  );
  if (officerAssignments.length === 0) {
    throw new AppError(
      403,
      'FUNCTION_ACCESS_DENIED',
      `This operation is restricted to roles: ${GST_OFFICER_ROLES.join(', ')}`,
      { required_roles: GST_OFFICER_ROLES },
    );
  }
  // The same assignment must also carry the scope: a wildcard, the transfer's source location, or
  // its source site (the events door compares payload site_id against the assignment's location).
  const matched =
    officerAssignments.find((r) => r.locationId === '*') ??
    officerAssignments.find(
      (r) => r.locationId === scope.locationId || r.locationId === scope.siteId,
    );
  if (!matched) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      `No ${GST_OFFICER_ROLES.join('/')} assignment grants access to location "${scope.locationId}"`,
      { location_id: scope.locationId, site_id: scope.siteId, required_roles: GST_OFFICER_ROLES },
    );
  }
  const auditLocationId = matched.locationId;
  return {
    userId: authContext.userId,
    role: matched.role,
    auditLocationId,
    eventLocationId: auditLocationId === '*' ? NO_LOCATION_UUID : auditLocationId,
  };
}

/**
 * Resolves the approver for a transfer of `quantity`. Returns requiresApproval=false when no DOA
 * band governs it. When approval is required but the band-matched role has no active holder, it
 * escalates to the next authority in the DOA ladder that does have one (Story 2.5 review decision:
 * escalate to a fallback rather than freezing the request). If no approver can be resolved at all,
 * it fails closed with APPROVAL_UNRESOLVED rather than persisting an un-approvable request.
 */
async function resolveApprover(
  transactionType: string,
  quantity: number,
): Promise<{ requiresApproval: boolean; approverActorId: string | null }> {
  const doaEntry = await findMatchingDoaEntry(transactionType, quantity);
  if (!doaEntry) {
    return { requiresApproval: false, approverActorId: null };
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
      'Transfer requires approval but no active approver could be resolved',
      {
        transaction_type: transactionType,
      },
    );
  }
  return { requiresApproval: true, approverActorId: approver };
}

// ---------------------------------------------------------------------------
// Task 3: POST /api/v1/transfer-requests - Create transfer request
// ---------------------------------------------------------------------------

const createTransferRequestBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  if (!isNonEmptyString(body['sku_id'])) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'sku_id is required and must be a non-empty string',
    );
    return;
  }
  if (
    !isNonEmptyString(body['from_location_id']) ||
    !UUID_REGEX.test(body['from_location_id'] as string)
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'from_location_id is required and must be a valid UUID',
    );
    return;
  }
  if (
    !isNonEmptyString(body['to_location_id']) ||
    !UUID_REGEX.test(body['to_location_id'] as string)
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'to_location_id is required and must be a valid UUID',
    );
    return;
  }
  if (!isPositiveFiniteNumber(body['quantity'])) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'quantity is required and must be a positive number',
    );
    return;
  }
  if (!isNonEmptyString(body['business_stream'])) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'business_stream is required and must be a non-empty string',
    );
    return;
  }

  // Story 11.5 (Task 3.5): the valuation basis, taxable value, the two GSTINs and every *_by
  // attribution field are server-derived and REFUSED on input (the 11.2 so_number_ext rule); the
  // seam's shape assert refuses the same keys on the events door.
  for (const key of Object.keys(body)) {
    if (CREATE_REFUSED_FIELDS.has(key) || /_by$/.test(key)) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        `${key} is server-derived and must not be supplied`,
      );
      return;
    }
  }
  if (
    body['declared_unit_value'] !== undefined &&
    !isPositiveDecimal(body['declared_unit_value'])
  ) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'declared_unit_value must be a positive number or numeric string when supplied',
    );
    return;
  }
  const declaredUnitValue = body['declared_unit_value'] as string | number | undefined;

  const skuId = body['sku_id'] as string;
  const fromLocationId = body['from_location_id'] as string;
  const toLocationId = body['to_location_id'] as string;
  const quantity = body['quantity'] as number;
  const businessStream = body['business_stream'] as string;
  const lotId = body['lot_id'] !== undefined ? (body['lot_id'] as string) : undefined;
  const serialIds = body['serial_ids'] !== undefined ? (body['serial_ids'] as string[]) : undefined;
  const notes = body['notes'] !== undefined ? (body['notes'] as string) : undefined;

  if (fromLocationId === toLocationId) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_LOCATION',
      'from_location_id and to_location_id must be different',
    );
    return;
  }

  // Optional client-supplied idempotency key so a retried create is a no-op instead of allocating
  // stock twice (Story 2.5 review). Must be a UUID; defaults to a server-generated id.
  let transferRequestId: string;
  if (body['transfer_request_id'] !== undefined) {
    if (
      !isNonEmptyString(body['transfer_request_id']) ||
      !UUID_REGEX.test(body['transfer_request_id'] as string)
    ) {
      sendRequestError(
        req,
        res,
        400,
        'INVALID_PARAMS',
        'transfer_request_id must be a valid UUID when supplied',
      );
      return;
    }
    transferRequestId = body['transfer_request_id'] as string;
  } else {
    transferRequestId = randomUUID();
  }

  // Role + location scope (Story 2.5 review): only permitted roles may create, and only for a
  // source location they are assigned to.
  assertRoleAllowed(req, CREATE_ROLES);
  assertWriteLocationAccess(req, fromLocationId);

  const actor = actorContext(req);
  const pool = getPool();
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    // Idempotency: a retried create with the same client-supplied id returns the existing request
    // instead of persisting a second created event / re-allocating stock (Story 2.5 review).
    const existing = await getTransferRequestById(transferRequestId, client);
    if (existing) {
      // Chunk-2 review Q16: the replay describes the SAME resource as the fresh create, so it
      // carries the same `gst` shape - a concrete stamped supply_class, not a missing key.
      const replayClass = await getBranchTransferClassification(transferRequestId, client);
      const replayValuation = await getBranchTransferValuation(transferRequestId, client);
      await client.query('COMMIT');
      committed = true;
      sendJson(res, 200, {
        transfer_request_id: existing.transfer_request_id,
        status: existing.status,
        ...(existing.approver_actor_id ? { approver_actor_id: existing.approver_actor_id } : {}),
        correlation_id: existing.correlation_id,
        gst: {
          supply_class: replayClass?.supply_class ?? 'unclassified',
          valuation: replayValuation,
        },
      });
      return;
    }

    // Validate within transaction for consistency
    const fromLocation = await getLocationById(fromLocationId, client);
    if (!fromLocation || fromLocation.status !== 'active') {
      throw new AppError(
        400,
        'LOCATION_NOT_FOUND',
        'from_location_id does not exist or is not active',
        {
          from_location_id: fromLocationId,
        },
      );
    }

    const toLocation = await getLocationById(toLocationId, client);
    if (!toLocation || toLocation.status !== 'active') {
      throw new AppError(
        400,
        'LOCATION_NOT_FOUND',
        'to_location_id does not exist or is not active',
        {
          to_location_id: toLocationId,
        },
      );
    }

    const item = await getItemBySku(skuId);
    if (!item) {
      throw new AppError(404, 'ITEM_NOT_FOUND', `No item master record exists for sku "${skuId}"`, {
        sku: skuId,
      });
    }

    // Validate lot if provided
    let validatedLotId: string | null = null;
    if (lotId) {
      const lotResult = await client.query(`SELECT lot_id, sku FROM lot_master WHERE lot_id = $1`, [
        lotId,
      ]);
      if (lotResult.rows.length === 0) {
        throw new AppError(400, 'LOT_NOT_FOUND', `Lot "${lotId}" not found`, { lot_id: lotId });
      }
      if (lotResult.rows[0].sku !== skuId) {
        // Distinct from AC6 receive-vs-ship LOT_MISMATCH (Story 2.5 review): this is a lot that
        // does not belong to the requested SKU at creation time.
        throw new AppError(
          400,
          'LOT_SKU_MISMATCH',
          `Lot "${lotId}" does not belong to SKU "${skuId}"`,
          {
            lot_id: lotId,
            sku_id: skuId,
          },
        );
      }
      validatedLotId = lotId;

      if (serialIds && serialIds.length > 0) {
        const serialResult = await client.query(
          `SELECT serial_number, lot_id FROM serial_master WHERE serial_number = ANY($1)`,
          [serialIds],
        );
        if (serialResult.rows.length !== serialIds.length) {
          const foundSet = new Set(
            serialResult.rows.map((s: { serial_number: string }) => s.serial_number),
          );
          const missing = serialIds.filter((s: string) => !foundSet.has(s));
          throw new AppError(
            400,
            'SERIAL_NOT_FOUND',
            `Serial numbers not found: ${missing.join(', ')}`,
            {
              serial_ids: missing,
            },
          );
        }
        for (const s of serialResult.rows) {
          if (s.lot_id !== lotId) {
            throw new AppError(
              400,
              'SERIAL_NOT_AVAILABLE',
              `Serial "${s.serial_number}" does not belong to lot "${lotId}"`,
              {
                serial_number: s.serial_number,
                lot_id: lotId,
              },
            );
          }
        }
      }
    }

    // DOA resolution with escalation fallback (Story 2.5 review).
    const { requiresApproval, approverActorId } = await resolveApprover(
      TRANSFER_REQUEST_DOA_TYPE,
      quantity,
    );

    const status = requiresApproval ? 'pending_approval' : 'pending_shipment';
    const correlationId = randomUUID();

    const envelope = {
      stream_type: 'inventory',
      stream_id: transferRequestId,
      event_type: 'transfer_request.created',
      payload: {
        transfer_request_id: transferRequestId,
        sku_id: skuId,
        quantity,
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        ...(validatedLotId ? { lot_id: validatedLotId } : {}),
        ...(serialIds ? { serial_ids: serialIds } : {}),
        business_stream: businessStream,
        ...(notes ? { notes } : {}),
        ...(approverActorId ? { approver_actor_id: approverActorId } : {}),
        status,
        ...(declaredUnitValue !== undefined ? { declared_unit_value: declaredUnitValue } : {}),
      },
      metadata: {
        correlation_id: correlationId,
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: new Date().toISOString(),
      },
    };

    await persistEvent(envelope, auditCtxFor(req, actor, 201), client);
    // Story 11.5: surface the valuation the seam just wrote (null for intra classes) and the class
    // it STAMPED. Chunk-2 review Q16: `supply_class` was `valuation ? 'inter_gstin' : undefined`
    // and JSON drops undefined, so an intra transfer answered `{"gst":{"valuation":null}}` with no
    // class at all while GET /:id returned a concrete `intra_site`. The stamp records the real
    // class for EVERY transfer, so the two contracts now agree.
    const createdClass = await getBranchTransferClassification(transferRequestId, client);
    const valuation = await getBranchTransferValuation(transferRequestId, client);
    await client.query('COMMIT');
    committed = true;

    sendJson(res, 201, {
      transfer_request_id: transferRequestId,
      status,
      ...(approverActorId ? { approver_actor_id: approverActorId } : {}),
      correlation_id: correlationId,
      gst: {
        supply_class: createdClass?.supply_class ?? 'unclassified',
        valuation,
      },
    });
  } catch (err: unknown) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/transfer-requests/{transfer_request_id}
// ---------------------------------------------------------------------------

const getTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  const row = await getTransferRequestById(id);
  if (!row) {
    sendRequestError(req, res, 404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    return;
  }

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  if (!wildcard && !locations.has(row.from_location_id) && !locations.has(row.to_location_id)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      'No role assignment grants access to the locations in this transfer',
    );
  }

  sendJson(res, 200, { ...transferRequestRowToJson(row), gst: await gstBlockFor(row) });
};

/**
 * Story 11.5 (Task 3.6): the `gst` block for ONE transfer.
 *
 * Chunk-2 review Q3: this used to re-derive the supply class by calling `classifyBranchTransfer` on
 * TODAY's IST date - the exact fail-open that ruling D1 removed from the ship gate, left live on the
 * read path. It diverged from the gate in both directions: an unstamped transfer (gate: blocked,
 * `not_valued`) rendered as `intra_site`/`intra_gstin` with NO `ship_blockers`, and a transfer
 * stamped `intra_gstin` whose sites were later registered under different GSTINs rendered
 * `inter_gstin` with blockers the gate would never raise. The STAMP
 * (`branch_transfer_classification`, the same row `dispatchGateGstDocuments` reads) is now the
 * authority, and `ship_blockers` is verbatim what the ship gate returns right now - Task 3.6's
 * requirement, made true rather than approximately true.
 *
 * Only a transfer with NO stamp at all (created before this story) falls back to a re-derivation,
 * and then purely as an advisory `derived_supply_class`: `supply_class` stays `unclassified` and the
 * gate's blockers are still reported, so the officer sees that it cannot ship. Q20: a failed
 * re-derivation is likewise reported ALONGSIDE the blockers instead of replacing them, so a genuine
 * SITE_GSTIN_MISSING no longer renders as a clean, unblocked transfer.
 */
async function gstBlockFor(row: TransferRequestRow): Promise<Record<string, unknown>> {
  const classification = await getBranchTransferClassification(row.transfer_request_id);
  const gate = await dispatchGateGstDocuments(row);

  if (!classification) {
    const block: Record<string, unknown> = {
      supply_class: 'unclassified',
      classification_stamped: false,
      valuation: null,
      documents: [],
      ship_blockers: gate.reasons,
      e_way_bill_threshold_inr: gate.threshold,
    };
    try {
      const derived = await classifyBranchTransfer(
        row.from_location_id,
        row.to_location_id,
        toIstCalendarDate(new Date()),
      );
      block['derived_supply_class'] = derived.supply_class;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      block['classification_error'] = err.errorCode;
    }
    return block;
  }

  if (classification.supply_class !== 'inter_gstin') {
    return {
      supply_class: classification.supply_class,
      classification_stamped: true,
      ship_blockers: gate.reasons,
    };
  }

  const valuation = await getBranchTransferValuation(row.transfer_request_id);
  const documents = await listBranchTransferGstDocuments(row.transfer_request_id);
  return {
    supply_class: 'inter_gstin',
    classification_stamped: true,
    valuation,
    documents,
    ship_blockers: gate.reasons,
    e_way_bill_threshold_inr: gate.threshold,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/transfer-requests - List transfer requests
// ---------------------------------------------------------------------------

const listTransferRequestsBase: RouteHandler = async (req, res, _params) => {
  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  const fromLocationId = url.searchParams.get('from_location_id');
  const toLocationId = url.searchParams.get('to_location_id');
  const status = url.searchParams.get('status');
  const skuId = url.searchParams.get('sku_id');

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');

  const filteredFrom: string | null = fromLocationId ?? null;
  const filteredTo: string | null = toLocationId ?? null;
  let locationAny: string[] | null = null;

  if (!wildcard) {
    if (fromLocationId && !locations.has(fromLocationId)) {
      sendRequestError(
        req,
        res,
        403,
        'LOCATION_ACCESS_DENIED',
        'No access to the specified from_location_id',
      );
      return;
    }
    if (toLocationId && !locations.has(toLocationId)) {
      sendRequestError(
        req,
        res,
        403,
        'LOCATION_ACCESS_DENIED',
        'No access to the specified to_location_id',
      );
      return;
    }
    if (!fromLocationId && !toLocationId) {
      // Scope to every assigned location on EITHER side, not just the first (Story 2.5 review).
      locationAny = [...locations];
    }
  }

  const rows = await getTransferRequests({
    from_location_id: filteredFrom,
    to_location_id: filteredTo,
    ...(locationAny !== null ? { location_any: locationAny } : {}),
    ...(status !== null ? { status } : {}),
    ...(skuId !== null ? { sku_id: skuId } : {}),
  });

  // Chunk-2 review E3-P: the LIST route used to await the full `gst` block per row - 3-5 further
  // queries each, so a wildcard-scoped page of 5,000 transfers issued ~20,000 sequential round
  // trips. RULED: no consumer reads a taxable value, a basis or a document list from a LIST
  // response, so the block is gone from here (it stays on GET /:id) and the only GST field that
  // survives is `supply_class`, resolved for the WHOLE page in ONE query. A transfer with no stamp
  // is absent from the Map and reports `unclassified` - never a re-derivation (Q3).
  const classifications = await getBranchTransferClassifications(
    rows.map((r) => r.transfer_request_id),
  );
  sendJson(
    res,
    200,
    rows.map((row) => ({
      ...transferRequestRowToJson(row),
      supply_class:
        classifications.get(row.transfer_request_id.toLowerCase())?.supply_class ?? 'unclassified',
    })),
  );
};

function transferRequestRowToJson(row: TransferRequestRow): Record<string, unknown> {
  const result: Record<string, unknown> = {
    transfer_request_id: row.transfer_request_id,
    sku_id: row.sku_id,
    quantity: Number(row.quantity),
    from_location_id: row.from_location_id,
    to_location_id: row.to_location_id,
    status: row.status,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
  };
  if (row.lot_id) result.lot_id = row.lot_id;
  if (row.serial_ids) result.serial_ids = row.serial_ids;
  if (row.approver_actor_id) result.approver_actor_id = row.approver_actor_id;
  if (row.notes) result.notes = row.notes;
  if (row.shipped_at) result.shipped_at = row.shipped_at;
  if (row.received_at) result.received_at = row.received_at;
  return result;
}

// ---------------------------------------------------------------------------
// Task 4: PATCH /api/v1/transfer-requests/{id}/approve
// ---------------------------------------------------------------------------

const approveTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const actor = actorContext(req);
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const notes = body?.['notes'] !== undefined ? (body['notes'] as string) : undefined;

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    // Read + lock within transaction so concurrent approve/reject serialize (Story 2.5 review)
    const row = await getTransferRequestById(id, client, true);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    if (row.status !== 'pending_approval') {
      throw new AppError(
        400,
        'INVALID_STATE',
        `Transfer request is in status "${row.status}", expected "pending_approval"`,
      );
    }

    if (row.approver_actor_id !== actor.userId) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Caller is not the resolved approver for this transfer request',
        {
          approver_actor_id: row.approver_actor_id,
          caller_user_id: actor.userId,
        },
      );
    }

    const correlationId = randomUUID();

    // Update status to approved within the event transaction
    await client.query('UPDATE transfer_request SET status = $1 WHERE transfer_request_id = $2', [
      'approved',
      id,
    ]);

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'transfer_request.approval_decided',
        payload: {
          transfer_request_id: id,
          approved: true,
          reason_code: null,
          notes,
          approver_actor_id: actor.userId,
          business_stream: row.business_stream,
        },
        metadata: {
          correlation_id: correlationId,
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 200),
      client,
    );

    await client.query('COMMIT');
    committed = true;

    sendJson(res, 200, {
      transfer_request_id: id,
      status: 'approved',
      approved_by: actor.userId,
      notes,
    });
  } catch (err: unknown) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Task 4: PATCH /api/v1/transfer-requests/{id}/reject
// ---------------------------------------------------------------------------

const rejectTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const actor = actorContext(req);
  const body = getParsedBody(req) as Record<string, unknown> | undefined;

  if (!body || !isNonEmptyString(body['reason_code'])) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'reason_code is required');
    return;
  }
  const reason_code = body['reason_code'] as string;
  const notes = body?.['notes'] !== undefined ? (body['notes'] as string) : undefined;

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    // Read + lock within transaction so concurrent approve/reject serialize (Story 2.5 review)
    const row = await getTransferRequestById(id, client, true);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    if (row.status !== 'pending_approval') {
      throw new AppError(
        400,
        'INVALID_STATE',
        `Transfer request is in status "${row.status}", expected "pending_approval"`,
      );
    }

    if (row.approver_actor_id !== actor.userId) {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Caller is not the resolved approver for this transfer request',
        {
          approver_actor_id: row.approver_actor_id,
          caller_user_id: actor.userId,
        },
      );
    }

    const correlationId = randomUUID();

    // Update status to rejected
    await client.query('UPDATE transfer_request SET status = $1 WHERE transfer_request_id = $2', [
      'rejected',
      id,
    ]);

    // Revert the allocation: decrease allocated to return the quantity to available.
    // stock_balance.lot_id carries the lot NUMBER, never the lot_master UUID this row holds, so the
    // UUID must be bridged first. Passing it raw matched zero rows and leaked the allocation on
    // every rejected transfer - silently, because the UPDATE reports success either way.
    const rejectLotNumber =
      row.lot_id === null ? null : await lotNumberForUuid(row.lot_id, row.sku_id, client);
    await client.query(
      `UPDATE stock_balance
       SET allocated = GREATEST(allocated - $1::numeric, 0),
           updated_at = now()
       WHERE sku = $2 AND location_id = $3
         AND ($4::text IS NULL OR lot_id = $4)
         AND allocated >= $1::numeric`,
      [row.quantity, row.sku_id, row.from_location_id, rejectLotNumber],
    );

    await persistEvent(
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'transfer_request.approval_decided',
        payload: {
          transfer_request_id: id,
          approved: false,
          reason_code,
          notes,
          approver_actor_id: actor.userId,
          business_stream: row.business_stream,
        },
        metadata: {
          correlation_id: correlationId,
          actor: {
            user_id: actor.userId,
            role: actor.role,
            location_id: actor.eventLocationId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      auditCtxFor(req, actor, 200),
      client,
    );

    await client.query('COMMIT');
    committed = true;

    sendJson(res, 200, {
      transfer_request_id: id,
      status: 'rejected',
      reason_code,
      notes,
    });
  } catch (err: unknown) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Task 5: POST /api/v1/transfer-requests/{id}/ship
// ---------------------------------------------------------------------------

const shipTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const actor = actorContext(req);

  if (!body || !isNonEmptyString(body['lot_id'])) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'lot_id is required and must be a non-empty string',
    );
    return;
  }
  const lotId = body['lot_id'] as string;

  const shippedQuantity =
    body['shipped_quantity'] !== undefined ? (body['shipped_quantity'] as number) : undefined;
  const serialIds = body['serial_ids'] !== undefined ? (body['serial_ids'] as string[]) : undefined;
  const notes = body['notes'] !== undefined ? (body['notes'] as string) : undefined;

  assertRoleAllowed(req, SHIP_RECEIVE_ROLES);

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    const row = await getTransferRequestById(id, client, true);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    // Ship moves stock out of the source location: caller must be assigned there (Story 2.5 review).
    assertWriteLocationAccess(req, row.from_location_id);

    if (row.status !== 'approved' && row.status !== 'pending_shipment') {
      throw new AppError(
        403,
        'APPROVAL_REQUIRED',
        'Transfer request must be approved before shipping',
        {
          current_status: row.status,
        },
      );
    }

    // AC5: Quantity check
    const shipQty = shippedQuantity ?? row.quantity;
    if (shipQty > row.quantity) {
      throw new AppError(
        400,
        'QUANTITY_EXCEEDS_APPROVED',
        `Shipped quantity ${shipQty} exceeds approved quantity ${row.quantity}`,
        {
          approved_quantity: row.quantity,
          requested_quantity: shipQty,
        },
      );
    }

    // Lot matching (ship side)
    if (row.lot_id && row.lot_id !== lotId) {
      throw new AppError(
        400,
        'LOT_MISMATCH',
        `Ship lot_id "${lotId}" does not match request lot_id "${row.lot_id}"`,
        {
          request_lot_id: row.lot_id,
          ship_lot_id: lotId,
        },
      );
    }

    const correlationId = randomUUID();

    const envelope = {
      stream_type: 'inventory',
      stream_id: id,
      event_type: 'transfer_ship.created',
      payload: {
        transfer_request_id: id,
        shipped_quantity: shipQty,
        lot_id: lotId,
        ...(serialIds ? { serial_ids: serialIds } : {}),
        ...(notes ? { notes } : {}),
        correlation_id: correlationId,
        business_stream: row.business_stream,
      },
      metadata: {
        correlation_id: correlationId,
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: new Date().toISOString(),
      },
    };

    await persistEvent(envelope, auditCtxFor(req, actor, 201), client);
    await client.query('COMMIT');
    committed = true;

    sendJson(res, 201, {
      transfer_request_id: id,
      status: 'shipped',
      lot_id: lotId,
      shipped_quantity: shipQty,
      correlation_id: correlationId,
    });
  } catch (err: unknown) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// Task 6: POST /api/v1/transfer-requests/{id}/receive
// ---------------------------------------------------------------------------

const receiveTransferRequestBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const actor = actorContext(req);

  if (!body || !isNonEmptyString(body['lot_id'])) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'lot_id is required and must be a non-empty string',
    );
    return;
  }
  const lotId = body['lot_id'] as string;

  const receivedQuantity =
    body['received_quantity'] !== undefined ? (body['received_quantity'] as number) : undefined;
  const serialIds = body['serial_ids'] !== undefined ? (body['serial_ids'] as string[]) : undefined;
  const receivedAtLocationId =
    body['received_at_location_id'] !== undefined
      ? (body['received_at_location_id'] as string)
      : undefined;
  const receivedDate =
    body['received_date'] !== undefined ? (body['received_date'] as string) : undefined;
  const notes = body['notes'] !== undefined ? (body['notes'] as string) : undefined;

  assertRoleAllowed(req, SHIP_RECEIVE_ROLES);

  const pool = getPool();
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    const row = await getTransferRequestById(id, client, true);
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
    }

    // Receive brings stock into the destination: caller must be assigned there (Story 2.5 review).
    assertWriteLocationAccess(req, row.to_location_id);

    if (row.status !== 'shipped' && row.status !== 'partially_received') {
      throw new AppError(
        400,
        'INVALID_STATE',
        `Transfer request must be in "shipped" or "partially_received" status, current status is "${row.status}"`,
      );
    }

    const receiveLocationId = receivedAtLocationId ?? row.to_location_id;
    if (receiveLocationId !== row.to_location_id) {
      throw new AppError(
        400,
        'INVALID_LOCATION',
        `Receive location does not match the approved destination location`,
        {
          expected_location_id: row.to_location_id,
          received_location_id: receiveLocationId,
        },
      );
    }

    const receiveLocation = await getLocationById(receiveLocationId, client);
    if (!receiveLocation || receiveLocation.status !== 'active') {
      throw new AppError(
        400,
        'LOCATION_NOT_FOUND',
        'Receive location does not exist or is not active',
        {
          location_id: receiveLocationId,
        },
      );
    }

    // Default the received quantity to what actually remains in transit (not the originally
    // requested quantity), so an omitted received_quantity cannot over-receive (Story 2.5 review).
    const inTransitRow = await getInTransitByTransferRequest(id, client);
    const receiveQty = receivedQuantity ?? (inTransitRow ? inTransitRow.quantity : row.quantity);

    // AC6: Lot matching - against the lot actually shipped (from the in-transit row), which for a
    // lot-less request differs from the (null) request lot (Story 2.5 review).
    const shippedLot = inTransitRow?.lot_id ?? row.lot_id;
    if (lotId !== shippedLot) {
      throw new AppError(
        400,
        'LOT_MISMATCH',
        `Receive lot_id "${lotId}" does not match shipped lot_id "${shippedLot}"`,
        {
          ship_lot_id: shippedLot,
          receive_lot_id: lotId,
        },
      );
    }

    // AC3: reuse the ship event's correlation_id so ship and receive share one trace id
    // (Story 2.5 review); fall back to a fresh id only if the tracking row is unexpectedly absent.
    const correlationId = inTransitRow?.correlation_id ?? randomUUID();

    const envelope = {
      stream_type: 'inventory',
      stream_id: id,
      event_type: 'transfer_receive.created',
      payload: {
        transfer_request_id: id,
        received_quantity: receiveQty,
        lot_id: lotId,
        ...(serialIds ? { serial_ids: serialIds } : {}),
        received_at_location_id: receiveLocationId,
        ...(receivedDate ? { received_date: receivedDate } : {}),
        ...(notes ? { notes } : {}),
        correlation_id: correlationId,
        business_stream: row.business_stream,
      },
      metadata: {
        correlation_id: correlationId,
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: new Date().toISOString(),
      },
    };

    await persistEvent(envelope, auditCtxFor(req, actor, 201), client);
    // Read the projected status inside the transaction: the receive projection sets it to
    // 'received' on full receipt or 'partially_received' otherwise (Story 2.5 review).
    const finalRow = await getTransferRequestById(id, client);
    await client.query('COMMIT');
    committed = true;

    sendJson(res, 201, {
      transfer_request_id: id,
      status: finalRow?.status ?? 'received',
      lot_id: lotId,
      received_quantity: receiveQty,
      correlation_id: correlationId,
    });
  } catch (err: unknown) {
    if (!committed) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/v1/stock/{sku}/in-transit
// ---------------------------------------------------------------------------

const getInTransitBase: RouteHandler = async (req, res, params) => {
  const sku = params['sku'];
  if (!sku || !SKU_REGEX.test(sku)) {
    sendRequestError(
      req,
      res,
      400,
      'INVALID_PARAMS',
      'sku path parameter must be 1-64 URL-safe characters',
    );
    return;
  }

  const authContext = getAuthContext(req);
  if (!authContext) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  const rows = await getInTransitBalances(sku);

  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  const filteredRows = wildcard
    ? rows
    : rows.filter((r) => locations.has(r.location_from) || locations.has(r.location_to));

  sendJson(res, 200, {
    sku,
    in_transit: filteredRows.map((r) => ({
      location_from: r.location_from,
      location_to: r.location_to,
      lot_id: r.lot_id,
      quantity: Number(r.quantity),
      transfer_request_id: r.transfer_request_id,
      correlation_id: r.correlation_id,
      ship_event_id: r.ship_event_id,
      created_at: r.created_at,
    })),
  });
};

// ---------------------------------------------------------------------------
// Story 11.5 Task 4.3: POST /api/v1/transfer-requests/{id}/valuation-override
// ---------------------------------------------------------------------------

/**
 * Chunk-2 review Q15: `cost_centre` and `project_code` are in BOTH event payload allowlists
 * (`src/compliance/transfer-request.ts`) but neither REST route forwarded them, so they were
 * settable only through the events and edge doors and vanished silently from a REST call.
 */
function optionalTagFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ['cost_centre', 'project_code'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `${field} must be a non-empty string when supplied`,
        {
          field,
        },
      );
    }
    out[field] = value.trim();
  }
  return out;
}

/** The transfer's FROM site (the site the officer must hold), from its source location. */
async function fromSiteOf(row: TransferRequestRow): Promise<string> {
  const fromLocation = await getLocationById(row.from_location_id);
  if (!fromLocation) {
    throw new AppError(400, 'LOCATION_NOT_FOUND', 'from_location_id does not exist', {
      from_location_id: row.from_location_id,
    });
  }
  return fromLocation.site_id;
}

const overrideValuationBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }
  assertRoleAllowed(req, GST_OFFICER_ROLES);
  const body = (getParsedBody(req) ?? {}) as Record<string, unknown>;
  const idempotencyKey = requireIdempotencyKey(body);

  // The overriding actor is the authenticated identity; a payload overridden_by is refused.
  for (const key of Object.keys(body)) {
    if (/_by$/.test(key)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `${key} is server-derived and must not be supplied`,
      );
    }
  }
  if (!isRule28Basis(body['valuation_basis'])) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'valuation_basis must be one of open_market_value, like_kind_quality, cost_plus, invoice_value_full_itc',
    );
  }
  if (typeof body['reason_code'] !== 'string' || body['reason_code'].trim() === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'reason_code is required');
  }
  // Q21: capped, not catalogued.
  if (body['reason_code'].trim().length > REASON_CODE_MAX_LENGTH) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `reason_code must be at most ${REASON_CODE_MAX_LENGTH} characters`,
      { field: 'reason_code', max_length: REASON_CODE_MAX_LENGTH },
    );
  }
  if (
    body['declared_unit_value'] !== undefined &&
    !isPositiveDecimal(body['declared_unit_value'])
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'declared_unit_value must be a positive number or numeric string when supplied',
    );
  }

  const row = await getTransferRequestById(id);
  if (!row) throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
  // Site scope through the FROM location (the Story 2.5 idiom), resolved from the SAME gst_officer
  // assignment that grants the privilege (Q5), and that assignment is the audited actor (Q6). The
  // seam is the guard for every business refusal (NOT_A_BRANCH_TRANSFER, VALUATION_LOCKED,
  // BASIS_NOT_ELIGIBLE).
  const siteId = await fromSiteOf(row);
  const actor = gstOfficerActor(req, { locationId: row.from_location_id, siteId });

  const result = await persistEvent(
    {
      stream_type: 'inventory',
      stream_id: id,
      event_type: 'transfer_request.valuation_overridden',
      idempotency_key: idempotencyKey,
      payload: {
        transfer_request_id: id,
        site_id: siteId,
        business_stream: row.business_stream,
        valuation_basis: body['valuation_basis'],
        ...(body['declared_unit_value'] !== undefined
          ? { declared_unit_value: body['declared_unit_value'] }
          : {}),
        reason_code: (body['reason_code'] as string).trim(),
        ...optionalTagFields(body),
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 200),
  );
  const valuation = await getBranchTransferValuation(id);
  sendJson(res, 200, { eventId: result.event_id, transfer_request_id: id, valuation });
};

// ---------------------------------------------------------------------------
// Story 11.5 Task 5.4: POST / GET /api/v1/transfer-requests/{id}/gst-documents
// ---------------------------------------------------------------------------

const recordGstDocumentBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }
  assertRoleAllowed(req, GST_OFFICER_ROLES);
  const body = (getParsedBody(req) ?? {}) as Record<string, unknown>;
  const idempotencyKey = requireIdempotencyKey(body);
  for (const key of Object.keys(body)) {
    if (/_by$/.test(key)) {
      throw new AppError(
        400,
        'INVALID_PARAMS',
        `${key} is server-derived and must not be supplied`,
      );
    }
  }
  const kind = body['document_kind'];
  if (typeof kind !== 'string' || !(GST_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(400, 'INVALID_PARAMS', 'document_kind must be tax_invoice or e_way_bill');
  }
  const documentNumber = body['document_number_ext'];
  if (typeof documentNumber !== 'string' || documentNumber.trim() === '') {
    throw new AppError(400, 'INVALID_PARAMS', 'document_number_ext is required');
  }
  // Q21: capped free text, no catalogue.
  if (documentNumber.trim().length > DOCUMENT_NUMBER_EXT_MAX_LENGTH) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      `document_number_ext must be at most ${DOCUMENT_NUMBER_EXT_MAX_LENGTH} characters`,
      { field: 'document_number_ext', max_length: DOCUMENT_NUMBER_EXT_MAX_LENGTH },
    );
  }
  const irnExt = body['irn_ext'] ?? body['irn'];
  if (
    kind === 'tax_invoice' &&
    (typeof irnExt !== 'string' || !IRN_EXT_REGEX.test(irnExt.trim()))
  ) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'irn_ext is required for a tax invoice and must be the 64-character hexadecimal IRN issued by the IRP',
    );
  }
  // Q14: an IRN on an e-way bill used to be spread away silently (the field is forwarded only for a
  // tax_invoice) while the events door 400s the identical payload. Refuse it here with the seam's
  // own code and message (`assertTransferGstDocumentRecordedShape`) so the two doors agree.
  if (
    kind !== 'tax_invoice' &&
    (irnExt !== undefined || body['irp_acknowledged_at'] !== undefined)
  ) {
    throw new AppError(400, 'INVALID_PARAMS', 'irn_ext applies to a tax_invoice only');
  }

  const row = await getTransferRequestById(id);
  if (!row) throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
  // Privilege and site scope from the SAME gst_officer assignment, which is also the audited
  // actor (chunk-2 review Q5/Q6).
  const siteId = await fromSiteOf(row);
  const actor = gstOfficerActor(req, { locationId: row.from_location_id, siteId });

  const result = await persistEvent(
    {
      stream_type: 'inventory',
      stream_id: id,
      event_type: 'transfer_request.gst_document_recorded',
      idempotency_key: idempotencyKey,
      payload: {
        transfer_request_id: id,
        site_id: siteId,
        business_stream: row.business_stream,
        document_kind: kind,
        document_number_ext: documentNumber.trim(),
        ...(kind === 'tax_invoice' ? { irn_ext: normalizeIrnExt(irnExt as string) } : {}),
        ...(body['irp_acknowledged_at'] !== undefined
          ? { irp_acknowledged_at: body['irp_acknowledged_at'] }
          : {}),
        ...(body['ewb_valid_until'] !== undefined
          ? { ewb_valid_until: body['ewb_valid_until'] }
          : {}),
        issued_at: body['issued_at'] ?? new Date().toISOString(),
        ...optionalTagFields(body),
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.eventLocationId },
        occurred_at: new Date().toISOString(),
      },
    },
    auditCtxFor(req, actor, 200),
  );
  const documents = await listBranchTransferGstDocuments(id);
  const gate = await dispatchGateGstDocuments(row);
  sendJson(res, 200, {
    eventId: result.event_id,
    transfer_request_id: id,
    documents,
    ship_blockers: gate.reasons,
  });
};

const listGstDocumentsBase: RouteHandler = async (req, res, params) => {
  const id = params['transfer_request_id']?.toLowerCase();
  if (!id || !UUID_REGEX.test(id)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'transfer_request_id must be a valid UUID');
    return;
  }
  const authContext = getAuthContext(req);
  if (!authContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const row = await getTransferRequestById(id);
  if (!row) throw new AppError(404, 'NOT_FOUND', `Transfer request "${id}" not found`);
  // Any inventory reader at either end may see why a ship is blocked (the warehouse must).
  const { wildcard, locations } = permittedLocationsForModule(authContext.roles, 'inventory');
  if (!wildcard && !locations.has(row.from_location_id) && !locations.has(row.to_location_id)) {
    throw new AppError(
      403,
      'LOCATION_ACCESS_DENIED',
      'No role assignment grants access to the locations in this transfer',
    );
  }
  sendJson(res, 200, { transfer_request_id: id, gst: await gstBlockFor(row) });
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const createTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(createTransferRequestBase);

export const getTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(getTransferRequestBase);

export const listTransferRequestsHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(listTransferRequestsBase);

export const approveTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(approveTransferRequestBase);

export const rejectTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(rejectTransferRequestBase);

export const shipTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(shipTransferRequestBase);

export const receiveTransferRequestHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(receiveTransferRequestBase);

export const getInTransitHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(getInTransitBase);

export const overrideTransferValuationHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(overrideValuationBase);

export const recordTransferGstDocumentHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'write',
})(recordGstDocumentBase);

export const listTransferGstDocumentsHandler: RouteHandler = requireRole({
  module: 'inventory',
  functionScope: 'read',
})(listGstDocumentsBase);

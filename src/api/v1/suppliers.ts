import type { IncomingMessage } from 'node:http';
import type { RouteHandler } from '../../middleware/error.js';
import { AppError, sendJson, sendRequestError } from '../../middleware/error.js';
import {
  getParsedBody,
  getAuthContext,
  getAuthorizedAssignment,
  getTraceId,
} from '../../middleware/context.js';
import { requireRole } from '../../middleware/rbac.js';
import { persistEvent } from '../../events/store.js';
import type { AuditEntryPayload } from '../../read/projections/audit_log.js';
import { randomUUID } from 'node:crypto';

import {
  getSupplierById,
  getSupplierByOwnerPartyCode,
  listSuppliers,
} from '../../read/projections/supplier.js';
import {
  findMatchingDoaEntry,
  findRoleHolder,
  findActiveDelegation,
  listActiveDoaEntries,
} from '../../read/projections/doa_registry.js';

const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';
const SUPPLIER_DOA_TYPE = 'supplier_onboarding';

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
    method: req.method ?? '',
    http_status: httpStatus,
    metadata: {},
  };
}

async function resolveApprover(
  transactionType: string,
  value: number,
): Promise<{ requiresApproval: boolean; approverActorId: string | null }> {
  const doaEntry = await findMatchingDoaEntry(transactionType, value);
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
      'Supplier onboarding requires approval but no active approver could be resolved',
      { transaction_type: transactionType },
    );
  }
  return { requiresApproval: true, approverActorId: approver };
}

const createSupplierBase: RouteHandler = async (req, res, _params) => {
  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const actor = actorContext(req);
  const supplierId = randomUUID();
  const now = new Date().toISOString();

  const envelope = {
    stream_type: 'procurement',
    stream_id: supplierId,
    event_type: 'supplier.registered',
    event_id: randomUUID(),
    payload: {
      supplier_id: supplierId,
      legal_name: body.legal_name,
      owner_party_code: body.owner_party_code,
      gstin_ext: body.gstin_ext ?? null,
      pan_ext: body.pan_ext ?? null,
      contacts: body.contacts ?? [],
      credit_period_days: body.credit_period_days ?? 0,
      commercial_terms: body.commercial_terms ?? null,
      freight_terms: body.freight_terms ?? null,
      delivery_terms: body.delivery_terms ?? null,
      certification_references: body.certification_references ?? [],
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      occurred_at: now,
    },
  };

  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 201));
  const supplier = await getSupplierById(supplierId);

  sendJson(req, res, 201, {
    event_id: persisted.event_id,
    supplier: supplier ?? null,
  });
};

const getSupplierBase: RouteHandler = async (req, res, params) => {
  const supplierId = params?.['supplierId'] as string | undefined;
  if (!supplierId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId is required');
    return;
  }

  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
    return;
  }

  sendJson(req, res, 200, { supplier });
};

const listSuppliersBase: RouteHandler = async (req, res, _params) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const status = url.searchParams.get('status') as 'onboarding' | 'active' | 'inactive' | null;
  const search = url.searchParams.get('search');

  if (status && !['onboarding', 'active', 'inactive'].includes(status)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'status must be one of: onboarding, active, inactive', { status });
    return;
  }

  const results = await listSuppliers({
    status: status ?? undefined,
    search: search ?? undefined,
  });

  sendJson(req, res, 200, { suppliers: results });
};

const submitOnboardingBase: RouteHandler = async (req, res, params) => {
  const supplierId = params?.['supplierId'] as string | undefined;
  if (!supplierId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId is required');
    return;
  }

  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
    return;
  }

  if (supplier.status === 'active') {
    sendRequestError(req, res, 400, 'SUPPLIER_ALREADY_ACTIVE', 'Supplier is already active', { supplier_id: supplierId });
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const documents = (body?.documents as Record<string, unknown>[]) ?? [];

  const approval = await resolveApprover(SUPPLIER_DOA_TYPE, 0);

  const actor = actorContext(req);
  const now = new Date().toISOString();

  if (!approval.requiresApproval) {
    const envelope = {
      stream_type: 'procurement',
      stream_id: supplierId,
      event_type: 'supplier.onboarding_approved',
      event_id: randomUUID(),
      payload: {
        supplier_id: supplierId,
        approver_actor_id: actor.userId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: {
          user_id: actor.userId,
          role: actor.role,
          location_id: actor.eventLocationId,
        },
        occurred_at: now,
      },
    };

    const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 200));
    const updated = await getSupplierById(supplierId);

    sendJson(req, res, 200, {
      event_id: persisted.event_id,
      requires_approval: false,
      supplier: updated,
    });
    return;
  }

  const envelope = {
    stream_type: 'procurement',
    stream_id: supplierId,
    event_type: 'supplier.onboarding_submitted',
    event_id: randomUUID(),
    payload: {
      supplier_id: supplierId,
      documents,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      occurred_at: now,
    },
  };

  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 200));

  sendJson(req, res, 200, {
    event_id: persisted.event_id,
    error_code: 'APPROVAL_REQUIRED',
    message: 'Onboarding submitted for approval',
    details: {
      supplier_id: supplierId,
      approver_actor_id: approval.approverActorId,
    },
  });
};

const approveOnboardingBase: RouteHandler = async (req, res, params) => {
  const supplierId = params?.['supplierId'] as string | undefined;
  if (!supplierId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId is required');
    return;
  }

  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();

  const doaEntry = await findMatchingDoaEntry(SUPPLIER_DOA_TYPE, 0);
  if (!doaEntry) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'No DOA entry governs supplier onboarding - approval not required', { supplier_id: supplierId });
    return;
  }

  const envelope = {
    stream_type: 'procurement',
    stream_id: supplierId,
    event_type: 'supplier.onboarding_approved',
    event_id: randomUUID(),
    payload: {
      supplier_id: supplierId,
      approver_actor_id: actor.userId,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      occurred_at: now,
    },
  };

  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 200));
  const updated = await getSupplierById(supplierId);

  sendJson(req, res, 200, {
    event_id: persisted.event_id,
    supplier: updated,
  });
};

const rejectOnboardingBase: RouteHandler = async (req, res, params) => {
  const supplierId = params?.['supplierId'] as string | undefined;
  if (!supplierId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId is required');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reason = body?.rejection_reason;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'rejection_reason is required and must be a non-empty string');
    return;
  }

  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();

  const envelope = {
    stream_type: 'procurement',
    stream_id: supplierId,
    event_type: 'supplier.onboarding_rejected',
    event_id: randomUUID(),
    payload: {
      supplier_id: supplierId,
      rejection_reason: reason.trim(),
      approver_actor_id: actor.userId,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      occurred_at: now,
    },
  };

  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 200));
  const updated = await getSupplierById(supplierId);

  sendJson(req, res, 200, {
    event_id: persisted.event_id,
    supplier: updated,
  });
};

const updateSupplierBase: RouteHandler = async (req, res, params) => {
  const supplierId = params?.['supplierId'] as string | undefined;
  if (!supplierId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId is required');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  if (!body) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'Request body is required');
    return;
  }

  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();

  const payload: Record<string, unknown> = { supplier_id: supplierId };
  if ('contacts' in body) payload.contacts = body.contacts;
  if ('credit_period_days' in body) payload.credit_period_days = body.credit_period_days;
  if ('commercial_terms' in body) payload.commercial_terms = body.commercial_terms;
  if ('freight_terms' in body) payload.freight_terms = body.freight_terms;
  if ('delivery_terms' in body) payload.delivery_terms = body.delivery_terms;
  if ('certification_references' in body) payload.certification_references = body.certification_references;

  const envelope = {
    stream_type: 'procurement',
    stream_id: supplierId,
    event_type: 'supplier.updated',
    event_id: randomUUID(),
    payload,
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      occurred_at: now,
    },
  };

  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 200));
  const updated = await getSupplierById(supplierId);

  sendJson(req, res, 200, {
    event_id: persisted.event_id,
    supplier: updated,
  });
};

const deactivateSupplierBase: RouteHandler = async (req, res, params) => {
  const supplierId = params?.['supplierId'] as string | undefined;
  if (!supplierId) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', 'supplierId is required');
    return;
  }

  const body = getParsedBody(req) as Record<string, unknown> | undefined;
  const reasonCode = body?.reason_code;
  const validReasons = ['fraud', 'business_closure', 'duplicate', 'compliance_failure', 'voluntary'];
  if (!reasonCode || typeof reasonCode !== 'string' || !validReasons.includes(reasonCode)) {
    sendRequestError(req, res, 400, 'INVALID_PARAMS', `reason_code is required and must be one of: ${validReasons.join(', ')}`, { reason_code: reasonCode });
    return;
  }

  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    sendRequestError(req, res, 404, 'SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
    return;
  }

  const actor = actorContext(req);
  const now = new Date().toISOString();

  const envelope = {
    stream_type: 'procurement',
    stream_id: supplierId,
    event_type: 'supplier.deactivated',
    event_id: randomUUID(),
    payload: {
      supplier_id: supplierId,
      reason_code: reasonCode,
      actor_id: actor.userId,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: {
        user_id: actor.userId,
        role: actor.role,
        location_id: actor.eventLocationId,
      },
      occurred_at: now,
    },
  };

  const persisted = await persistEvent(envelope, auditCtxFor(req, actor, 200));
  const updated = await getSupplierById(supplierId);

  sendJson(req, res, 200, {
    event_id: persisted.event_id,
    supplier: updated,
  });
};

export const createSupplierHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(createSupplierBase);

export const getSupplierHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(getSupplierBase);

export const listSuppliersHandler = requireRole({
  module: 'procurement',
  functionScope: 'read',
})(listSuppliersBase);

export const submitOnboardingHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(submitOnboardingBase);

export const approveOnboardingHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(approveOnboardingBase);

export const rejectOnboardingHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(rejectOnboardingBase);

export const updateSupplierHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(updateSupplierBase);

export const deactivateSupplierHandler = requireRole({
  module: 'procurement',
  functionScope: 'write',
})(deactivateSupplierBase);

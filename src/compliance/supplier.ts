import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import {
  getSupplierById,
  getSupplierByGstin,
  getSupplierByOwnerPartyCode,
  insertSupplier,
  updateSupplierStatus,
  updateSupplierMutableFields,
} from '../read/projections/supplier.js';
import { OWNER_PARTY_CODE_REGEX } from './ownership.js';
import { emitNotificationInTransaction } from '../notify/emit.js';

const PROCUREMENT_STREAM_TYPES = new Set(['procurement']);
const SUPPLIER_EVENT_TYPES = new Set([
  'supplier.registered',
  'supplier.onboarding_submitted',
  'supplier.onboarding_approved',
  'supplier.onboarding_rejected',
  'supplier.updated',
  'supplier.deactivated',
]);

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const DECACTIVATION_REASONS = new Set([
  'fraud',
  'business_closure',
  'duplicate',
  'compliance_failure',
  'voluntary',
]);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function supplierEventType(envelope: EventEnvelope): string | null {
  if (!PROCUREMENT_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!SUPPLIER_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AppError(400, code, message, details);
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

export function assertSupplierShape(envelope: EventEnvelope): void {
  const type = supplierEventType(envelope);
  if (!type) return;
  const p = envelope.payload as Record<string, unknown>;

  switch (type) {
    case 'supplier.registered':
      assertSupplierRegisteredShape(p);
      break;
    case 'supplier.onboarding_submitted':
      assertSupplierOnboardingSubmittedShape(p);
      break;
    case 'supplier.onboarding_approved':
      assertSupplierOnboardingApprovedShape(p);
      break;
    case 'supplier.onboarding_rejected':
      assertSupplierOnboardingRejectedShape(p);
      break;
    case 'supplier.updated':
      assertSupplierUpdatedShape(p);
      break;
    case 'supplier.deactivated':
      assertSupplierDeactivatedShape(p);
      break;
  }
}

function assertSupplierRegisteredShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!isNonEmptyString(p['legal_name']))
    reject('INVALID_PARAMS', 'legal_name is required and must be a non-empty string');
  if (!isNonEmptyString(p['owner_party_code']))
    reject('INVALID_PARAMS', 'owner_party_code is required');

  const ownerPartyCode = String(p['owner_party_code']).trim().toUpperCase();
  if (!OWNER_PARTY_CODE_REGEX.test(ownerPartyCode)) {
    reject('INVALID_PARAMS', 'owner_party_code must be 2-32 uppercase alphanumeric/hyphen characters', {
      owner_party_code: p['owner_party_code'],
    });
  }
  p['owner_party_code'] = ownerPartyCode;

  if (p['gstin_ext'] !== undefined && p['gstin_ext'] !== null && p['gstin_ext'] !== '') {
    if (typeof p['gstin_ext'] !== 'string' || !GSTIN_REGEX.test(p['gstin_ext'])) {
      reject('INVALID_PARAMS', 'gstin_ext must match the GSTIN format ^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$', {
        gstin_ext: p['gstin_ext'],
      });
    }
  }

  if (!Array.isArray(p['contacts']) || (p['contacts'] as unknown[]).length === 0) {
    reject('INVALID_PARAMS', 'contacts is required and must be a non-empty array');
  }
  for (const c of p['contacts'] as Record<string, unknown>[]) {
    if (!isNonEmptyString(c['name'])) {
      reject('INVALID_PARAMS', 'Each contact must have a name');
    }
    if (!isNonEmptyString(c['email']) && !isNonEmptyString(c['phone'])) {
      reject('INVALID_PARAMS', 'Each contact must have at least an email or phone');
    }
  }

  if (typeof p['credit_period_days'] !== 'number' || !Number.isInteger(p['credit_period_days']) || (p['credit_period_days'] as number) < 0) {
    reject('INVALID_PARAMS', 'credit_period_days is required and must be a non-negative integer');
  }

  if (p['commercial_terms'] !== undefined && p['commercial_terms'] !== null && typeof p['commercial_terms'] !== 'string') {
    reject('INVALID_PARAMS', 'commercial_terms must be a string');
  }
  if (p['freight_terms'] !== undefined && p['freight_terms'] !== null && typeof p['freight_terms'] !== 'string') {
    reject('INVALID_PARAMS', 'freight_terms must be a string');
  }
  if (p['delivery_terms'] !== undefined && p['delivery_terms'] !== null && typeof p['delivery_terms'] !== 'string') {
    reject('INVALID_PARAMS', 'delivery_terms must be a string');
  }

  if (p['certification_references'] !== undefined) {
    if (!Array.isArray(p['certification_references'])) {
      reject('INVALID_PARAMS', 'certification_references must be an array');
    }
    for (const cr of p['certification_references'] as Record<string, unknown>[]) {
      if (!isNonEmptyString(cr['type']) || !isNonEmptyString(cr['reference_number'])) {
        reject('INVALID_PARAMS', 'Each certification_reference must have type and reference_number');
      }
    }
  }
}

function assertSupplierOnboardingSubmittedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!Array.isArray(p['documents']) || (p['documents'] as unknown[]).length === 0) {
    reject('INVALID_PARAMS', 'documents is required and must be a non-empty array');
  }
  for (const doc of p['documents'] as Record<string, unknown>[]) {
    if (!isNonEmptyString(doc['type']) || !isNonEmptyString(doc['reference']) || !isNonEmptyString(doc['file_hash'])) {
      reject('INVALID_PARAMS', 'Each document must have type, reference, and file_hash');
    }
  }
}

function assertSupplierOnboardingApprovedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!isUuid(p['approver_actor_id']))
    reject('INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
}

function assertSupplierOnboardingRejectedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!isNonEmptyString(p['rejection_reason']))
    reject('INVALID_PARAMS', 'rejection_reason is required and must be a non-empty string');
  if (!isUuid(p['approver_actor_id']))
    reject('INVALID_PARAMS', 'approver_actor_id is required and must be a UUID');
}

function assertSupplierUpdatedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');

  const immutableFields = ['legal_name', 'gstin_ext', 'pan_ext'];
  const presentImmutable: string[] = [];
  for (const field of immutableFields) {
    if (field in p) presentImmutable.push(field);
  }
  if (presentImmutable.length > 0) {
    reject('IMMUTABLE_FIELD', 'Cannot modify immutable fields on an active supplier', {
      immutable_fields: presentImmutable,
    });
  }

  const allowedFields = ['contacts', 'credit_period_days', 'commercial_terms', 'freight_terms', 'delivery_terms', 'certification_references'];
  let hasField = false;
  for (const field of allowedFields) {
    if (field in p) hasField = true;
  }
  if (!hasField) {
    reject('INVALID_PARAMS', 'At least one mutable field must be provided');
  }

  if (p['credit_period_days'] !== undefined && (typeof p['credit_period_days'] !== 'number' || !Number.isInteger(p['credit_period_days']) || (p['credit_period_days'] as number) < 0)) {
    reject('INVALID_PARAMS', 'credit_period_days must be a non-negative integer');
  }
  if (p['contacts'] !== undefined && (!Array.isArray(p['contacts']) || (p['contacts'] as unknown[]).length === 0)) {
    reject('INVALID_PARAMS', 'contacts must be a non-empty array');
  }
}

function assertSupplierDeactivatedShape(p: Record<string, unknown>): void {
  if (!isUuid(p['supplier_id']))
    reject('INVALID_PARAMS', 'supplier_id is required and must be a UUID');
  if (!isNonEmptyString(p['reason_code']) || !DECACTIVATION_REASONS.has(p['reason_code'] as string)) {
    reject('INVALID_PARAMS', 'reason_code is required and must be one of: fraud, business_closure, duplicate, compliance_failure, voluntary', {
      reason_code: p['reason_code'],
    });
  }
  if (!isUuid(p['actor_id']))
    reject('INVALID_PARAMS', 'actor_id is required and must be a UUID');
}

// ---------------------------------------------------------------------------
// Inside-transaction projection (DB access)
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export async function applySupplierProjection(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  const type = supplierEventType(envelope);
  if (!type) return;

  switch (type) {
    case 'supplier.registered':
      await applySupplierRegistered(envelope, client);
      break;
    case 'supplier.onboarding_submitted':
      await applySupplierOnboardingSubmitted(envelope, client);
      break;
    case 'supplier.onboarding_approved':
      await applySupplierOnboardingApproved(envelope, client);
      break;
    case 'supplier.onboarding_rejected':
      await applySupplierOnboardingRejected(envelope, client);
      break;
    case 'supplier.updated':
      await applySupplierUpdated(envelope, client);
      break;
    case 'supplier.deactivated':
      await applySupplierDeactivated(envelope, client);
      break;
  }
}

async function applySupplierRegistered(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;
  const now = new Date().toISOString();

  const existingByCode = await getSupplierByOwnerPartyCode(p['owner_party_code'] as string, client);
  if (existingByCode) {
    reject('INVALID_PARAMS', 'An active, onboarding, or inactive supplier already exists with this owner_party_code', {
      owner_party_code: p['owner_party_code'],
      existing_supplier_id: existingByCode.supplier_id,
      existing_status: existingByCode.status,
    });
  }

  if (p['gstin_ext'] && typeof p['gstin_ext'] === 'string' && p['gstin_ext'].trim() !== '') {
    const gstin = p['gstin_ext'].trim();
    const existingGstin = await client.query(
      `SELECT supplier_id, legal_name, status FROM supplier WHERE gstin_ext = $1 AND status IN ('onboarding', 'active') FOR UPDATE`,
      [gstin],
    );
    if (existingGstin.rows.length > 0) {
      const existing = existingGstin.rows[0] as Record<string, unknown>;
      reject('DUPLICATE_SUPPLIER_GSTIN', 'A supplier with this GSTIN already exists', {
        gstin_ext: gstin,
        existing_supplier_id: existing['supplier_id'],
        existing_legal_name: existing['legal_name'],
        existing_status: existing['status'],
      });
    }
  }

  await insertSupplier(
    {
      supplier_id: supplierId,
      legal_name: p['legal_name'] as string,
      owner_party_code: p['owner_party_code'] as string,
      gstin_ext: (typeof p['gstin_ext'] === 'string' && p['gstin_ext'].trim() !== '') ? p['gstin_ext'].trim() : null,
      pan_ext: (typeof p['pan_ext'] === 'string' && p['pan_ext'].trim() !== '') ? p['pan_ext'].trim() : null,
      contacts: p['contacts'] as Record<string, unknown>[],
      credit_period_days: p['credit_period_days'] as number,
      commercial_terms: (typeof p['commercial_terms'] === 'string') ? p['commercial_terms'] : null,
      freight_terms: (typeof p['freight_terms'] === 'string') ? p['freight_terms'] : null,
      delivery_terms: (typeof p['delivery_terms'] === 'string') ? p['delivery_terms'] : null,
      certification_references: (p['certification_references'] as Record<string, unknown>[]) ?? [],
      status: 'onboarding',
      deactivation_reason_code: null,
      deactivated_at: null,
      onboarding_submitted_at: null,
      onboarding_approved_at: null,
      onboarding_approved_by: null,
      onboarding_rejection_reason: null,
      created_by: envelope.metadata.actor.user_id,
      created_at: now,
      updated_at: now,
    },
    client,
  );
}

async function applySupplierOnboardingSubmitted(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;

  const existing = await client.query(
    `SELECT status, onboarding_submitted_at FROM supplier WHERE supplier_id = $1 FOR UPDATE`,
    [supplierId],
  );
  if (existing.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
  }
  const supplier = existing.rows[0] as Record<string, unknown>;
  if (supplier['status'] !== 'onboarding') {
    if (supplier['status'] === 'inactive') {
      await client.query(
        `UPDATE supplier SET status = 'onboarding', updated_at = now() WHERE supplier_id = $1`,
        [supplierId],
      );
    } else {
      reject('SUPPLIER_ALREADY_ACTIVE', 'Supplier is already active and does not require onboarding', {
        supplier_id: supplierId,
        status: supplier['status'],
      });
    }
  }

  const submittedAt = (typeof p['submitted_at'] === 'string') ? p['submitted_at'] : new Date().toISOString();
  const submittedBy = (typeof p['submitted_by'] === 'string') ? p['submitted_by'] : envelope.metadata.actor.user_id;

  await updateSupplierStatus(supplierId, 'onboarding', {
    onboarding_submitted_at: submittedAt,
  }, client);
}

async function applySupplierOnboardingApproved(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;

  const existing = await client.query(
    `SELECT status, onboarding_submitted_at FROM supplier WHERE supplier_id = $1 FOR UPDATE`,
    [supplierId],
  );
  if (existing.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
  }
  const supplier = existing.rows[0] as Record<string, unknown>;
  if (supplier['status'] !== 'onboarding') {
    if (supplier['status'] === 'active') {
      reject('SUPPLIER_ALREADY_APPROVED', 'Supplier is already active', {
        supplier_id: supplierId,
        status: supplier['status'],
      });
    } else {
      reject('SUPPLIER_NOT_FOUND', 'Supplier must be in onboarding status for approval', {
        supplier_id: supplierId,
        status: supplier['status'],
      });
    }
  }
  if (supplier['onboarding_submitted_at'] === null) {
    reject('SUPPLIER_ONBOARDING_NOT_SUBMITTED', 'Onboarding has not been submitted for this supplier', {
      supplier_id: supplierId,
    });
  }

  const now = new Date().toISOString();
  const approverId = typeof p['approved_at'] === 'string' ? p['approved_at'] : now;
  await updateSupplierStatus(supplierId, 'active', {
    onboarding_approved_at: approverId,
    onboarding_approved_by: p['approver_actor_id'] as string,
  }, client);

  await emitNotificationInTransaction(
    {
      target: { role: 'procurement_officer' },
      event_type: 'onboarding_approved',
      status_verb: 'approved',
      object_type: 'supplier_onboarding',
      object_id: supplierId,
      actor_label: `Supplier ${p['supplier_id']}`,
      next_step: 'Supplier is now active and selectable on requisitions and purchase orders',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: now,
    },
    client,
  );
}

async function applySupplierOnboardingRejected(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;

  const existing = await client.query(
    `SELECT status FROM supplier WHERE supplier_id = $1 FOR UPDATE`,
    [supplierId],
  );
  if (existing.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
  }
  const supplier = existing.rows[0] as Record<string, unknown>;
  if (supplier['status'] !== 'onboarding') {
    reject('SUPPLIER_NOT_FOUND', 'Supplier must be in onboarding status for rejection', {
      supplier_id: supplierId,
      status: supplier['status'],
    });
  }

  await updateSupplierStatus(supplierId, 'onboarding', {
    onboarding_rejection_reason: p['rejection_reason'] as string,
  }, client);

  const now = new Date().toISOString();
  await emitNotificationInTransaction(
    {
      target: { role: 'procurement_officer' },
      event_type: 'onboarding_rejected',
      status_verb: 'rejected',
      object_type: 'supplier_onboarding',
      object_id: supplierId,
      actor_label: `Supplier ${p['supplier_id']}`,
      next_step: `Rejection reason: ${p['rejection_reason']}`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      occurred_at: now,
    },
    client,
  );
}

async function applySupplierUpdated(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;

  const existing = await client.query(
    `SELECT status FROM supplier WHERE supplier_id = $1 FOR UPDATE`,
    [supplierId],
  );
  if (existing.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
  }
  const supplier = existing.rows[0] as Record<string, unknown>;
  if (supplier['status'] !== 'active') {
    reject('SUPPLIER_NOT_ACTIVE', 'Only active suppliers can be updated', {
      supplier_id: supplierId,
      status: supplier['status'],
    });
  }

  const fields: Record<string, unknown> = {};
  if ('contacts' in p) fields['contacts'] = p['contacts'];
  if ('credit_period_days' in p) fields['credit_period_days'] = p['credit_period_days'];
  if ('commercial_terms' in p) fields['commercial_terms'] = p['commercial_terms'] ?? null;
  if ('freight_terms' in p) fields['freight_terms'] = p['freight_terms'] ?? null;
  if ('delivery_terms' in p) fields['delivery_terms'] = p['delivery_terms'] ?? null;
  if ('certification_references' in p) fields['certification_references'] = p['certification_references'];

  await updateSupplierMutableFields(supplierId, fields, client);
}

async function applySupplierDeactivated(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (await alreadyPersisted(envelope, client)) return;

  const p = envelope.payload as Record<string, unknown>;
  const supplierId = p['supplier_id'] as string;

  const existing = await client.query(
    `SELECT status FROM supplier WHERE supplier_id = $1 FOR UPDATE`,
    [supplierId],
  );
  if (existing.rows.length === 0) {
    reject('SUPPLIER_NOT_FOUND', 'Supplier not found', { supplier_id: supplierId });
  }
  const supplier = existing.rows[0] as Record<string, unknown>;
  if (supplier['status'] !== 'active' && supplier['status'] !== 'onboarding') {
    reject('INVALID_PARAMS', 'Only active or onboarding suppliers can be deactivated', {
      supplier_id: supplierId,
      status: supplier['status'],
    });
  }

  const now = new Date().toISOString();
  await updateSupplierStatus(supplierId, 'inactive', {
    deactivation_reason_code: p['reason_code'] as string,
    deactivated_at: now,
  }, client);
}

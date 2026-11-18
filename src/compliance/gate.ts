import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getPurchaseOrderByRef } from '../read/projections/erp_purchase_order.js';
import { getLocationByCode } from '../read/projections/location_register.js';
import {
  getGateEventById,
  markGateEventReversed,
  upsertGateEvent,
} from '../read/projections/gate_event.js';

const GATE_STREAM_TYPES = new Set(['gate']);
const GATE_EVENT_TYPES = new Set(['gate.entered', 'gate.reversed']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return isNonEmptyString(value) && UUID_REGEX.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO8601_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

function localYmd(date: Date): string {
  // IST = UTC+5:30. Shift the instant, then read back with UTC getters so the result is
  // host-timezone independent (local getters would double-apply the offset on an IST host).
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

function gateEventType(envelope: EventEnvelope): string | null {
  if (!GATE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!GATE_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

export function assertGateEnteredShape(envelope: EventEnvelope): void {
  if (gateEventType(envelope) !== 'gate.entered') return;
  const p = envelope.payload;
  if (!isUuid(p['gate_event_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'gate_event_id is required and must be a UUID');
  const vehicle = trimmed(p['vehicle_reg_ext']);
  if (!vehicle) throw new AppError(400, 'GATE_VEHICLE_REG_REQUIRED', 'vehicle_reg_ext is required');
  p['vehicle_reg_ext'] = vehicle.toUpperCase();
  const photo = trimmed(p['challan_photo_ref']);
  if (!photo)
    throw new AppError(400, 'GATE_CHALLAN_PHOTO_REQUIRED', 'challan_photo_ref is required');
  p['challan_photo_ref'] = photo;
  const poRef = trimmed(p['po_ref_ext']);
  if (!poRef) throw new AppError(400, 'GATE_PO_REF_REQUIRED', 'po_ref_ext is required');
  p['po_ref_ext'] = poRef;
  const siteCode = trimmed(p['site_code_ext']);
  if (!siteCode) throw new AppError(400, 'GATE_SITE_NOT_FOUND', 'site_code_ext is required');
  p['site_code_ext'] = siteCode;
  const gateId = trimmed(p['gate_id']);
  if (!gateId) throw new AppError(400, 'INVALID_PARAMS', 'gate_id is required');
  p['gate_id'] = gateId;
  if (!isUuid(p['gate_officer_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'gate_officer_id is required and must be a UUID');
  if (!isIsoTimestamp(p['entered_at']))
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'entered_at is required and must be an ISO timestamp',
    );
  if (Date.parse(p['entered_at']) > Date.now() + 5 * 60_000)
    throw new AppError(400, 'INVALID_PARAMS', 'entered_at is in the future');
  if (p['driver_name'] !== undefined && p['driver_name'] !== null)
    p['driver_name'] = trimmed(p['driver_name']);
  if (p['challan_number_ext'] !== undefined && p['challan_number_ext'] !== null)
    p['challan_number_ext'] = trimmed(p['challan_number_ext']);
  assertFieldLengths(p);
  assertSupplierShape(p);
}

const SUPPLIER_REF_MAX = 64;
const SUPPLIER_NAME_MAX = 200;
const GATE_FIELD_MAX = {
  driver_name: 120,
  challan_number_ext: 64,
  vehicle_reg_ext: 32,
  po_ref_ext: 64,
  gate_id: 64,
  site_code_ext: 64,
  challan_photo_ref: 512,
} as const;

function assertFieldLengths(p: Record<string, unknown>): void {
  for (const [key, max] of Object.entries(GATE_FIELD_MAX)) {
    const v = p[key];
    if (typeof v === 'string' && v.length > max)
      throw new AppError(400, 'INVALID_PARAMS', `${key} must be at most ${max} characters`);
  }
}

/**
 * Story 3.13 (AC 3, D3): optional supplier identification. Either a vendor code (`supplier_ref_ext`,
 * `supplier_unlisted` false) or an unlisted supplier (`supplier_unlisted: true`, ref null, typed
 * name required). A present value is never empty, and a name never rides along with a vendor code.
 */
function assertSupplierShape(p: Record<string, unknown>): void {
  const flag = p['supplier_unlisted'];
  if (flag !== undefined && flag !== null && typeof flag !== 'boolean')
    throw new AppError(400, 'INVALID_PARAMS', 'supplier_unlisted must be a boolean when supplied');
  const unlisted = flag === true;
  p['supplier_unlisted'] = unlisted;
  const read = (key: string, max: number): string | null => {
    const raw = p[key];
    if (raw === undefined || raw === null) return null;
    const value = trimmed(raw);
    if (!value)
      throw new AppError(400, 'INVALID_PARAMS', `${key} must be a non-empty string when supplied`);
    if (value.length > max)
      throw new AppError(400, 'INVALID_PARAMS', `${key} must be at most ${max} characters`);
    return value;
  };
  const ref = read('supplier_ref_ext', SUPPLIER_REF_MAX);
  const name = read('supplier_name_unlisted', SUPPLIER_NAME_MAX);
  if (unlisted) {
    if (ref !== null)
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'supplier_ref_ext must be null when supplier_unlisted',
      );
    if (name === null)
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'supplier_name_unlisted is required when supplier_unlisted',
      );
  } else if (name !== null) {
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'supplier_name_unlisted requires supplier_unlisted true',
    );
  }
  p['supplier_ref_ext'] = ref;
  p['supplier_name_unlisted'] = name;
}

export function assertGateReversedShape(envelope: EventEnvelope): void {
  if (gateEventType(envelope) !== 'gate.reversed') return;
  const p = envelope.payload;
  if (!isUuid(p['gate_event_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'gate_event_id is required and must be a UUID');
  const reason = trimmed(p['reversal_reason']);
  if (!reason)
    throw new AppError(400, 'GATE_REVERSAL_REASON_REQUIRED', 'reversal_reason is required');
  p['reversal_reason'] = reason;
  if (p['reversed_by'] !== undefined && !isUuid(p['reversed_by']))
    throw new AppError(400, 'INVALID_PARAMS', 'reversed_by must be a UUID when supplied');
}

export async function applyGateProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const type = gateEventType(envelope);
  if (!type) return;
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload;

  if (type === 'gate.entered') {
    const siteCode = p['site_code_ext'] as string;
    const site = await getLocationByCode(siteCode, client);
    if (!site || site.status !== 'active' || site.level !== 'site') {
      throw new AppError(404, 'GATE_SITE_NOT_FOUND', `No active site exists for "${siteCode}"`, {
        site_code_ext: siteCode,
      });
    }
    const poRef = p['po_ref_ext'] as string;
    const po = poRef === 'UNKNOWN' ? null : await getPurchaseOrderByRef(poRef, client);
    const bindingStatus = po && po.status === 'open' ? 'matched' : 'unmatched';
    await upsertGateEvent(
      {
        gate_event_id: p['gate_event_id'] as string,
        site_id: site.location_id,
        site_code_ext: siteCode,
        po_ref_ext: poRef === 'UNKNOWN' ? null : poRef,
        binding_status: bindingStatus,
        vehicle_reg_ext: p['vehicle_reg_ext'] as string,
        driver_name: (p['driver_name'] as string | null | undefined) ?? null,
        challan_number_ext: (p['challan_number_ext'] as string | null | undefined) ?? null,
        challan_photo_ref: p['challan_photo_ref'] as string,
        gate_id: p['gate_id'] as string,
        gate_officer_id: p['gate_officer_id'] as string,
        correlation_id: envelope.metadata.correlation_id,
        supplier_ref_ext: (p['supplier_ref_ext'] as string | null | undefined) ?? null,
        supplier_name_unlisted: (p['supplier_name_unlisted'] as string | null | undefined) ?? null,
        supplier_unlisted: p['supplier_unlisted'] === true,
        entered_at: p['entered_at'] as string,
        business_date: localYmd(new Date(p['entered_at'] as string)),
        source_event_id: eventId,
      },
      client,
    );
    return;
  }

  const gateEventId = p['gate_event_id'] as string;
  const existing = await getGateEventById(gateEventId, client);
  if (!existing)
    throw new AppError(404, 'GATE_EVENT_NOT_FOUND', `No gate event exists for "${gateEventId}"`, {
      gate_event_id: gateEventId,
    });
  if (existing.status === 'reversed')
    throw new AppError(409, 'GATE_ALREADY_REVERSED', 'Gate event is already reversed', {
      gate_event_id: gateEventId,
    });
  await markGateEventReversed(gateEventId, p['reversal_reason'] as string, client);
}

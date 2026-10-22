import type { EdgeEventRecord } from './test-capture';
import { createOutboxEvent } from './outbox-event';

/**
 * Story 3.13: pure capture logic for the gate entry and weighbridge screens, mirroring the server
 * seam (src/compliance/gate.ts and src/compliance/weighbridge.ts). The device builds ONE
 * gate.entered envelope and ONE weighbridge.recorded envelope; the binding token is the
 * gate event's metadata.correlation_id and the weighment carries the same value.
 */

export const GATE_STEPS = ['challan', 'photo', 'vehicle', 'supplier'] as const;
export type GateStep = (typeof GATE_STEPS)[number];

export interface GateChallanMatch {
kind: 'match';
poRefExt: string;
supplierRefExt: string;
}

export type GateLookupResult = GateChallanMatch | { kind: 'not-found' | 'unavailable' };

/** Each edit/new lookup invalidates responses from all earlier requests. */
export function createGateLookup(fetcher: typeof fetch) {
let revision = 0;
return {
invalidate() { revision++; },
async resolve(raw: string): Promise<GateLookupResult | null> {
const current = ++revision;
const code = raw.trim();
if (!code) return { kind: 'not-found' };
try {
const asn = await fetcher(`/api/v1/asn/${encodeURIComponent(code)}`, { credentials: 'include' });
if (current !== revision) return null;
let poRef = code;
if (asn.ok) {
const body = await asn.json() as { po_ref_ext?: unknown } | null;
if (current !== revision) return null;
if (typeof body?.po_ref_ext !== 'string' || !body.po_ref_ext.trim()) return { kind: 'unavailable' };
poRef = body.po_ref_ext.trim();
} else if (asn.status !== 404) {
return { kind: 'unavailable' };
}
const po = await fetcher(`/api/v1/erp/purchase-orders/${encodeURIComponent(poRef)}`, { credentials: 'include' });
if (current !== revision) return null;
if (!po.ok) return { kind: po.status === 404 ? 'not-found' : 'unavailable' };
const body = await po.json() as { po_number_ext?: unknown; supplier_ref_ext?: unknown } | null;
if (current !== revision) return null;
if (typeof body?.po_number_ext !== 'string' || body.po_number_ext.trim() !== poRef) return { kind: 'unavailable' };
return { kind: 'match', poRefExt: poRef, supplierRefExt: typeof body.supplier_ref_ext === 'string' ? body.supplier_ref_ext.trim() : '' };
} catch {
return current === revision ? { kind: 'unavailable' } : null;
}
},
};
}

export function gateChallanBinding(resolution: GateChallanMatch | 'typed' | 'rejected') {
return typeof resolution === 'string'
? { poRefExt: 'UNKNOWN', supplierRefExt: '' }
: { poRefExt: resolution.poRefExt, supplierRefExt: resolution.supplierRefExt };
}

export function isGateSupplierReady(mode: 'matched' | 'unlisted', reference: string, name: string): boolean {
return (mode === 'matched' ? reference : name).trim().length > 0;
}

const WEIGHT_REGEX = /^\d+(\.\d{1,3})?$/;

/** A kilogram reading is a NUMERIC(_,3): digits with at most three decimals, non-negative. */
export function isKilogram(value: string): boolean {
  return WEIGHT_REGEX.test(value.trim());
}

/** Exact integer milli-kilograms, so net is never subtracted as a JS float. */
export function parseKgToMilli(value: string): bigint | null {
  const s = value.trim();
  if (!WEIGHT_REGEX.test(s)) return null;
  const [intPart, fracPart = ''] = s.split('.');
  const frac = (fracPart + '000').slice(0, 3);
  return BigInt(intPart!) * 1000n + BigInt(frac);
}

/** NUMERIC(_,3) string from integer milli-kilograms. */
export function milliToKg(milli: bigint): string {
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, '0');
  return `${whole.toString()}.${frac}`;
}

export interface Weighment {
  grossKg: string;
  tareKg: string;
  netKg: string;
}

export type WeighmentResult = { ok: true; weighment: Weighment } | { ok: false; errorCode: string };

/** Computes net = gross - tare in exact milli-kg. Tare greater than gross is refused. */
export function computeWeighment(grossKg: string, tareKg: string): WeighmentResult {
  const gross = parseKgToMilli(grossKg);
  const tare = parseKgToMilli(tareKg);
  if (tare === null) return { ok: false, errorCode: 'WEIGHBRIDGE_TARE_REQUIRED' };
  if (gross === null) return { ok: false, errorCode: 'WEIGHBRIDGE_GROSS_REQUIRED' };
  const net = gross - tare;
  if (net < 0n) return { ok: false, errorCode: 'WEIGHBRIDGE_NET_NEGATIVE' };
  return {
    ok: true,
    weighment: { grossKg: milliToKg(gross), tareKg: milliToKg(tare), netKg: milliToKg(net) },
  };
}

/**
 * AC 8: the provisional on-device tolerance verdict. The server recomputes it in SQL NUMERIC and
 * its verdict replaces the banner on sync; this is only the immediate hint before submit.
 */
export function isToleranceBreach(input: {
  netKg: string;
  orderedQty: number;
  overReceiptTolerancePct: number;
  underReceiptTolerancePct: number;
}): boolean {
  const net = Number(input.netKg);
  const lower = input.orderedQty * (1 - input.underReceiptTolerancePct / 100);
  const upper = input.orderedQty * (1 + input.overReceiptTolerancePct / 100);
  return net < lower || net > upper;
}

export interface GateCaptureInput {
  challanNumberExt: string | null;
  poRefExt: string;
  challanPhotoRef: string;
  vehicleRegExt: string;
  driverName: string | null;
  supplierRefExt: string | null;
  supplierNameUnlisted: string | null;
  siteCodeExt: string;
  gateId: string;
  userId: string;
  role: string;
  siteId: string;
  deviceId: string;
  eventId?: string;
  correlationId?: string;
  occurredAt?: string;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * AC 6: one `gate.entered` envelope. The device mints gate_event_id and the binding token
 * (metadata.correlation_id); the officer id is the signed-in user; vehicle registration is
 * upper-cased on the device and again by the server.
 */
export function createGateEnteredEvent(input: GateCaptureInput): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const gateEventId = globalThis.crypto.randomUUID();
  const correlationId = input.correlationId ?? globalThis.crypto.randomUUID();
  const poRef = input.poRefExt.trim() || 'UNKNOWN';
  return createOutboxEvent({
    eventId,
    streamType: 'gate',
    streamId: gateEventId,
    eventType: 'gate.entered',
    payload: {
      gate_event_id: gateEventId,
      site_code_ext: input.siteCodeExt.trim(),
      po_ref_ext: poRef,
      vehicle_reg_ext: input.vehicleRegExt.trim().toUpperCase(),
      driver_name: trimmedOrNull(input.driverName),
      challan_number_ext: trimmedOrNull(input.challanNumberExt),
      challan_photo_ref: input.challanPhotoRef.trim(),
      gate_id: input.gateId.trim(),
      gate_officer_id: input.userId,
      entered_at: occurredAt,
      supplier_ref_ext: trimmedOrNull(input.supplierRefExt),
      supplier_name_unlisted: trimmedOrNull(input.supplierNameUnlisted),
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId,
    deviceId: input.deviceId,
    idempotencyKey: `edge-gate-${eventId}`,
    occurredAt,
    captureMethod: 'MANUAL',
  });
}

export interface WeighbridgeCaptureInput {
  correlationId: string;
  poRefExt: string;
  lineNo: number;
  grossKg: string;
  tareKg: string;
  siteCodeExt: string;
  deviceId: string;
  userId: string;
  role: string;
  siteId: string;
  /** MANUAL whenever either reading was typed; AUTO only from an indicator read. */
  captureMethod: 'AUTO' | 'MANUAL';
  eventId?: string;
  occurredAt?: string;
}

/**
 * AC 8: one `weighbridge.recorded` envelope carrying the gate binding token. Net is left for the
 * server to recompute in SQL NUMERIC; the device still refuses a negative net before queueing.
 */
export function createWeighbridgeRecordedEvent(
  input: WeighbridgeCaptureInput,
): EdgeEventRecord | { errorCode: string } {
  const weighment = computeWeighment(input.grossKg, input.tareKg);
  if (!weighment.ok) return { errorCode: weighment.errorCode };
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const weighbridgeEventId = globalThis.crypto.randomUUID();
  const event = createOutboxEvent({
    eventId,
    streamType: 'weighbridge',
    streamId: weighbridgeEventId,
    eventType: 'weighbridge.recorded',
    payload: {
      weighbridge_event_id: weighbridgeEventId,
      correlation_id: input.correlationId,
      po_ref_ext: input.poRefExt.trim(),
      line_no: input.lineNo,
      gross_kg: weighment.weighment.grossKg,
      tare_kg: weighment.weighment.tareKg,
      site_code_ext: input.siteCodeExt.trim(),
      device_id: input.deviceId.trim(),
      capture_method: input.captureMethod,
      weighed_by: input.userId,
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: input.correlationId,
    deviceId: input.deviceId,
    idempotencyKey: `edge-weigh-${eventId}`,
    occurredAt,
    captureMethod: input.captureMethod,
  });
  return event;
}

export type GateMissingPart = 'challan' | 'photo' | 'vehicle' | 'supplier';

export interface GateFormSnapshot {
  challanResolved: boolean;
  challanNumber: string;
  hasPhoto: boolean;
  vehicleReg: string;
  supplierResolved: boolean;
  supplierNameUnlisted: string;
}

/** AC 6: Next stays disabled until the challan is accepted/rejected/typed and each step is filled. */
export function missingGateParts(form: GateFormSnapshot): GateMissingPart[] {
  const missing: GateMissingPart[] = [];
if (!form.challanResolved) missing.push('challan');
  if (!form.hasPhoto) missing.push('photo');
  if (!form.vehicleReg.trim()) missing.push('vehicle');
if (!form.supplierResolved) missing.push('supplier');
  return missing;
}

export function isGateReady(form: GateFormSnapshot): boolean {
return missingGateParts(form).length === 0;
}

export function isGateStepReady(step: GateStep, form: GateFormSnapshot): boolean {
return !missingGateParts(form).includes(step);
}

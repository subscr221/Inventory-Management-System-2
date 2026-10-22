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
    invalidate() {
      revision++;
    },
    async resolve(raw: string): Promise<GateLookupResult | null> {
      const current = ++revision;
      const code = raw.trim();
      if (!code) return { kind: 'not-found' };
      try {
        const asn = await fetcher(`/api/v1/asn/${encodeURIComponent(code)}`, {
          credentials: 'include',
        });
        if (current !== revision) return null;
        let poRef = code;
        if (asn.ok) {
          const body = (await asn.json()) as { po_ref_ext?: unknown } | null;
          if (current !== revision) return null;
          if (typeof body?.po_ref_ext !== 'string' || !body.po_ref_ext.trim())
            return { kind: 'unavailable' };
          poRef = body.po_ref_ext.trim();
        } else if (asn.status !== 404) {
          return { kind: 'unavailable' };
        }
        const po = await fetcher(`/api/v1/erp/purchase-orders/${encodeURIComponent(poRef)}`, {
          credentials: 'include',
        });
        if (current !== revision) return null;
        if (!po.ok) return { kind: po.status === 404 ? 'not-found' : 'unavailable' };
        const body = (await po.json()) as {
          po_number_ext?: unknown;
          supplier_ref_ext?: unknown;
        } | null;
        if (current !== revision) return null;
        if (
          typeof body?.po_number_ext !== 'string' ||
          body.po_number_ext.trim().toLowerCase() !== poRef.toLowerCase()
        )
          return { kind: 'unavailable' };
        return {
          kind: 'match',
          poRefExt: body.po_number_ext.trim(),
          supplierRefExt:
            typeof body.supplier_ref_ext === 'string' ? body.supplier_ref_ext.trim() : '',
        };
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

export function isGateSupplierReady(
  mode: 'matched' | 'unlisted',
  reference: string,
  name: string,
): boolean {
  return (mode === 'matched' ? reference : name).trim().length > 0;
}

/** NUMERIC(_,3) reading: at most nine integer digits so an unbounded paste cannot overflow the column. */
const WEIGHT_REGEX = /^\d{1,9}(\.\d{1,3})?$/;

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

export type WeighFormProblem =
  'token' | 'po' | 'line' | 'gross' | 'tare' | 'gross-format' | 'tare-format' | 'net-negative';

export type WeighFormResult =
  { ok: true; lineNo: number; weighment: Weighment } | { ok: false; problem: WeighFormProblem };

const MAX_LINE_NO = 2147483647;

/** Field-by-field weigh form validation, so the operator is told which entry is wrong. */
export function validateWeighForm(form: {
  correlationId: string;
  poRef: string;
  lineNo: string;
  gross: string;
  tare: string;
}): WeighFormResult {
  if (!form.correlationId.trim()) return { ok: false, problem: 'token' };
  if (!form.poRef.trim()) return { ok: false, problem: 'po' };
  const line = form.lineNo.trim();
  if (!/^\d{1,10}$/.test(line) || Number(line) < 1 || Number(line) > MAX_LINE_NO) {
    return { ok: false, problem: 'line' };
  }
  const gross = parseKgToMilli(form.gross);
  if (gross === null) return { ok: false, problem: form.gross.trim() ? 'gross-format' : 'gross' };
  const tare = parseKgToMilli(form.tare);
  if (tare === null) return { ok: false, problem: form.tare.trim() ? 'tare-format' : 'tare' };
  if (gross === 0n) return { ok: false, problem: 'gross' };
  if (tare === 0n) return { ok: false, problem: 'tare' };
  const computed = computeWeighment(form.gross, form.tare);
  if (!computed.ok) return { ok: false, problem: 'net-negative' };
  return { ok: true, lineNo: Number(line), weighment: computed.weighment };
}

/** Decimal string (no exponent) scaled by 10^scale as a BigInt, or null when malformed. */
function decimalToScaled(value: string | number, scale: number): bigint | null {
  const s = String(value).trim();
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return null;
  return (
    BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0')
  );
}

/**
 * AC 8: the provisional on-device tolerance verdict, in exact BigInt arithmetic (milli-kg for
 * quantities, 1e-4 percent for tolerances). The server recomputes it in SQL NUMERIC and its verdict
 * replaces the banner on sync. Returns null when any input is malformed or out of range, so the
 * caller can show nothing rather than a wrong verdict.
 */
export function isToleranceBreach(input: {
  netKg: string;
  orderedQty: number | string;
  overReceiptTolerancePct: number | string;
  underReceiptTolerancePct: number | string;
}): boolean | null {
  const net = decimalToScaled(input.netKg, 3);
  const ordered = decimalToScaled(input.orderedQty, 3);
  const over = decimalToScaled(input.overReceiptTolerancePct, 4);
  const under = decimalToScaled(input.underReceiptTolerancePct, 4);
  if (net === null || ordered === null || over === null || under === null) return null;
  const hundred = 100n * 10000n;
  if (under > hundred || over > 1000n * 10000n) return null;
  return net * hundred < ordered * (hundred - under) || net * hundred > ordered * (hundred + over);
}

/** Largest gate/weighbridge photo the capture screen accepts; the uploader re-encodes above its own cap. */
export const MAX_GATE_PHOTO_BYTES = 25 * 1024 * 1024;

export type PhotoProblem = 'empty' | 'type' | 'size';

/** Why a chosen photo file cannot be queued, or null when it can. */
export function photoProblem(
  file: { size: number; type: string },
  accepted: readonly string[],
): PhotoProblem | null {
  if (file.size === 0) return 'empty';
  if (!file.type || !accepted.includes(file.type)) return 'type';
  if (file.size > MAX_GATE_PHOTO_BYTES) return 'size';
  return null;
}

export interface PoLineBand {
  orderedQty: string;
  overReceiptTolerancePct: string;
  underReceiptTolerancePct: string;
}

/** Reads the PO line's ordered quantity and tolerances; null on any failure (fail soft). */
export async function fetchPoLineBand(
  fetcher: typeof fetch,
  poRef: string,
  lineNo: number,
): Promise<PoLineBand | null> {
  try {
    const res = await fetcher(`/api/v1/erp/purchase-orders/${encodeURIComponent(poRef)}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { lines?: Array<Record<string, unknown>> } | null;
    const line = body?.lines?.find((l) => Number(l['line_no']) === lineNo);
    if (!line) return null;
    const band: PoLineBand = {
      orderedQty: String(line['ordered_qty']),
      overReceiptTolerancePct: String(line['over_receipt_tolerance_pct'] ?? '0'),
      underReceiptTolerancePct: String(line['under_receipt_tolerance_pct'] ?? '0'),
    };
    return isToleranceBreach({ netKg: '0', ...band }) === null ? null : band;
  } catch {
    return null;
  }
}

export interface GateCaptureInput {
  challanNumberExt: string | null;
  poRefExt: string;
  challanPhotoRef: string;
  vehicleRegExt: string;
  driverName: string | null;
  supplierRefExt: string | null;
  supplierNameUnlisted: string | null;
  /** True when the officer typed a supplier name instead of using the PO vendor. */
  supplierUnlisted?: boolean;
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
      supplier_unlisted: input.supplierUnlisted === true,
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

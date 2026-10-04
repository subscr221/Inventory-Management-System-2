import type { EdgeEventRecord } from './test-capture';
import { createOutboxEvent } from './outbox-event';
import { createIndentRaisedEvent } from './indent';
import { istCalendarDate } from './business-date';

/** Story 8.9 Table 5: the reason catalogue (twin of src/compliance/damage-reasons.ts). */
export const DAMAGE_REASON_CODES = [
  'DEAD_ON_ARRIVAL',
  'DAMAGED_COMPONENT',
  'WRONG_ITEM_OR_SPEC',
  'OTHER',
] as const;
export type DamageReasonCode = (typeof DAMAGE_REASON_CODES)[number];

/** Story 8.9 Table 5: the OTHER note is one line of at most this many characters. */
export const MAX_DAMAGE_NOTE_LENGTH = 200;

export type DamageFoundAt = 'stock' | 'in_use';

// Same rule as the server (src/compliance/damage.ts QUANTITY_REGEX), plus "above zero".
const QUANTITY_REGEX = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;

export function isDamageQuantity(value: string): boolean {
  return QUANTITY_REGEX.test(value) && Number(value) > 0;
}

export interface DamageCaptureInput {
  sku: string;
  lotNumber: string | null;
  /** Decimal string, as typed (the server compares decimal strings, never floats). */
  quantity: string;
  foundAt: DamageFoundAt;
  binCode: string | null;
  reasonCode: DamageReasonCode;
  reasonNote: string | null;
  photoAttachmentId: string;
  wholeLotRequested: boolean;
  replacementIndentId: string | null;
  userId: string;
  role: string;
  siteId: string;
  deviceId: string;
  reportId?: string;
  eventId?: string;
  occurredAt?: string;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Story 8.9 (AC 1, D1, D3): one `damage.reported` event on the `damage` stream, keyed by the
 * device-minted report id. The server stamps `reporter_user_id` from the token; the device sends
 * its own id so an offline row still names its owner (Story 1.12 upload attribution).
 */
export function createDamageReportedEvent(input: DamageCaptureInput): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const reportId = input.reportId ?? globalThis.crypto.randomUUID();
  return createOutboxEvent({
    eventId,
    streamType: 'damage',
    streamId: reportId,
    eventType: 'damage.reported',
    payload: {
      report_id: reportId,
      site_id: input.siteId,
      reporter_user_id: input.userId,
      sku: input.sku.trim(),
      lot_number: trimmedOrNull(input.lotNumber),
      quantity: input.quantity.trim(),
      found_at: input.foundAt,
      bin_code: input.foundAt === 'stock' ? trimmedOrNull(input.binCode) : null,
      reason_code: input.reasonCode,
      // Table 5: only OTHER carries a note; a note on any other code is refused by the server.
      reason_note: input.reasonCode === 'OTHER' ? trimmedOrNull(input.reasonNote) : null,
      photo_attachment_id: input.photoAttachmentId,
      whole_lot_requested: input.wholeLotRequested,
      replacement_indent_id: input.replacementIndentId,
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: globalThis.crypto.randomUUID(),
    deviceId: input.deviceId,
    idempotencyKey: `edge-damage-${eventId}`,
    occurredAt,
    captureMethod: 'MANUAL',
  });
}

/** What the linked requisition needs beyond the report (the indent shape requires all four). */
export interface DamageReplacementInput {
  indentId?: string;
  departmentCode: string;
  businessStream: string;
  itemCategory: string;
  uom: string;
  /** From i18n `damage.replacementReason`. */
  reason: string;
}

/**
 * Story 8.9 (AC 5, D15): report and request replacement is one flow. The device mints both ids,
 * the damage event names the indent and the indent names the report; the damage event comes
 * FIRST so the outbox uploads it first. The indent is urgent, needed today (IST), for the same
 * site, SKU and quantity, under the normal approval rules.
 */
export function createDamageCaptureEvents(
  input: Omit<DamageCaptureInput, 'replacementIndentId'> & {
    replacement: DamageReplacementInput | null;
  },
): EdgeEventRecord[] {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const reportId = input.reportId ?? globalThis.crypto.randomUUID();
  const { replacement, ...rest } = input;
  const indentId = replacement ? (replacement.indentId ?? globalThis.crypto.randomUUID()) : null;
  const damage = createDamageReportedEvent({
    ...rest,
    reportId,
    occurredAt,
    replacementIndentId: indentId,
  });
  if (!replacement || !indentId) return [damage];
  const indent = createIndentRaisedEvent({
    indentId,
    damageReportId: reportId,
    sku: input.sku,
    itemCategory: replacement.itemCategory,
    requestedQty: Number(input.quantity.trim()),
    uom: replacement.uom,
    needByDate: istCalendarDate(occurredAt),
    departmentCode: replacement.departmentCode,
    businessStream: replacement.businessStream,
    urgent: true,
    reason: replacement.reason,
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    deviceId: input.deviceId,
    occurredAt,
  });
  return [damage, indent];
}

export type DamageMissingPart =
  | 'sku'
  | 'bin'
  | 'quantity'
  | 'reason'
  | 'note'
  | 'photo'
  | 'lot'
  | 'replacement';

export interface DamageFormSnapshot {
  sku: string;
  foundAt: DamageFoundAt;
  binCode: string;
  quantity: string;
  reasonCode: DamageReasonCode | null;
  reasonNote: string;
  hasPhoto: boolean;
  wholeLotRequested: boolean;
  lotNumber: string;
  replacement: boolean;
  departmentCode: string;
  businessStream: string;
  itemCategory: string;
  uom: string;
}

/** Table 13 footer: "Still needed: ..." lists the missing parts in form order. */
export function missingDamageParts(form: DamageFormSnapshot): DamageMissingPart[] {
  const missing: DamageMissingPart[] = [];
  if (!form.sku.trim()) missing.push('sku');
  if (form.foundAt === 'stock' && !form.binCode.trim()) missing.push('bin');
  if (!isDamageQuantity(form.quantity.trim())) missing.push('quantity');
  if (form.reasonCode === null) missing.push('reason');
  else if (form.reasonCode === 'OTHER') {
    const note = form.reasonNote.trim();
    if (!note || note.length > MAX_DAMAGE_NOTE_LENGTH || /[\r\n]/.test(note)) missing.push('note');
  }
  if (!form.hasPhoto) missing.push('photo');
  // The server refuses a whole-lot request without a lot (it is a request about that lot).
  if (form.wholeLotRequested && !form.lotNumber.trim()) missing.push('lot');
  if (
    form.replacement &&
    [form.departmentCode, form.businessStream, form.itemCategory, form.uom].some((v) => !v.trim())
  ) {
    missing.push('replacement');
  }
  return missing;
}

/**
 * Story 3.14: pure receipt arithmetic and the `goods.received` payload builder for the acceptance
 * screen. Quantities stay decimal strings and are compared as scaled integers, never floats. The
 * server band is `ordered x (1 + over_receipt_tolerance_pct / 100)` minus cumulative GOOD+DAMAGED;
 * REJECTED never counts. The client caps GOOD to that band and reports the remainder as an excess
 * returned with the vehicle.
 */

const SCALE = 1_000_000n;

export function toMicros(value: string | number): bigint {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 0n;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt((fraction + '000000').slice(0, 6));
}

export function fromMicros(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function toleranceBasisPoints(pct: string | number | null | undefined): bigint {
  if (pct === null || pct === undefined) return 0n;
  const text = String(pct).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 0n;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

export interface BandInput {
  ordered: string | number;
  cumulativeReceived: string | number;
  overReceiptTolerancePct: string | number | null | undefined;
}

/** Remaining quantity that may still be posted as GOOD on this PO line, floored at zero. */
export function remainingBand(input: BandInput): bigint {
  const ordered = toMicros(input.ordered);
  const basisPoints = toleranceBasisPoints(input.overReceiptTolerancePct);
  const ceiling = (ordered * (10_000n + basisPoints)) / 10_000n;
  const remaining = ceiling - toMicros(input.cumulativeReceived);
  return remaining > 0n ? remaining : 0n;
}

export interface ReceiptLineDraft extends BandInput {
  poRefExt: string;
  lineNo: number;
  sku: string;
  uom: string;
  lotId?: string | null;
  expiryDate?: string | null;
  good: string | number;
  damaged: string | number;
  rejected: string | number;
  damagedDetail?: string;
  rejectedDetail?: string;
  /** One of the fixed SHORT sub-reasons, or 'OTHER' with a photo and note. */
  shortDetail?: string;
  otherPhotoRef?: string;
  otherNote?: string;
}

export interface ReceiptSubmission {
  grnId: string;
  bindingToken: string;
  inspectionBayCode: string;
  materialPhotoRef: string;
  inspectOnOpening?: 'suspected' | 'observed' | null;
  inspectNote?: string | null;
  inspectPhotoRef?: string | null;
  lines: ReceiptLineDraft[];
}

export interface ReceiptRow {
  grn_line_id: string;
  body: Record<string, unknown>;
  condition: 'GOOD' | 'DAMAGED' | 'REJECTED';
}

export interface GoodQuantityResult {
  posted: bigint;
  excess: bigint;
}

/** The quantity of a draft that may actually post as GOOD, and the excess returned with the truck. */
export function goodQuantity(draft: ReceiptLineDraft): GoodQuantityResult {
  const good = toMicros(draft.good);
  const allowed = remainingBand(draft);
  const posted = good < allowed ? good : allowed;
  return { posted, excess: good - posted };
}

/** True when the line still leaves the PO line short after this receipt's GOOD and DAMAGED units. */
export function lineIsShort(draft: ReceiptLineDraft): boolean {
  const { posted } = goodQuantity(draft);
  const counted = toMicros(draft.cumulativeReceived) + posted + toMicros(draft.damaged);
  return counted < toMicros(draft.ordered);
}

export function lineChip(draft: ReceiptLineDraft): 'not-counted' | 'matches' | 'short' | 'excess' {
  const counted = toMicros(draft.good) + toMicros(draft.damaged) + toMicros(draft.rejected);
  if (counted === 0n) return 'not-counted';
  const { excess } = goodQuantity(draft);
  if (excess > 0n) return 'excess';
  if (lineIsShort(draft)) return 'short';
  return 'matches';
}

export type IdFactory = () => string;

/**
 * Build the per-line `goods.received` bodies for one acceptance: DAMAGED and REJECTED rows first,
 * the GOOD row last, one row per non-zero condition quantity. `newId` is injected so tests are
 * deterministic and a retry reuses the ids the screen already holds.
 */
export function buildReceiptRows(
  submission: ReceiptSubmission,
  newId: IdFactory = () => crypto.randomUUID(),
): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  for (const draft of submission.lines) {
    const common: Record<string, unknown> = {
      grn_id: submission.grnId,
      po_ref_ext: draft.poRefExt,
      line_no: draft.lineNo,
      sku: draft.sku,
      uom: draft.uom,
      correlation_id: submission.bindingToken,
      source_document: 'PO',
      target_location_code: submission.inspectionBayCode,
      ...(draft.lotId ? { lot_id: draft.lotId } : {}),
      ...(draft.expiryDate ? { expiry_date: draft.expiryDate } : {}),
      ...(submission.materialPhotoRef ? { material_photo_ref: submission.materialPhotoRef } : {}),
      ...(submission.inspectOnOpening
        ? {
            inspect_on_opening: submission.inspectOnOpening,
            ...(submission.inspectNote ? { inspect_note: submission.inspectNote } : {}),
            ...(submission.inspectPhotoRef
              ? { inspect_photo_ref: submission.inspectPhotoRef }
              : {}),
          }
        : {}),
    };

    const rejected = toMicros(draft.rejected);
    if (rejected > 0n) {
      rows.push({
        grn_line_id: newId(),
        condition: 'REJECTED',
        body: {
          ...common,
          grn_line_id: '',
          received_qty: fromMicros(rejected),
          line_condition: 'REJECTED',
          reason_code: 'REJECTED',
          reason_detail: draft.rejectedDetail ?? 'WRONG_ITEM',
        },
      });
    }

    const damaged = toMicros(draft.damaged);
    if (damaged > 0n) {
      rows.push({
        grn_line_id: newId(),
        condition: 'DAMAGED',
        body: {
          ...common,
          received_qty: fromMicros(damaged),
          line_condition: 'DAMAGED',
          reason_code: 'DAMAGED',
          reason_detail: draft.damagedDetail ?? 'TRANSIT_DAMAGE',
        },
      });
    }

    const { posted } = goodQuantity(draft);
    if (posted > 0n) {
      const short = lineIsShort(draft);
      const other = short && draft.shortDetail === 'OTHER';
      rows.push({
        grn_line_id: newId(),
        condition: 'GOOD',
        body: {
          ...common,
          received_qty: fromMicros(posted),
          line_condition: 'GOOD',
          ...(short
            ? other
              ? {
                  reason_code: 'OTHER',
                  reason_photo_ref: draft.otherPhotoRef ?? '',
                  reason_note: draft.otherNote ?? '',
                }
              : { reason_code: 'SHORT', reason_detail: draft.shortDetail }
            : {}),
        },
      });
    }
  }
  for (const row of rows) row.body['grn_line_id'] = row.grn_line_id;
  return rows;
}

export interface CompletionSummary {
  lines: number;
  good: bigint;
  damaged: bigint;
  rejected: bigint;
  excess: bigint;
}

export function summarize(rows: ReceiptRow[]): CompletionSummary {
  const summary: CompletionSummary = {
    lines: rows.length,
    good: 0n,
    damaged: 0n,
    rejected: 0n,
    excess: 0n,
  };
  for (const row of rows) {
    summary[
      row.condition === 'GOOD' ? 'good' : row.condition === 'DAMAGED' ? 'damaged' : 'rejected'
    ] += toMicros(row.body['received_qty'] as string);
  }
  return summary;
}

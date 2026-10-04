// Story 3.11: the fixed, grouped receiving reason catalogue (UX run 2026-09-23..26, EXPERIENCE.md
// L151 and the memlog L43 ruling). Group codes are fixed; site-configurable labels are parked
// post-pilot (UX Q14), so there is no config knob and no table. Pure constants - no database.

export const LINE_CONDITIONS: ReadonlySet<string> = new Set(['GOOD', 'DAMAGED', 'REJECTED']);

export const RECEIPT_REASON_CODES: ReadonlySet<string> = new Set([
  'SHORT',
  'DAMAGED',
  'REJECTED',
  'OTHER',
]);

/** Sub-reasons per group. OTHER has none: it carries a photo plus a one-line note instead. */
export const RECEIPT_REASON_DETAILS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'SHORT',
    new Set([
      'SUPPLIER_SHORT_SHIPPED',
      'PART_DELIVERY_BALANCE_TO_FOLLOW',
      'COUNT_MISMATCH_WITH_CHALLAN',
    ]),
  ],
  ['DAMAGED', new Set(['TRANSIT_DAMAGE', 'PACKING_DAMAGE', 'RUST_OR_CORROSION'])],
  ['REJECTED', new Set(['WRONG_ITEM', 'WRONG_SPEC'])],
]);

/**
 * The only allowed line_condition / reason_code pairs (story Table 2). A GOOD line may carry SHORT
 * only when it leaves the PO line short - that half of the rule needs the PO band and is enforced
 * in the applier, not here.
 */
export const ALLOWED_CONDITION_REASON: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['GOOD', new Set(['SHORT', 'OTHER'])],
  ['DAMAGED', new Set(['DAMAGED', 'OTHER'])],
  ['REJECTED', new Set(['REJECTED', 'OTHER'])],
]);

export const MAX_REASON_PHOTO_REF_LENGTH = 512;
export const MAX_REASON_NOTE_LENGTH = 200;

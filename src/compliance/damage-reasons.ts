// Story 8.9: the fixed damage-report catalogues (story Tables 5 and 6). The reason codes are the
// reporter's words from mockups/key-requisitions.html L502; the outcomes are the four commercial
// outcomes the spine lists (EXPERIENCE.md L153, Q5, the PRD addendum), not the three some mocks
// show. Pure constants - no database, no config knob (the Story 3.11 catalogue precedent).

export const DAMAGE_REASON_CODES: readonly string[] = [
  'DEAD_ON_ARRIVAL',
  'DAMAGED_COMPONENT',
  'WRONG_ITEM_OR_SPEC',
  'OTHER',
];

/** OTHER carries a one-line note; every other code refuses one (the 3.11 stray-evidence lesson). */
export const DAMAGE_OTHER_REASON = 'OTHER';
export const MAX_DAMAGE_NOTE_LENGTH = 200;

export const DAMAGE_OUTCOMES: readonly string[] = [
  'debit_note',
  'return_for_replacement',
  'write_off',
  'accept_as_is_price_reduction',
];

/** The one outcome that carries a price reduction and releases the held units at close. */
export const PRICE_REDUCTION_OUTCOME = 'accept_as_is_price_reduction';

/** AC 9: a DAMAGED or REJECTED GRN line (Story 3.11) opens a case with this reason. */
export const RECEIPT_CONDITION_TO_DAMAGE_REASON: ReadonlyMap<string, string> = new Map([
  ['DAMAGED', 'DAMAGED_COMPONENT'],
  ['REJECTED', 'WRONG_ITEM_OR_SPEC'],
]);

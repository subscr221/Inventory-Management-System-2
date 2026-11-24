/**
 * Story 3.16 (AC 4, 5, 6): the pick-line execution rules kept pure so bin/lot scanning, the
 * quantity gate, the outbox event shape and the completion decision are unit tested without a DOM.
 */

export interface PickLineRow {
  pick_line_id: string;
  pick_task_id: string;
  dispatch_order_line_id: string;
  sku: string;
  directed_lot_id: string | null;
  confirmed_lot_id: string | null;
  directed_quantity: string;
  confirmed_quantity: string | null;
  location_id: string;
  pick_sequence: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'substituted' | 'short';
  capture_method: 'PWA' | 'PAPER' | null;
  location_code: string | null;
  directed_lot_number: string | null;
  uom: string | null;
}

export interface PickTaskDetail {
  pick_task_id: string;
  dispatch_order_id: string;
  sku: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  so_number_ext?: string | null;
}

/** The confirm input the edge client turns into a `pick_line.confirmed` outbox event. */
export interface PickLineConfirmInput {
  pickTaskId: string;
  pickLineId: string;
  confirmedLotId: string | null;
  confirmedQuantity: string;
  directedLotNumber: string | null;
  idempotencyKey: string;
  overrideReason?: string | null;
}

export type PickStep = 'bin' | 'lot' | 'qty';

export const PICK_STEPS: readonly PickStep[] = ['bin', 'lot', 'qty'];

export const PICK_STEP_KEYS: Record<PickStep, string> = {
  bin: 'floor.stepper.bin',
  lot: 'floor.stepper.lot',
  qty: 'floor.stepper.qty',
};

export interface MessageResult {
  ok: boolean;
  step: PickStep;
  held?: boolean;
  messageKey: string | null;
  messageParams?: Record<string, string>;
  canSubstitute?: boolean;
  scannedLot?: string;
}

export function directedBin(line: PickLineRow): string {
  return (line.location_code ?? line.location_id ?? '').trim();
}

export function directedLot(line: PickLineRow): string {
  return (line.directed_lot_number ?? line.directed_lot_id ?? '').trim();
}

/** Step 1: a wrong bin stays on step 1 and reports the directed bin; a match advances to lot. */
export function evaluateBin(code: string, line: PickLineRow): MessageResult {
  const bin = directedBin(line);
  if (code.trim().toLowerCase() !== bin.toLowerCase()) {
    return {
      ok: false,
      step: 'bin',
      messageKey: 'floor.wrongBin',
      messageParams: { code: code.trim(), bin },
    };
  }
  return { ok: true, step: 'lot', messageKey: null };
}

/**
 * Step 2: a held lot (scanned lot_number present in held_lot with a held quality status) is
 * blocked without advancing; a different unheld lot is "Wrong lot - not picked" naming the
 * directed lot; the directed lot advances to confirm with the quantity prefilled.
 */
export function evaluateLot(
  code: string,
  line: PickLineRow,
  heldLotNumber: string | null,
): MessageResult {
  const scanned = code.trim();
  const directed = directedLot(line);
  const isHeld =
    heldLotNumber !== null && scanned.toLowerCase() === heldLotNumber.trim().toLowerCase();
  if (isHeld) {
    // A held lot equal to the directed lot: there is no alternative to name, so do not instruct
    // the picker to pick the blocked lot.
    if (scanned.toLowerCase() === directed.toLowerCase()) {
      return {
        ok: false,
        step: 'lot',
        held: true,
        messageKey: 'floor.onHoldDirected',
        messageParams: { lot: heldLotNumber.trim() },
      };
    }
    return {
      ok: false,
      step: 'lot',
      held: true,
      messageKey: 'floor.onHold',
      messageParams: { lot: heldLotNumber.trim(), directed },
    };
  }
  if (scanned.toLowerCase() !== directed.toLowerCase()) {
    return {
      ok: false,
      step: 'lot',
      held: false,
      canSubstitute: true,
      scannedLot: scanned,
      messageKey: 'floor.wrongLot',
      messageParams: { code: scanned, lot: directed },
    };
  }
  return { ok: true, step: 'qty', held: false, messageKey: null };
}

/** Step 3: Confirm is enabled only when the quantity equals the directed quantity. */
export function quantityReady(value: string, line: PickLineRow): boolean {
  return value.trim() === line.directed_quantity.trim();
}

/**
 * The `pick_line.confirmed` payload the edge outbox uploads (stream warehouse). capture_method is
 * always PWA for the device screen; confirmed_by is stamped server-side.
 */
export function confirmPayload(args: {
  pickTaskId: string;
  pickLineId: string;
  confirmedLotId: string | null;
  confirmedQuantity: string;
  directedLotNumber?: string | null;
  overrideReason?: string | null;
}): Record<string, unknown> {
  // Story 3.17 (Task 6.5): the edge has no lot_master replica, so a lot substitution sends the
  // scanned lot number (confirmed_lot_id null) and the server resolves it to a UUID for the SKU.
  const substituting =
    args.confirmedLotId === null &&
    typeof args.directedLotNumber === 'string' &&
    args.directedLotNumber.trim().length > 0;
  return {
    pick_task_id: args.pickTaskId,
    pick_line_id: args.pickLineId,
    confirmed_lot_id: args.confirmedLotId,
    ...(substituting ? { confirmed_lot_number: args.directedLotNumber!.trim() } : {}),
    confirmed_quantity: args.confirmedQuantity,
    ...(args.overrideReason && args.overrideReason.trim().length > 0
      ? { override_reason: args.overrideReason.trim() }
      : {}),
    capture_method: 'PWA',
  };
}

/** A line reads Synced when it carries a confirmed, substituted or short status and no quantity remains pending. */
export function lineSettled(line: PickLineRow): boolean {
  return line.status === 'confirmed' || line.status === 'substituted' || line.status === 'short';
}

/**
 * Story 3.17 (Task 6.2): Short pick reason codes and payload construction.
 */
export type PickShortReason = 'BIN_EMPTY' | 'LESS_IN_BIN' | 'DAMAGED' | 'OTHER';

export const SHORT_PICK_REASONS: readonly PickShortReason[] = [
  'BIN_EMPTY',
  'LESS_IN_BIN',
  'DAMAGED',
  'OTHER',
];

export interface PickLineShortPickInput {
  pickTaskId: string;
  pickLineId: string;
  foundQuantity: string;
  reason: PickShortReason;
  note?: string | null;
  directedLotNumber: string | null;
  idempotencyKey: string;
}

export function shortPickPayload(args: {
  pickTaskId: string;
  pickLineId: string;
  foundQuantity: string;
  reason: PickShortReason;
  note?: string | null;
}): Record<string, unknown> {
  return {
    pick_task_id: args.pickTaskId,
    pick_line_id: args.pickLineId,
    found_quantity: args.foundQuantity,
    reason: args.reason,
    ...(args.note && args.note.trim().length > 0 ? { note: args.note.trim() } : {}),
    capture_method: 'PWA',
  };
}

export function isShortQuantity(value: string, line: PickLineRow): boolean {
  const v = parseFloat(value.trim());
  const d = parseFloat(line.directed_quantity.trim());
  return !Number.isNaN(v) && v >= 0 && v < d;
}

export interface ShortPickValidation {
  ready: boolean;
  footerKey: string;
}

export function evaluateShortPick(
  found: string,
  reason: PickShortReason | null,
  note: string,
  line: PickLineRow,
): ShortPickValidation {
  const isShort = isShortQuantity(found, line);
  if (!isShort) {
    return {
      ready: false,
      footerKey: 'floor.short.invalidQuantity',
    };
  }
  if (!reason) {
    return {
      ready: false,
      footerKey: 'floor.short.leftReason',
    };
  }
  if (reason === 'OTHER' && note.trim().length === 0) {
    return {
      ready: false,
      footerKey: 'floor.short.leftNote',
    };
  }
  return {
    ready: true,
    footerKey: 'floor.short.ready',
  };
}

/**
 * The completion decision: every non-cancelled line confirmed (Task 5). No picker-side
 * `pick_task.completed` is emitted - the server finalizes inline.
 */
export function taskComplete(lines: PickLineRow[]): boolean {
  const active = lines.filter((line) => line.status !== 'cancelled');
  return active.length > 0 && active.every(lineSettled);
}

/** The next pending line in directed pick-path order, or null when the task is done. */
export function nextLine(lines: PickLineRow[]): PickLineRow | null {
  return lines.find((line) => line.status === 'pending') ?? null;
}

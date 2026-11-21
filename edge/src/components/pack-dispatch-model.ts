/**
 * Story 3.18 (AC 3, AC 4): the pack station's pure rules, unit-tested without a DOM. The list
 * groups the dispatch read into three buckets; the pack flow derives the POST /pack body from the
 * picked-lot checklist and the single carton weight, and the scan match toggles a line in or out.
 */

export type PackStage = 'picked' | 'packed' | 'documents_generated' | 'dispatched';

export interface DispatchOrderRow {
  dispatch_order_id: string;
  so_number_ext: string;
  line_no: number;
  ship_to_ext: string | null;
  sku: string;
  quantity: string;
  picked_at: string;
  packed_at: string | null;
  dispatched_at: string | null;
  stage: PackStage;
  irn_recorded: boolean;
}

export type DispatchGroupKey = 'ready' | 'waiting' | 'dispatched';

export interface DispatchGroup {
  key: DispatchGroupKey;
  rows: DispatchOrderRow[];
}

/** AC 3: three groups in fixed order - Ready to pack, Waiting for documents, Dispatched today. */
export function groupDispatchRows(rows: DispatchOrderRow[]): DispatchGroup[] {
  return [
    { key: 'ready', rows: rows.filter((r) => r.stage === 'picked') },
    {
      key: 'waiting',
      rows: rows.filter((r) => r.stage === 'packed' || r.stage === 'documents_generated'),
    },
    { key: 'dispatched', rows: rows.filter((r) => r.stage === 'dispatched') },
  ];
}

export type WaitPill = 'cannot' | 'ready';

/** AC 3: Waiting for documents rows pill on the IRN coverage, not the stage. */
export function waitPillFor(row: DispatchOrderRow): WaitPill {
  return row.irn_recorded ? 'ready' : 'cannot';
}

export interface PickedLineRow {
  pick_line_id: string;
  sku: string;
  confirmed_lot_id: string | null;
  confirmed_lot_number: string | null;
  confirmed_quantity: string | null;
  uom: string | null;
}

export interface PackingLine {
  sku: string;
  packed_qty: string;
  lot_id: string | null;
  carton_count: number;
  actual_weight_kg: number | null;
  label_ref: null;
}

/**
 * AC 4: one `packingLines` entry per picked line, carton weight on the first line only. Fails
 * closed: a not-yet-packed lot is "lines", a missing or invalid weight is "weight", and a picked
 * line with no confirmed quantity (a data anomaly) is "lines" rather than silently packing zero.
 */
export function buildPackingLines(
  lines: PickedLineRow[],
  packedKeys: ReadonlySet<string>,
  weight: string,
): { ok: true; packingLines: PackingLine[] } | { ok: false; reason: 'lines' | 'weight' } {
  const packed = lines.filter((l) => packedKeys.has(l.pick_line_id));
  if (packed.length !== lines.length || lines.length === 0) return { ok: false, reason: 'lines' };
  if (packed.some((line) => line.confirmed_quantity === null)) {
    return { ok: false, reason: 'lines' };
  }
  const trimmed = weight.trim();
  const kilograms = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(kilograms) || kilograms <= 0) {
    return { ok: false, reason: 'weight' };
  }
  return {
    ok: true,
    packingLines: packed.map((line, idx) => ({
      sku: line.sku,
      packed_qty: line.confirmed_quantity as string,
      lot_id: line.confirmed_lot_id,
      carton_count: idx === 0 ? 1 : 0,
      actual_weight_kg: idx === 0 ? kilograms : null,
      label_ref: null,
    })),
  };
}

/** AC 4: the Generate button stays disabled until every lot is packed and a valid weight is entered. */
export function canGenerate(
  lines: PickedLineRow[],
  packedKeys: ReadonlySet<string>,
  weight: string,
): boolean {
  return buildPackingLines(lines, packedKeys, weight).ok;
}

export type ScanOutcome =
  { kind: 'packed'; lineId: string } | { kind: 'already'; lineId: string } | { kind: 'unknown' };

/**
 * AC 4: a scanned lot matches one not-yet-packed line; anything else is refused in place. When two
 * lines share a lot number (a split pick from one lot), an already-packed match does not block the
 * still-unpacked line, and only when every matching line is packed does the scan read as duplicate.
 */
export function matchScan(
  lines: PickedLineRow[],
  packedKeys: ReadonlySet<string>,
  scanned: string,
): ScanOutcome {
  const value = scanned.trim();
  if (value === '') return { kind: 'unknown' };
  const matching = lines.filter(
    (line) => line.confirmed_lot_number !== null && line.confirmed_lot_number === value,
  );
  if (matching.length === 0) return { kind: 'unknown' };
  const unpacked = matching.find((line) => !packedKeys.has(line.pick_line_id));
  if (unpacked) return { kind: 'packed', lineId: unpacked.pick_line_id };
  return { kind: 'already', lineId: matching[0]!.pick_line_id };
}

/** What is left before Generate is enabled: the un-scanned lot count and whether the weight is set. */
export interface RemainingHints {
  itemsToScan: number;
  weightMissing: boolean;
}

export function remainingHints(
  lines: PickedLineRow[],
  packedKeys: ReadonlySet<string>,
  weight: string,
): RemainingHints {
  return {
    itemsToScan: lines.filter((l) => !packedKeys.has(l.pick_line_id)).length,
    weightMissing: weight.trim() === '',
  };
}

/** A lot-less picked line has no label to scan, so it is packed by confirmation alone. */
export function autoPackedKeys(lines: PickedLineRow[]): Set<string> {
  return new Set(lines.filter((l) => l.confirmed_lot_number === null).map((l) => l.pick_line_id));
}

/** AC 5: the IRN coverage state - covered, blocked, or still unknown (a failed check). */
export function irnCoverageState(covered: boolean | null): 'blocked' | 'ready' | 'unknown' {
  if (covered === true) return 'ready';
  if (covered === false) return 'blocked';
  return 'unknown';
}

/** AC 6: a document is printable only when it has content. */
export function canPrintDocument(content: string | null): boolean {
  return content !== null;
}

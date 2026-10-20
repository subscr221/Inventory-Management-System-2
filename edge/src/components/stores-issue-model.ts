/**
 * Story 4.11 (AC 9): pure helpers behind the stores issue page. No fetch, no React, so the unit
 * test drives every rule the screen applies before it posts.
 */

export interface IssuableIndentRow {
  indent_id: string;
  indent_number_ext: string;
  status: string;
  requester_user_id: string;
  department_code: string;
  line_count?: number;
  approved_line_count?: number;
  issued_line_count?: number;
  created_at: string;
}

export interface IssuableLineRow {
  indent_line_id: string;
  line_no: number;
  sku: string;
  uom: string;
  requested_qty: string;
  issued_qty: string;
  open_qty: string;
  line_status: string;
  issue_state: string;
  approval_route: string;
}

/** What the storekeeper typed for one line; empty quantity means "not on this slip". */
export interface IssueLineForm {
  indent_line_id: string;
  quantity: string;
  location_code: string;
  lot_id: string;
  serials: string;
  override_expired_lot: boolean;
}

export interface IssueRequestLine {
  indent_line_id: string;
  quantity: string;
  location_code: string;
  lot_id?: string;
  serials?: Array<{ serial_number: string }>;
  override_expired_lot?: boolean;
}

// Mirrors the server rule: at most 12 integer digits and three decimals.
const QTY_REGEX = /^\d{1,12}(\.\d{1,3})?$/;

/** NUMERIC text to thousandths as a BigInt, so comparisons never touch floats. */
function toMilli(value: string): bigint | null {
  if (!/^\d+(\.\d{1,3})?$/.test(value)) return null;
  const [whole = '0', frac = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt((frac + '000').slice(0, 3));
}

export function isIssuableIndentRow(value: unknown): value is IssuableIndentRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.indent_id === 'string' &&
    typeof row.indent_number_ext === 'string' &&
    typeof row.status === 'string' &&
    typeof row.requester_user_id === 'string' &&
    typeof row.department_code === 'string' &&
    typeof row.created_at === 'string'
  );
}

export function isIssuableLineRow(value: unknown): value is IssuableLineRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.indent_line_id === 'string' &&
    typeof row.line_no === 'number' &&
    typeof row.sku === 'string' &&
    typeof row.uom === 'string' &&
    typeof row.requested_qty === 'string' &&
    typeof row.issued_qty === 'string' &&
    typeof row.open_qty === 'string' &&
    typeof row.line_status === 'string' &&
    typeof row.issue_state === 'string'
  );
}

/** Only approved lines still open can go on a slip (Table 3 of the story). */
export function openApprovedLines(lines: IssuableLineRow[]): IssuableLineRow[] {
  return lines.filter((l) => l.line_status === 'approved' && l.issue_state === 'open');
}

export function emptyForm(line: IssuableLineRow): IssueLineForm {
  return {
    indent_line_id: line.indent_line_id,
    quantity: '',
    location_code: '',
    lot_id: '',
    serials: '',
    override_expired_lot: false,
  };
}

export type BuildResult =
  | { ok: true; lines: IssueRequestLine[] }
  | {
      ok: false;
      reason: 'no_lines' | 'bad_quantity' | 'over_open' | 'no_bin' | 'bad_serials';
      line_no?: number;
    };

/**
 * Turns the typed forms into the request body. Lines with an empty quantity are left off the
 * slip; a quantity above the open quantity is refused here so the server guard is never the
 * first thing the storekeeper sees.
 */
export function buildIssueBody(lines: IssuableLineRow[], forms: IssueLineForm[]): BuildResult {
  const out: IssueRequestLine[] = [];
  for (const form of forms) {
    const line = lines.find((l) => l.indent_line_id === form.indent_line_id);
    if (!line) continue;
    const quantity = form.quantity.trim();
    if (quantity === '') continue;
    const qtyMilli = QTY_REGEX.test(quantity) ? toMilli(quantity) : null;
    if (qtyMilli === null || qtyMilli <= 0n) {
      return { ok: false, reason: 'bad_quantity', line_no: line.line_no };
    }
    const openMilli = toMilli(line.open_qty);
    if (openMilli === null || qtyMilli > openMilli) {
      return { ok: false, reason: 'over_open', line_no: line.line_no };
    }
    const bin = form.location_code.trim();
    if (bin === '') return { ok: false, reason: 'no_bin', line_no: line.line_no };
    const entry: IssueRequestLine = {
      indent_line_id: line.indent_line_id,
      quantity,
      location_code: bin,
    };
    const lot = form.lot_id.trim();
    if (lot !== '') entry.lot_id = lot;
    const serials = form.serials
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (serials.length > 0) {
      if (new Set(serials).size !== serials.length || BigInt(serials.length) * 1000n !== qtyMilli) {
        return { ok: false, reason: 'bad_serials', line_no: line.line_no };
      }
      entry.serials = serials.map((serial_number) => ({ serial_number }));
    }
    if (form.override_expired_lot) entry.override_expired_lot = true;
    out.push(entry);
  }
  if (out.length === 0) return { ok: false, reason: 'no_lines' };
  return { ok: true, lines: out };
}

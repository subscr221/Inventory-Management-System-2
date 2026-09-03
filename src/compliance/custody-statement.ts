import type { CustodyLedgerEntryRow } from '../read/projections/custody_ledger_entry.js';
import { toIstCalendarDate } from '../lib/business-days.js';

/**
 * Story 9.3 (FR-JW-05, AC 2, AC 6): the custody statement is a PURE function over ledger rows and
 * the order header - unit-testable without a database, nothing persisted on request (decision 8).
 * JSON is canonical; renderCustodyStatementText is the fixed-width printable rendering. All
 * quantity arithmetic is exact scaled-integer BigInt on NUMERIC(18,3) strings (the 9.2 review
 * patch 1 rule: never Number()).
 */

// ---------------------------------------------------------------------------
// Exact NUMERIC(18,3) string arithmetic
// ---------------------------------------------------------------------------

const QTY_SCALE = 3;
const QTY_FACTOR = 10n ** BigInt(QTY_SCALE);

/** Parses a NUMERIC string (optional sign, up to 3 decimals) into a scaled BigInt. */
export function qtyToScaled(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Not a NUMERIC quantity string: "${value}"`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = unsigned.split('.');
  const padded = (frac + '0'.repeat(QTY_SCALE)).slice(0, QTY_SCALE);
  const scaled = BigInt(whole || '0') * QTY_FACTOR + BigInt(padded);
  return negative ? -scaled : scaled;
}

/** Formats a scaled BigInt back to a canonical NUMERIC(18,3) string ("-0.500", "12.000"). */
export function qtyFromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / QTY_FACTOR;
  const frac = (abs % QTY_FACTOR).toString().padStart(QTY_SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

export function qtyAdd(a: string, b: string): string {
  return qtyFromScaled(qtyToScaled(a) + qtyToScaled(b));
}

export function qtyNegate(a: string): string {
  return qtyFromScaled(-qtyToScaled(a));
}

/** -1, 0, 1 as a < b, a = b, a > b. */
export function qtyCompare(a: string, b: string): -1 | 0 | 1 {
  const x = qtyToScaled(a);
  const y = qtyToScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Statement shape
// ---------------------------------------------------------------------------

export interface CustodyStatementOrderHeader {
  service_order_id: string;
  order_number_ext: string;
  customer_party_code: string;
  customer_name: string;
  site_id: string;
  status: string;
}

export interface CustodyStatementLine extends CustodyLedgerEntryRow {
  /** Customer-owned balance for this line's sku AFTER this entry (exact string). */
  running_balance: string;
}

export interface CustodyClosingBalance {
  sku: string;
  uom: string;
  balance: string;
}

export interface CustodyStatement {
  header: {
    service_order_id: string;
    order_number_ext: string;
    customer_party_code: string;
    customer_name: string;
    site_id: string;
    status: string;
    generated_at: string;
    business_date: string;
  };
  /** Customer-owned movements in ledger order, each with the per-sku running balance. */
  lines: CustodyStatementLine[];
  /** Processor-owned, billable additions (FR-JW-07), listed apart from the customer ledger. */
  own_material: CustodyLedgerEntryRow[];
  closing_balances: CustodyClosingBalance[];
  total_customer_balance: string;
  own_material_total: string;
}

/**
 * Rows MUST arrive in statement order (occurred_at, created_at, entry_id): the running balance is
 * a prefix sum in that order. The builder does not re-sort so the SQL order is the single truth.
 */
export function buildCustodyStatement(
  order: CustodyStatementOrderHeader,
  entries: CustodyLedgerEntryRow[],
  generatedAt: string = new Date().toISOString(),
): CustodyStatement {
  const running = new Map<string, bigint>();
  const uomBySku = new Map<string, string>();
  const lines: CustodyStatementLine[] = [];
  const ownMaterial: CustodyLedgerEntryRow[] = [];
  let ownTotal = 0n;

  for (const entry of entries) {
    if (entry.ownership === 'processor') {
      ownMaterial.push(entry);
      ownTotal += qtyToScaled(entry.quantity_delta);
      continue;
    }
    const next = (running.get(entry.sku) ?? 0n) + qtyToScaled(entry.quantity_delta);
    running.set(entry.sku, next);
    if (!uomBySku.has(entry.sku)) uomBySku.set(entry.sku, entry.uom);
    lines.push({ ...entry, running_balance: qtyFromScaled(next) });
  }

  const closing: CustodyClosingBalance[] = [...running.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sku, balance]) => ({
      sku,
      uom: uomBySku.get(sku) ?? '',
      balance: qtyFromScaled(balance),
    }));
  const total = [...running.values()].reduce((acc, v) => acc + v, 0n);

  return {
    header: {
      service_order_id: order.service_order_id,
      order_number_ext: order.order_number_ext,
      customer_party_code: order.customer_party_code,
      customer_name: order.customer_name,
      site_id: order.site_id,
      status: order.status,
      generated_at: generatedAt,
      business_date: toIstCalendarDate(new Date(generatedAt)),
    },
    lines,
    own_material: ownMaterial,
    closing_balances: closing,
    total_customer_balance: qtyFromScaled(total),
    own_material_total: qtyFromScaled(ownTotal),
  };
}

// ---------------------------------------------------------------------------
// Fixed-width text rendering
// ---------------------------------------------------------------------------

const WIDTH = 100;

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : ' '.repeat(width - value.length) + value;
}

function rule(char: string = '-'): string {
  return char.repeat(WIDTH);
}

const LINE_COLUMNS = [
  { title: 'DATE', width: 10 },
  { title: 'CATEGORY', width: 16 },
  { title: 'SKU', width: 21 },
  { title: 'LOT', width: 16 },
  { title: 'QTY DELTA', width: 16 },
  { title: 'BALANCE', width: 16 },
] as const;

function lineRow(cells: string[]): string {
  return LINE_COLUMNS.map((column, i) => {
    const cell = cells[i] ?? '';
    // Quantity columns are right-aligned; everything else left-aligned.
    return i >= 4 ? padLeft(cell, column.width) : padRight(cell, column.width);
  }).join(' ');
}

/** The printable custody statement: plain UTF-8, 100 columns, no control characters. */
export function renderCustodyStatementText(statement: CustodyStatement): string {
  const h = statement.header;
  const out: string[] = [];
  out.push(rule('='));
  out.push('CUSTODY STATEMENT');
  out.push(rule('='));
  out.push(`Order            : ${h.order_number_ext}  (${h.service_order_id})`);
  out.push(`Customer         : ${h.customer_party_code}  ${h.customer_name}`);
  out.push(`Site             : ${h.site_id}`);
  out.push(`Order status     : ${h.status}`);
  out.push(`Generated        : ${h.generated_at}  (business date ${h.business_date} IST)`);
  out.push('');
  out.push('CUSTOMER-OWNED MATERIAL');
  out.push(rule());
  out.push(lineRow(LINE_COLUMNS.map((c) => c.title)));
  out.push(rule());
  if (statement.lines.length === 0) out.push('(no movements)');
  for (const line of statement.lines) {
    out.push(
      lineRow([
        line.business_date,
        line.movement_category,
        line.sku,
        line.lot_id ?? '',
        `${line.quantity_delta} ${line.uom}`,
        line.running_balance,
      ]),
    );
    if (line.movement_category === 'receipt') {
      out.push(`           receipt ${line.receipt_id ?? ''}`);
      out.push(
        `           variance ${line.variance_qty ?? '0.000'}${
          line.variance_flagged ? ' FLAGGED' : ''
        }  received_by ${line.posted_by}`,
      );
    }
  }
  out.push(rule());
  out.push('CLOSING CUSTOMER-OWNED BALANCES');
  out.push(rule());
  if (statement.closing_balances.length === 0) out.push('(none)');
  for (const closing of statement.closing_balances) {
    out.push(`${padRight(closing.sku, 40)} ${padLeft(closing.balance, 20)} ${closing.uom}`);
  }
  out.push(`${padRight('TOTAL', 40)} ${padLeft(statement.total_customer_balance, 20)}`);
  out.push('');
  out.push('OWN MATERIAL (processor-owned, billable)');
  out.push(rule());
  if (statement.own_material.length === 0) out.push('(none)');
  for (const own of statement.own_material) {
    out.push(
      lineRow([
        own.business_date,
        own.movement_category,
        own.sku,
        own.lot_id ?? '',
        `${own.quantity_delta} ${own.uom}`,
        'billable',
      ]),
    );
  }
  out.push(`${padRight('OWN MATERIAL TOTAL', 40)} ${padLeft(statement.own_material_total, 20)}`);
  out.push(rule('='));
  return out.join('\n') + '\n';
}

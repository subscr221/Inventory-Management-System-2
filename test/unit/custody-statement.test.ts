import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  qtyToScaled,
  qtyFromScaled,
  qtyAdd,
  qtyNegate,
  qtyCompare,
  buildCustodyStatement,
  renderCustodyStatementText,
} from '../../src/compliance/custody-statement.js';
import type { CustodyLedgerEntryRow } from '../../src/read/projections/custody_ledger_entry.js';

/**
 * Story 9.3 (Task 8.3): the statement builder is a pure function; running balances and sign
 * handling are asserted with EXACT strings, never Number(). Processor-owned rows are present in
 * every fixture so the FR-JW-07 exclusion is exercised, not assumed.
 */

const ORDER_ID = randomUUID();

function row(
  overrides: Partial<CustodyLedgerEntryRow> &
    Pick<CustodyLedgerEntryRow, 'movement_category' | 'quantity_delta'>,
): CustodyLedgerEntryRow {
  const processor = overrides.movement_category === 'own_material';
  return {
    entry_id: randomUUID(),
    service_order_id: ORDER_ID,
    customer_party_code: 'CUST-1',
    reference_ext: null,
    ownership: processor ? 'processor' : 'customer',
    sku: 'SKU-A',
    lot_id: 'LOT-1',
    location_id: randomUUID(),
    uom: 'KG',
    billable: processor,
    bom_line_id: null,
    kit_bom_revision_id: null,
    receipt_id: null,
    variance_qty: null,
    variance_flagged: null,
    site_id: randomUUID(),
    posted_by: randomUUID(),
    occurred_at: '2026-09-03T04:00:00.000Z',
    business_date: '2026-09-03',
    source_event_id: randomUUID(),
    source_event_type: 'x',
    correlation_id: null,
    created_at: '2026-09-03T04:00:00.000Z',
    ...overrides,
  };
}

const header = {
  service_order_id: ORDER_ID,
  order_number_ext: 'JW-0001',
  customer_party_code: 'CUST-1',
  customer_name: 'Acme',
  site_id: randomUUID(),
  status: 'in_process',
};

describe('Story 9.3 exact quantity arithmetic', () => {
  it('round-trips NUMERIC(18,3) strings without float drift', () => {
    assert.strictEqual(qtyFromScaled(qtyToScaled('0.1')), '0.100');
    assert.strictEqual(qtyAdd('0.1', '0.2'), '0.300');
    assert.strictEqual(qtyAdd('123456789012345.678', '0.001'), '123456789012345.679');
    assert.strictEqual(qtyNegate('12'), '-12.000');
    assert.strictEqual(qtyNegate('-0.5'), '0.500');
    assert.strictEqual(qtyAdd('-0.500', '0.500'), '0.000');
  });
  it('compares exactly', () => {
    assert.strictEqual(qtyCompare('1.000', '1'), 0);
    assert.strictEqual(qtyCompare('0.999', '1'), -1);
    assert.strictEqual(qtyCompare('1.001', '1'), 1);
    assert.strictEqual(qtyCompare('-1', '-2'), 1);
  });
  it('refuses non-numeric strings', () => {
    assert.throws(() => qtyToScaled('abc'), TypeError);
    assert.throws(() => qtyToScaled('1e3'), TypeError);
  });
});

describe('Story 9.3 custody statement builder (AC 2, AC 6)', () => {
  const entries: CustodyLedgerEntryRow[] = [
    row({
      movement_category: 'receipt',
      quantity_delta: '100.000',
      receipt_id: randomUUID(),
      variance_qty: '2.500',
      variance_flagged: true,
    }),
    row({ movement_category: 'own_material', quantity_delta: '7.250', sku: 'SKU-OWN', uom: 'EA' }),
    row({ movement_category: 'consumption', quantity_delta: '-30.250' }),
    row({ movement_category: 'receipt', quantity_delta: '5.000', sku: 'SKU-B', lot_id: 'LOT-B' }),
    row({ movement_category: 'consumption', quantity_delta: '-69.750' }),
    row({ movement_category: 'own_material', quantity_delta: '1.000', sku: 'SKU-A' }),
  ];

  it('runs the per-sku customer balance in ledger order and ignores processor rows', () => {
    const statement = buildCustodyStatement(header, entries, '2026-09-03T04:00:00.000Z');
    assert.strictEqual(statement.lines.length, 4);
    assert.deepStrictEqual(
      statement.lines.map((l) => [l.sku, l.quantity_delta, l.running_balance]),
      [
        ['SKU-A', '100.000', '100.000'],
        ['SKU-A', '-30.250', '69.750'],
        ['SKU-B', '5.000', '5.000'],
        ['SKU-A', '-69.750', '0.000'],
      ],
    );
    // The own_material row for SKU-A must NOT lift SKU-A's customer balance.
    assert.deepStrictEqual(statement.closing_balances, [
      { sku: 'SKU-A', uom: 'KG', balance: '0.000' },
      { sku: 'SKU-B', uom: 'KG', balance: '5.000' },
    ]);
    assert.strictEqual(statement.total_customer_balance, '5.000');
    assert.strictEqual(statement.own_material.length, 2);
    assert.strictEqual(statement.own_material_total, '8.250');
    assert.strictEqual(statement.header.business_date, '2026-09-03');
    assert.strictEqual(statement.header.order_number_ext, 'JW-0001');
  });

  it('carries the receipt variance onto the receipt line', () => {
    const statement = buildCustodyStatement(header, entries);
    assert.strictEqual(statement.lines[0]!.variance_qty, '2.500');
    assert.strictEqual(statement.lines[0]!.variance_flagged, true);
  });

  it('handles a negative running balance and an empty ledger', () => {
    const negative = buildCustodyStatement(header, [
      row({ movement_category: 'count_adjustment', quantity_delta: '-0.001' }),
    ]);
    assert.strictEqual(negative.lines[0]!.running_balance, '-0.001');
    assert.strictEqual(negative.total_customer_balance, '-0.001');
    const empty = buildCustodyStatement(header, []);
    assert.deepStrictEqual(empty.closing_balances, []);
    assert.strictEqual(empty.total_customer_balance, '0.000');
    assert.strictEqual(empty.own_material_total, '0.000');
  });

  it('renders a fixed-width text statement with a distinct own-material section', () => {
    const text = renderCustodyStatementText(
      buildCustodyStatement(header, entries, '2026-09-03T04:00:00.000Z'),
    );
    assert.ok(text.startsWith('='.repeat(100) + '\nCUSTODY STATEMENT'));
    assert.ok(text.includes('CUSTOMER-OWNED MATERIAL'));
    assert.ok(text.includes('OWN MATERIAL (processor-owned, billable)'));
    assert.ok(text.includes('JW-0001'));
    assert.ok(text.includes('FLAGGED'));
    assert.ok(text.includes('0.000'));
    assert.ok(text.includes('SKU-OWN'));
    // Every rendered line stays within the fixed width and is plain text.
    for (const line of text.split('\n')) {
      assert.ok(line.length <= 100, `line too wide: ${line.length}`);
      assert.ok(
        [...line].every((ch) => ch.charCodeAt(0) >= 0x20),
        'control character in rendered line',
      );
    }
    // Section order: customer lines, closing balances, then own material.
    assert.ok(
      text.indexOf('CUSTOMER-OWNED MATERIAL') < text.indexOf('CLOSING CUSTOMER-OWNED BALANCES'),
    );
    assert.ok(
      text.indexOf('CLOSING CUSTOMER-OWNED BALANCES') <
        text.indexOf('OWN MATERIAL (processor-owned'),
    );
  });
});

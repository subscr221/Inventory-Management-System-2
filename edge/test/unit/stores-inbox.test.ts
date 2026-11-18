import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedToday,
  buildInbox,
  openArrivals,
  resolveScan,
  type ArrivalRow,
} from '../../src/components/stores-inbox-model';

function arrival(overrides: Partial<ArrivalRow> = {}): ArrivalRow {
  return {
    gate_event_id: 'gate-1',
    challan_number_ext: 'CH-1',
    vehicle_reg_ext: 'KA01AB1234',
    driver_name: null,
    challan_photo_ref: 'photo-1',
    entered_at: '2026-10-22T08:00:00.000Z',
    binding_status: 'matched',
    po_ref_ext: 'PO-1',
    supplier_ref_ext: 'SUP-1',
    supplier_name_unlisted: null,
    supplier_unlisted: false,
    binding_token: 'token-1',
    has_accepted_weighment: true,
    grn_id: null,
    po_summary: { po_ref_ext: 'PO-1', line_count: 1, open_qty: '10' },
    ...overrides,
  };
}

test('the inbox has the four groups in order and says nothing is waiting', () => {
  const groups = buildInbox({
    arrivals: [],
    putaway: [],
    issues: [],
    showIssues: false,
    showPutaway: false,
  });
  assert.deepEqual(
    groups.map((group) => group.key),
    ['arrived', 'putaway', 'issues', 'returns'],
  );
  assert.deepEqual(
    groups.map((group) => group.cards.length),
    [0, 0, 0, 0],
  );
});

test('an unmatched arrival is pilled Match supplier and cannot start', () => {
  const [group] = buildInbox({
    arrivals: [arrival({ binding_status: 'unmatched' })],
    putaway: [],
    issues: [],
    showIssues: false,
    showPutaway: false,
  });
  assert.equal(group!.cards[0]!.pillKey, 'stores.pill.matchSupplier');
  assert.equal(group!.cards[0]!.actionHref, null);
  assert.equal(group!.cards[0]!.disabledReasonKey, 'stores.reason.matchSupplier');
});

test('a matched arrival without an accepted weighment waits for the weighbridge', () => {
  const [group] = buildInbox({
    arrivals: [arrival({ has_accepted_weighment: false })],
    putaway: [],
    issues: [],
    showIssues: false,
    showPutaway: false,
  });
  assert.equal(group!.cards[0]!.pillKey, 'stores.pill.waitingForWeighbridge');
  assert.equal(group!.cards[0]!.actionHref, null);
});

test('a matched, weighed arrival opens acceptance; an accepted one leaves the group', () => {
  const open = arrival();
  const accepted = arrival({
    gate_event_id: 'gate-2',
    challan_number_ext: 'CH-2',
    grn_id: 'grn-2',
  });
  assert.deepEqual(
    openArrivals([open, accepted]).map((row) => row.gate_event_id),
    ['gate-1'],
  );
  assert.deepEqual(
    acceptedToday([open, accepted]).map((row) => row.id),
    ['grn-2'],
  );
  const [group] = buildInbox({
    arrivals: [open, accepted],
    putaway: [],
    issues: [],
    showIssues: false,
    showPutaway: false,
  });
  assert.equal(group!.cards.length, 1);
  assert.equal(group!.cards[0]!.actionHref, '/stores/accept?gate=gate-1');
});

test('issues render only when the caller has an issue entry', () => {
  const input = {
    arrivals: [],
    putaway: [],
    issues: [{ indent_id: 'indent-1', indent_number: 'IND-1' }],
    showPutaway: false,
  };
  const hidden = buildInbox({ ...input, showIssues: false });
  assert.equal(hidden[2]!.cards.length, 0);
  const shown = buildInbox({ ...input, showIssues: true });
  assert.equal(shown[2]!.cards.length, 1);
  assert.equal(shown[2]!.cards[0]!.actionHref, '/stores/issue');
});

test('a challan scan opens acceptance; a challan already accepted is a done card', () => {
  const open = arrival();
  const accepted = arrival({
    gate_event_id: 'gate-2',
    challan_number_ext: 'CH-2',
    grn_id: 'grn-2',
  });
  assert.deepEqual(resolveScan('ch-1', [open, accepted]), { kind: 'accept', arrival: open });
  assert.deepEqual(resolveScan('CH-2', [open, accepted]), { kind: 'done', arrival: accepted });
  assert.deepEqual(resolveScan('LOT-9', [open, accepted]), { kind: 'unknown' });
});

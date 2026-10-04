import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { computeMatchVariance } from '../../src/read/projections/three_way_match.js';
import {
  MAX_REASON_NOTE_LENGTH,
  MAX_REASON_PHOTO_REF_LENGTH,
} from '../../src/compliance/receiving-reasons.js';

// Story 3.11: GRN line condition and reason codes. Bootstrapped like story-3-4.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY', raw };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

const SHORT_PART = { reason_code: 'SHORT', reason_detail: 'PART_DELIVERY_BALANCE_TO_FOLLOW' };
const DAMAGED_TRANSIT = {
  line_condition: 'DAMAGED',
  reason_code: 'DAMAGED',
  reason_detail: 'TRANSIT_DAMAGE',
};
const REJECTED_WRONG_ITEM = {
  line_condition: 'REJECTED',
  reason_code: 'REJECTED',
  reason_detail: 'WRONG_ITEM',
};

describe('Story 3.11 GRN Line Condition and Reason Codes', () => {
  let server: Server;
  let port: number;
  let siteAId: string;
  let qcZoneId: string;
  let dockId: string;
  let storeHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let supervisorId: string;

  async function seedPo(
    poRef: string,
    sku: string,
    orderedQty: number,
    overPct = 5,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3, $3, 1, $4, 5, 'ERP', now())`,
      [poRef, sku, orderedQty, overPct],
    );
  }

  async function seedToken(poRef: string): Promise<string> {
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A', $5, 1, 1000, 1100, 100, 'accepted', 'WB-1', 'MANUAL', $6, '2026-07-23', $7)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, supervisorId, randomUUID()],
    );
    return token;
  }

  function grnBody(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      correlation_id: token,
      po_ref_ext: 'OVERRIDE-ME',
      line_no: 1,
      source_document: 'PO',
      sku: 'SKU-311',
      target_location_code: 'RECV-DOCK-311',
      received_qty: 10,
      ...overrides,
    };
  }

  function post(body: Record<string, unknown>): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
  }

  async function grnLineCount(grnLineId: string): Promise<number> {
    const r = await getPool().query(
      'SELECT count(*)::int AS c FROM grn_line WHERE grn_line_id = $1',
      [grnLineId],
    );
    return r.rows[0]!['c'] as number;
  }

  async function onHandAt(sku: string, locationId: string): Promise<string> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS q FROM stock_balance WHERE sku = $1 AND location_id = $2`,
      [sku, locationId],
    );
    return r.rows[0]!['q'] as string;
  }

  async function eventPayload(grnLineId: string): Promise<Record<string, unknown>> {
    const r = await getPool().query(
      `SELECT payload FROM domain_events WHERE event_type = 'goods.received' AND payload->>'grn_line_id' = $1`,
      [grnLineId],
    );
    assert.strictEqual(r.rows.length, 1, `exactly one goods.received for ${grnLineId}`);
    return r.rows[0]!['payload'] as Record<string, unknown>;
  }

  async function assertRefused(
    body: Record<string, unknown>,
    status: number,
    code: string,
  ): Promise<void> {
    const res = await post(body);
    assert.strictEqual(res.status, status, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], code, JSON.stringify(res.body));
    assert.strictEqual(await grnLineCount(body['grn_line_id'] as string), 0, 'no row written');
    const ev = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'goods.received' AND payload->>'grn_line_id' = $1`,
      [body['grn_line_id']],
    );
    assert.strictEqual(ev.rows[0]!['c'], 0, 'no event written');
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/grn_jobwork_challan.sql',
      '../../read/projections/grn_line_condition.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE qc_quality_hold, purchase_order_line, asn_line, asn, putaway_task, grn_line, grn, weighbridge_event, gate_event, integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteAId = randomUUID();
    qcZoneId = randomUUID();
    dockId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES
         ($1, 'site-A', 'site', NULL, $1, 'general', 'ambient', false, 'active'),
         ($2, 'ZONE-QC-HOLD', 'zone', $1, $1, 'quarantine', 'ambient', true, 'active'),
         ($3, 'RECV-DOCK-311', 'zone', $1, $1, 'staging', 'ambient', false, 'active')`,
      [siteAId, qcZoneId, dockId],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES
         ('SKU-311', 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active'),
         ('SKU-311-LOT', 'EA', true, false, false, false, false, 'weighted_average', 'production', 'active')`,
    );

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    await provisionUser(port, 'store-assistant-3-11@example.com', [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
    ]);
    storeHeaders = await authFor(port, 'store-assistant-3-11@example.com');
    supervisorId = await provisionUser(port, 'unloading-supervisor-3-11@example.com', [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    await provisionUser(port, 'inventory-controller-3-11@example.com', [
      {
        role: 'inventory_controller',
        module: 'receiving',
        functionScope: 'read',
        locationId: siteAId,
      },
    ]);
    readerHeaders = await authFor(port, 'inventory-controller-3-11@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: a clean GOOD line stores GOOD with no reason on the row and the event', async () => {
    await seedPo('PO-311-CLEAN', 'SKU-311', 10);
    const body = grnBody(await seedToken('PO-311-CLEAN'), { po_ref_ext: 'PO-311-CLEAN' });
    const res = await post(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['line_condition'], 'GOOD');
    assert.strictEqual(line['reason_code'], null);
    assert.strictEqual(line['reason_detail'], null);
    assert.strictEqual(line['status'], 'posted');
    assert.strictEqual(line['shortage_variance_qty'], '0.000');
    const payload = await eventPayload(body['grn_line_id'] as string);
    assert.strictEqual(payload['line_condition'], 'GOOD', 'absent condition is stamped GOOD');
    assert.strictEqual(payload['reason_code'], undefined);
  });

  it('AC1: a DAMAGED line stores condition, code and detail on the row and the event', async () => {
    await seedPo('PO-311-DMG', 'SKU-311', 10);
    const body = grnBody(await seedToken('PO-311-DMG'), {
      po_ref_ext: 'PO-311-DMG',
      received_qty: 10,
      ...DAMAGED_TRANSIT,
    });
    const res = await post(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['line_condition'], 'DAMAGED');
    assert.strictEqual(line['reason_code'], 'DAMAGED');
    assert.strictEqual(line['reason_detail'], 'TRANSIT_DAMAGE');
    const payload = await eventPayload(body['grn_line_id'] as string);
    assert.strictEqual(payload['line_condition'], 'DAMAGED');
    assert.strictEqual(payload['reason_code'], 'DAMAGED');
    assert.strictEqual(payload['reason_detail'], 'TRANSIT_DAMAGE');
  });

  it('AC2: OTHER is refused without both a photo and a valid one-line note, and accepted with both', async () => {
    // Ordered well above what this test's several accepted OTHER lines cumulatively receive, so the
    // over-tolerance band (a separate AC5/AC6 concern) never interferes with these AC2 assertions.
    await seedPo('PO-311-OTH', 'SKU-311', 1000);
    const token = await seedToken('PO-311-OTH');
    const base = { po_ref_ext: 'PO-311-OTH', received_qty: 10, reason_code: 'OTHER' };
    const photo = 'att/photo-311.jpg';
    for (const variant of [
      { reason_note: 'seal broken on two cartons' },
      { reason_photo_ref: photo },
      { reason_photo_ref: photo, reason_note: '   ' },
      { reason_photo_ref: '  ', reason_note: 'seal broken' },
      { reason_photo_ref: photo, reason_note: 'line one\nline two' },
      { reason_photo_ref: photo, reason_note: 'x'.repeat(201) },
    ]) {
      await assertRefused(
        grnBody(token, { ...base, ...variant }),
        400,
        'RECEIVING_OTHER_EVIDENCE_REQUIRED',
      );
    }
    const ok = grnBody(token, {
      ...base,
      reason_photo_ref: ` ${photo} `,
      reason_note: ' seal broken on two cartons ',
    });
    const res = await post(ok);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['line_condition'], 'GOOD');
    assert.strictEqual(line['reason_code'], 'OTHER');
    assert.strictEqual(line['reason_photo_ref'], photo);
    assert.strictEqual(line['reason_note'], 'seal broken on two cartons');
    assert.strictEqual(line['status'], 'posted', 'GOOD plus OTHER keeps ordinary putaway');

    // Boundary (code review 2026-09-27): exactly at the limit is accepted, one over is refused.
    const noteAtLimit = 'n'.repeat(MAX_REASON_NOTE_LENGTH);
    const photoAtLimit = 'p'.repeat(MAX_REASON_PHOTO_REF_LENGTH);
    const atLimitRes = await post(
      grnBody(token, { ...base, reason_photo_ref: photoAtLimit, reason_note: noteAtLimit }),
    );
    assert.strictEqual(atLimitRes.status, 201, JSON.stringify(atLimitRes.body));
    const atLimitLine = atLimitRes.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(atLimitLine['reason_note'], noteAtLimit);
    assert.strictEqual(atLimitLine['reason_photo_ref'], photoAtLimit);
    await assertRefused(
      grnBody(token, {
        ...base,
        reason_photo_ref: 'p'.repeat(MAX_REASON_PHOTO_REF_LENGTH + 1),
        reason_note: 'seal broken',
      }),
      400,
      'RECEIVING_OTHER_EVIDENCE_REQUIRED',
    );
  });

  it('AC1/Table 1 (code review 2026-09-27): a stray reason_photo_ref or reason_note on a non-OTHER code is refused', async () => {
    await seedPo('PO-311-STRAY', 'SKU-311', 10);
    const token = await seedToken('PO-311-STRAY');
    await assertRefused(
      grnBody(token, {
        po_ref_ext: 'PO-311-STRAY',
        received_qty: 10,
        ...DAMAGED_TRANSIT,
        reason_photo_ref: 'att/stray.jpg',
      }),
      400,
      'RECEIVING_REASON_INVALID',
    );
    await assertRefused(
      grnBody(token, {
        po_ref_ext: 'PO-311-STRAY',
        received_qty: 10,
        ...SHORT_PART,
        reason_note: 'stray note',
      }),
      400,
      'RECEIVING_REASON_INVALID',
    );
  });

  it('AC3: DAMAGED and REJECTED lines quarantine only their own units; no lot-wide hold', async () => {
    await seedPo('PO-311-Q', 'SKU-311-LOT', 30);
    const token = await seedToken('PO-311-Q');
    const grnId = randomUUID();
    const lot = 'LOT-311-Q';
    const beforeQc = await onHandAt('SKU-311-LOT', qcZoneId);
    const notifBefore = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'notification.created' AND payload->'target'->>'role' = 'qc_inspector'`,
    );

    const damaged = grnBody(token, {
      grn_id: grnId,
      po_ref_ext: 'PO-311-Q',
      sku: 'SKU-311-LOT',
      lot_id: lot,
      received_qty: 5,
      ...DAMAGED_TRANSIT,
    });
    const rejected = grnBody(token, {
      grn_id: grnId,
      po_ref_ext: 'PO-311-Q',
      sku: 'SKU-311-LOT',
      lot_id: lot,
      received_qty: 3,
      ...REJECTED_WRONG_ITEM,
    });
    const good = grnBody(token, {
      grn_id: grnId,
      po_ref_ext: 'PO-311-Q',
      sku: 'SKU-311-LOT',
      lot_id: lot,
      received_qty: 25,
    });
    for (const [body, condition] of [
      [damaged, 'DAMAGED'],
      [rejected, 'REJECTED'],
    ] as const) {
      const res = await post(body);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const line = res.body['grn_line'] as Record<string, unknown>;
      assert.strictEqual(line['line_condition'], condition);
      assert.strictEqual(line['status'], 'quarantined');
      assert.strictEqual(line['qc_hold'], true);
      assert.strictEqual(line['target_location_id'], qcZoneId);
      const putaway = res.body['putaway_task'] as Record<string, unknown>;
      assert.strictEqual(putaway['status'], 'held');
      assert.strictEqual(putaway['owner_role'], 'qc_inspector');
    }
    // Damaged 5 counts against the PO line, rejected 3 does not: GOOD 25 completes the order of 30.
    const goodRes = await post(good);
    assert.strictEqual(goodRes.status, 201, JSON.stringify(goodRes.body));
    const goodLine = goodRes.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(goodLine['status'], 'posted');
    assert.strictEqual(goodLine['shortage_variance_qty'], '0.000');
    assert.strictEqual(
      (goodRes.body['putaway_task'] as Record<string, unknown>)['status'],
      'ready',
    );
    assert.strictEqual(goodLine['target_location_id'], dockId);

    // Stock (both non-clean lines, REJECTED included per the ruling) sits in quarantine.
    assert.strictEqual(
      Number(await onHandAt('SKU-311-LOT', qcZoneId)) - Number(beforeQc),
      8,
      'damaged 5 plus rejected 3 are on hand in ZONE-QC-HOLD',
    );
    // Units only: the lot flag stays clear and no Story 8.5 hold row exists.
    const lots = await getPool().query(
      `SELECT quality_hold_status FROM lot_master WHERE lot_number = $1 AND sku = 'SKU-311-LOT'`,
      [lot],
    );
    assert.ok(lots.rows.length >= 1, 'lot_master row exists for the received lot');
    for (const row of lots.rows) assert.strictEqual(row['quality_hold_status'], 'none');
    const holds = await getPool().query(
      'SELECT count(*)::int AS c FROM qc_quality_hold WHERE lot_number = $1',
      [lot],
    );
    assert.strictEqual(holds.rows[0]!['c'], 0);

    // The inspector's notification names the dock report.
    const notes = await getPool().query(
      `SELECT payload->>'next_step' AS next_step FROM domain_events
        WHERE event_type = 'notification.created' AND payload->'target'->>'role' = 'qc_inspector'`,
    );
    assert.strictEqual(notes.rows.length, (notifBefore.rows[0]!['c'] as number) + 2);
    const steps = notes.rows.map((r) => r['next_step'] as string);
    assert.ok(
      steps.some((s) => s.includes('DAMAGED / DAMAGED / TRANSIT_DAMAGE')),
      steps.join('|'),
    );
    assert.ok(
      steps.some((s) => s.includes('REJECTED / REJECTED / WRONG_ITEM')),
      steps.join('|'),
    );
  });

  it('AC3 (code review 2026-09-27): a DAMAGED line that breaches the PO over-tolerance band still quarantines, never the old tolerance-rejection outcome', async () => {
    await seedPo('PO-311-DMGOVER', 'SKU-311', 10);
    const token = await seedToken('PO-311-DMGOVER');
    const body = grnBody(token, { po_ref_ext: 'PO-311-DMGOVER', received_qty: 20, ...DAMAGED_TRANSIT });
    const res = await post(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['line_condition'], 'DAMAGED');
    assert.strictEqual(line['status'], 'quarantined', 'AC3 quarantine wins over tolerance-rejection');
    assert.strictEqual(line['qc_hold'], true);
    assert.strictEqual(line['target_location_id'], qcZoneId);
    const putaway = res.body['putaway_task'] as Record<string, unknown>;
    assert.strictEqual(putaway['status'], 'held');
    assert.strictEqual(putaway['owner_role'], 'qc_inspector');
    const notif = await getPool().query(
      `SELECT payload->>'next_step' AS next_step FROM domain_events
        WHERE event_type = 'notification.created' AND payload->>'object_id' = $1`,
      [body['grn_line_id']],
    );
    assert.strictEqual(
      notif.rows.length,
      1,
      'qc_hold_placed notification fired, not receipt_tolerance_exceeded',
    );
    assert.ok((notif.rows[0]!['next_step'] as string).includes('DAMAGED / DAMAGED / TRANSIT_DAMAGE'));
  });

  it('AC3 (code review 2026-09-27): a DAMAGED/OTHER report names the condition and note in the QC notification, with no reason_detail', async () => {
    await seedPo('PO-311-DMGOTHER', 'SKU-311', 10);
    const token = await seedToken('PO-311-DMGOTHER');
    const body = grnBody(token, {
      po_ref_ext: 'PO-311-DMGOTHER',
      line_condition: 'DAMAGED',
      reason_code: 'OTHER',
      reason_photo_ref: 'att/dmg-other.jpg',
      reason_note: 'crushed pallet corner',
    });
    const res = await post(body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['status'], 'quarantined');
    assert.strictEqual(line['reason_detail'], null);
    const notif = await getPool().query(
      `SELECT payload->>'next_step' AS next_step FROM domain_events
        WHERE event_type = 'notification.created' AND payload->>'object_id' = $1`,
      [body['grn_line_id']],
    );
    assert.strictEqual(notif.rows.length, 1);
    assert.ok((notif.rows[0]!['next_step'] as string).includes('DAMAGED / OTHER: crushed pallet corner'));
  });

  it('AC4: REJECTED never counts against the PO line - band, shortage, over-tolerance and three-way match', async () => {
    await seedPo('PO-311-REJ', 'SKU-311', 10);
    const token = await seedToken('PO-311-REJ');
    const grnId = randomUUID();
    // Far beyond the over-tolerance band, yet never RECEIPT_TOLERANCE_EXCEEDED.
    const rej = grnBody(token, {
      grn_id: grnId,
      po_ref_ext: 'PO-311-REJ',
      received_qty: 200,
      ...REJECTED_WRONG_ITEM,
      reason_detail: 'WRONG_SPEC',
    });
    const rejRes = await post(rej);
    assert.strictEqual(rejRes.status, 201, JSON.stringify(rejRes.body));
    const rejLine = rejRes.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(rejLine['status'], 'quarantined');
    assert.strictEqual(rejLine['shortage_variance_qty'], '0.000');

    // GOOD 10 is neither short nor over: the 200 rejected units are not in the cumulative.
    const good = grnBody(token, { grn_id: grnId, po_ref_ext: 'PO-311-REJ', received_qty: 10 });
    const goodRes = await post(good);
    assert.strictEqual(goodRes.status, 201, JSON.stringify(goodRes.body));
    assert.strictEqual(
      (goodRes.body['grn_line'] as Record<string, unknown>)['shortage_variance_qty'],
      '0.000',
    );
    // A further GOOD unit now trips the band (cumulative 11 > 10 * 1.05): the rejected 200 did not
    // hide the real receipts either.
    const over = await post(
      grnBody(token, { grn_id: grnId, po_ref_ext: 'PO-311-REJ', received_qty: 1 }),
    );
    assert.strictEqual(over.status, 200, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'RECEIPT_TOLERANCE_EXCEEDED');

    // Three-way match: bind the GRN to a native PO and read the received quantity it compares.
    const poId = randomUUID();
    await getPool().query(`UPDATE grn SET po_id = $1 WHERE grn_id = $2`, [poId, grnId]);
    await getPool().query(
      `INSERT INTO purchase_order_line (po_line_id, po_id, line_no, sku, item_category, ordered_qty, uom, unit_price)
       VALUES ($1, $2, 1, 'SKU-311', 'general', 10, 'EA', 1)`,
      [randomUUID(), poId],
    );
    const client = await getPool().connect();
    try {
      const cmp = await computeMatchVariance(
        randomUUID(),
        poId,
        { quantityTolerancePercent: 0, priceTolerancePercent: 0, invoiceValueToleranceAbsolute: 0 },
        client,
      );
      const line = cmp.lines.find((l) => l.sku === 'SKU-311');
      assert.ok(line, JSON.stringify(cmp));
      assert.strictEqual(Number(line!.received_qty), 10, 'REJECTED 200 is not matched');
    } finally {
      client.release();
    }

    // Visible in the discrepancy view with its reason.
    const disc = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/discrepancies?site=site-A',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(disc.status, 200, JSON.stringify(disc.body));
    const rows = disc.body['discrepancies'] as Record<string, unknown>[];
    const row = rows.find((r) => r['grn_line_id'] === rej['grn_line_id']);
    assert.ok(row, 'REJECTED line appears in the discrepancy view');
    assert.strictEqual(row!['line_condition'], 'REJECTED');
    assert.strictEqual(row!['reason_code'], 'REJECTED');
    assert.strictEqual(row!['reason_detail'], 'WRONG_SPEC');
  });

  it('AC4: a GOOD line with an OTHER anomaly and no shortage appears in the discrepancy view', async () => {
    await seedPo('PO-311-ANOM', 'SKU-311', 10);
    const body = grnBody(await seedToken('PO-311-ANOM'), {
      po_ref_ext: 'PO-311-ANOM',
      reason_code: 'OTHER',
      reason_photo_ref: 'att/anom.jpg',
      reason_note: 'invoice copy missing',
    });
    assert.strictEqual((await post(body)).status, 201);
    const disc = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/discrepancies?site=site-A',
      undefined,
      readerHeaders,
    );
    const rows = disc.body['discrepancies'] as Record<string, unknown>[];
    assert.ok(rows.some((r) => r['grn_line_id'] === body['grn_line_id']));
  });

  it('AC4 (code review 2026-09-27): a clean GOOD line with no shortage and no reason stays out of the discrepancy view', async () => {
    await seedPo('PO-311-CLEANDISC', 'SKU-311', 10);
    const body = grnBody(await seedToken('PO-311-CLEANDISC'), { po_ref_ext: 'PO-311-CLEANDISC' });
    assert.strictEqual((await post(body)).status, 201);
    const disc = await makeRequest(
      port,
      'GET',
      '/api/v1/receiving/discrepancies?site=site-A',
      undefined,
      readerHeaders,
    );
    const rows = disc.body['discrepancies'] as Record<string, unknown>[];
    assert.ok(
      !rows.some((r) => r['grn_line_id'] === body['grn_line_id']),
      'a clean GOOD line must not appear in the discrepancy view',
    );
  });

  it('AC5: reason reporting is required - missing, invalid and mismatched reasons are refused at capture', async () => {
    await seedPo('PO-311-REQ', 'SKU-311', 100);
    const token = await seedToken('PO-311-REQ');
    const po = { po_ref_ext: 'PO-311-REQ' };
    // Pre-transaction: a non-GOOD condition without a reason.
    await assertRefused(
      grnBody(token, { ...po, line_condition: 'DAMAGED' }),
      400,
      'RECEIVING_REASON_REQUIRED',
    );
    await assertRefused(
      grnBody(token, { ...po, line_condition: 'REJECTED' }),
      400,
      'RECEIVING_REASON_REQUIRED',
    );
    // In-transaction: a GOOD line leaving the PO line short, with no reason, rolls back.
    const stockBefore = await onHandAt('SKU-311', dockId);
    await assertRefused(
      grnBody(token, { ...po, received_qty: 10 }),
      400,
      'RECEIVING_REASON_REQUIRED',
    );
    assert.strictEqual(await onHandAt('SKU-311', dockId), stockBefore, 'no stock posted');
    // Vocabulary, pairing and detail rules.
    for (const bad of [
      { line_condition: 'BROKEN', reason_code: 'DAMAGED', reason_detail: 'TRANSIT_DAMAGE' },
      { reason_code: 'LOST', reason_detail: 'X' },
      { line_condition: 'DAMAGED', reason_code: 'SHORT', reason_detail: 'SUPPLIER_SHORT_SHIPPED' },
      { line_condition: 'REJECTED', reason_code: 'DAMAGED', reason_detail: 'TRANSIT_DAMAGE' },
      { reason_code: 'DAMAGED', reason_detail: 'TRANSIT_DAMAGE' },
      { reason_code: 'REJECTED', reason_detail: 'WRONG_ITEM' },
      { line_condition: 'DAMAGED', reason_code: 'DAMAGED' },
      { line_condition: 'DAMAGED', reason_code: 'DAMAGED', reason_detail: 'WRONG_ITEM' },
      { reason_code: 'SHORT', reason_detail: 'TRANSIT_DAMAGE' },
      {
        reason_code: 'OTHER',
        reason_detail: 'SUPPLIER_SHORT_SHIPPED',
        reason_photo_ref: 'p',
        reason_note: 'n',
      },
      { reason_detail: 'TRANSIT_DAMAGE' },
    ]) {
      await assertRefused(grnBody(token, { ...po, ...bad }), 400, 'RECEIVING_REASON_INVALID');
    }
    // A GOOD short line with SHORT posts, and carries its shortage.
    const shortRes = await post(grnBody(token, { ...po, received_qty: 10, ...SHORT_PART }));
    assert.strictEqual(shortRes.status, 201, JSON.stringify(shortRes.body));
    const shortLine = shortRes.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(shortLine['reason_code'], 'SHORT');
    assert.strictEqual(shortLine['shortage_variance_qty'], '90.000');

    // SHORT on a line that completes the PO line is refused in-transaction.
    await assertRefused(
      grnBody(token, {
        ...po,
        received_qty: 90,
        reason_code: 'SHORT',
        reason_detail: 'SUPPLIER_SHORT_SHIPPED',
      }),
      400,
      'RECEIVING_REASON_INVALID',
    );
  });

  it('AC5: a customer challan receipt refuses any condition or reason field', async () => {
    const body = {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      source_document: 'JOBWORK_CHALLAN',
      stock_class: 'job_work',
      sku: 'SKU-311',
      target_location_code: 'RECV-DOCK-311',
      received_qty: 5,
      service_order_id: randomUUID(),
      challan_number_ext: 'CH-311',
      challan_date: '2026-09-26',
      challan_qty: 5,
      ...DAMAGED_TRANSIT,
    };
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'receiving',
        stream_id: body.grn_id,
        event_type: 'goods.received',
        payload: body,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: supervisorId, role: 'store_assistant', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RECEIVING_REASON_INVALID');
    assert.strictEqual(await grnLineCount(body.grn_line_id), 0);

    // The same holds for customer material received on a PO line (stock_class job_work).
    await seedPo('PO-311-JW', 'SKU-311', 100);
    await assertRefused(
      grnBody(await seedToken('PO-311-JW'), {
        po_ref_ext: 'PO-311-JW',
        stock_class: 'job_work',
        ...SHORT_PART,
      }),
      400,
      'RECEIVING_REASON_INVALID',
    );
  });

  it('Split receipt: DAMAGED first then GOOD completes the order; GOOD first must say why it is short', async () => {
    await seedPo('PO-311-SPLIT', 'SKU-311', 10);
    const token = await seedToken('PO-311-SPLIT');
    const grnId = randomUUID();
    const dmg = await post(
      grnBody(token, {
        grn_id: grnId,
        po_ref_ext: 'PO-311-SPLIT',
        received_qty: 2,
        ...DAMAGED_TRANSIT,
      }),
    );
    assert.strictEqual(dmg.status, 201, JSON.stringify(dmg.body));
    const good = await post(
      grnBody(token, { grn_id: grnId, po_ref_ext: 'PO-311-SPLIT', received_qty: 8 }),
    );
    assert.strictEqual(good.status, 201, JSON.stringify(good.body));
    assert.strictEqual(
      (good.body['grn_line'] as Record<string, unknown>)['shortage_variance_qty'],
      '0.000',
    );

    // Reverse order on a fresh PO: GOOD 8 first looks short until the damaged line arrives.
    await seedPo('PO-311-SPLIT2', 'SKU-311', 10);
    const token2 = await seedToken('PO-311-SPLIT2');
    await assertRefused(
      grnBody(token2, { po_ref_ext: 'PO-311-SPLIT2', received_qty: 8 }),
      400,
      'RECEIVING_REASON_REQUIRED',
    );
  });

  it('Replay: a resend of the same GRN line with a different reason is a STREAM_CONFLICT', async () => {
    await seedPo('PO-311-RPL', 'SKU-311', 100);
    const token = await seedToken('PO-311-RPL');
    const body = grnBody(token, { po_ref_ext: 'PO-311-RPL', received_qty: 10, ...SHORT_PART });
    assert.strictEqual((await post(body)).status, 201);
    const changed = await post({ ...body, reason_detail: 'SUPPLIER_SHORT_SHIPPED' });
    assert.strictEqual(changed.status, 409, JSON.stringify(changed.body));
    assert.strictEqual(changed.body['error_code'], 'STREAM_CONFLICT');
    const row = await getPool().query('SELECT reason_detail FROM grn_line WHERE grn_line_id = $1', [
      body['grn_line_id'],
    ]);
    assert.strictEqual(row.rows[0]!['reason_detail'], 'PART_DELIVERY_BALANCE_TO_FOLLOW');
  });

  it('Edge door: the same rules and codes apply to an edge upload', async () => {
    await seedPo('PO-311-EDGE', 'SKU-311', 100);
    const token = await seedToken('PO-311-EDGE');
    function envelope(payload: Record<string, unknown>): Record<string, unknown> {
      return {
        event_id: randomUUID(),
        stream_type: 'receiving',
        stream_id: payload['grn_id'],
        event_type: 'goods.received',
        payload,
        metadata: {
          correlation_id: token,
          actor: { user_id: supervisorId, role: 'store_assistant', location_id: siteAId },
          device_id: 'EDGE-RCV-311',
          occurred_at: '2026-09-26T05:00:00.000Z',
        },
        idempotency_key: `grn-edge-311-${randomUUID()}`,
      };
    }
    const refused = grnBody(token, {
      po_ref_ext: 'PO-311-EDGE',
      reason_code: 'OTHER',
      reason_note: 'no photo',
    });
    const r1 = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      envelope(refused),
      storeHeaders,
    );
    assert.strictEqual(r1.status, 400, JSON.stringify(r1.body));
    assert.strictEqual(r1.body['error_code'], 'RECEIVING_OTHER_EVIDENCE_REQUIRED');
    assert.strictEqual(await grnLineCount(refused['grn_line_id'] as string), 0);

    const accepted = grnBody(token, {
      po_ref_ext: 'PO-311-EDGE',
      received_qty: 4,
      ...DAMAGED_TRANSIT,
    });
    const acceptedEnvelope = envelope(accepted);
    const qcBefore = await onHandAt('SKU-311', qcZoneId);
    const r2 = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      acceptedEnvelope,
      storeHeaders,
    );
    assert.strictEqual(r2.status, 201, JSON.stringify(r2.body));
    // An identical resend of the reasoned capture is a duplicate, never a second receipt.
    const dup = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      acceptedEnvelope,
      storeHeaders,
    );
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(await grnLineCount(accepted['grn_line_id'] as string), 1);
    assert.strictEqual(Number(await onHandAt('SKU-311', qcZoneId)) - Number(qcBefore), 4);
    const row = await getPool().query(
      'SELECT line_condition, reason_code, status, target_location_id FROM grn_line WHERE grn_line_id = $1',
      [accepted['grn_line_id']],
    );
    assert.deepStrictEqual(row.rows[0], {
      line_condition: 'DAMAGED',
      reason_code: 'DAMAGED',
      status: 'quarantined',
      target_location_id: qcZoneId,
    });
  });
});

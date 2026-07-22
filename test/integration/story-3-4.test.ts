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

function makeRequest(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
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
  const res = await makeRequest(port, 'POST', '/api/v1/scim/v2/Users', { externalId, email: externalId, displayName: externalId, roles }, SCIM_HEADERS);
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 3.4 Goods Receiving Against ASN or PO', () => {
  let server: Server;
  let port: number;
  let siteAId: string;
  let siteBId: string;
  let qcZoneId: string;
  let dockId: string;
  let storeHeaders: Record<string, string>;
  let storeSiteBHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let supervisorId: string;

  // Directly seeds an open PO + single line (no Epic 4 native PO; mirrors the Story 2.9 projection).
  async function seedPo(poRef: string, sku: string, orderedQty: number, overPct = 5, underPct = 5): Promise<void> {
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3, $3, 1, $4, $5, 'ERP', now())`,
      [poRef, sku, orderedQty, overPct, underPct],
    );
  }

  // Seeds an accepted (or tolerance_breach) weighbridge_event carrying a fresh binding token, at site-A.
  async function seedToken(poRef: string, status: 'accepted' | 'tolerance_breach' = 'accepted'): Promise<string> {
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A', $5, 1, 1000, 1100, 100, $6, 'WB-1', 'MANUAL', $7, '2026-07-23', $8)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, status, supervisorId, randomUUID()],
    );
    return token;
  }

  function grnBody(token: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      grn_id: randomUUID(),
      grn_line_id: randomUUID(),
      correlation_id: token,
      po_ref_ext: 'OVERRIDE-ME',
      line_no: 1,
      source_document: 'PO',
      sku: 'SKU-RCV-1',
      target_location_code: 'RECV-DOCK',
      received_qty: 10,
      ...overrides,
    };
  }

  async function notificationCount(role: string): Promise<number> {
    const r = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'notification.created' AND payload->'target'->>'role' = $1`,
      [role],
    );
    return r.rows[0]!['c'] as number;
  }

  async function onHand(sku: string): Promise<number> {
    const r = await getPool().query(`SELECT COALESCE(SUM(on_hand), 0)::float AS q FROM stock_balance WHERE sku = $1`, [sku]);
    return r.rows[0]!['q'] as number;
  }

  async function seedDoa(transactionType: string, role: string): Promise<void> {
    await getPool().query(
      `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
       VALUES ($1, $2, $3, NULL, NULL, true)`,
      [randomUUID(), role, transactionType],
    );
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/business_stream_config.sql',
      '../../read/projections/location.sql',
      '../../read/projections/instrument_calibration.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/transfer_request.sql',
      '../../read/projections/in_transit.sql',
      '../../read/projections/cycle_count.sql',
      '../../read/projections/physical_verification.sql',
      '../../read/projections/inventory_planning.sql',
      '../../read/projections/replenishment_recommendation.sql',
      '../../read/projections/obsolescence_flag.sql',
      '../../read/projections/ownership_agreement.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/erp_sales_order.sql',
      '../../read/projections/integration_exception.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/putaway_task.sql',
      '../../read/projections/asn.sql',
      '../../read/projections/asn_line.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE asn_line, asn, putaway_task, grn_line, grn, weighbridge_event, gate_event, integration_exception, erp_sync_state, erp_sales_order, erp_purchase_order_line, erp_purchase_order, ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteAId = randomUUID();
    siteBId = randomUUID();
    qcZoneId = randomUUID();
    dockId = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES
         ($1, 'site-A', 'site', NULL, $1, 'general', 'ambient', false, 'active'),
         ($2, 'site-B', 'site', NULL, $2, 'general', 'ambient', false, 'active'),
         ($3, 'ZONE-QC-HOLD', 'zone', $1, $1, 'quarantine', 'ambient', true, 'active'),
         ($4, 'RECV-DOCK', 'zone', $1, $1, 'staging', 'ambient', false, 'active')`,
      [siteAId, siteBId, qcZoneId, dockId],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES
         ('SKU-RCV-1', 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active'),
         ('SKU-RCV-BIS', 'EA', false, false, false, false, true, 'weighted_average', 'production', 'active')`,
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

    await provisionUser(port, 'store-assistant-3-4@example.com', [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
    ]);
    storeHeaders = await authFor(port, 'store-assistant-3-4@example.com');

    await provisionUser(port, 'store-assistant-b-3-4@example.com', [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteBId },
    ]);
    storeSiteBHeaders = await authFor(port, 'store-assistant-b-3-4@example.com');

    supervisorId = await provisionUser(port, 'unloading-supervisor-3-4@example.com', [
      { role: 'unloading_supervisor', module: 'receiving', functionScope: 'write', locationId: siteAId },
    ]);

    await provisionUser(port, 'warehouse-manager-3-4@example.com', [
      { role: 'warehouse_manager', module: 'receiving', functionScope: 'write', locationId: '*' },
    ]);
    managerHeaders = await authFor(port, 'warehouse-manager-3-4@example.com');

    await provisionUser(port, 'inventory-controller-3-4@example.com', [
      { role: 'inventory_controller', module: 'receiving', functionScope: 'read', locationId: siteAId },
    ]);
    readerHeaders = await authFor(port, 'inventory-controller-3-4@example.com');

    // AC3 held-putaway release band (seeded up front); the AC7 quarantine band is seeded mid-test.
    await seedDoa('receiving.putaway_release', 'unloading_supervisor');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: accepted-token receipt posts a GRN line, stock, and a ready putaway task', async () => {
    await seedPo('PO-A1', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-A1');
    const before = await onHand('SKU-RCV-1');
    const body = grnBody(token, { po_ref_ext: 'PO-A1', received_qty: 10, lot_id: 'LOT-A1', expiry_date: '2027-01-01' });
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['status'], 'posted');
    assert.strictEqual(line['lot_id'], 'LOT-A1');
    assert.strictEqual(line['received_qty'], '10.000');
    const putaway = res.body['putaway_task'] as Record<string, unknown>;
    assert.strictEqual(putaway['status'], 'ready');
    assert.strictEqual(putaway['from_location_id'], dockId);
    assert.strictEqual(await onHand('SKU-RCV-1'), before + 10);
  });

  it('AC2: ASN intake pre-populates and the confirmed GRN header records source_document ASN', async () => {
    await seedPo('PO-A2', 'SKU-RCV-1', 100);
    const asnNumber = `ASN-${randomUUID()}`;
    const intake = await makeRequest(
      port,
      'POST',
      '/api/v1/asn',
      { asn_number_ext: asnNumber, po_ref_ext: 'PO-A2', site_code_ext: 'site-A', lines: [{ line_no: 1, sku: 'SKU-RCV-1', expected_qty: 20 }] },
      storeHeaders,
    );
    assert.strictEqual(intake.status, 201, JSON.stringify(intake.body));

    const read = await makeRequest(port, 'GET', `/api/v1/asn/${asnNumber}`, undefined, storeHeaders);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const asnLines = read.body['lines'] as Record<string, unknown>[];
    assert.strictEqual(asnLines[0]!['sku'], 'SKU-RCV-1');
    assert.strictEqual(asnLines[0]!['expected_qty'], '20.000');

    const token = await seedToken('PO-A2');
    const body = grnBody(token, { po_ref_ext: 'PO-A2', received_qty: 20, source_document: 'ASN', source_ref_ext: asnNumber });
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const grn = res.body['grn'] as Record<string, unknown>;
    assert.strictEqual(grn['source_document'], 'ASN');
    assert.strictEqual(grn['source_ref_ext'], asnNumber);
  });

  it('AC2: ASN intake against an unknown PO rejects ASN_PO_NOT_FOUND', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/asn',
      { asn_number_ext: `ASN-${randomUUID()}`, po_ref_ext: 'PO-NOPE', site_code_ext: 'site-A', lines: [{ line_no: 1, sku: 'SKU-RCV-1', expected_qty: 5 }] },
      storeHeaders,
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ASN_PO_NOT_FOUND');
  });

  it('AC3: BIS-flagged item routes to ZONE-QC-HOLD with a held putaway task and a DOA-gated manual release', async () => {
    await seedPo('PO-BIS', 'SKU-RCV-BIS', 50);
    const token = await seedToken('PO-BIS');
    const beforeQc = await notificationCount('qc_inspector');
    const body = grnBody(token, { po_ref_ext: 'PO-BIS', sku: 'SKU-RCV-BIS', received_qty: 10 });
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const line = res.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['qc_hold'], true);
    assert.strictEqual(line['target_location_id'], qcZoneId);
    const putaway = res.body['putaway_task'] as Record<string, unknown>;
    assert.strictEqual(putaway['status'], 'held');
    assert.strictEqual(putaway['from_location_id'], qcZoneId);
    assert.strictEqual(await notificationCount('qc_inspector'), beforeQc + 1);

    const putawayId = putaway['putaway_task_id'] as string;
    // A store assistant cannot release a held task (endpoint is supervisor-only).
    const denied = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${putawayId}/release`, { reason_code: 'QC_PASSED' }, storeHeaders);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));

    const released = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${putawayId}/release`, { reason_code: 'QC_PASSED' }, managerHeaders);
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
    assert.strictEqual(released.body['status'], 'ready');
    assert.strictEqual(released.body['release_reason_code'], 'QC_PASSED');
  });

  it('AC4: an off-PO barcode rejects ITEM_PO_MISMATCH with no stock and no durable line', async () => {
    await seedPo('PO-A4', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-A4');
    const before = await onHand('SKU-RCV-1');
    const grnLineId = randomUUID();
    const body = grnBody(token, { grn_line_id: grnLineId, po_ref_ext: 'PO-A4', sku: 'SKU-OFFPO', received_qty: 5 });
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ITEM_PO_MISMATCH');
    assert.strictEqual(await onHand('SKU-RCV-1'), before);
    const line = await getPool().query('SELECT count(*)::int AS c FROM grn_line WHERE grn_line_id = $1', [grnLineId]);
    assert.strictEqual(line.rows[0]!['c'], 0);
  });

  it('AC5/C1: over-tolerance yields a committed rejected line + surviving discrepancy notification, no stock', async () => {
    await seedPo('PO-A5', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-A5');
    const before = await onHand('SKU-RCV-1');
    const beforeNotif = await notificationCount('unloading_supervisor');
    const grnLineId = randomUUID();
    const body = grnBody(token, { grn_line_id: grnLineId, po_ref_ext: 'PO-A5', received_qty: 200 });
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RECEIPT_TOLERANCE_EXCEEDED');
    assert.strictEqual((res.body['grn_line'] as Record<string, unknown>)['status'], 'rejected');
    assert.strictEqual(await onHand('SKU-RCV-1'), before);
    // No putaway task for a rejected line; the discrepancy notification survives (was NOT rolled back).
    const putaway = await getPool().query('SELECT count(*)::int AS c FROM putaway_task WHERE grn_line_id = $1', [grnLineId]);
    assert.strictEqual(putaway.rows[0]!['c'], 0);
    assert.strictEqual(await notificationCount('unloading_supervisor'), beforeNotif + 1);
  });

  it('H1: two concurrent receipts on the same PO line cannot both pass the tolerance band', async () => {
    await seedPo('PO-H1', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-H1');
    const [a, b] = await Promise.all([
      makeRequest(port, 'POST', '/api/v1/grn-lines', grnBody(token, { po_ref_ext: 'PO-H1', received_qty: 60 }), storeHeaders),
      makeRequest(port, 'POST', '/api/v1/grn-lines', grnBody(token, { po_ref_ext: 'PO-H1', received_qty: 60 }), storeHeaders),
    ]);
    const rejected = [a, b].filter((r) => r.body['error_code'] === 'RECEIPT_TOLERANCE_EXCEEDED');
    assert.strictEqual(rejected.length, 1, `exactly one of two 60-unit receipts must reject: ${JSON.stringify([a.body, b.body])}`);
  });

  it('AC6: short-within-tolerance posts with a shortage variance visible in the discrepancy view', async () => {
    await seedPo('PO-A6', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-A6');
    const grnLineId = randomUUID();
    const body = grnBody(token, { grn_line_id: grnLineId, po_ref_ext: 'PO-A6', received_qty: 96 });
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', body, storeHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((res.body['grn_line'] as Record<string, unknown>)['shortage_variance_qty'], '4.000');

    const disc = await makeRequest(port, 'GET', '/api/v1/receiving/discrepancies?site=site-A', undefined, readerHeaders);
    assert.strictEqual(disc.status, 200, JSON.stringify(disc.body));
    const rows = disc.body['discrepancies'] as Record<string, unknown>[];
    assert.ok(rows.some((r) => r['grn_line_id'] === grnLineId), 'short line must appear in the discrepancy view');
  });

  it('AC7: LOT_EXPIRED, then APPROVAL_REQUIRED without a DOA band, then a DOA-approved quarantine into ZONE-QC-HOLD', async () => {
    await seedPo('PO-A7', 'SKU-RCV-1', 100);
    const token1 = await seedToken('PO-A7');
    const expired = await makeRequest(port, 'POST', '/api/v1/grn-lines', grnBody(token1, { po_ref_ext: 'PO-A7', received_qty: 10, lot_id: 'LOT-EXP', expiry_date: '2020-01-01' }), storeHeaders);
    assert.strictEqual(expired.status, 400, JSON.stringify(expired.body));
    assert.strictEqual(expired.body['error_code'], 'LOT_EXPIRED');

    // quarantine_approved with no governing DOA band yet -> APPROVAL_REQUIRED.
    const token2 = await seedToken('PO-A7');
    const unapproved = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      grnBody(token2, { po_ref_ext: 'PO-A7', received_qty: 10, lot_id: 'LOT-EXP2', expiry_date: '2020-01-01', quarantine_approved: true, quarantine_reason_code: 'EXPIRED_HOLD' }),
      storeHeaders,
    );
    assert.strictEqual(unapproved.status, 403, JSON.stringify(unapproved.body));
    assert.strictEqual(unapproved.body['error_code'], 'APPROVAL_REQUIRED');

    // Seed the DOA band; the resolvable unloading_supervisor holder authorizes the quarantine receipt.
    await seedDoa('receiving.quarantine', 'unloading_supervisor');
    const token3 = await seedToken('PO-A7');
    const approved = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      grnBody(token3, { po_ref_ext: 'PO-A7', received_qty: 10, lot_id: 'LOT-EXP3', expiry_date: '2020-01-01', quarantine_approved: true, quarantine_reason_code: 'EXPIRED_HOLD' }),
      storeHeaders,
    );
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    const line = approved.body['grn_line'] as Record<string, unknown>;
    assert.strictEqual(line['status'], 'quarantined');
    assert.strictEqual(line['target_location_id'], qcZoneId);
  });

  it('AC1 chain: RECEIVING_WEIGHT_NOT_ACCEPTED when the token has only a tolerance_breach weighment', async () => {
    await seedPo('PO-BR', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-BR', 'tolerance_breach');
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', grnBody(token, { po_ref_ext: 'PO-BR', received_qty: 10 }), storeHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RECEIVING_WEIGHT_NOT_ACCEPTED');
  });

  it('RECEIVING_BINDING_TOKEN_NOT_FOUND for a token with no weighbridge event', async () => {
    await seedPo('PO-NT', 'SKU-RCV-1', 100);
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', grnBody(randomUUID(), { po_ref_ext: 'PO-NT', received_qty: 10 }), storeHeaders);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RECEIVING_BINDING_TOKEN_NOT_FOUND');
  });

  it('Idempotent replay of the same goods.received (same grn_line_id) posts stock exactly once', async () => {
    await seedPo('PO-IDEM', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-IDEM');
    const before = await onHand('SKU-RCV-1');
    const envelope = {
      event_id: randomUUID(),
      stream_type: 'receiving',
      stream_id: randomUUID(),
      event_type: 'goods.received',
      payload: grnBody(token, { po_ref_ext: 'PO-IDEM', received_qty: 10 }),
      metadata: { correlation_id: token, actor: { user_id: supervisorId, role: 'store_assistant', location_id: siteAId }, device_id: 'EDGE-RCV-1', occurred_at: '2026-07-23T05:00:00.000Z' },
      idempotency_key: `grn-edge-${randomUUID()}`,
    };
    (envelope.payload as Record<string, unknown>)['grn_id'] = envelope.stream_id;
    const first = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, storeHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const dup = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, storeHeaders);
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(await onHand('SKU-RCV-1'), before + 10);
  });

  it('RBAC: store_assistant create is site-scoped; an out-of-scope site is rejected', async () => {
    await seedPo('PO-RBAC', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-RBAC');
    const res = await makeRequest(port, 'POST', '/api/v1/grn-lines', grnBody(token, { po_ref_ext: 'PO-RBAC', received_qty: 10 }), storeSiteBHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('the receiving seam never writes any erp_* projection', async () => {
    await seedPo('PO-ERP', 'SKU-RCV-1', 100);
    const token = await seedToken('PO-ERP');
    const beforeLine = await getPool().query('SELECT count(*)::int AS c, COALESCE(SUM(open_qty),0)::float AS q FROM erp_purchase_order_line');
    await makeRequest(port, 'POST', '/api/v1/grn-lines', grnBody(token, { po_ref_ext: 'PO-ERP', received_qty: 10 }), storeHeaders);
    const afterLine = await getPool().query('SELECT count(*)::int AS c, COALESCE(SUM(open_qty),0)::float AS q FROM erp_purchase_order_line');
    assert.strictEqual(afterLine.rows[0]!['c'], beforeLine.rows[0]!['c']);
    assert.strictEqual(afterLine.rows[0]!['q'], beforeLine.rows[0]!['q']);
  });
});

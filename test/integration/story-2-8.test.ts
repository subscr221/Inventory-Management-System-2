import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.8: Consignment and VMI Stock Segregation. Runs against the PRODUCTION router surface
// with real auth, RBAC, and PostgreSQL; the suite runs serially (--test-concurrency=1).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const BUSINESS_DATE = '2026-07-22';

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
  const res = await makeRequest(port, 'POST', '/api/v1/scim/v2/Users', { externalId, email: externalId, displayName: externalId, roles }, SCIM_HEADERS);
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 2.8 Consignment and VMI Stock Segregation', () => {
  let server: Server;
  let port: number;
  let plannerHeaders: Record<string, string>;
  let scopedPlannerHeaders: Record<string, string>;
  let warehouseWriterHeaders: Record<string, string>;
  let plannerUserId: string;
  let locAId: string;
  let locBId: string;

  before(async () => {
    const adminPool = getAdminPool();
    await adminPool.query('TRUNCATE ownership_agreement CASCADE').catch(() => undefined);
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE ownership_agreement, obsolescence_flag, replenishment_recommendation, inventory_planning_params, physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    const ids: string[] = [];
    for (const code of ['LOC-2-8-A', 'LOC-2-8-B']) {
      const r = await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
        [randomUUID(), code, randomUUID()],
      );
      ids.push(r.rows[0]!['location_id'] as string);
    }
    [locAId, locBId] = ids as [string, string];

    plannerUserId = await provisionUser(port, 'planner-2-8@example.com', [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'inventory_planner', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, 'planner-2-8@example.com');

    await provisionUser(port, 'scoped-planner-2-8@example.com', [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: locAId },
      { role: 'inventory_planner', module: 'inventory', functionScope: 'read', locationId: locAId },
    ]);
    scopedPlannerHeaders = await authFor(port, 'scoped-planner-2-8@example.com');

    await provisionUser(port, 'warehouse-writer-2-8@example.com', [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: locAId },
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'read', locationId: locAId },
    ]);
    warehouseWriterHeaders = await authFor(port, 'warehouse-writer-2-8@example.com');
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- helpers -------------------------------------------------------------

  async function seedItem(sku: string): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
  }

  async function postStockEvent(eventType: string, payload: Record<string, unknown>, eventId?: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        ...(eventId ? { event_id: eventId } : {}),
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: eventType,
        payload: { business_stream: 'production', ...payload },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: locAId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
  }

  async function putAgreement(sku: string, locationId: string, stockClass: string, body: Record<string, unknown>, headers = plannerHeaders): Promise<HttpResult> {
    return makeRequest(port, 'PUT', `/api/v1/ownership-agreements/${sku}/${locationId}/${stockClass}`, body, headers);
  }

  async function getStock(sku: string): Promise<Record<string, unknown>> {
    const res = await makeRequest(port, 'GET', `/api/v1/stock/${sku}`, undefined, plannerHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  function classEntry(stock: Record<string, unknown>, locationId: string, stockClass: string): Record<string, unknown> | undefined {
    const locations = stock['locations'] as Array<Record<string, unknown>>;
    const loc = locations.find((l) => l['location_id'] === locationId);
    if (!loc) return undefined;
    return (loc['classes'] as Array<Record<string, unknown>>).find((c) => c['stock_class'] === stockClass);
  }

  // --- AC1: consignment receipt segregated with supplier reference --------

  it('AC1: a consignment receipt lands under stock_class consignment with the supplier reference and leaves owned unchanged', async () => {
    const sku = 'RM-0099-A';
    await seedItem(sku);
    const created = await putAgreement(sku, locAId, 'consignment', { owner_party_code: 'SUP-007', business_stream: 'production' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body['owner_party_code'], 'SUP-007');
    assert.strictEqual(created.body['active'], true);

    const ownedReceipt = await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 40, unit_cost: 5 });
    assert.strictEqual(ownedReceipt.status, 201, JSON.stringify(ownedReceipt.body));
    const consignmentReceipt = await postStockEvent('stock.received', {
      sku,
      target_location_id: locAId,
      quantity: 100,
      stock_class: 'consignment',
      owner_party_code: 'SUP-007',
    });
    assert.strictEqual(consignmentReceipt.status, 201, JSON.stringify(consignmentReceipt.body));

    const stock = await getStock(sku);
    assert.strictEqual((stock['consolidated'] as Record<string, unknown>)['on_hand'], 40);
    const location = (stock['locations'] as Array<Record<string, unknown>>).find((l) => l['location_id'] === locAId)!;
    assert.strictEqual(location['on_hand'], 40);
    const owned = classEntry(stock, locAId, 'owned');
    const consignment = classEntry(stock, locAId, 'consignment');
    assert.ok(owned, 'owned class entry missing');
    assert.ok(consignment, 'consignment class entry missing');
    assert.strictEqual(owned!['on_hand'], 40);
    assert.strictEqual(owned!['owner_party_code'], null);
    assert.strictEqual(consignment!['on_hand'], 100);
    assert.strictEqual(consignment!['owner_party_code'], 'SUP-007');
    const byClass = stock['consolidated_by_class'] as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      byClass.map((c) => [c['stock_class'], c['on_hand']]),
      [
        ['consignment', 100],
        ['owned', 40],
      ],
    );
  });

  it('AC1 guard: a consignment receipt without an active agreement is rejected OWNERSHIP_AGREEMENT_NOT_FOUND', async () => {
    const sku = 'RM-0099-NOAGR';
    await seedItem(sku);
    const res = await postStockEvent('stock.received', {
      sku,
      target_location_id: locAId,
      quantity: 10,
      stock_class: 'consignment',
      owner_party_code: 'SUP-007',
    });
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'OWNERSHIP_AGREEMENT_NOT_FOUND');
    const stock = await getStock(sku);
    assert.strictEqual((stock['locations'] as unknown[]).length, 0);
  });

  it('AC1 guard: a consignment receipt naming the wrong owner party is rejected OWNER_PARTY_MISMATCH', async () => {
    const sku = 'RM-0099-A';
    const res = await postStockEvent('stock.received', {
      sku,
      target_location_id: locAId,
      quantity: 10,
      stock_class: 'consignment',
      owner_party_code: 'SUP-999',
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'OWNER_PARTY_MISMATCH');
  });

  it('AC1 guard: a consignment receipt without owner_party_code fails shape validation', async () => {
    const sku = 'RM-0099-A';
    const res = await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 10, stock_class: 'consignment' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('job_work receipts stay outside the ownership gate (Epic 9 flow untouched)', async () => {
    const sku = 'RM-0099-JW';
    await seedItem(sku);
    const res = await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 5, stock_class: 'job_work' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stock = await getStock(sku);
    assert.strictEqual(classEntry(stock, locAId, 'job_work')!['on_hand'], 5);
  });

  // --- AC2: classless issues draw owned only ------------------------------

  it('AC2: an issue without stock_class draws from owned stock only', async () => {
    const sku = 'RM-0099-A';
    const res = await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 30 });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stock = await getStock(sku);
    assert.strictEqual(classEntry(stock, locAId, 'owned')!['on_hand'], 10);
    assert.strictEqual(classEntry(stock, locAId, 'consignment')!['on_hand'], 100);
  });

  it('AC2 guard: a classless issue larger than owned availability is INSUFFICIENT_STOCK even when consignment stock could cover it', async () => {
    const sku = 'RM-0099-A';
    // owned = 10, consignment = 100: a classless issue of 50 must NOT touch consignment.
    const res = await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 50 });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    const details = res.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['stock_class'], 'owned');
    const stock = await getStock(sku);
    assert.strictEqual(classEntry(stock, locAId, 'owned')!['on_hand'], 10);
    assert.strictEqual(classEntry(stock, locAId, 'consignment')!['on_hand'], 100);
  });

  it('AC2 transfer regression: lot-less owned transfer does not mark consignment in_transit', async () => {
    const sku = 'RM-0099-XFER';
    await seedItem(sku);
    assert.strictEqual((await putAgreement(sku, locAId, 'consignment', { owner_party_code: 'SUP-055', business_stream: 'production' })).status, 201);
    assert.strictEqual((await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 20 })).status, 201);
    assert.strictEqual(
      (await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 20, stock_class: 'consignment', owner_party_code: 'SUP-055' })).status,
      201,
    );
    const transferRequestId = randomUUID();
    assert.strictEqual(
      (await postStockEvent('transfer_request.created', {
        transfer_request_id: transferRequestId,
        sku_id: sku,
        quantity: 5,
        from_location_id: locAId,
        to_location_id: locBId,
        status: 'pending_shipment',
      })).status,
      201,
    );
    assert.strictEqual(
      (await postStockEvent('transfer_ship.created', {
        transfer_request_id: transferRequestId,
        lot_id: 'SHIP-LOT-XFER',
        shipped_quantity: 5,
        correlation_id: randomUUID(),
      })).status,
      201,
    );
    const stock = await getStock(sku);
    assert.strictEqual(classEntry(stock, locAId, 'owned')!['in_transit'], 5);
    assert.strictEqual(classEntry(stock, locAId, 'consignment')!['in_transit'], 0);
  });

  // --- AC5: class-scoped INSUFFICIENT_STOCK -------------------------------

  it('AC5: a consignment issue exceeding consignment on-hand is rejected INSUFFICIENT_STOCK without drawing owned stock', async () => {
    const sku = 'RM-0099-A';
    const res = await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 120, stock_class: 'consignment' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    const details = res.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['stock_class'], 'consignment');
    assert.strictEqual(details['available_quantity'], 100);
    const stock = await getStock(sku);
    assert.strictEqual(classEntry(stock, locAId, 'owned')!['on_hand'], 10);
    assert.strictEqual(classEntry(stock, locAId, 'consignment')!['on_hand'], 100);
  });

  it('AC5: an explicit consignment issue within availability drains consignment only', async () => {
    const sku = 'RM-0099-A';
    const res = await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 60, stock_class: 'consignment' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stock = await getStock(sku);
    assert.strictEqual(classEntry(stock, locAId, 'owned')!['on_hand'], 10);
    assert.strictEqual(classEntry(stock, locAId, 'consignment')!['on_hand'], 40);
  });

  // --- AC4: valuation covers owned units only -----------------------------

  it('AC4: valuation carrying value covers owned units only; consignment units report at zero value in non_owned_quantities', async () => {
    const sku = 'RM-0099-VAL';
    await seedItem(sku);
    const agr = await putAgreement(sku, locAId, 'consignment', { owner_party_code: 'SUP-007', business_stream: 'production' });
    assert.strictEqual(agr.status, 201, JSON.stringify(agr.body));
    assert.strictEqual((await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 40, unit_cost: 5 })).status, 201);
    assert.strictEqual(
      (await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 100, stock_class: 'consignment', owner_party_code: 'SUP-007' })).status,
      201,
    );

    const res = await makeRequest(port, 'GET', `/api/v1/stock/${sku}/valuation`, undefined, plannerHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['quantity_on_hand'], 40);
    assert.strictEqual(res.body['carrying_value'], 200);
    const nonOwned = res.body['non_owned_quantities'] as Array<Record<string, unknown>>;
    assert.strictEqual(nonOwned.length, 1);
    assert.strictEqual(nonOwned[0]!['stock_class'], 'consignment');
    assert.strictEqual(nonOwned[0]!['quantity_on_hand'], 100);
    assert.strictEqual(nonOwned[0]!['carrying_value_contribution'], 0);
    assert.deepStrictEqual(nonOwned[0]!['owner_party_codes'], ['SUP-007']);
  });

  // --- AC3: VMI replenishment signal --------------------------------------

  it('AC3: vmi stock below the agreed minimum produces a vmi_replenishment signal carrying the owner party, visible in the exception queue', async () => {
    const sku = 'RM-0099-VMI';
    await seedItem(sku);
    const agr = await putAgreement(sku, locAId, 'vmi', { owner_party_code: 'SUP-042', vmi_min_qty: 50, business_stream: 'production' });
    assert.strictEqual(agr.status, 201, JSON.stringify(agr.body));
    assert.strictEqual(
      (await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 30, stock_class: 'vmi', owner_party_code: 'SUP-042' })).status,
      201,
    );

    const check = await makeRequest(port, 'POST', '/api/v1/planning/vmi/check', { business_date: BUSINESS_DATE, sku }, plannerHeaders);
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    const recommended = check.body['recommended'] as Array<Record<string, unknown>>;
    assert.strictEqual(recommended.length, 1);
    assert.strictEqual(recommended[0]!['owner_party_code'], 'SUP-042');
    assert.strictEqual(recommended[0]!['recommended_order_qty'], 20);

    const queue = await makeRequest(port, 'GET', `/api/v1/planning/replenishment/recommendations?sku=${sku}&signal_type=vmi_replenishment`, undefined, plannerHeaders);
    assert.strictEqual(queue.status, 200, JSON.stringify(queue.body));
    const rows = queue.body['recommendations'] as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['signal_type'], 'vmi_replenishment');
    assert.strictEqual(rows[0]!['owner_party_code'], 'SUP-042');
    assert.strictEqual(rows[0]!['status'], 'open');
    assert.strictEqual(rows[0]!['reorder_point'], 50);

    // Planner exception alert committed with the signal.
    const alert = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1 AND payload->>'event_type' = 'vmi_replenishment_recommended'`,
      [sku],
    );
    assert.strictEqual(alert.rows[0]!['c'], 1);
  });

  it('AC3 idempotency: re-running the vmi check over unchanged state produces no duplicate open signal or alert', async () => {
    const sku = 'RM-0099-VMI';
    const again = await makeRequest(port, 'POST', '/api/v1/planning/vmi/check', { business_date: BUSINESS_DATE, sku }, plannerHeaders);
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual((again.body['recommended'] as unknown[]).length, 0);
    const open = await getPool().query(
      `SELECT count(*)::int AS c FROM replenishment_recommendation WHERE sku = $1 AND status = 'open' AND signal_type = 'vmi_replenishment'`,
      [sku],
    );
    assert.strictEqual(open.rows[0]!['c'], 1);
  });

  it('AC3 coexistence: an open internal signal and an open vmi signal share a grain without conflict', async () => {
    const sku = 'RM-0099-VMI';
    const internal = await postStockEvent('replenishment.recommended', {
      recommendation_id: randomUUID(),
      sku,
      location_id: locAId,
      on_hand_at_check: 30,
      reorder_point: 25,
      recommended_order_qty: 100,
      triggered_at: new Date().toISOString(),
      business_date: BUSINESS_DATE,
    });
    assert.strictEqual(internal.status, 201, JSON.stringify(internal.body));
    const open = await getPool().query(
      `SELECT signal_type, count(*)::int AS c FROM replenishment_recommendation
       WHERE sku = $1 AND status = 'open' GROUP BY signal_type ORDER BY signal_type`,
      [sku],
    );
    assert.deepStrictEqual(
      open.rows.map((r) => [r['signal_type'], r['c']]),
      [
        ['internal', 1],
        ['vmi_replenishment', 1],
      ],
    );
  });

  it('AC3 threshold: at-or-above the vmi minimum no signal is produced', async () => {
    const sku = 'RM-0099-VMI-OK';
    await seedItem(sku);
    assert.strictEqual((await putAgreement(sku, locAId, 'vmi', { owner_party_code: 'SUP-042', vmi_min_qty: 50, business_stream: 'production' })).status, 201);
    assert.strictEqual(
      (await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 50, stock_class: 'vmi', owner_party_code: 'SUP-042' })).status,
      201,
    );
    const check = await makeRequest(port, 'POST', '/api/v1/planning/vmi/check', { business_date: BUSINESS_DATE, sku }, plannerHeaders);
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    assert.strictEqual((check.body['recommended'] as unknown[]).length, 0);
  });

  it('AC3 fail-closed: an active vmi agreement without a minimum is rejected with VMI_MIN_NOT_CONFIGURED', async () => {
    const sku = 'RM-0099-VMI-NOMIN';
    await seedItem(sku);
    const created = await putAgreement(sku, locAId, 'vmi', { owner_party_code: 'SUP-042', business_stream: 'production' });
    assert.strictEqual(created.status, 400, JSON.stringify(created.body));
    assert.strictEqual(created.body['error_code'], 'VMI_MIN_NOT_CONFIGURED');
  });

  it('AC3 concurrency: concurrent vmi checks produce exactly one open signal and one alert', async () => {
    const sku = 'RM-0099-VMI-RACE';
    await seedItem(sku);
    assert.strictEqual((await putAgreement(sku, locAId, 'vmi', { owner_party_code: 'SUP-044', vmi_min_qty: 50, business_stream: 'production' })).status, 201);
    assert.strictEqual(
      (await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 30, stock_class: 'vmi', owner_party_code: 'SUP-044' })).status,
      201,
    );

    const checks = await Promise.all([
      makeRequest(port, 'POST', '/api/v1/planning/vmi/check', { business_date: BUSINESS_DATE, sku }, plannerHeaders),
      makeRequest(port, 'POST', '/api/v1/planning/vmi/check', { business_date: BUSINESS_DATE, sku }, plannerHeaders),
    ]);
    for (const check of checks) assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    assert.strictEqual(checks.reduce((sum, check) => sum + ((check.body['recommended'] as unknown[]).length), 0), 1);
    const open = await getPool().query(
      `SELECT count(*)::int AS c FROM replenishment_recommendation WHERE sku = $1 AND status = 'open' AND signal_type = 'vmi_replenishment'`,
      [sku],
    );
    assert.strictEqual(open.rows[0]!['c'], 1);
    const alert = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1 AND payload->>'event_type' = 'vmi_replenishment_recommended'`,
      [sku],
    );
    assert.strictEqual(alert.rows[0]!['c'], 1);
  });

  // --- agreement config contract ------------------------------------------

  it('agreement partial edits preserve omitted config', async () => {
    const sku = 'RM-0099-VMI';
    const edited = await putAgreement(sku, locAId, 'vmi', { vmi_min_qty: 60, business_stream: 'production' });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    assert.strictEqual(edited.body['owner_party_code'], 'SUP-042');
    assert.strictEqual(edited.body['vmi_min_qty'], 60);
    assert.strictEqual(edited.body['active'], true);
  });

  it('agreement shape guards: malformed owner code and misplaced vmi_min_qty are rejected', async () => {
    const sku = 'RM-0099-A';
    const badCode = await putAgreement(sku, locAId, 'consignment', { owner_party_code: 'sup 7!', business_stream: 'production' });
    assert.strictEqual(badCode.status, 400, JSON.stringify(badCode.body));
    const minOnConsignment = await putAgreement(sku, locAId, 'consignment', { vmi_min_qty: 10, business_stream: 'production' });
    assert.strictEqual(minOnConsignment.status, 400, JSON.stringify(minOnConsignment.body));
    const badClass = await putAgreement(sku, locAId, 'owned', { owner_party_code: 'SUP-007', business_stream: 'production' });
    assert.strictEqual(badClass.status, 400, JSON.stringify(badClass.body));
  });

  it('agreement owner code is trimmed before validation and persistence', async () => {
    const sku = 'RM-0099-TRIM';
    await seedItem(sku);
    const created = await putAgreement(sku, locAId, 'consignment', { owner_party_code: ' SUP-TRIM ', business_stream: 'production' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body['owner_party_code'], 'SUP-TRIM');
  });

  it('agreement creation rejects unknown locations', async () => {
    const sku = 'RM-0099-BADLOC';
    await seedItem(sku);
    const created = await putAgreement(sku, randomUUID(), 'consignment', { owner_party_code: 'SUP-007', business_stream: 'production' });
    assert.strictEqual(created.status, 400, JSON.stringify(created.body));
    assert.strictEqual(created.body['error_code'], 'LOCATION_NOT_FOUND');
  });

  it('agreement idempotency: replaying the same event_id applies the projection once', async () => {
    const sku = 'RM-0099-IDEM';
    await seedItem(sku);
    const eventId = randomUUID();
    const agreementId = randomUUID();
    const payload = {
      agreement_id: agreementId,
      sku,
      location_id: locAId,
      stock_class: 'consignment',
      owner_party_code: 'SUP-011',
      set_by_actor_id: plannerUserId,
    };
    const first = await postStockEvent('ownership.agreement_set', payload, eventId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await postStockEvent('ownership.agreement_set', payload, eventId);
    assert.strictEqual(replay.status, 409, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['error_code'], 'DUPLICATE_EVENT');
    const rows = await getPool().query(`SELECT count(*)::int AS c FROM ownership_agreement WHERE sku = $1`, [sku]);
    assert.strictEqual(rows.rows[0]!['c'], 1);
  });

  // --- RBAC and location scoping ------------------------------------------

  it('RBAC: agreement writes require write access and planning-config role on the HTTP handler and the direct event path', async () => {
    const sku = 'RM-0099-RBAC';
    await seedItem(sku);
    const viaRole = await putAgreement(sku, locAId, 'consignment', { owner_party_code: 'SUP-007', business_stream: 'production' }, warehouseWriterHeaders);
    assert.strictEqual(viaRole.status, 403, JSON.stringify(viaRole.body));
    assert.strictEqual(viaRole.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const viaHandler = await putAgreement(sku, locBId, 'consignment', { owner_party_code: 'SUP-007', business_stream: 'production' }, scopedPlannerHeaders);
    assert.strictEqual(viaHandler.status, 403, JSON.stringify(viaHandler.body));
    assert.strictEqual(viaHandler.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const viaEventsRole = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'ownership.agreement_set',
        payload: {
          business_stream: 'production',
          agreement_id: randomUUID(),
          sku,
          location_id: locAId,
          stock_class: 'consignment',
          owner_party_code: 'SUP-007',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'warehouse_operator', location_id: locAId },
          occurred_at: new Date().toISOString(),
        },
      },
      warehouseWriterHeaders,
    );
    assert.strictEqual(viaEventsRole.status, 403, JSON.stringify(viaEventsRole.body));
    assert.strictEqual(viaEventsRole.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const viaEvents = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'ownership.agreement_set',
        payload: {
          business_stream: 'production',
          agreement_id: randomUUID(),
          sku,
          location_id: locBId,
          stock_class: 'consignment',
          owner_party_code: 'SUP-007',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: locAId },
          occurred_at: new Date().toISOString(),
        },
      },
      scopedPlannerHeaders,
    );
    assert.strictEqual(viaEvents.status, 403, JSON.stringify(viaEvents.body));
    assert.strictEqual(viaEvents.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('scoping: the agreement list requires a planning-config role and is filtered to the caller-visible locations', async () => {
    const sku = 'RM-0099-SCOPE';
    await seedItem(sku);
    assert.strictEqual((await putAgreement(sku, locAId, 'consignment', { owner_party_code: 'SUP-021', business_stream: 'production' })).status, 201);
    assert.strictEqual((await putAgreement(sku, locBId, 'consignment', { owner_party_code: 'SUP-022', business_stream: 'production' })).status, 201);

    const deniedRole = await makeRequest(port, 'GET', `/api/v1/ownership-agreements?sku=${sku}`, undefined, warehouseWriterHeaders);
    assert.strictEqual(deniedRole.status, 403, JSON.stringify(deniedRole.body));
    assert.strictEqual(deniedRole.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const scoped = await makeRequest(port, 'GET', `/api/v1/ownership-agreements?sku=${sku}`, undefined, scopedPlannerHeaders);
    assert.strictEqual(scoped.status, 200, JSON.stringify(scoped.body));
    const rows = scoped.body['agreements'] as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['location_id'], locAId);

    const denied = await makeRequest(port, 'GET', `/api/v1/ownership-agreements?sku=${sku}&location_id=${locBId}`, undefined, scopedPlannerHeaders);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
  });
});

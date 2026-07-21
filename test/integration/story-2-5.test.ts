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

// Story 2.5: inter-location transfer requests. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, and PostgreSQL. Tests run serially
// (npm test uses --test-concurrency=1) and seed their own SKUs/lots/stock for isolation.

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
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 2.5 Inter-Location Transfer Requests Integration Tests', () => {
  let server: Server;
  let port: number;
  let warehouseHeaders: Record<string, string>; // create + ship + receive at A and B
  let logisticsHeaders: Record<string, string>; // create only
  let readerHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>; // warehouse_manager at C only
  let approverUserId: string;
  let locAId: string; // source
  let locBId: string; // destination
  let locCId: string; // unrelated

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
      '../../read/projections/transfer_request.sql',
      '../../read/projections/in_transit.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE in_transit, transfer_request, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    // Three locations.
    const ids: string[] = [];
    for (const code of ['LOC-2-5-A', 'LOC-2-5-B', 'LOC-2-5-C']) {
      const r = await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
        [randomUUID(), code, randomUUID()],
      );
      ids.push(r.rows[0]!['location_id'] as string);
    }
    [locAId, locBId, locCId] = ids as [string, string, string];

    // Users / roles.
    await provisionUser(port, 'wh-2-5@example.com', [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: locAId },
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: locBId },
    ]);
    warehouseHeaders = await authFor(port, 'wh-2-5@example.com');

    await provisionUser(port, 'logi-2-5@example.com', [
      { role: 'logistics_manager', module: 'inventory', functionScope: 'write', locationId: locAId },
    ]);
    logisticsHeaders = await authFor(port, 'logi-2-5@example.com');

    await provisionUser(port, 'reader-2-5@example.com', [
      { role: 'inventory_reader', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, 'reader-2-5@example.com');

    approverUserId = await provisionUser(port, 'approver-2-5@example.com', [
      { role: 'transfer_approver', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, 'approver-2-5@example.com');

    await provisionUser(port, 'outsider-2-5@example.com', [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: locCId },
    ]);
    outsiderHeaders = await authFor(port, 'outsider-2-5@example.com');

    // DOA bands for transfer_request. value_min is exclusive, value_max inclusive.
    //  qty <= 100         -> no approval
    //  100 < qty <= 500   -> transfer_approver (has holders)
    //  qty > 500          -> ghost_approver (NO holder) -> escalation walks to transfer_approver
    // DOA entries require compliance-module write access.
    await provisionUser(port, 'doa-admin-2-5@example.com', [
      { role: 'compliance_admin_2_5', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    const doaHeaders = await authFor(port, 'doa-admin-2-5@example.com');
    for (const entry of [
      { role: 'transfer_approver', value_min: 100, value_max: 500 },
      { role: 'ghost_approver', value_min: 500, value_max: null },
    ]) {
      const r = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { transaction_type: 'transfer_request', ...entry },
        doaHeaders,
      );
      assert.strictEqual(r.status, 201, `DOA entry ${entry.role} failed: ${JSON.stringify(r.body)}`);
    }
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- seeding helpers -----------------------------------------------------

  async function seedItem(
    sku: string,
    opts: { lot?: boolean; serial?: boolean } = {},
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', $2, $3, 'weighted_average', 'production', 'active')`,
      [sku, opts.lot ?? false, opts.serial ?? false],
    );
  }

  /** Seed a lot_master row; returns the lot_id (UUID string) used as the transfer lot_id. */
  async function seedLot(lotNumber: string, sku: string): Promise<string> {
    const r = await getPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku) VALUES ($1, $2, $3) RETURNING lot_id`,
      [randomUUID(), lotNumber, sku],
    );
    return r.rows[0]!['lot_id'] as string;
  }

  async function seedSerials(sku: string, lotId: string, serials: string[]): Promise<void> {
    for (const s of serials) {
      await getPool().query(
        `INSERT INTO serial_master (serial_id, serial_number, sku, lot_id) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), s, sku, lotId],
      );
    }
  }

  async function seedStock(sku: string, locationId: string, onHand: number, lotId: string | null): Promise<void> {
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', $4)`,
      [sku, locationId, lotId, onHand],
    );
  }

  async function balance(sku: string, locationId: string, lotId: string | null): Promise<{ on_hand: number; allocated: number; in_transit: number; available: number } | null> {
    const r = await getPool().query(
      `SELECT on_hand, allocated, in_transit, available FROM stock_balance
       WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)`,
      [sku, locationId, lotId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0]!;
    return {
      on_hand: Number(row['on_hand']),
      allocated: Number(row['allocated']),
      in_transit: Number(row['in_transit']),
      available: Number(row['available']),
    };
  }

  async function eventCount(streamId: string): Promise<number> {
    const r = await getPool().query(`SELECT count(*)::int AS c FROM domain_events WHERE stream_id = $1`, [streamId]);
    return r.rows[0]!['c'] as number;
  }

  function createBody(sku: string, qty: number, lotId: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sku_id: sku,
      from_location_id: locAId,
      to_location_id: locBId,
      quantity: qty,
      business_stream: 'production',
      ...(lotId ? { lot_id: lotId } : {}),
      ...extra,
    };
  }

  // --- tests ---------------------------------------------------------------

  it('AC1: a transfer above the DOA band is routed for approval (pending_approval + resolved approver)', async () => {
    const sku = 'TR-APPROVAL';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-APPROVAL', sku);
    await seedStock(sku, locAId, 300, lot);

    // quantity 200 falls in the 100<q<=500 band -> requires approval
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 200, lot), warehouseHeaders);
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    assert.strictEqual(create.body['status'], 'pending_approval');
    assert.strictEqual(create.body['approver_actor_id'], approverUserId);
  });

  it('AC1: a transfer at/below the band requires no approval (pending_shipment) and allocates source stock', async () => {
    const sku = 'TR-NOAPPROVAL';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-NOAPPROVAL', sku);
    await seedStock(sku, locAId, 100, lot);

    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), warehouseHeaders);
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    assert.strictEqual(create.body['status'], 'pending_shipment');
    assert.ok(!create.body['approver_actor_id']);

    const bal = await balance(sku, locAId, lot);
    assert.strictEqual(bal?.allocated, 50, 'allocation must reserve the transfer quantity');
    assert.strictEqual(bal?.available, 50);
  });

  it('AC2: only the resolved approver may approve; others get APPROVAL_REQUIRED', async () => {
    const sku = 'TR-APPROVE-GATE';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-APPROVE-GATE', sku);
    await seedStock(sku, locAId, 300, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 200, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;

    const wrong = await makeRequest(port, 'PATCH', `/api/v1/transfer-requests/${id}/approve`, {}, warehouseHeaders);
    assert.strictEqual(wrong.status, 403);
    assert.strictEqual(wrong.body['error_code'], 'APPROVAL_REQUIRED');

    const ok = await makeRequest(port, 'PATCH', `/api/v1/transfer-requests/${id}/approve`, {}, approverHeaders);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body['status'], 'approved');
  });

  it('AC5: shipping more than the approved quantity is rejected with QUANTITY_EXCEEDS_APPROVED', async () => {
    const sku = 'TR-SHIP-QTY';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-SHIP-QTY', sku);
    await seedStock(sku, locAId, 100, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;

    const ship = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 80 }, warehouseHeaders);
    assert.strictEqual(ship.status, 400);
    assert.strictEqual(ship.body['error_code'], 'QUANTITY_EXCEEDS_APPROVED');
  });

  it('AC3: ship then receive share one correlation_id; full receive completes the transfer and moves stock', async () => {
    const sku = 'TR-HAPPY';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-HAPPY', sku);
    await seedStock(sku, locAId, 100, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;

    const ship = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, warehouseHeaders);
    assert.strictEqual(ship.status, 201, JSON.stringify(ship.body));
    const shipCorr = ship.body['correlation_id'] as string;

    // source: on_hand reduced, in_transit reflects
    const src = await balance(sku, locAId, lot);
    assert.strictEqual(src?.on_hand, 50);
    assert.strictEqual(src?.in_transit, 50);

    const recv = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/receive`, { lot_id: lot, received_quantity: 50 }, warehouseHeaders);
    assert.strictEqual(recv.status, 201, JSON.stringify(recv.body));
    assert.strictEqual(recv.body['status'], 'received');
    assert.strictEqual(recv.body['correlation_id'], shipCorr, 'AC3: receive must reuse the ship correlation_id');

    const dest = await balance(sku, locBId, lot);
    assert.strictEqual(dest?.on_hand, 50, 'destination on_hand must reflect the received quantity');
    const srcAfter = await balance(sku, locAId, lot);
    assert.strictEqual(srcAfter?.in_transit, 0, 'in_transit must clear on full receive');
  });

  it('AC6: receiving a different lot than shipped is rejected with LOT_MISMATCH', async () => {
    const sku = 'TR-LOT-MISMATCH';
    await seedItem(sku, { lot: true });
    const lotA = await seedLot('LOT-TR-MM-A', sku);
    const lotB = await seedLot('LOT-TR-MM-B', sku);
    await seedStock(sku, locAId, 100, lotA);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 40, lotA), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lotA, shipped_quantity: 40 }, warehouseHeaders);

    const recv = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/receive`, { lot_id: lotB, received_quantity: 40 }, warehouseHeaders);
    assert.strictEqual(recv.status, 400);
    assert.strictEqual(recv.body['error_code'], 'LOT_MISMATCH');
  });

  it('Partial receive keeps the transfer receivable (partially_received), then a second receive completes it', async () => {
    const sku = 'TR-PARTIAL';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-PARTIAL', sku);
    await seedStock(sku, locAId, 100, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, warehouseHeaders);

    const first = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/receive`, { lot_id: lot, received_quantity: 30 }, warehouseHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(first.body['status'], 'partially_received');

    const mid = await balance(sku, locAId, lot);
    assert.strictEqual(mid?.in_transit, 20, 'remaining quantity stays in transit');

    const second = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/receive`, { lot_id: lot, received_quantity: 20 }, warehouseHeaders);
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.strictEqual(second.body['status'], 'received');

    const dest = await balance(sku, locBId, lot);
    assert.strictEqual(dest?.on_hand, 50, 'destination accrues both partial receipts');
  });

  it('Over-receiving more than remains in transit is rejected with QUANTITY_EXCEEDS_APPROVED', async () => {
    const sku = 'TR-OVER-RECV';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-OVER-RECV', sku);
    await seedStock(sku, locAId, 100, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, warehouseHeaders);

    const recv = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/receive`, { lot_id: lot, received_quantity: 80 }, warehouseHeaders);
    assert.strictEqual(recv.status, 400, JSON.stringify(recv.body));
    assert.strictEqual(recv.body['error_code'], 'QUANTITY_EXCEEDS_APPROVED');
  });

  it('A client-supplied transfer_request_id makes a retried create idempotent (no double allocation, one event)', async () => {
    const sku = 'TR-IDEM';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-IDEM', sku);
    await seedStock(sku, locAId, 100, lot);
    const clientId = randomUUID();

    const first = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 40, lot, { transfer_request_id: clientId }), warehouseHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 40, lot, { transfer_request_id: clientId }), warehouseHeaders);
    assert.strictEqual(second.status, 200, 'retry returns the existing request');
    assert.strictEqual(second.body['transfer_request_id'], clientId);

    const bal = await balance(sku, locAId, lot);
    assert.strictEqual(bal?.allocated, 40, 'stock must be allocated exactly once');
    assert.strictEqual(await eventCount(clientId), 1, 'only one created event may exist');
  });

  it('Concurrent double-ship produces exactly one in-transit row and one stock issue', async () => {
    const sku = 'TR-CONCURRENT';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-CONCURRENT', sku);
    await seedStock(sku, locAId, 100, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;

    const [a, b] = await Promise.all([
      makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, warehouseHeaders),
      makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, warehouseHeaders),
    ]);
    const okCount = [a, b].filter((r) => r.status === 201).length;
    assert.ok(okCount >= 1, 'at least one ship must succeed');

    const rows = await getPool().query('SELECT count(*)::int AS c FROM in_transit WHERE transfer_request_id = $1', [id]);
    assert.strictEqual(rows.rows[0]!['c'], 1, 'exactly one in_transit row may exist');
    const src = await balance(sku, locAId, lot);
    assert.strictEqual(src?.on_hand, 50, 'stock may be issued exactly once (100 - 50)');
  });

  it('Location RBAC: a writer not assigned to the source location cannot create the transfer', async () => {
    const sku = 'TR-LOC-RBAC';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-LOC-RBAC', sku);
    await seedStock(sku, locAId, 100, lot);

    const res = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 40, lot), outsiderHeaders);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('Role allow-list: logistics_manager may create but may NOT ship (ship is restricted to warehouse/store roles)', async () => {
    const sku = 'TR-LOGI';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-LOGI', sku);
    await seedStock(sku, locAId, 100, lot);

    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), logisticsHeaders);
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    const id = create.body['transfer_request_id'] as string;

    const ship = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, logisticsHeaders);
    assert.strictEqual(ship.status, 403, JSON.stringify(ship.body));
    assert.strictEqual(ship.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('Role allow-list: a read-only role cannot create a transfer', async () => {
    const sku = 'TR-ROLE-GATE';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-ROLE-GATE', sku);
    await seedStock(sku, locAId, 100, lot);

    const res = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 40, lot), readerHeaders);
    assert.ok(res.status === 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  it('Escalation: when the band-matched approver role has no holder, approval escalates to a role that does', async () => {
    const sku = 'TR-ESCALATE';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-ESCALATE', sku);
    await seedStock(sku, locAId, 700, lot);

    // qty 600 matches the ghost_approver band (>500), which has no holder -> escalate to transfer_approver.
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 600, lot), warehouseHeaders);
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    assert.strictEqual(create.body['status'], 'pending_approval');
    assert.strictEqual(create.body['approver_actor_id'], approverUserId, 'escalation must resolve to a role holder');
  });

  it('A lot-less request that ships with a concrete lot can be received against that lot (no false LOT_MISMATCH)', async () => {
    const sku = 'TR-LOTLESS';
    await seedItem(sku, { lot: false });
    const lot = await seedLot('LOT-TR-LOTLESS', sku);
    await seedStock(sku, locAId, 100, null); // stock held without a lot grain

    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, null), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;
    const ship = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, warehouseHeaders);
    assert.strictEqual(ship.status, 201, JSON.stringify(ship.body));

    const recv = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/receive`, { lot_id: lot, received_quantity: 50 }, warehouseHeaders);
    assert.strictEqual(recv.status, 201, JSON.stringify(recv.body));
    assert.strictEqual(recv.body['status'], 'received');
  });

  it('Serial traceability: shipping a serial not on the request is rejected with SERIAL_MISMATCH', async () => {
    const sku = 'TR-SERIAL';
    await seedItem(sku, { lot: true, serial: true });
    const lot = await seedLot('LOT-TR-SERIAL', sku);
    await seedSerials(sku, lot, ['SN-1', 'SN-2', 'SN-3']);
    await seedStock(sku, locAId, 100, lot);

    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 2, lot, { serial_ids: ['SN-1', 'SN-2'] }), warehouseHeaders);
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
    const id = create.body['transfer_request_id'] as string;

    const ship = await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 2, serial_ids: ['SN-1', 'SN-9'] }, warehouseHeaders);
    assert.strictEqual(ship.status, 400, JSON.stringify(ship.body));
    assert.strictEqual(ship.body['error_code'], 'SERIAL_MISMATCH');
  });

  it('Rejecting a pending transfer reverses the allocation, restoring available stock', async () => {
    const sku = 'TR-REJECT';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-REJECT', sku);
    await seedStock(sku, locAId, 300, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 200, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;
    const beforeReject = await balance(sku, locAId, lot);
    assert.strictEqual(beforeReject?.allocated, 200);

    const reject = await makeRequest(port, 'PATCH', `/api/v1/transfer-requests/${id}/reject`, { reason_code: 'NOT_NEEDED' }, approverHeaders);
    assert.strictEqual(reject.status, 200, JSON.stringify(reject.body));

    const afterReject = await balance(sku, locAId, lot);
    assert.strictEqual(afterReject?.allocated, 0, 'allocation must be released');
    assert.strictEqual(afterReject?.available, 300);
  });

  it('In-transit API omits fully-received (zero-quantity) rows', async () => {
    const sku = 'TR-INTRANSIT-API';
    await seedItem(sku, { lot: true });
    const lot = await seedLot('LOT-TR-INTRANSIT-API', sku);
    await seedStock(sku, locAId, 100, lot);
    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 50, lot), warehouseHeaders);
    const id = create.body['transfer_request_id'] as string;
    await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/ship`, { lot_id: lot, shipped_quantity: 50 }, warehouseHeaders);

    const during = await makeRequest(port, 'GET', `/api/v1/stock/${sku}/in-transit`, undefined, readerHeaders);
    assert.strictEqual(during.status, 200, JSON.stringify(during.body));
    assert.strictEqual((during.body['in_transit'] as unknown[]).length, 1, 'in-transit shows the shipped transfer');

    await makeRequest(port, 'POST', `/api/v1/transfer-requests/${id}/receive`, { lot_id: lot, received_quantity: 50 }, warehouseHeaders);
    const after = await makeRequest(port, 'GET', `/api/v1/stock/${sku}/in-transit`, undefined, readerHeaders);
    assert.strictEqual((after.body['in_transit'] as unknown[]).length, 0, 'fully-received transfer must not surface as in-transit');
  });

  it('A lot that does not belong to the SKU is rejected at create with LOT_SKU_MISMATCH (distinct from AC6 LOT_MISMATCH)', async () => {
    const sku = 'TR-LOT-SKU';
    const otherSku = 'TR-LOT-SKU-OTHER';
    await seedItem(sku, { lot: true });
    await seedItem(otherSku, { lot: true });
    const foreignLot = await seedLot('LOT-TR-FOREIGN', otherSku);
    await seedStock(sku, locAId, 100, null);

    const create = await makeRequest(port, 'POST', '/api/v1/transfer-requests', createBody(sku, 40, foreignLot), warehouseHeaders);
    assert.strictEqual(create.status, 400, JSON.stringify(create.body));
    assert.strictEqual(create.body['error_code'], 'LOT_SKU_MISMATCH');
  });
});

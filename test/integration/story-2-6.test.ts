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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const BUSINESS_DATE = '2026-07-21';

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
    req.setTimeout(5000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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

describe('Story 2.6 Cycle Counting and Physical Inventory', () => {
  let server: Server;
  let port: number;
  let counterHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;
  let approver2Headers: Record<string, string>;
  let signerHeaders: Record<string, string>;
  let operatorHeaders: Record<string, string>;
  let counterUserId: string;
  let approverUserId: string;
  let locAId: string;
  let locBId: string;

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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE physical_verification_line, physical_verification, cycle_count_line, cycle_count, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
    for (const code of ['LOC-2-6-A', 'LOC-2-6-B']) {
      const r = await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
        [randomUUID(), code, randomUUID()],
      );
      ids.push(r.rows[0]!['location_id'] as string);
    }
    [locAId, locBId] = ids as [string, string];

    // counter: enters and submits counts (SOD "enterer").
    counterUserId = await provisionUser(port, 'counter-2-6@example.com', [
      { role: 'inventory_controller', module: 'inventory', functionScope: 'write', locationId: locAId },
    ]);
    counterHeaders = await authFor(port, 'counter-2-6@example.com');

    // approver: DOA-resolved holder of warehouse_manager (provisioned first so it is the holder).
    approverUserId = await provisionUser(port, 'approver-2-6@example.com', [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, 'approver-2-6@example.com');

    // approver2: also a warehouse_manager, but NOT the resolved DOA holder.
    await provisionUser(port, 'approver2-2-6@example.com', [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    approver2Headers = await authFor(port, 'approver2-2-6@example.com');

    // signer: management sign-off (finance_controller in SIGNOFF_ROLES).
    await provisionUser(port, 'signer-2-6@example.com', [
      { role: 'finance_controller', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    signerHeaders = await authFor(port, 'signer-2-6@example.com');

    // operator: wildcard inventory writer + reader, used for direct POST /api/v1/events and reads.
    await provisionUser(port, 'operator-2-6@example.com', [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'inventory_reader', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    operatorHeaders = await authFor(port, 'operator-2-6@example.com');

    // DOA band for count adjustments: any variance value -> warehouse_manager.
    await provisionUser(port, 'doa-admin-2-6@example.com', [
      { role: 'compliance_admin_2_6', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    const doaHeaders = await authFor(port, 'doa-admin-2-6@example.com');
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      { transaction_type: 'inventory.count_adjustment', role: 'warehouse_manager', value_min: null, value_max: null },
      doaHeaders,
    );
    assert.strictEqual(doa.status, 201, `DOA entry failed: ${JSON.stringify(doa.body)}`);
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- seeding helpers -----------------------------------------------------

  async function seedItem(sku: string, opts: { lot?: boolean; serial?: boolean } = {}): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', $2, $3, 'weighted_average', 'production', 'active')`,
      [sku, opts.lot ?? false, opts.serial ?? false],
    );
  }

  async function seedStock(sku: string, locationId: string, onHand: number, lotId: string | null, allocated = 0): Promise<void> {
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, allocated) VALUES ($1, $2, $3, 'owned', $4, $5)`,
      [sku, locationId, lotId, onHand, allocated],
    );
  }

  async function seedValuation(sku: string, qty: number, avg: number): Promise<void> {
    await getPool().query(
      `INSERT INTO inventory_valuation (sku, quantity_on_hand, running_average_cost, carrying_value) VALUES ($1, $2, $3, $4)`,
      [sku, qty, avg, qty * avg],
    );
  }

  async function seedLot(lotNumber: string, sku: string): Promise<void> {
    await getPool().query(`INSERT INTO lot_master (lot_id, lot_number, sku) VALUES ($1, $2, $3)`, [randomUUID(), lotNumber, sku]);
  }

  async function balance(sku: string, locationId: string, lotId: string | null): Promise<{ on_hand: number; allocated: number; available: number } | null> {
    const r = await getPool().query(
      `SELECT on_hand, allocated, available FROM stock_balance
       WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)`,
      [sku, locationId, lotId],
    );
    if (r.rows.length === 0) return null;
    return { on_hand: Number(r.rows[0]!['on_hand']), allocated: Number(r.rows[0]!['allocated']), available: Number(r.rows[0]!['available']) };
  }

  async function createCount(sku: string[], headers: Record<string, string>, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/cycle-counts',
      { location_id: locAId, sku_scope: sku, count_type: 'cycle', business_date: BUSINESS_DATE, business_stream: 'production', ...extra },
      headers,
    );
    assert.strictEqual(res.status, 201, `create count failed: ${JSON.stringify(res.body)}`);
    return res.body['cycle_count_id'] as string;
  }

  // --- tests ---------------------------------------------------------------

  it('AC1: submit computes variance per SKU/lot and flags variances above tolerance for approval', async () => {
    await seedItem('CC-AC1-A');
    await seedStock('CC-AC1-A', locAId, 100, null);
    await seedValuation('CC-AC1-A', 100, 10);
    await seedItem('CC-AC1-B');
    await seedStock('CC-AC1-B', locAId, 40, null);

    const countId = await createCount(['CC-AC1-A', 'CC-AC1-B'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [
        { sku: 'CC-AC1-A', counted_quantity: 95 },
        { sku: 'CC-AC1-B', counted_quantity: 40 },
      ],
    }, counterHeaders);
    assert.strictEqual(submit.status, 201, JSON.stringify(submit.body));

    const lines = submit.body['lines'] as Array<Record<string, unknown>>;
    const a = lines.find((l) => l['sku'] === 'CC-AC1-A')!;
    const b = lines.find((l) => l['sku'] === 'CC-AC1-B')!;
    assert.strictEqual(a['variance_quantity'], -5, 'A: 95 - 100 = -5');
    assert.strictEqual(a['tolerance_breach'], true, 'A: non-zero variance breaches zero-tolerance');
    assert.ok(a['adjustment_id'], 'A: breaching line has an adjustment routed for approval');
    assert.strictEqual(a['adjustment_status'], 'pending_approval');
    assert.strictEqual(Number(a['variance_value']), 50, 'A: |−5| * avg 10 = 50');
    assert.strictEqual(b['variance_quantity'], 0, 'B: no variance');
    assert.strictEqual(b['tolerance_breach'], false);
    assert.strictEqual(b['adjustment_id'], null, 'B: no adjustment for a matching count');
  });

  it('AC1: allocated and in_transit are reported separately, not counted as adjustable book stock', async () => {
    await seedItem('CC-ALLOC');
    await seedStock('CC-ALLOC', locAId, 30, null, 12); // 12 allocated
    const countId = await createCount(['CC-ALLOC'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-ALLOC', counted_quantity: 30 }],
    }, counterHeaders);
    const line = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!;
    assert.strictEqual(line['book_quantity'], 30, 'book uses on_hand, not on_hand - allocated');
    assert.strictEqual(line['allocated_quantity'], 12, 'allocated reported separately');
    assert.strictEqual(line['variance_quantity'], 0);
  });

  it('AC2: a stock.adjusted event without an approved adjustment is rejected centrally with APPROVAL_REQUIRED', async () => {
    await seedItem('CC-AC2');
    await seedStock('CC-AC2', locAId, 50, null);
    const res = await makeRequest(port, 'POST', '/api/v1/events', {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.adjusted',
      payload: {
        adjustment_id: randomUUID(),
        cycle_count_id: randomUUID(),
        sku: 'CC-AC2',
        target_location_id: locAId,
        stock_class: 'owned',
        delta_quantity: -5,
        reason_code: 'shrinkage',
        approver_actor_id: approverUserId,
        business_stream: 'production',
        placement_confirmed: true,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: counterUserId, role: 'warehouse_operator', location_id: locAId },
        occurred_at: new Date().toISOString(),
      },
    }, operatorHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    const bal = await balance('CC-AC2', locAId, null);
    assert.strictEqual(bal?.on_hand, 50, 'stock is untouched by the rejected adjustment');
  });

  it('AC3: an approved adjustment updates stock, valuation, and is logged in the edit log with approver/reason/delta', async () => {
    await seedItem('CC-AC3');
    await seedStock('CC-AC3', locAId, 100, null);
    await seedValuation('CC-AC3', 100, 10);
    const countId = await createCount(['CC-AC3'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-AC3', counted_quantity: 95 }],
    }, counterHeaders);
    const adjustmentId = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!['adjustment_id'] as string;

    const approve = await makeRequest(
      port,
      'PATCH',
      `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/approve`,
      { reason_code: 'shrinkage' },
      approverHeaders,
    );
    assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));

    const bal = await balance('CC-AC3', locAId, null);
    assert.strictEqual(bal?.on_hand, 95, 'on_hand adjusted down to the counted quantity');

    const val = await getPool().query(`SELECT quantity_on_hand, carrying_value FROM inventory_valuation WHERE sku = $1`, ['CC-AC3']);
    assert.strictEqual(Number(val.rows[0]!['quantity_on_hand']), 95, 'valuation quantity moves with on_hand');
    assert.strictEqual(Number(val.rows[0]!['carrying_value']), 950, 'carrying value = 95 * avg 10');

    const evt = await getPool().query(
      `SELECT payload FROM domain_events WHERE event_type = 'stock.adjusted' AND payload->>'adjustment_id' = $1`,
      [adjustmentId],
    );
    assert.strictEqual(evt.rows.length, 1, 'the adjustment is recorded in the append-only event log');
    const payload = evt.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['approver_actor_id'], approverUserId);
    assert.strictEqual(payload['reason_code'], 'shrinkage');
    assert.strictEqual(Number(payload['delta_quantity']), -5);

    const audit = await getPool().query(
      `SELECT count(*)::int AS c FROM audit_log WHERE event_id = (SELECT event_id FROM domain_events WHERE event_type='stock.adjusted' AND payload->>'adjustment_id' = $1)`,
      [adjustmentId],
    );
    assert.strictEqual(audit.rows[0]!['c'], 1, 'the adjustment carries a statutory audit row');
  });

  it('SOD: the count submitter cannot approve its own adjustment (COUNT_ENTERER_CANNOT_APPROVE)', async () => {
    await seedItem('CC-SOD');
    await seedStock('CC-SOD', locAId, 20, null);
    await seedValuation('CC-SOD', 20, 5);
    const countId = await createCount(['CC-SOD'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-SOD', counted_quantity: 18 }],
    }, counterHeaders);
    const adjustmentId = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!['adjustment_id'] as string;

    // inventory_controller is itself an approve-eligible role, so the SOD guard - not a role gate -
    // is what blocks the submitter from approving the variance they entered.
    const attempt = await makeRequest(
      port,
      'PATCH',
      `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/approve`,
      { reason_code: 'x' },
      counterHeaders,
    );
    assert.strictEqual(attempt.status, 403, JSON.stringify(attempt.body));
    assert.strictEqual(attempt.body['error_code'], 'COUNT_ENTERER_CANNOT_APPROVE');
  });

  it('DOA: an authorized approver who is not the resolved DOA holder is rejected with APPROVAL_REQUIRED', async () => {
    await seedItem('CC-DOA');
    await seedStock('CC-DOA', locAId, 20, null);
    await seedValuation('CC-DOA', 20, 5);
    const countId = await createCount(['CC-DOA'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-DOA', counted_quantity: 15 }],
    }, counterHeaders);
    const adjustmentId = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!['adjustment_id'] as string;

    const attempt = await makeRequest(
      port,
      'PATCH',
      `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/approve`,
      { reason_code: 'x' },
      approver2Headers,
    );
    assert.strictEqual(attempt.status, 403, JSON.stringify(attempt.body));
    assert.strictEqual(attempt.body['error_code'], 'APPROVAL_REQUIRED');
  });

  it('a negative adjustment that would drop on_hand below allocated is rejected', async () => {
    await seedItem('CC-NEG');
    await seedStock('CC-NEG', locAId, 10, null, 8); // 8 allocated
    await seedValuation('CC-NEG', 10, 1);
    const countId = await createCount(['CC-NEG'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-NEG', counted_quantity: 0 }],
    }, counterHeaders);
    const adjustmentId = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!['adjustment_id'] as string;

    const approve = await makeRequest(
      port,
      'PATCH',
      `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/approve`,
      { reason_code: 'shrinkage' },
      approverHeaders,
    );
    assert.strictEqual(approve.status, 409, JSON.stringify(approve.body));
    assert.strictEqual(approve.body['error_code'], 'STOCK_ADJUSTMENT_NEGATIVE_BALANCE');
    const bal = await balance('CC-NEG', locAId, null);
    assert.strictEqual(bal?.on_hand, 10, 'stock is untouched by the rejected negative adjustment');
    assert.strictEqual(bal?.allocated, 8, 'allocated is preserved');
  });

  it('a lot-controlled item requires a lot on every count line', async () => {
    await seedItem('CC-LOT', { lot: true });
    await seedLot('LOT-CC', 'CC-LOT');
    await seedStock('CC-LOT', locAId, 30, 'LOT-CC');
    const countId = await createCount(['CC-LOT'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-LOT', counted_quantity: 28 }],
    }, counterHeaders);
    assert.strictEqual(submit.status, 400, JSON.stringify(submit.body));
    assert.strictEqual(submit.body['error_code'], 'LOT_REQUIRED');
  });

  it('submit is idempotent: a repeat submission does not double-record lines', async () => {
    await seedItem('CC-IDEM');
    await seedStock('CC-IDEM', locAId, 50, null);
    await seedValuation('CC-IDEM', 50, 2);
    const countId = await createCount(['CC-IDEM'], counterHeaders);
    const first = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-IDEM', counted_quantity: 47 }],
    }, counterHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-IDEM', counted_quantity: 47 }],
    }, counterHeaders);
    assert.strictEqual(second.status, 200, 'a re-submit is a no-op returning the recorded count');
    const rows = await getPool().query(`SELECT count(*)::int AS c FROM cycle_count_line WHERE cycle_count_id = $1`, [countId]);
    assert.strictEqual(rows.rows[0]!['c'], 1, 'exactly one line row for the count');
  });

  it('AC4: the physical-verification report exposes CARO evidence fields and is immutable once period-locked', async () => {
    await seedItem('CC-PV');
    await seedStock('CC-PV', locAId, 100, null);
    await seedValuation('CC-PV', 100, 4);
    const countId = await createCount(['CC-PV'], counterHeaders);
    const submit = await makeRequest(port, 'POST', `/api/v1/cycle-counts/${countId}/submit`, {
      lines: [{ sku: 'CC-PV', counted_quantity: 90 }],
    }, counterHeaders);
    const adjustmentId = (submit.body['lines'] as Array<Record<string, unknown>>)[0]!['adjustment_id'] as string;
    await makeRequest(port, 'PATCH', `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/approve`, { reason_code: 'shrinkage' }, approverHeaders);

    const pvId = randomUUID();
    const complete = await makeRequest(port, 'POST', '/api/v1/physical-verifications', {
      physical_verification_id: pvId,
      location_id: locAId,
      count_refs: [countId],
      coverage_percentage: 100,
      business_date: BUSINESS_DATE,
      business_stream: 'production',
    }, counterHeaders);
    assert.strictEqual(complete.status, 201, JSON.stringify(complete.body));

    const report = await makeRequest(port, 'GET', `/api/v1/physical-verification/report?location_id=${locAId}`, undefined, operatorHeaders);
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    const reports = report.body['reports'] as Array<Record<string, unknown>>;
    const rep = reports.find((r) => r['physical_verification_id'] === pvId)!;
    assert.ok(rep, 'the completed verification appears in the report');
    assert.strictEqual(rep['coverage_percentage'], 100);
    assert.strictEqual(rep['management_signoff_status'], 'pending');
    const repLine = (rep['lines'] as Array<Record<string, unknown>>)[0]!;
    assert.strictEqual(repLine['sku'], 'CC-PV');
    assert.strictEqual(repLine['book_quantity'], 100);
    assert.strictEqual(repLine['counted_quantity'], 90);
    assert.strictEqual(repLine['variance_quantity'], -10);
    assert.strictEqual(Number(repLine['variance_value']), 40, '|−10| * avg 4');
    assert.ok(repLine['adjustment_event_ref'], 'the applied adjustment event is referenced as evidence');
    assert.strictEqual(repLine['count_date'], BUSINESS_DATE, 'count date is a local business date');

    // Sign off -> period locked.
    const signoff = await makeRequest(port, 'POST', `/api/v1/physical-verifications/${pvId}/sign-off`, { business_date: BUSINESS_DATE }, signerHeaders);
    assert.strictEqual(signoff.status, 200, JSON.stringify(signoff.body));

    const locked = await makeRequest(port, 'POST', `/api/v1/physical-verifications/${pvId}/sign-off`, { business_date: BUSINESS_DATE }, signerHeaders);
    assert.strictEqual(locked.status, 409, JSON.stringify(locked.body));
    assert.strictEqual(locked.body['error_code'], 'PERIOD_LOCKED');

    const after = await makeRequest(port, 'GET', `/api/v1/physical-verification/report?location_id=${locAId}`, undefined, operatorHeaders);
    const repAfter = (after.body['reports'] as Array<Record<string, unknown>>).find((r) => r['physical_verification_id'] === pvId)!;
    assert.strictEqual(repAfter['management_signoff_status'], 'signed_off');
    assert.strictEqual(repAfter['period_locked'], true);
  });

  it('location scoping: a non-wildcard actor cannot create a count for an unassigned location', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/cycle-counts', {
      location_id: locBId,
      sku_scope: ['CC-AC1-A'],
      count_type: 'cycle',
      business_date: BUSINESS_DATE,
      business_stream: 'production',
    }, counterHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });
});

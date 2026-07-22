import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { runSafetyStockComputation, runReplenishmentCheck, runObsolescenceScan } from '../../src/compliance/planning-jobs.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.7: Safety Stock, Reorder Points, and Obsolescence Flagging. Runs against the PRODUCTION
// router surface with real auth, RBAC, and PostgreSQL; the suite runs serially (--test-concurrency=1).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const BUSINESS_DATE = '2026-07-22';
const NO_LOCATION_UUID = '00000000-0000-0000-0000-000000000000';

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

describe('Story 2.7 Safety Stock, Reorder Points, and Obsolescence Flagging', () => {
  let server: Server;
  let port: number;
  let plannerHeaders: Record<string, string>;
  let scopedPlannerHeaders: Record<string, string>;
  let mixedScopePlannerHeaders: Record<string, string>;
  let plannerUserId: string;
  let locAId: string;
  let locBId: string;
  let locACode: string;

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
    for (const code of ['LOC-2-7-A', 'LOC-2-7-B']) {
      const r = await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
        [randomUUID(), code, randomUUID()],
      );
      ids.push(r.rows[0]!['location_id'] as string);
    }
    [locAId, locBId] = ids as [string, string];
    locACode = 'LOC-2-7-A';

    // planner: wildcard write + read + the inventory_planner role that alerts target.
    plannerUserId = await provisionUser(port, 'planner-2-7@example.com', [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'inventory_planner', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, 'planner-2-7@example.com');

    // scoped planner: write access to locA only, used for location-scoping rejection.
    await provisionUser(port, 'scoped-planner-2-7@example.com', [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: locAId },
    ]);
    scopedPlannerHeaders = await authFor(port, 'scoped-planner-2-7@example.com');

    await provisionUser(port, 'mixed-scope-planner-2-7@example.com', [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: locAId },
      { role: 'inventory_planner', module: 'inventory', functionScope: 'read', locationId: locBId },
    ]);
    mixedScopePlannerHeaders = await authFor(port, 'mixed-scope-planner-2-7@example.com');
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

  function daysAgoIso(days: number): string {
    return new Date(Date.now() - days * 86400000).toISOString();
  }

  async function postStockEvent(eventType: string, payload: Record<string, unknown>, occurredAt?: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: eventType,
        payload: { business_stream: 'production', ...payload },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: locAId },
          occurred_at: occurredAt ?? new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
  }

  async function setParams(body: Record<string, unknown>, headers = plannerHeaders): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/planning/params', body, headers);
  }

  async function getParams(sku: string, locationId: string): Promise<Record<string, unknown>> {
    const res = await makeRequest(port, 'GET', `/api/v1/planning/params/${sku}?location_id=${locationId}`, undefined, plannerHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = res.body['params'] as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1, `expected one params row for ${sku}`);
    return rows[0]!;
  }

  async function notificationCount(objectId: string, eventType: string): Promise<number> {
    const r = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1 AND payload->>'event_type' = $2`,
      [objectId, eventType],
    );
    return r.rows[0]!['c'] as number;
  }

  async function eventCount(eventType: string, sku: string): Promise<number> {
    const r = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = $1 AND payload->>'sku' = $2`,
      [eventType, sku],
    );
    return r.rows[0]!['c'] as number;
  }

  // --- AC1: safety stock and reorder point --------------------------------

  it('AC1: the worked example computes safety stock = 20 and reorder point by the documented formula', async () => {
    const sku = 'SS-AC1';
    await seedItem(sku);
    // Two distinct issue days of 10 and 18 give STDDEV_POP = 4 and mean daily demand = 14.
    await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 100, unit_cost: 5 });
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 10 }, daysAgoIso(5));
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 18 }, daysAgoIso(3));

    const params = await setParams({
      sku,
      location_id: locAId,
      lead_time_days: 9,
      lead_time_source: 'seeded',
      service_level: 0.95,
      standard_order_qty: 100,
      obsolescence_threshold_days: 180,
      business_stream: 'production',
    });
    assert.strictEqual(params.status, 201, JSON.stringify(params.body));

    const compute = await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(compute.status, 200, JSON.stringify(compute.body));

    const row = await getParams(sku, locAId);
    // z(0.95) * sigma(4) * sqrt(9) = 1.645 * 4 * 3 = 19.74, ceil -> 20.
    assert.strictEqual(Number(row['safety_stock']), 20, 'safety stock ceils to 20');
    // reorder = ceil(avg_daily_demand(14) * lead_time(9) + safety_stock(20)) = ceil(146) = 146.
    assert.strictEqual(Number(row['reorder_point']), 146, 'reorder point = (avg * lead) + safety stock');

    const inputs = row['computation_inputs'] as Record<string, unknown>;
    assert.strictEqual(Number(inputs['sigma_daily']), 4, 'sigma_daily recorded');
    assert.strictEqual(Number(inputs['avg_daily_demand']), 14, 'avg_daily_demand recorded');
    assert.strictEqual(Number(inputs['z']), 1.645, 'z score recorded');
    assert.strictEqual(Number(inputs['sample_day_count']), 2, 'sample day count recorded');
    assert.strictEqual(inputs['lead_time_source'], 'seeded', 'lead_time_source recorded on every computation');

    // Reproducible from its recorded inputs.
    const reproduced = Math.ceil(Number(inputs['z']) * Number(inputs['sigma_daily']) * Math.sqrt(Number(inputs['lead_time_days'])));
    assert.strictEqual(reproduced, Number(row['safety_stock']), 'the stored computation reproduces from computation_inputs');
  });

  it('AC1: computation is idempotent - recomputing over unchanged demand emits no duplicate event', async () => {
    const before = await eventCount('inventory_planning.safety_stock_computed', 'SS-AC1');
    const again = await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku: 'SS-AC1', location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    const after = await eventCount('inventory_planning.safety_stock_computed', 'SS-AC1');
    assert.strictEqual(after, before, 'a recompute over unchanged state emits no new computation event');
  });

  it('AC1: fails closed with INSUFFICIENT_DEMAND_HISTORY when the window has too few sample days', async () => {
    const sku = 'SS-INSUF';
    await seedItem(sku);
    await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 50 });
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 5 }, daysAgoIso(2));
    await setParams({ sku, location_id: locAId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.95, business_stream: 'production' });
    const compute = await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(compute.status, 400, JSON.stringify(compute.body));
    assert.strictEqual(compute.body['error_code'], 'INSUFFICIENT_DEMAND_HISTORY');
    const row = await getParams(sku, locAId);
    assert.strictEqual(row['safety_stock'], null, 'no computation is stored on insufficient history');
  });

  it('AC1: fails closed with LEAD_TIME_NOT_CONFIGURED when no lead time is set', async () => {
    const sku = 'SS-NOLEAD';
    await seedItem(sku);
    await setParams({ sku, location_id: locAId, service_level: 0.95, business_stream: 'production' });
    const compute = await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(compute.status, 400, JSON.stringify(compute.body));
    assert.strictEqual(compute.body['error_code'], 'LEAD_TIME_NOT_CONFIGURED');
  });

  it('AC1: rejects an unsupported service level with INVALID_SERVICE_LEVEL', async () => {
    const sku = 'SS-BADSL';
    await seedItem(sku);
    await setParams({ sku, location_id: locAId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.8, business_stream: 'production' });
    const compute = await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(compute.status, 400, JSON.stringify(compute.body));
    assert.strictEqual(compute.body['error_code'], 'INVALID_SERVICE_LEVEL');
  });

  // --- AC2: replenishment recommendation ----------------------------------

  it('AC2: an on-hand at/below reorder point creates exactly one open recommendation and one planner alert', async () => {
    const sku = 'RP-AC2';
    await seedItem(sku);
    // Received 100, issued 10 + 18 across two days -> on_hand 72, sigma 4, avg 14.
    await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 100, unit_cost: 5 });
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 10 }, daysAgoIso(5));
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 18 }, daysAgoIso(3));
    await setParams({ sku, location_id: locAId, lead_time_days: 5, lead_time_source: 'seeded', service_level: 0.95, standard_order_qty: 100, business_stream: 'production' });
    const compute = await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(compute.status, 200, JSON.stringify(compute.body));
    // reorder = ceil(14*5 + ceil(1.645*4*sqrt(5))) = ceil(70 + 15) = 85; on_hand 72 <= 85 crosses.

    const check = await makeRequest(port, 'POST', '/api/v1/planning/replenishment/check', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    const recommended = check.body['recommended'] as Array<Record<string, unknown>>;
    assert.strictEqual(recommended.length, 1, 'exactly one recommendation created');
    assert.strictEqual(recommended[0]!['recommended_order_qty'], 100, 'recommended qty is the standard order qty');

    const list = await makeRequest(port, 'GET', `/api/v1/planning/replenishment/recommendations?sku=${sku}&status=open`, undefined, plannerHeaders);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const recs = list.body['recommendations'] as Array<Record<string, unknown>>;
    assert.strictEqual(recs.length, 1, 'one open recommendation is listed');
    assert.strictEqual(Number(recs[0]!['on_hand_at_check']), 72);
    assert.strictEqual(Number(recs[0]!['reorder_point']), 85);

    assert.strictEqual(await notificationCount(sku, 'replenishment_recommended'), 1, 'exactly one planner alert emitted');

    // Idempotent per crossing: a re-check over unchanged state adds no second recommendation or alert.
    const recheck = await makeRequest(port, 'POST', '/api/v1/planning/replenishment/check', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(recheck.status, 200, JSON.stringify(recheck.body));
    assert.strictEqual((recheck.body['recommended'] as unknown[]).length, 0, 'no second recommendation on re-check');
    assert.strictEqual(await eventCount('replenishment.recommended', sku), 1, 'still exactly one recommendation event');
    assert.strictEqual(await notificationCount(sku, 'replenishment_recommended'), 1, 'still exactly one alert');
  });

  it('AC2 concurrency: two concurrent checks for the same grain create at most one open recommendation', async () => {
    const sku = 'RP-CONC';
    await seedItem(sku);
    await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 100, unit_cost: 5 });
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 10 }, daysAgoIso(5));
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 18 }, daysAgoIso(3));
    await setParams({ sku, location_id: locAId, lead_time_days: 5, lead_time_source: 'seeded', service_level: 0.95, standard_order_qty: 100, business_stream: 'production' });
    await makeRequest(port, 'POST', '/api/v1/planning/safety-stock/compute', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);

    const scope = { location_id: locAId, sku, business_date: BUSINESS_DATE, actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: NO_LOCATION_UUID } };
    await Promise.all([runReplenishmentCheck(scope), runReplenishmentCheck(scope)]);

    const open = await getPool().query(`SELECT count(*)::int AS c FROM replenishment_recommendation WHERE sku = $1 AND status = 'open'`, [sku]);
    assert.strictEqual(open.rows[0]!['c'], 1, 'no more than one open recommendation after concurrent checks');
    assert.strictEqual(await eventCount('replenishment.recommended', sku), 1, 'exactly one recommendation event');
  });

  // --- AC3: obsolescence flag + NRV trigger -------------------------------

  it('AC3: an item with no issues past the threshold is flagged aging, appears in the report, and triggers NRV testing without a write-down', async () => {
    const sku = 'OBS-AC3';
    await seedItem(sku);
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, last_issue_at)
       VALUES ($1, $2, NULL, 'owned', 30, now() - INTERVAL '200 days')`,
      [sku, locAId],
    );
    await getPool().query(`INSERT INTO inventory_valuation (sku, quantity_on_hand, running_average_cost, carrying_value) VALUES ($1, 30, 5, 150)`, [sku]);
    await setParams({ sku, location_id: locAId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.95, obsolescence_threshold_days: 180, business_stream: 'production' });

    const scan = await makeRequest(port, 'POST', '/api/v1/planning/obsolescence/scan', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(scan.status, 200, JSON.stringify(scan.body));
    assert.strictEqual((scan.body['flagged'] as unknown[]).length, 1, 'the aging item is flagged');

    const report = await makeRequest(port, 'GET', `/api/v1/planning/obsolescence/report?location_id=${locAId}`, undefined, plannerHeaders);
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    const rows = report.body['reports'] as Array<Record<string, unknown>>;
    const rep = rows.find((r) => r['sku'] === sku)!;
    assert.ok(rep, 'the flagged item appears in the obsolescence report');
    assert.strictEqual(rep['status'], 'aging');
    assert.strictEqual(rep['disposition_status'], 'pending_disposition');
    assert.strictEqual(rep['nrv_testing_triggered'], true);
    assert.ok(Number(rep['days_since_issue']) >= 180, 'days_since_issue exceeds the threshold');
    assert.strictEqual(Number(rep['threshold_days']), 180);

    // NRV testing is a flag plus alert only - planning must NOT post a write-down.
    assert.strictEqual(await notificationCount(sku, 'obsolescence_flagged'), 1, 'exactly one NRV-review alert emitted');
    const writeDownEvents = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type IN ('stock.nrv_write_down_recorded', 'inventory.nrv_write_down') AND payload->>'sku' = $1`,
      [sku],
    );
    assert.strictEqual(writeDownEvents.rows[0]!['c'], 0, 'planning posts no NRV write-down event');
    const nrvRows = await getPool().query(`SELECT count(*)::int AS c FROM inventory_valuation_nrv_adjustment WHERE sku = $1`, [sku]);
    assert.strictEqual(nrvRows.rows[0]!['c'], 0, 'planning writes no NRV adjustment row (the DOA-gated valuation seam owns write-downs)');

    // Idempotent: re-scanning an already-aging grain emits no second flag or alert.
    const rescan = await makeRequest(port, 'POST', '/api/v1/planning/obsolescence/scan', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual((rescan.body['flagged'] as unknown[]).length, 0, 'no second flag on re-scan');
    assert.strictEqual(await eventCount('obsolescence.flagged', sku), 1, 'still exactly one flag event');
    assert.strictEqual(await notificationCount(sku, 'obsolescence_flagged'), 1, 'still exactly one alert');
  });

  it('AC3: resumed issue activity within the threshold clears the flag', async () => {
    const sku = 'OBS-AC3';
    // Fresh issue stamps last_issue_at = now, inside the 180-day threshold.
    await postStockEvent('stock.issued', { sku, target_location_id: locAId, quantity: 5 });
    const scan = await makeRequest(port, 'POST', '/api/v1/planning/obsolescence/scan', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(scan.status, 200, JSON.stringify(scan.body));
    assert.strictEqual((scan.body['cleared'] as unknown[]).length, 1, 'resumed activity clears the flag');

    const report = await makeRequest(port, 'GET', `/api/v1/planning/obsolescence/report?location_id=${locAId}`, undefined, plannerHeaders);
    const rep = (report.body['reports'] as Array<Record<string, unknown>>).find((r) => r['sku'] === sku)!;
    assert.strictEqual(rep['status'], 'active', 'the flag is cleared back to active');
    assert.strictEqual(rep['disposition_status'], null);
    assert.strictEqual(rep['nrv_testing_triggered'], false);
  });

  it('AC3 concurrency: two concurrent scans for the same aging grain create at most one flag', async () => {
    const sku = 'OBS-CONC';
    await seedItem(sku);
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, last_issue_at)
       VALUES ($1, $2, NULL, 'owned', 30, now() - INTERVAL '200 days')`,
      [sku, locAId],
    );
    await setParams({ sku, location_id: locAId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.95, obsolescence_threshold_days: 180, business_stream: 'production' });

    const scope = { location_id: locAId, sku, business_date: BUSINESS_DATE, actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: NO_LOCATION_UUID } };
    await Promise.all([runObsolescenceScan(scope), runObsolescenceScan(scope)]);

    const flags = await getPool().query(`SELECT count(*)::int AS c FROM obsolescence_flag WHERE sku = $1 AND status = 'aging'`, [sku]);
    assert.strictEqual(flags.rows[0]!['c'], 1, 'exactly one aging flag row after concurrent scans');
    assert.strictEqual(await eventCount('obsolescence.flagged', sku), 1, 'exactly one flag event');
  });

  // --- guardrails ----------------------------------------------------------

  it('a direct stock.adjusted-style bypass cannot forge planning outputs: the seam validates safety_stock_computed against configured params', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/events', {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'inventory_planning.safety_stock_computed',
      payload: {
        computation_id: randomUUID(),
        planning_params_id: randomUUID(),
        sku: 'SS-AC1',
        location_id: locBId, // no params configured at locB for SS-AC1
        safety_stock: 999,
        reorder_point: 999,
        avg_daily_demand: 1,
        demand_std_dev: 1,
        computation_inputs: {},
        computed_at: new Date().toISOString(),
        business_date: BUSINESS_DATE,
        business_stream: 'production',
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: locBId },
        occurred_at: new Date().toISOString(),
      },
    }, plannerHeaders);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PLANNING_PARAMS_NOT_FOUND');
  });

  it('location scoping: a planner scoped to locA cannot set params for locB', async () => {
    const res = await setParams({ sku: 'SS-AC1', location_id: locBId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.95, business_stream: 'production' }, scopedPlannerHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('review patch: read access at a target location is not enough for planning writes', async () => {
    const res = await setParams({ sku: 'SS-AC1', location_id: locBId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.95, business_stream: 'production' }, mixedScopePlannerHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('review patch: direct events and edge uploads enforce planning payload location write access', async () => {
    const payload = {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_id: randomUUID(),
      event_type: 'inventory_planning.params_set',
      payload: {
        planning_params_id: randomUUID(),
        sku: 'SS-AC1',
        location_id: locBId,
        service_level: 0.95,
        business_stream: 'production',
        set_by_actor_id: plannerUserId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: locAId },
        occurred_at: new Date().toISOString(),
        device_id: 'rugged-2-7',
      },
    };
    const direct = await makeRequest(port, 'POST', '/api/v1/events', payload, mixedScopePlannerHeaders);
    assert.strictEqual(direct.status, 403, JSON.stringify(direct.body));
    assert.strictEqual(direct.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const edge = await makeRequest(port, 'POST', '/api/v1/edge/events', { ...payload, idempotency_key: `plan-edge-${randomUUID()}`, device_id: 'rugged-2-7' }, mixedScopePlannerHeaders);
    assert.strictEqual(edge.status, 403, JSON.stringify(edge.body));
    assert.strictEqual(edge.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('review patch: code-keyed owned issues feed safety-stock demand stats and concurrent computes do not duplicate events', async () => {
    const sku = 'SS-CODE-CONC';
    await seedItem(sku);
    await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 100, unit_cost: 5 });
    await postStockEvent('stock.issued', { sku, target_location_code: locACode, quantity: 10 }, daysAgoIso(5));
    await postStockEvent('stock.issued', { sku, target_location_code: locACode, quantity: 18 }, daysAgoIso(3));
    await setParams({ sku, location_id: locAId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.95, business_stream: 'production' });

    const scope = { location_id: locAId, sku, business_date: BUSINESS_DATE, actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: NO_LOCATION_UUID } };
    await Promise.all([runSafetyStockComputation(scope), runSafetyStockComputation(scope)]);

    const row = await getParams(sku, locAId);
    assert.strictEqual(Number(row['safety_stock']), 20, 'code-keyed issues are counted in demand stats');
    assert.strictEqual(await eventCount('inventory_planning.safety_stock_computed', sku), 1, 'concurrent computes emit exactly one event');
  });

  it('review patch: only owned stock feeds replenishment and obsolescence decisions', async () => {
    const sku = 'OWNED-ONLY-2-7';
    await seedItem(sku);
    // Story 2.8: consignment receipts are agreement-gated and must carry the owner party code.
    await getPool().query(
      `INSERT INTO ownership_agreement (agreement_id, sku, location_id, stock_class, owner_party_code, business_stream)
       VALUES ($1, $2, $3, 'consignment', 'SUP-2-7', 'production')`,
      [randomUUID(), sku, locAId],
    );
    const ownedReceipt = await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 1, unit_cost: 5 });
    assert.strictEqual(ownedReceipt.status, 201, JSON.stringify(ownedReceipt.body));
    const consignmentReceipt = await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 1000, unit_cost: 5, stock_class: 'consignment', owner_party_code: 'SUP-2-7' });
    assert.strictEqual(consignmentReceipt.status, 201, JSON.stringify(consignmentReceipt.body));
    await getPool().query(
      `INSERT INTO inventory_planning_params (planning_params_id, sku, location_id, service_level, reorder_point, standard_order_qty, obsolescence_threshold_days, business_stream)
       VALUES ($1, $2, $3, 0.95, 50, 100, 180, 'production')`,
      [randomUUID(), sku, locAId],
    );

    const check = await makeRequest(port, 'POST', '/api/v1/planning/replenishment/check', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(check.status, 200, JSON.stringify(check.body));
    assert.strictEqual((check.body['recommended'] as unknown[]).length, 1, 'owned on-hand 1 crosses reorder even with consignment present');

    await getPool().query(`UPDATE stock_balance SET last_issue_at = now() - INTERVAL '200 days' WHERE sku = $1 AND stock_class = 'consignment'`, [sku]);
    const scan = await makeRequest(port, 'POST', '/api/v1/planning/obsolescence/scan', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(scan.status, 200, JSON.stringify(scan.body));
    assert.strictEqual((scan.body['flagged'] as unknown[]).length, 0, 'consignment activity does not age owned stock');
  });

  it('review patch: partial params edits preserve omitted config fields', async () => {
    const sku = 'PARAM-PRESERVE-2-7';
    await seedItem(sku);
    const initial = await setParams({ sku, location_id: locAId, lead_time_days: 11, lead_time_source: 'seeded', service_level: 0.95, obsolescence_threshold_days: 180, standard_order_qty: 75, demand_window_days: 30, business_stream: 'production' });
    assert.strictEqual(initial.status, 201, JSON.stringify(initial.body));
    const edited = await setParams({ sku, location_id: locAId, service_level: 0.99, business_stream: 'production' });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    const row = await getParams(sku, locAId);
    assert.strictEqual(Number(row['lead_time_days']), 11);
    assert.strictEqual(row['lead_time_source'], 'seeded');
    assert.strictEqual(Number(row['obsolescence_threshold_days']), 180);
    assert.strictEqual(Number(row['standard_order_qty']), 75);
    assert.strictEqual(Number(row['demand_window_days']), 30);
  });

  it('review patch: never-issued owned stock uses a fallback clock and returns real days_since_issue', async () => {
    const sku = 'OBS-NEVER-2-7';
    await seedItem(sku);
    await postStockEvent('stock.received', { sku, target_location_id: locAId, quantity: 30, unit_cost: 5 }, daysAgoIso(200));
    await setParams({ sku, location_id: locAId, lead_time_days: 9, lead_time_source: 'seeded', service_level: 0.95, obsolescence_threshold_days: 180, business_stream: 'production' });

    const scan = await makeRequest(port, 'POST', '/api/v1/planning/obsolescence/scan', { sku, location_id: locAId, business_date: BUSINESS_DATE }, plannerHeaders);
    assert.strictEqual(scan.status, 200, JSON.stringify(scan.body));
    const flagged = scan.body['flagged'] as Array<Record<string, unknown>>;
    assert.strictEqual(flagged.length, 1, 'never-issued stock is flagged once past threshold');
    assert.ok(Number(flagged[0]!['days_since_issue']) >= 180, 'response carries real days_since_issue');
  });

  it('review patch: rejects overflowing lead time and zero-quantity direct recommendations cleanly', async () => {
    const lead = await setParams({ sku: 'SS-AC1', location_id: locAId, lead_time_days: 1000000, lead_time_source: 'seeded', service_level: 0.95, business_stream: 'production' });
    assert.strictEqual(lead.status, 400, JSON.stringify(lead.body));
    assert.strictEqual(lead.body['error_code'], 'INVALID_PARAMS');

    const zero = await makeRequest(port, 'POST', '/api/v1/events', {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'replenishment.recommended',
      payload: {
        recommendation_id: randomUUID(),
        sku: 'SS-AC1',
        location_id: locAId,
        on_hand_at_check: 0,
        reorder_point: 1,
        recommended_order_qty: 0,
        triggered_at: new Date().toISOString(),
        business_date: BUSINESS_DATE,
        business_stream: 'production',
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: locAId },
        occurred_at: new Date().toISOString(),
      },
    }, plannerHeaders);
    assert.strictEqual(zero.status, 400, JSON.stringify(zero.body));
    assert.strictEqual(zero.body['error_code'], 'INVALID_PARAMS');
  });
});

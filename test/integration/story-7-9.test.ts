import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { toIstCalendarDate } from '../../src/lib/business-days.js';
import { getSpareCatalogueByGrain } from '../../src/read/projections/maintenance_spare_catalogue.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.9: Spare Min-Max Level Amendment. Extends the Story 7.4 catalogue (FR-M-09) with ONE
// amendment event that updates the existing maintenance_spare_catalogue row in place. Runs against
// the PRODUCTION router surface (createAppRouter) with real auth, RBAC and PostgreSQL, bootstrapped
// exactly like test/integration/story-7-4.test.ts. The maintenance stream is blocked at the
// direct-events HTTP guard, so the seam-enforced codes (SPARE_NOT_CATALOGUED, the critical-needs-min
// INVALID_MIN_MAX) are exercised through direct persistEvent calls - the surface a direct write hits.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

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
    req.setTimeout(15000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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

type SpareRow = Record<string, unknown>;

describe('Story 7.9 Spare Min-Max Level Amendment', () => {
  let server: Server;
  let port: number;
  let storeLocId: string;

  let storekeeperId: string;
  let storekeeperHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;
  let plannerUserId: string;
  let plannerHeaders: Record<string, string>;

  // --- helpers -------------------------------------------------------------

  let skuCounter = 0;
  /** Creates an active item_master row and returns its canonical (lower-case) SKU. */
  async function seedItem(): Promise<string> {
    skuCounter += 1;
    const sku = `sp-${run}-${skuCounter}`;
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
    return sku;
  }

  async function seedLocation(codeSuffix: string): Promise<string> {
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), `LOC-7-9-${run}-${codeSuffix}`, randomUUID()],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function catalogueSpare(
    sku: string,
    locationId: string,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/spares',
      { sku, location_id: locationId, ...extra },
      storekeeperHeaders,
    );
  }

  /** Receives owned stock through the Epic 2 ledger, exactly as Story 7.4 does. */
  async function receiveStock(sku: string, locationId: string, quantity: number): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.received',
        payload: {
          business_stream: 'production',
          sku,
          target_location_id: locationId,
          quantity,
          unit_cost: 5,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: locationId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  }

  async function scan(sku: string): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/spares/scan',
      { business_date: toIstCalendarDate(new Date()), sku },
      storekeeperHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body['breach_scan'] as Record<string, unknown>;
  }

  async function amendSpare(
    body: Record<string, unknown>,
    headers: Record<string, string> = storekeeperHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/maintenance/spares/amend', body, headers);
  }

  /** A catalogued critical spare at storeLocId with min 5 / max 50; returns the created row. */
  async function catalogueCritical(sku: string): Promise<SpareRow> {
    const res = await catalogueSpare(sku, storeLocId, {
      is_critical: true,
      min_level: '5',
      max_level: '50',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body['spare'] as SpareRow;
  }

  async function rowByGrain(sku: string, locationId: string): Promise<SpareRow> {
    const row = await getSpareCatalogueByGrain(sku, locationId);
    assert.ok(row, `catalogue row for ${sku}@${locationId} should exist`);
    return row as unknown as SpareRow;
  }

  async function amendmentEventsFor(catalogueId: string): Promise<Array<Record<string, unknown>>> {
    const result = await getAdminPool().query(
      `SELECT event_id, payload FROM domain_events
        WHERE event_type = 'maintenance.spare_catalogue_amended'
          AND payload->>'catalogue_id' = $1
        ORDER BY created_at`,
      [catalogueId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async function directAmend(payload: Record<string, unknown>): Promise<unknown> {
    return persistEvent({
      stream_type: 'maintenance',
      stream_id: randomUUID(),
      event_type: 'maintenance.spare_catalogue_amended',
      payload,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: storekeeperId, role: 'maintenance_storekeeper', location_id: storeLocId },
        occurred_at: new Date().toISOString(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
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
      '../../read/projections/notification.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/asset.sql',
      '../../read/projections/asset_meter.sql',
      '../../read/projections/asset_meter_reading.sql',
      '../../read/projections/maintenance_plan.sql',
      '../../read/projections/maintenance_work_order.sql',
      '../../read/projections/maintenance_sla_policy.sql',
      '../../read/projections/maintenance_fault_report.sql',
      '../../read/projections/maintenance_downtime.sql',
      '../../read/projections/maintenance_reliability_metric.sql',
      '../../read/projections/maintenance_spare_catalogue.sql',
      '../../read/projections/asset_parts_list.sql',
      '../../read/projections/maintenance_spare_reservation.sql',
      '../../read/projections/maintenance_spare_alert.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE maintenance_spare_alert, maintenance_spare_reservation, asset_parts_list, maintenance_spare_catalogue, maintenance_reliability_metric, maintenance_downtime, maintenance_fault_report, maintenance_sla_policy, maintenance_work_order, maintenance_plan, asset_meter_reading, asset_meter, asset, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    storeLocId = await seedLocation('STORE');

    // The same maintenance_storekeeper fixture shape Story 7.4 uses - no second role is invented.
    storekeeperId = await provisionUser(port, `storekeeper-7-9-${run}@example.com`, [
      {
        role: 'maintenance_storekeeper',
        module: 'maintenance',
        functionScope: 'write',
        locationId: storeLocId,
      },
      {
        role: 'maintenance_storekeeper',
        module: 'maintenance',
        functionScope: 'read',
        locationId: storeLocId,
      },
    ]);
    storekeeperHeaders = await authFor(port, `storekeeper-7-9-${run}@example.com`);

    await provisionUser(port, `reader-7-9-${run}@example.com`, [
      {
        role: `maintenance_reader_7_9_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: storeLocId,
      },
    ]);
    readerHeaders = await authFor(port, `reader-7-9-${run}@example.com`);

    await provisionUser(port, `outsider-7-9-${run}@example.com`, [
      {
        role: `warehouse_worker_7_9_${run}`,
        module: 'warehouse',
        functionScope: 'write',
        locationId: storeLocId,
      },
    ]);
    outsiderHeaders = await authFor(port, `outsider-7-9-${run}@example.com`);

    plannerUserId = await provisionUser(port, `planner-7-9-${run}@example.com`, [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'inventory_planner', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, `planner-7-9-${run}@example.com`);
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: amendment updates the row in place and the event log keeps the history
  // -------------------------------------------------------------------------

  it('AC1: amending a catalogued spare updates min/max in place and records the previous levels on the event', async () => {
    const sku = await seedItem();
    const created = await catalogueCritical(sku);
    const catalogueId = created['catalogue_id'] as string;

    const res = await amendSpare({ sku, location_id: storeLocId, min_level: '8', max_level: '80' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(typeof res.body['event_id'] === 'string', 'event_id is returned');
    const spare = res.body['spare'] as SpareRow;
    assert.strictEqual(spare['catalogue_id'], catalogueId, 'row amended in place, not replaced');
    assert.strictEqual(spare['min_level'], '8.000000');
    assert.strictEqual(spare['max_level'], '80.000000');
    assert.strictEqual(spare['is_critical'], true, 'criticality is untouched by an amendment');

    const row = await rowByGrain(sku, storeLocId);
    assert.strictEqual(row['catalogue_id'], catalogueId, 'the grain still resolves the same row');
    assert.strictEqual(row['min_level'], '8.000000');
    assert.strictEqual(row['max_level'], '80.000000');
    // Normalize both sides: the HTTP body carries an ISO string, the accessor may return a Date.
    assert.ok(
      new Date(row['updated_at'] as string | Date).getTime() >
        new Date(created['updated_at'] as string).getTime(),
      'updated_at moved forward',
    );

    // The event log IS the history: previous levels live on the amendment event's own payload.
    const events = await amendmentEventsFor(catalogueId);
    assert.strictEqual(events.length, 1);
    const payload = events[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['previous_min_level'], '5.000000');
    assert.strictEqual(payload['previous_max_level'], '50.000000');
    assert.strictEqual(payload['min_level'], '8');
    assert.strictEqual(payload['max_level'], '80');
    assert.strictEqual(payload['catalogue_id'], catalogueId, 'catalogue_id is seam-written');
  });

  it('AC1: a second amendment chains the history - its previous levels are the first amendment’s new levels', async () => {
    const sku = await seedItem();
    const catalogueId = (await catalogueCritical(sku))['catalogue_id'] as string;

    assert.strictEqual(
      (await amendSpare({ sku, location_id: storeLocId, min_level: '6', max_level: '60' })).status,
      200,
    );
    assert.strictEqual(
      (await amendSpare({ sku, location_id: storeLocId, min_level: '7', max_level: '70' })).status,
      200,
    );

    const events = await amendmentEventsFor(catalogueId);
    assert.strictEqual(events.length, 2);
    const second = events[1]!['payload'] as Record<string, unknown>;
    assert.strictEqual(second['previous_min_level'], '6.000000');
    assert.strictEqual(second['previous_max_level'], '60.000000');
    const row = await rowByGrain(sku, storeLocId);
    assert.strictEqual(row['min_level'], '7.000000');
    assert.strictEqual(row['max_level'], '70.000000');
  });

  it('AC1: a SKU typed in a different case amends the same row (canonicalization in handler and seam)', async () => {
    const sku = await seedItem();
    const catalogueId = (await catalogueCritical(sku))['catalogue_id'] as string;
    const res = await amendSpare({
      sku: `  ${sku.toUpperCase()} `,
      location_id: storeLocId,
      min_level: '9',
      max_level: '90',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((res.body['spare'] as SpareRow)['catalogue_id'], catalogueId);
  });

  it('AC1: a non-critical spare can have both levels cleared to null', async () => {
    const sku = await seedItem();
    const created = await catalogueSpare(sku, storeLocId, { min_level: '1', max_level: '10' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));

    const res = await amendSpare({
      sku,
      location_id: storeLocId,
      min_level: null,
      max_level: null,
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const spare = res.body['spare'] as SpareRow;
    assert.strictEqual(spare['min_level'], null);
    assert.strictEqual(spare['max_level'], null);
    const payload = (await amendmentEventsFor(spare['catalogue_id'] as string))[0]![
      'payload'
    ] as Record<string, unknown>;
    assert.strictEqual(payload['previous_min_level'], '1.000000');
    assert.strictEqual(payload['previous_max_level'], '10.000000');
  });

  it('AC1: the next breach sweep evaluates against the amended min, not the catalogued one', async () => {
    const sku = await seedItem();
    await catalogueSpare(sku, storeLocId, { is_critical: true, min_level: '2', max_level: '20' });
    await receiveStock(sku, storeLocId, 5);

    const beforeAmend = await scan(sku);
    assert.strictEqual(beforeAmend['grains_evaluated'], 1);
    assert.strictEqual(beforeAmend['breaches_flagged'], 0, 'on_hand 5 is above the original min 2');

    const res = await amendSpare({ sku, location_id: storeLocId, min_level: '8', max_level: '20' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const afterAmend = await scan(sku);
    assert.strictEqual(
      afterAmend['breaches_flagged'],
      1,
      'on_hand 5 is at or below the amended min 8',
    );
  });

  // -------------------------------------------------------------------------
  // AC 2: refused with an explicit error_code and no row change
  // -------------------------------------------------------------------------

  it('AC2 guard: max below min is INVALID_MIN_MAX and the row is unchanged', async () => {
    const sku = await seedItem();
    await catalogueCritical(sku);
    const before = await rowByGrain(sku, storeLocId);

    const res = await amendSpare({ sku, location_id: storeLocId, min_level: '10', max_level: '2' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_MIN_MAX');

    assert.deepStrictEqual(await rowByGrain(sku, storeLocId), before);
    assert.strictEqual((await amendmentEventsFor(before['catalogue_id'] as string)).length, 0);
  });

  it('AC2 guard: a malformed level is INVALID_MIN_MAX before any event is minted', async () => {
    const sku = await seedItem();
    await catalogueCritical(sku);
    const before = await rowByGrain(sku, storeLocId);

    const res = await amendSpare({
      sku,
      location_id: storeLocId,
      min_level: 'lots',
      max_level: '9',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_MIN_MAX');
    assert.deepStrictEqual(await rowByGrain(sku, storeLocId), before);
  });

  it('AC2 guard: an uncatalogued (sku, location) grain is 422 SPARE_NOT_CATALOGUED on the route', async () => {
    const sku = await seedItem();
    const res = await amendSpare({ sku, location_id: storeLocId, min_level: '1', max_level: '2' });
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SPARE_NOT_CATALOGUED');
    assert.strictEqual(await getSpareCatalogueByGrain(sku, storeLocId), null);
  });

  it('AC2 guard: the direct-event path for an uncatalogued grain hits the SAME SPARE_NOT_CATALOGUED from the seam', async () => {
    const sku = await seedItem();
    await assert.rejects(
      () => directAmend({ sku, location_id: storeLocId, min_level: '1', max_level: '2' }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'SPARE_NOT_CATALOGUED');
        assert.strictEqual((err as { statusCode: number }).statusCode, 422);
        return true;
      },
    );
    assert.strictEqual(await getSpareCatalogueByGrain(sku, storeLocId), null);
  });

  it('AC2 guard: clearing min_level on a critical spare is INVALID_MIN_MAX through the route', async () => {
    const sku = await seedItem();
    await catalogueCritical(sku);
    const before = await rowByGrain(sku, storeLocId);

    const res = await amendSpare({
      sku,
      location_id: storeLocId,
      min_level: null,
      max_level: '50',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_MIN_MAX');
    assert.deepStrictEqual(await rowByGrain(sku, storeLocId), before);
    assert.strictEqual((await amendmentEventsFor(before['catalogue_id'] as string)).length, 0);
  });

  it('AC2 guard: clearing min_level on a critical spare is INVALID_MIN_MAX on the direct-event path too (needs the locked row)', async () => {
    const sku = await seedItem();
    await catalogueCritical(sku);
    const before = await rowByGrain(sku, storeLocId);

    await assert.rejects(
      () => directAmend({ sku, location_id: storeLocId, min_level: null, max_level: '50' }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'INVALID_MIN_MAX');
        assert.strictEqual((err as { statusCode: number }).statusCode, 400);
        return true;
      },
    );
    assert.deepStrictEqual(await rowByGrain(sku, storeLocId), before);
  });

  it('AC2 guard: direct-event max below min is INVALID_MIN_MAX from the pure shape assert', async () => {
    const sku = await seedItem();
    await catalogueCritical(sku);
    await assert.rejects(
      () => directAmend({ sku, location_id: storeLocId, min_level: '10', max_level: '2' }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'INVALID_MIN_MAX');
        return true;
      },
    );
  });

  it('validation: sku and a UUID location_id are required', async () => {
    const missingSku = await amendSpare({
      location_id: storeLocId,
      min_level: '1',
      max_level: '2',
    });
    assert.strictEqual(missingSku.status, 400, JSON.stringify(missingSku.body));
    assert.strictEqual(missingSku.body['error_code'], 'INVALID_PARAMS');

    const badLoc = await amendSpare({
      sku: 'x',
      location_id: 'nope',
      min_level: '1',
      max_level: '2',
    });
    assert.strictEqual(badLoc.status, 400, JSON.stringify(badLoc.body));
    assert.strictEqual(badLoc.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 3: amendment is the ONLY edit path - the create route still refuses
  // -------------------------------------------------------------------------

  it('AC3: after an amendment, a second POST of the original catalogue shape is still 409 SPARE_ALREADY_CATALOGUED', async () => {
    const sku = await seedItem();
    const catalogueId = (await catalogueCritical(sku))['catalogue_id'] as string;
    assert.strictEqual(
      (await amendSpare({ sku, location_id: storeLocId, min_level: '3', max_level: '30' })).status,
      200,
    );

    const again = await catalogueSpare(sku, storeLocId, {
      is_critical: true,
      min_level: '1',
      max_level: '100',
    });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'SPARE_ALREADY_CATALOGUED');

    // And the create route did not sneak the new levels in.
    const row = await rowByGrain(sku, storeLocId);
    assert.strictEqual(row['catalogue_id'], catalogueId);
    assert.strictEqual(row['min_level'], '3.000000');
    assert.strictEqual(row['max_level'], '30.000000');
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('idempotency: replaying an amendment key returns the same event and catalogue_id and amends exactly once', async () => {
    const sku = await seedItem();
    const catalogueId = (await catalogueCritical(sku))['catalogue_id'] as string;

    const key = randomUUID();
    const first = await amendSpare({
      sku,
      location_id: storeLocId,
      min_level: '11',
      max_level: '110',
      idempotency_key: key,
    });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    const replay = await amendSpare({
      sku,
      location_id: storeLocId,
      min_level: '11',
      max_level: '110',
      idempotency_key: key,
    });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual((replay.body['spare'] as SpareRow)['catalogue_id'], catalogueId);

    const events = await amendmentEventsFor(catalogueId);
    assert.strictEqual(events.length, 1, 'the ledger did not grow on replay');
    assert.strictEqual(
      (events[0]!['payload'] as Record<string, unknown>)['previous_min_level'],
      '5.000000',
      'the single amendment still records the ORIGINAL previous levels',
    );
  });

  it('idempotency: reusing an amendment key across event types is DUPLICATE_EVENT', async () => {
    const sku = await seedItem();
    await catalogueCritical(sku);
    const key = randomUUID();
    assert.strictEqual(
      (
        await amendSpare({
          sku,
          location_id: storeLocId,
          min_level: '2',
          max_level: '20',
          idempotency_key: key,
        })
      ).status,
      200,
    );
    const other = await seedItem();
    const reused = await catalogueSpare(other, storeLocId, { idempotency_key: key });
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    assert.strictEqual(reused.body['error_code'], 'DUPLICATE_EVENT');
  });

  // -------------------------------------------------------------------------
  // RBAC
  // -------------------------------------------------------------------------

  it('RBAC: no token is 401; an outsider module is 403; a read-scoped maintenance caller is 403', async () => {
    const sku = await seedItem();
    await catalogueCritical(sku);
    const body = { sku, location_id: storeLocId, min_level: '1', max_level: '2' };

    const anonymous = await amendSpare(body, {});
    assert.strictEqual(anonymous.status, 401, JSON.stringify(anonymous.body));

    const outsider = await amendSpare(body, outsiderHeaders);
    assert.strictEqual(outsider.status, 403, JSON.stringify(outsider.body));

    const reader = await amendSpare(body, readerHeaders);
    assert.strictEqual(reader.status, 403, JSON.stringify(reader.body));

    // None of the refusals touched the row.
    const row = await rowByGrain(sku, storeLocId);
    assert.strictEqual(row['min_level'], '5.000000');
    assert.strictEqual(row['max_level'], '50.000000');
  });
});

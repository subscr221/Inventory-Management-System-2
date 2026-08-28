import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { addBusinessDays, toIstCalendarDate } from '../../src/lib/business-days.js';
import { config } from '../../src/config/index.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.4: Spare Parts Cataloguing, Reservation, and Critical-Spares Alerts (FR-M-07, FR-M-08,
// FR-M-09). Runs against the PRODUCTION router surface (createAppRouter) with real auth, RBAC and
// PostgreSQL - no mocks of the DB or the event store. The harness is the Story 7.3 pattern
// extended with the Epic 2 item/location/stock projections this story rides on.
//
// Time is controlled through the explicit business_date parameters of the scan job and through
// direct return_due_date manipulation for the overdue sweep, so no clock mocking is needed. The
// maintenance stream is blocked at the direct-events HTTP guard (INVALID_EVENT_STREAM), so the
// seam-level rejection codes (SPARE_DERIVATION_MISMATCH, DUPLICATE_SPARE_ALERT) are exercised
// through direct persistEvent calls - the enforcement surface a direct write would hit.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

function detailsOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
}

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

/** The IST calendar date of "now", the same anchor the issue applier uses for the return clock. */
function istToday(): string {
  return toIstCalendarDate(new Date());
}

/** Whole-day UTC arithmetic on an ISO date, matching the job and handler helpers. */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(y!, m! - 1, d!) + days * 86400000).toISOString().slice(0, 10);
}

describe('Story 7.4 Spare Parts Cataloguing, Reservation and Critical-Spares Alerts', () => {
  let server: Server;
  let port: number;
  let storeLocId: string;
  let otherLocId: string;

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
      [randomUUID(), `LOC-7-4-${run}-${codeSuffix}`, randomUUID()],
    );
    return r.rows[0]!['location_id'] as string;
  }

  /** Receives owned stock through the Epic 2 ledger, the only way stock enters this suite. */
  async function receiveStock(
    sku: string,
    locationId: string,
    quantity: number,
  ): Promise<HttpResult> {
    return makeRequest(
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
  }

  interface BalanceSnapshot {
    on_hand: number;
    allocated: number;
    available: number;
  }

  async function balanceOf(sku: string, locationId: string): Promise<BalanceSnapshot> {
    const r = await getAdminPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float8 AS on_hand,
              COALESCE(SUM(allocated), 0)::float8 AS allocated,
              COALESCE(SUM(available), 0)::float8 AS available
         FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'`,
      [sku, locationId],
    );
    return r.rows[0] as unknown as BalanceSnapshot;
  }

  /** Asserts the generated-column invariant that every ledger movement must preserve. */
  async function assertLedgerInvariant(
    sku: string,
    locationId: string,
    expected: { on_hand: number; allocated: number },
    label: string,
  ): Promise<void> {
    const balance = await balanceOf(sku, locationId);
    assert.strictEqual(balance.on_hand, expected.on_hand, `${label}: on_hand`);
    assert.strictEqual(balance.allocated, expected.allocated, `${label}: allocated`);
    assert.strictEqual(
      balance.available,
      expected.on_hand - expected.allocated,
      `${label}: available must equal on_hand - allocated`,
    );
  }

  async function createAsset(criticalityClass: string = 'critical'): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-7-4-${randomUUID().slice(0, 12)}`,
        asset_name: `Asset ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: criticalityClass,
      },
      storekeeperHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_id']!;
  }

  /**
   * An OPEN breakdown work order, built through the real Story 7.3 path (policy, fault report,
   * acceptance) rather than an inserted row, so the reservation tests run against a work order the
   * system actually produced.
   */
  const policyDefinedFor: Set<string> = new Set();
  async function openWorkOrder(criticalityClass: string = 'medium'): Promise<{
    workOrderId: string;
    assetId: string;
  }> {
    if (!policyDefinedFor.has(criticalityClass)) {
      const policy = await makeRequest(
        port,
        'POST',
        '/api/v1/maintenance/sla-policies',
        {
          criticality_class: criticalityClass,
          safety_flag: false,
          priority: 'p3',
          response_minutes: 60,
          resolution_hours: 24,
        },
        storekeeperHeaders,
      );
      assert.strictEqual(policy.status, 201, JSON.stringify(policy.body));
      policyDefinedFor.add(criticalityClass);
    }
    const assetId = await createAsset(criticalityClass);
    const fault = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/fault-reports',
      { asset_id: assetId, description: `Spares needed ${randomUUID().slice(0, 6)}` },
      storekeeperHeaders,
    );
    assert.strictEqual(fault.status, 201, JSON.stringify(fault.body));
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;
    const accepted = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/accept`,
      {},
      storekeeperHeaders,
    );
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    const workOrderId = (accepted.body['work_order'] as Record<string, string>)['work_order_id']!;
    return { workOrderId, assetId };
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

  async function addPart(
    assetId: string,
    sku: string,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/parts`,
      { sku, quantity_per: '2', ...extra },
      storekeeperHeaders,
    );
  }

  async function reserve(
    workOrderId: string,
    sku: string,
    locationId: string,
    quantity: string,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/spare-reservations`,
      { sku, location_id: locationId, quantity, ...extra },
      storekeeperHeaders,
    );
  }

  async function issue(
    reservationId: string,
    businessDate: string = istToday(),
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/spare-reservations/${reservationId}/issue`,
      { business_date: businessDate, ...extra },
      storekeeperHeaders,
    );
  }

  async function returnSpare(
    reservationId: string,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/spare-reservations/${reservationId}/return`,
      body,
      storekeeperHeaders,
    );
  }

  async function cancel(
    reservationId: string,
    reason: string = 'Work order rescoped',
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/spare-reservations/${reservationId}/cancel`,
      { cancellation_reason: reason },
      storekeeperHeaders,
    );
  }

  async function scan(
    businessDate: string,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/spares/scan',
      { business_date: businessDate, ...extra },
      storekeeperHeaders,
    );
  }

  /** Counts notification.created domain events for one object and business event type. */
  async function notificationFor(
    objectId: string,
    eventType: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role,
              payload->'target'->>'location_id' AS location_id,
              payload->>'next_step' AS next_step,
              payload->>'actor_label' AS actor_label,
              payload->'escalation'->>'target_role' AS escalation_role,
              payload->'escalation'->>'acknowledgment_window_seconds' AS escalation_window
         FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = $2`,
      [objectId, eventType],
    );
    const row = result.rows[0];
    return row ? (row as Record<string, unknown>) : null;
  }

  /**
   * Replicates src/notify/dispatch.ts resolveTargetUserIds exactly. A notification aimed at a role
   * no user holds fans out to zero recipients and still reports success, so asserting the event
   * exists is NOT enough to prove the alert is deliverable.
   */
  async function recipientCountFor(role: string, locationId: string): Promise<number> {
    const result = await getAdminPool().query(
      `SELECT count(DISTINCT user_id)::int AS n FROM user_role_assignments
        WHERE role = $1 AND (location_id = $2 OR location_id = '*')`,
      [role, locationId],
    );
    return result.rows[0]!['n'] as number;
  }

  async function domainEventCountFor(
    eventType: string,
    payloadIdField: string,
    payloadId: string,
  ): Promise<number> {
    const result = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE event_type = $1 AND payload->>$2 = $3`,
      [eventType, payloadIdField, payloadId],
    );
    return result.rows[0]!['n'] as number;
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
    otherLocId = await seedLocation('OTHER');

    // The storekeeper holds the LITERAL role the breach notification targets. Provisioning it
    // under a run-suffixed name would leave the alert undeliverable in production while the suite
    // still passed, which is exactly the failure this user exists to catch.
    storekeeperId = await provisionUser(port, `storekeeper-7-4-${run}@example.com`, [
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
    storekeeperHeaders = await authFor(port, `storekeeper-7-4-${run}@example.com`);

    await provisionUser(port, `reader-7-4-${run}@example.com`, [
      {
        role: `maintenance_reader_7_4_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: storeLocId,
      },
    ]);
    readerHeaders = await authFor(port, `reader-7-4-${run}@example.com`);

    await provisionUser(port, `outsider-7-4-${run}@example.com`, [
      {
        role: `warehouse_worker_7_4_${run}`,
        module: 'warehouse',
        functionScope: 'write',
        locationId: storeLocId,
      },
    ]);
    outsiderHeaders = await authFor(port, `outsider-7-4-${run}@example.com`);

    plannerUserId = await provisionUser(port, `planner-7-4-${run}@example.com`, [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'inventory_planner', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, `planner-7-4-${run}@example.com`);
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: maintenance-owned asset parts list with where-used
  // -------------------------------------------------------------------------

  it('AC1: a spare listed against an asset shows where-used with the asset tag, name and criticality', async () => {
    const sku = await seedItem();
    const assetId = await createAsset('high');

    const added = await addPart(assetId, sku, { quantity_per: '4', position_ref: 'DRIVE-END' });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    const part = added.body['part'] as Record<string, unknown>;
    assert.strictEqual(part['asset_id'], assetId);
    assert.strictEqual(part['sku'], sku);
    assert.strictEqual(part['quantity_per'], '4.000000');
    assert.strictEqual(part['position_ref'], 'DRIVE-END');

    const whereUsed = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spares/${sku}/where-used`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(whereUsed.status, 200, JSON.stringify(whereUsed.body));
    const usages = whereUsed.body['where_used'] as Array<Record<string, unknown>>;
    assert.strictEqual(usages.length, 1);
    assert.strictEqual(usages[0]!['asset_id'], assetId);
    assert.strictEqual(usages[0]!['criticality_class'], 'high');
    assert.ok(usages[0]!['asset_tag'], 'where-used must carry the scannable asset tag');
    assert.ok(usages[0]!['asset_name'], 'where-used must carry the asset name');
  });

  it('AC1: where-used spans every asset whose parts list references the spare', async () => {
    const sku = await seedItem();
    const assetOne = await createAsset('low');
    const assetTwo = await createAsset('medium');
    assert.strictEqual((await addPart(assetOne, sku)).status, 201);
    assert.strictEqual((await addPart(assetTwo, sku)).status, 201);

    const whereUsed = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spares/${sku}/where-used`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(whereUsed.status, 200, JSON.stringify(whereUsed.body));
    const ids = (whereUsed.body['where_used'] as Array<Record<string, unknown>>).map(
      (u) => u['asset_id'],
    );
    assert.deepStrictEqual([...ids].sort(), [assetOne, assetTwo].sort());
  });

  it('AC1: the parts list is the asset-side read of the same rows', async () => {
    const sku = await seedItem();
    const assetId = await createAsset();
    assert.strictEqual((await addPart(assetId, sku)).status, 201);

    const parts = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/parts`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(parts.status, 200, JSON.stringify(parts.body));
    const rows = parts.body['parts'] as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['sku'], sku);
  });

  it('AC1: a SKU typed in a different case resolves to the same parts-list row', async () => {
    const sku = await seedItem();
    const assetId = await createAsset();
    assert.strictEqual((await addPart(assetId, sku.toUpperCase())).status, 201);

    // Canonicalized on the way in, so the where-used lookup by either case finds it.
    const upper = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spares/${sku.toUpperCase()}/where-used`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(upper.status, 200, JSON.stringify(upper.body));
    assert.strictEqual((upper.body['where_used'] as unknown[]).length, 1);
  });

  it('AC1 guard: a second listing of the same spare on one asset is ASSET_PART_ALREADY_LISTED', async () => {
    const sku = await seedItem();
    const assetId = await createAsset();
    const first = await addPart(assetId, sku);
    assert.strictEqual(first.status, 201);

    const second = await addPart(assetId, sku);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'ASSET_PART_ALREADY_LISTED');
    assert.strictEqual(
      detailsOf(second.body)?.['existing_part_line_id'],
      (first.body['part'] as Record<string, unknown>)['part_line_id'],
    );
  });

  it('AC1 guard: listing a part on an unknown asset is ASSET_NOT_FOUND', async () => {
    const sku = await seedItem();
    const res = await addPart(randomUUID(), sku);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ASSET_NOT_FOUND');
  });

  it('AC1 guard: listing a part for a SKU absent from item_master is ITEM_NOT_FOUND', async () => {
    const assetId = await createAsset();
    const res = await addPart(assetId, `ghost-${run}`);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ITEM_NOT_FOUND');
  });

  it('AC1 guard: a non-positive quantity_per is rejected before any write', async () => {
    const sku = await seedItem();
    const assetId = await createAsset();
    const res = await addPart(assetId, sku, { quantity_per: '0' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 2: cataloguing under the Epic 2 stock ledger
  // -------------------------------------------------------------------------

  it('AC2: a spare is catalogued at a location with its min-max levels', async () => {
    const sku = await seedItem();
    const res = await catalogueSpare(sku, storeLocId, {
      is_critical: true,
      min_level: '5',
      max_level: '50',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const spare = res.body['spare'] as Record<string, unknown>;
    assert.strictEqual(spare['sku'], sku);
    assert.strictEqual(spare['location_id'], storeLocId);
    assert.strictEqual(spare['is_critical'], true);
    assert.strictEqual(spare['min_level'], '5.000000');
    assert.strictEqual(spare['max_level'], '50.000000');
  });

  it('AC2: the same spare can be catalogued independently at a second location', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    const other = await catalogueSpare(sku, otherLocId, { is_critical: true, min_level: '2' });
    assert.strictEqual(other.status, 201, JSON.stringify(other.body));
  });

  it('AC2 guard: re-cataloguing the same grain is SPARE_ALREADY_CATALOGUED', async () => {
    const sku = await seedItem();
    const first = await catalogueSpare(sku, storeLocId);
    assert.strictEqual(first.status, 201);
    const second = await catalogueSpare(sku, storeLocId);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'SPARE_ALREADY_CATALOGUED');
    assert.strictEqual(
      detailsOf(second.body)?.['existing_catalogue_id'],
      (first.body['spare'] as Record<string, unknown>)['catalogue_id'],
    );
  });

  it('AC2 guard: cataloguing a SKU absent from item_master is ITEM_NOT_FOUND', async () => {
    const res = await catalogueSpare(`ghost-${run}`, storeLocId);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ITEM_NOT_FOUND');
  });

  it('AC2 guard: cataloguing at an unknown location is LOCATION_NOT_FOUND', async () => {
    const sku = await seedItem();
    const res = await catalogueSpare(sku, randomUUID());
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_NOT_FOUND');
  });

  it('AC2 guard: max below min, and a critical spare with no minimum, are both INVALID_MIN_MAX', async () => {
    const sku = await seedItem();
    const inverted = await catalogueSpare(sku, storeLocId, { min_level: '10', max_level: '2' });
    assert.strictEqual(inverted.status, 400, JSON.stringify(inverted.body));
    assert.strictEqual(inverted.body['error_code'], 'INVALID_MIN_MAX');

    // A critical spare with no minimum would be silently invisible to the FR-M-09 scan.
    const noMin = await catalogueSpare(sku, storeLocId, { is_critical: true });
    assert.strictEqual(noMin.status, 400, JSON.stringify(noMin.body));
    assert.strictEqual(noMin.body['error_code'], 'INVALID_MIN_MAX');
  });

  // -------------------------------------------------------------------------
  // AC 2: reserve, issue, return and cancel against the Epic 2 ledger
  // -------------------------------------------------------------------------

  it('AC2: reserving raises allocated and lowers available without touching on_hand', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 20)).status, 201);
    const { workOrderId } = await openWorkOrder();

    const res = await reserve(workOrderId, sku, storeLocId, '6');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const reservation = res.body['reservation'] as Record<string, unknown>;
    assert.strictEqual(reservation['status'], 'reserved');
    assert.strictEqual(reservation['quantity'], '6.000000');
    assert.strictEqual(reservation['work_order_id'], workOrderId);
    assert.strictEqual(reservation['return_due_date'], null);

    await assertLedgerInvariant(sku, storeLocId, { on_hand: 20, allocated: 6 }, 'after reserve');
  });

  it('AC2: issuing the full available quantity succeeds - the allocation is released before the draw', async () => {
    // The reservation holds the ONLY free stock at this location. applyStockIssue gates on
    // `available`, which is already net of that allocation, so an issue-before-deallocate ordering
    // fails here with a spurious INSUFFICIENT_STOCK. This is the ordering regression test.
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 7)).status, 201);
    const { workOrderId } = await openWorkOrder();

    const reserved = await reserve(workOrderId, sku, storeLocId, '7');
    assert.strictEqual(reserved.status, 201, JSON.stringify(reserved.body));
    await assertLedgerInvariant(
      sku,
      storeLocId,
      { on_hand: 7, allocated: 7 },
      'fully reserved, available is zero',
    );

    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    const issued = await issue(reservationId);
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    assert.strictEqual((issued.body['reservation'] as Record<string, unknown>)['status'], 'issued');
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 0, allocated: 0 }, 'after issue');
  });

  it('AC2: issuing freezes a return_due_date three business days out', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;

    const issued = await issue(reservationId);
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const reservation = issued.body['reservation'] as Record<string, unknown>;
    const expected = addBusinessDays(
      istToday(),
      config.maintenance.spareReturnBusinessDays,
      config.maintenance.spareReturnHolidayCalendar,
    );
    assert.strictEqual(reservation['return_due_date'], expected);
    assert.ok(reservation['issued_at'], 'issued_at must be stamped');
  });

  it('AC2: a full return puts the stock back and closes the reservation', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 10)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '4');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 6, allocated: 0 }, 'after issue');

    const returned = await returnSpare(reservationId);
    assert.strictEqual(returned.status, 200, JSON.stringify(returned.body));
    const reservation = returned.body['reservation'] as Record<string, unknown>;
    assert.strictEqual(reservation['status'], 'returned');
    assert.strictEqual(reservation['quantity_returned'], '4.000000');
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 10, allocated: 0 }, 'after return');
  });

  it('AC2: a partial return leaves the reservation open until the balance comes back', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 10)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '4');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    const partial = await returnSpare(reservationId, { quantity_returned: '1' });
    assert.strictEqual(partial.status, 200, JSON.stringify(partial.body));
    assert.strictEqual(
      (partial.body['reservation'] as Record<string, unknown>)['status'],
      'partially_returned',
    );
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 7, allocated: 0 }, 'after partial');

    const rest = await returnSpare(reservationId, { quantity_returned: '3' });
    assert.strictEqual(rest.status, 200, JSON.stringify(rest.body));
    assert.strictEqual((rest.body['reservation'] as Record<string, unknown>)['status'], 'returned');
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 10, allocated: 0 }, 'after balance');
  });

  it('AC2: cancelling a reservation releases the allocation instead of stranding it', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 8)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '3');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 8, allocated: 3 }, 'reserved');

    const cancelled = await cancel(reservationId);
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.strictEqual(
      (cancelled.body['reservation'] as Record<string, unknown>)['status'],
      'cancelled',
    );
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 8, allocated: 0 }, 'after cancel');
  });

  it('AC2 guard: reserving an uncatalogued spare is SPARE_NOT_CATALOGUED', async () => {
    const sku = await seedItem();
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const res = await reserve(workOrderId, sku, storeLocId, '1');
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SPARE_NOT_CATALOGUED');
  });

  it('AC2 guard: reserving beyond available stock is INSUFFICIENT_STOCK with the Epic 2 detail', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 2)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const res = await reserve(workOrderId, sku, storeLocId, '3');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(detailsOf(res.body)?.['available_quantity'], 2);
    // The rejected reservation rolled back with the ledger: nothing is held.
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 2, allocated: 0 }, 'after rejection');
  });

  it('AC2 guard: reserving against an unknown work order is WORK_ORDER_NOT_FOUND', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    const res = await reserve(randomUUID(), sku, storeLocId, '1');
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WORK_ORDER_NOT_FOUND');
  });

  it('AC2 guard: reserving against a completed work order is WORK_ORDER_NOT_OPEN', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const completed = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      {
        // Story 7.8 (FR-M-18, Binding Decision 8): a breakdown closure carries the three codes.
        fault_code: config.maintenance.closureCodes.fault[0],
        cause_code: config.maintenance.closureCodes.cause[0],
        remedy_code: config.maintenance.closureCodes.remedy[0],
      },
      storekeeperHeaders,
    );
    assert.strictEqual(completed.status, 200, JSON.stringify(completed.body));

    const res = await reserve(workOrderId, sku, storeLocId, '1');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WORK_ORDER_NOT_OPEN');
  });

  it('AC2 guard: issuing twice, and cancelling an issued reservation, are RESERVATION_NOT_RESERVED', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    const again = await issue(reservationId);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'RESERVATION_NOT_RESERVED');

    const cancelled = await cancel(reservationId);
    assert.strictEqual(cancelled.status, 409, JSON.stringify(cancelled.body));
    assert.strictEqual(cancelled.body['error_code'], 'RESERVATION_NOT_RESERVED');
    // The double-issue attempt drew nothing extra from the ledger.
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 3, allocated: 0 }, 'unchanged');
  });

  it('AC2 guard: returning a reservation that was never issued is RESERVATION_NOT_ISSUED', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;

    const res = await returnSpare(reservationId, { quantity_returned: '1' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RESERVATION_NOT_ISSUED');
  });

  it('AC2 guard: returning more than was issued is RETURN_QUANTITY_EXCEEDS_ISSUED, never clamped', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    const res = await returnSpare(reservationId, { quantity_returned: '3' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RETURN_QUANTITY_EXCEEDS_ISSUED');
    // Nothing was put back: an over-return must not inflate the ledger.
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 3, allocated: 0 }, 'unchanged');
  });

  it('AC2 guard: issue, return and cancel on an unknown reservation are RESERVATION_NOT_FOUND', async () => {
    const ghost = randomUUID();
    for (const res of [
      await issue(ghost),
      await returnSpare(ghost, { quantity_returned: '1' }),
      await cancel(ghost),
    ]) {
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'RESERVATION_NOT_FOUND');
    }
  });

  it('AC2 guard: a direct event declaring the wrong asset_id is SPARE_DERIVATION_MISMATCH', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();

    await assert.rejects(
      () =>
        persistEvent({
          stream_type: 'maintenance',
          stream_id: randomUUID(),
          event_type: 'maintenance.spare_reserved',
          payload: {
            reservation_id: randomUUID(),
            work_order_id: workOrderId,
            asset_id: randomUUID(), // not the work order's asset
            sku,
            location_id: storeLocId,
            lot_id: null,
            quantity: '1',
            reserved_at: new Date().toISOString(),
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: {
              user_id: storekeeperId,
              role: 'maintenance_storekeeper',
              location_id: storeLocId,
            },
            occurred_at: new Date().toISOString(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'SPARE_DERIVATION_MISMATCH');
        return true;
      },
    );
    // The rejected direct event held no stock.
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 5, allocated: 0 }, 'after rejection');
  });

  it('AC2 guard: a direct event declaring a fabricated return_due_date is SPARE_DERIVATION_MISMATCH', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    const now = new Date().toISOString();

    await assert.rejects(
      () =>
        persistEvent({
          stream_type: 'maintenance',
          stream_id: reservationId,
          event_type: 'maintenance.spare_issued',
          payload: {
            reservation_id: reservationId,
            quantity: '2',
            issued_at: now,
            return_due_date: addDays(istToday(), 90), // a deadline the clock never produces
            business_date: istToday(),
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: {
              user_id: storekeeperId,
              role: 'maintenance_storekeeper',
              location_id: storeLocId,
            },
            occurred_at: now,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'SPARE_DERIVATION_MISMATCH');
        return true;
      },
    );
  });

  // -------------------------------------------------------------------------
  // AC 3: critical-spares min-max breach alerts
  // -------------------------------------------------------------------------

  it('AC3: a critical spare at or below its minimum raises a same-day alert and notifies a real storekeeper', async () => {
    const sku = await seedItem();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { is_critical: true, min_level: '10' })).status,
      201,
    );
    assert.strictEqual((await receiveStock(sku, storeLocId, 10)).status, 201);
    const businessDate = istToday();

    const res = await scan(businessDate, { sku });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const breach = res.body['breach_scan'] as Record<string, unknown>;
    assert.strictEqual(breach['grains_evaluated'], 1);
    assert.strictEqual(breach['breaches_flagged'], 1);
    assert.strictEqual(breach['notifications_sent'], 1);

    const alertId = (breach['alert_ids'] as string[])[0]!;
    const alerts = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spares/alerts?sku=${sku}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(alerts.status, 200, JSON.stringify(alerts.body));
    const rows = alerts.body['alerts'] as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['alert_type'], 'min_breach');
    assert.strictEqual(rows[0]!['business_date'], businessDate);
    assert.strictEqual(rows[0]!['on_hand_at_check'], '10.000000');
    assert.strictEqual(rows[0]!['min_level'], '10.000000');

    const notification = await notificationFor(alertId, 'critical_spare_breach');
    assert.ok(notification, 'a breach notification event must exist');
    assert.strictEqual(notification!['role'], 'maintenance_storekeeper');
    assert.strictEqual(notification!['location_id'], storeLocId);

    // The role must actually resolve to a user, or the alert fans out to nobody and still
    // reports success. This is the assertion that makes the notification real.
    assert.ok(
      (await recipientCountFor('maintenance_storekeeper', storeLocId)) >= 1,
      'the breach notification must resolve to at least one recipient',
    );
  });

  it('AC3: re-running the scan on the same business_date does not duplicate the alert', async () => {
    const sku = await seedItem();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { is_critical: true, min_level: '4' })).status,
      201,
    );
    assert.strictEqual((await receiveStock(sku, storeLocId, 1)).status, 201);
    const businessDate = istToday();

    const first = await scan(businessDate, { sku });
    assert.strictEqual(
      (first.body['breach_scan'] as Record<string, unknown>)['breaches_flagged'],
      1,
    );

    const second = await scan(businessDate, { sku });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    const breach = second.body['breach_scan'] as Record<string, unknown>;
    assert.strictEqual(breach['grains_evaluated'], 1, 'the grain is still evaluated');
    assert.strictEqual(breach['breaches_flagged'], 0, 'but no second alert is written');
    assert.strictEqual(breach['notifications_sent'], 0);

    const alerts = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spares/alerts?sku=${sku}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((alerts.body['alerts'] as unknown[]).length, 1);
  });

  it('AC3: a critical spare above its minimum raises nothing, and its recovery is the absence of a row', async () => {
    const sku = await seedItem();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { is_critical: true, min_level: '3' })).status,
      201,
    );
    assert.strictEqual((await receiveStock(sku, storeLocId, 12)).status, 201);

    const res = await scan(istToday(), { sku });
    const breach = res.body['breach_scan'] as Record<string, unknown>;
    assert.strictEqual(breach['grains_evaluated'], 1);
    assert.strictEqual(breach['breaches_flagged'], 0);

    const alerts = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spares/alerts?sku=${sku}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((alerts.body['alerts'] as unknown[]).length, 0);
  });

  it('AC3: a non-critical spare below zero stock is never scanned', async () => {
    const sku = await seedItem();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { is_critical: false, min_level: '99' })).status,
      201,
    );
    const res = await scan(istToday(), { sku });
    const breach = res.body['breach_scan'] as Record<string, unknown>;
    assert.strictEqual(breach['grains_evaluated'], 0, 'a non-critical grain is out of scope');
    assert.strictEqual(breach['breaches_flagged'], 0);
  });

  it('AC3: the breach comparison uses on_hand, so a fully reserved but present spare is not a stockout', async () => {
    const sku = await seedItem();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { is_critical: true, min_level: '5' })).status,
      201,
    );
    assert.strictEqual((await receiveStock(sku, storeLocId, 20)).status, 201);
    const { workOrderId } = await openWorkOrder();
    // Reserve everything: `available` is now 0, but the stock is physically in the store.
    assert.strictEqual((await reserve(workOrderId, sku, storeLocId, '20')).status, 201);

    const res = await scan(istToday(), { sku });
    const breach = res.body['breach_scan'] as Record<string, unknown>;
    assert.strictEqual(breach['breaches_flagged'], 0, 'reserved stock is still on hand');
  });

  it('AC3 guard: a direct duplicate alert event for the same grain and day is DUPLICATE_SPARE_ALERT', async () => {
    const sku = await seedItem();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { is_critical: true, min_level: '9' })).status,
      201,
    );
    assert.strictEqual((await receiveStock(sku, storeLocId, 2)).status, 201);
    const businessDate = istToday();
    assert.strictEqual(
      ((await scan(businessDate, { sku })).body['breach_scan'] as Record<string, unknown>)[
        'breaches_flagged'
      ],
      1,
    );

    await assert.rejects(
      () =>
        persistEvent({
          stream_type: 'maintenance',
          stream_id: randomUUID(),
          event_type: 'maintenance.critical_spare_breach_flagged',
          payload: {
            alert_id: randomUUID(),
            sku,
            location_id: storeLocId,
            on_hand_at_check: '2',
            min_level: '9',
            business_date: businessDate,
            flagged_at: new Date().toISOString(),
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: {
              user_id: storekeeperId,
              role: 'maintenance_storekeeper',
              location_id: storeLocId,
            },
            occurred_at: new Date().toISOString(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'DUPLICATE_SPARE_ALERT');
        return true;
      },
    );
  });

  // -------------------------------------------------------------------------
  // AC 2: the three-working-day return clock is enforced, not just recorded
  // -------------------------------------------------------------------------

  it('AC2: the sweep flags an issued spare past its return clock and escalates, with separate counters', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    // Sweep on a business_date beyond the frozen clock rather than moving the clock backwards, so
    // the persisted deadline stays exactly what the storekeeper was told.
    const futureDate = addDays(istToday(), 30);
    const res = await scan(futureDate, { sku });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const sweep = res.body['return_sweep'] as Record<string, unknown>;
    assert.strictEqual(sweep['reservations_swept'], 1);
    assert.strictEqual(sweep['escalations_raised'], 1);
    assert.deepStrictEqual(sweep['reservation_ids'], [reservationId]);

    const notification = await notificationFor(reservationId, 'spare_return_overdue');
    assert.ok(notification, 'an overdue notification event must exist');
    assert.strictEqual(notification!['role'], 'maintenance_supervisor');
    assert.strictEqual(notification!['escalation_role'], 'maintenance_manager');
    assert.strictEqual(notification!['escalation_window'], '86400');
  });

  it('AC2: a returned spare is not swept as overdue', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);
    assert.strictEqual((await returnSpare(reservationId)).status, 200);

    const res = await scan(addDays(istToday(), 30), { sku });
    const sweep = res.body['return_sweep'] as Record<string, unknown>;
    assert.strictEqual(sweep['reservations_swept'], 0);
  });

  it('AC2: the overdue filter on the reservations list agrees with the sweep', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    const notYet = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spare-reservations?sku=${sku}&return_overdue=true&business_date=${istToday()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((notYet.body['reservations'] as unknown[]).length, 0);

    const later = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spare-reservations?sku=${sku}&return_overdue=true&business_date=${addDays(istToday(), 30)}`,
      undefined,
      readerHeaders,
    );
    const rows = later.body['reservations'] as Array<Record<string, unknown>>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['reservation_id'], reservationId);
  });

  // -------------------------------------------------------------------------
  // Idempotency, RBAC and route-shadowing regressions
  // -------------------------------------------------------------------------

  it('idempotency: replaying each write route returns the same resource without growing the ledger', async () => {
    const sku = await seedItem();
    const assetId = await createAsset();
    assert.strictEqual((await receiveStock(sku, storeLocId, 10)).status, 201);

    const catalogueKey = randomUUID();
    const first = await catalogueSpare(sku, storeLocId, { idempotency_key: catalogueKey });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const catalogueId = (first.body['spare'] as Record<string, string>)['catalogue_id']!;
    const replayCatalogue = await catalogueSpare(sku, storeLocId, {
      idempotency_key: catalogueKey,
    });
    assert.strictEqual(replayCatalogue.status, 201, JSON.stringify(replayCatalogue.body));
    assert.strictEqual(
      (replayCatalogue.body['spare'] as Record<string, string>)['catalogue_id'],
      catalogueId,
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.spare_catalogued', 'catalogue_id', catalogueId),
      1,
    );

    const partKey = randomUUID();
    const part = await addPart(assetId, sku, { idempotency_key: partKey });
    assert.strictEqual(part.status, 201, JSON.stringify(part.body));
    const partLineId = (part.body['part'] as Record<string, string>)['part_line_id']!;
    const replayPart = await addPart(assetId, sku, { idempotency_key: partKey });
    assert.strictEqual(replayPart.status, 201, JSON.stringify(replayPart.body));
    assert.strictEqual(
      (replayPart.body['part'] as Record<string, string>)['part_line_id'],
      partLineId,
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.asset_part_listed', 'part_line_id', partLineId),
      1,
    );

    const { workOrderId } = await openWorkOrder();
    const reserveKey = randomUUID();
    const reserved = await reserve(workOrderId, sku, storeLocId, '3', {
      idempotency_key: reserveKey,
    });
    assert.strictEqual(reserved.status, 201, JSON.stringify(reserved.body));
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    const replayReserve = await reserve(workOrderId, sku, storeLocId, '3', {
      idempotency_key: reserveKey,
    });
    assert.strictEqual(replayReserve.status, 201, JSON.stringify(replayReserve.body));
    assert.strictEqual(
      (replayReserve.body['reservation'] as Record<string, string>)['reservation_id'],
      reservationId,
    );
    // The replay must not allocate a second time.
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 10, allocated: 3 }, 'replayed reserve');

    const issueKey = randomUUID();
    const issued = await issue(reservationId, istToday(), { idempotency_key: issueKey });
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const replayIssue = await issue(reservationId, istToday(), { idempotency_key: issueKey });
    assert.strictEqual(replayIssue.status, 200, JSON.stringify(replayIssue.body));
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 7, allocated: 0 }, 'replayed issue');

    const returnKey = randomUUID();
    const returned = await returnSpare(reservationId, {
      quantity_returned: '3',
      idempotency_key: returnKey,
    });
    assert.strictEqual(returned.status, 200, JSON.stringify(returned.body));
    const replayReturn = await returnSpare(reservationId, {
      quantity_returned: '3',
      idempotency_key: returnKey,
    });
    assert.strictEqual(replayReturn.status, 200, JSON.stringify(replayReturn.body));
    await assertLedgerInvariant(sku, storeLocId, { on_hand: 10, allocated: 0 }, 'replayed return');
  });

  it('idempotency: reusing a key across event types is DUPLICATE_EVENT', async () => {
    const sku = await seedItem();
    const assetId = await createAsset();
    const key = randomUUID();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { idempotency_key: key })).status,
      201,
    );

    const crossed = await addPart(assetId, sku, { idempotency_key: key });
    assert.strictEqual(crossed.status, 409, JSON.stringify(crossed.body));
    assert.strictEqual(crossed.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('route order: /spares/scan and /spares/alerts are not shadowed by the where-used parameter route', async () => {
    // Registered after the parameter segment, these would resolve as a where-used lookup for a SKU
    // literally named "scan" or "alerts" - a silently broken scan trigger.
    const alerts = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/spares/alerts',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(alerts.status, 200, JSON.stringify(alerts.body));
    assert.ok(Array.isArray(alerts.body['alerts']), 'the alerts route must return alerts');
    assert.strictEqual(alerts.body['where_used'], undefined);

    const scanRes = await scan(istToday());
    assert.strictEqual(scanRes.status, 200, JSON.stringify(scanRes.body));
    assert.ok(scanRes.body['breach_scan'], 'the scan route must run the job');
  });

  it('validation: the scan requires an explicit business_date', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/spares/scan',
      {},
      storekeeperHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('RBAC: a caller outside the maintenance module cannot reach any spares route', async () => {
    const sku = await seedItem();
    const denied = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/spares',
      { sku, location_id: storeLocId },
      outsiderHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));

    const deniedRead = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/spares',
      undefined,
      outsiderHeaders,
    );
    assert.strictEqual(deniedRead.status, 403, JSON.stringify(deniedRead.body));
  });

  it('RBAC: a read-scoped caller cannot write, but can read', async () => {
    const sku = await seedItem();
    const denied = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/spares',
      { sku, location_id: storeLocId },
      readerHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));

    const allowed = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/spares',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
  });

  // -------------------------------------------------------------------------
  // Code review 2026-08-25 regression tests
  // -------------------------------------------------------------------------

  it('review: fractional quantities flow through reserve and return-all in exact NUMERIC (no JS float drift)', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 1)).status, 201);
    const { workOrderId } = await openWorkOrder();

    const reserved = await reserve(workOrderId, sku, storeLocId, '0.3');
    assert.strictEqual(reserved.status, 201, JSON.stringify(reserved.body));
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    // Partial return of 0.1, then "return all" (no quantity): the outstanding remainder must be
    // the exact NUMERIC 0.2, never a 14-decimal float artifact, and the reservation must settle.
    const partial = await returnSpare(reservationId, { quantity_returned: '0.1' });
    assert.strictEqual(partial.status, 200, JSON.stringify(partial.body));
    const all = await returnSpare(reservationId);
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    await assertLedgerInvariant(
      sku,
      storeLocId,
      { on_hand: 1, allocated: 0 },
      'fractional return-all',
    );

    const row = await getAdminPool().query(
      `SELECT status, quantity_returned::text AS quantity_returned
         FROM maintenance_spare_reservation WHERE reservation_id = $1`,
      [reservationId],
    );
    assert.strictEqual(row.rows[0]!['status'], 'returned');
    assert.strictEqual(row.rows[0]!['quantity_returned'], '0.300000');
  });

  it('review: a fractional closing return (0.1 then 0.2 of 0.3) is not spuriously rejected', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 1)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '0.3');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    assert.strictEqual(
      (await returnSpare(reservationId, { quantity_returned: '0.1' })).status,
      200,
    );
    const closing = await returnSpare(reservationId, { quantity_returned: '0.2' });
    assert.strictEqual(closing.status, 200, JSON.stringify(closing.body));
    const row = await getAdminPool().query(
      `SELECT status FROM maintenance_spare_reservation WHERE reservation_id = $1`,
      [reservationId],
    );
    assert.strictEqual(row.rows[0]!['status'], 'returned');
  });

  it('review: concurrent catalogue POSTs on the same grain resolve to one 201 and one 409 SPARE_ALREADY_CATALOGUED', async () => {
    const sku = await seedItem();
    const results = await Promise.all([
      catalogueSpare(sku, storeLocId),
      catalogueSpare(sku, storeLocId),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepStrictEqual(statuses, [201, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    assert.strictEqual(conflict.body['error_code'], 'SPARE_ALREADY_CATALOGUED');
    assert.ok(
      detailsOf(conflict.body)?.['existing_catalogue_id'],
      'the 409 must carry the winning catalogue id',
    );
  });

  it('review: concurrent part listings on the same (asset, sku) grain resolve to one 201 and one 409 ASSET_PART_ALREADY_LISTED', async () => {
    const sku = await seedItem();
    const assetId = await createAsset();
    const results = await Promise.all([addPart(assetId, sku), addPart(assetId, sku)]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepStrictEqual(statuses, [201, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    assert.strictEqual(conflict.body['error_code'], 'ASSET_PART_ALREADY_LISTED');
  });

  it('review: a forged breach alert for a non-breached grain is SPARE_DERIVATION_MISMATCH', async () => {
    const sku = await seedItem();
    assert.strictEqual(
      (await catalogueSpare(sku, storeLocId, { is_critical: true, min_level: '1' })).status,
      201,
    );
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);

    await assert.rejects(
      () =>
        persistEvent({
          stream_type: 'maintenance',
          stream_id: randomUUID(),
          event_type: 'maintenance.critical_spare_breach_flagged',
          payload: {
            alert_id: randomUUID(),
            sku,
            location_id: storeLocId,
            on_hand_at_check: '0',
            min_level: '1',
            business_date: istToday(),
            flagged_at: new Date().toISOString(),
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: {
              user_id: storekeeperId,
              role: 'maintenance_storekeeper',
              location_id: storeLocId,
            },
            occurred_at: new Date().toISOString(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'SPARE_DERIVATION_MISMATCH');
        return true;
      },
    );
  });

  it('review: a forged overdue alert for a not-yet-overdue reservation is SPARE_DERIVATION_MISMATCH', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    await assert.rejects(
      () =>
        persistEvent({
          stream_type: 'maintenance',
          stream_id: randomUUID(),
          event_type: 'maintenance.spare_return_overdue_flagged',
          payload: {
            alert_id: randomUUID(),
            reservation_id: reservationId,
            sku,
            location_id: storeLocId,
            return_due_date: addDays(istToday(), 90),
            business_date: istToday(),
            flagged_at: new Date().toISOString(),
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: {
              user_id: storekeeperId,
              role: 'maintenance_storekeeper',
              location_id: storeLocId,
            },
            occurred_at: new Date().toISOString(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'SPARE_DERIVATION_MISMATCH');
        return true;
      },
    );
  });

  it('review: a direct issue declaring a different quantity than the reservation is SPARE_DERIVATION_MISMATCH', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;

    await assert.rejects(
      () =>
        persistEvent({
          stream_type: 'maintenance',
          stream_id: reservationId,
          event_type: 'maintenance.spare_issued',
          payload: {
            reservation_id: reservationId,
            quantity: '3',
            issued_at: new Date().toISOString(),
            return_due_date: addBusinessDays(
              istToday(),
              config.maintenance.spareReturnBusinessDays,
              config.maintenance.spareReturnHolidayCalendar,
            ),
            business_date: istToday(),
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: {
              user_id: storekeeperId,
              role: 'maintenance_storekeeper',
              location_id: storeLocId,
            },
            occurred_at: new Date().toISOString(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'SPARE_DERIVATION_MISMATCH');
        return true;
      },
    );
  });

  it('review: is_critical as a string is rejected with 400, never silently coerced to false', async () => {
    const sku = await seedItem();
    const res = await catalogueSpare(sku, storeLocId, { is_critical: 'true', min_level: '1' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('review: a percent-encoded SKU on the where-used route is a 400, never a 500', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/spares/100%25/where-used',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('review: a same-key replay with a different body returns the ORIGINAL spare by id, never null', async () => {
    const skuA = await seedItem();
    const skuB = await seedItem();
    const key = randomUUID();
    const first = await catalogueSpare(skuA, storeLocId, { idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const originalId = (first.body['spare'] as Record<string, string>)['catalogue_id']!;

    const replay = await catalogueSpare(skuB, storeLocId, { idempotency_key: key });
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    const spare = replay.body['spare'] as Record<string, string> | null;
    assert.ok(spare, 'the replay read-back must resolve the original row, never null');
    assert.strictEqual(spare['catalogue_id'], originalId);
  });

  it('review: business_date without return_overdue=true is rejected on the reservations list', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spare-reservations?business_date=${istToday()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('review: a second sweep of the same business_date is a no-op and the overdue alert row is readable', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;
    assert.strictEqual((await issue(reservationId)).status, 200);

    const futureDate = addDays(istToday(), 30);
    const first = await scan(futureDate, { sku });
    assert.strictEqual(
      (first.body['return_sweep'] as Record<string, unknown>)['reservations_swept'],
      1,
    );

    const second = await scan(futureDate, { sku });
    const sweep2 = second.body['return_sweep'] as Record<string, unknown>;
    assert.strictEqual(sweep2['reservations_swept'], 0);
    assert.strictEqual(sweep2['escalations_raised'], 0);

    const alerts = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/spares/alerts?alert_type=return_overdue&location_id=${storeLocId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(alerts.status, 200, JSON.stringify(alerts.body));
    const rows = alerts.body['alerts'] as Array<Record<string, unknown>>;
    const mine = rows.filter((r) => r['reservation_id'] === reservationId);
    assert.strictEqual(mine.length, 1, 'the overdue alert row must be readable');
  });

  it('review: return-after-cancel and a second cancel are rejected; cancel without a reason is a 400', async () => {
    const sku = await seedItem();
    assert.strictEqual((await catalogueSpare(sku, storeLocId)).status, 201);
    assert.strictEqual((await receiveStock(sku, storeLocId, 5)).status, 201);
    const { workOrderId } = await openWorkOrder();
    const reserved = await reserve(workOrderId, sku, storeLocId, '2');
    const reservationId = (reserved.body['reservation'] as Record<string, string>)[
      'reservation_id'
    ]!;

    const noReason = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/spare-reservations/${reservationId}/cancel`,
      {},
      storekeeperHeaders,
    );
    assert.strictEqual(noReason.status, 400, JSON.stringify(noReason.body));
    assert.strictEqual(noReason.body['error_code'], 'INVALID_PARAMS');

    assert.strictEqual((await cancel(reservationId)).status, 200);
    const secondCancel = await cancel(reservationId);
    assert.strictEqual(secondCancel.status, 409, JSON.stringify(secondCancel.body));
    assert.strictEqual(secondCancel.body['error_code'], 'RESERVATION_NOT_RESERVED');

    const afterCancel = await returnSpare(reservationId);
    assert.strictEqual(afterCancel.status, 409, JSON.stringify(afterCancel.body));
    assert.strictEqual(afterCancel.body['error_code'], 'RESERVATION_NOT_ISSUED');
  });
});

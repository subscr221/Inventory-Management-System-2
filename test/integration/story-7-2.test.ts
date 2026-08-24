import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.2: Preventive Maintenance Plans and Work Order Generation (FR-M-02, FR-M-03). Runs
// against the PRODUCTION router surface (createAppRouter) with real auth, RBAC, and PostgreSQL -
// no mocks of the DB or the event store. The harness is the Story 7.1 pattern extended with the
// four new projections.
//
// Time is controlled entirely through the jobs' business_date parameter, so no clock mocking is
// needed. Every job call passes an asset_id filter so concurrently-created fixtures in other tests
// in this file cannot bleed into one another's assertions.

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

/** Whole-day UTC arithmetic on an ISO date, matching the job and handler helpers. */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(y!, m! - 1, d!) + days * 86400000).toISOString().slice(0, 10);
}

const TODAY = new Date().toISOString().slice(0, 10);
const ESCALATION_ROLE = `maintenance_planner_7_2_${run}`;
const ALERT_ROLE = `maintenance_planner_alert_7_2_${run}`;
// Well past any silent_after_days value a test configures (the fixtures use 30).
const LONG_AFTER_SILENT_WINDOW = addDays(TODAY, 400);

describe('Story 7.2 Preventive Maintenance Plans and Work Order Generation Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteAId = randomUUID();

  let plannerHeaders: Record<string, string>;
  let plannerId: string;
  let readerHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;

  async function createAsset(name: string): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-${randomUUID().slice(0, 12)}`,
        asset_name: `${name} ${run}`,
        criticality_class: 'high',
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_id']!;
  }

  async function createMeter(
    assetId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters',
      {
        asset_id: assetId,
        meter_code: `HRS-${randomUUID().slice(0, 8)}`,
        unit: 'hours',
        alert_role: ALERT_ROLE,
        ...overrides,
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body['meter'] as Record<string, unknown>;
  }

  async function createCalendarPlan(
    assetId: string,
    anchorOffsetDays: number,
    intervalDays: number,
    graceDays: number,
  ): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `PM ${randomUUID().slice(0, 8)}`,
        plan_type: 'calendar',
        interval_days: intervalDays,
        grace_period_days: graceDays,
        escalation_role: ESCALATION_ROLE,
        anchor_date: addDays(TODAY, anchorOffsetDays),
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body['plan'] as Record<string, unknown>;
  }

  async function generate(assetId: string, businessDate: string): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/pm/generate',
      { business_date: businessDate, asset_id: assetId },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function sweep(assetId: string, businessDate: string): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/pm/grace-sweep',
      { business_date: businessDate, asset_id: assetId },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function reconcile(
    assetId: string,
    businessDate: string,
  ): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters/reconcile',
      { business_date: businessDate, asset_id: assetId },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function postReading(
    meterId: string,
    value: number,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meter-readings',
      { meter_id: meterId, reading_value: value, ...overrides },
      plannerHeaders,
    );
  }

  /** Counts notification.created domain events raised for one object (no dispatcher needed). */
  async function notificationCountFor(objectId: string, eventType: string): Promise<number> {
    const result = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = $2`,
      [objectId, eventType],
    );
    return result.rows[0]!['n'] as number;
  }

  /** Resolves the notification target role for one object (one shared predicate, not a copy). */
  async function notificationRoleFor(objectId: string): Promise<string | null> {
    const result = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role FROM domain_events
        WHERE event_type = 'notification.created' AND payload->>'object_id' = $1`,
      [objectId],
    );
    const row = result.rows[0];
    return (row ? row['role'] : null) as string | null;
  }

  /** Counts domain_events rows for one event type and one payload id (event-ledger truth). */
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
      '../../read/projections/asset.sql',
      '../../read/projections/asset_meter.sql',
      '../../read/projections/asset_meter_reading.sql',
      '../../read/projections/maintenance_plan.sql',
      '../../read/projections/maintenance_work_order.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE maintenance_work_order, maintenance_plan, asset_meter_reading, asset_meter, asset, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    plannerId = await provisionUser(port, `planner-7-2-${run}@example.com`, [
      {
        role: `maintenance_planner_7_2_${run}`,
        module: 'maintenance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    plannerHeaders = await authFor(port, `planner-7-2-${run}@example.com`);

    await provisionUser(port, `reader-7-2-${run}@example.com`, [
      {
        role: `maintenance_reader_7_2_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    readerHeaders = await authFor(port, `reader-7-2-${run}@example.com`);

    await provisionUser(port, `outsider-7-2-${run}@example.com`, [
      {
        role: `warehouse_worker_7_2_${run}`,
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    outsiderHeaders = await authFor(port, `outsider-7-2-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: plans auto-generate work orders as due, tracked against a grace window
  // -------------------------------------------------------------------------

  it('AC1: a calendar plan generates one work order with the right due and grace dates, and advances its cursor', async () => {
    const assetId = await createAsset('Injection Press');
    const plan = await createCalendarPlan(assetId, -40, 30, 5);
    // First due cycle is one interval after the anchor.
    assert.strictEqual(plan['next_due_date'], addDays(TODAY, -10));
    assert.strictEqual(plan['plan_type'], 'calendar');
    assert.strictEqual(plan['created_by'], plannerId);

    const result = await generate(assetId, TODAY);
    assert.strictEqual(result['work_orders_generated'], 1, JSON.stringify(result));

    const listRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders?asset_id=${assetId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    const workOrders = listRes.body['work_orders'] as Record<string, unknown>[];
    assert.strictEqual(workOrders.length, 1);
    assert.strictEqual(workOrders[0]!['due_date'], addDays(TODAY, -10));
    assert.strictEqual(workOrders[0]!['grace_until_date'], addDays(TODAY, -5));
    assert.strictEqual(workOrders[0]!['status'], 'open');
    assert.strictEqual(workOrders[0]!['origin'], 'preventive');
    assert.strictEqual(workOrders[0]!['plan_id'], plan['plan_id']);

    const planRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/plans/${plan['plan_id'] as string}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(planRes.status, 200, JSON.stringify(planRes.body));
    assert.strictEqual(
      (planRes.body['plan'] as Record<string, unknown>)['next_due_date'],
      addDays(TODAY, 20),
      'the plan cursor must advance by one interval',
    );
  });

  it('AC1: re-running generation on the same business_date creates no second work order', async () => {
    const assetId = await createAsset('Lathe');
    await createCalendarPlan(assetId, -40, 30, 5);

    const first = await generate(assetId, TODAY);
    assert.strictEqual(first['work_orders_generated'], 1);
    const second = await generate(assetId, TODAY);
    assert.strictEqual(second['work_orders_generated'], 0, JSON.stringify(second));
    // The mechanism here is cursor-advance (the plan is no longer due), NOT the duplicate-cycle
    // skip: both counters must reflect that honestly.
    assert.strictEqual(second['plans_evaluated'], 0, JSON.stringify(second));
    assert.strictEqual(second['skipped_existing'], 0, JSON.stringify(second));

    const listRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders?asset_id=${assetId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((listRes.body['work_orders'] as unknown[]).length, 1);
  });

  it('AC1: a plan whose cycle has not arrived generates nothing', async () => {
    const assetId = await createAsset('Compressor');
    await createCalendarPlan(assetId, 0, 30, 5);
    const result = await generate(assetId, TODAY);
    assert.strictEqual(result['plans_evaluated'], 0);
    assert.strictEqual(result['work_orders_generated'], 0);
  });

  it('AC1: a calendar plan several cycles behind catches up all missed cycles in one run, and a re-run generates nothing', async () => {
    const assetId = await createAsset('Catch-up Press');
    // Anchored 100 days ago with interval 30: cycles TODAY-70, TODAY-40 and TODAY-10 are all due.
    await createCalendarPlan(assetId, -100, 30, 5);

    const result = await generate(assetId, TODAY);
    assert.strictEqual(result['plans_evaluated'], 1, JSON.stringify(result));
    assert.strictEqual(result['work_orders_generated'], 3, JSON.stringify(result));

    const listRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders?asset_id=${assetId}`,
      undefined,
      readerHeaders,
    );
    const dueDates = (listRes.body['work_orders'] as Record<string, unknown>[])
      .map((wo) => wo['due_date'])
      .sort();
    assert.deepEqual(dueDates, [addDays(TODAY, -70), addDays(TODAY, -40), addDays(TODAY, -10)]);

    // A re-run over the same date generates nothing: the cursor passed the business_date.
    const rerun = await generate(assetId, TODAY);
    assert.strictEqual(rerun['work_orders_generated'], 0, JSON.stringify(rerun));
    assert.strictEqual(rerun['plans_evaluated'], 0);

    // The job run wrote its audit trail (Task 5.5).
    const auditRes = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE endpoint LIKE '%/pm/generate' AND method = 'POST' AND http_status = 200`,
    );
    assert.ok((auditRes.rows[0]!['n'] as number) >= 1, 'generate runs must write audit rows');
  });

  it('AC1: a meter plan several thresholds behind catches up all cycles in one run', async () => {
    const assetId = await createAsset('Catch-up Lathe');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;
    // First threshold derived in the seam from the locked meter: 0 + 1000.
    const planRes = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Meter Catch-up ${randomUUID().slice(0, 8)}`,
        plan_type: 'meter',
        meter_id: meterId,
        interval_meter_units: 1000,
        grace_period_days: 3,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(planRes.status, 201, JSON.stringify(planRes.body));

    // Jump the meter five thresholds past the derived threshold.
    assert.strictEqual((await postReading(meterId, 5000)).status, 201);

    const result = await generate(assetId, TODAY);
    assert.strictEqual(result['work_orders_generated'], 5, JSON.stringify(result));

    const rerun = await generate(assetId, TODAY);
    assert.strictEqual(rerun['work_orders_generated'], 0, JSON.stringify(rerun));
  });

  // -------------------------------------------------------------------------
  // AC 2: grace window expiry transitions to overdue and escalates
  // -------------------------------------------------------------------------

  it('AC2: a work order inside its grace window is not swept and raises no alert', async () => {
    const assetId = await createAsset('Grinder');
    await createCalendarPlan(assetId, -40, 30, 5);
    const generated = await generate(assetId, TODAY);
    const workOrderId = (generated['work_order_ids'] as string[])[0]!;

    const result = await sweep(assetId, addDays(TODAY, -7));
    assert.strictEqual(result['work_orders_swept'], 0, JSON.stringify(result));
    assert.strictEqual(result['escalations_raised'], 0);

    // Task 7.3 requires the work order to "stay open with no notification": assert the DB state,
    // not just the job counters (a sweep that wrongly transitioned while reporting 0 would pass).
    const getRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(
      (getRes.body['work_order'] as Record<string, unknown>)['status'],
      'open',
      JSON.stringify(getRes.body),
    );
    assert.strictEqual(await notificationCountFor(workOrderId, 'pm_work_order_overdue'), 0);
  });

  it('AC2: a work order past its grace window goes overdue and escalates to the plan role exactly once', async () => {
    const assetId = await createAsset('Hydraulic Press');
    await createCalendarPlan(assetId, -40, 30, 5);
    await generate(assetId, TODAY);

    const result = await sweep(assetId, TODAY);
    assert.strictEqual(result['work_orders_swept'], 1, JSON.stringify(result));
    assert.strictEqual(result['escalations_raised'], 1);
    const workOrderId = (result['work_order_ids'] as string[])[0]!;

    const getRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}`,
      undefined,
      readerHeaders,
    );
    const workOrder = getRes.body['work_order'] as Record<string, unknown>;
    assert.strictEqual(workOrder['status'], 'overdue');
    assert.ok(workOrder['overdue_at'], 'overdue_at must be stamped');
    assert.ok(workOrder['escalated_at'], 'escalated_at must be stamped');

    assert.strictEqual(await notificationCountFor(workOrderId, 'pm_work_order_overdue'), 1);
    assert.strictEqual(await notificationRoleFor(workOrderId), ESCALATION_ROLE);

    // Re-running the sweep must not escalate a second time.
    const second = await sweep(assetId, TODAY);
    assert.strictEqual(second['work_orders_swept'], 0, JSON.stringify(second));
    assert.strictEqual(await notificationCountFor(workOrderId, 'pm_work_order_overdue'), 1);
  });

  it('AC2: a completed work order is never swept, and a late completion of an overdue order is allowed', async () => {
    const assetId = await createAsset('Bandsaw');
    await createCalendarPlan(assetId, -40, 30, 5);
    const generated = await generate(assetId, TODAY);
    const workOrderId = (generated['work_order_ids'] as string[])[0]!;

    const completeRes = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      {},
      plannerHeaders,
    );
    assert.strictEqual(completeRes.status, 200, JSON.stringify(completeRes.body));
    const completed = completeRes.body['work_order'] as Record<string, unknown>;
    assert.strictEqual(completed['status'], 'completed');
    assert.strictEqual(completed['completed_by'], plannerId);

    const swept = await sweep(assetId, TODAY);
    assert.strictEqual(swept['work_orders_swept'], 0, JSON.stringify(swept));
    assert.strictEqual(await notificationCountFor(workOrderId, 'pm_work_order_overdue'), 0);

    const again = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      {},
      plannerHeaders,
    );
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'WORK_ORDER_ALREADY_COMPLETED');
  });

  it('AC2: an overdue work order can still be completed late', async () => {
    const assetId = await createAsset('Overhead Crane');
    await createCalendarPlan(assetId, -40, 30, 5);
    const generated = await generate(assetId, TODAY);
    const workOrderId = (generated['work_order_ids'] as string[])[0]!;

    // Establish that the sweep really transitioned the order BEFORE completing it (a no-op sweep
    // must not pass this test).
    const swept = await sweep(assetId, TODAY);
    assert.strictEqual(swept['work_orders_swept'], 1, JSON.stringify(swept));
    const beforeComplete = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(
      (beforeComplete.body['work_order'] as Record<string, unknown>)['status'],
      'overdue',
      'the work order must be overdue before the late completion',
    );

    const completeRes = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      {},
      plannerHeaders,
    );
    assert.strictEqual(completeRes.status, 200, JSON.stringify(completeRes.body));
    assert.strictEqual(
      (completeRes.body['work_order'] as Record<string, unknown>)['status'],
      'completed',
    );
  });

  it('AC2: a sweep on the exact grace_until_date leaves the order open; the next day sweeps it', async () => {
    const assetId = await createAsset('Boundary Grinder');
    await createCalendarPlan(assetId, -40, 30, 5); // due TODAY-10, grace until TODAY-5
    const generated = await generate(assetId, TODAY);
    const workOrderId = (generated['work_order_ids'] as string[])[0]!;

    // Exactly on the boundary the window has not closed (strictly-after semantics on both the
    // list predicate and the applier re-check).
    const onBoundary = await sweep(assetId, addDays(TODAY, -5));
    assert.strictEqual(onBoundary['work_orders_swept'], 0, JSON.stringify(onBoundary));
    assert.strictEqual(await notificationCountFor(workOrderId, 'pm_work_order_overdue'), 0);

    // One day past the boundary: swept exactly once.
    const nextDay = await sweep(assetId, addDays(TODAY, -4));
    assert.strictEqual(nextDay['work_orders_swept'], 1, JSON.stringify(nextDay));
  });

  // -------------------------------------------------------------------------
  // AC 3: manual readings advance the meter and update PM due calculations
  // -------------------------------------------------------------------------

  it('AC3: a manual reading advances the meter and shrinks the plan remaining units', async () => {
    const assetId = await createAsset('CNC Mill');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;

    const planRes = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Meter PM ${randomUUID().slice(0, 8)}`,
        plan_type: 'meter',
        meter_id: meterId,
        interval_meter_units: 100,
        grace_period_days: 3,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(planRes.status, 201, JSON.stringify(planRes.body));
    const planId = (planRes.body['plan'] as Record<string, unknown>)['plan_id'] as string;

    const reading = await postReading(meterId, 40);
    assert.strictEqual(reading.status, 201, JSON.stringify(reading.body));
    assert.strictEqual(
      Number((reading.body['meter'] as Record<string, unknown>)['current_reading']),
      40,
    );
    assert.ok((reading.body['meter'] as Record<string, unknown>)['last_reading_at']);

    const planAfter = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/plans/${planId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(Number(planAfter.body['meter_units_remaining']), 60);

    // Below the threshold: nothing due yet.
    const early = await generate(assetId, TODAY);
    assert.strictEqual(early['work_orders_generated'], 0, JSON.stringify(early));

    // Crossing the threshold makes the plan due.
    const crossing = await postReading(meterId, 120);
    assert.strictEqual(crossing.status, 201, JSON.stringify(crossing.body));
    const due = await generate(assetId, TODAY);
    assert.strictEqual(due['work_orders_generated'], 1, JSON.stringify(due));

    const workOrderId = (due['work_order_ids'] as string[])[0]!;
    const woRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}`,
      undefined,
      readerHeaders,
    );
    const workOrder = woRes.body['work_order'] as Record<string, unknown>;
    assert.strictEqual(workOrder['due_date'], TODAY);
    assert.strictEqual(workOrder['grace_until_date'], addDays(TODAY, 3));

    // The cursor advanced by one interval, so the plan is not due again at 120.
    const rerun = await generate(assetId, TODAY);
    assert.strictEqual(rerun['work_orders_generated'], 0, JSON.stringify(rerun));
  });

  it('AC3: a reading below the current reading is rejected, an equal reading is accepted', async () => {
    const assetId = await createAsset('Shot Blaster');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;

    assert.strictEqual((await postReading(meterId, 500)).status, 201);

    const regression = await postReading(meterId, 499);
    assert.strictEqual(regression.status, 409, JSON.stringify(regression.body));
    assert.strictEqual(regression.body['error_code'], 'METER_READING_REGRESSION');
    assert.strictEqual(
      Number((regression.body['details'] as Record<string, unknown>)['current_reading']),
      500,
    );

    const equal = await postReading(meterId, 500);
    assert.strictEqual(equal.status, 201, JSON.stringify(equal.body));
    assert.strictEqual(
      Number((equal.body['meter'] as Record<string, unknown>)['current_reading']),
      500,
    );
  });

  // -------------------------------------------------------------------------
  // AC 4: every registered source is applied identically and recorded
  // -------------------------------------------------------------------------

  it('AC4: readings from every registered source are applied identically and record source and capture method', async () => {
    const assetId = await createAsset('Maker Hub Router');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;

    const cases: Array<[string, string, number]> = [
      ['manual', 'manual_entry', 10],
      ['hub_booking', 'api', 20],
      ['station_equipment', 'device_feed', 30],
    ];
    for (const [source, captureMethod, value] of cases) {
      const res = await postReading(meterId, value, { source, capture_method: captureMethod });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const stored = res.body['reading'] as Record<string, unknown>;
      assert.strictEqual(stored['source'], source);
      assert.strictEqual(stored['capture_method'], captureMethod);
      assert.strictEqual(stored['recorded_by'], plannerId);
      assert.strictEqual(
        Number((res.body['meter'] as Record<string, unknown>)['current_reading']),
        value,
        'every source advances the meter the same way',
      );
    }

    const readingsRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters/${meterId}/readings`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(readingsRes.status, 200, JSON.stringify(readingsRes.body));
    assert.strictEqual((readingsRes.body['readings'] as unknown[]).length, 3);

    const badSource = await postReading(meterId, 40, { source: 'telepathy' });
    assert.strictEqual(badSource.status, 400, JSON.stringify(badSource.body));
    assert.strictEqual(badSource.body['error_code'], 'INVALID_PARAMS');

    const badCapture = await postReading(meterId, 40, { capture_method: 'osmosis' });
    assert.strictEqual(badCapture.status, 400, JSON.stringify(badCapture.body));
    assert.strictEqual(badCapture.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC3/AC4: reading_at bounds and the explicit-UTC-offset requirement are enforced, and backfills cannot rewind the silent clock', async () => {
    const assetId = await createAsset('Clock Probe');
    const meter = await createMeter(assetId, { silent_after_days: 30 });
    const meterId = meter['meter_id'] as string;

    // Malformed PRESENCE is a client error; absence is sanctioned (falls back to now).
    assert.strictEqual((await postReading(meterId, 10, { reading_at: 123456789 })).status, 400);
    // A naive timestamp (no UTC offset) is rejected: JS local time and pg session time must not
    // disagree on the stored instant.
    assert.strictEqual(
      (await postReading(meterId, 10, { reading_at: `${TODAY}T10:00:00` })).status,
      400,
    );
    // More than 24h in the future is a data-entry error.
    assert.strictEqual(
      (await postReading(meterId, 10, { reading_at: `${addDays(TODAY, 5)}T00:00:00Z` })).status,
      400,
    );

    // A legitimate reading with an explicit offset lands and keeps its instant.
    const ok = await postReading(meterId, 10, { reading_at: `${TODAY}T10:00:00Z` });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(
      (ok.body['reading'] as Record<string, unknown>)['reading_at'],
      `${TODAY}T10:00:00.000Z`,
    );

    // Flag the meter as silent, then backfill a reading dated well before the registration.
    await reconcile(assetId, LONG_AFTER_SILENT_WINDOW);
    const flaggedRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters?asset_id=${assetId}`,
      undefined,
      readerHeaders,
    );
    const flaggedRow = (flaggedRes.body['meters'] as Record<string, unknown>[])[0]!;
    assert.ok(flaggedRow['silent_flagged_at'], 'meter must be flagged first');

    const backfill = await postReading(meterId, 12, {
      reading_at: `${addDays(TODAY, -700)}T00:00:00Z`,
    });
    assert.strictEqual(backfill.status, 201, JSON.stringify(backfill.body));

    // A backfill that did not advance the clock must neither rewind the silent clock nor clear
    // the live flag (the Groups 2/3 GREATEST + CASE decisions).
    const afterRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters?asset_id=${assetId}`,
      undefined,
      readerHeaders,
    );
    const afterRow = (afterRes.body['meters'] as Record<string, unknown>[])[0]!;
    assert.strictEqual(
      afterRow['silent_flagged_at'],
      flaggedRow['silent_flagged_at'],
      'a backdated reading must not clear the silent flag',
    );
    assert.ok(afterRow['last_reading_at'], 'last_reading_at must still be stamped');
  });

  it('AC3: a reading landing exactly on the threshold makes the meter plan due', async () => {
    const assetId = await createAsset('Exact Threshold Lathe');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;
    // Derived first threshold in the seam: 0 + 100.
    const planRes = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Exact ${randomUUID().slice(0, 8)}`,
        plan_type: 'meter',
        meter_id: meterId,
        interval_meter_units: 100,
        grace_period_days: 3,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(planRes.status, 201, JSON.stringify(planRes.body));

    assert.strictEqual((await postReading(meterId, 99)).status, 201);
    const below = await generate(assetId, TODAY);
    assert.strictEqual(below['work_orders_generated'], 0, JSON.stringify(below));

    // Exactly at the threshold: the due predicate is >=, so the plan is due.
    assert.strictEqual((await postReading(meterId, 100)).status, 201);
    const due = await generate(assetId, TODAY);
    assert.strictEqual(due['work_orders_generated'], 1, JSON.stringify(due));
  });

  // -------------------------------------------------------------------------
  // AC 5: reconciliation flags silent meters
  // -------------------------------------------------------------------------

  it('AC5: reconciliation flags a silent meter once, alerts its role, and a fresh reading clears the flag', async () => {
    const assetId = await createAsset('Idle Kiln');
    const meter = await createMeter(assetId, { silent_after_days: 30 });
    const meterId = meter['meter_id'] as string;

    // Well inside the window: nothing is silent yet.
    const early = await reconcile(assetId, addDays(TODAY, 5));
    assert.strictEqual(early['meters_flagged'], 0, JSON.stringify(early));

    const late = await reconcile(assetId, LONG_AFTER_SILENT_WINDOW);
    assert.strictEqual(late['meters_flagged'], 1, JSON.stringify(late));
    assert.strictEqual(late['alerts_raised'], 1, 'a delivered alert must be visible on the result');
    assert.strictEqual(await notificationCountFor(meterId, 'meter_silent'), 1);
    assert.strictEqual(await notificationRoleFor(meterId), ALERT_ROLE);

    const listRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters?asset_id=${assetId}`,
      undefined,
      readerHeaders,
    );
    const flagged = (listRes.body['meters'] as Record<string, unknown>[])[0]!;
    assert.ok(flagged['silent_flagged_at'], 'silent_flagged_at must be stamped');
    assert.ok(flagged['last_reconciled_at'], 'last_reconciled_at must be stamped');

    // Idempotent: a second run flags nothing new and raises no second alert.
    const rerun = await reconcile(assetId, LONG_AFTER_SILENT_WINDOW);
    assert.strictEqual(rerun['meters_flagged'], 0, JSON.stringify(rerun));
    assert.strictEqual(rerun['alerts_raised'], 0);
    assert.strictEqual(await notificationCountFor(meterId, 'meter_silent'), 1);

    // A fresh reading reconciles the meter.
    assert.strictEqual((await postReading(meterId, 7)).status, 201);
    const clearedRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters?asset_id=${assetId}`,
      undefined,
      readerHeaders,
    );
    const cleared = (clearedRes.body['meters'] as Record<string, unknown>[])[0]!;
    assert.strictEqual(cleared['silent_flagged_at'], null);

    const afterReading = await reconcile(assetId, addDays(TODAY, 5));
    assert.strictEqual(afterReading['meters_flagged'], 0, JSON.stringify(afterReading));
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: guards, RBAC, idempotency, referential integrity
  // -------------------------------------------------------------------------

  it('rejects a direct maintenance event POST with INVALID_EVENT_STREAM', async () => {
    const assetId = await createAsset('Direct Write Probe');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'maintenance',
        stream_id: randomUUID(),
        event_type: 'maintenance.plan_defined',
        payload: {
          plan_id: randomUUID(),
          asset_id: assetId,
          plan_name: 'Backdoor',
          plan_type: 'calendar',
          interval_days: 30,
          grace_period_days: 1,
          escalation_role: ESCALATION_ROLE,
          anchor_date: TODAY,
          next_due_date: TODAY,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: plannerId,
            role: `maintenance_planner_7_2_${run}`,
            location_id: '00000000-0000-0000-0000-000000000000',
          },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_EVENT_STREAM');
  });

  it('enforces module and function RBAC on every mutating route', async () => {
    const assetId = await createAsset('RBAC Probe');
    const planBody = {
      asset_id: assetId,
      plan_name: `Denied ${randomUUID().slice(0, 8)}`,
      plan_type: 'calendar',
      interval_days: 30,
      grace_period_days: 1,
      escalation_role: ESCALATION_ROLE,
      anchor_date: TODAY,
    };

    const outsider = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      planBody,
      outsiderHeaders,
    );
    assert.strictEqual(outsider.status, 403, JSON.stringify(outsider.body));
    assert.strictEqual(outsider.body['error_code'], 'MODULE_ACCESS_DENIED');

    const reader = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      planBody,
      readerHeaders,
    );
    assert.strictEqual(reader.status, 403, JSON.stringify(reader.body));
    assert.strictEqual(reader.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    for (const [method, path] of [
      ['POST', '/api/v1/maintenance/meters'],
      ['POST', '/api/v1/maintenance/meter-readings'],
      ['POST', '/api/v1/maintenance/pm/generate'],
      ['POST', '/api/v1/maintenance/pm/grace-sweep'],
      ['POST', '/api/v1/maintenance/meters/reconcile'],
      ['POST', '/api/v1/maintenance/work-orders/00000000-0000-0000-0000-000000000000/complete'],
    ] as Array<[string, string]>) {
      const denied = await makeRequest(port, method, path, {}, readerHeaders);
      assert.strictEqual(denied.status, 403, `${path}: ${JSON.stringify(denied.body)}`);
      assert.strictEqual(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    }

    // Read routes also deny the outsider (module-level) and reject nothing structurally.
    for (const path of [
      '/api/v1/maintenance/plans',
      '/api/v1/maintenance/meters',
      '/api/v1/maintenance/work-orders',
    ]) {
      const deniedRead = await makeRequest(port, 'GET', path, undefined, outsiderHeaders);
      assert.strictEqual(deniedRead.status, 403, `${path}: ${JSON.stringify(deniedRead.body)}`);
      assert.strictEqual(deniedRead.body['error_code'], 'MODULE_ACCESS_DENIED');
    }
  });

  it('replays a meter registration idempotently and keeps distinct blank-key writes distinct', async () => {
    const assetId = await createAsset('Idempotency Probe');
    const key = randomUUID();
    const code = `HRS-${randomUUID().slice(0, 8)}`;

    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters',
      {
        asset_id: assetId,
        meter_code: code,
        unit: 'hours',
        alert_role: ALERT_ROLE,
        idempotency_key: key,
      },
      plannerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters',
      {
        asset_id: assetId,
        meter_code: code,
        unit: 'hours',
        alert_role: ALERT_ROLE,
        idempotency_key: key,
      },
      plannerHeaders,
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.strictEqual(
      (second.body['meter'] as Record<string, unknown>)['meter_id'],
      (first.body['meter'] as Record<string, unknown>)['meter_id'],
    );

    const countRes = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM asset_meter WHERE asset_id = $1`,
      [assetId],
    );
    assert.strictEqual(countRes.rows[0]!['n'], 1);
    // The event ledger agrees: exactly one registration event for this meter.
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.meter_registered',
        'meter_id',
        (first.body['meter'] as Record<string, string>)['meter_id']!,
      ),
      1,
    );

    // A blank key is "not supplied": two distinct registrations must both land.
    for (const suffix of ['A', 'B']) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/maintenance/meters',
        {
          asset_id: assetId,
          meter_code: `${code}-${suffix}`,
          unit: 'cycles',
          alert_role: ALERT_ROLE,
          idempotency_key: '',
        },
        plannerHeaders,
      );
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    }
    const afterBlank = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM asset_meter WHERE asset_id = $1`,
      [assetId],
    );
    assert.strictEqual(afterBlank.rows[0]!['n'], 3);
  });

  it('rejects a replay whose idempotency key belongs to a different event type', async () => {
    const assetId = await createAsset('Cross Stream Probe');
    const key = randomUUID();
    const planted = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-${randomUUID().slice(0, 12)}`,
        asset_name: `Planted ${run}`,
        criticality_class: 'low',
        idempotency_key: key,
      },
      plannerHeaders,
    );
    assert.strictEqual(planted.status, 201, JSON.stringify(planted.body));

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters',
      {
        asset_id: assetId,
        meter_code: `HRS-${randomUUID().slice(0, 8)}`,
        unit: 'hours',
        alert_role: ALERT_ROLE,
        idempotency_key: key,
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(
      (res.body['details'] as Record<string, unknown>)['existing_event_type'],
      'asset.registered',
    );
  });

  it('enforces referential integrity and the uniqueness keys of plans and meters', async () => {
    const assetId = await createAsset('Integrity Probe');
    const otherAssetId = await createAsset('Other Asset');
    const meter = await createMeter(assetId, { meter_code: `MIX-${run}` });
    const meterId = meter['meter_id'] as string;

    const unknownAsset = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: randomUUID(),
        plan_name: `Ghost ${randomUUID().slice(0, 8)}`,
        plan_type: 'calendar',
        interval_days: 30,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(unknownAsset.status, 404, JSON.stringify(unknownAsset.body));
    assert.strictEqual(unknownAsset.body['error_code'], 'ASSET_NOT_FOUND');

    const mismatch = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: otherAssetId,
        plan_name: `Mismatch ${randomUUID().slice(0, 8)}`,
        plan_type: 'meter',
        meter_id: meterId,
        interval_meter_units: 50,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.strictEqual(mismatch.body['error_code'], 'PLAN_METER_MISMATCH');

    // A meter plan naming a meter that does not exist at all is a 404, not a mismatch.
    const unknownMeterPlan = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Ghost Meter ${randomUUID().slice(0, 8)}`,
        plan_type: 'meter',
        meter_id: randomUUID(),
        interval_meter_units: 50,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(unknownMeterPlan.status, 404, JSON.stringify(unknownMeterPlan.body));
    assert.strictEqual(unknownMeterPlan.body['error_code'], 'METER_NOT_FOUND');

    // Case variants of a meter code are the same meter.
    const dupMeter = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters',
      {
        asset_id: assetId,
        meter_code: `mix-${run}`,
        unit: 'hours',
        alert_role: ALERT_ROLE,
      },
      plannerHeaders,
    );
    assert.strictEqual(dupMeter.status, 409, JSON.stringify(dupMeter.body));
    assert.strictEqual(dupMeter.body['error_code'], 'DUPLICATE_METER');
    assert.strictEqual(
      (dupMeter.body['details'] as Record<string, unknown>)['existing_meter_id'],
      meterId,
    );

    const planName = `Shared Name ${run}`;
    const firstPlan = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: planName,
        plan_type: 'calendar',
        interval_days: 30,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(firstPlan.status, 201, JSON.stringify(firstPlan.body));
    const dupPlan = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: planName.toUpperCase(),
        plan_type: 'calendar',
        interval_days: 30,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(dupPlan.status, 409, JSON.stringify(dupPlan.body));
    assert.strictEqual(dupPlan.body['error_code'], 'DUPLICATE_PLAN');

    const unknownMeterReading = await postReading(randomUUID(), 5);
    assert.strictEqual(unknownMeterReading.status, 404, JSON.stringify(unknownMeterReading.body));
    assert.strictEqual(unknownMeterReading.body['error_code'], 'METER_NOT_FOUND');

    const unknownPlan = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/plans/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(unknownPlan.status, 404, JSON.stringify(unknownPlan.body));
    assert.strictEqual(unknownPlan.body['error_code'], 'PLAN_NOT_FOUND');

    const unknownWorkOrder = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(unknownWorkOrder.status, 404, JSON.stringify(unknownWorkOrder.body));
    assert.strictEqual(unknownWorkOrder.body['error_code'], 'WORK_ORDER_NOT_FOUND');
  });

  it("job asset_id scope excludes another asset's due work orders and silent meters", async () => {
    const assetA = await createAsset('Scope A');
    const assetB = await createAsset('Scope B');
    await createCalendarPlan(assetA, -40, 30, 5);
    await generate(assetA, TODAY);

    const meterB = await createMeter(assetB, { silent_after_days: 30 });

    // Sweep scoped to B sees none of A's expired-grace work order; scoped to A sweeps A's.
    const sweptB = await sweep(assetB, TODAY);
    assert.strictEqual(sweptB['work_orders_swept'], 0, JSON.stringify(sweptB));
    const sweptA = await sweep(assetA, TODAY);
    assert.strictEqual(sweptA['work_orders_swept'], 1, JSON.stringify(sweptA));

    // Reconcile scoped to A sees none of B's silent meter; scoped to B flags B's.
    const recA = await reconcile(assetA, LONG_AFTER_SILENT_WINDOW);
    assert.strictEqual(recA['meters_flagged'], 0, JSON.stringify(recA));
    const recB = await reconcile(assetB, LONG_AFTER_SILENT_WINDOW);
    assert.strictEqual(recB['meters_flagged'], 1, JSON.stringify(recB));
    assert.strictEqual(recB['alerts_raised'], 1);
    assert.ok(meterB['meter_id'], 'meter fixture must exist');
  });

  it('replays plan, reading and completion idempotently with exactly one event each', async () => {
    const assetId = await createAsset('Replay Probe');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;

    // Plan replay: same key returns the same plan and one event row.
    const planKey = randomUUID();
    const planBody = {
      asset_id: assetId,
      plan_name: `Replay ${randomUUID().slice(0, 8)}`,
      plan_type: 'calendar',
      interval_days: 30,
      grace_period_days: 1,
      escalation_role: ESCALATION_ROLE,
      anchor_date: TODAY,
      idempotency_key: planKey,
    };
    const planFirst = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      planBody,
      plannerHeaders,
    );
    assert.strictEqual(planFirst.status, 201, JSON.stringify(planFirst.body));
    const planReplay = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      planBody,
      plannerHeaders,
    );
    assert.strictEqual(planReplay.status, 201, JSON.stringify(planReplay.body));
    assert.strictEqual(
      (planReplay.body['plan'] as Record<string, unknown>)['plan_id'],
      (planFirst.body['plan'] as Record<string, unknown>)['plan_id'],
    );
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.plan_defined',
        'plan_id',
        (planFirst.body['plan'] as Record<string, string>)['plan_id']!,
      ),
      1,
    );

    // Reading replay: same key returns the same reading and one event row.
    const readingKey = randomUUID();
    const readingBody = { meter_id: meterId, reading_value: 77, idempotency_key: readingKey };
    const readingFirst = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meter-readings',
      readingBody,
      plannerHeaders,
    );
    assert.strictEqual(readingFirst.status, 201, JSON.stringify(readingFirst.body));
    const readingReplay = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meter-readings',
      readingBody,
      plannerHeaders,
    );
    assert.strictEqual(readingReplay.status, 201, JSON.stringify(readingReplay.body));
    const readingId = (readingFirst.body['reading'] as Record<string, string>)['reading_id']!;
    assert.strictEqual(
      (readingReplay.body['reading'] as Record<string, unknown>)['reading_id'],
      readingId,
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.meter_reading_recorded', 'reading_id', readingId),
      1,
    );

    // Completion replay of a generated work order: same key returns 200, one event row.
    await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Replay WO ${randomUUID().slice(0, 8)}`,
        plan_type: 'calendar',
        interval_days: 30,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: addDays(TODAY, -40),
      },
      plannerHeaders,
    );
    const generated = await generate(assetId, TODAY);
    const workOrderId = (generated['work_order_ids'] as string[])[0]!;
    const completeKey = randomUUID();
    const completeFirst = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      { idempotency_key: completeKey },
      plannerHeaders,
    );
    assert.strictEqual(completeFirst.status, 200, JSON.stringify(completeFirst.body));
    const completeReplay = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      { idempotency_key: completeKey },
      plannerHeaders,
    );
    assert.strictEqual(completeReplay.status, 200, JSON.stringify(completeReplay.body));
    assert.strictEqual(
      await domainEventCountFor('maintenance.work_order_completed', 'work_order_id', workOrderId),
      1,
    );
  });

  it('validates calendar anchor ordering, the interval cap, and the meter next_due_meter override', async () => {
    const assetId = await createAsset('Bounds Probe');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;

    // A first due cycle before the anchor would make the plan born-due with an expired grace
    // window (instantly sweepable).
    const backdated = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Backdated ${randomUUID().slice(0, 8)}`,
        plan_type: 'calendar',
        interval_days: 30,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
        next_due_date: addDays(TODAY, -5),
      },
      plannerHeaders,
    );
    assert.strictEqual(backdated.status, 400, JSON.stringify(backdated.body));
    assert.strictEqual(backdated.body['error_code'], 'INVALID_PARAMS');

    // An interval beyond the cap is a clean 400, not a RangeError 500.
    const hugeInterval = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Huge ${randomUUID().slice(0, 8)}`,
        plan_type: 'calendar',
        interval_days: 100001,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(hugeInterval.status, 400, JSON.stringify(hugeInterval.body));
    assert.strictEqual(hugeInterval.body['error_code'], 'INVALID_PARAMS');

    // An explicit next_due_meter override wins over the seam's locked derivation (0 + 100).
    const overrideRes = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Override ${randomUUID().slice(0, 8)}`,
        plan_type: 'meter',
        meter_id: meterId,
        interval_meter_units: 100,
        next_due_meter: 1000,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(overrideRes.status, 201, JSON.stringify(overrideRes.body));
    assert.strictEqual(
      (overrideRes.body['plan'] as Record<string, unknown>)['next_due_meter'],
      '1000.0000',
      'the explicit override must win over the derived threshold',
    );
  });

  it('supports clamped pagination on the list routes and rejects an invalid readings range', async () => {
    const assetId = await createAsset('Paging Probe');
    const meter = await createMeter(assetId);
    const meterId = meter['meter_id'] as string;
    for (const value of [1, 2, 3]) {
      assert.strictEqual((await postReading(meterId, value)).status, 201);
    }

    const firstPage = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters/${meterId}/readings?limit=1`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(firstPage.status, 200, JSON.stringify(firstPage.body));
    assert.strictEqual((firstPage.body['readings'] as unknown[]).length, 1);

    const secondPage = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters/${meterId}/readings?limit=1&offset=1`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((secondPage.body['readings'] as unknown[]).length, 1);
    assert.notStrictEqual(
      (secondPage.body['readings'] as Record<string, unknown>[])[0]!['reading_id'],
      (firstPage.body['readings'] as Record<string, unknown>[])[0]!['reading_id'],
      'the offset page must not repeat the first row',
    );

    const badFrom = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters/${meterId}/readings?from=not-a-date`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badFrom.status, 400, JSON.stringify(badFrom.body));
    assert.strictEqual(badFrom.body['error_code'], 'INVALID_PARAMS');

    await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters',
      {
        asset_id: assetId,
        meter_code: `PAGE-${randomUUID().slice(0, 8)}`,
        unit: 'hours',
        alert_role: ALERT_ROLE,
      },
      plannerHeaders,
    );
    const metersPage = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/meters?asset_id=${assetId}&limit=1`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((metersPage.body['meters'] as unknown[]).length, 1);
  });

  it('rejects a job trigger without a business_date and a malformed plan definition', async () => {
    const noDate = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/pm/generate',
      {},
      plannerHeaders,
    );
    assert.strictEqual(noDate.status, 400, JSON.stringify(noDate.body));
    assert.strictEqual(noDate.body['error_code'], 'INVALID_PARAMS');

    const assetId = await createAsset('Validation Probe');
    const badInterval = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/plans',
      {
        asset_id: assetId,
        plan_name: `Bad ${randomUUID().slice(0, 8)}`,
        plan_type: 'calendar',
        interval_days: 0,
        grace_period_days: 1,
        escalation_role: ESCALATION_ROLE,
        anchor_date: TODAY,
      },
      plannerHeaders,
    );
    assert.strictEqual(badInterval.status, 400, JSON.stringify(badInterval.body));
    assert.strictEqual(badInterval.body['error_code'], 'INVALID_PARAMS');
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';

/**
 * Story 3.8: Warehouse Task Management and Productivity Tracking (FR-W-07).
 *
 * Mirrors the Story 3.6 harness (SCIM provisioning + dev-token auth, run-scoped identifiers, no
 * TRUNCATE) rather than Story 3.7's, because Story 3.7's file calls SCIM routes that do not exist
 * on the router and therefore fails at setup before any assertion runs.
 *
 * Determinism notes, since two of the three ACs are about elapsed time:
 *  - Task ages are controlled by inserting projection rows with an explicit `created_at` in the
 *    past. There is no API for "a task that is already 90 minutes old".
 *  - Gate dwell is controlled through the gate event's `entered_at` (which the Story 3.2 create
 *    route accepts) while the weighbridge/GRN end of the interval is "now". Each dwell scenario
 *    uses its OWN site so the per-shift median is never a mixture of two scenarios.
 *  - The exactly-4-minute median boundary cannot be produced over HTTP; it is pinned in
 *    test/unit/task-metrics.test.ts against the same decision function this endpoint calls.
 */

const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  raw: string;
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
              parsed = { error_code: 'NON_JSON_BODY' };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, raw });
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
  const res = await makeRequest(port, 'POST', '/api/v1/scim/v2/Users', { externalId, email: externalId, displayName: externalId, roles }, SCIM_HEADERS);
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe('Story 3.8 Warehouse Task Management and Productivity Tracking', () => {
  let server: Server;
  let port: number;

  let managerHeaders: Record<string, string>;
  let frontlineHeaders: Record<string, string>;
  let otherSiteHeaders: Record<string, string>;
  let gateHeaders: Record<string, string>;
  let weighHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  /**
   * Story 3.8 code review: the SOD test must reach the compliance seam, not be stopped by the
   * route RBAC layer. This user holds warehouse WRITE (so /api/v1/events accepts the request) but
   * carries a non-supervisor role, so the seam's assertSupervisor is the one that actually rejects.
   * A pure read-only role would fail on FUNCTION_ACCESS_DENIED upstream and the test would be a
   * false positive: the seam would never get the chance to refuse.
   */
  let nonSupervisorWriteHeaders: Record<string, string>;
  let operatorUserId: string;
  let managerUserId: string;
  /**
   * Story 3.8 code review: the assignment-steal and concurrency tests need a real active user
   * to assign to. The new active-assignee check in the seam and the route refuses any UUID not
   * known to users with ASSIGNEE_NOT_FOUND before it ever reaches the row-level guard, so a
   * raw randomUUID is rejected with 404 before the 409 the test originally expected.
   */
  let otherOperatorUserId: string;

  const run = randomUUID().slice(0, 8);
  // Site A: the task board and productivity fixtures, plus the "weighbridge-resolved breach" shift.
  const siteAId = randomUUID();
  // Site B: an out-of-scope site, used only for the site-scoping negative test.
  const siteBId = randomUUID();
  // Site C: the "under target" dwell shift. Site D: the "GRN fallback" dwell shift.
  const siteCId = randomUUID();
  const siteDId = randomUUID();
  const zoneAId = randomUUID();
  const zoneBId = randomUUID();
  const zoneDId = randomUUID();
  const dockId = randomUUID();
  const dockDId = randomUUID();
  const dockDCode = `DOCK38D-${run}`;
  /**
   * A dedicated operator identity for the AC2 rollup. The board fixtures also attribute tasks to
   * the frontline operator, and counting those would make the confirmation-rate assertion depend on
   * the order the tests happen to run in.
   */
  const productivityOperatorId = randomUUID();

  const siteACode = `S38A-${run}`;
  const siteCCode = `S38C-${run}`;
  const siteDCode = `S38D-${run}`;

  async function seedLocation(locationId: string, code: string, level: string, parentId: string | null, siteId: string): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active')`,
      [locationId, code, level, parentId, siteId],
    );
  }

  async function seedPutawayTask(overrides: {
    siteId?: string;
    zoneId?: string | null;
    status?: 'ready' | 'held' | 'completed';
    createdAt?: string;
    priority?: string;
    assignedTo?: string | null;
    completedAt?: string | null;
    completedBy?: string | null;
  } = {}): Promise<string> {
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO putaway_task
         (putaway_task_id, grn_line_id, sku, quantity, from_location_id, site_id, status, source_event_id,
          created_at, updated_at, priority, assigned_to, zone_id, completed_at, completed_by)
       VALUES ($1, $2, $3, 10, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, $9, $10, $11, $12::timestamptz, $13)`,
      [
        id,
        randomUUID(),
        `SKU-38-${run}`,
        dockId,
        overrides.siteId ?? siteAId,
        overrides.status ?? 'ready',
        randomUUID(),
        overrides.createdAt ?? minutesAgo(5),
        overrides.priority ?? 'normal',
        overrides.assignedTo ?? null,
        overrides.zoneId === undefined ? zoneAId : overrides.zoneId,
        overrides.completedAt ?? null,
        overrides.completedBy ?? null,
      ],
    );
    return id;
  }

  async function seedSalesOrderLine(soNumber: string, siteId: string, siteCode: string): Promise<string> {
    const result = await getPool().query(
      `INSERT INTO erp_sales_order
         (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, 1, $2, 100, $3, $4, 'open', 'ERP', now())
       RETURNING id`,
      [soNumber, `SKU-38-${run}`, siteId, siteCode],
    );
    return result.rows[0]!['id'] as string;
  }

  async function seedPickTask(dispatchOrderId: string, overrides: { createdAt?: string; priority?: string; status?: string } = {}): Promise<string> {
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO pick_task
         (pick_task_id, dispatch_order_id, sku, total_quantity, strategy, zone_id, status, created_by,
          created_at, updated_at, priority)
       VALUES ($1, $2, $3, 10, 'single', $4, $5, $6, $7::timestamptz, $7::timestamptz, $8)`,
      [
        id,
        dispatchOrderId,
        `SKU-38-${run}`,
        zoneAId,
        overrides.status ?? 'pending',
        managerUserId,
        overrides.createdAt ?? minutesAgo(5),
        overrides.priority ?? 'normal',
      ],
    );
    return id;
  }

  /** Creates a real Story 3.2 gate event and returns its binding token plus its business_date. */
  async function createGateEvent(siteCode: string, enteredAt: string): Promise<{ correlationId: string; businessDate: string; gateEventId: string }> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/gate-events',
      {
        site_code_ext: siteCode,
        po_ref_ext: `PO38-${run}`,
        vehicle_reg_ext: `KA01${run.slice(0, 4).toUpperCase()}`,
        challan_number_ext: `CH-${run}`,
        challan_photo_ref: `challan-${randomUUID()}.jpg`,
        driver_name: 'Raman',
        gate_id: 'GATE-1',
        entered_at: enteredAt,
      },
      gateHeaders,
    );
    assert.strictEqual(res.status, 201, `gate create failed: ${res.raw}`);
    return {
      correlationId: res.body['correlation_id'] as string,
      businessDate: res.body['business_date'] as string,
      gateEventId: res.body['gate_event_id'] as string,
    };
  }

  /** Records a real Story 3.3 weighment against a binding token. Its occurred_at is "now". */
  async function recordWeighment(correlationId: string): Promise<string> {
    const weighbridgeEventId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      {
        weighbridge_event_id: weighbridgeEventId,
        correlation_id: correlationId,
        tare_kg: 12000,
        gross_kg: 15500,
        po_ref_ext: `PO38-${run}`,
        line_no: 1,
        device_id: 'WB-DEVICE-1',
        capture_method: 'MANUAL',
      },
      weighHeaders,
    );
    assert.strictEqual(res.status, 201, `weighbridge create failed: ${res.raw}`);
    return weighbridgeEventId;
  }

  /**
   * Story 3.8 code review: a quarantined GRN line surfaces as a "receiving" task on the unified
   * board. The board test now proves this source is wired, not just the pick/putaway ones.
   */
  async function seedQuarantinedGrnLine(overrides: { createdAt?: string } = {}): Promise<string> {
    const grnId = randomUUID();
    const grnLineId = randomUUID();
    const createdAt = overrides.createdAt ?? minutesAgo(40);
    await getPool().query(
      `INSERT INTO grn (grn_id, correlation_id, po_ref_ext, source_document, received_at, received_by, site_id, site_code_ext, source_event_id, business_date)
       VALUES ($1, $2, $3, 'PO', $4::timestamptz, $5, $6, $7, $8, $4::date)`,
      [grnId, randomUUID(), `PO38-REC-${run}`, createdAt, managerUserId, siteAId, siteACode, randomUUID()],
    );
    await getPool().query(
      `INSERT INTO grn_line (grn_line_id, grn_id, po_ref_ext, line_no, sku, target_location_id, received_qty, uom, status, created_at, source_event_id, weighbridge_correlation_id)
       VALUES ($1, $2, $3, 1, $4, $5, 10, 'KG', 'quarantined', $6::timestamptz, $7, $8)`,
      [grnLineId, grnId, `PO38-REC-${run}`, `SKU-38-${run}`, dockId, createdAt, randomUUID(), randomUUID()],
    );
    return grnLineId;
  }

  /**
   * Story 3.8 code review: a packed-but-not-dispatched packing record surfaces as a "packing"
   * task. The packing_record table is the source for the board's fourth task type.
   */
  async function seedPackedNotDispatched(overrides: { createdAt?: string } = {}): Promise<string> {
    const orderId = await seedSalesOrderLine(`SO38-PACK-${run}`, siteAId, siteACode);
    const packingRecordId = randomUUID();
    await getPool().query(
      `INSERT INTO packing_record (packing_record_id, dispatch_order_id, sku, packed_qty, status, packed_by, packed_at, carton_count)
       VALUES ($1, $2, $3, 10, 'packed', $4, $5::timestamptz, 1)`,
      [packingRecordId, orderId, `SKU-38-${run}`, managerUserId, overrides.createdAt ?? minutesAgo(50)],
    );
    return packingRecordId;
  }

  /**
   * Seeds an accepted weighment carrying no capture instant, exactly as a pre-Story-3.8 row looks.
   * Story 3.4 requires an accepted weighment before a GRN may be posted, so this is what lets the
   * GRN-fallback leg of the dwell view be exercised.
   */
  async function seedWeighmentWithoutInstant(correlationId: string, siteId: string, siteCode: string): Promise<void> {
    await getPool().query(
      `INSERT INTO weighbridge_event
         (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
          tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 1000, 1100, 100, 'accepted', 'WB-1', 'MANUAL', $7, CURRENT_DATE, $8)`,
      [randomUUID(), correlationId, randomUUID(), siteId, siteCode, `PO38-${run}`, managerUserId, randomUUID()],
    );
  }

  // site_id is required for a site-wide (null-zone) default: code review made it part of the SLA
  // grain, so a "site-wide" threshold must name the site it governs. A zone-scoped write still takes
  // its site from the zone itself and ignores anything passed here.
  async function setSlaThreshold(
    taskType: string,
    thresholdMinutes: number | string,
    zoneId: string | null,
    headers = managerHeaders,
    siteId: string = siteAId,
  ): Promise<HttpResult> {
    return makeRequest(port, 'PUT', '/api/v1/warehouse-tasks/sla-config', {
      site_id: siteId,
      task_type: taskType,
      zone_id: zoneId,
      threshold_minutes: thresholdMinutes,
    }, headers);
  }

  before(async () => {
    server = createAppServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    await seedLocation(siteAId, siteACode, 'site', null, siteAId);
    await seedLocation(siteBId, `S38B-${run}`, 'site', null, siteBId);
    await seedLocation(siteCId, siteCCode, 'site', null, siteCId);
    await seedLocation(siteDId, siteDCode, 'site', null, siteDId);
    await seedLocation(zoneAId, `Z38A-${run}`, 'zone', siteAId, siteAId);
    await seedLocation(zoneBId, `Z38B-${run}`, 'zone', siteAId, siteAId);
    await seedLocation(dockId, `DOCK38-${run}`, 'bin', zoneAId, siteAId);
    // Site D receives goods, so it needs its own receiving bin: the GRN target location must belong
    // to the site the binding token resolves to.
    await seedLocation(zoneDId, `Z38D-${run}`, 'zone', siteDId, siteDId);
    await seedLocation(dockDId, dockDCode, 'bin', zoneDId, siteDId);

    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [`SKU-38-${run}`],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
      [`PO38-${run}`],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, 3500, 3500, 1, 5, 5, 'ERP', now())`,
      [`PO38-${run}`, `SKU-38-${run}`],
    );

    const everySite = [siteAId, siteCId, siteDId];
    managerUserId = await provisionUser(
      port,
      `wt-manager-${run}@example.com`,
      everySite.map((locationId) => ({ role: 'warehouse_manager', module: 'warehouse', functionScope: 'write' as const, locationId })),
    );
    managerHeaders = await authFor(port, `wt-manager-${run}@example.com`);

    // A frontline role: holds warehouse READ through the unified board, but must not be able to
    // change an SLA threshold or assign work.
    operatorUserId = await provisionUser(port, `wt-frontline-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'warehouse', functionScope: 'read', locationId: siteAId },
    ]);
    frontlineHeaders = await authFor(port, `wt-frontline-${run}@example.com`);

    await provisionUser(port, `wt-otherSite-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: siteBId },
    ]);
    otherSiteHeaders = await authFor(port, `wt-otherSite-${run}@example.com`);

    await provisionUser(
      port,
      `wt-gate-${run}@example.com`,
      everySite.map((locationId) => ({ role: 'gate_officer', module: 'inventory', functionScope: 'write' as const, locationId })),
    );
    gateHeaders = await authFor(port, `wt-gate-${run}@example.com`);

    await provisionUser(
      port,
      `wt-weigh-${run}@example.com`,
      everySite.map((locationId) => ({ role: 'weighbridge_operator', module: 'inventory', functionScope: 'write' as const, locationId })),
    );
    weighHeaders = await authFor(port, `wt-weigh-${run}@example.com`);

    await provisionUser(
      port,
      `wt-store-${run}@example.com`,
      everySite.map((locationId) => ({ role: 'store_assistant', module: 'receiving', functionScope: 'write' as const, locationId })),
    );
    storeHeaders = await authFor(port, `wt-store-${run}@example.com`);

    // Non-supervisor warehouse write user. store_assistant is NOT in WAREHOUSE_TASK_SUPERVISE_ROLES,
    // so any privileged write through /api/v1/events is rejected by the compliance seam, not by
    // the route RBAC layer. The test on line ~725 needs this user to prove the seam gate holds.
    await provisionUser(port, `wt-nonSupervisorWrite-${run}@example.com`, [
      { role: 'store_assistant', module: 'warehouse', functionScope: 'write' as const, locationId: siteAId },
    ]);
    nonSupervisorWriteHeaders = await authFor(port, `wt-nonSupervisorWrite-${run}@example.com`);

    // A second active operator for the assignment-steal and concurrency tests. The new
    // active-assignee check would otherwise 404 a randomUUID, masking the row-level guard those
    // tests are meant to exercise.
    otherOperatorUserId = await provisionUser(port, `wt-otherOperator-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write' as const, locationId: siteAId },
    ]);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  // -------------------------------------------------------------------------
  // AC1: the task board
  // -------------------------------------------------------------------------

  it('AC1: open tasks are grouped by type and operator with age, priority, and zone', async () => {
    const orderId = await seedSalesOrderLine(`SO38-BOARD-${run}`, siteAId, siteACode);
    // Story 3.8 code review: seed with a mix of priorities across BOTH source tables so the
    // ranking is forced to compare priority values rather than whichever domain happened to be
    // first in the UNION. Earlier this test asserted only that "the first row is urgent", which
    // was trivially true under a single-domain query plan and never exercised the cross-source
    // ranking logic.
    const pickLowId = await seedPickTask(orderId, { createdAt: minutesAgo(20), priority: 'low' });
    await seedPickTask(orderId, { createdAt: minutesAgo(15), priority: 'normal' });
    await seedPutawayTask({ createdAt: minutesAgo(9), assignedTo: operatorUserId, priority: 'urgent' });
    const putawayHighId = await seedPutawayTask({ createdAt: minutesAgo(7), assignedTo: operatorUserId, priority: 'high' });

    const res = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks?site_id=${siteAId}`, undefined, managerHeaders);
    assert.strictEqual(res.status, 200, res.raw);

    const tasks = res.body['tasks'] as Array<Record<string, unknown>>;
    assert.ok(tasks.length >= 4, `expected at least the four seeded tasks, got ${tasks.length}`);

    const picking = tasks.find((t) => t['task_id'] === pickLowId)!;
    const putaway = tasks.find((t) => t['task_id'] === putawayHighId)!;
    assert.ok(picking, 'the seeded pick task must appear on the board');
    assert.ok(putaway, 'the seeded putaway task must appear on the board');

    // Age is computed in SQL from created_at, so a 20-minute-old task reads as ~20 minutes.
    assert.ok(Number(picking['age_minutes']) >= 19.9 && Number(picking['age_minutes']) < 25, `unexpected age: ${String(picking['age_minutes'])}`);
    assert.strictEqual(putaway['zone_id'], zoneAId);
    assert.strictEqual(putaway['assigned_to'], operatorUserId);
    assert.strictEqual(picking['site_id'], siteAId);

    // Priority ranking is independent of the UNION source order. A putaway "urgent" task must
    // rank above a pick "high" task, and the pick "low" task must be at or near the bottom.
    const priorityOrder = tasks.map((t) => t['priority'] as string);
    const urgentIndex = priorityOrder.indexOf('urgent');
    const highIndex = priorityOrder.indexOf('high');
    const normalIndex = priorityOrder.indexOf('normal');
    const lowIndex = priorityOrder.indexOf('low');
    assert.ok(urgentIndex < highIndex, `urgent (${urgentIndex}) must precede high (${highIndex}); order=${priorityOrder.join(',')}`);
    assert.ok(highIndex < normalIndex, `high (${highIndex}) must precede normal (${normalIndex}); order=${priorityOrder.join(',')}`);
    assert.ok(normalIndex < lowIndex, `normal (${normalIndex}) must precede low (${lowIndex}); order=${priorityOrder.join(',')}`);

    const groups = res.body['groups'] as Array<Record<string, unknown>>;
    const pickingGroup = groups.find((g) => g['task_type'] === 'picking')!;
    const putawayGroup = groups.find((g) => g['task_type'] === 'putaway')!;
    assert.ok(pickingGroup && putawayGroup, 'the board groups by task type');
    const putawayOperators = putawayGroup['operators'] as Array<Record<string, unknown>>;
    assert.ok(putawayOperators.some((o) => o['assigned_to'] === operatorUserId), 'the board groups by operator within a type');
  });

  it('AC1: receiving and packing sources appear on the unified board with their own priority', async () => {
    // Story 3.8 code review: the original task-board tests only seeded pick and putaway tasks.
    // They proved nothing about whether the receiving (grn_line quarantined) and packing
    // (packing_record packed-but-undispatched) sources actually surface. Seed both, then assert
    // they are present and on the board.
    await seedQuarantinedGrnLine({ createdAt: minutesAgo(40) });
    await seedPackedNotDispatched({ createdAt: minutesAgo(50) });

    const res = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks?site_id=${siteAId}`, undefined, managerHeaders);
    assert.strictEqual(res.status, 200, res.raw);
    const tasks = res.body['tasks'] as Array<Record<string, unknown>>;
    const receiving = tasks.find((t) => t['task_type'] === 'receiving');
    const packing = tasks.find((t) => t['task_type'] === 'packing');
    assert.ok(receiving, 'a quarantined GRN line must surface as a receiving task on the unified board');
    assert.ok(packing, 'a packed-but-undispatched packing record must surface as a packing task on the unified board');
  });

  it('AC1: a task past its configured SLA threshold is flagged with the breached threshold shown', async () => {
    // A zone-specific threshold of 5 minutes for putaway in zone B.
    const configured = await setSlaThreshold('putaway', 5, zoneBId);
    assert.strictEqual(configured.status, 200, configured.raw);

    const breachingId = await seedPutawayTask({ zoneId: zoneBId, createdAt: minutesAgo(45) });
    const healthyId = await seedPutawayTask({ zoneId: zoneBId, createdAt: minutesAgo(1) });

    const res = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks?site_id=${siteAId}&task_type=putaway&zone_id=${zoneBId}`, undefined, managerHeaders);
    assert.strictEqual(res.status, 200, res.raw);
    const tasks = res.body['tasks'] as Array<Record<string, unknown>>;

    const breaching = tasks.find((t) => t['task_id'] === breachingId)!;
    const healthy = tasks.find((t) => t['task_id'] === healthyId)!;
    assert.ok(breaching && healthy);

    assert.strictEqual(breaching['breached'], true);
    // AC1 requires the breached threshold itself to be shown, not merely a boolean.
    assert.strictEqual(String(breaching['breached_threshold_minutes']), '5.00');
    assert.strictEqual(breaching['sla_threshold_minutes'], '5.00');

    assert.strictEqual(healthy['breached'], false);
    assert.strictEqual(healthy['breached_threshold_minutes'], null);
    assert.strictEqual(healthy['sla_threshold_minutes'], '5.00');

    const summary = res.body['summary'] as Record<string, unknown>;
    assert.ok(Number(summary['breached_count']) >= 1);
  });

  it('AC1: a zone-specific threshold overrides the site-wide default for that zone only', async () => {
    // Site-wide default for picking is generous; zone A is strict.
    assert.strictEqual((await setSlaThreshold('picking', 600, null)).status, 200);
    assert.strictEqual((await setSlaThreshold('picking', 1, zoneAId)).status, 200);

    const orderId = await seedSalesOrderLine(`SO38-ZONE-${run}`, siteAId, siteACode);
    const zoneScoped = await seedPickTask(orderId, { createdAt: minutesAgo(30) });

    const res = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks?site_id=${siteAId}&task_type=picking`, undefined, managerHeaders);
    assert.strictEqual(res.status, 200, res.raw);
    const task = (res.body['tasks'] as Array<Record<string, unknown>>).find((t) => t['task_id'] === zoneScoped)!;
    assert.ok(task);
    // Resolved against the zone row (1 minute), not the site-wide default (600 minutes).
    assert.strictEqual(task['sla_threshold_minutes'], '1.00');
    assert.strictEqual(task['breached'], true);
  });

  it('AC1: a malformed filter is rejected with 400 INVALID_PARAMS before any query runs', async () => {
    const badType = await makeRequest(port, 'GET', '/api/v1/warehouse-tasks?task_type=teleportation', undefined, managerHeaders);
    assert.strictEqual(badType.status, 400, badType.raw);
    assert.strictEqual(badType.body['error_code'], 'INVALID_PARAMS');

    const badUuid = await makeRequest(port, 'GET', '/api/v1/warehouse-tasks?zone_id=not-a-uuid', undefined, managerHeaders);
    assert.strictEqual(badUuid.status, 400, badUuid.raw);
    assert.strictEqual(badUuid.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC2: completion identity, duration, and confirmation rate
  // -------------------------------------------------------------------------

  it('AC2: completed tasks carry operator identity and duration, and the confirmation rate reflects them', async () => {
    const periodStart = minutesAgo(180);
    const periodEnd = new Date(Date.now() + 60 * 1000).toISOString();

    // Four tasks attributed to this operator in the window; two of them completed.
    const op = productivityOperatorId;
    await seedPutawayTask({ zoneId: zoneBId, createdAt: minutesAgo(120), assignedTo: op, status: 'completed', completedAt: minutesAgo(110), completedBy: op });
    await seedPutawayTask({ zoneId: zoneBId, createdAt: minutesAgo(100), assignedTo: op, status: 'completed', completedAt: minutesAgo(80), completedBy: op });
    await seedPutawayTask({ zoneId: zoneBId, createdAt: minutesAgo(90), assignedTo: op });
    await seedPutawayTask({ zoneId: zoneBId, createdAt: minutesAgo(85), assignedTo: op });

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/warehouse-tasks/productivity?site_id=${siteAId}&operator_id=${op}&period_start=${encodeURIComponent(periodStart)}&period_end=${encodeURIComponent(periodEnd)}`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(res.status, 200, res.raw);

    const byOperator = res.body['by_operator'] as Array<Record<string, unknown>>;
    const row = byOperator.find((r) => r['operator_id'] === op)!;
    assert.ok(row, 'the operator must appear in the per-operator rollup');
    assert.strictEqual(Number(row['assigned_count']), 4);
    assert.strictEqual(Number(row['completed_count']), 2);
    assert.strictEqual(row['confirmation_rate'], '0.5000');

    // Durations are computed in SQL: 10 minutes and 20 minutes -> mean 900s, median 900s.
    assert.ok(row['avg_duration_seconds'] !== null, 'duration must be reported for completed tasks');
    assert.ok(Math.abs(Number(row['avg_duration_seconds']) - 900) < 2, `unexpected mean duration: ${String(row['avg_duration_seconds'])}`);
    assert.ok(Math.abs(Number(row['median_duration_seconds']) - 900) < 2, `unexpected median duration: ${String(row['median_duration_seconds'])}`);

    const byZone = res.body['by_zone'] as Array<Record<string, unknown>>;
    const zoneRow = byZone.find((r) => r['zone_id'] === zoneBId)!;
    assert.ok(zoneRow, 'the zone must appear in the per-zone rollup');
    assert.strictEqual(Number(zoneRow['completed_count']), 2);
  });

  it('AC2: an inverted period window is rejected rather than silently returning nothing', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/warehouse-tasks/productivity?site_id=${siteAId}&period_start=2026-07-29T10:00:00Z&period_end=2026-07-29T09:00:00Z`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(res.status, 400, res.raw);
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC3: gate dwell
  // -------------------------------------------------------------------------

  it('AC3 (Task 1): a real weighment persists its capture instant, so dwell is computable', async () => {
    const gate = await createGateEvent(siteACode, minutesAgo(11));
    const weighbridgeEventId = await recordWeighment(gate.correlationId);

    const stored = await getPool().query(`SELECT occurred_at FROM weighbridge_event WHERE weighbridge_event_id = $1`, [weighbridgeEventId]);
    assert.strictEqual(stored.rows.length, 1);
    assert.ok(stored.rows[0]!['occurred_at'] !== null, 'Story 3.3 discarded the capture instant; Story 3.8 must persist it');

    const view = await getPool().query(
      `SELECT resolution_source, weighment_present, challan_photo_present,
              ROUND((EXTRACT(EPOCH FROM dwell_interval) / 60.0)::numeric, 2)::text AS dwell_minutes
         FROM gate_dwell_metric WHERE correlation_id = $1`,
      [gate.correlationId],
    );
    assert.strictEqual(view.rows.length, 1, 'the dwell view must resolve this vehicle');
    assert.strictEqual(view.rows[0]!['resolution_source'], 'weighbridge');
    assert.strictEqual(view.rows[0]!['weighment_present'], true);
    assert.strictEqual(view.rows[0]!['challan_photo_present'], true);
    assert.ok(Number(view.rows[0]!['dwell_minutes']) >= 10.9, `expected roughly 11 minutes, got ${String(view.rows[0]!['dwell_minutes'])}`);
  });

  it('AC3: a shift whose median dwell exceeds 4 minutes is reported as an exception with drill-through', async () => {
    const gate = await createGateEvent(siteACode, minutesAgo(12));
    await recordWeighment(gate.correlationId);

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/warehouse-tasks/exceptions/gate-dwell?site_id=${siteAId}&business_date=${gate.businessDate}`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(res.status, 200, res.raw);
    assert.strictEqual(Number(res.body['target_minutes']), 4);

    const exceptions = res.body['exceptions'] as Array<Record<string, unknown>>;
    const shift = exceptions.find((s) => s['site_id'] === siteAId && s['business_date'] === gate.businessDate)!;
    assert.ok(shift, `expected an exception for site A on ${gate.businessDate}: ${res.raw}`);
    assert.strictEqual(shift['exceeded'], true);
    assert.ok(Number(shift['median_dwell_minutes']) > 4);

    // AC3's drill-through: the individual gate events that breached, each traceable by token.
    const breaches = shift['breaches'] as Array<Record<string, unknown>>;
    assert.ok(breaches.length >= 1, 'a breaching shift must expose its breaching vehicles');
    const breach = breaches.find((b) => b['correlation_id'] === gate.correlationId)!;
    assert.ok(breach, 'the drill-through must include this vehicle by correlation_id');
    assert.strictEqual(breach['resolution_source'], 'weighbridge');
    assert.ok(Number(breach['dwell_minutes']) > 4);

    // SM-C2: capture completeness is reported alongside the dwell, never hidden behind it.
    const completeness = shift['capture_completeness'] as Record<string, unknown>;
    assert.ok(Number(completeness['challan_photo_present_count']) >= 1);
    assert.ok(Number(completeness['weighment_present_count']) >= 1);
  });

  it('AC3: a shift comfortably under the 4-minute target produces no exception', async () => {
    const gate = await createGateEvent(siteCCode, minutesAgo(1));
    await recordWeighment(gate.correlationId);

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/warehouse-tasks/exceptions/gate-dwell?site_id=${siteCId}&business_date=${gate.businessDate}`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(res.status, 200, res.raw);
    const shifts = res.body['shifts'] as Array<Record<string, unknown>>;
    const shift = shifts.find((s) => s['site_id'] === siteCId)!;
    assert.ok(shift, `expected the site C shift to be reported: ${res.raw}`);
    assert.ok(Number(shift['median_dwell_minutes']) < 4);
    assert.strictEqual(shift['exceeded'], false);
    assert.deepStrictEqual(shift['breaches'], []);
    assert.strictEqual((res.body['exceptions'] as unknown[]).length, 0);
  });

  it('AC3 (Task 1): where no weighment instant applies, dwell falls back to GRN confirmation', async () => {
    const gate = await createGateEvent(siteDCode, minutesAgo(13));
    // An accepted weighment with no capture instant: Story 3.4 needs it to allow the receipt, and
    // the dwell view must then fall through to the GRN leg rather than dropping the vehicle.
    await seedWeighmentWithoutInstant(gate.correlationId, siteDId, siteDCode);

    const grn = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: gate.correlationId,
        po_ref_ext: `PO38-${run}`,
        line_no: 1,
        source_document: 'PO',
        sku: `SKU-38-${run}`,
        target_location_code: dockDCode,
        received_qty: 10,
      },
      storeHeaders,
    );
    assert.strictEqual(grn.status, 201, `grn create failed: ${grn.raw}`);

    const stored = await getPool().query(`SELECT received_at FROM grn WHERE correlation_id = $1`, [gate.correlationId]);
    assert.strictEqual(stored.rows.length, 1);
    assert.ok(stored.rows[0]!['received_at'] !== null, 'Story 3.4 discarded the receipt instant; Story 3.8 must persist it');

    const view = await getPool().query(
      `SELECT resolution_source, weighment_present, grn_fallback_used FROM gate_dwell_metric WHERE correlation_id = $1`,
      [gate.correlationId],
    );
    assert.strictEqual(view.rows.length, 1);
    assert.strictEqual(view.rows[0]!['resolution_source'], 'grn');
    // weighment_present asks whether an accepted weighment EXISTS, not whether it carried a capture
    // instant. This vehicle WAS weighed - the weighment simply predates the migration that added
    // occurred_at - so reporting it as unweighed would have SM-C2 flagging a skipped capture that
    // never happened. grn_fallback_used stays true because the dwell was in fact resolved from the
    // GRN; the two answer different questions and must not be derived from each other.
    assert.strictEqual(view.rows[0]!['weighment_present'], true);
    assert.strictEqual(view.rows[0]!['grn_fallback_used'], true);

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/warehouse-tasks/exceptions/gate-dwell?site_id=${siteDId}&business_date=${gate.businessDate}`,
      undefined,
      managerHeaders,
    );
    assert.strictEqual(res.status, 200, res.raw);
    const shift = (res.body['shifts'] as Array<Record<string, unknown>>).find((s) => s['site_id'] === siteDId)!;
    assert.ok(shift);
    assert.strictEqual(shift['exceeded'], true);
    const completeness = shift['capture_completeness'] as Record<string, unknown>;
    assert.ok(Number(completeness['grn_fallback_count']) >= 1, 'a GRN-fallback resolution must be visible as a capture-completeness counter');
  });

  // -------------------------------------------------------------------------
  // SLA configuration, RBAC, SOD, and site scoping
  // -------------------------------------------------------------------------

  it('SLA config: a supervisor sets a threshold through the event seam and can read it back', async () => {
    const res = await setSlaThreshold('packing', '12.50', null);
    assert.strictEqual(res.status, 200, res.raw);
    assert.ok(typeof res.body['event_id'] === 'string', 'the change must be recorded as a domain event, not a direct UPDATE');
    const config = res.body['sla_config'] as Record<string, unknown>;
    assert.strictEqual(config['threshold_minutes'], '12.50');
    assert.strictEqual(config['zone_id'], null);
    // updated_by is server-set from the authenticated actor, never a client value or a placeholder.
    assert.strictEqual(config['updated_by'], managerUserId);

    const read = await makeRequest(port, 'GET', '/api/v1/warehouse-tasks/sla-config?task_type=packing', undefined, managerHeaders);
    assert.strictEqual(read.status, 200, read.raw);
    const configs = read.body['sla_configs'] as Array<Record<string, unknown>>;
    assert.strictEqual(configs.length, 1, 'one row per (task_type, zone_id) grain, never a duplicate site-wide row');
    assert.strictEqual(configs[0]!['threshold_minutes'], '12.50');
  });

  it('SLA config: repeating an update at the same grain replaces the value instead of stacking rows', async () => {
    assert.strictEqual((await setSlaThreshold('receiving', 20, null)).status, 200);
    assert.strictEqual((await setSlaThreshold('receiving', 35, null)).status, 200);

    const read = await makeRequest(port, 'GET', '/api/v1/warehouse-tasks/sla-config?task_type=receiving', undefined, managerHeaders);
    const configs = read.body['sla_configs'] as Array<Record<string, unknown>>;
    assert.strictEqual(configs.length, 1, 'NULLS NOT DISTINCT must collapse the site-wide grain to one row');
    assert.strictEqual(configs[0]!['threshold_minutes'], '35.00');
  });

  it('SLA config: a replayed idempotency key does not apply the change twice', async () => {
    const idempotencyKey = `sla-replay-${run}`;
    const first = await makeRequest(port, 'PUT', '/api/v1/warehouse-tasks/sla-config', {
      site_id: siteAId, task_type: 'putaway', zone_id: null, threshold_minutes: 42, idempotency_key: idempotencyKey,
    }, managerHeaders);
    assert.strictEqual(first.status, 200, first.raw);

    // A second PUT with the SAME idempotency key but a different value must be a no-op: the first
    // value stays, the second value never lands, and no second domain event is recorded.
    const replay = await makeRequest(port, 'PUT', '/api/v1/warehouse-tasks/sla-config', {
      site_id: siteAId, task_type: 'putaway', zone_id: null, threshold_minutes: 99, idempotency_key: idempotencyKey,
    }, managerHeaders);
    // Either the duplicate is rejected outright or it short-circuits; what must NOT happen is the
    // second value silently landing under a key that already committed a different one.
    assert.ok(replay.status === 409 || replay.status === 200, replay.raw);

    const read = await makeRequest(port, 'GET', '/api/v1/warehouse-tasks/sla-config?task_type=putaway', undefined, managerHeaders);
    const siteWide = (read.body['sla_configs'] as Array<Record<string, unknown>>).find((c) => c['zone_id'] === null)!;
    assert.strictEqual(siteWide['threshold_minutes'], '42.00', 'the replayed key must not overwrite the committed threshold');

    // Exactly one domain event was recorded for this idempotency key, never two.
    const eventCount = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.strictEqual(eventCount.rows[0]!['n'], 1, `a replayed key must produce exactly one domain event; got ${eventCount.rows[0]!['n']}`);
  });

  it('assignment idempotency: a retried assign with the same key does not change the row', async () => {
    // Replay-safe: a second POST with the same idempotency_key must return the original event
    // without re-applying the projection. The first write commits an "in_progress" status change
    // to the pick task; a duplicate must NOT observe that change as a state conflict.
    const dispatchOrderId = await seedSalesOrderLine(`SO38-REPLAY-${run}`, siteAId, siteACode);
    const pickTaskId = await seedPickTask(dispatchOrderId, { createdAt: minutesAgo(2) });

    const idem = `assign-replay-${run}`;
    const first = await makeRequest(port, 'POST', `/api/v1/pick-tasks/${pickTaskId}/assign`, {
      assigned_to: operatorUserId, priority: 'high', idempotency_key: idem,
    }, managerHeaders);
    assert.strictEqual(first.status, 200, first.raw);

    const second = await makeRequest(port, 'POST', `/api/v1/pick-tasks/${pickTaskId}/assign`, {
      assigned_to: operatorUserId, priority: 'urgent', idempotency_key: idem,
    }, managerHeaders);
    // The duplicate path is by design a no-op (or a 409) and must not apply the second value.
    assert.ok(second.status === 200 || second.status === 409, second.raw);

    const read = await getPool().query(
      `SELECT priority, assigned_to, status FROM pick_task WHERE pick_task_id = $1`,
      [pickTaskId],
    );
    assert.strictEqual(read.rows[0]!['priority'], 'high', 'a replay must not overwrite the committed priority');
    assert.strictEqual(read.rows[0]!['assigned_to'], operatorUserId, 'a replay must not change the assignee');
  });

  it('assignment concurrency: only one of two concurrent assigns to the same task wins', async () => {
    // Two simultaneous assigns to the same task from two different operators. The status=
    // predicate + assignee guard ensures exactly one UPDATE returns rowCount=1, the other
    // returns 0 and surfaces as 409 PUTAWAY_TASK_ALREADY_ASSIGNED. The losing supervisor must
    // not silently succeed and the task's assigned_to must be exactly the winner.
    const taskId = await seedPutawayTask({ createdAt: minutesAgo(2) });

    const [a, b] = await Promise.all([
      makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: operatorUserId }, managerHeaders),
      makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: otherOperatorUserId }, managerHeaders),
    ]);

    const statuses = [a.status, b.status].sort();
    // One wins (200) and the other loses (409). The exact pair is one each.
    assert.deepStrictEqual(statuses, [200, 409], `expected one 200 and one 409, got ${statuses.join(',')}: a=${a.raw} b=${b.raw}`);

    const after = await getPool().query(`SELECT assigned_to FROM putaway_task WHERE putaway_task_id = $1`, [taskId]);
    assert.ok([operatorUserId, otherOperatorUserId].includes(after.rows[0]!['assigned_to'] as string), 'the task must be assigned to exactly one of the two requesters');
    const winner = (a.status === 200 ? a : b).body['task'] as Record<string, unknown>;
    assert.strictEqual(winner['assigned_to'], after.rows[0]!['assigned_to'], 'the winner row and the row read back must agree on the assignee');
  });

  it('assignment replay: a retried assign with the same idempotency_key yields a deterministic assigned_at', async () => {
    // Story 3.8 code review: assignPickTask previously used now() for assigned_at, so a replay
    // produced a different timestamp than the original. The fix uses the event capture instant,
    // so the replay yields the SAME assigned_at as the first apply.
    const taskId = await seedPutawayTask({ createdAt: minutesAgo(1) });
    const idem = `assign-replay-ts-${run}`;
    const first = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, {
      assigned_to: operatorUserId, priority: 'normal', idempotency_key: idem,
    }, managerHeaders);
    assert.strictEqual(first.status, 200, first.raw);

    // Re-read what was written.
    const firstRow = await getPool().query(`SELECT assigned_at FROM putaway_task WHERE putaway_task_id = $1`, [taskId]);
    const firstAssignedAt = (firstRow.rows[0]!['assigned_at'] as Date).toISOString();

    // The original event's capture instant determines assigned_at, so a fresh request with the
    // same key short-circuits and the row does not move.
    const second = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, {
      assigned_to: operatorUserId, priority: 'normal', idempotency_key: idem,
    }, managerHeaders);
    assert.ok(second.status === 200 || second.status === 409, second.raw);

    const secondRow = await getPool().query(`SELECT assigned_at FROM putaway_task WHERE putaway_task_id = $1`, [taskId]);
    const secondAssignedAt = (secondRow.rows[0]!['assigned_at'] as Date).toISOString();
    assert.strictEqual(secondAssignedAt, firstAssignedAt, `a replay must not move assigned_at; was ${firstAssignedAt}, now ${secondAssignedAt}`);
  });

  it('RBAC: a frontline role may read the board but may not change an SLA threshold', async () => {
    const read = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks?site_id=${siteAId}`, undefined, frontlineHeaders);
    assert.strictEqual(read.status, 200, `frontline read access must not regress: ${read.raw}`);

    const write = await setSlaThreshold('picking', 15, null, frontlineHeaders);
    assert.ok(write.status === 403, write.raw);
    assert.ok(
      write.body['error_code'] === 'FUNCTION_ACCESS_DENIED',
      `expected FUNCTION_ACCESS_DENIED, got ${String(write.body['error_code'])}`,
    );
  });

  it('SOD: the supervisor-only gate holds on the direct event path, not just the HTTP handler', async () => {
    // A non-supervisor user with warehouse WRITE posting the same event straight to /api/v1/events
    // must be refused by the compliance seam. A pure read-only role would be stopped by the route
    // RBAC layer and never reach the seam, leaving the test as a false positive. This user passes
    // /api/v1/events's requireRole check (write on the warehouse module) and is then stopped by
    // assertSupervisor, which is the placement that actually holds against a direct POST.
    const res = await makeRequest(port, 'POST', '/api/v1/events', {
      stream_type: 'warehouse',
      stream_id: randomUUID(),
      event_type: 'task_sla_config.updated',
      payload: { site_id: siteAId, task_type: 'picking', zone_id: null, threshold_minutes: 1 },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: operatorUserId, role: 'store_assistant', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    }, nonSupervisorWriteHeaders);
    assert.strictEqual(res.status, 403, `direct event path must be gated by the seam, got ${res.status}: ${res.raw}`);
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('SOD: a malformed threshold is rejected before it can consume an idempotency key', async () => {
    const res = await setSlaThreshold('picking', -5, null);
    assert.strictEqual(res.status, 400, res.raw);
    assert.strictEqual(res.body['error_code'], 'TASK_SLA_CONFIG_INVALID_PAYLOAD');

    const tooPrecise = await setSlaThreshold('picking', '5.005', null);
    assert.strictEqual(tooPrecise.status, 400, tooPrecise.raw);
    assert.strictEqual(tooPrecise.body['error_code'], 'TASK_SLA_CONFIG_INVALID_PAYLOAD');
  });

  it('RBAC: assignment is supervisor-only and server-sets the assigning identity', async () => {
    const taskId = await seedPutawayTask({ createdAt: minutesAgo(3) });

    const denied = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: operatorUserId }, frontlineHeaders);
    assert.strictEqual(denied.status, 403, denied.raw);
    assert.strictEqual(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const ok = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: operatorUserId, priority: 'high', assigned_by: '00000000-0000-4000-8000-000000000000' }, managerHeaders);
    assert.strictEqual(ok.status, 200, ok.raw);
    const task = ok.body['task'] as Record<string, unknown>;
    assert.strictEqual(task['assigned_to'], operatorUserId);
    assert.strictEqual(task['priority'], 'high');
    // The client tried to supply assigned_by; the server must ignore it and stamp the real actor.
    assert.strictEqual(task['assigned_by'], managerUserId);
  });

  it('RBAC: assigning a task that is no longer ready is a 409, never a silent reassignment', async () => {
    const completedTask = await seedPutawayTask({ status: 'completed', createdAt: minutesAgo(30), completedAt: minutesAgo(5), completedBy: operatorUserId });
    const res = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${completedTask}/assign`, { assigned_to: operatorUserId }, managerHeaders);
    assert.strictEqual(res.status, 409, res.raw);
    // The seam distinguishes the two ways an assignment can fail closed: the task is not in 'ready'
    // status, or it is ready but already held by a different operator. The single
    // PUTAWAY_TASK_NOT_ASSIGNABLE code could not tell a supervisor which had happened.
    assert.strictEqual(res.body['error_code'], 'PUTAWAY_TASK_NOT_READY');
  });

  it('assignment is refused rather than silently stolen when another operator already holds the task', async () => {
    const taskId = await seedPutawayTask({ createdAt: minutesAgo(4) });
    const first = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: operatorUserId }, managerHeaders);
    assert.strictEqual(first.status, 200, first.raw);

    const steal = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: otherOperatorUserId }, managerHeaders);
    assert.strictEqual(steal.status, 409, steal.raw);
    assert.strictEqual(steal.body['error_code'], 'PUTAWAY_TASK_ALREADY_ASSIGNED');

    // The original assignee must still hold the task: the losing write changed nothing.
    const after = await makeRequest(port, 'GET', `/api/v1/putaway-tasks/${taskId}`, undefined, managerHeaders);
    assert.strictEqual((after.body['task'] as Record<string, unknown>)['assigned_to'], operatorUserId);
  });

  it('assignment is recorded as a domain event so a projection rebuild does not lose it', async () => {
    const taskId = await seedPutawayTask({ createdAt: minutesAgo(2) });
    const res = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: operatorUserId, priority: 'urgent' }, managerHeaders);
    assert.strictEqual(res.status, 200, res.raw);
    assert.ok(typeof res.body['event_id'] === 'string', 'assignment must carry a domain event, not be a direct read-model write');

    const evt = await getPool().query(
      `SELECT event_type, payload FROM domain_events WHERE event_id = $1`,
      [res.body['event_id']],
    );
    assert.strictEqual(evt.rows.length, 1, 'the assignment event must be durably recorded');
    assert.strictEqual(evt.rows[0]!['event_type'], 'putaway_task.assigned');
  });

  it('RBAC: an invalid assignment payload is a 400, not a database error', async () => {
    const taskId = await seedPutawayTask({ createdAt: minutesAgo(2) });
    const res = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: 'nobody' }, managerHeaders);
    assert.strictEqual(res.status, 400, res.raw);
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');

    const badPriority = await makeRequest(port, 'POST', `/api/v1/putaway-tasks/${taskId}/assign`, { assigned_to: operatorUserId, priority: 'immediately' }, managerHeaders);
    assert.strictEqual(badPriority.status, 400, badPriority.raw);
    assert.strictEqual(badPriority.body['error_code'], 'INVALID_PARAMS');
  });

  it('Site scoping: an out-of-scope site is refused on every new read surface', async () => {
    for (const path of [
      `/api/v1/warehouse-tasks?site_id=${siteAId}`,
      `/api/v1/warehouse-tasks/productivity?site_id=${siteAId}`,
      `/api/v1/warehouse-tasks/exceptions/gate-dwell?site_id=${siteAId}`,
      `/api/v1/warehouse-tasks/sla-config?site_id=${siteAId}`,
    ]) {
      const res = await makeRequest(port, 'GET', path, undefined, otherSiteHeaders);
      assert.strictEqual(res.status, 403, `${path} must refuse an out-of-scope site: ${res.raw}`);
      assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }
  });

  it('Site scoping: an SLA config write is refused for an out-of-scope site', async () => {
    // otherSiteHeaders is the site-B manager; the site-A site filter must be rejected.
    const denied = await setSlaThreshold('putaway', 20, null, otherSiteHeaders, siteAId);
    assert.strictEqual(denied.status, 403, denied.raw);
    assert.strictEqual(denied.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('Metrics RBAC: a frontline warehouse role is denied on the productivity and gate-dwell endpoints', async () => {
    // The metrics endpoints share the board's role list, which let a store_assistant pull
    // per-colleague confirmation rates. They are gated more tightly than the board.
    const prod = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks/productivity?site_id=${siteAId}`, undefined, frontlineHeaders);
    assert.strictEqual(prod.status, 403, `productivity must refuse a frontline role: ${prod.raw}`);
    assert.strictEqual(prod.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const dwell = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks/exceptions/gate-dwell?site_id=${siteAId}`, undefined, frontlineHeaders);
    assert.strictEqual(dwell.status, 403, `gate-dwell must refuse a frontline role: ${dwell.raw}`);
    assert.strictEqual(dwell.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('Site scoping: an unfiltered board is narrowed to the sites the caller may see', async () => {
    // The site-B manager holds no assignment at site A, so site A's tasks must not appear even when
    // no site filter is supplied at all.
    const res = await makeRequest(port, 'GET', '/api/v1/warehouse-tasks', undefined, otherSiteHeaders);
    assert.strictEqual(res.status, 200, res.raw);
    const tasks = res.body['tasks'] as Array<Record<string, unknown>>;
    assert.ok(tasks.every((t) => t['site_id'] !== siteAId), 'an unscoped read must not leak another site’s tasks');
  });

  it('Schema: the gate_dwell_metric view exists with the columns the dashboard contract depends on', async () => {
    // The schema-drift harness only understands CREATE TABLE blocks, so a view is asserted here.
    const result = await getPool().query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'gate_dwell_metric' ORDER BY column_name`,
    );
    const columns = result.rows.map((r) => r['column_name'] as string);
    for (const expected of [
      'business_date',
      'challan_photo_present',
      'correlation_id',
      'dwell_interval',
      'gate_entered_at',
      'gate_event_id',
      'grn_fallback_used',
      'resolution_source',
      'resolved_at',
      'site_id',
      'vehicle_reg_ext',
      'weighment_present',
    ]) {
      assert.ok(columns.includes(expected), `gate_dwell_metric must expose ${expected}; has ${columns.join(', ')}`);
    }
  });
});

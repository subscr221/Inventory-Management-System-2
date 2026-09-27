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
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/** Every path to a number-typed value anywhere in `value` (AC 2: availability shows no quantity). */
function numericPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => numericPaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      numericPaths(v, `${path}.${k}`),
    );
  }
  return [];
}

describe('Story 1.15 Employee Base Role', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const binFree = randomUUID();
  const binJobWork = randomUUID();
  const binAllocated = randomUUID();
  const binHeld = randomUUID();
  const binQuarantine = randomUUID();
  const binSiteB = randomUUID();
  const SKU = `SKU-115-${run}`;
  const HELD_LOT = `LOT-115-HELD-${run}`;

  let emp1Id: string;
  let emp1: Record<string, string>;
  let emp2: Record<string, string>;
  let nosite: Record<string, string>;
  let po1: Record<string, string>;
  let gateEmp: Record<string, string>;
  let emp2IndentId: string;

  const employeeAt = (locationId: string): Role => ({
    role: 'employee',
    module: 'employee',
    functionScope: 'write',
    locationId,
  });

  function raiseBody(sku: string, unitPrice = 100): Record<string, unknown> {
    return {
      department_code: 'MAINT',
      site_id: siteA,
      business_stream: 'production',
      need_by_date: '2026-10-15',
      urgent: false,
      reason: 'Gloves for the line',
      lines: [
        {
          sku,
          item_category: 'consumables',
          requested_qty: 10,
          uom: 'EA',
          unit_price_estimate: unitPrice,
        },
      ],
      confirm_duplicate: true,
    };
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
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/qc_inspection_task.sql',
      '../../read/projections/ownership_agreement.sql',
      '../../read/projections/edge_refused_capture.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE indent_line, indent, stock_balance, lot_master, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    // Locations: two sites; five bins under site A covering each availability rule, one under B.
    const locations: [string, string, string, string | null, string, boolean][] = [
      [siteA, `S115A-${run}`, 'site', null, siteA, false],
      [siteB, `S115B-${run}`, 'site', null, siteB, false],
      [binFree, `S115A-BIN-1-${run}`, 'bin', siteA, siteA, false],
      [binJobWork, `S115A-BIN-2-${run}`, 'bin', siteA, siteA, false],
      [binAllocated, `S115A-BIN-3-${run}`, 'bin', siteA, siteA, false],
      [binHeld, `S115A-BIN-4-${run}`, 'bin', siteA, siteA, false],
      [binQuarantine, `S115A-BIN-5-${run}`, 'bin', siteA, siteA, true],
      [binSiteB, `S115B-BIN-1-${run}`, 'bin', siteB, siteB, false],
    ];
    for (const [id, code, level, parent, site, quarantine] of locations) {
      await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
         VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', $6, 'active')`,
        [id, code, level, parent ?? id, site, quarantine],
      );
    }
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, 'weighted_average', 'production', 'active')`,
      [SKU],
    );
    await getPool().query(
      `INSERT INTO lot_master (lot_number, sku, quality_hold_status, quality_hold_reason) VALUES ($1, $2, 'held', 'QC hold')`,
      [HELD_LOT, SKU],
    );
    const balances: [string, string | null, string, number, number][] = [
      [binFree, null, 'owned', 10, 2],
      [binJobWork, null, 'job_work', 5, 0],
      [binAllocated, null, 'owned', 4, 4],
      [binHeld, HELD_LOT, 'owned', 6, 0],
      [binQuarantine, null, 'owned', 3, 0],
      [binSiteB, null, 'owned', 9, 0],
    ];
    for (const [locationId, lot, stockClass, onHand, allocated] of balances) {
      await getPool().query(
        `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, allocated) VALUES ($1, $2, $3, $4, $5, $6)`,
        [SKU, locationId, lot, stockClass, onHand, allocated],
      );
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

    emp1Id = await provisionUser(port, `emp1-115-${run}@example.com`, [employeeAt(siteA)]);
    emp1 = await authFor(port, `emp1-115-${run}@example.com`);
    await provisionUser(port, `emp2-115-${run}@example.com`, [employeeAt(siteA)]);
    emp2 = await authFor(port, `emp2-115-${run}@example.com`);
    await provisionUser(port, `nosite-115-${run}@example.com`, [employeeAt(siteB)]);
    nosite = await authFor(port, `nosite-115-${run}@example.com`);
    await provisionUser(port, `po1-115-${run}@example.com`, [
      {
        role: 'procurement_officer',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
      {
        role: 'procurement_officer',
        module: 'inventory',
        functionScope: 'read',
        locationId: siteA,
      },
      // Code review 2026-09-27: every real pilot person holds the base hat too (this same diff
      // adds it to all 20 humans in the pilot pack), so po1 must carry it here as well, or this
      // regression case never actually exercises the specialist-vs-base-hat tie-break.
      employeeAt(siteA),
    ]);
    po1 = await authFor(port, `po1-115-${run}@example.com`);
    await provisionUser(port, `gate-115-${run}@example.com`, [
      { role: 'gate_officer', module: 'inventory', functionScope: 'write', locationId: siteA },
      employeeAt(siteA),
    ]);
    gateEmp = await authFor(port, `gate-115-${run}@example.com`);
    await provisionUser(port, `approver-115-${run}@example.com`, [
      {
        role: 'department_head_115',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);

    await provisionUser(port, `doa-115-${run}@example.com`, [
      {
        role: 'compliance_admin_115',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'indent_approval',
        role: 'department_head_115',
        value_min: 5000,
        value_max: null,
      },
      await authFor(port, `doa-115-${run}@example.com`),
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));

    const seeded = await makeRequest(port, 'POST', '/api/v1/indents', raiseBody(SKU), emp2);
    assert.strictEqual(seeded.status, 201, JSON.stringify(seeded.body));
    emp2IndentId = (seeded.body['indent'] as Record<string, string>)['indent_id']!;
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 1: raise ------------------------------------------------------------

  it('AC1: an employee-only user raises a requisition; the actor is stamped from the employee assignment', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/indents', raiseBody(SKU, 1000), emp1);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const indent = res.body['indent'] as Record<string, unknown>;
    assert.strictEqual(indent['requester_user_id'], emp1Id);
    assert.strictEqual(indent['site_id'], siteA);
    // 10 x 1000 crosses the 5000 band: routed for approval.
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    const details = res.body['details'] as Record<string, unknown>;
    assert.strictEqual(typeof details['approver_actor_id'], 'string');

    const ev = await getPool().query(
      `SELECT metadata FROM domain_events WHERE event_id = $1 AND event_type = 'indent.raised'`,
      [res.body['event_id']],
    );
    assert.strictEqual(ev.rows.length, 1);
    const actor = (ev.rows[0]!['metadata'] as Record<string, Record<string, string>>)['actor']!;
    assert.strictEqual(actor['role'], 'employee');
    assert.strictEqual(actor['location_id'], siteA);
    assert.strictEqual(actor['user_id'], emp1Id);
  });

  it('AC1: an employee assigned at another site cannot raise at this site', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/indents', raiseBody(SKU), nosite);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('AC1 (D3): the base role is raise-only; every other indent action stays procurement write', async () => {
    const raised = await makeRequest(port, 'POST', '/api/v1/indents', raiseBody(SKU), emp1);
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const id = (raised.body['indent'] as Record<string, string>)['indent_id']!;
    for (const action of ['confirm', 'withdraw', 'approve', 'reject', 'cancel']) {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/indents/${id}/${action}`,
        { rejection_reason: 'no', cancelled_reason: 'no' },
        emp1,
      );
      assert.strictEqual(res.status, 403, `${action}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED', action);
    }
  });

  it('AC1 regression: a procurement officer still raises, stamped with their own role', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/indents', raiseBody(SKU), po1);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const ev = await getPool().query(`SELECT metadata FROM domain_events WHERE event_id = $1`, [
      res.body['event_id'],
    ]);
    const actor = (ev.rows[0]!['metadata'] as Record<string, Record<string, string>>)['actor']!;
    assert.strictEqual(actor['role'], 'procurement_officer');
  });

  // --- AC 4: my requests ------------------------------------------------------

  it("AC4: mine=true lists only the caller's own requisitions", async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/indents?mine=true', undefined, emp1);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const indents = res.body['indents'] as Record<string, unknown>[];
    assert.ok(indents.length >= 2, JSON.stringify(indents));
    for (const i of indents) assert.strictEqual(i['requester_user_id'], emp1Id);
    assert.ok(!indents.some((i) => i['indent_id'] === emp2IndentId));
  });

  it('AC4 (D6): a base-role caller listing without mine=true is refused, never silently narrowed', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/indents', undefined, emp1);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual(
      res.body['message'],
      'Base role lists own requisitions only; pass mine=true',
    );
  });

  it("AC4: a base-role caller reads their own indent but not another employee's", async () => {
    const mine = await makeRequest(port, 'GET', '/api/v1/indents?mine=true', undefined, emp1);
    const ownId = (mine.body['indents'] as Record<string, string>[])[0]!['indent_id'];
    const own = await makeRequest(port, 'GET', `/api/v1/indents/${ownId}`, undefined, emp1);
    assert.strictEqual(own.status, 200, JSON.stringify(own.body));
    assert.strictEqual((own.body['indent'] as Record<string, string>)['indent_id'], ownId);

    const other = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${emp2IndentId}`,
      undefined,
      emp1,
    );
    assert.strictEqual(other.status, 403, JSON.stringify(other.body));
    assert.strictEqual(other.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('AC4 regression: a procurement reader still lists the site without mine=true', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/indents', undefined, po1);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const ids = (res.body['indents'] as Record<string, string>[]).map((i) => i['indent_id']);
    assert.ok(ids.includes(emp2IndentId));
    const other = await makeRequest(port, 'GET', `/api/v1/indents/${emp2IndentId}`, undefined, po1);
    assert.strictEqual(other.status, 200, JSON.stringify(other.body));
  });

  // --- AC 2: availability -----------------------------------------------------

  it('AC2: availability answers in-stock state per visible location with no numbers', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/stock/${SKU}/availability`,
      undefined,
      emp1,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['in_stock', 'locations', 'sku', 'uom']);
    assert.deepStrictEqual(numericPaths(res.body), []);
    assert.strictEqual(res.body['sku'], SKU);
    assert.strictEqual(res.body['uom'], 'EA');
    assert.strictEqual(res.body['in_stock'], true);
    assert.deepStrictEqual(res.body['locations'], [
      { location_id: binFree, location_code: `S115A-BIN-1-${run}`, in_stock: true },
      { location_id: binJobWork, location_code: `S115A-BIN-2-${run}`, in_stock: false },
      { location_id: binAllocated, location_code: `S115A-BIN-3-${run}`, in_stock: false },
      { location_id: binHeld, location_code: `S115A-BIN-4-${run}`, in_stock: false },
      { location_id: binQuarantine, location_code: `S115A-BIN-5-${run}`, in_stock: false },
    ]);
  });

  it('AC2: quantities stay gated by inventory read', async () => {
    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU}`, undefined, emp1);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('AC2: unknown SKU answers 404 ITEM_NOT_FOUND; a malformed SKU answers 400', async () => {
    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/stock/NOPE-${run}/availability`,
      undefined,
      emp1,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'ITEM_NOT_FOUND');
    const bad = await makeRequest(
      port,
      'GET',
      '/api/v1/stock/%24bad/availability',
      undefined,
      emp1,
    );
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.strictEqual(bad.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC2: an inventory reader gets the same shape; a caller with neither module is refused', async () => {
    const res = await makeRequest(port, 'GET', `/api/v1/stock/${SKU}/availability`, undefined, po1);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['in_stock', 'locations', 'sku', 'uom']);
    assert.deepStrictEqual(numericPaths(res.body), []);
    assert.strictEqual((res.body['locations'] as unknown[]).length, 5);

    await provisionUser(port, `nomod-115-${run}@example.com`, [
      { role: 'auditor_115', module: 'audit', functionScope: 'read', locationId: siteA },
    ]);
    const denied = await makeRequest(
      port,
      'GET',
      `/api/v1/stock/${SKU}/availability`,
      undefined,
      await authFor(port, `nomod-115-${run}@example.com`),
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('AC2: an employee at site B sees only site B locations', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/stock/${SKU}/availability`,
      undefined,
      nosite,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body['locations'], [
      { location_id: binSiteB, location_code: `S115B-BIN-1-${run}`, in_stock: true },
    ]);
  });

  // --- AC 5: bootstrap navigation ---------------------------------------------

  it('AC5: an employee-only user gets the three base entries and no refused-captures screen', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, emp1);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body['navigation'], [
      'Dashboard',
      'Frontline',
      'New requisition',
      'Check stock',
      'My requests',
      // Story 8.9: every base-hat holder reports damage; none of these callers works cases.
      'Report damage',
    ]);
    assert.strictEqual(res.body['role'], 'employee');
  });

  it('AC5: a procurement and inventory holder gets every entry in table order', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, po1);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body['navigation'], [
      'Dashboard',
      'Frontline',
      'Refused captures',
      'New requisition',
      'Check stock',
      'My requests',
      // Story 8.9: every base-hat holder reports damage; none of these callers works cases.
      'Report damage',
    ]);
  });

  it('AC5: the base hat never displaces a specialist role as the operating role', async () => {
    const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, gateEmp);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['role'], 'gate_officer');
    assert.deepStrictEqual(res.body['navigation'], [
      'Dashboard',
      'Frontline',
      'Refused captures',
      'New requisition',
      'Check stock',
      'My requests',
      // Story 8.9: every base-hat holder reports damage; none of these callers works cases.
      'Report damage',
    ]);
  });

  // --- Edge sweep -------------------------------------------------------------

  function edgeEnvelope(eventType: string, payload: Record<string, unknown>) {
    const eventId = randomUUID();
    return {
      event_id: eventId,
      stream_type: 'procurement',
      stream_id: (payload['indent_id'] as string) ?? randomUUID(),
      event_type: eventType,
      payload,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: emp1Id, role: 'employee', location_id: siteA },
        device_id: `EDGE-TAB-115-${run}`,
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: `edge-115-${eventId}`,
    };
  }

  it('edge: an employee-only user syncs an offline indent.raised', async () => {
    const indentId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope('indent.raised', {
        indent_id: indentId,
        requester_user_id: emp1Id,
        department_code: 'MAINT',
        site_id: siteA,
        business_stream: 'production',
        need_by_date: '2026-10-15',
        urgent: false,
        lines: [
          {
            sku: `SKU-115-EDGE-${run}`,
            item_category: 'consumables',
            requested_qty: 1,
            uom: 'EA',
            unit_price_estimate: 10,
          },
        ],
      }),
      emp1,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await getPool().query(
      'SELECT requester_user_id, site_id FROM indent WHERE indent_id = $1',
      [indentId],
    );
    assert.strictEqual(row.rows[0]?.['requester_user_id'], emp1Id);
    const ev = await getPool().query(
      `SELECT metadata FROM domain_events WHERE stream_id = $1 AND event_type = 'indent.raised'`,
      [indentId],
    );
    const actor = (ev.rows[0]!['metadata'] as Record<string, Record<string, string>>)['actor']!;
    assert.strictEqual(actor['role'], 'employee');
  });

  it('edge: employee write does not unlock any other procurement event', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope('indent.approved', {
        indent_id: emp2IndentId,
        approver_actor_id: emp1Id,
        site_id: siteA,
      }),
      emp1,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('edge: an employee at another site cannot sync an indent.raised for this site', async () => {
    const indentId = randomUUID();
    const envelope = edgeEnvelope('indent.raised', {
      indent_id: indentId,
      department_code: 'MAINT',
      site_id: siteA,
      business_stream: 'production',
      need_by_date: '2026-10-15',
      urgent: false,
      lines: [
        {
          sku: SKU,
          item_category: 'consumables',
          requested_qty: 1,
          uom: 'EA',
          unit_price_estimate: 1,
        },
      ],
    });
    envelope.metadata.actor.location_id = siteB;
    const res = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, nosite);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });
});

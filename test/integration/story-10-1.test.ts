import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { assertRdIssueGuards } from '../../src/compliance/rd-guards.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 10.1: R&D location types, lot ring-fence and project master. Runs against the production router
// (createAppRouter) with real auth, RBAC, the nested stock.issued ledger path and PostgreSQL.
// Roles and bands are suffixed per run (the story-4-10 pattern) so seeds never collide.

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
type Row = Record<string, unknown>;

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
        host: '127.0.0.1',
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
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (raw += chunk));
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { raw };
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
  assert.strictEqual(res.status, 201, `provision ${externalId}: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status < 300, `dev-token ${sub}: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 10.1 R&D and maker-hub location types and project master', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const rdBin = randomUUID();
  const hubBin = randomUUID();
  const stdBin = randomUUID();
  const SKU = `RD-101-${run}`;
  const SKU_LOT = `RDL-101-${run}`;
  const LOT_RD = `LOT-101-RD-${run}`;
  const LOT_FREE = `LOT-101-FREE-${run}`;
  const PROJ = `PRJ-${run}`.toUpperCase();
  const PROJ_CLOSED = `PRJC-${run}`.toUpperCase();
  let requesterHeaders: Record<string, string>;
  let deptHeadHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let engHeaders: Record<string, string>;
  let storeId: string;
  let ownerId: string;
  let otherId: string;

  async function raiseApproved(
    stream: string,
    sku: string,
  ): Promise<{ id: string; lineId: string }> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      {
        department_code: 'MAINT',
        site_id: siteA,
        business_stream: stream,
        need_by_date: '2026-12-01',
        urgent: false,
        reason: 'R&D issue',
        confirm_duplicate: true,
        lines: [
          {
            sku,
            item_category: 'consumable',
            requested_qty: 50,
            uom: 'EA',
            unit_price_estimate: 1,
          },
        ],
      },
      requesterHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const id = (res.body['indent'] as Row)['indent_id'] as string;
    const lineId = (res.body['lines'] as Row[])[0]!['indent_line_id'] as string;
    const ap = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    return { id, lineId };
  }

  async function receive(sku: string, binId: string, quantity: number, extra: Row = {}) {
    await persistEvent({
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.received',
      payload: {
        business_stream: 'production',
        sku,
        target_location_id: binId,
        quantity,
        unit_cost: 2,
        ...extra,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: storeId, role: 'store_assistant', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    });
  }

  function issue(
    indentId: string,
    lineId: string,
    binId: string,
    extra: Row = {},
    body: Row = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/issue`,
      { lines: [{ indent_line_id: lineId, quantity: '1', location_id: binId, ...extra }], ...body },
      storeHeaders,
    );
  }

  before(async () => {
    const adminPool = getAdminPool();
    // Orphans from a prior run would fail the idempotent lot_id foreign key below.
    await adminPool.query(
      `DO $$ BEGIN IF to_regclass('rd_reclassification') IS NOT NULL THEN TRUNCATE rd_reclassification; END IF; END $$`,
    );
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
      '../../read/projections/rd_project.sql',
      '../../read/projections/rd_reclassification.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
      '../../read/projections/indent_info_request.sql',
      '../../read/projections/indent_issue.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE rd_reclassification, rd_project, indent_issue_line, indent_issue, indent_info_request, indent_line, indent, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    const pool = getPool();
    await pool.query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'site', NULL, $1, 'general', 'ambient', 'active')`,
      [siteA, `SITE-101-${run}`],
    );
    for (const [id, code, type] of [
      [rdBin, `RDB-${run}`, 'rd_store'],
      [hubBin, `HUB-${run}`, 'maker_hub_store'],
      [stdBin, `STD-${run}`, 'standard'],
    ] as const) {
      await pool.query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status, location_type)
         VALUES ($1, $2, 'bin', $3, $3, 'general', 'ambient', 'active', $4)`,
        [id, code, siteA, type],
      );
    }
    for (const [sku, lot] of [
      [SKU, false],
      [SKU_LOT, true],
    ] as const) {
      await pool.query(
        `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
         VALUES ($1, 'EA', $2, false, 'fifo', 'production', 'active')`,
        [sku, lot],
      );
    }

    const write = (role: string, module: string, locationId = '*'): Role => ({
      role,
      module,
      functionScope: 'write',
      locationId,
    });
    await provisionUser(port, `req-101-${run}@example.com`, [
      write('floor_supervisor', 'procurement', siteA),
    ]);
    requesterHeaders = await authFor(port, `req-101-${run}@example.com`);
    await provisionUser(port, `dh-101-${run}@example.com`, [
      write(`department_head_101_${run}`, 'procurement'),
    ]);
    deptHeadHeaders = await authFor(port, `dh-101-${run}@example.com`);
    storeId = await provisionUser(port, `store-101-${run}@example.com`, [
      write('store_assistant', 'warehouse', siteA),
    ]);
    storeHeaders = await authFor(port, `store-101-${run}@example.com`);
    ownerId = await provisionUser(port, `eng-101-${run}@example.com`, [
      write('engineer_101', 'engineering'),
    ]);
    engHeaders = await authFor(port, `eng-101-${run}@example.com`);
    otherId = randomUUID();
    await provisionUser(port, `doa-101-${run}@example.com`, [
      write('compliance_admin_101', 'compliance'),
    ]);
    const doaHeaders = await authFor(port, `doa-101-${run}@example.com`);
    const band = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'indent_approval',
        role: `department_head_101_${run}`,
        value_min: null,
        value_max: null,
      },
      doaHeaders,
    );
    assert.strictEqual(band.status, 201, JSON.stringify(band.body));

    await receive(SKU, rdBin, 100);
    await receive(SKU, stdBin, 100);
    await receive(SKU_LOT, stdBin, 100, { lot_id: LOT_RD });
    await receive(SKU_LOT, stdBin, 100, { lot_id: LOT_FREE });
    await pool.query(`UPDATE lot_master SET rd_designated = true WHERE lot_number = $1`, [LOT_RD]);
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePool();
    await closeAdminPool();
  });

  function createProject(body: Row): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/rd-projects', body, engHeaders);
  }

  async function bal(sku: string, loc: string): Promise<number[]> {
    const r = await getPool().query(
      `SELECT on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2`,
      [sku, loc],
    );
    return r.rows.map((x) => Number(x['on_hand']));
  }

  it('R&D and maker-hub receipts land only in the receiving location', async () => {
    assert.deepStrictEqual(await bal(SKU, rdBin), [100]);
    assert.deepStrictEqual(await bal(SKU, hubBin), []);
    await receive(SKU, hubBin, 7);
    assert.deepStrictEqual(await bal(SKU, hubBin), [7]);
    assert.deepStrictEqual(await bal(SKU, rdBin), [100]);
    const types = await getPool().query(
      `SELECT location_type FROM location_register WHERE location_id IN ($1, $2) ORDER BY 1`,
      [rdBin, hubBin],
    );
    assert.deepStrictEqual(
      types.rows.map((r) => r['location_type']),
      ['maker_hub_store', 'rd_store'],
    );
    await assert.rejects(
      getPool().query(
        `UPDATE location_register SET location_type = 'bogus' WHERE location_id = $1`,
        [stdBin],
      ),
    );
  });

  it('project create: 201 with record; bad phase or negative budget 400; duplicate 409', async () => {
    const base = { owner_user_id: ownerId, phase: 'research', budget_amount: 1000 };
    const ok = await createProject({ project_code: PROJ, ...base });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body['project_code'], PROJ);
    assert.strictEqual(ok.body['owner_user_id'], ownerId);
    assert.strictEqual(ok.body['phase'], 'research');
    assert.strictEqual(ok.body['status'], 'active');
    assert.strictEqual(Number(ok.body['budget_amount']), 1000);
    const badPhase = await createProject({
      ...base,
      project_code: `X-${run}`,
      phase: 'production',
    });
    assert.strictEqual(badPhase.status, 400);
    const negative = await createProject({ ...base, project_code: `Y-${run}`, budget_amount: -1 });
    assert.strictEqual(negative.status, 400);
    const dup = await createProject({ project_code: PROJ, ...base });
    assert.strictEqual(dup.status, 409);
    const closed = await createProject({ ...base, project_code: PROJ_CLOSED, status: 'closed' });
    assert.strictEqual(closed.status, 201);
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/rd-projects/${PROJ}`,
      undefined,
      engHeaders,
    );
    assert.strictEqual(got.status, 200);
    const list = await makeRequest(port, 'GET', '/api/v1/rd-projects', undefined, engHeaders);
    assert.ok((list.body['projects'] as Row[]).length >= 2);
    const missing = await makeRequest(
      port,
      'GET',
      '/api/v1/rd-projects/NOPE',
      undefined,
      engHeaders,
    );
    assert.strictEqual(missing.status, 404);
  });

  it('CROSS_ISSUE_BLOCKED: rd_designated lot or rd_store source to non-R&D demand is rejected', async () => {
    const a = await raiseApproved('production', SKU_LOT);
    const lot = await issue(a.id, a.lineId, stdBin, { lot_id: LOT_RD });
    assert.strictEqual(lot.status, 409, JSON.stringify(lot.body));
    assert.strictEqual(lot.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    const b = await raiseApproved('production', SKU);
    const loc = await issue(b.id, b.lineId, rdBin);
    assert.strictEqual(loc.status, 409, JSON.stringify(loc.body));
    assert.strictEqual(loc.body['error_code'], 'CROSS_ISSUE_BLOCKED');
  });

  it('non-R&D stock to non-R&D demand is unchanged', async () => {
    const a = await raiseApproved('production', SKU);
    const res = await issue(a.id, a.lineId, stdBin);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  it('approved reclassification by a different approver lifts the block; self-approval is refused', async () => {
    const lotRow = await getPool().query(`SELECT lot_id FROM lot_master WHERE lot_number = $1`, [
      LOT_RD,
    ]);
    const lotId = lotRow.rows[0]!['lot_id'] as string;
    await assert.rejects(
      getPool().query(
        `INSERT INTO rd_reclassification (lot_id, requested_by, approved_by, status) VALUES ($1, $2, $2, 'approved')`,
        [lotId, ownerId],
      ),
    );
    const pending = await getPool().query(
      `INSERT INTO rd_reclassification (lot_id, requested_by, status) VALUES ($1, $2, 'pending') RETURNING reclassification_id`,
      [lotId, ownerId],
    );
    const a = await raiseApproved('production', SKU_LOT);
    const still = await issue(a.id, a.lineId, stdBin, { lot_id: LOT_RD });
    assert.strictEqual(still.body['error_code'], 'CROSS_ISSUE_BLOCKED');
    await getPool().query(
      `UPDATE rd_reclassification SET status = 'approved', approved_by = $2 WHERE reclassification_id = $1`,
      [pending.rows[0]!['reclassification_id'], otherId],
    );
    const ok = await issue(a.id, a.lineId, stdBin, { lot_id: LOT_RD });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  });

  it('PROJECT_CODE_REQUIRED: R&D demand with no, unknown or closed project code is rejected', async () => {
    const a = await raiseApproved('research', SKU);
    const none = await issue(a.id, a.lineId, stdBin);
    assert.strictEqual(none.status, 409, JSON.stringify(none.body));
    assert.strictEqual(none.body['error_code'], 'PROJECT_CODE_REQUIRED');
    const unknown = await issue(a.id, a.lineId, stdBin, {}, { project_code: `NOPE-${run}` });
    assert.strictEqual(unknown.body['error_code'], 'PROJECT_CODE_REQUIRED');
    const closed = await issue(a.id, a.lineId, stdBin, {}, { project_code: PROJ_CLOSED });
    assert.strictEqual(closed.body['error_code'], 'PROJECT_CODE_REQUIRED');
    const ok = await issue(a.id, a.lineId, rdBin, {}, { project_code: PROJ });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  });

  it('fails closed: unknown lot and missing location throw', async () => {
    const client = await getPool().connect();
    try {
      await assert.rejects(
        assertRdIssueGuards(
          client,
          { location_id: stdBin, lot_id: `NO-SUCH-LOT-${run}`, sku: SKU_LOT },
          'production',
          null,
        ),
        { errorCode: 'LOT_NOT_FOUND' },
      );
      await assert.rejects(
        assertRdIssueGuards(
          client,
          { location_id: randomUUID(), lot_id: null, sku: SKU },
          'production',
          null,
        ),
        { errorCode: 'LOCATION_NOT_FOUND' },
      );
    } finally {
      client.release();
    }
  });

  it('project create rejects bad budget (too many decimals, huge) and bad code', async () => {
    const base = { owner_user_id: ownerId, phase: 'research' };
    const dec = await createProject({ ...base, project_code: `D-${run}`, budget_amount: 1.234 });
    assert.strictEqual(dec.status, 400);
    const huge = await createProject({ ...base, project_code: `H-${run}`, budget_amount: 1e16 });
    assert.strictEqual(huge.status, 400);
    const badCode = await createProject({ ...base, project_code: 'a b!', budget_amount: 1 });
    assert.strictEqual(badCode.status, 400);
  });

  it('issue rejects a non-string project_code with 400', async () => {
    const a = await raiseApproved('research', SKU);
    const res = await issue(a.id, a.lineId, rdBin, {}, { project_code: 123 });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });
});

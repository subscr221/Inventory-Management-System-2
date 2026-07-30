import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';

/**
 * Story 3.9: Forward-Pick Replenishment (FR-W-08).
 *
 * Mirrors the Story 3.8 harness (SCIM provisioning + dev-token auth, run-scoped identifiers) - the
 * most recently confirmed-executing warehouse integration suite at this story's baseline.
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

describe('Story 3.9 Forward-Pick Replenishment', () => {
  let server: Server;
  let port: number;

  let managerHeaders: Record<string, string>;
  let frontlineHeaders: Record<string, string>;
  let otherSiteHeaders: Record<string, string>;

  const run = randomUUID().slice(0, 8);
  const siteAId = randomUUID();
  const siteBId = randomUUID();
  const siteACode = `S39A-${run}`;
  const siteBCode = `S39B-${run}`;
  const fpZoneId = randomUUID();
  const reserveZoneId = randomUUID();
  const generalZoneId = randomUUID();
  const reserveBinId = randomUUID();
  const fpBinId = randomUUID();
  const outsideBinId = randomUUID();
  const sku = `SKU-39-${run}`;

  async function seedLocation(locationId: string, code: string, level: string, parentId: string | null, siteId: string, zoneType = 'general'): Promise<void> {
    await getPool().query(
      `INSERT INTO location_register
         (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
          size_class, hazmat_allowed, quarantine, access_restricted, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ambient', 'standard', false, false, false, 'active')`,
      [locationId, code, level, parentId, siteId, zoneType],
    );
  }

  async function setConfig(minQty: number, maxQty: number, headers = managerHeaders, zoneId = fpZoneId): Promise<HttpResult> {
    return makeRequest(port, 'PUT', '/api/v1/replenishment/config', { sku, zone_id: zoneId, min_qty: minQty, max_qty: maxQty }, headers);
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
    await seedLocation(siteBId, siteBCode, 'site', null, siteBId);
    await seedLocation(fpZoneId, `FP39-${run}`, 'zone', siteAId, siteAId, 'forward_pick');
    await seedLocation(reserveZoneId, `RES39-${run}`, 'zone', siteAId, siteAId, 'reserve');
    await seedLocation(generalZoneId, `GEN39-${run}`, 'zone', siteAId, siteAId, 'general');
    await seedLocation(reserveBinId, `RESBIN39-${run}`, 'bin', reserveZoneId, siteAId, 'reserve');
    await seedLocation(fpBinId, `FPBIN39-${run}`, 'bin', fpZoneId, siteAId, 'forward_pick');
    await seedLocation(outsideBinId, `OUTBIN39-${run}`, 'bin', generalZoneId, siteAId, 'general');

    await provisionUser(port, `r39-manager-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    managerHeaders = await authFor(port, `r39-manager-${run}@example.com`);

    await provisionUser(port, `r39-frontline-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    frontlineHeaders = await authFor(port, `r39-frontline-${run}@example.com`);

    await provisionUser(port, `r39-otherSite-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: siteBId },
    ]);
    otherSiteHeaders = await authFor(port, `r39-otherSite-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
  });

  // -------------------------------------------------------------------------
  // Config write and its guardrails
  // -------------------------------------------------------------------------

  it('config: a supervisor sets a forward-pick threshold; site_id resolves from the zone', async () => {
    const res = await setConfig(10, 50);
    assert.strictEqual(res.status, 200, res.raw);
    const config = res.body['forward_pick_config'] as Record<string, unknown>;
    assert.strictEqual(config['sku'], sku);
    assert.strictEqual(config['zone_id'], fpZoneId);
    assert.strictEqual(config['site_id'], siteAId);
    assert.strictEqual(config['min_qty'], '10.000');
    assert.strictEqual(config['max_qty'], '50.000');
  });

  it('config: a non-forward-pick zone is rejected with FORWARD_PICK_ZONE_INVALID', async () => {
    const res = await setConfig(10, 50, managerHeaders, generalZoneId);
    assert.strictEqual(res.status, 400, res.raw);
    assert.strictEqual(res.body['error_code'], 'FORWARD_PICK_ZONE_INVALID');
  });

  it('config: a frontline role is rejected', async () => {
    const res = await setConfig(10, 50, frontlineHeaders);
    assert.strictEqual(res.status, 403, res.raw);
  });

  it('config: an out-of-scope site is rejected', async () => {
    const res = await setConfig(10, 50, otherSiteHeaders);
    assert.strictEqual(res.status, 403, res.raw);
  });

  // -------------------------------------------------------------------------
  // AC1: min/max breach
  // -------------------------------------------------------------------------

  it('AC1: a balance below the configured minimum raises a min_max task topping up to the maximum; a re-run does not stack a second one', async () => {
    const localSku = `SKU-39-AC1-${run}`;
    await makeRequest(port, 'PUT', '/api/v1/replenishment/config', { sku: localSku, zone_id: fpZoneId, min_qty: 10, max_qty: 50 }, managerHeaders);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 4)`, [localSku, fpBinId]);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 100)`, [localSku, reserveBinId]);

    const first = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId, sku: localSku }, managerHeaders);
    assert.strictEqual(first.status, 200, first.raw);
    const createdFirst = first.body['created'] as Array<Record<string, unknown>>;
    assert.strictEqual(createdFirst.length, 1, first.raw);
    assert.strictEqual(createdFirst[0]!['signal_type'], 'min_max');
    assert.strictEqual(createdFirst[0]!['quantity'], '46.000000');

    const board = await makeRequest(port, 'GET', `/api/v1/warehouse-tasks?site_id=${siteAId}&task_type=replenishment`, undefined, managerHeaders);
    assert.strictEqual(board.status, 200, board.raw);
    const boardTasks = board.body['tasks'] as Array<Record<string, unknown>>;
    assert.ok(boardTasks.some((t) => t['task_id'] === createdFirst[0]!['replenishment_task_id']), 'the created task must appear on the unified task board');

    const second = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId, sku: localSku }, managerHeaders);
    assert.strictEqual(second.status, 200, second.raw);
    assert.strictEqual((second.body['created'] as unknown[]).length, 0, 'a re-run with no balance change must not stack a second open task');
  });

  // -------------------------------------------------------------------------
  // AC2: demand signal ahead of the min/max cycle
  // -------------------------------------------------------------------------

  it('AC2: open pick demand exceeding the forward-pick balance raises a demand_signal task even though the minimum has not been breached', async () => {
    const localSku = `SKU-39-AC2-${run}`;
    await makeRequest(port, 'PUT', '/api/v1/replenishment/config', { sku: localSku, zone_id: fpZoneId, min_qty: 5, max_qty: 50 }, managerHeaders);
    // Balance (20) is above the configured minimum (5), so no min/max breach - but open demand
    // (30) exceeds it, which must still raise a demand_signal task per AC2.
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 20)`, [localSku, fpBinId]);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 100)`, [localSku, reserveBinId]);
    await getPool().query(
      `INSERT INTO erp_sales_order (so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, status, source_system, last_synced_at)
       VALUES ($1, 1, $2, 30, $3, $4, 'open', 'ERP', now())`,
      [`SO39-${run}`, localSku, siteAId, siteACode],
    );

    const res = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId, sku: localSku }, managerHeaders);
    assert.strictEqual(res.status, 200, res.raw);
    const created = res.body['created'] as Array<Record<string, unknown>>;
    assert.strictEqual(created.length, 1, res.raw);
    assert.strictEqual(created[0]!['signal_type'], 'demand_signal');
    assert.strictEqual(created[0]!['quantity'], '10.000000');
  });

  // -------------------------------------------------------------------------
  // AC3: confirmation moves stock and preserves correlation_id
  // -------------------------------------------------------------------------

  it('AC3: confirming a task moves the exact quantity between reserve and forward-pick, and the correlation_id is preserved end to end', async () => {
    const localSku = `SKU-39-AC3-${run}`;
    await makeRequest(port, 'PUT', '/api/v1/replenishment/config', { sku: localSku, zone_id: fpZoneId, min_qty: 10, max_qty: 30 }, managerHeaders);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 0)`, [localSku, fpBinId]);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 200)`, [localSku, reserveBinId]);

    const checkRes = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId, sku: localSku }, managerHeaders);
    assert.strictEqual(checkRes.status, 200, checkRes.raw);
    const created = checkRes.body['created'] as Array<Record<string, unknown>>;
    assert.strictEqual(created.length, 1, checkRes.raw);
    const taskId = created[0]!['replenishment_task_id'] as string;
    assert.strictEqual(created[0]!['quantity'], '30.000000');

    const confirmRes = await makeRequest(port, 'POST', `/api/v1/replenishment-tasks/${taskId}/confirm`, { to_location_id: fpBinId }, frontlineHeaders);
    assert.strictEqual(confirmRes.status, 200, confirmRes.raw);
    const task = confirmRes.body['task'] as Record<string, unknown>;
    assert.strictEqual(task['status'], 'completed');
    assert.strictEqual(task['to_location_id'], fpBinId);
    const correlationId = task['correlation_id'] as string;
    assert.ok(correlationId, 'the completed task must carry a correlation_id');

    const reserveBalance = await getPool().query(
      `SELECT on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'`,
      [localSku, reserveBinId],
    );
    const fpBalance = await getPool().query(
      `SELECT on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'`,
      [localSku, fpBinId],
    );
    assert.strictEqual(reserveBalance.rows[0]!['on_hand'], '170.000000');
    assert.strictEqual(fpBalance.rows[0]!['on_hand'], '30.000000');

    // Idempotent replay: confirming an already-completed task is a no-op, not a double move.
    const secondConfirm = await makeRequest(port, 'POST', `/api/v1/replenishment-tasks/${taskId}/confirm`, { to_location_id: fpBinId }, frontlineHeaders);
    assert.strictEqual(secondConfirm.status, 200, secondConfirm.raw);
    const reserveAfterReplay = await getPool().query(
      `SELECT on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'`,
      [localSku, reserveBinId],
    );
    assert.strictEqual(reserveAfterReplay.rows[0]!['on_hand'], '170.000000', 'a replayed confirmation must not move stock a second time');
  });

  it('AC3: confirming to a destination outside the task zone is rejected with REPLENISHMENT_DESTINATION_OUTSIDE_ZONE', async () => {
    const localSku = `SKU-39-AC3B-${run}`;
    await makeRequest(port, 'PUT', '/api/v1/replenishment/config', { sku: localSku, zone_id: fpZoneId, min_qty: 10, max_qty: 30 }, managerHeaders);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 0)`, [localSku, fpBinId]);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 200)`, [localSku, reserveBinId]);
    const checkRes = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId, sku: localSku }, managerHeaders);
    const taskId = (checkRes.body['created'] as Array<Record<string, unknown>>)[0]!['replenishment_task_id'] as string;

    const res = await makeRequest(port, 'POST', `/api/v1/replenishment-tasks/${taskId}/confirm`, { to_location_id: outsideBinId }, frontlineHeaders);
    assert.strictEqual(res.status, 409, res.raw);
    assert.strictEqual(res.body['error_code'], 'REPLENISHMENT_DESTINATION_OUTSIDE_ZONE');
  });

  // -------------------------------------------------------------------------
  // RBAC and site scoping
  // -------------------------------------------------------------------------

  it('check: a frontline role is rejected', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId }, frontlineHeaders);
    assert.strictEqual(res.status, 403, res.raw);
  });

  it('check: an out-of-scope site is rejected with LOCATION_ACCESS_DENIED', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId }, otherSiteHeaders);
    assert.strictEqual(res.status, 403, res.raw);
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  // -------------------------------------------------------------------------
  // Task 6.5: assignment
  // -------------------------------------------------------------------------

  it('assign: a supervisor assigns a ready replenishment task to an operator', async () => {
    const localSku = `SKU-39-ASSIGN-${run}`;
    const operatorId = await provisionUser(port, `r39-assignee-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId: siteAId },
    ]);
    await makeRequest(port, 'PUT', '/api/v1/replenishment/config', { sku: localSku, zone_id: fpZoneId, min_qty: 10, max_qty: 30 }, managerHeaders);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 0)`, [localSku, fpBinId]);
    await getPool().query(`INSERT INTO stock_balance (sku, location_id, stock_class, on_hand) VALUES ($1, $2, 'owned', 200)`, [localSku, reserveBinId]);
    const checkRes = await makeRequest(port, 'POST', '/api/v1/replenishment/check', { site_id: siteAId, sku: localSku }, managerHeaders);
    const taskId = (checkRes.body['created'] as Array<Record<string, unknown>>)[0]!['replenishment_task_id'] as string;

    const assignRes = await makeRequest(port, 'POST', `/api/v1/replenishment-tasks/${taskId}/assign`, { assigned_to: operatorId }, managerHeaders);
    assert.strictEqual(assignRes.status, 200, assignRes.raw);
    const task = assignRes.body['task'] as Record<string, unknown>;
    assert.strictEqual(task['assigned_to'], operatorId);

    const frontlineAssignAttempt = await makeRequest(port, 'POST', `/api/v1/replenishment-tasks/${taskId}/assign`, { assigned_to: operatorId }, frontlineHeaders);
    assert.strictEqual(frontlineAssignAttempt.status, 403, frontlineAssignAttempt.raw);
  });
});

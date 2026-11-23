import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 10.2: R&D requisition, budget check and issue types. Runs against the production router
// (createAppRouter) with real auth, RBAC and PostgreSQL. Roles and bands are suffixed per run so
// seeds never collide.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

const SIX_CRITERIA = {
  technical_feasibility: true,
  intention_to_complete: true,
  ability_to_use_or_sell: true,
  future_economic_benefits: true,
  resources_available: true,
  expenditure_measurable: true,
};

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

describe('Story 10.2 R&D requisition, budget check and issue types', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const rdBin = randomUUID();
  const stdBin = randomUUID();
  const SKU = `RD-102-${run}`;
  let requesterHeaders: Record<string, string>;
  let ownerHeaders: Record<string, string>;
  let headHeaders: Record<string, string>;
  let strangerHeaders: Record<string, string>;
  let requesterId: string;
  let ownerId: string;
  let headId: string;

  function createProject(body: Row): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/rd-projects', body, ownerHeaders);
  }

  function raise(projectCode: string, lines: Row[], extra: Row = {}): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/rd-requisitions',
      { project_code: projectCode, lines, ...extra },
      requesterHeaders,
    );
  }

  function approve(requisitionId: string, headers: Record<string, string>): Promise<HttpResult> {
    return makeRequest(port, 'POST', `/api/v1/rd-requisitions/${requisitionId}/approve`, {}, headers);
  }

  function reject(
    requisitionId: string,
    headers: Record<string, string>,
    reason: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/rd-requisitions/${requisitionId}/reject`,
      { rejection_reason: reason },
      headers,
    );
  }

  function issue(requisitionId: string, lines: Row[], extra: Row = {}): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/rd-requisitions/${requisitionId}/issue`,
      { lines, ...extra },
      requesterHeaders,
    );
  }

  function setChecklist(projectCode: string, criteria: Row, extra: Row = {}): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/rd-projects/${projectCode}/checklist`,
      { criteria, ...extra },
      ownerHeaders,
    );
  }

  async function line(requisitionId: string, idx = 0): Promise<Row> {
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/rd-requisitions/${requisitionId}`,
      undefined,
      ownerHeaders,
    );
    return (got.body['lines'] as Row[])[idx]!;
  }

  async function onHand(sku: string, loc: string): Promise<number> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::float8 AS q FROM stock_balance WHERE sku = $1 AND location_id = $2`,
      [sku, loc],
    );
    return r.rows[0]!['q'] as number;
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
      '../../read/projections/rd_project.sql',
      '../../read/projections/rd_reclassification.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/asset.sql',
      '../../read/projections/rd_requisition.sql',
      '../../read/projections/rd_requisition_line.sql',
      '../../read/projections/rd_project_checklist.sql',
      '../../read/projections/rd_issue_cost.sql',
      '../../read/projections/rd_equipment_custody.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE rd_equipment_custody, rd_issue_cost, rd_project_checklist, rd_requisition_line, rd_requisition, rd_reclassification, rd_project, lot_trace, serial_master, lot_master, stock_balance, inventory_valuation, asset, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
      [siteA, `SITE-102-${run}`],
    );
    for (const [id, code, type] of [
      [rdBin, `RDB-${run}`, 'rd_store'],
      [stdBin, `STD-${run}`, 'standard'],
    ] as const) {
      await pool.query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status, location_type)
         VALUES ($1, $2, 'bin', $3, $3, 'general', 'ambient', 'active', $4)`,
        [id, code, siteA, type],
      );
    }
    await pool.query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, 'fifo', 'production', 'active')`,
      [SKU],
    );

    const write = (role: string, module: string, locationId = '*'): Role => ({
      role,
      module,
      functionScope: 'write',
      locationId,
    });
    requesterId = await provisionUser(port, `req-102-${run}@example.com`, [
      write(`rd_requester_${run}`, 'engineering'),
    ]);
    requesterHeaders = await authFor(port, `req-102-${run}@example.com`);
    ownerId = await provisionUser(port, `owner-102-${run}@example.com`, [
      write(`rd_owner_${run}`, 'engineering'),
    ]);
    ownerHeaders = await authFor(port, `owner-102-${run}@example.com`);
    headId = await provisionUser(port, `head-102-${run}@example.com`, [
      write(`rd_head_${run}`, 'engineering'),
    ]);
    headHeaders = await authFor(port, `head-102-${run}@example.com`);
    await provisionUser(port, `stranger-102-${run}@example.com`, [
      write(`rd_stranger_${run}`, 'engineering'),
    ]);
    strangerHeaders = await authFor(port, `stranger-102-${run}@example.com`);

    await provisionUser(port, `doa-102-${run}@example.com`, [
      write('compliance_admin_102', 'compliance'),
    ]);
    const doaHeaders = await authFor(port, `doa-102-${run}@example.com`);
    const band = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      { transaction_type: 'rd_budget_breach', role: `rd_head_${run}`, value_min: null, value_max: null },
      doaHeaders,
    );
    assert.strictEqual(band.status, 201, JSON.stringify(band.body));

    await persistEvent({
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.received',
      payload: { business_stream: 'production', sku: SKU, target_location_id: stdBin, quantity: 200, unit_cost: 2 },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: requesterId, role: 'store_assistant', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    });
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePool();
    await closeAdminPool();
  });

  it('raise within budget is approved; lines carry server-computed line_value', async () => {
    const project = `OK-${run}`.toUpperCase();
    const created = await createProject({
      project_code: project,
      owner_user_id: ownerId,
      phase: 'research',
      budget_amount: 1000,
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const res = await raise(project, [
      { sku: SKU, requested_qty: '10', uom: 'EA', unit_cost_estimate: '6', issue_type: 'consumable' },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'approved');
    assert.strictEqual(res.body['budget_breach'], false);
    const lines = res.body['lines'] as Row[];
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(Number(lines[0]!['line_value']), 60);
    assert.strictEqual(Number(lines[0]!['issued_quantity']), 0);
  });

  it('raise breach routes to owner and R&D head with approval_required', async () => {
    const project = `BR-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 100 });
    const res = await raise(project, [
      { sku: SKU, requested_qty: '10', uom: 'EA', unit_cost_estimate: '20', issue_type: 'consumable' },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'approval_required');
    assert.strictEqual(res.body['budget_breach'], true);
    assert.strictEqual(res.body['approver_actor_id'], headId);
    assert.strictEqual(res.body['owner_approver_id'], ownerId);
  });

  it('dual-leg approval: requester and strangers are refused; owner then head approve', async () => {
    const project = `DL-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 10 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '50', issue_type: 'consumable' },
    ]);
    const id = raised.body['requisition_id'] as string;
    assert.strictEqual(raised.body['status'], 'approval_required');

    const self = await approve(id, requesterHeaders);
    assert.strictEqual(self.status, 403, JSON.stringify(self.body));
    assert.strictEqual(self.body['error_code'], 'NOT_RESOLVED_APPROVER');

    const stranger = await approve(id, strangerHeaders);
    assert.strictEqual(stranger.status, 403, JSON.stringify(stranger.body));
    assert.strictEqual(stranger.body['error_code'], 'NOT_RESOLVED_APPROVER');

    const headApprove = await approve(id, headHeaders);
    assert.strictEqual(headApprove.status, 200, JSON.stringify(headApprove.body));
    assert.strictEqual(headApprove.body['status'], 'approval_required');

    const ownerApprove = await approve(id, ownerHeaders);
    assert.strictEqual(ownerApprove.status, 200, JSON.stringify(ownerApprove.body));
    assert.strictEqual(ownerApprove.body['status'], 'approved');
  });

  it('owner can raise and sponsor their own breach requisition; only the head leg remains', async () => {
    const project = `OO-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 10 });
    const raised = await makeRequest(
      port,
      'POST',
      '/api/v1/rd-requisitions',
      {
        project_code: project,
        lines: [
          { sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '50', issue_type: 'consumable' },
        ],
      },
      ownerHeaders,
    );
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    assert.strictEqual(raised.body['status'], 'approval_required');
    // The owner leg is satisfied at raise - the owner sponsors their own requisition.
    assert.ok(raised.body['owner_approved_at']);
    assert.strictEqual(raised.body['owner_approver_id'], null);
    const id = raised.body['requisition_id'] as string;
    const headApprove = await approve(id, headHeaders);
    assert.strictEqual(headApprove.status, 200, JSON.stringify(headApprove.body));
    assert.strictEqual(headApprove.body['status'], 'approved');
  });

  it('multi-line raise and issue persist every line and every cost row (no 23505)', async () => {
    const project = `ML-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 10 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '50', issue_type: 'consumable' },
      { sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '40', issue_type: 'consumable' },
    ]);
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    assert.strictEqual(raised.body['status'], 'approval_required');
    const lines = raised.body['lines'] as Row[];
    assert.strictEqual(lines.length, 2);
    const id = raised.body['requisition_id'] as string;

    const ownerApprove = await approve(id, ownerHeaders);
    assert.strictEqual(ownerApprove.status, 200, JSON.stringify(ownerApprove.body));
    const headApprove = await approve(id, headHeaders);
    assert.strictEqual(headApprove.status, 200, JSON.stringify(headApprove.body));
    assert.strictEqual(headApprove.body['status'], 'approved');

    const res = await issue(id, [
      { requisition_line_id: lines[0]!['requisition_line_id'], quantity: '1', location_id: stdBin },
      { requisition_line_id: lines[1]!['requisition_line_id'], quantity: '1', location_id: stdBin },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const costs = res.body['issue_costs'] as Row[];
    assert.strictEqual(costs.length, 2);
  });

  it('multi-line equipment custody issue writes every custody row (no 23505)', async () => {
    const project = `EC-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '2', uom: 'EA', unit_cost_estimate: '6', issue_type: 'equipment_custody' },
      { sku: SKU, requested_qty: '2', uom: 'EA', unit_cost_estimate: '6', issue_type: 'equipment_custody' },
    ]);
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    assert.strictEqual(raised.body['status'], 'approved');
    const lines = raised.body['lines'] as Row[];
    assert.strictEqual(lines.length, 2);
    const id = raised.body['requisition_id'] as string;

    const res = await issue(id, [
      {
        requisition_line_id: lines[0]!['requisition_line_id'],
        quantity: '1',
        location_id: stdBin,
        custodian_user_id: requesterId,
        expected_return_date: '2030-01-01',
        condition_codes: ['working'],
      },
      {
        requisition_line_id: lines[1]!['requisition_line_id'],
        quantity: '1',
        location_id: stdBin,
        custodian_user_id: requesterId,
        expected_return_date: '2030-01-01',
        condition_codes: ['working'],
      },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const custody = res.body['equipment_custody'] as Row[];
    assert.strictEqual(custody.length, 2);
  });

  it('reject by owner settles the requisition rejected', async () => {
    const project = `RJ-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 10 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '50', issue_type: 'consumable' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const res = await reject(id, ownerHeaders, 'Too expensive');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'rejected');
    assert.strictEqual(res.body['rejection_reason'], 'Too expensive');
  });

  it('issue on a non-approved requisition is refused RD_REQUISITION_NOT_APPROVED', async () => {
    const project = `NA-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 10 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '50', issue_type: 'consumable' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;
    const res = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '1', location_id: stdBin },
    ]);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_REQUISITION_NOT_APPROVED');
  });

  it('research issue is expensed, drains stock, and increments issued_quantity', async () => {
    const project = `RS-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '5', uom: 'EA', unit_cost_estimate: '6', issue_type: 'consumable' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;
    const before = await onHand(SKU, stdBin);
    const res = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '2', location_id: stdBin },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const costs = res.body['issue_costs'] as Row[];
    assert.strictEqual(costs.length, 1);
    assert.strictEqual(costs[0]!['capitalization'], 'expensed');
    assert.strictEqual(costs[0]!['capitalization_blocked_reason'], null);
    assert.strictEqual(Number(costs[0]!['cost_amount']), 4);
    assert.strictEqual(await onHand(SKU, stdBin), before - 2);
    const after = await line(id);
    assert.strictEqual(Number(after['issued_quantity']), 2);
  });

  it('over-issue is refused RD_REQUISITION_LINE_EXCEEDED', async () => {
    const project = `OV-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '5', uom: 'EA', unit_cost_estimate: '6', issue_type: 'consumable' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;
    const over = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '6', location_id: stdBin },
    ]);
    assert.strictEqual(over.status, 409, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'RD_REQUISITION_LINE_EXCEEDED');
    const first = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '5', location_id: stdBin },
    ]);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '1', location_id: stdBin },
    ]);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'RD_REQUISITION_LINE_EXCEEDED');
  });

  it('development issue with incomplete checklist is expensed with CAPITALIZATION_CRITERIA_NOT_MET', async () => {
    const project = `DV-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'development', budget_amount: 1000 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '3', uom: 'EA', unit_cost_estimate: '6', issue_type: 'project_material' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;
    const res = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '3', location_id: stdBin },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const costs = res.body['issue_costs'] as Row[];
    assert.strictEqual(costs[0]!['capitalization'], 'expensed');
    assert.strictEqual(costs[0]!['capitalization_blocked_reason'], 'CAPITALIZATION_CRITERIA_NOT_MET');
  });

  it('development issue after all six criteria met is capitalized', async () => {
    const project = `CP-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'development', budget_amount: 1000 });
    const set = await setChecklist(project, SIX_CRITERIA);
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    assert.ok(set.body['capitalization_effective_date']);
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '3', uom: 'EA', unit_cost_estimate: '6', issue_type: 'project_material' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;
    const res = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '3', location_id: stdBin },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const costs = res.body['issue_costs'] as Row[];
    assert.strictEqual(costs[0]!['capitalization'], 'capitalized');
    assert.strictEqual(costs[0]!['capitalization_blocked_reason'], null);
    assert.strictEqual(costs[0]!['checklist_reference'], project);
  });

  it('checklist route refuses a client-supplied capitalization_effective_date', async () => {
    const project = `RB-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'development', budget_amount: 1000 });
    const res = await setChecklist(project, SIX_CRITERIA, {
      capitalization_effective_date: '2020-01-01T00:00:00.000Z',
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RETROACTIVE_REINSTATEMENT_BLOCKED');
  });

  it('committed uses remaining unissued quantity (budget check after partial issue)', async () => {
    const project = `CM-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 100 });
    const a = await raise(project, [
      { sku: SKU, requested_qty: '10', uom: 'EA', unit_cost_estimate: '6', issue_type: 'consumable' },
    ]);
    assert.strictEqual(a.body['status'], 'approved');
    const aid = a.body['requisition_id'] as string;
    const aln = (a.body['lines'] as Row[])[0]!;
    const issued = await issue(aid, [
      { requisition_line_id: aln['requisition_line_id'], quantity: '5', location_id: stdBin },
    ]);
    assert.strictEqual(issued.status, 201, JSON.stringify(issued.body));

    const committed = await getPool().query(
      `SELECT COALESCE(SUM(round((l.requested_qty - l.issued_quantity) * l.unit_cost_estimate, 4)), 0)::float8 AS c
       FROM rd_requisition_line l JOIN rd_requisition r ON r.requisition_id = l.requisition_id
       WHERE r.project_code = $1 AND r.status = 'approved'`,
      [project],
    );
    assert.strictEqual(committed.rows[0]!['c'], 30);

    // With remaining-committed = 30 and actual = 10 (relieved at cost 2), a 40-value requisition
    // probes at 80 < 100 and stays approved. Full line_value committed (60) would probe 110 > 100.
    const b = await raise(project, [
      { sku: SKU, requested_qty: '10', uom: 'EA', unit_cost_estimate: '4', issue_type: 'consumable' },
    ]);
    assert.strictEqual(b.body['status'], 'approved');
  });

  it('raise replay with the same idempotency key does not duplicate the header', async () => {
    const project = `RP-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const key = randomUUID();
    const first = await raise(
      project,
      [{ sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '6', issue_type: 'consumable' }],
      { idempotency_key: key },
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await raise(
      project,
      [{ sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '6', issue_type: 'consumable' }],
      { idempotency_key: key },
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.strictEqual(second.body['requisition_id'], first.body['requisition_id']);
    const count = await getPool().query(`SELECT COUNT(*)::int AS n FROM rd_requisition WHERE requisition_id = $1`, [
      first.body['requisition_id'],
    ]);
    assert.strictEqual(count.rows[0]!['n'], 1);
  });

  it('issue replay with the same issue_id does not double-issue', async () => {
    const project = `IR-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '5', uom: 'EA', unit_cost_estimate: '6', issue_type: 'consumable' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;
    const issueId = randomUUID();
    const body = [
      { requisition_line_id: ln['requisition_line_id'], quantity: '2', location_id: stdBin },
    ];
    const first = await issue(id, body, { issue_id: issueId });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await issue(id, body, { issue_id: issueId });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const count = await getPool().query(`SELECT COUNT(*)::int AS n FROM rd_issue_cost WHERE issue_id = $1`, [issueId]);
    assert.strictEqual(count.rows[0]!['n'], 1);
    const afterLine = await line(id);
    assert.strictEqual(Number(afterLine['issued_quantity']), 2);
  });

  it('equipment custody: drains stock, writes no cost row, and rejects a past return date', async () => {
    const project = `EQ-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '5', uom: 'EA', unit_cost_estimate: '6', issue_type: 'equipment_custody' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;

    const past = await issue(id, [
      {
        requisition_line_id: ln['requisition_line_id'],
        quantity: '1',
        location_id: stdBin,
        custodian_user_id: requesterId,
        expected_return_date: '2020-01-01',
        condition_codes: ['working'],
      },
    ]);
    assert.strictEqual(past.status, 400, JSON.stringify(past.body));

    const before = await onHand(SKU, stdBin);
    const valuationBefore = await getPool().query(
      `SELECT quantity_on_hand::float8 AS q, carrying_value::float8 AS v FROM inventory_valuation WHERE sku = $1`,
      [SKU],
    );
    const res = await issue(id, [
      {
        requisition_line_id: ln['requisition_line_id'],
        quantity: '2',
        location_id: stdBin,
        custodian_user_id: requesterId,
        expected_return_date: '2030-01-01',
        condition_codes: ['working', 'calibrated'],
      },
    ]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((res.body['issue_costs'] as Row[]).length, 0);
    const custody = res.body['equipment_custody'] as Row[];
    assert.strictEqual(custody.length, 1);
    assert.strictEqual(custody[0]!['status'], 'on_loan');
    assert.strictEqual(custody[0]!['custodian_user_id'], requesterId);
    assert.strictEqual(Number(custody[0]!['quantity']), 2);
    assert.strictEqual(custody[0]!['expected_return_date'], '2030-01-01');
    assert.deepStrictEqual(custody[0]!['condition_codes'], ['working', 'calibrated']);
    assert.strictEqual(custody[0]!['overdue'], false);
    assert.strictEqual(custody[0]!['overdue_days'], 0);
    assert.strictEqual(await onHand(SKU, stdBin), before - 2);
    const valuationAfter = await getPool().query(
      `SELECT quantity_on_hand::float8 AS q, carrying_value::float8 AS v FROM inventory_valuation WHERE sku = $1`,
      [SKU],
    );
    assert.strictEqual(valuationAfter.rows[0]!['q'], valuationBefore.rows[0]!['q']);
    assert.strictEqual(valuationAfter.rows[0]!['v'], valuationBefore.rows[0]!['v']);
  });

  it('missing issue_type is refused RD_ISSUE_TYPE_REQUIRED', async () => {
    const project = `IT-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const res = await raise(project, [
      { sku: SKU, requested_qty: '1', uom: 'EA', unit_cost_estimate: '6' },
    ]);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RD_ISSUE_TYPE_REQUIRED');
  });

  it('list route tolerates a non-numeric limit/offset without a 500', async () => {
    const project = `LS-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/rd-requisitions?limit=abc&offset=xyz`,
      undefined,
      ownerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body['requisitions']));
  });

  it('AC6: incomplete checklist expenses, later met capitalizes, first cost row never reinstated', async () => {
    const project = `AC6-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'development', budget_amount: 1000 });
    const partial = { ...SIX_CRITERIA, future_economic_benefits: false };
    const setPartial = await setChecklist(project, partial);
    assert.strictEqual(setPartial.status, 200, JSON.stringify(setPartial.body));

    const raised = await raise(project, [
      { sku: SKU, requested_qty: '6', uom: 'EA', unit_cost_estimate: '6', issue_type: 'project_material' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;

    const first = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '3', location_id: stdBin },
    ]);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstCosts = first.body['issue_costs'] as Row[];
    assert.strictEqual(firstCosts.length, 1);
    assert.strictEqual(firstCosts[0]!['capitalization'], 'expensed');
    assert.strictEqual(firstCosts[0]!['capitalization_blocked_reason'], 'CAPITALIZATION_CRITERIA_NOT_MET');

    const setAll = await setChecklist(project, SIX_CRITERIA);
    assert.strictEqual(setAll.status, 200, JSON.stringify(setAll.body));
    assert.ok(setAll.body['capitalization_effective_date']);

    const second = await issue(id, [
      { requisition_line_id: ln['requisition_line_id'], quantity: '3', location_id: stdBin },
    ]);
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const secondCosts = second.body['issue_costs'] as Row[];
    assert.strictEqual(secondCosts.length, 2);
    // created_at ordering keeps the earlier issue first: the first cost row stays expensed (no
    // retroactive reinstatement), and only the second, post-criteria issue capitalizes.
    assert.strictEqual(secondCosts[0]!['capitalization'], 'expensed');
    assert.strictEqual(secondCosts[1]!['capitalization'], 'capitalized');
  });

  it('AC7: overdue on_loan custody surfaces overdue and overdue_days', async () => {
    const project = `OD-${run}`.toUpperCase();
    await createProject({ project_code: project, owner_user_id: ownerId, phase: 'research', budget_amount: 1000 });
    const raised = await raise(project, [
      { sku: SKU, requested_qty: '2', uom: 'EA', unit_cost_estimate: '6', issue_type: 'equipment_custody' },
    ]);
    const id = raised.body['requisition_id'] as string;
    const ln = (raised.body['lines'] as Row[])[0]!;

    // The issue seam refuses a past return date, so the overdue state is seeded directly at the
    // register and read back through the read model.
    const custodyId = randomUUID();
    const issueId = randomUUID();
    await getPool().query(
      `INSERT INTO rd_equipment_custody
         (custody_id, issue_id, requisition_id, requisition_line_id, project_code, custodian_user_id,
          asset_id, sku, quantity, expected_return_date, condition_codes, status, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, '1', '2020-01-01', ARRAY['working'], 'on_loan', $8)`,
      [custodyId, issueId, id, ln['requisition_line_id'], project, requesterId, SKU, randomUUID()],
    );

    const got = await makeRequest(port, 'GET', `/api/v1/rd-requisitions/${id}`, undefined, ownerHeaders);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const custody = (got.body['equipment_custody'] as Row[]).filter((c) => c['custody_id'] === custodyId);
    assert.strictEqual(custody.length, 1);
    assert.strictEqual(custody[0]!['overdue'], true);
    assert.ok((custody[0]!['overdue_days'] as number) > 0);
  });
});

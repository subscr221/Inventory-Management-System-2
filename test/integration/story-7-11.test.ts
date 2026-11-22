import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.11: nav gating (DOA holder vs technician), the warranty override reason-code read and the
// read enrichments the supervisor desk board needs. Real auth, RBAC and PostgreSQL; no mocks.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN'] ?? ''}` };
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

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<void> {
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
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 7.11 Maintenance Supervisor Desk server reads', () => {
  let server: Server;
  let port: number;
  let supervisorHeaders: Record<string, string>;
  let technicianHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let procurementHeaders: Record<string, string>;
  let siteId: string;
  let assetId: string;
  let assetTag: string;
  let assetName: string;

  const navOf = async (headers: Record<string, string>): Promise<string[]> => {
    const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, headers);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return res.body['navigation'] as string[];
  };

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
      '../../read/projections/maintenance_asset_cost.sql',
      '../../read/projections/statutory_examination.sql',
      '../../read/projections/asset_coverage.sql',
      '../../read/projections/asset_coverage_alert.sql',
      '../../read/projections/maintenance_warranty_override.sql',
      '../../read/projections/maintenance_work_order_closure.sql',
      '../../read/projections/maintenance_sync_conflict.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE maintenance_sync_conflict, maintenance_work_order_closure, maintenance_warranty_override, asset_coverage_alert, asset_coverage, statutory_examination, maintenance_asset_cost, maintenance_spare_alert, maintenance_spare_reservation, asset_parts_list, maintenance_spare_catalogue, maintenance_reliability_metric, maintenance_downtime, maintenance_fault_report, maintenance_sla_policy, maintenance_work_order, maintenance_plan, asset_meter_reading, asset_meter, asset, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteId = randomUUID();
    await adminPool.query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, 'site', NULL, $1, 'general', 'ambient', false, 'active')`,
      [siteId, `site-7-11-${run}`],
    );

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    const sup = `maint-sup-7-11-${run}@example.com`;
    await provisionUser(port, sup, [
      {
        role: 'maintenance_supervisor',
        module: 'maintenance',
        functionScope: 'write',
        locationId: siteId,
      },
      {
        role: 'maintenance_supervisor',
        module: 'maintenance',
        functionScope: 'read',
        locationId: siteId,
      },
    ]);
    supervisorHeaders = await authFor(port, sup);
    const tech = `maint-tech-7-11-${run}@example.com`;
    await provisionUser(port, tech, [
      {
        role: 'maintenance_technician',
        module: 'maintenance',
        functionScope: 'write',
        locationId: siteId,
      },
    ]);
    technicianHeaders = await authFor(port, tech);
    const comp = `compliance-7-11-${run}@example.com`;
    await provisionUser(port, comp, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, comp);
    const proc = `proc-7-11-${run}@example.com`;
    await provisionUser(port, proc, [
      { role: 'buyer', module: 'procurement', functionScope: 'write', locationId: siteId },
    ]);
    procurementHeaders = await authFor(port, proc);

    const sla = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      {
        criticality_class: 'critical',
        safety_flag: false,
        priority: 'p1',
        response_minutes: 30,
        resolution_hours: 4,
      },
      supervisorHeaders,
    );
    assert.ok(sla.status === 201 || sla.body['error_code'] === 'DUPLICATE_SLA_POLICY');
    assetTag = `TAG-7-11-${randomUUID().slice(0, 12)}`;
    assetName = `Press ${run}`;
    const asset = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      { asset_tag: assetTag, asset_name: assetName, criticality_class: 'critical' },
      supervisorHeaders,
    );
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    assetId = (asset.body['asset'] as Record<string, string>)['asset_id']!;
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('navigation: the technician Maintenance row shows to maintenance read, never the desk', async () => {
    const tech = await navOf(technicianHeaders);
    assert.ok(tech.includes('Maintenance'), JSON.stringify(tech));
    assert.ok(!tech.includes('Maintenance desk'));
    assert.ok(!(await navOf(procurementHeaders)).includes('Maintenance'));
  });

  it('navigation: the desk follows an active DOA holding, not the module role', async () => {
    // No DOA entry yet: even the supervisor is not sent the desk.
    assert.ok(!(await navOf(supervisorHeaders)).includes('Maintenance desk'));
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'maintenance_supervisor',
        transaction_type: 'maintenance.return_to_service',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));
    assert.ok((await navOf(supervisorHeaders)).includes('Maintenance desk'));
    assert.ok(!(await navOf(technicianHeaders)).includes('Maintenance desk'));
  });

  it('reason codes: the configured warranty override catalogue, maintenance read only', async () => {
    const path = '/api/v1/maintenance/warranty-override-reason-codes';
    const ok = await makeRequest(port, 'GET', path, undefined, supervisorHeaders);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body['reason_codes'], config.maintenance.warrantyOverrideReasonCodes);
    const denied = await makeRequest(port, 'GET', path, undefined, procurementHeaders);
    assert.strictEqual(denied.status, 403);
  });

  it('enrichment: work-order asset_tag, asset-status asset_tag and asset_name, worklist status_note and fault_report_id', async () => {
    const reported = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/fault-reports',
      { asset_id: assetId, description: 'Belt slipping' },
      supervisorHeaders,
    );
    assert.strictEqual(reported.status, 201, JSON.stringify(reported.body));
    const faultId = (reported.body['fault_report'] as Record<string, string>)['fault_report_id']!;
    const accepted = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultId}/accept`,
      {},
      supervisorHeaders,
    );
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    const workOrderId = (accepted.body['work_order'] as Record<string, string>)['work_order_id']!;

    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders?asset_id=${assetId}`,
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const row = (list.body['work_orders'] as Array<Record<string, unknown>>).find(
      (w) => w['work_order_id'] === workOrderId,
    )!;
    assert.strictEqual(row['asset_tag'], assetTag);
    assert.strictEqual(row['status'], 'open');

    const set = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/status`,
      { new_status: 'idle' },
      supervisorHeaders,
    );
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    const down = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/status`,
      { new_status: 'breakdown' },
      supervisorHeaders,
    );
    assert.strictEqual(down.status, 200, JSON.stringify(down.body));
    const statuses = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/asset-status?status=breakdown',
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(statuses.status, 200, JSON.stringify(statuses.body));
    const status = (statuses.body['asset_statuses'] as Array<Record<string, unknown>>).find(
      (s) => s['asset_id'] === assetId,
    )!;
    assert.strictEqual(status['asset_tag'], assetTag);
    assert.strictEqual(status['asset_name'], assetName);

    const worklist = await makeRequest(
      port,
      'GET',
      '/api/v1/edge/maintenance/worklist',
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(worklist.status, 200, JSON.stringify(worklist.body));
    const entry = (worklist.body['work_orders'] as Array<Record<string, unknown>>).find(
      (w) => w['work_order_id'] === workOrderId,
    )!;
    assert.strictEqual(entry['status_note'], null);
    assert.strictEqual(entry['fault_report_id'], faultId);
  });
});

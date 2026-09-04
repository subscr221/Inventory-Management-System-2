import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { findValidBisLicence } from '../../src/read/projections/compliance_bis_licence.js';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBisLicenceExpiryCycle } from '../../src/compliance/bis-licence-expiry.js';
import { persistEvent } from '../../src/events/store.js';

/**
 * Story 8.7 Compliance Master Data - BIS Licence Register and Legal Metrology Label Masters
 * (FR-Q-11, FR-Q-14). Real PostgreSQL, the real production router, SCIM provisioning and
 * dev-token auth. Tests run serially; every identifier is run-scoped.
 *
 * The harness scaffolding (makeRequest/provisionUser/authFor/createItem/seedLocation and the
 * QC plan/lot machinery used only by the AC 2 end-to-end regression arm) is a deliberate local
 * re-implementation of the story-8-6.test.ts closures, which are not exported (that file's own
 * documented rule at its top: never import cross-story).
 */

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

/** Independent IST calendar arithmetic (+05:30), never imported from production. */
function istDate(offsetDays: number = 0): string {
  const ist = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000 + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
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
    req.setTimeout(60000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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

interface Plan {
  itemId: string;
  sku: string;
  revisionId: string;
  planId: string;
  versionId: string;
  lines: string[];
}

interface Held {
  lotId: string;
  lotNumber: string;
  taskId: string;
  plan: Plan;
}

describe('Story 8.7 Compliance Master Data - BIS Licence Register and Label Masters', () => {
  let server: Server;
  let port: number;

  let complianceAdminUserId: string;
  let complianceAdminHeaders: Record<string, string>;
  let complianceWriter2Headers: Record<string, string>;
  let complianceReaderHeaders: Record<string, string>;
  let deniedHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let componentItemId: string;

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  async function createItem(sku: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku,
        description: `Story 8.7 item ${sku}`,
        valuation_method: 'fifo',
        uom: 'EA',
        business_stream: 'production',
        category: 'raw_materials',
        lot_controlled: true,
        standard_cost_designation: 'ind_as_2_para_21_measurement_technique',
        standard_cost_amount: 10,
        ...overrides,
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, `item ${sku} failed: ${JSON.stringify(res.body)}`);
    return (res.body as Record<string, string>)['item_id']!;
  }

  async function seedLocation(
    level: string,
    code: string,
    parentId: string | null,
    siteId: string | null,
  ): Promise<string> {
    const locationId = randomUUID();
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::uuid IS NULL THEN $1 ELSE $5::uuid END, 'general', 'ambient', 'active') RETURNING location_id`,
      [locationId, code, level, parentId, siteId],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  async function auditCount(errorCode: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = $1 AND ${where}`,
      [errorCode, ...params],
    );
    return r.rows[0]!['n'] as number;
  }

  // -------------------------------------------------------------------------
  // Compliance API helpers
  // -------------------------------------------------------------------------

  async function createLicence(
    headers: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/compliance/bis-licences',
      {
        licence_number: `CM/L-87-${run}-${randomUUID().slice(0, 6)}`,
        licence_type: 'cml',
        valid_from: '2020-01-01',
        valid_to: '2099-12-31',
        idempotency_key: randomUUID(),
        ...overrides,
      },
      headers,
    );
  }

  /**
   * The alert-ledger stages recorded for a licence, most urgent last. The ledger is keyed on the
   * window the alert was raised against, so `validTo` narrows to one window; without it the rows
   * for every window this licence has ever had are returned.
   */
  async function stagesFor(licenceId: string, validTo?: string): Promise<number[]> {
    const r = validTo
      ? await getAdminPool().query(
          `SELECT stage_days FROM compliance_bis_licence_alert
            WHERE licence_id = $1 AND valid_to = $2::date ORDER BY stage_days DESC`,
          [licenceId, validTo],
        )
      : await getAdminPool().query(
          `SELECT stage_days FROM compliance_bis_licence_alert WHERE licence_id = $1
            ORDER BY stage_days DESC`,
          [licenceId],
        );
    return r.rows.map((row) => row['stage_days'] as number);
  }

  async function draftLabel(
    headers: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/compliance/label-masters',
      {
        label_version: 'v1',
        idempotency_key: randomUUID(),
        ...overrides,
      },
      headers,
    );
  }

  // -------------------------------------------------------------------------
  // Minimal QC plan/lot machinery, needed only by the AC 2 end-to-end release regression.
  // -------------------------------------------------------------------------

  async function draftAndRelease(parentItemId: string): Promise<string> {
    const draft = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'A',
        bom_type: 'production',
        lines: [
          {
            line_no: 1,
            component_item_id: componentItemId,
            output_class: 'component',
            quantity_per: '2.0',
            line_uom: 'EA',
            uom_conversion_factor: '1.0',
            scrap_percent: '0.0',
            is_phantom: false,
            effective_from: '2020-01-01',
          },
        ],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(draft.status, 201, `draft failed: ${JSON.stringify(draft.body)}`);
    const bomId = draft.body['bom_id'] as string;
    const rollup = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/cost-rollups`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(rollup.status, 201, `rollup failed: ${JSON.stringify(rollup.body)}`);
    const release = await makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
    assert.strictEqual(release.status, 200, `release failed: ${JSON.stringify(release.body)}`);
    return draft.body['current_revision_id'] as string;
  }

  function minorAttribute(lineNo: number = 1): Record<string, unknown> {
    return {
      line_no: lineNo,
      characteristic_name: 'Surface finish',
      characteristic_class: 'minor',
      test_method_ref: 'SOP-QC-014',
      instrument_type: null,
      result_kind: 'attribute',
      lower_limit: null,
      upper_limit: null,
      limit_uom: null,
      acceptance_criteria: 'No visible scratches under 500 lux',
      sample_handling: 'Visual',
    };
  }

  let planCounter = 0;
  async function planOk(itemOverrides: Record<string, unknown> = {}): Promise<Plan> {
    planCounter += 1;
    const sku = `FG-8-7-${run}-${planCounter}`;
    const itemId = await createItem(sku, itemOverrides);
    const revisionId = await draftAndRelease(itemId);
    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/inspection-plans',
      {
        scope: 'standard',
        item_id: itemId,
        bom_revision_id: revisionId,
        effective_from: '2026-01-01',
        aql: '1.000',
        inspection_level: 'II',
        characteristics: [minorAttribute()],
      },
      qcHeadHeaders,
    );
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const planId = (created.body['plan'] as Record<string, unknown>)['plan_id'] as string;
    const versionId = (created.body['version'] as Record<string, unknown>)[
      'plan_version_id'
    ] as string;
    const approved = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/inspection-plans/${planId}/versions/${versionId}/approve`,
      { idempotency_key: randomUUID() },
      qcHeadHeaders,
    );
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    const lines = (created.body['characteristics'] as Array<Record<string, unknown>>).map(
      (c) => c['characteristic_id'] as string,
    );
    return { itemId, sku, revisionId, planId, versionId, lines };
  }

  let lotCounter = 0;
  async function heldLot(
    plan: Plan,
    quantity: string,
    locationId: string,
    siteId: string,
    headers: Record<string, string>,
  ): Promise<Held> {
    lotCounter += 1;
    const lotId = randomUUID();
    const lotNumber = `FG-LOT-8-7-${run}-${lotCounter}`;
    await getPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status) VALUES ($1, $2, $3, 'none')`,
      [lotId, lotNumber, plan.sku],
    );
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', $4::numeric)`,
      [plan.sku, locationId, lotNumber, quantity],
    );
    await getPool().query(
      `INSERT INTO lot_trace (lot_id, event_id, event_type, sku, location_id, location_code, quantity_change, business_stream)
       VALUES ($1, $2, 'stock.received', $3, $4, NULL, $5::numeric, 'production')`,
      [lotId, randomUUID(), plan.sku, locationId, quantity],
    );
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/completions',
      {
        source_completion_type: 'synthetic_completion',
        source_completion_id: randomUUID(),
        lot_id: lotId,
        lot_number: lotNumber,
        item_id: plan.itemId,
        quantity,
        uom: 'EA',
        site_id: siteId,
        bom_revision_id: plan.revisionId,
        completed_at: '2026-07-15T10:00:00.000+05:30',
        business_stream: 'production',
        source_order_type: null,
        source_order_ref: null,
      },
      headers,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const task = res.body['task'] as Record<string, unknown>;
    return { lotId, lotNumber, taskId: task['task_id'] as string, plan };
  }

  async function inspected(
    plan: Plan,
    quantity: string = '10.000000',
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Held> {
    const held = await heldLot(plan, quantity, locationId, siteId, headers);
    const determination = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/sampling`,
      {},
      headers,
    );
    assert.strictEqual(determination.status, 201, JSON.stringify(determination.body));
    const sampleSize = (determination.body['sampling'] as Record<string, unknown>)[
      'sample_size'
    ] as number;
    const readings: Record<string, unknown>[] = [];
    for (let u = 1; u <= sampleSize; u += 1) {
      readings.push({ sample_unit_no: u, attribute_conforms: true });
    }
    const obs = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/observations`,
      { characteristic_id: plan.lines[0], readings },
      headers,
    );
    assert.strictEqual(obs.status, 201, JSON.stringify(obs.body));
    const completion = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/inspection-completion`,
      {},
      headers,
    );
    assert.strictEqual(completion.status, 201, JSON.stringify(completion.body));
    return held;
  }

  async function accepted(
    plan: Plan,
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Held> {
    const held = await inspected(plan, '10.000000', locationId, siteId, headers);
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/disposition`,
      { disposition: 'accept', justification: 'Story 8.7 accept decision' },
      approverHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return held;
  }

  async function releasable(
    plan: Plan,
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Held> {
    const held = await accepted(plan, locationId, siteId, headers);
    const sample = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/retention-sample`,
      { quantity: '1.000000', uom: 'EA', location_id: locationId },
      headers,
    );
    assert.strictEqual(sample.status, 201, JSON.stringify(sample.body));
    return held;
  }

  async function release(
    taskId: string,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', `/api/v1/qc/tasks/${taskId}/release`, {}, headers);
  }

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

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
      '../../read/projections/supplier.sql',
      '../../read/projections/supplier_scorecard_metric.sql',
      '../../read/projections/bom.sql',
      '../../read/projections/bom_revision.sql',
      '../../read/projections/bom_line.sql',
      '../../read/projections/bom_structure.sql',
      '../../read/projections/bom_alternate.sql',
      '../../read/projections/bom_explosion.sql',
      '../../read/projections/bom_explosion_line.sql',
      '../../read/projections/bom_cost_rollup.sql',
      '../../read/projections/bom_cost_rollup_line.sql',
      '../../read/projections/bom_outbound_message.sql',
      '../../read/projections/inspection_plan.sql',
      '../../read/projections/inspection_plan_version.sql',
      '../../read/projections/inspection_plan_characteristic.sql',
      '../../read/projections/inspection_plan_approval.sql',
      '../../read/projections/qc_inspection_task.sql',
      '../../read/projections/qc_deviation.sql',
      '../../read/projections/qc_lot_disposition.sql',
      '../../read/projections/qc_sampling_plan.sql',
      '../../read/projections/qc_inspection_result.sql',
      '../../read/projections/qc_sampling_switching_state.sql',
      '../../read/projections/qc_lot_split.sql',
      '../../read/projections/qc_ncr.sql',
      '../../read/projections/qc_batch_release.sql',
      '../../read/projections/qc_retention_sample.sql',
      '../../read/projections/qc_quality_hold.sql',
      '../../read/projections/qc_capa.sql',
      '../../read/projections/compliance_bis_licence.sql',
      '../../read/projections/label_master.sql',
      '../../read/projections/compliance_bis_licence_alert.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE compliance_bis_licence_alert, compliance_bis_licence, label_master, qc_capa, qc_quality_hold, qc_retention_sample, qc_batch_release, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-7-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-7-${run}`, siteAId, siteAId);

    complianceAdminUserId = await provisionUser(port, `compliance-admin-8-7-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
      { role: 'compliance_admin', module: 'compliance', functionScope: 'read', locationId: '*' },
      // The FR-AC-13 edit-log proof reads GET /api/v1/audit/log, which is guarded by module
      // 'audit' - a separate grant from the compliance module these routes live on.
      { role: 'compliance_admin', module: 'audit', functionScope: 'read', locationId: '*' },
    ]);
    complianceAdminHeaders = await authFor(port, `compliance-admin-8-7-${run}@example.com`);

    await provisionUser(port, `compliance-writer2-8-7-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
      { role: 'compliance_admin', module: 'compliance', functionScope: 'read', locationId: '*' },
    ]);
    complianceWriter2Headers = await authFor(port, `compliance-writer2-8-7-${run}@example.com`);

    await provisionUser(port, `compliance-reader-8-7-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'read', locationId: '*' },
    ]);
    complianceReaderHeaders = await authFor(port, `compliance-reader-8-7-${run}@example.com`);

    await provisionUser(port, `unassigned-8-7-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    deniedHeaders = await authFor(port, `unassigned-8-7-${run}@example.com`);

    await provisionUser(port, `engineer-8-7-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-7-${run}@example.com`);

    await provisionUser(port, `qc-head-8-7-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-7-${run}@example.com`);

    await provisionUser(port, `qc-inspector-8-7-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteAId },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteAId },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-8-7-${run}@example.com`);

    await provisionUser(port, `qc-approver-8-7-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `qc-approver-8-7-${run}@example.com`);

    for (const transactionType of ['qc.inspection_plan_approval', 'qc.conditional_release']) {
      await getPool().query(
        `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
         VALUES ($1, 'qc_head', $2, NULL, NULL, true)`,
        [randomUUID(), transactionType],
      );
    }

    // The compliance.label_master_approval DOA entry (BSD-4): governs which role can approve a
    // label version, resolved to complianceAdminUserId (via the compliance_admin role holder).
    const doaEntryRes = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'compliance.label_master_approval',
        role: 'compliance_admin',
        value_min: null,
        value_max: null,
      },
      complianceAdminHeaders,
    );
    assert.strictEqual(doaEntryRes.status, 201, JSON.stringify(doaEntryRes.body));

    componentItemId = await createItem(`CMP-8-7-${run}`, { lot_controlled: false });
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: BIS licence register CRUD and edit log (Task 9.2)
  // -------------------------------------------------------------------------

  it('AC 1: create persists all fields, and update/renewal changes the window on the SAME row', async () => {
    const sku = `SKU-87-1-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      licence_type: 'cml',
      valid_from: '2025-01-01',
      valid_to: istDate(120),
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const licence = created.body['licence'] as Record<string, unknown>;
    assert.strictEqual(licence['sku'], sku);
    assert.strictEqual(licence['licence_type'], 'cml');
    assert.strictEqual(licence['valid_from'], '2025-01-01');
    assert.strictEqual(licence['valid_to'], istDate(120));
    assert.strictEqual(licence['status'], 'active');
    const licenceId = licence['licence_id'] as string;
    const eventId = created.body['event_id'] as string;

    // FR-AC-13 edit-log proof: the event_id ties to a domain_events row for this licence.
    const evRow = await getAdminPool().query(
      `SELECT event_id FROM domain_events WHERE event_id = $1 AND stream_id = $2`,
      [eventId, licenceId],
    );
    assert.strictEqual(evRow.rows.length, 1, 'the create event was persisted and logged');

    const updated = await makeRequest(
      port,
      'PATCH',
      `/api/v1/compliance/bis-licences/${licenceId}`,
      { valid_to: '2026-06-30', idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
    const updatedLicence = updated.body['licence'] as Record<string, unknown>;
    assert.strictEqual(updatedLicence['licence_id'], licenceId, 'renewal updates the SAME row');
    assert.strictEqual(updatedLicence['valid_to'], '2026-06-30');
    assert.strictEqual(updatedLicence['valid_from'], '2025-01-01');
    assert.strictEqual(await countRows('compliance_bis_licence', 'sku = $1', [sku]), 1);
  });

  it('code review D8: a write without idempotency_key is 400, and a replay is 200 not 201', async () => {
    const sku = `SKU-87-idem-${run}`;
    await createItem(sku);
    const noKey = await makeRequest(
      port,
      'POST',
      '/api/v1/compliance/bis-licences',
      {
        licence_number: `CM/L-87-nokey-${run}`,
        licence_type: 'cml',
        sku,
        valid_from: '2025-01-01',
        valid_to: istDate(300),
      },
      complianceAdminHeaders,
    );
    assert.strictEqual(noKey.status, 400, JSON.stringify(noKey.body));
    assert.strictEqual(noKey.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(noKey.body)['field'], 'idempotency_key');

    // The same key twice: created once, then replayed as 200 with the same event_id.
    const key = randomUUID();
    const body = {
      licence_number: `CM/L-87-replay-${run}`,
      licence_type: 'cml',
      sku,
      valid_from: '2025-01-01',
      valid_to: istDate(300),
      idempotency_key: key,
    };
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/compliance/bis-licences',
      body,
      complianceAdminHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/compliance/bis-licences',
      body,
      complianceAdminHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(await countRows('compliance_bis_licence', 'sku = $1', [sku]), 1);
  });

  it('code review: list routes are paginated and reject a blank sku filter', async () => {
    const blank = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/bis-licences?sku=',
      undefined,
      complianceAdminHeaders,
    );
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));
    assert.strictEqual(blank.body['error_code'], 'INVALID_PARAMS');

    const bounded = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/bis-licences?limit=1',
      undefined,
      complianceAdminHeaders,
    );
    assert.strictEqual(bounded.status, 200, JSON.stringify(bounded.body));
    assert.strictEqual((bounded.body['licences'] as unknown[]).length, 1);
    assert.strictEqual(bounded.body['limit'], 1);

    const overCap = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/bis-licences?limit=99999',
      undefined,
      complianceAdminHeaders,
    );
    assert.strictEqual(overCap.status, 400, JSON.stringify(overCap.body));
  });

  it('code review: approving a nonexistent label is 404, not a 403 about approval authority', async () => {
    const missing = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${randomUUID()}/approve`,
      { idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'LABEL_MASTER_NOT_FOUND');
  });

  it('code review: a licence recorded with an already-closed window is stored expired', async () => {
    const sku = `SKU-87-past-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2020-01-01',
      valid_to: istDate(-1),
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const licence = created.body['licence'] as Record<string, unknown>;
    // Symmetric with renewal: status is derived from the window at write time, never left 'active'
    // for the sweep to correct on some later tick.
    assert.strictEqual(licence['status'], 'expired');
    // And it is therefore not a sweep candidate, so no alert row is ever written for it.
    await runBisLicenceExpiryCycle();
    assert.strictEqual(
      await countRows('compliance_bis_licence_alert', 'licence_id = $1', [
        licence['licence_id'] as string,
      ]),
      0,
    );
  });

  it('code review: an SoD-refused approval writes an audit row', async () => {
    const sku = `SKU-87-sodaudit-${run}`;
    await createItem(sku);
    const draft = await draftLabel(complianceAdminHeaders, { sku, label_version: 'v1' });
    const labelId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;
    const refused = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${labelId}/approve`,
      { idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body['error_code'], 'LABEL_APPROVAL_SOD_VIOLATION');
    assert.strictEqual(
      await auditCount('LABEL_APPROVAL_SOD_VIOLATION', "details->>'label_id' = $2", [labelId]),
      1,
      'a refused statutory approval must leave an audit trail for THIS label',
    );
  });

  it('AC 1/BSD-3: renewing an expired licence restores it to service and re-arms its alerts', async () => {
    const sku = `SKU-87-renewal-${run}`;
    await createItem(sku);
    // Recorded LIVE and 10 days from expiry, so the sweep genuinely writes ledger rows for this
    // window before the renewal - the point of the test is what happens to those rows.
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      valid_to: istDate(10),
      valid_from: '2020-01-01',
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const licenceId = (created.body['licence'] as Record<string, unknown>)['licence_id'] as string;
    const firstWindow = istDate(10);

    await runBisLicenceExpiryCycle();
    assert.deepStrictEqual(
      await stagesFor(licenceId),
      [90, 60, 30],
      'the live window is flagged at every missed stage',
    );

    // The window closes, as it would overnight, and the sweep flips the licence.
    await getAdminPool().query(
      `UPDATE compliance_bis_licence SET valid_to = $2::date WHERE licence_id = $1`,
      [licenceId, istDate(-1)],
    );
    await runBisLicenceExpiryCycle();
    const expired = await getAdminPool().query(
      `SELECT status FROM compliance_bis_licence WHERE licence_id = $1`,
      [licenceId],
    );
    assert.strictEqual(expired.rows[0]!['status'], 'expired');

    // Renewal is an in-place window update: status returns to 'active' on the SAME row, so the
    // Story 8.6 statutory release block disengages.
    const renewed = await makeRequest(
      port,
      'PATCH',
      `/api/v1/compliance/bis-licences/${licenceId}`,
      { valid_to: istDate(45), idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(renewed.status, 200, JSON.stringify(renewed.body));
    assert.strictEqual((renewed.body['licence'] as Record<string, unknown>)['status'], 'active');

    // The ledger is APPEND-ONLY: the alerts raised against the earlier windows survive the renewal.
    // Nothing is deleted, because the window is part of the key.
    assert.deepStrictEqual(
      await stagesFor(licenceId, firstWindow),
      [90, 60, 30],
      'alerts raised against the first window are still on the record',
    );
    assert.deepStrictEqual(
      await stagesFor(licenceId, istDate(-1)),
      [0],
      'the expiry flip against the closed window is still on the record',
    );
    // The re-armed window is 45 days out, so the next sweep flags 90 and 60 for it.
    await runBisLicenceExpiryCycle();
    assert.deepStrictEqual(await stagesFor(licenceId, istDate(45)), [90, 60]);

    // The whole point of the append-only key: after the renewal has itself been swept, the ledger
    // holds every row from all three windows - 3 for the first, 1 for the closed one, 2 for the
    // renewed one. The pre-review design deleted the licence's rows on renewal and would fail
    // here with 2. (Asserting only that the NEW window starts empty proves nothing: it is a window
    // that has never existed before, so the count is zero by construction.)
    assert.strictEqual(
      await countRows('compliance_bis_licence_alert', 'licence_id = $1', [licenceId]),
      6,
      'no alert history is destroyed by a renewal',
    );
  });

  it('BSD-3/D11: an all-sites licence and a site-specific licence coexist, and the specific one wins', async () => {
    const sku = `SKU-87-precedence-${run}`;
    await createItem(sku);
    // Story 8.7 code review (D11): BSD-3 claimed the overlap guard leaves at most one row per
    // scope, making the findValidBisLicence ordering unreachable. It does not - the guard compares
    // scopes exactly, so a national all-sites licence and a plant-specific one legitimately
    // coexist with overlapping windows, and the site-specific row is the one that must win.
    const global = await createLicence(complianceAdminHeaders, {
      sku,
      site_id: null,
      valid_from: '2020-01-01',
      valid_to: istDate(300),
    });
    assert.strictEqual(global.status, 201, JSON.stringify(global.body));

    const specific = await createLicence(complianceAdminHeaders, {
      sku,
      site_id: siteAId,
      valid_from: '2020-01-01',
      valid_to: istDate(300),
    });
    assert.strictEqual(
      specific.status,
      201,
      'an overlapping site-specific licence is legitimate alongside an all-sites one',
    );
    const specificId = (specific.body['licence'] as Record<string, unknown>)[
      'licence_id'
    ] as string;

    const resolved = await findValidBisLicence(sku, siteAId, istDate(0));
    assert.ok(resolved, 'a covering licence resolves');
    assert.strictEqual(
      resolved.licence_id,
      specificId,
      'the site-specific licence takes precedence',
    );
  });

  it('AC 3/SoD: the drafting user cannot approve their own label version', async () => {
    const sku = `SKU-87-sod-${run}`;
    await createItem(sku);
    // The compliance admin IS the DOA-resolved approver, so a label they drafted themselves is
    // refused - the control a DOA-governed label master exists to enforce.
    const draft = await draftLabel(complianceAdminHeaders, { sku, label_version: 'v1' });
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));
    const labelId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;
    const approve = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${labelId}/approve`,
      { idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(approve.status, 409, JSON.stringify(approve.body));
    assert.strictEqual(approve.body['error_code'], 'LABEL_APPROVAL_SOD_VIOLATION');
    const row = await getAdminPool().query(`SELECT status FROM label_master WHERE label_id = $1`, [
      labelId,
    ]);
    assert.strictEqual(row.rows[0]!['status'], 'draft', 'the refused approval left no side effect');
  });

  it('AC 1/FR-AC-13: a licence change is visible through GET /api/v1/audit/log', async () => {
    const sku = `SKU-87-auditlog-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2020-01-01',
      valid_to: istDate(180),
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const eventId = created.body['event_id'] as string;

    // Task 9.2 states the edit-log proof is made through the audit ROUTE, not a raw domain_events
    // SELECT: a regression that stopped compliance writes reaching the audit projection would be
    // invisible to a query that reads the event store directly.
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const log = await makeRequest(
      port,
      'GET',
      `/api/v1/audit/log?start_date=${from}&end_date=${to}&limit=1000`,
      undefined,
      complianceAdminHeaders,
    );
    assert.strictEqual(log.status, 200, JSON.stringify(log.body));
    const entries = (log.body['entries'] ?? log.body['audit_log'] ?? []) as Array<
      Record<string, unknown>
    >;
    assert.ok(
      entries.some((e) => e['event_id'] === eventId),
      'the licence create is linked into the audit log by event_id',
    );
  });

  it('AC 1: immutable fields are rejected on PATCH', async () => {
    const sku = `SKU-87-2-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, { sku });
    const licenceId = (created.body['licence'] as Record<string, unknown>)['licence_id'] as string;
    for (const field of ['licence_number', 'licence_type', 'sku', 'site_id']) {
      const res = await makeRequest(
        port,
        'PATCH',
        `/api/v1/compliance/bis-licences/${licenceId}`,
        { [field]: 'not-allowed', idempotency_key: randomUUID() },
        complianceAdminHeaders,
      );
      assert.strictEqual(res.status, 400, `${field}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
  });

  it('AC 1: duplicate create (same number/sku/scope, different case) is BIS_LICENCE_EXISTS', async () => {
    const sku = `SKU-87-3-${run}`;
    await createItem(sku);
    const number = `CM/L-DUP-87-${run}`;
    const first = await createLicence(complianceAdminHeaders, {
      sku,
      licence_number: number,
      valid_from: '2025-01-01',
      valid_to: '2025-06-30',
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    // A non-overlapping window for the same folded number/sku/scope still hits the case-folded
    // uniqueness index before the overlap guard would even apply.
    const dup = await createLicence(complianceAdminHeaders, {
      sku,
      licence_number: number.toLowerCase(),
      valid_from: '2026-01-01',
      valid_to: '2026-06-30',
    });
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'BIS_LICENCE_EXISTS');
  });

  it('AC 1: sku that does not resolve is ITEM_NOT_FOUND (fail-closed)', async () => {
    const res = await createLicence(complianceAdminHeaders, { sku: `NO-SUCH-SKU-87-${run}` });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ITEM_NOT_FOUND');
  });

  it('AC 1: site_id that does not resolve is LOCATION_NOT_FOUND', async () => {
    const sku = `SKU-87-4-${run}`;
    await createItem(sku);
    const res = await createLicence(complianceAdminHeaders, { sku, site_id: randomUUID() });
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_NOT_FOUND');
  });

  it('AC 1/BSD-3: overlap is rejected BIS_LICENCE_OVERLAP; a sequential non-overlapping licence succeeds', async () => {
    const sku = `SKU-87-5-${run}`;
    await createItem(sku);
    // Live windows: the overlap guard deliberately considers only 'active' rows, so an expired
    // predecessor never blocks a replacement (Story 8.7 code review, D1).
    const first = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2025-01-01',
      valid_to: istDate(200),
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const overlap = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: istDate(100),
      valid_to: istDate(400),
    });
    assert.strictEqual(overlap.status, 409, JSON.stringify(overlap.body));
    assert.strictEqual(overlap.body['error_code'], 'BIS_LICENCE_OVERLAP');

    const sequential = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: istDate(201),
      valid_to: istDate(400),
    });
    assert.strictEqual(sequential.status, 201, JSON.stringify(sequential.body));
  });

  it('AC 1: idempotency-key replay returns 200 with the same event_id', async () => {
    const sku = `SKU-87-6-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2025-01-01',
      valid_to: '2025-12-31',
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const licenceId = (created.body['licence'] as Record<string, unknown>)['licence_id'] as string;
    // A same-window PATCH replay never trips the overlap guard (it excludes its own row), so a
    // replayed idempotency key isolates the replay-detection idiom cleanly.
    const key = `story-8-7-replay-key-${run}`;
    const patchBody = { valid_to: '2025-12-30', idempotency_key: key };
    const replay1 = await makeRequest(
      port,
      'PATCH',
      `/api/v1/compliance/bis-licences/${licenceId}`,
      patchBody,
      complianceAdminHeaders,
    );
    const replay2 = await makeRequest(
      port,
      'PATCH',
      `/api/v1/compliance/bis-licences/${licenceId}`,
      patchBody,
      complianceAdminHeaders,
    );
    assert.strictEqual(replay1.status, 200, JSON.stringify(replay1.body));
    assert.strictEqual(replay2.status, 200, JSON.stringify(replay2.body));
    assert.strictEqual(replay2.body['event_id'], replay1.body['event_id']);
  });

  // -------------------------------------------------------------------------
  // AC 2: expiry sweep and BIS_LICENCE_INVALID end-to-end regression (Task 9.3)
  // -------------------------------------------------------------------------

  it('AC 2: the sweep flags exact stages at day boundaries, is idempotent, catches up, and flips status on expiry', async () => {
    const sku = `SKU-87-7-${run}`;
    await createItem(sku);

    // 91 days out: no stage due.
    const day91 = await createLicence(complianceAdminHeaders, {
      sku,
      valid_to: istDate(91),
      valid_from: '2020-01-01',
    });
    const licence91 = (day91.body['licence'] as Record<string, unknown>)['licence_id'] as string;

    // Both sides of every stage boundary - 61/60 and 31/30 catch an off-by-one that would fire a
    // stage a day early, which the 90/60/30/1/0 set alone cannot see.
    const boundaries: Array<{ offset: number; label: string }> = [
      { offset: 90, label: '90' },
      { offset: 61, label: '61' },
      { offset: 60, label: '60' },
      { offset: 31, label: '31' },
      { offset: 30, label: '30' },
      { offset: 1, label: '1' },
      { offset: 0, label: '0' },
      // Recorded live, then its window is closed below to simulate the passage of a day - a
      // licence RECORDED already-expired is inserted 'expired' and is correctly never swept.
      { offset: 0, label: 'expired' },
    ];
    const licenceIds: Record<string, string> = { '91': licence91 };
    for (const b of boundaries) {
      const boundarySku = `SKU-87-7-${b.label}-${run}`;
      await createItem(boundarySku);
      const created = await createLicence(complianceAdminHeaders, {
        sku: boundarySku,
        valid_to: istDate(b.offset),
        valid_from: '2020-01-01',
      });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      licenceIds[b.label] = (created.body['licence'] as Record<string, unknown>)[
        'licence_id'
      ] as string;
    }

    // The window closes while the row is still 'active', exactly as it would overnight.
    await getAdminPool().query(
      `UPDATE compliance_bis_licence SET valid_to = $2::date WHERE licence_id = $1`,
      [licenceIds['expired']!, istDate(-1)],
    );

    const result1 = await runBisLicenceExpiryCycle();
    assert.strictEqual(result1.cycleFailed, false, 'the cycle must not fail');
    assert.strictEqual(result1.failed, 0);

    // No alert row at all for the 91-day-out licence.
    assert.strictEqual(
      await countRows('compliance_bis_licence_alert', 'licence_id = $1', [licence91]),
      0,
    );

    // Exact stage rows appear.
    assert.deepStrictEqual(await stagesFor(licenceIds['90']!), [90]);
    assert.deepStrictEqual(await stagesFor(licenceIds['61']!), [90], 'the 60 stage is not yet due');
    assert.deepStrictEqual(await stagesFor(licenceIds['60']!), [90, 60]);
    assert.deepStrictEqual(
      await stagesFor(licenceIds['31']!),
      [90, 60],
      'the 30 stage is not yet due',
    );
    assert.deepStrictEqual(await stagesFor(licenceIds['30']!), [90, 60, 30]);
    assert.deepStrictEqual(await stagesFor(licenceIds['1']!), [90, 60, 30]);
    // valid_to = today (offset 0): still covers today, not yet expired, all three stages due.
    assert.deepStrictEqual(await stagesFor(licenceIds['0']!), [90, 60, 30]);
    // valid_to = yesterday: expired. Stage 0 is flagged ALONE - the day-count stages are moot once
    // the window has closed, and emitting them would fire 'Expiring soon' after 'Expired'.
    assert.deepStrictEqual(await stagesFor(licenceIds['expired']!), [0]);

    // Second run: no duplicates (idempotence).
    const result2 = await runBisLicenceExpiryCycle();
    assert.strictEqual(result2.cycleFailed, false);
    assert.deepStrictEqual(await stagesFor(licenceIds['expired']!), [0]);
    assert.strictEqual(
      await countRows('compliance_bis_licence_alert', 'licence_id = $1', [licenceIds['expired']!]),
      1,
    );

    // Expired flip: status becomes 'expired'.
    const expiredLicence = await getAdminPool().query(
      `SELECT status FROM compliance_bis_licence WHERE licence_id = $1`,
      [licenceIds['expired']!],
    );
    assert.strictEqual(expiredLicence.rows[0]!['status'], 'expired');

    // The other boundaries remain 'active'.
    const activeLicence = await getAdminPool().query(
      `SELECT status FROM compliance_bis_licence WHERE licence_id = $1`,
      [licenceIds['30']!],
    );
    assert.strictEqual(activeLicence.rows[0]!['status'], 'active');

    // BSD-5: EXACTLY one notification per licence per cycle, no matter how many stages the ledger
    // caught up on. Asserted on the licences that persisted THREE rows in one cycle - the ones
    // where the most-urgent-stage early return is actually load-bearing. (Asserting this on the
    // expired licence would be vacuous: its ledger holds a single row, so one notification is
    // arithmetic rather than evidence.)
    const notificationsFor = async (licenceId: string): Promise<number> => {
      const r = await getAdminPool().query(
        `SELECT count(*)::int AS n FROM domain_events
          WHERE stream_type = 'notification' AND event_type = 'notification.created'
            AND payload->>'object_id' = $1`,
        [licenceId],
      );
      return r.rows[0]!['n'] as number;
    };

    for (const label of ['30', '1', '0']) {
      assert.deepStrictEqual(
        await stagesFor(licenceIds[label]!),
        [90, 60, 30],
        `licence ${label} caught up on three stages in one cycle`,
      );
      assert.strictEqual(
        await notificationsFor(licenceIds[label]!),
        1,
        `licence ${label}: three ledger rows, exactly one notification (BSD-5)`,
      );
    }
    assert.strictEqual(await notificationsFor(licenceIds['60']!), 1, 'two rows, one notification');
    assert.strictEqual(await notificationsFor(licenceIds['expired']!), 1, 'the flip notifies once');

    // Exact, not a floor: 60 suppresses 1, and 30/1/0 suppress 2 each. A floor of ">= 2" would
    // hold even if suppression counting were broken for three of the four licences.
    assert.strictEqual(
      result1.suppressedStages,
      8,
      'every stage but the most urgent is counted as suppressed',
    );

    // End-to-end regression of Story 8.6: a release attempt for the now-expired BIS-covered sku
    // fails BIS_LICENCE_INVALID through the REAL release route.
    const plan = await planOk({ bis_licence_required: true });
    const bisLicenceRes = await createLicence(complianceAdminHeaders, {
      sku: plan.sku,
      valid_to: istDate(-1),
      valid_from: '2020-01-01',
    });
    assert.strictEqual(bisLicenceRes.status, 201, JSON.stringify(bisLicenceRes.body));
    await runBisLicenceExpiryCycle();
    const held = await releasable(plan);
    const releaseRes = await release(held.taskId);
    assert.strictEqual(releaseRes.status, 409, JSON.stringify(releaseRes.body));
    assert.strictEqual(releaseRes.body['error_code'], 'BIS_LICENCE_INVALID');

    // findValidBisLicence-shaped check: no row is valid either by status or by window.
    const noneValid = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM compliance_bis_licence
        WHERE sku = $1 AND status = 'active' AND valid_from <= $2::date AND valid_to >= $2::date`,
      [plan.sku, istDate(0)],
    );
    assert.strictEqual(noneValid.rows[0]!['n'], 0);
  });

  // -------------------------------------------------------------------------
  // AC 3: label master version control and approval (Task 9.4)
  // -------------------------------------------------------------------------

  it('AC 3: draft creates status draft with NULL approval fields; approval sets fields and supersedes the predecessor', async () => {
    const sku = `SKU-87-8-${run}`;
    await createItem(sku);
    // Segregation of duties: writer2 drafts, the DOA-resolved compliance admin approves.
    const draft1 = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v1' });
    assert.strictEqual(draft1.status, 201, JSON.stringify(draft1.body));
    const label1 = draft1.body['label'] as Record<string, unknown>;
    assert.strictEqual(label1['status'], 'draft');
    assert.strictEqual(label1['approved_by'], null);
    assert.strictEqual(label1['approved_at'], null);
    const label1Id = label1['label_id'] as string;

    const approve1 = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${label1Id}/approve`,
      { idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(approve1.status, 200, JSON.stringify(approve1.body));
    const approvedLabel1 = approve1.body['label'] as Record<string, unknown>;
    assert.strictEqual(approvedLabel1['status'], 'approved');
    assert.strictEqual(approvedLabel1['approved_by'], complianceAdminUserId);
    assert.ok(approvedLabel1['approved_at']);

    // Draft and approve a second version for the same sku: the first flips to superseded, with its
    // approval metadata intact.
    const draft2 = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v2' });
    assert.strictEqual(draft2.status, 201, JSON.stringify(draft2.body));
    const label2Id = (draft2.body['label'] as Record<string, unknown>)['label_id'] as string;
    const approve2 = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${label2Id}/approve`,
      { idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(approve2.status, 200, JSON.stringify(approve2.body));

    const supersededRow = await getAdminPool().query(
      `SELECT status, approved_by, approved_at FROM label_master WHERE label_id = $1`,
      [label1Id],
    );
    assert.strictEqual(supersededRow.rows[0]!['status'], 'superseded');
    assert.strictEqual(supersededRow.rows[0]!['approved_by'], complianceAdminUserId);
    assert.ok(supersededRow.rows[0]!['approved_at'], 'approval metadata stays intact on supersede');

    // uq_label_master_current: exactly one approved row per sku.
    const approvedCount = await countRows('label_master', `sku = $1 AND status = 'approved'`, [
      sku,
    ]);
    assert.strictEqual(approvedCount, 1);
  });

  it('AC 3: duplicate (sku, version) draft is LABEL_VERSION_EXISTS; approving an already-approved row is LABEL_VERSION_NOT_DRAFT', async () => {
    const sku = `SKU-87-9-${run}`;
    await createItem(sku);
    const first = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v1' });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    // uq_label_master_version is case-folded, so 'V1' collides with 'v1'.
    const dup = await draftLabel(complianceWriter2Headers, { sku, label_version: 'V1' });
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'LABEL_VERSION_EXISTS');

    const labelId = (first.body['label'] as Record<string, unknown>)['label_id'] as string;
    const approve = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${labelId}/approve`,
      { idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));
    const reapprove = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${labelId}/approve`,
      { idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(reapprove.status, 409, JSON.stringify(reapprove.body));
    assert.strictEqual(reapprove.body['error_code'], 'LABEL_VERSION_NOT_DRAFT');
  });

  // -------------------------------------------------------------------------
  // AC 4: DOA approval authority (Task 9.5)
  // -------------------------------------------------------------------------

  it('AC 4: an approval attempt by a non-resolved writer is 403 APPROVAL_REQUIRED and audited', async () => {
    const sku = `SKU-87-10-${run}`;
    await createItem(sku);
    const draft = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v1' });
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));
    const labelId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;

    const denied = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${labelId}/approve`,
      { idempotency_key: randomUUID() },
      complianceWriter2Headers,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(denied.body)['resolved_approver_user_id'], complianceAdminUserId);

    const auditRows = await auditCount('APPROVAL_REQUIRED', `details->>'label_id' = $2`, [labelId]);
    assert.ok(auditRows >= 1, 'the rejection is audited');
  });

  it('AC 4: approving with NO DOA entry seeded is APPROVAL_UNRESOLVED', async () => {
    const sku = `SKU-87-11-${run}`;
    await createItem(sku);
    // Delete the DOA entry seeded in before() temporarily to prove the unresolved path, then
    // restore it so subsequent tests keep working.
    const removed = await getAdminPool().query(
      `DELETE FROM doa_registry_entries WHERE transaction_type = 'compliance.label_master_approval' RETURNING entry_id, role, value_min, value_max, active`,
    );
    try {
      const draft = await draftLabel(complianceAdminHeaders, { sku, label_version: 'v1' });
      assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));
      const labelId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/compliance/label-masters/${labelId}/approve`,
        { idempotency_key: randomUUID() },
        complianceAdminHeaders,
      );
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
    } finally {
      for (const row of removed.rows) {
        await getAdminPool().query(
          `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
           VALUES ($1, $2, 'compliance.label_master_approval', $3, $4, $5)`,
          [row['entry_id'], row['role'], row['value_min'], row['value_max'], row['active']],
        );
      }
    }
  });

  // -------------------------------------------------------------------------
  // RBAC arms (Task 9.6)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Code review (Group 4): negative arms for the guards this review minted. Each of these was
  // deletable from the production code with a fully green suite before this block existed.
  // -------------------------------------------------------------------------

  it('code review: a forged expiry event for a stage that is not due is BIS_LICENCE_STAGE_NOT_DUE', async () => {
    const sku = `SKU-87-forge-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2020-01-01',
      valid_to: istDate(300),
    });
    const licenceId = (created.body['licence'] as Record<string, unknown>)['licence_id'] as string;

    // The sweep is the only legitimate producer of this event, so the applier cross-check is
    // reachable only by persisting one directly - which is exactly the threat it exists for: any
    // actor able to write a compliance event could otherwise expire a live licence and block every
    // dependent statutory release.
    await assert.rejects(
      () =>
        persistEvent(
          {
            stream_type: 'compliance',
            stream_id: licenceId,
            event_type: 'compliance.bis_licence_expiry_flagged',
            payload: { licence_id: licenceId, stage_days: 0 },
            metadata: {
              correlation_id: randomUUID(),
              causation_id: null,
              actor: {
                user_id: '00000000-0000-0000-0000-000000000000',
                role: 'system_compliance_licence_expiry',
                location_id: '00000000-0000-0000-0000-000000000000',
              },
              occurred_at: new Date().toISOString(),
            },
          } as never,
          undefined,
        ),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode?: string }).errorCode, 'BIS_LICENCE_STAGE_NOT_DUE');
        return true;
      },
    );

    const row = await getAdminPool().query(
      `SELECT status FROM compliance_bis_licence WHERE licence_id = $1`,
      [licenceId],
    );
    assert.strictEqual(row.rows[0]!['status'], 'active', 'the forged event did not expire it');
    assert.strictEqual(
      await countRows('compliance_bis_licence_alert', 'licence_id = $1', [licenceId]),
      0,
      'and left no ledger row',
    );
  });

  it('code review: a tampered approver on the approval payload is APPROVAL_AUTHORITY_MISMATCH', async () => {
    const sku = `SKU-87-tamper-${run}`;
    await createItem(sku);
    const draft = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v1' });
    const labelId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;

    // BSD-4 has the route capture the resolved approver onto the payload so a rebuild is
    // deterministic. The applier re-derives and compares, so a payload naming someone else - a
    // forged event, or one replayed after the DOA registry changed - must not land.
    await assert.rejects(
      () =>
        persistEvent(
          {
            stream_type: 'compliance',
            stream_id: labelId,
            event_type: 'compliance.label_version_approved',
            payload: {
              label_id: labelId,
              approved_by: complianceAdminUserId,
              doa_entry_id: randomUUID(),
              governing_role: 'compliance_admin',
              delegation_applied: false,
            },
            metadata: {
              correlation_id: randomUUID(),
              causation_id: null,
              actor: {
                user_id: complianceAdminUserId,
                role: 'compliance_admin',
                location_id: siteAId,
              },
              occurred_at: new Date().toISOString(),
            },
          } as never,
          undefined,
        ),
      (err: unknown) => {
        assert.strictEqual(
          (err as { errorCode?: string }).errorCode,
          'APPROVAL_AUTHORITY_MISMATCH',
        );
        return true;
      },
    );

    const row = await getAdminPool().query(
      `SELECT status, approved_by FROM label_master WHERE label_id = $1`,
      [labelId],
    );
    assert.strictEqual(row.rows[0]!['status'], 'draft');
    assert.strictEqual(row.rows[0]!['approved_by'], null);
  });

  it('code review: a client-declared server-derived field is COMPLIANCE_DERIVATION_MISMATCH', async () => {
    const sku = `SKU-87-derived-${run}`;
    await createItem(sku);
    await assert.rejects(
      () =>
        persistEvent(
          {
            stream_type: 'compliance',
            stream_id: randomUUID(),
            event_type: 'compliance.bis_licence_recorded',
            payload: {
              licence_id: randomUUID(),
              licence_number: `CM/L-87-derived-${run}`,
              licence_type: 'cml',
              sku,
              site_id: null,
              valid_from: '2020-01-01',
              valid_to: istDate(300),
              // status is derived from the window by the applier and must never be declared.
              status: 'active',
            },
            metadata: {
              correlation_id: randomUUID(),
              causation_id: null,
              actor: {
                user_id: complianceAdminUserId,
                role: 'compliance_admin',
                location_id: siteAId,
              },
              occurred_at: new Date().toISOString(),
            },
          } as never,
          undefined,
        ),
      (err: unknown) => {
        assert.strictEqual(
          (err as { errorCode?: string }).errorCode,
          'COMPLIANCE_DERIVATION_MISMATCH',
        );
        return true;
      },
    );
  });

  it('code review: PATCHing an unknown licence is BIS_LICENCE_NOT_FOUND, and GET by id 404s', async () => {
    const unknown = randomUUID();
    const patched = await makeRequest(
      port,
      'PATCH',
      `/api/v1/compliance/bis-licences/${unknown}`,
      { valid_to: istDate(90), idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(patched.status, 404, JSON.stringify(patched.body));
    assert.strictEqual(patched.body['error_code'], 'BIS_LICENCE_NOT_FOUND');

    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/compliance/bis-licences/${unknown}`,
      undefined,
      complianceAdminHeaders,
    );
    assert.strictEqual(got.status, 404, JSON.stringify(got.body));
    assert.strictEqual(got.body['error_code'], 'BIS_LICENCE_NOT_FOUND');

    const label = await makeRequest(
      port,
      'GET',
      `/api/v1/compliance/label-masters/${randomUUID()}`,
      undefined,
      complianceAdminHeaders,
    );
    assert.strictEqual(label.status, 404, JSON.stringify(label.body));
    assert.strictEqual(label.body['error_code'], 'LABEL_MASTER_NOT_FOUND');

    const malformed = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/bis-licences/not-a-uuid',
      undefined,
      complianceAdminHeaders,
    );
    assert.strictEqual(malformed.status, 400, JSON.stringify(malformed.body));
    assert.strictEqual(malformed.body['error_code'], 'INVALID_PARAMS');
  });

  it('code review: the get-by-id routes round-trip what the collection routes list', async () => {
    const sku = `SKU-87-getbyid-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2020-01-01',
      valid_to: istDate(250),
    });
    const licenceId = (created.body['licence'] as Record<string, unknown>)['licence_id'] as string;
    const gotLicence = await makeRequest(
      port,
      'GET',
      `/api/v1/compliance/bis-licences/${licenceId}`,
      undefined,
      complianceReaderHeaders,
    );
    assert.strictEqual(gotLicence.status, 200, JSON.stringify(gotLicence.body));
    const licence = gotLicence.body['licence'] as Record<string, unknown>;
    assert.strictEqual(licence['licence_id'], licenceId);
    assert.strictEqual(licence['sku'], sku);
    assert.strictEqual(licence['status'], 'active');

    const draft = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v1' });
    const labelId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;
    const gotLabel = await makeRequest(
      port,
      'GET',
      `/api/v1/compliance/label-masters/${labelId}`,
      undefined,
      complianceReaderHeaders,
    );
    assert.strictEqual(gotLabel.status, 200, JSON.stringify(gotLabel.body));
    assert.strictEqual((gotLabel.body['label'] as Record<string, unknown>)['label_id'], labelId);

    const listedLabels = await makeRequest(
      port,
      'GET',
      `/api/v1/compliance/label-masters?sku=${sku}`,
      undefined,
      complianceReaderHeaders,
    );
    assert.strictEqual(listedLabels.status, 200, JSON.stringify(listedLabels.body));
    assert.strictEqual((listedLabels.body['labels'] as unknown[]).length, 1);
  });

  it('code review: fields the route does not accept are rejected, never silently dropped', async () => {
    const sku = `SKU-87-unaccepted-${run}`;
    await createItem(sku);
    const withStatus = await makeRequest(
      port,
      'POST',
      '/api/v1/compliance/bis-licences',
      {
        licence_number: `CM/L-87-unacc-${run}`,
        licence_type: 'cml',
        sku,
        valid_from: '2020-01-01',
        valid_to: istDate(300),
        status: 'active',
        idempotency_key: randomUUID(),
      },
      complianceAdminHeaders,
    );
    assert.strictEqual(withStatus.status, 400, JSON.stringify(withStatus.body));
    assert.strictEqual(detailsOf(withStatus.body)['field'], 'status');

    const draftWithApproval = await makeRequest(
      port,
      'POST',
      '/api/v1/compliance/label-masters',
      { sku, label_version: 'v9', approved_by: randomUUID(), idempotency_key: randomUUID() },
      complianceWriter2Headers,
    );
    assert.strictEqual(draftWithApproval.status, 400, JSON.stringify(draftWithApproval.body));
    assert.strictEqual(detailsOf(draftWithApproval.body)['field'], 'approved_by');

    const draft = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v1' });
    const labelId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;
    const approveWithAuthority = await makeRequest(
      port,
      'POST',
      `/api/v1/compliance/label-masters/${labelId}/approve`,
      { doa_entry_id: randomUUID(), idempotency_key: randomUUID() },
      complianceAdminHeaders,
    );
    assert.strictEqual(approveWithAuthority.status, 400, JSON.stringify(approveWithAuthority.body));
    assert.strictEqual(detailsOf(approveWithAuthority.body)['field'], 'doa_entry_id');
  });

  it('code review D1: an expired licence does not block an overlapping replacement', async () => {
    const sku = `SKU-87-d1-${run}`;
    await createItem(sku);
    // Recorded with a closed window, so it is stored 'expired'.
    const expired = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2020-01-01',
      valid_to: istDate(-1),
    });
    assert.strictEqual(expired.status, 201, JSON.stringify(expired.body));
    assert.strictEqual((expired.body['licence'] as Record<string, unknown>)['status'], 'expired');

    // A replacement whose window overlaps the expired one is legitimate: the overlap guard
    // considers only active rows, so renewal-by-replacement is not blocked forever.
    const replacement = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2020-01-01',
      valid_to: istDate(300),
    });
    assert.strictEqual(
      replacement.status,
      201,
      'an expired predecessor must not block an overlapping replacement',
    );

    // And the live one is what covers a release today.
    const resolved = await findValidBisLicence(sku, siteAId, istDate(0));
    assert.ok(resolved);
    assert.strictEqual(
      resolved.licence_id,
      (replacement.body['licence'] as Record<string, unknown>)['licence_id'],
    );
  });

  it('code review D4: a duplicate conflict reports the conflicting row identity', async () => {
    const sku = `SKU-87-d4-${run}`;
    await createItem(sku);
    const licenceNumber = `CM/L-87-d4-${run}`;
    const first = await createLicence(complianceAdminHeaders, {
      sku,
      licence_number: licenceNumber,
      valid_from: '2020-01-01',
      valid_to: istDate(300),
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstId = (first.body['licence'] as Record<string, unknown>)['licence_id'] as string;

    // A NON-overlapping window, so the overlap guard stands aside and the scope-uniqueness index
    // is what rejects: same licence number, same sku, same site, differing only by case.
    const dup = await createLicence(complianceAdminHeaders, {
      sku,
      licence_number: licenceNumber.toLowerCase(),
      valid_from: istDate(301),
      valid_to: istDate(600),
    });
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'BIS_LICENCE_EXISTS');
    // The resolver must name the row that already holds the grain, not echo the submitted values.
    assert.strictEqual(
      detailsOf(dup.body)['existing_licence_id'],
      firstId,
      'the conflict names the row that already holds the scope',
    );

    // The label path carries the same contract.
    const draft = await draftLabel(complianceWriter2Headers, { sku, label_version: 'v1' });
    const draftId = (draft.body['label'] as Record<string, unknown>)['label_id'] as string;
    const dupLabel = await draftLabel(complianceWriter2Headers, { sku, label_version: 'V1' });
    assert.strictEqual(dupLabel.status, 409, JSON.stringify(dupLabel.body));
    assert.strictEqual(dupLabel.body['error_code'], 'LABEL_VERSION_EXISTS');
    assert.strictEqual(detailsOf(dupLabel.body)['existing_label_id'], draftId);
  });

  it('code review: a second overlapping sweep tick stands down on the advisory lock', async () => {
    const blocker = await getPool().connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [8707]);
      const contended = await runBisLicenceExpiryCycle();
      assert.strictEqual(contended.skippedLocked, true, 'the second tick must not run');
      assert.strictEqual(contended.cycleFailed, false, 'and it is not an error');
      assert.strictEqual(contended.flagged, 0);
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
    }

    // With the lock released the sweep runs normally again.
    const normal = await runBisLicenceExpiryCycle();
    assert.strictEqual(normal.skippedLocked, false);
  });

  it('RBAC: module compliance denied for an unassigned user (MODULE_ACCESS_DENIED)', async () => {
    const res = await createLicence(deniedHeaders, { sku: `SKU-87-12-${run}` });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('RBAC: read scope cannot write (FUNCTION_ACCESS_DENIED)', async () => {
    const res = await createLicence(complianceReaderHeaders, { sku: `SKU-87-13-${run}` });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('RBAC: read scope CAN list and get', async () => {
    const sku = `SKU-87-rbacget-${run}`;
    await createItem(sku);
    const created = await createLicence(complianceAdminHeaders, {
      sku,
      valid_from: '2020-01-01',
      valid_to: istDate(120),
    });
    const licenceId = (created.body['licence'] as Record<string, unknown>)['licence_id'] as string;

    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/bis-licences',
      undefined,
      complianceReaderHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));

    // ...and the "get" the title promises, on both registers.
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/compliance/bis-licences/${licenceId}`,
      undefined,
      complianceReaderHeaders,
    );
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.strictEqual((got.body['licence'] as Record<string, unknown>)['licence_id'], licenceId);

    const labels = await makeRequest(
      port,
      'GET',
      '/api/v1/compliance/label-masters',
      undefined,
      complianceReaderHeaders,
    );
    assert.strictEqual(labels.status, 200, JSON.stringify(labels.body));
  });
});

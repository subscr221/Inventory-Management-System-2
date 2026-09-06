import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 8.6 Statutory Release Blocks and Quality Reporting (FR-Q-11, FR-Q-13, FR-Q-14). Real
 * PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run
 * serially; every identifier is run-scoped.
 *
 * The harness scaffolding (planOk, heldLot, inspected, accepted, release) is a deliberate local
 * re-implementation of the story-8-4 closures, which are not exported (the same Debug Log note
 * that file carries about story-8-3). The register tables have NO write routes in this story
 * (Binding Scope Decision 1), so licence and label rows are seeded through the admin pool.
 *
 * Dashboard expectations are computed INDEPENDENTLY from the fixtures this file creates (2
 * accepts + 1 coded reject at the dedicated site C = 66.67% FPY), never from the query under
 * test. The ambient test config runs `enforce` (the default), which is what the block tests need;
 * the `dormant` branch is proven by child-process config loads in
 * test/unit/qc-statutory-blocks-config.test.ts plus the parameterised predicates.
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

function metricOf(body: Record<string, unknown>, name: string): Record<string, unknown> {
  const metrics = body['metrics'] as Record<string, unknown>;
  assert.ok(metrics && typeof metrics === 'object', `response carries no metrics object`);
  const metric = metrics[name];
  assert.ok(metric && typeof metric === 'object', `metrics.${name} missing`);
  return metric as Record<string, unknown>;
}

function seriesOf(metric: Record<string, unknown>): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(metric['series']), 'metric carries no series array');
  return metric['series'] as Array<Record<string, unknown>>;
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

describe('Story 8.6 Statutory Release Blocks and Quality Reporting', () => {
  let server: Server;
  let port: number;

  let inspectorUserId: string;
  let inspectorHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;
  let qcHeadUserId: string;
  let qcHeadHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  /** `qc` read scoped to the empty site D only - the AC 6 no-data caller. */
  let emptyReaderHeaders: Record<string, string>;
  /** `qc` read scoped to the dashboard site C only - the AC 7 narrowing caller. */
  let siteCReaderHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let siteBId: string;
  let siteCId: string;
  let binC1Id: string;
  let siteDId: string;
  let componentItemId: string;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function createItem(sku: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku,
        description: `Story 8.6 item ${sku}`,
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

  /** Admin-pool seeded register row: the table has no write routes in this story (Decision 1). */
  async function seedLicence(
    sku: string,
    overrides: {
      number?: string;
      siteId?: string | null;
      validFrom?: string;
      validTo?: string;
      type?: 'cml' | 'r_number';
    } = {},
  ): Promise<string> {
    const number = overrides.number ?? `CM/L-86-${run}-${randomUUID().slice(0, 6)}`;
    await getAdminPool().query(
      `INSERT INTO compliance_bis_licence
         (licence_id, licence_number, licence_type, sku, site_id, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date)`,
      [
        randomUUID(),
        number,
        overrides.type ?? 'cml',
        sku,
        overrides.siteId ?? null,
        overrides.validFrom ?? '2020-01-01',
        overrides.validTo ?? '2099-12-31',
      ],
    );
    return number;
  }

  /** Admin-pool seeded label row; the approval pairing biconditional shapes the columns. */
  async function seedLabel(
    sku: string,
    status: 'draft' | 'approved' | 'superseded',
    version: string = 'v1',
  ): Promise<string> {
    const labelId = randomUUID();
    const approved = status === 'approved' || status === 'superseded';
    await getAdminPool().query(
      `INSERT INTO label_master (label_id, sku, label_version, status, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        labelId,
        sku,
        version,
        status,
        approved ? qcHeadUserId : null,
        approved ? new Date().toISOString() : null,
      ],
    );
    return labelId;
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
    const sku = `FG-8-6-${run}-${planCounter}`;
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
    const lotNumber = `FG-LOT-8-6-${run}-${lotCounter}`;
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

  /** One lot driven to an accept disposition; signed by the approver (NFR-SEC-05). */
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
      { disposition: 'accept', justification: 'Story 8.6 accept decision' },
      approverHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return held;
  }

  /** Accepted lot with its retention sample logged - the state a release attempt starts from. */
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

  async function dashboard(
    headers: Record<string, string>,
    query: string = '',
  ): Promise<HttpResult> {
    return makeRequest(port, 'GET', `/api/v1/qc/reports/dashboard${query}`, undefined, headers);
  }

  async function auditCount(errorCode: string, taskId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE error_code = $1 AND details->>'task_id' = $2`,
      [errorCode, taskId],
    );
    return r.rows[0]!['n'] as number;
  }

  async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE compliance_bis_licence, label_master, qc_capa, qc_quality_hold, qc_retention_sample, qc_batch_release, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-6-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-6-${run}`, siteAId, siteAId);
    siteBId = await seedLocation('site', `SITE-B-8-6-${run}`, null, null);
    siteCId = await seedLocation('site', `SITE-C-8-6-${run}`, null, null);
    binC1Id = await seedLocation('bin', `BIN-C1-8-6-${run}`, siteCId, siteCId);
    siteDId = await seedLocation('site', `SITE-D-8-6-${run}`, null, null);
    assert.ok(siteBId);

    qcHeadUserId = await provisionUser(port, `qc-head-8-6-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-6-${run}@example.com`);

    inspectorUserId = await provisionUser(port, `qc-inspector-8-6-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteAId },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteAId },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-8-6-${run}@example.com`);
    assert.ok(inspectorUserId);

    await provisionUser(port, `qc-approver-8-6-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `qc-approver-8-6-${run}@example.com`);

    await provisionUser(port, `engineer-8-6-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-6-${run}@example.com`);

    await provisionUser(port, `dash-empty-8-6-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteDId },
    ]);
    emptyReaderHeaders = await authFor(port, `dash-empty-8-6-${run}@example.com`);

    await provisionUser(port, `dash-site-c-8-6-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteCId },
    ]);
    siteCReaderHeaders = await authFor(port, `dash-site-c-8-6-${run}@example.com`);

    for (const transactionType of ['qc.inspection_plan_approval', 'qc.conditional_release']) {
      await getPool().query(
        `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
         VALUES ($1, 'qc_head', $2, NULL, NULL, true)`,
        [randomUUID(), transactionType],
      );
    }

    componentItemId = await createItem(`CMP-8-6-${run}`, { lot_controlled: false });
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 5/AC 6: dashboard params and the first-class empty shape (before any seeding)
  // -------------------------------------------------------------------------

  it('AC 5: malformed from/to and an inverted window are 400 INVALID_PARAMS', async () => {
    assert.strictEqual(config.quality.statutoryReleaseBlocks, 'enforce');
    for (const query of ['?from=2026-13-01', '?to=26-01-01', '?from=notadate']) {
      const res = await dashboard(qcHeadHeaders, query);
      assert.strictEqual(res.status, 400, `${query}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
    const inverted = await dashboard(qcHeadHeaders, '?from=2026-02-01&to=2026-01-01');
    assert.strictEqual(inverted.status, 400);
    assert.strictEqual(inverted.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC 6: an empty period and an empty site scope return no-data shapes, never fabricated ratios', async () => {
    const res = await dashboard(emptyReaderHeaders, '?from=2000-01-01&to=2000-01-31');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['coverage'], 'live_audit_log_only');
    const period = res.body['period'] as Record<string, unknown>;
    assert.strictEqual(period['from'], '2000-01-01');
    assert.strictEqual(period['to'], '2000-01-31');
    for (const name of [
      'first_pass_yield',
      'rejection_rate_by_product',
      'rejection_rate_by_defect_code',
      'ncr_aging',
      'capa_aging',
      'conditional_releases',
      'calibration_lockouts',
    ]) {
      const metric = metricOf(res.body, name);
      assert.strictEqual(metric['state'], 'no_data', `${name} should be no_data`);
      assert.deepStrictEqual(seriesOf(metric), [], `${name} series should be empty`);
    }
    const fpy = metricOf(res.body, 'first_pass_yield');
    // Zero denominator is REPORTED as no-data with a null yield - never 0% and never 100%.
    assert.strictEqual(fpy['lots_dispositioned'], 0);
    assert.strictEqual(fpy['lots_accepted'], 0);
    assert.strictEqual(fpy['yield_percent'], null);
  });

  // -------------------------------------------------------------------------
  // AC 1/AC 2: the BIS licence block (FR-Q-11)
  // -------------------------------------------------------------------------

  it('AC 1: a BIS-covered product with no register row is rejected BIS_LICENCE_INVALID and audited', async () => {
    const plan = await planOk({ bis_licence_required: true });
    const held = await releasable(plan);
    const res = await release(held.taskId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'BIS_LICENCE_INVALID');
    assert.strictEqual(detailsOf(res.body)['sku'], plan.sku);
    // The refused release left no release record and wrote the statutory audit row.
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);
    assert.ok((await auditCount('BIS_LICENCE_INVALID', held.taskId)) >= 1);
  });

  it('AC 2: a valid licence releases and stamps the REGISTER number on the release record', async () => {
    const plan = await planOk({ bis_licence_required: true });
    const licenceNumber = await seedLicence(plan.sku);
    const held = await releasable(plan);
    const res = await release(held.taskId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = res.body['release'] as Record<string, unknown>;
    assert.strictEqual(row['document_kind'], 'coc');
    assert.strictEqual(row['bis_licence_number'], licenceNumber);
    const persisted = await getAdminPool().query(
      `SELECT bis_licence_number FROM qc_batch_release WHERE lot_id = $1`,
      [held.lotId],
    );
    assert.strictEqual(persisted.rows[0]!['bis_licence_number'], licenceNumber);
  });

  it('AC 1: validity is inclusive of valid_to and rejects an expired or not-yet-valid window', async () => {
    // Boundary 1: valid_to = asOf (today IST) still covers the release.
    const planEdge = await planOk({ bis_licence_required: true });
    await seedLicence(planEdge.sku, { validTo: istDate(0) });
    const heldEdge = await releasable(planEdge);
    const onEdge = await release(heldEdge.taskId);
    assert.strictEqual(onEdge.status, 201, JSON.stringify(onEdge.body));

    // Boundary 2: valid_to = asOf - 1 day (expired yesterday) rejects.
    const planExpired = await planOk({ bis_licence_required: true });
    await seedLicence(planExpired.sku, { validTo: istDate(-1) });
    const heldExpired = await releasable(planExpired);
    const expired = await release(heldExpired.taskId);
    assert.strictEqual(expired.status, 409, JSON.stringify(expired.body));
    assert.strictEqual(expired.body['error_code'], 'BIS_LICENCE_INVALID');

    // Boundary 3: valid_from = asOf + 1 day (starts tomorrow) rejects.
    const planFuture = await planOk({ bis_licence_required: true });
    await seedLicence(planFuture.sku, { validFrom: istDate(1), validTo: istDate(365) });
    const heldFuture = await releasable(planFuture);
    const future = await release(heldFuture.taskId);
    assert.strictEqual(future.status, 409, JSON.stringify(future.body));
    assert.strictEqual(future.body['error_code'], 'BIS_LICENCE_INVALID');
  });

  it('Decision 6: a site-specific row wins over a global row; a foreign-site row does not cover', async () => {
    // Both a global and a site-A-specific licence are valid: the release at site A records the
    // SITE-SPECIFIC number.
    const plan = await planOk({ bis_licence_required: true });
    await seedLicence(plan.sku, { number: `GLOBAL-86-${run}` });
    await seedLicence(plan.sku, { number: `SITE-A-86-${run}`, siteId: siteAId });
    const held = await releasable(plan);
    const res = await release(held.taskId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(
      (res.body['release'] as Record<string, unknown>)['bis_licence_number'],
      `SITE-A-86-${run}`,
    );

    // A licence scoped to site B only does NOT cover a site-A release.
    const planForeign = await planOk({ bis_licence_required: true });
    await seedLicence(planForeign.sku, { siteId: siteBId });
    const heldForeign = await releasable(planForeign);
    const foreign = await release(heldForeign.taskId);
    assert.strictEqual(foreign.status, 409, JSON.stringify(foreign.body));
    assert.strictEqual(foreign.body['error_code'], 'BIS_LICENCE_INVALID');
  });

  // -------------------------------------------------------------------------
  // AC 3: the Legal Metrology label block (FR-Q-14)
  // -------------------------------------------------------------------------

  it('AC 3: a Legal Metrology item with no current approved label is rejected LABEL_VERSION_MISSING and audited, then releases once approved', async () => {
    const plan = await planOk({ legal_metrology_required: true });
    const held = await releasable(plan);

    // No label row at all: rejected and audited.
    const missing = await release(held.taskId);
    assert.strictEqual(missing.status, 409, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'LABEL_VERSION_MISSING');
    assert.ok((await auditCount('LABEL_VERSION_MISSING', held.taskId)) >= 1);

    // A DRAFT label is not a current approved version: still rejected.
    await seedLabel(plan.sku, 'draft');
    const draftOnly = await release(held.taskId);
    assert.strictEqual(draftOnly.status, 409, JSON.stringify(draftOnly.body));
    assert.strictEqual(draftOnly.body['error_code'], 'LABEL_VERSION_MISSING');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);

    // An approved, version-controlled label lifts the block.
    await seedLabel(plan.sku, 'approved', 'v2');
    const ok = await release(held.taskId);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    // A non-BIS Legal Metrology item still gets the CoA and a null licence number.
    const row = ok.body['release'] as Record<string, unknown>;
    assert.strictEqual(row['document_kind'], 'coa');
    assert.strictEqual(row['bis_licence_number'], null);
  });

  it('Decision 8: uq_label_master_current admits exactly one approved row per sku', async () => {
    const sku = `LBL-DUP-8-6-${run}`;
    await seedLabel(sku, 'approved', 'v1');
    await assert.rejects(
      () => seedLabel(sku, 'approved', 'v2'),
      /uq_label_master_current/,
      'a second approved label row must violate the partial unique index',
    );
  });

  // -------------------------------------------------------------------------
  // Decision 9: the optional reject-path defect code
  // -------------------------------------------------------------------------

  it('Decision 9: an unknown reject defect_code is 422 DEFECT_CODE_UNKNOWN; one on an accept is 400', async () => {
    const plan = await planOk();
    const held = await inspected(plan);
    const unknown = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/disposition`,
      { disposition: 'reject', justification: 'coded reject', defect_code: 'NOT_A_CODE' },
      approverHeaders,
    );
    assert.strictEqual(unknown.status, 422, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'DEFECT_CODE_UNKNOWN');

    const onAccept = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/disposition`,
      { disposition: 'accept', justification: 'accept with code', defect_code: 'DIMENSIONAL' },
      approverHeaders,
    );
    assert.strictEqual(onAccept.status, 400, JSON.stringify(onAccept.body));
    assert.strictEqual(onAccept.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 5/AC 7: the dashboard over independently seeded site-C fixtures
  // -------------------------------------------------------------------------

  /** Site-C fixture state shared by the dashboard tests below. */
  let codedRejectHeld: Held;
  let codedRejectNcrId: string;
  let acceptedC1: Held;
  let seededCapaId: string;

  it('AC 5: seeding site C - two accepts and one DIMENSIONAL-coded reject', async () => {
    const planC1 = await planOk();
    const planC2 = await planOk();
    // Two accepted lots of C1 and one coded reject of C2, all at the dedicated site C so the
    // site-C reader's dashboard reflects EXACTLY these fixtures and nothing else in this file.
    acceptedC1 = await accepted(planC1, binC1Id, siteCId, qcHeadHeaders);
    await accepted(planC1, binC1Id, siteCId, qcHeadHeaders);
    codedRejectHeld = await inspected(planC2, '10.000000', binC1Id, siteCId, qcHeadHeaders);
    const rejectRes = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${codedRejectHeld.taskId}/disposition`,
      { disposition: 'reject', justification: 'coded reject', defect_code: 'DIMENSIONAL' },
      approverHeaders,
    );
    assert.strictEqual(rejectRes.status, 201, JSON.stringify(rejectRes.body));
    // The disposition-origin NCR now carries the optional code (Decision 9).
    const ncr = await getAdminPool().query(
      `SELECT ncr_id, origin, defect_code FROM qc_ncr WHERE lot_id = $1`,
      [codedRejectHeld.lotId],
    );
    assert.strictEqual(ncr.rows.length, 1);
    assert.strictEqual(ncr.rows[0]!['origin'], 'disposition');
    assert.strictEqual(ncr.rows[0]!['defect_code'], 'DIMENSIONAL');
    codedRejectNcrId = ncr.rows[0]!['ncr_id'] as string;

    // A CAPA opened 45 days ago and due yesterday, seeded directly (the CAPA routes are Story
    // 8.5's surface; the dashboard only READS the projection). Independently known expectation:
    // open 1, overdue 1, bucket 31-60.
    seededCapaId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO qc_capa (capa_id, capa_number, sku, defect_code, title, owner_user_id, due_on,
                            status, opened_by, opened_at, source_event_id)
       VALUES ($1, $2, $3, 'DIMENSIONAL', 'Aging fixture', $4, $5::date, 'open', $4, $6, $7)`,
      [
        seededCapaId,
        `CAPA-86-${run}`,
        codedRejectHeld.plan.sku,
        qcHeadUserId,
        istDate(-1),
        new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
        randomUUID(),
      ],
    );

    // One calibration-lockout audit row at site C (Decision 12: the metric reads audit_log; the
    // Story 8.2 lockout rows stamp the task's site into location_id).
    await getAdminPool().query(
      `INSERT INTO audit_log (trace_id, user_id, role, location_id, endpoint, method, http_status, error_code, details)
       VALUES ($1, $2, 'qc_inspector', $3, '/api/v1/qc/tasks/x/results', 'POST', 423, 'CALIBRATION_LOCKOUT', $4::jsonb)`,
      [
        randomUUID(),
        qcHeadUserId,
        siteCId,
        JSON.stringify({ task_id: codedRejectHeld.taskId, site_id: siteCId }),
      ],
    );
  });

  it('AC 5: the site-C dashboard reports the independently computed metric values', async () => {
    const res = await dashboard(siteCReaderHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['coverage'], 'live_audit_log_only');

    // FPY: 2 accepts of 3 dispositions = 66.67 (computed here from the fixture plan, not from
    // the query under test).
    const fpy = metricOf(res.body, 'first_pass_yield');
    assert.strictEqual(fpy['state'], 'ok');
    assert.strictEqual(fpy['lots_dispositioned'], 3);
    assert.strictEqual(fpy['lots_accepted'], 2);
    assert.strictEqual(fpy['yield_percent'], '66.67');
    assert.strictEqual(seriesOf(fpy).length, 3);
    for (const row of seriesOf(fpy)) {
      assert.strictEqual(row['site_id'], siteCId);
      assert.ok(row['disposition_id'], 'drill-through carries disposition_id');
    }

    // Rejection by product: C1 sku 0/2, C2 sku 1/1.
    const byProduct = metricOf(res.body, 'rejection_rate_by_product');
    assert.strictEqual(byProduct['state'], 'ok');
    const groups = byProduct['by_product'] as Array<Record<string, unknown>>;
    const c2 = groups.find((g) => g['sku'] === codedRejectHeld.plan.sku);
    assert.ok(c2, 'the rejected sku appears in by_product');
    assert.strictEqual(c2['dispositioned'], 1);
    assert.strictEqual(c2['rejected'], 1);
    assert.strictEqual(c2['rejection_rate_percent'], '100.00');
    const c1 = groups.find((g) => g['sku'] === acceptedC1.plan.sku);
    assert.ok(c1, 'the accepted sku appears in by_product');
    assert.strictEqual(c1['dispositioned'], 2);
    assert.strictEqual(c1['rejected'], 0);
    assert.strictEqual(c1['rejection_rate_percent'], '0.00');

    // Rejection by defect code: exactly the one coded NCR, bucketed under its code.
    const byDefect = metricOf(res.body, 'rejection_rate_by_defect_code');
    assert.strictEqual(byDefect['state'], 'ok');
    assert.deepStrictEqual(byDefect['by_defect_code'], [
      { defect_code: 'DIMENSIONAL', ncr_count: 1 },
    ]);
    assert.strictEqual(seriesOf(byDefect)[0]!['ncr_id'], codedRejectNcrId);

    // NCR aging: the one open NCR, freshly raised, in the 0-30 bucket.
    const ncrAging = metricOf(res.body, 'ncr_aging');
    assert.strictEqual(ncrAging['state'], 'ok');
    assert.strictEqual(ncrAging['open_count'], 1);
    assert.deepStrictEqual(ncrAging['buckets'], { '0-30': 1, '31-60': 0, '61-90': 0, '90+': 0 });

    // CAPA aging: the seeded 45-day-old, due-yesterday CAPA - open 1, overdue 1, bucket 31-60.
    const capaAging = metricOf(res.body, 'capa_aging');
    assert.strictEqual(capaAging['state'], 'ok');
    assert.strictEqual(capaAging['open_count'], 1);
    assert.strictEqual(capaAging['overdue_count'], 1);
    assert.deepStrictEqual(capaAging['buckets'], { '0-30': 0, '31-60': 1, '61-90': 0, '90+': 0 });
    assert.strictEqual(seriesOf(capaAging)[0]!['capa_id'], seededCapaId);

    // Conditional releases: none seeded at site C - a first-class zero, not an error.
    const conditional = metricOf(res.body, 'conditional_releases');
    assert.strictEqual(conditional['state'], 'no_data');
    assert.strictEqual(conditional['total'], 0);

    // Calibration lockouts: the one seeded site-C audit row, with its declared coverage caveat.
    const lockouts = metricOf(res.body, 'calibration_lockouts');
    assert.strictEqual(lockouts['state'], 'ok');
    assert.strictEqual(lockouts['lockout_count'], 1);
    assert.strictEqual(lockouts['coverage'], 'live_audit_log_only');
    assert.ok(seriesOf(lockouts)[0]!['log_id'], 'lockout drill-through carries log_id');
  });

  it('AC 7: a site-A-scoped caller sees NO site-C rows, and vice versa', async () => {
    // The inspector reads site A only: the site-C fixtures must be invisible.
    const siteARes = await dashboard(inspectorHeaders);
    assert.strictEqual(siteARes.status, 200, JSON.stringify(siteARes.body));
    const byDefectA = metricOf(siteARes.body, 'rejection_rate_by_defect_code');
    for (const row of seriesOf(byDefectA)) {
      assert.notStrictEqual(row['ncr_id'], codedRejectNcrId, 'site-C NCR leaked into site-A view');
      assert.notStrictEqual(row['site_id'], siteCId);
    }
    for (const row of seriesOf(metricOf(siteARes.body, 'first_pass_yield'))) {
      assert.notStrictEqual(row['site_id'], siteCId);
    }
    const lockoutsA = metricOf(siteARes.body, 'calibration_lockouts');
    assert.strictEqual(lockoutsA['lockout_count'], 0, 'site-C lockout leaked into site-A view');

    // And the site-C reader sees none of the site-A statutory-block activity.
    const siteCRes = await dashboard(siteCReaderHeaders);
    for (const row of seriesOf(metricOf(siteCRes.body, 'first_pass_yield'))) {
      assert.strictEqual(row['site_id'], siteCId);
    }
  });

  it('AC 5: drill-through ids resolve through the existing GET routes', async () => {
    // The NCR id from the by-defect-code series resolves via GET /api/v1/qc/ncrs/:ncrId.
    const ncrRes = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/ncrs/${codedRejectNcrId}`,
      undefined,
      siteCReaderHeaders,
    );
    assert.strictEqual(ncrRes.status, 200, JSON.stringify(ncrRes.body));
    assert.strictEqual(
      (ncrRes.body['ncr'] as Record<string, unknown>)['defect_code'],
      'DIMENSIONAL',
    );

    // The disposition drill-through resolves via the task's disposition read.
    const dispRes = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${acceptedC1.taskId}/disposition`,
      undefined,
      siteCReaderHeaders,
    );
    assert.strictEqual(dispRes.status, 200, JSON.stringify(dispRes.body));

    // The CAPA drill-through resolves via GET /api/v1/qc/capas/:capaId.
    const capaRes = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/capas/${seededCapaId}`,
      undefined,
      siteCReaderHeaders,
    );
    assert.strictEqual(capaRes.status, 200, JSON.stringify(capaRes.body));
  });
});

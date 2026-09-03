import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { assertQcGateAllows } from '../../src/compliance/quality.js';
import { validateLotForIssueAllocate } from '../../src/compliance/lot-serial-validation.js';
import { applyDispatchShippingDocumentsGeneratedProjection } from '../../src/compliance/dispatch.js';
import { AppError } from '../../src/middleware/error.js';

/**
 * Story 8.5 Quality Holds and Recall Trace (FR-Q-09, FR-Q-10). Real PostgreSQL, the real
 * production router, SCIM provisioning and dev-token auth. Dedicated routes carry the ordinary
 * behaviour; direct POST /api/v1/events carries the forgery and derivation proofs; the edge upload
 * route carries the central-only and AC2 replay proofs. The dispatch enforcement path is exercised
 * by calling its applier directly against seeded packing fixtures inside a rolled-back
 * transaction, exactly the surface the production event path invokes.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DEVICE_ID = `edge-8-5-${run}`;
const SEED_CODES = [
  'DIMENSIONAL',
  'SURFACE_FINISH',
  'MATERIAL_NONCONFORMITY',
  'CONTAMINATION',
  'ASSEMBLY',
  'FUNCTIONAL',
  'MARKING_LABELLING',
  'PACKAGING',
  'CORROSION',
  'DOCUMENTATION',
];

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

describe('Story 8.5 Quality Holds and Recall Trace', () => {
  let server: Server;
  let port: number;

  let qcHeadUserId: string;
  let qcHeadHeaders: Record<string, string>;
  let approverUserId: string;
  let approverHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let engineerUserId: string;
  let engineerHeaders: Record<string, string>;
  let qualityHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let siteBId: string;
  let binB1Id: string;
  let componentItemId: string;

  let planDefault: Plan;

  // -------------------------------------------------------------------------
  // Helpers (the Story 8.3 harness, trimmed to what this story exercises)
  // -------------------------------------------------------------------------

  async function createItem(sku: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku,
        description: `Story 8.5 item ${sku}`,
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
  async function planOk(): Promise<Plan> {
    planCounter += 1;
    const sku = `FG-8-5-${run}-${planCounter}`;
    const itemId = await createItem(sku);
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
      inspectorHeaders,
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
  /** A lot + stock + trace row WITHOUT any QC task: an ungoverned lot (still holdable). */
  async function plainLot(
    sku: string,
    quantity: string = '10.000000',
    locationId: string = binA1Id,
  ): Promise<{
    lotId: string;
    lotNumber: string;
  }> {
    lotCounter += 1;
    const lotId = randomUUID();
    const lotNumber = `FG-LOT-8-5-${run}-${lotCounter}`;
    await getPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status) VALUES ($1, $2, $3, 'none')`,
      [lotId, lotNumber, sku],
    );
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', $4::numeric)`,
      [sku, locationId, lotNumber, quantity],
    );
    await getPool().query(
      `INSERT INTO lot_trace (lot_id, event_id, event_type, sku, location_id, location_code, quantity_change, business_stream)
       VALUES ($1, $2, 'stock.received', $3, $4, NULL, $5::numeric, 'production')`,
      [lotId, randomUUID(), sku, locationId, quantity],
    );
    return { lotId, lotNumber };
  }

  async function heldLot(
    plan: Plan,
    quantity: string,
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Held> {
    const seeded = await plainLot(plan.sku, quantity, locationId);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/completions',
      {
        source_completion_type: 'synthetic_completion',
        source_completion_id: randomUUID(),
        lot_id: seeded.lotId,
        lot_number: seeded.lotNumber,
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
    return {
      lotId: seeded.lotId,
      lotNumber: seeded.lotNumber,
      taskId: task['task_id'] as string,
      plan,
    };
  }

  async function inspected(
    plan: Plan,
    quantity: string = '10.000000',
    accepted: boolean = true,
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
      readings.push({ sample_unit_no: u, attribute_conforms: accepted ? true : u !== 1 });
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

  async function disposition(
    taskId: string,
    kind: 'accept' | 'reject',
    headers: Record<string, string> = approverHeaders,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      { disposition: kind, justification: `Story 8.5 ${kind} decision`, ...extra },
      headers,
    );
  }

  async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  async function lotRow(lotId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(`SELECT * FROM lot_master WHERE lot_id = $1`, [lotId]);
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  // -------------------------------------------------------------------------
  // Story 8.5 command helpers
  // -------------------------------------------------------------------------

  async function placeHold(
    lotId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = qcHeadHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/qc/holds',
      { lot_id: lotId, hold_reason: 'Story 8.5 containment', ...extra },
      headers,
    );
  }

  async function releaseHold(
    holdId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = approverHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/holds/${holdId}/release`,
      { release_reason: 'Story 8.5 containment lifted', ...extra },
      headers,
    );
  }

  async function raiseNcr(
    lotId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = qcHeadHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/qc/ncrs',
      {
        lot_id: lotId,
        defect_code: 'DIMENSIONAL',
        justification: 'Story 8.5 nonconformance',
        quantity: '5.000000',
        ...extra,
      },
      headers,
    );
  }

  let capaCounter = 0;
  async function openCapa(
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = qcHeadHeaders,
  ): Promise<HttpResult> {
    capaCounter += 1;
    return makeRequest(
      port,
      'POST',
      '/api/v1/qc/capas',
      {
        sku: `SKU-CAPA-${run}-${capaCounter}`,
        defect_code: 'DIMENSIONAL',
        title: `Story 8.5 CAPA ${capaCounter}`,
        owner_user_id: qcHeadUserId,
        due_on: '2026-12-31',
        ...extra,
      },
      headers,
    );
  }

  async function ncrOutcome(
    ncrId: string,
    outcome: string,
    headers: Record<string, string> = qcHeadHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/ncrs/${ncrId}/outcome`,
      { outcome, outcome_reason: `Story 8.5 ${outcome}` },
      headers,
    );
  }

  /** Seeds a PRIOR hold-sourced NCR row directly (past business dates are unreachable via API). */
  async function seedPriorNcr(sku: string, defectCode: string, istDate: string): Promise<void> {
    await getPool().query(
      `INSERT INTO qc_ncr (ncr_id, lot_id, lot_number, site_id, sku, quantity, justification,
         raised_by, raised_at, source_event_id, origin, defect_code, capa_mandatory)
       VALUES ($1, $2, $3, $4, $5, 1, 'Story 8.5 prior fixture', $6, $7::timestamptz, $8,
               'hold', $9, false)`,
      [
        randomUUID(),
        randomUUID(),
        `LOT-PRIOR-${run}-${randomUUID().slice(0, 6)}`,
        siteAId,
        sku,
        randomUUID(),
        `${istDate}T12:00:00.000+05:30`,
        randomUUID(),
        defectCode,
      ],
    );
  }

  function stockEnvelope(
    eventType: string,
    payload: Record<string, unknown>,
    extra: { device_id?: string; event_id?: string; idempotency_key?: string } = {},
  ): Record<string, unknown> {
    return {
      ...(extra.event_id ? { event_id: extra.event_id } : {}),
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: eventType,
      payload: { business_stream: 'production', ...payload },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: engineerUserId, role: 'inventory_controller', location_id: binA1Id },
        occurred_at: new Date().toISOString(),
        ...(extra.device_id ? { device_id: extra.device_id } : {}),
      },
      ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
    };
  }

  async function withRolledBackClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
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
      // Story 8.5: the two new projections, the trace-route sources and the dispatch-path fixture
      // tables. erp_sales_order and pick_task come first (dispatch_order_status lives in
      // pick_task.sql; packing_record.sql ALTERs it).
      '../../read/projections/erp_sales_order.sql',
      '../../read/projections/pick_task.sql',
      '../../read/projections/packing_record.sql',
      '../../read/projections/dispatch_document.sql',
      '../../read/projections/production_order.sql',
      '../../read/projections/production_wip_ledger.sql',
      '../../read/projections/qc_batch_release.sql',
      '../../read/projections/qc_retention_sample.sql',
      '../../read/projections/qc_quality_hold.sql',
      '../../read/projections/qc_capa.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE qc_capa, qc_quality_hold, qc_retention_sample, qc_batch_release, production_wip_ledger, production_order, dispatch_document, packing_record, dispatch_order_status, pick_task, erp_sales_order, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-5-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-5-${run}`, siteAId, siteAId);
    siteBId = await seedLocation('site', `SITE-B-8-5-${run}`, null, null);
    binB1Id = await seedLocation('bin', `BIN-B1-8-5-${run}`, siteBId, siteBId);

    qcHeadUserId = await provisionUser(port, `qc-head-8-5-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-5-${run}@example.com`);

    // Never places the holds it releases, so the SOD guard stays out of the happy path.
    approverUserId = await provisionUser(port, `qc-approver-8-5-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `qc-approver-8-5-${run}@example.com`);

    // Site-A-scoped read AND write: the LOCATION_ACCESS_DENIED proofs.
    await provisionUser(port, `qc-inspector-8-5-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteAId },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteAId },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-8-5-${run}@example.com`);

    engineerUserId = await provisionUser(port, `engineer-8-5-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-5-${run}@example.com`);

    // The Story 2.3 legacy 'quality' module surface, for the QUALITY_HOLD_GOVERNED proof.
    await provisionUser(port, `quality-officer-8-5-${run}@example.com`, [
      { role: 'quality_officer', module: 'quality', functionScope: 'write', locationId: '*' },
    ]);
    qualityHeaders = await authFor(port, `quality-officer-8-5-${run}@example.com`);

    await getPool().query(
      `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
       VALUES ($1, 'qc_head', 'qc.inspection_plan_approval', NULL, NULL, true)`,
      [randomUUID()],
    );

    componentItemId = await createItem(`COMP-8-5-${run}`);
    planDefault = await planOk();
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: hold placement, enterprise blocking, the five enforcement paths
  // -------------------------------------------------------------------------

  it('AC1: placing a hold flips the ONE enforcement flag and the enforcement paths block', async () => {
    const held = await inspected(planDefault, '10.000000');
    const accepted = await disposition(held.taskId, 'accept');
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    assert.strictEqual((await lotRow(held.lotId))!['quality_hold_status'], 'none');

    const placed = await placeHold(held.lotId, { defect_code: 'SURFACE_FINISH' });
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.body));
    const hold = placed.body['hold'] as Record<string, unknown>;
    assert.strictEqual(hold['status'], 'open');
    assert.strictEqual(hold['lot_number'], held.lotNumber);
    assert.strictEqual(hold['defect_code'], 'SURFACE_FINISH');
    assert.strictEqual(hold['placed_by'], qcHeadUserId);
    // Success writes the statutory audit row for the persisted event.
    assert.strictEqual(
      await countRows('audit_log', 'event_id = $1', [placed.body['event_id']]),
      1,
      'hold placement must land an audit row',
    );
    // The one flag, set in the same transaction; and the lot_trace entry.
    const lot = (await lotRow(held.lotId))!;
    assert.strictEqual(lot['quality_hold_status'], 'held');
    assert.strictEqual(lot['quality_hold_reason'], 'Story 8.5 containment');
    assert.strictEqual(
      await countRows('lot_trace', `lot_id = $1 AND event_type = 'qc.hold_placed'`, [held.lotId]),
      1,
    );

    // Enforcement path 1 + 2 (assertQcGateAllows and lot-serial-validation, via the real event
    // route): issue and allocate both block.
    for (const eventType of ['stock.issued', 'stock.allocated']) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        stockEnvelope(eventType, {
          sku: held.plan.sku,
          target_location_id: binA1Id,
          quantity: 1,
          lot_id: held.lotNumber,
        }),
        engineerHeaders,
      );
      assert.strictEqual(res.status, 400, `${eventType}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'LOT_ON_HOLD');
    }

    // Path 3: the QC gate assertion on an outbound operation, called on the same client surface
    // the dispatch and cross-dock appliers use.
    await withRolledBackClient(async (client) => {
      await assert.rejects(
        assertQcGateAllows({
          lot_id: held.lotId,
          operation: 'dispatch',
          business_date: '2026-08-31',
          client,
        }),
        (err: unknown) => err instanceof AppError && err.errorCode === 'LOT_ON_HOLD',
      );
    });

    // Path 4: the lot-serial validation read every issue/allocate ultimately consults.
    const validation = await validateLotForIssueAllocate(held.lotNumber, held.plan.sku);
    assert.strictEqual(validation.valid, false);
    assert.strictEqual(validation.errorCode, 'LOT_ON_HOLD');

    // Path 5: the dispatch shipping-documents applier over seeded packing fixtures.
    const dispatchOrderId = randomUUID();
    await getPool().query(
      `INSERT INTO dispatch_order_status (dispatch_order_id, picked_at, picked_by, packed_at)
       VALUES ($1, now(), $2, now())`,
      [dispatchOrderId, engineerUserId],
    );
    await getPool().query(
      `INSERT INTO packing_record (packing_record_id, dispatch_order_id, sku, packed_qty, lot_id, carton_count, packed_by)
       VALUES ($1, $2, $3, 5, $4, 1, $5)`,
      [randomUUID(), dispatchOrderId, held.plan.sku, held.lotId, engineerUserId],
    );
    await withRolledBackClient(async (client) => {
      await assert.rejects(
        applyDispatchShippingDocumentsGeneratedProjection(
          {
            payload: { dispatch_order_id: dispatchOrderId, document_types: ['bol'] },
            metadata: {
              correlation_id: randomUUID(),
              actor: { user_id: engineerUserId, role: 'dispatcher', location_id: siteAId },
              occurred_at: new Date().toISOString(),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          client,
          randomUUID(),
        ),
        (err: unknown) => err instanceof AppError && err.errorCode === 'LOT_ON_HOLD',
      );
    });
  });

  it('AC1: a second open hold is HOLD_EXISTS, sequentially and concurrently', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    const first = await placeHold(lotId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const holdId = (first.body['hold'] as Record<string, unknown>)['hold_id'] as string;

    const sequential = await placeHold(lotId);
    assert.strictEqual(sequential.status, 409, JSON.stringify(sequential.body));
    assert.strictEqual(sequential.body['error_code'], 'HOLD_EXISTS');
    assert.strictEqual(detailsOf(sequential.body)['existing_hold_id'], holdId);

    const fresh = await plainLot(planDefault.sku);
    const [a, b] = await Promise.all([placeHold(fresh.lotId), placeHold(fresh.lotId)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`,
    );
    const loser = a.status === 409 ? a : b;
    assert.strictEqual(loser.body['error_code'], 'HOLD_EXISTS');
    assert.strictEqual(
      await countRows('qc_quality_hold', `lot_id = $1 AND status = 'open'`, [fresh.lotId]),
      1,
    );
  });

  it('AC1: replaying the same idempotency key returns the same hold (200, no second row)', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    const key = randomUUID();
    const first = await placeHold(lotId, { idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await placeHold(lotId, { idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['hold'] as Record<string, unknown>)['hold_id'],
      (first.body['hold'] as Record<string, unknown>)['hold_id'],
    );
    assert.strictEqual(await countRows('qc_quality_hold', 'lot_id = $1', [lotId]), 1);
  });

  it('AC1: the trace returns movements, where-used, where-shipped, coverage and the measured budget', async () => {
    const { lotId, lotNumber } = await plainLot(planDefault.sku);
    const placed = await placeHold(lotId);
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.body));
    const holdId = (placed.body['hold'] as Record<string, unknown>)['hold_id'] as string;

    // where-used fixture: a production order that consumed this lot.
    const orderId = randomUUID();
    await getPool().query(
      `INSERT INTO production_order (production_order_id, order_number_ext, output_item_id,
         output_sku, order_quantity, order_uom, plant_location_id, bom_id, business_stream,
         source_reference_type, source_reference_id, status, created_by, source_event_id)
       VALUES ($1, $2, $3, $4, 10, 'EA', $5, $6, 'production', 'manual', 'MAN-8-5', 'in_process', $7, $8)`,
      [
        orderId,
        `MO-8-5-${run}`,
        randomUUID(),
        `FG-OUT-${run}`,
        siteAId,
        randomUUID(),
        qcHeadUserId,
        randomUUID(),
      ],
    );
    await getPool().query(
      `INSERT INTO production_wip_ledger (posting_id, production_order_id, posting_type,
         bom_line_id, component_item_id, component_sku, lot_number, source_location_id, quantity,
         open_quantity, unit_cost, posting_value, source_event_id, occurred_at)
       VALUES ($1, $2, 'directed_issue', $3, $4, $5, $6, $7, 4, 4, 10, 40, $8, now())`,
      [
        randomUUID(),
        orderId,
        randomUUID(),
        planDefault.itemId,
        planDefault.sku,
        lotNumber,
        binA1Id,
        randomUUID(),
      ],
    );
    // where-shipped fixture: a packed + dispatched order with one generated document.
    const dispatchOrderId = randomUUID();
    await getPool().query(
      `INSERT INTO dispatch_order_status (dispatch_order_id, picked_at, picked_by, packed_at)
       VALUES ($1, now(), $2, now())`,
      [dispatchOrderId, engineerUserId],
    );
    await getPool().query(
      `INSERT INTO packing_record (packing_record_id, dispatch_order_id, sku, packed_qty, lot_id, carton_count, packed_by)
       VALUES ($1, $2, $3, 6, $4, 1, $5)`,
      [randomUUID(), dispatchOrderId, planDefault.sku, lotId, engineerUserId],
    );
    await getPool().query(
      `INSERT INTO dispatch_document (document_id, dispatch_order_id, document_type, document_content, generated_by)
       VALUES ($1, $2, 'bol', 'BOL-8-5', $3)`,
      [randomUUID(), dispatchOrderId, engineerUserId],
    );

    const trace = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/holds/${holdId}/trace`,
      undefined,
      qcHeadHeaders,
    );
    assert.strictEqual(trace.status, 200, JSON.stringify(trace.body));
    assert.strictEqual(trace.body['hold_id'], holdId);
    assert.strictEqual(trace.body['lot_number'], lotNumber);

    const movements = trace.body['movements'] as Array<Record<string, unknown>>;
    assert.ok(movements.length >= 2, 'stock.received and qc.hold_placed must both appear');
    assert.ok(movements.some((m) => m['event_type'] === 'qc.hold_placed'));

    const whereUsed = trace.body['where_used'] as Array<Record<string, unknown>>;
    assert.strictEqual(whereUsed.length, 1, JSON.stringify(whereUsed));
    assert.strictEqual(whereUsed[0]!['order_number_ext'], `MO-8-5-${run}`);
    assert.strictEqual(whereUsed[0]!['posting_type'], 'directed_issue');

    const whereShipped = trace.body['where_shipped'] as Array<Record<string, unknown>>;
    assert.strictEqual(whereShipped.length, 1, JSON.stringify(whereShipped));
    assert.strictEqual(whereShipped[0]!['dispatch_order_id'], dispatchOrderId);
    const documents = whereShipped[0]!['documents'] as Array<Record<string, unknown>>;
    assert.strictEqual(documents.length, 1);
    assert.strictEqual(documents[0]!['document_type'], 'bol');

    // The declared coverage limit (Binding Scope Decision 7 makes the budget observable too).
    const coverage = trace.body['coverage'] as Record<string, unknown>;
    // Story 9.3 moved job-work consumption into where_used; only production genealogy remains.
    assert.strictEqual((coverage['not_yet_covered'] as string[]).length, 1);
    assert.ok(
      (coverage['where_used'] as string[]).some((c) => c.includes('custody.consumption_posted')),
    );
    assert.strictEqual(trace.body['propagation_budget_minutes'], 15);
    assert.strictEqual(typeof trace.body['elapsed_minutes'], 'number');
    assert.strictEqual(trace.body['propagation_budget_breached'], false);
    assert.strictEqual(
      trace.body['placed_at'],
      (placed.body['hold'] as Record<string, unknown>)['placed_at'],
    );

    // The plain hold read reports the same budget envelope.
    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/holds/${holdId}`,
      undefined,
      qcHeadHeaders,
    );
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body['propagation_budget_minutes'], 15);
    assert.strictEqual(read.body['propagation_budget_breached'], false);
  });

  it('Decision 3: the Story 2.3 clear route is fail-closed QUALITY_HOLD_GOVERNED while a governed hold is open', async () => {
    const { lotId, lotNumber } = await plainLot(planDefault.sku);
    const placed = await placeHold(lotId);
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.body));
    const holdId = (placed.body['hold'] as Record<string, unknown>)['hold_id'] as string;

    const blocked = await makeRequest(
      port,
      'DELETE',
      `/api/v1/lots/${lotNumber}/quality-hold`,
      {},
      qualityHeaders,
    );
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'QUALITY_HOLD_GOVERNED');
    assert.strictEqual(detailsOf(blocked.body)['hold_id'], holdId);
    assert.strictEqual((await lotRow(lotId))!['quality_hold_status'], 'held');

    const released = await releaseHold(holdId);
    assert.strictEqual(released.status, 201, JSON.stringify(released.body));
    const cleared = await makeRequest(
      port,
      'DELETE',
      `/api/v1/lots/${lotNumber}/quality-hold`,
      {},
      qualityHeaders,
    );
    assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
  });

  it('Decision 4: release is segregated, reason-carrying, and once-only', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    const placed = await placeHold(lotId);
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.body));
    const holdId = (placed.body['hold'] as Record<string, unknown>)['hold_id'] as string;

    // The placer cannot release (audited SOD_VIOLATION).
    const sod = await releaseHold(holdId, {}, qcHeadHeaders);
    assert.strictEqual(sod.status, 409, JSON.stringify(sod.body));
    assert.strictEqual(sod.body['error_code'], 'SOD_VIOLATION');
    assert.ok(
      (await countRows('audit_log', `error_code = 'SOD_VIOLATION' AND details->>'hold_id' = $1`, [
        holdId,
      ])) >= 1,
      'the refused release must be audited',
    );

    const noReason = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/holds/${holdId}/release`,
      {},
      approverHeaders,
    );
    assert.strictEqual(noReason.status, 400, JSON.stringify(noReason.body));

    const released = await releaseHold(holdId);
    assert.strictEqual(released.status, 201, JSON.stringify(released.body));
    const holdRow = released.body['hold'] as Record<string, unknown>;
    assert.strictEqual(holdRow['status'], 'released');
    assert.strictEqual(holdRow['released_by'], approverUserId);
    assert.strictEqual(holdRow['release_reason'], 'Story 8.5 containment lifted');
    assert.strictEqual((await lotRow(lotId))!['quality_hold_status'], 'none');
    assert.strictEqual(
      await countRows('lot_trace', `lot_id = $1 AND event_type = 'qc.hold_released'`, [lotId]),
      1,
    );

    const again = await releaseHold(holdId);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'HOLD_ALREADY_RELEASED');

    // Concurrent double release on a fresh hold: exactly one wins.
    const fresh = await plainLot(planDefault.sku);
    const placed2 = await placeHold(fresh.lotId);
    const holdId2 = (placed2.body['hold'] as Record<string, unknown>)['hold_id'] as string;
    const [a, b] = await Promise.all([releaseHold(holdId2), releaseHold(holdId2)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`,
    );
    assert.strictEqual((a.status === 409 ? a : b).body['error_code'], 'HOLD_ALREADY_RELEASED');
  });

  it('Decision 1/4: releasing a governed hold never lifts the scrap_pending containment', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    await getPool().query(
      `UPDATE lot_master SET quality_hold_status = 'held', quality_hold_reason = 'scrap_pending' WHERE lot_id = $1`,
      [lotId],
    );
    const placed = await placeHold(lotId);
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.body));
    // The pre-existing containment reason is preserved, not overwritten.
    assert.strictEqual((await lotRow(lotId))!['quality_hold_reason'], 'scrap_pending');

    const holdId = (placed.body['hold'] as Record<string, unknown>)['hold_id'] as string;
    const released = await releaseHold(holdId);
    assert.strictEqual(released.status, 201, JSON.stringify(released.body));
    const lot = (await lotRow(lotId))!;
    assert.strictEqual(lot['quality_hold_status'], 'held', 'scrap containment must survive');
    assert.strictEqual(lot['quality_hold_reason'], 'scrap_pending');
  });

  // -------------------------------------------------------------------------
  // AC2: edge replay rejection and central-only surface
  // -------------------------------------------------------------------------

  it('AC2: a queued edge transaction replayed against a held lot is rejected LOT_ON_HOLD', async () => {
    const { lotId, lotNumber } = await plainLot(planDefault.sku);
    const placed = await placeHold(lotId);
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.body));

    // The device captured the issue while offline (before or after the hold - the replay is
    // decided centrally either way), then reconnects and uploads.
    const eventId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      stockEnvelope(
        'stock.issued',
        {
          sku: planDefault.sku,
          target_location_id: binA1Id,
          quantity: 1,
          lot_id: lotNumber,
        },
        { event_id: eventId, idempotency_key: `edge-8-5-${eventId}`, device_id: DEVICE_ID },
      ),
      engineerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOT_ON_HOLD');
  });

  it('AC2/Decision 6: the propagation bucket and the synced edge table exist structurally', () => {
    // Binding Scope Decision 7: the 15-minute contract is asserted structurally (the bucket
    // selects held rows; the edge capture guard reads the table) - never with a 15-minute wait.
    const rules = readFileSync(resolve(__dirname, '../../sync/sync-rules.yaml'), 'utf-8');
    assert.ok(rules.includes('quality_holds:'), 'sync-rules must define the quality_holds bucket');
    assert.ok(
      rules.includes(
        "SELECT lot_id AS id, lot_id, lot_number, sku, quality_hold_status, quality_hold_reason, updated_at FROM lot_master AS held_lot WHERE quality_hold_status = 'held'",
      ),
      'the bucket replicates the held rows of lot_master under the held_lot client name',
    );
    const schema = readFileSync(resolve(__dirname, '../../edge/src/local-db/schema.ts'), 'utf-8');
    assert.ok(schema.includes('held_lot: heldLot'), 'EdgeSchema must register held_lot');
    const heldLotDef = schema.slice(
      schema.indexOf('export const heldLot'),
      schema.indexOf('export const EdgeSchema'),
    );
    for (const column of [
      'lot_id',
      'lot_number',
      'sku',
      'quality_hold_status',
      'quality_hold_reason',
      'updated_at',
    ]) {
      assert.ok(heldLotDef.includes(column), `held_lot must carry ${column}`);
    }
    assert.ok(!heldLotDef.includes('localOnly'), 'held_lot is synced, never localOnly');
    const guard = readFileSync(resolve(__dirname, '../../edge/src/capture/held-lot.ts'), 'utf-8');
    assert.ok(guard.includes('FROM held_lot'), 'the pre-capture guard reads the synced table');
  });

  it('AC2: every Story 8.5 event type is central-only on the edge upload route', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    for (const eventType of [
      'qc.hold_placed',
      'qc.hold_released',
      'qc.ncr_raised',
      'qc.capa_opened',
      'qc.capa_closed',
      'qc.capa_linked',
    ]) {
      const eventId = randomUUID();
      const streamId = randomUUID();
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          event_id: eventId,
          stream_type: 'qc',
          stream_id: streamId,
          event_type: eventType,
          event_version: 1,
          payload: { lot_id: lotId },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: qcHeadUserId, role: 'qc_head', location_id: siteAId },
            device_id: DEVICE_ID,
            capture_method: 'MANUAL',
            occurred_at: new Date().toISOString(),
          },
          schema_version: 1,
          idempotency_key: `edge-8-5-${eventId}`,
        },
        qcHeadHeaders,
      );
      assert.strictEqual(res.status, 403, `${eventType}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    }
    assert.strictEqual(await countRows('qc_quality_hold', 'lot_id = $1', [lotId]), 0);
  });

  it('Forgery: a declared server-derived field is QC_DERIVATION_MISMATCH on every new type', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [];
    const holdId = randomUUID();
    cases.push([
      'qc.hold_placed',
      holdId,
      {
        hold_id: holdId,
        lot_id: randomUUID(),
        hold_reason: 'forged',
        placed_at: new Date().toISOString(),
      },
    ]);
    const holdId2 = randomUUID();
    cases.push([
      'qc.hold_released',
      holdId2,
      { hold_id: holdId2, release_reason: 'forged', released_by: randomUUID() },
    ]);
    const ncrId = randomUUID();
    cases.push([
      'qc.ncr_raised',
      ncrId,
      {
        ncr_id: ncrId,
        lot_id: randomUUID(),
        defect_code: 'DIMENSIONAL',
        justification: 'forged',
        quantity: '1',
        capa_mandatory: false,
      },
    ]);
    const capaId = randomUUID();
    cases.push([
      'qc.capa_opened',
      capaId,
      {
        capa_id: capaId,
        sku: 'SKU-F',
        defect_code: 'DIMENSIONAL',
        title: 'forged',
        owner_user_id: randomUUID(),
        due_on: '2026-12-31',
        capa_number: 'CAPA-2026-9999',
      },
    ]);
    const capaId2 = randomUUID();
    cases.push([
      'qc.capa_closed',
      capaId2,
      { capa_id: capaId2, closure_evidence: 'forged', status: 'closed' },
    ]);
    const ncrId2 = randomUUID();
    cases.push([
      'qc.capa_linked',
      ncrId2,
      { ncr_id: ncrId2, capa_id: randomUUID(), linked_by: randomUUID() },
    ]);

    for (const [eventType, streamId, payload] of cases) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          stream_type: 'qc',
          stream_id: streamId,
          event_type: eventType,
          payload,
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: qcHeadUserId, role: 'qc_head', location_id: siteAId },
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: randomUUID(),
        },
        qcHeadHeaders,
      );
      assert.strictEqual(res.status, 409, `${eventType}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'QC_DERIVATION_MISMATCH', eventType);
    }
  });

  // -------------------------------------------------------------------------
  // AC3: hold-sourced NCR with defect code and CAPA linkage
  // -------------------------------------------------------------------------

  it('AC3: an NCR raised on a held lot carries its defect code and validated CAPA link', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    const placed = await placeHold(lotId);
    assert.strictEqual(placed.status, 201, JSON.stringify(placed.body));
    const holdId = (placed.body['hold'] as Record<string, unknown>)['hold_id'] as string;

    const capaRes = await openCapa({ sku: planDefault.sku });
    assert.strictEqual(capaRes.status, 201, JSON.stringify(capaRes.body));
    const capa = capaRes.body['capa'] as Record<string, unknown>;
    assert.match(capa['capa_number'] as string, /^CAPA-\d{4}-\d{4,}$/);
    assert.strictEqual(capa['status'], 'open');
    assert.strictEqual(
      await countRows('audit_log', 'event_id = $1', [capaRes.body['event_id']]),
      1,
    );

    const raised = await raiseNcr(lotId, { capa_id: capa['capa_id'] });
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const ncr = raised.body['ncr'] as Record<string, unknown>;
    assert.strictEqual(ncr['origin'], 'hold');
    assert.strictEqual(ncr['hold_id'], holdId);
    assert.strictEqual(ncr['defect_code'], 'DIMENSIONAL');
    assert.strictEqual(ncr['capa_id'], capa['capa_id']);
    assert.strictEqual(ncr['capa_mandatory'], false);
    assert.strictEqual(ncr['disposition_id'], null);
    assert.strictEqual(ncr['task_id'], null);
    assert.strictEqual(await countRows('audit_log', 'event_id = $1', [raised.body['event_id']]), 1);
  });

  it('AC3: an unknown defect code is rejected 422 with the allowed catalogue in the detail', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    await placeHold(lotId);
    const res = await raiseNcr(lotId, { defect_code: 'NOT_A_CODE' });
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'DEFECT_CODE_UNKNOWN');
    assert.deepStrictEqual(detailsOf(res.body)['allowed'], SEED_CODES);
  });

  it('AC3: a raise naming a closed CAPA is rejected CAPA_NOT_OPEN; an unknown one CAPA_NOT_FOUND', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    await placeHold(lotId);
    const capaRes = await openCapa({ sku: planDefault.sku });
    const capa = capaRes.body['capa'] as Record<string, unknown>;
    const closed = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/capas/${capa['capa_id']}/close`,
      { closure_evidence: 'Story 8.5 closure evidence' },
      qcHeadHeaders,
    );
    assert.strictEqual(closed.status, 201, JSON.stringify(closed.body));
    assert.strictEqual((closed.body['capa'] as Record<string, unknown>)['status'], 'closed');

    const res = await raiseNcr(lotId, { capa_id: capa['capa_id'] });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CAPA_NOT_OPEN');

    const missing = await raiseNcr(lotId, { capa_id: randomUUID() });
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'CAPA_NOT_FOUND');
  });

  it('AC3: a hold-sourced NCR requires a held or defective lot', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    const res = await raiseNcr(lotId);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'HOLD_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // AC4: repeat-defect rule and the mandatory-CAPA close gate
  // -------------------------------------------------------------------------

  it('AC4: the next matching NCR after 3 in-window is capa_mandatory and gates its close on APPROVAL_REQUIRED', async () => {
    const sku = `SKU-REPEAT-${run}`;
    await createItem(sku);
    // Three prior matching NCRs on earlier IST business dates (unreachable through the API, which
    // stamps raised_at server-side - the seeded rows are the enterprise-wide history).
    const today = new Date(Date.now() + 5.5 * 3_600_000);
    const day = (offset: number): string =>
      new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    await seedPriorNcr(sku, 'CONTAMINATION', day(1));
    await seedPriorNcr(sku, 'CONTAMINATION', day(2));
    await seedPriorNcr(sku, 'CONTAMINATION', day(3));
    // A same-SKU different-defect NCR never counts toward the grain.
    await seedPriorNcr(sku, 'PACKAGING', day(1));

    const { lotId } = await plainLot(sku);
    await placeHold(lotId);
    const raised = await raiseNcr(lotId, { defect_code: 'CONTAMINATION' });
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const ncr = raised.body['ncr'] as Record<string, unknown>;
    assert.strictEqual(ncr['capa_mandatory'], true, JSON.stringify(ncr));
    const ncrId = ncr['ncr_id'] as string;

    const gated = await ncrOutcome(ncrId, 'closed_with_capa');
    assert.strictEqual(gated.status, 409, JSON.stringify(gated.body));
    assert.strictEqual(gated.body['error_code'], 'APPROVAL_REQUIRED');
    const gd = detailsOf(gated.body);
    assert.strictEqual(gd['matching_ncr_count'], 3);
    assert.strictEqual(gd['repeat_defect_threshold'], 3);
    assert.strictEqual(gd['repeat_defect_window_days'], 90);
    assert.match(String(gd['link_route']), /\/api\/v1\/qc\/ncrs\/.+\/capa$/);
    assert.ok(
      (await countRows(
        'audit_log',
        `error_code = 'APPROVAL_REQUIRED' AND details->>'ncr_id' = $1`,
        [ncrId],
      )) >= 1,
      'the gated close must be audited',
    );

    const capaRes = await openCapa({ sku, defect_code: 'CONTAMINATION' });
    const capaId = (capaRes.body['capa'] as Record<string, unknown>)['capa_id'] as string;
    const linked = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/ncrs/${ncrId}/capa`,
      { capa_id: capaId },
      qcHeadHeaders,
    );
    assert.strictEqual(linked.status, 201, JSON.stringify(linked.body));
    assert.strictEqual((linked.body['ncr'] as Record<string, unknown>)['capa_id'], capaId);

    // A second link is CAPA_ALREADY_LINKED, sequentially and concurrently.
    const secondCapa = await openCapa({ sku, defect_code: 'CONTAMINATION' });
    const secondCapaId = (secondCapa.body['capa'] as Record<string, unknown>)['capa_id'] as string;
    const relink = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/ncrs/${ncrId}/capa`,
      { capa_id: secondCapaId },
      qcHeadHeaders,
    );
    assert.strictEqual(relink.status, 409, JSON.stringify(relink.body));
    assert.strictEqual(relink.body['error_code'], 'CAPA_ALREADY_LINKED');

    const done = await ncrOutcome(ncrId, 'closed_with_capa');
    assert.strictEqual(done.status, 201, JSON.stringify(done.body));
    assert.strictEqual(
      (done.body['ncr'] as Record<string, unknown>)['outcome'],
      'closed_with_capa',
    );

    const twice = await ncrOutcome(ncrId, 'closed_with_capa');
    assert.strictEqual(twice.status, 409, JSON.stringify(twice.body));
    assert.strictEqual(twice.body['error_code'], 'NCR_OUTCOME_EXISTS');
  });

  it('AC4: two concurrent CAPA links produce exactly one linked CAPA', async () => {
    const { lotId } = await plainLot(planDefault.sku);
    await placeHold(lotId);
    const raised = await raiseNcr(lotId);
    const ncrId = (raised.body['ncr'] as Record<string, unknown>)['ncr_id'] as string;
    const capaA = await openCapa({ sku: planDefault.sku });
    const capaB = await openCapa({ sku: planDefault.sku });
    const [a, b] = await Promise.all([
      makeRequest(
        port,
        'POST',
        `/api/v1/qc/ncrs/${ncrId}/capa`,
        {
          capa_id: (capaA.body['capa'] as Record<string, unknown>)['capa_id'],
        },
        qcHeadHeaders,
      ),
      makeRequest(
        port,
        'POST',
        `/api/v1/qc/ncrs/${ncrId}/capa`,
        {
          capa_id: (capaB.body['capa'] as Record<string, unknown>)['capa_id'],
        },
        qcHeadHeaders,
      ),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`,
    );
    assert.strictEqual((a.status === 409 ? a : b).body['error_code'], 'CAPA_ALREADY_LINKED');
  });

  it('Decision 14: the outcome vocabularies do not mix across origins', async () => {
    // A hold-sourced NCR refuses the three disposition-family outcomes.
    const { lotId } = await plainLot(planDefault.sku);
    await placeHold(lotId);
    const raised = await raiseNcr(lotId);
    const holdNcrId = (raised.body['ncr'] as Record<string, unknown>)['ncr_id'] as string;
    for (const outcome of ['rework', 'downgrade', 'scrap']) {
      // downgrade carries its route-level shape requirement so the SEAM refusal is what fires.
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/qc/ncrs/${holdNcrId}/outcome`,
        {
          outcome,
          outcome_reason: `Story 8.5 ${outcome}`,
          ...(outcome === 'downgrade' ? { downgrade_sku: 'SKU-OTHER-8-5' } : {}),
        },
        qcHeadHeaders,
      );
      assert.strictEqual(res.status, 409, `${outcome}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'NCR_OUTCOME_NOT_APPLICABLE');
    }

    // A disposition-sourced NCR refuses closed_with_capa.
    const held = await inspected(planDefault, '8.000000', false);
    const rejected = await disposition(held.taskId, 'reject');
    assert.strictEqual(rejected.status, 201, JSON.stringify(rejected.body));
    const dispNcrId = ((rejected.body['ncr'] as Record<string, unknown>) ?? {})['ncr_id'] as string;
    const res = await ncrOutcome(dispNcrId, 'closed_with_capa');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'NCR_OUTCOME_NOT_APPLICABLE');
  });

  it('8.3 regression: the reject path still creates exactly one origin-disposition NCR per lot', async () => {
    const held = await inspected(planDefault, '12.000000', false);
    const first = await disposition(held.taskId, 'reject');
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const ncr = first.body['ncr'] as Record<string, unknown>;
    assert.strictEqual(ncr['origin'], 'disposition');
    assert.strictEqual(ncr['outcome'], null);
    assert.strictEqual(await countRows('qc_ncr', 'lot_id = $1', [held.lotId]), 1);

    // A second reject is refused exactly as Story 8.3 shipped it, after the uq_qc_ncr_lot change.
    const second = await disposition(held.taskId, 'reject');
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DISPOSITION_EXISTS');
    assert.strictEqual(await countRows('qc_ncr', 'lot_id = $1', [held.lotId]), 1);
  });

  // -------------------------------------------------------------------------
  // Site scoping (LOCATION_ACCESS_DENIED) on the site-scoped write routes
  // -------------------------------------------------------------------------

  it('Site scope: the site-scoped write routes refuse and audit a cross-site actor', async () => {
    // A governed lot at site B (its inspection task carries the site).
    const heldB = await heldLot(planDefault, '5.000000', binB1Id, siteBId, qcHeadHeaders);

    const place = await placeHold(heldB.lotId, {}, inspectorHeaders);
    assert.strictEqual(place.status, 403, JSON.stringify(place.body));
    assert.strictEqual(place.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.ok(
      (await countRows(
        'audit_log',
        `error_code = 'LOCATION_ACCESS_DENIED' AND details->>'lot_id' = $1`,
        [heldB.lotId],
      )) >= 1,
    );

    const placedByHead = await placeHold(heldB.lotId);
    assert.strictEqual(placedByHead.status, 201, JSON.stringify(placedByHead.body));
    const holdId = (placedByHead.body['hold'] as Record<string, unknown>)['hold_id'] as string;

    const release = await releaseHold(holdId, {}, inspectorHeaders);
    assert.strictEqual(release.status, 403, JSON.stringify(release.body));
    assert.strictEqual(release.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const raise = await raiseNcr(heldB.lotId, {}, inspectorHeaders);
    assert.strictEqual(raise.status, 403, JSON.stringify(raise.body));
    assert.strictEqual(raise.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const raisedByHead = await raiseNcr(heldB.lotId);
    assert.strictEqual(raisedByHead.status, 201, JSON.stringify(raisedByHead.body));
    const ncrId = (raisedByHead.body['ncr'] as Record<string, unknown>)['ncr_id'] as string;
    const capaRes = await openCapa({ sku: planDefault.sku });
    const link = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/ncrs/${ncrId}/capa`,
      { capa_id: (capaRes.body['capa'] as Record<string, unknown>)['capa_id'] },
      inspectorHeaders,
    );
    assert.strictEqual(link.status, 403, JSON.stringify(link.body));
    assert.strictEqual(link.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // Cross-site reads on the hold are refused too.
    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/holds/${holdId}`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(read.status, 403, JSON.stringify(read.body));
    assert.strictEqual(read.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const trace = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/holds/${holdId}/trace`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(trace.status, 403, JSON.stringify(trace.body));
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';
import { persistEvent } from '../../src/events/store.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 8.2 AQL Sampling and Result Capture (FR-Q-03, FR-Q-04, FR-Q-13, FR-M-13). Real PostgreSQL,
 * the real production router, SCIM provisioning and dev-token auth. Dedicated routes carry the
 * ordinary behaviour; direct persistEvent / POST /api/v1/events carry the forgery, derivation,
 * stream and replay proofs. Tests run serially; every identifier is run-scoped and every date is
 * a fixed anchor.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DEVICE_ID = `edge-8-2-${run}`;
const ANCHOR = '2026-06-01';

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
  /** characteristic ids in line order */
  lines: string[];
}

interface Held {
  lotId: string;
  lotNumber: string;
  taskId: string;
  plan: Plan;
}

describe('Story 8.2 AQL Sampling and Result Capture', () => {
  let server: Server;
  let port: number;

  let qcHeadUserId: string;
  let qcHeadHeaders: Record<string, string>;
  let inspectorUserId: string;
  let inspectorHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  let schedulerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let procurementHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let siteBId: string;
  let binB1Id: string;
  let componentItemId: string;

  /** Default plan: AQL 1.0 / II with a critical numeric (UTM, MPa) line and an instrument-less minor attribute line. */
  let planDefault: Plan;

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
        description: `Story 8.2 item ${sku}`,
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

  function criticalNumeric(): Record<string, unknown> {
    return {
      line_no: 1,
      characteristic_name: 'Tensile strength',
      characteristic_class: 'critical',
      test_method_ref: 'IS 1608',
      instrument_type: 'UTM',
      result_kind: 'numeric',
      lower_limit: '410.000000',
      upper_limit: '560.000000',
      limit_uom: 'MPa',
      acceptance_criteria: null,
      sample_handling: 'Machine coupons; test within 24h',
    };
  }

  function minorAttribute(lineNo: number = 2): Record<string, unknown> {
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
  /** A fresh item, released spec revision, approved plan version. */
  async function planFor(
    aql: string | null,
    level: string | null,
    characteristics: Record<string, unknown>[] = [criticalNumeric(), minorAttribute()],
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Plan | HttpResult> {
    planCounter += 1;
    const sku = `FG-8-2-${run}-${planCounter}`;
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
        aql,
        inspection_level: level,
        characteristics,
      },
      headers,
    );
    if (created.status !== 201) return created;
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

  async function planOk(
    aql: string | null,
    level: string | null,
    characteristics?: Record<string, unknown>[],
  ): Promise<Plan> {
    const plan = await planFor(aql, level, characteristics);
    assert.ok('planId' in plan, JSON.stringify(plan));
    return plan;
  }

  let lotCounter = 0;
  async function heldLot(
    plan: Plan,
    quantity: string,
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Held> {
    lotCounter += 1;
    const lotId = randomUUID();
    const lotNumber = `FG-LOT-8-2-${run}-${lotCounter}`;
    await getPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status) VALUES ($1, $2, $3, 'none')`,
      [lotId, lotNumber, plan.sku],
    );
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', $4::numeric)`,
      [plan.sku, locationId, lotNumber, quantity],
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

  async function determine(
    taskId: string,
    headers: Record<string, string> = inspectorHeaders,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', `/api/v1/qc/tasks/${taskId}/sampling`, body, headers);
  }

  function sampling(res: HttpResult): Record<string, unknown> {
    return res.body['sampling'] as Record<string, unknown>;
  }

  async function calibratedInstrument(
    validUntil: string = '2027-06-01',
  ): Promise<{ assetId: string; instrumentId: string; recordId: string }> {
    const asset = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-8-2-${randomUUID().slice(0, 12)}`,
        asset_name: `UTM ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: 'critical',
      },
      schedulerHeaders,
    );
    assert.strictEqual(asset.status, 201, JSON.stringify(asset.body));
    const assetId = (asset.body['asset'] as Record<string, string>)['asset_id']!;
    const register = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/instruments',
      {
        asset_id: assetId,
        instrument_id: `INS-8-2-${randomUUID().slice(0, 8)}`,
        location_id: siteAId,
        calibration_interval_days: 365,
      },
      schedulerHeaders,
    );
    assert.strictEqual(register.status, 201, JSON.stringify(register.body));
    const registered = register.body['instrument'] as Record<string, string>;
    const recordId = registered['instrument_record_id']!;
    // The register canonicalizes the key (Story 7.5); the result rows carry the register's form.
    const instrumentId = registered['instrument_id']!;
    const certificate = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${recordId}/certificates`,
      {
        calibration_type: 'in_house',
        certificate_number: `CERT-${randomUUID().slice(0, 8)}`,
        issuing_lab: null,
        calibrated_on: ANCHOR,
        valid_until: validUntil,
        business_date: ANCHOR,
      },
      schedulerHeaders,
    );
    assert.strictEqual(certificate.status, 201, JSON.stringify(certificate.body));
    return { assetId, instrumentId, recordId };
  }

  async function calibrationStatusOf(instrumentId: string): Promise<string | null> {
    const r = await getAdminPool().query(
      `SELECT calibration_status FROM instrument_calibration_statuses WHERE lower(instrument_id) = lower($1)`,
      [instrumentId],
    );
    return (r.rows[0]?.['calibration_status'] as string | undefined) ?? null;
  }

  function numericReadings(
    from: number,
    to: number,
    nonconformingUnits: number[] = [],
  ): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let u = from; u <= to; u += 1) {
      out.push({
        sample_unit_no: u,
        measured_value: nonconformingUnits.includes(u) ? '300.000000' : '500.000000',
        measured_uom: 'MPa',
      });
    }
    return out;
  }

  function attributeReadings(
    from: number,
    to: number,
    nonconformingUnits: number[] = [],
  ): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let u = from; u <= to; u += 1) {
      out.push({ sample_unit_no: u, attribute_conforms: !nonconformingUnits.includes(u) });
    }
    return out;
  }

  async function postResults(
    taskId: string,
    characteristicId: string,
    assetId: string,
    readings: Record<string, unknown>[],
    headers: Record<string, string> = inspectorHeaders,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/results`,
      { characteristic_id: characteristicId, instrument_asset_id: assetId, readings, ...extra },
      headers,
    );
  }

  async function postObservations(
    taskId: string,
    characteristicId: string,
    readings: Record<string, unknown>[],
    headers: Record<string, string> = inspectorHeaders,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/observations`,
      { characteristic_id: characteristicId, readings, ...extra },
      headers,
    );
  }

  async function complete(
    taskId: string,
    headers: Record<string, string> = inspectorHeaders,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/inspection-completion`,
      body,
      headers,
    );
  }

  async function taskRow(taskId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(`SELECT * FROM qc_inspection_task WHERE task_id = $1`, [
      taskId,
    ]);
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function stateRow(planId: string, siteId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT * FROM qc_sampling_switching_state WHERE plan_id = $1 AND site_id = $2`,
      [planId, siteId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  async function eventRow(eventId: unknown): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT stream_type, event_type, payload, metadata FROM domain_events WHERE event_id = $1`,
      [eventId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  /**
   * Drives ONE lot of the single-attribute-line plan (lot 5 under AQL 1.0 / II resolves to the
   * whole lot, Ac 0 / Re 1) to completion with the given outcome. Returns the completion body.
   */
  async function inspectLot(
    plan: Plan,
    accepted: boolean,
    quantity: string = '5.000000',
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<{ held: Held; determination: HttpResult; completion: HttpResult }> {
    const held = await heldLot(plan, quantity, locationId, siteId, headers);
    const determination = await determine(held.taskId, headers);
    assert.strictEqual(determination.status, 201, JSON.stringify(determination.body));
    const sampleSize = sampling(determination)['sample_size'] as number;
    const required = plan.lines.length === 1 ? sampleSize : Number(quantity.split('.')[0]);
    const obs = await postObservations(
      held.taskId,
      plan.lines[plan.lines.length - 1]!,
      attributeReadings(1, required, accepted ? [] : [1]),
      headers,
    );
    assert.strictEqual(obs.status, 201, JSON.stringify(obs.body));
    const completion = await complete(held.taskId, headers);
    assert.strictEqual(completion.status, 201, JSON.stringify(completion.body));
    assert.strictEqual(
      (completion.body['task'] as Record<string, unknown>)['sampling_outcome'],
      accepted ? 'accepted' : 'not_accepted',
    );
    return { held, determination, completion };
  }

  async function adjustState(
    planId: string,
    siteId: string,
    action: string,
    headers: Record<string, string>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/sampling-states/${planId}/sites/${siteId}/actions`,
      { action, reason: `Story 8.2 ${action}` },
      headers,
    );
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
      '../../read/projections/transfer_request.sql',
      '../../read/projections/in_transit.sql',
      '../../read/projections/integration_exception.sql',
      '../../read/projections/pick_task.sql',
      '../../read/projections/pick_line.sql',
      '../../read/projections/packing_record.sql',
      '../../read/projections/dispatch_document.sql',
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
      '../../read/projections/asset.sql',
      '../../read/projections/instrument_register.sql',
      '../../read/projections/instrument_calibration_certificate.sql',
      '../../read/projections/instrument_calibration_alert.sql',
      '../../read/projections/instrument_calibration_escalation.sql',
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, instrument_calibration_escalation, instrument_calibration_alert, instrument_calibration_certificate, instrument_register, instrument_calibration_statuses, asset, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, dispatch_document, packing_record, dispatch_order_status, pick_line, pick_task, in_transit, transfer_request, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, integration_exception, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-2-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-2-${run}`, siteAId, siteAId);
    siteBId = await seedLocation('site', `SITE-B-8-2-${run}`, null, null);
    binB1Id = await seedLocation('bin', `BIN-B1-8-2-${run}`, siteBId, siteBId);

    qcHeadUserId = await provisionUser(port, `qc-head-8-2-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-2-${run}@example.com`);

    // The inspector's read AND write scope is site A only (Binding Scope Decision 10 proofs).
    inspectorUserId = await provisionUser(port, `qc-inspector-8-2-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteAId },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteAId },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-8-2-${run}@example.com`);

    await provisionUser(port, `engineer-8-2-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-2-${run}@example.com`);

    await provisionUser(port, `cal-scheduler-8-2-${run}@example.com`, [
      {
        role: 'calibration_scheduler',
        module: 'maintenance',
        functionScope: 'write',
        locationId: '*',
      },
      {
        role: 'calibration_scheduler',
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    schedulerHeaders = await authFor(port, `cal-scheduler-8-2-${run}@example.com`);

    await provisionUser(port, `qc-reader-8-2-${run}@example.com`, [
      { role: `qc_reader_${run}`, module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `qc-reader-8-2-${run}@example.com`);

    await provisionUser(port, `proc-8-2-${run}@example.com`, [
      { role: 'buyer', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);
    procurementHeaders = await authFor(port, `proc-8-2-${run}@example.com`);

    await getPool().query(
      `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
       VALUES ($1, 'qc_head', 'qc.inspection_plan_approval', NULL, NULL, true)`,
      [randomUUID()],
    );

    componentItemId = await createItem(`CMP-8-2-${run}`, { lot_controlled: false });
    planDefault = await planOk('1.000', 'II');
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: sampling determination from the tables, frozen on the task
  // -------------------------------------------------------------------------

  it('AC1: derives code letter, sample size, Ac and Re from the tables for the frozen AQL, level, lot size and severity', async () => {
    const h = await heldLot(planDefault, '500.000000');
    const res = await determine(h.taskId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const s = sampling(res);
    assert.strictEqual(s['code_letter'], 'H');
    assert.strictEqual(s['resolved_code_letter'], 'H');
    assert.strictEqual(s['sample_size'], 50);
    assert.strictEqual(s['acceptance_number'], 1);
    assert.strictEqual(s['rejection_number'], 2);
    assert.strictEqual(s['severity'], 'normal');
    assert.strictEqual(s['inspection_level'], 'II');
    assert.strictEqual(s['aql'], '1.000');
    assert.strictEqual(s['lot_size'], 500);
    assert.strictEqual(s['sampling_basis'], 'aql_table');
    assert.strictEqual(s['standard_ref'], 'IS 2500 (Part 1):2000 / ISO 2859-1:1999');
    assert.strictEqual(s['critical_characteristic_count'], 1);
    assert.strictEqual(s['determined_by'], inspectorUserId);
    const task = res.body['task'] as Record<string, unknown>;
    assert.strictEqual(task['task_status'], 'sampling_determined');
    assert.strictEqual(task['sampling_id'], s['sampling_id']);
    assert.strictEqual(task['gate_status'], 'qc_hold');
    const ev = await eventRow(res.body['event_id']);
    assert.strictEqual(ev['event_type'], 'qc.sampling_determined');
    const payload = ev['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['sample_size'], 50);
    assert.strictEqual(payload['code_letter'], 'H');
    assert.strictEqual(payload['previous_task_status'], 'open');
    assert.strictEqual(payload['task_status'], 'sampling_determined');
    assert.deepStrictEqual(payload['critical_characteristic_ids'], [planDefault.lines[0]]);

    const j = await determine((await heldLot(planDefault, '1000.000000')).taskId);
    assert.strictEqual(j.status, 201, JSON.stringify(j.body));
    assert.deepStrictEqual(
      [
        sampling(j)['code_letter'],
        sampling(j)['sample_size'],
        sampling(j)['acceptance_number'],
        sampling(j)['rejection_number'],
      ],
      ['J', 80, 2, 3],
    );

    const plan25 = await planOk('2.500', 'II');
    const l = await determine((await heldLot(plan25, '5000.000000')).taskId);
    assert.strictEqual(l.status, 201, JSON.stringify(l.body));
    assert.deepStrictEqual(
      [
        sampling(l)['code_letter'],
        sampling(l)['sample_size'],
        sampling(l)['acceptance_number'],
        sampling(l)['rejection_number'],
      ],
      ['L', 200, 10, 11],
    );

    // Arrow case: F at AQL 1.0 resolves down to G with G's sample size.
    const f = await determine((await heldLot(planDefault, '100.000000')).taskId);
    assert.strictEqual(f.status, 201, JSON.stringify(f.body));
    assert.deepStrictEqual(
      [
        sampling(f)['code_letter'],
        sampling(f)['resolved_code_letter'],
        sampling(f)['sample_size'],
        sampling(f)['acceptance_number'],
        sampling(f)['rejection_number'],
      ],
      ['F', 'G', 32, 0, 1],
    );

    // Sample size at or above the lot size: the whole lot is inspected.
    const whole = await determine((await heldLot(planDefault, '5.000000')).taskId);
    assert.strictEqual(whole.status, 201, JSON.stringify(whole.body));
    assert.strictEqual(sampling(whole)['sample_size'], 5);
    assert.strictEqual(sampling(whole)['lot_size'], 5);
  });

  it('AC1: fractional quantities, non-preferred AQLs, unknown levels and discontinued inspection fail closed; null AQL is full inspection', async () => {
    const fractional = await heldLot(planDefault, '100.500000');
    const res = await determine(fractional.taskId);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SAMPLING_LOT_SIZE_INVALID');
    assert.strictEqual(detailsOf(res.body)['quantity'], '100.500000');
    assert.strictEqual((await taskRow(fractional.taskId))!['task_status'], 'open');
    assert.strictEqual(await countRows('qc_sampling_plan', 'task_id = $1', [fractional.taskId]), 0);

    // Semantic gates at plan creation (Task 5): the values sampling would reject are refused early.
    const badAql = await planFor('1.200', 'II');
    assert.ok(!('planId' in badAql));
    assert.strictEqual((badAql as HttpResult).status, 400, JSON.stringify(badAql));
    assert.strictEqual((badAql as HttpResult).body['error_code'], 'AQL_NOT_IN_STANDARD');
    const badLevel = await planFor('1.000', 'IV');
    assert.ok(!('planId' in badLevel));
    assert.strictEqual((badLevel as HttpResult).body['error_code'], 'INSPECTION_LEVEL_INVALID');

    const full = await planOk(null, null);
    const held = await heldLot(full, '37.000000');
    const det = await determine(held.taskId);
    assert.strictEqual(det.status, 201, JSON.stringify(det.body));
    assert.strictEqual(sampling(det)['sampling_basis'], 'full_inspection');
    assert.strictEqual(sampling(det)['sample_size'], 37);
    assert.strictEqual(sampling(det)['acceptance_number'], null);
    assert.strictEqual(sampling(det)['code_letter'], null);
    assert.strictEqual(sampling(det)['aql'], null);
  });

  it('AC1: a second determination replays the frozen plan; a direct event cannot declare derived fields or ride a foreign stream', async () => {
    const held = await heldLot(planDefault, '500.000000');
    const key = randomUUID();
    const first = await determine(held.taskId, inspectorHeaders, { idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replayKey = await determine(held.taskId, inspectorHeaders, { idempotency_key: key });
    assert.strictEqual(replayKey.status, 200, JSON.stringify(replayKey.body));
    assert.strictEqual(sampling(replayKey)['sampling_id'], sampling(first)['sampling_id']);
    const replayFresh = await determine(held.taskId);
    assert.strictEqual(replayFresh.status, 200, JSON.stringify(replayFresh.body));
    assert.strictEqual(sampling(replayFresh)['sampling_id'], sampling(first)['sampling_id']);
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'qc.sampling_determined' AND payload->>'task_id' = $1`,
        [held.taskId],
      ),
      1,
    );
    assert.strictEqual(await countRows('qc_sampling_plan', 'task_id = $1', [held.taskId]), 1);

    // The seam alone rejects a second plan for the task and every declared derived field.
    const base = {
      stream_type: 'qc',
      stream_id: held.taskId,
      event_type: 'qc.sampling_determined',
      payload: {
        task_id: held.taskId,
        sampling_id: randomUUID(),
        determined_at: new Date().toISOString(),
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    };
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      persistEvent({ ...base, payload: { ...base.payload, sample_size: 2 } } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'QC_DERIVATION_MISMATCH',
    );
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      persistEvent(base as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'QC_TASK_NOT_OPEN',
    );
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      persistEvent({ ...base, stream_type: 'inventory' } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'INVALID_PAYLOAD',
    );
    assert.strictEqual(await countRows('qc_sampling_plan', 'task_id = $1', [held.taskId]), 1);
  });

  // -------------------------------------------------------------------------
  // AC2: 100 % critical, sample-only major/minor, completeness, outcome
  // -------------------------------------------------------------------------

  it('AC2: critical lines need every lot unit, other lines every sample unit; completion refuses gaps; one critical nonconformity rejects the lot', async () => {
    const held = await heldLot(planDefault, '500.000000');
    const det = await determine(held.taskId);
    assert.strictEqual(det.status, 201, JSON.stringify(det.body));
    const [criticalId, minorId] = planDefault.lines as [string, string];
    const instrument = await calibratedInstrument();

    // Unit sample_size + 1 on the minor (sample-only) line is out of range.
    const outOfRange = await postObservations(held.taskId, minorId, attributeReadings(51, 51));
    assert.strictEqual(outOfRange.status, 400, JSON.stringify(outOfRange.body));
    assert.strictEqual(outOfRange.body['error_code'], 'QC_SAMPLE_UNIT_OUT_OF_RANGE');
    assert.strictEqual(detailsOf(outOfRange.body)['max_sample_unit_no'], 50);
    // The critical line accepts every lot unit; 501 readings in one event is refused, 500 accepted.
    const tooMany = await postResults(
      held.taskId,
      criticalId,
      instrument.assetId,
      numericReadings(1, 501),
    );
    assert.strictEqual(tooMany.status, 400, JSON.stringify(tooMany.body));
    const batch = await postResults(
      held.taskId,
      criticalId,
      instrument.assetId,
      numericReadings(1, 500, [60]),
    );
    assert.strictEqual(batch.status, 201, JSON.stringify(batch.body));
    const results = batch.body['results'] as Array<Record<string, unknown>>;
    assert.strictEqual(results.length, 500);
    const unit60 = results.find((r) => r['sample_unit_no'] === 60)!;
    assert.strictEqual(unit60['conforms'], false);
    assert.strictEqual(unit60['measured_value'], '300.000000');
    assert.strictEqual(unit60['instrument_id'], instrument.instrumentId);
    assert.strictEqual(results.find((r) => r['sample_unit_no'] === 1)!['conforms'], true);
    const unit501 = await postResults(
      held.taskId,
      criticalId,
      instrument.assetId,
      numericReadings(501, 501),
    );
    assert.strictEqual(unit501.body['error_code'], 'QC_SAMPLE_UNIT_OUT_OF_RANGE');

    // Completion refuses while the minor line has no results, listing the gap.
    const incomplete = await complete(held.taskId);
    assert.strictEqual(incomplete.status, 409, JSON.stringify(incomplete.body));
    assert.strictEqual(incomplete.body['error_code'], 'QC_INSPECTION_INCOMPLETE');
    assert.deepStrictEqual(detailsOf(incomplete.body)['missing'], [
      { characteristic_id: minorId, required: 50, recorded: 0 },
    ]);
    assert.strictEqual((await taskRow(held.taskId))!['task_status'], 'sampling_determined');

    const obs = await postObservations(held.taskId, minorId, attributeReadings(1, 50));
    assert.strictEqual(obs.status, 201, JSON.stringify(obs.body));
    const done = await complete(held.taskId);
    assert.strictEqual(done.status, 201, JSON.stringify(done.body));
    const task = done.body['task'] as Record<string, unknown>;
    // The single critical nonconformity on unit 60 (outside the 50-unit sample, count 0 < Ac 1)
    // still rejects the lot.
    assert.strictEqual(task['task_status'], 'inspected');
    assert.strictEqual(task['sampling_outcome'], 'not_accepted');
    assert.strictEqual(task['nonconforming_sample_units'], 0);
    assert.strictEqual(task['critical_nonconformities'], 1);
    assert.strictEqual(task['inspected_by'], inspectorUserId);
    assert.strictEqual(task['gate_status'], 'qc_hold');
    const payload = (await eventRow(done.body['event_id']))['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['sampling_outcome'], 'not_accepted');
    assert.strictEqual(payload['severity_used'], 'normal');
    assert.strictEqual(payload['previous_task_status'], 'sampling_determined');
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'notification.created' AND payload->>'object_id' = $1 AND payload->>'event_type' = 'qc_inspection_not_accepted' AND payload->'target'->>'role' = $2`,
        [held.taskId, config.quality.inspectionTaskNotificationRole],
      ),
      1,
    );
    // No further results after completion; a second completion is rejected.
    const late = await postObservations(held.taskId, minorId, attributeReadings(1, 1));
    assert.strictEqual(late.body['error_code'], 'QC_TASK_NOT_OPEN_FOR_RESULTS');
    const again = await complete(held.taskId);
    assert.strictEqual(again.body['error_code'], 'QC_TASK_NOT_OPEN_FOR_RESULTS');
    // Results before sampling is determined are refused.
    const early = await heldLot(planDefault, '10.000000');
    const noSampling = await postObservations(early.taskId, minorId, attributeReadings(1, 1));
    assert.strictEqual(noSampling.status, 409);
    assert.strictEqual(noSampling.body['error_code'], 'QC_SAMPLING_REQUIRED');
  });

  // -------------------------------------------------------------------------
  // AC3: switching rules per (plan, site)
  // -------------------------------------------------------------------------

  it('AC3: normal to tightened, tightened table on the next lot, back to normal after 5 accepted, discontinuation, resume, independent sites', async () => {
    const plan = await planOk('1.000', 'II', [minorAttribute(1)]);
    // Lot 5 under letter A resolves down the AQL 1.0 column: G (n = 32) on normal, so the whole
    // lot of 5 is inspected with Ac 0 / Re 1.
    const first = await inspectLot(plan, true);
    assert.strictEqual(sampling(first.determination)['resolved_code_letter'], 'G');
    assert.strictEqual(sampling(first.determination)['acceptance_number'], 0);
    assert.strictEqual(
      (first.completion.body['switching_state'] as Record<string, unknown>)['switching_score'],
      2,
    );
    await inspectLot(plan, false);
    await inspectLot(plan, true);
    const fourth = await inspectLot(plan, false);
    const afterFourth = fourth.completion.body['switching_state'] as Record<string, unknown>;
    assert.strictEqual(afterFourth['severity'], 'tightened');
    assert.strictEqual(afterFourth['switching_score'], 0);
    const payload = (await eventRow(fourth.completion.body['event_id']))['payload'] as Record<
      string,
      unknown
    >;
    assert.strictEqual(payload['previous_severity'], 'normal');
    assert.strictEqual(payload['new_severity'], 'tightened');
    // The next determination uses Table II-B (H at AQL 1.0 is the tightened Ac 0 cell).
    const fifth = await inspectLot(plan, true);
    assert.strictEqual(sampling(fifth.determination)['severity'], 'tightened');
    assert.strictEqual(sampling(fifth.determination)['resolved_code_letter'], 'H');
    for (let i = 0; i < 3; i += 1) await inspectLot(plan, true);
    assert.strictEqual((await stateRow(plan.planId, siteAId))!['severity'], 'tightened');
    const back = await inspectLot(plan, true);
    assert.strictEqual(
      (back.completion.body['switching_state'] as Record<string, unknown>)['severity'],
      'normal',
    );

    // Discontinuation: 2 not-accepted lots switch to tightened; 5 cumulative not-accepted lots on
    // tightened discontinue inspection.
    await inspectLot(plan, false);
    await inspectLot(plan, false);
    assert.strictEqual((await stateRow(plan.planId, siteAId))!['severity'], 'tightened');
    for (let i = 0; i < 4; i += 1) {
      await inspectLot(plan, false);
      await inspectLot(plan, true);
    }
    const last = await inspectLot(plan, false);
    const state = last.completion.body['switching_state'] as Record<string, unknown>;
    assert.strictEqual(state['inspection_discontinued'], true);
    const blocked = await heldLot(plan, '5.000000');
    const refused = await determine(blocked.taskId);
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body['error_code'], 'SAMPLING_INSPECTION_DISCONTINUED');
    assert.strictEqual((await taskRow(blocked.taskId))!['task_status'], 'open');

    // Only a QC Head-level role resumes; the inspector is refused and audited.
    const inspectorResume = await adjustState(
      plan.planId,
      siteAId,
      'resume_inspection',
      inspectorHeaders,
    );
    assert.strictEqual(inspectorResume.status, 403, JSON.stringify(inspectorResume.body));
    assert.strictEqual(inspectorResume.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(
      await countRows(
        'audit_log',
        `error_code = 'APPROVAL_REQUIRED' AND user_id = $1 AND location_id = $2 AND endpoint LIKE '%/sampling-states/%'`,
        [inspectorUserId, siteAId],
      ),
      1,
    );
    const notDiscontinued = await adjustState(
      plan.planId,
      siteBId,
      'resume_inspection',
      qcHeadHeaders,
    );
    assert.strictEqual(notDiscontinued.body['error_code'], 'SAMPLING_INSPECTION_NOT_DISCONTINUED');
    const resumed = await adjustState(plan.planId, siteAId, 'resume_inspection', qcHeadHeaders);
    assert.strictEqual(resumed.status, 201, JSON.stringify(resumed.body));
    const resumedState = resumed.body['switching_state'] as Record<string, unknown>;
    assert.strictEqual(resumedState['severity'], 'tightened');
    assert.strictEqual(resumedState['inspection_discontinued'], false);
    assert.strictEqual(resumedState['not_accepted_on_tightened'], 0);
    const resumedPayload = (await eventRow(resumed.body['event_id']))['payload'] as Record<
      string,
      unknown
    >;
    assert.strictEqual(resumedPayload['authorized_by'], qcHeadUserId);
    assert.strictEqual(resumedPayload['authorizing_role'], 'qc_head');
    const afterResume = await determine(blocked.taskId);
    assert.strictEqual(afterResume.status, 201, JSON.stringify(afterResume.body));
    assert.strictEqual(sampling(afterResume)['severity'], 'tightened');

    // A different site under the same plan has its own state (normal, untouched).
    const siteB = await inspectLot(plan, true, '5.000000', binB1Id, siteBId, qcHeadHeaders);
    assert.strictEqual(sampling(siteB.determination)['severity'], 'normal');
    assert.strictEqual(
      (siteB.completion.body['switching_state'] as Record<string, unknown>)['lots_counted'],
      1,
    );
    const states = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/sampling-states?plan_id=${plan.planId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(states.status, 200);
    assert.strictEqual((states.body['states'] as unknown[]).length, 2);
  });

  it('AC3: the switching score reaches 30 on an Ac >= 2 plan, a not-accepted lot resets it, reduced needs QC Head authority, Table II-C applies, and between Ac and Re returns to normal', async () => {
    // Lot 8 under AQL 40 / II is letter A (n = 2): Ac 2 / Re 3 on normal, with AQL 25 one step
    // tighter at A giving Ac 1 / Re 2.
    const plan = await planOk('40.000', 'II', [minorAttribute(1)]);
    const one = await inspectLot(plan, true, '8.000000');
    assert.deepStrictEqual(
      [
        sampling(one.determination)['code_letter'],
        sampling(one.determination)['sample_size'],
        sampling(one.determination)['acceptance_number'],
        sampling(one.determination)['rejection_number'],
      ],
      ['A', 2, 2, 3],
    );
    assert.strictEqual(
      (one.completion.body['switching_state'] as Record<string, unknown>)['switching_score'],
      3,
    );
    // A not-accepted lot (3 nonconforming of 2 sample units is impossible; use a critical line? No:
    // this plan has one minor line, so 2 nonconforming units < Re 3 is accepted. Reset the score
    // through the tighter-AQL rule instead: 2 nonconforming exceeds the tighter Ac 1.)
    const held2 = await heldLot(plan, '8.000000');
    assert.strictEqual((await determine(held2.taskId)).status, 201);
    assert.strictEqual(
      (await postObservations(held2.taskId, plan.lines[0]!, attributeReadings(1, 2, [1, 2])))
        .status,
      201,
    );
    const reset = await complete(held2.taskId);
    assert.strictEqual(reset.status, 201, JSON.stringify(reset.body));
    assert.strictEqual(
      (reset.body['task'] as Record<string, unknown>)['sampling_outcome'],
      'accepted',
    );
    assert.strictEqual(
      (reset.body['switching_state'] as Record<string, unknown>)['switching_score'],
      0,
    );

    // Not eligible yet.
    const early = await adjustState(plan.planId, siteAId, 'authorize_reduced', qcHeadHeaders);
    assert.strictEqual(early.status, 409, JSON.stringify(early.body));
    assert.strictEqual(early.body['error_code'], 'REDUCED_INSPECTION_NOT_ELIGIBLE');

    let state: Record<string, unknown> = {};
    for (let i = 0; i < 10; i += 1) {
      const lot = await inspectLot(plan, true, '8.000000');
      state = lot.completion.body['switching_state'] as Record<string, unknown>;
    }
    assert.strictEqual(state['switching_score'], 30);
    assert.strictEqual(state['reduced_eligible'], true);
    assert.strictEqual(state['severity'], 'normal');

    const inspectorAuthorize = await adjustState(
      plan.planId,
      siteAId,
      'authorize_reduced',
      inspectorHeaders,
    );
    assert.strictEqual(inspectorAuthorize.status, 403);
    assert.strictEqual(inspectorAuthorize.body['error_code'], 'APPROVAL_REQUIRED');
    const authorized = await adjustState(plan.planId, siteAId, 'authorize_reduced', qcHeadHeaders);
    assert.strictEqual(authorized.status, 201, JSON.stringify(authorized.body));
    assert.strictEqual(
      (authorized.body['switching_state'] as Record<string, unknown>)['severity'],
      'reduced',
    );

    // Table II-C: A at AQL 40 on reduced is Ac 1 / Re 3 with the reduced sample size 2; two
    // nonconforming units fall between Ac and Re, the lot is accepted and inspection returns to
    // normal.
    const reduced = await heldLot(plan, '8.000000');
    const det = await determine(reduced.taskId);
    assert.strictEqual(det.status, 201, JSON.stringify(det.body));
    assert.deepStrictEqual(
      [
        sampling(det)['severity'],
        sampling(det)['sample_size'],
        sampling(det)['acceptance_number'],
        sampling(det)['rejection_number'],
      ],
      ['reduced', 2, 1, 3],
    );
    assert.strictEqual(
      (await postObservations(reduced.taskId, plan.lines[0]!, attributeReadings(1, 2, [1, 2])))
        .status,
      201,
    );
    const between = await complete(reduced.taskId);
    assert.strictEqual(between.status, 201, JSON.stringify(between.body));
    assert.strictEqual(
      (between.body['task'] as Record<string, unknown>)['sampling_outcome'],
      'accepted',
    );
    assert.strictEqual(
      (between.body['task'] as Record<string, unknown>)['nonconforming_sample_units'],
      2,
    );
    assert.strictEqual(
      (between.body['switching_state'] as Record<string, unknown>)['severity'],
      'normal',
    );

    // Ac 0 / 1 plans score +2 per accepted lot.
    const two = await planOk('1.000', 'II', [minorAttribute(1)]);
    await inspectLot(two, true);
    const second = await inspectLot(two, true);
    assert.strictEqual(
      (second.completion.body['switching_state'] as Record<string, unknown>)['switching_score'],
      4,
    );
  });

  // -------------------------------------------------------------------------
  // AC4: instrument binding
  // -------------------------------------------------------------------------

  it('AC4: results bind the asset and the derived instrument key; observations and instruments are refused where the line forbids them; duplicates, uom and forged recorders fail', async () => {
    const held = await heldLot(planDefault, '100.000000');
    assert.strictEqual((await determine(held.taskId)).status, 201);
    const [criticalId, minorId] = planDefault.lines as [string, string];
    const instrument = await calibratedInstrument();

    const ok = await postResults(
      held.taskId,
      criticalId,
      instrument.assetId,
      numericReadings(1, 3),
    );
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    const row = (ok.body['results'] as Array<Record<string, unknown>>)[0]!;
    assert.strictEqual(row['instrument_asset_id'], instrument.assetId);
    assert.strictEqual(row['instrument_id'], instrument.instrumentId);
    assert.strictEqual(row['recorded_by'], inspectorUserId);
    assert.strictEqual(row['characteristic_class'], 'critical');
    const payload = (await eventRow(ok.body['event_id']))['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['instrument_id'], instrument.instrumentId);
    assert.strictEqual(payload['result_kind'], 'numeric');
    assert.strictEqual(Object.keys(payload['conforms_by_result_id'] as object).length, 3);

    const unregistered = await postResults(
      held.taskId,
      criticalId,
      randomUUID(),
      numericReadings(4, 4),
    );
    assert.strictEqual(unregistered.status, 404, JSON.stringify(unregistered.body));
    assert.strictEqual(unregistered.body['error_code'], 'INSTRUMENT_NOT_FOUND');

    const observationOnNumeric = await postObservations(
      held.taskId,
      criticalId,
      attributeReadings(4, 4),
    );
    assert.strictEqual(observationOnNumeric.status, 400, JSON.stringify(observationOnNumeric.body));
    assert.strictEqual(observationOnNumeric.body['error_code'], 'INSTRUMENT_REQUIRED');

    const instrumentOnAttribute = await postResults(
      held.taskId,
      minorId,
      instrument.assetId,
      attributeReadings(1, 1),
    );
    assert.strictEqual(
      instrumentOnAttribute.status,
      400,
      JSON.stringify(instrumentOnAttribute.body),
    );
    assert.strictEqual(instrumentOnAttribute.body['error_code'], 'INSTRUMENT_NOT_PERMITTED');

    const uom = await postResults(held.taskId, criticalId, instrument.assetId, [
      { sample_unit_no: 4, measured_value: '500.000000', measured_uom: 'psi' },
    ]);
    assert.strictEqual(uom.body['error_code'], 'QC_RESULT_UOM_MISMATCH');
    const kind = await postResults(held.taskId, criticalId, instrument.assetId, [
      { sample_unit_no: 4, attribute_conforms: true },
    ]);
    assert.strictEqual(kind.body['error_code'], 'QC_RESULT_KIND_MISMATCH');
    const notInPlan = await postObservations(held.taskId, randomUUID(), attributeReadings(1, 1));
    assert.strictEqual(notInPlan.body['error_code'], 'QC_CHARACTERISTIC_NOT_IN_PLAN');

    const duplicate = await postResults(
      held.taskId,
      criticalId,
      instrument.assetId,
      numericReadings(3, 3),
    );
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'QC_RESULT_EXISTS');
    assert.strictEqual(detailsOf(duplicate.body)['sample_unit_no'], 3);
    assert.strictEqual(await countRows('qc_inspection_result', 'task_id = $1', [held.taskId]), 3);

    const forged = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'qc',
        stream_id: held.taskId,
        event_type: 'qc.result_recorded',
        payload: {
          task_id: held.taskId,
          lot_id: held.lotId,
          characteristic_id: criticalId,
          instrument_asset_id: instrument.assetId,
          instrument_id: instrument.instrumentId,
          readings: [
            {
              result_id: randomUUID(),
              sample_unit_no: 9,
              measured_value: '500.000000',
              measured_uom: 'MPa',
            },
          ],
          recorded_at: new Date().toISOString(),
          recorded_by: qcHeadUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      inspectorHeaders,
    );
    assert.strictEqual(forged.status, 409, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'QC_DERIVATION_MISMATCH');
    assert.strictEqual(await countRows('qc_inspection_result', 'task_id = $1', [held.taskId]), 3);

    // Reads: filters and site scope.
    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/results?characteristic_id=${criticalId}&conforms=true`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(list.status, 200);
    assert.strictEqual((list.body['results'] as unknown[]).length, 3);
    const unit = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/results?sample_unit_no=2`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((unit.body['results'] as unknown[]).length, 1);
    const badFilter = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/results?conforms=maybe`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badFilter.status, 400);
    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/sampling`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(detail.status, 200);
    assert.strictEqual((detail.body['sampling'] as Record<string, unknown>)['sample_size'], 32);
  });

  // -------------------------------------------------------------------------
  // AC5: non-overridable calibration lockout
  // -------------------------------------------------------------------------

  it('AC5: an out-of-calibration instrument is 423 CALIBRATION_LOCKOUT for every role, persists nothing, is audited with the task site, and a lapsed replay stays locked', async () => {
    const held = await heldLot(planDefault, '100.000000');
    assert.strictEqual((await determine(held.taskId)).status, 201);
    const criticalId = planDefault.lines[0]!;
    const lapsing = await calibratedInstrument('2026-07-01');
    assert.strictEqual(await calibrationStatusOf(lapsing.instrumentId), 'calibrated');
    const key = randomUUID();
    const before = await postResults(
      held.taskId,
      criticalId,
      lapsing.assetId,
      numericReadings(1, 1),
      inspectorHeaders,
      { idempotency_key: key },
    );
    assert.strictEqual(before.status, 201, JSON.stringify(before.body));

    const scan = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/calibration/scan',
      { business_date: '2026-07-02' },
      schedulerHeaders,
    );
    assert.strictEqual(scan.status, 200, JSON.stringify(scan.body));
    assert.strictEqual(await calibrationStatusOf(lapsing.instrumentId), 'out_of_calibration');

    const eventsBefore = await countRows('domain_events', 'true', []);
    const resultsBefore = await countRows('qc_inspection_result', 'task_id = $1', [held.taskId]);
    const taskBefore = await taskRow(held.taskId);
    const locked = await postResults(
      held.taskId,
      criticalId,
      lapsing.assetId,
      numericReadings(2, 2),
      inspectorHeaders,
      { idempotency_key: `k-${run}-${randomUUID()}` },
    );
    assert.strictEqual(locked.status, 423, JSON.stringify(locked.body));
    assert.strictEqual(locked.body['error_code'], 'CALIBRATION_LOCKOUT');
    const head = await postResults(
      held.taskId,
      criticalId,
      lapsing.assetId,
      numericReadings(2, 2),
      qcHeadHeaders,
    );
    assert.strictEqual(head.status, 423, JSON.stringify(head.body));
    assert.strictEqual(head.body['error_code'], 'CALIBRATION_LOCKOUT');
    // Replay of the earlier (calibrated-time) key is locked too: the gate runs before replay.
    const replay = await postResults(
      held.taskId,
      criticalId,
      lapsing.assetId,
      numericReadings(1, 1),
      inspectorHeaders,
      { idempotency_key: key },
    );
    assert.strictEqual(replay.status, 423, JSON.stringify(replay.body));

    assert.strictEqual(await countRows('domain_events', 'true', []), eventsBefore);
    assert.strictEqual(
      await countRows('qc_inspection_result', 'task_id = $1', [held.taskId]),
      resultsBefore,
    );
    assert.deepStrictEqual(await taskRow(held.taskId), taskBefore);
    const audit = await getAdminPool().query(
      `SELECT user_id, location_id, endpoint, trace_id, error_code, details FROM audit_log
        WHERE error_code = 'CALIBRATION_LOCKOUT' AND details->>'task_id' = $1 ORDER BY seq_no ASC`,
      [held.taskId],
    );
    assert.strictEqual(audit.rows.length, 3, JSON.stringify(audit.rows));
    const first = audit.rows[0] as Record<string, unknown>;
    assert.strictEqual(first['user_id'], inspectorUserId);
    assert.strictEqual(first['location_id'], siteAId);
    assert.ok((first['endpoint'] as string).endsWith(`/qc/tasks/${held.taskId}/results`));
    assert.ok(typeof first['trace_id'] === 'string' && (first['trace_id'] as string).length > 0);
    const details = first['details'] as Record<string, unknown>;
    assert.strictEqual(details['lot_id'], held.lotId);
    assert.strictEqual(details['instrument_asset_id'], lapsing.assetId);
    assert.strictEqual(details['instrument_id'], lapsing.instrumentId);
    assert.strictEqual((audit.rows[1] as Record<string, unknown>)['user_id'], qcHeadUserId);

    // A direct event pairing a CALIBRATED instrument key with the lapsed asset cannot get through.
    const calibrated = await calibratedInstrument();
    const paired = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'qc',
        stream_id: held.taskId,
        event_type: 'qc.result_recorded',
        payload: {
          task_id: held.taskId,
          lot_id: held.lotId,
          characteristic_id: criticalId,
          instrument_asset_id: lapsing.assetId,
          instrument_id: calibrated.instrumentId,
          readings: [
            {
              result_id: randomUUID(),
              sample_unit_no: 7,
              measured_value: '500.000000',
              measured_uom: 'MPa',
            },
          ],
          recorded_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      inspectorHeaders,
    );
    assert.ok([409, 423].includes(paired.status), JSON.stringify(paired.body));
    assert.ok(
      ['QC_DERIVATION_MISMATCH', 'CALIBRATION_LOCKOUT'].includes(
        paired.body['error_code'] as string,
      ),
    );
    assert.strictEqual(
      await countRows('qc_inspection_result', 'task_id = $1', [held.taskId]),
      resultsBefore,
    );
    // The Story 1.7 synthetic route is byte-for-byte preserved: locked instrument 423, calibrated 201.
    const synthetic = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/results',
      { instrument_id: lapsing.instrumentId, lot_id: held.lotNumber, parameter: 'ph', value: 7 },
      inspectorHeaders,
    );
    assert.strictEqual(synthetic.status, 423);
    const syntheticOk = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/results',
      { instrument_id: calibrated.instrumentId, lot_id: held.lotNumber, parameter: 'ph', value: 7 },
      inspectorHeaders,
    );
    assert.strictEqual(syntheticOk.status, 201, JSON.stringify(syntheticOk.body));
    assert.strictEqual(
      await countRows('qc_inspection_result', 'task_id = $1', [held.taskId]),
      resultsBefore,
    );
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  it('concurrency: one plan, one row per unit, one completion, and a completion racing a result never loses the result', async () => {
    const plan = await planOk('1.000', 'II', [minorAttribute(1)]);
    const held = await heldLot(plan, '5.000000');
    const [a, b] = await Promise.all([determine(held.taskId), determine(held.taskId)]);
    assert.ok([a.status, b.status].includes(201), JSON.stringify([a.body, b.body]));
    assert.ok([a.status, b.status].every((s) => [200, 201, 409].includes(s)));
    assert.strictEqual(await countRows('qc_sampling_plan', 'task_id = $1', [held.taskId]), 1);

    const line = plan.lines[0]!;
    const [r1, r2] = await Promise.all([
      postObservations(held.taskId, line, attributeReadings(1, 1)),
      postObservations(held.taskId, line, attributeReadings(1, 1)),
    ]);
    assert.deepStrictEqual(
      [r1.status, r2.status].sort(),
      [201, 409],
      JSON.stringify([r1.body, r2.body]),
    );
    assert.strictEqual(
      await countRows('qc_inspection_result', 'task_id = $1 AND sample_unit_no = 1', [held.taskId]),
      1,
    );

    // A completion racing the last required result: both hold the task row, so either the
    // completion sees the full set (201) or refuses as incomplete (409); the result is never lost.
    assert.strictEqual(
      (await postObservations(held.taskId, line, attributeReadings(2, 4))).status,
      201,
    );
    const [lastResult, race] = await Promise.all([
      postObservations(held.taskId, line, attributeReadings(5, 5)),
      complete(held.taskId),
    ]);
    assert.strictEqual(lastResult.status, 201, JSON.stringify(lastResult.body));
    assert.ok([201, 409].includes(race.status), JSON.stringify(race.body));
    assert.strictEqual(await countRows('qc_inspection_result', 'task_id = $1', [held.taskId]), 5);
    if (race.status === 409) {
      assert.strictEqual(race.body['error_code'], 'QC_INSPECTION_INCOMPLETE');
      assert.strictEqual((await complete(held.taskId)).status, 201);
    }
    const [c1, c2] = await Promise.all([complete(held.taskId), complete(held.taskId)]);
    assert.ok(c1.status === 409 && c2.status === 409, JSON.stringify([c1.body, c2.body]));
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'qc.inspection_completed' AND payload->>'task_id' = $1`,
        [held.taskId],
      ),
      1,
    );
  });

  // -------------------------------------------------------------------------
  // Read scope, edge classification, RBAC
  // -------------------------------------------------------------------------

  it('read scope: a site A inspector cannot read site B tasks, sampling or results; lists are narrowed', async () => {
    const b = await heldLot(planDefault, '10.000000', binB1Id, siteBId, qcHeadHeaders);
    assert.strictEqual((await determine(b.taskId, qcHeadHeaders)).status, 201);
    for (const path of [
      `/api/v1/qc/tasks/${b.taskId}`,
      `/api/v1/qc/tasks/${b.taskId}/sampling`,
      `/api/v1/qc/tasks/${b.taskId}/results`,
    ]) {
      const res = await makeRequest(port, 'GET', path, undefined, inspectorHeaders);
      assert.strictEqual(res.status, 403, `${path}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }
    const write = await determine(b.taskId, inspectorHeaders);
    assert.strictEqual(write.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/qc/tasks?limit=500',
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(list.status, 200);
    const tasks = list.body['tasks'] as Array<Record<string, unknown>>;
    assert.ok(tasks.length >= 1);
    assert.ok(tasks.every((t) => t['site_id'] === siteAId));
    const filtered = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks?site_id=${siteBId}`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(filtered.status, 403);
    const states = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/sampling-states?site_id=${siteBId}`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(states.status, 403);
    const wildcard = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${b.taskId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(wildcard.status, 200);
    assert.strictEqual((wildcard.body['sampling'] as Record<string, unknown>)['sample_size'], 10);
    const byStatus = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks?task_status=inspected&limit=500`,
      undefined,
      readerHeaders,
    );
    assert.ok(
      (byStatus.body['tasks'] as Array<Record<string, unknown>>).every(
        (t) => t['task_status'] === 'inspected',
      ),
    );
  });

  it('edge: every Story 8.2 command except qc.result_recorded is CENTRAL_ONLY_OPERATION on the edge route', async () => {
    const held = await heldLot(planDefault, '10.000000');
    for (const [eventType, payload] of [
      [
        'qc.sampling_determined',
        {
          task_id: held.taskId,
          sampling_id: randomUUID(),
          determined_at: new Date().toISOString(),
        },
      ],
      ['qc.inspection_completed', { task_id: held.taskId, completed_at: new Date().toISOString() }],
      [
        'qc.observation_recorded',
        {
          task_id: held.taskId,
          lot_id: held.lotId,
          characteristic_id: planDefault.lines[1],
          readings: [{ result_id: randomUUID(), sample_unit_no: 1, attribute_conforms: true }],
          recorded_at: new Date().toISOString(),
        },
      ],
    ] as Array<[string, Record<string, unknown>]>) {
      const eventId = randomUUID();
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          event_id: eventId,
          stream_type: 'qc',
          stream_id: held.taskId,
          event_type: eventType,
          event_version: 1,
          payload,
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
            device_id: DEVICE_ID,
            capture_method: 'MANUAL',
            occurred_at: new Date().toISOString(),
          },
          schema_version: 1,
          idempotency_key: `edge-8-2-${eventId}`,
        },
        inspectorHeaders,
      );
      assert.strictEqual(res.status, 403, `${eventType}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    }
    assert.strictEqual((await taskRow(held.taskId))!['task_status'], 'open');
    // qc.sampling_state_adjusted is plan-scoped (stream_id is plan_id, not task_id), so it is
    // asserted separately from the task-scoped loop above rather than folded into it.
    const adjustEventId = randomUUID();
    const adjustRes = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: adjustEventId,
        stream_type: 'qc',
        stream_id: planDefault.planId,
        event_type: 'qc.sampling_state_adjusted',
        event_version: 1,
        payload: {
          plan_id: planDefault.planId,
          site_id: siteAId,
          action: 'authorize_reduced',
          reason: 'edge central-only sweep',
          adjusted_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
          device_id: DEVICE_ID,
          capture_method: 'MANUAL',
          occurred_at: new Date().toISOString(),
        },
        schema_version: 1,
        idempotency_key: `edge-8-2-${adjustEventId}`,
      },
      inspectorHeaders,
    );
    assert.strictEqual(adjustRes.status, 403, JSON.stringify(adjustRes.body));
    assert.strictEqual(adjustRes.body['error_code'], 'CENTRAL_ONLY_OPERATION');
  });

  it('RBAC: 401/403 sweep on every new route', async () => {
    const id = randomUUID();
    const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['POST', `/api/v1/qc/tasks/${id}/sampling`, {}],
      ['GET', `/api/v1/qc/tasks/${id}/sampling`, undefined],
      [
        'POST',
        `/api/v1/qc/tasks/${id}/results`,
        { characteristic_id: id, instrument_asset_id: id, readings: [] },
      ],
      ['POST', `/api/v1/qc/tasks/${id}/observations`, { characteristic_id: id, readings: [] }],
      ['GET', `/api/v1/qc/tasks/${id}/results`, undefined],
      ['POST', `/api/v1/qc/tasks/${id}/inspection-completion`, {}],
      ['GET', '/api/v1/qc/sampling-states', undefined],
      [
        'POST',
        `/api/v1/qc/sampling-states/${id}/sites/${id}/actions`,
        { action: 'resume_inspection', reason: 'x' },
      ],
    ];
    for (const [method, path, body] of routes) {
      const anonymous = await makeRequest(port, method, path, body);
      assert.strictEqual(anonymous.status, 401, `${method} ${path} anonymous`);
      const outsider = await makeRequest(port, method, path, body, procurementHeaders);
      assert.strictEqual(outsider.status, 403, `${method} ${path} outsider`);
      assert.strictEqual(outsider.body['error_code'], 'MODULE_ACCESS_DENIED');
    }
    for (const [method, path, body] of routes.filter(([m]) => m === 'POST')) {
      const reader = await makeRequest(port, method, path, body, readerHeaders);
      assert.strictEqual(reader.status, 403, `${method} ${path} reader`);
      assert.strictEqual(reader.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    }
    const missing = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${id}/sampling`,
      {},
      qcHeadHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'QC_TASK_NOT_FOUND');
  });
});

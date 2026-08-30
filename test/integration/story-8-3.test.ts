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
 * Story 8.3 Lot Disposition - Accept, Reject, Conditional Release (FR-Q-05, FR-Q-06, FR-Q-13).
 * Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Dedicated
 * routes carry the ordinary behaviour; direct POST /api/v1/events carries the forgery, derivation
 * and central-only proofs. Tests run serially; every identifier is run-scoped and every date is a
 * fixed anchor.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DEVICE_ID = `edge-8-3-${run}`;

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
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
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

describe('Story 8.3 Lot Disposition - Accept, Reject, Conditional Release', () => {
  let server: Server;
  let port: number;

  let inspectorUserId: string;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let engineerUserId: string;
  let engineerHeaders: Record<string, string>;
  let procurementHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let siteBId: string;
  let binB1Id: string;
  let componentItemId: string;
  let supplierId: string;

  /** A single instrument-less minor-attribute line: inspection needs no calibrated instrument. */
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
        description: `Story 8.3 item ${sku}`,
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
    const sku = `FG-8-3-${run}-${planCounter}`;
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
  async function heldLot(
    plan: Plan,
    quantity: string,
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Held> {
    lotCounter += 1;
    const lotId = randomUUID();
    const lotNumber = `FG-LOT-8-3-${run}-${lotCounter}`;
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

  /** Drives one held lot all the way to task_status 'inspected' with the chosen outcome. */
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
    headers: Record<string, string> = inspectorHeaders,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      {
        disposition: kind,
        justification: `Story 8.3 ${kind} decision`,
        ...extra,
      },
      headers,
    );
  }

  async function split(
    taskId: string,
    quantities: string[],
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/split`,
      {
        justification: 'Story 8.3 partial conformance',
        splits: quantities.map((quantity, index) => ({ sequence: index + 1, quantity })),
      },
      headers,
    );
  }

  async function ncrOutcome(
    ncrId: string,
    outcome: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/ncrs/${ncrId}/outcome`,
      { outcome, outcome_reason: `Story 8.3 ${outcome}`, ...extra },
      headers,
    );
  }

  async function taskRow(taskId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(`SELECT * FROM qc_inspection_task WHERE task_id = $1`, [
      taskId,
    ]);
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function lotRow(lotId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(`SELECT * FROM lot_master WHERE lot_id = $1`, [lotId]);
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function ownedOnHand(sku: string, lotNumber: string): Promise<string> {
    const r = await getAdminPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS total FROM stock_balance
        WHERE sku = $1 AND lot_id = $2 AND stock_class = 'owned'`,
      [sku, lotNumber],
    );
    return r.rows[0]!['total'] as string;
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

  function inventoryEnvelope(
    eventType: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: eventType,
      payload: { business_stream: 'production', ...payload },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: engineerUserId, role: 'inventory_controller', location_id: binA1Id },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: randomUUID(),
    };
  }

  async function postEvent(
    envelope: Record<string, unknown>,
    headers: Record<string, string> = engineerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/events', envelope, headers);
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-3-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-3-${run}`, siteAId, siteAId);
    siteBId = await seedLocation('site', `SITE-B-8-3-${run}`, null, null);
    binB1Id = await seedLocation('bin', `BIN-B1-8-3-${run}`, siteBId, siteBId);

    await provisionUser(port, `qc-head-8-3-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-3-${run}@example.com`);

    // The inspector's read AND write scope is site A only (the AC 6 site-scope proofs).
    inspectorUserId = await provisionUser(port, `qc-inspector-8-3-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteAId },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteAId },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-8-3-${run}@example.com`);

    engineerUserId = await provisionUser(port, `engineer-8-3-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-3-${run}@example.com`);

    await provisionUser(port, `proc-8-3-${run}@example.com`, [
      { role: 'buyer', module: 'procurement', functionScope: 'write', locationId: '*' },
      { role: 'buyer', module: 'procurement', functionScope: 'read', locationId: '*' },
    ]);
    procurementHeaders = await authFor(port, `proc-8-3-${run}@example.com`);

    await getPool().query(
      `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
       VALUES ($1, 'qc_head', 'qc.inspection_plan_approval', NULL, NULL, true)`,
      [randomUUID()],
    );

    supplierId = randomUUID();
    await getPool().query(
      `INSERT INTO supplier (supplier_id, legal_name, owner_party_code, status, created_by)
       VALUES ($1, $2, $3, 'active', $4)`,
      [supplierId, `Job Worker 8-3 ${run}`, `JW${run.slice(0, 6).toUpperCase()}`, engineerUserId],
    );

    componentItemId = await createItem(`CMP-8-3-${run}`, { lot_controlled: false });
    planDefault = await planOk();
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: exactly one disposition per lot
  // -------------------------------------------------------------------------

  it('AC1: an accept stores one disposition, moves the gate to accepted, and writes back every derived field', async () => {
    const held = await inspected(planDefault, '10.000000');
    const res = await disposition(held.taskId, 'accept');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const row = res.body['disposition'] as Record<string, unknown>;
    assert.strictEqual(row['disposition'], 'accept');
    assert.strictEqual(row['lot_id'], held.lotId);
    assert.strictEqual(row['task_id'], held.taskId);
    assert.strictEqual(row['deviation_id'], null);
    assert.strictEqual(row['doa_entry_id'], null, 'accept must not fabricate a DOA reference');
    assert.strictEqual(row['ncr_id'], null);
    assert.strictEqual(row['sampling_outcome'], 'accepted');
    assert.strictEqual(row['requested_by'], inspectorUserId);
    assert.strictEqual(row['approved_by'], inspectorUserId);
    assert.strictEqual(row['inspector_user_id'], inspectorUserId);
    assert.strictEqual(row['quantity'], '10.000000');
    assert.strictEqual(res.body['ncr'], null);

    const task = (res.body['task'] as Record<string, unknown>) ?? {};
    assert.strictEqual(task['gate_status'], 'accepted');

    const ev = await eventRow(res.body['event_id']);
    assert.strictEqual(ev['event_type'], 'qc.lot_dispositioned');
    assert.strictEqual(ev['stream_type'], 'qc');
    const payload = ev['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['previous_gate_status'], 'qc_hold');
    assert.strictEqual(payload['gate_status'], 'accepted');
    assert.strictEqual(payload['lot_number'], held.lotNumber);
    assert.strictEqual(payload['sku'], planDefault.sku);
    assert.strictEqual(payload['site_id'], siteAId);
    assert.strictEqual(payload['quantity'], '10.000000');
    assert.strictEqual(payload['sampling_outcome'], 'accepted');

    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 1);
    assert.strictEqual(await countRows('qc_ncr', 'lot_id = $1', [held.lotId]), 0);
    // The notification is emitted transactionally (AD-17): the notifications ROW is written later
    // by the dispatcher, so the atomic guarantee is the notification.created event itself.
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'notification.created' AND payload->>'object_id' = $1 AND payload->>'event_type' = 'qc_lot_dispositioned'`,
        [held.taskId],
      ),
      1,
    );
  });

  it('AC1: a second disposition attempt is DISPOSITION_EXISTS and changes nothing', async () => {
    const held = await inspected(planDefault, '8.000000');
    const first = await disposition(held.taskId, 'accept');
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const dispositionId = (first.body['disposition'] as Record<string, unknown>)[
      'disposition_id'
    ] as string;

    const second = await disposition(held.taskId, 'reject');
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DISPOSITION_EXISTS');
    assert.strictEqual(detailsOf(second.body)['existing_disposition_id'], dispositionId);
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 1);
    assert.strictEqual(await countRows('qc_ncr', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual((await taskRow(held.taskId))?.['gate_status'], 'accepted');
  });

  it('AC1: two concurrent dispositions of one lot produce exactly one disposition', async () => {
    const held = await inspected(planDefault, '6.000000');
    const [a, b] = await Promise.all([
      disposition(held.taskId, 'accept'),
      disposition(held.taskId, 'accept'),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepStrictEqual(statuses, [201, 409], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
    const loser = a.status === 409 ? a : b;
    assert.strictEqual(loser.body['error_code'], 'DISPOSITION_EXISTS');
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 1);
  });

  it('AC1: a disposition before inspection completes is QC_INSPECTION_REQUIRED from both open states', async () => {
    const open = await heldLot(planDefault, '5.000000');
    const fromOpen = await disposition(open.taskId, 'accept');
    assert.strictEqual(fromOpen.status, 409, JSON.stringify(fromOpen.body));
    assert.strictEqual(fromOpen.body['error_code'], 'QC_INSPECTION_REQUIRED');
    assert.strictEqual(detailsOf(fromOpen.body)['task_status'], 'open');

    const sampled = await heldLot(planDefault, '5.000000');
    const determination = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${sampled.taskId}/sampling`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(determination.status, 201, JSON.stringify(determination.body));
    const fromSampled = await disposition(sampled.taskId, 'accept');
    assert.strictEqual(fromSampled.status, 409, JSON.stringify(fromSampled.body));
    assert.strictEqual(fromSampled.body['error_code'], 'QC_INSPECTION_REQUIRED');
    assert.strictEqual(detailsOf(fromSampled.body)['task_status'], 'sampling_determined');
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [sampled.lotId]), 0);
  });

  it('AC1 and AC3: a reject stores the disposition and raises exactly one open NCR', async () => {
    const held = await inspected(planDefault, '12.000000', false);
    const res = await disposition(held.taskId, 'reject');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = res.body['disposition'] as Record<string, unknown>;
    const ncr = res.body['ncr'] as Record<string, unknown>;
    assert.strictEqual(row['disposition'], 'reject');
    assert.strictEqual(row['ncr_id'], ncr['ncr_id']);
    assert.strictEqual(ncr['outcome'], null, 'a fresh NCR is open');
    assert.strictEqual(ncr['lot_id'], held.lotId);
    assert.strictEqual(ncr['quantity'], '12.000000');
    assert.strictEqual(ncr['site_id'], siteAId);
    assert.strictEqual(ncr['raised_by'], inspectorUserId);
    assert.strictEqual((await taskRow(held.taskId))?.['gate_status'], 'rejected');
    assert.strictEqual(await countRows('qc_ncr', 'lot_id = $1', [held.lotId]), 1);
  });

  // -------------------------------------------------------------------------
  // AC2: partial split
  // -------------------------------------------------------------------------

  it('AC2: a three-way split creates child lots and tasks, relabels the stock, and terminates the parent', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '30.000000');
    const res = await split(held.taskId, ['10.000000', '15.000000', '5.000000']);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const parent = res.body['disposition'] as Record<string, unknown>;
    assert.strictEqual(parent['disposition'], 'split');
    assert.strictEqual(parent['quantity'], '30.000000');
    assert.strictEqual((await taskRow(held.taskId))?.['gate_status'], 'split');
    assert.strictEqual(await ownedOnHand(plan.sku, held.lotNumber), '0.000000');

    const splits = res.body['splits'] as Array<Record<string, unknown>>;
    assert.strictEqual(splits.length, 3);
    const expected = ['10.000000', '15.000000', '5.000000'];
    for (const [index, child] of splits.entries()) {
      assert.strictEqual(child['sequence'], index + 1);
      assert.strictEqual(child['quantity'], expected[index]);
      assert.strictEqual(child['child_lot_number'], `${held.lotNumber}-0${index + 1}`);
      assert.strictEqual(
        await ownedOnHand(plan.sku, child['child_lot_number'] as string),
        expected[index],
      );
      const childTask = await taskRow(child['child_task_id'] as string);
      assert.ok(childTask, 'child task exists');
      assert.strictEqual(childTask['gate_status'], 'qc_hold');
      assert.strictEqual(childTask['task_status'], 'inspected', 'children inherit the inspection');
      assert.strictEqual(childTask['plan_version_id'], plan.versionId);
      assert.strictEqual(childTask['quantity'], expected[index]);
      assert.strictEqual(childTask['inspected_by'], inspectorUserId);
      assert.notStrictEqual(childTask['source_completion_id'], null);
    }

    // AC2: independent dispositions per split.
    const first = await disposition(splits[0]!['child_task_id'] as string, 'accept');
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await disposition(splits[1]!['child_task_id'] as string, 'reject');
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.strictEqual(
      (await taskRow(splits[0]!['child_task_id'] as string))?.['gate_status'],
      'accepted',
    );
    assert.strictEqual(
      (await taskRow(splits[1]!['child_task_id'] as string))?.['gate_status'],
      'rejected',
    );
    assert.strictEqual(
      (await taskRow(splits[2]!['child_task_id'] as string))?.['gate_status'],
      'qc_hold',
      'an un-dispositioned child stays at the gate',
    );

    const ev = await eventRow(res.body['event_id']);
    assert.strictEqual(ev['event_type'], 'qc.lot_split_recorded');
    const payload = ev['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['gate_status'], 'split');
    assert.strictEqual(
      (payload['splits'] as Array<Record<string, unknown>>)[0]!['lot_number'],
      `${held.lotNumber}-01`,
    );
  });

  it('AC2: a split whose quantities do not sum to the lot is QC_SPLIT_QUANTITY_MISMATCH with no partial write', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '20.000000');
    const res = await split(held.taskId, ['10.000000', '5.000000']);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'QC_SPLIT_QUANTITY_MISMATCH');
    assert.strictEqual(detailsOf(res.body)['split_total'], '15.000000');
    assert.strictEqual(await countRows('qc_lot_split', 'parent_lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(
      await countRows('lot_master', 'lot_number LIKE $1', [`${held.lotNumber}-%`]),
      0,
    );
    assert.strictEqual(await ownedOnHand(plan.sku, held.lotNumber), '20.000000');
    assert.strictEqual((await taskRow(held.taskId))?.['gate_status'], 'qc_hold');
  });

  it('AC2: a split of an allocated lot is INSUFFICIENT_STOCK with no partial write', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '20.000000');
    // A QC-gated lot should never be allocated; force the corrupted state to prove the guard.
    await getAdminPool().query(
      `UPDATE stock_balance SET allocated = 5 WHERE sku = $1 AND lot_id = $2`,
      [plan.sku, held.lotNumber],
    );
    const res = await split(held.taskId, ['10.000000', '10.000000']);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(await countRows('qc_lot_split', 'parent_lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(
      await countRows('lot_master', 'lot_number LIKE $1', [`${held.lotNumber}-%`]),
      0,
    );
    assert.strictEqual(await ownedOnHand(plan.sku, held.lotNumber), '20.000000');
  });

  it('AC2: a split of fewer than two children is QC_SPLIT_INVALID', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '9.000000');
    const res = await split(held.taskId, ['9.000000']);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'QC_SPLIT_INVALID');
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 0);
  });

  // -------------------------------------------------------------------------
  // AC3, AC4, AC5: NCR outcomes
  // -------------------------------------------------------------------------

  async function rejectedLot(
    plan: Plan,
    quantity: string = '10.000000',
  ): Promise<{ held: Held; ncrId: string; dispositionId: string }> {
    const held = await inspected(plan, quantity, false);
    const res = await disposition(held.taskId, 'reject');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return {
      held,
      ncrId: (res.body['ncr'] as Record<string, unknown>)['ncr_id'] as string,
      dispositionId: (res.body['disposition'] as Record<string, unknown>)[
        'disposition_id'
      ] as string,
    };
  }

  it('AC3: a scrap outcome blocks the lot on the hold axis and moves no stock', async () => {
    const plan = await planOk();
    const { held, ncrId } = await rejectedLot(plan);
    const res = await ncrOutcome(ncrId, 'scrap');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const ncr = res.body['ncr'] as Record<string, unknown>;
    assert.strictEqual(ncr['outcome'], 'scrap');
    assert.strictEqual(ncr['outcome_by'], inspectorUserId);
    assert.strictEqual(ncr['downgrade_lot_id'], null);
    assert.strictEqual(ncr['rework_requested_event_id'], null);

    const lot = await lotRow(held.lotId);
    assert.strictEqual(lot?.['quality_hold_status'], 'held');
    assert.strictEqual(lot?.['quality_hold_reason'], 'scrap_pending');
    assert.strictEqual(await ownedOnHand(plan.sku, held.lotNumber), '10.000000');

    const ev = await eventRow(res.body['event_id']);
    assert.strictEqual(ev['event_type'], 'qc.ncr_outcome_recorded');
    assert.strictEqual((ev['payload'] as Record<string, unknown>)['quality_hold_status'], 'held');
  });

  it('AC3: a second NCR outcome is NCR_OUTCOME_EXISTS', async () => {
    const plan = await planOk();
    const { ncrId } = await rejectedLot(plan);
    assert.strictEqual((await ncrOutcome(ncrId, 'scrap')).status, 201);
    const second = await ncrOutcome(ncrId, 'rework');
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'NCR_OUTCOME_EXISTS');
  });

  it('AC6: a lot under an independent manual hold cannot have its NCR outcome recorded', async () => {
    const plan = await planOk();
    const { held, ncrId } = await rejectedLot(plan);
    await getAdminPool().query(
      `UPDATE lot_master SET quality_hold_status = 'held', quality_hold_reason = 'recall' WHERE lot_id = $1`,
      [held.lotId],
    );
    const res = await ncrOutcome(ncrId, 'scrap');
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual(await countRows('qc_ncr', 'ncr_id = $1 AND outcome IS NOT NULL', [ncrId]), 0);
  });

  it('AC3: two concurrent identical-key rework outcomes on one NCR never produce a stale-replay QC_REWORK_NOT_DERIVED', async () => {
    // Regression guard for the check-then-act replay race fixed in recordNcrOutcomeBase: a same-key
    // retry must resolve to either a clean replay (200/201 sharing one event_id, if both requests
    // reach persistEvent before either commits) or a legitimate sequential NCR_OUTCOME_EXISTS (if
    // request ordering happens to serialize before the race window) - but never the old bug's
    // symptom, where the DB-race loser still tried to persist its own stale rework companion event
    // and got rejected by applyReworkRequested's QC_REWORK_NOT_DERIVED guard.
    const plan = await planOk();
    const { ncrId } = await rejectedLot(plan);
    const idempotencyKey = randomUUID();
    const [a, b] = await Promise.all([
      ncrOutcome(ncrId, 'rework', { idempotency_key: idempotencyKey }),
      ncrOutcome(ncrId, 'rework', { idempotency_key: idempotencyKey }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    const bodies = `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`;
    assert.notStrictEqual(a.body['error_code'], 'QC_REWORK_NOT_DERIVED', bodies);
    assert.notStrictEqual(b.body['error_code'], 'QC_REWORK_NOT_DERIVED', bodies);
    if (statuses[1] === 409) {
      assert.deepStrictEqual(statuses, [201, 409], bodies);
      const loser = a.status === 409 ? a : b;
      assert.strictEqual(loser.body['error_code'], 'NCR_OUTCOME_EXISTS', bodies);
    } else {
      assert.deepStrictEqual(statuses, [200, 201], bodies);
      assert.strictEqual(a.body['event_id'], b.body['event_id'], 'both requests resolve to the same event');
    }
    assert.strictEqual(await countRows('qc_ncr', 'ncr_id = $1 AND outcome = $2', [ncrId, 'rework']), 1);
  });

  it('AC4: a downgrade relabels the quantity onto an ungoverned seconds lot', async () => {
    const plan = await planOk();
    const secondsSku = `FG-8-3-SECONDS-${run}`;
    await createItem(secondsSku);
    const { held, ncrId } = await rejectedLot(plan);

    const res = await ncrOutcome(ncrId, 'downgrade', { downgrade_sku: secondsSku });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const ncr = res.body['ncr'] as Record<string, unknown>;
    assert.strictEqual(ncr['outcome'], 'downgrade');
    assert.strictEqual(ncr['downgrade_sku'], secondsSku);
    assert.ok(ncr['downgrade_lot_id'], 'a downgrade lot was created');

    assert.strictEqual(await ownedOnHand(plan.sku, held.lotNumber), '0.000000');
    assert.strictEqual(await ownedOnHand(secondsSku, `${held.lotNumber}-DG`), '10.000000');
    assert.strictEqual(
      await countRows('qc_inspection_task', 'lot_id = $1', [ncr['downgrade_lot_id']]),
      0,
      'the downgrade lot is ungoverned',
    );
  });

  it('AC4: a downgrade SKU that is unknown or equal to the lot SKU is DOWNGRADE_SKU_INVALID', async () => {
    const plan = await planOk();
    const { ncrId } = await rejectedLot(plan);
    const unknown = await ncrOutcome(ncrId, 'downgrade', {
      downgrade_sku: `NO-SUCH-SKU-${run}`,
    });
    assert.strictEqual(unknown.status, 400, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'DOWNGRADE_SKU_INVALID');

    const same = await ncrOutcome(ncrId, 'downgrade', { downgrade_sku: plan.sku });
    assert.strictEqual(same.status, 400, JSON.stringify(same.body));
    assert.strictEqual(same.body['error_code'], 'DOWNGRADE_SKU_INVALID');

    const missing = await ncrOutcome(ncrId, 'downgrade');
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'DOWNGRADE_SKU_REQUIRED');
  });

  it('AC5: a rework outcome emits the qc.rework_requested integration contract in the same transaction', async () => {
    const plan = await planOk();
    const { held, ncrId } = await rejectedLot(plan, '7.000000');
    const res = await ncrOutcome(ncrId, 'rework');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const ncr = res.body['ncr'] as Record<string, unknown>;
    assert.strictEqual(ncr['outcome'], 'rework');
    const reworkEventId = ncr['rework_requested_event_id'];
    assert.ok(reworkEventId, 'the NCR names its rework event');

    // The synthetic subscriber Story 6.3 will replace: read the contract straight off the stream.
    const ev = await eventRow(reworkEventId);
    assert.strictEqual(ev['event_type'], 'qc.rework_requested');
    const payload = ev['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['ncr_id'], ncrId);
    assert.strictEqual(payload['lot_id'], held.lotId);
    assert.strictEqual(payload['lot_number'], held.lotNumber);
    assert.strictEqual(payload['task_id'], held.taskId);
    assert.strictEqual(payload['sku'], plan.sku);
    assert.strictEqual(payload['site_id'], siteAId);
    assert.strictEqual(payload['quantity'], '7.000000');
    assert.strictEqual(payload['plan_version_id'], plan.versionId);
    assert.strictEqual(payload['requested_by'], inspectorUserId);
    // No stock moved and no order created: the contract is the whole deliverable.
    assert.strictEqual(await ownedOnHand(plan.sku, held.lotNumber), '7.000000');
  });

  it('AC5: a direct qc.rework_requested post the NCR does not name is QC_REWORK_NOT_DERIVED', async () => {
    const plan = await planOk();
    const { held, ncrId } = await rejectedLot(plan);
    const forged = await postEvent(
      {
        stream_type: 'qc',
        stream_id: ncrId,
        event_type: 'qc.rework_requested',
        payload: {
          ncr_id: ncrId,
          lot_id: held.lotId,
          lot_number: held.lotNumber,
          task_id: held.taskId,
          sku: plan.sku,
          site_id: siteAId,
          quantity: '10.000000',
          plan_version_id: plan.versionId,
          requested_by: inspectorUserId,
          requested_at: '2026-07-20T10:00:00.000+05:30',
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
    assert.strictEqual(forged.body['error_code'], 'QC_REWORK_NOT_DERIVED');
  });

  // -------------------------------------------------------------------------
  // AC6: fail-closed authority, holds and central-only
  // -------------------------------------------------------------------------

  it('AC6: a disposition outside the actor write scope is an audited LOCATION_ACCESS_DENIED', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '5.000000', true, binB1Id, siteBId, qcHeadHeaders);
    const res = await disposition(held.taskId, 'accept', inspectorHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(
      await countRows('audit_log', `error_code = 'LOCATION_ACCESS_DENIED' AND user_id = $1`, [
        inspectorUserId,
      ]) > 0,
      true,
      'the refused decision is in the statutory audit log',
    );
  });

  it('AC6: a lot under an independent manual hold cannot be dispositioned', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '5.000000');
    await getAdminPool().query(
      `UPDATE lot_master SET quality_hold_status = 'held', quality_hold_reason = 'recall' WHERE lot_id = $1`,
      [held.lotId],
    );
    const res = await disposition(held.taskId, 'accept');
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual(detailsOf(res.body)['reason'], 'manual_hold');
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 0);
  });

  it('AC6: every Story 8.3 event type is central-only on the edge upload route', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '5.000000');
    for (const eventType of [
      'qc.lot_dispositioned',
      'qc.lot_split_recorded',
      'qc.ncr_outcome_recorded',
      'qc.rework_requested',
    ]) {
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
          payload: { task_id: held.taskId, lot_id: held.lotId },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
            device_id: DEVICE_ID,
            capture_method: 'MANUAL',
            occurred_at: new Date().toISOString(),
          },
          schema_version: 1,
          idempotency_key: `edge-8-3-${eventId}`,
        },
        inspectorHeaders,
      );
      assert.strictEqual(res.status, 403, `${eventType}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    }
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 0);
  });

  // -------------------------------------------------------------------------
  // AC7: gate integration
  // -------------------------------------------------------------------------

  it('AC7: only an accepted lot leaves the gate; rejected, split and manually held lots stay blocked', async () => {
    const plan = await planOk();
    const accepted = await inspected(plan, '10.000000');
    assert.strictEqual((await disposition(accepted.taskId, 'accept')).status, 201);
    // Allocation, not issue: an issue would additionally need FIFO cost layers this synthetic lot
    // has never had. Allocation runs the same assertQcGateAllows check, which is what AC 7 is about.
    const allocate = await postEvent(
      inventoryEnvelope('stock.allocated', {
        sku: plan.sku,
        target_location_id: binA1Id,
        quantity: 4,
        lot_id: accepted.lotNumber,
      }),
    );
    assert.strictEqual(allocate.status, 201, JSON.stringify(allocate.body));
    const allocatedRow = await getAdminPool().query(
      `SELECT allocated::text AS allocated FROM stock_balance WHERE sku = $1 AND lot_id = $2`,
      [plan.sku, accepted.lotNumber],
    );
    assert.strictEqual(allocatedRow.rows[0]!['allocated'], '4.000000');

    const rejectedPlan = await planOk();
    const rejected = await inspected(rejectedPlan, '10.000000', false);
    assert.strictEqual((await disposition(rejected.taskId, 'reject')).status, 201);
    const blocked = await postEvent(
      inventoryEnvelope('stock.allocated', {
        sku: rejectedPlan.sku,
        target_location_id: binA1Id,
        quantity: 1,
        lot_id: rejected.lotNumber,
      }),
    );
    assert.strictEqual(blocked.status, 400, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual(detailsOf(blocked.body)['reason'], 'rejected');

    const splitPlan = await planOk();
    const parent = await inspected(splitPlan, '10.000000');
    assert.strictEqual((await split(parent.taskId, ['4.000000', '6.000000'])).status, 201);
    const splitBlocked = await postEvent(
      inventoryEnvelope('stock.allocated', {
        sku: splitPlan.sku,
        target_location_id: binA1Id,
        quantity: 1,
        lot_id: parent.lotNumber,
      }),
    );
    assert.ok([400, 409].includes(splitBlocked.status), JSON.stringify(splitBlocked.body));
    assert.strictEqual(splitBlocked.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual(detailsOf(splitBlocked.body)['reason'], 'split');

    // An accepted lot under the INDEPENDENT manual hold still blocks: two axes, both must be clear.
    await getAdminPool().query(
      `UPDATE lot_master SET quality_hold_status = 'held', quality_hold_reason = 'recall' WHERE lot_id = $1`,
      [accepted.lotId],
    );
    const heldAgain = await postEvent(
      inventoryEnvelope('stock.allocated', {
        sku: plan.sku,
        target_location_id: binA1Id,
        quantity: 1,
        lot_id: accepted.lotNumber,
      }),
    );
    assert.strictEqual(heldAgain.status, 400, JSON.stringify(heldAgain.body));
    assert.strictEqual(heldAgain.body['error_code'], 'LOT_ON_HOLD');
    // The Story 2.3 lot-hold validation runs ahead of the QC gate, so the reason is the hold's own
    // reason code; the accepted-gate arm of assertQcGateAllows is the defence behind it and would
    // report 'manual_hold'. Either is a correct refusal - what matters is that acceptance at the QC
    // gate does NOT clear the independent hold axis.
    assert.ok(
      ['manual_hold', 'recall'].includes(detailsOf(heldAgain.body)['reason'] as string),
      JSON.stringify(heldAgain.body),
    );
  });

  // -------------------------------------------------------------------------
  // AC8: supplier scorecard quality acceptance
  // -------------------------------------------------------------------------

  it('AC8: a quality-acceptance metric is derived from a real disposition and rejects a fabricated value', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '10.000000');
    const decided = await disposition(held.taskId, 'accept');
    assert.strictEqual(decided.status, 201, JSON.stringify(decided.body));
    const dispositionId = (decided.body['disposition'] as Record<string, unknown>)[
      'disposition_id'
    ] as string;

    const metric = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/dispositions/${dispositionId}/scorecard/quality-acceptance`,
      { supplier_id: supplierId },
      procurementHeaders,
    );
    assert.strictEqual(metric.status, 201, JSON.stringify(metric.body));
    assert.strictEqual(metric.body['value_num'], '1.000000');
    assert.strictEqual(
      await countRows(
        'supplier_scorecard_metric',
        `supplier_id = $1 AND metric_kind = 'quality_acceptance'`,
        [supplierId],
      ),
      1,
      'the Story 4.2 applier is no longer a no-op',
    );

    const scorecard = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${supplierId}?metric_kind=quality_acceptance`,
      undefined,
      procurementHeaders,
    );
    assert.strictEqual(scorecard.status, 200, JSON.stringify(scorecard.body));
    assert.ok(
      !JSON.stringify(scorecard.body).includes('no_data'),
      `quality acceptance still reports no_data: ${JSON.stringify(scorecard.body)}`,
    );

    // A fabricated value cannot slip past the seam's locked re-derivation.
    const forged = await postEvent(
      {
        stream_type: 'procurement',
        stream_id: held.lotId,
        event_type: 'supplier_scorecard.metric_recorded',
        payload: {
          metric_id: randomUUID(),
          supplier_id: supplierId,
          metric_kind: 'quality_acceptance',
          reference_event_id: randomUUID(),
          reference_entity_id: dispositionId,
          value_num: '0.000000',
          context: { disposition: 'accept' },
          business_date: '2026-07-15',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: engineerUserId, role: 'buyer', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      procurementHeaders,
    );
    assert.strictEqual(forged.status, 409, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'SCORECARD_DERIVATION_MISMATCH');
  });

  it('AC8: a split or conditional-release disposition is not a quality-acceptance measurement', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '10.000000');
    const res = await split(held.taskId, ['4.000000', '6.000000']);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const dispositionId = (res.body['disposition'] as Record<string, unknown>)[
      'disposition_id'
    ] as string;
    const metric = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/dispositions/${dispositionId}/scorecard/quality-acceptance`,
      { supplier_id: supplierId },
      procurementHeaders,
    );
    assert.strictEqual(metric.status, 409, JSON.stringify(metric.body));
    assert.strictEqual(metric.body['error_code'], 'SCORECARD_REFERENCE_INVALID');
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  it('reads: the disposition and NCR routes are site-scoped and paginate safely', async () => {
    const plan = await planOk();
    const { held, ncrId } = await rejectedLot(plan);

    const view = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/disposition`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(view.status, 200, JSON.stringify(view.body));
    assert.strictEqual(
      (view.body['disposition'] as Record<string, unknown>)['disposition'],
      'reject',
    );
    assert.strictEqual((view.body['ncr'] as Record<string, unknown>)['ncr_id'], ncrId);

    const one = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/ncrs/${ncrId}`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(one.status, 200, JSON.stringify(one.body));

    const open = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/ncrs?outcome=open&limit=5`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(open.status, 200, JSON.stringify(open.body));
    assert.ok((open.body['ncrs'] as unknown[]).length <= 5);

    const bad = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/ncrs?limit=abc`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.strictEqual(bad.body['error_code'], 'INVALID_PARAMS');

    // A site-B NCR is invisible to the site-A inspector.
    const otherPlan = await planOk();
    const otherHeld = await inspected(otherPlan, '5.000000', false, binB1Id, siteBId, qcHeadHeaders);
    const otherReject = await disposition(otherHeld.taskId, 'reject', qcHeadHeaders);
    assert.strictEqual(otherReject.status, 201, JSON.stringify(otherReject.body));
    const otherNcrId = (otherReject.body['ncr'] as Record<string, unknown>)['ncr_id'] as string;
    const denied = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/ncrs/${otherNcrId}`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.ok(config.quality.qcHeadRoles.length > 0);
  });
});

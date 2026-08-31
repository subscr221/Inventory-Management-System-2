import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';
import { runRetentionExpiryCycle } from '../../src/notify/retention-expiry.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 8.4 CoA/CoC, Retention Samples and Batch Release Records (FR-Q-07, FR-Q-08). Real
 * PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Dedicated routes
 * carry the ordinary behaviour; direct POST /api/v1/events carries the forgery, derivation and
 * central-only proofs. Tests run serially; every identifier is run-scoped.
 *
 * Debug Log Reference: Story 8.3's own fixtures (heldLot, inspected, planOk, disposition, authFor)
 * are NOT exported from test/integration/story-8-3.test.ts - they are closures inside its describe
 * block - so the equivalents below are a deliberate local re-implementation, not a duplicated
 * oversight. `accepted()` is this story's own addition: one lot driven all the way to an accept
 * disposition, which is where Story 8.4 begins.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
/** Story 8.6 (Binding Scope Decision 14): the register number every BIS-covered fixture seeds. */
const SEEDED_BIS_LICENCE_NUMBER = `CM/L-84-${run}`;
const DEVICE_ID = `edge-8-4-${run}`;

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

/**
 * Independent reimplementation of the IST calendar-date arithmetic the seam performs, written from
 * the +05:30 offset rather than imported from production - importing `addYearsToCalendarDate` would
 * assert the implementation against itself. Leap-day clamping is covered exactly in the unit test.
 */
function istDatePlusYears(iso: string, years: number): string {
  const ist = new Date(new Date(iso).getTime() + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCFullYear() + years;
  const month = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

describe('Story 8.4 CoA/CoC, Retention Samples and Batch Release Records', () => {
  let server: Server;
  let port: number;

  let inspectorUserId: string;
  let inspectorHeaders: Record<string, string>;
  /** NFR-SEC-05: a result recorder cannot approve an acceptance, so accepts need a second party. */
  let approverUserId: string;
  let approverHeaders: Record<string, string>;
  let qcHeadUserId: string;
  let qcHeadHeaders: Record<string, string>;
  let engineerUserId: string;
  let engineerHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let siteBId: string;
  let binB1Id: string;
  let componentItemId: string;

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
        description: `Story 8.4 item ${sku}`,
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
  /** `bisCovered` drives Binding Scope Decisions 3 and 4: CoC for a BIS item, CoA otherwise. */
  async function planOk(bisCovered: boolean = false): Promise<Plan> {
    planCounter += 1;
    const sku = `FG-8-4-${run}-${planCounter}`;
    const itemId = await createItem(sku, bisCovered ? { bis_licence_required: true } : {});
    if (bisCovered) {
      // Story 8.6 (Binding Scope Decision 14): the statutory release blocks default to `enforce`,
      // so every BIS-covered fixture seeds one valid, global-scope licence row through the admin
      // pool (the register has no write routes in 8.6). The coc-path assertion below now proves
      // the RELEASE RECORD CARRIES THIS REGISTER NUMBER - the honest end-state, strengthening the
      // Story 8.4 null-stub assertion rather than weakening it.
      await getAdminPool().query(
        `INSERT INTO compliance_bis_licence
           (licence_id, licence_number, licence_type, sku, site_id, valid_from, valid_to)
         VALUES ($1, $2, 'cml', $3, NULL, '2020-01-01', '2099-12-31')`,
        [randomUUID(), SEEDED_BIS_LICENCE_NUMBER, sku],
      );
    }
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
    const lotNumber = `FG-LOT-8-4-${run}-${lotCounter}`;
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
    conforming: boolean = true,
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
      readings.push({ sample_unit_no: u, attribute_conforms: conforming ? true : u !== 1 });
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
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      { disposition: kind, justification: `Story 8.4 ${kind} decision` },
      headers,
    );
  }

  /** One lot driven to an accept disposition - the state Story 8.4's release step starts from. */
  async function accepted(
    plan: Plan,
    quantity: string = '10.000000',
    locationId: string = binA1Id,
    siteId: string = siteAId,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<Held> {
    const held = await inspected(plan, quantity, true, locationId, siteId, headers);
    // Signed by the approver, never by whoever recorded the results (NFR-SEC-05).
    const res = await disposition(held.taskId, 'accept', approverHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return held;
  }

  async function logRetentionSample(
    taskId: string,
    headers: Record<string, string> = inspectorHeaders,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/retention-sample`,
      { quantity: '1.000000', uom: 'EA', location_id: binA1Id, ...overrides },
      headers,
    );
  }

  async function release(
    taskId: string,
    headers: Record<string, string> = inspectorHeaders,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', `/api/v1/qc/tasks/${taskId}/release`, body, headers);
  }

  /** Audit rows for one refusal on one task - scoped, so the count cannot drift with file order. */
  async function auditCount(errorCode: string, taskId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE error_code = $1 AND details->>'task_id' = $2`,
      [errorCode, taskId],
    );
    return r.rows[0]!['n'] as number;
  }

  /** The AC8 audit row must name the actor, the task AND the lot, not merely the code. */
  async function auditRow(errorCode: string, taskId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT user_id, error_code, details FROM audit_log
        WHERE error_code = $1 AND details->>'task_id' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [errorCode, taskId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? {};
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

  async function retentionSampleRow(lotId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT retention_sample_id, status, expires_on::text AS expires_on, disposal_event_id,
              disposed_at, quantity::text AS quantity, uom, location_id
         FROM qc_retention_sample WHERE lot_id = $1`,
      [lotId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function postEvent(
    envelope: Record<string, unknown>,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/events', envelope, headers);
  }

  function qcEnvelope(
    eventType: string,
    streamId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      stream_type: 'qc',
      stream_id: streamId,
      event_type: eventType,
      payload,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: randomUUID(),
    };
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
      // Story 8.6: the release seam now reads the statutory register tables on every release, and
      // planOk seeds a licence row for BIS-covered fixtures (Binding Scope Decision 14).
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
        'TRUNCATE compliance_bis_licence, label_master, qc_retention_sample, qc_batch_release, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-4-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-4-${run}`, siteAId, siteAId);
    siteBId = await seedLocation('site', `SITE-B-8-4-${run}`, null, null);
    binB1Id = await seedLocation('bin', `BIN-B1-8-4-${run}`, siteBId, siteBId);

    qcHeadUserId = await provisionUser(port, `qc-head-8-4-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-4-${run}@example.com`);

    // The inspector's read AND write scope is site A only (the AC 8 site-scope proofs).
    inspectorUserId = await provisionUser(port, `qc-inspector-8-4-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteAId },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: siteAId },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-8-4-${run}@example.com`);

    // Records no results, so it can sign an acceptance without tripping the segregation guard.
    approverUserId = await provisionUser(port, `qc-approver-8-4-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `qc-approver-8-4-${run}@example.com`);

    engineerUserId = await provisionUser(port, `engineer-8-4-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-4-${run}@example.com`);
    assert.ok(engineerUserId);

    for (const transactionType of ['qc.inspection_plan_approval', 'qc.conditional_release']) {
      await getPool().query(
        `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
         VALUES ($1, 'qc_head', $2, NULL, NULL, true)`,
        [randomUUID(), transactionType],
      );
    }

    componentItemId = await createItem(`CMP-8-4-${run}`, { lot_controlled: false });
    planDefault = await planOk();
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: the batch release record and its CoA
  // -------------------------------------------------------------------------

  it('AC1: a released accepted lot gets one batch release record, a CoA and a 7-year retention window', async () => {
    const held = await accepted(planDefault, '10.000000');

    const sample = await logRetentionSample(held.taskId);
    assert.strictEqual(sample.status, 201, JSON.stringify(sample.body));
    const loggedSample = sample.body['retention_sample'] as Record<string, unknown>;
    assert.strictEqual(loggedSample['status'], 'retained');
    assert.strictEqual(loggedSample['quantity'], '1.000000');
    assert.strictEqual(loggedSample['uom'], 'EA');
    assert.strictEqual(loggedSample['location_id'], binA1Id);
    assert.strictEqual(loggedSample['logged_by'], inspectorUserId);
    assert.strictEqual(loggedSample['disposal_event_id'], null);
    assert.strictEqual(loggedSample['disposed_at'], null);

    const res = await release(held.taskId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = res.body['release'] as Record<string, unknown>;
    assert.strictEqual(row['lot_id'], held.lotId);
    assert.strictEqual(row['task_id'], held.taskId);
    // Binding Scope Decision 4: a non-BIS item is certified with a CoA.
    assert.strictEqual(row['document_kind'], 'coa');
    // Binding Scope Decision 5: no physical document is generated, so the store key stays null.
    assert.strictEqual(row['document_ref'], null);
    assert.strictEqual(row['bis_licence_number'], null);
    // The LITERAL 7 that AC1 requires, not `config.quality.retentionYearsDefault` - asserting the
    // config value against a number production read from the same config object is X === X and
    // passes for 7, 1 or 900.
    assert.strictEqual(row['retention_years'], 7);
    assert.strictEqual(row['released_by'], inspectorUserId);

    // AC 1's "retained for a default 7 years", asserted to the DAY. Checking only the year would
    // accept a release stamping 2033-01-01 in place of 2033-07-15.
    assert.strictEqual(
      row['retention_expires_on'],
      istDatePlusYears(row['released_at'] as string, 7),
    );

    // The retention sample must share that exact clock.
    const sampleAfterRelease = await retentionSampleRow(held.lotId);
    assert.strictEqual(
      sampleAfterRelease?.['expires_on'],
      row['retention_expires_on'],
      'the retention sample and its release record must share one retention clock',
    );

    // The release record names the disposition it was built on (Binding Scope Decision 1).
    const dispositionRow = (
      await getAdminPool().query(
        `SELECT disposition_id, approved_by, inspector_user_id
           FROM qc_lot_disposition WHERE lot_id = $1`,
        [held.lotId],
      )
    ).rows[0] as Record<string, unknown>;
    assert.strictEqual(row['disposition_id'], dispositionRow['disposition_id']);
    // NFR-SEC-05: the acceptance this release inherits was signed by someone other than the
    // inspector who recorded the results, and both parties are on the record.
    assert.strictEqual(dispositionRow['approved_by'], approverUserId);
    assert.strictEqual(dispositionRow['inspector_user_id'], inspectorUserId);
    assert.notStrictEqual(dispositionRow['approved_by'], dispositionRow['inspector_user_id']);

    const ev = await eventRow(res.body['event_id']);
    assert.strictEqual(ev['event_type'], 'qc.batch_release_recorded');
    assert.strictEqual(ev['stream_type'], 'qc');
    const payload = ev['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['document_kind'], 'coa');
    assert.strictEqual(payload['lot_number'], held.lotNumber);
    assert.strictEqual(payload['site_id'], siteAId);
    assert.strictEqual(payload['disposition'], 'accept');
    assert.strictEqual(payload['quantity'], '10.000000');

    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 1);
    // AD-17: the notification is emitted transactionally, so the guarantee is the event itself.
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'notification.created' AND payload->>'object_id' = $1 AND payload->>'event_type' = 'qc_batch_release_recorded'`,
        [held.taskId],
      ),
      1,
    );
    // The success path is a statutory record too: the accepted event carries its audit row, and
    // exactly one - a duplicated row in a statutory log is itself a defect worth failing on.
    assert.strictEqual(
      await countRows('audit_log', `event_id = $1`, [res.body['event_id']]),
      1,
      'the release is written to the statutory audit log exactly once',
    );
  });

  it('AC1: release is available on GET, and 404 before it happens', async () => {
    const held = await accepted(await planOk(), '4.000000');
    const before = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/release`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(before.status, 404, JSON.stringify(before.body));
    assert.strictEqual(before.body['error_code'], 'RELEASE_NOT_FOUND');

    const sampleBefore = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/retention-sample`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(sampleBefore.status, 404, JSON.stringify(sampleBefore.body));
    // Distinct from the applier's RETENTION_SAMPLE_NOT_FOUND ("this id does not resolve"): here
    // nothing has been logged yet, which is a different fact for the caller.
    assert.strictEqual(sampleBefore.body['error_code'], 'RETENTION_SAMPLE_NOT_LOGGED');

    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    assert.strictEqual((await release(held.taskId)).status, 201);

    const after = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/release`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));
    assert.strictEqual(
      (after.body['release'] as Record<string, unknown>)['lot_id'],
      held.lotId,
    );
    const sampleAfter = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}/retention-sample`,
      undefined,
      inspectorHeaders,
    );
    assert.strictEqual(sampleAfter.status, 200, JSON.stringify(sampleAfter.body));
    assert.strictEqual(
      (sampleAfter.body['retention_sample'] as Record<string, unknown>)['status'],
      'retained',
    );
  });

  // -------------------------------------------------------------------------
  // AC3: the CoC and the BIS licence number
  // -------------------------------------------------------------------------

  it('AC3: a BIS-covered product is certified with a CoC carrying the (still-null) licence number', async () => {
    const bisPlan = await planOk(true);
    const held = await accepted(bisPlan, '6.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);

    const res = await release(held.taskId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = res.body['release'] as Record<string, unknown>;
    // Binding Scope Decisions 3 and 4: bis_licence_required = true selects the CoC format.
    assert.strictEqual(row['document_kind'], 'coc');
    // Story 8.6 (Binding Scope Decision 14, reversing Story 8.4 Decision 2): the register-backed
    // resolveBisLicence stamps the SEEDED register number onto the release record - not null (the
    // 8.4 stub) and not any client-supplied value (the forgery test below).
    assert.strictEqual(row['bis_licence_number'], SEEDED_BIS_LICENCE_NUMBER);
    assert.strictEqual(row['retention_years'], 7);
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 1);
    // Testing Standards: every success path asserts the audit row AND the transactional
    // notification, not just the first one in the file.
    assert.strictEqual(
      await countRows('audit_log', `event_id = $1`, [res.body['event_id']]),
      1,
    );
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'notification.created' AND payload->>'object_id' = $1
           AND payload->>'event_type' = 'qc_batch_release_recorded'`,
        [held.taskId],
      ),
      1,
    );
  });

  // -------------------------------------------------------------------------
  // AC4: the retention sample gate
  // -------------------------------------------------------------------------

  it('AC4: release before the retention sample is logged is RETENTION_SAMPLE_REQUIRED and nothing persists', async () => {
    const held = await accepted(await planOk(), '5.000000');
    const res = await release(held.taskId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RETENTION_SAMPLE_REQUIRED');
    assert.strictEqual(detailsOf(res.body)['lot_id'], held.lotId);
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(
      await auditCount('RETENTION_SAMPLE_REQUIRED', held.taskId),
      1,
      'the refused release is in the statutory audit log exactly once, for THIS task',
    );
    // AC8 requires the row to carry actor, task, lot and code - not merely the code.
    const refusedAudit = await auditRow('RETENTION_SAMPLE_REQUIRED', held.taskId);
    assert.strictEqual(refusedAudit['user_id'], inspectorUserId);
    const refusedDetails = refusedAudit['details'] as Record<string, unknown>;
    assert.strictEqual(refusedDetails['task_id'], held.taskId);
    assert.strictEqual(refusedDetails['lot_id'], held.lotId);

    // ...and logging the sample afterwards makes the very same release succeed.
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    assert.strictEqual((await release(held.taskId)).status, 201);
  });

  it('AC4: a retention sample may be logged before the disposition exists (the AC4 ordering)', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '5.000000');
    // No disposition yet: logging must NOT be gated on disposition state (Task 3's ordering note).
    const sample = await logRetentionSample(held.taskId);
    assert.strictEqual(sample.status, 201, JSON.stringify(sample.body));
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [held.lotId]), 1);

    // Release still refuses until the lot is actually dispositioned.
    const early = await release(held.taskId);
    assert.strictEqual(early.status, 409, JSON.stringify(early.body));
    assert.strictEqual(early.body['error_code'], 'QC_RELEASE_NOT_ELIGIBLE');

    // Signed by the approver: the inspector recorded the results and so cannot approve (NFR-SEC-05).
    assert.strictEqual((await disposition(held.taskId, 'accept', approverHeaders)).status, 201);
    assert.strictEqual((await release(held.taskId)).status, 201);
  });

  it('AC4: a second retention sample is RETENTION_SAMPLE_EXISTS, sequentially and under a race', async () => {
    const sequential = await accepted(await planOk(), '5.000000');
    const first = await logRetentionSample(sequential.taskId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const retentionSampleId = (first.body['retention_sample'] as Record<string, unknown>)[
      'retention_sample_id'
    ] as string;

    const second = await logRetentionSample(sequential.taskId);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'RETENTION_SAMPLE_EXISTS');
    assert.strictEqual(
      detailsOf(second.body)['existing_retention_sample_id'],
      retentionSampleId,
    );
    assert.strictEqual(await auditCount('RETENTION_SAMPLE_EXISTS', sequential.taskId), 1);
    assert.strictEqual(
      await countRows('qc_retention_sample', 'lot_id = $1', [sequential.lotId]),
      1,
    );

    // Ten in flight, not two: two requests that happen to serialise would also yield [201, 409]
    // from a naive check-then-insert with no unique constraint, so a pair proves very little.
    const raced = await accepted(await planOk(), '5.000000');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => logRetentionSample(raced.taskId)),
    );
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    assert.strictEqual(created.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.strictEqual(refused.length, 9);
    for (const r of refused) {
      assert.strictEqual(r.body['error_code'], 'RETENTION_SAMPLE_EXISTS');
    }
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [raced.lotId]), 1);
  });

  // -------------------------------------------------------------------------
  // AC5: the 30-day expiry alert
  // -------------------------------------------------------------------------

  it('AC5: a sample inside the 30-day alert window flips to disposal_pending exactly once', async () => {
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    // The real expiry is seven years out, so the alert window is reached by moving the row's own
    // expires_on - the sweep's only input - rather than by waiting or faking the clock.
    await getAdminPool().query(
      `UPDATE qc_retention_sample SET expires_on = CURRENT_DATE + ($2::int * INTERVAL '1 day')
        WHERE lot_id = $1`,
      [held.lotId, config.quality.retentionExpiryAlertLeadDays - 1],
    );

    const swept = await runRetentionExpiryCycle();
    // Exactly one: every other sample alive at this point has a 7-year window, so a `>= 1` would
    // hide a sweep that also picked up rows it had no business touching.
    assert.strictEqual(swept.disposalPending, 1, JSON.stringify(swept));
    assert.strictEqual(swept.failed, 0);
    assert.strictEqual(swept.cycleFailed, false);

    const row = await retentionSampleRow(held.lotId);
    assert.strictEqual(row?.['status'], 'disposal_pending');
    // Physical disposal is Phase 2 / Epic 16, so nothing claims the sample was actually disposed.
    assert.strictEqual(row?.['disposed_at'], null);

    const disposalEvent = await getAdminPool().query(
      `SELECT event_id FROM domain_events
        WHERE event_type = 'qc.retention_sample_disposed' AND payload->>'lot_id' = $1`,
      [held.lotId],
    );
    assert.strictEqual(disposalEvent.rows.length, 1);
    // The stamped id must be THAT event, not merely some non-empty string.
    assert.strictEqual(row?.['disposal_event_id'], disposalEvent.rows[0]!['event_id']);
    // AC5 is an ALERT: a status flip nobody is told about does not satisfy it.
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'notification.created' AND payload->>'object_id' = $1
           AND payload->>'event_type' = 'qc_retention_sample_disposal_pending'`,
        [held.taskId],
      ),
      1,
      'the expiry alert notifies the QC role',
    );

    // A second sweep is a no-op: the `WHERE status = 'retained'` guard never re-picks the row.
    await runRetentionExpiryCycle();
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'qc.retention_sample_disposed' AND payload->>'lot_id' = $1`,
        [held.lotId],
      ),
      1,
      'a re-fired sweep tick must not re-emit the disposal event',
    );
    assert.strictEqual((await retentionSampleRow(held.lotId))?.['status'], 'disposal_pending');
  });

  it('AC5: the alert window boundary is exact - due on the day, untouched one day later', async () => {
    // A sample sitting exactly ON the boundary must sweep; one day beyond it must not. Without
    // both, a lead-days bug anywhere between 31 and ~2500 days passes, because the only negative
    // case was a sample seven years out.
    const onBoundary = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(onBoundary.taskId)).status, 201);
    const beyond = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(beyond.taskId)).status, 201);
    await getAdminPool().query(
      `UPDATE qc_retention_sample
          SET expires_on = ((now() AT TIME ZONE 'Asia/Kolkata')::date + $2::int)
        WHERE lot_id = $1`,
      [onBoundary.lotId, config.quality.retentionExpiryAlertLeadDays],
    );
    await getAdminPool().query(
      `UPDATE qc_retention_sample
          SET expires_on = ((now() AT TIME ZONE 'Asia/Kolkata')::date + $2::int)
        WHERE lot_id = $1`,
      [beyond.lotId, config.quality.retentionExpiryAlertLeadDays + 1],
    );

    const swept = await runRetentionExpiryCycle();
    assert.strictEqual(swept.disposalPending, 1, JSON.stringify(swept));
    assert.strictEqual((await retentionSampleRow(onBoundary.lotId))?.['status'], 'disposal_pending');
    assert.strictEqual((await retentionSampleRow(beyond.lotId))?.['status'], 'retained');
  });

  it('AC5: a sample outside the alert window is left alone', async () => {
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    const swept = await runRetentionExpiryCycle();
    assert.strictEqual(swept.cycleFailed, false, JSON.stringify(swept));
    assert.strictEqual((await retentionSampleRow(held.lotId))?.['status'], 'retained');
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'qc.retention_sample_disposed' AND payload->>'lot_id' = $1`,
        [held.lotId],
      ),
      0,
    );
  });

  // -------------------------------------------------------------------------
  // AC6: release eligibility
  // -------------------------------------------------------------------------

  it('AC6: release on a rejected, split or still-held lot is QC_RELEASE_NOT_ELIGIBLE and nothing persists', async () => {
    const rejectedPlan = await planOk();
    const rejected = await inspected(rejectedPlan, '10.000000', false);
    assert.strictEqual((await logRetentionSample(rejected.taskId)).status, 201);
    assert.strictEqual((await disposition(rejected.taskId, 'reject')).status, 201);
    const onReject = await release(rejected.taskId);
    assert.strictEqual(onReject.status, 409, JSON.stringify(onReject.body));
    assert.strictEqual(onReject.body['error_code'], 'QC_RELEASE_NOT_ELIGIBLE');
    assert.strictEqual(detailsOf(onReject.body)['disposition'], 'reject');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [rejected.lotId]), 0);
    // AC8: this code sits in AUDITED_REJECTIONS, so removing it from that set must break a test.
    assert.strictEqual(await auditCount('QC_RELEASE_NOT_ELIGIBLE', rejected.taskId), 1);

    const splitPlan = await planOk();
    const parent = await inspected(splitPlan, '10.000000');
    assert.strictEqual((await logRetentionSample(parent.taskId)).status, 201);
    const split = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${parent.taskId}/split`,
      {
        justification: 'Story 8.4 partial conformance',
        splits: [
          { sequence: 1, quantity: '4.000000' },
          { sequence: 2, quantity: '6.000000' },
        ],
      },
      inspectorHeaders,
    );
    assert.strictEqual(split.status, 201, JSON.stringify(split.body));
    const onSplit = await release(parent.taskId);
    assert.strictEqual(onSplit.status, 409, JSON.stringify(onSplit.body));
    assert.strictEqual(onSplit.body['error_code'], 'QC_RELEASE_NOT_ELIGIBLE');
    assert.strictEqual(detailsOf(onSplit.body)['disposition'], 'split');

    const undecided = await inspected(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(undecided.taskId)).status, 201);
    const onHold = await release(undecided.taskId);
    assert.strictEqual(onHold.status, 409, JSON.stringify(onHold.body));
    assert.strictEqual(onHold.body['error_code'], 'QC_RELEASE_NOT_ELIGIBLE');
    assert.strictEqual(detailsOf(onHold.body)['disposition'], null);
    assert.strictEqual(detailsOf(onHold.body)['gate_status'], 'qc_hold');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [undecided.lotId]), 0);
  });

  it('AC6: a conditionally released lot IS releasable (Binding Scope Decision 1)', async () => {
    const plan = await planOk();
    const held = await inspected(plan, '5.000000');
    const conditional = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/conditional-release`,
      {
        justification: 'Story 8.4 conditional release',
        conditions: 'Segregate and re-test within the window',
        scope_kind: 'internal_movement',
        scope_ref: `MOVE-8-4-${run}`,
        expires_on: '2030-12-31',
        idempotency_key: randomUUID(),
      },
      qcHeadHeaders,
    );
    assert.strictEqual(conditional.status, 201, JSON.stringify(conditional.body));

    assert.strictEqual((await logRetentionSample(held.taskId, qcHeadHeaders)).status, 201);
    const res = await release(held.taskId, qcHeadHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = res.body['release'] as Record<string, unknown>;
    assert.strictEqual(row['released_by'], qcHeadUserId);
    const ev = await eventRow(res.body['event_id']);
    assert.strictEqual(
      (ev['payload'] as Record<string, unknown>)['disposition'],
      'conditional_release',
    );
    assert.strictEqual(
      await countRows('audit_log', `event_id = $1`, [res.body['event_id']]),
      1,
    );
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'notification.created' AND payload->>'object_id' = $1
           AND payload->>'event_type' = 'qc_batch_release_recorded'`,
        [held.taskId],
      ),
      1,
    );
  });

  // -------------------------------------------------------------------------
  // AC7: one release per lot
  // -------------------------------------------------------------------------

  it('AC7: a second release is RELEASE_EXISTS, sequentially and under two concurrent requests', async () => {
    const sequential = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(sequential.taskId)).status, 201);
    const first = await release(sequential.taskId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const releaseId = (first.body['release'] as Record<string, unknown>)['release_id'] as string;

    const second = await release(sequential.taskId);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'RELEASE_EXISTS');
    assert.strictEqual(detailsOf(second.body)['existing_release_id'], releaseId);
    assert.strictEqual(await auditCount('RELEASE_EXISTS', sequential.taskId), 1);
    assert.strictEqual(
      await countRows('qc_batch_release', 'lot_id = $1', [sequential.lotId]),
      1,
    );

    const raced = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(raced.taskId)).status, 201);
    const results = await Promise.all(Array.from({ length: 10 }, () => release(raced.taskId)));
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    assert.strictEqual(created.length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.strictEqual(refused.length, 9);
    for (const r of refused) {
      assert.strictEqual(r.body['error_code'], 'RELEASE_EXISTS');
    }
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [raced.lotId]), 1);
  });

  it('AC7: the same idempotency key replays the release rather than creating a second one', async () => {
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    const key = randomUUID();
    const first = await release(held.taskId, inspectorHeaders, { idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await release(held.taskId, inspectorHeaders, { idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 1);
  });

  // -------------------------------------------------------------------------
  // AC8: fail-closed authority, central-only and forgery
  // -------------------------------------------------------------------------

  it('AC8: both write routes outside the actor write scope are audited LOCATION_ACCESS_DENIED', async () => {
    const plan = await planOk();
    const held = await accepted(plan, '5.000000', binB1Id, siteBId, qcHeadHeaders);

    const sample = await logRetentionSample(held.taskId, inspectorHeaders, {
      location_id: binB1Id,
    });
    assert.strictEqual(sample.status, 403, JSON.stringify(sample.body));
    assert.strictEqual(sample.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [held.lotId]), 0);

    // Log it legitimately as the wildcard-scoped QC head so the release refusal below is proven to
    // be about authority, not about the missing sample.
    assert.strictEqual(
      (await logRetentionSample(held.taskId, qcHeadHeaders, { location_id: binB1Id })).status,
      201,
    );
    const released = await release(held.taskId, inspectorHeaders);
    assert.strictEqual(released.status, 403, JSON.stringify(released.body));
    assert.strictEqual(released.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);

    // Exactly two, scoped to THIS task: a `>= 2` count over the whole run passes even when one of
    // the two routes audits nothing, because an unrelated earlier denial already satisfied it.
    assert.strictEqual(
      await auditCount('LOCATION_ACCESS_DENIED', held.taskId),
      2,
      'both refused attempts - retention-sample log and release - are audited for this task',
    );
    const deniedAudit = await auditRow('LOCATION_ACCESS_DENIED', held.taskId);
    assert.strictEqual(deniedAudit['user_id'], inspectorUserId);
    assert.strictEqual(
      (deniedAudit['details'] as Record<string, unknown>)['lot_id'],
      held.lotId,
    );
  });

  it('AC8: every Story 8.4 event type is central-only on the edge upload route', async () => {
    const held = await accepted(await planOk(), '5.000000');
    for (const eventType of [
      'qc.batch_release_recorded',
      'qc.retention_sample_logged',
      'qc.retention_sample_disposed',
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
          idempotency_key: `edge-8-4-${eventId}`,
        },
        inspectorHeaders,
      );
      assert.strictEqual(res.status, 403, `${eventType}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    }
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [held.lotId]), 0);
  });

  it('AC8: a direct POST declaring any server-derived field is QC_DERIVATION_MISMATCH', async () => {
    const held = await accepted(await planOk(), '5.000000');

    // qc.batch_release_recorded: document_kind and retention_years are the server's alone.
    for (const forged of [
      { document_kind: 'coa' },
      { retention_years: 1 },
      { retention_expires_on: '2027-01-01' },
      { bis_licence_number: 'CM/L-FORGED' },
      { released_by: inspectorUserId },
      { disposition_id: randomUUID() },
    ]) {
      const res = await postEvent(
        qcEnvelope('qc.batch_release_recorded', held.taskId, {
          task_id: held.taskId,
          lot_id: held.lotId,
          release_id: randomUUID(),
          decided_at: new Date().toISOString(),
          ...forged,
        }),
      );
      assert.strictEqual(res.status, 409, `${JSON.stringify(forged)}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'QC_DERIVATION_MISMATCH');
      assert.strictEqual(detailsOf(res.body)['field'], Object.keys(forged)[0]);
    }
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);

    // qc.retention_sample_logged: the expiry is derived from the same retention resolution as the
    // release record, so a client cannot shorten it.
    for (const forged of [{ expires_on: '2027-01-01' }, { retention_years: 1 }, { logged_by: inspectorUserId }]) {
      const res = await postEvent(
        qcEnvelope('qc.retention_sample_logged', held.taskId, {
          task_id: held.taskId,
          lot_id: held.lotId,
          retention_sample_id: randomUUID(),
          quantity: '1.000000',
          uom: 'EA',
          location_id: binA1Id,
          logged_at: new Date().toISOString(),
          ...forged,
        }),
      );
      assert.strictEqual(res.status, 409, `${JSON.stringify(forged)}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'QC_DERIVATION_MISMATCH');
      // WHICH field was refused, not merely that something was: without this, a blanket
      // unconditional reject of every direct post would satisfy the entire loop.
      assert.strictEqual(detailsOf(res.body)['field'], Object.keys(forged)[0]);
    }
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [held.lotId]), 0);

    // qc.retention_sample_disposed: the status and the owning task are the server's alone.
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    const sampleId = (await retentionSampleRow(held.lotId))?.['retention_sample_id'] as string;
    for (const forged of [{ status: 'disposal_pending' }, { task_id: held.taskId }]) {
      const res = await postEvent(
        qcEnvelope('qc.retention_sample_disposed', sampleId, {
          retention_sample_id: sampleId,
          lot_id: held.lotId,
          disposed_at: new Date().toISOString(),
          ...forged,
        }),
      );
      assert.strictEqual(res.status, 409, `${JSON.stringify(forged)}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'QC_DERIVATION_MISMATCH');
      assert.strictEqual(detailsOf(res.body)['field'], Object.keys(forged)[0]);
    }
    assert.strictEqual((await retentionSampleRow(held.lotId))?.['status'], 'retained');
  });

  it('AC8: a direct POST naming a task that is not the lot own task is QC_DERIVATION_MISMATCH', async () => {
    const held = await accepted(await planOk(), '5.000000');
    const other = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);

    const res = await postEvent(
      qcEnvelope('qc.batch_release_recorded', other.taskId, {
        task_id: other.taskId,
        lot_id: held.lotId,
        release_id: randomUUID(),
        decided_at: new Date().toISOString(),
      }),
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'QC_DERIVATION_MISMATCH');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);
    // ...and nothing landed on the OTHER lot either, which an implementation that "resolved" the
    // mismatch by trusting the declared task would have done.
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [other.lotId]), 0);
  });

  it('AC8: a re-fired disposal of an already-transitioned sample is refused, not silently accepted', async () => {
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    await getAdminPool().query(
      `UPDATE qc_retention_sample SET expires_on = CURRENT_DATE WHERE lot_id = $1`,
      [held.lotId],
    );
    await runRetentionExpiryCycle();
    const sampleId = (await retentionSampleRow(held.lotId))?.['retention_sample_id'] as string;

    const res = await postEvent(
      qcEnvelope('qc.retention_sample_disposed', sampleId, {
        retention_sample_id: sampleId,
        lot_id: held.lotId,
        disposed_at: new Date().toISOString(),
      }),
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RETENTION_SAMPLE_NOT_RETAINED');
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'qc.retention_sample_disposed' AND payload->>'lot_id' = $1`,
        [held.lotId],
      ),
      1,
    );
  });

  it('AC8: the write routes reject a malformed body before anything is persisted', async () => {
    const held = await accepted(await planOk(), '5.000000');
    for (const body of [
      { quantity: '0', uom: 'EA', location_id: binA1Id },
      { quantity: '1.000000', uom: '   ', location_id: binA1Id },
      { quantity: '1.000000', uom: 'EA', location_id: 'not-a-uuid' },
    ]) {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/qc/tasks/${held.taskId}/retention-sample`,
        body,
        inspectorHeaders,
      );
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [held.lotId]), 0);
  });
  // -------------------------------------------------------------------------
  // Review regressions: each locks in one HIGH defect found in the code review
  // -------------------------------------------------------------------------

  it('AC1 regression: a sample logged on an EARLIER day is re-stamped to the release clock', async () => {
    // The same-day assertion in the AC1 test cannot see this defect: within one test run logged_at
    // and decided_at fall on the same IST calendar date, so both clocks agree by accident. Only a
    // sample logged on a genuinely earlier day exposes it - which is the real-world case, since
    // AC4 requires the sample to exist before release and releases follow days or weeks later.
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);

    // Move the sample's own clock back 10 days, exactly as a real earlier logging would have.
    await getAdminPool().query(
      `UPDATE qc_retention_sample
          SET logged_at = logged_at - INTERVAL '10 days',
              expires_on = expires_on - INTERVAL '10 days'
        WHERE lot_id = $1`,
      [held.lotId],
    );
    const before = await retentionSampleRow(held.lotId);

    const res = await release(held.taskId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const releaseRow = res.body['release'] as Record<string, unknown>;
    const after = await retentionSampleRow(held.lotId);

    assert.notStrictEqual(
      before?.['expires_on'],
      releaseRow['retention_expires_on'],
      'precondition: the two clocks must genuinely differ before release',
    );
    assert.strictEqual(
      after?.['expires_on'],
      releaseRow['retention_expires_on'],
      'release must re-stamp the sample so the evidence outlives the certificate it backs',
    );
    // And the sample is therefore NOT swept while the certificate is still inside its window.
    const swept = await runRetentionExpiryCycle();
    assert.strictEqual(swept.cycleFailed, false, JSON.stringify(swept));
    assert.strictEqual((await retentionSampleRow(held.lotId))?.['status'], 'retained');
  });

  it('AC6 regression: a lot placed on quality hold AFTER acceptance cannot be released', async () => {
    // The hold axis is independent of the QC gate and can be stamped at any time (a recall, or a
    // Story 8.3 scrap outcome). lockLotForRetention did not re-derive it, so a recalled lot could
    // still be issued a CoA/CoC - the same bypass class found and fixed in the Story 8.3 review.
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    await getAdminPool().query(
      `UPDATE lot_master SET quality_hold_status = 'held', quality_hold_reason = 'recall'
        WHERE lot_id = $1`,
      [held.lotId],
    );

    const res = await release(held.taskId);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual(detailsOf(res.body)['reason'], 'manual_hold');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(await auditCount('LOT_ON_HOLD', held.taskId), 1);
  });

  it('AC1/AC3 regression: an unresolvable SKU fails CLOSED instead of silently issuing a CoA', async () => {
    // getItemBySku returning null used to collapse into "not BIS-covered", so a BIS product whose
    // item row had gone missing was certified with a CoA and the shorter retention window.
    const plan = await planOk(true);
    const held = await accepted(plan, '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    await getAdminPool().query(`UPDATE item_master SET sku = $2 WHERE sku = $1`, [
      plan.sku,
      `${plan.sku}-RENAMED`,
    ]);

    const res = await release(held.taskId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ITEM_NOT_FOUND');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);

    // Restore so later tests still resolve this SKU.
    await getAdminPool().query(`UPDATE item_master SET sku = $1 WHERE sku = $2`, [
      plan.sku,
      `${plan.sku}-RENAMED`,
    ]);
  });

  it('AC4 regression: a sample already routed for disposal no longer satisfies the release gate', async () => {
    // "A retention sample exists" is not the requirement; a RETAINED one is. A sample already
    // swept to disposal_pending backs nothing, so a certificate asserting it would be false.
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);
    await getAdminPool().query(
      `UPDATE qc_retention_sample SET status = 'disposal_pending', disposal_event_id = $2
        WHERE lot_id = $1`,
      [held.lotId, randomUUID()],
    );

    const res = await release(held.taskId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'RETENTION_SAMPLE_REQUIRED');
    assert.strictEqual(detailsOf(res.body)['retention_sample_status'], 'disposal_pending');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);
  });

  it('AC6 regression: a lapsed conditional-release deviation cannot be laundered into a release', async () => {
    // assertQcGateAllows restricts a conditionally released lot "until its batch release record
    // exists" - so minting that record on an EXPIRED deviation would turn a lapsed, time-boxed
    // authorization into a permanent one.
    const plan = await planOk();
    const held = await inspected(plan, '5.000000');
    const conditional = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${held.taskId}/conditional-release`,
      {
        justification: 'Story 8.4 conditional release',
        conditions: 'Segregate and re-test within the window',
        scope_kind: 'internal_movement',
        scope_ref: `MOVE-EXPIRED-8-4-${run}`,
        expires_on: '2030-12-31',
        idempotency_key: randomUUID(),
      },
      qcHeadHeaders,
    );
    assert.strictEqual(conditional.status, 201, JSON.stringify(conditional.body));
    assert.strictEqual((await logRetentionSample(held.taskId, qcHeadHeaders)).status, 201);

    // chk_qc_deviation_expiry enforces expires_on > decided_on, so the whole window is moved into
    // the past rather than just its end - a lapsed deviation, not an impossible one.
    await getAdminPool().query(
      `UPDATE qc_deviation
          SET decided_on = DATE '2019-01-01', expires_on = DATE '2020-01-01'
        WHERE lot_id = $1`,
      [held.lotId],
    );

    const res = await release(held.taskId, qcHeadHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'QC_RELEASE_NOT_ELIGIBLE');
    assert.strictEqual(detailsOf(res.body)['deviation_expires_on'], '2020-01-01');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);
  });

  it('AC1 regression: a back-dated decided_at cannot mint an already-expired certificate', async () => {
    // The whole statutory retention window is derived from this client-supplied timestamp, so an
    // unbounded value reaches the same outcome AC2's floor guard exists to prevent.
    const held = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(held.taskId)).status, 201);

    const backDated = await release(held.taskId, inspectorHeaders, {
      decided_at: '1990-01-01T00:00:00.000+05:30',
    });
    assert.strictEqual(backDated.status, 400, JSON.stringify(backDated.body));
    assert.strictEqual(backDated.body['error_code'], 'INVALID_PAYLOAD');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);

    const future = await release(held.taskId, inspectorHeaders, {
      decided_at: '2099-01-01T00:00:00.000+05:30',
    });
    assert.strictEqual(future.status, 400, JSON.stringify(future.body));
    assert.strictEqual(future.body['error_code'], 'INVALID_PAYLOAD');
    assert.strictEqual(await countRows('qc_batch_release', 'lot_id = $1', [held.lotId]), 0);

    // The same bound applies to the sample's own clock on the direct-post path.
    const other = await accepted(await planOk(), '5.000000');
    const staleSample = await postEvent(
      qcEnvelope('qc.retention_sample_logged', other.taskId, {
        task_id: other.taskId,
        lot_id: other.lotId,
        retention_sample_id: randomUUID(),
        quantity: '1.000000',
        uom: 'EA',
        location_id: binA1Id,
        logged_at: '1990-01-01T00:00:00.000+05:30',
      }),
    );
    assert.strictEqual(staleSample.status, 400, JSON.stringify(staleSample.body));
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [other.lotId]), 0);
  });

  it('AC4 regression: a retention sample must name a location that actually exists', async () => {
    const held = await accepted(await planOk(), '5.000000');
    const res = await logRetentionSample(held.taskId, inspectorHeaders, {
      location_id: randomUUID(),
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_NOT_FOUND');
    assert.strictEqual(await countRows('qc_retention_sample', 'lot_id = $1', [held.lotId]), 0);
  });

  it('AC8: both new GET routes are read-scoped, so a foreign site cannot read a CoA/CoC', async () => {
    // Without this, deleting assertReadSiteAccess from either read route breaks no test and a
    // cross-site leak of a statutory certificate ships undetected.
    const plan = await planOk();
    const held = await accepted(plan, '5.000000', binB1Id, siteBId, qcHeadHeaders);
    assert.strictEqual(
      (await logRetentionSample(held.taskId, qcHeadHeaders, { location_id: binB1Id })).status,
      201,
    );
    assert.strictEqual((await release(held.taskId, qcHeadHeaders)).status, 201);

    for (const path of ['release', 'retention-sample']) {
      const res = await makeRequest(
        port,
        'GET',
        `/api/v1/qc/tasks/${held.taskId}/${path}`,
        undefined,
        inspectorHeaders,
      );
      assert.strictEqual(res.status, 403, `${path}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }
  });

  it('AC5 regression: one poisoned row does not abort the whole sweep', async () => {
    // The sweep used to run every due row in one undivided transaction, so a single failure rolled
    // back every sample already transitioned in that tick and returned a result identical to
    // "nothing was due" - one bad row silently stopped all retention alerting, hourly, forever.
    const good = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(good.taskId)).status, 201);
    const poisoned = await accepted(await planOk(), '5.000000');
    assert.strictEqual((await logRetentionSample(poisoned.taskId)).status, 201);

    for (const lotId of [good.lotId, poisoned.lotId]) {
      await getAdminPool().query(
        `UPDATE qc_retention_sample
            SET expires_on = ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)
          WHERE lot_id = $1`,
        [lotId],
      );
    }
    // Break exactly one row with a surgical CHECK that refuses only ITS transition, so the applier
    // genuinely throws part-way through the batch.
    const poisonedSample = await retentionSampleRow(poisoned.lotId);
    await getAdminPool().query(
      `ALTER TABLE qc_retention_sample ADD CONSTRAINT tmp_poison_8_4
         CHECK (NOT (retention_sample_id = '${poisonedSample?.['retention_sample_id'] as string}'
                     AND status = 'disposal_pending'))`,
    );
    try {
      const swept = await runRetentionExpiryCycle();
      // The cycle itself succeeded, the healthy row committed, and the bad row was counted and
      // left behind for the next tick instead of taking the whole batch down with it.
      assert.strictEqual(swept.cycleFailed, false, JSON.stringify(swept));
      assert.strictEqual(swept.disposalPending, 1, JSON.stringify(swept));
      assert.strictEqual(swept.failed, 1, JSON.stringify(swept));
      assert.strictEqual((await retentionSampleRow(good.lotId))?.['status'], 'disposal_pending');
      assert.strictEqual((await retentionSampleRow(poisoned.lotId))?.['status'], 'retained');
    } finally {
      await getAdminPool().query(
        `ALTER TABLE qc_retention_sample DROP CONSTRAINT tmp_poison_8_4`,
      );
    }

    // Once the poison is gone the previously failing row sweeps normally on the next tick.
    const recovered = await runRetentionExpiryCycle();
    assert.strictEqual(recovered.failed, 0, JSON.stringify(recovered));
    assert.strictEqual((await retentionSampleRow(poisoned.lotId))?.['status'], 'disposal_pending');
  });
});

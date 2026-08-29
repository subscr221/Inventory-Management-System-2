import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PoolClient } from 'pg';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';
import { persistEvent } from '../../src/events/store.js';
import { receiveQcCompletion } from '../../src/quality/completion.js';
import { assertQcGateAllows } from '../../src/compliance/quality.js';
import { applyStockIssue } from '../../src/read/projections/stock_balance.js';
import type { QcGateOperation } from '../../src/compliance/quality.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 8.1 Inspection Plans and QC Gate (FR-Q-01, FR-Q-02, FR-Q-05). Real PostgreSQL, the real
 * production router, SCIM provisioning and dev-token auth. Dedicated routes carry the ordinary
 * behaviour; direct persistEvent / POST /api/v1/events carry the bypass, forgery, stream-mismatch
 * and replay proofs. Tests run serially; every identifier is run-scoped.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DEVICE_ID = `edge-8-1-${run}`;

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
    req.setTimeout(20000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Story 8.1 Inspection Plans and QC Gate', () => {
  let server: Server;
  let port: number;

  let qcHeadUserId: string;
  let qcHeadHeaders: Record<string, string>;
  let inspectorUserId: string;
  let inspectorHeaders: Record<string, string>;
  let delegateUserId: string;
  let delegateHeaders: Record<string, string>;
  let engineerUserId: string;
  let engineerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let procurementHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let binA2Id: string;
  let siteBId: string;
  let binB1Id: string;

  let fgItemId: string;
  let fgSku: string;
  let fgRevisionId: string;
  let fgBomId: string;
  let otherItemId: string;
  let otherRevisionId: string;
  let componentItemId: string;

  let standardPlanId: string;
  let standardV1Id: string;

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
        description: `Story 8.1 item ${sku}`,
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

  function componentLine(lineNo: number, componentId: string): Record<string, unknown> {
    return {
      line_no: lineNo,
      component_item_id: componentId,
      output_class: 'component',
      quantity_per: '2.0',
      line_uom: 'EA',
      uom_conversion_factor: '1.0',
      scrap_percent: '0.0',
      is_phantom: false,
      effective_from: '2020-01-01',
    };
  }

  async function draftBom(
    parentItemId: string,
    bomType: 'production' | 'rnd' = 'production',
  ): Promise<{ bomId: string; revisionId: string }> {
    const draft = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'A',
        bom_type: bomType,
        lines: [componentLine(1, componentItemId)],
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
    assert.strictEqual(draft.status, 201, `draft failed: ${JSON.stringify(draft.body)}`);
    return {
      bomId: draft.body['bom_id'] as string,
      revisionId: draft.body['current_revision_id'] as string,
    };
  }

  async function draftAndRelease(
    parentItemId: string,
  ): Promise<{ bomId: string; revisionId: string }> {
    const { bomId, revisionId } = await draftBom(parentItemId);
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
    return { bomId, revisionId };
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

  function characteristics(): Record<string, unknown>[] {
    return [
      {
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
        sample_handling: 'Machine three coupons per lot; test within 24h',
      },
      {
        line_no: 2,
        characteristic_name: 'Surface finish',
        characteristic_class: 'minor',
        test_method_ref: 'SOP-QC-014',
        instrument_type: null,
        result_kind: 'attribute',
        lower_limit: null,
        upper_limit: null,
        limit_uom: null,
        acceptance_criteria: 'No visible scratches under 500 lux',
        sample_handling: 'Visual, 100% of sample',
      },
    ];
  }

  async function createPlanVersion(
    body: Record<string, unknown>,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/qc/inspection-plans',
      {
        scope: 'standard',
        item_id: fgItemId,
        bom_revision_id: fgRevisionId,
        effective_from: '2026-01-01',
        aql: '1.000',
        inspection_level: 'II',
        characteristics: characteristics(),
        ...body,
      },
      headers,
    );
  }

  async function approveVersion(
    planId: string,
    versionId: string,
    headers: Record<string, string>,
    idempotencyKey: string = randomUUID(),
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/inspection-plans/${planId}/versions/${versionId}/approve`,
      { idempotency_key: idempotencyKey },
      headers,
    );
  }

  async function seedDoa(transactionType: string, role: string): Promise<string> {
    const entryId = randomUUID();
    await getPool().query(
      `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
       VALUES ($1, $2, $3, NULL, NULL, true)`,
      [entryId, role, transactionType],
    );
    return entryId;
  }

  async function clearDoa(transactionType: string): Promise<void> {
    await getAdminPool().query(`DELETE FROM doa_registry_entries WHERE transaction_type = $1`, [
      transactionType,
    ]);
  }

  let lotCounter = 0;
  async function seedLotWithStock(
    sku: string,
    locationId: string,
    quantity: string,
  ): Promise<{ lotId: string; lotNumber: string }> {
    lotCounter += 1;
    const lotId = randomUUID();
    const lotNumber = `FG-LOT-${run}-${lotCounter}`;
    await getPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status) VALUES ($1, $2, $3, 'none')`,
      [lotId, lotNumber, sku],
    );
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', $4::numeric)`,
      [sku, locationId, lotNumber, quantity],
    );
    return { lotId, lotNumber };
  }

  function completionBody(
    lot: { lotId: string; lotNumber: string },
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      source_completion_type: 'synthetic_completion',
      source_completion_id: randomUUID(),
      lot_id: lot.lotId,
      lot_number: lot.lotNumber,
      item_id: fgItemId,
      quantity: '100.000000',
      uom: 'EA',
      site_id: siteAId,
      bom_revision_id: fgRevisionId,
      completed_at: '2026-07-15T10:00:00.000+05:30',
      business_stream: 'production',
      source_order_type: null,
      source_order_ref: null,
      ...overrides,
    };
  }

  async function submitCompletion(
    body: Record<string, unknown>,
    headers: Record<string, string> = inspectorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/qc/completions', body, headers);
  }

  /** A held lot at binA1 with an open task (the common fixture for the no-bypass proofs). */
  async function heldLot(
    quantity: string = '100.000000',
    locationId: string = binA1Id,
  ): Promise<{ lotId: string; lotNumber: string; taskId: string }> {
    const lot = await seedLotWithStock(fgSku, locationId, quantity);
    const res = await submitCompletion(completionBody(lot, { quantity }));
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const task = res.body['task'] as Record<string, unknown>;
    return { ...lot, taskId: task['task_id'] as string };
  }

  function releaseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      justification: 'Customer line-down; visual and dimensional checks passed',
      conditions: 'Move only to the rework bay; no dispatch',
      scope_kind: 'internal_movement',
      scope_ref: binA2Id,
      expires_on: isoDaysFromNow(7),
      ...overrides,
    };
  }

  async function conditionalRelease(
    taskId: string,
    headers: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/conditional-release`,
      releaseBody(overrides),
      headers,
    );
  }

  function inventoryEnvelope(
    eventType: string,
    payload: Record<string, unknown>,
    streamType: string = 'inventory',
  ): Record<string, unknown> {
    return {
      stream_type: streamType,
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

  async function taskRow(taskId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(`SELECT * FROM qc_inspection_task WHERE task_id = $1`, [
      taskId,
    ]);
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  async function notificationCountFor(objectId: string, targetRole: string): Promise<number> {
    return countRows(
      'domain_events',
      `event_type = 'notification.created' AND payload->>'object_id' = $1 AND payload->'target'->>'role' = $2`,
      [objectId, targetRole],
    );
  }

  async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('ROLLBACK');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function gateRejection(
    check: Omit<Parameters<typeof assertQcGateAllows>[0], 'client'>,
  ): Promise<Record<string, unknown> | null> {
    return withTransaction(async (client) => {
      try {
        await assertQcGateAllows({ ...check, client });
        return null;
      } catch (err) {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return { error_code: e.errorCode, ...e.details };
      }
    });
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
      '../../read/projections/inspection_plan.sql',
      '../../read/projections/inspection_plan_version.sql',
      '../../read/projections/inspection_plan_characteristic.sql',
      '../../read/projections/inspection_plan_approval.sql',
      '../../read/projections/qc_inspection_task.sql',
      '../../read/projections/qc_deviation.sql',
      '../../read/projections/qc_lot_disposition.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, dispatch_document, packing_record, dispatch_order_status, pick_line, pick_task, in_transit, transfer_request, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, integration_exception, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-1-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-1-${run}`, siteAId, siteAId);
    binA2Id = await seedLocation('bin', `BIN-A2-8-1-${run}`, siteAId, siteAId);
    siteBId = await seedLocation('site', `SITE-B-8-1-${run}`, null, null);
    binB1Id = await seedLocation('bin', `BIN-B1-8-1-${run}`, siteBId, siteBId);

    qcHeadUserId = await provisionUser(port, `qc-head-8-1-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-1-${run}@example.com`);

    inspectorUserId = await provisionUser(port, `qc-inspector-8-1-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteAId },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
      { role: 'qc_inspector', module: 'quality', functionScope: 'write', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-8-1-${run}@example.com`);

    delegateUserId = await provisionUser(port, `qc-delegate-8-1-${run}@example.com`, [
      { role: `qc_delegate_${run}`, module: 'qc', functionScope: 'write', locationId: '*' },
    ]);
    delegateHeaders = await authFor(port, `qc-delegate-8-1-${run}@example.com`);

    engineerUserId = await provisionUser(port, `engineer-8-1-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: '*' },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-1-${run}@example.com`);

    await provisionUser(port, `qc-reader-8-1-${run}@example.com`, [
      { role: `qc_reader_${run}`, module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `qc-reader-8-1-${run}@example.com`);

    await provisionUser(port, `proc-8-1-${run}@example.com`, [
      { role: 'buyer', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);
    procurementHeaders = await authFor(port, `proc-8-1-${run}@example.com`);

    componentItemId = await createItem(`CMP-8-1-${run}`, { lot_controlled: false });
    fgSku = `FG-8-1-${run}`;
    fgItemId = await createItem(fgSku);
    const released = await draftAndRelease(fgItemId);
    fgRevisionId = released.revisionId;
    fgBomId = released.bomId;
    otherItemId = await createItem(`FG-OTHER-8-1-${run}`);
    otherRevisionId = (await draftAndRelease(otherItemId)).revisionId;
    assert.ok(fgBomId);
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: immutable versions, characteristic pairing, spec correspondence
  // -------------------------------------------------------------------------

  it('AC1: creates an immutable plan version bound to the released spec revision with ordered characteristics', async () => {
    const res = await createPlanVersion({});
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const plan = res.body['plan'] as Record<string, unknown>;
    const version = res.body['version'] as Record<string, unknown>;
    const lines = res.body['characteristics'] as Record<string, unknown>[];
    standardPlanId = plan['plan_id'] as string;
    standardV1Id = version['plan_version_id'] as string;
    assert.strictEqual(plan['scope'], 'standard');
    assert.strictEqual(plan['sku'], fgSku);
    assert.strictEqual(plan['bom_revision_id'], fgRevisionId);
    assert.strictEqual(version['version_no'], 1);
    assert.strictEqual(version['effective_from'], '2026-01-01');
    assert.strictEqual(version['aql'], '1.000');
    assert.strictEqual(version['approved'], false);
    assert.deepStrictEqual(
      lines.map((l) => [l['line_no'], l['result_kind']]),
      [
        [1, 'numeric'],
        [2, 'attribute'],
      ],
    );
    assert.strictEqual(lines[0]!['lower_limit'], '410.000000');

    // The persisted event carries the SERVER-derived version_no and sku.
    const ev = await getAdminPool().query(`SELECT payload FROM domain_events WHERE event_id = $1`, [
      res.body['event_id'],
    ]);
    const payload = ev.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['version_no'], 1);
    assert.strictEqual(payload['sku'], fgSku);

    // Immutability: app_user has no UPDATE or DELETE on the version tables.
    await assert.rejects(
      getPool().query(`UPDATE inspection_plan_version SET aql = 2 WHERE plan_version_id = $1`, [
        standardV1Id,
      ]),
      (err: unknown) => (err as { code?: string }).code === '42501',
    );
    await assert.rejects(
      getPool().query(`DELETE FROM inspection_plan_characteristic WHERE plan_version_id = $1`, [
        standardV1Id,
      ]),
      (err: unknown) => (err as { code?: string }).code === '42501',
    );
  });

  it('AC1: a second version on the same effective date is INSPECTION_PLAN_EFFECTIVITY_CONFLICT; a later date allocates version 2', async () => {
    const same = await createPlanVersion({});
    assert.strictEqual(same.status, 409, JSON.stringify(same.body));
    assert.strictEqual(same.body['error_code'], 'INSPECTION_PLAN_EFFECTIVITY_CONFLICT');
    assert.strictEqual(detailsOf(same.body)['existing_plan_version_id'], standardV1Id);

    const later = await createPlanVersion({ effective_from: '2026-06-01' });
    assert.strictEqual(later.status, 201, JSON.stringify(later.body));
    const version = later.body['version'] as Record<string, unknown>;
    assert.strictEqual(version['version_no'], 2);
    assert.strictEqual((later.body['plan'] as Record<string, unknown>)['plan_id'], standardPlanId);
    assert.strictEqual(await countRows('inspection_plan', 'plan_id = $1', [standardPlanId]), 1);
  });

  it('AC1: concurrent same-scope same-date creates resolve to exactly one version', async () => {
    const body = { effective_from: '2026-09-01' };
    const [a, b] = await Promise.all([createPlanVersion(body), createPlanVersion(body)]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));
    const rejected = a.status === 409 ? a : b;
    assert.strictEqual(rejected.body['error_code'], 'INSPECTION_PLAN_EFFECTIVITY_CONFLICT');
    assert.strictEqual(
      await countRows('inspection_plan_version', `plan_id = $1 AND effective_from = '2026-09-01'`, [
        standardPlanId,
      ]),
      1,
    );
  });

  it('AC1: characteristic kind/limit pairing is enforced before any write', async () => {
    const before = await countRows('inspection_plan_version', 'plan_id = $1', [standardPlanId]);
    const numericNoLimits = await createPlanVersion({
      effective_from: '2027-01-01',
      characteristics: [{ ...characteristics()[0]!, lower_limit: null, upper_limit: null }],
    });
    assert.strictEqual(numericNoLimits.status, 400, JSON.stringify(numericNoLimits.body));
    assert.strictEqual(numericNoLimits.body['error_code'], 'INVALID_PAYLOAD');
    const attributeWithLimits = await createPlanVersion({
      effective_from: '2027-01-01',
      characteristics: [{ ...characteristics()[1]!, lower_limit: '1.0' }],
    });
    assert.strictEqual(attributeWithLimits.status, 400);
    const inverted = await createPlanVersion({
      effective_from: '2027-01-01',
      characteristics: [{ ...characteristics()[0]!, lower_limit: '600', upper_limit: '500' }],
    });
    assert.strictEqual(inverted.status, 400);
    const samplingPairing = await createPlanVersion({
      effective_from: '2027-01-01',
      aql: '1.000',
      inspection_level: null,
    });
    assert.strictEqual(samplingPairing.status, 400);
    assert.strictEqual(
      await countRows('inspection_plan_version', 'plan_id = $1', [standardPlanId]),
      before,
    );
  });

  it('AC1: a draft revision, an R&D BOM and a foreign item revision each fail closed', async () => {
    // One BOM per parent item: add a DRAFT revision to the released BOM directly.
    const draftRevision = randomUUID();
    await getPool()
      .query(
        `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, drafted_at, source_event_id)
       VALUES ($1, $2, 'DRAFT-8-1', 'draft', $3, now(), $4)`,
        [draftRevision, fgBomId, engineerUserId, randomUUID()],
      )
      .catch(() => undefined);
    const notReleased = await createPlanVersion({
      bom_revision_id: draftRevision,
      effective_from: '2027-02-01',
    });
    assert.ok([404, 409].includes(notReleased.status), JSON.stringify(notReleased.body));
    assert.ok(
      ['BOM_NOT_RELEASED', 'BOM_REVISION_NOT_FOUND'].includes(
        notReleased.body['error_code'] as string,
      ),
    );

    const foreign = await createPlanVersion({
      bom_revision_id: otherRevisionId,
      effective_from: '2027-02-01',
    });
    assert.strictEqual(foreign.status, 409, JSON.stringify(foreign.body));
    assert.strictEqual(foreign.body['error_code'], 'INSPECTION_PLAN_SCOPE_MISMATCH');

    const rndItem = await createItem(`RND-8-1-${run}`);
    const rnd = await draftBom(rndItem, 'rnd');
    await getPool().query(
      `UPDATE bom_revision SET revision_status = 'released' WHERE revision_id = $1`,
      [rnd.revisionId],
    );
    const barred = await createPlanVersion({
      item_id: rndItem,
      bom_revision_id: rnd.revisionId,
      effective_from: '2027-02-01',
    });
    assert.strictEqual(barred.status, 409, JSON.stringify(barred.body));
    assert.strictEqual(barred.body['error_code'], 'RD_EXECUTION_BARRED');
  });

  // -------------------------------------------------------------------------
  // AC1: DOA-gated approval
  // -------------------------------------------------------------------------

  it('AC1: approval with no DOA entry is 404 APPROVAL_UNRESOLVED and audited; a non-QC-Head governing role fails closed', async () => {
    await clearDoa('qc.inspection_plan_approval');
    const none = await approveVersion(standardPlanId, standardV1Id, qcHeadHeaders);
    assert.strictEqual(none.status, 404, JSON.stringify(none.body));
    assert.strictEqual(none.body['error_code'], 'APPROVAL_UNRESOLVED');
    assert.strictEqual(
      await countRows(
        'audit_log',
        `error_code = 'APPROVAL_UNRESOLVED' AND user_id = $1 AND endpoint LIKE '%/approve' AND details->>'plan_version_id' = $2`,
        [qcHeadUserId, standardV1Id],
      ),
      1,
    );

    await seedDoa('qc.inspection_plan_approval', 'qc_inspector');
    const wrongRole = await approveVersion(standardPlanId, standardV1Id, inspectorHeaders);
    assert.strictEqual(wrongRole.status, 404, JSON.stringify(wrongRole.body));
    assert.strictEqual(wrongRole.body['error_code'], 'APPROVAL_UNRESOLVED');
    assert.strictEqual(detailsOf(wrongRole.body)['reason'], 'governing_role_not_qc_head');
    await clearDoa('qc.inspection_plan_approval');

    // A QC Head-level role with no active holder is fail-closed too.
    await seedDoa('qc.inspection_plan_approval', 'qc_head');
    await getAdminPool().query(`UPDATE users SET active = false WHERE user_id = $1`, [
      qcHeadUserId,
    ]);
    try {
      const noHolder = await approveVersion(standardPlanId, standardV1Id, inspectorHeaders);
      assert.strictEqual(noHolder.status, 409, JSON.stringify(noHolder.body));
      assert.strictEqual(noHolder.body['error_code'], 'APPROVAL_UNRESOLVED');
      assert.strictEqual(detailsOf(noHolder.body)['reason'], 'no_active_holder');
    } finally {
      await getAdminPool().query(`UPDATE users SET active = true WHERE user_id = $1`, [
        qcHeadUserId,
      ]);
    }
    assert.strictEqual(
      await countRows('inspection_plan_approval', 'plan_id = $1', [standardPlanId]),
      0,
    );
  });

  it('AC1: qc module write access alone cannot approve (403 APPROVAL_REQUIRED, audited, nothing persisted); the resolved QC Head can, exactly once', async () => {
    const forbidden = await approveVersion(standardPlanId, standardV1Id, inspectorHeaders);
    assert.strictEqual(forbidden.status, 403, JSON.stringify(forbidden.body));
    assert.strictEqual(forbidden.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(forbidden.body)['resolved_approver_user_id'], qcHeadUserId);
    const audit = await getAdminPool().query(
      `SELECT trace_id, role, details FROM audit_log
        WHERE error_code = 'APPROVAL_REQUIRED' AND user_id = $1 AND endpoint LIKE '%/approve'
          AND details->>'plan_version_id' = $2`,
      [inspectorUserId, standardV1Id],
    );
    assert.strictEqual(audit.rows.length, 1);
    assert.ok((audit.rows[0]!['trace_id'] as string).length > 0);
    assert.strictEqual(
      await countRows('inspection_plan_approval', 'plan_id = $1', [standardPlanId]),
      0,
    );
    assert.strictEqual(
      await countRows('domain_events', `event_type = 'qc.inspection_plan_approved'`, []),
      0,
    );

    const key = randomUUID();
    const ok = await approveVersion(standardPlanId, standardV1Id, qcHeadHeaders, key);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const approval = ok.body['approval'] as Record<string, unknown>;
    assert.strictEqual(approval['approved_by'], qcHeadUserId);
    assert.strictEqual(approval['resolved_approver_user_id'], qcHeadUserId);
    assert.strictEqual(approval['governing_role'], 'qc_head');
    assert.ok(approval['doa_entry_id']);
    assert.strictEqual((ok.body['version'] as Record<string, unknown>)['approved'], true);

    // Same-key replay returns the same event; a second approval is 409.
    const replay = await approveVersion(standardPlanId, standardV1Id, qcHeadHeaders, key);
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body['event_id'], ok.body['event_id']);
    const again = await approveVersion(standardPlanId, standardV1Id, qcHeadHeaders);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'INSPECTION_PLAN_ALREADY_APPROVED');
    assert.strictEqual(
      await countRows('inspection_plan_approval', 'plan_version_id = $1', [standardV1Id]),
      1,
    );
  });

  it('AC1: concurrent approvals of one version resolve to one approval record', async () => {
    const created = await createPlanVersion({ effective_from: '2026-03-01' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const versionId = (created.body['version'] as Record<string, unknown>)[
      'plan_version_id'
    ] as string;
    const [a, b] = await Promise.all([
      approveVersion(standardPlanId, versionId, qcHeadHeaders),
      approveVersion(standardPlanId, versionId, qcHeadHeaders),
    ]);
    assert.deepStrictEqual(
      [a.status, b.status].sort(),
      [200, 409],
      JSON.stringify([a.body, b.body]),
    );
    assert.strictEqual(
      await countRows('inspection_plan_approval', 'plan_version_id = $1', [versionId]),
      1,
    );
  });

  it('AC1: an active delegation makes the delegate the approver and the delegating QC Head cannot approve meanwhile', async () => {
    const created = await createPlanVersion({ effective_from: '2026-06-01', plan_id: undefined });
    // 2026-06-01 already exists on the standard plan; use a fresh date instead.
    assert.strictEqual(created.status, 409);
    const fresh = await createPlanVersion({ effective_from: '2026-04-01' });
    assert.strictEqual(fresh.status, 201, JSON.stringify(fresh.body));
    const versionId = (fresh.body['version'] as Record<string, unknown>)[
      'plan_version_id'
    ] as string;

    const delegationId = randomUUID();
    await getPool().query(
      `INSERT INTO doa_vacation_delegations (delegation_id, delegator_user_id, delegate_user_id, start_date, end_date, active)
       VALUES ($1, $2, $3, $4::date, $5::date, true)`,
      [delegationId, qcHeadUserId, delegateUserId, isoDaysFromNow(-2), isoDaysFromNow(2)],
    );
    try {
      const headBlocked = await approveVersion(standardPlanId, versionId, qcHeadHeaders);
      assert.strictEqual(headBlocked.status, 403, JSON.stringify(headBlocked.body));
      assert.strictEqual(detailsOf(headBlocked.body)['resolved_approver_user_id'], delegateUserId);
      const delegated = await approveVersion(standardPlanId, versionId, delegateHeaders);
      assert.strictEqual(delegated.status, 200, JSON.stringify(delegated.body));
      const approval = delegated.body['approval'] as Record<string, unknown>;
      assert.strictEqual(approval['approved_by'], delegateUserId);
      assert.strictEqual(approval['governing_role'], 'qc_head');
    } finally {
      await getAdminPool().query(
        `UPDATE doa_vacation_delegations SET active = false WHERE delegation_id = $1`,
        [delegationId],
      );
    }
  });

  it('AC1: direct events cannot forge approval identity, declare derived fields, or ride a foreign stream', async () => {
    const created = await createPlanVersion({ effective_from: '2026-05-01' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const versionId = (created.body['version'] as Record<string, unknown>)[
      'plan_version_id'
    ] as string;
    const base = {
      stream_type: 'qc',
      stream_id: standardPlanId,
      event_type: 'qc.inspection_plan_approved',
      payload: {
        plan_id: standardPlanId,
        plan_version_id: versionId,
        approved_at: new Date().toISOString(),
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    };
    // Declared derived approver identity.
    await assert.rejects(
      persistEvent({
        ...base,
        payload: { ...base.payload, approved_by: qcHeadUserId, doa_entry_id: randomUUID() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'QC_DERIVATION_MISMATCH',
    );
    // A non-approver actor through the seam, with no handler in front.
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      persistEvent(base as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'APPROVAL_REQUIRED' &&
        (err as { statusCode?: number }).statusCode === 403,
    );
    // The same event name on a foreign stream is rejected outright, not silently ignored - on the
    // inventory stream (where tagging would otherwise answer first) and on a non-inventory stream
    // (where nothing else would have objected at all).
    for (const foreignStream of ['inventory', 'maintenance']) {
      await assert.rejects(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persistEvent({ ...base, stream_type: foreignStream } as any),
        (err: unknown) => (err as { errorCode?: string }).errorCode === 'INVALID_PAYLOAD',
      );
    }
    assert.strictEqual(
      await countRows('inspection_plan_approval', 'plan_version_id = $1', [versionId]),
      0,
    );
    assert.strictEqual(
      await countRows(
        'domain_events',
        `event_type = 'qc.inspection_plan_approved' AND payload->>'plan_version_id' = $1`,
        [versionId],
      ),
      0,
    );
    // The approved version is still usable through the seam by the real approver.
    const ok = await approveVersion(standardPlanId, versionId, qcHeadHeaders);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  // -------------------------------------------------------------------------
  // AC1/AC2: deterministic resolution and customer overrides
  // -------------------------------------------------------------------------

  it('AC1: resolution picks the latest approved effective version, excludes future-effective and draft versions', async () => {
    // Approved so far: 2026-01-01 (v1), 2026-03-01, 2026-04-01, 2026-05-01. Unapproved: 2026-06-01,
    // 2026-09-01. Approve a far-future version too.
    const future = await createPlanVersion({ effective_from: '2030-01-01' });
    assert.strictEqual(future.status, 201);
    const futureId = (future.body['version'] as Record<string, unknown>)[
      'plan_version_id'
    ] as string;
    assert.strictEqual((await approveVersion(standardPlanId, futureId, qcHeadHeaders)).status, 200);

    const resolveAt = async (date: string): Promise<HttpResult> =>
      makeRequest(
        port,
        'GET',
        `/api/v1/qc/inspection-plans/resolve?item_id=${fgItemId}&bom_revision_id=${fgRevisionId}&business_date=${date}`,
        undefined,
        readerHeaders,
      );
    const july = await resolveAt('2026-07-15');
    assert.strictEqual(july.status, 200, JSON.stringify(july.body));
    assert.strictEqual(
      (july.body['version'] as Record<string, unknown>)['effective_from'],
      '2026-05-01',
    );
    assert.strictEqual(july.body['scope'], 'standard');
    const feb = await resolveAt('2026-02-10');
    assert.strictEqual(
      (feb.body['version'] as Record<string, unknown>)['plan_version_id'],
      standardV1Id,
    );
    const before = await resolveAt('2025-12-31');
    assert.strictEqual(before.status, 409, JSON.stringify(before.body));
    assert.strictEqual(before.body['error_code'], 'INSPECTION_PLAN_NOT_APPROVED');
    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/inspection-plans/resolve?item_id=${otherItemId}&bom_revision_id=${otherRevisionId}&business_date=2026-07-15`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'INSPECTION_PLAN_NOT_FOUND');
  });

  it('AC2: an approved order-scoped customer plan applies for that order only and never affects another order', async () => {
    const orderRef = `JWO-${run}-1`;
    const override = await createPlanVersion({
      scope: 'customer_override',
      source_order_type: 'job_work_order',
      source_order_ref: orderRef,
      effective_from: '2026-01-01',
      characteristics: [
        { ...characteristics()[0]!, lower_limit: '450.000000', upper_limit: '560.000000' },
      ],
    });
    assert.strictEqual(override.status, 201, JSON.stringify(override.body));
    const overridePlanId = (override.body['plan'] as Record<string, unknown>)['plan_id'] as string;
    const overrideVersionId = (override.body['version'] as Record<string, unknown>)[
      'plan_version_id'
    ] as string;
    assert.notStrictEqual(overridePlanId, standardPlanId);

    const query = (ref: string): string =>
      `/api/v1/qc/inspection-plans/resolve?item_id=${fgItemId}&bom_revision_id=${fgRevisionId}&business_date=2026-07-15&source_order_type=job_work_order&source_order_ref=${ref}`;
    // Unapproved (draft) override fails closed (Annex requirement 8).
    const unapproved = await makeRequest(port, 'GET', query(orderRef), undefined, readerHeaders);
    assert.strictEqual(unapproved.status, 409, JSON.stringify(unapproved.body));
    assert.strictEqual(unapproved.body['error_code'], 'INSPECTION_PLAN_NOT_APPROVED');

    assert.strictEqual(
      (await approveVersion(overridePlanId, overrideVersionId, qcHeadHeaders)).status,
      200,
    );
    const applied = await makeRequest(port, 'GET', query(orderRef), undefined, readerHeaders);
    assert.strictEqual(applied.body['scope'], 'customer_override');
    assert.strictEqual(
      (applied.body['plan'] as Record<string, unknown>)['plan_id'],
      overridePlanId,
    );
    const otherOrder = await makeRequest(
      port,
      'GET',
      query(`JWO-${run}-2`),
      undefined,
      readerHeaders,
    );
    assert.strictEqual(otherOrder.body['scope'], 'standard');
    const noOrder = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/inspection-plans/resolve?item_id=${fgItemId}&bom_revision_id=${fgRevisionId}&business_date=2026-07-15`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(noOrder.body['scope'], 'standard');

    // Arbitrary order types are not exposed.
    const arbitrary = await createPlanVersion({
      scope: 'customer_override',
      source_order_type: 'sales_order',
      source_order_ref: 'SO-1',
      effective_from: '2026-01-01',
    });
    assert.strictEqual(arbitrary.status, 400);
  });

  // -------------------------------------------------------------------------
  // AC3: the producer-neutral completion contract
  // -------------------------------------------------------------------------

  it('AC3: a synthetic completion freezes the resolved plan, creates the task in qc_hold, audits and notifies transactionally', async () => {
    const lot = await seedLotWithStock(fgSku, binA1Id, '100.000000');
    const key = randomUUID();
    const res = await submitCompletion({ ...completionBody(lot), idempotency_key: key });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const task = res.body['task'] as Record<string, unknown>;
    assert.strictEqual(task['gate_status'], 'qc_hold');
    assert.strictEqual(task['task_status'], 'open');
    assert.strictEqual(task['business_date'], '2026-07-15');
    assert.strictEqual(task['plan_scope'], 'standard');
    assert.strictEqual(task['quantity'], '100.000000');
    assert.strictEqual(task['sku'], fgSku);
    const frozen = await getAdminPool().query(
      `SELECT effective_from::text AS effective_from FROM inspection_plan_version WHERE plan_version_id = $1`,
      [task['plan_version_id']],
    );
    assert.strictEqual(frozen.rows[0]!['effective_from'], '2026-05-01');

    const ev = await getAdminPool().query(
      `SELECT stream_type, payload FROM domain_events WHERE event_id = $1`,
      [res.body['event_id']],
    );
    assert.strictEqual(ev.rows[0]!['stream_type'], 'qc');
    const payload = ev.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['gate_status'], 'qc_hold');
    assert.strictEqual(payload['plan_version_id'], task['plan_version_id']);
    assert.strictEqual(payload['business_date'], '2026-07-15');
    assert.strictEqual(
      await countRows(
        'audit_log',
        `event_id = $1 AND http_status = 201 AND endpoint LIKE '%/qc/completions'`,
        [res.body['event_id']],
      ),
      1,
    );
    // The transactional notification names a real recipient at the site.
    const recipients = await countRows(
      'user_role_assignments',
      `role = $1 AND (location_id = $2 OR location_id = '*')`,
      [config.quality.inspectionTaskNotificationRole, siteAId],
    );
    assert.ok(recipients >= 1, 'the inspector must hold the notification role at site A');
    assert.strictEqual(
      await notificationCountFor(
        task['task_id'] as string,
        config.quality.inspectionTaskNotificationRole,
      ),
      1,
    );

    // Same-key replay is the same task, no second event, task, or notification.
    const replay = await submitCompletion({ ...completionBody(lot), idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['task'] as Record<string, unknown>)['task_id'],
      task['task_id'],
    );
    assert.strictEqual(await countRows('qc_inspection_task', 'lot_id = $1', [lot.lotId]), 1);
    assert.strictEqual(
      await notificationCountFor(
        task['task_id'] as string,
        config.quality.inspectionTaskNotificationRole,
      ),
      1,
    );
    // A different key for the same lot or the same source completion is one effect, not two.
    const dupLot = await submitCompletion(completionBody(lot));
    assert.strictEqual(dupLot.status, 409, JSON.stringify(dupLot.body));
    assert.strictEqual(dupLot.body['error_code'], 'DUPLICATE_QC_COMPLETION');
    assert.strictEqual(detailsOf(dupLot.body)['existing_task_id'], task['task_id']);
  });

  it('AC3: a later plan approval never changes the plan version frozen on an existing held lot', async () => {
    const held = await heldLot();
    const before = (await taskRow(held.taskId))!['plan_version_id'];
    const newer = await createPlanVersion({ effective_from: '2026-07-01' });
    assert.strictEqual(newer.status, 201, JSON.stringify(newer.body));
    const newerId = (newer.body['version'] as Record<string, unknown>)['plan_version_id'] as string;
    assert.strictEqual((await approveVersion(standardPlanId, newerId, qcHeadHeaders)).status, 200);
    assert.strictEqual((await taskRow(held.taskId))!['plan_version_id'], before);
    // A NEW lot completed on the same business date now resolves the newer version.
    const fresh = await heldLot();
    assert.strictEqual((await taskRow(fresh.taskId))!['plan_version_id'], newerId);
  });

  it('AC3: a hand-off whose lot or finished stock is missing, wrong, or already sellable is QC_HOLD_REQUIRED with no partial effects', async () => {
    const eventsBefore = await countRows(
      'domain_events',
      `event_type = 'qc.completion_received'`,
      [],
    );
    const missingLot = await submitCompletion(
      completionBody({ lotId: randomUUID(), lotNumber: `GHOST-${run}` }),
    );
    assert.strictEqual(missingLot.status, 409, JSON.stringify(missingLot.body));
    assert.strictEqual(missingLot.body['error_code'], 'QC_HOLD_REQUIRED');
    assert.strictEqual(detailsOf(missingLot.body)['reason'], 'lot_missing');

    const noStock = { lotId: randomUUID(), lotNumber: `NOSTOCK-${run}` };
    await getPool().query(`INSERT INTO lot_master (lot_id, lot_number, sku) VALUES ($1, $2, $3)`, [
      noStock.lotId,
      noStock.lotNumber,
      fgSku,
    ]);
    const missingStock = await submitCompletion(completionBody(noStock));
    assert.strictEqual(missingStock.status, 409);
    assert.strictEqual(detailsOf(missingStock.body)['reason'], 'finished_stock_missing');

    const wrongQty = await seedLotWithStock(fgSku, binA1Id, '90.000000');
    const mismatch = await submitCompletion(completionBody(wrongQty, { quantity: '100.000000' }));
    assert.strictEqual(mismatch.status, 409);
    assert.strictEqual(detailsOf(mismatch.body)['reason'], 'finished_stock_missing');

    const sellable = await seedLotWithStock(fgSku, binA1Id, '100.000000');
    await getPool().query(`UPDATE stock_balance SET allocated = 10 WHERE lot_id = $1`, [
      sellable.lotNumber,
    ]);
    const alreadySellable = await submitCompletion(completionBody(sellable));
    assert.strictEqual(alreadySellable.status, 409, JSON.stringify(alreadySellable.body));
    assert.strictEqual(detailsOf(alreadySellable.body)['reason'], 'stock_sellable');

    const otherSite = await seedLotWithStock(fgSku, binB1Id, '100.000000');
    const wrongSite = await submitCompletion(completionBody(otherSite));
    assert.strictEqual(wrongSite.status, 409, JSON.stringify(wrongSite.body));

    // No plan for the item at all fails closed and leaves nothing behind.
    const noPlanLot = await seedLotWithStock(`FG-OTHER-8-1-${run}`, binA1Id, '5.000000');
    const noPlan = await submitCompletion(
      completionBody(noPlanLot, {
        item_id: otherItemId,
        bom_revision_id: otherRevisionId,
        quantity: '5.000000',
      }),
    );
    assert.strictEqual(noPlan.status, 404, JSON.stringify(noPlan.body));
    assert.strictEqual(noPlan.body['error_code'], 'INSPECTION_PLAN_NOT_FOUND');

    assert.strictEqual(
      await countRows('domain_events', `event_type = 'qc.completion_received'`, []),
      eventsBefore,
    );
    for (const lot of [noStock, wrongQty, sellable, otherSite, noPlanLot]) {
      assert.strictEqual(await countRows('qc_inspection_task', 'lot_id = $1', [lot.lotId]), 0);
    }
  });

  it('AC3: the hand-off joins the producer transaction - a QC-gate failure rolls the producer lot and stock back, and success commits all of it', async () => {
    const actor = { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId };
    const producerSeed = async (
      client: PoolClient,
      sku: string,
    ): Promise<{ lotId: string; lotNumber: string }> => {
      lotCounter += 1;
      const lotId = randomUUID();
      const lotNumber = `PRODUCER-${run}-${lotCounter}`;
      await client.query(`INSERT INTO lot_master (lot_id, lot_number, sku) VALUES ($1, $2, $3)`, [
        lotId,
        lotNumber,
        sku,
      ]);
      await client.query(
        `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', 25)`,
        [sku, binA1Id, lotNumber],
      );
      return { lotId, lotNumber };
    };

    // Failure path: no plan for the other item, so the producer's own writes must vanish.
    const failClient = await getPool().connect();
    let failedLot: { lotId: string; lotNumber: string } | null = null;
    try {
      await failClient.query('BEGIN');
      failedLot = await producerSeed(failClient, `FG-OTHER-8-1-${run}`);
      await assert.rejects(
        receiveQcCompletion(
          {
            source_completion_type: 'production_order',
            source_completion_id: randomUUID(),
            lot_id: failedLot.lotId,
            lot_number: failedLot.lotNumber,
            item_id: otherItemId,
            quantity: '25.000000',
            uom: 'EA',
            site_id: siteAId,
            bom_revision_id: otherRevisionId,
            completed_at: new Date().toISOString(),
            business_stream: 'production',
            actor,
          },
          failClient,
        ),
        (err: unknown) => (err as { errorCode?: string }).errorCode === 'INSPECTION_PLAN_NOT_FOUND',
      );
      await failClient.query('ROLLBACK');
    } finally {
      failClient.release();
    }
    assert.strictEqual(await countRows('lot_master', 'lot_id = $1', [failedLot!.lotId]), 0);
    assert.strictEqual(await countRows('stock_balance', 'lot_id = $1', [failedLot!.lotNumber]), 0);

    // Success path: lot, stock, task, event, audit and notification commit together.
    const okClient = await getPool().connect();
    let okLot: { lotId: string; lotNumber: string } | null = null;
    let taskId = '';
    try {
      await okClient.query('BEGIN');
      okLot = await producerSeed(okClient, fgSku);
      const result = await receiveQcCompletion(
        {
          source_completion_type: 'production_order',
          source_completion_id: randomUUID(),
          lot_id: okLot.lotId,
          lot_number: okLot.lotNumber,
          item_id: fgItemId,
          quantity: '25.000000',
          uom: 'EA',
          site_id: siteAId,
          bom_revision_id: fgRevisionId,
          completed_at: new Date().toISOString(),
          business_stream: 'production',
          actor,
        },
        okClient,
        {
          trace_id: `trace-${run}`,
          user_id: inspectorUserId,
          role: 'qc_inspector',
          location_id: siteAId,
          endpoint: '/synthetic-producer',
          method: 'POST',
          http_status: 201,
        },
      );
      taskId = result.task.task_id;
      assert.strictEqual(result.replayed, false);
      // Not visible outside the transaction yet.
      assert.strictEqual(await countRows('qc_inspection_task', 'task_id = $1', [taskId]), 0);
      await okClient.query('COMMIT');
    } finally {
      okClient.release();
    }
    assert.strictEqual(await countRows('qc_inspection_task', 'task_id = $1', [taskId]), 1);
    assert.strictEqual(await countRows('stock_balance', 'lot_id = $1', [okLot!.lotNumber]), 1);
    assert.strictEqual(
      await countRows('audit_log', `endpoint = '/synthetic-producer' AND trace_id = $1`, [
        `trace-${run}`,
      ]),
      1,
    );
  });

  it('AC3: concurrent delivery of the same completion has one effect; a wrong stream or declared derived field is rejected', async () => {
    const lot = await seedLotWithStock(fgSku, binA1Id, '100.000000');
    const body = completionBody(lot);
    const [a, b] = await Promise.all([submitCompletion(body), submitCompletion(body)]);
    assert.deepStrictEqual(
      [a.status, b.status].sort(),
      [201, 409],
      JSON.stringify([a.body, b.body]),
    );
    assert.strictEqual(await countRows('qc_inspection_task', 'lot_id = $1', [lot.lotId]), 1);

    const another = await seedLotWithStock(fgSku, binA1Id, '100.000000');
    const taskId = randomUUID();
    const envelope = {
      stream_type: 'qc',
      stream_id: taskId,
      event_type: 'qc.completion_received',
      payload: { ...completionBody(another), task_id: taskId },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    };
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      persistEvent({ ...envelope, stream_type: 'production' } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'INVALID_PAYLOAD',
    );
    await assert.rejects(
      persistEvent({
        ...envelope,
        payload: { ...envelope.payload, gate_status: 'conditionally_released' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'QC_DERIVATION_MISMATCH',
    );
    await assert.rejects(
      persistEvent({
        ...envelope,
        payload: { ...envelope.payload, business_stream: 'research' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'QC_DERIVATION_MISMATCH',
    );
    assert.strictEqual(await countRows('qc_inspection_task', 'lot_id = $1', [another.lotId]), 0);
  });

  it('AC3: the task is created even when no notification recipient exists at the site', async () => {
    const lot = await seedLotWithStock(fgSku, binB1Id, '10.000000');
    const res = await submitCompletion(
      completionBody(lot, { site_id: siteBId, quantity: '10.000000' }),
      qcHeadHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const taskId = (res.body['task'] as Record<string, unknown>)['task_id'] as string;
    assert.strictEqual(
      await countRows('user_role_assignments', `role = $1 AND location_id = $2`, [
        config.quality.inspectionTaskNotificationRole,
        siteBId,
      ]),
      0,
    );
    assert.strictEqual(await countRows('qc_inspection_task', 'task_id = $1', [taskId]), 1);
  });

  // -------------------------------------------------------------------------
  // AC3: no bypass across lot-use paths
  // -------------------------------------------------------------------------

  it('AC3: qc_hold blocks inventory allocation and issue, automatic lot selection, and lot-less drains', async () => {
    const held = await heldLot('100.000000');
    const allocate = await postEvent(
      inventoryEnvelope('stock.allocated', {
        sku: fgSku,
        target_location_id: binA1Id,
        quantity: 10,
        lot_id: held.lotNumber,
      }),
    );
    assert.strictEqual(allocate.status, 400, JSON.stringify(allocate.body));
    assert.strictEqual(allocate.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual(detailsOf(allocate.body)['reason'], 'qc_hold');

    const issue = await postEvent(
      inventoryEnvelope('stock.issued', {
        sku: fgSku,
        target_location_id: binA1Id,
        quantity: 10,
        lot_id: held.lotNumber,
      }),
    );
    assert.strictEqual(issue.status, 400, JSON.stringify(issue.body));
    assert.strictEqual(issue.body['error_code'], 'LOT_ON_HOLD');

    // Automatic selection never lands on the gated lot: the only stock at this bin is held.
    const ownBin = await seedLocation('bin', `BIN-FEFO-8-1-${run}`, siteAId, siteAId);
    const heldOnly = await heldLot('50.000000', ownBin);
    const fefo = await postEvent(
      inventoryEnvelope('stock.issued', {
        sku: fgSku,
        target_location_id: ownBin,
        quantity: 5,
        fefo_mode: 'fefo',
      }),
    );
    assert.ok([400, 409].includes(fefo.status), JSON.stringify(fefo.body));
    assert.ok(['NO_AVAILABLE_LOT', 'LOT_ON_HOLD'].includes(fefo.body['error_code'] as string));
    // A lot-less ledger drain (the replenishment and backflush shape - no lot is ever named) sees
    // no available stock at all: the drain-window predicate hides the gated lot.
    const lotless = await withTransaction(
      async (client): Promise<Record<string, unknown> | null> => {
        try {
          await applyStockIssue({ sku: fgSku, location_id: ownBin, quantity: '5' }, client);
          return null;
        } catch (err) {
          const e = err as { errorCode?: string; details?: Record<string, unknown> };
          return { error_code: e.errorCode, ...e.details };
        }
      },
    );
    assert.strictEqual(lotless?.['error_code'], 'INSUFFICIENT_STOCK');
    assert.strictEqual(lotless?.['available_quantity'], 0);
    // A lot-less HTTP issue on the lot-controlled item is already refused upstream (LOT_REQUIRED).
    const lotlessHttp = await postEvent(
      inventoryEnvelope('stock.issued', { sku: fgSku, target_location_id: ownBin, quantity: 5 }),
    );
    assert.strictEqual(lotlessHttp.status, 400, JSON.stringify(lotlessHttp.body));
    const balance = await getAdminPool().query(
      `SELECT on_hand::text AS on_hand, allocated::text AS allocated FROM stock_balance WHERE lot_id = $1`,
      [heldOnly.lotNumber],
    );
    assert.strictEqual(balance.rows[0]!['on_hand'], '50.000000');
    assert.strictEqual(balance.rows[0]!['allocated'], '0.000000');
  });

  it('AC3: qc_hold blocks a transfer request, cross-dock, picking, dispatch documents and final dispatch', async () => {
    const held = await heldLot();
    const transfer = await postEvent(
      inventoryEnvelope('transfer_request.created', {
        transfer_request_id: randomUUID(),
        sku_id: fgSku,
        quantity: 10,
        from_location_id: binA1Id,
        to_location_id: binA2Id,
        lot_id: held.lotId,
      }),
    );
    assert.strictEqual(transfer.status, 400, JSON.stringify(transfer.body));
    assert.strictEqual(transfer.body['error_code'], 'LOT_ON_HOLD');

    const businessDate = '2026-07-20';
    for (const operation of [
      'pick',
      'cross_dock',
      'maintenance_issue',
      'replenishment',
      'production_issue',
      'transfer',
      'dispatch_document',
      'dispatch',
    ] as QcGateOperation[]) {
      const rejection = await gateRejection({
        lot_id: held.lotId,
        operation,
        scope_ref: binA2Id,
        business_date: businessDate,
      });
      assert.strictEqual(rejection?.['error_code'], 'LOT_ON_HOLD', operation);
      assert.strictEqual(rejection?.['reason'], 'qc_hold', operation);
    }
    // Lot-number addressing resolves to the same gate.
    const byNumber = await gateRejection({
      lot_number: held.lotNumber,
      sku: fgSku,
      operation: 'issue',
      business_date: businessDate,
    });
    assert.strictEqual(byNumber?.['error_code'], 'LOT_ON_HOLD');

    // Shipping-document generation and final dispatch through the real appliers.
    const dispatchOrderId = randomUUID();
    await getPool().query(
      `INSERT INTO dispatch_order_status (dispatch_order_id, picked_by, packed_at) VALUES ($1, $2, now())`,
      [dispatchOrderId, engineerUserId],
    );
    await getPool().query(
      `INSERT INTO packing_record (packing_record_id, dispatch_order_id, sku, packed_qty, lot_id, carton_count, packed_by)
       VALUES ($1, $2, $3, 100, $4, 1, $5)`,
      [randomUUID(), dispatchOrderId, fgSku, held.lotId, engineerUserId],
    );
    const dispatchEnvelope = (
      eventType: string,
      payload: Record<string, unknown>,
    ): Record<string, unknown> => ({
      stream_type: 'warehouse',
      stream_id: dispatchOrderId,
      event_type: eventType,
      payload: { dispatch_order_id: dispatchOrderId, ...payload },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: engineerUserId, role: 'warehouse_manager', location_id: binA1Id },
        occurred_at: new Date().toISOString(),
      },
    });
    const documentsEnvelope = dispatchEnvelope('dispatch.shipping_documents_generated', {
      document_types: ['bol'],
    });
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      persistEvent(documentsEnvelope as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'LOT_ON_HOLD' &&
        (err as { details?: Record<string, unknown> }).details?.['reason'] === 'qc_gate',
    );
    await getPool()
      .query(
        `INSERT INTO dispatch_document (document_id, dispatch_order_id, document_type, document_number, content, generated_by)
       VALUES ($1, $2, 'bol', $3, '{}', $4)`,
        [randomUUID(), dispatchOrderId, `BOL-${run}`, engineerUserId],
      )
      .catch(() => undefined);
    await assert.rejects(
      persistEvent(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dispatchEnvelope('dispatch.dispatched', { dispatched_at: new Date().toISOString() }) as any,
      ),
      (err: unknown) => {
        const code = (err as { errorCode?: string }).errorCode;
        return code === 'LOT_ON_HOLD' || code === 'DISPATCH_DOCUMENTS_NOT_GENERATED';
      },
    );
    assert.strictEqual((await taskRow(held.taskId))!['gate_status'], 'qc_hold');
  });

  it('AC3: edge devices cannot submit any Story 8.1 command (CENTRAL_ONLY_OPERATION) while qc.result_recorded stays allowed', async () => {
    const eventId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: eventId,
        stream_type: 'qc',
        stream_id: standardPlanId,
        event_type: 'qc.inspection_plan_approved',
        event_version: 1,
        payload: {
          plan_id: standardPlanId,
          plan_version_id: standardV1Id,
          approved_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
          device_id: DEVICE_ID,
          capture_method: 'MANUAL',
          occurred_at: new Date().toISOString(),
        },
        schema_version: 1,
        idempotency_key: `edge-8-1-${eventId}`,
      },
      inspectorHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
  });

  // -------------------------------------------------------------------------
  // AC4 / AC5: DOA-gated conditional release
  // -------------------------------------------------------------------------

  it('AC5: an unauthorized conditional release is APPROVAL_REQUIRED, audited, and persists nothing', async () => {
    await clearDoa('qc.conditional_release');
    const held = await heldLot();
    const unresolved = await conditionalRelease(held.taskId, qcHeadHeaders);
    assert.strictEqual(unresolved.status, 404, JSON.stringify(unresolved.body));
    assert.strictEqual(unresolved.body['error_code'], 'APPROVAL_UNRESOLVED');

    await seedDoa('qc.conditional_release', 'qc_head');
    const eventsBefore = await countRows('domain_events', `stream_id = $1`, [held.taskId]);
    const notificationsBefore = await countRows(
      'domain_events',
      `event_type = 'notification.created'`,
      [],
    );
    const res = await conditionalRelease(held.taskId, inspectorHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(res.body)['resolved_approver_user_id'], qcHeadUserId);

    const audit = await getAdminPool().query(
      `SELECT trace_id, user_id, endpoint, error_code, details FROM audit_log
        WHERE error_code = 'APPROVAL_REQUIRED' AND user_id = $1 AND endpoint LIKE '%/conditional-release'`,
      [inspectorUserId],
    );
    assert.strictEqual(audit.rows.length, 1);
    const row = audit.rows[0]!;
    assert.ok((row['trace_id'] as string).length > 0);
    assert.strictEqual((row['details'] as Record<string, unknown>)['lot_id'], held.lotId);
    assert.strictEqual((row['details'] as Record<string, unknown>)['task_id'], held.taskId);

    assert.strictEqual(await countRows('qc_deviation', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 0);
    assert.strictEqual(
      await countRows('domain_events', `stream_id = $1`, [held.taskId]),
      eventsBefore,
    );
    assert.strictEqual(
      await countRows('domain_events', `event_type = 'notification.created'`, []),
      notificationsBefore,
    );
    assert.strictEqual((await taskRow(held.taskId))!['gate_status'], 'qc_hold');

    // The same forgery through the seam is blocked as well.
    await assert.rejects(
      persistEvent({
        stream_type: 'qc',
        stream_id: held.taskId,
        event_type: 'qc.conditional_release_recorded',
        payload: {
          task_id: held.taskId,
          lot_id: held.lotId,
          deviation_id: randomUUID(),
          disposition_id: randomUUID(),
          ...releaseBody(),
          decided_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'APPROVAL_REQUIRED',
    );
  });

  it('AC4: the resolved approver records one immutable deviation and one disposition, and the lot moves to conditionally_released', async () => {
    const held = await heldLot();
    const key = randomUUID();
    const res = await conditionalRelease(held.taskId, qcHeadHeaders, { idempotency_key: key });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const task = res.body['task'] as Record<string, unknown>;
    const deviation = res.body['deviation'] as Record<string, unknown>;
    const disposition = res.body['disposition'] as Record<string, unknown>;
    assert.strictEqual(task['gate_status'], 'conditionally_released');
    assert.strictEqual(deviation['scope_kind'], 'internal_movement');
    assert.strictEqual(deviation['scope_ref'], binA2Id);
    assert.strictEqual(deviation['expires_on'], isoDaysFromNow(7));
    assert.strictEqual(deviation['approved_by'], qcHeadUserId);
    assert.strictEqual(deviation['requested_by'], qcHeadUserId);
    assert.ok(deviation['doa_entry_id']);
    assert.strictEqual(disposition['disposition'], 'conditional_release');
    assert.strictEqual(disposition['deviation_id'], deviation['deviation_id']);
    assert.strictEqual(disposition['plan_version_id'], task['plan_version_id']);
    assert.strictEqual(disposition['inspector_user_id'], null);

    const ev = await getAdminPool().query(`SELECT payload FROM domain_events WHERE event_id = $1`, [
      res.body['event_id'],
    ]);
    const payload = ev.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['approved_by'], qcHeadUserId);
    assert.strictEqual(payload['previous_gate_status'], 'qc_hold');
    assert.ok(payload['decided_on']);
    assert.strictEqual(
      await notificationCountFor(held.taskId, config.quality.inspectionTaskNotificationRole),
      2,
    );

    // Immutable: no UPDATE / DELETE for app_user on the evidence tables.
    await assert.rejects(
      getPool().query(`UPDATE qc_deviation SET expires_on = '2099-01-01' WHERE deviation_id = $1`, [
        deviation['deviation_id'],
      ]),
      (err: unknown) => (err as { code?: string }).code === '42501',
    );

    // Replay returns the original disposition; a second distinct disposition is DISPOSITION_EXISTS.
    const replay = await conditionalRelease(held.taskId, qcHeadHeaders, { idempotency_key: key });
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], res.body['event_id']);
    assert.strictEqual(await countRows('qc_deviation', 'lot_id = $1', [held.lotId]), 1);
    const second = await conditionalRelease(held.taskId, qcHeadHeaders);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DISPOSITION_EXISTS');
    assert.strictEqual(
      detailsOf(second.body)['existing_disposition_id'],
      disposition['disposition_id'],
    );
    assert.strictEqual(
      await notificationCountFor(held.taskId, config.quality.inspectionTaskNotificationRole),
      2,
    );
  });

  it('AC4: concurrent conditional releases resolve to one disposition', async () => {
    const held = await heldLot();
    const [a, b] = await Promise.all([
      conditionalRelease(held.taskId, qcHeadHeaders),
      conditionalRelease(held.taskId, qcHeadHeaders),
    ]);
    assert.deepStrictEqual(
      [a.status, b.status].sort(),
      [201, 409],
      JSON.stringify([a.body, b.body]),
    );
    const rejected = a.status === 409 ? a : b;
    assert.strictEqual(rejected.body['error_code'], 'DISPOSITION_EXISTS');
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 1);
    assert.strictEqual(await countRows('qc_deviation', 'lot_id = $1', [held.lotId]), 1);
  });

  it('AC4: an invalid or past expiry, a blank justification and a forged approver are rejected', async () => {
    const held = await heldLot();
    const past = await conditionalRelease(held.taskId, qcHeadHeaders, {
      expires_on: isoDaysFromNow(-1),
    });
    assert.strictEqual(past.status, 400, JSON.stringify(past.body));
    const today = await conditionalRelease(held.taskId, qcHeadHeaders, {
      expires_on: isoDaysFromNow(0),
    });
    assert.strictEqual(today.status, 400, JSON.stringify(today.body));
    const impossible = await conditionalRelease(held.taskId, qcHeadHeaders, {
      expires_on: '2027-02-30',
    });
    assert.strictEqual(impossible.status, 400);
    const blank = await conditionalRelease(held.taskId, qcHeadHeaders, { justification: '   ' });
    assert.strictEqual(blank.status, 400);
    await assert.rejects(
      persistEvent({
        stream_type: 'qc',
        stream_id: held.taskId,
        event_type: 'qc.conditional_release_recorded',
        payload: {
          task_id: held.taskId,
          lot_id: held.lotId,
          deviation_id: randomUUID(),
          disposition_id: randomUUID(),
          ...releaseBody(),
          decided_at: new Date().toISOString(),
          approved_by: qcHeadUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: qcHeadUserId, role: 'qc_head', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'QC_DERIVATION_MISMATCH',
    );
    assert.strictEqual((await taskRow(held.taskId))!['gate_status'], 'qc_hold');
  });

  it('AC4: segregation of duties - a known result recorder cannot approve the same lot, and a known recorder is attributed as inspector', async () => {
    const held = await heldLot();
    // The synthetic Story 1.7 result event names the lot by number; the approver recorded it.
    await getAdminPool().query(
      `INSERT INTO domain_events (event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version)
       VALUES ($1, 'qc', $2, 'qc.result_recorded', 1, $3::jsonb, $4::jsonb, 1)`,
      [
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          instrument_id: `INS-${run}`,
          lot_id: held.lotNumber,
          parameter: 'weight',
          value: 1,
        }),
        JSON.stringify({
          correlation_id: randomUUID(),
          actor: { user_id: qcHeadUserId, role: 'qc_head', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        }),
      ],
    );
    const sod = await conditionalRelease(held.taskId, qcHeadHeaders);
    assert.strictEqual(sod.status, 409, JSON.stringify(sod.body));
    assert.strictEqual(sod.body['error_code'], 'SOD_VIOLATION');
    assert.strictEqual(await countRows('qc_lot_disposition', 'lot_id = $1', [held.lotId]), 0);

    const other = await heldLot();
    await getAdminPool().query(
      `INSERT INTO domain_events (event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version)
       VALUES ($1, 'qc', $2, 'qc.result_recorded', 1, $3::jsonb, $4::jsonb, 1)`,
      [
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          instrument_id: `INS-${run}`,
          lot_id: other.lotId,
          parameter: 'weight',
          value: 1,
        }),
        JSON.stringify({
          correlation_id: randomUUID(),
          actor: { user_id: inspectorUserId, role: 'qc_inspector', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        }),
      ],
    );
    const ok = await conditionalRelease(other.taskId, qcHeadHeaders);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(
      (ok.body['disposition'] as Record<string, unknown>)['inspector_user_id'],
      inspectorUserId,
    );
  });

  // -------------------------------------------------------------------------
  // AC3/AC4: conditionally released scope, expiry, and the independent manual hold
  // -------------------------------------------------------------------------

  it('AC4: a conditional release alone permits only the in-scope internal movement and never sales allocation, picking, documents or dispatch', async () => {
    const held = await heldLot();
    const release = await conditionalRelease(held.taskId, qcHeadHeaders);
    assert.strictEqual(release.status, 201, JSON.stringify(release.body));
    const businessDate = isoDaysFromNow(1);
    // Transfer requests address ledger rows by the lot NUMBER (stock_balance grain); seed additional stock at the source bin.
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', 5)
       ON CONFLICT (sku, location_id, lot_id, stock_class) DO UPDATE SET on_hand = stock_balance.on_hand + 5`,
      [fgSku, binA1Id, held.lotNumber],
    );

    for (const operation of [
      'allocation',
      'issue',
      'pick',
      'cross_dock',
      'maintenance_issue',
      'replenishment',
      'dispatch_document',
      'dispatch',
    ] as QcGateOperation[]) {
      const rejection = await gateRejection({
        lot_id: held.lotId,
        operation,
        scope_ref: binA2Id,
        business_date: businessDate,
      });
      assert.strictEqual(rejection?.['error_code'], 'LOT_ON_HOLD', operation);
      assert.strictEqual(rejection?.['reason'], 'conditional_release_scope', operation);
    }
    const inScope = await gateRejection({
      lot_id: held.lotId,
      operation: 'transfer',
      scope_ref: binA2Id,
      business_date: businessDate,
    });
    assert.strictEqual(inScope, null, 'the in-scope internal movement is permitted');
    const outOfScope = await gateRejection({
      lot_id: held.lotId,
      operation: 'transfer',
      scope_ref: binB1Id,
      business_date: businessDate,
    });
    assert.strictEqual(outOfScope?.['reason'], 'deviation_scope_mismatch');
    const expired = await gateRejection({
      lot_id: held.lotId,
      operation: 'transfer',
      scope_ref: binA2Id,
      business_date: isoDaysFromNow(7),
    });
    assert.strictEqual(expired?.['reason'], 'deviation_expired');

    // Through the real paths: the sales allocation is blocked, the scoped transfer succeeds.
    const allocate = await postEvent(
      inventoryEnvelope('stock.allocated', {
        sku: fgSku,
        target_location_id: binA1Id,
        quantity: 5,
        lot_id: held.lotNumber,
      }),
    );
    assert.strictEqual(allocate.status, 400, JSON.stringify(allocate.body));
    assert.strictEqual(detailsOf(allocate.body)['reason'], 'conditional_release_scope');
    const wrongDestination = await postEvent(
      inventoryEnvelope('transfer_request.created', {
        transfer_request_id: randomUUID(),
        sku_id: fgSku,
        quantity: 5,
        from_location_id: binA1Id,
        to_location_id: binB1Id,
        lot_id: held.lotId,
      }),
    );
    assert.strictEqual(wrongDestination.status, 400, JSON.stringify(wrongDestination.body));
    assert.strictEqual(detailsOf(wrongDestination.body)['reason'], 'deviation_scope_mismatch');
    const scoped = await postEvent(
      inventoryEnvelope('transfer_request.created', {
        transfer_request_id: randomUUID(),
        sku_id: fgSku,
        quantity: 5,
        from_location_id: binA1Id,
        to_location_id: binA2Id,
        lot_id: held.lotId,
      }),
    );
    assert.strictEqual(scoped.status, 201, JSON.stringify(scoped.body));
    const balance = await getAdminPool().query(
      `SELECT allocated::text AS allocated FROM stock_balance WHERE lot_id = $1`,
      [held.lotNumber],
    );
    assert.strictEqual(balance.rows[0]!['allocated'], '5.000000');

    // An order_allocation / dispatch scope is stored but not operationally usable before Story 8.4.
    const dispatchScoped = await heldLot();
    const stored = await conditionalRelease(dispatchScoped.taskId, qcHeadHeaders, {
      scope_kind: 'dispatch',
      scope_ref: `SO-${run}`,
    });
    assert.strictEqual(stored.status, 201, JSON.stringify(stored.body));
    const notActivated = await gateRejection({
      lot_id: dispatchScoped.lotId,
      operation: 'transfer',
      scope_ref: binA2Id,
      business_date: businessDate,
    });
    assert.strictEqual(notActivated?.['reason'], 'deviation_scope_not_activated');
    const dispatchBlocked = await gateRejection({
      lot_id: dispatchScoped.lotId,
      operation: 'dispatch',
      scope_ref: `SO-${run}`,
      business_date: businessDate,
    });
    assert.strictEqual(dispatchBlocked?.['reason'], 'conditional_release_scope');
  });

  it('AC4: the manual hold axis and the QC gate are independent, and a manually held conditionally released lot stays blocked everywhere', async () => {
    const held = await heldLot();
    const hold = await makeRequest(
      port,
      'PUT',
      `/api/v1/lots/${held.lotNumber}/quality-hold`,
      { hold_reason: 'Story 8.1 manual hold' },
      inspectorHeaders,
    );
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));
    // Conditional release does not clear the manual hold...
    const release = await conditionalRelease(held.taskId, qcHeadHeaders);
    assert.strictEqual(release.status, 201, JSON.stringify(release.body));
    const lot = await getAdminPool().query(
      `SELECT quality_hold_status FROM lot_master WHERE lot_id = $1`,
      [held.lotId],
    );
    assert.strictEqual(lot.rows[0]!['quality_hold_status'], 'held');
    // ...and the manual hold keeps the in-scope movement blocked.
    const blocked = await gateRejection({
      lot_id: held.lotId,
      operation: 'transfer',
      scope_ref: binA2Id,
      business_date: isoDaysFromNow(1),
    });
    assert.strictEqual(blocked?.['reason'], 'manual_hold');
    const transfer = await postEvent(
      inventoryEnvelope('transfer_request.created', {
        transfer_request_id: randomUUID(),
        sku_id: fgSku,
        quantity: 5,
        from_location_id: binA1Id,
        to_location_id: binA2Id,
        lot_id: held.lotId,
      }),
    );
    assert.strictEqual(transfer.status, 400, JSON.stringify(transfer.body));
    assert.strictEqual(transfer.body['error_code'], 'LOT_ON_HOLD');
    // Clearing the manual hold does not clear or alter the QC gate.
    const clear = await makeRequest(
      port,
      'DELETE',
      `/api/v1/lots/${held.lotNumber}/quality-hold`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(clear.status, 200, JSON.stringify(clear.body));
    assert.strictEqual((await taskRow(held.taskId))!['gate_status'], 'conditionally_released');
    const other = await heldLot();
    const holdOther = await makeRequest(
      port,
      'PUT',
      `/api/v1/lots/${other.lotNumber}/quality-hold`,
      { hold_reason: 'x' },
      inspectorHeaders,
    );
    assert.strictEqual(holdOther.status, 200);
    const clearOther = await makeRequest(
      port,
      'DELETE',
      `/api/v1/lots/${other.lotNumber}/quality-hold`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(clearOther.status, 200);
    assert.strictEqual((await taskRow(other.taskId))!['gate_status'], 'qc_hold');
  });

  it('AC4: racing a manual hold, a conditional release and a transfer on one lot never deadlocks and never bypasses', async () => {
    const held = await heldLot();
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', 5)`,
      [fgSku, binA1Id, held.lotId],
    );
    const [hold, release, transfer] = await Promise.all([
      makeRequest(
        port,
        'PUT',
        `/api/v1/lots/${held.lotNumber}/quality-hold`,
        { hold_reason: 'race' },
        inspectorHeaders,
      ),
      conditionalRelease(held.taskId, qcHeadHeaders),
      postEvent(
        inventoryEnvelope('transfer_request.created', {
          transfer_request_id: randomUUID(),
          sku_id: fgSku,
          quantity: 5,
          from_location_id: binA1Id,
          to_location_id: binA2Id,
          lot_id: held.lotId,
        }),
      ),
    ]);
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));
    assert.strictEqual(release.status, 201, JSON.stringify(release.body));
    assert.strictEqual(transfer.status, 400, JSON.stringify(transfer.body));
    assert.strictEqual(transfer.body['error_code'], 'LOT_ON_HOLD');
    const lot = await getAdminPool().query(
      `SELECT quality_hold_status FROM lot_master WHERE lot_id = $1`,
      [held.lotId],
    );
    assert.strictEqual(lot.rows[0]!['quality_hold_status'], 'held');
    assert.strictEqual((await taskRow(held.taskId))!['gate_status'], 'conditionally_released');
    const balance = await getAdminPool().query(
      `SELECT allocated::text AS allocated FROM stock_balance WHERE lot_id = $1`,
      [held.lotId],
    );
    assert.strictEqual(balance.rows[0]!['allocated'], '0.000000');
  });

  // -------------------------------------------------------------------------
  // Reads and RBAC
  // -------------------------------------------------------------------------

  it('reads: plan, version and task detail routes expose the frozen state', async () => {
    const held = await heldLot();
    const task = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks/${held.taskId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(task.status, 200, JSON.stringify(task.body));
    assert.strictEqual((task.body['task'] as Record<string, unknown>)['lot_id'], held.lotId);
    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/tasks?gate_status=qc_hold&site_id=${siteAId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(list.status, 200);
    assert.ok((list.body['tasks'] as unknown[]).length >= 1);
    const plan = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/inspection-plans/${standardPlanId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(plan.status, 200);
    assert.ok((plan.body['versions'] as unknown[]).length >= 5);
    const version = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/inspection-plans/${standardPlanId}/versions/${standardV1Id}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(version.status, 200);
    assert.strictEqual(
      (version.body['approval'] as Record<string, unknown>)['governing_role'],
      'qc_head',
    );
    const plans = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/inspection-plans?item_id=${fgItemId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(plans.status, 200);
    assert.strictEqual((plans.body['plans'] as unknown[]).length, 2);
  });

  it('RBAC: 401/403 sweep on every new route, and the synthetic completion is location-scoped', async () => {
    const id = randomUUID();
    const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['POST', '/api/v1/qc/inspection-plans', { item_id: id }],
      ['GET', '/api/v1/qc/inspection-plans', undefined],
      [
        'GET',
        `/api/v1/qc/inspection-plans/resolve?item_id=${id}&bom_revision_id=${id}&business_date=2026-01-01`,
        undefined,
      ],
      ['GET', `/api/v1/qc/inspection-plans/${id}`, undefined],
      ['GET', `/api/v1/qc/inspection-plans/${id}/versions/${id}`, undefined],
      ['POST', `/api/v1/qc/inspection-plans/${id}/versions/${id}/approve`, {}],
      ['POST', '/api/v1/qc/completions', { source_completion_type: 'synthetic_completion' }],
      ['GET', '/api/v1/qc/tasks', undefined],
      ['GET', `/api/v1/qc/tasks/${id}`, undefined],
      ['POST', `/api/v1/qc/tasks/${id}/conditional-release`, releaseBody()],
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
    // The inspector's write scope is site A only.
    const lot = await seedLotWithStock(fgSku, binB1Id, '3.000000');
    const otherSite = await submitCompletion(
      completionBody(lot, { site_id: siteBId, quantity: '3.000000' }),
    );
    assert.strictEqual(otherSite.status, 403, JSON.stringify(otherSite.body));
    assert.strictEqual(otherSite.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const heldB = await submitCompletion(
      completionBody(lot, { site_id: siteBId, quantity: '3.000000' }),
      qcHeadHeaders,
    );
    assert.strictEqual(heldB.status, 201, JSON.stringify(heldB.body));
    const releaseB = await conditionalRelease(
      (heldB.body['task'] as Record<string, unknown>)['task_id'] as string,
      inspectorHeaders,
    );
    assert.strictEqual(releaseB.status, 403);
    assert.strictEqual(releaseB.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });
});

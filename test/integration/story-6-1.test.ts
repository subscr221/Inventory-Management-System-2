import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = randomUUID().slice(0, 8);
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
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

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/**
 * Exact decimal comparison through PostgreSQL NUMERIC - the codebase's own numericEqual idiom.
 * Never parseFloat: an IEEE 754 round trip is exactly the defect this assertion exists to catch.
 * The typeof guard proves the value left the DB as a string.
 */
async function assertNumericEqual(
  actual: unknown,
  expected: string,
  message: string,
): Promise<void> {
  assert.strictEqual(typeof actual, 'string', `${message}: quantity must travel as a string`);
  const result = await getPool().query('SELECT $1::numeric = $2::numeric AS eq', [
    actual as string,
    expected,
  ]);
  assert.strictEqual(
    result.rows[0]!.eq,
    true,
    `${message}: got ${String(actual)}, expected ${expected}`,
  );
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
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

describe('Story 6.1 Production Order Creation and Release Gate', () => {
  let server: Server;
  let port: number;

  let plannerUserId: string;
  let plannerHeaders: Record<string, string>;
  let approverUserId: string;
  let approverHeaders: Record<string, string>;
  let nonApproverHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;

  let siteLocId: string;
  let zoneLocId: string;
  let binLocId: string;

  async function createItem(sku: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku,
        description: `Test item ${sku}`,
        valuation_method: 'fifo',
        uom: 'EA',
        business_stream: 'production',
        category: 'raw_materials',
        standard_cost_designation: 'ind_as_2_para_21_measurement_technique',
        standard_cost_amount: 10,
        ...overrides,
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, `item ${sku} failed: ${JSON.stringify(res.body)}`);
    return (res.body as Record<string, string>)['item_id']!;
  }

  function componentLine(
    lineNo: number,
    componentItemId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      line_no: lineNo,
      component_item_id: componentItemId,
      output_class: 'component',
      quantity_per: '2.0',
      line_uom: 'EA',
      uom_conversion_factor: '1.0',
      scrap_percent: '0.0',
      is_phantom: false,
      effective_from: '2020-01-01',
      ...overrides,
    };
  }

  async function draftBom(
    parentItemId: string,
    lines: Record<string, unknown>[],
    bomType: 'production' | 'rnd' = 'production',
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'A',
        bom_type: bomType,
        lines,
        idempotency_key: randomUUID(),
      },
      engineerHeaders,
    );
  }

  async function runRollup(bomId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/cost-rollups`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
  }

  async function releaseBom(bomId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/boms/${bomId}/release`,
      { idempotency_key: randomUUID() },
      engineerHeaders,
    );
  }

  async function draftAndRelease(
    parentItemId: string,
    lines: Record<string, unknown>[],
  ): Promise<{ bomId: string; revisionId: string }> {
    const draft = await draftBom(parentItemId, lines);
    assert.strictEqual(draft.status, 201, `draft failed: ${JSON.stringify(draft.body)}`);
    const bomId = draft.body['bom_id'] as string;
    const rollup = await runRollup(bomId);
    assert.strictEqual(rollup.status, 201, `rollup failed: ${JSON.stringify(rollup.body)}`);
    const release = await releaseBom(bomId);
    assert.strictEqual(release.status, 200, `release failed: ${JSON.stringify(release.body)}`);
    return { bomId, revisionId: draft.body['current_revision_id'] as string };
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

  /** Receives owned stock through the Epic 2 ledger - the only way stock enters this suite. The
   *  ledger is inventory-module, so the engineer (who also holds inventory_controller write) is the
   *  posting actor; the production planner has no inventory assignment. */
  async function receiveStock(sku: string, locationId: string, quantity: number): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.received',
        payload: {
          business_stream: 'production',
          sku,
          target_location_id: locationId,
          quantity,
          unit_cost: 5,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_controller', location_id: locationId },
          occurred_at: new Date().toISOString(),
        },
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, `stock receipt failed: ${JSON.stringify(res.body)}`);
  }

  async function createOrder(
    overrides: Partial<Record<string, unknown>> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      {
        output_item_id: overrides.output_item_id,
        order_quantity: overrides.order_quantity ?? '10',
        plant_location_id: overrides.plant_location_id ?? siteLocId,
        bom_id: overrides.bom_id,
        business_stream: overrides.business_stream ?? 'production',
        source_reference_type: overrides.source_reference_type ?? 'manual',
        source_reference_id: overrides.source_reference_id ?? `REF-${randomUUID().slice(0, 8)}`,
        idempotency_key: overrides.idempotency_key ?? randomUUID(),
        ...(overrides.order_number_ext !== undefined
          ? { order_number_ext: overrides.order_number_ext }
          : {}),
      },
      plannerHeaders,
    );
  }

  function releaseOrder(orderId: string, body: Record<string, unknown> = {}): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), ...body },
      plannerHeaders,
    );
  }

  /** Asserts a state-machine rejection: HTTP 400 with the stable INVALID_STATE_TRANSITION code. */
  function assertInvalidTransition(res: HttpResult): void {
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(
      res.body['error_code'],
      'INVALID_STATE_TRANSITION',
      JSON.stringify(res.body),
    );
  }

  function transitionOrder(orderId: string, newStatus: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/transition`,
      { new_status: newStatus, idempotency_key: randomUUID() },
      plannerHeaders,
    );
  }

  function cancelOrder(orderId: string, body: Record<string, unknown> = {}): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/cancel`,
      { idempotency_key: randomUUID(), ...body },
      plannerHeaders,
    );
  }

  async function getOrder(orderId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}`,
      undefined,
      plannerHeaders,
    );
  }

  async function domainEventCount(orderId: string, eventType: string): Promise<number> {
    const result = await getPool().query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE stream_id = $1 AND event_type = $2`,
      [orderId, eventType],
    );
    return Number(result.rows[0]!.n);
  }

  async function auditRowCountForOrder(orderId: string): Promise<number> {
    const result = await getPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE event_id IN (
          SELECT event_id FROM domain_events
          WHERE stream_id = $1
            AND event_type IN ('production_order.created','production_order.released','production_order.state_changed','production_order.cancelled')
        )`,
      [orderId],
    );
    return Number(result.rows[0]!.n);
  }

  async function currentRevisionOf(bomId: string): Promise<string | null> {
    const result = await getPool().query('SELECT current_revision_id FROM bom WHERE bom_id = $1', [
      bomId,
    ]);
    return (result.rows[0]?.['current_revision_id'] as string | null) ?? null;
  }

  async function assertOrderStatus(orderId: string, status: string): Promise<void> {
    const res = await getOrder(orderId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], status);
  }

  async function seedDoaReleaseOverride(): Promise<void> {
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'production_manager',
        transaction_type: 'production_order.release_override',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));
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
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/integration_exception.sql',
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
      '../../read/projections/production_order.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE production_order, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, integration_exception, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    // The plant site with a zone and a bin two levels below it. The bin is where component stock
    // lands, so every release gate test exercises the descendant availability walk.
    siteLocId = await seedLocation('site', `PLANT-${run}`, null, null);
    zoneLocId = await seedLocation('zone', `ZONE-${run}`, siteLocId, siteLocId);
    binLocId = await seedLocation('bin', `BIN-${run}`, zoneLocId, siteLocId);
    void zoneLocId;

    // Task 7.1: the production_planner role assignment for module production with write scope
    // (the exact role string Story 7.6 already uses as a notification target).
    plannerUserId = await provisionUser(port, `planner-6-1-${run}@example.com`, [
      { role: 'production_planner', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_planner', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, `planner-6-1-${run}@example.com`);

    // The DOA registry names production_manager for production_order.release_override; this user
    // holds that literal role.
    approverUserId = await provisionUser(port, `approver-6-1-${run}@example.com`, [
      { role: 'production_manager', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_manager', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `approver-6-1-${run}@example.com`);

    // A second production user who is NOT the DOA approver (AC7 path).
    await provisionUser(port, `technician-6-1-${run}@example.com`, [
      { role: 'production_planner', module: 'production', functionScope: 'write', locationId: '*' },
    ]);
    nonApproverHeaders = await authFor(port, `technician-6-1-${run}@example.com`);

    await provisionUser(port, `reader-6-1-${run}@example.com`, [
      { role: 'production_viewer', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `reader-6-1-${run}@example.com`);

    await provisionUser(port, `engineer-6-1-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-6-1-${run}@example.com`);

    await provisionUser(port, `compliance-6-1-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-6-1-${run}@example.com`);
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC6 / AC7: the DOA-resolved override
  // -------------------------------------------------------------------------

  it('AC6/AC7: an override without a DOA entry is rejected 404 APPROVAL_UNRESOLVED, and this test seeds the entry for the suite', async () => {
    // ORDER-COUPLED precondition: this test MUST run first (it is declared first). No release
    // override entry may exist yet; the assert keeps a future reorder from turning a real 404 into
    // a 403 that reads as a puzzle.
    const doaRows = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM doa_registry_entries
        WHERE transaction_type = 'production_order.release_override' AND active = true`,
    );
    assert.strictEqual(
      doaRows.rows[0]!['n'],
      0,
      'this test must run BEFORE the release_override DOA entry is seeded',
    );

    const fx = await releasedTwoLineBom('404');
    const itemOut = fx.itemOut;
    const bom = fx.bom;
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;
    const res = await releaseOrder(orderId, { override: { reason: 'Expedite' } });
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
    await assertOrderStatus(orderId, 'planned');

    // Seed the entry the rest of the suite relies on (Task 7.2: through the DOA route, never by
    // direct SQL insert, so the seeding path is the one production uses).
    await seedDoaReleaseOverride();
  });

  // -------------------------------------------------------------------------
  // AC1: creation, immutable MO-YYYY-NNNN number, planned state, tagging
  // -------------------------------------------------------------------------

  it('AC1: creation assigns an MO-YYYY-NNNN number and lands in planned; the next creation gets the next number', async () => {
    const item = await createItem(`FG-${run}-ac1a`);
    const first = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstNumber = first.body['order_number_ext'] as string;
    assert.match(firstNumber, /^MO-\d{4}-\d{4,}$/, `number format: ${firstNumber}`);
    assert.strictEqual(first.body['status'], 'planned');

    const second = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const secondNumber = second.body['order_number_ext'] as string;
    assert.match(secondNumber, /^MO-\d{4}-\d{4,}$/);
    assert.notStrictEqual(secondNumber, firstNumber, 'two creations must not share a number');
    const firstSeq = Number(firstNumber.split('-')[2]);
    const secondSeq = Number(secondNumber.split('-')[2]);
    assert.ok(secondSeq > firstSeq, `second number ${secondNumber} must follow ${firstNumber}`);
  });

  it('AC1: a client-supplied order_number_ext is ignored on the handler path', async () => {
    const item = await createItem(`FG-${run}-ac1b`);
    const res = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      order_number_ext: 'MO-9999-9999',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const number = res.body['order_number_ext'] as string;
    assert.match(number, /^MO-\d{4}-\d{4,}$/);
    assert.notStrictEqual(number, 'MO-9999-9999');
  });

  it('AC1: an untagged create is rejected UNTAGGED_TRANSACTION on BOTH the handler and the direct-event path', async () => {
    const item = await createItem(`FG-${run}-ac1c`);
    const res = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      business_stream: '',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UNTAGGED_TRANSACTION');

    const directOrderId = randomUUID();
    const direct = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: directOrderId,
        event_type: 'production_order.created',
        payload: {
          production_order_id: directOrderId,
          order_number_ext: '',
          output_item_id: item,
          output_sku: 'X',
          order_quantity: '1',
          order_uom: 'EA',
          plant_location_id: siteLocId,
          bom_id: randomUUID(),
          business_stream: '',
          source_reference_type: 'manual',
          source_reference_id: 'REF-X',
          created_by: plannerUserId,
          created_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(direct.status, 400, JSON.stringify(direct.body));
    assert.strictEqual(direct.body['error_code'], 'UNTAGGED_TRANSACTION');
  });

  it('AC1: an inactive business stream is rejected INVALID_BUSINESS_STREAM', async () => {
    const item = await createItem(`FG-${run}-ac1d`);
    const res = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      business_stream: 'nonexistent_stream',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_BUSINESS_STREAM');
  });

  it('AC1 error codes: ITEM_NOT_FOUND, OUTPUT_ITEM_NOT_ACTIVE, PLANT_NOT_FOUND, INVALID_PLANT, INVALID_ORDER_QUANTITY, SOURCE_REFERENCE_REQUIRED, PRODUCTION_ORDER_NOT_FOUND', async () => {
    // ITEM_NOT_FOUND
    const noItem = await createOrder({ output_item_id: randomUUID(), bom_id: randomUUID() });
    assert.strictEqual(noItem.status, 404, JSON.stringify(noItem.body));
    assert.strictEqual(noItem.body['error_code'], 'ITEM_NOT_FOUND');

    // OUTPUT_ITEM_NOT_ACTIVE: an inactive item resolves but is not active.
    const inactiveSku = `FG-${run}-inactive`;
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, 'fifo', 'production', 'inactive')`,
      [inactiveSku],
    );
    const inactiveItemId = (
      await getPool().query('SELECT item_id FROM item_master WHERE sku = $1', [inactiveSku])
    ).rows[0]!['item_id'] as string;
    const notActive = await createOrder({ output_item_id: inactiveItemId, bom_id: randomUUID() });
    assert.strictEqual(notActive.status, 409, JSON.stringify(notActive.body));
    assert.strictEqual(notActive.body['error_code'], 'OUTPUT_ITEM_NOT_ACTIVE');

    // PLANT_NOT_FOUND
    const item = await createItem(`FG-${run}-ac1e`);
    const noPlant = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      plant_location_id: randomUUID(),
    });
    assert.strictEqual(noPlant.status, 404, JSON.stringify(noPlant.body));
    assert.strictEqual(noPlant.body['error_code'], 'PLANT_NOT_FOUND');

    // INVALID_PLANT: a zone-level location resolves but is not a site.
    const notSite = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      plant_location_id: zoneLocId,
    });
    assert.strictEqual(notSite.status, 400, JSON.stringify(notSite.body));
    assert.strictEqual(notSite.body['error_code'], 'INVALID_PLANT');

    // INVALID_ORDER_QUANTITY: not a positive decimal string.
    const badQty = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      order_quantity: '0',
    });
    assert.strictEqual(badQty.status, 400, JSON.stringify(badQty.body));
    assert.strictEqual(badQty.body['error_code'], 'INVALID_ORDER_QUANTITY');
    const nanQty = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      order_quantity: 'abc',
    });
    assert.strictEqual(nanQty.status, 400, JSON.stringify(nanQty.body));
    assert.strictEqual(nanQty.body['error_code'], 'INVALID_ORDER_QUANTITY');
    // NUMERIC(18,6) boundaries: 13+ integer digits and 7+ decimal places both exceed the ceiling.
    const wideQty = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      order_quantity: '1000000000000',
    });
    assert.strictEqual(wideQty.status, 400, JSON.stringify(wideQty.body));
    assert.strictEqual(wideQty.body['error_code'], 'INVALID_ORDER_QUANTITY');
    const fineQty = await createOrder({
      output_item_id: item,
      bom_id: randomUUID(),
      order_quantity: '1.0000001',
    });
    assert.strictEqual(fineQty.status, 400, JSON.stringify(fineQty.body));
    assert.strictEqual(fineQty.body['error_code'], 'INVALID_ORDER_QUANTITY');

    // SOURCE_REFERENCE_REQUIRED: missing id and off-enum type.
    const noSource = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      {
        output_item_id: item,
        order_quantity: '10',
        plant_location_id: siteLocId,
        bom_id: randomUUID(),
        business_stream: 'production',
        source_reference_type: 'manual',
        source_reference_id: '   ',
        idempotency_key: randomUUID(),
      },
      plannerHeaders,
    );
    assert.strictEqual(noSource.status, 400, JSON.stringify(noSource.body));
    assert.strictEqual(noSource.body['error_code'], 'SOURCE_REFERENCE_REQUIRED');
    const badSourceType = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      {
        output_item_id: item,
        order_quantity: '10',
        plant_location_id: siteLocId,
        bom_id: randomUUID(),
        business_stream: 'production',
        source_reference_type: 'sales_order',
        source_reference_id: 'REF-X',
        idempotency_key: randomUUID(),
      },
      plannerHeaders,
    );
    assert.strictEqual(badSourceType.status, 400, JSON.stringify(badSourceType.body));
    assert.strictEqual(badSourceType.body['error_code'], 'SOURCE_REFERENCE_REQUIRED');

    // Over-length source_reference_id: the handler passes it through and the seam's 512-character
    // bound rejects it with INVALID_PAYLOAD (Compliance Seam Contract length check).
    const longSource = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      {
        output_item_id: item,
        order_quantity: '10',
        plant_location_id: siteLocId,
        bom_id: randomUUID(),
        business_stream: 'production',
        source_reference_type: 'manual',
        source_reference_id: 'X'.repeat(513),
        idempotency_key: randomUUID(),
      },
      plannerHeaders,
    );
    assert.strictEqual(longSource.status, 400, JSON.stringify(longSource.body));
    assert.strictEqual(longSource.body['error_code'], 'INVALID_PAYLOAD');

    // PRODUCTION_ORDER_NOT_FOUND
    const missing = await getOrder(randomUUID());
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'PRODUCTION_ORDER_NOT_FOUND');
  });

  it('AC1: a client-supplied order_number_ext is rejected ORDER_NUMBER_IMMUTABLE on the direct POST /api/v1/events path', async () => {
    const item = await createItem(`FG-${run}-ac1f`);
    // The declared payload must carry the item's REAL sku/uom (the applier re-derives and checks
    // both under lock before it allocates the number), and the item's real sku is server-assigned.
    const itemRow = (
      await getPool().query('SELECT sku, uom FROM item_master WHERE item_id = $1', [item])
    ).rows[0]! as { sku: string; uom: string };
    const directOrderId = randomUUID();
    // A year 100 years ahead can never equal the server-allocated MO-<currentYear>-NNNN number,
    // so this test asserts the immutable-number guard without depending on the sequence state or
    // the current calendar year.
    const impossibleNumber = `MO-${new Date().getUTCFullYear() + 100}-0001`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: directOrderId,
        event_type: 'production_order.created',
        payload: {
          production_order_id: directOrderId,
          order_number_ext: impossibleNumber,
          output_item_id: item,
          output_sku: itemRow.sku,
          order_quantity: '1',
          order_uom: itemRow.uom,
          plant_location_id: siteLocId,
          bom_id: randomUUID(),
          business_stream: 'production',
          source_reference_type: 'manual',
          source_reference_id: 'REF-Y',
          created_by: plannerUserId,
          created_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ORDER_NUMBER_IMMUTABLE');
  });

  // -------------------------------------------------------------------------
  // AC2: state machine, exhaustive rejection, edit-log attribution
  // -------------------------------------------------------------------------

  it('AC2: the legal path planned -> released -> in_process -> completed -> closed works and every accepted transition is attributed in the edit log', async () => {
    const { itemOut, bom } = await releasedSingleLineBom('ac2');
    const created = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body['production_order_id'] as string;

    // No stock is needed: the override release by the DOA approver crosses any shortfall, and this
    // test is about the transition walk, not the gate verdict.
    const released = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      {
        idempotency_key: randomUUID(),
        override: { reason: 'State machine walk' },
      },
      approverHeaders,
    );
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
    assert.strictEqual(released.body['status'], 'released');

    const inProcess = await transitionOrder(orderId, 'in_process');
    assert.strictEqual(inProcess.status, 200, JSON.stringify(inProcess.body));
    const completed = await transitionOrder(orderId, 'completed');
    assert.strictEqual(completed.status, 200, JSON.stringify(completed.body));
    const closed = await transitionOrder(orderId, 'closed');
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));

    await assertOrderStatus(orderId, 'closed');

    // FR-AC-13 / AC2: one audit_log row per accepted event (create + release + 3 transitions).
    const auditRows = await auditRowCountForOrder(orderId);
    assert.strictEqual(
      auditRows,
      5,
      'every accepted transition must be attributed in the edit log',
    );
  });

  it('AC2: every illegal transition pair returns 400 INVALID_STATE_TRANSITION', async () => {
    const { itemOut, bom } = await releasedSingleLineBom('ac2b');
    const created = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = created.body['production_order_id'] as string;

    // planned: no transition route edge is legal; release is legal (needs an override when there is
    // no stock) and cancel is legal.
    assertInvalidTransition(await transitionOrder(orderId, 'in_process'));
    assertInvalidTransition(await transitionOrder(orderId, 'completed'));
    assertInvalidTransition(await transitionOrder(orderId, 'closed'));

    // released: only in_process is legal on the transition route.
    const released = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'Rejection table' } },
      approverHeaders,
    );
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
    assertInvalidTransition(await transitionOrder(orderId, 'completed'));
    assertInvalidTransition(await transitionOrder(orderId, 'closed'));

    // in_process: only completed is legal.
    assert.strictEqual((await transitionOrder(orderId, 'in_process')).status, 200);
    assertInvalidTransition(await transitionOrder(orderId, 'in_process'));
    assertInvalidTransition(await transitionOrder(orderId, 'closed'));
    assertInvalidTransition(await cancelOrder(orderId));
    assertInvalidTransition(await releaseOrder(orderId));

    // completed: only closed is legal.
    assert.strictEqual((await transitionOrder(orderId, 'completed')).status, 200);
    assertInvalidTransition(await transitionOrder(orderId, 'in_process'));
    assertInvalidTransition(await transitionOrder(orderId, 'completed'));
    assertInvalidTransition(await cancelOrder(orderId));
    assertInvalidTransition(await releaseOrder(orderId));

    // closed: terminal.
    assert.strictEqual((await transitionOrder(orderId, 'closed')).status, 200);
    assertInvalidTransition(await transitionOrder(orderId, 'in_process'));
    assertInvalidTransition(await transitionOrder(orderId, 'completed'));
    assertInvalidTransition(await transitionOrder(orderId, 'closed'));
    assertInvalidTransition(await cancelOrder(orderId));
    assertInvalidTransition(await releaseOrder(orderId));

    // cancelled: terminal.
    const second = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const secondId = second.body['production_order_id'] as string;
    assert.strictEqual((await cancelOrder(secondId)).status, 200);
    assertInvalidTransition(await transitionOrder(secondId, 'in_process'));
    assertInvalidTransition(await cancelOrder(secondId));
    assertInvalidTransition(await releaseOrder(secondId));
  });

  // -------------------------------------------------------------------------
  // AC3: cancellation reachability
  // -------------------------------------------------------------------------

  it('AC3: cancel from in_process, completed and closed is rejected INVALID_STATE_TRANSITION; cancel from planned and released succeeds', async () => {
    const { itemOut: item, bom } = await releasedSingleLineBom('ac3');

    // From in_process.
    const order1 = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const id1 = order1.body['production_order_id'] as string;
    const r1 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${id1}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'AC3' } },
      approverHeaders,
    );
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    assert.strictEqual((await transitionOrder(id1, 'in_process')).status, 200);
    const cancelInProcess = await cancelOrder(id1);
    assert.strictEqual(cancelInProcess.status, 400, JSON.stringify(cancelInProcess.body));
    assert.strictEqual(cancelInProcess.body['error_code'], 'INVALID_STATE_TRANSITION');

    // From completed.
    const order2 = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const id2 = order2.body['production_order_id'] as string;
    const r2 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${id2}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'AC3' } },
      approverHeaders,
    );
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.strictEqual((await transitionOrder(id2, 'in_process')).status, 200);
    assert.strictEqual((await transitionOrder(id2, 'completed')).status, 200);
    const cancelCompleted = await cancelOrder(id2);
    assert.strictEqual(cancelCompleted.status, 400, JSON.stringify(cancelCompleted.body));
    assert.strictEqual(cancelCompleted.body['error_code'], 'INVALID_STATE_TRANSITION');

    // From closed.
    const order3 = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const id3 = order3.body['production_order_id'] as string;
    const r3 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${id3}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'AC3' } },
      approverHeaders,
    );
    assert.strictEqual(r3.status, 200, JSON.stringify(r3.body));
    assert.strictEqual((await transitionOrder(id3, 'in_process')).status, 200);
    assert.strictEqual((await transitionOrder(id3, 'completed')).status, 200);
    assert.strictEqual((await transitionOrder(id3, 'closed')).status, 200);
    const cancelClosed = await cancelOrder(id3);
    assert.strictEqual(cancelClosed.status, 400, JSON.stringify(cancelClosed.body));
    assert.strictEqual(cancelClosed.body['error_code'], 'INVALID_STATE_TRANSITION');

    // From planned.
    const order4 = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const id4 = order4.body['production_order_id'] as string;
    const cancelPlanned = await cancelOrder(id4);
    assert.strictEqual(cancelPlanned.status, 200, JSON.stringify(cancelPlanned.body));
    await assertOrderStatus(id4, 'cancelled');

    // From released.
    const order5 = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const id5 = order5.body['production_order_id'] as string;
    const r5 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${id5}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'AC3' } },
      approverHeaders,
    );
    assert.strictEqual(r5.status, 200, JSON.stringify(r5.body));
    const cancelReleased = await cancelOrder(id5);
    assert.strictEqual(cancelReleased.status, 200, JSON.stringify(cancelReleased.body));
    await assertOrderStatus(id5, 'cancelled');
  });

  it('Table 5: a blank reason_code on cancel is rejected 400 INVALID_PARAMS by the handler', async () => {
    const item = await createItem(`FG-${run}-blank-code`);
    const order = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    const orderId = order.body['production_order_id'] as string;

    for (const reasonCode of ['', '   ']) {
      const res = await cancelOrder(orderId, { reason_code: reasonCode });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
    await assertOrderStatus(orderId, 'planned');
  });

  it('Table 5: an over-length override_reason on release is rejected 400 INVALID_PAYLOAD by the seam', async () => {
    const fx = await releasedTwoLineBom('long-reason');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'X'.repeat(513) } },
      approverHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PAYLOAD');
    await assertOrderStatus(orderId, 'planned');
  });

  // -------------------------------------------------------------------------
  // AC4: unreversed transactions block cancellation
  // -------------------------------------------------------------------------

  it('AC4: cancel from released with unreversed_transaction_count > 0 is rejected UNREVERSED_TRANSACTIONS, and succeeds once the counter is zero', async () => {
    const { itemOut: item, bom } = await releasedSingleLineBom('ac4');
    const order = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;
    const released = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'AC4' } },
      approverHeaders,
    );
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));

    // Story 6.2 owns the writer that increments this counter; seed it directly with a comment so
    // the test does not pretend to be that writer.
    await getPool().query(
      `UPDATE production_order SET unreversed_transaction_count = 1 WHERE production_order_id = $1`,
      [orderId],
    );

    const blocked = await cancelOrder(orderId);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'UNREVERSED_TRANSACTIONS');
    await assertOrderStatus(orderId, 'released');

    await getPool().query(
      `UPDATE production_order SET unreversed_transaction_count = 0 WHERE production_order_id = $1`,
      [orderId],
    );
    const nowAllowed = await cancelOrder(orderId);
    assert.strictEqual(nowAllowed.status, 200, JSON.stringify(nowAllowed.body));
    await assertOrderStatus(orderId, 'cancelled');
  });

  // -------------------------------------------------------------------------
  // AC5: the release gate (shortfall blocks, stock releases, nesting, depth)
  // -------------------------------------------------------------------------

  /** A released one-component BOM for the state-machine tests, where stock is irrelevant. */
  async function releasedSingleLineBom(suffix: string): Promise<{
    itemOut: string;
    c1Sku: string;
    bom: { bomId: string; revisionId: string };
  }> {
    const itemOut = await createItem(`FG-${run}-${suffix}`);
    const itemC1 = await createItem(`C1-${run}-${suffix}`);
    const c1Sku = (
      await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [itemC1])
    ).rows[0]!['sku'] as string;
    const bom = await draftAndRelease(itemOut, [componentLine(1, itemC1)]);
    return { itemOut, c1Sku, bom };
  }

  async function releasedTwoLineBom(suffix: string): Promise<{
    itemOut: string;
    itemC1: string;
    itemC2: string;
    c1Sku: string;
    c2Sku: string;
    bom: { bomId: string; revisionId: string };
  }> {
    const itemOut = await createItem(`FG-${run}-${suffix}`);
    const itemC1 = await createItem(`C1-${run}-${suffix}`);
    const itemC2 = await createItem(`C2-${run}-${suffix}`);
    const c1Sku = (
      await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [itemC1])
    ).rows[0]!['sku'] as string;
    const c2Sku = (
      await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [itemC2])
    ).rows[0]!['sku'] as string;
    const bom = await draftAndRelease(itemOut, [
      componentLine(1, itemC1),
      componentLine(2, itemC2),
    ]);
    return { itemOut, itemC1, itemC2, c1Sku, c2Sku, bom };
  }

  it('AC5: a shortfall blocks release with per-line shortfall detail, leaves the order planned, and writes no release event', async () => {
    const fx = await releasedTwoLineBom('ac5-short');
    const itemOut = fx.itemOut;
    const c1Sku = fx.c1Sku;
    const c2Sku = fx.c2Sku;
    const bom = fx.bom;

    // quantity_per 2.0 on each line: order quantity 10 -> 20 required per line.
    await receiveStock(c1Sku, binLocId, 20);

    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const res = await releaseOrder(orderId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    const lines = (res.body['details'] as Record<string, unknown> | undefined)?.['lines'] as
      Record<string, unknown>[] | undefined;
    assert.ok(lines, 'per-line shortfall detail must be present');
    const short = lines.find((l) => l['component_sku'] === c2Sku && l['satisfied'] === false);
    assert.ok(short, `shortfall must name the short component ${c2Sku}: ${JSON.stringify(lines)}`);
    await assertNumericEqual(short!['shortfall_quantity'], '20', 'shortfall must be exactly 20');
    assert.strictEqual(lines.find((l) => l['component_sku'] === c1Sku)!['satisfied'], true);

    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(
      await domainEventCount(orderId, 'production_order.released'),
      0,
      'a blocked release must not write a production_order.released event',
    );
  });

  it('AC5: sufficient stock releases, pins released_revision_id to the explosion revision, and does not expedite', async () => {
    const fx = await releasedTwoLineBom('ac5-suff');
    const itemOut = fx.itemOut;
    const c1Sku = fx.c1Sku;
    const c2Sku = fx.c2Sku;
    const bom = fx.bom;

    await receiveStock(c1Sku, binLocId, 20);
    await receiveStock(c2Sku, binLocId, 20);

    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const res = await releaseOrder(orderId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'released');
    assert.strictEqual(res.body['released_revision_id'], bom.revisionId);
    assert.strictEqual(res.body['expediting_flag'], false);
    assert.strictEqual(res.body['override_by'], null);
    assert.strictEqual(res.body['override_reason'], null);

    // The pinned revision is the CURRENT released revision of the BOM.
    assert.strictEqual(await currentRevisionOf(bom.bomId), bom.revisionId);
  });

  it('AC5: a nested BOM explodes through the delegated walk and its requirements gate availability', async () => {
    const itemOut = await createItem(`FG-${run}-nested`);
    const itemMid = await createItem(`MID-${run}-nested`);
    const itemLeaf = await createItem(`LEAF-${run}-nested`);
    const midSku = (
      await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [itemMid])
    ).rows[0]!['sku'] as string;
    const leafSku = (
      await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [itemLeaf])
    ).rows[0]!['sku'] as string;

    // child BOM: MID consumes LEAF at 2.0 per unit.
    await draftAndRelease(itemMid, [componentLine(1, itemLeaf)]);
    // parent BOM: OUT consumes MID at 2.0 per unit.
    const bom = await draftAndRelease(itemOut, [componentLine(1, itemMid)]);

    // order 10 -> MID required 20; the child walk -> LEAF required 40.
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const blocked = await releaseOrder(orderId);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    const blockedLines = (blocked.body['details'] as Record<string, unknown> | undefined)?.[
      'lines'
    ] as Record<string, unknown>[] | undefined;
    assert.ok(
      blockedLines?.find((l) => l['component_sku'] === leafSku && l['satisfied'] === false),
      `leaf shortfall must be reported: ${JSON.stringify(blockedLines)}`,
    );

    await receiveStock(midSku, binLocId, 20);
    await receiveStock(leafSku, binLocId, 40);
    const res = await releaseOrder(orderId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['released_revision_id'], bom.revisionId);
  });

  it('AC5: stock two levels below the plant site is found by the descendant walk', async () => {
    const itemOut = await createItem(`FG-${run}-deep`);
    const itemC1 = await createItem(`C1-${run}-deep`);
    const c1Sku = (
      await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [itemC1])
    ).rows[0]!['sku'] as string;
    const bom = await draftAndRelease(itemOut, [componentLine(1, itemC1)]);

    // The stock sits in binLoc, which is site -> zone -> bin (two levels below the plant).
    await receiveStock(c1Sku, binLocId, 20);

    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;
    const res = await releaseOrder(orderId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['released_revision_id'], bom.revisionId);
  });

  it('AC5: the dry-run gate read returns a 200 satisfied:false body on a shortfall instead of a 409', async () => {
    const fx = await releasedTwoLineBom('dryrun');
    const itemOut = fx.itemOut;
    const c1Sku = fx.c1Sku;
    const bom = fx.bom;
    await receiveStock(c1Sku, binLocId, 20);

    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}/release-gate`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['satisfied'], false);
    const lines = (res.body['lines'] as Record<string, unknown>[] | undefined) ?? [];
    assert.ok(lines.length > 0, 'the dry-run must carry per-line detail');
    const short = lines.find((l) => l['component_sku'] === fx.c2Sku && l['satisfied'] === false);
    assert.ok(
      short,
      `the unstocked line must be reported as a shortfall: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      (short as Record<string, unknown>)['shortfall_quantity'] !== undefined,
      'the shortfall line must carry shortfall_quantity',
    );
    await assertOrderStatus(orderId, 'planned');
  });

  it('AC5 delegation negatives: RD_EXECUTION_BARRED, BOM_NOT_RELEASED and BOM_ITEM_MISMATCH prove the gate delegates', async () => {
    // RD_EXECUTION_BARRED: an R&D draft BOM never reaches the gate's own checks.
    const itemRnd = await createItem(`FG-${run}-rnd`);
    const itemRndComp = await createItem(`C-${run}-rnd`);
    const rndDraft = await draftBom(itemRnd, [componentLine(1, itemRndComp)], 'rnd');
    assert.strictEqual(rndDraft.status, 201, JSON.stringify(rndDraft.body));
    const rndBomId = rndDraft.body['bom_id'] as string;
    const rndOrder = await createOrder({ output_item_id: itemRnd, bom_id: rndBomId });
    const rndOrderId = rndOrder.body['production_order_id'] as string;
    const rndRes = await releaseOrder(rndOrderId);
    assert.strictEqual(rndRes.status, 409, JSON.stringify(rndRes.body));
    assert.strictEqual(rndRes.body['error_code'], 'RD_EXECUTION_BARRED');

    // BOM_NOT_RELEASED: a draft BOM is a real BOM that matches the output item but is not released.
    const itemDraft = await createItem(`FG-${run}-draft`);
    const itemDraftComp = await createItem(`C-${run}-draft`);
    const draft = await draftBom(itemDraft, [componentLine(1, itemDraftComp)]);
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));
    const draftBomId = draft.body['bom_id'] as string;
    const draftOrder = await createOrder({ output_item_id: itemDraft, bom_id: draftBomId });
    const draftOrderId = draftOrder.body['production_order_id'] as string;
    const draftRes = await releaseOrder(draftOrderId);
    assert.strictEqual(draftRes.status, 409, JSON.stringify(draftRes.body));
    assert.strictEqual(draftRes.body['error_code'], 'BOM_NOT_RELEASED');

    // BOM_ITEM_MISMATCH: the BOM's parent item is not the order's output item.
    const itemOther = await createItem(`FG-${run}-other`);
    const itemMatch = await createItem(`FG-${run}-match`);
    const itemMatchComp = await createItem(`C-${run}-match`);
    const bom = await draftAndRelease(itemMatch, [componentLine(1, itemMatchComp)]);
    const mismatchOrder = await createOrder({ output_item_id: itemOther, bom_id: bom.bomId });
    const mismatchOrderId = mismatchOrder.body['production_order_id'] as string;
    const mismatchRes = await releaseOrder(mismatchOrderId);
    assert.strictEqual(mismatchRes.status, 409, JSON.stringify(mismatchRes.body));
    assert.strictEqual(mismatchRes.body['error_code'], 'BOM_ITEM_MISMATCH');

    // BOM_NOT_FOUND: creation records bom_id without resolving it, so a random bom_id reaches the
    // release gate's getBomById and surfaces the delegated 404.
    const itemNoBom = await createItem(`FG-${run}-nobom`);
    const noBomOrder = await createOrder({ output_item_id: itemNoBom, bom_id: randomUUID() });
    const noBomOrderId = noBomOrder.body['production_order_id'] as string;
    const noBomRes = await releaseOrder(noBomOrderId);
    assert.strictEqual(noBomRes.status, 404, JSON.stringify(noBomRes.body));
    assert.strictEqual(noBomRes.body['error_code'], 'BOM_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // AC6 / AC7: the DOA-resolved override
  // -------------------------------------------------------------------------

  it('AC7: an override by a non-approver is rejected 403 APPROVAL_REQUIRED with an explicit edit-log row', async () => {
    const fx = await releasedTwoLineBom('ac7');
    const itemOut = fx.itemOut;
    const c1Sku = fx.c1Sku;
    const bom = fx.bom;
    await receiveStock(c1Sku, binLocId, 20);

    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'Expedite' } },
      nonApproverHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(
      await domainEventCount(orderId, 'production_order.released'),
      0,
      'a rejected override must not write a production_order.released event',
    );

    // AC7: the rejected attempt is in the edit log with the mandated code, status, order id and
    // resolved approver.
    const audit = await getPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE error_code = 'APPROVAL_REQUIRED'
          AND http_status = 403
          AND event_id IS NULL
          AND details ->> 'production_order_id' = $1
          AND details ->> 'resolved_approver_user_id' = $2`,
      [orderId, approverUserId],
    );
    assert.strictEqual(
      audit.rows[0]!['n'],
      1,
      'the rejected override must write an explicit APPROVAL_REQUIRED audit_log row',
    );
  });

  it('AC6: an override by the resolved DOA approver releases despite a shortfall and records the expediting triple', async () => {
    const fx = await releasedTwoLineBom('ac6');
    const itemOut = fx.itemOut;
    const c1Sku = fx.c1Sku;
    const bom = fx.bom;
    // Only one of two lines is stocked - a genuine shortfall the override must cross.
    await receiveStock(c1Sku, binLocId, 20);

    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'Expedite now' } },
      approverHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], 'released');
    assert.strictEqual(res.body['expediting_flag'], true);
    assert.strictEqual(res.body['override_by'], approverUserId);
    assert.strictEqual(res.body['override_reason'], 'Expedite now');
    assert.strictEqual(res.body['released_revision_id'], bom.revisionId);

    const audit = await getPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE event_id IN (
          SELECT event_id FROM domain_events
          WHERE stream_id = $1 AND event_type = 'production_order.released'
        )`,
      [orderId],
    );
    assert.ok(audit.rows[0]!['n'] >= 1, 'the release must be attributed in the edit log');
  });

  it('Table 5: an override with a blank or missing reason is rejected 400 OVERRIDE_REASON_REQUIRED BEFORE any DOA resolution', async () => {
    const fx = await releasedTwoLineBom('no-reason');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    // A non-approver cannot probe the DOA registry with an empty override body: the reason check
    // runs first and returns 400, never APPROVAL_UNRESOLVED/APPROVAL_REQUIRED.
    for (const overrideBody of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/production-orders/${orderId}/release`,
        { idempotency_key: randomUUID(), override: overrideBody },
        nonApproverHeaders,
      );
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'OVERRIDE_REASON_REQUIRED');
    }
    await assertOrderStatus(orderId, 'planned');
  });

  it('Table 5: an order-number collision on the unique index is mapped to 409 DUPLICATE_PRODUCTION_ORDER_NUMBER', async () => {
    // The number comes from the shared sequence. Force a collision by rewinding the sequence so the
    // next allocation re-uses a number that already exists in production_order; the 23505 resolver
    // in the applier maps it to DUPLICATE_PRODUCTION_ORDER_NUMBER instead of a 500. The sequence is
    // restored afterwards so later allocations continue past every existing number.
    const item = await createItem(`FG-${run}-dupnum`);
    const first = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const maxRow = await getPool().query(
      `SELECT max((regexp_match(order_number_ext, 'MO-\\d{4}-(\\d+)$'))[1]::bigint) AS max_n
         FROM production_order`,
    );
    const maxN = Number(maxRow.rows[0]!['max_n']);
    assert.ok(Number.isInteger(maxN) && maxN >= 1, `expected an allocated number, got ${maxN}`);

    // app_user holds only USAGE on the sequence; the admin pool owns it and may rewind it.
    await getAdminPool().query(`SELECT setval('production_order_number_seq', $1::bigint, true)`, [
      maxN - 1,
    ]);
    const second = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_PRODUCTION_ORDER_NUMBER');

    await getAdminPool().query(`SELECT setval('production_order_number_seq', $1::bigint, true)`, [
      maxN,
    ]);
  });

  // -------------------------------------------------------------------------
  // AD-12 bypass evidence: forged direct events cannot defeat the seam
  // -------------------------------------------------------------------------

  it('AD-12: a forged production_order.released with a fabricated override_by is rejected 403 and changes no projection row', async () => {
    const fx = await releasedTwoLineBom('forged1');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.released',
        payload: {
          production_order_id: orderId,
          // The correct revision id so the seam's re-derivation passes and the DOA check fires.
          released_revision_id: bom.revisionId,
          business_date: new Date().toISOString().slice(0, 10),
          expediting_flag: true,
          override_by: randomUUID(),
          override_reason: 'Forged override',
          released_by: plannerUserId,
          released_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.released'), 0);
  });

  it('AD-12: a forged production_order.released with a shortfall and no override is rejected 409 INSUFFICIENT_STOCK and changes no projection row', async () => {
    const fx = await releasedTwoLineBom('forged2');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;
    // No stock at all: the gate verdict is unsatisfied, and no override means a hard 409.

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.released',
        payload: {
          production_order_id: orderId,
          released_revision_id: bom.revisionId,
          business_date: new Date().toISOString().slice(0, 10),
          expediting_flag: false,
          override_by: null,
          override_reason: null,
          released_by: plannerUserId,
          released_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.released'), 0);
  });

  it('AD-12: a forged production_order.released declaring the REAL approver as override_by is still rejected when the acting user is not that approver', async () => {
    const fx = await releasedTwoLineBom('forged3');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    // The payload names the REAL resolved approver - only the actor (a plain production planner)
    // is wrong, so the declared-override_by check alone would pass and the AC7 actor check must fire.
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.released',
        payload: {
          production_order_id: orderId,
          released_revision_id: bom.revisionId,
          business_date: new Date().toISOString().slice(0, 10),
          expediting_flag: true,
          override_by: approverUserId,
          override_reason: 'Forged override',
          released_by: plannerUserId,
          released_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.released'), 0);
  });

  it('AD-12: a forged production_order.state_changed carrying an illegal transition is rejected 400 and changes no projection row', async () => {
    const item = await createItem(`FG-${run}-forged`);
    // No BOM is needed: the order is created (bom_id is recorded, not resolved at create) and the
    // forged transition is rejected before the release gate ever runs.
    const order = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.state_changed',
        payload: {
          production_order_id: orderId,
          previous_status: 'planned',
          new_status: 'completed',
          changed_by: plannerUserId,
          changed_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.state_changed'), 0);
  });

  it('AD-12: a forged production_order.cancelled declaring the wrong unreversed_transaction_count is rejected 409 PRODUCTION_ORDER_DERIVATION_MISMATCH', async () => {
    const item = await createItem(`FG-${run}-forged-cancel`);
    const order = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    const orderId = order.body['production_order_id'] as string;

    // The locked row holds unreversed_transaction_count = 0; a forged declaration of 1 must reject
    // with PRODUCTION_ORDER_DERIVATION_MISMATCH before the AC4 guard even runs.
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.cancelled',
        payload: {
          production_order_id: orderId,
          previous_status: 'planned',
          unreversed_transaction_count: 1,
          cancelled_by: plannerUserId,
          cancelled_at: new Date().toISOString(),
          reason_code: null,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PRODUCTION_ORDER_DERIVATION_MISMATCH');
    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.cancelled'), 0);
  });

  it('AD-12: a production_order.cancelled declaring the correct unreversed_transaction_count cancels the order', async () => {
    const item = await createItem(`FG-${run}-cancel-ok`);
    const order = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.cancelled',
        payload: {
          production_order_id: orderId,
          previous_status: 'planned',
          unreversed_transaction_count: 0,
          cancelled_by: plannerUserId,
          cancelled_at: new Date().toISOString(),
          reason_code: null,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    await assertOrderStatus(orderId, 'cancelled');
  });

  it('AD-12: a forged production_order.released declaring the wrong released_revision_id is rejected 409 PRODUCTION_ORDER_DERIVATION_MISMATCH', async () => {
    const fx = await releasedTwoLineBom('forged-rev');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.released',
        payload: {
          production_order_id: orderId,
          released_revision_id: randomUUID(),
          business_date: new Date().toISOString().slice(0, 10),
          expediting_flag: false,
          override_by: null,
          override_reason: null,
          released_by: plannerUserId,
          released_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PRODUCTION_ORDER_DERIVATION_MISMATCH');
    await assertOrderStatus(orderId, 'planned');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.released'), 0);
  });

  it('AD-12: a forged production_order.created declaring the wrong output_sku is rejected 409 PRODUCTION_ORDER_DERIVATION_MISMATCH', async () => {
    const item = await createItem(`FG-${run}-forged-sku`);
    const directOrderId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: directOrderId,
        event_type: 'production_order.created',
        payload: {
          production_order_id: directOrderId,
          order_number_ext: '',
          output_item_id: item,
          output_sku: 'NOT-THE-SKU',
          order_quantity: '1',
          order_uom: 'EA',
          plant_location_id: siteLocId,
          bom_id: randomUUID(),
          business_stream: 'production',
          source_reference_type: 'manual',
          source_reference_id: 'REF-SKU',
          created_by: plannerUserId,
          created_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PRODUCTION_ORDER_DERIVATION_MISMATCH');
    assert.strictEqual(await domainEventCount(directOrderId, 'production_order.created'), 0);
  });

  it('AD-12: a forged production_order.state_changed declaring the wrong previous_status is rejected 409 PRODUCTION_ORDER_DERIVATION_MISMATCH', async () => {
    const item = await createItem(`FG-${run}-forged-prev`);
    const order = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    const orderId = order.body['production_order_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.state_changed',
        payload: {
          production_order_id: orderId,
          previous_status: 'released',
          new_status: 'in_process',
          changed_by: plannerUserId,
          changed_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PRODUCTION_ORDER_DERIVATION_MISMATCH');
    await assertOrderStatus(orderId, 'planned');
  });

  it('AD-12: a forged production_order.cancelled on a released order with unreversed transactions is rejected 409 UNREVERSED_TRANSACTIONS by the SEAM (not the handler pre-check)', async () => {
    const fx = await releasedTwoLineBom('seam-ac4');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };
    const order = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;
    const released = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'Seam AC4' } },
      approverHeaders,
    );
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));

    // Story 6.2 owns the counter writer; seed it directly, then post a DIRECT cancelled event with
    // a MATCHING declared counter so the derivation check passes and the seam's AC4 guard fires.
    await getPool().query(
      `UPDATE production_order SET unreversed_transaction_count = 1 WHERE production_order_id = $1`,
      [orderId],
    );
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.cancelled',
        payload: {
          production_order_id: orderId,
          previous_status: 'released',
          unreversed_transaction_count: 1,
          cancelled_by: plannerUserId,
          cancelled_at: new Date().toISOString(),
          reason_code: null,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UNREVERSED_TRANSACTIONS');
    await assertOrderStatus(orderId, 'released');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.cancelled'), 0);
  });

  it('AD-12: a direct production_order.created with an out-of-range UTC offset is rejected 400 INVALID_PAYLOAD instead of a 500', async () => {
    const item = await createItem(`FG-${run}-offset`);
    const directOrderId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: directOrderId,
        event_type: 'production_order.created',
        payload: {
          production_order_id: directOrderId,
          order_number_ext: '',
          output_item_id: item,
          output_sku: 'SKU-OFFSET',
          order_quantity: '1',
          order_uom: 'EA',
          plant_location_id: siteLocId,
          bom_id: randomUUID(),
          business_stream: 'production',
          source_reference_type: 'manual',
          source_reference_id: 'REF-OFFSET',
          created_by: plannerUserId,
          created_at: '2026-01-01T10:00:00+99:99',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PAYLOAD');
    assert.strictEqual(await domainEventCount(directOrderId, 'production_order.created'), 0);
  });

  it('Table 5: a malformed :orderId path parameter is rejected 400 INVALID_PARAMS', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders/not-a-uuid',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // Idempotency: replay tests per write route
  // -------------------------------------------------------------------------

  it('AD-16: every write route is idempotent - a same-key replay returns the same resource and writes no second event', async () => {
    const { itemOut: item, bom } = await releasedSingleLineBom('idem');

    // Create replay.
    const key = randomUUID();
    const body = {
      output_item_id: item,
      order_quantity: '10',
      plant_location_id: siteLocId,
      bom_id: bom.bomId,
      business_stream: 'production',
      source_reference_type: 'manual',
      source_reference_id: 'REF-IDEM',
      idempotency_key: key,
    };
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      body,
      plannerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const orderId = first.body['production_order_id'] as string;
    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      body,
      plannerHeaders,
    );
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['production_order_id'], orderId);
    assert.strictEqual(await domainEventCount(orderId, 'production_order.created'), 1);

    // Release replay (override path so no stock is needed).
    const releaseBody = { idempotency_key: randomUUID(), override: { reason: 'Idem' } };
    const releaseFirst = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      releaseBody,
      approverHeaders,
    );
    assert.strictEqual(releaseFirst.status, 200, JSON.stringify(releaseFirst.body));
    const releaseReplay = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      releaseBody,
      approverHeaders,
    );
    assert.strictEqual(releaseReplay.status, 200, JSON.stringify(releaseReplay.body));
    assert.strictEqual(releaseReplay.body['production_order_id'], orderId);
    assert.strictEqual(await domainEventCount(orderId, 'production_order.released'), 1);

    // Cancel replay. Ordered BEFORE any transition: cancellation is only legal from planned or
    // released, so the same-key replay of a successful cancel must return the stored result while
    // the order is still released (the replay-first handler check proves exactly that).
    const cancelBody = { reason_code: 'no longer needed', idempotency_key: randomUUID() };
    const cancelFirst = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/cancel`,
      cancelBody,
      plannerHeaders,
    );
    assert.strictEqual(cancelFirst.status, 200, JSON.stringify(cancelFirst.body));
    const cancelReplay = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/cancel`,
      cancelBody,
      plannerHeaders,
    );
    assert.strictEqual(cancelReplay.status, 200, JSON.stringify(cancelReplay.body));
    assert.strictEqual(cancelReplay.body['production_order_id'], orderId);
    assert.strictEqual(await domainEventCount(orderId, 'production_order.cancelled'), 1);

    // Transition replay on a SECOND order (transitions are one-way and cancel has already
    // terminated the first).
    const secondOrder = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const secondId = secondOrder.body['production_order_id'] as string;
    const secondRelease = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${secondId}/release`,
      { idempotency_key: randomUUID(), override: { reason: 'Idem' } },
      approverHeaders,
    );
    assert.strictEqual(secondRelease.status, 200, JSON.stringify(secondRelease.body));
    const transitionBody = { new_status: 'in_process', idempotency_key: randomUUID() };
    const transFirst = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${secondId}/transition`,
      transitionBody,
      plannerHeaders,
    );
    assert.strictEqual(transFirst.status, 200, JSON.stringify(transFirst.body));
    const transReplay = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${secondId}/transition`,
      transitionBody,
      plannerHeaders,
    );
    assert.strictEqual(transReplay.status, 200, JSON.stringify(transReplay.body));
    assert.strictEqual(transReplay.body['production_order_id'], secondId);
    assert.strictEqual(await domainEventCount(secondId, 'production_order.state_changed'), 1);

    // Cross-event-type key reuse surfaces 409 DUPLICATE_EVENT (replayIdOrReject): the RELEASE
    // key, reused on a create, resolves to a foreign production_order.released event - not a
    // same-type create replay.
    const stale = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      {
        output_item_id: item,
        order_quantity: '10',
        plant_location_id: siteLocId,
        bom_id: bom.bomId,
        business_stream: 'production',
        source_reference_type: 'manual',
        source_reference_id: 'REF-X',
        idempotency_key: releaseBody.idempotency_key,
      },
      plannerHeaders,
    );
    assert.strictEqual(stale.status, 409, JSON.stringify(stale.body));
    assert.strictEqual(stale.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('AD-16: a same-event-type idempotency-key reuse on a DIFFERENT order surfaces 409 DUPLICATE_EVENT instead of releasing the wrong order', async () => {
    const fx = await releasedTwoLineBom('idem-cross-rel');
    const itemOut = fx.itemOut as string;
    const bom = fx.bom as { bomId: string; revisionId: string };

    // Order A is released with key K.
    const orderA = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderAId = orderA.body['production_order_id'] as string;
    const releaseBody = { idempotency_key: randomUUID(), override: { reason: 'Idem cross' } };
    const releaseA = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderAId}/release`,
      releaseBody,
      approverHeaders,
    );
    assert.strictEqual(releaseA.status, 200, JSON.stringify(releaseA.body));

    // The same key on order B must NOT silently return order A's released resource - the
    // stream_id check in replayIdOrReject surfaces 409 DUPLICATE_EVENT and order B stays planned.
    const orderB = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderBId = orderB.body['production_order_id'] as string;
    const releaseB = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderBId}/release`,
      releaseBody,
      approverHeaders,
    );
    assert.strictEqual(releaseB.status, 409, JSON.stringify(releaseB.body));
    assert.strictEqual(releaseB.body['error_code'], 'DUPLICATE_EVENT');
    await assertOrderStatus(orderBId, 'planned');
  });

  it('RBAC: a plant-scoped production role cannot read, list, release or cancel an order at another plant (LOCATION_ACCESS_DENIED)', async () => {
    const otherSiteLocId = await seedLocation('site', `PLANT-OTHER-${run}`, null, null);
    await provisionUser(port, `scoped-reader-6-1-${run}@example.com`, [
      {
        role: 'production_viewer',
        module: 'production',
        functionScope: 'read',
        locationId: otherSiteLocId,
      },
    ]);
    const scopedReaderHeaders = await authFor(port, `scoped-reader-6-1-${run}@example.com`);
    await provisionUser(port, `scoped-writer-6-1-${run}@example.com`, [
      {
        role: 'production_planner',
        module: 'production',
        functionScope: 'write',
        locationId: otherSiteLocId,
      },
    ]);
    const scopedWriterHeaders = await authFor(port, `scoped-writer-6-1-${run}@example.com`);

    const item = await createItem(`FG-${run}-scoped`);
    const order = await createOrder({ output_item_id: item, bom_id: randomUUID() });
    const orderId = order.body['production_order_id'] as string;
    assert.strictEqual(order.body['plant_location_id'], siteLocId);

    // Read denied for a reader scoped to another plant.
    const readDenied = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}`,
      undefined,
      scopedReaderHeaders,
    );
    assert.strictEqual(readDenied.status, 403, JSON.stringify(readDenied.body));
    assert.strictEqual(readDenied.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // List filtered: the scoped reader sees no orders at the main site.
    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders',
      undefined,
      scopedReaderHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.ok(
      !(list.body['orders'] as Record<string, unknown>[]).some(
        (o) => o['production_order_id'] === orderId,
      ),
    );

    // Release denied for a writer scoped to another plant.
    const releaseDenied = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID() },
      scopedWriterHeaders,
    );
    assert.strictEqual(releaseDenied.status, 403, JSON.stringify(releaseDenied.body));
    assert.strictEqual(releaseDenied.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // Cancel denied for a writer scoped to another plant.
    const cancelDenied = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/cancel`,
      { idempotency_key: randomUUID() },
      scopedWriterHeaders,
    );
    assert.strictEqual(cancelDenied.status, 403, JSON.stringify(cancelDenied.body));
    assert.strictEqual(cancelDenied.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // The order is untouched and still visible to the wildcard reader.
    await assertOrderStatus(orderId, 'planned');
    const control = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(control.status, 200, JSON.stringify(control.body));
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  it('concurrency: two parallel creations both succeed with distinct numbers (the sequence, never MAX+1)', async () => {
    const itemA = await createItem(`FG-${run}-conc-a`);
    const itemB = await createItem(`FG-${run}-conc-b`);
    const [resA, resB] = await Promise.all([
      createOrder({ output_item_id: itemA, bom_id: randomUUID() }),
      createOrder({ output_item_id: itemB, bom_id: randomUUID() }),
    ]);
    assert.strictEqual(resA.status, 201, JSON.stringify(resA.body));
    assert.strictEqual(resB.status, 201, JSON.stringify(resB.body));
    const numberA = resA.body['order_number_ext'] as string;
    const numberB = resB.body['order_number_ext'] as string;
    assert.notStrictEqual(numberA, numberB, 'parallel creations must allocate distinct numbers');
  });

  it('concurrency: two parallel releases of one order resolve to one success and one stable 400 INVALID_STATE_TRANSITION', async () => {
    const item = await createItem(`FG-${run}-conc-rel`);
    const itemC1 = await createItem(`C1-${run}-conc-rel`);
    const c1Sku = (
      await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [itemC1])
    ).rows[0]!['sku'] as string;
    const bom = await draftAndRelease(item, [componentLine(1, itemC1)]);
    await receiveStock(c1Sku, binLocId, 20);

    const order = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const [resA, resB] = await Promise.all([releaseOrder(orderId), releaseOrder(orderId)]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 400],
      `parallel releases must be one success and one stable rejection: ${JSON.stringify([resA.body, resB.body])}`,
    );
    const rejected = resA.status === 400 ? resA : resB;
    assert.strictEqual(rejected.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual(await domainEventCount(orderId, 'production_order.released'), 1);
    await assertOrderStatus(orderId, 'released');
  });

  // -------------------------------------------------------------------------
  // Read surface
  // -------------------------------------------------------------------------

  it('GET /api/v1/production-orders lists and filters the created orders', async () => {
    const { itemOut: item, bom } = await releasedSingleLineBom('list');
    const order = await createOrder({ output_item_id: item, bom_id: bom.bomId });
    const orderId = order.body['production_order_id'] as string;

    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders?status=planned&output_item_id=${item}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const orders = list.body['orders'] as Record<string, unknown>[];
    assert.ok(
      orders.some((o) => o['production_order_id'] === orderId),
      `the created order must appear in the filtered list: ${JSON.stringify(orders)}`,
    );

    const none = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders?status=closed',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(none.status, 200, JSON.stringify(none.body));
    const closedOrders = none.body['orders'] as Record<string, unknown>[];
    assert.ok(
      !closedOrders.some((o) => o['production_order_id'] === orderId),
      'a planned order must not appear in the closed filter',
    );

    // plant_location_id and business_stream filters include the order.
    const byPlant = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders?plant_location_id=${siteLocId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(byPlant.status, 200, JSON.stringify(byPlant.body));
    assert.ok(
      (byPlant.body['orders'] as Record<string, unknown>[]).some(
        (o) => o['production_order_id'] === orderId,
      ),
    );

    const byStream = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders?business_stream=production',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(byStream.status, 200, JSON.stringify(byStream.body));
    assert.ok(
      (byStream.body['orders'] as Record<string, unknown>[]).some(
        (o) => o['production_order_id'] === orderId,
      ),
    );

    // output_item_id negative: filtering by a different item excludes the order (proves the filter
    // is applied, not just the unfiltered superset).
    const otherItem = await createItem(`FG-${run}-list-other`);
    const otherFilter = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders?output_item_id=${otherItem}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(otherFilter.status, 200, JSON.stringify(otherFilter.body));
    assert.deepStrictEqual(otherFilter.body['orders'], []);

    // Pagination: limit=1 returns exactly one page entry and offset skips the first page.
    const page = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders?limit=1',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(page.status, 200, JSON.stringify(page.body));
    assert.strictEqual((page.body['orders'] as Record<string, unknown>[]).length, 1);
    const pageTwo = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders?limit=1&offset=1',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(pageTwo.status, 200, JSON.stringify(pageTwo.body));
    const firstId = (page.body['orders'] as Record<string, unknown>[])[0]!['production_order_id'];
    const secondId = (pageTwo.body['orders'] as Record<string, unknown>[])[0]?.[
      'production_order_id'
    ];
    assert.notStrictEqual(secondId, firstId, 'offset=1 must return a different first entry');

    // Malformed filters and pagination are rejected 400, not silently defaulted.
    const badPlant = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders?plant_location_id=not-a-uuid',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badPlant.status, 400, JSON.stringify(badPlant.body));
    assert.strictEqual(badPlant.body['error_code'], 'INVALID_PARAMS');
    const badLimit = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders?limit=0',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badLimit.status, 400, JSON.stringify(badLimit.body));
    assert.strictEqual(badLimit.body['error_code'], 'INVALID_PARAMS');
    const badOffset = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders?offset=-1',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badOffset.status, 400, JSON.stringify(badOffset.body));
    assert.strictEqual(badOffset.body['error_code'], 'INVALID_PARAMS');
  });
});

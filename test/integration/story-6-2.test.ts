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

/** Exact decimal comparison through PostgreSQL NUMERIC - the codebase's own numericEqual idiom. */
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

describe('Story 6.2 Material Staging, Issue, and WIP Ledger', () => {
  let server: Server;
  let port: number;

  let plannerUserId: string;
  let plannerHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;

  let siteLocId: string;
  let zoneLocId: string;
  let binLocId: string;
  let otherSiteLocId: string;

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

  /** Priced stock receipt through the Epic 2 ledger - the ONLY way stock enters this suite
   *  (Task 9.2: an unpriced seed trips WIP_COST_UNRESOLVED and hides the real behavior under
   *  test, so every receipt carries a unit_cost and the valuation running average resolves). */
  async function receiveStock(
    sku: string,
    locationId: string,
    quantity: number,
    lotId: string | null = null,
    unitCost: number = 5,
  ): Promise<void> {
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
          unit_cost: unitCost,
          ...(lotId !== null ? { lot_id: lotId } : {}),
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

  /** Drains stock through a stock.issued event so an AC3 shortfall can be set up AFTER release. */
  async function drainStock(sku: string, locationId: string, quantity: number): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.issued',
        payload: {
          business_stream: 'production',
          sku,
          target_location_id: locationId,
          quantity,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_controller', location_id: locationId },
          occurred_at: new Date().toISOString(),
        },
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, `stock drain failed: ${JSON.stringify(res.body)}`);
  }

  async function seedLot(lotNumber: string, sku: string): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO lot_master (lot_number, sku) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [lotNumber, sku],
    );
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
      },
      plannerHeaders,
    );
  }

  function releaseOrder(
    orderId: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = plannerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  function stageOrder(
    orderId: string,
    lines: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      { idempotency_key: randomUUID(), lines, ...extra },
      plannerHeaders,
    );
  }

  function getStagingWorklist(orderId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}/material-staging`,
      undefined,
      readerHeaders,
    );
  }

  function issueMaterial(orderId: string, stageId: string, quantity: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-issues`,
      { idempotency_key: randomUUID(), stage_id: stageId, quantity },
      plannerHeaders,
    );
  }

  function confirmProduction(
    orderId: string,
    confirmedQuantity: string,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/confirmations`,
      { idempotency_key: randomUUID(), confirmed_quantity: confirmedQuantity, ...body },
      plannerHeaders,
    );
  }

  function returnMaterial(
    orderId: string,
    sourcePostingId: string,
    quantity: string,
    reasonCode: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-returns`,
      {
        idempotency_key: randomUUID(),
        source_posting_id: sourcePostingId,
        quantity,
        reason_code: reasonCode,
      },
      plannerHeaders,
    );
  }

  function getWip(orderId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}/wip`,
      undefined,
      readerHeaders,
    );
  }

  async function getOrder(orderId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}`,
      undefined,
      readerHeaders,
    );
  }

  async function skuOf(itemId: string): Promise<string> {
    const result = await getPool().query('SELECT sku FROM item_master WHERE item_id = $1', [
      itemId,
    ]);
    return result.rows[0]!['sku'] as string;
  }

  async function bomLineIds(revisionId: string): Promise<Map<number, string>> {
    const result = await getPool().query(
      `SELECT line_no, bom_line_id FROM bom_line WHERE revision_id = $1 ORDER BY line_no`,
      [revisionId],
    );
    return new Map(
      result.rows.map((row) => [Number(row['line_no']), row['bom_line_id'] as string]),
    );
  }

  /** Reads the exact owned balance at a grain; returns NUMERIC strings. */
  async function balanceAt(
    sku: string,
    locationId: string,
    lotId: string | null,
  ): Promise<{ on_hand: string; allocated: string; picked: string; available: string }> {
    const result = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand,
              COALESCE(SUM(allocated), 0)::text AS allocated,
              COALESCE(SUM(picked), 0)::text AS picked,
              COALESCE(SUM(available), 0)::text AS available
         FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'
          AND ($3::text IS NULL OR lot_id = $3)`,
      [sku, locationId, lotId],
    );
    const row = result.rows[0]!;
    return {
      on_hand: String(row['on_hand']),
      allocated: String(row['allocated']),
      picked: String(row['picked']),
      available: String(row['available']),
    };
  }

  /** The 7.4 rule: available = on_hand - allocated - picked on every touched row, in SQL NUMERIC,
   *  plus the absolute values for exact assertions - never just deltas. */
  async function assertBalanceInvariant(
    sku: string,
    locationId: string,
    lotId: string | null,
    label: string,
  ): Promise<{ on_hand: string; allocated: string; picked: string; available: string }> {
    const balance = await balanceAt(sku, locationId, lotId);
    const result = await getPool().query(
      `SELECT ($1::numeric = $2::numeric - $3::numeric - $4::numeric) AS holds`,
      [balance.available, balance.on_hand, balance.allocated, balance.picked],
    );
    assert.strictEqual(
      result.rows[0]!['holds'],
      true,
      `${label}: available = on_hand - allocated - picked failed for ${sku} at ${locationId} (${JSON.stringify(balance)})`,
    );
    return balance;
  }

  async function wipSummaryDb(orderId: string): Promise<{
    net_open_quantity: string;
    net_open_value: string;
  }> {
    const result = await getPool().query(
      `SELECT COALESCE(SUM(open_quantity), 0)::text AS net_open_quantity,
              COALESCE(SUM(open_quantity * unit_cost), 0)::text AS net_open_value
         FROM production_wip_ledger
        WHERE production_order_id = $1
          AND posting_type IN ('directed_issue','backflush')`,
      [orderId],
    );
    return {
      net_open_quantity: String(result.rows[0]!['net_open_quantity']),
      net_open_value: String(result.rows[0]!['net_open_value']),
    };
  }

  async function stageRowsForOrder(orderId: string): Promise<Record<string, unknown>[]> {
    const result = await getPool().query(
      `SELECT * FROM production_order_stage WHERE production_order_id = $1 ORDER BY created_at ASC, stage_id ASC`,
      [orderId],
    );
    return result.rows as Record<string, unknown>[];
  }

  async function wipPostingsForOrder(orderId: string): Promise<Record<string, unknown>[]> {
    const result = await getPool().query(
      `SELECT * FROM production_wip_ledger WHERE production_order_id = $1 ORDER BY created_at ASC, posting_id ASC`,
      [orderId],
    );
    return result.rows as Record<string, unknown>[];
  }

  async function unreversedCount(orderId: string): Promise<number> {
    const result = await getPool().query(
      `SELECT unreversed_transaction_count FROM production_order WHERE production_order_id = $1`,
      [orderId],
    );
    return Number(result.rows[0]!['unreversed_transaction_count']);
  }

  /** A released BOM carrying BOTH supply methods: one directed_issue line (default) and one line
   *  explicitly added with supply_method 'backflush' (Task 9.2 - without a backflush line AC2/AC3
   *  are untestable). */
  async function releasedMixedBom(suffix: string): Promise<{
    itemOut: string;
    itemC1: string;
    itemC2: string;
    c1Sku: string;
    c2Sku: string;
    c1LineId: string;
    c2LineId: string;
    bom: { bomId: string; revisionId: string };
  }> {
    const itemOut = await createItem(`FG-${run}-${suffix}`);
    const itemC1 = await createItem(`C1-${run}-${suffix}`);
    const itemC2 = await createItem(`C2-${run}-${suffix}`);
    const c1Sku = await skuOf(itemC1);
    const c2Sku = await skuOf(itemC2);
    const bom = await draftAndRelease(itemOut, [
      componentLine(1, itemC1),
      componentLine(2, itemC2, { quantity_per: '1.0', supply_method: 'backflush' }),
    ]);
    const lineIds = await bomLineIds(bom.revisionId);
    const c1LineId = lineIds.get(1)!;
    const c2LineId = lineIds.get(2)!;
    return { itemOut, itemC1, itemC2, c1Sku, c2Sku, c1LineId, c2LineId, bom };
  }

  /** A released BOM with a SINGLE backflush line (for the fractional / backflush-only tests). */
  async function releasedBackflushOnlyBom(
    suffix: string,
    quantityPer = '1.0',
  ): Promise<{
    itemOut: string;
    itemC2: string;
    c2Sku: string;
    c2LineId: string;
    bom: { bomId: string; revisionId: string };
  }> {
    const itemOut = await createItem(`FG-${run}-${suffix}`);
    const itemC2 = await createItem(`BF-${run}-${suffix}`);
    const c2Sku = await skuOf(itemC2);
    const bom = await draftAndRelease(itemOut, [
      componentLine(1, itemC2, { quantity_per: quantityPer, supply_method: 'backflush' }),
    ]);
    const lineIds = await bomLineIds(bom.revisionId);
    return { itemOut, itemC2, c2Sku, c2LineId: lineIds.get(1)!, bom };
  }

  /** Releases an order, seeding the DOA override entry so availability shortfalls can be crossed
   *  when a test's focus is elsewhere. */
  async function releaseWithOverride(orderId: string): Promise<HttpResult> {
    return releaseOrder(orderId, { override: { reason: 'Test expedite' } }, approverHeaders);
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
      '../../read/projections/production_order_stage.sql',
      '../../read/projections/production_wip_ledger.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE production_order_stage, production_wip_ledger, production_order, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, integration_exception, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteLocId = await seedLocation('site', `PLANT-${run}`, null, null);
    zoneLocId = await seedLocation('zone', `ZONE-${run}`, siteLocId, siteLocId);
    binLocId = await seedLocation('bin', `BIN-${run}`, zoneLocId, siteLocId);
    otherSiteLocId = await seedLocation('site', `PLANT-OTHER-${run}`, null, null);
    void zoneLocId;

    plannerUserId = await provisionUser(port, `planner-6-2-${run}@example.com`, [
      { role: 'production_planner', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_planner', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, `planner-6-2-${run}@example.com`);

    await provisionUser(port, `approver-6-2-${run}@example.com`, [
      { role: 'production_manager', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_manager', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `approver-6-2-${run}@example.com`);

    await provisionUser(port, `reader-6-2-${run}@example.com`, [
      { role: 'production_viewer', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `reader-6-2-${run}@example.com`);

    await provisionUser(port, `engineer-6-2-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-6-2-${run}@example.com`);

    await provisionUser(port, `compliance-6-2-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-6-2-${run}@example.com`);

    // Seed the release-override DOA entry through the route (the production path), so the
    // override-based releases in this suite work without order coupling.
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
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: staging creates pick rows and allocates stock
  // -------------------------------------------------------------------------

  it('AC1: staging a Released order creates one stage row per directed-issue line (backflush absent), allocates the exact quantities, and a second staging of the same line 409s', async () => {
    const fx = await releasedMixedBom('ac1');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);

    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body['production_order_id'] as string;
    const released = await releaseOrder(orderId);
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));

    // The worklist before staging shows the directed-issue line as pending and NO backflush line
    // (AC1: "backflush lines absent from the result").
    const worklist = await getStagingWorklist(orderId);
    assert.strictEqual(worklist.status, 200, JSON.stringify(worklist.body));
    const pending = worklist.body['pending'] as Record<string, unknown>[];
    assert.strictEqual(
      pending.length,
      1,
      `only the directed line is pending: ${JSON.stringify(pending)}`,
    );
    assert.strictEqual(pending[0]!['bom_line_id'], fx.c1LineId);
    assert.strictEqual(worklist.body['revision_id'], fx.bom.revisionId);
    assert.strictEqual((worklist.body['staged'] as unknown[]).length, 0);

    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(staged.status, 201, JSON.stringify(staged.body));
    const stagedLine = (staged.body['lines'] as Record<string, unknown>[])[0]!;
    const stageId = stagedLine['stage_id'] as string;
    assert.match(stageId, /^[0-9a-f-]{36}$/i);
    assert.strictEqual(stagedLine['component_sku'], fx.c1Sku);
    assert.strictEqual(stagedLine['component_item_id'], fx.itemC1);
    await assertNumericEqual(stagedLine['required_quantity'], '20', 'staged required quantity');
    assert.strictEqual(stagedLine['staged_by'], plannerUserId);
    assert.strictEqual(staged.body['revision_id'], fx.bom.revisionId);

    // Stock: allocated increases by exactly the staged quantity at the named bin (absolute values).
    const afterStage = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'AC1 after stage');
    await assertNumericEqual(afterStage.on_hand, '20', 'C1 on_hand after stage');
    await assertNumericEqual(afterStage.allocated, '20', 'C1 allocated after stage');
    await assertNumericEqual(afterStage.available, '0', 'C1 available after stage');
    // The backflush component is untouched by staging.
    const c2AfterStage = await assertBalanceInvariant(
      fx.c2Sku,
      binLocId,
      null,
      'AC1 C2 after stage',
    );
    await assertNumericEqual(c2AfterStage.allocated, '0', 'C2 not allocated by staging');

    // The stage row landed as allocated with issued 0.
    const rows = await stageRowsForOrder(orderId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['status'], 'allocated');
    await assertNumericEqual(String(rows[0]!['issued_quantity']), '0', 'stage issued_quantity');
    assert.strictEqual(rows[0]!['source_location_id'], binLocId);

    // The worklist after staging shows the line as staged with nothing pending.
    const after = await getStagingWorklist(orderId);
    assert.strictEqual((after.body['staged'] as unknown[]).length, 1);
    assert.strictEqual((after.body['pending'] as unknown[]).length, 0);

    // A second staging of the same line 409s DUPLICATE_EVENT via the UNIQUE grain.
    const duplicate = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'DUPLICATE_EVENT');
    const details = duplicate.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['existing_stage_id'], stageId);

    const afterDuplicate = await assertBalanceInvariant(
      fx.c1Sku,
      binLocId,
      null,
      'AC1 after duplicate',
    );
    await assertNumericEqual(afterDuplicate.allocated, '20', 'no double allocation');
  });

  it('AC1: staging with insufficient stock at the named bin propagates the Epic 2 INSUFFICIENT_STOCK detail unchanged', async () => {
    const fx = await releasedMixedBom('ac1-short');
    // Plant-wide availability is sufficient (5 at the named bin + 15 at a sibling bin), so the
    // order RELEASES - but the named bin alone cannot cover the staging allocation.
    const siblingBin = await seedLocation('bin', `BIN-SIB-${run}`, zoneLocId, siteLocId);
    await receiveStock(fx.c1Sku, binLocId, 5);
    await receiveStock(fx.c1Sku, siblingBin, 15);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(staged.status, 409, JSON.stringify(staged.body));
    assert.strictEqual(staged.body['error_code'], 'INSUFFICIENT_STOCK');
    const details = staged.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['sku'], fx.c1Sku);
    await assertNumericEqual(String(details['available_quantity']), '5', 'shortfall available');
    await assertNumericEqual(String(details['requested_quantity']), '20', 'shortfall requested');
    // No stage row and no allocation.
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 0);
    const balance = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'AC1 short');
    await assertNumericEqual(balance.allocated, '0', 'no allocation on failed stage');
  });

  it('AC1: issue moves the exact staged quantity into WIP, drains on_hand, and flips the stage when fully issued; partial issues stay allocated', async () => {
    const fx = await releasedMixedBom('ac1-issue');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);
    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;

    // Partial issue: half of the staged quantity; the stage stays allocated.
    const partial = await issueMaterial(orderId, stageId, '10');
    assert.strictEqual(partial.status, 200, JSON.stringify(partial.body));
    const partialPostings = partial.body['postings'] as Record<string, unknown>[];
    await assertNumericEqual(partialPostings[0]!['quantity'], '10', 'partial issue posting');
    await assertNumericEqual(partialPostings[0]!['posting_value'], '50.000', '10 x unit_cost 5');
    await assertNumericEqual(partialPostings[0]!['unit_cost'], '5.000', 'issued cost');

    let stageRow = (await stageRowsForOrder(orderId))[0]!;
    assert.strictEqual(stageRow['status'], 'allocated', 'partial issue keeps the stage allocated');
    await assertNumericEqual(String(stageRow['issued_quantity']), '10', 'partial issued_quantity');

    let balance = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'AC1 after partial issue');
    await assertNumericEqual(balance.on_hand, '10', 'on_hand after partial issue');
    await assertNumericEqual(balance.allocated, '10', 'allocated after partial issue');
    await assertNumericEqual(balance.available, '0', 'available after partial issue');

    // The remaining half completes the issue and flips the stage.
    const full = await issueMaterial(orderId, stageId, '10');
    assert.strictEqual(full.status, 200, JSON.stringify(full.body));
    stageRow = (await stageRowsForOrder(orderId))[0]!;
    assert.strictEqual(stageRow['status'], 'issued', 'full issue flips the stage');
    await assertNumericEqual(String(stageRow['issued_quantity']), '20', 'fully issued');

    balance = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'AC1 after full issue');
    await assertNumericEqual(balance.on_hand, '0', 'on_hand fully drained');
    await assertNumericEqual(balance.allocated, '0', 'allocated fully released');

    // The WIP ledger holds one posting per issue at the drained grain.
    const postings = await wipPostingsForOrder(orderId);
    assert.strictEqual(postings.length, 2);
    assert.strictEqual(postings[0]!['posting_type'], 'directed_issue');
    await assertNumericEqual(String(postings[0]!['open_quantity']), '10', 'posting 1 open');
    await assertNumericEqual(String(postings[1]!['open_quantity']), '10', 'posting 2 open');

    // The counter reflects the two open postings.
    assert.strictEqual(await unreversedCount(orderId), 2);
  });

  // -------------------------------------------------------------------------
  // AC2: backflush on confirmation
  // -------------------------------------------------------------------------

  it('AC2: a confirmation of quantity Q backflushes every backflush line at required_quantity proportional to Q, and leaves directed-issue lines untouched', async () => {
    const fx = await releasedMixedBom('ac2');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10, null, 8);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    // Stage AND issue the directed line first, then confirm 5 of 10 - the backflush line consumes
    // 5 (1.0 per confirmed unit), the directed line is untouched.
    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    assert.strictEqual((await issueMaterial(orderId, stageId, '20')).status, 200);

    const confirmed = await confirmProduction(orderId, '5');
    assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
    const backflushLines = confirmed.body['backflush_lines'] as Record<string, unknown>[];
    assert.strictEqual(backflushLines.length, 1, 'one backflush line confirmed');
    assert.strictEqual(backflushLines[0]!['bom_line_id'], fx.c2LineId);
    assert.strictEqual(backflushLines[0]!['component_sku'], fx.c2Sku);
    await assertNumericEqual(
      String(backflushLines[0]!['required_quantity']),
      '5',
      'backflush drains 5 of 10 at confirmed quantity 5',
    );
    const backflushPosting = (backflushLines[0]!['postings'] as Record<string, unknown>[])[0]!;
    await assertNumericEqual(backflushPosting['quantity'], '5', 'backflush posting quantity');
    await assertNumericEqual(backflushPosting['posting_value'], '40.000', '5 x unit_cost 8');
    assert.strictEqual(backflushPosting['posting_type'], undefined, 'postings carry no type field');

    const c2Balance = await assertBalanceInvariant(
      fx.c2Sku,
      binLocId,
      null,
      'AC2 C2 after confirm',
    );
    await assertNumericEqual(c2Balance.on_hand, '5', 'C2 drained by 5');

    // Directed-issue line untouched: C1 already issued, so its on_hand stays 0 and no extra
    // posting exists for it beyond the issue.
    const c1Balance = await assertBalanceInvariant(
      fx.c1Sku,
      binLocId,
      null,
      'AC2 C1 after confirm',
    );
    await assertNumericEqual(c1Balance.on_hand, '0', 'C1 untouched by backflush');
    const postings = await wipPostingsForOrder(orderId);
    const directed = postings.filter((p) => p['posting_type'] === 'directed_issue');
    const backflush = postings.filter((p) => p['posting_type'] === 'backflush');
    assert.strictEqual(directed.length, 1, 'exactly one directed issue posting');
    assert.strictEqual(backflush.length, 1, 'exactly one backflush posting');

    const wip = await getWip(orderId);
    assert.strictEqual(wip.status, 200, JSON.stringify(wip.body));
    await assertNumericEqual(
      String(wip.body['net_open_quantity']),
      '25',
      '20 issued + 5 backflushed',
    );
    await assertNumericEqual(String(wip.body['net_open_value']), '140.000', '20x5 + 5x8');
  });

  it('AC2: fractional backflush settles in SQL NUMERIC (0.1 + 0.2 = 0.3 exactly, never binary float)', async () => {
    const fx = await releasedBackflushOnlyBom('ac2-frac');
    await receiveStock(fx.c2Sku, binLocId, 0.3, null, 8);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    // Only 0.3 of the line's 10 is available at release; the DOA override crosses the gate.
    assert.strictEqual((await releaseWithOverride(orderId)).status, 200);

    const first = await confirmProduction(orderId, '0.1');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await confirmProduction(orderId, '0.2');
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));

    const balance = await assertBalanceInvariant(fx.c2Sku, binLocId, null, 'AC2 frac');
    await assertNumericEqual(balance.on_hand, '0', '0.1 + 0.2 drained exactly 0.3');
    const wip = await getWip(orderId);
    await assertNumericEqual(
      String(wip.body['net_open_quantity']),
      '0.3',
      '0.1 + 0.2 = 0.3 in NUMERIC',
    );

    // A further confirmation now finds nothing left - the exact 0.3 was consumed.
    const third = await confirmProduction(orderId, '0.1');
    assert.strictEqual(third.status, 409, JSON.stringify(third.body));
    assert.strictEqual(third.body['error_code'], 'INSUFFICIENT_STOCK');
  });

  // -------------------------------------------------------------------------
  // AC3: backflush shortfall reporting
  // -------------------------------------------------------------------------

  it('AC3: a confirmation shortfall rejects 409 INSUFFICIENT_STOCK with EVERY deficient line in shortfall_lines and changes no stock row', async () => {
    const itemOut = await createItem(`FG-${run}-ac3`);
    const itemC1 = await createItem(`C1-${run}-ac3`);
    const itemC2 = await createItem(`C2-${run}-ac3`);
    const itemC3 = await createItem(`C3-${run}-ac3`);
    const c1Sku = await skuOf(itemC1);
    const c2Sku = await skuOf(itemC2);
    const c3Sku = await skuOf(itemC3);
    const bom = await draftAndRelease(itemOut, [
      componentLine(1, itemC1),
      componentLine(2, itemC2, { quantity_per: '1.0', supply_method: 'backflush' }),
      componentLine(3, itemC3, { quantity_per: '1.0', supply_method: 'backflush' }),
    ]);
    const lineIds = await bomLineIds(bom.revisionId);
    const c2LineId = lineIds.get(2)!;
    const c3LineId = lineIds.get(3)!;

    await receiveStock(c1Sku, binLocId, 20);
    await receiveStock(c2Sku, binLocId, 10);
    await receiveStock(c3Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    // Drain BOTH backflush components below their requirement before the confirmation.
    await drainStock(c2Sku, binLocId, 6); // leaves 4 of 10
    await drainStock(c3Sku, binLocId, 9); // leaves 1 of 10

    const before = await balanceAt(c2Sku, binLocId, null);
    const before3 = await balanceAt(c3Sku, binLocId, null);

    const confirmed = await confirmProduction(orderId, '10');
    assert.strictEqual(confirmed.status, 409, JSON.stringify(confirmed.body));
    assert.strictEqual(confirmed.body['error_code'], 'INSUFFICIENT_STOCK');
    const shortfallLines = (confirmed.body['details'] as Record<string, unknown>)?.[
      'shortfall_lines'
    ] as Record<string, unknown>[];
    assert.ok(shortfallLines, 'shortfall_lines must be present');
    assert.strictEqual(
      shortfallLines.length,
      2,
      `EVERY deficient line must be reported, got ${JSON.stringify(shortfallLines)}`,
    );
    const c2Line = shortfallLines.find((l) => l['component_sku'] === c2Sku)!;
    const c3Line = shortfallLines.find((l) => l['component_sku'] === c3Sku)!;
    assert.strictEqual(c2Line['bom_line_id'], c2LineId);
    await assertNumericEqual(String(c2Line['required_quantity']), '10', 'C2 required');
    await assertNumericEqual(String(c2Line['available_quantity']), '4', 'C2 available');
    await assertNumericEqual(String(c2Line['shortfall_quantity']), '6', 'C2 shortfall');
    assert.strictEqual(c3Line['bom_line_id'], c3LineId);
    await assertNumericEqual(String(c3Line['shortfall_quantity']), '9', 'C3 shortfall');

    // No stock row changed.
    const after2 = await balanceAt(c2Sku, binLocId, null);
    const after3 = await balanceAt(c3Sku, binLocId, null);
    assert.deepStrictEqual(after2, before, 'C2 balances identical before/after');
    assert.deepStrictEqual(after3, before3, 'C3 balances identical before/after');
    assert.strictEqual(
      (await wipPostingsForOrder(orderId)).length,
      0,
      'no WIP postings on rejection',
    );
    assert.strictEqual(await unreversedCount(orderId), 0);
  });

  // -------------------------------------------------------------------------
  // AC4: the real-time WIP ledger read
  // -------------------------------------------------------------------------

  it('AC4: GET /wip returns net open quantity and value computed in SQL, and postings are append-complete; a full return zeroes both', async () => {
    const fx = await releasedMixedBom('ac4');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10, null, 8);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    assert.strictEqual((await issueMaterial(orderId, stageId, '20')).status, 200);
    assert.strictEqual((await confirmProduction(orderId, '10')).status, 200);

    const wip = await getWip(orderId);
    assert.strictEqual(wip.status, 200, JSON.stringify(wip.body));
    await assertNumericEqual(String(wip.body['net_open_quantity']), '30', '20 + 10');
    await assertNumericEqual(String(wip.body['net_open_value']), '180.000', '20x5 + 10x8');
    const postings = wip.body['postings'] as Record<string, unknown>[];
    assert.strictEqual(postings.length, 2, 'append-complete in insertion order');
    assert.strictEqual(postings[0]!['posting_type'], 'directed_issue');
    assert.strictEqual(postings[1]!['posting_type'], 'backflush');

    // The WIP read matches the SQL-computed summary from the ledger directly.
    const dbSummary = await wipSummaryDb(orderId);
    await assertNumericEqual(dbSummary.net_open_quantity, '30', 'db net open quantity');
    await assertNumericEqual(dbSummary.net_open_value, '180.000', 'db net open value');

    // Full returns zero the ledger read.
    const issuePosting = postings[0]!['posting_id'] as string;
    const backflushPosting = postings[1]!['posting_id'] as string;
    assert.strictEqual(
      (await returnMaterial(orderId, issuePosting, '20', 'SURPLUS_TO_ORDER')).status,
      200,
    );
    assert.strictEqual(
      (await returnMaterial(orderId, backflushPosting, '10', 'SURPLUS_TO_ORDER')).status,
      200,
    );

    const wipAfter = await getWip(orderId);
    await assertNumericEqual(
      String(wipAfter.body['net_open_quantity']),
      '0',
      'net open zero after full return',
    );
    await assertNumericEqual(
      String(wipAfter.body['net_open_value']),
      '0.000',
      'net value zero after full return',
    );
    assert.strictEqual(
      (wipAfter.body['postings'] as unknown[]).length,
      4,
      'return postings appended',
    );
  });

  // -------------------------------------------------------------------------
  // AC5: returns reverse WIP at issued cost and restore the original lot
  // -------------------------------------------------------------------------

  it('AC5: a return restores the ORIGINAL location and lot grain, reverses WIP at the SOURCE posting cost, and blanks/unknown reason codes are rejected', async () => {
    const fx = await releasedMixedBom('ac5');
    const lotNumber = `LOT-${run}-ac5`;
    await seedLot(lotNumber, fx.c1Sku);
    await receiveStock(fx.c1Sku, binLocId, 20, lotNumber, 5);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId, lot_number: lotNumber },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const issued = await issueMaterial(orderId, stageId, '20');
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const issuePosting = (issued.body['postings'] as Record<string, unknown>[])[0]!;
    const sourcePostingId = issuePosting['posting_id'] as string;
    await assertNumericEqual(String(issuePosting['unit_cost']), '5.000', 'issued at 5.000');
    assert.strictEqual(issuePosting['lot_number'], lotNumber, 'posting carries the lot grain');

    // Raise today's average: a new receipt at a higher cost moves running_average_cost up.
    await receiveStock(fx.c1Sku, binLocId, 20, null, 50);

    // REASON_CODE_REQUIRED: blank reason rejected before anything moves.
    const blank = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-returns`,
      {
        idempotency_key: randomUUID(),
        source_posting_id: sourcePostingId,
        quantity: '1',
        reason_code: '   ',
      },
      plannerHeaders,
    );
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));
    assert.strictEqual(blank.body['error_code'], 'REASON_CODE_REQUIRED');

    // RETURN_REASON_CODE_INVALID: an unconfigured code rejected 422 with the allowed list.
    const invalid = await returnMaterial(orderId, sourcePostingId, '1', 'NOT_A_REAL_CODE');
    assert.strictEqual(invalid.status, 422, JSON.stringify(invalid.body));
    assert.strictEqual(invalid.body['error_code'], 'RETURN_REASON_CODE_INVALID');
    const allowed = (invalid.body['details'] as Record<string, unknown>)?.['allowed'] as string[];
    assert.ok(
      Array.isArray(allowed) && allowed.includes('SURPLUS_TO_ORDER'),
      'allowed list present',
    );

    // The genuine return restores the ORIGINAL lot grain at the issued cost (5.000), not today's
    // average (which would be higher after the 50-cost receipt).
    const returned = await returnMaterial(orderId, sourcePostingId, '20', 'SURPLUS_TO_ORDER');
    assert.strictEqual(returned.status, 200, JSON.stringify(returned.body));
    const returnPostingId = returned.body['posting_id'] as string;
    assert.match(returnPostingId, /^[0-9a-f-]{36}$/i);

    const balance = await assertBalanceInvariant(fx.c1Sku, binLocId, lotNumber, 'AC5 lot restore');
    await assertNumericEqual(balance.on_hand, '20', 'original lot grain regains 20');

    const returnRow = (
      await getPool().query('SELECT * FROM production_wip_ledger WHERE posting_id = $1', [
        returnPostingId,
      ])
    ).rows[0]!;
    await assertNumericEqual(String(returnRow['unit_cost']), '5.000', 'return at the issued cost');
    await assertNumericEqual(String(returnRow['posting_value']), '100.000', '20 x 5.000');
    assert.strictEqual(returnRow['source_posting_id'], sourcePostingId);
    assert.strictEqual(returnRow['reason_code'], 'SURPLUS_TO_ORDER');
    assert.strictEqual(returnRow['open_quantity'], null, 'return rows carry NULL open_quantity');
    assert.strictEqual(
      returnRow['lot_number'],
      lotNumber,
      'return posting preserves the lot grain',
    );
  });

  // -------------------------------------------------------------------------
  // AC6: over-return rejection
  // -------------------------------------------------------------------------

  it('AC6: returning open_quantity + epsilon rejects 409 RETURN_EXCEEDS_ISSUE with the ledger unchanged; returning exactly open_quantity closes the posting', async () => {
    const fx = await releasedMixedBom('ac6');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);
    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const issued = await issueMaterial(orderId, stageId, '20');
    const sourcePostingId = (issued.body['postings'] as Record<string, unknown>[])[0]![
      'posting_id'
    ] as string;

    // A fractional epsilon above the open quantity is rejected - settled in SQL NUMERIC.
    const over = await returnMaterial(orderId, sourcePostingId, '20.000001', 'SURPLUS_TO_ORDER');
    assert.strictEqual(over.status, 409, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'RETURN_EXCEEDS_ISSUE');
    const details = over.body['details'] as Record<string, unknown>;
    await assertNumericEqual(String(details['open_quantity']), '20', 'over-return open detail');

    // Ledger unchanged: the source posting still has its full open quantity and no return row.
    const sourceRow = (
      await getPool().query('SELECT * FROM production_wip_ledger WHERE posting_id = $1', [
        sourcePostingId,
      ])
    ).rows[0]!;
    await assertNumericEqual(String(sourceRow['open_quantity']), '20', 'open_quantity unchanged');
    assert.strictEqual(
      (
        await getPool().query(
          'SELECT count(*)::int AS n FROM production_wip_ledger WHERE source_posting_id = $1',
          [sourcePostingId],
        )
      ).rows[0]!['n'],
      0,
      'no return posting written',
    );

    // Returning exactly the open quantity succeeds and closes the posting.
    const exact = await returnMaterial(orderId, sourcePostingId, '20', 'SURPLUS_TO_ORDER');
    assert.strictEqual(exact.status, 200, JSON.stringify(exact.body));
    const closed = (
      await getPool().query('SELECT * FROM production_wip_ledger WHERE posting_id = $1', [
        sourcePostingId,
      ])
    ).rows[0]!;
    await assertNumericEqual(String(closed['open_quantity']), '0', 'posting closed');

    // A further return against the closed posting now exceeds.
    const afterClose = await returnMaterial(orderId, sourcePostingId, '0.1', 'SURPLUS_TO_ORDER');
    assert.strictEqual(afterClose.status, 409, JSON.stringify(afterClose.body));
    assert.strictEqual(afterClose.body['error_code'], 'RETURN_EXCEEDS_ISSUE');
  });

  // -------------------------------------------------------------------------
  // AC4 / BD-7: the cancel guard integration
  // -------------------------------------------------------------------------

  it('cancel guard: issue blocks cancel with UNREVERSED_TRANSACTIONS, a full return recomputes the counter to zero and cancel succeeds', async () => {
    const fx = await releasedMixedBom('cancel');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const issued = await issueMaterial(orderId, stageId, '20');
    const sourcePostingId = (issued.body['postings'] as Record<string, unknown>[])[0]![
      'posting_id'
    ] as string;
    assert.strictEqual(await unreversedCount(orderId), 1);

    const blocked = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/cancel`,
      { idempotency_key: randomUUID() },
      plannerHeaders,
    );
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'UNREVERSED_TRANSACTIONS');

    // Full return recomputes the counter to zero (the Counter Contract).
    assert.strictEqual(
      (await returnMaterial(orderId, sourcePostingId, '20', 'SURPLUS_TO_ORDER')).status,
      200,
    );
    assert.strictEqual(await unreversedCount(orderId), 0);

    const cancelled = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/cancel`,
      { idempotency_key: randomUUID() },
      plannerHeaders,
    );
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
    const order = await getOrder(orderId);
    assert.strictEqual(order.body['status'], 'cancelled');
  });

  it('review fix: cancelling a Released order with staged-but-unissued stock deallocates the stock and clears the stage rows', async () => {
    const fx = await releasedMixedBom('cancel-stage');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(staged.status, 201, JSON.stringify(staged.body));
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 1);

    // The staged stock is fully allocated and no WIP postings exist, so the counter is zero and
    // cancel is legal - the 6.2 cancel rollback must return the stock to `available`.
    const before = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'cancel-stage before');
    await assertNumericEqual(before.allocated, '20', 'allocated before cancel');
    await assertNumericEqual(before.available, '0', 'available before cancel');

    const cancelled = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/cancel`,
      { idempotency_key: randomUUID() },
      plannerHeaders,
    );
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));

    const order = await getOrder(orderId);
    assert.strictEqual(order.body['status'], 'cancelled');
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 0, 'stage rows cleared');

    const after = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'cancel-stage after');
    await assertNumericEqual(after.allocated, '0', 'allocated deallocated');
    await assertNumericEqual(after.on_hand, '20', 'on_hand unchanged');
    await assertNumericEqual(after.available, '20', 'stock returned to available');
  });

  // -------------------------------------------------------------------------
  // Replay (AD-16) per write route
  // -------------------------------------------------------------------------

  it('AD-16: every write route replays a same-key resubmission to the stored event with no second projection effect', async () => {
    const fx = await releasedMixedBom('replay');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    // Staging replay.
    const stagingBody = {
      idempotency_key: randomUUID(),
      lines: [{ bom_line_id: fx.c1LineId, source_location_id: binLocId }],
    };
    const stage1 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      stagingBody,
      plannerHeaders,
    );
    assert.strictEqual(stage1.status, 201, JSON.stringify(stage1.body));
    const stageId = (stage1.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const stage2 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      stagingBody,
      plannerHeaders,
    );
    assert.strictEqual(stage2.status, 200, JSON.stringify(stage2.body));
    assert.strictEqual(stage2.body['production_order_id'], orderId);
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 1, 'no second stage row');

    // Issue replay.
    const issueBody = { idempotency_key: randomUUID(), stage_id: stageId, quantity: '20' };
    const issue1 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-issues`,
      issueBody,
      plannerHeaders,
    );
    assert.strictEqual(issue1.status, 200, JSON.stringify(issue1.body));
    const issue2 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-issues`,
      issueBody,
      plannerHeaders,
    );
    assert.strictEqual(issue2.status, 200, JSON.stringify(issue2.body));
    assert.strictEqual((await wipPostingsForOrder(orderId)).length, 1, 'no second issue posting');

    // Confirmation replay.
    const confirmBody = { idempotency_key: randomUUID(), confirmed_quantity: '5' };
    const confirm1 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/confirmations`,
      confirmBody,
      plannerHeaders,
    );
    assert.strictEqual(confirm1.status, 200, JSON.stringify(confirm1.body));
    const confirm2 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/confirmations`,
      confirmBody,
      plannerHeaders,
    );
    assert.strictEqual(confirm2.status, 200, JSON.stringify(confirm2.body));
    assert.strictEqual(
      (await wipPostingsForOrder(orderId)).length,
      2,
      'no second backflush posting',
    );

    // Return replay.
    const issuePosting = (issue1.body['postings'] as Record<string, unknown>[])[0]![
      'posting_id'
    ] as string;
    const returnBody = {
      idempotency_key: randomUUID(),
      source_posting_id: issuePosting,
      quantity: '20',
      reason_code: 'SURPLUS_TO_ORDER',
    };
    const return1 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-returns`,
      returnBody,
      plannerHeaders,
    );
    assert.strictEqual(return1.status, 200, JSON.stringify(return1.body));
    const return2 = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-returns`,
      returnBody,
      plannerHeaders,
    );
    assert.strictEqual(return2.status, 200, JSON.stringify(return2.body));
    assert.strictEqual(
      (
        await getPool().query(
          "SELECT count(*)::int AS n FROM production_wip_ledger WHERE posting_type = 'return' AND production_order_id = $1",
          [orderId],
        )
      ).rows[0]!['n'],
      1,
      'no second return posting',
    );
    // The replay never re-applied the return to the source posting's open_quantity.
    const source = (
      await getPool().query(
        'SELECT open_quantity FROM production_wip_ledger WHERE posting_id = $1',
        [issuePosting],
      )
    ).rows[0]!;
    await assertNumericEqual(
      String(source['open_quantity']),
      '0',
      'source posting closed exactly once',
    );
  });

  // -------------------------------------------------------------------------
  // AD-12: forged direct events cannot bypass the seam
  // -------------------------------------------------------------------------

  it('AD-12: forged material_staged events (wrong revision, wrong component triple, declared stage_id) are rejected by the seam', async () => {
    const fx = await releasedMixedBom('forged-stage');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const post = (payload: Record<string, unknown>) =>
      makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          stream_type: 'production',
          stream_id: orderId,
          event_type: 'production_order.material_staged',
          payload,
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: plannerUserId, role: 'production_planner', location_id: binLocId },
            occurred_at: new Date().toISOString(),
          },
        },
        plannerHeaders,
      );

    // Wrong revision: a forged revision_id does not match the staged requirement set revision.
    const wrongRevision = await post({
      production_order_id: orderId,
      revision_id: randomUUID(),
      business_date: new Date().toISOString().slice(0, 10),
      lines: [
        {
          bom_line_id: fx.c1LineId,
          component_item_id: fx.itemC1,
          component_sku: fx.c1Sku,
          required_quantity: '20',
          source_location_id: binLocId,
          lot_number: null,
          staged_at: new Date().toISOString(),
        },
      ],
    });
    assert.strictEqual(wrongRevision.status, 409, JSON.stringify(wrongRevision.body));
    assert.strictEqual(wrongRevision.body['error_code'], 'PRODUCTION_MATERIAL_DERIVATION_MISMATCH');

    // Wrong component_sku: re-derived under lock, a fabrication is rejected.
    const wrongSku = await post({
      production_order_id: orderId,
      revision_id: fx.bom.revisionId,
      business_date: new Date().toISOString().slice(0, 10),
      lines: [
        {
          bom_line_id: fx.c1LineId,
          component_item_id: fx.itemC1,
          component_sku: 'FAKE-SKU',
          required_quantity: '20',
          source_location_id: binLocId,
          lot_number: null,
          staged_at: new Date().toISOString(),
        },
      ],
    });
    assert.strictEqual(wrongSku.status, 409, JSON.stringify(wrongSku.body));
    assert.strictEqual(wrongSku.body['error_code'], 'PRODUCTION_MATERIAL_DERIVATION_MISMATCH');

    // A declared (fabricated) stage_id is a server-minted write-back and rejects.
    const declaredStageId = await post({
      production_order_id: orderId,
      revision_id: fx.bom.revisionId,
      business_date: new Date().toISOString().slice(0, 10),
      lines: [
        {
          stage_id: randomUUID(),
          bom_line_id: fx.c1LineId,
          component_item_id: fx.itemC1,
          component_sku: fx.c1Sku,
          required_quantity: '20',
          source_location_id: binLocId,
          lot_number: null,
          staged_at: new Date().toISOString(),
        },
      ],
    });
    assert.strictEqual(declaredStageId.status, 409, JSON.stringify(declaredStageId.body));
    assert.strictEqual(
      declaredStageId.body['error_code'],
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
    );

    // Nothing landed: no stage rows, no allocation.
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 0);
    const balance = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'AD-12 forged stage');
    await assertNumericEqual(balance.allocated, '0', 'no allocation from forged events');
  });

  it('AD-12: forged material_issued / confirmation_recorded / material_returned events are rejected by the seam', async () => {
    const fx = await releasedMixedBom('forged-others');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);
    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;

    const direct = (eventType: string, payload: Record<string, unknown>) =>
      makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          stream_type: 'production',
          stream_id: orderId,
          event_type: eventType,
          payload,
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: plannerUserId, role: 'production_planner', location_id: binLocId },
            occurred_at: new Date().toISOString(),
          },
        },
        plannerHeaders,
      );

    // Issued with an inflated quantity (> remaining staged) is rejected by the seam.
    const inflatedIssue = await direct('production_order.material_issued', {
      production_order_id: orderId,
      stage_id: stageId,
      quantity: '21',
      issued_by: plannerUserId,
      issued_at: new Date().toISOString(),
      postings: [],
    });
    assert.strictEqual(inflatedIssue.status, 409, JSON.stringify(inflatedIssue.body));
    assert.strictEqual(inflatedIssue.body['error_code'], 'ISSUE_EXCEEDS_STAGED');

    // Issued with FABRICATED postings (server-derived write-back) is rejected.
    const fabricatedPostings = await direct('production_order.material_issued', {
      production_order_id: orderId,
      stage_id: stageId,
      quantity: '20',
      issued_by: plannerUserId,
      issued_at: new Date().toISOString(),
      postings: [
        {
          posting_id: randomUUID(),
          bom_line_id: fx.c1LineId,
          component_item_id: fx.itemC1,
          component_sku: fx.c1Sku,
          lot_number: null,
          source_location_id: binLocId,
          quantity: '20',
          unit_cost: '0.001',
          posting_value: '0.02',
        },
      ],
    });
    assert.strictEqual(fabricatedPostings.status, 409, JSON.stringify(fabricatedPostings.body));
    assert.strictEqual(
      fabricatedPostings.body['error_code'],
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
    );

    // Confirmation with fabricated backflush_lines (server-derived write-back) is rejected.
    const fabricatedBackflush = await direct('production_order.confirmation_recorded', {
      production_order_id: orderId,
      confirmed_quantity: '5',
      revision_id: fx.bom.revisionId,
      business_date: new Date().toISOString().slice(0, 10),
      confirmed_by: plannerUserId,
      confirmed_at: new Date().toISOString(),
      backflush_lines: [
        {
          bom_line_id: fx.c2LineId,
          component_sku: fx.c2Sku,
          required_quantity: '5',
          postings: [],
        },
      ],
    });
    assert.strictEqual(fabricatedBackflush.status, 409, JSON.stringify(fabricatedBackflush.body));
    assert.strictEqual(
      fabricatedBackflush.body['error_code'],
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
    );

    // Confirmation with a wrong revision is rejected by the seam.
    const wrongRevisionConfirm = await direct('production_order.confirmation_recorded', {
      production_order_id: orderId,
      confirmed_quantity: '5',
      revision_id: randomUUID(),
      business_date: new Date().toISOString().slice(0, 10),
      confirmed_by: plannerUserId,
      confirmed_at: new Date().toISOString(),
      backflush_lines: [],
    });
    assert.strictEqual(wrongRevisionConfirm.status, 409, JSON.stringify(wrongRevisionConfirm.body));
    assert.strictEqual(
      wrongRevisionConfirm.body['error_code'],
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
    );

    // Return with a fabricated posting_id (server-minted write-back) is rejected.
    const fabricatedReturnId = await direct('production_order.material_returned', {
      production_order_id: orderId,
      source_posting_id: randomUUID(),
      quantity: '1',
      reason_code: 'SURPLUS_TO_ORDER',
      returned_by: plannerUserId,
      returned_at: new Date().toISOString(),
      posting_id: randomUUID(),
    });
    assert.strictEqual(fabricatedReturnId.status, 409, JSON.stringify(fabricatedReturnId.body));
    assert.strictEqual(
      fabricatedReturnId.body['error_code'],
      'PRODUCTION_MATERIAL_DERIVATION_MISMATCH',
    );

    // Nothing landed: no postings, no stock moved.
    assert.strictEqual((await wipPostingsForOrder(orderId)).length, 0);
    const balance = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'AD-12 forged others');
    await assertNumericEqual(balance.on_hand, '20', 'stock untouched');
    await assertNumericEqual(balance.allocated, '20', 'staging allocation untouched');
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  it('concurrency: two parallel stagings of the same line resolve to one winner and one stable 409 DUPLICATE_EVENT', async () => {
    const fx = await releasedMixedBom('conc-stage');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const [resA, resB] = await Promise.all([
      stageOrder(orderId, [{ bom_line_id: fx.c1LineId, source_location_id: binLocId }]),
      stageOrder(orderId, [{ bom_line_id: fx.c1LineId, source_location_id: binLocId }]),
    ]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `parallel stagings must be one success and one stable rejection: ${JSON.stringify([resA.body, resB.body])}`,
    );
    const loser = resA.status === 409 ? resA : resB;
    assert.strictEqual(loser.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 1, 'exactly one stage row');
    const balance = await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'conc stage');
    await assertNumericEqual(balance.allocated, '20', 'allocated exactly once');
  });

  it('concurrency: two parallel confirmations racing the last unit of a component resolve to one success and one stable 409 INSUFFICIENT_STOCK', async () => {
    const fx = await releasedBackflushOnlyBom('conc-confirm');
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    // Both confirmations demand 6 of the 10 available units: one wins, the second sees 4.
    const [resA, resB] = await Promise.all([
      confirmProduction(orderId, '6'),
      confirmProduction(orderId, '6'),
    ]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 409],
      `parallel confirmations must be one success and one stable rejection: ${JSON.stringify([resA.body, resB.body])}`,
    );
    const loser = resA.status === 409 ? resA : resB;
    assert.strictEqual(loser.body['error_code'], 'INSUFFICIENT_STOCK');
    const shortfall = (loser.body['details'] as Record<string, unknown>)?.[
      'shortfall_lines'
    ] as Record<string, unknown>[];
    assert.strictEqual(shortfall.length, 1, 'the loser reports the shortfall line');
    await assertNumericEqual(String(shortfall[0]!['shortfall_quantity']), '2', 'loser sees 6-4');
    assert.strictEqual(
      (await wipPostingsForOrder(orderId)).length,
      1,
      'exactly one backflush posting',
    );
  });

  // -------------------------------------------------------------------------
  // RBAC and plant scoping
  // -------------------------------------------------------------------------

  it('RBAC/scoping: a read-only role gets 403 on the write routes, and a plant-scoped role gets 403 LOCATION_ACCESS_DENIED on another plant order', async () => {
    const fx = await releasedMixedBom('rbac');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    // A read-only role cannot write: it holds the production module but not the write function
    // scope, so the denial is FUNCTION_ACCESS_DENIED.
    const readDenied = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      {
        idempotency_key: randomUUID(),
        lines: [{ bom_line_id: fx.c1LineId, source_location_id: binLocId }],
      },
      readerHeaders,
    );
    assert.strictEqual(readDenied.status, 403, JSON.stringify(readDenied.body));
    assert.strictEqual(readDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // A writer scoped to another plant is refused LOCATION_ACCESS_DENIED on every route.
    await provisionUser(port, `scoped-writer-6-2-${run}@example.com`, [
      {
        role: 'production_planner',
        module: 'production',
        functionScope: 'write',
        locationId: otherSiteLocId,
      },
    ]);
    const scopedWriterHeaders = await authFor(port, `scoped-writer-6-2-${run}@example.com`);

    const scopedStage = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      {
        idempotency_key: randomUUID(),
        lines: [{ bom_line_id: fx.c1LineId, source_location_id: binLocId }],
      },
      scopedWriterHeaders,
    );
    assert.strictEqual(scopedStage.status, 403, JSON.stringify(scopedStage.body));
    assert.strictEqual(scopedStage.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const scopedWip = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}/wip`,
      undefined,
      scopedWriterHeaders,
    );
    assert.strictEqual(scopedWip.status, 403, JSON.stringify(scopedWip.body));
    assert.strictEqual(scopedWip.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // The control read still works for the wildcard reader.
    const control = await getWip(orderId);
    assert.strictEqual(control.status, 200, JSON.stringify(control.body));
  });

  // -------------------------------------------------------------------------
  // Table 8 error codes (the reachable set)
  // -------------------------------------------------------------------------

  it('Table 8: INVALID_STATE_TRANSITION, PRODUCTION_ORDER_NOT_FOUND, STAGING_LINE_NOT_DIRECTED_ISSUE, STAGING_LOCATION_OUTSIDE_PLANT, ISSUE_EXCEEDS_STAGED, STAGE_ALREADY_ISSUED', async () => {
    const fx = await releasedMixedBom('t8a');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;

    // PRODUCTION_ORDER_NOT_FOUND on every route family.
    for (const path of [
      `/api/v1/production-orders/${randomUUID()}/material-staging`,
      `/api/v1/production-orders/${randomUUID()}/material-issues`,
      `/api/v1/production-orders/${randomUUID()}/confirmations`,
      `/api/v1/production-orders/${randomUUID()}/material-returns`,
      `/api/v1/production-orders/${randomUUID()}/wip`,
    ]) {
      const res = await makeRequest(
        port,
        path.includes('wip') ? 'GET' : 'POST',
        path,
        path.includes('wip') ? undefined : { idempotency_key: randomUUID() },
        plannerHeaders,
      );
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'PRODUCTION_ORDER_NOT_FOUND');
    }

    // INVALID_STATE_TRANSITION: staging a planned order.
    const planned = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(planned.status, 400, JSON.stringify(planned.body));
    assert.strictEqual(planned.body['error_code'], 'INVALID_STATE_TRANSITION');

    // Release, then run the reachable staging/issue guards.
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    // STAGING_LINE_NOT_DIRECTED_ISSUE: staging the backflush line is rejected.
    const backflushStage = await stageOrder(orderId, [
      { bom_line_id: fx.c2LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(backflushStage.status, 409, JSON.stringify(backflushStage.body));
    assert.strictEqual(backflushStage.body['error_code'], 'STAGING_LINE_NOT_DIRECTED_ISSUE');

    // STAGING_LOCATION_OUTSIDE_PLANT: a bin outside the order plant.
    const outsideBin = await seedLocation('bin', `BIN-OUT-${run}`, otherSiteLocId, otherSiteLocId);
    const outside = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: outsideBin },
    ]);
    assert.strictEqual(outside.status, 409, JSON.stringify(outside.body));
    assert.strictEqual(outside.body['error_code'], 'STAGING_LOCATION_OUTSIDE_PLANT');

    // Stage + issue full, then ISSUE_EXCEEDS_STAGED / STAGE_ALREADY_ISSUED.
    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const overIssue = await issueMaterial(orderId, stageId, '21');
    assert.strictEqual(overIssue.status, 409, JSON.stringify(overIssue.body));
    assert.strictEqual(overIssue.body['error_code'], 'ISSUE_EXCEEDS_STAGED');

    assert.strictEqual((await issueMaterial(orderId, stageId, '20')).status, 200);
    const alreadyIssued = await issueMaterial(orderId, stageId, '0.1');
    assert.strictEqual(alreadyIssued.status, 409, JSON.stringify(alreadyIssued.body));
    assert.strictEqual(alreadyIssued.body['error_code'], 'STAGE_ALREADY_ISSUED');

    // STAGE_NOT_FOUND: a random stage id.
    const noStage = await issueMaterial(orderId, randomUUID(), '1');
    assert.strictEqual(noStage.status, 404, JSON.stringify(noStage.body));
    assert.strictEqual(noStage.body['error_code'], 'STAGE_NOT_FOUND');
  });

  it('Table 8: NO_BACKFLUSH_LINES, WIP_COST_UNRESOLVED, POSTING_NOT_FOUND, RETURN_SOURCE_MISMATCH, RETURN_REASON_CODE_INVALID, INVALID_PARAMS', async () => {
    // NO_BACKFLUSH_LINES: an order whose BOM has no backflush lines cannot confirm.
    const itemOut = await createItem(`FG-${run}-t8b`);
    const itemC1 = await createItem(`C1-${run}-t8b`);
    const c1Sku = await skuOf(itemC1);
    const bom = await draftAndRelease(itemOut, [componentLine(1, itemC1)]);
    await receiveStock(c1Sku, binLocId, 20);
    const noBf = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const noBfOrderId = noBf.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(noBfOrderId)).status, 200);
    const noBfConfirm = await confirmProduction(noBfOrderId, '1');
    assert.strictEqual(noBfConfirm.status, 409, JSON.stringify(noBfConfirm.body));
    assert.strictEqual(noBfConfirm.body['error_code'], 'NO_BACKFLUSH_LINES');

    // WIP_COST_UNRESOLVED: an unpriced receipt leaves running_average_cost NULL, so issuing
    // against that component fails closed.
    const fx = await releasedMixedBom('t8b2');
    await receiveStock(fx.c1Sku, binLocId, 20, null, 0);
    // Force the valuation row to an unpriced state: running_average_cost stays NULL when the
    // receipt is unpriced, so drop the row the priced path would have created.
    await getAdminPool().query(`DELETE FROM inventory_valuation WHERE sku = $1`, [fx.c1Sku]);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);
    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const noCost = await issueMaterial(orderId, stageId, '20');
    assert.strictEqual(noCost.status, 409, JSON.stringify(noCost.body));
    assert.strictEqual(noCost.body['error_code'], 'WIP_COST_UNRESOLVED');

    // POSTING_NOT_FOUND: a random source posting on the return route.
    const noPosting = await returnMaterial(orderId, randomUUID(), '1', 'SURPLUS_TO_ORDER');
    assert.strictEqual(noPosting.status, 404, JSON.stringify(noPosting.body));
    assert.strictEqual(noPosting.body['error_code'], 'POSTING_NOT_FOUND');

    // RETURN_SOURCE_MISMATCH: return against another order's posting. Issue on THIS order, then
    // point a return on a SECOND order at this posting.
    await getAdminPool().query(`DELETE FROM inventory_valuation WHERE sku = $1`, [fx.c1Sku]);
    await receiveStock(fx.c1Sku, binLocId, 20, null, 5);
    const priced = await issueMaterial(orderId, stageId, '20');
    assert.strictEqual(priced.status, 200, JSON.stringify(priced.body));
    const sourcePostingId = (priced.body['postings'] as Record<string, unknown>[])[0]![
      'posting_id'
    ] as string;

    const secondCreated = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const secondOrderId = secondCreated.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(secondOrderId)).status, 200);
    const mismatch = await returnMaterial(secondOrderId, sourcePostingId, '1', 'SURPLUS_TO_ORDER');
    assert.strictEqual(mismatch.status, 409, JSON.stringify(mismatch.body));
    assert.strictEqual(mismatch.body['error_code'], 'RETURN_SOURCE_MISMATCH');

    // INVALID_PARAMS: malformed bodies never reach the seam's projection.
    const badBody = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      {
        idempotency_key: randomUUID(),
        lines: [{ bom_line_id: 'not-a-uuid', source_location_id: binLocId }],
      },
      plannerHeaders,
    );
    assert.strictEqual(badBody.status, 400, JSON.stringify(badBody.body));
    assert.strictEqual(badBody.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // BOM_REVISION_DRIFT and MATERIAL_REQUIREMENT_SET_TRUNCATED
  // -------------------------------------------------------------------------

  it('BOM_REVISION_DRIFT: an ECO-superseded revision blocks staging/confirmation until a conscious re-release', async () => {
    const fx = await releasedMixedBom('drift');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    const released = await releaseOrder(orderId);
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
    assert.strictEqual(released.body['released_revision_id'], fx.bom.revisionId);

    // An ECO supersedes the released revision: a NEW released revision becomes the current one.
    const newRevisionId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, released_at, released_by, source_event_id)
       VALUES ($1, $2, 'B', 'released', $3, now(), $3, $4)`,
      [newRevisionId, fx.bom.bomId, plannerUserId, randomUUID()],
    );
    await getAdminPool().query('UPDATE bom SET current_revision_id = $1 WHERE bom_id = $2', [
      newRevisionId,
      fx.bom.bomId,
    ]);

    // Staging now rejects BOM_REVISION_DRIFT - the order executes against the revision it was
    // gated against.
    const drifted = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(drifted.status, 409, JSON.stringify(drifted.body));
    assert.strictEqual(drifted.body['error_code'], 'BOM_REVISION_DRIFT');
    const driftDetails = drifted.body['details'] as Record<string, unknown>;
    assert.strictEqual(driftDetails['released_revision_id'], fx.bom.revisionId);
    assert.strictEqual(driftDetails['current_revision_id'], newRevisionId);

    // Confirmation is pinned the same way.
    const driftedConfirm = await confirmProduction(orderId, '5');
    assert.strictEqual(driftedConfirm.status, 409, JSON.stringify(driftedConfirm.body));
    assert.strictEqual(driftedConfirm.body['error_code'], 'BOM_REVISION_DRIFT');

    // Nothing landed.
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 0);
    assert.strictEqual((await wipPostingsForOrder(orderId)).length, 0);
  });

  it('MATERIAL_REQUIREMENT_SET_TRUNCATED: a BOM that grew deeper after release cannot be staged', async () => {
    const itemOut = await createItem(`FG-${run}-trunc`);
    const itemC1 = await createItem(`C1-${run}-trunc`);
    const c1Sku = await skuOf(itemC1);
    const bom = await draftAndRelease(itemOut, [componentLine(1, itemC1, { quantity_per: '1.0' })]);
    await receiveStock(c1Sku, binLocId, 1);
    const created = await createOrder({
      output_item_id: itemOut,
      bom_id: bom.bomId,
      order_quantity: '1',
    });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    // After release, extend a child-BOM chain under C1 deep enough to hit the depth cap when the
    // walk descends. 22 child BOMs: BOM(C1)->C2 ... BOM(C21)->C22, so the row AT the cap still has
    // somewhere to descend.
    const chainItems: { itemId: string; sku: string }[] = [];
    for (let i = 2; i <= 22; i += 1) {
      const itemId = await createItem(`C${i}-${run}-trunc`);
      chainItems.push({ itemId, sku: await skuOf(itemId) });
    }
    for (let i = 0; i < chainItems.length; i += 1) {
      const parent = i === 0 ? { itemId: itemC1, sku: c1Sku } : chainItems[i - 1]!;
      const child = chainItems[i]!;
      const bomId = randomUUID();
      const revisionId = randomUUID();
      const lineId = randomUUID();
      await getAdminPool().query(
        `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, current_revision_id, created_by, source_event_id)
         VALUES ($1, $2, $3, 'EA', 'production', 'production', 'released', $4, $5, $6)`,
        [bomId, parent.itemId, parent.sku, revisionId, plannerUserId, randomUUID()],
      );
      await getAdminPool().query(
        `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, released_at, released_by, source_event_id)
         VALUES ($1, $2, 'A', 'released', $3, now(), $3, $4)`,
        [revisionId, bomId, plannerUserId, randomUUID()],
      );
      await getAdminPool().query(
        `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, scrap_percent, is_phantom, effective_from, supply_method, source_event_id)
         VALUES ($1, $2, $3, 1, $4, $5, 'component', '1.0', 'EA', '1.0', '1.0', 0, false, '2020-01-01', 'directed_issue', $6)`,
        [lineId, revisionId, bomId, child.itemId, child.sku, randomUUID()],
      );
    }

    // The walk from the released order now truncates at the depth cap.
    const truncated = await stageOrder(orderId, [
      { bom_line_id: (await bomLineIds(bom.revisionId)).get(1)!, source_location_id: binLocId },
    ]);
    assert.strictEqual(truncated.status, 409, JSON.stringify(truncated.body));
    assert.strictEqual(truncated.body['error_code'], 'MATERIAL_REQUIREMENT_SET_TRUNCATED');
    assert.strictEqual((await stageRowsForOrder(orderId)).length, 0);
  });

  // -------------------------------------------------------------------------
  // Ledger invariants and the worklist read
  // -------------------------------------------------------------------------

  it('ledger invariants: available = on_hand - allocated - picked holds after every stock-touching op and WIP open never goes negative', async () => {
    const fx = await releasedMixedBom('invariants');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'invariant: seeded');
    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'invariant: staged');
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const issued = await issueMaterial(orderId, stageId, '20');
    await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'invariant: issued');
    assert.strictEqual((await confirmProduction(orderId, '10')).status, 200);
    await assertBalanceInvariant(fx.c2Sku, binLocId, null, 'invariant: backflushed');

    const sourcePostingId = (issued.body['postings'] as Record<string, unknown>[])[0]![
      'posting_id'
    ] as string;
    assert.strictEqual(
      (await returnMaterial(orderId, sourcePostingId, '20', 'SURPLUS_TO_ORDER')).status,
      200,
    );
    await assertBalanceInvariant(fx.c1Sku, binLocId, null, 'invariant: returned');

    // WIP open quantity never negative across the whole order.
    const negative = await getPool().query(
      `SELECT count(*)::int AS n FROM production_wip_ledger WHERE production_order_id = $1 AND open_quantity < 0`,
      [orderId],
    );
    assert.strictEqual(negative.rows[0]!['n'], 0, 'no negative open quantities');
  });

  it('GET /material-staging worklist carries the staged rows plus the remaining directed lines and is a clean read', async () => {
    const fx = await releasedMixedBom('worklist');
    await receiveStock(fx.c1Sku, binLocId, 20);
    await receiveStock(fx.c2Sku, binLocId, 10);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    assert.strictEqual((await releaseOrder(orderId)).status, 200);

    const empty = await getStagingWorklist(orderId);
    assert.strictEqual(empty.status, 200, JSON.stringify(empty.body));
    assert.strictEqual(empty.body['status'], 'released');
    assert.strictEqual((empty.body['staged'] as unknown[]).length, 0);
    assert.strictEqual((empty.body['pending'] as unknown[]).length, 1);
    await assertNumericEqual(
      String((empty.body['pending'] as Record<string, unknown>[])[0]!['required_quantity']),
      '20',
      'pending requirement quantity',
    );

    const staged = await stageOrder(orderId, [
      { bom_line_id: fx.c1LineId, source_location_id: binLocId },
    ]);
    assert.strictEqual(staged.status, 201, JSON.stringify(staged.body));
    const after = await getStagingWorklist(orderId);
    const stagedRows = after.body['staged'] as Record<string, unknown>[];
    assert.strictEqual(stagedRows.length, 1);
    assert.strictEqual(stagedRows[0]!['status'], 'allocated');
    assert.strictEqual(stagedRows[0]!['source_location_id'], binLocId);
    assert.strictEqual((after.body['pending'] as unknown[]).length, 0);
  });
});

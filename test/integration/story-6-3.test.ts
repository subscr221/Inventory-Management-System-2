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

/**
 * Story 6.3: Production Completions and QC Hand-off (FR-MO-07/08/09/10).
 *
 * Bootstrapped from story-6-2.test.ts (same harness, helpers and seeding discipline) and extended
 * with the Epic 8 projections, because this is the FIRST real producer of the Story 8.1 QC
 * hand-off: every assertion about AC1 and AC2 is an assertion about a live inspection task, not a
 * synthetic one.
 *
 * Seeding discipline carried from 6.2: every stock receipt is PRICED so the Story 2.4 running
 * average resolves (an unpriced seed trips WIP_COST_UNRESOLVED and hides the behaviour under test),
 * and every stock assertion checks absolute values plus the ledger invariant
 * available = on_hand - allocated - picked, never deltas alone.
 */

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
    req.setTimeout(20000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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

describe('Story 6.3 Production Completions and QC Hand-off', () => {
  let server: Server;
  let port: number;

  let plannerUserId: string;
  let plannerHeaders: Record<string, string>;
  let supervisorUserId: string;
  let supervisorHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let scopedPlannerHeaders: Record<string, string>;

  let siteLocId: string;
  let zoneLocId: string;
  let binLocId: string;
  let otherSiteLocId: string;

  // -------------------------------------------------------------------------
  // Fixture helpers (the 6.2 set, verbatim where unchanged)
  // -------------------------------------------------------------------------

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

  function outputLine(
    lineNo: number,
    itemId: string,
    outputClass: 'co_product' | 'by_product',
    yieldPercent: string,
  ): Record<string, unknown> {
    return {
      line_no: lineNo,
      component_item_id: itemId,
      output_class: outputClass,
      quantity_per: '1.0',
      line_uom: 'EA',
      uom_conversion_factor: '1.0',
      scrap_percent: '0.0',
      expected_yield_percent: yieldPercent,
      is_phantom: false,
      effective_from: '2020-01-01',
    };
  }

  async function draftAndRelease(
    parentItemId: string,
    lines: Record<string, unknown>[],
  ): Promise<{ bomId: string; revisionId: string }> {
    const draft = await makeRequest(
      port,
      'POST',
      '/api/v1/boms',
      {
        parent_item_id: parentItemId,
        revision_code: 'A',
        bom_type: 'production',
        lines,
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

  /** Priced receipt through the Epic 2 ledger: an unpriced seed trips WIP_COST_UNRESOLVED. */
  async function receiveStock(
    sku: string,
    locationId: string,
    quantity: number,
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

  /**
   * Absolute balance assertion.
   *
   * Code review 2026-08-31: this helper used to assert `available = on_hand - allocated - picked`,
   * which `stock_balance.available` is declared as `GENERATED ALWAYS AS (...) STORED`. The storage
   * engine enforces that identity, so the assertion could not fail and six call sites proved
   * nothing. It now asserts the caller's EXPECTED absolute values, which is what the Story 7.4 rule
   * was actually asking for.
   */
  async function assertBalance(
    sku: string,
    locationId: string,
    lotId: string | null,
    expected: { on_hand: string; allocated?: string; picked?: string },
    label: string,
  ): Promise<{ on_hand: string; allocated: string; picked: string; available: string }> {
    const balance = await balanceAt(sku, locationId, lotId);
    await assertNumericEqual(balance.on_hand, expected.on_hand, `${label}: on_hand`);
    if (expected.allocated !== undefined) {
      await assertNumericEqual(balance.allocated, expected.allocated, `${label}: allocated`);
    }
    if (expected.picked !== undefined) {
      await assertNumericEqual(balance.picked, expected.picked, `${label}: picked`);
    }
    return balance;
  }

  async function wipSummaryDb(
    orderId: string,
  ): Promise<{ net_open_quantity: string; net_open_value: string }> {
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

  async function orderRow(orderId: string): Promise<Record<string, unknown>> {
    const result = await getPool().query(
      `SELECT * FROM production_order WHERE production_order_id = $1`,
      [orderId],
    );
    return result.rows[0] as Record<string, unknown>;
  }

  async function completionRows(orderId: string): Promise<Record<string, unknown>[]> {
    const result = await getPool().query(
      `SELECT * FROM production_completion WHERE production_order_id = $1
        ORDER BY created_at ASC, completion_id ASC`,
      [orderId],
    );
    return result.rows as Record<string, unknown>[];
  }

  async function taskForLot(lotId: string): Promise<Record<string, unknown> | undefined> {
    const result = await getPool().query(`SELECT * FROM qc_inspection_task WHERE lot_id = $1`, [
      lotId,
    ]);
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  /**
   * Scoped to the order, the actor and the endpoint (code review 2026-08-31). The earlier helper
   * counted every row in the database with that error code and asserted only that the count rose,
   * so writing the row with a null user, a 200 status and empty details left it green - and the
   * row content is the entire point of FR-AC-13.
   */
  async function auditRowFor(
    errorCode: string,
    orderId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await getPool().query(
      `SELECT * FROM audit_log
        WHERE error_code = $1 AND details->>'production_order_id' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [errorCode, orderId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  // -------------------------------------------------------------------------
  // Order and QC plan fixtures
  // -------------------------------------------------------------------------

  async function createOrder(overrides: Record<string, unknown> = {}): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/production-orders',
      {
        output_item_id: overrides['output_item_id'],
        order_quantity: overrides['order_quantity'] ?? '10',
        plant_location_id: overrides['plant_location_id'] ?? siteLocId,
        bom_id: overrides['bom_id'],
        business_stream: overrides['business_stream'] ?? 'production',
        source_reference_type: overrides['source_reference_type'] ?? 'manual',
        source_reference_id: overrides['source_reference_id'] ?? `REF-${randomUUID().slice(0, 8)}`,
        idempotency_key: overrides['idempotency_key'] ?? randomUUID(),
      },
      plannerHeaders,
    );
  }

  async function approvePlanFor(itemId: string, revisionId: string): Promise<void> {
    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/inspection-plans',
      {
        scope: 'standard',
        item_id: itemId,
        bom_revision_id: revisionId,
        effective_from: '2020-01-01',
        aql: '1.000',
        inspection_level: 'II',
        characteristics: [
          {
            line_no: 1,
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
          },
        ],
      },
      inspectorHeaders,
    );
    assert.strictEqual(created.status, 201, `plan create failed: ${JSON.stringify(created.body)}`);
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
    assert.strictEqual(
      approved.status,
      200,
      `plan approve failed: ${JSON.stringify(approved.body)}`,
    );
  }

  interface Fixture {
    itemOut: string;
    outSku: string;
    componentSku: string;
    componentItemId: string;
    componentLineId: string;
    directedSku: string;
    directedLineId: string;
    coItemId?: string;
    byItemId?: string;
    coLineId?: string;
    byLineId?: string;
    bom: { bomId: string; revisionId: string };
  }

  let fixtureCounter = 0;

  /**
   * A released BOM with one backflush component (so material can be consumed into WIP through the
   * 6.2 confirmation route) and, optionally, one co-product and one by-product output line. Every
   * output item gets an APPROVED inspection plan against the SAME released revision, because the
   * Story 8.1 plan grain is (item_id, bom_revision_id) and a completion with no approved plan fails
   * closed (Binding Decision 3).
   */
  async function fixture(withSecondaryOutputs: boolean): Promise<Fixture> {
    fixtureCounter += 1;
    const suffix = `${run}-${fixtureCounter}`;
    const itemOut = await createItem(`FG-6-3-${suffix}`);
    const itemComponent = await createItem(`C-6-3-${suffix}`);
    // Task 9.2 requires BOTH supply methods. Without the directed_issue line every drain ran
    // against a single open posting, so the oldest-first ordering, the partial drain and the
    // source-cost rule of BD-8 were structurally untestable (code review 2026-08-31).
    const itemDirected = await createItem(`D-6-3-${suffix}`);
    const lines: Record<string, unknown>[] = [
      componentLine(1, itemComponent, { quantity_per: '1.0', supply_method: 'backflush' }),
      componentLine(2, itemDirected, { quantity_per: '1.0' }),
    ];
    let coItemId: string | undefined;
    let byItemId: string | undefined;
    let coRevisionId: string | undefined;
    let byRevisionId: string | undefined;
    if (withSecondaryOutputs) {
      coItemId = await createItem(`CO-6-3-${suffix}`);
      byItemId = await createItem(`BY-6-3-${suffix}`);
      // Story 8.1 keys an inspection plan on (item_id, bom_revision_id) and refuses a plan whose
      // revision does not belong to the item (INSPECTION_PLAN_SCOPE_MISMATCH), so a co-product is
      // inspected against its OWN released specification, not the parent order's revision.
      const coSpecComponent = await createItem(`COC-6-3-${suffix}`);
      const bySpecComponent = await createItem(`BYC-6-3-${suffix}`);
      coRevisionId = (await draftAndRelease(coItemId, [componentLine(1, coSpecComponent)]))
        .revisionId;
      byRevisionId = (await draftAndRelease(byItemId, [componentLine(1, bySpecComponent)]))
        .revisionId;
      lines.push(outputLine(3, coItemId, 'co_product', '50.0'));
      lines.push(outputLine(4, byItemId, 'by_product', '10.0'));
    }
    const bom = await draftAndRelease(itemOut, lines);
    const lineIds = await bomLineIds(bom.revisionId);
    await approvePlanFor(itemOut, bom.revisionId);
    if (coItemId && coRevisionId) await approvePlanFor(coItemId, coRevisionId);
    if (byItemId && byRevisionId) await approvePlanFor(byItemId, byRevisionId);
    const result: Fixture = {
      itemOut,
      outSku: await skuOf(itemOut),
      componentSku: await skuOf(itemComponent),
      componentItemId: itemComponent,
      componentLineId: lineIds.get(1)!,
      directedSku: await skuOf(itemDirected),
      directedLineId: lineIds.get(2)!,
      bom,
    };
    if (coItemId) {
      result.coItemId = coItemId;
      result.coLineId = lineIds.get(3)!;
    }
    if (byItemId) {
      result.byItemId = byItemId;
      result.byLineId = lineIds.get(4)!;
    }
    return result;
  }

  /**
   * Drives a fixture all the way to an in_process order with WIP already open: the component is
   * received priced, the order created and released, a confirmation backflushes the component into
   * the WIP ledger, and the order transitions to in_process.
   */
  async function runningOrder(
    fx: Fixture,
    orderQuantity: string = '10',
    confirmQuantity: string = '10',
    componentStock: number = 100,
  ): Promise<string> {
    await receiveStock(fx.componentSku, binLocId, componentStock);
    // A DIFFERENT unit cost from the backflush component, so a relief posting written at today's
    // average instead of the source posting's cost is detectable (BD-8).
    await receiveStock(fx.directedSku, binLocId, componentStock, 11);
    const created = await createOrder({
      output_item_id: fx.itemOut,
      bom_id: fx.bom.bomId,
      order_quantity: orderQuantity,
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body['production_order_id'] as string;
    const released = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID() },
      plannerHeaders,
    );
    assert.strictEqual(released.status, 200, JSON.stringify(released.body));
    // Stage and issue the directed line FIRST, so the WIP ledger carries a directed_issue posting
    // (created earlier, at a different unit cost) as well as the backflush postings.
    const staged = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      {
        idempotency_key: randomUUID(),
        lines: [{ bom_line_id: fx.directedLineId, source_location_id: binLocId }],
      },
      plannerHeaders,
    );
    assert.strictEqual(staged.status, 201, JSON.stringify(staged.body));
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    const issued = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-issues`,
      { idempotency_key: randomUUID(), stage_id: stageId, quantity: orderQuantity },
      plannerHeaders,
    );
    assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    const confirmed = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/confirmations`,
      { idempotency_key: randomUUID(), confirmed_quantity: confirmQuantity },
      plannerHeaders,
    );
    assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
    const transitioned = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/transition`,
      { new_status: 'in_process', idempotency_key: randomUUID() },
      plannerHeaders,
    );
    assert.strictEqual(transitioned.status, 200, JSON.stringify(transitioned.body));
    return orderId;
  }

  function postCompletion(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = plannerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/completions`,
      { idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  function declareScrap(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = plannerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/scrap-declarations`,
      { idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  function shortClose(
    orderId: string,
    body: Record<string, unknown>,
    // The close-short decision is DOA-gated (AC6), so the supervisor is the default caller.
    headers: Record<string, string> = supervisorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/short-close`,
      { idempotency_key: randomUUID(), ...body },
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
      '../../read/projections/integration_exception.sql',
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
      '../../read/projections/production_order.sql',
      '../../read/projections/production_order_stage.sql',
      '../../read/projections/production_wip_ledger.sql',
      '../../read/projections/production_completion.sql',
      '../../read/projections/production_scrap_declaration.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE production_completion, production_scrap_declaration, production_order_stage, production_wip_ledger, production_order, qc_retention_sample, qc_batch_release, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, integration_exception, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteLocId = await seedLocation('site', `PLANT-63-${run}`, null, null);
    zoneLocId = await seedLocation('zone', `ZONE-63-${run}`, siteLocId, siteLocId);
    binLocId = await seedLocation('bin', `BIN-63-${run}`, zoneLocId, siteLocId);
    void zoneLocId;
    otherSiteLocId = await seedLocation('site', `PLANT-OTHER-63-${run}`, null, null);

    plannerUserId = await provisionUser(port, `planner-6-3-${run}@example.com`, [
      { role: 'production_planner', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_planner', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, `planner-6-3-${run}@example.com`);

    supervisorUserId = await provisionUser(port, `supervisor-6-3-${run}@example.com`, [
      { role: 'production_manager', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_manager', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    supervisorHeaders = await authFor(port, `supervisor-6-3-${run}@example.com`);

    await provisionUser(port, `reader-6-3-${run}@example.com`, [
      { role: 'production_viewer', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `reader-6-3-${run}@example.com`);

    await provisionUser(port, `scoped-6-3-${run}@example.com`, [
      {
        role: 'production_planner',
        module: 'production',
        functionScope: 'write',
        locationId: otherSiteLocId,
      },
      {
        role: 'production_planner',
        module: 'production',
        functionScope: 'read',
        locationId: otherSiteLocId,
      },
    ]);
    scopedPlannerHeaders = await authFor(port, `scoped-6-3-${run}@example.com`);

    await provisionUser(port, `engineer-6-3-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-6-3-${run}@example.com`);

    await provisionUser(port, `compliance-6-3-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-6-3-${run}@example.com`);

    await provisionUser(port, `qc-inspector-6-3-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-6-3-${run}@example.com`);

    await provisionUser(port, `qc-head-6-3-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-6-3-${run}@example.com`);

    for (const transactionType of [
      'production_order.release_override',
      'qc.inspection_plan_approval',
    ]) {
      await getPool().query(
        `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
         VALUES ($1, $2, $3, NULL, NULL, true)`,
        [
          randomUUID(),
          transactionType === 'qc.inspection_plan_approval' ? 'qc_head' : 'production_manager',
          transactionType,
        ],
      );
    }
    // AC5 and AC6: both approval authorities come from the DOA registry, never a role constant.
    for (const transactionType of [
      'production_order.over_completion',
      'production_order.short_close',
    ]) {
      const entry = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        {
          role: 'production_manager',
          transaction_type: transactionType,
          value_min: null,
          value_max: null,
        },
        complianceHeaders,
      );
      assert.strictEqual(entry.status, 201, `${transactionType}: ${JSON.stringify(entry.body)}`);
    }
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1 and AC2: the completion posts into QC Hold, never into sellable stock
  // -------------------------------------------------------------------------

  it('AC1: a completion on an In Process order creates the finished lot, posts its stock and opens a qc_hold inspection task', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    const wipBefore = await wipSummaryDb(orderId);
    assert.notStrictEqual(wipBefore.net_open_quantity, '0', 'the fixture must open WIP first');

    const posted = await postCompletion(orderId, { primary_quantity: '10' });
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));

    const outputs = posted.body['outputs'] as Record<string, unknown>[];
    assert.strictEqual(outputs.length, 1, 'one output lot with no co-products');
    const primary = outputs[0]!;
    assert.strictEqual(primary['output_class'], 'primary');
    assert.strictEqual(primary['bom_line_id'], null);
    assert.strictEqual(primary['output_sku'], fx.outSku);
    await assertNumericEqual(primary['quantity'], '10', 'primary output quantity');

    // The lot exists, is not on any manual hold, and carries the server-minted number.
    const order = await orderRow(orderId);
    assert.strictEqual(primary['lot_number'], `${String(order['order_number_ext'])}-L1`);
    const lot = await getPool().query(`SELECT * FROM lot_master WHERE lot_id = $1`, [
      primary['lot_id'],
    ]);
    assert.strictEqual(lot.rows.length, 1);
    assert.strictEqual(lot.rows[0]!['quality_hold_status'], 'none');

    // The finished stock exists at the plant, unallocated, at exactly the completed quantity.
    await assertBalance(
      fx.outSku,
      siteLocId,
      primary['lot_number'] as string,
      { on_hand: '10', allocated: '0', picked: '0' },
      'AC1 finished stock',
    );

    // AC1: the gate is qc_hold, and the task points back at THIS completion.
    const task = await taskForLot(primary['lot_id'] as string);
    assert.ok(task, 'the QC inspection task must exist');
    assert.strictEqual(task!['gate_status'], 'qc_hold');
    assert.strictEqual(task!['source_completion_type'], 'production_order');
    assert.strictEqual(task!['source_completion_id'], primary['completion_id']);
    assert.strictEqual(task!['task_id'], primary['qc_task_id']);

    // The order aggregate and the WIP relief.
    const after = await orderRow(orderId);
    await assertNumericEqual(String(after['completed_quantity']), '10', 'completed_quantity');
    const wipAfter = await wipSummaryDb(orderId);
    await assertNumericEqual(wipAfter.net_open_quantity, '0', 'WIP fully relieved at 100%');
    assert.strictEqual(Number(after['unreversed_transaction_count']), 0);
    // One relief posting per DRAINED source posting, counted against the ledger rather than
    // asserted as merely non-empty (code review 2026-08-31: `length > 0` survived a mutation that
    // returned only the first entry). The fixture opens a directed_issue posting and a backflush
    // posting, and a completion at the full ordered quantity drains both.
    const relief = posted.body['wip_relief'] as Record<string, unknown>[];
    const drained = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM production_wip_ledger
        WHERE production_order_id = $1 AND posting_type = 'completion_relief'`,
      [orderId],
    );
    assert.strictEqual(
      relief.length,
      Number(drained.rows[0]!['n']),
      'the payload reports every relief posting the ledger holds',
    );
    assert.ok(
      relief.length >= 2,
      `expected both source postings drained: ${JSON.stringify(relief)}`,
    );
    // BD-8: each relief is written at its SOURCE posting's unit cost, so the two costs differ.
    const reliefCosts = new Set(relief.map((entry) => String(entry['unit_cost'])));
    assert.strictEqual(
      reliefCosts.size,
      2,
      `relief must carry per-source costs: ${[...reliefCosts]}`,
    );
  });

  it('AC2: the completed lot cannot be allocated to sellable use while its gate is qc_hold', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    const posted = await postCompletion(orderId, { primary_quantity: '10' });
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));
    const primary = (posted.body['outputs'] as Record<string, unknown>[])[0]!;

    const allocation = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.allocated',
        payload: {
          business_stream: 'production',
          sku: fx.outSku,
          target_location_id: siteLocId,
          lot_id: primary['lot_number'],
          quantity: 1,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_controller', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      engineerHeaders,
    );
    assert.strictEqual(allocation.status, 400, JSON.stringify(allocation.body));
    assert.strictEqual(allocation.body['error_code'], 'LOT_ON_HOLD');
    assert.strictEqual(
      (allocation.body['details'] as Record<string, unknown>)['qc_gate_status'],
      'qc_hold',
    );
  });

  it('AC2: a completion whose output has no approved inspection plan fails closed and leaves NO lot and NO stock behind', async () => {
    // The BOM is released but no plan is approved for the output item, so the Story 8.1 hand-off
    // refuses. The whole completion must roll back with it (Binding Decision 1).
    fixtureCounter += 1;
    const suffix = `${run}-noplan-${fixtureCounter}`;
    const itemOut = await createItem(`FG-NOPLAN-${suffix}`);
    const itemComponent = await createItem(`C-NOPLAN-${suffix}`);
    const bom = await draftAndRelease(itemOut, [
      componentLine(1, itemComponent, { quantity_per: '1.0', supply_method: 'backflush' }),
    ]);
    const componentSku = await skuOf(itemComponent);
    const outSku = await skuOf(itemOut);
    await receiveStock(componentSku, binLocId, 100);
    const created = await createOrder({ output_item_id: itemOut, bom_id: bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID() },
      plannerHeaders,
    );
    await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/confirmations`,
      { idempotency_key: randomUUID(), confirmed_quantity: '10' },
      plannerHeaders,
    );
    await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/transition`,
      { new_status: 'in_process', idempotency_key: randomUUID() },
      plannerHeaders,
    );

    const posted = await postCompletion(orderId, { primary_quantity: '10' });
    // Pinned to ONE code and ONE status (code review 2026-08-31): the previous OR-assertion could
    // not tell the two Table 8 rows apart and would have accepted either status.
    assert.strictEqual(posted.status, 404, JSON.stringify(posted.body));
    assert.strictEqual(posted.body['error_code'], 'INSPECTION_PLAN_NOT_FOUND');

    // Nothing was left behind: no completion row, no lot, no finished stock.
    assert.strictEqual((await completionRows(orderId)).length, 0);
    await assertBalance(outSku, siteLocId, null, { on_hand: '0' }, 'no orphan finished stock');
    const orphanLots = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM lot_master WHERE sku = $1`,
      [outSku],
    );
    assert.strictEqual(Number(orphanLots.rows[0]!['n']), 0, 'no orphan lot');
  });

  // -------------------------------------------------------------------------
  // AC3: co-products and by-products post as their own lots
  // -------------------------------------------------------------------------

  it('AC3: a completion posts the primary output, each co-product and each by-product as its own lot with its own qc_hold task', async () => {
    const fx = await fixture(true);
    const orderId = await runningOrder(fx);

    const posted = await postCompletion(orderId, { primary_quantity: '10' });
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));
    const outputs = posted.body['outputs'] as Record<string, unknown>[];
    assert.strictEqual(
      outputs.length,
      3,
      `primary + co-product + by-product: ${JSON.stringify(outputs)}`,
    );

    const byClass = new Map(outputs.map((o) => [o['output_class'] as string, o]));
    const co = byClass.get('co_product')!;
    const by = byClass.get('by_product')!;
    assert.strictEqual(co['bom_line_id'], fx.coLineId);
    assert.strictEqual(by['bom_line_id'], fx.byLineId);
    // 50% and 10% of the 10-unit primary quantity, settled in SQL NUMERIC.
    await assertNumericEqual(co['quantity'], '5', 'co-product quantity at 50 percent yield');
    await assertNumericEqual(by['quantity'], '1', 'by-product quantity at 10 percent yield');

    // Three distinct lots, three distinct tasks, all in qc_hold.
    const lotNumbers = new Set(outputs.map((o) => o['lot_number'] as string));
    assert.strictEqual(lotNumbers.size, 3, 'each output gets its own lot number');
    for (const output of outputs) {
      const task = await taskForLot(output['lot_id'] as string);
      assert.ok(task, `task missing for ${String(output['output_class'])}`);
      assert.strictEqual(task!['gate_status'], 'qc_hold');
      await assertBalance(
        output['output_sku'] as string,
        siteLocId,
        output['lot_number'] as string,
        { on_hand: String(output['quantity']), allocated: '0' },
        `AC3 stock for ${String(output['output_class'])}`,
      );
    }

    // Only the PRIMARY counts toward the ordered quantity (the co-products are separate outputs).
    const order = await orderRow(orderId);
    await assertNumericEqual(
      String(order['completed_quantity']),
      '10',
      'only the primary counts toward completed_quantity',
    );
    assert.strictEqual((await completionRows(orderId)).length, 3);
  });

  // -------------------------------------------------------------------------
  // AC4: scrap relieves WIP
  // -------------------------------------------------------------------------

  it('AC4: a scrap declaration relieves WIP, logs the declaration and moves no stock', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    const before = await wipSummaryDb(orderId);
    const stockBefore = await balanceAt(fx.componentSku, binLocId, null);

    const declared = await declareScrap(orderId, {
      scrap_quantity: '2',
      reason_code: 'PROCESS_LOSS',
    });
    assert.strictEqual(declared.status, 201, JSON.stringify(declared.body));
    assert.match(
      String(declared.body['scrap_id']),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'scrap_id is a real UUID, not merely 36 characters of hex and hyphens',
    );
    assert.strictEqual(declared.body['uom'], 'EA');
    assert.strictEqual(declared.body['declared_by'], plannerUserId);

    // 2 of 10 ordered units scrapped. The relief is prorated against the value ISSUED to the order
    // (product-owner decision, code review 2026-08-31), not against whatever is still open, so the
    // share is issued * 2/10. Asserting the ledger's own arithmetic rather than re-deriving the
    // implementation's formula: the drop in open value must equal the sum of the relief postings
    // actually written, and that sum must be the reported relieved_value.
    const after = await wipSummaryDb(orderId);
    const reliefRows = await getPool().query(
      `SELECT COALESCE(SUM(posting_value), 0)::text AS relieved,
              COUNT(*)::int AS n
         FROM production_wip_ledger
        WHERE production_order_id = $1 AND posting_type = 'scrap_relief'`,
      [orderId],
    );
    assert.ok(
      Number(reliefRows.rows[0]!['n']) >= 1,
      'at least one scrap relief posting was written',
    );
    // Within the ledger's own rounding tolerance, not exactly equal: production_wip_ledger stores
    // posting_value as NUMERIC(14,3) per posting while open_quantity decrements at NUMERIC(18,6),
    // so N relief postings can diverge from the drop by up to 0.0005 each. That divergence is a
    // recorded deferred-work item; this assertion pins the magnitude so a REAL regression (relief
    // written at the wrong cost, or against the wrong postings) still fails loudly.
    const drop = await getPool().query(
      `SELECT ($1::numeric - $2::numeric)::text AS drop,
              (abs(($1::numeric - $2::numeric) - $3::numeric) <= 0.001 * $4::int) AS within`,
      [
        before.net_open_value,
        after.net_open_value,
        String(reliefRows.rows[0]!['relieved']),
        Number(reliefRows.rows[0]!['n']),
      ],
    );
    assert.strictEqual(
      drop.rows[0]!['within'],
      true,
      `the drop in open WIP (${String(drop.rows[0]!['drop'])}) must match the relief postings written (${String(reliefRows.rows[0]!['relieved'])})`,
    );
    await assertNumericEqual(
      String(declared.body['relieved_value']),
      String(reliefRows.rows[0]!['relieved']),
      'the reported relieved_value equals the ledger',
    );
    // The share is bounded by the issued basis: 20 percent of what was issued, never more.
    const issued = await getPool().query(
      `SELECT COALESCE(SUM(posting_value), 0)::text AS issued
         FROM production_wip_ledger
        WHERE production_order_id = $1 AND posting_type IN ('directed_issue','backflush')`,
      [orderId],
    );
    const withinShare = await getPool().query(
      `SELECT ($1::numeric <= ($2::numeric * 2 / 10) + 0.001) AS ok,
              ($1::numeric > 0) AS positive`,
      [String(reliefRows.rows[0]!['relieved']), String(issued.rows[0]!['issued'])],
    );
    assert.strictEqual(withinShare.rows[0]!['positive'], true, 'the scrap relieved real value');
    assert.strictEqual(
      withinShare.rows[0]!['ok'],
      true,
      'the scrap relieved no more than its share of the issued value',
    );

    // The declaration is logged with the relieved value.
    const rows = await getPool().query(
      `SELECT * FROM production_scrap_declaration WHERE production_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0]!['reason_code'], 'PROCESS_LOSS');
    await assertNumericEqual(String(rows.rows[0]!['scrap_quantity']), '2', 'scrap_quantity');

    // No stock moved: the scrap declaration is a WIP relief and an AD-10 source document only.
    // Anchored on the literal seeded quantity, not on a second reading of the same helper: the
    // backflush consumed 10 of the 100 received, so 90 must remain and no scrap may touch it.
    await assertBalance(
      fx.componentSku,
      binLocId,
      null,
      { on_hand: '90' },
      'AC4 component stock unchanged by the scrap declaration',
    );
    await assertNumericEqual(stockBefore.on_hand, '90', 'component on_hand before the declaration');

    const order = await orderRow(orderId);
    await assertNumericEqual(String(order['scrapped_quantity']), '2', 'scrapped_quantity');
  });

  it('AC4: a scrap declaration larger than the open WIP is rejected SCRAP_EXCEEDS_WIP and leaves the ledger untouched', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    const before = await wipSummaryDb(orderId);

    const declared = await declareScrap(orderId, {
      scrap_quantity: '50',
      reason_code: 'PROCESS_LOSS',
    });
    assert.strictEqual(declared.status, 409, JSON.stringify(declared.body));
    assert.strictEqual(declared.body['error_code'], 'SCRAP_EXCEEDS_WIP');
    const details = declared.body['details'] as Record<string, unknown>;
    await assertNumericEqual(
      String(details['open_wip_value']),
      before.net_open_value,
      'the rejection reports the real open WIP value',
    );

    const after = await wipSummaryDb(orderId);
    await assertNumericEqual(after.net_open_value, before.net_open_value, 'ledger untouched');
    assert.strictEqual(
      (
        await getPool().query(
          `SELECT COUNT(*)::int AS n FROM production_scrap_declaration WHERE production_order_id = $1`,
          [orderId],
        )
      ).rows[0]!['n'],
      0,
    );
  });

  it('AC4: a blank scrap reason is REASON_CODE_REQUIRED and an unknown one is SCRAP_REASON_CODE_INVALID with the allowed list', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);

    const blank = await declareScrap(orderId, { scrap_quantity: '1', reason_code: '   ' });
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));
    assert.strictEqual(blank.body['error_code'], 'REASON_CODE_REQUIRED');

    const unknown = await declareScrap(orderId, { scrap_quantity: '1', reason_code: 'NOT_A_CODE' });
    assert.strictEqual(unknown.status, 422, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'SCRAP_REASON_CODE_INVALID');
    const allowed = (unknown.body['details'] as Record<string, unknown>)['allowed'] as string[];
    assert.ok(allowed.includes('PROCESS_LOSS'), 'the allowed list is reported to the caller');
  });

  // -------------------------------------------------------------------------
  // AC5: over-completion tolerance and supervisor approval
  // -------------------------------------------------------------------------

  it('AC5: a completion beyond the ordered quantity plus tolerance is blocked with APPROVAL_REQUIRED and the attempt is audited', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);

    // The tolerance default is 5 percent, so 10.5 is the ceiling and 12 is over it.
    const blocked = await postCompletion(orderId, { primary_quantity: '12' });
    assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'APPROVAL_REQUIRED');
    const details = blocked.body['details'] as Record<string, unknown>;
    await assertNumericEqual(String(details['ceiling']), '10.5', 'the reported ceiling');
    await assertNumericEqual(String(details['cumulative_quantity']), '12', 'cumulative quantity');
    assert.strictEqual(details['tolerance_percent'], '5');

    const auditRow = await auditRowFor('APPROVAL_REQUIRED', orderId);
    assert.ok(auditRow, 'the blocked attempt is written to the edit log (FR-AC-13)');
    assert.strictEqual(auditRow!['user_id'], plannerUserId, 'the audit row names the actor');
    assert.strictEqual(auditRow!['http_status'], 403, 'the audit row records the rejection status');
    assert.match(
      String(auditRow!['endpoint']),
      /\/completions$/,
      'the audit row names the endpoint',
    );
    await assertNumericEqual(
      String((auditRow!['details'] as Record<string, unknown>)['ceiling']),
      '10.5',
      'the audit row carries the load-bearing detail',
    );
    assert.strictEqual((await completionRows(orderId)).length, 0, 'nothing was posted');

    // Inside tolerance is fine without any approval at all.
    const allowed = await postCompletion(orderId, { primary_quantity: '10.4' });
    assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));
  });

  it('AC5: the over-completion succeeds only for the DOA-resolved approver, acting as themselves', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);

    // A forged approver: the planner names the supervisor but acts as the planner.
    const forged = await postCompletion(orderId, {
      primary_quantity: '12',
      over_completion_approved: true,
      approved_by: supervisorUserId,
    });
    assert.strictEqual(forged.status, 403, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'APPROVAL_REQUIRED');

    // The supervisor naming somebody else is refused too.
    const wrongApprover = await postCompletion(
      orderId,
      {
        primary_quantity: '12',
        over_completion_approved: true,
        approved_by: plannerUserId,
      },
      supervisorHeaders,
    );
    assert.strictEqual(wrongApprover.status, 403, JSON.stringify(wrongApprover.body));

    // The resolved approver acting as themselves is accepted.
    const approved = await postCompletion(
      orderId,
      {
        primary_quantity: '12',
        over_completion_approved: true,
        approved_by: supervisorUserId,
      },
      supervisorHeaders,
    );
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    const rows = await completionRows(orderId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['over_completion_approved'], true);
    assert.strictEqual(rows[0]!['approved_by'], supervisorUserId);
  });

  it('AC5: the ceiling bounds the CUMULATIVE quantity, so repeated small completions cannot walk past it', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);

    for (const quantity of ['5', '5']) {
      const ok = await postCompletion(orderId, { primary_quantity: quantity });
      assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    }
    // 10 posted; the next unit crosses the 10.5 ceiling even though it is tiny on its own.
    const blocked = await postCompletion(orderId, { primary_quantity: '1' });
    assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'APPROVAL_REQUIRED');
    await assertNumericEqual(
      String((blocked.body['details'] as Record<string, unknown>)['cumulative_quantity']),
      '11',
      'the cumulative quantity, not the event quantity',
    );
  });

  // -------------------------------------------------------------------------
  // AC6: the close-short decision
  // -------------------------------------------------------------------------

  it('AC6: a short-completed order records the close-short decision, clears residual WIP and becomes closure-eligible at the reduced quantity', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    const posted = await postCompletion(orderId, { primary_quantity: '6' });
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));
    const wipMid = await wipSummaryDb(orderId);
    assert.notStrictEqual(wipMid.net_open_quantity, '0', 'residual WIP remains after a short run');

    const closed = await shortClose(orderId, {
      reason_code: 'YIELD_SHORTFALL',
      residual_disposition: 'scrapped',
    });
    assert.strictEqual(closed.status, 201, JSON.stringify(closed.body));
    assert.strictEqual(closed.body['reason_code'], 'YIELD_SHORTFALL');
    assert.strictEqual(closed.body['short_closed_by'], supervisorUserId);
    await assertNumericEqual(
      String(closed.body['completed_quantity']),
      '6',
      'the decision records the reduced quantity',
    );

    const order = await orderRow(orderId);
    assert.ok(order['short_closed_at'], 'short_closed_at is stamped');
    assert.strictEqual(order['short_close_reason'], 'YIELD_SHORTFALL');
    assert.strictEqual(order['short_closed_by'], supervisorUserId);
    // The order is NOT transitioned by this event (Binding Decision 11).
    assert.strictEqual(order['status'], 'in_process');

    const wipAfter = await wipSummaryDb(orderId);
    await assertNumericEqual(wipAfter.net_open_quantity, '0', 'residual WIP is fully relieved');
    await assertNumericEqual(wipAfter.net_open_value, '0', 'residual WIP value is zero');
    assert.strictEqual(Number(order['unreversed_transaction_count']), 0);

    // A second decision on the same order is refused.
    const again = await shortClose(orderId, {
      reason_code: 'YIELD_SHORTFALL',
      residual_disposition: 'scrapped',
    });
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'SHORT_CLOSE_EXISTS');
  });

  it('AC6: an order inside the tolerance floor needs no decision and is refused SHORT_CLOSE_NOT_APPLICABLE', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    const posted = await postCompletion(orderId, { primary_quantity: '9.6' });
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));

    const refused = await shortClose(orderId, {
      reason_code: 'YIELD_SHORTFALL',
      residual_disposition: 'returned',
    });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body['error_code'], 'SHORT_CLOSE_NOT_APPLICABLE');
    await assertNumericEqual(
      String((refused.body['details'] as Record<string, unknown>)['floor']),
      '9.5',
      'the reported short floor',
    );
  });

  it('AC6: an unknown close-short reason is SHORT_CLOSE_REASON_CODE_INVALID and a missing one is REASON_CODE_REQUIRED', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    await postCompletion(orderId, { primary_quantity: '5' });

    const bad = await shortClose(orderId, {
      reason_code: 'MADE_UP',
      residual_disposition: 'returned',
    });
    assert.strictEqual(bad.status, 422, JSON.stringify(bad.body));
    assert.strictEqual(bad.body['error_code'], 'SHORT_CLOSE_REASON_CODE_INVALID');

    const missing = await shortClose(orderId, { residual_disposition: 'returned' });
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'REASON_CODE_REQUIRED');

    const badDisposition = await shortClose(orderId, {
      reason_code: 'YIELD_SHORTFALL',
      residual_disposition: 'burned',
    });
    assert.strictEqual(badDisposition.status, 400, JSON.stringify(badDisposition.body));
    assert.strictEqual(badDisposition.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC7: the linked rework order
  // -------------------------------------------------------------------------

  it('AC7: a rework order is raised from the real QC reject-to-rework path, links to the source lot, and refuses a second raise', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    const posted = await postCompletion(orderId, { primary_quantity: '10' });
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));
    const primary = (posted.body['outputs'] as Record<string, unknown>[])[0]!;
    const taskId = primary['qc_task_id'] as string;

    // Drive the completed lot through the Epic 8 gate: sample, fail one unit, complete the
    // inspection, reject the lot (which opens the NCR) and record a rework outcome. This is the
    // real producer-to-QC-to-rework chain AC7 describes, not a synthetic stand-in.
    const sampling = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/sampling`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(sampling.status, 201, JSON.stringify(sampling.body));
    const sampleSize = (sampling.body['sampling'] as Record<string, unknown>)[
      'sample_size'
    ] as number;
    const characteristics = await getPool().query(
      `SELECT c.characteristic_id
         FROM inspection_plan_characteristic c
         JOIN qc_inspection_task t ON t.plan_version_id = c.plan_version_id
        WHERE t.task_id = $1 ORDER BY c.line_no LIMIT 1`,
      [taskId],
    );
    const characteristicId = characteristics.rows[0]!['characteristic_id'] as string;
    const readings = Array.from({ length: sampleSize }, (_unused, index) => ({
      sample_unit_no: index + 1,
      attribute_conforms: index !== 0,
    }));
    const observations = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/observations`,
      { characteristic_id: characteristicId, readings },
      inspectorHeaders,
    );
    assert.strictEqual(observations.status, 201, JSON.stringify(observations.body));
    const inspectionCompletion = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/inspection-completion`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(inspectionCompletion.status, 201, JSON.stringify(inspectionCompletion.body));

    const rejected = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      { disposition: 'reject', justification: 'Story 6.3 rework path' },
      qcHeadHeaders,
    );
    assert.strictEqual(rejected.status, 201, JSON.stringify(rejected.body));
    const ncrId = (rejected.body['ncr'] as Record<string, unknown>)['ncr_id'] as string;

    const outcome = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/ncrs/${ncrId}/outcome`,
      { outcome: 'rework', outcome_reason: 'Reworkable surface defect' },
      qcHeadHeaders,
    );
    assert.strictEqual(outcome.status, 201, JSON.stringify(outcome.body));

    const reworkEvent = await getPool().query(
      `SELECT event_id FROM domain_events WHERE event_type = 'qc.rework_requested'
        AND payload->>'lot_id' = $1 LIMIT 1`,
      [primary['lot_id']],
    );
    assert.strictEqual(
      reworkEvent.rows.length,
      1,
      'the NCR rework outcome must persist the qc.rework_requested integration contract',
    );
    const reworkEventId = reworkEvent.rows[0]!['event_id'] as string;

    const raised = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders/rework',
      { source_rework_event_id: reworkEventId, idempotency_key: randomUUID() },
      plannerHeaders,
    );
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    assert.strictEqual(raised.body['source_lot_id'], primary['lot_id']);
    assert.strictEqual(raised.body['source_lot_number'], primary['lot_number']);
    assert.strictEqual(raised.body['ncr_id'], ncrId);
    const reworkOrderId = raised.body['production_order_id'] as string;
    const reworkOrder = await orderRow(reworkOrderId);
    assert.strictEqual(reworkOrder['source_rework_event_id'], reworkEventId);
    assert.strictEqual(reworkOrder['source_lot_id'], primary['lot_id']);
    assert.strictEqual(reworkOrder['status'], 'planned');
    assert.strictEqual(reworkOrder['output_item_id'], fx.itemOut);
    assert.strictEqual(reworkOrder['source_reference_id'], ncrId);
    assert.notStrictEqual(reworkOrder['order_number_ext'], null);

    // AC7: the rework order's own output re-enters the QC gate with no special-casing, because it
    // completes through exactly the same path as any other order.
    await receiveStock(fx.componentSku, binLocId, 100);
    for (const [path, body] of [
      [`/api/v1/production-orders/${reworkOrderId}/release`, {}],
      [
        `/api/v1/production-orders/${reworkOrderId}/confirmations`,
        { confirmed_quantity: String(reworkOrder['order_quantity']) },
      ],
      [`/api/v1/production-orders/${reworkOrderId}/transition`, { new_status: 'in_process' }],
    ] as [string, Record<string, unknown>][]) {
      const step = await makeRequest(
        port,
        'POST',
        path,
        { idempotency_key: randomUUID(), ...body },
        plannerHeaders,
      );
      assert.strictEqual(step.status, 200, `${path}: ${JSON.stringify(step.body)}`);
    }
    const reworkCompletion = await postCompletion(reworkOrderId, { primary_quantity: '10' });
    assert.strictEqual(reworkCompletion.status, 201, JSON.stringify(reworkCompletion.body));
    const reworkOutput = (reworkCompletion.body['outputs'] as Record<string, unknown>[])[0]!;
    const reworkTask = await taskForLot(reworkOutput['lot_id'] as string);
    assert.ok(reworkTask, 'the rework output has its own inspection task');
    assert.strictEqual(reworkTask!['gate_status'], 'qc_hold');
    assert.notStrictEqual(reworkOutput['lot_id'], primary['lot_id'], 'a NEW linked lot');

    const again = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders/rework',
      { source_rework_event_id: reworkEventId, idempotency_key: randomUUID() },
      plannerHeaders,
    );
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'REWORK_ORDER_EXISTS');
  });

  it('AC7: an event that is not a qc.rework_requested cannot be used as a rework linkage', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    const someEvent = await getPool().query(
      `SELECT event_id FROM domain_events WHERE stream_id = $1 LIMIT 1`,
      [orderId],
    );
    const raised = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders/rework',
      {
        source_rework_event_id: someEvent.rows[0]!['event_id'],
        idempotency_key: randomUUID(),
      },
      plannerHeaders,
    );
    assert.strictEqual(raised.status, 404, JSON.stringify(raised.body));
    assert.strictEqual(raised.body['error_code'], 'REWORK_EVENT_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // State gate, replay, direct-event bypass, RBAC and scoping
  // -------------------------------------------------------------------------

  it('the status gate is in_process only: a released order cannot be completed, scrapped or short-closed', async () => {
    const fx = await fixture(false);
    await receiveStock(fx.componentSku, binLocId, 100);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID() },
      plannerHeaders,
    );

    for (const [label, result] of [
      ['completion', await postCompletion(orderId, { primary_quantity: '1' })],
      ['scrap', await declareScrap(orderId, { scrap_quantity: '1', reason_code: 'PROCESS_LOSS' })],
      [
        'short close',
        await shortClose(
          orderId,
          { reason_code: 'YIELD_SHORTFALL', residual_disposition: 'returned' },
          supervisorHeaders,
        ),
      ],
    ] as [string, HttpResult][]) {
      assert.strictEqual(result.status, 400, `${label}: ${JSON.stringify(result.body)}`);
      assert.strictEqual(result.body['error_code'], 'INVALID_STATE_TRANSITION');
    }
  });

  it('a same-key replay of each write returns the stored event and posts nothing twice', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    const key = randomUUID();

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/completions`,
      { idempotency_key: key, primary_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/completions`,
      { idempotency_key: key, primary_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual((await completionRows(orderId)).length, 1, 'exactly one completion row');

    const scrapKey = randomUUID();
    const scrapOne = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/scrap-declarations`,
      { idempotency_key: scrapKey, scrap_quantity: '1', reason_code: 'PROCESS_LOSS' },
      plannerHeaders,
    );
    assert.strictEqual(scrapOne.status, 201, JSON.stringify(scrapOne.body));
    const scrapTwo = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/scrap-declarations`,
      { idempotency_key: scrapKey, scrap_quantity: '1', reason_code: 'PROCESS_LOSS' },
      plannerHeaders,
    );
    assert.strictEqual(scrapTwo.status, 200, JSON.stringify(scrapTwo.body));
    const scrapRows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM production_scrap_declaration WHERE production_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(Number(scrapRows.rows[0]!['n']), 1, 'exactly one scrap declaration');
  });

  it('AD-12: a forged direct event cannot declare the server-derived fields or bypass the plant scope', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);

    const forgedOutputs = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.completion_posted',
        payload: {
          production_order_id: orderId,
          primary_quantity: '1',
          completed_at: '2026-07-15T10:00:00.000+05:30',
          outputs: [{ completion_id: randomUUID() }],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(forgedOutputs.status, 409, JSON.stringify(forgedOutputs.body));
    assert.strictEqual(
      forgedOutputs.body['error_code'],
      'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
    );

    const forgedRevision = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.completion_posted',
        payload: {
          production_order_id: orderId,
          primary_quantity: '1',
          completed_at: '2026-07-15T10:00:00.000+05:30',
          revision_id: randomUUID(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(forgedRevision.status, 409, JSON.stringify(forgedRevision.body));
    assert.strictEqual(forgedRevision.body['error_code'], 'BOM_REVISION_DRIFT');

    // A scoped actor cannot reach another plant's order through the direct-event path either.
    const foreignActor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.scrap_declared',
        payload: {
          production_order_id: orderId,
          scrap_quantity: '1',
          reason_code: 'PROCESS_LOSS',
          declared_at: '2026-07-15T10:00:00.000+05:30',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: plannerUserId,
            role: 'production_planner',
            location_id: otherSiteLocId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(foreignActor.status, 403, JSON.stringify(foreignActor.body));
    assert.strictEqual(foreignActor.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('RBAC and plant scoping: a reader cannot write and a foreign-plant writer is denied', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);

    const readerWrite = await postCompletion(orderId, { primary_quantity: '1' }, readerHeaders);
    assert.strictEqual(readerWrite.status, 403, JSON.stringify(readerWrite.body));

    const foreign = await postCompletion(orderId, { primary_quantity: '1' }, scopedPlannerHeaders);
    assert.strictEqual(foreign.status, 403, JSON.stringify(foreign.body));
    assert.strictEqual(foreign.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('the completions read surface lists every output lot and the scrap declarations of the order', async () => {
    const fx = await fixture(true);
    const orderId = await runningOrder(fx);
    // Scrap is declared DURING the run, while WIP is still open. A completion at the full ordered
    // quantity relieves all remaining WIP, and an order with no open WIP has nothing left to scrap
    // (code review 2026-08-31: SCRAP_EXCEEDS_WIP now covers the zero-balance case too).
    const scrapped = await declareScrap(orderId, {
      scrap_quantity: '1',
      reason_code: 'SETUP_REJECT',
    });
    assert.strictEqual(scrapped.status, 201, JSON.stringify(scrapped.body));
    await postCompletion(orderId, { primary_quantity: '10' });

    const listed = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}/completions`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
    assert.strictEqual((listed.body['completions'] as unknown[]).length, 3);
    assert.strictEqual((listed.body['scrap_declarations'] as unknown[]).length, 1);
    await assertNumericEqual(
      String(listed.body['completed_quantity']),
      '10',
      'the read surface reports the primary completed quantity',
    );
  });

  it('a scrap declaration against an order with no open WIP is refused, not silently written', async () => {
    // Code review 2026-08-31: scrap_value computed to 0 against a zero balance, so the
    // `exceeds` comparison was 0 > 0 = false and a declaration claiming scrap while relieving
    // nothing was accepted - while a SMALLER scrap against a nonzero balance was correctly
    // rejected. The guard now covers the zero case it was inconsistent about.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    // Completing the full ordered quantity relieves every open posting ('all' mode).
    const completed = await postCompletion(orderId, { primary_quantity: '10' });
    assert.strictEqual(completed.status, 201, JSON.stringify(completed.body));
    const wip = await wipSummaryDb(orderId);
    await assertNumericEqual(wip.net_open_value, '0', 'WIP is fully relieved');

    const refused = await declareScrap(orderId, {
      scrap_quantity: '1',
      reason_code: 'PROCESS_LOSS',
    });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body['error_code'], 'SCRAP_EXCEEDS_WIP');
    await assertNumericEqual(
      String((refused.body['details'] as Record<string, unknown>)['open_wip_value']),
      '0',
      'the rejection reports the zero balance',
    );
    const rows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM production_scrap_declaration WHERE production_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(Number(rows.rows[0]!['n']), 0, 'no declaration was written');
  });

  it('re-applying the same scrap event cannot write a second declaration, and scrapped_quantity is absolute', async () => {
    // Code review 2026-08-31: scrap_id is server-minted per call, so the primary key alone could
    // not make a re-applied event collide; uq_production_scrap_declaration_event is the grain.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    const declared = await declareScrap(orderId, {
      scrap_quantity: '2',
      reason_code: 'PROCESS_LOSS',
    });
    assert.strictEqual(declared.status, 201, JSON.stringify(declared.body));

    const order = await orderRow(orderId);
    await assertNumericEqual(String(order['scrapped_quantity']), '2', 'scrapped_quantity');

    // A direct event carrying the SAME source event identity collides on the grain rather than
    // appending a second row and double-counting the aggregate.
    const eventRow = await getPool().query(
      `SELECT source_event_id FROM production_scrap_declaration WHERE production_order_id = $1`,
      [orderId],
    );
    const sourceEventId = eventRow.rows[0]!['source_event_id'] as string;
    const replayed = await getPool()
      .query(
        `INSERT INTO production_scrap_declaration (
           scrap_id, production_order_id, scrap_quantity, uom, reason_code, relieved_value,
           business_date, declared_by, declared_at, source_event_id
         ) SELECT gen_random_uuid(), production_order_id, scrap_quantity, uom, reason_code,
                  relieved_value, business_date, declared_by, declared_at, source_event_id
             FROM production_scrap_declaration WHERE source_event_id = $1`,
        [sourceEventId],
      )
      .then(() => null)
      .catch((err: { code?: string; constraint?: string }) => err);
    assert.ok(replayed, 'a second row for the same source event must be refused');
    assert.strictEqual((replayed as { code?: string }).code, '23505');
    assert.strictEqual(
      (replayed as { constraint?: string }).constraint,
      'uq_production_scrap_declaration_event',
    );
  });

  it('authorisation precedes the replay short-circuit: a foreign-plant caller with a known idempotency key is denied, not answered', async () => {
    // Code review 2026-08-31: the replay used to answer before the plant check, so a caller
    // holding production write at another plant who supplied a used idempotency key received 200
    // and the full stored payload - lot ids, lot numbers and cost postings included.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    const key = randomUUID();
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/completions`,
      { idempotency_key: key, primary_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const foreign = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/completions`,
      { idempotency_key: key, primary_quantity: '5' },
      scopedPlannerHeaders,
    );
    assert.strictEqual(foreign.status, 403, JSON.stringify(foreign.body));
    assert.strictEqual(foreign.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.strictEqual(foreign.body['outputs'], undefined, 'no payload leaks to a denied caller');
  });

  it('RBAC and plant scoping are enforced on every route, not just completions', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    await postCompletion(orderId, { primary_quantity: '5' });

    const scrapBody = { scrap_quantity: '1', reason_code: 'PROCESS_LOSS' };
    const shortBody = { reason_code: 'YIELD_SHORTFALL', residual_disposition: 'returned' };

    for (const [label, reader, foreign] of [
      [
        'scrap-declarations',
        await declareScrap(orderId, scrapBody, readerHeaders),
        await declareScrap(orderId, scrapBody, scopedPlannerHeaders),
      ],
      [
        'short-close',
        await shortClose(orderId, shortBody, readerHeaders),
        await shortClose(orderId, shortBody, scopedPlannerHeaders),
      ],
    ] as [string, HttpResult, HttpResult][]) {
      assert.strictEqual(reader.status, 403, `${label} reader: ${JSON.stringify(reader.body)}`);
      assert.strictEqual(foreign.status, 403, `${label} foreign: ${JSON.stringify(foreign.body)}`);
      assert.strictEqual(foreign.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }

    // The read route must reject a foreign-plant reader too.
    const foreignRead = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}/completions`,
      undefined,
      scopedPlannerHeaders,
    );
    assert.strictEqual(foreignRead.status, 403, JSON.stringify(foreignRead.body));
    assert.strictEqual(foreignRead.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // The rework route authorises before it leaks any identifier.
    const reworkReader = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders/rework',
      { source_rework_event_id: randomUUID(), idempotency_key: randomUUID() },
      readerHeaders,
    );
    assert.strictEqual(reworkReader.status, 403, JSON.stringify(reworkReader.body));

    // Nothing was written by any of the denied attempts.
    const rows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM production_scrap_declaration WHERE production_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(Number(rows.rows[0]!['n']), 0);
    const order = await orderRow(orderId);
    assert.strictEqual(order['short_closed_at'], null, 'no close-short decision was recorded');
  });

  it('an unknown order is 404 and a non-UUID order id is 400 on the scrap and short-close routes too', async () => {
    const missingOrder = randomUUID();
    for (const [label, result] of [
      [
        'scrap',
        await declareScrap(missingOrder, { scrap_quantity: '1', reason_code: 'PROCESS_LOSS' }),
      ],
      [
        'short-close',
        await shortClose(missingOrder, {
          reason_code: 'YIELD_SHORTFALL',
          residual_disposition: 'returned',
        }),
      ],
    ] as [string, HttpResult][]) {
      assert.strictEqual(result.status, 404, `${label}: ${JSON.stringify(result.body)}`);
      assert.strictEqual(result.body['error_code'], 'PRODUCTION_ORDER_NOT_FOUND');
    }

    for (const path of ['scrap-declarations', 'short-close']) {
      const malformed = await makeRequest(
        port,
        'POST',
        `/api/v1/production-orders/not-a-uuid/${path}`,
        { idempotency_key: randomUUID(), scrap_quantity: '1', reason_code: 'PROCESS_LOSS' },
        plannerHeaders,
      );
      assert.strictEqual(malformed.status, 400, `${path}: ${JSON.stringify(malformed.body)}`);
      assert.strictEqual(malformed.body['error_code'], 'INVALID_PARAMS');
    }
  });

  it('a replay returns the STORED payload, and a key reused across orders is refused', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    const key = randomUUID();
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/completions`,
      { idempotency_key: key, primary_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstLot = (first.body['outputs'] as Record<string, unknown>[])[0]!['lot_id'];

    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/completions`,
      { idempotency_key: key, primary_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    // The BODY must be the stored event, not merely a 200 (code review 2026-08-31: returning an
    // empty object satisfied the previous assertion).
    assert.strictEqual(
      (replay.body['outputs'] as Record<string, unknown>[])[0]!['lot_id'],
      firstLot,
      'the replay returns the stored outputs',
    );
    assert.strictEqual(replay.body['completed_by'], plannerUserId);

    // The 6.1 Group B lesson: the same key on a DIFFERENT order must not return the first order's
    // payload. Deleting the stream_id clause from replayIdOrReject makes this fail.
    const otherFx = await fixture(false);
    const otherOrderId = await runningOrder(otherFx, '10', '10', 200);
    const crossOrder = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${otherOrderId}/completions`,
      { idempotency_key: key, primary_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(crossOrder.status, 409, JSON.stringify(crossOrder.body));
    assert.strictEqual(crossOrder.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(
      (await completionRows(otherOrderId)).length,
      0,
      'the foreign key reuse wrote nothing to the second order',
    );
  });

  it('a same-key replay of the short-close route returns the stored decision', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 200);
    await postCompletion(orderId, { primary_quantity: '5' });
    const key = randomUUID();
    const body = { reason_code: 'YIELD_SHORTFALL', residual_disposition: 'returned' };
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/short-close`,
      { idempotency_key: key, ...body },
      supervisorHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/short-close`,
      { idempotency_key: key, ...body },
      supervisorHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['reason_code'], 'YIELD_SHORTFALL');
    assert.strictEqual(replay.body['short_closed_by'], supervisorUserId);
  });

  it('AC6: a close-short decision requires the DOA-resolved approver, acting as themselves', async () => {
    // Product-owner decision, code review 2026-08-31: a close-short writes off the entire open WIP
    // balance and now carries the same authority chain the over-completion always had.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    await postCompletion(orderId, { primary_quantity: '5' });

    const byPlanner = await shortClose(
      orderId,
      { reason_code: 'YIELD_SHORTFALL', residual_disposition: 'returned' },
      plannerHeaders,
    );
    assert.strictEqual(byPlanner.status, 403, JSON.stringify(byPlanner.body));
    assert.strictEqual(byPlanner.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(
      (byPlanner.body['details'] as Record<string, unknown>)['resolved_approver_user_id'],
      supervisorUserId,
      'the rejection names the authority that was required',
    );
    let order = await orderRow(orderId);
    assert.strictEqual(order['short_closed_at'], null, 'the unauthorised attempt recorded nothing');
    const wipStill = await wipSummaryDb(orderId);
    assert.notStrictEqual(wipStill.net_open_quantity, '0', 'no WIP was written off');

    const bySupervisor = await shortClose(orderId, {
      reason_code: 'YIELD_SHORTFALL',
      residual_disposition: 'returned',
    });
    assert.strictEqual(bySupervisor.status, 201, JSON.stringify(bySupervisor.body));
    order = await orderRow(orderId);
    assert.strictEqual(order['short_closed_by'], supervisorUserId);
  });

  it('two completions racing the tolerance ceiling: one wins, the other is blocked', async () => {
    // Task 9.4. The order lock is the serialization point BD-6 depends on; posting sequentially
    // cannot detect a lost update.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    const [a, b] = await Promise.all([
      postCompletion(orderId, { primary_quantity: '10' }),
      postCompletion(orderId, { primary_quantity: '10' }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 403],
      `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`,
    );
    const blocked = a.status === 403 ? a : b;
    assert.strictEqual(blocked.body['error_code'], 'APPROVAL_REQUIRED');
    const rows = await completionRows(orderId);
    assert.strictEqual(rows.filter((r) => r['output_class'] === 'primary').length, 1);
    const order = await orderRow(orderId);
    await assertNumericEqual(
      String(order['completed_quantity']),
      '10',
      'exactly one completion counted',
    );
  });

  it('two scrap declarations racing the last open WIP: one wins, the other is refused stably', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    const [a, b] = await Promise.all([
      declareScrap(orderId, { scrap_quantity: '9', reason_code: 'PROCESS_LOSS' }),
      declareScrap(orderId, { scrap_quantity: '9', reason_code: 'PROCESS_LOSS' }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`,
    );
    const refused = a.status === 409 ? a : b;
    assert.strictEqual(refused.body['error_code'], 'SCRAP_EXCEEDS_WIP');
    const order = await orderRow(orderId);
    await assertNumericEqual(
      String(order['scrapped_quantity']),
      '9',
      'cumulative scrap stays bounded',
    );
  });

  it('cumulative scrap cannot exceed the ordered quantity across several declarations', async () => {
    // Code review 2026-08-31: the previous guard compared a fraction of open value against open
    // value itself, which reduces to scrap_quantity > order_quantity and never consulted WIP, so
    // repeated declarations drove scrapped_quantity to multiples of the order.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    for (const quantity of ['4', '4']) {
      const ok = await declareScrap(orderId, {
        scrap_quantity: quantity,
        reason_code: 'PROCESS_LOSS',
      });
      assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    }
    const over = await declareScrap(orderId, { scrap_quantity: '4', reason_code: 'PROCESS_LOSS' });
    assert.strictEqual(over.status, 409, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'SCRAP_EXCEEDS_WIP');
    await assertNumericEqual(
      String((over.body['details'] as Record<string, unknown>)['already_scrapped']),
      '8',
      'the rejection reports the cumulative figure it bounded',
    );
    const order = await orderRow(orderId);
    await assertNumericEqual(
      String(order['scrapped_quantity']),
      '8',
      'scrapped_quantity is bounded',
    );
  });

  it('an order carrying a close-short decision accepts no further production', async () => {
    // Code review 2026-08-31: the close-short applier never advances status and no other applier
    // read short_closed_at, so an order could be short-closed and still producing.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    await postCompletion(orderId, { primary_quantity: '5' });
    const closed = await shortClose(orderId, {
      reason_code: 'YIELD_SHORTFALL',
      residual_disposition: 'scrapped',
    });
    assert.strictEqual(closed.status, 201, JSON.stringify(closed.body));

    const later = await postCompletion(orderId, { primary_quantity: '1' });
    assert.strictEqual(later.status, 400, JSON.stringify(later.body));
    assert.strictEqual(later.body['error_code'], 'INVALID_STATE_TRANSITION');
    const scrapAfter = await declareScrap(orderId, {
      scrap_quantity: '1',
      reason_code: 'PROCESS_LOSS',
    });
    assert.strictEqual(scrapAfter.status, 400, JSON.stringify(scrapAfter.body));
    const order = await orderRow(orderId);
    await assertNumericEqual(
      String(order['completed_quantity']),
      '5',
      'the settled quantity was not overwritten',
    );
  });

  it('AD-12: a forged production_order.created cannot fabricate a rework linkage', async () => {
    // Task 9.4 names this case explicitly. Deleting the applier-side linkage validation in
    // src/compliance/production-order.ts makes it fail.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    const someEvent = await getPool().query(
      `SELECT event_id FROM domain_events WHERE stream_id = $1 LIMIT 1`,
      [orderId],
    );
    const forgedOrderId = randomUUID();
    const forged = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: forgedOrderId,
        event_type: 'production_order.created',
        payload: {
          production_order_id: forgedOrderId,
          order_number_ext: '',
          output_item_id: fx.itemOut,
          output_sku: fx.outSku,
          order_quantity: '1',
          order_uom: 'EA',
          plant_location_id: siteLocId,
          bom_id: fx.bom.bomId,
          business_stream: 'production',
          source_reference_type: 'manual',
          source_reference_id: `FORGED-${run}`,
          created_by: plannerUserId,
          created_at: new Date().toISOString(),
          source_rework_event_id: someEvent.rows[0]!['event_id'],
          source_lot_id: randomUUID(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(forged.status, 404, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'REWORK_EVENT_NOT_FOUND');
    const written = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM production_order WHERE production_order_id = $1`,
      [forgedOrderId],
    );
    assert.strictEqual(Number(written.rows[0]!['n']), 0, 'no order was created');
  });

  it('AD-12: a forged short_close_recorded is plant-scoped and derivation-checked on the direct path', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    await postCompletion(orderId, { primary_quantity: '5' });

    const foreignActor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.short_close_recorded',
        payload: {
          production_order_id: orderId,
          reason_code: 'YIELD_SHORTFALL',
          residual_disposition: 'returned',
          decided_at: '2026-07-15T10:00:00.000+05:30',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: plannerUserId,
            role: 'production_planner',
            location_id: otherSiteLocId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(foreignActor.status, 403, JSON.stringify(foreignActor.body));
    assert.strictEqual(foreignActor.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const forgedWriteBack = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.short_close_recorded',
        payload: {
          production_order_id: orderId,
          reason_code: 'YIELD_SHORTFALL',
          residual_disposition: 'returned',
          decided_at: '2026-07-15T10:00:00.000+05:30',
          relieved_value: '999.999',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(forgedWriteBack.status, 409, JSON.stringify(forgedWriteBack.body));
    assert.strictEqual(
      forgedWriteBack.body['error_code'],
      'PRODUCTION_COMPLETION_DERIVATION_MISMATCH',
    );
    const order = await orderRow(orderId);
    assert.strictEqual(order['short_closed_at'], null, 'neither forgery recorded a decision');
  });

  it('an over-completion with no governing DOA entry is refused APPROVAL_UNRESOLVED', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    const removed = await getAdminPool().query(
      `DELETE FROM doa_registry_entries WHERE transaction_type = 'production_order.over_completion'
        RETURNING entry_id, role, value_min, value_max, active`,
    );
    try {
      const blocked = await postCompletion(
        orderId,
        {
          primary_quantity: '12',
          over_completion_approved: true,
          approved_by: supervisorUserId,
        },
        supervisorHeaders,
      );
      assert.strictEqual(blocked.status, 404, JSON.stringify(blocked.body));
      assert.strictEqual(blocked.body['error_code'], 'APPROVAL_UNRESOLVED');
      assert.strictEqual((await completionRows(orderId)).length, 0);
    } finally {
      for (const row of removed.rows) {
        await getAdminPool().query(
          `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
           VALUES ($1, $2, 'production_order.over_completion', $3, $4, $5)`,
          [row['entry_id'], row['role'], row['value_min'], row['value_max'], row['active']],
        );
      }
    }
  });

  it('a redundant approval flag on a within-tolerance completion is not recorded as an over-completion', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    const posted = await postCompletion(
      orderId,
      { primary_quantity: '5', over_completion_approved: true, approved_by: supervisorUserId },
      supervisorHeaders,
    );
    assert.strictEqual(posted.status, 201, JSON.stringify(posted.body));
    assert.strictEqual(posted.body['over_completion_approved'], false);
    assert.strictEqual(posted.body['approved_by'], null);
    const rows = await completionRows(orderId);
    assert.strictEqual(rows[0]!['over_completion_approved'], false);
    assert.strictEqual(rows[0]!['approved_by'], null);
  });

  it('a BOM revision that moved after release blocks completion', async () => {
    // Code review 2026-08-31: the drift check compared the pinned revision against itself and
    // could never fire; an ECO that moved bom.current_revision_id was invisible.
    const fx = await fixture(false);
    const orderId = await runningOrder(fx, '10', '10', 400);
    const moved = randomUUID();
    await getAdminPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, source_event_id)
       SELECT $1, bom_id, 'B', revision_status, drafted_by, source_event_id
         FROM bom_revision WHERE revision_id = $2`,
      [moved, fx.bom.revisionId],
    );
    await getAdminPool().query(`UPDATE bom SET current_revision_id = $1 WHERE bom_id = $2`, [
      moved,
      fx.bom.bomId,
    ]);
    try {
      const blocked = await postCompletion(orderId, { primary_quantity: '5' });
      assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
      assert.strictEqual(blocked.body['error_code'], 'BOM_REVISION_DRIFT');
      assert.strictEqual(
        (blocked.body['details'] as Record<string, unknown>)['current_revision_id'],
        moved,
        'the rejection names the revision that moved',
      );
      assert.strictEqual((await completionRows(orderId)).length, 0);
    } finally {
      await getAdminPool().query(`UPDATE bom SET current_revision_id = $1 WHERE bom_id = $2`, [
        fx.bom.revisionId,
        fx.bom.bomId,
      ]);
    }
  });

  it('list bounds are rejected rather than silently reinterpreted', async () => {
    const fx = await fixture(false);
    const orderId = await runningOrder(fx);
    for (const query of ['limit=0', 'limit=abc', 'limit=500', 'offset=-1']) {
      const result = await makeRequest(
        port,
        'GET',
        `/api/v1/production-orders/${orderId}/completions?${query}`,
        undefined,
        readerHeaders,
      );
      assert.strictEqual(result.status, 400, `${query}: ${JSON.stringify(result.body)}`);
      assert.strictEqual(result.body['error_code'], 'INVALID_PARAMS');
    }
    const ok = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${orderId}/completions?limit=1&offset=0`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });

  it('an unknown order is 404 and a non-UUID order id is 400 on every write route', async () => {
    const missing = await postCompletion(randomUUID(), { primary_quantity: '1' });
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'PRODUCTION_ORDER_NOT_FOUND');

    const malformed = await makeRequest(
      port,
      'POST',
      '/api/v1/production-orders/not-a-uuid/completions',
      { idempotency_key: randomUUID(), primary_quantity: '1' },
      plannerHeaders,
    );
    assert.strictEqual(malformed.status, 400, JSON.stringify(malformed.body));
    assert.strictEqual(malformed.body['error_code'], 'INVALID_PARAMS');
  });
});

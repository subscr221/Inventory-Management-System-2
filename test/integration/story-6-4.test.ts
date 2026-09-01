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
 * Story 6.4: Lot Genealogy, Closure, and Offline Execution (FR-MO-11/12/13, FR-B-08).
 *
 * Bootstrapped from story-6-3.test.ts (same harness, helpers and seeding discipline) and extended
 * with the consumption variance projection, a lot-controlled component and a QC APPROVER identity
 * distinct from the inspector - the Story 8.3 SOD amendment rejects an accept disposition taken by
 * a user who recorded the results, so a closure test that shares one identity proves nothing about
 * closure and everything about SOD.
 *
 * Seeding discipline carried from 6.2/6.3: every stock receipt is PRICED so the Story 2.4 running
 * average resolves (an unpriced seed trips WIP_COST_UNRESOLVED and hides the behaviour under test),
 * and component stock is received WITH lot numbers so the genealogy under test has real lots to
 * report rather than a column of nulls.
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

describe('Story 6.4 Lot Genealogy, Closure, and Offline Execution', () => {
  let server: Server;
  let port: number;

  let plannerUserId: string;
  let plannerHeaders: Record<string, string>;
  let supervisorHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;
  let scopedPlannerHeaders: Record<string, string>;
  let deviceHeaders: Record<string, string>;

  let siteLocId: string;
  let zoneLocId: string;
  let binLocId: string;
  let otherSiteLocId: string;

  // -------------------------------------------------------------------------
  // Fixture helpers (the 6.3 set, verbatim where unchanged)
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
      quantity_per: '1.0',
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
    lotNumber: string | null = null,
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
          ...(lotNumber !== null ? { lot_id: lotNumber, expiry_date: '2030-12-31' } : {}),
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

  async function varianceRows(orderId: string): Promise<Record<string, unknown>[]> {
    const result = await getPool().query(
      `SELECT * FROM production_consumption_variance WHERE production_order_id = $1
        ORDER BY component_sku ASC`,
      [orderId],
    );
    return result.rows as Record<string, unknown>[];
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

  /** Scoped to the order, the actor and the endpoint (the 6.3 helper, verbatim). */
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

  async function approvePlanFor(itemId: string, revisionId: string): Promise<string[]> {
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
    return (created.body['characteristics'] as Array<Record<string, unknown>>).map(
      (c) => c['characteristic_id'] as string,
    );
  }

  interface Fixture {
    itemOut: string;
    outSku: string;
    componentSku: string;
    componentItemId: string;
    componentLineId: string;
    directedSku: string;
    directedItemId: string;
    directedLineId: string;
    coItemId?: string;
    coLineId?: string;
    characteristicIds: string[];
    bom: { bomId: string; revisionId: string };
  }

  let fixtureCounter = 0;

  /**
   * A released BOM with one backflush component and one directed-issue component, so both consumption
   * paths appear in the genealogy and in the variance report, plus an optional co-product so the
   * multi-output-lot genealogy decision is exercised. Every output item gets an APPROVED inspection
   * plan against the SAME released revision (the Story 8.1 grain).
   */
  async function fixture(
    withCoProduct: boolean = false,
    componentScrapPercent: string = '0.0',
    lotControlledDirected: boolean = false,
  ): Promise<Fixture> {
    fixtureCounter += 1;
    const suffix = `${run}-${fixtureCounter}`;
    const itemOut = await createItem(`FG-6-4-${suffix}`);
    const itemComponent = await createItem(`C-6-4-${suffix}`);
    const itemDirected = await createItem(
      `D-6-4-${suffix}`,
      lotControlledDirected ? { lot_controlled: true } : {},
    );
    const lines: Record<string, unknown>[] = [
      componentLine(1, itemComponent, {
        supply_method: 'backflush',
        scrap_percent: componentScrapPercent,
      }),
      componentLine(2, itemDirected),
    ];
    let coItemId: string | undefined;
    let coRevisionId: string | undefined;
    if (withCoProduct) {
      coItemId = await createItem(`CO-6-4-${suffix}`);
      const coSpecComponent = await createItem(`COC-6-4-${suffix}`);
      coRevisionId = (await draftAndRelease(coItemId, [componentLine(1, coSpecComponent)]))
        .revisionId;
      lines.push(outputLine(3, coItemId, 'co_product', '50.0'));
    }
    const bom = await draftAndRelease(itemOut, lines);
    const lineIds = await bomLineIds(bom.revisionId);
    const characteristicIds = await approvePlanFor(itemOut, bom.revisionId);
    if (coItemId && coRevisionId) await approvePlanFor(coItemId, coRevisionId);
    const result: Fixture = {
      itemOut,
      outSku: await skuOf(itemOut),
      componentSku: await skuOf(itemComponent),
      componentItemId: itemComponent,
      componentLineId: lineIds.get(1)!,
      directedSku: await skuOf(itemDirected),
      directedItemId: itemDirected,
      directedLineId: lineIds.get(2)!,
      characteristicIds,
      bom,
    };
    if (coItemId) {
      result.coItemId = coItemId;
      result.coLineId = lineIds.get(3)!;
    }
    return result;
  }

  interface RunningOrder {
    orderId: string;
    componentLotNumber: string;
    directedLotNumber: string;
    stageId: string;
  }

  /**
   * Drives a fixture to an in_process order with WIP open: both components received priced AND
   * lotted, the order created and released, the directed line staged and issued, the backflush line
   * consumed by a confirmation, and the order transitioned to in_process.
   */
  async function runningOrder(
    fx: Fixture,
    orderQuantity: string = '10',
    confirmQuantity: string = '10',
    options: { stageOnly?: boolean; skipDirectedLot?: boolean } = {},
  ): Promise<RunningOrder> {
    const componentLotNumber = `LOT-C-${randomUUID().slice(0, 8)}`;
    const directedLotNumber = `LOT-D-${randomUUID().slice(0, 8)}`;
    await receiveStock(fx.componentSku, binLocId, 100, 5, componentLotNumber);
    // A DIFFERENT unit cost from the backflush component, so a relief posting written at today's
    // average instead of the source posting's cost is detectable (the 6.3 BD-8 discipline).
    await receiveStock(fx.directedSku, binLocId, 100, 11, directedLotNumber);
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
    const staged = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      {
        idempotency_key: randomUUID(),
        lines: [
          {
            bom_line_id: fx.directedLineId,
            source_location_id: binLocId,
            ...(options.skipDirectedLot === true ? {} : { lot_number: directedLotNumber }),
          },
        ],
      },
      plannerHeaders,
    );
    assert.strictEqual(staged.status, 201, JSON.stringify(staged.body));
    const stageId = (staged.body['lines'] as Record<string, unknown>[])[0]!['stage_id'] as string;
    if (options.stageOnly !== true) {
      const issued = await makeRequest(
        port,
        'POST',
        `/api/v1/production-orders/${orderId}/material-issues`,
        { idempotency_key: randomUUID(), stage_id: stageId, quantity: orderQuantity },
        plannerHeaders,
      );
      assert.strictEqual(issued.status, 200, JSON.stringify(issued.body));
    }
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
    return { orderId, componentLotNumber, directedLotNumber, stageId };
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

  function transition(
    orderId: string,
    newStatus: string,
    headers: Record<string, string> = plannerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/transition`,
      { new_status: newStatus, idempotency_key: randomUUID() },
      headers,
    );
  }

  /**
   * Drives one output lot's QC task from qc_hold to an ACCEPT disposition. The inspector records
   * the results and a DIFFERENT approver takes the decision: the Story 8.3 SOD amendment rejects an
   * accept taken by a known result recorder with SOD_VIOLATION.
   */
  async function acceptLot(taskId: string, characteristicId: string): Promise<void> {
    const determination = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/sampling`,
      {},
      inspectorHeaders,
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
      `/api/v1/qc/tasks/${taskId}/observations`,
      { characteristic_id: characteristicId, readings },
      inspectorHeaders,
    );
    assert.strictEqual(obs.status, 201, JSON.stringify(obs.body));
    const completion = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/inspection-completion`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(completion.status, 201, JSON.stringify(completion.body));
    const disposed = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      { disposition: 'accept', justification: 'Story 6.4 closure fixture' },
      approverHeaders,
    );
    assert.strictEqual(disposed.status, 201, JSON.stringify(disposed.body));
  }

  /** Every output lot of the order accepted, so only the other two gate checks can block closure. */
  async function acceptEveryOutputLot(fx: Fixture, orderId: string): Promise<void> {
    for (const row of await completionRows(orderId)) {
      const characteristicId =
        row['output_class'] === 'primary'
          ? fx.characteristicIds[0]!
          : ((
              await getPool().query(
                `SELECT c.characteristic_id
                   FROM qc_inspection_task t
                   JOIN inspection_plan_characteristic c ON c.plan_version_id = t.plan_version_id
                  WHERE t.task_id = $1 ORDER BY c.line_no LIMIT 1`,
                [row['qc_task_id']],
              )
            ).rows[0]!['characteristic_id'] as string);
      await acceptLot(row['qc_task_id'] as string, characteristicId);
    }
  }

  /** A fully consumed, fully completed, fully dispositioned order sitting in `completed`. */
  async function closeableOrder(fx: Fixture, orderQuantity: string = '10'): Promise<RunningOrder> {
    const running = await runningOrder(fx, orderQuantity, orderQuantity);
    const completed = await postCompletion(running.orderId, { primary_quantity: orderQuantity });
    assert.strictEqual(completed.status, 201, JSON.stringify(completed.body));
    await acceptEveryOutputLot(fx, running.orderId);
    const toCompleted = await transition(running.orderId, 'completed');
    assert.strictEqual(toCompleted.status, 200, JSON.stringify(toCompleted.body));
    return running;
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
      '../../read/projections/production_consumption_variance.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE production_consumption_variance, production_completion, production_scrap_declaration, production_order_stage, production_wip_ledger, production_order, qc_retention_sample, qc_batch_release, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, supplier_scorecard_metric, supplier, bom_alternate, bom_explosion, bom_explosion_line, bom_cost_rollup_line, bom_cost_rollup, bom_outbound_message, bom_structure, bom_line, bom_revision, bom, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, integration_exception, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteLocId = await seedLocation('site', `PLANT-64-${run}`, null, null);
    zoneLocId = await seedLocation('zone', `ZONE-64-${run}`, siteLocId, siteLocId);
    binLocId = await seedLocation('bin', `BIN-64-${run}`, zoneLocId, siteLocId);
    void zoneLocId;
    otherSiteLocId = await seedLocation('site', `PLANT-OTHER-64-${run}`, null, null);

    plannerUserId = await provisionUser(port, `planner-6-4-${run}@example.com`, [
      { role: 'production_planner', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_planner', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, `planner-6-4-${run}@example.com`);

    await provisionUser(port, `supervisor-6-4-${run}@example.com`, [
      { role: 'production_manager', module: 'production', functionScope: 'write', locationId: '*' },
      { role: 'production_manager', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    supervisorHeaders = await authFor(port, `supervisor-6-4-${run}@example.com`);

    await provisionUser(port, `scoped-6-4-${run}@example.com`, [
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
    scopedPlannerHeaders = await authFor(port, `scoped-6-4-${run}@example.com`);

    await provisionUser(port, `engineer-6-4-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    engineerHeaders = await authFor(port, `engineer-6-4-${run}@example.com`);

    await provisionUser(port, `compliance-6-4-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-6-4-${run}@example.com`);

    await provisionUser(port, `qc-inspector-6-4-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-6-4-${run}@example.com`);

    await provisionUser(port, `qc-head-6-4-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-6-4-${run}@example.com`);

    // The Story 8.3 SOD amendment: an ACCEPT disposition may not be taken by a user who recorded
    // the results, so the approver is a distinct identity from the inspector above.
    await provisionUser(port, `qc-approver-6-4-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `qc-approver-6-4-${run}@example.com`);

    // The plant device identity used for the FR-MO-13 edge-upload assertions.
    await provisionUser(port, `device-6-4-${run}@example.com`, [
      {
        role: 'production_operator',
        module: 'production',
        functionScope: 'write',
        locationId: '*',
      },
      { role: 'production_operator', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    deviceHeaders = await authFor(port, `device-6-4-${run}@example.com`);

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
  // AC1: the as-consumed lot genealogy
  // -------------------------------------------------------------------------

  it('AC1: an output lot returns every consumed input lot and quantity', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    const [completion] = await completionRows(running.orderId);
    const lotId = completion!['lot_id'] as string;

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/lots/${lotId}/genealogy`,
      undefined,
      plannerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['lot_id'], lotId);
    assert.strictEqual(res.body['production_order_id'], running.orderId);
    assert.strictEqual(res.body['output_class'], 'primary');

    const inputs = res.body['inputs'] as Array<Record<string, unknown>>;
    assert.strictEqual(inputs.length, 2, `expected both components: ${JSON.stringify(inputs)}`);

    const backflush = inputs.find((line) => line['component_sku'] === fx.componentSku);
    const directed = inputs.find((line) => line['component_sku'] === fx.directedSku);
    assert.ok(backflush, 'the backflush component must appear in the genealogy');
    assert.ok(directed, 'the directed-issue component must appear in the genealogy');

    // quantity_per is 1.0 on both lines with zero scrap, so a 10-unit run consumes 10 of each.
    await assertNumericEqual(backflush!['quantity_consumed'], '10', 'backflush consumption');
    await assertNumericEqual(directed!['quantity_consumed'], '10', 'directed consumption');

    // The lot identity is the point of FR-MO-11: both the ledger's lot NUMBER and the resolved
    // lot_master UUID must come back, or the trace dead-ends at a string.
    assert.strictEqual(backflush!['input_lot_number'], running.componentLotNumber);
    assert.strictEqual(directed!['input_lot_number'], running.directedLotNumber);
    assert.ok(
      backflush!['input_lot_id'],
      'the consumed backflush lot must resolve to a lot_master id',
    );
    assert.ok(
      directed!['input_lot_id'],
      'the consumed directed lot must resolve to a lot_master id',
    );
    assert.strictEqual(res.body['shares_inputs_with_sibling_lots'], false);
  });

  it('AC1: every output lot minted by one completion reports the same consumed-input list', async () => {
    const fx = await fixture(true);
    const running = await runningOrder(fx);
    const completed = await postCompletion(running.orderId, { primary_quantity: '10' });
    assert.strictEqual(completed.status, 201, JSON.stringify(completed.body));

    const rows = await completionRows(running.orderId);
    assert.ok(rows.length >= 2, `expected a primary and a co-product lot: ${rows.length}`);

    const genealogies: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const res = await makeRequest(
        port,
        'GET',
        `/api/v1/production-orders/lots/${row['lot_id'] as string}/genealogy`,
        undefined,
        plannerHeaders,
      );
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      genealogies.push(res.body);
    }

    // The binding decision under test: joint consumption is reported in full against every output
    // lot, never prorated into a fabricated per-lot share.
    const normalize = (body: Record<string, unknown>): string =>
      JSON.stringify(
        (body['inputs'] as Array<Record<string, unknown>>).map((line) => [
          line['component_sku'],
          line['input_lot_number'],
          line['quantity_consumed'],
        ]),
      );
    assert.strictEqual(
      normalize(genealogies[0]!),
      normalize(genealogies[1]!),
      'sibling output lots must report the identical consumed-input list',
    );
    for (const body of genealogies) {
      assert.strictEqual(body['shares_inputs_with_sibling_lots'], true);
      assert.ok((body['sibling_lot_ids'] as string[]).length >= 1);
    }
  });

  it('AC1: a lot that is not a production output is 404, and a foreign plant lot is 403', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    const [completion] = await completionRows(running.orderId);

    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/lots/${randomUUID()}/genealogy`,
      undefined,
      plannerHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'OUTPUT_LOT_NOT_FOUND');

    // Authorisation runs on the owning order BEFORE the genealogy is read, so a scoped caller
    // learns nothing about another plant's consumption.
    const foreign = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/lots/${completion!['lot_id'] as string}/genealogy`,
      undefined,
      scopedPlannerHeaders,
    );
    assert.strictEqual(foreign.status, 403);
    assert.strictEqual(foreign.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.strictEqual(foreign.body['inputs'], undefined, 'a denied read must disclose no inputs');
  });

  // -------------------------------------------------------------------------
  // AC2: lot-controlled components cannot be consumed without a recorded lot
  // -------------------------------------------------------------------------

  it('AC2: staging a lot-controlled component with no lot is rejected LOT_REQUIRED and writes no stage row', async () => {
    const fx = await fixture(false, '0.0', true);
    const lotNumber = `LOT-D-${randomUUID().slice(0, 8)}`;
    await receiveStock(fx.componentSku, binLocId, 100, 5, `LOT-C-${randomUUID().slice(0, 8)}`);
    await receiveStock(fx.directedSku, binLocId, 100, 11, lotNumber);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
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
    assert.strictEqual(staged.status, 400, JSON.stringify(staged.body));
    assert.strictEqual(staged.body['error_code'], 'LOT_REQUIRED');

    const stages = await getPool().query(
      `SELECT * FROM production_order_stage WHERE production_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(stages.rows.length, 0, 'a rejected staging must leave no stage row behind');

    // The same line WITH a lot is accepted, proving the rejection is about the missing lot and not
    // about the fixture being unusable.
    const withLot = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/material-staging`,
      {
        idempotency_key: randomUUID(),
        lines: [
          { bom_line_id: fx.directedLineId, source_location_id: binLocId, lot_number: lotNumber },
        ],
      },
      plannerHeaders,
    );
    assert.strictEqual(withLot.status, 201, JSON.stringify(withLot.body));
  });

  it('AC2: the seam enforces LOT_REQUIRED on the direct-event path (AD-12)', async () => {
    const fx = await fixture(false, '0.0', true);
    await receiveStock(fx.componentSku, binLocId, 100, 5, `LOT-C-${randomUUID().slice(0, 8)}`);
    await receiveStock(fx.directedSku, binLocId, 100, 11, `LOT-D-${randomUUID().slice(0, 8)}`);
    const created = await createOrder({ output_item_id: fx.itemOut, bom_id: fx.bom.bomId });
    const orderId = created.body['production_order_id'] as string;
    await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${orderId}/release`,
      { idempotency_key: randomUUID() },
      plannerHeaders,
    );

    const direct = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: orderId,
        event_type: 'production_order.material_staged',
        payload: {
          production_order_id: orderId,
          revision_id: fx.bom.revisionId,
          business_date: new Date().toISOString().slice(0, 10),
          lines: [
            {
              bom_line_id: fx.directedLineId,
              component_item_id: fx.directedItemId,
              component_sku: fx.directedSku,
              required_quantity: '10.000000',
              source_location_id: binLocId,
              lot_number: null,
              staged_at: new Date().toISOString(),
            },
          ],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      plannerHeaders,
    );
    assert.strictEqual(direct.status, 400, JSON.stringify(direct.body));
    assert.strictEqual(direct.body['error_code'], 'LOT_REQUIRED');
  });

  // -------------------------------------------------------------------------
  // AC3: the closure gate
  // -------------------------------------------------------------------------

  it('AC3: closure succeeds when WIP is zero, no staging is open and every output lot is dispositioned', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);

    const wip = await wipSummaryDb(running.orderId);
    await assertNumericEqual(wip.net_open_quantity, '0', 'WIP must be zero before closure');

    const closed = await transition(running.orderId, 'closed');
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    assert.strictEqual((await orderRow(running.orderId))['status'], 'closed');

    // The gate's verdict is written onto the persisted event, so the closure is auditable.
    const event = await getPool().query(
      `SELECT payload FROM domain_events
        WHERE stream_id = $1 AND event_type = 'production_order.state_changed'
          AND payload->>'new_status' = 'closed'`,
      [running.orderId],
    );
    const payload = event.rows[0]!['payload'] as Record<string, unknown>;
    const checks = payload['closure_checks'] as Record<string, unknown>;
    assert.ok(checks, 'the closure event must carry the gate verdict');
    await assertNumericEqual(checks['wip_net_open_quantity'], '0', 'recorded WIP quantity');
    assert.strictEqual(checks['open_stage_count'], 0);
    assert.strictEqual(checks['output_lot_count'], checks['dispositioned_lot_count']);
  });

  it('AC3: non-zero WIP blocks closure with CLOSURE_GATE_BLOCKED and leaves the order completed', async () => {
    const fx = await fixture();
    // Confirm MORE than is ever completed, so relief cannot close every posting: the second
    // confirmation opens WIP the completion's proportional relief does not reach.
    const running = await runningOrder(fx, '10', '10');
    const secondConfirm = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/confirmations`,
      { idempotency_key: randomUUID(), confirmed_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(secondConfirm.status, 200, JSON.stringify(secondConfirm.body));
    const partial = await postCompletion(running.orderId, { primary_quantity: '4' });
    assert.strictEqual(partial.status, 201, JSON.stringify(partial.body));
    await acceptEveryOutputLot(fx, running.orderId);
    assert.strictEqual((await transition(running.orderId, 'completed')).status, 200);

    const wip = await wipSummaryDb(running.orderId);
    assert.notStrictEqual(wip.net_open_quantity, '0', 'the fixture must leave WIP open');

    const closed = await transition(running.orderId, 'closed');
    assert.strictEqual(closed.status, 409, JSON.stringify(closed.body));
    assert.strictEqual(closed.body['error_code'], 'CLOSURE_GATE_BLOCKED');
    const details = closed.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['first_blocking_reason'], 'WIP_NOT_ZERO');
    assert.strictEqual((await orderRow(running.orderId))['status'], 'completed');
    assert.strictEqual(
      (await varianceRows(running.orderId)).length,
      0,
      'a blocked closure must write no variance rows',
    );
  });

  it('AC3: an undispositioned output lot blocks closure and names every offending lot', async () => {
    const fx = await fixture();
    const running = await runningOrder(fx);
    const completed = await postCompletion(running.orderId, { primary_quantity: '10' });
    assert.strictEqual(completed.status, 201, JSON.stringify(completed.body));
    // Deliberately NOT dispositioned.
    assert.strictEqual((await transition(running.orderId, 'completed')).status, 200);

    const closed = await transition(running.orderId, 'closed');
    assert.strictEqual(closed.status, 409, JSON.stringify(closed.body));
    assert.strictEqual(closed.body['error_code'], 'CLOSURE_GATE_BLOCKED');
    const details = closed.body['details'] as Record<string, unknown>;
    const reasons = details['blocking_reasons'] as Array<Record<string, unknown>>;
    const undispositioned = reasons.find((r) => r['reason'] === 'LOTS_UNDISPOSITIONED');
    assert.ok(undispositioned, `expected LOTS_UNDISPOSITIONED: ${JSON.stringify(reasons)}`);
    const lots = undispositioned!['undispositioned_lots'] as Array<Record<string, unknown>>;
    const rows = await completionRows(running.orderId);
    assert.strictEqual(lots.length, rows.length, 'every undispositioned lot must be reported');

    // Dispositioning them clears exactly that blocker.
    await acceptEveryOutputLot(fx, running.orderId);
    const retried = await transition(running.orderId, 'closed');
    assert.strictEqual(retried.status, 200, JSON.stringify(retried.body));
  });

  it('AC3: open staged material blocks closure, and every blocking reason is reported at once', async () => {
    const fx = await fixture();
    // Stage the directed line but never issue it: the stage row stays `allocated`.
    const running = await runningOrder(fx, '10', '10', { stageOnly: true });
    const completed = await postCompletion(running.orderId, { primary_quantity: '10' });
    assert.strictEqual(completed.status, 201, JSON.stringify(completed.body));
    assert.strictEqual((await transition(running.orderId, 'completed')).status, 200);

    const closed = await transition(running.orderId, 'closed');
    assert.strictEqual(closed.status, 409, JSON.stringify(closed.body));
    const details = closed.body['details'] as Record<string, unknown>;
    const reasons = (details['blocking_reasons'] as Array<Record<string, unknown>>).map(
      (r) => r['reason'],
    );
    assert.ok(
      reasons.includes('STAGING_OPEN'),
      `expected STAGING_OPEN: ${JSON.stringify(reasons)}`,
    );
    // The undispositioned lot is reported in the SAME response, not discovered on the next attempt.
    assert.ok(
      reasons.includes('LOTS_UNDISPOSITIONED'),
      `every blocker must be reported at once: ${JSON.stringify(reasons)}`,
    );
  });

  it('AC3: a split disposition on the parent output lot satisfies the gate', async () => {
    const fx = await fixture();
    const running = await runningOrder(fx);
    assert.strictEqual(
      (await postCompletion(running.orderId, { primary_quantity: '10' })).status,
      201,
    );
    const [completion] = await completionRows(running.orderId);
    const taskId = completion!['qc_task_id'] as string;

    const determination = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/sampling`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(determination.status, 201, JSON.stringify(determination.body));
    const sampleSize = (determination.body['sampling'] as Record<string, unknown>)[
      'sample_size'
    ] as number;
    // A split needs a COMPLETED inspection (QC_INSPECTION_REQUIRED otherwise): one unit fails, so
    // the lot is genuinely part-conforming and a split is the honest disposition.
    const readings: Record<string, unknown>[] = [];
    for (let u = 1; u <= sampleSize; u += 1) {
      readings.push({ sample_unit_no: u, attribute_conforms: u !== 1 });
    }
    const obs = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/observations`,
      { characteristic_id: fx.characteristicIds[0]!, readings },
      inspectorHeaders,
    );
    assert.strictEqual(obs.status, 201, JSON.stringify(obs.body));
    const inspection = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/inspection-completion`,
      {},
      inspectorHeaders,
    );
    assert.strictEqual(inspection.status, 201, JSON.stringify(inspection.body));
    const split = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/split`,
      {
        justification: 'Story 6.4 split fixture',
        splits: [
          { sequence: 1, quantity: '6.000000' },
          { sequence: 2, quantity: '4.000000' },
        ],
      },
      inspectorHeaders,
    );
    assert.strictEqual(split.status, 201, JSON.stringify(split.body));

    const disposition = await getPool().query(
      `SELECT disposition FROM qc_lot_disposition WHERE lot_id = $1`,
      [completion!['lot_id']],
    );
    assert.strictEqual(disposition.rows[0]!['disposition'], 'split');

    assert.strictEqual((await transition(running.orderId, 'completed')).status, 200);
    const closed = await transition(running.orderId, 'closed');
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
  });

  // -------------------------------------------------------------------------
  // AC4: a closed order is immutable
  // -------------------------------------------------------------------------

  it('AC4: every mutating posting against a closed order is rejected ORDER_CLOSED and audited', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    assert.strictEqual((await transition(running.orderId, 'closed')).status, 200);

    const issue = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/material-issues`,
      { idempotency_key: randomUUID(), stage_id: running.stageId, quantity: '1' },
      plannerHeaders,
    );
    assert.strictEqual(issue.body['error_code'], 'ORDER_CLOSED', JSON.stringify(issue.body));
    assert.strictEqual(issue.status, 409);

    const completion = await postCompletion(running.orderId, { primary_quantity: '1' });
    assert.strictEqual(
      completion.body['error_code'],
      'ORDER_CLOSED',
      JSON.stringify(completion.body),
    );

    const scrap = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/scrap-declarations`,
      { idempotency_key: randomUUID(), quantity: '1', reason_code: 'PROCESS_LOSS' },
      plannerHeaders,
    );
    assert.strictEqual(scrap.body['error_code'], 'ORDER_CLOSED', JSON.stringify(scrap.body));

    const staging = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/material-staging`,
      {
        idempotency_key: randomUUID(),
        lines: [{ bom_line_id: fx.directedLineId, source_location_id: binLocId }],
      },
      plannerHeaders,
    );
    assert.strictEqual(staging.body['error_code'], 'ORDER_CLOSED', JSON.stringify(staging.body));

    // FR-AC-13: the refusal is in the edit log with the order it was refused against.
    const audit = await auditRowFor('ORDER_CLOSED', running.orderId);
    assert.ok(audit, 'an ORDER_CLOSED rejection must be written to the edit log');
    assert.ok(audit!['user_id'], 'the edit-log row must attribute the attempt to a user');
  });

  it('AC4: a closed order cannot be re-closed, cancelled or transitioned onward', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    assert.strictEqual((await transition(running.orderId, 'closed')).status, 200);

    const reclose = await transition(running.orderId, 'closed');
    assert.strictEqual(reclose.status, 400, JSON.stringify(reclose.body));
    assert.strictEqual(reclose.body['error_code'], 'INVALID_STATE_TRANSITION');

    const cancelled = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/cancel`,
      { idempotency_key: randomUUID(), reason_code: 'ORDER_CURTAILED' },
      plannerHeaders,
    );
    assert.strictEqual(cancelled.status, 400, JSON.stringify(cancelled.body));
    assert.strictEqual(cancelled.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual((await orderRow(running.orderId))['status'], 'closed');
  });

  // -------------------------------------------------------------------------
  // AC5 and AC6: offline execution and the central-only operations
  // -------------------------------------------------------------------------

  it('AC5: a replayed edge upload of a production event is suppressed with DUPLICATE_EVENT', async () => {
    const fx = await fixture();
    const running = await runningOrder(fx);
    const envelope = {
      event_id: randomUUID(),
      stream_type: 'production',
      stream_id: running.orderId,
      event_type: 'production_order.state_changed',
      payload: {
        production_order_id: running.orderId,
        previous_status: 'in_process',
        new_status: 'completed',
        changed_by: plannerUserId,
        changed_at: new Date().toISOString(),
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: plannerUserId, role: 'production_operator', location_id: siteLocId },
        occurred_at: new Date().toISOString(),
        device_id: `device-${run}`,
      },
      idempotency_key: randomUUID(),
    };

    const first = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, deviceHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual((await orderRow(running.orderId))['status'], 'completed');

    const replay = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, deviceHeaders);
    assert.strictEqual(replay.status, 409, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['error_code'], 'DUPLICATE_EVENT');
    const details = replay.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['existing_event_id'], envelope.event_id);

    const stored = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events
        WHERE stream_id = $1 AND event_type = 'production_order.state_changed'
          AND payload->>'new_status' = 'completed'`,
      [running.orderId],
    );
    assert.strictEqual(stored.rows[0]!['n'], 1, 'a replay must not write a second event');
  });

  it('AC6: release, cancel and close are rejected CENTRAL_ONLY_OPERATION on the edge route', async () => {
    const fx = await fixture();
    const running = await runningOrder(fx);

    const cases: Array<{ eventType: string; payload: Record<string, unknown> }> = [
      {
        eventType: 'production_order.released',
        payload: {
          production_order_id: running.orderId,
          released_revision_id: fx.bom.revisionId,
          business_date: '2026-09-01',
          expediting_flag: false,
          override_by: null,
          override_reason: null,
          released_by: plannerUserId,
          released_at: new Date().toISOString(),
        },
      },
      {
        eventType: 'production_order.cancelled',
        payload: {
          production_order_id: running.orderId,
          previous_status: 'in_process',
          cancelled_by: plannerUserId,
          cancelled_at: new Date().toISOString(),
          unreversed_transaction_count: 0,
          reason_code: null,
        },
      },
      {
        eventType: 'production_order.state_changed',
        payload: {
          production_order_id: running.orderId,
          previous_status: 'completed',
          new_status: 'closed',
          changed_by: plannerUserId,
          changed_at: new Date().toISOString(),
        },
      },
      {
        eventType: 'production_order.created',
        payload: { production_order_id: running.orderId },
      },
    ];

    for (const testCase of cases) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          event_id: randomUUID(),
          stream_type: 'production',
          stream_id: running.orderId,
          event_type: testCase.eventType,
          payload: testCase.payload,
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: plannerUserId, role: 'production_operator', location_id: siteLocId },
            occurred_at: new Date().toISOString(),
            device_id: `device-${run}`,
          },
          idempotency_key: randomUUID(),
        },
        deviceHeaders,
      );
      assert.strictEqual(res.status, 403, `${testCase.eventType}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION', testCase.eventType);
    }

    // The rejection is about the OPERATION, not the stream: the same event type carrying a
    // non-closing transition is accepted from the same device.
    const allowed = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: randomUUID(),
        stream_type: 'production',
        stream_id: running.orderId,
        event_type: 'production_order.state_changed',
        payload: {
          production_order_id: running.orderId,
          previous_status: 'in_process',
          new_status: 'completed',
          changed_by: plannerUserId,
          changed_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_operator', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
          device_id: `device-${run}`,
        },
        idempotency_key: randomUUID(),
      },
      deviceHeaders,
    );
    assert.strictEqual(allowed.status, 201, JSON.stringify(allowed.body));
    assert.strictEqual((await orderRow(running.orderId))['status'], 'completed');
  });

  it('AC6: a central-only edge rejection writes an edit-log entry and changes no state', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    const before = await orderRow(running.orderId);

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: randomUUID(),
        stream_type: 'production',
        stream_id: running.orderId,
        event_type: 'production_order.state_changed',
        payload: {
          production_order_id: running.orderId,
          previous_status: 'completed',
          new_status: 'closed',
          changed_by: plannerUserId,
          changed_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_operator', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
          device_id: `device-${run}`,
        },
        idempotency_key: randomUUID(),
      },
      deviceHeaders,
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await orderRow(running.orderId))['status'], before['status']);

    const audit = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE error_code = 'CENTRAL_ONLY_OPERATION'`,
    );
    assert.ok(
      Number(audit.rows[0]!['n']) > 0,
      'a central-only refusal must be written to the edit log',
    );
  });

  // -------------------------------------------------------------------------
  // AC7: the consumption variance report
  // -------------------------------------------------------------------------

  it('AC7: closure writes one variance line per BOM line, within tolerance on an exact run', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    assert.strictEqual((await transition(running.orderId, 'closed')).status, 200);

    const rows = await varianceRows(running.orderId);
    assert.strictEqual(rows.length, 2, `expected one line per component: ${JSON.stringify(rows)}`);
    for (const row of rows) {
      await assertNumericEqual(String(row['basis_quantity']), '10', 'basis is the primary output');
      await assertNumericEqual(String(row['expected_quantity']), '10', 'expected consumption');
      await assertNumericEqual(String(row['actual_quantity']), '10', 'actual consumption');
      await assertNumericEqual(String(row['variance_quantity']), '0', 'variance quantity');
      await assertNumericEqual(String(row['variance_percent']), '0', 'variance percent');
      assert.strictEqual(row['tolerance_breached'], false);
      assert.strictEqual(row['revision_id'], fx.bom.revisionId);
    }

    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${running.orderId}/consumption-variance`,
      undefined,
      plannerHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(read.body['computed'], true);
    assert.strictEqual(read.body['breached_line_count'], 0);
    assert.strictEqual((read.body['lines'] as unknown[]).length, 2);
  });

  it('AC7: over-consumption beyond the tolerance is flagged and carries the implied scrap percent', async () => {
    const fx = await fixture();
    // Consume 15 of the backflush component against a 10-unit expectation: a second confirmation
    // draws 5 more, then the completion of the full order quantity relieves every open posting.
    const running = await runningOrder(fx, '10', '10');
    const extra = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/confirmations`,
      { idempotency_key: randomUUID(), confirmed_quantity: '5' },
      plannerHeaders,
    );
    assert.strictEqual(extra.status, 200, JSON.stringify(extra.body));
    assert.strictEqual(
      (await postCompletion(running.orderId, { primary_quantity: '10' })).status,
      201,
    );
    await acceptEveryOutputLot(fx, running.orderId);
    assert.strictEqual((await transition(running.orderId, 'completed')).status, 200);
    assert.strictEqual((await transition(running.orderId, 'closed')).status, 200);

    const rows = await varianceRows(running.orderId);
    const backflush = rows.find((row) => row['component_sku'] === fx.componentSku);
    assert.ok(backflush, 'the over-consumed component must have a variance line');
    await assertNumericEqual(String(backflush!['expected_quantity']), '10', 'expected');
    await assertNumericEqual(String(backflush!['actual_quantity']), '15', 'actual');
    await assertNumericEqual(String(backflush!['variance_percent']), '50', 'variance percent');
    assert.strictEqual(backflush!['tolerance_breached'], true);
    // FR-B-08's recalibration signal: the BOM declared 0 percent scrap, the run exhibited 50.
    await assertNumericEqual(String(backflush!['bom_scrap_percent']), '0', 'declared scrap');
    await assertNumericEqual(String(backflush!['implied_scrap_percent']), '50', 'implied scrap');

    // The directed line consumed exactly its expectation and must NOT be flagged.
    const directed = rows.find((row) => row['component_sku'] === fx.directedSku);
    assert.strictEqual(directed!['tolerance_breached'], false);

    const payload = (
      await getPool().query(
        `SELECT payload FROM domain_events
          WHERE stream_id = $1 AND event_type = 'production_order.state_changed'
            AND payload->>'new_status' = 'closed'`,
        [running.orderId],
      )
    ).rows[0]!['payload'] as Record<string, unknown>;
    const variance = payload['variance'] as Record<string, unknown>;
    assert.strictEqual(variance['computed'], true);
    assert.strictEqual(variance['breached_line_count'], 1);
    assert.strictEqual((variance['breached_lines'] as unknown[]).length, 1);
  });

  it('AC7: the BOM scrap allowance is the expectation, so a run that consumes it exactly is not flagged', async () => {
    // A 20 percent scrap allowance on the backflush line: a 10-unit run expects 12 and the
    // backflush consumes exactly that, so the line must read 0 percent variance - not +20.
    const fx = await fixture(false, '20.0');
    const running = await closeableOrder(fx);
    assert.strictEqual((await transition(running.orderId, 'closed')).status, 200);

    const rows = await varianceRows(running.orderId);
    const backflush = rows.find((row) => row['component_sku'] === fx.componentSku);
    assert.ok(backflush);
    await assertNumericEqual(
      String(backflush!['expected_quantity']),
      '12',
      'scrap-inflated expectation',
    );
    await assertNumericEqual(
      String(backflush!['expected_base_quantity']),
      '10',
      'zero-scrap basis',
    );
    await assertNumericEqual(String(backflush!['actual_quantity']), '12', 'actual');
    await assertNumericEqual(String(backflush!['variance_percent']), '0', 'variance percent');
    await assertNumericEqual(String(backflush!['implied_scrap_percent']), '20', 'implied scrap');
    assert.strictEqual(backflush!['tolerance_breached'], false);
  });

  it('AC7: the variance read returns an empty, uncomputed report for an order that has not closed', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${running.orderId}/consumption-variance`,
      undefined,
      plannerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['computed'], false);
    assert.strictEqual((res.body['lines'] as unknown[]).length, 0);
    assert.strictEqual(res.body['status'], 'completed');
  });

  // -------------------------------------------------------------------------
  // Derivation, replay, scoping and concurrency
  // -------------------------------------------------------------------------

  it('AD-12: a direct event declaring the gate verdict or the variance summary is rejected', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);

    for (const field of ['closure_checks', 'variance']) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          stream_type: 'production',
          stream_id: running.orderId,
          event_type: 'production_order.state_changed',
          payload: {
            production_order_id: running.orderId,
            previous_status: 'completed',
            new_status: 'closed',
            changed_by: plannerUserId,
            changed_at: new Date().toISOString(),
            [field]: field === 'variance' ? { computed: true } : { open_stage_count: 0 },
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: randomUUID(),
        },
        plannerHeaders,
      );
      assert.strictEqual(res.status, 409, `${field}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'PRODUCTION_ORDER_DERIVATION_MISMATCH', field);
    }
    assert.strictEqual((await orderRow(running.orderId))['status'], 'completed');
  });

  it('AD-12: the closure gate runs on the direct-event path, not only in the handler', async () => {
    const fx = await fixture();
    const running = await runningOrder(fx);
    assert.strictEqual(
      (await postCompletion(running.orderId, { primary_quantity: '10' })).status,
      201,
    );
    assert.strictEqual((await transition(running.orderId, 'completed')).status, 200);

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'production',
        stream_id: running.orderId,
        event_type: 'production_order.state_changed',
        payload: {
          production_order_id: running.orderId,
          previous_status: 'completed',
          new_status: 'closed',
          changed_by: plannerUserId,
          changed_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'production_planner', location_id: siteLocId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CLOSURE_GATE_BLOCKED');
    assert.strictEqual((await orderRow(running.orderId))['status'], 'completed');
  });

  it('AD-16: a same-key replay of the closure returns the stored result and writes no second report', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    const key = randomUUID();
    const body = { new_status: 'closed', idempotency_key: key };

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/transition`,
      body,
      plannerHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/production-orders/${running.orderId}/transition`,
      body,
      plannerHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['status'], 'closed');
    assert.strictEqual(
      (await varianceRows(running.orderId)).length,
      2,
      'a replay must not double-write the variance report',
    );
  });

  it('concurrency: two parallel closures produce exactly one closed order and one variance report', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);

    const [a, b] = await Promise.all([
      transition(running.orderId, 'closed'),
      transition(running.orderId, 'closed'),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.strictEqual(
      statuses[0],
      200,
      `one closure must win: ${JSON.stringify([a.body, b.body])}`,
    );
    assert.ok(
      statuses[1]! >= 400,
      `the loser must be rejected, not silently accepted: ${JSON.stringify([a.body, b.body])}`,
    );
    assert.strictEqual((await orderRow(running.orderId))['status'], 'closed');
    assert.strictEqual((await varianceRows(running.orderId)).length, 2);
    const events = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events
        WHERE stream_id = $1 AND event_type = 'production_order.state_changed'
          AND payload->>'new_status' = 'closed'`,
      [running.orderId],
    );
    assert.strictEqual(events.rows[0]!['n'], 1, 'exactly one closure event may be stored');
  });

  it('RBAC: the new reads are plant-scoped and refuse a caller scoped to another plant', async () => {
    const fx = await fixture();
    const running = await closeableOrder(fx);
    assert.strictEqual((await transition(running.orderId, 'closed')).status, 200);

    const variance = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${running.orderId}/consumption-variance`,
      undefined,
      scopedPlannerHeaders,
    );
    assert.strictEqual(variance.status, 403, JSON.stringify(variance.body));
    assert.strictEqual(variance.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // A supervisor with wildcard read scope sees the same report.
    const allowed = await makeRequest(
      port,
      'GET',
      `/api/v1/production-orders/${running.orderId}/consumption-variance`,
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    assert.strictEqual((allowed.body['lines'] as unknown[]).length, 2);
  });

  it('params: a non-UUID lot or order id is a clean 400, never a 500', async () => {
    const genealogy = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders/lots/not-a-uuid/genealogy',
      undefined,
      plannerHeaders,
    );
    assert.strictEqual(genealogy.status, 400, JSON.stringify(genealogy.body));
    assert.strictEqual(genealogy.body['error_code'], 'INVALID_PARAMS');

    const variance = await makeRequest(
      port,
      'GET',
      '/api/v1/production-orders/not-a-uuid/consumption-variance',
      undefined,
      plannerHeaders,
    );
    assert.strictEqual(variance.status, 400, JSON.stringify(variance.body));
    assert.strictEqual(variance.body['error_code'], 'INVALID_PARAMS');
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool } from '../../src/config/db.js';
import { toIstCalendarDate } from '../../src/lib/business-days.js';
import { runJobWorkBillingFeedSweepCycle } from '../../src/notify/jobwork-billing-sweep.js';
import { dispatchGateBlockedLots } from '../../src/compliance/dispatch.js';

/**
 * Story 9.6 Offcut Election Execution and ERP Billing Feed (FR-JW-09/10, FR-JW-12). Real
 * PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run serially;
 * every identifier is run-scoped. Fixture writes use the admin pool (app_user has no DELETE). The
 * harness scaffolding is a deliberate local re-implementation of the story-9-5 closures (never
 * import cross-story). The billing sweep is called DIRECTLY (the retention-expiry.ts convention)
 * against an artificially backdated first_sent_at.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const RUN = run.toUpperCase();

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
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
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, text: raw });
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

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body['details'] ?? {}) as Record<string, unknown>;
}

// Role names asserted as LITERALS, never against the sweep's exported constants (the 8.4 lesson).
const COORDINATOR_ROLE = 'jobwork_coordinator';
const SITE_HEAD_ROLE = 'site_head';
const CONTRACTED_RATE = '18.5000';

describe('Story 9.6 Offcut Election Execution and ERP Billing Feed', () => {
  let server: Server;
  let port: number;

  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let acknowledgerUserId: string;
  let acknowledgerHeaders: Record<string, string>;
  let storeUserId: string;
  let storeHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let readOnlyHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;
  let otherSiteHeaders: Record<string, string>;

  let siteAId: string;
  let siteBId: string;
  let dockId: string;
  let kitBomId: string;
  let kitRevisionId: string;
  let outputItemId: string;
  let customerItemId: string;
  const characteristicIds: Record<string, string> = {};

  const TODAY = toIstCalendarDate(new Date());
  const CUSTOMER = `CUST-9-6-${RUN}`;
  const SKU = `SKU-CUST-9-6-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-9-6-${RUN}`;
  const SKU_OWNED = `SKU-OWN-9-6-${RUN}`;
  const OUTPUT_SKU = `SKU-OUT-9-6-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-6-${run}`;
  let poCounter = 0;

  // -------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------

  async function seedLocation(level: string, code: string, siteId: string | null): Promise<string> {
    const locationId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', false, 'active')`,
      [locationId, code, level, siteId, siteId ?? locationId],
    );
    return locationId;
  }

  async function seedItem(sku: string): Promise<string> {
    const r = await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, false, false, false, 'weighted_average', 'job_work', 'active')
       RETURNING item_id`,
      [sku],
    );
    return r.rows[0]!['item_id'] as string;
  }

  async function seedKitBom(
    lines: { sku: string; itemId: string; supplySource: 'company' | 'customer' }[],
  ): Promise<{ bomId: string; revisionId: string; itemId: string }> {
    const bomId = randomUUID();
    const revisionId = randomUUID();
    const parentItemId = await seedItem(OUTPUT_SKU);
    await getAdminPool().query(
      `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, current_revision_id, created_by, source_event_id)
       VALUES ($1, $2, $3, 'KG', 'job_work', 'job_work_kit', 'released', $4, $5, $6)`,
      [bomId, parentItemId, OUTPUT_SKU, revisionId, coordinatorUserId, randomUUID()],
    );
    await getAdminPool().query(
      `INSERT INTO bom_revision (revision_id, bom_id, revision_code, revision_status, drafted_by, released_at, released_by, source_event_id)
       VALUES ($1, $2, 'A', 'released', $3, now(), $3, $4)`,
      [revisionId, bomId, coordinatorUserId, randomUUID()],
    );
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      await getAdminPool().query(
        `INSERT INTO bom_line (bom_line_id, revision_id, bom_id, line_no, component_item_id, component_sku, is_placeholder, output_class, quantity_per, line_uom, uom_conversion_factor, base_quantity_per, is_phantom, effective_from, supply_method, supply_source, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, false, 'component', '1.0', 'KG', '1.0', '1.0', false, '2020-01-01', 'directed_issue', $7, $8)`,
        [
          randomUUID(),
          revisionId,
          bomId,
          lineNo,
          line.itemId,
          line.sku,
          line.supplySource,
          randomUUID(),
        ],
      );
    }
    return { bomId, revisionId, itemId: parentItemId };
  }

  async function seedPo(sku: string): Promise<string> {
    poCounter += 1;
    const poRef = `PO-JW-9-6-${run}-${poCounter}`;
    await getAdminPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-JW', 'INR', '2026-10-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getAdminPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, 100000, 100000, 1, 5, 5, 'ERP', now())`,
      [poRef, sku],
    );
    return poRef;
  }

  async function seedToken(poRef: string): Promise<string> {
    const token = randomUUID();
    await getAdminPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
         tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A-9-6', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-6', 'MANUAL', $6, $7, $8)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, coordinatorUserId, TODAY, randomUUID()],
    );
    return token;
  }

  interface OrderOpts {
    contractual?: boolean;
    election?: 'return' | 'retain_and_buy' | 'retain_free';
    rate?: string | null;
    confirmExtra?: Record<string, unknown>;
    basisType?: 'per_piece' | 'per_kg' | 'per_hour' | 'lumpsum';
  }

  async function createDraftOrder(opts: OrderOpts = {}): Promise<string> {
    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/service-orders',
      {
        site_id: siteAId,
        customer_party_code: CUSTOMER,
        customer_name: 'Acme Fabrication Pvt Ltd',
        price_basis: { basis_type: opts.basisType ?? 'per_kg', rate: 12.5, currency: 'INR' },
        kit_bom_id: kitBomId,
        ...(opts.contractual ? { has_contractual_offcut: true } : {}),
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
    assert.strictEqual(create.status, 201, `create order failed: ${JSON.stringify(create.body)}`);
    return (create.body['service_order'] as Record<string, unknown>)['service_order_id'] as string;
  }

  async function confirmOrder(orderId: string, body: Record<string, unknown>): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/confirm`,
      { idempotency_key: randomUUID(), ...body },
      coordinatorHeaders,
    );
  }

  /** A confirmed order; contractual orders carry their election and the contracted rate. */
  async function confirmedOrder(opts: OrderOpts = {}): Promise<string> {
    const orderId = await createDraftOrder(opts);
    const body: Record<string, unknown> = { ...(opts.confirmExtra ?? {}) };
    if (opts.contractual) {
      body['offcut_election'] = opts.election ?? 'return';
      if (opts.rate !== null) {
        body['offcut_rate'] = opts.rate ?? CONTRACTED_RATE;
        body['offcut_currency'] = 'INR';
      }
    }
    const confirm = await confirmOrder(orderId, body);
    assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
    return orderId;
  }

  /** A customer-material GRN line; returns the lot number. */
  async function receive(
    serviceOrderId: string,
    opts: { sku?: string; qty?: string } = {},
  ): Promise<{ lot: string; challan: string }> {
    const sku = opts.sku ?? SKU;
    const qty = opts.qty ?? '1000';
    const poRef = await seedPo(sku);
    const token = await seedToken(poRef);
    const lot = `LOT-JW-9-6-${run}-${randomUUID().slice(0, 6)}`;
    const challan = `CH-${run}-${randomUUID().slice(0, 6)}`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        receipt_id: randomUUID(),
        correlation_id: token,
        po_ref_ext: poRef,
        line_no: 1,
        source_document: 'PO',
        sku,
        target_location_code: DOCK_CODE,
        received_qty: qty,
        stock_class: 'job_work',
        lot_id: lot,
        service_order_id: serviceOrderId,
        challan_number_ext: challan,
        challan_date: '2026-09-01',
        challan_qty: qty,
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 201, `receipt failed: ${JSON.stringify(res.body)}`);
    return { lot, challan };
  }

  async function inProcessOrder(
    opts: OrderOpts & { qty?: string } = {},
  ): Promise<{ orderId: string; lot: string; challan: string }> {
    const orderId = await confirmedOrder(opts);
    const { lot, challan } = await receive(orderId, { qty: opts.qty ?? '1000' });
    return { orderId, lot, challan };
  }

  async function consume(orderId: string, lot: string, qty = '100'): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/consumptions`,
      {
        sku: SKU,
        lot_id: lot,
        location_id: dockId,
        quantity: qty,
        uom: 'KG',
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
  }

  async function postOffcut(
    orderId: string,
    lot: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcuts`,
      {
        sku: SKU,
        lot_id: lot,
        location_id: dockId,
        uom: 'KG',
        idempotency_key: randomUUID(),
        ...body,
      },
      headers,
    );
  }

  async function recordOutput(orderId: string, quantity = '50'): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/outputs`,
      { quantity, uom: 'KG', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 201, `output failed: ${JSON.stringify(res.body)}`);
    return (res.body['output'] as Record<string, unknown>)['lot_number'] as string;
  }

  async function taskIdForLot(lotNumber: string): Promise<string> {
    const taskRow = await getAdminPool().query(
      `SELECT task_id FROM qc_inspection_task WHERE lot_id = (SELECT lot_id FROM lot_master WHERE lot_number = $1)`,
      [lotNumber],
    );
    assert.ok(taskRow.rows[0], `no QC task for lot ${lotNumber}`);
    return taskRow.rows[0]!['task_id'] as string;
  }

  async function releaseLot(lotNumber: string, characteristicKey: string): Promise<void> {
    const taskId = await taskIdForLot(lotNumber);
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
    const readings = Array.from({ length: sampleSize }, (_, i) => ({
      sample_unit_no: i + 1,
      attribute_conforms: true,
    }));
    const obs = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/observations`,
      { characteristic_id: characteristicIds[characteristicKey], readings },
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
    const disp = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      { disposition: 'accept', justification: 'Story 9.6 dispatch fixture' },
      qcHeadHeaders,
    );
    assert.strictEqual(disp.status, 201, JSON.stringify(disp.body));
  }

  async function dispatch(
    orderId: string,
    lotNumber: string,
    quantity: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/dispatches`,
      {
        lot_id: lotNumber,
        dispatched_quantity: quantity,
        uom: 'KG',
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
  }

  /** An in_process order with consumption, one released output lot and ONE partial dispatch. */
  async function dispatchedOrder(
    opts: OrderOpts = {},
  ): Promise<{ orderId: string; lot: string; outputLot: string }> {
    const { orderId, lot } = await inProcessOrder(opts);
    assert.strictEqual((await consume(orderId, lot, '500')).status, 201);
    const outputLot = await recordOutput(orderId, '50');
    await releaseLot(outputLot, 'output');
    const d = await dispatch(orderId, outputLot, '20');
    assert.strictEqual(d.status, 201, JSON.stringify(d.body));
    return { orderId, lot, outputLot };
  }

  async function generateFeed(
    orderId: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/billing-feed`,
      { idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  async function acknowledge(
    feedId: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = acknowledgerHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/billing-feeds/${feedId}/acknowledgment`,
      {
        idempotency_key: randomUUID(),
        acknowledged_ref_ext: `ERP-INV-${run}-${randomUUID().slice(0, 6)}`,
        ...body,
      },
      headers,
    );
  }

  async function report(headers: Record<string, string> = coordinatorHeaders): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      '/api/v1/jobwork/reports/billing-reconciliation',
      undefined,
      headers,
    );
  }

  async function postEvent(body: unknown, headers = coordinatorHeaders): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/events', body, headers);
  }

  function offcutEnvelope(orderId: string, lot: string, extra: Record<string, unknown> = {}) {
    return {
      stream_type: 'custody',
      stream_id: orderId,
      event_type: 'custody.offcut_recorded',
      payload: {
        service_order_id: orderId,
        offcut_id: randomUUID(),
        sku: SKU,
        lot_id: lot,
        location_id: dockId,
        quantity: '10',
        uom: 'KG',
        site_id: siteAId,
        posted_by: coordinatorUserId,
        ...extra,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: coordinatorUserId, role: COORDINATOR_ROLE, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    };
  }

  async function approvePlan(key: string, itemId: string): Promise<void> {
    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/inspection-plans',
      {
        scope: 'standard',
        item_id: itemId,
        bom_revision_id: kitRevisionId,
        effective_from: '2020-01-01',
        aql: '1.000',
        inspection_level: 'II',
        characteristics: [
          {
            line_no: 1,
            characteristic_name: 'Surface finish',
            characteristic_class: 'minor',
            test_method_ref: 'SOP-QC-JW',
            instrument_type: null,
            result_kind: 'attribute',
            lower_limit: null,
            upper_limit: null,
            limit_uom: null,
            acceptance_criteria: 'No visible defects',
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
    characteristicIds[key] = (created.body['characteristics'] as Record<string, unknown>[])[0]![
      'characteristic_id'
    ] as string;
    const approver = await resolvedApprover('qc.inspection_plan_approval');
    const approved = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/inspection-plans/${planId}/versions/${versionId}/approve`,
      { idempotency_key: randomUUID() },
      approver.headers,
    );
    assert.strictEqual(
      approved.status,
      200,
      `plan approve failed: ${JSON.stringify(approved.body)}`,
    );
  }

  async function resolvedApprover(
    transactionType: string,
  ): Promise<{ userId: string; headers: Record<string, string> }> {
    const entry = await getAdminPool().query(
      `SELECT role FROM doa_registry_entries
        WHERE transaction_type = $1 AND active = true
        ORDER BY created_at ASC, entry_id ASC LIMIT 1`,
      [transactionType],
    );
    const role = entry.rows[0]?.['role'] as string | undefined;
    assert.ok(role, `no active DOA entry for ${transactionType}`);
    const holder = await getAdminPool().query(
      `SELECT u.user_id, u.external_id FROM user_role_assignments a
         JOIN users u ON u.user_id = a.user_id
        WHERE a.role = $1 AND u.active = true
        ORDER BY a.created_at ASC, a.assignment_id ASC LIMIT 1`,
      [role],
    );
    const userId = holder.rows[0]?.['user_id'] as string | undefined;
    const externalId = holder.rows[0]?.['external_id'] as string | undefined;
    assert.ok(userId && externalId, `no active holder of role ${role}`);
    return { userId: userId!, headers: await authFor(port, externalId!) };
  }

  async function ledgerRows(orderId: string, category: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT entry_id, sku, lot_id, quantity_delta::text AS quantity_delta, ownership, billable, reference_ext,
              posted_by, source_event_id
         FROM custody_ledger_entry WHERE service_order_id = $1 AND movement_category = $2
        ORDER BY created_at ASC`,
      [orderId, category],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function custodyBalance(orderId: string, sku = SKU): Promise<string> {
    const r = await getAdminPool().query(
      `SELECT COALESCE(SUM(quantity_delta), 0)::numeric(18,3)::text AS balance
         FROM custody_ledger_entry WHERE service_order_id = $1 AND sku = $2 AND ownership = 'customer'`,
      [orderId, sku],
    );
    return r.rows[0]!['balance'] as string;
  }

  async function stockOnHand(sku: string, lot: string, stockClass: string): Promise<string | null> {
    const r = await getAdminPool().query(
      `SELECT on_hand::numeric(18,3)::text AS on_hand FROM stock_balance
        WHERE sku = $1 AND lot_id = $2 AND stock_class = $3 AND location_id = $4`,
      [sku, lot, stockClass, dockId],
    );
    return (r.rows[0]?.['on_hand'] as string | undefined) ?? null;
  }

  async function storedPayload(eventId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(`SELECT payload FROM domain_events WHERE event_id = $1`, [
      eventId,
    ]);
    return r.rows[0]!['payload'] as Record<string, unknown>;
  }

  async function orderRow(orderId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT status, offcut_election, offcut_rate::text AS offcut_rate, offcut_currency, offcut_settled_at,
              offcut_settled_by, invoiced_at, invoiced_feed_id, order_number_ext, site_id
         FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function feedRow(feedId: string): Promise<Record<string, unknown> | undefined> {
    const r = await getAdminPool().query(
      `SELECT status, first_sent_at, acknowledged_at, acknowledged_by, acknowledged_ref_ext,
              exception_raised_at, alert_sent_at, generated_by, total_value::text AS total_value,
              open_to_dispatch_qty::text AS open_to_dispatch_qty, payload
         FROM job_work_billing_feed WHERE feed_id = $1`,
      [feedId],
    );
    return r.rows[0] as Record<string, unknown> | undefined;
  }

  async function documentsFor(orderId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT document_type, document_content, generated_by FROM dispatch_document
        WHERE dispatch_order_id = $1 ORDER BY document_type ASC`,
      [orderId],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function notificationsFor(objectId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT payload FROM domain_events
        WHERE stream_type = 'notification' AND event_type = 'notification.created'
          AND payload->>'object_id' = $1
        ORDER BY created_at ASC`,
      [objectId],
    );
    return r.rows.map((row: Record<string, unknown>) => row['payload'] as Record<string, unknown>);
  }

  async function auditedFor(errorCode: string, traceId: string): Promise<boolean> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = $1 AND trace_id = $2`,
      [errorCode, traceId],
    );
    return (r.rows[0]!['n'] as number) === 1;
  }

  /**
   * Binding decision 19: the converted lot carries the Story 8.5 GOVERNED hold - an open
   * qc_quality_hold row plus the lot_master enforcement flag that every allocation, pick and
   * dispatch gate reads (dispatchGateBlockedLots is the codebase's own predicate for the latter).
   */
  async function qcHeld(
    lotNumber: string,
  ): Promise<{ held: boolean; openHolds: number; holdStatus: string | null }> {
    const lot = await getAdminPool().query(
      `SELECT lot_id, quality_hold_status FROM lot_master WHERE lot_number = $1`,
      [lotNumber],
    );
    const lotId = lot.rows[0]?.['lot_id'] as string | undefined;
    assert.ok(lotId, `no lot_master row for ${lotNumber}`);
    const holds = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM qc_quality_hold WHERE lot_id = $1 AND status = 'open'`,
      [lotId],
    );
    const client = await getAdminPool().connect();
    try {
      const blocked = await dispatchGateBlockedLots([lotId!], client);
      return {
        held: blocked.heldLotIds.length > 0,
        openHolds: holds.rows[0]!['n'] as number,
        holdStatus: (lot.rows[0]!['quality_hold_status'] as string | null) ?? null,
      };
    } finally {
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
      '../../read/projections/cycle_count.sql',
      '../../read/projections/physical_verification.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/putaway_task.sql',
      '../../read/projections/bom.sql',
      '../../read/projections/bom_revision.sql',
      '../../read/projections/bom_line.sql',
      '../../read/projections/qc_quality_hold.sql',
      '../../read/projections/inspection_plan.sql',
      '../../read/projections/inspection_plan_version.sql',
      '../../read/projections/inspection_plan_characteristic.sql',
      '../../read/projections/inspection_plan_approval.sql',
      '../../read/projections/qc_inspection_task.sql',
      '../../read/projections/qc_sampling_plan.sql',
      '../../read/projections/qc_sampling_switching_state.sql',
      '../../read/projections/qc_inspection_result.sql',
      '../../read/projections/qc_lot_disposition.sql',
      '../../read/projections/qc_lot_split.sql',
      '../../read/projections/qc_ncr.sql',
      '../../read/projections/qc_retention_sample.sql',
      '../../read/projections/service_order.sql',
      '../../read/projections/jobwork_material_receipt.sql',
      '../../read/projections/custody_ledger_entry.sql',
      '../../read/projections/job_work_output.sql',
      '../../read/projections/jobwork_return_clock.sql',
      '../../read/projections/dispatch_document.sql',
      '../../read/projections/job_work_billing_feed.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
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

    siteAId = await seedLocation('site', `SITE-A-9-6-${run}`, null);
    siteBId = await seedLocation('site', `SITE-B-9-6-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId);
    customerItemId = await seedItem(SKU);
    const companyItemId = await seedItem(SKU_COMPANY);
    await seedItem(SKU_OWNED);

    coordinatorUserId = await provisionUser(port, `jw-coord-9-6-${run}@example.com`, [
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'custody', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coord-9-6-${run}@example.com`);

    // A SECOND jobwork writer: the only actor the SoD arm lets acknowledge a feed.
    acknowledgerUserId = await provisionUser(port, `jw-ack-9-6-${run}@example.com`, [
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    acknowledgerHeaders = await authFor(port, `jw-ack-9-6-${run}@example.com`);

    storeUserId = await provisionUser(port, `jw-store-9-6-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-6-${run}@example.com`);

    await provisionUser(port, `qc-inspector-9-6-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-9-6-${run}@example.com`);

    await provisionUser(port, `qc-head-9-6-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-9-6-${run}@example.com`);

    await provisionUser(port, `compliance-9-6-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-9-6-${run}@example.com`);

    await provisionUser(port, `jw-readonly-9-6-${run}@example.com`, [
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    readOnlyHeaders = await authFor(port, `jw-readonly-9-6-${run}@example.com`);

    await provisionUser(port, `outsider-9-6-${run}@example.com`, [
      { role: 'maintenance_viewer', module: 'maintenance', functionScope: 'read', locationId: '*' },
    ]);
    outsiderHeaders = await authFor(port, `outsider-9-6-${run}@example.com`);

    await provisionUser(port, `jw-other-site-9-6-${run}@example.com`, [
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'write', locationId: siteBId },
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'read', locationId: siteBId },
    ]);
    otherSiteHeaders = await authFor(port, `jw-other-site-9-6-${run}@example.com`);

    // site_head holder so the escalation tier of the billing alert has a real recipient.
    await provisionUser(port, `site-head-9-6-${run}@example.com`, [
      { role: SITE_HEAD_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);

    for (const [transactionType, role] of [['qc.inspection_plan_approval', 'qc_head']]) {
      const entry = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { role, transaction_type: transactionType, value_min: null, value_max: null },
        complianceHeaders,
      );
      assert.strictEqual(entry.status, 201, `${transactionType}: ${JSON.stringify(entry.body)}`);
    }

    const kit = await seedKitBom([
      { sku: SKU, itemId: customerItemId, supplySource: 'customer' },
      { sku: SKU_COMPANY, itemId: companyItemId, supplySource: 'company' },
    ]);
    kitBomId = kit.bomId;
    kitRevisionId = kit.revisionId;
    outputItemId = kit.itemId;

    // One plan for the job-work OUTPUT item (dispatch needs a released lot). The converted offcut
    // lot carries the Story 8.5 governed hold instead of a plan-bound task (Binding decision 19):
    // inspection plans are grained on a BOM revision whose parent must be the item, and customer
    // raw material has no BOM.
    await approvePlan('output', outputItemId);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // Task 0: the contracted offcut rate lives on the order
  // -------------------------------------------------------------------------

  it('Task 0: a contractual order refuses confirm without an offcut rate, and confirms with the pair', async () => {
    const orderId = await createDraftOrder({ contractual: true });
    const noRate = await confirmOrder(orderId, { offcut_election: 'retain_and_buy' });
    assert.strictEqual(noRate.status, 409, JSON.stringify(noRate.body));
    assert.strictEqual(noRate.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual(detailsOf(noRate.body)['field'], 'offcut_rate');
    assert.strictEqual((await orderRow(orderId))['status'], 'draft');

    // Direct-event arm: the gate lives in the seam, not the route.
    const direct = await postEvent({
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.order_confirmed',
      payload: { service_order_id: orderId, offcut_election: 'retain_and_buy' },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: coordinatorUserId, role: COORDINATOR_ROLE, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    });
    assert.strictEqual(direct.status, 409, JSON.stringify(direct.body));
    assert.strictEqual(direct.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual(detailsOf(direct.body)['field'], 'offcut_rate');
    assert.strictEqual((await orderRow(orderId))['status'], 'draft');

    const ok = await confirmOrder(orderId, {
      offcut_election: 'retain_and_buy',
      offcut_rate: CONTRACTED_RATE,
      offcut_currency: 'INR',
    });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const row = await orderRow(orderId);
    assert.strictEqual(row['offcut_rate'], '18.5000');
    assert.strictEqual(row['offcut_currency'], 'INR');
  });

  it('Task 0: a non-contractual order refuses a rate at confirm, and the currency must match the price basis', async () => {
    const plain = await createDraftOrder();
    const mirror = await confirmOrder(plain, { offcut_rate: '1.0000', offcut_currency: 'INR' });
    assert.strictEqual(mirror.status, 409, JSON.stringify(mirror.body));
    assert.strictEqual(mirror.body['error_code'], 'INVALID_STATE_TRANSITION');

    const contractual = await createDraftOrder({ contractual: true });
    const usd = await confirmOrder(contractual, {
      offcut_election: 'retain_and_buy',
      offcut_rate: CONTRACTED_RATE,
      offcut_currency: 'USD',
    });
    assert.strictEqual(usd.status, 400, JSON.stringify(usd.body));
    assert.strictEqual(usd.body['error_code'], 'INVALID_PARAMS');
    const numeric = await confirmOrder(contractual, {
      offcut_election: 'retain_and_buy',
      offcut_rate: 18.5,
      offcut_currency: 'INR',
    });
    assert.strictEqual(numeric.status, 400, JSON.stringify(numeric.body));
  });

  // -------------------------------------------------------------------------
  // AC 1: the `return` branch
  // -------------------------------------------------------------------------

  it('AC1: a `return` offcut drains custody through the CUSTODY_RETURN door and writes four dispatch documents', async () => {
    const { orderId, lot } = await inProcessOrder({ contractual: true, election: 'return' });
    const challan = `RET-${run}-${randomUUID().slice(0, 6)}`;
    const res = await postOffcut(orderId, lot, {
      quantity: '50',
      return_challan_number_ext: challan,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['custody_balance_after'], '950.000');
    const entry = res.body['entry'] as Record<string, unknown>;
    assert.strictEqual(entry['movement_category'], 'offcut');
    assert.strictEqual(entry['ownership'], 'customer');
    assert.strictEqual(entry['billable'], false);
    assert.strictEqual(entry['quantity_delta'], '-50.000');
    assert.strictEqual(entry['reference_ext'], challan);

    assert.strictEqual(await custodyBalance(orderId), '950.000');
    assert.strictEqual(await stockOnHand(SKU, lot, 'job_work'), '950.000');

    const payload = await storedPayload(res.body['event_id'] as string);
    assert.strictEqual(payload['election'], 'return');
    assert.strictEqual(payload['converted_lot_number'], null);
    assert.strictEqual(payload['billable_value'], null);

    const docs = await documentsFor(orderId);
    assert.deepStrictEqual(
      docs.map((d) => d['document_type']),
      ['bol', 'commercial_invoice', 'label', 'packing_slip'],
    );
    const challanDoc = docs.find((d) => d['document_type'] === 'commercial_invoice')!;
    assert.ok(
      (challanDoc['document_content'] as string).includes('JOB-WORK OFFCUT RETURN CHALLAN'),
    );
    assert.ok((challanDoc['document_content'] as string).includes(challan));
    assert.strictEqual(challanDoc['generated_by'], coordinatorUserId);

    // The clock absorbs the returned quantity (non-strict, reconciled_qty).
    const clock = await getAdminPool().query(
      `SELECT reconciled_qty::text AS reconciled_qty FROM jobwork_return_clock WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(clock.rows[0]!['reconciled_qty'], '50.000');
  });

  it('AC1: a `return` offcut without a challan number refuses INVALID_PARAMS; with a rate estimate refuses INVALID_PARAMS', async () => {
    const { orderId, lot } = await inProcessOrder({ contractual: true, election: 'return' });
    const noChallan = await postOffcut(orderId, lot, { quantity: '5' });
    assert.strictEqual(noChallan.status, 400, JSON.stringify(noChallan.body));
    assert.strictEqual(noChallan.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(noChallan.body)['field'], 'return_challan_number_ext');

    const withOverride = await postOffcut(orderId, lot, {
      quantity: '5',
      return_challan_number_ext: `RET-${run}-x`,
      offcut_rate_estimate: '20.0000',
    });
    assert.strictEqual(withOverride.status, 400, JSON.stringify(withOverride.body));
    assert.strictEqual(withOverride.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(withOverride.body)['field'], 'offcut_rate_estimate');
    assert.strictEqual(await custodyBalance(orderId), '1000.000');
    assert.strictEqual((await documentsFor(orderId)).length, 0);
  });

  // -------------------------------------------------------------------------
  // AC 2: retain_and_buy
  // -------------------------------------------------------------------------

  it('AC2: retain_and_buy drains custody, mints a QC-held owned lot, and bills quantity x the contracted rate', async () => {
    const { orderId, lot } = await inProcessOrder({
      contractual: true,
      election: 'retain_and_buy',
    });
    const res = await postOffcut(orderId, lot, { quantity: '40' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const entry = res.body['entry'] as Record<string, unknown>;
    assert.strictEqual(entry['billable'], true);
    assert.strictEqual(entry['quantity_delta'], '-40.000');
    const order = await orderRow(orderId);
    assert.strictEqual(entry['reference_ext'], order['order_number_ext']);

    const payload = await storedPayload(res.body['event_id'] as string);
    assert.strictEqual(payload['election'], 'retain_and_buy');
    assert.strictEqual(payload['effective_offcut_rate'], '18.5000');
    assert.strictEqual(payload['billable_value'], '740.0000');
    const converted = payload['converted_lot_number'] as string;
    assert.strictEqual(
      converted,
      `${order['order_number_ext']}-${(order['site_id'] as string).slice(0, 8)}-OC1`,
    );
    assert.strictEqual(await custodyBalance(orderId), '960.000');
    assert.strictEqual(await stockOnHand(SKU, lot, 'job_work'), '960.000');
    assert.strictEqual(await stockOnHand(SKU, converted, 'owned'), '40.000');

    // Binding decision 19: held for QC on mint and NOT allocatable through the gate predicate.
    const hold = await qcHeld(converted);
    assert.strictEqual(hold.holdStatus, 'held');
    assert.strictEqual(hold.openHolds, 1);
    assert.strictEqual(hold.held, true);
    assert.ok(payload['converted_lot_hold_id']);

    // Genealogy (disclosed): lot_trace is UNIQUE on event_id, so the offcut event carries the
    // customer lot's drain row only; the owned lot's first trace row is written by the hold event,
    // whose causation_id is the offcut event.
    const trace = await getAdminPool().query(
      `SELECT lm.lot_number, lt.quantity_change::numeric(18,3)::text AS quantity_change FROM lot_trace lt
         JOIN lot_master lm ON lm.lot_id = lt.lot_id
        WHERE lt.event_id = $1`,
      [res.body['event_id']],
    );
    assert.deepStrictEqual(
      trace.rows.map((r: Record<string, unknown>) => [r['lot_number'], r['quantity_change']]),
      [[lot, '-40.000']],
    );
    const holdTrace = await getAdminPool().query(
      `SELECT lt.event_type, de.metadata->>'causation_id' AS causation_id
         FROM lot_trace lt
         JOIN lot_master lm ON lm.lot_id = lt.lot_id
         JOIN domain_events de ON de.event_id = lt.event_id
        WHERE lm.lot_number = $1`,
      [converted],
    );
    assert.strictEqual(holdTrace.rows.length, 1, JSON.stringify(holdTrace.rows));
    assert.strictEqual(holdTrace.rows[0]!['event_type'], 'qc.hold_placed');
    assert.strictEqual(holdTrace.rows[0]!['causation_id'], res.body['event_id']);
  });

  it('AC2 (PO ruling, open question 6): a real-time offcut_rate_estimate IS the settlement rate, no approval; the contracted rate rides beside it', async () => {
    const { orderId, lot } = await inProcessOrder({
      contractual: true,
      election: 'retain_and_buy',
    });
    // A number literal is refused at the shape assert; the estimate is an exact decimal string.
    const numeric = await postOffcut(orderId, lot, { quantity: '10', offcut_rate_estimate: 20 });
    assert.strictEqual(numeric.status, 400, JSON.stringify(numeric.body));
    assert.strictEqual(numeric.body['error_code'], 'INVALID_PARAMS');

    // The coordinator posts the estimate directly: no DOA approver, no approved_by.
    const estimated = await postOffcut(orderId, lot, {
      quantity: '10',
      offcut_rate_estimate: '20.0000',
    });
    assert.strictEqual(estimated.status, 201, JSON.stringify(estimated.body));
    const payload = await storedPayload(estimated.body['event_id'] as string);
    assert.strictEqual(payload['effective_offcut_rate'], '20.0000');
    assert.strictEqual(payload['contracted_offcut_rate'], '18.5000');
    assert.strictEqual(payload['billable_value'], '200.0000');
    assert.strictEqual(payload['approved_by'], undefined);
    assert.strictEqual(await custodyBalance(orderId), '990.000');

    // An estimate equal to the contracted rate is simply the rate; no refusal.
    const same = await postOffcut(orderId, lot, { quantity: '5', offcut_rate_estimate: '18.5' });
    assert.strictEqual(same.status, 201, JSON.stringify(same.body));
    const samePayload = await storedPayload(same.body['event_id'] as string);
    assert.strictEqual(samePayload['effective_offcut_rate'], '18.5');
    assert.strictEqual(samePayload['billable_value'], '92.5000');

    // Without an estimate the contracted rate is the effective rate, stamped in both slots.
    const contracted = await postOffcut(orderId, lot, { quantity: '2', settles_offcut: true });
    assert.strictEqual(contracted.status, 201, JSON.stringify(contracted.body));
    const contractedPayload = await storedPayload(contracted.body['event_id'] as string);
    assert.strictEqual(contractedPayload['effective_offcut_rate'], '18.5000');
    assert.strictEqual(contractedPayload['contracted_offcut_rate'], '18.5000');
    assert.strictEqual(contractedPayload['billable_value'], '37.0000');
  });

  // -------------------------------------------------------------------------
  // AC 3: retain_free
  // -------------------------------------------------------------------------

  it('AC3: retain_free drains custody with billable = false, converts to a QC-held owned lot, and refuses an estimate', async () => {
    const { orderId, lot } = await inProcessOrder({ contractual: true, election: 'retain_free' });
    const withOverride = await postOffcut(orderId, lot, {
      quantity: '5',
      offcut_rate_estimate: '1.0000',
    });
    assert.strictEqual(withOverride.status, 400, JSON.stringify(withOverride.body));
    assert.strictEqual(withOverride.body['error_code'], 'INVALID_PARAMS');

    const res = await postOffcut(orderId, lot, { quantity: '30' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const entry = res.body['entry'] as Record<string, unknown>;
    assert.strictEqual(entry['billable'], false);
    assert.strictEqual(entry['reference_ext'], 'offcut_election:retain_free');
    const payload = await storedPayload(res.body['event_id'] as string);
    assert.strictEqual(payload['election'], 'retain_free');
    assert.strictEqual(payload['billable_value'], null);
    assert.strictEqual(payload['effective_offcut_rate'], null);
    const converted = payload['converted_lot_number'] as string;
    assert.ok(converted.endsWith('-OC1'));
    assert.strictEqual(await stockOnHand(SKU, converted, 'owned'), '30.000');
    assert.strictEqual(await custodyBalance(orderId), '970.000');
    assert.strictEqual((await qcHeld(converted)).held, true);
    assert.strictEqual((await documentsFor(orderId)).length, 0);
  });

  // -------------------------------------------------------------------------
  // Election gate and settlement (Binding decisions 1, 15)
  // -------------------------------------------------------------------------

  it('an offcut on an order with no contractual arrangement refuses OFFCUT_ELECTION_MISSING (audited)', async () => {
    const { orderId, lot } = await inProcessOrder();
    const res = await postOffcut(orderId, lot, { quantity: '5' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'OFFCUT_ELECTION_MISSING');
    assert.strictEqual(detailsOf(res.body)['reason'], 'not_contractual');
    assert.ok(await auditedFor('OFFCUT_ELECTION_MISSING', res.body['trace_id'] as string));
    assert.strictEqual(await custodyBalance(orderId), '1000.000');
    assert.strictEqual((await ledgerRows(orderId, 'offcut')).length, 0);
  });

  it('settles_offcut stamps the order; a further offcut refuses OFFCUT_ELECTION_MISSING with already_settled_at', async () => {
    const { orderId, lot } = await inProcessOrder({ contractual: true, election: 'return' });
    const first = await postOffcut(orderId, lot, {
      quantity: '20',
      return_challan_number_ext: `RET-${run}-a`,
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual((await orderRow(orderId))['offcut_settled_at'], null);

    const settling = await postOffcut(orderId, lot, {
      quantity: '20',
      return_challan_number_ext: `RET-${run}-b`,
      settles_offcut: true,
    });
    assert.strictEqual(settling.status, 201, JSON.stringify(settling.body));
    const row = await orderRow(orderId);
    assert.ok(row['offcut_settled_at']);
    assert.strictEqual(row['offcut_settled_by'], coordinatorUserId);

    const after = await postOffcut(orderId, lot, {
      quantity: '1',
      return_challan_number_ext: `RET-${run}-c`,
    });
    assert.strictEqual(after.status, 409, JSON.stringify(after.body));
    assert.strictEqual(after.body['error_code'], 'OFFCUT_ELECTION_MISSING');
    assert.strictEqual(detailsOf(after.body)['reason'], 'already_settled');
    assert.ok(detailsOf(after.body)['already_settled_at']);
    assert.strictEqual(await custodyBalance(orderId), '960.000');
  });

  it('an offcut replays on the same idempotency key (200, same event, one ledger row) and refuses derived fields', async () => {
    const { orderId, lot } = await inProcessOrder({ contractual: true, election: 'retain_free' });
    const key = randomUUID();
    const first = await postOffcut(orderId, lot, { quantity: '5', idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await postOffcut(orderId, lot, { quantity: '5', idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual((await ledgerRows(orderId, 'offcut')).length, 1);
    assert.strictEqual(await custodyBalance(orderId), '995.000');

    const derived = await postOffcut(orderId, lot, { quantity: '5', election: 'return' });
    assert.strictEqual(derived.status, 400, JSON.stringify(derived.body));
    assert.strictEqual(derived.body['error_code'], 'INVALID_PARAMS');
  });

  it('RBAC and site scope: read-only refuses 403, an off-site writer sees 404, an outsider gets 403 on the report', async () => {
    const { orderId, lot } = await inProcessOrder({ contractual: true, election: 'retain_free' });
    const ro = await postOffcut(orderId, lot, { quantity: '1' }, readOnlyHeaders);
    assert.strictEqual(ro.status, 403, JSON.stringify(ro.body));
    const offSite = await postOffcut(orderId, lot, { quantity: '1' }, otherSiteHeaders);
    assert.strictEqual(offSite.status, 403, JSON.stringify(offSite.body));
    assert.strictEqual(offSite.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const outsider = await report(outsiderHeaders);
    assert.strictEqual(outsider.status, 403, JSON.stringify(outsider.body));
    const feedOffSite = await generateFeed(orderId, {}, otherSiteHeaders);
    assert.strictEqual(feedOffSite.status, 403, JSON.stringify(feedOffSite.body));
  });

  // -------------------------------------------------------------------------
  // AC 4: billing feed generation, acknowledgment, the invoiced stamp
  // -------------------------------------------------------------------------

  it('AC4: generation with zero dispatches refuses BILLING_NOT_READY (no_dispatch, audited)', async () => {
    const { orderId, lot } = await inProcessOrder();
    assert.strictEqual((await consume(orderId, lot, '100')).status, 201);
    const res = await generateFeed(orderId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'BILLING_NOT_READY');
    assert.strictEqual(detailsOf(res.body)['reason'], 'no_dispatch');
    assert.ok(await auditedFor('BILLING_NOT_READY', res.body['trace_id'] as string));
  });

  it('AC4 / decision 18: one dispatch with output still open SUCCEEDS and records open_to_dispatch_qty on the feed and the report', async () => {
    const { orderId } = await dispatchedOrder();
    // An own-material line (FR-JW-07) so the feed carries it.
    const ownedLot = `LOT-OWN-${run}-${randomUUID().slice(0, 6)}`;
    const seed = await postEvent(
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.received',
        payload: {
          business_stream: 'job_work',
          sku: SKU_OWNED,
          target_location_id: dockId,
          quantity: 20,
          lot_id: ownedLot,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: storeUserId, role: 'store_assistant', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      storeHeaders,
    );
    assert.strictEqual(seed.status, 201, JSON.stringify(seed.body));
    const own = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/own-material`,
      {
        sku: SKU_OWNED,
        lot_id: ownedLot,
        location_id: dockId,
        quantity: '5.5',
        uom: 'KG',
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
    assert.strictEqual(own.status, 201, JSON.stringify(own.body));

    const key = randomUUID();
    const res = await generateFeed(orderId, { idempotency_key: key });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const feed = res.body['feed'] as Record<string, unknown>;
    assert.strictEqual(feed['status'], 'pending');
    assert.strictEqual(feed['measured_basis'], 'per_kg');
    assert.strictEqual(feed['measured_quantity'], '20.000');
    // 20 kg x 12.5 = 250.0000, no offcut value.
    assert.strictEqual(feed['total_value'], '250.0000');
    assert.strictEqual(feed['currency'], 'INR');
    assert.strictEqual(feed['open_to_dispatch_qty'], '30.000');
    assert.strictEqual(feed['generated_by'], coordinatorUserId);
    const payload = feed['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['feed_type'], 'job_work_billing');
    assert.strictEqual(payload['idempotency_key'], key);
    assert.strictEqual((payload['challan_references'] as unknown[]).length, 1);
    assert.strictEqual((payload['dispatch_lines'] as unknown[]).length, 1);
    const ownLines = payload['own_material_lines'] as Record<string, unknown>[];
    assert.strictEqual(ownLines.length, 1);
    assert.strictEqual(ownLines[0]!['sku'], SKU_OWNED);
    assert.strictEqual(ownLines[0]!['quantity'], '5.500');
    assert.deepStrictEqual(payload['retain_and_buy_lines'], []);
    assert.strictEqual(payload['open_to_dispatch_qty'], '30.000');
    assert.strictEqual((await orderRow(orderId))['invoiced_at'], null);

    // A replay returns the same event; a fresh key collides on the schema rule.
    const replay = await generateFeed(orderId, { idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], res.body['event_id']);
    const second = await generateFeed(orderId);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(second.body)['constraint'], 'uq_job_work_billing_feed_order');

    const rep = await report();
    assert.strictEqual(rep.status, 200, JSON.stringify(rep.body));
    const row = (rep.body['rows'] as Record<string, unknown>[]).find(
      (r) => r['feed_id'] === feed['feed_id'],
    );
    assert.ok(row, 'feed missing from the reconciliation report');
    assert.strictEqual(row['status'], 'pending');
    assert.strictEqual(row['exception'], false);
    assert.strictEqual(row['open_to_dispatch_qty'], '30.000');
    assert.strictEqual(row['open_to_dispatch'], true);
    assert.strictEqual(row['retry_window_elapsed'], false);
  });

  it('AC4 / decision 15: a contractual order refuses billing until the settling offcut lands, then carries the retain-and-buy line', async () => {
    const { orderId, lot } = await dispatchedOrder({
      contractual: true,
      election: 'retain_and_buy',
    });
    const blocked = await generateFeed(orderId);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'BILLING_NOT_READY');
    assert.strictEqual(detailsOf(blocked.body)['reason'], 'offcut_not_settled');

    const settle = await postOffcut(orderId, lot, { quantity: '40', settles_offcut: true });
    assert.strictEqual(settle.status, 201, JSON.stringify(settle.body));

    const res = await generateFeed(orderId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const feed = res.body['feed'] as Record<string, unknown>;
    const payload = feed['payload'] as Record<string, unknown>;
    const lines = payload['retain_and_buy_lines'] as Record<string, unknown>[];
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0]!['quantity'], '40.000');
    assert.strictEqual(lines[0]!['offcut_rate'], '18.5000');
    assert.strictEqual(lines[0]!['contracted_offcut_rate'], '18.5000');
    assert.strictEqual(lines[0]!['billable_value'], '740.0000');
    assert.strictEqual(lines[0]!['currency'], 'INR');
    assert.ok((lines[0]!['converted_lot_number'] as string).endsWith('-OC1'));
    assert.strictEqual(payload['service_value'], '250.0000');
    assert.strictEqual(payload['offcut_value'], '740.0000');
    assert.strictEqual(feed['total_value'], '990.0000');
  });

  it('AC4: acknowledgment by a SECOND actor stamps invoiced_at; self-acknowledgment refuses SOD_VIOLATION (audited); a second acknowledgment refuses DUPLICATE_EVENT', async () => {
    const { orderId } = await dispatchedOrder();
    const gen = await generateFeed(orderId);
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    const feedId = gen.body['feed_id'] as string;

    const self = await acknowledge(feedId, {}, coordinatorHeaders);
    assert.strictEqual(self.status, 409, JSON.stringify(self.body));
    assert.strictEqual(self.body['error_code'], 'SOD_VIOLATION');
    assert.strictEqual(detailsOf(self.body)['generated_by'], coordinatorUserId);
    assert.ok(await auditedFor('SOD_VIOLATION', self.body['trace_id'] as string));
    assert.strictEqual((await feedRow(feedId))!['status'], 'pending');
    assert.strictEqual((await orderRow(orderId))['invoiced_at'], null);

    const blank = await acknowledge(feedId, { acknowledged_ref_ext: '  ' });
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));

    const ref = `ERP-INV-${run}-ok`;
    const key = randomUUID();
    const ok = await acknowledge(feedId, { acknowledged_ref_ext: ref, idempotency_key: key });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const feed = ok.body['feed'] as Record<string, unknown>;
    assert.strictEqual(feed['status'], 'acknowledged');
    assert.strictEqual(feed['acknowledged_by'], acknowledgerUserId);
    assert.strictEqual(feed['acknowledged_ref_ext'], ref);
    assert.ok(ok.body['invoiced_at']);
    assert.strictEqual(ok.body['invoiced_feed_id'], feedId);
    const order = await orderRow(orderId);
    assert.ok(order['invoiced_at']);
    assert.strictEqual(order['invoiced_feed_id'], feedId);
    assert.strictEqual(order['status'], 'in_process', 'invoiced is never a status');

    const replay = await acknowledge(feedId, { acknowledged_ref_ext: ref, idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], ok.body['event_id']);
    const again = await acknowledge(feedId);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'DUPLICATE_EVENT');

    // Acknowledged feeds leave the reconciliation report.
    const rep = await report();
    assert.ok(
      !(rep.body['rows'] as Record<string, unknown>[]).some((r) => r['feed_id'] === feedId),
    );
  });

  // Story 9.6 code review 2026-09-05: the two guards that replace BSD-16's removed DOA chain. The
  // settling posting is the only place the retain-and-buy rate is named AND the posting that stamps
  // the sole billing precondition, so an unbounded rate plus a settler-acknowledged feed let one
  // actor price the customer's scrap and sign off the invoice for it.
  it('a settlement rate outside the governed band refuses OFFCUT_RATE_OUT_OF_BAND (audited)', async () => {
    const { orderId, lot } = await inProcessOrder({
      contractual: true,
      election: 'retain_and_buy',
    });
    // Contracted 18.5000, band 10%: 20.3500 is the edge and passes, 20.3501 is one tick past it.
    const high = await postOffcut(orderId, lot, {
      quantity: '10',
      offcut_rate_estimate: '20.3501',
    });
    assert.strictEqual(high.status, 409, JSON.stringify(high.body));
    assert.strictEqual(high.body['error_code'], 'OFFCUT_RATE_OUT_OF_BAND');
    assert.strictEqual(detailsOf(high.body)['contracted_offcut_rate'], '18.5000');
    assert.ok(await auditedFor('OFFCUT_RATE_OUT_OF_BAND', high.body['trace_id'] as string));
    assert.strictEqual(await custodyBalance(orderId), '1000.000', 'a refusal drains nothing');

    const low = await postOffcut(orderId, lot, { quantity: '10', offcut_rate_estimate: '0.0001' });
    assert.strictEqual(low.status, 409, JSON.stringify(low.body));
    assert.strictEqual(low.body['error_code'], 'OFFCUT_RATE_OUT_OF_BAND');

    const edge = await postOffcut(orderId, lot, {
      quantity: '10',
      offcut_rate_estimate: '20.3500',
    });
    assert.strictEqual(edge.status, 201, JSON.stringify(edge.body));
    const payload = await storedPayload(edge.body['event_id'] as string);
    assert.strictEqual(payload['effective_offcut_rate'], '20.3500');
  });

  it('AC4: a feed cannot be acknowledged by the actor who settled the offcut it bills', async () => {
    const { orderId, lot } = await dispatchedOrder({
      contractual: true,
      election: 'retain_and_buy',
    });
    // The ACKNOWLEDGER settles the offcut; the coordinator generates, so the generator leg is clean
    // and only the settler leg can refuse.
    const settle = await postOffcut(
      orderId,
      lot,
      { quantity: '10', settles_offcut: true },
      acknowledgerHeaders,
    );
    assert.strictEqual(settle.status, 201, JSON.stringify(settle.body));
    assert.strictEqual((await orderRow(orderId))['offcut_settled_by'], acknowledgerUserId);

    const gen = await generateFeed(orderId);
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    const feedId = gen.body['feed_id'] as string;

    const settler = await acknowledge(feedId);
    assert.strictEqual(settler.status, 409, JSON.stringify(settler.body));
    assert.strictEqual(settler.body['error_code'], 'SOD_VIOLATION');
    assert.strictEqual(detailsOf(settler.body)['reason'], 'offcut_settler');
    assert.strictEqual(detailsOf(settler.body)['offcut_settled_by'], acknowledgerUserId);
    assert.ok(await auditedFor('SOD_VIOLATION', settler.body['trace_id'] as string));
    assert.strictEqual((await feedRow(feedId))!['status'], 'pending');
    assert.strictEqual((await orderRow(orderId))['invoiced_at'], null);
  });

  it('AC4 / decision 12: a per_hour price basis needs measured_hours and bills them', async () => {
    const { orderId } = await dispatchedOrder({ basisType: 'per_hour' });
    const missing = await generateFeed(orderId);
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(missing.body)['field'], 'measured_hours');
    const res = await generateFeed(orderId, { measured_hours: '7.5' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const feed = res.body['feed'] as Record<string, unknown>;
    assert.strictEqual(feed['measured_basis'], 'per_hour');
    assert.strictEqual(feed['measured_quantity'], '7.500');
    assert.strictEqual(feed['total_value'], '93.7500');
  });

  // -------------------------------------------------------------------------
  // AC 5: retry window, exception queue, alert, reconciliation
  // -------------------------------------------------------------------------

  it('AC5: the sweep flips a feed past the retry window to exception, alerts the coordinator with an escalation, and a second tick is a no-op', async () => {
    const { orderId } = await dispatchedOrder();
    const gen = await generateFeed(orderId);
    assert.strictEqual(gen.status, 201, JSON.stringify(gen.body));
    const feedId = gen.body['feed_id'] as string;

    // Inside the window: nothing happens.
    const early = await runJobWorkBillingFeedSweepCycle();
    assert.strictEqual(early.cycleFailed, false);
    assert.strictEqual((await feedRow(feedId))!['status'], 'pending');

    await getAdminPool().query(
      `UPDATE job_work_billing_feed SET first_sent_at = now() - interval '25 hours' WHERE feed_id = $1`,
      [feedId],
    );
    const tick = await runJobWorkBillingFeedSweepCycle();
    assert.strictEqual(tick.cycleFailed, false, JSON.stringify(tick));
    assert.strictEqual(tick.failed, 0);
    assert.ok(tick.exceptions >= 1, JSON.stringify(tick));
    const row = (await feedRow(feedId))!;
    assert.strictEqual(row['status'], 'exception');
    assert.ok(row['exception_raised_at']);
    assert.ok(row['alert_sent_at']);

    const notes = await notificationsFor(feedId);
    assert.strictEqual(notes.length, 1, JSON.stringify(notes));
    const target = notes[0]!['target'] as Record<string, unknown>;
    assert.strictEqual(target['role'], COORDINATOR_ROLE);
    assert.strictEqual(target['location_id'], siteAId);
    assert.strictEqual(notes[0]!['event_type'], 'jobwork_billing_feed_exception');
    const escalation = notes[0]!['escalation'] as Record<string, unknown>;
    assert.strictEqual(escalation['target_role'], SITE_HEAD_ROLE);
    assert.strictEqual(escalation['acknowledgment_window_seconds'], 259_200);

    const second = await runJobWorkBillingFeedSweepCycle();
    assert.strictEqual(second.cycleFailed, false);
    assert.strictEqual((await notificationsFor(feedId)).length, 1, 'the second tick re-alerted');
    assert.strictEqual((await feedRow(feedId))!['status'], 'exception');

    const rep = await report();
    const reported = (rep.body['rows'] as Record<string, unknown>[]).find(
      (r) => r['feed_id'] === feedId,
    );
    assert.ok(reported);
    assert.strictEqual(reported['status'], 'exception');
    assert.strictEqual(reported['exception'], true);
    assert.strictEqual(reported['retry_window_elapsed'], true);

    // An exception feed can still be acknowledged once ERP catches up.
    const ack = await acknowledge(feedId);
    assert.strictEqual(ack.status, 200, JSON.stringify(ack.body));
    assert.strictEqual((await feedRow(feedId))!['status'], 'acknowledged');
  });

  // -------------------------------------------------------------------------
  // Task 10.5: direct-event bypass arms hit the identical gates
  // -------------------------------------------------------------------------

  it('direct POST /api/v1/events: custody.offcut_recorded meets OFFCUT_ELECTION_MISSING and the settled gate; `election` is refused on input', async () => {
    const plain = await inProcessOrder();
    const res = await postEvent(offcutEnvelope(plain.orderId, plain.lot));
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'OFFCUT_ELECTION_MISSING');
    assert.strictEqual(await custodyBalance(plain.orderId), '1000.000');

    const named = await postEvent(
      offcutEnvelope(plain.orderId, plain.lot, { election: 'retain_free' }),
    );
    assert.strictEqual(named.status, 400, JSON.stringify(named.body));
    assert.strictEqual(named.body['error_code'], 'INVALID_PARAMS');

    const settled = await inProcessOrder({ contractual: true, election: 'retain_free' });
    const settling = await postOffcut(settled.orderId, settled.lot, {
      quantity: '5',
      settles_offcut: true,
    });
    assert.strictEqual(settling.status, 201, JSON.stringify(settling.body));
    const after = await postEvent(offcutEnvelope(settled.orderId, settled.lot));
    assert.strictEqual(after.status, 409, JSON.stringify(after.body));
    assert.strictEqual(after.body['error_code'], 'OFFCUT_ELECTION_MISSING');
    assert.strictEqual(detailsOf(after.body)['reason'], 'already_settled');
    assert.strictEqual(await custodyBalance(settled.orderId), '995.000');

    // And the legitimate direct event succeeds through the same seam.
    const open = await inProcessOrder({ contractual: true, election: 'retain_free' });
    const ok = await postEvent(offcutEnvelope(open.orderId, open.lot));
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(await custodyBalance(open.orderId), '990.000');
  });

  it('direct POST /api/v1/events: jobwork.billing_feed_generated meets both BILLING_NOT_READY legs; acknowledgment meets SOD_VIOLATION', async () => {
    function generatedEnvelope(orderId: string, actorId = coordinatorUserId) {
      return {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.billing_feed_generated',
        payload: {
          service_order_id: orderId,
          feed_id: randomUUID(),
          site_id: siteAId,
          generated_by: actorId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actorId, role: COORDINATOR_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      };
    }
    const noDispatch = await inProcessOrder();
    const a = await postEvent(generatedEnvelope(noDispatch.orderId));
    assert.strictEqual(a.status, 409, JSON.stringify(a.body));
    assert.strictEqual(a.body['error_code'], 'BILLING_NOT_READY');
    assert.strictEqual(detailsOf(a.body)['reason'], 'no_dispatch');

    const unsettled = await dispatchedOrder({ contractual: true, election: 'retain_and_buy' });
    const b = await postEvent(generatedEnvelope(unsettled.orderId));
    assert.strictEqual(b.status, 409, JSON.stringify(b.body));
    assert.strictEqual(b.body['error_code'], 'BILLING_NOT_READY');
    assert.strictEqual(detailsOf(b.body)['reason'], 'offcut_not_settled');

    // A forged generated_by (someone else's id) is refused before any write.
    const forged = await postEvent(generatedEnvelope(unsettled.orderId, acknowledgerUserId));
    assert.strictEqual(forged.status, 403, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // The `erp` stream is refused outright (Binding decision 7): RBAC has no `erp` module for a
    // job-work writer (403) and assertErpReadOnly 405s anyone who gets past it. Never a 201.
    const erp = await postEvent({ ...generatedEnvelope(unsettled.orderId), stream_type: 'erp' });
    assert.ok([403, 405].includes(erp.status), JSON.stringify(erp.body));
    assert.strictEqual(
      (
        await getAdminPool().query(
          `SELECT count(*)::int AS n FROM job_work_billing_feed WHERE service_order_id = $1`,
          [unsettled.orderId],
        )
      ).rows[0]!['n'],
      0,
    );

    const settle = await postOffcut(unsettled.orderId, unsettled.lot, {
      quantity: '1',
      settles_offcut: true,
    });
    assert.strictEqual(settle.status, 201, JSON.stringify(settle.body));
    const ok = await postEvent(generatedEnvelope(unsettled.orderId));
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    const feedId =
      ((ok.body['payload'] as Record<string, unknown> | undefined)?.['feed_id'] as string) ??
      ((
        await getAdminPool().query(
          `SELECT feed_id FROM job_work_billing_feed WHERE service_order_id = $1`,
          [unsettled.orderId],
        )
      ).rows[0]!['feed_id'] as string);

    const selfAck = await postEvent({
      stream_type: 'jobwork',
      stream_id: unsettled.orderId,
      event_type: 'jobwork.billing_feed_acknowledged',
      payload: {
        feed_id: feedId,
        service_order_id: unsettled.orderId,
        acknowledged_ref_ext: 'ERP-DIRECT',
        acknowledged_by: coordinatorUserId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: coordinatorUserId, role: COORDINATOR_ROLE, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    });
    assert.strictEqual(selfAck.status, 409, JSON.stringify(selfAck.body));
    assert.strictEqual(selfAck.body['error_code'], 'SOD_VIOLATION');
    assert.strictEqual((await feedRow(feedId))!['status'], 'pending');
    assert.strictEqual((await orderRow(unsettled.orderId))['invoiced_at'], null);
  });

  // -------------------------------------------------------------------------
  // Closure interplay (Binding decision 10): the EXISTING gate enforces execution
  // -------------------------------------------------------------------------

  it('decision 10: an order with unexecuted offcut still fails CUSTODY_NOT_ZERO; executing it to zero lets closure through', async () => {
    const { orderId, lot } = await inProcessOrder({
      contractual: true,
      election: 'retain_free',
      qty: '10',
    });
    const blocked = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/closure`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'CUSTODY_NOT_ZERO');

    const settle = await postOffcut(orderId, lot, { quantity: '10', settles_offcut: true });
    assert.strictEqual(settle.status, 201, JSON.stringify(settle.body));
    assert.strictEqual(await custodyBalance(orderId), '0.000');
    const closed = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/closure`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    assert.strictEqual((await orderRow(orderId))['status'], 'closed');
  });
});

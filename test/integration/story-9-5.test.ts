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
import { qtyFromScaled, qtyToScaled } from '../../src/compliance/custody-statement.js';
import { runJobworkClockSweepCycle } from '../../src/notify/jobwork-clock-sweep.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';

/**
 * Story 9.5 Statutory Return Clocks and Closure Gate (FR-AC-11, FR-JW-13/14/15). Real PostgreSQL,
 * the real production router, SCIM provisioning and dev-token auth. Tests run serially; every
 * identifier is run-scoped. Fixture writes use the admin pool. The harness scaffolding is a
 * deliberate local re-implementation of the story-9-4 closures (never import cross-story). The
 * sweep is called DIRECTLY (the retention-expiry.ts convention), with challan dates backdated so
 * breach and alert windows are exercised without waiting real calendar time.
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

/** Pure UTC calendar shift of a YYYY-MM-DD string (the same arithmetic the seam is pinned on). */
function shiftDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Story 9.5 code review (chunks 3/4): the role names and the escalation window are asserted as
// LITERALS, never against the sweep's own exported constants or against config. Importing
// JOBWORK_CLOCK_*_ROLE from the module under test and comparing the notification to it is the 8.4
// "config asserted against itself" defect: renaming the constant to a role nobody holds kept every
// arm green while the statutory alert went to nobody. These three strings are what AC3 and AC5 name,
// and 259200 is the three-day default Task 2.1 discloses.
const COORDINATOR_ROLE = 'jobwork_coordinator';
const COMPLIANCE_ROLE = 'compliance_officer';
const SITE_HEAD_ROLE = 'site_head';
const ESCALATION_WINDOW_SECONDS = 259_200;

describe('Story 9.5 Statutory Return Clocks and Closure Gate', () => {
  let server: Server;
  let port: number;

  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let signerHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;
  let counterUserId: string;
  let counterHeaders: Record<string, string>;
  let reclassifierHeaders: Record<string, string>;
  let siteHeadUserId: string;
  let otherSiteReclassifierHeaders: Record<string, string>;
  let readOnlyHeaders: Record<string, string>;

  let siteAId: string;
  let siteBId: string;
  let dockId: string;
  let kitBomId: string;
  let kitRevisionId: string;
  let outputItemId: string;
  let characteristicId: string;

  const TODAY = toIstCalendarDate(new Date());
  const CUSTOMER = `CUST-9-5-${RUN}`;
  const SKU = `SKU-CUST-9-5-${RUN}`;
  const SKU2 = `SKU-CUST2-9-5-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-9-5-${RUN}`;
  const OUTPUT_SKU = `SKU-OUT-9-5-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-5-${run}`;
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
    const poRef = `PO-JW-9-5-${run}-${poCounter}`;
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
       VALUES ($1, $2, $3, $4, 'site-A-9-5', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-5', 'MANUAL', $6, $7, $8)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, coordinatorUserId, TODAY, randomUUID()],
    );
    return token;
  }

  async function confirmedOrder(): Promise<string> {
    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/service-orders',
      {
        site_id: siteAId,
        customer_party_code: CUSTOMER,
        customer_name: 'Acme Fabrication Pvt Ltd',
        price_basis: { basis_type: 'per_kg', rate: 12.5, currency: 'INR' },
        kit_bom_id: kitBomId,
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
    assert.strictEqual(create.status, 201, `create order failed: ${JSON.stringify(create.body)}`);
    const orderId = (create.body['service_order'] as Record<string, unknown>)[
      'service_order_id'
    ] as string;
    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/confirm`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
    return orderId;
  }

  interface ReceiveOpts {
    sku?: string;
    qty?: string;
    challanQty?: string;
    challanDate?: string;
    challanClass?: 'input' | 'capital_goods';
  }

  /** A customer-material GRN line; returns the lot number and the receipt's challan number. */
  async function receive(
    serviceOrderId: string,
    opts: ReceiveOpts = {},
  ): Promise<{ lot: string; challan: string; receiptId: string }> {
    const sku = opts.sku ?? SKU;
    const qty = opts.qty ?? '5000';
    const poRef = await seedPo(sku);
    const token = await seedToken(poRef);
    const lot = `LOT-JW-9-5-${run}-${randomUUID().slice(0, 6)}`;
    const challan = `CH-${run}-${randomUUID().slice(0, 6)}`;
    const receiptId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        receipt_id: receiptId,
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
        challan_date: opts.challanDate ?? '2026-09-01',
        challan_qty: opts.challanQty ?? qty,
        ...(opts.challanClass ? { challan_class: opts.challanClass } : {}),
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 201, `receipt failed: ${JSON.stringify(res.body)}`);
    return { lot, challan, receiptId };
  }

  async function consume(
    orderId: string,
    lot: string,
    sku = SKU,
    qty = '100',
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/consumptions`,
      {
        sku,
        lot_id: lot,
        location_id: dockId,
        quantity: qty,
        uom: 'KG',
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
  }

  async function postLoss(orderId: string, quantity: string, sku = SKU): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/loss`,
      { sku, quantity, uom: 'KG', reason_code: 'PROCESS_YIELD', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
  }

  async function postReturn(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/returns`,
      {
        sku: SKU,
        location_id: dockId,
        uom: 'KG',
        return_challan_number_ext: `RET-${run}-${randomUUID().slice(0, 6)}`,
        idempotency_key: randomUUID(),
        ...body,
      },
      headers,
    );
  }

  async function requestClosure(
    orderId: string,
    idempotencyKey = randomUUID(),
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/closure`,
      { idempotency_key: idempotencyKey },
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

  async function releaseOutputLot(lotNumber: string): Promise<void> {
    const taskRow = await getAdminPool().query(
      `SELECT task_id FROM qc_inspection_task WHERE lot_id = (SELECT lot_id FROM lot_master WHERE lot_number = $1)`,
      [lotNumber],
    );
    await releaseOutputTask(taskRow.rows[0]!['task_id'] as string);
  }

  async function dispatch(
    orderId: string,
    lotNumber: string,
    quantity: string,
    idempotencyKey = randomUUID(),
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/dispatches`,
      {
        lot_id: lotNumber,
        dispatched_quantity: quantity,
        uom: 'KG',
        idempotency_key: idempotencyKey,
      },
      coordinatorHeaders,
    );
  }

  /** Story 6.3/8.3 pattern: approve a plan, then drive one output lot's task to 'accepted'. */
  async function approvePlan(): Promise<void> {
    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/inspection-plans',
      {
        scope: 'standard',
        item_id: outputItemId,
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
    characteristicId = (created.body['characteristics'] as Record<string, unknown>[])[0]![
      'characteristic_id'
    ] as string;
    // Resolve and authenticate as whichever actor the server will actually require for the shared
    // 'qc.inspection_plan_approval' type on this long-lived local database (the 9.4 precedent).
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

  async function releaseOutputTask(taskId: string): Promise<void> {
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
    const disp = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/tasks/${taskId}/disposition`,
      { disposition: 'accept', justification: 'Story 9.5 dispatch fixture' },
      qcHeadHeaders,
    );
    assert.strictEqual(disp.status, 201, JSON.stringify(disp.body));
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

  async function clocksFor(orderId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT clock_id, receipt_id, sku, challan_qty::text AS challan_qty, reconciled_qty::text AS reconciled_qty,
              loss_qty::text AS loss_qty, challan_class, to_char(challan_date, 'YYYY-MM-DD') AS challan_date,
              to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date, status, deemed_supply_qty::text AS deemed_supply_qty,
              deemed_supply_recorded_at, alert_90_sent_at, alert_30_sent_at
         FROM jobwork_return_clock WHERE service_order_id = $1
        ORDER BY challan_date ASC, created_at ASC`,
      [orderId],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function notificationsFor(clockId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT payload FROM domain_events
        WHERE stream_type = 'notification' AND event_type = 'notification.created'
          AND payload->>'object_id' = $1
        ORDER BY created_at ASC`,
      [clockId],
    );
    return r.rows.map((row: Record<string, unknown>) => row['payload'] as Record<string, unknown>);
  }

  async function ledgerRows(orderId: string, category: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT sku, lot_id, quantity_delta::text AS quantity_delta, ownership, posted_by, source_event_id,
              variance_qty::text AS variance_qty, variance_flagged
         FROM custody_ledger_entry WHERE service_order_id = $1 AND movement_category = $2
        ORDER BY sku ASC, created_at ASC`,
      [orderId, category],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function orderStatus(orderId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT status, closed_at, closed_by FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function auditCount(errorCode: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = $1`,
      [errorCode],
    );
    return r.rows[0]!['n'] as number;
  }

  /**
   * Story 9.5 code review (chunks 3/4): the audit row for THIS request, keyed on the trace id the
   * response carried. `auditCount(code) > before` is satisfied by any concurrently-running test that
   * happens to trigger the same refusal, so it never actually established the BSD-5 claim.
   */
  async function auditedFor(errorCode: string, traceId: string): Promise<boolean> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = $1 AND trace_id = $2`,
      [errorCode, traceId],
    );
    return (r.rows[0]!['n'] as number) === 1;
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

    siteAId = await seedLocation('site', `SITE-A-9-5-${run}`, null);
    // A second site, so every site-scope guard in this story has something to be denied against.
    siteBId = await seedLocation('site', `SITE-B-9-5-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId);
    const customerItemId = await seedItem(SKU);
    const customer2ItemId = await seedItem(SKU2);
    const companyItemId = await seedItem(SKU_COMPANY);

    coordinatorUserId = await provisionUser(port, `jw-coord-9-5-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'custody', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coord-9-5-${run}@example.com`);

    const QC_HEAD_ROLE = 'qc_head';

    await provisionUser(port, `jw-store-9-5-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-5-${run}@example.com`);

    await provisionUser(port, `qc-inspector-9-5-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-9-5-${run}@example.com`);

    await provisionUser(port, `qc-head-9-5-${run}@example.com`, [
      { role: QC_HEAD_ROLE, module: 'qc', functionScope: 'write', locationId: '*' },
      { role: QC_HEAD_ROLE, module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-9-5-${run}@example.com`);

    await provisionUser(port, `compliance-9-5-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-9-5-${run}@example.com`);

    // Management sign-off for the physical verification: finance_controller is in SIGNOFF_ROLES.
    await provisionUser(port, `signer-9-5-${run}@example.com`, [
      { role: 'finance_controller', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    signerHeaders = await authFor(port, `signer-9-5-${run}@example.com`);

    // The Story 2.6 count and PV-completion routes are role-restricted (CREATE_ROLES /
    // COMPLETE_ROLES); inventory_controller is in both, and is the "verifying user" AC7 attributes.
    counterUserId = await provisionUser(port, `counter-9-5-${run}@example.com`, [
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    counterHeaders = await authFor(port, `counter-9-5-${run}@example.com`);

    // Story 9.5 code review (chunk 1): the classification-correction route needs jobwork/write AND a
    // role in CHALLAN_RECLASSIFICATION_ROLES. compliance_admin above is on the compliance module, so
    // it fails the module gate; the coordinator passes the module gate and fails the role gate.
    await provisionUser(port, `reclass-9-5-${run}@example.com`, [
      { role: 'compliance_officer', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'compliance_officer', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    reclassifierHeaders = await authFor(port, `reclass-9-5-${run}@example.com`);

    // Story 9.5 code review (chunks 3/4): a real site_head holder. AC5's terminal notice and AC4's
    // escalation both target this role, and it had NO holder anywhere in the repository - two
    // occurrences, both constant definitions - so the arms asserting the site-head copy would have
    // passed while the alert reached nobody. Debug Log 6 corrected `job_work_coordinator` on exactly
    // this test; the same standard applies here.
    siteHeadUserId = await provisionUser(port, `site-head-9-5-${run}@example.com`, [
      { role: 'site_head', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'site_head', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);

    // A reclassifier scoped to a DIFFERENT site, so LOCATION_ACCESS_DENIED is reachable. Every
    // fixture user was previously locationId '*', which made every site-scope check dead in the
    // suite and a cross-site leak invisible.
    await provisionUser(port, `reclass-other-9-5-${run}@example.com`, [
      {
        role: 'compliance_officer',
        module: 'jobwork',
        functionScope: 'write',
        locationId: siteBId,
      },
      { role: 'compliance_officer', module: 'jobwork', functionScope: 'read', locationId: siteBId },
    ]);
    otherSiteReclassifierHeaders = await authFor(port, `reclass-other-9-5-${run}@example.com`);

    // jobwork READ only: the 403 negative for the two write routes, which had none at all.
    await provisionUser(port, `jw-readonly-9-5-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    readOnlyHeaders = await authFor(port, `jw-readonly-9-5-${run}@example.com`);

    // No jobwork module assignment at all: the RBAC negative for the report routes.
    await provisionUser(port, `outsider-9-5-${run}@example.com`, [
      { role: 'maintenance_viewer', module: 'maintenance', functionScope: 'read', locationId: '*' },
    ]);
    outsiderHeaders = await authFor(port, `outsider-9-5-${run}@example.com`);

    const entry = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: QC_HEAD_ROLE,
        transaction_type: 'qc.inspection_plan_approval',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(entry.status, 201, JSON.stringify(entry.body));

    const kit = await seedKitBom([
      { sku: SKU, itemId: customerItemId, supplySource: 'customer' },
      { sku: SKU2, itemId: customer2ItemId, supplySource: 'customer' },
      { sku: SKU_COMPANY, itemId: companyItemId, supplySource: 'company' },
    ]);
    kitBomId = kit.bomId;
    kitRevisionId = kit.revisionId;
    outputItemId = kit.itemId;

    await approvePlan();
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // Task 0: the widened custody-ledger replay key (latent Story 9.4 defect)
  // -------------------------------------------------------------------------

  it('Task 0: a dispatch on a kit with TWO customer-supplied skus writes two dispatch rows under one event and replays cleanly', async () => {
    const orderId = await confirmedOrder();
    const a = await receive(orderId, { sku: SKU, qty: '1000' });
    const b = await receive(orderId, { sku: SKU2, qty: '1000' });
    assert.strictEqual((await consume(orderId, a.lot, SKU, '500')).status, 201);
    assert.strictEqual((await consume(orderId, b.lot, SKU2, '300')).status, 201);
    const lotNumber = await recordOutput(orderId, '50');
    await releaseOutputLot(lotNumber);

    const key = randomUUID();
    const first = await dispatch(orderId, lotNumber, '50', key);
    // Before Task 0 this was a 500 on the second insert (uq_custody_ledger_source_event on
    // source_event_id alone); the pre-fix collision is pinned as the failure it would have been.
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const rows = await ledgerRows(orderId, 'dispatch');
    assert.strictEqual(rows.length, 2, JSON.stringify(rows));
    // Keyed by sku: the ledger query orders by sku under the database collation, which sorts
    // 'SKU-CUST2-...' ahead of 'SKU-CUST-...' (punctuation is secondary), so positional order is
    // not a property worth pinning.
    const bySku = new Map(rows.map((r) => [r['sku'], r['quantity_delta']]));
    assert.strictEqual(bySku.get(SKU), '-500.000');
    assert.strictEqual(bySku.get(SKU2), '-300.000');
    assert.strictEqual(rows[0]!['source_event_id'], rows[1]!['source_event_id']);

    const replay = await dispatch(orderId, lotNumber, '50', key);
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual((await ledgerRows(orderId, 'dispatch')).length, 2);
  });

  // -------------------------------------------------------------------------
  // AC 1, 2: the clock and its reconciliation
  // -------------------------------------------------------------------------

  it('AC1: a receipt opens a clock expiring exactly 365 days from challan_date (input) or 1095 (capital_goods); the class defaults to input', async () => {
    const orderId = await confirmedOrder();
    const input = await receive(orderId, { qty: '100', challanDate: '2026-09-01' });
    const capital = await receive(orderId, {
      qty: '10',
      challanDate: '2026-09-01',
      challanClass: 'capital_goods',
    });
    const clocks = await clocksFor(orderId);
    assert.strictEqual(clocks.length, 2, JSON.stringify(clocks));
    const inputClock = clocks.find((c) => c['receipt_id'] === input.receiptId)!;
    const capitalClock = clocks.find((c) => c['receipt_id'] === capital.receiptId)!;
    assert.strictEqual(inputClock['challan_class'], 'input');
    assert.strictEqual(inputClock['expiry_date'], '2027-09-01');
    assert.strictEqual(inputClock['status'], 'open');
    assert.strictEqual(inputClock['challan_qty'], '100.000');
    assert.strictEqual(capitalClock['challan_class'], 'capital_goods');
    assert.strictEqual(capitalClock['expiry_date'], '2029-08-31');

    const receipt = await getAdminPool().query(
      `SELECT challan_class FROM jobwork_material_receipt WHERE receipt_id = $1`,
      [capital.receiptId],
    );
    assert.strictEqual(receipt.rows[0]!['challan_class'], 'capital_goods');
    const receipts = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/receipts`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(receipts.status, 200);
    const listed = receipts.body['receipts'] as Record<string, unknown>[];
    // Keyed on the receipt ids, not `some()`: a route that swapped the two classes, or echoed one
    // constant per page, passed the previous form.
    assert.strictEqual(
      listed.find((r) => r['receipt_id'] === input.receiptId)!['challan_class'],
      'input',
    );
    assert.strictEqual(
      listed.find((r) => r['receipt_id'] === capital.receiptId)!['challan_class'],
      'capital_goods',
    );
  });

  it('AC1: an unknown challan_class is refused at the receipt', async () => {
    const orderId = await confirmedOrder();
    const poRef = await seedPo(SKU);
    const token = await seedToken(poRef);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: token,
        po_ref_ext: poRef,
        line_no: 1,
        source_document: 'PO',
        sku: SKU,
        target_location_code: DOCK_CODE,
        received_qty: '10',
        stock_class: 'job_work',
        lot_id: `LOT-BAD-${run}-${randomUUID().slice(0, 6)}`,
        service_order_id: orderId,
        challan_number_ext: `CH-BAD-${run}`,
        challan_date: '2026-09-01',
        challan_qty: '10',
        challan_class: 'tooling_exempt',
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await clocksFor(orderId)).length, 0);
  });

  it('AC2: consumption moves neither counter; dispatch reconciles the apportioned input quantity FIFO - the older challan fills first', async () => {
    const orderId = await confirmedOrder();
    const older = await receive(orderId, { qty: '300', challanDate: shiftDays(TODAY, -120) });
    const newer = await receive(orderId, { qty: '5000', challanDate: shiftDays(TODAY, -60) });
    assert.strictEqual((await consume(orderId, older.lot, SKU, '300')).status, 201);
    assert.strictEqual((await consume(orderId, newer.lot, SKU, '200')).status, 201);

    let clocks = await clocksFor(orderId);
    assert.deepStrictEqual(
      clocks.map((c) => [c['reconciled_qty'], c['loss_qty'], c['status']]),
      [
        ['0.000', '0.000', 'open'],
        ['0.000', '0.000', 'open'],
      ],
      'consumption is internal state: the clock keeps running',
    );

    const lotNumber = await recordOutput(orderId, '50');
    await releaseOutputLot(lotNumber);
    // The dispatch closes out the order's total output, so the apportionment is the exact
    // remaining consumed balance (500) - the older challan (300) fills first, the newer takes 200.
    const res = await dispatch(orderId, lotNumber, '50');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    clocks = await clocksFor(orderId);
    const olderClock = clocks.find((c) => c['receipt_id'] === older.receiptId)!;
    const newerClock = clocks.find((c) => c['receipt_id'] === newer.receiptId)!;
    assert.strictEqual(olderClock['reconciled_qty'], '300.000');
    assert.strictEqual(olderClock['status'], 'reconciled');
    assert.strictEqual(newerClock['reconciled_qty'], '200.000');
    assert.strictEqual(newerClock['status'], 'partially_reconciled');
    assert.strictEqual(newerClock['loss_qty'], '0.000');
  });

  it('AC2: declared loss increments loss_qty, never reconciled_qty', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '5000' });
    assert.strictEqual((await consume(orderId, lot, SKU, '1000')).status, 201);
    const loss = await postLoss(orderId, '10');
    assert.strictEqual(loss.status, 201, JSON.stringify(loss.body));
    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['loss_qty'], '10.000');
    assert.strictEqual(clock!['reconciled_qty'], '0.000');
    assert.strictEqual(clock!['status'], 'partially_reconciled');
  });

  it('AC2: custody.return_recorded drains job_work stock, writes a return row, and reconciles the clock', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });
    const before = await getAdminPool().query(
      `SELECT on_hand::numeric(18,3)::text AS on_hand FROM stock_balance WHERE sku = $1 AND lot_id = $2 AND stock_class = 'job_work'`,
      [SKU, lot],
    );
    assert.strictEqual(before.rows[0]!['on_hand'], '100.000');

    const res = await postReturn(orderId, { lot_id: lot, quantity: '40' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['custody_balance_after'], '60.000');
    const entry = res.body['entry'] as Record<string, unknown>;
    assert.strictEqual(entry['movement_category'], 'return');
    assert.strictEqual(entry['quantity_delta'], '-40.000');

    const after = await getAdminPool().query(
      `SELECT on_hand::numeric(18,3)::text AS on_hand FROM stock_balance WHERE sku = $1 AND lot_id = $2 AND stock_class = 'job_work'`,
      [SKU, lot],
    );
    assert.strictEqual(after.rows[0]!['on_hand'], '60.000');
    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['reconciled_qty'], '40.000');
    assert.strictEqual(clock!['status'], 'partially_reconciled');
    const stored = await getAdminPool().query(
      `SELECT payload->>'return_challan_number_ext' AS challan FROM domain_events WHERE event_id = $1`,
      [res.body['event_id']],
    );
    assert.ok((stored.rows[0]!['challan'] as string).startsWith('RET-'));
  });

  it('AC2: a return refuses a blank return_challan_number_ext (400); an over-tolerance excess drains in full with the clock capped', async () => {
    const orderId = await confirmedOrder();
    // Received 105 against a challan of 100 (a flagged over-tolerance receipt): the custody balance
    // covers 105, the clock only ever covered 100.
    const { lot } = await receive(orderId, { qty: '105', challanQty: '100' });

    const blank = await postReturn(orderId, {
      lot_id: lot,
      quantity: '10',
      return_challan_number_ext: '   ',
    });
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));
    assert.strictEqual(blank.body['error_code'], 'INVALID_PARAMS');
    const missing = await postReturn(orderId, {
      lot_id: lot,
      quantity: '10',
      return_challan_number_ext: undefined,
    });
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));

    // Story 9.5 code review (chunk 2): the clock reconciliation for a return is CAPPED, not strict.
    // It used to refuse INVALID_PARAMS here, which left the 5 units of over-tolerance excess with no
    // legal drain at all - the return was barred, so the only route was booking them as `loss` with
    // an invented reason code, and CUSTODY_NOT_ZERO then blocked closure forever. The physical
    // movement is fully gated upstream; the clock absorbs its 100 and reports the rest.
    const over = await postReturn(orderId, { lot_id: lot, quantity: '105' });
    assert.strictEqual(over.status, 201, JSON.stringify(over.body));
    assert.strictEqual(over.body['custody_balance_after'], '0.000');
    assert.strictEqual((await ledgerRows(orderId, 'return')).length, 1);
    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['reconciled_qty'], '100.000', 'capped at the challan, never above');
    assert.strictEqual(clock!['status'], 'reconciled');
    const stock = await getAdminPool().query(
      `SELECT on_hand::numeric(18,3)::text AS on_hand FROM stock_balance WHERE sku = $1 AND lot_id = $2 AND stock_class = 'job_work'`,
      [SKU, lot],
    );
    assert.strictEqual(stock.rows[0]!['on_hand'], '0.000', 'the full 105 drained');

    // And the order can now actually close - the point of the change.
    const closure = await requestClosure(orderId);
    assert.strictEqual(closure.status, 200, JSON.stringify(closure.body));
  });

  it('code review: the return challan number is persisted on the ledger row and rendered on the statement', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });
    const res = await postReturn(orderId, { lot_id: lot, quantity: '40' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const stored = await getAdminPool().query(
      `SELECT reference_ext FROM custody_ledger_entry WHERE service_order_id = $1 AND movement_category = 'return'`,
      [orderId],
    );
    assert.strictEqual(stored.rows.length, 1);
    const challan = stored.rows[0]!['reference_ext'] as string;
    assert.ok(challan.startsWith('RET-'), challan);

    const statement = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/custody-statement?format=text`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(statement.status, 200, statement.text);
    assert.ok(statement.text.includes(`return challan ${challan}`), statement.text);
  });

  it('code review: a declared loss is counted ONCE against the clock, not once per counter', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '1000' });
    // 600 consumed with a 10-unit loss keeps the declaration inside the Story 9.4 process-loss norm,
    // so this exercises the clock accounting rather than the over-norm DOA path.
    assert.strictEqual((await consume(orderId, lot, SKU, '600')).status, 201);
    assert.strictEqual((await postLoss(orderId, '10')).status, 201);
    const [afterLoss] = await clocksFor(orderId);
    assert.strictEqual(afterLoss!['loss_qty'], '10.000');
    assert.strictEqual(afterLoss!['reconciled_qty'], '0.000');

    // Dispatching the processed output apportions the CONSUMPTION back onto the clock. The loss was
    // previously inside that apportionment base too, so the same 10 units moved BOTH counters and a
    // 10-unit loss burned 20 units of capacity, understating the deemed supply by exactly the loss.
    const lotNumber = await recordOutput(orderId, '50');
    await releaseOutputLot(lotNumber);
    const sent = await dispatch(orderId, lotNumber, '50');
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['loss_qty'], '10.000');
    assert.strictEqual(
      clock!['reconciled_qty'],
      '600.000',
      'consumption only, loss not re-counted',
    );
    // Scaled-integer comparison, never Number() on a NUMERIC string - the one coercion the Dev
    // Notes forbid everywhere, and this is the arm whose whole purpose is quantity correctness.
    const accounted =
      qtyToScaled(clock!['reconciled_qty'] as string) + qtyToScaled(clock!['loss_qty'] as string);
    assert.strictEqual(qtyFromScaled(accounted), '610.000', 'challan 1000 less 390 on the floor');
  });

  it('AC2: a direct POST /api/v1/events custody.return_recorded without a challan number meets the same wall', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'custody',
        stream_id: orderId,
        event_type: 'custody.return_recorded',
        payload: {
          service_order_id: orderId,
          return_id: randomUUID(),
          sku: SKU,
          lot_id: lot,
          location_id: dockId,
          quantity: '10',
          uom: 'KG',
          site_id: siteAId,
          posted_by: coordinatorUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 3, 4, 5: the sweep - breach-window alerts, escalation, deemed supply
  // -------------------------------------------------------------------------

  it('AC5: the sweep flips an expired clock to breached with deemed_supply_qty = challan - reconciled - loss and notifies compliance officer and site head', async () => {
    const orderId = await confirmedOrder();
    // Challan dated 400 days ago: expired 35 days ago.
    const { lot } = await receive(orderId, { qty: '1000', challanDate: shiftDays(TODAY, -400) });
    assert.strictEqual((await consume(orderId, lot, SKU, '500')).status, 201);
    assert.strictEqual((await postLoss(orderId, '5')).status, 201);
    const [beforeSweep] = await clocksFor(orderId);
    assert.strictEqual(beforeSweep!['status'], 'partially_reconciled');

    const result = await runJobworkClockSweepCycle();
    assert.strictEqual(result.cycleFailed, false);
    assert.strictEqual(result.skippedLocked, false);
    assert.ok(result.breached >= 1, JSON.stringify(result));

    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['status'], 'breached');
    // Loss (5) is Section 143(5) accounted waste, never deemed supply; consumption (500) is still
    // on the floor and IS deemed supply once the year has passed.
    assert.strictEqual(clock!['deemed_supply_qty'], '995.000');
    assert.ok(clock!['deemed_supply_recorded_at']);
    assert.strictEqual(clock!['alert_90_sent_at'], null, 'straight to breached, no alert stage');

    const notes = await notificationsFor(clock!['clock_id'] as string);
    assert.strictEqual(notes.length, 2, JSON.stringify(notes));
    // Story 9.5 code review (chunks 3/4): DELIVERY, not just emission. The suite read only the
    // domain-event payload, so the site-head copy would have looked correct while resolving to zero
    // recipients - site_head had no holder anywhere in the repository. Run the Story 1.11 dispatch
    // cycle and assert the notification actually landed on a user.
    // A generous limit: the cycle is global and earlier arms in this file leave a backlog.
    await runDispatchCycle(500);
    await runDispatchCycle(500);
    const delivered = await getAdminPool().query(
      `SELECT target_user_id FROM notifications
        WHERE object_id = $1 AND target_user_id = $2 AND target_role = $3`,
      [clock!['clock_id'] as string, siteHeadUserId, SITE_HEAD_ROLE],
    );
    assert.strictEqual(
      delivered.rows.length,
      1,
      'the site head actually received the breach notice',
    );
    const targets = notes.map((n) => (n['target'] as Record<string, unknown>)['role']).sort();
    assert.deepStrictEqual(targets, [COMPLIANCE_ROLE, SITE_HEAD_ROLE]);
    const siteHead = notes.find(
      (n) => (n['target'] as Record<string, unknown>)['role'] === SITE_HEAD_ROLE,
    )!;
    assert.strictEqual((siteHead['target'] as Record<string, unknown>)['location_id'], siteAId);
    assert.ok((siteHead['next_step'] as string).includes('995.000'));

    // Idempotent: a second tick does nothing to this clock.
    await runJobworkClockSweepCycle();
    assert.strictEqual((await notificationsFor(clock!['clock_id'] as string)).length, 2);
    assert.strictEqual((await clocksFor(orderId))[0]!['deemed_supply_qty'], '995.000');
  });

  it('AC3/AC4: the 90-day stage fires one alert to coordinator and compliance officer (the latter escalating to site head), stamps once, and never double-alerts', async () => {
    const orderId = await confirmedOrder();
    // Expiry in 60 days: inside the 90-day window, outside the 30-day one.
    const { receiptId } = await receive(orderId, {
      qty: '100',
      challanDate: shiftDays(TODAY, -(365 - 60)),
    });
    const first = await runJobworkClockSweepCycle();
    assert.strictEqual(first.cycleFailed, false);
    assert.ok(first.alerted >= 1, JSON.stringify(first));

    const clock = (await clocksFor(orderId)).find((c) => c['receipt_id'] === receiptId)!;
    assert.strictEqual(clock['expiry_date'], shiftDays(TODAY, 60));
    assert.ok(clock['alert_90_sent_at'], '90-day stamp set');
    assert.strictEqual(clock['alert_30_sent_at'], null, '30-day stamp untouched');
    assert.strictEqual(clock['status'], 'open');

    const notes = await notificationsFor(clock['clock_id'] as string);
    assert.strictEqual(notes.length, 2, JSON.stringify(notes));
    const coordinator = notes.find(
      (n) => (n['target'] as Record<string, unknown>)['role'] === COORDINATOR_ROLE,
    )!;
    const compliance = notes.find(
      (n) => (n['target'] as Record<string, unknown>)['role'] === COMPLIANCE_ROLE,
    )!;
    assert.ok(coordinator && compliance);
    assert.strictEqual(
      coordinator['escalation'],
      null,
      'the coordinator copy carries no escalation',
    );
    assert.deepStrictEqual(compliance['escalation'], {
      target_role: SITE_HEAD_ROLE,
      acknowledgment_window_seconds: ESCALATION_WINDOW_SECONDS,
    });
    assert.ok((compliance['next_step'] as string).includes(clock['expiry_date'] as string));
    assert.ok((compliance['status_verb'] as string).includes('90'));

    await runJobworkClockSweepCycle();
    assert.strictEqual(
      (await notificationsFor(clock['clock_id'] as string)).length,
      2,
      'a second tick does not re-alert the same tier',
    );
  });

  it('AC3: a clock first seen inside the 30-day window fires exactly ONE alert with BOTH stamps set', async () => {
    const orderId = await confirmedOrder();
    const { receiptId } = await receive(orderId, {
      qty: '100',
      challanDate: shiftDays(TODAY, -(365 - 20)),
    });
    await runJobworkClockSweepCycle();
    const clock = (await clocksFor(orderId)).find((c) => c['receipt_id'] === receiptId)!;
    assert.ok(clock['alert_90_sent_at']);
    assert.ok(clock['alert_30_sent_at']);
    const notes = await notificationsFor(clock['clock_id'] as string);
    assert.strictEqual(notes.length, 2, 'one alert = coordinator copy + compliance copy');
    assert.ok((notes[0]!['status_verb'] as string).includes('30'));
    await runJobworkClockSweepCycle();
    assert.strictEqual((await notificationsFor(clock['clock_id'] as string)).length, 2);
  });

  it('AC3: a clock with more than 90 days to run is not swept at all', async () => {
    const orderId = await confirmedOrder();
    const { receiptId } = await receive(orderId, { qty: '100', challanDate: TODAY });
    await runJobworkClockSweepCycle();
    const clock = (await clocksFor(orderId)).find((c) => c['receipt_id'] === receiptId)!;
    assert.strictEqual(clock['alert_90_sent_at'], null);
    assert.strictEqual(clock['alert_30_sent_at'], null);
    assert.strictEqual(clock['status'], 'open');
    assert.strictEqual((await notificationsFor(clock['clock_id'] as string)).length, 0);
  });

  // -------------------------------------------------------------------------
  // AC 8: the closure gate
  // -------------------------------------------------------------------------

  it('AC8: closure with a non-zero custody balance refuses CUSTODY_NOT_ZERO naming the sku, audited; the order stays in_process', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });
    assert.strictEqual((await consume(orderId, lot, SKU, '40')).status, 201);
    const before = await auditCount('CUSTODY_NOT_ZERO');

    const res = await requestClosure(orderId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CUSTODY_NOT_ZERO');
    const details = res.body['details'] as Record<string, unknown>;
    assert.deepStrictEqual(details['non_zero_skus'], [SKU]);
    assert.deepStrictEqual(details['non_zero_balances'], [
      { sku: SKU, uom: 'KG', balance: '60.000' },
    ]);
    assert.ok((await auditCount('CUSTODY_NOT_ZERO')) > before, 'refusal audited (BSD-5)');
    assert.strictEqual((await orderStatus(orderId))['status'], 'in_process');
  });

  it('AC8: closure succeeds once the balance is drained to exactly zero; replay returns 200 with no second transition', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });
    assert.strictEqual((await consume(orderId, lot, SKU, '70')).status, 201);
    assert.strictEqual((await postReturn(orderId, { lot_id: lot, quantity: '30' })).status, 201);

    const key = randomUUID();
    const res = await requestClosure(orderId, key);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const order = res.body['service_order'] as Record<string, unknown>;
    assert.strictEqual(order['status'], 'closed');
    const row = await orderStatus(orderId);
    assert.strictEqual(row['status'], 'closed');
    assert.strictEqual(row['closed_by'], coordinatorUserId);
    assert.ok(row['closed_at']);

    const replay = await requestClosure(orderId, key);
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], res.body['event_id']);
    const events = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE stream_id = $1 AND event_type = 'jobwork.order_closure_requested'`,
      [orderId],
    );
    assert.strictEqual(events.rows[0]!['n'], 1);

    // A fresh closure request on an already-closed order is an INVALID_STATE_TRANSITION, not a
    // second close.
    const again = await requestClosure(orderId);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'INVALID_STATE_TRANSITION');
  });

  it('AC8: a breached clock is NOT a closure key - the order closes on a zero balance and the ITC-04 still shows the breach', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -400) });
    assert.strictEqual((await consume(orderId, lot, SKU, '100')).status, 201);
    await runJobworkClockSweepCycle();
    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['status'], 'breached');
    assert.strictEqual(clock!['deemed_supply_qty'], '100.000');

    const res = await requestClosure(orderId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((await orderStatus(orderId))['status'], 'closed');
    assert.strictEqual((await clocksFor(orderId))[0]!['status'], 'breached');
  });

  it('AC8: a confirmed order with no receipts cannot be closed (INVALID_STATE_TRANSITION through the reserved seam)', async () => {
    const orderId = await confirmedOrder();
    const res = await requestClosure(orderId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual((await orderStatus(orderId))['status'], 'confirmed');
  });

  it('AC8: a direct POST /api/v1/events jobwork.order_closure_requested cannot bypass the gate', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });
    assert.strictEqual((await consume(orderId, lot, SKU, '10')).status, 201);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.order_closure_requested',
        payload: { service_order_id: orderId, requested_by: coordinatorUserId, site_id: siteAId },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CUSTODY_NOT_ZERO');
    assert.strictEqual((await orderStatus(orderId))['status'], 'in_process');
  });

  it('AC8: the closure route refuses server-owned fields', async () => {
    const orderId = await confirmedOrder();
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/closure`,
      { idempotency_key: randomUUID(), requested_by: coordinatorUserId },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 7: physical-verification variance reconciliation
  // -------------------------------------------------------------------------

  it('AC7: a job_work-class count variance signed off in a physical verification posts a count_adjustment ledger row attributed to the counter, visible on the next custody statement', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '500' });
    assert.strictEqual((await consume(orderId, lot, SKU, '100')).status, 201);
    // Book at the dock is now 400 of this lot in the job_work class.

    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/cycle-counts',
      {
        location_id: dockId,
        sku_scope: [SKU],
        count_type: 'cycle',
        business_date: TODAY,
        business_stream: 'job_work',
        stock_class: 'job_work',
        // Within tolerance: the variance is RECORDED on the line without routing to a DOA
        // adjustment approval (which is the Story 2.6 stock-adjustment path, not this story's).
        tolerance_percent: 50,
      },
      counterHeaders,
    );
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const countId = created.body['cycle_count_id'] as string;
    const submitted = await makeRequest(
      port,
      'POST',
      `/api/v1/cycle-counts/${countId}/submit`,
      {
        // unit_cost: the Story 2.6 count seam requires it for non-owned classes (variance banding
        // of customer-owned material has no valuation row to fall back on).
        lines: [
          { sku: SKU, lot_id: lot, stock_class: 'job_work', counted_quantity: 390, unit_cost: 1 },
        ],
      },
      counterHeaders,
    );
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    const line = (submitted.body['lines'] as Record<string, unknown>[])[0]!;
    assert.strictEqual(Number(line['variance_quantity']), -10);

    const pvId = randomUUID();
    const completed = await makeRequest(
      port,
      'POST',
      '/api/v1/physical-verifications',
      {
        physical_verification_id: pvId,
        location_id: dockId,
        count_refs: [countId],
        coverage_percentage: 100,
        business_date: TODAY,
        business_stream: 'job_work',
      },
      counterHeaders,
    );
    assert.strictEqual(completed.status, 201, JSON.stringify(completed.body));
    assert.strictEqual(
      (await ledgerRows(orderId, 'count_adjustment')).length,
      0,
      'not before sign-off',
    );

    const signed = await makeRequest(
      port,
      'POST',
      `/api/v1/physical-verifications/${pvId}/sign-off`,
      { business_date: TODAY },
      signerHeaders,
    );
    assert.strictEqual(signed.status, 200, JSON.stringify(signed.body));

    const rows = await ledgerRows(orderId, 'count_adjustment');
    assert.strictEqual(rows.length, 1, JSON.stringify(rows));
    assert.strictEqual(rows[0]!['quantity_delta'], '-10.000');
    assert.strictEqual(rows[0]!['lot_id'], lot);
    assert.strictEqual(rows[0]!['variance_flagged'], true);
    assert.strictEqual(rows[0]!['posted_by'], counterUserId, 'attributed to the counter');
    const signOffEvent = await getAdminPool().query(
      `SELECT event_id FROM domain_events WHERE event_type = 'physical_verification.signed_off' AND payload->>'physical_verification_id' = $1`,
      [pvId],
    );
    assert.strictEqual(rows[0]!['source_event_id'], signOffEvent.rows[0]!['event_id']);

    // The clock is NOT reconciled by a verification discrepancy.
    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['reconciled_qty'], '0.000');
    assert.strictEqual(clock!['loss_qty'], '0.000');

    const statement = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/custody-statement`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(statement.status, 200);
    const lines = (statement.body['statement'] as Record<string, unknown>)['lines'] as Record<
      string,
      unknown
    >[];
    const adj = lines.find((l) => l['movement_category'] === 'count_adjustment')!;
    assert.ok(adj, 'count_adjustment appears on the next statement');
    assert.strictEqual(adj['running_balance'], '390.000');
    const text = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/custody-statement?format=text`,
      undefined,
      coordinatorHeaders,
    );
    assert.ok(text.text.includes('physical verification variance -10.000'));
    assert.ok(text.text.includes(`verified_by ${counterUserId}`));
  });

  // -------------------------------------------------------------------------
  // AC 6: ITC-04 and aging reports
  // -------------------------------------------------------------------------

  it('AC6: the ITC-04 report returns the period challans with their clock columns and the deemed-supply records; RBAC enforced', async () => {
    const orderId = await confirmedOrder();
    const live = await receive(orderId, {
      qty: '200',
      challanQty: '200',
      challanDate: shiftDays(TODAY, -100),
    });
    const breached = await receive(orderId, { qty: '50', challanDate: shiftDays(TODAY, -370) });
    assert.strictEqual((await consume(orderId, live.lot, SKU, '20')).status, 201);
    assert.strictEqual((await postLoss(orderId, '1')).status, 201);
    await runJobworkClockSweepCycle();

    const from = shiftDays(TODAY, -400);
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/itc-04?from=${from}&to=${TODAY}&site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = (res.body['rows'] as Record<string, unknown>[]).filter(
      (r) => r['service_order_id'] === orderId,
    );
    assert.strictEqual(rows.length, 2, JSON.stringify(rows));
    const liveRow = rows.find((r) => r['receipt_id'] === live.receiptId)!;
    const breachedRow = rows.find((r) => r['receipt_id'] === breached.receiptId)!;
    assert.strictEqual(liveRow['challan_number_ext'], live.challan);
    assert.strictEqual(liveRow['challan_qty'], '200.000');
    assert.strictEqual(liveRow['status'], 'open');
    // Inputs clock: one calendar year from the (relative) challan date.
    const liveExpiry = new Date(`${shiftDays(TODAY, -100)}T00:00:00Z`);
    liveExpiry.setUTCFullYear(liveExpiry.getUTCFullYear() + 1);
    assert.strictEqual(liveRow['expiry_date'], liveExpiry.toISOString().slice(0, 10));
    assert.strictEqual(breachedRow['status'], 'breached');
    // FIFO: the loss landed on the OLDER (breached-to-be) challan before the sweep froze it.
    assert.strictEqual(breachedRow['loss_qty'], '1.000');
    assert.strictEqual(breachedRow['deemed_supply_qty'], '49.000');
    const deemed = (res.body['deemed_supply_records'] as Record<string, unknown>[]).filter(
      (r) => r['service_order_id'] === orderId,
    );
    assert.strictEqual(deemed.length, 1);
    assert.strictEqual(deemed[0]!['clock_id'], breachedRow['clock_id']);
    assert.strictEqual(res.body['report'], 'ITC-04');
    assert.deepStrictEqual(res.body['period'], { from, to: TODAY });

    const missing = await makeRequest(
      port,
      'GET',
      '/api/v1/jobwork/reports/itc-04',
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(missing.body['error_code'], 'INVALID_PARAMS');

    const unauth = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/itc-04?from=${from}&to=${TODAY}`,
    );
    assert.strictEqual(unauth.status, 401);
    const forbidden = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/itc-04?from=${from}&to=${TODAY}`,
      undefined,
      outsiderHeaders,
    );
    assert.strictEqual(forbidden.status, 403, JSON.stringify(forbidden.body));
    const reader = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/itc-04?from=${from}&to=${TODAY}`,
      undefined,
      storeHeaders,
    );
    assert.strictEqual(reader.status, 200, 'a jobwork READ role suffices');
  });

  it('AC6: the aging report buckets open exposure by days to expiry and past-due breaches; RBAC enforced', async () => {
    const orderId = await confirmedOrder();
    const soon = await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -(365 - 10)) });
    const mid = await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -(365 - 60)) });
    const far = await receive(orderId, { qty: '100', challanDate: TODAY });
    const past = await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -366) });
    await runJobworkClockSweepCycle();

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/aging?site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const rows = (res.body['rows'] as Record<string, unknown>[]).filter(
      (r) => r['service_order_id'] === orderId,
    );
    const bucketOf = (receiptId: string): unknown =>
      rows.find((r) => r['receipt_id'] === receiptId)!['bucket'];
    assert.strictEqual(bucketOf(soon.receiptId), 'due_within_30');
    assert.strictEqual(bucketOf(mid.receiptId), 'due_within_90');
    assert.strictEqual(bucketOf(far.receiptId), 'beyond_90');
    assert.strictEqual(bucketOf(past.receiptId), 'breached');
    assert.strictEqual(rows.find((r) => r['receipt_id'] === soon.receiptId)!['days_to_expiry'], 10);
    assert.strictEqual(rows.find((r) => r['receipt_id'] === past.receiptId)!['days_to_expiry'], -1);
    const buckets = res.body['buckets'] as Record<
      string,
      { count: number; outstanding_qty: string }
    >;
    assert.ok(buckets['breached']!.count >= 1);
    assert.ok(buckets['due_within_30']!.count >= 1);
    // The bucket totals are global across every order in the database, so the bucket figure itself
    // is not assertable here. What IS assertable - and what the typeof check never touched - is that
    // the per-row outstanding arithmetic is exact for this order's own rows.
    assert.strictEqual(
      rows.find((r) => r['receipt_id'] === far.receiptId)!['outstanding_qty'],
      '100.000',
    );
    assert.strictEqual(
      qtyFromScaled(rows.reduce((acc, r) => acc + qtyToScaled(r['outstanding_qty'] as string), 0n)),
      '400.000',
      'four untouched challans of 100 each',
    );

    const forbidden = await makeRequest(
      port,
      'GET',
      '/api/v1/jobwork/reports/aging',
      undefined,
      outsiderHeaders,
    );
    assert.strictEqual(forbidden.status, 403, JSON.stringify(forbidden.body));
    // A fully reconciled clock drops off the aging report.
    const doneOrder = await confirmedOrder();
    const { lot } = await receive(doneOrder, { qty: '10' });
    assert.strictEqual((await postReturn(doneOrder, { lot_id: lot, quantity: '10' })).status, 201);
    const after = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/aging?site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    assert.ok(
      !(after.body['rows'] as Record<string, unknown>[]).some(
        (r) => r['service_order_id'] === doneOrder,
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Regression
  // -------------------------------------------------------------------------

  it('code review: a compliance officer corrects a misclassified challan and the clock moves to the three-year expiry; the coordinator cannot', async () => {
    const orderId = await confirmedOrder();
    const receipt = await receive(orderId, { qty: '100', challanDate: '2026-09-01' });
    const [opened] = await clocksFor(orderId);
    assert.strictEqual(opened!['challan_class'], 'input');
    assert.strictEqual(opened!['expiry_date'], '2027-09-01');
    const clockId = opened!['clock_id'] as string;
    const path = `/api/v1/jobwork/clocks/${clockId}/classification`;

    // The coordinator is the party the breach alerts are addressed to: it must not be able to push
    // its own deadline out by two years, even though it holds jobwork/write.
    const denied = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      coordinatorHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual((await clocksFor(orderId))[0]!['expiry_date'], '2027-09-01');

    const bad = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'tooling' },
      reclassifierHeaders,
    );
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.strictEqual(bad.body['error_code'], 'INVALID_PARAMS');

    const ok = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      reclassifierHeaders,
    );
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const corrected = ok.body['return_clock'] as Record<string, unknown>;
    assert.strictEqual(corrected['challan_class'], 'capital_goods');
    // Recomputed from the STORED challan_date in SQL, not from a caller-supplied date.
    assert.strictEqual(corrected['expiry_date'], '2029-08-31');
    assert.strictEqual(corrected['receipt_id'], receipt.receiptId);
    const [stored] = await clocksFor(orderId);
    assert.strictEqual(stored!['expiry_date'], '2029-08-31');

    // Re-applying the class it already carries is a no-op that still answers 200 (retry-safe).
    const repeat = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      reclassifierHeaders,
    );
    assert.strictEqual(repeat.status, 200, JSON.stringify(repeat.body));
    assert.strictEqual((await clocksFor(orderId))[0]!['expiry_date'], '2029-08-31');
  });

  it('code review: a challan already recorded as a deemed supply can no longer be reclassified', async () => {
    const orderId = await confirmedOrder();
    await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -400) });
    await runJobworkClockSweepCycle();
    const [breached] = await clocksFor(orderId);
    assert.strictEqual(breached!['status'], 'breached');
    assert.ok(breached!['deemed_supply_recorded_at']);

    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/jobwork/clocks/${breached!['clock_id'] as string}/classification`,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      reclassifierHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    const [after] = await clocksFor(orderId);
    assert.strictEqual(after!['challan_class'], 'input');
    assert.strictEqual(after!['deemed_supply_qty'], '100.000');
  });

  it('code review: the aging report drops a breached clock once it is fully reconciled, while ITC-04 keeps the deemed-supply record', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -400) });
    await runJobworkClockSweepCycle();
    const [breached] = await clocksFor(orderId);
    assert.strictEqual(breached!['status'], 'breached');

    const aging = async (): Promise<Record<string, unknown>[]> => {
      const r = await makeRequest(
        port,
        'GET',
        `/api/v1/jobwork/reports/aging?site_id=${siteAId}`,
        undefined,
        coordinatorHeaders,
      );
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      return (r.body['rows'] as Record<string, unknown>[]).filter(
        (row) => row['service_order_id'] === orderId,
      );
    };
    assert.strictEqual((await aging()).length, 1, 'breached exposure is on the aging report');

    // A late return still drains a breached clock (the closure gate must stay reachable). The clock
    // stays 'breached' so its deemed supply survives - which is exactly why the aging report keys
    // off the counters and not the status bucket.
    const ret = await postReturn(orderId, { lot_id: lot, quantity: '100' });
    assert.strictEqual(ret.status, 201, JSON.stringify(ret.body));
    const [drained] = await clocksFor(orderId);
    assert.strictEqual(drained!['status'], 'breached');
    assert.strictEqual(drained!['reconciled_qty'], '100.000');
    assert.strictEqual(
      drained!['deemed_supply_qty'],
      '100.000',
      'the recorded deemed supply is frozen',
    );

    assert.deepStrictEqual(await aging(), [], 'no outstanding exposure left to age');

    const itc = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/itc-04?from=${shiftDays(TODAY, -400)}&to=${TODAY}&site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(itc.status, 200, JSON.stringify(itc.body));
    const deemed = (itc.body['deemed_supply_records'] as Record<string, unknown>[]).filter(
      (row) => row['service_order_id'] === orderId,
    );
    assert.strictEqual(deemed.length, 1, 'the deemed supply is still reported');
    assert.strictEqual(deemed[0]!['deemed_supply_qty'], '100.000');
  });

  it('code review: the reclassification route is gated on role, site, and the retro-expiry refusal', async () => {
    const orderId = await confirmedOrder();
    await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -400) });
    const [old] = await clocksFor(orderId);
    const path = `/api/v1/jobwork/clocks/${old!['clock_id'] as string}/classification`;

    // Site scope is drawn from the RECLASSIFYING assignments only. This user holds
    // compliance_officer at site B and nothing at site A, so the site-A clock is denied.
    const offSite = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      otherSiteReclassifierHeaders,
    );
    assert.strictEqual(offSite.status, 403, JSON.stringify(offSite.body));
    assert.strictEqual(offSite.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // AD-16: a state-changing route requires an idempotency key.
    const noKey = await makeRequest(
      port,
      'PATCH',
      path,
      { challan_class: 'capital_goods' },
      reclassifierHeaders,
    );
    assert.strictEqual(noKey.status, 400, JSON.stringify(noKey.body));

    // Server-owned fields are refused rather than silently dropped with a 200.
    const stamped = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods', alert_30_sent_at: null },
      reclassifierHeaders,
    );
    assert.strictEqual(stamped.status, 400, JSON.stringify(stamped.body));

    // An unknown clock is a 404, not a silent success.
    const missing = await makeRequest(
      port,
      'PATCH',
      `/api/v1/jobwork/clocks/${randomUUID()}/classification`,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      reclassifierHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));

    // The retro-expiry guard: this challan is 400 days old, so moving it to `input` would set an
    // expiry that has already passed and the next sweep tick would freeze a deemed supply with no
    // warning at correction time. Declaring a breach is the sweep's job, not a correction's.
    const widened = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      reclassifierHeaders,
    );
    assert.strictEqual(widened.status, 200, JSON.stringify(widened.body));
    const retro = await makeRequest(
      port,
      'PATCH',
      path,
      { idempotency_key: randomUUID(), challan_class: 'input' },
      reclassifierHeaders,
    );
    assert.strictEqual(retro.status, 409, JSON.stringify(retro.body));
    assert.strictEqual(retro.body['error_code'], 'INVALID_STATE_TRANSITION');
    const details = retro.body['details'] as Record<string, unknown>;
    assert.ok((details['would_expire_on'] as string) < TODAY, JSON.stringify(details));
    // Unchanged by the refusal.
    assert.strictEqual((await clocksFor(orderId))[0]!['challan_class'], 'capital_goods');

    // BSD-5: the refused statutory correction left an audit row.
    assert.ok(await auditedFor('LOCATION_ACCESS_DENIED', offSite.body['trace_id'] as string));
  });

  it('code review: reclassifying to a later expiry clears both alert stamps so the clock re-arms', async () => {
    const orderId = await confirmedOrder();
    // 20 days to run: inside the 30-day window, so one sweep stamps BOTH stages.
    await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -(365 - 20)) });
    await runJobworkClockSweepCycle();
    const [alerted] = await clocksFor(orderId);
    assert.ok(alerted!['alert_30_sent_at'], 'the 30-day stage stamped');
    assert.ok(alerted!['alert_90_sent_at'], 'and the 90-day stage with it');

    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/jobwork/clocks/${alerted!['clock_id'] as string}/classification`,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      reclassifierHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    // Both stamps cleared: the expiry moved out by two years, and dueClockSweepStage suppresses any
    // stage whose stamp is set, so leaving them would have silenced this clock for the whole
    // extended window and surfaced it only as `breached`.
    const [corrected] = await clocksFor(orderId);
    assert.strictEqual(corrected!['alert_30_sent_at'], null);
    assert.strictEqual(corrected!['alert_90_sent_at'], null);
    assert.strictEqual(corrected!['status'], 'open');

    // And it is genuinely no longer due: the next tick leaves it alone.
    const notesBefore = (await notificationsFor(corrected!['clock_id'] as string)).length;
    await runJobworkClockSweepCycle();
    assert.strictEqual(
      (await notificationsFor(corrected!['clock_id'] as string)).length,
      notesBefore,
      'a clock three years out is not re-alerted',
    );
  });

  it("code review: the closure applier refuses a site_id that is not the order's, under its own lock", async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });
    assert.strictEqual((await consume(orderId, lot, SKU, '100')).status, 201);

    // A direct event carrying the WRONG site. The route's assertSiteWriteAccess is not in play here,
    // which is the point: the gate has to hold at the seam or a direct POST walks past it.
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.order_closure_requested',
        payload: { service_order_id: orderId, requested_by: coordinatorUserId, site_id: siteBId },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED');
    assert.strictEqual((await orderStatus(orderId))['status'], 'in_process');

    // And requested_by must be the authenticated actor, not a name the caller picked.
    const forged = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.order_closure_requested',
        payload: { service_order_id: orderId, requested_by: randomUUID(), site_id: siteAId },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(forged.status, 403, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual((await orderStatus(orderId))['status'], 'in_process');
  });

  it('code review: the return and closure routes enforce RBAC and site scope', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '100' });

    // jobwork READ only: may not post a return, may not request closure. Neither route had any
    // 403 arm at all - both helpers carried an unused `headers` parameter, the fingerprint of a
    // planned arm that was dropped.
    const readReturn = await postReturn(orderId, { lot_id: lot, quantity: '10' }, readOnlyHeaders);
    assert.strictEqual(readReturn.status, 403, JSON.stringify(readReturn.body));
    const readClosure = await requestClosure(orderId, undefined, readOnlyHeaders);
    assert.strictEqual(readClosure.status, 403, JSON.stringify(readClosure.body));

    // Nothing was written by either refusal.
    assert.strictEqual((await ledgerRows(orderId, 'return')).length, 0);
    assert.strictEqual((await orderStatus(orderId))['status'], 'in_process');
  });

  it('code review: the return path refuses a foreign lot, an over-balance quantity and a uom mismatch, and replays cleanly', async () => {
    const orderA = await confirmedOrder();
    const orderB = await confirmedOrder();
    const { lot: lotA } = await receive(orderA, { qty: '100' });
    await receive(orderB, { qty: '100' });

    // A lot received under another order is not returnable here.
    const foreign = await postReturn(orderB, { lot_id: lotA, quantity: '10' });
    assert.strictEqual(foreign.status, 409, JSON.stringify(foreign.body));
    assert.strictEqual(foreign.body['error_code'], 'CROSS_ISSUE_BLOCKED');

    // More than the custody balance is refused. This is the guard the chunk-2 capped-clock change
    // leans on - it relaxed the clock-side check on the grounds that the physical movement is
    // gated upstream, and that upstream gate had no arm of its own.
    assert.strictEqual((await consume(orderA, lotA, SKU, '60')).status, 201);
    const over = await postReturn(orderA, { lot_id: lotA, quantity: '50' });
    assert.strictEqual(over.status, 409, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'INSUFFICIENT_STOCK');

    // A uom the ledger does not carry this sku in.
    const wrongUom = await postReturn(orderA, { lot_id: lotA, quantity: '10', uom: 'EA' });
    assert.strictEqual(wrongUom.status, 400, JSON.stringify(wrongUom.body));
    assert.strictEqual(wrongUom.body['error_code'], 'INVALID_PARAMS');

    // Replay: the same idempotency key returns the same event and moves the clock exactly once.
    const key = randomUUID();
    const first = await postReturn(orderA, { lot_id: lotA, quantity: '40', idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await postReturn(orderA, { lot_id: lotA, quantity: '40', idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual((await ledgerRows(orderA, 'return')).length, 1);
    assert.strictEqual((await clocksFor(orderA))[0]!['reconciled_qty'], '40.000');
  });

  it('code review: the sweep yields to a concurrent tick rather than double-alerting', async () => {
    const orderId = await confirmedOrder();
    await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -400) });

    // Hold the sweep's advisory lock on another connection, exactly as a second instance would.
    const blocker = await getAdminPool().connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [9505]);
      const skipped = await runJobworkClockSweepCycle();
      assert.strictEqual(skipped.skippedLocked, true, JSON.stringify(skipped));
      assert.strictEqual(skipped.breached, 0);
      assert.strictEqual(skipped.cycleFailed, false);
      // Nothing was touched while the lock was held.
      assert.strictEqual((await clocksFor(orderId))[0]!['status'], 'open');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    // Lock released: the same clock is swept normally on the next tick.
    const after = await runJobworkClockSweepCycle();
    assert.strictEqual(after.skippedLocked, false);
    assert.strictEqual((await clocksFor(orderId))[0]!['status'], 'breached');
  });

  it('code review: ITC-04 reports a deemed supply in the period it AROSE, not the period of its challan', async () => {
    const orderId = await confirmedOrder();
    await receive(orderId, { qty: '100', challanDate: shiftDays(TODAY, -400) });
    await runJobworkClockSweepCycle();
    const [clock] = await clocksFor(orderId);
    assert.strictEqual(clock!['status'], 'breached');

    // A period that EXCLUDES the challan date entirely. The deemed supply was recorded today, so it
    // must still be reported here - the whole reason the deemed-supply leg exists. With the old
    // single-union query the arm that covered this used a period wide enough to match on
    // challan_date alone, so deleting the deemed-supply clause passed.
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/itc-04?from=${shiftDays(TODAY, -30)}&to=${TODAY}&site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const deemed = (res.body['deemed_supply_records'] as Record<string, unknown>[]).filter(
      (r) => r['service_order_id'] === orderId,
    );
    assert.strictEqual(deemed.length, 1, 'reported in the period it arose');
    // And the challan itself is NOT in the period rows, because it was issued 400 days ago.
    const rows = (res.body['rows'] as Record<string, unknown>[]).filter(
      (r) => r['service_order_id'] === orderId,
    );
    assert.strictEqual(rows.length, 0, 'the challan leg is scoped to challan_date alone');
  });

  it('regression: the 9.1-9.4 order lifecycle, receipt, consumption, loss and dispatch flows are unaffected', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, { qty: '1000' });
    assert.strictEqual((await consume(orderId, lot, SKU, '500')).status, 201);
    assert.strictEqual((await postLoss(orderId, '10')).status, 201);
    const lotNumber = await recordOutput(orderId, '50');
    await releaseOutputLot(lotNumber);
    const res = await dispatch(orderId, lotNumber, '20');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((await orderStatus(orderId))['status'], 'in_process');
  });
});

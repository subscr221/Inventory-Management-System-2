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
import { dispatchGateBlockedLots } from '../../src/compliance/dispatch.js';

/**
 * Story 9.8 Offcut Acquisition CFO Approval (extends Story 9.7 AC 7; FR-JW-09/10, FR-JW-12). Real
 * PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run serially;
 * every identifier is run-scoped. Fixture writes use the admin pool (app_user has no DELETE). The
 * harness scaffolding is a deliberate local re-implementation of the story-9-7 closures (never
 * import cross-story).
 *
 * WHAT THIS STORY CHANGES. Story 9.7 captured the DOA second signature as a STRING on the poster's
 * own request: `approved_by` merely had to equal resolveApprover's output. This suite is the proof
 * that the signature is now an authenticated action - an above-band acquisition is PROPOSED and
 * executes nothing until the resolved `cfo` approves it through their own session, and there is no
 * longer any request field through which anybody can name an approver.
 *
 * TWO SEPARATE REAL PEOPLE hold the segregated pair: `finance_controller` prices and proposes,
 * `cfo` signs, and neither is the acting coordinator. `npm run verify:roles` enforces the same
 * separation against a live environment.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const RUN = run.toUpperCase();

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  traceId: string | null;
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
          resolvePromise({
            status: res.statusCode ?? 0,
            body: parsed,
            text: raw,
            // Error bodies carry the trace id; the audit row is keyed on it (the 9.5/9.6 idiom).
            traceId: (parsed['trace_id'] as string | undefined) ?? null,
          });
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

// Role names asserted as LITERALS, never against exported constants (the 8.4 lesson).
const COORDINATOR_ROLE = 'jobwork_coordinator';
const FINANCE_ROLE = 'finance_controller';
const CFO_ROLE = 'cfo';
const SITE_HEAD_ROLE = 'site_head';
const OFFCUT_ACQUISITION_TYPE = 'jobwork.offcut_acquisition';
/** The offcut contract's INDICATIVE rate, carried on the order. */
const INDICATIVE_RATE = '18.5000';
/** Above this acquisition value the CFO second signature is required (AC 7). */
const DOA_BAND_MIN = 1000;

describe('Story 9.8 Offcut Acquisition CFO Approval', () => {
  let server: Server;
  let port: number;

  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let financeUserId: string;
  let financeHeaders: Record<string, string>;
  let cfoUserId: string;
  let cfoHeaders: Record<string, string>;
  let ackUserId: string;
  let ackHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;

  let siteAId: string;
  let siteBId: string;
  let dockId: string;
  let kitBomId: string;
  let kitRevisionId: string;
  let outputItemId: string;
  let customerItemId: string;
  const characteristicIds: Record<string, string> = {};

  const TODAY = toIstCalendarDate(new Date());
  const CUSTOMER = `CUST-9-8-${RUN}`;
  const SKU = `SKU-CUST-9-8-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-9-8-${RUN}`;
  const OUTPUT_SKU = `SKU-OUT-9-8-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-8-${run}`;
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
    const poRef = `PO-JW-9-8-${run}-${poCounter}`;
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
       VALUES ($1, $2, $3, $4, 'site-A-9-8', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-8', 'MANUAL', $6, $7, $8)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, coordinatorUserId, TODAY, randomUUID()],
    );
    return token;
  }

  async function createDraftOrder(): Promise<string> {
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
        has_contractual_offcut: true,
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
    assert.strictEqual(create.status, 201, `create order failed: ${JSON.stringify(create.body)}`);
    return (create.body['service_order'] as Record<string, unknown>)['service_order_id'] as string;
  }

  /** A confirmed contractual order carrying the offcut contract's INDICATIVE rate. */
  async function confirmedOrder(opts: { indicativeRate?: string | null } = {}): Promise<string> {
    const orderId = await createDraftOrder();
    const body: Record<string, unknown> = {
      idempotency_key: randomUUID(),
      offcut_election: 'return',
    };
    if (opts.indicativeRate !== null) {
      body['offcut_rate'] = opts.indicativeRate ?? INDICATIVE_RATE;
      body['offcut_currency'] = 'INR';
    }
    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/confirm`,
      body,
      coordinatorHeaders,
    );
    assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
    return orderId;
  }

  async function receive(
    serviceOrderId: string,
    qty: string,
  ): Promise<{ lot: string; challan: string }> {
    const poRef = await seedPo(SKU);
    const token = await seedToken(poRef);
    const lot = `LOT-JW-9-8-${run}-${randomUUID().slice(0, 6)}`;
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
        sku: SKU,
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

  async function capture(orderId: string, lot: string, quantity: string): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcuts`,
      {
        sku: SKU,
        lot_id: lot,
        location_id: dockId,
        quantity,
        uom: 'KG',
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 201, `offcut capture failed: ${JSON.stringify(res.body)}`);
    return (res.body['offcut_id'] as string) ?? '';
  }

  /**
   * The DOA registry is global and outlives this run, so the holder resolveApprover actually picks
   * for a transaction type may be another suite's user. Resolve it the way the seam does rather
   * than assuming this suite's fixture wins (the 9.6 lesson).
   *
   * Chunk D code review (2026-09-06): match the BAND that governs the values this suite uses and
   * assert the role, never "the oldest active entry" - stale overlapping entries (earlier runs,
   * other bands) could otherwise resolve the signature to the wrong authority.
   */
  async function resolvedApprover(
    transactionType: string,
    opts: { value?: number | null; role?: string } = {},
  ): Promise<{ userId: string; headers: Record<string, string> }> {
    const value = opts.value ?? null;
    const entry = await getAdminPool().query(
      `SELECT role FROM doa_registry_entries
        WHERE transaction_type = $1 AND active = true
          AND ($2::numeric IS NULL OR (value_min IS NULL OR value_min <= $2::numeric))
          AND ($2::numeric IS NULL OR (value_max IS NULL OR value_max >= $2::numeric))
        ORDER BY value_min DESC NULLS LAST, created_at ASC, entry_id ASC LIMIT 1`,
      [transactionType, value],
    );
    const role = entry.rows[0]?.['role'] as string | undefined;
    assert.ok(role, `no active DOA entry for ${transactionType}`);
    if (opts.role !== undefined) {
      assert.strictEqual(
        role,
        opts.role,
        `DOA ${transactionType} resolved to ${role}, expected ${opts.role}`,
      );
    }
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

  async function postEvent(body: unknown, headers = financeHeaders): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/events', body, headers);
  }

  // ---- QC / dispatch / billing scaffolding (needed for the credit-note citation) ----

  async function consume(orderId: string, lot: string, qty: string): Promise<HttpResult> {
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

  async function recordOutput(orderId: string, quantity: string): Promise<string> {
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
      { disposition: 'accept', justification: 'Story 9.8 dispatch fixture' },
      qcHeadHeaders,
    );
    assert.strictEqual(disp.status, 201, JSON.stringify(disp.body));
  }

  /**
   * An order whose service invoice has been generated AND acknowledged by ERP, with a retained
   * offcut holding row still open. That acknowledged reference is what an acquisition credit note
   * cites (Task 4.11).
   */
  async function invoicedOrderWithHolding(
    opts: { offcutQty?: string } = {},
  ): Promise<{ orderId: string; holdingId: string; lot: string; invoiceRef: string }> {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, '1000');
    assert.strictEqual((await consume(orderId, lot, '500')).status, 201);
    const outputLot = await recordOutput(orderId, '50');
    await releaseLot(outputLot, 'output');
    const dispatched = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/dispatches`,
      { lot_id: outputLot, dispatched_quantity: '20', uom: 'KG', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(dispatched.status, 201, JSON.stringify(dispatched.body));
    const feed = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/billing-feed`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(feed.status, 201, JSON.stringify(feed.body));
    const feedId = feed.body['feed_id'] as string;
    const invoiceRef = `ERP-INV-${run}-${randomUUID().slice(0, 6)}`;
    const acked = await makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/billing-feeds/${feedId}/acknowledgment`,
      { idempotency_key: randomUUID(), acknowledged_ref_ext: invoiceRef },
      ackHeaders,
    );
    assert.strictEqual(acked.status, 200, JSON.stringify(acked.body));
    const holdingId = await capture(orderId, lot, opts.offcutQty ?? '10');
    return { orderId, holdingId, lot, invoiceRef };
  }

  // ---- assertions ----

  async function holdingRow(holdingId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT holding_id, service_order_id, sku, lot_id, quantity::text AS quantity, uom, status,
              disposition, disposed_at, disposed_by, disposal_rate::text AS disposal_rate,
              indicative_rate::text AS indicative_rate, disposal_currency,
              disposal_value::text AS disposal_value, approved_by, doa_entry_id,
              return_challan_number_ext, clock_reconciled_qty::text AS clock_reconciled_qty,
              owned_lot_id, site_id
         FROM job_work_offcut_holding WHERE holding_id = $1`,
      [holdingId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function creditNotes(orderId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT credit_note_id, holding_id, document_kind, supersedes_credit_note_id,
              cited_invoice_ref_ext, rate::text AS rate, indicative_rate::text AS indicative_rate,
              currency, value::text AS value, delta_value::text AS delta_value, status,
              acknowledged_by, acknowledged_ref_ext, valued_by
         FROM job_work_credit_note WHERE service_order_id = $1
        ORDER BY created_at ASC, credit_note_id ASC`,
      [orderId],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function stockOnHand(lot: string, stockClass: string): Promise<string | null> {
    const r = await getAdminPool().query(
      `SELECT on_hand::numeric(18,3)::text AS on_hand FROM stock_balance
        WHERE sku = $1 AND lot_id = $2 AND stock_class = $3 AND location_id = $4`,
      [SKU, lot, stockClass, dockId],
    );
    return (r.rows[0]?.['on_hand'] as string | undefined) ?? null;
  }

  async function clockRow(orderId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT clock_id, challan_qty::text AS challan_qty, reconciled_qty::text AS reconciled_qty,
              loss_qty::text AS loss_qty, deemed_supply_qty::text AS deemed_supply_qty, status,
              to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
         FROM jobwork_return_clock WHERE service_order_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [orderId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function auditedFor(errorCode: string, traceId: string): Promise<boolean> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = $1 AND trace_id = $2`,
      [errorCode, traceId],
    );
    return (r.rows[0]!['n'] as number) >= 1;
  }

  /**
   * AC 3: the acquired lot carries the Story 8.5 GOVERNED hold - an open qc_quality_hold row plus the
   * lot_master enforcement flag that every allocation, pick and dispatch gate reads.
   */
  async function qcHeld(lotNumber: string): Promise<{ held: boolean; openHolds: number }> {
    const lot = await getAdminPool().query(
      `SELECT lot_id, quality_hold_status FROM lot_master WHERE lot_number = $1`,
      [lotNumber],
    );
    const lotId = lot.rows[0]?.['lot_id'] as string | undefined;
    assert.ok(lotId, `no lot_master row for ${lotNumber}`);
    assert.strictEqual(lot.rows[0]!['quality_hold_status'], 'held');
    const holds = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM qc_quality_hold WHERE lot_id = $1 AND status = 'open'`,
      [lotId],
    );
    const client = await getAdminPool().connect();
    try {
      const blocked = await dispatchGateBlockedLots([lotId!], client);
      return { held: blocked.heldLotIds.length > 0, openHolds: holds.rows[0]!['n'] as number };
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
      '../../read/projections/job_work_offcut_holding.sql',
      '../../read/projections/job_work_credit_note.sql',
      '../../read/projections/job_work_offcut_acquisition_proposal.sql',
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

    siteAId = await seedLocation('site', `SITE-A-9-8-${run}`, null);
    siteBId = await seedLocation('site', `SITE-B-9-8-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId);
    customerItemId = await seedItem(SKU);
    const companyItemId = await seedItem(SKU_COMPANY);

    coordinatorUserId = await provisionUser(port, `jw-coord-9-8-${run}@example.com`, [
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'custody', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coord-9-8-${run}@example.com`);

    // Task 0.5: the finance controller who PRICES the offcut, and the CFO who SIGNS the
    // acquisition, are two different real users, and neither is the acting coordinator.
    financeUserId = await provisionUser(port, `jw-finance-9-8-${run}@example.com`, [
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: FINANCE_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    financeHeaders = await authFor(port, `jw-finance-9-8-${run}@example.com`);

    cfoUserId = await provisionUser(port, `jw-cfo-9-8-${run}@example.com`, [
      { role: CFO_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: CFO_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    cfoHeaders = await authFor(port, `jw-cfo-9-8-${run}@example.com`);

    ackUserId = await provisionUser(port, `jw-ack-9-8-${run}@example.com`, [
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    ackHeaders = await authFor(port, `jw-ack-9-8-${run}@example.com`);

    await provisionUser(port, `jw-store-9-8-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-8-${run}@example.com`);

    await provisionUser(port, `qc-inspector-9-8-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-9-8-${run}@example.com`);

    await provisionUser(port, `qc-head-9-8-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-9-8-${run}@example.com`);

    await provisionUser(port, `compliance-9-8-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-9-8-${run}@example.com`);

    await provisionUser(port, `jw-other-site-9-8-${run}@example.com`, [
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'write', locationId: siteBId },
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'read', locationId: siteBId },
    ]);

    await provisionUser(port, `site-head-9-8-${run}@example.com`, [
      { role: SITE_HEAD_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);

    // BSD-9: the acquisition band is DEDICATED to `cfo`. Seeding a second role under this
    // transaction type would let resolveApprover fall back across roles and resolve the CFO
    // signature to somebody else while every arm below stayed green.
    for (const [transactionType, role, valueMin] of [
      ['qc.inspection_plan_approval', 'qc_head', null],
      [OFFCUT_ACQUISITION_TYPE, CFO_ROLE, DOA_BAND_MIN],
    ] as [string, string, number | null][]) {
      const entry = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { role, transaction_type: transactionType, value_min: valueMin, value_max: null },
        complianceHeaders,
      );
      assert.strictEqual(entry.status, 201, `${transactionType}: ${JSON.stringify(entry.body)}`);
    }

    // The `cfo` role is global and outlives this run, so the holder resolveApprover picks may be an
    // earlier run's user. Resolve the real approver instead of assuming this run's fixture wins.
    const acquisitionApprover = await resolvedApprover(OFFCUT_ACQUISITION_TYPE, {
      value: DOA_BAND_MIN,
      role: CFO_ROLE,
    });
    cfoUserId = acquisitionApprover.userId;
    cfoHeaders = acquisitionApprover.headers;

    const kit = await seedKitBom([
      { sku: SKU, itemId: customerItemId, supplySource: 'customer' },
      { sku: SKU_COMPANY, itemId: companyItemId, supplySource: 'company' },
    ]);
    kitBomId = kit.bomId;
    kitRevisionId = kit.revisionId;
    outputItemId = kit.itemId;

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
    characteristicIds['output'] = (
      created.body['characteristics'] as Record<string, unknown>[]
    )[0]!['characteristic_id'] as string;
    const planApprover = await resolvedApprover('qc.inspection_plan_approval');
    const approved = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/inspection-plans/${planId}/versions/${versionId}/approve`,
      { idempotency_key: randomUUID() },
      planApprover.headers,
    );
    assert.strictEqual(
      approved.status,
      200,
      `plan approve failed: ${JSON.stringify(approved.body)}`,
    );
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // Story 9.8 helpers
  // -------------------------------------------------------------------------

  /** A `returned` or below-band `acquired` disposal on an existing holding. */
  async function disposeOffcut(
    orderId: string,
    holdingId: string,
    body: Record<string, unknown>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      { holding_id: holdingId, location_id: dockId, idempotency_key: randomUUID(), ...body },
      financeHeaders,
    );
  }

  /** The revaluation route (Story 9.7 AC 5), used here only to test cross-route key reuse. */
  async function revalue(
    orderId: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-revaluations`,
      { currency: 'INR', idempotency_key: idempotencyKey, ...body },
      financeHeaders,
    );
  }

  /** The disposal route. An above-band `acquired` posting comes back as a pending proposal. */
  async function proposeAcquisition(
    orderId: string,
    holdingId: string,
    opts: { rate?: string; headers?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      {
        holding_id: holdingId,
        disposition: 'acquired',
        rate: opts.rate ?? INDICATIVE_RATE,
        currency: 'INR',
        location_id: dockId,
        idempotency_key: opts.idempotencyKey ?? randomUUID(),
      },
      opts.headers ?? financeHeaders,
    );
  }

  async function approveProposal(
    orderId: string,
    proposalId: string,
    headers: Record<string, string> = cfoHeaders,
    idempotencyKey: string = randomUUID(),
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-acquisition-proposals/${proposalId}/approve`,
      { idempotency_key: idempotencyKey },
      headers,
    );
  }

  async function proposalRow(proposalId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT proposal_id, service_order_id, holding_id, site_id, rate::text AS rate, currency,
              indicative_rate::text AS indicative_rate, proposed_value::text AS proposed_value,
              doa_entry_id, resolved_approver_actor_id, proposed_by, status, decided_at, decided_by,
              disposal_event_id
         FROM job_work_offcut_acquisition_proposal WHERE proposal_id = $1`,
      [proposalId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function proposalCountForHolding(holdingId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM job_work_offcut_acquisition_proposal WHERE holding_id = $1`,
      [holdingId],
    );
    return r.rows[0]!['n'] as number;
  }

  async function firstProposalIdForHolding(holdingId: string): Promise<string> {
    const r = await getAdminPool().query(
      `SELECT proposal_id FROM job_work_offcut_acquisition_proposal WHERE holding_id = $1
        ORDER BY created_at ASC LIMIT 1`,
      [holdingId],
    );
    assert.ok(r.rows[0], `no proposal row for holding ${holdingId}`);
    return r.rows[0]!['proposal_id'] as string;
  }

  async function holdingsRead(
    orderId: string,
    headers: Record<string, string> = financeHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/offcut-holdings`,
      undefined,
      headers,
    );
  }

  function proposalEnvelope(
    orderId: string,
    holdingId: string,
    extra: Record<string, unknown> = {},
    actor: { userId: string; role: string } = { userId: financeUserId, role: FINANCE_ROLE },
  ) {
    return {
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_acquisition_proposed',
      payload: {
        service_order_id: orderId,
        proposal_id: randomUUID(),
        holding_id: holdingId,
        site_id: siteAId,
        rate: INDICATIVE_RATE,
        currency: 'INR',
        posted_by: actor.userId,
        ...extra,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    };
  }

  function approvalEnvelope(
    orderId: string,
    proposalId: string,
    extra: Record<string, unknown> = {},
    actor: { userId: string; role: string } = { userId: cfoUserId, role: CFO_ROLE },
  ) {
    return {
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_acquisition_approved',
      payload: {
        service_order_id: orderId,
        proposal_id: proposalId,
        site_id: siteAId,
        approved_by: actor.userId,
        ...extra,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // AC 1, 2, 7, 8: the two-step round trip
  // -------------------------------------------------------------------------

  it('AC 1, 7, 8: an above-band acquisition persists a PROPOSAL and performs no disposal effect', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const holdingBefore = await holdingRow(holdingId);
    const offcutLot = holdingBefore['lot_id'] as string;
    // The fixture's own dispatch already reconciled part of the clock; what matters here is that
    // the PROPOSAL moves it not at all.
    const reconciledBefore = (await clockRow(orderId))['reconciled_qty'];

    // 100 KG at 18.5 = 1850, in the governed band (>= 1000).
    const proposed = await proposeAcquisition(orderId, holdingId);
    assert.strictEqual(proposed.status, 201, JSON.stringify(proposed.body));
    assert.strictEqual(proposed.body['status'], 'pending_approval');
    const proposalId = proposed.body['proposal_id'] as string;
    assert.ok(proposalId);

    // AC 1: the proposal records the terms, the matched band and the RESOLVED approver.
    const proposal = await proposalRow(proposalId);
    assert.strictEqual(proposal['status'], 'pending');
    assert.strictEqual(proposal['holding_id'], holdingId);
    assert.strictEqual(proposal['rate'], INDICATIVE_RATE);
    assert.strictEqual(proposal['proposed_value'], '1850.0000');
    assert.strictEqual(proposal['proposed_by'], financeUserId);
    assert.strictEqual(proposal['resolved_approver_actor_id'], cfoUserId);
    assert.ok(proposal['doa_entry_id'], 'the matched DOA band is frozen on the proposal');
    assert.strictEqual(proposal['decided_at'], null);
    assert.strictEqual(proposal['disposal_event_id'], null);

    // AC 1, AC 8: NOTHING happened. The holding is still retained, the offcut stock is still in the
    // segregated class, no owned lot exists, no credit note was raised and the clock still runs.
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'retained');
    assert.strictEqual(row['disposed_at'], null);
    assert.strictEqual(row['disposal_value'], null);
    assert.strictEqual(row['approved_by'], null);
    assert.strictEqual(row['owned_lot_id'], null);
    assert.strictEqual(await stockOnHand(offcutLot, 'offcut'), '100.000');
    assert.strictEqual((await creditNotes(orderId)).length, 0);
    assert.strictEqual((await clockRow(orderId))['reconciled_qty'], reconciledBefore);

    // AC 7: the pending signature is VISIBLE to an authorized reader without guessing.
    const read = await holdingsRead(orderId);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const holdingsOut = read.body['holdings'] as Record<string, unknown>[];
    const pending = holdingsOut.find((h) => h['holding_id'] === holdingId)![
      'pending_approval'
    ] as Record<string, unknown>;
    assert.strictEqual(pending['proposal_id'], proposalId);
    assert.strictEqual(pending['resolved_approver_actor_id'], cfoUserId);
    assert.strictEqual(pending['proposed_by'], financeUserId);
    assert.strictEqual(pending['proposed_value'], '1850.0000');
  });

  it('AC 2: the resolved CFO approving through their OWN session executes the Story 9.7 effects', async () => {
    const { orderId, holdingId, invoiceRef } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const offcutLot = (await holdingRow(holdingId))['lot_id'] as string;
    const reconciledBefore = (await clockRow(orderId))['reconciled_qty'] as string;
    const proposalId = (await proposeAcquisition(orderId, holdingId)).body['proposal_id'] as string;

    const approved = await approveProposal(orderId, proposalId);
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));

    // The proposal is decided, by the authenticated approver, and points at the event that did it.
    const proposal = await proposalRow(proposalId);
    assert.strictEqual(proposal['status'], 'approved');
    assert.strictEqual(proposal['decided_by'], cfoUserId);
    assert.strictEqual(proposal['disposal_event_id'], approved.body['event_id']);

    // AC 2: title transferred, the offcut left its segregated class, an owned lot was minted under
    // the governed QC hold, the credit note cites the acknowledged service invoice and the Section
    // 143 clock stopped for the quantity.
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'disposed');
    assert.strictEqual(row['disposition'], 'acquired');
    assert.strictEqual(row['disposal_value'], '1850.0000');
    assert.strictEqual(row['approved_by'], cfoUserId, 'the approver is the CFO who signed');
    assert.strictEqual(
      row['disposed_by'],
      financeUserId,
      'the poster is the controller who priced',
    );
    assert.ok(row['doa_entry_id']);
    assert.strictEqual(row['clock_reconciled_qty'], '100.000');
    assert.strictEqual(await stockOnHand(offcutLot, 'offcut'), '0.000');
    const ownedLot = row['owned_lot_id'] as string;
    assert.ok(ownedLot, 'an owned lot was minted');
    assert.strictEqual(await stockOnHand(ownedLot, 'owned'), '100.000');
    const held = await qcHeld(ownedLot);
    assert.strictEqual(held.held, true);
    assert.strictEqual(held.openHolds, 1);
    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0]!['document_kind'], 'original');
    assert.strictEqual(notes[0]!['value'], '1850.0000');
    assert.strictEqual(notes[0]!['cited_invoice_ref_ext'], invoiceRef);
    assert.strictEqual(notes[0]!['valued_by'], financeUserId);
    // The approval stopped the clock for the acquired quantity, on top of whatever the fixture's
    // own dispatch had already reconciled.
    const reconciledAfter = (await clockRow(orderId))['reconciled_qty'] as string;
    assert.strictEqual(Number(reconciledAfter) - Number(reconciledBefore), 100);
  });

  // -------------------------------------------------------------------------
  // AC 3, 5: who may sign
  // -------------------------------------------------------------------------

  it('AC 3, 5: anyone but the resolved approver - the proposer included - is refused and audited', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const proposalId = (await proposeAcquisition(orderId, holdingId)).body['proposal_id'] as string;

    // MUTATION POINT 1: the approver identity comes from the AUTHENTICATED caller and is compared
    // against the proposal's FROZEN resolved approver. Comparing anything from a request body, or
    // dropping the comparison, passes these arms and gives the second signature away.
    for (const [label, headers] of [
      ['the original proposer (dual control, AC 5)', financeHeaders],
      ['an unrelated accounts officer', ackHeaders],
      ['the acting coordinator', coordinatorHeaders],
    ] as [string, Record<string, string>][]) {
      const refused = await approveProposal(orderId, proposalId, headers);
      assert.strictEqual(refused.status, 403, `${label}: ${JSON.stringify(refused.body)}`);
      assert.strictEqual(refused.body['error_code'], 'APPROVAL_REQUIRED', label);
      // The refusal never names the resolved approver - it is exactly the session an attacker would
      // want (the 9.7 chunk-A reasoning, still load-bearing).
      assert.strictEqual(detailsOf(refused.body)['resolved_approver_actor_id'], undefined, label);
      assert.ok(refused.traceId && (await auditedFor('APPROVAL_REQUIRED', refused.traceId)), label);
      // AC 3: no disposal effect. The proposal is still pending and the holding still retained.
      assert.strictEqual((await proposalRow(proposalId))['status'], 'pending', label);
      assert.strictEqual((await holdingRow(holdingId))['status'], 'retained', label);
      assert.strictEqual((await creditNotes(orderId)).length, 0, label);
    }

    // And the resolved approver still can.
    const ok = await approveProposal(orderId, proposalId);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'disposed');
  });

  it('AC 5: a CFO who also held finance_controller cannot file a proposal only they could sign', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    // The ROLES_SHARE_HOLDER shape `npm run verify:roles` refuses in production. Dual control must
    // be the applier's own wall on both doors, not something the events-door finance gate happens
    // to catch (a dual-role CFO passes that gate).
    const adminPool = getAdminPool();
    const grant = await adminPool.query(
      `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
       VALUES ($1, 'finance_controller', 'jobwork', 'write', '*')
       ON CONFLICT DO NOTHING
       RETURNING assignment_id`,
      [cfoUserId],
    );
    const grantedAssignmentId = grant.rows[0]?.['assignment_id'] as string | undefined;

    // MUTATION POINT 2: the propose-time dual-control check. Removing it lets the CFO file a
    // proposal they are the resolved approver of - and the schema constraint would then surface as
    // an unclassified 500 rather than this audited refusal.
    const viaRoute = await proposeAcquisition(orderId, holdingId, { headers: cfoHeaders });
    assert.strictEqual(viaRoute.status, 403, JSON.stringify(viaRoute.body));
    assert.strictEqual(viaRoute.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(viaRoute.body)['acting_user_id'], cfoUserId);
    assert.ok(viaRoute.traceId && (await auditedFor('APPROVAL_REQUIRED', viaRoute.traceId)));

    // MUTATION POINT 2 (direct-event arm): straight past the routes, into the applier.
    const viaEvent = await postEvent(
      proposalEnvelope(orderId, holdingId, {}, { userId: cfoUserId, role: CFO_ROLE }),
      cfoHeaders,
    );
    assert.strictEqual(viaEvent.status, 403, JSON.stringify(viaEvent.body));
    assert.strictEqual(viaEvent.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(await proposalCountForHolding(holdingId), 0);
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');

    // Remove the global role mutation so later tests (and later runs) never see a dual-role CFO.
    if (grantedAssignmentId) {
      await adminPool.query(`DELETE FROM user_role_assignments WHERE assignment_id = $1`, [
        grantedAssignmentId,
      ]);
    }
    const cleaned = await adminPool.query(
      `SELECT count(*)::int AS n FROM user_role_assignments
        WHERE user_id = $1 AND role = 'finance_controller' AND module = 'jobwork'`,
      [cfoUserId],
    );
    assert.strictEqual(cleaned.rows[0]!['n'], 0);
  });

  // -------------------------------------------------------------------------
  // AC 4: the claimed-approver path is gone, and one proposal per holding
  // -------------------------------------------------------------------------

  it('AC 4: no request may name an approver, and a second competing proposal is refused', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });

    // The field does not exist on the route...
    const claimed = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      {
        holding_id: holdingId,
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
        approved_by: cfoUserId,
        idempotency_key: randomUUID(),
      },
      financeHeaders,
    );
    assert.strictEqual(claimed.status, 400, JSON.stringify(claimed.body));
    assert.strictEqual(claimed.body['error_code'], 'INVALID_PARAMS');

    // ...nor on the events door, whose closed shape refuses it too.
    const claimedDirect = await postEvent({
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_disposed',
      payload: {
        service_order_id: orderId,
        disposal_id: randomUUID(),
        holding_id: holdingId,
        site_id: siteAId,
        location_id: dockId,
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
        approved_by: cfoUserId,
        posted_by: financeUserId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    });
    assert.strictEqual(claimedDirect.status, 400, JSON.stringify(claimedDirect.body));
    assert.strictEqual(claimedDirect.body['error_code'], 'INVALID_PARAMS');

    // One pending proposal per holding: a second, competing one is refused by the schema.
    const first = await proposeAcquisition(orderId, holdingId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await proposeAcquisition(orderId, holdingId, { rate: '20.0000' });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(await proposalCountForHolding(holdingId), 1);
  });

  // -------------------------------------------------------------------------
  // AC 6: the boundary - nothing below the band gains a proposal step
  // -------------------------------------------------------------------------

  it('AC 6: below-band, free-retention and returned disposals still complete in ONE request', async () => {
    // Below band: 10 KG at 18.5 = 185.
    const below = await invoicedOrderWithHolding({ offcutQty: '10' });
    const belowRes = await proposeAcquisition(below.orderId, below.holdingId);
    assert.strictEqual(belowRes.status, 201, JSON.stringify(belowRes.body));
    assert.strictEqual(belowRes.body['status'], undefined);
    assert.strictEqual(await proposalCountForHolding(below.holdingId), 0);
    assert.strictEqual((await holdingRow(below.holdingId))['status'], 'disposed');

    // A free retention is `acquired` at exactly zero, which is below every band by construction.
    const free = await invoicedOrderWithHolding({ offcutQty: '100' });
    const freeRes = await proposeAcquisition(free.orderId, free.holdingId, { rate: '0.0000' });
    assert.strictEqual(freeRes.status, 201, JSON.stringify(freeRes.body));
    assert.strictEqual(await proposalCountForHolding(free.holdingId), 0);
    const freeRow = await holdingRow(free.holdingId);
    assert.strictEqual(freeRow['status'], 'disposed');
    assert.strictEqual(freeRow['disposal_value'], '0.0000');
    assert.strictEqual((await creditNotes(free.orderId)).length, 0);

    // A `returned` disposal transfers no title and never had a signature to capture.
    const returned = await invoicedOrderWithHolding({ offcutQty: '100' });
    const returnedRes = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${returned.orderId}/offcut-disposals`,
      {
        holding_id: returned.holdingId,
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-ac6`,
        location_id: dockId,
        idempotency_key: randomUUID(),
      },
      financeHeaders,
    );
    assert.strictEqual(returnedRes.status, 201, JSON.stringify(returnedRes.body));
    assert.strictEqual(await proposalCountForHolding(returned.holdingId), 0);
    assert.strictEqual((await holdingRow(returned.holdingId))['disposition'], 'returned');
  });

  it('AC 6 (both directions): a below-band acquisition may not be PROPOSED either', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    // Straight at the events door, since the route would have routed it to a disposal. A proposal
    // below the band would invent an approval step the governance never asked for and leave the
    // offcut retained until somebody signed it.
    const res = await postEvent(proposalEnvelope(orderId, holdingId));
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(await proposalCountForHolding(holdingId), 0);
  });

  // -------------------------------------------------------------------------
  // AC 9: the direct events door meets the identical wall
  // -------------------------------------------------------------------------

  it('AC 9: the events door enforces the finance gate on propose and the identity gate on approve', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });

    // Proposing is the PRICING decision, so it carries the Story 9.7 Task 7.2 finance gate on this
    // door as well: a bare jobwork write grant is not enough.
    const financelessDoor = await postEvent(
      proposalEnvelope(orderId, holdingId, {}, { userId: ackUserId, role: 'accounts_officer' }),
      ackHeaders,
    );
    assert.strictEqual(financelessDoor.status, 403, JSON.stringify(financelessDoor.body));
    assert.strictEqual(financelessDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual(await proposalCountForHolding(holdingId), 0);

    const viaDoor = await postEvent(proposalEnvelope(orderId, holdingId));
    assert.strictEqual(viaDoor.status, 201, JSON.stringify(viaDoor.body));
    const pendingId = await firstProposalIdForHolding(holdingId);

    // Approving is NOT finance-gated - the cfo holds no finance_controller assignment, which is the
    // whole control. What gates it is the identity frozen on the proposal row, checked by the
    // applier because this door never read that row.
    const wrongSigner = await postEvent(
      approvalEnvelope(orderId, pendingId, {}, { userId: ackUserId, role: 'accounts_officer' }),
      ackHeaders,
    );
    assert.strictEqual(wrongSigner.status, 403, JSON.stringify(wrongSigner.body));
    assert.strictEqual(wrongSigner.body['error_code'], 'APPROVAL_REQUIRED');
    assert.ok(wrongSigner.traceId && (await auditedFor('APPROVAL_REQUIRED', wrongSigner.traceId)));

    // A FORGED approved_by naming the CFO from somebody else's session cannot post at all: the
    // shape validator pins the field to the authenticated actor before any applier runs.
    const forged = await postEvent(
      approvalEnvelope(
        orderId,
        pendingId,
        { approved_by: cfoUserId },
        { userId: ackUserId, role: 'accounts_officer' },
      ),
      ackHeaders,
    );
    assert.strictEqual(forged.status, 403, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');

    // The resolved approver's own posting goes through, on this door as on the route.
    const signed = await postEvent(approvalEnvelope(orderId, pendingId), cfoHeaders);
    assert.strictEqual(signed.status, 201, JSON.stringify(signed.body));
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'disposed');
    assert.strictEqual(row['approved_by'], cfoUserId);
  });

  // -------------------------------------------------------------------------
  // AC 10: idempotency on both routes
  // -------------------------------------------------------------------------

  it('AC 10: both steps replay cleanly, and a key reused for a different target is refused', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const other = await invoicedOrderWithHolding({ offcutQty: '100' });

    const proposeKey = randomUUID();
    const first = await proposeAcquisition(orderId, holdingId, { idempotencyKey: proposeKey });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const proposalId = first.body['proposal_id'] as string;

    const replayed = await proposeAcquisition(orderId, holdingId, { idempotencyKey: proposeKey });
    assert.strictEqual(replayed.status, 200, JSON.stringify(replayed.body));
    assert.strictEqual(replayed.body['event_id'], first.body['event_id']);
    assert.strictEqual(replayed.body['proposal_id'], proposalId);
    assert.strictEqual(replayed.body['status'], 'pending_approval');
    assert.strictEqual(await proposalCountForHolding(holdingId), 1);

    // The same key against a DIFFERENT holding is a client bug, not a replay.
    const crossTarget = await proposeAcquisition(other.orderId, other.holdingId, {
      idempotencyKey: proposeKey,
    });
    assert.strictEqual(crossTarget.status, 409, JSON.stringify(crossTarget.body));
    assert.strictEqual(crossTarget.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(await proposalCountForHolding(other.holdingId), 0);

    const approveKey = randomUUID();
    const approved = await approveProposal(orderId, proposalId, cfoHeaders, approveKey);
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    const approvedAgain = await approveProposal(orderId, proposalId, cfoHeaders, approveKey);
    assert.strictEqual(approvedAgain.status, 200, JSON.stringify(approvedAgain.body));
    assert.strictEqual(approvedAgain.body['event_id'], approved.body['event_id']);
    // Exactly one disposal happened: one credit note for the order.
    assert.strictEqual((await creditNotes(orderId)).length, 1);

    // A key reused for a DIFFERENT proposal is refused rather than answering success about a
    // proposal the caller never approved.
    const otherProposalId = (await proposeAcquisition(other.orderId, other.holdingId)).body[
      'proposal_id'
    ] as string;
    const wrongTarget = await approveProposal(
      other.orderId,
      otherProposalId,
      cfoHeaders,
      approveKey,
    );
    assert.strictEqual(wrongTarget.status, 409, JSON.stringify(wrongTarget.body));
    assert.strictEqual(wrongTarget.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((await holdingRow(other.holdingId))['status'], 'retained');

    // A fresh key against an ALREADY approved proposal is refused too - it is no longer pending.
    const twice = await approveProposal(orderId, proposalId);
    assert.strictEqual(twice.status, 409, JSON.stringify(twice.body));
    assert.strictEqual(twice.body['error_code'], 'DUPLICATE_EVENT');
  });

  // -------------------------------------------------------------------------
  // Code review 2026-09-07 patches: regression coverage for the three fixes that change behavior
  // -------------------------------------------------------------------------

  it('patch: a pending proposal blocks EVERY other disposal of the same holding, not just a second proposal', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const proposalId = (await proposeAcquisition(orderId, holdingId)).body['proposal_id'] as string;

    // MUTATION POINT: the getPendingProposalForHolding check in applyJobworkOffcutDisposed. Without
    // it, a `returned` disposal on this holding would complete with no CFO signature at all.
    const returned = await disposeOffcut(orderId, holdingId, {
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-patch1`,
    });
    assert.strictEqual(returned.status, 409, JSON.stringify(returned.body));
    assert.strictEqual(returned.body['error_code'], 'OFFCUT_NOT_RETAINED');
    assert.strictEqual(detailsOf(returned.body)['reason'], 'acquisition_proposal_pending');
    assert.ok(returned.traceId && (await auditedFor('OFFCUT_NOT_RETAINED', returned.traceId)));

    // A repriced BELOW-band acquired disposal on the same holding must be blocked too - the whole
    // point is that re-submitting at a friendlier rate cannot skip the pending signature.
    const repriced = await disposeOffcut(orderId, holdingId, {
      disposition: 'acquired',
      rate: '1.0000',
      currency: 'INR',
    });
    assert.strictEqual(repriced.status, 409, JSON.stringify(repriced.body));
    assert.strictEqual(repriced.body['error_code'], 'OFFCUT_NOT_RETAINED');

    // Nothing moved: the holding is still retained and the proposal is still pending.
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');
    assert.strictEqual((await proposalRow(proposalId))['status'], 'pending');

    // The direct events door meets the identical wall.
    const viaEvent = await postEvent({
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_disposed',
      payload: {
        service_order_id: orderId,
        disposal_id: randomUUID(),
        holding_id: holdingId,
        site_id: siteAId,
        location_id: dockId,
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-patch1-door`,
        posted_by: financeUserId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    });
    assert.strictEqual(viaEvent.status, 409, JSON.stringify(viaEvent.body));
    assert.strictEqual(viaEvent.body['error_code'], 'OFFCUT_NOT_RETAINED');

    // And the proposal can still be approved normally afterward - it was never disturbed.
    const approved = await approveProposal(orderId, proposalId);
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'disposed');
  });

  it('patch: a proposal idempotency key reused on the revaluation route is refused, not silently replayed', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const key = randomUUID();
    const proposed = await proposeAcquisition(orderId, holdingId, { idempotencyKey: key });
    assert.strictEqual(proposed.status, 201, JSON.stringify(proposed.body));

    // MUTATION POINT: the spec.bandAware gate on the retry-recognition branch. Without it, this
    // reused key would be silently accepted as a "replay" and return a pending-proposal-shaped body
    // from the revaluation endpoint instead of refusing the cross-route reuse.
    const reused = await revalue(orderId, { holding_id: holdingId, rate: '5.0000' }, key);
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    assert.strictEqual(reused.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(
      reused.body['status'],
      undefined,
      'must not read back as a pending proposal',
    );
  });

  it('patch: a backdated occurred_at on the direct approval event is refused cleanly, never a raw 500', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const proposalId = (await proposeAcquisition(orderId, holdingId)).body['proposal_id'] as string;

    // MUTATION POINT: the occurredAt < proposal.created_at guard. Without it, this trips the
    // chk_job_work_offcut_acq_proposal_lifecycle CHECK as an unclassified Postgres 23514 (a 500).
    // Built inline (not via approvalEnvelope) so the backdated timestamp lands in metadata, not payload.
    const backdated = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.offcut_acquisition_approved',
        payload: {
          service_order_id: orderId,
          proposal_id: proposalId,
          site_id: siteAId,
          approved_by: cfoUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: cfoUserId, role: CFO_ROLE, location_id: siteAId },
          occurred_at: '2000-01-01T00:00:00.000Z',
        },
      },
      cfoHeaders,
    );
    assert.strictEqual(backdated.status, 400, JSON.stringify(backdated.body));
    assert.strictEqual(backdated.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await proposalRow(proposalId))['status'], 'pending');
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');

    // A normal, server-time approval still goes through afterward.
    const ok = await postEvent(approvalEnvelope(orderId, proposalId), cfoHeaders);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'disposed');
  });

  it('D8 (chunk D code review 2026-09-06): an in-range 14-digit rate times a large quantity overflows NUMERIC(18,4) at PROPOSE and is classified INVALID_PARAMS, never a raw 22003 500', async () => {
    // The rate regex bound alone cannot see the PRODUCT: 99999999999999.9999 is a legal 18,4 rate,
    // but 100 KG at that rate computes to 9999999999999999.9900 - sixteen integer digits, off the
    // 18,4 scale. The proposal row carries proposed_value NUMERIC(18,4), so the overflow surfaces at
    // PROPOSE, inside the proposal insert, where classifyMoneyInsert maps SQLSTATE 22003 to a clean
    // 400 INVALID_PARAMS. Without the classification the finance controller would get a raw 500.
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    const proposed = await proposeAcquisition(orderId, holdingId, {
      rate: '99999999999999.9999',
    });
    assert.strictEqual(proposed.status, 400, JSON.stringify(proposed.body));
    assert.strictEqual(proposed.body['error_code'], 'INVALID_PARAMS');
    // Nothing was written: the holding is still retained and no proposal row exists.
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');
    assert.strictEqual(await proposalCountForHolding(holdingId), 0);
    assert.deepStrictEqual(await creditNotes(orderId), []);

    // A normal-rate proposal on the same holding still goes through afterward - the refusal left
    // the row untouched, so the CFO workflow is not wedged.
    const ok = await proposeAcquisition(orderId, holdingId);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');
    const approved = await approveProposal(orderId, ok.body['proposal_id'] as string);
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'disposed');
  });
});

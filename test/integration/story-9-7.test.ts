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
import { runJobworkClockSweepCycle } from '../../src/notify/jobwork-clock-sweep.js';
import { dispatchGateBlockedLots } from '../../src/compliance/dispatch.js';
import { getLatestCreditNoteForHolding } from '../../src/read/projections/job_work_credit_note.js';

/**
 * Story 9.7 Offcut Holding, Disposal and Valuation (FR-JW-09/10, FR-JW-12, FR-AC-11). Real
 * PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run serially;
 * every identifier is run-scoped. Fixture writes use the admin pool (app_user has no DELETE). The
 * harness scaffolding is a deliberate local re-implementation of the story-9-6 closures (never
 * import cross-story). The clock sweep is called DIRECTLY against a backdated expiry_date.
 *
 * TWO SEPARATE REAL PEOPLE hold the segregated pair (Task 0.5): `finance_controller` posts and
 * prices the disposal, `cfo` signs the acquisition above the DOA band, and neither is the acting
 * coordinator. `npm run verify:roles` enforces the same separation against a live environment.
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

/**
 * D2 (chunk D code review 2026-09-06): NUMERIC strings compared through Number() float through
 * binary doubles, so "0.500" - "0.200" can read as 0.30000000000000004. Compare at the QTY scale
 * (3) as integers instead: strip the dot and diff the whole numbers.
 */
function scaledQty(q: string): number {
  return Number(q.replace('.', ''));
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

describe('Story 9.7 Offcut Holding, Disposal and Valuation', () => {
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
  const CUSTOMER = `CUST-9-7-${RUN}`;
  const SKU = `SKU-CUST-9-7-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-9-7-${RUN}`;
  const OUTPUT_SKU = `SKU-OUT-9-7-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-7-${run}`;
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
    const poRef = `PO-JW-9-7-${run}-${poCounter}`;
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
       VALUES ($1, $2, $3, $4, 'site-A-9-7', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-7', 'MANUAL', $6, $7, $8)`,
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
    opts: { challanQty?: string } = {},
  ): Promise<{ lot: string; challan: string }> {
    const poRef = await seedPo(SKU);
    const token = await seedToken(poRef);
    const lot = `LOT-JW-9-7-${run}-${randomUUID().slice(0, 6)}`;
    const challan = `CH-${run}-${randomUUID().slice(0, 6)}`;
    const challanQty = opts.challanQty ?? qty;
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
        challan_qty: challanQty,
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

  /** An in_process order with a captured, still-retained offcut holding row. */
  async function retainedHolding(
    opts: { quantity?: string; receiveQty?: string; indicativeRate?: string | null } = {},
  ): Promise<{ orderId: string; lot: string; holdingId: string; quantity: string }> {
    const orderId = await confirmedOrder(
      opts.indicativeRate === undefined ? {} : { indicativeRate: opts.indicativeRate },
    );
    const receiveQty = opts.receiveQty ?? '1000';
    const { lot } = await receive(orderId, receiveQty);
    const quantity = opts.quantity ?? '10';
    const holdingId = await capture(orderId, lot, quantity);
    return { orderId, lot, holdingId, quantity };
  }

  async function dispose(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = financeHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      { location_id: dockId, idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  async function revalue(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = financeHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-revaluations`,
      { currency: 'INR', idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  async function acknowledgeCreditNote(
    creditNoteId: string,
    headers: Record<string, string> = ackHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/credit-notes/${creditNoteId}/acknowledgment`,
      {
        idempotency_key: randomUUID(),
        acknowledged_ref_ext: `ERP-CN-${run}-${randomUUID().slice(0, 6)}`,
      },
      headers,
    );
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

  function disposalEnvelope(
    orderId: string,
    holdingId: string,
    extra: Record<string, unknown> = {},
    actor: { userId: string; role: string } = { userId: financeUserId, role: FINANCE_ROLE },
  ) {
    return {
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_disposed',
      payload: {
        service_order_id: orderId,
        disposal_id: randomUUID(),
        holding_id: holdingId,
        site_id: siteAId,
        location_id: dockId,
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

  /** Story 9.8: the direct-door envelope for an above-band acquisition PROPOSAL. */
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
      { disposition: 'accept', justification: 'Story 9.7 dispatch fixture' },
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

  async function documentsFor(orderId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT document_type, document_content FROM dispatch_document
        WHERE dispatch_order_id = $1 ORDER BY document_type ASC`,
      [orderId],
    );
    return r.rows as Record<string, unknown>[];
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

    siteAId = await seedLocation('site', `SITE-A-9-7-${run}`, null);
    siteBId = await seedLocation('site', `SITE-B-9-7-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId);
    customerItemId = await seedItem(SKU);
    const companyItemId = await seedItem(SKU_COMPANY);

    coordinatorUserId = await provisionUser(port, `jw-coord-9-7-${run}@example.com`, [
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'custody', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coord-9-7-${run}@example.com`);

    // Task 0.5: the finance controller who PRICES the offcut, and the CFO who SIGNS the
    // acquisition, are two different real users, and neither is the acting coordinator.
    financeUserId = await provisionUser(port, `jw-finance-9-7-${run}@example.com`, [
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: FINANCE_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    financeHeaders = await authFor(port, `jw-finance-9-7-${run}@example.com`);

    cfoUserId = await provisionUser(port, `jw-cfo-9-7-${run}@example.com`, [
      { role: CFO_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: CFO_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    cfoHeaders = await authFor(port, `jw-cfo-9-7-${run}@example.com`);

    ackUserId = await provisionUser(port, `jw-ack-9-7-${run}@example.com`, [
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    ackHeaders = await authFor(port, `jw-ack-9-7-${run}@example.com`);

    await provisionUser(port, `jw-store-9-7-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-7-${run}@example.com`);

    await provisionUser(port, `qc-inspector-9-7-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-9-7-${run}@example.com`);

    await provisionUser(port, `qc-head-9-7-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-9-7-${run}@example.com`);

    await provisionUser(port, `compliance-9-7-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-9-7-${run}@example.com`);

    await provisionUser(port, `jw-other-site-9-7-${run}@example.com`, [
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'write', locationId: siteBId },
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'read', locationId: siteBId },
    ]);
    otherSiteHeaders = await authFor(port, `jw-other-site-9-7-${run}@example.com`);

    await provisionUser(port, `site-head-9-7-${run}@example.com`, [
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
  // Task 1: the segregation bar (PREREQUISITE)
  // -------------------------------------------------------------------------

  it('Task 1: retained offcut is barred from every demand, and disposal is the ONE door', async () => {
    const { orderId, holdingId } = await retainedHolding();
    const holding = await holdingRow(holdingId);
    const offcutLot = holding['lot_id'] as string;
    assert.strictEqual(await stockOnHand(offcutLot, 'offcut'), '10.000');

    // MUTATION POINT 1: an ordinary stock issue naming the offcut class carries no Symbol and must
    // be refused. There is no lightweight issue ROUTE to exercise here - the earlier arm pointed at
    // /api/v1/stock/issues, a route this codebase has never registered, so its 404 was exactly the
    // false-green chunk D forbids. Every issue path funnels into applyStockBalanceProjection, the
    // same seam the direct-event arm below drives: removing `offcut` from
    // CUSTOMER_OWNED_STOCK_CLASSES, or widening the door to any Symbol, fails THAT arm, and the
    // disposal arm at the end proves the offcut class still drains through its ONE door.
    const direct = await postEvent(
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.issued',
        payload: {
          sku: SKU,
          target_location_id: dockId,
          lot_id: offcutLot,
          quantity: '1',
          stock_class: 'offcut',
          business_stream: 'job_work',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: COORDINATOR_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(
      direct.status,
      400,
      `a direct offcut issue must never succeed: ${direct.text}`,
    );
    assert.strictEqual(direct.body['error_code'], 'CROSS_ISSUE_BLOCKED', direct.text);
    assert.strictEqual(await stockOnHand(offcutLot, 'offcut'), '10.000');

    // ...and the disposal path, which stamps the Symbol, does drain it.
    const disposed = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-1`,
    });
    assert.strictEqual(disposed.status, 201, JSON.stringify(disposed.body));
    assert.strictEqual(await stockOnHand(offcutLot, 'offcut'), '0.000');
  });

  // -------------------------------------------------------------------------
  // AC 1, AC 2: the `returned` disposition
  // -------------------------------------------------------------------------

  it('AC 1 + AC 2: a returned disposal closes the holding row, renders documents and stops the clock', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '25' });
    const before = await clockRow(orderId);
    assert.strictEqual(before['reconciled_qty'], '0.000');

    const challan = `RCH-${run}-${randomUUID().slice(0, 6)}`;
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: challan,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'disposed');
    assert.strictEqual(row['disposition'], 'returned');
    assert.strictEqual(row['disposed_by'], financeUserId);
    assert.strictEqual(row['return_challan_number_ext'], challan);
    // A return transfers no title, so it carries no price at all (the widened lifecycle CHECK).
    assert.strictEqual(row['disposal_rate'], null);
    assert.strictEqual(row['disposal_value'], null);
    assert.strictEqual(row['owned_lot_id'], null);

    // AC 2: the four generic document types, the challan in the commercial_invoice slot.
    const docs = await documentsFor(orderId);
    assert.deepStrictEqual(docs.map((d) => d['document_type']).sort(), [
      'bol',
      'commercial_invoice',
      'label',
      'packing_slip',
    ]);
    const invoiceDoc = docs.find((d) => d['document_type'] === 'commercial_invoice')!;
    assert.match(invoiceDoc['document_content'] as string, /OFFCUT RETURN CHALLAN/);
    assert.ok((invoiceDoc['document_content'] as string).includes(challan));

    // AC 1: the Section 143 clock is stopped for the disposed quantity, and no credit note exists.
    const after = await clockRow(orderId);
    assert.strictEqual(after['reconciled_qty'], '25.000');
    assert.deepStrictEqual(await creditNotes(orderId), []);
  });

  // -------------------------------------------------------------------------
  // AC 3, AC 4: the `acquired` disposition
  // -------------------------------------------------------------------------

  it('AC 3: an acquisition mints an owned lot under QC hold, raises a credit note citing the invoice, and stops the clock', async () => {
    const { orderId, holdingId, invoiceRef } = await invoicedOrderWithHolding({ offcutQty: '10' });
    // The Story 9.4 dispatch on this fixture already reconciled part of the clock, so the assertion
    // below is on the DELTA this disposal adds, never on an absolute figure.
    const clockBefore = await clockRow(orderId);
    // 10 KG at 18.5 = 185, below the 1000 band: no second signature required here.
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'disposed');
    assert.strictEqual(row['disposition'], 'acquired');
    assert.strictEqual(row['disposal_rate'], INDICATIVE_RATE);
    assert.strictEqual(row['disposal_value'], '185.0000');
    assert.strictEqual(row['disposal_currency'], 'INR');
    assert.strictEqual(row['approved_by'], null);

    // Title transferred: a NEW owned lot, held for QC because the material was only ever inspected
    // as the customer's, against the customer's specification.
    const ownedLot = row['owned_lot_id'] as string;
    assert.ok(ownedLot, 'an acquisition must mint an owned lot');
    assert.strictEqual(await stockOnHand(ownedLot, 'owned'), '10.000');
    assert.strictEqual(await stockOnHand(row['lot_id'] as string, 'offcut'), '0.000');
    const held = await qcHeld(ownedLot);
    assert.strictEqual(held.held, true, 'the acquired lot must be held for QC');
    assert.ok(held.openHolds >= 1);

    // AC 3: ONE original credit note, citing the acknowledged service invoice.
    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0]!['document_kind'], 'original');
    assert.strictEqual(notes[0]!['cited_invoice_ref_ext'], invoiceRef);
    assert.strictEqual(notes[0]!['value'], '185.0000');
    assert.strictEqual(notes[0]!['status'], 'pending');
    assert.strictEqual(notes[0]!['valued_by'], financeUserId);

    const clock = await clockRow(orderId);
    // Consumption never touches the clock; this disposal moves exactly the disposed quantity.
    // D2 (chunk D code review 2026-09-06): the delta is compared as scaled integers, never through
    // Number() on NUMERIC strings (binary float noise).
    assert.strictEqual(
      scaledQty(clock['reconciled_qty'] as string) -
        scaledQty(clockBefore['reconciled_qty'] as string),
      scaledQty('10.000'),
    );
  });

  it('AC 3 (BSD-5): a free retention is acquired at rate zero - it mints the lot and raises NO credit note', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    // Deliberately NO billing feed on this order: a zero-rate acquisition must not need one, because
    // it never reaches the citation precondition.
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: '0',
      currency: 'INR',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['disposition'], 'acquired');
    assert.strictEqual(row['disposal_rate'], '0.0000');
    assert.strictEqual(row['disposal_value'], '0.0000');
    assert.ok(row['owned_lot_id'], 'a free retention still transfers title and still mints a lot');
    assert.strictEqual(await stockOnHand(row['owned_lot_id'] as string, 'owned'), '10.000');
    assert.deepStrictEqual(await creditNotes(orderId), []);
  });

  it('AC 4: a negotiated rate differing from the indicative rate is accepted, with both stored', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    // Half the indicative rate: no tolerance is applied and nothing is refused on rate.
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: '9.2500',
      currency: 'INR',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['disposal_rate'], '9.2500');
    assert.strictEqual(row['indicative_rate'], INDICATIVE_RATE);
    assert.strictEqual(row['disposal_value'], '92.5000');
    const notes = await creditNotes(orderId);
    assert.strictEqual(notes[0]!['rate'], '9.2500');
    assert.strictEqual(notes[0]!['indicative_rate'], INDICATIVE_RATE);
  });

  it('Task 4.11: an acquisition with no acknowledged service invoice is refused CREDIT_NOTE_UNCITABLE', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CREDIT_NOTE_UNCITABLE');
    assert.strictEqual(detailsOf(res.body)['reason'], 'no_billing_feed');
    // Nothing was written: the holding row is untouched and the offcut stock is still there.
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'retained');
    assert.strictEqual(await stockOnHand(row['lot_id'] as string, 'offcut'), '10.000');
    assert.ok(res.traceId && (await auditedFor('CREDIT_NOTE_UNCITABLE', res.traceId)));
  });

  // -------------------------------------------------------------------------
  // Open question 4: one disposal per row, never two, never partial
  // -------------------------------------------------------------------------

  it('AC 1: a second disposal of the same holding row is refused OFFCUT_NOT_RETAINED', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const first = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-${randomUUID().slice(0, 6)}`,
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-${randomUUID().slice(0, 6)}`,
    });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'OFFCUT_NOT_RETAINED');
    assert.strictEqual(detailsOf(second.body)['reason'], 'already_disposed');
    assert.ok(second.traceId && (await auditedFor('OFFCUT_NOT_RETAINED', second.traceId)));
  });

  // -------------------------------------------------------------------------
  // AC 5: revaluation
  // -------------------------------------------------------------------------

  it('AC 5: a revaluation raises a delta document and never mutates the original', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const [original] = await creditNotes(orderId);

    const revalued = await revalue(orderId, { holding_id: holdingId, rate: '20.0000' });
    assert.strictEqual(revalued.status, 201, JSON.stringify(revalued.body));

    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 2);
    const delta = notes[1]!;
    assert.strictEqual(delta['document_kind'], 'delta');
    assert.strictEqual(delta['supersedes_credit_note_id'], original!['credit_note_id']);
    assert.strictEqual(delta['value'], '200.0000');
    assert.strictEqual(delta['delta_value'], '15.0000');
    assert.strictEqual(delta['cited_invoice_ref_ext'], original!['cited_invoice_ref_ext']);
    // The original is byte-for-byte what it was.
    assert.deepStrictEqual(notes[0], original);
    // The holding row carries the CURRENT commercial value; the documents stay immutable.
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['disposal_rate'], '20.0000');
    assert.strictEqual(row['disposal_value'], '200.0000');
    assert.strictEqual(row['indicative_rate'], INDICATIVE_RATE);

    // A second revaluation chains off the LATEST delta, and downward is a negative delta.
    const again = await revalue(orderId, { holding_id: holdingId, rate: '15.0000' });
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    const chained = await creditNotes(orderId);
    assert.strictEqual(chained.length, 3);
    assert.strictEqual(chained[2]!['supersedes_credit_note_id'], delta['credit_note_id']);
    assert.strictEqual(chained[2]!['delta_value'], '-50.0000');
  });

  it('AC 5: revaluing a free retention is refused CREDIT_NOTE_MISSING; revaluing a return is refused', async () => {
    const free = await retainedHolding({ quantity: '10' });
    assert.strictEqual(
      (
        await dispose(free.orderId, {
          holding_id: free.holdingId,
          disposition: 'acquired',
          rate: '0',
          currency: 'INR',
        })
      ).status,
      201,
    );
    const noDoc = await revalue(free.orderId, { holding_id: free.holdingId, rate: '5.0000' });
    assert.strictEqual(noDoc.status, 409, JSON.stringify(noDoc.body));
    assert.strictEqual(noDoc.body['error_code'], 'CREDIT_NOTE_MISSING');
    assert.ok(noDoc.traceId && (await auditedFor('CREDIT_NOTE_MISSING', noDoc.traceId)));

    const returned = await retainedHolding({ quantity: '10' });
    assert.strictEqual(
      (
        await dispose(returned.orderId, {
          holding_id: returned.holdingId,
          disposition: 'returned',
          return_challan_number_ext: `RCH-${run}-${randomUUID().slice(0, 6)}`,
        })
      ).status,
      201,
    );
    const wrongBranch = await revalue(returned.orderId, {
      holding_id: returned.holdingId,
      rate: '5.0000',
    });
    assert.strictEqual(wrongBranch.status, 400, JSON.stringify(wrongBranch.body));
    assert.strictEqual(wrongBranch.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 6: segregation of duties on the acknowledgment
  // -------------------------------------------------------------------------

  it('AC 6: the finance controller who set the rate cannot acknowledge the credit note that bills it', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const [note] = await creditNotes(orderId);
    const creditNoteId = note!['credit_note_id'] as string;

    // MUTATION POINT 2 (route arm): weakening the SoD comparison in the applier fails here.
    const self = await acknowledgeCreditNote(creditNoteId, financeHeaders);
    assert.strictEqual(self.status, 403, JSON.stringify(self.body));
    assert.strictEqual(self.body['error_code'], 'SOD_VIOLATION');
    assert.strictEqual(detailsOf(self.body)['valued_by'], financeUserId);
    assert.ok(self.traceId && (await auditedFor('SOD_VIOLATION', self.traceId)));

    // MUTATION POINT 2 (direct-event arm): the same refusal through the events door. Code review
    // 2026-09-06 added the identity pin (P4): an acknowledgment must name the AUTHENTICATED actor
    // as acknowledged_by, so a FORGED third-party name is now refused FUNCTION_ACCESS_DENIED before
    // the SOD check can even run...
    const forgedName = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.credit_note_acknowledged',
        payload: {
          service_order_id: orderId,
          credit_note_id: creditNoteId,
          site_id: siteAId,
          acknowledged_ref_ext: `ERP-CN-${run}-forged`,
          acknowledged_by: ackUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      financeHeaders,
    );
    assert.strictEqual(forgedName.status, 403, JSON.stringify(forgedName.body));
    assert.strictEqual(forgedName.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // ...while the VALUER acknowledging as themself through the door still hits the SOD wall.
    const selfDirect = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.credit_note_acknowledged',
        payload: {
          service_order_id: orderId,
          credit_note_id: creditNoteId,
          site_id: siteAId,
          acknowledged_ref_ext: `ERP-CN-${run}-self`,
          acknowledged_by: financeUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      financeHeaders,
    );
    assert.strictEqual(selfDirect.status, 403, JSON.stringify(selfDirect.body));
    assert.strictEqual(selfDirect.body['error_code'], 'SOD_VIOLATION');
    assert.ok(selfDirect.traceId && (await auditedFor('SOD_VIOLATION', selfDirect.traceId)));

    // A different person acknowledges, and the document flips exactly once.
    const ok = await acknowledgeCreditNote(creditNoteId, ackHeaders);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const acknowledged = (await creditNotes(orderId))[0]!;
    assert.strictEqual(acknowledged['status'], 'acknowledged');
    assert.strictEqual(acknowledged['acknowledged_by'], ackUserId);
    const twice = await acknowledgeCreditNote(creditNoteId, ackHeaders);
    assert.strictEqual(twice.status, 409, JSON.stringify(twice.body));
    assert.strictEqual(twice.body['error_code'], 'DUPLICATE_EVENT');
  });

  // -------------------------------------------------------------------------
  // AC 7: the governed DOA band and dual control
  // -------------------------------------------------------------------------

  // Story 9.8 REPOINTED these arms. The AC 7 interim contract - the poster claiming an `approved_by`
  // that merely had to match resolveApprover's output - is GONE: an above-band acquisition is now a
  // PROPOSAL awaiting the CFO's own authenticated approval. The full two-step round trip lives in
  // test/integration/story-9-8.test.ts; what stays here is that the old contract cannot be reached.
  it('AC 7 (Story 9.8): an above-band acquisition becomes a PROPOSAL, and no request may name an approver', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });

    // Story 9.8 AC 4: there is no field left on a disposal through which a caller can name an
    // approver, on either door. MUTATION POINT: re-adding `approved_by` to the route's allow-list
    // or to DISPOSAL_FIELDS resurrects the whole hazard, and this arm is what catches it.
    const claimed = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
      approved_by: cfoUserId,
    });
    assert.strictEqual(claimed.status, 400, JSON.stringify(claimed.body));
    assert.strictEqual(claimed.body['error_code'], 'INVALID_PARAMS');

    // The direct events door cannot post the above-band acquisition AS A DISPOSAL to skip the
    // second signature: the applier refuses it under the order lock and audits the refusal. The
    // refusal still does not name the resolved approver.
    const viaEvent = await postEvent(
      disposalEnvelope(orderId, holdingId, {
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
      }),
    );
    assert.strictEqual(viaEvent.status, 403, JSON.stringify(viaEvent.body));
    assert.strictEqual(viaEvent.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(viaEvent.body)['resolved_approver_user_id'], undefined);
    assert.strictEqual(detailsOf(viaEvent.body)['acquisition_value'], '1850.0000');
    assert.ok(viaEvent.traceId && (await auditedFor('APPROVAL_REQUIRED', viaEvent.traceId)));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');

    // 100 KG at 18.5 = 1850, above the 1000 band: the disposal route answers with a pending
    // proposal and touches nothing (AC 1, AC 8 of Story 9.8).
    const proposed = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
    });
    assert.strictEqual(proposed.status, 201, JSON.stringify(proposed.body));
    assert.strictEqual(proposed.body['status'], 'pending_approval');
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'retained');
    assert.strictEqual(row['approved_by'], null);
    assert.strictEqual(row['disposal_value'], null);
  });

  it('AC 7 (BSD-10): dual control - the acting user must NOT be the resolved approver', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '100' });
    // MUTATION POINT 3: the CFO posts their own acquisition. If the inverted comparison is "fixed"
    // back into the 9.4 same-person form, this arm passes and dual control is gone.
    //
    // The resolved approver here is granted finance_controller as well - the ROLES_SHARE_HOLDER
    // shape `npm run verify:roles` refuses in production. The point of the guard is that even that
    // shape cannot post: dual control is the applier's own wall, on both doors, and the chunk-C
    // events-door finance gate must NOT be what stops a dual-role CFO (they would be allowed by it).
    const adminPool = await getAdminPool();
    const grant = await adminPool.query(
      `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
       VALUES ($1, 'finance_controller', 'jobwork', 'write', '*')
       ON CONFLICT DO NOTHING
       RETURNING assignment_id`,
      [cfoUserId],
    );
    const grantedAssignmentId = grant.rows[0]?.['assignment_id'] as string | undefined;
    const viaRoute = await dispose(
      orderId,
      {
        holding_id: holdingId,
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
      },
      cfoHeaders,
    );
    assert.strictEqual(viaRoute.status, 403, JSON.stringify(viaRoute.body));
    assert.strictEqual(viaRoute.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(viaRoute.body)['acting_user_id'], cfoUserId);

    // MUTATION POINT 3 (direct-event arm): straight past the routes, into the applier. Story 9.8
    // moved this refusal to PROPOSE time - the CFO may not file a proposal only they could sign.
    const viaEvent = await postEvent(
      proposalEnvelope(
        orderId,
        holdingId,
        { rate: INDICATIVE_RATE, currency: 'INR' },
        {
          userId: cfoUserId,
          role: CFO_ROLE,
        },
      ),
      cfoHeaders,
    );
    assert.strictEqual(viaEvent.status, 403, JSON.stringify(viaEvent.body));
    assert.strictEqual(viaEvent.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(viaEvent.body)['acting_user_id'], cfoUserId);
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');

    // Chunk C code review: the events-door finance gate. A user holding ONLY a jobwork write grant
    // (accounts_officer, no finance_controller) must not be able to price an offcut acquisition
    // through POST /api/v1/events - the identical wall to the route's requireFinanceControllerScope.
    const financelessDoor = await postEvent(
      disposalEnvelope(
        orderId,
        holdingId,
        {
          disposition: 'returned',
          return_challan_number_ext: `RCH-${run}-door-gate`,
        },
        { userId: ackUserId, role: 'accounts_officer' },
      ),
      ackHeaders,
    );
    assert.strictEqual(financelessDoor.status, 403, JSON.stringify(financelessDoor.body));
    assert.strictEqual(financelessDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');

    // Chunk D code review (2026-09-06): remove the global role mutation this arm created so later
    // authorization and segregation tests (and subsequent runs) never see a dual-role CFO.
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

  it('AC 7 (Story 9.8 AC 6): a below-band acquisition still completes in ONE request', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    // 10 KG at 18.5 = 185, below the 1000 band: no proposal step is invented for it.
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], undefined, 'a below-band acquisition is not pending');
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'disposed');
    assert.strictEqual(row['approved_by'], null);
    assert.strictEqual(row['doa_entry_id'], null);
    // And it still cannot carry an approval claim - the field does not exist (Story 9.8 AC 4).
    const claimed = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
      approved_by: cfoUserId,
    });
    assert.strictEqual(claimed.status, 400, JSON.stringify(claimed.body));
    assert.strictEqual(claimed.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // BSD-3: a CLOSED order
  // -------------------------------------------------------------------------

  it('BSD-3: a disposal is accepted on a CLOSED order - the offcut outlives the order', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, '100');
    // Capture the WHOLE custody balance so the Story 9.5 closure gate is reachable.
    const holdingId = await capture(orderId, lot, '100');
    const closed = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/closure`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    const orderStatus = await getAdminPool().query(
      `SELECT status FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(orderStatus.rows[0]!['status'], 'closed');

    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-${randomUUID().slice(0, 6)}`,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'disposed');
  });

  // -------------------------------------------------------------------------
  // AC 9: the ageing report
  // -------------------------------------------------------------------------

  it('AC 9: retained offcut appears on the ageing report and leaves it once acquired', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    const before = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/aging?site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(before.status, 200, JSON.stringify(before.body));
    const beforeSection = before.body['offcut_holdings'] as Record<string, unknown>;
    const beforeRows = beforeSection['rows'] as Record<string, unknown>[];
    assert.ok(
      beforeRows.some((r) => r['holding_id'] === holdingId),
      'a retained holding row must appear on the ageing report',
    );
    // BSD-11: the section is reported ALONGSIDE the clock figures and never folded into them.
    assert.strictEqual(beforeSection['counted_in_deemed_supply'], false);

    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );

    const after = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/aging?site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    // D2 (chunk D code review 2026-09-06): assert the status BEFORE reading the body - a failed
    // report would otherwise surface as a TypeError on an undefined body field, not as a report
    // failure.
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));
    const afterRows = (after.body['offcut_holdings'] as Record<string, unknown>)['rows'] as Record<
      string,
      unknown
    >[];
    assert.ok(
      !afterRows.some((r) => r['holding_id'] === holdingId),
      'an acquired holding row is ordinary owned stock and must leave the job-work exposure report',
    );
  });

  it('D10 (chunk D code review 2026-09-06): the ageing horizon boundary - 90 days is breached, 89 is due_within_30, and beyond_90 stays dead for offcut', async () => {
    // `age_days = today - business_date`, runway = 90 - age_days, so 90 lands exactly on breached,
    // 89 on due_within_30, and beyond_90 is unreachable (runway can never exceed the 90-day
    // horizon). The capture route is unaware of business_date, so the rows are backdated directly.
    const businessDateMinusDays = (days: number): string => {
      const d = new Date(`${TODAY}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const breached = await retainedHolding({ quantity: '10' });
    const dueSoon = await retainedHolding({ quantity: '10' });
    await getAdminPool().query(
      `UPDATE job_work_offcut_holding SET business_date = $2::date WHERE holding_id = $1`,
      [breached.holdingId, businessDateMinusDays(90)],
    );
    await getAdminPool().query(
      `UPDATE job_work_offcut_holding SET business_date = $2::date WHERE holding_id = $1`,
      [dueSoon.holdingId, businessDateMinusDays(89)],
    );
    const report = await makeRequest(
      port,
      'GET',
      `/api/v1/jobwork/reports/aging?site_id=${siteAId}`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    const section = report.body['offcut_holdings'] as Record<string, unknown>;
    const rows = section['rows'] as Record<string, unknown>[];
    const breachedRow = rows.find((r) => r['holding_id'] === breached.holdingId);
    const dueSoonRow = rows.find((r) => r['holding_id'] === dueSoon.holdingId);
    assert.ok(breachedRow, 'the 90-day-old holding must appear');
    assert.ok(dueSoonRow, 'the 89-day-old holding must appear');
    assert.strictEqual(breachedRow['age_days'], 90);
    assert.strictEqual(breachedRow['bucket'], 'breached');
    assert.strictEqual(dueSoonRow['age_days'], 89);
    assert.strictEqual(dueSoonRow['bucket'], 'due_within_30');
    const buckets = section['buckets'] as Record<string, Record<string, unknown>>;
    assert.strictEqual(
      buckets['beyond_90']!['count'],
      0,
      'beyond_90 can never be populated for offcut',
    );
    assert.ok((buckets['breached']!['count'] as number) >= 1);
  });

  // -------------------------------------------------------------------------
  // AC 8: the breach sweep
  // -------------------------------------------------------------------------

  it('AC 8: the sweep surfaces retained offcut - on a CLOSED order too - without double-counting deemed supply', async () => {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, '100');
    // D2 (chunk D code review 2026-09-06): capture the WHOLE custody balance so the Story 9.5
    // closure gate is actually REACHABLE - the previous '40' left 60 KG in custody, the order never
    // closed, and the `[200, 409]` acceptance let the "closed-order sweep" claim go unproven.
    const holdingId = await capture(orderId, lot, '100');
    const holding = await holdingRow(holdingId);
    const closed = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/closure`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    const orderStatus = await getAdminPool().query(
      `SELECT status FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(orderStatus.rows[0]!['status'], 'closed');

    // Backdate the clock so this row sorts FIRST in the sweep's expiry-ascending batch, and reaches
    // the breach stage deterministically. Never a hardcoded future date (the 2026-09-05 lesson).
    const clock = await clockRow(orderId);
    await getAdminPool().query(
      `UPDATE jobwork_return_clock SET expiry_date = $2::date WHERE clock_id = $1`,
      // The day after the challan date: past due against TODAY, and still inside
      // chk_jobwork_return_clock_expiry, which requires expiry_date > challan_date.
      [clock['clock_id'], '2026-09-02'],
    );

    const result = await runJobworkClockSweepCycle({ today: TODAY });
    assert.strictEqual(result.cycleFailed, false);
    // D2 (chunk D code review 2026-09-06): an exact count, never `>= 1` - a doubled counter (the
    // raced/rolled-back path counting a row twice) must fail this arm.
    assert.strictEqual(
      result.offcutRetained,
      1,
      'the sweep must count the retained offcut exactly once',
    );

    const swept = await clockRow(orderId);
    assert.strictEqual(swept['status'], 'breached');
    // BSD-11 / Task 8.3: deemed supply is challan - reconciled - loss, and the retained offcut is
    // ALREADY inside that figure because capture does not reconcile the clock. Adding it again
    // would report 200 KG of deemed supply against a 100 KG challan.
    assert.strictEqual(swept['deemed_supply_qty'], '100.000');
    assert.strictEqual(swept['reconciled_qty'], '0.000');

    // D10 (chunk D code review 2026-09-06): the raced/rolled-back path in deterministic form - a
    // SECOND sweep sees the clock already breached, surfaces nothing, and must NOT count the row
    // again. `offcutRetained` is only ever incremented once the stage outcome commits.
    const again = await runJobworkClockSweepCycle({ today: TODAY });
    assert.strictEqual(again.cycleFailed, false);
    assert.strictEqual(again.offcutRetained, 0, 'a retried/raced row must not be counted twice');
    assert.strictEqual((await clockRow(orderId))['status'], 'breached');

    const notes = await notificationsFor(clock['clock_id'] as string);
    assert.ok(notes.length >= 1, 'the breach must notify');
    const text = notes.map((n) => String(n['next_step'] ?? '')).join('\n');
    // Chunk B review decision (2026-09-07): wording softened to drop the false per-clock
    // ownership claim on multi-clock skus (see jobwork-clock-sweep.ts).
    assert.match(text, /Retained contractual offcut on this order\/sku/);
    assert.ok(text.includes(holding['lot_id'] as string));
  });

  // -------------------------------------------------------------------------
  // Direct-event bypass arms (the hold-bypass class) and cross-site writes
  // -------------------------------------------------------------------------

  it('hold-bypass: a direct offcut_disposed event meets every gate the route does', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });

    // Server-derived fields are refused on input, never silently overwritten.
    const derived = await postEvent(
      disposalEnvelope(orderId, holdingId, {
        disposition: 'returned',
        return_challan_number_ext: 'RCH-derived',
        disposal_value: '99.0000',
      }),
    );
    assert.strictEqual(derived.status, 400, JSON.stringify(derived.body));
    assert.strictEqual(derived.body['error_code'], 'INVALID_PARAMS');

    // A return with no challan number, straight through the events door.
    const noChallan = await postEvent(
      disposalEnvelope(orderId, holdingId, { disposition: 'returned' }),
    );
    assert.strictEqual(noChallan.status, 400, JSON.stringify(noChallan.body));

    // A holding row belonging to another order is not disposable from this one.
    const other = await retainedHolding({ quantity: '5' });
    const crossOrder = await postEvent(
      disposalEnvelope(orderId, other.holdingId, {
        disposition: 'returned',
        return_challan_number_ext: 'RCH-cross',
      }),
    );
    assert.strictEqual(crossOrder.status, 404, JSON.stringify(crossOrder.body));

    // And the legitimate direct posting works, proving the arms above refused for their own reason.
    const ok = await postEvent(
      disposalEnvelope(orderId, holdingId, {
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-direct`,
      }),
    );
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'disposed');
  });

  it('hold-bypass: direct revaluation and acknowledgment events meet their own walls', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    // Revaluing a still-retained row is refused before anything is written.
    const early = await postEvent({
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_revalued',
      payload: {
        service_order_id: orderId,
        revaluation_id: randomUUID(),
        holding_id: holdingId,
        site_id: siteAId,
        rate: '5.0000',
        currency: 'INR',
        posted_by: financeUserId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
    });
    assert.strictEqual(early.status, 400, JSON.stringify(early.body));
    assert.strictEqual(early.body['error_code'], 'INVALID_PARAMS');

    // An acknowledgment of a credit note that does not exist is a 404, not a 500. The direct-event
    // acknowledgment must name the AUTHENTICATED actor as acknowledged_by (the P4 identity pin), so
    // the payload and the door user are the same person here.
    const missing = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.credit_note_acknowledged',
        payload: {
          service_order_id: orderId,
          credit_note_id: randomUUID(),
          site_id: siteAId,
          acknowledged_ref_ext: 'ERP-CN-missing',
          acknowledged_by: financeUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      financeHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
  });

  it('cross-site: a finance controller granted only at another site cannot dispose of this offcut', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const res = await dispose(
      orderId,
      {
        holding_id: holdingId,
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-cross`,
      },
      otherSiteHeaders,
    );
    assert.ok([403, 404].includes(res.status), JSON.stringify(res.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');
  });

  it('D5 (chunk D code review 2026-09-06): the direct events door meets every gate the route does - acquired pricing, the site sub-check, payload-site binding, the currency guards and the self-audited refusal codes', async () => {
    // 1. An `acquired` PRICED disposal through the door by a non-finance actor is refused by the
    //    finance gate. The chunk-C arm only tried `returned`; the priced branch is the whole point
    //    of the gate (minting owned stock and raising a credit note on a jobwork write grant alone).
    const priced = await retainedHolding({ quantity: '10' });
    const acquiredDoor = await postEvent(
      disposalEnvelope(
        priced.orderId,
        priced.holdingId,
        {
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        },
        { userId: ackUserId, role: 'accounts_officer' },
      ),
      ackHeaders,
    );
    assert.strictEqual(acquiredDoor.status, 403, JSON.stringify(acquiredDoor.body));
    assert.strictEqual(acquiredDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual((await holdingRow(priced.holdingId))['status'], 'retained');

    // 2. The finance gate's SITE sub-check through the door. A user who CAN write the site (jobwork
    //    write at site A - so the payload-site binding passes) but whose finance_controller grant is
    //    site-B-only must still be refused the valuation event: privilege and scope come from the
    //    SAME assignment (events.ts chunk-C comment). The pre-existing `otherSiteHeaders` fixture
    //    cannot reach this arm because its jobwork write grant is site-B-only too, so the door's
    //    payload-site binding fires first as LOCATION_ACCESS_DENIED.
    const financeOtherSiteUser = `jw-finance-other-site-9-7-${run}@example.com`;
    const financeOtherSiteUserId = await provisionUser(port, financeOtherSiteUser, [
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'write', locationId: siteAId },
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'read', locationId: siteAId },
      {
        role: 'finance_controller',
        module: 'jobwork',
        functionScope: 'write',
        locationId: siteBId,
      },
    ]);
    const financeOtherSiteHeaders = await authFor(port, financeOtherSiteUser);
    const otherSite = await retainedHolding({ quantity: '10' });
    const otherSiteDoor = await postEvent(
      disposalEnvelope(
        otherSite.orderId,
        otherSite.holdingId,
        {
          disposition: 'returned',
          return_challan_number_ext: `RCH-${run}-door-site`,
        },
        { userId: financeOtherSiteUserId, role: FINANCE_ROLE },
      ),
      financeOtherSiteHeaders,
    );
    assert.strictEqual(otherSiteDoor.status, 403, JSON.stringify(otherSiteDoor.body));
    assert.strictEqual(otherSiteDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual((await holdingRow(otherSite.holdingId))['status'], 'retained');

    // 3. Payload-site binding for a NON-valuation event: an acknowledgment naming site A, posted
    //    with a token whose jobwork write grant is site-B-only, is refused LOCATION_ACCESS_DENIED
    //    by the door's central gate before any applier runs.
    const binding = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: randomUUID(),
        event_type: 'jobwork.credit_note_acknowledged',
        payload: {
          service_order_id: randomUUID(),
          credit_note_id: randomUUID(),
          site_id: siteAId,
          acknowledged_ref_ext: `ERP-${run}-binding`,
          acknowledged_by: '00000000-0000-0000-0000-0000000000b5',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: '00000000-0000-0000-0000-0000000000b5',
            role: FINANCE_ROLE,
            location_id: siteBId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      otherSiteHeaders,
    );
    assert.strictEqual(binding.status, 403, JSON.stringify(binding.body));
    assert.strictEqual(binding.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // 4. The currency equality guards (P6) through the door: the applier refuses a disposal or a
    //    revaluation priced in a currency other than the order offcut currency.
    const currencyOrder = await invoicedOrderWithHolding({ offcutQty: '10' });
    const disposalCurrencyDoor = await postEvent(
      disposalEnvelope(currencyOrder.orderId, currencyOrder.holdingId, {
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'USD',
      }),
    );
    assert.strictEqual(disposalCurrencyDoor.status, 400, JSON.stringify(disposalCurrencyDoor.body));
    assert.strictEqual(disposalCurrencyDoor.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await holdingRow(currencyOrder.holdingId))['status'], 'retained');
    assert.strictEqual(
      (
        await dispose(currencyOrder.orderId, {
          holding_id: currencyOrder.holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const revaluationCurrencyDoor = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: currencyOrder.orderId,
        event_type: 'jobwork.offcut_revalued',
        payload: {
          service_order_id: currencyOrder.orderId,
          revaluation_id: randomUUID(),
          holding_id: currencyOrder.holdingId,
          site_id: siteAId,
          rate: '20.0000',
          currency: 'USD',
          posted_by: financeUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      financeHeaders,
    );
    assert.strictEqual(
      revaluationCurrencyDoor.status,
      400,
      JSON.stringify(revaluationCurrencyDoor.body),
    );
    assert.strictEqual(revaluationCurrencyDoor.body['error_code'], 'INVALID_PARAMS');

    // 5. CREDIT_NOTE_UNCITABLE through the door (no acknowledged billing feed), self-audited.
    const uncitable = await retainedHolding({ quantity: '10' });
    const uncitableDoor = await postEvent(
      disposalEnvelope(uncitable.orderId, uncitable.holdingId, {
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
      }),
    );
    assert.strictEqual(uncitableDoor.status, 409, JSON.stringify(uncitableDoor.body));
    assert.strictEqual(uncitableDoor.body['error_code'], 'CREDIT_NOTE_UNCITABLE');
    assert.ok(
      uncitableDoor.traceId && (await auditedFor('CREDIT_NOTE_UNCITABLE', uncitableDoor.traceId)),
    );

    // 6. OFFCUT_NOT_RETAINED through the door (a second disposal of the SAME row after a SUCCESSFUL
    //    first one), self-audited. The holding above is still retained (the UNCITABLE refusal rolled
    //    back), so a separate holding is used here.
    const twice = await retainedHolding({ quantity: '10' });
    const firstDisposal = await postEvent(
      disposalEnvelope(twice.orderId, twice.holdingId, {
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-d5-first`,
      }),
    );
    assert.strictEqual(firstDisposal.status, 201, JSON.stringify(firstDisposal.body));
    const secondDoor = await postEvent(
      disposalEnvelope(twice.orderId, twice.holdingId, {
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-d5-second`,
      }),
    );
    assert.strictEqual(secondDoor.status, 409, JSON.stringify(secondDoor.body));
    assert.strictEqual(secondDoor.body['error_code'], 'OFFCUT_NOT_RETAINED');
    assert.ok(secondDoor.traceId && (await auditedFor('OFFCUT_NOT_RETAINED', secondDoor.traceId)));

    // 7. CREDIT_NOTE_SUPERSEDED through the door (acknowledging the superseded original),
    //    self-audited; the CURRENT delta still acknowledges through the door.
    const superseded = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(superseded.orderId, {
          holding_id: superseded.holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    assert.strictEqual(
      (
        await revalue(superseded.orderId, {
          holding_id: superseded.holdingId,
          rate: '20.0000',
        })
      ).status,
      201,
    );
    const supersededNotes = await creditNotes(superseded.orderId);
    const supersededOriginal = supersededNotes[0]!['credit_note_id'] as string;
    const supersededDelta = supersededNotes[supersededNotes.length - 1]![
      'credit_note_id'
    ] as string;
    const staleDoor = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: superseded.orderId,
        event_type: 'jobwork.credit_note_acknowledged',
        payload: {
          service_order_id: superseded.orderId,
          credit_note_id: supersededOriginal,
          site_id: siteAId,
          acknowledged_ref_ext: `ERP-${run}-d5-stale`,
          acknowledged_by: ackUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: ackUserId, role: 'accounts_officer', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      ackHeaders,
    );
    assert.strictEqual(staleDoor.status, 409, JSON.stringify(staleDoor.body));
    assert.strictEqual(staleDoor.body['error_code'], 'CREDIT_NOTE_SUPERSEDED');
    assert.ok(staleDoor.traceId && (await auditedFor('CREDIT_NOTE_SUPERSEDED', staleDoor.traceId)));
    const currentDoor = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: superseded.orderId,
        event_type: 'jobwork.credit_note_acknowledged',
        payload: {
          service_order_id: superseded.orderId,
          credit_note_id: supersededDelta,
          site_id: siteAId,
          acknowledged_ref_ext: `ERP-${run}-d5-current`,
          acknowledged_by: ackUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: ackUserId, role: 'accounts_officer', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      ackHeaders,
    );
    // The events door answers 201 for a created event (the ROUTE answers 200); both acknowledge.
    assert.strictEqual(currentDoor.status, 201, JSON.stringify(currentDoor.body));
    assert.strictEqual(
      (await creditNotes(superseded.orderId))[supersededNotes.length - 1]!['status'],
      'acknowledged',
    );

    // 8. The revaluation finance gate on BOTH doors, and the revaluation posted_by identity pin
    //    (P4) on the door.
    const revalGate = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(revalGate.orderId, {
          holding_id: revalGate.holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const routeRevalGate = await revalue(
      revalGate.orderId,
      { holding_id: revalGate.holdingId, rate: '20.0000' },
      coordinatorHeaders,
    );
    assert.strictEqual(routeRevalGate.status, 403, JSON.stringify(routeRevalGate.body));
    assert.strictEqual(routeRevalGate.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const doorRevalGate = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: revalGate.orderId,
        event_type: 'jobwork.offcut_revalued',
        payload: {
          service_order_id: revalGate.orderId,
          revaluation_id: randomUUID(),
          holding_id: revalGate.holdingId,
          site_id: siteAId,
          rate: '20.0000',
          currency: 'INR',
          posted_by: coordinatorUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: COORDINATOR_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(doorRevalGate.status, 403, JSON.stringify(doorRevalGate.body));
    assert.strictEqual(doorRevalGate.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const doorRevalPin = await postEvent(
      {
        stream_type: 'jobwork',
        stream_id: revalGate.orderId,
        event_type: 'jobwork.offcut_revalued',
        payload: {
          service_order_id: revalGate.orderId,
          revaluation_id: randomUUID(),
          holding_id: revalGate.holdingId,
          site_id: siteAId,
          rate: '20.0000',
          currency: 'INR',
          posted_by: ackUserId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: financeUserId, role: FINANCE_ROLE, location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      financeHeaders,
    );
    assert.strictEqual(doorRevalPin.status, 403, JSON.stringify(doorRevalPin.body));
    assert.strictEqual(doorRevalPin.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('Task 7.2: a jobwork writer without the finance_controller role cannot value a disposal', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const res = await dispose(
      orderId,
      {
        holding_id: holdingId,
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-role`,
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.ok(res.traceId && (await auditedFor('FUNCTION_ACCESS_DENIED', res.traceId)));
  });

  it('AD-16: a retried disposal replays with the same id and posts nothing twice', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const key = randomUUID();
    const body = {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-retry`,
      location_id: dockId,
      idempotency_key: key,
    };
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      body,
      financeHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const retry = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      body,
      financeHeaders,
    );
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['event_id'], first.body['event_id']);
    const docs = await documentsFor(orderId);
    assert.strictEqual(docs.length, 4, 'a replay must not render a second document set');
  });

  it("D7 (chunk D code review 2026-09-06): an acknowledgment replays 200 after the caller's site-scoped grant moves, and a replay never answers 201", async () => {
    // Every fixture ack user is wildcard-scoped, so the isRetry short-circuit before the
    // 404-versus-403 site collapse was indistinguishable from a site check that happened to pass.
    // This arm uses a SITE-scoped accounts_officer, moves the grant away between the success and
    // the retry, and demands the replay still answers 200 about the STORED event (the action was
    // authorized when it committed - the ack handler's chunk-C comment).
    const scopedAckUser = `jw-ack-scoped-9-7-${run}@example.com`;
    const scopedAckUserId = await provisionUser(port, scopedAckUser, [
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'write', locationId: siteAId },
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'read', locationId: siteAId },
    ]);
    const scopedAckHeaders = await authFor(port, scopedAckUser);

    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const note = (await creditNotes(orderId))[0]!['credit_note_id'] as string;
    const key = randomUUID();
    const body = { idempotency_key: key, acknowledged_ref_ext: `ERP-${run}-grantmove` };
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/credit-notes/${note}/acknowledgment`,
      body,
      scopedAckHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    // The caller's write grant at the note's site is now gone (moved to the other site entirely).
    await getAdminPool().query(
      `UPDATE user_role_assignments SET location_id = $2
        WHERE user_id = $1 AND role = 'accounts_officer' AND module = 'jobwork' AND function_scope = 'write'`,
      [scopedAckUserId, siteBId],
    );

    // A FIRST submission would now hit the 404-versus-403 collapse; the RETRY must still replay the
    // stored event - and as 200, never 201 (a retry answers about an event that already exists).
    const retry = await makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/credit-notes/${note}/acknowledgment`,
      body,
      scopedAckHeaders,
    );
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['event_id'], first.body['event_id']);
    assert.strictEqual((await creditNotes(orderId))[0]!['status'], 'acknowledged');

    // Cleanup: a fresh, same-key ack attempt from ANOTHER person would be a different event target
    // semantics check; instead just restore nothing - the run-scoped user is discarded by the next
    // run. But prove the grant move actually took effect: a NEW acknowledgment from the scoped user
    // is now a 404 (site collapse), never a success.
    const freshKey = randomUUID();
    const afterMove = await makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/credit-notes/${note}/acknowledgment`,
      { idempotency_key: freshKey, acknowledged_ref_ext: `ERP-${run}-grantmove2` },
      scopedAckHeaders,
    );
    assert.strictEqual(afterMove.status, 404, JSON.stringify(afterMove.body));
  });

  it('GET offcut-holdings returns the ledger and its credit-note trail', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/offcut-holdings`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const holdings = res.body['holdings'] as Record<string, unknown>[];
    // D2 (chunk D code review 2026-09-06): prove the ledger is scoped to THIS order - a GET that
    // leaked another order's disposed row would satisfy a bare length/status check.
    assert.strictEqual(holdings.length, 1);
    assert.strictEqual(holdings[0]!['holding_id'], holdingId);
    assert.strictEqual(holdings[0]!['service_order_id'], orderId);
    assert.strictEqual(holdings[0]!['status'], 'disposed');
    assert.strictEqual((res.body['credit_notes'] as unknown[]).length, 1);
  });

  // -------------------------------------------------------------------------
  // Code review 2026-09-06: the patch regressions, each arm proving its new guard
  // -------------------------------------------------------------------------

  it('P2 (code review 2026-09-06): the clock reconcile the disposal absorbed is visible on the holding row', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-${randomUUID().slice(0, 6)}`,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'disposed');
    assert.strictEqual(row['clock_reconciled_qty'], '10.000');
  });

  it('D8 (chunk D code review 2026-09-06): an over-tolerance receipt makes the clock shortfall VISIBLE on the holding row', async () => {
    // Challan says 1000 but the GRN over-receives 1040 (inside the 5% tolerance, and the receiving
    // route COMMITS over-tolerance lines by design). The clock capacity is challan_qty = 1000, so a
    // 1030 KG holding can only reconcile 1000 of it - the residual 30 must be visible as
    // `quantity - clock_reconciled_qty` on the row the disposal wrote.
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, '1040', { challanQty: '1000' });
    const holdingId = await capture(orderId, lot, '1030');
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-${randomUUID().slice(0, 6)}`,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['status'], 'disposed');
    assert.strictEqual(row['quantity'], '1030.000');
    assert.strictEqual(row['clock_reconciled_qty'], '1000.000');
    const clock = await clockRow(orderId);
    assert.strictEqual(clock['reconciled_qty'], '1000.000');
  });

  it('D8 (chunk D code review 2026-09-06): two ACQUIRED disposals reusing one disposal_id collide on the QC-hold PK as DUPLICATE_EVENT', async () => {
    // The QC hold's PK is hold_id = disposal_id. Two acquired disposals on DIFFERENT holdings of the
    // same order reusing one disposal_id must classify the second as DUPLICATE_EVENT (409), never a
    // raw SQLSTATE 23505 500, and must roll back completely.
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    const { lot: lot2 } = await receive(orderId, '100');
    const holdingId2 = await capture(orderId, lot2, '10');
    const reusedDisposalId = randomUUID();
    const first = await postEvent(
      disposalEnvelope(orderId, holdingId, {
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
        disposal_id: reusedDisposalId,
      }),
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await postEvent(
      disposalEnvelope(orderId, holdingId2, {
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
        disposal_id: reusedDisposalId,
      }),
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((await holdingRow(holdingId2))['status'], 'retained');
    const notes = await creditNotes(orderId);
    assert.strictEqual(
      notes.length,
      1,
      'the collided disposal must not raise a second credit note',
    );
  });

  it('D8 (chunk D code review 2026-09-06): a positive rate whose computed value rounds to 0.0000 is a no-note acquisition, end to end', async () => {
    // P9 pins the gate in the unit suite; this is the END-TO-END shape. quantity 0.001 at rate
    // 0.0100 computes to 0.0000100 and rounds half-up to "0.0000" at the money scale, so the
    // acquisition mints the owned lot but raises NO credit note - the BSD-5 free-retention branch
    // must NOT be the only no-note path.
    const { orderId, holdingId } = await retainedHolding({ quantity: '0.001' });
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: '0.0100',
      currency: 'INR',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['disposition'], 'acquired');
    assert.strictEqual(row['disposal_rate'], '0.0100');
    assert.strictEqual(row['disposal_value'], '0.0000');
    assert.ok(
      row['owned_lot_id'],
      'a rounded-to-zero acquisition still transfers title and mints a lot',
    );
    assert.strictEqual(await stockOnHand(row['owned_lot_id'] as string, 'owned'), '0.001');
    assert.strictEqual(await stockOnHand(row['lot_id'] as string, 'offcut'), '0.000');
    assert.deepStrictEqual(await creditNotes(orderId), []);
  });

  it('D8 (chunk D code review 2026-09-06): acknowledging an EARLIER delta in a two-delta chain is refused CREDIT_NOTE_SUPERSEDED', async () => {
    // P8 stops at one revaluation: the original superseded by delta1. This arm proves the chain
    // closes - after delta2 supersedes delta1, acknowledging delta1 is refused too, and only the
    // CURRENT delta (delta2) acknowledges.
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    assert.strictEqual(
      (await revalue(orderId, { holding_id: holdingId, rate: '20.0000' })).status,
      201,
    );
    assert.strictEqual(
      (await revalue(orderId, { holding_id: holdingId, rate: '15.0000' })).status,
      201,
    );
    const notes = await creditNotes(orderId);
    const delta1 = notes[1]!['credit_note_id'] as string;
    const delta2 = notes[2]!['credit_note_id'] as string;
    assert.strictEqual(notes[2]!['supersedes_credit_note_id'], delta1);

    const staleDelta = await acknowledgeCreditNote(delta1);
    assert.strictEqual(staleDelta.status, 409, JSON.stringify(staleDelta.body));
    assert.strictEqual(staleDelta.body['error_code'], 'CREDIT_NOTE_SUPERSEDED');
    assert.ok(
      staleDelta.traceId && (await auditedFor('CREDIT_NOTE_SUPERSEDED', staleDelta.traceId)),
    );
    assert.strictEqual((await creditNotes(orderId))[1]!['status'], 'pending');

    const currentDelta = await acknowledgeCreditNote(delta2);
    assert.strictEqual(currentDelta.status, 200, JSON.stringify(currentDelta.body));
    assert.strictEqual((await creditNotes(orderId))[2]!['status'], 'acknowledged');
    assert.strictEqual((await creditNotes(orderId))[0]!['status'], 'pending');
  });

  it('D9 (chunk D code review 2026-09-06): the latest-document pointer wins over created_at ordering - a delta seeded with an EARLIER created_at is still the chaining base', async () => {
    // The chunk-B pointer fix (getLatestCreditNoteForHolding: the document nothing supersedes) was
    // indistinguishable from created_at ordering because revaluations always create deltas AFTER
    // their predecessor. Invert the two rows' created_at so the pointer and the clock disagree, and
    // assert the POINTER wins - both in the projection and in the observable next chain link.
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    assert.strictEqual(
      (await revalue(orderId, { holding_id: holdingId, rate: '20.0000' })).status,
      201,
    );
    let notes = await creditNotes(orderId);
    const original = notes[0]!['credit_note_id'] as string;
    const delta1 = notes[1]!['credit_note_id'] as string;
    // Invert: the original is now the LATEST-created row and delta1 the earliest.
    await getAdminPool().query(
      `UPDATE job_work_credit_note
          SET created_at = CASE credit_note_id
              WHEN $1 THEN now()
              WHEN $2 THEN now() - interval '1 day'
              ELSE created_at END
        WHERE credit_note_id IN ($1, $2)`,
      [original, delta1],
    );
    const client = await getAdminPool().connect();
    try {
      const latest = await getLatestCreditNoteForHolding(holdingId, client);
      assert.ok(latest, 'the projection must still resolve a latest document');
      assert.strictEqual(latest.credit_note_id, delta1);
    } finally {
      client.release();
    }

    // The observable consequence: the NEXT revaluation chains off delta1 (the pointer), never the
    // original (the later-created row). Reverting the projection to `ORDER BY created_at DESC`
    // makes this arm supersede the original and fail.
    assert.strictEqual(
      (await revalue(orderId, { holding_id: holdingId, rate: '15.0000' })).status,
      201,
    );
    notes = await creditNotes(orderId);
    assert.strictEqual(notes[2]!['supersedes_credit_note_id'], delta1);
  });

  it('P8 (code review 2026-09-06): acknowledging a SUPERSEDED credit note is refused CREDIT_NOTE_SUPERSEDED, and the current delta still acknowledges', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const notes0 = await creditNotes(orderId);
    const original = notes0[notes0.length - 1]!;
    assert.strictEqual(original['document_kind'], 'original');
    assert.strictEqual(
      (await revalue(orderId, { holding_id: holdingId, rate: '20.0000' })).status,
      201,
    );
    // The original is now superseded by the delta and must not be acknowledged as the current
    // document.
    const stale = await acknowledgeCreditNote(original['credit_note_id'] as string);
    assert.strictEqual(stale.status, 409, JSON.stringify(stale.body));
    assert.strictEqual(stale.body['error_code'], 'CREDIT_NOTE_SUPERSEDED');
    assert.ok(stale.traceId && (await auditedFor('CREDIT_NOTE_SUPERSEDED', stale.traceId)));
    const notes = await creditNotes(orderId);
    const delta = notes[notes.length - 1]!;
    assert.strictEqual(delta['document_kind'], 'delta');
    const ok = await acknowledgeCreditNote(delta['credit_note_id'] as string);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((await creditNotes(orderId))[notes.length - 1]!['status'], 'acknowledged');
  });

  it('P6 (code review 2026-09-06): a disposal priced in a currency other than the order offcut currency is refused', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'USD',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');
  });

  it('P6 (code review 2026-09-06): a revaluation in a currency other than the superseded document is refused', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(orderId, {
          holding_id: holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const res = await revalue(orderId, { holding_id: holdingId, rate: '20.0000', currency: 'USD' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['disposal_rate'], INDICATIVE_RATE);
    assert.strictEqual(row['disposal_currency'], 'INR');
  });

  it('P5 (code review 2026-09-06): a rate wider than NUMERIC(18,4) is refused cleanly, never a raw 22003 500', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: '999999999999999',
      currency: 'INR',
    });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');
  });

  it('P4 (code review 2026-09-06): a direct disposal naming somebody else as posted_by is refused FUNCTION_ACCESS_DENIED', async () => {
    const { orderId, holdingId } = await retainedHolding({ quantity: '10' });
    const forged = await postEvent(
      disposalEnvelope(orderId, holdingId, {
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-p4`,
        posted_by: ackUserId,
      }),
    );
    assert.strictEqual(forged.status, 403, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');
  });

  it('D6 (chunk D code review 2026-09-06): the three routes refuse out-of-scope body fields (allow-list, never accepted-but-ignored)', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    const badSite = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
      site_id: siteBId,
    });
    assert.strictEqual(badSite.status, 400, JSON.stringify(badSite.body));
    assert.strictEqual(badSite.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await holdingRow(holdingId))['status'], 'retained');

    const res = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const badReval = await revalue(orderId, {
      holding_id: holdingId,
      rate: '20.0000',
      disposition: 'returned',
    });
    assert.strictEqual(badReval.status, 400, JSON.stringify(badReval.body));
    assert.strictEqual(badReval.body['error_code'], 'INVALID_PARAMS');
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['disposal_rate'], INDICATIVE_RATE);

    const notes = await creditNotes(orderId);
    const original = notes[notes.length - 1]!;
    const badAck = await makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/credit-notes/${original['credit_note_id'] as string}/acknowledgment`,
      {
        idempotency_key: randomUUID(),
        acknowledged_ref_ext: `ERP-${run}-nope`,
        rate: '5.0000',
      },
      ackHeaders,
    );
    assert.strictEqual(badAck.status, 400, JSON.stringify(badAck.body));
    assert.strictEqual(badAck.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await creditNotes(orderId))[notes.length - 1]!['status'], 'pending');
  });

  it('D4 (chunk D code review 2026-09-06): an idempotency key reused for a DIFFERENT target is refused, never replayed against the wrong record', async () => {
    const { orderId, holdingId } = await invoicedOrderWithHolding({ offcutQty: '10' });
    const key = randomUUID();
    const first = await dispose(orderId, {
      holding_id: holdingId,
      disposition: 'acquired',
      rate: INDICATIVE_RATE,
      currency: 'INR',
      idempotency_key: key,
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const other = await retainedHolding({ quantity: '10' });
    const crossOrder = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${other.orderId}/offcut-disposals`,
      {
        location_id: dockId,
        idempotency_key: key,
        holding_id: other.holdingId,
        disposition: 'returned',
        return_challan_number_ext: `RCH-${run}-reuse`,
      },
      financeHeaders,
    );
    assert.strictEqual(crossOrder.status, 409, JSON.stringify(crossOrder.body));
    assert.strictEqual(crossOrder.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(crossOrder.body)['stored_service_order_id'], orderId);
    assert.strictEqual((await holdingRow(other.holdingId))['status'], 'retained');

    const otherNote = await invoicedOrderWithHolding({ offcutQty: '10' });
    assert.strictEqual(
      (
        await dispose(otherNote.orderId, {
          holding_id: otherNote.holdingId,
          disposition: 'acquired',
          rate: INDICATIVE_RATE,
          currency: 'INR',
        })
      ).status,
      201,
    );
    const noteOne = (await creditNotes(orderId))[0]!['credit_note_id'] as string;
    const noteTwo = (await creditNotes(otherNote.orderId))[0]!['credit_note_id'] as string;
    const ackKey = randomUUID();
    const ackOne = await makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/credit-notes/${noteOne}/acknowledgment`,
      { idempotency_key: ackKey, acknowledged_ref_ext: `ERP-${run}-cn1` },
      ackHeaders,
    );
    assert.strictEqual(ackOne.status, 200, JSON.stringify(ackOne.body));
    const ackTwo = await makeRequest(
      port,
      'POST',
      `/api/v1/jobwork/credit-notes/${noteTwo}/acknowledgment`,
      { idempotency_key: ackKey, acknowledged_ref_ext: `ERP-${run}-cn2` },
      ackHeaders,
    );
    assert.strictEqual(ackTwo.status, 409, JSON.stringify(ackTwo.body));
    assert.strictEqual(ackTwo.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((await creditNotes(otherNote.orderId))[0]!['status'], 'pending');
  });
});

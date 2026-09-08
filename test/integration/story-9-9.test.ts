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

/**
 * Story 9.9 Offcut Revaluation CFO Approval (closes deferred-work 9.8-2; FR-JW-12, FR-AC-11). Real
 * PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run serially;
 * every identifier is run-scoped. Fixture writes use the admin pool (app_user has no DELETE). The
 * harness scaffolding is a deliberate local re-implementation of the story-9-7 / story-9-8 closures
 * (never import cross-story).
 *
 * WHAT THIS STORY CHANGES. Story 9.8 made the second signature real on the offcut ACQUISITION path.
 * The REVALUATION path was left on the Story 9.7 contract, where `approved_by` was a string the
 * POSTER supplied and the seam merely compared against resolveApprover's output - so the only
 * barrier between a finance controller and their own second signature was not knowing the CFO's user
 * id, which is not a secret. This suite is the proof that an above-band revaluation is now PROPOSED
 * and executes nothing until the resolved `cfo` approves through their own session, and that there
 * is no request field left through which anybody can name an approver on either door.
 *
 * TWO SEPARATE REAL PEOPLE hold the segregated pair: `finance_controller` prices and proposes, `cfo`
 * signs, and neither is the acting coordinator.
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
const OFFCUT_ACQUISITION_TYPE = 'jobwork.offcut_acquisition';
/** The offcut contract's INDICATIVE rate, carried on the order. */
const INDICATIVE_RATE = '18.5000';
/** Above this value the CFO second signature is required. */
const DOA_BAND_MIN = 1000;
/** 10 KG offcut. The acquisition prices it at 185 (below band); the numbers below follow from it. */
const OFFCUT_QTY = '10';
const ACQUIRED_VALUE = '185.0000';
/** 10 x 150 = 1500, in the band: this revaluation must become a PROPOSAL. */
const ABOVE_BAND_RATE = '150.0000';
const ABOVE_BAND_VALUE = '1500.0000';
/** 10 x 20 = 200, below every band: this revaluation must still complete in ONE request. */
const BELOW_BAND_RATE = '20.0000';
const BELOW_BAND_VALUE = '200.0000';

describe('Story 9.9 Offcut Revaluation CFO Approval', () => {
  let server: Server;
  let port: number;

  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let financeUserId: string;
  let financeHeaders: Record<string, string>;
  let cfoUserId: string;
  let cfoHeaders: Record<string, string>;
  let otherFinanceUserId: string;
  let otherFinanceHeaders: Record<string, string>;
  let ackHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;

  let siteAId: string;
  let dockId: string;
  let kitBomId: string;
  let kitRevisionId: string;
  let outputItemId: string;
  let customerItemId: string;
  const characteristicIds: Record<string, string> = {};

  const TODAY = toIstCalendarDate(new Date());
  const CUSTOMER = `CUST-9-9-${RUN}`;
  const SKU = `SKU-CUST-9-9-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-9-9-${RUN}`;
  const OUTPUT_SKU = `SKU-OUT-9-9-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-9-${run}`;
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
    const poRef = `PO-JW-9-9-${run}-${poCounter}`;
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
       VALUES ($1, $2, $3, $4, 'site-A-9-9', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-9', 'MANUAL', $6, $7, $8)`,
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

  async function confirmedOrder(): Promise<string> {
    const orderId = await createDraftOrder();
    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/confirm`,
      {
        idempotency_key: randomUUID(),
        offcut_election: 'return',
        offcut_rate: INDICATIVE_RATE,
        offcut_currency: 'INR',
      },
      coordinatorHeaders,
    );
    assert.strictEqual(confirm.status, 200, `confirm failed: ${JSON.stringify(confirm.body)}`);
    return orderId;
  }

  async function receive(serviceOrderId: string, qty: string): Promise<{ lot: string }> {
    const poRef = await seedPo(SKU);
    const token = await seedToken(poRef);
    const lot = `LOT-JW-9-9-${run}-${randomUUID().slice(0, 6)}`;
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
    return { lot };
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
   * may be another suite's user. Resolve it the way the seam does rather than assuming this suite's
   * fixture wins (the 9.6 lesson), matching the BAND that governs the values used here and
   * asserting the role.
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
      { disposition: 'accept', justification: 'Story 9.9 dispatch fixture' },
      qcHeadHeaders,
    );
    assert.strictEqual(disp.status, 201, JSON.stringify(disp.body));
  }

  /**
   * An order whose service invoice ERP has acknowledged, with a RETAINED offcut holding row still
   * open. That acknowledged reference is what an acquisition credit note cites.
   */
  async function invoicedHolding(
    offcutQty: string = OFFCUT_QTY,
  ): Promise<{ orderId: string; holdingId: string }> {
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
    const holdingId = await capture(orderId, lot, offcutQty);
    return { orderId, holdingId };
  }

  /**
   * The whole fixture this story needs: an invoiced order whose offcut has been ACQUIRED below the
   * band in one request, so there is an `original` credit note to supersede.
   */
  async function acquiredHolding(): Promise<{
    orderId: string;
    holdingId: string;
    originalCreditNoteId: string;
  }> {
    const { orderId, holdingId } = await invoicedHolding();

    // 10 KG at 18.5 = 185, below the 1000 band: a single-request acquisition, exactly as Story 9.8
    // leaves it. This is what raises the `original` document every revaluation below supersedes.
    const disposed = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      {
        holding_id: holdingId,
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
        location_id: dockId,
        idempotency_key: randomUUID(),
      },
      financeHeaders,
    );
    assert.strictEqual(disposed.status, 201, JSON.stringify(disposed.body));
    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 1, 'the acquisition must raise exactly one original document');
    assert.strictEqual(notes[0]!['document_kind'], 'original');
    assert.strictEqual(notes[0]!['value'], ACQUIRED_VALUE);
    return { orderId, holdingId, originalCreditNoteId: notes[0]!['credit_note_id'] as string };
  }

  // ---- assertions ----

  async function holdingRow(holdingId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT holding_id, service_order_id, status, disposition, disposed_by,
              disposal_rate::text AS disposal_rate, indicative_rate::text AS indicative_rate,
              disposal_currency, disposal_value::text AS disposal_value, approved_by, doa_entry_id,
              clock_reconciled_qty::text AS clock_reconciled_qty, site_id
         FROM job_work_offcut_holding WHERE holding_id = $1`,
      [holdingId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function creditNotes(orderId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT credit_note_id, holding_id, document_kind, supersedes_credit_note_id,
              cited_invoice_ref_ext, rate::text AS rate, currency, value::text AS value,
              delta_value::text AS delta_value, status, valued_by
         FROM job_work_credit_note WHERE service_order_id = $1
        ORDER BY created_at ASC, credit_note_id ASC`,
      [orderId],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function proposalRow(proposalId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT proposal_id, service_order_id, holding_id, site_id, rate::text AS rate, currency,
              indicative_rate::text AS indicative_rate, proposed_value::text AS proposed_value,
              doa_entry_id, kind, supersedes_credit_note_id, resolved_approver_actor_id, proposed_by,
              status, decided_at, decided_by, disposal_event_id, revaluation_event_id
         FROM job_work_offcut_acquisition_proposal WHERE proposal_id = $1`,
      [proposalId],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function clockRow(orderId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT clock_id, challan_qty::text AS challan_qty, reconciled_qty::text AS reconciled_qty,
              loss_qty::text AS loss_qty, deemed_supply_qty::text AS deemed_supply_qty, status
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

  // -------------------------------------------------------------------------
  // Story 9.9 request helpers
  // -------------------------------------------------------------------------

  /** The revaluation route. An above-band posting comes back as a pending PROPOSAL. */
  async function revalue(
    orderId: string,
    body: Record<string, unknown>,
    opts: { headers?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-revaluations`,
      { currency: 'INR', idempotency_key: opts.idempotencyKey ?? randomUUID(), ...body },
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
      `/api/v1/service-orders/${orderId}/offcut-revaluation-proposals/${proposalId}/approve`,
      { idempotency_key: idempotencyKey },
      headers,
    );
  }

  function revaluationEnvelope(
    orderId: string,
    holdingId: string,
    extra: Record<string, unknown> = {},
    actor: { userId: string; role: string } = { userId: financeUserId, role: FINANCE_ROLE },
  ) {
    return {
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_revalued',
      payload: {
        service_order_id: orderId,
        revaluation_id: randomUUID(),
        holding_id: holdingId,
        site_id: siteAId,
        rate: BELOW_BAND_RATE,
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

  function revaluationProposalEnvelope(
    orderId: string,
    holdingId: string,
    extra: Record<string, unknown> = {},
    actor: { userId: string; role: string } = { userId: financeUserId, role: FINANCE_ROLE },
  ) {
    return {
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_revaluation_proposed',
      payload: {
        service_order_id: orderId,
        proposal_id: randomUUID(),
        holding_id: holdingId,
        site_id: siteAId,
        rate: ABOVE_BAND_RATE,
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

  function revaluationApprovalEnvelope(
    orderId: string,
    proposalId: string,
    extra: Record<string, unknown> = {},
    actor: { userId: string; role: string } = { userId: cfoUserId, role: CFO_ROLE },
  ) {
    return {
      stream_type: 'jobwork',
      stream_id: orderId,
      event_type: 'jobwork.offcut_revaluation_approved',
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

  /** Posts an above-band revaluation and returns the pending proposal's id. */
  async function proposeRevaluation(
    orderId: string,
    holdingId: string,
    opts: { rate?: string; headers?: Record<string, string>; idempotencyKey?: string } = {},
  ): Promise<HttpResult> {
    return revalue(
      orderId,
      { holding_id: holdingId, rate: opts.rate ?? ABOVE_BAND_RATE },
      {
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
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

    siteAId = await seedLocation('site', `SITE-A-9-9-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId);
    customerItemId = await seedItem(SKU);
    const companyItemId = await seedItem(SKU_COMPANY);

    coordinatorUserId = await provisionUser(port, `jw-coord-9-9-${run}@example.com`, [
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'custody', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coord-9-9-${run}@example.com`);

    // The finance controller who PRICES the offcut and the CFO who SIGNS the revaluation are two
    // different real users, and neither is the acting coordinator.
    financeUserId = await provisionUser(port, `jw-finance-9-9-${run}@example.com`, [
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: FINANCE_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    financeHeaders = await authFor(port, `jw-finance-9-9-${run}@example.com`);

    // A SECOND finance controller: the AC 3 "anyone else" who is neither the proposer nor the
    // resolved approver, but who does hold every role the routes require.
    otherFinanceUserId = await provisionUser(port, `jw-finance2-9-9-${run}@example.com`, [
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    otherFinanceHeaders = await authFor(port, `jw-finance2-9-9-${run}@example.com`);

    cfoUserId = await provisionUser(port, `jw-cfo-9-9-${run}@example.com`, [
      { role: CFO_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: CFO_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    cfoHeaders = await authFor(port, `jw-cfo-9-9-${run}@example.com`);

    await provisionUser(port, `jw-ack-9-9-${run}@example.com`, [
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'accounts_officer', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    ackHeaders = await authFor(port, `jw-ack-9-9-${run}@example.com`);

    await provisionUser(port, `jw-store-9-9-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-9-${run}@example.com`);

    await provisionUser(port, `qc-inspector-9-9-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-9-9-${run}@example.com`);

    await provisionUser(port, `qc-head-9-9-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-9-9-${run}@example.com`);

    await provisionUser(port, `compliance-9-9-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-9-9-${run}@example.com`);

    // BSD-9: the acquisition band - which the revaluation deliberately shares (Story 9.7 Task 5.5,
    // Story 9.9 design decision 4) - is DEDICATED to `cfo`. Seeding a second role under this
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
    const approver = await resolvedApprover(OFFCUT_ACQUISITION_TYPE, {
      value: DOA_BAND_MIN,
      role: CFO_ROLE,
    });
    cfoUserId = approver.userId;
    cfoHeaders = approver.headers;
    assert.notStrictEqual(cfoUserId, financeUserId, 'proposer and approver must be two people');
    assert.notStrictEqual(cfoUserId, otherFinanceUserId, 'the AC 3 outsider must not be the CFO');

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
  // AC 1: the proposal performs NOTHING
  // -------------------------------------------------------------------------

  it('AC 1: an above-band revaluation persists a PROPOSAL and changes nothing', async () => {
    const { orderId, holdingId, originalCreditNoteId } = await acquiredHolding();
    const before = await holdingRow(holdingId);
    const clockBefore = await clockRow(orderId);

    const proposed = await proposeRevaluation(orderId, holdingId);
    assert.strictEqual(proposed.status, 201, JSON.stringify(proposed.body));
    assert.strictEqual(proposed.body['status'], 'pending_approval');
    const proposalId = proposed.body['proposal_id'] as string;

    // The proposal row froze BOTH moving parts: who resolveApprover named, and the document the
    // delta will chain off.
    const row = await proposalRow(proposalId);
    assert.strictEqual(row['kind'], 'revaluation');
    assert.strictEqual(row['status'], 'pending');
    assert.strictEqual(row['rate'], ABOVE_BAND_RATE);
    assert.strictEqual(row['proposed_value'], ABOVE_BAND_VALUE);
    assert.strictEqual(row['proposed_by'], financeUserId);
    assert.strictEqual(row['resolved_approver_actor_id'], cfoUserId);
    assert.strictEqual(row['supersedes_credit_note_id'], originalCreditNoteId);
    assert.strictEqual(row['revaluation_event_id'], null);
    assert.strictEqual(row['disposal_event_id'], null);
    assert.ok(row['doa_entry_id'], 'the matched band entry is frozen too');

    // AC 1 is a statement about ABSENCE, so it is tested as one: no delta document, the holding
    // still carries the acquisition's value and rate, and the Section 143 clock has not moved.
    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 1, 'a proposal raises NO delta document');
    assert.strictEqual(notes[0]!['credit_note_id'], originalCreditNoteId);
    const after = await holdingRow(holdingId);
    assert.strictEqual(after['disposal_value'], ACQUIRED_VALUE);
    assert.strictEqual(after['disposal_rate'], INDICATIVE_RATE);
    assert.strictEqual(after['approved_by'], before['approved_by']);
    assert.strictEqual(after['doa_entry_id'], before['doa_entry_id']);
    assert.deepStrictEqual(await clockRow(orderId), clockBefore);

    // AC 7 read surface: the pending signature is visible, and says WHICH kind is waiting.
    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}/offcut-holdings`,
      undefined,
      financeHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const holdings = read.body['holdings'] as Record<string, unknown>[];
    const pending = holdings.find((h) => h['holding_id'] === holdingId)![
      'pending_approval'
    ] as Record<string, unknown> | null;
    assert.ok(pending, 'the pending revaluation must be visible on the holding read');
    assert.strictEqual(pending!['kind'], 'revaluation');
    assert.strictEqual(pending!['proposal_id'], proposalId);
  });

  // -------------------------------------------------------------------------
  // AC 2: the resolved approver's own authenticated request
  // -------------------------------------------------------------------------

  it('AC 2: the resolved CFO approving through their OWN session raises the delta', async () => {
    const { orderId, holdingId, originalCreditNoteId } = await acquiredHolding();
    const proposed = await proposeRevaluation(orderId, holdingId);
    assert.strictEqual(proposed.status, 201, JSON.stringify(proposed.body));
    const proposalId = proposed.body['proposal_id'] as string;

    const approved = await approveProposal(orderId, proposalId);
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));

    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 2, 'the approval raises exactly one delta');
    const delta = notes.find((n) => n['document_kind'] === 'delta')!;
    assert.strictEqual(delta['supersedes_credit_note_id'], originalCreditNoteId);
    assert.strictEqual(delta['value'], ABOVE_BAND_VALUE);
    // 1500 - 185. The delta is the signed difference against the document it supersedes.
    assert.strictEqual(delta['delta_value'], '1315.0000');
    assert.strictEqual(delta['rate'], ABOVE_BAND_RATE);
    // The document trail is immutable: the original is untouched by the correction.
    const original = notes.find((n) => n['document_kind'] === 'original')!;
    assert.strictEqual(original['value'], ACQUIRED_VALUE);
    assert.strictEqual(original['rate'], INDICATIVE_RATE);
    // valued_by stays the finance controller who priced it - the AC 6 SoD comparison depends on it.
    assert.strictEqual(delta['valued_by'], financeUserId);

    const row = await holdingRow(holdingId);
    assert.strictEqual(
      row['disposal_value'],
      ABOVE_BAND_VALUE,
      'the holding carries the new value',
    );
    assert.strictEqual(row['disposal_rate'], ABOVE_BAND_RATE);
    assert.strictEqual(row['approved_by'], cfoUserId, 'the approver is the CFO who signed');

    const proposal = await proposalRow(proposalId);
    assert.strictEqual(proposal['status'], 'approved');
    assert.strictEqual(proposal['decided_by'], cfoUserId);
    assert.ok(proposal['revaluation_event_id'], 'the approving event is recorded');
    assert.strictEqual(
      proposal['disposal_event_id'],
      null,
      'a revaluation must never write the acquisition event column (the lifecycle CHECK)',
    );
  });

  // -------------------------------------------------------------------------
  // AC 3: nobody else, on either door
  // -------------------------------------------------------------------------

  it('AC 3: anyone but the resolved approver - the proposer included - is refused and audited', async () => {
    const { orderId, holdingId } = await acquiredHolding();
    const proposed = await proposeRevaluation(orderId, holdingId);
    const proposalId = proposed.body['proposal_id'] as string;

    // MUTATION POINT: the frozen-approver comparison. Reverting it in the route or the applier
    // makes both of these pass and the second signature is gone.
    const outsider = await approveProposal(orderId, proposalId, otherFinanceHeaders);
    assert.strictEqual(outsider.status, 403, JSON.stringify(outsider.body));
    assert.strictEqual(outsider.body['error_code'], 'APPROVAL_REQUIRED');
    // The refusal never names the approver: the caller either is them or has no business knowing.
    assert.strictEqual(detailsOf(outsider.body)['resolved_approver_actor_id'], undefined);
    assert.strictEqual(detailsOf(outsider.body)['resolved_approver_user_id'], undefined);
    assert.ok(outsider.traceId && (await auditedFor('APPROVAL_REQUIRED', outsider.traceId)));

    const selfSigned = await approveProposal(orderId, proposalId, financeHeaders);
    assert.strictEqual(selfSigned.status, 403, JSON.stringify(selfSigned.body));
    assert.strictEqual(selfSigned.body['error_code'], 'APPROVAL_REQUIRED');
    assert.ok(selfSigned.traceId && (await auditedFor('APPROVAL_REQUIRED', selfSigned.traceId)));

    // The direct events door meets the same wall, under the order advisory lock.
    const viaEvent = await postEvent(
      revaluationApprovalEnvelope(
        orderId,
        proposalId,
        {},
        {
          userId: otherFinanceUserId,
          role: FINANCE_ROLE,
        },
      ),
      otherFinanceHeaders,
    );
    assert.strictEqual(viaEvent.status, 403, JSON.stringify(viaEvent.body));
    assert.strictEqual(viaEvent.body['error_code'], 'APPROVAL_REQUIRED');
    assert.ok(viaEvent.traceId && (await auditedFor('APPROVAL_REQUIRED', viaEvent.traceId)));

    // Nothing happened to the document trail through any of the three.
    assert.strictEqual((await creditNotes(orderId)).length, 1);
    assert.strictEqual((await proposalRow(proposalId))['status'], 'pending');

    // And a forged approved_by naming the CFO from somebody else's session cannot post at all: the
    // shape validator pins the field to the authenticated actor before the applier is reached.
    const forgedSession = await postEvent(
      revaluationApprovalEnvelope(
        orderId,
        proposalId,
        { approved_by: cfoUserId },
        { userId: otherFinanceUserId, role: FINANCE_ROLE },
      ),
      otherFinanceHeaders,
    );
    assert.strictEqual(forgedSession.status, 403, JSON.stringify(forgedSession.body));
    assert.strictEqual(forgedSession.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('AC 3 (dual control): a CFO who also held finance_controller cannot file a proposal only they could sign', async () => {
    const { orderId, holdingId } = await acquiredHolding();
    // The ROLES_SHARE_HOLDER shape `npm run verify:roles` refuses in production. The point of the
    // guard is that even that shape cannot post: dual control is the applier's own wall, on both
    // doors, and the route's finance gate must NOT be what stops a dual-role CFO - it would let
    // them through.
    const adminPool = getAdminPool();
    const grant = await adminPool.query(
      `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
       VALUES ($1, 'finance_controller', 'jobwork', 'write', '*')
       ON CONFLICT DO NOTHING
       RETURNING assignment_id`,
      [cfoUserId],
    );
    try {
      const dualRole = await resolvedApprover(OFFCUT_ACQUISITION_TYPE, { value: DOA_BAND_MIN });
      // MUTATION POINT: the propose-time dual-control check. Reverting it lets this post, and the
      // schema's chk_..._dual_control then refuses it as an unclassified 23514 500 instead.
      const res = await proposeRevaluation(orderId, holdingId, { headers: dualRole.headers });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
      assert.ok(res.traceId && (await auditedFor('APPROVAL_REQUIRED', res.traceId)));
      assert.strictEqual((await creditNotes(orderId)).length, 1, 'nothing was written');
    } finally {
      const assignmentId = grant.rows[0]?.['assignment_id'] as string | undefined;
      if (assignmentId) {
        await adminPool.query(`DELETE FROM user_role_assignments WHERE assignment_id = $1`, [
          assignmentId,
        ]);
      }
    }
  });

  // -------------------------------------------------------------------------
  // THE FORGERY ARM: the reason this story exists (Task 7.2)
  // -------------------------------------------------------------------------

  it('AC 3 (deferred-work 9.8-2): no request may name an approver on a revaluation, on EITHER door', async () => {
    const { orderId, holdingId } = await acquiredHolding();

    // THE DEFECT THIS STORY CLOSES. Under Story 9.7 this exact request succeeded: `approved_by` was
    // a string the poster supplied, checked only against resolveApprover's output, so a finance
    // controller who knew the CFO's user id signed their own revaluation. The id is named CORRECTLY
    // here - that is the point. Knowing it must no longer be worth anything.
    //
    // MUTATION POINT (route door): re-adding 'approved_by' to the revaluation route's callerFields
    // resurrects the whole hazard, and this half is what catches it.
    const claimed = await revalue(orderId, {
      holding_id: holdingId,
      rate: ABOVE_BAND_RATE,
      approved_by: cfoUserId,
    });
    assert.strictEqual(claimed.status, 400, JSON.stringify(claimed.body));
    assert.strictEqual(claimed.body['error_code'], 'INVALID_PARAMS');

    // MUTATION POINT (events door): the route allow-list and the applier's closed shape are TWO
    // different guards, and Story 8.6 proved a route-only guard passes a seam-only mutant. Restoring
    // 'approved_by' to REVALUATION_FIELDS is caught only by this half.
    const viaEvent = await postEvent(
      revaluationEnvelope(orderId, holdingId, {
        rate: ABOVE_BAND_RATE,
        approved_by: cfoUserId,
      }),
    );
    assert.strictEqual(viaEvent.status, 400, JSON.stringify(viaEvent.body));
    assert.strictEqual(viaEvent.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(viaEvent.body)['field'], 'approved_by');

    // A below-band revaluation cannot carry one either - the field simply does not exist.
    const belowBandClaim = await revalue(orderId, {
      holding_id: holdingId,
      rate: BELOW_BAND_RATE,
      approved_by: cfoUserId,
    });
    assert.strictEqual(belowBandClaim.status, 400, JSON.stringify(belowBandClaim.body));
    assert.strictEqual(belowBandClaim.body['error_code'], 'INVALID_PARAMS');

    // And the above-band revaluation cannot be posted as a PLAIN revaluation on the direct door to
    // skip the signature: the applier refuses it under the order lock and audits the refusal.
    //
    // MUTATION POINT: the above-band refusal in applyJobworkOffcutRevalued.
    const skipSignature = await postEvent(
      revaluationEnvelope(orderId, holdingId, { rate: ABOVE_BAND_RATE }),
    );
    assert.strictEqual(skipSignature.status, 403, JSON.stringify(skipSignature.body));
    assert.strictEqual(skipSignature.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(skipSignature.body)['revalued_value'], ABOVE_BAND_VALUE);
    assert.strictEqual(detailsOf(skipSignature.body)['resolved_approver_user_id'], undefined);
    assert.ok(
      skipSignature.traceId && (await auditedFor('APPROVAL_REQUIRED', skipSignature.traceId)),
    );
    assert.strictEqual((await creditNotes(orderId)).length, 1, 'nothing was written');
  });

  // -------------------------------------------------------------------------
  // AC 4: below the band, nothing changes
  // -------------------------------------------------------------------------

  it('AC 4: a below-band revaluation still completes in ONE request, unsigned', async () => {
    const { orderId, holdingId, originalCreditNoteId } = await acquiredHolding();
    const res = await revalue(orderId, { holding_id: holdingId, rate: BELOW_BAND_RATE });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['status'], undefined, 'a below-band revaluation is not pending');

    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 2);
    const delta = notes.find((n) => n['document_kind'] === 'delta')!;
    assert.strictEqual(delta['supersedes_credit_note_id'], originalCreditNoteId);
    assert.strictEqual(delta['value'], BELOW_BAND_VALUE);
    assert.strictEqual(delta['delta_value'], '15.0000');
    const row = await holdingRow(holdingId);
    assert.strictEqual(row['disposal_value'], BELOW_BAND_VALUE);
    assert.strictEqual(row['approved_by'], null, 'below every band there is no approval to record');
    assert.strictEqual(row['doa_entry_id'], null);

    // Both directions (the Story 9.8 symmetry): a below-band revaluation may not be PROPOSED
    // either, or a proposal would invent an approval step the governance never asked for.
    //
    // MUTATION POINT: the below-band refusal in applyJobworkOffcutRevaluationProposed.
    const proposedBelowBand = await postEvent(
      revaluationProposalEnvelope(orderId, holdingId, { rate: '5.0000' }),
    );
    assert.strictEqual(proposedBelowBand.status, 400, JSON.stringify(proposedBelowBand.body));
    assert.strictEqual(proposedBelowBand.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(proposedBelowBand.body)['revalued_value'], '50.0000');
  });

  // -------------------------------------------------------------------------
  // AC 5: the frozen document
  // -------------------------------------------------------------------------

  it('AC 5: approving against a document a later revaluation superseded is refused', async () => {
    const { orderId, holdingId, originalCreditNoteId } = await acquiredHolding();
    const proposed = await proposeRevaluation(orderId, holdingId);
    const proposalId = proposed.body['proposal_id'] as string;
    assert.strictEqual(
      (await proposalRow(proposalId))['supersedes_credit_note_id'],
      originalCreditNoteId,
    );

    // A BELOW-band revaluation needs no signature and lands between propose and approve. This is
    // deliberately NOT blocked: the whole premise of AC 5 is that the document can move.
    const between = await revalue(orderId, { holding_id: holdingId, rate: BELOW_BAND_RATE });
    assert.strictEqual(between.status, 201, JSON.stringify(between.body));
    const afterBetween = await creditNotes(orderId);
    assert.strictEqual(afterBetween.length, 2);

    // MUTATION POINT: the superseded-document check. Reverting it raises the proposed delta against
    // a document that is no longer the latest - arithmetically right about the wrong document, and
    // the running correction is silently corrupted.
    const approved = await approveProposal(orderId, proposalId);
    assert.strictEqual(approved.status, 409, JSON.stringify(approved.body));
    assert.strictEqual(approved.body['error_code'], 'CREDIT_NOTE_SUPERSEDED');
    assert.strictEqual(
      detailsOf(approved.body)['proposed_against_credit_note_id'],
      originalCreditNoteId,
    );
    assert.ok(approved.traceId && (await auditedFor('CREDIT_NOTE_SUPERSEDED', approved.traceId)));

    // No delta was raised by the refused approval, and the holding still carries the below-band
    // value the intervening revaluation set.
    assert.deepStrictEqual(await creditNotes(orderId), afterBetween);
    assert.strictEqual((await holdingRow(holdingId))['disposal_value'], BELOW_BAND_VALUE);
    assert.strictEqual((await proposalRow(proposalId))['status'], 'pending');

    // DISCLOSED GAP, asserted so it cannot change silently. The stale proposal still holds the
    // holding's ONE pending slot, and Story 9.8 reserved the `superseded` status for a withdrawal
    // path that nothing writes yet - so this offcut cannot be re-proposed at all until such a path
    // exists. The refusal message above is worded not to promise otherwise. Recorded as deferred
    // work; closing it is a governance question (who may withdraw a pending signature request),
    // not a transcription fix.
    const again = await proposeRevaluation(orderId, holdingId);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(
      again.body['error_code'],
      'DUPLICATE_EVENT',
      'the stale proposal still holds the one pending slot, and no withdrawal path exists yet',
    );
  });

  // -------------------------------------------------------------------------
  // AC 6: idempotency on every path
  // -------------------------------------------------------------------------

  it('AC 6: propose, approve and the below-band revaluation all replay against the stored event', async () => {
    const { orderId, holdingId } = await acquiredHolding();

    const proposeKey = randomUUID();
    const first = await proposeRevaluation(orderId, holdingId, { idempotencyKey: proposeKey });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const proposalId = first.body['proposal_id'] as string;
    const replayed = await proposeRevaluation(orderId, holdingId, { idempotencyKey: proposeKey });
    assert.strictEqual(replayed.status, 200, JSON.stringify(replayed.body));
    assert.strictEqual(replayed.body['event_id'], first.body['event_id']);
    assert.strictEqual(replayed.body['proposal_id'], proposalId);
    assert.strictEqual(replayed.body['status'], 'pending_approval');

    const approveKey = randomUUID();
    const approved = await approveProposal(orderId, proposalId, cfoHeaders, approveKey);
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    // The pre-checks run on the FRESH request only: on a replay the row is already approved, and
    // AD-16 demands the retry answer against the STORED event rather than being refused by them.
    const approveReplay = await approveProposal(orderId, proposalId, cfoHeaders, approveKey);
    assert.strictEqual(approveReplay.status, 200, JSON.stringify(approveReplay.body));
    assert.strictEqual(approveReplay.body['event_id'], approved.body['event_id']);
    assert.strictEqual((await creditNotes(orderId)).length, 2, 'the replay raised no second delta');

    // A key reused for a DIFFERENT proposal is a client bug, not a success about a proposal the
    // caller never approved.
    const other = await acquiredHolding();
    const otherProposal = await proposeRevaluation(other.orderId, other.holdingId);
    const crossed = await approveProposal(
      other.orderId,
      otherProposal.body['proposal_id'] as string,
      cfoHeaders,
      approveKey,
    );
    assert.strictEqual(crossed.status, 409, JSON.stringify(crossed.body));
    assert.strictEqual(crossed.body['error_code'], 'DUPLICATE_EVENT');

    // And the below-band single-request path replays too.
    const belowKey = randomUUID();
    const below = await revalue(
      other.orderId,
      { holding_id: other.holdingId, rate: BELOW_BAND_RATE },
      { idempotencyKey: belowKey },
    );
    assert.strictEqual(below.status, 201, JSON.stringify(below.body));
    const belowReplay = await revalue(
      other.orderId,
      { holding_id: other.holdingId, rate: BELOW_BAND_RATE },
      { idempotencyKey: belowKey },
    );
    assert.strictEqual(belowReplay.status, 200, JSON.stringify(belowReplay.body));
    assert.strictEqual(belowReplay.body['event_id'], below.body['event_id']);
  });

  // -------------------------------------------------------------------------
  // The kind discriminator: one table, two signatures, no crossing over
  // -------------------------------------------------------------------------

  it('the two proposal kinds cannot be approved through each other route', async () => {
    const { orderId, holdingId } = await acquiredHolding();
    const proposed = await proposeRevaluation(orderId, holdingId);
    const proposalId = proposed.body['proposal_id'] as string;

    // The ACQUISITION approve route must not reach a revaluation proposal: its applier runs the
    // disposal effects, minting a lot and transferring title on a holding disposed of long ago.
    const wrongRoute = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-acquisition-proposals/${proposalId}/approve`,
      { idempotency_key: randomUUID() },
      cfoHeaders,
    );
    assert.strictEqual(wrongRoute.status, 404, JSON.stringify(wrongRoute.body));
    assert.strictEqual(wrongRoute.body['error_code'], 'NOT_FOUND');

    // Same on the direct events door, where there is no route to pick the wrong one for you.
    const wrongEvent = await postEvent(
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
          occurred_at: new Date().toISOString(),
        },
      },
      cfoHeaders,
    );
    assert.strictEqual(wrongEvent.status, 404, JSON.stringify(wrongEvent.body));
    assert.strictEqual(wrongEvent.body['error_code'], 'NOT_FOUND');
    assert.strictEqual((await proposalRow(proposalId))['status'], 'pending');
    assert.strictEqual((await creditNotes(orderId)).length, 1);

    // THE OTHER DIRECTION, and the one with teeth: an ACQUISITION proposal reached through the
    // REVALUATION door. 100 KG at 18.5 = 1850, above the band, so the disposal route answers with a
    // pending acquisition proposal on a still-RETAINED holding. Approving that as a revaluation
    // would raise a delta against an offcut whose title has not transferred and which has no
    // document at all.
    //
    // MUTATION POINT: the kind guard in applyJobworkOffcutRevaluationApproved. Nothing else in this
    // suite reaches it - the arm above is caught by the acquisition applier's own guard.
    const acq = await invoicedHolding('100');
    const acqProposed = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${acq.orderId}/offcut-disposals`,
      {
        holding_id: acq.holdingId,
        disposition: 'acquired',
        rate: INDICATIVE_RATE,
        currency: 'INR',
        location_id: dockId,
        idempotency_key: randomUUID(),
      },
      financeHeaders,
    );
    assert.strictEqual(acqProposed.status, 201, JSON.stringify(acqProposed.body));
    assert.strictEqual(acqProposed.body['status'], 'pending_approval');
    const acqProposalId = acqProposed.body['proposal_id'] as string;
    assert.strictEqual((await proposalRow(acqProposalId))['kind'], 'acquisition');

    const wrongRouteBack = await approveProposal(acq.orderId, acqProposalId);
    assert.strictEqual(wrongRouteBack.status, 404, JSON.stringify(wrongRouteBack.body));
    assert.strictEqual(wrongRouteBack.body['error_code'], 'NOT_FOUND');

    const wrongEventBack = await postEvent(
      revaluationApprovalEnvelope(acq.orderId, acqProposalId),
      cfoHeaders,
    );
    assert.strictEqual(wrongEventBack.status, 404, JSON.stringify(wrongEventBack.body));
    assert.strictEqual(wrongEventBack.body['error_code'], 'NOT_FOUND');

    // The acquisition proposal is untouched and its holding is still the customer's.
    assert.strictEqual((await proposalRow(acqProposalId))['status'], 'pending');
    assert.strictEqual((await holdingRow(acq.holdingId))['status'], 'retained');
    assert.strictEqual((await creditNotes(acq.orderId)).length, 0);
  });

  it('the events door enforces the finance gate on propose and the identity gate on approve', async () => {
    const { orderId, holdingId } = await acquiredHolding();

    // The proposer must hold finance_controller - the route gate has an events-door twin.
    const notFinance = await postEvent(
      revaluationProposalEnvelope(
        orderId,
        holdingId,
        {},
        {
          userId: coordinatorUserId,
          role: COORDINATOR_ROLE,
        },
      ),
      coordinatorHeaders,
    );
    assert.strictEqual(notFinance.status, 403, JSON.stringify(notFinance.body));
    assert.strictEqual((await creditNotes(orderId)).length, 1);

    // posted_by must BE the authenticated actor: proposed_by is stamped from it and the dual-control
    // comparison is made against it, so a forged value would let one person propose in another name.
    const forgedPoster = await postEvent(
      revaluationProposalEnvelope(orderId, holdingId, { posted_by: otherFinanceUserId }),
    );
    assert.strictEqual(forgedPoster.status, 403, JSON.stringify(forgedPoster.body));
    assert.strictEqual(forgedPoster.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // A proposal naming a derived field is refused: the server owns every one of them.
    const claimedDerived = await postEvent(
      revaluationProposalEnvelope(orderId, holdingId, {
        supersedes_credit_note_id: randomUUID(),
      }),
    );
    assert.strictEqual(claimedDerived.status, 400, JSON.stringify(claimedDerived.body));
    assert.strictEqual(claimedDerived.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(claimedDerived.body)['field'], 'supersedes_credit_note_id');

    // The proposal itself still works from the events door when it is posted honestly.
    const honest = await postEvent(revaluationProposalEnvelope(orderId, holdingId));
    assert.strictEqual(honest.status, 201, JSON.stringify(honest.body));
    assert.strictEqual((await creditNotes(orderId)).length, 1, 'a proposal writes no document');
  });

  it('the events door can run the WHOLE two-step flow: a door propose and a door approve', async () => {
    // Story 9.9 code review (2026-09-09): the door tests above pinned only the REFUSALS on the
    // direct events door. The success arms are what guarantee the door's appliers (not the route
    // helpers) freeze the resolved approver and the superseded document, and that a door-posted
    // approval executes the same delta the route approval does - the seam that shipped one wrong
    // event type and a missing finance gate earlier in this story.
    const { orderId, holdingId, originalCreditNoteId } = await acquiredHolding();

    // Propose through the direct door. The applier derives every server-owned field; the frozen row
    // is the one the CFO's own session later signs.
    const proposed = await postEvent(revaluationProposalEnvelope(orderId, holdingId));
    assert.strictEqual(proposed.status, 201, JSON.stringify(proposed.body));
    const row = await getAdminPool().query(
      `SELECT proposal_id, kind, status, proposed_by, resolved_approver_actor_id,
              supersedes_credit_note_id, proposed_value::text AS proposed_value,
              revaluation_event_id, disposal_event_id
         FROM job_work_offcut_acquisition_proposal WHERE holding_id = $1`,
      [holdingId],
    );
    assert.strictEqual(row.rows.length, 1, 'the door propose wrote exactly one proposal row');
    const frozen = row.rows[0] as Record<string, unknown>;
    assert.strictEqual(frozen['kind'], 'revaluation');
    assert.strictEqual(frozen['status'], 'pending');
    assert.strictEqual(frozen['proposed_by'], financeUserId);
    assert.strictEqual(frozen['resolved_approver_actor_id'], cfoUserId);
    assert.strictEqual(frozen['supersedes_credit_note_id'], originalCreditNoteId);
    assert.strictEqual(frozen['proposed_value'], ABOVE_BAND_VALUE);
    assert.strictEqual(frozen['revaluation_event_id'], null);
    const proposalId = frozen['proposal_id'] as string;

    // Approve through the direct door with the CFO's own session: the delta is executed.
    const approved = await postEvent(revaluationApprovalEnvelope(orderId, proposalId), cfoHeaders);
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    const notes = await creditNotes(orderId);
    assert.strictEqual(notes.length, 2, 'the door approval raises exactly one delta');
    const delta = notes.find((n) => n['document_kind'] === 'delta')!;
    assert.strictEqual(delta['supersedes_credit_note_id'], originalCreditNoteId);
    assert.strictEqual(delta['delta_value'], '1315.0000');
    assert.strictEqual(delta['valued_by'], financeUserId, 'the pricer stays the proposer');

    const holding = await holdingRow(holdingId);
    assert.strictEqual(holding['disposal_value'], ABOVE_BAND_VALUE);
    assert.strictEqual(holding['approved_by'], cfoUserId);

    const decided = await proposalRow(proposalId);
    assert.strictEqual(decided['status'], 'approved');
    assert.strictEqual(decided['decided_by'], cfoUserId);
    assert.ok(decided['revaluation_event_id'], 'the door approval recorded its event id');
    assert.strictEqual(decided['disposal_event_id'], null);
  });

  it('a proposal is never raised for a revaluation that could not have succeeded', async () => {
    // The proposal applier runs every precondition the revaluation applier runs BEFORE writing the
    // row, so a pending signature can never sit on an offcut whose revaluation would be refused.
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, '100');
    const holdingId = await capture(orderId, lot, OFFCUT_QTY);

    // Still RETAINED: there is nothing to revalue until a disposal has priced it.
    const notDisposed = await postEvent(revaluationProposalEnvelope(orderId, holdingId));
    assert.strictEqual(notDisposed.status, 400, JSON.stringify(notDisposed.body));
    assert.strictEqual(notDisposed.body['error_code'], 'INVALID_PARAMS');

    // A free retention was acquired at rate zero and raised NO document, so there is nothing to
    // supersede - CREDIT_NOTE_MISSING, refused at PROPOSE time rather than discovered at approve.
    const free = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      {
        holding_id: holdingId,
        disposition: 'acquired',
        rate: '0.0000',
        currency: 'INR',
        location_id: dockId,
        idempotency_key: randomUUID(),
      },
      financeHeaders,
    );
    assert.strictEqual(free.status, 201, JSON.stringify(free.body));
    const noDocument = await postEvent(revaluationProposalEnvelope(orderId, holdingId));
    assert.strictEqual(noDocument.status, 409, JSON.stringify(noDocument.body));
    assert.strictEqual(noDocument.body['error_code'], 'CREDIT_NOTE_MISSING');
    assert.ok(noDocument.traceId && (await auditedFor('CREDIT_NOTE_MISSING', noDocument.traceId)));

    const proposals = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM job_work_offcut_acquisition_proposal WHERE holding_id = $1`,
      [holdingId],
    );
    assert.strictEqual(proposals.rows[0]!['n'], 0, 'no proposal row was written by either refusal');
  });

  it('a revaluation proposal priced in another currency than the superseded document is refused', async () => {
    const { orderId, holdingId } = await acquiredHolding();
    const res = await postEvent(
      revaluationProposalEnvelope(orderId, holdingId, { currency: 'USD' }),
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual((await creditNotes(orderId)).length, 1);
  });
});

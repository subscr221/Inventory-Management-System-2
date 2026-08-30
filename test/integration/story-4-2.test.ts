import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { businessDaysBetween, toIstCalendarDate } from '../../src/lib/business-days.js';
import { config } from '../../src/config/index.js';

// Story 4.2: Supplier Performance Scorecards. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, and PostgreSQL - no mocks of the DB or the event store.
// The harness is the Story 4.5 union (3.4 receiving + 4.4 PO + 4.7 invoice + 4.5 match) because
// the scorecard CONSUMES that substrate: every metric here is derived from fixtures seeded
// through the real upstream routes. NUMERIC values are asserted as strings; DATE via ::text.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

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
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 4.2 Supplier Performance Scorecards Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteAId = randomUUID();
  const qcZoneId = randomUUID();
  const dockId = randomUUID();

  let officerHeaders: Record<string, string>;
  let deptHeadHeaders: Record<string, string>;
  let requesterHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let supervisorId: string;
  let officerId: string;
  let supplierId: string;
  let indentSeq = 0;

  /** Bypasses the route handlers entirely - the direct event surface every seam guard must cover. */
  async function directEvent(
    streamId: string,
    payload: Record<string, unknown>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: streamId,
        event_type: 'supplier_scorecard.metric_recorded',
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: officerId,
            role: 'procurement_officer_4_2',
            location_id: siteAId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      officerHeaders,
    );
  }

  function metricPayload(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      metric_id: randomUUID(),
      supplier_id: supplierId,
      metric_kind: 'on_time_delivery',
      reference_event_id: randomUUID(),
      reference_entity_id: randomUUID(),
      value_num: '1.000000',
      context: { received_date: '2026-07-23', promised_delivery_date: '2026-07-22' },
      business_date: '2026-07-23',
      ...overrides,
    };
  }

  /**
   * Builds a seam-valid responsiveness payload by re-deriving every enforced field from the
   * governed projections - the same derivation the compliance seam performs. Direct-event tests
   * must carry derived values because the seam re-derives and rejects any disagreement.
   */
  async function derivedResponsivenessPayload(
    poId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const poRow = (
      await getAdminPool().query(
        `SELECT supplier_id, issued_at, confirmed_at FROM purchase_order WHERE po_id = $1`,
        [poId],
      )
    ).rows[0] as Record<string, unknown>;
    const evRow = (
      await getAdminPool().query(
        `SELECT event_id FROM domain_events
         WHERE stream_id = $1 AND event_type = 'purchase_order.confirmed'
         ORDER BY event_version DESC LIMIT 1`,
        [poId],
      )
    ).rows[0] as Record<string, unknown>;
    const issuedAt = new Date(poRow['issued_at'] as string | Date);
    const confirmedAt = new Date(poRow['confirmed_at'] as string | Date);
    const businessDays = businessDaysBetween(
      issuedAt,
      confirmedAt,
      config.scorecard.responsivenessHolidayCalendar,
    );
    return {
      metric_id: randomUUID(),
      supplier_id: poRow['supplier_id'],
      metric_kind: 'responsiveness',
      reference_event_id: evRow['event_id'],
      reference_entity_id: poId,
      value_num: `${businessDays}.000000`,
      context: { issued_at: issuedAt.toISOString(), confirmed_at: confirmedAt.toISOString() },
      business_date: toIstCalendarDate(confirmedAt),
      ...overrides,
    };
  }

  function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  interface PoFixture {
    poId: string;
    poLineId: string;
    sku: string;
    poRefExt: string;
  }

  // -------------------------------------------------------------------------
  // Fixtures (Story 3.4 / 4.1 / 4.3 / 4.4 / 4.5 / 4.7 real routes)
  // -------------------------------------------------------------------------

  async function seedItem(sku: string): Promise<void> {
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat,
                                quarantine_required, bis_licence_required, valuation_method,
                                business_stream, status)
       VALUES ($1, 'KG', false, false, false, false, false, 'weighted_average', 'production', 'active')
       ON CONFLICT (sku) DO NOTHING`,
      [sku],
    );
  }

  async function seedErpPo(poRefExt: string, sku: string, orderedQty: number): Promise<void> {
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency,
                                       expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-42', 'INR', '2026-12-01', 'open', 'ERP', now())`,
      [poRefExt],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty,
                                            unit_price, over_receipt_tolerance_pct,
                                            under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, $3, $3, 500, 10, 10, 'ERP', now())`,
      [poRefExt, sku, orderedQty],
    );
  }

  async function seedToken(poRefExt: string): Promise<string> {
    const token = randomUUID();
    await getPool().query(
      `INSERT INTO weighbridge_event
        (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext,
         line_no, tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by,
         business_date, source_event_id)
       VALUES ($1, $2, $3, $4, 'site-A', $5, 1, 1000, 1100, 100, 'accepted', 'WB-42', 'MANUAL', $6,
               '2026-07-23', $7)`,
      [randomUUID(), token, randomUUID(), siteAId, poRefExt, supervisorId, randomUUID()],
    );
    return token;
  }

  async function createApprovedIndent(sku: string): Promise<string> {
    indentSeq += 1;
    const raiseRes = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      {
        department_code: 'PROD',
        site_id: siteAId,
        business_stream: 'production',
        need_by_date: '2026-12-01',
        urgent: false,
        lines: [
          {
            sku: `${sku}-IND-${indentSeq}`,
            item_category: 'raw_materials',
            requested_qty: 100,
            uom: 'KG',
            unit_price_estimate: 500,
          },
        ],
      },
      requesterHeaders,
    );
    assert.strictEqual(raiseRes.status, 201, JSON.stringify(raiseRes.body));
    const indentId = (raiseRes.body['indent'] as Record<string, unknown>)['indent_id'] as string;
    const approveRes = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    return indentId;
  }

  /** Drafts, approves and issues a native PO, and seeds its ERP receiving reference. */
  async function createIssuedPo(tag: string): Promise<PoFixture> {
    const sku = `SKU-42-${tag}-${run}`;
    const poRefExt = `PO-42-${tag}-${run}`;
    await seedItem(sku);
    const indentId = await createApprovedIndent(sku);
    const draftRes = await makeRequest(
      port,
      'POST',
      '/api/v1/purchase-orders',
      {
        indent_id: indentId,
        supplier_id: supplierId,
        po_type: 'standard',
        lines: [
          { sku, item_category: 'raw_materials', ordered_qty: 100, uom: 'KG', unit_price: 500 },
        ],
      },
      officerHeaders,
    );
    assert.strictEqual(draftRes.status, 201, JSON.stringify(draftRes.body));
    const po = draftRes.body['purchase_order'] as Record<string, unknown>;
    const poId = po['po_id'] as string;
    if (po['status'] === 'pending-approval') {
      const approveRes = await makeRequest(
        port,
        'POST',
        `/api/v1/purchase-orders/${poId}/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    }
    const issueRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/issue`,
      {},
      officerHeaders,
    );
    assert.strictEqual(issueRes.status, 200, JSON.stringify(issueRes.body));
    const poLineId = (draftRes.body['lines'] as Record<string, unknown>[])[0]![
      'po_line_id'
    ] as string;
    await seedErpPo(poRefExt, sku, 100);
    return { poId, poLineId, sku, poRefExt };
  }

  async function confirmPo(poId: string, promisedDate: string): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poId}/confirm`,
      { promised_delivery_date: promisedDate },
      officerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  /** Physical receipt through Story 3.4's real capture route, then 4.5's native PO binding. */
  async function receiveAndBind(po: PoFixture, receivedQty: number): Promise<string> {
    const token = await seedToken(po.poRefExt);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: token,
        po_ref_ext: po.poRefExt,
        line_no: 1,
        source_document: 'PO',
        sku: po.sku,
        target_location_code: 'RECV-DOCK',
        received_qty: receivedQty,
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const grnId = ((res.body['grn'] as Record<string, unknown>)['grn_id'] as string)!;
    const link = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/link-po`,
      { po_id: po.poId },
      officerHeaders,
    );
    assert.strictEqual(link.status, 201, JSON.stringify(link.body));
    return grnId;
  }

  /** Captures a PO-backed invoice and runs the 4.5 match. Returns the match id. */
  async function captureAndMatch(
    po: PoFixture,
    tag: string,
    quantity: number,
    unitPrice: number,
  ): Promise<string> {
    const lineTotal = Number((quantity * unitPrice).toFixed(2));
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/supplier-invoices',
      {
        supplier_id: supplierId,
        invoice_number_ext: `INV-42-${tag}-${run}`,
        invoice_date: '2026-07-25',
        po_id: po.poId,
        currency: 'INR',
        lines: [
          {
            po_line_id: po.poLineId,
            sku: po.sku,
            quantity,
            uom: 'KG',
            unit_price: unitPrice,
            taxable_value: lineTotal,
            line_total: lineTotal,
          },
        ],
        subtotal: lineTotal,
        total_value: lineTotal,
      },
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const invoiceId = (res.body['supplier_invoice'] as Record<string, unknown>)[
      'invoice_id'
    ] as string;
    const matchRes = await makeRequest(
      port,
      'POST',
      '/api/v1/three-way-match/run',
      { invoice_id: invoiceId },
      officerHeaders,
    );
    assert.strictEqual(matchRes.status, 201, JSON.stringify(matchRes.body));
    return matchRes.body['match_id'] as string;
  }

  async function metricRows(
    metricKind: string,
    referenceEntityId?: string,
  ): Promise<Record<string, unknown>[]> {
    const conditions = ['supplier_id = $1', 'metric_kind = $2'];
    const values: unknown[] = [supplierId, metricKind];
    if (referenceEntityId) {
      conditions.push('reference_entity_id = $3');
      values.push(referenceEntityId);
    }
    const r = await getAdminPool().query(
      `SELECT metric_id, value_num::text AS value_num, business_date::text AS business_date,
              context, reference_event_id, supersedes_metric_id, recorded_by
       FROM supplier_scorecard_metric
       WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at ASC`,
      values,
    );
    return r.rows as Record<string, unknown>[];
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
      '../../read/projections/ownership_agreement.sql',
      '../../read/projections/erp_purchase_order.sql',
      '../../read/projections/erp_sales_order.sql',
      '../../read/projections/integration_exception.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/putaway_task.sql',
      '../../read/projections/asn.sql',
      '../../read/projections/asn_line.sql',
      '../../read/projections/supplier.sql',
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
      '../../read/projections/purchase_order.sql',
      '../../read/projections/purchase_order_line.sql',
      '../../read/projections/po_outbound_message.sql',
      '../../read/projections/supplier_invoice.sql',
      '../../read/projections/supplier_invoice_line.sql',
      '../../read/projections/supplier_invoice_ingestion.sql',
      '../../read/projections/msme_ageing_feed.sql',
      '../../read/projections/three_way_match.sql',
      '../../read/projections/payment_clearance_feed.sql',
      '../../read/projections/supplier_scorecard_metric.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE supplier_scorecard_metric, payment_clearance_feed, three_way_match, msme_ageing_feed, supplier_invoice_line, supplier_invoice_ingestion, supplier_invoice, po_outbound_message, purchase_order_line, purchase_order, indent_line, indent, supplier, asn_line, asn, putaway_task, grn_line, grn, weighbridge_event, gate_event, integration_exception, erp_purchase_order_line, erp_purchase_order, erp_sales_order, ownership_agreement, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id,
                                      site_id, zone_type, temperature_class, quarantine, status)
       VALUES
         ($1, 'site-A', 'site', NULL, $1, 'general', 'ambient', false, 'active'),
         ($2, 'ZONE-QC-HOLD', 'zone', $1, $1, 'quarantine', 'ambient', true, 'active'),
         ($3, 'RECV-DOCK', 'zone', $1, $1, 'staging', 'ambient', false, 'active')`,
      [siteAId, qcZoneId, dockId],
    );

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    officerId = await provisionUser(port, `officer-4-2-${run}@example.com`, [
      {
        role: 'procurement_officer_4_2',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    officerHeaders = await authFor(port, `officer-4-2-${run}@example.com`);

    await provisionUser(port, `approver-4-2-${run}@example.com`, [
      {
        role: 'department_head_4_2',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    deptHeadHeaders = await authFor(port, `approver-4-2-${run}@example.com`);

    await provisionUser(port, `requester-4-2-${run}@example.com`, [
      {
        role: 'floor_supervisor_4_2',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    requesterHeaders = await authFor(port, `requester-4-2-${run}@example.com`);

    await provisionUser(port, `reader-4-2-${run}@example.com`, [
      {
        role: 'procurement_reader_4_2',
        module: 'procurement',
        functionScope: 'read',
        locationId: siteAId,
      },
    ]);
    readerHeaders = await authFor(port, `reader-4-2-${run}@example.com`);

    await provisionUser(port, `store-4-2-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
    ]);
    storeHeaders = await authFor(port, `store-4-2-${run}@example.com`);

    supervisorId = await provisionUser(port, `unloading-4-2-${run}@example.com`, [
      {
        role: 'unloading_supervisor',
        module: 'receiving',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);

    await provisionUser(port, `doa-admin-4-2-${run}@example.com`, [
      {
        role: 'compliance_admin_4_2',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-4-2-${run}@example.com`);
    for (const entry of [
      {
        transaction_type: 'indent_approval',
        role: 'department_head_4_2',
        value_min: 0,
        value_max: null,
      },
      {
        transaction_type: 'purchase_order_approval',
        role: 'department_head_4_2',
        value_min: 0,
        value_max: null,
      },
    ]) {
      const r = await makeRequest(port, 'POST', '/api/v1/doa/entries', entry, doaHeaders);
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    }

    const supplierRes = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `Scorecard Supplier ${run}`,
        owner_party_code: `OWN-42-${run}`.toUpperCase(),
        gstin_ext: '27ABCDE1234F1Z5',
        contacts: [{ name: 'Contact', email: 'contact@example.com' }],
        credit_period_days: 30,
      },
      officerHeaders,
    );
    assert.strictEqual(supplierRes.status, 201, JSON.stringify(supplierRes.body));
    supplierId = (supplierRes.body['supplier'] as Record<string, unknown>)['supplier_id'] as string;
    const submitRes = await makeRequest(
      port,
      'POST',
      `/api/v1/suppliers/${supplierId}/onboarding/submit`,
      { documents: [{ type: 'registration', reference: 'REG-42', file_hash: 'abc123' }] },
      officerHeaders,
    );
    assert.strictEqual(submitRes.status, 200, JSON.stringify(submitRes.body));
    if (submitRes.body['requires_approval'] !== false) {
      const approveRes = await makeRequest(
        port,
        'POST',
        `/api/v1/suppliers/${supplierId}/onboarding/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    }
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: on-time delivery from receipts against PO promise dates
  // -------------------------------------------------------------------------

  /** Reads the business_date receiving actually stamped onto a GRN (server-local calendar date). */
  async function grnBusinessDate(grnId: string): Promise<string> {
    const r = await getAdminPool().query(
      `SELECT business_date::text AS bd FROM grn WHERE grn_id = $1`,
      [grnId],
    );
    return (r.rows[0] as Record<string, unknown>)['bd'] as string;
  }

  it('AC1: an on-or-before-promise receipt records a zero-or-negative signed day delta', async () => {
    const po = await createIssuedPo('AC1A');
    const grnId = await receiveAndBind(po, 100);
    // Anchor the promise to the business_date receiving actually stamped (server-local calendar),
    // not istToday(): receiving stamps business_date via localYmd (server-local), which can trail
    // or lead IST by a day, and the delta must stay exact regardless of that wall-clock skew.
    const received = await grnBusinessDate(grnId);
    const promised = addDays(received, 2);
    await confirmPo(po.poId, promised);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/scorecard/on-time`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['value_num'], '-2.000000');
    const rows = await metricRows('on_time_delivery', grnId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['value_num'], '-2.000000');
    const context = rows[0]!['context'] as Record<string, unknown>;
    assert.strictEqual(context['received_date'], rows[0]!['business_date']);
    assert.strictEqual(context['promised_delivery_date'], promised);
  });

  it('AC1: a late receipt records a positive signed day delta', async () => {
    const po = await createIssuedPo('AC1B');
    const grnId = await receiveAndBind(po, 100);
    // Promised three days before the stamped receipt date => delta +3.
    const received = await grnBusinessDate(grnId);
    await confirmPo(po.poId, addDays(received, -3));

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/scorecard/on-time`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['value_num'], '3.000000');
  });

  it('AC1: a PO without a promised date contributes no on-time data - rejected, no fabricated zero', async () => {
    const po = await createIssuedPo('AC1C');
    // Issued but never confirmed: promised_delivery_date is null.
    const grnId = await receiveAndBind(po, 100);

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/scorecard/on-time`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PO_PROMISE_DATE_MISSING');
    const rows = await metricRows('on_time_delivery', grnId);
    assert.strictEqual(rows.length, 0);
  });

  it('AC1: an unlinked GRN is rejected with GRN_NOT_LINKED', async () => {
    const po = await createIssuedPo('AC1D');
    await confirmPo(po.poId, '2026-07-25');
    // Receive through 3.4 but do NOT bind to the native PO.
    const token = await seedToken(po.poRefExt);
    const receipt = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: token,
        po_ref_ext: po.poRefExt,
        line_no: 1,
        source_document: 'PO',
        sku: po.sku,
        target_location_code: 'RECV-DOCK',
        received_qty: 100,
      },
      storeHeaders,
    );
    assert.strictEqual(receipt.status, 201, JSON.stringify(receipt.body));
    const grnId = (receipt.body['grn'] as Record<string, unknown>)['grn_id'] as string;

    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/scorecard/on-time`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'GRN_NOT_LINKED');
  });

  it('AC1: replaying the on-time write is a no-op - the metric row count stays 1', async () => {
    const po = await createIssuedPo('AC1E');
    await confirmPo(po.poId, '2026-07-25');
    const grnId = await receiveAndBind(po, 100);

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/scorecard/on-time`,
      {},
      officerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/scorecard/on-time`,
      {},
      officerHeaders,
    );
    // The project's documented idempotent-replay surface: 2xx replay or 409 conflict.
    assert.ok(
      [200, 201, 409].includes(replay.status),
      `unexpected replay status ${replay.status}: ${JSON.stringify(replay.body)}`,
    );
    const rows = await metricRows('on_time_delivery', grnId);
    assert.strictEqual(rows.length, 1);
  });

  // -------------------------------------------------------------------------
  // AC2: quality acceptance is no-data until Epic 8 lands
  // -------------------------------------------------------------------------

  it('AC2: with no qc.lot_dispositioned source, quality acceptance is a first-class no_data shape', async () => {
    const count = await getAdminPool().query(
      `SELECT count(*)::int AS c FROM supplier_scorecard_metric WHERE metric_kind = 'quality_acceptance'`,
    );
    assert.strictEqual((count.rows[0] as Record<string, unknown>)['c'], 0);

    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${supplierId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const metrics = res.body['metrics'] as Record<string, unknown>;
    // Exact shape: no count/mean/series keys leak into the no_data response.
    assert.deepStrictEqual(metrics['quality_acceptance'], { state: 'no_data' });
  });

  // -------------------------------------------------------------------------
  // AC3: price variance from three-way match results
  // -------------------------------------------------------------------------

  it('AC3: a +2.5% price variance records the exact NUMERIC string, a -1% match updates latest', async () => {
    const poA = await createIssuedPo('AC3A');
    await confirmPo(poA.poId, '2026-07-25');
    await receiveAndBind(poA, 100);
    // 512.50 vs PO 500 = +2.5% (out of the 2% tolerance - the match blocks, which still counts).
    const matchA = await captureAndMatch(poA, 'AC3A', 100, 512.5);
    const resA = await makeRequest(
      port,
      'POST',
      `/api/v1/three-way-match/${matchA}/scorecard/price-variance`,
      {},
      officerHeaders,
    );
    assert.strictEqual(resA.status, 201, JSON.stringify(resA.body));
    assert.strictEqual(resA.body['value_num'], '2.500000');

    const poB = await createIssuedPo('AC3B');
    await confirmPo(poB.poId, '2026-07-25');
    await receiveAndBind(poB, 100);
    // 495 vs PO 500 = -1% (within tolerance - passes).
    const matchB = await captureAndMatch(poB, 'AC3B', 100, 495);
    const resB = await makeRequest(
      port,
      'POST',
      `/api/v1/three-way-match/${matchB}/scorecard/price-variance`,
      {},
      officerHeaders,
    );
    assert.strictEqual(resB.status, 201, JSON.stringify(resB.body));
    assert.strictEqual(resB.body['value_num'], '-1.000000');

    const scorecard = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${supplierId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(scorecard.status, 200, JSON.stringify(scorecard.body));
    const pv = (scorecard.body['metrics'] as Record<string, unknown>)['price_variance'] as Record<
      string,
      unknown
    >;
    assert.strictEqual(pv['count'], 2);
    assert.strictEqual(pv['latest_value'], '-1.000000');
  });

  it('AC3: a zero-variance match still contributes an explicit 0.000000', async () => {
    const po = await createIssuedPo('AC3C');
    await confirmPo(po.poId, '2026-07-25');
    await receiveAndBind(po, 100);
    const matchId = await captureAndMatch(po, 'AC3C', 100, 500);
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/three-way-match/${matchId}/scorecard/price-variance`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['value_num'], '0.000000');
    const rows = await metricRows('price_variance', matchId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['value_num'], '0.000000');
  });

  // -------------------------------------------------------------------------
  // AC4: responsiveness from PO confirmation latency in IST business days
  // -------------------------------------------------------------------------

  it('AC4: a PO confirmed the same business day records 0.000000', async () => {
    const po = await createIssuedPo('AC4A');
    await confirmPo(po.poId, '2026-07-25');
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${po.poId}/scorecard/responsiveness`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['value_num'], '0.000000');
    assert.strictEqual(res.body['business_days'], 0);
  });

  it('AC4: issued Friday IST, confirmed Monday IST is exactly one business day (the Saturday)', async () => {
    const po = await createIssuedPo('AC4B');
    await confirmPo(po.poId, '2026-08-20');
    // The routes stamp wall-clock instants; re-anchor them onto the fixed AC4 calendar facts
    // (2026-08-14 Friday, 2026-08-17 Monday) directly in the projection the route reads.
    await getAdminPool().query(
      `UPDATE purchase_order SET issued_at = '2026-08-14T04:00:00Z', confirmed_at = '2026-08-17T04:00:00Z'
       WHERE po_id = $1`,
      [po.poId],
    );
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${po.poId}/scorecard/responsiveness`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['value_num'], '1.000000');
  });

  it('AC4: a Sunday-only gap counts zero, and clock skew never produces a negative', async () => {
    const poA = await createIssuedPo('AC4C');
    await confirmPo(poA.poId, '2026-08-20');
    // Saturday 2026-08-15 to Monday 2026-08-17: only Sunday lies between.
    await getAdminPool().query(
      `UPDATE purchase_order SET issued_at = '2026-08-15T04:00:00Z', confirmed_at = '2026-08-17T04:00:00Z'
       WHERE po_id = $1`,
      [poA.poId],
    );
    const resA = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poA.poId}/scorecard/responsiveness`,
      {},
      officerHeaders,
    );
    assert.strictEqual(resA.status, 201, JSON.stringify(resA.body));
    assert.strictEqual(resA.body['value_num'], '0.000000');

    const poB = await createIssuedPo('AC4D');
    await confirmPo(poB.poId, '2026-08-20');
    await getAdminPool().query(
      `UPDATE purchase_order SET issued_at = '2026-08-18T04:00:00Z', confirmed_at = '2026-08-14T04:00:00Z'
       WHERE po_id = $1`,
      [poB.poId],
    );
    const resB = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${poB.poId}/scorecard/responsiveness`,
      {},
      officerHeaders,
    );
    assert.strictEqual(resB.status, 201, JSON.stringify(resB.body));
    assert.strictEqual(resB.body['value_num'], '0.000000');
  });

  it('AC4: an unconfirmed PO is rejected with PO_NOT_CONFIRMED and never contributes', async () => {
    const po = await createIssuedPo('AC4E');
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${po.poId}/scorecard/responsiveness`,
      {},
      officerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'PO_NOT_CONFIRMED');
  });

  it('AC4: a configured holiday removes that business day from the responsiveness count', async () => {
    const po = await createIssuedPo('AC4H');
    await confirmPo(po.poId, '2026-08-20');
    // Friday 2026-08-14 to Monday 2026-08-17: the only business day between is Saturday
    // 2026-08-15 (Monday-Saturday working week). Declaring it a holiday removes it.
    await getAdminPool().query(
      `UPDATE purchase_order SET issued_at = '2026-08-14T04:00:00Z', confirmed_at = '2026-08-17T04:00:00Z'
       WHERE po_id = $1`,
      [po.poId],
    );
    const holidays = config.scorecard.responsivenessHolidayCalendar as unknown as string[];
    holidays.push('2026-08-15');
    try {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/purchase-orders/${po.poId}/scorecard/responsiveness`,
        {},
        officerHeaders,
      );
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body['value_num'], '0.000000');
    } finally {
      holidays.pop();
    }
  });

  // -------------------------------------------------------------------------
  // AC5: consolidated scorecard view with drill-through
  // -------------------------------------------------------------------------

  it('AC5: the scorecard response carries the exact consolidated shape', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${supplierId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(Object.keys(res.body).sort(), [
      'generated_at',
      'metrics',
      'supplier_id',
    ]);
    assert.strictEqual(res.body['supplier_id'], supplierId);
    const metrics = res.body['metrics'] as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(metrics).sort(), [
      'on_time_delivery',
      'price_variance',
      'quality_acceptance',
      'responsiveness',
    ]);
    for (const kind of ['on_time_delivery', 'price_variance', 'responsiveness']) {
      const trend = metrics[kind] as Record<string, unknown>;
      assert.deepStrictEqual(
        Object.keys(trend).sort(),
        [
          'count',
          'latest',
          'latest_value',
          'mean',
          'series',
          'trailing_30d_mean',
          'trailing_365d_mean',
          'trailing_90d_mean',
        ],
        `unexpected trend shape for ${kind}`,
      );
      assert.ok((trend['count'] as number) > 0, `${kind} should have observations by now`);
      assert.ok(Array.isArray(trend['series']));
      assert.strictEqual(typeof trend['mean'], 'string', 'NUMERIC stays a string');
    }
    assert.deepStrictEqual(metrics['quality_acceptance'], { state: 'no_data' });
  });

  it('AC5: drill-through returns the underlying transactions with the right metric_kind mapping', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${supplierId}/transactions`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const transactions = res.body['transactions'] as Record<string, unknown>[];
    assert.ok(transactions.length >= 3);
    const kinds = new Set(transactions.map((t) => t['metric_kind'] as string));
    assert.ok(kinds.has('on_time_delivery'));
    assert.ok(kinds.has('price_variance'));
    assert.ok(kinds.has('responsiveness'));
    for (const t of transactions) {
      assert.ok(typeof t['summary'] === 'string' && (t['summary'] as string).length > 0);
      assert.ok(typeof t['business_date'] === 'string');
      assert.ok(typeof t['reference_entity_id'] === 'string');
    }

    const filtered = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${supplierId}/transactions?metric_kind=price_variance`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(filtered.status, 200, JSON.stringify(filtered.body));
    const filteredRows = filtered.body['transactions'] as Record<string, unknown>[];
    assert.ok(filteredRows.length >= 1);
    assert.ok(filteredRows.every((t) => t['metric_kind'] === 'price_variance'));
  });

  it('AC5: strict query validation - bad metric_kind, dates, limit and offset are 400', async () => {
    for (const qs of [
      'metric_kind=vibes',
      'since=2026-02-31',
      'until=not-a-date',
      'limit=0',
      'limit=201',
      'limit=10abc',
      'offset=10001',
    ]) {
      const res = await makeRequest(
        port,
        'GET',
        `/api/v1/supplier-scorecards/${supplierId}/transactions?${qs}`,
        undefined,
        readerHeaders,
      );
      assert.strictEqual(res.status, 400, `${qs}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS', qs);
    }
    const unknownSupplier = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(unknownSupplier.status, 404);
    assert.strictEqual(unknownSupplier.body['error_code'], 'SUPPLIER_NOT_FOUND');
  });

  it('AC5 RBAC: a procurement reader cannot invoke the metric write routes', async () => {
    const po = await createIssuedPo('RBAC');
    await confirmPo(po.poId, '2026-07-25');
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${po.poId}/scorecard/responsiveness`,
      {},
      readerHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  });

  // -------------------------------------------------------------------------
  // AC6: enforcement lives in the compliance seam, not the routes
  // -------------------------------------------------------------------------

  it('AC6: direct events with malformed shapes are rejected at the seam with INVALID_PARAMS', async () => {
    for (const overrides of [
      { business_date: '2026-02-31' },
      { metric_kind: 'vibes' },
      { value_num: 'not-numeric' },
      { value_num: '123456789.000000' },
      { context: {} },
    ]) {
      const res = await directEvent(supplierId, metricPayload(overrides));
      assert.strictEqual(res.status, 400, JSON.stringify({ overrides, body: res.body }));
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS', JSON.stringify(overrides));
    }
  });

  it('AC6: a direct event naming a non-active supplier is rejected with SUPPLIER_NOT_ACTIVE', async () => {
    // A freshly-created supplier stays in onboarding until submit + approve.
    const supplierRes = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `Onboarding Supplier ${run}`,
        owner_party_code: `OWN-42B-${run}`.toUpperCase(),
        gstin_ext: '27ABCDE1234F2Z4',
        contacts: [{ name: 'Contact', email: 'contact2@example.com' }],
        credit_period_days: 30,
      },
      officerHeaders,
    );
    assert.strictEqual(supplierRes.status, 201, JSON.stringify(supplierRes.body));
    const onboardingSupplierId = (supplierRes.body['supplier'] as Record<string, unknown>)[
      'supplier_id'
    ] as string;

    const res = await directEvent(
      onboardingSupplierId,
      metricPayload({ supplier_id: onboardingSupplierId }),
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SUPPLIER_NOT_ACTIVE');
    const count = await getAdminPool().query(
      `SELECT count(*)::int AS c FROM supplier_scorecard_metric WHERE supplier_id = $1`,
      [onboardingSupplierId],
    );
    assert.strictEqual((count.rows[0] as Record<string, unknown>)['c'], 0);
  });

  it('AC6: a duplicate direct event for the same source and kind leaves exactly one row', async () => {
    const po = await createIssuedPo('AC6DUP');
    await confirmPo(po.poId, '2026-07-25');
    const payload = await derivedResponsivenessPayload(po.poId);
    const first = await directEvent(po.poId, payload);
    assert.ok(
      first.status >= 200 && first.status < 300,
      `first insert failed: ${JSON.stringify(first.body)}`,
    );
    // Same reference_event_id + metric_kind, fresh metric_id: the projection replay guard holds.
    const second = await directEvent(po.poId, { ...payload, metric_id: randomUUID() });
    assert.ok(
      [200, 201, 409].includes(second.status),
      `unexpected duplicate status ${second.status}: ${JSON.stringify(second.body)}`,
    );
    const rows = await metricRows('responsiveness', po.poId);
    assert.strictEqual(rows.length, 1);
  });

  it('AC6: a direct event with a fabricated value_num is rejected by the seam re-derivation', async () => {
    const po = await createIssuedPo('AC6FAB');
    await confirmPo(po.poId, '2026-07-25');
    const payload = await derivedResponsivenessPayload(po.poId, { value_num: '999.000000' });
    const res = await directEvent(po.poId, payload);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SCORECARD_DERIVATION_MISMATCH');
    const rows = await metricRows('responsiveness', po.poId);
    assert.strictEqual(rows.length, 0);
  });

  it('AC6: a direct event naming a nonexistent reference entity is rejected at the seam', async () => {
    const fabricatedGrnId = randomUUID();
    const res = await directEvent(
      supplierId,
      metricPayload({ reference_entity_id: fabricatedGrnId }),
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'GRN_NOT_FOUND');
    const rows = await getAdminPool().query(
      `SELECT count(*)::int AS c FROM supplier_scorecard_metric WHERE reference_entity_id = $1`,
      [fabricatedGrnId],
    );
    assert.strictEqual((rows.rows[0] as Record<string, unknown>)['c'], 0);
  });

  it('AC6: a direct event attributing a source document to the wrong supplier is rejected', async () => {
    // A second active supplier: created, submitted and approved through the real onboarding flow.
    const supplierRes = await makeRequest(
      port,
      'POST',
      '/api/v1/suppliers',
      {
        legal_name: `Mismatch Supplier ${run}`,
        owner_party_code: `OWN-42C-${run}`.toUpperCase(),
        gstin_ext: '27ABCDE1234F3Z3',
        contacts: [{ name: 'Contact', email: 'contact3@example.com' }],
        credit_period_days: 30,
      },
      officerHeaders,
    );
    assert.strictEqual(supplierRes.status, 201, JSON.stringify(supplierRes.body));
    const otherSupplierId = (supplierRes.body['supplier'] as Record<string, unknown>)[
      'supplier_id'
    ] as string;
    const submitRes = await makeRequest(
      port,
      'POST',
      `/api/v1/suppliers/${otherSupplierId}/onboarding/submit`,
      { documents: [{ type: 'registration', reference: 'REG-42C', file_hash: 'def456' }] },
      officerHeaders,
    );
    assert.strictEqual(submitRes.status, 200, JSON.stringify(submitRes.body));
    if (submitRes.body['requires_approval'] !== false) {
      const approveRes = await makeRequest(
        port,
        'POST',
        `/api/v1/suppliers/${otherSupplierId}/onboarding/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.body));
    }

    // The PO belongs to the primary supplier; the payload claims the other one.
    const po = await createIssuedPo('AC6MIS');
    await confirmPo(po.poId, '2026-07-25');
    const payload = await derivedResponsivenessPayload(po.poId, { supplier_id: otherSupplierId });
    const res = await directEvent(otherSupplierId, payload);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SCORECARD_SUPPLIER_MISMATCH');
    const rows = await metricRows('responsiveness', po.poId);
    assert.strictEqual(rows.length, 0);
  });

  it('AC6 seam-then-route: the same unlinked-GRN violation is rejected by both surfaces', async () => {
    const po = await createIssuedPo('AC6SR');
    await confirmPo(po.poId, '2026-07-25');
    // Receive through 3.4 but do NOT bind to the native PO.
    const token = await seedToken(po.poRefExt);
    const receipt = await makeRequest(
      port,
      'POST',
      '/api/v1/grn-lines',
      {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: token,
        po_ref_ext: po.poRefExt,
        line_no: 1,
        source_document: 'PO',
        sku: po.sku,
        target_location_code: 'RECV-DOCK',
        received_qty: 100,
      },
      storeHeaders,
    );
    assert.strictEqual(receipt.status, 201, JSON.stringify(receipt.body));
    const grnId = (receipt.body['grn'] as Record<string, unknown>)['grn_id'] as string;

    const routeRes = await makeRequest(
      port,
      'POST',
      `/api/v1/grns/${grnId}/scorecard/on-time`,
      {},
      officerHeaders,
    );
    assert.strictEqual(routeRes.status, 409, JSON.stringify(routeRes.body));
    assert.strictEqual(routeRes.body['error_code'], 'GRN_NOT_LINKED');

    const seamRes = await directEvent(supplierId, metricPayload({ reference_entity_id: grnId }));
    assert.strictEqual(seamRes.status, 409, JSON.stringify(seamRes.body));
    assert.strictEqual(seamRes.body['error_code'], 'GRN_NOT_LINKED');

    const rows = await metricRows('on_time_delivery', grnId);
    assert.strictEqual(rows.length, 0);
  });

  // Story 8.3 activated this metric kind: the applier is no longer a no-op, it derives the value
  // from the qc_lot_disposition row named by reference_entity_id. The guarantee this test protects
  // is unchanged and now stronger - nothing can fabricate quality data. A quality_acceptance event
  // whose reference entity is not a real disposition is REJECTED rather than silently ignored.
  it('AC6: a quality_acceptance event with no real disposition behind it is rejected, and nothing is projected', async () => {
    const res = await directEvent(
      supplierId,
      metricPayload({
        metric_kind: 'quality_acceptance',
        value_num: '1.000000',
        context: { disposition: 'accept' },
      }),
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'DISPOSITION_NOT_FOUND');
    const count = await getAdminPool().query(
      `SELECT count(*)::int AS c FROM supplier_scorecard_metric WHERE metric_kind = 'quality_acceptance'`,
    );
    assert.strictEqual((count.rows[0] as Record<string, unknown>)['c'], 0);
  });

  // -------------------------------------------------------------------------
  // AC7: append-only metric history with supersedes corrections
  // -------------------------------------------------------------------------

  it('AC7: a correction is a new row with supersedes_metric_id; the original row is untouched', async () => {
    const po = await createIssuedPo('AC7A');
    await confirmPo(po.poId, '2026-07-25');
    const firstRes = await makeRequest(
      port,
      'POST',
      `/api/v1/purchase-orders/${po.poId}/scorecard/responsiveness`,
      {},
      officerHeaders,
    );
    assert.strictEqual(firstRes.status, 201, JSON.stringify(firstRes.body));
    const originalRows = await metricRows('responsiveness', po.poId);
    assert.strictEqual(originalRows.length, 1);
    assert.strictEqual(originalRows[0]!['value_num'], '0.000000');
    const originalMetricId = originalRows[0]!['metric_id'] as string;

    // The source fact is corrected: re-anchor the timestamps onto a Friday-to-Monday gap
    // (one business day) and record a correction event pointing back via supersedes_metric_id.
    await getAdminPool().query(
      `UPDATE purchase_order SET issued_at = '2026-08-14T04:00:00Z', confirmed_at = '2026-08-17T04:00:00Z'
       WHERE po_id = $1`,
      [po.poId],
    );
    const correction = await derivedResponsivenessPayload(po.poId, {
      supersedes_metric_id: originalMetricId,
    });
    assert.strictEqual(correction['value_num'], '1.000000');
    const res = await directEvent(po.poId, correction);
    assert.ok(res.status >= 200 && res.status < 300, JSON.stringify(res.body));

    const rows = await metricRows('responsiveness', po.poId);
    assert.strictEqual(rows.length, 2);
    const before = rows.find((r) => r['metric_id'] === originalMetricId)!;
    assert.strictEqual(before['value_num'], '0.000000', 'the original row is unchanged');
    assert.strictEqual(before['supersedes_metric_id'], null);
    const after_ = rows.find((r) => r['metric_id'] !== originalMetricId)!;
    assert.strictEqual(after_['value_num'], '1.000000');
    assert.strictEqual(after_['supersedes_metric_id'], originalMetricId);

    // The scorecard series excludes superseded rows: only the correction is served for this PO.
    const scorecard = await makeRequest(
      port,
      'GET',
      `/api/v1/supplier-scorecards/${supplierId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(scorecard.status, 200, JSON.stringify(scorecard.body));
    const resp = (scorecard.body['metrics'] as Record<string, unknown>)['responsiveness'] as Record<
      string,
      unknown
    >;
    const series = (resp['series'] as Record<string, unknown>[]).filter(
      (s) => s['reference_entity_id'] === po.poId,
    );
    assert.strictEqual(series.length, 1);
    assert.strictEqual(series[0]!['value_num'], '1.000000');
    assert.strictEqual(series[0]!['supersedes_metric_id'], originalMetricId);
  });

  it('AC7: a correction pointing at a nonexistent metric is rejected', async () => {
    const po = await createIssuedPo('AC7B');
    await confirmPo(po.poId, '2026-07-25');
    const payload = await derivedResponsivenessPayload(po.poId, {
      supersedes_metric_id: randomUUID(),
    });
    const res = await directEvent(po.poId, payload);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SCORECARD_SUPERSEDES_NOT_FOUND');
    const rows = await metricRows('responsiveness', po.poId);
    assert.strictEqual(rows.length, 0);
  });

  it('AC7: app_user holds no UPDATE or DELETE privilege on the metric projection', async () => {
    const r = await getAdminPool().query(
      `SELECT has_table_privilege('app_user', 'supplier_scorecard_metric', 'DELETE') AS can_delete,
              has_table_privilege('app_user', 'supplier_scorecard_metric', 'UPDATE') AS can_update,
              has_table_privilege('app_user', 'supplier_scorecard_metric', 'INSERT') AS can_insert,
              has_table_privilege('app_user', 'supplier_scorecard_metric', 'SELECT') AS can_select`,
    );
    const grants = r.rows[0] as Record<string, unknown>;
    assert.strictEqual(grants['can_delete'], false);
    assert.strictEqual(grants['can_update'], false);
    assert.strictEqual(grants['can_insert'], true);
    assert.strictEqual(grants['can_select'], true);
  });
});

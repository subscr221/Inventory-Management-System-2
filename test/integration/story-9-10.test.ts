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
import { persistEvent } from '../../src/events/store.js';
import { assertQcGateAllows } from '../../src/compliance/quality.js';
import { validateLotForIssueAllocate } from '../../src/compliance/lot-serial-validation.js';

/**
 * Story 9.10 Pre-Pilot Gate Sweep and Offcut Reconciliation Cleanup (retro items 2/3/4/6).
 *
 * AC 1: the dispatch-dispatched gate call site (applyDispatchDispatchedProjection) still refuses
 *   BOTH halves through the shared dispatchGateBlockedLots guard - a manually held lot and a
 *   QC-gated lot (Task 6.3 regression arms on the CHANGED call site; story-3-7/story-8-1 carry the
 *   route-level arms and are re-run in Task 6.4).
 * AC 2: an offcut-class count adjustment is refused (OFFCUT_ADJUSTMENT_REFUSED) and audited while
 *   an owned-class adjustment on the same task still applies.
 * AC 3: a count line on customer-owned stock records ZERO variance value while an owned line keeps
 *   its computed value.
 * AC 4: an upper-case UUID path parameter behaves identically to lower-case on a service-orders
 *   route (closes deferred-work 9.8-1) - the offcut disposal route's stored-vs-path retry binding
 *   is the exact mechanism the deferred-work entry describes.
 * AC 5: the billing reconciliation report surfaces a duplicate acknowledged_ref_ext count
 *   (closes deferred-work 9.6C-1).
 *
 * Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run
 * serially; every identifier is run-scoped. Fixture writes use the admin pool (app_user has no
 * DELETE). The harness scaffolding is a deliberate local re-implementation of the story-9-7
 * closures (never import cross-story).
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

// Role names asserted as LITERALS, never against exported constants (the 8.4 lesson).
const COORDINATOR_ROLE = 'jobwork_coordinator';
const FINANCE_ROLE = 'finance_controller';
const INDICATIVE_RATE = '18.5000';

describe('Story 9.10 Pre-Pilot Gate Sweep and Offcut Reconciliation Cleanup', () => {
  let server: Server;
  let port: number;

  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let financeHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  // Cycle-count users (story-2-6 conventions).
  let counterHeaders: Record<string, string>;
  let approverHeaders: Record<string, string>;

  let siteAId: string;
  let dockId: string;
  let kitBomId: string;
  let customerItemId: string;
  /** Global DOA row seeded by before(); deactivated in after() (code review 2026-09-08, P9). */
  let seededDoaEntryId: string | null = null;

  const TODAY = toIstCalendarDate(new Date());
  const CUSTOMER = `CUST-9-10-${RUN}`;
  const SKU = `SKU-CUST-9-10-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-9-10-${RUN}`;
  const OUTPUT_SKU = `SKU-OUT-9-10-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-10-${run}`;
  let poCounter = 0;

  // -------------------------------------------------------------------------
  // Job-work fixture helpers (local re-implementation of the story-9-7 closure)
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
  ): Promise<{ bomId: string; revisionId: string }> {
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
    return { bomId, revisionId };
  }

  async function seedPo(sku: string): Promise<string> {
    poCounter += 1;
    const poRef = `PO-JW-9-10-${run}-${poCounter}`;
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
       VALUES ($1, $2, $3, $4, 'site-A-9-10', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-10', 'MANUAL', $6, $7, $8)`,
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
    const lot = `LOT-JW-9-10-${run}-${randomUUID().slice(0, 6)}`;
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
        challan_number_ext: `CH-${run}-${randomUUID().slice(0, 6)}`,
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

  /** A confirmed contractual order with one retained offcut holding row still open. */
  async function retainedHolding(
    opts: { offcutQty?: string } = {},
  ): Promise<{ orderId: string; holdingId: string; lot: string }> {
    const orderId = await confirmedOrder();
    const { lot } = await receive(orderId, '1000');
    const holdingId = await capture(orderId, lot, opts.offcutQty ?? '10');
    return { orderId, holdingId, lot };
  }

  // ---- assertions ----

  async function holdingRow(holdingId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT holding_id, service_order_id, status, disposed_at, owned_lot_id
         FROM job_work_offcut_holding WHERE holding_id = $1`,
      [holdingId],
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
  // Cycle-count fixture helpers (story-2-6 conventions)
  // -------------------------------------------------------------------------

  async function seedStock(sku: string, onHand: number, stockClass: string): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand, allocated)
       VALUES ($1, $2, NULL, $3, $4, 0)`,
      [sku, dockId, stockClass, onHand],
    );
  }

  async function seedValuation(sku: string, qty: number, avg: number): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO inventory_valuation (sku, quantity_on_hand, running_average_cost, carrying_value)
       VALUES ($1, $2, $3, $4)`,
      [sku, qty, avg, qty * avg],
    );
  }

  async function createCount(sku: string[]): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/cycle-counts',
      {
        location_id: dockId,
        sku_scope: sku,
        count_type: 'cycle',
        business_date: TODAY,
        business_stream: 'production',
      },
      counterHeaders,
    );
    assert.strictEqual(res.status, 201, `create count failed: ${JSON.stringify(res.body)}`);
    return res.body['cycle_count_id'] as string;
  }

  async function submitCount(
    countId: string,
    lines: Record<string, unknown>[],
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/cycle-counts/${countId}/submit`,
      { lines },
      counterHeaders,
    );
  }

  async function approveAdjustment(
    countId: string,
    adjustmentId: string,
    reasonCode: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'PATCH',
      `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/approve`,
      { reason_code: reasonCode },
      approverHeaders,
    );
  }

  async function rejectAdjustment(
    countId: string,
    adjustmentId: string,
    reasonCode: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'PATCH',
      `/api/v1/cycle-counts/${countId}/adjustments/${adjustmentId}/reject`,
      { reason_code: reasonCode },
      approverHeaders,
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
      '../../read/projections/notification.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
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
      '../../read/projections/service_order.sql',
      '../../read/projections/jobwork_material_receipt.sql',
      '../../read/projections/custody_ledger_entry.sql',
      '../../read/projections/job_work_output.sql',
      '../../read/projections/jobwork_return_clock.sql',
      '../../read/projections/dispatch_document.sql',
      '../../read/projections/qc_inspection_task.sql',
      '../../read/projections/qc_quality_hold.sql',
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

    siteAId = await seedLocation('site', `SITE-A-9-10-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId);
    customerItemId = await seedItem(SKU);
    const companyItemId = await seedItem(SKU_COMPANY);

    coordinatorUserId = await provisionUser(port, `jw-coord-9-10-${run}@example.com`, [
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'custody', functionScope: 'write', locationId: '*' },
      { role: COORDINATOR_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coord-9-10-${run}@example.com`);

    await provisionUser(port, `jw-finance-9-10-${run}@example.com`, [
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: FINANCE_ROLE, module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: FINANCE_ROLE, module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    financeHeaders = await authFor(port, `jw-finance-9-10-${run}@example.com`);

    await provisionUser(port, `jw-store-9-10-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-10-${run}@example.com`);

    await provisionUser(port, `compliance-9-10-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-9-10-${run}@example.com`);

    // Cycle-count actors (the count task lives at dockId; SOD requires the submitter to differ
    // from the DOA-resolved approver).
    await provisionUser(port, `counter-9-10-${run}@example.com`, [
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: dockId,
      },
    ]);
    counterHeaders = await authFor(port, `counter-9-10-${run}@example.com`);
    await provisionUser(port, `approver-9-10-${run}@example.com`, [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    approverHeaders = await authFor(port, `approver-9-10-${run}@example.com`);

    // DOA registry: count adjustments route any value to warehouse_manager.
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'inventory.count_adjustment',
        role: 'warehouse_manager',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, `DOA entry failed: ${JSON.stringify(doa.body)}`);
    // Code review 2026-09-08 (P9): this row is global state that outlives the run and competes on
    // `ORDER BY created_at ASC, entry_id ASC` with every other suite's band, so it is deactivated in
    // after(). An unbounded band (value_min NULL) is also the ONE band shape under which the D1
    // defect is invisible - `findMatchingDoaEntry` matches with `$2 > value_min`, so a zeroed
    // variance still resolves here while it fails against any registry whose lowest band starts at
    // zero. It is kept unbounded deliberately, and the D1 regression is pinned on the value stored
    // on the count line instead.
    seededDoaEntryId = doa.body['entry_id'] as string;

    // The registry is global and outlives this run, so the holder resolveCountApprover actually picks
    // may be an earlier suite's warehouse_manager (the 9.6 lesson). Resolve the real approver rather
    // than assuming this run's fixture wins.
    const countApprover = await getAdminPool().query(
      `SELECT u.user_id, u.external_id FROM user_role_assignments a
       JOIN users u ON u.user_id = a.user_id
      WHERE a.role = 'warehouse_manager' AND u.active = true
      ORDER BY a.created_at ASC, a.assignment_id ASC LIMIT 1`,
    );
    const countApproverExternalId = countApprover.rows[0]?.['external_id'] as string | undefined;
    assert.ok(countApproverExternalId, 'no active warehouse_manager holder');
    approverHeaders = await authFor(port, countApproverExternalId);

    const kit = await seedKitBom([
      { sku: SKU, itemId: customerItemId, supplySource: 'customer' },
      { sku: SKU_COMPANY, itemId: companyItemId, supplySource: 'company' },
    ]);
    kitBomId = kit.bomId;
  });

  after(async () => {
    // Code review 2026-09-08 (P9): the DOA registry is global and outlives this run, so the band
    // seeded in before() is retired here rather than left to compete with every later suite's band.
    if (seededDoaEntryId) {
      await getAdminPool().query(
        `UPDATE doa_registry_entries SET active = false WHERE entry_id = $1`,
        [seededDoaEntryId],
      );
    }
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 2 + AC 3 (cycle-count offcut refusal; owned still applies; zero variance)
  // -------------------------------------------------------------------------

  it('AC 2 / AC 3: an offcut-class count adjustment is refused AND audited while an owned-class adjustment on the same task still applies, and the offcut line carries zero variance value', async () => {
    const item = `CC-9-10-${run}`;
    await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, 'weighted_average', 'production', 'active')`,
      [item],
    );
    await seedStock(item, 100, 'owned');
    await seedStock(item, 100, 'offcut');
    await seedValuation(item, 100, 10);

    const countId = await createCount([item]);
    const submitted = await submitCount(countId, [
      // Owned line: counted 90 vs book 100 => variance 10, value 10 * avg 10 = 100.
      { sku: item, counted_quantity: 90 },
      // Offcut line: counted 90 vs book 100 => variance 10, but variance_value must be zero
      // (AC 3) and the adjustment must be refused (AC 2). unit_cost is required for a non-owned
      // line by the seam even though the value is zeroed.
      { sku: item, stock_class: 'offcut', counted_quantity: 90, unit_cost: 1 },
    ]);
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));

    const lines = (submitted.body['lines'] as Record<string, unknown>[]) ?? [];
    const ownedLine = lines.find((l) => l['stock_class'] === 'owned');
    const offcutLine = lines.find((l) => l['stock_class'] === 'offcut');
    assert.ok(ownedLine && offcutLine, 'both lines must be created');

    // AC 3, placement corrected by code review 2026-09-08 (D1): the COUNT LINE keeps its computed
    // value for BOTH classes, because that value is what resolveCountApprover bands the adjustment
    // on. Zeroing it here banded every customer-owned adjustment at the lowest DOA band and, under
    // any registry whose lowest band starts at zero, made the line neither approvable NOR rejectable
    // - deadlocking the physical verification. The unvalued rule is applied to the statutory
    // evidence row instead, asserted at the end of this test.
    assert.strictEqual(Number(ownedLine['variance_value']), 100);
    assert.strictEqual(Number(offcutLine['variance_value']), 10);

    // The owned adjustment approves and applies.
    const ownedApprove = await approveAdjustment(
      countId,
      ownedLine['adjustment_id'] as string,
      'shrinkage',
    );
    assert.strictEqual(ownedApprove.status, 200, JSON.stringify(ownedApprove.body));
    const ownedBalance = await getAdminPool().query(
      `SELECT on_hand::text AS on_hand FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND stock_class = 'owned'`,
      [item, dockId],
    );
    assert.strictEqual(Number(ownedBalance.rows[0]!['on_hand']), 90);

    // The offcut adjustment is refused, with the dedicated code and the corrective message.
    const offcutApprove = await approveAdjustment(
      countId,
      offcutLine['adjustment_id'] as string,
      'shrinkage',
    );
    assert.strictEqual(offcutApprove.status, 400, JSON.stringify(offcutApprove.body));
    assert.strictEqual(offcutApprove.body['error_code'], 'OFFCUT_ADJUSTMENT_REFUSED');
    assert.match(offcutApprove.body['message'] as string, /offcut disposal and revaluation flow/);
    // The refusal was AUDITED (the applier writes its own row on a fresh connection, so it
    // survives the rollback), and the offcut balance is untouched.
    assert.ok(
      offcutApprove.body['trace_id'] &&
        (await auditedFor('OFFCUT_ADJUSTMENT_REFUSED', offcutApprove.body['trace_id'] as string)),
    );
    const offcutBalance = await getAdminPool().query(
      `SELECT on_hand::text AS on_hand FROM stock_balance
        WHERE sku = $1 AND location_id = $2 AND stock_class = 'offcut'`,
      [item, dockId],
    );
    assert.strictEqual(Number(offcutBalance.rows[0]!['on_hand']), 100);

    // Code review 2026-09-08 (D1/P1): the refusal names its exit, and that exit WORKS. The offcut
    // adjustment can never be applied, so the count only closes once the line is rejected. Before
    // the D1 fix this rejection resolved the approver from a zeroed variance value and could fail
    // 409 APPROVAL_UNRESOLVED, leaving the count - and the statutory physical verification behind
    // it - permanently stuck.
    const refusalDetails = offcutApprove.body['details'] as Record<string, unknown> | undefined;
    assert.strictEqual(refusalDetails?.['resolution'], 'reject_adjustment_to_close_count');
    const offcutReject = await rejectAdjustment(
      countId,
      offcutLine['adjustment_id'] as string,
      'shrinkage',
    );
    assert.strictEqual(offcutReject.status, 200, JSON.stringify(offcutReject.body));

    // AC 3 proper: the statutory EVIDENCE row is the unvalued one. The customer-owned line carries a
    // zero variance value there, the owned line keeps its computed value, and stock_class sits on
    // the same row so an auditor can tell a deliberately-unvalued line from a zero-cost one.
    const pvId = randomUUID();
    const pv = await makeRequest(
      port,
      'POST',
      '/api/v1/physical-verifications',
      {
        physical_verification_id: pvId,
        location_id: dockId,
        count_refs: [countId],
        coverage_percentage: 100,
        business_date: TODAY,
        business_stream: 'production',
      },
      counterHeaders,
    );
    assert.strictEqual(pv.status, 201, JSON.stringify(pv.body));

    const evidence = await getAdminPool().query(
      `SELECT stock_class, variance_value::text AS variance_value
         FROM physical_verification_line
        WHERE physical_verification_id = $1 AND sku = $2
        ORDER BY stock_class`,
      [pvId, item],
    );
    const evidenceByClass = new Map(
      evidence.rows.map((r) => [r['stock_class'] as string, Number(r['variance_value'])]),
    );
    assert.strictEqual(evidenceByClass.get('offcut'), 0);
    assert.strictEqual(evidenceByClass.get('owned'), 100);
  });

  // -------------------------------------------------------------------------
  // AC 4: upper-case UUID path behaves identically to lower-case (deferred-work 9.8-1)
  // -------------------------------------------------------------------------

  it('AC 4: an upper-case UUID path parameter on a service-orders route replays identically to lower-case (closes 9.8-1)', async () => {
    // The exact 9.8-1 mechanism, on the offcut disposal route: the FIRST posting commits with a
    // lower-case path; the SAME-key retry arrives with an UPPER-CASE order id. The route's
    // stored-vs-path target binding (storedPayload.service_order_id vs the requireUuidParam path
    // value) must match. requireUuidParam lower-cases the path segment, so the retry replays 200;
    // without the lower-casing it is rejected as a cross-target DUPLICATE_EVENT 409.
    const { orderId, holdingId } = await retainedHolding({ offcutQty: '10' });
    const body = {
      holding_id: holdingId,
      location_id: dockId,
      disposition: 'returned',
      return_challan_number_ext: `RCH-${run}-case`,
      idempotency_key: randomUUID(),
    };

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/offcut-disposals`,
      body,
      financeHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual((await holdingRow(holdingId))['status'], 'disposed');

    // Same body, same key, UPPER-CASE order id in the path.
    const upper = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId.toUpperCase()}/offcut-disposals`,
      body,
      financeHeaders,
    );
    assert.strictEqual(upper.status, 200, JSON.stringify(upper.body));
    assert.strictEqual(upper.body['event_id'], first.body['event_id']);
    assert.strictEqual(upper.body['disposal_id'], first.body['disposal_id']);
  });

  // -------------------------------------------------------------------------
  // AC 5: reconciliation report duplicate acknowledged_ref_ext count (deferred-work 9.6C-1)
  // -------------------------------------------------------------------------

  it('AC 5: the reconciliation report surfaces a duplicate acknowledged_ref_ext count when one ERP reference acknowledges two orders', async () => {
    const sharedRef = `ERP-INV-${run}-dup`;
    const report = () =>
      makeRequest(
        port,
        'GET',
        `/api/v1/jobwork/reports/billing-reconciliation?site_id=${siteAId}`,
        undefined,
        coordinatorHeaders,
      );

    // One ERP document acknowledging two orders is CORRECT behaviour - the report must COUNT it,
    // never flag it as a defect.
    for (let i = 0; i < 2; i += 1) {
      await getAdminPool().query(
        `INSERT INTO job_work_billing_feed
           (feed_id, service_order_id, idempotency_key, payload, site_id, status,
            acknowledged_at, acknowledged_by, acknowledged_ref_ext, measured_basis,
            measured_quantity, total_value, currency, first_sent_at, generated_by, source_event_id)
         VALUES ($1, $2, $3, '{}', $4, 'acknowledged', now(), $5, $6, 'per_kg',
            '20.000', '250.0000', 'INR', now(), $5, $7)`,
        [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          siteAId,
          coordinatorUserId,
          sharedRef,
          randomUUID(),
        ],
      );
    }

    const after = await report();
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));
    const dup = (after.body['duplicate_acknowledged_refs'] as Record<string, unknown>[]).find(
      (d) => d['acknowledged_ref_ext'] === sharedRef,
    );
    assert.ok(dup, 'the shared reference must appear in duplicate_acknowledged_refs');
    assert.strictEqual(dup['order_count'], 2);
    assert.strictEqual(Array.isArray(dup['feed_ids']) && dup['feed_ids'].length, 2);
  });

  // -------------------------------------------------------------------------
  // AC 1: the dispatch-dispatched gate call site still refuses BOTH halves (Task 6.3)
  // -------------------------------------------------------------------------

  it('AC 1: applyDispatchDispatchedProjection still refuses a manually held lot AND a QC-gated lot through the shared guard', async () => {
    // A lot on a MANUAL hold: lot_master.quality_hold_status = 'held' backed by an open QC hold.
    const heldLotId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status, quality_hold_reason)
       VALUES ($1, $2, $3, 'held', 'warehouse_recall')`,
      [heldLotId, `LOT-HOLD-9-10-${run}`, SKU],
    );
    await getAdminPool().query(
      `INSERT INTO qc_quality_hold
         (hold_id, lot_id, lot_number, sku, site_id, status, hold_reason, placed_by, placed_at, source_event_id)
       VALUES ($1, $2, $3, $4, $5, 'open', 'warehouse_recall', $6, now(), $7)`,
      [
        randomUUID(),
        heldLotId,
        `LOT-HOLD-9-10-${run}`,
        SKU,
        siteAId,
        coordinatorUserId,
        randomUUID(),
      ],
    );
    // A QC-gated lot: its inspection task is still in qc_hold (no release yet).
    const gatedLotId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku)
       VALUES ($1, $2, $3)`,
      [gatedLotId, `LOT-GATE-9-10-${run}`, SKU],
    );
    await getAdminPool().query(
      `INSERT INTO qc_inspection_task
         (task_id, lot_id, lot_number, source_completion_type, source_completion_id, item_id, sku,
          quantity, uom, site_id, bom_revision_id, plan_id, plan_version_id, plan_scope, completed_at,
          business_date, gate_status, gate_changed_at, source_event_id)
       VALUES ($1, $2, $3, 'job_work_order', $4, $5, $6, 1, 'KG', $7, $8, $9, $10, 'standard', now(),
          $11, 'qc_hold', now(), $12)`,
      [
        randomUUID(),
        gatedLotId,
        `LOT-GATE-9-10-${run}`,
        randomUUID(),
        customerItemId,
        SKU,
        siteAId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        TODAY,
        randomUUID(),
      ],
    );

    // Two separate dispatch orders, each with one packing record on the offending lot and a
    // shipping document already generated, so the dispatched seam is reached.
    const dispatchEvent = async (lotId: string) => {
      const dispatchOrderId = randomUUID();
      await getAdminPool().query(
        `INSERT INTO dispatch_order_status (dispatch_order_id, picked_by, packed_at)
         VALUES ($1, $2, now())`,
        [dispatchOrderId, coordinatorUserId],
      );
      await getAdminPool().query(
        `INSERT INTO packing_record (packing_record_id, dispatch_order_id, sku, packed_qty, lot_id, carton_count, packed_by)
         VALUES ($1, $2, $3, 100, $4, 1, $5)`,
        [randomUUID(), dispatchOrderId, SKU, lotId, coordinatorUserId],
      );
      await getAdminPool().query(
        `INSERT INTO dispatch_document (document_id, dispatch_order_id, document_type, document_content, generated_by)
         VALUES ($1, $2, 'bol', '{}', $3)`,
        [randomUUID(), dispatchOrderId, coordinatorUserId],
      );
      return persistEvent({
        stream_type: 'warehouse',
        stream_id: dispatchOrderId,
        event_type: 'dispatch.dispatched',
        payload: { dispatch_order_id: dispatchOrderId, dispatched_at: new Date().toISOString() },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'warehouse_manager', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      });
    };

    // Manual hold half.
    await assert.rejects(
      dispatchEvent(heldLotId),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'LOT_ON_HOLD' &&
        (err as { details?: Record<string, unknown> }).details?.['reason'] === 'quality_hold',
    );
    // QC gate half.
    await assert.rejects(
      dispatchEvent(gatedLotId),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'LOT_ON_HOLD' &&
        (err as { details?: Record<string, unknown> }).details?.['reason'] === 'qc_gate',
    );
  });
  // -------------------------------------------------------------------------
  // AC 1 (code review 2026-09-08, D2): the hold half of assertQcGateAllows runs even when the lot
  // has NO qc_inspection_task. This is the instance the original sweep did not look at, and it is
  // the ONLY lot gate on pick.ts, transfer-request.ts, production-material.ts and
  // maintenance-spares.ts, so before this fix a recalled lot was issuable through all four.
  // -------------------------------------------------------------------------

  it('AC 1: a held lot with no QC inspection task is refused by assertQcGateAllows (D2)', async () => {
    const sku = `QG-9-10-${run}`;
    const lotId = randomUUID();
    const lotNumber = `LOT-QG-${run}`;
    await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'KG', true, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
    await getAdminPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status)
       VALUES ($1, $2, $3, 'held')`,
      [lotId, lotNumber, sku],
    );
    const noTask = await getAdminPool().query(
      `SELECT 1 FROM qc_inspection_task WHERE lot_id = $1`,
      [lotId],
    );
    assert.strictEqual(noTask.rows.length, 0, 'the fixture must have NO inspection task');

    const client = await getAdminPool().connect();
    try {
      await assert.rejects(
        () =>
          assertQcGateAllows({
            lot_id: lotId,
            operation: 'issue',
            business_date: TODAY,
            client,
          }),
        (err: unknown) =>
          (err as { errorCode?: string }).errorCode === 'LOT_ON_HOLD' &&
          (err as { details?: Record<string, unknown> }).details?.['reason'] === 'manual_hold',
        'a held lot with no inspection task must still be refused',
      );

      // Task 6.3: the sibling gate Task 1 changed from `=== 'held'` to `!== 'none'` had no arm at
      // all. Same lot, the other idiom.
      const validated = await validateLotForIssueAllocate(lotNumber, sku, false, client);
      assert.strictEqual(validated.valid, false);
      assert.strictEqual(validated.errorCode, 'LOT_ON_HOLD');
    } finally {
      client.release();
    }
  });
});

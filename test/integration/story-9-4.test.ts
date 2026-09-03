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

/**
 * Story 9.4 Process Loss, Offcut Election Capture, and QC-Gated Dispatch (FR-JW-08, FR-JW-09/10,
 * FR-JW-11). Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth.
 * Tests run serially; every identifier is run-scoped. Fixture writes use the admin pool. The
 * harness scaffolding is a deliberate local re-implementation of the story-9-2/9-3 closures (never
 * import cross-story) plus the story-6-3/8-3 inspection-plan-approval and disposition closures.
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

describe('Story 9.4 Process Loss, Offcut Election Capture, and QC-Gated Dispatch', () => {
  let server: Server;
  let port: number;

  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let inspectorHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;

  let siteAId: string;
  let dockId: string;
  let kitBomId: string;
  let kitRevisionId: string;
  let outputItemId: string;
  let characteristicId: string;

  const CUSTOMER = `CUST-9-4-${RUN}`;
  const SKU = `SKU-CUST-9-4-${RUN}`;
  const SKU_COMPANY = `SKU-COMP-9-4-${RUN}`;
  const OUTPUT_SKU = `SKU-OUT-9-4-${RUN}`;
  const DOCK_CODE = `RECV-DOCK-9-4-${run}`;
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
    const poRef = `PO-JW-9-4-${run}-${poCounter}`;
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
       VALUES ($1, $2, $3, $4, 'site-A-9-4', $5, 1, 1000, 2000, 1000, 'accepted', 'WB-9-4', 'MANUAL', $6, '2026-09-03', $7)`,
      [randomUUID(), token, randomUUID(), siteAId, poRef, coordinatorUserId, randomUUID()],
    );
    return token;
  }

  async function confirmedOrder(overrides: Record<string, unknown> = {}): Promise<string> {
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
        ...overrides,
      },
      coordinatorHeaders,
    );
    assert.strictEqual(create.status, 201, `create order failed: ${JSON.stringify(create.body)}`);
    const orderId = (create.body['service_order'] as Record<string, unknown>)[
      'service_order_id'
    ] as string;
    const confirmBody: Record<string, unknown> = { idempotency_key: randomUUID() };
    if (overrides['offcut_election'] !== undefined) {
      confirmBody['offcut_election'] = overrides['offcut_election'];
    }
    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/confirm`,
      confirmBody,
      coordinatorHeaders,
    );
    return confirm.status === 200
      ? orderId
      : (() => {
          throw new Error(`confirm failed: ${JSON.stringify(confirm.body)}`);
        })();
  }

  async function receive(serviceOrderId: string, sku: string = SKU, qty = '1000'): Promise<string> {
    const poRef = await seedPo(sku);
    const token = await seedToken(poRef);
    const lot = `LOT-JW-9-4-${run}-${randomUUID().slice(0, 6)}`;
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
        sku,
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
    return lot;
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

  /** A confirmed, in_process order with a receipt and consumption already posted. */
  async function inProcessOrderWithConsumption(
    consumedQty = '100',
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const orderId = await confirmedOrder(overrides);
    const lot = await receive(orderId);
    const c = await consume(orderId, lot, SKU, consumedQty);
    assert.strictEqual(c.status, 201, `consume failed: ${JSON.stringify(c.body)}`);
    return orderId;
  }

  async function postLoss(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/loss`,
      { sku: SKU, uom: 'KG', reason_code: 'PROCESS_YIELD', idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  async function recordOutput(
    orderId: string,
    lotId: string,
    quantity = '50',
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/outputs`,
      { lot_id: lotId, quantity, uom: 'KG', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
  }

  async function dispatch(
    orderId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/dispatches`,
      { uom: 'KG', idempotency_key: randomUUID(), ...body },
      headers,
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
    // 'qc.inspection_plan_approval' is a pre-existing transaction type shared with every other
    // story's tests against this same long-lived local test database; findMatchingDoaEntry
    // resolves the OLDEST active entry for it (src/read/projections/doa_registry.ts:193), which
    // may not be the entry this fixture just registered. Resolve and authenticate as whichever
    // actor the server will actually require, rather than assuming it is qcHeadHeaders.
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

  /** Drives an already-created output task through sampling -> observations -> completion -> accept. */
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
      { disposition: 'accept', justification: 'Story 9.4 dispatch fixture' },
      qcHeadHeaders,
    );
    assert.strictEqual(disp.status, 201, JSON.stringify(disp.body));
  }

  /** Resolves whichever user resolveApprover will actually pick for transactionType (the OLDEST
   * active DOA entry's role and the OLDEST active holder of that role - src/api/v1/indents.ts:66,
   * src/read/projections/doa_registry.ts:193,298 - which may predate this run's own fixtures on
   * this long-lived local test database). */
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

  async function auditCount(errorCode: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = $1`,
      [errorCode],
    );
    return r.rows[0]!['n'] as number;
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

    siteAId = await seedLocation('site', `SITE-A-9-4-${run}`, null);
    dockId = await seedLocation('zone', DOCK_CODE, siteAId);
    const customerItemId = await seedItem(SKU);
    const companyItemId = await seedItem(SKU_COMPANY);

    coordinatorUserId = await provisionUser(port, `jw-coord-9-4-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'custody', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coord-9-4-${run}@example.com`);

    // Run-unique role LABELS (RBAC keys off module/functionScope/locationId only, per
    // permittedLocationsForModuleScope - the "role" string is a DOA/audit label). Using the
    // literal role names shared across every prior story's test fixtures would let
    // findRoleHolder's oldest-created-row resolution (src/read/projections/doa_registry.ts:298)
    // silently resolve the DOA approver to a stale user from an EARLIER test run against this
    // same long-lived local test database, rather than this run's own fixture user.
    const SUPERVISOR_ROLE = `jobwork_supervisor_9_4_${run}`;
    // 'qc_head' is NOT a free choice here: resolveQcAuthority's requireQcHead option (Story 8.x,
    // src/compliance/quality.ts:1513) hard-checks the DOA entry's role against
    // config.quality.qcHeadRoles (default ['qc_head']) and fails APPROVAL_UNRESOLVED for any other
    // role literal - unlike jobwork.over_norm_loss, this transaction type cannot use a run-unique
    // role name. resolvedApprover() below still protects against stale-holder pollution by
    // dynamically resolving and authenticating as whichever user actually holds it.
    const QC_HEAD_ROLE = 'qc_head';
    // Provisioned so at least one holder of SUPERVISOR_ROLE exists (guarantees resolvedApprover
    // finds someone on a truly fresh database); the actual approver used by the tests below is
    // whichever user resolvedApprover('jobwork.over_norm_loss') resolves to, per the comment above.
    await provisionUser(port, `jw-supervisor-9-4-${run}@example.com`, [
      { role: SUPERVISOR_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: SUPERVISOR_ROLE, module: 'custody', functionScope: 'write', locationId: '*' },
    ]);

    await provisionUser(port, `jw-store-9-4-${run}@example.com`, [
      { role: 'store_assistant', module: 'receiving', functionScope: 'write', locationId: siteAId },
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'store_assistant', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    storeHeaders = await authFor(port, `jw-store-9-4-${run}@example.com`);

    await provisionUser(port, `qc-inspector-9-4-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    inspectorHeaders = await authFor(port, `qc-inspector-9-4-${run}@example.com`);

    await provisionUser(port, `qc-head-9-4-${run}@example.com`, [
      { role: QC_HEAD_ROLE, module: 'qc', functionScope: 'write', locationId: '*' },
      { role: QC_HEAD_ROLE, module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-9-4-${run}@example.com`);

    await provisionUser(port, `compliance-9-4-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-9-4-${run}@example.com`);

    for (const transactionType of ['qc.inspection_plan_approval', 'jobwork.over_norm_loss']) {
      const entry = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        {
          role: transactionType === 'qc.inspection_plan_approval' ? QC_HEAD_ROLE : SUPERVISOR_ROLE,
          transaction_type: transactionType,
          value_min: null,
          value_max: null,
        },
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

    await approvePlan();
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1, 2: process loss and the over-norm DOA chain
  // -------------------------------------------------------------------------

  it('AC1/AC2: within-norm loss posts to the custody ledger without approval', async () => {
    const orderId = await inProcessOrderWithConsumption('1000');
    // 1% of 1000 consumed = 10, at/below the configured 5% default norm.
    const res = await postLoss(orderId, { quantity: '10' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const rows = await getAdminPool().query(
      `SELECT movement_category, ownership, quantity_delta::text AS quantity_delta, posted_by
         FROM custody_ledger_entry WHERE service_order_id = $1 AND movement_category = 'loss'`,
      [orderId],
    );
    assert.strictEqual(rows.rows.length, 1);
    assert.strictEqual(rows.rows[0]!['ownership'], 'customer');
    assert.strictEqual(rows.rows[0]!['quantity_delta'], '-10.000');
    assert.strictEqual(rows.rows[0]!['posted_by'], coordinatorUserId);
  });

  it('AC1: over-norm loss without approval refuses APPROVAL_REQUIRED, audited', async () => {
    const orderId = await inProcessOrderWithConsumption('1000');
    // 200/1000 = 20% > the 5% default norm.
    const res = await postLoss(orderId, { quantity: '200' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    assert.ok((await auditCount('APPROVAL_REQUIRED')) > 0);
    const rows = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM custody_ledger_entry WHERE service_order_id = $1 AND movement_category = 'loss'`,
      [orderId],
    );
    assert.strictEqual(rows.rows[0]!['n'], 0);
  });

  it('AC1: over-norm loss approved by the resolved DOA approver succeeds; forged approver refused', async () => {
    const orderId = await inProcessOrderWithConsumption('1000');
    const forged = await postLoss(orderId, {
      quantity: '200',
      over_norm_approved: true,
      approved_by: coordinatorUserId,
    });
    assert.strictEqual(forged.status, 403, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'APPROVAL_REQUIRED');

    const approver = await resolvedApprover('jobwork.over_norm_loss');
    const approved = await postLoss(
      orderId,
      { quantity: '200', over_norm_approved: true, approved_by: approver.userId },
      approver.headers,
    );
    assert.strictEqual(approved.status, 201, JSON.stringify(approved.body));
    const rows = await getAdminPool().query(
      `SELECT quantity_delta::text AS quantity_delta FROM custody_ledger_entry
        WHERE service_order_id = $1 AND movement_category = 'loss'`,
      [orderId],
    );
    assert.strictEqual(rows.rows[0]!['quantity_delta'], '-200.000');
  });

  it('AC1: direct POST /api/v1/events cannot bypass the over-norm approval gate', async () => {
    const orderId = await inProcessOrderWithConsumption('1000');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'custody',
        stream_id: orderId,
        event_type: 'custody.loss_recorded',
        payload: {
          service_order_id: orderId,
          loss_id: randomUUID(),
          sku: SKU,
          quantity: '200',
          uom: 'KG',
          site_id: siteAId,
          reason_code: 'PROCESS_YIELD',
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
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
  });

  // -------------------------------------------------------------------------
  // AC 3: mandatory offcut election
  // -------------------------------------------------------------------------

  it('AC3: a contractual-offcut order refuses confirm without an election', async () => {
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
    assert.strictEqual(create.status, 201, JSON.stringify(create.body));
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
    assert.strictEqual(confirm.status, 409, JSON.stringify(confirm.body));
    assert.strictEqual(confirm.body['error_code'], 'INVALID_STATE_TRANSITION');

    const confirmWithElection = await makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${orderId}/confirm`,
      { idempotency_key: randomUUID(), offcut_election: 'retain_and_buy' },
      coordinatorHeaders,
    );
    assert.strictEqual(confirmWithElection.status, 200, JSON.stringify(confirmWithElection.body));
  });

  it('AC3: an order with no contractual offcut arrangement confirms without an election (9.1 regression)', async () => {
    const orderId = await confirmedOrder();
    const row = await getAdminPool().query(
      `SELECT status, offcut_election FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(row.rows[0]!['status'], 'confirmed');
    assert.strictEqual(row.rows[0]!['offcut_election'], null);
  });

  // -------------------------------------------------------------------------
  // AC 4, 5: output recording, QC gate, and dispatch
  // -------------------------------------------------------------------------

  it('AC4: output recording creates a qc_hold inspection task; dispatch before release refuses LOT_ON_HOLD', async () => {
    const orderId = await inProcessOrderWithConsumption('500');
    const lotId = randomUUID();
    const output = await recordOutput(orderId, lotId, '50');
    assert.strictEqual(output.status, 201, JSON.stringify(output.body));
    const outputRow = output.body['output'] as Record<string, unknown>;
    const lotNumber = outputRow['lot_number'] as string;

    const task = await getAdminPool().query(
      `SELECT gate_status FROM qc_inspection_task WHERE lot_id = (SELECT lot_id FROM lot_master WHERE lot_number = $1)`,
      [lotNumber],
    );
    assert.strictEqual(task.rows[0]!['gate_status'], 'qc_hold');

    const blocked = await dispatch(orderId, { lot_id: lotNumber, dispatched_quantity: '10' });
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'LOT_ON_HOLD');
  });

  it('AC5: dispatch after QC release decrements open-to-dispatch, posts a custody dispatch row, and generates documents', async () => {
    const orderId = await inProcessOrderWithConsumption('500');
    const lotId = randomUUID();
    const output = await recordOutput(orderId, lotId, '50');
    assert.strictEqual(output.status, 201, JSON.stringify(output.body));
    const outputRow = output.body['output'] as Record<string, unknown>;
    const lotNumber = outputRow['lot_number'] as string;
    const taskRow = await getAdminPool().query(
      `SELECT task_id FROM qc_inspection_task WHERE lot_id = (SELECT lot_id FROM lot_master WHERE lot_number = $1)`,
      [lotNumber],
    );
    await releaseOutputTask(taskRow.rows[0]!['task_id'] as string);

    const first = await dispatch(orderId, { lot_id: lotNumber, dispatched_quantity: '20' });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const outRow = await getAdminPool().query(
      `SELECT dispatched_quantity::text AS dispatched_quantity FROM job_work_output WHERE lot_number = $1`,
      [lotNumber],
    );
    assert.strictEqual(outRow.rows[0]!['dispatched_quantity'], '20.000');

    const ledger = await getAdminPool().query(
      `SELECT quantity_delta::text AS quantity_delta, ownership FROM custody_ledger_entry
        WHERE service_order_id = $1 AND movement_category = 'dispatch'`,
      [orderId],
    );
    assert.strictEqual(ledger.rows.length, 1, JSON.stringify(ledger.rows));
    assert.strictEqual(ledger.rows[0]!['ownership'], 'customer');
    assert.ok(Number(ledger.rows[0]!['quantity_delta']) < 0);

    const docs = await getAdminPool().query(
      `SELECT document_type FROM dispatch_document WHERE dispatch_order_id = $1 ORDER BY document_type`,
      [orderId],
    );
    assert.deepStrictEqual(
      docs.rows.map((r: Record<string, unknown>) => r['document_type']).sort(),
      ['bol', 'commercial_invoice', 'label', 'packing_slip'],
    );

    // Exceeding the remaining open-to-dispatch quantity refuses.
    const over = await dispatch(orderId, { lot_id: lotNumber, dispatched_quantity: '40' });
    assert.strictEqual(over.status, 409, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'INSUFFICIENT_STOCK');
  });

  it('AC4: dispatching a lot from another order refuses CROSS_ISSUE_BLOCKED', async () => {
    const orderA = await inProcessOrderWithConsumption('500');
    const orderB = await inProcessOrderWithConsumption('500');
    const lotId = randomUUID();
    const output = await recordOutput(orderA, lotId, '50');
    const lotNumber = (output.body['output'] as Record<string, unknown>)['lot_number'] as string;

    const res = await dispatch(orderB, { lot_id: lotNumber, dispatched_quantity: '10' });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CROSS_ISSUE_BLOCKED');
  });

  it('regression: story-9-1/9-2/9-3 order lifecycle and receipt/consumption flows are unaffected', async () => {
    const orderId = await inProcessOrderWithConsumption('100');
    const status = await getAdminPool().query(
      `SELECT status FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(status.rows[0]!['status'], 'in_process');
  });
});

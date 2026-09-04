import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';
import { persistEvent } from '../../src/events/store.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.6: Statutory Examinations, Cost Accumulation, and Machine Status Broadcast
// (FR-M-14, FR-M-15, FR-M-16). Runs against the PRODUCTION router surface (createAppRouter) with
// real auth, RBAC and PostgreSQL - no mocks of the DB or the event store. The harness is the Story
// 7.5 pattern extended with the Story 7.6 projections and the Epic 3 weighbridge chain.
//
// Time is controlled entirely through the explicit business_date parameter of the scan and through
// the examination dates, so no clock mocking is needed. The maintenance stream is blocked at the
// direct-events HTTP guard (INVALID_EVENT_STREAM), so the seam-level rejection codes
// (STATUTORY_DERIVATION_MISMATCH, COST_DERIVATION_MISMATCH) are exercised through direct
// persistEvent calls - the enforcement surface a direct write would actually hit.

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

function detailsOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
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
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/** Whole-day UTC arithmetic on an ISO date, matching the handler and job helpers. */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(y!, m! - 1, d!) + days * 86400000).toISOString().slice(0, 10);
}

/** Whole-month arithmetic in the same SQL semantics the seam re-checks (make_interval clamping). */
function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  return new Date(
    Date.UTC(y!, m! - 1 + months, Math.min(d!, new Date(y!, m! - 1 + months + 1, 0).getDate())),
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * A FIXED anchor date, deliberately not derived from the wall clock. Every examination window and
 * business_date in this suite is expressed relative to it, so no test can flip on a clock-window
 * boundary the way the story-5-2 and story-5-3 flakes do.
 */
const ANCHOR = '2026-06-01';
// A scan date strictly AFTER ANCHOR + 12 months (2027-06-01), so an examination recorded at ANCHOR
// with the default 12-month interval is genuinely overdue at scan time. Derived from today (not a
// fixed literal) so the suite cannot go stale once the wall clock passes the anchor's window.
const OVERDUE_SCAN_DATE = addDays(new Date().toISOString().slice(0, 10), 300);

describe('Story 7.6 Statutory Examinations, Cost Accumulation, and Machine Status Broadcast', () => {
  let server: Server;
  let port: number;
  let siteLocId: string;
  let supervisorUserId: string;
  let supervisorHeaders: Record<string, string>;
  let technicianHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let weighOperatorHeaders: Record<string, string>;
  let plannerUserId: string;
  let hubUserId: string;

  // --- helpers -------------------------------------------------------------

  async function seedLocation(codeSuffix: string): Promise<string> {
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), `LOC-7-6-${run}-${codeSuffix}`, randomUUID()],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function createAsset(): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-7-6-${randomUUID().slice(0, 12)}`,
        asset_name: `Machine ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: 'critical',
      },
      supervisorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_id']!;
  }

  async function recordExamination(
    assetId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/statutory-examinations',
      {
        asset_id: assetId,
        examination_type: 'osh_code',
        interval_months: 12,
        examined_on: ANCHOR,
        certificate_number_ext: `CERT-${randomUUID().slice(0, 8)}`,
        business_date: ANCHOR,
        ...overrides,
      },
      supervisorHeaders,
    );
  }

  async function recordExaminationOk(
    assetId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ examinationId: string; res: HttpResult }> {
    const res = await recordExamination(assetId, overrides);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const examination = res.body['examination'] as Record<string, string>;
    return { examinationId: examination['examination_id']!, res };
  }

  async function scan(
    businessDate: string,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/statutory-examinations/scan',
      { business_date: businessDate, ...overrides },
      supervisorHeaders,
    );
  }

  async function setStatus(
    assetId: string,
    newStatus: string,
    overrides: Record<string, unknown> = {},
    headers: Record<string, string> = supervisorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/status`,
      { new_status: newStatus, ...overrides },
      headers,
    );
  }

  async function getStatus(assetId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/status`,
      undefined,
      readerHeaders,
    );
  }

  /** Inserts an open maintenance work order directly (the harness seeds projections as fixtures). */
  async function insertOpenWorkOrder(assetId: string): Promise<string> {
    const workOrderId = randomUUID();
    // chk_maintenance_work_order_plan_link requires plan_id on a 'preventive' row; a phantom plan id
    // is fine - there is no FK between projections, and the completion applier never reads the plan.
    await getAdminPool().query(
      `INSERT INTO maintenance_work_order (
        work_order_id, plan_id, asset_id, origin, due_date, grace_until_date,
        status, generated_for_cycle, created_at, updated_at
      ) VALUES ($1, $2, $3, 'preventive', $4, $4, 'open', 'cycle-1', now(), now())`,
      [workOrderId, randomUUID(), assetId, ANCHOR],
    );
    return workOrderId;
  }

  async function completeWorkOrder(
    workOrderId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      overrides,
      supervisorHeaders,
    );
  }

  async function workOrderRow(workOrderId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT work_order_id, labor_cost::text AS labor_cost, parts_cost::text AS parts_cost,
              total_cost::text AS total_cost, capitalization_flagged, status
         FROM maintenance_work_order WHERE work_order_id = $1`,
      [workOrderId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function assetCostRow(assetId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT total_labor_cost::text AS total_labor_cost, total_parts_cost::text AS total_parts_cost,
              total_cost::text AS total_cost, last_work_order_id
         FROM maintenance_asset_cost WHERE asset_id = $1`,
      [assetId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function examinationRow(examinationId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT examination_id, asset_id, examination_type, interval_months,
              to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, status, device_key
         FROM statutory_examination WHERE examination_id = $1`,
      [examinationId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function domainEventCountFor(
    eventType: string,
    payloadIdField: string,
    payloadId: string,
  ): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = $1 AND payload->>$2 = $3`,
      [eventType, payloadIdField, payloadId],
    );
    return r.rows[0]!['n'] as number;
  }

  /**
   * The MOST RECENT notification for (object_id, target_role). Ordered rather than an arbitrary
   * rows[0]: object_id is the subject (an asset can change status many times), so which row comes
   * back must be deterministic. Pair with notificationCountFor wherever duplicate emission matters.
   */
  async function notificationFor(
    objectId: string,
    targetRole: string,
  ): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role,
              payload->>'next_step' AS next_step,
              payload->>'actor_label' AS actor_label,
              payload->>'status_verb' AS status_verb,
              payload->'escalation'->>'target_role' AS escalation_role
         FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->'target'->>'role' = $2
        ORDER BY created_at DESC, event_id DESC
        LIMIT 1`,
      [objectId, targetRole],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  /** How many notifications a subject has drawn for a role - the duplicate-emission guard. */
  async function notificationCountFor(objectId: string, targetRole: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->'target'->>'role' = $2`,
      [objectId, targetRole],
    );
    return r.rows[0]!['n'] as number;
  }

  /** Whether a weighbridge_event row was actually written for a PO line (Testing Requirements 2/3). */
  async function weighbridgeEventCountFor(poRef: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM weighbridge_event WHERE po_ref_ext = $1`,
      [poRef],
    );
    return r.rows[0]!['n'] as number;
  }

  /** Replicates src/notify/dispatch.ts resolveTargetUserIds exactly (the Story 7.4 lesson). */
  async function recipientCountFor(role: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(DISTINCT user_id)::int AS n FROM user_role_assignments
        WHERE role = $1 AND (location_id = '*' OR location_id = $2)`,
      [role, siteLocId],
    );
    return r.rows[0]!['n'] as number;
  }

  /** The actor stamp every direct-persistEvent forgery test uses. */
  function forgedMetadata(): Record<string, unknown> {
    return {
      correlation_id: randomUUID(),
      actor: { user_id: supervisorUserId, role: 'maintenance_supervisor', location_id: siteLocId },
      occurred_at: new Date().toISOString(),
    };
  }

  /** Seeds the full Epic 3 weighbridge chain: site, PO + line, gate event, operator. */
  async function seedWeighbridgeChain(): Promise<{ siteId: string; token: string; poRef: string }> {
    const siteId = randomUUID();
    const siteCode = `SITE-WB-7-6-${run}-${randomUUID().slice(0, 8)}`;
    const sku = `SKU-WB-7-6-${randomUUID().slice(0, 8)}`;
    const poRef = `PO-WB-7-6-${randomUUID().slice(0, 8)}`;
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'site', $1, 'general', 'ambient', 'active')`,
      [siteId, siteCode],
    );
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'KG', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
      [poRef],
    );
    await getPool().query(
      `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
       VALUES ($1, 1, $2, 3500, 3500, 1, 2, 2, 'ERP', now())`,
      [poRef, sku],
    );
    const token = randomUUID();
    await getAdminPool().query(
      `INSERT INTO gate_event (gate_event_id, site_id, site_code_ext, po_ref_ext, binding_status, vehicle_reg_ext, challan_number_ext, challan_photo_ref, gate_id, gate_officer_id, correlation_id, entered_at, business_date, status, source_event_id)
       VALUES ($1, $2, $3, $4, 'matched', 'KA01AB1234', 'CH-1', 'challan.jpg', 'GATE-1', $5, $6, now(), '2026-06-01', 'open', $1)`,
      [randomUUID(), siteId, siteCode, poRef, supervisorUserId, token],
    );
    return { siteId, token, poRef };
  }

  function wbBody(
    token: string,
    poRef: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      weighbridge_event_id: randomUUID(),
      correlation_id: token,
      tare_kg: 12000,
      gross_kg: 15500,
      po_ref_ext: poRef,
      line_no: 1,
      device_id: 'WB-DEVICE-7-6',
      capture_method: 'MANUAL',
      ...overrides,
    };
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
      '../../read/projections/asset.sql',
      '../../read/projections/maintenance_work_order.sql',
      '../../read/projections/maintenance_plan.sql',
      '../../read/projections/statutory_examination.sql',
      '../../read/projections/statutory_examination_record.sql',
      '../../read/projections/asset_operational_status.sql',
      '../../read/projections/maintenance_asset_cost.sql',
      '../../read/projections/gate_event.sql',
      '../../read/projections/weighbridge_event.sql',
      '../../read/projections/erp_purchase_order.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE statutory_examination_record, statutory_examination, asset_operational_status, maintenance_asset_cost, maintenance_work_order, maintenance_plan, asset, weighbridge_event, gate_event, erp_purchase_order_line, erp_purchase_order, integration_exception, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteLocId = await seedLocation('SITE');

    // The supervisor holds the LITERAL role the DOA entry routes to and the notifications target.
    supervisorUserId = await provisionUser(port, `maint-sup-7-6-${run}@example.com`, [
      {
        role: 'maintenance_supervisor',
        module: 'maintenance',
        functionScope: 'write',
        locationId: '*',
      },
      {
        role: 'maintenance_supervisor',
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    supervisorHeaders = await authFor(port, `maint-sup-7-6-${run}@example.com`);

    // A maintenance technician who is NOT the resolved return-to-service approver (403 path).
    await provisionUser(port, `maint-tech-7-6-${run}@example.com`, [
      {
        role: 'maintenance_technician',
        module: 'maintenance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    technicianHeaders = await authFor(port, `maint-tech-7-6-${run}@example.com`);

    await provisionUser(port, `maint-reader-7-6-${run}@example.com`, [
      {
        role: `maintenance_reader_7_6_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    readerHeaders = await authFor(port, `maint-reader-7-6-${run}@example.com`);

    await provisionUser(port, `compliance-7-6-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-7-6-${run}@example.com`);

    await provisionUser(port, `wb-operator-7-6-${run}@example.com`, [
      {
        role: 'weighbridge_operator',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    weighOperatorHeaders = await authFor(port, `wb-operator-7-6-${run}@example.com`);

    // AC4 fan-out must resolve to at least one real recipient for BOTH new role strings (the
    // Story 7.4 lesson applied in advance).
    plannerUserId = await provisionUser(port, `planner-7-6-${run}@example.com`, [
      { role: 'production_planner', module: 'production', functionScope: 'read', locationId: '*' },
    ]);
    hubUserId = await provisionUser(port, `hub-7-6-${run}@example.com`, [
      {
        role: 'hub_booking_coordinator',
        module: 'production',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    void plannerUserId;
    void hubUserId;
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1 + AC2: statutory examination register, overdue scan, use-lock
  // -------------------------------------------------------------------------

  it('AC1: a statutory examination is recorded compliant with the SQL-derived due date', async () => {
    const assetId = await createAsset();
    const { res, examinationId } = await recordExaminationOk(assetId, {
      interval_months: 18,
      examined_on: ANCHOR,
    });
    const examination = res.body['examination'] as Record<string, string>;
    assert.strictEqual(examination['status'], 'compliant');
    assert.strictEqual(examination['next_due_date'], addMonths(ANCHOR, 18));
    const records = res.body['records'] as Record<string, unknown>[];
    assert.strictEqual(records.length, 1);

    const row = await examinationRow(examinationId);
    assert.strictEqual(row?.['examination_type'], 'osh_code');
    assert.strictEqual(row?.['next_due_date'], addMonths(ANCHOR, 18));
    assert.strictEqual(row?.['status'], 'compliant');
  });

  it('AC1: recording an already-overdue examination is rejected 422 EXAMINATION_ALREADY_OVERDUE', async () => {
    const assetId = await createAsset();
    const res = await recordExamination(assetId, {
      examined_on: addDays(ANCHOR, -400),
      interval_months: 12,
    });
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'EXAMINATION_ALREADY_OVERDUE');
  });

  it('AC1: an examination dated after business_date is rejected 422 EXAMINATION_FUTURE_DATE', async () => {
    const assetId = await createAsset();
    const res = await recordExamination(assetId, { examined_on: addDays(ANCHOR, 2) });
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'EXAMINATION_FUTURE_DATE');
  });

  it('AC1: invalid type, interval, and asset each surface their stable error code', async () => {
    const assetId = await createAsset();
    const badType = await recordExamination(assetId, { examination_type: 'not_a_type' });
    assert.strictEqual(badType.status, 400);
    assert.strictEqual(badType.body['error_code'], 'INVALID_EXAMINATION_TYPE');

    const badInterval = await recordExamination(assetId, { interval_months: 0 });
    assert.strictEqual(badInterval.status, 400);
    assert.strictEqual(badInterval.body['error_code'], 'INVALID_INTERVAL');

    const badAsset = await recordExamination(randomUUID(), {});
    assert.strictEqual(badAsset.status, 404);
    assert.strictEqual(badAsset.body['error_code'], 'ASSET_NOT_FOUND');
  });

  it('AC1: a second record on a COMPLIANT grain is rejected 409 DUPLICATE_STATUTORY_EXAMINATION', async () => {
    const assetId = await createAsset();
    const { examinationId } = await recordExaminationOk(assetId);
    const res = await recordExamination(assetId, {
      certificate_number_ext: 'SECOND-CERT',
    });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'DUPLICATE_STATUTORY_EXAMINATION');
    const details = detailsOf(res.body);
    assert.strictEqual(details?.['existing_examination_id'], examinationId);
  });

  it('AC1: a forged next_due_date on the direct event path is rejected 409 STATUTORY_DERIVATION_MISMATCH', async () => {
    const assetId = await createAsset();
    const examinationId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: examinationId,
        event_type: 'maintenance.statutory_examination_recorded',
        payload: {
          examination_id: examinationId,
          asset_id: assetId,
          examination_type: 'osh_code',
          interval_months: 12,
          examined_on: ANCHOR,
          next_due_date: addMonths(ANCHOR, 24),
          certificate_number_ext: 'FORGED',
          device_key: null,
          business_date: ANCHOR,
          recorded_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error &&
        (err as { errorCode?: string }).errorCode === 'STATUTORY_DERIVATION_MISMATCH',
    );
  });

  it('AC1: the overdue scan flips examinations strictly past their due date and skips re-runs', async () => {
    const assetId = await createAsset();
    const { examinationId } = await recordExaminationOk(assetId);
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'compliant');

    const before = await scan(ANCHOR, { asset_id: assetId });
    assert.strictEqual(before.status, 200, JSON.stringify(before.body));
    assert.strictEqual(before.body['examinations_overdue'], 0);

    const flipped = await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });
    assert.strictEqual(flipped.status, 200, JSON.stringify(flipped.body));
    assert.strictEqual(flipped.body['examinations_overdue'], 1);
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'overdue');

    const again = await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });
    assert.strictEqual(again.body['examinations_overdue'], 0);

    const notification = await notificationFor(examinationId, 'maintenance_supervisor');
    assert.ok(notification, 'overdue notification must exist');
    // Exactly one: the grain flipped once, and the re-run above must not have re-notified.
    assert.strictEqual(await notificationCountFor(examinationId, 'maintenance_supervisor'), 1);
    assert.strictEqual(notification?.['escalation_role'], 'maintenance_manager');
    // Notification Contract: the fixed next_step, and a human-readable subject rather than a raw
    // id (the 7.2 Group 4 patch). Selecting these without asserting them proved nothing.
    assert.strictEqual(notification?.['status_verb'], 'Overdue');
    assert.strictEqual(
      notification?.['next_step'],
      'Schedule re-examination; the asset is locked until re-examined',
    );
    const overdueLabel = notification?.['actor_label'] as string;
    assert.ok(
      overdueLabel.includes('osh_code') && !overdueLabel.startsWith(assetId),
      `actor_label must name the asset, not a raw id: ${overdueLabel}`,
    );
  });

  it('AC1: an overdue statutory examination blocks return-to-service end to end', async () => {
    const assetId = await createAsset();
    // The asset is put into its baseline status BEFORE the examination goes overdue.
    const idle = await setStatus(assetId, 'idle');
    assert.strictEqual(idle.status, 200, JSON.stringify(idle.body));

    const { examinationId } = await recordExaminationOk(assetId);
    const flipped = await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });
    assert.strictEqual(flipped.body['examinations_overdue'], 1);
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'overdue');

    const blocked = await setStatus(assetId, 'running');
    assert.strictEqual(blocked.status, 423, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'STATUTORY_EXAMINATION_OVERDUE');

    const status = await getStatus(assetId);
    assert.strictEqual((status.body['status'] as Record<string, string>)['status'], 'idle');
    assert.strictEqual(
      await domainEventCountFor('maintenance.asset_status_changed', 'asset_id', assetId),
      1,
    );
  });

  it('AC1: a re-stamp transitions an overdue examination back to compliant', async () => {
    const assetId = await createAsset();
    const { examinationId } = await recordExaminationOk(assetId);
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'overdue');

    const reStamp = await recordExamination(assetId, {
      certificate_number_ext: 'RESTAMP-CERT',
      examined_on: OVERDUE_SCAN_DATE,
      interval_months: 24,
      business_date: OVERDUE_SCAN_DATE,
    });
    assert.strictEqual(reStamp.status, 201, JSON.stringify(reStamp.body));
    const row = await examinationRow(examinationId);
    assert.strictEqual(row?.['status'], 'compliant');
    assert.strictEqual(row?.['next_due_date'], addMonths(OVERDUE_SCAN_DATE, 24));
  });

  it('GET /statutory-examinations lists filterable and paginated, and GET by id returns history', async () => {
    const assetA = await createAsset();
    const { examinationId } = await recordExaminationOk(assetA, {
      certificate_number_ext: 'LIST-CERT-1',
    });
    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/statutory-examinations?asset_id=${assetA}&status=compliant`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const examinations = list.body['examinations'] as Record<string, string>[];
    assert.strictEqual(examinations.length, 1);
    assert.strictEqual(examinations[0]!['asset_id'], assetA);

    const badStatus = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/statutory-examinations?status=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badStatus.status, 400);

    // A second, independent asset keeps the grain unique (one examination per (asset, type)).
    const assetB = await createAsset();
    await recordExaminationOk(assetB, { certificate_number_ext: 'LIST-CERT-2' });
    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/statutory-examinations/${examinationId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(detail.status, 200, JSON.stringify(detail.body));
    const records = detail.body['records'] as Record<string, unknown>[];
    assert.strictEqual(records.length, 1);

    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/statutory-examinations/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'EXAMINATION_NOT_FOUND');
  });

  it('AD-16: a replay of the statutory record returns the same examination and writes no event', async () => {
    const assetId = await createAsset();
    const idempotencyKey = randomUUID();
    const body = {
      asset_id: assetId,
      examination_type: 'osh_code',
      interval_months: 12,
      examined_on: ANCHOR,
      certificate_number_ext: 'REPLAY-CERT',
      business_date: ANCHOR,
      idempotency_key: idempotencyKey,
    };
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/statutory-examinations',
      body,
      supervisorHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstId = (first.body['examination'] as Record<string, string>)['examination_id']!;

    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/statutory-examinations',
      { ...body, certificate_number_ext: 'REPLAY-CERT-CHANGED' },
      supervisorHeaders,
    );
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    const replayId = (replay.body['examination'] as Record<string, string>)['examination_id']!;
    assert.strictEqual(replayId, firstId);
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.statutory_examination_recorded',
        'examination_id',
        firstId,
      ),
      1,
    );
  });

  // -------------------------------------------------------------------------
  // AC2: weighbridge out-of-stamp lockout and re-stamp unblock
  // -------------------------------------------------------------------------

  it('AC2: a weighbridge whose stamp is overdue blocks trade weighment with 423 WEIGHBRIDGE_OUT_OF_STAMP', async () => {
    const { token, poRef } = await seedWeighbridgeChain();
    const assetId = await createAsset();
    await recordExaminationOk(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: 'WB-DEVICE-7-6',
      certificate_number_ext: 'STAMP-1',
    });
    // Scoped to this asset. An unscoped scan sweeps the WHOLE register and flips every still
    // compliant examination other tests left behind, emitting their notifications too.
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });

    const body = wbBody(token, poRef);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      body,
      weighOperatorHeaders,
    );
    assert.strictEqual(res.status, 423, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WEIGHBRIDGE_OUT_OF_STAMP');
    // The Testing Requirements name the PROJECTION assertion separately from the event one: no
    // weighbridge_event row may exist either, or a lockout that only suppressed the event while
    // still recording the weighment would pass.
    assert.strictEqual(await weighbridgeEventCountFor(poRef), 0);
    assert.strictEqual(
      await domainEventCountFor(
        'weighbridge.recorded',
        'weighbridge_event_id',
        body['weighbridge_event_id'] as string,
      ),
      0,
    );
  });

  it('AC2: the lockout is fail-open for device keys not in the register', async () => {
    const { token, poRef } = await seedWeighbridgeChain();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      wbBody(token, poRef, { device_id: 'WB-UNKNOWN-DEVICE' }),
      weighOperatorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  it('AC2: a re-stamp unblocks weighment and the weighment is persisted', async () => {
    const { token, poRef } = await seedWeighbridgeChain();
    const assetId = await createAsset();
    const { examinationId } = await recordExaminationOk(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: 'WB-DEVICE-RE-STAMP',
      certificate_number_ext: 'STAMP-2',
    });
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'overdue');

    const blocked = await makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      wbBody(token, poRef, { device_id: 'WB-DEVICE-RE-STAMP' }),
      weighOperatorHeaders,
    );
    assert.strictEqual(blocked.status, 423, JSON.stringify(blocked.body));

    const reStamp = await recordExamination(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: 'WB-DEVICE-RE-STAMP',
      certificate_number_ext: 'STAMP-2-RENEWED',
      examined_on: OVERDUE_SCAN_DATE,
      interval_months: 12,
      business_date: OVERDUE_SCAN_DATE,
    });
    assert.strictEqual(reStamp.status, 201, JSON.stringify(reStamp.body));
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'compliant');

    const weighment = await makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      wbBody(token, poRef, { device_id: 'WB-DEVICE-RE-STAMP' }),
      weighOperatorHeaders,
    );
    assert.strictEqual(weighment.status, 201, JSON.stringify(weighment.body));
    assert.ok(weighment.body['weighbridge_event_id']);
    // "assert the weighment is persisted" (Testing Requirements 3) means the row, not the id the
    // request supplied echoing back in the response body.
    assert.strictEqual(await weighbridgeEventCountFor(poRef), 1);
    assert.strictEqual(
      await domainEventCountFor(
        'weighbridge.recorded',
        'weighbridge_event_id',
        weighment.body['weighbridge_event_id'] as string,
      ),
      1,
    );
  });

  it('AC2: a completed work order on a weighbridge asset invalidates the stamp', async () => {
    const assetId = await createAsset();
    await recordExaminationOk(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: 'WB-DEVICE-REPAIR',
      certificate_number_ext: 'STAMP-3',
    });
    const before = await getPool().query(
      `SELECT examination_id, status FROM statutory_examination WHERE device_key = 'wb-device-repair'`,
    );
    assert.strictEqual(before.rows[0]!['status'], 'compliant');

    const workOrderId = await insertOpenWorkOrder(assetId);
    const res = await completeWorkOrder(workOrderId, { labor_cost: '1000', parts_cost: '500' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const after = await getPool().query(
      `SELECT examination_id, status FROM statutory_examination WHERE device_key = 'wb-device-repair'`,
    );
    assert.strictEqual(after.rows[0]!['status'], 'overdue');
  });

  // -------------------------------------------------------------------------
  // AC3: cost accumulation, capitalization flag, exact NUMERIC strings
  // -------------------------------------------------------------------------

  it('AC3: closure with labor + parts accumulates per asset with exact NUMERIC strings', async () => {
    const assetId = await createAsset();
    const wo1 = await insertOpenWorkOrder(assetId);
    const res1 = await completeWorkOrder(wo1, { labor_cost: '1000.500', parts_cost: '2000' });
    assert.strictEqual(res1.status, 200, JSON.stringify(res1.body));

    const row1 = await workOrderRow(wo1);
    assert.strictEqual(row1?.['total_cost'], '3000.500');
    assert.strictEqual(row1?.['capitalization_flagged'], false);

    const wo2 = await insertOpenWorkOrder(assetId);
    const res2 = await completeWorkOrder(wo2, { labor_cost: '49000', parts_cost: '2000' });
    assert.strictEqual(res2.status, 200, JSON.stringify(res2.body));

    const row2 = await workOrderRow(wo2);
    assert.strictEqual(row2?.['total_cost'], '51000.000');
    assert.strictEqual(row2?.['capitalization_flagged'], true);

    const costs = await assetCostRow(assetId);
    assert.strictEqual(costs?.['total_labor_cost'], '50000.500');
    assert.strictEqual(costs?.['total_parts_cost'], '4000.000');
    assert.strictEqual(costs?.['total_cost'], '54000.500');
  });

  it('AC3: the capitalization flag is strict - exactly equal to the threshold is NOT flagged', async () => {
    // Read from config, not hardcoded: the threshold is MAINTENANCE_CAPITALIZATION_THRESHOLD, so a
    // literal 50000 stops testing the boundary the moment the env value moves and instead proves
    // only that some sub-threshold amount is unflagged.
    const threshold = config.maintenance.capitalizationThreshold;
    const assetId = await createAsset();

    const atThreshold = await insertOpenWorkOrder(assetId);
    const equal = await completeWorkOrder(atThreshold, { labor_cost: threshold, parts_cost: '0' });
    assert.strictEqual(equal.status, 200, JSON.stringify(equal.body));
    assert.strictEqual((await workOrderRow(atThreshold))?.['capitalization_flagged'], false);

    // One minor unit over, so the comparison is pinned at the boundary from BOTH sides and a
    // regression that rounds to whole units before comparing is caught.
    const overThreshold = await insertOpenWorkOrder(assetId);
    const over = await completeWorkOrder(overThreshold, {
      labor_cost: threshold,
      parts_cost: '0.001',
    });
    assert.strictEqual(over.status, 200, JSON.stringify(over.body));
    assert.strictEqual((await workOrderRow(overThreshold))?.['capitalization_flagged'], true);
  });

  it('AC3: an invalid cost string is rejected 400 INVALID_COST', async () => {
    const assetId = await createAsset();
    const wo = await insertOpenWorkOrder(assetId);
    const res = await completeWorkOrder(wo, { labor_cost: 'abc' });
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_COST');
  });

  it('AC3: an existing completion without cost fields stays zero-cost (story-7-2 regression)', async () => {
    const assetId = await createAsset();
    const wo = await insertOpenWorkOrder(assetId);
    const res = await completeWorkOrder(wo);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const row = await workOrderRow(wo);
    assert.strictEqual(row?.['total_cost'], '0.000');
    assert.strictEqual(row?.['capitalization_flagged'], false);
    // The cost path is skipped entirely for a cost-free completion, so no rollup row exists yet
    // (the additive extension contract: existing behavior unchanged, new behavior opt-in).
    assert.strictEqual(await assetCostRow(assetId), null);
  });

  it('AC3: a forged total_cost on the direct event path is rejected 409 COST_DERIVATION_MISMATCH', async () => {
    const assetId = await createAsset();
    const workOrderId = await insertOpenWorkOrder(assetId);
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.work_order_completed',
        payload: {
          work_order_id: workOrderId,
          asset_id: assetId,
          completed_at: new Date().toISOString(),
          labor_cost: '100',
          parts_cost: '200',
          total_cost: '999',
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error &&
        (err as { errorCode?: string }).errorCode === 'COST_DERIVATION_MISMATCH' &&
        // The seam raises this code from six branches; without the detail this test also passes
        // when the event is refused for a reason that has nothing to do with the forged total.
        (err as { details?: Record<string, unknown> }).details?.['derived_total_cost'] === '300',
    );
  });

  it('AC3: a replay of a completion does not double-count the cost rollup', async () => {
    const assetId = await createAsset();
    const wo = await insertOpenWorkOrder(assetId);
    const idempotencyKey = randomUUID();
    const first = await completeWorkOrder(wo, {
      labor_cost: '1000',
      parts_cost: '500',
      idempotency_key: idempotencyKey,
    });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const replay = await completeWorkOrder(wo, {
      labor_cost: '999999',
      parts_cost: '999999',
      idempotency_key: idempotencyKey,
    });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    const costs = await assetCostRow(assetId);
    assert.strictEqual(costs?.['total_cost'], '1500.000');
    // Task 8.3 in full: the SAME resource returns, and the ledger does not grow.
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(
      await domainEventCountFor('maintenance.work_order_completed', 'work_order_id', wo),
      1,
    );
  });

  it('GET /assets/:assetId/costs and GET /asset-costs read the rollup', async () => {
    const assetId = await createAsset();
    const wo = await insertOpenWorkOrder(assetId);
    await completeWorkOrder(wo, { labor_cost: '2000', parts_cost: '500' });

    const one = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/costs`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(one.status, 200, JSON.stringify(one.body));
    assert.strictEqual((one.body['costs'] as Record<string, string>)['total_cost'], '2500.000');

    const all = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/asset-costs',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    const list = all.body['asset_costs'] as Record<string, string>[];
    assert.ok(list.some((c) => c['total_cost'] === '2500.000'));

    const missingAsset = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${randomUUID()}/costs`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(missingAsset.status, 404);
    assert.strictEqual(missingAsset.body['error_code'], 'ASSET_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // AC4 + AC5: machine status broadcast and return-to-service authority
  // -------------------------------------------------------------------------

  it('AC4: the first status must be idle, then a transition broadcasts to both planning roles', async () => {
    const assetId = await createAsset();

    const invalid = await setStatus(assetId, 'running');
    assert.strictEqual(invalid.status, 400, JSON.stringify(invalid.body));
    assert.strictEqual(invalid.body['error_code'], 'INVALID_STATUS_TRANSITION');

    const idle = await setStatus(assetId, 'idle');
    assert.strictEqual(idle.status, 200, JSON.stringify(idle.body));
    assert.strictEqual((idle.body['status'] as Record<string, string>)['status'], 'idle');

    // The broadcast is a property of the status change, not of 'running' specifically. Driving it
    // with idle -> breakdown keeps this test off the return-to-service DOA path, which the code
    // review of 2026-08-26 widened to cover EVERY transition into 'running'.
    const changed = await setStatus(assetId, 'breakdown');
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    assert.strictEqual((changed.body['status'] as Record<string, string>)['status'], 'breakdown');
    assert.strictEqual(changed.body['notifications_delivered'], 2);
    assert.strictEqual(changed.body['notifications_dropped'], 0);

    const planner = await notificationFor(assetId, 'production_planner');
    const hub = await notificationFor(assetId, 'hub_booking_coordinator');
    assert.ok(planner, 'production_planner notification must exist');
    assert.ok(hub, 'hub_booking_coordinator notification must exist');
    // Exactly one per role per transition, and there were two transitions. A regression that fans
    // the same broadcast out twice used to satisfy a bare "the notification exists" assertion.
    assert.strictEqual(await notificationCountFor(assetId, 'production_planner'), 2);
    assert.strictEqual(await notificationCountFor(assetId, 'hub_booking_coordinator'), 2);
    // Notification Contract: the fixed next_step, and an actor_label naming the asset rather than
    // a raw id. Both were selected by the helper and asserted by nothing.
    for (const notification of [planner, hub]) {
      assert.strictEqual(notification['status_verb'], 'breakdown');
      assert.strictEqual(notification['next_step'], 'Update planning and booking accordingly');
      const label = notification['actor_label'] as string;
      assert.ok(
        label.includes('idle -> breakdown') && !label.startsWith(assetId),
        `actor_label must name the asset and the transition: ${label}`,
      );
    }
    assert.ok(
      (await recipientCountFor('production_planner')) > 0,
      'planner role must resolve a recipient',
    );
    assert.ok(
      (await recipientCountFor('hub_booking_coordinator')) > 0,
      'hub role must resolve a recipient',
    );
  });

  it('AC5: a replay of the status change emits no second notification', async () => {
    const assetId = await createAsset();
    const idempotencyKey = randomUUID();
    const first = await setStatus(assetId, 'idle', { idempotency_key: idempotencyKey });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    // A real transition must happen between the two idempotent calls, and it must be ASSERTED: an
    // unasserted setStatus that silently fails leaves the premise of this test unmet while the test
    // still passes. idle -> maintenance needs no DOA entry, unlike a transition into 'running',
    // and leaves the replay's declared new_status ('breakdown') a legal move from the current row,
    // so the replay reaches the idempotency short-circuit rather than the transition pre-check.
    const between = await setStatus(assetId, 'maintenance');
    assert.strictEqual(between.status, 200, JSON.stringify(between.body));

    const before = await getPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'notification.created'`,
    );
    const replay = await setStatus(assetId, 'idle', {
      idempotency_key: idempotencyKey,
      new_status: 'breakdown',
    });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    const after = await getPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'notification.created'`,
    );
    assert.strictEqual(after.rows[0]!['n'], before.rows[0]!['n']);
    // Task 8.3 in full: the SAME resource returns, and the status-change ledger does not grow
    // either - counting only notifications left the replay contract itself unasserted.
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(
      await domainEventCountFor('maintenance.asset_status_changed', 'asset_id', assetId),
      2,
    );
  });

  it('AC5: return to service without a DOA entry is rejected 409 APPROVAL_UNRESOLVED', async () => {
    // ORDER-COUPLED, and asserted rather than left to a comment: this test is only meaningful while
    // no maintenance.return_to_service DOA entry exists, and the next test creates one permanently.
    // Without this precondition check, running the suite under a name filter or after a reorder
    // turns a real 404 into a 403 and the failure reads as a puzzle rather than a broken premise.
    const doaRows = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM doa_registry_entries
        WHERE transaction_type = 'maintenance.return_to_service' AND active = true`,
    );
    assert.strictEqual(
      doaRows.rows[0]!['n'],
      0,
      'this test must run BEFORE the DOA entry is seeded by the 403 test below',
    );

    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    assert.strictEqual((await setStatus(assetId, 'breakdown')).status, 200);
    const res = await setStatus(assetId, 'running', {}, supervisorHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
    // AC5: the asset remains out of service.
    assert.strictEqual(
      ((await getStatus(assetId)).body['status'] as Record<string, unknown>)['status'],
      'breakdown',
    );
  });

  it('AC5: return to service by a non-approver is rejected 403 APPROVAL_REQUIRED', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    assert.strictEqual((await setStatus(assetId, 'breakdown')).status, 200);

    // Seed the DOA entry now; the 404 test above ran without it.
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'maintenance_supervisor',
        transaction_type: 'maintenance.return_to_service',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));

    const denied = await setStatus(assetId, 'running', {}, technicianHeaders);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'APPROVAL_REQUIRED');
    // AC5: "the asset remains out of service until a supervisor signs off" - the rejection alone
    // does not prove that. Nothing may have been written, and the asset is still broken down.
    assert.strictEqual(
      ((await getStatus(assetId)).body['status'] as Record<string, unknown>)['status'],
      'breakdown',
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.asset_status_changed', 'asset_id', assetId),
      2,
    );

    const approved = await setStatus(assetId, 'running', {}, supervisorHeaders);
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    const status = approved.body['status'] as Record<string, unknown>;
    assert.strictEqual(status['status'], 'running');
    assert.strictEqual(status['sign_off_by'], supervisorUserId);
  });

  it('AC5: a fabricated sign_off_by on the direct event path cannot bypass the gate', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    assert.strictEqual((await setStatus(assetId, 'breakdown')).status, 200);
    const now = new Date().toISOString();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'maintenance.asset_status_changed',
        payload: {
          asset_id: assetId,
          previous_status: 'breakdown',
          new_status: 'running',
          changed_by: supervisorUserId,
          changed_at: now,
          sign_off_by: randomUUID(),
          sign_off_at: now,
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error &&
        (err as { errorCode?: string }).errorCode === 'COST_DERIVATION_MISMATCH' &&
        // Pin the SIGN-OFF branch: the derived approver must be the resolved DOA holder, or this
        // test passes when the event is refused over previous_status or changed_by instead.
        (err as { details?: Record<string, unknown> }).details?.['derived_sign_off_by'] ===
          supervisorUserId,
    );
  });

  it('AC5: invalid transitions and non-sign-off sign-off fields are rejected', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);

    const same = await setStatus(assetId, 'idle');
    assert.strictEqual(same.status, 400, JSON.stringify(same.body));
    assert.strictEqual(same.body['error_code'], 'INVALID_STATUS_TRANSITION');

    // A transition that is not INTO 'running' carries no sign-off; a declared one is a derivation
    // mismatch. (idle -> running is no longer such a transition: the code review of 2026-08-26
    // widened the AC5 gate to every transition into 'running'.)
    const now = new Date().toISOString();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'maintenance.asset_status_changed',
        payload: {
          asset_id: assetId,
          previous_status: 'idle',
          new_status: 'maintenance',
          changed_by: supervisorUserId,
          changed_at: now,
          sign_off_by: supervisorUserId,
          sign_off_at: now,
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error &&
        (err as { errorCode?: string }).errorCode === 'COST_DERIVATION_MISMATCH' &&
        // Pin the NON-RETURN branch by its own detail shape (previous/new status, no sign-off ids).
        (err as { details?: Record<string, unknown> }).details?.['new_status'] === 'maintenance',
    );
  });

  it('GET /asset-status lists statuses filterable by state', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    assert.strictEqual((await setStatus(assetId, 'breakdown')).status, 200);

    const all = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/asset-status',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    assert.ok(
      (all.body['asset_statuses'] as Record<string, string>[]).some(
        (s) => s['asset_id'] === assetId,
      ),
    );

    const breakdown = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/asset-status?status=breakdown',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(breakdown.status, 200);
    const list = breakdown.body['asset_statuses'] as Record<string, string>[];
    assert.ok(list.some((s) => s['asset_id'] === assetId));

    const bad = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/asset-status?status=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(bad.status, 400);
  });

  it('GET /assets/:assetId/status returns 404 for an unknown asset', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${randomUUID()}/status`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body['error_code'], 'ASSET_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // Concurrency: race path must return the SAME code and detail as the sequential path
  // -------------------------------------------------------------------------

  it('CONC: parallel statutory records on the same grain resolve to one success and one stable 409', async () => {
    const assetId = await createAsset();
    const attempt = async (): Promise<{
      ok: boolean;
      errorCode?: string | undefined;
      existingId?: unknown;
    }> => {
      try {
        const examinationId = randomUUID();
        await persistEvent({
          stream_type: 'maintenance',
          stream_id: examinationId,
          event_type: 'maintenance.statutory_examination_recorded',
          payload: {
            examination_id: examinationId,
            asset_id: assetId,
            examination_type: 'osh_code',
            interval_months: 12,
            examined_on: ANCHOR,
            next_due_date: addMonths(ANCHOR, 12),
            certificate_number_ext: `CONC-${randomUUID().slice(0, 6)}`,
            device_key: null,
            business_date: ANCHOR,
            recorded_at: new Date().toISOString(),
          },
          metadata: forgedMetadata(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        return { ok: true };
      } catch (err: unknown) {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return {
          ok: false,
          errorCode: e.errorCode,
          existingId: e.details?.['existing_examination_id'],
        };
      }
    };

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const okCount = [a, b].filter((r) => r.ok).length;
    const fail = [a, b].find((r) => !r.ok);
    assert.strictEqual(okCount, 1);
    assert.ok(fail);
    assert.strictEqual(fail.errorCode, 'DUPLICATE_STATUTORY_EXAMINATION');
    assert.ok(typeof fail.existingId === 'string');
  });

  it('CONC: parallel status changes on the same asset resolve to one success and one stable 409', async () => {
    const assetId = await createAsset();
    const now = new Date().toISOString();
    const attempt = async (): Promise<{
      ok: boolean;
      errorCode?: string | undefined;
      derivedPrevious?: unknown;
    }> => {
      try {
        await persistEvent({
          stream_type: 'maintenance',
          stream_id: assetId,
          event_type: 'maintenance.asset_status_changed',
          payload: {
            asset_id: assetId,
            previous_status: null,
            new_status: 'idle',
            changed_by: supervisorUserId,
            changed_at: now,
            sign_off_by: null,
            sign_off_at: null,
          },
          metadata: forgedMetadata(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        return { ok: true };
      } catch (err: unknown) {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return {
          ok: false,
          errorCode: e.errorCode,
          derivedPrevious: e.details?.['derived_previous_status'],
        };
      }
    };

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const okCount = [a, b].filter((r) => r.ok).length;
    const fail = [a, b].find((r) => !r.ok);
    assert.strictEqual(okCount, 1);
    assert.ok(fail);
    assert.strictEqual(fail.errorCode, 'COST_DERIVATION_MISMATCH');
    // Pin the branch: the loser declared previous_status null and the winner had already written
    // 'idle'. Without this, five other branches of the seam raise the same code.
    assert.strictEqual(fail.derivedPrevious, 'idle');
  });

  it('CONC: parallel records with the same device_key resolve to one success and one stable 409', async () => {
    const assetA = await createAsset();
    const assetB = await createAsset();
    const attempt = async (
      assetId: string,
    ): Promise<{
      ok: boolean;
      errorCode?: string | undefined;
    }> => {
      try {
        const examinationId = randomUUID();
        await persistEvent({
          stream_type: 'maintenance',
          stream_id: examinationId,
          event_type: 'maintenance.statutory_examination_recorded',
          payload: {
            examination_id: examinationId,
            asset_id: assetId,
            examination_type: 'weighbridge_legal_metrology',
            interval_months: 12,
            examined_on: ANCHOR,
            next_due_date: addMonths(ANCHOR, 12),
            certificate_number_ext: null,
            device_key: 'WB-CONC-DEVICE',
            business_date: ANCHOR,
            recorded_at: new Date().toISOString(),
          },
          metadata: forgedMetadata(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        return { ok: true };
      } catch (err: unknown) {
        const e = err as { errorCode?: string };
        return { ok: false, errorCode: e.errorCode };
      }
    };

    const [a, b] = await Promise.all([attempt(assetA), attempt(assetB)]);
    const okCount = [a, b].filter((r) => r.ok).length;
    const fail = [a, b].find((r) => !r.ok);
    assert.strictEqual(okCount, 1);
    assert.ok(fail);
    assert.strictEqual(fail.errorCode, 'DUPLICATE_EVENT');
  });

  // -------------------------------------------------------------------------
  // Code review 2026-08-26 (Group A): regression coverage for the applied patches
  // -------------------------------------------------------------------------

  it('REV: a re-stamp attaches its evidence record to the register row and reads it back', async () => {
    const assetId = await createAsset();
    const deviceKey = `WB-REV-${run}`;
    const { examinationId } = await recordExaminationOk(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: deviceKey,
      certificate_number_ext: 'REV-STAMP-1',
    });
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });

    const reStamp = await recordExamination(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: deviceKey,
      certificate_number_ext: 'REV-STAMP-2',
      examined_on: OVERDUE_SCAN_DATE,
      business_date: OVERDUE_SCAN_DATE,
    });
    assert.strictEqual(reStamp.status, 201, JSON.stringify(reStamp.body));

    // The handler mints a fresh examination_id per POST, so the payload id is NOT the register
    // row's id on a re-stamp. The 201 must still carry the register row, and both evidence rows
    // must hang off that row - not off a payload id no register row was ever keyed to.
    const examination = reStamp.body['examination'] as Record<string, unknown> | null;
    assert.ok(examination, 'the re-stamp 201 must carry the register row, not null');
    assert.strictEqual(examination['examination_id'], examinationId);
    assert.strictEqual(examination['status'], 'compliant');
    assert.strictEqual((reStamp.body['records'] as unknown[]).length, 2);

    const records = await getAdminPool().query(
      `SELECT certificate_number_ext FROM statutory_examination_record
        WHERE examination_id = $1 ORDER BY examined_at ASC, record_id ASC`,
      [examinationId],
    );
    assert.deepStrictEqual(
      records.rows.map((r) => r['certificate_number_ext']),
      ['rev-stamp-1', 'rev-stamp-2'],
    );
  });

  it('REV: a re-stamp that omits device_key keeps the weighbridge mapping governed', async () => {
    const { token, poRef } = await seedWeighbridgeChain();
    const assetId = await createAsset();
    const deviceKey = `WB-KEEP-${run}`;
    const { examinationId } = await recordExaminationOk(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: deviceKey,
      certificate_number_ext: 'KEEP-1',
    });
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });

    const reStamp = await recordExamination(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      certificate_number_ext: 'KEEP-2',
      examined_on: OVERDUE_SCAN_DATE,
      business_date: OVERDUE_SCAN_DATE,
    });
    assert.strictEqual(reStamp.status, 201, JSON.stringify(reStamp.body));
    // device_key is the register row's identity, not per-certificate data: omitting it must not
    // NULL the only mapping from weighbridge_event.device_id back to the register.
    assert.strictEqual(
      (await examinationRow(examinationId))?.['device_key'],
      deviceKey.toLowerCase(),
    );

    await scan(addMonths(OVERDUE_SCAN_DATE, 24), { asset_id: assetId });
    const blocked = await makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      wbBody(token, poRef, { device_id: deviceKey }),
      weighOperatorHeaders,
    );
    assert.strictEqual(blocked.status, 423, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'WEIGHBRIDGE_OUT_OF_STAMP');
  });

  it('REV: whitespace around device_id cannot slip past the weighbridge lockout', async () => {
    const { token, poRef } = await seedWeighbridgeChain();
    const assetId = await createAsset();
    const deviceKey = `WB-TRIM-${run}`;
    await recordExaminationOk(assetId, {
      examination_type: 'weighbridge_legal_metrology',
      device_key: deviceKey,
      certificate_number_ext: 'TRIM-1',
    });
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });

    // The lockout runs BEFORE assertWeighbridgeRecordedShape trims device_id, so it has to
    // canonicalize on its own side or a single leading space fails the register lookup open.
    const blocked = await makeRequest(
      port,
      'POST',
      '/api/v1/weighbridge-events',
      wbBody(token, poRef, { device_id: `  ${deviceKey}  ` }),
      weighOperatorHeaders,
    );
    assert.strictEqual(blocked.status, 423, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'WEIGHBRIDGE_OUT_OF_STAMP');
  });

  it('REV: a forged total_cost with no labor_cost or parts_cost is rejected', async () => {
    const assetId = await createAsset();
    const workOrderId = await insertOpenWorkOrder(assetId);
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.work_order_completed',
        payload: {
          work_order_id: workOrderId,
          asset_id: assetId,
          completed_at: new Date().toISOString(),
          total_cost: '999999',
          capitalization_flagged: true,
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error &&
        (err as { errorCode?: string }).errorCode === 'COST_DERIVATION_MISMATCH' &&
        // Pin the UNDERIVABLE-DECLARATION branch: with no labor_cost and no parts_cost there is
        // nothing to derive from, so the detail names the declared value and no derived one.
        (err as { details?: Record<string, unknown> }).details?.['declared_total_cost'] ===
          '999999',
    );
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'open');
  });

  it('REV: a declared total_cost at a different NUMERIC scale is accepted', async () => {
    const assetId = await createAsset();
    const workOrderId = await insertOpenWorkOrder(assetId);
    // '100.500' is what the projection renders for NUMERIC(14,3); the SQL sum renders '100.5'.
    // The comparison runs in NUMERIC, so echoing the projection's own value must not 409.
    await persistEvent({
      stream_type: 'maintenance',
      stream_id: workOrderId,
      event_type: 'maintenance.work_order_completed',
      payload: {
        work_order_id: workOrderId,
        asset_id: assetId,
        completed_at: new Date().toISOString(),
        labor_cost: '100.5',
        parts_cost: '0',
        total_cost: '100.500',
      },
      metadata: forgedMetadata(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    assert.strictEqual((await workOrderRow(workOrderId))?.['total_cost'], '100.500');
  });

  it('REV: an explicit null cost field is treated as absent and writes no rollup row', async () => {
    const assetId = await createAsset();
    const workOrderId = await insertOpenWorkOrder(assetId);
    await persistEvent({
      stream_type: 'maintenance',
      stream_id: workOrderId,
      event_type: 'maintenance.work_order_completed',
      payload: {
        work_order_id: workOrderId,
        asset_id: assetId,
        completed_at: new Date().toISOString(),
        labor_cost: null,
        parts_cost: null,
      },
      metadata: forgedMetadata(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    assert.strictEqual((await workOrderRow(workOrderId))?.['total_cost'], '0.000');
    assert.strictEqual(await assetCostRow(assetId), null);
  });

  it('REV: a direct asset_status_changed cannot move an asset whose examination is overdue', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    await recordExaminationOk(assetId, { certificate_number_ext: `AC1-BYPASS-${run}` });
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });

    // AD-12: the AC1 use-lock lives in the seam, not only in setAssetStatusBase, so the direct
    // event path cannot walk a statutorily locked asset back into service.
    const now = new Date().toISOString();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'maintenance.asset_status_changed',
        payload: {
          asset_id: assetId,
          previous_status: 'idle',
          new_status: 'running',
          changed_by: supervisorUserId,
          changed_at: now,
          sign_off_by: null,
          sign_off_at: null,
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error &&
        (err as { errorCode?: string }).errorCode === 'STATUTORY_EXAMINATION_OVERDUE',
    );
    assert.strictEqual(
      ((await getStatus(assetId)).body['status'] as Record<string, unknown>)['status'],
      'idle',
    );
  });

  it('REV: a direct return-to-service with no sign_off_by is rejected APPROVAL_REQUIRED', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    assert.strictEqual((await setStatus(assetId, 'breakdown')).status, 200);

    // A MISSING sign-off is AC5's APPROVAL_REQUIRED; only a fabricated one is the 409 derivation
    // mismatch asserted by the test above.
    const now = new Date().toISOString();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'maintenance.asset_status_changed',
        payload: {
          asset_id: assetId,
          previous_status: 'breakdown',
          new_status: 'running',
          changed_by: supervisorUserId,
          changed_at: now,
          sign_off_by: null,
          sign_off_at: null,
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error && (err as { errorCode?: string }).errorCode === 'APPROVAL_REQUIRED',
    );
  });

  // -------------------------------------------------------------------------
  // Code review 2026-08-26 (Group B): regression coverage for the applied patches
  // -------------------------------------------------------------------------

  it('REV: the completion response and the work-order GET expose the derived cost fields', async () => {
    const assetId = await createAsset();
    const workOrderId = await insertOpenWorkOrder(assetId);
    const res = await completeWorkOrder(workOrderId, {
      labor_cost: '60000',
      parts_cost: '1000.250',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    // Without these on the read model the server-derived capitalization decision would be
    // write-only: nothing outside the projection table could ever see it.
    const completed = res.body['work_order'] as Record<string, unknown>;
    assert.strictEqual(completed['labor_cost'], '60000.000');
    assert.strictEqual(completed['parts_cost'], '1000.250');
    assert.strictEqual(completed['total_cost'], '61000.250');
    assert.strictEqual(completed['capitalization_flagged'], true);

    const fetched = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(fetched.status, 200, JSON.stringify(fetched.body));
    const row = fetched.body['work_order'] as Record<string, unknown>;
    assert.strictEqual(row['total_cost'], '61000.250');
    assert.strictEqual(row['capitalization_flagged'], true);
  });

  it('REV: breakdown -> idle -> running cannot dodge the AC5 sign-off gate', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    assert.strictEqual((await setStatus(assetId, 'breakdown')).status, 200);
    // The two-hop laundering path: breakdown -> idle carries no sign-off by design.
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);

    // idle -> running is a return to service too, so a non-approver is still refused.
    const denied = await setStatus(assetId, 'running', {}, technicianHeaders);
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
    assert.strictEqual(denied.body['error_code'], 'APPROVAL_REQUIRED');
    // AC5: the machine stays out of service and nothing was written.
    assert.strictEqual(
      ((await getStatus(assetId)).body['status'] as Record<string, unknown>)['status'],
      'idle',
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.asset_status_changed', 'asset_id', assetId),
      3,
    );

    const approved = await setStatus(assetId, 'running', {}, supervisorHeaders);
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    assert.strictEqual(
      (approved.body['status'] as Record<string, unknown>)['sign_off_by'],
      supervisorUserId,
    );
  });

  it('REV: an overdue examination locks the asset from use but not from maintenance', async () => {
    const assetId = await createAsset();
    assert.strictEqual((await setStatus(assetId, 'idle')).status, 200);
    await recordExaminationOk(assetId, { certificate_number_ext: `AC1-SCOPE-${run}` });
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });

    // Locked from USE: the transition into service is refused.
    const running = await setStatus(assetId, 'running', {}, supervisorHeaders);
    assert.strictEqual(running.status, 423, JSON.stringify(running.body));
    assert.strictEqual(running.body['error_code'], 'STATUTORY_EXAMINATION_OVERDUE');

    // Not frozen: the asset can still be taken into maintenance to perform the re-examination,
    // and that change still broadcasts to planning and hub booking.
    const maintenance = await setStatus(assetId, 'maintenance', {}, supervisorHeaders);
    assert.strictEqual(maintenance.status, 200, JSON.stringify(maintenance.body));
    assert.strictEqual(
      (maintenance.body['status'] as Record<string, unknown>)['status'],
      'maintenance',
    );
    assert.strictEqual(maintenance.body['notifications_delivered'], 2);
  });

  it('REV: an out-of-bigint-range offset returns an empty page, not a 500', async () => {
    for (const path of [
      '/api/v1/maintenance/statutory-examinations?offset=99999999999999999999',
      '/api/v1/maintenance/asset-status?offset=99999999999999999999',
      '/api/v1/maintenance/asset-costs?offset=99999999999999999999',
    ]) {
      const res = await makeRequest(port, 'GET', path, undefined, readerHeaders);
      assert.strictEqual(res.status, 200, `${path} -> ${JSON.stringify(res.body)}`);
    }
  });

  it('REV: the scan reports delivered notifications and an empty failure list', async () => {
    const assetId = await createAsset();
    await recordExaminationOk(assetId, { certificate_number_ext: `SCAN-RESULT-${run}` });
    const res = await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['examinations_overdue'], 1);
    assert.strictEqual(res.body['notifications_delivered'], 1);
    assert.strictEqual(res.body['notifications_dropped'], 0);
    assert.deepStrictEqual(res.body['examinations_failed'], []);
    // examinations_evaluated is the counter that reveals an over-broad scan scope: the scope must
    // be narrowed in SQL, not by a JS filter after the fact, or it overstates what was looked at.
    assert.strictEqual(res.body['examinations_evaluated'], 1);
  });

  it('REV: a replayed scan neither re-flips nor re-notifies (Task 8.3, scan write route)', async () => {
    const assetId = await createAsset();
    const { examinationId } = await recordExaminationOk(assetId, {
      certificate_number_ext: `SCAN-REPLAY-${run}`,
    });
    const idempotencyKey = randomUUID();

    const first = await scan(OVERDUE_SCAN_DATE, {
      asset_id: assetId,
      idempotency_key: idempotencyKey,
    });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body['examinations_overdue'], 1);

    const notificationsBefore = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'notification.created'`,
    );
    const replay = await scan(OVERDUE_SCAN_DATE, {
      asset_id: assetId,
      idempotency_key: idempotencyKey,
    });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    // The grain is already overdue, so the second pass evaluates nothing and writes nothing.
    assert.strictEqual(replay.body['examinations_overdue'], 0);
    assert.strictEqual(replay.body['examinations_evaluated'], 0);
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.statutory_examination_overdue',
        'examination_id',
        examinationId,
      ),
      1,
    );
    const notificationsAfter = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'notification.created'`,
    );
    assert.strictEqual(notificationsAfter.rows[0]!['n'], notificationsBefore.rows[0]!['n']);
  });

  it('REV: a second overdue flip on the same grain is refused DUPLICATE_STATUTORY_EXAMINATION_OVERDUE', async () => {
    const assetId = await createAsset();
    const { examinationId } = await recordExaminationOk(assetId, {
      certificate_number_ext: `DUP-OVERDUE-${run}`,
    });
    const row = await examinationRow(examinationId);
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'overdue');

    // The code the scan's lost-race skip depends on (Table 9). Without a test that provokes it,
    // a rename or a status-code change would silently turn one lost race into a failed scan.
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: examinationId,
        event_type: 'maintenance.statutory_examination_overdue',
        payload: {
          examination_id: examinationId,
          asset_id: assetId,
          examination_type: 'osh_code',
          next_due_date: row?.['next_due_date'],
          business_date: OVERDUE_SCAN_DATE,
          flagged_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        err instanceof Error &&
        (err as { errorCode?: string }).errorCode === 'DUPLICATE_STATUTORY_EXAMINATION_OVERDUE',
    );
  });

  it('REV: the same certificate number cannot be recorded twice on one examination', async () => {
    const assetId = await createAsset();
    const certificate = `DUP-CERT-${run}`;
    const { examinationId } = await recordExaminationOk(assetId, {
      certificate_number_ext: certificate,
    });
    await scan(OVERDUE_SCAN_DATE, { asset_id: assetId });

    // uq_statutory_examination_record_number, the one new unique index with no coverage at all.
    // A re-stamp reusing the certificate number of the record it replaces must be refused.
    const reused = await recordExamination(assetId, {
      certificate_number_ext: certificate,
      examined_on: OVERDUE_SCAN_DATE,
      business_date: OVERDUE_SCAN_DATE,
    });
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    const details = detailsOf(reused.body);
    assert.strictEqual(details?.['certificate_number_ext'], certificate.toLowerCase());
    assert.strictEqual(details?.['examination_id'], examinationId);

    const records = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM statutory_examination_record WHERE examination_id = $1`,
      [examinationId],
    );
    assert.strictEqual(records.rows[0]!['n'], 1);
    assert.strictEqual((await examinationRow(examinationId))?.['status'], 'overdue');
  });
});

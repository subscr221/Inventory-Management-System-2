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

// Story 7.7: AMC, Warranty, and Insurance Tracking (FR-M-10, FR-M-11). Runs against the PRODUCTION
// router surface (createAppRouter) with real auth, RBAC and PostgreSQL - no mocks of the DB or the
// event store. The harness is the Story 7.6 pattern extended with the coverage projections and the
// Story 7.3 fault chain that produces breakdown work orders.
//
// Time is controlled entirely through explicit business_date parameters and coverage dates, so no
// clock mocking is needed - EXCEPT where the Story 7.3 accept handler derives its own business_date
// from the wall clock (a pre-existing behaviour this story inherits, logged to deferred-work): the
// warranty-check tests therefore anchor on TODAY, the same value that handler computes.
//
// The maintenance stream is blocked at the direct-events HTTP guard (INVALID_EVENT_STREAM), so the
// seam-level rejection codes (COVERAGE_DERIVATION_MISMATCH, APPROVAL_REQUIRED on completion) are
// exercised through direct persistEvent calls - the enforcement surface a direct write would hit.

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

/**
 * A FIXED anchor date, deliberately not derived from the wall clock. Every alert window and
 * business_date in the AC 1 suite is expressed relative to it, so no staged-alert test can flip on
 * a clock-window boundary.
 */
const ANCHOR = '2026-06-01';
/** The date the Story 7.3 accept handler itself derives; the warranty-check suite anchors on it. */
const TODAY = new Date().toISOString().slice(0, 10);

const REASON_CODE = config.maintenance.warrantyOverrideReasonCodes[0]!;

describe('Story 7.7 AMC, Warranty, and Insurance Tracking', () => {
  let server: Server;
  let port: number;
  let siteLocId: string;
  let supervisorUserId: string;
  let supervisorHeaders: Record<string, string>;
  let technicianHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let procurementHeaders: Record<string, string>;

  // --- helpers -------------------------------------------------------------

  async function seedLocation(codeSuffix: string): Promise<string> {
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), `LOC-7-7-${run}-${codeSuffix}`, randomUUID()],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function createAsset(): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-7-7-${randomUUID().slice(0, 12)}`,
        asset_name: `Machine ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: 'critical',
      },
      supervisorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_id']!;
  }

  async function recordCoverage(
    assetId: string,
    overrides: Record<string, unknown> = {},
    headers: Record<string, string> = supervisorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/coverages`,
      {
        coverage_type: 'amc',
        provider_name: 'Acme Service Co',
        reference_number_ext: `AMC-${randomUUID().slice(0, 8)}`,
        start_date: ANCHOR,
        expiry_date: addDays(ANCHOR, 120),
        business_date: ANCHOR,
        ...overrides,
      },
      headers,
    );
  }

  async function recordCoverageOk(
    assetId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ coverageId: string; res: HttpResult }> {
    const res = await recordCoverage(assetId, overrides);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const coverage = res.body['coverage'] as Record<string, string>;
    return { coverageId: coverage['coverage_id']!, res };
  }

  async function scan(
    businessDate: string,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/coverages/scan',
      { business_date: businessDate, ...overrides },
      supervisorHeaders,
    );
  }

  /**
   * An ACTIVE warranty at TODAY, inserted directly. Used only where the coverage must already be
   * lapsed or where the API's fail-closed date gates would (correctly) refuse the fixture.
   */
  async function insertCoverageFixture(
    assetId: string,
    coverageType: string,
    startDate: string,
    expiryDate: string,
  ): Promise<string> {
    const coverageId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO asset_coverage (
        coverage_id, asset_id, coverage_type, provider_name, reference_number_ext,
        start_date, expiry_date, contract_value, recorded_by, recorded_at
      ) VALUES ($1,$2,$3,'Fixture Provider',$4,$5::date,$6::date,NULL,$7,now())`,
      [
        coverageId,
        assetId,
        coverageType,
        `FIX-${randomUUID().slice(0, 8)}`,
        startDate,
        expiryDate,
        supervisorUserId,
      ],
    );
    return coverageId;
  }

  async function definePolicy(criticalityClass: string, safetyFlag: boolean): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      {
        criticality_class: criticalityClass,
        safety_flag: safetyFlag,
        priority: 'p1',
        response_minutes: 30,
        resolution_hours: 4,
      },
      supervisorHeaders,
    );
    assert.ok(
      res.status === 201 || res.body['error_code'] === 'DUPLICATE_SLA_POLICY',
      JSON.stringify(res.body),
    );
  }

  /** Reports a fault and accepts it, returning the created breakdown work order. */
  async function breakdownWorkOrder(assetId: string): Promise<Record<string, unknown>> {
    const reported = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/fault-reports',
      { asset_id: assetId, description: `Fault ${randomUUID().slice(0, 6)}` },
      supervisorHeaders,
    );
    assert.strictEqual(reported.status, 201, JSON.stringify(reported.body));
    const faultReportId = (reported.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;
    const accepted = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/accept`,
      {},
      supervisorHeaders,
    );
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    return accepted.body['work_order'] as Record<string, unknown>;
  }

  /** Inserts an open PREVENTIVE work order directly (the harness seeds projections as fixtures). */
  async function insertPreventiveWorkOrder(assetId: string): Promise<string> {
    const workOrderId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO maintenance_work_order (
        work_order_id, plan_id, asset_id, origin, due_date, grace_until_date,
        status, generated_for_cycle, created_at, updated_at
      ) VALUES ($1, $2, $3, 'preventive', $4, $4, 'open', $5, now(), now())`,
      [workOrderId, randomUUID(), assetId, ANCHOR, `cycle-${randomUUID().slice(0, 8)}`],
    );
    return workOrderId;
  }

  async function completeWorkOrder(
    workOrderId: string,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/complete`,
      body,
      supervisorHeaders,
    );
  }

  async function recordOverride(
    workOrderId: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = supervisorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/warranty-overrides`,
      { reason_code: REASON_CODE, ...body },
      headers,
    );
  }

  async function coverageRow(coverageId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT coverage_id, asset_id, coverage_type, provider_name, reference_number_ext,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              contract_value::text AS contract_value, recorded_by
         FROM asset_coverage WHERE coverage_id = $1`,
      [coverageId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function alertRowsFor(coverageId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT alert_id, stage_days, to_char(business_date, 'YYYY-MM-DD') AS business_date
         FROM asset_coverage_alert WHERE coverage_id = $1 ORDER BY stage_days ASC`,
      [coverageId],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function workOrderRow(workOrderId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT work_order_id, status, warranty_flagged, warranty_coverage_id,
              labor_cost::text AS labor_cost, parts_cost::text AS parts_cost,
              total_cost::text AS total_cost, capitalization_flagged
         FROM maintenance_work_order WHERE work_order_id = $1`,
      [workOrderId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function persistedPayloadFor(
    eventType: string,
    idField: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT payload FROM domain_events WHERE event_type = $1 AND payload->>$2 = $3
        ORDER BY created_at DESC LIMIT 1`,
      [eventType, idField, id],
    );
    return (r.rows[0]?.['payload'] as Record<string, unknown>) ?? null;
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

  async function notificationFor(
    objectId: string,
    targetRole: string,
  ): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role,
              payload->>'next_step' AS next_step,
              payload->>'actor_label' AS actor_label,
              payload->>'status_verb' AS status_verb,
              payload->>'object_type' AS object_type,
              payload->'escalation'->>'target_role' AS escalation_role,
              payload->'escalation'->>'acknowledgment_window_seconds' AS escalation_window
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

  /** Replicates src/notify/dispatch.ts resolveTargetUserIds for a null-location target. */
  async function recipientCountFor(role: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(DISTINCT user_id)::int AS n FROM user_role_assignments WHERE role = $1`,
      [role],
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

  /**
   * Seeds the maintenance.warranty_override DOA entry once. The APPROVAL_UNRESOLVED test above
   * asserts the registry is EMPTY before this runs, so the seeding is deliberately lazy rather
   * than part of before(): both the no-entry and the resolved-approver paths need to be reachable
   * in one suite run.
   */
  async function seedWarrantyOverrideDoa(): Promise<void> {
    const existing = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM doa_registry_entries
        WHERE transaction_type = 'maintenance.warranty_override' AND active = true`,
    );
    if ((existing.rows[0]!['n'] as number) > 0) return;
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'maintenance_supervisor',
        transaction_type: 'maintenance.warranty_override',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));
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
      '../../read/projections/notification.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/asset.sql',
      '../../read/projections/maintenance_plan.sql',
      '../../read/projections/maintenance_work_order.sql',
      '../../read/projections/maintenance_sla_policy.sql',
      '../../read/projections/maintenance_fault_report.sql',
      '../../read/projections/maintenance_downtime.sql',
      '../../read/projections/maintenance_asset_cost.sql',
      '../../read/projections/statutory_examination.sql',
      '../../read/projections/asset_coverage.sql',
      '../../read/projections/asset_coverage_alert.sql',
      '../../read/projections/maintenance_warranty_override.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE maintenance_warranty_override, asset_coverage_alert, asset_coverage, statutory_examination, maintenance_asset_cost, maintenance_downtime, maintenance_fault_report, maintenance_work_order, maintenance_sla_policy, maintenance_plan, asset, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    // The supervisor holds the LITERAL role the DOA entry routes to and the escalation targets.
    supervisorUserId = await provisionUser(port, `maint-sup-7-7-${run}@example.com`, [
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
    supervisorHeaders = await authFor(port, `maint-sup-7-7-${run}@example.com`);

    // A maintenance technician who is NOT the resolved warranty-override approver (403 path).
    await provisionUser(port, `maint-tech-7-7-${run}@example.com`, [
      {
        role: 'maintenance_technician',
        module: 'maintenance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    technicianHeaders = await authFor(port, `maint-tech-7-7-${run}@example.com`);

    await provisionUser(port, `maint-reader-7-7-${run}@example.com`, [
      {
        role: `maintenance_reader_7_7_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    readerHeaders = await authFor(port, `maint-reader-7-7-${run}@example.com`);

    await provisionUser(port, `compliance-7-7-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-7-7-${run}@example.com`);

    // A user with NO maintenance grant at all: the RBAC 403 path.
    await provisionUser(port, `proc-7-7-${run}@example.com`, [
      { role: 'buyer', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);
    procurementHeaders = await authFor(port, `proc-7-7-${run}@example.com`);

    // The alert target must resolve to at least one REAL recipient (the Story 7.4 lesson): a
    // notification aimed at a role no user holds fans out to zero and still reports success.
    await provisionUser(port, `maint-mgr-7-7-${run}@example.com`, [
      {
        role: 'maintenance_manager',
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);

    await definePolicy('critical', false);
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: staged 90/60/30-day expiry alerts
  // -------------------------------------------------------------------------

  it('AC1: both notification roles resolve to real recipients', async () => {
    assert.ok(
      (await recipientCountFor('maintenance_manager')) > 0,
      'maintenance_manager must have a holder or every alert fans out to nobody',
    );
    assert.ok(
      (await recipientCountFor('maintenance_supervisor')) > 0,
      'maintenance_supervisor must have a holder or every escalation fans out to nobody',
    );
  });

  it('AC1: each of the 90, 60 and 30-day stages fires exactly once, for all three coverage types', async () => {
    const expiry = addDays(ANCHOR, 120);
    const assetId = await createAsset();
    const coverages: string[] = [];
    for (const coverageType of ['amc', 'warranty', 'insurance']) {
      const { coverageId } = await recordCoverageOk(assetId, {
        coverage_type: coverageType,
        expiry_date: expiry,
      });
      coverages.push(coverageId);
    }

    for (const stage of [90, 60, 30]) {
      const res = await scan(addDays(expiry, -stage), { asset_id: assetId });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body['alerts_raised'], 3, `stage ${stage} must fire for all three`);
      assert.strictEqual(res.body['notifications_delivered'], 3);
      assert.strictEqual(res.body['notifications_dropped'], 0);
    }

    for (const coverageId of coverages) {
      const rows = await alertRowsFor(coverageId);
      assert.deepStrictEqual(
        rows.map((r) => r['stage_days']),
        [30, 60, 90],
      );
      for (const row of rows) {
        assert.strictEqual(
          await notificationCountFor(row['alert_id'] as string, 'maintenance_manager'),
          1,
        );
      }
    }
  });

  it('AC1: only the 30-day stage escalates, and the alert text is human-readable', async () => {
    const expiry = addDays(ANCHOR, 200);
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      reference_number_ext: `W-ESC-${randomUUID().slice(0, 8)}`,
      expiry_date: expiry,
    });

    await scan(addDays(expiry, -90), { asset_id: assetId });
    await scan(addDays(expiry, -60), { asset_id: assetId });
    await scan(addDays(expiry, -30), { asset_id: assetId });

    const rows = await alertRowsFor(coverageId);
    const byStage = new Map(rows.map((r) => [r['stage_days'] as number, r['alert_id'] as string]));
    assert.strictEqual(byStage.size, 3);

    for (const stage of [90, 60]) {
      const notification = await notificationFor(byStage.get(stage)!, 'maintenance_manager');
      assert.ok(notification, `stage ${stage} notification missing`);
      assert.strictEqual(notification['escalation_role'], null, `stage ${stage} must not escalate`);
    }

    const urgent = await notificationFor(byStage.get(30)!, 'maintenance_manager');
    assert.ok(urgent);
    assert.strictEqual(urgent['escalation_role'], 'maintenance_supervisor');
    assert.strictEqual(urgent['escalation_window'], '86400');
    assert.strictEqual(urgent['status_verb'], 'Due');
    assert.strictEqual(urgent['object_type'], 'asset_coverage');
    assert.strictEqual(urgent['next_step'], 'Renew the contract or record a new coverage');
    // A human-readable subject, never a raw id.
    assert.match(String(urgent['actor_label']), /warranty W-ESC-/);
    assert.match(String(urgent['actor_label']), /30 days remaining/);
  });

  it('AC1: a same-business_date re-run is a no-op', async () => {
    const expiry = addDays(ANCHOR, 150);
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, { expiry_date: expiry });

    const first = await scan(addDays(expiry, -90), { asset_id: assetId });
    assert.strictEqual(first.body['alerts_raised'], 1);
    const second = await scan(addDays(expiry, -90), { asset_id: assetId });
    assert.strictEqual(second.body['alerts_raised'], 0);
    assert.strictEqual(second.body['coverages_evaluated'], 0);
    assert.strictEqual(second.body['notifications_delivered'], 0);
    assert.strictEqual((await alertRowsFor(coverageId)).length, 1);
  });

  it('AC1: a skipped run catches up, firing every unfired due stage most-urgent-first', async () => {
    const expiry = addDays(ANCHOR, 130);
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, { expiry_date: expiry });

    // No scan at -90 or -60: the first run happens with 30 days left.
    const res = await scan(addDays(expiry, -30), { asset_id: assetId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['alerts_raised'], 3, 'every missed stage must catch up');
    const alertIds = res.body['alert_ids'] as string[];
    const stagesInOrder: number[] = [];
    for (const alertId of alertIds) {
      const r = await getAdminPool().query(
        `SELECT stage_days FROM asset_coverage_alert WHERE alert_id = $1`,
        [alertId],
      );
      stagesInOrder.push(r.rows[0]!['stage_days'] as number);
    }
    assert.deepStrictEqual(stagesInOrder, [30, 60, 90], 'most-urgent stage must fire first');
    assert.strictEqual((await alertRowsFor(coverageId)).length, 3);
  });

  it('AC1: a renewal earns a fresh set of stages while the old coverage keeps its fired ones', async () => {
    const expiry = addDays(ANCHOR, 100);
    const assetId = await createAsset();
    const { coverageId: original } = await recordCoverageOk(assetId, {
      coverage_type: 'amc',
      reference_number_ext: `AMC-ORIG-${randomUUID().slice(0, 6)}`,
      expiry_date: expiry,
    });
    await scan(addDays(expiry, -90), { asset_id: assetId });
    assert.strictEqual((await alertRowsFor(original)).length, 1);

    const renewalExpiry = addDays(expiry, 365);
    const { coverageId: renewal } = await recordCoverageOk(assetId, {
      coverage_type: 'amc',
      reference_number_ext: `AMC-RENEW-${randomUUID().slice(0, 6)}`,
      expiry_date: renewalExpiry,
    });
    const res = await scan(addDays(renewalExpiry, -90), { asset_id: assetId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    // The original is long expired by this date and is never alerted again.
    assert.strictEqual((await alertRowsFor(original)).length, 1);
    assert.deepStrictEqual(
      (await alertRowsFor(renewal)).map((r) => r['stage_days']),
      [90],
    );
  });

  it('AC1: an already-expired coverage is never alerted', async () => {
    const expiry = addDays(ANCHOR, 60);
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, { expiry_date: expiry });

    const res = await scan(addDays(expiry, 1), { asset_id: assetId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['alerts_raised'], 0);
    assert.strictEqual((await alertRowsFor(coverageId)).length, 0);
  });

  it('AC1: a direct double-flag of the same grain is rejected 409 DUPLICATE_COVERAGE_ALERT', async () => {
    const expiry = addDays(ANCHOR, 95);
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, { expiry_date: expiry });
    const businessDate = addDays(expiry, -90);
    await scan(businessDate, { asset_id: assetId });

    const now = new Date().toISOString();
    const alertId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: alertId,
        event_type: 'maintenance.coverage_expiry_flagged',
        payload: {
          alert_id: alertId,
          coverage_id: coverageId,
          asset_id: assetId,
          coverage_type: 'amc',
          stage_days: 90,
          expiry_date: expiry,
          business_date: businessDate,
          flagged_at: now,
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'DUPLICATE_COVERAGE_ALERT' &&
        (err as { statusCode?: number }).statusCode === 409,
    );
  });

  it('AC1: the scan rejects a missing, malformed or impossible business_date 400', async () => {
    for (const body of [{}, { business_date: 'not-a-date' }, { business_date: '2026-02-30' }]) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/maintenance/coverages/scan',
        body,
        supervisorHeaders,
      );
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
  });

  // -------------------------------------------------------------------------
  // AC2: the warranty check at breakdown work-order creation
  // -------------------------------------------------------------------------

  it('AC2: a breakdown work order on an asset under warranty is flagged with the coverage id', async () => {
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -30),
      expiry_date: addDays(TODAY, 300),
      business_date: TODAY,
    });

    const workOrder = await breakdownWorkOrder(assetId);
    assert.strictEqual(workOrder['warranty_flagged'], true);
    assert.strictEqual(workOrder['warranty_coverage_id'], coverageId);

    const row = await workOrderRow(workOrder['work_order_id'] as string);
    assert.strictEqual(row?.['warranty_flagged'], true);
    assert.strictEqual(row?.['warranty_coverage_id'], coverageId);

    // The DERIVED fields are written back onto the persisted payload, not merely into the row.
    const payload = await persistedPayloadFor(
      'maintenance.breakdown_work_order_created',
      'work_order_id',
      workOrder['work_order_id'] as string,
    );
    assert.strictEqual(payload?.['warranty_flagged'], true);
    assert.strictEqual(payload?.['warranty_coverage_id'], coverageId);
  });

  it('AC2: an asset with no warranty yields an unflagged work order', async () => {
    const assetId = await createAsset();
    // An AMC and an insurance policy are NOT a warranty: only coverage_type warranty flags.
    await recordCoverageOk(assetId, {
      coverage_type: 'amc',
      start_date: addDays(TODAY, -30),
      expiry_date: addDays(TODAY, 300),
      business_date: TODAY,
    });
    await recordCoverageOk(assetId, {
      coverage_type: 'insurance',
      start_date: addDays(TODAY, -30),
      expiry_date: addDays(TODAY, 300),
      business_date: TODAY,
    });

    const workOrder = await breakdownWorkOrder(assetId);
    assert.strictEqual(workOrder['warranty_flagged'], false);
    assert.strictEqual(workOrder['warranty_coverage_id'], null);
  });

  it('AC2: an expired warranty does not flag, and a future-dated one does not either', async () => {
    const assetId = await createAsset();
    await insertCoverageFixture(assetId, 'warranty', addDays(TODAY, -400), addDays(TODAY, -1));
    await insertCoverageFixture(assetId, 'warranty', addDays(TODAY, 5), addDays(TODAY, 400));

    const workOrder = await breakdownWorkOrder(assetId);
    assert.strictEqual(workOrder['warranty_flagged'], false);
    assert.strictEqual(workOrder['warranty_coverage_id'], null);
  });

  it('AC2: two active warranties flag the one expiring last', async () => {
    const assetId = await createAsset();
    const { coverageId: shorter } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      reference_number_ext: `W-SHORT-${randomUUID().slice(0, 6)}`,
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 100),
      business_date: TODAY,
    });
    const { coverageId: longer } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      reference_number_ext: `W-LONG-${randomUUID().slice(0, 6)}`,
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });

    const workOrder = await breakdownWorkOrder(assetId);
    assert.strictEqual(workOrder['warranty_coverage_id'], longer);
    assert.notStrictEqual(workOrder['warranty_coverage_id'], shorter);
  });

  it('AC2: a preventive work order is never warranty-checked (Story 7.2 regression)', async () => {
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrderId = await insertPreventiveWorkOrder(assetId);
    const row = await workOrderRow(workOrderId);
    assert.strictEqual(row?.['warranty_flagged'], false);
    assert.strictEqual(row?.['warranty_coverage_id'], null);
    // And it completes with no override, exactly as before this story.
    const completed = await completeWorkOrder(workOrderId);
    assert.strictEqual(completed.status, 200, JSON.stringify(completed.body));
  });

  it('AC2: a DECLARED warranty_flagged on the direct event path is rejected', async () => {
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });

    const reported = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/fault-reports',
      { asset_id: assetId, description: 'Forged declaration path' },
      supervisorHeaders,
    );
    assert.strictEqual(reported.status, 201, JSON.stringify(reported.body));
    const faultReport = reported.body['fault_report'] as Record<string, string>;
    const faultReportId = faultReport['fault_report_id']!;

    const policyRow = await getAdminPool().query(
      `SELECT policy_id, priority, response_minutes, resolution_hours
         FROM maintenance_sla_policy
        WHERE criticality_class = 'critical' AND safety_flag = false AND status = 'active'`,
    );
    const policy = policyRow.rows[0] as Record<string, unknown>;
    const reportedAtRow = await getAdminPool().query(
      `SELECT reported_at FROM maintenance_fault_report WHERE fault_report_id = $1`,
      [faultReportId],
    );
    const reportedAtMs = (reportedAtRow.rows[0]!['reported_at'] as Date).getTime();
    const responseDue = new Date(
      reportedAtMs + (policy['response_minutes'] as number) * 60000,
    ).toISOString();
    const resolutionDue = new Date(
      reportedAtMs + (policy['resolution_hours'] as number) * 3600000,
    ).toISOString();
    const dueDate = resolutionDue.slice(0, 10);

    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: randomUUID(),
        event_type: 'maintenance.breakdown_work_order_created',
        payload: {
          work_order_id: randomUUID(),
          fault_report_id: faultReportId,
          asset_id: assetId,
          downtime_id: randomUUID(),
          priority: policy['priority'],
          sla_policy_id: policy['policy_id'],
          due_date: dueDate,
          grace_until_date: dueDate,
          sla_response_due_at: responseDue,
          sla_resolution_due_at: resolutionDue,
          business_date: TODAY,
          // The forgery: an active warranty exists, but the caller asserts otherwise.
          warranty_flagged: false,
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return (
          e.errorCode === 'WORK_ORDER_DERIVATION_MISMATCH' &&
          e.details !== undefined &&
          'warranty_flagged' in e.details
        );
      },
    );
  });

  it('AC4: an override with no governing DOA entry is rejected 404 APPROVAL_UNRESOLVED', async () => {
    // ORDER-COUPLED, and asserted rather than left to a comment: this test is only meaningful while
    // no maintenance.warranty_override DOA entry exists, and the next test creates one permanently.
    const doaRows = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM doa_registry_entries
        WHERE transaction_type = 'maintenance.warranty_override' AND active = true`,
    );
    assert.strictEqual(
      doaRows.rows[0]!['n'],
      0,
      'this test must run BEFORE the DOA entry is seeded by the test below',
    );

    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const res = await recordOverride(workOrder['work_order_id'] as string);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
  });

  // -------------------------------------------------------------------------
  // AC3: the chargeable-work gate
  // -------------------------------------------------------------------------

  it('AC3: completing a warranty-flagged work order without an override is rejected 403', async () => {
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    const res = await completeWorkOrder(workOrderId, { labor_cost: '100.000' });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(res.body)?.['warranty_coverage_id'], coverageId);

    // The work order is untouched: no completion, no cost.
    const row = await workOrderRow(workOrderId);
    assert.strictEqual(row?.['status'], 'open');
    assert.strictEqual(row?.['total_cost'], '0.000');
  });

  it('AC3: the gate is in the SEAM, so a direct completion event cannot bypass it (AD-12)', async () => {
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.work_order_completed',
        payload: {
          work_order_id: workOrderId,
          asset_id: assetId,
          completed_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'APPROVAL_REQUIRED' &&
        (err as { statusCode?: number }).statusCode === 403,
    );
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'open');
  });

  it('AC3: an unflagged breakdown work order completes with the Story 7.6 cost arm intact', async () => {
    const assetId = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    assert.strictEqual(workOrder['warranty_flagged'], false);

    const res = await completeWorkOrder(workOrderId, {
      labor_cost: '0.100',
      parts_cost: '0.200',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const row = await workOrderRow(workOrderId);
    assert.strictEqual(row?.['status'], 'completed');
    // Exact NUMERIC arithmetic: a JS float would give 0.30000000000000004.
    assert.strictEqual(row?.['total_cost'], '0.300');
    assert.strictEqual(row?.['capitalization_flagged'], false);
  });

  it('AC3: after an override is recorded, completion succeeds and the cost arm still derives', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    const override = await recordOverride(workOrderId);
    assert.strictEqual(override.status, 201, JSON.stringify(override.body));

    const threshold = config.maintenance.capitalizationThreshold;
    const above = (Number(threshold) + 1).toFixed(3);
    const res = await completeWorkOrder(workOrderId, { labor_cost: above, parts_cost: '0.000' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const row = await workOrderRow(workOrderId);
    assert.strictEqual(row?.['status'], 'completed');
    assert.strictEqual(row?.['total_cost'], above);
    assert.strictEqual(row?.['capitalization_flagged'], true);
  });

  // -------------------------------------------------------------------------
  // AC4: the reason-coded override and its DOA authority
  // -------------------------------------------------------------------------

  it('AC4: the resolved approver records an override and the event captures the decision', async () => {
    await seedWarrantyOverrideDoa();

    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    const res = await recordOverride(workOrderId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const override = res.body['override'] as Record<string, unknown>;
    assert.strictEqual(override['work_order_id'], workOrderId);
    assert.strictEqual(override['warranty_coverage_id'], coverageId);
    assert.strictEqual(override['reason_code'], REASON_CODE);
    assert.strictEqual(override['overridden_by'], supervisorUserId);
    assert.ok(override['overridden_at']);

    // AC4: the override, its reason code and the overriding actor are in the event stream.
    const payload = await persistedPayloadFor(
      'maintenance.warranty_override_recorded',
      'override_id',
      override['override_id'] as string,
    );
    assert.strictEqual(payload?.['reason_code'], REASON_CODE);
    assert.strictEqual(payload?.['overridden_by'], supervisorUserId);
    assert.strictEqual(payload?.['warranty_coverage_id'], coverageId);

    // The read surface answers too.
    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}/warranty-overrides`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(
      (read.body['override'] as Record<string, unknown>)['override_id'],
      override['override_id'],
    );
  });

  it('AC4: a non-approver is rejected 403 APPROVAL_REQUIRED and nothing is written', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    const res = await recordOverride(workOrderId, {}, technicianHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(res.body)?.['resolved_approver_user_id'], supervisorUserId);

    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}/warranty-overrides`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(read.body['override'], null);
    // And the gate still holds.
    assert.strictEqual((await completeWorkOrder(workOrderId)).status, 403);
  });

  it('AC4: a reason code outside the configured list is rejected 422', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const res = await recordOverride(workOrder['work_order_id'] as string, {
      reason_code: 'BECAUSE_I_SAID_SO',
    });
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WARRANTY_OVERRIDE_REASON_INVALID');
  });

  it('AC4: an override on an unflagged work order is rejected 409 WARRANTY_OVERRIDE_NOT_REQUIRED', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    assert.strictEqual(workOrder['warranty_flagged'], false);
    const res = await recordOverride(workOrder['work_order_id'] as string);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'WARRANTY_OVERRIDE_NOT_REQUIRED');
  });

  it('AC4: a second override is rejected 409, identically on the sequential and race paths', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    const first = await recordOverride(workOrderId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const overrideId = (first.body['override'] as Record<string, string>)['override_id']!;

    const second = await recordOverride(workOrderId);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'WARRANTY_OVERRIDE_ALREADY_RECORDED');
    assert.strictEqual(detailsOf(second.body)?.['existing_override_id'], overrideId);

    // The race path: two parallel POSTs on a FRESH flagged work order return the same shape.
    const raceAssetId = await createAsset();
    await recordCoverageOk(raceAssetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const raceWorkOrder = await breakdownWorkOrder(raceAssetId);
    const raceWorkOrderId = raceWorkOrder['work_order_id'] as string;
    const [a, b] = await Promise.all([
      recordOverride(raceWorkOrderId),
      recordOverride(raceWorkOrderId),
    ]);
    const statuses = [a!.status, b!.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    const loser = a!.status === 409 ? a! : b!;
    assert.strictEqual(loser.body['error_code'], 'WARRANTY_OVERRIDE_ALREADY_RECORDED');
    assert.ok(detailsOf(loser.body)?.['existing_override_id'], 'the loser must name the winner');
    const rows = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM maintenance_warranty_override WHERE work_order_id = $1`,
      [raceWorkOrderId],
    );
    assert.strictEqual(rows.rows[0]!['n'], 1);
  });

  it('AC4: an override after completion is rejected 409 WORK_ORDER_ALREADY_COMPLETED', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    assert.strictEqual((await recordOverride(workOrderId)).status, 201);
    assert.strictEqual((await completeWorkOrder(workOrderId)).status, 200);

    // A second work order on the same asset, so the grain is free but the order is closed.
    const closed = await recordOverride(workOrderId);
    assert.strictEqual(closed.status, 409, JSON.stringify(closed.body));
    assert.ok(
      closed.body['error_code'] === 'WORK_ORDER_ALREADY_COMPLETED' ||
        closed.body['error_code'] === 'WARRANTY_OVERRIDE_ALREADY_RECORDED',
      JSON.stringify(closed.body),
    );
  });

  it('AC4: a forged overridden_by on the direct event path is rejected', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.warranty_override_recorded',
        payload: {
          override_id: randomUUID(),
          work_order_id: workOrderId,
          warranty_coverage_id: coverageId,
          reason_code: REASON_CODE,
          overridden_by: randomUUID(),
          overridden_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'COVERAGE_DERIVATION_MISMATCH' &&
        (err as { statusCode?: number }).statusCode === 409,
    );
    // The gate still holds: nothing was recorded.
    assert.strictEqual((await completeWorkOrder(workOrderId)).status, 403);
  });

  it('AC4: a forged warranty_coverage_id on the direct event path is rejected', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.warranty_override_recorded',
        payload: {
          override_id: randomUUID(),
          work_order_id: workOrderId,
          warranty_coverage_id: randomUUID(),
          reason_code: REASON_CODE,
          overridden_by: supervisorUserId,
          overridden_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'COVERAGE_DERIVATION_MISMATCH',
    );
  });

  it('AC4: the override write route replays under the same idempotency key', async () => {
    await seedWarrantyOverrideDoa();
    const assetId = await createAsset();
    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const key = randomUUID();

    const first = await recordOverride(workOrderId, { idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await recordOverride(workOrderId, { idempotency_key: key });
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(
      (replay.body['override'] as Record<string, string>)['override_id'],
      (first.body['override'] as Record<string, string>)['override_id'],
    );
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.warranty_override_recorded',
        'work_order_id',
        workOrderId,
      ),
      1,
    );
  });

  // -------------------------------------------------------------------------
  // Coverage CRUD and platform contracts
  // -------------------------------------------------------------------------

  it('records a coverage, reads it back BY ID, and keeps contract_value exact', async () => {
    const assetId = await createAsset();
    const reference = `  AMC-TRIM-${randomUUID().slice(0, 6)}  `;
    const { coverageId, res } = await recordCoverageOk(assetId, {
      provider_name: '  Acme Service Co  ',
      reference_number_ext: reference,
      contract_value: '12345.678',
    });
    const coverage = res.body['coverage'] as Record<string, unknown>;
    assert.strictEqual(coverage['coverage_id'], coverageId);
    assert.strictEqual(coverage['provider_name'], 'Acme Service Co');
    assert.strictEqual(coverage['reference_number_ext'], reference.trim());
    // Exact decimal round-trip: a JS float would not survive this.
    assert.strictEqual(coverage['contract_value'], '12345.678');
    assert.strictEqual(coverage['recorded_by'], supervisorUserId);

    const row = await coverageRow(coverageId);
    assert.strictEqual(row?.['contract_value'], '12345.678');
    assert.strictEqual(row?.['provider_name'], 'Acme Service Co');

    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/coverages/${coverageId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    assert.strictEqual(
      (read.body['coverage'] as Record<string, string>)['coverage_id'],
      coverageId,
    );
  });

  it('rejects a duplicate reference case-insensitively, sequentially and under a race', async () => {
    const assetId = await createAsset();
    const reference = `W-DUP-${randomUUID().slice(0, 6)}`;
    const { coverageId } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      reference_number_ext: reference,
    });

    const sequential = await recordCoverage(assetId, {
      coverage_type: 'warranty',
      reference_number_ext: reference.toLowerCase(),
    });
    assert.strictEqual(sequential.status, 409, JSON.stringify(sequential.body));
    assert.strictEqual(sequential.body['error_code'], 'DUPLICATE_COVERAGE');
    assert.strictEqual(detailsOf(sequential.body)?.['existing_coverage_id'], coverageId);

    // A different coverage_type with the SAME reference is a different grain and is allowed.
    const otherType = await recordCoverage(assetId, {
      coverage_type: 'amc',
      reference_number_ext: reference,
    });
    assert.strictEqual(otherType.status, 201, JSON.stringify(otherType.body));

    const raceAssetId = await createAsset();
    const raceReference = `W-RACE-${randomUUID().slice(0, 6)}`;
    const [a, b] = await Promise.all([
      recordCoverage(raceAssetId, {
        coverage_type: 'warranty',
        reference_number_ext: raceReference,
      }),
      recordCoverage(raceAssetId, {
        coverage_type: 'warranty',
        reference_number_ext: raceReference.toUpperCase(),
      }),
    ]);
    const statuses = [a!.status, b!.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], `${JSON.stringify(a)} ${JSON.stringify(b)}`);
    const loser = a!.status === 409 ? a! : b!;
    assert.strictEqual(loser.body['error_code'], 'DUPLICATE_COVERAGE');
    assert.ok(detailsOf(loser.body)?.['existing_coverage_id'], 'the loser must name the winner');
  });

  it('rejects an already-expired coverage 422 and a future-start coverage 422', async () => {
    const assetId = await createAsset();
    const expired = await recordCoverage(assetId, {
      start_date: addDays(ANCHOR, -400),
      expiry_date: addDays(ANCHOR, -1),
    });
    assert.strictEqual(expired.status, 422, JSON.stringify(expired.body));
    assert.strictEqual(expired.body['error_code'], 'COVERAGE_ALREADY_EXPIRED');

    const future = await recordCoverage(assetId, {
      start_date: addDays(ANCHOR, 10),
      expiry_date: addDays(ANCHOR, 400),
    });
    assert.strictEqual(future.status, 422, JSON.stringify(future.body));
    assert.strictEqual(future.body['error_code'], 'COVERAGE_FUTURE_START');
  });

  it('rejects impossible calendar dates, an inverted window and a malformed contract_value 400', async () => {
    const assetId = await createAsset();
    const impossible = await recordCoverage(assetId, {
      start_date: '2026-02-30',
      expiry_date: addDays(ANCHOR, 100),
    });
    assert.strictEqual(impossible.status, 400, JSON.stringify(impossible.body));
    assert.strictEqual(impossible.body['error_code'], 'INVALID_PARAMS');

    const inverted = await recordCoverage(assetId, {
      start_date: addDays(ANCHOR, 10),
      expiry_date: ANCHOR,
    });
    assert.strictEqual(inverted.status, 400, JSON.stringify(inverted.body));

    const badValue = await recordCoverage(assetId, { contract_value: 1000 });
    assert.strictEqual(badValue.status, 400, JSON.stringify(badValue.body));
    assert.strictEqual(badValue.body['error_code'], 'INVALID_PARAMS');
  });

  it('rejects a coverage against an unknown asset 404 ASSET_NOT_FOUND', async () => {
    const res = await recordCoverage(randomUUID());
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ASSET_NOT_FOUND');
  });

  it('returns 404 COVERAGE_NOT_FOUND for an unknown coverage id', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/coverages/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'COVERAGE_NOT_FOUND');
  });

  it('the coverage write route replays under the same idempotency key', async () => {
    const assetId = await createAsset();
    const key = randomUUID();
    const body = {
      coverage_type: 'insurance',
      provider_name: 'Replay Insurer',
      reference_number_ext: `INS-REPLAY-${randomUUID().slice(0, 6)}`,
      start_date: ANCHOR,
      expiry_date: addDays(ANCHOR, 300),
      business_date: ANCHOR,
      idempotency_key: key,
    };
    const first = await recordCoverage(assetId, body);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await recordCoverage(assetId, body);
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(
      (replay.body['coverage'] as Record<string, string>)['coverage_id'],
      (first.body['coverage'] as Record<string, string>)['coverage_id'],
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.coverage_recorded', 'asset_id', assetId),
      1,
    );
  });

  it('rejects cross-event-type idempotency-key reuse 409 DUPLICATE_EVENT', async () => {
    const assetId = await createAsset();
    const key = randomUUID();
    const first = await recordCoverage(assetId, { idempotency_key: key });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      start_date: addDays(TODAY, -10),
      expiry_date: addDays(TODAY, 400),
      business_date: TODAY,
    });
    const workOrder = await breakdownWorkOrder(assetId);
    const reused = await recordOverride(workOrder['work_order_id'] as string, {
      idempotency_key: key,
    });
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    assert.strictEqual(reused.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(reused.body)?.['existing_event_id'], first.body['event_id']);
  });

  it('lists coverages by asset, type and status, and lists alerts by coverage', async () => {
    const assetId = await createAsset();
    const { coverageId } = await recordCoverageOk(assetId, {
      coverage_type: 'warranty',
      expiry_date: addDays(ANCHOR, 110),
    });
    await recordCoverageOk(assetId, { coverage_type: 'amc', expiry_date: addDays(ANCHOR, 110) });

    const byAsset = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/coverages`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(byAsset.status, 200, JSON.stringify(byAsset.body));
    assert.strictEqual((byAsset.body['coverages'] as unknown[]).length, 2);

    const byType = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/coverages?coverage_type=warranty`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((byType.body['coverages'] as unknown[]).length, 1);

    const expiredAt = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/coverages?asset_id=${assetId}&status=expired&business_date=${addDays(ANCHOR, 200)}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(expiredAt.status, 200, JSON.stringify(expiredAt.body));
    assert.strictEqual((expiredAt.body['coverages'] as unknown[]).length, 2);

    const activeAt = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/coverages?asset_id=${assetId}&status=active&business_date=${ANCHOR}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((activeAt.body['coverages'] as unknown[]).length, 2);

    await scan(addDays(ANCHOR, 20), { asset_id: assetId });
    const alerts = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/coverages/alerts?coverage_id=${coverageId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(alerts.status, 200, JSON.stringify(alerts.body));
    assert.strictEqual((alerts.body['alerts'] as unknown[]).length, 1);

    // The static /coverages/alerts route must not be shadowed by /coverages/:coverageId.
    const badStatus = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/coverages?status=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badStatus.status, 400, JSON.stringify(badStatus.body));
  });

  it('enforces RBAC: 401 without a token, 403 without the maintenance module', async () => {
    const assetId = await createAsset();
    const anonymous = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/coverages`,
      { coverage_type: 'amc' },
    );
    assert.strictEqual(anonymous.status, 401, JSON.stringify(anonymous.body));

    const wrongModule = await recordCoverage(assetId, {}, procurementHeaders);
    assert.strictEqual(wrongModule.status, 403, JSON.stringify(wrongModule.body));

    const readOnlyWrite = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/coverages/scan',
      { business_date: ANCHOR },
      readerHeaders,
    );
    assert.strictEqual(readOnlyWrite.status, 403, JSON.stringify(readOnlyWrite.body));
  });
});

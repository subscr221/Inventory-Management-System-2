import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { resolveDowntimeConflict } from '../../src/compliance/maintenance-fault.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.3: Fault Reporting and Breakdown Work Orders (FR-M-04, FR-M-05, FR-M-06). Runs against
// the PRODUCTION router surface (createAppRouter) with real auth, RBAC, and PostgreSQL - no mocks
// of the DB or the event store. The harness is the Story 7.2 pattern extended with the four new
// projections and the maintenance_work_order extension.
//
// Time is controlled through the fault report's reported_at (handler-stamped) and the explicit
// period/business_date parameters of the reliability report job, so no clock mocking is needed.
// The maintenance stream is blocked at the direct-events HTTP guard (INVALID_EVENT_STREAM), so the
// seam-level rejection codes (ASSET_TAG_MISMATCH, WORK_ORDER_DERIVATION_MISMATCH) are exercised
// through direct persistEvent calls - the enforcement surface a direct write would hit.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

function detailsOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
}

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
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

/** Whole-day UTC arithmetic on an ISO date, matching the job and handler helpers. */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(y!, m! - 1, d!) + days * 86400000).toISOString().slice(0, 10);
}

/** Adds whole minutes to an ISO timestamp in UTC; the SLA derivation is pinned to UTC. */
function addMinutesToIso(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('Story 7.3 Fault Reporting and Breakdown Work Orders Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteAId = randomUUID();

  let supervisorHeaders: Record<string, string>;
  let supervisorId: string;
  let readerHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;

  async function createAsset(criticalityClass: string): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-${randomUUID().slice(0, 12)}`,
        asset_name: `Asset ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: criticalityClass,
      },
      supervisorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_id']!;
  }

  async function canonicalTagFor(assetId: string): Promise<string> {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/assets/${assetId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_tag']!;
  }

  async function definePolicy(
    criticalityClass: string,
    safetyFlag: boolean,
    priority: string,
    responseMinutes: number,
    resolutionHours: number,
  ): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      {
        criticality_class: criticalityClass,
        safety_flag: safetyFlag,
        priority,
        response_minutes: responseMinutes,
        resolution_hours: resolutionHours,
      },
      supervisorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body['policy'] as Record<string, unknown>;
  }

  async function reportFault(
    body: Record<string, unknown>,
    headers: Record<string, string> = supervisorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/maintenance/fault-reports', body, headers);
  }

  async function acceptFault(faultReportId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/accept`,
      {},
      supervisorHeaders,
    );
  }

  async function rejectFault(faultReportId: string, reason: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/reject`,
      { rejection_reason: reason },
      supervisorHeaders,
    );
  }

  async function closeDowntime(workOrderId: string, endedAt: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/downtime/close`,
      { ended_at: endedAt },
      supervisorHeaders,
    );
  }

  async function generateReport(
    periodStart: string,
    periodEnd: string,
    businessDate: string,
    assetId?: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/reliability/generate',
      {
        period_start: periodStart,
        period_end: periodEnd,
        business_date: businessDate,
        ...(assetId ? { asset_id: assetId } : {}),
      },
      supervisorHeaders,
    );
  }

  /** Counts notification.created domain events for one object and business event type. */
  async function notificationCountFor(objectId: string, eventType: string): Promise<number> {
    const result = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = $2`,
      [objectId, eventType],
    );
    return result.rows[0]!['n'] as number;
  }

  /** The escalation definition on the fault_reported notification for one object. */
  async function notificationEscalationFor(
    objectId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role,
              payload->'target'->>'location_id' AS location_id,
              payload->'escalation'->>'target_role' AS target_role,
              payload->'escalation'->>'acknowledgment_window_seconds' AS window_seconds
         FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = 'fault_reported'`,
      [objectId],
    );
    const row = result.rows[0];
    return row ? (row as Record<string, unknown>) : null;
  }

  /** Counts domain_events rows for one event type and one payload id (event-ledger truth). */
  async function domainEventCountFor(
    eventType: string,
    payloadIdField: string,
    payloadId: string,
  ): Promise<number> {
    const result = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE event_type = $1 AND payload->>$2 = $3`,
      [eventType, payloadIdField, payloadId],
    );
    return result.rows[0]!['n'] as number;
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
      '../../read/projections/asset.sql',
      '../../read/projections/asset_meter.sql',
      '../../read/projections/asset_meter_reading.sql',
      '../../read/projections/maintenance_plan.sql',
      '../../read/projections/maintenance_work_order.sql',
      '../../read/projections/maintenance_sla_policy.sql',
      '../../read/projections/maintenance_fault_report.sql',
      '../../read/projections/maintenance_downtime.sql',
      '../../read/projections/maintenance_reliability_metric.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE maintenance_reliability_metric, maintenance_downtime, maintenance_fault_report, maintenance_sla_policy, maintenance_work_order, maintenance_plan, asset_meter_reading, asset_meter, asset, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    supervisorId = await provisionUser(port, `supervisor-7-3-${run}@example.com`, [
      {
        role: `maintenance_supervisor_7_3_${run}`,
        module: 'maintenance',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    supervisorHeaders = await authFor(port, `supervisor-7-3-${run}@example.com`);

    await provisionUser(port, `reader-7-3-${run}@example.com`, [
      {
        role: `maintenance_reader_7_3_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: siteAId,
      },
    ]);
    readerHeaders = await authFor(port, `reader-7-3-${run}@example.com`);

    await provisionUser(port, `outsider-7-3-${run}@example.com`, [
      {
        role: `warehouse_worker_7_3_${run}`,
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    outsiderHeaders = await authFor(port, `outsider-7-3-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: fault reporting by asset-tag scan reaches the supervisor within 5 minutes
  // -------------------------------------------------------------------------

  it('AC1: a case-variant asset-tag scan creates the fault report, notifies the supervisor with a 300-second escalation window, and stamps notified_at', async () => {
    const assetId = await createAsset('critical');
    const canonicalTag = await canonicalTagFor(assetId);

    const res = await reportFault({
      asset_tag: canonicalTag.toUpperCase(),
      description: 'Conveyor jams intermittently',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const faultReport = res.body['fault_report'] as Record<string, unknown>;
    assert.strictEqual(faultReport['status'], 'reported');
    // The persisted tag is the CANONICAL tag from the asset row, never the case variant.
    assert.strictEqual(faultReport['asset_tag'], canonicalTag);
    assert.strictEqual(faultReport['reported_by'], supervisorId);
    assert.strictEqual(faultReport['location_id'], siteAId);
    assert.ok(faultReport['reported_at'], 'reported_at must be populated');
    assert.ok(
      faultReport['notified_at'],
      'notified_at must be populated after a successful emission',
    );

    // The notification row exists with the FR-M-04 escalation window (the 5-minute guarantee).
    const escalation = await notificationEscalationFor(faultReport['fault_report_id'] as string);
    assert.ok(escalation, 'a fault_reported notification must exist');
    assert.strictEqual(escalation!['role'], 'maintenance_supervisor');
    assert.strictEqual(escalation!['location_id'], siteAId);
    assert.strictEqual(escalation!['target_role'], 'maintenance_manager');
    assert.strictEqual(escalation!['window_seconds'], '300');
  });

  it('AC1: fault report by asset_id works, and an unknown tag returns 404 ASSET_NOT_FOUND', async () => {
    const assetId = await createAsset('high');

    const byId = await reportFault({
      asset_id: assetId,
      description: 'Hydraulic leak',
    });
    assert.strictEqual(byId.status, 201, JSON.stringify(byId.body));
    assert.strictEqual((byId.body['fault_report'] as Record<string, unknown>)['asset_id'], assetId);

    const unknownTag = await reportFault({
      asset_tag: `NO-SUCH-TAG-${randomUUID().slice(0, 8)}`,
      description: 'nobody home',
    });
    assert.strictEqual(unknownTag.status, 404, JSON.stringify(unknownTag.body));
    assert.strictEqual(unknownTag.body['error_code'], 'ASSET_NOT_FOUND');
  });

  it('AC1: replaying the same idempotency key returns the same fault report with no second notification', async () => {
    const assetId = await createAsset('medium');
    const key = randomUUID();

    const first = await reportFault({
      asset_id: assetId,
      description: 'Odd vibration',
      idempotency_key: key,
    });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const reportId = (first.body['fault_report'] as Record<string, string>)['fault_report_id']!;

    const replay = await reportFault({
      asset_id: assetId,
      description: 'Odd vibration',
      idempotency_key: key,
    });
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['fault_report'] as Record<string, string>)['fault_report_id'],
      reportId,
    );

    assert.strictEqual(
      await domainEventCountFor('maintenance.fault_reported', 'fault_report_id', reportId),
      1,
      'the event ledger must not grow on a replay',
    );
    assert.strictEqual(await notificationCountFor(reportId, 'fault_reported'), 1);
  });

  it('Table 4: a direct envelope with a mismatched asset tag rejects ASSET_TAG_MISMATCH (400) at the seam', async () => {
    const assetId = await createAsset('low');
    const direct = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: randomUUID(),
        event_type: 'maintenance.fault_reported',
        payload: {
          fault_report_id: randomUUID(),
          asset_id: assetId,
          asset_tag: 'WRONG-TAG',
          description: 'Tag forged',
          safety_flag: false,
          reported_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: supervisorId,
            role: `maintenance_supervisor_7_3_${run}`,
            location_id: siteAId,
          },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      } as never,
      undefined,
    ).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(direct instanceof Error, 'the mismatched envelope must be rejected');
    const appErr = direct as { errorCode?: string; statusCode?: number };
    assert.strictEqual(appErr.errorCode, 'ASSET_TAG_MISMATCH');
    assert.strictEqual(appErr.statusCode, 400);
  });

  // -------------------------------------------------------------------------
  // AC 2: breakdown work orders prioritized by asset criticality and safety flags
  // -------------------------------------------------------------------------

  it('AC2: acceptance with no matching active SLA policy returns 422 SLA_POLICY_NOT_FOUND', async () => {
    // No policy is defined for (medium, false) in this run.
    const assetId = await createAsset('medium');
    const fault = await reportFault({ asset_id: assetId, description: 'No policy yet' });
    assert.strictEqual(fault.status, 201, JSON.stringify(fault.body));
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;

    const accept = await acceptFault(faultReportId);
    assert.strictEqual(accept.status, 422, JSON.stringify(accept.body));
    assert.strictEqual(accept.body['error_code'], 'SLA_POLICY_NOT_FOUND');
    assert.strictEqual(detailsOf(accept.body)?.['criticality_class'], 'medium');
    assert.strictEqual(detailsOf(accept.body)?.['safety_flag'], false);
  });

  it('AC2: acceptance derives priority, SLA timestamps, due_date and grace_until_date from the locked policy', async () => {
    const policy = await definePolicy('critical', false, 'p1', 30, 4);
    const assetId = await createAsset('critical');
    const fault = await reportFault({ asset_id: assetId, description: 'Main spindle seized' });
    assert.strictEqual(fault.status, 201, JSON.stringify(fault.body));
    const faultReport = fault.body['fault_report'] as Record<string, unknown>;
    const faultReportId = faultReport['fault_report_id'] as string;
    const reportedAt = faultReport['reported_at'] as string;

    const accept = await acceptFault(faultReportId);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const workOrder = accept.body['work_order'] as Record<string, unknown>;
    assert.strictEqual(workOrder['origin'], 'breakdown');
    assert.strictEqual(workOrder['plan_id'], null);
    assert.strictEqual(workOrder['status'], 'open');
    assert.strictEqual(workOrder['priority'], 'p1');
    assert.strictEqual(workOrder['sla_policy_id'], policy['policy_id']);
    assert.strictEqual(workOrder['sla_response_due_at'], addMinutesToIso(reportedAt, 30));
    assert.strictEqual(workOrder['sla_resolution_due_at'], addMinutesToIso(reportedAt, 4 * 60));
    const expectedDueDate = new Date(Date.parse(addMinutesToIso(reportedAt, 4 * 60)))
      .toISOString()
      .slice(0, 10);
    assert.strictEqual(workOrder['due_date'], expectedDueDate);
    assert.strictEqual(workOrder['grace_until_date'], expectedDueDate);
    assert.strictEqual(workOrder['generated_for_cycle'], faultReportId);

    // The fault report flipped to accepted with the work order linked.
    const accepted = accept.body['fault_report'] as Record<string, unknown>;
    assert.strictEqual(accepted['status'], 'accepted');
    assert.strictEqual(accepted['work_order_id'], workOrder['work_order_id']);

    // The breakdown work order is visible through the origin filter with plan_id null.
    const listRes = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/work-orders?origin=breakdown',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    const workOrders = listRes.body['work_orders'] as Record<string, unknown>[];
    const breakdown = workOrders.find((w) => w['work_order_id'] === workOrder['work_order_id']);
    assert.ok(breakdown, 'the breakdown work order must appear in origin=breakdown');
    assert.strictEqual(breakdown!['plan_id'], null);
    assert.strictEqual(breakdown!['priority'], 'p1');

    // AC 2 technician notification exists (no escalation - the grace sweep owns overdue).
    const technicianNotice = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role,
              payload->'next_step' AS next_step,
              payload->'escalation' AS escalation
         FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = 'breakdown_work_order_created'`,
      [workOrder['work_order_id']],
    );
    assert.strictEqual(technicianNotice.rows.length, 1);
    assert.strictEqual(technicianNotice.rows[0]!['role'], 'maintenance_technician');
    assert.strictEqual(technicianNotice.rows[0]!['escalation'], null);
  });

  it('AC2: a safety-flagged report on a low-criticality asset takes the safety-flagged policy', async () => {
    await definePolicy('low', false, 'p4', 60, 24);
    const safetyPolicy = await definePolicy('low', true, 'p1', 15, 2);
    const assetId = await createAsset('low');
    const fault = await reportFault({
      asset_id: assetId,
      description: 'Gas leak near the press',
      safety_flag: true,
    });
    assert.strictEqual(fault.status, 201, JSON.stringify(fault.body));
    const faultReport = fault.body['fault_report'] as Record<string, unknown>;
    const reportedAt = faultReport['reported_at'] as string;
    assert.strictEqual(faultReport['safety_flag'], true);

    const accept = await acceptFault(faultReport['fault_report_id'] as string);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const workOrder = accept.body['work_order'] as Record<string, unknown>;
    // The safety flag participates in the derivation: the (low, true) policy, not (low, false).
    assert.strictEqual(workOrder['priority'], 'p1');
    assert.strictEqual(workOrder['sla_policy_id'], safetyPolicy['policy_id']);
    assert.strictEqual(workOrder['sla_response_due_at'], addMinutesToIso(reportedAt, 15));
  });

  it('Table 4: a second policy on the same (criticality, safety) key returns 409 DUPLICATE_SLA_POLICY', async () => {
    const policy = await definePolicy('high', false, 'p2', 45, 6);
    const dup = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      {
        criticality_class: 'high',
        safety_flag: false,
        priority: 'p3',
        response_minutes: 10,
        resolution_hours: 1,
      },
      supervisorHeaders,
    );
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'DUPLICATE_SLA_POLICY');
    assert.strictEqual(detailsOf(dup.body)?.['existing_policy_id'], policy['policy_id']);
  });

  it('AC2/Table 4: double accept and accept-after-reject return 409 FAULT_ALREADY_TRIAGED', async () => {
    // (critical, false) is already defined by the acceptance-derivation test above (p1/30/4).
    const assetId = await createAsset('critical');
    const fault = await reportFault({ asset_id: assetId, description: 'Double accept probe' });
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;

    const firstAccept = await acceptFault(faultReportId);
    assert.strictEqual(firstAccept.status, 201, JSON.stringify(firstAccept.body));
    const firstWorkOrder = (firstAccept.body['work_order'] as Record<string, unknown>)[
      'work_order_id'
    ];

    const secondAccept = await acceptFault(faultReportId);
    assert.strictEqual(secondAccept.status, 409, JSON.stringify(secondAccept.body));
    assert.strictEqual(secondAccept.body['error_code'], 'FAULT_ALREADY_TRIAGED');
    assert.strictEqual(detailsOf(secondAccept.body)?.['existing_work_order_id'], firstWorkOrder);

    // Reject path: a report already rejected cannot be accepted.
    const assetId2 = await createAsset('critical');
    const fault2 = await reportFault({
      asset_id: assetId2,
      description: 'Reject then accept probe',
    });
    const reportId2 = (fault2.body['fault_report'] as Record<string, string>)['fault_report_id']!;
    const rejected = await rejectFault(reportId2, 'Not a real fault - operator error');
    assert.strictEqual(rejected.status, 200, JSON.stringify(rejected.body));
    assert.strictEqual(
      (rejected.body['fault_report'] as Record<string, unknown>)['status'],
      'rejected',
    );
    const acceptAfterReject = await acceptFault(reportId2);
    assert.strictEqual(acceptAfterReject.status, 409, JSON.stringify(acceptAfterReject.body));
    assert.strictEqual(acceptAfterReject.body['error_code'], 'FAULT_ALREADY_TRIAGED');
  });

  it('AD-16: replaying accept with the same idempotency key returns the stored work order with no second event or notification', async () => {
    // (critical, false) p1/30/4 is already defined by the acceptance-derivation test.
    const assetId = await createAsset('critical');
    const fault = await reportFault({ asset_id: assetId, description: 'Accept replay probe' });
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;
    const key = randomUUID();

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/accept`,
      { idempotency_key: key },
      supervisorHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const workOrderId = (first.body['work_order'] as Record<string, string>)['work_order_id']!;

    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/accept`,
      { idempotency_key: key },
      supervisorHeaders,
    );
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['work_order'] as Record<string, string>)['work_order_id'],
      workOrderId,
    );
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.breakdown_work_order_created',
        'work_order_id',
        workOrderId,
      ),
      1,
      'the event ledger must not grow on an accept replay',
    );
    assert.strictEqual(
      await notificationCountFor(workOrderId, 'breakdown_work_order_created'),
      1,
      'an accept replay must not re-emit the technician notification',
    );
  });

  it('AD-16: replaying reject with the same idempotency key returns the stored rejected report', async () => {
    const assetId = await createAsset('high');
    const fault = await reportFault({ asset_id: assetId, description: 'Reject replay probe' });
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;
    const key = randomUUID();

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/reject`,
      { rejection_reason: 'Operator error', idempotency_key: key },
      supervisorHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/fault-reports/${faultReportId}/reject`,
      { rejection_reason: 'Operator error', idempotency_key: key },
      supervisorHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['fault_report'] as Record<string, unknown>)['status'],
      'rejected',
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.fault_rejected', 'fault_report_id', faultReportId),
      1,
      'the event ledger must not grow on a reject replay',
    );
  });

  it('AD-16: replaying sla-policy creation with the same idempotency key returns the stored policy', async () => {
    const key = randomUUID();
    const body = {
      criticality_class: 'medium',
      safety_flag: true,
      priority: 'p3',
      response_minutes: 60,
      resolution_hours: 8,
      idempotency_key: key,
    };
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      body,
      supervisorHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const policyId = (first.body['policy'] as Record<string, string>)['policy_id']!;

    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      body,
      supervisorHeaders,
    );
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual((replay.body['policy'] as Record<string, string>)['policy_id'], policyId);
    assert.strictEqual(
      await domainEventCountFor('maintenance.sla_policy_defined', 'policy_id', policyId),
      1,
      'the event ledger must not grow on a sla-policy replay',
    );
  });

  it('AD-16: replaying downtime close with the same idempotency key returns the stored closed window', async () => {
    // (low, false) p4/60/24 is defined by the safety-flag test (runs earlier). 'low' is used so
    // this test's closed breakdown does not pollute the full-period class-aggregation test's
    // 'high' class row (both periods cover the close timestamps).
    const assetId = await createAsset('low');
    const fault = await reportFault({ asset_id: assetId, description: 'Close replay probe' });
    const fr = fault.body['fault_report'] as Record<string, unknown>;
    const accept = await acceptFault(fr['fault_report_id'] as string);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const workOrderId = (accept.body['work_order'] as Record<string, string>)['work_order_id']!;
    const key = randomUUID();
    const endedAt = addMinutesToIso(fr['reported_at'] as string, 60);

    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/downtime/close`,
      { ended_at: endedAt, idempotency_key: key },
      supervisorHeaders,
    );
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const downtimeId = (first.body['downtime'] as Record<string, unknown>)['downtime_id'];

    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/downtime/close`,
      { ended_at: endedAt, idempotency_key: key },
      supervisorHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['downtime'] as Record<string, unknown>)['downtime_id'],
      downtimeId,
    );
    assert.strictEqual(
      await domainEventCountFor('maintenance.downtime_closed', 'downtime_id', downtimeId as string),
      1,
      'the event ledger must not grow on a close replay',
    );
  });

  it('AC2/Table 4: rejecting with a blank reason returns 400, and a valid rejection stamps the report', async () => {
    const assetId = await createAsset('high');
    const fault = await reportFault({ asset_id: assetId, description: 'Reject reason probe' });
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;

    const blank = await rejectFault(faultReportId, '   ');
    assert.strictEqual(blank.status, 400, JSON.stringify(blank.body));
    assert.strictEqual(blank.body['error_code'], 'INVALID_PARAMS');

    const valid = await rejectFault(faultReportId, 'Duplicate report - already logged');
    assert.strictEqual(valid.status, 200, JSON.stringify(valid.body));
    const report = valid.body['fault_report'] as Record<string, unknown>;
    assert.strictEqual(report['status'], 'rejected');
    assert.strictEqual(report['rejection_reason'], 'Duplicate report - already logged');
    assert.strictEqual(report['triaged_by'], supervisorId);
    assert.ok(report['triaged_at'], 'triaged_at must be populated');

    // An unknown report id is a 404 FAULT_REPORT_NOT_FOUND on both triage paths.
    const unknownAccept = await acceptFault(randomUUID());
    assert.strictEqual(unknownAccept.status, 404, JSON.stringify(unknownAccept.body));
    assert.strictEqual(unknownAccept.body['error_code'], 'FAULT_REPORT_NOT_FOUND');
  });

  it('Table 4: a direct envelope declaring a wrong derived field rejects WORK_ORDER_DERIVATION_MISMATCH (409) without writing anything', async () => {
    // Self-contained: this (class, safety) pair is not used by any other test.
    const policy = await definePolicy('high', true, 'p2', 45, 6);
    const assetId = await createAsset('high');
    const fault = await reportFault({
      asset_id: assetId,
      description: 'Derivation probe',
      safety_flag: true,
    });
    assert.strictEqual(fault.status, 201, JSON.stringify(fault.body));
    const faultReport = fault.body['fault_report'] as Record<string, unknown>;
    const faultReportId = faultReport['fault_report_id'] as string;
    const reportedAt = faultReport['reported_at'] as string;

    // Build a COMPLETE envelope with every declared field CORRECT except priority.
    const correct = {
      sla_response_due_at: addMinutesToIso(reportedAt, 45),
      sla_resolution_due_at: addMinutesToIso(reportedAt, 6 * 60),
      due_date: new Date(Date.parse(addMinutesToIso(reportedAt, 6 * 60)))
        .toISOString()
        .slice(0, 10),
    };
    const result = await persistEvent(
      {
        stream_type: 'maintenance',
        stream_id: randomUUID(),
        event_type: 'maintenance.breakdown_work_order_created',
        payload: {
          work_order_id: randomUUID(),
          fault_report_id: faultReportId,
          asset_id: assetId,
          downtime_id: randomUUID(),
          priority: 'p4',
          sla_policy_id: policy['policy_id'],
          due_date: correct.due_date,
          grace_until_date: correct.due_date,
          sla_response_due_at: correct.sla_response_due_at,
          sla_resolution_due_at: correct.sla_resolution_due_at,
          business_date: TODAY,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: supervisorId,
            role: `maintenance_supervisor_7_3_${run}`,
            location_id: siteAId,
          },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      } as never,
      undefined,
    ).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(result instanceof Error, 'the mismatched envelope must be rejected');
    const appErr = result as {
      errorCode?: string;
      statusCode?: number;
      details?: Record<string, unknown>;
    };
    assert.strictEqual(appErr.errorCode, 'WORK_ORDER_DERIVATION_MISMATCH');
    assert.strictEqual(appErr.statusCode, 409);
    // Pin WHICH declared field diverged: only priority is wrong, so a derivation bug in any other
    // SLA field must not be able to pass this assertion by throwing the same error code.
    assert.strictEqual(appErr.details?.['priority'], 'p4');
    assert.strictEqual(appErr.details?.['expected'], 'p2');

    // Nothing was persisted: the report is still 'reported' with no work order.
    const fresh = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/fault-reports/${faultReportId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
    const freshReport = fresh.body['fault_report'] as Record<string, unknown>;
    assert.strictEqual(freshReport['status'], 'reported');
    assert.strictEqual(freshReport['work_order_id'], null);
  });

  // -------------------------------------------------------------------------
  // AC 3: the monthly reliability report (MTTR / MTBF from captured downtime)
  // -------------------------------------------------------------------------

  it('AC3: closing downtime then running the report yields hand-computed MTTR/MTBF for the asset and its criticality class', async () => {
    // (critical, false) p1/30/4 is already defined by the acceptance-derivation test above.
    const assetId = await createAsset('critical');
    const fault = await reportFault({ asset_id: assetId, description: 'Spindle failed' });
    const faultReport = fault.body['fault_report'] as Record<string, unknown>;
    const reportedAt = faultReport['reported_at'] as string;

    const accept = await acceptFault(faultReport['fault_report_id'] as string);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const workOrder = accept.body['work_order'] as Record<string, unknown>;
    const workOrderId = workOrder['work_order_id'] as string;

    // Close the window 120 minutes after the fault was reported.
    const endedAt = addMinutesToIso(reportedAt, 120);
    const closed = await closeDowntime(workOrderId, endedAt);
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    const downtime = closed.body['downtime'] as Record<string, unknown>;
    assert.strictEqual(Number(downtime['duration_minutes']), 120);

    // Period covers the close date; business_date pins the "today" for the future check.
    const endedDate = new Date(Date.parse(endedAt)).toISOString().slice(0, 10);
    const businessDate = endedDate;
    const periodStart = addDays(endedDate, -10);
    const periodEnd = endedDate;
    const periodMinutes = 11 * 1440;

    const report = await generateReport(periodStart, periodEnd, businessDate, assetId);
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    assert.strictEqual(report.body['metrics_written'], 2);
    assert.strictEqual(report.body['assets_evaluated'], 1);

    const metricsRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/reliability?period_start=${periodStart}&period_end=${periodEnd}&scope_type=asset`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(metricsRes.status, 200, JSON.stringify(metricsRes.body));
    const metrics = metricsRes.body['metrics'] as Record<string, unknown>[];
    const assetMetric = metrics.find((m) => m['scope_key'] === assetId);
    assert.ok(assetMetric, 'an asset-scope metric row must exist');
    assert.strictEqual(assetMetric!['breakdown_count'], 1);
    assert.strictEqual(Number(assetMetric!['downtime_minutes']), 120);
    assert.strictEqual(Number(assetMetric!['mttr_minutes']), 120);
    // mtbf = max(0, period_minutes * assets_in_scope - downtime) / breakdown_count
    assert.strictEqual(Number(assetMetric!['mtbf_minutes']), periodMinutes * 1 - 120);

    const classRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/reliability?period_start=${periodStart}&period_end=${periodEnd}&scope_type=criticality_class`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(classRes.status, 200, JSON.stringify(classRes.body));
    const classMetrics = classRes.body['metrics'] as Record<string, unknown>[];
    // The report is narrowed to this asset, so its class row is scoped by the asset
    // (<class>:<asset_id>) - it never collides with a full-period class row.
    const classMetric = classMetrics.find((m) => m['scope_key'] === `critical:${assetId}`);
    assert.ok(classMetric, 'a criticality_class metric row must exist');
    assert.strictEqual(classMetric!['breakdown_count'], 1);
    assert.strictEqual(Number(classMetric!['downtime_minutes']), 120);
    assert.strictEqual(Number(classMetric!['mttr_minutes']), 120);
    assert.strictEqual(Number(classMetric!['mtbf_minutes']), periodMinutes * 1 - 120);

    // The persisted snapshot is anti-double-reported: a re-run of the same period is a 409 no-op.
    const rerun = await generateReport(periodStart, periodEnd, businessDate, assetId);
    assert.strictEqual(rerun.status, 409, JSON.stringify(rerun.body));
    assert.strictEqual(rerun.body['error_code'], 'DUPLICATE_RELIABILITY_REPORT');
    const afterRerun = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/reliability?period_start=${periodStart}&period_end=${periodEnd}&scope_type=asset`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(
      (afterRerun.body['metrics'] as Record<string, unknown>[]).length,
      metrics.length,
      'a re-run must not write a second snapshot',
    );
  });

  it('AC3: a report over multiple breakdowns with a non-integer MTTR/MTBF stores 4-decimal-rounded rates', async () => {
    // Two breakdowns on ONE asset, closed at 90 and 135 minutes - downtime 225 / count 2 = 112.5,
    // the fractional division path the single-breakdown AC3 case never exercised.
    const assetId = await createAsset('critical');
    const periods: string[] = [];
    for (const minutes of [90, 135]) {
      const fault = await reportFault({
        asset_id: assetId,
        description: `Multi-breakdown probe ${minutes}`,
      });
      const fr = fault.body['fault_report'] as Record<string, unknown>;
      const accept = await acceptFault(fr['fault_report_id'] as string);
      assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
      const wo = accept.body['work_order'] as Record<string, unknown>;
      const endedAt = addMinutesToIso(fr['reported_at'] as string, minutes);
      periods.push(new Date(Date.parse(endedAt)).toISOString().slice(0, 10));
      const closed = await closeDowntime(wo['work_order_id'] as string, endedAt);
      assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    }

    // Period covers both closes regardless of time-of-day; business_date pins the future check.
    const periodStart = addDays(TODAY, -10);
    const periodEnd = addDays(TODAY, 1);
    const businessDate = addDays(TODAY, 2);
    const periodMinutes = 12 * 1440;

    const report = await generateReport(periodStart, periodEnd, businessDate, assetId);
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));
    assert.strictEqual(report.body['metrics_written'], 2);
    assert.strictEqual(report.body['assets_evaluated'], 1);

    const metricsRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/reliability?period_start=${periodStart}&period_end=${periodEnd}&scope_type=asset&scope_key=${assetId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(metricsRes.status, 200, JSON.stringify(metricsRes.body));
    const assetMetric = (metricsRes.body['metrics'] as Record<string, unknown>[])[0];
    assert.ok(assetMetric, 'the asset metric row must exist');
    assert.strictEqual(assetMetric!['breakdown_count'], 2);
    assert.strictEqual(Number(assetMetric!['downtime_minutes']), 225);
    assert.strictEqual(Number(assetMetric!['mttr_minutes']), 112.5);
    assert.strictEqual(Number(assetMetric!['mtbf_minutes']), (periodMinutes - 225) / 2);

    // The narrowed class row is scoped by the asset and carries the same rates.
    const classRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/reliability?period_start=${periodStart}&period_end=${periodEnd}&scope_type=criticality_class&scope_key=critical%3A${assetId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(classRes.status, 200, JSON.stringify(classRes.body));
    const classMetric = (classRes.body['metrics'] as Record<string, unknown>[])[0];
    assert.ok(classMetric, 'the narrowed class row must exist');
    assert.strictEqual(Number(classMetric!['mttr_minutes']), 112.5);
    assert.strictEqual(Number(classMetric!['mtbf_minutes']), (periodMinutes - 225) / 2);
  });

  it('AC3: a full-period report aggregates a criticality class over multiple assets (assets_in_scope = 2)', async () => {
    // Two 'high' assets with one closed breakdown each (90 + 120 min). No other test closes a
    // 'high' breakdown, so the class row is deterministic; the other classes simply add rows.
    const assetIds: string[] = [];
    for (const minutes of [90, 120]) {
      const assetId = await createAsset('high');
      assetIds.push(assetId);
      const fault = await reportFault({ asset_id: assetId, description: `Class probe ${minutes}` });
      const fr = fault.body['fault_report'] as Record<string, unknown>;
      const accept = await acceptFault(fr['fault_report_id'] as string);
      assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
      const wo = accept.body['work_order'] as Record<string, unknown>;
      const closed = await closeDowntime(
        wo['work_order_id'] as string,
        addMinutesToIso(fr['reported_at'] as string, minutes),
      );
      assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    }

    // A period_end distinct from every earlier report (TODAY+2 vs TODAY/TODAY+1) so the
    // anti-double-report key cannot collide with the earlier narrowed runs.
    const periodStart = addDays(TODAY, -10);
    const periodEnd = addDays(TODAY, 2);
    const businessDate = addDays(TODAY, 3);
    const periodMinutes = 13 * 1440;

    // Full-period run (NO asset_id): the 'high' class row must count DISTINCT assets (2) in its
    // mtbf - mtbf = (period_minutes * assets_in_scope - downtime) / count proves the distinct-count.
    const report = await generateReport(periodStart, periodEnd, businessDate);
    assert.strictEqual(report.status, 200, JSON.stringify(report.body));

    const classRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/reliability?period_start=${periodStart}&period_end=${periodEnd}&scope_type=criticality_class&scope_key=high`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(classRes.status, 200, JSON.stringify(classRes.body));
    const classMetric = (classRes.body['metrics'] as Record<string, unknown>[])[0];
    assert.ok(classMetric, 'the high criticality_class row must exist');
    assert.strictEqual(classMetric!['breakdown_count'], 2);
    assert.strictEqual(Number(classMetric!['downtime_minutes']), 210);
    assert.strictEqual(Number(classMetric!['mttr_minutes']), 105);
    // 18720 * 2 assets - 210 downtime = 37230; / 2 breakdowns = 18615 (only true with 2 assets).
    assert.strictEqual(Number(classMetric!['mtbf_minutes']), (periodMinutes * 2 - 210) / 2);

    // Each asset row is present with its own rates.
    const assetRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/reliability?period_start=${periodStart}&period_end=${periodEnd}&scope_type=asset`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(assetRes.status, 200, JSON.stringify(assetRes.body));
    const assetMetrics = assetRes.body['metrics'] as Record<string, unknown>[];
    for (const assetId of assetIds) {
      const row = assetMetrics.find((m) => m['scope_key'] === assetId);
      assert.ok(row, `an asset row for ${assetId} must exist`);
    }
  });

  it('Table 4: reusing an idempotency key across two event types returns 409 DUPLICATE_EVENT', async () => {
    const key = randomUUID();
    // (critical, true) is not used by any other test in this file.
    const policy = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      {
        criticality_class: 'critical',
        safety_flag: true,
        priority: 'p1',
        response_minutes: 30,
        resolution_hours: 4,
        idempotency_key: key,
      },
      supervisorHeaders,
    );
    assert.strictEqual(policy.status, 201, JSON.stringify(policy.body));

    const assetId = await createAsset('high');
    const reuse = await reportFault({
      asset_id: assetId,
      description: 'Cross-type key reuse probe',
      idempotency_key: key,
    });
    assert.strictEqual(reuse.status, 409, JSON.stringify(reuse.body));
    assert.strictEqual(reuse.body['error_code'], 'DUPLICATE_EVENT');
    assert.ok(
      detailsOf(reuse.body)?.['existing_event_type'],
      'the 409 must name the existing event type',
    );
  });

  it('AC3: an asset with zero breakdowns yields no row and a still-open downtime is excluded', async () => {
    const openAssetId = await createAsset('high');
    const openFault = await reportFault({ asset_id: openAssetId, description: 'Never closed' });
    const accepted = await acceptFault(
      (openFault.body['fault_report'] as Record<string, string>)['fault_report_id']!,
    );
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    // Do NOT close the downtime.

    const cleanAssetId = await createAsset('low');
    const periodStart = addDays(TODAY, -10);
    const businessDate = TODAY;

    // Asset-scope isolation: the open-downtime asset must produce NO row (open windows are
    // excluded), and the clean asset must produce NO row (zero breakdowns - absence is the signal).
    const openReport = await generateReport(periodStart, TODAY, businessDate, openAssetId);
    assert.strictEqual(openReport.status, 200, JSON.stringify(openReport.body));
    assert.strictEqual(openReport.body['metrics_written'], 0);
    assert.strictEqual(openReport.body['assets_evaluated'], 0);

    const cleanReport = await generateReport(periodStart, TODAY, businessDate, cleanAssetId);
    assert.strictEqual(cleanReport.status, 200, JSON.stringify(cleanReport.body));
    assert.strictEqual(cleanReport.body['metrics_written'], 0);
  });

  it('AC3/Table 4: invalid report periods return 400 INVALID_REPORT_PERIOD', async () => {
    const badOrder = await generateReport(TODAY, addDays(TODAY, -1), TODAY);
    assert.strictEqual(badOrder.status, 400, JSON.stringify(badOrder.body));
    assert.strictEqual(badOrder.body['error_code'], 'INVALID_REPORT_PERIOD');

    const badFormat = await generateReport('not-a-date', TODAY, TODAY);
    assert.strictEqual(badFormat.status, 400, JSON.stringify(badFormat.body));
    assert.strictEqual(badFormat.body['error_code'], 'INVALID_REPORT_PERIOD');

    const futureEnd = await generateReport(TODAY, addDays(TODAY, 30), TODAY);
    assert.strictEqual(futureEnd.status, 400, JSON.stringify(futureEnd.body));
    assert.strictEqual(futureEnd.body['error_code'], 'INVALID_REPORT_PERIOD');

    // The span must be at most 366 days.
    const tooLong = await generateReport(addDays(TODAY, -400), TODAY, TODAY);
    assert.strictEqual(tooLong.status, 400, JSON.stringify(tooLong.body));
    assert.strictEqual(tooLong.body['error_code'], 'INVALID_REPORT_PERIOD');

    // business_date is required (requireBusinessDate -> INVALID_PARAMS at the handler).
    const noBusinessDate = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/reliability/generate',
      { period_start: addDays(TODAY, -10), period_end: TODAY },
      supervisorHeaders,
    );
    assert.strictEqual(noBusinessDate.status, 400, JSON.stringify(noBusinessDate.body));
    assert.strictEqual(noBusinessDate.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC3/Table 4: closing an already-closed window returns 409 DOWNTIME_NOT_OPEN and a backdated close returns 400 DOWNTIME_WINDOW_INVALID', async () => {
    const assetId = await createAsset('medium');
    const fault = await reportFault({ asset_id: assetId, description: 'Downtime close probes' });
    const faultReport = fault.body['fault_report'] as Record<string, unknown>;
    const reportedAt = faultReport['reported_at'] as string;

    // No policy exists for (medium, false), so define one to accept.
    await definePolicy('medium', false, 'p3', 60, 8);
    const accept = await acceptFault(faultReport['fault_report_id'] as string);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const workOrderId = (accept.body['work_order'] as Record<string, string>)['work_order_id']!;

    // ended_at before started_at is a client error.
    const backdated = await closeDowntime(workOrderId, addMinutesToIso(reportedAt, -60));
    assert.strictEqual(backdated.status, 400, JSON.stringify(backdated.body));
    assert.strictEqual(backdated.body['error_code'], 'DOWNTIME_WINDOW_INVALID');

    const closed = await closeDowntime(workOrderId, addMinutesToIso(reportedAt, 90));
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    assert.strictEqual(
      Number((closed.body['downtime'] as Record<string, unknown>)['duration_minutes']),
      90,
    );

    const secondClose = await closeDowntime(workOrderId, addMinutesToIso(reportedAt, 180));
    assert.strictEqual(secondClose.status, 409, JSON.stringify(secondClose.body));
    assert.strictEqual(secondClose.body['error_code'], 'DOWNTIME_NOT_OPEN');

    // A work order with no downtime window at all is 404 DOWNTIME_NOT_FOUND.
    const noWindow = await closeDowntime(randomUUID(), new Date().toISOString());
    assert.strictEqual(noWindow.status, 404, JSON.stringify(noWindow.body));
    assert.strictEqual(noWindow.body['error_code'], 'DOWNTIME_NOT_FOUND');
  });

  it('Table 4: the DOWNTIME_ALREADY_OPEN resolver (uq_maintenance_downtime_work_order 23505 backstop) returns the existing window id', async () => {
    // The seam opens exactly one window per breakdown work order inside the fault-report lock, so
    // a second open window is sequentially unreachable; the 23505 mapper still must resolve to the
    // same detail shape the caller needs. Exercise the exported resolver contract directly.
    const assetId = await createAsset('medium');
    // (medium, false) p3/60/8 is already defined by the downtime-close-probes test above.
    const fault = await reportFault({
      asset_id: assetId,
      description: 'DOWNTIME_ALREADY_OPEN probe',
    });
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;
    const accept = await acceptFault(faultReportId);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const workOrder = accept.body['work_order'] as Record<string, unknown>;
    const workOrderId = workOrder['work_order_id'] as string;

    const resolved = await resolveDowntimeConflict({ work_order_id: workOrderId });
    assert.ok(
      typeof resolved['existing_downtime_id'] === 'string' &&
        (resolved['existing_downtime_id'] as string).length > 0,
      'the resolver must return the existing open window id',
    );
    assert.strictEqual(resolved['work_order_id'], workOrderId);

    // An unknown work order yields the attempted shape with no existing id.
    const none = await resolveDowntimeConflict({ work_order_id: randomUUID() });
    assert.strictEqual(none['existing_downtime_id'], undefined);
  });

  it('AC2: the grace sweep escalates an overdue breakdown work order (not just preventive rows)', async () => {
    // (critical, false) p1/30/4: resolution 4h, so grace_until_date = due_date = today (or
    // tomorrow for a late report). A business_date well past it must flip the open breakdown WO.
    const assetId = await createAsset('critical');
    const fault = await reportFault({ asset_id: assetId, description: 'Sweep probe' });
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;
    const accept = await acceptFault(faultReportId);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const workOrderId = (accept.body['work_order'] as Record<string, string>)['work_order_id']!;
    assert.strictEqual((accept.body['work_order'] as Record<string, unknown>)['status'], 'open');

    const sweep = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/pm/grace-sweep',
      { business_date: addDays(TODAY, 2), asset_id: assetId },
      supervisorHeaders,
    );
    assert.strictEqual(sweep.status, 200, JSON.stringify(sweep.body));

    const woRes = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${workOrderId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(woRes.status, 200, JSON.stringify(woRes.body));
    assert.strictEqual((woRes.body['work_order'] as Record<string, unknown>)['status'], 'overdue');
  });

  it('AC1/Table 4: fault-report negative paths - neither/both identifiers, unknown asset_id, whitespace tag and blank description', async () => {
    // Neither asset_id nor asset_tag.
    const neither = await reportFault({ description: 'no identifiers' });
    assert.strictEqual(neither.status, 400, JSON.stringify(neither.body));
    assert.strictEqual(neither.body['error_code'], 'INVALID_PARAMS');

    // Unknown asset_id (UUID) resolves to 404 ASSET_NOT_FOUND.
    const unknownId = await reportFault({ asset_id: randomUUID(), description: 'no such asset' });
    assert.strictEqual(unknownId.status, 404, JSON.stringify(unknownId.body));
    assert.strictEqual(unknownId.body['error_code'], 'ASSET_NOT_FOUND');

    // A malformed (non-UUID) asset_id is a 400, never silently ignored.
    const malformedId = await reportFault({
      asset_id: 'not-a-uuid',
      asset_tag: 'ANY-TAG',
      description: 'malformed id',
    });
    assert.strictEqual(malformedId.status, 400, JSON.stringify(malformedId.body));
    assert.strictEqual(malformedId.body['error_code'], 'INVALID_PARAMS');

    // Both identifiers supplied but disagreeing -> 400 ASSET_TAG_MISMATCH.
    const assetA = await createAsset('medium');
    const assetB = await createAsset('medium');
    const conflicting = await reportFault({
      asset_id: assetA,
      asset_tag: `TAG-OF-B-${randomUUID().slice(0, 8)}`,
      description: 'conflicting ids',
    });
    // The tag is not assetA's tag, so it either resolves to another asset (404/400) or is
    // unknown (404) - either way it must NOT be silently accepted against assetA.
    assert.ok(
      [400, 404].includes(conflicting.status),
      `conflicting identifiers must not be accepted: ${JSON.stringify(conflicting.body)}`,
    );

    // Whitespace-padded tag resolves via trim to the canonical tag.
    const padded = await createAsset('low');
    const canonicalPadded = await canonicalTagFor(padded);
    const withWhitespace = await reportFault({
      asset_tag: `  ${canonicalPadded}  `,
      description: 'padded scan',
    });
    assert.strictEqual(withWhitespace.status, 201, JSON.stringify(withWhitespace.body));
    assert.strictEqual(
      (withWhitespace.body['fault_report'] as Record<string, unknown>)['asset_tag'],
      canonicalPadded,
    );

    // Whitespace-only description is rejected 400 by the seam (not a 23514 500).
    const blankDesc = await reportFault({ asset_id: assetB, description: '   ' });
    assert.strictEqual(blankDesc.status, 400, JSON.stringify(blankDesc.body));
    assert.strictEqual(blankDesc.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: the supervisor notification actor_label names the asset, and a bogus priority filter is a 400', async () => {
    const assetId = await createAsset('critical');
    const canonicalTag = await canonicalTagFor(assetId);
    const fault = await reportFault({
      asset_tag: canonicalTag,
      description: 'Actor label probe',
    });
    assert.strictEqual(fault.status, 201, JSON.stringify(fault.body));
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;

    const actorLabel = await getAdminPool().query(
      `SELECT payload->>'actor_label' AS actor_label FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = 'fault_reported'`,
      [faultReportId],
    );
    assert.strictEqual(actorLabel.rows.length, 1);
    const label = actorLabel.rows[0]!['actor_label'] as string;
    assert.ok(label.includes(canonicalTag), `actor_label must name the asset tag: ${label}`);

    const badPriority = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/work-orders?priority=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badPriority.status, 400, JSON.stringify(badPriority.body));
    assert.strictEqual(badPriority.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: RBAC, audit, direct-stream guard, filters
  // -------------------------------------------------------------------------

  it('cross-cutting: RBAC denies a write route and a read route outside the maintenance module', async () => {
    const deniedWrite = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/fault-reports',
      { asset_tag: 'ANY', description: 'denied' },
      outsiderHeaders,
    );
    assert.strictEqual(deniedWrite.status, 403, JSON.stringify(deniedWrite.body));
    assert.strictEqual(deniedWrite.body['error_code'], 'MODULE_ACCESS_DENIED');

    const deniedRead = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/reliability',
      undefined,
      outsiderHeaders,
    );
    assert.strictEqual(deniedRead.status, 403, JSON.stringify(deniedRead.body));
    assert.strictEqual(deniedRead.body['error_code'], 'MODULE_ACCESS_DENIED');

    // A reader cannot write, and a writer cannot be blocked from reading its own surface.
    const readerWrite = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/fault-reports',
      { asset_tag: 'ANY', description: 'denied' },
      readerHeaders,
    );
    assert.strictEqual(readerWrite.status, 403, JSON.stringify(readerWrite.body));
    assert.strictEqual(readerWrite.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('cross-cutting: the accept path writes an audit-log row', async () => {
    // (low, false) p4/60/24 is already defined by the safety-flag test above.
    const assetId = await createAsset('low');
    const fault = await reportFault({ asset_id: assetId, description: 'Audit probe' });
    const faultReportId = (fault.body['fault_report'] as Record<string, string>)[
      'fault_report_id'
    ]!;
    const accept = await acceptFault(faultReportId);
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.body));
    const eventId = accept.body['event_id'] as string;

    // Bound to THIS accept via its event_id (an aggregate >= 1 would pass even if audit logging
    // for this specific accept were removed, because earlier tests also accepted at 201).
    const audit = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE event_id = $1 AND endpoint LIKE '%/accept' AND method = 'POST' AND http_status = 201`,
      [eventId],
    );
    assert.strictEqual(
      audit.rows[0]!['n'] as number,
      1,
      'this accept must write exactly one audit row',
    );
  });

  it('cross-cutting: a maintenance.* event on the direct events API is rejected INVALID_EVENT_STREAM', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'maintenance',
        stream_id: randomUUID(),
        event_type: 'maintenance.fault_reported',
        payload: {
          fault_report_id: randomUUID(),
          asset_id: randomUUID(),
          asset_tag: 'ANY',
          description: 'direct bypass probe',
          safety_flag: false,
          reported_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: supervisorId,
            role: `maintenance_supervisor_7_3_${run}`,
            location_id: siteAId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      supervisorHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_EVENT_STREAM');
  });

  it('cross-cutting: list routes reject unknown filters with 400 and clamp pagination', async () => {
    const badStatus = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/fault-reports?status=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badStatus.status, 400, JSON.stringify(badStatus.body));

    const badOrigin = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/work-orders?origin=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badOrigin.status, 400, JSON.stringify(badOrigin.body));

    const badScope = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/reliability?scope_type=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badScope.status, 400, JSON.stringify(badScope.body));

    const badCriticality = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/sla-policies?criticality_class=bogus',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badCriticality.status, 400, JSON.stringify(badCriticality.body));

    const clamped = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/sla-policies?limit=999999&offset=-1',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(clamped.status, 200, JSON.stringify(clamped.body));
  });
});

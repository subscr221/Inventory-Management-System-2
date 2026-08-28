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

// Story 7.8: Offline Technician Workflow and Closure Codes (FR-M-17, FR-M-18). Runs against the
// PRODUCTION router surface (createAppRouter) with real auth, RBAC and PostgreSQL - no mocks of the
// DB or the event store. The harness is the Story 7.7 pattern plus the Story 1.8 edge envelope
// adapted to the maintenance stream with a technician actor.
//
// The maintenance stream is blocked at the direct-events HTTP guard (INVALID_EVENT_STREAM), so the
// seam-level rejection codes (WORK_ORDER_DERIVATION_MISMATCH, SYNC_CONFLICT_DERIVATION_MISMATCH,
// DUPLICATE_SYNC_CONFLICT, CLOSURE_CODES_REQUIRED on the direct path) are exercised through direct
// persistEvent calls - the enforcement surface a direct write would hit.

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

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
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

/** The date the Story 7.3 accept handler derives; the warranty fixtures anchor on it. */
const TODAY = new Date().toISOString().slice(0, 10);
const FAULT_CODE = config.maintenance.closureCodes.fault[0]!;
const CAUSE_CODE = config.maintenance.closureCodes.cause[0]!;
const REMEDY_CODE = config.maintenance.closureCodes.remedy[0]!;
const CODES = { fault_code: FAULT_CODE, cause_code: CAUSE_CODE, remedy_code: REMEDY_CODE };
const REASON_CODE = config.maintenance.warrantyOverrideReasonCodes[0]!;
const DEVICE_ID = `EDGE-TAB-7-8-${run}`;

describe('Story 7.8 Offline Technician Workflow and Closure Codes', () => {
  let server: Server;
  let port: number;
  let siteLocId: string;
  let storeLocId: string;
  let technicianUserId: string;
  let supervisorUserId: string;
  let plannerUserId: string;
  let technicianHeaders: Record<string, string>;
  let supervisorHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let procurementHeaders: Record<string, string>;
  let plannerHeaders: Record<string, string>;
  let skuCounter = 0;

  // --- helpers -------------------------------------------------------------

  async function seedLocation(codeSuffix: string): Promise<string> {
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), `LOC-7-8-${run}-${codeSuffix}`, randomUUID()],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function createAsset(): Promise<{ assetId: string; assetTag: string }> {
    const assetTag = `TAG-7-8-${randomUUID().slice(0, 12)}`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: assetTag,
        asset_name: `Machine ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: 'critical',
      },
      supervisorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { assetId: (res.body['asset'] as Record<string, string>)['asset_id']!, assetTag };
  }

  async function definePolicy(criticalityClass: string, safetyFlag: boolean): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/sla-policies',
      {
        criticality_class: criticalityClass,
        safety_flag: safetyFlag,
        priority: safetyFlag ? 'p1' : 'p2',
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

  /** Reports a fault and accepts it, returning the created breakdown work order (stream head 1). */
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

  /** Inserts an open PREVENTIVE work order directly (no events on its stream: head 0). */
  async function insertPreventiveWorkOrder(
    assetId: string,
    overrides: { due_date?: string; grace_until_date?: string; status?: string } = {},
  ): Promise<string> {
    const workOrderId = randomUUID();
    const dueDate = overrides.due_date ?? TODAY;
    await getAdminPool().query(
      `INSERT INTO maintenance_work_order (
        work_order_id, plan_id, asset_id, origin, due_date, grace_until_date,
        status, generated_for_cycle, created_at, updated_at
      ) VALUES ($1, $2, $3, 'preventive', $4, $5, $6, $7, now(), now())`,
      [
        workOrderId,
        randomUUID(),
        assetId,
        dueDate,
        overrides.grace_until_date ?? dueDate,
        overrides.status ?? 'open',
        `cycle-${randomUUID().slice(0, 8)}`,
      ],
    );
    return workOrderId;
  }

  async function createMeter(assetId: string): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/meters',
      {
        asset_id: assetId,
        meter_code: `HRS-${randomUUID().slice(0, 8)}`,
        unit: 'hours',
        alert_role: 'maintenance_supervisor',
      },
      supervisorHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['meter'] as Record<string, string>)['meter_id']!;
  }

  async function seedItem(): Promise<string> {
    skuCounter += 1;
    const sku = `sp-7-8-${run}-${skuCounter}`;
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
    return sku;
  }

  async function receiveStock(sku: string, quantity: number): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.received',
        payload: {
          business_stream: 'production',
          sku,
          target_location_id: storeLocId,
          quantity,
          unit_cost: 5,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: plannerUserId, role: 'inventory_planner', location_id: storeLocId },
          occurred_at: new Date().toISOString(),
        },
      },
      plannerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  }

  /** A reserved spare on the work order; the reservation stream head is 1 (spare_reserved). */
  async function reservedSpare(workOrderId: string): Promise<string> {
    const sku = await seedItem();
    const catalogued = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/spares',
      { sku, location_id: storeLocId },
      supervisorHeaders,
    );
    assert.strictEqual(catalogued.status, 201, JSON.stringify(catalogued.body));
    await receiveStock(sku, 5);
    const reserved = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/spare-reservations`,
      { sku, location_id: storeLocId, quantity: '1' },
      supervisorHeaders,
    );
    assert.strictEqual(reserved.status, 201, JSON.stringify(reserved.body));
    return (reserved.body['reservation'] as Record<string, string>)['reservation_id']!;
  }

  function edgeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const eventId = randomUUID();
    return {
      event_id: eventId,
      stream_type: 'maintenance',
      stream_id: randomUUID(),
      event_type: 'edge.test_capture_recorded',
      event_version: 1,
      payload: { capture_kind: 'shell_test' },
      metadata: {
        correlation_id: randomUUID(),
        actor: {
          user_id: technicianUserId,
          role: 'maintenance_technician',
          location_id: siteLocId,
        },
        device_id: DEVICE_ID,
        capture_method: 'MANUAL',
        occurred_at: new Date().toISOString(),
      },
      schema_version: 1,
      idempotency_key: `edge-7-8-${eventId}`,
      ...overrides,
    };
  }

  function statusEnvelope(
    workOrderId: string,
    assetId: string,
    eventVersion: number,
    newStatus: 'in_progress' | 'on_hold' = 'in_progress',
  ): Record<string, unknown> {
    return edgeEnvelope({
      stream_id: workOrderId,
      event_type: 'maintenance.work_order_status_updated',
      event_version: eventVersion,
      payload: {
        work_order_id: workOrderId,
        asset_id: assetId,
        new_status: newStatus,
        note: null,
        updated_at: new Date().toISOString(),
      },
    });
  }

  function closureEnvelope(
    workOrderId: string,
    assetId: string,
    eventVersion: number,
  ): Record<string, unknown> {
    return edgeEnvelope({
      stream_id: workOrderId,
      event_type: 'maintenance.work_order_completed',
      event_version: eventVersion,
      payload: {
        work_order_id: workOrderId,
        asset_id: assetId,
        completed_at: new Date().toISOString(),
        ...CODES,
      },
    });
  }

  function faultEnvelope(
    assetTag: string,
    safetyFlag: boolean,
    faultReportId: string = randomUUID(),
  ): Record<string, unknown> {
    return edgeEnvelope({
      stream_id: faultReportId,
      event_type: 'maintenance.fault_reported',
      event_version: 1,
      payload: {
        fault_report_id: faultReportId,
        asset_tag: assetTag,
        description: `Edge fault ${randomUUID().slice(0, 6)}`,
        safety_flag: safetyFlag,
        reported_at: new Date().toISOString(),
      },
    });
  }

  async function postEdge(
    envelope: Record<string, unknown>,
    headers: Record<string, string> = technicianHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/edge/events', envelope, headers);
  }

  async function headOf(streamId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT COALESCE(MAX(event_version), 0)::int AS head FROM domain_events WHERE stream_id = $1`,
      [streamId],
    );
    return r.rows[0]!['head'] as number;
  }

  async function eventCountForKey(idempotencyKey: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return r.rows[0]!['n'] as number;
  }

  async function workOrderRow(workOrderId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT * FROM maintenance_work_order WHERE work_order_id = $1`,
      [workOrderId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function closureRow(workOrderId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT * FROM maintenance_work_order_closure WHERE work_order_id = $1`,
      [workOrderId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function conflictRowsFor(conflictingEventId: string): Promise<Record<string, unknown>[]> {
    const r = await getAdminPool().query(
      `SELECT * FROM maintenance_sync_conflict WHERE conflicting_event_id = $1`,
      [conflictingEventId],
    );
    return r.rows as Record<string, unknown>[];
  }

  async function notificationFor(
    objectId: string,
    targetRole: string,
  ): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role,
              payload->'target'->>'location_id' AS location_id,
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

  /** Replicates src/notify/dispatch.ts resolveTargetUserIds for a location-scoped target. */
  async function recipientCountFor(role: string, locationId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(DISTINCT user_id)::int AS n FROM user_role_assignments
        WHERE role = $1 AND (location_id = $2 OR location_id = '*')`,
      [role, locationId],
    );
    return r.rows[0]!['n'] as number;
  }

  function supervisorMetadata(): Record<string, unknown> {
    return {
      correlation_id: randomUUID(),
      actor: { user_id: supervisorUserId, role: 'maintenance_supervisor', location_id: siteLocId },
      occurred_at: new Date().toISOString(),
    };
  }

  async function seedDoa(transactionType: string): Promise<void> {
    const existing = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM doa_registry_entries
        WHERE transaction_type = $1 AND active = true`,
      [transactionType],
    );
    if ((existing.rows[0]!['n'] as number) > 0) return;
    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'maintenance_supervisor',
        transaction_type: transactionType,
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));
  }

  async function clearDoa(transactionType: string): Promise<void> {
    await getAdminPool().query(`DELETE FROM doa_registry_entries WHERE transaction_type = $1`, [
      transactionType,
    ]);
  }

  async function worklist(query: string = ''): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/edge/maintenance/worklist${query}`,
      undefined,
      technicianHeaders,
    );
  }

  function worklistEntry(
    body: Record<string, unknown>,
    workOrderId: string,
  ): Record<string, unknown> | undefined {
    return (body['work_orders'] as Record<string, unknown>[]).find(
      (row) => row['work_order_id'] === workOrderId,
    );
  }

  async function restStatus(
    workOrderId: string,
    newStatus: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = supervisorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/status`,
      { new_status: newStatus, ...body },
      headers,
    );
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

  /** A breakdown closure with an explicit completed_at, through the seam (the closure ledger keys on it). */
  async function closeBreakdownAt(assetId: string, completedAt: string): Promise<string> {
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    await persistEvent({
      stream_type: 'maintenance',
      stream_id: workOrderId,
      event_type: 'maintenance.work_order_completed',
      payload: {
        work_order_id: workOrderId,
        asset_id: assetId,
        completed_at: completedAt,
        ...CODES,
      },
      metadata: supervisorMetadata(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return workOrderId;
  }

  /** A stale-version conflict on a fresh breakdown work order; returns the 409 and the envelope. */
  async function raiseVersionConflict(): Promise<{
    res: HttpResult;
    envelope: Record<string, unknown>;
    workOrderId: string;
  }> {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const fetched = await worklist();
    assert.strictEqual(fetched.status, 200, JSON.stringify(fetched.body));
    const n = worklistEntry(fetched.body, workOrderId)?.['stream_version'] as number;
    assert.strictEqual(n, 1);
    assert.strictEqual((await restStatus(workOrderId, 'in_progress')).status, 200);
    const envelope = statusEnvelope(workOrderId, assetId, n + 1, 'on_hold');
    const res = await postEdge(envelope);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'STREAM_CONFLICT');
    return { res, envelope, workOrderId };
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
      '../../read/projections/asset.sql',
      '../../read/projections/asset_meter.sql',
      '../../read/projections/asset_meter_reading.sql',
      '../../read/projections/maintenance_plan.sql',
      '../../read/projections/maintenance_work_order.sql',
      '../../read/projections/maintenance_sla_policy.sql',
      '../../read/projections/maintenance_fault_report.sql',
      '../../read/projections/maintenance_downtime.sql',
      '../../read/projections/maintenance_reliability_metric.sql',
      '../../read/projections/maintenance_spare_catalogue.sql',
      '../../read/projections/asset_parts_list.sql',
      '../../read/projections/maintenance_spare_reservation.sql',
      '../../read/projections/maintenance_spare_alert.sql',
      '../../read/projections/maintenance_asset_cost.sql',
      '../../read/projections/statutory_examination.sql',
      '../../read/projections/asset_coverage.sql',
      '../../read/projections/asset_coverage_alert.sql',
      '../../read/projections/maintenance_warranty_override.sql',
      '../../read/projections/maintenance_work_order_closure.sql',
      '../../read/projections/maintenance_sync_conflict.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE maintenance_sync_conflict, maintenance_work_order_closure, maintenance_warranty_override, asset_coverage_alert, asset_coverage, statutory_examination, maintenance_asset_cost, maintenance_spare_alert, maintenance_spare_reservation, asset_parts_list, maintenance_spare_catalogue, maintenance_reliability_metric, maintenance_downtime, maintenance_fault_report, maintenance_sla_policy, maintenance_work_order, maintenance_plan, asset_meter_reading, asset_meter, asset, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
    storeLocId = await seedLocation('STORE');

    // The technician's assignment is SITE-scoped (access matrix L66): the edge upload route pins
    // the envelope actor location to it, and the supervisor notification targets that site.
    technicianUserId = await provisionUser(port, `maint-tech-7-8-${run}@example.com`, [
      {
        role: 'maintenance_technician',
        module: 'maintenance',
        functionScope: 'write',
        locationId: siteLocId,
      },
      {
        role: 'maintenance_technician',
        module: 'maintenance',
        functionScope: 'read',
        locationId: siteLocId,
      },
    ]);
    technicianHeaders = await authFor(port, `maint-tech-7-8-${run}@example.com`);

    // The supervisor holds the LITERAL role the DOA entry routes to and the notification targets;
    // exactly ONE supervisor, because findRoleHolder picks the earliest-assigned holder.
    supervisorUserId = await provisionUser(port, `maint-sup-7-8-${run}@example.com`, [
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
    supervisorHeaders = await authFor(port, `maint-sup-7-8-${run}@example.com`);

    await provisionUser(port, `maint-mgr-7-8-${run}@example.com`, [
      {
        role: 'maintenance_manager',
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);

    await provisionUser(port, `maint-reader-7-8-${run}@example.com`, [
      {
        role: `maintenance_reader_7_8_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    readerHeaders = await authFor(port, `maint-reader-7-8-${run}@example.com`);

    await provisionUser(port, `compliance-7-8-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `compliance-7-8-${run}@example.com`);

    await provisionUser(port, `proc-7-8-${run}@example.com`, [
      { role: 'buyer', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);
    procurementHeaders = await authFor(port, `proc-7-8-${run}@example.com`);

    plannerUserId = await provisionUser(port, `planner-7-8-${run}@example.com`, [
      { role: 'inventory_planner', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'inventory_planner', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    plannerHeaders = await authFor(port, `planner-7-8-${run}@example.com`);

    await definePolicy('critical', false);
    await definePolicy('critical', true);
    await seedDoa('maintenance.sync_conflict_resolution');
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: offline capture, replay in sequence, duplicate suppression
  // -------------------------------------------------------------------------

  it('AC1: both notification roles resolve to real recipients at the device site', async () => {
    assert.ok((await recipientCountFor('maintenance_supervisor', siteLocId)) > 0);
    assert.ok((await recipientCountFor('maintenance_manager', siteLocId)) > 0);
  });

  it('AC1: an edge fault report carrying the tag only lands with a derived asset_id, reaches the supervisor, and replays as 409 DUPLICATE_EVENT', async () => {
    const { assetId, assetTag } = await createAsset();
    const envelope = faultEnvelope(assetTag.toLowerCase(), false);
    const first = await postEdge(envelope);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const persistedPayload = first.body['payload'] as Record<string, unknown>;
    assert.strictEqual(persistedPayload['asset_id'], assetId);
    assert.strictEqual(persistedPayload['asset_tag'], assetTag);

    const faultReportId = (envelope['payload'] as Record<string, string>)['fault_report_id']!;
    const row = await getAdminPool().query(
      `SELECT asset_id, location_id, reported_by, notified_at FROM maintenance_fault_report WHERE fault_report_id = $1`,
      [faultReportId],
    );
    assert.strictEqual(row.rows[0]?.['asset_id'], assetId);
    assert.strictEqual(row.rows[0]?.['location_id'], siteLocId);
    assert.strictEqual(row.rows[0]?.['reported_by'], technicianUserId);
    assert.ok(row.rows[0]?.['notified_at'], 'notified_at must reflect the emission');
    assert.strictEqual(await notificationCountFor(faultReportId, 'maintenance_supervisor'), 1);
    const notification = await notificationFor(faultReportId, 'maintenance_supervisor');
    assert.strictEqual(notification?.['location_id'], siteLocId);
    assert.strictEqual(notification?.['escalation_role'], 'maintenance_manager');

    // Replay of the SAME envelope: 409 with the original identity, exactly one row, no second
    // notification (Binding Decision 1 restores the AD-16 / Story 1.8 contract on the edge route).
    const replay = await postEdge(envelope);
    assert.strictEqual(replay.status, 409, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(replay.body)['existing_event_id'], envelope['event_id']);
    assert.strictEqual(detailsOf(replay.body)['existing_event_type'], 'maintenance.fault_reported');
    assert.strictEqual(await eventCountForKey(envelope['idempotency_key'] as string), 1);
    assert.strictEqual(await notificationCountFor(faultReportId, 'maintenance_supervisor'), 1);

    // A NEW event_id with the SAME idempotency key: 409 with the ORIGINAL event id.
    const rekeyed = await postEdge({ ...envelope, event_id: randomUUID() });
    assert.strictEqual(rekeyed.status, 409, JSON.stringify(rekeyed.body));
    assert.strictEqual(rekeyed.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(rekeyed.body)['existing_event_id'], envelope['event_id']);
  });

  it('AC1: two parallel identical edge posts yield exactly one 201 and one 409 with the same detail shape', async () => {
    const { assetTag } = await createAsset();
    const envelope = faultEnvelope(assetTag, false);
    const [a, b] = await Promise.all([postEdge(envelope), postEdge(envelope)]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));
    const rejected = a.status === 409 ? a : b;
    assert.strictEqual(rejected.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(rejected.body)['existing_event_id'], envelope['event_id']);
    assert.strictEqual(
      detailsOf(rejected.body)['existing_event_type'],
      'maintenance.fault_reported',
    );
    assert.strictEqual(await eventCountForKey(envelope['idempotency_key'] as string), 1);
  });

  it('AC1: an edge status update stamped head + 1 from the worklist stream_version lands in_progress', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const fetched = await worklist();
    assert.strictEqual(fetched.status, 200, JSON.stringify(fetched.body));
    const entry = worklistEntry(fetched.body, workOrderId);
    assert.ok(entry, 'the breakdown work order must be on the worklist');
    const n = entry['stream_version'] as number;
    assert.strictEqual(n, await headOf(workOrderId));

    const envelope = statusEnvelope(workOrderId, assetId, n + 1);
    const res = await postEdge(envelope);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['event_version'], n + 1);
    assert.strictEqual((res.body['payload'] as Record<string, unknown>)['previous_status'], 'open');
    const row = await workOrderRow(workOrderId);
    assert.strictEqual(row?.['status'], 'in_progress');
    assert.strictEqual(row?.['status_updated_by'], technicianUserId);
    assert.ok(row?.['status_updated_at']);

    const replay = await postEdge(envelope);
    assert.strictEqual(replay.status, 409, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(replay.body)['existing_event_id'], envelope['event_id']);
    assert.strictEqual(
      detailsOf(replay.body)['existing_event_type'],
      'maintenance.work_order_status_updated',
    );
    assert.strictEqual(await eventCountForKey(envelope['idempotency_key'] as string), 1);
  });

  it('AC1: edge meter readings omit the version, never conflict, and advance the meter', async () => {
    const { assetId } = await createAsset();
    const meterId = await createMeter(assetId);
    const reading = (value: number, deviceId: string) =>
      edgeEnvelope({
        stream_id: meterId,
        event_type: 'maintenance.meter_reading_recorded',
        event_version: undefined,
        payload: {
          reading_id: randomUUID(),
          meter_id: meterId,
          asset_id: assetId,
          reading_value: value,
          reading_at: new Date().toISOString(),
          source: 'manual',
          capture_method: 'manual_entry',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: technicianUserId,
            role: 'maintenance_technician',
            location_id: siteLocId,
          },
          device_id: deviceId,
          capture_method: 'MANUAL',
          occurred_at: new Date().toISOString(),
        },
      });
    const firstEnvelope = reading(100, 'EDGE-TAB-A');
    const first = await postEdge(firstEnvelope);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstReplay = await postEdge(firstEnvelope);
    assert.strictEqual(firstReplay.status, 409, JSON.stringify(firstReplay.body));
    assert.strictEqual(firstReplay.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(firstReplay.body)['existing_event_id'], firstEnvelope['event_id']);
    assert.strictEqual(
      detailsOf(firstReplay.body)['existing_event_type'],
      'maintenance.meter_reading_recorded',
    );
    assert.strictEqual(await eventCountForKey(firstEnvelope['idempotency_key'] as string), 1);
    // Two "devices" posting without a version: both land (additive observations).
    const second = await postEdge(reading(150, 'EDGE-TAB-B'));
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.strictEqual(second.body['event_version'], (first.body['event_version'] as number) + 1);
    const meter = await getAdminPool().query(
      `SELECT current_reading::text AS current_reading FROM asset_meter WHERE meter_id = $1`,
      [meterId],
    );
    assert.strictEqual(Number(meter.rows[0]?.['current_reading']), 150);
    const readings = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM asset_meter_reading WHERE meter_id = $1`,
      [meterId],
    );
    assert.strictEqual(readings.rows[0]?.['n'], 2);
  });

  it('AC1: an edge spares issue omitting return_due_date lands issued with the derived date written back', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const reservationId = await reservedSpare(workOrderId);
    const fetched = await worklist();
    const reservations = worklistEntry(fetched.body, workOrderId)?.['reservations'] as Record<
      string,
      unknown
    >[];
    const cached = reservations.find((r) => r['reservation_id'] === reservationId);
    assert.ok(cached, 'the reserved spare must be on the worklist');
    const n = cached['stream_version'] as number;
    assert.strictEqual(n, await headOf(reservationId));

    const issuedAt = new Date().toISOString();
    const envelope = edgeEnvelope({
      stream_id: reservationId,
      event_type: 'maintenance.spare_issued',
      event_version: n + 1,
      payload: {
        reservation_id: reservationId,
        quantity: cached['quantity'],
        issued_at: issuedAt,
        business_date: TODAY,
      },
    });
    const res = await postEdge(envelope);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const persistedPayload = res.body['payload'] as Record<string, unknown>;
    assert.match(String(persistedPayload['return_due_date']), /^\d{4}-\d{2}-\d{2}$/);
    const row = await getAdminPool().query(
      `SELECT status, to_char(return_due_date, 'YYYY-MM-DD') AS return_due_date
         FROM maintenance_spare_reservation WHERE reservation_id = $1`,
      [reservationId],
    );
    assert.strictEqual(row.rows[0]?.['status'], 'issued');
    assert.strictEqual(row.rows[0]?.['return_due_date'], persistedPayload['return_due_date']);

    const replay = await postEdge(envelope);
    assert.strictEqual(replay.status, 409, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(replay.body)['existing_event_id'], envelope['event_id']);
    assert.strictEqual(detailsOf(replay.body)['existing_event_type'], 'maintenance.spare_issued');
    assert.strictEqual(await eventCountForKey(envelope['idempotency_key'] as string), 1);
  });

  it('AC1: an edge closure with all three codes completes the work order and writes the closure row', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const n = await headOf(workOrderId);
    const envelope = closureEnvelope(workOrderId, assetId, n + 1);
    const res = await postEdge(envelope);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'completed');
    const closure = await closureRow(workOrderId);
    assert.strictEqual(closure?.['origin'], 'breakdown');
    assert.strictEqual(closure?.['closed_by'], technicianUserId);
    assert.strictEqual(closure?.['fault_code'], FAULT_CODE);
    assert.strictEqual(
      (closure?.['closed_at'] as Date).toISOString(),
      (envelope['payload'] as Record<string, string>)['completed_at'],
    );

    const replay = await postEdge(envelope);
    assert.strictEqual(replay.status, 409, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual(detailsOf(replay.body)['existing_event_id'], envelope['event_id']);
    assert.strictEqual(
      detailsOf(replay.body)['existing_event_type'],
      'maintenance.work_order_completed',
    );
    assert.strictEqual(await eventCountForKey(envelope['idempotency_key'] as string), 1);
  });

  it('AC1: three offline captures stamped N+1, N+2, N+3 replay in order and land at exactly those versions', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const n =
      (worklistEntry((await worklist()).body, workOrderId)?.['stream_version'] as number) ?? 0;
    const first = await postEdge(statusEnvelope(workOrderId, assetId, n + 1, 'in_progress'));
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await postEdge(statusEnvelope(workOrderId, assetId, n + 2, 'on_hold'));
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const third = await postEdge(closureEnvelope(workOrderId, assetId, n + 3));
    assert.strictEqual(third.status, 201, JSON.stringify(third.body));
    assert.deepStrictEqual(
      [first.body['event_version'], second.body['event_version'], third.body['event_version']],
      [n + 1, n + 2, n + 3],
    );
    assert.strictEqual(await headOf(workOrderId), n + 3);
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'completed');
  });

  it('AC1: a capture stamped N+3 while the head is N+1 is STREAM_CONFLICT and inserts NOTHING (the store.ts gap hole is closed)', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const head = await headOf(workOrderId);
    const envelope = statusEnvelope(workOrderId, assetId, head + 2);
    const res = await postEdge(envelope);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'STREAM_CONFLICT');
    assert.strictEqual(detailsOf(res.body)['stream_id'], workOrderId);
    assert.strictEqual(detailsOf(res.body)['event_version'], head + 2);
    assert.strictEqual(detailsOf(res.body)['head_version'], head);
    assert.ok(detailsOf(res.body)['conflict_id']);
    assert.strictEqual(await headOf(workOrderId), head);
    assert.strictEqual(await eventCountForKey(envelope['idempotency_key'] as string), 0);
    assert.strictEqual((await conflictRowsFor(envelope['event_id'] as string)).length, 1);
  });

  it('AC1: the parked-chain re-capture (head conflict, then a capture past the local head) rejects rather than gap-inserting', async () => {
    const { workOrderId, envelope } = await raiseVersionConflict();
    // The device bumped its local head past the conflicted capture and captured again.
    const assetId = (envelope['payload'] as Record<string, string>)['asset_id']!;
    const head = await headOf(workOrderId);
    const later = await postEdge(statusEnvelope(workOrderId, assetId, head + 2, 'on_hold'));
    assert.strictEqual(later.status, 409, JSON.stringify(later.body));
    assert.strictEqual(later.body['error_code'], 'STREAM_CONFLICT');
    assert.strictEqual(await headOf(workOrderId), head);
  });

  it('AC1: benign rebase - a status update stamped over the nightly work_order_overdue sweep lands at head + 1 with no queue row', async () => {
    const { assetId } = await createAsset();
    const workOrderId = await insertPreventiveWorkOrder(assetId, {
      due_date: addDays(TODAY, -10),
      grace_until_date: addDays(TODAY, -5),
    });
    // The device fetched the worklist at head 0 (a directly-inserted order has no events yet).
    const n = worklistEntry((await worklist()).body, workOrderId)?.['stream_version'] as number;
    assert.strictEqual(n, 0);
    const sweep = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/pm/grace-sweep',
      { business_date: TODAY, asset_id: assetId },
      supervisorHeaders,
    );
    assert.strictEqual(sweep.status, 200, JSON.stringify(sweep.body));
    assert.strictEqual(await headOf(workOrderId), n + 1);
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'overdue');

    const envelope = statusEnvelope(workOrderId, assetId, n + 1);
    const res = await postEdge(envelope);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['event_version'], n + 2);
    assert.strictEqual(
      (res.body['payload'] as Record<string, unknown>)['previous_status'],
      'overdue',
    );
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'in_progress');
    assert.strictEqual((await conflictRowsFor(envelope['event_id'] as string)).length, 0);
  });

  it('AC1: a warranty override in the gap (alone, or with the sweep) is a real STREAM_CONFLICT with a queue row', async () => {
    await seedDoa('maintenance.warranty_override');
    const { assetId } = await createAsset();
    const coverage = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/coverages`,
      {
        coverage_type: 'warranty',
        provider_name: 'Acme Service Co',
        reference_number_ext: `WAR-${randomUUID().slice(0, 8)}`,
        start_date: addDays(TODAY, -10),
        expiry_date: addDays(TODAY, 400),
        business_date: TODAY,
      },
      supervisorHeaders,
    );
    assert.strictEqual(coverage.status, 201, JSON.stringify(coverage.body));
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    assert.strictEqual(workOrder['warranty_flagged'], true);
    const n = worklistEntry((await worklist()).body, workOrderId)?.['stream_version'] as number;

    // Override alone in the gap: human-authored, never rebase-safe.
    const override = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/warranty-overrides`,
      { reason_code: REASON_CODE },
      supervisorHeaders,
    );
    assert.strictEqual(override.status, 201, JSON.stringify(override.body));
    const stale = statusEnvelope(workOrderId, assetId, n + 1);
    const res = await postEdge(stale);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'STREAM_CONFLICT');
    assert.strictEqual(detailsOf(res.body)['head_version'], n + 1);
    assert.strictEqual((await conflictRowsFor(stale['event_id'] as string)).length, 1);

    // Both in the gap: a work order that went overdue AND was overridden still conflicts.
    const { assetId: assetB } = await createAsset();
    const workOrderB = await insertPreventiveWorkOrder(assetB, {
      due_date: addDays(TODAY, -10),
      grace_until_date: addDays(TODAY, -5),
    });
    const nB = worklistEntry((await worklist()).body, workOrderB)?.['stream_version'] as number;
    assert.strictEqual(
      (
        await makeRequest(
          port,
          'POST',
          '/api/v1/maintenance/pm/grace-sweep',
          { business_date: TODAY, asset_id: assetB },
          supervisorHeaders,
        )
      ).status,
      200,
    );
    assert.strictEqual((await restStatus(workOrderB, 'in_progress')).status, 200);
    const both = await postEdge(statusEnvelope(workOrderB, assetB, nB + 1, 'on_hold'));
    assert.strictEqual(both.status, 409, JSON.stringify(both.body));
    assert.strictEqual(both.body['error_code'], 'STREAM_CONFLICT');
    assert.strictEqual(detailsOf(both.body)['head_version'], nB + 2);
  });

  it('AC1: maintenance.asset_status_changed on the edge route is 403 CENTRAL_ONLY_OPERATION and leaves no row', async () => {
    const { assetId } = await createAsset();
    const envelope = edgeEnvelope({
      stream_id: assetId,
      event_type: 'maintenance.asset_status_changed',
      payload: { asset_id: assetId, new_status: 'in_service' },
    });
    const res = await postEdge(envelope);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    assert.strictEqual(detailsOf(res.body)['event_type'], 'maintenance.asset_status_changed');
    assert.strictEqual(await eventCountForKey(envelope['idempotency_key'] as string), 0);
  });

  it('AC1: a non-maintenance edge envelope (the Story 1.8 shell test capture) still returns 201', async () => {
    const res = await postEdge(edgeEnvelope());
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  // -------------------------------------------------------------------------
  // AC 2: conflicts, the sync-conflict queue and its resolution
  // -------------------------------------------------------------------------

  it('AC2: a stale edge capture over a central change is STREAM_CONFLICT, queued, and surfaced to the supervisor', async () => {
    const { res, envelope, workOrderId } = await raiseVersionConflict();
    const details = detailsOf(res.body);
    assert.strictEqual(details['stream_id'], workOrderId);
    assert.strictEqual(details['event_version'], 2);
    assert.strictEqual(details['head_version'], 2);
    const conflictId = details['conflict_id'] as string;
    assert.ok(conflictId);

    const listed = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/sync-conflicts?status=open',
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
    const row = (listed.body['conflicts'] as Record<string, unknown>[]).find(
      (c) => c['conflict_id'] === conflictId,
    );
    assert.ok(row, 'the conflict must be listed as open');
    assert.strictEqual(row['reason'], 'version_conflict');
    assert.strictEqual(row['expected_version'], 2);
    assert.strictEqual(row['head_version'], 2);
    assert.strictEqual(row['rejection_code'], null);
    assert.strictEqual(row['device_id'], DEVICE_ID);
    assert.strictEqual(row['captured_by'], technicianUserId);
    assert.strictEqual(row['location_id'], siteLocId);
    assert.strictEqual(row['stream_id'], workOrderId);
    assert.strictEqual(row['conflicting_event_id'], envelope['event_id']);
    assert.strictEqual(row['conflicting_event_type'], 'maintenance.work_order_status_updated');
    assert.deepStrictEqual(row['conflicting_payload'], envelope['payload']);
    assert.strictEqual(row['status'], 'open');

    const single = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/sync-conflicts/${conflictId}`,
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(single.status, 200);
    assert.strictEqual(
      (single.body['conflict'] as Record<string, unknown>)['conflict_id'],
      conflictId,
    );

    assert.strictEqual(await notificationCountFor(conflictId, 'maintenance_supervisor'), 1);
    const notification = await notificationFor(conflictId, 'maintenance_supervisor');
    assert.strictEqual(notification?.['location_id'], siteLocId);
    assert.strictEqual(notification?.['status_verb'], 'Flagged');
    assert.strictEqual(notification?.['object_type'], 'maintenance_sync_conflict');
    assert.strictEqual(notification?.['escalation_role'], 'maintenance_manager');
    assert.strictEqual(notification?.['escalation_window'], '86400');
    assert.strictEqual(
      notification?.['next_step'],
      'Review the conflicting capture and record a resolution',
    );
    assert.match(String(notification?.['actor_label']), new RegExp(`device ${DEVICE_ID}$`));
  });

  it('AC2: re-posting the same conflicting envelope replays the raise with the SAME conflict_id (sequential and parallel)', async () => {
    const { res, envelope } = await raiseVersionConflict();
    const conflictId = detailsOf(res.body)['conflict_id'] as string;
    const again = await postEdge(envelope);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'STREAM_CONFLICT');
    assert.strictEqual(detailsOf(again.body)['conflict_id'], conflictId);
    const [a, b] = await Promise.all([postEdge(envelope), postEdge(envelope)]);
    assert.strictEqual(detailsOf(a.body)['conflict_id'], conflictId);
    assert.strictEqual(detailsOf(b.body)['conflict_id'], conflictId);
    assert.strictEqual((await conflictRowsFor(envelope['event_id'] as string)).length, 1);
    assert.strictEqual(await notificationCountFor(conflictId, 'maintenance_supervisor'), 1);
  });

  it('AC2: a safety-flagged edge fault on a mistyped tag is queued as safety_fault_rejected; a non-safety one is not', async () => {
    const safety = faultEnvelope(`NO-SUCH-TAG-${run}`, true);
    const res = await postEdge(safety);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ASSET_NOT_FOUND');
    assert.strictEqual(detailsOf(res.body)['asset_tag'], `NO-SUCH-TAG-${run}`);
    const conflictId = detailsOf(res.body)['conflict_id'] as string;
    assert.ok(conflictId, 'a safety fault rejection must carry a conflict_id');
    const rows = await conflictRowsFor(safety['event_id'] as string);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]?.['conflict_id'], conflictId);
    assert.strictEqual(rows[0]?.['reason'], 'safety_fault_rejected');
    assert.strictEqual(rows[0]?.['rejection_code'], 'ASSET_NOT_FOUND');
    assert.strictEqual(rows[0]?.['expected_version'], null);
    assert.strictEqual(rows[0]?.['head_version'], null);
    const notification = await notificationFor(conflictId, 'maintenance_supervisor');
    assert.strictEqual(
      notification?.['next_step'],
      'Safety fault could not be filed from the device: verify the asset and re-file centrally',
    );
    assert.strictEqual(notification?.['escalation_window'], '86400');

    // Re-posting the safety fault yields the same conflict_id.
    const again = await postEdge(safety);
    assert.strictEqual(again.status, 404);
    assert.strictEqual(detailsOf(again.body)['conflict_id'], conflictId);
    assert.strictEqual(await notificationCountFor(conflictId, 'maintenance_supervisor'), 1);

    // The same mistyped tag WITHOUT the safety flag: 404, no queue row, no notification.
    const plain = faultEnvelope(`NO-SUCH-TAG-${run}`, false);
    const plainRes = await postEdge(plain);
    assert.strictEqual(plainRes.status, 404, JSON.stringify(plainRes.body));
    assert.strictEqual(plainRes.body['error_code'], 'ASSET_NOT_FOUND');
    assert.strictEqual(detailsOf(plainRes.body)['conflict_id'], undefined);
    assert.strictEqual((await conflictRowsFor(plain['event_id'] as string)).length, 0);
  });

  it('AC2: the supervisor resolves the conflict once; a second resolution, the technician, and a missing DOA entry are rejected', async () => {
    const { res } = await raiseVersionConflict();
    const conflictId = detailsOf(res.body)['conflict_id'] as string;

    const technician = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/sync-conflicts/${conflictId}/resolve`,
      { resolution_code: 'discarded' },
      technicianHeaders,
    );
    assert.strictEqual(technician.status, 403, JSON.stringify(technician.body));
    assert.strictEqual(technician.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(technician.body)['resolved_approver_user_id'], supervisorUserId);

    const resolved = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/sync-conflicts/${conflictId}/resolve`,
      {
        resolution_code: 'discarded',
        resolution_note: 'Re-entered centrally',
        idempotency_key: `res-${conflictId}`,
      },
      supervisorHeaders,
    );
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolved.body));
    const conflict = resolved.body['conflict'] as Record<string, unknown>;
    assert.strictEqual(conflict['status'], 'resolved');
    assert.strictEqual(conflict['resolution_code'], 'discarded');
    assert.strictEqual(conflict['resolution_note'], 'Re-entered centrally');
    assert.strictEqual(conflict['resolved_by'], supervisorUserId);
    assert.ok(conflict['resolved_at']);
    const persisted = await getAdminPool().query(
      `SELECT payload->>'resolved_by' AS resolved_by FROM domain_events WHERE event_id = $1`,
      [resolved.body['event_id']],
    );
    assert.strictEqual(persisted.rows[0]?.['resolved_by'], supervisorUserId);

    // Same-key replay returns the original resource (no pre-check on the now-resolved state).
    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/sync-conflicts/${conflictId}/resolve`,
      { resolution_code: 'discarded', idempotency_key: `res-${conflictId}` },
      supervisorHeaders,
    );
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], resolved.body['event_id']);

    const second = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/sync-conflicts/${conflictId}/resolve`,
      { resolution_code: 'reapplied_centrally' },
      supervisorHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'SYNC_CONFLICT_ALREADY_RESOLVED');
    assert.ok(detailsOf(second.body)['resolved_at']);

    const { res: other } = await raiseVersionConflict();
    const otherId = detailsOf(other.body)['conflict_id'] as string;
    await clearDoa('maintenance.sync_conflict_resolution');
    try {
      const unresolved = await makeRequest(
        port,
        'POST',
        `/api/v1/maintenance/sync-conflicts/${otherId}/resolve`,
        { resolution_code: 'discarded' },
        supervisorHeaders,
      );
      assert.strictEqual(unresolved.status, 404, JSON.stringify(unresolved.body));
      assert.strictEqual(unresolved.body['error_code'], 'APPROVAL_UNRESOLVED');
      assert.strictEqual(
        detailsOf(unresolved.body)['transaction_type'],
        'maintenance.sync_conflict_resolution',
      );
    } finally {
      await seedDoa('maintenance.sync_conflict_resolution');
    }

    const listedOpen = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/sync-conflicts?status=open&stream_id=${(await getAdminPool().query(`SELECT stream_id FROM maintenance_sync_conflict WHERE conflict_id = $1`, [otherId])).rows[0]!['stream_id']}`,
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(listedOpen.status, 200);
    assert.ok(
      (listedOpen.body['conflicts'] as Record<string, unknown>[]).some(
        (c) => c['conflict_id'] === otherId,
      ),
    );
  });

  it('AC2: handler validation - unknown conflict 404, bad enum 400, bad status filter 400', async () => {
    const missing = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/sync-conflicts/${randomUUID()}/resolve`,
      { resolution_code: 'discarded' },
      supervisorHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'SYNC_CONFLICT_NOT_FOUND');
    const { res } = await raiseVersionConflict();
    const conflictId = detailsOf(res.body)['conflict_id'] as string;
    const badEnum = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/sync-conflicts/${conflictId}/resolve`,
      { resolution_code: 'ignored' },
      supervisorHeaders,
    );
    assert.strictEqual(badEnum.status, 400);
    assert.strictEqual(badEnum.body['error_code'], 'INVALID_PARAMS');
    const badStatus = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/sync-conflicts?status=pending',
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(badStatus.status, 400);
    assert.strictEqual(badStatus.body['error_code'], 'INVALID_PARAMS');
    const unknownGet = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/sync-conflicts/${randomUUID()}`,
      undefined,
      supervisorHeaders,
    );
    assert.strictEqual(unknownGet.status, 404);
    assert.strictEqual(unknownGet.body['error_code'], 'SYNC_CONFLICT_NOT_FOUND');
  });

  it('AC2: the seam rejects a forged resolved_by and a duplicate raise on the direct event path (AD-12)', async () => {
    const { res, envelope, workOrderId } = await raiseVersionConflict();
    const conflictId = detailsOf(res.body)['conflict_id'] as string;

    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: conflictId,
        event_type: 'maintenance.sync_conflict_resolved',
        payload: {
          conflict_id: conflictId,
          resolution_code: 'discarded',
          resolution_note: null,
          resolved_by: randomUUID(),
          resolved_at: new Date().toISOString(),
        },
        metadata: supervisorMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'SYNC_CONFLICT_DERIVATION_MISMATCH' &&
        (err as { statusCode?: number }).statusCode === 409,
    );

    const duplicateId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: duplicateId,
        event_type: 'maintenance.sync_conflict_raised',
        payload: {
          conflict_id: duplicateId,
          stream_id: workOrderId,
          stream_type: 'maintenance',
          conflicting_event_id: envelope['event_id'],
          conflicting_event_type: 'maintenance.work_order_status_updated',
          idempotency_key: envelope['idempotency_key'],
          device_id: DEVICE_ID,
          captured_by: technicianUserId,
          location_id: siteLocId,
          reason: 'version_conflict',
          expected_version: 2,
          head_version: 2,
          rejection_code: null,
          conflicting_payload: envelope['payload'],
          occurred_at: new Date().toISOString(),
          raised_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: technicianUserId,
            role: 'maintenance_technician',
            location_id: siteLocId,
          },
          occurred_at: new Date().toISOString(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'DUPLICATE_SYNC_CONFLICT' &&
        (err as { details?: Record<string, unknown> }).details?.['existing_conflict_id'] ===
          conflictId,
    );
    assert.strictEqual((await conflictRowsFor(envelope['event_id'] as string)).length, 1);
  });

  it('AC2/AC3: the seam rejects forged captured_by, an asset_id/tag mismatch, and a forged return_due_date (AD-12)', async () => {
    // captured_by on the raise applier is the device actor, never trusted from the payload.
    const raiseConflictId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: raiseConflictId,
        event_type: 'maintenance.sync_conflict_raised',
        payload: {
          conflict_id: raiseConflictId,
          stream_id: randomUUID(),
          stream_type: 'maintenance',
          conflicting_event_id: randomUUID(),
          conflicting_event_type: 'maintenance.work_order_status_updated',
          idempotency_key: `edge-wo-status-${randomUUID()}`,
          device_id: DEVICE_ID,
          captured_by: randomUUID(),
          location_id: siteLocId,
          reason: 'version_conflict',
          expected_version: 2,
          head_version: 1,
          rejection_code: null,
          conflicting_payload: { work_order_id: randomUUID(), new_status: 'in_progress' },
          occurred_at: new Date().toISOString(),
          raised_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: technicianUserId,
            role: 'maintenance_technician',
            location_id: siteLocId,
          },
          occurred_at: new Date().toISOString(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'SYNC_CONFLICT_DERIVATION_MISMATCH' &&
        (err as { statusCode?: number }).statusCode === 409,
    );

    // A supplied asset_id belonging to a different asset than the scanned tag is a mismatch.
    const assetA = await createAsset();
    const assetB = await createAsset();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: randomUUID(),
        event_type: 'maintenance.fault_reported',
        event_version: 1,
        payload: {
          fault_report_id: randomUUID(),
          asset_id: assetA.assetId,
          asset_tag: assetB.assetTag,
          description: 'mismatched tag forgery',
          safety_flag: false,
          reported_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: technicianUserId,
            role: 'maintenance_technician',
            location_id: siteLocId,
          },
          occurred_at: new Date().toISOString(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'ASSET_TAG_MISMATCH',
    );

    // A declared return_due_date that diverges from the three-working-day clock is rejected.
    const workOrder = await breakdownWorkOrder(assetA.assetId);
    const reservationId = await reservedSpare(workOrder['work_order_id'] as string);
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: reservationId,
        event_type: 'maintenance.spare_issued',
        payload: {
          reservation_id: reservationId,
          quantity: '1',
          issued_at: new Date().toISOString(),
          return_due_date: '2099-12-31',
          business_date: TODAY,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: technicianUserId,
            role: 'maintenance_technician',
            location_id: siteLocId,
          },
          occurred_at: new Date().toISOString(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'SPARE_DERIVATION_MISMATCH' &&
        (err as { statusCode?: number }).statusCode === 409,
    );
  });

  it('AC2: RBAC 401/403 sweep on every new route', async () => {
    const id = randomUUID();
    const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['GET', '/api/v1/edge/maintenance/worklist', undefined],
      ['GET', '/api/v1/maintenance/closure-codes', undefined],
      ['GET', '/api/v1/maintenance/sync-conflicts', undefined],
      ['GET', `/api/v1/maintenance/sync-conflicts/${id}`, undefined],
      [
        'POST',
        `/api/v1/maintenance/sync-conflicts/${id}/resolve`,
        { resolution_code: 'discarded' },
      ],
      ['POST', `/api/v1/maintenance/work-orders/${id}/status`, { new_status: 'in_progress' }],
      ['GET', `/api/v1/maintenance/assets/${id}/closures`, undefined],
    ];
    for (const [method, path, body] of routes) {
      const anonymous = await makeRequest(port, method, path, body);
      assert.strictEqual(anonymous.status, 401, `${method} ${path} anonymous`);
      // No maintenance assignment at all: the module gate fires before the function gate.
      const outsider = await makeRequest(port, method, path, body, procurementHeaders);
      assert.strictEqual(outsider.status, 403, `${method} ${path} outsider`);
      assert.strictEqual(outsider.body['error_code'], 'MODULE_ACCESS_DENIED');
    }
    for (const [method, path, body] of routes.filter(([m]) => m === 'POST')) {
      const reader = await makeRequest(port, method, path, body, readerHeaders);
      assert.strictEqual(reader.status, 403, `${method} ${path} reader`);
      assert.strictEqual(reader.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    }
  });

  // -------------------------------------------------------------------------
  // AC 3: three-part closure coding
  // -------------------------------------------------------------------------

  it('AC3: a breakdown work order cannot close without all three codes, on the REST route AND the direct path', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const res = await completeWorkOrder(workOrderId);
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CLOSURE_CODES_REQUIRED');
    assert.deepStrictEqual(detailsOf(res.body)['missing'], [
      'fault_code',
      'cause_code',
      'remedy_code',
    ]);
    assert.strictEqual(detailsOf(res.body)['work_order_id'], workOrderId);

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
        metadata: supervisorMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'CLOSURE_CODES_REQUIRED' &&
        (err as { statusCode?: number }).statusCode === 422,
    );
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'open');
    assert.strictEqual(await closureRow(workOrderId), null);
  });

  it('AC3: one or two codes are INVALID_PAYLOAD (all-or-none) and an unknown code is CLOSURE_CODE_INVALID', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const one = await completeWorkOrder(workOrderId, { fault_code: FAULT_CODE });
    assert.strictEqual(one.status, 400, JSON.stringify(one.body));
    assert.strictEqual(one.body['error_code'], 'INVALID_PAYLOAD');
    const two = await completeWorkOrder(workOrderId, {
      fault_code: FAULT_CODE,
      cause_code: CAUSE_CODE,
    });
    assert.strictEqual(two.status, 400);
    assert.strictEqual(two.body['error_code'], 'INVALID_PAYLOAD');
    const tooLong = await completeWorkOrder(workOrderId, { ...CODES, remedy_code: 'X'.repeat(65) });
    assert.strictEqual(tooLong.status, 400);
    assert.strictEqual(tooLong.body['error_code'], 'INVALID_PAYLOAD');
    const unknown = await completeWorkOrder(workOrderId, { ...CODES, cause_code: 'NOT_A_CAUSE' });
    assert.strictEqual(unknown.status, 422, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'CLOSURE_CODE_INVALID');
    assert.strictEqual(detailsOf(unknown.body)['field'], 'cause_code');
    assert.strictEqual(detailsOf(unknown.body)['value'], 'NOT_A_CAUSE');
    assert.deepStrictEqual(
      detailsOf(unknown.body)['allowed'],
      config.maintenance.closureCodes.cause,
    );
    assert.strictEqual((await workOrderRow(workOrderId))?.['status'], 'open');
  });

  it('AC3: a preventive work order completes without codes (7.2 regression) or with codes (closure row)', async () => {
    const { assetId } = await createAsset();
    const plain = await insertPreventiveWorkOrder(assetId);
    const res = await completeWorkOrder(plain);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await closureRow(plain), null);

    const coded = await insertPreventiveWorkOrder(assetId);
    const withCodes = await completeWorkOrder(coded, CODES);
    assert.strictEqual(withCodes.status, 200, JSON.stringify(withCodes.body));
    const closure = await closureRow(coded);
    assert.strictEqual(closure?.['origin'], 'preventive');
    assert.strictEqual(closure?.['closed_by'], supervisorUserId);
  });

  it('AC3: a breakdown completion with all three codes records the closure with actor and completed_at, and replays unchanged', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    const key = `close-${workOrderId}`;
    const res = await completeWorkOrder(workOrderId, { ...CODES, idempotency_key: key });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const closure = await closureRow(workOrderId);
    assert.strictEqual(closure?.['origin'], 'breakdown');
    assert.strictEqual(closure?.['closed_by'], supervisorUserId);
    assert.strictEqual(closure?.['fault_code'], FAULT_CODE);
    assert.strictEqual(closure?.['cause_code'], CAUSE_CODE);
    assert.strictEqual(closure?.['remedy_code'], REMEDY_CODE);
    const persisted = await getAdminPool().query(
      `SELECT payload->>'completed_at' AS completed_at FROM domain_events WHERE event_id = $1`,
      [res.body['event_id']],
    );
    assert.strictEqual(
      (closure?.['closed_at'] as Date).toISOString(),
      persisted.rows[0]?.['completed_at'],
    );
    const before = await eventCountForKey(key);
    const replay = await completeWorkOrder(workOrderId, { ...CODES, idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], res.body['event_id']);
    assert.strictEqual(await eventCountForKey(key), before);
  });

  it('AC3: the 7.7 warranty gate still runs BEFORE the closure check, and with an override plus codes the 7.6 cost arm derives', async () => {
    await seedDoa('maintenance.warranty_override');
    const { assetId } = await createAsset();
    const coverage = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/assets/${assetId}/coverages`,
      {
        coverage_type: 'warranty',
        provider_name: 'Acme Service Co',
        reference_number_ext: `WAR-${randomUUID().slice(0, 8)}`,
        start_date: addDays(TODAY, -10),
        expiry_date: addDays(TODAY, 400),
        business_date: TODAY,
      },
      supervisorHeaders,
    );
    assert.strictEqual(coverage.status, 201, JSON.stringify(coverage.body));
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;
    assert.strictEqual(workOrder['warranty_flagged'], true);

    const gated = await completeWorkOrder(workOrderId);
    assert.strictEqual(gated.status, 403, JSON.stringify(gated.body));
    assert.strictEqual(gated.body['error_code'], 'APPROVAL_REQUIRED');
    const gatedWithCodes = await completeWorkOrder(workOrderId, CODES);
    assert.strictEqual(gatedWithCodes.status, 403);

    const override = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/work-orders/${workOrderId}/warranty-overrides`,
      { reason_code: REASON_CODE },
      supervisorHeaders,
    );
    assert.strictEqual(override.status, 201, JSON.stringify(override.body));
    const stillRequired = await completeWorkOrder(workOrderId, { labor_cost: '10.000' });
    assert.strictEqual(stillRequired.status, 422);
    assert.strictEqual(stillRequired.body['error_code'], 'CLOSURE_CODES_REQUIRED');
    const done = await completeWorkOrder(workOrderId, {
      labor_cost: '10.000',
      parts_cost: '2.500',
      ...CODES,
    });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    const row = await workOrderRow(workOrderId);
    assert.strictEqual(row?.['status'], 'completed');
    assert.strictEqual(row?.['total_cost'], '12.500');
    assert.ok(await closureRow(workOrderId));
  });

  it('AC3: GET /closure-codes returns the three configured catalogues', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/closure-codes',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      fault: config.maintenance.closureCodes.fault,
      cause: config.maintenance.closureCodes.cause,
      remedy: config.maintenance.closureCodes.remedy,
    });
  });

  // -------------------------------------------------------------------------
  // AC 4: the last five closures at work-order open
  // -------------------------------------------------------------------------

  it('AC4: the work-order read, the per-asset list and the worklist present the last five breakdown closures newest-first', async () => {
    const { assetId } = await createAsset();
    const empty = await breakdownWorkOrder(assetId);
    const emptyRead = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${empty['work_order_id']}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(emptyRead.status, 200);
    assert.deepStrictEqual(emptyRead.body['recent_closures'], []);
    // Closed NOW, so it is the newest breakdown closure on the asset throughout this test.
    const newestId = empty['work_order_id'] as string;
    assert.strictEqual((await completeWorkOrder(newestId, CODES)).status, 200);

    const base = Date.parse('2026-08-01T10:00:00.000Z');
    const closedIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      closedIds.push(await closeBreakdownAt(assetId, new Date(base + i * 3600000).toISOString()));
    }
    // Three PM closures, newer than every breakdown closure, must NOT displace them by default.
    for (let i = 0; i < 3; i += 1) {
      const pm = await insertPreventiveWorkOrder(assetId);
      await persistEvent({
        stream_type: 'maintenance',
        stream_id: pm,
        event_type: 'maintenance.work_order_completed',
        payload: {
          work_order_id: pm,
          asset_id: assetId,
          completed_at: new Date(base + (10 + i) * 3600000).toISOString(),
          ...CODES,
        },
        metadata: supervisorMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    const seventh = await breakdownWorkOrder(assetId);
    const seventhId = seventh['work_order_id'] as string;
    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${seventhId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const recent = read.body['recent_closures'] as Record<string, unknown>[];
    assert.strictEqual(recent.length, 5);
    assert.ok(recent.every((c) => c['origin'] === 'breakdown'));
    // Newest first: the closure recorded now, then the four latest of the six anchored ones; the
    // two oldest anchored closures fall outside the window.
    assert.deepStrictEqual(
      recent.map((c) => c['work_order_id']),
      [newestId, ...[...closedIds].reverse().slice(0, 4)],
    );
    assert.ok(
      recent.every((c) => c['fault_code'] && c['cause_code'] && c['remedy_code'] && c['closed_at']),
    );

    const widened = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/work-orders/${seventhId}?include_preventive=true`,
      undefined,
      readerHeaders,
    );
    const mixed = widened.body['recent_closures'] as Record<string, unknown>[];
    assert.strictEqual(mixed.length, 5);
    assert.strictEqual(mixed.filter((c) => c['origin'] === 'preventive').length, 3);

    // The full ledger pages all ten closures (one from the first coded completion, six, three).
    const page1 = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/closures?limit=4&offset=0`,
      undefined,
      readerHeaders,
    );
    const page2 = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/closures?limit=4&offset=4`,
      undefined,
      readerHeaders,
    );
    const page3 = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/closures?limit=4&offset=8`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(page1.status, 200);
    assert.strictEqual(
      (page1.body['closures'] as unknown[]).length +
        (page2.body['closures'] as unknown[]).length +
        (page3.body['closures'] as unknown[]).length,
      10,
    );
    const breakdownOnly = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${assetId}/closures?origin=breakdown&limit=50`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual((breakdownOnly.body['closures'] as unknown[]).length, 7);
    const unknownAsset = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/assets/${randomUUID()}/closures`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(unknownAsset.status, 404);
    assert.strictEqual(unknownAsset.body['error_code'], 'ASSET_NOT_FOUND');

    // The worklist carries the same five per work order and the true stream head.
    const fetched = await worklist('?limit=500');
    assert.strictEqual(fetched.status, 200, JSON.stringify(fetched.body));
    const entry = worklistEntry(fetched.body, seventhId);
    assert.ok(entry);
    assert.deepStrictEqual(
      (entry['recent_closures'] as Record<string, unknown>[]).map((c) => c['work_order_id']),
      recent.map((c) => c['work_order_id']),
    );
    assert.strictEqual(entry['stream_version'], await headOf(seventhId));
    assert.deepStrictEqual(fetched.body['closure_codes'], {
      fault: config.maintenance.closureCodes.fault,
      cause: config.maintenance.closureCodes.cause,
      remedy: config.maintenance.closureCodes.remedy,
    });
  });

  it('AC4: worklist limit bounds reject 400, and a truncated page reports total and truncated', async () => {
    for (const bad of ['0', '501', 'abc', '-1']) {
      const res = await worklist(`?limit=${bad}`);
      assert.strictEqual(res.status, 400, `limit=${bad}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
    // At least three open work orders exist by now (earlier tests leave them open); pin three more.
    const { assetId } = await createAsset();
    for (let i = 0; i < 3; i += 1) await breakdownWorkOrder(assetId);
    const res = await worklist('?limit=2');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const workOrders = res.body['work_orders'] as Record<string, unknown>[];
    assert.strictEqual(workOrders.length, 2);
    assert.ok((res.body['total'] as number) >= 3);
    assert.strictEqual(res.body['truncated'], true);
    // The two highest-priority rows: p1/p2 sort before everything else and before NULL.
    assert.ok(workOrders.every((row) => row['priority'] !== null));
    assert.ok(String(workOrders[0]!['priority']) <= String(workOrders[1]!['priority']));
    const full = await worklist('?limit=500');
    assert.strictEqual(full.body['truncated'], (full.body['total'] as number) > 500);
  });

  // -------------------------------------------------------------------------
  // Status machine (Binding Decision 7)
  // -------------------------------------------------------------------------

  it('Status machine: the allowed transitions succeed with the audit fields; the others are rejected with the exact codes', async () => {
    const { assetId } = await createAsset();
    const workOrder = await breakdownWorkOrder(assetId);
    const workOrderId = workOrder['work_order_id'] as string;

    const onHoldFromOpen = await restStatus(workOrderId, 'on_hold');
    assert.strictEqual(onHoldFromOpen.status, 409, JSON.stringify(onHoldFromOpen.body));
    assert.strictEqual(onHoldFromOpen.body['error_code'], 'INVALID_STATUS_TRANSITION');
    assert.strictEqual(detailsOf(onHoldFromOpen.body)['from'], 'open');
    assert.strictEqual(detailsOf(onHoldFromOpen.body)['to'], 'on_hold');
    assert.deepStrictEqual(detailsOf(onHoldFromOpen.body)['allowed'], ['in_progress']);

    const inProgress = await restStatus(
      workOrderId,
      'in_progress',
      { note: 'Started' },
      technicianHeaders,
    );
    assert.strictEqual(inProgress.status, 200, JSON.stringify(inProgress.body));
    const row1 = inProgress.body['work_order'] as Record<string, unknown>;
    assert.strictEqual(row1['status'], 'in_progress');
    assert.strictEqual(row1['status_updated_by'], technicianUserId);
    assert.strictEqual(row1['status_note'], 'Started');
    assert.ok(row1['status_updated_at']);

    const onHold = await restStatus(workOrderId, 'on_hold');
    assert.strictEqual(onHold.status, 200, JSON.stringify(onHold.body));
    assert.strictEqual((onHold.body['work_order'] as Record<string, unknown>)['status'], 'on_hold');
    assert.strictEqual((onHold.body['work_order'] as Record<string, unknown>)['status_note'], null);

    const resumed = await restStatus(workOrderId, 'in_progress');
    assert.strictEqual(resumed.status, 200, JSON.stringify(resumed.body));
    assert.strictEqual(
      (resumed.body['work_order'] as Record<string, unknown>)['status'],
      'in_progress',
    );

    const badEnum = await restStatus(workOrderId, 'completed');
    assert.strictEqual(badEnum.status, 400);
    assert.strictEqual(badEnum.body['error_code'], 'INVALID_PARAMS');
    const longNote = await restStatus(workOrderId, 'on_hold', { note: 'x'.repeat(501) });
    assert.strictEqual(longNote.status, 400);
    assert.strictEqual(longNote.body['error_code'], 'INVALID_PARAMS');
    const unknown = await restStatus(randomUUID(), 'in_progress');
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body['error_code'], 'WORK_ORDER_NOT_FOUND');

    // A declared previous_status on the direct path is a forgery.
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: workOrderId,
        event_type: 'maintenance.work_order_status_updated',
        payload: {
          work_order_id: workOrderId,
          asset_id: assetId,
          new_status: 'on_hold',
          note: null,
          updated_at: new Date().toISOString(),
          previous_status: 'open',
        },
        metadata: supervisorMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'WORK_ORDER_DERIVATION_MISMATCH' &&
        (err as { statusCode?: number }).statusCode === 409,
    );

    // Completion from in_progress succeeds; a transition on a completed order is rejected.
    const done = await completeWorkOrder(workOrderId, CODES);
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    const afterDone = await restStatus(workOrderId, 'in_progress');
    assert.strictEqual(afterDone.status, 409, JSON.stringify(afterDone.body));
    assert.strictEqual(afterDone.body['error_code'], 'WORK_ORDER_ALREADY_COMPLETED');
    assert.ok(detailsOf(afterDone.body)['completed_at']);
  });

  it('Status machine: completion from on_hold succeeds, and the grace sweep flips only open work orders', async () => {
    const { assetId } = await createAsset();
    const held = await insertPreventiveWorkOrder(assetId, {
      due_date: addDays(TODAY, -10),
      grace_until_date: addDays(TODAY, -5),
    });
    assert.strictEqual((await restStatus(held, 'in_progress')).status, 200);
    assert.strictEqual((await restStatus(held, 'on_hold')).status, 200);
    const stillOpen = await insertPreventiveWorkOrder(assetId, {
      due_date: addDays(TODAY, -10),
      grace_until_date: addDays(TODAY, -5),
    });
    const sweep = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/pm/grace-sweep',
      { business_date: TODAY, asset_id: assetId },
      supervisorHeaders,
    );
    assert.strictEqual(sweep.status, 200, JSON.stringify(sweep.body));
    assert.strictEqual((await workOrderRow(stillOpen))?.['status'], 'overdue');
    // Decision 7 boundary: an on_hold order past its grace window is NOT swept.
    assert.strictEqual((await workOrderRow(held))?.['status'], 'on_hold');
    const done = await completeWorkOrder(held);
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.strictEqual((await workOrderRow(held))?.['status'], 'completed');
    // And the list filter accepts the new vocabulary.
    const listed = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/work-orders?status=on_hold',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
  });
});

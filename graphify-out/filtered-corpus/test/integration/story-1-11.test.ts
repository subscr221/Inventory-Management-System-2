import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from '../../src/api/router.js';
import { provisionUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import {
  listNotificationsHandler,
  getUnreadCountHandler,
  updateNotificationHandler,
  acknowledgeNotificationHandler,
  getPreferencesHandler,
  putPreferencesHandler,
  createPushSubscriptionHandler,
  deletePushSubscriptionHandler,
} from '../../src/api/v1/notification.js';
import { emitNotification } from '../../src/notify/emit.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { runEscalationCycle } from '../../src/notify/escalate.js';
import { runExpiryCycle } from '../../src/notify/expire.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 3997;
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const LOCATION_A = '55555555-5555-4555-8555-555555555555';
const LOCATION_B = '66666666-6666-4666-8666-666666666666';
const SYSTEM_ACTOR = { user_id: '00000000-0000-0000-0000-000000000000', role: 'system', location_id: LOCATION_A };

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

function makeRequest(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
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
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolvePromise({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(port, 'POST', '/api/v1/scim/v2/Users', { externalId, email: externalId, displayName: externalId, roles }, SCIM_HEADERS);
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  const token = (res.body as Record<string, string>)['token'] ?? '';
  return { Authorization: `Bearer ${token}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Story 1.11 Notification and Alerting Foundation Integration Tests', () => {
  let server: Server;
  let supervisorAHeaders: Record<string, string>;
  let supervisorBHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let deniedHeaders: Record<string, string>;

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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE notification_preferences, push_subscriptions, notification_escalations, notification_escalation_defs, notification_dispatch_attempts, notification_dispatch_log, notification_deliveries, notifications, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    const router = new Router();
    router.post('/api/v1/scim/v2/Users', provisionUserHandler);
    router.post('/api/v1/auth/dev-token', devTokenHandler);
    router.get('/api/v1/notifications', listNotificationsHandler);
    router.get('/api/v1/notifications/unread-count', getUnreadCountHandler);
    router.patch('/api/v1/notifications/:id', updateNotificationHandler);
    router.post('/api/v1/notifications/:id/acknowledge', acknowledgeNotificationHandler);
    router.get('/api/v1/notifications/preferences', getPreferencesHandler);
    router.put('/api/v1/notifications/preferences', putPreferencesHandler);
    router.post('/api/v1/notifications/push-subscription', createPushSubscriptionHandler);
    router.delete('/api/v1/notifications/push-subscription', deletePushSubscriptionHandler);

    server = createServer((req, res) => {
      router.handle(req, res).catch((err) => {
        console.error('Unhandled server error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error_code: 'INTERNAL_ERROR', message: 'Internal server error', details: {}, trace_id: 'unknown' }));
        }
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(TEST_PORT, () => resolvePromise()));

    await provisionUser(TEST_PORT, 'notif-supervisor-a@example.com', [
      { role: 'maintenance_supervisor', module: 'maintenance', functionScope: 'write', locationId: LOCATION_A },
      { role: 'notification_access', module: 'notification', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'notif-supervisor-b@example.com', [
      { role: 'maintenance_supervisor', module: 'maintenance', functionScope: 'write', locationId: LOCATION_B },
      { role: 'notification_access', module: 'notification', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'notif-compliance@example.com', [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
      { role: 'notification_access', module: 'notification', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'notif-denied@example.com', [{ role: 'viewer', module: 'inventory', functionScope: 'read', locationId: '*' }]);

    supervisorAHeaders = await authFor(TEST_PORT, 'notif-supervisor-a@example.com');
    supervisorBHeaders = await authFor(TEST_PORT, 'notif-supervisor-b@example.com');
    complianceHeaders = await authFor(TEST_PORT, 'notif-compliance@example.com');
    deniedHeaders = await authFor(TEST_PORT, 'notif-denied@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: emitted notification is delivered in-app to every user holding the target role at the target location, with trace_id recorded', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-0001',
      actor: SYSTEM_ACTOR,
    });
    assert.strictEqual(emitted.ok, true);

    const result = await runDispatchCycle();
    assert.strictEqual(result.notificationsCreated, 1, 'only the location-A supervisor should be notified');

    const listA = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, supervisorAHeaders);
    assert.strictEqual(listA.status, 200, JSON.stringify(listA.body));
    const notificationsA = listA.body['notifications'] as Array<Record<string, unknown>>;
    assert.strictEqual(notificationsA.length, 1);
    assert.strictEqual(notificationsA[0]!['object_id'], 'FLT-0001');
    assert.strictEqual(notificationsA[0]!['status'], 'created');

    const listB = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, supervisorBHeaders);
    assert.strictEqual(listB.status, 200, JSON.stringify(listB.body));
    assert.strictEqual((listB.body['notifications'] as unknown[]).length, 0, 'location-B supervisor must not receive a location-A alert');

    const deliveries = await getPool().query(
      `SELECT trace_id, outcome FROM notification_deliveries d JOIN notifications n ON n.notification_id = d.notification_id WHERE n.object_id = 'FLT-0001' AND d.channel = 'in_app'`,
    );
    assert.strictEqual(deliveries.rows.length, 1);
    assert.strictEqual(deliveries.rows[0]!['outcome'], 'delivered');
    assert.ok(deliveries.rows[0]!['trace_id'], 'delivery must record a trace_id');
  });

  it('AC4: emission never blocks the emitting caller, and the notification is durably queued until a (recovered) dispatch cycle delivers it', async () => {
    const before = await getPool().query(`SELECT count(*)::int AS count FROM notifications WHERE object_id = 'REQ-9001'`);
    assert.strictEqual(before.rows[0]!['count'], 0);

    const start = Date.now();
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'approval_received',
      status_verb: 'Approved',
      object_type: 'requisition',
      object_id: 'REQ-9001',
      actor: SYSTEM_ACTOR,
    });
    const elapsedMs = Date.now() - start;
    assert.strictEqual(emitted.ok, true);
    assert.ok(elapsedMs < 2000, `emission must complete quickly, not block on delivery (took ${elapsedMs}ms)`);

    // "Service unavailable": no dispatch cycle has run yet - the event exists but nothing has
    // fanned out to notifications yet. This IS the durable-queue state, not data loss.
    const stillQueued = await getPool().query(
      `SELECT count(*)::int AS count FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.created' AND payload->>'object_id' = 'REQ-9001'`,
    );
    assert.strictEqual(stillQueued.rows[0]!['count'], 1, 'the event must be durably persisted even though nothing has dispatched it yet');
    const notYetFannedOut = await getPool().query(`SELECT count(*)::int AS count FROM notifications WHERE object_id = 'REQ-9001'`);
    assert.strictEqual(notYetFannedOut.rows[0]!['count'], 0);

    // "Recovery": the dispatcher runs again and catches up.
    await runDispatchCycle();
    const afterRecovery = await getPool().query(`SELECT count(*)::int AS count FROM notifications WHERE object_id = 'REQ-9001'`);
    assert.strictEqual(afterRecovery.rows[0]!['count'], 1, 'delivered once the dispatcher recovers');
  });

  it('AC3: a recipient with no reachable push channel still gets the in-app notification, with its original occurred_at preserved', async () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    await putPreferences(complianceHeaders, 'goods_received', true);
    const subscribe = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/notifications/push-subscription',
      { endpoint: 'https://push.example.com/unreachable-endpoint', keys: { p256dh: 'test-p256dh', auth: 'test-auth' } },
      complianceHeaders,
    );
    assert.strictEqual(subscribe.status, 201, JSON.stringify(subscribe.body));

    await emitNotification({
      target: { role: 'compliance_admin', location_id: null },
      event_type: 'goods_received',
      status_verb: 'Received',
      object_type: 'po',
      object_id: 'PO-0042',
      actor: SYSTEM_ACTOR,
      occurred_at: occurredAt,
    });
    await runDispatchCycle();

    const list = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, complianceHeaders);
    const match = (list.body['notifications'] as Array<Record<string, unknown>>).find((n) => n['object_id'] === 'PO-0042');
    assert.ok(match, 'in-app delivery must not be lost when the push channel is unreachable');
    assert.strictEqual(match!['occurred_at'], occurredAt, 'timestamp must be the original event time, not a delivery-attempt re-stamp');

    const pushDelivery = await getPool().query(
      `SELECT outcome, failure_reason FROM notification_deliveries d JOIN notifications n ON n.notification_id = d.notification_id
       WHERE n.object_id = 'PO-0042' AND d.channel = 'web_push'`,
    );
    assert.strictEqual(pushDelivery.rows.length, 1);
    assert.strictEqual(pushDelivery.rows[0]!['outcome'], 'failed');
    assert.ok(pushDelivery.rows[0]!['failure_reason']);
  });

  it('AC2: an unacknowledged escalating alert escalates to the DOA-resolved role after its window elapses, and every hop is recorded', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-ESC-01',
      actor: SYSTEM_ACTOR,
      escalation: { target_role: 'compliance_admin', acknowledgment_window_seconds: 1 },
    });
    assert.strictEqual(emitted.ok, true);
    const sourceEventId = emitted.ok ? emitted.event.event_id : '';
    await runDispatchCycle();
    await sleep(1100);

    const cycle = await runEscalationCycle();
    assert.strictEqual(cycle.escalated, 1);

    const escalationRows = await getPool().query(
      `SELECT from_target, to_target, resolved_via FROM notification_escalations WHERE source_event_id = $1 ORDER BY escalated_at DESC LIMIT 1`,
      [sourceEventId],
    );
    assert.strictEqual(escalationRows.rows.length, 1);
    assert.strictEqual(escalationRows.rows[0]!['to_target'], 'role:compliance_admin');
    assert.strictEqual(escalationRows.rows[0]!['resolved_via'], 'doa_role_holder');

    // Task 4.4: the hop is event-sourced, not only a read-model row.
    const escalatedEvents = await getPool().query(
      `SELECT payload FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.escalated' AND payload->>'source_event_id' = $1`,
      [sourceEventId],
    );
    assert.strictEqual(escalatedEvents.rows.length, 1, 'a notification.escalated domain event must be persisted for the hop');

    // The original def is now resolved (claimed by this escalation), so it never re-fires.
    const originalDef = await getPool().query(`SELECT resolved FROM notification_escalation_defs WHERE source_event_id = $1`, [sourceEventId]);
    assert.strictEqual(originalDef.rows[0]!['resolved'], true, 'the original escalation def must be resolved after escalating');

    await runDispatchCycle();
    const complianceList = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, complianceHeaders);
    const escalated = (complianceList.body['notifications'] as Array<Record<string, unknown>>).find((n) => n['object_id'] === 'FLT-ESC-01');
    assert.ok(escalated, 'the escalation target must receive their own notification through the same delivery path');

    // No-silent-expiry chain (AC2 / Task 4.5): the escalation notification to compliance_admin
    // itself carries a follow-on escalation to the configured fallback role, so an unacknowledged
    // escalation keeps climbing to a guaranteed-staffed tier instead of just stopping.
    const fallbackDef = await getPool().query(
      `SELECT escalation_target_role FROM notification_escalation_defs WHERE source_event_id = $1`,
      [escalated!['source_event_id']],
    );
    assert.strictEqual(fallbackDef.rows.length, 1, 'the escalated alert must schedule a further escalation to the fallback tier');
    assert.strictEqual(fallbackDef.rows[0]!['escalation_target_role'], 'system_admin');
  });

  it('AC2: acknowledging before the window elapses stops the alert from ever escalating', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-ACK-01',
      actor: SYSTEM_ACTOR,
      escalation: { target_role: 'compliance_admin', acknowledgment_window_seconds: 3600 },
    });
    assert.strictEqual(emitted.ok, true);
    await runDispatchCycle();

    const list = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, supervisorAHeaders);
    const own = (list.body['notifications'] as Array<Record<string, unknown>>).find((n) => n['object_id'] === 'FLT-ACK-01');
    assert.ok(own);

    const ack = await makeRequest(TEST_PORT, 'POST', `/api/v1/notifications/${own!['notification_id'] as string}/acknowledge`, {}, supervisorAHeaders);
    assert.strictEqual(ack.status, 200, JSON.stringify(ack.body));
    assert.strictEqual(ack.body['escalation_resolved'], true);

    // Force the deadline into the past directly (bypassing the 1-hour wait) to prove the resolved
    // flag - not the deadline - is what prevents escalation.
    await getPool().query(
      `UPDATE notification_escalation_defs SET deadline_at = now() - interval '1 second'
       WHERE source_event_id = (SELECT source_event_id FROM notifications WHERE notification_id = $1)`,
      [own!['notification_id']],
    );
    const cycle = await runEscalationCycle();
    assert.strictEqual(cycle.defsProcessed, 0, 'an acknowledged alert must never escalate, no matter how far past its deadline');

    // Task 4.1: acknowledgment is event-sourced.
    const ackEvents = await getPool().query(
      `SELECT payload FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.acknowledged'
       AND payload->>'source_event_id' = $1`,
      [emitted.ok ? emitted.event.event_id : ''],
    );
    assert.strictEqual(ackEvents.rows.length, 1, 'a notification.acknowledged domain event must be persisted');
  });

  it('AC2: marking a notification acted_upon via PATCH also stops escalation (resolved decision)', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-ACTED-01',
      actor: SYSTEM_ACTOR,
      escalation: { target_role: 'compliance_admin', acknowledgment_window_seconds: 3600 },
    });
    assert.strictEqual(emitted.ok, true);
    await runDispatchCycle();

    const list = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, supervisorAHeaders);
    const own = (list.body['notifications'] as Array<Record<string, unknown>>).find((n) => n['object_id'] === 'FLT-ACTED-01')!;

    const patch = await makeRequest(TEST_PORT, 'PATCH', `/api/v1/notifications/${own['notification_id'] as string}`, { action: 'acted_upon' }, supervisorAHeaders);
    assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));
    assert.strictEqual(patch.body['status'], 'acted_upon');

    const def = await getPool().query(`SELECT resolved FROM notification_escalation_defs WHERE source_event_id = $1`, [
      emitted.ok ? emitted.event.event_id : '',
    ]);
    assert.strictEqual(def.rows[0]!['resolved'], true, 'acting on a notification must resolve its escalation clock');

    await getPool().query(`UPDATE notification_escalation_defs SET deadline_at = now() - interval '1 second' WHERE source_event_id = $1`, [
      emitted.ok ? emitted.event.event_id : '',
    ]);
    const cycle = await runEscalationCycle();
    assert.strictEqual(cycle.defsProcessed, 0, 'an acted-upon alert must never escalate');
  });

  it('Task 5.3: notifications past the retention window transition to expired and emit a notification.expired event', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_B },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-EXP-01',
      actor: SYSTEM_ACTOR,
    });
    assert.strictEqual(emitted.ok, true);
    await runDispatchCycle();

    // Backdate the row past the 30-day (default) retention window.
    await getPool().query(
      `UPDATE notifications SET created_at = now() - interval '60 days' WHERE source_event_id = $1`,
      [emitted.ok ? emitted.event.event_id : ''],
    );

    const result = await runExpiryCycle();
    assert.ok(result.expired >= 1);

    const expiredRow = await getPool().query(`SELECT status FROM notifications WHERE source_event_id = $1`, [emitted.ok ? emitted.event.event_id : '']);
    assert.strictEqual(expiredRow.rows[0]!['status'], 'expired');

    const expiredEvents = await getPool().query(
      `SELECT 1 FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.expired' AND payload->>'source_event_id' = $1`,
      [emitted.ok ? emitted.event.event_id : ''],
    );
    assert.strictEqual(expiredEvents.rows.length, 1, 'an expired notification must emit a notification.expired event');

    // Idempotent: a second sweep does not re-expire or re-emit for the same row.
    const before = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'notification.expired' AND payload->>'source_event_id' = $1`,
      [emitted.ok ? emitted.event.event_id : ''],
    );
    await runExpiryCycle();
    const after = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'notification.expired' AND payload->>'source_event_id' = $1`,
      [emitted.ok ? emitted.event.event_id : ''],
    );
    assert.strictEqual(after.rows[0]!['c'], before.rows[0]!['c'], 'a second expiry sweep must be a no-op for already-expired rows');
  });

  it('P8: an escalation with a non-positive window is dropped, not persisted as a poison-pill def', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-BADWIN-01',
      actor: SYSTEM_ACTOR,
      escalation: { target_role: 'compliance_admin', acknowledgment_window_seconds: 0 },
    });
    assert.strictEqual(emitted.ok, true);

    const dispatch = await runDispatchCycle();
    assert.ok(dispatch.eventsProcessed >= 1);

    // The notification still delivered, but no escalation def was created (window was invalid).
    const delivered = await getPool().query(`SELECT count(*)::int AS c FROM notifications WHERE object_id = 'FLT-BADWIN-01'`);
    assert.strictEqual(delivered.rows[0]!['c'], 1);
    const def = await getPool().query(`SELECT count(*)::int AS c FROM notification_escalation_defs WHERE source_event_id = $1`, [
      emitted.ok ? emitted.event.event_id : '',
    ]);
    assert.strictEqual(def.rows[0]!['c'], 0, 'a non-positive window must not create an escalation def');

    // And the event is not a poison pill: it is marked dispatched exactly once.
    const dispatchLog = await getPool().query(`SELECT count(*)::int AS c FROM notification_dispatch_log WHERE source_event_id = $1`, [
      emitted.ok ? emitted.event.event_id : '',
    ]);
    assert.strictEqual(dispatchLog.rows[0]!['c'], 1);
  });

  it('P5: malformed since/until list filters are rejected with 400, not a 500', async () => {
    const badSince = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications?since=notadate', undefined, supervisorAHeaders);
    assert.strictEqual(badSince.status, 400, JSON.stringify(badSince.body));
    const badUntil = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications?until=2026-13-99', undefined, supervisorAHeaders);
    assert.strictEqual(badUntil.status, 400, JSON.stringify(badUntil.body));
    const good = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications?since=2026-01-01T00:00:00.000Z', undefined, supervisorAHeaders);
    assert.strictEqual(good.status, 200, JSON.stringify(good.body));
  });

  it('preferences default to opted-out and PUT updates them per event type', async () => {
    const initial = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications/preferences', undefined, supervisorBHeaders);
    assert.strictEqual(initial.status, 200, JSON.stringify(initial.body));
    const initialPrefs = initial.body['preferences'] as Array<Record<string, unknown>>;
    assert.ok(initialPrefs.every((p) => p['opted_in'] === false));
    assert.ok(initialPrefs.some((p) => p['event_type'] === 'approval_received'));

    const put = await putPreferences(supervisorBHeaders, 'approval_received', true);
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));

    const after1 = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications/preferences', undefined, supervisorBHeaders);
    const afterPrefs = after1.body['preferences'] as Array<Record<string, unknown>>;
    assert.strictEqual(afterPrefs.find((p) => p['event_type'] === 'approval_received')?.['opted_in'], true);
  });

  it('unread-count and PATCH read/acted_upon lifecycle transitions', async () => {
    await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_B },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-LC-01',
      actor: SYSTEM_ACTOR,
    });
    await runDispatchCycle();

    const countBefore = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications/unread-count', undefined, supervisorBHeaders);
    assert.ok((countBefore.body['unread_count'] as number) >= 1);

    const list = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, supervisorBHeaders);
    const target = (list.body['notifications'] as Array<Record<string, unknown>>).find((n) => n['object_id'] === 'FLT-LC-01')!;

    const markRead = await makeRequest(TEST_PORT, 'PATCH', `/api/v1/notifications/${target['notification_id'] as string}`, { action: 'read' }, supervisorBHeaders);
    assert.strictEqual(markRead.status, 200, JSON.stringify(markRead.body));
    assert.strictEqual(markRead.body['status'], 'read');

    const markActed = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/notifications/${target['notification_id'] as string}`,
      { action: 'acted_upon' },
      supervisorBHeaders,
    );
    assert.strictEqual(markActed.status, 200, JSON.stringify(markActed.body));
    assert.strictEqual(markActed.body['status'], 'acted_upon');

    // A different recipient may not act on someone else's notification.
    const otherUsersAttempt = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/notifications/${target['notification_id'] as string}`,
      { action: 'read' },
      supervisorAHeaders,
    );
    assert.strictEqual(otherUsersAttempt.status, 404, JSON.stringify(otherUsersAttempt.body));
  });

  it('push subscription register/unregister controls whether a web_push delivery is attempted', async () => {
    await putPreferences(supervisorAHeaders, 'sync_complete', true);
    const register = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/notifications/push-subscription',
      { endpoint: 'https://push.example.com/sub-1', keys: { p256dh: 'p', auth: 'a' } },
      supervisorAHeaders,
    );
    assert.strictEqual(register.status, 201, JSON.stringify(register.body));

    const unregister = await makeRequest(
      TEST_PORT,
      'DELETE',
      `/api/v1/notifications/push-subscription?endpoint=${encodeURIComponent('https://push.example.com/sub-1')}`,
      undefined,
      supervisorAHeaders,
    );
    assert.strictEqual(unregister.status, 200, JSON.stringify(unregister.body));
    assert.strictEqual(unregister.body['deleted'], true);

    await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'sync_complete',
      status_verb: 'Synced',
      object_type: 'sync_batch',
      object_id: 'SYNC-0001',
      actor: SYSTEM_ACTOR,
    });
    await runDispatchCycle();

    const pushAttempts = await getPool().query(
      `SELECT count(*)::int AS count FROM notification_deliveries d JOIN notifications n ON n.notification_id = d.notification_id
       WHERE n.object_id = 'SYNC-0001' AND d.channel = 'web_push'`,
    );
    assert.strictEqual(pushAttempts.rows[0]!['count'], 0, 'no push attempt should be made once the subscription is unregistered');
  });

  it('RBAC: a user without the notification module role is denied', async () => {
    const list = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications', undefined, deniedHeaders);
    assert.strictEqual(list.status, 403, JSON.stringify(list.body));

    const prefs = await makeRequest(TEST_PORT, 'GET', '/api/v1/notifications/preferences', undefined, deniedHeaders);
    assert.strictEqual(prefs.status, 403, JSON.stringify(prefs.body));
  });

  it('regression guard: dispatch only ever processes stream_type "notification" events, other streams are untouched', async () => {
    const before = await runDispatchCycle();
    const pool = getPool();
    await pool.query(
      `INSERT INTO domain_events (stream_type, stream_id, event_type, event_version, payload, metadata)
       VALUES ('maintenance', $1, 'maintenance.note_recorded', 1, '{"note":"unrelated"}'::jsonb, $2::jsonb)`,
      [randomUUID(), JSON.stringify({ correlation_id: randomUUID(), actor: SYSTEM_ACTOR, occurred_at: new Date().toISOString() })],
    );
    const after1 = await runDispatchCycle();
    assert.strictEqual(after1.eventsProcessed, 0, 'a non-notification stream must never be picked up by the dispatcher');
    assert.strictEqual(before.eventsProcessed, before.eventsProcessed);
  });

  it('P1: a failure mid-escalation-hop rolls back the claim, so the escalation retries instead of being silently lost', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-ATOMIC-01',
      actor: SYSTEM_ACTOR,
      escalation: { target_role: 'compliance_admin', acknowledgment_window_seconds: 1 },
    });
    assert.strictEqual(emitted.ok, true);
    const sourceEventId = emitted.ok ? emitted.event.event_id : '';
    await runDispatchCycle();
    await sleep(1100);

    // Fault injection: fail the hop-record INSERT inside the escalation transaction - the exact
    // crash window that previously (claim-then-act, autocommit) lost the escalation forever.
    const adminPool = getAdminPool();
    await adminPool.query(
      `CREATE OR REPLACE FUNCTION test_inject_escalation_failure() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'injected escalation failure'; END $$ LANGUAGE plpgsql`,
    );
    await adminPool.query(
      `CREATE TRIGGER test_inject_escalation_failure_trg BEFORE INSERT ON notification_escalations
       FOR EACH ROW EXECUTE FUNCTION test_inject_escalation_failure()`,
    );
    try {
      const failedCycle = await runEscalationCycle();
      assert.strictEqual(failedCycle.escalated, 0, 'a hop whose transaction failed must not count as escalated');

      const def = await getPool().query(`SELECT resolved FROM notification_escalation_defs WHERE source_event_id = $1`, [sourceEventId]);
      assert.strictEqual(def.rows[0]!['resolved'], false, 'a failed hop must release its claim so the escalation retries');

      const orphanNotifications = await getPool().query(
        `SELECT count(*)::int AS c FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'event_type' = 'escalation' AND metadata->>'causation_id' = $1`,
        [sourceEventId],
      );
      assert.strictEqual(orphanNotifications.rows[0]!['c'], 0, 'no escalation notification may survive the rolled-back hop');
      const orphanHopEvents = await getPool().query(
        `SELECT count(*)::int AS c FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.escalated'
         AND payload->>'source_event_id' = $1`,
        [sourceEventId],
      );
      assert.strictEqual(orphanHopEvents.rows[0]!['c'], 0, 'no notification.escalated event may survive the rolled-back hop');
    } finally {
      await adminPool.query(`DROP TRIGGER IF EXISTS test_inject_escalation_failure_trg ON notification_escalations`);
      await adminPool.query(`DROP FUNCTION IF EXISTS test_inject_escalation_failure()`);
    }

    // At-least-once: with the failure gone, the next cycle picks the released claim back up.
    const recovered = await runEscalationCycle();
    assert.ok(recovered.escalated >= 1, 'the escalation must fire on the next cycle after the failure clears');
    const defAfter = await getPool().query(`SELECT resolved FROM notification_escalation_defs WHERE source_event_id = $1`, [sourceEventId]);
    assert.strictEqual(defAfter.rows[0]!['resolved'], true);
    const hop = await getPool().query(`SELECT count(*)::int AS c FROM notification_escalations WHERE source_event_id = $1`, [sourceEventId]);
    assert.strictEqual(hop.rows[0]!['c'], 1, 'exactly one hop must be recorded once the escalation succeeds');
    const hopEvent = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.escalated'
       AND payload->>'source_event_id' = $1`,
      [sourceEventId],
    );
    assert.strictEqual(hopEvent.rows[0]!['c'], 1, 'the hop and its domain event must commit together');
  });

  it('P1b: an escalation deadline anchors to dispatch time, not a stale occurred_at, so a late-dispatched alert keeps its full acknowledgment window', async () => {
    // A 2-hour-stale event with a 1-hour window: under occurred_at anchoring the deadline would
    // be an hour in the past at first delivery - instantly due, an escalation storm after any
    // dispatcher outage. Anchoring at max(occurred_at, dispatch time) preserves the SLA.
    const staleOccurredAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-STALE-01',
      actor: SYSTEM_ACTOR,
      occurred_at: staleOccurredAt,
      escalation: { target_role: 'compliance_admin', acknowledgment_window_seconds: 3600 },
    });
    assert.strictEqual(emitted.ok, true);
    await runDispatchCycle();

    const def = await getPool().query(
      `SELECT deadline_at > now() AS in_future, deadline_at > now() + interval '55 minutes' AS full_window
       FROM notification_escalation_defs WHERE source_event_id = $1`,
      [emitted.ok ? emitted.event.event_id : ''],
    );
    assert.strictEqual(def.rows[0]!['in_future'], true, 'a late-dispatched alert must not be born already past its deadline');
    assert.strictEqual(def.rows[0]!['full_window'], true, 'recipients must get the full acknowledgment window from delivery time');

    // The notification content still preserves the original business timestamp (AC3) - only the
    // escalation clock anchors to delivery.
    const notif = await getPool().query(`SELECT occurred_at FROM notifications WHERE source_event_id = $1`, [
      emitted.ok ? emitted.event.event_id : '',
    ]);
    assert.strictEqual(new Date(notif.rows[0]!['occurred_at'] as Date | string).toISOString(), staleOccurredAt);
  });

  it('P2: a poison event backs off, dead-letters after the attempt cap, and never starves the healthy events behind it', async () => {
    // Poison by construction: payload.target is missing, so fan-out throws inside the dispatch
    // transaction on every attempt.
    const poisonId = randomUUID();
    await getPool().query(
      `INSERT INTO domain_events (event_id, stream_type, stream_id, event_type, event_version, payload, metadata)
       VALUES ($1, 'notification', $2, 'notification.created', 1, $3::jsonb, $4::jsonb)`,
      [
        poisonId,
        randomUUID(),
        JSON.stringify({ event_type: 'fault_reported', status_verb: 'Reported', object_type: 'fault', object_id: 'FLT-POISON-01' }),
        JSON.stringify({ correlation_id: randomUUID(), actor: SYSTEM_ACTOR, occurred_at: new Date().toISOString() }),
      ],
    );
    // A healthy event emitted AFTER the poison one (so it sits behind it in the oldest-first queue).
    const healthy = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_A },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-HEALTHY-01',
      actor: SYSTEM_ACTOR,
    });
    assert.strictEqual(healthy.ok, true);

    await runDispatchCycle();
    const delivered = await getPool().query(`SELECT count(*)::int AS c FROM notifications WHERE object_id = 'FLT-HEALTHY-01'`);
    assert.strictEqual(delivered.rows[0]!['c'], 1, 'a failing event must never block the healthy event behind it');
    const firstAttempt = await getPool().query(
      `SELECT attempts, dead, next_attempt_at > now() AS backed_off FROM notification_dispatch_attempts WHERE source_event_id = $1`,
      [poisonId],
    );
    assert.strictEqual(firstAttempt.rows[0]!['attempts'], 1);
    assert.strictEqual(firstAttempt.rows[0]!['dead'], false);
    assert.strictEqual(firstAttempt.rows[0]!['backed_off'], true, 'a failed event must be rescheduled with backoff, not retried hot');

    // While backed off, the dispatcher must skip it entirely (no attempt increment).
    await runDispatchCycle();
    const whileBackedOff = await getPool().query(`SELECT attempts FROM notification_dispatch_attempts WHERE source_event_id = $1`, [poisonId]);
    assert.strictEqual(whileBackedOff.rows[0]!['attempts'], 1, 'an event still in backoff must not be fetched');

    // Drive it to the attempt cap, forcing each backoff due (same direct-UPDATE pattern the AC2
    // tests use to fast-forward deadlines).
    for (let attempt = 2; attempt <= 5; attempt++) {
      await getPool().query(`UPDATE notification_dispatch_attempts SET next_attempt_at = now() - interval '1 second' WHERE source_event_id = $1`, [
        poisonId,
      ]);
      await runDispatchCycle();
    }
    const capped = await getPool().query(`SELECT attempts, dead FROM notification_dispatch_attempts WHERE source_event_id = $1`, [poisonId]);
    assert.strictEqual(capped.rows[0]!['attempts'], 5);
    assert.strictEqual(capped.rows[0]!['dead'], true, 'after the attempt cap the event must be dead-lettered, not retried forever');

    // Dead-lettering is loud: exactly one operator alert raised to the fallback escalation role.
    const alert = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE stream_type = 'notification' AND event_type = 'notification.created'
       AND payload->>'event_type' = 'dispatch_dead_letter' AND payload->>'object_id' = $1`,
      [poisonId],
    );
    assert.strictEqual(alert.rows[0]!['c'], 1, 'dead-lettering must raise exactly one operator alert');

    // And dead means dead: even when "due", the event is never fetched again.
    await getPool().query(`UPDATE notification_dispatch_attempts SET next_attempt_at = now() - interval '1 second' WHERE source_event_id = $1`, [
      poisonId,
    ]);
    await runDispatchCycle();
    const afterDead = await getPool().query(`SELECT attempts FROM notification_dispatch_attempts WHERE source_event_id = $1`, [poisonId]);
    assert.strictEqual(afterDead.rows[0]!['attempts'], 5, 'a dead event must never be retried again');
  });

  it('P3: expiry row transitions and their notification.expired events commit atomically - a failed event insert rolls the expiry back', async () => {
    const emitted = await emitNotification({
      target: { role: 'maintenance_supervisor', location_id: LOCATION_B },
      event_type: 'fault_reported',
      status_verb: 'Reported',
      object_type: 'fault',
      object_id: 'FLT-EXPATOMIC-01',
      actor: SYSTEM_ACTOR,
    });
    assert.strictEqual(emitted.ok, true);
    const sourceEventId = emitted.ok ? emitted.event.event_id : '';
    await runDispatchCycle();
    await getPool().query(`UPDATE notifications SET created_at = now() - interval '60 days' WHERE source_event_id = $1`, [sourceEventId]);

    // Fault injection: fail exactly the notification.expired event insert - previously the row
    // UPDATE had already committed, so the event was lost forever (idempotency guaranteed it was
    // never re-emitted). Now the whole sweep must roll back instead.
    const adminPool = getAdminPool();
    await adminPool.query(
      `CREATE OR REPLACE FUNCTION test_inject_expiry_failure() RETURNS trigger AS $$
       BEGIN
         IF NEW.event_type = 'notification.expired' THEN RAISE EXCEPTION 'injected expiry failure'; END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
    );
    await adminPool.query(
      `CREATE TRIGGER test_inject_expiry_failure_trg BEFORE INSERT ON domain_events
       FOR EACH ROW EXECUTE FUNCTION test_inject_expiry_failure()`,
    );
    try {
      const failedCycle = await runExpiryCycle();
      assert.strictEqual(failedCycle.expired, 0, 'a sweep whose event insert failed must report nothing expired');

      const row = await getPool().query(`SELECT status FROM notifications WHERE source_event_id = $1`, [sourceEventId]);
      assert.strictEqual(row.rows[0]!['status'], 'created', 'the row transition must roll back with the failed event insert');
      const orphanEvents = await getPool().query(
        `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'notification.expired' AND payload->>'source_event_id' = $1`,
        [sourceEventId],
      );
      assert.strictEqual(orphanEvents.rows[0]!['c'], 0);
    } finally {
      await adminPool.query(`DROP TRIGGER IF EXISTS test_inject_expiry_failure_trg ON domain_events`);
      await adminPool.query(`DROP FUNCTION IF EXISTS test_inject_expiry_failure()`);
    }

    // At-least-once: the next sweep picks the rows back up and commits both sides together.
    const recovered = await runExpiryCycle();
    assert.ok(recovered.expired >= 1, 'the sweep must succeed once the failure clears');
    const rowAfter = await getPool().query(`SELECT status FROM notifications WHERE source_event_id = $1`, [sourceEventId]);
    assert.strictEqual(rowAfter.rows[0]!['status'], 'expired');
    const eventAfter = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'notification.expired' AND payload->>'source_event_id' = $1`,
      [sourceEventId],
    );
    assert.strictEqual(eventAfter.rows[0]!['c'], 1, 'the expiry and its event must commit together, exactly once');
  });

  async function putPreferences(headers: Record<string, string>, eventType: string, optedIn: boolean): Promise<HttpResult> {
    return makeRequest(TEST_PORT, 'PUT', '/api/v1/notifications/preferences', { event_type: eventType, opted_in: optedIn }, headers);
  }
});

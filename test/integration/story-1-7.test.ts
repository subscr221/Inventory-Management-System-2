import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { Router } from '../../src/api/router.js';
import { provisionUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import { postEventHandler } from '../../src/api/v1/events.js';
import {
  updateCalibrationStatusHandler,
  createQcResultHandler,
  createCalibrationEscalationHandler,
} from '../../src/api/v1/instruments.js';
import { createDoaEntryHandler } from '../../src/api/v1/doa.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 3996;
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const ACTOR_LOCATION = '44444444-4444-4444-8444-444444444444';

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
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  const token = (res.body as Record<string, string>)['token'] ?? '';
  return { Authorization: `Bearer ${token}` };
}

function qcBody(instrumentId = 'INS-0042') {
  return { instrument_id: instrumentId, lot_id: 'LOT-1', parameter: 'weight', value: 42 };
}

function directQcEnvelope(userId: string, instrumentId = 'INS-0042') {
  return {
    stream_type: 'qc',
    stream_id: randomUUID(),
    event_type: 'qc.result_recorded',
    payload: qcBody(instrumentId),
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: userId, role: 'qc_inspector', location_id: ACTOR_LOCATION },
      occurred_at: new Date().toISOString(),
    },
  };
}

async function eventCount(eventType: string, instrumentId: string): Promise<number> {
  const result = await getPool().query(
    `SELECT count(*)::int AS count FROM domain_events WHERE event_type = $1 AND payload->>'instrument_id' = $2`,
    [eventType, instrumentId],
  );
  return result.rows[0]!['count'] as number;
}

async function calibrationStatus(instrumentId: string): Promise<string | null> {
  const result = await getPool().query(
    `SELECT calibration_status FROM instrument_calibration_statuses WHERE instrument_id = $1`,
    [instrumentId],
  );
  return result.rows.length > 0 ? (result.rows[0]!['calibration_status'] as string) : null;
}

describe('Story 1.7 Calibration Lockout Integration Tests', () => {
  let server: Server;
  let maintenanceHeaders: Record<string, string>;
  let qcHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let deniedHeaders: Record<string, string>;
  let qcUserId: string;

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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    const router = new Router();
    router.post('/api/v1/scim/v2/Users', provisionUserHandler);
    router.post('/api/v1/auth/dev-token', devTokenHandler);
    router.post('/api/v1/events', postEventHandler);
    router.post('/api/v1/doa/entries', createDoaEntryHandler);
    router.put('/api/v1/instruments/:id/calibration-status', updateCalibrationStatusHandler);
    router.post('/api/v1/qc/results', createQcResultHandler);
    router.post('/api/v1/instruments/:id/calibration-escalations', createCalibrationEscalationHandler);

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

    await provisionUser(TEST_PORT, 'cal-maintenance@example.com', [
      { role: 'maintenance_supervisor', module: 'maintenance', functionScope: 'write', locationId: '*' },
    ]);
    qcUserId = await provisionUser(TEST_PORT, 'cal-qc@example.com', [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: ACTOR_LOCATION },
    ]);
    await provisionUser(TEST_PORT, 'cal-qc-head@example.com', [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: ACTOR_LOCATION },
    ]);
    await provisionUser(TEST_PORT, 'cal-compliance@example.com', [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'cal-scheduler@example.com', [
      { role: 'calibration_scheduler', module: 'maintenance', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'cal-denied@example.com', [
      { role: 'viewer', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);

    maintenanceHeaders = await authFor(TEST_PORT, 'cal-maintenance@example.com');
    qcHeaders = await authFor(TEST_PORT, 'cal-qc@example.com');
    qcHeadHeaders = await authFor(TEST_PORT, 'cal-qc-head@example.com');
    complianceHeaders = await authFor(TEST_PORT, 'cal-compliance@example.com');
    deniedHeaders = await authFor(TEST_PORT, 'cal-denied@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: out-of-calibration instruments reject synthetic QC results without persistence', async () => {
    const setLocked = await makeRequest(
      TEST_PORT,
      'PUT',
      '/api/v1/instruments/INS-0042/calibration-status',
      { calibration_status: 'out_of_calibration', reason: 'expired' },
      maintenanceHeaders,
    );
    assert.strictEqual(setLocked.status, 200, JSON.stringify(setLocked.body));
    const statusEvent = await getPool().query(
      `SELECT payload FROM domain_events WHERE event_type = 'instrument.calibration_status_updated' AND payload->>'instrument_id' = 'INS-0042' ORDER BY created_at ASC LIMIT 1`,
    );
    assert.strictEqual((statusEvent.rows[0]!['payload'] as Record<string, unknown>)['previous_status'], 'unknown');

    const blocked = await makeRequest(TEST_PORT, 'POST', '/api/v1/qc/results', qcBody(), qcHeaders);
    assert.strictEqual(blocked.status, 423, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'CALIBRATION_LOCKOUT');
    assert.strictEqual(await eventCount('qc.result_recorded', 'INS-0042'), 0);
  });

  it('AC2: qc_head cannot override the calibration lockout', async () => {
    const blocked = await makeRequest(TEST_PORT, 'POST', '/api/v1/qc/results', qcBody(), qcHeadHeaders);
    assert.strictEqual(blocked.status, 423, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'CALIBRATION_LOCKOUT');
    assert.strictEqual(await eventCount('qc.result_recorded', 'INS-0042'), 0);
  });

  it('AC3: calibrated instruments allow QC result persistence', async () => {
    const setCalibrated = await makeRequest(
      TEST_PORT,
      'PUT',
      '/api/v1/instruments/INS-0042/calibration-status',
      { calibration_status: 'calibrated', reason: 'verified' },
      maintenanceHeaders,
    );
    assert.strictEqual(setCalibrated.status, 200, JSON.stringify(setCalibrated.body));

    const accepted = await makeRequest(TEST_PORT, 'POST', '/api/v1/qc/results', qcBody(), qcHeaders);
    assert.strictEqual(accepted.status, 201, JSON.stringify(accepted.body));
    assert.strictEqual(accepted.body['event_type'], 'qc.result_recorded');
    assert.strictEqual(await eventCount('qc.result_recorded', 'INS-0042'), 1);
  });

  it('rejects escalation for unknown or calibrated instruments', async () => {
    const unknown = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/instruments/INS-UNKNOWN/calibration-escalations',
      { reason: 'missing status' },
      qcHeaders,
    );
    assert.strictEqual(unknown.status, 404, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'NOT_FOUND');

    const calibrated = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/instruments/INS-0042/calibration-escalations',
      { reason: 'already valid' },
      qcHeaders,
    );
    assert.strictEqual(calibrated.status, 400, JSON.stringify(calibrated.body));
    assert.strictEqual(calibrated.body['error_code'], 'INVALID_PARAMS');
  });

  it('direct POST /api/v1/events is also blocked while instrument is locked', async () => {
    const setLocked = await makeRequest(
      TEST_PORT,
      'PUT',
      '/api/v1/instruments/INS-DIRECT/calibration-status',
      { calibration_status: 'out_of_calibration' },
      maintenanceHeaders,
    );
    assert.strictEqual(setLocked.status, 200, JSON.stringify(setLocked.body));

    const blocked = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', directQcEnvelope(qcUserId, 'INS-DIRECT'), qcHeaders);
    assert.strictEqual(blocked.status, 423, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'CALIBRATION_LOCKOUT');
    assert.strictEqual(await eventCount('qc.result_recorded', 'INS-DIRECT'), 0);
  });

  it('AC4: escalation routes through DOA and does not change calibration status', async () => {
    const doa = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/entries',
      { role: 'calibration_scheduler', transaction_type: 'calibration.escalation', value_min: null, value_max: null },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));

    const escalation = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/instruments/INS-DIRECT/calibration-escalations',
      { reason: 'urgent batch release blocked' },
      qcHeaders,
    );
    assert.strictEqual(escalation.status, 201, JSON.stringify(escalation.body));
    const approver = escalation.body['approver'] as Record<string, unknown>;
    assert.ok(approver['user_id']);
    assert.strictEqual(await eventCount('calibration.escalation_requested', 'INS-DIRECT'), 1);
    assert.strictEqual(await calibrationStatus('INS-DIRECT'), 'out_of_calibration');

    const stillBlocked = await makeRequest(TEST_PORT, 'POST', '/api/v1/qc/results', qcBody('INS-DIRECT'), qcHeaders);
    assert.strictEqual(stillBlocked.status, 423, JSON.stringify(stillBlocked.body));
  });

  it('AC4 regression: escalation still routes when the DOA band has value_min 0 (exclusive-bound boundary)', async () => {
    const setLocked = await makeRequest(
      TEST_PORT,
      'PUT',
      '/api/v1/instruments/INS-BOUND/calibration-status',
      { calibration_status: 'out_of_calibration' },
      maintenanceHeaders,
    );
    assert.strictEqual(setLocked.status, 200, JSON.stringify(setLocked.body));

    const doa = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/entries',
      { role: 'calibration_scheduler', transaction_type: 'calibration.escalation', value_min: 0, value_max: null },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));

    const escalation = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/instruments/INS-BOUND/calibration-escalations',
      { reason: 'boundary band routing' },
      qcHeaders,
    );
    assert.strictEqual(escalation.status, 201, JSON.stringify(escalation.body));
    assert.strictEqual(await eventCount('calibration.escalation_requested', 'INS-BOUND'), 1);
  });

  it('RBAC: wrong modules cannot update status, submit QC results, or request escalations', async () => {
    const status = await makeRequest(
      TEST_PORT,
      'PUT',
      '/api/v1/instruments/INS-RBAC/calibration-status',
      { calibration_status: 'calibrated' },
      deniedHeaders,
    );
    assert.strictEqual(status.status, 403, JSON.stringify(status.body));

    const result = await makeRequest(TEST_PORT, 'POST', '/api/v1/qc/results', qcBody('INS-RBAC'), deniedHeaders);
    assert.strictEqual(result.status, 403, JSON.stringify(result.body));

    const escalation = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/instruments/INS-DIRECT/calibration-escalations',
      { reason: 'not allowed' },
      deniedHeaders,
    );
    assert.strictEqual(escalation.status, 403, JSON.stringify(escalation.body));
  });

  it('regression guard: non-QC streams and QC non-result events persist without calibration lookup', async () => {
    const nonQc = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'maintenance',
        stream_id: randomUUID(),
        event_type: 'maintenance.note_recorded',
        payload: { note: 'calibration module smoke test' },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: qcUserId, role: 'maintenance_supervisor', location_id: ACTOR_LOCATION },
          occurred_at: new Date().toISOString(),
        },
      },
      maintenanceHeaders,
    );
    assert.strictEqual(nonQc.status, 201, JSON.stringify(nonQc.body));

    const nonResult = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'qc',
        stream_id: randomUUID(),
        event_type: 'qc.plan_created',
        payload: { plan_id: 'PLAN-1' },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: qcUserId, role: 'qc_inspector', location_id: ACTOR_LOCATION },
          occurred_at: new Date().toISOString(),
        },
      },
      qcHeaders,
    );
    assert.strictEqual(nonResult.status, 201, JSON.stringify(nonResult.body));
  });
});

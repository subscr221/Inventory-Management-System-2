import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { Router } from '../../src/api/router.js';
import { healthHandler } from '../../src/api/v1/health.js';
import { postEventHandler, getStreamHandler } from '../../src/api/v1/events.js';
import { provisionUserHandler, patchUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import { auditLogHandler } from '../../src/api/v1/audit.js';
import { configAuditLogHandler } from '../../src/api/v1/config.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
          resolvePromise({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : {},
          });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const TEST_PORT = 3999;

async function provisionTestUser(port: number): Promise<{ userId: string; headers: Record<string, string> }> {
  const provisionRes = await makeRequest(port, 'POST', '/api/v1/scim/v2/Users', {
    externalId: 'test-user-1-3@example.com',
    email: 'test-user-1-3@example.com',
    displayName: 'Test User 1.3',
    roles: [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '00000000-0000-0000-0000-000000000001' },
      { role: 'auditor', module: 'audit', functionScope: 'read', locationId: '*' },
      { role: 'system_administrator', module: 'config', functionScope: 'write', locationId: '*' },
    ],
  }, { Authorization: `Bearer test-only-scim-bearer-token-not-for-production-use` });

  const tokenRes = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', {
    sub: 'test-user-1-3@example.com',
  });

  const token = (tokenRes.body as Record<string, string>)['token'] ?? '';
  return {
    userId: (provisionRes.body as Record<string, string>)['user_id'] ?? '',
    headers: { Authorization: `Bearer ${token}` },
  };
}

function makeEventPayload(streamType: string, streamId: string, overrides?: Record<string, unknown>) {
  return {
    stream_type: streamType,
    stream_id: streamId,
    event_type: 'test.event',
    payload: { test: true },
    metadata: {
      correlation_id: '00000000-0000-0000-0000-000000000002',
      actor: {
        user_id: '00000000-0000-0000-0000-000000000003',
        role: 'warehouse_operator',
        location_id: '00000000-0000-0000-0000-000000000001',
      },
      occurred_at: '2026-07-13T10:00:00.000Z',
    },
    ...overrides,
  };
}

describe('Story 1.3 Integration Tests', () => {
  let server: Server;
  let authHeaders: Record<string, string>;

  before(async () => {
    const adminPool = getAdminPool();
    const domainEventsSql = readFileSync(resolve(__dirname, '../../events/domain_events.sql'), 'utf-8');
    const usersSql = readFileSync(resolve(__dirname, '../../read/projections/users.sql'), 'utf-8');
    const auditLogSql = readFileSync(resolve(__dirname, '../../read/projections/audit_log.sql'), 'utf-8');
    await adminPool.query(domainEventsSql);
    await adminPool.query(usersSql);
    await adminPool.query(auditLogSql);
    await adminPool.query('TRUNCATE audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events');

    const router = new Router();
    router.get('/api/v1/health', healthHandler);
    router.post('/api/v1/events', postEventHandler);
    router.get('/api/v1/events/:streamType/:streamId', getStreamHandler);
    router.post('/api/v1/scim/v2/Users', provisionUserHandler);
    router.patch('/api/v1/scim/v2/Users/:externalId', patchUserHandler);
    router.post('/api/v1/auth/dev-token', devTokenHandler);
    router.get('/api/v1/audit/log', auditLogHandler);
    router.put('/api/v1/config/audit-log-enabled', configAuditLogHandler);

    server = createServer((req, res) => {
      router.handle(req, res).catch((err) => {
        console.error('Unhandled server error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error_code: 'INTERNAL_ERROR', message: 'Internal server error', details: {}, trace_id: 'unknown' }));
        }
      });
    });

    await new Promise<void>((resolvePromise) => {
      server.listen(TEST_PORT, () => resolvePromise());
    });

    const { headers } = await provisionTestUser(TEST_PORT);
    authHeaders = headers;
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: event write produces an audit entry with trace_id, user_id, role, location_id, timestamp, endpoint, method, event_id', async () => {
    const streamId = '00000000-0000-0000-0000-000000000004';
    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', makeEventPayload('inventory', streamId), authHeaders);
    assert.strictEqual(res.status, 201);

    const auditRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?start_date=2026-07-13T00:00:00.000Z&end_date=2026-07-13T23:59:59.999Z`,
      undefined,
      authHeaders,
    );
    assert.strictEqual(auditRes.status, 200);

    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, 'Expected at least one audit entry');

    const entry = entries[entries.length - 1]!;
    assert.ok(entry['trace_id'], 'trace_id should be present');
    assert.ok(entry['user_id'], 'user_id should be present');
    assert.ok(entry['role'], 'role should be present');
    assert.strictEqual(entry['role'], 'warehouse_operator');
    assert.ok(entry['location_id'], 'location_id should be present');
    assert.ok(entry['timestamp'], 'timestamp should be present');
    assert.ok(entry['endpoint'], 'endpoint should be present');
    assert.strictEqual(entry['method'], 'POST');
    assert.ok(entry['event_id'], 'event_id should be present');
    assert.strictEqual(entry['http_status'], 201);
  });

  it('AC1: unauthenticated POST is rejected with 401 and no audit entry is created', async () => {
    const streamId = '00000000-0000-0000-0000-000000000005';
    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', makeEventPayload('inventory', streamId));
    assert.strictEqual(res.status, 401);

    const auditRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?start_date=2026-07-13T00:00:00.000Z&end_date=2026-07-13T23:59:59.999Z`,
      undefined,
      authHeaders,
    );
    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    const hasEntryForUnauthenticated = entries.some((e) =>
      e['event_id'] === null && e['http_status'] === 401
    );
    assert.strictEqual(hasEntryForUnauthenticated, false, 'No audit entry should exist for unauthenticated request');
  });

  it('AC2: audit log entries are immutable via application context', async () => {
    const auditRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?start_date=2026-07-13T00:00:00.000Z&end_date=2026-07-13T23:59:59.999Z`,
      undefined,
      authHeaders,
    );
    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, 'Expected at least one audit entry');

    const logId = entries[0]!['log_id'];
    // Attempt to DELETE via the API (no DELETE endpoint exists for audit_log, so this should 404)
    const deleteRes = await makeRequest(TEST_PORT, 'DELETE', `/api/v1/audit/log/${logId}`, undefined, authHeaders);
    assert.strictEqual(deleteRes.status, 404);
  });

  it('AC3: auditor query returns entries in append order with range digest and no gaps', async () => {
    const auditRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?start_date=2026-07-13T00:00:00.000Z&end_date=2026-07-13T23:59:59.999Z`,
      undefined,
      authHeaders,
    );
    assert.strictEqual(auditRes.status, 200);

    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, 'Expected at least one audit entry');

    const rangeDigest = body['range_digest'] as string;
    assert.ok(rangeDigest, 'range_digest should be present');

    const sequenceCheck = body['sequence_check'] as Record<string, unknown>;
    assert.ok(sequenceCheck['is_contiguous'], 'entries should be contiguous');

    const timestamps = entries.map((e) => e['timestamp'] as string);
    for (let i = 1; i < timestamps.length; i++) {
      assert.ok(timestamps[i]! >= timestamps[i - 1]!, 'entries should be in append order');
    }
  });

  it('AC3: auditor query with user_id filter returns only matching entries', async () => {
    const auditRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?start_date=2026-07-13T00:00:00.000Z&end_date=2026-07-13T23:59:59.999Z&user_id=nonexistent-user`,
      undefined,
      authHeaders,
    );
    assert.strictEqual(auditRes.status, 200);

    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.strictEqual(entries.length, 0, 'No entries should match a nonexistent user_id');
  });

  it('AC4: audit log disable endpoint is rejected with AUDIT_LOG_DISABLED', async () => {
    const res = await makeRequest(TEST_PORT, 'PUT', '/api/v1/config/audit-log-enabled', {
      audit_log_enabled: false,
    }, authHeaders);
    assert.strictEqual(res.status, 423);
    const body = res.body as Record<string, unknown>;
    assert.strictEqual(body['error_code'], 'AUDIT_LOG_DISABLED');
  });

  it('AC4: config endpoint returns 200 when audit_log_enabled is true', async () => {
    const res = await makeRequest(TEST_PORT, 'PUT', '/api/v1/config/audit-log-enabled', {
      audit_log_enabled: true,
    }, authHeaders);
    assert.strictEqual(res.status, 200);
  });

  it('AC5: audit log entries are retained (no deletion path exists)', async () => {
    const auditRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?start_date=2026-07-13T00:00:00.000Z&end_date=2026-07-13T23:59:59.999Z`,
      undefined,
      authHeaders,
    );
    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, 'Audit entries should still exist (no deletion occurred)');
  });

  it('audit log entry user_id matches authenticated caller, not forged value', async () => {
    const streamId = '00000000-0000-0000-0000-000000000006';
    const forgedPayload = makeEventPayload('inventory', streamId, {
      metadata: {
        correlation_id: '00000000-0000-0000-0000-000000000002',
        actor: {
          user_id: '99999999-9999-9999-9999-999999999999',
          role: 'forged_role',
          location_id: '00000000-0000-0000-0000-000000000001',
        },
        occurred_at: '2026-07-13T10:00:00.000Z',
      },
    });
    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', forgedPayload, authHeaders);
    assert.strictEqual(res.status, 201);

    const eventResult = res.body as Record<string, unknown>;
    const actor = (eventResult['metadata'] as Record<string, unknown>)['actor'] as Record<string, unknown>;
    assert.notStrictEqual(actor['user_id'], '99999999-9999-9999-9999-999999999999', 'forged user_id should be overwritten');
    assert.notStrictEqual(actor['role'], 'forged_role', 'forged role should be overwritten');
  });

  it('GET /api/v1/audit/log rejects unauthenticated requests', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?start_date=2026-07-13T00:00:00.000Z&end_date=2026-07-13T23:59:59.999Z`,
    );
    assert.strictEqual(res.status, 401);
  });

  it('PUT /api/v1/config/audit-log-enabled rejects unauthenticated requests', async () => {
    const res = await makeRequest(TEST_PORT, 'PUT', '/api/v1/config/audit-log-enabled', {
      audit_log_enabled: true,
    });
    assert.strictEqual(res.status, 401);
  });
});
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
  edgeBootstrapHandler,
  edgeEventUploadHandler,
  powerSyncCredentialsHandler,
} from '../../src/api/v1/edge.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 3995;
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const EDGE_LOCATION = '55555555-5555-4555-8555-555555555555';

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
    { externalId, email: externalId, displayName: 'Raman Gate Officer', roles },
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
  const token = (res.body as Record<string, string>)['token'] ?? '';
  return { Authorization: `Bearer ${token}` };
}

function edgeEnvelope(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    stream_type: 'maintenance',
    stream_id: randomUUID(),
    event_type: 'edge.test_capture_recorded',
    event_version: 1,
    payload: { capture_kind: 'shell_test' },
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: userId, role: 'gate_officer', location_id: EDGE_LOCATION },
      device_id: 'EDGE-TAB-01',
      capture_method: 'MANUAL',
      occurred_at: new Date().toISOString(),
    },
    schema_version: 1,
    idempotency_key: `edge-${randomUUID()}`,
    ...overrides,
  };
}

describe('Story 1.8 backend edge sync contract', () => {
  let server: Server;
  let edgeHeaders: Record<string, string>;
  let edgeUserId: string;

  before(async () => {
    process.env['EDGE_SITE_NAME'] = 'Pilot Gate Site';
    process.env['POWERSYNC_URL'] = 'http://localhost:8080/powersync';
    process.env['POWERSYNC_TOKEN_SECRET'] = 'test-only-powersync-secret-not-for-production-use';
    process.env['POWERSYNC_TOKEN_ISSUER'] = 'inventory-test';
    process.env['POWERSYNC_TOKEN_AUDIENCE'] = 'powersync-test';

    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    const router = new Router();
    router.post('/api/v1/scim/v2/Users', provisionUserHandler);
    router.post('/api/v1/auth/dev-token', devTokenHandler);
    router.get('/api/v1/edge/bootstrap', edgeBootstrapHandler);
    router.get('/api/v1/edge/powersync-credentials', powerSyncCredentialsHandler);
    router.post('/api/v1/edge/events', edgeEventUploadHandler);

    server = createServer((req, res) => {
      router.handle(req, res).catch((err) => {
        console.error('Unhandled server error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error_code: 'INTERNAL_ERROR',
              message: 'Internal server error',
              details: {},
              trace_id: 'unknown',
            }),
          );
        }
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(TEST_PORT, () => resolvePromise()));

    edgeUserId = await provisionUser(TEST_PORT, 'edge-gate@example.com', [
      {
        role: 'gate_officer',
        module: 'maintenance',
        functionScope: 'write',
        locationId: EDGE_LOCATION,
      },
      {
        role: 'gate_officer',
        module: 'maintenance',
        functionScope: 'read',
        locationId: EDGE_LOCATION,
      },
    ]);
    edgeHeaders = await authFor(TEST_PORT, 'edge-gate@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('returns cached user, site, role, and navigation bootstrap context', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'GET',
      '/api/v1/edge/bootstrap',
      undefined,
      edgeHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['user_name'], 'Raman Gate Officer');
    assert.strictEqual(res.body['site_name'], 'Pilot Gate Site');
    assert.deepStrictEqual(res.body['navigation'], ['Dashboard', 'Frontline']);
    assert.strictEqual(res.body['offline_ready'], true);
  });

  it('returns short-lived PowerSync credentials with site claims', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'GET',
      '/api/v1/edge/powersync-credentials',
      undefined,
      edgeHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['endpoint'], 'http://localhost:8080/powersync');
    assert.equal(typeof res.body['token'], 'string');
    assert.ok((res.body['token'] as string).length > 20);
  });

  it('uploads edge events through the central event path and preserves event_id', async () => {
    const envelope = edgeEnvelope(edgeUserId);
    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/edge/events', envelope, edgeHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['event_id'], envelope.event_id);
    assert.ok((res.body['metadata'] as Record<string, unknown>)['synced_at']);

    const audit = await getPool().query(
      `SELECT count(*)::int AS count FROM audit_log WHERE event_id = $1`,
      [envelope.event_id],
    );
    assert.strictEqual(audit.rows[0]!['count'], 1);
  });

  it('rejects edge uploads missing idempotency_key or device_id without breaking internal callers', async () => {
    const missingIdempotency = edgeEnvelope(edgeUserId, { idempotency_key: null });
    const first = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/edge/events',
      missingIdempotency,
      edgeHeaders,
    );
    assert.strictEqual(first.status, 400, JSON.stringify(first.body));
    assert.strictEqual(first.body['error_code'], 'INVALID_EVENT_ENVELOPE');

    const missingDevice = edgeEnvelope(edgeUserId, {
      metadata: { ...edgeEnvelope(edgeUserId).metadata, device_id: null },
    });
    const second = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/edge/events',
      missingDevice,
      edgeHeaders,
    );
    assert.strictEqual(second.status, 400, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'INVALID_EVENT_ENVELOPE');
  });

  it('returns duplicate edge submissions as HTTP 409 with the original event identity', async () => {
    const envelope = edgeEnvelope(edgeUserId);
    const first = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/edge/events',
      envelope,
      edgeHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const duplicate = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/edge/events',
      envelope,
      edgeHeaders,
    );
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'DUPLICATE_EVENT');
    const details = duplicate.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['existing_event_id'], envelope.event_id);

    const count = await getPool().query(
      `SELECT count(*)::int AS count FROM domain_events WHERE idempotency_key = $1`,
      [envelope.idempotency_key],
    );
    assert.strictEqual(count.rows[0]!['count'], 1);
  });
});

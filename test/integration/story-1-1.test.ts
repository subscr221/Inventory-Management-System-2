import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { Router } from '../../src/api/router.js';
import { healthHandler } from '../../src/api/v1/health.js';
import { postEventHandler, getStreamHandler } from '../../src/api/v1/events.js';
import { provisionUserHandler, patchUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import { getPool, closePool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';
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

describe('Story 1.1 Integration Tests', () => {
  let server: Server;
  let authHeaders: Record<string, string>;

  before(async () => {
    const pool = getPool();
    const domainEventsSql = readFileSync(resolve(__dirname, '../../events/domain_events.sql'), 'utf-8');
    const usersSql = readFileSync(resolve(__dirname, '../../read/projections/users.sql'), 'utf-8');
    await pool.query(domainEventsSql);
    await pool.query(usersSql);
    await pool.query('TRUNCATE user_role_assignments, users, domain_events');

    const router = new Router();
    router.get('/api/v1/health', healthHandler);
    router.post('/api/v1/events', postEventHandler);
    router.get('/api/v1/events/:streamType/:streamId', getStreamHandler);
    router.post('/api/v1/scim/v2/Users', provisionUserHandler);
    router.patch('/api/v1/scim/v2/Users/:externalId', patchUserHandler);
    router.post('/api/v1/auth/dev-token', devTokenHandler);

    server = createServer((req, res) => {
      router.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
    });

    await new Promise<void>((resolvePromise) => {
      server.listen(TEST_PORT, () => resolvePromise());
    });

    // Story 1.2 gates every endpoint behind SSO auth + RBAC. These tests exercise the
    // Story 1.1 event write/read path itself, so provision a wildcard-scoped test user
    // (all modules, write, all locations) to keep this suite focused on event-store behavior.
    const scimHeaders = { Authorization: `Bearer ${config.scim.bearerToken}` };
    const provisionRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/scim/v2/Users',
      {
        externalId: 'story-1-1-test-user',
        email: 'story-1-1-test-user@example.test',
        roles: [{ role: 'test_all_access', module: '*', functionScope: 'write', locationId: '*' }],
      },
      scimHeaders,
    );
    assert.equal(provisionRes.status, 201, `test user provisioning failed: ${JSON.stringify(provisionRes.body)}`);

    const tokenRes = await makeRequest(TEST_PORT, 'POST', '/api/v1/auth/dev-token', {
      sub: 'story-1-1-test-user',
    });
    assert.equal(tokenRes.status, 201, `dev-token issuance failed: ${JSON.stringify(tokenRes.body)}`);
    authHeaders = { Authorization: `Bearer ${tokenRes.body['token'] as string}` };
  });

  after(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((err) => (err ? reject(err) : resolvePromise()));
    });
    await closePool();
  });

  it('AC1: health endpoint returns 200 with status ok and version 1', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', '/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'ok');
    assert.equal(res.body['version'], '1');
  });

  it('AC2: valid event persists and reads back with synced_at and monotonic version', async () => {
    const streamId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const correlationId = '11111111-2222-3333-4444-555555555555';
    const userId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    const locationId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

    const event = {
      stream_type: 'inventory',
      stream_id: streamId,
      event_type: 'stock.received',
      payload: { sku: 'RM-0042', quantity: 100 },
      metadata: {
        correlation_id: correlationId,
        actor: { user_id: userId, role: 'store_assistant', location_id: locationId },
        occurred_at: new Date().toISOString(),
      },
    };

    const postRes = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', event, authHeaders);
    assert.equal(postRes.status, 201);
    assert.ok(postRes.body['event_id']);
    assert.equal(postRes.body['event_version'], 1);
    assert.ok((postRes.body['metadata'] as Record<string, unknown>)['synced_at']);

    const event2 = {
      ...event,
      event_type: 'stock.allocated',
      payload: { sku: 'RM-0042', quantity: 10 },
      metadata: {
        ...event.metadata,
        causation_id: postRes.body['event_id'],
      },
    };

    const postRes2 = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', event2, authHeaders);
    assert.equal(postRes2.status, 201);
    assert.equal(postRes2.body['event_version'], 2);

    const getRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/events/inventory/${streamId}`, undefined, authHeaders);
    assert.equal(getRes.status, 200);
    const events = getRes.body['events'] as Array<Record<string, unknown>>;
    assert.equal(events.length, 2);
    assert.equal(events[0]!['event_version'], 1);
    assert.equal(events[1]!['event_version'], 2);
  });

  it('AC3: invalid envelope rejected with INVALID_EVENT_ENVELOPE', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
      },
      authHeaders,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body['error_code'], 'INVALID_EVENT_ENVELOPE');
    assert.ok(res.body['trace_id']);
  });

  it('AC3: missing actor rejected with INVALID_EVENT_ENVELOPE', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        event_type: 'stock.received',
        payload: { sku: 'RM-0042' },
        metadata: {
          correlation_id: '11111111-2222-3333-4444-555555555555',
          occurred_at: new Date().toISOString(),
        },
      },
      authHeaders,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body['error_code'], 'INVALID_EVENT_ENVELOPE');
  });

  it('AC3: missing correlation_id rejected with INVALID_EVENT_ENVELOPE', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        event_type: 'stock.received',
        payload: { sku: 'RM-0042' },
        metadata: {
          actor: {
            user_id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
            role: 'store_assistant',
            location_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
          },
          occurred_at: new Date().toISOString(),
        },
      },
      authHeaders,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body['error_code'], 'INVALID_EVENT_ENVELOPE');
  });

  it('idempotency key deduplication returns 409 with existing event_id', async () => {
    const event = {
      stream_type: 'test',
      stream_id: 'cccccccc-dddd-eeee-ffff-000000000000',
      event_type: 'test.created',
      payload: { data: 'first' },
      metadata: {
        correlation_id: '11111111-2222-3333-4444-555555555555',
        actor: {
          user_id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
          role: 'tester',
          location_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: 'unique-key-001',
    };

    const first = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', event, authHeaders);
    assert.equal(first.status, 201);
    const firstEventId = first.body['event_id'];

    const second = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', event, authHeaders);
    assert.equal(second.status, 409);
    assert.equal(second.body['error_code'], 'DUPLICATE_EVENT');
    assert.equal(
      (second.body['details'] as Record<string, unknown>)['existing_event_id'],
      firstEventId,
    );
  });

  it('per-stream monotonic version enforcement', async () => {
    const streamId = 'dddddddd-eeee-ffff-0000-111111111111';
    const baseEvent = {
      stream_type: 'version_test',
      stream_id: streamId,
      event_type: 'test.event',
      payload: { data: 'test' },
      metadata: {
        correlation_id: '11111111-2222-3333-4444-555555555555',
        actor: {
          user_id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
          role: 'tester',
          location_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        },
        occurred_at: new Date().toISOString(),
      },
    };

    const r1 = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', baseEvent, authHeaders);
    assert.equal(r1.status, 201);
    assert.equal(r1.body['event_version'], 1);

    const r2 = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', baseEvent, authHeaders);
    assert.equal(r2.status, 201);
    assert.equal(r2.body['event_version'], 2);

    const r3 = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', baseEvent, authHeaders);
    assert.equal(r3.status, 201);
    assert.equal(r3.body['event_version'], 3);

    const getRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/events/version_test/${streamId}`,
      undefined,
      authHeaders,
    );
    const events = getRes.body['events'] as Array<Record<string, unknown>>;
    assert.equal(events.length, 3);
    const versions = events.map((e) => e['event_version']);
    assert.deepEqual(versions, [1, 2, 3]);
  });
});

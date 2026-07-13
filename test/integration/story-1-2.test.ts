import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from '../../src/api/router.js';
import { healthHandler } from '../../src/api/v1/health.js';
import { postEventHandler, getStreamHandler } from '../../src/api/v1/events.js';
import { provisionUserHandler, patchUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { config } from '../../src/config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolvePromise, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
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

const TEST_PORT = 3998;
const SCIM_HEADERS = { Authorization: `Bearer ${config.scim.bearerToken}` };

const SITE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_B = 'aaaaaaaa-0000-0000-0000-000000000002';

async function provision(
  externalId: string,
  roles: Array<{ role: string; module: string; functionScope: 'read' | 'write'; locationId: string }>,
): Promise<string> {
  const res = await makeRequest(
    TEST_PORT,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: `${externalId}@example.test`, roles },
    SCIM_HEADERS,
  );
  assert.equal(res.status, 201, `provisioning failed for ${externalId}: ${JSON.stringify(res.body)}`);
  return res.body['userId'] as string;
}

async function devToken(sub: string): Promise<string> {
  const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.equal(res.status, 201, `dev-token issuance failed for ${sub}: ${JSON.stringify(res.body)}`);
  return res.body['token'] as string;
}

function eventBody(streamType: string, locationId: string) {
  return {
    stream_type: streamType,
    stream_id: 'bbbbbbbb-0000-0000-0000-000000000001',
    event_type: 'test.event',
    payload: { data: 'test' },
    metadata: {
      correlation_id: 'cccccccc-0000-0000-0000-000000000001',
      actor: {
        user_id: 'dddddddd-0000-0000-0000-000000000001',
        role: 'tester',
        location_id: locationId,
      },
      occurred_at: new Date().toISOString(),
    },
  };
}

describe('Story 1.2 Integration Tests', () => {
  let server: Server;

  before(async () => {
    // DDL and TRUNCATE require admin_user - app_user has neither CREATE nor TRUNCATE
    // privilege by design (see src/config/db.ts#getAdminPool).
    const adminPool = getAdminPool();
    const domainEventsSql = readFileSync(resolve(__dirname, '../../events/domain_events.sql'), 'utf-8');
    const usersSql = readFileSync(resolve(__dirname, '../../read/projections/users.sql'), 'utf-8');
    await adminPool.query(domainEventsSql);
    await adminPool.query(usersSql);
    await adminPool.query('TRUNCATE user_role_assignments, users, domain_events');

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
  });

  after(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((err) => (err ? reject(err) : resolvePromise()));
    });
    await closePool();
    await closeAdminPool();
  });

  it('AC1: no Authorization header returns 401 UNAUTHORIZED', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', '/api/v1/events/inventory/bbbbbbbb-0000-0000-0000-000000000001');
    assert.equal(res.status, 401);
    assert.equal(res.body['error_code'], 'UNAUTHORIZED');
  });

  it('AC2: write to a different location than the role grants returns 403 LOCATION_ACCESS_DENIED', async () => {
    const externalId = 'user-location-test';
    await provision(externalId, [{ role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: SITE_A }]);
    const token = await devToken(externalId);

    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('inventory', SITE_B), {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('AC3: no role assignment for the module returns 403 MODULE_ACCESS_DENIED', async () => {
    const externalId = 'user-module-test';
    await provision(externalId, [{ role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: '*' }]);
    const token = await devToken(externalId);

    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('maintenance', SITE_A), {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('AC4: read-only role attempting a write returns 403 FUNCTION_ACCESS_DENIED', async () => {
    const externalId = 'user-function-test';
    await provision(externalId, [{ role: 'auditor', module: 'inventory', functionScope: 'read', locationId: '*' }]);
    const token = await devToken(externalId);

    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('inventory', SITE_A), {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('AC5: SCIM-provisioned user can act on first login with no manual admin step', async () => {
    const externalId = 'user-first-login-test';
    await provision(externalId, [{ role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: SITE_A }]);
    const token = await devToken(externalId);

    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('inventory', SITE_A), {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(res.status, 201);
    assert.ok(res.body['event_id']);
  });

  it('AC6: deprovisioning via SCIM invalidates the existing session on the next request', async () => {
    const externalId = 'user-deprovision-test';
    await provision(externalId, [{ role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: SITE_A }]);
    const token = await devToken(externalId);

    const before1 = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('inventory', SITE_A), {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(before1.status, 201, 'expected the token to work before deprovisioning');

    const patchRes = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/scim/v2/Users/${externalId}`,
      { active: false },
      SCIM_HEADERS,
    );
    assert.equal(patchRes.status, 200);

    const after1 = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('inventory', SITE_A), {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(after1.status, 401);
    assert.equal(after1.body['error_code'], 'UNAUTHORIZED');
  });

  it('SCIM endpoints reject requests without a valid bearer token', async () => {
    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/scim/v2/Users', {
      externalId: 'unauthorized-attempt',
      email: 'x@example.test',
      roles: [],
    });
    assert.equal(res.status, 401);
    assert.equal(res.body['error_code'], 'UNAUTHORIZED');
  });

  it('health endpoint remains public and unaffected by auth', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', '/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body['status'], 'ok');
  });

  // --- Code review 2026-07-13 regression coverage ---

  it('Review D1: audit actor identity is bound to the authenticated caller, not the request body', async () => {
    const externalId = 'user-actor-binding';
    const userId = await provision(externalId, [
      { role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: SITE_A },
    ]);
    const token = await devToken(externalId);

    const forged = {
      stream_type: 'inventory',
      stream_id: 'e1e1e1e1-0000-0000-0000-000000000001',
      event_type: 'test.event',
      payload: { data: 'x' },
      metadata: {
        correlation_id: 'cccccccc-0000-0000-0000-000000000002',
        actor: {
          user_id: 'dddddddd-0000-0000-0000-000000000009', // forged - must be ignored
          role: 'super_admin', // forged - must be ignored
          location_id: SITE_A,
        },
        occurred_at: new Date().toISOString(),
      },
    };

    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', forged, {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(res.status, 201);
    const actor = (res.body['metadata'] as Record<string, unknown>)['actor'] as Record<string, unknown>;
    assert.equal(actor['user_id'], userId, 'actor.user_id must be overwritten with the authenticated user');
    assert.equal(actor['role'], 'store_assistant', 'actor.role must be the authorizing role, not the forged value');
  });

  it('Review D3: stream reads are location-scoped to the caller grants', async () => {
    const streamId = 'e2e2e2e2-0000-0000-0000-000000000001';
    const writerExt = 'user-rw-all-loc';
    await provision(writerExt, [{ role: 'admin', module: 'inventory', functionScope: 'write', locationId: '*' }]);
    const writerToken = await devToken(writerExt);

    const eventAt = (loc: string) => ({
      stream_type: 'inventory',
      stream_id: streamId,
      event_type: 'test.event',
      payload: { data: 'x' },
      metadata: {
        correlation_id: 'cccccccc-0000-0000-0000-000000000003',
        actor: { user_id: 'dddddddd-0000-0000-0000-00000000000a', role: 'x', location_id: loc },
        occurred_at: new Date().toISOString(),
      },
    });

    const a = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventAt(SITE_A), {
      Authorization: `Bearer ${writerToken}`,
    });
    assert.equal(a.status, 201);
    const b = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventAt(SITE_B), {
      Authorization: `Bearer ${writerToken}`,
    });
    assert.equal(b.status, 201);

    // A reader scoped to SITE_A only sees the SITE_A event.
    const readerExt = 'user-read-site-a';
    await provision(readerExt, [{ role: 'viewer', module: 'inventory', functionScope: 'read', locationId: SITE_A }]);
    const readerToken = await devToken(readerExt);
    const scoped = await makeRequest(TEST_PORT, 'GET', `/api/v1/events/inventory/${streamId}`, undefined, {
      Authorization: `Bearer ${readerToken}`,
    });
    assert.equal(scoped.status, 200);
    const scopedEvents = scoped.body['events'] as Array<Record<string, unknown>>;
    assert.equal(scopedEvents.length, 1, 'SITE_A reader must see only the SITE_A event');
    const scopedActor = (scopedEvents[0]!['metadata'] as Record<string, unknown>)['actor'] as Record<string, unknown>;
    assert.equal(scopedActor['location_id'], SITE_A);

    // A wildcard-location reader sees both events.
    const all = await makeRequest(TEST_PORT, 'GET', `/api/v1/events/inventory/${streamId}`, undefined, {
      Authorization: `Bearer ${writerToken}`,
    });
    assert.equal((all.body['events'] as Array<unknown>).length, 2);
  });

  it('Review D4: SCIM PATCH reactivates a deprovisioned user', async () => {
    const externalId = 'user-reactivate';
    await provision(externalId, [{ role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: SITE_A }]);

    const deprovision = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/scim/v2/Users/${externalId}`,
      { active: false },
      SCIM_HEADERS,
    );
    assert.equal(deprovision.status, 200);
    const blockedToken = await devToken(externalId);
    const blocked = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('inventory', SITE_A), {
      Authorization: `Bearer ${blockedToken}`,
    });
    assert.equal(blocked.status, 401);

    const reactivate = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/scim/v2/Users/${externalId}`,
      { active: true },
      SCIM_HEADERS,
    );
    assert.equal(reactivate.status, 200);
    assert.equal(reactivate.body['active'], true);

    const token = await devToken(externalId);
    const ok = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', eventBody('inventory', SITE_A), {
      Authorization: `Bearer ${token}`,
    });
    assert.equal(ok.status, 201, 'reactivated user must be able to act again');
  });

  it('Review D4: SCIM PATCH rejects an ambiguous active+roles body and a non-boolean active', async () => {
    const externalId = 'user-ambiguous-patch';
    await provision(externalId, [{ role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: SITE_A }]);

    const both = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/scim/v2/Users/${externalId}`,
      { active: false, roles: [] },
      SCIM_HEADERS,
    );
    assert.equal(both.status, 400);
    assert.equal(both.body['error_code'], 'INVALID_SCIM_REQUEST');

    const nonBoolean = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/scim/v2/Users/${externalId}`,
      { active: 'false' },
      SCIM_HEADERS,
    );
    assert.equal(nonBoolean.status, 400);
    assert.equal(nonBoolean.body['error_code'], 'INVALID_SCIM_REQUEST');
  });

  it('Review P4: repeated deprovision is idempotent', async () => {
    const externalId = 'user-double-deprovision';
    await provision(externalId, [{ role: 'store_assistant', module: 'inventory', functionScope: 'write', locationId: SITE_A }]);

    const first = await makeRequest(TEST_PORT, 'PATCH', `/api/v1/scim/v2/Users/${externalId}`, { active: false }, SCIM_HEADERS);
    assert.equal(first.status, 200);
    const second = await makeRequest(TEST_PORT, 'PATCH', `/api/v1/scim/v2/Users/${externalId}`, { active: false }, SCIM_HEADERS);
    assert.equal(second.status, 200, 'a second deprovision must not error');
  });

  it('Review P1: unauthenticated request is rejected with 401 before the body is parsed', async () => {
    // Send genuinely malformed JSON on a protected route with no auth. Because auth now runs
    // before body parsing, the response must be 401 UNAUTHORIZED, not 400 INVALID_JSON.
    const res = await new Promise<{ status: number; body: Record<string, unknown> }>((resolvePromise, reject) => {
      const req = httpRequest(
        {
          hostname: 'localhost',
          port: TEST_PORT,
          path: '/api/v1/events',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (r: IncomingMessage) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            resolvePromise({ status: r.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} });
          });
        },
      );
      req.on('error', reject);
      req.write('{ this is not valid json');
      req.end();
    });
    assert.equal(res.status, 401);
    assert.equal(res.body['error_code'], 'UNAUTHORIZED');
  });
});

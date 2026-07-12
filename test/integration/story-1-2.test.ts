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
import { getPool, closePool } from '../../src/config/db.js';
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
  });

  after(async () => {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((err) => (err ? reject(err) : resolvePromise()));
    });
    await closePool();
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
});

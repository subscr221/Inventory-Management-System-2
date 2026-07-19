import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { Router } from '../../src/api/router.js';
import { provisionUserHandler, patchUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import { postEventHandler, getStreamHandler } from '../../src/api/v1/events.js';
import { getCurrentLocationHandler, seedExpectedLocationHandler } from '../../src/api/v1/location.js';
import { createTaggingRuleHandler } from '../../src/api/v1/business-stream.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_PORT = 3997;
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const ACTOR_LOCATION = '44444444-4444-4444-8444-444444444444';

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
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

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
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

/** Builds a valid location.asserted inventory envelope; caller overrides payload/idempotency. */
function assertedEnvelope(
  lotId: string,
  userId: string,
  assertedLocation: string,
  extra: { idempotency_key?: string; confidence?: string; deviceId?: string | null; event_version?: number } = {},
) {
  const payload: Record<string, unknown> = { business_stream: 'production', lot_id: lotId, asserted_location: assertedLocation };
  if (extra.confidence !== undefined) payload['confidence'] = extra.confidence;
  if (extra.deviceId !== null) payload['device_id'] = extra.deviceId ?? 'rugged-01';
  return {
    stream_type: 'inventory',
    stream_id: lotId,
    event_type: 'location.asserted',
    payload,
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: userId, role: 'warehouse_operator', location_id: ACTOR_LOCATION },
      occurred_at: new Date().toISOString(),
    },
    ...(extra.event_version ? { event_version: extra.event_version } : {}),
    ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
  };
}

async function countRows(table: string, lotId: string): Promise<number> {
  const result = await getPool().query(`SELECT count(*)::int AS count FROM ${table} WHERE lot_id = $1`, [lotId]);
  return result.rows[0]!['count'] as number;
}

async function disputeEventsFor(lotId: string): Promise<Array<Record<string, unknown>>> {
  const result = await getPool().query(
    `SELECT payload FROM domain_events WHERE stream_id = $1 AND event_type = 'location.disputed'`,
    [lotId],
  );
  return result.rows.map((r) => r['payload'] as Record<string, unknown>);
}

describe('Story 1.6 Event-Sourced Location Integration Tests', () => {
  let server: Server;
  let inventoryHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let deniedHeaders: Record<string, string>;
  let inventoryUserId: string;

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/business_stream_config.sql',
      '../../read/projections/location.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    // The audit tables carry unconditional TRUNCATE protection; use the documented superuser
    // escape hatch (DISABLE TRIGGER ALL) for harness cleanup, exactly as story-1-4/1-5 do. The
    // business_streams seed rows are deliberately NOT truncated (migration seed data).
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    const router = new Router();
    router.post('/api/v1/scim/v2/Users', provisionUserHandler);
    router.patch('/api/v1/scim/v2/Users/:externalId', patchUserHandler);
    router.post('/api/v1/auth/dev-token', devTokenHandler);
    router.post('/api/v1/events', postEventHandler);
    router.get('/api/v1/events/:streamType/:streamId', getStreamHandler);
    router.get('/api/v1/locations/:lotId', getCurrentLocationHandler);
    router.post('/api/v1/locations/:lotId/expected', seedExpectedLocationHandler);
    router.post('/api/v1/business-streams/rules', createTaggingRuleHandler);

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

    inventoryUserId = await provisionUser(TEST_PORT, 'loc-inventory@example.com', [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'loc-compliance@example.com', [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'loc-denied@example.com', [
      { role: 'qc_inspector', module: 'quality', functionScope: 'write', locationId: '*' },
    ]);

    inventoryHeaders = await authFor(TEST_PORT, 'loc-inventory@example.com');
    complianceHeaders = await authFor(TEST_PORT, 'loc-compliance@example.com');
    deniedHeaders = await authFor(TEST_PORT, 'loc-denied@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: an asserted location that differs from the expected fact raises location.disputed, becomes current, and preserves expected', async () => {
    const lotId = randomUUID();

    const seed = await makeRequest(
      TEST_PORT,
      'POST',
      `/api/v1/locations/${lotId}/expected`,
      { expected_location: 'BIN-A47', source: 'seed' },
      inventoryHeaders,
    );
    assert.strictEqual(seed.status, 201, JSON.stringify(seed.body));

    const asserted = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-A43', { confidence: 'certain' }),
      inventoryHeaders,
    );
    assert.strictEqual(asserted.status, 201, JSON.stringify(asserted.body));

    const current = await makeRequest(TEST_PORT, 'GET', `/api/v1/locations/${lotId}`, undefined, inventoryHeaders);
    assert.strictEqual(current.status, 200, JSON.stringify(current.body));
    assert.strictEqual(current.body['location'], 'BIN-A43', 'asserted location becomes current');
    assert.notStrictEqual(current.body['confidence'], 'none');

    const disputes = await disputeEventsFor(lotId);
    assert.strictEqual(disputes.length, 1, 'exactly one location.disputed event');
    assert.strictEqual(disputes[0]!['asserted_location'], 'BIN-A43');
    assert.strictEqual(disputes[0]!['expected_location'], 'BIN-A47');
    assert.ok(disputes[0]!['actor'], 'dispute carries actor provenance');

    // The expected fact is preserved - neither deleted nor overwritten.
    const expectedRow = await getPool().query(
      `SELECT expected_location FROM location_expected_facts WHERE lot_id = $1`,
      [lotId],
    );
    assert.strictEqual(expectedRow.rows.length, 1);
    assert.strictEqual(expectedRow.rows[0]!['expected_location'], 'BIN-A47');
  });

  it('AC2: a duplicate idempotency_key returns 409 DUPLICATE_EVENT and the location updates exactly once', async () => {
    const lotId = randomUUID();
    const idempotencyKey = `task-${randomUUID()}`;

    const first = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-B10', { idempotency_key: idempotencyKey }),
      inventoryHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstEventId = first.body['event_id'] as string;

    const second = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-B10', { idempotency_key: idempotencyKey }),
      inventoryHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_EVENT');
    const details = second.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['existing_event_id'], firstEventId);

    assert.strictEqual(await countRows('location_asserted_facts', lotId), 1, 'asserted fact recorded exactly once');
    assert.strictEqual(await countRows('location_current', lotId), 1, 'current projection updated exactly once');
  });

  it('AC3: querying a lot with no location events returns null location and confidence none', async () => {
    const lotId = randomUUID();
    const res = await makeRequest(TEST_PORT, 'GET', `/api/v1/locations/${lotId}`, undefined, inventoryHeaders);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { location: null, confidence: 'none' });
    assert.strictEqual(await countRows('location_current', lotId), 0, 'no current row invented');
  });

  it('records an asserted location with no prior expected fact as current, raising no dispute', async () => {
    const lotId = randomUUID();
    const asserted = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-C55'),
      inventoryHeaders,
    );
    assert.strictEqual(asserted.status, 201, JSON.stringify(asserted.body));

    const current = await makeRequest(TEST_PORT, 'GET', `/api/v1/locations/${lotId}`, undefined, inventoryHeaders);
    assert.strictEqual(current.body['location'], 'BIN-C55');
    assert.strictEqual((await disputeEventsFor(lotId)).length, 0, 'no dispute without an expected fact');
  });

  it('does not dispute when the asserted location matches the expected fact', async () => {
    const lotId = randomUUID();
    const seed = await makeRequest(
      TEST_PORT,
      'POST',
      `/api/v1/locations/${lotId}/expected`,
      { expected_location: 'BIN-D01', source: 'seed' },
      inventoryHeaders,
    );
    assert.strictEqual(seed.status, 201, JSON.stringify(seed.body));

    const asserted = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-D01'),
      inventoryHeaders,
    );
    assert.strictEqual(asserted.status, 201, JSON.stringify(asserted.body));
    assert.strictEqual((await disputeEventsFor(lotId)).length, 0, 'matching assertion raises no dispute');
  });

  it('keeps the newer current location when an older explicit event_version arrives later', async () => {
    const lotId = randomUUID();
    const newer = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-NEW', { event_version: 2, confidence: 'certain' }),
      inventoryHeaders,
    );
    assert.strictEqual(newer.status, 201, JSON.stringify(newer.body));

    const older = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-OLD', { event_version: 1, confidence: 'low' }),
      inventoryHeaders,
    );
    assert.strictEqual(older.status, 201, JSON.stringify(older.body));

    const current = await makeRequest(TEST_PORT, 'GET', `/api/v1/locations/${lotId}`, undefined, inventoryHeaders);
    assert.strictEqual(current.body['location'], 'BIN-NEW');
    assert.strictEqual(current.body['confidence'], 'certain');
  });

  it('stores payload device_id and defaults omitted confidence to none', async () => {
    const lotId = randomUUID();
    const asserted = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-PAYLOAD-DEVICE', { deviceId: 'payload-scanner-9' }),
      inventoryHeaders,
    );
    assert.strictEqual(asserted.status, 201, JSON.stringify(asserted.body));

    const row = await getPool().query(
      `SELECT device_id, confidence FROM location_asserted_facts WHERE lot_id = $1`,
      [lotId],
    );
    assert.strictEqual(row.rows[0]!['device_id'], 'payload-scanner-9');
    assert.strictEqual(row.rows[0]!['confidence'], 'none');
  });

  it('rejects invalid confidence values with INVALID_PARAMS', async () => {
    const lotId = randomUUID();
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-BAD-CONFIDENCE', { confidence: 'banana' }),
      inventoryHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('emits location.disputed even when a tagging rule would require tags on that generated event', async () => {
    const rule = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      {
        transaction_type: 'location.disputed',
        cost_centre_required: true,
        project_code_required: false,
        effective_from: new Date().toISOString().slice(0, 10),
      },
      complianceHeaders,
    );
    assert.strictEqual(rule.status, 201, JSON.stringify(rule.body));

    const lotId = randomUUID();
    const seed = await makeRequest(
      TEST_PORT,
      'POST',
      `/api/v1/locations/${lotId}/expected`,
      { expected_location: 'BIN-TAG-EXPECTED', source: 'seed' },
      inventoryHeaders,
    );
    assert.strictEqual(seed.status, 201, JSON.stringify(seed.body));

    const asserted = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      assertedEnvelope(lotId, inventoryUserId, 'BIN-TAG-ACTUAL'),
      inventoryHeaders,
    );
    assert.strictEqual(asserted.status, 201, JSON.stringify(asserted.body));
    assert.strictEqual((await disputeEventsFor(lotId)).length, 1);
  });

  it('RBAC boundary: module access is denied for the location endpoints without the inventory role', async () => {
    const lotId = randomUUID();
    const getRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/locations/${lotId}`, undefined, deniedHeaders);
    assert.strictEqual(getRes.status, 403, JSON.stringify(getRes.body));
    assert.strictEqual(getRes.body['error_code'], 'MODULE_ACCESS_DENIED');

    const postRes = await makeRequest(
      TEST_PORT,
      'POST',
      `/api/v1/locations/${lotId}/expected`,
      { expected_location: 'BIN-A47' },
      deniedHeaders,
    );
    assert.strictEqual(postRes.status, 403, JSON.stringify(postRes.body));
    assert.strictEqual(postRes.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('regression guard: a non-location inventory event succeeds without touching the location tables', async () => {
    const lotId = randomUUID();
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: lotId,
        event_type: 'stock.allocated',
        payload: { business_stream: 'production', quantity: 5 },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inventoryUserId, role: 'warehouse_operator', location_id: ACTOR_LOCATION },
          occurred_at: new Date().toISOString(),
        },
      },
      inventoryHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await countRows('location_current', lotId), 0, 'non-location event must not touch location tables');
    assert.strictEqual(await countRows('location_asserted_facts', lotId), 0);
  });

  it('rejects a malformed location.asserted payload (missing asserted_location) with INVALID_PARAMS and appends nothing', async () => {
    const lotId = randomUUID();
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: lotId,
        event_type: 'location.asserted',
        payload: { business_stream: 'production', lot_id: lotId },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inventoryUserId, role: 'warehouse_operator', location_id: ACTOR_LOCATION },
          occurred_at: new Date().toISOString(),
        },
      },
      inventoryHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    const count = await getPool().query(`SELECT count(*)::int AS count FROM domain_events WHERE stream_id = $1`, [lotId]);
    assert.strictEqual(count.rows[0]!['count'], 0, 'malformed event must not append to domain_events');
  });
});

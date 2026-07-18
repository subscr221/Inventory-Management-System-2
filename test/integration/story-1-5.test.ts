import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { Router } from '../../src/api/router.js';
import { provisionUserHandler, patchUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import { postEventHandler, getStreamHandler } from '../../src/api/v1/events.js';
import {
  createTaggingRuleHandler,
  getTaggingRuleHandler,
  listBusinessStreamsHandler,
} from '../../src/api/v1/business-stream.js';
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

/** Builds a valid inventory-movement envelope; payload is caller-controlled per test case. */
function inventoryEnvelope(streamId: string, userId: string, payload: Record<string, unknown>, eventType = 'stock.moved') {
  return {
    stream_type: 'inventory',
    stream_id: streamId,
    event_type: eventType,
    payload,
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: userId, role: 'warehouse_operator', location_id: ACTOR_LOCATION },
      occurred_at: new Date().toISOString(),
    },
  };
}

async function domainEventCount(streamId: string): Promise<number> {
  const result = await getPool().query(`SELECT count(*)::int AS count FROM domain_events WHERE stream_id = $1`, [streamId]);
  return result.rows[0]!['count'] as number;
}

describe('Story 1.5 Business-Stream Tagging Enforcement Integration Tests', () => {
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    // The audit tables carry unconditional TRUNCATE protection; use the documented superuser
    // escape hatch (DISABLE TRIGGER ALL) for harness cleanup, exactly as story-1-4 does. The
    // business_streams seed rows are deliberately NOT truncated (the vocabulary is migration
    // seed data, re-applied idempotently above).
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
    router.post('/api/v1/business-streams/rules', createTaggingRuleHandler);
    router.get('/api/v1/business-streams/rules', getTaggingRuleHandler);
    router.get('/api/v1/business-streams', listBusinessStreamsHandler);

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

    inventoryUserId = await provisionUser(TEST_PORT, 'bst-inventory@example.com', [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'bst-compliance@example.com', [
      { role: 'system_administrator', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'bst-denied@example.com', [
      { role: 'qc_inspector', module: 'quality', functionScope: 'write', locationId: '*' },
    ]);

    inventoryHeaders = await authFor(TEST_PORT, 'bst-inventory@example.com');
    complianceHeaders = await authFor(TEST_PORT, 'bst-compliance@example.com');
    deniedHeaders = await authFor(TEST_PORT, 'bst-denied@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: rejects an inventory movement with no business_stream as UNTAGGED_TRANSACTION and appends nothing', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { quantity: 10 }),
      inventoryHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UNTAGGED_TRANSACTION');
    const details = res.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['missing_tag'], 'business_stream', 'rejection must identify the missing tag');
    assert.strictEqual(await domainEventCount(streamId), 0, 'no event may be appended to domain_events');
  });

  it('AC2: persists a valid business_stream and returns it intact on the Story 1.1 stream read', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { quantity: 10, business_stream: 'production' }),
      inventoryHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const read = await makeRequest(TEST_PORT, 'GET', `/api/v1/events/inventory/${streamId}`, undefined, inventoryHeaders);
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const events = read.body['events'] as Array<Record<string, unknown>>;
    assert.strictEqual(events.length, 1);
    const payload = events[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['business_stream'], 'production', 'the tag must survive the round trip');
  });

  it('AC3: rejects an unrecognized business_stream as INVALID_BUSINESS_STREAM and appends nothing', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { business_stream: 'unknown_stream' }),
      inventoryHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_BUSINESS_STREAM');
    const details = res.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['invalid_value'], 'unknown_stream');
    assert.strictEqual(await domainEventCount(streamId), 0);
  });

  it('AC4 (cost_centre): a dated rule makes cost_centre mandatory for its transaction type', async () => {
    const ruleRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      { transaction_type: 'stock.moved', cost_centre_required: true, effective_from: '2026-01-01' },
      complianceHeaders,
    );
    assert.strictEqual(ruleRes.status, 201, JSON.stringify(ruleRes.body));

    const streamId = randomUUID();
    const missing = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { business_stream: 'production' }),
      inventoryHeaders,
    );
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'UNTAGGED_TRANSACTION');
    const details = missing.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['missing_tag'], 'cost_centre');
    assert.strictEqual(details['transaction_type'], 'stock.moved');
    assert.strictEqual(await domainEventCount(streamId), 0);

    const tagged = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { business_stream: 'production', cost_centre: 'CC-100' }),
      inventoryHeaders,
    );
    assert.strictEqual(tagged.status, 201, JSON.stringify(tagged.body));
  });

  it('AC4 (project_code): a dated rule makes project_code mandatory for its transaction type', async () => {
    const ruleRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      { transaction_type: 'rd.consumed', project_code_required: true, effective_from: '2026-01-01' },
      complianceHeaders,
    );
    assert.strictEqual(ruleRes.status, 201, JSON.stringify(ruleRes.body));

    const streamId = randomUUID();
    const missing = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { business_stream: 'research' }, 'rd.consumed'),
      inventoryHeaders,
    );
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'UNTAGGED_TRANSACTION');
    const details = missing.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['missing_tag'], 'project_code');
    assert.strictEqual(await domainEventCount(streamId), 0);

    const tagged = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { business_stream: 'research', project_code: 'PROJ-42' }, 'rd.consumed'),
      inventoryHeaders,
    );
    assert.strictEqual(tagged.status, 201, JSON.stringify(tagged.body));
  });

  it('AC4 support: rule applicability is dated - an event before effective_from is not gated', async () => {
    const ruleRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      { transaction_type: 'stock.counted', cost_centre_required: true, effective_from: '2099-01-01' },
      complianceHeaders,
    );
    assert.strictEqual(ruleRes.status, 201, JSON.stringify(ruleRes.body));

    // The rule starts in 2099; today's event of that type needs no cost_centre yet.
    const streamId = randomUUID();
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(streamId, inventoryUserId, { business_stream: 'production' }, 'stock.counted'),
      inventoryHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  });

  it('rejects an overlapping tagging rule with TAGGING_RULE_CONFLICT', async () => {
    // stock.moved already has an open-ended rule from 2026-01-01 (created in the cost_centre test).
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      { transaction_type: 'stock.moved', project_code_required: true, effective_from: '2026-06-01' },
      complianceHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'TAGGING_RULE_CONFLICT');
  });

  it('GET /api/v1/business-streams/rules returns the effective rule; GET /api/v1/business-streams lists the vocabulary', async () => {
    const ruleRes = await makeRequest(
      TEST_PORT,
      'GET',
      '/api/v1/business-streams/rules?transaction_type=stock.moved&as_of_date=2026-07-19',
      undefined,
      complianceHeaders,
    );
    assert.strictEqual(ruleRes.status, 200, JSON.stringify(ruleRes.body));
    assert.strictEqual(ruleRes.body['transaction_type'], 'stock.moved');
    assert.strictEqual(ruleRes.body['cost_centre_required'], true);
    assert.strictEqual(ruleRes.body['effective_from'], '2026-01-01', 'DATE must not shift across timezones');

    const noRule = await makeRequest(
      TEST_PORT,
      'GET',
      '/api/v1/business-streams/rules?transaction_type=never.configured',
      undefined,
      complianceHeaders,
    );
    assert.strictEqual(noRule.status, 404);
    assert.strictEqual(noRule.body['error_code'], 'NOT_FOUND');

    const streams = await makeRequest(TEST_PORT, 'GET', '/api/v1/business-streams', undefined, complianceHeaders);
    assert.strictEqual(streams.status, 200, JSON.stringify(streams.body));
    const list = streams.body['streams'] as Array<Record<string, unknown>>;
    const codes = list.map((s) => s['stream_code']).sort();
    assert.deepStrictEqual(codes, ['job_work', 'maker_hub', 'production', 'research']);
  });

  it('RBAC boundary: module access is denied without the right role assignments', async () => {
    const eventRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      inventoryEnvelope(randomUUID(), inventoryUserId, { business_stream: 'production' }),
      deniedHeaders,
    );
    assert.strictEqual(eventRes.status, 403, JSON.stringify(eventRes.body));
    assert.strictEqual(eventRes.body['error_code'], 'MODULE_ACCESS_DENIED');

    const ruleRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      { transaction_type: 'x.y', effective_from: '2026-01-01' },
      deniedHeaders,
    );
    assert.strictEqual(ruleRes.status, 403, JSON.stringify(ruleRes.body));
    assert.strictEqual(ruleRes.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('regression guard: non-inventory streams persist without any business_stream tag', async () => {
    // The stream-type guard in assertInventoryTagging must not fire for non-inventory streams -
    // this is what keeps Stories 1.1-1.4 (DOA, SCIM, audit) byte-for-byte unaffected. The
    // compliance admin holds the 'compliance' module, so use a compliance-typed stream.
    const streamId = randomUUID();
    const complianceUserRes = await makeRequest(TEST_PORT, 'GET', '/api/v1/business-streams', undefined, complianceHeaders);
    assert.strictEqual(complianceUserRes.status, 200);

    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'compliance',
        stream_id: streamId,
        event_type: 'compliance.spine_checked',
        payload: { note: 'no business_stream here' },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: inventoryUserId, role: 'system_administrator', location_id: ACTOR_LOCATION },
          occurred_at: new Date().toISOString(),
        },
      },
      complianceHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await domainEventCount(streamId), 1);
  });

  it('validates admin rule input: bad dates and inverted ranges are INVALID_PARAMS', async () => {
    const badDate = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      { transaction_type: 'a.b', effective_from: 'not-a-date' },
      complianceHeaders,
    );
    assert.strictEqual(badDate.status, 400);
    assert.strictEqual(badDate.body['error_code'], 'INVALID_PARAMS');

    const inverted = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/business-streams/rules',
      { transaction_type: 'a.b', effective_from: '2026-06-01', effective_to: '2026-01-01' },
      complianceHeaders,
    );
    assert.strictEqual(inverted.status, 400);
    assert.strictEqual(inverted.body['error_code'], 'INVALID_PARAMS');
  });
});

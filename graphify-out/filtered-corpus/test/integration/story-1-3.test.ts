import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { Router } from '../../src/api/router.js';
import { healthHandler } from '../../src/api/v1/health.js';
import { postEventHandler, getStreamHandler } from '../../src/api/v1/events.js';
import { provisionUserHandler, patchUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import { auditLogHandler } from '../../src/api/v1/audit.js';
import { configAuditLogHandler } from '../../src/api/v1/config.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Audit timestamps default to now(), so hardcoding a single calendar day would make every query
// return zero rows on any other day. A wide, fixed window captures all entries regardless of the
// date the suite runs.
const WIDE_START = '2000-01-01T00:00:00.000Z';
const WIDE_END = '2100-01-01T00:00:00.000Z';
const auditRange = `start_date=${WIDE_START}&end_date=${WIDE_END}`;

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

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
  // The SCIM provision endpoint returns the id under `userId` (camelCase), not `user_id`.
  return {
    userId: (provisionRes.body as Record<string, string>)['userId'] ?? '',
    headers: { Authorization: `Bearer ${token}` },
  };
}

function makeEventPayload(streamType: string, streamId: string, overrides?: Record<string, unknown>) {
  return {
    stream_type: streamType,
    stream_id: streamId,
    event_type: 'test.event',
    // business_stream required on inventory streams since Story 1.5 (FR-AC-01); harmless on others
    payload: { test: true, business_stream: 'production' },
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
  let callerUserId: string;

  before(async () => {
    const adminPool = getAdminPool();
    const domainEventsSql = readFileSync(resolve(__dirname, '../../events/domain_events.sql'), 'utf-8');
    const usersSql = readFileSync(resolve(__dirname, '../../read/projections/users.sql'), 'utf-8');
    const auditLogSql = readFileSync(resolve(__dirname, '../../read/projections/audit_log.sql'), 'utf-8');
    // Story 1.5: business-stream tagging is enforced on the central write path for inventory
    // events, so the vocabulary table must exist before any inventory event is posted.
    const businessStreamSql = readFileSync(resolve(__dirname, '../../read/projections/business_stream_config.sql'), 'utf-8');
    await adminPool.query(domainEventsSql);
    await adminPool.query(usersSql);
    await adminPool.query(auditLogSql);
    await adminPool.query(businessStreamSql);
    // The audit tables now carry unconditional TRUNCATE protection; harness cleanup uses the
    // explicit superuser-only escape hatch (DISABLE TRIGGER ALL) - the same documented path a
    // disaster-recovery operator would use. The finally guarantees the triggers are re-enabled
    // even if the TRUNCATE throws, so a failed run never leaves the shared DB unprotected.
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      // CASCADE so that tables added by later stories which reference users (e.g. Story 1.4's
      // doa_vacation_delegations) are reset too - a shared-DB harness must not break when a later
      // migration adds a foreign key into users.
      await adminPool.query('TRUNCATE audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE');
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

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

    const { headers, userId } = await provisionTestUser(TEST_PORT);
    authHeaders = headers;
    callerUserId = userId;
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: event write produces an audit entry with trace_id, user_id, role, location_id, timestamp, endpoint, method, event_id, seq_no', async () => {
    const streamId = '00000000-0000-0000-0000-000000000004';
    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', makeEventPayload('inventory', streamId), authHeaders);
    assert.strictEqual(res.status, 201);

    const auditRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}`, undefined, authHeaders);
    assert.strictEqual(auditRes.status, 200);

    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, 'Expected at least one audit entry');

    // The event we just wrote is the most recent audit entry (ordered by seq_no ASC).
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
    assert.strictEqual(typeof entry['seq_no'], 'number', 'seq_no should be present and numeric');
  });

  it('AC1: unauthenticated POST is rejected with 401 and no audit entry is created', async () => {
    const streamId = '00000000-0000-0000-0000-000000000005';
    const res = await makeRequest(TEST_PORT, 'POST', '/api/v1/events', makeEventPayload('inventory', streamId));
    assert.strictEqual(res.status, 401);

    const auditRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}`, undefined, authHeaders);
    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    const hasEntryForUnauthenticated = entries.some((e) => e['event_id'] === null && e['http_status'] === 401);
    assert.strictEqual(hasEntryForUnauthenticated, false, 'No audit entry should exist for unauthenticated request');
  });

  it('AC2 (Task 2.5): a direct DB DELETE via the admin pool is rejected by the tamper trigger', async () => {
    // Ensure at least one row exists so the row-level BEFORE DELETE trigger fires.
    await makeRequest(TEST_PORT, 'POST', '/api/v1/events', makeEventPayload('inventory', '00000000-0000-0000-0000-0000000000a1'), authHeaders);

    const adminPool = getAdminPool();
    await assert.rejects(
      () => adminPool.query('DELETE FROM audit_log'),
      /AUDIT_LOG_TAMPER_ATTEMPT/,
      'A superuser DELETE against audit_log must be rejected by the tamper trigger',
    );
  });

  it('AC2 (Task 2.5): a direct DB UPDATE via the admin pool is rejected by the tamper trigger', async () => {
    await makeRequest(TEST_PORT, 'POST', '/api/v1/events', makeEventPayload('inventory', '00000000-0000-0000-0000-0000000000a2'), authHeaders);

    const adminPool = getAdminPool();
    await assert.rejects(
      () => adminPool.query(`UPDATE audit_log SET role = 'tampered'`),
      /AUDIT_LOG_TAMPER_ATTEMPT/,
      'A superuser UPDATE against audit_log must be rejected by the tamper trigger',
    );
  });

  it('AC2 (P10): the app role cannot TRUNCATE audit_log', async () => {
    // app_user lacks the TRUNCATE grant (primary protection) and the truncate trigger is a second
    // line for the app role. Either way the app cannot wipe the log.
    const appPool = getPool();
    await assert.rejects(
      () => appPool.query('TRUNCATE audit_log'),
      /permission denied|AUDIT_LOG_TAMPER_ATTEMPT/i,
      'app_user must not be able to TRUNCATE audit_log',
    );
  });

  it('AC2: no REST route exists to delete an audit log entry', async () => {
    const auditRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}`, undefined, authHeaders);
    const entries = (auditRes.body as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;
    const logId = entries[0]!['log_id'];
    const deleteRes = await makeRequest(TEST_PORT, 'DELETE', `/api/v1/audit/log/${logId}`, undefined, authHeaders);
    assert.strictEqual(deleteRes.status, 404);
  });

  it('AC3: auditor query returns entries in append order (monotonic seq_no) with a range digest and no gaps', async () => {
    const auditRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}`, undefined, authHeaders);
    assert.strictEqual(auditRes.status, 200);

    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, 'Expected at least one audit entry');

    assert.ok(body['range_digest'], 'range_digest should be present');

    const sequenceCheck = body['sequence_check'] as Record<string, unknown>;
    assert.strictEqual(sequenceCheck['append_order_verified'], true, 'seq_no should be strictly increasing');
    assert.strictEqual(sequenceCheck['gap_check_applicable'], true, 'gap check applies to an un-user-filtered query');
    assert.strictEqual(sequenceCheck['is_contiguous'], true, 'no committed rows should be missing from the range');
    assert.strictEqual(sequenceCheck['gap_count'], 0, 'gap_count should be zero');

    // seq_no is truly monotonic (not a random UUID compare).
    const seqNos = entries.map((e) => e['seq_no'] as number);
    for (let i = 1; i < seqNos.length; i++) {
      assert.ok(seqNos[i]! > seqNos[i - 1]!, 'seq_no must be strictly increasing in append order');
    }
  });

  it('AC3 (P2): cursor pagination returns every entry exactly once with no drops or duplicates', async () => {
    // Write a few more entries so there is something to page across.
    for (let i = 0; i < 4; i++) {
      await makeRequest(TEST_PORT, 'POST', '/api/v1/events', makeEventPayload('inventory', `00000000-0000-0000-0000-0000000000b${i}`), authHeaders);
    }

    // Ground truth: the full ordered list of log_ids.
    const fullRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}&limit=1000`, undefined, authHeaders);
    const fullEntries = (fullRes.body as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;
    const fullIds = fullEntries.map((e) => e['log_id'] as string);
    assert.ok(fullIds.length >= 5, 'Expected several entries to page across');

    // Page through with a tiny page size, following next_cursor.
    const pagedIds: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard++) {
      const url: string = `/api/v1/audit/log?${auditRange}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const pageRes: { status: number; body: Record<string, unknown> } = await makeRequest(TEST_PORT, 'GET', url, undefined, authHeaders);
      const pageBody = pageRes.body;
      const pageEntries = pageBody['entries'] as Array<Record<string, unknown>>;
      for (const e of pageEntries) pagedIds.push(e['log_id'] as string);
      cursor = (pageBody['next_cursor'] as string | null) ?? null;
      if (!cursor) break;
    }

    assert.deepStrictEqual(pagedIds, fullIds, 'paged log_ids must equal the full ordered set (no drops, no dupes)');
    assert.strictEqual(new Set(pagedIds).size, pagedIds.length, 'no duplicate log_ids across pages');
  });

  it('AC3: a valid-but-unmatched user_id filter returns zero entries and marks gap check inapplicable', async () => {
    const auditRes = await makeRequest(
      TEST_PORT,
      'GET',
      `/api/v1/audit/log?${auditRange}&user_id=11111111-1111-1111-1111-111111111111`,
      undefined,
      authHeaders,
    );
    assert.strictEqual(auditRes.status, 200);
    const body = auditRes.body as Record<string, unknown>;
    const entries = body['entries'] as Array<Record<string, unknown>>;
    assert.strictEqual(entries.length, 0, 'No entries should match a nonexistent user_id');
    const sequenceCheck = body['sequence_check'] as Record<string, unknown>;
    assert.strictEqual(sequenceCheck['gap_check_applicable'], false, 'gap check must be inapplicable under a user filter');
    assert.strictEqual(sequenceCheck['is_contiguous'], null, 'is_contiguous must be null under a user filter');
  });

  it('AC3 (P6): a non-UUID user_id is rejected with 400 INVALID_PARAMS', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}&user_id=not-a-uuid`, undefined, authHeaders);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((res.body as Record<string, unknown>)['error_code'], 'INVALID_PARAMS');
  });

  it('AC3 (P6): an invalid start_date is rejected with 400 INVALID_PARAMS', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?start_date=nonsense&end_date=${WIDE_END}`, undefined, authHeaders);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((res.body as Record<string, unknown>)['error_code'], 'INVALID_PARAMS');
  });

  it('AC3 (P6): a non-positive limit is rejected with 400 INVALID_PARAMS', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}&limit=-5`, undefined, authHeaders);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((res.body as Record<string, unknown>)['error_code'], 'INVALID_PARAMS');
  });

  it('AC3 (P6): a non-numeric cursor is rejected with 400 INVALID_PARAMS', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}&cursor=abc`, undefined, authHeaders);
    assert.strictEqual(res.status, 400);
    assert.strictEqual((res.body as Record<string, unknown>)['error_code'], 'INVALID_PARAMS');
  });

  it('AC4: attempting to disable the audit log via the config endpoint is rejected with AUDIT_LOG_DISABLED', async () => {
    const res = await makeRequest(TEST_PORT, 'PUT', '/api/v1/config/audit-log-enabled', { audit_log_enabled: false }, authHeaders);
    assert.strictEqual(res.status, 423);
    assert.strictEqual((res.body as Record<string, unknown>)['error_code'], 'AUDIT_LOG_DISABLED');
  });

  it('AC4 (P5/P9): the disable attempt is recorded in the tamper-attempt log under the authorized role', async () => {
    await makeRequest(TEST_PORT, 'PUT', '/api/v1/config/audit-log-enabled', { audit_log_enabled: false }, authHeaders);

    const adminPool = getAdminPool();
    const rows = await adminPool.query(
      `SELECT role, error_code FROM audit_log_tamper_attempt_log WHERE error_code = 'AUDIT_LOG_TAMPER_ATTEMPT' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.ok(rows.rows.length > 0, 'a tamper-attempt row should have been written');
    // Proves the P9 fix: the authorized role (system_administrator), not roles[0] (warehouse_operator).
    assert.strictEqual(rows.rows[0]!['role'], 'system_administrator');
  });

  it('AC4: enabling the audit log returns 200 and the mutating request is itself edit-logged (P10)', async () => {
    const res = await makeRequest(TEST_PORT, 'PUT', '/api/v1/config/audit-log-enabled', { audit_log_enabled: true }, authHeaders);
    assert.strictEqual(res.status, 200);

    // AC1: ANY mutating API request appears in the edit log - including this no-op PUT.
    const adminPool = getAdminPool();
    const rows = await adminPool.query(
      `SELECT method, http_status, event_id FROM audit_log
        WHERE endpoint = '/api/v1/config/audit-log-enabled' AND method = 'PUT'
        ORDER BY created_at DESC LIMIT 1`,
    );
    assert.ok(rows.rows.length > 0, 'the enable request must produce an audit entry');
    assert.strictEqual(rows.rows[0]!['http_status'], 200);
    assert.strictEqual(rows.rows[0]!['event_id'], null, 'a non-event mutation carries a null event_id');
  });

  it('AC5: audit log entries are retained (no deletion path exists)', async () => {
    const auditRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}`, undefined, authHeaders);
    const entries = (auditRes.body as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0, 'Audit entries should still exist (no deletion occurred)');
  });

  it('Task 6.3 (P1): a SCIM provisioning event writes a system-actor audit entry (role "system", location "*", status 201)', async () => {
    // The test user was provisioned via SCIM in before(); that must have produced an audit entry
    // attributed to the system principal with the spec-mandated actor values.
    const auditRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}&limit=1000`, undefined, authHeaders);
    const entries = (auditRes.body as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;
    const scimEntry = entries.find((e) => e['role'] === 'system' && e['method'] === 'POST');
    assert.ok(scimEntry, 'a SCIM system-actor audit entry should exist for the provisioning');
    assert.strictEqual(scimEntry!['user_id'], SYSTEM_ACTOR_ID, 'SCIM audit actor should be the system principal');
    assert.strictEqual(scimEntry!['location_id'], '*', 'SCIM audit location should be the system-wide marker');
    assert.strictEqual(scimEntry!['http_status'], 201, 'provisioning audit row records the 201 the client received');
    assert.ok(scimEntry!['trace_id'], 'SCIM audit entry should carry a trace_id');
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

    // The AUDIT ROW (not just the event envelope) must be bound to the authenticated caller:
    // exact equality with the SCIM-provisioned userId, never the forged UUID (Tasks 6.4/7.2).
    assert.ok(callerUserId, 'provisioned caller userId must be known to the test');
    const eventId = eventResult['event_id'] as string;
    const auditRes = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}&limit=1000`, undefined, authHeaders);
    const auditEntries = (auditRes.body as Record<string, unknown>)['entries'] as Array<Record<string, unknown>>;
    const auditRow = auditEntries.find((e) => e['event_id'] === eventId);
    assert.ok(auditRow, 'an audit entry must exist for the forged-payload event');
    assert.strictEqual(auditRow!['user_id'], callerUserId, 'audit user_id must equal the authenticated caller');
    assert.strictEqual(auditRow!['role'], 'warehouse_operator', 'audit role must be the RBAC-authorized role, not the forged one');
  });

  it('GET /api/v1/audit/log rejects unauthenticated requests', async () => {
    const res = await makeRequest(TEST_PORT, 'GET', `/api/v1/audit/log?${auditRange}`);
    assert.strictEqual(res.status, 401);
  });

  it('PUT /api/v1/config/audit-log-enabled rejects unauthenticated requests', async () => {
    const res = await makeRequest(TEST_PORT, 'PUT', '/api/v1/config/audit-log-enabled', { audit_log_enabled: true });
    assert.strictEqual(res.status, 401);
  });

  it('AC2 (P4): a direct admin TRUNCATE of audit_log is rejected by the unconditional trigger', async () => {
    const adminPool = getAdminPool();
    await assert.rejects(
      () => adminPool.query('TRUNCATE audit_log'),
      /AUDIT_LOG_TAMPER_ATTEMPT/,
      'TRUNCATE must be rejected for every role - a full wipe is the same violation as a row delete',
    );
  });

  it('AC2 (D1): app_user UPDATE and DELETE against audit_log are rejected (grants + trigger)', async () => {
    // app_user has no UPDATE/DELETE grant (first line of defense); the tamper trigger is the
    // second. Either way the statement must fail. The durable record of direct-DB attempts is the
    // PostgreSQL server error log (Decision 2026-07-18) - see read/projections/audit_log.sql.
    const appPool = getPool();
    await assert.rejects(
      () => appPool.query(`UPDATE audit_log SET role = 'tampered'`),
      /permission denied|AUDIT_LOG_TAMPER_ATTEMPT/i,
      'app_user UPDATE must be rejected',
    );
    await assert.rejects(
      () => appPool.query('DELETE FROM audit_log'),
      /permission denied|AUDIT_LOG_TAMPER_ATTEMPT/i,
      'app_user DELETE must be rejected',
    );
  });

  it('AC2 (P11): archive markers are tamper-protected', async () => {
    const adminPool = getAdminPool();
    // Seed one marker (append is legitimate), then prove it cannot be altered or deleted.
    await adminPool.query(
      `INSERT INTO audit_log_archive (original_log_id, archive_path) VALUES (gen_random_uuid(), 'archive/tamper-probe.json')`,
    );
    await assert.rejects(
      () => adminPool.query(`UPDATE audit_log_archive SET archive_path = 'archive/forged.json'`),
      /AUDIT_LOG_TAMPER_ATTEMPT/,
      'archive markers must not be alterable',
    );
    await assert.rejects(
      () => adminPool.query('DELETE FROM audit_log_archive'),
      /AUDIT_LOG_TAMPER_ATTEMPT/,
      'archive markers must not be deletable',
    );
  });

  it('AC1 (P10): an idempotent SCIM no-op PATCH still produces an edit-log entry', async () => {
    // Dedicated throwaway user - deprovisioning the main test user would kill its session.
    await makeRequest(TEST_PORT, 'POST', '/api/v1/scim/v2/Users', {
      externalId: 'noop-user-1-3@example.com',
      email: 'noop-user-1-3@example.com',
      roles: [],
    }, { Authorization: `Bearer test-only-scim-bearer-token-not-for-production-use` });

    const scimHeaders = { Authorization: `Bearer test-only-scim-bearer-token-not-for-production-use` };
    const first = await makeRequest(TEST_PORT, 'PATCH', '/api/v1/scim/v2/Users/noop-user-1-3@example.com', { active: false }, scimHeaders);
    assert.strictEqual(first.status, 200);
    const second = await makeRequest(TEST_PORT, 'PATCH', '/api/v1/scim/v2/Users/noop-user-1-3@example.com', { active: false }, scimHeaders);
    assert.strictEqual(second.status, 200, 'repeat deprovision stays idempotent');

    const adminPool = getAdminPool();
    const rows = await adminPool.query(
      `SELECT event_id, http_status, role, details FROM audit_log
        WHERE endpoint = '/api/v1/scim/v2/Users/noop-user-1-3@example.com' AND method = 'PATCH'
        ORDER BY created_at ASC`,
    );
    assert.ok(rows.rows.length >= 2, 'both the real deprovision and the no-op repeat must be edit-logged');
    const noOpRow = rows.rows[rows.rows.length - 1]!;
    assert.strictEqual(noOpRow['event_id'], null, 'the no-op carries no event');
    assert.strictEqual(noOpRow['http_status'], 200, 'the no-op records the 200 the client received');
    assert.strictEqual(noOpRow['role'], 'system');
    const realRow = rows.rows[0]!;
    assert.ok(realRow['event_id'], 'the real deprovision links its event');
    assert.strictEqual(realRow['http_status'], 200, 'PATCH flows record 200, not a hardcoded 201 (P5)');
  });

  it('AC5 (P7): archive CLI exports eligible rows, marks them exactly once, and re-runs are no-ops', async () => {
    const adminPool = getAdminPool();
    // Seed two backdated rows (9 years old - past the 8-year retention window) and one recent row.
    // INSERT is legitimate (append-only); the trigger only guards UPDATE/DELETE/TRUNCATE.
    const oldIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await adminPool.query(
        `INSERT INTO audit_log (trace_id, user_id, role, location_id, endpoint, method, http_status, created_at, timestamp)
         VALUES ('archive-test-trace', gen_random_uuid(), 'system', '*', '/archive-test', 'POST', 201,
                 now() - interval '9 years', now() - interval '9 years')
         RETURNING log_id`,
      );
      oldIds.push(r.rows[0]!['log_id'] as string);
    }

    const { runArchiveAuditLog } = await import('../../src/cli/archive-audit-log-core.js');
    const { getPool: getAppPool } = await import('../../src/config/db.js');

    const firstRun = await runArchiveAuditLog(getAppPool());
    assert.strictEqual(firstRun.archivedCount, 2, 'both 9-year-old rows are eligible; the recent rows are not');
    assert.ok(firstRun.archivePath, 'an export file path is reported');
    const { readFileSync: readF, rmSync } = await import('node:fs');
    const exported = JSON.parse(readF(firstRun.archivePath!, 'utf-8')) as Array<Record<string, unknown>>;
    assert.strictEqual(exported.length, 2, 'the export file contains exactly the eligible rows');
    assert.ok(oldIds.every((id) => exported.some((e) => e['log_id'] === id)));

    // Idempotence: a re-run finds nothing (markers exist), and the markers did not duplicate.
    const secondRun = await runArchiveAuditLog(getAppPool());
    assert.strictEqual(secondRun.archivedCount, 0, 're-running archives nothing new');
    const markers = await adminPool.query(
      `SELECT COUNT(*) AS count FROM audit_log_archive WHERE original_log_id = ANY($1::uuid[])`,
      [oldIds],
    );
    assert.strictEqual(Number(markers.rows[0]!['count']), 2, 'exactly one marker per archived row (P6)');

    // Original rows remain in audit_log - archival never deletes inside the retention window.
    const originals = await adminPool.query(
      `SELECT COUNT(*) AS count FROM audit_log WHERE log_id = ANY($1::uuid[])`,
      [oldIds],
    );
    assert.strictEqual(Number(originals.rows[0]!['count']), 2, 'archived rows are still retrievable online (AC5)');

    rmSync(firstRun.archivePath!, { force: true });
  });
});

// These exercise the startup-immutable enforcement (Decision 2) and need no database, so they run
// even where PostgreSQL is unavailable. Each spawns a fresh process that imports only the audit
// config module and reports via exit code.
describe('Story 1.3 audit config startup enforcement', () => {
  function runConfigLoad(auditLogEnabled: string): { status: number | null; stderr: string } {
    const code =
      "try { await import('./src/config/audit.ts'); process.exit(0); } catch (e) { console.error(e && e.message ? e.message : String(e)); process.exit(1); }";
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      {
        cwd: resolve(__dirname, '../..'),
        env: { ...process.env, AUDIT_LOG_ENABLED: auditLogEnabled },
        encoding: 'utf-8',
      },
    );
    return { status: res.status, stderr: res.stderr ?? '' };
  }

  it('Task 7.5: AUDIT_LOG_ENABLED=false refuses to start with AUDIT_LOG_DISABLED_AT_STARTUP', () => {
    const { status, stderr } = runConfigLoad('false');
    assert.strictEqual(status, 1, 'process should exit non-zero when the audit log is disabled');
    assert.match(stderr, /AUDIT_LOG_DISABLED_AT_STARTUP/);
  });

  it('P12: AUDIT_LOG_ENABLED is case-insensitive ("TRUE" is accepted)', () => {
    const { status } = runConfigLoad('TRUE');
    assert.strictEqual(status, 0, 'an uppercase TRUE should be accepted, not crash at startup');
  });

  it('an invalid AUDIT_LOG_ENABLED value refuses to start', () => {
    const { status, stderr } = runConfigLoad('yes-please');
    assert.strictEqual(status, 1, 'process should exit non-zero on an invalid flag value');
    assert.match(stderr, /Invalid AUDIT_LOG_ENABLED/);
  });
});

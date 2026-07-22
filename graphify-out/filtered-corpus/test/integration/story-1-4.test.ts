import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { Router } from '../../src/api/router.js';
import { provisionUserHandler, patchUserHandler } from '../../src/api/v1/scim.js';
import { devTokenHandler } from '../../src/api/v1/auth-dev.js';
import {
  createDoaEntryHandler,
  updateDoaEntryHandler,
  createDelegationHandler,
  resolveDoaHandler,
  workflowConfigHandler,
} from '../../src/api/v1/doa.js';
import { readStream } from '../../src/events/store.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { findActiveDelegation, findMatchingDoaEntry, findRoleHolder } from '../../src/read/projections/doa_registry.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_PORT = 3997;
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

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

/** Provisions a user via SCIM and returns the internal user_id. */
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

/** Obtains a dev-token bearer header for a subject (externalId). */
async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  const token = (res.body as Record<string, string>)['token'] ?? '';
  return { Authorization: `Bearer ${token}` };
}

describe('Story 1.4 Enterprise DOA Registry Integration Tests', () => {
  let server: Server;
  let adminHeaders: Record<string, string>;
  let deniedHeaders: Record<string, string>;
  let adminUserId: string;
  let userAId: string; // holds procurement_head
  let userBId: string; // delegate
  const userAExt = 'doa-user-a@example.com';
  const userBExt = 'doa-user-b@example.com';
  let entryId: string;

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of ['../../events/domain_events.sql', '../../read/projections/users.sql', '../../read/projections/audit_log.sql', '../../read/projections/doa_registry.sql']) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    // The audit tables carry unconditional TRUNCATE protection; use the documented superuser escape
    // hatch (DISABLE TRIGGER ALL) for harness cleanup. DOA tables have no triggers. The finally
    // re-enables even if the TRUNCATE throws, so a failed run never leaves the shared DB unprotected.
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
    router.post('/api/v1/doa/entries', createDoaEntryHandler);
    router.patch('/api/v1/doa/entries/:entryId', updateDoaEntryHandler);
    router.post('/api/v1/doa/delegations', createDelegationHandler);
    router.post('/api/v1/doa/resolve', resolveDoaHandler);
    router.post('/api/v1/doa/workflow-config', workflowConfigHandler);

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

    adminUserId = await provisionUser(TEST_PORT, 'doa-admin@example.com', [
      { role: 'system_administrator', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    userAId = await provisionUser(TEST_PORT, userAExt, [
      { role: 'procurement_head', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);
    userBId = await provisionUser(TEST_PORT, userBExt, [
      { role: 'buyer', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(TEST_PORT, 'doa-denied@example.com', [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);

    adminHeaders = await authFor(TEST_PORT, 'doa-admin@example.com');
    deniedHeaders = await authFor(TEST_PORT, 'doa-denied@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: creates a DOA entry and resolves the approver as the current role holder', async () => {
    const createRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/entries',
      { role: 'procurement_head', transaction_type: 'po_approval', value_min: 500000, value_max: null },
      adminHeaders,
    );
    assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
    entryId = createRes.body['entry_id'] as string;
    assert.ok(entryId, 'entry_id should be returned');
    assert.strictEqual(createRes.body['value_min'], 500000, 'value_min should be a JS number, not a string');

    const resolveRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: 'po_approval', value: 600000 },
      adminHeaders,
    );
    assert.strictEqual(resolveRes.status, 200, JSON.stringify(resolveRes.body));
    const matched = resolveRes.body['matched_entry'] as Record<string, unknown>;
    const approver = resolveRes.body['approver'] as Record<string, unknown>;
    assert.strictEqual(matched['entry_id'], entryId);
    assert.strictEqual(approver['user_id'], userAId, 'approver should be the procurement_head holder (User A)');
    assert.strictEqual(resolveRes.body['delegation_applied'], false);
    assert.strictEqual(resolveRes.body['delegated_from'], null);
  });

  it('AC2: a vacation delegation reroutes resolution to the delegate within its dated window', async () => {
    const delegationRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/delegations',
      { delegator_external_id: userAExt, delegate_external_id: userBExt, start_date: '2026-08-01', end_date: '2026-08-10' },
      adminHeaders,
    );
    assert.strictEqual(delegationRes.status, 201, JSON.stringify(delegationRes.body));
    const delegationId = delegationRes.body['delegation_id'] as string;

    // Within the window: resolves to User B (the delegate).
    const resolveInWindow = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: 'po_approval', value: 600000, as_of_date: '2026-08-05' },
      adminHeaders,
    );
    assert.strictEqual(resolveInWindow.status, 200, JSON.stringify(resolveInWindow.body));
    const approver = resolveInWindow.body['approver'] as Record<string, unknown>;
    assert.strictEqual(approver['user_id'], userBId, 'approver should be the delegate (User B)');
    assert.strictEqual(resolveInWindow.body['delegation_applied'], true);
    assert.strictEqual(resolveInWindow.body['delegated_from'], userAId);

    // The delegation and its active dates are recorded in the event log (AC2 second clause).
    const events = await readStream('doa_vacation_delegation', delegationId);
    assert.strictEqual(events.length, 1, 'delegation should have exactly one event');
    assert.strictEqual(events[0]!.event_type, 'doa_registry.vacation_delegation_created');
    assert.strictEqual((events[0]!.payload as Record<string, unknown>)['start_date'], '2026-08-01');
    assert.strictEqual((events[0]!.payload as Record<string, unknown>)['end_date'], '2026-08-10');

    // Outside the window: resolves back to the holder (User A).
    const resolveOutOfWindow = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: 'po_approval', value: 600000, as_of_date: '2026-07-15' },
      adminHeaders,
    );
    assert.strictEqual((resolveOutOfWindow.body['approver'] as Record<string, unknown>)['user_id'], userAId);
    assert.strictEqual(resolveOutOfWindow.body['delegation_applied'], false);

    // Deprovisioned-delegate edge (Task 1.2): deactivate User B, then resolving in-window must fall
    // back to User A rather than returning a deprovisioned approver.
    const deactivate = await makeRequest(TEST_PORT, 'PATCH', `/api/v1/scim/v2/Users/${encodeURIComponent(userBExt)}`, { active: false }, SCIM_HEADERS);
    assert.strictEqual(deactivate.status, 200, JSON.stringify(deactivate.body));
    const resolveAfterDeactivate = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: 'po_approval', value: 600000, as_of_date: '2026-08-05' },
      adminHeaders,
    );
    assert.strictEqual((resolveAfterDeactivate.body['approver'] as Record<string, unknown>)['user_id'], userAId, 'deprovisioned delegate must not be resolved; falls back to holder');
    assert.strictEqual(resolveAfterDeactivate.body['delegation_applied'], false);
  });

  it('AC3: an updated entry takes effect on the next resolution with no restart, and is edit-logged', async () => {
    // Lower the band so a value that did NOT match before now matches - proving the update is live.
    const patchRes = await makeRequest(
      TEST_PORT,
      'PATCH',
      `/api/v1/doa/entries/${entryId}`,
      { value_min: 100000 },
      adminHeaders,
    );
    assert.strictEqual(patchRes.status, 200, JSON.stringify(patchRes.body));
    assert.strictEqual(patchRes.body['value_min'], 100000);

    const resolveRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: 'po_approval', value: 150000 },
      adminHeaders,
    );
    assert.strictEqual(resolveRes.status, 200, JSON.stringify(resolveRes.body));
    assert.strictEqual((resolveRes.body['approver'] as Record<string, unknown>)['user_id'], userAId);

    // Every DOA registry change is edit-logged with the administrator's identity (AC3 second clause).
    const pool = getPool();
    const auditRows = await pool.query(
      `SELECT user_id, role, method, http_status, event_id FROM audit_log WHERE endpoint = $1 AND method = 'PATCH' ORDER BY seq_no DESC LIMIT 1`,
      [`/api/v1/doa/entries/${entryId}`],
    );
    assert.strictEqual(auditRows.rows.length, 1, 'the PATCH must produce an audit-log row');
    assert.strictEqual(auditRows.rows[0]!['user_id'], adminUserId, 'audit row must attribute the change to the admin, not a body value');
    assert.strictEqual(auditRows.rows[0]!['role'], 'system_administrator');
    assert.ok(auditRows.rows[0]!['event_id'], 'the entry_updated event id should be recorded on the audit row');
  });

  it('AC4: workflow config cannot override a DOA-governed transaction type', async () => {
    const blocked = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/workflow-config',
      { transaction_type: 'po_approval', approver_mapping: { any: 'thing' } },
      adminHeaders,
    );
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.strictEqual(blocked.body['error_code'], 'DOA_OVERRIDE_BLOCKED');

    // The bypass attempt is recorded in the tamper-attempt log.
    const pool = getPool();
    const tamperRows = await pool.query(
      `SELECT error_code, user_id FROM audit_log_tamper_attempt_log WHERE error_code = 'DOA_OVERRIDE_BLOCKED' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.strictEqual(tamperRows.rows.length, 1, 'a DOA_OVERRIDE_BLOCKED tamper row must exist');
    assert.strictEqual(tamperRows.rows[0]!['user_id'], adminUserId);

    // An ungoverned transaction type is accepted (the gate does not over-fire).
    const allowed = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/workflow-config',
      { transaction_type: 'not_governed_type', approver_mapping: { any: 'thing' } },
      adminHeaders,
    );
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    assert.strictEqual(allowed.body['accepted'], true);
  });

  it('RBAC: a caller without the compliance module is denied on every DOA endpoint', async () => {
    const calls: Array<[string, string, unknown]> = [
      ['POST', '/api/v1/doa/entries', { role: 'x', transaction_type: 'y' }],
      ['PATCH', `/api/v1/doa/entries/${entryId}`, { active: false }],
      ['POST', '/api/v1/doa/delegations', { delegator_external_id: userAExt, delegate_external_id: userBExt, start_date: '2026-08-01', end_date: '2026-08-10' }],
      ['POST', '/api/v1/doa/resolve', { transaction_type: 'po_approval', value: 600000 }],
      ['POST', '/api/v1/doa/workflow-config', { transaction_type: 'po_approval' }],
    ];
    for (const [method, path, body] of calls) {
      const res = await makeRequest(TEST_PORT, method, path, body, deniedHeaders);
      assert.strictEqual(res.status, 403, `${method} ${path} should be 403, got ${res.status}`);
      assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED', `${method} ${path}`);
    }
  });

  it('resolve returns NO_DOA_ENTRY_MATCH for an unknown transaction type', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: 'nonexistent_type', value: 100 },
      adminHeaders,
    );
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body['error_code'], 'NO_DOA_ENTRY_MATCH');
  });

  it('resolve returns NO_APPROVER_FOUND when the matched entry\'s role has no active holder', async () => {
    // Create an entry for a role nobody holds.
    const createRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/entries',
      { role: 'nonexistent_role', transaction_type: 'orphan_approval', value_min: null, value_max: null },
      adminHeaders,
    );
    assert.strictEqual(createRes.status, 201);
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: 'orphan_approval', value: 1 },
      adminHeaders,
    );
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body['error_code'], 'NO_APPROVER_FOUND');
  });

  it('rejects an invalid value band (value_max <= value_min) with INVALID_PARAMS', async () => {
    const res = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/entries',
      { role: 'procurement_head', transaction_type: 'bad_band', value_min: 500, value_max: 400 },
      adminHeaders,
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('enforces the value-band invariant at the database boundary', async () => {
    await assert.rejects(
      getPool().query(
        `INSERT INTO doa_registry_entries (role, transaction_type, value_min, value_max)
         VALUES ($1, $2, $3, $4)`,
        ['procurement_head', 'invalid_direct_write', 500, 400],
      ),
      (error: unknown) => (error as { constraint?: string }).constraint === 'chk_doa_registry_entries_value_band',
    );
  });

  it('serializes concurrent PATCH requests before validating their merged value bands', async () => {
    const createRes = await makeRequest(
      TEST_PORT,
      'POST',
      '/api/v1/doa/entries',
      { role: 'procurement_head', transaction_type: 'concurrent_patch', value_min: 100, value_max: null },
      adminHeaders,
    );
    assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));
    const concurrentEntryId = createRes.body['entry_id'] as string;
    const adminPool = getAdminPool();

    // The delay makes both HTTP requests overlap deterministically. With SELECT FOR UPDATE, one
    // request commits and the other re-reads that committed state before returning INVALID_PARAMS.
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION test_delay_doa_update() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_delay_doa_update
        BEFORE UPDATE ON doa_registry_entries
        FOR EACH ROW EXECUTE FUNCTION test_delay_doa_update();
    `);
    try {
      const responses = await Promise.all([
        makeRequest(TEST_PORT, 'PATCH', `/api/v1/doa/entries/${concurrentEntryId}`, { value_max: 150 }, adminHeaders),
        makeRequest(TEST_PORT, 'PATCH', `/api/v1/doa/entries/${concurrentEntryId}`, { value_min: 200 }, adminHeaders),
      ]);
      assert.deepStrictEqual(
        responses.map((response) => response.status).sort((a, b) => a - b),
        [200, 400],
        responses.map((response) => JSON.stringify(response.body)).join('\n'),
      );
      assert.strictEqual(responses.find((response) => response.status === 400)?.body['error_code'], 'INVALID_PARAMS');

      const row = await getPool().query(
        `SELECT value_min, value_max FROM doa_registry_entries WHERE entry_id = $1`,
        [concurrentEntryId],
      );
      const valueMin = row.rows[0]!['value_min'] === null ? null : Number(row.rows[0]!['value_min']);
      const valueMax = row.rows[0]!['value_max'] === null ? null : Number(row.rows[0]!['value_max']);
      assert.ok(valueMin === null || valueMax === null || valueMin < valueMax, 'the committed value band must remain valid');
    } finally {
      await adminPool.query('DROP TRIGGER IF EXISTS test_delay_doa_update ON doa_registry_entries');
      await adminPool.query('DROP FUNCTION IF EXISTS test_delay_doa_update()');
    }
  });

  it('uses UUID tie-breakers when DOA records have identical timestamps', async () => {
    const client = await getAdminPool().connect();
    const timestamp = '2026-01-01T00:00:00.000Z';
    const firstUserId = '10000000-0000-0000-0000-000000000001';
    const secondUserId = '10000000-0000-0000-0000-000000000002';
    const firstAssignmentId = '20000000-0000-0000-0000-000000000001';
    const secondAssignmentId = '20000000-0000-0000-0000-000000000002';
    const firstEntryId = '30000000-0000-0000-0000-000000000001';
    const secondEntryId = '30000000-0000-0000-0000-000000000002';
    const firstDelegationId = '40000000-0000-0000-0000-000000000001';
    const secondDelegationId = '40000000-0000-0000-0000-000000000002';
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (user_id, external_id, email, active, provisioned_at)
         VALUES ($1, 'tie-holder-1', 'tie-holder-1@example.com', true, $3),
                ($2, 'tie-holder-2', 'tie-holder-2@example.com', true, $3)`,
        [firstUserId, secondUserId, timestamp],
      );
      await client.query(
        `INSERT INTO user_role_assignments
           (assignment_id, user_id, role, module, function_scope, location_id, created_at)
         VALUES ($1, $2, 'tie_role', 'procurement', 'write', '*', $5),
                ($3, $4, 'tie_role', 'procurement', 'write', '*', $5)`,
        [firstAssignmentId, firstUserId, secondAssignmentId, secondUserId, timestamp],
      );
      await client.query(
        `INSERT INTO doa_registry_entries
           (entry_id, role, transaction_type, value_min, value_max, created_at, updated_at)
         VALUES ($1, 'tie_role', 'tie_approval', NULL, NULL, $3, $3),
                ($2, 'tie_role', 'tie_approval', NULL, NULL, $3, $3)`,
        [firstEntryId, secondEntryId, timestamp],
      );
      await client.query(
        `INSERT INTO doa_vacation_delegations
           (delegation_id, delegator_user_id, delegate_user_id, start_date, end_date, created_at)
         VALUES ($1, $3, $4, '2026-08-01', '2026-08-10', $6),
                ($2, $3, $5, '2026-08-01', '2026-08-10', $6)`,
        [firstDelegationId, secondDelegationId, userAId, firstUserId, secondUserId, timestamp],
      );

      assert.strictEqual((await findMatchingDoaEntry('tie_approval', 1, client))?.entry_id, firstEntryId);
      assert.strictEqual((await findActiveDelegation(userAId, '2026-08-05', client))?.delegation_id, firstDelegationId);
      assert.strictEqual((await findRoleHolder('tie_role', client))?.user_id, firstUserId);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 1.9: exercises the five Spine Acceptance Contract invariants through the production router
// surface while asserting no module routes are registered. Each spine invariant is already enforced
// inside persistEvent (Stories 1.3-1.7); this suite is the formal acceptance gate proving all five
// hold together.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const ACTOR_LOCATION = '44444444-4444-4444-8444-444444444444';
const WIDE_START = '2000-01-01T00:00:00.000Z';
const WIDE_END = '2100-01-01T00:00:00.000Z';

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
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY', raw };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${JSON.stringify(res.body)}`);
  const token = res.body['token'];
  assert.strictEqual(typeof token, 'string', `dev-token ${sub} response missing token: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${token}` };
}

function inventoryEventEnvelope(streamId: string, eventType: string, payload: Record<string, unknown>) {
  return {
    stream_type: 'inventory',
    stream_id: streamId,
    event_type: eventType,
    payload,
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: randomUUID(), role: 'warehouse_operator', location_id: ACTOR_LOCATION },
      occurred_at: new Date().toISOString(),
    },
  };
}

describe('Story 1.9 Spine Acceptance Contract Tests', () => {
  let server: Server;
  let testPort: number;
  let operatorHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let maintenanceHeaders: Record<string, string>;
  let qcHeaders: Record<string, string>;
  let qcHeadHeaders: Record<string, string>;
  let procurementHeadUserId: string;

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

    const router = createAppRouter();
    const routeSurface = router.listRoutes().map((route) => `${route.method} ${route.path}`).sort();
    const allowedSpineRoutes = [
      'DELETE /api/v1/notifications/push-subscription',
      'DELETE /api/v1/lots/:lot_id/quality-hold',
      'GET /api/v1/audit/log',
      'GET /api/v1/business-streams',
      'GET /api/v1/business-streams/rules',
      'GET /api/v1/edge/bootstrap',
      'GET /api/v1/edge/powersync-credentials',
      'GET /api/v1/events/:streamType/:streamId',
      'GET /api/v1/health',
      'GET /api/v1/items/:sku',
      'GET /api/v1/locations',
      'GET /api/v1/locations/:locationId',
      'GET /api/v1/lots/:lotId/location',
      'GET /api/v1/lots/:lot_id/trace',
      'GET /api/v1/notifications',
      'GET /api/v1/notifications/preferences',
      'GET /api/v1/notifications/unread-count',
      'GET /api/v1/stock/:sku',
      'GET /api/v1/stock/:sku/valuation',
      'GET /api/v1/valuation/standard-cost-variance-report',
      'PATCH /api/v1/doa/entries/:entryId',
      'PATCH /api/v1/items/:sku',
      'PATCH /api/v1/locations/:locationId',
      'PATCH /api/v1/notifications/:id',
      'PATCH /api/v1/scim/v2/Users/:externalId',
      'POST /api/v1/auth/dev-token',
      'POST /api/v1/business-streams/rules',
      'POST /api/v1/doa/delegations',
      'POST /api/v1/doa/entries',
      'POST /api/v1/doa/resolve',
      'POST /api/v1/doa/workflow-config',
      'POST /api/v1/edge/events',
      'POST /api/v1/events',
      'POST /api/v1/instruments/:id/calibration-escalations',
      'POST /api/v1/items',
      'POST /api/v1/locations',
      'POST /api/v1/lots/:lotId/location/expected',
      'POST /api/v1/stock/:sku/select-lot',
      'POST /api/v1/stock/:sku/valuation/nrv-write-down',
      'POST /api/v1/stock/:sku/valuation/nrv-recovery',
      'POST /api/v1/stock/:sku/valuation/standard-cost-variance-review',
      'POST /api/v1/notifications/:id/acknowledge',
      'POST /api/v1/notifications/push-subscription',
      'POST /api/v1/qc/results',
      'POST /api/v1/scim/v2/Users',
      // Story 2.5: Inter-Location Transfer Requests
      'POST /api/v1/transfer-requests',
      'GET /api/v1/transfer-requests/:transfer_request_id',
      'GET /api/v1/transfer-requests',
      'PATCH /api/v1/transfer-requests/:transfer_request_id/approve',
      'PATCH /api/v1/transfer-requests/:transfer_request_id/reject',
      'POST /api/v1/transfer-requests/:transfer_request_id/ship',
      'POST /api/v1/transfer-requests/:transfer_request_id/receive',
      'GET /api/v1/stock/:sku/in-transit',
      // Story 2.6: Cycle Counting and Physical Inventory
      'POST /api/v1/cycle-counts',
      'GET /api/v1/cycle-counts',
      'GET /api/v1/cycle-counts/:cycle_count_id',
      'POST /api/v1/cycle-counts/:cycle_count_id/submit',
      'PATCH /api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/approve',
      'PATCH /api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/reject',
      'POST /api/v1/physical-verifications',
      'POST /api/v1/physical-verifications/:physical_verification_id/sign-off',
      'GET /api/v1/physical-verification/report',
      // Story 2.7: Safety Stock, Reorder Points, and Obsolescence Flagging
      'POST /api/v1/planning/params',
      'GET /api/v1/planning/params/:sku',
      'POST /api/v1/planning/safety-stock/compute',
      'POST /api/v1/planning/replenishment/check',
      'GET /api/v1/planning/replenishment/recommendations',
      'POST /api/v1/planning/obsolescence/scan',
      'GET /api/v1/planning/obsolescence/report',
      // Story 2.8: Consignment and VMI Stock Segregation
      'GET /api/v1/ownership-agreements',
      'PUT /api/v1/ownership-agreements/:sku/:locationId/:stockClass',
      'POST /api/v1/planning/vmi/check',
      // Story 2.9: ERP Inbound Reference Projections (read-only; write verbs reject)
      'GET /api/v1/erp/purchase-orders/:poNumber',
      'GET /api/v1/erp/sales-orders',
      'POST /api/v1/erp/sync',
      'POST /api/v1/erp/purchase-orders',
      'PUT /api/v1/erp/purchase-orders',
      'PATCH /api/v1/erp/purchase-orders',
      'DELETE /api/v1/erp/purchase-orders',
      'POST /api/v1/erp/purchase-orders/:poNumber',
      'PUT /api/v1/erp/purchase-orders/:poNumber',
      'PATCH /api/v1/erp/purchase-orders/:poNumber',
      'DELETE /api/v1/erp/purchase-orders/:poNumber',
      'POST /api/v1/erp/sales-orders',
      'PUT /api/v1/erp/sales-orders',
      'PATCH /api/v1/erp/sales-orders',
      'DELETE /api/v1/erp/sales-orders',
      'PUT /api/v1/config/audit-log-enabled',
      'PUT /api/v1/instruments/:id/calibration-status',
      'PUT /api/v1/lots/:lot_id/quality-hold',
      'PUT /api/v1/notifications/preferences',
    ].sort();
    assert.deepStrictEqual(routeSurface, allowedSpineRoutes, 'production route surface must stay limited to the platform spine');

    server = createAppServer(router);
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        testPort = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    await provisionUser(testPort, 'spine-operator@example.com', [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
      { role: 'auditor', module: 'audit', functionScope: 'read', locationId: '*' },
      { role: 'system_administrator', module: 'config', functionScope: 'write', locationId: '*' },
    ]);
    operatorHeaders = await authFor(testPort, 'spine-operator@example.com');

    await provisionUser(testPort, 'spine-compliance@example.com', [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(testPort, 'spine-compliance@example.com');

    procurementHeadUserId = await provisionUser(testPort, 'spine-procurement-head@example.com', [
      { role: 'procurement_head', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);

    await provisionUser(testPort, 'spine-maintenance@example.com', [
      { role: 'maintenance_supervisor', module: 'maintenance', functionScope: 'write', locationId: '*' },
    ]);
    maintenanceHeaders = await authFor(testPort, 'spine-maintenance@example.com');

    await provisionUser(testPort, 'spine-qc@example.com', [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: ACTOR_LOCATION },
    ]);
    qcHeaders = await authFor(testPort, 'spine-qc@example.com');

    await provisionUser(testPort, 'spine-qc-head@example.com', [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: ACTOR_LOCATION },
    ]);
    qcHeadHeaders = await authFor(testPort, 'spine-qc-head@example.com');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  it('Spine 1 (FR-AC-13): every submitted event appears in the append-only, auditor-readable edit log', async () => {
    const submittedEventIds: string[] = [];
    for (const eventType of ['stock.moved', 'stock.received', 'stock.adjusted']) {
      const res = await makeRequest(
        testPort,
        'POST',
        '/api/v1/events',
        inventoryEventEnvelope(randomUUID(), eventType, { business_stream: 'production', quantity: 1 }),
        operatorHeaders,
      );
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const eventId = res.body['event_id'];
      if (typeof eventId !== 'string') {
        assert.fail(`event response missing event_id: ${JSON.stringify(res.body)}`);
      }
      submittedEventIds.push(eventId);
    }

    const auditRes = await makeRequest(
      testPort,
      'GET',
      `/api/v1/audit/log?start_date=${WIDE_START}&end_date=${WIDE_END}&limit=1000`,
      undefined,
      operatorHeaders,
    );
    assert.strictEqual(auditRes.status, 200, JSON.stringify(auditRes.body));
    const entries = auditRes.body['entries'];
    assert.ok(Array.isArray(entries), `audit log response must include entries array: ${JSON.stringify(auditRes.body)}`);
    for (const eventId of submittedEventIds) {
      const entry = entries.find((e: Record<string, unknown>) => e['event_id'] === eventId);
      assert.ok(entry, `submitted event ${eventId} must appear in the edit log`);
      for (const field of ['trace_id', 'user_id', 'role', 'location_id', 'timestamp', 'endpoint', 'method', 'http_status', 'seq_no']) {
        assert.ok(entry[field] !== undefined && entry[field] !== null, `audit entry must expose ${field} for an auditor-readable format`);
      }
    }

    const adminPool = getAdminPool();
    const tamperClient = await adminPool.connect();
    try {
      await tamperClient.query('BEGIN');
      await assert.rejects(
        () => tamperClient.query('DELETE FROM audit_log'),
        /AUDIT_LOG_TAMPER_ATTEMPT/,
        'the log is append-only: a direct DELETE must be rejected',
      );
    } finally {
      await tamperClient.query('ROLLBACK').catch(() => undefined);
      tamperClient.release();
    }

    const updateClient = await adminPool.connect();
    try {
      await updateClient.query('BEGIN');
      await assert.rejects(
        () => updateClient.query(`UPDATE audit_log SET role = 'tampered'`),
        /AUDIT_LOG_TAMPER_ATTEMPT/,
        'the log is append-only: a direct UPDATE must be rejected',
      );
    } finally {
      await updateClient.query('ROLLBACK').catch(() => undefined);
      updateClient.release();
    }
  });

  it('Spine 1 (FR-AC-13): a disable attempt is blocked', async () => {
    const res = await makeRequest(testPort, 'PUT', '/api/v1/config/audit-log-enabled', { audit_log_enabled: false }, operatorHeaders);
    assert.strictEqual(res.status, 423, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'AUDIT_LOG_DISABLED');
  });

  it('Spine 2 (FR-DOA-01): approval workflows resolve approvers from the registry; no hard-coded role path survives', async () => {
    const transactionType = `spine_test_approval_${randomUUID()}`;
    const createRes = await makeRequest(
      testPort,
      'POST',
      '/api/v1/doa/entries',
      { role: 'procurement_head', transaction_type: transactionType, value_min: null, value_max: null },
      complianceHeaders,
    );
    assert.strictEqual(createRes.status, 201, JSON.stringify(createRes.body));

    const resolveRes = await makeRequest(
      testPort,
      'POST',
      '/api/v1/doa/resolve',
      { transaction_type: transactionType, value: 1 },
      complianceHeaders,
    );
    assert.strictEqual(resolveRes.status, 200, JSON.stringify(resolveRes.body));
    const approver = resolveRes.body['approver'] as Record<string, unknown>;
    assert.strictEqual(approver['user_id'], procurementHeadUserId, 'the approver must be resolved from the registry-held role');

    // The DOA registry cannot be bypassed by a workflow supplying its own approver mapping for a
    // governed transaction type - this is the functional proof that no hard-coded role path survives.
    const overrideAttempt = await makeRequest(
      testPort,
      'POST',
      '/api/v1/doa/workflow-config',
      { transaction_type: transactionType, approver_mapping: { any: 'thing' } },
      complianceHeaders,
    );
    assert.strictEqual(overrideAttempt.status, 409, JSON.stringify(overrideAttempt.body));
    assert.strictEqual(overrideAttempt.body['error_code'], 'DOA_OVERRIDE_BLOCKED');
  });

  it('Spine 3 (INT-LOC-01): asserted and expected are stored separately; a discrepancy raises location.disputed; last-writer-wins does not occur', async () => {
    const lotId = randomUUID();
    const seed = await makeRequest(
      testPort,
      'POST',
      `/api/v1/lots/${lotId}/location/expected`,
      { expected_location: 'BIN-SPINE-EXPECTED', source: 'spine-test' },
      operatorHeaders,
    );
    assert.strictEqual(seed.status, 201, JSON.stringify(seed.body));

    const asserted = await makeRequest(
      testPort,
      'POST',
      '/api/v1/events',
      inventoryEventEnvelope(lotId, 'location.asserted', {
        business_stream: 'production',
        lot_id: lotId,
        asserted_location: 'BIN-SPINE-ACTUAL',
        confidence: 'certain',
      }),
      operatorHeaders,
    );
    assert.strictEqual(asserted.status, 201, JSON.stringify(asserted.body));

    const current = await makeRequest(testPort, 'GET', `/api/v1/lots/${lotId}/location`, undefined, operatorHeaders);
    assert.strictEqual(current.body['location'], 'BIN-SPINE-ACTUAL', 'the asserted fact becomes the current location');

    const disputeRows = await getPool().query(
      `SELECT payload FROM domain_events WHERE stream_id = $1 AND event_type = 'location.disputed'`,
      [lotId],
    );
    assert.strictEqual(disputeRows.rows.length, 1, 'a discrepancy between asserted and expected must raise exactly one location.disputed event');
    const disputePayload = disputeRows.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(disputePayload['asserted_location'], 'BIN-SPINE-ACTUAL');
    assert.strictEqual(disputePayload['expected_location'], 'BIN-SPINE-EXPECTED');

    const expectedRow = await getPool().query(`SELECT expected_location FROM location_expected_facts WHERE lot_id = $1`, [lotId]);
    assert.strictEqual(expectedRow.rows.length, 1);
    assert.strictEqual(
      expectedRow.rows[0]!['expected_location'],
      'BIN-SPINE-EXPECTED',
      'the expected fact must survive the conflicting assertion untouched - last-writer-wins does not occur',
    );
  });

  it('Spine 4 (FR-M-13): a QC result against an out-of-calibration instrument is rejected, and qc_head cannot override', async () => {
    const instrumentId = `SPINE-${randomUUID()}`;
    const lock = await makeRequest(
      testPort,
      'PUT',
      `/api/v1/instruments/${instrumentId}/calibration-status`,
      { calibration_status: 'out_of_calibration', reason: 'spine test' },
      maintenanceHeaders,
    );
    assert.strictEqual(lock.status, 200, JSON.stringify(lock.body));

    const qcBody = { instrument_id: instrumentId, lot_id: 'SPINE-LOT-1', parameter: 'weight', value: 1 };
    const rejected = await makeRequest(testPort, 'POST', '/api/v1/qc/results', qcBody, qcHeaders);
    assert.strictEqual(rejected.status, 423, JSON.stringify(rejected.body));
    assert.strictEqual(rejected.body['error_code'], 'CALIBRATION_LOCKOUT');

    const overrideAttempt = await makeRequest(testPort, 'POST', '/api/v1/qc/results', qcBody, qcHeadHeaders);
    assert.strictEqual(overrideAttempt.status, 423, JSON.stringify(overrideAttempt.body));
    assert.strictEqual(overrideAttempt.body['error_code'], 'CALIBRATION_LOCKOUT', 'qc_head must not be able to override the lockout');

    const count = await getPool().query(
      `SELECT count(*)::int AS count FROM domain_events WHERE event_type = 'qc.result_recorded' AND payload->>'instrument_id' = $1`,
      [instrumentId],
    );
    assert.strictEqual(count.rows[0]!['count'], 0, 'no QC result may persist while the instrument is locked out');
  });

  it('Spine 5 (FR-AC-01): an inventory movement without business_stream is rejected with UNTAGGED_TRANSACTION identifying the missing tag', async () => {
    const streamId = randomUUID();
    const res = await makeRequest(
      testPort,
      'POST',
      '/api/v1/events',
      inventoryEventEnvelope(streamId, 'stock.moved', { quantity: 1 }),
      operatorHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UNTAGGED_TRANSACTION');
    const details = res.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['missing_tag'], 'business_stream', 'the rejection must identify the missing tag');

    const count = await getPool().query(`SELECT count(*)::int AS count FROM domain_events WHERE stream_id = $1`, [streamId]);
    assert.strictEqual(count.rows[0]!['count'], 0, 'an untagged movement must not be persisted');
  });
});

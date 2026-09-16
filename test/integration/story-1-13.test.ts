import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { AppError } from '../../src/middleware/error.js';
import { withRefusedCaptureRecord } from '../../src/api/v1/edge.js';
import { setAuthContext, setParsedBody } from '../../src/middleware/context.js';

// Story 1.13: Refused and Parked Captures Are Never Lost (AD-18, AC 2 and 4). Production router,
// real auth, RBAC and PostgreSQL. The 'sync' stream is barred at both event doors, so the seam's
// forgery and duplicate codes are exercised through direct persistEvent calls.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DOA_TYPE = 'edge.refused_capture_resolution';
const SUPERVISOR_ROLE = `refusal_supervisor_${run}`;

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
          resolvePromise({ status: res.statusCode ?? 0, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Story 1.13 Refused and Parked Captures Are Never Lost', () => {
  let server: Server;
  let port: number;
  let siteId: string;
  let otherSiteId: string;
  let techId: string;
  let supervisorId: string;
  const headers: Record<string, Record<string, string>> = {};

  async function provision(name: string, roles: Role[]): Promise<string> {
    const externalId = `${name}-1-13-${run}@example.com`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/scim/v2/Users',
      { externalId, email: externalId, displayName: externalId, roles },
      SCIM_HEADERS,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const token = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub: externalId });
    headers[name] = { Authorization: `Bearer ${token.body['token'] as string}` };
    return (res.body as Record<string, string>)['userId']!;
  }

  function both(role: string, module: string, locationId: string): Role[] {
    return [
      { role, module, functionScope: 'write', locationId },
      { role, module, functionScope: 'read', locationId },
    ];
  }

  function envelope(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const eventId = randomUUID();
    return {
      event_id: eventId,
      stream_type: 'maintenance',
      stream_id: randomUUID(),
      event_type: 'edge.test_capture_recorded',
      event_version: 1,
      payload: { capture_kind: 'shell_test' },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: userId, role: 'device_role', location_id: siteId },
        device_id: `EDGE-1-13-${run}`,
        capture_method: 'MANUAL',
        occurred_at: new Date().toISOString(),
      },
      schema_version: 1,
      idempotency_key: `edge-1-13-${eventId}`,
      ...overrides,
    };
  }

  function inventoryEnvelope(userId: string): Record<string, unknown> {
    return envelope(userId, {
      stream_type: 'inventory',
      event_type: 'stock.moved',
      event_version: undefined,
      payload: { business_stream: 'production', sku: `NONEXISTENT-${run}`, quantity: 1 },
    });
  }

  async function upload(who: string, body: Record<string, unknown>): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/edge/events', body, headers[who]);
  }

  async function recordsFor(eventId: unknown): Promise<Array<Record<string, unknown>>> {
    const r = await getPool().query(`SELECT * FROM edge_refused_capture WHERE event_id = $1`, [eventId]);
    return r.rows as Array<Record<string, unknown>>;
  }

  async function seedDoa(): Promise<void> {
    await getAdminPool().query(`DELETE FROM doa_registry_entries WHERE transaction_type = $1`, [DOA_TYPE]);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      { role: SUPERVISOR_ROLE, transaction_type: DOA_TYPE, value_min: null, value_max: null },
      headers['compliance'],
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  }

  /** A refusal created through the real upload path (a middleware MODULE_ACCESS_DENIED). */
  async function refusal(): Promise<Record<string, unknown>> {
    const body = inventoryEnvelope(techId);
    const res = await upload('tech', body);
    assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
    return (await recordsFor(body['event_id']))[0]!;
  }

  function recordedEvent(overrides: Record<string, unknown> = {}, actorUserId = techId): Record<string, unknown> {
    const refusalId = randomUUID();
    const now = new Date().toISOString();
    return {
      stream_type: 'sync',
      stream_id: refusalId,
      event_type: 'sync.refused_capture_recorded',
      payload: {
        refusal_id: refusalId,
        event_id: randomUUID(),
        stream_type: 'maintenance',
        stream_id: null,
        event_type: null,
        idempotency_key: null,
        device_id: null,
        captured_by: actorUserId,
        captured_role: null,
        location_id: siteId,
        location_source: 'declared',
        http_status: 403,
        error_code: 'MODULE_ACCESS_DENIED',
        error_details: {},
        envelope: {},
        envelope_truncated: false,
        trace_id: 't',
        occurred_at: null,
        refused_at: now,
        ...overrides,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actorUserId, role: 'unassigned', location_id: siteId },
        occurred_at: now,
      },
      idempotency_key: `forge-${refusalId}`,
    };
  }

  const auditCtx = {
    trace_id: 't',
    user_id: randomUUID(),
    role: 'test',
    location_id: '*',
    endpoint: '/test',
    method: 'POST',
    http_status: 201,
  };

  async function persistError(event: Record<string, unknown>): Promise<AppError> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await persistEvent(event as any, { ...auditCtx, user_id: techId });
    } catch (err) {
      assert.ok(err instanceof AppError, String(err));
      return err;
    }
    assert.fail('expected persistEvent to refuse');
  }

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
      '../../read/projections/notification.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/serial_master.sql',
      '../../read/projections/lot_trace.sql',
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/asset.sql',
      '../../read/projections/maintenance_work_order.sql',
      '../../read/projections/maintenance_sync_conflict.sql',
      '../../read/projections/edge_refused_capture.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('TRUNCATE edge_refused_capture, maintenance_sync_conflict');

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    siteId = randomUUID();
    otherSiteId = randomUUID();
    techId = await provision('tech', both('maintenance_technician', 'maintenance', siteId));
    supervisorId = await provision('supervisor', [
      ...both(SUPERVISOR_ROLE, 'maintenance', '*'),
      ...both(SUPERVISOR_ROLE, 'inventory', '*'),
    ]);
    await provision('writer', both(`refusal_writer_${run}`, 'maintenance', siteId));
    await provision('reader', [
      { role: `refusal_reader_${run}`, module: 'maintenance', functionScope: 'read', locationId: siteId },
    ]);
    await provision('elsewhere', both(`refusal_elsewhere_${run}`, 'maintenance', otherSiteId));
    // Sees rows at siteId (read) but may only write at otherSiteId: the LOCATION_ACCESS_DENIED case.
    await provision('offsitewriter', [
      { role: `refusal_offsite_${run}`, module: 'maintenance', functionScope: 'read', locationId: siteId },
      { role: `refusal_offsite_${run}`, module: 'maintenance', functionScope: 'write', locationId: otherSiteId },
    ]);
    await provision('controller', both(`inventory_controller`, 'inventory', siteId));
    await provision('admin', both('admin', '*', siteId));
    await provision('compliance', [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    await seedDoa();
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 2: the central record ------------------------------------------------

  it('AC2: a middleware MODULE_ACCESS_DENIED records one open refusal and the response is unchanged', async () => {
    const body = inventoryEnvelope(techId);
    const res = await upload('tech', body);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
    assert.deepStrictEqual(res.body['details'], {});
    assert.equal('refusal_id' in res.body, false);

    const again = await upload('tech', body);
    assert.deepStrictEqual({ ...again.body, trace_id: null }, { ...res.body, trace_id: null });

    const rows = await recordsFor(body['event_id']);
    assert.strictEqual(rows.length, 1, 'a replayed upload records nothing new');
    const row = rows[0]!;
    assert.strictEqual(row['status'], 'open');
    assert.strictEqual(row['stream_type'], 'inventory');
    assert.strictEqual(row['http_status'], 403);
    assert.strictEqual(row['error_code'], 'MODULE_ACCESS_DENIED');
    assert.strictEqual(row['captured_by'], techId);
    assert.strictEqual(row['captured_role'], null);
    assert.strictEqual(row['location_id'], siteId);
    assert.strictEqual(row['location_source'], 'declared');
    assert.strictEqual(row['device_id'], `EDGE-1-13-${run}`);
    assert.deepStrictEqual(row['envelope'], JSON.parse(JSON.stringify(body)), 'the envelope is the snapshot the device sent');
    assert.strictEqual(row['trace_id'], res.body['trace_id']);
  });

  it('AC2: a handler LOCATION_ACCESS_DENIED records the authorized site and role', async () => {
    const body = envelope(techId, { payload: { capture_kind: 'shell_test', site_id: otherSiteId } });
    const res = await upload('tech', body);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const [row] = await recordsFor(body['event_id']);
    assert.strictEqual(row?.['location_source'], 'authorized');
    assert.strictEqual(row?.['captured_role'], 'maintenance_technician');
    assert.strictEqual(row?.['location_id'], siteId);
  });

  it('AC2: an applier refusal from another module records the returned code', async () => {
    const body = inventoryEnvelope(techId);
    const res = await upload('controller', body);
    assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(res.body));
    const [row] = await recordsFor(body['event_id']);
    assert.strictEqual(row?.['error_code'], res.body['error_code']);
    assert.strictEqual(row?.['http_status'], res.status);
    assert.strictEqual(row?.['stream_type'], 'inventory');
  });

  it('AC2: a maintenance STREAM_CONFLICT keeps its conflict_id and also records a refusal', async () => {
    const body = envelope(techId, { event_version: 5 });
    const res = await upload('tech', body);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'STREAM_CONFLICT');
    const conflictId = (res.body['details'] as Record<string, unknown>)['conflict_id'];
    assert.ok(typeof conflictId === 'string');
    const [row] = await recordsFor(body['event_id']);
    assert.strictEqual(row?.['error_code'], 'STREAM_CONFLICT');
    assert.strictEqual((row?.['error_details'] as Record<string, unknown>)['conflict_id'], conflictId);
  });

  it('AC2: accepted, duplicate, unauthenticated and malformed uploads record nothing', async () => {
    const accepted = envelope(techId);
    assert.strictEqual((await upload('tech', accepted)).status, 201);
    const duplicate = await upload('tech', accepted);
    assert.strictEqual(duplicate.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((await recordsFor(accepted['event_id'])).length, 0);

    const anonymous = inventoryEnvelope(techId);
    const unauth = await makeRequest(port, 'POST', '/api/v1/edge/events', anonymous);
    assert.strictEqual(unauth.status, 401);
    assert.strictEqual((await recordsFor(anonymous['event_id'])).length, 0);

    const malformed = inventoryEnvelope(techId);
    malformed['event_id'] = 'not-a-uuid';
    assert.strictEqual((await upload('tech', malformed)).status, 403);
    const count = await getPool().query(`SELECT count(*)::int AS n FROM edge_refused_capture WHERE envelope->>'event_id' = 'not-a-uuid'`);
    assert.strictEqual(count.rows[0]!['n'], 0);
  });

  it('AC2: a bare 403, a 5xx and a non-AppError are rethrown unchanged and record nothing', async () => {
    for (const thrown of [
      new AppError(403, 'FORBIDDEN', 'bare forbidden'),
      new AppError(503, 'INTERNAL_ERROR', 'down'),
      new Error('boom'),
    ]) {
      const body = inventoryEnvelope(techId);
      const req = { url: '/api/v1/edge/events', method: 'POST' } as IncomingMessage;
      setParsedBody(req, body);
      setAuthContext(req, { userId: techId, roles: [] } as unknown as Parameters<typeof setAuthContext>[1]);
      const wrapped = withRefusedCaptureRecord(async () => {
        throw thrown;
      });
      await assert.rejects(() => wrapped(req, {} as never, {}), (err) => err === thrown);
      assert.strictEqual((await recordsFor(body['event_id'])).length, 0, String(thrown));
    }
  });

  it('AC2: both event doors refuse the sync stream', async () => {
    const event = recordedEvent();
    const eventsDoor = await makeRequest(port, 'POST', '/api/v1/events', { ...event, event_id: randomUUID() }, headers['admin']);
    assert.strictEqual(eventsDoor.status, 400, JSON.stringify(eventsDoor.body));
    assert.strictEqual(eventsDoor.body['error_code'], 'INVALID_EVENT_STREAM');

    const edgeDoor = await upload('admin', envelope(techId, { stream_type: 'sync', event_type: 'sync.refused_capture_recorded' }));
    assert.strictEqual(edgeDoor.status, 403, JSON.stringify(edgeDoor.body));
    assert.strictEqual(edgeDoor.body['error_code'], 'CENTRAL_ONLY_OPERATION');
  });

  it('AC2: a second record for the same capture is DUPLICATE_REFUSED_CAPTURE, sequentially and in a race', async () => {
    const first = recordedEvent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await persistEvent(first as any, { ...auditCtx, user_id: techId });
    const eventId = (first['payload'] as Record<string, unknown>)['event_id'];
    const existingRefusalId = (first['payload'] as Record<string, unknown>)['refusal_id'];
    const sequential = await persistError(recordedEvent({ event_id: eventId }));
    assert.strictEqual(sequential.statusCode, 409);
    assert.strictEqual(sequential.errorCode, 'DUPLICATE_REFUSED_CAPTURE');
    assert.deepStrictEqual(sequential.details, { event_id: eventId, existing_refusal_id: existingRefusalId });

    const raceEventId = randomUUID();
    const results = await Promise.allSettled(
      [recordedEvent({ event_id: raceEventId }), recordedEvent({ event_id: raceEventId })].map((event) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persistEvent(event as any, { ...auditCtx, user_id: techId }),
      ),
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.strictEqual(rejected.length, 1);
    const [winner] = await recordsFor(raceEventId);
    const err = rejected[0]!.reason as AppError;
    assert.strictEqual(err.errorCode, 'DUPLICATE_REFUSED_CAPTURE');
    assert.deepStrictEqual(err.details, { event_id: raceEventId, existing_refusal_id: winner?.['refusal_id'] });
  });

  it('AC2: forged derivation and an oversized envelope are refused by the seam', async () => {
    const forged = await persistError(recordedEvent({ captured_by: supervisorId }));
    assert.strictEqual(forged.statusCode, 409);
    assert.strictEqual(forged.errorCode, 'REFUSED_CAPTURE_DERIVATION_MISMATCH');
    assert.deepStrictEqual(forged.details, { field: 'captured_by', expected: techId, actual: supervisorId });

    const oversized = await persistError(recordedEvent({ envelope: { blob: 'x'.repeat(70 * 1024) } }));
    assert.strictEqual(oversized.errorCode, 'INVALID_PAYLOAD');
  });

  // --- AC 4: the refused-captures API -----------------------------------------------

  it('AC4: 401 on every route without a bearer, and 403 MODULE_ACCESS_DENIED for a caller with no module', async () => {
    const id = randomUUID();
    for (const [method, path] of [
      ['GET', '/api/v1/edge/refused-captures'],
      ['GET', `/api/v1/edge/refused-captures/${id}`],
      ['POST', `/api/v1/edge/refused-captures/${id}/resolve`],
    ] as const) {
      assert.strictEqual((await makeRequest(port, method, path, method === 'POST' ? { note: 'n' } : undefined)).status, 401, path);
    }
    await provision('nobody', []);
    const res = await makeRequest(port, 'GET', '/api/v1/edge/refused-captures', undefined, headers['nobody']);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('AC4: the list is narrowed by module and site, and an invisible detail is 404', async () => {
    const inventoryRow = await refusal();
    const maintenanceBody = envelope(techId, { payload: { capture_kind: 'shell_test', site_id: otherSiteId } });
    await upload('tech', maintenanceBody);
    const [maintenanceRow] = await recordsFor(maintenanceBody['event_id']);

    const ids = async (who: string, query = ''): Promise<unknown[]> => {
      const res = await makeRequest(port, 'GET', `/api/v1/edge/refused-captures${query}`, undefined, headers[who]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return (res.body['refusals'] as Array<Record<string, unknown>>).map((r) => r['refusal_id']);
    };
    const supervisorIds = await ids('supervisor', '?limit=500');
    assert.ok(supervisorIds.includes(inventoryRow['refusal_id']));
    assert.ok(supervisorIds.includes(maintenanceRow?.['refusal_id']));
    const readerIds = await ids('reader', '?limit=500');
    assert.ok(readerIds.includes(maintenanceRow?.['refusal_id']));
    assert.equal(readerIds.includes(inventoryRow['refusal_id']), false, 'no inventory scope');
    assert.deepStrictEqual(await ids('elsewhere'), [], 'no scope at this site');
    assert.equal((await ids('supervisor', '?stream_type=maintenance&limit=500')).includes(inventoryRow['refusal_id']), false);
    assert.deepStrictEqual(await ids('supervisor', `?location_id=${otherSiteId}`), []);

    const hidden = await makeRequest(port, 'GET', `/api/v1/edge/refused-captures/${String(inventoryRow['refusal_id'])}`, undefined, headers['reader']);
    assert.strictEqual(hidden.status, 404);
    assert.strictEqual(hidden.body['error_code'], 'REFUSED_CAPTURE_NOT_FOUND');
    assert.deepStrictEqual(hidden.body['details'], { refusal_id: inventoryRow['refusal_id'] });
    const shown = await makeRequest(port, 'GET', `/api/v1/edge/refused-captures/${String(inventoryRow['refusal_id'])}`, undefined, headers['supervisor']);
    assert.strictEqual(shown.status, 200);
    assert.strictEqual((shown.body['refusal'] as Record<string, unknown>)['event_id'], inventoryRow['event_id']);
  });

  it('AC4: resolve validates the note, needs write, and is DOA-gated in the applier', async () => {
    const body = envelope(techId, { payload: { capture_kind: 'shell_test', site_id: otherSiteId } });
    await upload('tech', body);
    const [row] = await recordsFor(body['event_id']);
    const path = `/api/v1/edge/refused-captures/${String(row?.['refusal_id'])}/resolve`;

    const noNote = await makeRequest(port, 'POST', path, { note: '   ' }, headers['supervisor']);
    assert.strictEqual(noNote.status, 400);
    assert.strictEqual(noNote.body['error_code'], 'VALIDATION_ERROR');
    assert.deepStrictEqual(noNote.body['details'], { field: 'note' });

    const readOnly = await makeRequest(port, 'POST', path, { note: 'checked' }, headers['reader']);
    assert.strictEqual(readOnly.status, 403);
    assert.strictEqual(readOnly.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // Write on the module, but only at another site.
    const offSite = await makeRequest(port, 'POST', path, { note: 'checked' }, headers['offsitewriter']);
    assert.strictEqual(offSite.status, 403, JSON.stringify(offSite.body));
    assert.strictEqual(offSite.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const notApprover = await makeRequest(port, 'POST', path, { note: 'checked' }, headers['writer']);
    assert.strictEqual(notApprover.status, 403, JSON.stringify(notApprover.body));
    assert.strictEqual(notApprover.body['error_code'], 'APPROVAL_REQUIRED');
    assert.deepStrictEqual(notApprover.body['details'], {
      refusal_id: row?.['refusal_id'],
      resolved_approver_user_id: supervisorId,
    });

    const key = randomUUID();
    const resolved = await makeRequest(port, 'POST', path, { note: ' Wrong role on tablet ', idempotency_key: key }, headers['supervisor']);
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolved.body));
    const refusal = resolved.body['refusal'] as Record<string, unknown>;
    assert.strictEqual(refusal['status'], 'resolved');
    assert.strictEqual(refusal['resolved_by'], supervisorId);
    assert.strictEqual(refusal['resolution_note'], 'Wrong role on tablet');

    const replay = await makeRequest(port, 'POST', path, { note: 'Wrong role on tablet', idempotency_key: key }, headers['supervisor']);
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.body['event_id'], resolved.body['event_id']);

    const second = await makeRequest(port, 'POST', path, { note: 'again' }, headers['supervisor']);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body['error_code'], 'REFUSED_CAPTURE_ALREADY_RESOLVED');
    assert.deepStrictEqual(second.body['details'], {
      refusal_id: row?.['refusal_id'],
      resolved_by: supervisorId,
      resolved_at: refusal['resolved_at'],
    });
  });

  it('AC4: an idempotency key already used on another refusal never reports a false resolution', async () => {
    const first = await refusal();
    const second = await refusal();
    const key = randomUUID();
    const resolved = await makeRequest(
      port,
      'POST',
      `/api/v1/edge/refused-captures/${String(first['refusal_id'])}/resolve`,
      { note: 'first', idempotency_key: key },
      headers['supervisor'],
    );
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolved.body));

    const reused = await makeRequest(
      port,
      'POST',
      `/api/v1/edge/refused-captures/${String(second['refusal_id'])}/resolve`,
      { note: 'second', idempotency_key: key },
      headers['supervisor'],
    );
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    assert.strictEqual(reused.body['error_code'], 'DUPLICATE_EVENT');
    const stillOpen = await makeRequest(
      port,
      'GET',
      `/api/v1/edge/refused-captures/${String(second['refusal_id'])}`,
      undefined,
      headers['supervisor'],
    );
    assert.strictEqual((stillOpen.body['refusal'] as Record<string, unknown>)['status'], 'open');
  });

  it('AC4: an out-of-range offset is a 400, not a PostgreSQL overflow', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/edge/refused-captures?offset=99999999999999999999',
      undefined,
      headers['supervisor'],
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC4: resolve with no DOA entry is APPROVAL_UNRESOLVED', async () => {
    const row = await refusal();
    await getAdminPool().query(`DELETE FROM doa_registry_entries WHERE transaction_type = $1`, [DOA_TYPE]);
    try {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/edge/refused-captures/${String(row['refusal_id'])}/resolve`,
        { note: 'checked' },
        headers['supervisor'],
      );
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
      assert.deepStrictEqual(res.body['details'], { transaction_type: DOA_TYPE });
    } finally {
      await seedDoa();
    }
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { deriveIndentStatus } from '../../src/compliance/indent.js';
import { routeIndentLines, lineValueOf } from '../../src/compliance/indent-routing.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.10: requisition line-level approval and mixed routing. Runs against the production
// router (createAppRouter) with real auth, RBAC, per-line DOA resolution and PostgreSQL. Bands and
// roles are suffixed per run (the story-4-3 pattern) so seeds never collide.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

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
type Row = Record<string, unknown>;

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
          let parsed: Row = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Row;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY', raw };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
  assert.strictEqual(res.status, 201, `provision ${externalId}: ${JSON.stringify(res.body)}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status < 300, `dev-token ${sub}: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 4.10 line-level approval and mixed routing', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  let requesterHeaders: Record<string, string>;
  let requesterId: string;
  let deptHeadHeaders: Record<string, string>;
  let deptHeadId: string;
  let financeHeaders: Record<string, string>;
  let financeId: string;
  let otherWriterHeaders: Record<string, string>;
  let deptEntryId: string;
  let finEntryId: string;

  const line = (sku: string, qty: number, price: number | null) => ({
    sku,
    item_category: 'consumables',
    requested_qty: qty,
    uom: 'EA',
    ...(price === null ? {} : { unit_price_estimate: price }),
  });

  function raiseBody(lines: Row[], overrides: Row = {}): Row {
    return {
      department_code: 'MAINT',
      site_id: siteA,
      business_stream: 'production',
      need_by_date: '2026-12-01',
      urgent: false,
      reason: 'Line consumables',
      confirm_duplicate: true,
      lines,
      ...overrides,
    };
  }

  /** Two small lines for the dept head, one big line for finance. */
  async function raiseMixed(tag: string): Promise<{ indent: Row; lines: Row[] }> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody([
        line(`SKU-410-${tag}-A-${run}`, 10, 100),
        line(`SKU-410-${tag}-B-${run}`, 2, 500),
        line(`SKU-410-${tag}-C-${run}`, 3, 100000),
      ]),
      requesterHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { indent: res.body['indent'] as Row, lines: res.body['lines'] as Row[] };
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
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE indent_line, indent, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    const write = (role: string, locationId = '*'): Role => ({
      role,
      module: 'procurement',
      functionScope: 'write',
      locationId,
    });
    requesterId = await provisionUser(port, `req-410-${run}@example.com`, [
      write('floor_supervisor', siteA),
    ]);
    requesterHeaders = await authFor(port, `req-410-${run}@example.com`);
    deptHeadId = await provisionUser(port, `dh-410-${run}@example.com`, [
      write(`department_head_410_${run}`),
    ]);
    deptHeadHeaders = await authFor(port, `dh-410-${run}@example.com`);
    financeId = await provisionUser(port, `fin-410-${run}@example.com`, [
      write(`finance_controller_410_${run}`),
    ]);
    financeHeaders = await authFor(port, `fin-410-${run}@example.com`);
    await provisionUser(port, `other-410-${run}@example.com`, [write('procurement_officer')]);
    otherWriterHeaders = await authFor(port, `other-410-${run}@example.com`);

    await provisionUser(port, `doa-410-${run}@example.com`, [
      {
        role: 'compliance_admin_410',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-410-${run}@example.com`);
    const ids: string[] = [];
    // Pilot bands (O1): department head up to 1,00,000 inclusive, finance controller above.
    for (const entry of [
      { role: `department_head_410_${run}`, value_min: null, value_max: 100000 },
      { role: `finance_controller_410_${run}`, value_min: 100000, value_max: null },
    ]) {
      const r = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { transaction_type: 'indent_approval', ...entry },
        doaHeaders,
      );
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      ids.push(
        ((r.body['entry'] as Row | undefined)?.['entry_id'] ?? r.body['entry_id']) as string,
      );
    }
    [deptEntryId, finEntryId] = ids as [string, string];
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 1, 2, 4: routing at raise ---------------------------------------------------------

  it('AC1/AC2: a three-line raise routes each line on its own value; header approver is the highest-value line', async () => {
    const { indent, lines } = await raiseMixed('MIX');
    assert.strictEqual(lines.length, 3);
    assert.deepStrictEqual(
      lines.map((l) => [l['approval_route'], l['line_status'], l['approver_actor_id']]),
      [
        ['doa', 'pending', deptHeadId],
        ['doa', 'pending', deptHeadId],
        ['doa', 'pending', financeId],
      ],
    );
    assert.strictEqual(lines[0]!['doa_entry_id'], deptEntryId);
    assert.strictEqual(lines[2]!['doa_entry_id'], finEntryId);
    assert.strictEqual(indent['approver_actor_id'], financeId);
    assert.strictEqual(indent['doa_entry_id'], finEntryId);
    assert.strictEqual(indent['status'], 'raised');
    assert.strictEqual(indent['line_count'], 3);
    assert.strictEqual(indent['approved_line_count'], 0);
  });

  it('AC4: band boundary - exactly 1,00,000 is the department head, 1,00,000.01 is finance, zero is the department head', async () => {
    const routes = await routeIndentLines([
      line('x', 1, 100000),
      line('x', 1, 100000.01),
      line('x', 1, null),
    ]);
    assert.deepStrictEqual(
      routes.map((r) => [r.line_value, r.approver_actor_id]),
      [
        [100000, deptHeadId],
        [100000.01, financeId],
        [0, deptHeadId],
      ],
    );
    assert.strictEqual(lineValueOf({ requested_qty: 3, unit_price_estimate: 0.1 }), 0.3);
  });

  it('AC6: no band, no store - HTTP and edge sync both refuse INDENT_APPROVAL_BAND_MISSING', async () => {
    const adminPool = getAdminPool();
    // Open a gap: the finance band becomes 200000+ so a 1,50,000 line matches nothing.
    await adminPool.query(
      `UPDATE doa_registry_entries SET value_min = 200000 WHERE entry_id = $1`,
      [finEntryId],
    );
    try {
      const before = (await getPool().query(`SELECT count(*)::int AS n FROM indent`)).rows[0]!['n'];
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/indents',
        raiseBody([line(`SKU-410-GAP-A-${run}`, 1, 10), line(`SKU-410-GAP-B-${run}`, 1, 150000)]),
        requesterHeaders,
      );
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'INDENT_APPROVAL_BAND_MISSING');
      assert.deepStrictEqual(res.body['details'], {
        line_no: 2,
        line_value: 150000,
        transaction_type: 'indent_approval',
      });

      const indentId = randomUUID();
      const edge = await makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          event_id: randomUUID(),
          stream_type: 'procurement',
          stream_id: indentId,
          event_type: 'indent.raised',
          payload: {
            indent_id: indentId,
            department_code: 'MAINT',
            site_id: siteA,
            business_stream: 'production',
            need_by_date: '2026-12-01',
            lines: [line(`SKU-410-GAP-E-${run}`, 1, 150000)],
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: requesterId, role: 'floor_supervisor', location_id: siteA },
            device_id: `EDGE-410-${run}`,
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: `edge-410-gap-${run}`,
        },
        requesterHeaders,
      );
      assert.strictEqual(edge.status, 409, JSON.stringify(edge.body));
      assert.strictEqual(edge.body['error_code'], 'INDENT_APPROVAL_BAND_MISSING');
      const after = (await getPool().query(`SELECT count(*)::int AS n FROM indent`)).rows[0]!['n'];
      assert.strictEqual(after, before, 'nothing persisted');
    } finally {
      await adminPool.query(
        `UPDATE doa_registry_entries SET value_min = 100000 WHERE entry_id = $1`,
        [finEntryId],
      );
    }
  });

  it('AC2: edge sync produces the same per-line routing as the HTTP raise', async () => {
    const indentId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: randomUUID(),
        stream_type: 'procurement',
        stream_id: indentId,
        event_type: 'indent.raised',
        payload: {
          indent_id: indentId,
          department_code: 'MAINT',
          site_id: siteA,
          business_stream: 'production',
          need_by_date: '2026-12-01',
          duplicate_confirmed: true,
          lines: [line(`SKU-410-EDGE-A-${run}`, 1, 10), line(`SKU-410-EDGE-B-${run}`, 1, 150000)],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: requesterId, role: 'floor_supervisor', location_id: siteA },
          device_id: `EDGE-410-${run}`,
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: `edge-410-ok-${run}`,
      },
      requesterHeaders,
    );
    assert.ok(res.status < 300, JSON.stringify(res.body));
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${indentId}`,
      undefined,
      financeHeaders,
    );
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const lines = got.body['lines'] as Row[];
    assert.deepStrictEqual(
      lines.map((l) => l['approver_actor_id']),
      [deptHeadId, financeId],
    );
    assert.strictEqual((got.body['indent'] as Row)['approver_actor_id'], financeId);
  });

  // --- AC 3, 7: per-line decisions -----------------------------------------------------------

  it('AC3/AC7: approve two lines by id leaves the header raised with 2 of 3 approved; the third line waits', async () => {
    const { indent, lines } = await raiseMixed('PART');
    const id = indent['indent_id'] as string;
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [lines[0]!['indent_line_id'], lines[1]!['indent_line_id']] },
      deptHeadHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const header = res.body['indent'] as Row;
    assert.strictEqual(header['status'], 'raised');
    assert.strictEqual(header['line_count'], 3);
    assert.strictEqual(header['approved_line_count'], 2);
    const after = res.body['lines'] as Row[];
    assert.deepStrictEqual(
      after.map((l) => l['line_status']),
      ['approved', 'approved', 'pending'],
    );
    assert.strictEqual(after[0]!['decided_by'], deptHeadId);

    // AC 7 on GET and on the list.
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${id}`,
      undefined,
      requesterHeaders,
    );
    assert.strictEqual((got.body['indent'] as Row)['approved_line_count'], 2);
    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/indents?mine=true&limit=200',
      undefined,
      requesterHeaders,
    );
    const row = (list.body['indents'] as Row[]).find((r) => r['indent_id'] === id)!;
    assert.strictEqual(row['line_count'], 3);
    assert.strictEqual(row['approved_line_count'], 2);

    // Already decided line is refused, and the whole request with it (all or nothing).
    const again = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [lines[0]!['indent_line_id']] },
      deptHeadHeaders,
    );
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body['error_code'], 'INDENT_LINE_ALREADY_DECIDED');

    // Unknown line id for this indent.
    const unknown = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [randomUUID()] },
      financeHeaders,
    );
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body['error_code'], 'INDENT_LINE_NOT_FOUND');

    // Approver of line A cannot decide line C.
    const wrong = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [lines[2]!['indent_line_id']] },
      deptHeadHeaders,
    );
    assert.strictEqual(wrong.status, 403);
    assert.strictEqual(wrong.body['error_code'], 'NOT_RESOLVED_APPROVER');

    // Reject the third with a reason: Table 1 derives header approved.
    const rej = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/reject`,
      { rejection_reason: 'Too expensive', line_ids: [lines[2]!['indent_line_id']] },
      financeHeaders,
    );
    assert.strictEqual(rej.status, 200, JSON.stringify(rej.body));
    const final = rej.body['indent'] as Row;
    assert.strictEqual(final['status'], 'approved');
    assert.strictEqual(final['decided_by'], financeId);
    assert.strictEqual(final['rejection_reason'], null);
    assert.strictEqual(final['approved_line_count'], 2);
    assert.strictEqual((rej.body['lines'] as Row[])[2]!['rejection_reason'], 'Too expensive');

    // One audit entry per decided line.
    const audit = await getPool().query(
      `SELECT error_code, details FROM audit_log WHERE details->>'indent_id' = $1 AND error_code LIKE 'indent.line_%' ORDER BY (details->>'line_no')::int`,
      [id],
    );
    assert.deepStrictEqual(
      audit.rows.map((r) => [r['error_code'], (r['details'] as Row)['line_no']]),
      [
        ['indent.line_approved', 1],
        ['indent.line_approved', 2],
        ['indent.line_rejected', 3],
      ],
    );
  });

  it('AC3: absent line_ids decides only the lines the actor holds, and the persisted event carries the explicit list', async () => {
    const { indent, lines } = await raiseMixed('HELD');
    const id = indent['indent_id'] as string;
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(
      (res.body['lines'] as Row[]).map((l) => l['line_status']),
      ['approved', 'approved', 'pending'],
    );
    const ev = await getPool().query(`SELECT payload FROM domain_events WHERE event_id = $1`, [
      res.body['event_id'],
    ]);
    assert.deepStrictEqual(
      ((ev.rows[0]!['payload'] as Row)['line_ids'] as string[]).sort(),
      [lines[0]!['indent_line_id'], lines[1]!['indent_line_id']].sort(),
    );
    // Requester notified in the same transaction (the dispatch cycle projects it).
    await runDispatchCycle();
    const notes = await getPool().query(
      `SELECT count(*)::int AS n FROM notifications WHERE object_id = $1 AND event_type = 'indent_decision'`,
      [id],
    );
    assert.strictEqual(notes.rows[0]!['n'], 1);
  });

  it('AC3: SOD-01 per line, and a non-approver writer is NOT_RESOLVED_APPROVER', async () => {
    const { indent, lines } = await raiseMixed('SOD');
    const id = indent['indent_id'] as string;
    const own = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [lines[0]!['indent_line_id']] },
      requesterHeaders,
    );
    assert.strictEqual(own.status, 403);
    assert.strictEqual(own.body['error_code'], 'INDENT_RAISER_CANNOT_APPROVE');
    const other = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      {},
      otherWriterHeaders,
    );
    assert.strictEqual(other.status, 403);
    assert.strictEqual(other.body['error_code'], 'NOT_RESOLVED_APPROVER');
    const bad = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: ['nope'] },
      deptHeadHeaders,
    );
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: rejecting every line derives header rejected with the last reason', async () => {
    const { indent } = await raiseMixed('REJ');
    const id = indent['indent_id'] as string;
    const r1 = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/reject`,
      { rejection_reason: 'first' },
      deptHeadHeaders,
    );
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    assert.strictEqual((r1.body['indent'] as Row)['status'], 'raised');
    const r2 = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/reject`,
      { rejection_reason: 'second' },
      financeHeaders,
    );
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    const h = r2.body['indent'] as Row;
    assert.strictEqual(h['status'], 'rejected');
    assert.strictEqual(h['rejection_reason'], 'second');
    assert.strictEqual(h['approved_line_count'], 0);
    const again = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(again.body['error_code'], 'INDENT_ALREADY_DECIDED');
  });

  it('Table 1: deriveIndentStatus unit cases', () => {
    const l = (
      s: 'pending' | 'approved' | 'rejected',
      at: string | null,
      by = 'u',
      r: string | null = null,
    ) => ({
      line_status: s,
      decided_at: at,
      decided_by: by,
      rejection_reason: r,
    });
    assert.strictEqual(
      deriveIndentStatus([l('approved', '2026-01-01'), l('pending', null)]).status,
      'raised',
    );
    const mixed = deriveIndentStatus([
      l('rejected', '2026-01-02T00:00:00Z', 'b', 'no'),
      l('approved', '2026-01-01T00:00:00Z', 'a'),
    ]);
    assert.deepStrictEqual(mixed, {
      status: 'approved',
      decided_at: '2026-01-02T00:00:00Z',
      decided_by: 'b',
      rejection_reason: null,
    });
    assert.deepStrictEqual(
      deriveIndentStatus([
        l('rejected', '2026-01-01T00:00:00Z', 'a', 'x'),
        l('rejected', '2026-01-03T00:00:00Z', 'b', 'y'),
      ]),
      {
        status: 'rejected',
        decided_at: '2026-01-03T00:00:00Z',
        decided_by: 'b',
        rejection_reason: 'y',
      },
    );
  });

  // --- AC 2 seam for Story 4.8 ----------------------------------------------------------------

  it('AC2 (Task 2.5): a pre-routed line is approved at raise while the DOA line still waits - no split', async () => {
    const lines = [line(`SKU-410-PRE-A-${run}`, 1, 10), line(`SKU-410-PRE-B-${run}`, 1, 10)];
    // Story 4.8 (D6): the seam only accepts a standing_approval line that names an active grant of
    // this requester at this site covering its SKU, so the fixture inserts one.
    const grantId = randomUUID();
    await getPool().query(
      `INSERT INTO standing_grant (grant_id, grant_ref, grant_kind, grantee_user_id, assigner_user_id,
         site_id, scope_sku, status, source_event_id)
       VALUES ($1, $2, 'standing_approval', $3, $4, $5, $6, 'active', $7)`,
      [
        grantId,
        `SA-T410-${run}`,
        requesterId,
        deptHeadId,
        siteA,
        `SKU-410-PRE-A-${run}`,
        randomUUID(),
      ],
    );
    const routes = await routeIndentLines(
      lines,
      undefined,
      new Map([[0, { approval_route: 'standing_approval', standing_grant_id: grantId }]]),
    );
    assert.strictEqual(routes[0]!.approver_actor_id, null);
    assert.strictEqual(routes[0]!.requires_approval, false);
    assert.strictEqual(routes[1]!.approver_actor_id, deptHeadId);
    const indentId = randomUUID();
    await persistEvent({
      stream_type: 'procurement',
      stream_id: indentId,
      event_type: 'indent.raised',
      event_id: randomUUID(),
      payload: {
        indent_id: indentId,
        requester_user_id: requesterId,
        department_code: 'MAINT',
        site_id: siteA,
        business_stream: 'production',
        need_by_date: '2026-12-01',
        duplicate_confirmed: true,
        lines: lines.map((l, i) => ({
          ...l,
          approval_route: routes[i]!.approval_route,
          approver_actor_id: routes[i]!.approver_actor_id ?? undefined,
          doa_entry_id: routes[i]!.doa_entry_id ?? undefined,
          standing_grant_id: routes[i]!.standing_grant_id ?? undefined,
        })),
        approver_actor_id: deptHeadId,
        doa_entry_id: deptEntryId,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: requesterId, role: 'floor_supervisor', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    });
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${indentId}`,
      undefined,
      requesterHeaders,
    );
    const rows = got.body['lines'] as Row[];
    assert.deepStrictEqual(
      rows.map((l) => [l['approval_route'], l['line_status'], l['decided_by']]),
      [
        ['standing_approval', 'approved', 'system'],
        ['doa', 'pending', null],
      ],
    );
    const header = got.body['indent'] as Row;
    assert.strictEqual(header['status'], 'raised');
    assert.strictEqual(header['approved_line_count'], 1);
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((res.body['indent'] as Row)['status'], 'approved');
  });

  // --- code review 2026-10-21 ----------------------------------------------------------------

  it('review: a direct events post cannot pre-route (auto-approve) a line; the route fields are dropped', async () => {
    const indentId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        event_id: randomUUID(),
        stream_type: 'procurement',
        stream_id: indentId,
        event_type: 'indent.raised',
        payload: {
          indent_id: indentId,
          requester_user_id: requesterId,
          department_code: 'MAINT',
          site_id: siteA,
          business_stream: 'production',
          need_by_date: '2026-12-01',
          duplicate_confirmed: true,
          approver_actor_id: deptHeadId,
          lines: [{ ...line(`SKU-410-FORGE-${run}`, 1, 10), approval_route: 'self_approval' }],
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: requesterId, role: 'procurement_officer', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: `ev-410-forge-${run}`,
      },
      otherWriterHeaders,
    );
    assert.ok(res.status < 300, JSON.stringify(res.body));
    const rows = (
      await getPool().query(
        `SELECT approval_route, line_status FROM indent_line WHERE indent_id = $1`,
        [indentId],
      )
    ).rows as Row[];
    assert.deepStrictEqual(rows, [{ approval_route: 'doa', line_status: 'pending' }]);
  });

  it('review: a non-object line is a 400, not a 500', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody([line(`SKU-410-NULL-${run}`, 1, 10), null as unknown as Row]),
      requesterHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // --- AC 5: migration ------------------------------------------------------------------------

  it('AC5: the backfill gives legacy lines the header decision, idempotently', async () => {
    const adminPool = getAdminPool();
    const id = randomUUID();
    const at = '2026-01-05T10:00:00.000Z';
    await adminPool.query(
      `INSERT INTO indent (indent_id, indent_number_ext, requester_user_id, department_code, site_id, business_stream, need_by_date, status, approver_actor_id, doa_entry_id, decided_at, decided_by, source_event_id)
       VALUES ($1, $2, $3, 'MAINT', $4, 'production', '2026-01-01', 'approved', $5, $6, $7, $5, $8)`,
      [id, `IND-LEGACY-${run}`, requesterId, siteA, deptHeadId, deptEntryId, at, randomUUID()],
    );
    for (const n of [1, 2]) {
      await adminPool.query(
        `INSERT INTO indent_line (indent_line_id, indent_id, line_no, sku, item_category, requested_qty, uom) VALUES ($1, $2, $3, $4, 'c', 1, 'EA')`,
        [randomUUID(), id, n, `SKU-LEGACY-${n}-${run}`],
      );
    }
    const sql = readFileSync(resolve(__dirname, '../../read/projections/indent_line.sql'), 'utf-8');
    for (let i = 0; i < 2; i += 1) {
      await adminPool.query(sql);
      const rows = (
        await adminPool.query(
          `SELECT line_status, approver_actor_id, doa_entry_id, decided_by, decided_at FROM indent_line WHERE indent_id = $1 ORDER BY line_no`,
          [id],
        )
      ).rows as Row[];
      assert.strictEqual(rows.length, 2);
      for (const r of rows) {
        assert.strictEqual(r['line_status'], 'approved');
        assert.strictEqual(r['approver_actor_id'], deptHeadId);
        assert.strictEqual(r['doa_entry_id'], deptEntryId);
        assert.strictEqual(r['decided_by'], deptHeadId);
        assert.strictEqual(new Date(r['decided_at'] as string).toISOString(), at);
      }
    }
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.13: an approver asks the requester a question (request-info). Reuses the 4.12 user and
// DOA band set-up: dept holds the small band, finance the large one.

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
type Headers = Record<string, string>;

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Headers,
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

async function authFor(port: number, sub: string): Promise<Headers> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status < 300, `dev-token ${sub}: ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 4.13 requisition ask for info', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const users: Record<string, { id: string; headers: Headers; email: string }> = {};
  const deptRole = `department_head_413_${run}`;
  const finRole = `finance_controller_413_${run}`;

  const employee = (locationId = siteA): Role => ({
    role: 'employee',
    module: 'employee',
    functionScope: 'write',
    locationId,
  });
  const line = (sku: string, qty: number, price: number) => ({
    sku,
    item_category: 'consumables',
    requested_qty: qty,
    uom: 'EA',
    unit_price_estimate: price,
  });

  async function raise(
    lines: Row[],
    confirmDuplicate = true,
  ): Promise<{ indent: Row; lines: Row[] }> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      {
        department_code: 'MAINT',
        site_id: siteA,
        business_stream: 'production',
        need_by_date: '2026-12-01',
        urgent: false,
        reason: 'Approvals inbox',
        confirm_duplicate: confirmDuplicate,
        lines,
      },
      users['requester']!.headers,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { indent: res.body['indent'] as Row, lines: res.body['lines'] as Row[] };
  }

  const list = (who: string, query: string) =>
    makeRequest(port, 'GET', `/api/v1/indents?${query}`, undefined, users[who]!.headers);
  const detail = (who: string, id: string) =>
    makeRequest(port, 'GET', `/api/v1/indents/${id}`, undefined, users[who]!.headers);
  const idsOf = (res: HttpResult) => (res.body['indents'] as Row[]).map((r) => r['indent_id']);
  const rowOf = (res: HttpResult, id: unknown) =>
    (res.body['indents'] as Row[]).find((r) => r['indent_id'] === id);

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
      '../../read/projections/indent_info_request.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE indent_info_request, indent_line, indent, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    const people: Array<[string, Role[]]> = [
      [
        'requester',
        [
          employee(),
          { role: 'employee', module: 'notification', functionScope: 'read', locationId: siteA },
        ],
      ],
      [
        'dept',
        [
          employee(),
          { role: deptRole, module: 'procurement', functionScope: 'write', locationId: siteA },
        ],
      ],
      [
        'finance',
        [
          employee(),
          { role: finRole, module: 'migration', functionScope: 'write', locationId: '*' },
          { role: finRole, module: 'jobwork', functionScope: 'write', locationId: '*' },
          { role: finRole, module: 'compliance', functionScope: 'write', locationId: '*' },
          { role: finRole, module: 'inventory', functionScope: 'read', locationId: '*' },
        ],
      ],
      ['delegate1', [employee()]],
      ['delegate2', [employee()]],
      ['plain', [employee()]],
    ];
    for (const [key, roles] of people) {
      const email = `${key}-413-${run}@example.com`;
      const id = await provisionUser(port, email, roles);
      users[key] = { id, headers: await authFor(port, email), email };
    }

    await provisionUser(port, `doa-413-${run}@example.com`, [
      {
        role: 'compliance_admin_413',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-413-${run}@example.com`);
    for (const entry of [
      { role: deptRole, value_min: null, value_max: 100000 },
      { role: finRole, value_min: 100000, value_max: null },
    ]) {
      const r = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { transaction_type: 'indent_approval', ...entry },
        doaHeaders,
      );
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    }
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePool();
    await closeAdminPool();
  });

  const ask = (who: string, id: string, body: unknown) =>
    makeRequest(port, 'POST', `/api/v1/indents/${id}/request-info`, body, users[who]!.headers);
  const count = async (sql: string, args: unknown[]): Promise<number> =>
    (await getAdminPool().query(sql, args)).rows[0].n as number;
  const counts = async (id: string) => ({
    events: await count(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'indent.info_requested' AND stream_id = $1`,
      [id],
    ),
    rows: await count(`SELECT count(*)::int AS n FROM indent_info_request WHERE indent_id = $1`, [
      id,
    ]),
    audit: await count(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = 'indent.info_requested' AND details->>'indent_id' = $1`,
      [id],
    ),
    notes: await count(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'notification.created'
         AND payload->>'event_type' = 'indent_info_requested' AND payload->>'object_id' = $1`,
      [id],
    ),
  });

  it('AC1/AC4/AC6: ask writes one event, row, audit entry and notification; lines stay pending; reads carry it', async () => {
    const { indent, lines } = await raise([line(`SKU-413-A-${run}`, 2, 100)]);
    const id = indent['indent_id'] as string;
    const res = await ask('dept', id, { question: '  Which machine is this for?  ' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(await counts(id), { events: 1, rows: 1, audit: 1, notes: 1 });
    assert.strictEqual((res.body['indent'] as Row)['status'], 'raised');
    assert.strictEqual((res.body['lines'] as Row[])[0]!['line_status'], 'pending');

    const d = await detail('dept', id);
    const q = (d.body['info_requests'] as Row[])[0]!;
    assert.strictEqual(q['question'], 'Which machine is this for?');
    assert.deepStrictEqual(q['line_ids'], [lines[0]!['indent_line_id']]);
    assert.strictEqual(q['asked_by'], users['dept']!.email);
    assert.deepStrictEqual(d.body['pending_for_me_line_ids'], [lines[0]!['indent_line_id']]);

    const mine = await list('requester', 'mine=true');
    const info = rowOf(mine, id)!['info_requested'] as Row;
    assert.strictEqual(info['question'], 'Which machine is this for?');
    const inbox = await list('dept', 'pending_for_me=true');
    assert.ok(idsOf(inbox).includes(id), 'the row stays Waiting');
    assert.strictEqual((rowOf(inbox, id)!['info_requested'] as Row)['question'], info['question']);

    await runDispatchCycle();
    const note = await getAdminPool().query(
      `SELECT target_user_id FROM notifications WHERE object_id = $1 AND event_type = 'indent_info_requested'`,
      [id],
    );
    assert.strictEqual(note.rows[0].target_user_id, users['requester']!.id);
    const feed = await makeRequest(
      port,
      'GET',
      '/api/v1/notifications',
      undefined,
      users['requester']!.headers,
    );
    assert.strictEqual(feed.status, 200, JSON.stringify(feed.body));
    assert.ok(
      JSON.stringify(feed.body).includes('indent_info_requested'),
      'GET /notifications returns the row',
    );

    // Q27: a second question replaces the displayed one; history stays.
    assert.strictEqual((await ask('dept', id, { question: 'And the budget code?' })).status, 200);
    const all = (await detail('dept', id)).body['info_requests'] as Row[];
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0]!['question'], 'And the budget code?');
    assert.strictEqual(
      (rowOf(await list('requester', 'mine=true'), id)!['info_requested'] as Row)['question'],
      'And the budget code?',
    );
  });

  it('AC1: an active delegate may ask', async () => {
    const adminPool = getAdminPool();
    const today = new Date().toISOString().slice(0, 10);
    await adminPool.query(
      `INSERT INTO doa_vacation_delegations (delegator_user_id, delegate_user_id, start_date, end_date, created_at)
       VALUES ($1, $2, $3::date - 1, $3::date + 1, '2026-01-01T00:00:00Z')`,
      [users['dept']!.id, users['delegate1']!.id, today],
    );
    try {
      const { indent } = await raise([line(`SKU-413-D-${run}`, 1, 50)]);
      const id = indent['indent_id'] as string;
      const res = await ask('delegate1', id, { question: 'Delegate asks' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual((await counts(id)).rows, 1);
    } finally {
      await adminPool.query(`DELETE FROM doa_vacation_delegations WHERE delegator_user_id = $1`, [
        users['dept']!.id,
      ]);
    }
  });

  it('AC2: every refusal row returns its code and writes nothing', async () => {
    const { indent, lines } = await raise([
      line(`SKU-413-S-${run}`, 1, 100),
      line(`SKU-413-B-${run}`, 1, 150000),
    ]);
    const id = indent['indent_id'] as string;
    const small = lines[0]!['indent_line_id'] as string;
    const zero = { events: 0, rows: 0, audit: 0, notes: 0 };

    for (const [who, body, status, code] of [
      ['dept', { question: '   ' }, 400, 'INDENT_INFO_QUESTION_REQUIRED'],
      ['dept', {}, 400, 'INDENT_INFO_QUESTION_REQUIRED'],
      ['dept', { question: 'x'.repeat(2001) }, 400, 'INDENT_INFO_QUESTION_TOO_LONG'],
      ['requester', { question: 'Asking myself' }, 403, 'INDENT_RAISER_CANNOT_APPROVE'],
      ['plain', { question: 'Not mine' }, 403, 'NOT_RESOLVED_APPROVER'],
    ] as const) {
      const res = await ask(who, id, body);
      assert.strictEqual(res.status, status, `${who}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], code);
    }

    // A decided line is refused while the header is still raised.
    const approve = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [small] },
      users['dept']!.headers,
    );
    assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));
    const decided = await ask('dept', id, { question: 'Too late', line_ids: [small] });
    assert.strictEqual(decided.status, 409, JSON.stringify(decided.body));
    assert.strictEqual(decided.body['error_code'], 'INDENT_LINE_ALREADY_DECIDED');
    assert.deepStrictEqual(await counts(id), zero);

    const held = await raise([line(`SKU-413-H-${run}`, 1, 10)]);
    const heldId = held.indent['indent_id'] as string;
    await getAdminPool().query(
      `UPDATE indent SET status = 'pending-confirmation' WHERE indent_id = $1`,
      [heldId],
    );
    const hold = await ask('dept', heldId, { question: 'On hold?' });
    assert.strictEqual(hold.status, 409, JSON.stringify(hold.body));
    assert.strictEqual(hold.body['error_code'], 'INDENT_PENDING_CONFIRMATION');
    assert.deepStrictEqual(await counts(heldId), zero);
  });

  it('AC3: the events door and the edge door refuse an uploaded indent.info_requested', async () => {
    const envelope = (extra: Row) => ({
      stream_type: 'procurement',
      stream_id: randomUUID(),
      event_type: 'indent.info_requested',
      payload: {
        indent_id: randomUUID(),
        info_request_id: randomUUID(),
        line_ids: [randomUUID()],
        question: 'Uploaded',
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: users['dept']!.id, role: deptRole, location_id: siteA },
        occurred_at: new Date().toISOString(),
        ...extra,
      },
    });
    const events = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      envelope({}),
      users['dept']!.headers,
    );
    assert.strictEqual(events.status, 403, JSON.stringify(events.body));
    assert.strictEqual(events.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const edge = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        ...envelope({ device_id: `EDGE-413-${run}`, capture_method: 'MANUAL' }),
        event_id: randomUUID(),
        event_version: 1,
        schema_version: 1,
        idempotency_key: randomUUID(),
      },
      users['dept']!.headers,
    );
    assert.strictEqual(edge.status, 403, JSON.stringify(edge.body));
    assert.strictEqual(edge.body['error_code'], 'CENTRAL_ONLY_OPERATION');
  });
});

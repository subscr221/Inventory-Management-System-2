import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.12: approvals inbox list filters, approver detail read and the widened approve/reject
// gate. The finance holder is provisioned as docs/migration/pilot-mock-extract/roles.json
// provisions accounts@: the employee base hat at the site plus migration, jobwork and compliance
// write and inventory read at every location - no procurement assignment (Q25).

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

describe('Story 4.12 approvals inbox and approver detail', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const users: Record<string, { id: string; headers: Headers; email: string }> = {};
  const deptRole = `department_head_412_${run}`;
  const finRole = `finance_controller_412_${run}`;

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

    const people: Array<[string, Role[]]> = [
      ['requester', [employee()]],
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
      const email = `${key}-412-${run}@example.com`;
      const id = await provisionUser(port, email, roles);
      users[key] = { id, headers: await authFor(port, email), email };
    }

    await provisionUser(port, `doa-412-${run}@example.com`, [
      {
        role: 'compliance_admin_412',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-412-${run}@example.com`);
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

  it('AC1: bootstrap sends Approvals to band holders only', async () => {
    for (const [who, expected] of [
      ['finance', true],
      ['dept', true],
      ['requester', false],
      ['plain', false],
    ] as const) {
      const res = await makeRequest(
        port,
        'GET',
        '/api/v1/edge/bootstrap',
        undefined,
        users[who]!.headers,
      );
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(
        (res.body['navigation'] as string[]).includes('Approvals'),
        expected,
        `${who} navigation ${JSON.stringify(res.body['navigation'])}`,
      );
    }
  });

  it('AC2/AC3: finance without procurement lists, reads, approves; dept head rejects; decided tab follows', async () => {
    const { indent, lines } = await raise([
      line(`SKU-412-S-${run}`, 2, 100),
      line(`SKU-412-B-${run}`, 1, 150000),
    ]);
    const id = indent['indent_id'] as string;
    const [small, big] = lines.map((l) => l['indent_line_id'] as string) as [string, string];

    const finList = await list('finance', 'pending_for_me=true');
    assert.strictEqual(finList.status, 200, JSON.stringify(finList.body));
    const finRow = rowOf(finList, id)!;
    assert.ok(finRow, 'finance sees the requisition');
    assert.deepStrictEqual(finRow['pending_for_me_line_ids'], [big]);
    assert.deepStrictEqual([...(finRow['line_skus'] as string[])].sort(), [
      `SKU-412-B-${run}`,
      `SKU-412-S-${run}`,
    ]);
    assert.strictEqual(finRow['requester_display_name'], users['requester']!.email);
    assert.notStrictEqual(finRow['estimated_value'], null, 'approvers see the amount');
    assert.deepStrictEqual(finList.body['approver_bands'], [
      { role: finRole, value_min: 100000, value_max: null },
    ]);

    const deptRow = rowOf(await list('dept', 'pending_for_me=true'), id)!;
    assert.deepStrictEqual(deptRow['pending_for_me_line_ids'], [small]);

    const finDetail = await detail('finance', id);
    assert.strictEqual(finDetail.status, 200, JSON.stringify(finDetail.body));
    assert.deepStrictEqual(finDetail.body['pending_for_me_line_ids'], [big]);
    assert.strictEqual(finDetail.body['requester_display_name'], users['requester']!.email);
    const detailLines = finDetail.body['lines'] as Row[];
    assert.deepStrictEqual(detailLines.find((l) => l['indent_line_id'] === big)!['approver_band'], {
      role: finRole,
      value_min: 100000,
      value_max: null,
    });

    const reqDetail = await detail('requester', id);
    assert.strictEqual(reqDetail.status, 200);
    assert.deepStrictEqual(reqDetail.body['pending_for_me_line_ids'], []);

    const plainDetail = await detail('plain', id);
    assert.strictEqual(plainDetail.status, 403);
    assert.strictEqual(plainDetail.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // Code review: the widened gate rests on the seam, so a base-role user with no band is refused.
    for (const [action, body] of [
      ['approve', { line_ids: [big] }],
      ['reject', { line_ids: [big], rejection_reason: 'Not mine to decide' }],
    ] as const) {
      const refused = await makeRequest(
        port,
        'POST',
        `/api/v1/indents/${id}/${action}`,
        body,
        users['plain']!.headers,
      );
      assert.strictEqual(refused.status, 403, `${action}: ${JSON.stringify(refused.body)}`);
      assert.strictEqual(refused.body['error_code'], 'NOT_RESOLVED_APPROVER');
    }

    const approve = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [big] },
      users['finance']!.headers,
    );
    assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));

    const reject = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/reject`,
      { line_ids: [small], rejection_reason: 'Use stock on hand' },
      users['dept']!.headers,
    );
    assert.strictEqual(reject.status, 200, JSON.stringify(reject.body));

    // Nothing pending: an empty list, never FUNCTION_ACCESS_DENIED.
    const emptied = await list('finance', 'pending_for_me=true');
    assert.strictEqual(emptied.status, 200);
    assert.ok(!idsOf(emptied).includes(id));

    const decided = await list('finance', 'decided_by_me=true');
    assert.strictEqual(decided.status, 200);
    assert.deepStrictEqual(rowOf(decided, id)!['pending_for_me_line_ids'], []);
    assert.ok(idsOf(await list('dept', 'decided_by_me=true')).includes(id));
    assert.ok(!idsOf(await list('plain', 'decided_by_me=true')).includes(id));

    const after = await detail('finance', id);
    assert.strictEqual(after.status, 200, 'the decider still reads the requisition');
    const bigAfter = (after.body['lines'] as Row[]).find((l) => l['indent_line_id'] === big)!;
    assert.strictEqual(bigAfter['decided_by_display_name'], users['finance']!.email);

    // Code review (owner ruling 2026-11-19): an approver reads the slips of what they approved.
    const slips = (who: string) =>
      makeRequest(port, 'GET', `/api/v1/indents/${id}/issues`, undefined, users[who]!.headers);
    assert.strictEqual((await slips('finance')).status, 200);
    assert.strictEqual((await slips('plain')).status, 403);
  });

  it('code review: a Decided row carries no pending ids; a requisition never waits for its raiser', async () => {
    const { indent, lines } = await raise([
      line(`SKU-412-R1-${run}`, 1, 100),
      line(`SKU-412-R2-${run}`, 1, 200),
    ]);
    const id = indent['indent_id'] as string;
    const [first, second] = lines.map((l) => l['indent_line_id'] as string) as [string, string];

    const approve = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [first] },
      users['dept']!.headers,
    );
    assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));
    assert.deepStrictEqual(
      rowOf(await list('dept', 'pending_for_me=true'), id)!['pending_for_me_line_ids'],
      [second],
    );
    assert.deepStrictEqual(
      rowOf(await list('dept', 'decided_by_me=true'), id)!['pending_for_me_line_ids'],
      [],
    );

    // A line whose stored approver is the raiser (they hold the band, or were the delegate at
    // routing): the detail gives the raiser nothing to decide, so the list must not say Waiting.
    await getAdminPool().query(
      `UPDATE indent_line SET approver_actor_id = $1 WHERE indent_line_id = $2`,
      [users['requester']!.id, second],
    );
    assert.ok(!idsOf(await list('requester', 'pending_for_me=true')).includes(id));
    assert.ok(!idsOf(await list('dept', 'pending_for_me=true')).includes(id));
  });

  it('AC2: a pending-confirmation duplicate is not listed as waiting', async () => {
    // An online raise answers 409 instead of storing a pending-confirmation header (only the
    // offline edge path stores one), so the header is set directly.
    const { indent } = await raise([line(`SKU-412-DUP-${run}`, 1, 10)]);
    const id = indent['indent_id'];
    assert.ok(idsOf(await list('dept', 'pending_for_me=true')).includes(id));
    await getAdminPool().query(
      `UPDATE indent SET status = 'pending-confirmation' WHERE indent_id = $1`,
      [id],
    );
    assert.ok(!idsOf(await list('dept', 'pending_for_me=true')).includes(id));
    assert.deepStrictEqual(
      (await detail('dept', id as string)).body['pending_for_me_line_ids'],
      [],
    );
  });

  it('AC2/D3: the earliest active delegate sees and decides; a second overlapping delegate does not', async () => {
    const adminPool = getAdminPool();
    const today = new Date().toISOString().slice(0, 10);
    for (const [delegate, created] of [
      ['delegate1', '2026-01-01T00:00:00Z'],
      ['delegate2', '2026-01-02T00:00:00Z'],
    ] as const) {
      await adminPool.query(
        `INSERT INTO doa_vacation_delegations (delegator_user_id, delegate_user_id, start_date, end_date, created_at)
         VALUES ($1, $2, $3::date - 1, $3::date + 1, $4)`,
        [users['dept']!.id, users[delegate]!.id, today, created],
      );
    }
    try {
      const { indent } = await raise([line(`SKU-412-DEL-${run}`, 1, 50)]);
      const id = indent['indent_id'];

      assert.ok(idsOf(await list('delegate1', 'pending_for_me=true')).includes(id));
      assert.ok(!idsOf(await list('delegate2', 'pending_for_me=true')).includes(id));

      const nav = async (who: string) =>
        (
          (await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, users[who]!.headers))
            .body['navigation'] as string[]
        ).includes('Approvals');
      assert.strictEqual(await nav('delegate1'), true);
      assert.strictEqual(await nav('delegate2'), false);

      const refused = await makeRequest(
        port,
        'POST',
        `/api/v1/indents/${id as string}/approve`,
        {},
        users['delegate2']!.headers,
      );
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.strictEqual(refused.body['error_code'], 'NOT_RESOLVED_APPROVER');

      assert.strictEqual((await detail('delegate1', id as string)).status, 200);
      const ok = await makeRequest(
        port,
        'POST',
        `/api/v1/indents/${id as string}/approve`,
        {},
        users['delegate1']!.headers,
      );
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    } finally {
      await adminPool.query(`DELETE FROM doa_vacation_delegations WHERE delegator_user_id = $1`, [
        users['dept']!.id,
      ]);
    }
  });

  it('AC2: the approver flags refuse each other, mine and issuable', async () => {
    for (const query of [
      'pending_for_me=true&decided_by_me=true',
      'pending_for_me=true&mine=true',
      'decided_by_me=true&issuable=true',
    ]) {
      const res = await list('finance', query);
      assert.strictEqual(res.status, 400, query);
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
  });

  it('AC3: confirm, withdraw and cancel stay procurement write', async () => {
    const { indent } = await raise([line(`SKU-412-CXL-${run}`, 1, 10)]);
    for (const action of ['confirm', 'withdraw', 'cancel']) {
      const res = await makeRequest(
        port,
        'POST',
        `/api/v1/indents/${indent['indent_id'] as string}/${action}`,
        { cancelled_reason: 'x' },
        users['finance']!.headers,
      );
      assert.strictEqual(res.status, 403, `${action}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
    }
  });
});

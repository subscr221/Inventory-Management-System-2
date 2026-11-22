import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { reresolveStuckIndents } from '../../src/cli/reresolve-stuck-indents-core.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.9: indent approver fallback to the department_head holder. Runs against the production
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

describe('Story 4.9 indent approver resolution fallback', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  let requesterHeaders: Record<string, string>;
  let requesterId: string;
  let hodHeaders: Record<string, string>;
  let hodId: string;
  let financeId: string;
  let finEntryId: string;

  const line = (sku: string, qty: number, price: number) => ({
    sku,
    item_category: 'consumables',
    requested_qty: qty,
    uom: 'EA',
    unit_price_estimate: price,
  });
  const raiseBody = (lines: Row[]): Row => ({
    department_code: 'MAINT',
    site_id: siteA,
    business_stream: 'production',
    need_by_date: '2026-12-01',
    urgent: false,
    reason: 'Fallback',
    confirm_duplicate: true,
    lines,
  });
  const edgeBody = (indentId: string, lines: Row[], key: string): Row => ({
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
      lines,
    },
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: requesterId, role: 'floor_supervisor', location_id: siteA },
      device_id: `EDGE-49-${run}`,
      occurred_at: new Date().toISOString(),
    },
    idempotency_key: key,
  });
  const count = async (): Promise<number> =>
    (await getPool().query(`SELECT count(*)::int AS n FROM indent`)).rows[0]!['n'] as number;
  const raise = (lines: Row[], headers: Record<string, string>) =>
    makeRequest(port, 'POST', '/api/v1/indents', raiseBody(lines), headers);

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
    requesterId = await provisionUser(port, `req-49-${run}@example.com`, [
      write('floor_supervisor', siteA),
    ]);
    requesterHeaders = await authFor(port, `req-49-${run}@example.com`);
    financeId = await provisionUser(port, `fin-49-${run}@example.com`, [
      write(`finance_controller_49_${run}`),
    ]);
    await provisionUser(port, `doa-49-${run}@example.com`, [
      {
        role: 'compliance_admin_49',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-49-${run}@example.com`);
    // One band only, above 1,00,000: every smaller value matches no band.
    const r = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'indent_approval',
        role: `finance_controller_49_${run}`,
        value_min: 100000,
        value_max: null,
      },
      doaHeaders,
    );
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    finEntryId = ((r.body['entry'] as Row | undefined)?.['entry_id'] ??
      r.body['entry_id']) as string;
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePool();
    await closeAdminPool();
  });

  it('NO_BAND_NO_HOD: refused on HTTP and edge, nothing persisted', async () => {
    const before = await count();
    const res = await raise([line(`SKU-49-NOHOD-${run}`, 1, 500)], requesterHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INDENT_APPROVAL_BAND_MISSING');
    assert.match(String(res.body['message']), /department_head/);
    const edge = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeBody(randomUUID(), [line(`SKU-49-NOHOD-E-${run}`, 1, 500)], `edge-49-nohod-${run}`),
      requesterHeaders,
    );
    assert.strictEqual(edge.status, 409, JSON.stringify(edge.body));
    assert.strictEqual(edge.body['error_code'], 'INDENT_APPROVAL_BAND_MISSING');
    assert.strictEqual(await count(), before, 'nothing persisted');
  });

  it('NO_BAND_FALLBACK and FALLBACK_STATUS: routes to the department_head; status shows it', async () => {
    hodId = await provisionUser(port, `hod-49-${run}@example.com`, [
      { role: 'department_head', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);
    hodHeaders = await authFor(port, `hod-49-${run}@example.com`);
    const res = await raise(
      [line(`SKU-49-FB-A-${run}`, 1, 500), line(`SKU-49-FB-B-${run}`, 1, 150000)],
      requesterHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const lines = res.body['lines'] as Row[];
    assert.deepStrictEqual(
      lines.map((l) => [
        l['approval_route'],
        l['approver_actor_id'],
        l['doa_entry_id'],
        l['fallback_reason'],
      ]),
      [
        ['doa', hodId, null, 'no_band_match'],
        ['doa', financeId, finEntryId, null],
      ],
    );
    assert.strictEqual((res.body['indent'] as Row)['approver_actor_id'], financeId);
    const id = (res.body['indent'] as Row)['indent_id'] as string;
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${id}`,
      undefined,
      requesterHeaders,
    );
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.strictEqual(
      (got.body['indent'] as Row)['waiting_on_label'],
      'Head of department, fallback: no DOA band matches value',
    );
    assert.deepStrictEqual(
      (got.body['lines'] as Row[]).map((l) => l['fallback_reason']),
      ['no_band_match', null],
    );
  });

  it('FALLBACK_APPROVES: the department_head decides; a non-approver is refused', async () => {
    const res = await raise([line(`SKU-49-AP-${run}`, 1, 500)], requesterHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const id = (res.body['indent'] as Row)['indent_id'] as string;
    const lineId = (res.body['lines'] as Row[])[0]!['indent_line_id'];
    const wrong = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [lineId] },
      await authFor(port, `fin-49-${run}@example.com`),
    );
    assert.strictEqual(wrong.body['error_code'], 'NOT_RESOLVED_APPROVER');
    const ok = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${id}/approve`,
      { line_ids: [lineId] },
      hodHeaders,
    );
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((ok.body['indent'] as Row)['status'], 'approved');
  });

  it('FALLBACK_REFUSES_SELF: a department_head raising an unmatched indent is refused (no self-approval)', async () => {
    const res = await raise([line(`SKU-49-SOD-${run}`, 1, 500)], hodHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INDENT_APPROVAL_BAND_MISSING');
  });

  it('edge door parity: falls back identically and ignores a client fallback_reason', async () => {
    const id = randomUUID();
    const forged = {
      ...line(`SKU-49-EDGE-${run}`, 1, 500),
      fallback_reason: 'forged',
      approver_actor_id: randomUUID(),
    };
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeBody(id, [forged], `edge-49-ok-${run}`),
      requesterHeaders,
    );
    assert.ok(res.status < 300, JSON.stringify(res.body));
    const rows = (
      await getPool().query(
        `SELECT approver_actor_id, fallback_reason, doa_entry_id FROM indent_line WHERE indent_id = $1`,
        [id],
      )
    ).rows;
    assert.deepStrictEqual(rows, [
      { approver_actor_id: hodId, fallback_reason: 'no_band_match', doa_entry_id: null },
    ]);
  });

  it('regression: no persisted pending doa line lacks an approver after any raise', async () => {
    const r = await getPool().query(
      `SELECT count(*)::int AS n FROM indent_line
       WHERE line_status = 'pending' AND approval_route = 'doa' AND approver_actor_id IS NULL`,
    );
    assert.strictEqual(r.rows[0]!['n'], 0);
  });

  it('STUCK_LEGACY: report changes nothing; apply routes via fallback and audits; no HOD is an exception', async () => {
    const res = await raise([line(`SKU-49-STUCK-${run}`, 1, 500)], requesterHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const id = (res.body['indent'] as Row)['indent_id'] as string;
    const lineId = (res.body['lines'] as Row[])[0]!['indent_line_id'] as string;
    const admin = getAdminPool();
    // Simulate a pre-4.9 row: no approver, no fallback marker.
    await admin.query(
      `UPDATE indent_line SET approver_actor_id = NULL, fallback_reason = NULL WHERE indent_line_id = $1`,
      [lineId],
    );
    await admin.query(`UPDATE indent SET approver_actor_id = NULL WHERE indent_id = $1`, [id]);

    const report = await reresolveStuckIndents(getPool(), { apply: false });
    assert.deepStrictEqual(
      report.stuck.map((s) => s.indent_line_id),
      [lineId],
    );
    assert.strictEqual(report.fixed.length, 0);
    const still = await getPool().query(
      `SELECT approver_actor_id FROM indent_line WHERE indent_line_id = $1`,
      [lineId],
    );
    assert.strictEqual(still.rows[0]!['approver_actor_id'], null, 'report mode changes nothing');

    await admin.query(`UPDATE users SET active = false WHERE user_id = $1`, [hodId]);
    try {
      const noHod = await reresolveStuckIndents(getPool(), { apply: true });
      assert.strictEqual(noHod.fixed.length, 0);
      assert.strictEqual(noHod.exceptions.length, 1);
      assert.strictEqual(noHod.exceptions[0]!.error_code, 'INDENT_APPROVAL_BAND_MISSING');
    } finally {
      await admin.query(`UPDATE users SET active = true WHERE user_id = $1`, [hodId]);
    }

    const applied = await reresolveStuckIndents(getPool(), { apply: true });
    assert.strictEqual(applied.fixed.length, 1);
    assert.strictEqual(applied.exceptions.length, 0);
    const after = await getPool().query(
      `SELECT approver_actor_id, fallback_reason FROM indent_line WHERE indent_line_id = $1`,
      [lineId],
    );
    assert.deepStrictEqual(after.rows[0], {
      approver_actor_id: hodId,
      fallback_reason: 'no_band_match',
    });
    const hdr = await getPool().query(`SELECT approver_actor_id FROM indent WHERE indent_id = $1`, [
      id,
    ]);
    assert.strictEqual(hdr.rows[0]!['approver_actor_id'], hodId);
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE endpoint = 'cli:reresolve-stuck-indents' AND details->>'indent_line_id' = $1`,
      [lineId],
    );
    assert.strictEqual(audit.rows[0]!['n'], 1);
    assert.strictEqual((await reresolveStuckIndents(getPool(), { apply: false })).stuck.length, 0);
  });
});

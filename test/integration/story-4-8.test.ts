import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { runStandingGrantSweepCycle } from '../../src/notify/standing-grant-sweep.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.8: standing approvals and self-approval limits. Runs against the production router
// (createAppRouter) with real auth, RBAC, DOA registry authority, the Story 4.10 per-line routing,
// the Story 4.11 stores issue and PostgreSQL. Roles and DOA entries are suffixed per run (the
// story-4-10 pattern) so seeds never collide.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;
const daysAhead = (n: number): string =>
  new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);

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
        host: '127.0.0.1',
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
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (raw += chunk));
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { raw };
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

describe('Story 4.8 standing approvals and self-approval limits', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const binA = randomUUID();
  const ROLE_SITE_HEAD = `site_head_48_${run}`;
  const ROLE_DEPT_HEAD = `department_head_48_${run}`;
  const ROLE_FINANCE = `finance_controller_48_${run}`;

  let requesterId: string;
  let requesterHeaders: Record<string, string>;
  let bystanderId: string;
  let bystanderHeaders: Record<string, string>;
  let siteHeadId: string;
  let siteHeadHeaders: Record<string, string>;
  let deptHeadId: string;
  let deptHeadHeaders: Record<string, string>;
  let financeId: string;
  let financeHeaders: Record<string, string>;
  let dualHeaders: Record<string, string>;
  let storeId: string;
  let storeHeaders: Record<string, string>;
  let doaHeaders: Record<string, string>;

  const write = (role: string, module: string, locationId = '*'): Role => ({
    role,
    module,
    functionScope: 'write',
    locationId,
  });

  // Every response body the suite sees is scanned for the two phrases the voice table forbids.
  const seenBodies: string[] = [];
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResult> {
    const res = await makeRequest(port, method, path, body, headers);
    seenBodies.push(JSON.stringify(res.body));
    return res;
  }

  let skuSeq = 0;
  /** A fresh active SKU per scenario so grants and caps never bleed between tests. */
  async function newSku(prefix: string, itemGroupId: string | null = null): Promise<string> {
    skuSeq += 1;
    const sku = `${prefix}-48-${run}-${skuSeq}`;
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status, item_group_id)
       VALUES ($1, 'EA', false, false, 'fifo', 'production', 'active', $2)`,
      [sku, itemGroupId],
    );
    return sku;
  }

  async function newGroup(status = 'active'): Promise<{ id: string; code: string; name: string }> {
    skuSeq += 1;
    const code = `G48-${run}-${skuSeq}`.toUpperCase();
    const name = `Cleaning gear ${run} ${skuSeq}`;
    const r = await getPool().query(
      `INSERT INTO item_group (code, name, status) VALUES ($1, $2, $3) RETURNING item_group_id`,
      [code, name, status],
    );
    return { id: (r.rows[0] as Row)['item_group_id'] as string, code, name };
  }

  function line(sku: string, qty: number, price: number | null = 10): Row {
    return {
      sku,
      item_category: 'consumable',
      requested_qty: qty,
      uom: 'EA',
      ...(price === null ? {} : { unit_price_estimate: price }),
    };
  }

  function raiseBody(lines: Row[]): Row {
    return {
      department_code: 'MAINT',
      site_id: siteA,
      business_stream: 'production',
      need_by_date: '2026-12-01',
      urgent: false,
      reason: 'Standing approval',
      confirm_duplicate: true,
      lines,
    };
  }

  async function raise(
    lines: Row[],
    headers: Record<string, string> = requesterHeaders,
  ): Promise<{ indent: Row; lines: Row[] }> {
    const res = await call('POST', '/api/v1/indents', raiseBody(lines), headers);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { indent: res.body['indent'] as Row, lines: res.body['lines'] as Row[] };
  }

  async function assign(body: Row, headers: Record<string, string> = siteHeadHeaders) {
    return call('POST', '/api/v1/standing-grants', { site_id: siteA, ...body }, headers);
  }

  async function financeApprove(
    grantId: string,
    headers: Record<string, string> = financeHeaders,
  ): Promise<HttpResult> {
    return call('POST', `/api/v1/standing-grants/${grantId}/finance-approve`, {}, headers);
  }

  async function activeGrant(body: Row, headers: Record<string, string> = siteHeadHeaders) {
    const created = await assign(body, headers);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const grant = created.body['grant'] as Row;
    const approved = await financeApprove(grant['grant_id'] as string);
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    return approved.body['grant'] as Row;
  }

  function saBody(sku: string, extra: Row = {}): Row {
    return {
      grant_kind: 'standing_approval',
      grantee_user_id: requesterId,
      scope_sku: sku,
      ...extra,
    };
  }

  async function receive(sku: string, quantity: number): Promise<void> {
    await persistEvent({
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: 'stock.received',
      payload: {
        business_stream: 'production',
        sku,
        target_location_id: binA,
        quantity,
        unit_cost: 2,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: storeId, role: 'store_assistant', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    });
  }

  function issueLine(indentLineId: string, quantity: string | number): Row {
    return { indent_line_id: indentLineId, quantity, location_id: binA };
  }

  async function issue(indentId: string, lines: Row[]): Promise<HttpResult> {
    return call('POST', `/api/v1/indents/${indentId}/issue`, { lines }, storeHeaders);
  }

  async function lineRow(lineId: string): Promise<Row> {
    return (await getPool().query(`SELECT * FROM indent_line WHERE indent_line_id = $1`, [lineId]))
      .rows[0] as Row;
  }

  async function grantRow(grantId: string): Promise<Row> {
    return (await getPool().query(`SELECT * FROM standing_grant WHERE grant_id = $1`, [grantId]))
      .rows[0] as Row;
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
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
      '../../read/projections/indent_issue.sql',
      '../../read/projections/standing_grant.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE standing_grant_prune_setting, standing_grant, indent_issue_line, indent_issue, indent_line, indent, lot_trace, serial_master, lot_master, stock_balance, item_master, item_group, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    const pool = getPool();
    await pool.query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'site', NULL, $1, 'general', 'ambient', 'active')`,
      [siteA, `SITE-A-${run}`],
    );
    await pool.query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'bin', $3, $3, 'general', 'ambient', 'active')`,
      [binA, `BIN-A-${run}`, siteA],
    );

    // The department head is provisioned before the dual-hat user so findRoleHolder (oldest
    // holder) resolves indent approval to the dedicated head.
    deptHeadId = await provisionUser(port, `dh-48-${run}@example.com`, [
      write(ROLE_DEPT_HEAD, 'procurement'),
    ]);
    deptHeadHeaders = await authFor(port, `dh-48-${run}@example.com`);
    financeId = await provisionUser(port, `fin-48-${run}@example.com`, [
      write(ROLE_FINANCE, 'procurement'),
    ]);
    financeHeaders = await authFor(port, `fin-48-${run}@example.com`);
    await provisionUser(port, `dual-48-${run}@example.com`, [
      write(ROLE_DEPT_HEAD, 'procurement'),
      write(ROLE_FINANCE, 'procurement'),
    ]);
    dualHeaders = await authFor(port, `dual-48-${run}@example.com`);
    siteHeadId = await provisionUser(port, `sh-48-${run}@example.com`, [
      write(ROLE_SITE_HEAD, 'procurement', siteA),
      write(ROLE_SITE_HEAD, 'notification', siteA),
    ]);
    siteHeadHeaders = await authFor(port, `sh-48-${run}@example.com`);
    requesterId = await provisionUser(port, `req-48-${run}@example.com`, [
      write('floor_supervisor', 'procurement', siteA),
    ]);
    requesterHeaders = await authFor(port, `req-48-${run}@example.com`);
    bystanderId = await provisionUser(port, `by-48-${run}@example.com`, [
      write('floor_supervisor', 'procurement', siteA),
    ]);
    bystanderHeaders = await authFor(port, `by-48-${run}@example.com`);
    storeId = await provisionUser(port, `store-48-${run}@example.com`, [
      write('store_assistant', 'warehouse', siteA),
    ]);
    storeHeaders = await authFor(port, `store-48-${run}@example.com`);

    await provisionUser(port, `doa-48-${run}@example.com`, [
      write('compliance_admin_48', 'compliance'),
    ]);
    doaHeaders = await authFor(port, `doa-48-${run}@example.com`);
    for (const entry of [
      {
        transaction_type: 'indent_approval',
        role: ROLE_DEPT_HEAD,
        value_min: null,
        value_max: null,
      },
      { transaction_type: 'standing_grant_assign', role: ROLE_SITE_HEAD },
      { transaction_type: 'standing_grant_assign', role: ROLE_DEPT_HEAD },
      { transaction_type: 'standing_grant_finance', role: ROLE_FINANCE },
    ]) {
      const band = await makeRequest(port, 'POST', '/api/v1/doa/entries', entry, doaHeaders);
      assert.strictEqual(band.status, 201, JSON.stringify(band.body));
    }
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 1: assign, finance sign-off once -------------------------------------------------------

  describe('AC1 assign a standing approval', () => {
    it('a site head and a head of department assign; the grant is pending and inert until finance approves once', async () => {
      const sku = await newSku('ASSIGN');
      const bySiteHead = await assign(saBody(sku, { monthly_qty_cap: 6, end_date: daysAhead(30) }));
      assert.strictEqual(bySiteHead.status, 201, JSON.stringify(bySiteHead.body));
      const grant = bySiteHead.body['grant'] as Row;
      assert.match(grant['grant_ref'] as string, /^SA-\d{4}-\d{3,}$/);
      assert.strictEqual(grant['status'], 'pending-finance');
      assert.strictEqual(grant['assigner_user_id'], siteHeadId);
      assert.strictEqual(grant['monthly_qty_cap'], '6.000');
      assert.strictEqual(grant['scope_sku'], sku);

      const byDeptHead = await assign(saBody(await newSku('ASSIGN')), deptHeadHeaders);
      assert.strictEqual(byDeptHead.status, 201, JSON.stringify(byDeptHead.body));

      // Pending: the covered line still goes to the DOA approver (no effect before finance signs).
      const raised = await raise([line(sku, 2)]);
      assert.strictEqual(raised.lines[0]!['approval_route'], 'doa');
      assert.strictEqual(raised.lines[0]!['line_status'], 'pending');

      const approved = await financeApprove(grant['grant_id'] as string);
      assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
      const active = approved.body['grant'] as Row;
      assert.strictEqual(active['status'], 'active');
      assert.strictEqual(active['finance_approver_user_id'], financeId);
      assert.ok(active['finance_decided_at']);

      const again = await financeApprove(grant['grant_id'] as string);
      assert.strictEqual(again.status, 409);
      assert.strictEqual(again.body['error_code'], 'GRANT_NOT_PENDING');
    });

    it('someone without assign authority is refused GRANT_ASSIGNER_NOT_AUTHORIZED', async () => {
      const res = await assign(saBody(await newSku('NOAUTH')), bystanderHeaders);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'GRANT_ASSIGNER_NOT_AUTHORIZED');
    });

    it('a person cannot assign to themselves (D4)', async () => {
      const res = await assign(saBody(await newSku('SELF'), { grantee_user_id: siteHeadId }));
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'GRANT_SELF_ASSIGNMENT');
    });

    it('the finance approver is neither the assigner nor the grantee, and must hold the finance role (D4)', async () => {
      // The dual-hat user is a valid assigner (department head) and a valid finance approver, but
      // may not approve their own assignment.
      const created = await assign(saBody(await newSku('DUAL')), dualHeaders);
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const id = (created.body['grant'] as Row)['grant_id'] as string;
      const own = await financeApprove(id, dualHeaders);
      assert.strictEqual(own.status, 403, JSON.stringify(own.body));
      assert.strictEqual(own.body['error_code'], 'GRANT_FINANCE_NOT_RESOLVED');
      const wrongRole = await financeApprove(id, siteHeadHeaders);
      assert.strictEqual(wrongRole.status, 403);
      assert.strictEqual(wrongRole.body['error_code'], 'GRANT_FINANCE_NOT_RESOLVED');
      assert.strictEqual((await grantRow(id))['status'], 'pending-finance');
      const ok = await financeApprove(id, financeHeaders);
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    });

    it('finance authority is membership of the governing role at the site (a newer site holder is not outranked by the wildcard one), or the active delegate of the role holder', async () => {
      // findRoleHolder returns the OLDEST holder among the site's own and every-location holders
      // (Story 1.16 deferred note); authority here is membership, so ordering cannot lock out a
      // newer holder. A holder scoped to another site is no finance approver of this one.
      await provisionUser(port, `sitefin-48-${run}@example.com`, [
        write(ROLE_FINANCE, 'procurement', siteA),
      ]);
      const siteFinHeaders = await authFor(port, `sitefin-48-${run}@example.com`);
      await provisionUser(port, `otherfin-48-${run}@example.com`, [
        write(ROLE_FINANCE, 'procurement', randomUUID()),
      ]);
      const otherFinHeaders = await authFor(port, `otherfin-48-${run}@example.com`);
      await provisionUser(port, `deleg-48-${run}@example.com`, [
        write('floor_supervisor', 'procurement', siteA),
      ]);
      const delegateHeaders = await authFor(port, `deleg-48-${run}@example.com`);

      const mk = async (): Promise<string> => {
        const created = await assign(saBody(await newSku('FINAUTH')));
        assert.strictEqual(created.status, 201, JSON.stringify(created.body));
        return (created.body['grant'] as Row)['grant_id'] as string;
      };
      const [g1, g2] = [await mk(), await mk()];
      const elsewhere = await financeApprove(g1, otherFinHeaders);
      assert.strictEqual(elsewhere.status, 403, JSON.stringify(elsewhere.body));
      assert.strictEqual(elsewhere.body['error_code'], 'GRANT_FINANCE_NOT_RESOLVED');
      const sited = await financeApprove(g1, siteFinHeaders);
      assert.strictEqual(sited.status, 200, JSON.stringify(sited.body));

      const before = await financeApprove(g2, delegateHeaders);
      assert.strictEqual(before.status, 403, JSON.stringify(before.body));
      const delegation = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/delegations',
        {
          delegator_external_id: `fin-48-${run}@example.com`,
          delegate_external_id: `deleg-48-${run}@example.com`,
          start_date: daysAhead(-2),
          end_date: daysAhead(2),
        },
        doaHeaders,
      );
      assert.ok(delegation.status < 300, JSON.stringify(delegation.body));
      const delegated = await financeApprove(g2, delegateHeaders);
      assert.strictEqual(delegated.status, 200, JSON.stringify(delegated.body));
    });

    it('finance can reject with a reason; a rejection without one is a 400 and a rejected grant stays inert', async () => {
      const sku = await newSku('REJ');
      const created = await assign(saBody(sku));
      const id = (created.body['grant'] as Row)['grant_id'] as string;
      const noReason = await call(
        'POST',
        `/api/v1/standing-grants/${id}/finance-reject`,
        { reason: '  ' },
        financeHeaders,
      );
      assert.strictEqual(noReason.status, 400);
      const rejected = await call(
        'POST',
        `/api/v1/standing-grants/${id}/finance-reject`,
        { reason: 'not a repeat item' },
        financeHeaders,
      );
      assert.strictEqual(rejected.status, 200, JSON.stringify(rejected.body));
      assert.strictEqual((rejected.body['grant'] as Row)['status'], 'rejected');
      assert.strictEqual((await grantRow(id))['finance_rejection_reason'], 'not a repeat item');
      const late = await financeApprove(id);
      assert.strictEqual(late.status, 409);
      assert.strictEqual(late.body['error_code'], 'GRANT_NOT_PENDING');
      const raised = await raise([line(sku, 1)]);
      assert.strictEqual(raised.lines[0]!['approval_route'], 'doa');
    });

    it('refuses an invalid scope: neither or both targets, an inactive item group, an unknown SKU, a bad cap or a past end date', async () => {
      const group = await newGroup('inactive');
      const sku = await newSku('SCOPE');
      const cases: Array<[string, Row, number, string]> = [
        [
          'no scope',
          { grant_kind: 'standing_approval', grantee_user_id: requesterId },
          400,
          'GRANT_SCOPE_INVALID',
        ],
        ['both scopes', saBody(sku, { scope_item_group_id: group.id }), 400, 'GRANT_SCOPE_INVALID'],
        [
          'inactive group',
          {
            grant_kind: 'standing_approval',
            grantee_user_id: requesterId,
            scope_item_group_id: group.id,
          },
          400,
          'GRANT_SCOPE_INVALID',
        ],
        ['unknown sku', saBody(`NOPE-${run}`), 400, 'GRANT_SCOPE_INVALID'],
        ['zero cap', saBody(sku, { monthly_qty_cap: 0 }), 400, 'INVALID_PARAMS'],
        ['past end date', saBody(sku, { end_date: daysAhead(-1) }), 400, 'INVALID_PARAMS'],
        [
          'unknown grantee',
          saBody(sku, { grantee_user_id: randomUUID() }),
          409,
          'GRANT_GRANTEE_INVALID',
        ],
      ];
      for (const [name, body, status, code] of cases) {
        const res = await assign(body);
        assert.strictEqual(res.status, status, `${name}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body['error_code'], code, name);
      }
    });

    it('a grant can name an item group by code, and lists show assigned, held and pending views', async () => {
      const group = await newGroup();
      const created = await assign({
        grant_kind: 'standing_approval',
        grantee_user_id: requesterId,
        scope_item_group_code: group.code,
      });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const id = (created.body['grant'] as Row)['grant_id'] as string;
      assert.strictEqual((created.body['grant'] as Row)['scope_label'], group.name);

      const pending = await call(
        'GET',
        '/api/v1/standing-grants?pending_finance=me',
        undefined,
        financeHeaders,
      );
      assert.strictEqual(pending.status, 200, JSON.stringify(pending.body));
      assert.ok((pending.body['grants'] as Row[]).some((g) => g['grant_id'] === id));
      const notForAssigner = await call(
        'GET',
        '/api/v1/standing-grants?pending_finance=me',
        undefined,
        siteHeadHeaders,
      );
      assert.ok(!(notForAssigner.body['grants'] as Row[]).some((g) => g['grant_id'] === id));

      const assigned = await call(
        'GET',
        '/api/v1/standing-grants?assigned_by=me',
        undefined,
        siteHeadHeaders,
      );
      assert.ok((assigned.body['grants'] as Row[]).some((g) => g['grant_id'] === id));
      const held = await call(
        'GET',
        '/api/v1/standing-grants?held_by=me',
        undefined,
        requesterHeaders,
      );
      assert.ok((held.body['grants'] as Row[]).some((g) => g['grant_id'] === id));
      const none = await call('GET', '/api/v1/standing-grants', undefined, requesterHeaders);
      assert.strictEqual(none.status, 400);

      const detail = await call(
        'GET',
        `/api/v1/standing-grants/${id}`,
        undefined,
        requesterHeaders,
      );
      assert.strictEqual(detail.status, 200);
      // A procurement reader of another site is neither party, nor finance, nor reads this site.
      await provisionUser(port, `elsewhere-48-${run}@example.com`, [
        write('floor_supervisor', 'procurement', randomUUID()),
      ]);
      const stranger = await call(
        'GET',
        `/api/v1/standing-grants/${id}`,
        undefined,
        await authFor(port, `elsewhere-48-${run}@example.com`),
      );
      assert.strictEqual(stranger.status, 403, JSON.stringify(stranger.body));
    });

    it('standing_grant events are not accepted through the events door (D11)', async () => {
      const grantId = randomUUID();
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          event_id: randomUUID(),
          stream_type: 'standing_grant',
          stream_id: grantId,
          event_type: 'standing_grant.assigned',
          payload: { grant_id: grantId },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: siteHeadId, role: ROLE_SITE_HEAD, location_id: siteA },
            occurred_at: new Date().toISOString(),
          },
        },
        siteHeadHeaders,
      );
      // No role holds a standing_grant module, so the door's own RBAC answers first; a wildcard
      // caller that passed it would meet INVALID_EVENT_STREAM. Either way nothing is persisted.
      assert.ok([400, 403].includes(res.status), JSON.stringify(res.body));
      const persisted = await getPool().query(`SELECT 1 FROM domain_events WHERE stream_id = $1`, [
        grantId,
      ]);
      assert.strictEqual(persisted.rows.length, 0);
    });
  });

  // --- AC 2: ride the grant, per line ------------------------------------------------------------

  describe('AC2 ride the grant', () => {
    it('a covered line goes straight to stores with no approver, and the screen and slip say which grant', async () => {
      const sku = await newSku('RIDE');
      await receive(sku, 50);
      const grant = await activeGrant(saBody(sku, { monthly_qty_cap: 6 }));
      const ref = grant['grant_ref'] as string;

      const raised = await raise([line(sku, 4)]);
      const l = raised.lines[0]!;
      assert.strictEqual(l['approval_route'], 'standing_approval');
      assert.strictEqual(l['line_status'], 'approved');
      assert.strictEqual(l['approver_actor_id'], null);
      assert.strictEqual(l['decided_by'], 'system');
      assert.strictEqual(l['standing_grant_id'], grant['grant_id']);
      assert.strictEqual(l['standing_grant_ref'], ref);
      assert.strictEqual(l['cap'], '6.000');
      assert.strictEqual(l['month_to_date_issued'], '0.000');
      assert.strictEqual(raised.indent['status'], 'approved');

      // The raise audits the system approval (deferred from Story 4.10) and tells stores.
      const audit = await getPool().query(
        `SELECT details FROM audit_log WHERE error_code = 'indent.line_standing_approved' AND details->>'indent_line_id' = $1`,
        [l['indent_line_id']],
      );
      assert.strictEqual(audit.rows.length, 1);
      assert.strictEqual((audit.rows[0]!['details'] as Row)['standing_grant_ref'], ref);
      const note = await getPool().query(
        `SELECT payload->>'next_step' AS next_step FROM domain_events
         WHERE stream_type = 'notification' AND payload->>'object_id' = $1 AND payload->>'event_type' = 'indent_issue_pending'`,
        [raised.indent['indent_id']],
      );
      assert.strictEqual(note.rows.length, 1);
      assert.ok((note.rows[0]!['next_step'] as string).includes(ref));

      const issued = await issue(raised.indent['indent_id'] as string, [
        issueLine(l['indent_line_id'] as string, 3),
      ]);
      assert.strictEqual(issued.status, 201, JSON.stringify(issued.body));
      const expected = `Standing approval ${ref} for req-48-${run}@example.com (${sku}). Storekeeper please issue.`;
      assert.deepStrictEqual(issued.body['standing_approval_texts'], [expected]);
      const slip = issued.body['slip_text'] as string;
      assert.ok(slip.includes(`Basis: ${expected}`), slip);
      assert.ok(!slip.includes('No approval required'), slip);
      const [issueLineRow] = (issued.body['issue'] as Row)['lines'] as Row[];
      assert.strictEqual(issueLineRow!['standing_grant_id'], grant['grant_id']);
      assert.strictEqual(issueLineRow!['standing_approval_text'], expected);

      // The usage reads back on the line and on the grant.
      const got = await call(
        'GET',
        `/api/v1/indents/${raised.indent['indent_id'] as string}`,
        undefined,
        requesterHeaders,
      );
      const gotLine = (got.body['lines'] as Row[])[0]!;
      assert.strictEqual(gotLine['month_to_date_issued'], '3.000');
      assert.strictEqual(gotLine['standing_approval_text'], expected);
      const detail = await call(
        'GET',
        `/api/v1/standing-grants/${grant['grant_id'] as string}`,
        undefined,
        siteHeadHeaders,
      );
      const usage = detail.body['usage'] as Row;
      assert.strictEqual(usage['month_to_date_issued'], '3.000');
      assert.strictEqual(usage['cap'], '6.000');
      assert.ok(usage['last_used_at']);
    });

    it('a grant on an item group covers every item in the group; a different person is not covered', async () => {
      const group = await newGroup();
      const inGroup = await newSku('GRP', group.id);
      const outside = await newSku('GRP');
      const grant = await activeGrant({
        grant_kind: 'standing_approval',
        grantee_user_id: requesterId,
        scope_item_group_id: group.id,
      });
      const raised = await raise([line(inGroup, 1), line(outside, 1)]);
      assert.deepStrictEqual(
        raised.lines.map((l) => [l['approval_route'], l['line_status']]),
        [
          ['standing_approval', 'approved'],
          ['doa', 'pending'],
        ],
      );
      assert.strictEqual(raised.lines[0]!['standing_grant_id'], grant['grant_id']);
      assert.ok(
        (raised.lines[0]!['standing_approval_text'] as string).includes(`(${group.name})`),
        'the sentence names the item group',
      );
      // Per person: the same item raised by someone else takes the DOA route.
      const other = await raise([line(inGroup, 1)], bystanderHeaders);
      assert.strictEqual(other.lines[0]!['approval_route'], 'doa');
    });

    it('the grant id comes from the server: a forged route or grant id on the HTTP raise and the events door is ignored', async () => {
      const sku = await newSku('FORGE');
      const other = await newSku('FORGE');
      const grant = await activeGrant(saBody(sku));
      const forged = await call(
        'POST',
        '/api/v1/indents',
        raiseBody([
          {
            ...line(other, 1),
            approval_route: 'standing_approval',
            standing_grant_id: grant['grant_id'],
          },
        ]),
        requesterHeaders,
      );
      assert.strictEqual(forged.status, 201, JSON.stringify(forged.body));
      const forgedLine = (forged.body['lines'] as Row[])[0]!;
      assert.strictEqual(forgedLine['approval_route'], 'doa');
      assert.strictEqual(forgedLine['line_status'], 'pending');

      const indentId = randomUUID();
      const door = await makeRequest(
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
            lines: [
              {
                ...line(other, 1),
                approval_route: 'standing_approval',
                standing_grant_id: grant['grant_id'],
              },
            ],
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: requesterId, role: 'floor_supervisor', location_id: siteA },
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: `ev-48-forge-${run}`,
        },
        requesterHeaders,
      );
      assert.ok(door.status < 300, JSON.stringify(door.body));
      const rows = (
        await getPool().query(
          `SELECT approval_route, line_status, standing_grant_id FROM indent_line WHERE indent_id = $1`,
          [indentId],
        )
      ).rows;
      assert.deepStrictEqual(rows, [
        { approval_route: 'doa', line_status: 'pending', standing_grant_id: null },
      ]);
    });

    it('an offline (edge) raise rides the grant too, decided on the server when it syncs; the edge cannot send grant events', async () => {
      const sku = await newSku('EDGE');
      const other = await newSku('EDGE');
      const grant = await activeGrant(saBody(sku));
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
            duplicate_confirmed: true,
            // The device claims a grant for the uncovered line; the server ignores it.
            lines: [
              line(sku, 1, 10),
              { ...line(other, 1, 10), standing_grant_id: grant['grant_id'] },
            ],
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: requesterId, role: 'floor_supervisor', location_id: siteA },
            device_id: `EDGE-48-${run}`,
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: `edge-48-${run}`,
        },
        requesterHeaders,
      );
      assert.ok(edge.status < 300, JSON.stringify(edge.body));
      const rows = (
        await getPool().query(
          `SELECT sku, approval_route, line_status, standing_grant_id FROM indent_line WHERE indent_id = $1 ORDER BY line_no`,
          [indentId],
        )
      ).rows;
      assert.deepStrictEqual(
        rows.map((r) => [r['approval_route'], r['line_status'], r['standing_grant_id']]),
        [
          ['standing_approval', 'approved', grant['grant_id']],
          ['doa', 'pending', null],
        ],
      );

      const grantId = randomUUID();
      const refused = await makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          event_id: randomUUID(),
          stream_type: 'standing_grant',
          stream_id: grantId,
          event_type: 'standing_grant.revoked',
          payload: { grant_id: grant['grant_id'], revoke_reason: 'assigner' },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: siteHeadId, role: ROLE_SITE_HEAD, location_id: siteA },
            device_id: `EDGE-48-${run}`,
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: `edge-48-grant-${run}`,
        },
        siteHeadHeaders,
      );
      // No role holds a standing_grant module, so the door's RBAC answers first; a wildcard caller
      // would meet CENTRAL_ONLY_OPERATION. Either way the grant is untouched.
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.ok(
        ['MODULE_ACCESS_DENIED', 'CENTRAL_ONLY_OPERATION'].includes(
          refused.body['error_code'] as string,
        ),
        JSON.stringify(refused.body),
      );
      assert.strictEqual((await grantRow(grant['grant_id'] as string))['status'], 'active');
    });

    it('the seam refuses a standing_approval line that names no covering active grant', async () => {
      const sku = await newSku('SEAM');
      const indentId = randomUUID();
      await assert.rejects(
        persistEvent({
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
            lines: [
              {
                ...line(sku, 1),
                approval_route: 'standing_approval',
                standing_grant_id: randomUUID(),
              },
            ],
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: requesterId, role: 'floor_supervisor', location_id: siteA },
            occurred_at: new Date().toISOString(),
          },
        }),
        (err: unknown) => (err as { errorCode?: string }).errorCode === 'STANDING_APPROVAL_LAPSED',
      );
    });
  });

  // --- AC 3: fallback, never reject ----------------------------------------------------------------

  describe('AC3 fallback to the normal approval path', () => {
    it('a mixed requisition keeps one document: the covered line to stores, the uncovered line to the DOA approver', async () => {
      const covered = await newSku('MIX');
      const uncovered = await newSku('MIX');
      await activeGrant(saBody(covered));
      const raised = await raise([line(covered, 1), line(uncovered, 1)]);
      assert.deepStrictEqual(
        raised.lines.map((l) => [l['approval_route'], l['line_status'], l['approver_actor_id']]),
        [
          ['standing_approval', 'approved', null],
          ['doa', 'pending', deptHeadId],
        ],
      );
      assert.strictEqual(raised.indent['status'], 'raised');
      const count = await getPool().query(
        `SELECT count(*)::int AS n FROM indent WHERE indent_id = $1`,
        [raised.indent['indent_id']],
      );
      assert.strictEqual((count.rows[0] as Row)['n'], 1);
    });

    it('a line over the remaining monthly cap at raise takes the DOA route, never a rejection', async () => {
      const sku = await newSku('CAPRAISE');
      await activeGrant(saBody(sku, { monthly_qty_cap: 5 }));
      const raised = await raise([line(sku, 6)]);
      assert.strictEqual(raised.lines[0]!['approval_route'], 'doa');
      assert.strictEqual(raised.lines[0]!['line_status'], 'pending');
      // Two lines of one requisition share the cap: the first rides, the second falls back.
      const split = await raise([line(sku, 3), line(sku, 3)]);
      assert.deepStrictEqual(
        split.lines.map((l) => l['approval_route']),
        ['standing_approval', 'doa'],
      );
    });

    it('an issue that would pass the cap is refused 409 STANDING_APPROVAL_LAPSED and the line is re-routed, not rejected; reaching the cap exactly is allowed', async () => {
      const sku = await newSku('CAPISSUE');
      await receive(sku, 100);
      await activeGrant(saBody(sku, { monthly_qty_cap: 6 }));
      // Both lines ride at raise: nothing has been issued yet, so each fits the cap on its own.
      const a = await raise([line(sku, 4)]);
      const b = await raise([line(sku, 4)]);
      const c = await raise([line(sku, 2)]);
      for (const r of [a, b, c])
        assert.strictEqual(r.lines[0]!['approval_route'], 'standing_approval');

      assert.strictEqual(
        (
          await issue(a.indent['indent_id'] as string, [
            issueLine(a.lines[0]!['indent_line_id'] as string, 4),
          ])
        ).status,
        201,
      );
      const over = await issue(b.indent['indent_id'] as string, [
        issueLine(b.lines[0]!['indent_line_id'] as string, 4),
      ]);
      assert.strictEqual(over.status, 409, JSON.stringify(over.body));
      assert.strictEqual(over.body['error_code'], 'STANDING_APPROVAL_LAPSED');
      const details = over.body['details'] as Row;
      assert.deepStrictEqual(details['rerouted_lines'], [b.lines[0]!['indent_line_id']]);
      assert.strictEqual((details['lapsed_lines'] as Row[])[0]!['reason'], 'monthly_cap_exceeded');

      // Re-routed to the DOA approver, pending, nothing issued, never rejected.
      const rerouted = await lineRow(b.lines[0]!['indent_line_id'] as string);
      assert.strictEqual(rerouted['approval_route'], 'doa');
      assert.strictEqual(rerouted['line_status'], 'pending');
      assert.strictEqual(rerouted['approver_actor_id'], deptHeadId);
      assert.strictEqual(rerouted['issued_qty'], '0.000');
      assert.strictEqual(rerouted['rejection_reason'], null);
      const header = await getPool().query(`SELECT status FROM indent WHERE indent_id = $1`, [
        b.indent['indent_id'],
      ]);
      assert.strictEqual((header.rows[0] as Row)['status'], 'raised');
      const reroutedAudit = await getPool().query(
        `SELECT 1 FROM audit_log WHERE error_code = 'indent.line_rerouted' AND details->>'indent_line_id' = $1`,
        [b.lines[0]!['indent_line_id']],
      );
      assert.strictEqual(reroutedAudit.rows.length, 1);

      // The DOA approver now decides it, and stores issues on the DOA basis.
      const decided = await call(
        'POST',
        `/api/v1/indents/${b.indent['indent_id'] as string}/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(decided.status, 200, JSON.stringify(decided.body));
      const viaDoa = await issue(b.indent['indent_id'] as string, [
        issueLine(b.lines[0]!['indent_line_id'] as string, 4),
      ]);
      assert.strictEqual(viaDoa.status, 201, JSON.stringify(viaDoa.body));
      assert.match(viaDoa.body['slip_text'] as string, /Basis: Approved by /);
      assert.deepStrictEqual(viaDoa.body['standing_approval_texts'], []);

      // 4 + 2 = 6 reaches the cap exactly; the DOA-routed line above did not count against it.
      const exact = await issue(c.indent['indent_id'] as string, [
        issueLine(c.lines[0]!['indent_line_id'] as string, 2),
      ]);
      assert.strictEqual(exact.status, 201, JSON.stringify(exact.body));
      assert.deepStrictEqual((exact.body['standing_approval_texts'] as string[]).length, 1);
    });

    it('a partial issue within the cap goes through; the remainder falls back and keeps what already left the store', async () => {
      const sku = await newSku('PARTIAL');
      await receive(sku, 100);
      await activeGrant(saBody(sku, { monthly_qty_cap: 6 }));
      const first = await raise([line(sku, 3)]);
      const second = await raise([line(sku, 5)]);
      assert.strictEqual(second.lines[0]!['approval_route'], 'standing_approval');
      assert.strictEqual(
        (
          await issue(first.indent['indent_id'] as string, [
            issueLine(first.lines[0]!['indent_line_id'] as string, 3),
          ])
        ).status,
        201,
      );
      // 3 used; 3 of the 5 fit the cap exactly.
      const within = await issue(second.indent['indent_id'] as string, [
        issueLine(second.lines[0]!['indent_line_id'] as string, 3),
      ]);
      assert.strictEqual(within.status, 201, JSON.stringify(within.body));
      // The remaining 2 would reach 8 of 6: refused and re-routed.
      const rest = await issue(second.indent['indent_id'] as string, [
        issueLine(second.lines[0]!['indent_line_id'] as string, 2),
      ]);
      assert.strictEqual(rest.status, 409, JSON.stringify(rest.body));
      assert.strictEqual(rest.body['error_code'], 'STANDING_APPROVAL_LAPSED');
      const after = await lineRow(second.lines[0]!['indent_line_id'] as string);
      assert.strictEqual(after['approval_route'], 'doa');
      assert.strictEqual(after['line_status'], 'pending');
      assert.strictEqual(after['issued_qty'], '3.000');
      assert.strictEqual(after['issue_state'], 'open');
    });

    it('a revoked grant or one past its end date falls back at issue, and a new raise no longer rides it', async () => {
      const revokedSku = await newSku('REVOKED');
      const endedSku = await newSku('ENDED');
      await receive(revokedSku, 20);
      await receive(endedSku, 20);
      const revokedGrant = await activeGrant(saBody(revokedSku));
      const endedGrant = await activeGrant(saBody(endedSku, { end_date: daysAhead(5) }));
      const r1 = await raise([line(revokedSku, 1)]);
      const r2 = await raise([line(endedSku, 1)]);

      const revoke = await call(
        'POST',
        `/api/v1/standing-grants/${revokedGrant['grant_id'] as string}/revoke`,
        {},
        siteHeadHeaders,
      );
      assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
      await getPool().query(`UPDATE standing_grant SET end_date = $2::date WHERE grant_id = $1`, [
        endedGrant['grant_id'],
        daysAhead(-2),
      ]);

      const i1 = await issue(r1.indent['indent_id'] as string, [
        issueLine(r1.lines[0]!['indent_line_id'] as string, 1),
      ]);
      assert.strictEqual(i1.status, 409, JSON.stringify(i1.body));
      assert.strictEqual(i1.body['error_code'], 'STANDING_APPROVAL_LAPSED');
      assert.strictEqual(
        ((i1.body['details'] as Row)['lapsed_lines'] as Row[])[0]!['reason'],
        'grant_not_active',
      );
      const i2 = await issue(r2.indent['indent_id'] as string, [
        issueLine(r2.lines[0]!['indent_line_id'] as string, 1),
      ]);
      assert.strictEqual(i2.status, 409, JSON.stringify(i2.body));
      assert.strictEqual(
        ((i2.body['details'] as Row)['lapsed_lines'] as Row[])[0]!['reason'],
        'end_date_passed',
      );
      for (const r of [r1, r2]) {
        const l = await lineRow(r.lines[0]!['indent_line_id'] as string);
        assert.strictEqual(l['approval_route'], 'doa');
        assert.strictEqual(l['line_status'], 'pending');
      }
      for (const sku of [revokedSku, endedSku]) {
        const later = await raise([line(sku, 1)]);
        assert.strictEqual(later.lines[0]!['approval_route'], 'doa');
      }
    });
  });

  // --- AC 4: self-approval within a limit ------------------------------------------------------------

  describe('AC4 self-approval limit', () => {
    let limitHolderId: string;
    let limitHolderHeaders: Record<string, string>;
    let limitGrantId: string;

    before(async () => {
      limitHolderId = await provisionUser(port, `lim-48-${run}@example.com`, [
        write('floor_supervisor', 'procurement', siteA),
      ]);
      limitHolderHeaders = await authFor(port, `lim-48-${run}@example.com`);
      const grant = await activeGrant({
        grant_kind: 'self_approval_limit',
        grantee_user_id: limitHolderId,
        limit_amount: 500,
      });
      limitGrantId = grant['grant_id'] as string;
    });

    async function selfApprove(
      indentId: string,
      lineIds: string[],
      headers: Record<string, string> = limitHolderHeaders,
    ): Promise<HttpResult> {
      return call('POST', `/api/v1/indents/${indentId}/approve`, { line_ids: lineIds }, headers);
    }

    it('the requester approves their own line within the limit; the line and the audit entry record it', async () => {
      const sku = await newSku('SELFOK');
      const raised = await raise([line(sku, 10, 50)], limitHolderHeaders);
      const lineId = raised.lines[0]!['indent_line_id'] as string;
      assert.strictEqual(raised.lines[0]!['line_status'], 'pending');

      const res = await selfApprove(raised.indent['indent_id'] as string, [lineId]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const decided = (res.body['lines'] as Row[])[0]!;
      assert.strictEqual(decided['line_status'], 'approved');
      assert.strictEqual(decided['self_approved'], true);
      assert.strictEqual(decided['self_approval_grant_id'], limitGrantId);
      assert.strictEqual(decided['approval_route'], 'self_approval');
      assert.strictEqual(decided['decided_by'], limitHolderId);
      assert.strictEqual((res.body['indent'] as Row)['status'], 'approved');

      const audit = await getPool().query(
        `SELECT details FROM audit_log WHERE error_code = 'indent.line_approved' AND details->>'indent_line_id' = $1`,
        [lineId],
      );
      assert.strictEqual(audit.rows.length, 1);
      const d = audit.rows[0]!['details'] as Row;
      assert.strictEqual(d['self_approved'], true);
      assert.strictEqual(d['self_approval_grant_id'], limitGrantId);

      // Stores issues it; the slip says it was inside the limit.
      await receive(sku, 20);
      const issued = await issue(raised.indent['indent_id'] as string, [issueLine(lineId, 2)]);
      assert.strictEqual(issued.status, 201, JSON.stringify(issued.body));
      assert.match(issued.body['slip_text'] as string, /Basis: Within self-approval limit/);
    });

    it('one rupee over the limit is refused INDENT_RAISER_CANNOT_APPROVE and the DOA approver still decides', async () => {
      const sku = await newSku('SELFOVER');
      const raised = await raise([line(sku, 1, 501)], limitHolderHeaders);
      const lineId = raised.lines[0]!['indent_line_id'] as string;
      const res = await selfApprove(raised.indent['indent_id'] as string, [lineId]);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'INDENT_RAISER_CANNOT_APPROVE');
      assert.strictEqual((await lineRow(lineId))['line_status'], 'pending');
      const doa = await call(
        'POST',
        `/api/v1/indents/${raised.indent['indent_id'] as string}/approve`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(doa.status, 200, JSON.stringify(doa.body));
      const row = await lineRow(lineId);
      assert.strictEqual(row['self_approved'], false);
      assert.strictEqual(row['decided_by'], deptHeadId);
    });

    it('a self-reject is refused; a pending limit, a person without a limit and a revoked limit have no right', async () => {
      const sku = await newSku('SELFREJ');
      const raised = await raise([line(sku, 1, 10)], limitHolderHeaders);
      const lineId = raised.lines[0]!['indent_line_id'] as string;
      const rejected = await call(
        'POST',
        `/api/v1/indents/${raised.indent['indent_id'] as string}/reject`,
        { line_ids: [lineId], rejection_reason: 'changed my mind' },
        limitHolderHeaders,
      );
      assert.strictEqual(rejected.status, 403, JSON.stringify(rejected.body));
      assert.strictEqual(rejected.body['error_code'], 'INDENT_RAISER_CANNOT_APPROVE');

      // Pending limit: assigned, finance has not signed.
      const pendingId = await provisionUser(port, `pend-48-${run}@example.com`, [
        write('floor_supervisor', 'procurement', siteA),
      ]);
      const pendingHeaders = await authFor(port, `pend-48-${run}@example.com`);
      const pend = await assign({
        grant_kind: 'self_approval_limit',
        grantee_user_id: pendingId,
        limit_amount: 1000,
      });
      assert.strictEqual(pend.status, 201, JSON.stringify(pend.body));
      const p = await raise([line(await newSku('SELFPEND'), 1, 10)], pendingHeaders);
      const pRes = await call(
        'POST',
        `/api/v1/indents/${p.indent['indent_id'] as string}/approve`,
        { line_ids: [p.lines[0]!['indent_line_id']] },
        pendingHeaders,
      );
      assert.strictEqual(pRes.status, 403);
      assert.strictEqual(pRes.body['error_code'], 'INDENT_RAISER_CANNOT_APPROVE');

      // No limit at all.
      const n = await raise([line(await newSku('SELFNONE'), 1, 10)]);
      const nRes = await call(
        'POST',
        `/api/v1/indents/${n.indent['indent_id'] as string}/approve`,
        { line_ids: [n.lines[0]!['indent_line_id']] },
        requesterHeaders,
      );
      assert.strictEqual(nRes.status, 403);
      assert.strictEqual(nRes.body['error_code'], 'INDENT_RAISER_CANNOT_APPROVE');

      // Revoked limit.
      const revokedId = await provisionUser(port, `rvk-48-${run}@example.com`, [
        write('floor_supervisor', 'procurement', siteA),
      ]);
      const revokedHeaders = await authFor(port, `rvk-48-${run}@example.com`);
      const rg = await activeGrant({
        grant_kind: 'self_approval_limit',
        grantee_user_id: revokedId,
        limit_amount: 1000,
      });
      const rv = await raise([line(await newSku('SELFRVK'), 1, 10)], revokedHeaders);
      await call(
        'POST',
        `/api/v1/standing-grants/${rg['grant_id'] as string}/revoke`,
        {},
        siteHeadHeaders,
      );
      const rvRes = await call(
        'POST',
        `/api/v1/indents/${rv.indent['indent_id'] as string}/approve`,
        { line_ids: [rv.lines[0]!['indent_line_id']] },
        revokedHeaders,
      );
      assert.strictEqual(rvRes.status, 403);
    });

    it('the same rule holds when the approval arrives through the events door (edge upload follows the seam)', async () => {
      const sku = await newSku('SELFDOOR');
      const raised = await raise([line(sku, 10, 50), line(sku, 1, 501)], limitHolderHeaders);
      const [within, over] = raised.lines;
      const post = (lineIds: unknown[]) =>
        makeRequest(
          port,
          'POST',
          '/api/v1/events',
          {
            event_id: randomUUID(),
            stream_type: 'procurement',
            stream_id: raised.indent['indent_id'],
            event_type: 'indent.approved',
            payload: {
              indent_id: raised.indent['indent_id'],
              approver_actor_id: limitHolderId,
              line_ids: lineIds,
            },
            metadata: {
              correlation_id: randomUUID(),
              actor: { user_id: limitHolderId, role: 'floor_supervisor', location_id: siteA },
              occurred_at: new Date().toISOString(),
            },
            idempotency_key: `ev-48-${randomUUID()}`,
          },
          limitHolderHeaders,
        );
      const bad = await post([over!['indent_line_id']]);
      assert.strictEqual(bad.status, 403, JSON.stringify(bad.body));
      assert.strictEqual(bad.body['error_code'], 'INDENT_RAISER_CANNOT_APPROVE');
      const good = await post([within!['indent_line_id']]);
      assert.ok(good.status < 300, JSON.stringify(good.body));
      assert.strictEqual(
        (await lineRow(within!['indent_line_id'] as string))['self_approved'],
        true,
      );
    });

    it('estimated value shows on my requests only to a person holding a live limit', async () => {
      const sku = await newSku('SELFVIEW');
      await raise([line(sku, 2, 10)], limitHolderHeaders);
      await raise([line(sku, 2, 10)], bystanderHeaders);
      const holder = await call(
        'GET',
        '/api/v1/indents?mine=true&limit=50',
        undefined,
        limitHolderHeaders,
      );
      assert.strictEqual(holder.status, 200, JSON.stringify(holder.body));
      assert.ok((holder.body['indents'] as Row[]).length > 0);
      assert.ok((holder.body['indents'] as Row[]).every((i) => i['estimated_value'] !== null));
      const other = await call(
        'GET',
        '/api/v1/indents?mine=true&limit=50',
        undefined,
        bystanderHeaders,
      );
      assert.ok((other.body['indents'] as Row[]).length > 0);
      assert.ok((other.body['indents'] as Row[]).every((i) => i['estimated_value'] === null));
    });
  });

  // --- AC 5: revoke and auto-revoke --------------------------------------------------------------------

  describe('AC5 revoke and auto-revoke', () => {
    it('the assigner revokes alone and instantly; nobody else can; a revoked grant cannot be revoked again', async () => {
      const sku = await newSku('REVOKE');
      const grant = await activeGrant(saBody(sku));
      const id = grant['grant_id'] as string;
      const stranger = await call(
        'POST',
        `/api/v1/standing-grants/${id}/revoke`,
        {},
        deptHeadHeaders,
      );
      assert.strictEqual(stranger.status, 403, JSON.stringify(stranger.body));
      assert.strictEqual(stranger.body['error_code'], 'GRANT_ASSIGNER_NOT_AUTHORIZED');
      const grantee = await call(
        'POST',
        `/api/v1/standing-grants/${id}/revoke`,
        {},
        requesterHeaders,
      );
      assert.strictEqual(grantee.status, 403);

      const revoked = await call(
        'POST',
        `/api/v1/standing-grants/${id}/revoke`,
        {},
        siteHeadHeaders,
      );
      assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));
      const row = await grantRow(id);
      assert.strictEqual(row['status'], 'revoked');
      assert.strictEqual(row['revoke_reason'], 'assigner');
      assert.strictEqual(row['revoked_by'], siteHeadId);
      const raised = await raise([line(sku, 1)]);
      assert.strictEqual(raised.lines[0]!['approval_route'], 'doa', 'effective at once');

      const twice = await call('POST', `/api/v1/standing-grants/${id}/revoke`, {}, siteHeadHeaders);
      assert.strictEqual(twice.status, 409);
      assert.strictEqual(twice.body['error_code'], 'GRANT_NOT_LIVE');
      const missing = await call(
        'POST',
        `/api/v1/standing-grants/${randomUUID()}/revoke`,
        {},
        siteHeadHeaders,
      );
      assert.strictEqual(missing.status, 404);
    });

    it('disabling an account revokes every grant the person holds in the same request; grants they assigned stay live', async () => {
      const extId = `gone-48-${run}@example.com`;
      const goneId = await provisionUser(port, extId, [
        write(ROLE_SITE_HEAD, 'procurement', siteA),
      ]);
      const goneHeaders = await authFor(port, extId);

      const heldActive = await activeGrant(
        saBody(await newSku('GONE'), { grantee_user_id: goneId }),
      );
      const heldPending = await assign(saBody(await newSku('GONE'), { grantee_user_id: goneId }));
      assert.strictEqual(heldPending.status, 201, JSON.stringify(heldPending.body));
      const limit = await activeGrant({
        grant_kind: 'self_approval_limit',
        grantee_user_id: goneId,
        limit_amount: 100,
      });
      // A grant the disabled person assigned (they hold the site head role too).
      const assigned = await activeGrant(saBody(await newSku('GONE')), goneHeaders);

      const patch = await makeRequest(
        port,
        'PATCH',
        `/api/v1/scim/v2/Users/${encodeURIComponent(extId)}`,
        { active: false },
        SCIM_HEADERS,
      );
      assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));

      for (const g of [heldActive, limit, heldPending.body['grant'] as Row]) {
        const row = await grantRow(g['grant_id'] as string);
        assert.strictEqual(row['status'], 'revoked', String(g['grant_ref']));
        assert.strictEqual(row['revoke_reason'], 'account_disabled');
        assert.strictEqual(row['revoked_by'], '00000000-0000-0000-0000-000000000000');
      }
      assert.strictEqual((await grantRow(assigned['grant_id'] as string))['status'], 'active');

      // Idempotent: a repeated disable (the already-inactive branch) is a no-op for settled grants.
      const again = await makeRequest(
        port,
        'PATCH',
        `/api/v1/scim/v2/Users/${encodeURIComponent(extId)}`,
        { active: false },
        SCIM_HEADERS,
      );
      assert.strictEqual(again.status, 200, JSON.stringify(again.body));
      const audit = await getPool().query(
        `SELECT count(*)::int AS n FROM audit_log WHERE error_code = 'standing_grant.revoked' AND details->>'grantee_user_id' = $1`,
        [goneId],
      );
      assert.strictEqual((audit.rows[0] as Row)['n'], 3);
    });
  });

  // --- AC 6: pruning cycle -------------------------------------------------------------------------------

  describe('AC6 pruning cycle', () => {
    let headId: string;
    let headHeaders: Record<string, string>;
    let head2Id: string;
    let head2Headers: Record<string, string>;
    // Set in before() once the first grant has been used, so the fake clock starts after that issue.
    let t0 = new Date();
    const at = (days: number): string => new Date(t0.getTime() + days * DAY_MS).toISOString();
    const grantRefs: string[] = [];
    let usedGrantId: string;

    const reviewsFor = async (userId: string): Promise<Row[]> =>
      (
        await getPool().query(
          `SELECT status_verb, next_step, actor_label FROM notifications
           WHERE target_user_id = $1 AND event_type = 'standing_grant_review' ORDER BY created_at ASC`,
          [userId],
        )
      ).rows as Row[];

    before(async () => {
      headId = await provisionUser(port, `head-48-${run}@example.com`, [
        write(ROLE_SITE_HEAD, 'procurement', siteA),
        write(ROLE_SITE_HEAD, 'notification', siteA),
      ]);
      headHeaders = await authFor(port, `head-48-${run}@example.com`);
      head2Id = await provisionUser(port, `head2-48-${run}@example.com`, [
        write(ROLE_SITE_HEAD, 'procurement', siteA),
      ]);
      head2Headers = await authFor(port, `head2-48-${run}@example.com`);
      for (let i = 0; i < 2; i += 1) {
        const sku = await newSku('PRUNE');
        const g = await activeGrant(saBody(sku, { monthly_qty_cap: 10 }), headHeaders);
        grantRefs.push(g['grant_ref'] as string);
        if (i === 0) {
          usedGrantId = g['grant_id'] as string;
          await receive(sku, 20);
          const r = await raise([line(sku, 2)]);
          const issued = await issue(r.indent['indent_id'] as string, [
            issueLine(r.lines[0]!['indent_line_id'] as string, 2),
          ]);
          assert.strictEqual(issued.status, 201, JSON.stringify(issued.body));
        }
      }
      await activeGrant(saBody(await newSku('PRUNE2')), head2Headers);
      t0 = new Date(Date.now() + 1000);
      const set = await call(
        'PUT',
        '/api/v1/standing-grants/prune-setting',
        { prune_interval_days: 7 },
        head2Headers,
      );
      assert.strictEqual(set.status, 200, JSON.stringify(set.body));
      const bad = await call(
        'PUT',
        '/api/v1/standing-grants/prune-setting',
        { prune_interval_days: 0 },
        head2Headers,
      );
      assert.strictEqual(bad.status, 400);
    });

    it('sends one list per due assigner, names every live grant with last-period usage, and does not resend inside the interval', async () => {
      const first = await runStandingGrantSweepCycle({ now: at(0) });
      assert.strictEqual(first.cycleFailed, false);
      assert.ok(first.listsSent >= 2, JSON.stringify(first));
      await runDispatchCycle(200);

      const lists = await reviewsFor(headId);
      assert.strictEqual(lists.length, 1);
      const text = lists[0]!['next_step'] as string;
      for (const ref of grantRefs) assert.ok(text.includes(ref), text);
      assert.ok(text.includes('issued last period 2.000'), text);
      assert.ok(
        !text.includes('consider revoking'),
        'a grant used or just activated is not flagged',
      );

      await runStandingGrantSweepCycle({ now: at(0) });
      await runStandingGrantSweepCycle({ now: at(29) });
      await runDispatchCycle(200);
      assert.strictEqual((await reviewsFor(headId)).length, 1, 'default interval is 30 days');
    });

    it('honours a custom interval per assigner and resends once the default 30 days have run', async () => {
      await runStandingGrantSweepCycle({ now: at(8) });
      await runDispatchCycle(200);
      assert.strictEqual(
        (await reviewsFor(head2Id)).length,
        2,
        '7-day interval is due after 8 days',
      );
      assert.strictEqual((await reviewsFor(headId)).length, 1, 'but the 30-day assigner is not');

      await runStandingGrantSweepCycle({ now: at(31) });
      await runDispatchCycle(200);
      assert.strictEqual((await reviewsFor(headId)).length, 2);
    });

    it('flags a grant unused for 90 days as a candidate to revoke', async () => {
      await runStandingGrantSweepCycle({ now: at(125) });
      await runDispatchCycle(200);
      const lists = await reviewsFor(headId);
      const latest = lists[lists.length - 1]!['next_step'] as string;
      assert.ok(latest.includes('consider revoking'), latest);
      // The grant used 125 days ago in fake time is flagged too: it was last used at t0.
      assert.ok(latest.includes(grantRefs[0]!), latest);
    });

    it('delivers in_app and, for a person opted in with a subscription, web_push', async () => {
      const pref = await call(
        'PUT',
        '/api/v1/notifications/preferences',
        { event_type: 'standing_grant_review', opted_in: true },
        headHeaders,
      );
      assert.strictEqual(pref.status, 200, JSON.stringify(pref.body));
      const sub = await call(
        'POST',
        '/api/v1/notifications/push-subscription',
        { endpoint: 'https://push.example.com/head-48', keys: { p256dh: 'p', auth: 'a' } },
        headHeaders,
      );
      assert.strictEqual(sub.status, 201, JSON.stringify(sub.body));
      await runStandingGrantSweepCycle({ now: at(170) });
      await runDispatchCycle(200);
      const channels = await getPool().query(
        `SELECT DISTINCT d.channel FROM notification_deliveries d
         JOIN notifications n ON n.notification_id = d.notification_id
         WHERE n.target_user_id = $1 AND n.event_type = 'standing_grant_review'`,
        [headId],
      );
      assert.deepStrictEqual((channels.rows as Row[]).map((r) => r['channel']).sort(), [
        'in_app',
        'web_push',
      ]);
    });

    it('expires a grant past its end date and drops it from the list', async () => {
      const sku = await newSku('EXPIRE');
      const g = await activeGrant(saBody(sku, { end_date: daysAhead(3) }), head2Headers);
      await getPool().query(`UPDATE standing_grant SET end_date = $2::date WHERE grant_id = $1`, [
        g['grant_id'],
        daysAhead(-1),
      ]);
      const result = await runStandingGrantSweepCycle();
      assert.ok(result.expired >= 1, JSON.stringify(result));
      const row = await grantRow(g['grant_id'] as string);
      assert.strictEqual(row['status'], 'expired');
      assert.ok(row['expired_at']);
      const raised = await raise([line(sku, 1)]);
      assert.strictEqual(raised.lines[0]!['approval_route'], 'doa');
      // The expired grant is not live any more: it cannot be revoked.
      const revoke = await call(
        'POST',
        `/api/v1/standing-grants/${g['grant_id'] as string}/revoke`,
        {},
        head2Headers,
      );
      assert.strictEqual(revoke.status, 409);
      assert.strictEqual(revoke.body['error_code'], 'GRANT_NOT_LIVE');
      assert.ok(usedGrantId);
    });

    it('moves the list of a disabled assigner to the finance approver', async () => {
      const extId = `head3-48-${run}@example.com`;
      const head3Id = await provisionUser(port, extId, [
        write(ROLE_SITE_HEAD, 'procurement', siteA),
      ]);
      const head3Headers = await authFor(port, extId);
      const g = await activeGrant(saBody(await newSku('ORPHAN')), head3Headers);
      await makeRequest(
        port,
        'PATCH',
        `/api/v1/scim/v2/Users/${encodeURIComponent(extId)}`,
        { active: false },
        SCIM_HEADERS,
      );
      assert.strictEqual((await grantRow(g['grant_id'] as string))['status'], 'active');
      await runStandingGrantSweepCycle({ now: at(200) });
      await runDispatchCycle(200);
      const finance = await reviewsFor(financeId);
      assert.ok(
        finance.some((n) => (n['next_step'] as string).includes(g['grant_ref'] as string)),
        'the finance approver now reviews the orphaned grant',
      );
      assert.strictEqual(
        (await reviewsFor(head3Id)).length,
        0,
        'the disabled assigner no longer receives lists',
      );
    });
  });

  // --- Voice ----------------------------------------------------------------------------------------------------

  describe('voice', () => {
    it('no response says "No approval required" or grades a person', () => {
      assert.ok(seenBodies.length > 20);
      for (const body of seenBodies) {
        assert.ok(!body.includes('No approval required'), body.slice(0, 200));
        assert.ok(!/junior/i.test(body), body.slice(0, 200));
      }
      assert.ok(bystanderId && deptHeadId);
    });
  });
});

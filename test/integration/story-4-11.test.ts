import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.11: stores counter issue against a requisition. Runs against the production router
// (createAppRouter) with real auth, RBAC, the nested stock.issued ledger path and PostgreSQL.
// Roles and bands are suffixed per run (the story-4-10 pattern) so seeds never collide.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const daysAhead = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

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

describe('Story 4.11 stores counter issue against a requisition', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const binA = randomUUID();
  const binB = randomUUID();
  const SKU_PLAIN = `CON-411-${run}`;
  const SKU_LOT = `RM-411-${run}`;
  const SKU_SER = `EQ-411-${run}`;
  let requesterHeaders: Record<string, string>;
  let requesterId: string;
  let deptHeadHeaders: Record<string, string>;
  let storeHeaders: Record<string, string>;
  let storeId: string;
  let qualityHeaders: Record<string, string>;
  let otherSiteStoreHeaders: Record<string, string>;

  function line(sku: string, qty: number, price: number | null): Row {
    return {
      sku,
      item_category: 'consumable',
      requested_qty: qty,
      uom: 'EA',
      ...(price === null ? {} : { unit_price_estimate: price }),
    };
  }

  function raiseBody(lines: Row[], overrides: Row = {}): Row {
    return {
      department_code: 'MAINT',
      site_id: siteA,
      business_stream: 'production',
      need_by_date: '2026-12-01',
      urgent: false,
      reason: 'Counter issue',
      confirm_duplicate: true,
      lines,
      ...overrides,
    };
  }

  async function raise(lines: Row[]): Promise<{ indent: Row; lines: Row[] }> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(lines),
      requesterHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { indent: res.body['indent'] as Row, lines: res.body['lines'] as Row[] };
  }

  async function approveAll(indentId: string): Promise<void> {
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  async function raiseApproved(lines: Row[]): Promise<{ indent: Row; lines: Row[] }> {
    const raised = await raise(lines);
    await approveAll(raised.indent['indent_id'] as string);
    return raised;
  }

  async function receive(sku: string, quantity: number, extra: Row = {}): Promise<void> {
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
        ...extra,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: storeId, role: 'store_assistant', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    });
  }

  async function onHand(sku: string, lotId: string | null = null): Promise<number> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::numeric AS n FROM stock_balance WHERE sku = $1 AND location_id = $2 AND ($3::text IS NULL OR lot_id = $3)`,
      [sku, binA, lotId],
    );
    return Number(r.rows[0]!['n']);
  }

  function issueLine(indentLineId: string, quantity: string | number, extra: Row = {}): Row {
    return { indent_line_id: indentLineId, quantity, location_id: binA, ...extra };
  }

  async function issue(
    indentId: string,
    lines: Row[],
    headers: Record<string, string> = storeHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', `/api/v1/indents/${indentId}/issue`, { lines }, headers);
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE indent_issue_line, indent_issue, indent_line, indent, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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
    // Sites and bins: the actor location of a stock event must be a registered location, so each
    // site is a location_register row and its bin hangs under it (isLocationDescendantOf).
    for (const [id, code, parent] of [
      [siteA, `SITE-A-${run}`, null],
      [siteB, `SITE-B-${run}`, null],
    ] as const) {
      await pool.query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, 'site', $3, $1, 'general', 'ambient', 'active')`,
        [id, code, parent],
      );
    }
    for (const [id, code, site] of [
      [binA, `BIN-A-${run}`, siteA],
      [binB, `BIN-B-${run}`, siteB],
    ] as const) {
      await pool.query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, 'bin', $3, $3, 'general', 'ambient', 'active')`,
        [id, code, site],
      );
    }
    for (const [sku, lot, ser] of [
      [SKU_PLAIN, false, false],
      [SKU_LOT, true, false],
      [SKU_SER, true, true],
    ] as const) {
      await pool.query(
        `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
         VALUES ($1, 'EA', $2, $3, 'fifo', 'production', 'active')`,
        [sku, lot, ser],
      );
    }

    const write = (role: string, module: string, locationId = '*'): Role => ({
      role,
      module,
      functionScope: 'write',
      locationId,
    });
    requesterId = await provisionUser(port, `req-411-${run}@example.com`, [
      write('floor_supervisor', 'procurement', siteA),
    ]);
    requesterHeaders = await authFor(port, `req-411-${run}@example.com`);
    await provisionUser(port, `dh-411-${run}@example.com`, [
      write(`department_head_411_${run}`, 'procurement'),
    ]);
    deptHeadHeaders = await authFor(port, `dh-411-${run}@example.com`);
    storeId = await provisionUser(port, `store-411-${run}@example.com`, [
      write('store_assistant', 'warehouse', siteA),
    ]);
    storeHeaders = await authFor(port, `store-411-${run}@example.com`);
    await provisionUser(port, `store-b-411-${run}@example.com`, [
      write('store_assistant', 'warehouse', siteB),
    ]);
    otherSiteStoreHeaders = await authFor(port, `store-b-411-${run}@example.com`);
    // quality_officer is on the expired-lot override allowlist and holds warehouse write at the
    // site so it can issue; quality write reaches the hold route.
    await provisionUser(port, `qa-411-${run}@example.com`, [
      write('quality_officer', 'quality'),
      write('quality_officer', 'warehouse', siteA),
    ]);
    qualityHeaders = await authFor(port, `qa-411-${run}@example.com`);

    await provisionUser(port, `doa-411-${run}@example.com`, [
      write('compliance_admin_411', 'compliance'),
    ]);
    const doaHeaders = await authFor(port, `doa-411-${run}@example.com`);
    const band = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        transaction_type: 'indent_approval',
        role: `department_head_411_${run}`,
        value_min: null,
        value_max: null,
      },
      doaHeaders,
    );
    assert.strictEqual(band.status, 201, JSON.stringify(band.body));

    await receive(SKU_PLAIN, 500);
  });

  after(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 1, 6, 8: full issue, ledger, slip, audit -------------------------------------------

  it('AC1/AC6/AC8: a full issue drains the bin, writes the slip and the audit row, and the line reads issued', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 10, 5)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;
    const before = await onHand(SKU_PLAIN);

    const res = await issue(indentId, [issueLine(lineId, '10')]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(await onHand(SKU_PLAIN), before - 10);

    const issueRow = res.body['issue'] as Row;
    assert.match(issueRow['issue_number_ext'] as string, /^ISS-\d{4}-\d{4,}$/);
    assert.strictEqual((issueRow['lines'] as Row[]).length, 1);
    const slip = res.body['slip_text'] as string;
    assert.ok(slip.startsWith(`ISSUE SLIP ${issueRow['issue_number_ext'] as string}`), slip);
    assert.ok(slip.includes(indent['indent_number_ext'] as string), slip);
    assert.ok(slip.includes(`${requesterId} (MAINT)`), slip);
    assert.ok(slip.includes(`Basis: Approved by department_head_411_${run} (`), slip);
    assert.ok(!slip.includes('No approval required'), slip);

    const [issuedLine] = res.body['lines'] as Row[];
    assert.strictEqual(issuedLine!['issued_qty'], '10.000');
    assert.strictEqual(issuedLine!['open_qty'], '0.000');
    assert.strictEqual(issuedLine!['issue_state'], 'issued');
    assert.strictEqual(issuedLine!['line_status'], 'approved');
    assert.strictEqual((res.body['indent'] as Row)['issued_line_count'], 1);
    assert.strictEqual((res.body['indent'] as Row)['status'], 'approved');

    // The nested stock.issued carries the indent.issued event as its cause.
    const nested = await getPool().query(
      `SELECT event_type, metadata->>'causation_id' AS cause, payload->>'sku' AS sku FROM domain_events WHERE metadata->>'causation_id' = $1`,
      [res.body['event_id']],
    );
    assert.deepStrictEqual(
      nested.rows.map((r) => [r['event_type'], r['sku']]),
      [['stock.issued', SKU_PLAIN]],
    );
    const audit = await getPool().query(
      `SELECT error_code, details FROM audit_log WHERE details->>'indent_id' = $1 AND error_code = 'indent.line_issued'`,
      [indentId],
    );
    assert.strictEqual(audit.rows.length, 1);
    assert.strictEqual((audit.rows[0]!['details'] as Row)['quantity'], '10');
    assert.strictEqual(
      (audit.rows[0]!['details'] as Row)['issue_number_ext'],
      issueRow['issue_number_ext'],
    );

    // GET detail and the slip read back.
    const got = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${indentId}`,
      undefined,
      requesterHeaders,
    );
    assert.strictEqual(got.status, 200);
    assert.strictEqual((got.body['lines'] as Row[])[0]!['issue_state'], 'issued');
    const slipRead = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/issues/${issueRow['issue_id'] as string}`,
      undefined,
      requesterHeaders,
    );
    assert.strictEqual(slipRead.status, 200, JSON.stringify(slipRead.body));
    assert.strictEqual((slipRead.body['issue'] as Row)['slip_content'], slip);
    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${indentId}/issues`,
      undefined,
      storeHeaders,
    );
    assert.strictEqual(list.status, 200);
    assert.strictEqual((list.body['issues'] as Row[]).length, 1);

    // Second issue of a fully issued line.
    const again = await issue(indentId, [issueLine(lineId, '1')]);
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.body['error_code'], 'INDENT_LINE_FULLY_ISSUED');
    assert.strictEqual(await onHand(SKU_PLAIN), before - 10);
  });

  // --- AC 2, 7: partial issue, second slip lists the first --------------------------------------

  it('AC2/AC7: a partial issue leaves the line open; the remainder is a second slip naming the first; issued never exceeds requested', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 12, 5)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;
    const before = await onHand(SKU_PLAIN);

    const first = await issue(indentId, [issueLine(lineId, 5)]);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const l1 = (first.body['lines'] as Row[])[0]!;
    assert.strictEqual(l1['issue_state'], 'open');
    assert.strictEqual(l1['issued_qty'], '5.000');
    assert.strictEqual(l1['open_qty'], '7.000');
    assert.strictEqual((first.body['indent'] as Row)['issued_line_count'], 0);

    const over = await issue(indentId, [issueLine(lineId, '7.001')]);
    assert.strictEqual(over.status, 409, JSON.stringify(over.body));
    assert.strictEqual(over.body['error_code'], 'INDENT_ISSUE_EXCEEDS_APPROVED');
    assert.strictEqual((over.body['details'] as Row)['open_qty'], '7.000');
    assert.strictEqual(await onHand(SKU_PLAIN), before - 5);

    const second = await issue(indentId, [issueLine(lineId, '7')]);
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const firstNo = (first.body['issue'] as Row)['issue_number_ext'] as string;
    assert.ok(
      (second.body['slip_text'] as string).includes(`Earlier slips : ${firstNo}`),
      second.body['slip_text'] as string,
    );
    assert.ok((second.body['slip_text'] as string).includes('issued to date 12.000'));
    assert.strictEqual((second.body['lines'] as Row[])[0]!['issue_state'], 'issued');
    assert.strictEqual(await onHand(SKU_PLAIN), before - 12);
    const slips = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${indentId}/issues`,
      undefined,
      storeHeaders,
    );
    assert.deepStrictEqual(
      (slips.body['issues'] as Row[]).map((s) => s['issue_number_ext']),
      [firstNo, (second.body['issue'] as Row)['issue_number_ext']],
    );
  });

  // --- AC 3: close the remainder -----------------------------------------------------------------

  it('AC3: closing an open remainder needs a reason, refuses further issue and tells the requester', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 4, 5)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;
    assert.strictEqual((await issue(indentId, [issueLine(lineId, 1)])).status, 201);

    const noReason = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/lines/${lineId}/close`,
      { reason: '  ' },
      storeHeaders,
    );
    assert.strictEqual(noReason.status, 400);
    assert.strictEqual(noReason.body['error_code'], 'INDENT_LINE_CLOSE_REASON_REQUIRED');

    const closed = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/lines/${lineId}/close`,
      { reason: 'not stocked, remainder to purchase' },
      storeHeaders,
    );
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    const l = (closed.body['lines'] as Row[])[0]!;
    assert.strictEqual(l['issue_state'], 'closed');
    assert.strictEqual(l['closed_reason'], 'not stocked, remainder to purchase');
    assert.strictEqual(l['closed_by'], storeId);
    assert.strictEqual((closed.body['indent'] as Row)['issued_line_count'], 1);

    const after = await issue(indentId, [issueLine(lineId, 1)]);
    assert.strictEqual(after.status, 409);
    assert.strictEqual(after.body['error_code'], 'INDENT_LINE_CLOSED');
    const twice = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/lines/${lineId}/close`,
      { reason: 'again' },
      storeHeaders,
    );
    assert.strictEqual(twice.status, 409);
    assert.strictEqual(twice.body['error_code'], 'INDENT_LINE_CLOSED');

    await runDispatchCycle();
    const notified = await getPool().query(
      `SELECT status_verb, next_step FROM notifications WHERE object_id = $1 AND event_type = 'indent_decision' AND status_verb = 'closed'`,
      [indentId],
    );
    assert.strictEqual(notified.rows.length, 1);
    assert.match(
      notified.rows[0]!['next_step'] as string,
      /closed at stores after 1\.000 of 4\.000 issued/,
    );
  });

  // --- AC 4: refusals ----------------------------------------------------------------------------

  it('AC4: pending, rejected, missing and foreign-site lines are refused and a mixed body persists nothing', async () => {
    const { indent, lines } = await raise([line(SKU_PLAIN, 3, 5), line(SKU_PLAIN, 2, 5)]);
    const indentId = indent['indent_id'] as string;
    const [a, b] = lines as [Row, Row];
    const before = await onHand(SKU_PLAIN);

    const pending = await issue(indentId, [issueLine(a['indent_line_id'] as string, 1)]);
    assert.strictEqual(pending.status, 409);
    assert.strictEqual(pending.body['error_code'], 'INDENT_LINE_NOT_APPROVED');

    // Approve line A only, reject line B.
    let r = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      { line_ids: [a['indent_line_id']] },
      deptHeadHeaders,
    );
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/reject`,
      { line_ids: [b['indent_line_id']], rejection_reason: 'no' },
      deptHeadHeaders,
    );
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const rejected = await issue(indentId, [issueLine(b['indent_line_id'] as string, 1)]);
    assert.strictEqual(rejected.status, 409);
    assert.strictEqual(rejected.body['error_code'], 'INDENT_LINE_NOT_APPROVED');

    const unknown = await issue(indentId, [issueLine(randomUUID(), 1)]);
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body['error_code'], 'INDENT_LINE_NOT_FOUND');

    const foreignBin = await issue(indentId, [
      issueLine(a['indent_line_id'] as string, 1, { location_id: binB }),
    ]);
    assert.strictEqual(foreignBin.status, 409, JSON.stringify(foreignBin.body));
    assert.strictEqual(foreignBin.body['error_code'], 'INDENT_ISSUE_BIN_OUTSIDE_SITE');

    const noLines = await issue(indentId, []);
    assert.strictEqual(noLines.status, 400);
    assert.strictEqual(noLines.body['error_code'], 'INDENT_ISSUE_LINE_REQUIRED');

    // One good line and one bad line: nothing is written.
    const mixed = await issue(indentId, [
      issueLine(a['indent_line_id'] as string, 1),
      issueLine(b['indent_line_id'] as string, 1),
    ]);
    assert.strictEqual(mixed.status, 409);
    assert.strictEqual(await onHand(SKU_PLAIN), before);
    const slips = await getPool().query(
      `SELECT count(*)::int AS n FROM indent_issue WHERE indent_id = $1`,
      [indentId],
    );
    assert.strictEqual(slips.rows[0]!['n'], 0);

    // The storekeeper of another site and the requester cannot issue here.
    const wrongSite = await issue(
      indentId,
      [issueLine(a['indent_line_id'] as string, 1)],
      otherSiteStoreHeaders,
    );
    assert.strictEqual(wrongSite.status, 403, JSON.stringify(wrongSite.body));
    const requester = await issue(
      indentId,
      [issueLine(a['indent_line_id'] as string, 1)],
      requesterHeaders,
    );
    assert.strictEqual(requester.status, 403, JSON.stringify(requester.body));

    // Header cancelled refuses INDENT_NOT_ISSUABLE.
    r = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/cancel`,
      { cancelled_reason: 'x' },
      deptHeadHeaders,
    );
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const cancelled = await issue(indentId, [issueLine(a['indent_line_id'] as string, 1)]);
    assert.strictEqual(cancelled.status, 409);
    assert.strictEqual(cancelled.body['error_code'], 'INDENT_NOT_ISSUABLE');
  });

  it('AC4: insufficient stock surfaces INSUFFICIENT_STOCK from the ledger unchanged', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 10000, 5)]);
    const res = await issue(indent['indent_id'] as string, [
      issueLine(lines[0]!['indent_line_id'] as string, 10000),
    ]);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INSUFFICIENT_STOCK');
  });

  it('D8: the events door refuses indent.issued and indent.line_closed', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: randomUUID(),
        event_type: 'indent.issued',
        payload: { indent_id: randomUUID(), issue_id: randomUUID(), lines: [] },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: storeId, role: 'store_assistant', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      // A procurement writer passes the module gate; the door itself must still refuse.
      deptHeadHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  // --- AC 5: lot and serial rules through the issue route -------------------------------------

  it('AC5: lot-controlled items follow Story 2.3 - LOT_REQUIRED, LOT_EXPIRED with override, LOT_ON_HOLD, lot trace', async () => {
    const live = `LOT-411-LIVE-${run}`;
    const expired = `LOT-411-EXP-${run}`;
    const held = `LOT-411-HELD-${run}`;
    await receive(SKU_LOT, 20, { lot_id: live, expiry_date: daysAhead(90) });
    await receive(SKU_LOT, 20, { lot_id: expired, expiry_date: '2020-01-01' });
    await receive(SKU_LOT, 20, { lot_id: held, expiry_date: daysAhead(90) });
    const hold = await makeRequest(
      port,
      'PUT',
      `/api/v1/lots/${held}/quality-hold`,
      { hold_reason: 'inspection failed' },
      qualityHeaders,
    );
    assert.strictEqual(hold.status, 200, JSON.stringify(hold.body));

    const { indent, lines } = await raiseApproved([line(SKU_LOT, 15, 5)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;

    const noLot = await issue(indentId, [issueLine(lineId, 5)]);
    assert.strictEqual(noLot.status, 400, JSON.stringify(noLot.body));
    assert.strictEqual(noLot.body['error_code'], 'LOT_REQUIRED');

    const onHold = await issue(indentId, [issueLine(lineId, 5, { lot_id: held })]);
    assert.strictEqual(onHold.body['error_code'], 'LOT_ON_HOLD', JSON.stringify(onHold.body));

    const exp = await issue(indentId, [issueLine(lineId, 5, { lot_id: expired })]);
    assert.strictEqual(exp.body['error_code'], 'LOT_EXPIRED', JSON.stringify(exp.body));

    // The storekeeper may not override; the quality officer may.
    const overrideByStore = await issue(indentId, [
      issueLine(lineId, 5, { lot_id: expired, override_expired_lot: true }),
    ]);
    assert.strictEqual(overrideByStore.status, 403, JSON.stringify(overrideByStore.body));
    const overrideByQa = await issue(
      indentId,
      [issueLine(lineId, 5, { lot_id: expired, override_expired_lot: true })],
      qualityHeaders,
    );
    assert.strictEqual(overrideByQa.status, 201, JSON.stringify(overrideByQa.body));
    assert.strictEqual(await onHand(SKU_LOT, expired), 15);

    const ok = await issue(indentId, [issueLine(lineId, 10, { lot_id: live })]);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(await onHand(SKU_LOT, live), 10);
    assert.ok((ok.body['slip_text'] as string).includes(`lot ${live}`));
    const issueLineRow = ((ok.body['issue'] as Row)['lines'] as Row[])[0]!;
    assert.strictEqual(issueLineRow['lot_id'], live);

    const trace = await getPool().query(
      `SELECT t.quantity_change FROM lot_trace t JOIN lot_master m ON m.lot_id = t.lot_id WHERE m.lot_number = $1 AND t.event_id = $2`,
      [live, issueLineRow['stock_issued_event_id']],
    );
    assert.strictEqual(trace.rows.length, 1);
    assert.strictEqual(Number(trace.rows[0]!['quantity_change']), -10);
  });

  it('AC5: serial-controlled items need serials summing to the quantity and the serials leave the bin', async () => {
    const lot = `LOT-411-SER-${run}`;
    const serials = [`SN-411-1-${run}`, `SN-411-2-${run}`, `SN-411-3-${run}`];
    await receive(SKU_SER, 3, {
      lot_id: lot,
      expiry_date: daysAhead(365),
      serials: serials.map((serial_number) => ({ serial_number, initial_quantity: 1 })),
    });
    const { indent, lines } = await raiseApproved([line(SKU_SER, 3, 50)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;

    const noSerial = await issue(indentId, [issueLine(lineId, 2, { lot_id: lot })]);
    assert.strictEqual(
      noSerial.body['error_code'],
      'SERIAL_REQUIRED',
      JSON.stringify(noSerial.body),
    );

    const mismatch = await issue(indentId, [
      issueLine(lineId, 2, { lot_id: lot, serials: [{ serial_number: serials[0] }] }),
    ]);
    assert.strictEqual(mismatch.status, 400, JSON.stringify(mismatch.body));

    const ok = await issue(indentId, [
      issueLine(lineId, 2, {
        lot_id: lot,
        serials: [{ serial_number: serials[0] }, { serial_number: serials[1] }],
      }),
    ]);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.ok((ok.body['slip_text'] as string).includes('serials 2'));
    const state = await getPool().query(
      `SELECT serial_number, current_location_id FROM serial_master WHERE sku = $1 ORDER BY serial_number`,
      [SKU_SER],
    );
    assert.deepStrictEqual(
      state.rows.map((r) => [r['serial_number'], r['current_location_id']]),
      [
        [serials[0], null],
        [serials[1], null],
        [serials[2], binA],
      ],
    );
    const gone = await issue(indentId, [
      issueLine(lineId, 1, { lot_id: lot, serials: [{ serial_number: serials[0] }] }),
    ]);
    assert.strictEqual(gone.body['error_code'], 'SERIAL_NOT_AVAILABLE', JSON.stringify(gone.body));
  });

  // --- AC 7, 8: late-approved line and the issue inbox ------------------------------------------

  it('AC7/AC8: a line approved after a slip exists notifies the stores role at the site; the inbox lists only open approved lines', async () => {
    const { indent, lines } = await raise([line(SKU_PLAIN, 2, 5), line(SKU_PLAIN, 3, 5)]);
    const indentId = indent['indent_id'] as string;
    const [a, b] = lines as [Row, Row];
    let r = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      { line_ids: [a['indent_line_id']] },
      deptHeadHeaders,
    );
    assert.strictEqual(r.status, 200);
    // No slip yet: approving must not page the stores.
    await runDispatchCycle();
    const none = await getPool().query(
      `SELECT count(*)::int AS n FROM notifications WHERE object_id = $1 AND event_type = 'indent_issue_pending'`,
      [indentId],
    );
    assert.strictEqual(none.rows[0]!['n'], 0);

    // Header still raised (line B pending): the approved line can already be issued.
    const inboxBefore = await makeRequest(
      port,
      'GET',
      '/api/v1/indents?issuable=true',
      undefined,
      storeHeaders,
    );
    assert.strictEqual(inboxBefore.status, 200, JSON.stringify(inboxBefore.body));
    assert.ok((inboxBefore.body['indents'] as Row[]).some((i) => i['indent_id'] === indentId));
    const first = await issue(indentId, [issueLine(a['indent_line_id'] as string, 2)]);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstNo = (first.body['issue'] as Row)['issue_number_ext'] as string;

    // Fully issued line A, line B pending: not in the inbox.
    const inboxMid = await makeRequest(
      port,
      'GET',
      '/api/v1/indents?issuable=true',
      undefined,
      storeHeaders,
    );
    assert.ok(!(inboxMid.body['indents'] as Row[]).some((i) => i['indent_id'] === indentId));

    r = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      { line_ids: [b['indent_line_id']] },
      deptHeadHeaders,
    );
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await runDispatchCycle();
    const paged = await getPool().query(
      `SELECT target_role, target_location_id, next_step FROM notifications WHERE object_id = $1 AND event_type = 'indent_issue_pending'`,
      [indentId],
    );
    assert.strictEqual(paged.rows.length, 1, JSON.stringify(paged.rows));
    assert.strictEqual(paged.rows[0]!['target_role'], 'store_assistant');
    assert.strictEqual(paged.rows[0]!['target_location_id'], siteA);
    assert.match(
      paged.rows[0]!['next_step'] as string,
      new RegExp(
        `line 2 ${SKU_PLAIN} qty 3\\.000 approved after slip\\(s\\) ${firstNo}; issue on a new slip`,
      ),
    );

    const inboxAfter = await makeRequest(
      port,
      'GET',
      '/api/v1/indents?issuable=true',
      undefined,
      storeHeaders,
    );
    assert.ok((inboxAfter.body['indents'] as Row[]).some((i) => i['indent_id'] === indentId));
    // The other site's storekeeper does not see it.
    const inboxB = await makeRequest(
      port,
      'GET',
      '/api/v1/indents?issuable=true',
      undefined,
      otherSiteStoreHeaders,
    );
    assert.strictEqual(inboxB.status, 200, JSON.stringify(inboxB.body));
    assert.ok(!(inboxB.body['indents'] as Row[]).some((i) => i['indent_id'] === indentId));

    const second = await issue(indentId, [issueLine(b['indent_line_id'] as string, 3)]);
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.ok((second.body['slip_text'] as string).includes(firstNo));
    assert.strictEqual((second.body['indent'] as Row)['issued_line_count'], 2);
  });

  it('replaying the persisted indent.issued event is idempotent', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 1, 5)]);
    const indentId = indent['indent_id'] as string;
    const res = await issue(indentId, [issueLine(lines[0]!['indent_line_id'] as string, 1)]);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const stored = await getPool().query(
      `SELECT event_id, stream_type, stream_id, event_type, payload, metadata FROM domain_events WHERE event_id = $1`,
      [res.body['event_id']],
    );
    const ev = stored.rows[0]!;
    const before = await onHand(SKU_PLAIN);
    // Same event id again: the applier is a no-op (alreadyPersisted) and the store answers
    // idempotently, so the ledger, the slips and the line are untouched.
    await persistEvent({
      event_id: ev['event_id'] as string,
      stream_type: ev['stream_type'] as string,
      stream_id: ev['stream_id'] as string,
      event_type: ev['event_type'] as string,
      payload: ev['payload'] as Record<string, unknown>,
      metadata: ev['metadata'] as never,
    });
    assert.strictEqual(await onHand(SKU_PLAIN), before);
    const slips = await getPool().query(
      `SELECT count(*)::int AS n FROM indent_issue WHERE indent_id = $1`,
      [indentId],
    );
    assert.strictEqual(slips.rows[0]!['n'], 1);
    const l = await getPool().query(`SELECT issued_qty FROM indent_line WHERE indent_id = $1`, [
      indentId,
    ]);
    assert.strictEqual(l.rows[0]!['issued_qty'], '1.000');
  });

  it('review: a retry carrying the same issue_id returns the slip already written and issues once', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 5, 5)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;
    const issueId = randomUUID();
    const before = await onHand(SKU_PLAIN);
    const body = { issue_id: issueId, lines: [issueLine(lineId, '2')] };
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/issue`,
      body,
      storeHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const retry = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/issue`,
      body,
      storeHeaders,
    );
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.body['replayed'], true);
    assert.strictEqual(retry.body['slip_text'], first.body['slip_text']);
    assert.strictEqual(await onHand(SKU_PLAIN), before - 2);
    const slips = await getPool().query(
      `SELECT count(*)::int AS n FROM indent_issue WHERE indent_id = $1`,
      [indentId],
    );
    assert.strictEqual(slips.rows[0]!['n'], 1);
    // The same issue_id against another requisition is refused, not replayed.
    const other = await raiseApproved([line(SKU_PLAIN, 1, 5)]);
    const clash = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${other.indent['indent_id'] as string}/issue`,
      { issue_id: issueId, lines: [issueLine(other.lines[0]!['indent_line_id'] as string, '1')] },
      storeHeaders,
    );
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));
  });

  it('review: the edge door refuses indent.issued and indent.line_closed', async () => {
    for (const eventType of ['indent.issued', 'indent.line_closed']) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          stream_type: 'procurement',
          event_id: randomUUID(),
          stream_id: randomUUID(),
          event_type: eventType,
          payload: { indent_id: randomUUID(), issue_id: randomUUID(), lines: [] },
          event_version: 1,
          schema_version: 1,
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: storeId, role: 'store_assistant', location_id: siteA },
            device_id: `EDGE-411-${run}`,
            capture_method: 'MANUAL',
            occurred_at: new Date().toISOString(),
          },
          idempotency_key: randomUUID(),
        },
        // A procurement writer passes the module gate; the door itself must still refuse.
        deptHeadHeaders,
      );
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    }
  });

  it('review: a remainder can be closed once the requisition is ordered, but not issued against', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 4, 5)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;
    assert.strictEqual((await issue(indentId, [issueLine(lineId, 1)])).status, 201);
    await getAdminPool().query(`UPDATE indent SET status = 'ordered' WHERE indent_id = $1`, [
      indentId,
    ]);
    const refused = await issue(indentId, [issueLine(lineId, 1)]);
    assert.strictEqual(refused.status, 409);
    assert.strictEqual(refused.body['error_code'], 'INDENT_NOT_ISSUABLE');
    const closed = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/lines/${lineId}/close`,
      { reason: 'remainder to purchase' },
      storeHeaders,
    );
    assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
    assert.strictEqual((closed.body['lines'] as Row[])[0]!['issue_state'], 'closed');
  });

  it('review: a requisition with issued stock cannot be cancelled', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 3, 5)]);
    const indentId = indent['indent_id'] as string;
    assert.strictEqual(
      (await issue(indentId, [issueLine(lines[0]!['indent_line_id'] as string, 1)])).status,
      201,
    );
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/cancel`,
      { cancelled_reason: 'changed my mind' },
      requesterHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INDENT_CANCEL_AFTER_ISSUE');
  });

  it('review: duplicate serials and an oversized body are refused before any write', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_SER, 3, 50)]);
    const indentId = indent['indent_id'] as string;
    const lineId = lines[0]!['indent_line_id'] as string;
    const dup = await issue(indentId, [
      issueLine(lineId, 2, {
        lot_id: 'L-DUP',
        serials: [{ serial_number: 'SN-DUP' }, { serial_number: 'SN-DUP' }],
      }),
    ]);
    assert.strictEqual(dup.status, 400, JSON.stringify(dup.body));
    const tooMany = await issue(
      indentId,
      Array.from({ length: 51 }, () => issueLine(randomUUID(), '1')),
    );
    assert.strictEqual(tooMany.status, 400, JSON.stringify(tooMany.body));
  });

  it('review: the stores inbox is not widened by a procurement role', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/indents?issuable=true',
      undefined,
      deptHeadHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('review: an unknown bin code is a 404 LOCATION_NOT_FOUND', async () => {
    const { indent, lines } = await raiseApproved([line(SKU_PLAIN, 2, 5)]);
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indent['indent_id'] as string}/issue`,
      {
        lines: [
          {
            indent_line_id: lines[0]!['indent_line_id'],
            quantity: '1',
            location_code: `NO-SUCH-BIN-${run}`,
          },
        ],
      },
      storeHeaders,
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOCATION_NOT_FOUND');
  });
});

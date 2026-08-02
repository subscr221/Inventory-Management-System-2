import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 4.3: purchase requisition and indent loop. Runs against the PRODUCTION router surface
// (createAppRouter) with real auth, RBAC, DOA resolution, and PostgreSQL. Tests run serially
// (npm test uses --test-concurrency=1) and seed their own users/DOA bands for isolation.

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
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(
    res.status >= 200 && res.status < 300,
    `dev-token ${sub} failed: ${JSON.stringify(res.body)}`,
  );
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 4.3 Purchase Requisition and Indent Loop Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  let requesterHeaders: Record<string, string>;
  let requesterUserId: string;
  let secondRequesterHeaders: Record<string, string>;
  let deptHeadHeaders: Record<string, string>;
  let deptHeadUserId: string;
  let financeHeaders: Record<string, string>;
  let financeUserId: string;
  let superAdminUserId: string;
  let otherWriterHeaders: Record<string, string>;
  let tier1EntryId: string;
  let tier2EntryId: string;
  let tier3EntryId: string;

  function raiseBody(
    sku: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      department_code: 'MAINT',
      site_id: siteA,
      business_stream: 'production',
      need_by_date: '2026-09-01',
      urgent: false,
      reason: 'Line consumables',
      lines: [
        {
          sku,
          item_category: 'consumables',
          requested_qty: 10,
          uom: 'EA',
          unit_price_estimate: 100,
        },
      ],
      ...overrides,
    };
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

    requesterUserId = await provisionUser(port, `requester-4-3-${run}@example.com`, [
      {
        role: 'floor_supervisor',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    requesterHeaders = await authFor(port, `requester-4-3-${run}@example.com`);

    await provisionUser(port, `requester2-4-3-${run}@example.com`, [
      {
        role: 'floor_supervisor',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    secondRequesterHeaders = await authFor(port, `requester2-4-3-${run}@example.com`);

    deptHeadUserId = await provisionUser(port, `dept-head-4-3-${run}@example.com`, [
      {
        role: 'department_head_4_3',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    deptHeadHeaders = await authFor(port, `dept-head-4-3-${run}@example.com`);

    financeUserId = await provisionUser(port, `finance-4-3-${run}@example.com`, [
      {
        role: 'finance_controller_4_3',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    financeHeaders = await authFor(port, `finance-4-3-${run}@example.com`);

    superAdminUserId = await provisionUser(port, `super-admin-4-3-${run}@example.com`, [
      { role: 'super_admin_4_3', module: 'procurement', functionScope: 'write', locationId: '*' },
    ]);

    await provisionUser(port, `other-writer-4-3-${run}@example.com`, [
      {
        role: 'procurement_officer',
        module: 'procurement',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    otherWriterHeaders = await authFor(port, `other-writer-4-3-${run}@example.com`);

    // Access-matrix section 8 DOA value bands for indent_approval (Table 4 of the story):
    // Tier 1 up to 50,000 -> department head; Tier 2 50,001-2,00,000 -> finance controller;
    // Tier 3 above 2,00,000 -> super admin. value_min is exclusive, value_max inclusive.
    await provisionUser(port, `doa-admin-4-3-${run}@example.com`, [
      {
        role: 'compliance_admin_4_3',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    const doaHeaders = await authFor(port, `doa-admin-4-3-${run}@example.com`);
    const entryIds: string[] = [];
    for (const entry of [
      { role: 'department_head_4_3', value_min: null, value_max: 50000 },
      { role: 'finance_controller_4_3', value_min: 50000, value_max: 200000 },
      { role: 'super_admin_4_3', value_min: 200000, value_max: null },
    ]) {
      const r = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { transaction_type: 'indent_approval', ...entry },
        doaHeaders,
      );
      assert.strictEqual(
        r.status,
        201,
        `DOA entry ${entry.role} failed: ${JSON.stringify(r.body)}`,
      );
      const created = r.body['entry'] as Record<string, unknown> | undefined;
      entryIds.push(
        (created?.['entry_id'] as string) ??
          ((r.body as Record<string, unknown>)['entry_id'] as string),
      );
    }
    [tier1EntryId, tier2EntryId, tier3EntryId] = entryIds as [string, string, string];
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- AC 1 ------------------------------------------------------------------

  it('AC1: an untagged requisition is rejected at capture with UNTAGGED_TRANSACTION', async () => {
    const body = raiseBody(`SKU-43-UNTAGGED-${run}`);
    delete body['business_stream'];
    const res = await makeRequest(port, 'POST', '/api/v1/indents', body, requesterHeaders);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'UNTAGGED_TRANSACTION');
  });

  it('AC1/AC4/AC6: a tagged raise commits, allocates IND-YYYY-NNNN, resolves the Tier 1 approver, and returns APPROVAL_REQUIRED', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(`SKU-43-T1-${run}`),
      requesterHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    const indent = res.body['indent'] as Record<string, unknown>;
    assert.strictEqual(indent['status'], 'raised');
    assert.match(String(indent['indent_number_ext']), /^IND-\d{4}-\d{4,}$/);
    assert.strictEqual(indent['requester_user_id'], requesterUserId);
    assert.strictEqual(indent['business_stream'], 'production');
    // 10 x 100 = 1000 INR -> Tier 1 -> department head. pg returns NUMERIC as string.
    assert.strictEqual(indent['estimated_value'], '1000.0000');
    assert.strictEqual(indent['approver_actor_id'], deptHeadUserId);
    assert.strictEqual(indent['doa_entry_id'], tier1EntryId);
    const lines = res.body['lines'] as Array<Record<string, unknown>>;
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0]!['requested_qty'], '10.000');
    assert.strictEqual(lines[0]!['line_value'], '1000.0000');
  });

  it('AC6: band selection follows the DOA registry - Tier 2 and Tier 3 amounts resolve to their authorities', async () => {
    // 1,23,000 INR (the wireframe amount) -> Tier 2 -> finance controller.
    const tier2 = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(`SKU-43-T2-${run}`, {
        lines: [
          {
            sku: `SKU-43-T2-${run}`,
            item_category: 'equipment',
            requested_qty: 1,
            uom: 'EA',
            unit_price_estimate: 123000,
          },
        ],
      }),
      requesterHeaders,
    );
    assert.strictEqual(tier2.status, 201, JSON.stringify(tier2.body));
    const t2indent = tier2.body['indent'] as Record<string, unknown>;
    assert.strictEqual(t2indent['approver_actor_id'], financeUserId);
    assert.strictEqual(t2indent['doa_entry_id'], tier2EntryId);

    // 2,50,000 INR -> Tier 3 -> super admin.
    const tier3 = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(`SKU-43-T3-${run}`, {
        lines: [
          {
            sku: `SKU-43-T3-${run}`,
            item_category: 'equipment',
            requested_qty: 1,
            uom: 'EA',
            unit_price_estimate: 250000,
          },
        ],
      }),
      requesterHeaders,
    );
    assert.strictEqual(tier3.status, 201, JSON.stringify(tier3.body));
    const t3indent = tier3.body['indent'] as Record<string, unknown>;
    assert.strictEqual(t3indent['approver_actor_id'], superAdminUserId);
    assert.strictEqual(t3indent['doa_entry_id'], tier3EntryId);
  });

  // --- AC 2 ------------------------------------------------------------------

  it('AC2: an online duplicate is flagged with DUPLICATE_EVENT and proceeds only after explicit confirmation', async () => {
    const sku = `SKU-43-DUP-${run}`;
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku),
      requesterHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const dup = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku),
      requesterHeaders,
    );
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.strictEqual(dup.body['error_code'], 'DUPLICATE_EVENT');
    const details = dup.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['confirmation_required'], true);
    assert.strictEqual(
      details['duplicate_of_indent_id'],
      (first.body['indent'] as Record<string, unknown>)['indent_id'],
    );

    const confirmed = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku, { confirm_duplicate: true }),
      requesterHeaders,
    );
    assert.strictEqual(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.strictEqual((confirmed.body['indent'] as Record<string, unknown>)['status'], 'raised');
  });

  it('AC2: the same item by a DIFFERENT requester is not a duplicate', async () => {
    const sku = `SKU-43-OTHERREQ-${run}`;
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku),
      requesterHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku),
      secondRequesterHeaders,
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
  });

  // --- AC 3 ------------------------------------------------------------------

  function edgeRaiseEnvelope(
    sku: string,
    indentId: string,
    eventId: string,
  ): Record<string, unknown> {
    return {
      event_id: eventId,
      stream_type: 'procurement',
      stream_id: indentId,
      event_type: 'indent.raised',
      payload: {
        indent_id: indentId,
        requester_user_id: requesterUserId,
        department_code: 'MAINT',
        site_id: siteA,
        business_stream: 'production',
        need_by_date: '2026-09-01',
        urgent: false,
        lines: [
          {
            sku,
            item_category: 'consumables',
            requested_qty: 10,
            uom: 'EA',
            unit_price_estimate: 100,
          },
        ],
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: requesterUserId, role: 'floor_supervisor', location_id: siteA },
        device_id: `EDGE-TAB-43-${run}`,
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: `edge-indent-${eventId}`,
    };
  }

  it('AC3: an offline-captured duplicate is held in pending-confirmation at sync time, never dropped, and the requester is notified', async () => {
    const sku = `SKU-43-OFFDUP-${run}`;
    const online = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku),
      requesterHeaders,
    );
    assert.strictEqual(online.status, 201, JSON.stringify(online.body));
    const originalId = (online.body['indent'] as Record<string, unknown>)['indent_id'];

    const heldId = randomUUID();
    const synced = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeRaiseEnvelope(sku, heldId, randomUUID()),
      requesterHeaders,
    );
    assert.strictEqual(synced.status, 201, JSON.stringify(synced.body));

    const row = await getPool().query(
      'SELECT status, duplicate_of_indent_id FROM indent WHERE indent_id = $1',
      [heldId],
    );
    assert.strictEqual(row.rows.length, 1, 'the offline capture must never be dropped');
    assert.strictEqual(row.rows[0]!['status'], 'pending-confirmation');
    assert.strictEqual(row.rows[0]!['duplicate_of_indent_id'], originalId);

    const flagEvent = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events WHERE event_type = 'indent.duplicate_flagged' AND stream_id = $1`,
      [heldId],
    );
    assert.strictEqual(flagEvent.rows[0]!['c'], 1);

    const holdNotice = await getPool().query(
      `SELECT count(*)::int AS c FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1 AND payload->'target'->>'user_id' = $2`,
      [heldId, requesterUserId],
    );
    assert.strictEqual(
      holdNotice.rows[0]!['c'],
      1,
      'requester must be notified of the duplicate hold',
    );

    // The confirmed path applies the same DUPLICATE_EVENT flow: the requester confirms and the
    // indent proceeds to raised.
    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${heldId}/confirm`,
      {},
      requesterHeaders,
    );
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    assert.strictEqual((confirm.body['indent'] as Record<string, unknown>)['status'], 'raised');
  });

  it('AC3: a held indent can be withdrawn by the requester instead', async () => {
    const sku = `SKU-43-OFFWD-${run}`;
    const online = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku),
      requesterHeaders,
    );
    assert.strictEqual(online.status, 201, JSON.stringify(online.body));

    const heldId = randomUUID();
    const synced = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeRaiseEnvelope(sku, heldId, randomUUID()),
      requesterHeaders,
    );
    assert.strictEqual(synced.status, 201, JSON.stringify(synced.body));

    const otherCannot = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${heldId}/withdraw`,
      {},
      otherWriterHeaders,
    );
    assert.strictEqual(otherCannot.status, 403, JSON.stringify(otherCannot.body));

    const withdraw = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${heldId}/withdraw`,
      {},
      requesterHeaders,
    );
    assert.strictEqual(withdraw.status, 200, JSON.stringify(withdraw.body));
    const indent = withdraw.body['indent'] as Record<string, unknown>;
    assert.strictEqual(indent['status'], 'cancelled');
    assert.strictEqual(indent['cancelled_reason'], 'withdrawn_by_requester');
  });

  it('replaying the same indent.raised envelope leaves exactly one row', async () => {
    const sku = `SKU-43-REPLAY-${run}`;
    const indentId = randomUUID();
    const envelope = edgeRaiseEnvelope(sku, indentId, randomUUID());

    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      envelope,
      requesterHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      envelope,
      requesterHeaders,
    );
    // Story 3-10 decision: persistEvent returns the EXISTING event on an idempotent replay
    // (201 with the same event_id) rather than a 409. Either way the projection must not
    // double-apply.
    assert.ok(
      replay.status === 201 || replay.status === 409,
      `unexpected replay status: ${replay.status} ${JSON.stringify(replay.body)}`,
    );
    if (replay.status === 201) {
      assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    } else {
      assert.strictEqual(replay.body['error_code'], 'DUPLICATE_EVENT');
    }

    const rows = await getPool().query(
      'SELECT count(*)::int AS c FROM indent WHERE indent_id = $1',
      [indentId],
    );
    assert.strictEqual(rows.rows[0]!['c'], 1);
    const lineRows = await getPool().query(
      'SELECT count(*)::int AS c FROM indent_line WHERE indent_id = $1',
      [indentId],
    );
    assert.strictEqual(lineRows.rows[0]!['c'], 1);
  });

  // --- AC 5 / AC 6 decisions -------------------------------------------------

  async function raiseTier1(sku: string): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(sku),
      requesterHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['indent'] as Record<string, unknown>)['indent_id'] as string;
  }

  it('SOD-01: the requester cannot approve their own indent', async () => {
    const indentId = await raiseTier1(`SKU-43-SOD-${run}`);
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      requesterHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INDENT_RAISER_CANNOT_APPROVE');
  });

  it('a procurement writer who is not the DOA-resolved approver gets NOT_RESOLVED_APPROVER', async () => {
    const indentId = await raiseTier1(`SKU-43-NRA-${run}`);
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      otherWriterHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'NOT_RESOLVED_APPROVER');
    // The Tier 2/3 authority is not the resolved Tier 1 approver either.
    const res2 = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      financeHeaders,
    );
    assert.strictEqual(res2.status, 403, JSON.stringify(res2.body));
    assert.strictEqual(res2.body['error_code'], 'NOT_RESOLVED_APPROVER');
  });

  it('AC5: an approval notifies the requester directly through the notification foundation, and double-approve returns INDENT_ALREADY_DECIDED', async () => {
    const indentId = await raiseTier1(`SKU-43-APPR-${run}`);

    const approve = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));
    const indent = approve.body['indent'] as Record<string, unknown>;
    assert.strictEqual(indent['status'], 'approved');
    assert.strictEqual(indent['decided_by'], deptHeadUserId);
    assert.ok(indent['decided_at']);

    const notice = await getPool().query(
      `SELECT payload FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1`,
      [indentId],
    );
    assert.strictEqual(notice.rows.length, 1);
    const payload = notice.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual((payload['target'] as Record<string, unknown>)['user_id'], requesterUserId);
    assert.strictEqual(payload['status_verb'], 'approved');

    // The extended user_id targeting delivers to exactly the requester.
    await runDispatchCycle();
    const delivered = await getPool().query(
      `SELECT target_user_id FROM notifications WHERE object_id = $1`,
      [indentId],
    );
    assert.strictEqual(delivered.rows.length, 1);
    assert.strictEqual(delivered.rows[0]!['target_user_id'], requesterUserId);

    const again = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'INDENT_ALREADY_DECIDED');
  });

  it('AC5: rejection requires a mandatory reason and carries it in the requester notification', async () => {
    const indentId = await raiseTier1(`SKU-43-REJ-${run}`);

    const noReason = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/reject`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(noReason.status, 400, JSON.stringify(noReason.body));
    assert.strictEqual(noReason.body['error_code'], 'INDENT_REJECTION_REASON_REQUIRED');

    const reject = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/reject`,
      { rejection_reason: 'Budget exhausted for this quarter' },
      deptHeadHeaders,
    );
    assert.strictEqual(reject.status, 200, JSON.stringify(reject.body));
    const indent = reject.body['indent'] as Record<string, unknown>;
    assert.strictEqual(indent['status'], 'rejected');
    assert.strictEqual(indent['rejection_reason'], 'Budget exhausted for this quarter');

    const notice = await getPool().query(
      `SELECT payload FROM domain_events
       WHERE stream_type = 'notification' AND event_type = 'notification.created'
         AND payload->>'object_id' = $1`,
      [indentId],
    );
    assert.strictEqual(notice.rows.length, 1);
    const payload = notice.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual((payload['target'] as Record<string, unknown>)['user_id'], requesterUserId);
    assert.strictEqual(payload['status_verb'], 'rejected');
    assert.match(String(payload['next_step']), /Budget exhausted for this quarter/);
  });

  // --- AC 4 ------------------------------------------------------------------

  it('AC4: live status is readable, and ordered carries the expected delivery date as a status attribute', async () => {
    const indentId = await raiseTier1(`SKU-43-STATUS-${run}`);

    const raised = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${indentId}`,
      undefined,
      requesterHeaders,
    );
    assert.strictEqual(raised.status, 200, JSON.stringify(raised.body));
    assert.strictEqual((raised.body['indent'] as Record<string, unknown>)['status'], 'raised');

    const approve = await makeRequest(
      port,
      'POST',
      `/api/v1/indents/${indentId}/approve`,
      {},
      deptHeadHeaders,
    );
    assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));

    // Story 4.4 owns PO creation; the ordered transition is accepted as a domain event.
    const poId = randomUUID();
    const ordered = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'procurement',
        stream_id: indentId,
        event_type: 'indent.ordered',
        payload: {
          indent_id: indentId,
          purchase_order_id: poId,
          expected_delivery_date: '2026-08-20',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: deptHeadUserId, role: 'department_head_4_3', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      deptHeadHeaders,
    );
    assert.strictEqual(ordered.status, 201, JSON.stringify(ordered.body));

    const status = await makeRequest(
      port,
      'GET',
      `/api/v1/indents/${indentId}`,
      undefined,
      requesterHeaders,
    );
    assert.strictEqual(status.status, 200, JSON.stringify(status.body));
    const indent = status.body['indent'] as Record<string, unknown>;
    assert.strictEqual(indent['status'], 'ordered');
    assert.strictEqual(indent['purchase_order_id'], poId);
    // node-postgres parses DATE at local midnight, so the JSON value shifts with the server
    // timezone; assert the stored calendar date via a text cast instead.
    assert.ok(indent['expected_delivery_date']);
    const storedDate = await getPool().query(
      'SELECT expected_delivery_date::text AS d FROM indent WHERE indent_id = $1',
      [indentId],
    );
    assert.strictEqual(storedDate.rows[0]!['d'], '2026-08-20');

    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/indents?status=ordered&mine=true',
      undefined,
      requesterHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const listed = (list.body['indents'] as Array<Record<string, unknown>>).map(
      (i) => i['indent_id'],
    );
    assert.ok(listed.includes(indentId));
  });

  it('AC1: raising without any line returns INDENT_LINE_REQUIRED', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(`SKU-43-NOLINE-${run}`, { lines: [] }),
      requesterHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INDENT_LINE_REQUIRED');
  });

  it('AC6: DOA band resolution at exact boundaries - 50000 resolves to Tier 1, 200000 resolves to Tier 2', async () => {
    // Exactly 50000 INR (1 x 50000) -> Tier 1 boundary -> department head
    const tier1Boundary = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(`SKU-43-T1BOUNDARY-${run}`, {
        lines: [
          {
            sku: `SKU-43-T1BOUNDARY-${run}`,
            item_category: 'equipment',
            requested_qty: 1,
            uom: 'EA',
            unit_price_estimate: 50000,
          },
        ],
      }),
      requesterHeaders,
    );
    assert.strictEqual(tier1Boundary.status, 201, JSON.stringify(tier1Boundary.body));
    const t1bIndent = tier1Boundary.body['indent'] as Record<string, unknown>;
    assert.strictEqual(t1bIndent['approver_actor_id'], deptHeadUserId);
    assert.strictEqual(t1bIndent['doa_entry_id'], tier1EntryId);

    // Exactly 200000 INR (1 x 200000) -> Tier 2 boundary -> finance controller
    const tier2Boundary = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      raiseBody(`SKU-43-T2BOUNDARY-${run}`, {
        lines: [
          {
            sku: `SKU-43-T2BOUNDARY-${run}`,
            item_category: 'equipment',
            requested_qty: 1,
            uom: 'EA',
            unit_price_estimate: 200000,
          },
        ],
      }),
      requesterHeaders,
    );
    assert.strictEqual(tier2Boundary.status, 201, JSON.stringify(tier2Boundary.body));
    const t2bIndent = tier2Boundary.body['indent'] as Record<string, unknown>;
    assert.strictEqual(t2bIndent['approver_actor_id'], financeUserId);
    assert.strictEqual(t2bIndent['doa_entry_id'], tier2EntryId);
  });
});

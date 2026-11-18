import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { assertItemGroupAssignable } from '../../src/read/projections/item_group.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 2.10: item group master, per-person create/edit/delete rights granted by the CEO or the
// Finance Head, item assignment, the shared assignability guard and the change notifications.
// Runs against the PRODUCTION router surface (createAppRouter) so route order and gates are
// exercised exactly as deployed.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

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

interface EventRow {
  event_id: string;
  stream_type: string;
  stream_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
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

async function eventsOfType(eventType: string): Promise<EventRow[]> {
  const result = await getPool().query(
    `SELECT event_id, stream_type, stream_id, event_type, payload, metadata
       FROM domain_events WHERE event_type = $1 ORDER BY created_at, event_version`,
    [eventType],
  );
  return result.rows as EventRow[];
}

async function eventCount(): Promise<number> {
  const result = await getPool().query(`SELECT count(*)::int AS count FROM domain_events`);
  return result.rows[0]!['count'] as number;
}

async function auditRowsFor(eventId: string): Promise<number> {
  const result = await getPool().query(
    `SELECT count(*)::int AS count FROM audit_log WHERE event_id = $1`,
    [eventId],
  );
  return result.rows[0]!['count'] as number;
}

/** Target user ids of the notification.created events sharing one correlation id. */
async function notifiedUsers(correlationId: string): Promise<string[]> {
  const result = await getPool().query(
    `SELECT payload->'target'->>'user_id' AS user_id FROM domain_events
      WHERE event_type = 'notification.created' AND metadata->>'correlation_id' = $1`,
    [correlationId],
  );
  return result.rows.map((r) => r['user_id'] as string).sort();
}

/** Distinct notification event_type to status_verb list across every notification.created event. */
async function notificationKinds(): Promise<Record<string, string[]>> {
  const result = await getPool().query(
    `SELECT DISTINCT payload->>'event_type' AS event_type, payload->>'status_verb' AS status_verb
       FROM domain_events WHERE event_type = 'notification.created'
        AND payload->>'event_type' IS NOT NULL ORDER BY 1, 2`,
  );
  const kinds: Record<string, string[]> = {};
  for (const row of result.rows) {
    (kinds[row['event_type'] as string] ??= []).push(row['status_verb'] as string);
  }
  return kinds;
}

describe('Story 2.10 Item Groups Master Integration Tests', () => {
  let server: Server;
  let port: number;
  let siteId: string;
  const ids: Record<string, string> = {};
  const hdr: Record<string, Record<string, string>> = {};

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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE lot_master, serial_master, lot_trace, stock_balance, item_master, item_group_right, item_group_recipient, item_group, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    const IC: Role = {
      role: 'inventory_controller',
      module: 'inventory',
      functionScope: 'write',
      locationId: '*',
    };
    ids['icFull'] = await provisionUser(port, 'ig-ic-full@example.com', [IC]);
    hdr['icFull'] = await authFor(port, 'ig-ic-full@example.com');
    ids['icNone'] = await provisionUser(port, 'ig-ic-none@example.com', [IC]);
    hdr['icNone'] = await authFor(port, 'ig-ic-none@example.com');

    const site = await makeRequest(
      port,
      'POST',
      '/api/v1/locations',
      { location_code: 'SITE-IG', level: 'site' },
      hdr['icFull'],
    );
    assert.strictEqual(site.status, 201, JSON.stringify(site.body));
    siteId = site.body['location_id'] as string;

    const personas: [string, string, Role[]][] = [
      [
        'wm',
        'ig-wm@example.com',
        [
          {
            role: 'warehouse_manager',
            module: 'inventory',
            functionScope: 'write',
            locationId: siteId,
          },
        ],
      ],
      [
        'ceo',
        'ig-ceo@example.com',
        [{ role: 'ceo', module: 'employee', functionScope: 'write', locationId: siteId }],
      ],
      [
        'fin',
        'ig-fin@example.com',
        [
          {
            role: 'finance_controller',
            module: 'jobwork',
            functionScope: 'write',
            locationId: '*',
          },
        ],
      ],
      [
        'siteHead',
        'ig-site-head@example.com',
        [{ role: 'site_head', module: 'jobwork', functionScope: 'write', locationId: siteId }],
      ],
      [
        'cfo',
        'ig-cfo@example.com',
        [{ role: 'cfo', module: 'jobwork', functionScope: 'write', locationId: '*' }],
      ],
      [
        'storeCtl',
        'ig-store-ctl@example.com',
        [
          {
            role: 'store_controller',
            module: 'warehouse',
            functionScope: 'read',
            locationId: siteId,
          },
        ],
      ],
      [
        'extra',
        'ig-extra@example.com',
        [{ role: 'stock_viewer', module: 'inventory', functionScope: 'read', locationId: '*' }],
      ],
      // Holds two Table 2 roles and is later put on the recipient list: one notification only.
      [
        'dual',
        'ig-dual@example.com',
        [
          { role: 'ceo', module: 'employee', functionScope: 'write', locationId: siteId },
          { role: 'cfo', module: 'jobwork', functionScope: 'write', locationId: '*' },
        ],
      ],
    ];
    for (const [key, externalId, roles] of personas) {
      ids[key] = await provisionUser(port, externalId, roles);
      hdr[key] = await authFor(port, externalId);
    }

    // Items: G1 drives set/change/clear, G2 is inactive (absent from group lookups), U1 and U2 are
    // the active ungrouped pair, U3 is inactive ungrouped, D1 (inactive) proves "ever assigned".
    for (const [sku, status] of [
      ['SKU-G1', 'active'],
      ['SKU-G2', 'inactive'],
      ['SKU-U1', 'active'],
      ['SKU-U2', 'active'],
      ['SKU-U3', 'inactive'],
      ['SKU-D1', 'inactive'],
    ]) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/items',
        { sku, uom: 'EA', valuation_method: 'fifo', business_stream: 'production', status },
        hdr['icFull'],
      );
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    }
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  /** The nine users the AC 7 fan-out reaches in the base fixture: Table 2 holders plus the list. */
  const expectedNotified = () =>
    ['icFull', 'icNone', 'ceo', 'fin', 'cfo', 'siteHead', 'storeCtl', 'extra', 'dual']
      .map((k) => ids[k]!)
      .sort();

  const rightsPut = (who: string, target: string, body: unknown) =>
    makeRequest(port, 'PUT', `/api/v1/item-groups/rights/${ids[target]}`, body, hdr[who]);

  // ---------------------------------------------------------------------------------------------
  // AC 3 - rights granted only by the CEO or the Finance Head
  // ---------------------------------------------------------------------------------------------

  it('AC 3: the CEO grants all three rights; one granted event and one audit row', async () => {
    const res = await rightsPut('ceo', 'icFull', { create: true, edit: true, delete: true });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(
      [res.body['user_id'], res.body['create'], res.body['edit'], res.body['delete']],
      [ids['icFull'], true, true, true],
    );
    const events = await eventsOfType('item_group_right.granted');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.stream_type, 'item_group');
    assert.strictEqual(events[0]!.stream_id, ids['icFull']);
    assert.deepStrictEqual(events[0]!.payload, {
      user_id: ids['icFull'],
      before: { create: false, edit: false, delete: false },
      after: { create: true, edit: true, delete: true },
    });
    assert.strictEqual(await auditRowsFor(events[0]!.event_id), 1);
  });

  it('AC 3: a grantee without inventory_controller is 400; a non-CEO granter is 403', async () => {
    const before = await eventCount();
    const toWm = await rightsPut('ceo', 'wm', { create: true, edit: false, delete: false });
    assert.strictEqual(toWm.status, 400, JSON.stringify(toWm.body));
    assert.strictEqual(toWm.body['error_code'], 'GRANTEE_NOT_INVENTORY_CONTROLLER');

    for (const who of ['icFull', 'wm', 'siteHead', 'cfo']) {
      const res = await rightsPut(who, 'icNone', { create: true, edit: false, delete: false });
      assert.strictEqual(res.status, 403, `${who}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
      assert.deepStrictEqual((res.body['details'] as Record<string, unknown>)['required_roles'], [
        'ceo',
        'finance_controller',
      ]);
    }
    const partial = await rightsPut('ceo', 'icNone', { create: true });
    assert.strictEqual(partial.status, 400, JSON.stringify(partial.body));
    assert.strictEqual(partial.body['error_code'], 'INVALID_PARAMS');
    const unknown = await makeRequest(
      port,
      'PUT',
      `/api/v1/item-groups/rights/${randomUUID()}`,
      { create: true, edit: false, delete: false },
      hdr['ceo'],
    );
    assert.strictEqual(unknown.status, 400, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'USER_NOT_FOUND');
    assert.strictEqual(await eventCount(), before, 'a refused grant writes nothing');
  });

  it('AC 3: the Finance Head grants create only; the rights list shows both holders', async () => {
    const res = await rightsPut('fin', 'icNone', { create: true, edit: false, delete: false });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/rights',
      undefined,
      hdr['fin'],
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const rights = (list.body['rights'] as Record<string, unknown>[])
      .map((r) => [r['user_id'], r['create'], r['edit'], r['delete']])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepStrictEqual(
      rights,
      [
        [ids['icFull'], true, true, true],
        [ids['icNone'], true, false, false],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const listByIc = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/rights',
      undefined,
      hdr['icFull'],
    );
    assert.strictEqual(listByIc.status, 403);
  });

  // ---------------------------------------------------------------------------------------------
  // AC 1 - create, edit, deactivate, reactivate
  // ---------------------------------------------------------------------------------------------

  it('AC 1: an inventory controller with create creates a group; others are refused', async () => {
    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'BEARINGS', name: 'Bearings' },
      hdr['icFull'],
    );
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body['code'], 'BEARINGS');
    assert.strictEqual(created.body['name'], 'Bearings');
    assert.strictEqual(created.body['status'], 'active');
    assert.strictEqual(created.body['ever_assigned'], false);
    ids['BEARINGS'] = created.body['item_group_id'] as string;
    const events = await eventsOfType('item_group.created');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.stream_id, ids['BEARINGS']);
    assert.strictEqual(await auditRowsFor(events[0]!.event_id), 1);

    const before = await eventCount();
    const noRight = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'NORIGHT', name: 'No right' },
      hdr['wm'],
    );
    assert.strictEqual(noRight.status, 403, JSON.stringify(noRight.body));
    assert.strictEqual(noRight.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepStrictEqual((noRight.body['details'] as Record<string, unknown>)['required_roles'], [
      'inventory_controller',
    ]);
    const dupCode = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'BEARINGS', name: 'Other' },
      hdr['icFull'],
    );
    assert.strictEqual(dupCode.status, 409, JSON.stringify(dupCode.body));
    assert.strictEqual(dupCode.body['error_code'], 'DUPLICATE_ITEM_GROUP_CODE');
    const dupName = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'BEARINGS2', name: 'bearings' },
      hdr['icFull'],
    );
    assert.strictEqual(dupName.status, 409, JSON.stringify(dupName.body));
    assert.strictEqual(dupName.body['error_code'], 'DUPLICATE_ITEM_GROUP_NAME');
    for (const code of ['bearings', 'A', 'X'.repeat(33)]) {
      const bad = await makeRequest(
        port,
        'POST',
        '/api/v1/item-groups',
        { code, name: `Name ${code}` },
        hdr['icFull'],
      );
      assert.strictEqual(bad.status, 400, `${code}: ${JSON.stringify(bad.body)}`);
      assert.strictEqual(bad.body['error_code'], 'INVALID_PARAMS');
    }
    assert.strictEqual(await eventCount(), before, 'refused creates write nothing');
  });

  it('AC 1: a holder with create only creates, but cannot edit or delete', async () => {
    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'SEALS', name: 'Seals' },
      hdr['icNone'],
    );
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    ids['SEALS'] = created.body['item_group_id'] as string;

    const edit = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/SEALS',
      { name: 'Seal kits' },
      hdr['icNone'],
    );
    assert.strictEqual(edit.status, 403, JSON.stringify(edit.body));
    assert.strictEqual(edit.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');
    assert.strictEqual((edit.body['details'] as Record<string, unknown>)['right'], 'edit');

    const del = await makeRequest(
      port,
      'DELETE',
      '/api/v1/item-groups/SEALS',
      undefined,
      hdr['icNone'],
    );
    assert.strictEqual(del.status, 403, JSON.stringify(del.body));
    assert.strictEqual(del.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');
    assert.strictEqual((del.body['details'] as Record<string, unknown>)['right'], 'delete');
  });

  it('AC 3: the Finance Head revokes; the holder then has no create right', async () => {
    const res = await rightsPut('fin', 'icNone', { create: false, edit: false, delete: false });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const revoked = await eventsOfType('item_group_right.revoked');
    assert.strictEqual(revoked.length, 1);
    assert.deepStrictEqual(revoked[0]!.payload, {
      user_id: ids['icNone'],
      before: { create: true, edit: false, delete: false },
      after: { create: false, edit: false, delete: false },
    });
    assert.strictEqual(await auditRowsFor(revoked[0]!.event_id), 1);
    const rows = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [
      ids['icNone'],
    ]);
    assert.strictEqual(rows.rows.length, 0, 'all false removes the row');

    const create = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'GASKETS', name: 'Gaskets' },
      hdr['icNone'],
    );
    assert.strictEqual(create.status, 403, JSON.stringify(create.body));
    assert.strictEqual(create.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');
    assert.strictEqual((create.body['details'] as Record<string, unknown>)['right'], 'create');
  });

  it('AC 1: rename, deactivate and reactivate each write one updated event', async () => {
    const steps: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ name: 'Seal kits' }, { name: 'Seal kits', status: 'active' }],
      [{ status: 'inactive' }, { name: 'Seal kits', status: 'inactive' }],
      [{ status: 'active' }, { name: 'Seal kits', status: 'active' }],
    ];
    for (const [body, expected] of steps) {
      const prior = (await eventsOfType('item_group.updated')).length;
      const res = await makeRequest(
        port,
        'PATCH',
        '/api/v1/item-groups/SEALS',
        body,
        hdr['icFull'],
      );
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body['name'], expected['name']);
      assert.strictEqual(res.body['status'], expected['status']);
      const events = await eventsOfType('item_group.updated');
      assert.strictEqual(events.length, prior + 1);
      const payload = events.at(-1)!.payload;
      assert.ok(payload['before'] && payload['after'], JSON.stringify(payload));
      assert.strictEqual(
        (payload['after'] as Record<string, unknown>)['status'],
        expected['status'],
      );
      assert.strictEqual(await auditRowsFor(events.at(-1)!.event_id), 1);
    }

    const before = await eventCount();
    const withCode = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/SEALS',
      { code: 'SEALS2' },
      hdr['icFull'],
    );
    assert.strictEqual(withCode.status, 400, JSON.stringify(withCode.body));
    const empty = await makeRequest(port, 'PATCH', '/api/v1/item-groups/SEALS', {}, hdr['icFull']);
    assert.strictEqual(empty.status, 400, JSON.stringify(empty.body));
    const unknown = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/NOSUCH',
      { name: 'x' },
      hdr['icFull'],
    );
    assert.strictEqual(unknown.status, 404, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'ITEM_GROUP_NOT_FOUND');
    const badStatus = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/SEALS',
      { status: 'retired' },
      hdr['icFull'],
    );
    assert.strictEqual(badStatus.status, 400, JSON.stringify(badStatus.body));
    assert.strictEqual(await eventCount(), before);
  });

  // ---------------------------------------------------------------------------------------------
  // AC 4, AC 6 - assignment and the shared guard
  // ---------------------------------------------------------------------------------------------

  it('AC 4: set, change and clear a group on an item ride item.updated', async () => {
    const steps: [string | null, string | null][] = [
      [ids['BEARINGS']!, null],
      [ids['SEALS']!, ids['BEARINGS']!],
      [null, ids['SEALS']!],
      [ids['BEARINGS']!, null],
    ];
    for (const [value, previous] of steps) {
      const prior = (await eventsOfType('item.updated')).length;
      const res = await makeRequest(
        port,
        'PATCH',
        '/api/v1/items/SKU-G1',
        { item_group_id: value },
        hdr['icFull'],
      );
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body['item_group_id'], value);
      const events = await eventsOfType('item.updated');
      assert.strictEqual(events.length, prior + 1);
      const payload = events.at(-1)!.payload;
      assert.strictEqual((payload['before'] as Record<string, unknown>)['item_group_id'], previous);
      assert.strictEqual((payload['after'] as Record<string, unknown>)['item_group_id'], value);
    }
    const flags = await getPool().query(
      `SELECT code, ever_assigned FROM item_group WHERE code IN ('BEARINGS', 'SEALS') ORDER BY code`,
    );
    assert.deepStrictEqual(
      flags.rows.map((r) => [r['code'], r['ever_assigned']]),
      [
        ['BEARINGS', true],
        ['SEALS', true],
      ],
    );
    // SKU-G2 (inactive) is grouped too, so the lookup below proves inactive items are hidden.
    const g2 = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-G2',
      { item_group_id: ids['BEARINGS'] },
      hdr['icFull'],
    );
    assert.strictEqual(g2.status, 200, JSON.stringify(g2.body));
  });

  it('AC 4: other item fields keep the inventory gate; item_group_id needs the edit right', async () => {
    const uom = await makeRequest(port, 'PATCH', '/api/v1/items/SKU-U1', { uom: 'BOX' }, hdr['wm']);
    assert.strictEqual(uom.status, 200, JSON.stringify(uom.body));

    const before = await eventCount();
    const wmGroup = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U1',
      { uom: 'EA', item_group_id: ids['BEARINGS'] },
      hdr['wm'],
    );
    assert.strictEqual(wmGroup.status, 403, JSON.stringify(wmGroup.body));
    assert.strictEqual(wmGroup.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepStrictEqual((wmGroup.body['details'] as Record<string, unknown>)['required_roles'], [
      'inventory_controller',
    ]);
    const icGroup = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U1',
      { item_group_id: ids['BEARINGS'] },
      hdr['icNone'],
    );
    assert.strictEqual(icGroup.status, 403, JSON.stringify(icGroup.body));
    assert.strictEqual(icGroup.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');
    assert.strictEqual(await eventCount(), before);
    const item = await makeRequest(port, 'GET', '/api/v1/items/SKU-U1', undefined, hdr['icFull']);
    assert.strictEqual(item.body['uom'], 'BOX');
    assert.strictEqual(item.body['item_group_id'], null);
  });

  it('AC 4: an item created with a group carries it and marks the group used', async () => {
    const created = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'FILTERS', name: 'Filters' },
      hdr['icFull'],
    );
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const item = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku: 'SKU-F1',
        uom: 'EA',
        valuation_method: 'fifo',
        business_stream: 'production',
        status: 'inactive',
        item_group_id: created.body['item_group_id'],
      },
      hdr['icFull'],
    );
    assert.strictEqual(item.status, 201, JSON.stringify(item.body));
    assert.strictEqual(item.body['item_group_id'], created.body['item_group_id']);
    const flag = await getPool().query(
      `SELECT ever_assigned FROM item_group WHERE code = 'FILTERS'`,
    );
    assert.strictEqual(flag.rows[0]!['ever_assigned'], true);

    const refused = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku: 'SKU-F2',
        uom: 'EA',
        valuation_method: 'fifo',
        business_stream: 'production',
        item_group_id: created.body['item_group_id'],
      },
      hdr['wm'],
    );
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    const none = await getPool().query(`SELECT 1 FROM item_master WHERE sku = 'SKU-F2'`);
    assert.strictEqual(none.rows.length, 0);
  });

  it('AC 6: unknown, malformed and inactive groups are refused and nothing is written', async () => {
    const deactivate = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'OLD', name: 'Old group' },
      hdr['icFull'],
    );
    assert.strictEqual(deactivate.status, 201);
    ids['OLD'] = deactivate.body['item_group_id'] as string;
    const off = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/OLD',
      { status: 'inactive' },
      hdr['icFull'],
    );
    assert.strictEqual(off.status, 200);

    const itemBefore = await getPool().query(`SELECT * FROM item_master WHERE sku = 'SKU-G1'`);
    const before = await eventCount();
    for (const [value, code] of [
      [randomUUID(), 'ITEM_GROUP_NOT_FOUND'],
      ['not-a-uuid', 'ITEM_GROUP_NOT_FOUND'],
      [42, 'ITEM_GROUP_NOT_FOUND'],
      [ids['OLD'], 'ITEM_GROUP_INACTIVE'],
    ] as [unknown, string][]) {
      const res = await makeRequest(
        port,
        'PATCH',
        '/api/v1/items/SKU-G1',
        { item_group_id: value },
        hdr['icFull'],
      );
      assert.strictEqual(res.status, 400, `${String(value)}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body['error_code'], code);
    }
    const itemAfter = await getPool().query(`SELECT * FROM item_master WHERE sku = 'SKU-G1'`);
    assert.deepStrictEqual(itemAfter.rows, itemBefore.rows);
    assert.strictEqual(await eventCount(), before);
    const oldFlag = await getPool().query(
      `SELECT ever_assigned FROM item_group WHERE code = 'OLD'`,
    );
    assert.strictEqual(oldFlag.rows[0]!['ever_assigned'], false);
  });

  it('AC 6: assertItemGroupAssignable is the shared guard (D6)', async () => {
    const ok = await assertItemGroupAssignable(ids['BEARINGS']);
    assert.strictEqual(ok.code, 'BEARINGS');
    await assert.rejects(assertItemGroupAssignable(ids['OLD']), (err: unknown) => {
      const e = err as { statusCode?: number; errorCode?: string };
      assert.strictEqual(e.statusCode, 400);
      assert.strictEqual(e.errorCode, 'ITEM_GROUP_INACTIVE');
      return true;
    });
    for (const value of [randomUUID(), 'nope', null, undefined, 7]) {
      await assert.rejects(assertItemGroupAssignable(value), (err: unknown) => {
        const e = err as { statusCode?: number; errorCode?: string };
        assert.strictEqual(e.statusCode, 400);
        assert.strictEqual(e.errorCode, 'ITEM_GROUP_NOT_FOUND');
        return true;
      });
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const locked = await assertItemGroupAssignable(ids['SEALS'], client);
      assert.strictEqual(locked.code, 'SEALS');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // AC 4, AC 5 - group lookup and the ungrouped report
  // ---------------------------------------------------------------------------------------------

  it('AC 4: the group items lookup returns active items only', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/BEARINGS/items',
      undefined,
      hdr['wm'],
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual((res.body['item_group'] as Record<string, unknown>)['code'], 'BEARINGS');
    assert.deepStrictEqual(
      (res.body['items'] as Record<string, unknown>[]).map((i) => i['sku']),
      ['SKU-G1'],
    );
    const one = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/BEARINGS',
      undefined,
      hdr['wm'],
    );
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body['code'], 'BEARINGS');
    const missing = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/NOSUCH',
      undefined,
      hdr['wm'],
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'ITEM_GROUP_NOT_FOUND');
    const list = await makeRequest(port, 'GET', '/api/v1/item-groups', undefined, hdr['extra']);
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.deepStrictEqual(
      (list.body['item_groups'] as Record<string, unknown>[]).map((g) => g['code']),
      ['BEARINGS', 'FILTERS', 'OLD', 'SEALS'],
    );
  });

  it('AC 5: the ungrouped report lists active ungrouped items by SKU', async () => {
    const res = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/ungrouped-items',
      undefined,
      hdr['wm'],
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(
      (res.body['items'] as Record<string, unknown>[]).map((i) => i['sku']),
      ['SKU-U1', 'SKU-U2'],
    );
    assert.strictEqual(res.body['count'], 2);
    const denied = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/ungrouped-items',
      undefined,
      hdr['ceo'],
    );
    assert.strictEqual(denied.status, 403, 'no inventory read, no report');
  });

  // ---------------------------------------------------------------------------------------------
  // AC 2 - delete only a never-used group
  // ---------------------------------------------------------------------------------------------

  it('AC 2: a never-used group deletes; a used or once-used group is 409', async () => {
    const fresh = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'TEMP', name: 'Temporary' },
      hdr['icFull'],
    );
    assert.strictEqual(fresh.status, 201);
    const del = await makeRequest(
      port,
      'DELETE',
      '/api/v1/item-groups/TEMP',
      undefined,
      hdr['icFull'],
    );
    assert.strictEqual(del.status, 204, JSON.stringify(del.body));
    const deleted = await eventsOfType('item_group.deleted');
    assert.strictEqual(deleted.length, 1);
    assert.strictEqual(deleted[0]!.stream_id, fresh.body['item_group_id']);
    assert.strictEqual(await auditRowsFor(deleted[0]!.event_id), 1);
    const gone = await getPool().query(`SELECT 1 FROM item_group WHERE code = 'TEMP'`);
    assert.strictEqual(gone.rows.length, 0);

    // In use now.
    const before = await eventCount();
    const inUse = await makeRequest(
      port,
      'DELETE',
      '/api/v1/item-groups/BEARINGS',
      undefined,
      hdr['icFull'],
    );
    assert.strictEqual(inUse.status, 409, JSON.stringify(inUse.body));
    assert.strictEqual(inUse.body['error_code'], 'ITEM_GROUP_IN_USE');
    assert.match(inUse.body['message'] as string, /deactivate it instead/);

    // Used once, emptied since (D9).
    const once = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'ONCE', name: 'Used once' },
      hdr['icFull'],
    );
    assert.strictEqual(once.status, 201);
    const set = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-D1',
      { item_group_id: once.body['item_group_id'] },
      hdr['icFull'],
    );
    assert.strictEqual(set.status, 200);
    const clear = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-D1',
      { item_group_id: null },
      hdr['icFull'],
    );
    assert.strictEqual(clear.status, 200);
    const mid = await eventCount();
    const onceDel = await makeRequest(
      port,
      'DELETE',
      '/api/v1/item-groups/ONCE',
      undefined,
      hdr['icFull'],
    );
    assert.strictEqual(onceDel.status, 409, JSON.stringify(onceDel.body));
    assert.strictEqual(onceDel.body['error_code'], 'ITEM_GROUP_IN_USE');
    assert.strictEqual(await eventCount(), mid);
    assert.ok(mid > before);

    const unknown = await makeRequest(
      port,
      'DELETE',
      '/api/v1/item-groups/NOSUCH',
      undefined,
      hdr['icFull'],
    );
    assert.strictEqual(unknown.status, 404);
  });

  // ---------------------------------------------------------------------------------------------
  // AC 7 - everyone is told, once
  // ---------------------------------------------------------------------------------------------

  it('AC 7: only the CEO or Finance Head maintains the recipient list', async () => {
    const before = await eventCount();
    const byIc = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups/recipients',
      { user_id: ids['extra'] },
      hdr['icFull'],
    );
    assert.strictEqual(byIc.status, 403, JSON.stringify(byIc.body));
    assert.strictEqual(byIc.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const unknown = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups/recipients',
      { user_id: randomUUID() },
      hdr['ceo'],
    );
    assert.strictEqual(unknown.status, 400, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'USER_NOT_FOUND');
    assert.strictEqual(await eventCount(), before);

    for (const [who, target] of [
      ['ceo', 'extra'],
      ['fin', 'dual'],
      ['fin', 'wm'],
    ]) {
      const res = await makeRequest(
        port,
        'POST',
        '/api/v1/item-groups/recipients',
        { user_id: ids[target!] },
        hdr[who!],
      );
      assert.strictEqual(res.status, 201, `${target}: ${JSON.stringify(res.body)}`);
    }
    const added = await eventsOfType('item_group_recipient.added');
    assert.strictEqual(added.length, 3);
    for (const event of added) assert.strictEqual(await auditRowsFor(event.event_id), 1);

    const removed = await makeRequest(
      port,
      'DELETE',
      `/api/v1/item-groups/recipients/${ids['wm']}`,
      undefined,
      hdr['ceo'],
    );
    assert.strictEqual(removed.status, 204, JSON.stringify(removed.body));
    const removedEvents = await eventsOfType('item_group_recipient.removed');
    assert.strictEqual(removedEvents.length, 1);
    assert.deepStrictEqual(removedEvents[0]!.payload, { user_id: ids['wm'] });

    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/item-groups/recipients',
      undefined,
      hdr['fin'],
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    assert.deepStrictEqual(
      (list.body['recipients'] as Record<string, unknown>[]).map((r) => r['user_id']).sort(),
      [ids['extra'], ids['dual']].sort(),
    );
  });

  it('AC 7: a change notifies Table 2 holders, the list and the actor, once each', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'NOTIFY', name: 'Notify me' },
      hdr['icFull'],
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const created = (await eventsOfType('item_group.created')).find(
      (e) => e.stream_id === res.body['item_group_id'],
    )!;
    const correlationId = created.metadata['correlation_id'] as string;
    const expected = expectedNotified();
    assert.deepStrictEqual(await notifiedUsers(correlationId), expected);
    assert.ok(!(await notifiedUsers(correlationId)).includes(ids['wm']!), 'wm is not notified');

    await runDispatchCycle(500);
    const rows = await getPool().query(
      `SELECT n.target_user_id, n.object_type, n.object_id FROM notifications n
         JOIN domain_events e ON e.event_id = n.source_event_id
        WHERE e.metadata->>'correlation_id' = $1`,
      [correlationId],
    );
    assert.deepStrictEqual(
      rows.rows.map((r) => r['target_user_id'] as string).sort(),
      [...expected].sort(),
    );
    for (const row of rows.rows) {
      assert.strictEqual(row['object_type'], 'item_group');
      assert.strictEqual(row['object_id'], 'NOTIFY');
    }
  });

  it('AC 7: assignment, rights and recipient changes notify; refused writes do not', async () => {
    const assign = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U2',
      { item_group_id: ids['SEALS'] },
      hdr['icFull'],
    );
    assert.strictEqual(assign.status, 200, JSON.stringify(assign.body));
    const updated = (await eventsOfType('item.updated')).at(-1)!;
    const users = await notifiedUsers(updated.metadata['correlation_id'] as string);
    assert.deepStrictEqual(users, expectedNotified());

    // A non-group item edit does not notify.
    const plain = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U2',
      { uom: 'KG' },
      hdr['icFull'],
    );
    assert.strictEqual(plain.status, 200);
    const plainEvent = (await eventsOfType('item.updated')).at(-1)!;
    assert.deepStrictEqual(
      await notifiedUsers(plainEvent.metadata['correlation_id'] as string),
      [],
    );

    const grant = await rightsPut('ceo', 'icNone', { create: false, edit: true, delete: false });
    assert.strictEqual(grant.status, 200);
    const grantEvent = (await eventsOfType('item_group_right.granted')).at(-1)!;
    assert.deepStrictEqual(
      await notifiedUsers(grantEvent.metadata['correlation_id'] as string),
      expectedNotified(),
    );

    const recipientEvent = (await eventsOfType('item_group_recipient.removed')).at(-1)!;
    // Recipients resolve after the change, so the removed user (wm) is not told; the actor (ceo)
    // is in the Table 2 set already.
    const recipientUsers = await notifiedUsers(recipientEvent.metadata['correlation_id'] as string);
    assert.deepStrictEqual(recipientUsers, expectedNotified());
    assert.ok(!recipientUsers.includes(ids['wm']!));

    const notificationsBefore = (await eventsOfType('notification.created')).length;
    const refused = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups',
      { code: 'NOTIFY', name: 'Again' },
      hdr['icFull'],
    );
    assert.strictEqual(refused.status, 409);
    assert.strictEqual((await eventsOfType('notification.created')).length, notificationsBefore);
  });

  // ---------------------------------------------------------------------------------------------
  // Code review 2026-10-02 patches: self-grant, deactivated users, no-ops, event types, actor role
  // ---------------------------------------------------------------------------------------------

  const IC_ROLE: Role = {
    role: 'inventory_controller',
    module: 'inventory',
    functionScope: 'write',
    locationId: '*',
  };

  it('AC 3: only a CEO holder may grant rights to themselves', async () => {
    ids['finIc'] = await provisionUser(port, 'ig-fin-ic@example.com', [
      { role: 'finance_controller', module: 'jobwork', functionScope: 'write', locationId: '*' },
      IC_ROLE,
    ]);
    hdr['finIc'] = await authFor(port, 'ig-fin-ic@example.com');
    ids['ceoIc'] = await provisionUser(port, 'ig-ceo-ic@example.com', [
      { role: 'ceo', module: 'employee', functionScope: 'write', locationId: siteId },
      IC_ROLE,
    ]);
    hdr['ceoIc'] = await authFor(port, 'ig-ceo-ic@example.com');

    const before = await eventCount();
    const refused = await rightsPut('finIc', 'finIc', { create: true, edit: true, delete: true });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual(refused.body['error_code'], 'ITEM_GROUP_SELF_GRANT_REFUSED');
    assert.strictEqual(await eventCount(), before, 'a refused self-grant writes nothing');
    const none = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [
      ids['finIc'],
    ]);
    assert.strictEqual(none.rows.length, 0);

    // The CEO may; a Finance Head may still grant to someone else, or revoke their own.
    const ceoSelf = await rightsPut('ceoIc', 'ceoIc', { create: true, edit: false, delete: false });
    assert.strictEqual(ceoSelf.status, 200, JSON.stringify(ceoSelf.body));
    const toFinIc = await rightsPut('ceo', 'finIc', { create: false, edit: true, delete: false });
    assert.strictEqual(toFinIc.status, 200, JSON.stringify(toFinIc.body));
    const selfRevoke = await rightsPut('finIc', 'finIc', {
      create: false,
      edit: false,
      delete: false,
    });
    assert.strictEqual(selfRevoke.status, 200, JSON.stringify(selfRevoke.body));
    const gone = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [
      ids['finIc'],
    ]);
    assert.strictEqual(gone.rows.length, 0, 'a self-revoke is open to a Finance Head');
  });

  it('AC 3: rights of a deactivated user can be revoked but not granted', async () => {
    ids['gone'] = await provisionUser(port, 'ig-gone@example.com', [IC_ROLE]);
    const grant = await rightsPut('ceo', 'gone', { create: false, edit: true, delete: false });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    await getPool().query(`UPDATE users SET active = false WHERE user_id = $1`, [ids['gone']]);

    const before = await eventCount();
    const regrant = await rightsPut('ceo', 'gone', { create: true, edit: true, delete: false });
    assert.strictEqual(regrant.status, 400, JSON.stringify(regrant.body));
    assert.strictEqual(regrant.body['error_code'], 'USER_NOT_FOUND');
    assert.strictEqual(await eventCount(), before);

    const revoke = await rightsPut('ceo', 'gone', { create: false, edit: false, delete: false });
    assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
    const revoked = (await eventsOfType('item_group_right.revoked')).at(-1)!;
    assert.strictEqual(revoked.stream_id, ids['gone']);
    assert.deepStrictEqual(revoked.payload['before'], { create: false, edit: true, delete: false });
    const rows = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [
      ids['gone'],
    ]);
    assert.strictEqual(rows.rows.length, 0);
  });

  it('AC 7: a change that changes nothing writes no event and no notice', async () => {
    const notices = async () => (await eventsOfType('notification.created')).length;
    const before = await eventCount();
    const noticesBefore = await notices();

    // Group PATCH with the stored name and status.
    const same = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/SEALS',
      { name: 'Seal kits', status: 'active' },
      hdr['icFull'],
    );
    assert.strictEqual(same.status, 200, JSON.stringify(same.body));
    assert.strictEqual(same.body['name'], 'Seal kits');

    // Rights PUT equal to the stored rights, and a revoke for a user with no row.
    const stored = await getPool().query(
      `SELECT can_create, can_edit, can_delete, granted_by, updated_at
         FROM item_group_right WHERE user_id = $1`,
      [ids['icNone']],
    );
    assert.deepStrictEqual(
      [stored.rows[0]!['can_create'], stored.rows[0]!['can_edit'], stored.rows[0]!['can_delete']],
      [false, true, false],
    );
    const equal = await rightsPut('ceo', 'icNone', { create: false, edit: true, delete: false });
    assert.strictEqual(equal.status, 200, JSON.stringify(equal.body));
    assert.strictEqual(equal.body['edit'], true);
    const after = await getPool().query(
      `SELECT granted_by, updated_at FROM item_group_right WHERE user_id = $1`,
      [ids['icNone']],
    );
    assert.deepStrictEqual(after.rows[0], {
      granted_by: stored.rows[0]!['granted_by'],
      updated_at: stored.rows[0]!['updated_at'],
    });
    const noRow = await rightsPut('ceo', 'gone', { create: false, edit: false, delete: false });
    assert.strictEqual(noRow.status, 200, JSON.stringify(noRow.body));
    assert.strictEqual(noRow.body['create'], false);

    assert.strictEqual(await eventCount(), before, 'no event for any of the three no-ops');
    assert.strictEqual(await notices(), noticesBefore);

    // Item PATCH echoing the current group needs no right and still works once the group is
    // deactivated; nothing is notified.
    const prior = (await eventsOfType('item.updated')).length;
    const echo = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U2',
      { item_group_id: ids['SEALS'], uom: 'LB' },
      hdr['wm'],
    );
    assert.strictEqual(echo.status, 200, JSON.stringify(echo.body));
    assert.strictEqual(echo.body['item_group_id'], ids['SEALS']);
    const off = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/SEALS',
      { status: 'inactive' },
      hdr['icFull'],
    );
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    const echoInactive = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U2',
      { item_group_id: ids['SEALS'], uom: 'KG' },
      hdr['wm'],
    );
    assert.strictEqual(echoInactive.status, 200, JSON.stringify(echoInactive.body));
    const on = await makeRequest(
      port,
      'PATCH',
      '/api/v1/item-groups/SEALS',
      { status: 'active' },
      hdr['icFull'],
    );
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    const echoEvents = (await eventsOfType('item.updated')).slice(prior);
    assert.strictEqual(echoEvents.length, 2);
    for (const event of echoEvents) {
      assert.deepStrictEqual(await notifiedUsers(event.metadata['correlation_id'] as string), []);
    }

    // POST with an explicit null group needs no right; PATCH of an unknown SKU is 404.
    const nullCreate = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku: 'SKU-N1',
        uom: 'EA',
        valuation_method: 'fifo',
        business_stream: 'production',
        item_group_id: null,
      },
      hdr['wm'],
    );
    assert.strictEqual(nullCreate.status, 201, JSON.stringify(nullCreate.body));
    assert.strictEqual(nullCreate.body['item_group_id'], null);
    const unknownSku = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/NO-SUCH-SKU',
      { item_group_id: ids['SEALS'] },
      hdr['wm'],
    );
    assert.strictEqual(unknownSku.status, 404, JSON.stringify(unknownSku.body));
    assert.strictEqual(unknownSku.body['error_code'], 'ITEM_NOT_FOUND');
  });

  it("AC 1: a caller without the inventory write gate gets the gate's 403 first", async () => {
    const before = await eventCount();
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/v1/item-groups', { code: 'GATED', name: 'Gated' }],
      ['PATCH', '/api/v1/item-groups/SEALS', { name: 'Gated name' }],
      ['DELETE', '/api/v1/item-groups/SEALS', undefined],
    ];
    for (const [who, code] of [
      ['ceo', 'MODULE_ACCESS_DENIED'],
      ['fin', 'MODULE_ACCESS_DENIED'],
      ['extra', 'FUNCTION_ACCESS_DENIED'],
    ] as const) {
      for (const [method, path, body] of attempts) {
        const res = await makeRequest(port, method, path, body, hdr[who]);
        assert.strictEqual(
          res.status,
          403,
          `${who} ${method} ${path}: ${JSON.stringify(res.body)}`,
        );
        assert.strictEqual(res.body['error_code'], code, `${who} ${method} ${path}`);
      }
    }
    assert.strictEqual(await eventCount(), before);
    const seals = await getPool().query(`SELECT name FROM item_group WHERE code = 'SEALS'`);
    assert.strictEqual(seals.rows[0]!['name'], 'Seal kits');
  });

  it('AC 7: recipient list errors write nothing', async () => {
    const before = await eventCount();
    const duplicate = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups/recipients',
      { user_id: ids['extra'] },
      hdr['ceo'],
    );
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'ITEM_GROUP_RECIPIENT_EXISTS');
    const notMember = await makeRequest(
      port,
      'DELETE',
      `/api/v1/item-groups/recipients/${ids['wm']}`,
      undefined,
      hdr['ceo'],
    );
    assert.strictEqual(notMember.status, 404, JSON.stringify(notMember.body));
    assert.strictEqual(notMember.body['error_code'], 'ITEM_GROUP_RECIPIENT_NOT_FOUND');
    const deactivated = await makeRequest(
      port,
      'POST',
      '/api/v1/item-groups/recipients',
      { user_id: ids['gone'] },
      hdr['ceo'],
    );
    assert.strictEqual(deactivated.status, 400, JSON.stringify(deactivated.body));
    assert.strictEqual(deactivated.body['error_code'], 'USER_NOT_FOUND');
    assert.strictEqual(await eventCount(), before);
  });

  it('AC 3: the item event and its notice carry the inventory_controller role', async () => {
    // warehouse_manager is listed first, so the module gate authorizes under that role.
    ids['wmIc'] = await provisionUser(port, 'ig-wm-ic@example.com', [
      {
        role: 'warehouse_manager',
        module: 'inventory',
        functionScope: 'write',
        locationId: siteId,
      },
      IC_ROLE,
    ]);
    hdr['wmIc'] = await authFor(port, 'ig-wm-ic@example.com');
    const grant = await rightsPut('ceo', 'wmIc', { create: false, edit: true, delete: false });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));

    const res = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U1',
      { item_group_id: ids['SEALS'] },
      hdr['wmIc'],
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const event = (await eventsOfType('item.updated')).at(-1)!;
    assert.strictEqual(
      (event.metadata['actor'] as Record<string, unknown>)['role'],
      'inventory_controller',
    );
    const audit = await getPool().query(`SELECT role FROM audit_log WHERE event_id = $1`, [
      event.event_id,
    ]);
    assert.deepStrictEqual(
      audit.rows.map((r) => r['role']),
      ['inventory_controller'],
    );
    const notices = await getPool().query(
      `SELECT DISTINCT metadata->'actor'->>'role' AS role FROM domain_events
        WHERE event_type = 'notification.created' AND metadata->>'correlation_id' = $1`,
      [event.metadata['correlation_id']],
    );
    assert.deepStrictEqual(
      notices.rows.map((r) => r['role']),
      ['inventory_controller'],
    );

    // An edit that leaves the group alone keeps the module gate's role.
    const plain = await makeRequest(
      port,
      'PATCH',
      '/api/v1/items/SKU-U1',
      { uom: 'PCS' },
      hdr['wmIc'],
    );
    assert.strictEqual(plain.status, 200, JSON.stringify(plain.body));
    const plainEvent = (await eventsOfType('item.updated')).at(-1)!;
    assert.strictEqual(
      (plainEvent.metadata['actor'] as Record<string, unknown>)['role'],
      'warehouse_manager',
    );
  });

  it('AC 7: every notification carries the domain event type that caused it', async () => {
    // A rights reduction is a change, not a grant (owner ruling 2026-10-02).
    const changed = await rightsPut('ceo', 'icNone', { create: true, edit: false, delete: false });
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    const changedEvent = (await eventsOfType('item_group_right.changed')).at(-1)!;
    assert.deepStrictEqual(changedEvent.payload['before'], {
      create: false,
      edit: true,
      delete: false,
    });

    const orphans = await getPool().query(
      `SELECT n.payload->>'event_type' AS event_type FROM domain_events n
        WHERE n.event_type = 'notification.created' AND NOT EXISTS (
          SELECT 1 FROM domain_events e
           WHERE e.metadata->>'correlation_id' = n.metadata->>'correlation_id'
             AND e.event_type = n.payload->>'event_type' AND e.stream_type <> 'notification')`,
    );
    assert.deepStrictEqual(orphans.rows, [], 'each notice names the event written with it');

    const kinds = await notificationKinds();
    assert.deepStrictEqual(kinds['item_group.created'], ['Item group created']);
    assert.deepStrictEqual(kinds['item_group.deleted'], ['Item group deleted']);
    assert.deepStrictEqual(
      kinds['item_group.updated'],
      ['Item group deactivated', 'Item group reactivated', 'Item group updated'].sort(),
    );
    assert.deepStrictEqual(kinds['item_group_right.granted'], ['Item group rights granted']);
    assert.deepStrictEqual(kinds['item_group_right.changed'], ['Item group rights changed']);
    assert.deepStrictEqual(kinds['item_group_right.revoked'], ['Item group rights revoked']);
    assert.deepStrictEqual(kinds['item_group_recipient.added'], ['Item group recipient added']);
    assert.deepStrictEqual(kinds['item_group_recipient.removed'], ['Item group recipient removed']);
    assert.deepStrictEqual(
      kinds['item.updated'],
      ['Item group changed', 'Item group cleared', 'Item group set'].sort(),
    );
    assert.deepStrictEqual(kinds['item.created'], ['Item group set']);
  });
});

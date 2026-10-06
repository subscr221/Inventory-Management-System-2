import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { runDispatchCycle } from '../../src/notify/dispatch.js';
import { assertItemGroupAssignable } from '../../src/read/projections/item_group.js';

// Story 2.10: item group master. Runs against the PRODUCTION router surface (createAppRouter) so
// route order and gates are exercised exactly as deployed.

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

async function eventCount(eventType: string): Promise<number> {
  const r = await getPool().query(
    `SELECT count(*)::int AS count FROM domain_events WHERE event_type = $1`,
    [eventType],
  );
  return r.rows[0]!['count'] as number;
}

async function auditCount(): Promise<number> {
  const r = await getPool().query(`SELECT count(*)::int AS count FROM audit_log`);
  return r.rows[0]!['count'] as number;
}

async function allEventCount(): Promise<number> {
  const r = await getPool().query(`SELECT count(*)::int AS count FROM domain_events`);
  return r.rows[0]!['count'] as number;
}

/** Two distinct sites, so a site-scoped recipient is never the same site as another. */
const SITE_A = 'SITE-210-A';
const SITE_B = 'SITE-210-B';

describe('Story 2.10 Item Group Master Integration Tests', () => {
  let server: Server;
  let port: number;
  const h: Record<string, Record<string, string>> = {};
  const ids: Record<string, string> = {};

  const inv = (role: string, scope: 'read' | 'write' = 'write'): Role => ({
    role,
    module: 'inventory',
    functionScope: scope,
    locationId: '*',
  });

  const call = (who: string, method: string, path: string, body?: unknown): Promise<HttpResult> =>
    makeRequest(port, method, path, body, h[who]);

  async function createGroup(code: string, name: string): Promise<HttpResult> {
    return call('icFull', 'POST', '/api/v1/item-groups', { code, name });
  }

  async function createItem(sku: string): Promise<void> {
    const res = await call('icFull', 'POST', '/api/v1/items', {
      sku,
      uom: 'ea',
      valuation_method: 'fifo',
      business_stream: 'production',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
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
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE item_group_right, item_group_recipient, item_group, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    const personas: [string, Role[]][] = [
      ['icFull', [inv('inventory_controller')]],
      ['icNone', [inv('inventory_controller')]],
      ['wm', [inv('warehouse_manager')]],
      ['ceo', [{ role: 'ceo', module: 'config', functionScope: 'write', locationId: '*' }]],
      [
        'fin',
        [
          {
            role: 'finance_controller',
            module: 'finance',
            functionScope: 'write',
            locationId: '*',
          },
        ],
      ],
      // siteHead and storeCtl are site-scoped on purpose, not enterprise-wide: Table 2 says they
      // are notified at every site because groups are global, so resolveItemGroupRecipients must
      // find them without matching on location. Provisioning them at '*' would hide a regression
      // that added a location filter.
      [
        'siteHead',
        [{ role: 'site_head', module: 'jobwork', functionScope: 'read', locationId: SITE_A }],
      ],
      ['cfo', [{ role: 'cfo', module: 'finance', functionScope: 'read', locationId: '*' }]],
      [
        'storeCtl',
        [
          {
            role: 'store_controller',
            module: 'warehouse',
            functionScope: 'read',
            locationId: SITE_B,
          },
        ],
      ],
      ['extra', [inv('stock_viewer', 'read')]],
    ];
    for (const [name, roles] of personas) {
      ids[name] = await provisionUser(port, `${name}@story210.example.com`, roles);
      h[name] = await authFor(port, `${name}@story210.example.com`);
    }
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // ---------------------------------------------------------------------------------------------
  it('AC3: only ceo or finance_controller grants rights, only to inventory_controller holders', async () => {
    const rightsBefore = await eventCount('item_group_right.granted');
    const auditBefore = await auditCount();

    const grant = await call('ceo', 'PUT', `/api/v1/item-groups/rights/${ids['icFull']}`, {
      create: true,
      edit: true,
      delete: true,
    });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    assert.strictEqual(grant.body['create'], true);
    assert.strictEqual(grant.body['edit'], true);
    assert.strictEqual(grant.body['delete'], true);
    assert.strictEqual(await eventCount('item_group_right.granted'), rightsBefore + 1);
    assert.ok((await auditCount()) > auditBefore, 'an audit row records the grant');

    const finGrant = await call('fin', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
      create: true,
      edit: false,
      delete: false,
    });
    assert.strictEqual(finGrant.status, 200, JSON.stringify(finGrant.body));
    assert.strictEqual(await eventCount('item_group_right.granted'), rightsBefore + 2);

    const revokedBefore = await eventCount('item_group_right.revoked');
    const revoke = await call('fin', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
      create: false,
      edit: false,
      delete: false,
    });
    assert.strictEqual(revoke.status, 200, JSON.stringify(revoke.body));
    assert.strictEqual(await eventCount('item_group_right.revoked'), revokedBefore + 1);
    const stored = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [
      ids['icNone'],
    ]);
    assert.strictEqual(stored.rows.length, 0, 'revoke removes the row');

    // Negative controls.
    const byIc = await call('icFull', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
      create: true,
      edit: true,
      delete: true,
    });
    assert.strictEqual(byIc.status, 403);
    assert.strictEqual(byIc.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepStrictEqual((byIc.body['details'] as Record<string, unknown>)['required_roles'], [
      'ceo',
      'finance_controller',
    ]);

    const toWm = await call('ceo', 'PUT', `/api/v1/item-groups/rights/${ids['wm']}`, {
      create: true,
      edit: false,
      delete: false,
    });
    assert.strictEqual(toWm.status, 400);
    assert.strictEqual(toWm.body['error_code'], 'GRANTEE_NOT_INVENTORY_CONTROLLER');

    const list = await call('ceo', 'GET', '/api/v1/item-groups/rights');
    assert.strictEqual(list.status, 200);
    assert.strictEqual((list.body['rights'] as unknown[]).length, 1);
    assert.strictEqual((await call('icFull', 'GET', '/api/v1/item-groups/rights')).status, 403);
  });

  // ---------------------------------------------------------------------------------------------
  it('AC3: a grantor may not grant to themselves and a no-op writes nothing', async () => {
    // Owner ruling 2026-10-06: self-granting is refused. The persona that matters is a grantor who
    // ALSO holds inventory_controller, since that is who could exercise what they award themselves;
    // a plain ceo proves nothing about the dual-role case.
    const dual = await provisionUser(port, 'ceo-ic@story210.example.com', [
      { role: 'ceo', module: 'config', functionScope: 'write', locationId: '*' },
      inv('inventory_controller'),
    ]);
    h['ceoIc'] = await authFor(port, 'ceo-ic@story210.example.com');
    const self = await call('ceoIc', 'PUT', `/api/v1/item-groups/rights/${dual}`, {
      create: true,
      edit: true,
      delete: true,
    });
    assert.strictEqual(self.status, 403, JSON.stringify(self.body));
    assert.strictEqual(self.body['error_code'], 'SELF_GRANT_NOT_PERMITTED');
    const none = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [dual]);
    assert.strictEqual(none.rows.length, 0, 'the refused self-grant stored nothing');

    // The same grantor may grant to someone else, and may drop their own rights afterwards.
    const byOther = await call('ceo', 'PUT', `/api/v1/item-groups/rights/${dual}`, {
      create: true,
      edit: false,
      delete: false,
    });
    assert.strictEqual(byOther.status, 200, JSON.stringify(byOther.body));
    const selfRevoke = await call('ceoIc', 'PUT', `/api/v1/item-groups/rights/${dual}`, {
      create: false,
      edit: false,
      delete: false,
    });
    assert.strictEqual(selfRevoke.status, 200, JSON.stringify(selfRevoke.body));
    const gone = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [dual]);
    assert.strictEqual(gone.rows.length, 0, 'a grantor can revoke their own rights');
    // This persona is a Table 2 holder (ceo and inventory_controller). Deactivated so it drops out of
    // the active recipient set and the later notification counts stay at the seven fixed holders.
    await getAdminPool().query(`UPDATE users SET active = false WHERE user_id = $1`, [dual]);

    // Owner ruling 2026-10-06: revoking from a user who holds no right changes nothing, so it
    // emits no event and no notification however many times it is called.
    const revokedBefore = await eventCount('item_group_right.revoked');
    const notifyBefore = await eventCount('notification.created');
    for (let i = 0; i < 3; i += 1) {
      const noop = await call('ceo', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
        create: false,
        edit: false,
        delete: false,
      });
      assert.strictEqual(noop.status, 200, JSON.stringify(noop.body));
      assert.strictEqual(noop.body['create'], false);
      assert.strictEqual(noop.body['granted_by'], null, 'no row, so nothing granted it');
      assert.strictEqual(noop.body['updated_at'], null);
    }
    assert.strictEqual(await eventCount('item_group_right.revoked'), revokedBefore);
    assert.strictEqual(await eventCount('notification.created'), notifyBefore);
  });

  // ---------------------------------------------------------------------------------------------
  it('AC3/AC7: rights and recipients can still be withdrawn from a deactivated user', async () => {
    const leaver = await provisionUser(port, 'leaver@story210.example.com', [
      inv('inventory_controller'),
    ]);
    const granted = await call('ceo', 'PUT', `/api/v1/item-groups/rights/${leaver}`, {
      create: true,
      edit: false,
      delete: false,
    });
    assert.strictEqual(granted.status, 200, JSON.stringify(granted.body));
    const addedToList = await call('ceo', 'POST', '/api/v1/item-groups/recipients', {
      user_id: leaver,
    });
    assert.strictEqual(addedToList.status, 201);

    await getAdminPool().query(`UPDATE users SET active = false WHERE user_id = $1`, [leaver]);

    // Granting to a deactivated user is still refused: it would hand out access nobody can use.
    const regrant = await call('ceo', 'PUT', `/api/v1/item-groups/rights/${leaver}`, {
      create: true,
      edit: true,
      delete: false,
    });
    assert.strictEqual(regrant.status, 400);
    assert.strictEqual(regrant.body['error_code'], 'USER_NOT_FOUND');

    // Withdrawal must work, or an offboarded user's rows could never be cleaned up.
    const revoked = await call('ceo', 'PUT', `/api/v1/item-groups/rights/${leaver}`, {
      create: false,
      edit: false,
      delete: false,
    });
    assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));
    const rightRows = await getPool().query(`SELECT 1 FROM item_group_right WHERE user_id = $1`, [
      leaver,
    ]);
    assert.strictEqual(rightRows.rows.length, 0, 'the rights row is gone');

    const removed = await call('ceo', 'DELETE', `/api/v1/item-groups/recipients/${leaver}`);
    assert.strictEqual(removed.status, 204, JSON.stringify(removed.body));
    const listRows = await getPool().query(
      `SELECT 1 FROM item_group_recipient WHERE user_id = $1`,
      [leaver],
    );
    assert.strictEqual(listRows.rows.length, 0, 'the recipient row is gone');
  });

  // ---------------------------------------------------------------------------------------------
  it('AC1: create validates, enforces uniqueness and the role plus right gate', async () => {
    const created = await createGroup('BEARINGS', 'Bearings');
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body['code'], 'BEARINGS');
    assert.strictEqual(created.body['status'], 'active');
    assert.strictEqual(await eventCount('item_group.created'), 1);

    const noRight = await call('icNone', 'POST', '/api/v1/item-groups', {
      code: 'FASTENERS',
      name: 'Fasteners',
    });
    assert.strictEqual(noRight.status, 403);
    assert.strictEqual(noRight.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');
    assert.strictEqual((noRight.body['details'] as Record<string, unknown>)['right'], 'create');

    const wm = await call('wm', 'POST', '/api/v1/item-groups', { code: 'FASTENERS', name: 'F' });
    assert.strictEqual(wm.status, 403);
    assert.strictEqual(wm.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepStrictEqual((wm.body['details'] as Record<string, unknown>)['required_roles'], [
      'inventory_controller',
    ]);

    const dupCode = await createGroup('BEARINGS', 'Other name');
    assert.strictEqual(dupCode.status, 409);
    assert.strictEqual(dupCode.body['error_code'], 'DUPLICATE_ITEM_GROUP_CODE');
    const dupName = await createGroup('BEARINGS2', 'bearings');
    assert.strictEqual(dupName.status, 409);
    assert.strictEqual(dupName.body['error_code'], 'DUPLICATE_ITEM_GROUP_NAME');

    for (const bad of ['bearings', 'A', 'A'.repeat(33)]) {
      const res = await createGroup(bad, 'Whatever');
      assert.strictEqual(res.status, 400, `code ${bad}`);
      assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
    }
    assert.strictEqual(await eventCount('item_group.created'), 1, 'refused writes emit nothing');
  });

  // ---------------------------------------------------------------------------------------------
  it('AC1: edit renames, deactivates and reactivates with before and after', async () => {
    const before = await eventCount('item_group.updated');
    const rename = await call('icFull', 'PATCH', '/api/v1/item-groups/BEARINGS', {
      name: 'Ball Bearings',
    });
    assert.strictEqual(rename.status, 200, JSON.stringify(rename.body));
    assert.strictEqual(rename.body['name'], 'Ball Bearings');
    const deactivate = await call('icFull', 'PATCH', '/api/v1/item-groups/BEARINGS', {
      status: 'inactive',
    });
    assert.strictEqual(deactivate.body['status'], 'inactive');
    const reactivate = await call('icFull', 'PATCH', '/api/v1/item-groups/BEARINGS', {
      status: 'active',
    });
    assert.strictEqual(reactivate.body['status'], 'active');
    assert.strictEqual(await eventCount('item_group.updated'), before + 3);

    const ev = await getPool().query(
      `SELECT payload FROM domain_events WHERE event_type = 'item_group.updated' ORDER BY created_at ASC LIMIT 1`,
    );
    const payload = ev.rows[0]!['payload'] as {
      before: { name: string };
      after: { name: string };
    };
    assert.strictEqual(payload.before.name, 'Bearings');
    assert.strictEqual(payload.after.name, 'Ball Bearings');

    assert.strictEqual(
      (await call('icFull', 'PATCH', '/api/v1/item-groups/BEARINGS', { code: 'NEWCODE' })).status,
      400,
    );
    assert.strictEqual(
      (await call('icFull', 'PATCH', '/api/v1/item-groups/BEARINGS', {})).status,
      400,
    );
    const unknown = await call('icFull', 'PATCH', '/api/v1/item-groups/NOPE-GROUP', { name: 'x' });
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(unknown.body['error_code'], 'ITEM_GROUP_NOT_FOUND');

    // A code that cannot name a group at all is bad input, the same answer create gives, so a
    // caller can tell a malformed code from a well-formed one that is simply unknown.
    for (const bad of ['bearings', 'A']) {
      const malformed = await call('icFull', 'PATCH', `/api/v1/item-groups/${bad}`, { name: 'x' });
      assert.strictEqual(malformed.status, 400, `code ${bad}`);
      assert.strictEqual(malformed.body['error_code'], 'INVALID_PARAMS');
    }

    // A holder with create only may not edit.
    await call('ceo', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
      create: true,
      edit: false,
      delete: false,
    });
    const createOnly = await call('icNone', 'PATCH', '/api/v1/item-groups/BEARINGS', {
      name: 'Nope',
    });
    assert.strictEqual(createOnly.status, 403);
    assert.strictEqual(createOnly.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');
    assert.strictEqual((createOnly.body['details'] as Record<string, unknown>)['right'], 'edit');
    await call('ceo', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
      create: false,
      edit: false,
      delete: false,
    });
  });

  // ---------------------------------------------------------------------------------------------
  it('AC4/AC5/AC6: assignment, lookup, ungrouped report and refusals', async () => {
    for (const sku of ['SKU-G1', 'SKU-G2', 'SKU-U1', 'SKU-U2', 'SKU-INACTIVE']) {
      await createItem(sku);
    }
    const inactiveItem = await call('icFull', 'PATCH', '/api/v1/items/SKU-INACTIVE', {
      status: 'inactive',
    });
    assert.strictEqual(inactiveItem.status, 200);

    const group = await call('icFull', 'GET', '/api/v1/item-groups/BEARINGS');
    const groupId = group.body['item_group_id'] as string;

    // AC7 covers an item group set, changed or cleared, so each of the three is counted. The
    // recipients at this point are the seven Table 2 holders (icFull, icNone, ceo, fin, cfo,
    // siteHead, storeCtl); the recipient list is still empty and icFull is the actor.
    const TABLE_2_HOLDERS = 7;
    const notifyBeforeSet = await eventCount('notification.created');
    const set = await call('icFull', 'PATCH', '/api/v1/items/SKU-G1', { item_group_id: groupId });
    assert.strictEqual(set.status, 200, JSON.stringify(set.body));
    assert.strictEqual(set.body['item_group_id'], groupId);
    assert.strictEqual(
      (await eventCount('notification.created')) - notifyBeforeSet,
      TABLE_2_HOLDERS,
      'setting a group notifies every Table 2 holder once',
    );
    const ev = await getPool().query(
      `SELECT payload FROM domain_events WHERE event_type = 'item.updated' ORDER BY created_at DESC LIMIT 1`,
    );
    const payload = ev.rows[0]!['payload'] as {
      before: { item_group_id: string | null };
      after: { item_group_id: string | null };
    };
    assert.strictEqual(payload.before.item_group_id, null);
    assert.strictEqual(payload.after.item_group_id, groupId);

    await call('icFull', 'PATCH', '/api/v1/items/SKU-G2', { item_group_id: groupId });
    const other = await createGroup('FASTENERS', 'Fasteners');
    const otherId = other.body['item_group_id'] as string;
    const notifyBeforeChange = await eventCount('notification.created');
    const change = await call('icFull', 'PATCH', '/api/v1/items/SKU-G2', {
      item_group_id: otherId,
    });
    assert.strictEqual(change.body['item_group_id'], otherId);
    assert.strictEqual(
      (await eventCount('notification.created')) - notifyBeforeChange,
      TABLE_2_HOLDERS,
      'changing a group notifies every Table 2 holder once',
    );
    const notifyBeforeClear = await eventCount('notification.created');
    const clear = await call('icFull', 'PATCH', '/api/v1/items/SKU-G2', { item_group_id: null });
    assert.strictEqual(clear.status, 200);
    assert.strictEqual(clear.body['item_group_id'], null);
    assert.strictEqual(
      (await eventCount('notification.created')) - notifyBeforeClear,
      TABLE_2_HOLDERS,
      'clearing a group notifies every Table 2 holder once',
    );

    // Re-sending SKU-G1's existing group changes nothing, so it must notify nobody. SKU-G2 is
    // left cleared on purpose: the AC2 delete case needs FASTENERS to be a group that was
    // assigned and then emptied (D9), and the ungrouped report below needs SKU-G2 back in it.
    const notifyBeforeNoop = await eventCount('notification.created');
    const noop = await call('icFull', 'PATCH', '/api/v1/items/SKU-G1', { item_group_id: groupId });
    assert.strictEqual(noop.status, 200);
    assert.strictEqual(
      await eventCount('notification.created'),
      notifyBeforeNoop,
      'a no-op reassignment notifies nobody',
    );

    const items = await call('icFull', 'GET', '/api/v1/item-groups/BEARINGS/items');
    assert.strictEqual(items.status, 200);
    assert.deepStrictEqual(
      (items.body['items'] as { sku: string }[]).map((i) => i.sku),
      ['SKU-G1'],
    );

    // Task 1.2 named [SKU-U1, SKU-U2] with count 2. SKU-G2 is in the list because it was assigned
    // and then cleared earlier in this test, which proves the AC5 behaviour the shorter list would
    // not: a cleared item returns to the ungrouped report. SKU-INACTIVE is absent as specified.
    const ungrouped = await call('wm', 'GET', '/api/v1/item-groups/ungrouped-items');
    assert.strictEqual(ungrouped.status, 200);
    assert.deepStrictEqual(
      (ungrouped.body['items'] as { sku: string }[]).map((i) => i.sku),
      ['SKU-G2', 'SKU-U1', 'SKU-U2'],
    );
    assert.strictEqual(ungrouped.body['count'], 3);

    // Other fields keep the inventory write gate: wm may PATCH uom, but not the group.
    const uom = await call('wm', 'PATCH', '/api/v1/items/SKU-U1', { uom: 'kg' });
    assert.strictEqual(uom.status, 200, JSON.stringify(uom.body));
    const wmGroup = await call('wm', 'PATCH', '/api/v1/items/SKU-U1', { item_group_id: groupId });
    assert.strictEqual(wmGroup.status, 403);
    assert.strictEqual(wmGroup.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const noEdit = await call('icNone', 'PATCH', '/api/v1/items/SKU-U1', {
      item_group_id: groupId,
    });
    assert.strictEqual(noEdit.status, 403);
    assert.strictEqual(noEdit.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');

    // Refusals write nothing.
    const eventsBefore = await allEventCount();
    for (const bad of [randomUUID(), 'not-a-uuid']) {
      const res = await call('icFull', 'PATCH', '/api/v1/items/SKU-U1', { item_group_id: bad });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body['error_code'], 'ITEM_GROUP_NOT_FOUND');
    }
    await call('icFull', 'PATCH', '/api/v1/item-groups/FASTENERS', { status: 'inactive' });
    const eventsAfterDeactivate = await allEventCount();
    const inactive = await call('icFull', 'PATCH', '/api/v1/items/SKU-U1', {
      item_group_id: otherId,
    });
    assert.strictEqual(inactive.status, 400);
    assert.strictEqual(inactive.body['error_code'], 'ITEM_GROUP_INACTIVE');
    assert.strictEqual(
      await allEventCount(),
      eventsAfterDeactivate,
      'refused assignment writes nothing',
    );
    assert.ok(eventsAfterDeactivate > eventsBefore);
    const row = await getPool().query(`SELECT item_group_id FROM item_master WHERE sku = 'SKU-U1'`);
    assert.strictEqual(row.rows[0]!['item_group_id'], null);

    // The shared guard, called directly (Story 4.8 seam).
    assert.strictEqual((await assertItemGroupAssignable(groupId)).code, 'BEARINGS');
    await assert.rejects(() => assertItemGroupAssignable(otherId), {
      errorCode: 'ITEM_GROUP_INACTIVE',
    });
    await assert.rejects(() => assertItemGroupAssignable(randomUUID()), {
      errorCode: 'ITEM_GROUP_NOT_FOUND',
    });
    await call('icFull', 'PATCH', '/api/v1/item-groups/FASTENERS', { status: 'active' });

    // POST may set the group; null on POST is refused.
    const created = await call('icFull', 'POST', '/api/v1/items', {
      sku: 'SKU-NEW-G',
      uom: 'ea',
      valuation_method: 'fifo',
      business_stream: 'production',
      item_group_id: groupId,
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.strictEqual(created.body['item_group_id'], groupId);
    const nullOnPost = await call('icFull', 'POST', '/api/v1/items', {
      sku: 'SKU-NEW-NULL',
      uom: 'ea',
      valuation_method: 'fifo',
      business_stream: 'production',
      item_group_id: null,
    });
    assert.strictEqual(nullOnPost.status, 400, JSON.stringify(nullOnPost.body));
    assert.strictEqual(nullOnPost.body['error_code'], 'INVALID_PARAMS');

    // A PATCH to an unknown SKU is answered as a missing item, not as a group error.
    const unknownSku = await call('icFull', 'PATCH', '/api/v1/items/SKU-NOPE', {
      item_group_id: groupId,
    });
    assert.strictEqual(unknownSku.status, 404);
    assert.strictEqual(unknownSku.body['error_code'], 'ITEM_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------------------------
  it('AC2: delete only a never-used group', async () => {
    const fresh = await createGroup('TEMPGRP', 'Temporary Group');
    assert.strictEqual(fresh.status, 201);
    const deletedBefore = await eventCount('item_group.deleted');
    const del = await call('icFull', 'DELETE', '/api/v1/item-groups/TEMPGRP');
    assert.strictEqual(del.status, 204);
    assert.strictEqual(await eventCount('item_group.deleted'), deletedBefore + 1);
    assert.strictEqual((await call('icFull', 'GET', '/api/v1/item-groups/TEMPGRP')).status, 404);

    const inUse = await call('icFull', 'DELETE', '/api/v1/item-groups/BEARINGS');
    assert.strictEqual(inUse.status, 409);
    assert.strictEqual(inUse.body['error_code'], 'ITEM_GROUP_IN_USE');
    assert.match(String(inUse.body['message']), /deactivate/);

    // FASTENERS had SKU-G2 assigned and then cleared: still refused (D9).
    const emptied = await call('icFull', 'DELETE', '/api/v1/item-groups/FASTENERS');
    assert.strictEqual(emptied.status, 409);
    assert.strictEqual(emptied.body['error_code'], 'ITEM_GROUP_IN_USE');

    const another = await createGroup('TEMP2', 'Temporary Two');
    assert.strictEqual(another.status, 201);
    await call('ceo', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
      create: true,
      edit: true,
      delete: false,
    });
    const noDelete = await call('icNone', 'DELETE', '/api/v1/item-groups/TEMP2');
    assert.strictEqual(noDelete.status, 403);
    assert.strictEqual(noDelete.body['error_code'], 'ITEM_GROUP_RIGHT_REQUIRED');
    assert.strictEqual((noDelete.body['details'] as Record<string, unknown>)['right'], 'delete');
    await call('ceo', 'PUT', `/api/v1/item-groups/rights/${ids['icNone']}`, {
      create: false,
      edit: false,
      delete: false,
    });
    assert.strictEqual((await call('icFull', 'GET', '/api/v1/item-groups/TEMP2')).status, 200);
  });

  // ---------------------------------------------------------------------------------------------
  it('AC7: one notification per user, recipient list kept by ceo or finance only', async () => {
    const notifyBefore = await eventCount('notification.created');
    const created = await createGroup('NOTIFY1', 'Notify One');
    assert.strictEqual(created.status, 201);
    // Table 2 holders (icFull, icNone, ceo, fin, cfo, siteHead, storeCtl); icFull is also the actor.
    const afterFirst = await eventCount('notification.created');
    assert.strictEqual(afterFirst - notifyBefore, 7, 'one per Table 2 holder, actor included');

    const added = await call('ceo', 'POST', '/api/v1/item-groups/recipients', {
      user_id: ids['extra'],
    });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    const afterAdd = await eventCount('notification.created');
    assert.strictEqual(afterAdd - afterFirst, 8, 'the add itself notifies, extra included');

    const forbidden = await call('icFull', 'POST', '/api/v1/item-groups/recipients', {
      user_id: ids['wm'],
    });
    assert.strictEqual(forbidden.status, 403);
    assert.strictEqual(
      await eventCount('notification.created'),
      afterAdd,
      'refused write emits nothing',
    );
    assert.strictEqual(
      (await call('ceo', 'POST', '/api/v1/item-groups/recipients', { user_id: randomUUID() })).body[
        'error_code'
      ],
      'USER_NOT_FOUND',
    );

    const second = await createGroup('NOTIFY2', 'Notify Two');
    assert.strictEqual(second.status, 201);

    const dispatched = await runDispatchCycle(500);
    assert.ok(dispatched.eventsProcessed > 0);
    const users = await getPool().query(
      `SELECT target_user_id, count(*)::int AS n FROM notifications
        WHERE object_type = 'item_group' AND object_id = 'NOTIFY2' GROUP BY target_user_id`,
    );
    const byUser = new Map(
      users.rows.map((r) => [r['target_user_id'] as string, r['n'] as number]),
    );
    for (const name of ['ceo', 'fin', 'cfo', 'siteHead', 'storeCtl', 'icFull', 'extra']) {
      assert.strictEqual(byUser.get(ids[name]!), 1, `${name} gets exactly one`);
    }
    assert.strictEqual(byUser.get(ids['wm']!), undefined, 'wm gets none');

    // Recipient list read and removal.
    const list = await call('fin', 'GET', '/api/v1/item-groups/recipients');
    assert.strictEqual((list.body['recipients'] as unknown[]).length, 1);
    const removeBefore = await eventCount('item_group_recipient.removed');
    const removed = await call('fin', 'DELETE', `/api/v1/item-groups/recipients/${ids['extra']}`);
    assert.strictEqual(removed.status, 204);
    assert.strictEqual(await eventCount('item_group_recipient.removed'), removeBefore + 1);
  });

  it('AC7: a user holding two Table 2 roles and on the list gets exactly one notification', async () => {
    const dual = await provisionUser(port, 'dual@story210.example.com', [
      { role: 'cfo', module: 'finance', functionScope: 'read', locationId: '*' },
      { role: 'site_head', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    await call('ceo', 'POST', '/api/v1/item-groups/recipients', { user_id: dual });
    await createGroup('NOTIFY3', 'Notify Three');
    await runDispatchCycle(500);
    const rows = await getPool().query(
      `SELECT count(*)::int AS n FROM notifications
        WHERE target_user_id = $1 AND object_type = 'item_group' AND object_id = 'NOTIFY3'`,
      [dual],
    );
    assert.strictEqual(rows.rows[0]!['n'], 1);
  });
});

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
import {
  findRoleHolder,
  findActiveDelegation,
  isActiveRoleHolderForEntry,
} from '../../src/read/projections/doa_registry.js';
import { CHALLAN_RECLASSIFICATION_ROLES } from '../../src/compliance/jobwork-return-clock.js';
import {
  verifySegregatedRoles,
  type VerifySegregatedRolesResult,
} from '../../src/cli/verify-segregated-roles-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const SITE_HEAD = 'site_head';

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

/** Story 1.16 Table 1: the grants every site head receives, at one concrete site. */
function siteHeadAt(locationId: string): Role[] {
  return [
    { role: SITE_HEAD, module: 'jobwork', functionScope: 'write', locationId },
    { role: SITE_HEAD, module: 'jobwork', functionScope: 'read', locationId },
    { role: SITE_HEAD, module: 'notification', functionScope: 'read', locationId },
  ];
}

describe('Story 1.16 Site Head Role', () => {
  let server: Server;
  let port: number;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const SITE_A_CODE = `S116A-${run}`;
  const SITE_B_CODE = `S116B-${run}`;
  const clockA = randomUUID();
  const clockB = randomUUID();
  const REGIONAL_ROLE = `regional_head_${run}`;
  const TRANSACTION_TYPE = 'test.site_head_authority';

  const headAExt = `head-a-116-${run}@example.com`;
  const headBExt = `head-b-116-${run}@example.com`;
  const wmExt = `wm-116-${run}@example.com`;
  const empExt = `emp-116-${run}@example.com`;
  const coordExt = `coord-116-${run}@example.com`;
  const regionalExt = `regional-116-${run}@example.com`;
  const adminExt = `admin-116-${run}@example.com`;

  let headAId: string;
  let headBId: string;
  let wmId: string;
  let regionalId: string;
  let headA: Record<string, string>;
  let wm: Record<string, string>;
  let emp: Record<string, string>;
  let coord: Record<string, string>;
  let admin: Record<string, string>;
  let entryId: string;
  let beforeAnySite: VerifySegregatedRolesResult;

  async function clockClass(clockId: string): Promise<string> {
    const result = await getAdminPool().query(
      `SELECT challan_class FROM jobwork_return_clock WHERE clock_id = $1`,
      [clockId],
    );
    return (result.rows[0] as { challan_class: string }).challan_class;
  }

  function reclassify(clockId: string, headers: Record<string, string>): Promise<HttpResult> {
    return makeRequest(
      port,
      'PATCH',
      `/api/v1/jobwork/clocks/${clockId}/classification`,
      { idempotency_key: randomUUID(), challan_class: 'capital_goods' },
      headers,
    );
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
      '../../read/projections/location_register.sql',
      '../../read/projections/jobwork_return_clock.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE jobwork_return_clock, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, transaction_tagging_rules, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    // D5: with no active site registered the required-role section is empty and does not fail.
    // Read here, while the register is still empty, and asserted in its own case below.
    beforeAnySite = await verifySegregatedRoles(adminPool, []);

    for (const [id, code] of [
      [siteA, SITE_A_CODE],
      [siteB, SITE_B_CODE],
    ] as const) {
      await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
         VALUES ($1, $2, 'site', $1, $1, 'general', 'ambient', false, 'active')`,
        [id, code],
      );
    }
    // One open statutory clock per site: the rows the D7 gate acts on. Ten days into a 365-day
    // clock, so a correction to capital_goods moves the expiry later and is accepted.
    for (const [clockId, siteId] of [
      [clockA, siteA],
      [clockB, siteB],
    ] as const) {
      await adminPool.query(
        `INSERT INTO jobwork_return_clock
           (clock_id, receipt_id, service_order_id, sku, challan_qty, challan_class, challan_date, expiry_date, site_id)
         VALUES ($1, $2, $3, $4, 100, 'input', CURRENT_DATE - 10, CURRENT_DATE + 355, $5)`,
        [clockId, randomUUID(), randomUUID(), `SKU-116-${run}`, siteId],
      );
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

    // headB is provisioned BEFORE headA, so it holds the OLDEST site_head assignment: the holder
    // the location-blind lookup returns, and the wrong answer for a site A transaction.
    headBId = await provisionUser(port, headBExt, siteHeadAt(siteB));
    headAId = await provisionUser(port, headAExt, siteHeadAt(siteA));
    wmId = await provisionUser(port, wmExt, [
      { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: siteA },
    ]);
    await provisionUser(port, empExt, [
      { role: 'employee', module: 'employee', functionScope: 'write', locationId: siteA },
    ]);
    // Holds jobwork write at site A under a role that may not reclassify: the caller who reaches
    // the site-head gate itself instead of being stopped at the module gate in front of it.
    await provisionUser(port, coordExt, [
      {
        role: 'jobwork_coordinator',
        module: 'jobwork',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    // A role held at every site. Its own name, so the site_head cases above keep two holders.
    regionalId = await provisionUser(port, regionalExt, [
      { role: REGIONAL_ROLE, module: 'jobwork', functionScope: 'write', locationId: '*' },
    ]);
    await provisionUser(port, adminExt, [
      {
        role: 'system_administrator',
        module: 'compliance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);

    headA = await authFor(port, headAExt);
    wm = await authFor(port, wmExt);
    emp = await authFor(port, empExt);
    coord = await authFor(port, coordExt);
    admin = await authFor(port, adminExt);

    const entry = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      { role: SITE_HEAD, transaction_type: TRANSACTION_TYPE, value_min: 0, value_max: null },
      admin,
    );
    assert.strictEqual(entry.status, 201, JSON.stringify(entry.body));
    entryId = entry.body['entry_id'] as string;
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  describe('AC 3 resolution at the transaction site', () => {
    it('resolves the site head of the site that is asked for', async () => {
      const atA = await findRoleHolder(SITE_HEAD, undefined, siteA);
      const atB = await findRoleHolder(SITE_HEAD, undefined, siteB);
      assert.deepStrictEqual(atA, { user_id: headAId, external_id: headAExt });
      assert.deepStrictEqual(atB, { user_id: headBId, external_id: headBExt });
      assert.notStrictEqual(headAId, headBId);
    });

    it('with no location, still returns the oldest holder across every site', async () => {
      const oldest = await findRoleHolder(SITE_HEAD);
      assert.deepStrictEqual(oldest, { user_id: headBId, external_id: headBExt });
    });

    it('a holder assigned at every site satisfies any site', async () => {
      const expected = { user_id: regionalId, external_id: regionalExt };
      assert.deepStrictEqual(await findRoleHolder(REGIONAL_ROLE, undefined, siteA), expected);
      assert.deepStrictEqual(await findRoleHolder(REGIONAL_ROLE, undefined, siteB), expected);
      assert.deepStrictEqual(
        await findRoleHolder(REGIONAL_ROLE, undefined, randomUUID()),
        expected,
      );
    });

    it('returns null for a site nobody holds the role at', async () => {
      assert.strictEqual(await findRoleHolder(SITE_HEAD, undefined, randomUUID()), null);
      // Negative control: the same role does resolve at a site it is held at.
      assert.notStrictEqual(await findRoleHolder(SITE_HEAD, undefined, siteA), null);
    });

    it('does not resolve another role held at the site', async () => {
      const holder = await findRoleHolder('warehouse_manager', undefined, siteA);
      assert.deepStrictEqual(holder, { user_id: wmId, external_id: wmExt });
      assert.strictEqual(await findRoleHolder('warehouse_manager', undefined, siteB), null);
    });

    it('resolves inside a transaction client as well as on the pool', async () => {
      const client = await getPool().connect();
      try {
        const holder = await findRoleHolder(SITE_HEAD, client, siteA);
        assert.deepStrictEqual(holder, { user_id: headAId, external_id: headAExt });
      } finally {
        client.release();
      }
    });
  });

  describe('AC 3 delegation', () => {
    /** The way resolveApprover resolves: the holder at the site, then that holder's delegate. */
    async function approverAt(siteId: string, asOfDate: string): Promise<string | null> {
      const holder = await findRoleHolder(SITE_HEAD, undefined, siteId);
      if (!holder) return null;
      const delegation = await findActiveDelegation(holder.user_id, asOfDate);
      return delegation?.delegate_user_id ?? holder.user_id;
    }

    it('reroutes the site A head to the delegate inside the window only', async () => {
      const created = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/delegations',
        {
          delegator_external_id: headAExt,
          delegate_external_id: wmExt,
          start_date: '2026-11-01',
          end_date: '2026-11-10',
        },
        admin,
      );
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));

      const inside = await findActiveDelegation(headAId, '2026-11-05');
      assert.strictEqual(inside?.delegate_user_id, wmId);
      assert.strictEqual(inside?.delegator_user_id, headAId);
      assert.strictEqual(await approverAt(siteA, '2026-11-05'), wmId);

      assert.strictEqual(await findActiveDelegation(headAId, '2026-10-15'), null);
      assert.strictEqual(await approverAt(siteA, '2026-10-15'), headAId);
      assert.strictEqual(await approverAt(siteA, '2026-11-11'), headAId);
    });

    it('leaves the site B head, who delegated nothing, resolving to itself', async () => {
      assert.strictEqual(await findActiveDelegation(headBId, '2026-11-05'), null);
      assert.strictEqual(await approverAt(siteB, '2026-11-05'), headBId);
    });
  });

  describe('AC 3 membership on a DOA entry', () => {
    it('the site A head holds the entry role at site A and not at site B', async () => {
      assert.strictEqual(
        await isActiveRoleHolderForEntry(entryId, headAId, undefined, siteA),
        true,
      );
      assert.strictEqual(
        await isActiveRoleHolderForEntry(entryId, headAId, undefined, siteB),
        false,
      );
    });

    it('with no location, membership is what it was before this story', async () => {
      assert.strictEqual(await isActiveRoleHolderForEntry(entryId, headAId), true);
      assert.strictEqual(await isActiveRoleHolderForEntry(entryId, headBId), true);
    });

    it('somebody who does not hold the role is not a member at any site', async () => {
      assert.strictEqual(await isActiveRoleHolderForEntry(entryId, wmId, undefined, siteA), false);
      assert.strictEqual(await isActiveRoleHolderForEntry(entryId, wmId), false);
    });
  });

  describe('AC 2 verify:roles reports the role per site', () => {
    it('reports nothing and fails nothing while no active site is registered', () => {
      assert.deepStrictEqual(beforeAnySite.required_roles, []);
      assert.deepStrictEqual(beforeAnySite.violations, []);
      assert.strictEqual(beforeAnySite.ok, true);
    });

    it('reports each of the four required roles at each site with its holders', async () => {
      const result = await verifySegregatedRoles(getAdminPool(), []);

      assert.deepStrictEqual(
        result.required_roles.map((e) => [e.role, e.site_code, e.holder_user_ids, e.ok]),
        [
          ['site_head', SITE_A_CODE, [headAId], true],
          ['site_head', SITE_B_CODE, [headBId], true],
          ['warehouse_manager', SITE_A_CODE, [wmId], true],
          ['warehouse_manager', SITE_B_CODE, [], false],
          ['department_head', SITE_A_CODE, [], false],
          ['department_head', SITE_B_CODE, [], false],
          ['qc_head', SITE_A_CODE, [], false],
          ['qc_head', SITE_B_CODE, [], false],
        ],
      );
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(
        result.violations.map((v) => [v.code, v.details['role'], v.details['site_code']]),
        [
          ['ROLE_UNHELD_AT_SITE', 'warehouse_manager', SITE_B_CODE],
          ['ROLE_UNHELD_AT_SITE', 'department_head', SITE_A_CODE],
          ['ROLE_UNHELD_AT_SITE', 'department_head', SITE_B_CODE],
          ['ROLE_UNHELD_AT_SITE', 'qc_head', SITE_A_CODE],
          ['ROLE_UNHELD_AT_SITE', 'qc_head', SITE_B_CODE],
        ],
      );
    });
  });

  describe('AC 4 the site-head-gated action (D7)', () => {
    it('refuses a jobwork writer who is not a site head, naming the roles that may act', async () => {
      const res = await reclassify(clockA, coord);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
      assert.deepStrictEqual((res.body['details'] as Record<string, unknown>)['required_roles'], [
        'compliance_officer',
        'site_head',
      ]);
      assert.deepStrictEqual(
        [...CHALLAN_RECLASSIFICATION_ROLES],
        ['compliance_officer', 'site_head'],
      );
      assert.strictEqual(await clockClass(clockA), 'input');
    });

    it('refuses the warehouse manager and the plain employee before the gate is reached', async () => {
      // Neither holds any jobwork grant, so requireRole refuses them at the module gate that
      // stands in front of the site-head gate.
      for (const headers of [wm, emp]) {
        const res = await reclassify(clockA, headers);
        assert.strictEqual(res.status, 403, JSON.stringify(res.body));
        assert.strictEqual(res.body['error_code'], 'MODULE_ACCESS_DENIED');
      }
      assert.strictEqual(await clockClass(clockA), 'input');
    });

    it('refuses the site A head on a site B clock', async () => {
      const res = await reclassify(clockB, headA);
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'LOCATION_ACCESS_DENIED');
      assert.strictEqual(await clockClass(clockB), 'input');
    });

    it('lets the site A head correct a site A clock', async () => {
      const res = await reclassify(clockA, headA);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const clock = res.body['return_clock'] as Record<string, unknown>;
      assert.strictEqual(clock['clock_id'], clockA);
      assert.strictEqual(clock['challan_class'], 'capital_goods');
      assert.strictEqual(clock['site_id'], siteA);
      assert.strictEqual(await clockClass(clockA), 'capital_goods');
      // The site B clock was never touched.
      assert.strictEqual(await clockClass(clockB), 'input');
    });
  });
});

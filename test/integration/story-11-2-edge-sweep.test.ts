import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';

// ---------------------------------------------------------------------------
// Edge-sync door security sweep (2026-09-09) - the pin for src/api/v1/edge.ts.
//
// POST /api/v1/events and POST /api/v1/edge/events are meant to be twins. Two holes were closed on
// the edge door and this file is their only coverage:
//
//   1. dispatch.irn_recorded was gated by a DENYLIST of two frontline roles (store_assistant,
//      warehouse_operator) and admitted everyone else, so gate_officer, qc_inspector and every
//      other role the REST route refuses could lift the Story 11.2 statutory IRN-before-dispatch
//      block through edge sync. It read ONE arbitrarily-selected assignment, so a user holding
//      dispatch_clerk plus another warehouse role was admitted or refused depending on which
//      assignment happened to sort first. It is now the events door's ALLOWLIST
//      (dispatch_clerk / warehouse_manager), filtered across ALL assignments on module
//      warehouse/* at write scope.
//   2. There was no blanket payload-site check at all. assertPayloadSiteWriteAccess closed that
//      class centrally on the events door on 2026-09-06; assertEdgePayloadSiteWriteAccess is its
//      twin, ordered LAST so the specific function gates still answer with their precise
//      FUNCTION_ACCESS_DENIED and every other site_id-carrying event type is caught with
//      LOCATION_ACCESS_DENIED.
//
// Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run
// serially; every identifier is run-scoped. The harness scaffolding is a deliberate local
// re-implementation of the story-11-2 closures (never import cross-story).
//
// Every arm asserts error_code, never a bare status: this suite family has a documented history of
// arms satisfied by an unrelated refusal.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

// The projections this file reads or writes. Idempotent by construction (IF NOT EXISTS / guarded
// DO blocks), so re-applying them to a live test database is safe.
const HARNESS_DDL = [
  '../../events/domain_events.sql',
  '../../read/projections/users.sql',
  '../../read/projections/audit_log.sql',
  '../../read/projections/location_register.sql',
  '../../read/projections/item_master.sql',
  '../../read/projections/erp_sales_order.sql',
  '../../read/projections/dispatch_irn.sql',
  '../../read/projections/compliance_bis_licence.sql',
  '../../read/projections/compliance_bis_licence_alert.sql',
];

// Only the tables this file asserts row COUNTS on. Nothing else is truncated: every other
// assertion here is scoped to a run-scoped identifier.
const TRUNCATE_LIST = 'compliance_bis_licence_alert, compliance_bis_licence, dispatch_irn';

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

interface Actor {
  userId: string;
  token: string;
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
              parsed = { error_code: 'NON_JSON_BODY' };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(
  port: number,
  externalId: string,
  displayName: string,
  roles: Role[],
): Promise<Actor> {
  const created = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName, roles },
    SCIM_HEADERS,
  );
  assert.equal(created.status, 201, `SCIM user creation failed: ${created.raw}`);
  const userId = created.body['userId'];
  assert(typeof userId === 'string', 'SCIM response missing user id');

  const tokenResult = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', {
    sub: externalId,
  });
  assert.ok(tokenResult.status >= 200 && tokenResult.status < 300, `dev-token: ${tokenResult.raw}`);
  const token = tokenResult.body['token'];
  assert(typeof token === 'string', 'dev-token response missing token');
  return { userId, token };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

async function seedLocation(locationId: string, code: string, siteId: string): Promise<void> {
  await getAdminPool().query(
    `INSERT INTO location_register
       (location_id, location_code, level, parent_location_id, site_id, zone_type,
        temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status)
     VALUES ($1, $2, 'site', NULL, $3, 'general', 'ambient', 'standard', false, false, false, 'active')`,
    [locationId, code, siteId],
  );
}

// erp_sales_order is a direct-upsert reference projection (Story 2.9), not event-sourced. An IRN can
// be recorded against a line before any picking exists (Story 11.2 decision D3), so this is the only
// fixture the IRN arms need - no pick/pack/document machinery.
async function seedErpSalesOrder(id: string, soNumberExt: string, siteId: string): Promise<void> {
  await getAdminPool().query(
    `INSERT INTO erp_sales_order
       (id, so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext,
        ship_to_ext, status, source_system, last_synced_at)
     VALUES ($1, $2, 1, $3, '5', $4, 'SITE-EDGE', 'Customer EDGE', 'open', 'ERP', now())`,
    [id, soNumberExt, `SKU-${soNumberExt}`, siteId],
  );
}

async function seedItem(sku: string): Promise<void> {
  await getAdminPool().query(
    `INSERT INTO item_master (sku, uom, valuation_method, business_stream)
     VALUES ($1, 'EA', 'fifo', 'production')`,
    [sku],
  );
}

// A GST IRN is the IRP's SHA-256 over the invoice: 64 hexadecimal characters (Story 11.2 D2).
function irnFor(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

describe('Edge-sync door sweep - IRN allowlist and blanket payload-site check', () => {
  let server: Server;
  let port: number;
  const run = randomUUID().slice(0, 8);
  const siteA = randomUUID();
  const siteB = randomUUID();

  // Named by what each identity proves, not by its role alone.
  let clerk: Actor; // dispatch_clerk @ warehouse/write/siteA - the admitted recorder
  let gateOfficer: Actor; // NOT on the allowlist, NOT on the old denylist
  let qcInspector: Actor; // ditto, the second non-denylist role
  let clerkFirst: Actor; // dispatch_clerk listed BEFORE another warehouse role
  let clerkSecond: Actor; // dispatch_clerk listed AFTER another warehouse role
  let clerkWrongModule: Actor; // dispatch_clerk on 'inventory', warehouse write held elsewhere
  let clerkReadScope: Actor; // dispatch_clerk at READ scope, warehouse write held elsewhere
  let complianceA: Actor; // compliance/write/siteA - drives the blanket check
  let gstOfficerA: Actor; // gst_officer inventory/write/siteA - drives the ordering arm

  function edgeEnvelope(
    streamType: string,
    streamId: string,
    eventType: string,
    payload: Record<string, unknown>,
    actor: Actor,
    role: string,
    actorLocationId: string,
  ): Record<string, unknown> {
    return {
      event_id: randomUUID(),
      idempotency_key: randomUUID(),
      stream_type: streamType,
      stream_id: streamId,
      event_type: eventType,
      payload,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role, location_id: actorLocationId },
        occurred_at: new Date().toISOString(),
        device_id: `edge-sweep-${run}`,
      },
    };
  }

  function irnPayload(
    dispatchOrderId: string,
    tag: string,
    siteId: string,
  ): Record<string, unknown> {
    return {
      invoice_number_ext: `INV-EDGE-${tag}-${run}`,
      irn_ext: irnFor(`IRN-EDGE-${tag}-${run}`),
      dispatch_order_ids: [dispatchOrderId],
      site_id: siteId,
    };
  }

  function uploadIrn(
    actor: Actor,
    role: string,
    dispatchOrderId: string,
    tag: string,
    siteId = siteA,
    actorLocationId = siteA,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope(
        'warehouse',
        dispatchOrderId,
        'dispatch.irn_recorded',
        irnPayload(dispatchOrderId, tag, siteId),
        actor,
        role,
        actorLocationId,
      ),
      bearer(actor.token),
    );
  }

  async function irnRows(dispatchOrderId: string): Promise<number> {
    const rows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM dispatch_irn WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    return rows.rows[0]?.['n'] as number;
  }

  async function irnEvents(dispatchOrderId: string): Promise<number> {
    const rows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events
        WHERE event_type = 'dispatch.irn_recorded' AND stream_id = $1`,
      [dispatchOrderId],
    );
    return rows.rows[0]?.['n'] as number;
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of HARNESS_DDL) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query(`TRUNCATE ${TRUNCATE_LIST} CASCADE`);

    server = createAppServer();
    await new Promise<void>((resolvePromise) => server.listen(0, 'localhost', resolvePromise));
    port = (server.address() as AddressInfo).port;

    await seedLocation(siteA, `SITE-A-EDGE-${run}`, siteA);
    await seedLocation(siteB, `SITE-B-EDGE-${run}`, siteB);

    clerk = await provisionUser(port, `edge-clerk-${run}@example.com`, 'Dispatch Clerk', [
      { role: 'dispatch_clerk', module: 'warehouse', functionScope: 'write', locationId: siteA },
    ]);
    gateOfficer = await provisionUser(port, `edge-gate-${run}@example.com`, 'Gate Officer', [
      { role: 'gate_officer', module: 'warehouse', functionScope: 'write', locationId: siteA },
    ]);
    qcInspector = await provisionUser(port, `edge-qc-${run}@example.com`, 'QC Inspector', [
      { role: 'qc_inspector', module: 'warehouse', functionScope: 'write', locationId: siteA },
    ]);
    clerkFirst = await provisionUser(port, `edge-multi-a-${run}@example.com`, 'Clerk First', [
      { role: 'dispatch_clerk', module: 'warehouse', functionScope: 'write', locationId: siteA },
      {
        role: 'warehouse_operator',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    clerkSecond = await provisionUser(port, `edge-multi-b-${run}@example.com`, 'Clerk Second', [
      {
        role: 'warehouse_operator',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteA,
      },
      { role: 'dispatch_clerk', module: 'warehouse', functionScope: 'write', locationId: siteA },
    ]);
    // Both of the module/scope identities also hold a warehouse WRITE assignment under a role that
    // is not on the allowlist. Without it requireRole would refuse them MODULE_ACCESS_DENIED at the
    // door and the arm would be vacuous - it must reach the IRN gate and be refused BY IT.
    clerkWrongModule = await provisionUser(
      port,
      `edge-mod-${run}@example.com`,
      'Clerk Wrong Module',
      [
        { role: 'dispatch_clerk', module: 'inventory', functionScope: 'write', locationId: siteA },
        { role: 'gate_officer', module: 'warehouse', functionScope: 'write', locationId: siteA },
      ],
    );
    clerkReadScope = await provisionUser(port, `edge-read-${run}@example.com`, 'Clerk Read Scope', [
      { role: 'dispatch_clerk', module: 'warehouse', functionScope: 'read', locationId: siteA },
      { role: 'gate_officer', module: 'warehouse', functionScope: 'write', locationId: siteA },
    ]);
    complianceA = await provisionUser(
      port,
      `edge-compliance-${run}@example.com`,
      'Compliance Admin',
      [
        {
          role: 'compliance_admin',
          module: 'compliance',
          functionScope: 'write',
          locationId: siteA,
        },
      ],
    );
    gstOfficerA = await provisionUser(port, `edge-gst-${run}@example.com`, 'GST Officer', [
      { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: siteA },
    ]);
  });

  after(async () => {
    await closePool();
    await closeAdminPool();
    await new Promise<void>((resolvePromise, reject) => {
      server.close((err) => (err ? reject(err) : resolvePromise()));
    });
  });

  // --- Arm 1: the IRN gate is an ALLOWLIST, not the old two-role denylist ---------------------

  it('Arm 1: a gate_officer and a qc_inspector holding warehouse write are refused FUNCTION_ACCESS_DENIED and write no dispatch_irn row; a genuine dispatch_clerk still succeeds', async () => {
    // THIS IS THE ARM THAT MATTERS. Neither role is on the allowlist and neither was on the old
    // denylist, so before the sweep both were ADMITTED and lifted a statutory block through edge
    // sync. Each holds warehouse WRITE at the site named in the payload, so the refusal cannot come
    // from the module, the scope or the site - only from the allowlist itself.
    for (const [role, actor] of [
      ['gate_officer', gateOfficer],
      ['qc_inspector', qcInspector],
    ] as Array<[string, Actor]>) {
      const orderId = randomUUID();
      await seedErpSalesOrder(orderId, `SO-EDGE-${role}-${run}`, siteA);

      const refused = await uploadIrn(actor, role, orderId, role.toUpperCase());
      assert.equal(refused.status, 403, refused.raw);
      assert.equal(
        refused.body['error_code'],
        'FUNCTION_ACCESS_DENIED',
        `${role} must be refused by the IRN allowlist: ${refused.raw}`,
      );
      assert.deepEqual(detailsOf(refused.body)['required_roles'], [
        'dispatch_clerk',
        'warehouse_manager',
      ]);
      // The statutory block is still standing: nothing was recorded and no event was appended.
      assert.equal(await irnRows(orderId), 0, `${role} must not write a dispatch_irn row`);
      assert.equal(await irnEvents(orderId), 0, `${role} must not append an event`);
    }

    // The arm cannot pass by refusing everything: the allowlisted role is admitted, the row lands,
    // and recorded_by is the AUTHENTICATED actor.
    const clerkOrderId = randomUUID();
    await seedErpSalesOrder(clerkOrderId, `SO-EDGE-CLERK-${run}`, siteA);
    const accepted = await uploadIrn(clerk, 'dispatch_clerk', clerkOrderId, 'CLERK');
    assert.equal(accepted.status, 201, accepted.raw);
    const row = await getPool().query(
      `SELECT irn_ext, recorded_by FROM dispatch_irn WHERE dispatch_order_id = $1`,
      [clerkOrderId],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0]?.['irn_ext'], irnFor(`IRN-EDGE-CLERK-${run}`));
    assert.equal(row.rows[0]?.['recorded_by'], clerk.userId);
  });

  // --- Arm 6: two-door parity, the property the sweep exists to restore -----------------------

  it('Arm 6: the SAME dispatch.irn_recorded payload is refused FUNCTION_ACCESS_DENIED at BOTH doors for a gate_officer, and admitted at both for a dispatch_clerk', async () => {
    const doorOrderId = randomUUID();
    await seedErpSalesOrder(doorOrderId, `SO-EDGE-PAR-${run}`, siteA);
    const payload = irnPayload(doorOrderId, 'PARITY', siteA);

    const eventsDoor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'warehouse',
        stream_id: doorOrderId,
        event_type: 'dispatch.irn_recorded',
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: gateOfficer.userId, role: 'gate_officer', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      bearer(gateOfficer.token),
    );
    assert.equal(eventsDoor.status, 403, eventsDoor.raw);
    assert.equal(eventsDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const edgeDoor = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope(
        'warehouse',
        doorOrderId,
        'dispatch.irn_recorded',
        payload,
        gateOfficer,
        'gate_officer',
        siteA,
      ),
      bearer(gateOfficer.token),
    );
    assert.equal(edgeDoor.status, 403, edgeDoor.raw);
    assert.equal(edgeDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.equal(edgeDoor.body['error_code'], eventsDoor.body['error_code']);
    assert.equal(await irnRows(doorOrderId), 0, 'neither door may record the IRN');

    // The parity is two-sided: the allowlisted role passes both doors on the identical payload.
    const clerkDoor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'warehouse',
        stream_id: doorOrderId,
        event_type: 'dispatch.irn_recorded',
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: clerk.userId, role: 'dispatch_clerk', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      bearer(clerk.token),
    );
    assert.ok(clerkDoor.status >= 200 && clerkDoor.status < 300, clerkDoor.raw);
    assert.equal(await irnRows(doorOrderId), 1);
  });

  // --- Arm 2: filtered across ALL assignments, not one arbitrarily-selected one ---------------

  it('Arm 2: a user holding dispatch_clerk PLUS another warehouse role is admitted regardless of assignment ordering', async () => {
    // The pre-sweep gate read the single assignment requireRole happened to select, so the same
    // user was admitted or refused depending on which one sorted first. Both orderings are driven.
    for (const [label, actor] of [
      ['clerk-first', clerkFirst],
      ['clerk-second', clerkSecond],
    ] as Array<[string, Actor]>) {
      const orderId = randomUUID();
      await seedErpSalesOrder(orderId, `SO-EDGE-${label}-${run}`, siteA);
      const result = await uploadIrn(actor, 'dispatch_clerk', orderId, label.toUpperCase());
      assert.equal(
        result.status,
        201,
        `${label} holds dispatch_clerk and must be admitted: ${result.raw}`,
      );
      assert.equal(await irnRows(orderId), 1, `${label} must record the IRN`);
    }
  });

  // --- Arm 3: the module and scope halves of the gate -----------------------------------------

  it('Arm 3: a dispatch_clerk assignment on the wrong module, and one at read scope, are both refused FUNCTION_ACCESS_DENIED', async () => {
    for (const [label, actor] of [
      ['wrong-module', clerkWrongModule],
      ['read-scope', clerkReadScope],
    ] as Array<[string, Actor]>) {
      const orderId = randomUUID();
      await seedErpSalesOrder(orderId, `SO-EDGE-${label}-${run}`, siteA);
      // The actor reaches the gate on their gate_officer warehouse-write assignment, so this is a
      // refusal BY THE IRN GATE, not a module or scope refusal at the door.
      const result = await uploadIrn(actor, 'dispatch_clerk', orderId, label.toUpperCase());
      assert.equal(result.status, 403, result.raw);
      assert.equal(result.body['error_code'], 'FUNCTION_ACCESS_DENIED', `${label}: ${result.raw}`);
      assert.deepEqual(detailsOf(result.body)['required_roles'], [
        'dispatch_clerk',
        'warehouse_manager',
      ]);
      assert.equal(await irnRows(orderId), 0, `${label} must not record the IRN`);
    }
  });

  // --- Arm 4: the blanket payload-site check ---------------------------------------------------

  it('Arm 4: an event type with NO specific edge gate is refused LOCATION_ACCESS_DENIED for a site the actor does not hold, and succeeds for one they do', async () => {
    // compliance.bis_licence_recorded has no per-event-type gate on the edge door and its seam
    // (src/compliance/master-data.ts) checks that the site EXISTS, never that the ACTOR holds it -
    // so before the sweep this upload was accepted and a site-B licence was written by a site-A
    // compliance admin. Both sites are real locations, so the refusal can only be the actor-to-site
    // check.
    const sku = `SKU-EDGE-BIS-${run}`;
    await seedItem(sku);

    const foreignLicenceId = randomUUID();
    const foreign = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope(
        'compliance',
        foreignLicenceId,
        'compliance.bis_licence_recorded',
        {
          licence_id: foreignLicenceId,
          licence_number: `CML-EDGE-B-${run}`,
          licence_type: 'cml',
          sku,
          site_id: siteB,
          valid_from: '2026-01-01',
          valid_to: '2027-01-01',
        },
        complianceA,
        'compliance_admin',
        siteA,
      ),
      bearer(complianceA.token),
    );
    assert.equal(foreign.status, 403, foreign.raw);
    assert.equal(foreign.body['error_code'], 'LOCATION_ACCESS_DENIED', foreign.raw);
    const noRow = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM compliance_bis_licence WHERE licence_id = $1`,
      [foreignLicenceId],
    );
    assert.equal(noRow.rows[0]?.['n'], 0, 'a foreign-site licence must not be written');

    // The same event for the site the actor DOES hold lands, so the arm is not a blanket refusal.
    const ownLicenceId = randomUUID();
    const own = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope(
        'compliance',
        ownLicenceId,
        'compliance.bis_licence_recorded',
        {
          licence_id: ownLicenceId,
          licence_number: `CML-EDGE-A-${run}`,
          licence_type: 'cml',
          sku,
          site_id: siteA,
          valid_from: '2026-01-01',
          valid_to: '2027-01-01',
        },
        complianceA,
        'compliance_admin',
        siteA,
      ),
      bearer(complianceA.token),
    );
    assert.equal(own.status, 201, own.raw);
    const ownRow = await getPool().query(
      `SELECT site_id, sku FROM compliance_bis_licence WHERE licence_id = $1`,
      [ownLicenceId],
    );
    assert.equal(ownRow.rows.length, 1);
    assert.equal(ownRow.rows[0]?.['site_id'], siteA);
    assert.equal(ownRow.rows[0]?.['sku'], sku);
  });

  // --- Arm 5: gate ORDERING - the specific gate answers before the blanket one -----------------

  it('Arm 5: a wrong-site gst_officer on transfer_request.valuation_overridden still gets the specific FUNCTION_ACCESS_DENIED, not the blanket LOCATION_ACCESS_DENIED', async () => {
    // assertEdgePayloadSiteWriteAccess is ordered LAST deliberately, matching the events door: a
    // wrong-site GST officer must keep the precise refusal Story 11.5 pins, with its site_id and
    // required_roles details. If the blanket check ever moved ahead of the specific gates this arm
    // fails with LOCATION_ACCESS_DENIED.
    const transferId = randomUUID();
    const result = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope(
        'inventory',
        transferId,
        'transfer_request.valuation_overridden',
        {
          transfer_request_id: transferId,
          site_id: siteB,
          business_stream: 'production',
          valuation_basis: 'like_kind_quality',
          declared_unit_value: 130,
          reason_code: 'EDGE_SWEEP',
        },
        gstOfficerA,
        'gst_officer',
        siteA,
      ),
      bearer(gstOfficerA.token),
    );
    assert.equal(result.status, 403, result.raw);
    assert.equal(result.body['error_code'], 'FUNCTION_ACCESS_DENIED', result.raw);
    assert.equal(detailsOf(result.body)['site_id'], siteB);
    assert.deepEqual(detailsOf(result.body)['required_roles'], ['gst_officer']);
  });
});

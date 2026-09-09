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
// POST /api/v1/events and POST /api/v1/edge/events are meant to be twins. Three holes were closed
// on the edge door and this file is their only coverage:
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
//   3. The three Story 3.7 dispatch gates (dispatch.packed,
//      dispatch.shipping_documents_generated, dispatch.dispatched) were the same shape of denylist
//      as (1) - store_assistant / warehouse_operator refused, every other role admitted by default,
//      read off one arbitrarily-selected assignment. They are now allowlists mirroring
//      DISPATCH_WRITE_ROLES / DISPATCH_DOC_WRITE_ROLES in src/api/v1/dispatch.ts, which is what the
//      REST routes enforce.
//   4. That conversion exposed a gap on the OTHER door: POST /api/v1/events applied no role gate at
//      all to those same three event types (no reference in events.ts, no site_id in their payloads
//      for assertPayloadSiteWriteAccess to bind to, and no role check in src/compliance/dispatch.ts),
//      so any holder of warehouse write could pack, document and ship there. assertDispatchSodFunctionAccess
//      closes it with the same two lists. It has NO site half by design - these payloads carry no
//      site id - and neither does the edge door's; do not add an arm asserting one.
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
  '../../read/projections/lot_master.sql',
  '../../read/projections/stock_balance.sql',
  '../../read/projections/pick_task.sql',
  '../../read/projections/pick_line.sql',
  '../../read/projections/packing_record.sql',
  '../../read/projections/dispatch_document.sql',
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

async function seedLocation(
  locationId: string,
  code: string,
  siteId: string,
  level = 'site',
  parentId: string | null = null,
  pickSequence: number | null = null,
): Promise<void> {
  await getAdminPool().query(
    `INSERT INTO location_register
       (location_id, location_code, level, parent_location_id, site_id, zone_type,
        temperature_class, size_class, hazmat_allowed, quarantine, access_restricted, status,
        pick_sequence)
     VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active', $6)`,
    [locationId, code, level, parentId, siteId, pickSequence],
  );
}

async function createLot(lotNumber: string, sku: string, lotId: string): Promise<void> {
  await getAdminPool().query(
    `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status)
     VALUES ($1, $2, $3, 'none')`,
    [lotId, lotNumber, sku],
  );
}

async function seedStock(
  sku: string,
  locationId: string,
  lotNumber: string,
  onHand: number,
): Promise<void> {
  await getAdminPool().query(
    `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
     VALUES ($1, $2, $3, 'owned', $4)`,
    [sku, locationId, lotNumber, onHand],
  );
}

// erp_sales_order is a direct-upsert reference projection (Story 2.9), not event-sourced. An IRN can
// be recorded against a line before any picking exists (Story 11.2 decision D3), so this is the only
// fixture the IRN arms need - no pick/pack/document machinery.
async function seedErpSalesOrder(
  id: string,
  soNumberExt: string,
  siteId: string,
  sku = `SKU-${soNumberExt}`,
  quantity = '5',
): Promise<void> {
  await getAdminPool().query(
    `INSERT INTO erp_sales_order
       (id, so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext,
        ship_to_ext, status, source_system, last_synced_at)
     VALUES ($1, $2, 1, $3, $4, $5, 'SITE-EDGE', 'Customer EDGE', 'open', 'ERP', now())`,
    [id, soNumberExt, sku, quantity, siteId],
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
  let manager: Actor; // warehouse_manager - generates pick tasks for the staging fixture
  let operator: Actor; // warehouse_operator - confirms pick lines for the staging fixture
  let inventoryController: Actor; // on the DOC list only - proves the two lists differ

  // The Story 3.7 staging fixture: a bin with stock, one confirmed pick line, so the dispatch-side
  // event types below reach their seams in a legitimate state rather than being refused for a
  // reason unrelated to the role gate.
  const zoneId = randomUUID();
  const binId = randomUUID();

  async function stageToPack(
    dispatchOrderId: string,
    tag: string,
  ): Promise<{ sku: string; lotId: string; quantity: string }> {
    const sku = `SKU-EDGE-${tag}-${run}`;
    const lotNumber = `LOT-EDGE-${tag}-${run}`;
    const lotId = randomUUID();
    const quantity = '10';

    await seedErpSalesOrder(dispatchOrderId, `SO-EDGE-${tag}-${run}`, siteA, sku, quantity);
    await createLot(lotNumber, sku, lotId);
    await seedStock(sku, binId, lotNumber, Number(quantity));

    const pick = await makeRequest(
      port,
      'POST',
      '/api/v1/pick-tasks/generate',
      {
        dispatchOrderId,
        dispatchOrderLineIds: [dispatchOrderId],
        strategy: 'single',
      },
      bearer(manager.token),
    );
    assert.equal(pick.status, 201, `pick generation failed for ${tag}: ${pick.raw}`);
    const pickTaskId = (pick.body['pickTaskIds'] as string[] | undefined)?.[0];
    const pickLineId = (pick.body['pickLineIds'] as string[] | undefined)?.[0];
    assert(
      typeof pickTaskId === 'string' && typeof pickLineId === 'string',
      `pick response incomplete for ${tag}: ${pick.raw}`,
    );

    const confirm = await makeRequest(
      port,
      'POST',
      `/api/v1/pick-tasks/${pickTaskId}/lines/${pickLineId}/confirm`,
      { confirmedLotId: lotId, confirmedQuantity: quantity, captureMethod: 'PWA' },
      bearer(operator.token),
    );
    assert.equal(confirm.status, 200, `pick confirmation failed for ${tag}: ${confirm.raw}`);
    return { sku, lotId, quantity };
  }

  function uploadEdge(
    actor: Actor,
    role: string,
    dispatchOrderId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      edgeEnvelope('warehouse', dispatchOrderId, eventType, payload, actor, role, siteA),
      bearer(actor.token),
    );
  }

  function postEvents(
    actor: Actor,
    role: string,
    streamId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'warehouse',
        stream_id: streamId,
        event_type: eventType,
        payload,
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actor.userId, role, location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      bearer(actor.token),
    );
  }

  function packPayload(
    dispatchOrderId: string,
    staged: { sku: string; lotId: string; quantity: string },
  ): Record<string, unknown> {
    return {
      packing_record_id: randomUUID(),
      dispatch_order_id: dispatchOrderId,
      sku: staged.sku,
      packed_qty: staged.quantity,
      lot_id: staged.lotId,
      carton_count: 2,
      actual_weight_kg: '4.0',
    };
  }

  async function eventCount(dispatchOrderId: string, eventType: string): Promise<number> {
    const rows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events WHERE stream_id = $1 AND event_type = $2`,
      [dispatchOrderId, eventType],
    );
    return rows.rows[0]?.['n'] as number;
  }

  async function orderStatus(
    dispatchOrderId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await getPool().query(
      `SELECT packed_at, dispatched_at FROM dispatch_order_status WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    return rows.rows[0] as Record<string, unknown> | undefined;
  }

  async function documentCount(dispatchOrderId: string): Promise<number> {
    const rows = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM dispatch_document WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    return rows.rows[0]?.['n'] as number;
  }

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

    // The Story 3.7 arms need a real pickable bin under siteA.
    const aisleId = randomUUID();
    const rackId = randomUUID();
    await seedLocation(zoneId, `ZONE-EDGE-${run}`, siteA, 'zone', siteA);
    await seedLocation(aisleId, `AISLE-EDGE-${run}`, siteA, 'aisle', zoneId);
    await seedLocation(rackId, `RACK-EDGE-${run}`, siteA, 'rack', aisleId);
    await seedLocation(binId, `BIN-EDGE-${run}`, siteA, 'bin', rackId, 10);

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
    manager = await provisionUser(port, `edge-manager-${run}@example.com`, 'Warehouse Manager', [
      { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId: siteA },
    ]);
    operator = await provisionUser(port, `edge-operator-${run}@example.com`, 'Warehouse Operator', [
      {
        role: 'warehouse_operator',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteA,
      },
    ]);
    inventoryController = await provisionUser(
      port,
      `edge-invctl-${run}@example.com`,
      'Inventory Controller',
      [
        {
          role: 'inventory_controller',
          module: 'warehouse',
          functionScope: 'write',
          locationId: siteA,
        },
      ],
    );
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

  // --- Arm 7: the three Story 3.7 dispatch gates, converted denylist -> allowlist --------------

  const DISPATCH_WRITE_ROLES = ['dispatch_clerk', 'warehouse_manager'];
  const DISPATCH_DOC_WRITE_ROLES = ['dispatch_clerk', 'warehouse_manager', 'inventory_controller'];

  it('Arm 7: dispatch.packed, dispatch.shipping_documents_generated and dispatch.dispatched refuse a gate_officer and a qc_inspector with FUNCTION_ACCESS_DENIED, and a dispatch_clerk still performs all three', async () => {
    // The pre-conversion gates rejected a DENYLIST of store_assistant / warehouse_operator and
    // admitted every other role by default, so each of these identities could pack, document and
    // ship a real order through edge sync - all three SoD-guarded, dispatch-side actions. The order
    // is genuinely staged (stock, a confirmed pick line), so nothing but the role gate can be
    // producing the refusal.
    const orderId = randomUUID();
    const staged = await stageToPack(orderId, 'S37');

    for (const [role, actor] of [
      ['gate_officer', gateOfficer],
      ['qc_inspector', qcInspector],
    ] as Array<[string, Actor]>) {
      const denied = await uploadEdge(
        actor,
        role,
        orderId,
        'dispatch.packed',
        packPayload(orderId, staged),
      );
      assert.equal(denied.status, 403, denied.raw);
      assert.equal(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED', `${role}: ${denied.raw}`);
      assert.deepEqual(detailsOf(denied.body)['required_roles'], DISPATCH_WRITE_ROLES);
    }
    assert.equal(await eventCount(orderId, 'dispatch.packed'), 0, 'no packing event may persist');
    assert.equal((await orderStatus(orderId))?.['packed_at'], null, 'the order stays unpacked');

    const packed = await uploadEdge(
      clerk,
      'dispatch_clerk',
      orderId,
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.equal(packed.status, 201, packed.raw);
    assert.notEqual((await orderStatus(orderId))?.['packed_at'], null);

    // Document generation carries the WIDER list, so its refusal names three roles, not two.
    const docsDenied = await uploadEdge(
      gateOfficer,
      'gate_officer',
      orderId,
      'dispatch.shipping_documents_generated',
      { dispatch_order_id: orderId, document_types: ['bol', 'packing_slip'] },
    );
    assert.equal(docsDenied.status, 403, docsDenied.raw);
    assert.equal(docsDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED', docsDenied.raw);
    assert.deepEqual(detailsOf(docsDenied.body)['required_roles'], DISPATCH_DOC_WRITE_ROLES);
    assert.equal(await documentCount(orderId), 0, 'no shipping document may be generated');

    const docs = await uploadEdge(
      clerk,
      'dispatch_clerk',
      orderId,
      'dispatch.shipping_documents_generated',
      { dispatch_order_id: orderId, document_types: ['bol', 'packing_slip'] },
    );
    assert.equal(docs.status, 201, docs.raw);
    assert.ok((await documentCount(orderId)) > 0);

    // The Story 11.2 wall has to come down before dispatch is reachable at all, so the refusal
    // below is the ROLE gate and not IRN_MISSING.
    const irn = await uploadIrn(clerk, 'dispatch_clerk', orderId, 'S37');
    assert.equal(irn.status, 201, irn.raw);

    const shipDenied = await uploadEdge(
      gateOfficer,
      'gate_officer',
      orderId,
      'dispatch.dispatched',
      {
        dispatch_order_id: orderId,
      },
    );
    assert.equal(shipDenied.status, 403, shipDenied.raw);
    assert.equal(shipDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED', shipDenied.raw);
    assert.deepEqual(detailsOf(shipDenied.body)['required_roles'], DISPATCH_WRITE_ROLES);
    assert.equal(await eventCount(orderId, 'dispatch.dispatched'), 0);
    assert.equal((await orderStatus(orderId))?.['dispatched_at'], null, 'the goods stay put');

    const shipped = await uploadEdge(clerk, 'dispatch_clerk', orderId, 'dispatch.dispatched', {
      dispatch_order_id: orderId,
    });
    assert.equal(shipped.status, 201, shipped.raw);
    assert.notEqual((await orderStatus(orderId))?.['dispatched_at'], null);
  });

  // --- Arm 8: the doc-generation allowlist is genuinely wider ---------------------------------

  it('Arm 8: an inventory_controller is refused on dispatch.packed and dispatch.dispatched but ADMITTED on dispatch.shipping_documents_generated', async () => {
    // If the two lists were ever collapsed into one, this arm is the only thing that notices.
    const orderId = randomUUID();
    const staged = await stageToPack(orderId, 'IC');

    const packDenied = await uploadEdge(
      inventoryController,
      'inventory_controller',
      orderId,
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.equal(packDenied.status, 403, packDenied.raw);
    assert.equal(packDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED', packDenied.raw);
    assert.deepEqual(detailsOf(packDenied.body)['required_roles'], DISPATCH_WRITE_ROLES);
    assert.equal((await orderStatus(orderId))?.['packed_at'], null);

    const packed = await uploadEdge(
      clerk,
      'dispatch_clerk',
      orderId,
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.equal(packed.status, 201, packed.raw);

    // The same identity, one event type later, IS on the list.
    const docs = await uploadEdge(
      inventoryController,
      'inventory_controller',
      orderId,
      'dispatch.shipping_documents_generated',
      { dispatch_order_id: orderId, document_types: ['bol'] },
    );
    assert.equal(docs.status, 201, docs.raw);
    assert.ok((await documentCount(orderId)) > 0);

    const irn = await uploadIrn(clerk, 'dispatch_clerk', orderId, 'IC');
    assert.equal(irn.status, 201, irn.raw);

    const shipDenied = await uploadEdge(
      inventoryController,
      'inventory_controller',
      orderId,
      'dispatch.dispatched',
      { dispatch_order_id: orderId },
    );
    assert.equal(shipDenied.status, 403, shipDenied.raw);
    assert.equal(shipDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED', shipDenied.raw);
    assert.deepEqual(detailsOf(shipDenied.body)['required_roles'], DISPATCH_WRITE_ROLES);
    assert.equal((await orderStatus(orderId))?.['dispatched_at'], null);
  });

  // --- Arm 9: filtered across ALL assignments, not one arbitrarily-selected one ---------------

  it('Arm 9: a user holding dispatch_clerk plus another warehouse role packs regardless of provisioning order', async () => {
    for (const [label, actor] of [
      ['clerk-first', clerkFirst],
      ['clerk-second', clerkSecond],
    ] as Array<[string, Actor]>) {
      const orderId = randomUUID();
      const staged = await stageToPack(orderId, `PACK-${label}`);
      const packed = await uploadEdge(
        actor,
        'dispatch_clerk',
        orderId,
        'dispatch.packed',
        packPayload(orderId, staged),
      );
      assert.equal(packed.status, 201, `${label} holds dispatch_clerk: ${packed.raw}`);
      assert.notEqual((await orderStatus(orderId))?.['packed_at'], null);
    }
  });

  // --- Arm 10: the module and scope halves of the shared gate ---------------------------------

  it('Arm 10: a dispatch_clerk assignment on the wrong module, and one at read scope, cannot pack; the same order packs for a real clerk', async () => {
    const orderId = randomUUID();
    const staged = await stageToPack(orderId, 'MODSCOPE');

    for (const [label, actor] of [
      ['wrong-module', clerkWrongModule],
      ['read-scope', clerkReadScope],
    ] as Array<[string, Actor]>) {
      // Both reach the gate on their gate_officer warehouse-write assignment, so this is a refusal
      // BY THE GATE, not a module or scope refusal at the door.
      const denied = await uploadEdge(
        actor,
        'dispatch_clerk',
        orderId,
        'dispatch.packed',
        packPayload(orderId, staged),
      );
      assert.equal(denied.status, 403, denied.raw);
      assert.equal(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED', `${label}: ${denied.raw}`);
      assert.deepEqual(detailsOf(denied.body)['required_roles'], DISPATCH_WRITE_ROLES);
    }
    assert.equal((await orderStatus(orderId))?.['packed_at'], null);

    // Non-vacuity: the order itself was packable all along.
    const packed = await uploadEdge(
      clerk,
      'dispatch_clerk',
      orderId,
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.equal(packed.status, 201, packed.raw);
    assert.notEqual((await orderStatus(orderId))?.['packed_at'], null);
  });

  // --- Arm 11: the same three gates, on the EVENTS door (the gap this file found) --------------

  it('Arm 11: POST /api/v1/events refuses a gate_officer on all three dispatch-side event types for a fully-picked order, admits inventory_controller on documents only, and admits a dispatch_clerk throughout', async () => {
    // Until 2026-09-09 the events door applied NO role gate to these three event types: no
    // reference in events.ts, no site_id in the payloads for assertPayloadSiteWriteAccess to bind
    // to, and no role check in the dispatch seam. A gate_officer post reached BUSINESS-STATE
    // validation and came back 400 DISPATCH_ORDER_NOT_PICKED - which is why this arm uses a
    // genuinely staged, fully-picked order and asserts the status AND the code: on this order the
    // pre-fix door would have PACKED it, so nothing weaker than 403 FUNCTION_ACCESS_DENIED can
    // satisfy the arm.
    const orderId = randomUUID();
    const staged = await stageToPack(orderId, 'DOOR');

    const packDenied = await postEvents(
      gateOfficer,
      'gate_officer',
      orderId,
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.equal(packDenied.status, 403, packDenied.raw);
    assert.equal(packDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED', packDenied.raw);
    assert.deepEqual(detailsOf(packDenied.body)['required_roles'], DISPATCH_WRITE_ROLES);
    assert.equal(await eventCount(orderId, 'dispatch.packed'), 0);
    assert.equal((await orderStatus(orderId))?.['packed_at'], null, 'the order stays unpacked');

    const packed = await postEvents(
      clerk,
      'dispatch_clerk',
      orderId,
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.ok(packed.status >= 200 && packed.status < 300, packed.raw);
    assert.notEqual((await orderStatus(orderId))?.['packed_at'], null);

    // Documents: the wider list, named in the refusal ...
    const docsDenied = await postEvents(
      gateOfficer,
      'gate_officer',
      orderId,
      'dispatch.shipping_documents_generated',
      { dispatch_order_id: orderId, document_types: ['bol', 'packing_slip'] },
    );
    assert.equal(docsDenied.status, 403, docsDenied.raw);
    assert.equal(docsDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED', docsDenied.raw);
    assert.deepEqual(detailsOf(docsDenied.body)['required_roles'], DISPATCH_DOC_WRITE_ROLES);
    assert.equal(await documentCount(orderId), 0);

    // ... and genuinely wider: inventory_controller passes HERE and nowhere else.
    const docs = await postEvents(
      inventoryController,
      'inventory_controller',
      orderId,
      'dispatch.shipping_documents_generated',
      { dispatch_order_id: orderId, document_types: ['bol', 'packing_slip'] },
    );
    assert.ok(docs.status >= 200 && docs.status < 300, docs.raw);
    assert.ok((await documentCount(orderId)) > 0);

    // The Story 11.2 wall comes down first, so the dispatch refusals below are the ROLE gate.
    const irn = await uploadIrn(clerk, 'dispatch_clerk', orderId, 'DOOR');
    assert.equal(irn.status, 201, irn.raw);

    for (const [role, actor] of [
      ['gate_officer', gateOfficer],
      ['inventory_controller', inventoryController],
    ] as Array<[string, Actor]>) {
      const denied = await postEvents(actor, role, orderId, 'dispatch.dispatched', {
        dispatch_order_id: orderId,
      });
      assert.equal(denied.status, 403, denied.raw);
      assert.equal(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED', `${role}: ${denied.raw}`);
      assert.deepEqual(detailsOf(denied.body)['required_roles'], DISPATCH_WRITE_ROLES);
    }
    assert.equal((await orderStatus(orderId))?.['dispatched_at'], null, 'the goods stay put');

    // inventory_controller is refused on packing too - the two lists differ at both ends.
    const icPack = await postEvents(
      inventoryController,
      'inventory_controller',
      randomUUID(),
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.equal(icPack.status, 403, icPack.raw);
    assert.equal(icPack.body['error_code'], 'FUNCTION_ACCESS_DENIED', icPack.raw);
    assert.deepEqual(detailsOf(icPack.body)['required_roles'], DISPATCH_WRITE_ROLES);

    const shipped = await postEvents(clerk, 'dispatch_clerk', orderId, 'dispatch.dispatched', {
      dispatch_order_id: orderId,
    });
    assert.ok(shipped.status >= 200 && shipped.status < 300, shipped.raw);
    assert.notEqual((await orderStatus(orderId))?.['dispatched_at'], null);
  });

  // --- Arm 12: two-door parity for the dispatch-side gates ------------------------------------

  it('Arm 12: the SAME dispatch.packed payload and identity are refused FUNCTION_ACCESS_DENIED at BOTH doors, and admitted at both for a dispatch_clerk', async () => {
    // This is the arm that would have caught the original gap: the doors are compared directly on
    // one payload rather than each being pinned in isolation.
    const orderId = randomUUID();
    const staged = await stageToPack(orderId, 'PARITY37');
    const payload = packPayload(orderId, staged);

    const eventsDoor = await postEvents(
      gateOfficer,
      'gate_officer',
      orderId,
      'dispatch.packed',
      payload,
    );
    const edgeDoor = await uploadEdge(
      gateOfficer,
      'gate_officer',
      orderId,
      'dispatch.packed',
      payload,
    );
    assert.equal(eventsDoor.status, 403, eventsDoor.raw);
    assert.equal(edgeDoor.status, 403, edgeDoor.raw);
    assert.equal(eventsDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED', eventsDoor.raw);
    assert.equal(edgeDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED', edgeDoor.raw);
    assert.equal(edgeDoor.body['error_code'], eventsDoor.body['error_code']);
    assert.deepEqual(detailsOf(eventsDoor.body)['required_roles'], DISPATCH_WRITE_ROLES);
    assert.deepEqual(detailsOf(edgeDoor.body)['required_roles'], DISPATCH_WRITE_ROLES);
    assert.equal(await eventCount(orderId, 'dispatch.packed'), 0, 'neither door may pack');
    assert.equal((await orderStatus(orderId))?.['packed_at'], null);

    // Two-sided: the allowlisted role passes at the events door, and the order is genuinely
    // packable - so neither refusal above was the order's own state.
    const packed = await postEvents(
      clerk,
      'dispatch_clerk',
      orderId,
      'dispatch.packed',
      packPayload(orderId, staged),
    );
    assert.ok(packed.status >= 200 && packed.status < 300, packed.raw);
    assert.notEqual((await orderStatus(orderId))?.['packed_at'], null);
  });
});

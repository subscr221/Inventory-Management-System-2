import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createAppServer, createAppRouter } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import type { EventEnvelope } from '../../src/events/store.js';
// Chunk-3 review T15/T34: two arms drive the APPLIERS directly rather than a door, because the
// behaviours they pin are unreachable through one. `persistEvent` short-circuits on the stored
// idempotency key / event id BEFORE any applier runs, so the override applier's own
// source_event_id replay guard (P10) can only be reached by calling it; and a projection rebuild
// is by definition a replay of stored events against emptied tables.
import {
  applyTransferRequestProjection,
  applyTransferValuationOverridden,
  applyTransferGstDocumentRecorded,
} from '../../src/compliance/transfer-request.js';

// ---------------------------------------------------------------------------
// Story 11.5 - Branch transfer valuation and GST documents (AC 1 to AC 6)
//
// A stock transfer whose source and destination sites resolve to two DIFFERENT GSTINs is an
// inter-GSTIN taxable supply: valued under Rule 28 on the pair's dated default basis at create,
// re-valuable by a gst_officer until a document exists, and blocked at ship (409
// GST_DOCUMENTS_REQUIRED, on BOTH doors, with an audit row) until the ERP-issued tax invoice (with
// IRN) and, above the threshold, the e-way bill are recorded. Same-GSTIN and intra-site transfers
// are untouched. A site with no registration or a pair with no configuration fails closed.
//
// Real PostgreSQL, the real router, SCIM provisioning and dev-token auth. Every arm is STRICT: it
// asserts the specific error code and selects audit rows by THIS transfer's id (the 11.2 review
// found two vacuous arms). Fixture windows are ABSOLUTE past dates (no relative "today minus one"
// that can straddle the IST midnight). Helpers are local; never import cross-story.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

// Valid GSTINs (state code, PAN-shaped middle, Z, check digit). GSTIN_REGEX is a shape check only.
const GSTIN_A = '27AAACI1234A1Z5';
const GSTIN_B = '29AAACI1234A1Z1';
const GSTIN_E = '33AAACI1234A1Z7';
const GSTIN_F = '36AAACI1234A1Z2';
const GSTIN_G = '07AAACI1234A1Z9'; // siteG: re-registered mid-flight by the D1 regression arm
const GSTIN_H = '19AAACI1234A1Z3'; // siteH: like_kind_quality default, for the D3 role gate
const GSTIN_I = '24AAACI1234A1Z8'; // siteI: invoice_value_full_itc default, recipient ITC-eligible
const GSTIN_J = '10AAACI1234A1Z4'; // siteJ: the close-route invariant arm closes its config, then it
const GSTIN_K = '21AAACI1234A1Z6'; // siteK: a CLOSED-ended window, for the effective_from/to boundaries
const GSTIN_M = '23AAACI1234A1Z0'; // siteM: the close-route lifecycle arm owns this registration

function irnFor(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

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

async function scimCreateUser(
  port: number,
  externalId: string,
  displayName: string,
  roles: Role[],
): Promise<string> {
  const result = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName, roles },
    SCIM_HEADERS,
  );
  assert.equal(result.status, 201, `SCIM user creation failed: ${result.raw}`);
  const userId = result.body['userId'];
  assert(typeof userId === 'string', 'SCIM response missing user id');
  return userId;
}

async function tokenFor(port: number, externalId: string): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub: externalId });
  assert.ok(result.status >= 200 && result.status < 300, `dev-token failed: ${result.raw}`);
  const token = result.body['token'];
  assert(typeof token === 'string', 'dev-token response missing token');
  return token;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('Story 11.5 branch transfer valuation and GST documents', () => {
  const run = randomUUID().slice(0, 8);
  let server: Server;
  let port: number;

  // Sites (bare UUIDs; no site table exists) and one zone location per site.
  const siteA = randomUUID(); // GSTIN_A
  const siteB = randomUUID(); // GSTIN_B (inter-GSTIN with A, cost_plus default)
  const siteC = randomUUID(); // GSTIN_A again (intra_gstin with A)
  const siteD = randomUUID(); // NO registration
  const siteE = randomUUID(); // GSTIN_E, NO valuation config with A
  const siteF = randomUUID(); // GSTIN_F, open_market_value default with A
  const siteG = randomUUID(); // GSTIN_G, cost_plus default with A; re-registered by the D1 arm
  const siteH = randomUUID(); // GSTIN_H, like_kind_quality default with A
  const siteI = randomUUID(); // GSTIN_I, invoice_value_full_itc default with A (ITC-eligible)
  const siteJ = randomUUID(); // GSTIN_J, cost_plus with A; the close-invariant arm retires both
  const siteK = randomUUID(); // GSTIN_K over a CLOSED window, for the T18 date boundaries
  const siteM = randomUUID(); // GSTIN_M, owned outright by the close-route lifecycle arm
  const siteX = randomUUID(); // unrelated site an officer may be scoped to
  let locA: string;
  let locA2: string; // a SECOND location inside siteA, so an intra_site move can be stamped
  let locB: string;
  let locC: string;
  let locD: string;
  let locE: string;
  let locF: string;
  let locFx: string; // siteF, REFUSAL-ONLY: no arm may create a transfer here that succeeds
  let locG: string;
  let locH: string;
  let locHx: string; // siteH, REFUSAL-ONLY, same contract as locFx
  let locI: string;
  let locJ: string;
  let locK: string;

  let warehouse: { userId: string; token: string }; // warehouse_manager, inventory write '*'
  let officer: { userId: string; token: string }; // gst_officer at '*' + locA + siteA
  let officerElsewhere: { userId: string; token: string }; // gst_officer at siteX AND locA
  // Chunk-3 review T9: officerElsewhere deliberately keeps its locA grant, because the events-door
  // and edge-door arms need an identity that GENUINELY HOLDS the location it states (otherwise the
  // refusal is a vacuous LOCATION_ACCESS_DENIED and proves nothing about the site half). That same
  // grant makes it PASS `gstOfficerActor` on the REST routes, whose scope predicate matches either
  // the transfer's from LOCATION or its from SITE - so the REST wrong-site arms are driven by this
  // identity instead, which holds one unrelated site and nothing else.
  let officerOtherSiteOnly: { userId: string; token: string };
  // T12: holds siteA AND siteX, so a payload naming siteX for a siteA transfer clears BOTH doors'
  // gst_officer site gate and TRANSFER_SITE_MISMATCH is the only wall left to fire.
  let officerTwoSites: { userId: string; token: string };
  // T22: the `module` and `functionScope === 'write'` halves of the doors' officer predicate. Both
  // hold a real gst_officer assignment at siteA - one on the wrong MODULE, one at read scope - plus
  // a warehouse_manager write grant so they reach the gate rather than being turned away by
  // requireRole. Deleting either half of the predicate admits them.
  let officerWrongModule: { userId: string; token: string };
  let officerReadScope: { userId: string; token: string };
  // Code review D3: creating a transfer the configuration values on a hand-declared Rule 28 basis
  // is now a gst_officer capability, but gst_officer is NOT in the route's CREATE_ROLES. A creator
  // who may legitimately raise such a transfer therefore holds BOTH assignments. The plain
  // `warehouse` user deliberately keeps NO gst_officer assignment, because the AC2/AC3 arms prove
  // it is refused at the officer gate on both doors.
  let creatorOfficer: { userId: string; token: string };

  const SKU = `SKU-11-5-${run}`; // cost 100.000000
  const SKU_ROUND = `SKU-11-5-R-${run}`; // cost 33.333333
  let lotSku: string;
  let lotRound: string;

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../read/projections/site_gstin.sql',
      '../../read/projections/branch_transfer_classification.sql',
      '../../read/projections/branch_transfer_valuation_config.sql',
      '../../read/projections/branch_transfer_valuation.sql',
      '../../read/projections/branch_transfer_gst_document.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE branch_transfer_gst_document, branch_transfer_valuation, branch_transfer_classification, branch_transfer_valuation_config, site_gstin, in_transit, transfer_request, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, instrument_calibration_statuses, location_current, location_asserted_facts, location_expected_facts, transaction_tagging_rules, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    async function seedLocation(code: string, siteId: string): Promise<string> {
      const r = await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
         VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
        [randomUUID(), code, siteId],
      );
      return r.rows[0]!['location_id'] as string;
    }
    locA = await seedLocation(`LOC-11-5-A-${run}`, siteA);
    locA2 = await seedLocation(`LOC-11-5-A2-${run}`, siteA);
    locB = await seedLocation(`LOC-11-5-B-${run}`, siteB);
    locC = await seedLocation(`LOC-11-5-C-${run}`, siteC);
    locD = await seedLocation(`LOC-11-5-D-${run}`, siteD);
    locE = await seedLocation(`LOC-11-5-E-${run}`, siteE);
    locF = await seedLocation(`LOC-11-5-F-${run}`, siteF);
    locFx = await seedLocation(`LOC-11-5-FX-${run}`, siteF);
    locG = await seedLocation(`LOC-11-5-G-${run}`, siteG);
    locH = await seedLocation(`LOC-11-5-H-${run}`, siteH);
    locHx = await seedLocation(`LOC-11-5-HX-${run}`, siteH);
    locI = await seedLocation(`LOC-11-5-I-${run}`, siteI);
    locJ = await seedLocation(`LOC-11-5-J-${run}`, siteJ);
    locK = await seedLocation(`LOC-11-5-K-${run}`, siteK);
    await seedLocation(`LOC-11-5-M-${run}`, siteM);
    // Q10: a GSTIN can only be registered against a site some location_register row belongs to
    // (SITE_NOT_FOUND otherwise), so even the "unrelated" site the replay sub-check uses needs one.
    await seedLocation(`LOC-11-5-X-${run}`, siteX);

    const whId = `wh-11-5-${run}`;
    warehouse = {
      userId: await scimCreateUser(port, whId, 'Warehouse Manager', [
        { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: '*' },
        { role: 'warehouse_manager', module: 'inventory', functionScope: 'read', locationId: '*' },
      ]),
      token: await tokenFor(port, whId),
    };
    // The officer holds the FROM location (the route's assertWriteLocationAccess idiom) AND the
    // FROM site (the events door authorises against the payload site_id). Both scoped, no wildcard.
    // Code review E2: registering a GSTIN and configuring a pair are CENTRAL head-office acts and
    // now demand an assignment carrying BOTH the role and the wildcard location `*` with write
    // scope. The site-scoped write assignments stay, because the override and gst-documents routes
    // (Q5/Q6) take privilege and site scope from the SAME assignment and the site-bound arms below
    // depend on that.
    //
    // Chunk-3 review T11: there is deliberately NO `gst_officer read '*'` assignment here. Q19 is
    // the rule that a WRITE assignment satisfies a READ requirement (`assertGstConfigRole`, and
    // `satisfiesFunctionScope` in middleware/rbac.ts); an explicit read grant made that clause
    // deletable in silence, because every GET this officer performs would have been answered by the
    // redundant assignment instead. Every GET below now depends on the write-implies-read clause.
    const offId = `gst-11-5-${run}`;
    officer = {
      userId: await scimCreateUser(port, offId, 'GST Officer', [
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: '*' },
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: locA },
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: siteA },
      ]),
      token: await tokenFor(port, offId),
    };
    const offXId = `gst-x-11-5-${run}`;
    officerElsewhere = {
      userId: await scimCreateUser(port, offXId, 'GST Officer Elsewhere', [
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: siteX },
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: locA },
      ]),
      token: await tokenFor(port, offXId),
    };
    // D3: a creator who may raise a hand-declared-basis transfer. warehouse_manager satisfies the
    // route's CREATE_ROLES and the location scope; the gst_officer assignment at siteA is what the
    // applier's assertDeclaredBasisPermitted looks for (role AND site from the SAME assignment).
    const coId = `wh-gst-11-5-${run}`;
    creatorOfficer = {
      userId: await scimCreateUser(port, coId, 'Warehouse Manager and GST Officer', [
        {
          role: 'warehouse_manager',
          module: 'inventory',
          functionScope: 'write',
          locationId: locA,
        },
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: siteA },
        { role: 'warehouse_manager', module: 'inventory', functionScope: 'read', locationId: '*' },
      ]),
      token: await tokenFor(port, coId),
    };
    // T9: one unrelated site, no locA, no wildcard - the identity the REST site gate can refuse.
    const offOnlyXId = `gst-onlyx-11-5-${run}`;
    officerOtherSiteOnly = {
      userId: await scimCreateUser(port, offOnlyXId, 'GST Officer siteX only', [
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: siteX },
      ]),
      token: await tokenFor(port, offOnlyXId),
    };
    // T12: siteA AND siteX, so the door's site gate passes for either and the payload/transfer
    // binding is the only thing left to refuse a siteX payload against a siteA transfer.
    const offBothId = `gst-both-11-5-${run}`;
    officerTwoSites = {
      userId: await scimCreateUser(port, offBothId, 'GST Officer two sites', [
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: siteA },
        { role: 'gst_officer', module: 'inventory', functionScope: 'write', locationId: siteX },
      ]),
      token: await tokenFor(port, offBothId),
    };
    // T22: a genuine gst_officer assignment at siteA on the WRONG MODULE.
    const offModId = `gst-mod-11-5-${run}`;
    officerWrongModule = {
      userId: await scimCreateUser(port, offModId, 'GST Officer wrong module', [
        { role: 'gst_officer', module: 'quality', functionScope: 'write', locationId: siteA },
        { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: locA },
        { role: 'warehouse_manager', module: 'inventory', functionScope: 'read', locationId: '*' },
      ]),
      token: await tokenFor(port, offModId),
    };
    // T22: a genuine gst_officer assignment at siteA on inventory, but at READ scope.
    const offReadId = `gst-read-11-5-${run}`;
    officerReadScope = {
      userId: await scimCreateUser(port, offReadId, 'GST Officer read scope', [
        { role: 'gst_officer', module: 'inventory', functionScope: 'read', locationId: siteA },
        { role: 'warehouse_manager', module: 'inventory', functionScope: 'write', locationId: locA },
        { role: 'warehouse_manager', module: 'inventory', functionScope: 'read', locationId: '*' },
      ]),
      token: await tokenFor(port, offReadId),
    };

    // Items, lots, stock at the source, and the SKU-grain running-average cost.
    for (const [sku, cost] of [
      [SKU, '100.000000'],
      [SKU_ROUND, '33.333333'],
    ] as const) {
      await getPool().query(
        `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
         VALUES ($1, 'EA', true, false, 'weighted_average', 'production', 'active')`,
        [sku],
      );
      await getPool().query(
        `INSERT INTO inventory_valuation (sku, quantity_on_hand, running_average_cost, carrying_value)
         VALUES ($1, 100000, $2, 100000 * $2::numeric)`,
        [sku, cost],
      );
    }
    async function seedLot(sku: string, lotNumber: string): Promise<string> {
      const r = await getPool().query(
        `INSERT INTO lot_master (lot_id, lot_number, sku) VALUES ($1, $2, $3) RETURNING lot_id`,
        [randomUUID(), lotNumber, sku],
      );
      const lotId = r.rows[0]!['lot_id'] as string;
      await getPool().query(
        `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
         VALUES ($1, $2, $3, 'owned', 100000)`,
        [sku, locA, lotNumber],
      );
      return lotId;
    }
    lotSku = await seedLot(SKU, `LOT-11-5-${run}`);
    lotRound = await seedLot(SKU_ROUND, `LOT-11-5-R-${run}`);

    // Chunk-3 review T24: the registrations and pair configurations every arm below reads are
    // FIXTURE, so they are seeded here rather than by the first `it`. They were previously created
    // by an arm whose own subject was the refusal and replay behaviour of the two routes, which
    // made every later arm silently order-dependent on it. They are still written through the real
    // routes (the routes are the only writer for these tables), and the route behaviours that arm
    // proves stay in it.
    for (const [site, gstin] of [
      [siteA, GSTIN_A],
      [siteB, GSTIN_B],
      [siteC, GSTIN_A],
      [siteE, GSTIN_E],
      [siteF, GSTIN_F],
      [siteG, GSTIN_G],
      [siteH, GSTIN_H],
      [siteI, GSTIN_I],
      [siteJ, GSTIN_J],
    ] as const) {
      const r = await registerGstin(site, gstin);
      assert.equal(r.status, 201, r.raw);
    }
    // T18: siteK's registration is a CLOSED window, 2026-06-10 to 2026-06-20 inclusive. Every other
    // fixture window is 2020-04-01 to NULL against 2026 business dates, so nothing exercised
    // findSiteGstin's inclusive comparison at either end.
    const kReg = await makeRequest(
      port,
      'POST',
      `/api/v1/sites/${siteK}/gstin`,
      {
        idempotency_key: randomUUID(),
        gstin_ext: GSTIN_K,
        effective_from: '2026-06-10',
        effective_to: '2026-06-20',
      },
      bearer(officer.token),
    );
    assert.equal(kReg.status, 201, kReg.raw);

    for (const [to, basis, extra] of [
      [GSTIN_B, 'cost_plus', { cost_plus_percent: 110 }],
      [GSTIN_F, 'open_market_value', {}],
      [GSTIN_G, 'cost_plus', { cost_plus_percent: 110 }],
      [GSTIN_H, 'like_kind_quality', {}],
      // T26: the ONE pair configured as ITC-eligible, so AC 1's fourth Rule 28 basis has a
      // positive path at create and at override and `assertBasisEligible` is not refusal-only.
      [GSTIN_I, 'invoice_value_full_itc', { recipient_full_itc_eligible: true }],
      [GSTIN_J, 'cost_plus', { cost_plus_percent: 110 }],
      [GSTIN_K, 'cost_plus', { cost_plus_percent: 110 }],
    ] as const) {
      const r = await configurePair(GSTIN_A, to, basis, extra);
      assert.equal(r.status, 201, r.raw);
    }
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // --- helpers ---------------------------------------------------------------

  async function registerGstin(
    siteId: string,
    gstin: string,
    token = officer.token,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/sites/${siteId}/gstin`,
      { idempotency_key: randomUUID(), gstin_ext: gstin, effective_from: '2020-04-01' },
      bearer(token),
    );
  }

  async function configurePair(
    from: string,
    to: string,
    basis: string,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/gst/branch-transfer-valuation-config',
      {
        idempotency_key: randomUUID(),
        from_gstin_ext: from,
        to_gstin_ext: to,
        default_basis: basis,
        effective_from: '2020-04-01',
        ...extra,
      },
      bearer(officer.token),
    );
  }

  async function createTransfer(
    to: string,
    quantity: number,
    extra: Record<string, unknown> = {},
    sku = SKU,
    lot = lotSku,
    token?: string,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/transfer-requests',
      {
        sku_id: sku,
        from_location_id: locA,
        to_location_id: to,
        quantity,
        lot_id: lot,
        business_stream: 'production',
        ...extra,
      },
      bearer(token ?? warehouse.token),
    );
  }

  async function getTransfer(id: string): Promise<Record<string, unknown>> {
    const r = await makeRequest(
      port,
      'GET',
      `/api/v1/transfer-requests/${id}`,
      undefined,
      bearer(warehouse.token),
    );
    assert.equal(r.status, 200, r.raw);
    return r.body;
  }

  async function ship(id: string, quantity: number, lot = lotSku): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/ship`,
      { lot_id: lot, shipped_quantity: quantity },
      bearer(warehouse.token),
    );
  }

  async function recordDocument(
    id: string,
    payload: Record<string, unknown>,
    token = officer.token,
    idempotencyKey = randomUUID(),
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/gst-documents`,
      { idempotency_key: idempotencyKey, ...payload },
      bearer(token),
    );
  }

  function taxInvoice(seed: string): Record<string, unknown> {
    return {
      document_kind: 'tax_invoice',
      document_number_ext: `INV-11-5-${seed}`,
      irn_ext: irnFor(seed).toUpperCase(),
      issued_at: '2026-09-01T10:00:00Z',
    };
  }

  function ewayBill(seed: string): Record<string, unknown> {
    return {
      document_kind: 'e_way_bill',
      document_number_ext: `EWB-11-5-${seed}`,
      ewb_valid_until: '2030-01-01T00:00:00Z',
      issued_at: '2026-09-01T11:00:00Z',
    };
  }

  function doorEnvelope(
    eventType: string,
    transferId: string,
    payload: Record<string, unknown>,
    actor: { userId: string; role: string; locationId?: string },
    eventId?: string,
  ): Record<string, unknown> {
    return {
      ...(eventId ? { event_id: eventId } : {}),
      // Q18: POST /api/v1/events now REQUIRES an idempotency_key for the two branch-transfer GST
      // event types, so the door refuses the same override posted twice under two event ids exactly
      // as the REST routes do. Built once per envelope, so a replayed envelope replays its key too.
      idempotency_key: randomUUID(),
      stream_type: 'inventory',
      stream_id: transferId,
      event_type: eventType,
      payload: {
        transfer_request_id: transferId,
        site_id: siteA,
        business_stream: 'production',
        ...payload,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actor.userId, role: actor.role, location_id: actor.locationId ?? siteA },
        occurred_at: new Date().toISOString(),
      },
    };
  }

  async function valuationRow(id: string): Promise<Record<string, unknown> | null> {
    const r = await getPool().query(
      `SELECT valuation_basis, basis_source, unit_value::text AS unit_value, taxable_value::text AS taxable_value,
              from_gstin_ext, to_gstin_ext, overridden_by, override_reason_code, source_event_id
         FROM branch_transfer_valuation WHERE transfer_request_id = $1`,
      [id],
    );
    return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  // Code review D1: the class STAMPED at create. The ship gate reads this row and nothing else.
  async function classificationRow(id: string): Promise<Record<string, unknown> | null> {
    const r = await getPool().query(
      `SELECT supply_class, from_site_id, to_site_id, from_gstin_ext, to_gstin_ext,
              business_date::text AS business_date, source_event_id
         FROM branch_transfer_classification WHERE transfer_request_id = $1`,
      [id],
    );
    return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  async function auditRowsFor(
    id: string,
    errorCode = 'GST_DOCUMENTS_REQUIRED',
  ): Promise<number> {
    const r = await getPool().query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE error_code = $2 AND details->>'transfer_request_id' = $1`,
      [id, errorCode],
    );
    return r.rows[0]!['n'] as number;
  }

  /** How many transfer_request rows currently point at a destination, for delta assertions. */
  async function transferRowsTo(locationId: string): Promise<number> {
    const r = await getPool().query(
      `SELECT count(*)::int AS n FROM transfer_request WHERE to_location_id = $1`,
      [locationId],
    );
    return r.rows[0]!['n'] as number;
  }

  /** Classification stamps written for transfers pointing at a destination. */
  async function classificationRowsTo(locationId: string): Promise<number> {
    const r = await getPool().query(
      `SELECT count(*)::int AS n FROM branch_transfer_classification c
         JOIN transfer_request t ON t.transfer_request_id = c.transfer_request_id
        WHERE t.to_location_id = $1`,
      [locationId],
    );
    return r.rows[0]!['n'] as number;
  }

  /** Runs a body against a real transactional client, so an applier can be called directly. */
  async function inTransaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The persisted event row for an id, so a route's forwarded payload can be inspected. */
  async function eventRow(eventId: string): Promise<Record<string, unknown>> {
    const r = await getPool().query(
      `SELECT event_type, payload, metadata FROM domain_events WHERE event_id = $1`,
      [eventId],
    );
    assert.equal(r.rows.length, 1, `no domain_events row for ${eventId}`);
    return r.rows[0] as Record<string, unknown>;
  }

  /**
   * A `transfer_request.created` posted straight at the events door, so the arm controls
   * `metadata.occurred_at` and therefore the IST business date the classification resolves on.
   * 11:30 IST is used for the instant so the date can never straddle the IST midnight.
   */
  function createAtBusinessDate(
    to: string,
    quantity: number,
    businessDate: string,
    transferId = randomUUID(),
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: transferId,
        event_type: 'transfer_request.created',
        payload: {
          transfer_request_id: transferId,
          sku_id: SKU,
          quantity,
          from_location_id: locA,
          to_location_id: to,
          lot_id: lotSku,
          business_stream: 'production',
          status: 'pending_shipment',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: warehouse.userId, role: 'warehouse_manager', location_id: locA },
          occurred_at: `${businessDate}T06:00:00Z`,
        },
      },
      bearer(warehouse.token),
    );
  }

  /** A `transfer_ship.created` posted straight at the events door (no route pre-checks). */
  function doorShip(id: string, quantity: number, occurredAt?: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'transfer_ship.created',
        payload: {
          transfer_request_id: id,
          shipped_quantity: quantity,
          lot_id: lotSku,
          correlation_id: randomUUID(),
          business_stream: 'production',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: warehouse.userId, role: 'warehouse_manager', location_id: locA },
          occurred_at: occurredAt ?? new Date().toISOString(),
        },
      },
      bearer(warehouse.token),
    );
  }

  async function onHandAtSource(
    lotNumberSku: string,
  ): Promise<{ on_hand: number; in_transit: number }> {
    const r = await getPool().query(
      `SELECT on_hand::float AS on_hand, in_transit::float AS in_transit FROM stock_balance
        WHERE sku = $1 AND location_id = $2`,
      [lotNumberSku, locA],
    );
    return r.rows[0] as { on_hand: number; in_transit: number };
  }

  // --- Task 1 / Task 2: registration and configuration -------------------------

  it('registers site GSTINs and pair configurations through the routes; overlaps and same-key replays behave', async () => {
    // T24: the fixture registrations and configurations are seeded in `before` now, so this arm
    // owns only the route behaviours it actually asserts and no later arm depends on it running.
    // A warehouse manager is not a registration role.
    const denied = await registerGstin(siteD, GSTIN_A, warehouse.token);
    assert.equal(denied.status, 403, denied.raw);
    assert.equal(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    // An overlapping window for a registered site is refused.
    const overlap = await makeRequest(
      port,
      'POST',
      `/api/v1/sites/${siteA}/gstin`,
      { idempotency_key: randomUUID(), gstin_ext: GSTIN_B, effective_from: '2021-01-01' },
      bearer(officer.token),
    );
    assert.equal(overlap.status, 409, overlap.raw);
    assert.equal(overlap.body['error_code'], 'GSTIN_CONFIG_OVERLAP');
    // Same idempotency key replays the created row.
    const key = randomUUID();
    const first = await makeRequest(
      port,
      'POST',
      `/api/v1/sites/${siteX}/gstin`,
      { idempotency_key: key, gstin_ext: GSTIN_E, effective_from: '2020-04-01' },
      bearer(officer.token),
    );
    assert.equal(first.status, 201, first.raw);
    const replay = await makeRequest(
      port,
      'POST',
      `/api/v1/sites/${siteX}/gstin`,
      { idempotency_key: key, gstin_ext: GSTIN_E, effective_from: '2020-04-01' },
      bearer(officer.token),
    );
    assert.equal(replay.status, 200, replay.raw);
    assert.equal(replay.body['replayed'], true);
    const listed = await makeRequest(
      port,
      'GET',
      `/api/v1/sites/${siteA}/gstin`,
      undefined,
      bearer(officer.token),
    );
    assert.equal(listed.status, 200, listed.raw);
    assert.equal((listed.body['registrations'] as unknown[]).length, 1);

    // A second configuration over the same pair and window is refused.
    const dup = await configurePair(GSTIN_A, GSTIN_B, 'like_kind_quality');
    assert.equal(dup.status, 409, dup.raw);
    assert.equal(dup.body['error_code'], 'VALUATION_CONFIG_OVERLAP');
    // A second-proviso default without eligibility is refused at the route (and by CHECK).
    const badItc = await configurePair(GSTIN_B, GSTIN_A, 'invoice_value_full_itc');
    assert.equal(badItc.status, 400, badItc.raw);
    assert.equal(badItc.body['error_code'], 'INVALID_PARAMS');
    // Q19 in flight: this officer holds gst_officer at WRITE scope only, so every GET below is
    // answered by the write-implies-read clause in assertGstConfigRole and nothing else.
    const query = await makeRequest(
      port,
      'GET',
      `/api/v1/gst/branch-transfer-valuation-config?from_gstin_ext=${GSTIN_A}&to_gstin_ext=${GSTIN_B}`,
      undefined,
      bearer(officer.token),
    );
    assert.equal(query.status, 200, query.raw);
    const configs = query.body['configs'] as Array<Record<string, unknown>>;
    assert.equal(configs.length, 1);
    assert.equal(configs[0]!['default_basis'], 'cost_plus');
    assert.equal(configs[0]!['cost_plus_percent'], '110.000');
  });

  it('T19: two CONCURRENT registrations whose windows overlap settle as one 201 and one 409 GSTIN_CONFIG_OVERLAP - never a raw 500', async () => {
    // Both overlap arms above are answered by the app-side probe in insertSiteGstin, which sees a
    // committed row. This arm posts two registrations for a site that has NONE, at the same moment,
    // so both probes would miss: what stops a double registration is the per-site
    // pg_advisory_xact_lock (which serialises probe-then-insert), and behind it the gist EXCLUDE
    // constraint excl_site_gstin_window whose 23P01 mapWindowExclusionViolation turns into this
    // very 409. A double commit here is not a cosmetic defect: findSiteGstin then raises 500
    // GSTIN_CONFIG_CONFLICT on EVERY transfer touching the site, and app_user holds no DELETE grant
    // to repair it.
    const siteRace = randomUUID();
    await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active')`,
      [randomUUID(), `LOC-11-5-RACE-${run}`, siteRace],
    );
    const post = (gstin: string, from: string): Promise<HttpResult> =>
      makeRequest(
        port,
        'POST',
        `/api/v1/sites/${siteRace}/gstin`,
        { idempotency_key: randomUUID(), gstin_ext: gstin, effective_from: from },
        bearer(officer.token),
      );
    // Overlapping windows: both are open-ended, so 2021 and 2022 necessarily overlap.
    const [first, second] = await Promise.all([
      post(GSTIN_B, '2021-01-01'),
      post(GSTIN_E, '2022-01-01'),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409], `${first.raw} | ${second.raw}`);
    const loser = first.status === 409 ? first : second;
    assert.equal(loser.body['error_code'], 'GSTIN_CONFIG_OVERLAP', loser.raw);
    // Exactly one row committed, so the site still resolves to a single registration.
    const rows = await getPool().query(
      `SELECT count(*)::int AS n FROM site_gstin WHERE site_id = $1`,
      [siteRace],
    );
    assert.equal(rows.rows[0]!['n'], 1);
  });

  // --- AC 1 ------------------------------------------------------------------

  it('AC1: an inter-GSTIN transfer is classified and valued on the cost_plus default; unit_value = cost * 1.10 and the GET carries the gst block', async () => {
    const created = await createTransfer(locB, 600);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    const gst = created.body['gst'] as Record<string, unknown>;
    assert.equal(gst['supply_class'], 'inter_gstin');

    const row = await valuationRow(id);
    assert.ok(row, 'valuation row missing');
    assert.equal(row['valuation_basis'], 'cost_plus');
    assert.equal(row['basis_source'], 'config_default');
    assert.equal(row['unit_value'], '110.000000');
    assert.equal(row['taxable_value'], '66000.00');
    assert.equal(row['from_gstin_ext'], GSTIN_A);
    assert.equal(row['to_gstin_ext'], GSTIN_B);

    const fetched = await getTransfer(id);
    const block = fetched['gst'] as Record<string, unknown>;
    assert.equal(block['supply_class'], 'inter_gstin');
    const valuation = block['valuation'] as Record<string, unknown>;
    assert.equal(valuation['taxable_value'], '66000.00');
    assert.equal(valuation['basis_source'], 'config_default');
    assert.deepEqual(block['ship_blockers'], ['tax_invoice_missing', 'e_way_bill_missing']);
    assert.deepEqual(block['documents'], []);
  });

  it('AC1: taxable_value is rounded half-up to 2 dp once, at the end; unit_value keeps 6 dp', async () => {
    // 33.333333 * 1.10 = 36.6666663 -> 36.666666 (6 dp); * 7 = 256.666662 -> 256.67.
    const created = await createTransfer(locB, 7, {}, SKU_ROUND, lotRound);
    assert.equal(created.status, 201, created.raw);
    const row = await valuationRow(created.body['transfer_request_id'] as string);
    assert.equal(row?.['unit_value'], '36.666666');
    assert.equal(row?.['taxable_value'], '256.67');
  });

  it('AC1: an open_market_value default refuses a create with no declared value and values the declared one', async () => {
    // Code review D3: the hand-declared bases are now a gst_officer capability, so this arm is
    // driven by `creatorOfficer` (warehouse_manager + gst_officer). Driving it as the plain
    // warehouse manager now stops one wall earlier at 403 VALUATION_BASIS_NOT_PERMITTED and would
    // never reach the DECLARED_VALUE_REQUIRED behaviour this arm exists to pin; that 403 has its
    // own arm below.
    // T24: the refusal targets locFx, a destination NO arm ever creates a successful transfer to,
    // so the "nothing was persisted" assertion below is true because the refusal rolled back and
    // not merely because this arm happens to run before the arms that create rows at locF.
    const missing = await createTransfer(locFx, 10, {}, SKU, lotSku, creatorOfficer.token);
    assert.equal(missing.status, 400, missing.raw);
    assert.equal(missing.body['error_code'], 'DECLARED_VALUE_REQUIRED');
    // The refusal fired inside the seam: nothing was allocated or persisted (the classification
    // stamp is written in the same transaction, so it is rolled back too).
    const none = await getPool().query(`SELECT 1 FROM transfer_request WHERE to_location_id = $1`, [
      locFx,
    ]);
    assert.equal(none.rows.length, 0);
    assert.equal(await classificationRowsTo(locFx), 0);

    const declared = await createTransfer(
      locF,
      10,
      { declared_unit_value: '12.5' },
      SKU,
      lotSku,
      creatorOfficer.token,
    );
    assert.equal(declared.status, 201, declared.raw);
    const row = await valuationRow(declared.body['transfer_request_id'] as string);
    assert.equal(row?.['valuation_basis'], 'open_market_value');
    assert.equal(row?.['unit_value'], '12.500000');
    assert.equal(row?.['taxable_value'], '125.00');
    // D3: a figure the CREATOR handed us is `declared`, never `config_default`.
    assert.equal(row?.['basis_source'], 'declared');

    // Server-derived fields are refused on input, not dropped. T23: the CODE matters - a shape
    // refusal and a business refusal are otherwise indistinguishable at 400.
    const forged = await createTransfer(locB, 5, { taxable_value: '1.00' });
    assert.equal(forged.status, 400, forged.raw);
    assert.equal(forged.body['error_code'], 'INVALID_PARAMS');
    assert.match(forged.body['message'] as string, /taxable_value is server-derived/);
    const forgedBy = await createTransfer(locB, 5, { overridden_by: officer.userId });
    assert.equal(forgedBy.status, 400, forgedBy.raw);
    assert.equal(forgedBy.body['error_code'], 'INVALID_PARAMS');
    assert.match(forgedBy.body['message'] as string, /overridden_by is server-derived/);
  });

  // --- AC 5 ------------------------------------------------------------------

  it('AC5: a same-GSTIN cross-site transfer creates no valuation row and ships as before', async () => {
    const created = await createTransfer(locC, 5);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    assert.equal(await valuationRow(id), null);
    const fetched = await getTransfer(id);
    assert.equal((fetched['gst'] as Record<string, unknown>)['supply_class'], 'intra_gstin');
    const shipped = await ship(id, 5);
    assert.equal(shipped.status, 201, shipped.raw);
    assert.equal(shipped.body['status'], 'shipped');
  });

  // --- AC 6 ------------------------------------------------------------------

  it('AC6: a cross-site transfer to a site with no GSTIN registration is refused SITE_GSTIN_MISSING naming the site', async () => {
    const r = await createTransfer(locD, 5);
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body['error_code'], 'SITE_GSTIN_MISSING');
    assert.equal((r.body['details'] as Record<string, unknown>)['site_id'], siteD);
    const none = await getPool().query(`SELECT 1 FROM transfer_request WHERE to_location_id = $1`, [
      locD,
    ]);
    assert.equal(none.rows.length, 0);
    assert.equal(await classificationRowsTo(locD), 0);
  });

  it('AC6: a GSTIN pair with no valuation configuration is refused VALUATION_CONFIG_MISSING', async () => {
    const r = await createTransfer(locE, 5);
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body['error_code'], 'VALUATION_CONFIG_MISSING');
    const details = r.body['details'] as Record<string, unknown>;
    assert.equal(details['from_gstin_ext'], GSTIN_A);
    assert.equal(details['to_gstin_ext'], GSTIN_E);
  });

  // --- AC 2 ------------------------------------------------------------------

  it('AC2: the gst_officer re-values on a chosen basis; the actor is the authenticated identity; warehouse roles are 403 on BOTH doors', async () => {
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    const override = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'like_kind_quality',
        declared_unit_value: 120,
        reason_code: 'LIKE_KIND_AVAILABLE',
      },
      bearer(officer.token),
    );
    assert.equal(override.status, 200, override.raw);
    const row = await valuationRow(id);
    assert.equal(row?.['valuation_basis'], 'like_kind_quality');
    assert.equal(row?.['basis_source'], 'override');
    assert.equal(row?.['unit_value'], '120.000000');
    assert.equal(row?.['taxable_value'], '1200.00');
    assert.equal(row?.['overridden_by'], officer.userId);
    assert.equal(row?.['override_reason_code'], 'LIKE_KIND_AVAILABLE');
    assert.equal(row?.['source_event_id'], override.body['eventId']);

    // A payload overridden_by is refused, not honoured.
    const forged = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'cost_plus',
        reason_code: 'X',
        overridden_by: warehouse.userId,
      },
      bearer(officer.token),
    );
    assert.equal(forged.status, 400, forged.raw);
    // T23: the route's own server-derived-field refusal, not merely "some 400".
    assert.equal(forged.body['error_code'], 'INVALID_PARAMS');
    assert.match(forged.body['message'] as string, /overridden_by is server-derived/);

    // Route: a warehouse_manager (inventory write, wildcard) is FUNCTION_ACCESS_DENIED.
    const routeDenied = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      { idempotency_key: randomUUID(), valuation_basis: 'cost_plus', reason_code: 'X' },
      bearer(warehouse.token),
    );
    assert.equal(routeDenied.status, 403, routeDenied.raw);
    assert.equal(routeDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // Events door: the same warehouse_manager reaches the door (wildcard inventory write, so this
    // is NOT a vacuous MODULE/LOCATION denial) and is refused by the gst_officer gate specifically.
    const doorDenied = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      doorEnvelope(
        'transfer_request.valuation_overridden',
        id,
        { valuation_basis: 'cost_plus', reason_code: 'DOOR' },
        { userId: warehouse.userId, role: 'warehouse_manager' },
      ),
      bearer(warehouse.token),
    );
    assert.equal(doorDenied.status, 403, doorDenied.raw);
    assert.equal(doorDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepEqual((doorDenied.body['details'] as Record<string, unknown>)['required_roles'], [
      'gst_officer',
    ]);
    // An officer scoped to a DIFFERENT site is refused on the door by the gate's SITE half: they
    // state a location they genuinely hold (locA, so requireRole passes and this is not a vacuous
    // LOCATION_ACCESS_DENIED), but no gst_officer assignment of theirs grants the payload's site.
    const doorElsewhere = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      doorEnvelope(
        'transfer_request.valuation_overridden',
        id,
        { valuation_basis: 'cost_plus', reason_code: 'DOOR' },
        { userId: officerElsewhere.userId, role: 'gst_officer', locationId: locA },
      ),
      bearer(officerElsewhere.token),
    );
    assert.equal(doorElsewhere.status, 403, doorElsewhere.raw);
    assert.equal(doorElsewhere.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.equal((doorElsewhere.body['details'] as Record<string, unknown>)['site_id'], siteA);
    // The value is untouched by the three refusals.
    assert.equal((await valuationRow(id))?.['unit_value'], '120.000000');

    // The officer succeeds on the door too, and the actor is pinned from auth.
    const doorOk = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      doorEnvelope(
        'transfer_request.valuation_overridden',
        id,
        { valuation_basis: 'cost_plus', reason_code: 'BACK_TO_COST' },
        { userId: warehouse.userId, role: 'gst_officer' },
      ),
      bearer(officer.token),
    );
    assert.equal(doorOk.status, 201, doorOk.raw);
    const after = await valuationRow(id);
    assert.equal(after?.['valuation_basis'], 'cost_plus');
    assert.equal(after?.['unit_value'], '110.000000');
    assert.equal(after?.['overridden_by'], officer.userId);
  });

  it('AC2: invoice_value_full_itc is refused BASIS_NOT_ELIGIBLE when the pair is not ITC-eligible, and the override is VALUATION_LOCKED once a document exists', async () => {
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    const itc = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'invoice_value_full_itc',
        declared_unit_value: 99,
        reason_code: 'ITC',
      },
      bearer(officer.token),
    );
    assert.equal(itc.status, 409, itc.raw);
    assert.equal(itc.body['error_code'], 'BASIS_NOT_ELIGIBLE');

    const doc = await recordDocument(id, taxInvoice(`lock-${id}`));
    assert.equal(doc.status, 200, doc.raw);

    const locked = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'like_kind_quality',
        declared_unit_value: 1,
        reason_code: 'TOO_LATE',
      },
      bearer(officer.token),
    );
    assert.equal(locked.status, 409, locked.raw);
    assert.equal(locked.body['error_code'], 'VALUATION_LOCKED');
    assert.equal((locked.body['details'] as Record<string, unknown>)['locked_by'], 'gst_document');
    assert.equal((await valuationRow(id))?.['basis_source'], 'config_default');

    // A transfer that is not an inter-GSTIN supply cannot be overridden at all.
    const intra = await createTransfer(locC, 1);
    assert.equal(intra.status, 201, intra.raw);
    const notBranch = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${intra.body['transfer_request_id'] as string}/valuation-override`,
      { idempotency_key: randomUUID(), valuation_basis: 'cost_plus', reason_code: 'X' },
      bearer(officer.token),
    );
    assert.equal(notBranch.status, 409, notBranch.raw);
    assert.equal(notBranch.body['error_code'], 'NOT_A_BRANCH_TRANSFER');
  });

  // --- AC 4 / AC 3 -----------------------------------------------------------

  it('AC4: shipping without documents is 409 GST_DOCUMENTS_REQUIRED on BOTH doors, names every missing item, leaves an audit row for THIS transfer, and moves no stock', async () => {
    const created = await createTransfer(locB, 600);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    const before = await onHandAtSource(SKU);

    const blocked = await ship(id, 600);
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    const details = blocked.body['details'] as Record<string, unknown>;
    assert.deepEqual(details['reasons'], ['tax_invoice_missing', 'e_way_bill_missing']);
    assert.equal(details['taxable_value'], '66000.00');
    // Code review D4: do NOT "restore" this to 50000. The statutory Rs 50,000 e-way-bill threshold
    // is on the CONSIGNMENT value, which INCLUDES tax; this platform compares the TAXABLE value and
    // holds no tax rate, so the default is grossed down by the worst-case 18 percent IGST:
    // 50000 / 1.18 = 42373 (floor). The key is config.gst.ewayBillTaxableValueThresholdInr, set by
    // GST_EWAY_BILL_TAXABLE_VALUE_THRESHOLD_INR.
    assert.equal(details['threshold'], 42373);
    assert.equal(await auditRowsFor(id), 1);

    // Direct events door: the same wall, with its own audit row surviving the rollback.
    const door = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'transfer_ship.created',
        payload: {
          transfer_request_id: id,
          shipped_quantity: 600,
          lot_id: lotSku,
          correlation_id: randomUUID(),
          business_stream: 'production',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: warehouse.userId, role: 'warehouse_manager', location_id: locA },
          occurred_at: new Date().toISOString(),
        },
      },
      bearer(warehouse.token),
    );
    assert.equal(door.status, 409, door.raw);
    assert.equal(door.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.equal(await auditRowsFor(id), 2);

    const after = await onHandAtSource(SKU);
    assert.equal(after.on_hand, before.on_hand);
    assert.equal(after.in_transit, before.in_transit);
    const inTransit = await getPool().query(
      `SELECT 1 FROM in_transit WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(inTransit.rows.length, 0);
    const status = await getPool().query(
      `SELECT status FROM transfer_request WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(status.rows[0]!['status'], 'pending_shipment');
  });

  it('AC3/AC4: a tax invoice needs its IRN; above the threshold the e-way bill is still required; once both are recorded the transfer ships', async () => {
    const created = await createTransfer(locB, 600);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    const noIrn = await recordDocument(id, {
      document_kind: 'tax_invoice',
      document_number_ext: `INV-11-5-noirn-${id}`,
      issued_at: '2026-09-01T10:00:00Z',
    });
    assert.equal(noIrn.status, 400, noIrn.raw);
    // T23: a missing IRN is a typed shape refusal, not any 400 that happens along.
    assert.equal(noIrn.body['error_code'], 'INVALID_PARAMS');
    assert.match(noIrn.body['message'] as string, /irn_ext is required for a tax invoice/);
    const badIrn = await recordDocument(id, { ...taxInvoice(`bad-${id}`), irn_ext: 'not-a-hash' });
    assert.equal(badIrn.status, 400, badIrn.raw);
    assert.equal(badIrn.body['error_code'], 'INVALID_PARAMS');
    assert.match(badIrn.body['message'] as string, /64-character hexadecimal IRN/);

    const invoice = await recordDocument(id, taxInvoice(`inv-${id}`));
    assert.equal(invoice.status, 200, invoice.raw);
    assert.deepEqual(invoice.body['ship_blockers'], ['e_way_bill_missing']);
    const stored = await getPool().query(
      `SELECT irn_ext, recorded_by, site_id FROM branch_transfer_gst_document
        WHERE transfer_request_id = $1 AND document_kind = 'tax_invoice'`,
      [id],
    );
    // Lower-cased on the way in, actor pinned from auth, site bound to the FROM site.
    assert.equal(stored.rows[0]!['irn_ext'], irnFor(`inv-${id}`));
    assert.equal(stored.rows[0]!['recorded_by'], officer.userId);
    assert.equal(stored.rows[0]!['site_id'], siteA);

    const stillBlocked = await ship(id, 600);
    assert.equal(stillBlocked.status, 409, stillBlocked.raw);
    assert.equal(stillBlocked.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.deepEqual((stillBlocked.body['details'] as Record<string, unknown>)['reasons'], [
      'e_way_bill_missing',
    ]);

    const ewb = await recordDocument(id, ewayBill(`ewb-${id}`));
    assert.equal(ewb.status, 200, ewb.raw);
    assert.deepEqual(ewb.body['ship_blockers'], []);
    const fetched = await getTransfer(id);
    assert.equal(((fetched['gst'] as Record<string, unknown>)['documents'] as unknown[]).length, 2);

    const before = await onHandAtSource(SKU);
    const shipped = await ship(id, 600);
    assert.equal(shipped.status, 201, shipped.raw);
    const after = await onHandAtSource(SKU);
    assert.equal(after.on_hand, before.on_hand - 600);

    // Documents are recorded BEFORE shipment: a late recording is refused.
    const late = await recordDocument(id, {
      ...ewayBill(`late-${id}`),
      document_kind: 'e_way_bill',
    });
    assert.equal(late.status, 400, late.raw);
    // Q2: the two recording-window refusals now carry the DEDICATED code, not the generic one.
    assert.equal(late.body['error_code'], 'GST_DOCUMENT_STATE_INVALID');
  });

  it('AC3: a transfer valued at or below the threshold ships on the tax invoice alone', async () => {
    const created = await createTransfer(locB, 100); // 100 * 110 = 11000.00
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    const blocked = await ship(id, 100);
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.deepEqual((blocked.body['details'] as Record<string, unknown>)['reasons'], [
      'tax_invoice_missing',
    ]);
    const invoice = await recordDocument(id, taxInvoice(`below-${id}`));
    assert.equal(invoice.status, 200, invoice.raw);
    assert.deepEqual(invoice.body['ship_blockers'], []);
    const shipped = await ship(id, 100);
    assert.equal(shipped.status, 201, shipped.raw);
  });

  it('AC3: recording is idempotent on replay; the same number is a no-op; a DIFFERENT number for the same kind is GST_DOCUMENT_CONFLICT; a warehouse role is 403 on both doors', async () => {
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    // Route: the same idempotency key replays the SAME event (n === 1 events).
    const key = randomUUID();
    const first = await recordDocument(id, taxInvoice(`rep-${id}`), officer.token, key);
    assert.equal(first.status, 200, first.raw);
    const replay = await recordDocument(id, taxInvoice(`rep-${id}`), officer.token, key);
    assert.equal(replay.status, 200, replay.raw);
    assert.equal(replay.body['eventId'], first.body['eventId']);
    const events = await getPool().query(
      `SELECT count(*)::int AS n FROM domain_events
        WHERE stream_id = $1 AND event_type = 'transfer_request.gst_document_recorded'`,
      [id],
    );
    assert.equal(events.rows[0]!['n'], 1);

    // The same number under a fresh key is a no-op (still one row).
    const again = await recordDocument(id, taxInvoice(`rep-${id}`));
    assert.equal(again.status, 200, again.raw);
    const rows = await getPool().query(
      `SELECT count(*)::int AS n FROM branch_transfer_gst_document WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(rows.rows[0]!['n'], 1);

    // A different invoice number for the same kind is refused.
    const conflict = await recordDocument(id, taxInvoice(`other-${id}`));
    assert.equal(conflict.status, 409, conflict.raw);
    assert.equal(conflict.body['error_code'], 'GST_DOCUMENT_CONFLICT');
    assert.equal(
      (conflict.body['details'] as Record<string, unknown>)['existing_document_number_ext'],
      `INV-11-5-rep-${id}`,
    );

    // Warehouse role: 403 on the route and on the door (the door arm is not vacuous: wildcard
    // inventory write reaches the gst_officer gate itself).
    const routeDenied = await recordDocument(id, ewayBill(`wm-${id}`), warehouse.token);
    assert.equal(routeDenied.status, 403, routeDenied.raw);
    assert.equal(routeDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const doorDenied = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      doorEnvelope('transfer_request.gst_document_recorded', id, ewayBill(`wm-door-${id}`), {
        userId: warehouse.userId,
        role: 'warehouse_manager',
      }),
      bearer(warehouse.token),
    );
    assert.equal(doorDenied.status, 403, doorDenied.raw);
    assert.equal(doorDenied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    // A payload recorded_by is refused on the door.
    const forged = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      doorEnvelope(
        'transfer_request.gst_document_recorded',
        id,
        { ...ewayBill(`forge-${id}`), recorded_by: warehouse.userId },
        { userId: officer.userId, role: 'gst_officer' },
      ),
      bearer(officer.token),
    );
    assert.equal(forged.status, 400, forged.raw);
    // T23: the seam's allow-list refusal, naming the offending key.
    assert.equal(forged.body['error_code'], 'INVALID_PARAMS');
    assert.equal((forged.body['details'] as Record<string, unknown>)['field'], 'recorded_by');

    // Events door: a replay of the same event_id short-circuits (one row, stamped with that id).
    const eventId = randomUUID();
    const envelope = doorEnvelope(
      'transfer_request.gst_document_recorded',
      id,
      ewayBill(`door-${id}`),
      { userId: officer.userId, role: 'gst_officer' },
      eventId,
    );
    const doorFirst = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      envelope,
      bearer(officer.token),
    );
    assert.equal(doorFirst.status, 201, doorFirst.raw);
    const doorReplay = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      envelope,
      bearer(officer.token),
    );
    assert.ok(doorReplay.status >= 200 && doorReplay.status < 300, doorReplay.raw);
    const ewbRows = await getPool().query(
      `SELECT source_event_id, recorded_by FROM branch_transfer_gst_document
        WHERE transfer_request_id = $1 AND document_kind = 'e_way_bill'`,
      [id],
    );
    assert.equal(ewbRows.rows.length, 1);
    assert.equal(ewbRows.rows[0]!['source_event_id'], eventId);
    assert.equal(ewbRows.rows[0]!['recorded_by'], officer.userId);

    // The read route shows both documents and no blockers to an inventory reader.
    const listed = await makeRequest(
      port,
      'GET',
      `/api/v1/transfer-requests/${id}/gst-documents`,
      undefined,
      bearer(warehouse.token),
    );
    assert.equal(listed.status, 200, listed.raw);
    const block = listed.body['gst'] as Record<string, unknown>;
    assert.equal((block['documents'] as unknown[]).length, 2);
    assert.deepEqual(block['ship_blockers'], []);
  });

  // --- Code review D1: the classification is STAMPED at create and READ at the gate ------------

  it('D1: every create stamps a branch_transfer_classification row - intra_site with no GSTINs, intra_gstin with the ONE shared registration in BOTH columns, inter_gstin with the two distinct ones', async () => {
    // intra_site: locA and locA2 are both inside siteA, so no registration is resolved at all.
    const within = await createTransfer(locA2, 3);
    assert.equal(within.status, 201, within.raw);
    const withinId = within.body['transfer_request_id'] as string;
    const withinRow = await classificationRow(withinId);
    assert.ok(withinRow, 'intra_site create stamped no classification row');
    assert.equal(withinRow['supply_class'], 'intra_site');
    assert.equal(withinRow['from_site_id'], siteA);
    assert.equal(withinRow['to_site_id'], siteA);
    assert.equal(withinRow['from_gstin_ext'], null);
    assert.equal(withinRow['to_gstin_ext'], null);
    assert.ok(withinRow['source_event_id'], 'source_event_id not stamped');
    assert.equal(await valuationRow(withinId), null);

    // intra_gstin: siteA and siteC are two sites under ONE registration, written to BOTH columns.
    const shared = await createTransfer(locC, 3);
    assert.equal(shared.status, 201, shared.raw);
    const sharedId = shared.body['transfer_request_id'] as string;
    const sharedRow = await classificationRow(sharedId);
    assert.ok(sharedRow, 'intra_gstin create stamped no classification row');
    assert.equal(sharedRow['supply_class'], 'intra_gstin');
    assert.equal(sharedRow['from_site_id'], siteA);
    assert.equal(sharedRow['to_site_id'], siteC);
    assert.equal(sharedRow['from_gstin_ext'], GSTIN_A);
    assert.equal(sharedRow['to_gstin_ext'], GSTIN_A);
    assert.equal(await valuationRow(sharedId), null);

    // inter_gstin: the two distinct registrations the class was decided on.
    const across = await createTransfer(locB, 3);
    assert.equal(across.status, 201, across.raw);
    const acrossId = across.body['transfer_request_id'] as string;
    const acrossRow = await classificationRow(acrossId);
    assert.ok(acrossRow, 'inter_gstin create stamped no classification row');
    assert.equal(acrossRow['supply_class'], 'inter_gstin');
    assert.equal(acrossRow['from_site_id'], siteA);
    assert.equal(acrossRow['to_site_id'], siteB);
    assert.equal(acrossRow['from_gstin_ext'], GSTIN_A);
    assert.equal(acrossRow['to_gstin_ext'], GSTIN_B);
    // The stamp and the valuation sibling agree on the pair.
    const valued = await valuationRow(acrossId);
    assert.equal(valued?.['from_gstin_ext'], GSTIN_A);
    assert.equal(valued?.['to_gstin_ext'], GSTIN_B);
  });

  it('D1 REGRESSION: re-registering the destination site under the SOURCE GSTIN between create and ship does NOT wave an inter-GSTIN supply out of the door; the gate reads the stamp, not the current registration', async () => {
    // A genuine inter-GSTIN supply, siteA (GSTIN_A) -> siteG (GSTIN_G), valued at 66000.00.
    const created = await createTransfer(locG, 600);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    const stamp = await classificationRow(id);
    assert.equal(stamp?.['supply_class'], 'inter_gstin');
    assert.equal(stamp?.['to_gstin_ext'], GSTIN_G);
    assert.equal((await valuationRow(id))?.['taxable_value'], '66000.00');

    // Now the world changes UNDER the in-flight transfer: siteG's GSTIN_G registration is closed
    // and siteG is re-registered under GSTIN_A, so on the SHIP date siteA and siteG resolve to ONE
    // shared GSTIN. (excl_site_gstin_window forbids overlapping windows, so the old one is closed
    // first.) Nothing about the transfer itself changes.
    await getPool().query(
      `UPDATE site_gstin SET effective_to = DATE '2020-04-02' WHERE site_id = $1 AND gstin_ext = $2`,
      [siteG, GSTIN_G],
    );
    await getPool().query(
      `INSERT INTO site_gstin (site_id, gstin_ext, effective_from, created_by)
       VALUES ($1, $2, DATE '2020-04-03', $3)`,
      [siteG, GSTIN_A, officer.userId],
    );

    // Proof the flip is REAL and not merely asserted: a transfer created NOW over the same pair
    // classifies intra_gstin. That is exactly what the pre-patch ship gate re-derived for the
    // transfer above - it called classifyBranchTransfer on the SHIP date, got intra_gstin, returned
    // blocked:false, and shipped a taxable supply with no tax invoice, no IRN and no e-way bill.
    const reclassified = await createTransfer(locG, 3);
    assert.equal(reclassified.status, 201, reclassified.raw);
    const nowRow = await classificationRow(reclassified.body['transfer_request_id'] as string);
    assert.equal(nowRow?.['supply_class'], 'intra_gstin');
    assert.equal(nowRow?.['from_gstin_ext'], GSTIN_A);
    assert.equal(nowRow?.['to_gstin_ext'], GSTIN_A);

    // The in-flight transfer is STILL blocked, because the gate reads its stamp.
    const before = await onHandAtSource(SKU);
    const blocked = await ship(id, 600);
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.deepEqual((blocked.body['details'] as Record<string, unknown>)['reasons'], [
      'tax_invoice_missing',
      'e_way_bill_missing',
    ]);
    // The stamp is untouched by the registration edit.
    assert.equal((await classificationRow(id))?.['supply_class'], 'inter_gstin');
    assert.equal((await classificationRow(id))?.['to_gstin_ext'], GSTIN_G);

    // And nothing moved.
    const after = await onHandAtSource(SKU);
    assert.equal(after.on_hand, before.on_hand);
    assert.equal(after.in_transit, before.in_transit);
    const inTransit = await getPool().query(
      `SELECT 1 FROM in_transit WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(inTransit.rows.length, 0);
    const status = await getPool().query(
      `SELECT status FROM transfer_request WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(status.rows[0]!['status'], 'pending_shipment');
  });

  it('D1: a transfer with NO classification stamp is refused not_valued - the gate fails closed rather than re-deriving a class', async () => {
    // A pre-migration row: inserted straight into the read model, bypassing the create applier, so
    // no branch_transfer_classification row exists for it.
    const id = randomUUID();
    await getPool().query(
      `INSERT INTO transfer_request
         (transfer_request_id, sku_id, quantity, from_location_id, to_location_id, lot_id,
          business_stream, status, correlation_id)
       VALUES ($1, $2, 5, $3, $4, $5, 'production', 'pending_shipment', $6)`,
      [id, SKU, locA, locB, lotSku, randomUUID()],
    );
    assert.equal(await classificationRow(id), null);

    const blocked = await ship(id, 5);
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.deepEqual((blocked.body['details'] as Record<string, unknown>)['reasons'], [
      'not_valued',
    ]);
    const status = await getPool().query(
      `SELECT status FROM transfer_request WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(status.rows[0]!['status'], 'pending_shipment');
  });

  // --- Code review D2: a valued inter-GSTIN supply ships the valued quantity and nothing else ---

  it('D2: a SHORT ship of a valued inter-GSTIN transfer is 409 SHIP_QUANTITY_MISMATCH naming both quantities; the exact quantity ships; a non-inter-GSTIN transfer still short-ships', async () => {
    // Why not simply re-value: the e-invoice is ALREADY FILED with a minted IRN, so re-valuing the
    // transfer would leave our record contradicting a statutory document. The real-world path is to
    // cancel the tax invoice and re-raise it for the quantity actually moving.
    const created = await createTransfer(locB, 600);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    assert.equal(
      (await recordDocument(id, taxInvoice(`d2-inv-${id}`))).status,
      200,
      'tax invoice not recorded',
    );
    assert.equal(
      (await recordDocument(id, ewayBill(`d2-ewb-${id}`))).status,
      200,
      'ewb not recorded',
    );

    const before = await onHandAtSource(SKU);
    const short = await ship(id, 500);
    assert.equal(short.status, 409, short.raw);
    assert.equal(short.body['error_code'], 'SHIP_QUANTITY_MISMATCH');
    const details = short.body['details'] as Record<string, unknown>;
    assert.equal(details['valued_quantity'], 600);
    assert.equal(details['shipped_quantity'], 500);
    assert.equal(details['transfer_request_id'], id);
    // T21: SHIP_QUANTITY_MISMATCH calls auditRefusal exactly as GST_DOCUMENTS_REQUIRED does, and
    // the statutory refusal row has to survive the event rollback. Nothing counted it before.
    assert.equal(await auditRowsFor(id, 'SHIP_QUANTITY_MISMATCH'), 1);
    const unmoved = await onHandAtSource(SKU);
    assert.equal(unmoved.on_hand, before.on_hand);

    // The EXACT valued quantity still ships.
    const exact = await ship(id, 600);
    assert.equal(exact.status, 201, exact.raw);
    assert.equal(exact.body['status'], 'shipped');
    const after = await onHandAtSource(SKU);
    assert.equal(after.on_hand, before.on_hand - 600);

    // Story 2.5 is untouched for everything that is not a valued inter-GSTIN supply: an intra_gstin
    // transfer still ships short.
    const intra = await createTransfer(locC, 10);
    assert.equal(intra.status, 201, intra.raw);
    const intraId = intra.body['transfer_request_id'] as string;
    const partial = await ship(intraId, 4);
    assert.equal(partial.status, 201, partial.raw);
    assert.equal(partial.body['status'], 'shipped');
  });

  // --- Code review D3: the hand-declared bases are a gst_officer capability -------------------

  it('D3/E1: a non-officer who EXPLICITLY declares a unit value on an open_market_value or like_kind_quality default is 403 VALUATION_BASIS_NOT_PERMITTED on BOTH doors; a gst_officer creator succeeds', async () => {
    // Code review E1 narrowed this refusal. A non-officer who supplies NO declared_unit_value now
    // gets an UNVALUED transfer instead of a 403 (the arm below); the 403 survives only for a
    // non-officer who explicitly hands us a figure, which is what this arm drives throughout.
    // Chunk-3 review T3: the refusals target locFx / locHx - destinations NO arm ever creates a
    // surviving transfer to - so "nothing was persisted" is the strict `rows.length === 0` form the
    // sibling arms use. The previous shape selected rows for the SHARED destination, got none back,
    // and ran its per-row assertion zero times: a pass that asserted nothing at all. The successful
    // create at the end of each iteration still targets the shared locF / locH.
    for (const [to, refusalTo, gstin, basis] of [
      [locF, locFx, GSTIN_F, 'open_market_value'],
      [locH, locHx, GSTIN_H, 'like_kind_quality'],
    ] as const) {
      // Route: the plain warehouse manager reaches the applier (CREATE_ROLES and location scope
      // both pass, so this is not a vacuous FUNCTION_ACCESS_DENIED) and is stopped by the basis gate.
      const denied = await createTransfer(refusalTo, 4, { declared_unit_value: '20' });
      assert.equal(denied.status, 403, denied.raw);
      assert.equal(denied.body['error_code'], 'VALUATION_BASIS_NOT_PERMITTED');
      const deniedDetails = denied.body['details'] as Record<string, unknown>;
      assert.equal(deniedDetails['valuation_basis'], basis);
      assert.equal(deniedDetails['site_id'], siteA);
      assert.deepEqual(deniedDetails['required_roles'], ['gst_officer']);
      // Refused inside the seam: no transfer row, and no classification stamp either.
      const persisted = await getPool().query(
        `SELECT transfer_request_id FROM transfer_request WHERE to_location_id = $1`,
        [refusalTo],
      );
      assert.equal(persisted.rows.length, 0, 'the refused create was persisted');
      assert.equal(
        await classificationRowsTo(refusalTo),
        0,
        'the refused create left a classification stamp behind',
      );

      // Events door: the same wall, reached by the same identity posting the create event directly.
      const doorDenied = await makeRequest(
        port,
        'POST',
        '/api/v1/events',
        {
          stream_type: 'inventory',
          stream_id: randomUUID(),
          event_type: 'transfer_request.created',
          payload: {
            transfer_request_id: randomUUID(),
            sku_id: SKU,
            quantity: 4,
            from_location_id: locA,
            to_location_id: refusalTo,
            lot_id: lotSku,
            business_stream: 'production',
            status: 'pending_shipment',
            declared_unit_value: '20',
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: warehouse.userId, role: 'warehouse_manager', location_id: locA },
            occurred_at: new Date().toISOString(),
          },
        },
        bearer(warehouse.token),
      );
      assert.equal(doorDenied.status, 403, doorDenied.raw);
      assert.equal(doorDenied.body['error_code'], 'VALUATION_BASIS_NOT_PERMITTED');
      // The door refusal rolled back too - still nothing at the refusal-only destination.
      assert.equal(await transferRowsTo(refusalTo), 0);
      assert.equal(await classificationRowsTo(refusalTo), 0);

      // The gst_officer creator is allowed through and the row is stamped `declared`.
      const allowed = await createTransfer(
        to,
        4,
        { declared_unit_value: '20' },
        SKU,
        lotSku,
        creatorOfficer.token,
      );
      assert.equal(allowed.status, 201, allowed.raw);
      const row = await valuationRow(allowed.body['transfer_request_id'] as string);
      assert.equal(row?.['valuation_basis'], basis);
      assert.equal(row?.['basis_source'], 'declared');
      assert.equal(row?.['unit_value'], '20.000000');
      assert.equal(row?.['taxable_value'], '80.00');
      assert.equal(row?.['to_gstin_ext'], gstin);
    }
  });

  it('D3: basis_source is `declared` for a creator-supplied value and `config_default` for a cost_plus row, and only an `override` row may carry an overridden_by', async () => {
    // cost_plus derives its unit value from the running average cost: nobody declared anything.
    const derived = await createTransfer(locB, 10);
    assert.equal(derived.status, 201, derived.raw);
    const derivedId = derived.body['transfer_request_id'] as string;
    const derivedRow = await valuationRow(derivedId);
    assert.equal(derivedRow?.['valuation_basis'], 'cost_plus');
    assert.equal(derivedRow?.['basis_source'], 'config_default');
    assert.equal(derivedRow?.['overridden_by'], null);
    // And a declared_unit_value on that basis is now refused outright, not silently ignored.
    const ignored = await createTransfer(locB, 10, { declared_unit_value: '77' });
    assert.equal(ignored.status, 400, ignored.raw);
    assert.equal(ignored.body['error_code'], 'INVALID_PARAMS');

    // A creator-supplied figure is `declared`.
    const handed = await createTransfer(
      locF,
      10,
      { declared_unit_value: '12.5' },
      SKU,
      lotSku,
      creatorOfficer.token,
    );
    assert.equal(handed.status, 201, handed.raw);
    const handedId = handed.body['transfer_request_id'] as string;
    assert.equal((await valuationRow(handedId))?.['basis_source'], 'declared');

    // The DB ties basis_source to the attribution column: only `override` may name an overrider.
    // override_reason_code is supplied too, so chk_..._override_pair is satisfied and the
    // attribution CHECK is the one that has to fire.
    await assert.rejects(
      () =>
        getPool().query(
          `UPDATE branch_transfer_valuation SET overridden_by = $2, override_reason_code = 'FORGED'
            WHERE transfer_request_id = $1`,
          [handedId, officer.userId],
        ),
      /chk_branch_transfer_valuation_source_attribution/,
    );
    assert.equal((await valuationRow(handedId))?.['overridden_by'], null);

    // The same bar on a config_default row.
    await assert.rejects(
      () =>
        getPool().query(
          `UPDATE branch_transfer_valuation SET overridden_by = $2, override_reason_code = 'FORGED'
            WHERE transfer_request_id = $1`,
          [derivedId, officer.userId],
        ),
      /chk_branch_transfer_valuation_source_attribution/,
    );
  });

  // --- Code review D5: an EXPIRED e-way bill no longer satisfies the gate --------------------

  it('D5/F1: an e-way bill expired by SERVER time is e_way_bill_expired; backdating occurred_at does NOT buy passage; a bill still valid now ships', async () => {
    // An e-way bill is valid for one day per 200 km, so expiry while a truck waits at the gate is
    // routine, not exotic. ewb_valid_until was written, shape-checked once and then never compared
    // to anything, so a bill that expired two years ago satisfied the gate and the consignment
    // rolled out toward a checkpost detention.
    //
    // Ruling F1: the comparison is against SERVER TIME. The first version compared against
    // `metadata.occurred_at`, which is caller-supplied and bounded only in the future, so a shipper
    // could defeat the whole control by backdating one field - and the arm that used to live here
    // DEMONSTRATED that bypass while asserting it as correct. The boundary is therefore driven by
    // seeding `ewb_valid_until` relative to the wall clock, never by choosing `occurred_at`.
    const expiredAt = new Date(Date.now() - 60_000).toISOString(); // lapsed one minute ago
    const stillValidUntil = new Date(Date.now() + 10 * 60_000).toISOString(); // ten minutes left
    // Comfortably before the bill lapsed, and comfortably in the past so the store's upper bound
    // on occurred_at accepts it: this is the backdating a shipper would attempt.
    const backdated = new Date(Date.now() - 30 * 60_000).toISOString();

    const created = await createTransfer(locB, 600); // 66000.00, above the 42373 threshold
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    const invoice = await recordDocument(id, taxInvoice(`d5-inv-${id}`));
    assert.equal(invoice.status, 200, invoice.raw);
    const ewb = await recordDocument(id, {
      document_kind: 'e_way_bill',
      document_number_ext: `EWB-11-5-d5-${id}`,
      ewb_valid_until: expiredAt,
      issued_at: '2026-09-01T11:00:00Z',
    });
    assert.equal(ewb.status, 200, ewb.raw);
    // The bill IS recorded, so this arm can only fail on expiry - never on absence.
    const stored = await getPool().query(
      `SELECT ewb_valid_until FROM branch_transfer_gst_document
        WHERE transfer_request_id = $1 AND document_kind = 'e_way_bill'`,
      [id],
    );
    assert.equal(stored.rows.length, 1);

    // The REST route evaluates against the server clock.
    const before = await onHandAtSource(SKU);
    const blocked = await ship(id, 600);
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    const reasons = (blocked.body['details'] as Record<string, unknown>)['reasons'] as string[];
    assert.deepEqual(reasons, ['e_way_bill_expired']);
    assert.ok(!reasons.includes('e_way_bill_missing'), 'expired must not be reported as missing');
    const unmoved = await onHandAtSource(SKU);
    assert.equal(unmoved.on_hand, before.on_hand);
    assert.equal(unmoved.in_transit, before.in_transit);
    assert.equal(
      (
        await getPool().query(
          `SELECT status FROM transfer_request WHERE transfer_request_id = $1`,
          [id],
        )
      ).rows[0]!['status'],
      'pending_shipment',
    );

    // THE BYPASS, CLOSED: the same ship posted at the events door with an `occurred_at` from BEFORE
    // the bill lapsed is still refused. Under the old occurred_at comparison this returned 201 and
    // moved 600 units on a dead e-way bill.
    const backdatedShip = await doorShip(id, 600, backdated);
    assert.equal(backdatedShip.status, 409, backdatedShip.raw);
    assert.equal(backdatedShip.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.deepEqual((backdatedShip.body['details'] as Record<string, unknown>)['reasons'], [
      'e_way_bill_expired',
    ]);
    assert.equal((await onHandAtSource(SKU)).on_hand, before.on_hand);
    assert.equal(
      (
        await getPool().query(
          `SELECT status FROM transfer_request WHERE transfer_request_id = $1`,
          [id],
        )
      ).rows[0]!['status'],
      'pending_shipment',
    );

    // A SECOND consignment, identical but for a bill that has not yet lapsed, ships - so the arm
    // above fails on expiry and not on some unrelated wall the whole path would hit anyway.
    const live = await createTransfer(locB, 600);
    assert.equal(live.status, 201, live.raw);
    const liveId = live.body['transfer_request_id'] as string;
    assert.equal((await recordDocument(liveId, taxInvoice(`d5-live-${liveId}`))).status, 200);
    const liveEwb = await recordDocument(liveId, {
      document_kind: 'e_way_bill',
      document_number_ext: `EWB-11-5-live-${liveId}`,
      ewb_valid_until: stillValidUntil,
      issued_at: '2026-09-01T11:00:00Z',
    });
    assert.equal(liveEwb.status, 200, liveEwb.raw);
    assert.deepEqual(liveEwb.body['ship_blockers'], []);
    const beforeLive = await onHandAtSource(SKU);
    const shipped = await ship(liveId, 600);
    assert.equal(shipped.status, 201, shipped.raw);
    assert.equal(shipped.body['status'], 'shipped');
    assert.equal((await onHandAtSource(SKU)).on_hand, beforeLive.on_hand - 600);
  });

  // --- Code review E1: created UNVALUED, then valued by the officer through the same door -----

  it('E1: a non-officer creating on a hand-declared basis with NO declared value gets an UNVALUED inter-GSTIN transfer that the ship gate blocks not_valued; the officer then values it through the override route and it ships', async () => {
    // The old behaviour refused the CREATE outright, which made both hand-declared bases unusable
    // by anyone but an officer - the ordinary creator could not even raise the transfer. Now the
    // transfer is created with its classification stamp and NO valuation row, the ship gate holds
    // it on `not_valued`, and the officer supplies the Rule 28 figure afterwards.
    const created = await createTransfer(locF, 8); // open_market_value default, no declared value
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    // Q16: the create response now carries a concrete stamped class, not an absent key.
    assert.equal((created.body['gst'] as Record<string, unknown>)['supply_class'], 'inter_gstin');

    // Stamped, but deliberately unvalued.
    const stamp = await classificationRow(id);
    assert.equal(stamp?.['supply_class'], 'inter_gstin');
    assert.equal(stamp?.['to_gstin_ext'], GSTIN_F);
    assert.equal(await valuationRow(id), null);

    // Q3/Q20: the GET reports the stamp and the gate's verbatim blockers.
    const beforeBlock = (await getTransfer(id))['gst'] as Record<string, unknown>;
    assert.equal(beforeBlock['supply_class'], 'inter_gstin');
    assert.equal(beforeBlock['classification_stamped'], true);
    assert.equal(beforeBlock['valuation'], null);
    assert.deepEqual(beforeBlock['ship_blockers'], ['not_valued']);

    // The ship gate holds it: unvalued is not shippable, so nothing leaks out while it waits.
    const held = await ship(id, 8);
    assert.equal(held.status, 409, held.raw);
    assert.equal(held.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.deepEqual((held.body['details'] as Record<string, unknown>)['reasons'], ['not_valued']);

    // The officer's FIRST valuation rides the existing override route, which INSERTS here.
    const firstValuation = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'open_market_value',
        declared_unit_value: 15,
        reason_code: 'OMV_ESTABLISHED',
      },
      bearer(officer.token),
    );
    assert.equal(firstValuation.status, 200, firstValuation.raw);
    const row = await valuationRow(id);
    assert.ok(row, 'the first valuation inserted no row');
    assert.equal(row['valuation_basis'], 'open_market_value');
    // A human-supplied figure is `declared`, never `override`: basis_source describes how the value
    // was DERIVED, not which door wrote it. The table's CHECK then requires overridden_by to be NULL,
    // so the officer's identity lives only on source_event_id.
    assert.equal(row['basis_source'], 'declared');
    assert.equal(row['unit_value'], '15.000000');
    assert.equal(row['taxable_value'], '120.00');
    assert.equal(row['overridden_by'], null);
    assert.equal(row['override_reason_code'], null);
    assert.equal(row['source_event_id'], firstValuation.body['eventId']);
    assert.equal(row['from_gstin_ext'], GSTIN_A);
    assert.equal(row['to_gstin_ext'], GSTIN_F);

    // Valued at 120.00, below the 42373 threshold, so the tax invoice alone clears the gate.
    const invoice = await recordDocument(id, taxInvoice(`e1-${id}`));
    assert.equal(invoice.status, 200, invoice.raw);
    assert.deepEqual(invoice.body['ship_blockers'], []);
    const before = await onHandAtSource(SKU);
    const shipped = await ship(id, 8);
    assert.equal(shipped.status, 201, shipped.raw);
    assert.equal(shipped.body['status'], 'shipped');
    assert.equal((await onHandAtSource(SKU)).on_hand, before.on_hand - 8);
  });

  it('E1: the first-valuation door is opened ONLY for an unvalued inter_gstin stamp - intra_site, intra_gstin and unstamped transfers are still NOT_A_BRANCH_TRANSFER', async () => {
    async function overrideAttempt(id: string): Promise<HttpResult> {
      return makeRequest(
        port,
        'POST',
        `/api/v1/transfer-requests/${id}/valuation-override`,
        {
          idempotency_key: randomUUID(),
          valuation_basis: 'open_market_value',
          declared_unit_value: 5,
          reason_code: 'SHOULD_NOT_APPLY',
        },
        bearer(officer.token),
      );
    }

    // intra_site: stamped, but never a supply at all.
    const within = await createTransfer(locA2, 2);
    assert.equal(within.status, 201, within.raw);
    const withinId = within.body['transfer_request_id'] as string;
    assert.equal((await classificationRow(withinId))?.['supply_class'], 'intra_site');
    const withinRefused = await overrideAttempt(withinId);
    assert.equal(withinRefused.status, 409, withinRefused.raw);
    assert.equal(withinRefused.body['error_code'], 'NOT_A_BRANCH_TRANSFER');
    assert.equal(await valuationRow(withinId), null);

    // intra_gstin: cross-site, but one registration, so no Rule 28 valuation exists to make.
    const shared = await createTransfer(locC, 2);
    assert.equal(shared.status, 201, shared.raw);
    const sharedId = shared.body['transfer_request_id'] as string;
    assert.equal((await classificationRow(sharedId))?.['supply_class'], 'intra_gstin');
    const sharedRefused = await overrideAttempt(sharedId);
    assert.equal(sharedRefused.status, 409, sharedRefused.raw);
    assert.equal(sharedRefused.body['error_code'], 'NOT_A_BRANCH_TRANSFER');
    assert.equal(await valuationRow(sharedId), null);

    // Unstamped: E1 relaxed NOT_A_BRANCH_TRANSFER for an inter_gstin STAMP, never for the absence
    // of one, so a pre-migration row cannot be valued into existence through this door either.
    const legacyId = randomUUID();
    await getPool().query(
      `INSERT INTO transfer_request
         (transfer_request_id, sku_id, quantity, from_location_id, to_location_id, lot_id,
          business_stream, status, correlation_id)
       VALUES ($1, $2, 2, $3, $4, $5, 'production', 'pending_shipment', $6)`,
      [legacyId, SKU, locA, locB, lotSku, randomUUID()],
    );
    assert.equal(await classificationRow(legacyId), null);
    const legacyRefused = await overrideAttempt(legacyId);
    assert.equal(legacyRefused.status, 409, legacyRefused.raw);
    assert.equal(legacyRefused.body['error_code'], 'NOT_A_BRANCH_TRANSFER');
    assert.equal(await valuationRow(legacyId), null);

    // Q3/Q20: and the GET describes it honestly rather than looking clean - unclassified, not
    // stamped, blocked not_valued, with the re-derived class offered only as advisory.
    const block = (await getTransfer(legacyId))['gst'] as Record<string, unknown>;
    assert.equal(block['supply_class'], 'unclassified');
    assert.equal(block['classification_stamped'], false);
    assert.deepEqual(block['ship_blockers'], ['not_valued']);
    assert.equal(block['derived_supply_class'], 'inter_gstin');
  });

  // --- Code review Q1: the edge door is a real twin of the events door ------------------------

  it('Q1: the edge door refuses a gst_officer scoped to site A when the payload names a transfer at another site, and admits the officer who holds it', async () => {
    // Before the patch the edge door checked the ROLE alone, so an officer assigned at one site
    // could sync an override for any other site's transfer. It now checks module, write scope, the
    // role AND the payload site_id against the SAME assignment - the events door's predicate.
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    function edgeOverride(
      transferId: string,
      siteId: string,
      actor: { userId: string; token: string },
    ): Promise<HttpResult> {
      return makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          event_id: randomUUID(),
          idempotency_key: randomUUID(),
          stream_type: 'inventory',
          stream_id: transferId,
          event_type: 'transfer_request.valuation_overridden',
          payload: {
            transfer_request_id: transferId,
            site_id: siteId,
            business_stream: 'production',
            valuation_basis: 'like_kind_quality',
            declared_unit_value: 130,
            reason_code: 'EDGE_SYNC',
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: actor.userId, role: 'gst_officer', location_id: locA },
            occurred_at: new Date().toISOString(),
            device_id: `edge-11-5-${run}`,
          },
        },
        bearer(actor.token),
      );
    }

    // officerElsewhere is a gst_officer, but only at siteX. The role half of the gate therefore
    // PASSES (this is not a vacuous role denial); the site half is what refuses.
    const denied = await edgeOverride(id, siteA, officerElsewhere);
    assert.equal(denied.status, 403, denied.raw);
    assert.equal(denied.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const details = denied.body['details'] as Record<string, unknown>;
    assert.equal(details['site_id'], siteA);
    assert.deepEqual(details['required_roles'], ['gst_officer']);
    // Nothing was applied.
    assert.equal((await valuationRow(id))?.['valuation_basis'], 'cost_plus');
    assert.equal((await valuationRow(id))?.['basis_source'], 'config_default');

    // The officer who genuinely holds siteA is admitted and the override lands.
    const allowed = await edgeOverride(id, siteA, officer);
    assert.ok(allowed.status >= 200 && allowed.status < 300, allowed.raw);
    const row = await valuationRow(id);
    assert.equal(row?.['valuation_basis'], 'like_kind_quality');
    assert.equal(row?.['unit_value'], '130.000000');
    assert.equal(row?.['overridden_by'], officer.userId);
  });

  // --- Code review E3: the LIST route carries supply_class ONLY ------------------------------

  it('E3: GET /transfer-requests carries a top-level supply_class per row and no gst block; an unstamped row reports unclassified', async () => {
    // The LIST route used to await the whole gst block per row - 3-5 more queries each. No consumer
    // read a taxable value or a document list from a list response, so the block is gone from here
    // and only supply_class survives, resolved for the whole page in ONE query. The full block
    // stays on GET /:id, which the AC1 and E1 arms pin.
    const across = await createTransfer(locB, 2);
    assert.equal(across.status, 201, across.raw);
    const acrossId = across.body['transfer_request_id'] as string;
    const within = await createTransfer(locA2, 2);
    assert.equal(within.status, 201, within.raw);
    const withinId = within.body['transfer_request_id'] as string;
    const legacyId = randomUUID();
    await getPool().query(
      `INSERT INTO transfer_request
         (transfer_request_id, sku_id, quantity, from_location_id, to_location_id, lot_id,
          business_stream, status, correlation_id)
       VALUES ($1, $2, 2, $3, $4, $5, 'production', 'pending_shipment', $6)`,
      [legacyId, SKU, locA, locB, lotSku, randomUUID()],
    );

    const listed = await makeRequest(
      port,
      'GET',
      '/api/v1/transfer-requests',
      undefined,
      bearer(warehouse.token),
    );
    assert.equal(listed.status, 200, listed.raw);
    const rows = JSON.parse(listed.raw) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(rows), 'the list route no longer returns an array');
    function rowFor(id: string): Record<string, unknown> {
      const found = rows.find((r) => (r['transfer_request_id'] as string) === id);
      assert.ok(found, `transfer ${id} missing from the list page`);
      return found;
    }
    assert.equal(rowFor(acrossId)['supply_class'], 'inter_gstin');
    assert.equal(rowFor(withinId)['supply_class'], 'intra_site');
    // Never a re-derivation: no stamp means unclassified, full stop.
    assert.equal(rowFor(legacyId)['supply_class'], 'unclassified');
    // The heavyweight block is gone from every row on the page.
    for (const row of rows) {
      assert.equal(row['gst'], undefined, 'the gst block is still on the list route');
    }
  });

  // --- Code review E2: the central configuration routes and their close windows ---------------

  it('E2: registration and configuration are CENTRAL acts - a site-scoped officer is refused, an unknown site is SITE_NOT_FOUND, and a reused key with a different body is IDEMPOTENCY_KEY_REUSED', async () => {
    // Privilege AND the wildcard scope come from the SAME assignment. officerElsewhere holds
    // gst_officer write at siteX and locA but no `*`, so the role half passes and the scope half
    // refuses - this is not a vacuous role denial.
    const siteScoped = await registerGstin(siteD, GSTIN_G, officerElsewhere.token);
    assert.equal(siteScoped.status, 403, siteScoped.raw);
    assert.equal(siteScoped.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.equal(
      (siteScoped.body['details'] as Record<string, unknown>)['required_location_scope'],
      '*',
    );
    const configScoped = await makeRequest(
      port,
      'POST',
      '/api/v1/gst/branch-transfer-valuation-config',
      {
        idempotency_key: randomUUID(),
        from_gstin_ext: GSTIN_G,
        to_gstin_ext: GSTIN_H,
        default_basis: 'cost_plus',
        cost_plus_percent: 105,
        effective_from: '2020-04-01',
      },
      bearer(officerElsewhere.token),
    );
    assert.equal(configScoped.status, 403, configScoped.raw);
    assert.equal(configScoped.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // Q10: site_gstin.site_id has no FK, so a typo'd site used to create a permanently orphaned
    // registration while the intended site kept failing SITE_GSTIN_MISSING with nothing to explain it.
    const unknownSite = await registerGstin(randomUUID(), GSTIN_G);
    assert.equal(unknownSite.status, 400, unknownSite.raw);
    assert.equal(unknownSite.body['error_code'], 'SITE_NOT_FOUND');

    // Q7: one key must not create two different things. The replay compares a canonical hash of the
    // body, so the same key with a DIFFERENT body is refused rather than answered with the old row.
    const key = randomUUID();
    const firstConfig = await makeRequest(
      port,
      'POST',
      '/api/v1/gst/branch-transfer-valuation-config',
      {
        idempotency_key: key,
        from_gstin_ext: GSTIN_G,
        to_gstin_ext: GSTIN_H,
        default_basis: 'cost_plus',
        cost_plus_percent: 105,
        effective_from: '2020-04-01',
      },
      bearer(officer.token),
    );
    assert.equal(firstConfig.status, 201, firstConfig.raw);
    const reused = await makeRequest(
      port,
      'POST',
      '/api/v1/gst/branch-transfer-valuation-config',
      {
        idempotency_key: key,
        from_gstin_ext: GSTIN_H,
        to_gstin_ext: GSTIN_G,
        default_basis: 'cost_plus',
        cost_plus_percent: 999,
        effective_from: '2020-04-01',
      },
      bearer(officer.token),
    );
    assert.equal(reused.status, 409, reused.raw);
    assert.equal(reused.body['error_code'], 'IDEMPOTENCY_KEY_REUSED');
  });

  it('E2: the close routes stamp effective_to on an OPEN window only - a date before effective_from is 400, an unknown id 404, an already-closed window 409', async () => {
    // Without these routes a typo'd registration is permanent: the gist EXCLUDE constraint refuses
    // any overlapping correction and nothing can retire the bad window.
    //
    // T24: this arm registers the window it closes, on a site it owns outright (siteM). It used to
    // close the registration another arm had created for siteX and asserted `length === 1` only
    // because it happened to run after that arm and before anything else touched the site.
    const created = await registerGstin(siteM, GSTIN_M);
    assert.equal(created.status, 201, created.raw);
    const listed = await makeRequest(
      port,
      'GET',
      `/api/v1/sites/${siteM}/gstin`,
      undefined,
      bearer(officer.token),
    );
    assert.equal(listed.status, 200, listed.raw);
    const registrations = listed.body['registrations'] as Array<Record<string, unknown>>;
    assert.equal(registrations.length, 1);
    const registrationId = registrations[0]!['registration_id'] as string;
    assert.equal(registrations[0]!['effective_to'], null);

    function closeRegistration(id: string, effectiveTo: string, token = officer.token) {
      return makeRequest(
        port,
        'POST',
        `/api/v1/sites/${siteM}/gstin/${id}/close`,
        { idempotency_key: randomUUID(), effective_to: effectiveTo },
        bearer(token),
      );
    }

    // A close date before the window's own start would invert it.
    const inverted = await closeRegistration(registrationId, '2019-01-01');
    assert.equal(inverted.status, 400, inverted.raw);
    assert.equal(inverted.body['error_code'], 'INVALID_PARAMS');
    // An id that names no registration.
    const missing = await closeRegistration(randomUUID(), '2024-03-31');
    assert.equal(missing.status, 404, missing.raw);
    assert.equal(missing.body['error_code'], 'GSTIN_REGISTRATION_NOT_FOUND');
    // Central act: a site-scoped officer cannot close either. T23: the CODE and the discriminator,
    // so a role denial and a scope denial cannot satisfy each other.
    const scoped = await closeRegistration(registrationId, '2024-03-31', officerElsewhere.token);
    assert.equal(scoped.status, 403, scoped.raw);
    assert.equal(scoped.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.equal(
      (scoped.body['details'] as Record<string, unknown>)['required_location_scope'],
      '*',
    );

    const closed = await closeRegistration(registrationId, '2024-03-31');
    assert.equal(closed.status, 200, closed.raw);
    assert.equal(
      (closed.body['registration'] as Record<string, unknown>)['effective_to'],
      '2024-03-31',
    );
    // A closed window is corrected by registering the next one, never by moving the old boundary.
    const again = await closeRegistration(registrationId, '2025-03-31');
    assert.equal(again.status, 409, again.raw);
    assert.equal(again.body['error_code'], 'GSTIN_REGISTRATION_ALREADY_CLOSED');

    // The same lifecycle on a pair configuration, over a pair this arm creates for itself.
    const madeConfig = await configurePair(GSTIN_M, GSTIN_H, 'cost_plus', {
      cost_plus_percent: 105,
    });
    assert.equal(madeConfig.status, 201, madeConfig.raw);
    const configId = (madeConfig.body['config'] as Record<string, unknown>)['config_id'] as string;

    function closeConfig(id: string, effectiveTo: string, token = officer.token) {
      return makeRequest(
        port,
        'POST',
        `/api/v1/gst/branch-transfer-valuation-config/${id}/close`,
        { idempotency_key: randomUUID(), effective_to: effectiveTo },
        bearer(token),
      );
    }
    const configMissing = await closeConfig(randomUUID(), '2024-03-31');
    assert.equal(configMissing.status, 404, configMissing.raw);
    assert.equal(configMissing.body['error_code'], 'VALUATION_CONFIG_NOT_FOUND');
    // T33: the two arms the registration close route has and this one did not - an inverted window
    // and the central-act scope gate. Without them the config close route could lose either check
    // in silence while its twin stayed green.
    const configInverted = await closeConfig(configId, '2019-01-01');
    assert.equal(configInverted.status, 400, configInverted.raw);
    assert.equal(configInverted.body['error_code'], 'INVALID_PARAMS');
    assert.equal(
      (configInverted.body['details'] as Record<string, unknown>)['config_id'],
      configId,
    );
    const configScopedClose = await closeConfig(configId, '2024-03-31', officerElsewhere.token);
    assert.equal(configScopedClose.status, 403, configScopedClose.raw);
    assert.equal(configScopedClose.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.equal(
      (configScopedClose.body['details'] as Record<string, unknown>)['required_location_scope'],
      '*',
    );
    const configClosed = await closeConfig(configId, '2024-03-31');
    assert.equal(configClosed.status, 200, configClosed.raw);
    assert.equal(
      (configClosed.body['config'] as Record<string, unknown>)['effective_to'],
      '2024-03-31',
    );
    const configAgain = await closeConfig(configId, '2025-03-31');
    assert.equal(configAgain.status, 409, configAgain.raw);
    assert.equal(configAgain.body['error_code'], 'VALUATION_CONFIG_ALREADY_CLOSED');
  });

  it('T33: closing a window is not cosmetic - a closed CONFIG stops a pair valuing, and a closed REGISTRATION stops a site resolving, for a transfer created afterwards', async () => {
    // Neither close route proved its own invariant: both arms above assert the stamped
    // `effective_to` and stop there, so a close that wrote the column but left the window
    // resolving - or a resolver that ignored effective_to - would pass every one of them.
    // siteJ exists for this arm alone; no other arm creates a transfer to locJ.
    const workingNow = await createTransfer(locJ, 4);
    assert.equal(workingNow.status, 201, workingNow.raw);
    assert.equal(
      (workingNow.body['gst'] as Record<string, unknown>)['supply_class'],
      'inter_gstin',
    );

    // 1. Close the A -> J valuation configuration on a date already past.
    const configs = await makeRequest(
      port,
      'GET',
      `/api/v1/gst/branch-transfer-valuation-config?from_gstin_ext=${GSTIN_A}&to_gstin_ext=${GSTIN_J}`,
      undefined,
      bearer(officer.token),
    );
    assert.equal(configs.status, 200, configs.raw);
    const rows = configs.body['configs'] as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const closedConfig = await makeRequest(
      port,
      'POST',
      `/api/v1/gst/branch-transfer-valuation-config/${rows[0]!['config_id'] as string}/close`,
      { idempotency_key: randomUUID(), effective_to: '2024-03-31' },
      bearer(officer.token),
    );
    assert.equal(closedConfig.status, 200, closedConfig.raw);
    // The pair no longer values, so a fresh transfer fails CLOSED.
    const unconfigured = await createTransfer(locJ, 4);
    assert.equal(unconfigured.status, 409, unconfigured.raw);
    assert.equal(unconfigured.body['error_code'], 'VALUATION_CONFIG_MISSING');
    assert.equal(
      (unconfigured.body['details'] as Record<string, unknown>)['to_gstin_ext'],
      GSTIN_J,
    );

    // 2. Close siteJ's registration on a date already past.
    const jRegs = await makeRequest(
      port,
      'GET',
      `/api/v1/sites/${siteJ}/gstin`,
      undefined,
      bearer(officer.token),
    );
    assert.equal(jRegs.status, 200, jRegs.raw);
    const jList = jRegs.body['registrations'] as Array<Record<string, unknown>>;
    assert.equal(jList.length, 1);
    const closedReg = await makeRequest(
      port,
      'POST',
      `/api/v1/sites/${siteJ}/gstin/${jList[0]!['registration_id'] as string}/close`,
      { idempotency_key: randomUUID(), effective_to: '2024-03-31' },
      bearer(officer.token),
    );
    assert.equal(closedReg.status, 200, closedReg.raw);
    // siteJ no longer resolves at all, so the classification itself fails closed.
    const unregistered = await createTransfer(locJ, 4);
    assert.equal(unregistered.status, 409, unregistered.raw);
    assert.equal(unregistered.body['error_code'], 'SITE_GSTIN_MISSING');
    assert.equal((unregistered.body['details'] as Record<string, unknown>)['site_id'], siteJ);
  });

  // --- Code review Q14 / Q15 / Q18 / Q21: input that used to be dropped is now typed ----------

  it('Q14/Q15/Q18/Q21: an irn on an e-way bill, an over-long reason_code or document number, a blank cost_centre and a door post with no idempotency_key are all typed 400s', async () => {
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    // Q14: an IRN belongs to a tax invoice. Silently dropping it let a caller believe an e-way bill
    // carried one.
    const irnOnEwb = await recordDocument(id, {
      ...ewayBill(`q14-${id}`),
      irn_ext: irnFor(`q14-${id}`).toUpperCase(),
    });
    assert.equal(irnOnEwb.status, 400, irnOnEwb.raw);
    assert.equal(irnOnEwb.body['error_code'], 'INVALID_PARAMS');
    const ackOnEwb = await recordDocument(id, {
      ...ewayBill(`q14b-${id}`),
      irp_acknowledged_at: '2026-09-01T11:00:00Z',
    });
    assert.equal(ackOnEwb.status, 400, ackOnEwb.raw);
    assert.equal(ackOnEwb.body['error_code'], 'INVALID_PARAMS');
    assert.match(ackOnEwb.body['message'] as string, /applies to a tax_invoice only/);

    // Q21: the free-text fields are capped, so an unbounded string cannot reach the column.
    const longNumber = await recordDocument(id, {
      ...taxInvoice(`q21-${id}`),
      document_number_ext: 'X'.repeat(65),
    });
    assert.equal(longNumber.status, 400, longNumber.raw);
    assert.equal(longNumber.body['error_code'], 'INVALID_PARAMS');

    function override(body: Record<string, unknown>) {
      return makeRequest(
        port,
        'POST',
        `/api/v1/transfer-requests/${id}/valuation-override`,
        {
          idempotency_key: randomUUID(),
          valuation_basis: 'like_kind_quality',
          declared_unit_value: 120,
          reason_code: 'OK',
          ...body,
        },
        bearer(officer.token),
      );
    }
    const longReason = await override({ reason_code: 'R'.repeat(201) });
    assert.equal(longReason.status, 400, longReason.raw);
    assert.equal(longReason.body['error_code'], 'INVALID_PARAMS');

    // Q15: cost_centre and project_code are now forwarded rather than dropped, so a blank or
    // non-string value is a typed refusal instead of silently vanishing.
    const blankCostCentre = await override({ cost_centre: '   ' });
    assert.equal(blankCostCentre.status, 400, blankCostCentre.raw);
    assert.equal(blankCostCentre.body['error_code'], 'INVALID_PARAMS');
    const numericProject = await override({ project_code: 42 });
    assert.equal(numericProject.status, 400, numericProject.raw);
    assert.equal(numericProject.body['error_code'], 'INVALID_PARAMS');
    // A well-formed pair is accepted - and T29: FORWARDED, not merely accepted. Nothing asserted
    // that the two tag fields reached the persisted event, so deleting the spread in
    // `optionalTagFields` stayed green while the tags silently vanished.
    const tagged = await override({ cost_centre: 'CC-11-5', project_code: 'PRJ-11-5' });
    assert.equal(tagged.status, 200, tagged.raw);
    const persisted = await eventRow(tagged.body['eventId'] as string);
    const persistedPayload = persisted['payload'] as Record<string, unknown>;
    assert.equal(persistedPayload['cost_centre'], 'CC-11-5');
    assert.equal(persistedPayload['project_code'], 'PRJ-11-5');

    // Q18: the events door now demands the same idempotency_key the REST routes do, so the same
    // override posted twice under two event ids can no longer apply twice.
    const noKey = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: id,
        event_type: 'transfer_request.gst_document_recorded',
        payload: {
          transfer_request_id: id,
          site_id: siteA,
          business_stream: 'production',
          ...ewayBill(`q18-${id}`),
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: officer.userId, role: 'gst_officer', location_id: siteA },
          occurred_at: new Date().toISOString(),
        },
      },
      bearer(officer.token),
    );
    assert.equal(noKey.status, 400, noKey.raw);
    assert.equal(noKey.body['error_code'], 'INVALID_PARAMS');
    assert.equal((noKey.body['details'] as Record<string, unknown>)['field'], 'idempotency_key');
  });

  // --- Chunk-3 review: arms added for behaviours that had no coverage at all ------------------

  it('T4: the e-way-bill threshold is exercised AT the boundary - exactly 42373.00 ships on the invoice alone, 42373.01 does not', async () => {
    // The "at or below" arm above is valued at 11,000 against a threshold of 42,373, so flipping
    // the gate's `>` to `>=` (or moving the threshold by any amount under 31,373) left every arm
    // green. These two consignments sit one paisa apart across the line.
    async function valuedAt(unitValue: string): Promise<string> {
      const created = await createTransfer(
        locF, // open_market_value default, so the arm can name the taxable value exactly
        1,
        { declared_unit_value: unitValue },
        SKU,
        lotSku,
        creatorOfficer.token,
      );
      assert.equal(created.status, 201, created.raw);
      const id = created.body['transfer_request_id'] as string;
      assert.equal((await valuationRow(id))?.['taxable_value'], unitValue);
      return id;
    }

    // EXACTLY the threshold: `monToNum(taxable) > threshold` is false, so no e-way bill is due.
    const atThreshold = await valuedAt('42373.00');
    const blockedAt = await ship(atThreshold, 1);
    assert.equal(blockedAt.status, 409, blockedAt.raw);
    assert.equal(blockedAt.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    const atDetails = blockedAt.body['details'] as Record<string, unknown>;
    assert.equal(atDetails['threshold'], 42373);
    assert.equal(atDetails['taxable_value'], '42373.00');
    assert.deepEqual(atDetails['reasons'], ['tax_invoice_missing']);
    const atInvoice = await recordDocument(atThreshold, taxInvoice(`t4-at-${atThreshold}`));
    assert.equal(atInvoice.status, 200, atInvoice.raw);
    assert.deepEqual(atInvoice.body['ship_blockers'], []);
    const atShipped = await ship(atThreshold, 1);
    assert.equal(atShipped.status, 201, atShipped.raw);

    // ONE PAISA above: the e-way bill is due and the invoice alone no longer clears the gate.
    const overThreshold = await valuedAt('42373.01');
    const blockedOver = await ship(overThreshold, 1);
    assert.equal(blockedOver.status, 409, blockedOver.raw);
    assert.deepEqual((blockedOver.body['details'] as Record<string, unknown>)['reasons'], [
      'tax_invoice_missing',
      'e_way_bill_missing',
    ]);
    const overInvoice = await recordDocument(overThreshold, taxInvoice(`t4-over-${overThreshold}`));
    assert.equal(overInvoice.status, 200, overInvoice.raw);
    assert.deepEqual(overInvoice.body['ship_blockers'], ['e_way_bill_missing']);
    const stillHeld = await ship(overThreshold, 1);
    assert.equal(stillHeld.status, 409, stillHeld.raw);
    assert.equal(stillHeld.body['error_code'], 'GST_DOCUMENTS_REQUIRED');
    assert.deepEqual((stillHeld.body['details'] as Record<string, unknown>)['reasons'], [
      'e_way_bill_missing',
    ]);
  });

  it('T17: a declared unit value or a quantity/value product too large for its NUMERIC column is a TYPED 400, not an uncaught 500', async () => {
    // Nothing anywhere reached 1e12, so both column-derived magnitude bounds and the exponential-
    // notation guard in front of them were untested. Without the guard a JSON number at or above
    // 1e21 makes toFixed(6) return "1e+21" and BigInt() throws a bare SyntaxError inside the
    // applier - an uncaught 500 the caller cannot act on - so the assertion below is a typed 400,
    // never merely "not 200".
    const exponential = await createTransfer(
      locF,
      1,
      { declared_unit_value: 1e21 },
      SKU,
      lotSku,
      creatorOfficer.token,
    );
    assert.equal(exponential.status, 400, exponential.raw);
    assert.equal(exponential.body['error_code'], 'INVALID_PARAMS');
    assert.match(exponential.body['message'] as string, /maximum storable unit value/);

    // The string path is compared on its integer-digit count, which is exact at any size.
    const thirteenDigits = await createTransfer(
      locF,
      1,
      { declared_unit_value: '1234567890123' },
      SKU,
      lotSku,
      creatorOfficer.token,
    );
    assert.equal(thirteenDigits.status, 400, thirteenDigits.raw);
    assert.equal(thirteenDigits.body['error_code'], 'INVALID_PARAMS');
    assert.match(thirteenDigits.body['message'] as string, /maximum storable unit value/);
    // Twelve digits is storable, so the bound sits at the column and not somewhere short of it.
    const twelveDigits = await createTransfer(
      locF,
      1,
      { declared_unit_value: '999999999999' },
      SKU,
      lotSku,
      creatorOfficer.token,
    );
    assert.equal(twelveDigits.status, 201, twelveDigits.raw);
    assert.equal(
      (await valuationRow(twelveDigits.body['transfer_request_id'] as string))?.['unit_value'],
      '999999999999.000000',
    );

    // A storable unit value multiplied by a storable quantity can still overflow taxable_value's
    // NUMERIC(18,2) - 999999999999 x 20000 is 2.0e16, one order past the 16 integer digits the
    // column holds. Postgres would answer 22003 inside a 500; the bound answers 400.
    const overflowing = await createTransfer(
      locF,
      20000,
      { declared_unit_value: '999999999999' },
      SKU_ROUND,
      lotRound,
      creatorOfficer.token,
    );
    assert.equal(overflowing.status, 400, overflowing.raw);
    assert.equal(overflowing.body['error_code'], 'INVALID_PARAMS');
    assert.match(overflowing.body['message'] as string, /maximum storable taxable value/);
  });

  it('T26: AC 1 fourth basis - an ITC-eligible pair values on invoice_value_full_itc at create AND accepts it at override', async () => {
    // No pair was ever configured `recipient_full_itc_eligible: true`, so the Rule 28 second
    // proviso existed only as a refusal and `assertBasisEligible` had no positive path: making it
    // refuse unconditionally broke nothing. siteI's pair is the eligible one.
    const created = await createTransfer(
      locI,
      4,
      { declared_unit_value: '250.5' },
      SKU,
      lotSku,
      creatorOfficer.token,
    );
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    const row = await valuationRow(id);
    assert.equal(row?.['valuation_basis'], 'invoice_value_full_itc');
    assert.equal(row?.['basis_source'], 'declared');
    assert.equal(row?.['unit_value'], '250.500000');
    assert.equal(row?.['taxable_value'], '1002.00');
    assert.equal(row?.['to_gstin_ext'], GSTIN_I);

    // And the officer may re-state it on the same basis through the override door.
    const override = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'invoice_value_full_itc',
        declared_unit_value: 300,
        reason_code: 'ITC_ELIGIBLE',
      },
      bearer(officer.token),
    );
    assert.equal(override.status, 200, override.raw);
    const after = await valuationRow(id);
    assert.equal(after?.['valuation_basis'], 'invoice_value_full_itc');
    assert.equal(after?.['basis_source'], 'override');
    assert.equal(after?.['unit_value'], '300.000000');
    assert.equal(after?.['taxable_value'], '1200.00');
    assert.equal(after?.['override_reason_code'], 'ITC_ELIGIBLE');
  });

  it('T27: an intra_site transfer is not merely stamped - it SHIPS, and the gate lets it through on the stamp alone', async () => {
    // AC 5 was half covered: an intra_site transfer was created and its stamp asserted, but never
    // shipped, so an intra_site stamp mishandled at the ship gate failed no arm.
    const created = await createTransfer(locA2, 6);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    assert.equal((await classificationRow(id))?.['supply_class'], 'intra_site');
    assert.equal(await valuationRow(id), null);
    const block = (await getTransfer(id))['gst'] as Record<string, unknown>;
    assert.equal(block['supply_class'], 'intra_site');
    assert.deepEqual(block['ship_blockers'], []);

    const before = await onHandAtSource(SKU);
    const shipped = await ship(id, 6);
    assert.equal(shipped.status, 201, shipped.raw);
    assert.equal(shipped.body['status'], 'shipped');
    assert.equal((await onHandAtSource(SKU)).on_hand, before.on_hand - 6);
    // No statutory document was ever recorded for it, and none was demanded.
    const docs = await getPool().query(
      `SELECT count(*)::int AS n FROM branch_transfer_gst_document WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(docs.rows[0]!['n'], 0);
  });

  it('T28: a transfer still awaiting approval cannot carry a GST document - GST_DOCUMENT_STATE_INVALID naming the status', async () => {
    // P15 exists because a transfer awaiting approval accepted an IRN-bearing tax invoice, so a
    // FILED e-invoice could end up against a transfer that was then rejected - with the valuation
    // permanently locked by that document and no DELETE grant anywhere to unwind it. Every fixture
    // transfer is `pending_shipment` (this suite truncates doa_registry_entries, so nothing routes
    // for approval), so the status is set directly: what is under test is the applier's recording
    // WINDOW, not the DOA resolution that produces the status.
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    await getPool().query(
      `UPDATE transfer_request SET status = 'pending_approval' WHERE transfer_request_id = $1`,
      [id],
    );

    const refused = await recordDocument(id, taxInvoice(`t28-${id}`));
    assert.equal(refused.status, 400, refused.raw);
    assert.equal(refused.body['error_code'], 'GST_DOCUMENT_STATE_INVALID');
    const details = refused.body['details'] as Record<string, unknown>;
    assert.equal(details['current_status'], 'pending_approval');
    assert.equal(details['transfer_request_id'], id);
    const stored = await getPool().query(
      `SELECT count(*)::int AS n FROM branch_transfer_gst_document WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(stored.rows[0]!['n'], 0);

    // Back inside the recording window the identical document is accepted, so the refusal above is
    // the status check and not something about this document.
    await getPool().query(
      `UPDATE transfer_request SET status = 'pending_shipment' WHERE transfer_request_id = $1`,
      [id],
    );
    const accepted = await recordDocument(id, taxInvoice(`t28-${id}`));
    assert.equal(accepted.status, 200, accepted.raw);
  });

  it('T13: VALUATION_LOCKED has TWO causes - a shipped transfer is locked by STATUS, the cause AC 2 names', async () => {
    // Only the document cause was covered, so deleting the VALUATION_LOCKED_STATUSES check left
    // every arm green: a shipped transfer would have fallen through to the document check and
    // answered the same CODE with a different discriminator, which is what `locked_by` separates.
    const created = await createTransfer(locB, 100); // 11000.00, below the threshold
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    assert.equal((await recordDocument(id, taxInvoice(`t13-${id}`))).status, 200);
    const shipped = await ship(id, 100);
    assert.equal(shipped.status, 201, shipped.raw);
    assert.equal(shipped.body['status'], 'shipped');

    const locked = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'like_kind_quality',
        declared_unit_value: 1,
        reason_code: 'AFTER_THE_FACT',
      },
      bearer(officer.token),
    );
    assert.equal(locked.status, 409, locked.raw);
    assert.equal(locked.body['error_code'], 'VALUATION_LOCKED');
    const details = locked.body['details'] as Record<string, unknown>;
    // The status check runs FIRST, so a shipped transfer that also has a document reports `status`.
    assert.equal(details['locked_by'], 'status');
    assert.equal(details['current_status'], 'shipped');
    assert.equal((await valuationRow(id))?.['unit_value'], '110.000000');
  });

  it('T14: a re-recorded document whose NUMBER matches but whose IRN, issue instant or e-way-bill validity differs is GST_DOCUMENT_CONFLICT; an identical instant re-rendered is still a no-op', async () => {
    // The divergence check compares the whole filed record, not the document number alone: a second
    // recording carrying the same number with a CORRECTED IRN, issue instant or validity used to be
    // discarded in silence while the API answered success, so the stored document and the filed one
    // drifted apart with no trace. Only same-number-no-op and different-number-conflict were
    // covered, and the number comparison alone satisfies both.
    const created = await createTransfer(locB, 600); // above the threshold, so both kinds apply
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    const number = `INV-11-5-t14-${id}`;
    const irn = irnFor(`t14-${id}`).toUpperCase();
    const issuedAt = '2026-09-01T10:00:00Z';
    const invoice = await recordDocument(id, {
      document_kind: 'tax_invoice',
      document_number_ext: number,
      irn_ext: irn,
      issued_at: issuedAt,
    });
    assert.equal(invoice.status, 200, invoice.raw);

    // Same number, DIFFERENT IRN.
    const irnChanged = await recordDocument(id, {
      document_kind: 'tax_invoice',
      document_number_ext: number,
      irn_ext: irnFor(`t14-other-${id}`).toUpperCase(),
      issued_at: issuedAt,
    });
    assert.equal(irnChanged.status, 409, irnChanged.raw);
    assert.equal(irnChanged.body['error_code'], 'GST_DOCUMENT_CONFLICT');
    const irnDetails = irnChanged.body['details'] as Record<string, unknown>;
    assert.equal(irnDetails['existing_document_number_ext'], number);
    assert.equal(irnDetails['existing_irn_ext'], irnFor(`t14-${id}`));
    assert.equal(irnDetails['irn_ext'], irnFor(`t14-other-${id}`));

    // Same number and IRN, DIFFERENT issue instant.
    const issuedChanged = await recordDocument(id, {
      document_kind: 'tax_invoice',
      document_number_ext: number,
      irn_ext: irn,
      issued_at: '2026-09-02T10:00:00Z',
    });
    assert.equal(issuedChanged.status, 409, issuedChanged.raw);
    assert.equal(issuedChanged.body['error_code'], 'GST_DOCUMENT_CONFLICT');
    assert.equal(
      (issuedChanged.body['details'] as Record<string, unknown>)['issued_at'],
      '2026-09-02T10:00:00Z',
    );

    // P12: the SAME instant re-rendered with an explicit offset and milliseconds is the SAME
    // document. Compared as text this is a conflict; compared as an instant it is a no-op.
    const reRendered = await recordDocument(id, {
      document_kind: 'tax_invoice',
      document_number_ext: number,
      irn_ext: irn,
      issued_at: '2026-09-01T10:00:00.000+00:00',
    });
    assert.equal(reRendered.status, 200, reRendered.raw);
    const invoiceRows = await getPool().query(
      `SELECT count(*)::int AS n FROM branch_transfer_gst_document
        WHERE transfer_request_id = $1 AND document_kind = 'tax_invoice'`,
      [id],
    );
    assert.equal(invoiceRows.rows[0]!['n'], 1);

    // And the e-way bill's own field: same number, DIFFERENT validity end.
    const ewbNumber = `EWB-11-5-t14-${id}`;
    const firstEwb = await recordDocument(id, {
      document_kind: 'e_way_bill',
      document_number_ext: ewbNumber,
      ewb_valid_until: '2030-01-01T00:00:00Z',
      issued_at: '2026-09-01T11:00:00Z',
    });
    assert.equal(firstEwb.status, 200, firstEwb.raw);
    const validityChanged = await recordDocument(id, {
      document_kind: 'e_way_bill',
      document_number_ext: ewbNumber,
      ewb_valid_until: '2030-02-01T00:00:00Z',
      issued_at: '2026-09-01T11:00:00Z',
    });
    assert.equal(validityChanged.status, 409, validityChanged.raw);
    assert.equal(validityChanged.body['error_code'], 'GST_DOCUMENT_CONFLICT');
    assert.equal(
      (validityChanged.body['details'] as Record<string, unknown>)['ewb_valid_until'],
      '2030-02-01T00:00:00Z',
    );
    // The same validity re-rendered is still a no-op.
    const sameValidity = await recordDocument(id, {
      document_kind: 'e_way_bill',
      document_number_ext: ewbNumber,
      ewb_valid_until: '2030-01-01T00:00:00.000+00:00',
      issued_at: '2026-09-01T11:00:00Z',
    });
    assert.equal(sameValidity.status, 200, sameValidity.raw);
  });

  it('T15: replaying an override the row already carries is a NO-OP even after the transfer shipped, not VALUATION_LOCKED', async () => {
    // P10: an override whose event id is already stamped on the (locked) valuation row has been
    // applied. Replaying it after shipment used to throw VALUATION_LOCKED for an event the system
    // had ALREADY ACCEPTED, stalling the offline replay on a permanent error. No override was ever
    // replayed anywhere, so deleting the short-circuit was free.
    const created = await createTransfer(locB, 100); // 11000.00, below the threshold
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    const eventId = randomUUID();
    const envelope = doorEnvelope(
      'transfer_request.valuation_overridden',
      id,
      { valuation_basis: 'like_kind_quality', declared_unit_value: 140, reason_code: 'T15' },
      { userId: officer.userId, role: 'gst_officer' },
      eventId,
    );
    const applied = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      envelope,
      bearer(officer.token),
    );
    assert.equal(applied.status, 201, applied.raw);
    assert.equal((await valuationRow(id))?.['unit_value'], '140.000000');
    assert.equal((await valuationRow(id))?.['source_event_id'], eventId);

    assert.equal((await recordDocument(id, taxInvoice(`t15-${id}`))).status, 200);
    const shipped = await ship(id, 100);
    assert.equal(shipped.status, 201, shipped.raw);

    // Through the door the identical envelope is answered 2xx - but by the store's idempotency
    // short-circuit, which returns the stored event BEFORE any applier runs. That half is real
    // contract and is asserted here; it is NOT what pins the applier's own guard.
    const doorReplay = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      envelope,
      bearer(officer.token),
    );
    assert.ok(doorReplay.status >= 200 && doorReplay.status < 300, doorReplay.raw);

    // The applier itself, called with the stamped event id against the now-SHIPPED transfer, must
    // return without throwing. Delete the `valuation?.source_event_id === sourceEventId` guard and
    // this raises VALUATION_LOCKED - the exact permanent error that stalled the replay.
    const replayEnvelope: EventEnvelope = {
      event_id: eventId,
      stream_type: 'inventory',
      stream_id: id,
      event_type: 'transfer_request.valuation_overridden',
      payload: {
        transfer_request_id: id,
        site_id: siteA,
        business_stream: 'production',
        valuation_basis: 'like_kind_quality',
        declared_unit_value: 140,
        reason_code: 'T15',
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: officer.userId, role: 'gst_officer', location_id: siteA },
        occurred_at: new Date().toISOString(),
      },
    };
    await inTransaction(async (client) => {
      await applyTransferValuationOverridden(replayEnvelope, client, eventId);
    });
    assert.equal((await valuationRow(id))?.['unit_value'], '140.000000');

    // Non-vacuity: the SAME envelope under a DIFFERENT event id is a genuinely new override and is
    // refused, so the arm above passes because of the replay guard and not because the applier is
    // inert on a shipped transfer.
    await assert.rejects(
      () =>
        inTransaction(async (client) => {
          await applyTransferValuationOverridden(replayEnvelope, client, randomUUID());
        }),
      (err: unknown) => {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        assert.equal(e.errorCode, 'VALUATION_LOCKED');
        assert.equal((e.details ?? {})['locked_by'], 'status');
        return true;
      },
    );
  });

  it('T20/T21: guard ORDER - an OVER-ship of a valued inter-GSTIN supply is 409 SHIP_QUANTITY_MISMATCH with an audit row, while a non-inter-GSTIN over-ship is still 400 QUANTITY_EXCEEDS_APPROVED', async () => {
    // SHIP_QUANTITY_MISMATCH now fires BEFORE QUANTITY_EXCEEDS_APPROVED, so the code an over-ship
    // returns changed and nothing pinned it: only a SHORT ship was covered. The arm runs at the
    // EVENTS door, which is where the ordering is observable - the REST route has its own
    // pre-transaction quantity check that answers 400 before the seam is reached at all, and both
    // halves are asserted. (This also discharges review ruling F2, which declined to convert a
    // legacy suite to a two-GSTIN fixture on the grounds that this arm buys the same coverage.)
    const created = await createTransfer(locB, 100); // 11000.00, tax invoice alone clears the gate
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    assert.equal((await recordDocument(id, taxInvoice(`t20-${id}`))).status, 200);

    const before = await onHandAtSource(SKU);
    const overShip = await doorShip(id, 150);
    assert.equal(overShip.status, 409, overShip.raw);
    assert.equal(overShip.body['error_code'], 'SHIP_QUANTITY_MISMATCH');
    const details = overShip.body['details'] as Record<string, unknown>;
    assert.equal(details['valued_quantity'], 100);
    assert.equal(details['shipped_quantity'], 150);
    // T21: the refusal is audited on the OFFLINE door too - the one a short or over ship is most
    // likely to arrive through - and the row survives the event rollback.
    assert.equal(await auditRowsFor(id, 'SHIP_QUANTITY_MISMATCH'), 1);
    assert.equal((await onHandAtSource(SKU)).on_hand, before.on_hand);

    // The REST route's own pre-check still answers first, so the two doors differ deliberately.
    const routeOverShip = await ship(id, 150);
    assert.equal(routeOverShip.status, 400, routeOverShip.raw);
    assert.equal(routeOverShip.body['error_code'], 'QUANTITY_EXCEEDS_APPROVED');

    // A transfer that is NOT a valued inter-GSTIN supply keeps the Story 2.5 contract at the same
    // door: valued_quantity is null, so the mismatch guard is skipped and the quantity bar fires.
    const intra = await createTransfer(locC, 10);
    assert.equal(intra.status, 201, intra.raw);
    const intraId = intra.body['transfer_request_id'] as string;
    const intraOver = await doorShip(intraId, 15);
    assert.equal(intraOver.status, 400, intraOver.raw);
    assert.equal(intraOver.body['error_code'], 'QUANTITY_EXCEEDS_APPROVED');
    assert.equal((intraOver.body['details'] as Record<string, unknown>)['approved_quantity'], 10);
    assert.equal(await auditRowsFor(intraId, 'SHIP_QUANTITY_MISMATCH'), 0);

    // The exact valued quantity still ships through the same door.
    const exact = await doorShip(id, 100);
    assert.ok(exact.status >= 200 && exact.status < 300, exact.raw);
    assert.equal((await onHandAtSource(SKU)).on_hand, before.on_hand - 100);
  });

  it('T12/P18: a payload naming a site the officer DOES hold but which is not the transfer source is TRANSFER_SITE_MISMATCH, and the refusal does not leak the real from_site_id', async () => {
    // TRANSFER_SITE_MISMATCH is the guard written for the 2026-09-06 cross-site write class and it
    // had zero coverage on any door: every envelope in this suite hardcoded site_id: siteA, which
    // is the source site of every transfer here. officerTwoSites holds siteA AND siteX, so the
    // door's gst_officer site gate PASSES for a siteX payload and this binding is the only wall
    // left - the refusal cannot be a disguised authorisation denial.
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    const mismatched = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      doorEnvelope(
        'transfer_request.valuation_overridden',
        id,
        {
          site_id: siteX,
          valuation_basis: 'like_kind_quality',
          declared_unit_value: 999,
          reason_code: 'WRONG_SITE',
        },
        { userId: officerTwoSites.userId, role: 'gst_officer', locationId: siteX },
      ),
      bearer(officerTwoSites.token),
    );
    assert.equal(mismatched.status, 400, mismatched.raw);
    assert.equal(mismatched.body['error_code'], 'TRANSFER_SITE_MISMATCH');
    const details = mismatched.body['details'] as Record<string, unknown>;
    // P18: the detail names ONLY the site the caller supplied. Echoing the transfer's real
    // from_site_id back would hand an unauthorised caller the identifier the refusal withholds.
    assert.deepEqual(Object.keys(details), ['site_id']);
    assert.equal(details['site_id'], siteX);
    assert.equal(details['from_site_id'], undefined, 'the refusal leaked the real source site');
    // Nothing was applied.
    assert.equal((await valuationRow(id))?.['unit_value'], '110.000000');
    assert.equal((await valuationRow(id))?.['basis_source'], 'config_default');

    // The SAME identity naming the transfer's real site is admitted, so the refusal above is the
    // payload binding and nothing about officerTwoSites.
    const bound = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      doorEnvelope(
        'transfer_request.valuation_overridden',
        id,
        {
          valuation_basis: 'like_kind_quality',
          declared_unit_value: 999,
          reason_code: 'RIGHT_SITE',
        },
        { userId: officerTwoSites.userId, role: 'gst_officer' },
      ),
      bearer(officerTwoSites.token),
    );
    assert.equal(bound.status, 201, bound.raw);
    assert.equal((await valuationRow(id))?.['unit_value'], '999.000000');
  });

  it('T9/T10/T30: on the REST routes a gst_officer scoped to ANOTHER site is refused, a site-scoped officer with no wildcard is admitted, and the audit row names the AUTHORISING assignment', async () => {
    // T9: the only "officer elsewhere" identity also held gst_officer at locA, one of the two
    // scopes `gstOfficerActor` accepts, so it PASSED both routes and no arm anywhere drove a
    // wrong-site officer at them - deleting the scope half of the gate was green.
    // T10: the positive direction was only ever driven by an officer holding the wildcard `*`,
    // which short-circuits the site comparison, so that direction was unfalsifiable too. Here it is
    // driven by creatorOfficer, whose ONLY gst_officer assignment is at siteA.
    const created = await createTransfer(locB, 10);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    const deniedOverride = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'like_kind_quality',
        declared_unit_value: 55,
        reason_code: 'WRONG_SITE',
      },
      bearer(officerOtherSiteOnly.token),
    );
    assert.equal(deniedOverride.status, 403, deniedOverride.raw);
    assert.equal(deniedOverride.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const overrideDetails = deniedOverride.body['details'] as Record<string, unknown>;
    assert.equal(overrideDetails['location_id'], locA);
    assert.equal(overrideDetails['site_id'], siteA);
    assert.deepEqual(overrideDetails['required_roles'], ['gst_officer']);
    assert.equal((await valuationRow(id))?.['basis_source'], 'config_default');

    const deniedDocument = await recordDocument(
      id,
      taxInvoice(`t9-${id}`),
      officerOtherSiteOnly.token,
    );
    assert.equal(deniedDocument.status, 403, deniedDocument.raw);
    assert.equal(deniedDocument.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.equal((deniedDocument.body['details'] as Record<string, unknown>)['site_id'], siteA);

    // The site-scoped officer who genuinely holds siteA - and no wildcard - is admitted at both.
    const allowedOverride = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'like_kind_quality',
        declared_unit_value: 55,
        reason_code: 'SITE_SCOPED',
      },
      bearer(creatorOfficer.token),
    );
    assert.equal(allowedOverride.status, 200, allowedOverride.raw);
    assert.equal((await valuationRow(id))?.['unit_value'], '55.000000');
    assert.equal((await valuationRow(id))?.['overridden_by'], creatorOfficer.userId);

    const allowedDocument = await recordDocument(id, taxInvoice(`t30-${id}`), creatorOfficer.token);
    assert.equal(allowedDocument.status, 200, allowedDocument.raw);

    // T30 / Q6: creatorOfficer holds TWO roles - warehouse_manager at locA and gst_officer at
    // siteA - so the audit row CAN name the wrong one. It must name the assignment that actually
    // AUTHORISED the act: the gst_officer one, at the site scope that satisfied the gate.
    async function lastSuccessAudit(endpoint: string): Promise<Record<string, unknown>> {
      const r = await getPool().query(
        `SELECT role, location_id FROM audit_log
          WHERE endpoint = $1 AND user_id = $2::uuid AND error_code IS NULL
          ORDER BY seq_no DESC LIMIT 1`,
        [endpoint, creatorOfficer.userId],
      );
      assert.equal(r.rows.length, 1, `no successful audit row for ${endpoint}`);
      return r.rows[0] as Record<string, unknown>;
    }
    const documentAudit = await lastSuccessAudit(
      `/api/v1/transfer-requests/${id}/gst-documents`,
    );
    assert.equal(documentAudit['role'], 'gst_officer');
    assert.equal(documentAudit['location_id'], siteA);
    const overrideAudit = await lastSuccessAudit(
      `/api/v1/transfer-requests/${id}/valuation-override`,
    );
    assert.equal(overrideAudit['role'], 'gst_officer');
    assert.equal(overrideAudit['location_id'], siteA);
    // And the event the route persisted carries the same authorising assignment.
    const persisted = await eventRow(allowedDocument.body['eventId'] as string);
    const actor = (persisted['metadata'] as Record<string, unknown>)['actor'] as Record<
      string,
      unknown
    >;
    assert.equal(actor['role'], 'gst_officer');
    assert.equal(actor['location_id'], siteA);
  });

  it('T22: the EDGE door admits a gst_document_recorded from an officer who holds the site, and refuses one whose gst_officer assignment is on the wrong MODULE or at READ scope', async () => {
    // The edge gate was only ever entered for the override event type, so narrowing its event-type
    // set to the override alone silently reverted half of Q1. Its module / functionScope halves had
    // no arm at all: both identities below hold a REAL gst_officer assignment at siteA - one on
    // module `quality`, one at read scope - and both reach the gate through a warehouse_manager
    // write grant, so a vacuous requireRole denial is ruled out and deleting either half of the
    // predicate admits them to a statutory write.
    const created = await createTransfer(locB, 600);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;

    function edgeDocument(
      actor: { userId: string; token: string },
      locationId: string,
      seed: string,
    ): Promise<HttpResult> {
      return makeRequest(
        port,
        'POST',
        '/api/v1/edge/events',
        {
          event_id: randomUUID(),
          idempotency_key: randomUUID(),
          stream_type: 'inventory',
          stream_id: id,
          event_type: 'transfer_request.gst_document_recorded',
          payload: {
            transfer_request_id: id,
            site_id: siteA,
            business_stream: 'production',
            ...taxInvoice(seed),
          },
          metadata: {
            correlation_id: randomUUID(),
            actor: { user_id: actor.userId, role: 'gst_officer', location_id: locationId },
            occurred_at: new Date().toISOString(),
            device_id: `edge-11-5-${run}`,
          },
        },
        bearer(actor.token),
      );
    }

    const wrongModule = await edgeDocument(officerWrongModule, locA, `t22-mod-${id}`);
    assert.equal(wrongModule.status, 403, wrongModule.raw);
    assert.equal(wrongModule.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepEqual((wrongModule.body['details'] as Record<string, unknown>)['required_roles'], [
      'gst_officer',
    ]);
    const readScope = await edgeDocument(officerReadScope, locA, `t22-read-${id}`);
    assert.equal(readScope.status, 403, readScope.raw);
    assert.equal(readScope.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepEqual((readScope.body['details'] as Record<string, unknown>)['required_roles'], [
      'gst_officer',
    ]);
    // Nothing was recorded by either refusal.
    const none = await getPool().query(
      `SELECT count(*)::int AS n FROM branch_transfer_gst_document WHERE transfer_request_id = $1`,
      [id],
    );
    assert.equal(none.rows[0]!['n'], 0);

    // The officer who holds siteA on inventory at write scope IS admitted, and the document lands.
    const allowed = await edgeDocument(officerTwoSites, siteA, `t22-ok-${id}`);
    assert.ok(allowed.status >= 200 && allowed.status < 300, allowed.raw);
    const stored = await getPool().query(
      `SELECT document_number_ext, recorded_by, site_id FROM branch_transfer_gst_document
        WHERE transfer_request_id = $1 AND document_kind = 'tax_invoice'`,
      [id],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]!['document_number_ext'], `INV-11-5-t22-ok-${id}`);
    assert.equal(stored.rows[0]!['recorded_by'], officerTwoSites.userId);
    assert.equal(stored.rows[0]!['site_id'], siteA);
  });

  it('T29: a create REPLAY answers with the same concrete supply_class and valuation as the create it replays', async () => {
    // Q16's create-replay branch was never driven. The fresh-create branch was, so a replay that
    // dropped the class - which is what the pre-Q16 code did, since JSON drops `undefined` - would
    // have failed no arm.
    const interId = randomUUID();
    const body = {
      transfer_request_id: interId,
      sku_id: SKU,
      from_location_id: locA,
      to_location_id: locB,
      quantity: 12,
      lot_id: lotSku,
      business_stream: 'production',
    };
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/transfer-requests',
      body,
      bearer(warehouse.token),
    );
    assert.equal(first.status, 201, first.raw);
    assert.equal((first.body['gst'] as Record<string, unknown>)['supply_class'], 'inter_gstin');

    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/transfer-requests',
      body,
      bearer(warehouse.token),
    );
    assert.equal(replay.status, 200, replay.raw);
    assert.equal(replay.body['transfer_request_id'], interId);
    const replayGst = replay.body['gst'] as Record<string, unknown>;
    assert.equal(replayGst['supply_class'], 'inter_gstin');
    const replayValuation = replayGst['valuation'] as Record<string, unknown> | null;
    assert.ok(replayValuation, 'the replay dropped the valuation');
    assert.equal(replayValuation['taxable_value'], '1320.00');
    // Exactly one valuation, so the replay allocated and valued nothing a second time.
    const rows = await getPool().query(
      `SELECT count(*)::int AS n FROM branch_transfer_valuation WHERE transfer_request_id = $1`,
      [interId],
    );
    assert.equal(rows.rows[0]!['n'], 1);

    // The intra classes replay with a concrete class too, which is the case JSON used to swallow.
    const withinId = randomUUID();
    const withinBody = {
      ...body,
      transfer_request_id: withinId,
      to_location_id: locA2,
      quantity: 2,
    };
    const withinFirst = await makeRequest(
      port,
      'POST',
      '/api/v1/transfer-requests',
      withinBody,
      bearer(warehouse.token),
    );
    assert.equal(withinFirst.status, 201, withinFirst.raw);
    const withinReplay = await makeRequest(
      port,
      'POST',
      '/api/v1/transfer-requests',
      withinBody,
      bearer(warehouse.token),
    );
    assert.equal(withinReplay.status, 200, withinReplay.raw);
    const withinGst = withinReplay.body['gst'] as Record<string, unknown>;
    assert.equal(withinGst['supply_class'], 'intra_site');
    assert.equal(withinGst['valuation'], null);
  });

  it('T18: findSiteGstin is INCLUSIVE at both ends - a transfer on effective_from and on effective_to resolves, one day either side does not', async () => {
    // Every other fixture window is 2020-04-01 to NULL against 2026 business dates, so no boundary
    // was tested anywhere and an off-by-one at either comparison would silently un-register a site
    // on its first or last valid day. siteK is registered 2026-06-10 to 2026-06-20 INCLUSIVE; the
    // business date is driven from metadata.occurred_at through the events door, because the REST
    // route always means "today".
    const inside = [
      ['2026-06-10', 'the first day of the window'],
      ['2026-06-20', 'the last day of the window'],
    ] as const;
    for (const [businessDate, why] of inside) {
      const transferId = randomUUID();
      const r = await createAtBusinessDate(locK, 3, businessDate, transferId);
      assert.equal(r.status, 201, `${why}: ${r.raw}`);
      const stamp = await classificationRow(transferId);
      assert.equal(stamp?.['supply_class'], 'inter_gstin', why);
      assert.equal(stamp?.['to_gstin_ext'], GSTIN_K, why);
      assert.equal(stamp?.['business_date'], businessDate, why);
      assert.equal((await valuationRow(transferId))?.['taxable_value'], '330.00', why);
    }

    const outside = [
      ['2026-06-09', 'the day before effective_from'],
      ['2026-06-21', 'the day after effective_to'],
    ] as const;
    for (const [businessDate, why] of outside) {
      const transferId = randomUUID();
      const r = await createAtBusinessDate(locK, 3, businessDate, transferId);
      assert.equal(r.status, 409, `${why}: ${r.raw}`);
      assert.equal(r.body['error_code'], 'SITE_GSTIN_MISSING', why);
      const details = r.body['details'] as Record<string, unknown>;
      assert.equal(details['site_id'], siteK, why);
      assert.equal(details['business_date'], businessDate, why);
      assert.equal(await classificationRow(transferId), null, why);
    }
  });

  it('T34: the three EVENT-DERIVED projections rebuild from domain_events; site_gstin and the valuation config deliberately do not', async () => {
    // Nothing verified that branch_transfer_classification, branch_transfer_valuation and
    // branch_transfer_gst_document are reconstructible from the event log - which is the whole
    // claim behind calling them read models. This arm builds a transfer carrying all three rows,
    // drops them (with the transfer_request row, so the create applier's idempotency guard does not
    // short-circuit the replay), replays the stored events through the SAME appliers both doors
    // run, and compares column by column.
    //
    // DELIBERATE, following the transaction_tagging_rules precedent recorded in
    // src/api/v1/sites.ts: `site_gstin` and `branch_transfer_valuation_config` are written DIRECTLY
    // by their routes and emit no domain event, so they are unrebuildable BY CONSTRUCTION. They are
    // dated configuration, not a projection of the log, and no attempt is made to rebuild them
    // here. If either ever starts emitting an event, this arm should grow to cover it.
    const created = await createTransfer(locB, 20);
    assert.equal(created.status, 201, created.raw);
    const id = created.body['transfer_request_id'] as string;
    const override = await makeRequest(
      port,
      'POST',
      `/api/v1/transfer-requests/${id}/valuation-override`,
      {
        idempotency_key: randomUUID(),
        valuation_basis: 'like_kind_quality',
        declared_unit_value: 77,
        reason_code: 'REBUILD',
      },
      bearer(officer.token),
    );
    assert.equal(override.status, 200, override.raw);
    assert.equal((await recordDocument(id, taxInvoice(`t34-${id}`))).status, 200);

    const STABLE: Record<string, string> = {
      branch_transfer_classification:
        'supply_class, from_site_id, to_site_id, from_gstin_ext, to_gstin_ext, business_date::text AS business_date, source_event_id',
      branch_transfer_valuation:
        'valuation_basis, basis_source, unit_value::text AS unit_value, taxable_value::text AS taxable_value, from_gstin_ext, to_gstin_ext, overridden_by, override_reason_code, source_event_id, valuation_config_id, business_date::text AS business_date',
      branch_transfer_gst_document:
        'document_kind, document_number_ext, irn_ext, issued_at, ewb_valid_until, site_id, recorded_by, source_event_id',
    };
    async function snapshot(): Promise<Record<string, unknown[]>> {
      const out: Record<string, unknown[]> = {};
      for (const [table, columns] of Object.entries(STABLE)) {
        const r = await getPool().query(
          `SELECT ${columns} FROM ${table} WHERE transfer_request_id = $1 ORDER BY source_event_id`,
          [id],
        );
        out[table] = r.rows;
      }
      return out;
    }
    const original = await snapshot();
    assert.equal(original['branch_transfer_classification']!.length, 1);
    assert.equal(original['branch_transfer_valuation']!.length, 1);
    assert.equal(original['branch_transfer_gst_document']!.length, 1);

    // The stored events, in the order the store assigned them.
    const events = await getPool().query(
      `SELECT event_id, stream_type, stream_id, event_type, payload, metadata
         FROM domain_events WHERE stream_id = $1 ORDER BY event_version ASC`,
      [id],
    );
    assert.equal(events.rows.length, 3, 'expected create, override and document events');

    // Drop the derived rows AND the transfer row itself (app_user holds no DELETE grant).
    const admin = getAdminPool();
    for (const table of [
      'branch_transfer_gst_document',
      'branch_transfer_valuation',
      'branch_transfer_classification',
      'transfer_request',
    ]) {
      await admin.query(`DELETE FROM ${table} WHERE transfer_request_id = $1`, [id]);
    }
    const emptied = await snapshot();
    for (const table of Object.keys(STABLE)) {
      assert.equal(emptied[table]!.length, 0, `${table} was not emptied`);
    }

    await inTransaction(async (client) => {
      for (const row of events.rows) {
        const envelope: EventEnvelope = {
          event_id: row['event_id'] as string,
          stream_type: row['stream_type'] as string,
          stream_id: row['stream_id'] as string,
          event_type: row['event_type'] as string,
          payload: row['payload'] as Record<string, unknown>,
          metadata: row['metadata'] as EventEnvelope['metadata'],
        };
        const eventId = row['event_id'] as string;
        await applyTransferRequestProjection(envelope, client, eventId);
        await applyTransferValuationOverridden(envelope, client, eventId);
        await applyTransferGstDocumentRecorded(envelope, client, eventId);
      }
    });

    assert.deepEqual(await snapshot(), original, 'the rebuild did not reproduce the rows');
  });
});

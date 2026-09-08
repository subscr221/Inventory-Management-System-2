import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../../src/server.js';
import { closePool, getPool } from '../../src/config/db.js';

// ---------------------------------------------------------------------------
// Story 11.2 - IRN-before-dispatch enforcement (AC 1, AC 2)
//
// A fully-packed, document-generated, ERP-backed dispatch order is refused at the FINAL dispatch
// with 409 IRN_MISSING until an outbound IRN is recorded against it; recording the IRN lifts the
// block; re-recording the SAME invoice is a no-op; recording a DIFFERENT invoice against an already
// covered dispatch order is 409 DISPATCH_IRN_CONFLICT; a direct POST /api/v1/events meets the
// identical wall; an erp.*-shaped attempt is 405; and binding decision 2's coverage grain is proven
// by the multi-line-invoice and multi-invoice-order arms.
//
// Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run
// serially; every identifier is run-scoped. The harness scaffolding is a local re-implementation of
// the story-3-7 closures (never import cross-story).
// ---------------------------------------------------------------------------

const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

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

async function scimCreateAccessToken(port: number, externalId: string): Promise<string> {
  const result = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub: externalId });
  assert.ok(result.status >= 200 && result.status < 300, `dev-token failed: ${result.raw}`);
  const token = result.body['token'];
  assert(typeof token === 'string', 'dev-token response missing token');
  return token;
}

async function createWarehouseManager(
  port: number,
  locationId: string,
): Promise<{ userId: string; token: string }> {
  const externalId = `wm-11-2-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'Warehouse Manager', [
    { role: 'warehouse_manager', module: 'warehouse', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, externalId);
  return { userId, token };
}

async function createWarehouseOperator(
  port: number,
  locationId: string,
): Promise<{ userId: string; token: string }> {
  const externalId = `wo-11-2-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'Warehouse Operator', [
    { role: 'warehouse_operator', module: 'warehouse', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, externalId);
  return { userId, token };
}

// The job-work arm needs a caller who can actually REACH the job-work dispatch seam: a warehouse
// role is refused MODULE_ACCESS_DENIED at the door, which would make the arm vacuous.
async function createJobworkCoordinator(
  port: number,
  locationId: string,
): Promise<{ userId: string; token: string }> {
  const externalId = `jw-11-2-${randomUUID().slice(0, 8)}`;
  const userId = await scimCreateUser(port, externalId, 'Jobwork Coordinator', [
    { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId },
  ]);
  const token = await scimCreateAccessToken(port, externalId);
  return { userId, token };
}

// erp_sales_order is a direct-upsert reference projection (Story 2.9), not event-sourced - seed it
// with SQL directly, mirroring Story 3.6's seedOrderLine helper. line_no lets one multi-line invoice
// (one so_number_ext) cover multiple dispatch orders (one erp_sales_order row per line).
async function seedErpSalesOrder(
  id: string,
  soNumberExt: string,
  sku: string,
  quantity: string,
  siteId: string,
  lineNo = 1,
): Promise<void> {
  await getPool().query(
    `INSERT INTO erp_sales_order
       (id, so_number_ext, line_no, sku, quantity, ship_from_site_id, ship_from_site_code_ext, ship_to_ext, status, source_system, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'SITE-112', 'Customer JKL', 'open', 'ERP', now())`,
    [id, soNumberExt, lineNo, sku, quantity, siteId],
  );
}

async function seedLocation(
  locationId: string,
  code: string,
  level: string,
  parentId: string | null,
  siteId: string,
  pickSequence: number | null = null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO location_register
       (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class,
        size_class, hazmat_allowed, quarantine, access_restricted, status, pick_sequence)
     VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', 'standard', false, false, false, 'active', $6)`,
    [locationId, code, level, parentId, siteId, pickSequence],
  );
}

async function createLot(lotNumber: string, sku: string, lotId: string): Promise<void> {
  await getPool().query(
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
  await getPool().query(
    `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand)
     VALUES ($1, $2, $3, 'owned', $4)`,
    [sku, locationId, lotNumber, onHand],
  );
}

// Runs an ERP-backed dispatch order through pick -> pack -> shipping documents via the REAL routes so
// the dispatched seam is reached in its intended state. Returns nothing; the caller drives dispatch.
async function makeReadyDispatchOrder(
  port: number,
  managerToken: string,
  operatorToken: string,
  dispatchOrderId: string,
  sku: string,
  lotId: string,
  quantity: string,
): Promise<void> {
  const pick = await makeRequest(
    port,
    'POST',
    '/api/v1/pick-tasks/generate',
    { dispatchOrderId, dispatchOrderLineIds: [dispatchOrderId], strategy: 'single' },
    { Authorization: `Bearer ${managerToken}` },
  );
  assert.equal(pick.status, 201, `Pick task generation failed: ${pick.raw}`);
  const pickTaskId = (pick.body['pickTaskIds'] as string[] | undefined)?.[0];
  const pickLineId = (pick.body['pickLineIds'] as string[] | undefined)?.[0];
  assert(
    typeof pickTaskId === 'string' && typeof pickLineId === 'string',
    'Pick response incomplete',
  );

  const confirm = await makeRequest(
    port,
    'POST',
    `/api/v1/pick-tasks/${pickTaskId}/lines/${pickLineId}/confirm`,
    { confirmedLotId: lotId, confirmedQuantity: quantity, captureMethod: 'PWA' },
    { Authorization: `Bearer ${operatorToken}` },
  );
  assert.equal(confirm.status, 200, `Pick line confirmation failed: ${confirm.raw}`);

  const pack = await makeRequest(
    port,
    'POST',
    `/api/v1/dispatch/${dispatchOrderId}/pack`,
    {
      dispatchOrderId,
      packingLines: [
        { sku, packed_qty: quantity, lot_id: lotId, carton_count: 2, actual_weight_kg: 4.0 },
      ],
    },
    { Authorization: `Bearer ${managerToken}` },
  );
  assert.equal(pack.status, 200, `Pack failed: ${pack.raw}`);

  const docs = await makeRequest(
    port,
    'POST',
    `/api/v1/dispatch/${dispatchOrderId}/generate-documents`,
    { dispatchOrderId },
    { Authorization: `Bearer ${managerToken}` },
  );
  assert.equal(docs.status, 200, `Shipping documents generation failed: ${docs.raw}`);
}

// A GST IRN is the IRP's SHA-256 over the invoice: 64 hexadecimal characters (review decision D2).
// Fixtures derive a deterministic, well-formed one from a run-scoped seed.
function irnFor(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

async function recordIrn(
  port: number,
  token: string,
  dispatchOrderId: string,
  invoiceNumberExt: string,
  irnExt: string,
  alsoCovers?: string[],
  extra: Record<string, unknown> = {},
): Promise<HttpResult> {
  return makeRequest(
    port,
    'POST',
    `/api/v1/dispatch/${dispatchOrderId}/irn`,
    {
      idempotency_key: randomUUID(),
      invoice_number_ext: invoiceNumberExt,
      irn_ext: irnExt,
      ...(alsoCovers && alsoCovers.length > 0 ? { also_covers: alsoCovers } : {}),
      ...extra,
    },
    { Authorization: `Bearer ${token}` },
  );
}

function irnRecordedEnvelope(
  actor: { userId: string; role: string },
  siteId: string,
  payload: Record<string, unknown>,
  eventId?: string,
): Record<string, unknown> {
  return {
    ...(eventId ? { event_id: eventId } : {}),
    stream_type: 'warehouse',
    stream_id:
      payload['dispatch_order_ids'] instanceof Array
        ? payload['dispatch_order_ids'][0]
        : randomUUID(),
    event_type: 'dispatch.irn_recorded',
    payload,
    metadata: {
      correlation_id: randomUUID(),
      actor: { user_id: actor.userId, role: actor.role, location_id: siteId },
      occurred_at: new Date().toISOString(),
    },
  };
}

async function getIrnCoverage(
  port: number,
  token: string,
  dispatchOrderId: string,
): Promise<HttpResult> {
  return makeRequest(port, 'GET', `/api/v1/dispatch/${dispatchOrderId}/irn`, undefined, {
    Authorization: `Bearer ${token}`,
  });
}

async function dispatchOrder(
  port: number,
  token: string,
  dispatchOrderId: string,
): Promise<HttpResult> {
  return makeRequest(
    port,
    'POST',
    `/api/v1/dispatch/${dispatchOrderId}/dispatch`,
    { dispatchOrderId },
    { Authorization: `Bearer ${token}` },
  );
}

describe('Story 11.2 - IRN-Before-Dispatch Enforcement', () => {
  let server: Server;
  let port: number;
  const run = randomUUID().slice(0, 8);
  const siteId = randomUUID();
  const zoneId = randomUUID();
  const binId = randomUUID();
  let warehouseManager: { userId: string; token: string };
  let warehouseOperator: { userId: string; token: string };

  before(async () => {
    server = createAppServer();
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    port = (server.address() as AddressInfo).port;

    const aisleId = randomUUID();
    const rackId = randomUUID();
    await seedLocation(siteId, `SITE-112-${run}`, 'site', null, siteId);
    await seedLocation(zoneId, `ZONE-112-${run}`, 'zone', siteId, siteId);
    await seedLocation(aisleId, `AISLE-112-${run}`, 'aisle', zoneId, siteId);
    await seedLocation(rackId, `RACK-112-${run}`, 'rack', aisleId, siteId);
    await seedLocation(binId, `BIN-112-${run}`, 'bin', rackId, siteId, 10);

    warehouseManager = await createWarehouseManager(port, siteId);
    warehouseOperator = await createWarehouseOperator(port, siteId);
  });

  after(async () => {
    await closePool();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('AC1: dispatch before the IRN is recorded is refused 409 IRN_MISSING and audited, then succeeds once recorded', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-112-A-${run}`;
    const lotId = randomUUID();
    const quantity = '40';
    const invoiceNumberExt = `INV-112-A-${run}`;
    const irnExt = irnFor(`IRN-112-A-${run}`);

    await seedErpSalesOrder(dispatchOrderId, `SO-112-A-${run}`, sku, quantity, siteId);
    await createLot(`LOT-112-A-${run}`, sku, lotId);
    await seedStock(sku, binId, `LOT-112-A-${run}`, Number(quantity));
    await makeReadyDispatchOrder(
      port,
      warehouseManager.token,
      warehouseOperator.token,
      dispatchOrderId,
      sku,
      lotId,
      quantity,
    );

    // No coverage exists yet: GET /irn 404s and the final dispatch is refused IRN_MISSING.
    const missingGet = await getIrnCoverage(port, warehouseManager.token, dispatchOrderId);
    assert.equal(missingGet.status, 404, missingGet.raw);
    assert.equal(missingGet.body['error_code'], 'DISPATCH_IRN_NOT_RECORDED');

    const refused = await dispatchOrder(port, warehouseManager.token, dispatchOrderId);
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body['error_code'], 'IRN_MISSING');
    assert.equal(
      (refused.body['details'] as Record<string, unknown> | undefined)?.['dispatch_order_id'],
      dispatchOrderId,
    );

    // The refusal leaves an audit row FOR THIS ORDER (scoped, so a row from another run or another
    // file cannot satisfy the assertion), with no event_id because the event never persisted.
    const audit = await getPool().query(
      `SELECT error_code, event_id FROM audit_log
        WHERE error_code = 'IRN_MISSING' AND details->>'dispatch_order_id' = $1`,
      [dispatchOrderId],
    );
    assert.equal(audit.rows.length, 1, 'exactly one IRN_MISSING audit row for this order');
    assert.equal(audit.rows[0]?.['error_code'], 'IRN_MISSING');
    assert.equal(audit.rows[0]?.['event_id'], null);

    // Record the ERP-issued IRN and confirm the block lifts.
    const recorded = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      invoiceNumberExt,
      irnExt,
    );
    assert.equal(recorded.status, 200, recorded.raw);
    assert.deepStrictEqual(recorded.body['coverage'], [dispatchOrderId]);

    const coverage = await getIrnCoverage(port, warehouseManager.token, dispatchOrderId);
    assert.equal(coverage.status, 200, coverage.raw);
    const cov = coverage.body['coverage'] as Record<string, unknown>;
    assert.equal(cov['invoice_number_ext'], invoiceNumberExt);
    assert.equal(cov['irn_ext'], irnExt);
    assert.equal(cov['dispatch_order_id'], dispatchOrderId);

    const success = await dispatchOrder(port, warehouseManager.token, dispatchOrderId);
    assert.equal(success.status, 200, success.raw);

    const status = await getPool().query(
      `SELECT dispatched_at IS NOT NULL AS dispatched FROM dispatch_order_status WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    assert.equal(status.rows[0]?.['dispatched'], true);
  });

  it('AC2a: a multi-line invoice records once with also_covers and dispatches both dispatch orders', async () => {
    // One sales order (one so_number_ext) with two lines; each line is its own dispatch order.
    const soNumberExt = `SO-112-ML-${run}`;
    const line1Id = randomUUID();
    const line2Id = randomUUID();
    const sku1 = `SKU-112-ML1-${run}`;
    const sku2 = `SKU-112-ML2-${run}`;
    const lot1Id = randomUUID();
    const lot2Id = randomUUID();
    const quantity1 = '25';
    const quantity2 = '35';
    const invoiceNumberExt = `INV-112-ML-${run}`;
    const irnExt = irnFor(`IRN-112-ML-${run}`);

    await seedErpSalesOrder(line1Id, soNumberExt, sku1, quantity1, siteId, 1);
    await seedErpSalesOrder(line2Id, soNumberExt, sku2, quantity2, siteId, 2);
    await createLot(`LOT-112-ML1-${run}`, sku1, lot1Id);
    await createLot(`LOT-112-ML2-${run}`, sku2, lot2Id);
    await seedStock(sku1, binId, `LOT-112-ML1-${run}`, Number(quantity1));
    await seedStock(sku2, binId, `LOT-112-ML2-${run}`, Number(quantity2));
    await makeReadyDispatchOrder(
      port,
      warehouseManager.token,
      warehouseOperator.token,
      line1Id,
      sku1,
      lot1Id,
      quantity1,
    );
    await makeReadyDispatchOrder(
      port,
      warehouseManager.token,
      warehouseOperator.token,
      line2Id,
      sku2,
      lot2Id,
      quantity2,
    );

    // One recording covers BOTH lines of the invoice via also_covers.
    const recorded = await recordIrn(
      port,
      warehouseManager.token,
      line1Id,
      invoiceNumberExt,
      irnExt,
      [line2Id],
    );
    assert.equal(recorded.status, 200, recorded.raw);
    assert.deepStrictEqual(recorded.body['coverage'], [line1Id, line2Id]);

    // Both dispatch orders now dispatch without a second recording.
    const d1 = await dispatchOrder(port, warehouseManager.token, line1Id);
    assert.equal(d1.status, 200, d1.raw);
    const d2 = await dispatchOrder(port, warehouseManager.token, line2Id);
    assert.equal(d2.status, 200, d2.raw);
  });

  it('AC2b: a second invoice against the same order covers its own line - a missing IRN on line 2 still blocks', async () => {
    // The same sales order is invoiced twice. Invoice 1 covers line 1 only; line 2 stays uncovered
    // until invoice 2 is recorded against it (this is the arm that fails under an so_number_ext key).
    const soNumberExt = `SO-112-MI-${run}`;
    const line1Id = randomUUID();
    const line2Id = randomUUID();
    const sku1 = `SKU-112-MI1-${run}`;
    const sku2 = `SKU-112-MI2-${run}`;
    const lot1Id = randomUUID();
    const lot2Id = randomUUID();
    const quantity1 = '15';
    const quantity2 = '20';
    const invoice1Ext = `INV-112-MI1-${run}`;
    const invoice2Ext = `INV-112-MI2-${run}`;

    await seedErpSalesOrder(line1Id, soNumberExt, sku1, quantity1, siteId, 1);
    await seedErpSalesOrder(line2Id, soNumberExt, sku2, quantity2, siteId, 2);
    await createLot(`LOT-112-MI1-${run}`, sku1, lot1Id);
    await createLot(`LOT-112-MI2-${run}`, sku2, lot2Id);
    await seedStock(sku1, binId, `LOT-112-MI1-${run}`, Number(quantity1));
    await seedStock(sku2, binId, `LOT-112-MI2-${run}`, Number(quantity2));
    await makeReadyDispatchOrder(
      port,
      warehouseManager.token,
      warehouseOperator.token,
      line1Id,
      sku1,
      lot1Id,
      quantity1,
    );
    await makeReadyDispatchOrder(
      port,
      warehouseManager.token,
      warehouseOperator.token,
      line2Id,
      sku2,
      lot2Id,
      quantity2,
    );

    // Invoice 1 recorded against line 1 ONLY.
    const inv1 = await recordIrn(
      port,
      warehouseManager.token,
      line1Id,
      invoice1Ext,
      irnFor(`IRN-112-MI1-${run}`),
    );
    assert.equal(inv1.status, 200, inv1.raw);

    // Line 1 dispatches; line 2 is STILL blocked IRN_MISSING.
    const d1 = await dispatchOrder(port, warehouseManager.token, line1Id);
    assert.equal(d1.status, 200, d1.raw);
    const blocked = await dispatchOrder(port, warehouseManager.token, line2Id);
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body['error_code'], 'IRN_MISSING');

    // Invoice 2 recorded against line 2 lifts its block.
    const inv2 = await recordIrn(
      port,
      warehouseManager.token,
      line2Id,
      invoice2Ext,
      irnFor(`IRN-112-MI2-${run}`),
    );
    assert.equal(inv2.status, 200, inv2.raw);
    const d2 = await dispatchOrder(port, warehouseManager.token, line2Id);
    assert.equal(d2.status, 200, d2.raw);
  });

  it('AC2: recording a different invoice over covered coverage is 409 DISPATCH_IRN_CONFLICT and does not overwrite; the same invoice with a regenerated IRN supersedes', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-112-C-${run}`;
    const lotId = randomUUID();
    const quantity = '10';
    const irn1 = irnFor(`IRN-112-C1-${run}`);
    const irn1Regenerated = irnFor(`IRN-112-C1-regenerated-${run}`);

    await seedErpSalesOrder(dispatchOrderId, `SO-112-C-${run}`, sku, quantity, siteId);
    await createLot(`LOT-112-C-${run}`, sku, lotId);
    await seedStock(sku, binId, `LOT-112-C-${run}`, Number(quantity));
    await makeReadyDispatchOrder(
      port,
      warehouseManager.token,
      warehouseOperator.token,
      dispatchOrderId,
      sku,
      lotId,
      quantity,
    );

    const first = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      `INV-112-C1-${run}`,
      irn1,
    );
    assert.equal(first.status, 200, first.raw);

    // A second, DIFFERENT invoice against the same dispatch order is a genuine conflict, not a replay.
    const conflict = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      `INV-112-C2-${run}`,
      irnFor(`IRN-112-C2-${run}`),
    );
    assert.equal(conflict.status, 409, conflict.raw);
    assert.equal(conflict.body['error_code'], 'DISPATCH_IRN_CONFLICT');
    const conflictDetails = conflict.body['details'] as Record<string, unknown> | undefined;
    assert.equal(conflictDetails?.['invoice_number_ext'], `INV-112-C2-${run}`);
    assert.equal(conflictDetails?.['existing_invoice_number_ext'], `INV-112-C1-${run}`);

    // The first invoice's coverage is NOT overwritten.
    const coverage = await getIrnCoverage(port, warehouseManager.token, dispatchOrderId);
    assert.equal(coverage.status, 200, coverage.raw);
    assert.equal(
      (coverage.body['coverage'] as Record<string, unknown>)['invoice_number_ext'],
      `INV-112-C1-${run}`,
    );

    // Re-recording the SAME invoice with the SAME IRN is a no-op that succeeds and leaves the row alone.
    const noop = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      `INV-112-C1-${run}`,
      irn1,
    );
    assert.equal(noop.status, 200, noop.raw);
    const afterNoop = await getPool().query(
      `SELECT irn_ext, source_event_id, created_at = updated_at AS untouched FROM dispatch_irn WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    assert.equal(afterNoop.rows[0]?.['irn_ext'], irn1);
    assert.equal(afterNoop.rows[0]?.['source_event_id'], first.body['eventId']);
    assert.equal(afterNoop.rows[0]?.['untouched'], true);

    // Review decision D1: the SAME invoice re-recorded with a DIFFERENT IRN (IRP cancel-and-regenerate)
    // SUPERSEDES the stored IRN in place - not a conflict, not a silent no-op - and stamps the
    // superseding event. The invoice number stays; only the IRN moves.
    const superseded = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      `INV-112-C1-${run}`,
      irn1Regenerated,
    );
    assert.equal(superseded.status, 200, superseded.raw);
    const afterSupersede = await getPool().query(
      `SELECT invoice_number_ext, irn_ext, source_event_id, updated_at > created_at AS moved
         FROM dispatch_irn WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    assert.equal(afterSupersede.rows[0]?.['invoice_number_ext'], `INV-112-C1-${run}`);
    assert.equal(afterSupersede.rows[0]?.['irn_ext'], irn1Regenerated);
    assert.equal(afterSupersede.rows[0]?.['source_event_id'], superseded.body['eventId']);
    assert.equal(afterSupersede.rows[0]?.['moved'], true);
    // Still exactly ONE coverage row: supersession is an UPDATE, never a second row.
    const count = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM dispatch_irn WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    assert.equal(count.rows[0]?.['n'], 1);
  });

  it('AC2 replay: the same idempotency_key on the route and the same event_id on the events door both replay the ONE recording', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-112-R-${run}`;
    const invoiceNumberExt = `INV-112-R-${run}`;
    const irnExt = irnFor(`IRN-112-R-${run}`);
    await seedErpSalesOrder(dispatchOrderId, `SO-112-R-${run}`, sku, '5', siteId);

    // Route door: a client-supplied idempotency_key is REQUIRED (8.7 D8) ...
    const missingKey = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId}/irn`,
      { invoice_number_ext: invoiceNumberExt, irn_ext: irnExt },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );
    assert.equal(missingKey.status, 400, missingKey.raw);
    assert.equal(missingKey.body['error_code'], 'INVALID_PARAMS');

    // ... and replaying it returns the SAME event, appending nothing.
    const key = randomUUID();
    const firstPost = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      invoiceNumberExt,
      irnExt,
      undefined,
      {
        idempotency_key: key,
      },
    );
    assert.equal(firstPost.status, 200, firstPost.raw);
    const replayPost = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      invoiceNumberExt,
      irnExt,
      undefined,
      {
        idempotency_key: key,
      },
    );
    assert.equal(replayPost.status, 200, replayPost.raw);
    assert.equal(replayPost.body['eventId'], firstPost.body['eventId']);
    const routeEvents = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM domain_events WHERE event_type = 'dispatch.irn_recorded' AND stream_id = $1`,
      [dispatchOrderId],
    );
    assert.equal(routeEvents.rows[0]?.['n'], 1, 'a replayed recording appends no second event');

    // Events door: the same event_id posted twice is the persistEvent short-circuit, not a second
    // applier run - the coverage row keeps the FIRST event as its source.
    const doorOrderId = randomUUID();
    await seedErpSalesOrder(doorOrderId, `SO-112-RD-${run}`, `SKU-112-RD-${run}`, '5', siteId);
    const eventId = randomUUID();
    const envelope = irnRecordedEnvelope(
      { userId: warehouseManager.userId, role: 'warehouse_manager' },
      siteId,
      {
        invoice_number_ext: `INV-112-RD-${run}`,
        irn_ext: irnFor(`IRN-112-RD-${run}`),
        dispatch_order_ids: [doorOrderId],
        site_id: siteId,
      },
      eventId,
    );
    const doorFirst = await makeRequest(port, 'POST', '/api/v1/events', envelope, {
      Authorization: `Bearer ${warehouseManager.token}`,
    });
    assert.ok(doorFirst.status >= 200 && doorFirst.status < 300, doorFirst.raw);
    const doorReplay = await makeRequest(port, 'POST', '/api/v1/events', envelope, {
      Authorization: `Bearer ${warehouseManager.token}`,
    });
    assert.ok(doorReplay.status >= 200 && doorReplay.status < 300, doorReplay.raw);
    const doorRow = await getPool().query(
      `SELECT source_event_id, recorded_by FROM dispatch_irn WHERE dispatch_order_id = $1`,
      [doorOrderId],
    );
    assert.equal(doorRow.rows[0]?.['source_event_id'], eventId);
    // recorded_by is the AUTHENTICATED actor, never a payload field.
    assert.equal(doorRow.rows[0]?.['recorded_by'], warehouseManager.userId);
  });

  it('D3 lifecycle: an IRN can be recorded and read BEFORE pick generation, and a closed ERP line refuses recording on both doors', async () => {
    // Pre-pick: only the ERP line exists (no dispatch_order_status row yet). ERP raises the invoice
    // and the IRP the IRN independently of picking, so the desk must be able to record now.
    const prePickId = randomUUID();
    await seedErpSalesOrder(prePickId, `SO-112-PP-${run}`, `SKU-112-PP-${run}`, '5', siteId);
    const prePick = await recordIrn(
      port,
      warehouseManager.token,
      prePickId,
      `INV-112-PP-${run}`,
      irnFor(`IRN-112-PP-${run}`),
    );
    assert.equal(prePick.status, 200, prePick.raw);
    const prePickGet = await getIrnCoverage(port, warehouseManager.token, prePickId);
    assert.equal(prePickGet.status, 200, prePickGet.raw);

    // Closed line: refused DISPATCH_ORDER_CLOSED on the route ...
    const closedId = randomUUID();
    await seedErpSalesOrder(closedId, `SO-112-CL-${run}`, `SKU-112-CL-${run}`, '5', siteId);
    await getPool().query(`UPDATE erp_sales_order SET status = 'closed' WHERE id = $1`, [closedId]);
    const closedRoute = await recordIrn(
      port,
      warehouseManager.token,
      closedId,
      `INV-112-CL-${run}`,
      irnFor(`IRN-112-CL-${run}`),
    );
    assert.equal(closedRoute.status, 409, closedRoute.raw);
    assert.equal(closedRoute.body['error_code'], 'DISPATCH_ORDER_CLOSED');
    // ... and on the events door (the applier enforces it, so the seam refuses too).
    const closedDoor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      irnRecordedEnvelope({ userId: warehouseManager.userId, role: 'warehouse_manager' }, siteId, {
        invoice_number_ext: `INV-112-CL-${run}`,
        irn_ext: irnFor(`IRN-112-CL-${run}`),
        dispatch_order_ids: [closedId],
        site_id: siteId,
      }),
      { Authorization: `Bearer ${warehouseManager.token}` },
    );
    assert.equal(closedDoor.status, 409, closedDoor.raw);
    assert.equal(closedDoor.body['error_code'], 'DISPATCH_ORDER_CLOSED');
    const noRow = await getPool().query(`SELECT 1 FROM dispatch_irn WHERE dispatch_order_id = $1`, [
      closedId,
    ]);
    assert.equal(noRow.rows.length, 0);
  });

  it('Recording is restricted to dispatch roles on BOTH doors, and recorded_by / so_number_ext are refused on input', async () => {
    const dispatchOrderId = randomUUID();
    await seedErpSalesOrder(dispatchOrderId, `SO-112-RB-${run}`, `SKU-112-RB-${run}`, '5', siteId);
    const payload = {
      invoice_number_ext: `INV-112-RB-${run}`,
      irn_ext: irnFor(`IRN-112-RB-${run}`),
      dispatch_order_ids: [dispatchOrderId],
      site_id: siteId,
    };

    // A warehouse_operator holds warehouse WRITE scope at this site, which is all the events door
    // used to check; it must still be refused, exactly as the REST route refuses it.
    const operatorRoute = await recordIrn(
      port,
      warehouseOperator.token,
      dispatchOrderId,
      payload.invoice_number_ext,
      payload.irn_ext,
    );
    assert.equal(operatorRoute.status, 403, operatorRoute.raw);
    const operatorDoor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      irnRecordedEnvelope(
        { userId: warehouseOperator.userId, role: 'warehouse_operator' },
        siteId,
        payload,
      ),
      { Authorization: `Bearer ${warehouseOperator.token}` },
    );
    assert.equal(operatorDoor.status, 403, operatorDoor.raw);
    assert.equal(operatorDoor.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    // A poster-supplied recorded_by is refused by the closed shape (the 9.9 approved_by class).
    const forgedBy = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      irnRecordedEnvelope({ userId: warehouseManager.userId, role: 'warehouse_manager' }, siteId, {
        ...payload,
        recorded_by: warehouseOperator.userId,
      }),
      { Authorization: `Bearer ${warehouseManager.token}` },
    );
    assert.equal(forgedBy.status, 400, forgedBy.raw);
    assert.equal(forgedBy.body['error_code'], 'DISPATCH_IRN_INVALID_PAYLOAD');

    // so_number_ext is server-derived: refused on the route (not silently dropped) and on the door.
    const soOnRoute = await recordIrn(
      port,
      warehouseManager.token,
      dispatchOrderId,
      payload.invoice_number_ext,
      payload.irn_ext,
      undefined,
      { so_number_ext: 'SO-FORGED' },
    );
    assert.equal(soOnRoute.status, 400, soOnRoute.raw);
    assert.equal(soOnRoute.body['error_code'], 'INVALID_PARAMS');
    const soOnDoor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      irnRecordedEnvelope({ userId: warehouseManager.userId, role: 'warehouse_manager' }, siteId, {
        ...payload,
        so_number_ext: 'SO-FORGED',
      }),
      { Authorization: `Bearer ${warehouseManager.token}` },
    );
    assert.equal(soOnDoor.status, 400, soOnDoor.raw);
    assert.equal(soOnDoor.body['error_code'], 'DISPATCH_IRN_INVALID_PAYLOAD');

    // Nothing above wrote a row.
    const rows = await getPool().query(`SELECT 1 FROM dispatch_irn WHERE dispatch_order_id = $1`, [
      dispatchOrderId,
    ]);
    assert.equal(rows.rows.length, 0);
  });

  it('Input shape: the IRN must be 64 hex characters, irp_acknowledged_at must be a real past instant, and a mixed-case path id normalises', async () => {
    const dispatchOrderId = randomUUID();
    await seedErpSalesOrder(dispatchOrderId, `SO-112-SH-${run}`, `SKU-112-SH-${run}`, '5', siteId);
    const goodIrn = irnFor(`IRN-112-SH-${run}`);

    for (const badIrn of [
      'x',
      `IRN-112-SH-${run}`,
      goodIrn.slice(0, 63),
      `${goodIrn}0`,
      'g'.repeat(64),
    ]) {
      const r = await recordIrn(
        port,
        warehouseManager.token,
        dispatchOrderId,
        `INV-112-SH-${run}`,
        badIrn,
      );
      assert.equal(r.status, 400, `irn_ext ${badIrn} should be refused: ${r.raw}`);
      assert.equal(r.body['error_code'], 'INVALID_PARAMS');
    }
    // Date.parse('March') and Date.parse('1') are NOT NaN in V8; both must still be refused, as must
    // an acknowledgement in the future.
    for (const badTs of ['March', '1', new Date(Date.now() + 3_600_000).toISOString()]) {
      const r = await recordIrn(
        port,
        warehouseManager.token,
        dispatchOrderId,
        `INV-112-SH-${run}`,
        goodIrn,
        undefined,
        {
          irp_acknowledged_at: badTs,
        },
      );
      assert.equal(r.status, 400, `irp_acknowledged_at ${badTs} should be refused: ${r.raw}`);
      assert.equal(r.body['error_code'], 'INVALID_PARAMS');
    }

    // Upper-case IRN and upper-case path UUID both normalise: stored lower-case, coverage list
    // lower-case, and the same request in canonical case is the same-invoice no-op.
    const upper = await makeRequest(
      port,
      'POST',
      `/api/v1/dispatch/${dispatchOrderId.toUpperCase()}/irn`,
      {
        idempotency_key: randomUUID(),
        invoice_number_ext: `INV-112-SH-${run}`,
        irn_ext: goodIrn.toUpperCase(),
        irp_acknowledged_at: new Date(Date.now() - 60_000).toISOString(),
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );
    assert.equal(upper.status, 200, upper.raw);
    assert.deepStrictEqual(upper.body['coverage'], [dispatchOrderId]);
    const stored = await getPool().query(
      `SELECT irn_ext, irp_acknowledged_at FROM dispatch_irn WHERE dispatch_order_id = $1`,
      [dispatchOrderId],
    );
    assert.equal(stored.rows[0]?.['irn_ext'], goodIrn);
    assert.ok(stored.rows[0]?.['irp_acknowledged_at'] !== null);
  });

  it('AC1: a direct POST /api/v1/events dispatch.dispatched meets the identical IRN wall, and an erp.*-shaped event is 405', async () => {
    const dispatchOrderId = randomUUID();
    const sku = `SKU-112-D-${run}`;
    const lotId = randomUUID();
    const quantity = '30';

    await seedErpSalesOrder(dispatchOrderId, `SO-112-D-${run}`, sku, quantity, siteId);
    await createLot(`LOT-112-D-${run}`, sku, lotId);
    await seedStock(sku, binId, `LOT-112-D-${run}`, Number(quantity));
    await makeReadyDispatchOrder(
      port,
      warehouseManager.token,
      warehouseOperator.token,
      dispatchOrderId,
      sku,
      lotId,
      quantity,
    );

    // Direct events door: no route-level pre-check exists here, so the refusal must come from the
    // applier inside the transaction (the Story 9.8 seam lesson).
    const direct = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'warehouse',
        stream_id: dispatchOrderId,
        event_type: 'dispatch.dispatched',
        payload: { dispatch_order_id: dispatchOrderId },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: warehouseManager.userId,
            role: 'warehouse_manager',
            location_id: siteId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );
    assert.equal(direct.status, 409, direct.raw);
    assert.equal(direct.body['error_code'], 'IRN_MISSING');

    // The applier-self-audit row survives the event rollback on THIS door too (Task 5.2), scoped to
    // this order so no other arm's row can satisfy it.
    const doorAudit = await getPool().query(
      `SELECT event_id FROM audit_log WHERE error_code = 'IRN_MISSING' AND details->>'dispatch_order_id' = $1`,
      [dispatchOrderId],
    );
    assert.equal(
      doorAudit.rows.length,
      1,
      'exactly one IRN_MISSING audit row for the door refusal',
    );
    assert.equal(doorAudit.rows[0]?.['event_id'], null);

    // erp.*-shaped attempts are refused 405 by assertErpReadOnly before any applier runs.
    const erpShaped = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'warehouse',
        stream_id: dispatchOrderId,
        event_type: 'erp.sales_order_synced',
        payload: { id: dispatchOrderId },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: warehouseManager.userId,
            role: 'warehouse_manager',
            location_id: siteId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      { Authorization: `Bearer ${warehouseManager.token}` },
    );
    assert.equal(erpShaped.status, 405, erpShaped.raw);
  });

  it('7.3 unit arms: dispatchIsEInvoiceable is true for every ERP line (a blank so_number_ext is not an exemption) and the irn_ext CHECK pins the 64-hex shape', async () => {
    const { dispatchIsEInvoiceable, isValidIrpAcknowledgedAt, IRN_EXT_REGEX } =
      await import('../../src/compliance/dispatch.js');

    // Binding decision 4: EVERY erp_sales_order-backed supply is e-invoiceable. A line with a blank
    // so_number_ext (a sync defect) is still e-invoiceable - the wall must not open on bad data. The
    // null case no longer reaches the predicate: the applier fails CLOSED (IRN_MISSING) before it.
    assert.equal(dispatchIsEInvoiceable({ so_number_ext: 'SO-112-U-1', status: 'open' }), true);
    assert.equal(dispatchIsEInvoiceable({ so_number_ext: '', status: 'open' }), true);
    assert.equal(dispatchIsEInvoiceable({ so_number_ext: '   ', status: 'closed' }), true);

    // The IRN shape and the timestamp rule, as pure functions.
    assert.equal(IRN_EXT_REGEX.test(irnFor('x')), true);
    assert.equal(IRN_EXT_REGEX.test(irnFor('x').toUpperCase()), true);
    assert.equal(IRN_EXT_REGEX.test('IRN-005'), false);
    const fixedNow = Date.parse('2026-09-09T00:00:00Z');
    assert.equal(isValidIrpAcknowledgedAt('2026-09-08T23:59:59Z', fixedNow), true);
    assert.equal(isValidIrpAcknowledgedAt('2026-09-08T23:59:59.123+05:30', fixedNow), true);
    assert.equal(isValidIrpAcknowledgedAt('2026-09-09T00:04:59Z', fixedNow), true); // inside skew
    assert.equal(isValidIrpAcknowledgedAt('2026-09-09T00:05:01Z', fixedNow), false); // future
    assert.equal(isValidIrpAcknowledgedAt('March', fixedNow), false);
    assert.equal(isValidIrpAcknowledgedAt('1', fixedNow), false);
    assert.equal(isValidIrpAcknowledgedAt('2026-09-08', fixedNow), false); // date only
    assert.equal(isValidIrpAcknowledgedAt(null, fixedNow), false);

    // The chk_dispatch_irn_present CHECK constraint refuses a blank AND a non-hex irn_ext (Task 1.3
    // plus decision D2). The shape assert refuses both earlier on either door, but this arm proves
    // the DB constraint itself is live.
    const irnId = randomUUID();
    await seedErpSalesOrder(irnId, `SO-112-U-${run}`, `SKU-112-U-${run}`, '5', siteId);
    for (const badIrn of ['   ', `IRN-112-U-${run}`, irnFor('upper').toUpperCase()]) {
      await assert.rejects(
        getPool().query(
          `INSERT INTO dispatch_irn
             (dispatch_order_id, invoice_number_ext, irn_ext, so_number_ext, site_id, recorded_by, source_event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            irnId,
            `INV-112-U-${run}`,
            badIrn,
            `SO-112-U-${run}`,
            siteId,
            warehouseManager.userId,
            randomUUID(),
          ],
        ),
        (err: unknown) =>
          (err as { code?: string; constraint?: string }).code === '23514' &&
          (err as { constraint?: string }).constraint === 'chk_dispatch_irn_present',
        `irn_ext ${JSON.stringify(badIrn)} must fail the CHECK`,
      );
    }
  });

  it('7.1 arm: a job-work dispatch is unaffected - jobwork.output_dispatched never meets the IRN wall', async () => {
    // Story 9.4's job-work dispatch seam is a DIFFERENT applier (jobwork-dispatch.ts) that shares
    // nothing with applyDispatchDispatchedProjection. The STRUCTURAL guarantee is that the job-work
    // seam never calls the IRN gate helper: pin that at source level so a future "reuse" of
    // dispatchGateIrnMissing there fails this arm instead of silently extending the wall.
    const jobworkSeam = readFileSync(
      new URL('../../src/compliance/jobwork-dispatch.ts', import.meta.url),
      'utf8',
    );
    assert.equal(
      jobworkSeam.includes('dispatchGateIrnMissing'),
      false,
      'jobwork-dispatch.ts must not call the IRN gate helper',
    );
    assert.equal(
      jobworkSeam.includes('dispatchIrnPresent'),
      false,
      'jobwork-dispatch.ts must not read dispatch_irn',
    );

    // Behavioural arm: a jobwork.output_dispatched for an unknown order, posted by a caller who CAN
    // reach the job-work seam, is refused by that seam's own source-document rule - the EXACT code
    // is asserted, so an unrelated failure (a module refusal, or a leaked IRN_MISSING) cannot pass
    // as "unaffected". The previous form of this arm asserted only "not IRN_MISSING" and was
    // satisfied by MODULE_ACCESS_DENIED (code review 2026-09-09).
    const jobworkCoordinator = await createJobworkCoordinator(port, siteId);
    const orderId = randomUUID();
    const outputId = randomUUID();
    const result = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.output_dispatched',
        payload: {
          service_order_id: orderId,
          dispatch_id: outputId,
          lot_id: randomUUID(),
          dispatched_quantity: '1.000',
          uom: 'KG',
          site_id: siteId,
          dispatched_by: jobworkCoordinator.userId,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: jobworkCoordinator.userId,
            role: 'jobwork_coordinator',
            location_id: siteId,
          },
          occurred_at: new Date().toISOString(),
        },
      },
      { Authorization: `Bearer ${jobworkCoordinator.token}` },
    );
    assert.equal(result.body['error_code'], 'SOURCE_DOCUMENT_REQUIRED', result.raw);
  });
});

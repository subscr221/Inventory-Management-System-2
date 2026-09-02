import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { transitionServiceOrder } from '../../src/compliance/service-order.js';
import type { ServiceOrderRow } from '../../src/read/projections/service_order.js';

/**
 * Story 9.1 Job-Work Service Order Creation (FR-JW-01, FR-JW-02, FR-B-16, FR-AC-13).
 * Real PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run
 * serially; every identifier is run-scoped. Fixture writes use the admin pool (app_user lacks
 * DELETE). The harness scaffolding is a deliberate local re-implementation of the story-8-7
 * closures, which are not exported (never import cross-story).
 */

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

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
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
    req.setTimeout(60000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

describe('Story 9.1 Job-Work Service Order Creation', () => {
  let server: Server;
  let port: number;

  let coordinatorUserId: string;
  let coordinatorHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let deniedHeaders: Record<string, string>;

  let siteAId: string;
  let siteBId: string;
  let kitBomId: string;
  let productionBomId: string;
  let siteAWriteHeaders: Record<string, string>;

  async function seedLocation(level: string, code: string): Promise<string> {
    const locationId = randomUUID();
    const r = await getAdminPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, $3, NULL, $1, 'general', 'ambient', 'active') RETURNING location_id`,
      [locationId, code, level],
    );
    return r.rows[0]!['location_id'] as string;
  }

  /** Story 5.6 machinery is referenced, not rebuilt: the BOM row is seeded directly. */
  async function seedBom(bomType: 'production' | 'job_work_kit'): Promise<string> {
    const bomId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO bom (bom_id, parent_item_id, parent_sku, parent_uom, business_stream, bom_type, status, created_by, source_event_id)
       VALUES ($1, $2, $3, 'EA', 'job_work', $4, 'released', $5, $6)`,
      [
        bomId,
        randomUUID(),
        `KIT-9-1-${run}-${randomUUID().slice(0, 6)}`,
        bomType,
        coordinatorUserId,
        randomUUID(),
      ],
    );
    return bomId;
  }

  function orderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      site_id: siteAId,
      customer_party_code: `CUST-9-1-${run.toUpperCase()}`,
      customer_name: 'Acme Fabrication Pvt Ltd',
      spec_reference_ext: `SPEC-${run}`,
      promised_start_date: '2026-10-01',
      promised_delivery_date: '2026-11-15',
      price_basis: { basis_type: 'per_piece', rate: 42.5, currency: 'INR' },
      kit_bom_id: kitBomId,
      idempotency_key: randomUUID(),
      ...overrides,
    };
  }

  async function createOrder(
    overrides: Record<string, unknown> = {},
    headers = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', '/api/v1/service-orders', orderPayload(overrides), headers);
  }

  function orderOf(res: HttpResult): ServiceOrderRow {
    const order = res.body['service_order'];
    assert.ok(order, `no service_order in response: ${JSON.stringify(res.body)}`);
    return order as ServiceOrderRow;
  }

  async function createdOrderId(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await createOrder(overrides);
    assert.strictEqual(res.status, 201, `create failed: ${JSON.stringify(res.body)}`);
    return orderOf(res).service_order_id;
  }

  async function confirmOrder(
    serviceOrderId: string,
    body: Record<string, unknown> = {},
    headers = coordinatorHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/service-orders/${serviceOrderId}/confirm`,
      { idempotency_key: randomUUID(), ...body },
      headers,
    );
  }

  /** AC1 now requires kit_bom_id + price_basis at create; AC3's confirm-without-them refusal
   * path is reached by creating a full draft then clearing the field via PATCH. */
  async function clearField(serviceOrderId: string, field: 'kit_bom_id' | 'price_basis') {
    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${serviceOrderId}`,
      { [field]: null, idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 200, `clearing ${field} failed: ${JSON.stringify(res.body)}`);
  }

  async function rowOf(serviceOrderId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT * FROM service_order WHERE service_order_id = $1`,
      [serviceOrderId],
    );
    assert.strictEqual(r.rows.length, 1, `no service_order row for ${serviceOrderId}`);
    return r.rows[0] as Record<string, unknown>;
  }

  async function auditCount(errorCode: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM audit_log WHERE error_code = $1`,
      [errorCode],
    );
    return r.rows[0]!['n'] as number;
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
      '../../read/projections/bom.sql',
      '../../read/projections/service_order.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE service_order, bom, location_register, item_master, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-9-1-${run}`);
    siteBId = await seedLocation('site', `SITE-B-9-1-${run}`);

    coordinatorUserId = await provisionUser(port, `jw-coordinator-9-1-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId: '*' },
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: '*' },
      // The foreign-stream rejection arm posts to /api/v1/events on the 'qc' stream, whose RBAC
      // module gate answers before the envelope assert can; the grant lets the assert be reached.
      { role: 'jobwork_coordinator', module: 'qc', functionScope: 'write', locationId: '*' },
    ]);
    coordinatorHeaders = await authFor(port, `jw-coordinator-9-1-${run}@example.com`);

    await provisionUser(port, `jw-reader-9-1-${run}@example.com`, [
      { role: 'jobwork_reader', module: 'jobwork', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `jw-reader-9-1-${run}@example.com`);

    await provisionUser(port, `jw-denied-9-1-${run}@example.com`, [
      { role: 'warehouse_operator', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    deniedHeaders = await authFor(port, `jw-denied-9-1-${run}@example.com`);

    await provisionUser(port, `jw-sitea-writer-9-1-${run}@example.com`, [
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'write', locationId: siteAId },
      { role: 'jobwork_coordinator', module: 'jobwork', functionScope: 'read', locationId: siteAId },
    ]);
    siteAWriteHeaders = await authFor(port, `jw-sitea-writer-9-1-${run}@example.com`);

    kitBomId = await seedBom('job_work_kit');
    productionBomId = await seedBom('production');
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: draft creation
  // -------------------------------------------------------------------------

  it('AC1: creates a draft order with customer, spec reference, dates, price basis, and kit BOM link', async () => {
    const res = await createOrder();
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const order = orderOf(res);
    assert.strictEqual(order.status, 'draft');
    assert.strictEqual(order.kit_bom_id, kitBomId);
    assert.strictEqual(order.customer_party_code, `CUST-9-1-${run.toUpperCase()}`);
    assert.strictEqual(order.customer_name, 'Acme Fabrication Pvt Ltd');
    assert.strictEqual(order.spec_reference_ext, `SPEC-${run}`);
    assert.strictEqual(order.business_stream, 'job_work');
    assert.strictEqual(order.site_id, siteAId);
    assert.match(order.order_number_ext, /^SO-\d{4}-\d{4,}$/);
    assert.strictEqual(order.created_by, coordinatorUserId);
    assert.deepStrictEqual(order.price_basis, {
      basis_type: 'per_piece',
      rate: 42.5,
      currency: 'INR',
    });
    // The domain event is the replayable source (event-sourced projection).
    const events = await getAdminPool().query(
      `SELECT event_type, stream_type, payload FROM domain_events WHERE stream_id = $1`,
      [order.service_order_id],
    );
    assert.strictEqual(events.rows.length, 1);
    assert.strictEqual(events.rows[0]!['event_type'], 'jobwork.order_created');
    assert.strictEqual(events.rows[0]!['stream_type'], 'jobwork');
  });

  it('AC1: create without a kit BOM or price basis refuses (both are required at creation)', async () => {
    const noBom = await createOrder({ kit_bom_id: undefined });
    assert.strictEqual(noBom.status, 400, JSON.stringify(noBom.body));
    assert.strictEqual(noBom.body['error_code'], 'INVALID_PARAMS');

    const noBasis = await createOrder({ price_basis: undefined });
    assert.strictEqual(noBasis.status, 400, JSON.stringify(noBasis.body));
    assert.strictEqual(noBasis.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1 create replay: the same idempotency key returns the same order with 200, no second row', async () => {
    const key = randomUUID();
    const first = await createOrder({ idempotency_key: key });
    assert.strictEqual(first.status, 201);
    const firstOrder = orderOf(first);
    const replay = await createOrder({ idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(orderOf(replay).service_order_id, firstOrder.service_order_id);
    const count = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM service_order WHERE order_number_ext = $1`,
      [firstOrder.order_number_ext],
    );
    assert.strictEqual(count.rows[0]!['n'], 1);
  });

  it('AC1 referential guard: a kit_bom_id that is not a job_work_kit BOM refuses; a missing BOM 404s', async () => {
    const wrongType = await createOrder({ kit_bom_id: productionBomId });
    assert.strictEqual(wrongType.status, 409, JSON.stringify(wrongType.body));
    assert.strictEqual(wrongType.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(wrongType.body)['bom_type'], 'production');

    const missing = await createOrder({ kit_bom_id: randomUUID() });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'BOM_NOT_FOUND');
  });

  it('AC1 shape guards: bad party code, bad dates, bad price basis, server-derived fields, missing idempotency key', async () => {
    const badParty = await createOrder({ customer_party_code: 'bad lower case' });
    assert.strictEqual(badParty.status, 400);
    assert.strictEqual(badParty.body['error_code'], 'INVALID_PARAMS');

    const badDates = await createOrder({
      promised_start_date: '2026-11-15',
      promised_delivery_date: '2026-10-01',
    });
    assert.strictEqual(badDates.status, 400);

    const badBasis = await createOrder({
      price_basis: { basis_type: 'per_tonne', rate: 5, currency: 'INR' },
    });
    assert.strictEqual(badBasis.status, 400);

    const derived = await createOrder({ order_number_ext: 'SO-2026-9999' });
    assert.strictEqual(derived.status, 400);

    const statusField = await createOrder({ status: 'confirmed' });
    assert.strictEqual(statusField.status, 400);

    const noKey = await createOrder({ idempotency_key: undefined });
    assert.strictEqual(noKey.status, 400);
    assert.strictEqual(detailsOf(noKey.body)['field'], 'idempotency_key');

    const badSite = await createOrder({ site_id: randomUUID() });
    assert.strictEqual(badSite.status, 404);
    assert.strictEqual(badSite.body['error_code'], 'LOCATION_NOT_FOUND');
  });

  it('RBAC: a user without the jobwork module cannot create or read; reader cannot write', async () => {
    const denied = await createOrder({}, deniedHeaders);
    assert.strictEqual(denied.status, 403);

    const readerWrite = await createOrder({}, readerHeaders);
    assert.strictEqual(readerWrite.status, 403);

    const orderId = await createdOrderId();
    const readerRead = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(readerRead.status, 200);
    const deniedRead = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${orderId}`,
      undefined,
      deniedHeaders,
    );
    assert.strictEqual(deniedRead.status, 403);
  });

  it('[Review] site-scoped write access: a site-A-only writer cannot create, update, or confirm a site-B order', async () => {
    const crossSiteCreate = await createOrder({ site_id: siteBId }, siteAWriteHeaders);
    assert.strictEqual(crossSiteCreate.status, 403, JSON.stringify(crossSiteCreate.body));
    assert.strictEqual(crossSiteCreate.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const siteBOrderId = await createdOrderId({ site_id: siteBId });
    const crossSiteUpdate = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${siteBOrderId}`,
      { customer_name: 'Hijacked', idempotency_key: randomUUID() },
      siteAWriteHeaders,
    );
    assert.strictEqual(crossSiteUpdate.status, 403, JSON.stringify(crossSiteUpdate.body));
    assert.strictEqual(crossSiteUpdate.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const crossSiteConfirm = await confirmOrder(siteBOrderId, {}, siteAWriteHeaders);
    assert.strictEqual(crossSiteConfirm.status, 403, JSON.stringify(crossSiteConfirm.body));
    assert.strictEqual(crossSiteConfirm.body['error_code'], 'LOCATION_ACCESS_DENIED');

    // A same-site writer is unaffected.
    const sameSiteOrderId = await createdOrderId({ site_id: siteAId });
    const sameSiteUpdate = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${sameSiteOrderId}`,
      { customer_name: 'Fine', idempotency_key: randomUUID() },
      siteAWriteHeaders,
    );
    assert.strictEqual(sameSiteUpdate.status, 200, JSON.stringify(sameSiteUpdate.body));
  });

  it('[Review] GET-by-id: unauthorized-site read and truly-missing order both 404 identically', async () => {
    const siteBOrderId = await createdOrderId({ site_id: siteBId });
    const denied = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${siteBOrderId}`,
      undefined,
      siteAWriteHeaders,
    );
    assert.strictEqual(denied.status, 404);
    assert.strictEqual(denied.body['error_code'], 'SERVICE_ORDER_NOT_FOUND');

    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders/${randomUUID()}`,
      undefined,
      siteAWriteHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'SERVICE_ORDER_NOT_FOUND');
  });

  it('[Review] business_stream and site-level guards on a direct POST /api/v1/events (bypassing REST field-stripping)', async () => {
    const badStream = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: randomUUID(),
        event_type: 'jobwork.order_created',
        payload: {
          service_order_id: randomUUID(),
          site_id: siteAId,
          business_stream: 'production',
          customer_party_code: `CUST-9-1-BAD-${run.toUpperCase()}`,
          customer_name: 'Acme',
          kit_bom_id: kitBomId,
          price_basis: { basis_type: 'per_piece', rate: 1, currency: 'INR' },
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(badStream.status, 400, JSON.stringify(badStream.body));
    assert.strictEqual(badStream.body['error_code'], 'INVALID_PARAMS');

    const nonSiteLocation = await seedLocation('zone', `ZONE-9-1-${run}`);
    const badLevel = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: randomUUID(),
        event_type: 'jobwork.order_created',
        payload: {
          service_order_id: randomUUID(),
          site_id: nonSiteLocation,
          business_stream: 'job_work',
          customer_party_code: `CUST-9-1-BAD2-${run.toUpperCase()}`,
          customer_name: 'Acme',
          kit_bom_id: kitBomId,
          price_basis: { basis_type: 'per_piece', rate: 1, currency: 'INR' },
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(badLevel.status, 404, JSON.stringify(badLevel.body));
    assert.strictEqual(badLevel.body['error_code'], 'LOCATION_NOT_FOUND');
  });

  it('[Review] price_basis.currency must be a 3-letter code; unknown payload keys refuse', async () => {
    const badCurrency = await createOrder({
      price_basis: { basis_type: 'per_piece', rate: 1, currency: 'not-a-currency' },
    });
    assert.strictEqual(badCurrency.status, 400, JSON.stringify(badCurrency.body));

    const extraKey = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: randomUUID(),
        event_type: 'jobwork.order_created',
        payload: {
          service_order_id: randomUUID(),
          site_id: siteAId,
          business_stream: 'job_work',
          customer_party_code: `CUST-9-1-BAD3-${run.toUpperCase()}`,
          customer_name: 'Acme',
          kit_bom_id: kitBomId,
          price_basis: { basis_type: 'per_piece', rate: 1, currency: 'INR' },
          not_a_real_field: 'sneaky',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(extraKey.status, 400, JSON.stringify(extraKey.body));
    assert.strictEqual(extraKey.body['error_code'], 'INVALID_PARAMS');
  });

  it('[Review] update refuses when only one promised date is changed but it inverts the pair', async () => {
    const orderId = await createdOrderId({
      promised_start_date: '2026-10-01',
      promised_delivery_date: '2026-11-15',
    });
    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${orderId}`,
      { promised_delivery_date: '2026-01-01', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // AC 2: confirm transition, attributed
  // -------------------------------------------------------------------------

  it('AC2: confirm transitions draft -> confirmed with attribution recorded', async () => {
    const orderId = await createdOrderId();
    const res = await confirmOrder(orderId);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const order = orderOf(res);
    assert.strictEqual(order.status, 'confirmed');
    assert.strictEqual(order.confirmed_by, coordinatorUserId);
    assert.ok(order.confirmed_at, 'confirmed_at must be stamped');
    // The transition is recorded as its own attributed domain event (AC 2 "each transition
    // recorded and attributed").
    const events = await getAdminPool().query(
      `SELECT event_type, metadata FROM domain_events WHERE stream_id = $1 ORDER BY event_version`,
      [orderId],
    );
    assert.deepStrictEqual(
      events.rows.map((r) => r['event_type']),
      ['jobwork.order_created', 'jobwork.order_confirmed'],
    );
    const meta = events.rows[1]!['metadata'] as { actor: { user_id: string } };
    assert.strictEqual(meta.actor.user_id, coordinatorUserId);
  });

  it('AC2: optional offcut_election is persisted on confirm (BSD-6), and its vocabulary is enforced', async () => {
    const orderId = await createdOrderId();
    const bad = await confirmOrder(orderId, { offcut_election: 'sell_it' });
    assert.strictEqual(bad.status, 400);

    const res = await confirmOrder(orderId, { offcut_election: 'retain_and_buy' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(orderOf(res).offcut_election, 'retain_and_buy');
    assert.strictEqual((await rowOf(orderId))['offcut_election'], 'retain_and_buy');
  });

  it('AC2: idempotent replay of confirm - same key returns the stored result, no second transition', async () => {
    const orderId = await createdOrderId();
    const key = randomUUID();
    const first = await confirmOrder(orderId, { idempotency_key: key });
    assert.strictEqual(first.status, 200);
    const confirmedAt = (await rowOf(orderId))['confirmed_at'];

    const replay = await confirmOrder(orderId, { idempotency_key: key });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.deepStrictEqual((await rowOf(orderId))['confirmed_at'], confirmedAt);
    const events = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE stream_id = $1 AND event_type = 'jobwork.order_confirmed'`,
      [orderId],
    );
    assert.strictEqual(events.rows[0]!['n'], 1);
  });

  // -------------------------------------------------------------------------
  // AC 3: out-of-sequence and missing-precondition refusals
  // -------------------------------------------------------------------------

  it('AC3: confirm refuses without a linked kit BOM (INVALID_STATE_TRANSITION, audited)', async () => {
    const orderId = await createdOrderId();
    await clearField(orderId, 'kit_bom_id');
    const auditBefore = await auditCount('INVALID_STATE_TRANSITION');
    const res = await confirmOrder(orderId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual(detailsOf(res.body)['has_kit_bom'], false);
    assert.strictEqual((await rowOf(orderId))['status'], 'draft');
    // BSD-5: the refusal is in this route file's AUDITED_REJECTIONS set.
    assert.strictEqual(await auditCount('INVALID_STATE_TRANSITION'), auditBefore + 1);
  });

  it('AC3: confirm refuses without a price basis (INVALID_STATE_TRANSITION)', async () => {
    const orderId = await createdOrderId();
    await clearField(orderId, 'price_basis');
    const res = await confirmOrder(orderId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual(detailsOf(res.body)['has_price_basis'], false);
    assert.strictEqual((await rowOf(orderId))['status'], 'draft');
  });

  it('AC3: double-confirm refuses with INVALID_STATE_TRANSITION', async () => {
    const orderId = await createdOrderId();
    const first = await confirmOrder(orderId);
    assert.strictEqual(first.status, 200);
    const second = await confirmOrder(orderId);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'INVALID_STATE_TRANSITION');
  });

  it('AC3 (BSD-2): draft -> closed refuses at the applier level; confirmed -> in_process works; draft -> in_process refuses', async () => {
    const orderId = await createdOrderId();
    const client = await getPool().connect();
    try {
      // draft -> closed (the AC 3 example) refuses, gate marker or not.
      for (const closureGatePassed of [undefined, true]) {
        await client.query('BEGIN');
        await assert.rejects(
          transitionServiceOrder(
            orderId,
            'closed',
            {
              occurredAt: new Date().toISOString(),
              actorUserId: coordinatorUserId,
              ...(closureGatePassed !== undefined && { closureGatePassed }),
            },
            client,
          ),
          (err: { errorCode?: string; statusCode?: number }) => {
            assert.strictEqual(err.errorCode, 'INVALID_STATE_TRANSITION');
            assert.strictEqual(err.statusCode, 409);
            return true;
          },
        );
        await client.query('ROLLBACK');
      }

      // draft -> in_process refuses (only Story 9.2's receipt on a confirmed order fires it).
      await client.query('BEGIN');
      await assert.rejects(
        transitionServiceOrder(
          orderId,
          'in_process',
          { occurredAt: new Date().toISOString(), actorUserId: coordinatorUserId },
          client,
        ),
        (err: { errorCode?: string }) => err.errorCode === 'INVALID_STATE_TRANSITION',
      );
      await client.query('ROLLBACK');

      const confirm = await confirmOrder(orderId);
      assert.strictEqual(confirm.status, 200);

      // confirmed -> in_process is the 9.2 seam and works.
      await client.query('BEGIN');
      await transitionServiceOrder(
        orderId,
        'in_process',
        { occurredAt: new Date().toISOString(), actorUserId: coordinatorUserId },
        client,
      );
      await client.query('COMMIT');
      assert.strictEqual((await rowOf(orderId))['status'], 'in_process');

      // in_process -> closed still refuses without the 9.5 closure-gate marker.
      await client.query('BEGIN');
      await assert.rejects(
        transitionServiceOrder(
          orderId,
          'closed',
          { occurredAt: new Date().toISOString(), actorUserId: coordinatorUserId },
          client,
        ),
        (err: { errorCode?: string }) => err.errorCode === 'INVALID_STATE_TRANSITION',
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('AC3: a direct POST /api/v1/events cannot bypass the confirm gate (seam re-derives under lock)', async () => {
    const orderId = await createdOrderId();
    await clearField(orderId, 'kit_bom_id');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'jobwork',
        stream_id: orderId,
        event_type: 'jobwork.order_confirmed',
        payload: { service_order_id: orderId },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual((await rowOf(orderId))['status'], 'draft');
  });

  it('AC3: a jobwork.* event on a foreign stream is rejected before any applier can ignore it', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'qc',
        stream_id: randomUUID(),
        event_type: 'jobwork.order_confirmed',
        payload: { service_order_id: randomUUID() },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: coordinatorUserId, role: 'jobwork_coordinator', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_EVENT_ENVELOPE');
  });

  // -------------------------------------------------------------------------
  // AC 4: attributed edit log
  // -------------------------------------------------------------------------

  it('AC4: PATCH updates draft fields, emits jobwork.order_updated with the changed fields, and the edit log attributes it', async () => {
    const orderId = await createdOrderId();
    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${orderId}`,
      {
        customer_name: 'Acme Fabrication Pvt Ltd (renamed)',
        promised_delivery_date: '2026-12-01',
        idempotency_key: randomUUID(),
      },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const order = orderOf(res);
    assert.strictEqual(order.customer_name, 'Acme Fabrication Pvt Ltd (renamed)');
    // DATE columns round-trip through pg as local-midnight Date objects; compare in SQL.
    const dateRow = await getAdminPool().query(
      `SELECT to_char(promised_delivery_date, 'YYYY-MM-DD') AS d FROM service_order WHERE service_order_id = $1`,
      [orderId],
    );
    assert.strictEqual(dateRow.rows[0]!['d'], '2026-12-01');

    // BSD-9: attribution is event-sourced (changed-field payload)...
    const events = await getAdminPool().query(
      `SELECT event_id, payload, metadata FROM domain_events WHERE stream_id = $1 AND event_type = 'jobwork.order_updated'`,
      [orderId],
    );
    assert.strictEqual(events.rows.length, 1);
    const payload = events.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['customer_name'], 'Acme Fabrication Pvt Ltd (renamed)');
    assert.strictEqual(payload['promised_delivery_date'], '2026-12-01');
    assert.strictEqual(payload['customer_party_code'], undefined);
    const meta = events.rows[0]!['metadata'] as { actor: { user_id: string } };
    assert.strictEqual(meta.actor.user_id, coordinatorUserId);

    // ...and rides the non-disableable Story 1.3 statutory edit log (FR-AC-13) with the actor
    // and trace id.
    const audit = await getAdminPool().query(
      `SELECT user_id, trace_id, endpoint FROM audit_log WHERE event_id = $1`,
      [events.rows[0]!['event_id']],
    );
    assert.strictEqual(audit.rows.length, 1, 'the update must land one audit_log row');
    assert.strictEqual(audit.rows[0]!['user_id'], coordinatorUserId);
    assert.ok(audit.rows[0]!['trace_id'], 'audit row carries the trace id');
    assert.ok(String(audit.rows[0]!['endpoint']).includes(`/api/v1/service-orders/${orderId}`));
  });

  it('AC4/open question 2: PATCH on a confirmed order refuses with INVALID_STATE_TRANSITION', async () => {
    const orderId = await createdOrderId();
    const confirm = await confirmOrder(orderId);
    assert.strictEqual(confirm.status, 200);
    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${orderId}`,
      { customer_name: 'Too late', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_STATE_TRANSITION');
    assert.strictEqual((await rowOf(orderId))['customer_name'], 'Acme Fabrication Pvt Ltd');
  });

  it('PATCH guards: unknown order 404s, empty change set 400s, unaccepted fields refuse', async () => {
    const missing = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${randomUUID()}`,
      { customer_name: 'X', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body['error_code'], 'SERVICE_ORDER_NOT_FOUND');

    const orderId = await createdOrderId();
    const empty = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${orderId}`,
      { idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(empty.status, 400, JSON.stringify(empty.body));

    const siteChange = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${orderId}`,
      { site_id: randomUUID(), idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(siteChange.status, 400);

    const offcut = await makeRequest(
      port,
      'PATCH',
      `/api/v1/service-orders/${orderId}`,
      { offcut_election: 'return', idempotency_key: randomUUID() },
      coordinatorHeaders,
    );
    assert.strictEqual(offcut.status, 400);
  });

  it('list: site-scoped listing returns the run orders and filters by status', async () => {
    const orderId = await createdOrderId();
    const all = await makeRequest(
      port,
      'GET',
      `/api/v1/service-orders?site_id=${siteAId}&status=draft`,
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(all.status, 200);
    const orders = all.body['service_orders'] as ServiceOrderRow[];
    assert.ok(orders.some((o) => o.service_order_id === orderId));
    assert.ok(orders.every((o) => o.status === 'draft'));

    const badStatus = await makeRequest(
      port,
      'GET',
      '/api/v1/service-orders?status=cancelled',
      undefined,
      coordinatorHeaders,
    );
    assert.strictEqual(badStatus.status, 400);
  });
});

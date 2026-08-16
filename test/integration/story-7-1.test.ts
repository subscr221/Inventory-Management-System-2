import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.1: Asset Register and Criticality Classification (FR-M-01, AD-9). Runs against the
// PRODUCTION router surface (createAppRouter) with real auth, RBAC, and PostgreSQL - no mocks of
// the DB or the event store. The harness is the Story 4.2 pattern trimmed to the maintenance
// module's actual dependencies: the asset register consumes no upstream fixtures.

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
    req.setTimeout(15000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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

describe('Story 7.1 Asset Register and Criticality Classification Integration Tests', () => {
  let server: Server;
  let port: number;
  const siteAId = randomUUID();

  let maintainerHeaders: Record<string, string>;
  let maintainerId: string;
  let readerHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;

  function assetBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      asset_tag: `TAG-${randomUUID().slice(0, 12)}`,
      asset_name: `Two-Tonne Mould ${run}`,
      criticality_class: 'critical',
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
      '../../read/projections/asset.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE asset, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    maintainerId = await provisionUser(port, `maintainer-7-1-${run}@example.com`, [
      {
        role: 'maintenance_manager_7_1',
        module: 'maintenance',
        functionScope: 'write',
        locationId: '*',
      },
    ]);
    maintainerHeaders = await authFor(port, `maintainer-7-1-${run}@example.com`);

    await provisionUser(port, `reader-7-1-${run}@example.com`, [
      {
        role: 'maintenance_reader_7_1',
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    readerHeaders = await authFor(port, `reader-7-1-${run}@example.com`);

    await provisionUser(port, `outsider-7-1-${run}@example.com`, [
      {
        role: 'warehouse_worker_7_1',
        module: 'warehouse',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    outsiderHeaders = await authFor(port, `outsider-7-1-${run}@example.com`);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: registration creates a single record with criticality class + tag
  // -------------------------------------------------------------------------

  it('AC1: registers an asset with all fields and reads it back by id and list', async () => {
    const tag = `TAG-MOULD-${run}`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({
        asset_tag: tag,
        serial_number: `SER-MOULD-${run}`,
        manufacturer: 'Bharat Moulds',
        model: 'BM-2000',
      }),
      maintainerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body['event_id'], 'response must carry the persisted event_id');
    const asset = res.body['asset'] as Record<string, unknown>;
    assert.ok(asset, 'response must carry the read-back asset row');
    assert.ok(asset['asset_id'], 'asset_id must be server-minted');
    assert.strictEqual(asset['asset_tag'], tag);
    assert.strictEqual(asset['criticality_class'], 'critical');
    assert.strictEqual(asset['serial_number'], `SER-MOULD-${run}`);
    assert.strictEqual(asset['created_by'], maintainerId);

    const getRes = await makeRequest(
      port,
      'GET',
      `/api/v1/assets/${asset['asset_id']}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(getRes.status, 200, JSON.stringify(getRes.body));
    assert.strictEqual((getRes.body['asset'] as Record<string, unknown>)['asset_tag'], tag);

    const listRes = await makeRequest(port, 'GET', '/api/v1/assets', undefined, readerHeaders);
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    const listed = (listRes.body['assets'] as Record<string, unknown>[]).map((a) => a['asset_id']);
    assert.ok(listed.includes(asset['asset_id']), 'list must include the registered asset');
  });

  it('AC1: registers a low-criticality non-serialized asset (hub screwdriver) and filters by criticality_class', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({
        asset_name: `Hub Screwdriver ${run}`,
        criticality_class: 'low',
      }),
      maintainerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const asset = res.body['asset'] as Record<string, unknown>;
    assert.strictEqual(asset['criticality_class'], 'low');
    assert.strictEqual(asset['serial_number'], null);

    const filtered = await makeRequest(
      port,
      'GET',
      '/api/v1/assets?criticality_class=low',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(filtered.status, 200, JSON.stringify(filtered.body));
    const rows = filtered.body['assets'] as Record<string, unknown>[];
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.strictEqual(row['criticality_class'], 'low');
    }
    const ids = rows.map((r) => r['asset_id']);
    assert.ok(ids.includes(asset['asset_id']));
  });

  it('AC1: rejects a criticality_class outside the vocabulary with INVALID_PARAMS', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ criticality_class: 'catastrophic' }),
      maintainerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: rejects a missing asset_tag with INVALID_PARAMS', async () => {
    const body = assetBody();
    delete body['asset_tag'];
    const res = await makeRequest(port, 'POST', '/api/v1/assets', body, maintainerHeaders);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_PARAMS');
  });

  it('AC1: unknown assetId returns 404 ASSET_NOT_FOUND', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/assets/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'ASSET_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // AC 2: optional fixed_asset_ref free identifier, no lookup
  // -------------------------------------------------------------------------

  it('AC2: persists fixed_asset_ref verbatim with no lookup (a non-existent reference succeeds)', async () => {
    const ref = `FA-DOES-NOT-EXIST-${run}`;
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ fixed_asset_ref: ref }),
      maintainerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const asset = res.body['asset'] as Record<string, unknown>;
    assert.strictEqual(asset['fixed_asset_ref'], ref);
  });

  it('AC2: fixed_asset_ref may be omitted and stores NULL', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/assets', assetBody(), maintainerHeaders);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((res.body['asset'] as Record<string, unknown>)['fixed_asset_ref'], null);

    const nullRes = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ fixed_asset_ref: null }),
      maintainerHeaders,
    );
    assert.strictEqual(nullRes.status, 201, JSON.stringify(nullRes.body));
    assert.strictEqual((nullRes.body['asset'] as Record<string, unknown>)['fixed_asset_ref'], null);
  });

  // -------------------------------------------------------------------------
  // AC 3: duplicate detection - DUPLICATE_ASSET
  // -------------------------------------------------------------------------

  it('AC3: a second registration with the same serial_number returns 409 DUPLICATE_ASSET with existing_asset_id', async () => {
    const serial = `S-1-${run}`;
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ serial_number: serial }),
      maintainerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstId = (first.body['asset'] as Record<string, unknown>)['asset_id'];

    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ serial_number: serial }),
      maintainerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_ASSET');
    const details = second.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['existing_asset_id'], firstId);
  });

  it('AC3: a duplicate asset_tag (different serial) returns 409 DUPLICATE_ASSET', async () => {
    const tag = `TAG-DUP-${run}`;
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ asset_tag: tag, serial_number: `S-TAG-A-${run}` }),
      maintainerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ asset_tag: tag, serial_number: `S-TAG-B-${run}` }),
      maintainerHeaders,
    );
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'DUPLICATE_ASSET');
    assert.ok(
      (second.body['details'] as Record<string, unknown>)['existing_asset_id'],
      'tag collision must carry existing_asset_id',
    );
  });

  it('AC3: two non-serialized assets with the same manufacturer/model both register (serial-only duplicate detection)', async () => {
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({
        asset_name: `Identical Screwdriver A ${run}`,
        criticality_class: 'low',
        manufacturer: 'Taparia',
        model: 'SD-10',
      }),
      maintainerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({
        asset_name: `Identical Screwdriver B ${run}`,
        criticality_class: 'low',
        manufacturer: 'Taparia',
        model: 'SD-10',
      }),
      maintainerHeaders,
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.notStrictEqual(
      (first.body['asset'] as Record<string, unknown>)['asset_id'],
      (second.body['asset'] as Record<string, unknown>)['asset_id'],
    );
  });

  // -------------------------------------------------------------------------
  // Seam and platform guardrails
  // -------------------------------------------------------------------------

  it('direct POST /api/v1/events with a well-formed asset.registered envelope returns 400 INVALID_EVENT_STREAM', async () => {
    const assetId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'maintenance',
        stream_id: assetId,
        event_type: 'asset.registered',
        payload: {
          asset_id: assetId,
          asset_tag: `TAG-DIRECT-${run}`,
          asset_name: 'Fabricated Asset',
          criticality_class: 'high',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: {
            user_id: maintainerId,
            role: 'maintenance_manager_7_1',
            location_id: '00000000-0000-0000-0000-000000000000',
          },
          occurred_at: new Date().toISOString(),
        },
      },
      maintainerHeaders,
    );
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'INVALID_EVENT_STREAM');
  });

  it('RBAC: a non-maintenance user is denied with 403 on every route', async () => {
    // The existing RBAC middleware distinguishes the two denial axes: a user outside the
    // maintenance module gets MODULE_ACCESS_DENIED; a maintenance user with the wrong
    // functionScope gets FUNCTION_ACCESS_DENIED (covered by the read-scope test below).
    const post = await makeRequest(port, 'POST', '/api/v1/assets', assetBody(), outsiderHeaders);
    assert.strictEqual(post.status, 403, JSON.stringify(post.body));
    assert.strictEqual(post.body['error_code'], 'MODULE_ACCESS_DENIED');

    const list = await makeRequest(port, 'GET', '/api/v1/assets', undefined, outsiderHeaders);
    assert.strictEqual(list.status, 403, JSON.stringify(list.body));
    assert.strictEqual(list.body['error_code'], 'MODULE_ACCESS_DENIED');

    const get = await makeRequest(
      port,
      'GET',
      `/api/v1/assets/${randomUUID()}`,
      undefined,
      outsiderHeaders,
    );
    assert.strictEqual(get.status, 403, JSON.stringify(get.body));
    assert.strictEqual(get.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('RBAC: a read-scoped maintenance user cannot register an asset', async () => {
    const res = await makeRequest(port, 'POST', '/api/v1/assets', assetBody(), readerHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'FUNCTION_ACCESS_DENIED');
  });

  it('idempotent replay with the same idempotency_key returns the original asset and persists exactly one row', async () => {
    const idempotencyKey = randomUUID();
    const body = assetBody({
      serial_number: `S-IDEM-${run}`,
      idempotency_key: idempotencyKey,
    });
    const first = await makeRequest(port, 'POST', '/api/v1/assets', body, maintainerHeaders);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstAsset = first.body['asset'] as Record<string, unknown>;

    const replay = await makeRequest(port, 'POST', '/api/v1/assets', body, maintainerHeaders);
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    const replayAsset = replay.body['asset'] as Record<string, unknown>;
    assert.strictEqual(replayAsset['asset_id'], firstAsset['asset_id']);

    const count = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM asset WHERE serial_number = $1`,
      [`S-IDEM-${run}`],
    );
    assert.strictEqual((count.rows[0] as { n: number }).n, 1);

    const events = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    assert.strictEqual((events.rows[0] as { n: number }).n, 1);
  });

  // -------------------------------------------------------------------------
  // Code review 2026-08-16 regression tests
  // -------------------------------------------------------------------------

  it('review: a case-variant serial duplicate returns 409 DUPLICATE_ASSET with existing_asset_id', async () => {
    const serial = `S-CASE-${run}`;
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ serial_number: serial }),
      maintainerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const firstId = (first.body['asset'] as Record<string, unknown>)['asset_id'];

    const variant = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ serial_number: serial.toLowerCase() }),
      maintainerHeaders,
    );
    assert.strictEqual(variant.status, 409, JSON.stringify(variant.body));
    assert.strictEqual(variant.body['error_code'], 'DUPLICATE_ASSET');
    const details = variant.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['existing_asset_id'], firstId);
  });

  it('review: a case-variant asset_tag duplicate returns 409 DUPLICATE_ASSET', async () => {
    const tag = `TAG-CASE-${run}`;
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ asset_tag: tag, serial_number: `S-CASE-TAG-A-${run}` }),
      maintainerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const variant = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ asset_tag: tag.toLowerCase(), serial_number: `S-CASE-TAG-B-${run}` }),
      maintainerHeaders,
    );
    assert.strictEqual(variant.status, 409, JSON.stringify(variant.body));
    assert.strictEqual(variant.body['error_code'], 'DUPLICATE_ASSET');
    assert.ok(
      (variant.body['details'] as Record<string, unknown>)['existing_asset_id'],
      'case-variant tag collision must carry existing_asset_id',
    );
  });

  it('review: a blank idempotency_key does not collapse two distinct registrations into one', async () => {
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ serial_number: `S-BLANK-A-${run}`, idempotency_key: '' }),
      maintainerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));

    const second = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ serial_number: `S-BLANK-B-${run}`, idempotency_key: '' }),
      maintainerHeaders,
    );
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    assert.notStrictEqual(
      (first.body['asset'] as Record<string, unknown>)['asset_id'],
      (second.body['asset'] as Record<string, unknown>)['asset_id'],
      'two blank-key registrations must create two distinct assets',
    );
  });

  it('review: an idempotency key reused from a different event returns 409 DUPLICATE_EVENT, never a phantom 201', async () => {
    const foreignEventId = randomUUID();
    const foreignKey = randomUUID();
    const streamId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO domain_events (event_id, stream_type, stream_id, event_type, event_version, payload, metadata, schema_version, idempotency_key)
       VALUES ($1, 'procurement', $2, 'supplier.registered', 1, $3, $4, 1, $5)`,
      [
        foreignEventId,
        streamId,
        JSON.stringify({ supplier_id: randomUUID(), supplier_name: 'Foreign Event' }),
        JSON.stringify({
          correlation_id: randomUUID(),
          actor: {
            user_id: maintainerId,
            role: 'maintenance_manager_7_1',
            location_id: '00000000-0000-0000-0000-000000000000',
          },
          occurred_at: new Date().toISOString(),
        }),
        foreignKey,
      ],
    );

    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({ idempotency_key: foreignKey }),
      maintainerHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'DUPLICATE_EVENT');
    const details = res.body['details'] as Record<string, unknown>;
    assert.strictEqual(details['existing_event_id'], foreignEventId);
    assert.strictEqual(details['existing_event_type'], 'supplier.registered');
  });

  it('review: nullable capture fields are normalized in the persisted payload exactly as stored', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      assetBody({
        serial_number: '  S-PADDED-7-1  ',
        manufacturer: '  Acme ',
        model: ' M-1 ',
      }),
      maintainerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const asset = res.body['asset'] as Record<string, unknown>;
    assert.strictEqual(asset['serial_number'], 'S-PADDED-7-1');
    assert.strictEqual(asset['manufacturer'], 'Acme');
    assert.strictEqual(asset['model'], 'M-1');

    const event = await getAdminPool().query(
      `SELECT payload FROM domain_events WHERE event_id = $1`,
      [res.body['event_id']],
    );
    const payload = (event.rows[0] as { payload: Record<string, unknown> }).payload;
    assert.strictEqual(payload['serial_number'], 'S-PADDED-7-1');
    assert.strictEqual(payload['manufacturer'], 'Acme');
    assert.strictEqual(payload['model'], 'M-1');
  });
});

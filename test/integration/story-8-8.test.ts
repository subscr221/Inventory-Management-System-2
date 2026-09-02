import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { applyDispatchShippingDocumentsGeneratedProjection } from '../../src/compliance/dispatch.js';
import { AppError } from '../../src/middleware/error.js';

/**
 * Story 8.8 Witnessed Inspections and Prototype Stock Rules (FR-Q-15, FR-Q-12). Real PostgreSQL,
 * the real production router, SCIM provisioning and dev-token auth.
 *
 * The harness is bootstrapped from story-8-5.test.ts rather than story-8-7.test.ts: 8.5 is the
 * governed-hold story and already carries the dispatch fixture tables AC 1 needs (the Story 3.7
 * gate is exercised by calling its applier against seeded packing fixtures inside a rolled-back
 * transaction, exactly the surface the production event path invokes), plus the same
 * makeRequest/authFor/provisionUser helpers and DOA seeding shape 8.7 uses.
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

describe('Story 8.8 Witnessed Inspections and Prototype Stock Rules', () => {
  let server: Server;
  let port: number;

  let qcHeadUserId: string;
  let qcHeadHeaders: Record<string, string>;
  let raiserUserId: string;
  let raiserHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let engineerUserId: string;
  let engineerHeaders: Record<string, string>;
  let qualityHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;

  let siteAId: string;
  let binA1Id: string;
  let siteBId: string;
  let waiverDoaEntryId: string;
  let fgSku: string;

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function seedLocation(
    level: string,
    code: string,
    parentId: string | null,
    siteId: string | null,
  ): Promise<string> {
    const locationId = randomUUID();
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::uuid IS NULL THEN $1 ELSE $5::uuid END, 'general', 'ambient', 'active') RETURNING location_id`,
      [locationId, code, level, parentId, siteId],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function createItem(sku: string): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/items',
      {
        sku,
        description: `Story 8.8 item ${sku}`,
        valuation_method: 'fifo',
        uom: 'EA',
        business_stream: 'production',
        category: 'raw_materials',
        lot_controlled: true,
        standard_cost_designation: 'ind_as_2_para_21_measurement_technique',
        standard_cost_amount: 10,
      },
      engineerHeaders,
    );
    assert.strictEqual(res.status, 201, `item ${sku} failed: ${JSON.stringify(res.body)}`);
    return (res.body as Record<string, string>)['item_id']!;
  }

  let lotCounter = 0;
  /** A lot + owned stock + trace row WITHOUT a QC task: an ungoverned lot is still holdable. */
  async function plainLot(
    sku: string = fgSku,
    quantity: string = '10.000000',
    locationId: string = binA1Id,
  ): Promise<{ lotId: string; lotNumber: string }> {
    lotCounter += 1;
    const lotId = randomUUID();
    const lotNumber = `FG-LOT-8-8-${run}-${lotCounter}`;
    await getPool().query(
      `INSERT INTO lot_master (lot_id, lot_number, sku, quality_hold_status) VALUES ($1, $2, $3, 'none')`,
      [lotId, lotNumber, sku],
    );
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, lot_id, stock_class, on_hand) VALUES ($1, $2, $3, 'owned', $4::numeric)`,
      [sku, locationId, lotNumber, quantity],
    );
    await getPool().query(
      `INSERT INTO lot_trace (lot_id, event_id, event_type, sku, location_id, location_code, quantity_change, business_stream)
       VALUES ($1, $2, 'stock.received', $3, $4, NULL, $5::numeric, 'production')`,
      [lotId, randomUUID(), sku, locationId, quantity],
    );
    return { lotId, lotNumber };
  }

  async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  async function lotRow(lotId: string): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(`SELECT * FROM lot_master WHERE lot_id = $1`, [lotId]);
    return r.rows[0] as Record<string, unknown>;
  }

  function stockEnvelope(
    eventType: string,
    payload: Record<string, unknown>,
    extra: { idempotency_key?: string } = {},
  ): Record<string, unknown> {
    return {
      stream_type: 'inventory',
      stream_id: randomUUID(),
      event_type: eventType,
      payload: { business_stream: 'production', ...payload },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: engineerUserId, role: 'inventory_controller', location_id: binA1Id },
        occurred_at: new Date().toISOString(),
      },
      ...(extra.idempotency_key ? { idempotency_key: extra.idempotency_key } : {}),
    };
  }

  async function postStockEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/events',
      stockEnvelope(eventType, payload),
      engineerHeaders,
    );
  }

  async function withRolledBackClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Story 8.8 command helpers
  // -------------------------------------------------------------------------

  async function raiseHoldPoint(
    lotNumber: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = raiserHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/qc/witness-hold-points',
      {
        lot_number: lotNumber,
        sku: fgSku,
        inspection_type: 'customer_witnessed',
        hold_reason: 'Story 8.8 witnessed inspection pending',
        idempotency_key: randomUUID(),
        ...extra,
      },
      headers,
    );
  }

  async function recordNotice(
    holdPointId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = raiserHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/witness-hold-points/${holdPointId}/notices`,
      {
        recipient: 'Customer QA - Acme Ltd',
        notice_date: '2026-09-01',
        method: 'email',
        idempotency_key: randomUUID(),
        ...extra,
      },
      headers,
    );
  }

  // Code review 2026-09-02: sign-off now carries the raiser-cannot-sign-off SoD, so the default
  // signer is the qc_head (distinct from the raiser), keeping the guard out of the happy path.
  async function signOff(
    holdPointId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = qcHeadHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/witness-hold-points/${holdPointId}/sign-off`,
      {
        sign_off_note: 'Witness attended and accepted',
        idempotency_key: randomUUID(),
        ...extra,
      },
      headers,
    );
  }

  async function waive(
    holdPointId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = qcHeadHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/qc/witness-hold-points/${holdPointId}/waive`,
      {
        waiver_reason: 'Customer declined to attend; waiver approved under DOA',
        idempotency_key: randomUUID(),
        ...extra,
      },
      headers,
    );
  }

  /** Raises a hold point and returns its id, asserting the 201. */
  async function openHoldPoint(lotNumber: string): Promise<string> {
    const res = await raiseHoldPoint(lotNumber);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['hold_point'] as Record<string, unknown>)['hold_point_id'] as string;
  }

  /**
   * The Story 3.7 dispatch gate over seeded packing fixtures - the REAL enforcement path, not a
   * flag assertion. Returns the error code, or null when the dispatch was allowed.
   */
  async function dispatchGateCode(lotId: string, sku: string): Promise<string | null> {
    const dispatchOrderId = randomUUID();
    await getPool().query(
      `INSERT INTO dispatch_order_status (dispatch_order_id, picked_at, picked_by, packed_at)
       VALUES ($1, now(), $2, now())`,
      [dispatchOrderId, engineerUserId],
    );
    await getPool().query(
      `INSERT INTO packing_record (packing_record_id, dispatch_order_id, sku, packed_qty, lot_id, carton_count, packed_by)
       VALUES ($1, $2, $3, 5, $4, 1, $5)`,
      [randomUUID(), dispatchOrderId, sku, lotId, engineerUserId],
    );
    return withRolledBackClient(async (client) => {
      try {
        await applyDispatchShippingDocumentsGeneratedProjection(
          {
            payload: { dispatch_order_id: dispatchOrderId, document_types: ['bol'] },
            metadata: {
              correlation_id: randomUUID(),
              actor: { user_id: engineerUserId, role: 'dispatcher', location_id: siteAId },
              occurred_at: new Date().toISOString(),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          client,
          randomUUID(),
        );
        return null;
      } catch (err) {
        if (err instanceof AppError) return err.errorCode;
        throw err;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

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
      '../../read/projections/inventory_valuation.sql',
      '../../read/projections/inspection_plan.sql',
      '../../read/projections/inspection_plan_version.sql',
      '../../read/projections/inspection_plan_characteristic.sql',
      '../../read/projections/inspection_plan_approval.sql',
      '../../read/projections/qc_inspection_task.sql',
      '../../read/projections/qc_deviation.sql',
      '../../read/projections/qc_lot_disposition.sql',
      '../../read/projections/qc_sampling_plan.sql',
      '../../read/projections/qc_inspection_result.sql',
      '../../read/projections/qc_sampling_switching_state.sql',
      '../../read/projections/qc_lot_split.sql',
      '../../read/projections/qc_ncr.sql',
      // The dispatch-path fixture tables: erp_sales_order and pick_task come first
      // (dispatch_order_status lives in pick_task.sql; packing_record.sql ALTERs it).
      '../../read/projections/erp_sales_order.sql',
      '../../read/projections/pick_task.sql',
      '../../read/projections/packing_record.sql',
      '../../read/projections/dispatch_document.sql',
      '../../read/projections/qc_batch_release.sql',
      '../../read/projections/qc_retention_sample.sql',
      '../../read/projections/qc_quality_hold.sql',
      '../../read/projections/qc_capa.sql',
      // Story 8.8: the two new projections.
      '../../read/projections/qc_witness_hold_point.sql',
      '../../read/projections/qc_witness_notice.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE qc_witness_notice, qc_witness_hold_point, qc_capa, qc_quality_hold, qc_retention_sample, qc_batch_release, dispatch_document, packing_record, dispatch_order_status, pick_task, erp_sales_order, qc_ncr, qc_lot_split, qc_sampling_switching_state, qc_inspection_result, qc_sampling_plan, qc_lot_disposition, qc_deviation, qc_inspection_task, inspection_plan_approval, inspection_plan_characteristic, inspection_plan_version, inspection_plan, inventory_valuation, lot_trace, serial_master, lot_master, stock_balance, item_master, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    siteAId = await seedLocation('site', `SITE-A-8-8-${run}`, null, null);
    binA1Id = await seedLocation('bin', `BIN-A1-8-8-${run}`, siteAId, siteAId);
    siteBId = await seedLocation('site', `SITE-B-8-8-${run}`, null, null);

    // The DOA-resolved waiver approver. Never raises the hold points it waives, so the BSD-8 SoD
    // guard stays out of the happy path.
    qcHeadUserId = await provisionUser(port, `qc-head-8-8-${run}@example.com`, [
      { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    qcHeadHeaders = await authFor(port, `qc-head-8-8-${run}@example.com`);

    raiserUserId = await provisionUser(port, `qc-raiser-8-8-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    raiserHeaders = await authFor(port, `qc-raiser-8-8-${run}@example.com`);

    // Read-only QC scope: the list AND get-by-id read proof.
    await provisionUser(port, `qc-reader-8-8-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `qc-reader-8-8-${run}@example.com`);

    engineerUserId = await provisionUser(port, `engineer-8-8-${run}@example.com`, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: '*',
      },
      { role: 'inventory_controller', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    engineerHeaders = await authFor(port, `engineer-8-8-${run}@example.com`);

    // The Story 2.3 legacy 'quality' module surface: the independent ad hoc containment used by
    // the BSD-4 regression.
    await provisionUser(port, `quality-officer-8-8-${run}@example.com`, [
      { role: 'quality_officer', module: 'quality', functionScope: 'write', locationId: '*' },
    ]);
    qualityHeaders = await authFor(port, `quality-officer-8-8-${run}@example.com`);

    // No qc module grants at all: the RBAC negative.
    await provisionUser(port, `outsider-8-8-${run}@example.com`, [
      { role: 'inventory_controller', module: 'inventory', functionScope: 'read', locationId: '*' },
    ]);
    outsiderHeaders = await authFor(port, `outsider-8-8-${run}@example.com`);

    waiverDoaEntryId = randomUUID();
    await getPool().query(
      `INSERT INTO doa_registry_entries (entry_id, role, transaction_type, value_min, value_max, active)
       VALUES ($1, 'qc_head', 'qc.witnessed_inspection_waiver', NULL, NULL, true)`,
      [waiverDoaEntryId],
    );

    fgSku = `FG-8-8-${run}`;
    await createItem(fgSku);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC1: the hold point holds the lot through the REAL dispatch gate
  // -------------------------------------------------------------------------

  it('AC1: raising a hold point places the governed hold and the Story 3.7 dispatch gate refuses LOT_ON_HOLD', async () => {
    const lot = await plainLot();
    assert.strictEqual(
      await dispatchGateCode(lot.lotId, fgSku),
      null,
      'lot blocked before the hold point',
    );

    const holdPointId = await openHoldPoint(lot.lotNumber);

    // The hold point IS a governed qc_quality_hold plus the ONE enforcement flag (BSD-2).
    assert.strictEqual(
      await countRows('qc_quality_hold', `lot_id = $1 AND status = 'open'`, [lot.lotId]),
      1,
    );
    const row = await lotRow(lot.lotId);
    assert.strictEqual(row['quality_hold_status'], 'held');
    assert.strictEqual(row['quality_hold_reason'], 'Story 8.8 witnessed inspection pending');
    assert.strictEqual(
      await countRows('lot_trace', `lot_id = $1 AND event_type = 'qc.witness_hold_point_raised'`, [
        lot.lotId,
      ]),
      1,
    );

    // The acceptance criterion: dispatch is refused by the EXISTING gate, unchanged.
    assert.strictEqual(await dispatchGateCode(lot.lotId, fgSku), 'LOT_ON_HOLD');

    // BSD-2 corollary: the Story 2.3 ad hoc clear route still refuses to lift it.
    const adHocClear = await makeRequest(
      port,
      'DELETE',
      `/api/v1/lots/${lot.lotNumber}/quality-hold`,
      undefined,
      qualityHeaders,
    );
    assert.strictEqual(adHocClear.status, 409, JSON.stringify(adHocClear.body));
    assert.strictEqual(adHocClear.body['error_code'], 'QUALITY_HOLD_GOVERNED');

    assert.strictEqual(holdPointId.length, 36);
  });

  it('AC1: sign-off releases the hold and the same dispatch then succeeds', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);
    const notice = await recordNotice(holdPointId);
    assert.strictEqual(notice.status, 201, JSON.stringify(notice.body));
    assert.strictEqual(await dispatchGateCode(lot.lotId, fgSku), 'LOT_ON_HOLD');

    const res = await signOff(holdPointId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((res.body['hold_point'] as Record<string, unknown>)['status'], 'signed_off');

    const row = await lotRow(lot.lotId);
    assert.strictEqual(row['quality_hold_status'], 'none');
    assert.strictEqual(
      await countRows('qc_quality_hold', `lot_id = $1 AND status = 'released'`, [lot.lotId]),
      1,
    );
    assert.strictEqual(await dispatchGateCode(lot.lotId, fgSku), null);
  });

  it('AC1: a DOA-approved waiver releases the hold and the same dispatch then succeeds', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);
    assert.strictEqual(await dispatchGateCode(lot.lotId, fgSku), 'LOT_ON_HOLD');

    const res = await waive(holdPointId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const holdPoint = res.body['hold_point'] as Record<string, unknown>;
    assert.strictEqual(holdPoint['status'], 'waived');
    assert.strictEqual(holdPoint['waiver_doa_entry_id'], waiverDoaEntryId);
    assert.strictEqual(holdPoint['closed_by'], qcHeadUserId);

    assert.strictEqual((await lotRow(lot.lotId))['quality_hold_status'], 'none');
    assert.strictEqual(await dispatchGateCode(lot.lotId, fgSku), null);
  });

  // -------------------------------------------------------------------------
  // BSD-4: the hold-bypass class three prior reviews each found
  // -------------------------------------------------------------------------

  it('BSD-4: sign-off does NOT lift an independent containment it does not own', async () => {
    const lot = await plainLot();
    // An INDEPENDENT containment, placed first and owning the flag reason.
    const adHoc = await makeRequest(
      port,
      'PUT',
      `/api/v1/lots/${lot.lotNumber}/quality-hold`,
      { hold_reason: 'Independent containment 8.8' },
      qualityHeaders,
    );
    assert.strictEqual(adHoc.status, 200, JSON.stringify(adHoc.body));

    const holdPointId = await openHoldPoint(lot.lotNumber);
    // The pre-existing reason is PRESERVED, so the witness hold point does not own the flag.
    assert.strictEqual(
      (await lotRow(lot.lotId))['quality_hold_reason'],
      'Independent containment 8.8',
    );

    const notice = await recordNotice(holdPointId);
    assert.strictEqual(notice.status, 201, JSON.stringify(notice.body));
    const res = await signOff(holdPointId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    // The witness hold point closed, but the lot is STILL held and dispatch is STILL refused.
    const row = await lotRow(lot.lotId);
    assert.strictEqual(row['quality_hold_status'], 'held');
    assert.strictEqual(row['quality_hold_reason'], 'Independent containment 8.8');
    assert.strictEqual(await dispatchGateCode(lot.lotId, fgSku), 'LOT_ON_HOLD');
  });

  it('BSD-4: a waiver does NOT lift an independent containment either', async () => {
    const lot = await plainLot();
    const adHoc = await makeRequest(
      port,
      'PUT',
      `/api/v1/lots/${lot.lotNumber}/quality-hold`,
      { hold_reason: 'Independent containment 8.8 waiver arm' },
      qualityHeaders,
    );
    assert.strictEqual(adHoc.status, 200, JSON.stringify(adHoc.body));
    const holdPointId = await openHoldPoint(lot.lotNumber);

    const res = await waive(holdPointId);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual((await lotRow(lot.lotId))['quality_hold_status'], 'held');
    assert.strictEqual(await dispatchGateCode(lot.lotId, fgSku), 'LOT_ON_HOLD');
  });

  // -------------------------------------------------------------------------
  // AC2: the notice is evidence, and it is required before a sign-off
  // -------------------------------------------------------------------------

  it('AC2: a notice records recipient, date and method and reads back as evidence', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);
    const res = await recordNotice(holdPointId, {
      recipient: 'Third-party inspector - Bureau X',
      notice_date: '2026-08-30',
      method: 'letter',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const read = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/witness-hold-points/${holdPointId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(read.status, 200, JSON.stringify(read.body));
    const notices = read.body['notices'] as Array<Record<string, unknown>>;
    assert.strictEqual(notices.length, 1);
    assert.strictEqual(notices[0]!['recipient'], 'Third-party inspector - Bureau X');
    assert.strictEqual(notices[0]!['notice_date'], '2026-08-30');
    assert.strictEqual(notices[0]!['method'], 'letter');
    assert.strictEqual(notices[0]!['recorded_by'], raiserUserId);
  });

  it('AC2/BSD-6: sign-off with zero notices is refused, but a waiver with zero notices succeeds', async () => {
    const noNotice = await plainLot();
    const holdPointA = await openHoldPoint(noNotice.lotNumber);
    const refused = await signOff(holdPointA);
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body['error_code'], 'WITNESS_NOTICE_REQUIRED');
    assert.strictEqual(detailsOf(refused.body)['notice_count'], 0);
    // Refused means nothing moved: the hold point is still open and the lot still held.
    assert.strictEqual((await lotRow(noNotice.lotId))['quality_hold_status'], 'held');

    // The waiver is deliberately exempt (a waiver exists for the case where notice could not be
    // given), so it closes the SAME zero-notice hold point.
    const waived = await waive(holdPointA);
    assert.strictEqual(waived.status, 201, JSON.stringify(waived.body));
    assert.strictEqual((waived.body['hold_point'] as Record<string, unknown>)['status'], 'waived');
  });

  // -------------------------------------------------------------------------
  // AC3: prototype stock is structurally barred from sellable status
  // -------------------------------------------------------------------------

  it('AC3: prototype stock cannot be allocated and cannot be laundered into owned stock', async () => {
    // Epic 2 data only - no QC fixtures.
    const lotNumber = `PROTO-LOT-8-8-${run}`;
    const receipt = await postStockEvent('stock.received', {
      sku: fgSku,
      target_location_id: binA1Id,
      quantity: 25,
      lot_id: lotNumber,
      stock_class: 'prototype',
    });
    assert.strictEqual(receipt.status, 201, JSON.stringify(receipt.body));
    assert.strictEqual(
      await countRows('stock_balance', `sku = $1 AND lot_id = $2 AND stock_class = 'prototype'`, [
        fgSku,
        lotNumber,
      ]),
      1,
    );

    const allocate = await postStockEvent('stock.allocated', {
      sku: fgSku,
      target_location_id: binA1Id,
      quantity: 5,
      lot_id: lotNumber,
      stock_class: 'prototype',
    });
    assert.strictEqual(allocate.status, 400, JSON.stringify(allocate.body));
    assert.strictEqual(allocate.body['error_code'], 'PROTOTYPE_NOT_SALEABLE');

    // BSD-11 second arm: an owned write over the same grain would launder the stock.
    const ownedReceipt = await postStockEvent('stock.received', {
      sku: fgSku,
      target_location_id: binA1Id,
      quantity: 5,
      lot_id: lotNumber,
    });
    assert.strictEqual(ownedReceipt.status, 400, JSON.stringify(ownedReceipt.body));
    assert.strictEqual(ownedReceipt.body['error_code'], 'PROTOTYPE_NOT_SALEABLE');
    assert.strictEqual(
      await countRows('stock_balance', `sku = $1 AND lot_id = $2 AND stock_class = 'owned'`, [
        fgSku,
        lotNumber,
      ]),
      0,
    );

    // Code review 2026-09-02 (widened BSD-11): the bar is LOT-level - receiving 'owned' for the
    // same lot at a DIFFERENT location is refused too, so a transfer cannot launder the class.
    const otherLocationReceipt = await postStockEvent('stock.received', {
      sku: fgSku,
      target_location_id: siteAId,
      quantity: 5,
      lot_id: lotNumber,
    });
    assert.strictEqual(otherLocationReceipt.status, 400, JSON.stringify(otherLocationReceipt.body));
    assert.strictEqual(otherLocationReceipt.body['error_code'], 'PROTOTYPE_NOT_SALEABLE');

    // An unrelated lot at the same location is untouched: the bar is per grain, not per sku.
    const cleanLot = `CLEAN-LOT-8-8-${run}`;
    const clean = await postStockEvent('stock.received', {
      sku: fgSku,
      target_location_id: binA1Id,
      quantity: 7,
      lot_id: cleanLot,
    });
    assert.strictEqual(clean.status, 201, JSON.stringify(clean.body));
  });

  // -------------------------------------------------------------------------
  // Negative arms for the Error Code Contract
  // -------------------------------------------------------------------------

  it('WITNESS_HOLD_POINT_EXISTS: a second open hold point for one lot is refused', async () => {
    const lot = await plainLot();
    await openHoldPoint(lot.lotNumber);
    const second = await raiseHoldPoint(lot.lotNumber);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    // The governed hold is the first constraint reached: one open hold per lot, from ANY source.
    assert.ok(
      ['WITNESS_HOLD_POINT_EXISTS', 'HOLD_EXISTS'].includes(second.body['error_code'] as string),
      JSON.stringify(second.body),
    );
    assert.strictEqual(await countRows('qc_witness_hold_point', `lot_id = $1`, [lot.lotId]), 1);
  });

  it('WITNESS_HOLD_POINT_NOT_OPEN: sign-off or waiver against a closed hold point is refused', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);
    assert.strictEqual((await recordNotice(holdPointId)).status, 201);
    assert.strictEqual((await signOff(holdPointId)).status, 201);

    const again = await signOff(holdPointId);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'WITNESS_HOLD_POINT_NOT_OPEN');

    const waived = await waive(holdPointId);
    assert.strictEqual(waived.status, 409, JSON.stringify(waived.body));
    assert.strictEqual(waived.body['error_code'], 'WITNESS_HOLD_POINT_NOT_OPEN');

    // A notice against a closed hold point is refused too.
    const notice = await recordNotice(holdPointId);
    assert.strictEqual(notice.status, 409, JSON.stringify(notice.body));
    assert.strictEqual(notice.body['error_code'], 'WITNESS_HOLD_POINT_NOT_OPEN');
  });

  it('WITNESS_HOLD_POINT_NOT_FOUND: notice, sign-off and waiver against an unknown hold point are 404', async () => {
    const unknown = randomUUID();
    for (const res of [await recordNotice(unknown), await signOff(unknown), await waive(unknown)]) {
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'WITNESS_HOLD_POINT_NOT_FOUND');
    }
  });

  it('LOT_NOT_FOUND: a hold point against an unknown lot is 404', async () => {
    const res = await raiseHoldPoint(`NO-SUCH-LOT-8-8-${run}`);
    assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'LOT_NOT_FOUND');
  });

  it('SOD_VIOLATION: the actor who raised a hold point cannot approve its own waiver', async () => {
    const lot = await plainLot();
    // The QC head raises this one, so the DOA-resolved approver IS the raiser.
    const raised = await raiseHoldPoint(lot.lotNumber, {}, qcHeadHeaders);
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const holdPointId = (raised.body['hold_point'] as Record<string, unknown>)[
      'hold_point_id'
    ] as string;

    const res = await waive(holdPointId);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SOD_VIOLATION');
    assert.strictEqual(detailsOf(res.body)['raised_by'], qcHeadUserId);
    // Refused means nothing moved.
    assert.strictEqual((await lotRow(lot.lotId))['quality_hold_status'], 'held');
  });

  it('SOD_VIOLATION: the actor who raised a hold point cannot sign off its own inspection (code review 2026-09-02)', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);
    await recordNotice(holdPointId);

    const res = await signOff(holdPointId, {}, raiserHeaders);
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'SOD_VIOLATION');
    assert.strictEqual(detailsOf(res.body)['raised_by'], raiserUserId);
    assert.strictEqual((await lotRow(lot.lotId))['quality_hold_status'], 'held');
  });

  it('QUALITY_HOLD_GOVERNED: the Story 8.5 release route cannot release a witness-governed hold (code review 2026-09-02)', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);

    // qc_hold_id = hold_point_id by construction; the qc_head is NOT the placer, so the 8.5
    // SoD does not mask the witness governance guard.
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/qc/holds/${holdPointId}/release`,
      { release_reason: 'attempted bypass of the witness hold point' },
      qcHeadHeaders,
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'QUALITY_HOLD_GOVERNED');
    // Nothing moved: the hold point is still open and the lot still held.
    assert.strictEqual((await lotRow(lot.lotId))['quality_hold_status'], 'held');
    const hp = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/witness-hold-points/${holdPointId}`,
      null,
      qcHeadHeaders,
    );
    assert.strictEqual((hp.body['hold_point'] as Record<string, unknown>)['status'], 'open');
    // Round-2 pin: a wildcard-scoped raiser on a taskless lot stores NULL site_id, never the
    // zero-UUID NO_LOCATION sentinel (which no scoped reader could ever match).
    assert.strictEqual((hp.body['hold_point'] as Record<string, unknown>)['site_id'], null);
  });

  it('APPROVAL_REQUIRED: a non-approver cannot waive', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);
    const res = await waive(holdPointId, {}, raiserHeaders);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
  });

  it('APPROVAL_AUTHORITY_MISMATCH: the captured authority must match the authority resolved on apply', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);

    // Forge a waiver event whose captured quartet names a DIFFERENT DOA entry than the register
    // resolves now - the shape the applier re-derives and compares (BSD-7).
    const forged = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'qc',
        stream_id: holdPointId,
        event_type: 'qc.witnessed_inspection_waived',
        payload: {
          hold_point_id: holdPointId,
          waiver_reason: 'Forged capture',
          approved_by: qcHeadUserId,
          doa_entry_id: randomUUID(),
          governing_role: 'qc_head',
          delegation_applied: false,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: qcHeadUserId, role: 'qc_head', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      qcHeadHeaders,
    );
    assert.strictEqual(forged.status, 409, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'APPROVAL_AUTHORITY_MISMATCH');
    assert.strictEqual((await lotRow(lot.lotId))['quality_hold_status'], 'held');
  });

  it('APPROVAL_UNRESOLVED: a waiver with no governing DOA entry is refused', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);
    await getAdminPool().query(
      `UPDATE doa_registry_entries SET active = false WHERE entry_id = $1`,
      [waiverDoaEntryId],
    );
    try {
      const res = await waive(holdPointId);
      assert.ok([404, 409].includes(res.status), JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
    } finally {
      await getAdminPool().query(
        `UPDATE doa_registry_entries SET active = true WHERE entry_id = $1`,
        [waiverDoaEntryId],
      );
    }
  });

  it('QC_DERIVATION_MISMATCH: a client cannot declare a server-derived field', async () => {
    const lot = await plainLot();
    const forged = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'qc',
        stream_id: randomUUID(),
        event_type: 'qc.witness_hold_point_raised',
        payload: {
          hold_point_id: randomUUID(),
          lot_number: lot.lotNumber,
          sku: fgSku,
          inspection_type: 'third_party',
          hold_reason: 'Forged derivation',
          status: 'signed_off',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: raiserUserId, role: 'qc_inspector', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: randomUUID(),
      },
      raiserHeaders,
    );
    assert.strictEqual(forged.status, 409, JSON.stringify(forged.body));
    assert.strictEqual(forged.body['error_code'], 'QC_DERIVATION_MISMATCH');
  });

  it('INVALID_PARAMS: vocabularies, unaccepted fields and the required idempotency key', async () => {
    const lot = await plainLot();
    const badType = await raiseHoldPoint(lot.lotNumber, { inspection_type: 'regulator_witnessed' });
    assert.strictEqual(badType.status, 400, JSON.stringify(badType.body));
    assert.strictEqual(badType.body['error_code'], 'INVALID_PARAMS');

    const noKey = await makeRequest(
      port,
      'POST',
      '/api/v1/qc/witness-hold-points',
      {
        lot_number: lot.lotNumber,
        sku: fgSku,
        inspection_type: 'third_party',
        hold_reason: 'No idempotency key',
      },
      raiserHeaders,
    );
    assert.strictEqual(noKey.status, 400, JSON.stringify(noKey.body));
    assert.strictEqual(detailsOf(noKey.body)['field'], 'idempotency_key');

    const declared = await raiseHoldPoint(lot.lotNumber, { site_id: siteAId });
    assert.strictEqual(declared.status, 400, JSON.stringify(declared.body));
    assert.strictEqual(detailsOf(declared.body)['field'], 'site_id');

    const holdPointId = await openHoldPoint(lot.lotNumber);
    const badMethod = await recordNotice(holdPointId, { method: 'carrier_pigeon' });
    assert.strictEqual(badMethod.status, 400, JSON.stringify(badMethod.body));
    const badDate = await recordNotice(holdPointId, { notice_date: '2026-02-30' });
    assert.strictEqual(badDate.status, 400, JSON.stringify(badDate.body));
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('Idempotency: a replay of each write route returns 200 with the same event_id and one row', async () => {
    const lot = await plainLot();

    const raiseKey = randomUUID();
    const first = await raiseHoldPoint(lot.lotNumber, { idempotency_key: raiseKey });
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const holdPointId = (first.body['hold_point'] as Record<string, unknown>)[
      'hold_point_id'
    ] as string;
    const raiseReplay = await raiseHoldPoint(lot.lotNumber, { idempotency_key: raiseKey });
    assert.strictEqual(raiseReplay.status, 200, JSON.stringify(raiseReplay.body));
    assert.strictEqual(raiseReplay.body['event_id'], first.body['event_id']);
    assert.strictEqual(await countRows('qc_witness_hold_point', `lot_id = $1`, [lot.lotId]), 1);
    assert.strictEqual(await countRows('qc_quality_hold', `lot_id = $1`, [lot.lotId]), 1);

    const noticeKey = randomUUID();
    const notice = await recordNotice(holdPointId, { idempotency_key: noticeKey });
    assert.strictEqual(notice.status, 201, JSON.stringify(notice.body));
    const noticeReplay = await recordNotice(holdPointId, { idempotency_key: noticeKey });
    assert.strictEqual(noticeReplay.status, 200, JSON.stringify(noticeReplay.body));
    assert.strictEqual(noticeReplay.body['event_id'], notice.body['event_id']);
    assert.strictEqual(
      await countRows('qc_witness_notice', `hold_point_id = $1`, [holdPointId]),
      1,
    );

    const signKey = randomUUID();
    const signed = await signOff(holdPointId, { idempotency_key: signKey });
    assert.strictEqual(signed.status, 201, JSON.stringify(signed.body));
    const signReplay = await signOff(holdPointId, { idempotency_key: signKey });
    assert.strictEqual(signReplay.status, 200, JSON.stringify(signReplay.body));
    assert.strictEqual(signReplay.body['event_id'], signed.body['event_id']);

    // The waiver replay rides its own hold point.
    const waiveLot = await plainLot();
    const waiveHoldPoint = await openHoldPoint(waiveLot.lotNumber);
    const waiveKey = randomUUID();
    const waived = await waive(waiveHoldPoint, { idempotency_key: waiveKey });
    assert.strictEqual(waived.status, 201, JSON.stringify(waived.body));
    const waiveReplay = await waive(waiveHoldPoint, { idempotency_key: waiveKey });
    assert.strictEqual(waiveReplay.status, 200, JSON.stringify(waiveReplay.body));
    assert.strictEqual(waiveReplay.body['event_id'], waived.body['event_id']);
    assert.strictEqual(
      await countRows('qc_witness_hold_point', `hold_point_id = $1 AND status = 'waived'`, [
        waiveHoldPoint,
      ]),
      1,
    );
  });

  // -------------------------------------------------------------------------
  // RBAC and read scope
  // -------------------------------------------------------------------------

  it('RBAC: every route refuses a caller with no qc grants, and a read-scope caller can list and get', async () => {
    const lot = await plainLot();
    const holdPointId = await openHoldPoint(lot.lotNumber);

    const denied = [
      await raiseHoldPoint(lot.lotNumber, {}, outsiderHeaders),
      await recordNotice(holdPointId, {}, outsiderHeaders),
      await signOff(holdPointId, {}, outsiderHeaders),
      await waive(holdPointId, {}, outsiderHeaders),
      await makeRequest(port, 'GET', '/api/v1/qc/witness-hold-points', undefined, outsiderHeaders),
      await makeRequest(
        port,
        'GET',
        `/api/v1/qc/witness-hold-points/${holdPointId}`,
        undefined,
        outsiderHeaders,
      ),
    ];
    for (const res of denied) {
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    }

    // A read-scope caller cannot write...
    const readWrite = await recordNotice(holdPointId, {}, readerHeaders);
    assert.strictEqual(readWrite.status, 403, JSON.stringify(readWrite.body));

    // ...but BOTH read routes work for them.
    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/qc/witness-hold-points?status=open',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const holdPoints = list.body['hold_points'] as Array<Record<string, unknown>>;
    assert.ok(
      holdPoints.some((h) => h['hold_point_id'] === holdPointId),
      'the open hold point is missing from the list',
    );

    const get = await makeRequest(
      port,
      'GET',
      `/api/v1/qc/witness-hold-points/${holdPointId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(get.status, 200, JSON.stringify(get.body));
    assert.strictEqual(
      (get.body['hold_point'] as Record<string, unknown>)['hold_point_id'],
      holdPointId,
    );

    // A bad filter is a client error, not a silent full scan.
    const badFilter = await makeRequest(
      port,
      'GET',
      '/api/v1/qc/witness-hold-points?status=cancelled',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badFilter.status, 400, JSON.stringify(badFilter.body));
    assert.ok(siteBId.length === 36);
  });
});

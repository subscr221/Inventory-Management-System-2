import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, getPool, getAdminPool, closeAdminPool } from '../../src/config/db.js';
import { findRoleHolder } from '../../src/read/projections/doa_registry.js';
import { heldQuantity, caseStateFromRow } from '../../src/compliance/damage.js';
import { getDamageReportById } from '../../src/read/projections/damage_report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  raw: Buffer;
  headers: IncomingMessage['headers'];
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
    const isRaw = Buffer.isBuffer(body);
    const data = isRaw ? (body as Buffer) : body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          ...(isRaw ? {} : { 'Content-Type': 'application/json' }),
          ...(data !== undefined ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let parsed: Record<string, unknown> = {};
          if ((res.headers['content-type'] ?? '').includes('json') && raw.length > 0) {
            try {
              parsed = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY' };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, raw, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

async function provisionUser(
  port: number,
  externalId: string,
  roles: Role[],
  displayName?: string,
): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: displayName ?? externalId, roles },
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

/** A tiny but valid-looking JPEG: SOI, APP0 marker, padding. Magic bytes are all the store checks. */
function jpeg(size: number): Buffer {
  const out = randomBytes(size);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  out[3] = 0xe0;
  return out;
}

describe('Story 8.9 Report Damage - Universal Capture, QC Task, and Commercial Outcome', () => {
  let server: Server;
  let port: number;
  let siteA: string;
  let siteB: string;
  let qcHold: string;
  let qcBin1: string;
  let qcBin2: string;
  let binA1: string;
  let binA2: string;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  let bands: Record<string, string> = {};

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async function newSku(
    opts: {
      lot?: boolean;
      serial?: boolean;
      stock?: number;
      lotNumber?: string;
      cost?: string;
    } = {},
  ): Promise<string> {
    const sku = `SKU-89-${randomUUID().slice(0, 8)}`;
    await getPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, valuation_method, business_stream, status)
       VALUES ($1, 'EA', $2, $3, 'weighted_average', 'production', 'active')`,
      [sku, opts.lot === true, opts.serial === true],
    );
    if (opts.lotNumber) {
      await getPool().query(`INSERT INTO lot_master (lot_number, sku) VALUES ($1, $2)`, [
        opts.lotNumber,
        sku,
      ]);
    }
    if (opts.stock !== undefined) {
      await getPool().query(
        `INSERT INTO stock_balance (sku, location_id, location_code, lot_id, stock_class, on_hand) VALUES ($1, $2, 'BIN-89-A1', $3, 'owned', $4)`,
        [sku, binA1, opts.lotNumber ?? null, opts.stock],
      );
    }
    return sku;
  }

  async function onHand(sku: string, locationId: string): Promise<string> {
    const r = await getPool().query(
      `SELECT COALESCE(SUM(on_hand), 0)::numeric(18,3)::text AS q FROM stock_balance WHERE sku = $1 AND location_id = $2`,
      [sku, locationId],
    );
    return r.rows[0]!['q'] as string;
  }

  const JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
  ]);

  /** Uploads a real, owned attachment (code review 2026-09-28: reports must name a photo the actor uploaded). */
  async function uploadPhoto(who: string): Promise<string> {
    const attachmentId = randomUUID();
    const res = await makeRequest(port, 'PUT', `/api/v1/attachments/${attachmentId}`, JPEG_BYTES, {
      ...H[who],
      'Content-Type': 'image/jpeg',
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return attachmentId;
  }

  function reportBody(
    sku: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      site_id: siteA,
      sku,
      quantity: '4',
      found_at: 'stock',
      bin_code: 'BIN-89-A1',
      reason_code: 'DAMAGED_COMPONENT',
      ...overrides,
    };
  }

  async function report(
    who: string,
    sku: string,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    const photoAttachmentId =
      'photo_attachment_id' in overrides
        ? (overrides['photo_attachment_id'] as string | undefined)
        : await uploadPhoto(who);
    return makeRequest(
      port,
      'POST',
      '/api/v1/damage-reports',
      reportBody(sku, { ...overrides, photo_attachment_id: photoAttachmentId }),
      H[who],
    );
  }

  async function reportOk(
    who: string,
    sku: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const res = await report(who, sku, overrides);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body['report'] as Record<string, unknown>;
  }

  async function act(
    who: string,
    reportId: string,
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(port, 'POST', `/api/v1/damage-reports/${reportId}/${path}`, body, H[who]);
  }

  async function actOk(
    who: string,
    reportId: string,
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const res = await act(who, reportId, path, body);
    assert.ok(
      res.status === 201 || res.status === 200,
      `${who} ${path}: ${JSON.stringify(res.body)}`,
    );
    return res.body['report'] as Record<string, unknown>;
  }

  function expectError(res: HttpResult, status: number, code: string): void {
    assert.strictEqual(res.status, status, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], code, JSON.stringify(res.body));
  }

  async function detail(who: string, reportId: string): Promise<HttpResult> {
    return makeRequest(port, 'GET', `/api/v1/damage-reports/${reportId}`, undefined, H[who]);
  }

  /** A case inspected with damage confirmed, awaiting both keys. */
  async function awaitingKeys(reporter = 'emp1', confirmed = '3'): Promise<string> {
    const sku = await newSku({ stock: 10 });
    const r = await reportOk(reporter, sku);
    await actOk('qc1', r['report_id'] as string, 'inspection', {
      confirmed_quantity: confirmed,
      defect_code: 'FUNCTIONAL',
    });
    return r['report_id'] as string;
  }

  async function notificationsFor(
    reportId: string,
    eventType: string,
  ): Promise<Record<string, unknown>[]> {
    const r = await getPool().query(
      `SELECT payload FROM domain_events
        WHERE event_type = 'notification.created' AND payload->>'object_type' = 'damage_report'
          AND payload->>'object_id' = $1 AND payload->>'event_type' = $2`,
      [reportId, eventType],
    );
    return r.rows.map((row) => row['payload'] as Record<string, unknown>);
  }

  async function lastEvent(reportId: string, eventType: string): Promise<Record<string, unknown>> {
    const r = await getPool().query(
      `SELECT payload, metadata FROM domain_events WHERE stream_id = $1 AND event_type = $2 ORDER BY event_version DESC LIMIT 1`,
      [reportId, eventType],
    );
    assert.strictEqual(r.rows.length, 1, `no ${eventType} on ${reportId}`);
    return r.rows[0] as Record<string, unknown>;
  }

  async function band(transactionType: string, role: string): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      { role, transaction_type: transactionType, value_min: null, value_max: null },
      H['fin'],
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body['entry_id'] as string;
  }

  async function setBandActive(entryId: string, active: boolean): Promise<void> {
    const res = await makeRequest(
      port,
      'PATCH',
      `/api/v1/doa/entries/${entryId}`,
      { active },
      H['fin'],
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  }

  // -------------------------------------------------------------------------
  // setup
  // -------------------------------------------------------------------------

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/notification.sql',
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/stock_balance.sql',
      '../../read/projections/lot_master.sql',
      '../../read/projections/indent.sql',
      '../../read/projections/indent_line.sql',
      '../../read/projections/grn.sql',
      '../../read/projections/grn_line.sql',
      '../../read/projections/grn_jobwork_challan.sql',
      '../../read/projections/grn_line_condition.sql',
      '../../read/projections/qc_quality_hold.sql',
      '../../read/projections/damage_report.sql',
      '../../read/projections/attachment.sql',
      '../../read/projections/indent_damage_link.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE damage_report_action, damage_report, attachment, notification_escalations, notification_escalation_defs, notification_deliveries, notifications, notification_dispatch_log, notification_dispatch_attempts, indent_line, indent, qc_quality_hold, putaway_task, grn_line, grn, weighbridge_event, gate_event, erp_purchase_order_line, erp_purchase_order, inventory_valuation, lot_master, serial_master, lot_trace, stock_balance, item_master, location_register, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    siteA = randomUUID();
    siteB = randomUUID();
    qcHold = randomUUID();
    qcBin1 = randomUUID();
    qcBin2 = randomUUID();
    binA1 = randomUUID();
    binA2 = randomUUID();
    const binB1 = randomUUID();
    const dock = randomUUID();
    // ZONE-QC-HOLD is the quarantine zone the pilot pack builds (receiving and the report book into
    // it); QCH-89-B1 and B2 are quarantine shelves beneath it, where stores puts held units away.
    for (const [id, code, level, parent, site, quarantine, zoneType] of [
      [siteA, 'site-89-A', 'site', null, siteA, false, 'general'],
      [siteB, 'site-89-B', 'site', null, siteB, false, 'general'],
      [qcHold, 'ZONE-QC-HOLD', 'zone', siteA, siteA, true, 'quarantine'],
      [qcBin1, 'QCH-89-B1', 'bin', qcHold, siteA, true, 'quarantine'],
      [qcBin2, 'QCH-89-B2', 'bin', qcHold, siteA, true, 'quarantine'],
      [binA1, 'BIN-89-A1', 'bin', siteA, siteA, false, 'general'],
      [binA2, 'BIN-89-A2', 'bin', siteA, siteA, false, 'general'],
      [binB1, 'BIN-89-B1', 'bin', siteB, siteB, false, 'general'],
      [dock, 'RECV-DOCK-89', 'zone', siteA, siteA, false, 'staging'],
    ] as [string, string, string, string | null, string, boolean, string][]) {
      await getPool().query(
        `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ambient', $7, 'active')`,
        [id, code, level, parent, site, zoneType, quarantine],
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

    const employee = (site: string): Role => ({
      role: 'employee',
      module: 'employee',
      functionScope: 'write',
      locationId: site,
    });
    const personas: Record<string, { roles: Role[]; name: string }> = {
      emp1: { roles: [employee(siteA)], name: 'Ravi Emp' },
      emp2: { roles: [employee(siteA)], name: 'Asha Emp' },
      empB: { roles: [employee(siteB)], name: 'Other Site Emp' },
      store1: {
        roles: [
          {
            role: 'store_assistant',
            module: 'warehouse',
            functionScope: 'write',
            locationId: siteA,
          },
          {
            role: 'store_assistant',
            module: 'inventory',
            functionScope: 'write',
            locationId: siteA,
          },
          {
            role: 'store_assistant',
            module: 'receiving',
            functionScope: 'write',
            locationId: siteA,
          },
          employee(siteA),
        ],
        name: 'Store One',
      },
      qc1: {
        roles: [
          { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: siteA },
          employee(siteA),
        ],
        name: 'QC Inspector',
      },
      qch: {
        roles: [
          { role: 'qc_head', module: 'qc', functionScope: 'write', locationId: siteA },
          employee(siteA),
        ],
        name: 'QC Head',
      },
      fin: {
        roles: [
          {
            role: 'finance_controller',
            module: 'compliance',
            functionScope: 'write',
            locationId: '*',
          },
          employee(siteA),
        ],
        name: 'Finance Controller',
      },
      ceo: {
        roles: [
          { role: 'ceo', module: 'employee', functionScope: 'write', locationId: siteA },
          employee(siteA),
        ],
        name: 'The CEO',
      },
      svc: {
        roles: [
          { role: 'svc_erp_adapter', module: 'inventory', functionScope: 'write', locationId: '*' },
        ],
        name: 'ERP adapter',
      },
      unload: {
        roles: [
          {
            role: 'unloading_supervisor',
            module: 'receiving',
            functionScope: 'write',
            locationId: siteA,
          },
          employee(siteA),
        ],
        name: 'Unloading Supervisor',
      },
    };
    for (const [key, persona] of Object.entries(personas)) {
      const externalId = `${key}-8-9@example.com`;
      U[key] = await provisionUser(port, externalId, persona.roles, persona.name);
      H[key] = await authFor(port, externalId);
    }

    bands = {
      qc: await band('damage.qc_concurrence', 'qc_head'),
      finance: await band('damage.finance_concurrence', 'finance_controller'),
      escalation: await band('damage.escalation', 'ceo'),
      release: await band('receiving.putaway_release', 'unloading_supervisor'),
    };
    // The DOA authorities are the REAL oldest holders (findRoleHolder oldest-wins): resolve them
    // rather than assume the fixture persona.
    for (const [role, persona] of [
      ['qc_head', 'qch'],
      ['finance_controller', 'fin'],
      ['ceo', 'ceo'],
    ] as const) {
      const holder = await findRoleHolder(role);
      assert.strictEqual(holder?.user_id, U[persona], `${role} resolves to the ${persona} persona`);
    }
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: universal capture
  // -------------------------------------------------------------------------

  it('AC 1: an employee reports 4 of 10 units at a bin; the units are booked into QC hold', async () => {
    const sku = await newSku({ stock: 10 });
    // Story 1.8 offline pattern: the photo hasn't landed yet, only the report has.
    const res = await report('emp1', sku, { photo_attachment_id: randomUUID() });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const r = res.body['report'] as Record<string, unknown>;
    assert.match(r['report_number'] as string, /^DMG-\d{4}-\d{4}$/);
    assert.strictEqual(r['status'], 'on_hold');
    assert.strictEqual(r['hold_mode'], 'quarantined');
    assert.strictEqual(r['hold_note'], null);
    assert.strictEqual(r['physical_state'], 'awaiting_arrival');
    assert.strictEqual(r['reporter_user_id'], U['emp1']);
    assert.strictEqual(r['reporter_display_name'], 'Ravi Emp');
    assert.strictEqual(r['photo_status'], 'pending');
    assert.strictEqual(await onHand(sku, binA1), '6.000');
    assert.strictEqual(await onHand(sku, qcHold), '4.000');
    const inspect = await notificationsFor(r['report_id'] as string, 'damage_reported');
    assert.strictEqual(inspect.length, 1);
    assert.deepStrictEqual(
      (inspect[0]!['target'] as Record<string, unknown>)['role'],
      'qc_inspector',
    );
    assert.match(inspect[0]!['next_step'] as string, /BIN-89-A1/);
    const stores = await notificationsFor(r['report_id'] as string, 'damage_units_to_move');
    assert.strictEqual(stores.length, 1);
    assert.strictEqual(
      (stores[0]!['target'] as Record<string, unknown>)['role'],
      'store_assistant',
    );
    const event = await lastEvent(r['report_id'] as string, 'damage.reported');
    assert.strictEqual(
      ((event['metadata'] as Record<string, unknown>)['actor'] as Record<string, unknown>)['role'],
      'employee',
    );
    assert.strictEqual((event['payload'] as Record<string, unknown>)['hold_mode'], 'quarantined');
  });

  it('AC 1: reporting all remaining units of a single-bin SKU makes it out of stock for the bin', async () => {
    const sku = await newSku({ stock: 5 });
    await reportOk('emp1', sku, { quantity: '5' });
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/stock/${sku}/availability`,
      undefined,
      H['emp1'],
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['in_stock'], false);
  });

  it('AC 1 (D4): a report is never refused for stock reasons; it records with a note instead', async () => {
    const sku = await newSku({ stock: 10 });
    const over = await reportOk('emp1', sku, { quantity: '40' });
    assert.strictEqual(over['hold_mode'], 'record_only');
    assert.strictEqual(over['hold_note'], 'insufficient_stock_at_bin');
    assert.strictEqual(over['physical_state'], 'not_held');
    assert.strictEqual(await onHand(sku, binA1), '10.000', 'no stock moved');
    const inUse = await reportOk('emp1', sku, { found_at: 'in_use', bin_code: undefined });
    assert.strictEqual(inUse['hold_mode'], 'record_only');
    assert.strictEqual(inUse['hold_note'], 'in_use');
    assert.strictEqual(inUse['physical_state'], 'with_reporter');
    assert.strictEqual(inUse['bin_code'], null);
    const serial = await newSku({ serial: true, stock: 3 });
    const s = await reportOk('emp1', serial, { quantity: '1' });
    assert.strictEqual(s['hold_note'], 'serial_controlled');
  });

  it('AC 1: capture refusals name their reason', async () => {
    const sku = await newSku({ stock: 10 });
    expectError(
      await report('emp1', sku, { bin_code: 'NO-SUCH-BIN' }),
      404,
      'DAMAGE_LOCATION_NOT_FOUND',
    );
    expectError(
      await report('emp1', sku, { bin_code: 'BIN-89-B1' }),
      404,
      'DAMAGE_LOCATION_NOT_FOUND',
    );
    const lotSku = await newSku({ lot: true });
    expectError(await report('emp1', lotSku), 400, 'DAMAGE_LOT_REQUIRED');
    expectError(
      await report('emp1', lotSku, { lot_number: 'NOPE-LOT' }),
      404,
      'DAMAGE_LOT_NOT_FOUND',
    );
    expectError(
      await report('emp1', sku, { reason_code: 'OTHER' }),
      400,
      'DAMAGE_OTHER_NOTE_REQUIRED',
    );
    expectError(
      await report('emp1', sku, { reason_note: 'cracked' }),
      400,
      'DAMAGE_REASON_INVALID',
    );
    expectError(
      await report('emp1', sku, { photo_attachment_id: undefined }),
      400,
      'DAMAGE_PHOTO_REQUIRED',
    );
    expectError(await report('emp1', sku, { quantity: '0' }), 400, 'DAMAGE_QUANTITY_INVALID');
    expectError(await report('emp1', 'NO-SUCH-SKU'), 404, 'ITEM_NOT_FOUND');
    expectError(
      await report('svc', sku, { photo_attachment_id: randomUUID() }),
      403,
      'MODULE_ACCESS_DENIED',
    );
    expectError(
      await report('empB', sku, { photo_attachment_id: randomUUID() }),
      403,
      'LOCATION_ACCESS_DENIED',
    );
    assert.strictEqual(await onHand(sku, binA1), '10.000', 'no refused capture moved stock');
  });

  it('AD-16: a replay of the same idempotency key is 409 DUPLICATE_EVENT with the existing event id', async () => {
    const sku = await newSku({ stock: 10 });
    const key = `dmg-${randomUUID()}`;
    const photoAttachmentId = await uploadPhoto('emp1');
    const body = reportBody(sku, { idempotency_key: key, photo_attachment_id: photoAttachmentId });
    const first = await makeRequest(port, 'POST', '/api/v1/damage-reports', body, H['emp1']);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const again = await makeRequest(port, 'POST', '/api/v1/damage-reports', body, H['emp1']);
    expectError(again, 409, 'DUPLICATE_EVENT');
    assert.strictEqual(
      (again.body['details'] as Record<string, unknown>)['existing_event_id'],
      first.body['event_id'],
    );
    assert.strictEqual(await onHand(sku, qcHold), '4.000', 'moved once');
  });

  it('edge door: damage.reported is a base-hat capture; every other damage event is central-only', async () => {
    const sku = await newSku({ stock: 10 });
    const reportId = randomUUID();
    const photoAttachmentId = await uploadPhoto('emp1');
    const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      event_id: randomUUID(),
      stream_type: 'damage',
      stream_id: reportId,
      event_type: 'damage.reported',
      event_version: 1,
      payload: {
        ...reportBody(sku, { photo_attachment_id: photoAttachmentId }),
        report_id: reportId,
        reporter_user_id: U['emp2'],
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: U['emp1'], role: 'employee', location_id: siteA },
        occurred_at: new Date().toISOString(),
        device_id: 'tablet-89',
      },
      idempotency_key: `edge-damage-${randomUUID()}`,
      ...overrides,
    });
    const ok = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope(), H['emp1']);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    const row = await getDamageReportById(reportId);
    assert.strictEqual(row?.reporter_user_id, U['emp1'], 'reporter stamped from the token');
    const key = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      envelope({
        event_type: 'damage.key_turned',
        payload: { report_id: reportId, key: 'qc', outcome: 'write_off' },
      }),
      H['emp1'],
    );
    expectError(key, 403, 'CENTRAL_ONLY_OPERATION');
    const otherSite = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      envelope({
        stream_id: randomUUID(),
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: U['empB'], role: 'employee', location_id: siteB },
          occurred_at: new Date().toISOString(),
          device_id: 'tablet-89b',
        },
      }),
      H['empB'],
    );
    expectError(otherSite, 403, 'LOCATION_ACCESS_DENIED');
  });

  // -------------------------------------------------------------------------
  // AC 10: custody
  // -------------------------------------------------------------------------

  it('AC 10: arrival, external check and return are custody marks that never move the ledger', async () => {
    const sku = await newSku({ stock: 10 });
    const r = await reportOk('emp1', sku);
    const id = r['report_id'] as string;
    expectError(await act('emp1', id, 'custody/arrived'), 403, 'MODULE_ACCESS_DENIED');
    const arrived = await actOk('store1', id, 'custody/arrived', { note: 'on the QC shelf' });
    assert.strictEqual(arrived['physical_state'], 'in_qc_hold');
    assert.strictEqual(arrived['arrived_by'], U['store1']);
    assert.ok(arrived['arrived_at']);
    expectError(await act('store1', id, 'custody/arrived'), 409, 'DAMAGE_PHYSICAL_STATE_INVALID');
    const out = await actOk('qc1', id, 'custody/sent-external', {
      destination: 'NABL lab, Noida',
      reason: 'Failure analysis',
      expected_return_date: '2026-10-15',
    });
    assert.strictEqual(out['physical_state'], 'at_external_check');
    assert.strictEqual(out['external_destination'], 'NABL lab, Noida');
    assert.strictEqual(out['external_expected_return_date'], '2026-10-15');
    assert.strictEqual(await onHand(sku, qcHold), '4.000', 'still on the books while out');
    // The outcome cannot be recorded while units are out.
    await actOk('qc1', id, 'inspection', { confirmed_quantity: '4', defect_code: 'FUNCTIONAL' });
    await actOk('qch', id, 'keys/qc/turn', { outcome: 'write_off' });
    await actOk('fin', id, 'keys/finance/turn', { outcome: 'write_off' });
    expectError(
      await act('fin', id, 'outcome', { erp_document_ref_ext: 'JV-1' }),
      409,
      'DAMAGE_UNITS_OUT',
    );
    const back = await actOk('store1', id, 'custody/returned', {
      external_result_ref_ext: 'NABL-2026-77',
    });
    assert.strictEqual(back['physical_state'], 'in_qc_hold');
    assert.strictEqual(back['external_result_ref_ext'], 'NABL-2026-77');
    // An in-use report marked arrived lands in QC hold with no stock posting.
    const inUse = await reportOk('emp1', sku, { found_at: 'in_use', bin_code: undefined });
    const before = await onHand(sku, qcHold);
    const arrivedInUse = await actOk('qc1', inUse['report_id'] as string, 'custody/arrived');
    assert.strictEqual(arrivedInUse['physical_state'], 'in_qc_hold');
    assert.strictEqual(await onHand(sku, qcHold), before);
  });

  it('code review 2026-09-28: mark_returned_to_stock closes the release loop, gated on release', async () => {
    const sku = await newSku({ stock: 10 });
    const r = await reportOk('emp1', sku);
    const id = r['report_id'] as string;
    await actOk('store1', id, 'custody/arrived');
    // Not yet released: the case is still on_hold, so the units cannot be marked returned to stock.
    expectError(
      await act('store1', id, 'custody/returned-to-stock'),
      409,
      'DAMAGE_PHYSICAL_STATE_INVALID',
    );
    // QC finds no damage: the case clears and its held units are released.
    const cleared = await actOk('qc1', id, 'inspection', { confirmed_quantity: '0' });
    assert.strictEqual(cleared['status'], 'cleared');
    const returned = await actOk('store1', id, 'custody/returned-to-stock', {
      note: 'walked back to the shelf',
    });
    assert.strictEqual(returned['physical_state'], 'not_held');
    expectError(
      await act('store1', id, 'custody/returned-to-stock'),
      409,
      'DAMAGE_PHYSICAL_STATE_INVALID',
    );
  });

  it('code review 2026-09-28: photo_attachment_id must be uploaded by the reporter, once claimed', async () => {
    const sku = await newSku({ stock: 10 });
    const emp1Photo = await uploadPhoto('emp1');
    expectError(
      await report('emp2', sku, { photo_attachment_id: emp1Photo }),
      403,
      'DAMAGE_PHOTO_NOT_OWNED',
    );
    // A pending (not-yet-uploaded) id is fine - the Story 1.8 offline pattern.
    const pending = await reportOk('emp2', sku, { photo_attachment_id: randomUUID() });
    assert.strictEqual(pending['photo_status'], 'pending');
    // The reporter's own already-uploaded photo is fine, including reused across two reports.
    const own = await reportOk('emp1', sku, { photo_attachment_id: emp1Photo });
    assert.strictEqual(own['photo_status'], 'stored');
  });

  // -------------------------------------------------------------------------
  // D5: the stock guard
  // -------------------------------------------------------------------------

  /** Stores puts the booked units away onto a quarantine shelf beneath the zone. */
  async function shelve(sku: string): Promise<void> {
    const zone = await getPool().query(
      `UPDATE stock_balance SET on_hand = 0 WHERE sku = $1 AND location_id = $2 RETURNING on_hand`,
      [sku, qcHold],
    );
    assert.strictEqual(zone.rows.length, 1);
    await getPool().query(
      `INSERT INTO stock_balance (sku, location_id, location_code, lot_id, stock_class, on_hand) VALUES ($1, $2, 'QCH-89-B1', NULL, 'owned', 4)`,
      [sku, qcBin1],
    );
  }

  it('D5: held units cannot leave quarantine; moves between quarantine bins are allowed', async () => {
    const sku = await newSku({ stock: 10 });
    const r = await reportOk('emp1', sku);
    const id = r['report_id'] as string;
    await shelve(sku);
    const move = (from: string, to: string, qty: string): Promise<HttpResult> =>
      makeRequest(
        port,
        'POST',
        '/api/v1/stock/bin-moves',
        {
          site_id: siteA,
          sku,
          from_location_code: from,
          to_location_code: to,
          quantity: qty,
          idempotency_key: `move-${randomUUID()}`,
        },
        H['store1'],
      );
    expectError(await move('QCH-89-B1', 'BIN-89-A2', '4'), 409, 'DAMAGE_UNITS_HELD');
    const intoQuarantine = await move('QCH-89-B1', 'QCH-89-B2', '4');
    assert.ok(
      intoQuarantine.status === 201 || intoQuarantine.status === 200,
      JSON.stringify(intoQuarantine.body),
    );
    expectError(await move('QCH-89-B2', 'BIN-89-A2', '1'), 409, 'DAMAGE_UNITS_HELD');
    // Cleared: the same move out succeeds.
    await actOk('qc1', id, 'inspection', { confirmed_quantity: '0' });
    const out = await move('QCH-89-B2', 'BIN-89-A2', '4');
    assert.ok(out.status === 201 || out.status === 200, JSON.stringify(out.body));
    const row = await getDamageReportById(id);
    assert.strictEqual(heldQuantity(caseStateFromRow(row!)), '0');
  });

  it('D5: a quarantine bin holding 6 units of which 4 are held lets 2 leave and refuses the third', async () => {
    const sku = await newSku({ stock: 10 });
    await reportOk('emp1', sku);
    await shelve(sku);
    await getPool().query(
      `UPDATE stock_balance SET on_hand = on_hand + 2 WHERE sku = $1 AND location_id = $2`,
      [sku, qcBin1],
    );
    assert.strictEqual(await onHand(sku, qcBin1), '6.000');
    const move = (qty: string): Promise<HttpResult> =>
      makeRequest(
        port,
        'POST',
        '/api/v1/stock/bin-moves',
        {
          site_id: siteA,
          sku,
          from_location_code: 'QCH-89-B1',
          to_location_code: 'BIN-89-A2',
          quantity: qty,
          idempotency_key: `move-${randomUUID()}`,
        },
        H['store1'],
      );
    const two = await move('2');
    assert.ok(two.status === 201 || two.status === 200, JSON.stringify(two.body));
    expectError(await move('1'), 409, 'DAMAGE_UNITS_HELD');
    assert.strictEqual(await onHand(sku, qcBin1), '4.000');
  });

  // -------------------------------------------------------------------------
  // AC 2: whole lot is a request, the QC head decides
  // -------------------------------------------------------------------------

  it('AC 2: "suspect whole lot" is a request; the QC head decides and a governed hold follows', async () => {
    const lot = `LOT-89-${randomUUID().slice(0, 6)}`;
    const sku = await newSku({ lot: true, lotNumber: lot, stock: 10 });
    const r = await reportOk('emp1', sku, { lot_number: lot, whole_lot_requested: true });
    const id = r['report_id'] as string;
    const lotRow = await getPool().query(
      `SELECT lot_id, quality_hold_status FROM lot_master WHERE lot_number = $1`,
      [lot],
    );
    assert.strictEqual(lotRow.rows[0]!['quality_hold_status'], 'none', 'a request, not a hold');
    const holds = async (): Promise<number> =>
      (
        await getPool().query(`SELECT count(*)::int AS c FROM qc_quality_hold WHERE lot_id = $1`, [
          lotRow.rows[0]!['lot_id'],
        ])
      ).rows[0]!['c'] as number;
    assert.strictEqual(await holds(), 0);
    assert.strictEqual((await notificationsFor(id, 'damage_whole_lot_requested')).length, 1);
    expectError(
      await act('qc1', id, 'whole-lot', { decision: 'hold_lot', reason: 'spread' }),
      403,
      'APPROVAL_REQUIRED',
    );
    expectError(
      await act('emp1', id, 'whole-lot', { decision: 'hold_lot', reason: 'mine' }),
      403,
      'SOD_VIOLATION',
    );
    const decided = await actOk('qch', id, 'whole-lot', {
      decision: 'hold_lot',
      reason: 'Same reel',
    });
    assert.strictEqual(decided['whole_lot_decision'], 'hold_lot');
    assert.ok(decided['whole_lot_hold_id']);
    assert.strictEqual(decided['whole_lot_already_held'], false);
    const hold = await getPool().query(
      `SELECT hold_reason, status FROM qc_quality_hold WHERE hold_id = $1`,
      [decided['whole_lot_hold_id']],
    );
    assert.strictEqual(hold.rows[0]!['hold_reason'], 'damage_report');
    assert.strictEqual(hold.rows[0]!['status'], 'open');
    assert.strictEqual(await holds(), 1);
    expectError(
      await act('qch', id, 'whole-lot', { decision: 'keep_local', reason: 'again' }),
      409,
      'DAMAGE_WHOLE_LOT_NOT_PENDING',
    );
    const plain = await reportOk('emp1', await newSku({ stock: 10 }));
    expectError(
      await act('qch', plain['report_id'] as string, 'whole-lot', {
        decision: 'hold_lot',
        reason: 'x',
      }),
      409,
      'DAMAGE_WHOLE_LOT_NOT_PENDING',
    );
    // A lot already under an open governed hold: recorded, no second hold, no HOLD_EXISTS.
    const r2 = await reportOk('emp2', sku, {
      lot_number: lot,
      whole_lot_requested: true,
      quantity: '1',
    });
    const second = await actOk('qch', r2['report_id'] as string, 'whole-lot', {
      decision: 'hold_lot',
      reason: 'Still',
    });
    assert.strictEqual(second['whole_lot_already_held'], true);
    assert.strictEqual(second['whole_lot_hold_id'], decided['whole_lot_hold_id']);
    assert.strictEqual(await holds(), 1);
  });

  // -------------------------------------------------------------------------
  // Inspection (the ad-hoc QC task, D8)
  // -------------------------------------------------------------------------

  it('inspection: 0 clears; 3 of 4 awaits both keys; refusals', async () => {
    const sku = await newSku({ stock: 20 });
    const a = await reportOk('emp1', sku);
    expectError(
      await act('emp1', a['report_id'] as string, 'inspection', {
        confirmed_quantity: '1',
        defect_code: 'FUNCTIONAL',
      }),
      403,
      'MODULE_ACCESS_DENIED',
    );
    expectError(
      await act('qc1', a['report_id'] as string, 'inspection', {
        confirmed_quantity: '5',
        defect_code: 'FUNCTIONAL',
      }),
      400,
      'DAMAGE_QUANTITY_INVALID',
    );
    const badDefect = await act('qc1', a['report_id'] as string, 'inspection', {
      confirmed_quantity: '2',
      defect_code: 'NOT-A-CODE',
    });
    assert.strictEqual(
      badDefect.body['error_code'],
      'DEFECT_CODE_UNKNOWN',
      JSON.stringify(badDefect.body),
    );
    const cleared = await actOk('qc1', a['report_id'] as string, 'inspection', {
      confirmed_quantity: '0',
    });
    assert.strictEqual(cleared['status'], 'cleared');
    assert.strictEqual(
      (await notificationsFor(a['report_id'] as string, 'damage_cleared')).length,
      1,
    );
    assert.strictEqual(
      (await notificationsFor(a['report_id'] as string, 'damage_units_released')).length,
      1,
    );
    const b = await reportOk('emp1', sku);
    const confirmed = await actOk('qc1', b['report_id'] as string, 'inspection', {
      confirmed_quantity: '3',
      defect_code: 'FUNCTIONAL',
    });
    assert.strictEqual(confirmed['status'], 'awaiting_keys');
    assert.strictEqual(confirmed['confirmed_quantity'], '3.000000');
    const row = await getDamageReportById(b['report_id'] as string);
    assert.strictEqual(heldQuantity(caseStateFromRow(row!)), '3.000000');
    const keyNotices = await notificationsFor(b['report_id'] as string, 'damage_key_required');
    assert.deepStrictEqual(
      keyNotices.map((n) => (n['target'] as Record<string, unknown>)['role']).sort(),
      ['finance_controller', 'qc_head'],
    );
    expectError(
      await act('qc1', b['report_id'] as string, 'inspection', {
        confirmed_quantity: '1',
        defect_code: 'FUNCTIONAL',
      }),
      409,
      'DAMAGE_CASE_STATE_INVALID',
    );
  });

  // -------------------------------------------------------------------------
  // AC 3: two keys
  // -------------------------------------------------------------------------

  it('AC 3: QC then finance on the same outcome makes it final by concurrence', async () => {
    const id = await awaitingKeys();
    const afterQc = await actOk('qch', id, 'keys/qc/turn', { outcome: 'debit_note' });
    assert.strictEqual(afterQc['qc_key_status'], 'turned');
    assert.strictEqual(afterQc['status'], 'awaiting_keys');
    const final = await actOk('fin', id, 'keys/finance/turn', { outcome: 'debit_note' });
    assert.strictEqual(final['status'], 'outcome_final');
    assert.strictEqual(final['final_outcome'], 'debit_note');
    assert.strictEqual(final['decided_by'], 'concurrence');
    const qcEvent = await lastEvent(id, 'damage.key_turned');
    assert.strictEqual(
      ((qcEvent['metadata'] as Record<string, unknown>)['actor'] as Record<string, unknown>)[
        'role'
      ],
      'finance_controller',
    );
    assert.strictEqual(
      (qcEvent['payload'] as Record<string, unknown>)['doa_entry_id'],
      bands['finance'],
    );
    expectError(
      await act('qch', id, 'keys/qc/withdraw', { reason: 'late' }),
      409,
      'DAMAGE_CASE_LOCKED',
    );
    expectError(
      await act('fin', id, 'keys/finance/turn', { outcome: 'debit_note' }),
      409,
      'DAMAGE_CASE_LOCKED',
    );
  });

  it('AC 3: finance first then QC also works; a different second outcome is a mismatch', async () => {
    const id = await awaitingKeys();
    await actOk('fin', id, 'keys/finance/turn', { outcome: 'write_off' });
    expectError(
      await act('qch', id, 'keys/qc/turn', { outcome: 'debit_note' }),
      409,
      'DAMAGE_OUTCOME_MISMATCH',
    );
    const final = await actOk('qch', id, 'keys/qc/turn', { outcome: 'write_off' });
    assert.strictEqual(final['final_outcome'], 'write_off');
    const qcEvent = await lastEvent(id, 'damage.key_turned');
    assert.strictEqual(
      ((qcEvent['metadata'] as Record<string, unknown>)['actor'] as Record<string, unknown>)[
        'role'
      ],
      'qc_head',
    );
  });

  it('AC 3 (D10): separation - the reporter, one person for both keys, a non-holder', async () => {
    const id = await awaitingKeys('fin');
    expectError(
      await act('fin', id, 'keys/finance/turn', { outcome: 'write_off' }),
      403,
      'SOD_VIOLATION',
    );
    const id2 = await awaitingKeys();
    await actOk('qch', id2, 'keys/qc/turn', { outcome: 'write_off' });
    expectError(
      await act('qch', id2, 'keys/finance/turn', { outcome: 'write_off' }),
      403,
      'SOD_VIOLATION',
    );
    expectError(
      await act('qc1', id2, 'keys/finance/turn', { outcome: 'write_off' }),
      403,
      'APPROVAL_REQUIRED',
    );
    expectError(
      await act('emp2', id2, 'keys/finance/turn', { outcome: 'write_off' }),
      403,
      'APPROVAL_REQUIRED',
    );
    // Withdraw with a reason before the second key puts it back to pending.
    const withdrawn = await actOk('qch', id2, 'keys/qc/withdraw', { reason: 'Recheck the reel' });
    assert.strictEqual(withdrawn['qc_key_status'], 'pending');
    assert.strictEqual(withdrawn['qc_key_user_id'], null);
    expectError(
      await act('qch', id2, 'keys/qc/withdraw', { reason: 'twice' }),
      409,
      'DAMAGE_KEY_NOT_TURNED',
    );
    expectError(await act('qch', id2, 'keys/qc/withdraw', {}), 400, 'INVALID_PAYLOAD');
  });

  it('AC 3 (D7): no DOA entry for the finance key is 409 APPROVAL_UNRESOLVED (fail closed)', async () => {
    const id = await awaitingKeys();
    await setBandActive(bands['finance']!, false);
    try {
      expectError(
        await act('fin', id, 'keys/finance/turn', { outcome: 'write_off' }),
        409,
        'APPROVAL_UNRESOLVED',
      );
    } finally {
      await setBandActive(bands['finance']!, true);
    }
    await actOk('fin', id, 'keys/finance/turn', { outcome: 'write_off' });
  });

  it('AC 3: ten concurrent finance key turns - exactly one succeeds', async () => {
    const id = await awaitingKeys();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        act('fin', id, 'keys/finance/turn', { outcome: 'write_off' }),
      ),
    );
    assert.strictEqual(
      results.filter((r) => r.status === 201).length,
      1,
      JSON.stringify(results.map((r) => r.status)),
    );
    for (const r of results.filter((x) => x.status !== 201))
      expectError(r, 409, 'DAMAGE_KEY_ALREADY_TURNED');
  });

  // -------------------------------------------------------------------------
  // AC 3, AC 6: escalation to the CEO
  // -------------------------------------------------------------------------

  it('AC 3, AC 6: disagreement escalates to the CEO, who decides; the audit reads ceo', async () => {
    const id = await awaitingKeys();
    expectError(
      await act('fin', id, 'keys/finance/disagree', {
        proposed_outcome: 'debit_note',
        reason: 'Supplier fault',
      }),
      409,
      'DAMAGE_CASE_STATE_INVALID',
    );
    await actOk('qch', id, 'keys/qc/turn', { outcome: 'write_off' });
    const escalated = await actOk('fin', id, 'keys/finance/disagree', {
      proposed_outcome: 'debit_note',
      reason: 'Supplier fault',
    });
    assert.strictEqual(escalated['status'], 'escalated');
    assert.strictEqual(escalated['finance_key_status'], 'disagreed');
    const notices = await notificationsFor(id, 'damage_escalated');
    assert.strictEqual(notices.length, 1);
    assert.strictEqual((notices[0]!['target'] as Record<string, unknown>)['role'], 'ceo');
    expectError(
      await act('qch', id, 'keys/qc/withdraw', { reason: 'x' }),
      409,
      'DAMAGE_CASE_LOCKED',
    );
    expectError(
      await act('qch', id, 'escalation/decide', { outcome: 'write_off', reason: 'mine' }),
      403,
      'SOD_VIOLATION',
    );
    expectError(
      await act('emp2', id, 'escalation/decide', { outcome: 'write_off', reason: 'x' }),
      403,
      'APPROVAL_REQUIRED',
    );
    const final = await actOk('ceo', id, 'escalation/decide', {
      outcome: 'write_off',
      reason: 'QC is right',
    });
    assert.strictEqual(final['status'], 'outcome_final');
    assert.strictEqual(final['decided_by'], 'escalation');
    assert.strictEqual(final['escalation_user_id'], U['ceo']);
    const event = await lastEvent(id, 'damage.escalation_decided');
    assert.strictEqual(
      ((event['metadata'] as Record<string, unknown>)['actor'] as Record<string, unknown>)['role'],
      'ceo',
    );
  });

  // -------------------------------------------------------------------------
  // AC 4: four outcomes with an ERP reference
  // -------------------------------------------------------------------------

  it('AC 4: finance records the ERP reference on a final case and it closes', async () => {
    const id = await awaitingKeys();
    expectError(
      await act('fin', id, 'outcome', { erp_document_ref_ext: 'DN-1' }),
      409,
      'DAMAGE_CASE_STATE_INVALID',
    );
    expectError(
      await act('qch', id, 'keys/qc/turn', { outcome: 'accept_as_is_price_reduction' }),
      400,
      'DAMAGE_OUTCOME_INVALID',
    );
    await actOk('qch', id, 'keys/qc/turn', {
      outcome: 'accept_as_is_price_reduction',
      price_reduction_pct: '15',
    });
    await actOk('fin', id, 'keys/finance/turn', {
      outcome: 'accept_as_is_price_reduction',
      price_reduction_pct: '15.0',
    });
    expectError(
      await act('fin', id, 'outcome', { erp_document_ref_ext: '' }),
      400,
      'INVALID_PAYLOAD',
    );
    expectError(
      await act('qch', id, 'outcome', { erp_document_ref_ext: 'X' }),
      403,
      'APPROVAL_REQUIRED',
    );
    const closed = await actOk('fin', id, 'outcome', { erp_document_ref_ext: 'CN/2026/0042' });
    assert.strictEqual(closed['status'], 'closed');
    assert.strictEqual(closed['erp_document_ref_ext'], 'CN/2026/0042');
    assert.strictEqual(closed['final_price_reduction_pct'], '15.0000');
    const row = await getDamageReportById(id);
    assert.strictEqual(
      heldQuantity(caseStateFromRow(row!)),
      '0',
      'accepted as-is releases the units',
    );
  });

  // -------------------------------------------------------------------------
  // AC 9: receipt damage opens a case and gates the held putaway
  // -------------------------------------------------------------------------

  it('AC 9: a DAMAGED or REJECTED GRN line opens one case and its putaway waits for it', async () => {
    const sku = await newSku();
    const seedPo = async (po: string, ordered = 100): Promise<string> => {
      await getPool().query(
        `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
         VALUES ($1, 'SUP-1', 'INR', '2026-08-01', 'open', 'ERP', now())`,
        [po],
      );
      await getPool().query(
        `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
         VALUES ($1, 1, $2, $3, $3, 1, 5, 5, 'ERP', now())`,
        [po, sku, ordered],
      );
      const token = randomUUID();
      await getPool().query(
        `INSERT INTO weighbridge_event
          (weighbridge_event_id, correlation_id, gate_event_id, site_id, site_code_ext, po_ref_ext, line_no,
           tare_kg, gross_kg, net_kg, status, device_id, capture_method, weighed_by, business_date, source_event_id)
         VALUES ($1, $2, $3, $4, 'site-89-A', $5, 1, 1000, 1100, 100, 'accepted', 'WB-1', 'MANUAL', $6, '2026-07-23', $7)`,
        [randomUUID(), token, randomUUID(), siteA, po, U['unload'], randomUUID()],
      );
      return token;
    };
    const bodies: Record<string, unknown>[] = [];
    const receive = async (
      po: string,
      extra: Record<string, unknown>,
      ordered = 100,
    ): Promise<HttpResult> => {
      const body = {
        grn_id: randomUUID(),
        grn_line_id: randomUUID(),
        correlation_id: await seedPo(po, ordered),
        po_ref_ext: po,
        line_no: 1,
        source_document: 'PO',
        sku,
        target_location_code: 'RECV-DOCK-89',
        received_qty: 5,
        ...extra,
      };
      bodies.push(body);
      return makeRequest(port, 'POST', '/api/v1/grn-lines', body, H['store1']);
    };
    const damaged = await receive(`PO-89-D-${randomUUID().slice(0, 6)}`, {
      line_condition: 'DAMAGED',
      reason_code: 'DAMAGED',
      reason_detail: 'TRANSIT_DAMAGE',
    });
    assert.strictEqual(damaged.status, 201, JSON.stringify(damaged.body));
    const lineId = (damaged.body['grn_line'] as Record<string, unknown>)['grn_line_id'] as string;
    const cases = await getPool().query(
      `SELECT report_id FROM damage_report WHERE source_grn_line_id = $1`,
      [lineId],
    );
    assert.strictEqual(cases.rows.length, 1);
    const receiptCase = (await getDamageReportById(cases.rows[0]!['report_id'] as string))!;
    assert.strictEqual(receiptCase.source, 'receipt');
    assert.strictEqual(receiptCase.reason_code, 'DAMAGED_COMPONENT');
    assert.strictEqual(receiptCase.source_reason_code, 'TRANSIT_DAMAGE');
    assert.strictEqual(receiptCase.hold_mode, 'quarantined');
    assert.strictEqual(receiptCase.physical_state, 'in_qc_hold');
    assert.strictEqual(receiptCase.reporter_user_id, U['store1']);
    assert.strictEqual(receiptCase.photo_attachment_id, null);
    assert.strictEqual(receiptCase.quantity, '5.000000');

    const rejected = await receive(`PO-89-R-${randomUUID().slice(0, 6)}`, {
      line_condition: 'REJECTED',
      reason_code: 'REJECTED',
      reason_detail: 'WRONG_ITEM',
    });
    assert.strictEqual(rejected.status, 201, JSON.stringify(rejected.body));
    const rejectedLine = (rejected.body['grn_line'] as Record<string, unknown>)['grn_line_id'];
    const rejectedCase = await getPool().query(
      `SELECT reason_code FROM damage_report WHERE source_grn_line_id = $1`,
      [rejectedLine],
    );
    assert.strictEqual(rejectedCase.rows[0]!['reason_code'], 'WRONG_ITEM_OR_SPEC');

    const good = await receive(`PO-89-G-${randomUUID().slice(0, 6)}`, {}, 5);
    assert.strictEqual(good.status, 201, JSON.stringify(good.body));
    const short = await receive(`PO-89-S-${randomUUID().slice(0, 6)}`, {
      reason_code: 'SHORT',
      reason_detail: 'SUPPLIER_SHORT_SHIPPED',
    });
    assert.strictEqual(short.status, 201, JSON.stringify(short.body));
    for (const res of [good, short]) {
      const line = (res.body['grn_line'] as Record<string, unknown>)['grn_line_id'];
      const none = await getPool().query(
        `SELECT 1 FROM damage_report WHERE source_grn_line_id = $1`,
        [line],
      );
      assert.strictEqual(none.rows.length, 0, 'GOOD and SHORT lines open no case');
    }
    // Replaying the damaged receipt opens no second case.
    await makeRequest(port, 'POST', '/api/v1/grn-lines', bodies[0], H['store1']);
    const replayed = await getPool().query(
      `SELECT count(*)::int AS c FROM damage_report WHERE source_grn_line_id = $1`,
      [lineId],
    );
    assert.strictEqual(replayed.rows[0]!['c'], 1);

    // The held putaway waits for the case.
    const taskId = (damaged.body['putaway_task'] as Record<string, unknown>)[
      'putaway_task_id'
    ] as string;
    const release = (): Promise<HttpResult> =>
      makeRequest(
        port,
        'POST',
        `/api/v1/putaway-tasks/${taskId}/release`,
        { reason_code: 'QC_CLEARED' },
        H['unload'],
      );
    expectError(await release(), 409, 'DAMAGE_CASE_BLOCKS_RELEASE');
    await actOk('qc1', receiptCase.report_id, 'inspection', { confirmed_quantity: '0' });
    const released = await release();
    assert.ok(released.status === 200 || released.status === 201, JSON.stringify(released.body));

    // A write-off close keeps the rejected line's putaway held.
    const rejectedCaseId = (
      await getPool().query(`SELECT report_id FROM damage_report WHERE source_grn_line_id = $1`, [
        rejectedLine,
      ])
    ).rows[0]!['report_id'] as string;
    await actOk('qc1', rejectedCaseId, 'inspection', {
      confirmed_quantity: '5',
      defect_code: 'MARKING_LABELLING',
    });
    await actOk('qch', rejectedCaseId, 'keys/qc/turn', { outcome: 'write_off' });
    await actOk('fin', rejectedCaseId, 'keys/finance/turn', { outcome: 'write_off' });
    await actOk('fin', rejectedCaseId, 'outcome', { erp_document_ref_ext: 'JV-89-1' });
    const rejectedTask = (rejected.body['putaway_task'] as Record<string, unknown>)[
      'putaway_task_id'
    ] as string;
    expectError(
      await makeRequest(
        port,
        'POST',
        `/api/v1/putaway-tasks/${rejectedTask}/release`,
        { reason_code: 'QC_CLEARED' },
        H['unload'],
      ),
      409,
      'DAMAGE_CASE_BLOCKS_RELEASE',
    );
  });

  // -------------------------------------------------------------------------
  // AC 5: report and request replacement is one flow
  // -------------------------------------------------------------------------

  it('AC 5: the replacement indent links to its damage report; a forged link is refused', async () => {
    const sku = await newSku({ stock: 10 });
    const indentId = randomUUID();
    const r = await reportOk('emp1', sku, { replacement_indent_id: indentId });
    const indentBody = (id: string, damageReportId?: string): Record<string, unknown> => ({
      indent_id: id,
      ...(damageReportId !== undefined ? { damage_report_id: damageReportId } : {}),
      department_code: 'PROD',
      site_id: siteA,
      business_stream: 'production',
      need_by_date: '2026-10-01',
      urgent: true,
      reason: 'Replacement for damaged units',
      confirm_duplicate: true,
      lines: [{ sku, item_category: 'component', requested_qty: 4, uom: 'EA' }],
    });
    const raised = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      indentBody(indentId, r['report_id'] as string),
      H['emp1'],
    );
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const indent = raised.body['indent'] as Record<string, unknown>;
    assert.strictEqual(indent['indent_id'], indentId);
    assert.strictEqual(indent['damage_report_id'], r['report_id']);
    const shown = await detail('emp1', r['report_id'] as string);
    assert.strictEqual(
      (shown.body['report'] as Record<string, unknown>)['replacement_indent_number'],
      indent['indent_number_ext'],
    );
    // A report whose replacement_indent_id names a different indent.
    const forged = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      indentBody(randomUUID(), r['report_id'] as string),
      H['emp1'],
    );
    expectError(forged, 409, 'DAMAGE_REPLACEMENT_LINK_INVALID');
    // Another user's report.
    const otherIndent = randomUUID();
    const other = await reportOk('emp2', sku, {
      replacement_indent_id: otherIndent,
      quantity: '1',
    });
    expectError(
      await makeRequest(
        port,
        'POST',
        '/api/v1/indents',
        indentBody(otherIndent, other['report_id'] as string),
        H['emp1'],
      ),
      409,
      'DAMAGE_REPLACEMENT_LINK_INVALID',
    );
    // An indent without damage_report_id is unchanged (server-minted id).
    const plain = await makeRequest(
      port,
      'POST',
      '/api/v1/indents',
      indentBody(randomUUID()),
      H['emp1'],
    );
    assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));
    assert.strictEqual((plain.body['indent'] as Record<string, unknown>)['damage_report_id'], null);
  });

  // -------------------------------------------------------------------------
  // AC 8: reads and server-computed actions
  // -------------------------------------------------------------------------

  it('AC 8: view=mine, view=workbench and the detail allowed_actions', async () => {
    const sku = await newSku({ stock: 20 });
    const mine = await reportOk('emp1', sku);
    const theirs = await reportOk('emp2', sku);
    const list = await makeRequest(
      port,
      'GET',
      '/api/v1/damage-reports?view=mine&limit=51',
      undefined,
      H['emp1'],
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const ids = (list.body['reports'] as Record<string, unknown>[]).map((x) => x['report_id']);
    assert.ok(ids.includes(mine['report_id']));
    assert.ok(!ids.includes(theirs['report_id']));
    assert.ok(
      (list.body['reports'] as Record<string, unknown>[]).every(
        (x) => x['reporter_user_id'] === U['emp1'],
      ),
    );
    expectError(
      await makeRequest(port, 'GET', '/api/v1/damage-reports?view=workbench', undefined, H['emp1']),
      403,
      'FUNCTION_ACCESS_DENIED',
    );
    const qcList = await makeRequest(
      port,
      'GET',
      '/api/v1/damage-reports?view=workbench&limit=200',
      undefined,
      H['qc1'],
    );
    assert.strictEqual(qcList.status, 200, JSON.stringify(qcList.body));
    assert.ok(
      (qcList.body['reports'] as Record<string, unknown>[]).every((x) => x['site_id'] === siteA),
    );

    const keysCase = await awaitingKeys();
    const finalCase = await awaitingKeys();
    await actOk('qch', finalCase, 'keys/qc/turn', { outcome: 'write_off' });
    await actOk('fin', finalCase, 'keys/finance/turn', { outcome: 'write_off' });
    const finList = await makeRequest(
      port,
      'GET',
      '/api/v1/damage-reports?view=workbench&limit=200',
      undefined,
      H['fin'],
    );
    assert.strictEqual(finList.status, 200, JSON.stringify(finList.body));
    const finIds = (finList.body['reports'] as Record<string, unknown>[]).map(
      (x) => x['report_id'],
    );
    assert.ok(finIds.includes(keysCase), 'awaiting the finance key');
    assert.ok(finIds.includes(finalCase), 'awaiting its ERP reference');
    assert.ok(!finIds.includes(mine['report_id']), 'an uninspected case is not a finance step');
    for (const row of finList.body['reports'] as Record<string, unknown>[]) {
      assert.ok(
        ['awaiting_keys', 'escalated', 'outcome_final', 'closed'].includes(row['status'] as string),
        `fin sees ${row['status'] as string}`,
      );
    }

    const qcDetail = await detail('qc1', mine['report_id'] as string);
    assert.strictEqual(qcDetail.status, 200, JSON.stringify(qcDetail.body));
    assert.deepStrictEqual(qcDetail.body['allowed_actions'], ['inspect', 'mark_arrived']);
    assert.strictEqual(
      (qcDetail.body['report'] as Record<string, unknown>)['reporter_display_name'],
      'Ravi Emp',
    );
    assert.ok(Array.isArray(qcDetail.body['history']));
    const finDetail = await detail('fin', keysCase);
    assert.deepStrictEqual(finDetail.body['allowed_actions'], ['turn_finance_key']);
    const reporterDetail = await detail('emp1', mine['report_id'] as string);
    assert.deepStrictEqual(reporterDetail.body['allowed_actions'], []);
    expectError(await detail('emp2', mine['report_id'] as string), 403, 'FUNCTION_ACCESS_DENIED');

    const escalatedCase = await awaitingKeys();
    await actOk('qch', escalatedCase, 'keys/qc/turn', { outcome: 'write_off' });
    await actOk('fin', escalatedCase, 'keys/finance/disagree', {
      proposed_outcome: 'debit_note',
      reason: 'x',
    });
    const ceoDetail = await detail('ceo', escalatedCase);
    assert.deepStrictEqual(ceoDetail.body['allowed_actions'], ['decide_escalation']);
  });

  it('AC 1, AC 8: bootstrap navigation - everyone reports damage; case workers see the workbench', async () => {
    const nav = async (who: string): Promise<string[]> => {
      const res = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, H[who]);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body['navigation'] as string[];
    };
    for (const who of ['emp1', 'qc1', 'store1', 'qch', 'fin', 'ceo']) {
      assert.ok((await nav(who)).includes('Report damage'), `${who} reports damage`);
    }
    assert.ok(!(await nav('emp1')).includes('Damage cases'), 'a base-role user has no workbench');
    for (const who of ['qc1', 'store1', 'qch', 'fin', 'ceo']) {
      const entries = await nav(who);
      assert.ok(entries.includes('Damage cases'), `${who} works damage cases`);
      assert.ok(entries.indexOf('Report damage') < entries.indexOf('Damage cases'));
    }
    const ceo = await makeRequest(port, 'GET', '/api/v1/edge/bootstrap', undefined, H['ceo']);
    assert.strictEqual(ceo.body['role'], 'ceo', 'the CEO operates as ceo, not as the base hat');
  });

  // -------------------------------------------------------------------------
  // AC 7: the photo store
  // -------------------------------------------------------------------------

  it('AC 7: photos are stored as taken, idempotently, with type checks and visibility', async () => {
    const put = (id: string, body: Buffer, type: string, who = 'emp1'): Promise<HttpResult> =>
      makeRequest(port, 'PUT', `/api/v1/attachments/${id}`, body, {
        ...H[who],
        'Content-Type': type,
      });
    const small = jpeg(10 * 1024);
    const id = randomUUID();
    const first = await put(id, small, 'image/jpeg');
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(first.body['sha256'], createHash('sha256').update(small).digest('hex'));
    assert.strictEqual(first.body['byte_size'], small.length);
    const again = await put(id, small, 'image/jpeg');
    assert.strictEqual(again.status, 200);
    expectError(await put(id, jpeg(1024), 'image/jpeg'), 409, 'ATTACHMENT_CONFLICT');
    const big = jpeg(6 * 1024 * 1024);
    const bigRes = await put(randomUUID(), big, 'image/jpeg');
    assert.strictEqual(bigRes.status, 201, JSON.stringify(bigRes.body));
    assert.strictEqual(bigRes.body['byte_size'], big.length);
    expectError(
      await put(randomUUID(), Buffer.from('GIF89a......'), 'image/gif'),
      415,
      'ATTACHMENT_TYPE_INVALID',
    );
    expectError(
      await put(randomUUID(), Buffer.from('GIF89a......'), 'image/jpeg'),
      415,
      'ATTACHMENT_TYPE_INVALID',
    );
    expectError(await put(randomUUID(), small, 'image/jpeg', 'svc'), 403, 'MODULE_ACCESS_DENIED');

    const get = (who: string): Promise<HttpResult> =>
      makeRequest(port, 'GET', `/api/v1/attachments/${id}`, undefined, H[who]);
    const mine = await get('emp1');
    assert.strictEqual(mine.status, 200);
    assert.ok(mine.raw.equals(small), 'identical bytes back');
    assert.strictEqual(mine.headers['cache-control'], 'private, no-store');
    assert.strictEqual(mine.headers['content-type'], 'image/jpeg');
    expectError(await get('qc1'), 403, 'FUNCTION_ACCESS_DENIED');
    // Once a report at qc1's site references it, qc1 may read it; an unrelated employee still not.
    const sku = await newSku({ stock: 10 });
    const r = await reportOk('emp1', sku, { photo_attachment_id: id });
    assert.strictEqual(r['photo_status'], 'stored');
    assert.strictEqual((await get('qc1')).status, 200);
    expectError(await get('emp2'), 403, 'FUNCTION_ACCESS_DENIED');
    expectError(
      await makeRequest(port, 'GET', `/api/v1/attachments/${randomUUID()}`, undefined, H['emp1']),
      404,
      'ATTACHMENT_NOT_FOUND',
    );
  });
});

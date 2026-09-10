import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { openingStockImportTestHooks } from '../../src/api/v1/migration.js';
import { OPENING_STOCK_TEMPLATE_V1 } from '../../src/migration/opening-stock-template.js';
import { toIstCalendarDate } from '../../src/lib/business-days.js';

/**
 * Story 13.1 Opening Stock Migration and Verification (FR-DM-01, SM-48). Real PostgreSQL, the real
 * production router, SCIM provisioning and dev-token auth. Tests run serially and build on each
 * other's state; every identifier is run-scoped. Fixture writes use the admin pool (app_user has
 * no DELETE). The harness scaffolding is a deliberate local re-implementation of the story-9-9
 * closure (never import cross-story).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const RUN = run.toUpperCase();

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
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
          resolvePromise({ status: res.statusCode ?? 0, body: parsed, text: raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(600000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
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
  assert.strictEqual(res.status, 201, `provision ${externalId} failed: ${res.text}`);
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed: ${res.text}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body['details'] ?? {}) as Record<string, unknown>;
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const HEADER = OPENING_STOCK_TEMPLATE_V1.join(',');
const DOA_TYPE = 'migration.variance_explanation';
const PERF_ROWS = Number(process.env['STORY_13_1_PERF_ROWS'] ?? '2000');

describe('Story 13.1 Opening Stock Migration and Verification', () => {
  let server: Server;
  let port: number;

  const SITE_A = `SITE-A-13-1-${RUN}`;
  const SITE_B = `SITE-B-13-1-${RUN}`;
  const SITE_C = `SITE-C-13-1-${RUN}`;
  const BIN_A1 = `BIN-A1-13-1-${RUN}`;
  const BIN_A2 = `BIN-A2-13-1-${RUN}`;
  const BIN_B1 = `BIN-B1-13-1-${RUN}`;
  const BIN_C1 = `BIN-C1-13-1-${RUN}`;
  const LOTF = `LOTF-13-1-${RUN}`;
  const LOTW = `LOTW-13-1-${RUN}`;
  const SER = `SER-13-1-${RUN}`;
  const PLAIN = `PLAIN-13-1-${RUN}`;
  const CUST = `CUST-13-1-${RUN}`;
  const INACT = `INACT-13-1-${RUN}`;
  const PERF = `PERF-13-1-${RUN}`;
  const COUNTED_ON = isoDateOffset(-1);
  const EXPIRY = isoDateOffset(365);
  const TODAY = toIstCalendarDate(new Date());
  // lot_master.lot_number is globally unique, so every lot literal is run-scoped.
  const L = (n: string): string => `${n}-${RUN}`;

  let siteAId: string;
  let siteBId: string;
  let siteCId: string;
  let binA1Id: string;
  let binA2Id: string;
  let binC1Id: string;

  let leadAUserId: string;
  let leadAHeaders: Record<string, string>;
  let leadBHeaders: Record<string, string>;
  let approverUserId: string;
  let approverHeaders: Record<string, string>;
  let viewerHeaders: Record<string, string>;
  let erpHeaders: Record<string, string>;
  let gateHeaders: Record<string, string>;
  let stockHeaders: Record<string, string>;

  let firstLoadId: string;
  let resumeLoadId: string;
  let promoteEventId: string;
  const explanationIds: string[] = [];

  function row(cells: Partial<Record<(typeof OPENING_STOCK_TEMPLATE_V1)[number], string>>): string {
    const base: Record<string, string> = {
      site_code: SITE_A,
      location_code: BIN_A1,
      sku: PLAIN,
      lot_number: '',
      serial_number: '',
      quantity: '1',
      uom: 'EA',
      stock_class: 'owned',
      unit_cost: '5.0000',
      expiry_date: '',
      counted_on: COUNTED_ON,
      pv_ref_ext: `PV-${RUN}`,
      pv_line_ref_ext: '',
      ...cells,
    };
    return OPENING_STOCK_TEMPLATE_V1.map((c) => base[c] ?? '').join(',');
  }

  function csv(rows: string[]): string {
    return [HEADER, ...rows].join('\r\n') + '\r\n';
  }

  function importBody(
    fileCsv: string,
    opts: {
      mode?: 'initial' | 'correction';
      key?: string;
      site_id?: string;
      file_name?: string;
    } = {},
  ): Record<string, unknown> {
    return {
      site_id: opts.site_id ?? siteAId,
      file_name: opts.file_name ?? `opening-${run}.csv`,
      template_version: 'v1',
      mode: opts.mode ?? 'initial',
      csv: fileCsv,
      idempotency_key: opts.key ?? `13-1-${randomUUID()}`,
    };
  }

  async function seedLocation(level: string, code: string, siteId: string | null): Promise<string> {
    const locationId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', false, 'active')`,
      [locationId, code, level, siteId, siteId ?? locationId],
    );
    return locationId;
  }

  async function seedItem(
    sku: string,
    opts: {
      uom: string;
      lot: boolean;
      serial: boolean;
      method: 'fifo' | 'weighted_average' | 'specific_identification';
      status?: 'active' | 'inactive';
      stream?: string;
    },
  ): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, $2, $3, $4, false, false, false, $5, $6, $7)`,
      [
        sku,
        opts.uom,
        opts.lot,
        opts.serial,
        opts.method,
        opts.stream ?? 'production',
        opts.status ?? 'active',
      ],
    );
  }

  async function variances(query = ''): Promise<Record<string, unknown>[]> {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/opening-stock/variances?site_id=${siteAId}${query}`,
      undefined,
      leadAHeaders,
    );
    assert.strictEqual(res.status, 200, res.text);
    return res.body['variances'] as Record<string, unknown>[];
  }

  async function explain(keys: string[], causeCode = 'count_correction'): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/variances/explanations',
      {
        site_id: siteAId,
        variance_keys: keys,
        cause_code: causeCode,
        narrative: `Explained in run ${run}`,
        idempotency_key: `13-1-explain-${randomUUID()}`,
      },
      leadAHeaders,
    );
  }

  async function approve(
    explanationId: string,
    headers: Record<string, string>,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/migration/opening-stock/variances/explanations/${explanationId}/approve`,
      { idempotency_key: `13-1-approve-${randomUUID()}` },
      headers,
    );
  }

  async function promote(key: string, headers = leadAHeaders): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/promote',
      { site_id: siteAId, idempotency_key: key },
      headers,
    );
  }

  async function domainEventCount(where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../read/projections/integration_exception.sql',
      '../../read/projections/migration_import.sql',
      '../../read/projections/migration_import_rejection.sql',
      '../../read/projections/migration_opening_stock_row.sql',
      '../../read/projections/erp_stock_balance.sql',
      '../../read/projections/migration_variance_explanation.sql',
      '../../read/projections/migration_stage.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    siteAId = await seedLocation('site', SITE_A, null);
    siteBId = await seedLocation('site', SITE_B, null);
    siteCId = await seedLocation('site', SITE_C, null);
    binA1Id = await seedLocation('bin', BIN_A1, siteAId);
    binA2Id = await seedLocation('bin', BIN_A2, siteAId);
    await seedLocation('bin', BIN_B1, siteBId);
    binC1Id = await seedLocation('bin', BIN_C1, siteCId);

    await seedItem(LOTF, { uom: 'KG', lot: true, serial: false, method: 'fifo' });
    await seedItem(LOTW, { uom: 'KG', lot: true, serial: false, method: 'weighted_average' });
    await seedItem(SER, { uom: 'EA', lot: true, serial: true, method: 'specific_identification' });
    await seedItem(PLAIN, { uom: 'EA', lot: false, serial: false, method: 'weighted_average' });
    await seedItem(CUST, {
      uom: 'KG',
      lot: false,
      serial: false,
      method: 'weighted_average',
      stream: 'job_work',
    });
    await seedItem(INACT, {
      uom: 'EA',
      lot: false,
      serial: false,
      method: 'weighted_average',
      status: 'inactive',
    });
    await seedItem(PERF, { uom: 'EA', lot: true, serial: false, method: 'weighted_average' });

    const leadA = `migration-lead-a-13-1-${run}@example.com`;
    leadAUserId = await provisionUser(port, leadA, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteAId },
      { role: 'migration_lead', module: 'migration', functionScope: 'read', locationId: siteAId },
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteCId },
      { role: 'migration_lead', module: 'migration', functionScope: 'read', locationId: siteCId },
    ]);
    leadAHeaders = await authFor(port, leadA);

    const leadB = `migration-lead-b-13-1-${run}@example.com`;
    await provisionUser(port, leadB, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteBId },
      { role: 'migration_lead', module: 'migration', functionScope: 'read', locationId: siteBId },
    ]);
    leadBHeaders = await authFor(port, leadB);

    await provisionUser(port, `finance-13-1-${run}@example.com`, [
      { role: 'finance_controller', module: 'migration', functionScope: 'read', locationId: '*' },
    ]);

    const viewer = `viewer-13-1-${run}@example.com`;
    await provisionUser(port, viewer, [
      { role: 'audit_viewer', module: 'migration', functionScope: 'read', locationId: '*' },
    ]);
    viewerHeaders = await authFor(port, viewer);

    const erp = `svc-erp-13-1-${run}@example.com`;
    await provisionUser(port, erp, [
      { role: 'svc_erp_adapter', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    erpHeaders = await authFor(port, erp);

    const gate = `gate-13-1-${run}@example.com`;
    await provisionUser(port, gate, [
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateHeaders = await authFor(port, gate);

    const stock = `stock-13-1-${run}@example.com`;
    await provisionUser(port, stock, [
      {
        role: 'inventory_controller',
        module: 'inventory',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    stockHeaders = await authFor(port, stock);

    const compliance = `compliance-13-1-${run}@example.com`;
    await provisionUser(port, compliance, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    const complianceHeaders = await authFor(port, compliance);

    // Task 8.2: one band for finance_controller from value_min = 0 (never null). The transaction
    // type is global, so an earlier run's band is reused rather than duplicated.
    const band = await adminPool.query(
      `SELECT entry_id FROM doa_registry_entries WHERE transaction_type = $1 AND active = true`,
      [DOA_TYPE],
    );
    if (band.rows.length === 0) {
      const entry = await makeRequest(
        port,
        'POST',
        '/api/v1/doa/entries',
        { role: 'finance_controller', transaction_type: DOA_TYPE, value_min: 0, value_max: null },
        complianceHeaders,
      );
      assert.strictEqual(entry.status, 201, entry.text);
    }

    // `finance_controller` is a global role and outlives this run, so the holder resolveApprover
    // picks (oldest active assignment) may be an earlier run's user. Resolve the real approver the
    // way the resolver does and make sure that person can reach the migration read routes.
    const holder = await adminPool.query(
      `SELECT u.user_id, u.external_id FROM user_role_assignments a
         JOIN users u ON u.user_id = a.user_id
        WHERE a.role = 'finance_controller' AND u.active = true
        ORDER BY a.created_at ASC, a.assignment_id ASC LIMIT 1`,
    );
    approverUserId = holder.rows[0]!['user_id'] as string;
    const approverExternalId = holder.rows[0]!['external_id'] as string;
    const hasMigrationRead = await adminPool.query(
      `SELECT 1 FROM user_role_assignments WHERE user_id = $1 AND module = 'migration' AND function_scope = 'read' AND location_id = '*'`,
      [approverUserId],
    );
    if (hasMigrationRead.rows.length === 0) {
      await adminPool.query(
        `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
         VALUES ($1, 'finance_controller', 'migration', 'read', '*')`,
        [approverUserId],
      );
    }
    approverHeaders = await authFor(port, approverExternalId);
    assert.notEqual(approverUserId, leadAUserId);
  });

  after(async () => {
    delete openingStockImportTestHooks.beforeRow;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: a clean v1 file loads by location, lot and serial with its PV attribution
  // -------------------------------------------------------------------------

  it('AC1: a clean v1 file loads every row with its physical-verification reference', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(
        csv([
          row({
            sku: LOTF,
            lot_number: L('L1'),
            quantity: '100.000000',
            uom: 'KG',
            unit_cost: '10.0000',
            expiry_date: EXPIRY,
            pv_line_ref_ext: '1',
          }),
          row({
            sku: LOTW,
            lot_number: L('L2'),
            quantity: '50',
            uom: 'KG',
            unit_cost: '20.0000',
            pv_line_ref_ext: '2',
          }),
          row({
            sku: SER,
            lot_number: L('LS1'),
            serial_number: 'S1',
            quantity: '1',
            uom: 'EA',
            unit_cost: '500.0000',
            pv_line_ref_ext: '3',
          }),
          row({ sku: PLAIN, quantity: '30', unit_cost: '5.0000', pv_line_ref_ext: '4' }),
          row({
            location_code: BIN_A2,
            sku: CUST,
            quantity: '7',
            uom: 'KG',
            stock_class: 'job_work',
            unit_cost: '61.0000',
            pv_line_ref_ext: '5',
          }),
        ]),
      ),
      leadAHeaders,
    );
    assert.strictEqual(res.status, 201, res.text);
    firstLoadId = res.body['load_id'] as string;
    assert.strictEqual(res.body['row_count'], 5);
    assert.strictEqual(res.body['accepted_count'], 5);
    assert.strictEqual(res.body['rejected_count'], 0);
    assert.strictEqual(res.body['suppressed_count'], 0);

    const rows = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/opening-stock/rows?site_id=${siteAId}&load_id=${firstLoadId}`,
      undefined,
      leadAHeaders,
    );
    assert.strictEqual(rows.status, 200, rows.text);
    const list = rows.body['rows'] as Record<string, unknown>[];
    assert.strictEqual(list.length, 5);
    for (const r of list) {
      assert.strictEqual(r['pv_ref_ext'], `PV-${RUN}`);
      assert.strictEqual(r['counted_on'], COUNTED_ON);
      assert.strictEqual(r['status'], 'accepted');
    }
    const ser = list.find((r) => r['sku'] === SER)!;
    assert.strictEqual(ser['lot_number'], L('LS1'));
    assert.strictEqual(ser['serial_number'], 'S1');
    assert.strictEqual(ser['location_id'], binA1Id);
    const cust = list.find((r) => r['sku'] === CUST)!;
    assert.strictEqual(cust['unit_cost'], null, 'a job_work row is never valued');
    assert.strictEqual(cust['declared_unit_cost'], '61.000000');

    const header = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/opening-stock/imports/${firstLoadId}`,
      undefined,
      leadAHeaders,
    );
    assert.strictEqual(header.status, 200, header.text);
    assert.strictEqual(header.body['accepted_count'], 5);
    assert.strictEqual(header.body['mode'], 'initial');
  });

  it('AC1: the stage of a site with no promotion reads as staging', async () => {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/stages?site_id=${siteAId}`,
      undefined,
      leadAHeaders,
    );
    assert.strictEqual(res.status, 200, res.text);
    const stages = res.body['stages'] as Record<string, unknown>[];
    assert.strictEqual(stages.find((s) => s['domain'] === 'opening_stock')!['stage'], 'staging');
  });

  // -------------------------------------------------------------------------
  // AC 4 / AC 5: malformed, unknown and duplicate rows are rejected row by row
  // -------------------------------------------------------------------------

  it('AC4/AC5: each failing row is rejected with its code and details while good rows still load', async () => {
    const file = csv([
      row({ sku: LOTF, lot_number: L('LBAD'), quantity: 'abc', uom: 'KG', unit_cost: '10.0000' }), // line 2
      row({ location_code: `BIN-ZZ-${RUN}`, quantity: '3' }), // line 3
      row({ sku: `NOPE-${RUN}`, quantity: '3' }), // line 4
      row({ sku: INACT, quantity: '3' }), // line 5
      row({ sku: PLAIN, lot_number: L('LX'), quantity: '3' }), // line 6
      row({ sku: LOTF, lot_number: L('L7'), quantity: '3', uom: 'KG', unit_cost: '' }), // line 7
      row({ sku: LOTF, lot_number: L('L3'), quantity: '10', uom: 'KG', unit_cost: '10.0000' }), // line 8 (good)
      row({ sku: LOTF, lot_number: L('L3'), quantity: '12', uom: 'KG', unit_cost: '10.0000' }), // line 9
      row({
        sku: SER,
        lot_number: L('LX'),
        serial_number: 'S9',
        quantity: '1',
        uom: 'EA',
        unit_cost: '500.0000',
      }), // line 10 (good)
      row({
        sku: SER,
        lot_number: L('LY'),
        serial_number: 'S9',
        quantity: '1',
        uom: 'EA',
        unit_cost: '500.0000',
      }), // line 11
      row({
        sku: SER,
        lot_number: L('LZ'),
        serial_number: 'S8',
        quantity: '2',
        uom: 'EA',
        unit_cost: '500.0000',
      }), // line 12
      row({ location_code: BIN_B1, quantity: '3' }), // line 13
    ]);
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(file, { file_name: `mixed-${run}.csv` }),
      leadAHeaders,
    );
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body['row_count'], 12);
    assert.strictEqual(res.body['accepted_count'], 2);
    assert.strictEqual(res.body['rejected_count'], 10);
    const rejections = res.body['rejections'] as Record<string, unknown>[];
    const byLine = new Map(rejections.map((r) => [r['line_no'] as number, r]));
    const expect = (line: number, code: string, detail: Record<string, unknown>) => {
      const r = byLine.get(line);
      assert.ok(r, `line ${line} should be rejected`);
      assert.strictEqual(r['error_code'], code, `line ${line}: ${JSON.stringify(r)}`);
      for (const [k, v] of Object.entries(detail)) {
        assert.strictEqual(detailsOf(r)[k], v, `line ${line} details.${k}`);
      }
      assert.ok(typeof r['raw_row'] === 'string' && (r['raw_row'] as string).length > 0);
    };
    expect(2, 'MALFORMED_ROW', { column: 'quantity' });
    expect(3, 'UNKNOWN_REFERENCE', { reference: 'location_code' });
    expect(4, 'UNKNOWN_REFERENCE', { reference: 'sku' });
    expect(5, 'UNKNOWN_REFERENCE', { reference: 'sku' });
    expect(6, 'MALFORMED_ROW', { column: 'lot_number' });
    expect(7, 'MALFORMED_ROW', { column: 'unit_cost' });
    expect(9, 'DUPLICATE_LOT_SERIAL', { first_line_no: 8 });
    expect(11, 'DUPLICATE_LOT_SERIAL', { first_line_no: 10, scope: 'serial' });
    expect(12, 'MALFORMED_ROW', { column: 'quantity' });
    expect(13, 'UNKNOWN_REFERENCE', { reference: 'location_code' });
    assert.ok(!byLine.has(8) && !byLine.has(10));

    const report = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/opening-stock/imports/${res.body['load_id'] as string}`,
      undefined,
      leadAHeaders,
    );
    assert.strictEqual(report.status, 200, report.text);
    assert.strictEqual(report.body['file_name'], `mixed-${run}.csv`);
    assert.strictEqual((report.body['rejections'] as unknown[]).length, 10);
  });

  it('AC4: a file whose header is not the v1 contract is refused whole', async () => {
    const wrong = OPENING_STOCK_TEMPLATE_V1.map((c) => (c === 'quantity' ? 'qty' : c)).join(',');
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(`${wrong}\n${row({ quantity: '3' })}\n`),
      leadAHeaders,
    );
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body['error_code'], 'TEMPLATE_VERSION_UNSUPPORTED');
    assert.deepEqual(detailsOf(res.body)['expected_header'], [...OPENING_STOCK_TEMPLATE_V1]);
    const rows = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/opening-stock/rows?site_id=${siteAId}`,
      undefined,
      leadAHeaders,
    );
    assert.strictEqual(rows.body['total'], 7, 'nothing from the refused file loaded');
  });

  it('AC4: a row-level parse error is a MALFORMED_ROW and the rest of the file loads', async () => {
    const good = row({ location_code: BIN_A2, sku: PLAIN, quantity: '4' });
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(`${HEADER}\n"unterminated,${good}\n${good}\n`),
      leadAHeaders,
    );
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body['accepted_count'], 1);
    const rejection = (res.body['rejections'] as Record<string, unknown>[])[0]!;
    assert.strictEqual(rejection['error_code'], 'MALFORMED_ROW');
    assert.strictEqual(rejection['line_no'], 2);
  });

  // -------------------------------------------------------------------------
  // AC 6: a failed run resumes without duplicating rows; corrections supersede
  // -------------------------------------------------------------------------

  const resumeRows = () =>
    [1, 2, 3, 4, 5, 6].map((n) =>
      row({
        location_code: BIN_A2,
        sku: LOTF,
        lot_number: L(`L1${n - 1}`),
        quantity: String(n),
        uom: 'KG',
        unit_cost: '10.0000',
      }),
    );

  it('AC6: a run that dies after three rows resumes with those three suppressed as DUPLICATE_EVENT', async () => {
    openingStockImportTestHooks.beforeRow = (index) => {
      if (index === 3) throw new Error('injected crash after row 3');
    };
    const key = `13-1-resume-${run}`;
    try {
      const crashed = await makeRequest(
        port,
        'POST',
        '/api/v1/migration/opening-stock/imports',
        importBody(csv(resumeRows()), { key }),
        leadAHeaders,
      );
      assert.strictEqual(crashed.status, 500, crashed.text);
    } finally {
      delete openingStockImportTestHooks.beforeRow;
    }
    const headers = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM migration_import WHERE idempotency_key = $1`,
      [key],
    );
    assert.strictEqual(headers.rows[0]!['n'], 0, 'no header before the completion event');

    const resumed = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(csv(resumeRows()), { key }),
      leadAHeaders,
    );
    assert.strictEqual(resumed.status, 201, resumed.text);
    resumeLoadId = resumed.body['load_id'] as string;
    assert.strictEqual(resumed.body['suppressed_count'], 3);
    assert.strictEqual(resumed.body['accepted_count'], 3);
    assert.deepEqual(
      (resumed.body['suppressed'] as Record<string, unknown>[]).map((s) => s['line_no']),
      [2, 3, 4],
    );
    assert.deepEqual(
      (resumed.body['accepted'] as Record<string, unknown>[]).map((s) => s['line_no']),
      [5, 6, 7],
    );
    const headerCount = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM migration_import WHERE idempotency_key = $1`,
      [key],
    );
    assert.strictEqual(headerCount.rows[0]!['n'], 1);
    assert.strictEqual(
      await domainEventCount(
        `event_type = 'migration.opening_stock.loaded' AND payload->>'site_id' = $1 AND payload->>'sku' = $2 AND payload->>'location_id' = $3`,
        [siteAId, LOTF, binA2Id],
      ),
      6,
      'exactly six row events across both attempts',
    );

    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(csv(resumeRows()), { key }),
      leadAHeaders,
    );
    assert.strictEqual(replay.status, 200, replay.text);
    assert.strictEqual(replay.body['replayed'], true);
    assert.strictEqual(replay.body['load_id'], resumeLoadId);
  });

  it('AC6: a correction file supersedes the live row; the same grain in initial mode is DUPLICATE_LOT_SERIAL', async () => {
    const corrected = row({
      location_code: BIN_A2,
      sku: LOTF,
      lot_number: L('L11'),
      quantity: '20',
      uom: 'KG',
      unit_cost: '10.0000',
    });
    const correction = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(csv([corrected]), { mode: 'correction' }),
      leadAHeaders,
    );
    assert.strictEqual(correction.status, 201, correction.text);
    assert.strictEqual(correction.body['accepted_count'], 1);
    assert.strictEqual(correction.body['superseded_count'], 1);

    const live = await getAdminPool().query(
      `SELECT row_id, status, quantity::text AS quantity, superseded_by_row_id
         FROM migration_opening_stock_row
        WHERE site_id = $1 AND sku = $2 AND lot_number = $3 ORDER BY created_at`,
      [siteAId, LOTF, L('L11')],
    );
    assert.strictEqual(live.rows.length, 2);
    assert.strictEqual(live.rows[0]!['status'], 'superseded');
    assert.strictEqual(live.rows[0]!['superseded_by_row_id'], live.rows[1]!['row_id']);
    assert.strictEqual(live.rows[1]!['status'], 'accepted');
    assert.strictEqual(live.rows[1]!['quantity'], '20.000000');

    const again = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(
        csv([
          row({
            location_code: BIN_A2,
            sku: LOTF,
            lot_number: L('L11'),
            quantity: '21',
            uom: 'KG',
            unit_cost: '10.0000',
          }),
        ]),
      ),
      leadAHeaders,
    );
    assert.strictEqual(again.status, 201, again.text);
    const rejection = (again.body['rejections'] as Record<string, unknown>[])[0]!;
    assert.strictEqual(rejection['error_code'], 'DUPLICATE_LOT_SERIAL');
    assert.strictEqual(detailsOf(rejection)['existing_row_id'], live.rows[1]!['row_id']);
  });

  it('AC6: a serial already loaded in another bin is DUPLICATE_LOT_SERIAL', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(
        csv([
          row({
            location_code: BIN_A2,
            sku: SER,
            lot_number: L('LS1'),
            serial_number: 'S1',
            quantity: '1',
            uom: 'EA',
            unit_cost: '500.0000',
          }),
        ]),
      ),
      leadAHeaders,
    );
    assert.strictEqual(res.status, 201, res.text);
    const rejection = (res.body['rejections'] as Record<string, unknown>[])[0]!;
    assert.strictEqual(rejection['error_code'], 'DUPLICATE_LOT_SERIAL');
    assert.strictEqual(detailsOf(rejection)['scope'], 'serial');
  });

  // -------------------------------------------------------------------------
  // AC 2: the variance report against ERP and legacy snapshots
  // -------------------------------------------------------------------------

  it('AC2: ERP and legacy snapshots ingest through the sync trigger, unmapped rows queue an exception', async () => {
    const snap = new Date().toISOString();
    const erp = (o: Record<string, unknown>) => ({
      source_system: 'ERP',
      site_code_ext: SITE_A,
      snapshot_at: snap,
      ...o,
    });
    const legacy = (o: Record<string, unknown>) => ({
      source_system: 'LEGACY',
      site_code_ext: SITE_A,
      snapshot_at: snap,
      ...o,
    });
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/erp/sync',
      {
        stock_balances: [
          erp({
            location_code: BIN_A1,
            sku: LOTF,
            lot_number_ext: L('L1'),
            quantity: '100',
            unit_cost: '10',
          }),
          erp({
            location_code: BIN_A1,
            sku: LOTW,
            lot_number_ext: L('L2'),
            quantity: '45',
            unit_cost: '20',
          }),
          erp({
            location_code: BIN_A1,
            sku: LOTW,
            lot_number_ext: L('L99'),
            quantity: '3',
            unit_cost: '20',
          }),
          erp({
            location_code: BIN_A1,
            sku: SER,
            lot_number_ext: L('LS1'),
            serial_number_ext: 'S1',
            quantity: '1',
            unit_cost: '500',
          }),
          erp({
            location_code: BIN_A1,
            sku: SER,
            lot_number_ext: L('LS1'),
            serial_number_ext: 'S2',
            quantity: '1',
            unit_cost: '500',
          }),
          erp({ location_code: BIN_A1, sku: PLAIN, quantity: '30', unit_cost: '5' }),
          erp({ location_code: BIN_A2, sku: PLAIN, quantity: '4', unit_cost: '5' }),
          erp({ location_code: BIN_A2, sku: CUST, quantity: '5', unit_cost: '61' }),
          ...[1, 20, 3, 4, 5, 6].map((q, i) =>
            erp({
              location_code: BIN_A2,
              sku: LOTF,
              lot_number_ext: L(`L1${i}`),
              quantity: String(q),
              unit_cost: '10',
            }),
          ),
          erp({ location_code: `BIN-ZZ-${RUN}`, sku: PLAIN, quantity: '9', unit_cost: '5' }),
          legacy({ location_code: BIN_A1, sku: LOTF, quantity: '110', unit_cost: '10' }),
          legacy({ location_code: BIN_A1, sku: LOTW, quantity: '40', unit_cost: '20' }),
          legacy({ location_code: BIN_A1, sku: SER, quantity: '2' }),
          legacy({ location_code: BIN_A1, sku: PLAIN, quantity: '30' }),
          legacy({ location_code: BIN_A2, sku: PLAIN, quantity: '4' }),
          legacy({ location_code: BIN_A2, sku: CUST, quantity: '7' }),
          legacy({ location_code: BIN_A2, sku: LOTF, quantity: '39' }),
          {
            source_system: 'ERP',
            site_code_ext: SITE_A,
            location_code: BIN_A1,
            sku: PLAIN,
            quantity: 'not-a-number',
            snapshot_at: snap,
          },
        ],
      },
      erpHeaders,
    );
    assert.strictEqual(res.status, 200, res.text);
    const result = res.body['stock_balances'] as Record<string, number>;
    assert.strictEqual(result['applied'], 22);
    assert.strictEqual(result['unmapped'], 1);
    assert.strictEqual(result['failed'], 1);

    const state = await getAdminPool().query(
      `SELECT status FROM erp_sync_state WHERE projection_name = 'stock_balances'`,
    );
    assert.strictEqual(state.rows[0]!['status'], 'success');
    const exceptions = await getAdminPool().query(
      `SELECT error_code FROM integration_exception
        WHERE record_type = 'stock_balance' AND status = 'open' AND source_record_ref LIKE $1`,
      [`${SITE_A}|%`],
    );
    assert.deepEqual(exceptions.rows.map((r) => r['error_code']).sort(), [
      'INVALID_PARAMS',
      'UNKNOWN_REFERENCE',
    ]);

    const empty = await makeRequest(
      port,
      'POST',
      '/api/v1/erp/sync',
      { stock_balances: [] },
      erpHeaders,
    );
    assert.strictEqual(empty.status, 200, empty.text);
    assert.deepEqual(empty.body['stock_balances'], { applied: 0, failed: 0, unmapped: 0 });
  });

  it('AC2: the report lists every variance kind with a deterministic key and NUMERIC-string values', async () => {
    const list = await variances();
    const byKey = new Map(list.map((v) => [v['variance_key'] as string, v]));
    const expectKind = (key: string, kind: string) => {
      const v = byKey.get(key);
      assert.ok(v, `expected variance ${key}; have ${[...byKey.keys()].join(', ')}`);
      assert.strictEqual(v['kind'], kind, key);
      return v;
    };
    const mismatch = expectKind(`ERP|${BIN_A1}|${LOTW}|${L('L2')}|-`, 'quantity_mismatch');
    assert.strictEqual(mismatch['imported_quantity'], '50.000000');
    assert.strictEqual(mismatch['source_quantity'], '45.000000');
    assert.strictEqual(mismatch['quantity_delta'], '5.000000');
    assert.strictEqual(mismatch['variance_value'], '100.00');
    assert.strictEqual(mismatch['status'], 'open');
    assert.strictEqual(typeof mismatch['variance_value'], 'string');

    const missingImport = expectKind(`ERP|${BIN_A1}|${LOTW}|${L('L99')}|-`, 'missing_in_import');
    assert.strictEqual(missingImport['quantity_delta'], '-3.000000');
    assert.strictEqual(missingImport['variance_value'], '-60.00');

    expectKind(`ERP|${BIN_A1}|${LOTF}|${L('L3')}|-`, 'missing_in_source');
    expectKind(`ERP|${BIN_A1}|${SER}|-|S2`, 'serial_missing_in_import');
    expectKind(`ERP|${BIN_A1}|${SER}|-|S9`, 'serial_missing_in_source');
    expectKind(`ERP|BIN-ZZ-${RUN}|${PLAIN}|-|-`, 'unmapped_source_row');

    const jobWork = expectKind(`ERP|${BIN_A2}|${CUST}|-|-`, 'quantity_mismatch');
    assert.strictEqual(jobWork['quantity_delta'], '2.000000');
    assert.strictEqual(
      jobWork['variance_value'],
      '0',
      'customer-owned material reports zero value',
    );
    assert.strictEqual(jobWork['banding_value'], '122.00');

    const legacyLotw = expectKind(`LEGACY|${BIN_A1}|${LOTW}|-|-`, 'quantity_mismatch');
    assert.strictEqual(legacyLotw['quantity_delta'], '10.000000');
    assert.ok(
      !byKey.has(`LEGACY|${BIN_A1}|${LOTF}|-|-`),
      'lots aggregate against a lot-less legacy row',
    );
    assert.ok(
      !byKey.has(`LEGACY|${BIN_A1}|${SER}|-|-`),
      'serials aggregate against a serial-less legacy row',
    );
    assert.ok(!byKey.has(`ERP|${BIN_A1}|${LOTF}|${L('L1')}|-`));
    assert.ok(
      ![...byKey.keys()].some((k) => k.includes(`${BIN_A2}|${LOTF}|`)),
      'the corrected lot matches',
    );

    const filtered = await variances('&source_system=LEGACY&status=open');
    assert.ok(filtered.every((v) => v['source_system'] === 'LEGACY' && v['status'] === 'open'));
    const totals = (
      await makeRequest(
        port,
        'GET',
        `/api/v1/migration/opening-stock/variances?site_id=${siteAId}`,
        undefined,
        leadAHeaders,
      )
    ).body['totals'] as Record<string, unknown>;
    assert.strictEqual(totals['open_count'], list.length);
    assert.match(totals['open_value'] as string, /^\d+\.\d{2}$/);
  });

  // -------------------------------------------------------------------------
  // AC 3: promotion blocks on unexplained variances, in the handler AND in the applier
  // -------------------------------------------------------------------------

  it('AC3: promotion with open variances is 409 VARIANCE_UNRESOLVED listing each one', async () => {
    const res = await promote(`13-1-promote-early-${run}`);
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body['error_code'], 'VARIANCE_UNRESOLVED');
    const unexplained = detailsOf(res.body)['unexplained'] as Record<string, unknown>[];
    assert.ok(
      unexplained.some(
        (u) => u['variance_key'] === `ERP|${BIN_A1}|${LOTW}|${L('L2')}|-` && u['status'] === 'open',
      ),
    );
    assert.ok(
      unexplained.every((u) => 'kind' in u && 'quantity_delta' in u && 'variance_value' in u),
    );
  });

  it('AC3: the gate lives in the applier - a direct migration.stage.promoted persist is refused', async () => {
    await assert.rejects(
      persistEvent({
        stream_type: 'migration',
        stream_id: siteAId,
        event_type: 'migration.stage.promoted',
        payload: {
          site_id: siteAId,
          domain: 'opening_stock',
          from_stage: 'staging',
          to_stage: 'dry_run',
          accepted_row_count: 1,
          business_date: TODAY,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: leadAUserId, role: 'migration_lead', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: `13-1-direct-promote-${run}`,
      }),
      (err: unknown) => (err as { errorCode: string }).errorCode === 'VARIANCE_UNRESOLVED',
    );
    assert.strictEqual(
      await domainEventCount(`idempotency_key = $1`, [`13-1-direct-promote-${run}`]),
      0,
    );
    const stage = await getAdminPool().query(
      `SELECT stage FROM migration_stage WHERE site_id = $1 AND domain = 'opening_stock'`,
      [siteAId],
    );
    assert.notEqual(stage.rows[0]?.['stage'], 'dry_run');
  });

  it('AC3: an explanation is pending until the frozen approver signs it; the gate still blocks', async () => {
    const key = `ERP|${BIN_A1}|${LOTW}|${L('L2')}|-`;
    const res = await explain([key], 'legacy_unrecorded_issue');
    assert.strictEqual(res.status, 201, res.text);
    const explanation = (res.body['explanations'] as Record<string, unknown>[])[0]!;
    assert.strictEqual(explanation['status'], 'pending_approval');
    assert.strictEqual(explanation['approver_actor_id'], approverUserId);
    assert.strictEqual(explanation['explained_by_actor_id'], leadAUserId);
    assert.strictEqual(explanation['explained_quantity_delta'], '5.000000');
    assert.strictEqual(explanation['explained_value'], '100.00');
    explanationIds.push(explanation['explanation_id'] as string);

    // The identity checks live in the applier too: a direct persist naming a non-approver actor
    // (or the explainer) is refused before any event row exists, whatever the route did.
    const directApproval = (actorId: string, suffix: string) =>
      persistEvent({
        stream_type: 'migration',
        stream_id: siteAId,
        event_type: 'migration.variance.explanation_approved',
        payload: {
          site_id: siteAId,
          explanation_id: explanation['explanation_id'],
          business_date: TODAY,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: actorId, role: 'finance_controller', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: `13-1-direct-approve-${suffix}-${run}`,
      });
    await assert.rejects(
      directApproval(randomUUID(), 'stranger'),
      (err: unknown) => (err as { errorCode: string }).errorCode === 'APPROVAL_REQUIRED',
    );
    await assert.rejects(
      directApproval(leadAUserId, 'explainer'),
      (err: unknown) => (err as { errorCode: string }).errorCode === 'EXPLAINER_CANNOT_APPROVE',
    );
    assert.strictEqual(
      await domainEventCount(`idempotency_key LIKE $1`, [`13-1-direct-approve-%-${run}`]),
      0,
    );

    const pending = (await variances()).find((v) => v['variance_key'] === key)!;
    assert.strictEqual(pending['status'], 'pending_approval');
    const blocked = await promote(`13-1-promote-pending-${run}`);
    assert.strictEqual(blocked.status, 409, blocked.text);
    assert.ok(
      (detailsOf(blocked.body)['unexplained'] as Record<string, unknown>[]).some(
        (u) => u['variance_key'] === key && u['status'] === 'pending_approval',
      ),
    );

    const twice = await explain([key]);
    assert.strictEqual(twice.status, 409, twice.text);
    assert.strictEqual(twice.body['error_code'], 'INVALID_STATE');
    const missing = await explain([`ERP|${BIN_A1}|${LOTW}|NOPE|-`]);
    assert.strictEqual(missing.status, 404, missing.text);
    assert.strictEqual(missing.body['error_code'], 'VARIANCE_NOT_FOUND');
  });

  it('AC3: the explainer cannot approve, a non-approver cannot approve, the approver can', async () => {
    const id = explanationIds[0]!;
    const self = await approve(id, leadAHeaders);
    assert.strictEqual(self.status, 403, self.text);
    assert.strictEqual(self.body['error_code'], 'EXPLAINER_CANNOT_APPROVE');

    const other = await approve(id, viewerHeaders);
    assert.strictEqual(other.status, 403, other.text);
    assert.strictEqual(other.body['error_code'], 'APPROVAL_REQUIRED');
    assert.strictEqual(detailsOf(other.body)['approver_actor_id'], approverUserId);

    const forged = await makeRequest(
      port,
      'POST',
      `/api/v1/migration/opening-stock/variances/explanations/${id}/approve`,
      { idempotency_key: `13-1-forged-${run}`, approver_actor_id: approverUserId },
      viewerHeaders,
    );
    assert.strictEqual(forged.status, 403, forged.text);

    const ok = await approve(id, approverHeaders);
    assert.strictEqual(ok.status, 200, ok.text);
    const explanation = ok.body['explanation'] as Record<string, unknown>;
    assert.strictEqual(explanation['status'], 'approved');
    assert.ok(explanation['approved_event_id']);
    const explained = (await variances()).find(
      (v) => v['variance_key'] === `ERP|${BIN_A1}|${LOTW}|${L('L2')}|-`,
    )!;
    assert.strictEqual(explained['status'], 'explained');

    const again = await approve(id, approverHeaders);
    assert.strictEqual(again.status, 409, again.text);
    assert.strictEqual(again.body['error_code'], 'INVALID_STATE');
  });

  it('AC3: a corrected row that changes the delta makes the explanation stale; one that removes the variance unblocks it', async () => {
    const key = `ERP|${BIN_A1}|${LOTW}|${L('L2')}|-`;
    const stale = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(
        csv([
          row({ sku: LOTW, lot_number: L('L2'), quantity: '48', uom: 'KG', unit_cost: '20.0000' }),
        ]),
        { mode: 'correction' },
      ),
      leadAHeaders,
    );
    assert.strictEqual(stale.status, 201, stale.text);
    assert.strictEqual(stale.body['superseded_count'], 1);
    const staleVariance = (await variances()).find((v) => v['variance_key'] === key)!;
    assert.strictEqual(staleVariance['status'], 'stale');
    assert.strictEqual(staleVariance['quantity_delta'], '3.000000');
    const blocked = await promote(`13-1-promote-stale-${run}`);
    assert.strictEqual(blocked.status, 409, blocked.text);
    assert.ok(
      (detailsOf(blocked.body)['unexplained'] as Record<string, unknown>[]).some(
        (u) => u['variance_key'] === key && u['status'] === 'stale',
      ),
    );

    const fixed = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(
        csv([
          row({ sku: LOTW, lot_number: L('L2'), quantity: '45', uom: 'KG', unit_cost: '20.0000' }),
        ]),
        { mode: 'correction' },
      ),
      leadAHeaders,
    );
    assert.strictEqual(fixed.status, 201, fixed.text);
    assert.ok(
      !(await variances()).some((v) => v['variance_key'] === key),
      'the corrected row removed the variance',
    );
  });

  it('AC3: once every remaining variance is explained and approved, promotion succeeds', async () => {
    const open = (await variances()).filter((v) => v['status'] !== 'explained');
    assert.ok(open.length > 0);
    assert.ok(
      open.some((v) => v['variance_value'] === '0'),
      'the zero-valued job_work variance is among them',
    );
    const res = await explain(
      open.map((v) => v['variance_key'] as string),
      'other',
    );
    assert.strictEqual(res.status, 201, res.text);
    const explanations = res.body['explanations'] as Record<string, unknown>[];
    assert.strictEqual(explanations.length, open.length);
    for (const e of explanations) {
      const ok = await approve(e['explanation_id'] as string, approverHeaders);
      assert.strictEqual(ok.status, 200, ok.text);
    }
    assert.ok((await variances()).every((v) => v['status'] === 'explained'));

    const promoted = await promote(`13-1-promote-${run}`);
    assert.strictEqual(promoted.status, 200, promoted.text);
    assert.strictEqual(promoted.body['stage'], 'dry_run');
    promoteEventId = promoted.body['event_id'] as string;
    console.log(
      `[story-13-1] promoted ${String(promoted.body['posted_row_count'])} rows in ${String(promoted.body['duration_ms'])} ms`,
    );
  });

  // -------------------------------------------------------------------------
  // Posting assertions (Task 9.7)
  // -------------------------------------------------------------------------

  it('POST: promotion posted balances, lots, serials, valuation and genealogy exactly once', async () => {
    const admin = getAdminPool();
    const balance = async (sku: string, locationId: string, lot: string | null, cls = 'owned') => {
      const r = await admin.query(
        `SELECT on_hand::text AS on_hand FROM stock_balance
          WHERE sku = $1 AND location_id = $2 AND lot_id IS NOT DISTINCT FROM $3 AND stock_class = $4`,
        [sku, locationId, lot, cls],
      );
      return r.rows[0]?.['on_hand'] as string | undefined;
    };
    assert.strictEqual(await balance(LOTF, binA1Id, L('L1')), '100.000000');
    assert.strictEqual(await balance(LOTF, binA1Id, L('L3')), '10.000000');
    assert.strictEqual(await balance(LOTW, binA1Id, L('L2')), '45.000000');
    assert.strictEqual(await balance(SER, binA1Id, L('LS1')), '1.000000');
    assert.strictEqual(await balance(PLAIN, binA1Id, null), '30.000000');
    assert.strictEqual(await balance(PLAIN, binA2Id, null), '4.000000');
    assert.strictEqual(await balance(CUST, binA2Id, null, 'job_work'), '7.000000');
    assert.strictEqual(await balance(LOTF, binA2Id, L('L11')), '20.000000');

    const lot = await admin.query(
      `SELECT lot_id, expiry_date::text AS expiry_date FROM lot_master WHERE lot_number = $2 AND sku = $1`,
      [LOTF, L('L1')],
    );
    assert.strictEqual(lot.rows[0]!['expiry_date'], EXPIRY);
    const serial = await admin.query(
      `SELECT lot_id, current_location_id FROM serial_master WHERE sku = $1 AND serial_number = 'S1'`,
      [SER],
    );
    assert.strictEqual(serial.rows[0]!['lot_id'], L('LS1'));
    assert.strictEqual(serial.rows[0]!['current_location_id'], binA1Id);

    const valuation = await admin.query(
      `SELECT quantity_on_hand::text AS q, running_average_cost::text AS avg FROM inventory_valuation WHERE sku = $1`,
      [LOTW],
    );
    assert.strictEqual(Number(valuation.rows[0]!['q']), 45);
    assert.strictEqual(Number(valuation.rows[0]!['avg']), 20);
    const layers = await admin.query(
      `SELECT count(*)::int AS n FROM inventory_valuation_fifo_layer WHERE sku = $1 AND remaining_quantity > 0`,
      [LOTF],
    );
    assert.strictEqual(layers.rows[0]!['n'], 8);
    const serialCost = await admin.query(
      `SELECT unit_cost::text AS c FROM inventory_valuation_serial_cost WHERE sku = $1 AND serial_number = 'S1'`,
      [SER],
    );
    assert.strictEqual(Number(serialCost.rows[0]!['c']), 500);
    const custValuation = await admin.query(`SELECT 1 FROM inventory_valuation WHERE sku = $1`, [
      CUST,
    ]);
    assert.strictEqual(custValuation.rows.length, 0, 'job_work stock is never valued');

    const posted = await admin.query(
      `SELECT row_id, source_event_id, lot_number, status, posted_event_id
         FROM migration_opening_stock_row WHERE site_id = $1 AND status <> 'superseded'`,
      [siteAId],
    );
    assert.ok(
      posted.rows.every((r) => r['status'] === 'posted' && r['posted_event_id'] === promoteEventId),
    );
    const lotRows = posted.rows.filter((r) => r['lot_number'] !== null);
    const traces = await admin.query(
      `SELECT count(*)::int AS n FROM lot_trace WHERE event_id = ANY($1::uuid[])`,
      [lotRows.map((r) => r['source_event_id'])],
    );
    assert.strictEqual(
      traces.rows[0]!['n'],
      lotRows.length,
      'one genealogy origin row per lot, keyed on its load event',
    );

    const stage = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/stages?site_id=${siteAId}`,
      undefined,
      leadAHeaders,
    );
    const os = (stage.body['stages'] as Record<string, unknown>[]).find(
      (s) => s['domain'] === 'opening_stock',
    )!;
    assert.strictEqual(os['stage'], 'dry_run');
    assert.strictEqual(os['posted_row_count'], posted.rows.length);
  });

  it('POST: a promoted FIFO lot can be issued through the existing stock.issued path', async () => {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        stream_type: 'inventory',
        stream_id: randomUUID(),
        event_type: 'stock.issued',
        payload: {
          sku: LOTF,
          target_location_id: binA1Id,
          quantity: 1,
          lot_id: L('L1'),
          business_stream: 'production',
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: randomUUID(), role: 'inventory_controller', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
      },
      stockHeaders,
    );
    assert.strictEqual(res.status, 201, res.text);
    const balance = await getAdminPool().query(
      `SELECT on_hand::text AS on_hand FROM stock_balance WHERE sku = $1 AND location_id = $2 AND lot_id = $3`,
      [LOTF, binA1Id, L('L1')],
    );
    assert.strictEqual(balance.rows[0]!['on_hand'], '99.000000');
  });

  it('POST: a promoted site takes no further files and a promote replay posts nothing twice', async () => {
    const locked = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(csv([row({ location_code: BIN_A2, sku: PLAIN, quantity: '1' })])),
      leadAHeaders,
    );
    assert.strictEqual(locked.status, 409, locked.text);
    assert.strictEqual(locked.body['error_code'], 'STAGE_LOCKED');
    const lockedCorrection = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(csv([row({ location_code: BIN_A2, sku: PLAIN, quantity: '1' })]), {
        mode: 'correction',
      }),
      leadAHeaders,
    );
    assert.strictEqual(lockedCorrection.body['error_code'], 'STAGE_LOCKED');

    const before = await getAdminPool().query(
      `SELECT sum(on_hand)::text AS total FROM stock_balance WHERE location_id = ANY($1::uuid[])`,
      [[binA1Id, binA2Id]],
    );
    const replay = await promote(`13-1-promote-${run}`);
    assert.strictEqual(replay.status, 200, replay.text);
    assert.strictEqual(replay.body['replayed'], true);
    assert.strictEqual(replay.body['event_id'], promoteEventId);
    const after = await getAdminPool().query(
      `SELECT sum(on_hand)::text AS total FROM stock_balance WHERE location_id = ANY($1::uuid[])`,
      [[binA1Id, binA2Id]],
    );
    assert.strictEqual(after.rows[0]!['total'], before.rows[0]!['total']);
    const second = await promote(`13-1-promote-second-${run}`);
    assert.strictEqual(second.status, 409, second.text);
    assert.strictEqual(second.body['error_code'], 'STAGE_LOCKED');
  });

  // -------------------------------------------------------------------------
  // Security arms (Task 9.8)
  // -------------------------------------------------------------------------

  it('SEC: a migration lead scoped to another site, and a role without the module, are refused', async () => {
    const crossSite = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(csv([row({ quantity: '1' })])),
      leadBHeaders,
    );
    assert.strictEqual(crossSite.status, 403, crossSite.text);
    assert.strictEqual(crossSite.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const crossRead = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/opening-stock/variances?site_id=${siteAId}`,
      undefined,
      leadBHeaders,
    );
    assert.strictEqual(crossRead.status, 403, crossRead.text);
    const noModule = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/stages?site_id=${siteAId}`,
      undefined,
      gateHeaders,
    );
    assert.strictEqual(noModule.status, 403, noModule.text);
    assert.strictEqual(noModule.body['error_code'], 'MODULE_ACCESS_DENIED');
    const noModuleWrite = await promote(`13-1-gate-${run}`, gateHeaders);
    assert.strictEqual(noModuleWrite.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('SEC: both event doors refuse the migration stream before any idempotency key is consumed', async () => {
    const key = `13-1-door-${randomUUID()}`;
    const envelope = {
      event_id: randomUUID(),
      stream_type: 'migration',
      stream_id: randomUUID(),
      event_type: 'migration.opening_stock.loaded',
      payload: { site_id: siteAId, load_id: randomUUID() },
      event_version: 1,
      schema_version: 1,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: leadAUserId, role: 'migration_lead', location_id: siteAId },
        device_id: `EDGE-13-1-${RUN}`,
        capture_method: 'MANUAL',
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: key,
    };
    const events = await makeRequest(port, 'POST', '/api/v1/events', envelope, leadAHeaders);
    assert.strictEqual(events.status, 400, events.text);
    assert.strictEqual(events.body['error_code'], 'INVALID_EVENT_STREAM');
    const edge = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, leadAHeaders);
    assert.strictEqual(edge.status, 403, edge.text);
    assert.strictEqual(edge.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [key]), 0);

    // A migration event NAME on a foreign stream is refused by the pre-transaction shape assert.
    const foreign = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      { ...envelope, stream_type: 'inventory', idempotency_key: `${key}-foreign` },
      stockHeaders,
    );
    assert.strictEqual(foreign.status, 400, foreign.text);
    assert.strictEqual(foreign.body['error_code'], 'INVALID_EVENT_STREAM');
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [`${key}-foreign`]), 0);
  });

  // -------------------------------------------------------------------------
  // Volume (Open Question 6, Task 7.2): measured, not assumed
  // -------------------------------------------------------------------------

  it(`PERF: imports and promotes ${PERF_ROWS} rows at site C, recording the timings`, async () => {
    const rows: string[] = [];
    const snapshot: Record<string, unknown>[] = [];
    const snap = new Date().toISOString();
    for (let i = 0; i < PERF_ROWS; i++) {
      rows.push(
        row({
          site_code: SITE_C,
          location_code: BIN_C1,
          sku: PERF,
          lot_number: L(`P${i}`),
          quantity: '1',
          unit_cost: '1.0000',
        }),
      );
      snapshot.push({
        source_system: 'ERP',
        site_code_ext: SITE_C,
        location_code: BIN_C1,
        sku: PERF,
        lot_number_ext: L(`P${i}`),
        quantity: '1',
        unit_cost: '1',
        snapshot_at: snap,
      });
    }
    const t0 = process.hrtime.bigint();
    const imported = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      importBody(csv(rows), { site_id: siteCId }),
      leadAHeaders,
    );
    const importMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    assert.strictEqual(imported.status, 201, imported.text);
    assert.strictEqual(imported.body['accepted_count'], PERF_ROWS);

    const t1 = process.hrtime.bigint();
    const synced = await makeRequest(
      port,
      'POST',
      '/api/v1/erp/sync',
      { stock_balances: snapshot },
      erpHeaders,
    );
    const syncMs = Number(process.hrtime.bigint() - t1) / 1_000_000;
    assert.strictEqual(synced.status, 200, synced.text);

    const promoted = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/promote',
      { site_id: siteCId, idempotency_key: `13-1-perf-promote-${run}` },
      leadAHeaders,
    );
    assert.strictEqual(promoted.status, 200, promoted.text);
    assert.strictEqual(promoted.body['posted_row_count'], PERF_ROWS);
    console.log(
      `[story-13-1] PERF rows=${PERF_ROWS} import=${importMs.toFixed(0)}ms sync=${syncMs.toFixed(0)}ms promote=${String(promoted.body['duration_ms'])}ms`,
    );
    assert.ok(importMs < 5 * 60_000, `import took ${importMs.toFixed(0)} ms`);
    assert.strictEqual(binC1Id.length, 36);
  });
});

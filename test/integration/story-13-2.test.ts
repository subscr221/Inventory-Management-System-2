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
import { persistEvent } from '../../src/events/store.js';
import { getDomainVerificationStatuses } from '../../src/read/projections/migration_domain_verification.js';
import {
  ACTIVE_BOMS_TEMPLATE_V1,
  CUSTODY_REGISTERS_TEMPLATE_V1,
  JOBWORK_CHALLANS_TEMPLATE_V1,
  OPEN_POS_TEMPLATE_V1,
} from '../../src/migration/document-templates.js';
import { toIstCalendarDate } from '../../src/lib/business-days.js';

/**
 * Story 13.2 Active Document Migration - BOMs, POs, Challans, Custody Registers (FR-DM-02). Real
 * PostgreSQL, the real production router, SCIM provisioning and dev-token auth. Tests run serially
 * and build on each other's state; every identifier is run-scoped. The harness scaffolding is a
 * deliberate local re-implementation of the story-13-1 closure (never import cross-story).
 *
 * Fixture policy: legacy kits go through the Story 5.2 route (the BOM migration execution path);
 * ERP POs are admin-pool rows exactly as story-9-2 seeds them (the sync route soft-closes every PO
 * not in its batch, which would disturb other files' data); the job-work documents are admin-pool
 * rows because the Story 9.2 receipt route needs a weighbridge token, a dock and a kit BOM per
 * receipt - the four tables this story reads are seeded directly and the AC 2 broken references
 * are fabricated the same way.
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

type Domain = 'active_boms' | 'open_pos' | 'jobwork_challans' | 'custody_registers';

const TEMPLATES: Record<Domain, readonly string[]> = {
  active_boms: ACTIVE_BOMS_TEMPLATE_V1,
  open_pos: OPEN_POS_TEMPLATE_V1,
  jobwork_challans: JOBWORK_CHALLANS_TEMPLATE_V1,
  custody_registers: CUSTODY_REGISTERS_TEMPLATE_V1,
};

describe('Story 13.2 Active Document Migration verification and sign-off', () => {
  let server: Server;
  let port: number;

  const SITE_A = `SITE-A-13-2-${RUN}`;
  const SITE_B = `SITE-B-13-2-${RUN}`;
  const PARENT = `PARENT-13-2-${RUN}`;
  const COMP1 = `COMP1-13-2-${RUN}`;
  const COMP2 = `COMP2-13-2-${RUN}`;
  const INACT = `INACT-13-2-${RUN}`;
  const POI1 = `POI1-13-2-${RUN}`;
  const POI2 = `POI2-13-2-${RUN}`;
  const JWI = `JWI-13-2-${RUN}`;
  const CUI = `CUI-13-2-${RUN}`;
  const KIT_PREFIX = `KIT-13-2-${RUN}`;
  const KIT1 = `${KIT_PREFIX}-1`;
  const KIT2 = `${KIT_PREFIX}-2`;
  const PO_PREFIX = `PO-13-2-${RUN}`;
  const PO1 = `${PO_PREFIX}-1`;
  const PO2 = `${PO_PREFIX}-2`;
  const SO1 = `SO-13-2-${RUN}-1`;
  const CH1 = `CH-13-2-${RUN}-1`;
  const CH2 = `CH-13-2-${RUN}-2`;
  const CUSTOMER = `CUST13-2${RUN}`.replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  const CHALLAN_DATE = isoDateOffset(-30);
  const TODAY = toIstCalendarDate(new Date());

  let siteAId: string;
  let siteBId: string;
  let so1Id: string;
  let receipt1Id: string;

  let leadUserId: string;
  let leadHeaders: Record<string, string>;
  let engHeadUserId: string;
  let engHeadHeaders: Record<string, string>;
  let procHeadHeaders: Record<string, string>;
  let jwHeadUserId: string;
  let jwHeadHeaders: Record<string, string>;
  let otherSiteHeadHeaders: Record<string, string>;
  let dualHeaders: Record<string, string>;
  let gateHeaders: Record<string, string>;
  let engineerHeaders: Record<string, string>;

  const latestRun: Partial<Record<Domain, string>> = {};
  const latestLoad: Partial<Record<Domain, string>> = {};

  function csvFor(domain: Domain, rows: Record<string, string>[]): string {
    const header = TEMPLATES[domain];
    const lines = rows.map((r) => header.map((c) => r[c] ?? '').join(','));
    return [header.join(','), ...lines].join('\r\n') + '\r\n';
  }

  async function importManifest(
    domain: Domain,
    rows: Record<string, string>[],
    opts: { key?: string; headers?: Record<string, string>; site_id?: string; csv?: string } = {},
  ): Promise<HttpResult> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/documents/imports',
      {
        site_id: opts.site_id ?? siteAId,
        domain,
        file_name: `${domain}-${run}.csv`,
        template_version: 'v1',
        csv: opts.csv ?? csvFor(domain, rows),
        idempotency_key: opts.key ?? `13-2-import-${randomUUID()}`,
      },
      opts.headers ?? leadHeaders,
    );
    if (res.status === 201) latestLoad[domain] = res.body['load_id'] as string;
    return res;
  }

  async function runVerification(
    domain: Domain,
    opts: { headers?: Record<string, string>; key?: string; prefix?: string | null } = {},
  ): Promise<HttpResult> {
    const prefix =
      opts.prefix === undefined
        ? domain === 'active_boms'
          ? KIT_PREFIX
          : domain === 'open_pos'
            ? PO_PREFIX
            : null
        : opts.prefix;
    const res = await makeRequest(
      port,
      'POST',
      `/api/v1/migration/domains/${domain}/verification-runs`,
      {
        site_id: siteAId,
        idempotency_key: opts.key ?? `13-2-run-${randomUUID()}`,
        ...(prefix ? { document_ref_prefix: prefix } : {}),
      },
      opts.headers ?? leadHeaders,
    );
    if (res.status === 201) latestRun[domain] = res.body['run_id'] as string;
    return res;
  }

  async function findingsOf(
    domain: Domain,
    runId: string,
    query = '',
  ): Promise<Record<string, unknown>[]> {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/domains/${domain}/verification-runs/${runId}?limit=500${query}`,
      undefined,
      leadHeaders,
    );
    assert.strictEqual(res.status, 200, res.text);
    return res.body['findings'] as Record<string, unknown>[];
  }

  async function signOff(
    domain: Domain,
    runId: string,
    headers: Record<string, string>,
    waivers: { finding_id: string; narrative: string }[] = [],
    key = `13-2-signoff-${randomUUID()}`,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/migration/domains/${domain}/sign-off`,
      { site_id: siteAId, run_id: runId, waivers, idempotency_key: key },
      headers,
    );
  }

  async function domainStatus(domain: Domain): Promise<Record<string, unknown>> {
    const res = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/domains?site_id=${siteAId}`,
      undefined,
      leadHeaders,
    );
    assert.strictEqual(res.status, 200, res.text);
    const domains = res.body['domains'] as Record<string, unknown>[];
    return domains.find((d) => d['domain'] === domain)!;
  }

  async function domainEventCount(where: string, params: unknown[]): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE ${where}`,
      params,
    );
    return r.rows[0]!['n'] as number;
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
    opts: { uom?: string; status?: string; stream?: string } = {},
  ): Promise<string> {
    const r = await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, $2, false, false, false, false, false, 'weighted_average', $3, $4)
       RETURNING item_id`,
      [sku, opts.uom ?? 'EA', opts.stream ?? 'production', opts.status ?? 'active'],
    );
    return r.rows[0]!['item_id'] as string;
  }

  async function setItemStatus(sku: string, status: 'active' | 'inactive'): Promise<void> {
    await getAdminPool().query(`UPDATE item_master SET status = $2 WHERE sku = $1`, [sku, status]);
  }

  async function seedPo(
    poRef: string,
    lines: {
      line_no: number;
      sku: string;
      ordered: number;
      open: number;
      over: number | null;
      under: number | null;
    }[],
  ): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO erp_purchase_order (po_number_ext, supplier_ref_ext, currency, expected_delivery_date, status, source_system, last_synced_at)
       VALUES ($1, 'SUP-13-2', 'INR', $2, 'open', 'ERP', now())`,
      [poRef, isoDateOffset(30)],
    );
    for (const l of lines) {
      await getAdminPool().query(
        `INSERT INTO erp_purchase_order_line (po_number_ext, line_no, sku, ordered_qty, open_qty, unit_price, over_receipt_tolerance_pct, under_receipt_tolerance_pct, source_system, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'ERP', now())`,
        [poRef, l.line_no, l.sku, l.ordered, l.open, l.over, l.under],
      );
    }
  }

  async function seedReceipt(opts: {
    serviceOrderId: string;
    challan: string;
    sku: string;
    qty: number;
    withClock?: boolean;
    clockDate?: string;
  }): Promise<string> {
    const receiptId = randomUUID();
    const grnLineId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO grn_line (grn_line_id, grn_id, po_ref_ext, line_no, sku, received_qty, uom, stock_class, weighbridge_correlation_id, qc_hold, shortage_variance_qty, status, source_event_id)
       VALUES ($1, $2, $3, 1, $4, $5, 'KG', 'job_work', $6, false, 0, 'posted', $7)`,
      [
        grnLineId,
        randomUUID(),
        `PO-JW-13-2-${RUN}`,
        opts.sku,
        opts.qty,
        randomUUID(),
        randomUUID(),
      ],
    );
    await getAdminPool().query(
      `INSERT INTO jobwork_material_receipt (receipt_id, service_order_id, grn_line_id, challan_number_ext, challan_date, sku, lot_id, received_qty, challan_qty, uom, variance_qty, variance_flagged, received_by, site_id, source_event_id, challan_class)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $7, 'KG', 0, false, $8, $9, $10, 'input')`,
      [
        receiptId,
        opts.serviceOrderId,
        grnLineId,
        opts.challan,
        CHALLAN_DATE,
        opts.sku,
        opts.qty,
        leadUserId,
        siteAId,
        randomUUID(),
      ],
    );
    if (opts.withClock !== false) {
      const clockDate = opts.clockDate ?? CHALLAN_DATE;
      await getAdminPool().query(
        `INSERT INTO jobwork_return_clock (clock_id, receipt_id, service_order_id, sku, challan_qty, challan_class, challan_date, expiry_date, status, site_id)
         VALUES ($1, $2, $3, $4, $5, 'input', $6, ($6::date + INTERVAL '365 days')::date, 'open', $7)`,
        [randomUUID(), receiptId, opts.serviceOrderId, opts.sku, opts.qty, clockDate, siteAId],
      );
    }
    return receiptId;
  }

  async function seedCustody(opts: {
    serviceOrderId: string;
    sku: string;
    category: 'receipt' | 'consumption';
    delta: number;
    receiptId?: string | null;
    locationId?: string | null;
  }): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO custody_ledger_entry (entry_id, service_order_id, customer_party_code, movement_category, ownership, sku, lot_id, location_id, quantity_delta, uom, receipt_id, site_id, posted_by, occurred_at, business_date, source_event_id, source_event_type)
       VALUES ($1, $2, $3, $4, 'customer', $5, NULL, $6, $7, 'KG', $8, $9, $10, now(), $11, $12, 'jobwork.material_received')`,
      [
        randomUUID(),
        opts.serviceOrderId,
        CUSTOMER,
        opts.category,
        opts.sku,
        opts.locationId ?? null,
        opts.delta,
        opts.receiptId ?? null,
        siteAId,
        leadUserId,
        TODAY,
        randomUUID(),
      ],
    );
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../read/projections/migration_import.sql',
      '../../read/projections/migration_import_rejection.sql',
      '../../read/projections/migration_stage.sql',
      '../../read/projections/migration_document_manifest_row.sql',
      '../../read/projections/migration_domain_verification.sql',
      '../../read/projections/migration_domain_verification_finding.sql',
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
    await seedLocation('bin', `BIN-A1-13-2-${RUN}`, siteAId);

    const parentId = await seedItem(PARENT);
    const comp1Id = await seedItem(COMP1);
    const comp2Id = await seedItem(COMP2);
    const inactId = await seedItem(INACT, { status: 'inactive' });
    await seedItem(POI1);
    await seedItem(POI2);
    await seedItem(JWI, { uom: 'KG', stream: 'job_work' });
    await seedItem(CUI, { uom: 'KG', stream: 'job_work' });

    const lead = `migration-lead-13-2-${run}@example.com`;
    leadUserId = await provisionUser(port, lead, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteAId },
      { role: 'migration_lead', module: 'migration', functionScope: 'read', locationId: siteAId },
    ]);
    leadHeaders = await authFor(port, lead);

    const engHead = `eng-head-13-2-${run}@example.com`;
    engHeadUserId = await provisionUser(port, engHead, [
      { role: 'department_head', module: 'engineering', functionScope: 'write', locationId: '*' },
      { role: 'department_head', module: 'migration', functionScope: 'read', locationId: '*' },
    ]);
    engHeadHeaders = await authFor(port, engHead);

    const procHead = `proc-head-13-2-${run}@example.com`;
    await provisionUser(port, procHead, [
      {
        role: 'department_head',
        module: 'procurement',
        functionScope: 'write',
        locationId: siteAId,
      },
      { role: 'department_head', module: 'migration', functionScope: 'read', locationId: siteAId },
    ]);
    procHeadHeaders = await authFor(port, procHead);

    const jwHead = `jw-head-13-2-${run}@example.com`;
    jwHeadUserId = await provisionUser(port, jwHead, [
      { role: 'department_head', module: 'jobwork', functionScope: 'write', locationId: siteAId },
      { role: 'department_head', module: 'migration', functionScope: 'read', locationId: siteAId },
    ]);
    jwHeadHeaders = await authFor(port, jwHead);

    const otherHead = `other-head-13-2-${run}@example.com`;
    await provisionUser(port, otherHead, [
      { role: 'department_head', module: 'jobwork', functionScope: 'write', locationId: siteBId },
      { role: 'department_head', module: 'migration', functionScope: 'read', locationId: '*' },
    ]);
    otherSiteHeadHeaders = await authFor(port, otherHead);

    // SOD-07 arm: one person holding both the loader and the sign-off hat.
    const dual = `dual-13-2-${run}@example.com`;
    await provisionUser(port, dual, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteAId },
      { role: 'migration_lead', module: 'migration', functionScope: 'read', locationId: siteAId },
      { role: 'department_head', module: 'engineering', functionScope: 'write', locationId: '*' },
    ]);
    dualHeaders = await authFor(port, dual);

    const gate = `gate-13-2-${run}@example.com`;
    await provisionUser(port, gate, [
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateHeaders = await authFor(port, gate);

    const engineer = `engineer-13-2-${run}@example.com`;
    await provisionUser(port, engineer, [
      { role: 'engineering_admin', module: 'engineering', functionScope: 'write', locationId: '*' },
      { role: 'engineering_admin', module: 'engineering', functionScope: 'read', locationId: '*' },
    ]);
    engineerHeaders = await authFor(port, engineer);

    // Legacy kits through the Story 5.2 migration path: one released, one draft-remediation.
    const kits = await makeRequest(
      port,
      'POST',
      '/api/v1/boms/legacy-kit-migration',
      {
        kits: [
          {
            kit_ref: KIT1,
            parent_item_id: parentId,
            components: [
              { component_item_id: comp1Id, quantity_per: '3.0', line_uom: 'EA' },
              { component_item_id: comp2Id, quantity_per: '1.5', line_uom: 'EA' },
            ],
          },
          {
            kit_ref: KIT2,
            parent_item_id: comp1Id,
            components: [{ component_item_id: inactId, quantity_per: '1.0', line_uom: 'EA' }],
          },
        ],
      },
      engineerHeaders,
    );
    assert.strictEqual(kits.status, 200, kits.text);
    assert.strictEqual((kits.body['migrated'] as unknown[]).length, 1, kits.text);
    assert.strictEqual((kits.body['draft_remediation'] as unknown[]).length, 1, kits.text);

    await seedPo(PO1, [
      { line_no: 1, sku: POI1, ordered: 100, open: 60, over: 5, under: 5 },
      { line_no: 2, sku: POI2, ordered: 10, open: 10, over: null, under: null },
    ]);
    await seedPo(PO2, [{ line_no: 1, sku: POI1, ordered: 7, open: 7, over: null, under: null }]);

    so1Id = randomUUID();
    await adminPool.query(
      `INSERT INTO service_order (service_order_id, order_number_ext, customer_party_code, customer_name, status, has_contractual_offcut, site_id, business_stream, created_by, source_event_id)
       VALUES ($1, $2, $3, 'Acme Fabrication Pvt Ltd', 'in_process', false, $4, 'job_work', $5, $6)`,
      [so1Id, SO1, CUSTOMER, siteAId, leadUserId, randomUUID()],
    );
    receipt1Id = await seedReceipt({ serviceOrderId: so1Id, challan: CH1, sku: JWI, qty: 1000 });
    const receipt2Id = await seedReceipt({
      serviceOrderId: so1Id,
      challan: CH2,
      sku: JWI,
      qty: 500,
    });
    await seedCustody({
      serviceOrderId: so1Id,
      sku: JWI,
      category: 'receipt',
      delta: 1000,
      receiptId: receipt1Id,
    });
    await seedCustody({
      serviceOrderId: so1Id,
      sku: JWI,
      category: 'receipt',
      delta: 500,
      receiptId: receipt2Id,
    });
    await seedCustody({ serviceOrderId: so1Id, sku: JWI, category: 'consumption', delta: -200 });
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 5 (before anything): every domain is unverified
  // -------------------------------------------------------------------------

  it('AC5: before any manifest or run, all four domains report unverified and the stage list defaults every domain', async () => {
    for (const domain of [
      'active_boms',
      'open_pos',
      'jobwork_challans',
      'custody_registers',
    ] as Domain[]) {
      const s = await domainStatus(domain);
      assert.strictEqual(s['status'], 'unverified');
      assert.strictEqual(s['latest_run_id'], null);
    }
    const stages = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/stages?site_id=${siteAId}`,
      undefined,
      leadHeaders,
    );
    assert.strictEqual(stages.status, 200, stages.text);
    const domains = (stages.body['stages'] as Record<string, unknown>[]).map((s) => s['domain']);
    assert.deepEqual(domains, [
      'opening_stock',
      'active_boms',
      'open_pos',
      'jobwork_challans',
      'custody_registers',
    ]);
    const noManifest = await runVerification('active_boms');
    assert.strictEqual(noManifest.status, 409, noManifest.text);
    assert.strictEqual(noManifest.body['error_code'], 'MANIFEST_REQUIRED');
  });

  // -------------------------------------------------------------------------
  // AC 1: clean manifests verify with reconciliation counts and zero findings
  // -------------------------------------------------------------------------

  it('AC1: a header that does not match the domain template is refused whole; a wrong domain is DOMAIN_UNSUPPORTED', async () => {
    const wrong = await importManifest('active_boms', [], {
      csv: csvFor('open_pos', []) + `${SITE_A},x,1,${POI1},S,1,0,1,,\r\n`,
    });
    assert.strictEqual(wrong.status, 400, wrong.text);
    assert.strictEqual(wrong.body['error_code'], 'TEMPLATE_VERSION_UNSUPPORTED');
    assert.deepEqual(detailsOf(wrong.body)['expected_header'], [...ACTIVE_BOMS_TEMPLATE_V1]);
    const bad = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/documents/imports',
      {
        site_id: siteAId,
        domain: 'gate_passes',
        file_name: 'x.csv',
        template_version: 'v1',
        csv: 'a\r\n1\r\n',
        idempotency_key: randomUUID(),
      },
      leadHeaders,
    );
    assert.strictEqual(bad.status, 400, bad.text);
    assert.strictEqual(bad.body['error_code'], 'DOMAIN_UNSUPPORTED');
  });

  it('AC1: active_boms - a legacy kit manifest verifies against the Story 5.2 bom rows with zero findings', async () => {
    const imported = await importManifest('active_boms', [
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: 'R1',
        component_sku: COMP1,
        quantity_per: '3',
        line_uom: 'EA',
      },
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: 'R1',
        component_sku: COMP2,
        quantity_per: '1.500',
        line_uom: 'EA',
      },
      // rejected rows: a wrong site code and a duplicate manifest key
      {
        site_code: SITE_B,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: '',
        component_sku: COMP1,
        quantity_per: '1',
        line_uom: 'EA',
      },
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: '',
        component_sku: COMP1,
        quantity_per: '9',
        line_uom: 'EA',
      },
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: '',
        component_sku: COMP1,
        quantity_per: 'abc',
        line_uom: 'EA',
      },
    ]);
    assert.strictEqual(imported.status, 201, imported.text);
    assert.strictEqual(imported.body['domain'], 'active_boms');
    assert.strictEqual(imported.body['accepted_count'], 2);
    assert.strictEqual(imported.body['rejected_count'], 3);
    const rejections = imported.body['rejections'] as Record<string, unknown>[];
    assert.strictEqual(rejections[0]!['error_code'], 'UNKNOWN_REFERENCE');
    assert.strictEqual(detailsOf(rejections[0]!)['reference'], 'site_code');
    assert.strictEqual(rejections[1]!['error_code'], 'MALFORMED_ROW');
    assert.strictEqual(detailsOf(rejections[1]!)['reason'], 'duplicate_manifest_key');
    assert.strictEqual(detailsOf(rejections[1]!)['first_line_no'], 2);
    assert.strictEqual(rejections[2]!['error_code'], 'MALFORMED_ROW');
    assert.strictEqual(detailsOf(rejections[2]!)['column'], 'quantity_per');

    const header = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/documents/imports/${imported.body['load_id']}`,
      undefined,
      leadHeaders,
    );
    assert.strictEqual(header.status, 200, header.text);
    assert.strictEqual((header.body['rejections'] as unknown[]).length, 3);
    const rows = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/documents/rows?site_id=${siteAId}&domain=active_boms&load_id=${imported.body['load_id']}`,
      undefined,
      leadHeaders,
    );
    assert.strictEqual(rows.status, 200, rows.text);
    assert.strictEqual(rows.body['total'], 2);

    // Kit 2 (draft remediation, another kit_ref under the run prefix) is in the platform, not in
    // the manifest: a missing_in_source finding, not a quarantine. Add it to the manifest so the
    // domain verifies clean, proving the prefix scope and the state_mismatch on remediation kits.
    const first = await runVerification('active_boms');
    assert.strictEqual(first.status, 201, first.text);
    const firstFindings = await findingsOf('active_boms', first.body['run_id'] as string);
    assert.strictEqual(firstFindings.length, 1, JSON.stringify(firstFindings));
    assert.strictEqual(firstFindings[0]!['kind'], 'missing_in_source');
    assert.strictEqual(firstFindings[0]!['document_ref_ext'], KIT2);

    const withKit2 = await importManifest('active_boms', [
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: 'R1',
        component_sku: COMP1,
        quantity_per: '3',
        line_uom: 'EA',
      },
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: 'R1',
        component_sku: COMP2,
        quantity_per: '1.5',
        line_uom: 'EA',
      },
      {
        site_code: SITE_A,
        kit_ref: KIT2,
        parent_sku: COMP1,
        revision_code: 'R1',
        component_sku: INACT,
        quantity_per: '1',
        line_uom: 'EA',
      },
    ]);
    assert.strictEqual(withKit2.status, 201, withKit2.text);
    const second = await runVerification('active_boms');
    assert.strictEqual(second.status, 201, second.text);
    assert.strictEqual(second.body['source_count'], 2);
    assert.strictEqual(second.body['migrated_count'], 1);
    assert.strictEqual(second.body['quarantined_count'], 1);
    const kit2Findings = await findingsOf('active_boms', second.body['run_id'] as string);
    const kinds = kit2Findings.map((f) => `${f['document_ref_ext']}:${f['kind']}`).sort();
    assert.deepEqual(kinds, [`${KIT2}:state_mismatch`, `${KIT2}:unknown_reference`]);
    const q = kit2Findings.find((f) => f['kind'] === 'unknown_reference')!;
    assert.strictEqual(q['error_code'], 'UNKNOWN_REFERENCE');
    assert.strictEqual(detailsOf(q)['reference'], 'component_item_id');
    assert.strictEqual(detailsOf(q)['component_sku'], INACT);
    assert.strictEqual(q['line_ref'], '-');

    // Kit 1 alone is the clean AC 1 domain.
    const clean = await importManifest('active_boms', [
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: 'R1',
        component_sku: COMP1,
        quantity_per: '3',
        line_uom: 'EA',
      },
      {
        site_code: SITE_A,
        kit_ref: KIT1,
        parent_sku: PARENT,
        revision_code: 'R1',
        component_sku: COMP2,
        quantity_per: '1.5',
        line_uom: 'EA',
      },
    ]);
    assert.strictEqual(clean.status, 201, clean.text);
    const third = await runVerification('active_boms', { prefix: KIT1 });
    assert.strictEqual(third.status, 201, third.text);
    assert.strictEqual(third.body['source_count'], 1);
    assert.strictEqual(third.body['migrated_count'], 1);
    assert.strictEqual(third.body['quarantined_count'], 0);
    assert.strictEqual(third.body['mismatch_count'], 0);
    assert.strictEqual((await findingsOf('active_boms', third.body['run_id'] as string)).length, 0);
    assert.strictEqual(
      await domainEventCount(
        `event_type = 'migration.domain.verification_run' AND payload->>'run_id' = $1`,
        [third.body['run_id']],
      ),
      1,
    );
  });

  it('AC1: open_pos - a matching manifest reconciles ordered, received, open and tolerances against the ERP projection', async () => {
    const imported = await importManifest('open_pos', [
      {
        site_code: SITE_A,
        po_number_ext: PO1,
        line_no: '1',
        sku: POI1,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '100',
        received_qty: '40',
        open_qty: '60',
        over_receipt_tolerance_pct: '5',
        under_receipt_tolerance_pct: '5.000',
      },
      {
        site_code: SITE_A,
        po_number_ext: PO1,
        line_no: '2',
        sku: POI2,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '10',
        received_qty: '0',
        open_qty: '10',
        over_receipt_tolerance_pct: '',
        under_receipt_tolerance_pct: '',
      },
      {
        site_code: SITE_A,
        po_number_ext: PO2,
        line_no: '1',
        sku: POI1,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '7',
        received_qty: '0',
        open_qty: '7',
        over_receipt_tolerance_pct: '',
        under_receipt_tolerance_pct: '',
      },
    ]);
    assert.strictEqual(imported.status, 201, imported.text);
    const res = await runVerification('open_pos');
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body['source_count'], 3);
    assert.strictEqual(res.body['migrated_count'], 3);
    assert.strictEqual(res.body['mismatch_count'], 0);
    assert.strictEqual((await findingsOf('open_pos', res.body['run_id'] as string)).length, 0);
  });

  it('AC1: jobwork_challans - challans with source references verify against receipts, orders and return clocks', async () => {
    const imported = await importManifest('jobwork_challans', [
      {
        site_code: SITE_A,
        challan_number_ext: CH1,
        challan_date: CHALLAN_DATE,
        order_number_ext: SO1,
        customer_party_code: CUSTOMER,
        sku: JWI,
        challan_qty: '1000',
        uom: 'KG',
        challan_class: 'input',
      },
      {
        site_code: SITE_A,
        challan_number_ext: CH2,
        challan_date: CHALLAN_DATE,
        order_number_ext: SO1,
        customer_party_code: CUSTOMER,
        sku: JWI,
        challan_qty: '500.000',
        uom: 'KG',
        challan_class: 'input',
      },
    ]);
    assert.strictEqual(imported.status, 201, imported.text);
    const res = await runVerification('jobwork_challans');
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body['source_count'], 2);
    assert.strictEqual(res.body['migrated_count'], 2);
    assert.strictEqual(res.body['quarantined_count'], 0);
    assert.strictEqual(
      (await findingsOf('jobwork_challans', res.body['run_id'] as string)).length,
      0,
    );
  });

  it('AC1: custody_registers - the customer-ownership balance per order and sku reconciles to the register', async () => {
    const imported = await importManifest('custody_registers', [
      {
        site_code: SITE_A,
        order_number_ext: SO1,
        customer_party_code: CUSTOMER,
        sku: JWI,
        custody_qty: '1300',
        uom: 'KG',
      },
    ]);
    assert.strictEqual(imported.status, 201, imported.text);
    const res = await runVerification('custody_registers');
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body['source_count'], 1);
    assert.strictEqual(res.body['migrated_count'], 1);
    assert.strictEqual(
      (await findingsOf('custody_registers', res.body['run_id'] as string)).length,
      0,
    );
    // The applier wrote the header; the list route reads it newest first.
    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/domains/custody_registers/verification-runs?site_id=${siteAId}`,
      undefined,
      leadHeaders,
    );
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(
      (list.body['runs'] as Record<string, unknown>[])[0]!['run_id'],
      res.body['run_id'],
    );
  });

  // -------------------------------------------------------------------------
  // AC 3: every open-PO mismatch is listed
  // -------------------------------------------------------------------------

  it('AC3: differing ordered, received, open, tolerance and supplier values, a line absent from ERP and an open ERP line absent from the manifest are each listed', async () => {
    const imported = await importManifest('open_pos', [
      {
        site_code: SITE_A,
        po_number_ext: PO1,
        line_no: '1',
        sku: POI1,
        supplier_ref_ext: 'SUP-X',
        ordered_qty: '101',
        received_qty: '41',
        open_qty: '59',
        over_receipt_tolerance_pct: '6',
        under_receipt_tolerance_pct: '5',
      },
      {
        site_code: SITE_A,
        po_number_ext: PO1,
        line_no: '2',
        sku: POI2,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '10',
        received_qty: '0',
        open_qty: '10',
        over_receipt_tolerance_pct: '',
        under_receipt_tolerance_pct: '',
      },
      {
        site_code: SITE_A,
        po_number_ext: PO1,
        line_no: '3',
        sku: POI1,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '1',
        received_qty: '0',
        open_qty: '1',
        over_receipt_tolerance_pct: '',
        under_receipt_tolerance_pct: '',
      },
    ]);
    assert.strictEqual(imported.status, 201, imported.text);
    const res = await runVerification('open_pos');
    assert.strictEqual(res.status, 201, res.text);
    const findings = await findingsOf('open_pos', res.body['run_id'] as string);
    const fieldMismatches = findings.filter((f) => f['kind'] === 'field_mismatch');
    assert.deepEqual(fieldMismatches.map((f) => f['field']).sort(), [
      'open_qty',
      'ordered_qty',
      'over_receipt_tolerance_pct',
      'received_qty',
      'supplier_ref_ext',
    ]);
    const ordered = fieldMismatches.find((f) => f['field'] === 'ordered_qty')!;
    assert.strictEqual(ordered['source_value'], '101');
    assert.strictEqual(ordered['platform_value'], '100.000');
    const received = fieldMismatches.find((f) => f['field'] === 'received_qty')!;
    assert.strictEqual(received['source_value'], '41');
    assert.strictEqual(received['platform_value'], '40.000');
    assert.strictEqual(findings.filter((f) => f['kind'] === 'missing_in_platform').length, 1);
    assert.strictEqual(findings.find((f) => f['kind'] === 'missing_in_platform')!['line_ref'], '3');
    const missingInSource = findings.filter((f) => f['kind'] === 'missing_in_source');
    assert.strictEqual(missingInSource.length, 1);
    assert.strictEqual(missingInSource[0]!['document_ref_ext'], PO2);
    assert.strictEqual(res.body['mismatch_count'], 7);
    assert.strictEqual(res.body['migrated_count'], 1);
    assert.strictEqual(res.body['source_count'], 3);
  });

  // -------------------------------------------------------------------------
  // AC 2: unresolvable references quarantine the document
  // -------------------------------------------------------------------------

  it('AC2: open_pos - a line whose item is no longer in the active item master is quarantined and blocks sign-off even when waived', async () => {
    await setItemStatus(POI2, 'inactive');
    try {
      const res = await runVerification('open_pos');
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(res.body['quarantined_count'], 1);
      assert.strictEqual(res.body['migrated_count'], 0);
      const findings = await findingsOf(
        'open_pos',
        res.body['run_id'] as string,
        '&kind=unknown_reference',
      );
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0]!['error_code'], 'UNKNOWN_REFERENCE');
      assert.strictEqual(findings[0]!['line_ref'], '2');
      assert.strictEqual(detailsOf(findings[0]!)['reference'], 'sku');
      const all = await findingsOf('open_pos', res.body['run_id'] as string);
      const attempt = await signOff(
        'open_pos',
        res.body['run_id'] as string,
        procHeadHeaders,
        all.map((f) => ({ finding_id: f['finding_id'] as string, narrative: 'waive' })),
      );
      assert.strictEqual(attempt.status, 400, attempt.text);
      assert.strictEqual(attempt.body['error_code'], 'INVALID_PARAMS');
      const withoutQuarantine = await signOff(
        'open_pos',
        res.body['run_id'] as string,
        procHeadHeaders,
        all
          .filter((f) => f['kind'] !== 'unknown_reference')
          .map((f) => ({ finding_id: f['finding_id'] as string, narrative: 'waive' })),
      );
      assert.strictEqual(withoutQuarantine.status, 409, withoutQuarantine.text);
      assert.strictEqual(withoutQuarantine.body['error_code'], 'VERIFICATION_UNRESOLVED');
      assert.strictEqual((detailsOf(withoutQuarantine.body)['quarantined'] as unknown[]).length, 1);
    } finally {
      await setItemStatus(POI2, 'active');
    }
  });

  it('AC2: active_boms - a kit whose component item was deactivated is quarantined at kit level', async () => {
    await setItemStatus(COMP2, 'inactive');
    try {
      const res = await runVerification('active_boms', { prefix: KIT1 });
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(res.body['quarantined_count'], 1);
      assert.strictEqual(res.body['migrated_count'], 0);
      const findings = await findingsOf('active_boms', res.body['run_id'] as string);
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0]!['kind'], 'unknown_reference');
      assert.strictEqual(findings[0]!['document_ref_ext'], KIT1);
      assert.strictEqual(detailsOf(findings[0]!)['component_sku'], COMP2);
    } finally {
      await setItemStatus(COMP2, 'active');
    }
  });

  it('AC2: jobwork_challans - a receipt whose service order cannot be matched is quarantined with UNKNOWN_REFERENCE', async () => {
    const orphanId = await seedReceipt({
      serviceOrderId: randomUUID(),
      challan: `${CH1}-ORPHAN`,
      sku: JWI,
      qty: 5,
    });
    try {
      const res = await runVerification('jobwork_challans');
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(res.body['quarantined_count'], 1);
      assert.strictEqual(res.body['migrated_count'], 2);
      const findings = await findingsOf('jobwork_challans', res.body['run_id'] as string);
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0]!['error_code'], 'UNKNOWN_REFERENCE');
      assert.strictEqual(findings[0]!['document_ref_ext'], `${CH1}-ORPHAN`);
      assert.strictEqual(detailsOf(findings[0]!)['reference'], 'service_order_id');
      assert.strictEqual(findings[0]!['platform_ref'], orphanId);
    } finally {
      await getAdminPool().query(`DELETE FROM jobwork_return_clock WHERE receipt_id = $1`, [
        orphanId,
      ]);
      await getAdminPool().query(`DELETE FROM jobwork_material_receipt WHERE receipt_id = $1`, [
        orphanId,
      ]);
    }
  });

  it('AC2: custody_registers - an entry with an unknown location quarantines its register line', async () => {
    const ghost = randomUUID();
    await seedCustody({
      serviceOrderId: so1Id,
      sku: CUI,
      category: 'receipt',
      delta: 10,
      locationId: ghost,
    });
    try {
      const res = await runVerification('custody_registers');
      assert.strictEqual(res.status, 201, res.text);
      assert.strictEqual(res.body['quarantined_count'], 1);
      assert.strictEqual(res.body['migrated_count'], 1);
      const findings = await findingsOf('custody_registers', res.body['run_id'] as string);
      const kinds = findings.map((f) => `${f['line_ref']}:${f['kind']}`).sort();
      assert.deepEqual(kinds, [`${CUI}:missing_in_source`, `${CUI}:unknown_reference`]);
      assert.strictEqual(
        detailsOf(findings.find((f) => f['kind'] === 'unknown_reference')!)['reference'],
        'location_id',
      );
    } finally {
      await getAdminPool().query(`DELETE FROM custody_ledger_entry WHERE location_id = $1`, [
        ghost,
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // AC 4: department-head sign-off, one parameterised flow, SOD-07
  // -------------------------------------------------------------------------

  it('AC4: the migration lead, a head of another module and a head of another site cannot sign off', async () => {
    const clean = await runVerification('active_boms', { prefix: KIT1 });
    assert.strictEqual(clean.status, 201, clean.text);
    const runId = clean.body['run_id'] as string;
    const lead = await signOff('active_boms', runId, leadHeaders);
    assert.strictEqual(lead.status, 403, lead.text);
    assert.strictEqual(lead.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepEqual(detailsOf(lead.body)['required_roles'], ['department_head']);
    const wrongModule = await signOff('active_boms', runId, jwHeadHeaders);
    assert.strictEqual(wrongModule.status, 403, wrongModule.text);
    assert.strictEqual(wrongModule.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual(detailsOf(wrongModule.body)['required_module'], 'engineering');
    const otherSite = await signOff(
      'jobwork_challans',
      latestRun['jobwork_challans']!,
      otherSiteHeadHeaders,
    );
    assert.strictEqual(otherSite.status, 403, otherSite.text);
    assert.strictEqual(otherSite.body['error_code'], 'LOCATION_ACCESS_DENIED');
    assert.strictEqual((await domainStatus('active_boms'))['status'], 'unverified');
  });

  it('AC4 SOD-07: the head who ran the verification cannot sign it off, in the route and in the applier', async () => {
    const ran = await runVerification('active_boms', { headers: dualHeaders, prefix: KIT1 });
    assert.strictEqual(ran.status, 201, ran.text);
    const runId = ran.body['run_id'] as string;
    const conflict = await signOff('active_boms', runId, dualHeaders);
    assert.strictEqual(conflict.status, 403, conflict.text);
    assert.strictEqual(conflict.body['error_code'], 'SIGNOFF_ACTOR_CONFLICT');
    assert.strictEqual(detailsOf(conflict.body)['conflicting_role'], 'verification_runner');
    // The manifest loader (the lead) holding the head hat is the other SOD-07 leg.
    const dualUser = await getAdminPool().query(
      `SELECT user_id FROM users WHERE external_id = $1`,
      [`dual-13-2-${run}@example.com`],
    );
    const dualUserId = dualUser.rows[0]!['user_id'] as string;
    await assert.rejects(
      persistEvent({
        stream_type: 'migration',
        stream_id: siteAId,
        event_type: 'migration.domain.verified',
        payload: {
          site_id: siteAId,
          domain: 'active_boms',
          run_id: runId,
          waivers: [],
          signed_off_by_actor_id: dualUserId,
          signed_off_role: 'department_head',
          business_date: TODAY,
        },
        metadata: {
          correlation_id: randomUUID(),
          causation_id: null,
          actor: { user_id: dualUserId, role: 'department_head', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: `13-2-direct-sod-${randomUUID()}`,
      }),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'SIGNOFF_ACTOR_CONFLICT',
    );
    // A different head signs the same run: the engineering head, who neither loaded nor ran.
    const ok = await signOff('active_boms', runId, engHeadHeaders, [], `13-2-signoff-boms-${run}`);
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(ok.body['status'], 'verified');
    assert.strictEqual(ok.body['verified_by_actor_id'], engHeadUserId);
    const replay = await signOff(
      'active_boms',
      runId,
      engHeadHeaders,
      [],
      `13-2-signoff-boms-${run}`,
    );
    assert.strictEqual(replay.status, 200, replay.text);
    assert.strictEqual(replay.body['replayed'], true);
    assert.strictEqual(
      await domainEventCount(
        `event_type = 'migration.domain.verified' AND payload->>'run_id' = $1`,
        [runId],
      ),
      1,
    );
    assert.strictEqual((await domainStatus('active_boms'))['status'], 'verified');
  });

  it('AC4: open findings block sign-off until each is waived with a narrative; quarantine never waives', async () => {
    const res = await runVerification('open_pos');
    assert.strictEqual(res.status, 201, res.text);
    const runId = res.body['run_id'] as string;
    assert.strictEqual(res.body['quarantined_count'], 0);
    assert.strictEqual(res.body['mismatch_count'], 7);
    const bare = await signOff('open_pos', runId, procHeadHeaders);
    assert.strictEqual(bare.status, 409, bare.text);
    assert.strictEqual(bare.body['error_code'], 'VERIFICATION_UNRESOLVED');
    assert.strictEqual((detailsOf(bare.body)['unwaived'] as unknown[]).length, 7);
    const findings = await findingsOf('open_pos', runId);
    const partial = await signOff('open_pos', runId, procHeadHeaders, [
      {
        finding_id: findings[0]!['finding_id'] as string,
        narrative: 'Legacy register corrected after extract',
      },
    ]);
    assert.strictEqual(partial.status, 409, partial.text);
    assert.strictEqual((detailsOf(partial.body)['unwaived'] as unknown[]).length, 6);
    const foreign = await signOff('open_pos', runId, procHeadHeaders, [
      { finding_id: randomUUID(), narrative: 'not on this run' },
    ]);
    assert.strictEqual(foreign.status, 400, foreign.text);
    // Prove the gate lives in the applier: a direct persist with no waivers is refused there.
    const procUser = await getAdminPool().query(
      `SELECT user_id FROM users WHERE external_id = $1`,
      [`proc-head-13-2-${run}@example.com`],
    );
    const procUserId = procUser.rows[0]!['user_id'] as string;
    const directKey = `13-2-direct-gate-${randomUUID()}`;
    await assert.rejects(
      persistEvent({
        stream_type: 'migration',
        stream_id: siteAId,
        event_type: 'migration.domain.verified',
        payload: {
          site_id: siteAId,
          domain: 'open_pos',
          run_id: runId,
          waivers: [],
          signed_off_by_actor_id: procUserId,
          signed_off_role: 'department_head',
          business_date: TODAY,
        },
        metadata: {
          correlation_id: randomUUID(),
          causation_id: null,
          actor: { user_id: procUserId, role: 'department_head', location_id: siteAId },
          occurred_at: new Date().toISOString(),
        },
        idempotency_key: directKey,
      }),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'VERIFICATION_UNRESOLVED',
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [directKey]), 0);

    const all = await signOff(
      'open_pos',
      runId,
      procHeadHeaders,
      findings.map((f) => ({
        finding_id: f['finding_id'] as string,
        narrative: `Waived by the procurement head in run ${run}`,
      })),
    );
    assert.strictEqual(all.status, 201, all.text);
    assert.strictEqual(all.body['status'], 'verified');
    assert.strictEqual(all.body['waived_count'], 7);
    const waived = await findingsOf('open_pos', runId, '&status=waived');
    assert.strictEqual(waived.length, 7);
    assert.ok(waived.every((f) => typeof f['waived_event_id'] === 'string'));
    assert.strictEqual((await findingsOf('open_pos', runId, '&status=open')).length, 0);
  });

  it('AC4: a sign-off on a run that is no longer the latest is VERIFICATION_STALE', async () => {
    const staleRunId = latestRun['open_pos']!;
    const fresh = await importManifest('open_pos', [
      {
        site_code: SITE_A,
        po_number_ext: PO1,
        line_no: '1',
        sku: POI1,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '100',
        received_qty: '40',
        open_qty: '60',
        over_receipt_tolerance_pct: '5',
        under_receipt_tolerance_pct: '5',
      },
      {
        site_code: SITE_A,
        po_number_ext: PO1,
        line_no: '2',
        sku: POI2,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '10',
        received_qty: '0',
        open_qty: '10',
        over_receipt_tolerance_pct: '',
        under_receipt_tolerance_pct: '',
      },
      {
        site_code: SITE_A,
        po_number_ext: PO2,
        line_no: '1',
        sku: POI1,
        supplier_ref_ext: 'SUP-13-2',
        ordered_qty: '7',
        received_qty: '0',
        open_qty: '7',
        over_receipt_tolerance_pct: '',
        under_receipt_tolerance_pct: '',
      },
    ]);
    assert.strictEqual(fresh.status, 201, fresh.text);
    // A new manifest load alone reverts the domain (SM-48: verified, not once-verified).
    assert.strictEqual((await domainStatus('open_pos'))['status'], 'unverified');
    const stale = await signOff('open_pos', staleRunId, procHeadHeaders);
    assert.strictEqual(stale.status, 409, stale.text);
    assert.strictEqual(stale.body['error_code'], 'VERIFICATION_STALE');
    const rerun = await runVerification('open_pos');
    assert.strictEqual(rerun.status, 201, rerun.text);
    assert.strictEqual(rerun.body['mismatch_count'], 0);
    assert.strictEqual((await domainStatus('open_pos'))['status'], 'unverified');
    const ok = await signOff('open_pos', rerun.body['run_id'] as string, procHeadHeaders);
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual((await domainStatus('open_pos'))['status'], 'verified');
  });

  it('AC4: the job-work head signs off challans and custody after waiving a challan quantity mismatch; the resubmitted identical manifest replays', async () => {
    const rows = [
      {
        site_code: SITE_A,
        challan_number_ext: CH1,
        challan_date: CHALLAN_DATE,
        order_number_ext: SO1,
        customer_party_code: CUSTOMER,
        sku: JWI,
        challan_qty: '999',
        uom: 'KG',
        challan_class: 'input',
      },
      {
        site_code: SITE_A,
        challan_number_ext: CH2,
        challan_date: CHALLAN_DATE,
        order_number_ext: SO1,
        customer_party_code: CUSTOMER,
        sku: JWI,
        challan_qty: '500',
        uom: 'KG',
        challan_class: 'input',
      },
    ];
    const imported = await importManifest('jobwork_challans', rows);
    assert.strictEqual(imported.status, 201, imported.text);
    const again = await importManifest('jobwork_challans', rows);
    assert.strictEqual(again.status, 200, again.text);
    assert.strictEqual(again.body['replayed'], true);
    assert.strictEqual(again.body['load_id'], imported.body['load_id']);
    const res = await runVerification('jobwork_challans');
    assert.strictEqual(res.status, 201, res.text);
    const findings = await findingsOf('jobwork_challans', res.body['run_id'] as string);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0]!['field'], 'challan_qty');
    assert.strictEqual(findings[0]!['source_value'], '999');
    assert.strictEqual(findings[0]!['platform_value'], '1000.000');
    assert.strictEqual(findings[0]!['platform_ref'], receipt1Id);
    const ok = await signOff('jobwork_challans', res.body['run_id'] as string, jwHeadHeaders, [
      {
        finding_id: findings[0]!['finding_id'] as string,
        narrative: 'Legacy challan register typo, physical challan reads 1000',
      },
    ]);
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(ok.body['verified_by_actor_id'], jwHeadUserId);
    // The latest custody run is the AC 2 quarantine run and stays refused after the ghost entry
    // was removed (the event is the record of what was reviewed); a fresh run is required.
    const stillQuarantined = await signOff(
      'custody_registers',
      latestRun['custody_registers']!,
      jwHeadHeaders,
    );
    assert.strictEqual(stillQuarantined.status, 409, stillQuarantined.text);
    assert.strictEqual(stillQuarantined.body['error_code'], 'VERIFICATION_UNRESOLVED');
    const custodyRun = await runVerification('custody_registers');
    assert.strictEqual(custodyRun.status, 201, custodyRun.text);
    assert.strictEqual(custodyRun.body['quarantined_count'], 0);
    const custody = await signOff(
      'custody_registers',
      custodyRun.body['run_id'] as string,
      jwHeadHeaders,
    );
    assert.strictEqual(custody.status, 201, custody.text);
    for (const domain of [
      'active_boms',
      'open_pos',
      'jobwork_challans',
      'custody_registers',
    ] as Domain[]) {
      assert.strictEqual((await domainStatus(domain))['status'], 'verified', domain);
    }
  });

  it('AC2: a challan without its statutory return clock is a state_mismatch, not a quarantine', async () => {
    const noClock = await seedReceipt({
      serviceOrderId: so1Id,
      challan: `${CH1}-NOCLOCK`,
      sku: JWI,
      qty: 7,
      withClock: false,
    });
    try {
      const imported = await importManifest('jobwork_challans', [
        {
          site_code: SITE_A,
          challan_number_ext: CH1,
          challan_date: CHALLAN_DATE,
          order_number_ext: SO1,
          customer_party_code: CUSTOMER,
          sku: JWI,
          challan_qty: '1000',
          uom: 'KG',
          challan_class: 'input',
        },
        {
          site_code: SITE_A,
          challan_number_ext: CH2,
          challan_date: CHALLAN_DATE,
          order_number_ext: SO1,
          customer_party_code: CUSTOMER,
          sku: JWI,
          challan_qty: '500',
          uom: 'KG',
          challan_class: 'input',
        },
        {
          site_code: SITE_A,
          challan_number_ext: `${CH1}-NOCLOCK`,
          challan_date: CHALLAN_DATE,
          order_number_ext: SO1,
          customer_party_code: CUSTOMER,
          sku: JWI,
          challan_qty: '7',
          uom: 'KG',
          challan_class: 'input',
        },
      ]);
      assert.strictEqual(imported.status, 201, imported.text);
      const res = await runVerification('jobwork_challans');
      assert.strictEqual(res.status, 201, res.text);
      const findings = await findingsOf('jobwork_challans', res.body['run_id'] as string);
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0]!['kind'], 'state_mismatch');
      assert.strictEqual(findings[0]!['field'], 'return_clock');
      assert.strictEqual(detailsOf(findings[0]!)['reason'], 'no_return_clock');
      assert.strictEqual(res.body['quarantined_count'], 0);
      assert.strictEqual(res.body['migrated_count'], 2);
    } finally {
      await getAdminPool().query(`DELETE FROM jobwork_material_receipt WHERE receipt_id = $1`, [
        noClock,
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // AC 5: status is derived from the latest run of the latest manifest
  // -------------------------------------------------------------------------

  it('AC5: a new run without sign-off reverts a verified domain, and the TypeScript derivation agrees with the route', async () => {
    // jobwork_challans was verified, then the previous test loaded a new manifest and ran again.
    assert.strictEqual((await domainStatus('jobwork_challans'))['status'], 'unverified');
    assert.strictEqual((await domainStatus('custody_registers'))['status'], 'verified');
    const rerun = await runVerification('custody_registers');
    assert.strictEqual(rerun.status, 201, rerun.text);
    const viaRoute = await domainStatus('custody_registers');
    assert.strictEqual(viaRoute['status'], 'unverified');
    assert.strictEqual(viaRoute['latest_run_id'], rerun.body['run_id']);
    assert.notEqual(viaRoute['verified_run_id'], viaRoute['latest_run_id']);
    const direct = await getDomainVerificationStatuses(siteAId, getPool());
    assert.deepEqual(
      direct.map((d) => [d.domain, d.status]),
      [
        ['active_boms', 'verified'],
        ['open_pos', 'verified'],
        ['jobwork_challans', 'unverified'],
        ['custody_registers', 'unverified'],
      ],
    );
    assert.strictEqual(
      direct.find((d) => d.domain === 'custody_registers')!.latest_run_id,
      rerun.body['run_id'],
    );
  });

  // -------------------------------------------------------------------------
  // Security arms
  // -------------------------------------------------------------------------

  it('SEC: a caller without the migration module is MODULE_ACCESS_DENIED; a site-B lead cannot read site A', async () => {
    const gate = await makeRequest(
      port,
      'GET',
      `/api/v1/migration/domains?site_id=${siteAId}`,
      undefined,
      gateHeaders,
    );
    assert.strictEqual(gate.status, 403, gate.text);
    assert.strictEqual(gate.body['error_code'], 'MODULE_ACCESS_DENIED');
    const gateImport = await importManifest('active_boms', [], { headers: gateHeaders });
    assert.strictEqual(gateImport.status, 403, gateImport.text);
    const otherSiteImport = await importManifest('active_boms', [], { site_id: siteBId });
    assert.strictEqual(otherSiteImport.status, 403, otherSiteImport.text);
    assert.strictEqual(otherSiteImport.body['error_code'], 'LOCATION_ACCESS_DENIED');
  });

  it('SEC: both event doors refuse the new migration events before any idempotency key is consumed', async () => {
    const key = `13-2-door-${randomUUID()}`;
    const envelope = {
      event_id: randomUUID(),
      stream_type: 'migration',
      stream_id: siteAId,
      event_type: 'migration.domain.verified',
      payload: {
        site_id: siteAId,
        domain: 'active_boms',
        run_id: latestRun['active_boms'],
        waivers: [],
        signed_off_by_actor_id: engHeadUserId,
        signed_off_role: 'department_head',
        business_date: TODAY,
      },
      event_version: 1,
      schema_version: 1,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: engHeadUserId, role: 'department_head', location_id: siteAId },
        device_id: `EDGE-13-2-${RUN}`,
        capture_method: 'MANUAL',
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: key,
    };
    // The events door's own RBAC wants migration write, so the lead carries the envelope; the
    // stream bar must refuse it before the assert or any idempotency key.
    const events = await makeRequest(port, 'POST', '/api/v1/events', envelope, leadHeaders);
    assert.strictEqual(events.status, 400, events.text);
    assert.strictEqual(events.body['error_code'], 'INVALID_EVENT_STREAM');
    const edge = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, leadHeaders);
    assert.strictEqual(edge.status, 403, edge.text);
    assert.strictEqual(edge.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [key]), 0);
    // The name on a foreign stream is refused by the pre-transaction shape assert.
    const foreign = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      { ...envelope, stream_type: 'jobwork', idempotency_key: `${key}-foreign` },
      jwHeadHeaders,
    );
    assert.strictEqual(foreign.status, 400, foreign.text);
    assert.strictEqual(foreign.body['error_code'], 'INVALID_EVENT_STREAM');
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [`${key}-foreign`]), 0);
  });
});

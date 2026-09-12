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
import { OPENING_STOCK_TEMPLATE_V1 } from '../../src/migration/opening-stock-template.js';
import { MIGRATION_ERROR_CODES } from '../../src/compliance/migration-opening-stock.js';
import { MIGRATION_DOCUMENT_ERROR_CODES } from '../../src/compliance/migration-documents.js';
import {
  MAX_AUDIT_VARIANCE_ENTRIES,
  MIGRATION_GOLIVE_ERROR_CODES,
  evaluateGoLiveGate,
} from '../../src/compliance/migration-golive.js';
import { SEGREGATED_ROLE_PAIRS } from '../../src/cli/verify-segregated-roles-core.js';
import { toIstCalendarDate } from '../../src/lib/business-days.js';

/**
 * Story 13.3 Go-Live Reconciliation Sign-Off Gate (FR-DM-03, SM-48). Real PostgreSQL, the real
 * production router, SCIM provisioning and dev-token auth. Tests run serially and build on each
 * other's state; every identifier is run-scoped. The harness scaffolding is a deliberate local
 * re-implementation of the story-13-1 / story-13-2 closures (never import cross-story).
 *
 * Fixture policy: opening stock goes through the Story 13.1 import route; the ERP snapshot rows
 * are admin-pool rows exactly as the erp_stock_balance projection stores them (the sync route
 * soft-closes every PO not in its batch, which would disturb other files' data); the one
 * migration_import header fabricated by admin pool is the SOD-07 "loader" negative fixture. The
 * document-domain loads, verification runs and the opening-stock promotion are fabricated the same
 * way (admin pool, the rows the 13.1 / 13.2 appliers write) because this story composes their
 * STATUS, not their mechanics - the 13.1 and 13.2 suites own those.
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
const TODAY = toIstCalendarDate(new Date());
const DOCUMENT_DOMAINS = ['active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'];

describe('Story 13.3 Go-Live Reconciliation Sign-Off Gate', () => {
  let server: Server;
  let port: number;

  const SITE_A = `SITE-A-13-3-${RUN}`;
  const SITE_B = `SITE-B-13-3-${RUN}`;
  const BIN_A1 = `BIN-A1-13-3-${RUN}`;
  const PLAIN = `PLAIN-13-3-${RUN}`;
  const SECOND = `SECOND-13-3-${RUN}`;
  const COUNTED_ON = isoDateOffset(-1);

  let siteAId: string;
  let siteBId: string;
  let binA1Id: string;

  let leadUserId: string;
  let leadHeaders: Record<string, string>;
  let leadBHeaders: Record<string, string>;
  let leadStarHeaders: Record<string, string>;
  let headUserId: string;
  let headHeaders: Record<string, string>;
  let financeUserId: string;
  let financeHeaders: Record<string, string>;
  let dualUserId: string;
  let dualHeaders: Record<string, string>;
  let loaderFinanceUserId: string;
  let loaderFinanceHeaders: Record<string, string>;
  let otherSiteHeadHeaders: Record<string, string>;
  let engHeadHeaders: Record<string, string>;
  let gateHeaders: Record<string, string>;
  let bothHatsUserId: string;
  let bothHatsHeaders: Record<string, string>;

  let headSignoffEventId: string;
  let financeSignoffEventId: string;
  let staleHeadSignoffEventId: string;
  let staleFinanceSignoffEventId: string;
  let unblockEventId: string;

  const varianceKey = () => `ERP|${BIN_A1}|${PLAIN}|-|-`;

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

  async function seedLocation(level: string, code: string, siteId: string | null): Promise<string> {
    const locationId = randomUUID();
    await getAdminPool().query(
      `INSERT INTO location_register (location_id, location_code, level, parent_location_id, site_id, zone_type, temperature_class, quarantine, status)
       VALUES ($1, $2, $3, $4, $5, 'general', 'ambient', false, 'active')`,
      [locationId, code, level, siteId, siteId ?? locationId],
    );
    return locationId;
  }

  async function seedItem(sku: string): Promise<void> {
    await getAdminPool().query(
      `INSERT INTO item_master (sku, uom, lot_controlled, serial_controlled, hazmat, quarantine_required, bis_licence_required, valuation_method, business_stream, status)
       VALUES ($1, 'EA', false, false, false, false, false, 'weighted_average', 'production', 'active')`,
      [sku],
    );
  }

  /**
   * erp_stock_balance is keyed on its grain (uq_erp_stock_balance_grain): a re-extract UPDATES
   * the row with a later snapshot_at, exactly as the Story 2.9 sync upsert does.
   */
  async function seedSnapshot(
    snapshotAt: string,
    rows: Array<{ sku: string; quantity: string; unit_cost: string }>,
  ): Promise<void> {
    for (const r of rows) {
      const updated = await getAdminPool().query(
        `UPDATE erp_stock_balance
            SET quantity = $3, unit_cost = $4, snapshot_at = $5::timestamptz, last_synced_at = now(), updated_at = now()
          WHERE source_system = 'ERP' AND site_id = $1 AND location_code = $2 AND sku = $6
            AND lot_number_ext IS NULL AND serial_number_ext IS NULL`,
        [siteAId, BIN_A1, r.quantity, r.unit_cost, snapshotAt, r.sku],
      );
      if (updated.rowCount === 0) {
        await getAdminPool().query(
          `INSERT INTO erp_stock_balance
             (source_system, site_code_ext, site_id, location_code, location_id, sku, lot_number_ext, serial_number_ext,
              quantity, unit_cost, snapshot_at, last_synced_at)
           VALUES ('ERP', $1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8::timestamptz, now())`,
          [SITE_A, siteAId, BIN_A1, binA1Id, r.sku, r.quantity, r.unit_cost, snapshotAt],
        );
      }
    }
  }

  /**
   * The rows Story 13.2's appliers write for one document-domain load and its verification run,
   * with the stage row pointing at them; `verified` also stamps the sign-off columns so
   * getDomainVerificationStatuses derives `verified`. The lead is the loader and runner (never a
   * signer), so the SOD-07 legs stay untouched for the head and finance users.
   */
  async function fabricateDomainRun(
    domain: string,
    opts: { verified: boolean; quarantined?: number; openFinding?: boolean },
  ): Promise<{ loadId: string; runId: string }> {
    const loadId = randomUUID();
    const runId = randomUUID();
    const adminPool = getAdminPool();
    await adminPool.query(
      `INSERT INTO migration_import (load_id, site_id, domain, file_name, file_sha256, template_version, mode, idempotency_key, created_by_actor_id)
       VALUES ($1, $2, $3, $4, $7, 'v1', 'initial', $5, $6)`,
      [
        loadId,
        siteAId,
        domain,
        `${domain}-${run}.csv`,
        `13-3-${domain}-load-${run}`,
        leadUserId,
        String(DOCUMENT_DOMAINS.indexOf(domain) + 1).repeat(64),
      ],
    );
    await adminPool.query(
      `INSERT INTO migration_domain_verification
         (run_id, site_id, domain, load_id, source_count, migrated_count, quarantined_count, mismatch_count, waived_count,
          run_by_actor_id, findings_sha256, source_event_id, occurred_at, business_date)
       VALUES ($1, $2, $3, $4, 1, 1, $5, $6, 0, $7, repeat('2', 64), $8, now(), $9::date)`,
      [
        runId,
        siteAId,
        domain,
        loadId,
        opts.quarantined ?? 0,
        opts.openFinding ? 1 : 0,
        leadUserId,
        randomUUID(),
        TODAY,
      ],
    );
    if (opts.openFinding) {
      await adminPool.query(
        `INSERT INTO migration_domain_verification_finding
           (finding_id, run_id, site_id, domain, kind, error_code, document_ref_ext, line_ref, details, status)
         VALUES ($1, $2, $3, $4, 'missing_in_platform', 'RECONCILIATION_MISMATCH', $5, '1', '{}'::jsonb, 'open')`,
        [randomUUID(), runId, siteAId, domain, `DOC-${RUN}`],
      );
    }
    await adminPool.query(
      `INSERT INTO migration_stage (site_id, domain, stage, latest_load_id, latest_run_id, verified_run_id, verified_at, verified_by_actor_id)
       VALUES ($1, $2, 'staging', $3, $4, $5, $6, $7)
       ON CONFLICT (site_id, domain) DO UPDATE
         SET latest_load_id = EXCLUDED.latest_load_id, latest_run_id = EXCLUDED.latest_run_id,
             verified_run_id = EXCLUDED.verified_run_id, verified_at = EXCLUDED.verified_at,
             verified_by_actor_id = EXCLUDED.verified_by_actor_id, updated_at = now()`,
      [
        siteAId,
        domain,
        loadId,
        runId,
        opts.verified ? runId : null,
        opts.verified ? new Date().toISOString() : null,
        opts.verified ? randomUUID() : null,
      ],
    );
    return { loadId, runId };
  }

  async function markDomainVerified(domain: string, runId: string): Promise<void> {
    await getAdminPool().query(
      `UPDATE migration_stage SET verified_run_id = $3, verified_at = now(), verified_by_actor_id = $4, updated_at = now()
        WHERE site_id = $1 AND domain = $2`,
      [siteAId, domain, runId, randomUUID()],
    );
  }

  /** The row the Story 13.1 promotion applier leaves behind (stage `dry_run`). */
  async function fabricatePromotion(): Promise<void> {
    await getAdminPool().query(
      `UPDATE migration_stage
          SET stage = 'dry_run', promoted_at = now(), promoted_event_id = $2, promoted_by_actor_id = $3,
              posted_row_count = 2, updated_at = now()
        WHERE site_id = $1 AND domain = 'opening_stock'`,
      [siteAId, randomUUID(), leadUserId],
    );
  }

  async function report(headers = leadHeaders, siteId = siteAId): Promise<HttpResult> {
    return makeRequest(
      port,
      'GET',
      `/api/v1/migration/golive/reconciliation?site_id=${siteId}`,
      undefined,
      headers,
    );
  }

  async function signOff(
    signoffType: string,
    headers: Record<string, string>,
    key = `13-3-signoff-${randomUUID()}`,
    siteId = siteAId,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/migration/golive/sign-offs',
      { site_id: siteId, signoff_type: signoffType, idempotency_key: key },
      headers,
    );
  }

  async function unblock(
    key = `13-3-unblock-${randomUUID()}`,
    headers = leadHeaders,
    siteId = siteAId,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/migration/golive/unblock',
      { site_id: siteId, idempotency_key: key },
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

  function domainOf(body: Record<string, unknown>, domain: string): Record<string, unknown> {
    const domains = body['domains'] as Record<string, unknown>[];
    const found = domains.find((d) => d['domain'] === domain);
    assert.ok(found, `report has no domain ${domain}`);
    return found;
  }

  function gateOf(body: Record<string, unknown>): {
    satisfied: boolean;
    blocking: Record<string, unknown> | null;
  } {
    return body['gate'] as { satisfied: boolean; blocking: Record<string, unknown> | null };
  }

  function discrepanciesOf(body: Record<string, unknown>): Record<string, unknown>[] {
    return body['remaining_discrepancies'] as Record<string, unknown>[];
  }

  async function gateRefusal(): Promise<unknown> {
    const client = await getPool().connect();
    try {
      return (await evaluateGoLiveGate(siteAId, client)).refusal;
    } finally {
      client.release();
    }
  }

  function signoffEnvelope(opts: {
    key: string;
    signoffType: string;
    actorId: string;
    actorRole: string;
    payloadActorId?: string;
    payloadRole?: string;
  }) {
    return {
      stream_type: 'migration',
      stream_id: siteAId,
      event_type: 'migration.signoff.recorded',
      payload: {
        site_id: siteAId,
        signoff_type: opts.signoffType,
        signed_off_by_actor_id: opts.payloadActorId ?? opts.actorId,
        signed_off_role: opts.payloadRole ?? opts.actorRole,
        business_date: TODAY,
      },
      metadata: {
        correlation_id: randomUUID(),
        causation_id: null,
        actor: { user_id: opts.actorId, role: opts.actorRole, location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: opts.key,
    };
  }

  function unblockEnvelope(opts: { key: string; headEventId: string; financeEventId: string }) {
    return {
      stream_type: 'migration',
      stream_id: siteAId,
      event_type: 'migration.golive.unblocked',
      payload: {
        site_id: siteAId,
        department_head_signoff_event_id: opts.headEventId,
        finance_signoff_event_id: opts.financeEventId,
        unexplained_variance_count: 0,
        business_date: TODAY,
      },
      metadata: {
        correlation_id: randomUUID(),
        causation_id: null,
        actor: { user_id: leadUserId, role: 'migration_lead', location_id: siteAId },
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: opts.key,
    };
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
      '../../read/projections/migration_document_manifest_row.sql',
      '../../read/projections/migration_domain_verification.sql',
      '../../read/projections/migration_domain_verification_finding.sql',
      '../../read/projections/migration_domain_platform_exclusion.sql',
      '../../read/projections/migration_golive_signoff.sql',
      '../../read/projections/migration_golive_status.sql',
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
    binA1Id = await seedLocation('bin', BIN_A1, siteAId);
    await seedItem(PLAIN);
    await seedItem(SECOND);

    const lead = `migration-lead-13-3-${run}@example.com`;
    leadUserId = await provisionUser(port, lead, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteAId },
      { role: 'migration_lead', module: 'migration', functionScope: 'read', locationId: siteAId },
    ]);
    leadHeaders = await authFor(port, lead);

    const leadB = `migration-lead-b-13-3-${run}@example.com`;
    await provisionUser(port, leadB, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteBId },
      { role: 'migration_lead', module: 'migration', functionScope: 'read', locationId: siteBId },
    ]);
    leadBHeaders = await authFor(port, leadB);

    // A global lead: the only caller that can reach the unblock route with an unregistered site.
    const leadStar = `migration-lead-star-13-3-${run}@example.com`;
    await provisionUser(port, leadStar, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: '*' },
    ]);
    leadStarHeaders = await authFor(port, leadStar);

    // Access matrix 3.7: the department head signs off domain balances; a write assignment on
    // module `migration` (which also satisfies the wrapper's read requirement).
    const head = `dept-head-13-3-${run}@example.com`;
    headUserId = await provisionUser(port, head, [
      { role: 'department_head', module: 'migration', functionScope: 'write', locationId: siteAId },
    ]);
    headHeaders = await authFor(port, head);

    const finance = `finance-13-3-${run}@example.com`;
    financeUserId = await provisionUser(port, finance, [
      { role: 'finance_controller', module: 'migration', functionScope: 'write', locationId: '*' },
    ]);
    financeHeaders = await authFor(port, finance);

    // SOD-07 arm 1: one person holding both the migration-lead hat and the sign-off hat.
    const dual = `dual-13-3-${run}@example.com`;
    dualUserId = await provisionUser(port, dual, [
      { role: 'migration_lead', module: 'migration', functionScope: 'write', locationId: siteAId },
      { role: 'department_head', module: 'migration', functionScope: 'write', locationId: siteAId },
    ]);
    dualHeaders = await authFor(port, dual);

    // SOD-07 arm 2: a finance controller who is NOT a migration lead by role but who executed a
    // load for the site (the header is fabricated below as the negative fixture).
    const loaderFinance = `loader-finance-13-3-${run}@example.com`;
    loaderFinanceUserId = await provisionUser(port, loaderFinance, [
      {
        role: 'finance_controller',
        module: 'migration',
        functionScope: 'write',
        locationId: siteAId,
      },
    ]);
    loaderFinanceHeaders = await authFor(port, loaderFinance);
    await adminPool.query(
      `INSERT INTO migration_import (load_id, site_id, domain, file_name, file_sha256, template_version, mode, idempotency_key, created_by_actor_id)
       VALUES ($1, $2, 'active_boms', 'fabricated.csv', repeat('0', 64), 'v1', 'initial', $3, $4)`,
      [randomUUID(), siteAId, `13-3-fabricated-load-${run}`, loaderFinanceUserId],
    );

    // Code review 2026-09-12 decision 1: one person holding BOTH final sign-off hats on site B.
    const bothHats = `both-hats-13-3-${run}@example.com`;
    bothHatsUserId = await provisionUser(port, bothHats, [
      { role: 'department_head', module: 'migration', functionScope: 'write', locationId: siteBId },
      {
        role: 'finance_controller',
        module: 'migration',
        functionScope: 'write',
        locationId: siteBId,
      },
    ]);
    bothHatsHeaders = await authFor(port, bothHats);

    const otherHead = `other-head-13-3-${run}@example.com`;
    await provisionUser(port, otherHead, [
      { role: 'department_head', module: 'migration', functionScope: 'write', locationId: siteBId },
    ]);
    otherSiteHeadHeaders = await authFor(port, otherHead);

    // A 13.2-style head: engineering write, migration read only - not a final sign-off authority.
    const engHead = `eng-head-13-3-${run}@example.com`;
    await provisionUser(port, engHead, [
      { role: 'department_head', module: 'engineering', functionScope: 'write', locationId: '*' },
      { role: 'department_head', module: 'migration', functionScope: 'read', locationId: '*' },
    ]);
    engHeadHeaders = await authFor(port, engHead);

    const gate = `gate-13-3-${run}@example.com`;
    await provisionUser(port, gate, [
      { role: 'gate_officer', module: 'gate', functionScope: 'write', locationId: siteAId },
    ]);
    gateHeaders = await authFor(port, gate);
  });

  after(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // Task 0.2 / 0.3 pins: reused error codes and the already-registered SOD-07 pairs
  // -------------------------------------------------------------------------

  it('Task 0.2: the gate reuses the 13.1 and 13.2 error-code literals (APPROVAL_REQUIRED, VARIANCE_UNRESOLVED, SIGNOFF_ACTOR_CONFLICT)', () => {
    assert.strictEqual(
      MIGRATION_GOLIVE_ERROR_CODES.APPROVAL_REQUIRED,
      MIGRATION_ERROR_CODES.APPROVAL_REQUIRED,
    );
    assert.strictEqual(
      MIGRATION_GOLIVE_ERROR_CODES.VARIANCE_UNRESOLVED,
      MIGRATION_ERROR_CODES.VARIANCE_UNRESOLVED,
    );
    assert.strictEqual(
      MIGRATION_GOLIVE_ERROR_CODES.INVALID_STATE,
      MIGRATION_ERROR_CODES.INVALID_STATE,
    );
    assert.strictEqual(
      MIGRATION_GOLIVE_ERROR_CODES.SIGNOFF_ACTOR_CONFLICT,
      MIGRATION_DOCUMENT_ERROR_CODES.SIGNOFF_ACTOR_CONFLICT,
    );
    // The three codes this story mints collide with nothing upstream.
    for (const minted of ['SIGNOFF_STALE', 'PROMOTION_REQUIRED', 'DOMAIN_UNVERIFIED']) {
      assert.ok(!(minted in MIGRATION_ERROR_CODES));
      assert.ok(!(minted in MIGRATION_DOCUMENT_ERROR_CODES));
    }
    // Task 0.3: both role combinations this story gates are already registered SOD-07 pairs;
    // no new pair is minted.
    const pairs = SEGREGATED_ROLE_PAIRS.filter((p) => p.setterRole === 'migration_lead').map(
      (p) => p.approverRole,
    );
    assert.ok(pairs.includes('department_head'));
    assert.ok(pairs.includes('finance_controller'));
  });

  // -------------------------------------------------------------------------
  // AC 1: the reconciliation report
  // -------------------------------------------------------------------------

  it('AC1: before any load the report covers the whole wave scope, every domain empty, gate blocked on the sign-offs', async () => {
    const res = await report();
    assert.strictEqual(res.status, 200, res.text);
    assert.deepEqual(res.body['wave_scope'], ['opening_stock', ...DOCUMENT_DOMAINS]);
    const domains = res.body['domains'] as Record<string, unknown>[];
    assert.deepEqual(
      domains.map((d) => d['domain']),
      res.body['wave_scope'],
    );
    const os = domainOf(res.body, 'opening_stock');
    assert.strictEqual(os['variance_basis'], 'quantity_value');
    assert.strictEqual(os['stage'], 'staging');
    assert.strictEqual(os['source_count'], 0);
    assert.strictEqual(os['migrated_count'], 0);
    assert.strictEqual(os['load_count'], 0);
    assert.strictEqual(os['variance_count'], 0);
    assert.strictEqual(os['unexplained_count'], 0);
    assert.strictEqual(os['unexplained_value'], '0.00');
    for (const domain of DOCUMENT_DOMAINS) {
      const d = domainOf(res.body, domain);
      assert.strictEqual(d['status'], 'unverified');
      assert.strictEqual(d['variance_basis'], 'reconciliation_mismatch_count');
      assert.strictEqual(d['open_finding_count'], null);
      assert.strictEqual(d['source_count'], null);
    }
    const signoffs = res.body['signoffs'] as Record<string, unknown>;
    assert.strictEqual(signoffs['department_head_final'], null);
    assert.strictEqual(signoffs['finance_final'], null);
    // The fabricated loader fixture is the site's only data activity so far.
    const activity = res.body['data_activity'] as Record<string, unknown>;
    assert.strictEqual(typeof activity['latest_import_at'], 'string');
    assert.strictEqual(activity['latest_snapshot_at'], null);
    assert.deepEqual(res.body['golive'], { unblocked: false });
    const gate = gateOf(res.body);
    assert.strictEqual(gate.satisfied, false);
    assert.strictEqual(gate.blocking!['error_code'], 'APPROVAL_REQUIRED');
    assert.deepEqual((gate.blocking!['details'] as Record<string, unknown>)['missing_signoffs'], [
      'department_head_final',
      'finance_final',
    ]);
    const discrepancies = discrepanciesOf(res.body);
    assert.deepEqual(
      discrepancies.map((d) => [d['domain'], d['kind'], d['blocks_golive']]),
      [
        ['opening_stock', 'opening_stock_not_promoted', true],
        ['active_boms', 'domain_unverified', true],
        ['open_pos', 'domain_unverified', true],
        ['jobwork_challans', 'domain_unverified', true],
        ['custody_registers', 'domain_unverified', true],
      ],
    );
    assert.strictEqual(discrepancies[0]!['stage'], null);
  });

  it('AC1: after a load and an ERP snapshot the report carries source vs migrated counts, the quantity/value variance and its explanation status', async () => {
    const imported = await makeRequest(
      port,
      'POST',
      '/api/v1/migration/opening-stock/imports',
      {
        site_id: siteAId,
        file_name: `opening-${run}.csv`,
        template_version: 'v1',
        mode: 'initial',
        csv: csv([
          row({ sku: PLAIN, quantity: '10', unit_cost: '5.0000' }),
          row({ sku: SECOND, quantity: '4', unit_cost: '2.5000' }),
        ]),
        idempotency_key: `13-3-import-${run}`,
      },
      leadHeaders,
    );
    assert.strictEqual(imported.status, 201, imported.text);
    assert.strictEqual(imported.body['accepted_count'], 2, imported.text);

    // The ERP says 12 of PLAIN where 10 were counted: one quantity_mismatch worth -10.00.
    await seedSnapshot(new Date(Date.now() - 60_000).toISOString(), [
      { sku: PLAIN, quantity: '12', unit_cost: '5.000000' },
      { sku: SECOND, quantity: '4', unit_cost: '2.500000' },
    ]);

    const res = await report();
    assert.strictEqual(res.status, 200, res.text);
    const os = domainOf(res.body, 'opening_stock');
    assert.deepEqual(os['source_systems'], ['ERP']);
    assert.strictEqual(os['source_count'], 2);
    assert.strictEqual(os['migrated_count'], 2);
    assert.strictEqual(os['posted_count'], 0);
    assert.strictEqual(os['load_count'], 1);
    assert.strictEqual(os['loaded_row_count'], 2);
    assert.strictEqual(os['accepted_count'], 2);
    assert.strictEqual(os['rejected_count'], 0);
    assert.strictEqual(os['variance_count'], 1);
    assert.strictEqual(os['open_count'], 1);
    assert.strictEqual(os['explained_count'], 0);
    assert.strictEqual(os['unexplained_count'], 1);
    assert.strictEqual(os['unexplained_value'], '10.00');
    const variances = os['variances'] as Record<string, unknown>[];
    assert.strictEqual(variances.length, 1);
    assert.strictEqual(variances[0]!['variance_key'], varianceKey());
    assert.strictEqual(variances[0]!['kind'], 'quantity_mismatch');
    assert.strictEqual(variances[0]!['quantity_delta'], '-2.000000');
    assert.strictEqual(variances[0]!['variance_value'], '-10.00');
    assert.strictEqual(variances[0]!['status'], 'open');
    const activity = res.body['data_activity'] as Record<string, unknown>;
    assert.strictEqual(typeof activity['latest_snapshot_at'], 'string');
    const discrepancies = discrepanciesOf(res.body);
    const unexplained = discrepancies.filter((d) => d['kind'] === 'unexplained_variance');
    assert.strictEqual(unexplained.length, 1);
    assert.strictEqual(unexplained[0]!['domain'], 'opening_stock');
    assert.strictEqual(unexplained[0]!['variance_key'], varianceKey());
    assert.strictEqual(unexplained[0]!['status'], 'open');
    assert.strictEqual(unexplained[0]!['blocks_golive'], true);
    assert.strictEqual(discrepancies.length, 6);
  });

  // -------------------------------------------------------------------------
  // AC 2: go-live without both sign-offs is APPROVAL_REQUIRED
  // -------------------------------------------------------------------------

  it('AC2: go-live requested with neither sign-off is blocked APPROVAL_REQUIRED naming both', async () => {
    const res = await unblock();
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body['error_code'], 'APPROVAL_REQUIRED');
    assert.deepEqual(detailsOf(res.body)['missing_signoffs'], [
      'department_head_final',
      'finance_final',
    ]);
    assert.deepEqual(detailsOf(res.body)['recorded_signoffs'], []);
    assert.strictEqual(
      await domainEventCount(`event_type = 'migration.golive.unblocked' AND stream_id = $1`, [
        siteAId,
      ]),
      0,
    );
  });

  // -------------------------------------------------------------------------
  // Task 5.3: SOD-07 and the sign-off RBAC
  // -------------------------------------------------------------------------

  it('SOD-07: a migration lead cannot give either sign-off; a lead who also holds the head hat is SIGNOFF_ACTOR_CONFLICT in the route and in the applier', async () => {
    for (const [type, role] of [
      ['department_head_final', 'department_head'],
      ['finance_final', 'finance_controller'],
    ]) {
      const lead = await signOff(type!, leadHeaders);
      assert.strictEqual(lead.status, 403, lead.text);
      assert.strictEqual(lead.body['error_code'], 'FUNCTION_ACCESS_DENIED');
      assert.deepEqual(detailsOf(lead.body)['required_roles'], [role]);
      assert.strictEqual(detailsOf(lead.body)['required_module'], 'migration');
    }

    const dual = await signOff('department_head_final', dualHeaders);
    assert.strictEqual(dual.status, 403, dual.text);
    assert.strictEqual(dual.body['error_code'], 'SIGNOFF_ACTOR_CONFLICT');
    assert.strictEqual(detailsOf(dual.body)['conflicting_role'], 'migration_lead');

    // The applier repeats the check from the envelope's authenticated actor.
    await assert.rejects(
      persistEvent(
        signoffEnvelope({
          key: `13-3-direct-sod-${randomUUID()}`,
          signoffType: 'department_head_final',
          actorId: dualUserId,
          actorRole: 'department_head',
        }),
      ),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'SIGNOFF_ACTOR_CONFLICT',
    );
    assert.strictEqual(
      await domainEventCount(`event_type = 'migration.signoff.recorded' AND stream_id = $1`, [
        siteAId,
      ]),
      0,
    );
  });

  it("Applier provenance: a payload naming a signer other than the envelope actor, a payload role that is not the type's role, and an actor without the role are each refused before any row", async () => {
    // The shape assert refuses a payload that names someone else (no idempotency key consumed).
    const mismatch = `13-3-payload-actor-${randomUUID()}`;
    await assert.rejects(
      persistEvent(
        signoffEnvelope({
          key: mismatch,
          signoffType: 'department_head_final',
          actorId: dualUserId,
          actorRole: 'department_head',
          payloadActorId: headUserId,
        }),
      ),
      (err: unknown) => {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return (
          e.errorCode === 'INVALID_PARAMS' && e.details?.['reason'] === 'payload_actor_mismatch'
        );
      },
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [mismatch]), 0);

    const wrongRole = `13-3-payload-role-${randomUUID()}`;
    await assert.rejects(
      persistEvent(
        signoffEnvelope({
          key: wrongRole,
          signoffType: 'finance_final',
          actorId: financeUserId,
          actorRole: 'finance_controller',
          payloadRole: 'department_head',
        }),
      ),
      (err: unknown) => {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return (
          e.errorCode === 'INVALID_PARAMS' && e.details?.['expected_role'] === 'finance_controller'
        );
      },
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [wrongRole]), 0);

    // The applier proves the positive privilege leg from user_role_assignments, not the token:
    // a consistent envelope from a user who holds no finance_controller write assignment.
    const noRole = `13-3-applier-role-${randomUUID()}`;
    await assert.rejects(
      persistEvent(
        signoffEnvelope({
          key: noRole,
          signoffType: 'finance_final',
          actorId: headUserId,
          actorRole: 'finance_controller',
        }),
      ),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'FUNCTION_ACCESS_DENIED',
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [noRole]), 0);
  });

  it('SOD-07: a finance controller who executed a load for the site cannot give the final financial sign-off', async () => {
    const res = await signOff('finance_final', loaderFinanceHeaders);
    assert.strictEqual(res.status, 403, res.text);
    assert.strictEqual(res.body['error_code'], 'SIGNOFF_ACTOR_CONFLICT');
    assert.strictEqual(detailsOf(res.body)['conflicting_role'], 'migration_loader');
  });

  it('Decision 1 (two hats, two people): the actor who gave one final sign-off cannot give the other', async () => {
    // Site B has no data at all; the sign-off route still records (the stage lock mints the row).
    const first = await signOff('department_head_final', bothHatsHeaders, undefined, siteBId);
    assert.strictEqual(first.status, 201, first.text);
    assert.strictEqual(first.body['signed_off_by_actor_id'], bothHatsUserId);

    const second = await signOff('finance_final', bothHatsHeaders, undefined, siteBId);
    assert.strictEqual(second.status, 403, second.text);
    assert.strictEqual(second.body['error_code'], 'SIGNOFF_ACTOR_CONFLICT');
    assert.strictEqual(detailsOf(second.body)['conflicting_role'], 'other_final_signoff');
    assert.strictEqual(detailsOf(second.body)['other_signoff_type'], 'department_head_final');
    assert.strictEqual(detailsOf(second.body)['other_source_event_id'], first.body['event_id']);
    assert.strictEqual(
      await domainEventCount(`event_type = 'migration.signoff.recorded' AND stream_id = $1`, [
        siteBId,
      ]),
      1,
    );
  });

  it('RBAC: a head of another site, a head without a migration write assignment, a wrong signoff_type and a wrong role are each refused', async () => {
    const otherSite = await signOff('department_head_final', otherSiteHeadHeaders);
    assert.strictEqual(otherSite.status, 403, otherSite.text);
    assert.strictEqual(otherSite.body['error_code'], 'LOCATION_ACCESS_DENIED');

    const wrongModule = await signOff('department_head_final', engHeadHeaders);
    assert.strictEqual(wrongModule.status, 403, wrongModule.text);
    assert.strictEqual(wrongModule.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.strictEqual(detailsOf(wrongModule.body)['required_module'], 'migration');

    const headAsFinance = await signOff('finance_final', headHeaders);
    assert.strictEqual(headAsFinance.status, 403, headAsFinance.text);
    assert.strictEqual(headAsFinance.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    assert.deepEqual(detailsOf(headAsFinance.body)['required_roles'], ['finance_controller']);

    const badType = await signOff('final', financeHeaders);
    assert.strictEqual(badType.status, 400, badType.text);
    assert.strictEqual(badType.body['error_code'], 'INVALID_PARAMS');
    assert.strictEqual(detailsOf(badType.body)['field'], 'signoff_type');

    const noModule = await signOff('department_head_final', gateHeaders);
    assert.strictEqual(noModule.status, 403, noModule.text);
    assert.strictEqual(noModule.body['error_code'], 'MODULE_ACCESS_DENIED');
  });

  it('404: a well-formed site_id that is not a registered site is NOT_FOUND on all three routes', async () => {
    const ghost = randomUUID();
    const rep = await report(financeHeaders, ghost);
    assert.strictEqual(rep.status, 404, rep.text);
    assert.strictEqual(rep.body['error_code'], 'NOT_FOUND');
    const sign = await signOff('finance_final', financeHeaders, undefined, ghost);
    assert.strictEqual(sign.status, 404, sign.text);
    assert.strictEqual(sign.body['error_code'], 'NOT_FOUND');
    const un = await unblock(undefined, leadStarHeaders, ghost);
    assert.strictEqual(un.status, 404, un.text);
    assert.strictEqual(un.body['error_code'], 'NOT_FOUND');
    // The bin is a location but not a site.
    const bin = await unblock(undefined, leadStarHeaders, binA1Id);
    assert.strictEqual(bin.status, 404, bin.text);
  });

  // -------------------------------------------------------------------------
  // AC 2 (continued): one sign-off is still APPROVAL_REQUIRED; sign-offs are immutable
  // -------------------------------------------------------------------------

  it('AC2: the department-head sign-off records once (replay returns it, a second attestation is refused) and go-live stays blocked on finance', async () => {
    const key = `13-3-head-signoff-${run}`;
    const ok = await signOff('department_head_final', headHeaders, key);
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(ok.body['signoff_type'], 'department_head_final');
    assert.strictEqual(ok.body['signed_off_by_actor_id'], headUserId);
    assert.strictEqual(ok.body['signed_off_role'], 'department_head');
    assert.strictEqual(ok.body['business_date'], TODAY);
    assert.strictEqual(ok.body['stale'], false);
    assert.strictEqual(ok.body['superseded_count'], 0);
    headSignoffEventId = ok.body['event_id'] as string;
    assert.strictEqual(ok.body['source_event_id'], headSignoffEventId);

    const replay = await signOff('department_head_final', headHeaders, key);
    assert.strictEqual(replay.status, 200, replay.text);
    assert.strictEqual(replay.body['replayed'], true);
    assert.strictEqual(replay.body['event_id'], headSignoffEventId);
    assert.strictEqual(replay.body['source_event_id'], headSignoffEventId);

    const again = await signOff('department_head_final', headHeaders);
    assert.strictEqual(again.status, 409, again.text);
    assert.strictEqual(again.body['error_code'], 'INVALID_STATE');
    assert.strictEqual(detailsOf(again.body)['reason'], 'already_signed_off');
    assert.strictEqual(detailsOf(again.body)['source_event_id'], headSignoffEventId);
    assert.strictEqual(
      await domainEventCount(`event_type = 'migration.signoff.recorded' AND stream_id = $1`, [
        siteAId,
      ]),
      1,
    );

    const blocked = await unblock();
    assert.strictEqual(blocked.status, 409, blocked.text);
    assert.strictEqual(blocked.body['error_code'], 'APPROVAL_REQUIRED');
    assert.deepEqual(detailsOf(blocked.body)['missing_signoffs'], ['finance_final']);
    assert.deepEqual(detailsOf(blocked.body)['recorded_signoffs'], ['department_head_final']);
  });

  // -------------------------------------------------------------------------
  // AC 3: both sign-offs, one unexplained variance -> VARIANCE_UNRESOLVED with the list
  // -------------------------------------------------------------------------

  it('AC3: with both sign-offs recorded and an unexplained variance, go-live is VARIANCE_UNRESOLVED listing every blocking variance, in the route and in the applier', async () => {
    const fin = await signOff('finance_final', financeHeaders, `13-3-finance-signoff-${run}`);
    assert.strictEqual(fin.status, 201, fin.text);
    assert.strictEqual(fin.body['signed_off_by_actor_id'], financeUserId);
    assert.strictEqual(fin.body['signed_off_role'], 'finance_controller');
    financeSignoffEventId = fin.body['event_id'] as string;

    const res = await unblock();
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body['error_code'], 'VARIANCE_UNRESOLVED');
    assert.strictEqual(detailsOf(res.body)['unexplained_count'], 1);
    const listed = detailsOf(res.body)['unexplained'] as Record<string, unknown>[];
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0]!['variance_key'], varianceKey());
    assert.strictEqual(listed[0]!['kind'], 'quantity_mismatch');
    assert.strictEqual(listed[0]!['quantity_delta'], '-2.000000');
    assert.strictEqual(listed[0]!['variance_value'], '-10.00');
    assert.strictEqual(listed[0]!['status'], 'open');
    assert.strictEqual(detailsOf(res.body)['unexplained_truncated'], undefined);
    assert.ok(MAX_AUDIT_VARIANCE_ENTRIES >= 1);

    // The applier is the check that counts: a direct persist with the real sign-off ids is
    // refused for the same reason, and its refusal is audited.
    const key = `13-3-direct-unblock-${randomUUID()}`;
    await assert.rejects(
      persistEvent(
        unblockEnvelope({
          key,
          headEventId: headSignoffEventId,
          financeEventId: financeSignoffEventId,
        }),
      ),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'VARIANCE_UNRESOLVED',
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [key]), 0);
    assert.strictEqual(
      await domainEventCount(`event_type = 'migration.golive.unblocked' AND stream_id = $1`, [
        siteAId,
      ]),
      0,
    );

    const rep = await report();
    assert.strictEqual(rep.status, 200, rep.text);
    const signoffs = rep.body['signoffs'] as Record<string, Record<string, unknown> | null>;
    assert.strictEqual(signoffs['department_head_final']!['source_event_id'], headSignoffEventId);
    assert.strictEqual(signoffs['finance_final']!['source_event_id'], financeSignoffEventId);
    const gate = gateOf(rep.body);
    assert.strictEqual(gate.satisfied, false);
    assert.strictEqual(gate.blocking!['error_code'], 'VARIANCE_UNRESOLVED');
    assert.deepEqual(rep.body['golive'], { unblocked: false });
  });

  // -------------------------------------------------------------------------
  // Decision 2: a sign-off goes stale when data lands after it, and is re-attested
  // -------------------------------------------------------------------------

  it('Stale attestation: a newer ERP snapshot makes both sign-offs stale, SIGNOFF_STALE blocks the unblock in the route and the applier, and the report says so', async () => {
    // A fresh ERP snapshot that agrees with the count replaces the comparison wholesale
    // (Story 13.1: latest snapshot per source system), leaving zero variances - and it lands
    // AFTER both attestations, so neither describes the data now on the table.
    await seedSnapshot(new Date().toISOString(), [
      { sku: PLAIN, quantity: '10', unit_cost: '5.000000' },
      { sku: SECOND, quantity: '4', unit_cost: '2.500000' },
    ]);

    const res = await unblock();
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body['error_code'], 'SIGNOFF_STALE');
    const stale = detailsOf(res.body)['stale_signoffs'] as Record<string, unknown>[];
    assert.deepEqual(
      stale.map((s) => [s['signoff_type'], s['source_event_id']]),
      [
        ['department_head_final', headSignoffEventId],
        ['finance_final', financeSignoffEventId],
      ],
    );
    assert.strictEqual(typeof detailsOf(res.body)['latest_snapshot_at'], 'string');

    await assert.rejects(
      persistEvent(
        unblockEnvelope({
          key: `13-3-direct-stale-${randomUUID()}`,
          headEventId: headSignoffEventId,
          financeEventId: financeSignoffEventId,
        }),
      ),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'SIGNOFF_STALE',
    );

    const rep = await report();
    assert.strictEqual(rep.status, 200, rep.text);
    assert.strictEqual(domainOf(rep.body, 'opening_stock')['unexplained_count'], 0);
    const signoffs = rep.body['signoffs'] as Record<string, Record<string, unknown> | null>;
    assert.strictEqual(signoffs['department_head_final']!['stale'], true);
    assert.strictEqual(signoffs['finance_final']!['stale'], true);
    assert.strictEqual(gateOf(rep.body).blocking!['error_code'], 'SIGNOFF_STALE');
  });

  it('Re-attestation: a stale sign-off may be given again (append-only, latest wins), a fresh one still may not, and the old key replays the old row', async () => {
    // The document-domain loads and runs land BEFORE the re-attestation so the fresh sign-offs
    // postdate every import: three domains verified, custody left with an unverified run that
    // carries one quarantined document and one open finding (the report's other two kinds).
    for (const domain of ['active_boms', 'open_pos', 'jobwork_challans']) {
      await fabricateDomainRun(domain, { verified: true });
    }
    const custody = await fabricateDomainRun('custody_registers', {
      verified: false,
      quarantined: 1,
      openFinding: true,
    });

    staleHeadSignoffEventId = headSignoffEventId;
    staleFinanceSignoffEventId = financeSignoffEventId;

    const head = await signOff('department_head_final', headHeaders);
    assert.strictEqual(head.status, 201, head.text);
    assert.notStrictEqual(head.body['event_id'], staleHeadSignoffEventId);
    assert.strictEqual(head.body['stale'], false);
    assert.strictEqual(head.body['superseded_count'], 1);
    headSignoffEventId = head.body['event_id'] as string;

    const fin = await signOff('finance_final', financeHeaders);
    assert.strictEqual(fin.status, 201, fin.text);
    assert.strictEqual(fin.body['superseded_count'], 1);
    financeSignoffEventId = fin.body['event_id'] as string;

    const again = await signOff('department_head_final', headHeaders);
    assert.strictEqual(again.status, 409, again.text);
    assert.strictEqual(detailsOf(again.body)['reason'], 'already_signed_off');
    assert.strictEqual(detailsOf(again.body)['source_event_id'], headSignoffEventId);

    // The first attestation's key still replays ITS row, not the effective one.
    const replay = await signOff('department_head_final', headHeaders, `13-3-head-signoff-${run}`);
    assert.strictEqual(replay.status, 200, replay.text);
    assert.strictEqual(replay.body['replayed'], true);
    assert.strictEqual(replay.body['event_id'], staleHeadSignoffEventId);
    assert.strictEqual(replay.body['source_event_id'], staleHeadSignoffEventId);
    assert.strictEqual(replay.body['stale'], true);

    const rows = await getAdminPool().query(
      `SELECT signoff_type, source_event_id FROM migration_golive_signoff WHERE site_id = $1 ORDER BY occurred_at`,
      [siteAId],
    );
    assert.strictEqual(rows.rows.length, 4);
    assert.strictEqual(
      await domainEventCount(`event_type = 'migration.signoff.recorded' AND stream_id = $1`, [
        siteAId,
      ]),
      4,
    );

    // Next gate: the sign-offs are fresh and the variances are zero, but nothing is promoted.
    const res = await unblock();
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body['error_code'], 'PROMOTION_REQUIRED');
    assert.strictEqual(detailsOf(res.body)['stage'], 'staging');
    assert.strictEqual(custody.runId.length, 36);
  });

  it('Widened gate: promotion then every document domain verified; the report shows the non-blocking kinds; the unblock cites the effective sign-offs only', async () => {
    await fabricatePromotion();
    const res = await unblock();
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body['error_code'], 'DOMAIN_UNVERIFIED');
    assert.deepEqual(detailsOf(res.body)['unverified_domains'], ['custody_registers']);

    const rep = await report();
    assert.strictEqual(rep.status, 200, rep.text);
    assert.strictEqual(domainOf(rep.body, 'opening_stock')['stage'], 'dry_run');
    const custody = domainOf(rep.body, 'custody_registers');
    assert.strictEqual(custody['status'], 'unverified');
    assert.strictEqual(custody['quarantined_count'], 1);
    assert.strictEqual(custody['open_finding_count'], 1);
    assert.deepEqual(
      discrepanciesOf(rep.body).map((d) => [d['domain'], d['kind'], d['blocks_golive']]),
      [
        ['custody_registers', 'domain_unverified', true],
        ['custody_registers', 'quarantined_documents', false],
        ['custody_registers', 'open_findings', false],
      ],
    );
    assert.strictEqual(gateOf(rep.body).blocking!['error_code'], 'DOMAIN_UNVERIFIED');

    const runId = custody['latest_run_id'] as string;
    await markDomainVerified('custody_registers', runId);
    assert.strictEqual(await gateRefusal(), null);

    // The applier refuses an unblock that cites the SUPERSEDED finance attestation.
    const mismatch = `13-3-direct-mismatch-${randomUUID()}`;
    await assert.rejects(
      persistEvent(
        unblockEnvelope({
          key: mismatch,
          headEventId: headSignoffEventId,
          financeEventId: staleFinanceSignoffEventId,
        }),
      ),
      (err: unknown) => {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return (
          e.errorCode === 'INVALID_STATE' && e.details?.['reason'] === 'signoff_event_mismatch'
        );
      },
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [mismatch]), 0);
  });

  // -------------------------------------------------------------------------
  // AC 4: the gate satisfied -> the unblock event, idempotent
  // -------------------------------------------------------------------------

  it('AC4: with the gate satisfied the unblock event is created, and every re-request returns the existing event', async () => {
    const before = await report();
    assert.strictEqual(before.status, 200, before.text);
    assert.strictEqual(gateOf(before.body).satisfied, true);
    assert.strictEqual(gateOf(before.body).blocking, null);
    assert.deepEqual(before.body['golive'], { unblocked: false });
    assert.ok(discrepanciesOf(before.body).every((d) => d['blocks_golive'] === false));

    const key = `13-3-unblock-${run}`;
    const ok = await unblock(key);
    assert.strictEqual(ok.status, 201, ok.text);
    assert.strictEqual(ok.body['unblocked'], true);
    unblockEventId = ok.body['event_id'] as string;
    assert.strictEqual(ok.body['unblocked_event_id'], unblockEventId);
    assert.strictEqual(ok.body['unblocked_by_actor_id'], leadUserId);
    assert.strictEqual(ok.body['department_head_signoff_event_id'], headSignoffEventId);
    assert.strictEqual(ok.body['finance_signoff_event_id'], financeSignoffEventId);
    assert.strictEqual(ok.body['business_date'], TODAY);

    const row = await getAdminPool().query(
      `SELECT unblocked_event_id, department_head_signoff_event_id, finance_signoff_event_id
         FROM migration_golive_status WHERE site_id = $1`,
      [siteAId],
    );
    assert.strictEqual(row.rows.length, 1);
    assert.strictEqual(row.rows[0]!['unblocked_event_id'], unblockEventId);
    assert.strictEqual(row.rows[0]!['department_head_signoff_event_id'], headSignoffEventId);
    assert.strictEqual(row.rows[0]!['finance_signoff_event_id'], financeSignoffEventId);
    const stored = await getAdminPool().query(
      `SELECT payload FROM domain_events WHERE event_id = $1`,
      [unblockEventId],
    );
    const payload = stored.rows[0]!['payload'] as Record<string, unknown>;
    assert.strictEqual(payload['unexplained_variance_count'], 0);
    assert.strictEqual(payload['department_head_signoff_event_id'], headSignoffEventId);

    // Same key and a NEW key both return the existing event: an unblocked site is never
    // re-mutated (Task 4.1).
    const sameKey = await unblock(key);
    assert.strictEqual(sameKey.status, 200, sameKey.text);
    assert.strictEqual(sameKey.body['replayed'], true);
    assert.strictEqual(sameKey.body['event_id'], unblockEventId);
    const newKey = await unblock();
    assert.strictEqual(newKey.status, 200, newKey.text);
    assert.strictEqual(newKey.body['replayed'], true);
    assert.strictEqual(newKey.body['event_id'], unblockEventId);
    assert.strictEqual(
      await domainEventCount(`event_type = 'migration.golive.unblocked' AND stream_id = $1`, [
        siteAId,
      ]),
      1,
    );
    // And the applier refuses a hand-built second unblock outright.
    await assert.rejects(
      persistEvent(
        unblockEnvelope({
          key: `13-3-direct-second-unblock-${randomUUID()}`,
          headEventId: headSignoffEventId,
          financeEventId: financeSignoffEventId,
        }),
      ),
      (err: unknown) => {
        const e = err as { errorCode?: string; details?: Record<string, unknown> };
        return e.errorCode === 'INVALID_STATE' && e.details?.['reason'] === 'already_unblocked';
      },
    );

    const after = await report();
    assert.strictEqual(after.status, 200, after.text);
    const golive = after.body['golive'] as Record<string, unknown>;
    assert.strictEqual(golive['unblocked'], true);
    assert.strictEqual(golive['unblocked_event_id'], unblockEventId);
    assert.strictEqual(gateOf(after.body).satisfied, true);
    assert.deepEqual(
      discrepanciesOf(after.body).map((d) => [d['domain'], d['kind'], d['blocks_golive']]),
      [
        ['custody_registers', 'quarantined_documents', false],
        ['custody_registers', 'open_findings', false],
      ],
    );
  });

  it('AC4 shape: an unblock that cites a sign-off other than the recorded one, or a non-zero count, never reaches the projection', async () => {
    // The shape assert refuses a non-zero count before any DB write.
    const badCount = `13-3-bad-count-${randomUUID()}`;
    await assert.rejects(
      persistEvent({
        ...unblockEnvelope({
          key: badCount,
          headEventId: headSignoffEventId,
          financeEventId: financeSignoffEventId,
        }),
        payload: {
          site_id: siteAId,
          department_head_signoff_event_id: headSignoffEventId,
          finance_signoff_event_id: financeSignoffEventId,
          unexplained_variance_count: 1,
          business_date: TODAY,
        },
      }),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'INVALID_PARAMS',
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [badCount]), 0);
    // A sign-off type outside the vocabulary is refused the same way.
    const badType = `13-3-bad-type-${randomUUID()}`;
    await assert.rejects(
      persistEvent(
        signoffEnvelope({
          key: badType,
          signoffType: 'cfo_final',
          actorId: financeUserId,
          actorRole: 'cfo',
        }),
      ),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'INVALID_PARAMS',
    );
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [badType]), 0);
  });

  // -------------------------------------------------------------------------
  // SEC: read scope, module scope and the event doors
  // -------------------------------------------------------------------------

  it('SEC: a site-B lead cannot read site A, a caller without the migration module is MODULE_ACCESS_DENIED, and both event doors refuse the new events', async () => {
    const otherSite = await report(leadBHeaders);
    assert.strictEqual(otherSite.status, 403, otherSite.text);
    assert.strictEqual(otherSite.body['error_code'], 'LOCATION_ACCESS_DENIED');
    const noModule = await report(gateHeaders);
    assert.strictEqual(noModule.status, 403, noModule.text);
    assert.strictEqual(noModule.body['error_code'], 'MODULE_ACCESS_DENIED');
    const notLead = await unblock(undefined, financeHeaders);
    assert.strictEqual(notLead.status, 403, notLead.text);
    assert.strictEqual(notLead.body['error_code'], 'FUNCTION_ACCESS_DENIED');

    const key = `13-3-door-${randomUUID()}`;
    const envelope = {
      event_id: randomUUID(),
      stream_type: 'migration',
      stream_id: siteBId,
      event_type: 'migration.signoff.recorded',
      payload: {
        site_id: siteBId,
        signoff_type: 'finance_final',
        signed_off_by_actor_id: financeUserId,
        signed_off_role: 'finance_controller',
        business_date: TODAY,
      },
      event_version: 1,
      schema_version: 1,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: financeUserId, role: 'finance_controller', location_id: siteBId },
        device_id: `EDGE-13-3-${RUN}`,
        capture_method: 'MANUAL',
        occurred_at: new Date().toISOString(),
      },
      idempotency_key: key,
    };
    const events = await makeRequest(port, 'POST', '/api/v1/events', envelope, leadBHeaders);
    assert.strictEqual(events.status, 400, events.text);
    assert.strictEqual(events.body['error_code'], 'INVALID_EVENT_STREAM');
    const edge = await makeRequest(port, 'POST', '/api/v1/edge/events', envelope, leadBHeaders);
    assert.strictEqual(edge.status, 403, edge.text);
    assert.strictEqual(edge.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [key]), 0);
    const unblockDoor = await makeRequest(
      port,
      'POST',
      '/api/v1/events',
      {
        ...envelope,
        event_type: 'migration.golive.unblocked',
        idempotency_key: `${key}-unblock`,
        payload: {
          site_id: siteBId,
          department_head_signoff_event_id: randomUUID(),
          finance_signoff_event_id: randomUUID(),
          unexplained_variance_count: 0,
          business_date: TODAY,
        },
      },
      leadBHeaders,
    );
    assert.strictEqual(unblockDoor.status, 400, unblockDoor.text);
    assert.strictEqual(unblockDoor.body['error_code'], 'INVALID_EVENT_STREAM');
    assert.strictEqual(await domainEventCount(`idempotency_key = $1`, [`${key}-unblock`]), 0);
  });
});

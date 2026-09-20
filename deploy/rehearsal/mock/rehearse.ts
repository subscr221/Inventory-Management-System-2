// Mock rehearsal driver (runbook sections 4 to 7, mock pass). Generates a fresh run-scoped pack,
// seeds it, then walks the whole migration flow through the real router as the right distinct
// people and checks every planted defect of expected-outcomes.json against what the platform
// reports. LOCAL only: it starts the app in-process against the .env.test database.
//
//   node --env-file=.env.test --import tsx deploy/rehearsal/mock/rehearse.ts [--lines 300] [--seed 42]
//
// The harness (makeRequest, provisionUser, authFor, approver resolution) is the closure of the
// Story 13.1 to 13.3 integration tests. Exit code 0 only when every defect and step line is PASS.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../../src/server.js';
import { closeAdminPool, closePool, getAdminPool } from '../../../src/config/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const SCIM_HEADERS = { Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN'] ?? ''}` };
const DOA_TYPE = 'migration.variance_explanation';
const DOMAINS = ['active_boms', 'open_pos', 'jobwork_challans', 'custody_registers'] as const;
type Domain = (typeof DOMAINS)[number];
type Json = Record<string, unknown>;
type Headers = Record<string, string>;

interface HttpResult {
  status: number;
  body: Json;
  text: string;
}
interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const TAG = Date.now().toString(36).toUpperCase();
const SITE_CODE = `MOCK-${TAG}`;
const PACK = join(HERE, 'out', SITE_CODE);
const run = TAG.toLowerCase();
let port = 0;

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Headers,
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
          let parsed: Json = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Json;
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

function must(res: HttpResult, status: number, what: string): Json {
  if (res.status !== status)
    throw new Error(`${what}: expected ${status}, got ${res.status} ${res.text.slice(0, 600)}`);
  return res.body;
}

async function provisionUser(externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  return must(res, 201, `provision ${externalId}`)['userId'] as string;
}

async function authFor(sub: string): Promise<Headers> {
  const res = await makeRequest('POST', '/api/v1/auth/dev-token', { sub });
  if (res.status < 200 || res.status >= 300)
    throw new Error(`dev-token ${sub} failed: ${res.text}`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

// ---------------------------------------------------------------- result tables

interface Line {
  label: string;
  expected: string;
  observed: string;
  pass: boolean;
}
const defectLines: Line[] = [];
const stepLines: { name: string; seconds: number; pass: boolean; note: string }[] = [];

function check(label: string, expected: string, observed: string): void {
  defectLines.push({ label, expected, observed, pass: expected === observed });
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  const started = performance.now();
  try {
    const note = (await fn()) ?? '';
    stepLines.push({ name, seconds: (performance.now() - started) / 1000, pass: true, note });
  } catch (error) {
    stepLines.push({
      name,
      seconds: (performance.now() - started) / 1000,
      pass: false,
      note: (error as Error).message,
    });
    throw error;
  }
}

function printTables(): boolean {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '~' : s.padEnd(n));
  console.log(`\nPlanted defects (${SITE_CODE})`);
  console.log(`${pad('result', 7)}${pad('defect', 58)}${pad('expected', 34)}observed`);
  for (const l of defectLines) {
    console.log(
      `${pad(l.pass ? 'PASS' : 'FAIL', 7)}${pad(l.label, 58)}${pad(l.expected, 34)}${l.observed}`,
    );
  }
  console.log('\nFlow steps (wall-clock, feeds runbook Table 3)');
  for (const s of stepLines) {
    console.log(
      `${pad(s.pass ? 'PASS' : 'FAIL', 7)}${pad(s.name, 52)}${s.seconds.toFixed(2).padStart(8)} s  ${s.note}`,
    );
  }
  const failed =
    defectLines.filter((l) => !l.pass).length + stepLines.filter((s) => !s.pass).length;
  const total = stepLines.reduce((sum, s) => sum + s.seconds, 0);
  console.log(
    `\n${failed === 0 ? 'PASS' : 'FAIL'}: ${defectLines.length - defectLines.filter((l) => !l.pass).length}/${defectLines.length} defect checks, ` +
      `${stepLines.filter((s) => s.pass).length}/${stepLines.length} steps, ${total.toFixed(1)} s total`,
  );
  return failed === 0;
}

// ---------------------------------------------------------------- the flow

async function main(): Promise<void> {
  const adminPool = getAdminPool();
  const node = (script: string, args: string[]) =>
    execFileSync(process.execPath, [join(HERE, script), ...args], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });

  let siteId = '';
  let expected: Json = {};
  let world: Json = {};
  const h: Record<string, Headers> = {};
  const userIds: Record<string, string> = {};
  const email = (who: string) => `mock-${who}-${run}@example.com`;
  const person = async (who: string, roles: Role[]) => {
    userIds[who] = await provisionUser(email(who), roles);
    h[who] = await authFor(email(who));
  };

  await step('0 start app, projections', async () => {
    for (const name of [
      'integration_exception',
      'migration_import',
      'migration_import_rejection',
      'migration_opening_stock_row',
      'erp_stock_balance',
      'migration_variance_explanation',
      'migration_stage',
      'migration_document_manifest_row',
      'migration_domain_verification',
      'migration_domain_verification_finding',
      'migration_domain_platform_exclusion',
      'migration_golive_signoff',
      'migration_golive_status',
    ]) {
      await adminPool.query(readFileSync(join(ROOT, 'read/projections', `${name}.sql`), 'utf-8'));
    }
    const server: Server = createAppServer(createAppRouter());
    await new Promise<void>((done) => server.listen(0, () => done()));
    port = (server.address() as AddressInfo).port;
    closers.push(() => new Promise<void>((done) => server.close(() => done())));
  });

  await step('1 generate pack, seed, provision people', async () => {
    node('generate.mjs', [
      '--site-code',
      SITE_CODE,
      '--tag',
      TAG,
      '--lines',
      argOf('--lines', '300'),
      '--seed',
      argOf('--seed', '42'),
    ]);
    expected = JSON.parse(readFileSync(join(PACK, 'expected-outcomes.json'), 'utf8')) as Json;
    world = JSON.parse(readFileSync(join(PACK, 'world.json'), 'utf8')) as Json;
    // The seeder needs an existing actor before the site exists, so the wildcard-scoped ERP
    // service account is provisioned first and owns the seeded receipts.
    await person('erp', [
      { role: 'svc_erp_adapter', module: 'inventory', functionScope: 'write', locationId: '*' },
    ]);
    node('seed.mjs', ['--site-code', SITE_CODE, '--actor-email', email('erp')]);
    const site = await adminPool.query(
      `SELECT location_id FROM location_register WHERE location_code = $1`,
      [SITE_CODE],
    );
    siteId = site.rows[0]!['location_id'] as string;

    const at = (
      module: string,
      scope: 'read' | 'write',
      locationId = siteId,
      role = 'department_head',
    ): Role => ({
      role,
      module,
      functionScope: scope,
      locationId,
    });
    await person('lead', [
      at('migration', 'write', siteId, 'migration_lead'),
      at('migration', 'read', siteId, 'migration_lead'),
    ]);
    await person('engineer', [
      at('engineering', 'write', '*', 'engineering_admin'),
      at('engineering', 'read', '*', 'engineering_admin'),
    ]);
    await person('eng-head', [at('engineering', 'write', '*'), at('migration', 'read', '*')]);
    await person('proc-head', [at('procurement', 'write'), at('migration', 'read')]);
    await person('jw-head', [at('jobwork', 'write'), at('migration', 'read')]);
    await person('dept-head', [at('migration', 'write')]);
    await person('finance', [at('migration', 'write', '*', 'finance_controller')]);
    await person('compliance', [at('compliance', 'write', '*', 'compliance_admin')]);

    // One DOA band for the variance explanations; the transaction type is global, so reuse it.
    const band = await adminPool.query(
      `SELECT entry_id FROM doa_registry_entries WHERE transaction_type = $1 AND active = true`,
      [DOA_TYPE],
    );
    if (band.rows.length === 0) {
      must(
        await makeRequest(
          'POST',
          '/api/v1/doa/entries',
          { role: 'finance_controller', transaction_type: DOA_TYPE, value_min: 0, value_max: null },
          h['compliance'],
        ),
        201,
        'DOA band',
      );
    }
    return `site_id ${siteId}`;
  });

  await step('2 ERP stock-balance snapshot', async () => {
    const body = JSON.parse(readFileSync(join(PACK, 'erp-sync-stock-balances.json'), 'utf8')) as {
      stock_balances: unknown[];
    };
    const res = must(
      await makeRequest('POST', '/api/v1/erp/sync', body, h['erp']),
      200,
      'erp sync',
    );
    const counts = res['stock_balances'] as Record<string, number>;
    if (counts['applied'] !== body.stock_balances.length)
      throw new Error(`erp sync: ${JSON.stringify(counts)}`);
    return `${counts['applied']} balances applied`;
  });

  await step('3 legacy kits (released BOMs)', async () => {
    const kits = world['legacy_kits'] as {
      kit_ref: string;
      parent_sku: string;
      components: { component_sku: string; quantity_per: number; line_uom: string }[];
    }[];
    const ids = await adminPool.query(
      `SELECT sku, item_id FROM item_master WHERE sku = ANY($1::text[])`,
      [kits.flatMap((k) => [k.parent_sku, ...k.components.map((c) => c.component_sku)])],
    );
    const idOf = new Map(ids.rows.map((r) => [r['sku'] as string, r['item_id'] as string]));
    const res = must(
      await makeRequest(
        'POST',
        '/api/v1/boms/legacy-kit-migration',
        {
          kits: kits.map((k) => ({
            kit_ref: k.kit_ref,
            parent_item_id: idOf.get(k.parent_sku),
            components: k.components.map((c) => ({
              component_item_id: idOf.get(c.component_sku),
              quantity_per: String(c.quantity_per),
              line_uom: c.line_uom,
            })),
          })),
        },
        h['engineer'],
      ),
      200,
      'legacy kit migration',
    );
    const migrated = (res['migrated'] as unknown[]).length;
    if (migrated !== kits.length)
      throw new Error(
        `only ${migrated}/${kits.length} kits released: ${JSON.stringify(res).slice(0, 600)}`,
      );
    return `${migrated} kits released`;
  });

  const stock = expected['opening_stock'] as { file_rows: number; planted: Json[] };
  await step('4 import opening_stock.csv, rejections', async () => {
    const imported = must(
      await makeRequest(
        'POST',
        '/api/v1/migration/opening-stock/imports',
        {
          site_id: siteId,
          file_name: 'opening_stock.csv',
          template_version: 'v1',
          mode: 'initial',
          csv: readFileSync(join(PACK, 'opening_stock.csv'), 'utf8'),
          idempotency_key: `mock-import-${run}`,
        },
        h['lead'],
      ),
      201,
      'opening stock import',
    );
    const report = must(
      await makeRequest(
        'GET',
        `/api/v1/migration/opening-stock/imports/${imported['load_id'] as string}?limit=500`,
        undefined,
        h['lead'],
      ),
      200,
      'import report',
    );
    const byLine = new Map(
      (report['rejections'] as Json[]).map((r) => [
        r['line_no'] as number,
        r['error_code'] as string,
      ]),
    );
    const planted = stock.planted.filter((e) => e['rejection_code']);
    for (const e of planted) {
      const line = e['file_line_no'] as number;
      check(
        `stock ${e['defect']} line ${line} rejection`,
        e['rejection_code'] as string,
        byLine.get(line) ?? 'accepted',
      );
      byLine.delete(line);
    }
    check(
      'stock unplanted rejections',
      '0',
      `${byLine.size}${byLine.size ? ' ' + JSON.stringify([...byLine]).slice(0, 80) : ''}`,
    );
    return `${imported['row_count']} rows, ${imported['accepted_count']} accepted, ${imported['rejected_count']} rejected`;
  });

  let varianceKeys: string[] = [];
  await step('5 variance report', async () => {
    const res = must(
      await makeRequest(
        'GET',
        `/api/v1/migration/opening-stock/variances?site_id=${siteId}&limit=500`,
        undefined,
        h['lead'],
      ),
      200,
      'variances',
    );
    const list = res['variances'] as Json[];
    varianceKeys = list.map((v) => v['variance_key'] as string);
    const kindOf = new Map(list.map((v) => [v['variance_key'] as string, v['kind'] as string]));
    for (const e of stock.planted.filter((p) => p['variance_kind'])) {
      const key = `ERP|${e['key'] as string}`;
      check(
        `stock ${e['defect']} ${e['key']} variance`,
        e['variance_kind'] as string,
        kindOf.get(key) ?? 'none',
      );
      kindOf.delete(key);
    }
    check(
      'stock unplanted variances',
      '0',
      `${kindOf.size}${kindOf.size ? ' ' + JSON.stringify([...kindOf]).slice(0, 120) : ''}`,
    );
    return `${list.length} variances`;
  });

  await step('6 explain, self-approval refused, approve', async () => {
    const explained = must(
      await makeRequest(
        'POST',
        '/api/v1/migration/opening-stock/variances/explanations',
        {
          site_id: siteId,
          variance_keys: varianceKeys,
          cause_code: 'count_correction',
          narrative: `Mock rehearsal ${SITE_CODE}: planted defect, explained by the migration lead`,
          idempotency_key: `mock-explain-${run}`,
        },
        h['lead'],
      ),
      201,
      'explain',
    );
    const explanations = explained['explanations'] as Json[];
    // findRoleHolder froze the OLDEST active finance_controller in the whole database as the
    // approver, which need not be this run's finance user: resolve that person and act as them.
    const approverId = explanations[0]!['approver_actor_id'] as string;
    const approver = await adminPool.query(`SELECT external_id FROM users WHERE user_id = $1`, [
      approverId,
    ]);
    const approverExternalId = approver.rows[0]!['external_id'] as string;
    const hasRead = await adminPool.query(
      `SELECT 1 FROM user_role_assignments WHERE user_id = $1 AND module = 'migration' AND location_id = '*'`,
      [approverId],
    );
    if (hasRead.rows.length === 0) {
      await adminPool.query(
        `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
         VALUES ($1, 'finance_controller', 'migration', 'read', '*')`,
        [approverId],
      );
    }
    if (approverId === userIds['lead']) throw new Error('the approver resolved to the explainer');
    const approverHeaders = await authFor(approverExternalId);
    const approve = (id: string, headers: Headers) =>
      makeRequest(
        'POST',
        `/api/v1/migration/opening-stock/variances/explanations/${id}/approve`,
        { idempotency_key: `mock-approve-${randomUUID()}` },
        headers,
      );
    const self = await approve(explanations[0]!['explanation_id'] as string, h['lead']!);
    check(
      'explainer approves own explanation',
      'EXPLAINER_CANNOT_APPROVE',
      String(self.body['error_code'] ?? self.status),
    );
    for (const e of explanations) {
      const res = await approve(e['explanation_id'] as string, approverHeaders);
      if (res.status < 200 || res.status >= 300)
        throw new Error(`approve: ${res.status} ${res.text.slice(0, 400)}`);
    }
    return `${explanations.length} approved by ${approverExternalId}`;
  });

  await step('7 promote opening stock', async () => {
    const res = must(
      await makeRequest(
        'POST',
        '/api/v1/migration/opening-stock/promote',
        { site_id: siteId, idempotency_key: `mock-promote-${run}` },
        h['lead'],
      ),
      200,
      'promote',
    );
    return `${String(res['posted_row_count'])} rows posted, stage ${String(res['stage'])}`;
  });

  const authority: Record<Domain, string> = {
    active_boms: 'eng-head',
    open_pos: 'proc-head',
    jobwork_challans: 'jw-head',
    custody_registers: 'jw-head',
  };
  const prefix = world['document_ref_prefix'] as string;
  for (const domain of DOMAINS) {
    await step(`8 ${domain}: import, verify, waive, sign off`, async () => {
      const imported = must(
        await makeRequest(
          'POST',
          '/api/v1/migration/documents/imports',
          {
            site_id: siteId,
            domain,
            file_name: `${domain}.csv`,
            template_version: 'v1',
            csv: readFileSync(join(PACK, `${domain}.csv`), 'utf8'),
            idempotency_key: `mock-doc-${domain}-${run}`,
          },
          h['lead'],
        ),
        201,
        `${domain} import`,
      );
      check(`${domain} manifest rejections`, '0', String(imported['rejected_count']));
      const scoped = domain === 'active_boms' || domain === 'open_pos';
      const verification = must(
        await makeRequest(
          'POST',
          `/api/v1/migration/domains/${domain}/verification-runs`,
          {
            site_id: siteId,
            idempotency_key: `mock-run-${domain}-${run}`,
            ...(scoped ? { document_ref_prefix: prefix } : {}),
          },
          h['lead'],
        ),
        201,
        `${domain} verification`,
      );
      const runId = verification['run_id'] as string;
      const findings = must(
        await makeRequest(
          'GET',
          `/api/v1/migration/domains/${domain}/verification-runs/${runId}?limit=500`,
          undefined,
          h['lead'],
        ),
        200,
        `${domain} findings`,
      )['findings'] as Json[];
      const left = [...findings];
      // line_ref joins composite identities with U+001F; the pack writes that separator as '|'.
      const show = (f: Json) =>
        `${f['kind']}${f['field'] ? ':' + f['field'] : ''} ${f['document_ref_ext']}/${String(f['line_ref']).replace('', '|')}`;
      for (const e of (expected[domain] as { planted: Json[] }).planted) {
        const want = `${e['finding_kind']}${e['field'] ? ':' + e['field'] : ''} ${e['document_ref_ext']}/${e['line_ref']}`;
        const i = left.findIndex((f) => show(f) === want);
        const near = left.find((f) => f['document_ref_ext'] === e['document_ref_ext']);
        check(`${domain} ${e['defect']}`, want, i >= 0 ? want : near ? show(near) : 'none');
        if (i >= 0) {
          const f = left.splice(i, 1)[0]!;
          if (e['source_value'] !== undefined) {
            check(
              `${domain} ${e['defect']} values`,
              `${Number(e['source_value'])} vs ${Number(e['platform_value'])}`,
              `${Number(f['source_value'])} vs ${Number(f['platform_value'])}`,
            );
          }
        }
      }
      check(
        `${domain} unplanted findings`,
        '0',
        `${left.length}${left.length ? ' ' + left.map(show).join('; ').slice(0, 160) : ''}`,
      );
      const signed = await makeRequest(
        'POST',
        `/api/v1/migration/domains/${domain}/sign-off`,
        {
          site_id: siteId,
          run_id: runId,
          waivers: findings
            .filter((f) => f['kind'] !== 'unknown_reference')
            .map((f) => ({
              finding_id: f['finding_id'] as string,
              narrative: `Mock rehearsal: planted defect (${String(f['kind'])})`,
            })),
          idempotency_key: `mock-signoff-${domain}-${run}`,
        },
        h[authority[domain]],
      );
      must(signed, 201, `${domain} sign-off`);
      return `${findings.length} findings waived, signed by ${authority[domain]}`;
    });
  }

  await step('9 reconciliation, final sign-offs, unblock', async () => {
    const report = () =>
      makeRequest(
        'GET',
        `/api/v1/migration/golive/reconciliation?site_id=${siteId}`,
        undefined,
        h['lead'],
      );
    const before = must(await report(), 200, 'reconciliation report');
    for (const [who, type] of [
      ['dept-head', 'department_head_final'],
      ['finance', 'finance_final'],
    ] as const) {
      must(
        await makeRequest(
          'POST',
          '/api/v1/migration/golive/sign-offs',
          { site_id: siteId, signoff_type: type, idempotency_key: `mock-final-${type}-${run}` },
          h[who],
        ),
        201,
        `${type} sign-off`,
      );
    }
    const gate = must(await report(), 200, 'reconciliation report')['gate'] as Json;
    if (gate['satisfied'] !== true)
      throw new Error(`gate not satisfied: ${JSON.stringify(gate).slice(0, 600)}`);
    const unblocked = must(
      await makeRequest(
        'POST',
        '/api/v1/migration/golive/unblock',
        { site_id: siteId, idempotency_key: `mock-unblock-${run}` },
        h['lead'],
      ),
      201,
      'unblock',
    );
    return `gate before sign-offs: ${JSON.stringify((before['gate'] as Json)['blocking']).slice(0, 60)}; unblocked ${String(unblocked['unblocked'])}`;
  });
}

const closers: (() => Promise<void>)[] = [];
let crashed: unknown = null;
try {
  await main();
} catch (error) {
  crashed = error;
}
const ok = printTables();
if (crashed) console.error(`\nstopped: ${(crashed as Error).message}`);
for (const close of closers) await close();
await closePool();
await closeAdminPool();
process.exit(ok && !crashed ? 0 : 1);

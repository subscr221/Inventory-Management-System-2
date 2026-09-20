// Mock rehearsal driver (runbook sections 4 to 7, mock pass). Generates a fresh run-scoped pack,
// seeds it, then walks the whole migration flow through the real router as the right distinct
// people and checks every planted defect of expected-outcomes.json against what the platform
// reports. LOCAL only: it starts the app in-process against the .env.test database.
//
//   node --env-file=.env.test --import tsx deploy/rehearsal/mock/rehearse.ts [--lines 300] [--seed 42]
//
// The harness (makeRequest, provisionUser, authFor, approver resolution) is the closure of the
// Story 13.1 to 13.3 integration tests. Exit code 0 only when every defect and step line is PASS.
//
// REMOTE mode drives a deployed stack as real, already-provisioned people. It starts no app,
// provisions no user, role or DOA band and seeds nothing: run generate.mjs and seed.mjs for the
// site first, then point at that pack.
//
//   node --import tsx deploy/rehearsal/mock/rehearse.ts --print-required-roles      (no network)
//   node --import tsx deploy/rehearsal/mock/rehearse.ts --remote cfg.json --pack <dir> --dry-run
//   node --import tsx deploy/rehearsal/mock/rehearse.ts --remote cfg.json --pack <dir>
//        [--stop-before-unblock | --through-unblock]
//
// --dry-run fetches a token per actor and makes one authenticated GET each: no write. A remote run
// STOPS BEFORE the final sign-offs and the unblock unless told otherwise, because the go-live
// records are append-only and permanent on a shared database: --stop-before-unblock records the
// two final sign-offs and stops, --through-unblock goes all the way. Idempotency keys derive from
// the site code, so a remote re-run replays what it already wrote instead of duplicating it.
//
// Config (remote.example.json): api_base, token_url (OIDC token endpoint), client_id (a
// password-grant client), optional scope, site_code, site_id, and actors: a map from each logical
// actor (erp, engineer, lead, eng-head, proc-head, jw-head, dept-head, finance) to
// { "email", "password_env" }. Passwords are read from the named environment variables, never
// from the file. Logical actors may share one real person except where the platform forbids it
// (CONFLICTS below); a forbidden pairing fails before any network call.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const hasFlag = (name: string) => process.argv.includes(name);

// ---------------------------------------------------------------- actors and remote config

// What each logical actor holds: [role, module, function scope, location]. 'site' is the
// rehearsal site's location_id, '*' every location. Local mode provisions exactly this for its
// throwaway users; remote mode prints it for comparison with the real accounts.
type Grant = readonly [string, string, 'read' | 'write', 'site' | '*'];
const REQUIRED: Record<string, { steps: string; grants: Grant[]; localOnly?: true }> = {
  erp: {
    steps: '2 ERP stock-balance sync (remote: also item lookups for step 3)',
    grants: [['svc_erp_adapter', 'inventory', 'write', '*']],
  },
  lead: {
    steps: '4 import, 5 variances, 6 explain, 7 promote, 8 manifests + verification, 9 unblock',
    grants: [
      ['migration_lead', 'migration', 'write', 'site'],
      ['migration_lead', 'migration', 'read', 'site'],
    ],
  },
  engineer: {
    steps: '3 legacy kit migration',
    grants: [
      ['engineering_admin', 'engineering', 'write', '*'],
      ['engineering_admin', 'engineering', 'read', '*'],
    ],
  },
  'eng-head': {
    steps: '8 sign off active_boms',
    grants: [
      ['department_head', 'engineering', 'write', '*'],
      ['department_head', 'migration', 'read', '*'],
    ],
  },
  'proc-head': {
    steps: '8 sign off open_pos',
    grants: [
      ['department_head', 'procurement', 'write', 'site'],
      ['department_head', 'migration', 'read', 'site'],
    ],
  },
  'jw-head': {
    steps: '8 sign off jobwork_challans, custody_registers',
    grants: [
      ['department_head', 'jobwork', 'write', 'site'],
      ['department_head', 'migration', 'read', 'site'],
    ],
  },
  'dept-head': {
    steps: '9 department_head_final sign-off',
    grants: [['department_head', 'migration', 'write', 'site']],
  },
  finance: {
    steps: '6 approve variance explanations, 9 finance_final sign-off',
    grants: [['finance_controller', 'migration', 'write', '*']],
  },
  compliance: {
    steps: '1 create the DOA band when none is active (local mode only)',
    grants: [['compliance_admin', 'compliance', 'write', '*']],
    localOnly: true,
  },
};
const REMOTE_ACTORS = Object.keys(REQUIRED).filter((who) => !REQUIRED[who]!.localOnly);

// Pairs the platform refuses as one person, with the refusing check.
const SIGNERS = ['eng-head', 'proc-head', 'jw-head'];
const CONFLICTS: [string, string, string][] = [
  ['lead', 'finance', 'explainer cannot approve (src/api/v1/migration.ts:1083) and SOD-07'],
  ...SIGNERS.map((s): [string, string, string] => [
    'lead',
    s,
    'manifest loader / verification runner cannot sign the domain off, SOD-07 (src/compliance/migration-documents.ts:506,514)',
  ]),
  [
    'lead',
    'dept-head',
    'migration lead, loader, promoter, runner cannot give a final sign-off, SOD-07 (src/compliance/migration-golive.ts:413)',
  ],
  [
    'dept-head',
    'finance',
    'the two final sign-offs must come from two people (src/compliance/migration-golive.ts:430)',
  ],
];

function printRequiredRoles(): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    '\nRequired role assignments per logical actor (site = the rehearsal site location_id)',
  );
  console.log(
    `${pad('actor', 11)}${pad('role', 20)}${pad('module', 13)}${pad('scope', 7)}location`,
  );
  for (const [who, { grants, localOnly }] of Object.entries(REQUIRED)) {
    for (const [role, module, scope, location] of grants) {
      console.log(
        `${pad(who, 11)}${pad(role, 20)}${pad(module, 13)}${pad(scope, 7)}${location}${localOnly ? '   (local mode only)' : ''}`,
      );
    }
  }
  console.log(
    `\nAlso required on the platform: an active DOA band for transaction type ${DOA_TYPE} held by\n` +
      'finance_controller (remote mode does not create one). The approver frozen on each explanation is\n' +
      'the OLDEST active finance_controller in the database, who also needs migration read; the\n' +
      'configured finance actor must be that person. A write assignment satisfies read. Neither final\n' +
      'signer may hold migration_lead reaching the site (src/compliance/migration-golive.ts:389).',
  );
  console.log('\nMust be different people:');
  for (const [a, b, why] of CONFLICTS) console.log(`  ${a} / ${b}: ${why}`);
}

interface RemoteConfig {
  api_base: string;
  token_url: string;
  client_id: string;
  scope?: string;
  site_code: string;
  site_id: string;
  actors: Record<string, { email: string; password_env: string }>;
}

/** Loads and checks the remote config; every failure here happens before any network call. */
function loadRemote(path: string): RemoteConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as RemoteConfig;
  const problems: string[] = [];
  for (const key of ['api_base', 'token_url', 'client_id', 'site_code', 'site_id'] as const) {
    if (typeof cfg[key] !== 'string' || !cfg[key]) problems.push(`${key} is required`);
  }
  for (const who of REMOTE_ACTORS) {
    const actor = cfg.actors?.[who];
    if (!actor?.email || !actor.password_env) {
      problems.push(`actors.${who} needs email and password_env`);
    } else if ('password' in actor) {
      problems.push(`actors.${who}: passwords go in the environment, not the file`);
    } else if (!process.env[actor.password_env]) {
      problems.push(`actors.${who}: environment variable ${actor.password_env} is not set`);
    }
  }
  const emailOf = (who: string) => cfg.actors?.[who]?.email?.toLowerCase();
  for (const [a, b, why] of CONFLICTS) {
    if (emailOf(a) && emailOf(a) === emailOf(b))
      problems.push(`${a} and ${b} are both ${emailOf(a)}: ${why}`);
  }
  if (problems.length > 0)
    throw new Error(`remote config ${path} refused, nothing was sent:\n  ${problems.join('\n  ')}`);
  return cfg;
}

if (hasFlag('--print-required-roles')) {
  printRequiredRoles();
  process.exit(0);
}

const remotePath = argOf('--remote', '');
const remote: RemoteConfig | null = remotePath ? loadRemote(remotePath) : null;
if (!remote && hasFlag('--dry-run')) throw new Error('--dry-run needs --remote <config.json>');
// Where the flow stops: local runs go through the unblock as before; a remote run stops before
// the final sign-offs unless asked, because those records are permanent.
const stopBefore: 'signoffs' | 'unblock' | null = hasFlag('--through-unblock')
  ? null
  : hasFlag('--stop-before-unblock')
    ? 'unblock'
    : remote
      ? 'signoffs'
      : null;

const TAG = Date.now().toString(36).toUpperCase();
const SITE_CODE = remote ? remote.site_code : `MOCK-${TAG}`;
const PACK = resolve(argOf('--pack', join(HERE, 'out', SITE_CODE)));
const run = remote ? remote.site_code.toLowerCase() : TAG.toLowerCase();
let port = 0;

async function remoteRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Headers,
): Promise<HttpResult> {
  const res = await fetch(remote!.api_base.replace(/\/$/, '') + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(600000),
  });
  const raw = await res.text();
  let parsed: Json = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Json;
    } catch {
      parsed = { error_code: 'NON_JSON_BODY', raw };
    }
  }
  return { status: res.status, body: parsed, text: raw };
}

// OIDC password grant, one token per real person, renewed shortly before it expires.
const tokens = new Map<string, { token: string; expiresAt: number }>();
async function remoteAuth(who: string): Promise<Headers> {
  const actor = remote!.actors[who];
  if (!actor) throw new Error(`no remote actor configured for ${who}`);
  const key = actor.email.toLowerCase();
  let hit = tokens.get(key);
  if (!hit || hit.expiresAt - 30000 < Date.now()) {
    const res = await fetch(remote!.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: remote!.client_id,
        username: actor.email,
        password: process.env[actor.password_env] ?? '',
        ...(remote!.scope ? { scope: remote!.scope } : {}),
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || typeof body['access_token'] !== 'string')
      throw new Error(
        `token for ${who} (${actor.email}): ${res.status} ${String(body['error'] ?? '')} ${String(body['error_description'] ?? '')}`,
      );
    hit = {
      token: body['access_token'],
      expiresAt: Date.now() + Number(body['expires_in'] ?? 60) * 1000,
    };
    tokens.set(key, hit);
  }
  return { Authorization: `Bearer ${hit.token}` };
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Headers,
): Promise<HttpResult> {
  if (remote) return remoteRequest(method, path, body, headers);
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

/** A 201, or on a remote re-run the 200 replay of the record the first run already wrote. */
function created(res: HttpResult, what: string): Json {
  if (remote && res.status === 200 && res.body['replayed'] === true) return res.body;
  return must(res, 201, what);
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

/** --dry-run: a token and one harmless authenticated GET per actor, then out. No write. */
async function dryRun(): Promise<boolean> {
  const world = JSON.parse(readFileSync(join(PACK, 'world.json'), 'utf8')) as Json;
  const sku = (world['items'] as { sku: string }[])[0]!.sku;
  const probes: Record<string, string> = {
    erp: `/api/v1/items/${encodeURIComponent(sku)}`,
    engineer: '/api/v1/boms/migration-exceptions?limit=1',
  };
  const pad = (s: string, n: number) => s.padEnd(n);
  let ok = true;
  console.log(`\nDry run against ${remote!.api_base} (site ${SITE_CODE}): no write is made`);
  console.log(`${pad('result', 7)}${pad('actor', 11)}${pad('person', 36)}probe`);
  for (const who of REMOTE_ACTORS) {
    const path = probes[who] ?? `/api/v1/migration/stages?site_id=${remote!.site_id}`;
    let note: string;
    let pass = false;
    try {
      const res = await makeRequest('GET', path, undefined, await remoteAuth(who));
      pass = res.status === 200;
      note = `GET ${path} ${res.status}${pass ? '' : ' ' + String(res.body['error_code'] ?? '') + ' ' + res.text.slice(0, 160)}`;
    } catch (error) {
      note = (error as Error).message;
    }
    ok &&= pass;
    console.log(
      `${pad(pass ? 'PASS' : 'FAIL', 7)}${pad(who, 11)}${pad(remote!.actors[who]!.email, 36)}${note}`,
    );
  }
  console.log(
    `\n${ok ? 'PASS' : 'FAIL'}: a 401 is a token the API does not accept, a 403 a missing role assignment,` +
      ` a 404 on the erp item probe a pack that was not seeded (seed.mjs).`,
  );
  return ok;
}

async function main(): Promise<void> {
  const db = remote ? null : await import('../../../src/config/db.js');
  if (db) closers.push(db.closePool, db.closeAdminPool);
  const adminPool = db?.getAdminPool();
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
  // The request headers of a logical actor: the provisioned throwaway user locally, the mapped
  // real person's bearer token remotely.
  const as = async (who: string): Promise<Headers> => (remote ? remoteAuth(who) : h[who]!);
  const grantsOf = (who: string): Role[] =>
    REQUIRED[who]!.grants.map(([role, module, functionScope, location]) => ({
      role,
      module,
      functionScope,
      locationId: location === 'site' ? siteId : '*',
    }));

  if (remote) {
    await step('0 remote preflight: pack, a token per actor', async () => {
      expected = JSON.parse(readFileSync(join(PACK, 'expected-outcomes.json'), 'utf8')) as Json;
      world = JSON.parse(readFileSync(join(PACK, 'world.json'), 'utf8')) as Json;
      if (world['site_code'] !== SITE_CODE)
        throw new Error(`pack ${PACK} is for ${String(world['site_code'])}, not ${SITE_CODE}`);
      siteId = remote.site_id;
      for (const who of REMOTE_ACTORS) await remoteAuth(who);
      return `${tokens.size} people for ${REMOTE_ACTORS.length} actors, site_id ${siteId}`;
    });
  }

  if (!remote)
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
        await adminPool!.query(
          readFileSync(join(ROOT, 'read/projections', `${name}.sql`), 'utf-8'),
        );
      }
      const { createAppRouter, createAppServer } = await import('../../../src/server.js');
      const server: Server = createAppServer(createAppRouter());
      await new Promise<void>((done) => server.listen(0, () => done()));
      port = (server.address() as AddressInfo).port;
      closers.unshift(() => new Promise<void>((done) => server.close(() => done())));
    });

  if (!remote)
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
      await person('erp', grantsOf('erp'));
      node('seed.mjs', ['--site-code', SITE_CODE, '--actor-email', email('erp')]);
      const site = await adminPool!.query(
        `SELECT location_id FROM location_register WHERE location_code = $1`,
        [SITE_CODE],
      );
      siteId = site.rows[0]!['location_id'] as string;

      for (const who of Object.keys(REQUIRED)) {
        if (who !== 'erp') await person(who, grantsOf(who));
      }

      // One DOA band for the variance explanations; the transaction type is global, so reuse it.
      const band = await adminPool!.query(
        `SELECT entry_id FROM doa_registry_entries WHERE transaction_type = $1 AND active = true`,
        [DOA_TYPE],
      );
      if (band.rows.length === 0) {
        must(
          await makeRequest(
            'POST',
            '/api/v1/doa/entries',
            {
              role: 'finance_controller',
              transaction_type: DOA_TYPE,
              value_min: 0,
              value_max: null,
            },
            await as('compliance'),
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
      await makeRequest('POST', '/api/v1/erp/sync', body, await as('erp')),
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
    const skus = [
      ...new Set(kits.flatMap((k) => [k.parent_sku, ...k.components.map((c) => c.component_sku)])),
    ];
    const idOf = new Map<string, string>();
    if (remote) {
      // No database here: the item ids come from the item API, as the inventory-scoped actor.
      for (const sku of skus) {
        const item = must(
          await makeRequest(
            'GET',
            `/api/v1/items/${encodeURIComponent(sku)}`,
            undefined,
            await as('erp'),
          ),
          200,
          `item ${sku} (was the pack seeded?)`,
        );
        idOf.set(sku, ((item['item'] as Json | undefined) ?? item)['item_id'] as string);
      }
    } else {
      const ids = await adminPool!.query(
        `SELECT sku, item_id FROM item_master WHERE sku = ANY($1::text[])`,
        [skus],
      );
      for (const r of ids.rows) idOf.set(r['sku'] as string, r['item_id'] as string);
    }
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
        await as('engineer'),
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
    const imported = created(
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
        await as('lead'),
      ),
      'opening stock import',
    );
    const report = must(
      await makeRequest(
        'GET',
        `/api/v1/migration/opening-stock/imports/${imported['load_id'] as string}?limit=500`,
        undefined,
        await as('lead'),
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
        await as('lead'),
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
    const explained = created(
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
        await as('lead'),
      ),
      'explain',
    );
    const explanations = explained['explanations'] as Json[];
    // findRoleHolder froze the OLDEST active finance_controller in the whole database as the
    // approver, which need not be this run's finance user: resolve that person and act as them.
    const approverId = explanations[0]!['approver_actor_id'] as string;
    let approverExternalId: string;
    let approverHeaders: Headers;
    if (remote) {
      // No user lookup is exposed by the API, so the configured finance actor is tried and the
      // platform's own refusal (it names both user ids) tells whether that is the frozen approver.
      approverExternalId = remote.actors['finance']!.email;
      approverHeaders = await as('finance');
    } else {
      const approver = await adminPool!.query(`SELECT external_id FROM users WHERE user_id = $1`, [
        approverId,
      ]);
      approverExternalId = approver.rows[0]!['external_id'] as string;
      const hasRead = await adminPool!.query(
        `SELECT 1 FROM user_role_assignments WHERE user_id = $1 AND module = 'migration' AND location_id = '*'`,
        [approverId],
      );
      if (hasRead.rows.length === 0) {
        await adminPool!.query(
          `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
           VALUES ($1, 'finance_controller', 'migration', 'read', '*')`,
          [approverId],
        );
      }
      if (approverId === userIds['lead']) throw new Error('the approver resolved to the explainer');
      approverHeaders = await authFor(approverExternalId);
    }
    // Remote keys are per explanation and actor, so a re-run replays the approval it already made.
    const approve = (id: string, headers: Headers) =>
      makeRequest(
        'POST',
        `/api/v1/migration/opening-stock/variances/explanations/${id}/approve`,
        {
          idempotency_key: remote
            ? `mock-approve-${id}-${headers === approverHeaders ? 'approver' : 'self'}`
            : `mock-approve-${randomUUID()}`,
        },
        headers,
      );
    const self = await approve(explanations[0]!['explanation_id'] as string, await as('lead'));
    check(
      'explainer approves own explanation',
      'EXPLAINER_CANNOT_APPROVE',
      String(self.body['error_code'] ?? self.status),
    );
    for (const e of explanations) {
      const res = await approve(e['explanation_id'] as string, approverHeaders);
      if (remote && res.body['error_code'] === 'APPROVAL_REQUIRED') {
        const details = (res.body['details'] ?? res.body) as Json;
        throw new Error(
          `the configured finance actor ${approverExternalId} (user ${String(details['caller_user_id'])}) is not the approver the platform froze on the explanations (user ${approverId}, the oldest active finance_controller). ` +
            `Map actors.finance to that person and re-run: the explanations stay pending and the re-run replays up to here.`,
        );
      }
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
        await as('lead'),
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
      const imported = created(
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
          await as('lead'),
        ),
        `${domain} import`,
      );
      check(`${domain} manifest rejections`, '0', String(imported['rejected_count']));
      const scoped = domain === 'active_boms' || domain === 'open_pos';
      const verification = created(
        await makeRequest(
          'POST',
          `/api/v1/migration/domains/${domain}/verification-runs`,
          {
            site_id: siteId,
            idempotency_key: `mock-run-${domain}-${run}`,
            ...(scoped ? { document_ref_prefix: prefix } : {}),
          },
          await as('lead'),
        ),
        `${domain} verification`,
      );
      const runId = verification['run_id'] as string;
      const findings = must(
        await makeRequest(
          'GET',
          `/api/v1/migration/domains/${domain}/verification-runs/${runId}?limit=500`,
          undefined,
          await as('lead'),
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
        await as(authority[domain]),
      );
      created(signed, `${domain} sign-off`);
      return `${findings.length} findings waived, signed by ${authority[domain]}`;
    });
  }

  await step('9 reconciliation, final sign-offs, unblock', async () => {
    const report = async () =>
      makeRequest(
        'GET',
        `/api/v1/migration/golive/reconciliation?site_id=${siteId}`,
        undefined,
        await as('lead'),
      );
    const before = must(await report(), 200, 'reconciliation report');
    const blocking = JSON.stringify((before['gate'] as Json)['blocking']).slice(0, 60);
    if (stopBefore === 'signoffs')
      return `gate before sign-offs: ${blocking}; STOPPED before the final sign-offs and the unblock (permanent records): pass --stop-before-unblock or --through-unblock to go further`;
    for (const [who, type] of [
      ['dept-head', 'department_head_final'],
      ['finance', 'finance_final'],
    ] as const) {
      created(
        await makeRequest(
          'POST',
          '/api/v1/migration/golive/sign-offs',
          { site_id: siteId, signoff_type: type, idempotency_key: `mock-final-${type}-${run}` },
          await as(who),
        ),
        `${type} sign-off`,
      );
    }
    const gate = must(await report(), 200, 'reconciliation report')['gate'] as Json;
    if (gate['satisfied'] !== true)
      throw new Error(`gate not satisfied: ${JSON.stringify(gate).slice(0, 600)}`);
    if (stopBefore === 'unblock')
      return `gate before sign-offs: ${blocking}; gate satisfied; STOPPED before unblock (--stop-before-unblock)`;
    const unblocked = created(
      await makeRequest(
        'POST',
        '/api/v1/migration/golive/unblock',
        { site_id: siteId, idempotency_key: `mock-unblock-${run}` },
        await as('lead'),
      ),
      'unblock',
    );
    return `gate before sign-offs: ${blocking}; unblocked ${String(unblocked['unblocked'])}`;
  });
}

const closers: (() => Promise<void>)[] = [];
let crashed: unknown = null;
let ok = true;
try {
  if (remote) {
    printRequiredRoles();
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`
Who performs what on ${remote.api_base} (site ${SITE_CODE}, ${remote.site_id})`);
    for (const who of REMOTE_ACTORS)
      console.log(`${pad(who, 11)}${pad(remote.actors[who]!.email, 36)}${REQUIRED[who]!.steps}`);
    console.log(
      `
This run ${hasFlag('--dry-run') ? 'is a DRY RUN: tokens and one GET per actor, no write' : stopBefore === 'signoffs' ? 'STOPS BEFORE the final sign-offs and the unblock' : stopBefore === 'unblock' ? 'records the final sign-offs and STOPS BEFORE the unblock' : 'goes THROUGH the unblock'}.`,
    );
  }
  if (remote && hasFlag('--dry-run')) ok = await dryRun();
  else await main();
} catch (error) {
  crashed = error;
}
if (!(remote && hasFlag('--dry-run'))) ok = printTables();
if (crashed) console.error(`\nstopped: ${(crashed as Error).message}`);
for (const close of closers) await close();
process.exit(ok && !crashed ? 0 : 1);

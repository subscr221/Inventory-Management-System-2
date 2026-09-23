// Shared harness of setup-operations.ts and operations-smoke.ts: arguments, the remote config,
// one request function for both modes, people, and the PASS/FAIL table. Same conventions as
// rehearse.ts, which stays self-contained.
//
// LOCAL mode starts the app in-process against the .env.test database (override DB_PORT for your
// own container) and provisions the people of the pack's roles.json as throwaway users through
// SCIM. REMOTE mode (--remote cfg.json --pack <dir>) drives a deployed stack as the real people:
// it provisions nobody, so apply roles.json with src/cli/provision-roles.ts first.
//
// Remote config: the shape of remote.example.json (api_base, token_url, client_id, scope,
// site_code, site_id). "actors" is OPTIONAL here: a logical actor that is not listed is the person
// world.json operations.actors names, with the password read from the environment variable named
// by "default_password_env". Passwords never go in the file.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../../..');
export type Json = Record<string, unknown>;
export type Headers = Record<string, string>;

export interface HttpResult {
  status: number;
  body: Json;
  text: string;
}

export function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
export const hasFlag = (name: string) => process.argv.includes(name);

interface RemoteConfig {
  api_base: string;
  token_url: string;
  client_id: string;
  scope?: string;
  site_code: string;
  site_id: string;
  default_password_env?: string;
  actors?: Record<string, { email: string; password_env: string }>;
}

interface RolesFile {
  people: Record<string, { display_name?: string }>;
  roles: {
    role: string;
    module: string;
    function_scope: 'read' | 'write';
    location_id: string;
    holder: string;
  }[];
}

export interface Ctx {
  remote: boolean;
  siteCode: string;
  siteId: string;
  pack: string;
  /** Unique per local run, stable per site remotely: remote re-runs replay instead of duplicating. */
  run: string;
  world: Json;
  ops: Json;
  request(method: string, path: string, body?: unknown, headers?: Headers): Promise<HttpResult>;
  /** Request headers of a logical actor (world.json operations.actors). */
  as(who: string): Promise<Headers>;
  emailOf(who: string): string;
  /**
   * Headers of the person the platform froze as approver. Remotely that must be the configured
   * actor. Locally findRoleHolder picks the OLDEST holder in the whole database, who may be a user
   * of an earlier run: that user is granted the module at this site and impersonated.
   */
  asApprover(
    approverUserId: string | null,
    who: string,
    grant: { role: string; module: string },
  ): Promise<Headers>;
  /** Local mode only: direct reads for checks the API cannot answer. */
  sql: ((text: string, params?: unknown[]) => Promise<Json[]>) | null;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- result table

export interface Line {
  name: string;
  result: 'PASS' | 'FAIL' | 'SKIP';
  seconds: number;
  note: string;
}
const lines: Line[] = [];

/** Runs one step; a failure is recorded and returns false, so the caller can skip what depends on it. */
export async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const started = performance.now();
  try {
    const note = (await fn()) ?? '';
    lines.push({ name, result: 'PASS', seconds: (performance.now() - started) / 1000, note });
    return true;
  } catch (error) {
    lines.push({
      name,
      result: 'FAIL',
      seconds: (performance.now() - started) / 1000,
      note: (error as Error).message,
    });
    return false;
  }
}
export function skip(name: string, why: string): void {
  lines.push({ name, result: 'SKIP', seconds: 0, note: why });
}

/** A chain of steps: after the first failure the rest are SKIP. */
export async function flow(steps: [string, () => Promise<string | void>][]): Promise<void> {
  let failed = '';
  for (const [name, fn] of steps) {
    if (failed) skip(name, `needs "${failed}"`);
    else if (!(await step(name, fn))) failed = name;
  }
}

/** A copy of every recorded line, for drivers that write a machine-readable report. */
export const results = (): Line[] => lines.map((l) => ({ ...l }));

export function printTable(title: string): boolean {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '~' : s.padEnd(n));
  console.log(`\n${title}`);
  for (const l of lines)
    console.log(
      `${pad(l.result, 6)}${pad(l.name, 58)}${l.seconds.toFixed(2).padStart(7)} s  ${l.note.slice(0, 400)}`,
    );
  const bad = lines.filter((l) => l.result !== 'PASS').length;
  console.log(
    `\n${bad === 0 ? 'PASS' : 'FAIL'}: ${lines.length - bad}/${lines.length} steps passed` +
      (bad
        ? `, ${lines.filter((l) => l.result === 'FAIL').length} failed, ${lines.filter((l) => l.result === 'SKIP').length} skipped`
        : ''),
  );
  return bad === 0;
}

export function must(res: HttpResult, statuses: number | number[], what: string): Json {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(res.status))
    throw new Error(
      `${what}: expected ${allowed.join('/')}, got ${res.status} ${res.text.slice(0, 500)}`,
    );
  return res.body;
}

/** The first array found under any of the keys (list routes differ in their envelope key). */
export function listOf(body: Json, ...keys: string[]): Json[] {
  for (const key of [...keys, 'items', 'data', 'rows']) {
    if (Array.isArray(body[key])) return body[key] as Json[];
  }
  return [];
}

// ---------------------------------------------------------------- boot

function localRequest(port: number) {
  return (method: string, path: string, body?: unknown, headers?: Headers): Promise<HttpResult> =>
    new Promise((resolvePromise, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
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
          res.on('end', () =>
            resolvePromise(parse(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf-8'))),
          );
        },
      );
      req.on('error', reject);
      req.setTimeout(600000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
      if (data) req.write(data);
      req.end();
    });
}

function parse(status: number, raw: string): HttpResult {
  let body: Json = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      body = Array.isArray(parsed) ? { items: parsed } : (parsed as Json);
    } catch {
      body = { error_code: 'NON_JSON_BODY', raw };
    }
  }
  return { status, body, text: raw };
}

/** Boots either mode. Local: siteCode and pack name a site that rehearse.ts already took live. */
export async function boot(local: { siteCode: string; pack: string } | null): Promise<Ctx> {
  const remotePath = argOf('--remote', '');
  if (remotePath) return bootRemote(remotePath);
  if (!local)
    throw new Error(
      'local mode needs --site-code <code> (a site rehearse.ts took through the unblock)',
    );

  const world = JSON.parse(readFileSync(join(local.pack, 'world.json'), 'utf8')) as Json;
  const roles = JSON.parse(readFileSync(join(local.pack, 'roles.json'), 'utf8')) as RolesFile;
  const db = await import('../../../src/config/db.js');
  const adminPool = db.getAdminPool();
  const { createAppRouter, createAppServer } = await import('../../../src/server.js');
  const server: Server = createAppServer(createAppRouter());
  await new Promise<void>((done) => server.listen(0, () => done()));
  const request = localRequest((server.address() as AddressInfo).port);
  const site = await adminPool.query(
    `SELECT location_id FROM location_register WHERE location_code = $1 AND level = 'site'`,
    [local.siteCode],
  );
  if (site.rows.length === 0) throw new Error(`no site ${local.siteCode} in this database`);
  const siteId = site.rows[0]!['location_id'] as string;
  const run = local.siteCode.toLowerCase();

  const devToken = async (sub: string): Promise<Headers> => {
    const res = await request('POST', '/api/v1/auth/dev-token', { sub });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`dev-token ${sub} failed: ${res.text}`);
    return { Authorization: `Bearer ${res.body['token'] as string}` };
  };
  // The people of roles.json as throwaway users; a re-run on the same site reuses them.
  const scim = { Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN'] ?? ''}` };
  const localEmail = (email: string) => `ops-${email.split('@')[0]}-${run}@example.com`;
  const headersOf = new Map<string, Headers>();
  const userIdOf = new Map<string, string>();
  for (const email of Object.keys(roles.people)) {
    const externalId = localEmail(email);
    const existing = await adminPool.query(`SELECT user_id FROM users WHERE external_id = $1`, [
      externalId,
    ]);
    if (existing.rows.length === 0) {
      const res = await request(
        'POST',
        '/api/v1/scim/v2/Users',
        {
          externalId,
          email: externalId,
          displayName: roles.people[email]!.display_name ?? externalId,
          roles: roles.roles
            .filter((r) => r.holder === email)
            .map((r) => ({
              role: r.role,
              module: r.module,
              functionScope: r.function_scope,
              locationId: r.location_id === 'site' ? siteId : r.location_id,
            })),
        },
        scim,
      );
      userIdOf.set(email, must(res, 201, `provision ${externalId}`)['userId'] as string);
    } else userIdOf.set(email, existing.rows[0]!['user_id'] as string);
    headersOf.set(email, await devToken(externalId));
  }

  const ops = world['operations'] as Json;
  const actors = ops['actors'] as Record<string, string>;
  const person = (who: string) => {
    const email = actors[who];
    if (!email || !headersOf.has(email)) throw new Error(`no person for logical actor ${who}`);
    return email;
  };
  return {
    remote: false,
    siteCode: local.siteCode,
    siteId,
    pack: local.pack,
    run: `${run}-${Date.now().toString(36)}`,
    world,
    ops,
    request,
    as: async (who) => headersOf.get(person(who))!,
    emailOf: (who) => localEmail(person(who)),
    asApprover: async (approverUserId, who, grant) => {
      if (!approverUserId || approverUserId === userIdOf.get(person(who)))
        return headersOf.get(person(who))!;
      const user = await adminPool.query(`SELECT external_id FROM users WHERE user_id = $1`, [
        approverUserId,
      ]);
      if (user.rows.length === 0)
        throw new Error(`frozen approver ${approverUserId} is not a user`);
      for (const scope of ['read', 'write']) {
        await adminPool.query(
          `INSERT INTO user_role_assignments (user_id, role, module, function_scope, location_id)
           SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM user_role_assignments
             WHERE user_id = $1 AND role = $2 AND module = $3 AND function_scope = $4 AND location_id = $5)`,
          [approverUserId, grant.role, grant.module, scope, siteId],
        );
      }
      return devToken(user.rows[0]!['external_id'] as string);
    },
    sql: async (text, params) => (await adminPool.query(text, params)).rows as Json[],
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      await db.closePool();
      await db.closeAdminPool();
    },
  };
}

function bootRemote(path: string): Ctx {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as RemoteConfig;
  const problems: string[] = [];
  for (const key of ['api_base', 'token_url', 'client_id', 'site_code', 'site_id'] as const) {
    if (typeof cfg[key] !== 'string' || !cfg[key]) problems.push(`${key} is required`);
  }
  const pack = resolve(argOf('--pack', join(HERE, 'out', cfg.site_code ?? '')));
  const world = JSON.parse(readFileSync(join(pack, 'world.json'), 'utf8')) as Json;
  if (world['site_code'] !== cfg.site_code)
    problems.push(`pack ${pack} is for ${String(world['site_code'])}, not ${cfg.site_code}`);
  const ops = (world['operations'] ?? {}) as Json;
  const packActors = (ops['actors'] ?? {}) as Record<string, string>;
  const actorOf = (who: string) => {
    const explicit = cfg.actors?.[who];
    if (explicit) return explicit;
    return { email: packActors[who] ?? '', password_env: cfg.default_password_env ?? '' };
  };
  for (const who of Object.keys(packActors)) {
    const a = actorOf(who);
    if (!a.email || !a.password_env)
      problems.push(`actor ${who} needs an email and a password_env (or default_password_env)`);
    else if (!process.env[a.password_env])
      problems.push(`actor ${who}: environment variable ${a.password_env} is not set`);
  }
  if (problems.length > 0)
    throw new Error(`remote config ${path} refused, nothing was sent:\n  ${problems.join('\n  ')}`);

  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const auth = async (who: string): Promise<Headers> => {
    const actor = actorOf(who);
    if (!actor.email) throw new Error(`no person for logical actor ${who}`);
    const key = actor.email.toLowerCase();
    let hit = tokens.get(key);
    if (!hit || hit.expiresAt - 30000 < Date.now()) {
      const res = await fetch(cfg.token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: cfg.client_id,
          username: actor.email,
          password: process.env[actor.password_env] ?? '',
          ...(cfg.scope ? { scope: cfg.scope } : {}),
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
  };
  return {
    remote: true,
    siteCode: cfg.site_code,
    siteId: cfg.site_id,
    pack,
    run: `${cfg.site_code.toLowerCase()}-${Date.now().toString(36)}`,
    world,
    ops,
    request: async (method, urlPath, body, headers) => {
      const res = await fetch(cfg.api_base.replace(/\/$/, '') + urlPath, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(600000),
      });
      return parse(res.status, await res.text());
    },
    as: auth,
    emailOf: (who) => actorOf(who).email,
    // No user lookup is exposed by the API: the configured person is tried and the platform's own
    // refusal tells when the frozen approver is somebody else.
    asApprover: (_approverUserId, who) => auth(who),
    sql: null,
    close: async () => {},
  };
}

/**
 * Sends an approval as the configured approver. When the platform answers that it froze another
 * person (it names that user id in details), local mode retries as that person; remote mode
 * fails with the platform's own message, which says who must be mapped to the actor.
 */
export async function approveAs(
  ctx: Ctx,
  who: string,
  grant: { role: string; module: string },
  send: (headers: Headers) => Promise<HttpResult>,
  knownApproverId: string | null = null,
): Promise<HttpResult> {
  const first = await send(await ctx.asApprover(knownApproverId, who, grant));
  const details = (first.body['details'] ?? {}) as Json;
  const frozen = (details['resolved_approver_user_id'] ??
    details['approver_actor_id'] ??
    details['approver_user_id']) as string | undefined;
  if (first.status !== 403 || !frozen || ctx.remote) return first;
  return send(await ctx.asApprover(frozen, who, grant));
}

export const uuid = randomUUID;
export const packJson = (ctx: Ctx, name: string): Json =>
  JSON.parse(readFileSync(join(ctx.pack, name), 'utf8')) as Json;

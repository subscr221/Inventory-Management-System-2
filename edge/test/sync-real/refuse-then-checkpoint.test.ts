import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PowerSyncDatabase } from '@powersync/node';
import { EdgeSchema } from '../../src/local-db/schema';
import { EdgePowerSyncConnector } from '../../src/sync/connector';
import { insertCaptureEvent, resetAuthRequired, retainOutboxRow } from '../../src/local-db/outbox';
import { createTestCaptureEvent } from '../../src/capture/test-capture';
import { EdgeSession, setActiveSession, type SessionManager } from '../../src/session/session';

// Story 1.13 (AC 5): a REAL PowerSync service applies real checkpoints. Mocked connector tests
// cannot show that a checkpoint deletes an edge_outbox row whose upload-queue entry completed
// (Story 1.8 note); this does. Needs deploy/compose/docker-compose.sync-test.yml running and
// .env.test loaded (npm run edge:test:sync-real). The central API runs as a child process.

const ROOT = resolve(import.meta.dirname, '../../..');
const API_PORT = 3997;
const API = `http://127.0.0.1:${API_PORT}`;
const run = randomUUID().slice(0, 8);
const SITE = randomUUID();

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  assert.ok(res.ok, `${path} ${res.status} ${JSON.stringify(json)}`);
  return json;
}

interface TestUser {
  id: string;
  token: string;
}

async function provision(name: string, module: string, locationId: string): Promise<TestUser> {
  const externalId = `${name}-sync-real-${run}@example.com`;
  const role = `${name}_${run}`;
  const created = await post(
    '/api/v1/scim/v2/Users',
    {
      externalId,
      email: externalId,
      displayName: externalId,
      roles: [
        { role, module, functionScope: 'write', locationId },
        { role, module, functionScope: 'read', locationId },
      ],
    },
    { Authorization: `Bearer ${process.env['SCIM_BEARER_TOKEN']}` },
  );
  const token = await post('/api/v1/auth/dev-token', { sub: externalId });
  return { id: created['userId'] as string, token: token['token'] as string };
}

function signIn(user: TestUser): void {
  const manager: SessionManager = {
    getUser: async () => ({ access_token: user.token }),
    signinRedirect: async () => undefined,
    signinCallback: async () => undefined,
    signinSilent: async () => null,
    signoutRedirect: async () => undefined,
    removeUser: async () => undefined,
    events: { addUserSignedOut: () => undefined },
  };
  setActiveSession(
    new EdgeSession({ config: { mode: 'oidc', authority: 'https://unused/realms/ims', clientId: 'ims-app' }, manager }),
  );
}

const opened: PowerSyncDatabase[] = [];

function openDatabase(file: string): PowerSyncDatabase {
  const db = new PowerSyncDatabase({
    schema: EdgeSchema,
    // better-sqlite3, the SDK's default driver. The node:sqlite driver cannot read the INT64
    // sentinel the sync bookkeeping writes ("Value is too large to be represented as a JavaScript
    // number: 9223372036854775807" in updateLocalTarget), so no write checkpoint ever completes.
    database: { dbFilename: file, dbLocation: dir },
  });
  opened.push(db);
  return db;
}

const dir = mkdtempSync(join(tmpdir(), 'ims-sync-real-'));

describe('Story 1.13 refuse-then-checkpoint against a real PowerSync service', () => {
  let api: ChildProcess;
  let pool: pg.Pool;
  let refusedUser: TestUser; // holds no maintenance role: every test capture is refused
  let holder: TestUser; // holds maintenance at the site
  let supervisor: TestUser;

  async function inDomainEvents(eventId: string): Promise<boolean> {
    const r = await pool.query(`SELECT 1 FROM domain_events WHERE event_id = $1`, [eventId]);
    return r.rows.length === 1;
  }

  /**
   * Waits for the checkpoint that follows a completed upload queue entry: PowerSync rebuilds every
   * synced table from the server's buckets, and no bucket carries edge_outbox, so the row is
   * deleted locally. That deletion IS the checkpoint (currentStatus.lastSyncedAt has one-second
   * resolution and does not advance on a checkpoint that carries no data), and it is what makes
   * retention necessary.
   */
  async function checkpointRemoves(db: PowerSyncDatabase, eventId: string): Promise<true> {
    return waitFor(`the checkpoint to remove edge_outbox ${eventId}`, async () => {
      const queue = await db.getUploadQueueStats();
      const rows = await db.getAll(`SELECT id FROM edge_outbox WHERE id = ?`, [eventId]);
      return queue.count === 0 && rows.length === 0;
    });
  }

  function capture(user: TestUser) {
    return createTestCaptureEvent({ userId: user.id, role: 'device', siteId: SITE, deviceId: `SYNC-REAL-${run}` });
  }

  before(async () => {
    api = spawn(process.execPath, ['--env-file=.env.test', '--import', 'tsx', 'src/server.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DB_PORT: '5452',
        PORT: String(API_PORT),
        HOSTNAME: '127.0.0.1',
        POWERSYNC_URL: 'http://127.0.0.1:8090',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitFor('the API', async () => (await fetch(`${API}/api/v1/auth/dev-token`, { method: 'POST', body: '{}' })).status > 0);
    pool = new pg.Pool({
      host: '127.0.0.1',
      port: 5452,
      database: 'inventory_events',
      user: 'admin_user',
      password: process.env['DB_ADMIN_PASSWORD'],
    });
    refusedUser = await provision('refused', 'gate', SITE);
    holder = await provision('holder', 'maintenance', SITE);
    supervisor = await provision('supervisor', 'maintenance', '*');
  });

  after(async () => {
    setActiveSession(null);
    for (const db of opened) await db.close().catch(() => undefined);
    await pool?.end();
    api?.kill();
  });

  it('a refused capture survives the checkpoint, a restart, and reaches the central queue', async () => {
    const db = openDatabase('refused.db');
    signIn(refusedUser);
    const event = capture(refusedUser);
    await insertCaptureEvent(db, event);
    await db.connect(new EdgePowerSyncConnector(API, () => refusedUser.id));

    await waitFor('the retained refusal', async () =>
      (await db.getAll(`SELECT id FROM edge_outbox_retained WHERE id = ?`, [event.event_id])).length === 1,
    );
    await checkpointRemoves(db, event.event_id);
    const [retained] = await db.getAll<Record<string, unknown>>(
      `SELECT retained_reason, server_error_code FROM edge_outbox_retained WHERE id = ?`,
      [event.event_id],
    );
    assert.deepEqual(retained, { retained_reason: 'refused', server_error_code: 'MODULE_ACCESS_DENIED' });

    await db.disconnect();
    await db.close();
    const reopened = openDatabase('refused.db');
    assert.equal((await reopened.getAll(`SELECT id FROM edge_outbox_retained WHERE id = ?`, [event.event_id])).length, 1);
    await reopened.close();

    const list = await fetch(`${API}/api/v1/edge/refused-captures?limit=500`, {
      headers: { Authorization: `Bearer ${supervisor.token}` },
    });
    const body = (await list.json()) as { refusals: Array<Record<string, unknown>> };
    assert.ok(body.refusals.some((r) => r['event_id'] === event.event_id), JSON.stringify(body));
  });

  // Task 3.4 is implemented as ONE watch over both tables (a UNION ALL) rather than two watches.
  // AC1's "Needs attention" count refreshes only through it, so pin that a local-only write fires it.
  it('the single UNION watch fires for edge_outbox AND for the local-only retention table', async () => {
    const db = openDatabase('watch.db');
    let fires = 0;
    const abort = new AbortController();
    db.watch(
      `SELECT id, local_status, server_error_code, updated_at FROM edge_outbox
       UNION ALL
       SELECT id, retained_reason, server_error_code, retained_at FROM edge_outbox_retained`,
      [],
      { onResult: () => { fires += 1; } },
      { signal: abort.signal },
    );
    const settled = async (): Promise<void> => new Promise((r) => setTimeout(r, 400));
    await settled();
    const baseline = fires;
    const event = capture(holder);
    await insertCaptureEvent(db, event);
    await settled();
    const afterOutbox = fires;
    assert.ok(afterOutbox > baseline, 'an edge_outbox insert fires the watch');

    await db.writeTransaction((tx) => retainOutboxRow(tx, event.event_id, 'refused'));
    await settled();
    assert.ok(fires > afterOutbox, 'a local-only edge_outbox_retained write fires the same watch');
    abort.abort();
    await db.close();
  });

  it('an accepted capture reaches domain_events and is not retained', async () => {
    const db = openDatabase('accepted.db');
    signIn(holder);
    const event = capture(holder);
    await insertCaptureEvent(db, event);
    await db.connect(new EdgePowerSyncConnector(API, () => holder.id));
    await waitFor('the accepted event', () => inDomainEvents(event.event_id));
    await checkpointRemoves(db, event.event_id);
    assert.deepEqual(await db.getAll(`SELECT id FROM edge_outbox_retained`), []);
    await db.disconnect();
    await db.close();
  });

  it('a capture parked for its owner survives the checkpoint and uploads when the owner signs in', async () => {
    const db = openDatabase('parked.db');
    const event = capture(holder);
    await insertCaptureEvent(db, event);

    signIn(refusedUser);
    await db.connect(new EdgePowerSyncConnector(API, () => refusedUser.id));
    await waitFor('the parked row', async () =>
      (await db.getAll(`SELECT id FROM edge_outbox_retained WHERE retained_reason = 'parked_for_owner'`)).length === 1,
    );
    await checkpointRemoves(db, event.event_id);
    assert.equal(await inDomainEvents(event.event_id), false, 'nothing uploaded under the wrong session');
    await db.disconnect();

    signIn(holder);
    await resetAuthRequired(db, holder.id);
    await db.connect(new EdgePowerSyncConnector(API, () => holder.id));
    await waitFor('the owner upload', () => inDomainEvents(event.event_id));
    assert.deepEqual(await db.getAll(`SELECT id FROM edge_outbox_retained`), []);
    await db.disconnect();
    await db.close();
  });
});

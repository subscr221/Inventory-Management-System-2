import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheContext,
  clearCachedUserContext,
  countUnsettled,
  dismissRetainedRow,
  hasAuthRequired,
  hasUpstreamStreamConflict,
  insertCaptureEvent,
  outboxRowOwner,
  readCachedContext,
  readFailures,
  readOutboxCounts,
  readWaitingForOtherOwners,
  resetAuthRequired,
  retainOutboxRow,
  salvageUnheldOutboxRows,
  type QueryExecutor,
} from '../../src/local-db/outbox';
import {
  applyWorklistSnapshot,
  nextStreamVersion,
  readClosureCatalogue,
  type WorklistSnapshot,
} from '../../src/local-db/worklist';
import { createTestCaptureEvent } from '../../src/capture/test-capture';
import { SqliteDb } from './sqlite-db';

/** Story 1.12: outbox metadata naming the capturing user, as the capture builders stamp it. */
function ownedBy(userId: string): string {
  return JSON.stringify({ actor: { user_id: userId, role: 'r', location_id: 's1' } });
}

function statusById(db: SqliteDb, table = 'edge_outbox'): Record<string, unknown> {
  return Object.fromEntries(db.rows(table).map((row) => [row['id'], row['local_status']]));
}

describe('edge outbox local data', () => {
  it('inserts a capture event and reports pending counts', async () => {
    const db = new SqliteDb();
    await insertCaptureEvent(
      db,
      createTestCaptureEvent({
        userId: 'u1',
        role: 'gate_officer',
        siteId: 's1',
        deviceId: 'd1',
        occurredAt: '2026-07-20T03:30:00.000Z',
      }),
    );
    assert.deepEqual(await readOutboxCounts(db), { pendingCount: 1, failedCount: 0 });
    assert.equal(await hasAuthRequired(db), false);
  });

  it('separates failures and auth-required from pending counts', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'a', local_status: 'needs_attention', server_error_code: 'UNTAGGED_TRANSACTION' });
    db.seed({ id: 'b', local_status: 'auth_required' });
    db.seed({ id: 'c', local_status: 'pending_sync' });
    await retainOutboxRow(db, 'a', 'refused');
    assert.deepEqual(await readOutboxCounts(db), { pendingCount: 1, failedCount: 1 });
    assert.equal(await hasAuthRequired(db), true);
    assert.equal((await readFailures(db)).length, 1);
  });

  it('caches and restores user and site context', async () => {
    const db = new SqliteDb();
    await cacheContext(
      db,
      { userId: 'u1', userName: 'Officer', role: 'gate_officer' },
      { siteId: 's1', siteName: 'Pilot Site' },
    );
    const restored = await readCachedContext(db);
    assert.equal(restored?.user.userName, 'Officer');
    assert.equal(restored?.site.siteName, 'Pilot Site');
  });

  // Story 1.12: sign-in and shared-tablet sign-out helpers.
  it('counts only the signed-in user\'s rows that would still upload as unsettled', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'a', local_status: 'needs_attention', server_error_code: 'STREAM_CONFLICT', metadata: ownedBy('u1') });
    db.seed({ id: 'b', local_status: 'auth_required', metadata: ownedBy('u1') });
    db.seed({ id: 'c', local_status: 'pending_sync', metadata: ownedBy('u1') });
    db.seed({ id: 'd', local_status: 'synced', metadata: ownedBy('u1') });
    db.seed({ id: 'e', local_status: 'auth_required', metadata: ownedBy('u2') });
    assert.equal(await countUnsettled(db, 'u1'), 2);
    assert.equal(await countUnsettled(db, 'u2'), 1);
  });

  it('re-queues only the signing-in owner\'s auth_required rows and leaves every other row alone', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'a', local_status: 'needs_attention', server_error_code: 'UNTAGGED_TRANSACTION', metadata: ownedBy('u1') });
    db.seed({ id: 'b', local_status: 'auth_required', metadata: ownedBy('u1') });
    db.seed({ id: 'c', local_status: 'synced', metadata: ownedBy('u1') });
    db.seed({ id: 'd', local_status: 'auth_required', metadata: ownedBy('u2') });
    await resetAuthRequired(db, 'u1');
    assert.deepEqual(statusById(db), { a: 'needs_attention', b: 'pending_sync', c: 'synced', d: 'auth_required' });
    assert.equal(db.transactions, 1, 'one delete-and-reinsert transaction per re-queued row');
    assert.equal(db.rows('edge_outbox').find((row) => row['id'] === 'b')?.['metadata'], ownedBy('u1'));
    assert.equal(await hasAuthRequired(db, 'u1'), false);
    assert.equal(await hasAuthRequired(db, 'u2'), true);
  });

  it('groups unsettled captures waiting for other people by owner', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'a', local_status: 'auth_required', metadata: ownedBy('u2') });
    db.seed({ id: 'b', local_status: 'auth_required', metadata: ownedBy('u2') });
    db.seed({ id: 'c', local_status: 'pending_sync', metadata: ownedBy('u1') });
    db.seed({ id: 'd', local_status: 'synced', metadata: ownedBy('u3') });
    assert.deepEqual(await readWaitingForOtherOwners(db, 'u1'), [{ userId: 'u2', count: 2 }]);
  });

  it('reads the owner from outbox metadata and tolerates anything malformed', () => {
    assert.equal(outboxRowOwner(ownedBy('u1')), 'u1');
    assert.equal(outboxRowOwner('{not json'), null);
    assert.equal(outboxRowOwner(JSON.stringify({ actor: {} })), null);
    assert.equal(outboxRowOwner(undefined), null);
  });

  it('clears the cached user on sign-out but keeps the site context', async () => {
    const db = new SqliteDb();
    await cacheContext(
      db,
      { userId: 'u1', userName: 'Officer', role: 'gate_officer' },
      { siteId: 's1', siteName: 'Pilot Site' },
    );
    await clearCachedUserContext(db);
    assert.equal(await readCachedContext(db), null);
    assert.equal(db.rows('cached_user_context').length, 0);
    assert.deepEqual(
      db.rows('cached_site_context').map((row) => [row['site_id'], row['site_name']]),
      [['s1', 'Pilot Site']],
    );
  });
});

// Story 1.13 (AD-18): refused and parked rows are copied to the local-only edge_outbox_retained
// table, because a PowerSync checkpoint deletes every edge_outbox row whose queue entry completed.
describe('Story 1.13 retention of unheld outbox rows', () => {
  it('retains a full copy idempotently and keeps it through a checkpoint', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'a', local_status: 'needs_attention', server_error_code: 'MODULE_ACCESS_DENIED', metadata: ownedBy('u1') });
    await retainOutboxRow(db, 'a', 'refused');
    await retainOutboxRow(db, 'a', 'refused');
    db.checkpoint();
    const retained = db.rows('edge_outbox_retained');
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!['retained_reason'], 'refused');
    assert.equal(retained[0]!['server_error_code'], 'MODULE_ACCESS_DENIED');
    assert.equal(retained[0]!['metadata'], ownedBy('u1'));
    assert.equal(retained[0]!['idempotency_key'], 'key-a');
    assert.deepEqual(await readOutboxCounts(db), { pendingCount: 0, failedCount: 1 });
    assert.equal((await readFailures(db))[0]?.server_error_code, 'MODULE_ACCESS_DENIED');
  });

  it('never drops an existing retained copy when the outbox row is already gone', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'a', local_status: 'needs_attention' });
    await retainOutboxRow(db, 'a', 'refused');
    db.checkpoint();
    await retainOutboxRow(db, 'a', 'refused');
    assert.equal(db.rows('edge_outbox_retained').length, 1);
  });

  it('never double counts a row present in both tables', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'r', local_status: 'needs_attention', server_error_code: 'X' });
    db.seed({ id: 'p', local_status: 'auth_required', metadata: ownedBy('u2') });
    await retainOutboxRow(db, 'r', 'refused');
    await retainOutboxRow(db, 'p', 'parked_for_owner');
    assert.deepEqual(await readOutboxCounts(db), { pendingCount: 0, failedCount: 1 });
    assert.equal((await readFailures(db)).length, 1);
    assert.deepEqual(await readWaitingForOtherOwners(db, 'u1'), [{ userId: 'u2', count: 1 }]);
    assert.equal(await hasAuthRequired(db), false, 'a parked row is not a sign-in problem');
    db.checkpoint();
    assert.deepEqual(await readWaitingForOtherOwners(db, 'u1'), [{ userId: 'u2', count: 1 }]);
    assert.equal(await countUnsettled(db, 'u2'), 1);
  });

  it('finds a retained STREAM_CONFLICT head after the outbox row is gone', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'head', local_status: 'needs_attention', server_error_code: 'STREAM_CONFLICT', stream_id: 'wo-1', created_at: '2026-08-28T09:00:00.000Z' });
    await retainOutboxRow(db, 'head', 'refused');
    db.checkpoint();
    assert.deepEqual(
      await hasUpstreamStreamConflict(db, 'dep', 'wo-1', '2026-08-28T09:05:00.000Z'),
      { parked_behind_event_id: 'head' },
    );
    assert.equal(await hasUpstreamStreamConflict(db, 'dep', 'wo-2', '2026-08-28T09:05:00.000Z'), null);
  });

  it('re-queues a retained parked row for its owner and removes the retained copy', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'p', local_status: 'auth_required', metadata: ownedBy('u2') });
    db.seed({ id: 'q', local_status: 'auth_required', metadata: ownedBy('u3') });
    await retainOutboxRow(db, 'p', 'parked_for_owner');
    await retainOutboxRow(db, 'q', 'parked_for_owner');
    db.checkpoint();
    await resetAuthRequired(db, 'u2');
    assert.deepEqual(statusById(db), { p: 'pending_sync' });
    assert.equal(db.rows('edge_outbox')[0]!['idempotency_key'], 'key-p');
    assert.deepEqual(db.rows('edge_outbox_retained').map((row) => row['id']), ['q']);
  });

  // Story 1.14 (AC 6, Binding Decision 8): the dismiss action Story 1.13 deferred here.
  it('dismisses only the named refused copy, never a parked-for-owner row, and un-parks the stream', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'head', local_status: 'needs_attention', server_error_code: 'STREAM_CONFLICT', stream_id: 'wo-1', created_at: '2026-09-17T09:00:00.000Z' });
    db.seed({ id: 'other', local_status: 'needs_attention', server_error_code: 'ASSET_NOT_FOUND', stream_id: 'wo-2' });
    db.seed({ id: 'parked', local_status: 'auth_required', stream_id: 'wo-1', metadata: ownedBy('u2') });
    await retainOutboxRow(db, 'head', 'refused');
    await retainOutboxRow(db, 'other', 'refused');
    await retainOutboxRow(db, 'parked', 'parked_for_owner');
    db.checkpoint();
    assert.deepEqual(
      await hasUpstreamStreamConflict(db, 'tail', 'wo-1', '2026-09-17T09:05:00.000Z'),
      { parked_behind_event_id: 'head' },
    );

    await dismissRetainedRow(db, 'head');
    assert.deepEqual(
      db.rows('edge_outbox_retained').map((row) => [row['id'], row['retained_reason']]),
      [['other', 'refused'], ['parked', 'parked_for_owner']],
      'only the named refused row is gone',
    );
    assert.equal(db.transactions, 1, 'one write transaction');
    assert.equal(await hasUpstreamStreamConflict(db, 'tail', 'wo-1', '2026-09-17T09:05:00.000Z'), null, 'the stream is no longer parked');
    assert.deepEqual(await readOutboxCounts(db), { pendingCount: 0, failedCount: 1 });
    assert.deepEqual((await readFailures(db)).map((row) => row.id), ['other']);

    // A parked-for-owner row is never dismissable: it belongs to someone else and re-queues on their sign-in.
    await assert.rejects(dismissRetainedRow(db, 'parked'));
    assert.deepEqual(db.rows('edge_outbox_retained').map((row) => row['id']), ['other', 'parked']);
    assert.deepEqual(await readWaitingForOtherOwners(db, 'u1'), [{ userId: 'u2', count: 1 }]);
  });

  it('rejects dismissing an unsalvaged needs_attention row (no retained copy) and a missing id', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'head', local_status: 'needs_attention', server_error_code: 'STREAM_CONFLICT', stream_id: 'wo-1' });
    db.seed({ id: 'other', local_status: 'needs_attention', server_error_code: 'ASSET_NOT_FOUND', stream_id: 'wo-2' });
    await retainOutboxRow(db, 'other', 'refused');
    db.checkpoint();

    await assert.rejects(dismissRetainedRow(db, 'head'));
    await assert.rejects(dismissRetainedRow(db, 'missing'));
    assert.deepEqual(db.rows('edge_outbox_retained').map((row) => row['id']), ['other']);
  });

  it('salvages refused and other people\'s parked rows once, and nothing else', async () => {
    const db = new SqliteDb();
    db.seed({ id: 'r', local_status: 'needs_attention', server_error_code: 'X', metadata: ownedBy('u1') });
    db.seed({ id: 'mine', local_status: 'auth_required', metadata: ownedBy('u1') });
    db.seed({ id: 'theirs', local_status: 'auth_required', metadata: ownedBy('u2') });
    db.seed({ id: 'anon', local_status: 'auth_required' });
    db.seed({ id: 'pending', local_status: 'pending_sync', metadata: ownedBy('u2') });
    await salvageUnheldOutboxRows(db, 'u1');
    await salvageUnheldOutboxRows(db, 'u1');
    assert.deepEqual(
      db.rows('edge_outbox_retained').map((row) => [row['id'], row['retained_reason']]),
      [['r', 'refused'], ['theirs', 'parked_for_owner']],
    );
  });
});

// Story 7.8: the worklist cache and the per-stream version cursor (Binding Decisions 2 and 11).
interface CacheRow {
  id: string;
  local_head_version: number;
  stream_version: number;
  [key: string]: unknown;
}

class WorklistFakeDb implements QueryExecutor {
  outbox: Array<{ stream_id: string; local_status: string }> = [];
  workOrders = new Map<string, CacheRow>();
  reservations = new Map<string, CacheRow>();
  closureCodes: Array<{ kind: string; code: string }> = [];

  private tableFor(sql: string): Map<string, CacheRow> | null {
    if (sql.includes('cached_work_order')) return this.workOrders;
    if (sql.includes('cached_spare_reservation')) return this.reservations;
    return null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql.startsWith('DELETE FROM cached_work_order')) this.workOrders.clear();
    else if (sql.startsWith('DELETE FROM cached_spare_reservation')) this.reservations.clear();
    else if (sql.startsWith('DELETE FROM cached_closure_code')) this.closureCodes = [];
    else if (sql.startsWith('INSERT INTO cached_work_order')) {
      this.workOrders.set(params[0] as string, {
        id: params[0] as string,
        stream_version: params[10] as number,
        local_head_version: params[11] as number,
      });
    } else if (sql.startsWith('INSERT INTO cached_spare_reservation')) {
      this.reservations.set(params[0] as string, {
        id: params[0] as string,
        work_order_id: params[2],
        stream_version: params[6] as number,
        local_head_version: params[7] as number,
      });
    } else if (sql.startsWith('INSERT INTO cached_closure_code')) {
      this.closureCodes.push({ kind: params[1] as string, code: params[2] as string });
    } else if (sql.startsWith('UPDATE')) {
      const row = this.tableFor(sql)?.get(params[0] as string);
      if (row) row.local_head_version += 1;
    }
    return {};
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.includes('DISTINCT stream_id FROM edge_outbox')) {
      return [...new Set(this.outbox.filter((r) => r.local_status === 'pending_sync' || r.local_status === 'syncing').map((r) => r.stream_id))].map((stream_id) => ({ stream_id })) as T[];
    }
    if (sql.includes('AS id, local_head_version FROM')) {
      const table = this.tableFor(sql);
      return [...(table?.values() ?? [])].map((row) => ({ id: row.id, local_head_version: row.local_head_version })) as T[];
    }
    if (sql.startsWith('UPDATE') && sql.includes('RETURNING local_head_version')) {
      const row = this.tableFor(sql)?.get(params[0] as string);
      if (!row) return [] as T[];
      row.local_head_version += 1;
      return [{ local_head_version: row.local_head_version }] as T[];
    }
    if (sql.includes('SELECT local_head_version FROM')) {
      const row = this.tableFor(sql)?.get(params[0] as string);
      return (row ? [{ local_head_version: row.local_head_version }] : []) as T[];
    }
    if (sql.includes('FROM cached_closure_code')) return this.closureCodes as T[];
    return [];
  }

  async writeTransaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function snapshot(overrides: Partial<WorklistSnapshot> = {}): WorklistSnapshot {
  return {
    fetched_at: '2026-08-28T09:00:00.000Z',
    total: 1,
    truncated: false,
    closure_codes: { fault: ['MECHANICAL'], cause: ['WEAR'], remedy: ['REPLACED'] },
    work_orders: [
      {
        work_order_id: 'wo-1',
        origin: 'breakdown',
        status: 'open',
        priority: 'p1',
        due_date: '2026-08-30',
        sla_resolution_due_at: null,
        warranty_flagged: false,
        stream_version: 3,
        asset: { asset_id: 'a-1', asset_tag: 'CNC-01', name: 'CNC', criticality: 'critical' },
        recent_closures: [],
        reservations: [
          { reservation_id: 'r-1', sku: 'BELT', quantity: '1.000000', location_id: 'l-1', stream_version: 1 },
        ],
        meters: [],
      },
    ],
    ...overrides,
  };
}

describe('Story 7.8 worklist cache and stream version cursor', () => {
  it('seeds local_head_version from the server stream_version and bumps it per capture', async () => {
    const db = new WorklistFakeDb();
    await applyWorklistSnapshot(db, snapshot());
    assert.equal(db.workOrders.get('wo-1')?.local_head_version, 3);
    assert.equal(db.reservations.get('r-1')?.local_head_version, 1);
    assert.equal(await nextStreamVersion(db, 'cached_work_order', 'wo-1'), 4);
    assert.equal(await nextStreamVersion(db, 'cached_work_order', 'wo-1'), 5);
    assert.equal(await nextStreamVersion(db, 'cached_spare_reservation', 'r-1'), 2);
    await assert.rejects(() => nextStreamVersion(db, 'cached_work_order', 'missing'));
    assert.deepEqual(await readClosureCatalogue(db), {
      fault: ['MECHANICAL'],
      cause: ['WEAR'],
      remedy: ['REPLACED'],
    });
  });

  it('keeps the local head on a refresh while the stream has unsettled outbox rows, and re-seeds otherwise', async () => {
    const db = new WorklistFakeDb();
    await applyWorklistSnapshot(db, snapshot());
    await nextStreamVersion(db, 'cached_work_order', 'wo-1');
    await nextStreamVersion(db, 'cached_work_order', 'wo-1');
    assert.equal(db.workOrders.get('wo-1')?.local_head_version, 5);

    // A pending capture on wo-1: the refresh must NOT lower the cursor below the versions it claimed.
    db.outbox.push({ stream_id: 'wo-1', local_status: 'pending_sync' });
    await applyWorklistSnapshot(db, snapshot());
    assert.equal(db.workOrders.get('wo-1')?.local_head_version, 5);
    assert.equal(db.workOrders.get('wo-1')?.stream_version, 3);

    // Once every row on the stream has settled, the server head is the truth again.
    db.outbox = [{ stream_id: 'wo-1', local_status: 'synced' }];
    await applyWorklistSnapshot(db, snapshot({ work_orders: [{ ...snapshot().work_orders[0]!, stream_version: 6 }] }));
    assert.equal(db.workOrders.get('wo-1')?.local_head_version, 6);
  });
});

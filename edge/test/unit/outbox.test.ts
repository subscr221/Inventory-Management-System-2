import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheContext,
  hasAuthRequired,
  insertCaptureEvent,
  readCachedContext,
  readFailures,
  readOutboxCounts,
  type QueryExecutor,
} from '../../src/local-db/outbox';
import {
  applyWorklistSnapshot,
  nextStreamVersion,
  readClosureCatalogue,
  type WorklistSnapshot,
} from '../../src/local-db/worklist';
import { createTestCaptureEvent } from '../../src/capture/test-capture';

interface Row {
  id: string;
  local_status: string;
  event_type: string;
  server_error_code: string | null;
  created_at: string;
}

class FakeDb implements QueryExecutor {
  outbox: Row[] = [];
  user: Record<string, unknown> | null = null;
  site: Record<string, unknown> | null = null;

  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql.startsWith('INSERT INTO edge_outbox')) {
      this.outbox.push({
        id: params[0] as string,
        event_type: params[3] as string,
        local_status: params[9] as string,
        server_error_code: params[10] as string | null,
        created_at: params[12] as string,
      });
    } else if (sql.startsWith('DELETE FROM cached_user_context')) {
      this.user = null;
    } else if (sql.startsWith('INSERT INTO cached_user_context')) {
      this.user = { user_id: params[1], user_name: params[2], role: params[3] };
    } else if (sql.startsWith('DELETE FROM cached_site_context')) {
      this.site = null;
    } else if (sql.startsWith('INSERT INTO cached_site_context')) {
      this.site = { site_id: params[1], site_name: params[2] };
    }
    return {};
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (sql.includes('GROUP BY local_status')) {
      const counts = new Map<string, number>();
      for (const row of this.outbox)
        counts.set(row.local_status, (counts.get(row.local_status) ?? 0) + 1);
      return [...counts].map(([local_status, count]) => ({ local_status, count })) as T[];
    }
    if (sql.includes("local_status = ?") && params[0] === 'auth_required') {
      return [{ count: this.outbox.filter((r) => r.local_status === 'auth_required').length }] as T[];
    }
    if (sql.includes("local_status = ?") && params[0] === 'needs_attention') {
      return this.outbox.filter((r) => r.local_status === 'needs_attention') as T[];
    }
    if (sql.includes('FROM cached_user_context')) return (this.user ? [this.user] : []) as T[];
    if (sql.includes('FROM cached_site_context')) return (this.site ? [this.site] : []) as T[];
    return [];
  }
}

describe('edge outbox local data', () => {
  it('inserts a capture event and reports pending counts', async () => {
    const db = new FakeDb();
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
    const db = new FakeDb();
    db.outbox.push(
      { id: 'a', event_type: 'e', local_status: 'needs_attention', server_error_code: 'UNTAGGED_TRANSACTION', created_at: 'now' },
      { id: 'b', event_type: 'e', local_status: 'auth_required', server_error_code: null, created_at: 'now' },
      { id: 'c', event_type: 'e', local_status: 'pending_sync', server_error_code: null, created_at: 'now' },
    );
    assert.deepEqual(await readOutboxCounts(db), { pendingCount: 1, failedCount: 1 });
    assert.equal(await hasAuthRequired(db), true);
    assert.equal((await readFailures(db)).length, 1);
  });

  it('caches and restores user and site context', async () => {
    const db = new FakeDb();
    await cacheContext(
      db,
      { userId: 'u1', userName: 'Officer', role: 'gate_officer' },
      { siteId: 's1', siteName: 'Pilot Site' },
    );
    const restored = await readCachedContext(db);
    assert.equal(restored?.user.userName, 'Officer');
    assert.equal(restored?.site.siteName, 'Pilot Site');
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

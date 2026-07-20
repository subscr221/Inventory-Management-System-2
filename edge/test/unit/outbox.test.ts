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

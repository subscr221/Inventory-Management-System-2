import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CrudEntry,
  UpdateType,
  type AbstractPowerSyncDatabase,
  type CrudTransaction,
} from '@powersync/web';
import {
  EdgePowerSyncConnector,
  classifyServerUploadFailure,
} from '../../src/sync/connector';
import { edgeOutbox, type EdgeLocalStatus } from '../../src/local-db/schema';

function put(id: string, clientId: number): CrudEntry {
  return new CrudEntry(clientId, UpdateType.PUT, 'edge_outbox', id, 1, {
    stream_type: 'maintenance',
    local_status: 'pending_sync',
  });
}

function createDatabase(
  crud: CrudEntry[],
  statuses: Record<string, EdgeLocalStatus>,
  activity: string[],
): AbstractPowerSyncDatabase {
  const transaction = {
    crud,
    complete: async () => {
      activity.push('complete');
    },
    transactionId: 1,
  } as CrudTransaction;

  return {
    getNextCrudTransaction: async () => transaction,
    getOptional: async (_sql: string, parameters: unknown[]) => {
      const id = parameters[0] as string;
      activity.push(`read:${id}:${statuses[id] ?? 'missing'}`);
      return statuses[id] ? { local_status: statuses[id] } : null;
    },
    execute: async (_sql: string, parameters: unknown[]) => {
      const status = parameters[0] as EdgeLocalStatus;
      const id = parameters[4] as string;
      statuses[id] = status;
      activity.push(`write:${id}:${status}`);
      return { rowsAffected: 1 };
    },
  } as unknown as AbstractPowerSyncDatabase;
}

describe('edge upload failure classification', () => {
  it('treats duplicate conflicts as convergence', () => {
    assert.deepEqual(
      classifyServerUploadFailure(409, {
        error_code: 'DUPLICATE_EVENT',
        details: { existing_event_id: '11111111-1111-4111-8111-111111111111' },
      }),
      {
        action: 'complete',
        localStatus: 'synced',
        retryable: false,
        serverErrorCode: 'DUPLICATE_EVENT',
        existingEventId: '11111111-1111-4111-8111-111111111111',
      },
    );
  });

  it('separates permanent, auth, and retryable failures', () => {
    assert.equal(
      classifyServerUploadFailure(400, { error_code: 'UNTAGGED_TRANSACTION' }).localStatus,
      'needs_attention',
    );
    assert.equal(
      classifyServerUploadFailure(409, { error_code: 'STREAM_CONFLICT' }).localStatus,
      'needs_attention',
    );
    assert.equal(
      classifyServerUploadFailure(400, { error_code: 'VALUATION_METHOD_NOT_PERMITTED' }).localStatus,
      'needs_attention',
    );
    assert.equal(
      classifyServerUploadFailure(409, { error_code: 'NRV_RECOVERY_EXCEEDS_ORIGINAL_COST' }).localStatus,
      'needs_attention',
    );
    // Story 2.6 cycle-count / physical-verification permanent business rejections
    for (const code of [
      'COUNT_TASK_LOCKED',
      'COUNT_ENTERER_CANNOT_APPROVE',
      'PERIOD_LOCKED',
      'COUNT_VARIANCE_REQUIRES_APPROVAL',
      'STOCK_ADJUSTMENT_NEGATIVE_BALANCE',
      // Story 2.7 inventory-planning permanent business rejections
      'LEAD_TIME_NOT_CONFIGURED',
      'INSUFFICIENT_DEMAND_HISTORY',
      'INVALID_SERVICE_LEVEL',
      'PLANNING_PARAMS_NOT_FOUND',
      'OBSOLESCENCE_THRESHOLD_NOT_CONFIGURED',
    ]) {
      assert.equal(classifyServerUploadFailure(409, { error_code: code }).localStatus, 'needs_attention');
    }
    assert.equal(
      classifyServerUploadFailure(401, { error_code: 'UNAUTHORIZED' }).localStatus,
      'auth_required',
    );
    assert.equal(
      classifyServerUploadFailure(503, { error_code: 'INTERNAL_ERROR' }).retryable,
      true,
    );
    for (const status of [408, 425, 429]) {
      assert.equal(classifyServerUploadFailure(status, {}).action, 'retry');
    }
  });
});

describe('edge upload connector', () => {
  it('keeps the outbox locally readable so status is not insert-only', () => {
    assert.equal(edgeOutbox.insertOnly, false);
  });

  it('marks a successful row synced before completing the transaction', async (t) => {
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = { event1: 'pending_sync' };
    const database = createDatabase([put('event1', 1)], statuses, activity);
    t.mock.method(globalThis, 'fetch', async () => {
      activity.push('fetch:event1');
      return new Response(null, { status: 201 });
    });

    await new EdgePowerSyncConnector().uploadData(database);

    assert.equal(statuses['event1'], 'synced');
    assert.deepEqual(activity, [
      'read:event1:pending_sync',
      'fetch:event1',
      'write:event1:synced',
      'complete',
    ]);
  });

  it('retains an auth-blocked operation and stops the transaction', async (t) => {
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = {
      event1: 'pending_sync',
      event2: 'pending_sync',
    };
    const database = createDatabase([put('event1', 1), put('event2', 2)], statuses, activity);
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests += 1;
      return Response.json({ error_code: 'UNAUTHORIZED' }, { status: 401 });
    });

    await new EdgePowerSyncConnector().uploadData(database);

    assert.equal(requests, 1);
    assert.equal(statuses['event1'], 'auth_required');
    assert.equal(statuses['event2'], 'pending_sync');
    assert.equal(activity.includes('complete'), false);
  });

  it('completes PATCH and DELETE bookkeeping without posting envelopes', async (t) => {
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = { event1: 'synced' };
    const crud = [
      new CrudEntry(1, UpdateType.PATCH, 'edge_outbox', 'event1', 1, {
        local_status: 'synced',
      }),
      new CrudEntry(2, UpdateType.DELETE, 'edge_outbox', 'event1', 1),
    ];
    const database = createDatabase(crud, statuses, activity);
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null));

    await new EdgePowerSyncConnector().uploadData(database);

    assert.equal(fetchMock.mock.callCount(), 0);
    assert.deepEqual(activity, ['complete']);
  });

  it('preserves a settled permanent outcome when a later operation retries', async (t) => {
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = {
      permanent: 'pending_sync',
      retry: 'pending_sync',
    };
    const database = createDatabase(
      [put('permanent', 1), put('retry', 2)],
      statuses,
      activity,
    );
    const requestedIds: string[] = [];
    let retryAttempts = 0;
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { event_id: string };
      requestedIds.push(body.event_id);
      if (body.event_id === 'permanent') {
        return Response.json({ error_code: 'INVALID_EVENT_ENVELOPE' }, { status: 400 });
      }
      retryAttempts += 1;
      return retryAttempts === 1
        ? Response.json({ error_code: 'TEMPORARY' }, { status: 503 })
        : new Response(null, { status: 201 });
    });

    await assert.rejects(() => new EdgePowerSyncConnector().uploadData(database));
    assert.equal(statuses['permanent'], 'needs_attention');
    assert.equal(activity.includes('complete'), false);

    await new EdgePowerSyncConnector().uploadData(database);

    assert.deepEqual(requestedIds, ['permanent', 'retry', 'retry']);
    assert.equal(statuses['permanent'], 'needs_attention');
    assert.equal(statuses['retry'], 'synced');
    assert.equal(activity.at(-1), 'complete');
  });
});

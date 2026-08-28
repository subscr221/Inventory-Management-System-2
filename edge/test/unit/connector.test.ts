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
      // Story 2.8 consignment/VMI ownership permanent business rejections
      'OWNERSHIP_AGREEMENT_NOT_FOUND',
      'OWNER_PARTY_MISMATCH',
      'VMI_MIN_NOT_CONFIGURED',
      'INVALID_SIGNAL_TYPE',
      // Story 2.9 ERP read-only reference projection rejection
      'SOURCE_SYSTEM_READ_ONLY',
      // Story 3.2 gate-event permanent business rejections
      'GATE_VEHICLE_REG_REQUIRED',
      'GATE_CHALLAN_PHOTO_REQUIRED',
      'GATE_PO_REF_REQUIRED',
      'GATE_SITE_NOT_FOUND',
      'GATE_REVERSAL_REASON_REQUIRED',
      'GATE_EVENT_NOT_FOUND',
      'GATE_ALREADY_REVERSED',
      // Story 3.3 weighbridge permanent business rejections
      'WEIGHBRIDGE_TARE_REQUIRED',
      'WEIGHBRIDGE_GROSS_REQUIRED',
      'WEIGHBRIDGE_BINDING_TOKEN_REQUIRED',
      'WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND',
      'WEIGHBRIDGE_SITE_MISMATCH',
      'WEIGHBRIDGE_NET_NEGATIVE',
      'WEIGHBRIDGE_PO_LINE_NOT_FOUND',
    ]) {
      assert.equal(classifyServerUploadFailure(409, { error_code: code }).localStatus, 'needs_attention');
    }
    for (const code of [
      'GATE_VEHICLE_REG_REQUIRED',
      'GATE_CHALLAN_PHOTO_REQUIRED',
      'GATE_PO_REF_REQUIRED',
      'GATE_SITE_NOT_FOUND',
      'GATE_REVERSAL_REASON_REQUIRED',
      'GATE_EVENT_NOT_FOUND',
      'GATE_ALREADY_REVERSED',
      // Story 3.3 weighbridge permanent business rejections settle on a 403 business denial too
      'WEIGHBRIDGE_TARE_REQUIRED',
      'WEIGHBRIDGE_GROSS_REQUIRED',
      'WEIGHBRIDGE_BINDING_TOKEN_REQUIRED',
      'WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND',
      'WEIGHBRIDGE_SITE_MISMATCH',
      'WEIGHBRIDGE_NET_NEGATIVE',
      'WEIGHBRIDGE_PO_LINE_NOT_FOUND',
    ]) {
      assert.equal(classifyServerUploadFailure(403, { error_code: code }).localStatus, 'needs_attention');
    }
    // Story 3.4 goods-receiving permanent business rejections. RECEIPT_TOLERANCE_EXCEEDED is
    // deliberately NOT here - it is a committed 2xx business outcome, not a sync error.
    for (const code of [
      'ITEM_PO_MISMATCH',
      'RECEIVING_BINDING_TOKEN_REQUIRED',
      'RECEIVING_BINDING_TOKEN_NOT_FOUND',
      'RECEIVING_WEIGHT_NOT_ACCEPTED',
      'RECEIVING_PO_NOT_FOUND',
      'RECEIVING_QTY_REQUIRED',
      'RECEIVING_QC_HOLD_ZONE_NOT_FOUND',
    ]) {
      assert.equal(classifyServerUploadFailure(409, { error_code: code }).localStatus, 'needs_attention');
      assert.equal(classifyServerUploadFailure(403, { error_code: code }).localStatus, 'needs_attention');
    }
    // A tolerance-exceeded outcome must NOT be classified as a permanent sync failure.
    assert.notEqual(
      classifyServerUploadFailure(200, { error_code: 'RECEIPT_TOLERANCE_EXCEEDED' }).localStatus,
      'needs_attention',
    );
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

  // Story 7.8 (Binding Decision 3): parking. The fake below answers the outbox parking query from
  // an in-memory row set, so the connector's decision is made from the TABLE, not from memory.
  interface ParkRow {
    id: string;
    stream_id: string;
    created_at: string;
    local_status: EdgeLocalStatus;
    server_error_code: string | null;
  }

  function createParkingDatabase(
    crud: CrudEntry[],
    rows: ParkRow[],
    activity: string[],
  ): AbstractPowerSyncDatabase {
    const transaction = {
      crud,
      complete: async () => {
        activity.push('complete');
      },
      transactionId: 1,
    } as CrudTransaction;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
      getNextCrudTransaction: async () => transaction,
      getOptional: async (_sql: string, parameters: unknown[]) => {
        const row = byId.get(parameters[0] as string);
        return row ? { local_status: row.local_status } : null;
      },
      getAll: async (_sql: string, parameters: unknown[]) => {
        const [streamId, eventId, createdAt] = parameters as [string, string, string];
        activity.push(`park-check:${eventId}`);
        return rows
          .filter(
            (row) =>
              row.stream_id === streamId &&
              row.id !== eventId &&
              row.local_status === 'needs_attention' &&
              row.server_error_code === 'STREAM_CONFLICT' &&
              row.created_at <= createdAt,
          )
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
          .slice(0, 1)
          .map((row) => ({ id: row.id }));
      },
      execute: async (_sql: string, parameters: unknown[]) => {
        const row = byId.get(parameters[4] as string);
        if (row) {
          row.local_status = parameters[0] as EdgeLocalStatus;
          row.server_error_code = (parameters[1] as string | null) ?? null;
          activity.push(`write:${row.id}:${row.local_status}:${String(parameters[2])}`);
        }
        return { rowsAffected: 1 };
      },
    } as unknown as AbstractPowerSyncDatabase;
  }

  function streamPut(row: ParkRow, clientId: number, eventVersion: number | null = 2): CrudEntry {
    return new CrudEntry(clientId, UpdateType.PUT, 'edge_outbox', row.id, 1, {
      stream_type: 'maintenance',
      stream_id: row.stream_id,
      event_version: eventVersion,
      created_at: row.created_at,
      local_status: row.local_status,
    });
  }

  it('parks every later row on a conflicted stream without a network call and still uploads other streams', async (t) => {
    const activity: string[] = [];
    const rows: ParkRow[] = [
      { id: 'head', stream_id: 'wo-1', created_at: '2026-08-28T09:00:00.000Z', local_status: 'pending_sync', server_error_code: null },
      { id: 'dep1', stream_id: 'wo-1', created_at: '2026-08-28T09:05:00.000Z', local_status: 'pending_sync', server_error_code: null },
      { id: 'dep2', stream_id: 'wo-1', created_at: '2026-08-28T09:10:00.000Z', local_status: 'pending_sync', server_error_code: null },
      { id: 'other', stream_id: 'wo-2', created_at: '2026-08-28T09:11:00.000Z', local_status: 'pending_sync', server_error_code: null },
    ];
    const database = createParkingDatabase(
      rows.map((row, index) => streamPut(row, index + 1)),
      rows,
      activity,
    );
    const posted: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { event_id: string };
      posted.push(body.event_id);
      if (body.event_id === 'head') {
        return Response.json(
          { error_code: 'STREAM_CONFLICT', details: { stream_id: 'wo-1', event_version: 2, head_version: 3 } },
          { status: 409 },
        );
      }
      return new Response(null, { status: 201 });
    });

    await new EdgePowerSyncConnector().uploadData(database);

    assert.deepEqual(posted, ['head', 'other']);
    assert.equal(rows[0]!.local_status, 'needs_attention');
    assert.equal(rows[1]!.local_status, 'needs_attention');
    assert.equal(rows[1]!.server_error_code, 'STREAM_CONFLICT');
    assert.equal(rows[2]!.local_status, 'needs_attention');
    assert.equal(rows[3]!.local_status, 'synced');
    assert.ok(
      activity.includes('write:dep1:needs_attention:{"parked_behind_event_id":"head"}'),
      activity.join('\n'),
    );
    assert.ok(activity.includes('write:dep2:needs_attention:{"parked_behind_event_id":"head"}'));
    assert.equal(activity.at(-1), 'complete');
  });

  it('parks dependents that share the head created_at to the millisecond', async (t) => {
    const activity: string[] = [];
    const sameInstant = '2026-08-28T09:00:00.000Z';
    const rows: ParkRow[] = [
      { id: 'head', stream_id: 'wo-1', created_at: sameInstant, local_status: 'pending_sync', server_error_code: null },
      { id: 'dep1', stream_id: 'wo-1', created_at: sameInstant, local_status: 'pending_sync', server_error_code: null },
      { id: 'dep2', stream_id: 'wo-1', created_at: sameInstant, local_status: 'pending_sync', server_error_code: null },
    ];
    const database = createParkingDatabase(
      rows.map((row, index) => streamPut(row, index + 1)),
      rows,
      activity,
    );
    const posted: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { event_id: string };
      posted.push(body.event_id);
      return Response.json({ error_code: 'STREAM_CONFLICT' }, { status: 409 });
    });

    await new EdgePowerSyncConnector().uploadData(database);

    assert.deepEqual(posted, ['head']);
    assert.ok(rows.every((row) => row.local_status === 'needs_attention'));
    assert.equal(rows[2]!.server_error_code, 'STREAM_CONFLICT');
  });

  it('strips a null event_version from the POST body and keeps a numeric one', async (t) => {
    const activity: string[] = [];
    const rows: ParkRow[] = [
      { id: 'meter', stream_id: 'm-1', created_at: '2026-08-28T09:00:00.000Z', local_status: 'pending_sync', server_error_code: null },
      { id: 'status', stream_id: 'wo-1', created_at: '2026-08-28T09:01:00.000Z', local_status: 'pending_sync', server_error_code: null },
    ];
    const database = createParkingDatabase(
      [streamPut(rows[0]!, 1, null), streamPut(rows[1]!, 2, 5)],
      rows,
      activity,
    );
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 201 });
    });

    await new EdgePowerSyncConnector().uploadData(database);

    assert.equal(bodies.length, 2);
    assert.equal('event_version' in bodies[0]!, false);
    assert.equal(bodies[0]!['event_id'], 'meter');
    assert.equal(bodies[1]!['event_version'], 5);
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

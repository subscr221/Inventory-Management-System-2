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
import { EdgeSession, setActiveSession, type SessionManager } from '../../src/session/session';

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
  failRetain = false,
): AbstractPowerSyncDatabase {
  const transaction = {
    crud,
    complete: async () => {
      activity.push('complete');
    },
    transactionId: 1,
  } as CrudTransaction;

  const database = {
    getNextCrudTransaction: async () => transaction,
    getOptional: async (_sql: string, parameters: unknown[]) => {
      const id = parameters[0] as string;
      activity.push(`read:${id}:${statuses[id] ?? 'missing'}`);
      return statuses[id] ? { local_status: statuses[id] } : null;
    },
    writeTransaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(database),
    execute: async (sql: string, parameters: unknown[]) => {
      // Story 1.13: the retention copy (delete then insert-select) is routed explicitly.
      if (sql.includes('edge_outbox_retained')) {
        if (failRetain) throw new Error('retain failed');
        if (sql.trimStart().startsWith('INSERT')) activity.push(`retain:${String(parameters[2])}:${String(parameters[0])}`);
        return { rowsAffected: 1 };
      }
      const status = parameters[0] as EdgeLocalStatus;
      const id = parameters[4] as string;
      statuses[id] = status;
      activity.push(`write:${id}:${status}`);
      return { rowsAffected: 1 };
    },
  } as unknown as AbstractPowerSyncDatabase;
  return database;
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
    // An authorization denial is not a sign-in problem: only a bare 401/403 halts as auth_required.
    for (const code of ['FUNCTION_ACCESS_DENIED', 'LOCATION_ACCESS_DENIED', 'MODULE_ACCESS_DENIED']) {
      assert.equal(classifyServerUploadFailure(403, { error_code: code }).localStatus, 'needs_attention');
    }
    assert.equal(classifyServerUploadFailure(403, {}).localStatus, 'auth_required');
    assert.equal(classifyServerUploadFailure(401, { error_code: 'UNAUTHORIZED' }).localStatus, 'auth_required');
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
    const retained = new Set<string>();
    const database = {
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
              retained.has(row.id) &&
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
      writeTransaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(database),
      execute: async (sql: string, parameters: unknown[]) => {
        if (sql.includes('edge_outbox_retained')) {
          if (sql.trimStart().startsWith('INSERT')) {
            retained.add(parameters[2] as string);
            activity.push(`retain:${String(parameters[2])}:${String(parameters[0])}`);
          }
          return { rowsAffected: 1 };
        }
        const row = byId.get(parameters[4] as string);
        if (row) {
          row.local_status = parameters[0] as EdgeLocalStatus;
          row.server_error_code = (parameters[1] as string | null) ?? null;
          activity.push(`write:${row.id}:${row.local_status}:${String(parameters[2])}`);
        }
        return { rowsAffected: 1 };
      },
    } as unknown as AbstractPowerSyncDatabase;
    return database;
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
    // Story 1.13: the head and both parked dependents are retained; the other stream is not.
    for (const id of ['head', 'dep1', 'dep2']) assert.ok(activity.includes(`retain:${id}:refused`), id);
    assert.equal(activity.includes('retain:other:refused'), false);
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

  // Story 1.13 (found by the real PowerSync test): payload and metadata are TEXT columns, so opData
  // carries them as JSON strings; the server's envelope validation needs objects.
  it('posts payload and metadata as objects, and a malformed one unchanged', async (t) => {
    const activity: string[] = [];
    const rows: ParkRow[] = [
      { id: 'ok', stream_id: 's-1', created_at: '2026-09-16T00:00:00.000Z', local_status: 'pending_sync', server_error_code: null },
      { id: 'bad', stream_id: 's-2', created_at: '2026-09-16T00:00:01.000Z', local_status: 'pending_sync', server_error_code: null },
    ];
    const textPut = (row: ParkRow, clientId: number, payload: string) =>
      new CrudEntry(clientId, UpdateType.PUT, 'edge_outbox', row.id, 1, {
        stream_type: 'maintenance',
        stream_id: row.stream_id,
        created_at: row.created_at,
        payload,
        metadata: JSON.stringify({ actor: { user_id: 'u1' } }),
      });
    const database = createParkingDatabase(
      [textPut(rows[0]!, 1, '{"capture_kind":"shell_test"}'), textPut(rows[1]!, 2, '{not json')],
      rows,
      activity,
    );
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 201 });
    });

    await new EdgePowerSyncConnector().uploadData(database);

    assert.deepEqual(bodies[0]!['payload'], { capture_kind: 'shell_test' });
    assert.deepEqual(bodies[0]!['metadata'], { actor: { user_id: 'u1' } });
    assert.equal(bodies[1]!['payload'], '{not json');
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

// Story 1.13 (AD-18): every settle that completes the queue entry without the server holding the
// row retains it first, in the same write transaction; a failed retain becomes a retry.
describe('Story 1.13 connector retention', () => {
  it('retains a permanent server refusal before completing', async (t) => {
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = { event1: 'pending_sync' };
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ error_code: 'MODULE_ACCESS_DENIED' }, { status: 403 }),
    );

    await new EdgePowerSyncConnector().uploadData(createDatabase([put('event1', 1)], statuses, activity));

    assert.deepEqual(activity, [
      'read:event1:pending_sync',
      'write:event1:needs_attention',
      'retain:event1:refused',
      'complete',
    ]);
  });

  it('throws without completing when the retain write fails', async (t) => {
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = { event1: 'pending_sync' };
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ error_code: 'INVALID_EVENT_ENVELOPE' }, { status: 400 }),
    );

    await assert.rejects(
      () => new EdgePowerSyncConnector().uploadData(createDatabase([put('event1', 1)], statuses, activity, true)),
      /retain failed/,
    );
    assert.equal(activity.includes('complete'), false);
  });

  it('retains nothing for accepted, duplicate, halted or retried uploads', async (t) => {
    const responses = [
      new Response(null, { status: 201 }),
      Response.json({ error_code: 'DUPLICATE_EVENT', details: { existing_event_id: 'x' } }, { status: 409 }),
      Response.json({ error_code: 'UNAUTHORIZED' }, { status: 401 }),
      Response.json({}, { status: 403 }),
      Response.json({ error_code: 'INTERNAL_ERROR' }, { status: 503 }),
    ];
    for (const response of responses) {
      const activity: string[] = [];
      t.mock.method(globalThis, 'fetch', async () => response);
      await new EdgePowerSyncConnector()
        .uploadData(createDatabase([put('event1', 1)], { event1: 'pending_sync' }, activity))
        .catch(() => undefined);
      assert.equal(activity.some((entry) => entry.startsWith('retain:')), false, String(response.status));
      t.mock.restoreAll();
    }
  });
});

// Story 1.12 (AC2): with an active session, both connector calls carry the bearer header and
// nothing else about the requests changes.
describe('Story 1.12 connector identity', () => {
  function sessionWithToken(token: string): EdgeSession {
    const manager: SessionManager = {
      getUser: async () => ({ access_token: token }),
      signinRedirect: async () => undefined,
      signinCallback: async () => undefined,
      signinSilent: async () => null,
      signoutRedirect: async () => undefined,
      removeUser: async () => undefined,
      events: { addUserSignedOut: () => undefined },
    };
    return new EdgeSession({
      config: { mode: 'oidc', authority: 'https://a/realms/ims', clientId: 'ims-app' },
      manager,
    });
  }

  it('sends Authorization: Bearer on credentials and upload calls', async (t) => {
    setActiveSession(sessionWithToken('tok'));
    try {
      const seen: Array<{ url: string; auth: string | null; contentType: string | null }> = [];
      t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          auth: headers.get('authorization'),
          contentType: headers.get('content-type'),
        });
        return String(input).endsWith('/powersync-credentials')
          ? Response.json({ endpoint: 'https://ps', token: 'ps-token' })
          : new Response(null, { status: 201 });
      });
      const activity: string[] = [];
      const statuses: Record<string, EdgeLocalStatus> = {};
      const connector = new EdgePowerSyncConnector();

      assert.deepEqual(await connector.fetchCredentials(), { endpoint: 'https://ps', token: 'ps-token' });
      await connector.uploadData(createDatabase([put('event1', 1)], statuses, activity));

      assert.deepEqual(seen, [
        { url: '/api/v1/edge/powersync-credentials', auth: 'Bearer tok', contentType: null },
        { url: '/api/v1/edge/events', auth: 'Bearer tok', contentType: 'application/json' },
      ]);
      assert.equal(statuses['event1'], 'synced');
    } finally {
      setActiveSession(null);
    }
  });

  // Review decision 1: a row uploads only under its owner's session.
  function ownedPut(id: string, clientId: number, owner: string): CrudEntry {
    return new CrudEntry(clientId, UpdateType.PUT, 'edge_outbox', id, 1, {
      stream_type: 'maintenance',
      local_status: 'pending_sync',
      metadata: JSON.stringify({ actor: { user_id: owner, role: 'r', location_id: 's1' } }),
    });
  }

  it('parks another person\'s rows out of the queue and uploads the signed-in user\'s', async (t) => {
    const requested: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requested.push((JSON.parse(String(init?.body)) as { event_id: string }).event_id);
      return new Response(null, { status: 201 });
    });
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = {
      theirs: 'pending_sync',
      parked: 'auth_required',
      mine: 'pending_sync',
    };
    const database = createDatabase(
      [ownedPut('theirs', 1, 'u2'), ownedPut('parked', 2, 'u2'), ownedPut('mine', 3, 'u1')],
      statuses,
      activity,
    );

    await new EdgePowerSyncConnector('', () => 'u1').uploadData(database);

    assert.deepEqual(requested, ['mine']);
    assert.equal(statuses['theirs'], 'auth_required');
    assert.equal(statuses['parked'], 'auth_required');
    assert.equal(activity.filter((entry) => entry.startsWith('write:parked')).length, 0);
    // Story 1.13: both of u2's rows leave the queue, so both are retained for u2.
    assert.ok(activity.includes('retain:theirs:parked_for_owner'));
    assert.ok(activity.includes('retain:parked:parked_for_owner'));
    assert.equal(activity.includes('retain:mine:parked_for_owner'), false);
    assert.ok(activity.indexOf('retain:theirs:parked_for_owner') < activity.indexOf('complete'));
    assert.equal(statuses['mine'], 'synced');
    assert.equal(activity.at(-1), 'complete');
  });

  it('uploads nothing and keeps the queue when nobody is signed in', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201 }));
    const activity: string[] = [];
    const statuses: Record<string, EdgeLocalStatus> = { mine: 'pending_sync' };
    const database = createDatabase([ownedPut('mine', 1, 'u1')], statuses, activity);

    await new EdgePowerSyncConnector('', () => null).uploadData(database);

    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(statuses['mine'], 'pending_sync');
    assert.equal(activity.includes('complete'), false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDamageCaptureEvents,
  createDamageReportedEvent,
  isDamageQuantity,
  missingDamageParts,
  type DamageCaptureInput,
} from '../../src/capture/damage';
import { createIndentRaisedEvent } from '../../src/capture/indent';
import {
  classifyUploadResponse,
  uploadPendingPhotos,
  MAX_UPLOAD_BYTES,
} from '../../src/sync/attachment-uploader';
import type { PendingPhoto, PendingPhotoStore } from '../../src/local-db/pending-photos';

const USER = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const REPORT = '11111111-1111-4111-8111-111111111111';
const EVENT = '55555555-5555-4555-8555-555555555555';
const PHOTO = '44444444-4444-4444-8444-444444444444';
const INDENT = '66666666-6666-4666-8666-666666666666';

function base(overrides: Partial<DamageCaptureInput> = {}): DamageCaptureInput {
  return {
    sku: ' PCB-CTRL-01 ',
    lotNumber: ' LOT-7 ',
    quantity: '4',
    foundAt: 'stock',
    binCode: ' CMF-STORE-A1 ',
    reasonCode: 'DEAD_ON_ARRIVAL',
    reasonNote: null,
    photoAttachmentId: PHOTO,
    wholeLotRequested: false,
    replacementIndentId: null,
    userId: USER,
    role: 'employee',
    siteId: SITE,
    deviceId: 'EDGE-TAB-01',
    reportId: REPORT,
    eventId: EVENT,
    occurredAt: '2026-09-27T20:00:00.000Z',
    ...overrides,
  };
}

describe('Story 8.9 Task 9.1 damage capture', () => {
  it('builds damage.reported on the damage stream keyed by the report id', () => {
    const event = createDamageReportedEvent(base());
    assert.equal(event.event_id, EVENT);
    assert.equal(event.stream_type, 'damage');
    assert.equal(event.stream_id, REPORT);
    assert.equal(event.event_type, 'damage.reported');
    assert.equal(event.event_version, 1);
    assert.equal(event.idempotency_key, `edge-damage-${EVENT}`);
    assert.equal(event.local_status, 'pending_sync');
    assert.deepEqual(event.payload, {
      report_id: REPORT,
      site_id: SITE,
      reporter_user_id: USER,
      sku: 'PCB-CTRL-01',
      lot_number: 'LOT-7',
      quantity: '4',
      found_at: 'stock',
      bin_code: 'CMF-STORE-A1',
      reason_code: 'DEAD_ON_ARRIVAL',
      reason_note: null,
      photo_attachment_id: PHOTO,
      whole_lot_requested: false,
      replacement_indent_id: null,
    });
    assert.deepEqual(event.metadata.actor, { user_id: USER, role: 'employee', location_id: SITE });
    assert.equal(event.metadata.device_id, 'EDGE-TAB-01');
  });

  it('drops the bin for in-use material, the note for a non-OTHER reason, and an empty lot', () => {
    const event = createDamageReportedEvent(
      base({ foundAt: 'in_use', binCode: 'IGNORED', lotNumber: '  ', reasonNote: 'stray' }),
    );
    assert.equal(event.payload['bin_code'], null);
    assert.equal(event.payload['lot_number'], null);
    assert.equal(event.payload['reason_note'], null);
  });

  it('keeps a trimmed one-line note only for OTHER', () => {
    const event = createDamageReportedEvent(base({ reasonCode: 'OTHER', reasonNote: '  scorched  ' }));
    assert.equal(event.payload['reason_code'], 'OTHER');
    assert.equal(event.payload['reason_note'], 'scorched');
  });

  it('mints report and event ids when not pinned', () => {
    const input = base();
    delete input.reportId;
    delete input.eventId;
    const event = createDamageReportedEvent(input);
    assert.match(event.stream_id, /^[0-9a-f-]{36}$/i);
    assert.equal(event.payload['report_id'], event.stream_id);
    assert.equal(event.idempotency_key, `edge-damage-${event.event_id}`);
  });

  it('pairs a replacement indent: cross-referenced ids, same site, SKU and quantity, urgent today IST', () => {
    const events = createDamageCaptureEvents({
      ...base({ quantity: '2.5' }),
      replacement: {
        indentId: INDENT,
        departmentCode: ' MAINT ',
        businessStream: 'manufacturing',
        itemCategory: 'electronics',
        uom: 'EA',
        reason: 'Replacement for a damage report',
      },
    });
    assert.equal(events.length, 2);
    const [damage, indent] = events as [
      ReturnType<typeof createDamageReportedEvent>,
      ReturnType<typeof createDamageReportedEvent>,
    ];
    // Order matters: the outbox uploads the damage event first.
    assert.equal(damage.event_type, 'damage.reported');
    assert.equal(indent.event_type, 'indent.raised');
    assert.equal(damage.payload['replacement_indent_id'], INDENT);
    assert.equal(indent.stream_id, INDENT);
    assert.equal(indent.payload['indent_id'], INDENT);
    assert.equal(indent.payload['damage_report_id'], REPORT);
    assert.equal(indent.payload['site_id'], damage.payload['site_id']);
    assert.equal(indent.payload['requester_user_id'], USER);
    assert.equal(indent.payload['urgent'], true);
    assert.equal(indent.payload['department_code'], 'MAINT');
    assert.equal(indent.payload['reason'], 'Replacement for a damage report');
    // 20:00Z on the 27th is 01:30 IST on the 28th.
    assert.equal(indent.payload['need_by_date'], '2026-09-28');
    const lines = indent.payload['lines'] as Array<Record<string, unknown>>;
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!['sku'], damage.payload['sku']);
    assert.equal(lines[0]!['requested_qty'], 2.5);
    assert.equal(lines[0]!['uom'], 'EA');
    assert.notEqual(indent.event_id, damage.event_id);
    assert.equal(indent.idempotency_key, `edge-indent-${indent.event_id}`);
  });

  it('without a replacement yields the damage event alone with no indent id', () => {
    const events = createDamageCaptureEvents({ ...base(), replacement: null });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload['replacement_indent_id'], null);
  });

  it('createIndentRaisedEvent carries damage_report_id only when given', () => {
    const common = {
      sku: 'X',
      itemCategory: 'c',
      requestedQty: 1,
      uom: 'EA',
      needByDate: '2026-09-28',
      departmentCode: 'D',
      businessStream: 'b',
      urgent: false,
      userId: USER,
      role: 'employee',
      siteId: SITE,
      deviceId: 'd',
    };
    assert.equal('damage_report_id' in createIndentRaisedEvent(common).payload, false);
    assert.equal(
      createIndentRaisedEvent({ ...common, damageReportId: REPORT }).payload['damage_report_id'],
      REPORT,
    );
  });

  it('validates the quantity as a positive decimal string', () => {
    for (const ok of ['1', '4', '0.5', '12.125']) assert.equal(isDamageQuantity(ok), true, ok);
    for (const bad of ['', '0', '0.0', '-1', '1e3', 'abc', '01', '1.1234567']) {
      assert.equal(isDamageQuantity(bad), false, bad);
    }
  });

  it('lists the missing parts in form order', () => {
    assert.deepEqual(
      missingDamageParts({
        sku: '',
        foundAt: 'stock',
        binCode: '',
        quantity: '',
        reasonCode: null,
        reasonNote: '',
        hasPhoto: false,
        wholeLotRequested: true,
        lotNumber: '',
        replacement: true,
        departmentCode: '',
        businessStream: '',
        itemCategory: '',
        uom: '',
      }),
      ['sku', 'bin', 'quantity', 'reason', 'photo', 'lot', 'replacement'],
    );
    assert.deepEqual(
      missingDamageParts({
        sku: 'X',
        foundAt: 'in_use',
        binCode: '',
        quantity: '1',
        reasonCode: 'OTHER',
        reasonNote: '',
        hasPhoto: true,
        wholeLotRequested: false,
        lotNumber: '',
        replacement: false,
        departmentCode: '',
        businessStream: '',
        itemCategory: '',
        uom: '',
      }),
      ['note'],
    );
  });
});

describe('Story 8.9 Task 9.2 photo uploader', () => {
  it('classifies server answers', () => {
    assert.equal(classifyUploadResponse(201, null), 'stored');
    assert.equal(classifyUploadResponse(200, null), 'stored');
    assert.equal(classifyUploadResponse(409, 'ATTACHMENT_CONFLICT'), 'stored');
    assert.equal(classifyUploadResponse(413, 'PAYLOAD_TOO_LARGE'), 'reencode');
    assert.equal(classifyUploadResponse(415, 'ATTACHMENT_TYPE_INVALID'), 'reencode');
    assert.equal(classifyUploadResponse(500, null), 'retry');
    assert.equal(classifyUploadResponse(401, null), 'retry');
    assert.equal(classifyUploadResponse(403, 'MODULE_ACCESS_DENIED'), 'retry');
    assert.equal(MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
  });

  function memoryStore(photos: PendingPhoto[]): PendingPhotoStore & { removed: string[] } {
    const removed: string[] = [];
    return {
      removed,
      put: async (photo) => {
        photos.push(photo);
      },
      list: async () => [...photos],
      remove: async (id) => {
        removed.push(id);
      },
    };
  }

  function photo(id: string, owner = USER, type = 'image/jpeg', size = 16): PendingPhoto {
    return {
      attachmentId: id,
      blob: new Blob([new Uint8Array(size)], { type }),
      contentType: type,
      ownerUserId: owner,
      createdAt: '2026-09-27T10:00:00.000Z',
    };
  }

  it('PUTs the raw bytes with the file type, deletes on success, keeps on failure, skips other owners', async () => {
    const store = memoryStore([
      photo('a'),
      photo('b', USER, 'image/png'),
      photo('c', 'someone-else'),
    ]);
    const calls: Array<{ url: string; method: string | undefined; type: string | null; size: number }> = [];
    const result = await uploadPendingPhotos({
      store,
      ownerUserId: USER,
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body as Blob;
        calls.push({
          url,
          method: init?.method,
          type: new Headers(init?.headers).get('Content-Type'),
          size: body.size,
        });
        return new Response('{}', { status: url.endsWith('/a') ? 201 : 503 });
      },
    });
    assert.deepEqual(calls, [
      { url: '/api/v1/attachments/a', method: 'PUT', type: 'image/jpeg', size: 16 },
      { url: '/api/v1/attachments/b', method: 'PUT', type: 'image/png', size: 16 },
    ]);
    assert.deepEqual(store.removed, ['a']);
    assert.deepEqual(result, { stored: 1, pending: 1 });
  });

  it('re-encodes only a photo above the request limit, or of a type the server refuses', async () => {
    const store = memoryStore([
      photo('big', USER, 'image/jpeg', MAX_UPLOAD_BYTES + 1),
      photo('gif', USER, 'image/gif'),
      photo('ok', USER, 'image/webp'),
    ]);
    const reencoded: string[] = [];
    const sent: Array<[string, string | null]> = [];
    await uploadPendingPhotos({
      store,
      ownerUserId: USER,
      reencode: async (blob) => {
        reencoded.push(blob.type);
        return new Blob([new Uint8Array(8)], { type: 'image/jpeg' });
      },
      fetch: async (input, init) => {
        sent.push([String(input), new Headers(init?.headers).get('Content-Type')]);
        return new Response('{}', { status: 201 });
      },
    });
    assert.deepEqual(reencoded, ['image/jpeg', 'image/gif']);
    assert.deepEqual(sent, [
      ['/api/v1/attachments/big', 'image/jpeg'],
      ['/api/v1/attachments/gif', 'image/jpeg'],
      ['/api/v1/attachments/ok', 'image/webp'],
    ]);
    assert.deepEqual(store.removed, ['big', 'gif', 'ok']);
  });

  it('a network failure leaves the photo queued for the next pass', async () => {
    const store = memoryStore([photo('a')]);
    const result = await uploadPendingPhotos({
      store,
      ownerUserId: USER,
      fetch: async () => {
        throw new TypeError('offline');
      },
    });
    assert.deepEqual(store.removed, []);
    assert.deepEqual(result, { stored: 0, pending: 1 });
  });
});

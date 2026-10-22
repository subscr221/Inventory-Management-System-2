import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeWeighment,
  createGateEnteredEvent,
  createWeighbridgeRecordedEvent,
  isGateReady,
  isKilogram,
  isToleranceBreach,
  milliToKg,
  missingGateParts,
  parseKgToMilli,
  type GateCaptureInput,
  type GateFormSnapshot,
} from '../../src/capture/gate';
import { uploadPendingPhotos } from '../../src/sync/attachment-uploader';
import type { PendingPhoto, PendingPhotoStore } from '../../src/local-db/pending-photos';
import * as gate from '../../src/capture/gate';

const USER = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

function base(overrides: Partial<GateCaptureInput> = {}): GateCaptureInput {
  return {
    challanNumberExt: 'CH-1',
    poRefExt: 'PO-1',
    challanPhotoRef: 'photo-ref-1',
    vehicleRegExt: ' ka01ab1234 ',
    driverName: ' Ravi ',
    supplierRefExt: 'SUP-1',
    supplierNameUnlisted: null,
    siteCodeExt: 'site-A',
    gateId: 'GATE-01',
    userId: USER,
    role: 'gate_officer',
    siteId: SITE,
    deviceId: 'EDGE-GATE-01',
    eventId: '55555555-5555-4555-8555-555555555555',
    correlationId: '77777777-7777-4777-8777-777777777777',
    occurredAt: '2026-10-21T06:00:00.000Z',
    ...overrides,
  };
}

describe('Story 3.13 gate capture', () => {
  it('builds one gate.entered envelope with the binding token as correlation_id', () => {
    const event = createGateEnteredEvent(base());
    assert.equal(event.stream_type, 'gate');
    assert.equal(event.event_type, 'gate.entered');
    assert.equal(event.event_id, '55555555-5555-4555-8555-555555555555');
    assert.equal(event.metadata.correlation_id, '77777777-7777-4777-8777-777777777777');
    assert.equal(event.local_status, 'pending_sync');
    assert.equal(event.idempotency_key, 'edge-gate-55555555-5555-4555-8555-555555555555');
    const payload = event.payload;
    assert.equal(payload['vehicle_reg_ext'], 'KA01AB1234');
    assert.equal(payload['gate_id'], 'GATE-01');
    assert.equal(payload['site_code_ext'], 'site-A');
    assert.equal(payload['gate_officer_id'], USER);
    assert.equal(payload['driver_name'], 'Ravi');
    assert.equal(payload['supplier_ref_ext'], 'SUP-1');
    assert.equal(payload['supplier_name_unlisted'], null);
  });

  it('records the unlisted supplier name and leaves the code null when typing a name', () => {
    const event = createGateEnteredEvent(
      base({ supplierRefExt: null, supplierNameUnlisted: ' Acme Traders ' }),
    );
    assert.equal(event.payload['supplier_ref_ext'], null);
    assert.equal(event.payload['supplier_name_unlisted'], 'Acme Traders');
    assert.equal(event.payload['po_ref_ext'], 'PO-1');
  });

  it('defaults a missing PO reference to UNKNOWN', () => {
    const event = createGateEnteredEvent(base({ poRefExt: '   ' }));
    assert.equal(event.payload['po_ref_ext'], 'UNKNOWN');
  });

  it('reports the missing parts in step order and readiness', () => {
    const empty: GateFormSnapshot = {
      challanResolved: false,
      challanNumber: '',
      hasPhoto: false,
      vehicleReg: '',
      supplierResolved: false,
      supplierNameUnlisted: '',
    };
    assert.deepEqual(missingGateParts(empty), ['challan', 'photo', 'vehicle', 'supplier']);
    assert.equal(isGateReady(empty), false);
    const ready: GateFormSnapshot = {
      challanResolved: true,
      challanNumber: '',
      hasPhoto: true,
      vehicleReg: 'KA01AB1234',
      supplierResolved: true,
      supplierNameUnlisted: '',
    };
    assert.deepEqual(missingGateParts(ready), []);
    assert.equal(isGateReady(ready), true);
  });

it('does not confuse an edited or unaccepted scanned code with a typed resolution', () => {
    const form: GateFormSnapshot = {
      challanResolved: false,
challanNumber: 'CH-9',
hasPhoto: true,
vehicleReg: 'KA01AB1234',
supplierResolved: true,
      supplierNameUnlisted: 'Acme',
    };
assert.deepEqual(missingGateParts(form), ['challan']);
});
});

describe('Story 3.13 challan resolution and step gating', () => {
it('resolves an ASN first, then fetches its PO vendor rather than trusting the ASN vendor', async () => {
const calls: string[] = [];
const lookup = gate.createGateLookup(async (url) => {
calls.push(String(url));
return Response.json(calls.length === 1
? { po_ref_ext: 'PO-9', supplier_ref_ext: 'WRONG' }
: { po_number_ext: 'PO-9', supplier_ref_ext: 'SUP-9' });
});
assert.deepEqual(await lookup.resolve(' ASN/9 '), {
kind: 'match', poRefExt: 'PO-9', supplierRefExt: 'SUP-9',
});
assert.deepEqual(calls, ['/api/v1/asn/ASN%2F9', '/api/v1/erp/purchase-orders/PO-9']);
});

it('tries the scanned code as a PO only when the ASN is not found', async () => {
const calls: string[] = [];
const lookup = gate.createGateLookup(async (url) => {
calls.push(String(url));
return calls.length === 1 ? new Response(null, { status: 404 })
: Response.json({ po_number_ext: 'PO-1', supplier_ref_ext: 'SUP-1' });
});
assert.equal((await lookup.resolve('PO-1'))?.kind, 'match');
assert.deepEqual(calls, ['/api/v1/asn/PO-1', '/api/v1/erp/purchase-orders/PO-1']);
});

it('reports missing, offline, denied and malformed responses without fabricating a match', async () => {
for (const response of [new Response(null, { status: 403 }), Response.json({}), new Response(null, { status: 500 })]) {
let calls = 0;
const lookup = gate.createGateLookup(async () => { calls++; return response; });
assert.deepEqual(await lookup.resolve('X'), { kind: 'unavailable' });
assert.equal(calls, 1);
}
assert.deepEqual(await gate.createGateLookup(async () => new Response(null, { status: 404 })).resolve('X'), { kind: 'not-found' });
assert.deepEqual(await gate.createGateLookup(async () => { throw new TypeError('offline'); }).resolve('X'), { kind: 'unavailable' });
});

it('ignores obsolete responses after editing a code or starting another scan', async () => {
let finish!: (value: Response) => void;
let calls = 0;
const lookup = gate.createGateLookup(async () => {
calls++;
if (calls === 1) return new Promise<Response>((resolve) => { finish = resolve; });
return Response.json({ po_number_ext: 'NEW', supplier_ref_ext: 'SUP-NEW' });
});
const old = lookup.resolve('OLD');
lookup.invalidate();
finish(Response.json({ po_ref_ext: 'OLD-PO' }));
assert.equal(await old, null);
assert.equal(calls, 1);
const newer = await lookup.resolve('NEW');
assert.deepEqual(newer, { kind: 'unavailable' });
});

it('explicit typed/rejected fallback never binds a PO or a supplier', () => {
for (const kind of ['typed', 'rejected'] as const) {
assert.deepEqual(gate.gateChallanBinding(kind), { poRefExt: 'UNKNOWN', supplierRefExt: '' });
}
assert.deepEqual(gate.gateChallanBinding({ kind: 'match', poRefExt: 'PO-9', supplierRefExt: 'SUP-9' }), { poRefExt: 'PO-9', supplierRefExt: 'SUP-9' });
});

it('lets a newer scan finish without an older PO response overwriting it', async () => {
let finishOld!: (value: Response) => void;
let oldRequested!: () => void;
const oldStarted = new Promise<void>((resolve) => { oldRequested = resolve; });
const lookup = gate.createGateLookup(async (url) => {
const path = String(url);
if (path.includes('/asn/')) return new Response(null, { status: 404 });
if (path.endsWith('/OLD')) {
oldRequested();
return new Promise<Response>((resolve) => { finishOld = resolve; });
}
return Response.json({ po_number_ext: 'NEW', supplier_ref_ext: 'SUP-NEW' });
});
const old = lookup.resolve('OLD');
await oldStarted;
assert.deepEqual(await lookup.resolve('NEW'), { kind: 'match', poRefExt: 'NEW', supplierRefExt: 'SUP-NEW' });
finishOld(Response.json({ po_number_ext: 'OLD', supplier_ref_ext: 'SUP-OLD' }));
assert.equal(await old, null);
});

it('does not turn a PO without a supplier into a ready matched supplier', async () => {
let calls = 0;
const lookup = gate.createGateLookup(async () => ++calls === 1
? new Response(null, { status: 404 })
: Response.json({ po_number_ext: 'PO-1', supplier_ref_ext: ' ' }));
const result = await lookup.resolve('PO-1');
assert.equal(result?.kind, 'match');
if (result?.kind === 'match') assert.equal(gate.isGateSupplierReady('matched', result.supplierRefExt, 'Old unlisted name'), false);
const form: GateFormSnapshot = { challanResolved: true, challanNumber: 'PO-1', hasPhoto: true, vehicleReg: 'KA01', supplierResolved: false, supplierNameUnlisted: 'Old unlisted name' };
assert.deepEqual(missingGateParts(form), ['supplier']);
});

it('requires a nonempty matched vendor or a named unlisted supplier and gates each step independently', () => {
assert.equal(gate.isGateSupplierReady('matched', ' ', 'Ignored'), false);
assert.equal(gate.isGateSupplierReady('matched', 'SUP-9', ''), true);
assert.equal(gate.isGateSupplierReady('unlisted', 'SUP-9', ' '), false);
assert.equal(gate.isGateSupplierReady('unlisted', '', ' Acme '), true);
const form: GateFormSnapshot = { challanResolved: false, challanNumber: 'X', hasPhoto: false, vehicleReg: '', supplierResolved: false, supplierNameUnlisted: '' };
assert.equal(gate.isGateStepReady('challan', form), false);
assert.equal(gate.isGateStepReady('photo', form), false);
assert.equal(gate.isGateStepReady('vehicle', form), false);
assert.equal(gate.isGateStepReady('supplier', form), false);
assert.equal(gate.isGateStepReady('challan', { ...form, challanResolved: true }), true);
assert.equal(gate.isGateStepReady('photo', { ...form, hasPhoto: true }), true);
assert.equal(gate.isGateStepReady('vehicle', { ...form, vehicleReg: 'KA01' }), true);
assert.equal(gate.isGateStepReady('supplier', { ...form, supplierResolved: true }), true);
});
});

describe('Story 3.13 weighbridge capture', () => {
  it('parses and renders kilogram values exactly', () => {
    assert.equal(isKilogram('3500'), true);
    assert.equal(isKilogram('3500.5'), true);
    assert.equal(isKilogram('3500.1234'), false);
    assert.equal(isKilogram('-1'), false);
    assert.equal(parseKgToMilli('3500.5'), 3_500_500n);
    assert.equal(milliToKg(3_500_500n), '3500.500');
  });

  it('computes net = gross - tare exactly', () => {
    const result = computeWeighment('3500.250', '1500.000');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.weighment.netKg, '2000.250');
    }
  });

  it('refuses a tare greater than gross with WEIGHBRIDGE_NET_NEGATIVE', () => {
    const result = computeWeighment('1000', '1500');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorCode, 'WEIGHBRIDGE_NET_NEGATIVE');
  });

  it('flags a provisional tolerance breach outside the band', () => {
    const band = {
      orderedQty: 100,
      overReceiptTolerancePct: 5,
      underReceiptTolerancePct: 5,
    };
    assert.equal(isToleranceBreach({ netKg: '100', ...band }), false);
    assert.equal(isToleranceBreach({ netKg: '106', ...band }), true);
    assert.equal(isToleranceBreach({ netKg: '94', ...band }), true);
  });

  it('builds one weighbridge.recorded envelope carrying the gate binding token', () => {
    const event = createWeighbridgeRecordedEvent({
      correlationId: '77777777-7777-4777-8777-777777777777',
      poRefExt: 'PO-1',
      lineNo: 1,
      grossKg: '3500',
      tareKg: '1500',
      siteCodeExt: 'site-A',
      deviceId: 'WB-1',
      userId: USER,
      role: 'weighbridge_operator',
      siteId: SITE,
      captureMethod: 'MANUAL',
      eventId: '88888888-8888-4888-8888-888888888888',
      occurredAt: '2026-10-21T06:30:00.000Z',
    });
    assert.ok('event_type' in event);
    if ('event_type' in event) {
      assert.equal(event.event_type, 'weighbridge.recorded');
      assert.equal(event.metadata.correlation_id, '77777777-7777-4777-8777-777777777777');
      assert.equal(event.payload['gross_kg'], '3500.000');
      assert.equal(event.payload['tare_kg'], '1500.000');
      assert.equal(event.payload['capture_method'], 'MANUAL');
      assert.equal(event.payload['weighed_by'], USER);
    }
  });

  it('returns the refusal code instead of an envelope when the net is negative', () => {
    const result = createWeighbridgeRecordedEvent({
      correlationId: '77777777-7777-4777-8777-777777777777',
      poRefExt: 'PO-1',
      lineNo: 1,
      grossKg: '1000',
      tareKg: '1500',
      siteCodeExt: 'site-A',
      deviceId: 'WB-1',
      userId: USER,
      role: 'weighbridge_operator',
      siteId: SITE,
      captureMethod: 'MANUAL',
    });
    assert.deepEqual(result, { errorCode: 'WEIGHBRIDGE_NET_NEGATIVE' });
  });
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

function gatePhoto(id: string): PendingPhoto {
  return {
    attachmentId: id,
    blob: new Blob([new Uint8Array(16)], { type: 'image/jpeg' }),
    contentType: 'image/jpeg',
    ownerUserId: USER,
    createdAt: '2026-10-21T06:00:00.000Z',
  };
}

describe('Story 3.13 offline gate photo outbox (Task 4.2)', () => {
  it('holds the gate photo while offline and clears the pending row on upload success', async () => {
    const store = memoryStore([gatePhoto('gate-photo-1')]);

    // Offline: the upload throws, the photo stays queued, the gate entry still references it.
    const offline = await uploadPendingPhotos({
      store,
      ownerUserId: USER,
      fetch: async () => {
        throw new TypeError('offline');
      },
    });
    assert.deepEqual(offline, { stored: 0, pending: 1 });
    assert.deepEqual(store.removed, []);

    // Online: the same row uploads and is cleared.
    const online = await uploadPendingPhotos({
      store,
      ownerUserId: USER,
      fetch: async () => new Response('{}', { status: 201 }),
    });
    assert.deepEqual(online, { stored: 1, pending: 0 });
    assert.deepEqual(store.removed, ['gate-photo-1']);
  });
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { getAdminPool, getPool, closeAdminPool, closePool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { assertSingleHubCustomerRef } from '../../src/compliance/hub-customer.js';
import { runHubBookingExceptionJob } from '../../src/hub/booking-jobs.js';

// Story 10.4 (FR-RD-13, FR-RD-14): hub customers, machine-time booking, meter feed, 24h exception.
// Production router, real auth/RBAC and PostgreSQL; no mocks of the DB or the event store.
// Every test seeds its own customer / machine / asset / meter with run-unique codes and shares no
// rows with another test, so order does not matter and no shared table is truncated. A booking can
// only be backdated up to 12 hours (with a reason), so tests that need elapsed machine time or an
// overdue booking move opened_at with a direct UPDATE (the `backdate` helper).

const __dirname = dirname(fileURLToPath(import.meta.url));
const run = randomUUID().slice(0, 8);
const SCIM = { Authorization: `Bearer ${process.env.SCIM_BEARER_TOKEN ?? ''}` };
type Body = Record<string, unknown>;
type Response = { status: number; body: Body };
type Headers = Record<string, string>;
const MINUTE = 60_000;

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolveRequest, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          let parsed: Body = {};
          try {
            if (text) parsed = JSON.parse(text) as Body;
          } catch {
            parsed = { text };
          }
          resolveRequest({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Story 10.4 hub customers, machine-time booking, meter feed and 24h exception', () => {
  let server: Server;
  let port: number;
  let headers: Headers;
  let readOnlyHeaders: Headers;
  let scopedHeaders: Headers;
  let researchHeaders: Headers;
  const site = randomUUID();
  const hubBin = randomUUID();
  const otherBin = randomUUID();
  const stdBin = randomUUID();
  const operatorRole = `hub_operator_${run}`;
  let seq = 0;

  const call = (method: string, path: string, body?: unknown, h: Headers = headers): Promise<Response> =>
    request(port, method, path, body, h);
  const post = (path: string, body: unknown, h: Headers = headers): Promise<Response> =>
    call('POST', path, body, h);
  const get = (path: string, h: Headers = headers): Promise<Response> => call('GET', path, undefined, h);
  const pick = (r: Response, key: string, field: string): string => (r.body[key] as Body)[field] as string;

  async function provision(label: string, roles: Body[]): Promise<Headers> {
    const email = `story104-${label}-${run}@example.com`;
    const provisioned = await request(
      port,
      'POST',
      '/api/v1/scim/v2/Users',
      { externalId: email, email, displayName: email, roles },
      SCIM,
    );
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
    const tok = await request(port, 'POST', '/api/v1/auth/dev-token', { sub: email });
    return { Authorization: `Bearer ${tok.body['token'] as string}` };
  }

  async function seedCustomer(kind: 'member' | 'walk_in' = 'member', extra: Body = {}): Promise<string> {
    const n = ++seq;
    const r = await post(
      '/api/v1/hub-customers',
      kind === 'member'
        ? { customer_kind: 'member', display_name: `Member ${n}`, membership_no: `M-${run}-${n}`, ...extra }
        : { customer_kind: 'walk_in', display_name: `Walk-in ${n}`, ...extra },
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return pick(r, 'customer', 'customer_id');
  }

  /** Own asset (+ optional meter) + machine. `via` picks how the meter is attached to the machine. */
  async function seedMachine(
    opts: { metered?: boolean; via?: 'register' | 'link'; location?: string } = {},
  ): Promise<{ machineId: string; assetId: string; meterId: string | undefined; code: string }> {
    const { metered = true, via = 'link', location = hubBin } = opts;
    const n = ++seq;
    const asset = await post('/api/v1/assets', {
      asset_tag: `TAG-104-${run}-${n}`,
      asset_name: `Machine ${run}-${n}`,
      criticality_class: 'high',
    });
    assert.equal(asset.status, 201, JSON.stringify(asset.body));
    const assetId = pick(asset, 'asset', 'asset_id');
    let meterId: string | undefined;
    if (metered) {
      const meter = await post('/api/v1/maintenance/meters', {
        asset_id: assetId,
        meter_code: `HRS-104-${run}-${n}`,
        unit: 'hours',
        alert_role: operatorRole,
      });
      assert.equal(meter.status, 201, JSON.stringify(meter.body));
      meterId = pick(meter, 'meter', 'meter_id');
    }
    const code = `M-${run}-${n}`;
    const reg = await post('/api/v1/hub-machines', {
      machine_code: code,
      location_id: location,
      asset_id: assetId,
      operator_role: operatorRole,
      ...(metered && via === 'register' ? { meter_id: meterId } : {}),
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const machineId = pick(reg, 'machine', 'machine_id');
    if (metered && via === 'link') {
      const linked = await post(`/api/v1/hub-machines/${machineId}/meter`, { meter_id: meterId });
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      assert.equal(pick(linked, 'machine', 'meter_id'), meterId);
    }
    return { machineId, assetId, meterId, code };
  }

  const openOn = (machineId: string, customerId: string, extra: Body = {}): Promise<Response> =>
    post('/api/v1/hub-bookings', { customer_id: customerId, machine_id: machineId, ...extra });

  /** Moves opened_at into the past by direct UPDATE: the API (rightly) refuses client backdating. */
  async function backdate(bookingId: string, seconds: number): Promise<void> {
    await getPool().query(
      'UPDATE hub_booking SET opened_at = now() - make_interval(secs => $2::double precision) WHERE booking_id = $1',
      [bookingId, seconds],
    );
  }

  /** An open booking on its own metered machine, opened `hoursAgo` hours back. */
  async function seedOpenBooking(hoursAgo: number): Promise<{ bookingId: string; machineId: string; meterId: string }> {
    const m = await seedMachine();
    const opened = await openOn(m.machineId, await seedCustomer());
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const bookingId = pick(opened, 'booking', 'booking_id');
    if (hoursAgo > 0) await backdate(bookingId, hoursAgo * 3600);
    return { bookingId, machineId: m.machineId, meterId: m.meterId! };
  }

  before(async () => {
    const admin = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      ...[
        'users',
        'audit_log',
        'doa_registry',
        'business_stream_config',
        'location',
        'instrument_calibration',
        'notification',
        'location_register',
        'asset',
        'asset_meter',
        'asset_meter_reading',
        'hub_customer',
        'hub_machine',
        'hub_booking',
      ].map((p) => `../../read/projections/${p}.sql`),
    ])
      await admin.query(readFileSync(resolve(__dirname, file), 'utf8'));
    server = createAppServer(createAppRouter());
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, () => {
        server.off('error', rejectListen);
        port = (server.address() as AddressInfo).port;
        resolveListen();
      });
    });
    const pool = getPool();
    await pool.query(
      "INSERT INTO location_register (location_id,location_code,level,parent_location_id,site_id,zone_type,temperature_class,status) VALUES ($1,$2,'site',NULL,$1,'general','ambient','active')",
      [site, `SITE-104-${run}`],
    );
    for (const [id, code, type] of [
      [hubBin, `HUB-104-${run}`, 'maker_hub_store'],
      [otherBin, `HUB2-104-${run}`, 'maker_hub_store'],
      [stdBin, `STD-104-${run}`, 'standard'],
    ] as const)
      await pool.query(
        `INSERT INTO location_register (location_id,location_code,level,parent_location_id,site_id,zone_type,temperature_class,status,location_type)
         VALUES ($1,$2,'bin',$3,$3,'general','ambient','active',$4)`,
        [id, code, site, type],
      );
    headers = await provision('staff', [
      { role: `hub_staff_${run}`, module: 'engineering', functionScope: 'write', locationId: '*' },
      { role: `hub_maint_${run}`, module: 'maintenance', functionScope: 'write', locationId: '*' },
    ]);
    readOnlyHeaders = await provision('reader', [
      { role: `hub_reader_${run}`, module: 'engineering', functionScope: 'read', locationId: '*' },
    ]);
    scopedHeaders = await provision('scoped', [
      { role: `hub_scoped_${run}`, module: 'engineering', functionScope: 'write', locationId: otherBin },
    ]);
    researchHeaders = await provision('research', [
      { role: `hub_research_${run}`, module: 'research', functionScope: 'write', locationId: '*' },
    ]);
  });

  after(async () => {
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    await closePool();
    await closeAdminPool();
  });

  it('AC1: member and walk-in records are maintained; membership_no rules hold; no contact field exists', async () => {
    const n = ++seq;
    const membershipNo = `M-${run}-${n}`;
    const phone = `+91${Date.now()}${n}`;
    const member = await post('/api/v1/hub-customers', {
      customer_kind: 'member',
      display_name: 'Asha Rao',
      membership_no: membershipNo,
      contact_phone: phone,
    });
    assert.equal(member.status, 201, JSON.stringify(member.body));
    const memberId = pick(member, 'customer', 'customer_id');
    const walkInId = await seedCustomer('walk_in');
    const row = member.body['customer'] as Body;
    assert.equal(row['membership_no'], membershipNo);
    // X5: phone capture is deferred; no contact field is stored, returned or put in an event.
    const noContact = (r: Body): boolean => !Object.keys(r).some((k) => k.startsWith('contact'));
    assert.ok(noContact(row), 'no contact field in the create response');
    const all = (await get('/api/v1/hub-customers')).body['rows'] as Body[];
    assert.ok(all.every(noContact), 'no contact field in any list row');
    assert.equal(all.find((r) => r['customer_id'] === walkInId)!['membership_no'], null);
    const leaked = await getPool().query(
      'SELECT count(*)::int AS n FROM domain_events WHERE payload::text LIKE $1',
      [`%${phone}%`],
    );
    assert.equal(leaked.rows[0]!['n'], 0, 'the raw number never reaches the event store');

    const noNo = await post('/api/v1/hub-customers', { customer_kind: 'member', display_name: 'X' });
    assert.equal(noNo.status, 400, JSON.stringify(noNo.body));
    const walkWithNo = await post('/api/v1/hub-customers', {
      customer_kind: 'walk_in',
      display_name: 'Y',
      membership_no: 'M-nope',
    });
    assert.equal(walkWithNo.status, 400, JSON.stringify(walkWithNo.body));
    // P-H: a blank membership_no on a walk-in is absent, not an error.
    for (const blank of ['', '   ']) {
      const walkBlank = await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'Blank', membership_no: blank });
      assert.equal(walkBlank.status, 201, JSON.stringify(walkBlank.body));
      assert.equal(pick(walkBlank, 'customer', 'membership_no'), null);
    }
    const dup = await post('/api/v1/hub-customers', {
      customer_kind: 'member',
      display_name: 'Dup',
      membership_no: membershipNo,
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(dup.body['error_code'], 'HUB_DUPLICATE_RECORD');
    // P-K: case and surrounding spaces do not make a different membership_no.
    for (const variant of [membershipNo.toLowerCase(), ` ${membershipNo.toUpperCase()} `]) {
      const caseDup = await post('/api/v1/hub-customers', { customer_kind: 'member', display_name: 'Dup2', membership_no: variant });
      assert.equal(caseDup.status, 409, JSON.stringify(caseDup.body));
      assert.equal(caseDup.body['error_code'], 'HUB_DUPLICATE_RECORD');
    }

    const ids = all.map((r) => r['customer_id']);
    assert.ok(ids.includes(memberId) && ids.includes(walkInId));

    // The seam is the gate: a direct event carrying a phone (raw or hashed) is refused.
    for (const extra of [{ contact_phone: phone }, { contact_phone_hash: 'a'.repeat(64) }])
      await assert.rejects(
        persistEvent({
          stream_type: 'research',
          stream_id: randomUUID(),
          event_type: 'hub.customer_registered',
          payload: { customer_id: randomUUID(), customer_kind: 'walk_in', display_name: 'Direct', ...extra },
          metadata: {
            correlation_id: randomUUID(),
            occurred_at: new Date().toISOString(),
            actor: { user_id: randomUUID(), role: 'x', location_id: '*' },
          },
          idempotency_key: randomUUID(),
        } as never),
        { errorCode: 'INVALID_PARAMS' },
      );
  });

  it('P6: a customer location must exist and be a hub (maker_hub_store) location', async () => {
    const base = { customer_kind: 'walk_in', display_name: 'Located' };
    const ok = await post('/api/v1/hub-customers', { ...base, location_id: hubBin });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(pick(ok, 'customer', 'location_id'), hubBin);
    const std = await post('/api/v1/hub-customers', { ...base, location_id: stdBin });
    assert.equal(std.status, 400, JSON.stringify(std.body));
    assert.equal(std.body['error_code'], 'INVALID_PARAMS');
    const missing = await post('/api/v1/hub-customers', { ...base, location_id: randomUUID() });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body['error_code'], 'LOCATION_NOT_FOUND');
  });

  it('machine registration validates location type, asset, meter ownership and uniqueness', async () => {
    const n = ++seq;
    const base = { machine_code: `BAD-${run}-${n}`, operator_role: operatorRole };
    const wrongLoc = await post('/api/v1/hub-machines', { ...base, location_id: stdBin, asset_id: randomUUID() });
    assert.equal(wrongLoc.status, 400, JSON.stringify(wrongLoc.body));
    const noAsset = await post('/api/v1/hub-machines', { ...base, location_id: hubBin, asset_id: randomUUID() });
    assert.equal(noAsset.status, 404, JSON.stringify(noAsset.body));
    assert.equal(noAsset.body['error_code'], 'ASSET_NOT_FOUND');

    // Meter ownership: a meter of another asset is refused at registration and at link time.
    const owner = await seedMachine({ metered: true, via: 'register' });
    const other = await seedMachine({ metered: false });
    const mismatchRegister = await post('/api/v1/hub-machines', {
      ...base,
      machine_code: `BAD2-${run}-${n}`,
      location_id: hubBin,
      asset_id: other.assetId,
      meter_id: owner.meterId,
    });
    assert.equal(mismatchRegister.status, 400, JSON.stringify(mismatchRegister.body));
    assert.equal(mismatchRegister.body['error_code'], 'INVALID_PARAMS');
    const mismatchLink = await post(`/api/v1/hub-machines/${other.machineId}/meter`, { meter_id: owner.meterId });
    assert.equal(mismatchLink.status, 400, JSON.stringify(mismatchLink.body));
    const unknownMeter = await post(`/api/v1/hub-machines/${other.machineId}/meter`, { meter_id: randomUUID() });
    assert.equal(unknownMeter.status, 404, JSON.stringify(unknownMeter.body));
    assert.equal(unknownMeter.body['error_code'], 'METER_NOT_FOUND');
    const unknownMachine = await post(`/api/v1/hub-machines/${randomUUID()}/meter`, { meter_id: owner.meterId });
    assert.equal(unknownMachine.status, 404, JSON.stringify(unknownMachine.body));
    assert.equal(unknownMachine.body['error_code'], 'HUB_MACHINE_NOT_FOUND');

    // P3: one machine per asset.
    const dupAsset = await post('/api/v1/hub-machines', {
      ...base,
      machine_code: `BAD3-${run}-${n}`,
      location_id: hubBin,
      asset_id: owner.assetId,
    });
    assert.equal(dupAsset.status, 409, JSON.stringify(dupAsset.body));
    assert.equal(dupAsset.body['error_code'], 'HUB_DUPLICATE_RECORD');
  });

  it('P-E/P-K: uppercase asset and meter ids are accepted and stored lowercase; machine_code is case-insensitively unique', async () => {
    const m = await seedMachine({ metered: false });
    const fresh = await seedMachine({ metered: false });
    const meter = await post('/api/v1/maintenance/meters', {
      asset_id: fresh.assetId,
      meter_code: `HRS-UP-${run}-${++seq}`,
      unit: 'hours',
      alert_role: operatorRole,
    });
    const meterId = pick(meter, 'meter', 'meter_id');
    const link = await post(`/api/v1/hub-machines/${fresh.machineId}/meter`, { meter_id: meterId.toUpperCase() });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.equal(pick(link, 'machine', 'meter_id'), meterId);

    const asset = await post('/api/v1/assets', { asset_tag: `TAG-UP-${run}-${++seq}`, asset_name: 'Upper', criticality_class: 'low' });
    const assetId = pick(asset, 'asset', 'asset_id');
    const ownMeter = await post('/api/v1/maintenance/meters', { asset_id: assetId, meter_code: `HRS-UQ-${run}-${seq}`, unit: 'hours', alert_role: operatorRole });
    const ownMeterId = pick(ownMeter, 'meter', 'meter_id');
    const reg = await post('/api/v1/hub-machines', {
      machine_code: `UP-${run}-${seq}`,
      location_id: hubBin,
      asset_id: assetId.toUpperCase(),
      meter_id: ownMeterId.toUpperCase(),
      operator_role: operatorRole,
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(pick(reg, 'machine', 'asset_id'), assetId);
    assert.equal(pick(reg, 'machine', 'meter_id'), ownMeterId);

    const spare = await post('/api/v1/assets', { asset_tag: `TAG-CC-${run}-${++seq}`, asset_name: 'Case', criticality_class: 'low' });
    const caseDup = await post('/api/v1/hub-machines', {
      machine_code: ` ${m.code.toLowerCase()} `,
      location_id: hubBin,
      asset_id: pick(spare, 'asset', 'asset_id'),
      operator_role: operatorRole,
    });
    assert.equal(caseDup.status, 409, JSON.stringify(caseDup.body));
    assert.equal(caseDup.body['error_code'], 'HUB_DUPLICATE_RECORD');
  });

  it('X6: operator_role must be 1 to 64 letters, digits, underscores or hyphens', async () => {
    const spareAsset = async (): Promise<string> =>
      pick(await post('/api/v1/assets', { asset_tag: `TAG-OR-${run}-${++seq}`, asset_name: 'Role', criticality_class: 'low' }), 'asset', 'asset_id');
    for (const bad of ['', '   ', 'has space', 'semi;colon', 'x'.repeat(65), 'rôle']) {
      const r = await post('/api/v1/hub-machines', {
        machine_code: `OR-${run}-${++seq}`,
        location_id: hubBin,
        asset_id: await spareAsset(),
        operator_role: bad,
      });
      assert.equal(r.status, 400, JSON.stringify([bad, r.body]));
      assert.equal(r.body['error_code'], 'INVALID_PARAMS');
    }
    const ok = await post('/api/v1/hub-machines', {
      machine_code: `OR-${run}-${++seq}`,
      location_id: hubBin,
      asset_id: await spareAsset(),
      operator_role: 'x'.repeat(64),
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it('D2: the meter link is idempotent, refuses a second different meter, and gates the close', async () => {
    const m = await seedMachine({ metered: false });
    const meter = await post('/api/v1/maintenance/meters', {
      asset_id: m.assetId,
      meter_code: `HRS-L-${run}-${++seq}`,
      unit: 'hours',
      alert_role: operatorRole,
    });
    const meterId = pick(meter, 'meter', 'meter_id');
    const spare = await post('/api/v1/maintenance/meters', {
      asset_id: m.assetId,
      meter_code: `HRS-S-${run}-${seq}`,
      unit: 'hours',
      alert_role: operatorRole,
    });
    const spareId = pick(spare, 'meter', 'meter_id');

    // P-F: an unmetered machine cannot be booked; the refusal is at open and no booking row is written.
    const customer = await seedCustomer();
    const refused = await openOn(m.machineId, customer);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body['error_code'], 'HUB_MACHINE_NOT_METERED');
    const none = await getPool().query('SELECT count(*)::int AS n FROM hub_booking WHERE machine_id = $1', [m.machineId]);
    assert.equal(none.rows[0]!['n'], 0);

    const key = `link-${run}-${seq}`;
    const first = await post(`/api/v1/hub-machines/${m.machineId}/meter`, { meter_id: meterId, idempotency_key: key });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(pick(first, 'machine', 'meter_id'), meterId);
    const replay = await post(`/api/v1/hub-machines/${m.machineId}/meter`, { meter_id: meterId, idempotency_key: key });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body['event_id'], first.body['event_id']);
    const swap = await post(`/api/v1/hub-machines/${m.machineId}/meter`, { meter_id: spareId });
    assert.equal(swap.status, 409, JSON.stringify(swap.body));
    assert.equal(swap.body['error_code'], 'HUB_DUPLICATE_RECORD');

    const opened = await openOn(m.machineId, customer);
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const bookingId = pick(opened, 'booking', 'booking_id');
    await backdate(bookingId, 3600);
    const closed = await post(`/api/v1/hub-bookings/${bookingId}/close`, { actual_minutes: 5, meter_reading_value: 1 });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
  });

  it('AC2: the single-customer guard rejects zero or several references', async () => {
    const memberId = await seedCustomer();
    const walkInId = await seedCustomer('walk_in');
    const m = await seedMachine();
    const m2 = await seedMachine();
    assert.throws(() => assertSingleHubCustomerRef({}), { errorCode: 'MEMBER_REFERENCE_REQUIRED' });
    assert.throws(() => assertSingleHubCustomerRef({ member_id: memberId, walk_in_id: walkInId }), {
      errorCode: 'MEMBER_REFERENCE_REQUIRED',
    });
    assert.throws(() => assertSingleHubCustomerRef({ customer_ids: [] }), {
      errorCode: 'MEMBER_REFERENCE_REQUIRED',
    });
    assert.equal(assertSingleHubCustomerRef({ customer_ids: [memberId] }), memberId);
    // P-I: '' or whitespace is a present-but-invalid reference (the one-reference rule still applies).
    for (const blank of [{ customer_id: '' }, { member_id: '   ' }, { walk_in_id: '' }, { customer_ids: [''] }, { customer_id: '', member_id: memberId }])
      assert.throws(() => assertSingleHubCustomerRef(blank), { errorCode: 'MEMBER_REFERENCE_REQUIRED' });

    const none = await post('/api/v1/hub-bookings', { machine_id: m.machineId });
    assert.equal(none.status, 400, JSON.stringify(none.body));
    assert.equal(none.body['error_code'], 'MEMBER_REFERENCE_REQUIRED');
    for (const refs of [
      { customer_id: memberId, member_id: memberId },
      { member_id: memberId, walk_in_id: walkInId },
      { customer_ids: [memberId, walkInId] },
    ]) {
      const two = await post('/api/v1/hub-bookings', { machine_id: m.machineId, ...refs });
      assert.equal(two.status, 400, JSON.stringify(two.body));
      assert.equal(two.body['error_code'], 'MEMBER_REFERENCE_REQUIRED');
    }
    for (const blank of ['', '  ']) {
      const blankRef = await post('/api/v1/hub-bookings', { machine_id: m.machineId, customer_id: blank });
      assert.equal(blankRef.status, 400, JSON.stringify(blankRef.body));
      assert.equal(blankRef.body['error_code'], 'MEMBER_REFERENCE_REQUIRED');
    }
    const unknown = await openOn(m.machineId, randomUUID());
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body['error_code'], 'HUB_CUSTOMER_NOT_FOUND');
    const noMachine = await openOn(randomUUID(), memberId);
    assert.equal(noMachine.status, 404, JSON.stringify(noMachine.body));
    assert.equal(noMachine.body['error_code'], 'HUB_MACHINE_NOT_FOUND');

    // The seam is the gate: a direct event with two references is refused identically.
    await assert.rejects(
      persistEvent({
        stream_type: 'research',
        stream_id: randomUUID(),
        event_type: 'hub.booking_opened',
        payload: {
          booking_id: randomUUID(),
          member_id: memberId,
          walk_in_id: walkInId,
          machine_id: m.machineId,
          opened_at: new Date().toISOString(),
        },
        metadata: {
          correlation_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          actor: { user_id: randomUUID(), role: 'x', location_id: '*' },
        },
        idempotency_key: randomUUID(),
      } as never),
      { errorCode: 'MEMBER_REFERENCE_REQUIRED' },
    );

    const ok = await openOn(m.machineId, memberId);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const okWalkIn = await post('/api/v1/hub-bookings', { customer_ids: [walkInId], machine_id: m2.machineId });
    assert.equal(okWalkIn.status, 201, JSON.stringify(okWalkIn.body));
    assert.equal(pick(okWalkIn, 'booking', 'customer_id'), walkInId);
  });

  it('D3: a machine with an open booking refuses another open (HUB_MACHINE_BUSY) until it is closed', async () => {
    const m = await seedMachine();
    const customer = await seedCustomer();
    const first = await openOn(m.machineId, customer);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await openOn(m.machineId, await seedCustomer('walk_in'));
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body['error_code'], 'HUB_MACHINE_BUSY');
    const open = await getPool().query("SELECT count(*)::int AS n FROM hub_booking WHERE machine_id = $1 AND status = 'open'", [m.machineId]);
    assert.equal(open.rows[0]!['n'], 1);

    const firstId = pick(first, 'booking', 'booking_id');
    await backdate(firstId, 3600);
    const closed = await post(`/api/v1/hub-bookings/${firstId}/close`, { actual_minutes: 30, meter_reading_value: 10 });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const third = await openOn(m.machineId, customer);
    assert.equal(third.status, 201, JSON.stringify(third.body));
  });

  it('P1: replaying an idempotent open, register, customer create or close returns the original record', async () => {
    const m = await seedMachine();
    const customer = await seedCustomer();
    const openKey = `open-${run}-${++seq}`;
    const a = await openOn(m.machineId, customer, { idempotency_key: openKey });
    const b = await openOn(m.machineId, customer, { idempotency_key: openKey });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(pick(b, 'booking', 'booking_id'), pick(a, 'booking', 'booking_id'));
    assert.equal(b.body['event_id'], a.body['event_id']);

    const asset = await post('/api/v1/assets', {
      asset_tag: `TAG-104R-${run}-${++seq}`,
      asset_name: `Replay ${run}`,
      criticality_class: 'low',
    });
    const regBody = {
      machine_code: `RP-${run}-${seq}`,
      location_id: hubBin,
      asset_id: pick(asset, 'asset', 'asset_id'),
      operator_role: operatorRole,
      idempotency_key: `reg-${run}-${seq}`,
    };
    const r1 = await post('/api/v1/hub-machines', regBody);
    const r2 = await post('/api/v1/hub-machines', regBody);
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.equal(pick(r2, 'machine', 'machine_id'), pick(r1, 'machine', 'machine_id'));

    const custBody = { customer_kind: 'walk_in', display_name: 'Replay', idempotency_key: `cust-${run}-${seq}` };
    const c1 = await post('/api/v1/hub-customers', custBody);
    const c2 = await post('/api/v1/hub-customers', custBody);
    assert.equal(c2.status, 201, JSON.stringify(c2.body));
    assert.equal(pick(c2, 'customer', 'customer_id'), pick(c1, 'customer', 'customer_id'));

    // A close replay returns the closed booking (not HUB_BOOKING_ALREADY_CLOSED).
    const bookingId = pick(a, 'booking', 'booking_id');
    await backdate(bookingId, 7200);
    const closeBody = { actual_minutes: 60, meter_reading_value: 42, idempotency_key: `close-${run}-${seq}` };
    const k1 = await post(`/api/v1/hub-bookings/${bookingId}/close`, closeBody);
    const k2 = await post(`/api/v1/hub-bookings/${bookingId}/close`, closeBody);
    assert.equal(k1.status, 200, JSON.stringify(k1.body));
    assert.equal(k2.status, 200, JSON.stringify(k2.body));
    assert.equal(pick(k2, 'booking', 'booking_id'), bookingId);
    assert.equal(k2.body['event_id'], k1.body['event_id']);

    // A key reused for a different write is a 409, never a phantom record.
    const other = await seedOpenBooking(2);
    const reused = await post(`/api/v1/hub-bookings/${other.bookingId}/close`, { ...closeBody, idempotency_key: closeBody.idempotency_key });
    assert.equal(reused.status, 409, JSON.stringify(reused.body));
    assert.equal(reused.body['error_code'], 'DUPLICATE_EVENT');
    const crossType = await openOn((await seedMachine()).machineId, customer, { idempotency_key: custBody.idempotency_key });
    assert.equal(crossType.status, 409, JSON.stringify(crossType.body));
    assert.equal(crossType.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('D6/X4: opened_at may be backdated up to 12h with a reason; the 5-minute future skew and closed_at window stay', async () => {
    const customer = await seedCustomer();
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    const HOUR = 60 * MINUTE;
    const fresh = async (): Promise<string> => (await seedMachine()).machineId;

    // Future skew: refused even with a reason.
    const future = await openOn(await fresh(), customer, { opened_at: ago(-6 * MINUTE), backdate_reason: 'late entry' });
    assert.equal(future.status, 400, JSON.stringify(future.body));
    assert.equal(future.body['error_code'], 'INVALID_PARAMS');

    // Inside the 5-minute window no reason is needed.
    const inside = await openOn(await fresh(), customer, { opened_at: ago(4 * MINUTE) });
    assert.equal(inside.status, 201, JSON.stringify(inside.body));
    assert.equal(pick(inside, 'booking', 'backdate_reason'), null);

    // Past the window: a reason is required (missing, blank), and stored when given.
    for (const reason of [undefined, '', '   ']) {
      const r = await openOn(await fresh(), customer, { opened_at: ago(6 * MINUTE), ...(reason === undefined ? {} : { backdate_reason: reason }) });
      assert.equal(r.status, 400, JSON.stringify([reason, r.body]));
      assert.equal(r.body['error_code'], 'INVALID_PARAMS');
      assert.match(JSON.stringify(r.body), /backdate_reason/);
    }
    const late = await openOn(await fresh(), customer, { opened_at: ago(11 * HOUR), backdate_reason: '  machine used overnight, logged late ' });
    assert.equal(late.status, 201, JSON.stringify(late.body));
    assert.equal(pick(late, 'booking', 'backdate_reason'), 'machine used overnight, logged late');
    const lateOpened = new Date(pick(late, 'booking', 'opened_at')).getTime();
    assert.ok(Math.abs(Date.now() - 11 * HOUR - lateOpened) < MINUTE, 'the backdated opened_at is stored');

    // Beyond 12 hours: refused even with a reason. Reason over 500 characters: refused.
    const tooOld = await openOn(await fresh(), customer, { opened_at: ago(13 * HOUR), backdate_reason: 'forgot' });
    assert.equal(tooOld.status, 400, JSON.stringify(tooOld.body));
    assert.match(JSON.stringify(tooOld.body), /12 hours/);
    const longReason = await openOn(await fresh(), customer, { opened_at: ago(2 * HOUR), backdate_reason: 'x'.repeat(501) });
    assert.equal(longReason.status, 400, JSON.stringify(longReason.body));
    const maxReason = await openOn(await fresh(), customer, { opened_at: ago(2 * HOUR), backdate_reason: 'x'.repeat(500) });
    assert.equal(maxReason.status, 201, JSON.stringify(maxReason.body));

    // A backdated booking can close with actual_minutes up to the stored span (capped by opened_at/closed_at).
    const lateId = pick(late, 'booking', 'booking_id');
    const tooLong = await post(`/api/v1/hub-bookings/${lateId}/close`, { actual_minutes: 12 * 60, meter_reading_value: 5 });
    assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
    const closedLate = await post(`/api/v1/hub-bookings/${lateId}/close`, { actual_minutes: 10 * 60, meter_reading_value: 5 });
    assert.equal(closedLate.status, 200, JSON.stringify(closedLate.body));

    const serverStamped = await seedOpenBooking(0);
    const row = await getPool().query('SELECT opened_at FROM hub_booking WHERE booking_id = $1', [serverStamped.bookingId]);
    assert.ok(Math.abs((row.rows[0]!['opened_at'] as Date).getTime() - Date.now()) < MINUTE, 'server stamps opened_at');

    // closed_at keeps the plain 5-minute window.
    const lateClose = await post(`/api/v1/hub-bookings/${serverStamped.bookingId}/close`, {
      actual_minutes: 0,
      meter_reading_value: 5,
      closed_at: ago(6 * MINUTE),
    });
    assert.equal(lateClose.status, 400, JSON.stringify(lateClose.body));
    assert.match(JSON.stringify(lateClose.body), /closed_at/);
  });

  it('X2: an idempotent replay returns the original event even when its client timestamps are out of the window', async () => {
    const m = await seedMachine();
    const customer = await seedCustomer();
    const bookingId = randomUUID();
    const key = `replay-window-${run}-${++seq}`;
    const envelope = (openedAt: string, idempotencyKey: string): never =>
      ({
        stream_type: 'research',
        stream_id: bookingId,
        event_type: 'hub.booking_opened',
        payload: { booking_id: bookingId, customer_id: customer, machine_id: m.machineId, opened_at: openedAt },
        metadata: {
          correlation_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          actor: { user_id: randomUUID(), role: 'x', location_id: '*' },
        },
        idempotency_key: idempotencyKey,
      }) as never;
    const first = await persistEvent(envelope(new Date().toISOString(), key));
    // Same key, 20 hours old: a NEW event with that timestamp is refused, the replay is not.
    const stale = new Date(Date.now() - 20 * 60 * MINUTE).toISOString();
    const replay = await persistEvent(envelope(stale, key));
    assert.equal(replay.event_id, first.event_id);
    await assert.rejects(persistEvent(envelope(stale, `${key}-new`)), { errorCode: 'INVALID_PARAMS' });
  });

  it('P-G: impossible calendar dates are INVALID_PARAMS, never a 500', async () => {
    const customer = await seedCustomer();
    const m = await seedMachine();
    for (const bad of ['2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-04-31T10:00:00Z', '2027-02-29T10:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T10:60:00Z', '2026-01-01T10:00:00+25:00']) {
      for (const field of ['scheduled_start', 'scheduled_end', 'opened_at']) {
        const r = await openOn(m.machineId, customer, { [field]: bad });
        assert.equal(r.status, 400, JSON.stringify([field, bad, r.body]));
        assert.equal(r.body['error_code'], 'INVALID_PARAMS');
      }
    }
    const booking = await seedOpenBooking(1);
    const closeBad = await post(`/api/v1/hub-bookings/${booking.bookingId}/close`, { actual_minutes: 1, meter_reading_value: 5, closed_at: '2026-02-30T10:00:00Z' });
    assert.equal(closeBad.status, 400, JSON.stringify(closeBad.body));
    assert.equal(closeBad.body['error_code'], 'INVALID_PARAMS');
    await assert.rejects(
      persistEvent({
        stream_type: 'research',
        stream_id: booking.bookingId,
        event_type: 'hub.booking_exception_raised',
        payload: { booking_id: booking.bookingId, raised_at: '2026-02-30T10:00:00Z' },
        metadata: { correlation_id: randomUUID(), occurred_at: new Date().toISOString(), actor: { user_id: randomUUID(), role: 'x', location_id: '*' } },
        idempotency_key: randomUUID(),
      } as never),
      { errorCode: 'INVALID_PARAMS' },
    );
    // A real leap day is a valid scheduled date.
    const leap = await openOn(m.machineId, customer, { scheduled_start: '2028-02-29T10:00:00Z', scheduled_end: '2028-02-29T11:00:00+00:00' });
    assert.equal(leap.status, 201, JSON.stringify(leap.body));
  });

  it('AC3: close records actuals and feeds the meter register; regression rolls the close back', async () => {
    const m = await seedMachine();
    const customer = await seedCustomer();
    const id = pick(await openOn(m.machineId, customer), 'booking', 'booking_id');
    await backdate(id, 3 * 3600);
    const closed = await post(`/api/v1/hub-bookings/${id}/close`, { actual_minutes: 95, meter_reading_value: 120.5 });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const b = closed.body['booking'] as Body;
    assert.equal(b['status'], 'closed');
    assert.equal(b['actual_minutes'], 95);
    assert.equal(Number(b['meter_reading_value']), 120.5);
    const pool = getPool();
    const reading = await pool.query(
      'SELECT meter_id, reading_value, source FROM asset_meter_reading WHERE reading_id = $1',
      [b['reading_id']],
    );
    assert.equal(reading.rows[0]!['source'], 'hub_booking');
    assert.equal(reading.rows[0]!['meter_id'], m.meterId);
    const meter = await pool.query('SELECT current_reading FROM asset_meter WHERE meter_id = $1', [m.meterId]);
    assert.equal(Number(meter.rows[0]!['current_reading']), 120.5);

    const again = await post(`/api/v1/hub-bookings/${id}/close`, { actual_minutes: 1, meter_reading_value: 130 });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body['error_code'], 'HUB_BOOKING_ALREADY_CLOSED');

    const second = pick(await openOn(m.machineId, customer), 'booking', 'booking_id');
    await backdate(second, 3 * 3600);
    const regress = await post(`/api/v1/hub-bookings/${second}/close`, { actual_minutes: 10, meter_reading_value: 50 });
    assert.equal(regress.status, 409, JSON.stringify(regress.body));
    assert.equal(regress.body['error_code'], 'METER_READING_REGRESSION');
    const still = await pool.query('SELECT status, reading_id FROM hub_booking WHERE booking_id = $1', [second]);
    assert.equal(still.rows[0]!['status'], 'open');
    assert.equal(still.rows[0]!['reading_id'], null);
    const meterAfter = await pool.query('SELECT current_reading FROM asset_meter WHERE meter_id = $1', [m.meterId]);
    assert.equal(Number(meterAfter.rows[0]!['current_reading']), 120.5);

    const missing = await post(`/api/v1/hub-bookings/${randomUUID()}/close`, { actual_minutes: 1, meter_reading_value: 200 });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body['error_code'], 'HUB_BOOKING_NOT_FOUND');
  });

  it('P5/P8: close validation names the close fields and never returns a 500', async () => {
    const b = await seedOpenBooking(3);
    const close = (body: Body): Promise<Response> => post(`/api/v1/hub-bookings/${b.bookingId}/close`, body);
    const cases: Array<[Body, string]> = [
      [{ actual_minutes: -1, meter_reading_value: 200 }, 'actual_minutes'],
      [{ actual_minutes: 1.5, meter_reading_value: 200 }, 'actual_minutes'],
      [{ actual_minutes: 1e30, meter_reading_value: 200 }, 'actual_minutes'],
      [{ actual_minutes: 100001, meter_reading_value: 200 }, 'actual_minutes'],
      [{ actual_minutes: 10, meter_reading_value: 'x' }, 'meter_reading_value'],
      [{ actual_minutes: 10, meter_reading_value: -3 }, 'meter_reading_value'],
      [{ actual_minutes: 10, meter_reading_value: 1e14 }, 'meter_reading_value'],
      [{ actual_minutes: 10, meter_reading_value: 1.00001 }, 'meter_reading_value'],
      // P-J: a double whose shortest decimal form has more than 4 decimals would round in NUMERIC(18,4).
      [{ actual_minutes: 10, meter_reading_value: 0.30000000000000004 }, 'meter_reading_value'],
      [{ actual_minutes: 10, meter_reading_value: 1e-7 }, 'meter_reading_value'],
      [{ actual_minutes: 10, meter_reading_value: 100000000000000 }, 'meter_reading_value'],
      [{ actual_minutes: 10, meter_reading_value: 5, closed_at: 'yesterday' }, 'closed_at'],
      // Within the bound but longer than the booking has been open (3h = 180 minutes).
      [{ actual_minutes: 500, meter_reading_value: 200 }, 'actual_minutes'],
    ];
    for (const [body, field] of cases) {
      const r = await close(body);
      assert.equal(r.status, 400, JSON.stringify([body, r.body]));
      assert.equal(r.body['error_code'], 'INVALID_PARAMS');
      assert.match(JSON.stringify(r.body), new RegExp(field), JSON.stringify([body, r.body]));
    }
    assert.doesNotMatch(
      JSON.stringify((await close({ actual_minutes: -1, meter_reading_value: 200 })).body),
      /reading_at|"reading_value"/,
    );
    const still = await getPool().query('SELECT status FROM hub_booking WHERE booking_id = $1', [b.bookingId]);
    assert.equal(still.rows[0]!['status'], 'open');
    // P-J: a value that is exact in 4 decimals is accepted and stored exactly.
    const exact = await close({ actual_minutes: 10, meter_reading_value: 0.3 });
    assert.equal(exact.status, 200, JSON.stringify(exact.body));
    assert.equal(Number(pick(exact, 'booking', 'meter_reading_value')), 0.3);
  });

  it('a close with closed_at before opened_at is refused', async () => {
    const m = await seedMachine();
    const id = pick(await openOn(m.machineId, await seedCustomer()), 'booking', 'booking_id');
    const r = await post(`/api/v1/hub-bookings/${id}/close`, {
      actual_minutes: 0,
      meter_reading_value: 5,
      closed_at: new Date(Date.now() - 4 * MINUTE).toISOString(),
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body['error_code'], 'INVALID_PARAMS');
    assert.match(JSON.stringify(r.body), /closed_at must not precede opened_at/);
    const still = await getPool().query('SELECT status FROM hub_booking WHERE booking_id = $1', [id]);
    assert.equal(still.rows[0]!['status'], 'open');
  });

  it('D4: writes and lists are scoped to the actor locations; a read-only role cannot write', async () => {
    const atHub = await seedMachine({ location: hubBin });
    const atOther = await seedMachine({ location: otherBin });
    const hubCustomer = await seedCustomer('walk_in', { location_id: hubBin });
    const freeCustomer = await seedCustomer('walk_in');
    const hubBooking = await openOn(atHub.machineId, hubCustomer);
    assert.equal(hubBooking.status, 201, JSON.stringify(hubBooking.body));
    const hubBookingId = pick(hubBooking, 'booking', 'booking_id');

    // Read-only role: reads work, every write route is refused before any event is written.
    const ro = await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'RO' }, readOnlyHeaders);
    assert.equal(ro.status, 403, JSON.stringify(ro.body));
    assert.equal(ro.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const roBook = await post('/api/v1/hub-bookings', { customer_id: freeCustomer, machine_id: atHub.machineId }, readOnlyHeaders);
    assert.equal(roBook.status, 403, JSON.stringify(roBook.body));
    assert.equal(roBook.body['error_code'], 'FUNCTION_ACCESS_DENIED');
    const roList = await get('/api/v1/hub-machines', readOnlyHeaders);
    assert.equal(roList.status, 200, JSON.stringify(roList.body));
    assert.ok((roList.body['rows'] as Body[]).some((r) => r['machine_id'] === atHub.machineId));

    // A site-scoped writer cannot touch another location's machine, booking or customer...
    const denied = [
      await post('/api/v1/hub-bookings', { customer_id: freeCustomer, machine_id: atHub.machineId }, scopedHeaders),
      await post(`/api/v1/hub-bookings/${hubBookingId}/close`, { actual_minutes: 0, meter_reading_value: 1 }, scopedHeaders),
      await post(`/api/v1/hub-machines/${atHub.machineId}/meter`, { meter_id: randomUUID() }, scopedHeaders),
      await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'S', location_id: hubBin }, scopedHeaders),
      // P-D: a location-scoped writer must give the customer a location (an unlocated one is global).
      await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'S2' }, scopedHeaders),
      await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'S3', location_id: '' }, scopedHeaders),
      await post(
        '/api/v1/hub-machines',
        { machine_code: `DEN-${run}-${++seq}`, location_id: hubBin, asset_id: atHub.assetId, operator_role: operatorRole },
        scopedHeaders,
      ),
    ];
    for (const r of denied) {
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }
    const ownCustomer = await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'S4', location_id: otherBin }, scopedHeaders);
    assert.equal(ownCustomer.status, 201, JSON.stringify(ownCustomer.body));
    // ...works at its own location, and its lists exclude the other location's records.
    const own = await post('/api/v1/hub-bookings', { customer_id: freeCustomer, machine_id: atOther.machineId }, scopedHeaders);
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const idsOf = (r: Response, field: string): unknown[] => (r.body['rows'] as Body[]).map((x) => x[field]);
    const machines = await get('/api/v1/hub-machines', scopedHeaders);
    assert.ok(idsOf(machines, 'machine_id').includes(atOther.machineId));
    assert.ok(!idsOf(machines, 'machine_id').includes(atHub.machineId));
    const customers = await get('/api/v1/hub-customers', scopedHeaders);
    assert.ok(!idsOf(customers, 'customer_id').includes(hubCustomer));
    assert.ok(idsOf(customers, 'customer_id').includes(freeCustomer));
    const bookings = await get('/api/v1/hub-bookings', scopedHeaders);
    assert.ok(!idsOf(bookings, 'booking_id').includes(hubBookingId));
    const all = await get('/api/v1/hub-bookings');
    assert.ok(idsOf(all, 'booking_id').includes(hubBookingId));
  });

  it('AC4/D1: a booking unclosed for 24h raises exactly one exception, notified by role only', async () => {
    const old = await seedOpenBooking(25);
    const exactly24 = await seedOpenBooking(0);
    await getPool().query("UPDATE hub_booking SET opened_at = now() - interval '24 hours' WHERE booking_id = $1", [exactly24.bookingId]);
    const just23h59 = await seedOpenBooking(0);
    await backdate(just23h59.bookingId, 23 * 3600 + 59 * 60);
    const closedOld = await seedOpenBooking(26);
    const c = await post(`/api/v1/hub-bookings/${closedOld.bookingId}/close`, { actual_minutes: 30, meter_reading_value: 300 });
    assert.equal(c.status, 200, JSON.stringify(c.body));

    const first = await runHubBookingExceptionJob();
    assert.equal(first.failures, 0);
    assert.ok(first.booking_ids.includes(old.bookingId));
    assert.ok(first.booking_ids.includes(exactly24.bookingId), 'exactly 24h is overdue (<=)');
    assert.ok(!first.booking_ids.includes(just23h59.bookingId), '23h59 is not overdue');
    assert.ok(!first.booking_ids.includes(closedOld.bookingId));
    const second = await runHubBookingExceptionJob();
    assert.ok(!second.booking_ids.includes(old.bookingId));

    const pool = getPool();
    const events = await pool.query(
      "SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'hub.booking_exception_raised' AND stream_id = $1",
      [old.bookingId],
    );
    assert.equal(events.rows[0]!['n'], 1);
    const notes = await pool.query(
      "SELECT payload FROM domain_events WHERE event_type = 'notification.created' AND payload->>'object_id' = $1",
      [old.bookingId],
    );
    assert.equal(notes.rows.length, 1);
    const note = notes.rows[0]!['payload'] as Body;
    assert.equal(note['object_type'], 'hub_booking');
    assert.equal((note['target'] as Body)['role'], operatorRole);
    assert.equal((note['target'] as Body)['location_id'] ?? null, null, 'role only, no location scope');
    const rows = await pool.query(
      'SELECT booking_id, status, exception_raised_at FROM hub_booking WHERE booking_id = ANY($1)',
      [[old.bookingId, exactly24.bookingId, just23h59.bookingId, closedOld.bookingId]],
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r['booking_id'], r]));
    assert.notEqual(by[old.bookingId]!['exception_raised_at'], null);
    assert.equal(by[old.bookingId]!['status'], 'open');
    assert.notEqual(by[exactly24.bookingId]!['exception_raised_at'], null);
    assert.equal(by[just23h59.bookingId]!['exception_raised_at'], null);
    assert.equal(by[closedOld.bookingId]!['exception_raised_at'], null);
  });

  it('P-M: one booking whose exception fails does not stop the sweep; failures is 1', async () => {
    const bad = await seedOpenBooking(25);
    const good = await seedOpenBooking(25);
    // A role that bypassed registration validation (seeded directly) cannot be notified.
    await getPool().query("UPDATE hub_machine SET operator_role = 'bad role!' WHERE machine_id = $1", [bad.machineId]);
    try {
      const result = await runHubBookingExceptionJob();
      assert.equal(result.failures, 1);
      assert.ok(result.booking_ids.includes(good.bookingId));
      assert.ok(!result.booking_ids.includes(bad.bookingId));
      const rows = await getPool().query(
        'SELECT booking_id, exception_raised_at FROM hub_booking WHERE booking_id = ANY($1)',
        [[bad.bookingId, good.bookingId]],
      );
      const by = Object.fromEntries(rows.rows.map((r) => [r['booking_id'], r]));
      assert.notEqual(by[good.bookingId]!['exception_raised_at'], null, 'the other due booking still got its exception');
      assert.equal(by[bad.bookingId]!['exception_raised_at'], null, 'the failed booking is rolled back, not half-flagged');
    } finally {
      // Close the failing booking so later sweeps (and reruns) do not count it.
      await post(`/api/v1/hub-bookings/${bad.bookingId}/close`, { actual_minutes: 1, meter_reading_value: 5 });
    }
  });

  it('X3: only overlapping scheduled windows make a machine busy; a booking with no window conflicts with any open one', async () => {
    const win = (from: string, to: string): Body => ({ scheduled_start: `2030-01-01T${from}:00Z`, scheduled_end: `2030-01-01T${to}:00Z` });
    const m = await seedMachine();
    const a = await openOn(m.machineId, await seedCustomer(), win('10:00', '12:00'));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const overlap = await openOn(m.machineId, await seedCustomer(), win('11:00', '13:00'));
    assert.equal(overlap.status, 409, JSON.stringify(overlap.body));
    assert.equal(overlap.body['error_code'], 'HUB_MACHINE_BUSY');
    const inside = await openOn(m.machineId, await seedCustomer(), win('10:30', '11:00'));
    assert.equal(inside.status, 409, JSON.stringify(inside.body));
    const adjacent = await openOn(m.machineId, await seedCustomer(), win('12:00', '14:00'));
    assert.equal(adjacent.status, 201, JSON.stringify(adjacent.body));
    const disjoint = await openOn(m.machineId, await seedCustomer(), win('15:00', '16:00'));
    assert.equal(disjoint.status, 201, JSON.stringify(disjoint.body));
    const otherDay = await openOn(m.machineId, await seedCustomer(), {
      scheduled_start: '2030-01-02T10:00:00Z',
      scheduled_end: '2030-01-02T12:00:00Z',
    });
    assert.equal(otherDay.status, 201, JSON.stringify(otherDay.body));
    // A new booking without a complete window conflicts with every open booking on the machine.
    const noWindow = await openOn(m.machineId, await seedCustomer());
    assert.equal(noWindow.status, 409, JSON.stringify(noWindow.body));
    assert.equal(noWindow.body['error_code'], 'HUB_MACHINE_BUSY');
    const halfWindow = await openOn(m.machineId, await seedCustomer(), { scheduled_start: '2031-01-01T10:00:00Z' });
    assert.equal(halfWindow.status, 409, JSON.stringify(halfWindow.body));
    // ...and an open booking without a window blocks a new windowed one.
    const m2 = await seedMachine();
    assert.equal((await openOn(m2.machineId, await seedCustomer())).status, 201);
    const blocked = await openOn(m2.machineId, await seedCustomer(), win('10:00', '12:00'));
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body['error_code'], 'HUB_MACHINE_BUSY');
  });

  it('P-B/P-C: an uppercase UUID in the URL closes the booking; the same key with a different body is a 409', async () => {
    const booking = await seedOpenBooking(2);
    const upper = booking.bookingId.toUpperCase();
    const key = `close-up-${run}-${++seq}`;
    const closeBody = { actual_minutes: 30, meter_reading_value: 77, idempotency_key: key };
    const first = await post(`/api/v1/hub-bookings/${upper}/close`, closeBody);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(pick(first, 'booking', 'booking_id'), booking.bookingId);
    const same = await post(`/api/v1/hub-bookings/${booking.bookingId}/close`, closeBody);
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body['event_id'], first.body['event_id']);
    for (const changed of [{ actual_minutes: 31 }, { meter_reading_value: 78 }]) {
      const r = await post(`/api/v1/hub-bookings/${booking.bookingId}/close`, { ...closeBody, ...changed });
      assert.equal(r.status, 409, JSON.stringify([changed, r.body]));
      assert.equal(r.body['error_code'], 'DUPLICATE_EVENT');
    }

    // Open: same key, different machine, customer or window.
    const m = await seedMachine();
    const other = await seedMachine();
    const customer = await seedCustomer();
    const openKey = `open-diff-${run}-${++seq}`;
    const base = { idempotency_key: openKey, scheduled_start: '2032-01-01T10:00:00Z', scheduled_end: '2032-01-01T11:00:00Z' };
    const opened = await openOn(m.machineId, customer, base);
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    for (const [machineId, customerId, extra] of [
      [other.machineId, customer, {}],
      [m.machineId, await seedCustomer(), {}],
      [m.machineId, customer, { scheduled_end: '2032-01-01T12:00:00Z' }],
      [m.machineId, customer, { opened_at: new Date(Date.now() - 2 * MINUTE).toISOString() }],
    ] as const) {
      const r = await openOn(machineId, customerId, { ...base, ...extra });
      assert.equal(r.status, 409, JSON.stringify([extra, r.body]));
      assert.equal(r.body['error_code'], 'DUPLICATE_EVENT');
    }
    const identical = await openOn(m.machineId, customer, base);
    assert.equal(identical.status, 201, JSON.stringify(identical.body));
    assert.equal(identical.body['event_id'], opened.body['event_id']);

    // Customer create and machine register: same key, different body.
    const custKey = `cust-diff-${run}-${++seq}`;
    const c1 = await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'One', idempotency_key: custKey });
    assert.equal(c1.status, 201, JSON.stringify(c1.body));
    const c2 = await post('/api/v1/hub-customers', { customer_kind: 'walk_in', display_name: 'Two', idempotency_key: custKey });
    assert.equal(c2.status, 409, JSON.stringify(c2.body));
    assert.equal(c2.body['error_code'], 'DUPLICATE_EVENT');
  });

  it('X1/P-N: a direct hub.* event needs the engineering module and the hub location rule, on both doors', async () => {
    const atHub = await seedMachine({ location: hubBin });
    const customer = await seedCustomer();
    const event = (eventType: string, payload: Body, actorLocation: string): Body => ({
      stream_type: 'research',
      stream_id: randomUUID(),
      event_type: eventType,
      payload,
      metadata: {
        correlation_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        actor: { user_id: randomUUID(), role: 'x', location_id: actorLocation },
      },
      idempotency_key: randomUUID(),
    });
    const customerEvent = (actorLocation = hubBin): Body =>
      event('hub.customer_registered', { customer_id: randomUUID(), customer_kind: 'walk_in', display_name: 'Direct' }, actorLocation);
    const openEvent = (machineId: string, actorLocation: string): Body =>
      event(
        'hub.booking_opened',
        { booking_id: randomUUID(), customer_id: customer, machine_id: machineId, opened_at: new Date().toISOString() },
        actorLocation,
      );
    const edge = (body: Body): Body => ({
      ...body,
      event_id: randomUUID(),
      metadata: { ...(body['metadata'] as Body), device_id: 'EDGE-TAB-104', capture_method: 'MANUAL' },
    });

    for (const [door, wrap] of [
      ['/api/v1/events', (b: Body): Body => b],
      ['/api/v1/edge/events', edge],
    ] as const) {
      // A research-only role (the stream's own module) is refused: hub.* needs engineering.
      const research = await post(door, wrap(customerEvent()), researchHeaders);
      assert.equal(research.status, 403, `${door}: ${JSON.stringify(research.body)}`);
      const researchOpen = await post(door, wrap(openEvent(atHub.machineId, hubBin)), researchHeaders);
      assert.equal(researchOpen.status, 403, `${door}: ${JSON.stringify(researchOpen.body)}`);
      // A read-only engineering role is refused too.
      const reader = await post(door, wrap(customerEvent()), readOnlyHeaders);
      assert.equal(reader.status, 403, `${door}: ${JSON.stringify(reader.body)}`);
      // A writer scoped to another location is refused for this machine, allowed for its own.
      const denied = await post(door, wrap(openEvent(atHub.machineId, otherBin)), scopedHeaders);
      assert.equal(denied.status, 403, `${door}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body['error_code'], 'LOCATION_ACCESS_DENIED');
      const unlocated = await post(door, wrap(customerEvent(otherBin)), scopedHeaders);
      assert.equal(unlocated.status, 403, `${door}: ${JSON.stringify(unlocated.body)}`);
      assert.equal(unlocated.body['error_code'], 'LOCATION_ACCESS_DENIED');
      const target = await seedMachine({ location: otherBin });
      const own = await post(door, wrap(openEvent(target.machineId, otherBin)), scopedHeaders);
      assert.equal(own.status, 201, `${door}: ${JSON.stringify(own.body)}`);
      // A scoped user cannot register a machine at a location it does not cover, via the payload.
      const regDenied = await post(
        door,
        wrap(
          event(
            'hub.machine_registered',
            { machine_id: randomUUID(), machine_code: `X1-${run}-${++seq}`, location_id: hubBin, asset_id: atHub.assetId, operator_role: operatorRole },
            otherBin,
          ),
        ),
        scopedHeaders,
      );
      assert.equal(regDenied.status, 403, `${door}: ${JSON.stringify(regDenied.body)}`);
      assert.equal(regDenied.body['error_code'], 'LOCATION_ACCESS_DENIED');
    }
    // A global engineering writer still posts a hub event directly (the generic door stays usable).
    const ok = await post('/api/v1/events', customerEvent());
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});

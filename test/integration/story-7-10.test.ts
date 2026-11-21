import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { toIstCalendarDate } from '../../src/lib/business-days.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.10: Calibration Certificate Void and Supersede. Extends the Story 7.5 register with a
// void event (keep the row, mark it voided, reactivate the previous renewal-superseded certificate
// or lock the instrument out) and a correction-supersede branch on the record event (BSD 5: one
// event type, branched). Runs against the PRODUCTION router surface (createAppRouter) with real
// auth, RBAC and PostgreSQL, bootstrapped exactly like test/integration/story-7-5.test.ts. The
// maintenance stream is blocked at the direct-events HTTP guard, so seam-enforced codes are also
// exercised through direct persistEvent calls - the surface a direct write hits.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);
const DEVICE_ID = `edge-7-10-${run}`;
const ANCHOR = toIstCalendarDate(new Date());

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface Role {
  role: string;
  module: string;
  functionScope: 'read' | 'write';
  locationId: string;
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolvePromise, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          if (raw) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { error_code: 'NON_JSON_BODY', raw };
            }
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`Request timed out: ${method} ${path}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function provisionUser(port: number, externalId: string, roles: Role[]): Promise<string> {
  const res = await makeRequest(
    port,
    'POST',
    '/api/v1/scim/v2/Users',
    { externalId, email: externalId, displayName: externalId, roles },
    SCIM_HEADERS,
  );
  assert.strictEqual(
    res.status,
    201,
    `provision ${externalId} failed: ${JSON.stringify(res.body)}`,
  );
  return (res.body as Record<string, string>)['userId']!;
}

async function authFor(port: number, sub: string): Promise<Record<string, string>> {
  const res = await makeRequest(port, 'POST', '/api/v1/auth/dev-token', { sub });
  assert.ok(res.status >= 200 && res.status < 300, `dev-token ${sub} failed`);
  return { Authorization: `Bearer ${res.body['token'] as string}` };
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

type CertRow = Record<string, unknown>;

describe('Story 7.10 Calibration Certificate Void and Supersede', () => {
  let server: Server;
  let port: number;
  let siteLocId: string;

  let recorderUserId: string;
  let recorderHeaders: Record<string, string>;
  let qcAuthorityUserId: string;
  let qcAuthorityHeaders: Record<string, string>;
  let qcAuthority2Headers: Record<string, string>;
  let qcHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let outsiderHeaders: Record<string, string>;
  let voidDoaEntryId: string;
  let supersedeDoaEntryId: string;

  // --- helpers -------------------------------------------------------------

  async function seedLocation(codeSuffix: string): Promise<string> {
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), `LOC-7-10-${run}-${codeSuffix}`, randomUUID()],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function createAsset(): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-7-10-${randomUUID().slice(0, 12)}`,
        asset_name: `Instrument ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: 'critical',
      },
      recorderHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_id']!;
  }

  let instrumentCounter = 0;
  function nextInstrumentId(): string {
    instrumentCounter += 1;
    return `INS-7-10-${run}-${instrumentCounter}`;
  }

  /** Registers an instrument and returns its record id, failing loudly if registration did not. */
  async function registerOk(
    extra: Record<string, unknown> = {},
  ): Promise<{ instrumentRecordId: string; instrumentId: string; assetId: string }> {
    const assetId = (extra['asset_id'] as string | undefined) ?? (await createAsset());
    const instrumentId = (extra['instrument_id'] as string | undefined) ?? nextInstrumentId();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/instruments',
      {
        asset_id: assetId,
        instrument_id: instrumentId,
        location_id: siteLocId,
        calibration_interval_days: 365,
        ...extra,
      },
      recorderHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const instrument = res.body['instrument'] as Record<string, string>;
    return {
      instrumentRecordId: instrument['instrument_record_id']!,
      instrumentId: instrument['instrument_id']!,
      assetId,
    };
  }

  async function recordCertificate(
    instrumentRecordId: string,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates`,
      {
        calibration_type: 'in_house',
        certificate_number: `CERT-7-10-${randomUUID().slice(0, 8)}`,
        issuing_lab: null,
        calibrated_on: ANCHOR,
        valid_until: addDays(ANCHOR, 365),
        business_date: ANCHOR,
        ...body,
      },
      recorderHeaders,
    );
  }

  /** Records a certificate and returns its row, failing loudly on anything but 201. */
  async function recordOk(
    instrumentRecordId: string,
    body: Record<string, unknown> = {},
  ): Promise<CertRow> {
    const res = await recordCertificate(instrumentRecordId, body);
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body['certificate'] as CertRow;
  }

  async function voidCertificateRoute(
    instrumentRecordId: string,
    certificateId: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = qcAuthorityHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates/${certificateId}/void`,
      { void_reason: 'Recorded against the wrong instrument', ...body },
      headers,
    );
  }

  async function supersedeCertificateRoute(
    instrumentRecordId: string,
    certificateId: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = qcAuthorityHeaders,
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates/${certificateId}/supersede`,
      {
        calibration_type: 'in_house',
        certificate_number: `CERT-7-10-${randomUUID().slice(0, 8)}`,
        issuing_lab: null,
        calibrated_on: ANCHOR,
        valid_until: addDays(ANCHOR, 300),
        business_date: ANCHOR,
        supersede_reason: 'Certificate carried the wrong dates',
        ...body,
      },
      headers,
    );
  }

  async function scan(
    businessDate: string,
    extra: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/calibration/scan',
      { business_date: businessDate, ...extra },
      recorderHeaders,
    );
  }

  async function qcResult(instrumentId: string): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      '/api/v1/qc/results',
      {
        instrument_id: instrumentId,
        lot_id: `LOT-${randomUUID().slice(0, 8)}`,
        parameter: 'ph',
        value: 7,
      },
      qcHeaders,
    );
  }

  async function statusOf(instrumentId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT instrument_id, calibration_status, status_event_id, reason
         FROM instrument_calibration_statuses WHERE lower(instrument_id) = lower($1)`,
      [instrumentId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  async function certificateRow(certificateId: string): Promise<CertRow | null> {
    const r = await getAdminPool().query(
      `SELECT certificate_id, status, void_reason, voided_by, voided_at, superseded_as_correction,
              certificate_number, recorded_by
         FROM instrument_calibration_certificate WHERE certificate_id = $1`,
      [certificateId],
    );
    return (r.rows[0] as CertRow) ?? null;
  }

  async function certificatesByStatus(
    instrumentRecordId: string,
    status: string,
  ): Promise<CertRow[]> {
    const r = await getAdminPool().query(
      `SELECT certificate_id, status, superseded_as_correction
         FROM instrument_calibration_certificate
        WHERE instrument_record_id = $1 AND status = $2 ORDER BY recorded_at`,
      [instrumentRecordId, status],
    );
    return r.rows as CertRow[];
  }

  async function alertStagesForCertificate(certificateId: string): Promise<number[]> {
    const r = await getAdminPool().query(
      `SELECT stage_days FROM instrument_calibration_alert
        WHERE certificate_id = $1 ORDER BY stage_days ASC`,
      [certificateId],
    );
    return r.rows.map((row) => row['stage_days'] as number);
  }

  async function domainEventCountFor(
    eventType: string,
    payloadIdField: string,
    payloadId: string,
  ): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = $1 AND payload->>$2 = $3`,
      [eventType, payloadIdField, payloadId],
    );
    return r.rows[0]!['n'] as number;
  }

  async function domainEventPayload(
    eventType: string,
    payloadIdField: string,
    payloadId: string,
  ): Promise<Record<string, unknown>> {
    const r = await getAdminPool().query(
      `SELECT payload FROM domain_events WHERE event_type = $1 AND payload->>$2 = $3`,
      [eventType, payloadIdField, payloadId],
    );
    assert.strictEqual(r.rows.length, 1, `expected exactly one ${eventType} event for ${payloadId}`);
    return r.rows[0]!['payload'] as Record<string, unknown>;
  }

  /** Direct persistEvent void - the surface a direct write hits. */
  async function directVoid(
    payload: Record<string, unknown>,
    actorUserId: string = qcAuthorityUserId,
  ): Promise<unknown> {
    return persistEvent({
      stream_type: 'maintenance',
      stream_id: payload['certificate_id'] as string,
      event_type: 'maintenance.calibration_certificate_voided',
      payload,
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actorUserId, role: 'qc_head', location_id: siteLocId },
        occurred_at: new Date().toISOString(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /** Direct persistEvent correction-supersede (record event with the 7.10 branch declared). */
  async function directRecord(
    instrumentRecordId: string,
    instrumentId: string,
    payload: Record<string, unknown> = {},
    actorUserId: string = qcAuthorityUserId,
  ): Promise<unknown> {
    const certificateId = (payload['certificate_id'] as string | undefined) ?? randomUUID();
    return persistEvent({
      stream_type: 'maintenance',
      stream_id: certificateId,
      event_type: 'maintenance.calibration_certificate_recorded',
      payload: {
        certificate_id: certificateId,
        instrument_record_id: instrumentRecordId,
        instrument_id: instrumentId,
        calibration_type: 'in_house',
        certificate_number: `cert-7-10-direct-${randomUUID().slice(0, 8)}`,
        issuing_lab: null,
        calibrated_on: ANCHOR,
        valid_until: addDays(ANCHOR, 365),
        business_date: ANCHOR,
        recorded_at: new Date().toISOString(),
        ...payload,
      },
      metadata: {
        correlation_id: randomUUID(),
        actor: { user_id: actorUserId, role: 'qc_head', location_id: siteLocId },
        occurred_at: new Date().toISOString(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  before(async () => {
    const adminPool = getAdminPool();
    for (const file of [
      '../../events/domain_events.sql',
      '../../read/projections/users.sql',
      '../../read/projections/audit_log.sql',
      '../../read/projections/doa_registry.sql',
      '../../read/projections/business_stream_config.sql',
      '../../read/projections/location.sql',
      '../../read/projections/instrument_calibration.sql',
      '../../read/projections/notification.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/asset.sql',
      '../../read/projections/instrument_register.sql',
      '../../read/projections/instrument_calibration_certificate.sql',
      '../../read/projections/instrument_calibration_alert.sql',
      '../../read/projections/instrument_calibration_escalation.sql',
      '../../read/projections/edge_refused_capture.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE instrument_calibration_escalation, instrument_calibration_alert, instrument_calibration_certificate, instrument_register, instrument_calibration_statuses, edge_refused_capture, asset, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
      );
    } finally {
      await adminPool.query('ALTER TABLE audit_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log ENABLE TRIGGER ALL');
      await adminPool.query('ALTER TABLE audit_log_archive ENABLE TRIGGER ALL');
    }

    server = createAppServer(createAppRouter());
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        port = (server.address() as AddressInfo).port;
        resolvePromise();
      });
    });

    siteLocId = await seedLocation('QC');

    // The recorder: maintenance write, but deliberately NOT the qc_head DOA band holder, so the
    // authority legs and the SOD leg can be told apart.
    recorderUserId = await provisionUser(port, `cal-recorder-7-10-${run}@example.com`, [
      { role: 'calibration_scheduler', module: 'maintenance', functionScope: 'write', locationId: '*' },
      { role: 'calibration_scheduler', module: 'maintenance', functionScope: 'read', locationId: '*' },
    ]);
    recorderHeaders = await authFor(port, `cal-recorder-7-10-${run}@example.com`);

    // The QC authority: holds the qc_head role both DOA bands point at (BSD 1), plus maintenance
    // write so the route module gate passes.
    qcAuthorityUserId = await provisionUser(port, `qc-authority-7-10-${run}@example.com`, [
      { role: 'qc_head', module: 'maintenance', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'maintenance', functionScope: 'read', locationId: '*' },
    ]);
    qcAuthorityHeaders = await authFor(port, `qc-authority-7-10-${run}@example.com`);

    // A second qc_head holder, for voids/corrections of certificates the first holder recorded.
    await provisionUser(port, `qc-authority-2-7-10-${run}@example.com`, [
      { role: 'qc_head', module: 'maintenance', functionScope: 'write', locationId: '*' },
      { role: 'qc_head', module: 'maintenance', functionScope: 'read', locationId: '*' },
    ]);
    qcAuthority2Headers = await authFor(port, `qc-authority-2-7-10-${run}@example.com`);

    await provisionUser(port, `cal-qc-7-10-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
    ]);
    qcHeaders = await authFor(port, `cal-qc-7-10-${run}@example.com`);

    await provisionUser(port, `cal-compliance-7-10-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `cal-compliance-7-10-${run}@example.com`);

    await provisionUser(port, `cal-reader-7-10-${run}@example.com`, [
      { role: `maintenance_reader_7_10_${run}`, module: 'maintenance', functionScope: 'read', locationId: '*' },
    ]);
    readerHeaders = await authFor(port, `cal-reader-7-10-${run}@example.com`);

    await provisionUser(port, `cal-outsider-7-10-${run}@example.com`, [
      { role: `warehouse_worker_7_10_${run}`, module: 'warehouse', functionScope: 'write', locationId: '*' },
    ]);
    outsiderHeaders = await authFor(port, `cal-outsider-7-10-${run}@example.com`);

    // Task 5.3: seed both DOA entries with the pilot QC authority role, exactly as story-7-5 seeds
    // calibration.escalation for calibration_scheduler.
    const voidDoa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'qc_head',
        transaction_type: 'maintenance.calibration_certificate_void',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(voidDoa.status, 201, JSON.stringify(voidDoa.body));
    voidDoaEntryId = voidDoa.body['entry_id'] as string;

    const supersedeDoa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'qc_head',
        transaction_type: 'maintenance.calibration_certificate_supersede',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(supersedeDoa.status, 201, JSON.stringify(supersedeDoa.body));
    supersedeDoaEntryId = supersedeDoa.body['entry_id'] as string;
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: void reactivates the previous renewal-superseded certificate
  // -------------------------------------------------------------------------

  it('AC1: voiding the active certificate reactivates the latest renewal-superseded one and stays calibrated', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const renewal = await recordOk(instrumentRecordId);
    const current = await recordOk(instrumentRecordId);

    const res = await voidCertificateRoute(instrumentRecordId, current['certificate_id'] as string);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['reactivated_certificate_id'], renewal['certificate_id']);
    assert.strictEqual(res.body['calibration_status'], 'calibrated');

    const voided = await certificateRow(current['certificate_id'] as string);
    assert.strictEqual(voided?.['status'], 'voided');
    assert.strictEqual(voided?.['void_reason'], 'Recorded against the wrong instrument');
    assert.strictEqual(voided?.['voided_by'], qcAuthorityUserId);
    assert.ok(voided?.['voided_at'], 'voided_at is stamped');

    const reactivated = await certificateRow(renewal['certificate_id'] as string);
    assert.strictEqual(reactivated?.['status'], 'active');
    assert.strictEqual((await statusOf(instrumentId))?.['calibration_status'], 'calibrated');

    // The event log IS the history: the void event carries the reactivation outcome.
    const payload = await domainEventPayload(
      'maintenance.calibration_certificate_voided',
      'certificate_id',
      current['certificate_id'] as string,
    );
    assert.strictEqual(payload['reactivated_certificate_id'], renewal['certificate_id']);
    assert.strictEqual(payload['resulting_calibration_status'], 'calibrated');
    assert.strictEqual(payload['voided_by'], qcAuthorityUserId);
  });

  it('AC1: a correction-superseded predecessor is NEVER a reactivation candidate', async () => {
    const { instrumentRecordId } = await registerOk();
    const wrong = await recordOk(instrumentRecordId);
    // Correction-supersede the wrong certificate: it is permanently out of the reactivation pool.
    const corrected = await supersedeCertificateRoute(
      instrumentRecordId,
      wrong['certificate_id'] as string,
    );
    assert.strictEqual(corrected.status, 201, JSON.stringify(corrected.body));
    const correctedId = (corrected.body['certificate'] as CertRow)['certificate_id'] as string;

    // The corrected certificate was recorded by qcAuthority, so a SECOND band holder voids it.
    const res = await voidCertificateRoute(instrumentRecordId, correctedId, {}, qcAuthority2Headers);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['reactivated_certificate_id'], null);
    assert.strictEqual(res.body['calibration_status'], 'out_of_calibration');

    const wrongRow = await certificateRow(wrong['certificate_id'] as string);
    assert.strictEqual(wrongRow?.['status'], 'superseded', 'the corrected-away row stays superseded');
    assert.strictEqual(wrongRow?.['superseded_as_correction'], true);
  });

  it('AC1: voiding a superseded (non-active) certificate is history cleanup - no status write at all', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const first = await recordOk(instrumentRecordId);
    const second = await recordOk(instrumentRecordId); // renewal-supersedes first
    const before = await statusOf(instrumentId);
    assert.strictEqual(before?.['calibration_status'], 'calibrated');
    const eventsBefore = await domainEventCountFor(
      'instrument.calibration_status_updated',
      'instrument_id',
      instrumentId,
    );

    const res = await voidCertificateRoute(instrumentRecordId, first['certificate_id'] as string);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['reactivated_certificate_id'], null);
    assert.strictEqual(res.body['calibration_status'], 'calibrated');

    assert.strictEqual((await certificateRow(first['certificate_id'] as string))?.['status'], 'voided');
    assert.strictEqual(
      (await certificateRow(second['certificate_id'] as string))?.['status'],
      'active',
    );
    assert.deepStrictEqual(
      await statusOf(instrumentId),
      before,
      'the status row is byte-identical after a history-cleanup void',
    );
    assert.strictEqual(
      await domainEventCountFor('instrument.calibration_status_updated', 'instrument_id', instrumentId),
      eventsBefore,
      'a superseded-certificate void writes no status event',
    );
  });

  it('AC1: the voided certificate stays readable on the list route with its reason and actor', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    const res = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string, {
      void_reason: 'Wrong certificate scanned at receipt',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    const list = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates?status=voided`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const rows = list.body['certificates'] as CertRow[];
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['certificate_id'], cert['certificate_id']);
    assert.strictEqual(rows[0]!['status'], 'voided');
    assert.strictEqual(rows[0]!['void_reason'], 'Wrong certificate scanned at receipt');
    assert.strictEqual(rows[0]!['voided_by'], qcAuthorityUserId);
  });

  // -------------------------------------------------------------------------
  // AC 2: supersede by correction replaces the wrong certificate in one event
  // -------------------------------------------------------------------------

  it('AC2: a correction-supersede may carry the SAME certificate number and flags the row', async () => {
    const { instrumentRecordId } = await registerOk();
    // canonicalCertificateNumber lower-cases: keep the fixture lower-case so the assertion is exact.
    const number = `cert-7-10-same-${run}`;
    const wrong = await recordOk(instrumentRecordId, { certificate_number: number });

    const res = await supersedeCertificateRoute(
      instrumentRecordId,
      wrong['certificate_id'] as string,
      { certificate_number: number },
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const corrected = res.body['certificate'] as CertRow;
    assert.strictEqual(corrected['certificate_number'], number);
    assert.strictEqual(corrected['status'], 'active');

    const wrongRow = await certificateRow(wrong['certificate_id'] as string);
    assert.strictEqual(wrongRow?.['status'], 'superseded');
    assert.strictEqual(wrongRow?.['superseded_as_correction'], true);

    // Exactly one active certificate, exactly one event on the new certificate's stream.
    const actives = await certificatesByStatus(instrumentRecordId, 'active');
    assert.strictEqual(actives.length, 1);
    assert.strictEqual(actives[0]!['certificate_id'], corrected['certificate_id']);
    const payload = await domainEventPayload(
      'maintenance.calibration_certificate_recorded',
      'certificate_id',
      corrected['certificate_id'] as string,
    );
    assert.strictEqual(payload['supersedes_certificate_id'], wrong['certificate_id']);
    assert.strictEqual(payload['superseded_certificate_id'], wrong['certificate_id']);
    assert.strictEqual(payload['superseded_as_correction'], true);
    assert.strictEqual(payload['supersede_reason'], 'Certificate carried the wrong dates');
  });

  it('AC2: the corrected certificate gets a fresh alert grain and its dates drive the next scan', async () => {
    const { instrumentRecordId } = await registerOk();
    const wrongValidUntil = addDays(ANCHOR, 365);
    const wrong = await recordOk(instrumentRecordId, {
      certificate_number: `CERT-7-10-ALERT-${run}`,
      valid_until: wrongValidUntil,
    });
    // Fire the wrong certificate's stage-30 alert; the row must be RETAINED as audit history.
    const wrongScan = await scan(addDays(wrongValidUntil, -30), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(wrongScan.status, 200, JSON.stringify(wrongScan.body));
    assert.deepStrictEqual(await alertStagesForCertificate(wrong['certificate_id'] as string), [30]);

    const correctedValidUntil = addDays(ANCHOR, 10);
    const res = await supersedeCertificateRoute(
      instrumentRecordId,
      wrong['certificate_id'] as string,
      { valid_until: correctedValidUntil },
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const correctedId = (res.body['certificate'] as CertRow)['certificate_id'] as string;

    // The corrected certificate's dates drive the next scan: at valid_until - 5 every due stage
    // fires at once (the 7.5 catch-up rule), and the superseded certificate fires nothing more.
    const scanRes = await scan(addDays(correctedValidUntil, -5), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(scanRes.status, 200, JSON.stringify(scanRes.body));
    assert.deepStrictEqual(await alertStagesForCertificate(correctedId), [7, 14, 30]);
    assert.deepStrictEqual(
      await alertStagesForCertificate(wrong['certificate_id'] as string),
      [30],
      'the superseded certificate keeps its fired alert history and fires nothing new',
    );
  });

  it('AC1/AC2 (Task 7.2): alert history fired for a certificate survives its void as audit history', async () => {
    const { instrumentRecordId } = await registerOk();
    const validUntil = addDays(ANCHOR, 365);
    const cert = await recordOk(instrumentRecordId, { valid_until: validUntil });
    const scanRes = await scan(addDays(validUntil, -30), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(scanRes.status, 200, JSON.stringify(scanRes.body));
    assert.deepStrictEqual(await alertStagesForCertificate(cert['certificate_id'] as string), [30]);

    const res = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.deepStrictEqual(
      await alertStagesForCertificate(cert['certificate_id'] as string),
      [30],
      'the fired alert rows are retained after the void (Binding Decision 7)',
    );
    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'voided');
  });

  it('AC2: a supersede targeting anything but the current active certificate is CERTIFICATE_NOT_SUPERSEDABLE', async () => {
    const { instrumentRecordId } = await registerOk();
    const first = await recordOk(instrumentRecordId);
    await recordOk(instrumentRecordId); // renewal-supersedes first

    const res = await supersedeCertificateRoute(
      instrumentRecordId,
      first['certificate_id'] as string,
      { certificate_number: `CERT-7-10-TGT-${run}` },
    );
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CERTIFICATE_NOT_SUPERSEDABLE');
    assert.strictEqual(
      (await certificateRow(first['certificate_id'] as string))?.['status'],
      'superseded',
      'the non-current target is untouched',
    );
    assert.strictEqual(
      (await certificatesByStatus(instrumentRecordId, 'active')).length,
      1,
      'exactly one active certificate remains',
    );
  });

  // -------------------------------------------------------------------------
  // AC 3: voiding the only certificate locks the instrument out immediately
  // -------------------------------------------------------------------------

  it('AC3: voiding the only certificate flips out_of_calibration and the 1.7 gate holds non-overridably', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);

    const res = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body['calibration_status'], 'out_of_calibration');
    assert.strictEqual(res.body['reactivated_certificate_id'], null);

    const eventsBefore = await domainEventCountFor(
      'instrument.calibration_status_updated',
      'instrument_id',
      instrumentId,
    );
    const before = await statusOf(instrumentId);
    assert.strictEqual(before?.['calibration_status'], 'out_of_calibration');

    // The Story 1.7 gate bars every role with no override path, by construction.
    const qc = await qcResult(instrumentId);
    assert.strictEqual(qc.status, 423, JSON.stringify(qc.body));
    assert.strictEqual(qc.body['error_code'], 'CALIBRATION_LOCKOUT');

    const reinstate = await makeRequest(
      port,
      'PUT',
      `/api/v1/instruments/${instrumentId}/calibration-status`,
      { calibration_status: 'calibrated', reason: 'Supervisor says it is fine' },
      qcAuthorityHeaders,
    );
    assert.strictEqual(reinstate.status, 423, JSON.stringify(reinstate.body));
    assert.strictEqual(reinstate.body['error_code'], 'CALIBRATION_LOCKOUT');

    // 7.5 review lesson 14: byte-identical negative-property assertions after both rejections.
    assert.deepStrictEqual(await statusOf(instrumentId), before);
    assert.strictEqual(
      await domainEventCountFor('instrument.calibration_status_updated', 'instrument_id', instrumentId),
      eventsBefore,
      'no event is written by a rejected lockdown or reinstatement',
    );
  });

  // -------------------------------------------------------------------------
  // AC 4: DOA authority and per-certificate SOD, re-derived under the lock
  // -------------------------------------------------------------------------

  it('AC4: the DOA holder (not the recorder) may void; the recorder may not, even while holding the band', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);

    // The recorder does not hold the qc_head band at all.
    const nonHolder = await voidCertificateRoute(
      instrumentRecordId,
      cert['certificate_id'] as string,
      {},
      recorderHeaders,
    );
    assert.strictEqual(nonHolder.status, 403, JSON.stringify(nonHolder.body));
    assert.strictEqual(nonHolder.body['error_code'], 'APPROVAL_REQUIRED');

    // The DOA holder voids another person's certificate.
    const res = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });

  it('AC4: the DOA holder who RECORDED the certificate cannot void or correct it (per-certificate SOD)', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    // Record as the qcAuthority user so the DOA holder IS the recorder on this certificate.
    const asAuthority = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates`,
      {
        calibration_type: 'in_house',
        certificate_number: `CERT-7-10-SOD-${run}`,
        issuing_lab: null,
        calibrated_on: ANCHOR,
        valid_until: addDays(ANCHOR, 365),
        business_date: ANCHOR,
      },
      qcAuthorityHeaders,
    );
    assert.strictEqual(asAuthority.status, 201, JSON.stringify(asAuthority.body));
    const ownCert = asAuthority.body['certificate'] as CertRow;

    const voidRes = await voidCertificateRoute(instrumentRecordId, ownCert['certificate_id'] as string);
    assert.strictEqual(voidRes.status, 403, JSON.stringify(voidRes.body));
    assert.strictEqual(voidRes.body['error_code'], 'CERTIFICATE_RECORDER_CANNOT_CORRECT');

    const supRes = await supersedeCertificateRoute(instrumentRecordId, ownCert['certificate_id'] as string);
    assert.strictEqual(supRes.status, 403, JSON.stringify(supRes.body));
    assert.strictEqual(supRes.body['error_code'], 'CERTIFICATE_RECORDER_CANNOT_CORRECT');

    // Neither refusal touched the row.
    const row = await certificateRow(ownCert['certificate_id'] as string);
    assert.strictEqual(row?.['status'], 'active');
    assert.strictEqual(row?.['void_reason'], null);

    // The same legs on the direct-event path, where there is no route at all.
    await assert.rejects(
      () =>
        directVoid({
          certificate_id: ownCert['certificate_id'],
          instrument_record_id: instrumentRecordId,
          instrument_id: instrumentId,
          void_reason: 'self-void attempt',
          voided_by: qcAuthorityUserId,
          business_date: ANCHOR,
        }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'CERTIFICATE_RECORDER_CANNOT_CORRECT');
        return true;
      },
    );
  });

  it('AC4 twin: the correction branch rejects the recorder and non-holders on the DIRECT persistEvent door', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    // Record as the authority so the recorder IS the DOA holder on this certificate.
    const asAuthority = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates`,
      {
        calibration_type: 'in_house',
        certificate_number: `cert-7-10-soddirect-${run}`,
        issuing_lab: null,
        calibrated_on: ANCHOR,
        valid_until: addDays(ANCHOR, 365),
        business_date: ANCHOR,
      },
      qcAuthorityHeaders,
    );
    assert.strictEqual(asAuthority.status, 201, JSON.stringify(asAuthority.body));
    const ownCert = asAuthority.body['certificate'] as CertRow;

    // SOD leg on the direct recorded door: the corrector is the certificate's recorder.
    await assert.rejects(
      () =>
        directRecord(instrumentRecordId, instrumentId, {
          supersedes_certificate_id: ownCert['certificate_id'],
          supersede_reason: 'direct self-correction attempt',
        }),
      (err: unknown) => {
        assert.strictEqual(
          (err as { errorCode: string }).errorCode,
          'CERTIFICATE_RECORDER_CANNOT_CORRECT',
        );
        return true;
      },
    );

    // Non-holder leg on both direct doors: the recorder holds no qc_head band.
    await assert.rejects(
      () =>
        directRecord(
          instrumentRecordId,
          instrumentId,
          {
            supersedes_certificate_id: ownCert['certificate_id'],
            supersede_reason: 'direct non-holder correction attempt',
          },
          recorderUserId,
        ),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'APPROVAL_REQUIRED');
        return true;
      },
    );
    await assert.rejects(
      () =>
        directVoid(
          {
            certificate_id: ownCert['certificate_id'],
            instrument_record_id: instrumentRecordId,
            instrument_id: instrumentId,
            void_reason: 'direct non-holder void attempt',
            voided_by: recorderUserId,
            business_date: ANCHOR,
          },
          recorderUserId,
        ),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'APPROVAL_REQUIRED');
        return true;
      },
    );

    // No-DOA-entry leg on the direct doors fails closed as APPROVAL_UNRESOLVED.
    const adminPool = getAdminPool();
    await adminPool.query(`UPDATE doa_registry_entries SET active = false WHERE entry_id = ANY($1)`, [
      [voidDoaEntryId, supersedeDoaEntryId],
    ]);
    try {
      await assert.rejects(
        () =>
          directVoid({
            certificate_id: ownCert['certificate_id'],
            instrument_record_id: instrumentRecordId,
            instrument_id: instrumentId,
            void_reason: 'direct no-band void attempt',
            voided_by: qcAuthorityUserId,
            business_date: ANCHOR,
          }),
        (err: unknown) => {
          assert.strictEqual((err as { errorCode: string }).errorCode, 'APPROVAL_UNRESOLVED');
          assert.strictEqual((err as { statusCode: number }).statusCode, 404);
          return true;
        },
      );
      await assert.rejects(
        () =>
          directRecord(instrumentRecordId, instrumentId, {
            supersedes_certificate_id: ownCert['certificate_id'],
            supersede_reason: 'direct no-band correction attempt',
          }),
        (err: unknown) => {
          assert.strictEqual((err as { errorCode: string }).errorCode, 'APPROVAL_UNRESOLVED');
          assert.strictEqual((err as { statusCode: number }).statusCode, 404);
          return true;
        },
      );
    } finally {
      await adminPool.query(`UPDATE doa_registry_entries SET active = true WHERE entry_id = ANY($1)`, [
        [voidDoaEntryId, supersedeDoaEntryId],
      ]);
    }
    assert.strictEqual((await certificateRow(ownCert['certificate_id'] as string))?.['status'], 'active');

    // Non-active target leg on the direct door: a superseded certificate cannot be corrected.
    const first = await recordOk(instrumentRecordId);
    const latest = await recordOk(instrumentRecordId); // renewal-supersedes first
    await assert.rejects(
      () =>
        directRecord(instrumentRecordId, instrumentId, {
          supersedes_certificate_id: first['certificate_id'],
          supersede_reason: 'direct non-active target attempt',
        }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'CERTIFICATE_NOT_SUPERSEDABLE');
        return true;
      },
    );

    // Route leg: APPROVAL_REQUIRED on the supersede route for a non-holder (recorder). The DOA
    // check precedes the SOD check, so a non-holder targeting the CURRENT active certificate gets
    // APPROVAL_REQUIRED even though it also recorded it.
    const routeRes = await supersedeCertificateRoute(
      instrumentRecordId,
      latest['certificate_id'] as string,
      {},
      recorderHeaders,
    );
    assert.strictEqual(routeRes.status, 403, JSON.stringify(routeRes.body));
    assert.strictEqual(routeRes.body['error_code'], 'APPROVAL_REQUIRED');
  });

  it('AC4: with no DOA entry the authority check fails closed as 404 APPROVAL_UNRESOLVED', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    const adminPool = getAdminPool();

    await adminPool.query(`UPDATE doa_registry_entries SET active = false WHERE entry_id = $1`, [
      voidDoaEntryId,
    ]);
    try {
      const res = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string);
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
    } finally {
      await adminPool.query(`UPDATE doa_registry_entries SET active = true WHERE entry_id = $1`, [
        voidDoaEntryId,
      ]);
    }
    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');

    await adminPool.query(`UPDATE doa_registry_entries SET active = false WHERE entry_id = $1`, [
      supersedeDoaEntryId,
    ]);
    try {
      const res = await supersedeCertificateRoute(instrumentRecordId, cert['certificate_id'] as string);
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
      assert.strictEqual(res.body['error_code'], 'APPROVAL_UNRESOLVED');
    } finally {
      await adminPool.query(`UPDATE doa_registry_entries SET active = true WHERE entry_id = $1`, [
        supersedeDoaEntryId,
      ]);
    }
    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');
  });

  // -------------------------------------------------------------------------
  // Direct-event doors and edge gate (Binding Decision 4, Task 8.3)
  // -------------------------------------------------------------------------

  it('forgery: a void declaring a wrong instrument_id or a wrong voided_by rejects 409 CALIBRATION_DERIVATION_MISMATCH', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    const base = {
      certificate_id: cert['certificate_id'] as string,
      instrument_record_id: instrumentRecordId,
      void_reason: 'forged direct void',
      voided_by: qcAuthorityUserId,
      business_date: ANCHOR,
    };

    await assert.rejects(
      () => directVoid({ ...base, instrument_id: `FORGED-${run}` }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'CALIBRATION_DERIVATION_MISMATCH');
        assert.strictEqual((err as { statusCode: number }).statusCode, 409);
        return true;
      },
    );

    await assert.rejects(
      () => directVoid({ ...base, instrument_id: instrumentId, voided_by: recorderUserId }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'CALIBRATION_DERIVATION_MISMATCH');
        assert.strictEqual((err as { statusCode: number }).statusCode, 409);
        return true;
      },
    );

    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');
  });

  it('forgery: caller-declared server-derived fields on the void event are refused by the shape assert', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    const base = {
      certificate_id: cert['certificate_id'] as string,
      instrument_record_id: instrumentRecordId,
      instrument_id: instrumentId,
      void_reason: 'forged direct void',
      voided_by: qcAuthorityUserId,
      business_date: ANCHOR,
    };

    for (const extra of [
      { reactivated_certificate_id: randomUUID() },
      { resulting_calibration_status: 'calibrated' },
      { voided_at: new Date().toISOString() },
    ]) {
      await assert.rejects(
        () => directVoid({ ...base, ...extra }),
        (err: unknown) => {
          assert.strictEqual((err as { errorCode: string }).errorCode, 'INVALID_PAYLOAD');
          return true;
        },
        JSON.stringify(extra),
      );
    }
    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');
  });

  it('forgery: a backdated business_date on a direct void rejects instead of reactivating a lapsed certificate', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const renewal = await recordOk(instrumentRecordId);
    const current = await recordOk(instrumentRecordId);
    await assert.rejects(
      () =>
        directVoid({
          certificate_id: current['certificate_id'],
          instrument_record_id: instrumentRecordId,
          instrument_id: instrumentId,
          void_reason: 'backdated void attempt',
          voided_by: qcAuthorityUserId,
          business_date: addDays(ANCHOR, -10),
        }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'CALIBRATION_DERIVATION_MISMATCH');
        assert.strictEqual((err as { statusCode: number }).statusCode, 409);
        return true;
      },
    );
    assert.strictEqual((await certificateRow(current['certificate_id'] as string))?.['status'], 'active');
    assert.strictEqual((await certificateRow(renewal['certificate_id'] as string))?.['status'], 'superseded');
  });

  it('forgery: a certificate cannot supersede itself (direct door, before any seam state check)', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    await assert.rejects(
      () =>
        directRecord(instrumentRecordId, instrumentId, {
          certificate_id: cert['certificate_id'],
          supersedes_certificate_id: cert['certificate_id'],
          supersede_reason: 'self-supersede attempt',
        }),
      (err: unknown) => {
        assert.strictEqual((err as { errorCode: string }).errorCode, 'INVALID_PAYLOAD');
        assert.strictEqual((err as { statusCode: number }).statusCode, 400);
        return true;
      },
    );
    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');
  });

  it('voidability: a certificate that is already voided rejects 409 CERTIFICATE_NOT_VOIDABLE; unknown is 404 CERTIFICATE_NOT_FOUND', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    assert.strictEqual(
      (await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string)).status,
      200,
    );

    const again = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'CERTIFICATE_NOT_VOIDABLE');

    // Unknown certificate id is 404 CERTIFICATE_NOT_FOUND on both routes.
    const missingVoid = await voidCertificateRoute(instrumentRecordId, randomUUID());
    assert.strictEqual(missingVoid.status, 404, JSON.stringify(missingVoid.body));
    assert.strictEqual(missingVoid.body['error_code'], 'CERTIFICATE_NOT_FOUND');
    const missingSup = await supersedeCertificateRoute(instrumentRecordId, randomUUID());
    assert.strictEqual(missingSup.status, 409, JSON.stringify(missingSup.body));
    assert.strictEqual(missingSup.body['error_code'], 'CERTIFICATE_NOT_SUPERSEDABLE');
  });

  it('edge: an edge upload of the void event rejects 403 CENTRAL_ONLY_OPERATION', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    const eventId = randomUUID();
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/edge/events',
      {
        event_id: eventId,
        stream_type: 'maintenance',
        stream_id: cert['certificate_id'],
        event_type: 'maintenance.calibration_certificate_voided',
        event_version: 1,
        payload: {
          certificate_id: cert['certificate_id'],
          instrument_record_id: instrumentRecordId,
          instrument_id: instrumentId,
          void_reason: 'captured offline',
          voided_by: qcAuthorityUserId,
          business_date: ANCHOR,
        },
        metadata: {
          correlation_id: randomUUID(),
          actor: { user_id: qcAuthorityUserId, role: 'qc_head', location_id: siteLocId },
          device_id: DEVICE_ID,
          capture_method: 'MANUAL',
          occurred_at: new Date().toISOString(),
        },
        schema_version: 1,
        idempotency_key: `edge-7-10-${eventId}`,
      },
      qcAuthorityHeaders,
    );
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body['error_code'], 'CENTRAL_ONLY_OPERATION');
    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');
  });

  // -------------------------------------------------------------------------
  // Replay and concurrency (7.5 review lesson 11: race the same key)
  // -------------------------------------------------------------------------

  it('replay: a same-key void returns the stored event and the ledger does not grow', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    const key = randomUUID();

    const first = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string, {
      idempotency_key: key,
    });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    const replay = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string, {
      idempotency_key: key,
    });
    assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
    assert.strictEqual(replay.body['event_id'], first.body['event_id']);
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_certificate_voided',
        'certificate_id',
        cert['certificate_id'] as string,
      ),
      1,
      'the ledger did not grow on replay',
    );
  });

  it('replay: a consumed void or supersede key retried against a DIFFERENT certificate URL is 409 DUPLICATE_EVENT, never a phantom 200', async () => {
    const { instrumentRecordId } = await registerOk();
    const certA = await recordOk(instrumentRecordId);
    const certB = await recordOk(instrumentRecordId);
    const key = randomUUID();

    const first = await voidCertificateRoute(instrumentRecordId, certA['certificate_id'] as string, {
      idempotency_key: key,
    });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    // Same key against a different certificate's void URL: the stored event's stream does not
    // match the URL anchor, so it is a key misuse, not a replay.
    const wrongTarget = await voidCertificateRoute(
      instrumentRecordId,
      certB['certificate_id'] as string,
      { idempotency_key: key },
    );
    assert.strictEqual(wrongTarget.status, 409, JSON.stringify(wrongTarget.body));
    assert.strictEqual(wrongTarget.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((await certificateRow(certB['certificate_id'] as string))?.['status'], 'active');

    // Same shape on the supersede route: the payload's supersedes_certificate_id anchors the URL.
    const supKey = randomUUID();
    const { instrumentRecordId: secondInstrument } = await registerOk();
    const wrongCert = await recordOk(secondInstrument);
    const supFirst = await supersedeCertificateRoute(
      secondInstrument,
      wrongCert['certificate_id'] as string,
      { idempotency_key: supKey },
    );
    assert.strictEqual(supFirst.status, 201, JSON.stringify(supFirst.body));

    const otherCert = await recordOk(secondInstrument);
    const supWrong = await supersedeCertificateRoute(
      secondInstrument,
      otherCert['certificate_id'] as string,
      { idempotency_key: supKey },
    );
    assert.strictEqual(supWrong.status, 409, JSON.stringify(supWrong.body));
    assert.strictEqual(supWrong.body['error_code'], 'DUPLICATE_EVENT');
    assert.strictEqual((await certificateRow(otherCert['certificate_id'] as string))?.['status'], 'active');
  });

  it('race: two concurrent voids of the same certificate produce exactly one success', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);

    const [a, b] = await Promise.all([
      voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string),
      voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], JSON.stringify({ a: a.body, b: b.body }));
    const loser = a.status === 409 ? a : b;
    assert.strictEqual(loser.body['error_code'], 'CERTIFICATE_NOT_VOIDABLE');
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_certificate_voided',
        'certificate_id',
        cert['certificate_id'] as string,
      ),
      1,
    );
  });

  it('race: two concurrent correction-supersedes with the SAME number produce [201, 409 CERTIFICATE_ALREADY_RECORDED]', async () => {
    const { instrumentRecordId } = await registerOk();
    const wrong = await recordOk(instrumentRecordId);
    const number = `CERT-7-10-RACE-${run}`;

    const [a, b] = await Promise.all([
      supersedeCertificateRoute(instrumentRecordId, wrong['certificate_id'] as string, {
        certificate_number: number,
      }),
      supersedeCertificateRoute(instrumentRecordId, wrong['certificate_id'] as string, {
        certificate_number: number,
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], JSON.stringify({ a: a.body, b: b.body }));
    const loser = a.status === 409 ? a : b;
    assert.strictEqual(loser.body['error_code'], 'CERTIFICATE_ALREADY_RECORDED');
    assert.strictEqual(
      (await certificatesByStatus(instrumentRecordId, 'active')).length,
      1,
      'exactly one active certificate survives the race',
    );
  });

  // -------------------------------------------------------------------------
  // Boundary and RBAC
  // -------------------------------------------------------------------------

  it('boundary: void_reason blank, whitespace or over-length rejects 400 before any event is minted', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);
    for (const voidReason of ['', '   ', 'x'.repeat(513)]) {
      const res = await voidCertificateRoute(instrumentRecordId, cert['certificate_id'] as string, {
        void_reason: voidReason,
      });
      assert.strictEqual(res.status, 400, JSON.stringify({ voidReason, body: res.body }));
    }
    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_certificate_voided',
        'certificate_id',
        cert['certificate_id'] as string,
      ),
      0,
    );
  });

  it('boundary: an impossible date and an already-lapsed corrected certificate are rejected with explicit codes', async () => {
    const { instrumentRecordId } = await registerOk();
    const wrong = await recordOk(instrumentRecordId);

    const impossible = await supersedeCertificateRoute(
      instrumentRecordId,
      wrong['certificate_id'] as string,
      { valid_until: '2026-02-30' },
    );
    assert.strictEqual(impossible.status, 400, JSON.stringify(impossible.body));
    assert.strictEqual(impossible.body['error_code'], 'INVALID_CERTIFICATE_VALIDITY');

    // valid_until >= calibrated_on but already lapsed against business_date: the route-level
    // window check passes, and the seam's 7.5 rule rejects 422 CERTIFICATE_EXPIRED.
    // valid_until >= calibrated_on passes the route's own window check, so the seam's
    // CERTIFICATE_EXPIRED guard (valid_until before business_date) is what rejects.
    const lapsed = await supersedeCertificateRoute(
      instrumentRecordId,
      wrong['certificate_id'] as string,
      { calibrated_on: ANCHOR, valid_until: ANCHOR, business_date: addDays(ANCHOR, 1) },
    );
    assert.strictEqual(lapsed.status, 422, JSON.stringify(lapsed.body));
    assert.strictEqual(lapsed.body['error_code'], 'CERTIFICATE_EXPIRED');

    assert.strictEqual((await certificateRow(wrong['certificate_id'] as string))?.['status'], 'active');
  });

  it('RBAC: no token is 401; an outsider module is 403; a read-scoped maintenance caller is 403', async () => {
    const { instrumentRecordId } = await registerOk();
    const cert = await recordOk(instrumentRecordId);

    for (const suffix of ['void', 'supersede']) {
      const path = `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates/${cert['certificate_id']}/${suffix}`;
      const body =
        suffix === 'void'
          ? { void_reason: 'rbac probe' }
          : {
              calibration_type: 'in_house',
              certificate_number: `CERT-7-10-RBAC-${suffix}-${run}`,
              issuing_lab: null,
              calibrated_on: ANCHOR,
              valid_until: addDays(ANCHOR, 300),
              business_date: ANCHOR,
              supersede_reason: 'rbac probe',
            };

      const anonymous = await makeRequest(port, 'POST', path, body, {});
      assert.strictEqual(anonymous.status, 401, `${suffix}: ${JSON.stringify(anonymous.body)}`);

      const outsider = await makeRequest(port, 'POST', path, body, outsiderHeaders);
      assert.strictEqual(outsider.status, 403, `${suffix}: ${JSON.stringify(outsider.body)}`);

      const reader = await makeRequest(port, 'POST', path, body, readerHeaders);
      assert.strictEqual(reader.status, 403, `${suffix}: ${JSON.stringify(reader.body)}`);
    }

    assert.strictEqual((await certificateRow(cert['certificate_id'] as string))?.['status'], 'active');
  });
});

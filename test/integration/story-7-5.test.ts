import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAppRouter, createAppServer } from '../../src/server.js';
import { closePool, closeAdminPool, getAdminPool, getPool } from '../../src/config/db.js';
import { persistEvent } from '../../src/events/store.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 7.5: Calibration Register and Non-Overridable Lockout (FR-M-12, FR-M-13, AD-8). Runs
// against the PRODUCTION router surface (createAppRouter) with real auth, RBAC and PostgreSQL - no
// mocks of the DB or the event store. The harness is the Story 7.4 pattern narrowed to the
// projections this story rides on.
//
// Time is controlled entirely through the explicit business_date parameter of the scan and through
// the certificate validity dates, so no clock mocking is needed. The maintenance stream is blocked
// at the direct-events HTTP guard (INVALID_EVENT_STREAM), so the seam-level rejection codes
// (CALIBRATION_DERIVATION_MISMATCH, DUPLICATE_CALIBRATION_ALERT) are exercised through direct
// persistEvent calls - the enforcement surface a direct write would actually hit.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCIM_HEADERS = { Authorization: 'Bearer test-only-scim-bearer-token-not-for-production-use' };
const run = randomUUID().slice(0, 8);

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

function detailsOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const details = body['details'];
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
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

/** Whole-day UTC arithmetic on an ISO date, matching the handler and job helpers. */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(y!, m! - 1, d!) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * A FIXED anchor date, deliberately not derived from the wall clock. Every validity window and
 * business_date in this suite is expressed relative to it, so no test can flip on a clock-window
 * boundary the way the story-5-2 and story-5-3 flakes do.
 */
const ANCHOR = '2026-06-01';

describe('Story 7.5 Calibration Register and Non-Overridable Lockout', () => {
  let server: Server;
  let port: number;
  let siteLocId: string;
  let schedulerUserId: string;
  let schedulerHeaders: Record<string, string>;
  let readerHeaders: Record<string, string>;
  let qcHeaders: Record<string, string>;
  let complianceHeaders: Record<string, string>;
  let doaEntryId: string;

  // --- helpers -------------------------------------------------------------

  async function seedLocation(codeSuffix: string): Promise<string> {
    const r = await getPool().query(
      `INSERT INTO location_register (location_id, location_code, level, site_id, zone_type, temperature_class, status)
       VALUES ($1, $2, 'zone', $3, 'general', 'ambient', 'active') RETURNING location_id`,
      [randomUUID(), `LOC-7-5-${run}-${codeSuffix}`, randomUUID()],
    );
    return r.rows[0]!['location_id'] as string;
  }

  async function createAsset(): Promise<string> {
    const res = await makeRequest(
      port,
      'POST',
      '/api/v1/assets',
      {
        asset_tag: `TAG-7-5-${randomUUID().slice(0, 12)}`,
        asset_name: `Instrument ${run} ${randomUUID().slice(0, 4)}`,
        criticality_class: 'critical',
      },
      schedulerHeaders,
    );
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return (res.body['asset'] as Record<string, string>)['asset_id']!;
  }

  let instrumentCounter = 0;
  function nextInstrumentId(): string {
    instrumentCounter += 1;
    return `INS-7-5-${run}-${instrumentCounter}`;
  }

  async function registerInstrument(
    extra: Record<string, unknown> = {},
  ): Promise<{ res: HttpResult; instrumentId: string; assetId: string }> {
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
      schedulerHeaders,
    );
    return { res, instrumentId, assetId };
  }

  /** Registers an instrument and returns its record id, failing loudly if registration did not. */
  async function registerOk(
    extra: Record<string, unknown> = {},
  ): Promise<{ instrumentRecordId: string; instrumentId: string; assetId: string }> {
    const { res, assetId } = await registerInstrument(extra);
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
        certificate_number: `CERT-${randomUUID().slice(0, 8)}`,
        issuing_lab: null,
        calibrated_on: ANCHOR,
        valid_until: addDays(ANCHOR, 365),
        business_date: ANCHOR,
        ...body,
      },
      schedulerHeaders,
    );
  }

  async function raiseEscalation(
    instrumentRecordId: string,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/escalations`,
      { reason: 'Production line blocked', ...body },
      schedulerHeaders,
    );
  }

  async function resolveEscalationRoute(
    escalationId: string,
    body: Record<string, unknown> = {},
  ): Promise<HttpResult> {
    return makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/calibration/escalations/${escalationId}/resolve`,
      body,
      schedulerHeaders,
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
      schedulerHeaders,
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

  async function statusRowCount(instrumentId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM instrument_calibration_statuses WHERE lower(instrument_id) = lower($1)`,
      [instrumentId],
    );
    return r.rows[0]!['n'] as number;
  }

  async function certificateCount(instrumentRecordId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM instrument_calibration_certificate WHERE instrument_record_id = $1`,
      [instrumentRecordId],
    );
    return r.rows[0]!['n'] as number;
  }

  async function alertStagesFor(instrumentRecordId: string): Promise<number[]> {
    const r = await getAdminPool().query(
      `SELECT stage_days FROM instrument_calibration_alert
        WHERE instrument_record_id = $1 ORDER BY stage_days ASC`,
      [instrumentRecordId],
    );
    return r.rows.map((row) => row['stage_days'] as number);
  }

  async function escalationRow(escalationId: string): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT escalation_id, status, resolving_certificate_id, resolved_at
         FROM instrument_calibration_escalation WHERE escalation_id = $1`,
      [escalationId],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
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

  async function notificationFor(
    objectId: string,
    eventType: string,
  ): Promise<Record<string, unknown> | null> {
    const r = await getAdminPool().query(
      `SELECT payload->'target'->>'role' AS role,
              payload->'target'->>'location_id' AS location_id,
              payload->'target'->>'user_id' AS user_id,
              payload->>'next_step' AS next_step,
              payload->>'actor_label' AS actor_label,
              payload->'escalation'->>'target_role' AS escalation_role,
              payload->'escalation'->>'acknowledgment_window_seconds' AS escalation_window
         FROM domain_events
        WHERE event_type = 'notification.created'
          AND payload->>'object_id' = $1
          AND payload->>'event_type' = $2`,
      [objectId, eventType],
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  }

  /**
   * Replicates src/notify/dispatch.ts resolveTargetUserIds exactly. A notification aimed at a role
   * no user holds fans out to zero recipients and still reports success, so asserting the event
   * exists is NOT enough to prove the alert is deliverable (the Story 7.4 lesson).
   */
  async function recipientCountFor(role: string, locationId: string): Promise<number> {
    const r = await getAdminPool().query(
      `SELECT count(DISTINCT user_id)::int AS n FROM user_role_assignments
        WHERE role = $1 AND (location_id = $2 OR location_id = '*')`,
      [role, locationId],
    );
    return r.rows[0]!['n'] as number;
  }

  /** The actor stamp every direct-persistEvent forgery test uses. */
  function forgedMetadata(): Record<string, unknown> {
    return {
      correlation_id: randomUUID(),
      actor: { user_id: schedulerUserId, role: 'calibration_scheduler', location_id: siteLocId },
      occurred_at: new Date().toISOString(),
    };
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
      '../../read/projections/item_master.sql',
      '../../read/projections/location_register.sql',
      '../../read/projections/asset.sql',
      '../../read/projections/instrument_register.sql',
      '../../read/projections/instrument_calibration_certificate.sql',
      '../../read/projections/instrument_calibration_alert.sql',
      '../../read/projections/instrument_calibration_escalation.sql',
    ]) {
      await adminPool.query(readFileSync(resolve(__dirname, file), 'utf-8'));
    }
    await adminPool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_tamper_attempt_log DISABLE TRIGGER ALL');
    await adminPool.query('ALTER TABLE audit_log_archive DISABLE TRIGGER ALL');
    try {
      await adminPool.query(
        'TRUNCATE instrument_calibration_escalation, instrument_calibration_alert, instrument_calibration_certificate, instrument_register, instrument_calibration_statuses, asset, location_register, notification_escalations, notification_escalation_defs, notification_deliveries, notification_dispatch_attempts, notification_dispatch_log, notifications, doa_vacation_delegations, doa_registry_entries, audit_log_tamper_attempt_log, audit_log_archive, audit_log, user_role_assignments, users, domain_events CASCADE',
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

    // The scheduler holds the LITERAL role the staged alert targets and the DOA entry routes to.
    // Provisioning it under a run-suffixed name would leave every alert undeliverable in production
    // while this suite still passed, which is exactly the failure this user exists to catch.
    schedulerUserId = await provisionUser(port, `cal-scheduler-7-5-${run}@example.com`, [
      {
        role: 'calibration_scheduler',
        module: 'maintenance',
        functionScope: 'write',
        locationId: '*',
      },
      {
        role: 'calibration_scheduler',
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    schedulerHeaders = await authFor(port, `cal-scheduler-7-5-${run}@example.com`);

    await provisionUser(port, `cal-reader-7-5-${run}@example.com`, [
      {
        role: `maintenance_reader_7_5_${run}`,
        module: 'maintenance',
        functionScope: 'read',
        locationId: '*',
      },
    ]);
    readerHeaders = await authFor(port, `cal-reader-7-5-${run}@example.com`);

    await provisionUser(port, `cal-qc-7-5-${run}@example.com`, [
      { role: 'qc_inspector', module: 'qc', functionScope: 'write', locationId: '*' },
    ]);
    qcHeaders = await authFor(port, `cal-qc-7-5-${run}@example.com`);

    await provisionUser(port, `cal-compliance-7-5-${run}@example.com`, [
      { role: 'compliance_admin', module: 'compliance', functionScope: 'write', locationId: '*' },
    ]);
    complianceHeaders = await authFor(port, `cal-compliance-7-5-${run}@example.com`);

    const doa = await makeRequest(
      port,
      'POST',
      '/api/v1/doa/entries',
      {
        role: 'calibration_scheduler',
        transaction_type: 'calibration.escalation',
        value_min: null,
        value_max: null,
      },
      complianceHeaders,
    );
    assert.strictEqual(doa.status, 201, JSON.stringify(doa.body));
    doaEntryId = doa.body['entry_id'] as string;
  });

  after(async () => {
    if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await closePool();
    await closeAdminPool();
  });

  // -------------------------------------------------------------------------
  // AC 1: register, certificates, staged 30/14/7 alerts
  // -------------------------------------------------------------------------

  it('AC1: an in-house certificate is stored with its validity dates and calibrates the instrument', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();

    const before = await statusOf(instrumentId);
    assert.strictEqual(before?.['calibration_status'], 'out_of_calibration');

    const res = await recordCertificate(instrumentRecordId, {
      certificate_number: `IH-${run}-1`,
      calibrated_on: ANCHOR,
      valid_until: addDays(ANCHOR, 180),
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const certificate = res.body['certificate'] as Record<string, unknown>;
    assert.strictEqual(certificate['calibration_type'], 'in_house');
    assert.strictEqual(certificate['calibrated_on'], ANCHOR);
    assert.strictEqual(certificate['valid_until'], addDays(ANCHOR, 180));
    assert.strictEqual(certificate['status'], 'active');
    assert.strictEqual(res.body['calibration_status'], 'calibrated');

    // The gate reads the status row, so calibrated must mean a QC result is actually accepted.
    const qc = await qcResult(instrumentId);
    assert.strictEqual(qc.status, 201, JSON.stringify(qc.body));
  });

  it('AC1: an ISO 17025 certificate is stored with its issuing laboratory and one without is rejected', async () => {
    const { instrumentRecordId } = await registerOk();

    const missingLab = await recordCertificate(instrumentRecordId, {
      calibration_type: 'iso_17025',
      issuing_lab: null,
    });
    assert.strictEqual(missingLab.status, 400, JSON.stringify(missingLab.body));
    assert.strictEqual(missingLab.body['error_code'], 'INVALID_CALIBRATION_TYPE');

    const accredited = await recordCertificate(instrumentRecordId, {
      calibration_type: 'iso_17025',
      issuing_lab: 'NABL Lab 4471',
      certificate_number: `ISO-${run}-1`,
    });
    assert.strictEqual(accredited.status, 201, JSON.stringify(accredited.body));
    const certificate = accredited.body['certificate'] as Record<string, unknown>;
    assert.strictEqual(certificate['calibration_type'], 'iso_17025');
    assert.strictEqual(certificate['issuing_lab'], 'NABL Lab 4471');
  });

  it('AC1: alerts fire at exactly 30, 14 and 7 days before expiry, once per stage', async () => {
    const { instrumentRecordId } = await registerOk();
    const validUntil = addDays(ANCHOR, 100);
    const recorded = await recordCertificate(instrumentRecordId, {
      certificate_number: `STG-${run}-1`,
      valid_until: validUntil,
    });
    assert.strictEqual(recorded.status, 201, JSON.stringify(recorded.body));

    // 31 days out: nothing is due yet. This is the assertion that would fail if the stage test
    // were written as "<= 31" or as an open-ended countdown.
    const tooEarly = await scan(addDays(validUntil, -31), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(tooEarly.status, 200, JSON.stringify(tooEarly.body));
    assert.strictEqual(tooEarly.body['alerts_raised'], 0);

    for (const stage of [30, 14, 7]) {
      const res = await scan(addDays(validUntil, -stage), {
        instrument_record_id: instrumentRecordId,
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body['alerts_raised'], 1, `stage ${stage} should fire exactly once`);
    }
    assert.deepStrictEqual(await alertStagesFor(instrumentRecordId), [7, 14, 30]);
  });

  it('AC1: a scan skipped for several days fires every unfired stage on the next run, and a same-day re-run fires nothing', async () => {
    const { instrumentRecordId } = await registerOk();
    const validUntil = addDays(ANCHOR, 100);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `CATCH-${run}-1`,
          valid_until: validUntil,
        })
      ).status,
      201,
    );

    // Nothing has been scanned since the certificate was recorded; five days from expiry all three
    // stages are due and unfired. An equality test on the day count would have dropped all three.
    const catchUp = await scan(addDays(validUntil, -5), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(catchUp.status, 200, JSON.stringify(catchUp.body));
    assert.strictEqual(catchUp.body['alerts_raised'], 3);
    assert.deepStrictEqual(await alertStagesFor(instrumentRecordId), [7, 14, 30]);

    const rerun = await scan(addDays(validUntil, -5), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(rerun.status, 200, JSON.stringify(rerun.body));
    assert.strictEqual(
      rerun.body['alerts_raised'],
      0,
      'a same-day re-run is a no-op, not an error',
    );
    assert.deepStrictEqual(await alertStagesFor(instrumentRecordId), [7, 14, 30]);
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_expiry_flagged',
        'instrument_record_id',
        instrumentRecordId,
      ),
      3,
      'the same-day re-run must not grow the event ledger',
    );
  });

  it('AC1: a renewal issues a new certificate and therefore a fresh set of three stages', async () => {
    const { instrumentRecordId } = await registerOk();
    const firstValidUntil = addDays(ANCHOR, 60);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `REN-${run}-1`,
          valid_until: firstValidUntil,
        })
      ).status,
      201,
    );
    const firstScan = await scan(addDays(firstValidUntil, -5), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(firstScan.body['alerts_raised'], 3);

    const secondValidUntil = addDays(ANCHOR, 400);
    const renewal = await recordCertificate(instrumentRecordId, {
      certificate_number: `REN-${run}-2`,
      calibrated_on: addDays(ANCHOR, 35),
      valid_until: secondValidUntil,
      business_date: addDays(ANCHOR, 35),
    });
    assert.strictEqual(renewal.status, 201, JSON.stringify(renewal.body));

    // The superseded certificate is retained, not deleted, and is excluded from the scan.
    assert.strictEqual(await certificateCount(instrumentRecordId), 2);
    const history = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/instruments/${instrumentRecordId}/certificates`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(history.status, 200, JSON.stringify(history.body));
    const statuses = (history.body['certificates'] as Record<string, unknown>[]).map(
      (c) => c['status'],
    );
    assert.deepStrictEqual(statuses.slice().sort(), ['active', 'superseded']);

    const renewalScan = await scan(addDays(secondValidUntil, -5), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(
      renewalScan.body['alerts_raised'],
      3,
      'a renewal earns a fresh set of stages',
    );
    assert.strictEqual((await alertStagesFor(instrumentRecordId)).length, 6);
  });

  it('AC1: the staged alert notifies calibration_scheduler and resolves to at least one real recipient, escalating only at 7 days', async () => {
    const { instrumentRecordId } = await registerOk();
    const validUntil = addDays(ANCHOR, 100);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `NOTIF-${run}-1`,
          valid_until: validUntil,
        })
      ).status,
      201,
    );

    const thirty = await scan(addDays(validUntil, -30), {
      instrument_record_id: instrumentRecordId,
    });
    const thirtyAlertId = (thirty.body['alert_ids'] as string[])[0]!;
    assert.strictEqual(thirty.body['notifications_delivered'], 1);
    assert.strictEqual(thirty.body['notifications_dropped'], 0);

    const thirtyNotification = await notificationFor(thirtyAlertId, 'calibration_expiry_due');
    assert.ok(thirtyNotification, 'the 30-day stage must emit a notification');
    assert.strictEqual(thirtyNotification['role'], 'calibration_scheduler');
    assert.strictEqual(thirtyNotification['next_step'], 'Schedule re-calibration');
    assert.strictEqual(
      thirtyNotification['escalation_role'],
      null,
      'escalating a month-out reminder is noise',
    );
    assert.ok(
      await recipientCountFor('calibration_scheduler', siteLocId),
      'the alert must resolve to at least one real recipient, not fan out to zero',
    );

    const fourteen = await scan(addDays(validUntil, -14), {
      instrument_record_id: instrumentRecordId,
    });
    const fourteenAlertId = (fourteen.body['alert_ids'] as string[])[0]!;
    const fourteenNotification = await notificationFor(fourteenAlertId, 'calibration_expiry_due');
    assert.ok(fourteenNotification, 'the 14-day stage must emit a notification');
    assert.strictEqual(
      fourteenNotification['escalation_role'],
      null,
      'only the 7-day stage escalates; a 14-day reminder is still noise',
    );

    const seven = await scan(addDays(validUntil, -7), {
      instrument_record_id: instrumentRecordId,
    });
    const sevenAlertId = (seven.body['alert_ids'] as string[]).find(
      (id) => id !== thirtyAlertId,
    ) as string;
    const sevenNotification = await notificationFor(sevenAlertId, 'calibration_expiry_due');
    assert.ok(sevenNotification);
    assert.strictEqual(sevenNotification['escalation_role'], 'maintenance_manager');
    assert.strictEqual(sevenNotification['escalation_window'], '86400');
  });

  // -------------------------------------------------------------------------
  // AC 2: the non-overridable lockout
  // -------------------------------------------------------------------------

  it('AC2: a freshly registered instrument with no certificate is out of calibration and rejects a QC result', async () => {
    const { instrumentId } = await registerOk();

    // This is the assertion that catches an accidental ensureInstrumentCalibrationRow call, whose
    // 'calibrated' default would make every new instrument silently usable.
    assert.strictEqual(
      (await statusOf(instrumentId))?.['calibration_status'],
      'out_of_calibration',
    );

    const qc = await qcResult(instrumentId);
    assert.strictEqual(qc.status, 423, JSON.stringify(qc.body));
    assert.strictEqual(qc.body['error_code'], 'CALIBRATION_LOCKOUT');
    assert.strictEqual(
      await domainEventCountFor('qc.result_recorded', 'instrument_id', instrumentId),
      0,
    );
  });

  it('AC2: an expired certificate locks the instrument out end to end', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const validUntil = addDays(ANCHOR, 30);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `EXP-${run}-1`,
          valid_until: validUntil,
        })
      ).status,
      201,
    );
    assert.strictEqual((await qcResult(instrumentId)).status, 201);

    const flip = await scan(addDays(validUntil, 1), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(flip.status, 200, JSON.stringify(flip.body));
    assert.strictEqual(flip.body['instruments_expired'], 1);
    assert.strictEqual(
      (await statusOf(instrumentId))?.['calibration_status'],
      'out_of_calibration',
    );

    const blockedCountBefore = await domainEventCountFor(
      'qc.result_recorded',
      'instrument_id',
      instrumentId,
    );
    const qc = await qcResult(instrumentId);
    assert.strictEqual(qc.status, 423, JSON.stringify(qc.body));
    assert.strictEqual(qc.body['error_code'], 'CALIBRATION_LOCKOUT');
    assert.strictEqual(
      await domainEventCountFor('qc.result_recorded', 'instrument_id', instrumentId),
      blockedCountBefore,
      'a blocked QC result must write no event',
    );

    // A later scan finds nothing: the certificate is no longer active.
    const rerun = await scan(addDays(validUntil, 5), {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(rerun.body['instruments_expired'], 0);

    const notification = await notificationFor(instrumentRecordId, 'calibration_expired');
    assert.ok(notification, 'the expiry flip must notify');
    assert.strictEqual(
      notification['next_step'],
      'Instrument is locked out until a new certificate is recorded',
    );
    assert.strictEqual(notification['escalation_role'], 'maintenance_manager');
  });

  it("AC2 boundary: on the certificate's last valid day the stages fire but the instrument is NOT yet locked out", async () => {
    // The stage-due predicate is valid_until >= business_date (inclusive) while the expiry flip is
    // valid_until < business_date (strict). The equality day is where an off-by-one would hide: on
    // the last valid day every unfired stage is due (0 days remaining, so all three fire) but the
    // instrument must stay calibrated and a QC result must still pass, with zero calibration_expired
    // events.
    const { instrumentRecordId, instrumentId } = await registerOk();
    const validUntil = addDays(ANCHOR, 30);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `LASTDAY-${run}-1`,
          valid_until: validUntil,
        })
      ).status,
      201,
    );

    const boundary = await scan(validUntil, {
      instrument_record_id: instrumentRecordId,
    });
    assert.strictEqual(boundary.status, 200, JSON.stringify(boundary.body));
    assert.deepStrictEqual(await alertStagesFor(instrumentRecordId), [7, 14, 30]);
    assert.strictEqual(boundary.body['instruments_expired'], 0);
    assert.strictEqual(
      (await statusOf(instrumentId))?.['calibration_status'],
      'calibrated',
      'the expiry flip must be strictly after the last valid day',
    );
    assert.strictEqual((await qcResult(instrumentId)).status, 201);
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_expired',
        'instrument_record_id',
        instrumentRecordId,
      ),
      0,
    );
  });

  it('AC2: manual reinstatement of a registered instrument is rejected and leaves no trace', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const validUntil = addDays(ANCHOR, 10);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `MAN-${run}-1`,
          valid_until: validUntil,
        })
      ).status,
      201,
    );
    assert.strictEqual((await scan(addDays(validUntil, 1))).status, 200);
    assert.strictEqual(
      (await statusOf(instrumentId))?.['calibration_status'],
      'out_of_calibration',
    );

    const eventsBefore = await domainEventCountFor(
      'instrument.calibration_status_updated',
      'instrument_id',
      instrumentId,
    );
    const before = await statusOf(instrumentId);

    const reinstate = await makeRequest(
      port,
      'PUT',
      `/api/v1/instruments/${instrumentId}/calibration-status`,
      { calibration_status: 'calibrated', reason: 'Line manager says it is fine' },
      schedulerHeaders,
    );
    assert.strictEqual(reinstate.status, 423, JSON.stringify(reinstate.body));
    assert.strictEqual(reinstate.body['error_code'], 'CALIBRATION_LOCKOUT');

    assert.deepStrictEqual(
      await statusOf(instrumentId),
      before,
      'the status row must be byte-identical after a rejected reinstatement',
    );
    assert.strictEqual(
      await domainEventCountFor(
        'instrument.calibration_status_updated',
        'instrument_id',
        instrumentId,
      ),
      eventsBefore,
      'a rejected reinstatement must write no event',
    );
    assert.strictEqual((await qcResult(instrumentId)).status, 423);
  });

  it('AC2: locking a registered instrument down is still allowed, and an unregistered instrument keeps the Story 1.7 behaviour', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    assert.strictEqual(
      (await recordCertificate(instrumentRecordId, { certificate_number: `LOCK-${run}-1` })).status,
      201,
    );
    assert.strictEqual((await statusOf(instrumentId))?.['calibration_status'], 'calibrated');

    const lockDown = await makeRequest(
      port,
      'PUT',
      `/api/v1/instruments/${instrumentId}/calibration-status`,
      { calibration_status: 'out_of_calibration', reason: 'Dropped on the floor' },
      schedulerHeaders,
    );
    assert.strictEqual(lockDown.status, 200, JSON.stringify(lockDown.body));
    assert.strictEqual(
      (await statusOf(instrumentId))?.['calibration_status'],
      'out_of_calibration',
    );
    assert.strictEqual((await qcResult(instrumentId)).status, 423);

    // An id that is NOT in the register keeps the Story 1.7 admin behaviour exactly, which is what
    // keeps the Spine Acceptance Contract green.
    const unregistered = `UNREG-7-5-${run}`;
    const reinstated = await makeRequest(
      port,
      'PUT',
      `/api/v1/instruments/${unregistered}/calibration-status`,
      { calibration_status: 'calibrated', reason: 'Legacy admin path' },
      schedulerHeaders,
    );
    assert.strictEqual(reinstated.status, 200, JSON.stringify(reinstated.body));
    assert.strictEqual((await statusOf(unregistered))?.['calibration_status'], 'calibrated');
  });

  it('AC2: a case variant in the URL updates the registered instrument row instead of creating a second one', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    assert.strictEqual(
      (await recordCertificate(instrumentRecordId, { certificate_number: `CASE-${run}-1` })).status,
      201,
    );

    const upperCased = instrumentId.toUpperCase();
    assert.notStrictEqual(upperCased, instrumentId, 'the canonical id is lower-cased');
    const lockDown = await makeRequest(
      port,
      'PUT',
      `/api/v1/instruments/${upperCased}/calibration-status`,
      { calibration_status: 'out_of_calibration' },
      schedulerHeaders,
    );
    assert.strictEqual(lockDown.status, 200, JSON.stringify(lockDown.body));
    assert.strictEqual(await statusRowCount(instrumentId), 1);
    assert.strictEqual(
      (await statusOf(instrumentId))?.['calibration_status'],
      'out_of_calibration',
    );

    const reinstate = await makeRequest(
      port,
      'PUT',
      `/api/v1/instruments/${upperCased}/calibration-status`,
      { calibration_status: 'calibrated' },
      schedulerHeaders,
    );
    assert.strictEqual(reinstate.status, 423, 'a case variant is the same registered instrument');
  });

  // -------------------------------------------------------------------------
  // AC 3: escalation expedites, never bypasses
  // -------------------------------------------------------------------------

  it('AC3: an escalation on a locked-out instrument changes nothing about its calibration status', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const validUntil = addDays(ANCHOR, 20);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `ESC-${run}-1`,
          valid_until: validUntil,
        })
      ).status,
      201,
    );
    assert.strictEqual((await scan(addDays(validUntil, 1))).status, 200);

    const before = await statusOf(instrumentId);
    const certificatesBefore = await certificateCount(instrumentRecordId);
    assert.strictEqual(before?.['calibration_status'], 'out_of_calibration');

    const raised = await raiseEscalation(instrumentRecordId);
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const escalation = raised.body['escalation'] as Record<string, unknown>;
    assert.strictEqual(escalation['status'], 'open');
    assert.strictEqual(escalation['doa_entry_id'], doaEntryId);
    assert.strictEqual(escalation['routed_approver_user_id'], schedulerUserId);

    assert.deepStrictEqual(
      await statusOf(instrumentId),
      before,
      'the calibration status must be byte-identical before and after an escalation',
    );
    assert.strictEqual(
      await certificateCount(instrumentRecordId),
      certificatesBefore,
      'an escalation must not create a certificate',
    );
    const qc = await qcResult(instrumentId);
    assert.strictEqual(qc.status, 423, 'the lockout stays in force while the escalation is open');
    assert.strictEqual(qc.body['error_code'], 'CALIBRATION_LOCKOUT');

    const notification = await notificationFor(
      escalation['escalation_id'] as string,
      'calibration_escalation_raised',
    );
    assert.ok(notification, 'the escalation must notify the routed approver');
    assert.strictEqual(notification['user_id'], schedulerUserId);
    assert.strictEqual(
      notification['next_step'],
      'Expedite re-calibration; the lockout stays in force',
    );
  });

  it('AC3: recording a certificate auto-resolves the open escalation and only then calibrates', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const raised = await raiseEscalation(instrumentRecordId);
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const escalationId = (raised.body['escalation'] as Record<string, string>)['escalation_id']!;

    const recorded = await recordCertificate(instrumentRecordId, {
      certificate_number: `AUTO-${run}-1`,
    });
    assert.strictEqual(recorded.status, 201, JSON.stringify(recorded.body));
    const certificateId = (recorded.body['certificate'] as Record<string, string>)[
      'certificate_id'
    ]!;

    const row = await escalationRow(escalationId);
    assert.strictEqual(row?.['status'], 'resolved');
    assert.strictEqual(row?.['resolving_certificate_id'], certificateId);
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_escalation_resolved',
        'escalation_id',
        escalationId,
      ),
      1,
      'the auto-resolve must be recorded in the event ledger, not applied silently',
    );
    assert.strictEqual((await statusOf(instrumentId))?.['calibration_status'], 'calibrated');
  });

  it('AC3: the standalone resolve route closes an escalation raised after the certificate was recorded', async () => {
    const noCertificate = await registerOk();
    const prematureRaise = await raiseEscalation(noCertificate.instrumentRecordId);
    const prematureId = (prematureRaise.body['escalation'] as Record<string, string>)[
      'escalation_id'
    ]!;
    // No active certificate: the escalation cannot be closed without the re-calibration it exists
    // to expedite.
    const premature = await resolveEscalationRoute(prematureId);
    assert.strictEqual(premature.status, 422, JSON.stringify(premature.body));
    assert.strictEqual(premature.body['error_code'], 'CERTIFICATE_EXPIRED');

    // The "certificate recorded before the escalation was noticed" case: an active certificate
    // exists, the instrument was locked down by hand, and the escalation is raised afterwards, so
    // the certificate applier never saw it to auto-resolve.
    const { instrumentRecordId, instrumentId } = await registerOk();
    const recorded = await recordCertificate(instrumentRecordId, {
      certificate_number: `STANDALONE-${run}-1`,
    });
    assert.strictEqual(recorded.status, 201, JSON.stringify(recorded.body));
    const certificateId = (recorded.body['certificate'] as Record<string, string>)[
      'certificate_id'
    ]!;
    assert.strictEqual(
      (
        await makeRequest(
          port,
          'PUT',
          `/api/v1/instruments/${instrumentId}/calibration-status`,
          { calibration_status: 'out_of_calibration', reason: 'Suspected drift' },
          schedulerHeaders,
        )
      ).status,
      200,
    );

    const raised = await raiseEscalation(instrumentRecordId);
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const escalationId = (raised.body['escalation'] as Record<string, string>)['escalation_id']!;

    const resolved = await resolveEscalationRoute(escalationId);
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolved.body));
    const escalation = resolved.body['escalation'] as Record<string, unknown>;
    assert.strictEqual(escalation['status'], 'resolved');
    assert.strictEqual(escalation['resolving_certificate_id'], certificateId);

    // Resolving expedites; it does not unlock. Only a certificate event sets 'calibrated'.
    assert.strictEqual(
      (await statusOf(instrumentId))?.['calibration_status'],
      'out_of_calibration',
    );
    assert.strictEqual((await qcResult(instrumentId)).status, 423);

    // A second resolve is rejected rather than silently no-opping on a state it should reject.
    const again = await resolveEscalationRoute(escalationId);
    assert.strictEqual(again.status, 409, JSON.stringify(again.body));
    assert.strictEqual(again.body['error_code'], 'ESCALATION_NOT_OPEN');
  });

  it('AC3: an escalation requires an out-of-calibration instrument and only one may be open', async () => {
    const { instrumentRecordId } = await registerOk();
    assert.strictEqual(
      (await recordCertificate(instrumentRecordId, { certificate_number: `PRE-${run}-1` })).status,
      201,
    );

    const calibrated = await raiseEscalation(instrumentRecordId);
    assert.strictEqual(calibrated.status, 400, JSON.stringify(calibrated.body));
    assert.strictEqual(calibrated.body['error_code'], 'INVALID_PARAMS');

    const { instrumentRecordId: lockedId } = await registerOk();
    const first = await raiseEscalation(lockedId);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const second = await raiseEscalation(lockedId);
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body['error_code'], 'ESCALATION_ALREADY_OPEN');
    assert.strictEqual(
      detailsOf(second.body)?.['existing_escalation_id'],
      (first.body['escalation'] as Record<string, string>)['escalation_id'],
    );
  });

  it('AC3: an unknown escalation id is a 404', async () => {
    const missing = await resolveEscalationRoute(randomUUID());
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'ESCALATION_NOT_FOUND');
  });

  it('AC3: escalation routing fails closed when the DOA entry or its role holder is missing', async () => {
    const { instrumentRecordId } = await registerOk();
    const adminPool = getAdminPool();

    await adminPool.query(`UPDATE doa_registry_entries SET active = false WHERE entry_id = $1`, [
      doaEntryId,
    ]);
    try {
      const noEntry = await raiseEscalation(instrumentRecordId);
      assert.strictEqual(noEntry.status, 404, JSON.stringify(noEntry.body));
      assert.strictEqual(noEntry.body['error_code'], 'NO_DOA_ENTRY_MATCH');
    } finally {
      await adminPool.query(`UPDATE doa_registry_entries SET active = true WHERE entry_id = $1`, [
        doaEntryId,
      ]);
    }

    // Point the DOA entry at a role nobody holds rather than deactivating the scheduler: the
    // scheduler is also this suite's caller, and deactivating it would surface a 401 instead of the
    // routing failure under test.
    await adminPool.query(`UPDATE doa_registry_entries SET role = $2 WHERE entry_id = $1`, [
      doaEntryId,
      `nobody_holds_this_7_5_${run}`,
    ]);
    try {
      const noApprover = await raiseEscalation(instrumentRecordId);
      assert.strictEqual(noApprover.status, 404, JSON.stringify(noApprover.body));
      assert.strictEqual(noApprover.body['error_code'], 'NO_APPROVER_FOUND');
    } finally {
      await adminPool.query(`UPDATE doa_registry_entries SET role = $2 WHERE entry_id = $1`, [
        doaEntryId,
        'calibration_scheduler',
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // Registration and certificate error contract
  // -------------------------------------------------------------------------

  it('rejects registration against an unknown asset or location, a duplicate instrument id and a duplicate asset', async () => {
    const unknownAsset = await registerInstrument({ asset_id: randomUUID() });
    assert.strictEqual(unknownAsset.res.status, 404, JSON.stringify(unknownAsset.res.body));
    assert.strictEqual(unknownAsset.res.body['error_code'], 'ASSET_NOT_FOUND');

    const unknownLocation = await registerInstrument({ location_id: randomUUID() });
    assert.strictEqual(unknownLocation.res.status, 404, JSON.stringify(unknownLocation.res.body));
    assert.strictEqual(unknownLocation.res.body['error_code'], 'LOCATION_NOT_FOUND');

    const first = await registerOk();
    // Case variants are the same physical instrument.
    const duplicate = await registerInstrument({
      instrument_id: first.instrumentId.toUpperCase(),
    });
    assert.strictEqual(duplicate.res.status, 409, JSON.stringify(duplicate.res.body));
    assert.strictEqual(duplicate.res.body['error_code'], 'INSTRUMENT_ALREADY_REGISTERED');
    assert.strictEqual(
      detailsOf(duplicate.res.body)?.['existing_instrument_record_id'],
      first.instrumentRecordId,
    );

    const sameAsset = await registerInstrument({ asset_id: first.assetId });
    assert.strictEqual(sameAsset.res.status, 409, JSON.stringify(sameAsset.res.body));
    assert.strictEqual(sameAsset.res.body['error_code'], 'ASSET_ALREADY_INSTRUMENT');
    assert.strictEqual(
      detailsOf(sameAsset.res.body)?.['existing_instrument_record_id'],
      first.instrumentRecordId,
    );
  });

  it('rejects a bad calibration_interval_days rather than coercing it', async () => {
    const asString = await registerInstrument({ calibration_interval_days: '365' });
    assert.strictEqual(asString.res.status, 400, JSON.stringify(asString.res.body));
    assert.strictEqual(asString.res.body['error_code'], 'INVALID_PARAMS');

    const tooLarge = await registerInstrument({ calibration_interval_days: 100000 });
    assert.strictEqual(tooLarge.res.status, 400, JSON.stringify(tooLarge.res.body));
  });

  it('rejects an unknown instrument, an invalid validity window, a duplicate certificate number and an already-lapsed certificate', async () => {
    const unknown = await recordCertificate(randomUUID(), {
      certificate_number: `NOPE-${run}-1`,
    });
    assert.strictEqual(unknown.status, 404, JSON.stringify(unknown.body));
    assert.strictEqual(unknown.body['error_code'], 'INSTRUMENT_NOT_FOUND');

    const { instrumentRecordId } = await registerOk();

    const backwards = await recordCertificate(instrumentRecordId, {
      calibrated_on: addDays(ANCHOR, 10),
      valid_until: ANCHOR,
    });
    assert.strictEqual(backwards.status, 400, JSON.stringify(backwards.body));
    assert.strictEqual(backwards.body['error_code'], 'INVALID_CERTIFICATE_VALIDITY');

    // The other INVALID_CALIBRATION_TYPE branch: calibration_type is not in {in_house, iso_17025}.
    const vendorType = await recordCertificate(instrumentRecordId, {
      certificate_number: `VENDOR-${run}-1`,
      calibration_type: 'vendor',
    });
    assert.strictEqual(vendorType.status, 400, JSON.stringify(vendorType.body));
    assert.strictEqual(vendorType.body['error_code'], 'INVALID_CALIBRATION_TYPE');

    // The other INVALID_CERTIFICATE_VALIDITY branch: a malformed calendar date (not a valid
    // YYYY-MM-DD), which the round-trip check rejects instead of a raw SQL date-cast 500.
    const malformedDate = await recordCertificate(instrumentRecordId, {
      certificate_number: `MALFORMED-${run}-1`,
      valid_until: 'not-a-date',
    });
    assert.strictEqual(malformedDate.status, 400, JSON.stringify(malformedDate.body));
    assert.strictEqual(malformedDate.body['error_code'], 'INVALID_CERTIFICATE_VALIDITY');

    const lapsed = await recordCertificate(instrumentRecordId, {
      certificate_number: `LAPSED-${run}-1`,
      calibrated_on: addDays(ANCHOR, -400),
      valid_until: addDays(ANCHOR, -1),
      business_date: ANCHOR,
    });
    assert.strictEqual(lapsed.status, 422, JSON.stringify(lapsed.body));
    assert.strictEqual(lapsed.body['error_code'], 'CERTIFICATE_EXPIRED');

    const number = `DUP-${run}-1`;
    assert.strictEqual(
      (await recordCertificate(instrumentRecordId, { certificate_number: number })).status,
      201,
    );
    const duplicate = await recordCertificate(instrumentRecordId, {
      certificate_number: number.toUpperCase(),
    });
    assert.strictEqual(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.strictEqual(duplicate.body['error_code'], 'CERTIFICATE_ALREADY_RECORDED');
    assert.ok(detailsOf(duplicate.body)?.['existing_certificate_id']);
  });

  it('rejects a malformed filter combination and a non-UUID path segment instead of ignoring them', async () => {
    const badStatus = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/instruments?calibration_status=maybe',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badStatus.status, 400, JSON.stringify(badStatus.body));
    assert.strictEqual(badStatus.body['error_code'], 'INVALID_PARAMS');

    const badStage = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/calibration/alerts?stage_days=21',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badStage.status, 400, JSON.stringify(badStage.body));

    const badPath = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/instruments/not-a-uuid',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(badPath.status, 400, JSON.stringify(badPath.body));
    assert.strictEqual(badPath.body['error_code'], 'INVALID_PARAMS');

    const encoded = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/instruments/%E0%A4%A',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(encoded.status, 400, JSON.stringify(encoded.body));

    const missingDate = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/calibration/scan',
      {},
      schedulerHeaders,
    );
    assert.strictEqual(missingDate.status, 400, JSON.stringify(missingDate.body));
    assert.strictEqual(missingDate.body['error_code'], 'INVALID_PARAMS');
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('replays every write route to the same resource without growing the event ledger', async () => {
    const assetId = await createAsset();
    const instrumentId = nextInstrumentId();
    const registerKey = randomUUID();
    const registerBody = {
      asset_id: assetId,
      instrument_id: instrumentId,
      location_id: siteLocId,
      calibration_interval_days: 365,
      idempotency_key: registerKey,
    };
    const first = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/instruments',
      registerBody,
      schedulerHeaders,
    );
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    const instrumentRecordId = (first.body['instrument'] as Record<string, string>)[
      'instrument_record_id'
    ]!;
    const replay = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/instruments',
      registerBody,
      schedulerHeaders,
    );
    assert.strictEqual(replay.status, 201, JSON.stringify(replay.body));
    assert.strictEqual(
      (replay.body['instrument'] as Record<string, string>)['instrument_record_id'],
      instrumentRecordId,
    );
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.instrument_registered',
        'instrument_record_id',
        instrumentRecordId,
      ),
      1,
    );

    const escalationKey = randomUUID();
    const raised = await raiseEscalation(instrumentRecordId, { idempotency_key: escalationKey });
    assert.strictEqual(raised.status, 201, JSON.stringify(raised.body));
    const escalationId = (raised.body['escalation'] as Record<string, string>)['escalation_id']!;
    const raisedAgain = await raiseEscalation(instrumentRecordId, {
      idempotency_key: escalationKey,
    });
    assert.strictEqual(raisedAgain.status, 201, JSON.stringify(raisedAgain.body));
    assert.strictEqual(
      (raisedAgain.body['escalation'] as Record<string, string>)['escalation_id'],
      escalationId,
    );
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_escalation_raised',
        'escalation_id',
        escalationId,
      ),
      1,
    );

    const certificateKey = randomUUID();
    const certificateBody = {
      certificate_number: `IDEMP-${run}-1`,
      idempotency_key: certificateKey,
    };
    const recorded = await recordCertificate(instrumentRecordId, certificateBody);
    assert.strictEqual(recorded.status, 201, JSON.stringify(recorded.body));
    const certificateId = (recorded.body['certificate'] as Record<string, string>)[
      'certificate_id'
    ]!;
    const recordedAgain = await recordCertificate(instrumentRecordId, certificateBody);
    assert.strictEqual(recordedAgain.status, 201, JSON.stringify(recordedAgain.body));
    assert.strictEqual(
      (recordedAgain.body['certificate'] as Record<string, string>)['certificate_id'],
      certificateId,
    );
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_certificate_recorded',
        'certificate_id',
        certificateId,
      ),
      1,
    );

    // The standalone resolve route, replayed on an escalation the certificate applier never saw:
    // certificate first, hand lock-down, then the raise.
    const second = await registerOk();
    assert.strictEqual(
      (
        await recordCertificate(second.instrumentRecordId, {
          certificate_number: `IDEMP-${run}-2`,
        })
      ).status,
      201,
    );
    assert.strictEqual(
      (
        await makeRequest(
          port,
          'PUT',
          `/api/v1/instruments/${second.instrumentId}/calibration-status`,
          { calibration_status: 'out_of_calibration' },
          schedulerHeaders,
        )
      ).status,
      200,
    );
    const secondEscalation = await raiseEscalation(second.instrumentRecordId);
    const secondEscalationId = (secondEscalation.body['escalation'] as Record<string, string>)[
      'escalation_id'
    ]!;

    const resolveKey = randomUUID();
    const resolved = await resolveEscalationRoute(secondEscalationId, {
      idempotency_key: resolveKey,
    });
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolved.body));
    const resolveReplay = await resolveEscalationRoute(secondEscalationId, {
      idempotency_key: resolveKey,
    });
    assert.strictEqual(resolveReplay.status, 200, JSON.stringify(resolveReplay.body));
    assert.strictEqual(
      (resolveReplay.body['escalation'] as Record<string, string>)['escalation_id'],
      secondEscalationId,
    );
    assert.strictEqual(
      await domainEventCountFor(
        'maintenance.calibration_escalation_resolved',
        'escalation_id',
        secondEscalationId,
      ),
      1,
      'a replayed resolve must not grow the ledger',
    );
  });

  it('rejects a cross-event-type idempotency key reuse with DUPLICATE_EVENT', async () => {
    const key = randomUUID();
    const { instrumentRecordId } = await registerOk({ idempotency_key: key });
    const reused = await recordCertificate(instrumentRecordId, {
      certificate_number: `XTYPE-${run}-1`,
      idempotency_key: key,
    });
    assert.strictEqual(reused.status, 409, JSON.stringify(reused.body));
    assert.strictEqual(reused.body['error_code'], 'DUPLICATE_EVENT');
  });

  // -------------------------------------------------------------------------
  // Concurrency: the race path must match the sequential path
  // -------------------------------------------------------------------------

  it('resolves parallel registrations of the same instrument id to one winner and one stable 409', async () => {
    const instrumentId = nextInstrumentId();
    const [assetA, assetB] = await Promise.all([createAsset(), createAsset()]);
    const [a, b] = await Promise.all([
      registerInstrument({ asset_id: assetA, instrument_id: instrumentId }),
      registerInstrument({ asset_id: assetB, instrument_id: instrumentId }),
    ]);
    const statuses = [a.res.status, b.res.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.res.body)} / ${JSON.stringify(b.res.body)}`,
    );
    const winner = a.res.status === 201 ? a.res : b.res;
    const loser = a.res.status === 201 ? b.res : a.res;
    assert.strictEqual(loser.body['error_code'], 'INSTRUMENT_ALREADY_REGISTERED');
    assert.strictEqual(
      detailsOf(loser.body)?.['existing_instrument_record_id'],
      (winner.body['instrument'] as Record<string, string>)['instrument_record_id'],
    );
  });

  it('resolves parallel registrations of the same asset to one winner and one stable 409', async () => {
    // Races uq_instrument_register_asset: one asset is at most one instrument record (AD-9), so
    // the race must resolve to one success and one stable ASSET_ALREADY_INSTRUMENT 409 with the
    // same existing_* detail as the sequential path (Task 8.6).
    const assetId = await createAsset();
    const [a, b] = await Promise.all([
      registerInstrument({ asset_id: assetId, instrument_id: nextInstrumentId() }),
      registerInstrument({ asset_id: assetId, instrument_id: nextInstrumentId() }),
    ]);
    const statuses = [a.res.status, b.res.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.res.body)} / ${JSON.stringify(b.res.body)}`,
    );
    const winner = a.res.status === 201 ? a.res : b.res;
    const loser = a.res.status === 201 ? b.res : a.res;
    assert.strictEqual(loser.body['error_code'], 'ASSET_ALREADY_INSTRUMENT');
    assert.strictEqual(
      detailsOf(loser.body)?.['existing_instrument_record_id'],
      (winner.body['instrument'] as Record<string, string>)['instrument_record_id'],
    );
  });

  it('resolves parallel certificate recordings of the same number to one winner and one stable 409', async () => {
    const { instrumentRecordId } = await registerOk();
    // Racing the SAME certificate number exercises uq_instrument_calibration_certificate_number so
    // the race path returns the same code and existing_* detail as the sequential path (Task 8.6).
    const sharedNumber = `RACE-${run}-shared`;
    const [a, b] = await Promise.all([
      recordCertificate(instrumentRecordId, { certificate_number: sharedNumber }),
      recordCertificate(instrumentRecordId, { certificate_number: sharedNumber }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`,
    );
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    assert.strictEqual(loser.body['error_code'], 'CERTIFICATE_ALREADY_RECORDED');
    assert.strictEqual(
      detailsOf(loser.body)?.['existing_certificate_id'],
      (winner.body['certificate'] as Record<string, string>)['certificate_id'],
    );
    const active = await getAdminPool().query(
      `SELECT count(*)::int AS n FROM instrument_calibration_certificate
        WHERE instrument_record_id = $1 AND status = 'active'`,
      [instrumentRecordId],
    );
    assert.strictEqual(
      active.rows[0]!['n'],
      1,
      'exactly one active certificate may exist, whatever the interleaving',
    );
  });

  it('resolves parallel escalation raises to one open escalation and one stable 409', async () => {
    const { instrumentRecordId } = await registerOk();
    const [a, b] = await Promise.all([
      raiseEscalation(instrumentRecordId),
      raiseEscalation(instrumentRecordId),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(
      statuses,
      [201, 409],
      `${JSON.stringify(a.body)} / ${JSON.stringify(b.body)}`,
    );
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    assert.strictEqual(loser.body['error_code'], 'ESCALATION_ALREADY_OPEN');
    assert.strictEqual(
      detailsOf(loser.body)?.['existing_escalation_id'],
      (winner.body['escalation'] as Record<string, string>)['escalation_id'],
    );
  });

  it('resolves parallel scans of the same certificate stage to a single alert', async () => {
    const { instrumentRecordId } = await registerOk();
    const validUntil = addDays(ANCHOR, 100);
    assert.strictEqual(
      (
        await recordCertificate(instrumentRecordId, {
          certificate_number: `SCANRACE-${run}-1`,
          valid_until: validUntil,
        })
      ).status,
      201,
    );
    const businessDate = addDays(validUntil, -30);
    const [a, b] = await Promise.all([
      scan(businessDate, { instrument_record_id: instrumentRecordId }),
      scan(businessDate, { instrument_record_id: instrumentRecordId }),
    ]);
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    const raised = (a.body['alerts_raised'] as number) + (b.body['alerts_raised'] as number);
    assert.strictEqual(raised, 1, 'two concurrent scans must serialize into exactly one alert');
    assert.deepStrictEqual(await alertStagesFor(instrumentRecordId), [30]);
  });

  // -------------------------------------------------------------------------
  // Direct-event forgeries: the seam is the enforcement point
  // -------------------------------------------------------------------------

  it('rejects a forged expiry alert whose valid_until disagrees with the certificate', async () => {
    const { instrumentRecordId } = await registerOk();
    const validUntil = addDays(ANCHOR, 100);
    const recorded = await recordCertificate(instrumentRecordId, {
      certificate_number: `FORGE-${run}-1`,
      valid_until: validUntil,
    });
    assert.strictEqual(recorded.status, 201, JSON.stringify(recorded.body));
    const certificateId = (recorded.body['certificate'] as Record<string, string>)[
      'certificate_id'
    ]!;

    const forgedWrongValidUntilAlertId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: forgedWrongValidUntilAlertId,
        event_type: 'maintenance.calibration_expiry_flagged',
        payload: {
          alert_id: forgedWrongValidUntilAlertId,
          certificate_id: certificateId,
          instrument_record_id: instrumentRecordId,
          stage_days: 30,
          valid_until: addDays(validUntil, 90),
          business_date: addDays(validUntil, -30),
          flagged_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'CALIBRATION_DERIVATION_MISMATCH',
    );

    // A stage that is not due cannot be fabricated either.
    const forgedAlertId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: forgedAlertId,
        event_type: 'maintenance.calibration_expiry_flagged',
        payload: {
          alert_id: forgedAlertId,
          certificate_id: certificateId,
          instrument_record_id: instrumentRecordId,
          stage_days: 7,
          valid_until: validUntil,
          business_date: ANCHOR,
          flagged_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'CALIBRATION_DERIVATION_MISMATCH',
    );
    assert.deepStrictEqual(await alertStagesFor(instrumentRecordId), []);
  });

  it('rejects a second alert on an already-fired stage with DUPLICATE_CALIBRATION_ALERT', async () => {
    const { instrumentRecordId } = await registerOk();
    const validUntil = addDays(ANCHOR, 100);
    const recorded = await recordCertificate(instrumentRecordId, {
      certificate_number: `DUPALERT-${run}-1`,
      valid_until: validUntil,
    });
    const certificateId = (recorded.body['certificate'] as Record<string, string>)[
      'certificate_id'
    ]!;
    const businessDate = addDays(validUntil, -30);
    assert.strictEqual(
      (await scan(businessDate, { instrument_record_id: instrumentRecordId })).body[
        'alerts_raised'
      ],
      1,
    );

    const forgedAlertId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: forgedAlertId,
        event_type: 'maintenance.calibration_expiry_flagged',
        payload: {
          alert_id: forgedAlertId,
          certificate_id: certificateId,
          instrument_record_id: instrumentRecordId,
          stage_days: 30,
          valid_until: validUntil,
          business_date: businessDate,
          flagged_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) => (err as { errorCode?: string }).errorCode === 'DUPLICATE_CALIBRATION_ALERT',
    );
  });

  it('rejects a forged certificate event that names a different instrument, so it cannot unlock one', async () => {
    const victim = await registerOk();
    const other = await registerOk();
    assert.strictEqual((await qcResult(victim.instrumentId)).status, 423);

    const forgedCertificateId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: forgedCertificateId,
        event_type: 'maintenance.calibration_certificate_recorded',
        payload: {
          certificate_id: forgedCertificateId,
          instrument_record_id: victim.instrumentRecordId,
          instrument_id: other.instrumentId,
          calibration_type: 'in_house',
          certificate_number: `FORGED-${run}-1`,
          issuing_lab: null,
          calibrated_on: ANCHOR,
          valid_until: addDays(ANCHOR, 365),
          business_date: ANCHOR,
          recorded_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'CALIBRATION_DERIVATION_MISMATCH',
    );

    assert.strictEqual(
      (await statusOf(victim.instrumentId))?.['calibration_status'],
      'out_of_calibration',
      'a forged certificate must not unlock an instrument',
    );
    assert.strictEqual((await qcResult(victim.instrumentId)).status, 423);
  });

  it('rejects a forged expiry that would lock out an instrument whose certificate is still valid', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const validUntil = addDays(ANCHOR, 200);
    const recorded = await recordCertificate(instrumentRecordId, {
      certificate_number: `FORGEEXP-${run}-1`,
      valid_until: validUntil,
    });
    assert.strictEqual(recorded.status, 201, JSON.stringify(recorded.body));
    const certificateId = (recorded.body['certificate'] as Record<string, string>)[
      'certificate_id'
    ]!;

    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: instrumentRecordId,
        event_type: 'maintenance.calibration_expired',
        payload: {
          instrument_record_id: instrumentRecordId,
          instrument_id: instrumentId,
          certificate_id: certificateId,
          valid_until: validUntil,
          business_date: ANCHOR,
          expired_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'CALIBRATION_DERIVATION_MISMATCH',
    );
    assert.strictEqual((await statusOf(instrumentId))?.['calibration_status'], 'calibrated');
  });

  it('rejects a forged escalation that names a DOA entry or approver the registry does not resolve', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();

    const forgedEscalationId = randomUUID();
    await assert.rejects(
      persistEvent({
        stream_type: 'maintenance',
        stream_id: forgedEscalationId,
        event_type: 'maintenance.calibration_escalation_raised',
        payload: {
          escalation_id: forgedEscalationId,
          instrument_record_id: instrumentRecordId,
          instrument_id: instrumentId,
          doa_entry_id: randomUUID(),
          routed_approver_user_id: schedulerUserId,
          reason: null,
          raised_at: new Date().toISOString(),
        },
        metadata: forgedMetadata(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      (err: unknown) =>
        (err as { errorCode?: string }).errorCode === 'CALIBRATION_DERIVATION_MISMATCH',
    );
  });

  // -------------------------------------------------------------------------
  // RBAC and reads
  // -------------------------------------------------------------------------

  it('requires maintenance write for every calibration write route and maintenance read for every list', async () => {
    const denied = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/instruments',
      {
        asset_id: randomUUID(),
        instrument_id: 'X',
        location_id: siteLocId,
        calibration_interval_days: 1,
      },
      readerHeaders,
    );
    assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));

    // Every write route must be denied to a read-scope-only user, not just the first one: a
    // regression that dropped any single handler's write wrapper would otherwise pass unnoticed.
    const deniedCertificate = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${randomUUID()}/certificates`,
      {
        calibration_type: 'in_house',
        certificate_number: `RBAC-${run}-1`,
        calibrated_on: ANCHOR,
        valid_until: addDays(ANCHOR, 30),
        business_date: ANCHOR,
      },
      readerHeaders,
    );
    assert.strictEqual(deniedCertificate.status, 403, JSON.stringify(deniedCertificate.body));

    const deniedEscalation = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/instruments/${randomUUID()}/escalations`,
      { reason: 'x' },
      readerHeaders,
    );
    assert.strictEqual(deniedEscalation.status, 403, JSON.stringify(deniedEscalation.body));

    const deniedScan = await makeRequest(
      port,
      'POST',
      '/api/v1/maintenance/calibration/scan',
      { business_date: ANCHOR },
      readerHeaders,
    );
    assert.strictEqual(deniedScan.status, 403, JSON.stringify(deniedScan.body));

    const deniedResolve = await makeRequest(
      port,
      'POST',
      `/api/v1/maintenance/calibration/escalations/${randomUUID()}/resolve`,
      {},
      readerHeaders,
    );
    assert.strictEqual(deniedResolve.status, 403, JSON.stringify(deniedResolve.body));

    const listed = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/instruments',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(Array.isArray(listed.body['instruments']));

    const alerts = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/calibration/alerts',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(alerts.status, 200, JSON.stringify(alerts.body));

    const escalations = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/calibration/escalations?status=open',
      undefined,
      readerHeaders,
    );
    assert.strictEqual(escalations.status, 200, JSON.stringify(escalations.body));

    // And a user WITHOUT any maintenance role is denied the read surface outright.
    const deniedRead = await makeRequest(
      port,
      'GET',
      '/api/v1/maintenance/instruments',
      undefined,
      qcHeaders,
    );
    assert.strictEqual(deniedRead.status, 403, JSON.stringify(deniedRead.body));
  });

  it('reads back an instrument with its active certificate and current calibration status', async () => {
    const { instrumentRecordId, instrumentId } = await registerOk();
    const recorded = await recordCertificate(instrumentRecordId, {
      certificate_number: `READ-${run}-1`,
    });
    assert.strictEqual(recorded.status, 201, JSON.stringify(recorded.body));
    const certificateId = (recorded.body['certificate'] as Record<string, string>)[
      'certificate_id'
    ]!;

    const detail = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/instruments/${instrumentRecordId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(detail.status, 200, JSON.stringify(detail.body));
    assert.strictEqual(
      (detail.body['instrument'] as Record<string, string>)['instrument_id'],
      instrumentId,
    );
    assert.strictEqual(
      (detail.body['active_certificate'] as Record<string, string>)['certificate_id'],
      certificateId,
    );
    assert.strictEqual(detail.body['calibration_status'], 'calibrated');

    const filtered = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/instruments?calibration_status=calibrated&location_id=${siteLocId}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(filtered.status, 200, JSON.stringify(filtered.body));
    const ids = (filtered.body['instruments'] as Record<string, string>[]).map(
      (i) => i['instrument_record_id'],
    );
    assert.ok(ids.includes(instrumentRecordId));

    const missing = await makeRequest(
      port,
      'GET',
      `/api/v1/maintenance/instruments/${randomUUID()}`,
      undefined,
      readerHeaders,
    );
    assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));
    assert.strictEqual(missing.body['error_code'], 'INSTRUMENT_NOT_FOUND');
  });
});

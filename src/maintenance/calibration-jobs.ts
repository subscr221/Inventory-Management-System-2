import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../config/db.js';
import { persistEvent } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { emitNotification } from '../notify/emit.js';
import type { AuditEntryPayload } from '../read/projections/audit_log.js';
import { getAssetById } from '../read/projections/asset.js';
import { CALIBRATION_STAGES } from '../compliance/calibration-register.js';
import { getInstrumentRecordById } from '../read/projections/instrument_register.js';
import {
  getActiveCertificate,
  getCertificateById,
  listCertificateStagesDue,
  listCertificatesExpiredAt,
} from '../read/projections/instrument_calibration_certificate.js';
import { getCalibrationAlertForStage } from '../read/projections/instrument_calibration_alert.js';

/**
 * Story 7.5 calibration scan cycle (FR-M-12, FR-M-13). A pure function driven by the authenticated
 * POST trigger in src/api/v1/maintenance.ts, mirroring src/maintenance/spares-jobs.ts and
 * src/maintenance/pm-jobs.ts. There is deliberately NO scheduler, no timer and no container: the
 * only setInterval in the process is the Story 1.11 notification dispatcher, and every other
 * periodic cycle in this codebase is a POST with an explicit business_date.
 *
 * business_date is the ONLY notion of "today" inside the job. Wall-clock time is used solely for
 * flagged_at, expired_at, occurred_at and audit timestamps, which are TIMESTAMPTZ instants with
 * explicit offsets. Every date comparison happens in SQL DATE arithmetic, never in JS.
 *
 * Each certificate is processed in its OWN transaction: the row it decides on is locked FOR UPDATE
 * and the resulting event is persisted through persistEvent on that SAME client, so two concurrent
 * scans serialize into exactly one alert rather than racing to the unique index. The index remains
 * the backstop, and a lost race is skipped rather than failing the whole scan. Notifications are
 * emitted AFTER the transaction commits, using the non-throwing emitNotification (AD-17), so a
 * notification failure can never roll back an alert or a lockout.
 *
 * Write counters and delivery counters are kept SEPARATE in the result, so a dropped notification
 * stays visible instead of hiding behind the write count (the Story 7.2 and 7.4 lesson).
 */

export type AuditCtx = Omit<AuditEntryPayload, 'event_id' | 'error_code' | 'details'>;

export interface CalibrationJobActor {
  user_id: string;
  role: string;
  location_id: string;
}

export interface CalibrationScanScope {
  business_date: string;
  instrument_record_id?: string | undefined;
  location_id?: string | undefined;
  actor: CalibrationJobActor;
  auditCtx?: AuditCtx | undefined;
}

export interface CalibrationScanResult {
  business_date: string;
  certificates_evaluated: number;
  alerts_raised: number;
  instruments_expired: number;
  notifications_delivered: number;
  notifications_dropped: number;
  alert_ids: string[];
  expired_instrument_record_ids: string[];
}

/** The 7-day stage is the last warning before lockout, so it is the only one that escalates. */
const ESCALATING_STAGE_DAYS = 7;
const ACKNOWLEDGMENT_WINDOW_SECONDS = 86400;
/**
 * The notification role. NOT a new role string: calibration_scheduler is the role the Story 1.7
 * DOA registry already seeds for calibration.escalation. A notification aimed at a role no user
 * holds fans out to zero recipients and still reports success (the Story 7.4
 * maintenance_storekeeper lesson), so reusing an established role is the cheap correctness win.
 */
const CALIBRATION_ROLE = 'calibration_scheduler';

function isAppErrorWithCode(err: unknown, code: string): boolean {
  return err instanceof AppError && err.errorCode === code;
}

/** Runs `work` inside its own transaction, rolling back unless it signals success. */
async function inTransaction<T>(
  work: (client: PoolClient) => Promise<T | null>,
): Promise<T | null> {
  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A rollback failure on an already-aborted connection must not mask the original error.
      }
    }
    client.release();
  }
}

/**
 * AC 1 and AC 2 in one pass: the staged 30/14/7-day expiry warnings, then the expiry flip that
 * locks the instrument out.
 *
 * The two passes share a trigger because they share a cadence (daily) and an audience (the
 * calibration scheduler), and splitting them would double the operator's scheduler entries for no
 * gain. They run in that order deliberately: a certificate that has already lapsed must produce the
 * lockout, not a "7 days remaining" warning, and the stage query excludes lapsed certificates by
 * construction (valid_until >= business_date).
 *
 * Catch-up is structural, not special-cased: listCertificateStagesDue asks which stages are DUE and
 * UNFIRED, so a scan skipped for several days fires every missed stage on the next run, most urgent
 * first, and a second scan on the same business_date fires nothing because every due stage already
 * occupies its grain. An equality test on the day count would silently drop a stage whenever the
 * job is not run daily.
 */
export async function runCalibrationExpiryScan(
  scope: CalibrationScanScope,
): Promise<CalibrationScanResult> {
  const filters = {
    instrument_record_id: scope.instrument_record_id ?? null,
    location_id: scope.location_id ?? null,
  };

  const dueStages = await listCertificateStagesDue(
    scope.business_date,
    CALIBRATION_STAGES,
    filters,
  );

  const alertIds: string[] = [];
  const expiredInstrumentRecordIds: string[] = [];
  let notificationsDelivered = 0;
  let notificationsDropped = 0;

  for (const due of dueStages) {
    const flaggedAt = new Date().toISOString();
    const correlationId = randomUUID();
    const alertId = randomUUID();

    let flagged = false;
    try {
      flagged =
        (await inTransaction(async (client) => {
          // Lock the certificate so a concurrent scan for this grain serializes: the loser waits,
          // then sees the alert the winner committed and skips it.
          const locked = await getCertificateById(due.certificate_id, client, true);
          if (!locked || locked.status !== 'active') return null;
          if (locked.valid_until !== due.valid_until) return null;

          const existing = await getCalibrationAlertForStage(
            due.certificate_id,
            due.stage_days,
            client,
          );
          if (existing) return null;

          await persistEvent(
            {
              stream_type: 'maintenance',
              stream_id: alertId,
              event_type: 'maintenance.calibration_expiry_flagged',
              payload: {
                alert_id: alertId,
                certificate_id: locked.certificate_id,
                instrument_record_id: locked.instrument_record_id,
                stage_days: due.stage_days,
                valid_until: locked.valid_until,
                business_date: scope.business_date,
                flagged_at: flaggedAt,
              },
              metadata: {
                correlation_id: correlationId,
                actor: scope.actor,
                occurred_at: flaggedAt,
              },
              idempotency_key: randomUUID(),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
            scope.auditCtx,
            client,
          );
          return true;
        })) === true;
    } catch (err: unknown) {
      // A concurrent scan won the race to uq_instrument_calibration_alert_stage. Nothing was
      // persisted by this pass, so nothing may be counted or notified - but one lost race must not
      // fail the whole scan.
      if (isAppErrorWithCode(err, 'DUPLICATE_CALIBRATION_ALERT')) continue;
      throw err;
    }
    if (!flagged) continue;
    alertIds.push(alertId);

    const asset = await getAssetById(due.asset_id);
    const emitted = await emitNotification({
      target: { role: CALIBRATION_ROLE, location_id: due.location_id },
      event_type: 'calibration_expiry_due',
      status_verb: 'Due',
      object_type: 'instrument',
      object_id: alertId,
      // A human-readable subject, never a raw id (the 7.2 Group 4 patch).
      actor_label: `${due.instrument_id} (${asset?.asset_name ?? due.asset_id}), ${due.days_remaining} days remaining`,
      next_step: 'Schedule re-calibration',
      actor: scope.actor,
      correlation_id: correlationId,
      occurred_at: flaggedAt,
      // Escalating a month-out reminder is noise; the 7-day stage is the last warning before the
      // instrument locks out, so only that one carries an acknowledgment window.
      ...(due.stage_days === ESCALATING_STAGE_DAYS
        ? {
            escalation: {
              target_role: 'maintenance_manager',
              acknowledgment_window_seconds: ACKNOWLEDGMENT_WINDOW_SECONDS,
            },
          }
        : {}),
    });
    if (emitted.ok) notificationsDelivered += 1;
    else notificationsDropped += 1;
  }

  const lapsed = await listCertificatesExpiredAt(scope.business_date, filters);

  for (const certificate of lapsed) {
    const expiredAt = new Date().toISOString();
    const correlationId = randomUUID();

    let expired = false;
    expired =
      (await inTransaction(async (client) => {
        // Lock the register row FIRST per the Locking Contract (register -> certificate ->
        // escalation -> status). Locking the certificate before the register here inverted the
        // order and AB-BA deadlocked against applyCertificateRecorded (register -> certificate):
        // each transaction held one lock the other wanted, Postgres aborted one with an unmapped
        // 40P01, and the whole scan 500'd. With the register row held, the certificate reads below
        // serialize with a concurrent renewal.
        const registerRow = await getInstrumentRecordById(
          certificate.instrument_record_id,
          client,
          true,
        );
        if (!registerRow) return null;
        // Re-read under lock: a renewal committed between the list read and this write must not
        // lock out an instrument that has just been re-calibrated.
        const locked = await getCertificateById(certificate.certificate_id, client, true);
        if (!locked || locked.status !== 'active') return null;
        if (locked.valid_until !== certificate.valid_until) return null;
        const stillActive = await getActiveCertificate(locked.instrument_record_id, client, true);
        if (!stillActive || stillActive.certificate_id !== locked.certificate_id) return null;

        await persistEvent(
          {
            stream_type: 'maintenance',
            stream_id: locked.instrument_record_id,
            event_type: 'maintenance.calibration_expired',
            payload: {
              instrument_record_id: locked.instrument_record_id,
              instrument_id: locked.instrument_id,
              certificate_id: locked.certificate_id,
              valid_until: locked.valid_until,
              business_date: scope.business_date,
              expired_at: expiredAt,
            },
            metadata: {
              correlation_id: correlationId,
              actor: scope.actor,
              occurred_at: expiredAt,
            },
            idempotency_key: randomUUID(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          scope.auditCtx,
          client,
        );
        return true;
      })) === true;
    if (!expired) continue;
    expiredInstrumentRecordIds.push(certificate.instrument_record_id);

    const asset = await getAssetById(certificate.asset_id);
    const emitted = await emitNotification({
      target: { role: CALIBRATION_ROLE, location_id: certificate.location_id },
      event_type: 'calibration_expired',
      status_verb: 'Expired',
      object_type: 'instrument',
      object_id: certificate.instrument_record_id,
      actor_label: `${certificate.instrument_id} (${asset?.asset_name ?? certificate.asset_id}), certificate valid until ${certificate.valid_until}`,
      next_step: 'Instrument is locked out until a new certificate is recorded',
      actor: scope.actor,
      correlation_id: correlationId,
      occurred_at: expiredAt,
      escalation: {
        target_role: 'maintenance_manager',
        acknowledgment_window_seconds: ACKNOWLEDGMENT_WINDOW_SECONDS,
      },
    });
    if (emitted.ok) notificationsDelivered += 1;
    else notificationsDropped += 1;
  }

  return {
    business_date: scope.business_date,
    certificates_evaluated: dueStages.length + lapsed.length,
    alerts_raised: alertIds.length,
    instruments_expired: expiredInstrumentRecordIds.length,
    notifications_delivered: notificationsDelivered,
    notifications_dropped: notificationsDropped,
    alert_ids: alertIds,
    expired_instrument_record_ids: expiredInstrumentRecordIds,
  };
}

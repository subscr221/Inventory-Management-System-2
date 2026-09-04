import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getLocationByCode } from '../read/projections/location_register.js';
import { upsertWeighbridgeEvent } from '../read/projections/weighbridge_event.js';
import { getExaminationByDeviceKey } from '../read/projections/statutory_examination.js';
import type { StatutoryExaminationRow } from '../read/projections/statutory_examination.js';

/** AC3: tolerance breaches are routed to the receiving supervisor for review before receipt. */
const TOLERANCE_BREACH_TARGET_ROLE = 'receiving_supervisor';

const WEIGHBRIDGE_STREAM_TYPES = new Set(['weighbridge']);
const WEIGHBRIDGE_EVENT_TYPES = new Set(['weighbridge.recorded']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEIGHT_REGEX = /^\d+(\.\d{1,3})?$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return isNonEmptyString(value) && UUID_REGEX.test(value);
}

function trimmed(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function localYmd(date: Date): string {
  // IST = UTC+5:30. Shift the instant, then read back with UTC getters so the result is
  // host-timezone independent (local getters would double-apply the offset on an IST host).
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

function weighbridgeEventType(envelope: EventEnvelope): string | null {
  if (!WEIGHBRIDGE_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!WEIGHBRIDGE_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

export interface WeighbridgeLockoutDeps {
  getExaminationByDeviceKey: (deviceKey: string) => Promise<StatutoryExaminationRow | null>;
}

const defaultWeighbridgeLockoutDeps: WeighbridgeLockoutDeps = {
  getExaminationByDeviceKey,
};

/**
 * Story 7.6 (FR-M-14, AC 2): the pre-transaction weighbridge trade-weighment lockout, mirroring
 * assertCalibrationLockout in src/compliance/calibration.ts. Called from persistEvent for every
 * stream_type === 'weighbridge' && event_type === 'weighbridge.recorded' envelope, BEFORE any DB
 * write, so the direct-event path and the edge upload path (which converges on persistEvent) both
 * hit it.
 *
 * The weighbridge identity is resolved from payload.device_id through the statutory examination
 * register's device_key (canonicalized with lower() on both sides). A weighbridge whose stamp is
 * OVERDUE is blocked 423 WEIGHBRIDGE_OUT_OF_STAMP until it is re-stamped. Fail-open for device keys
 * not in the register (no statutory examination row - the device is not governed): the Story 7.5
 * lesson, applied unchanged, so the existing story-3-2/3-3/3-4 suites keep their exact behavior.
 */
export async function assertWeighbridgeStampLockout(
  envelope: EventEnvelope,
  deps: WeighbridgeLockoutDeps = defaultWeighbridgeLockoutDeps,
): Promise<void> {
  if (!WEIGHBRIDGE_STREAM_TYPES.has(envelope.stream_type)) return;
  if (envelope.event_type !== 'weighbridge.recorded') return;

  const deviceId = envelope.payload['device_id'];
  if (!isNonEmptyString(deviceId)) {
    throw new AppError(400, 'INVALID_PARAMS', 'weighbridge.recorded payload is missing device_id', {
      missing_field: 'device_id',
    });
  }

  // Canonicalized on BOTH sides before the lookup. The register stores device_key trimmed and
  // lowercased; getExaminationByDeviceKey matches on lower() but does NOT trim, and this assert runs
  // BEFORE assertWeighbridgeRecordedShape (which is where the payload's device_id gets trimmed), so
  // passing the raw value here let a single leading space miss the register and fail the lockout
  // open on an out-of-stamp weighbridge.
  const deviceKey = deviceId.trim().toLowerCase();
  const examination = await deps.getExaminationByDeviceKey(deviceKey);
  if (!examination) return;
  // Only a legal-metrology stamp governs trade weighment; any other examination type on this device
  // key is not the weighbridge's stamp and must fail open (Table 3, "device not governed").
  if (examination.examination_type !== 'weighbridge_legal_metrology') return;
  if (examination.status === 'overdue') {
    throw new AppError(
      423,
      'WEIGHBRIDGE_OUT_OF_STAMP',
      'Weighbridge statutory stamp is overdue; re-stamp before trade weighment',
      {
        device_id: deviceId,
        examination_id: examination.examination_id,
        next_due_date: examination.next_due_date,
      },
    );
  }
}

/**
 * Parses a kilogram value (number or numeric string, up to 3 decimals) into exact integer
 * milli-kilograms. Returns null when the value is missing, negative, or not a clean NUMERIC(_,3).
 * Integer milli-kg keeps net arithmetic exact - weights are never subtracted as JS floats.
 */
function parseKgToMilli(value: unknown): bigint | null {
  const s = trimmed(value);
  if (s === null || !WEIGHT_REGEX.test(s)) return null;
  const [intPart, fracPart = ''] = s.split('.');
  const frac = (fracPart + '000').slice(0, 3);
  return BigInt(intPart!) * 1000n + BigInt(frac);
}

/** Renders integer milli-kilograms back to a NUMERIC(_,3) string (e.g. 3500000 -> "3500.000"). */
function milliToKgString(milli: bigint): string {
  const whole = milli / 1000n;
  const frac = (milli % 1000n).toString().padStart(3, '0');
  return `${whole.toString()}.${frac}`;
}

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/**
 * Pre-transaction shape validation (Story 3.3, AC1). Runs before any DB write, so a malformed
 * weighbridge event never consumes an idempotency key. Computes net = gross - tare in exact integer
 * milli-kg and normalizes tare/gross/net back onto the payload as NUMERIC(_,3) strings.
 */
export function assertWeighbridgeRecordedShape(envelope: EventEnvelope): void {
  if (weighbridgeEventType(envelope) !== 'weighbridge.recorded') return;
  const p = envelope.payload;

  if (!isUuid(p['weighbridge_event_id']))
    throw new AppError(
      400,
      'INVALID_PARAMS',
      'weighbridge_event_id is required and must be a UUID',
    );
  if (!isUuid(p['correlation_id']))
    throw new AppError(
      400,
      'WEIGHBRIDGE_BINDING_TOKEN_REQUIRED',
      'correlation_id (binding token) is required and must be a UUID',
    );

  const tareMilli = parseKgToMilli(p['tare_kg']);
  if (tareMilli === null)
    throw new AppError(
      400,
      'WEIGHBRIDGE_TARE_REQUIRED',
      'tare_kg is required and must be a non-negative weight',
    );
  const grossMilli = parseKgToMilli(p['gross_kg']);
  if (grossMilli === null)
    throw new AppError(
      400,
      'WEIGHBRIDGE_GROSS_REQUIRED',
      'gross_kg is required and must be a non-negative weight',
    );

  const poRef = trimmed(p['po_ref_ext']);
  if (!poRef) throw new AppError(400, 'INVALID_PARAMS', 'po_ref_ext is required');
  p['po_ref_ext'] = poRef;

  const lineNo = p['line_no'];
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo <= 0)
    throw new AppError(400, 'INVALID_PARAMS', 'line_no is required and must be a positive integer');

  if (!isNonEmptyString(p['device_id']))
    throw new AppError(400, 'INVALID_PARAMS', 'device_id is required');
  p['device_id'] = (p['device_id'] as string).trim();

  if (p['capture_method'] !== 'AUTO' && p['capture_method'] !== 'MANUAL')
    throw new AppError(400, 'INVALID_PARAMS', "capture_method must be 'AUTO' or 'MANUAL'");
  if (!isUuid(p['weighed_by']))
    throw new AppError(400, 'INVALID_PARAMS', 'weighed_by is required and must be a UUID');

  if (p['site_code_ext'] !== undefined && p['site_code_ext'] !== null) {
    const siteCode = trimmed(p['site_code_ext']);
    if (!siteCode)
      throw new AppError(
        400,
        'INVALID_PARAMS',
        'site_code_ext must be a non-empty string when supplied',
      );
    p['site_code_ext'] = siteCode;
  }

  const netMilli = grossMilli - tareMilli;
  if (netMilli < 0n)
    throw new AppError(
      400,
      'WEIGHBRIDGE_NET_NEGATIVE',
      'net_kg (gross - tare) must not be negative',
    );

  p['tare_kg'] = milliToKgString(tareMilli);
  p['gross_kg'] = milliToKgString(grossMilli);
  p['net_kg'] = milliToKgString(netMilli);
}

/**
 * In-transaction projection (Story 3.3, AC1-3). Resolves the Story 3.2 binding token to its gate
 * event, enforces the site match, computes the tolerance band against the Story 2.9 open-PO line in
 * SQL NUMERIC (never JS float), and upserts an idempotent, replay-safe weighbridge_event row. Never
 * writes any erp_* projection - the ERP feed stays read-only (INT-ERP-01).
 */
export async function applyWeighbridgeProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (weighbridgeEventType(envelope) !== 'weighbridge.recorded') return;
  if (await alreadyPersisted(envelope, client)) return;
  const p = envelope.payload;

  const correlationId = envelope.metadata.correlation_id;
  // AC1 requires the binding token to be active: a gate event that has been reversed (Story 3.2
  // gate.reversed) no longer represents an active vehicle-to-PO binding, so it must not resolve as
  // a valid token here even though the row itself still exists.
  const gateResult = await client.query(
    `SELECT gate_event_id, site_id, site_code_ext, status
       FROM gate_event
      WHERE correlation_id = $1 AND status = 'open'
      ORDER BY entered_at DESC, created_at DESC
      LIMIT 1`,
    [correlationId],
  );
  if (gateResult.rows.length === 0) {
    throw new AppError(
      404,
      'WEIGHBRIDGE_BINDING_TOKEN_NOT_FOUND',
      `No active gate event exists for binding token "${correlationId}"`,
      { correlation_id: correlationId },
    );
  }
  const gate = gateResult.rows[0]!;
  const gateSiteId = gate['site_id'] as string;
  let siteId = gateSiteId;
  let siteCodeExt = gate['site_code_ext'] as string;

  // Site match (AC3 guard): if the operator supplied a weighbridge site, it must resolve to the same
  // physical site the gate event was captured at; otherwise the weighment inherits the gate site.
  const suppliedSiteCode =
    typeof p['site_code_ext'] === 'string' ? (p['site_code_ext'] as string) : null;
  if (suppliedSiteCode) {
    const site = await getLocationByCode(suppliedSiteCode, client);
    if (!site || site.status !== 'active' || site.level !== 'site') {
      throw new AppError(
        404,
        'WEIGHBRIDGE_SITE_MISMATCH',
        `No active site exists for "${suppliedSiteCode}"`,
        { site_code_ext: suppliedSiteCode },
      );
    }
    if (site.location_id !== gateSiteId) {
      throw new AppError(
        409,
        'WEIGHBRIDGE_SITE_MISMATCH',
        'Weighbridge site differs from the gate-event site for this binding token',
        {
          weighbridge_site_id: site.location_id,
          gate_site_id: gateSiteId,
        },
      );
    }
    siteId = site.location_id;
    siteCodeExt = suppliedSiteCode;
  }

  const poRef = p['po_ref_ext'] as string;
  const lineNo = p['line_no'] as number;
  const netKg = p['net_kg'] as string;

  // Tolerance band computed in SQL NUMERIC: [ordered_qty*(1 - under%/100), ordered_qty*(1 + over%/100)].
  // A missing PO line means the tolerance is unknowable, so the load cannot be silently accepted.
  const bandResult = await client.query(
    `SELECT
        (ordered_qty * (1 - COALESCE(under_receipt_tolerance_pct, 0) / 100))::text AS lower_bound,
        (ordered_qty * (1 + COALESCE(over_receipt_tolerance_pct, 0) / 100))::text AS upper_bound,
        ($3::numeric >= (ordered_qty * (1 - COALESCE(under_receipt_tolerance_pct, 0) / 100))
         AND $3::numeric <= (ordered_qty * (1 + COALESCE(over_receipt_tolerance_pct, 0) / 100))) AS within
       FROM erp_purchase_order_line
      WHERE po_number_ext = $1 AND line_no = $2`,
    [poRef, lineNo, netKg],
  );
  if (bandResult.rows.length === 0) {
    throw new AppError(
      404,
      'WEIGHBRIDGE_PO_LINE_NOT_FOUND',
      `No open PO line ${lineNo} exists for PO "${poRef}"`,
      { po_ref_ext: poRef, line_no: lineNo },
    );
  }
  const band = bandResult.rows[0]!;
  const within = band['within'] === true;
  const status: 'accepted' | 'tolerance_breach' = within ? 'accepted' : 'tolerance_breach';
  const toleranceBreachReason = within
    ? null
    : `Net weight ${netKg} kg is outside the accepted tolerance band [${band['lower_bound'] as string}, ${band['upper_bound'] as string}] for PO ${poRef} line ${lineNo}`;

  const occurredAt = envelope.metadata.occurred_at
    ? new Date(envelope.metadata.occurred_at)
    : new Date();

  await upsertWeighbridgeEvent(
    {
      weighbridge_event_id: p['weighbridge_event_id'] as string,
      correlation_id: correlationId,
      gate_event_id: gate['gate_event_id'] as string,
      site_id: siteId,
      site_code_ext: siteCodeExt,
      po_ref_ext: poRef,
      line_no: lineNo,
      tare_kg: p['tare_kg'] as string,
      gross_kg: p['gross_kg'] as string,
      net_kg: netKg,
      status,
      tolerance_breach_reason: toleranceBreachReason,
      device_id: p['device_id'] as string,
      capture_method: p['capture_method'] as 'AUTO' | 'MANUAL',
      weighed_by: p['weighed_by'] as string,
      business_date: localYmd(occurredAt),
      // Story 3.8: persist the capture instant itself, not only the calendar day derived from it.
      // The AC3 gate-dwell interval (gate entry -> weighbridge acceptance) is sub-day, so a DATE
      // cannot express it.
      occurred_at: occurredAt.toISOString(),
      source_event_id: eventId,
    },
    client,
  );

  // AC3: an out-of-tolerance load is blocked from silent receipt and routed as a task to the
  // named owner (receiving supervisor). Transactional with the projection write above, so a
  // breach is never persisted without its routed alert (mirrors the Story 2.6/2.7 approval-task
  // pattern in src/compliance/planning-jobs.ts).
  if (status === 'tolerance_breach') {
    await emitNotificationInTransaction(
      {
        target: { role: TOLERANCE_BREACH_TARGET_ROLE, location_id: siteId },
        event_type: 'weighbridge_tolerance_breach',
        status_verb: 'Tolerance breach',
        object_type: 'weighbridge_event',
        object_id: p['weighbridge_event_id'] as string,
        actor_label: 'Weighbridge',
        next_step: toleranceBreachReason,
        actor: envelope.metadata.actor,
        correlation_id: correlationId,
      },
      client,
    );
  }
}

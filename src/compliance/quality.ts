import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import type { RetentionSampleScope } from '../config/index.js';
import { isValidCalendarDate, toIstCalendarDate } from '../lib/business-days.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getItemById, getItemBySku, itemExistsBySku } from '../read/projections/item_master.js';
import {
  clearQualityHold,
  createLot,
  lotExistsByNumberAndSku,
  placeQualityHold,
} from '../read/projections/lot_master.js';
import { appendTraceEntry } from '../read/projections/lot_trace.js';
import { getBomById, getBomRevisionById } from '../read/projections/bom.js';
import { locationExistsById } from '../read/projections/location_register.js';
import { assertNotRdDraft } from './bom.js';
import {
  findActiveDelegation,
  findMatchingDoaEntry,
  findRoleHolder,
  listActiveDoaEntries,
} from '../read/projections/doa_registry.js';
import {
  getInspectionPlanByGrain,
  getInspectionPlanById,
  getInspectionPlanVersionByEffectiveFrom,
  getInspectionPlanVersionById,
  getMaxInspectionPlanVersionNo,
  insertInspectionPlan,
  insertInspectionPlanCharacteristic,
  insertInspectionPlanVersion,
  listInspectionPlanCharacteristics,
  listInspectionPlanVersions,
  resolveApprovedInspectionPlanVersion,
} from '../read/projections/inspection_plan.js';
import type {
  InspectionPlanRow,
  InspectionPlanScope,
  InspectionPlanVersionRow,
} from '../read/projections/inspection_plan.js';
import { insertInspectionPlanApproval } from '../read/projections/inspection_plan_approval.js';
import {
  getQcInspectionTaskById,
  getQcInspectionTaskByLotId,
  getQcInspectionTaskBySource,
  insertQcInspectionTask,
  transitionQcGate,
  transitionQcTaskStatus,
} from '../read/projections/qc_inspection_task.js';
import type { QcInspectionTaskRow } from '../read/projections/qc_inspection_task.js';
import {
  getConditionalReleaseForLot,
  getQcLotDispositionByLotId,
  insertQcDeviation,
  insertQcLotDisposition,
} from '../read/projections/qc_lot_disposition.js';
import {
  getQcBatchReleaseByLotId,
  insertQcBatchRelease,
} from '../read/projections/qc_batch_release.js';
import type { QcDocumentKind } from '../read/projections/qc_batch_release.js';
import {
  getQcRetentionSampleById,
  getQcRetentionSampleByLotId,
  insertQcRetentionSample,
  markQcRetentionSampleDisposalPending,
  setQcRetentionSampleExpiry,
} from '../read/projections/qc_retention_sample.js';
import {
  getQcSamplingPlanByTaskId,
  insertQcSamplingPlan,
} from '../read/projections/qc_sampling_plan.js';
import type { QcSamplingPlanRow } from '../read/projections/qc_sampling_plan.js';
import {
  countResultsByCharacteristic,
  insertQcInspectionResults,
  listNonconformingUnits,
  listResultRecorderUserIds,
} from '../read/projections/qc_inspection_result.js';
import type { InsertQcInspectionResultRow } from '../read/projections/qc_inspection_result.js';
import {
  getSwitchingState,
  initialSwitchingState,
  upsertSwitchingState,
} from '../read/projections/qc_sampling_switching_state.js';
import { getInstrumentRecordByAssetId } from '../read/projections/instrument_register.js';
import { getCalibrationStatus } from '../read/projections/instrument_calibration.js';
import { determineSampling } from '../quality/sampling.js';
import {
  advanceSwitchingState,
  applyAuthorizeReduced,
  applyResumeInspection,
  evaluateOutcome,
} from '../quality/switching.js';
import type { SwitchingSnapshot } from '../quality/switching.js';
import {
  PREFERRED_AQLS,
  TABLES_BY_SEVERITY,
  canonicalAql,
  isCodeLetter,
  isInspectionLevel,
  tighterAql,
} from '../quality/aql-tables.js';
import {
  insertQcNcr,
  insertHoldSourcedQcNcr,
  getQcNcrById,
  setQcNcrOutcome,
  countMatchingNcrsInWindow,
  linkCapaToNcr,
} from '../read/projections/qc_ncr.js';
import {
  getOpenQcQualityHoldByLotId,
  getQcQualityHoldById,
  insertQcQualityHold,
  otherOpenQcQualityHoldExists,
  releaseQcQualityHold,
} from '../read/projections/qc_quality_hold.js';
import {
  allocateQcCapaNumber,
  closeQcCapa,
  getQcCapaById,
  insertQcCapa,
} from '../read/projections/qc_capa.js';
import { insertQcLotSplit } from '../read/projections/qc_lot_split.js';
import {
  appendRelabelTrace,
  availableScaled,
  fromScaledQuantity,
  lockOwnedLotGrains,
  relabelLotQuantity,
  toScaledQuantity,
} from '../quality/lot-split.js';

/**
 * Story 8.1 compliance seam for the inspection-plan family and the QC gate (FR-Q-01, FR-Q-02,
 * FR-Q-05). Structurally mirrors src/compliance/maintenance-sync-conflict.ts: a stream gate, PURE
 * pre-transaction shape asserts, an in-transaction applier switch, an alreadyPersisted guard and
 * the same reject() AppError helper.
 *
 * Stream gate (Task 3): every Story 8.1 event name is gated on BOTH stream_type = 'qc' AND the
 * exact event type. The platform never verifies stream_type against the registry, so the same
 * names on a foreign stream are simply not this family's events: qualityEventType() returns null,
 * no shape assert runs, no applier runs, and assertForeignStreamRejected() below closes the
 * remaining gap by rejecting a Story 8.1 event name on any stream other than 'qc' outright, so a
 * caller cannot park a plausible-looking "approval" on the inventory stream.
 *
 * LOCKING CONTRACT (the fixed order every QC path shares, Task 6):
 * - plan create / approve: pg_advisory_xact_lock keyed by the grain and by plan_id. app_user holds
 *   no UPDATE on the plan tables, so FOR UPDATE is not available there; the advisory lock plus the
 *   unique constraints serialize version allocation and approval (never MAX(version)+1 unlocked).
 * - completion: lot_master FOR UPDATE, then the (not yet existing) task row's grain via the
 *   uq_qc_inspection_task_lot / _source backstops, then the stock read. The producer holds its own
 *   locks already; the hand-off joins the producer's transaction.
 * - conditional release and every gate assertion: lot row, then the QC-gate row (qc_inspection_task
 *   FOR UPDATE), then stock rows (taken by the Epic 2 helpers last). Conditional release uses the
 *   same prefix, so a release racing a consumption or a dispatch cannot deadlock.
 * - The DOA registry reads are plain SELECTs on append-only configuration and carry no lock-order
 *   dependency; they run on the transaction client so the re-derivation sees the same snapshot.
 */

const QC_STREAM_TYPES = new Set(['qc']);
export const INSPECTION_PLAN_CREATED = 'qc.inspection_plan_created';
export const INSPECTION_PLAN_APPROVED = 'qc.inspection_plan_approved';
export const QC_COMPLETION_RECEIVED = 'qc.completion_received';
export const QC_CONDITIONAL_RELEASE_RECORDED = 'qc.conditional_release_recorded';
// Story 8.2 (FR-Q-03, FR-Q-04): sampling determination, instrument-bound results (the Story 1.7
// event type, now registered with its full shape), instrument-less observations, inspection
// completion and the QC Head-level switching-state commands.
export const QC_SAMPLING_DETERMINED = 'qc.sampling_determined';
export const QC_RESULT_RECORDED = 'qc.result_recorded';
export const QC_OBSERVATION_RECORDED = 'qc.observation_recorded';
export const QC_INSPECTION_COMPLETED = 'qc.inspection_completed';
export const QC_SAMPLING_STATE_ADJUSTED = 'qc.sampling_state_adjusted';
// Story 8.3 (FR-Q-05, FR-Q-06): the accept/reject disposition, the partial split, the once-only
// NCR outcome and the rework integration contract Story 6.3 subscribes to.
export const QC_LOT_DISPOSITIONED = 'qc.lot_dispositioned';
export const QC_LOT_SPLIT_RECORDED = 'qc.lot_split_recorded';
export const QC_NCR_OUTCOME_RECORDED = 'qc.ncr_outcome_recorded';
export const QC_REWORK_REQUESTED = 'qc.rework_requested';
// Story 8.4 (FR-Q-07, FR-Q-08): the batch release record, the retention sample and the recorded
// disposal the 30-day expiry alert raises. All three are central-only (nothing about release or
// retention is captured at the edge PWA).
export const QC_BATCH_RELEASE_RECORDED = 'qc.batch_release_recorded';
export const QC_RETENTION_SAMPLE_LOGGED = 'qc.retention_sample_logged';
export const QC_RETENTION_SAMPLE_DISPOSED = 'qc.retention_sample_disposed';
// Story 8.5 (FR-Q-09, FR-Q-10): the governed hold record over the existing lot_master enforcement
// flag, the hold-sourced NCR origin and the first-class CAPA. All six are central-only - they join
// QC_CENTRAL_ONLY_EVENT_TYPES by construction (the derivation below filters out only
// qc.result_recorded), which a test asserts rather than assumes.
export const QC_HOLD_PLACED = 'qc.hold_placed';
export const QC_HOLD_RELEASED = 'qc.hold_released';
export const QC_NCR_RAISED = 'qc.ncr_raised';
export const QC_CAPA_OPENED = 'qc.capa_opened';
export const QC_CAPA_CLOSED = 'qc.capa_closed';
export const QC_CAPA_LINKED = 'qc.capa_linked';
export const QUALITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  INSPECTION_PLAN_CREATED,
  INSPECTION_PLAN_APPROVED,
  QC_COMPLETION_RECEIVED,
  QC_CONDITIONAL_RELEASE_RECORDED,
  QC_SAMPLING_DETERMINED,
  QC_RESULT_RECORDED,
  QC_OBSERVATION_RECORDED,
  QC_INSPECTION_COMPLETED,
  QC_SAMPLING_STATE_ADJUSTED,
  QC_LOT_DISPOSITIONED,
  QC_LOT_SPLIT_RECORDED,
  QC_NCR_OUTCOME_RECORDED,
  QC_REWORK_REQUESTED,
  QC_BATCH_RELEASE_RECORDED,
  QC_RETENTION_SAMPLE_LOGGED,
  QC_RETENTION_SAMPLE_DISPOSED,
  QC_HOLD_PLACED,
  QC_HOLD_RELEASED,
  QC_NCR_RAISED,
  QC_CAPA_OPENED,
  QC_CAPA_CLOSED,
  QC_CAPA_LINKED,
]);
/**
 * Story 8.1 Binding Scope Decision 9 / Story 8.2 Binding Scope Decision 8: every QC command is
 * central-only on the edge route EXCEPT qc.result_recorded, which keeps its Story 1.7 edge
 * allowance (an explicit set, never the whole family, so the exclusion is visible here).
 */
export const QC_CENTRAL_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(
  [...QUALITY_EVENT_TYPES].filter((type) => type !== QC_RESULT_RECORDED),
);
export const SWITCHING_ACTIONS: ReadonlySet<string> = new Set([
  'authorize_reduced',
  'resume_inspection',
]);
export const MAX_READINGS_PER_RESULT = 500;
const MAX_INSTRUMENT_ID_LENGTH = 128;

export const INSPECTION_PLAN_APPROVAL_DOA_TYPE = 'qc.inspection_plan_approval';
export const CONDITIONAL_RELEASE_DOA_TYPE = 'qc.conditional_release';

export const PLAN_SCOPES: ReadonlySet<string> = new Set(['standard', 'customer_override']);
export const CHARACTERISTIC_CLASSES: ReadonlySet<string> = new Set(['critical', 'major', 'minor']);
export const RESULT_KINDS: ReadonlySet<string> = new Set(['numeric', 'attribute']);
export const DEVIATION_SCOPE_KINDS: ReadonlySet<string> = new Set([
  'internal_movement',
  'order_allocation',
  'dispatch',
]);
export const SOURCE_COMPLETION_TYPES: ReadonlySet<string> = new Set([
  'synthetic_completion',
  'production_order',
  'job_work_order',
]);
export const MAX_CHARACTERISTICS = 500;
const MAX_TEXT_2000 = 2000;

// Story 8.3 (FR-Q-05, FR-Q-06).
export const LOT_DISPOSITIONS: ReadonlySet<string> = new Set(['accept', 'reject']);
export const NCR_OUTCOMES: ReadonlySet<string> = new Set(['rework', 'downgrade', 'scrap']);
/** Annex requirement 4: a split produces at least two and at most twenty children. */
export const MIN_SPLIT_CHILDREN = 2;
export const MAX_SPLIT_CHILDREN = 20;
/** Annex requirement 9 (scrap): the reason stamped on the lot's independent hold axis. */
export const SCRAP_PENDING_HOLD_REASON = 'scrap_pending';

// Story 8.4 (FR-Q-07, Binding Scope Decision 1): the two dispositions a lot may be released from.
export const RELEASABLE_DISPOSITIONS: ReadonlySet<string> = new Set([
  'accept',
  'conditional_release',
]);
// The certificate-format vocabulary (Binding Scope Decision 4) is owned by the projection module
// (QC_DOCUMENT_KINDS in src/read/projections/qc_batch_release.ts) and is deliberately NOT
// re-declared here: a second same-named constant for the same fact is exactly what drifts.
const MAX_UOM_LENGTH = 32;
/**
 * Story 8.4 review: the statutory retention window is derived from a CLIENT-supplied timestamp, so
 * that timestamp is bounded server-side. Without this, a back-dated decided_at mints a certificate
 * whose retention has already lapsed - the outcome AC2's RETENTION_FLOOR_VIOLATION boot guard
 * exists to prevent, reached by a different route - and a back-dated logged_at makes the very next
 * sweep tick flip a brand-new sample to disposal_pending, which no code path can undo.
 */
const MAX_RETENTION_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RETENTION_CLOCK_BACKDATE_MS = 30 * 24 * 60 * 60 * 1000;

function assertRetentionClockBounds(value: string, field: string, context: string): void {
  const at = new Date(value).getTime();
  const now = Date.now();
  if (at > now + MAX_RETENTION_CLOCK_SKEW_MS) {
    reject('INVALID_PAYLOAD', `${field} cannot be in the future on ${context}`, {
      field,
      [field]: value,
    });
  }
  if (at < now - MAX_RETENTION_CLOCK_BACKDATE_MS) {
    reject(
      'INVALID_PAYLOAD',
      `${field} is too far in the past on ${context}; the retention window is derived from it`,
      { field, [field]: value },
    );
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An explicit UTC offset is REQUIRED (the Story 7.2 offset lesson).
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// NUMERIC(18,6) magnitude as a decimal STRING; never a JS float on the authoritative path.
const QUANTITY_REGEX = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
const SIGNED_LIMIT_REGEX = /^-?(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
// NUMERIC(7,3) AQL input (Story 8.2 consumes it; this story stores it exactly).
const AQL_REGEX = /^(0|[1-9]\d{0,3})(\.\d{1,3})?$/;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO8601_TIMESTAMP_REGEX.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Exported so the API layer validates with the SAME rule instead of a second drifting copy. */
export function isPositiveQuantity(value: unknown): value is string {
  return typeof value === 'string' && QUANTITY_REGEX.test(value) && /[1-9]/.test(value);
}

/** Exact decimal-string comparison (sign, integer part, fraction), no float conversion. */
export function compareDecimalStrings(a: string, b: string): number {
  const parse = (v: string): { neg: boolean; int: string; frac: string } => {
    const neg = v.startsWith('-');
    const body = neg ? v.slice(1) : v;
    const [int = '0', frac = ''] = body.split('.');
    return { neg, int: int.replace(/^0+(?=\d)/, ''), frac: frac.replace(/0+$/, '') };
  };
  const x = parse(a);
  const y = parse(b);
  const isZero = (p: { int: string; frac: string }): boolean => p.int === '0' && p.frac === '';
  if (isZero(x) && isZero(y)) return 0;
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const magnitude = (): number => {
    if (x.int.length !== y.int.length) return x.int.length < y.int.length ? -1 : 1;
    if (x.int !== y.int) return x.int < y.int ? -1 : 1;
    const width = Math.max(x.frac.length, y.frac.length);
    const xf = x.frac.padEnd(width, '0');
    const yf = y.frac.padEnd(width, '0');
    if (xf === yf) return 0;
    return xf < yf ? -1 : 1;
  };
  const m = magnitude();
  return x.neg ? -m : m;
}

export function qualityEventType(envelope: EventEnvelope): string | null {
  if (!QC_STREAM_TYPES.has(envelope.stream_type)) return null;
  if (!QUALITY_EVENT_TYPES.has(envelope.event_type)) return null;
  return envelope.event_type;
}

function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status: number = 400,
): never {
  throw new AppError(status, code, message, details);
}

function rejectDeclaredDerived(
  p: Record<string, unknown>,
  fields: string[],
  context: string,
): void {
  for (const field of fields) {
    if (p[field] !== undefined) {
      reject(
        'QC_DERIVATION_MISMATCH',
        `${field} is derived by the server and cannot be declared on ${context}`,
        { field, declared_value: p[field] },
        409,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-transaction shape validation (no DB access)
// ---------------------------------------------------------------------------

/**
 * Task 3: a Story 8.1 event NAME on any stream other than 'qc' is rejected outright (400
 * INVALID_PAYLOAD) instead of being silently ignored, closing this instance of the platform
 * stream-mismatch bypass. Runs before every other assert.
 */
export function assertQualityForeignStreamRejected(envelope: EventEnvelope): void {
  if (QUALITY_EVENT_TYPES.has(envelope.event_type) && !QC_STREAM_TYPES.has(envelope.stream_type)) {
    reject('INVALID_PAYLOAD', `${envelope.event_type} must be persisted on the qc stream`, {
      event_type: envelope.event_type,
      stream_type: envelope.stream_type,
    });
  }
}

function assertCharacteristicShape(raw: unknown, index: number): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    reject('INVALID_PAYLOAD', `characteristics[${index}] must be an object`);
  }
  const c = raw as Record<string, unknown>;
  if (!isUuid(c['characteristic_id'])) {
    reject('INVALID_PAYLOAD', `characteristics[${index}].characteristic_id must be a UUID`);
  }
  if (!Number.isInteger(c['line_no']) || (c['line_no'] as number) <= 0) {
    reject('INVALID_PAYLOAD', `characteristics[${index}].line_no must be a positive integer`);
  }
  if (!isBoundedText(c['characteristic_name'], 200)) {
    reject(
      'INVALID_PAYLOAD',
      `characteristics[${index}].characteristic_name must be a non-empty string of at most 200 characters`,
    );
  }
  if (
    typeof c['characteristic_class'] !== 'string' ||
    !CHARACTERISTIC_CLASSES.has(c['characteristic_class'])
  ) {
    reject(
      'INVALID_PAYLOAD',
      `characteristics[${index}].characteristic_class must be one of: critical, major, minor`,
    );
  }
  if (!isBoundedText(c['test_method_ref'], 200)) {
    reject(
      'INVALID_PAYLOAD',
      `characteristics[${index}].test_method_ref must be a non-empty string of at most 200 characters`,
    );
  }
  if (c['instrument_type'] !== null && !isBoundedText(c['instrument_type'], 100)) {
    reject(
      'INVALID_PAYLOAD',
      `characteristics[${index}].instrument_type must be null or a non-empty string of at most 100 characters`,
    );
  }
  if (!isBoundedText(c['sample_handling'], 1000)) {
    reject(
      'INVALID_PAYLOAD',
      `characteristics[${index}].sample_handling must be a non-empty string of at most 1000 characters`,
    );
  }
  const kind = c['result_kind'];
  if (typeof kind !== 'string' || !RESULT_KINDS.has(kind)) {
    reject(
      'INVALID_PAYLOAD',
      `characteristics[${index}].result_kind must be one of: numeric, attribute`,
    );
  }
  const lower = c['lower_limit'];
  const upper = c['upper_limit'];
  if (kind === 'numeric') {
    if (lower !== null && (typeof lower !== 'string' || !SIGNED_LIMIT_REGEX.test(lower))) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}].lower_limit must be null or a decimal string`,
      );
    }
    if (upper !== null && (typeof upper !== 'string' || !SIGNED_LIMIT_REGEX.test(upper))) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}].upper_limit must be null or a decimal string`,
      );
    }
    if (lower === null && upper === null) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}] is numeric and must carry at least one acceptance limit`,
      );
    }
    if (
      typeof lower === 'string' &&
      typeof upper === 'string' &&
      compareDecimalStrings(lower, upper) > 0
    ) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}].lower_limit must not exceed upper_limit`,
        { lower_limit: lower, upper_limit: upper },
      );
    }
    if (c['limit_uom'] !== null && !isBoundedText(c['limit_uom'], 32)) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}].limit_uom must be null or a non-empty string of at most 32 characters`,
      );
    }
    if (c['acceptance_criteria'] !== null) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}] is numeric and must not carry acceptance_criteria`,
      );
    }
  } else {
    if (lower !== null || upper !== null || c['limit_uom'] !== null) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}] is attribute and must not carry numeric limits`,
      );
    }
    if (!isBoundedText(c['acceptance_criteria'], 1000)) {
      reject(
        'INVALID_PAYLOAD',
        `characteristics[${index}].acceptance_criteria must be a non-empty string of at most 1000 characters`,
      );
    }
  }
}

function assertScopePairing(p: Record<string, unknown>, context: string): void {
  const scope = p['scope'];
  const orderType = p['source_order_type'];
  const orderRef = p['source_order_ref'];
  if (typeof scope !== 'string' || !PLAN_SCOPES.has(scope)) {
    reject('INVALID_PAYLOAD', `${context}.scope must be one of: standard, customer_override`);
  }
  if (scope === 'standard') {
    if (orderType !== null || orderRef !== null) {
      reject(
        'INVALID_PAYLOAD',
        'A standard plan must not carry source_order_type or source_order_ref',
      );
    }
  } else {
    if (orderType !== 'job_work_order') {
      reject('INVALID_PAYLOAD', 'A customer override must carry source_order_type job_work_order', {
        source_order_type: orderType,
      });
    }
    if (!isBoundedText(orderRef, 128)) {
      reject(
        'INVALID_PAYLOAD',
        'A customer override must carry a non-empty source_order_ref of at most 128 characters',
      );
    }
  }
}

function assertInspectionPlanCreatedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['plan_id'])) reject('INVALID_PAYLOAD', 'plan_id must be a UUID');
  if (envelope.stream_id !== p['plan_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the plan_id for qc.inspection_plan_created', {
      stream_id: envelope.stream_id,
      payload_plan_id: p['plan_id'],
    });
  }
  if (!isUuid(p['plan_version_id'])) reject('INVALID_PAYLOAD', 'plan_version_id must be a UUID');
  if (!isUuid(p['item_id'])) reject('INVALID_PAYLOAD', 'item_id must be a UUID');
  if (!isUuid(p['bom_revision_id'])) reject('INVALID_PAYLOAD', 'bom_revision_id must be a UUID');
  assertScopePairing(p, 'qc.inspection_plan_created');
  if (typeof p['effective_from'] !== 'string' || !isValidCalendarDate(p['effective_from'])) {
    reject('INVALID_PAYLOAD', 'effective_from must be a valid YYYY-MM-DD calendar date');
  }
  const aql = p['aql'];
  const level = p['inspection_level'];
  if (
    aql !== null &&
    (typeof aql !== 'string' ||
      !AQL_REGEX.test(aql) ||
      !/[1-9]/.test(aql) ||
      compareDecimalStrings(aql, '1000') > 0)
  ) {
    reject(
      'INVALID_PAYLOAD',
      'aql must be null or a positive decimal string of at most 1000 with at most 3 places',
    );
  }
  if (level !== null && !isBoundedText(level, 16)) {
    reject(
      'INVALID_PAYLOAD',
      'inspection_level must be null or a non-empty string of at most 16 characters',
    );
  }
  if ((aql === null) !== (level === null)) {
    reject('INVALID_PAYLOAD', 'aql and inspection_level must be supplied together or both be null');
  }
  // Story 8.2 (Annex requirements 2 and 3): the semantic gates behind the shape gates above, so a
  // version cannot carry an AQL or a level that sampling determination would reject later.
  if (typeof aql === 'string' && canonicalAql(aql) === null) {
    reject(
      'AQL_NOT_IN_STANDARD',
      'aql must be one of the preferred AQL values of IS 2500 (Part 1) / ISO 2859-1',
      { aql, preferred_aqls: [...PREFERRED_AQLS] },
    );
  }
  if (level !== null && !isInspectionLevel(level)) {
    reject(
      'INSPECTION_LEVEL_INVALID',
      'inspection_level must be one of: I, II, III, S-1, S-2, S-3, S-4',
      { inspection_level: level },
    );
  }
  const characteristics = p['characteristics'];
  if (!Array.isArray(characteristics) || characteristics.length === 0) {
    reject('INVALID_PAYLOAD', 'characteristics must be a non-empty array');
  }
  if (characteristics.length > MAX_CHARACTERISTICS) {
    reject('INVALID_PAYLOAD', `characteristics must carry at most ${MAX_CHARACTERISTICS} lines`);
  }
  const lineNos = new Set<number>();
  const ids = new Set<string>();
  characteristics.forEach((raw, index) => {
    assertCharacteristicShape(raw, index);
    const c = raw as Record<string, unknown>;
    if (lineNos.has(c['line_no'] as number)) {
      reject('INVALID_PAYLOAD', `characteristics line_no ${c['line_no']} is duplicated`);
    }
    lineNos.add(c['line_no'] as number);
    if (ids.has(c['characteristic_id'] as string)) {
      reject('INVALID_PAYLOAD', `characteristic_id ${c['characteristic_id']} is duplicated`);
    }
    ids.add(c['characteristic_id'] as string);
  });
  if (!isIsoTimestamp(p['created_at'])) {
    reject('INVALID_PAYLOAD', 'created_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(p, ['version_no', 'sku'], 'qc.inspection_plan_created');
}

function assertInspectionPlanApprovedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['plan_id'])) reject('INVALID_PAYLOAD', 'plan_id must be a UUID');
  if (envelope.stream_id !== p['plan_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the plan_id for qc.inspection_plan_approved', {
      stream_id: envelope.stream_id,
      payload_plan_id: p['plan_id'],
    });
  }
  if (!isUuid(p['plan_version_id'])) reject('INVALID_PAYLOAD', 'plan_version_id must be a UUID');
  if (!isIsoTimestamp(p['approved_at'])) {
    reject('INVALID_PAYLOAD', 'approved_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(
    p,
    ['approved_by', 'resolved_approver_user_id', 'doa_entry_id', 'governing_role'],
    'qc.inspection_plan_approved',
  );
}

function assertCompletionReceivedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['task_id'])) reject('INVALID_PAYLOAD', 'task_id must be a UUID');
  if (envelope.stream_id !== p['task_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the task_id for qc.completion_received', {
      stream_id: envelope.stream_id,
      payload_task_id: p['task_id'],
    });
  }
  if (
    typeof p['source_completion_type'] !== 'string' ||
    !SOURCE_COMPLETION_TYPES.has(p['source_completion_type'])
  ) {
    reject(
      'INVALID_PAYLOAD',
      'source_completion_type must be one of: synthetic_completion, production_order, job_work_order',
    );
  }
  if (!isUuid(p['source_completion_id'])) {
    reject('INVALID_PAYLOAD', 'source_completion_id must be a UUID');
  }
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  if (!isBoundedText(p['lot_number'], 128)) {
    reject('INVALID_PAYLOAD', 'lot_number must be a non-empty string of at most 128 characters');
  }
  if (!isUuid(p['item_id'])) reject('INVALID_PAYLOAD', 'item_id must be a UUID');
  if (!isPositiveQuantity(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity must be a positive decimal string with at most 6 places');
  }
  if (!isBoundedText(p['uom'], 32)) {
    reject('INVALID_PAYLOAD', 'uom must be a non-empty string of at most 32 characters');
  }
  if (!isUuid(p['site_id'])) reject('INVALID_PAYLOAD', 'site_id must be a UUID');
  if (!isUuid(p['bom_revision_id'])) reject('INVALID_PAYLOAD', 'bom_revision_id must be a UUID');
  const orderType = p['source_order_type'];
  const orderRef = p['source_order_ref'];
  if (orderType === null) {
    if (orderRef !== null) {
      reject('INVALID_PAYLOAD', 'source_order_ref requires source_order_type job_work_order');
    }
  } else if (orderType !== 'job_work_order') {
    reject('INVALID_PAYLOAD', 'source_order_type must be null or job_work_order', {
      source_order_type: orderType,
    });
  } else if (!isBoundedText(orderRef, 128)) {
    reject(
      'INVALID_PAYLOAD',
      'source_order_ref must be a non-empty string of at most 128 characters for a job_work_order',
    );
  }
  if (!isIsoTimestamp(p['completed_at'])) {
    reject('INVALID_PAYLOAD', 'completed_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (!isBoundedText(p['business_stream'], 64)) {
    reject('INVALID_PAYLOAD', 'business_stream must be a non-empty string');
  }
  rejectDeclaredDerived(
    p,
    [
      'business_date',
      'sku',
      'plan_id',
      'plan_version_id',
      'plan_scope',
      'gate_status',
      'task_status',
    ],
    'qc.completion_received',
  );
}

function assertConditionalReleaseRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['task_id'])) reject('INVALID_PAYLOAD', 'task_id must be a UUID');
  if (envelope.stream_id !== p['task_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the task_id for qc.conditional_release_recorded', {
      stream_id: envelope.stream_id,
      payload_task_id: p['task_id'],
    });
  }
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  if (!isUuid(p['deviation_id'])) reject('INVALID_PAYLOAD', 'deviation_id must be a UUID');
  if (!isUuid(p['disposition_id'])) reject('INVALID_PAYLOAD', 'disposition_id must be a UUID');
  if (!isBoundedText(p['justification'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `justification must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (!isBoundedText(p['conditions'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `conditions must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (typeof p['scope_kind'] !== 'string' || !DEVIATION_SCOPE_KINDS.has(p['scope_kind'])) {
    reject(
      'INVALID_PAYLOAD',
      'scope_kind must be one of: internal_movement, order_allocation, dispatch',
    );
  }
  if (!isBoundedText(p['scope_ref'], 128)) {
    reject('INVALID_PAYLOAD', 'scope_ref must be a non-empty string of at most 128 characters');
  }
  if (!isIsoTimestamp(p['decided_at'])) {
    reject('INVALID_PAYLOAD', 'decided_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (typeof p['expires_on'] !== 'string' || !isValidCalendarDate(p['expires_on'])) {
    reject('INVALID_PAYLOAD', 'expires_on must be a valid YYYY-MM-DD calendar date');
  }
  // A valid FUTURE expiry (Task 7): strictly after the IST business date of the decision instant.
  const decidedOn = toIstCalendarDate(new Date(p['decided_at'] as string));
  if ((p['expires_on'] as string) <= decidedOn) {
    reject('INVALID_PAYLOAD', 'expires_on must be after the decision business date', {
      expires_on: p['expires_on'],
      decided_on: decidedOn,
    });
  }
  rejectDeclaredDerived(
    p,
    [
      'requested_by',
      'approved_by',
      'doa_entry_id',
      'inspector_user_id',
      'decided_on',
      'previous_gate_status',
      'gate_status',
    ],
    'qc.conditional_release_recorded',
  );
}

// ---------------------------------------------------------------------------
// Story 8.2 shape validation (pre-transaction, no DB access)
// ---------------------------------------------------------------------------

const SAMPLING_DERIVED_FIELDS = [
  'lot_id',
  'lot_number',
  'plan_version_id',
  'plan_id',
  'site_id',
  'lot_size',
  'aql',
  'inspection_level',
  'severity',
  'code_letter',
  'resolved_code_letter',
  'sample_size',
  'acceptance_number',
  'rejection_number',
  'sampling_basis',
  'standard_ref',
  'critical_characteristic_ids',
  'determined_by',
  'previous_task_status',
  'task_status',
];

function assertTaskStream(envelope: EventEnvelope, p: Record<string, unknown>): void {
  if (!isUuid(p['task_id'])) reject('INVALID_PAYLOAD', 'task_id must be a UUID');
  if (envelope.stream_id !== p['task_id']) {
    reject('INVALID_PAYLOAD', `stream_id must be the task_id for ${envelope.event_type}`, {
      stream_id: envelope.stream_id,
      payload_task_id: p['task_id'],
    });
  }
}

function assertSamplingDeterminedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  assertTaskStream(envelope, p);
  if (!isUuid(p['sampling_id'])) reject('INVALID_PAYLOAD', 'sampling_id must be a UUID');
  if (!isIsoTimestamp(p['determined_at'])) {
    reject(
      'INVALID_PAYLOAD',
      'determined_at must be an ISO 8601 timestamp with an explicit offset',
    );
  }
  rejectDeclaredDerived(p, SAMPLING_DERIVED_FIELDS, QC_SAMPLING_DETERMINED);
}

/**
 * Binding Scope Decision 4: 1 to 500 readings for ONE characteristic; unique result ids and unit
 * numbers within the event; decimal strings for measured values; a bounded uom; booleans for
 * attribute conformance. The kind pairing itself is verified in the transaction against the
 * frozen plan line.
 */
function assertReadingsShape(
  p: Record<string, unknown>,
  context: string,
  attributeOnly: boolean,
): void {
  const readings = p['readings'];
  if (!Array.isArray(readings) || readings.length === 0) {
    reject('INVALID_PAYLOAD', `${context}.readings must be a non-empty array`);
  }
  if (readings.length > MAX_READINGS_PER_RESULT) {
    reject(
      'INVALID_PAYLOAD',
      `${context}.readings must carry at most ${MAX_READINGS_PER_RESULT} entries`,
      {
        readings: readings.length,
        max: MAX_READINGS_PER_RESULT,
      },
    );
  }
  const ids = new Set<string>();
  const units = new Set<number>();
  readings.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      reject('INVALID_PAYLOAD', `readings[${index}] must be an object`);
    }
    const r = raw as Record<string, unknown>;
    if (!isUuid(r['result_id']))
      reject('INVALID_PAYLOAD', `readings[${index}].result_id must be a UUID`);
    if (ids.has(r['result_id'] as string)) {
      reject('INVALID_PAYLOAD', `readings[${index}].result_id is duplicated within the event`);
    }
    ids.add(r['result_id'] as string);
    const unit = r['sample_unit_no'];
    if (typeof unit !== 'number' || !Number.isSafeInteger(unit) || unit <= 0) {
      reject('INVALID_PAYLOAD', `readings[${index}].sample_unit_no must be a positive integer`);
    }
    if (units.has(unit as number)) {
      reject(
        'INVALID_PAYLOAD',
        `readings[${index}].sample_unit_no ${unit} is duplicated within the event`,
      );
    }
    units.add(unit as number);
    const value = r['measured_value'];
    if (value !== undefined && (typeof value !== 'string' || !SIGNED_LIMIT_REGEX.test(value))) {
      reject('INVALID_PAYLOAD', `readings[${index}].measured_value must be a decimal string`);
    }
    const uom = r['measured_uom'];
    if (uom !== undefined && !isBoundedText(uom, 32)) {
      reject(
        'INVALID_PAYLOAD',
        `readings[${index}].measured_uom must be a non-empty string of at most 32 characters`,
      );
    }
    const conforms = r['attribute_conforms'];
    if (conforms !== undefined && typeof conforms !== 'boolean') {
      reject('INVALID_PAYLOAD', `readings[${index}].attribute_conforms must be a boolean`);
    }
    if (attributeOnly) {
      if (typeof conforms !== 'boolean') {
        reject(
          'INVALID_PAYLOAD',
          `readings[${index}].attribute_conforms is required for an observation`,
        );
      }
      if (value !== undefined || uom !== undefined) {
        reject(
          'INVALID_PAYLOAD',
          `readings[${index}] of an observation must not carry a measured value`,
        );
      }
    }
  });
}

/**
 * Binding Scope Decision 1: a payload WITHOUT task_id is the Story 1.7 synthetic shape and is
 * validated only for the nonblank fields that route already requires; a payload WITH task_id is
 * the full, projected result shape.
 */
function assertResultRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (p['task_id'] === undefined) {
    for (const field of ['instrument_id', 'lot_id', 'parameter']) {
      if (typeof p[field] !== 'string' || (p[field] as string).trim() === '') {
        reject('INVALID_PAYLOAD', `${field} must be a non-empty string`, { field });
      }
    }
    if (p['value'] === undefined || p['value'] === null) {
      reject('INVALID_PAYLOAD', 'value is required');
    }
    return;
  }
  assertTaskStream(envelope, p);
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  if (!isUuid(p['characteristic_id']))
    reject('INVALID_PAYLOAD', 'characteristic_id must be a UUID');
  if (!isUuid(p['instrument_asset_id'])) {
    reject('INVALID_PAYLOAD', 'instrument_asset_id must be a UUID');
  }
  if (!isBoundedText(p['instrument_id'], MAX_INSTRUMENT_ID_LENGTH)) {
    reject('INVALID_PAYLOAD', 'instrument_id must be a non-empty string of at most 128 characters');
  }
  assertReadingsShape(p, QC_RESULT_RECORDED, false);
  if (!isIsoTimestamp(p['recorded_at'])) {
    reject('INVALID_PAYLOAD', 'recorded_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(
    p,
    ['characteristic_class', 'result_kind', 'conforms_by_result_id', 'recorded_by'],
    QC_RESULT_RECORDED,
  );
}

function assertObservationRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  assertTaskStream(envelope, p);
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  if (!isUuid(p['characteristic_id']))
    reject('INVALID_PAYLOAD', 'characteristic_id must be a UUID');
  if (p['instrument_asset_id'] !== undefined || p['instrument_id'] !== undefined) {
    reject(
      'INVALID_PAYLOAD',
      'An observation must not carry an instrument; use qc.result_recorded',
    );
  }
  assertReadingsShape(p, QC_OBSERVATION_RECORDED, true);
  if (!isIsoTimestamp(p['recorded_at'])) {
    reject('INVALID_PAYLOAD', 'recorded_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(
    p,
    ['characteristic_class', 'result_kind', 'conforms_by_result_id', 'recorded_by'],
    QC_OBSERVATION_RECORDED,
  );
}

function assertInspectionCompletedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  assertTaskStream(envelope, p);
  if (!isIsoTimestamp(p['completed_at'])) {
    reject('INVALID_PAYLOAD', 'completed_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(
    p,
    [
      'sampling_id',
      'sampling_outcome',
      'nonconforming_sample_units',
      'critical_nonconformities',
      'severity_used',
      'previous_severity',
      'new_severity',
      'switching_score',
      'reduced_eligible',
      'inspection_discontinued',
      'previous_task_status',
      'task_status',
      'inspected_by',
    ],
    QC_INSPECTION_COMPLETED,
  );
}

function assertSamplingStateAdjustedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['plan_id'])) reject('INVALID_PAYLOAD', 'plan_id must be a UUID');
  if (envelope.stream_id !== p['plan_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the plan_id for qc.sampling_state_adjusted', {
      stream_id: envelope.stream_id,
      payload_plan_id: p['plan_id'],
    });
  }
  if (!isUuid(p['site_id'])) reject('INVALID_PAYLOAD', 'site_id must be a UUID');
  if (typeof p['action'] !== 'string' || !SWITCHING_ACTIONS.has(p['action'])) {
    reject('INVALID_PAYLOAD', 'action must be one of: authorize_reduced, resume_inspection');
  }
  if (!isBoundedText(p['reason'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `reason must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (!isIsoTimestamp(p['adjusted_at'])) {
    reject('INVALID_PAYLOAD', 'adjusted_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(
    p,
    ['previous_severity', 'new_severity', 'authorized_by', 'authorizing_role'],
    QC_SAMPLING_STATE_ADJUSTED,
  );
}

/**
 * Story 8.3 (FR-Q-05, AC 1). Client fields: task_id (= stream_id), lot_id, the minted
 * disposition_id, the accept/reject choice, a justification and the decision instant. A reject
 * additionally carries the minted ncr_id; an accept must not. Everything else is derived under the
 * lot and task locks.
 */
function assertLotDispositionedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['task_id'])) reject('INVALID_PAYLOAD', 'task_id must be a UUID');
  if (envelope.stream_id !== p['task_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the task_id for qc.lot_dispositioned', {
      stream_id: envelope.stream_id,
      payload_task_id: p['task_id'],
    });
  }
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  if (!isUuid(p['disposition_id'])) reject('INVALID_PAYLOAD', 'disposition_id must be a UUID');
  if (typeof p['disposition'] !== 'string' || !LOT_DISPOSITIONS.has(p['disposition'])) {
    reject('INVALID_PAYLOAD', 'disposition must be one of: accept, reject');
  }
  if (!isBoundedText(p['justification'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `justification must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (!isIsoTimestamp(p['decided_at'])) {
    reject('INVALID_PAYLOAD', 'decided_at must be an ISO 8601 timestamp with an explicit offset');
  }
  // The NCR is created BY the reject (Annex requirement 8), so its identity travels with the event
  // and an accept may never carry one - the qc_lot_disposition ncr pairing check mirrors this.
  if (p['disposition'] === 'reject') {
    if (!isUuid(p['ncr_id'])) {
      reject('INVALID_PAYLOAD', 'ncr_id must be a UUID on a reject disposition');
    }
  } else if (p['ncr_id'] !== undefined && p['ncr_id'] !== null) {
    reject('INVALID_PAYLOAD', 'ncr_id is only valid on a reject disposition', {
      disposition: p['disposition'],
    });
  }
  rejectDeclaredDerived(
    p,
    [
      'lot_number',
      'sku',
      'site_id',
      'plan_version_id',
      'quantity',
      'sampling_outcome',
      'requested_by',
      'approved_by',
      'inspector_user_id',
      'previous_gate_status',
      'gate_status',
    ],
    QC_LOT_DISPOSITIONED,
  );
}

/**
 * Story 8.3 (FR-Q-05, AC 2). The client sends only the split shares. Quantities are validated as
 * decimal strings here; the sum-equals-parent check needs the task row and therefore runs in the
 * applier under the lock (QC_SPLIT_QUANTITY_MISMATCH).
 */
function assertLotSplitRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['task_id'])) reject('INVALID_PAYLOAD', 'task_id must be a UUID');
  if (envelope.stream_id !== p['task_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the task_id for qc.lot_split_recorded', {
      stream_id: envelope.stream_id,
      payload_task_id: p['task_id'],
    });
  }
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  if (!isUuid(p['disposition_id'])) reject('INVALID_PAYLOAD', 'disposition_id must be a UUID');
  if (!isBoundedText(p['justification'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `justification must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (!isIsoTimestamp(p['decided_at'])) {
    reject('INVALID_PAYLOAD', 'decided_at must be an ISO 8601 timestamp with an explicit offset');
  }
  const splits = p['splits'];
  if (
    !Array.isArray(splits) ||
    splits.length < MIN_SPLIT_CHILDREN ||
    splits.length > MAX_SPLIT_CHILDREN
  ) {
    reject(
      'QC_SPLIT_INVALID',
      `splits must be an array of ${MIN_SPLIT_CHILDREN} to ${MAX_SPLIT_CHILDREN} entries`,
      { split_count: Array.isArray(splits) ? splits.length : null },
    );
  }
  const seen = new Set<number>();
  for (const [index, entry] of (splits as unknown[]).entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      reject('QC_SPLIT_INVALID', 'every split entry must be an object', { index });
    }
    const split = entry as Record<string, unknown>;
    const sequence = split['sequence'];
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
      reject('QC_SPLIT_INVALID', 'every split sequence must be a positive integer', { index });
    }
    if (seen.has(sequence as number)) {
      reject('QC_SPLIT_INVALID', 'split sequences must be unique', { sequence });
    }
    seen.add(sequence as number);
    if (!isPositiveQuantity(split['quantity'])) {
      reject('QC_SPLIT_INVALID', 'every split quantity must be a positive decimal string', {
        index,
        quantity: split['quantity'] ?? null,
      });
    }
    rejectDeclaredDerived(
      split,
      ['lot_id', 'lot_number', 'task_id', 'source_completion_id'],
      QC_LOT_SPLIT_RECORDED,
    );
  }
  // Contiguous 1-based sequences (Annex requirement 4): the child lot-number suffix is derived from
  // the sequence, so a gap would mint non-contiguous lot numbers for a single split.
  for (let expected = 1; expected <= (splits as unknown[]).length; expected += 1) {
    if (!seen.has(expected)) {
      reject('QC_SPLIT_INVALID', 'split sequences must be contiguous starting at 1', {
        missing_sequence: expected,
      });
    }
  }
  rejectDeclaredDerived(
    p,
    [
      'lot_number',
      'sku',
      'site_id',
      'plan_version_id',
      'quantity',
      'requested_by',
      'approved_by',
      'inspector_user_id',
      'previous_gate_status',
      'gate_status',
    ],
    QC_LOT_SPLIT_RECORDED,
  );
}

/** Story 8.3 (FR-Q-06, AC 3, AC 4 and AC 5): the once-only NCR outcome. */
function assertNcrOutcomeRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['ncr_id'])) reject('INVALID_PAYLOAD', 'ncr_id must be a UUID');
  if (envelope.stream_id !== p['ncr_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the ncr_id for qc.ncr_outcome_recorded', {
      stream_id: envelope.stream_id,
      payload_ncr_id: p['ncr_id'],
    });
  }
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  // Story 8.5 (Binding Scope Decision 14): 'closed_with_capa' is the hold-sourced terminal
  // outcome; the applier rejects it on a disposition-sourced NCR and rejects the three
  // disposition-family outcomes on a hold-sourced NCR (NCR_OUTCOME_NOT_APPLICABLE).
  if (
    typeof p['outcome'] !== 'string' ||
    (!NCR_OUTCOMES.has(p['outcome']) && p['outcome'] !== NCR_HOLD_TERMINAL_OUTCOME)
  ) {
    reject('INVALID_PAYLOAD', 'outcome must be one of: rework, downgrade, scrap, closed_with_capa');
  }
  if (!isBoundedText(p['outcome_reason'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `outcome_reason must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (!isIsoTimestamp(p['decided_at'])) {
    reject('INVALID_PAYLOAD', 'decided_at must be an ISO 8601 timestamp with an explicit offset');
  }
  if (p['outcome'] === 'downgrade') {
    if (!isBoundedText(p['downgrade_sku'], 128)) {
      reject(
        'DOWNGRADE_SKU_REQUIRED',
        'downgrade_sku is required on a downgrade outcome and must be a non-empty string of at most 128 characters',
      );
    }
  } else if (p['downgrade_sku'] !== undefined) {
    reject('INVALID_PAYLOAD', 'downgrade_sku is only valid on a downgrade outcome', {
      outcome: p['outcome'],
    });
  }
  if (p['outcome'] === 'rework') {
    if (!isUuid(p['rework_event_id'])) {
      reject(
        'INVALID_PAYLOAD',
        'rework_event_id must be a UUID on a rework outcome (it is the id of the companion qc.rework_requested event)',
      );
    }
  } else if (p['rework_event_id'] !== undefined) {
    reject('INVALID_PAYLOAD', 'rework_event_id is only valid on a rework outcome', {
      outcome: p['outcome'],
    });
  }
  rejectDeclaredDerived(
    p,
    [
      'task_id',
      'lot_number',
      'sku',
      'site_id',
      'quantity',
      'outcome_by',
      'downgrade_lot_id',
      'downgrade_lot_number',
      'rework_requested_event_id',
      'quality_hold_status',
    ],
    QC_NCR_OUTCOME_RECORDED,
  );
}

/**
 * Story 8.3 (FR-Q-06, AC 5): the rework integration contract. EVERY field is derived, so this
 * assert only checks the shape is complete and well-formed; the applier re-derives all ten values
 * from the NCR and the task and rejects any disagreement (QC_DERIVATION_MISMATCH), and refuses the
 * event entirely unless the owning NCR already names this event id (QC_REWORK_NOT_DERIVED).
 */
function assertReworkRequestedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['ncr_id'])) reject('INVALID_PAYLOAD', 'ncr_id must be a UUID');
  if (envelope.stream_id !== p['ncr_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the ncr_id for qc.rework_requested', {
      stream_id: envelope.stream_id,
      payload_ncr_id: p['ncr_id'],
    });
  }
  for (const field of ['lot_id', 'task_id', 'site_id', 'plan_version_id', 'requested_by']) {
    if (!isUuid(p[field])) reject('INVALID_PAYLOAD', `${field} must be a UUID`);
  }
  if (!isBoundedText(p['lot_number'], 128)) {
    reject('INVALID_PAYLOAD', 'lot_number must be a non-empty string of at most 128 characters');
  }
  if (!isBoundedText(p['sku'], 128)) {
    reject('INVALID_PAYLOAD', 'sku must be a non-empty string of at most 128 characters');
  }
  if (!isPositiveQuantity(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity must be a positive decimal string');
  }
  if (!isIsoTimestamp(p['requested_at'])) {
    reject('INVALID_PAYLOAD', 'requested_at must be an ISO 8601 timestamp with an explicit offset');
  }
}

/**
 * Story 8.4 (FR-Q-07, AC 1, AC 6 and AC 7): the batch release command. Only task_id, lot_id,
 * release_id and decided_at are the client's; everything else is derived under lock by the applier
 * (Binding Scope Decisions 1, 2, 4 and 7), so declaring any of it is 409 QC_DERIVATION_MISMATCH.
 */
function assertBatchReleaseRecordedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  for (const field of ['task_id', 'lot_id', 'release_id']) {
    if (!isUuid(p[field])) reject('INVALID_PAYLOAD', `${field} must be a UUID`);
  }
  assertTaskStream(envelope, p);
  if (!isIsoTimestamp(p['decided_at'])) {
    reject('INVALID_PAYLOAD', 'decided_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(
    p,
    [
      'disposition_id',
      'retention_sample_id',
      'document_kind',
      'document_ref',
      'retention_years',
      'retention_expires_on',
      'bis_licence_number',
      'released_by',
      'lot_number',
      'sku',
      'site_id',
      'quantity',
      'disposition',
    ],
    QC_BATCH_RELEASE_RECORDED,
  );
}

/**
 * Story 8.4 (FR-Q-08, AC 4): the retention-sample log. Deliberately NOT gated on disposition state
 * here or in the applier - AC 4's ordering only makes sense if a sample can be logged any time
 * after the task exists, independent of whether release has been attempted yet (Task 3). Only
 * qc.batch_release_recorded gates on both disposition state and retention-sample presence.
 */
function assertRetentionSampleLoggedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  for (const field of ['task_id', 'lot_id', 'retention_sample_id', 'location_id']) {
    if (!isUuid(p[field])) reject('INVALID_PAYLOAD', `${field} must be a UUID`);
  }
  assertTaskStream(envelope, p);
  if (!isPositiveQuantity(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity must be a positive decimal string');
  }
  // Bound the TRIMMED value: chk_qc_retention_sample_uom checks char_length on the trimmed string
  // the applier actually inserts, so a pre-trim bound would refuse a padded but legal value.
  if (typeof p['uom'] !== 'string' || !isBoundedText(p['uom'].trim(), MAX_UOM_LENGTH)) {
    reject(
      'INVALID_PAYLOAD',
      `uom must be a non-empty string of at most ${MAX_UOM_LENGTH} characters`,
    );
  }
  if (!isIsoTimestamp(p['logged_at'])) {
    reject('INVALID_PAYLOAD', 'logged_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(
    p,
    ['expires_on', 'retention_years', 'logged_by', 'lot_number', 'sku', 'site_id', 'status'],
    QC_RETENTION_SAMPLE_LOGGED,
  );
}

/**
 * Story 8.4 (FR-Q-08, AC 5): the recorded disposal. System-actor only - it has no write route and
 * is emitted solely by the retention-expiry sweep - so the applier additionally refuses any event
 * whose sample is not still 'retained'.
 */
function assertRetentionSampleDisposedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  for (const field of ['retention_sample_id', 'lot_id']) {
    if (!isUuid(p[field])) reject('INVALID_PAYLOAD', `${field} must be a UUID`);
  }
  if (envelope.stream_id !== p['retention_sample_id']) {
    reject(
      'INVALID_PAYLOAD',
      'stream_id must be the retention_sample_id for qc.retention_sample_disposed',
      { stream_id: envelope.stream_id, payload_retention_sample_id: p['retention_sample_id'] },
    );
  }
  if (!isIsoTimestamp(p['disposed_at'])) {
    reject('INVALID_PAYLOAD', 'disposed_at must be an ISO 8601 timestamp with an explicit offset');
  }
  rejectDeclaredDerived(p, ['task_id', 'expires_on', 'status'], QC_RETENTION_SAMPLE_DISPOSED);
}

export function assertQualityShape(envelope: EventEnvelope): void {
  assertQualityForeignStreamRejected(envelope);
  switch (qualityEventType(envelope)) {
    case INSPECTION_PLAN_CREATED:
      assertInspectionPlanCreatedShape(envelope);
      return;
    case INSPECTION_PLAN_APPROVED:
      assertInspectionPlanApprovedShape(envelope);
      return;
    case QC_COMPLETION_RECEIVED:
      assertCompletionReceivedShape(envelope);
      return;
    case QC_CONDITIONAL_RELEASE_RECORDED:
      assertConditionalReleaseRecordedShape(envelope);
      return;
    case QC_SAMPLING_DETERMINED:
      assertSamplingDeterminedShape(envelope);
      return;
    case QC_RESULT_RECORDED:
      assertResultRecordedShape(envelope);
      return;
    case QC_OBSERVATION_RECORDED:
      assertObservationRecordedShape(envelope);
      return;
    case QC_INSPECTION_COMPLETED:
      assertInspectionCompletedShape(envelope);
      return;
    case QC_SAMPLING_STATE_ADJUSTED:
      assertSamplingStateAdjustedShape(envelope);
      return;
    case QC_LOT_DISPOSITIONED:
      assertLotDispositionedShape(envelope);
      return;
    case QC_LOT_SPLIT_RECORDED:
      assertLotSplitRecordedShape(envelope);
      return;
    case QC_NCR_OUTCOME_RECORDED:
      assertNcrOutcomeRecordedShape(envelope);
      return;
    case QC_REWORK_REQUESTED:
      assertReworkRequestedShape(envelope);
      return;
    case QC_BATCH_RELEASE_RECORDED:
      assertBatchReleaseRecordedShape(envelope);
      return;
    case QC_RETENTION_SAMPLE_LOGGED:
      assertRetentionSampleLoggedShape(envelope);
      return;
    case QC_RETENTION_SAMPLE_DISPOSED:
      assertRetentionSampleDisposedShape(envelope);
      return;
    case QC_HOLD_PLACED:
      assertHoldPlacedShape(envelope);
      return;
    case QC_HOLD_RELEASED:
      assertHoldReleasedShape(envelope);
      return;
    case QC_NCR_RAISED:
      assertNcrRaisedShape(envelope);
      return;
    case QC_CAPA_OPENED:
      assertCapaOpenedShape(envelope);
      return;
    case QC_CAPA_CLOSED:
      assertCapaClosedShape(envelope);
      return;
    case QC_CAPA_LINKED:
      assertCapaLinkedShape(envelope);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Transaction-aware, fail-closed DOA authority resolution (Binding Scope Decision 10)
// ---------------------------------------------------------------------------

export interface QcAuthority {
  approver_user_id: string;
  doa_entry_id: string;
  governing_role: string;
  delegation_applied: boolean;
}

/**
 * Resolves the DOA authority for a QC transaction type at value 0: the governing entry (404
 * APPROVAL_UNRESOLVED when none), optionally constrained to a QC Head-level governing role
 * (config.quality.qcHeadRoles - a registry entry naming any other role fails closed with the same
 * code and reason governing_role_not_qc_head), the active holder of that role and the active
 * delegate covering today's IST date (a deprovisioned delegate is not resolvable). When the
 * governing role has no active holder, other active entries for the type are walked (the
 * resolveApprover escalation) but, under requireQcHead, only through QC Head-level roles. No holder
 * anywhere is 409 APPROVAL_UNRESOLVED. Runs on `client` when given so the in-transaction
 * re-derivation sees the transaction's snapshot (Task 4 "run again inside the transaction").
 */
export async function resolveQcAuthority(
  transactionType: string,
  options: { requireQcHead: boolean },
  client?: PoolClient,
): Promise<QcAuthority> {
  const qcHeadRoles: readonly string[] = config.quality.qcHeadRoles;
  const entry = await findMatchingDoaEntry(transactionType, 0, client);
  if (!entry) {
    reject(
      'APPROVAL_UNRESOLVED',
      `No DOA entry governs ${transactionType}`,
      { transaction_type: transactionType },
      404,
    );
  }
  if (options.requireQcHead && !qcHeadRoles.includes(entry.role)) {
    reject(
      'APPROVAL_UNRESOLVED',
      `The DOA entry governing ${transactionType} does not name a QC Head-level role`,
      {
        transaction_type: transactionType,
        governing_role: entry.role,
        reason: 'governing_role_not_qc_head',
      },
      404,
    );
  }
  const today = toIstCalendarDate(new Date());
  const tryHolder = async (
    role: string,
  ): Promise<{ user_id: string; delegation_applied: boolean } | null> => {
    const holder = await findRoleHolder(role, client);
    if (!holder) return null;
    const delegation = await findActiveDelegation(holder.user_id, today, client);
    return delegation
      ? { user_id: delegation.delegate_user_id, delegation_applied: true }
      : { user_id: holder.user_id, delegation_applied: false };
  };
  let resolved = await tryHolder(entry.role);
  let usedEntry = entry;
  if (!resolved) {
    const entries = await listActiveDoaEntries(transactionType, client);
    for (const candidate of entries) {
      if (candidate.role === entry.role) continue;
      if (options.requireQcHead && !qcHeadRoles.includes(candidate.role)) continue;
      resolved = await tryHolder(candidate.role);
      if (resolved) {
        usedEntry = candidate;
        break;
      }
    }
  }
  if (!resolved) {
    reject(
      'APPROVAL_UNRESOLVED',
      'Approval is required but no active approver could be resolved',
      { transaction_type: transactionType, governing_role: entry.role, reason: 'no_active_holder' },
      409,
    );
  }
  return {
    approver_user_id: resolved.user_id,
    doa_entry_id: usedEntry.entry_id,
    governing_role: usedEntry.role,
    delegation_applied: resolved.delegation_applied,
  };
}

// ---------------------------------------------------------------------------
// Shared in-transaction derivations
// ---------------------------------------------------------------------------

async function alreadyPersisted(envelope: EventEnvelope, client: PoolClient): Promise<boolean> {
  if (!envelope.idempotency_key?.trim() && !envelope.event_id) return false;
  const existing = await client.query(
    `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
    [envelope.idempotency_key ?? null, envelope.event_id ?? null],
  );
  return existing.rows.length > 0;
}

/**
 * Task 4: the product item must be active and the specification revision must be a RELEASED
 * revision of a production or job_work_kit BOM owned by that item. Reads the item and BOM
 * projections only; never mutates them (Annex requirement 2).
 */
async function deriveItemAndSpecification(
  itemId: string,
  bomRevisionId: string,
  client: PoolClient,
): Promise<{ sku: string; business_stream: string; uom: string }> {
  const item = await getItemById(itemId, client);
  if (!item)
    reject('ITEM_NOT_FOUND', 'The product item does not resolve', { item_id: itemId }, 404);
  if (item.status !== 'active') {
    reject('ITEM_NOT_ACTIVE', 'The product item is not active', { item_id: itemId }, 409);
  }
  const revision = await getBomRevisionById(bomRevisionId, client);
  if (!revision) {
    reject(
      'BOM_REVISION_NOT_FOUND',
      'The specification revision does not resolve',
      { bom_revision_id: bomRevisionId },
      404,
    );
  }
  if (revision.revision_status !== 'released') {
    reject(
      'BOM_NOT_RELEASED',
      'The specification revision is not released',
      { bom_revision_id: bomRevisionId, revision_status: revision.revision_status },
      409,
    );
  }
  const bom = await getBomById(revision.bom_id, client);
  if (!bom) {
    reject(
      'BOM_NOT_FOUND',
      'The BOM of the specification revision does not resolve',
      {
        bom_id: revision.bom_id,
      },
      404,
    );
  }
  assertNotRdDraft(bom);
  if (bom.bom_type !== 'production' && bom.bom_type !== 'job_work_kit') {
    reject(
      'INSPECTION_PLAN_SCOPE_MISMATCH',
      'The specification revision must belong to a production or job-work-kit BOM',
      { bom_id: bom.bom_id, bom_type: bom.bom_type },
      409,
    );
  }
  if (bom.parent_item_id !== itemId) {
    reject(
      'INSPECTION_PLAN_SCOPE_MISMATCH',
      'The specification revision does not belong to the product item',
      { item_id: itemId, bom_revision_id: bomRevisionId, bom_parent_item_id: bom.parent_item_id },
      409,
    );
  }
  return { sku: item.sku, business_stream: item.business_stream, uom: item.uom };
}

async function advisoryLock(key: string, client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

function grainKey(p: {
  item_id: string;
  bom_revision_id: string;
  scope: string;
  source_order_type: string | null;
  source_order_ref: string | null;
}): string {
  return `inspection_plan|${p.item_id}|${p.bom_revision_id}|${p.scope}|${p.source_order_type ?? ''}|${p.source_order_ref ?? ''}`;
}

// ---------------------------------------------------------------------------
// Appliers
// ---------------------------------------------------------------------------

async function applyInspectionPlanCreated(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const planId = p['plan_id'] as string;
  const planVersionId = p['plan_version_id'] as string;
  const scope = p['scope'] as InspectionPlanScope;
  const itemId = p['item_id'] as string;
  const bomRevisionId = p['bom_revision_id'] as string;
  const sourceOrderType = (p['source_order_type'] as 'job_work_order' | null) ?? null;
  const sourceOrderRef = (p['source_order_ref'] as string | null) ?? null;
  const effectiveFrom = p['effective_from'] as string;
  const grain = {
    item_id: itemId,
    bom_revision_id: bomRevisionId,
    scope,
    source_order_type: sourceOrderType,
    source_order_ref: sourceOrderRef,
  };

  // Locking contract: the grain key, then the plan id (both advisory - the plan tables carry no
  // UPDATE grant for app_user, so FOR UPDATE is unavailable and MAX(version)+1 is only safe here).
  await advisoryLock(grainKey(grain), client);
  await advisoryLock(`inspection_plan|${planId}`, client);

  const derived = await deriveItemAndSpecification(itemId, bomRevisionId, client);

  let header: InspectionPlanRow | null = await getInspectionPlanById(planId, client);
  if (header) {
    const sameGrain =
      header.item_id === itemId &&
      header.bom_revision_id === bomRevisionId &&
      header.scope === scope &&
      header.source_order_type === sourceOrderType &&
      header.source_order_ref === sourceOrderRef;
    if (!sameGrain) {
      reject(
        'INSPECTION_PLAN_SCOPE_MISMATCH',
        'plan_id belongs to a plan with a different scope grain',
        {
          plan_id: planId,
          existing_scope: {
            item_id: header.item_id,
            bom_revision_id: header.bom_revision_id,
            scope: header.scope,
            source_order_type: header.source_order_type,
            source_order_ref: header.source_order_ref,
          },
        },
        409,
      );
    }
  } else {
    const byGrain = await getInspectionPlanByGrain(grain, client);
    if (byGrain) {
      reject(
        'INSPECTION_PLAN_SCOPE_MISMATCH',
        'A plan already exists for this scope grain under a different plan_id',
        { plan_id: planId, existing_plan_id: byGrain.plan_id },
        409,
      );
    }
    await insertInspectionPlan(
      {
        plan_id: planId,
        scope,
        item_id: itemId,
        sku: derived.sku,
        bom_revision_id: bomRevisionId,
        source_order_type: sourceOrderType,
        source_order_ref: sourceOrderRef,
        created_by: envelope.metadata.actor.user_id,
        source_event_id: eventId,
      },
      client,
    );
    header = await getInspectionPlanById(planId, client);
  }

  const existingVersion = await getInspectionPlanVersionById(planVersionId, client);
  if (existingVersion) {
    reject(
      'DUPLICATE_INSPECTION_PLAN_VERSION',
      'This plan version has already been created',
      { plan_version_id: planVersionId, plan_id: existingVersion.plan_id },
      409,
    );
  }
  const sameDate = await getInspectionPlanVersionByEffectiveFrom(planId, effectiveFrom, client);
  if (sameDate) {
    reject(
      'INSPECTION_PLAN_EFFECTIVITY_CONFLICT',
      'A version of this plan already carries this effective_from date',
      {
        plan_id: planId,
        effective_from: effectiveFrom,
        existing_plan_version_id: sameDate.plan_version_id,
      },
      409,
    );
  }
  const versionNo = (await getMaxInspectionPlanVersionNo(planId, client)) + 1;
  await insertInspectionPlanVersion(
    {
      plan_version_id: planVersionId,
      plan_id: planId,
      version_no: versionNo,
      effective_from: effectiveFrom,
      aql: (p['aql'] as string | null) ?? null,
      inspection_level: (p['inspection_level'] as string | null) ?? null,
      created_by: envelope.metadata.actor.user_id,
      source_event_id: eventId,
    },
    client,
  );
  // Preserve line ordering exactly as declared (Task 4): rows are inserted in payload order and
  // read back ORDER BY line_no; the (plan_version_id, line_no) unique constraint is the backstop.
  const characteristics = p['characteristics'] as Array<Record<string, unknown>>;
  for (const c of characteristics) {
    await insertInspectionPlanCharacteristic(
      {
        characteristic_id: c['characteristic_id'] as string,
        plan_version_id: planVersionId,
        line_no: c['line_no'] as number,
        characteristic_name: (c['characteristic_name'] as string).trim(),
        characteristic_class: c['characteristic_class'] as 'critical' | 'major' | 'minor',
        test_method_ref: (c['test_method_ref'] as string).trim(),
        instrument_type: (c['instrument_type'] as string | null) ?? null,
        result_kind: c['result_kind'] as 'numeric' | 'attribute',
        lower_limit: (c['lower_limit'] as string | null) ?? null,
        upper_limit: (c['upper_limit'] as string | null) ?? null,
        limit_uom: (c['limit_uom'] as string | null) ?? null,
        acceptance_criteria: (c['acceptance_criteria'] as string | null) ?? null,
        sample_handling: (c['sample_handling'] as string).trim(),
      },
      client,
    );
  }

  // Write the derived fields back onto the persisted payload.
  p['version_no'] = versionNo;
  p['sku'] = derived.sku;
}

async function applyInspectionPlanApproved(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const planId = p['plan_id'] as string;
  const planVersionId = p['plan_version_id'] as string;

  await advisoryLock(`inspection_plan|${planId}`, client);

  const version = await getInspectionPlanVersionById(planVersionId, client);
  if (!version) {
    reject(
      'INSPECTION_PLAN_NOT_FOUND',
      'The plan version does not resolve',
      { plan_id: planId, plan_version_id: planVersionId },
      404,
    );
  }
  if (version.plan_id !== planId) {
    reject(
      'INSPECTION_PLAN_SCOPE_MISMATCH',
      'The plan version does not belong to the declared plan',
      { plan_id: planId, plan_version_id: planVersionId, version_plan_id: version.plan_id },
      409,
    );
  }
  if (version.approved) {
    reject(
      'INSPECTION_PLAN_ALREADY_APPROVED',
      'This plan version is already approved',
      { plan_version_id: planVersionId, approved_at: version.approved_at },
      409,
    );
  }

  // AD-3 / Binding Scope Decision 10: authority re-derived INSIDE the transaction; the acting user
  // must BE the resolved QC Head-level approver. Module write access alone grants nothing.
  const authority = await resolveQcAuthority(
    INSPECTION_PLAN_APPROVAL_DOA_TYPE,
    { requireQcHead: true },
    client,
  );
  const actorId = envelope.metadata.actor.user_id;
  if (actorId !== authority.approver_user_id) {
    reject(
      'APPROVAL_REQUIRED',
      'Approving an inspection plan requires the resolved QC Head-level DOA approver',
      {
        plan_version_id: planVersionId,
        resolved_approver_user_id: authority.approver_user_id,
        governing_role: authority.governing_role,
      },
      403,
    );
  }

  await insertInspectionPlanApproval(
    {
      plan_version_id: planVersionId,
      plan_id: planId,
      approved_by: actorId,
      resolved_approver_user_id: authority.approver_user_id,
      doa_entry_id: authority.doa_entry_id,
      governing_role: authority.governing_role,
      approved_at: p['approved_at'] as string,
      source_event_id: eventId,
    },
    client,
  );

  p['approved_by'] = actorId;
  p['resolved_approver_user_id'] = authority.approver_user_id;
  p['doa_entry_id'] = authority.doa_entry_id;
  p['governing_role'] = authority.governing_role;
}

export interface ResolvedInspectionPlan {
  plan: InspectionPlanRow;
  version: InspectionPlanVersionRow;
  scope: InspectionPlanScope;
}

/**
 * Task 4 deterministic resolution: the applicable approved job_work_order override first, then the
 * approved standard plan, both at the trusted lot business date. Fails closed: no standard header
 * is 404 INSPECTION_PLAN_NOT_FOUND; a header whose versions are all draft or future-effective is
 * 409 INSPECTION_PLAN_NOT_APPROVED; corrupted date ambiguity is 409 INSPECTION_PLAN_AMBIGUOUS.
 */
export async function resolveInspectionPlanForLot(
  input: {
    item_id: string;
    bom_revision_id: string;
    source_order_type: 'job_work_order' | null;
    source_order_ref: string | null;
    business_date: string;
  },
  client?: PoolClient,
): Promise<ResolvedInspectionPlan> {
  if (input.source_order_type === 'job_work_order' && input.source_order_ref !== null) {
    const override = await getInspectionPlanByGrain(
      {
        item_id: input.item_id,
        bom_revision_id: input.bom_revision_id,
        scope: 'customer_override',
        source_order_type: 'job_work_order',
        source_order_ref: input.source_order_ref,
      },
      client,
    );
    if (override) {
      const resolved = await resolveApprovedInspectionPlanVersion(
        override.plan_id,
        input.business_date,
        client,
      );
      if (resolved.ambiguous) {
        reject(
          'INSPECTION_PLAN_AMBIGUOUS',
          'More than one approved override version is effective on the lot business date',
          { plan_id: override.plan_id, business_date: input.business_date },
          409,
        );
      }
      if (resolved.version) {
        return { plan: override, version: resolved.version, scope: 'customer_override' };
      }
      // No approved version is effective on the lot business date. A draft (never-approved)
      // override must fail closed (Annex requirement 8); an approved but future-effective
      // override legitimately yields to the standard plan (Annex requirement 3).
      const versions = await listInspectionPlanVersions(override.plan_id, client);
      if (!versions.some((v) => v.approved)) {
        reject(
          'INSPECTION_PLAN_NOT_APPROVED',
          'The customer override plan has no approved version',
          { plan_id: override.plan_id, business_date: input.business_date },
          409,
        );
      }
    }
  }
  const standard = await getInspectionPlanByGrain(
    {
      item_id: input.item_id,
      bom_revision_id: input.bom_revision_id,
      scope: 'standard',
      source_order_type: null,
      source_order_ref: null,
    },
    client,
  );
  if (!standard) {
    reject(
      'INSPECTION_PLAN_NOT_FOUND',
      'No inspection plan exists for the product item and specification revision',
      { item_id: input.item_id, bom_revision_id: input.bom_revision_id },
      404,
    );
  }
  const resolved = await resolveApprovedInspectionPlanVersion(
    standard.plan_id,
    input.business_date,
    client,
  );
  if (resolved.ambiguous) {
    reject(
      'INSPECTION_PLAN_AMBIGUOUS',
      'More than one approved plan version is effective on the lot business date',
      { plan_id: standard.plan_id, business_date: input.business_date },
      409,
    );
  }
  if (!resolved.version) {
    const versions = await listInspectionPlanVersions(standard.plan_id, client);
    reject(
      versions.length === 0 ? 'INSPECTION_PLAN_NOT_FOUND' : 'INSPECTION_PLAN_NOT_APPROVED',
      versions.length === 0
        ? 'The inspection plan has no versions'
        : 'No approved inspection-plan version is effective on the lot business date',
      { plan_id: standard.plan_id, business_date: input.business_date },
      versions.length === 0 ? 404 : 409,
    );
  }
  return { plan: standard, version: resolved.version, scope: 'standard' };
}

async function applyCompletionReceived(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const lotId = p['lot_id'] as string;
  const lotNumber = p['lot_number'] as string;
  const itemId = p['item_id'] as string;
  const quantity = p['quantity'] as string;
  const siteId = p['site_id'] as string;
  const bomRevisionId = p['bom_revision_id'] as string;
  const sourceType = p['source_completion_type'] as string;
  const sourceId = p['source_completion_id'] as string;
  const sourceOrderType = (p['source_order_type'] as 'job_work_order' | null) ?? null;
  const sourceOrderRef = (p['source_order_ref'] as string | null) ?? null;
  const completedAt = p['completed_at'] as string;

  // Trusted IST business date from the offset-bearing completion instant (Task 5).
  const businessDate = toIstCalendarDate(new Date(completedAt));

  // Locking contract step 1: the lot row FOR UPDATE. The producer created it in this transaction
  // (or before); a missing lot is a malformed attempt to enter the gate without a lot.
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [lotId],
  );
  if (lotResult.rows.length === 0) {
    reject(
      'QC_HOLD_REQUIRED',
      'The finished-goods lot does not exist; the producer must create it before the QC hand-off',
      { lot_id: lotId, reason: 'lot_missing' },
      409,
    );
  }
  const lotRow = lotResult.rows[0]!;

  const derived = await deriveItemAndSpecification(itemId, bomRevisionId, client);
  if (lotRow['lot_number'] !== lotNumber || lotRow['sku'] !== derived.sku) {
    reject(
      'QC_HOLD_REQUIRED',
      'The lot does not match the declared lot number and product item',
      {
        lot_id: lotId,
        declared_lot_number: lotNumber,
        lot_number: lotRow['lot_number'],
        declared_sku: derived.sku,
        lot_sku: lotRow['sku'],
        reason: 'lot_mismatch',
      },
      409,
    );
  }
  if (p['business_stream'] !== derived.business_stream) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'Declared business_stream does not match the product item',
      {
        declared_business_stream: p['business_stream'],
        item_business_stream: derived.business_stream,
      },
      409,
    );
  }
  if (p['uom'] !== derived.uom) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'Declared uom does not match the product item',
      {
        declared_uom: p['uom'],
        item_uom: derived.uom,
      },
      409,
    );
  }

  // Locking contract step 2: the gate grain. Unique lot task and unique source completion.
  const existingByLot = await getQcInspectionTaskByLotId(lotId, client, true);
  if (existingByLot) {
    reject(
      'DUPLICATE_QC_COMPLETION',
      'A QC inspection task already exists for this lot',
      { lot_id: lotId, existing_task_id: existingByLot.task_id },
      409,
    );
  }
  const existingBySource = await getQcInspectionTaskBySource(sourceType, sourceId, client);
  if (existingBySource) {
    reject(
      'DUPLICATE_QC_COMPLETION',
      'A QC inspection task already exists for this source completion',
      {
        source_completion_type: sourceType,
        source_completion_id: sourceId,
        existing_task_id: existingBySource.task_id,
      },
      409,
    );
  }

  // Locking contract step 3: the producer-owned finished stock (read only - never inserted or
  // updated here). The stock effect must exist at or beneath the site, at exactly the completed
  // quantity, and be held from sellable use: nothing allocated or picked yet.
  const stock = await client.query(
    `WITH RECURSIVE descendants AS (
       SELECT location_id, 0 AS depth FROM location_register WHERE location_id = $1
       UNION ALL
       SELECT lr.location_id, d.depth + 1
         FROM location_register lr
         JOIN descendants d ON lr.parent_location_id = d.location_id
        WHERE d.depth < 10
     )
     SELECT COUNT(*)::int AS row_count,
            COALESCE(SUM(sb.on_hand), 0)::text AS on_hand,
            COALESCE(SUM(sb.allocated), 0)::text AS allocated,
            COALESCE(SUM(sb.picked), 0)::text AS picked,
            COALESCE(SUM(sb.on_hand), 0) = $4::numeric AS exact_quantity,
            (COALESCE(SUM(sb.allocated), 0) = 0 AND COALESCE(SUM(sb.picked), 0) = 0) AS unconsumed
       FROM stock_balance sb
      WHERE sb.sku = $2 AND sb.lot_id = $3 AND sb.stock_class = 'owned'
        AND sb.location_id IN (SELECT location_id FROM descendants)`,
    [siteId, derived.sku, lotNumber, quantity],
  );
  const stockRow = stock.rows[0]!;
  if ((stockRow['row_count'] as number) === 0 || stockRow['exact_quantity'] !== true) {
    reject(
      'QC_HOLD_REQUIRED',
      'The finished-goods stock effect for this lot is missing or does not match the completed quantity',
      {
        lot_id: lotId,
        lot_number: lotNumber,
        site_id: siteId,
        declared_quantity: quantity,
        on_hand: stockRow['on_hand'],
        reason: 'finished_stock_missing',
      },
      409,
    );
  }
  if (stockRow['unconsumed'] !== true) {
    reject(
      'QC_HOLD_REQUIRED',
      'The finished-goods lot is already in sellable use and cannot enter QC Hold',
      {
        lot_id: lotId,
        lot_number: lotNumber,
        allocated: stockRow['allocated'],
        picked: stockRow['picked'],
        reason: 'stock_sellable',
      },
      409,
    );
  }

  // Resolve and freeze the plan BEFORE writing any projection (Task 5).
  const resolvedPlan = await resolveInspectionPlanForLot(
    {
      item_id: itemId,
      bom_revision_id: bomRevisionId,
      source_order_type: sourceOrderType,
      source_order_ref: sourceOrderRef,
      business_date: businessDate,
    },
    client,
  );

  const gateChangedAt = envelope.metadata.occurred_at;
  await insertQcInspectionTask(
    {
      task_id: taskId,
      lot_id: lotId,
      lot_number: lotNumber,
      source_completion_type: sourceType as QcInspectionTaskRow['source_completion_type'],
      source_completion_id: sourceId,
      item_id: itemId,
      sku: derived.sku,
      quantity,
      uom: p['uom'] as string,
      site_id: siteId,
      bom_revision_id: bomRevisionId,
      plan_id: resolvedPlan.plan.plan_id,
      plan_version_id: resolvedPlan.version.plan_version_id,
      plan_scope: resolvedPlan.scope,
      source_order_type: resolvedPlan.scope === 'customer_override' ? sourceOrderType : null,
      source_order_ref: resolvedPlan.scope === 'customer_override' ? sourceOrderRef : null,
      completed_at: completedAt,
      business_date: businessDate,
      gate_changed_at: gateChangedAt,
      source_event_id: eventId,
    },
    client,
  );

  p['business_date'] = businessDate;
  p['sku'] = derived.sku;
  p['plan_id'] = resolvedPlan.plan.plan_id;
  p['plan_version_id'] = resolvedPlan.version.plan_version_id;
  p['plan_scope'] = resolvedPlan.scope;
  p['gate_status'] = 'qc_hold';

  // Binding Scope Decision 12: the durable task above IS the inbox; this notification is emitted
  // transactionally to the configured inspector role at the completion site and may fan out to
  // zero recipients without affecting the task.
  await emitNotificationInTransaction(
    {
      target: { role: config.quality.inspectionTaskNotificationRole, location_id: siteId },
      event_type: 'qc_inspection_task_created',
      status_verb: 'QC Hold',
      object_type: 'qc_inspection_task',
      object_id: taskId,
      actor_label: `Lot ${lotNumber} (${derived.sku})`,
      next_step: 'Inspect the lot against the frozen plan version',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/**
 * Known result recorders for a task (Story 8.2 Binding Scope Decision 12): the recorded_by of
 * every qc_inspection_result row of the task, earliest first (first recorded_at, then result_id),
 * so `recorders[0]` is the deterministic inspector attribution stored as `inspector_user_id`.
 * The Story 8.1 domain_events scan of synthetic results is retired; the projection is the SOD
 * substrate Story 8.3 enforces against too.
 */
async function knownResultRecorders(taskId: string, client: PoolClient): Promise<string[]> {
  return (await listResultRecorderUserIds(taskId, client)).filter((id) => UUID_REGEX.test(id));
}

async function applyConditionalReleaseRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const lotId = p['lot_id'] as string;
  const decidedAt = p['decided_at'] as string;
  const decidedOn = toIstCalendarDate(new Date(decidedAt));
  const actorId = envelope.metadata.actor.user_id;

  // Locking contract: lot row, then the QC-gate row. Same prefix as every gate assertion (Task 6).
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, quality_hold_status FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [lotId],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: lotId }, 404);
  }
  const lotNumber = lotResult.rows[0]!['lot_number'] as string;
  const task = await getQcInspectionTaskByLotId(lotId, client, true);
  if (!task) {
    reject(
      'QC_TASK_NOT_FOUND',
      'No QC inspection task exists for this lot',
      { lot_id: lotId },
      404,
    );
  }
  if (task.task_id !== taskId) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'The declared task_id is not the inspection task of this lot',
      { lot_id: lotId, declared_task_id: taskId, task_id: task.task_id },
      409,
    );
  }
  const existingDisposition = await getQcLotDispositionByLotId(lotId, client);
  if (existingDisposition) {
    reject(
      'DISPOSITION_EXISTS',
      'A disposition has already been recorded for this lot',
      { lot_id: lotId, existing_disposition_id: existingDisposition.disposition_id },
      409,
    );
  }
  if (task.gate_status !== 'qc_hold') {
    reject(
      'QC_GATE_NOT_HELD',
      'Conditional release requires the lot to be in QC Hold',
      { lot_id: lotId, gate_status: task.gate_status },
      409,
    );
  }

  // Authority re-derived under the locks (AD-3, Binding Scope Decision 10).
  const authority = await resolveQcAuthority(
    CONDITIONAL_RELEASE_DOA_TYPE,
    { requireQcHead: false },
    client,
  );
  if (actorId !== authority.approver_user_id) {
    reject(
      'APPROVAL_REQUIRED',
      'Conditional release requires the resolved DOA approver',
      { lot_id: lotId, task_id: taskId, resolved_approver_user_id: authority.approver_user_id },
      403,
    );
  }

  // Segregation of duties (Binding Scope Decision 11): a known result recorder cannot approve the
  // release of the same lot.
  const recorders = await knownResultRecorders(task.task_id, client);
  if (recorders.includes(actorId)) {
    reject(
      'SOD_VIOLATION',
      'A result recorder for this lot cannot approve its conditional release',
      { lot_id: lotId, task_id: taskId, approver_user_id: actorId },
      409,
    );
  }
  const inspectorUserId = recorders[0] ?? null;

  const deviationId = p['deviation_id'] as string;
  const dispositionId = p['disposition_id'] as string;
  await insertQcDeviation(
    {
      deviation_id: deviationId,
      task_id: taskId,
      lot_id: lotId,
      deviation_type: 'conditional_release',
      justification: (p['justification'] as string).trim(),
      conditions: (p['conditions'] as string).trim(),
      scope_kind: p['scope_kind'] as 'internal_movement' | 'order_allocation' | 'dispatch',
      scope_ref: (p['scope_ref'] as string).trim(),
      decided_on: decidedOn,
      expires_on: p['expires_on'] as string,
      requested_by: actorId,
      approved_by: authority.approver_user_id,
      doa_entry_id: authority.doa_entry_id,
      decided_at: decidedAt,
      source_event_id: eventId,
    },
    client,
  );
  await insertQcLotDisposition(
    {
      disposition_id: dispositionId,
      lot_id: lotId,
      task_id: taskId,
      disposition: 'conditional_release',
      deviation_id: deviationId,
      plan_version_id: task.plan_version_id,
      quantity: task.quantity,
      requested_by: actorId,
      inspector_user_id: inspectorUserId,
      approved_by: authority.approver_user_id,
      doa_entry_id: authority.doa_entry_id,
      decided_at: decidedAt,
      source_event_id: eventId,
      // Story 8.3 additive columns: a conditional release is decided before inspection completes,
      // so the sampling outcome is whatever the task carries (usually null) and no NCR exists.
      sampling_outcome: task.sampling_outcome,
      ncr_id: null,
    },
    client,
  );
  const moved = await transitionQcGate(
    taskId,
    'qc_hold',
    'conditionally_released',
    decidedAt,
    client,
  );
  if (moved !== 1) {
    // Never silently no-op on a state the applier should reject (the 7.2 Group 2 decision).
    reject(
      'QC_GATE_NOT_HELD',
      'The lot left QC Hold before the conditional release could be applied',
      { lot_id: lotId, task_id: taskId },
      409,
    );
  }

  p['requested_by'] = actorId;
  p['approved_by'] = authority.approver_user_id;
  p['doa_entry_id'] = authority.doa_entry_id;
  p['inspector_user_id'] = inspectorUserId;
  p['decided_on'] = decidedOn;
  p['previous_gate_status'] = 'qc_hold';
  p['gate_status'] = 'conditionally_released';

  await emitNotificationInTransaction(
    {
      target: {
        role: config.quality.inspectionTaskNotificationRole,
        location_id: task.site_id,
      },
      event_type: 'qc_conditional_release_recorded',
      status_verb: 'Conditionally released',
      object_type: 'qc_inspection_task',
      object_id: taskId,
      actor_label: `Lot ${lotNumber} (${task.sku})`,
      next_step: `Internal movement only within scope ${(p['scope_ref'] as string).trim()} until ${p['expires_on'] as string}`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

// ---------------------------------------------------------------------------
// Story 8.3 appliers (disposition, partial split, NCR outcomes, rework contract)
// ---------------------------------------------------------------------------

interface DispositionableLot {
  lot_id: string;
  lot_number: string;
  sku: string;
  expiry_date: string | null;
  task: QcInspectionTaskRow;
  inspector_user_id: string | null;
  /** Every user who recorded a result on this task, for the NFR-SEC-05 segregation check. */
  result_recorders: string[];
}

/**
 * The shared fail-closed preamble for every Story 8.3 disposition (accept, reject and split).
 * Locking contract is the platform's fixed order and must not change: the lot row FOR UPDATE, then
 * the QC-gate row FOR UPDATE, then (for a split) the stock rows.
 *
 * Rejection order is deliberate. DISPOSITION_EXISTS is evaluated BEFORE the gate check so a second
 * attempt on an already-decided lot always reports the disposition, never a gate-state code.
 */
async function lockLotForDisposition(
  lotId: string,
  taskId: string,
  client: PoolClient,
): Promise<DispositionableLot> {
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku, expiry_date::text AS expiry_date, quality_hold_status
       FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [lotId],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: lotId }, 404);
  }
  const lot = lotResult.rows[0]!;
  const task = await getQcInspectionTaskByLotId(lotId, client, true);
  if (!task) {
    reject(
      'QC_TASK_NOT_FOUND',
      'No QC inspection task exists for this lot',
      { lot_id: lotId },
      404,
    );
  }
  if (task.task_id !== taskId) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'The declared task_id is not the inspection task of this lot',
      { lot_id: lotId, declared_task_id: taskId, task_id: task.task_id },
      409,
    );
  }
  const existing = await getQcLotDispositionByLotId(lotId, client);
  if (existing) {
    reject(
      'DISPOSITION_EXISTS',
      'A disposition has already been recorded for this lot',
      {
        lot_id: lotId,
        existing_disposition_id: existing.disposition_id,
        existing_disposition: existing.disposition,
      },
      409,
    );
  }
  if (task.gate_status !== 'qc_hold' && task.gate_status !== 'conditionally_released') {
    // Belt and braces: the disposition row above is the authoritative guard, so a terminal gate
    // with no disposition row would be a corrupted projection. Report it as the same code.
    reject(
      'DISPOSITION_EXISTS',
      'The QC gate has already reached a terminal state for this lot',
      { lot_id: lotId, gate_status: task.gate_status },
      409,
    );
  }
  if (task.task_status !== 'inspected') {
    reject(
      'QC_INSPECTION_REQUIRED',
      'A disposition requires a completed inspection for this lot',
      { lot_id: lotId, task_id: task.task_id, task_status: task.task_status },
      409,
    );
  }
  if (lot['quality_hold_status'] !== 'none') {
    reject(
      'LOT_ON_HOLD',
      'Lot is on quality hold and cannot be dispositioned',
      { lot_id: lotId, task_id: task.task_id, reason: 'manual_hold' },
      400,
    );
  }
  const recorders = await knownResultRecorders(task.task_id, client);
  return {
    lot_id: lotId,
    lot_number: lot['lot_number'] as string,
    sku: lot['sku'] as string,
    expiry_date: (lot['expiry_date'] as string | null) ?? null,
    task,
    inspector_user_id: recorders[0] ?? null,
    result_recorders: recorders,
  };
}

/** Story 8.3 (FR-Q-05, AC 1): accept or reject. A reject also raises the one open NCR. */
async function applyLotDispositioned(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const lotId = p['lot_id'] as string;
  const dispositionId = p['disposition_id'] as string;
  const disposition = p['disposition'] as 'accept' | 'reject';
  const decidedAt = p['decided_at'] as string;
  const actorId = envelope.metadata.actor.user_id;

  const held = await lockLotForDisposition(lotId, taskId, client);
  const { task } = held;

  // NFR-SEC-05, segregation of duties. ACCEPTANCE is the binding quality decision - it is what
  // lets stock leave the QC gate - so the person who recorded the results may not also sign it.
  // This mirrors applyConditionalReleaseRecorded, which has always enforced exactly this.
  //
  // Deliberately scoped to 'accept'. A reject is not a self-approval, and blocking a recorder from
  // rejecting their own lot would delay containment of bad material, which is actively harmful. A
  // split likewise decides nothing on its own: each child lot carries its own disposition and is
  // guarded here in turn.
  if (disposition === 'accept' && held.result_recorders.includes(actorId)) {
    reject(
      'SOD_VIOLATION',
      'A result recorder for this lot cannot approve its acceptance',
      { lot_id: lotId, task_id: taskId, approver_user_id: actorId },
      409,
    );
  }

  const ncrId = disposition === 'reject' ? (p['ncr_id'] as string) : null;

  await insertQcLotDisposition(
    {
      disposition_id: dispositionId,
      lot_id: lotId,
      task_id: taskId,
      disposition,
      deviation_id: null,
      plan_version_id: task.plan_version_id,
      quantity: task.quantity,
      requested_by: actorId,
      inspector_user_id: held.inspector_user_id,
      approved_by: actorId,
      // Binding Scope Decision 5: the normal path carries no DOA gate, so nothing fabricates one.
      doa_entry_id: null,
      decided_at: decidedAt,
      source_event_id: eventId,
      sampling_outcome: task.sampling_outcome,
      ncr_id: ncrId,
    },
    client,
  );

  if (disposition === 'reject') {
    // Annex requirement 8: the NCR is created BY the reject, so a rejected lot can never exist
    // without its NCR record.
    await insertQcNcr(
      {
        ncr_id: ncrId!,
        lot_id: lotId,
        lot_number: held.lot_number,
        task_id: taskId,
        disposition_id: dispositionId,
        site_id: task.site_id,
        sku: task.sku,
        quantity: task.quantity,
        justification: (p['justification'] as string).trim(),
        raised_by: actorId,
        raised_at: decidedAt,
        source_event_id: eventId,
      },
      client,
    );
  }

  const gateStatus = disposition === 'accept' ? 'accepted' : 'rejected';
  const moved = await transitionQcGate(taskId, task.gate_status, gateStatus, decidedAt, client);
  if (moved !== 1) {
    reject(
      'DISPOSITION_EXISTS',
      'The QC gate changed before the disposition could be applied',
      { lot_id: lotId, task_id: taskId, expected_gate_status: task.gate_status },
      409,
    );
  }

  p['lot_number'] = held.lot_number;
  p['sku'] = task.sku;
  p['site_id'] = task.site_id;
  p['plan_version_id'] = task.plan_version_id;
  p['quantity'] = task.quantity;
  p['sampling_outcome'] = task.sampling_outcome;
  p['requested_by'] = actorId;
  p['approved_by'] = actorId;
  p['inspector_user_id'] = held.inspector_user_id;
  p['previous_gate_status'] = task.gate_status;
  p['gate_status'] = gateStatus;

  await emitNotificationInTransaction(
    {
      target: {
        role: config.quality.inspectionTaskNotificationRole,
        location_id: task.site_id,
      },
      event_type: 'qc_lot_dispositioned',
      status_verb: disposition === 'accept' ? 'Accepted' : 'Rejected',
      object_type: 'qc_inspection_task',
      object_id: taskId,
      actor_label: `Lot ${held.lot_number} (${task.sku})`,
      next_step:
        disposition === 'accept'
          ? 'The lot has left the QC gate and is available to downstream operations'
          : 'Record the NCR outcome (rework, downgrade or scrap) for this lot',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/** Story 8.3 (FR-Q-05, AC 2): the partial split into independently dispositionable child lots. */
async function applyLotSplitRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const lotId = p['lot_id'] as string;
  const dispositionId = p['disposition_id'] as string;
  const decidedAt = p['decided_at'] as string;
  const actorId = envelope.metadata.actor.user_id;

  const held = await lockLotForDisposition(lotId, taskId, client);
  const { task } = held;

  const splits = [...(p['splits'] as Array<Record<string, unknown>>)].sort(
    (a, b) => (a['sequence'] as number) - (b['sequence'] as number),
  );
  let totalScaled = 0n;
  for (const split of splits) {
    totalScaled += toScaledQuantity(split['quantity'] as string);
  }
  const parentScaled = toScaledQuantity(task.quantity);
  if (totalScaled !== parentScaled) {
    reject(
      'QC_SPLIT_QUANTITY_MISMATCH',
      'The split quantities must sum exactly to the lot quantity',
      {
        lot_id: lotId,
        lot_quantity: task.quantity,
        split_total: fromScaledQuantity(totalScaled),
      },
      400,
    );
  }

  // Lock and validate the whole stock position BEFORE the first write, so an INSUFFICIENT_STOCK
  // rejection leaves no partial effect.
  const grains = await lockOwnedLotGrains(task.sku, task.lot_number, client);
  const available = availableScaled(grains, { lot_id: lotId, lot_number: task.lot_number });
  if (available < totalScaled) {
    reject(
      'INSUFFICIENT_STOCK',
      'The lot does not hold enough unallocated owned stock for this split',
      {
        lot_id: lotId,
        lot_number: task.lot_number,
        available: fromScaledQuantity(available),
        requested: fromScaledQuantity(totalScaled),
      },
      409,
    );
  }
  const firstGrain = grains[0] ?? null;

  for (const split of splits) {
    const sequence = split['sequence'] as number;
    const quantity = split['quantity'] as string;
    const childLotNumber = `${task.lot_number}-${String(sequence).padStart(2, '0')}`;
    if (await lotExistsByNumberAndSku(childLotNumber, task.sku, client)) {
      reject(
        'DUPLICATE_LOT',
        'The derived child lot number already exists',
        { parent_lot_number: task.lot_number, child_lot_number: childLotNumber },
        // 400 matches the uq_lot_master_lot_number arm in the store's 23505 chain, so the
        // sequential pre-check and the race path return the identical status and code.
        400,
      );
    }
    const childLot = await createLot(
      {
        lot_number: childLotNumber,
        sku: task.sku,
        expiry_date: held.expiry_date,
        quality_hold_status: 'none',
        quality_hold_reason: null,
      },
      client,
    );
    await relabelLotQuantity(
      {
        parent_lot_id: lotId,
        parent_lot_number: task.lot_number,
        sku: task.sku,
        target_lot_id: childLot.lot_id,
        target_lot_number: childLotNumber,
        target_sku: task.sku,
        quantity,
      },
      grains,
      client,
    );

    // Annex requirement 7: uq_qc_inspection_task_source forbids reusing the parent's completion
    // identity, so each child task mints a fresh one and qc_lot_split carries the real provenance.
    const childTaskId = randomUUID();
    const childSourceCompletionId = randomUUID();
    await insertQcInspectionTask(
      {
        task_id: childTaskId,
        lot_id: childLot.lot_id,
        lot_number: childLotNumber,
        source_completion_type: task.source_completion_type,
        source_completion_id: childSourceCompletionId,
        item_id: task.item_id,
        sku: task.sku,
        quantity,
        uom: task.uom,
        site_id: task.site_id,
        bom_revision_id: task.bom_revision_id,
        plan_id: task.plan_id,
        plan_version_id: task.plan_version_id,
        plan_scope: task.plan_scope,
        source_order_type: task.source_order_type,
        source_order_ref: task.source_order_ref,
        completed_at: task.completed_at,
        business_date: task.business_date,
        gate_changed_at: decidedAt,
        source_event_id: eventId,
      },
      client,
    );
    // Children inherit the parent's whole inspection result set, so each is immediately
    // dispositionable without re-sampling (Binding Scope Decision 7).
    const inherited = await transitionQcTaskStatus(
      childTaskId,
      'open',
      'inspected',
      {
        sampling_id: task.sampling_id!,
        sampling_outcome: task.sampling_outcome!,
        nonconforming_sample_units: task.nonconforming_sample_units ?? 0,
        critical_nonconformities: task.critical_nonconformities ?? 0,
        inspected_by: task.inspected_by!,
        inspected_at: task.inspected_at!,
      },
      client,
    );
    if (inherited !== 1) {
      reject(
        'QC_SPLIT_INVALID',
        'The child inspection task could not inherit the parent inspection',
        { child_task_id: childTaskId, parent_task_id: taskId },
        409,
      );
    }
    await insertQcLotSplit(
      {
        split_id: randomUUID(),
        parent_lot_id: lotId,
        parent_lot_number: task.lot_number,
        parent_task_id: taskId,
        disposition_id: dispositionId,
        child_lot_id: childLot.lot_id,
        child_lot_number: childLotNumber,
        child_task_id: childTaskId,
        sequence,
        quantity,
        source_event_id: eventId,
      },
      client,
    );
    split['lot_id'] = childLot.lot_id;
    split['lot_number'] = childLotNumber;
    split['task_id'] = childTaskId;
    split['source_completion_id'] = childSourceCompletionId;
  }

  // The parent must be empty of owned stock now; a remainder is a coding error, not a tolerance.
  const remaining = await lockOwnedLotGrains(task.sku, task.lot_number, client);
  const remainder = remaining.reduce((sum, grain) => sum + toScaledQuantity(grain.on_hand), 0n);
  if (remainder !== 0n) {
    reject(
      'QC_SPLIT_INVALID',
      'The parent lot still holds owned stock after the split',
      { lot_id: lotId, remaining: fromScaledQuantity(remainder) },
      409,
    );
  }

  await insertQcLotDisposition(
    {
      disposition_id: dispositionId,
      lot_id: lotId,
      task_id: taskId,
      disposition: 'split',
      deviation_id: null,
      plan_version_id: task.plan_version_id,
      quantity: task.quantity,
      requested_by: actorId,
      inspector_user_id: held.inspector_user_id,
      approved_by: actorId,
      doa_entry_id: null,
      decided_at: decidedAt,
      source_event_id: eventId,
      sampling_outcome: task.sampling_outcome,
      ncr_id: null,
    },
    client,
  );
  const moved = await transitionQcGate(taskId, task.gate_status, 'split', decidedAt, client);
  if (moved !== 1) {
    reject(
      'DISPOSITION_EXISTS',
      'The QC gate changed before the split could be applied',
      { lot_id: lotId, task_id: taskId, expected_gate_status: task.gate_status },
      409,
    );
  }

  await appendRelabelTrace(
    {
      lot_id: lotId,
      sku: task.sku,
      event_id: eventId,
      event_type: QC_LOT_SPLIT_RECORDED,
      quantity: task.quantity,
      occurred_at: envelope.metadata.occurred_at,
      location_id: firstGrain?.location_id ?? null,
      location_code: firstGrain?.location_code ?? null,
    },
    client,
  );

  p['lot_number'] = task.lot_number;
  p['sku'] = task.sku;
  p['site_id'] = task.site_id;
  p['plan_version_id'] = task.plan_version_id;
  p['quantity'] = task.quantity;
  p['requested_by'] = actorId;
  p['approved_by'] = actorId;
  p['inspector_user_id'] = held.inspector_user_id;
  p['previous_gate_status'] = task.gate_status;
  p['gate_status'] = 'split';
  p['splits'] = splits;

  await emitNotificationInTransaction(
    {
      target: {
        role: config.quality.inspectionTaskNotificationRole,
        location_id: task.site_id,
      },
      event_type: 'qc_lot_split_recorded',
      status_verb: 'Split',
      object_type: 'qc_inspection_task',
      object_id: taskId,
      actor_label: `Lot ${task.lot_number} (${task.sku})`,
      next_step: `Disposition each of the ${splits.length} child lots independently`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/** Story 8.3 (FR-Q-06, AC 3, AC 4 and AC 5): the once-only NCR outcome. */
async function applyNcrOutcomeRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const ncrId = p['ncr_id'] as string;
  const lotId = p['lot_id'] as string;
  const outcome = p['outcome'] as 'rework' | 'downgrade' | 'scrap' | 'closed_with_capa';
  const decidedAt = p['decided_at'] as string;
  const actorId = envelope.metadata.actor.user_id;

  // Same lock prefix as every other QC write: the lot row first, then the NCR row.
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku, expiry_date::text AS expiry_date, quality_hold_status
       FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [lotId],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: lotId }, 404);
  }
  const lot = lotResult.rows[0]!;
  const ncr = await getQcNcrById(ncrId, client, true);
  if (!ncr || ncr.lot_id !== lotId) {
    reject(
      'NCR_NOT_FOUND',
      'No non-conformance report resolves for this lot',
      { ncr_id: ncrId, lot_id: lotId },
      404,
    );
  }
  if (ncr.outcome !== null) {
    reject(
      'NCR_OUTCOME_EXISTS',
      'The NCR outcome has already been recorded',
      { ncr_id: ncrId, outcome: ncr.outcome },
      409,
    );
  }
  // Story 8.5 (Binding Scope Decision 14): the outcome vocabularies do not mix. rework, downgrade
  // and scrap all key off a disposition a hold-sourced NCR does not have; closed_with_capa moves
  // no stock and exists only for the hold origin.
  if (ncr.origin === 'hold' && outcome !== 'closed_with_capa') {
    reject(
      'NCR_OUTCOME_NOT_APPLICABLE',
      'A disposition-family outcome cannot be recorded on a hold-sourced NCR',
      { ncr_id: ncrId, origin: ncr.origin, outcome },
      409,
    );
  }
  if (ncr.origin === 'disposition' && outcome === 'closed_with_capa') {
    reject(
      'NCR_OUTCOME_NOT_APPLICABLE',
      'closed_with_capa is only valid on a hold-sourced NCR',
      { ncr_id: ncrId, origin: ncr.origin, outcome },
      409,
    );
  }
  // AC6 (Story 8.3): any disposition-family NCR outcome on a lot under an independent manual or
  // recall hold is rejected fail-closed with LOT_ON_HOLD, re-derived under the same lock as every
  // other QC write. Story 8.5 (Binding Scope Decision 14) sequences this AFTER the origin gate -
  // a hold-sourced NCR's lot is held BY DEFINITION, so its origin/vocabulary refusal must win -
  // and exempts 'closed_with_capa', which moves no stock, so the hold-bypass class this guard
  // exists for cannot occur through it. The lot lock above is still taken first, unchanged.
  if (outcome !== 'closed_with_capa' && lot['quality_hold_status'] !== 'none') {
    reject(
      'LOT_ON_HOLD',
      'Lot is on quality hold and the NCR outcome cannot be recorded',
      { lot_id: lotId, ncr_id: ncrId, reason: 'manual_hold' },
      400,
    );
  }
  // Story 8.5 (AC 4, Binding Scope Decision 13): the mandatory-CAPA gate is enforced at CLOSE.
  if (outcome === 'closed_with_capa' && ncr.capa_mandatory && ncr.capa_id === null) {
    const businessDate = toIstCalendarDate(new Date(ncr.raised_at));
    const matchingCount = await countMatchingNcrsInWindow(
      ncr.sku,
      ncr.defect_code ?? '',
      businessDate,
      config.qc.repeatDefectWindowDays,
      client,
    );
    reject(
      'APPROVAL_REQUIRED',
      `A CAPA is mandatory before this NCR can be closed: ${matchingCount} matching NCR(s) for (${ncr.sku}, ${ncr.defect_code}) inside the ${config.qc.repeatDefectWindowDays}-day repeat-defect window. Link one via POST /api/v1/qc/ncrs/:ncrId/capa.`,
      {
        ncr_id: ncrId,
        sku: ncr.sku,
        defect_code: ncr.defect_code,
        matching_ncr_count: matchingCount,
        repeat_defect_threshold: config.qc.repeatDefectThreshold,
        repeat_defect_window_days: config.qc.repeatDefectWindowDays,
        link_route: `POST /api/v1/qc/ncrs/${ncrId}/capa`,
      },
      409,
    );
  }

  let downgradeLotId: string | null = null;
  let downgradeLotNumber: string | null = null;
  let qualityHoldStatus: 'none' | 'held' = 'none';

  if (outcome === 'downgrade') {
    const downgradeSku = (p['downgrade_sku'] as string).trim();
    if (downgradeSku === ncr.sku) {
      reject(
        'DOWNGRADE_SKU_INVALID',
        'The downgrade SKU must differ from the rejected lot SKU',
        { ncr_id: ncrId, sku: ncr.sku },
        400,
      );
    }
    if (!(await itemExistsBySku(downgradeSku, client))) {
      reject(
        'DOWNGRADE_SKU_INVALID',
        'The downgrade SKU is not registered in the item master',
        { ncr_id: ncrId, downgrade_sku: downgradeSku },
        400,
      );
    }
    downgradeLotNumber = `${ncr.lot_number}-DG`;
    if (await lotExistsByNumberAndSku(downgradeLotNumber, downgradeSku, client)) {
      reject(
        'DUPLICATE_LOT',
        'The derived downgrade lot number already exists',
        { lot_number: ncr.lot_number, downgrade_lot_number: downgradeLotNumber },
        400,
      );
    }
    const grains = await lockOwnedLotGrains(ncr.sku, ncr.lot_number, client);
    const available = availableScaled(grains, { lot_id: lotId, lot_number: ncr.lot_number });
    if (available < toScaledQuantity(ncr.quantity)) {
      reject(
        'INSUFFICIENT_STOCK',
        'The lot does not hold enough unallocated owned stock to downgrade',
        {
          lot_id: lotId,
          available: fromScaledQuantity(available),
          requested: ncr.quantity,
        },
        409,
      );
    }
    const firstGrain = grains[0] ?? null;
    // Binding Scope Decision 8: the downgrade lot carries NO inspection task, so the QC gate
    // treats it as ungoverned stock and it is sellable seconds.
    const downgradeLot = await createLot(
      {
        lot_number: downgradeLotNumber,
        sku: downgradeSku,
        expiry_date: (lot['expiry_date'] as string | null) ?? null,
        quality_hold_status: 'none',
        quality_hold_reason: null,
      },
      client,
    );
    downgradeLotId = downgradeLot.lot_id;
    await relabelLotQuantity(
      {
        parent_lot_id: lotId,
        parent_lot_number: ncr.lot_number,
        sku: ncr.sku,
        target_lot_id: downgradeLot.lot_id,
        target_lot_number: downgradeLotNumber,
        target_sku: downgradeSku,
        quantity: ncr.quantity,
      },
      grains,
      client,
    );
    await appendRelabelTrace(
      {
        lot_id: lotId,
        sku: ncr.sku,
        event_id: eventId,
        event_type: QC_NCR_OUTCOME_RECORDED,
        quantity: ncr.quantity,
        occurred_at: envelope.metadata.occurred_at,
        location_id: firstGrain?.location_id ?? null,
        location_code: firstGrain?.location_code ?? null,
      },
      client,
    );
  }

  if (outcome === 'scrap') {
    // Annex requirement 10: scrap moves nothing. It parks the quantity on the INDEPENDENT hold
    // axis so every consumption path blocks, and retains this event as the AD-10 source document
    // for the Phase 2 (Epic 16) FR-SC intake.
    const heldLot = await placeQualityHold(
      ncr.lot_number,
      ncr.sku,
      SCRAP_PENDING_HOLD_REASON,
      client,
    );
    if (!heldLot) {
      reject(
        'LOT_NOT_FOUND',
        'The lot could not be placed on the scrap-pending hold',
        { lot_id: lotId, lot_number: ncr.lot_number },
        404,
      );
    }
    qualityHoldStatus = 'held';
  }

  const reworkEventId = outcome === 'rework' ? (p['rework_event_id'] as string) : null;
  const decided = await setQcNcrOutcome(
    {
      ncr_id: ncrId,
      outcome,
      outcome_reason: (p['outcome_reason'] as string).trim(),
      outcome_by: actorId,
      outcome_at: decidedAt,
      outcome_event_id: eventId,
      downgrade_sku: outcome === 'downgrade' ? (p['downgrade_sku'] as string).trim() : null,
      downgrade_lot_id: downgradeLotId,
      rework_requested_event_id: reworkEventId,
    },
    client,
  );
  if (!decided) {
    // The guarded UPDATE is the concurrency backstop: a raced second outcome updates zero rows.
    reject(
      'NCR_OUTCOME_EXISTS',
      'The NCR outcome has already been recorded',
      { ncr_id: ncrId },
      409,
    );
  }

  p['task_id'] = ncr.task_id;
  p['lot_number'] = ncr.lot_number;
  p['sku'] = ncr.sku;
  p['site_id'] = ncr.site_id;
  p['quantity'] = ncr.quantity;
  p['outcome_by'] = actorId;
  p['downgrade_lot_id'] = downgradeLotId;
  p['downgrade_lot_number'] = downgradeLotNumber;
  p['rework_requested_event_id'] = reworkEventId;
  p['quality_hold_status'] = qualityHoldStatus;

  await emitNotificationInTransaction(
    {
      target: {
        role: config.quality.inspectionTaskNotificationRole,
        location_id: ncr.site_id,
      },
      event_type: 'qc_ncr_outcome_recorded',
      status_verb: 'NCR outcome recorded',
      object_type: 'qc_ncr',
      object_id: ncrId,
      actor_label: `Lot ${ncr.lot_number} (${ncr.sku})`,
      next_step:
        outcome === 'rework'
          ? 'A rework order will consume this lot and produce a new lot for the QC gate'
          : outcome === 'downgrade'
            ? `Quantity relabelled onto downgrade lot ${downgradeLotNumber}`
            : outcome === 'closed_with_capa'
              ? 'The NCR is closed with its CAPA; the hold is released separately'
              : 'Quantity is blocked pending scrap disposal',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/**
 * Story 8.3 (FR-Q-06, AC 5): the rework integration contract. It writes no projection - it exists
 * so Story 6.3 has a subscribable fact - but it is NOT freely postable: the owning NCR must already
 * name this exact event id (the handler mints it and the outcome applier stores it), and every
 * field is re-derived from the NCR and the task.
 */
async function applyReworkRequested(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const ncrId = p['ncr_id'] as string;
  const ncr = await getQcNcrById(ncrId, client);
  // Story 8.5 widening: task_id is nullable on a hold-sourced NCR, but a rework outcome is only
  // recordable on a disposition-sourced one, so the null arm folds into the same refusal.
  if (
    !ncr ||
    ncr.outcome !== 'rework' ||
    ncr.rework_requested_event_id !== eventId ||
    ncr.task_id === null
  ) {
    reject(
      'QC_REWORK_NOT_DERIVED',
      'A rework request is only admissible from the NCR outcome that mints it',
      { ncr_id: ncrId, event_id: eventId },
      409,
    );
  }
  const task = await getQcInspectionTaskById(ncr.task_id, client);
  if (!task) {
    reject('QC_TASK_NOT_FOUND', 'The NCR task does not resolve', { ncr_id: ncrId }, 404);
  }
  const derived: Record<string, unknown> = {
    lot_id: ncr.lot_id,
    lot_number: ncr.lot_number,
    task_id: ncr.task_id,
    sku: ncr.sku,
    site_id: ncr.site_id,
    plan_version_id: task.plan_version_id,
    requested_by: ncr.outcome_by,
  };
  for (const [field, expected] of Object.entries(derived)) {
    if (p[field] !== expected) {
      reject(
        'QC_DERIVATION_MISMATCH',
        `${field} disagrees with the server re-derivation for qc.rework_requested`,
        { field, declared_value: p[field], derived_value: expected },
        409,
      );
    }
  }
  // quantity and requested_at are NUMERIC/timestamp round-trips: the declared string can differ in
  // scale or offset formatting from the canonical re-derivation while denoting the same value, so
  // compare by value (compareDecimalStrings, epoch millis) rather than by raw string equality.
  if (compareDecimalStrings(p['quantity'] as string, ncr.quantity) !== 0) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'quantity disagrees with the server re-derivation for qc.rework_requested',
      { field: 'quantity', declared_value: p['quantity'], derived_value: ncr.quantity },
      409,
    );
  }
  if (
    new Date(p['requested_at'] as string).getTime() !== new Date(ncr.outcome_at as string).getTime()
  ) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'requested_at disagrees with the server re-derivation for qc.rework_requested',
      { field: 'requested_at', declared_value: p['requested_at'], derived_value: ncr.outcome_at },
      409,
    );
  }
}

// ---------------------------------------------------------------------------
// Story 8.2 appliers (sampling, results, completion, switching-state commands)
// ---------------------------------------------------------------------------

/**
 * LOCKING CONTRACT (Story 8.2): every task-scoped applier reads the task WITHOUT a lock to learn
 * its lot, locks the lot row FOR UPDATE, then re-reads the task FOR UPDATE (the fixed Story 8.1
 * lot-then-gate prefix, so a result, a completion, a conditional release and a consumption on one
 * lot cannot deadlock), then takes the (plan, site) switching-state advisory lock and, when a row
 * exists, its FOR UPDATE. Results and completion both hold the task row, so a completion racing a
 * result insert for the same task cannot lose the result.
 */
async function lockTaskForInspection(
  taskId: string,
  client: PoolClient,
): Promise<QcInspectionTaskRow> {
  const unlocked = await getQcInspectionTaskById(taskId, client);
  if (!unlocked) {
    reject('QC_TASK_NOT_FOUND', 'QC inspection task not found', { task_id: taskId }, 404);
  }
  const lot = await client.query(`SELECT lot_id FROM lot_master WHERE lot_id = $1 FOR UPDATE`, [
    unlocked.lot_id,
  ]);
  if (lot.rows.length === 0) {
    reject(
      'LOT_NOT_FOUND',
      'The lot of this task does not resolve',
      { lot_id: unlocked.lot_id },
      404,
    );
  }
  const task = await getQcInspectionTaskById(taskId, client, true);
  if (!task) {
    reject('QC_TASK_NOT_FOUND', 'QC inspection task not found', { task_id: taskId }, 404);
  }
  return task;
}

function switchingLockKey(planId: string, siteId: string): string {
  return `qc_switching|${planId}|${siteId}`;
}

function snapshotOf(state: Awaited<ReturnType<typeof getSwitchingState>>): SwitchingSnapshot {
  if (!state) {
    return {
      severity: 'normal',
      switching_score: 0,
      recent_original_outcomes: [],
      consecutive_accepted_on_tightened: 0,
      not_accepted_on_tightened: 0,
      reduced_eligible: false,
      inspection_discontinued: false,
      lots_counted: 0,
    };
  }
  return {
    severity: state.severity,
    switching_score: state.switching_score,
    recent_original_outcomes: state.recent_original_outcomes,
    consecutive_accepted_on_tightened: state.consecutive_accepted_on_tightened,
    not_accepted_on_tightened: state.not_accepted_on_tightened,
    reduced_eligible: state.reduced_eligible,
    inspection_discontinued: state.inspection_discontinued,
    lots_counted: state.lots_counted,
  };
}

async function applySamplingDetermined(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const samplingId = p['sampling_id'] as string;
  const determinedAt = p['determined_at'] as string;
  const actorId = envelope.metadata.actor.user_id;

  const task = await lockTaskForInspection(taskId, client);
  if (task.task_status !== 'open') {
    reject(
      'QC_TASK_NOT_OPEN',
      'Sampling can only be determined for an open inspection task',
      { task_id: taskId, task_status: task.task_status, sampling_id: task.sampling_id },
      409,
    );
  }
  const existing = await getQcSamplingPlanByTaskId(taskId, client);
  if (existing) {
    reject(
      'QC_SAMPLING_EXISTS',
      'A sampling plan is already frozen on this task',
      { task_id: taskId, existing_sampling_id: existing.sampling_id },
      409,
    );
  }
  const version = await getInspectionPlanVersionById(task.plan_version_id, client);
  if (!version) {
    reject(
      'INSPECTION_PLAN_NOT_FOUND',
      'The frozen plan version of this task does not resolve',
      { task_id: taskId, plan_version_id: task.plan_version_id },
      404,
    );
  }
  const characteristics = await listInspectionPlanCharacteristics(task.plan_version_id, client);

  await advisoryLock(switchingLockKey(task.plan_id, task.site_id), client);
  const state = await getSwitchingState(task.plan_id, task.site_id, client, true);
  if (state?.inspection_discontinued) {
    reject(
      'SAMPLING_INSPECTION_DISCONTINUED',
      'Inspection under this plan is discontinued at this site until a QC Head resumes it',
      { plan_id: task.plan_id, site_id: task.site_id },
      409,
    );
  }
  const severity = state?.severity ?? 'normal';
  const determined = determineSampling({
    quantity: task.quantity,
    aql: version.aql,
    inspection_level: version.inspection_level,
    characteristics,
    severity,
  });

  await insertQcSamplingPlan(
    {
      sampling_id: samplingId,
      task_id: taskId,
      lot_id: task.lot_id,
      lot_number: task.lot_number,
      plan_version_id: task.plan_version_id,
      plan_id: task.plan_id,
      site_id: task.site_id,
      lot_size: determined.lot_size,
      aql: determined.aql,
      inspection_level: determined.inspection_level,
      severity: determined.severity,
      code_letter: determined.code_letter,
      resolved_code_letter: determined.resolved_code_letter,
      sample_size: determined.sample_size,
      acceptance_number: determined.acceptance_number,
      rejection_number: determined.rejection_number,
      sampling_basis: determined.sampling_basis,
      standard_ref: determined.standard_ref,
      critical_characteristic_count: determined.critical_characteristic_ids.length,
      determined_by: actorId,
      determined_at: determinedAt,
      source_event_id: eventId,
    },
    client,
  );
  const moved = await transitionQcTaskStatus(
    taskId,
    'open',
    'sampling_determined',
    { sampling_id: samplingId },
    client,
  );
  if (moved !== 1) {
    reject(
      'QC_TASK_NOT_OPEN',
      'The task left the open state before sampling could be frozen',
      { task_id: taskId },
      409,
    );
  }

  p['lot_id'] = task.lot_id;
  p['lot_number'] = task.lot_number;
  p['plan_version_id'] = task.plan_version_id;
  p['plan_id'] = task.plan_id;
  p['site_id'] = task.site_id;
  p['lot_size'] = determined.lot_size;
  p['aql'] = determined.aql;
  p['inspection_level'] = determined.inspection_level;
  p['severity'] = determined.severity;
  p['code_letter'] = determined.code_letter;
  p['resolved_code_letter'] = determined.resolved_code_letter;
  p['sample_size'] = determined.sample_size;
  p['acceptance_number'] = determined.acceptance_number;
  p['rejection_number'] = determined.rejection_number;
  p['sampling_basis'] = determined.sampling_basis;
  p['standard_ref'] = determined.standard_ref;
  p['critical_characteristic_ids'] = determined.critical_characteristic_ids;
  p['determined_by'] = actorId;
  p['previous_task_status'] = 'open';
  p['task_status'] = 'sampling_determined';
}

interface ReadingInput {
  result_id: string;
  sample_unit_no: number;
  measured_value?: string;
  measured_uom?: string;
  attribute_conforms?: boolean;
}

/** The unit range a characteristic requires under the frozen plan (Binding Scope Decision on AC 2). */
function requiredUnitCount(
  plan: Pick<QcSamplingPlanRow, 'sampling_basis' | 'lot_size' | 'sample_size'>,
  characteristicClass: string,
): number {
  return plan.sampling_basis === 'full_inspection' || characteristicClass === 'critical'
    ? plan.lot_size
    : plan.sample_size;
}

/**
 * Shared by qc.result_recorded (instrument-bound) and qc.observation_recorded (instrument-less):
 * the task must be in sampling_determined, the characteristic must be a line of the frozen plan
 * version, every unit must be inside the characteristic's required range, the reading kind must
 * pair with the line, and the instrument binding (AC 4 and AC 5) or its absence (Binding Scope
 * Decision 2) must match the line. conforms is derived here and stored (Annex requirement 7).
 */
async function applyResultBatch(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
  kind: 'result' | 'observation',
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  if (kind === 'result' && p['task_id'] === undefined) return; // Story 1.7 synthetic shape
  const taskId = p['task_id'] as string;
  const lotId = p['lot_id'] as string;
  const characteristicId = p['characteristic_id'] as string;
  const readings = p['readings'] as ReadingInput[];
  const recordedAt = p['recorded_at'] as string;
  const actorId = envelope.metadata.actor.user_id;
  if (!isUuid(actorId)) {
    reject('INVALID_PAYLOAD', 'The recording actor must be an authenticated user', {
      actor_user_id: actorId,
    });
  }

  const task = await lockTaskForInspection(taskId, client);
  if (task.lot_id !== lotId) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'The declared lot_id is not the lot of this inspection task',
      { task_id: taskId, declared_lot_id: lotId, lot_id: task.lot_id },
      409,
    );
  }
  if (task.task_status === 'open') {
    reject(
      'QC_SAMPLING_REQUIRED',
      'Sampling must be determined before results are recorded',
      { task_id: taskId, task_status: task.task_status },
      409,
    );
  }
  if (task.task_status !== 'sampling_determined') {
    reject(
      'QC_TASK_NOT_OPEN_FOR_RESULTS',
      'Inspection of this task is complete; no further results are accepted',
      { task_id: taskId, task_status: task.task_status },
      409,
    );
  }
  const plan = await getQcSamplingPlanByTaskId(taskId, client);
  if (!plan) {
    reject(
      'QC_SAMPLING_REQUIRED',
      'No sampling plan is frozen on this task',
      { task_id: taskId },
      409,
    );
  }
  const characteristics = await listInspectionPlanCharacteristics(task.plan_version_id, client);
  const line = characteristics.find((c) => c.characteristic_id === characteristicId);
  if (!line) {
    reject(
      'QC_CHARACTERISTIC_NOT_IN_PLAN',
      'The characteristic is not a line of the plan version frozen on this task',
      {
        task_id: taskId,
        plan_version_id: task.plan_version_id,
        characteristic_id: characteristicId,
      },
    );
  }
  const maxUnit = requiredUnitCount(plan, line.characteristic_class);
  for (const r of readings) {
    if (r.sample_unit_no > maxUnit) {
      reject(
        'QC_SAMPLE_UNIT_OUT_OF_RANGE',
        'The sample unit is outside the range this characteristic requires',
        {
          characteristic_id: characteristicId,
          characteristic_class: line.characteristic_class,
          sample_unit_no: r.sample_unit_no,
          max_sample_unit_no: maxUnit,
          sampling_basis: plan.sampling_basis,
        },
      );
    }
  }

  let instrumentAssetId: string | null = null;
  let instrumentId: string | null = null;
  if (kind === 'result') {
    if (line.result_kind !== 'numeric' && line.instrument_type === null) {
      reject(
        'INSTRUMENT_NOT_PERMITTED',
        'This characteristic is an instrument-less attribute line; record an observation instead',
        { characteristic_id: characteristicId, result_kind: line.result_kind },
      );
    }
    instrumentAssetId = p['instrument_asset_id'] as string;
    const declaredInstrumentId = p['instrument_id'] as string;
    const register = await getInstrumentRecordByAssetId(instrumentAssetId, client);
    if (!register) {
      reject(
        'INSTRUMENT_NOT_FOUND',
        'The asset is not a registered measuring instrument',
        { instrument_asset_id: instrumentAssetId },
        404,
      );
    }
    if (register.instrument_id.toLowerCase() !== declaredInstrumentId.trim().toLowerCase()) {
      reject(
        'QC_DERIVATION_MISMATCH',
        'The declared instrument_id is not the register key of the instrument asset',
        {
          instrument_asset_id: instrumentAssetId,
          declared_instrument_id: declaredInstrumentId,
          instrument_id: register.instrument_id,
        },
        409,
      );
    }
    instrumentId = register.instrument_id;
    // AD-8: re-checked INSIDE the transaction; no role overrides and the pre-transaction gate in
    // src/compliance/calibration.ts is untouched.
    const status = await getCalibrationStatus(register.instrument_id, client);
    if (status !== 'calibrated') {
      reject(
        'CALIBRATION_LOCKOUT',
        'Instrument calibration status blocks QC result persistence',
        {
          instrument_id: register.instrument_id,
          instrument_asset_id: instrumentAssetId,
          calibration_status: status,
        },
        423,
      );
    }
  } else if (line.result_kind !== 'attribute' || line.instrument_type !== null) {
    reject(
      'INSTRUMENT_REQUIRED',
      'This characteristic requires a measuring instrument; record a result with instrument_asset_id',
      {
        characteristic_id: characteristicId,
        result_kind: line.result_kind,
        instrument_type: line.instrument_type,
      },
    );
  }

  // Existing units for this characteristic: the sequential path returns the same code as the
  // uq_qc_inspection_result_unit race path.
  const existing = (await countResultsByCharacteristic(taskId, client)).get(characteristicId);
  const existingUnits = new Set(existing?.units ?? []);
  const rows: InsertQcInspectionResultRow[] = [];
  const conformsByResultId: Record<string, boolean> = {};
  for (const r of readings) {
    if (existingUnits.has(r.sample_unit_no)) {
      reject(
        'QC_RESULT_EXISTS',
        'A result already exists for this task, characteristic and sample unit',
        { task_id: taskId, characteristic_id: characteristicId, sample_unit_no: r.sample_unit_no },
        409,
      );
    }
    let conforms: boolean;
    if (line.result_kind === 'numeric') {
      if (typeof r.measured_value !== 'string' || r.attribute_conforms !== undefined) {
        reject(
          'QC_RESULT_KIND_MISMATCH',
          'A numeric characteristic needs measured_value and measured_uom, not attribute_conforms',
          { characteristic_id: characteristicId, sample_unit_no: r.sample_unit_no },
        );
      }
      if ((r.measured_uom ?? null) !== line.limit_uom) {
        reject('QC_RESULT_UOM_MISMATCH', 'measured_uom must equal the characteristic limit_uom', {
          characteristic_id: characteristicId,
          sample_unit_no: r.sample_unit_no,
          measured_uom: r.measured_uom ?? null,
          limit_uom: line.limit_uom,
        });
      }
      conforms =
        (line.lower_limit === null ||
          compareDecimalStrings(r.measured_value, line.lower_limit) >= 0) &&
        (line.upper_limit === null ||
          compareDecimalStrings(r.measured_value, line.upper_limit) <= 0);
    } else {
      if (
        typeof r.attribute_conforms !== 'boolean' ||
        r.measured_value !== undefined ||
        r.measured_uom !== undefined
      ) {
        reject(
          'QC_RESULT_KIND_MISMATCH',
          'An attribute characteristic needs attribute_conforms and no measured value',
          { characteristic_id: characteristicId, sample_unit_no: r.sample_unit_no },
        );
      }
      conforms = r.attribute_conforms;
    }
    conformsByResultId[r.result_id] = conforms;
    rows.push({
      result_id: r.result_id,
      task_id: taskId,
      lot_id: task.lot_id,
      characteristic_id: characteristicId,
      characteristic_class: line.characteristic_class,
      sample_unit_no: r.sample_unit_no,
      result_kind: line.result_kind,
      measured_value: line.result_kind === 'numeric' ? (r.measured_value as string) : null,
      measured_uom: line.result_kind === 'numeric' ? (r.measured_uom ?? null) : null,
      attribute_conforms:
        line.result_kind === 'attribute' ? (r.attribute_conforms as boolean) : null,
      conforms,
      instrument_asset_id: instrumentAssetId,
      instrument_id: instrumentId,
      recorded_by: actorId,
      recorded_at: recordedAt,
      source_event_id: eventId,
    });
  }
  await insertQcInspectionResults(rows, client);

  p['characteristic_class'] = line.characteristic_class;
  p['result_kind'] = line.result_kind;
  p['conforms_by_result_id'] = conformsByResultId;
  if (kind === 'result') p['instrument_id'] = instrumentId;
}

/** Whether the lot would have been accepted one preferred AQL step tighter at the same code letter (clause 9.3.3.2). */
function tighterAqlAcceptableFor(plan: QcSamplingPlanRow, nonconforming: number): boolean {
  if (plan.sampling_basis !== 'aql_table' || plan.aql === null || !isCodeLetter(plan.code_letter)) {
    return false;
  }
  const aql = canonicalAql(plan.aql);
  const tighter = aql === null ? null : tighterAql(aql);
  if (tighter === null) return false;
  const cell = TABLES_BY_SEVERITY[plan.severity][plan.code_letter][PREFERRED_AQLS.indexOf(tighter)];
  if (cell === undefined || typeof cell === 'string') return false; // arrow: conservative
  return nonconforming <= cell.ac;
}

async function applyInspectionCompleted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const completedAt = p['completed_at'] as string;
  const actorId = envelope.metadata.actor.user_id;

  const task = await lockTaskForInspection(taskId, client);
  if (task.task_status === 'open') {
    reject(
      'QC_SAMPLING_REQUIRED',
      'Sampling must be determined before inspection can complete',
      { task_id: taskId, task_status: task.task_status },
      409,
    );
  }
  if (task.task_status !== 'sampling_determined') {
    reject(
      'QC_TASK_NOT_OPEN_FOR_RESULTS',
      'Inspection of this task is already complete',
      { task_id: taskId, task_status: task.task_status, sampling_outcome: task.sampling_outcome },
      409,
    );
  }
  const plan = await getQcSamplingPlanByTaskId(taskId, client);
  if (!plan) {
    reject(
      'QC_SAMPLING_REQUIRED',
      'No sampling plan is frozen on this task',
      { task_id: taskId },
      409,
    );
  }
  const characteristics = await listInspectionPlanCharacteristics(task.plan_version_id, client);
  const counts = await countResultsByCharacteristic(taskId, client);
  const gaps: Array<{ characteristic_id: string; required: number; recorded: number }> = [];
  for (const line of characteristics) {
    const required = requiredUnitCount(plan, line.characteristic_class);
    const units = counts.get(line.characteristic_id)?.units ?? [];
    const recorded = new Set(units.filter((u) => u >= 1 && u <= required)).size;
    if (recorded < required) {
      gaps.push({ characteristic_id: line.characteristic_id, required, recorded });
    }
  }
  if (gaps.length > 0) {
    reject(
      'QC_INSPECTION_INCOMPLETE',
      'Inspection cannot complete while required results are missing',
      { task_id: taskId, sampling_id: plan.sampling_id, missing: gaps },
      409,
    );
  }

  const units = await listNonconformingUnits(taskId, client);
  const outcome = evaluateOutcome(plan, units);

  await advisoryLock(switchingLockKey(task.plan_id, task.site_id), client);
  const stateRow = await getSwitchingState(task.plan_id, task.site_id, client, true);
  const before = snapshotOf(stateRow);
  const after = advanceSwitchingState(
    before,
    outcome,
    plan,
    tighterAqlAcceptableFor(plan, outcome.nonconforming_sample_units),
  );
  if (plan.sampling_basis === 'aql_table') {
    await upsertSwitchingState(
      {
        ...(stateRow ?? initialSwitchingState(task.plan_id, task.site_id, eventId)),
        ...after,
        plan_id: task.plan_id,
        site_id: task.site_id,
        last_task_id: taskId,
        source_event_id: eventId,
      },
      client,
    );
  }

  const moved = await transitionQcTaskStatus(
    taskId,
    'sampling_determined',
    'inspected',
    {
      sampling_outcome: outcome.sampling_outcome,
      nonconforming_sample_units: outcome.nonconforming_sample_units,
      critical_nonconformities: outcome.critical_nonconformities,
      inspected_by: actorId,
      inspected_at: completedAt,
    },
    client,
  );
  if (moved !== 1) {
    reject(
      'QC_TASK_NOT_OPEN_FOR_RESULTS',
      'The task left the sampling_determined state before inspection could complete',
      { task_id: taskId },
      409,
    );
  }

  p['sampling_id'] = plan.sampling_id;
  p['sampling_outcome'] = outcome.sampling_outcome;
  p['nonconforming_sample_units'] = outcome.nonconforming_sample_units;
  p['critical_nonconformities'] = outcome.critical_nonconformities;
  p['severity_used'] = plan.severity;
  p['previous_severity'] = before.severity;
  p['new_severity'] = after.severity;
  p['switching_score'] = after.switching_score;
  p['reduced_eligible'] = after.reduced_eligible;
  p['inspection_discontinued'] = after.inspection_discontinued;
  p['inspected_by'] = actorId;
  p['previous_task_status'] = 'sampling_determined';
  p['task_status'] = 'inspected';

  if (outcome.sampling_outcome === 'not_accepted') {
    // The task remains the authoritative queue; this is a transactional convenience notification.
    await emitNotificationInTransaction(
      {
        target: { role: config.quality.inspectionTaskNotificationRole, location_id: task.site_id },
        event_type: 'qc_inspection_not_accepted',
        status_verb: 'Not accepted',
        object_type: 'qc_inspection_task',
        object_id: taskId,
        actor_label: `Lot ${task.lot_number} (${task.sku})`,
        next_step: `Disposition the lot: ${outcome.nonconforming_sample_units} nonconforming sample unit(s), ${outcome.critical_nonconformities} critical`,
        actor: envelope.metadata.actor,
        correlation_id: envelope.metadata.correlation_id,
        causation_id: eventId,
        occurred_at: envelope.metadata.occurred_at,
      },
      client,
    );
  }
}

async function applySamplingStateAdjusted(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const planId = p['plan_id'] as string;
  const siteId = p['site_id'] as string;
  const action = p['action'] as 'authorize_reduced' | 'resume_inspection';
  const actor = envelope.metadata.actor;
  const qcHeadRoles: readonly string[] = config.quality.qcHeadRoles;
  // Binding Scope Decision 9: QC Head-level authority from configuration, never a hard-coded role.
  if (!qcHeadRoles.includes(actor.role)) {
    reject(
      'APPROVAL_REQUIRED',
      'Adjusting the sampling switching state requires QC Head-level authority',
      { plan_id: planId, site_id: siteId, action, qc_head_roles: [...qcHeadRoles] },
      403,
    );
  }
  const plan = await getInspectionPlanById(planId, client);
  if (!plan) {
    reject('INSPECTION_PLAN_NOT_FOUND', 'Inspection plan not found', { plan_id: planId }, 404);
  }

  await advisoryLock(switchingLockKey(planId, siteId), client);
  const stateRow = await getSwitchingState(planId, siteId, client, true);
  const before = snapshotOf(stateRow);
  let after: SwitchingSnapshot;
  if (action === 'authorize_reduced') {
    if (before.severity !== 'normal' || !before.reduced_eligible) {
      reject(
        'REDUCED_INSPECTION_NOT_ELIGIBLE',
        'Reduced inspection requires normal inspection with a switching score of at least 30',
        {
          plan_id: planId,
          site_id: siteId,
          severity: before.severity,
          switching_score: before.switching_score,
          reduced_eligible: before.reduced_eligible,
        },
        409,
      );
    }
    after = applyAuthorizeReduced(before);
  } else {
    if (!before.inspection_discontinued) {
      reject(
        'SAMPLING_INSPECTION_NOT_DISCONTINUED',
        'Inspection under this plan is not discontinued at this site',
        { plan_id: planId, site_id: siteId, severity: before.severity },
        409,
      );
    }
    after = applyResumeInspection(before);
  }
  await upsertSwitchingState(
    {
      ...(stateRow ?? initialSwitchingState(planId, siteId, eventId)),
      ...after,
      plan_id: planId,
      site_id: siteId,
      source_event_id: eventId,
    },
    client,
  );
  p['previous_severity'] = before.severity;
  p['new_severity'] = after.severity;
  p['authorized_by'] = actor.user_id;
  p['authorizing_role'] = actor.role;
}

// ---------------------------------------------------------------------------
// Story 8.4: CoA/CoC, retention samples and batch release records (FR-Q-07, FR-Q-08)
// ---------------------------------------------------------------------------

/**
 * Binding Scope Decision 2: AC 3's CM/L or R-number comes from Story 8.7's BIS Licence Register,
 * which does not exist yet and is sequenced AFTER this story. This is the explicit hand-off point:
 * Story 8.7 replaces the body with a lookup against the licence register keyed on (sku, site).
 * Until then it resolves to null, qc_batch_release.bis_licence_number carries the null, and a null
 * NEVER blocks release - AC 3 only requires printing the number when one is available. The same
 * kind of documented forward reference as Story 4.2's early reservation of qc.lot_dispositioned.
 */
export async function resolveBisLicenceNumber(
  _sku: string,
  _siteId: string,
): Promise<string | null> {
  return null;
}

/**
 * Binding Scope Decision 7: the retention window for one lot, in years. Since the boot guard in
 * src/config/index.ts already enforces retentionYearsDefault >= bisRetentionFloorYears (that guard
 * IS AC 2's RETENTION_FLOOR_VIOLATION check), this Math.max currently evaluates to
 * retentionYearsDefault whatever the flag says. That is deliberate future-proofing for a real
 * per-SKU BIS STI registry (Open Question 2 / Story 8.6-8.7), NOT a no-op to simplify away: when
 * the floor becomes per-scheme rather than global, this is the single place it starts to bite.
 *
 * Both applyRetentionSampleLogged and applyBatchReleaseRecorded resolve through here, so both
 * agree on the year count; the release record is then the authority for the expiry DATE and
 * re-stamps the sample (AC1 ties retention to release).
 *
 * The two bounds are parameters defaulting to config so the Math.max is actually exercisable in a
 * test. With the boot guard in force the floor can never exceed the default, which would otherwise
 * make this function provably equal to `retentionYearsDefault` and any test of it a tautology.
 */
/**
 * Story 8.4 Open Question 1, answered by the product owner 2026-08-30: a retention sample is
 * required for every released lot by default, or only for BIS-covered products when the deployment
 * opts into the narrower rule.
 *
 * The scope is a parameter defaulting to config so the branch is exercisable in a test without
 * mutating global config - the same reason resolveRetentionYears takes its bounds explicitly.
 */
export function retentionSampleRequiredFor(
  bisLicenceRequired: boolean,
  scope: RetentionSampleScope = config.quality.retentionSampleScope,
): boolean {
  return scope === 'all_released_lots' || bisLicenceRequired;
}

export function resolveRetentionYears(
  bisLicenceRequired: boolean,
  defaultYears: number = config.quality.retentionYearsDefault,
  floorYears: number = config.quality.bisRetentionFloorYears,
): number {
  return Math.max(defaultYears, bisLicenceRequired ? floorYears : 0);
}

/**
 * Adds a whole number of years to a YYYY-MM-DD calendar date, clamping 29 February onto 28 February
 * in a non-leap target year. Pure calendar arithmetic on the string components - a retention expiry
 * is a legal calendar date and must never round-trip through a JS Date's local timezone.
 */
export function addYearsToCalendarDate(date: string, years: number): string {
  const [y, m, d] = date.split('-').map((part) => Number(part));
  const targetYear = y! + years;
  const lastDayOfMonth = new Date(Date.UTC(targetYear, m!, 0)).getUTCDate();
  const day = Math.min(d!, lastDayOfMonth);
  const mm = String(m).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${String(targetYear).padStart(4, '0')}-${mm}-${dd}`;
}

/**
 * Locks the lot row FOR UPDATE and resolves the task, keeping the fixed lot-then-task lock order
 * every Story 8.1-8.3 applier uses (lockLotForDisposition is the template; this one deliberately
 * does NOT carry that function's disposition/gate/inspection pre-checks, because a retention sample
 * may be logged at any point after the task exists - see Task 3's ordering note).
 */
async function lockLotForRetention(
  lotId: string,
  taskId: string,
  client: PoolClient,
): Promise<{ lot_number: string; quality_hold_status: string; task: QcInspectionTaskRow }> {
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, quality_hold_status FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [lotId],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: lotId }, 404);
  }
  const task = await getQcInspectionTaskByLotId(lotId, client, true);
  if (!task) {
    reject(
      'QC_TASK_NOT_FOUND',
      'No QC inspection task exists for this lot',
      { lot_id: lotId },
      404,
    );
  }
  if (task.task_id !== taskId) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'The declared task_id is not the inspection task of this lot',
      { lot_id: lotId, declared_task_id: taskId, task_id: task.task_id },
      409,
    );
  }
  return {
    lot_number: lotResult.rows[0]!['lot_number'] as string,
    quality_hold_status: lotResult.rows[0]!['quality_hold_status'] as string,
    task,
  };
}

/**
 * Story 8.4 review: the released item drives BOTH the certificate kind (Binding Scope Decision 4)
 * and the retention window, so an unresolvable SKU must fail CLOSED. Coalescing a missing item row
 * to "not BIS-covered" would silently issue a CoA - shorter window, no CM/L number - for a product
 * that may well be BIS-covered, which is exactly the guarantee AC1 and AC3 make. Every other master
 * lookup in this seam refuses on a missing row; this one does too.
 */
async function resolveBisCoverage(
  sku: string,
  client: PoolClient,
  context: string,
): Promise<boolean> {
  const item = await getItemBySku(sku, client);
  if (!item) {
    reject(
      'ITEM_NOT_FOUND',
      `The item master row for this lot's SKU does not resolve, so BIS coverage cannot be determined for ${context}`,
      { sku },
      409,
    );
  }
  return item.bis_licence_required === true;
}

/** Story 8.4 (FR-Q-08, AC 4): logs the one retention sample that lets this lot be released. */
async function applyRetentionSampleLogged(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const lotId = p['lot_id'] as string;
  const retentionSampleId = p['retention_sample_id'] as string;
  const quantity = p['quantity'] as string;
  const uom = (p['uom'] as string).trim();
  const locationId = p['location_id'] as string;
  const loggedAt = p['logged_at'] as string;
  const actorId = envelope.metadata.actor.user_id;

  assertRetentionClockBounds(loggedAt, 'logged_at', QC_RETENTION_SAMPLE_LOGGED);

  const { lot_number: lotNumber, task } = await lockLotForRetention(lotId, taskId, client);
  // The sample is evidentiary, so it may be logged while the lot is on hold - only RELEASE is
  // gated on the hold axis. But the storage location must be real and must belong to the task's
  // site: this row is the only record telling an auditor where the physical evidence is.
  if (!(await locationExistsById(locationId, client))) {
    reject(
      'LOCATION_NOT_FOUND',
      'The retention-sample storage location does not resolve',
      { location_id: locationId },
      400,
    );
  }
  const retentionYears = resolveRetentionYears(
    await resolveBisCoverage(task.sku, client, QC_RETENTION_SAMPLE_LOGGED),
  );
  // Provisional only: the release record is the authority for the retention clock (AC1 ties
  // retention to release), and applyBatchReleaseRecorded re-stamps this value under the same lot
  // lock. Until then the sample carries its own log-anchored window so it is never unbounded.
  const expiresOn = addYearsToCalendarDate(toIstCalendarDate(new Date(loggedAt)), retentionYears);

  // uq_qc_retention_sample_lot is the one-per-lot backstop: a raced second log loses here as a
  // 23505 that the store's constraint chain resolves to 409 RETENTION_SAMPLE_EXISTS.
  await insertQcRetentionSample(
    {
      retention_sample_id: retentionSampleId,
      lot_id: lotId,
      task_id: taskId,
      quantity,
      uom,
      location_id: locationId,
      logged_by: actorId,
      logged_at: loggedAt,
      expires_on: expiresOn,
      source_event_id: eventId,
    },
    client,
  );

  p['expires_on'] = expiresOn;
  p['retention_years'] = retentionYears;
  p['logged_by'] = actorId;
  // The trimmed value is what the projection stores, so the event must carry it too - otherwise a
  // padded input leaves the stored event and its own projection disagreeing on the unit.
  p['uom'] = uom;
  p['lot_number'] = lotNumber;
  p['sku'] = task.sku;
  p['site_id'] = task.site_id;
}

/** Story 8.4 (FR-Q-07, AC 1, AC 3, AC 6 and AC 7): the batch release record and its CoA/CoC. */
async function applyBatchReleaseRecorded(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const taskId = p['task_id'] as string;
  const lotId = p['lot_id'] as string;
  const releaseId = p['release_id'] as string;
  const decidedAt = p['decided_at'] as string;
  const actorId = envelope.metadata.actor.user_id;

  assertRetentionClockBounds(decidedAt, 'decided_at', QC_BATCH_RELEASE_RECORDED);

  const {
    lot_number: lotNumber,
    quality_hold_status: qualityHoldStatus,
    task,
  } = await lockLotForRetention(lotId, taskId, client);

  // AC6 fail-closed, and the independent hold axis every sibling applier re-derives under this same
  // lock (lockLotForDisposition, applyNcrOutcomeRecorded, assertQcGateAllows). Without it a lot
  // placed on recall or scrap_pending hold AFTER its accept disposition would still be certified.
  if (qualityHoldStatus !== 'none') {
    reject(
      'LOT_ON_HOLD',
      'Lot is on quality hold and cannot be released',
      { lot_id: lotId, task_id: taskId, reason: 'manual_hold' },
      400,
    );
  }

  // Binding Scope Decision 1: release is eligible only on an already-decided accept or conditional
  // release. Re-derived under the lot lock, never trusted from the request.
  const disposition = await getQcLotDispositionByLotId(lotId, client);
  if (!disposition || !RELEASABLE_DISPOSITIONS.has(disposition.disposition)) {
    reject(
      'QC_RELEASE_NOT_ELIGIBLE',
      'A lot can only be released from an accept or conditional_release disposition',
      {
        lot_id: lotId,
        task_id: taskId,
        disposition: disposition?.disposition ?? null,
        gate_status: task.gate_status,
      },
      409,
    );
  }

  // AC6's second clause: "or whose gate has not reached that state". The disposition row and the
  // gate are separate axes and a corrupted projection can disagree; releasing is precisely what
  // lifts the conditional-release movement restriction (see assertQcGateAllows), so the gate is
  // re-derived here rather than merely reported in the error detail.
  if (task.gate_status !== 'accepted' && task.gate_status !== 'conditionally_released') {
    reject(
      'QC_RELEASE_NOT_ELIGIBLE',
      'The QC gate has not reached a releasable state for this lot',
      {
        lot_id: lotId,
        task_id: taskId,
        disposition: disposition.disposition,
        gate_status: task.gate_status,
      },
      409,
    );
  }

  // A conditional release is authorized by a deviation with an expiry. assertQcGateAllows refuses
  // movement on a lapsed deviation and documents that the restriction lasts "until its batch
  // release record exists" - so minting that record on a lapsed deviation would launder an expired
  // authorization into a permanent one.
  if (disposition.disposition === 'conditional_release') {
    const conditional = await getConditionalReleaseForLot(lotId, client);
    const expiresOn = conditional?.deviation?.expires_on ?? null;
    if (!expiresOn || expiresOn < gateBusinessDateOf(envelope)) {
      reject(
        'QC_RELEASE_NOT_ELIGIBLE',
        'The conditional-release deviation authorizing this lot has expired',
        {
          lot_id: lotId,
          task_id: taskId,
          disposition: disposition.disposition,
          deviation_expires_on: expiresOn,
        },
        409,
      );
    }
  }

  // Binding Scope Decisions 3 and 4: a BIS-covered product (item_master.bis_licence_required) gets
  // the CoC, which is where AC 3's CM/L or R-number is printed; everything else gets the CoA. This
  // is resolved BEFORE the retention-sample gate because, under the narrower scope, BIS coverage is
  // what decides whether a sample is required at all.
  const bisCovered = await resolveBisCoverage(task.sku, client, QC_BATCH_RELEASE_RECORDED);

  // Binding Scope Decision 6, as amended by Open Question 1: required for every released lot by
  // default, or only for BIS-covered products when the deployment narrows the scope. The sample
  // must also still be RETAINED - one already routed for disposal backs nothing, so a certificate
  // asserting a retained sample would be false.
  const sampleRequired = retentionSampleRequiredFor(bisCovered);
  const sample = await getQcRetentionSampleByLotId(lotId, client);
  if (sampleRequired) {
    if (!sample) {
      reject(
        'RETENTION_SAMPLE_REQUIRED',
        'A retention sample must be logged for this lot before it can be released',
        {
          lot_id: lotId,
          task_id: taskId,
          retention_sample_scope: config.quality.retentionSampleScope,
        },
        409,
      );
    }
    if (sample.status !== 'retained') {
      reject(
        'RETENTION_SAMPLE_REQUIRED',
        'The retention sample for this lot is no longer retained',
        { lot_id: lotId, task_id: taskId, retention_sample_status: sample.status },
        409,
      );
    }
  }

  const documentKind: QcDocumentKind = bisCovered ? 'coc' : 'coa';
  const retentionYears = resolveRetentionYears(bisCovered);
  const retentionExpiresOn = addYearsToCalendarDate(
    toIstCalendarDate(new Date(decidedAt)),
    retentionYears,
  );
  // Binding Scope Decision 2: null until Story 8.7's licence register lands; never blocks release.
  const bisLicenceNumber = bisCovered
    ? await resolveBisLicenceNumber(task.sku, task.site_id)
    : null;

  // uq_qc_batch_release_lot / uq_qc_batch_release_disposition backstop a second release exactly the
  // way uq_qc_lot_disposition_lot backstops a second disposition: a 23505 the store's constraint
  // chain resolves to 409 RELEASE_EXISTS with the existing release_id.
  await insertQcBatchRelease(
    {
      release_id: releaseId,
      lot_id: lotId,
      task_id: taskId,
      disposition_id: disposition.disposition_id,
      document_kind: documentKind,
      retention_years: retentionYears,
      retention_expires_on: retentionExpiresOn,
      bis_licence_number: bisLicenceNumber,
      released_by: actorId,
      released_at: decidedAt,
      source_event_id: eventId,
    },
    client,
  );

  // AC1 ties the retention window to RELEASE ("when it is released ... retained for a default 7
  // years"), so the release record is the single authority and the sample is re-stamped to match.
  // Before this, the sample expired on logged_at + N while the certificate claimed decided_at + N,
  // and since AC4 forces logged_at <= decided_at the physical evidence was always scheduled for
  // disposal BEFORE the certificate it backs left its own retention window.
  // Only when one exists: under the narrower scope a non-BIS lot may legitimately have none.
  if (sample) {
    await setQcRetentionSampleExpiry(sample.retention_sample_id, retentionExpiresOn, client);
  }

  p['disposition_id'] = disposition.disposition_id;
  p['retention_sample_id'] = sample?.retention_sample_id ?? null;
  p['document_kind'] = documentKind;
  p['retention_years'] = retentionYears;
  p['retention_expires_on'] = retentionExpiresOn;
  p['bis_licence_number'] = bisLicenceNumber;
  p['released_by'] = actorId;
  p['lot_number'] = lotNumber;
  p['sku'] = task.sku;
  p['site_id'] = task.site_id;
  p['quantity'] = disposition.quantity;
  p['disposition'] = disposition.disposition;

  // AD-17: release is a decision, so it announces itself in the same transaction.
  await emitNotificationInTransaction(
    {
      target: {
        role: config.quality.inspectionTaskNotificationRole,
        location_id: task.site_id,
      },
      event_type: 'qc_batch_release_recorded',
      status_verb: 'Released',
      object_type: 'qc_inspection_task',
      object_id: taskId,
      actor_label: `Lot ${lotNumber} (${task.sku})`,
      next_step: `The ${documentKind.toUpperCase()} is on record and retained until ${retentionExpiresOn}`,
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/**
 * Story 8.4 (FR-Q-08, AC 5): the recorded disposal that routes an expiring sample to
 * 'disposal_pending'. Emitted by the retention-expiry sweep under the system actor; there is no
 * write route.
 *
 * The UPDATE is guarded by `WHERE status = 'retained'`, so it can never double-transition a row.
 * A zero-row result is REFUSED with 409 RETENTION_SAMPLE_NOT_RETAINED rather than written back as
 * a success: the only caller that can reach that state is a forged direct POST, which must not be
 * able to claim a transition that never happened. This is a deliberate departure from Task 4's
 * "no-op" wording, confirmed at review; the sweep never hits it, because its candidate query is
 * guarded by the same predicate, and the sweep isolates each row so one refusal cannot abort the
 * batch.
 */
async function applyRetentionSampleDisposed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const retentionSampleId = p['retention_sample_id'] as string;
  const lotId = p['lot_id'] as string;

  // Lock the sample row before reading the values this applier writes back and cross-checks:
  // without FOR UPDATE the status read below is a check-then-act window and the 409 detail can
  // report a status that no longer holds by the time the guarded UPDATE runs.
  const sample = await getQcRetentionSampleById(retentionSampleId, client, true);
  if (!sample) {
    reject(
      'RETENTION_SAMPLE_NOT_FOUND',
      'The retention sample does not resolve',
      { retention_sample_id: retentionSampleId },
      404,
    );
  }
  if (sample.lot_id !== lotId) {
    reject(
      'QC_DERIVATION_MISMATCH',
      'The declared lot_id is not the lot of this retention sample',
      { retention_sample_id: retentionSampleId, declared_lot_id: lotId, lot_id: sample.lot_id },
      409,
    );
  }
  const moved = await markQcRetentionSampleDisposalPending(retentionSampleId, eventId, client);
  if (!moved) {
    reject(
      'RETENTION_SAMPLE_NOT_RETAINED',
      'The retention sample has already left the retained state',
      { retention_sample_id: retentionSampleId, status: sample.status },
      409,
    );
  }

  p['task_id'] = sample.task_id;
  p['lot_id'] = sample.lot_id;
  p['expires_on'] = sample.expires_on;
  p['status'] = 'disposal_pending';

  // AC5 is an ALERT, not merely a status column. Without this the sweep flipped a row and emitted
  // an event that nothing surfaced to a human, so the "30-day expiry alert" alerted nobody. The
  // task carries the site the QC role is scoped to.
  const task = await getQcInspectionTaskById(sample.task_id, client);
  if (task) {
    await emitNotificationInTransaction(
      {
        target: {
          role: config.quality.inspectionTaskNotificationRole,
          location_id: task.site_id,
        },
        event_type: 'qc_retention_sample_disposal_pending',
        status_verb: 'Due for disposal',
        object_type: 'qc_inspection_task',
        object_id: sample.task_id,
        actor_label: `Retention sample for lot ${task.lot_number} (${task.sku})`,
        next_step: `The retention window closes on ${sample.expires_on}; route the sample for physical disposal`,
        actor: envelope.metadata.actor,
        correlation_id: envelope.metadata.correlation_id,
        causation_id: eventId,
        occurred_at: envelope.metadata.occurred_at,
      },
      client,
    );
  }
}

export async function applyQualityProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const eventType = qualityEventType(envelope);
  if (eventType === null) return;
  if (await alreadyPersisted(envelope, client)) return;

  switch (eventType) {
    case INSPECTION_PLAN_CREATED:
      await applyInspectionPlanCreated(envelope, client, eventId);
      return;
    case INSPECTION_PLAN_APPROVED:
      await applyInspectionPlanApproved(envelope, client, eventId);
      return;
    case QC_COMPLETION_RECEIVED:
      await applyCompletionReceived(envelope, client, eventId);
      return;
    case QC_CONDITIONAL_RELEASE_RECORDED:
      await applyConditionalReleaseRecorded(envelope, client, eventId);
      return;
    case QC_SAMPLING_DETERMINED:
      await applySamplingDetermined(envelope, client, eventId);
      return;
    case QC_RESULT_RECORDED:
      await applyResultBatch(envelope, client, eventId, 'result');
      return;
    case QC_OBSERVATION_RECORDED:
      await applyResultBatch(envelope, client, eventId, 'observation');
      return;
    case QC_INSPECTION_COMPLETED:
      await applyInspectionCompleted(envelope, client, eventId);
      return;
    case QC_SAMPLING_STATE_ADJUSTED:
      await applySamplingStateAdjusted(envelope, client, eventId);
      return;
    case QC_LOT_DISPOSITIONED:
      await applyLotDispositioned(envelope, client, eventId);
      return;
    case QC_LOT_SPLIT_RECORDED:
      await applyLotSplitRecorded(envelope, client, eventId);
      return;
    case QC_NCR_OUTCOME_RECORDED:
      await applyNcrOutcomeRecorded(envelope, client, eventId);
      return;
    case QC_REWORK_REQUESTED:
      await applyReworkRequested(envelope, client, eventId);
      return;
    case QC_RETENTION_SAMPLE_LOGGED:
      await applyRetentionSampleLogged(envelope, client, eventId);
      return;
    case QC_BATCH_RELEASE_RECORDED:
      await applyBatchReleaseRecorded(envelope, client, eventId);
      return;
    case QC_RETENTION_SAMPLE_DISPOSED:
      await applyRetentionSampleDisposed(envelope, client, eventId);
      return;
    case QC_HOLD_PLACED:
      await applyHoldPlaced(envelope, client, eventId);
      return;
    case QC_HOLD_RELEASED:
      await applyHoldReleased(envelope, client, eventId);
      return;
    case QC_NCR_RAISED:
      await applyNcrRaised(envelope, client, eventId);
      return;
    case QC_CAPA_OPENED:
      await applyCapaOpened(envelope, client, eventId);
      return;
    case QC_CAPA_CLOSED:
      await applyCapaClosed(envelope, client, eventId);
      return;
    case QC_CAPA_LINKED:
      await applyCapaLinked(envelope, client, eventId);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// The transaction-aware QC-gate assertion (Task 6)
// ---------------------------------------------------------------------------

export type QcGateOperation =
  | 'allocation'
  | 'issue'
  | 'pick'
  | 'transfer'
  | 'production_issue'
  | 'replenishment'
  | 'maintenance_issue'
  | 'cross_dock'
  | 'dispatch_document'
  | 'dispatch';

/**
 * The only operation kinds a conditionally released lot may take part in, and only when the
 * deviation's scope names the destination (Binding Scope Decisions 5 and 6): an inter-location
 * transfer to the named location, or a production issue to the named process (order). Sales
 * allocation, picking, shipping documents and dispatch stay blocked until Story 8.4.
 */
const INTERNAL_MOVEMENT_OPERATIONS: ReadonlySet<QcGateOperation> = new Set([
  'transfer',
  'production_issue',
]);

export interface QcGateCheck {
  lot_id?: string | null;
  lot_number?: string | null;
  sku?: string | null;
  operation: QcGateOperation;
  scope_ref?: string | null;
  /** The trusted IST business date of the operation (toIstCalendarDate of the event instant). */
  business_date: string;
  client: PoolClient;
}

/**
 * Asserts the QC gate allows `operation` on a lot, or throws 400 LOT_ON_HOLD (the operational
 * code every consumer already handles). Lock order: lot row, then QC-gate row; stock rows are
 * taken by the caller's ledger helper afterwards. A lot with no inspection task is ungoverned
 * (raw material, supplier stock under FR-P-06) and passes; a qc_hold gate always blocks; a
 * conditionally released gate permits only an unexpired, in-scope internal movement while the
 * independent manual or recall hold (lot_master.quality_hold_status) is clear.
 */
export async function assertQcGateAllows(check: QcGateCheck): Promise<void> {
  const { client } = check;
  let lotResult;
  // The platform names a lot by its UUID in some flows (transfer requests, picking, dispatch) and
  // by its lot NUMBER in others (the Epic 2 ledger, production staging, spares); either is
  // accepted here and resolved to the one lot_master row (the UUID-versus-lot-number semantics of
  // src/compliance/lot-serial-validation.ts).
  const ref = check.lot_id ?? check.lot_number ?? null;
  if (ref && UUID_REGEX.test(ref)) {
    lotResult = await client.query(
      `SELECT lot_id, lot_number, sku, quality_hold_status FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
      [ref],
    );
  } else if (ref) {
    lotResult = await client.query(
      `SELECT lot_id, lot_number, sku, quality_hold_status FROM lot_master
        WHERE lot_number = $1 AND ($2::text IS NULL OR sku = $2) FOR UPDATE`,
      [ref, check.sku ?? null],
    );
  } else {
    return;
  }
  if (lotResult.rows.length === 0) {
    throw new AppError(400, 'LOT_NOT_FOUND', 'The referenced lot does not resolve', {
      lot_id: check.lot_id ?? null,
      lot_number: check.lot_number ?? null,
      sku: check.sku ?? null,
      operation: check.operation,
    });
  }
  if (lotResult.rows.length > 1) {
    throw new AppError(
      400,
      'LOT_NOT_FOUND',
      'The lot reference resolves to more than one lot and is ambiguous',
      {
        lot_id: check.lot_id ?? null,
        lot_number: check.lot_number ?? null,
        sku: check.sku ?? null,
        operation: check.operation,
      },
    );
  }
  const lot = lotResult.rows[0]!;
  const lotId = lot['lot_id'] as string;
  const task = await getQcInspectionTaskByLotId(lotId, client, true);
  if (!task) return;

  const base = {
    lot_id: lotId,
    lot_number: lot['lot_number'],
    sku: lot['sku'],
    qc_gate_status: task.gate_status,
    operation: check.operation,
  };
  if (task.gate_status === 'qc_hold') {
    throw new AppError(400, 'LOT_ON_HOLD', 'Lot is in QC Hold pending inspection', {
      ...base,
      reason: 'qc_hold',
    });
  }
  // Story 8.3 (Binding Scope Decision 4): the three terminal gate states. They are handled BEFORE
  // the conditional-release logic below so a new gate state can never fall through into the
  // deviation checks, which would read a non-existent deviation as an authorization.
  if (task.gate_status === 'rejected') {
    throw new AppError(400, 'LOT_ON_HOLD', 'Lot was rejected at the QC gate', {
      ...base,
      reason: 'rejected',
    });
  }
  if (task.gate_status === 'split') {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'Lot was split at the QC gate; consume its child lots instead',
      { ...base, reason: 'split' },
    );
  }
  if (task.gate_status === 'accepted') {
    // An accepted lot has left the gate. The INDEPENDENT manual or recall hold still blocks it -
    // the two axes are separate and both must be clear.
    if (lot['quality_hold_status'] !== 'none') {
      throw new AppError(400, 'LOT_ON_HOLD', 'Lot is on quality hold', {
        ...base,
        reason: 'manual_hold',
      });
    }
    return;
  }
  // conditionally_released
  if (lot['quality_hold_status'] !== 'none') {
    throw new AppError(400, 'LOT_ON_HOLD', 'Lot is on quality hold', {
      ...base,
      reason: 'manual_hold',
    });
  }
  if (!INTERNAL_MOVEMENT_OPERATIONS.has(check.operation)) {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'A conditionally released lot is limited to authorized internal movement until its batch release record exists',
      { ...base, reason: 'conditional_release_scope' },
    );
  }
  const active = await getConditionalReleaseForLot(lotId, client);
  if (!active) {
    throw new AppError(400, 'LOT_ON_HOLD', 'No active deviation authorizes this movement', {
      ...base,
      reason: 'deviation_missing',
    });
  }
  const { deviation } = active;
  if (deviation.scope_kind !== 'internal_movement') {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'The deviation scope is not operationally usable until the Story 8.4 batch release record exists',
      { ...base, reason: 'deviation_scope_not_activated', scope_kind: deviation.scope_kind },
    );
  }
  if (!check.scope_ref || deviation.scope_ref !== check.scope_ref) {
    throw new AppError(
      400,
      'LOT_ON_HOLD',
      'The movement destination is outside the deviation scope',
      {
        ...base,
        reason: 'deviation_scope_mismatch',
        authorized_scope_ref: deviation.scope_ref,
        requested_scope_ref: check.scope_ref ?? null,
      },
    );
  }
  // "Unexpired" is strict: the deviation is usable on business dates BEFORE expires_on.
  if (!(check.business_date < deviation.expires_on)) {
    throw new AppError(400, 'LOT_ON_HOLD', 'The conditional-release deviation has expired', {
      ...base,
      reason: 'deviation_expired',
      expires_on: deviation.expires_on,
      business_date: check.business_date,
    });
  }
}

/**
 * The IST business date of an event's occurred_at instant, for gate assertions. occurred_at is
 * client-supplied (edge devices backdate events by design), so the conditional-release expiry
 * comparison inherits that trust: an authorized actor who can post a transfer or production event
 * could backdate occurred_at past an already-expired deviation. Accepted per review decision -
 * the expiry control bounds authorized movement, not an external attacker.
 */
export function gateBusinessDateOf(envelope: Pick<EventEnvelope, 'metadata'>): string {
  const instant = new Date(envelope.metadata.occurred_at);
  return Number.isNaN(instant.getTime())
    ? toIstCalendarDate(new Date())
    : toIstCalendarDate(instant);
}

// ---------------------------------------------------------------------------
// 23505 duplicate resolvers (the race path returns the SAME detail as the sequential path)
// ---------------------------------------------------------------------------

export async function resolveInspectionPlanGrainDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attempted: Record<string, unknown> = {
    plan_id: isUuid(payload['plan_id']) ? payload['plan_id'] : null,
  };
  if (
    isUuid(payload['item_id']) &&
    isUuid(payload['bom_revision_id']) &&
    typeof payload['scope'] === 'string'
  ) {
    const existing = await getInspectionPlanByGrain({
      item_id: payload['item_id'],
      bom_revision_id: payload['bom_revision_id'],
      scope: payload['scope'] as InspectionPlanScope,
      source_order_type: (payload['source_order_type'] as 'job_work_order' | null) ?? null,
      source_order_ref: (payload['source_order_ref'] as string | null) ?? null,
    });
    if (existing) return { ...attempted, existing_plan_id: existing.plan_id };
  }
  return attempted;
}

export async function resolveInspectionPlanEffectivityDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attempted: Record<string, unknown> = {
    plan_id: isUuid(payload['plan_id']) ? payload['plan_id'] : null,
    effective_from:
      typeof payload['effective_from'] === 'string' ? payload['effective_from'] : null,
  };
  if (isUuid(payload['plan_id']) && typeof payload['effective_from'] === 'string') {
    const existing = await getInspectionPlanVersionByEffectiveFrom(
      payload['plan_id'],
      payload['effective_from'],
    );
    if (existing) return { ...attempted, existing_plan_version_id: existing.plan_version_id };
  }
  return attempted;
}

export async function resolveQcCompletionDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attempted: Record<string, unknown> = {
    lot_id: isUuid(payload['lot_id']) ? payload['lot_id'] : null,
    source_completion_type:
      typeof payload['source_completion_type'] === 'string'
        ? payload['source_completion_type']
        : null,
    source_completion_id: isUuid(payload['source_completion_id'])
      ? payload['source_completion_id']
      : null,
  };
  if (isUuid(payload['lot_id'])) {
    const existing = await getQcInspectionTaskByLotId(payload['lot_id']);
    if (existing) return { ...attempted, existing_task_id: existing.task_id };
  }
  if (
    typeof payload['source_completion_type'] === 'string' &&
    isUuid(payload['source_completion_id'])
  ) {
    const existing = await getQcInspectionTaskBySource(
      payload['source_completion_type'],
      payload['source_completion_id'],
    );
    if (existing) return { ...attempted, existing_task_id: existing.task_id };
  }
  return attempted;
}

export async function resolveQcDispositionDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attempted: Record<string, unknown> = {
    lot_id: isUuid(payload['lot_id']) ? payload['lot_id'] : null,
  };
  if (isUuid(payload['lot_id'])) {
    const existing = await getQcLotDispositionByLotId(payload['lot_id']);
    if (existing) return { ...attempted, existing_disposition_id: existing.disposition_id };
  }
  return attempted;
}

/**
 * Story 8.4 (AC 7): the uq_qc_batch_release_lot / uq_qc_batch_release_disposition race path names
 * the release that won, exactly as the sequential RELEASE_EXISTS pre-check would.
 */
export async function resolveQcReleaseDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attempted: Record<string, unknown> = {
    lot_id: isUuid(payload['lot_id']) ? payload['lot_id'] : null,
  };
  if (isUuid(payload['lot_id'])) {
    const existing = await getQcBatchReleaseByLotId(payload['lot_id']);
    if (existing) return { ...attempted, existing_release_id: existing.release_id };
  }
  return attempted;
}

/** Story 8.4 (AC 4): the uq_qc_retention_sample_lot race path names the sample that won. */
export async function resolveQcRetentionSampleDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attempted: Record<string, unknown> = {
    lot_id: isUuid(payload['lot_id']) ? payload['lot_id'] : null,
  };
  if (isUuid(payload['lot_id'])) {
    const existing = await getQcRetentionSampleByLotId(payload['lot_id']);
    if (existing) {
      return { ...attempted, existing_retention_sample_id: existing.retention_sample_id };
    }
  }
  return attempted;
}

/** Story 8.2: uq_qc_sampling_plan_task race path returns the same detail as the sequential pre-check. */
export async function resolveQcSamplingDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attempted: Record<string, unknown> = {
    task_id: isUuid(payload['task_id']) ? payload['task_id'] : null,
    sampling_id: isUuid(payload['sampling_id']) ? payload['sampling_id'] : null,
  };
  if (isUuid(payload['task_id'])) {
    const existing = await getQcSamplingPlanByTaskId(payload['task_id']);
    if (existing) return { ...attempted, existing_sampling_id: existing.sampling_id };
  }
  return attempted;
}

/** Story 8.2: uq_qc_inspection_result_unit race path names the task and characteristic. */
export function resolveQcResultDuplicateConflict(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const readings = Array.isArray(payload['readings'])
    ? (payload['readings'] as Array<Record<string, unknown>>)
    : [];
  return {
    task_id: isUuid(payload['task_id']) ? payload['task_id'] : null,
    characteristic_id: isUuid(payload['characteristic_id']) ? payload['characteristic_id'] : null,
    sample_unit_nos: readings
      .map((r) => r['sample_unit_no'])
      .filter((u): u is number => typeof u === 'number'),
  };
}

// ---------------------------------------------------------------------------
// Story 8.5: governed quality holds, hold-sourced NCRs and CAPA (FR-Q-09, FR-Q-10)
// ---------------------------------------------------------------------------

/** Binding Scope Decision 14: the hold-sourced terminal outcome. Moves no stock. */
export const NCR_HOLD_TERMINAL_OUTCOME = 'closed_with_capa';

/**
 * Binding Scope Decision 10: the fail-closed defect-code gate, mirroring the Story 7.8
 * closure-code route - the allowed list is returned in the error detail.
 */
function assertKnownDefectCode(value: unknown, context: string): void {
  if (typeof value !== 'string' || !config.qc.defectCodes.includes(value)) {
    reject(
      'DEFECT_CODE_UNKNOWN',
      `defect_code is not in the configured QC defect-code catalogue on ${context}`,
      { defect_code: value ?? null, allowed: config.qc.defectCodes },
      422,
    );
  }
}

/**
 * Binding Scope Decision 12: the enterprise-wide repeat-defect predicate. Bounds arrive as
 * PARAMETERS, never module constants, so a unit test exercises real boundaries (the Story 8.4
 * tautological-config lesson). The window is the `windowDays` IST calendar days STRICTLY
 * preceding `businessDate` (a predecessor exactly `windowDays` old is outside; one day younger is
 * inside; the new NCR is never its own predecessor).
 */
export async function isRepeatDefect(
  sku: string,
  defectCode: string,
  businessDate: string,
  threshold: number,
  windowDays: number,
  client?: PoolClient,
): Promise<boolean> {
  const prior = await countMatchingNcrsInWindow(sku, defectCode, businessDate, windowDays, client);
  return prior >= threshold;
}

function assertHoldPlacedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['hold_id'])) reject('INVALID_PAYLOAD', 'hold_id must be a UUID');
  if (envelope.stream_id !== p['hold_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the hold_id for qc.hold_placed', {
      stream_id: envelope.stream_id,
      payload_hold_id: p['hold_id'],
    });
  }
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  if (!isBoundedText(p['hold_reason'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `hold_reason must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (p['defect_code'] !== undefined && p['defect_code'] !== null) {
    assertKnownDefectCode(p['defect_code'], QC_HOLD_PLACED);
  }
  rejectDeclaredDerived(
    p,
    ['placed_at', 'site_id', 'sku', 'lot_number', 'status', 'placed_by'],
    QC_HOLD_PLACED,
  );
}

function assertHoldReleasedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['hold_id'])) reject('INVALID_PAYLOAD', 'hold_id must be a UUID');
  if (envelope.stream_id !== p['hold_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the hold_id for qc.hold_released', {
      stream_id: envelope.stream_id,
      payload_hold_id: p['hold_id'],
    });
  }
  if (!isBoundedText(p['release_reason'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `release_reason must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  rejectDeclaredDerived(
    p,
    ['released_at', 'site_id', 'sku', 'lot_number', 'status', 'lot_id', 'released_by'],
    QC_HOLD_RELEASED,
  );
}

function assertNcrRaisedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['ncr_id'])) reject('INVALID_PAYLOAD', 'ncr_id must be a UUID');
  if (envelope.stream_id !== p['ncr_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the ncr_id for qc.ncr_raised', {
      stream_id: envelope.stream_id,
      payload_ncr_id: p['ncr_id'],
    });
  }
  if (!isUuid(p['lot_id'])) reject('INVALID_PAYLOAD', 'lot_id must be a UUID');
  assertKnownDefectCode(p['defect_code'], QC_NCR_RAISED);
  if (!isBoundedText(p['justification'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `justification must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  if (!isPositiveQuantity(p['quantity'])) {
    reject('INVALID_PAYLOAD', 'quantity must be a positive decimal string');
  }
  if (p['capa_id'] !== undefined && p['capa_id'] !== null && !isUuid(p['capa_id'])) {
    reject('INVALID_PAYLOAD', 'capa_id must be a UUID when supplied');
  }
  rejectDeclaredDerived(
    p,
    ['raised_at', 'site_id', 'sku', 'lot_number', 'hold_id', 'capa_mandatory', 'raised_by'],
    QC_NCR_RAISED,
  );
}

function assertCapaOpenedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['capa_id'])) reject('INVALID_PAYLOAD', 'capa_id must be a UUID');
  if (envelope.stream_id !== p['capa_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the capa_id for qc.capa_opened', {
      stream_id: envelope.stream_id,
      payload_capa_id: p['capa_id'],
    });
  }
  if (!isBoundedText(p['sku'], 128)) {
    reject('INVALID_PAYLOAD', 'sku must be a non-empty string of at most 128 characters');
  }
  assertKnownDefectCode(p['defect_code'], QC_CAPA_OPENED);
  if (!isBoundedText(p['title'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `title must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  for (const field of ['root_cause', 'corrective_action', 'preventive_action']) {
    if (p[field] !== undefined && p[field] !== null && !isBoundedText(p[field], MAX_TEXT_2000)) {
      reject(
        'INVALID_PAYLOAD',
        `${field} must be null or a non-empty string of at most ${MAX_TEXT_2000} characters`,
      );
    }
  }
  if (!isUuid(p['owner_user_id'])) reject('INVALID_PAYLOAD', 'owner_user_id must be a UUID');
  if (typeof p['due_on'] !== 'string' || !isValidCalendarDate(p['due_on'])) {
    reject('INVALID_PAYLOAD', 'due_on must be a YYYY-MM-DD calendar date');
  }
  rejectDeclaredDerived(p, ['capa_number', 'opened_by', 'opened_at', 'status'], QC_CAPA_OPENED);
}

function assertCapaClosedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['capa_id'])) reject('INVALID_PAYLOAD', 'capa_id must be a UUID');
  if (envelope.stream_id !== p['capa_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the capa_id for qc.capa_closed', {
      stream_id: envelope.stream_id,
      payload_capa_id: p['capa_id'],
    });
  }
  if (!isBoundedText(p['closure_evidence'], MAX_TEXT_2000)) {
    reject(
      'INVALID_PAYLOAD',
      `closure_evidence must be a non-empty string of at most ${MAX_TEXT_2000} characters`,
    );
  }
  rejectDeclaredDerived(p, ['closed_by', 'closed_at', 'status'], QC_CAPA_CLOSED);
}

function assertCapaLinkedShape(envelope: EventEnvelope): void {
  const p = envelope.payload as Record<string, unknown>;
  if (!isUuid(p['ncr_id'])) reject('INVALID_PAYLOAD', 'ncr_id must be a UUID');
  if (envelope.stream_id !== p['ncr_id']) {
    reject('INVALID_PAYLOAD', 'stream_id must be the ncr_id for qc.capa_linked', {
      stream_id: envelope.stream_id,
      payload_ncr_id: p['ncr_id'],
    });
  }
  if (!isUuid(p['capa_id'])) reject('INVALID_PAYLOAD', 'capa_id must be a UUID');
  rejectDeclaredDerived(p, ['linked_by', 'linked_at', 'sku', 'defect_code'], QC_CAPA_LINKED);
}

/**
 * AC 1: places the governed hold. Locks the LOT row first, then the QC task row (the lot-then-task
 * order every Story 8.1-8.4 applier uses - the other order deadlocks against them), inserts the
 * qc_quality_hold record, sets the ONE enforcement flag (Binding Scope Decision 1) in the same
 * transaction, appends the lot_trace entry and emits the AD-17 transactional notification.
 *
 * Flag-reason subtlety: when the lot is ALREADY flag-held (a Story 2.3 ad hoc hold, or the Story
 * 8.3 scrap_pending parking), the existing reason is PRESERVED rather than overwritten - the
 * governed record still exists and still blocks, but releasing it must not be able to lift a
 * containment this hold did not create (the hold-bypass class the 8.3/8.4 reviews each found).
 */
async function applyHoldPlaced(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const holdId = p['hold_id'] as string;
  const lotId = p['lot_id'] as string;
  const holdReason = (p['hold_reason'] as string).trim();
  const defectCode = (p['defect_code'] as string | null | undefined) ?? null;
  const actorId = envelope.metadata.actor.user_id;
  const placedAt = envelope.metadata.occurred_at;

  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku, quality_hold_status, quality_hold_reason
       FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [lotId],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: lotId }, 404);
  }
  const lot = lotResult.rows[0]!;
  const lotNumber = lot['lot_number'] as string;
  const sku = lot['sku'] as string;
  // Lot-then-task lock order (may be null: an ungoverned lot is still holdable).
  const task = await getQcInspectionTaskByLotId(lotId, client, true);

  const existing = await getOpenQcQualityHoldByLotId(lotId, client);
  if (existing) {
    reject(
      'HOLD_EXISTS',
      'An open quality hold already exists for this lot',
      { lot_id: lotId, existing_hold_id: existing.hold_id },
      409,
    );
  }

  const siteId = task?.site_id ?? envelope.metadata.actor.location_id;
  await insertQcQualityHold(
    {
      hold_id: holdId,
      lot_id: lotId,
      lot_number: lotNumber,
      sku,
      site_id: siteId,
      hold_reason: holdReason,
      defect_code: defectCode,
      placed_by: actorId,
      placed_at: placedAt,
      source_event_id: eventId,
    },
    client,
  );

  // Set the ONE enforcement flag, preserving a pre-existing reason (see the doc comment above).
  if (lot['quality_hold_status'] !== 'held') {
    const flagged = await placeQualityHold(lotNumber, sku, holdReason, client);
    if (!flagged) {
      reject('LOT_NOT_FOUND', 'The lot could not be flag-held', { lot_id: lotId }, 404);
    }
  }

  const item = await getItemBySku(sku, client);
  await appendTraceEntry(
    {
      lot_id: lotId,
      event_id: eventId,
      event_type: QC_HOLD_PLACED,
      sku,
      location_id: null,
      location_code: null,
      quantity_change: '0',
      business_stream: item?.business_stream ?? 'production',
      timestamp: placedAt,
    },
    client,
  );

  p['placed_at'] = placedAt;
  p['site_id'] = siteId;
  p['sku'] = sku;
  p['lot_number'] = lotNumber;
  p['status'] = 'open';
  p['placed_by'] = actorId;

  // AD-17: a hold is a decision.
  await emitNotificationInTransaction(
    {
      target: { role: config.quality.inspectionTaskNotificationRole, location_id: siteId },
      event_type: 'qc_hold_placed',
      status_verb: 'Quality hold placed',
      object_type: 'qc_quality_hold',
      object_id: holdId,
      actor_label: `Lot ${lotNumber} (${sku})`,
      next_step:
        'All stock in this lot is blocked on every node; run the where-used/where-shipped trace',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/**
 * Binding Scope Decision 4: release is a distinct, reason-carrying, SEGREGATED decision - the
 * releasing actor must not be the placer (SOD_VIOLATION, no config escape hatch). The guarded
 * UPDATE makes a concurrent second release a zero-row update (HOLD_ALREADY_RELEASED). The
 * enforcement flag clears ONLY when no other open governed hold exists AND the flag was not set by
 * an independent containment this hold does not own (scrap_pending in particular - lifting it here
 * would reintroduce the hold-bypass class).
 */
async function applyHoldReleased(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const holdId = p['hold_id'] as string;
  const releaseReason = (p['release_reason'] as string).trim();
  const actorId = envelope.metadata.actor.user_id;
  const releasedAt = envelope.metadata.occurred_at;

  // Read WITHOUT a lock to learn the lot (the Story 8.2 pattern), then lock lot-first.
  const peek = await getQcQualityHoldById(holdId, client);
  if (!peek) {
    reject('HOLD_NOT_FOUND', 'The named hold does not resolve', { hold_id: holdId }, 404);
  }
  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku, quality_hold_status, quality_hold_reason
       FROM lot_master WHERE lot_id = $1 FOR UPDATE`,
    [peek.lot_id],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: peek.lot_id }, 404);
  }
  const lot = lotResult.rows[0]!;
  const hold = await getQcQualityHoldById(holdId, client, true);
  if (!hold) {
    reject('HOLD_NOT_FOUND', 'The named hold does not resolve', { hold_id: holdId }, 404);
  }
  if (hold.status !== 'open') {
    reject(
      'HOLD_ALREADY_RELEASED',
      'The hold is no longer open',
      { hold_id: holdId, status: hold.status },
      409,
    );
  }
  if (hold.placed_by === actorId) {
    reject(
      'SOD_VIOLATION',
      'The actor who placed a hold cannot release it',
      { hold_id: holdId, placed_by: hold.placed_by },
      409,
    );
  }

  const released = await releaseQcQualityHold(
    {
      hold_id: holdId,
      released_by: actorId,
      released_at: releasedAt,
      release_reason: releaseReason,
      release_event_id: eventId,
    },
    client,
  );
  if (!released) {
    reject('HOLD_ALREADY_RELEASED', 'The hold is no longer open', { hold_id: holdId }, 409);
  }

  const otherOpen = await otherOpenQcQualityHoldExists(hold.lot_id, holdId, client);
  const thisHoldSetTheFlag = lot['quality_hold_reason'] === hold.hold_reason;
  if (!otherOpen && thisHoldSetTheFlag) {
    await clearQualityHold(hold.lot_number, hold.sku, client);
  }

  const item = await getItemBySku(hold.sku, client);
  await appendTraceEntry(
    {
      lot_id: hold.lot_id,
      event_id: eventId,
      event_type: QC_HOLD_RELEASED,
      sku: hold.sku,
      location_id: null,
      location_code: null,
      quantity_change: '0',
      business_stream: item?.business_stream ?? 'production',
      timestamp: releasedAt,
    },
    client,
  );

  p['released_at'] = releasedAt;
  p['site_id'] = hold.site_id;
  p['sku'] = hold.sku;
  p['lot_number'] = hold.lot_number;
  p['status'] = 'released';
  p['lot_id'] = hold.lot_id;
  p['released_by'] = actorId;

  // AD-17: a release is a decision.
  await emitNotificationInTransaction(
    {
      target: { role: config.quality.inspectionTaskNotificationRole, location_id: hold.site_id },
      event_type: 'qc_hold_released',
      status_verb: 'Quality hold released',
      object_type: 'qc_quality_hold',
      object_id: holdId,
      actor_label: `Lot ${hold.lot_number} (${hold.sku})`,
      next_step:
        otherOpen || !thisHoldSetTheFlag
          ? 'The lot remains blocked by another open hold'
          : 'The lot is no longer blocked',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/**
 * AC 3: the HOLD-SOURCED NCR (Binding Scope Decision 9). Requires a held or defective lot: an open
 * governed hold OR lot_master.quality_hold_status = 'held', re-derived under the lot lock. Never
 * touches applyLotDispositioned's creation path. capa_mandatory is computed here (Decision 12) and
 * ENFORCED at close (Decision 13).
 */
async function applyNcrRaised(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const ncrId = p['ncr_id'] as string;
  const lotId = p['lot_id'] as string;
  const defectCode = p['defect_code'] as string;
  const capaId = (p['capa_id'] as string | null | undefined) ?? null;
  const actorId = envelope.metadata.actor.user_id;
  const raisedAt = envelope.metadata.occurred_at;

  const lotResult = await client.query(
    `SELECT lot_id, lot_number, sku, quality_hold_status FROM lot_master
      WHERE lot_id = $1 FOR UPDATE`,
    [lotId],
  );
  if (lotResult.rows.length === 0) {
    reject('LOT_NOT_FOUND', 'The lot does not resolve', { lot_id: lotId }, 404);
  }
  const lot = lotResult.rows[0]!;
  const task = await getQcInspectionTaskByLotId(lotId, client, true);
  const openHold = await getOpenQcQualityHoldByLotId(lotId, client);
  if (!openHold && lot['quality_hold_status'] !== 'held') {
    reject(
      'HOLD_NOT_FOUND',
      'A hold-sourced NCR requires a held or defective lot: no open hold resolves and the lot is not flag-held',
      { lot_id: lotId, quality_hold_status: lot['quality_hold_status'] },
      404,
    );
  }
  if (capaId !== null) {
    const capa = await getQcCapaById(capaId, client);
    if (!capa) {
      reject('CAPA_NOT_FOUND', 'The named CAPA does not resolve', { capa_id: capaId }, 404);
    }
    if (capa.status !== 'open') {
      reject(
        'CAPA_NOT_OPEN',
        'The named CAPA is not open',
        { capa_id: capaId, status: capa.status },
        409,
      );
    }
  }

  const sku = lot['sku'] as string;
  const businessDate = toIstCalendarDate(new Date(raisedAt));
  const capaMandatory = await isRepeatDefect(
    sku,
    defectCode,
    businessDate,
    config.qc.repeatDefectThreshold,
    config.qc.repeatDefectWindowDays,
    client,
  );
  const siteId = task?.site_id ?? openHold?.site_id ?? envelope.metadata.actor.location_id;
  await insertHoldSourcedQcNcr(
    {
      ncr_id: ncrId,
      lot_id: lotId,
      lot_number: lot['lot_number'] as string,
      site_id: siteId,
      sku,
      quantity: p['quantity'] as string,
      justification: (p['justification'] as string).trim(),
      raised_by: actorId,
      raised_at: raisedAt,
      source_event_id: eventId,
      hold_id: openHold?.hold_id ?? null,
      defect_code: defectCode,
      capa_id: capaId,
      capa_mandatory: capaMandatory,
    },
    client,
  );

  p['raised_at'] = raisedAt;
  p['site_id'] = siteId;
  p['sku'] = sku;
  p['lot_number'] = lot['lot_number'];
  p['hold_id'] = openHold?.hold_id ?? null;
  p['capa_mandatory'] = capaMandatory;
  p['raised_by'] = actorId;
}

/** Binding Scope Decision 11: capa_number is minted server-side; 409 CAPA_EXISTS on collision. */
async function applyCapaOpened(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const capaId = p['capa_id'] as string;
  const actorId = envelope.metadata.actor.user_id;
  const openedAt = envelope.metadata.occurred_at;
  const istYear = Number(toIstCalendarDate(new Date(openedAt)).slice(0, 4));
  const capaNumber = await allocateQcCapaNumber(istYear, client);

  await insertQcCapa(
    {
      capa_id: capaId,
      capa_number: capaNumber,
      sku: (p['sku'] as string).trim(),
      defect_code: p['defect_code'] as string,
      title: (p['title'] as string).trim(),
      root_cause: (p['root_cause'] as string | null | undefined) ?? null,
      corrective_action: (p['corrective_action'] as string | null | undefined) ?? null,
      preventive_action: (p['preventive_action'] as string | null | undefined) ?? null,
      owner_user_id: p['owner_user_id'] as string,
      due_on: p['due_on'] as string,
      opened_by: actorId,
      opened_at: openedAt,
      source_event_id: eventId,
    },
    client,
  );

  p['capa_number'] = capaNumber;
  p['opened_by'] = actorId;
  p['opened_at'] = openedAt;
  p['status'] = 'open';
}

/** Closure requires evidence; the guarded UPDATE makes a second close CAPA_NOT_OPEN. */
async function applyCapaClosed(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const capaId = p['capa_id'] as string;
  const actorId = envelope.metadata.actor.user_id;
  const closedAt = envelope.metadata.occurred_at;

  const capa = await getQcCapaById(capaId, client, true);
  if (!capa) {
    reject('CAPA_NOT_FOUND', 'The named CAPA does not resolve', { capa_id: capaId }, 404);
  }
  if (capa.status !== 'open') {
    reject('CAPA_NOT_OPEN', 'The CAPA is not open', { capa_id: capaId, status: capa.status }, 409);
  }
  const closed = await closeQcCapa(
    {
      capa_id: capaId,
      closed_by: actorId,
      closed_at: closedAt,
      closure_evidence: (p['closure_evidence'] as string).trim(),
      close_event_id: eventId,
    },
    client,
  );
  if (!closed) {
    reject('CAPA_NOT_OPEN', 'The CAPA is not open', { capa_id: capaId }, 409);
  }

  p['closed_by'] = actorId;
  p['closed_at'] = closedAt;
  p['status'] = 'closed';

  // AD-17: a CAPA closure is a decision. Enterprise-scoped record, so no location filter.
  await emitNotificationInTransaction(
    {
      target: { role: config.quality.inspectionTaskNotificationRole, location_id: null },
      event_type: 'qc_capa_closed',
      status_verb: 'CAPA closed',
      object_type: 'qc_capa',
      object_id: capaId,
      actor_label: `${capa.capa_number} (${capa.sku}, ${capa.defect_code})`,
      next_step: 'Linked NCRs can now be closed with closed_with_capa',
      actor: envelope.metadata.actor,
      correlation_id: envelope.metadata.correlation_id,
      causation_id: eventId,
      occurred_at: envelope.metadata.occurred_at,
    },
    client,
  );
}

/** AC 4: links an OPEN CAPA to an open NCR exactly once (CAPA_ALREADY_LINKED on the second). */
async function applyCapaLinked(
  envelope: EventEnvelope,
  client: PoolClient,
  _eventId: string,
): Promise<void> {
  const p = envelope.payload as Record<string, unknown>;
  const ncrId = p['ncr_id'] as string;
  const capaId = p['capa_id'] as string;
  const actorId = envelope.metadata.actor.user_id;

  // Read WITHOUT a lock to learn the lot, then the standard lot-first lock prefix.
  const peek = await getQcNcrById(ncrId, client);
  if (!peek) {
    reject('NCR_NOT_FOUND', 'No non-conformance report resolves', { ncr_id: ncrId }, 404);
  }
  await client.query(`SELECT lot_id FROM lot_master WHERE lot_id = $1 FOR UPDATE`, [peek.lot_id]);
  const ncr = await getQcNcrById(ncrId, client, true);
  if (!ncr) {
    reject('NCR_NOT_FOUND', 'No non-conformance report resolves', { ncr_id: ncrId }, 404);
  }
  if (ncr.outcome !== null) {
    reject(
      'NCR_OUTCOME_EXISTS',
      'The NCR is already closed and cannot take a CAPA link',
      { ncr_id: ncrId, outcome: ncr.outcome },
      409,
    );
  }
  const capa = await getQcCapaById(capaId, client, true);
  if (!capa) {
    reject('CAPA_NOT_FOUND', 'The named CAPA does not resolve', { capa_id: capaId }, 404);
  }
  if (capa.status !== 'open') {
    reject(
      'CAPA_NOT_OPEN',
      'The named CAPA is not open',
      { capa_id: capaId, status: capa.status },
      409,
    );
  }
  const linked = await linkCapaToNcr(ncrId, capaId, client);
  if (!linked) {
    reject(
      'CAPA_ALREADY_LINKED',
      'The NCR already carries a CAPA',
      { ncr_id: ncrId, existing_capa_id: ncr.capa_id },
      409,
    );
  }

  p['linked_by'] = actorId;
  p['linked_at'] = envelope.metadata.occurred_at;
  p['sku'] = ncr.sku;
  p['defect_code'] = ncr.defect_code;
}

/** 23505 duplicate resolver: the race path returns the SAME detail as the sequential HOLD_EXISTS. */
export async function resolveQcHoldDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const lotId = isUuid(payload['lot_id']) ? payload['lot_id'] : null;
  const existing = lotId ? await getOpenQcQualityHoldByLotId(lotId) : null;
  return { lot_id: lotId, existing_hold_id: existing?.hold_id ?? null };
}

/** 23505 duplicate resolver for the minted-CAPA-number collision (CAPA_EXISTS). */
export async function resolveQcCapaDuplicateConflict(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return { capa_id: isUuid(payload['capa_id']) ? payload['capa_id'] : null };
}

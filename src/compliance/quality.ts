import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { config } from '../config/index.js';
import { isValidCalendarDate, toIstCalendarDate } from '../lib/business-days.js';
import { emitNotificationInTransaction } from '../notify/emit.js';
import { getItemById } from '../read/projections/item_master.js';
import { getBomById, getBomRevisionById } from '../read/projections/bom.js';
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

function isPositiveQuantity(value: unknown): value is string {
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

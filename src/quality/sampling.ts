import { AppError } from '../middleware/error.js';
import {
  STANDARD_REF,
  canonicalAql,
  codeLetterFor,
  isInspectionLevel,
  singleSamplingPlan,
} from './aql-tables.js';
import type {
  CodeLetter,
  InspectionLevel,
  PreferredAql,
  ResolvedCodeLetter,
  Severity,
} from './aql-tables.js';

/**
 * Story 8.2 (FR-Q-03, AC 1): the PURE sampling determination. Given the task's finished quantity,
 * the frozen plan version's AQL and inspection level, the frozen characteristics and the current
 * switching severity, it returns the plan the seam freezes on the task. No database access; every
 * rejection is an AppError with the story's stable code.
 *
 * - Lot size is the task's finished quantity and must be a whole positive number of units
 *   (Annex requirement 5): a fractional quantity is 400 SAMPLING_LOT_SIZE_INVALID.
 * - Only the standard's preferred AQLs are valid (Annex requirement 2): 400 AQL_NOT_IN_STANDARD.
 * - Arrow chains resolve into supplementary code letter S (n = 3150 normal and tightened, 1250
 *   reduced) where the standard's Ac 0 diagonal runs past the 16 Table I letters. Where no plan
 *   exists at any letter - Table II-B's AQL 0.010 column, whose tightened diagonal runs one letter
 *   lower than normal and falls off the end of the tables - the combination is refused 400
 *   AQL_NOT_IN_STANDARD (deferred-work ledger ref 534).
 * - A null level resolves to General Inspection Level II; anything outside the vocabulary is
 *   400 INSPECTION_LEVEL_INVALID (Annex requirement 3).
 * - A version with no AQL (both aql and inspection_level null) is full_inspection: every unit of
 *   the lot is inspected for every characteristic and no Ac / Re applies (Annex requirement 4).
 * - When the table sample size equals or exceeds the lot size, or the lot is below the first Table
 *   I band, the whole lot is inspected (sample_size = lot_size) with the table's Ac / Re.
 */

export interface DetermineSamplingInput {
  /** The task's finished quantity as the NUMERIC(18,6) decimal string. */
  quantity: string;
  aql: string | null;
  inspection_level: string | null;
  characteristics: ReadonlyArray<{ characteristic_id: string; characteristic_class: string }>;
  severity: Severity;
}

export interface DeterminedSampling {
  lot_size: number;
  aql: PreferredAql | null;
  inspection_level: InspectionLevel | null;
  severity: Severity;
  code_letter: CodeLetter | null;
  resolved_code_letter: ResolvedCodeLetter | null;
  sample_size: number;
  acceptance_number: number | null;
  rejection_number: number | null;
  sampling_basis: 'aql_table' | 'full_inspection';
  standard_ref: string;
  critical_characteristic_ids: string[];
}

const WHOLE_QUANTITY_REGEX = /^(\d+)(?:\.(\d+))?$/;

/** Parses a NUMERIC decimal string as a whole positive unit count, or null. Never uses Number on a fraction. */
export function parseLotSize(quantity: string): number | null {
  const m = WHOLE_QUANTITY_REGEX.exec(quantity);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (/[1-9]/.test(frac)) return null;
  const int = m[1]!.replace(/^0+(?=\d)/, '');
  if (int.length > 15) return null;
  const value = Number.parseInt(int, 10);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function determineSampling(input: DetermineSamplingInput): DeterminedSampling {
  const lotSize = parseLotSize(input.quantity);
  if (lotSize === null) {
    throw new AppError(
      400,
      'SAMPLING_LOT_SIZE_INVALID',
      'The task quantity must be a whole positive number of units for sampling',
      { quantity: input.quantity },
    );
  }
  const criticalIds = input.characteristics
    .filter((c) => c.characteristic_class === 'critical')
    .map((c) => c.characteristic_id);

  if (input.aql === null) {
    if (input.inspection_level !== null) {
      throw new AppError(
        400,
        'INSPECTION_LEVEL_INVALID',
        'An inspection level without an AQL cannot be sampled',
        { inspection_level: input.inspection_level },
      );
    }
    return {
      lot_size: lotSize,
      aql: null,
      inspection_level: null,
      severity: input.severity,
      code_letter: null,
      resolved_code_letter: null,
      sample_size: lotSize,
      acceptance_number: null,
      rejection_number: null,
      sampling_basis: 'full_inspection',
      standard_ref: STANDARD_REF,
      critical_characteristic_ids: criticalIds,
    };
  }

  const aql = canonicalAql(input.aql);
  if (aql === null) {
    throw new AppError(
      400,
      'AQL_NOT_IN_STANDARD',
      'The AQL is not a preferred value of the standard',
      {
        aql: input.aql,
      },
    );
  }
  const level: unknown = input.inspection_level === null ? 'II' : input.inspection_level;
  if (!isInspectionLevel(level)) {
    throw new AppError(
      400,
      'INSPECTION_LEVEL_INVALID',
      'The inspection level must be one of: I, II, III, S-1, S-2, S-3, S-4',
      { inspection_level: input.inspection_level },
    );
  }
  // Below the first Table I band the whole lot is inspected; letter A carries the table's Ac / Re.
  const letter = codeLetterFor(lotSize, level) ?? 'A';
  const plan = singleSamplingPlan(letter, aql, input.severity);
  if (!plan) {
    throw new AppError(
      400,
      'AQL_NOT_IN_STANDARD',
      'No sampling plan exists for this AQL and letter',
      {
        aql,
        code_letter: letter,
        severity: input.severity,
      },
    );
  }
  return {
    lot_size: lotSize,
    aql,
    inspection_level: level,
    severity: input.severity,
    code_letter: plan.code_letter,
    resolved_code_letter: plan.resolved_letter,
    sample_size: Math.min(plan.sample_size, lotSize),
    acceptance_number: plan.ac,
    rejection_number: plan.re,
    sampling_basis: 'aql_table',
    standard_ref: STANDARD_REF,
    critical_characteristic_ids: criticalIds,
  };
}

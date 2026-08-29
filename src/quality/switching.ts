/**
 * Story 8.2 (FR-Q-03, AC 2 and AC 3): PURE outcome evaluation and the ISO 2859-1:1999 clause 9.3
 * switching rules with the clause 9.3.3.2 switching score (Annex requirements 8 to 11). No database
 * access; the seam reads the state under lock, calls these, and writes the result back.
 */

export type SwitchingSeverity = 'normal' | 'tightened' | 'reduced';
export type SamplingOutcome = 'accepted' | 'not_accepted';

export interface OutcomePlan {
  sampling_basis: 'aql_table' | 'full_inspection';
  sample_size: number;
  acceptance_number: number | null;
  rejection_number: number | null;
  severity: SwitchingSeverity;
}

export interface NonconformingUnitInput {
  sample_unit_no: number;
  critical: boolean;
}

export interface EvaluatedOutcome {
  sampling_outcome: SamplingOutcome;
  /** Nonconforming units among the AQL sample units (1..sample_size). */
  nonconforming_sample_units: number;
  /** Units carrying at least one nonconforming critical result, anywhere in the lot. */
  critical_nonconformities: number;
  /** Reduced inspection only: the count fell strictly between Ac and Re (accept, return to normal). */
  between_ac_and_re: boolean;
}

/**
 * Annex requirement 8: the lot is not_accepted when any critical nonconformity exists on any unit
 * or when the nonconforming count among the AQL sample units reaches Re; otherwise accepted. Under
 * full_inspection (no Ac / Re) any nonconforming unit is a not_accepted lot (Ac 0 semantics of a
 * 100 % inspection). On reduced inspection a count strictly between Ac and Re accepts the lot and
 * is flagged so the switching rules return to normal (clause 9.3.3.4 as adopted by IS 2500).
 */
export function evaluateOutcome(
  plan: OutcomePlan,
  units: NonconformingUnitInput[],
): EvaluatedOutcome {
  const critical = units.filter((u) => u.critical).length;
  const inSample = units.filter(
    (u) => u.sample_unit_no >= 1 && u.sample_unit_no <= plan.sample_size,
  );
  const nonconforming = inSample.length;
  let outcome: SamplingOutcome = 'accepted';
  let between = false;
  if (critical > 0) {
    outcome = 'not_accepted';
  } else if (plan.sampling_basis === 'full_inspection') {
    outcome = units.length > 0 ? 'not_accepted' : 'accepted';
  } else {
    const ac = plan.acceptance_number ?? 0;
    const re = plan.rejection_number ?? ac + 1;
    if (nonconforming >= re) outcome = 'not_accepted';
    else if (nonconforming > ac) between = true;
  }
  return {
    sampling_outcome: outcome,
    nonconforming_sample_units: nonconforming,
    critical_nonconformities: critical,
    between_ac_and_re: between,
  };
}

export interface SwitchingSnapshot {
  severity: SwitchingSeverity;
  switching_score: number;
  recent_original_outcomes: boolean[];
  consecutive_accepted_on_tightened: number;
  not_accepted_on_tightened: number;
  reduced_eligible: boolean;
  inspection_discontinued: boolean;
  lots_counted: number;
}

export const INITIAL_SWITCHING_SNAPSHOT: SwitchingSnapshot = {
  severity: 'normal',
  switching_score: 0,
  recent_original_outcomes: [],
  consecutive_accepted_on_tightened: 0,
  not_accepted_on_tightened: 0,
  reduced_eligible: false,
  inspection_discontinued: false,
  lots_counted: 0,
};

export const SWITCHING_SCORE_REDUCED_THRESHOLD = 30;
const NORMAL_WINDOW = 5;
const NORMAL_TO_TIGHTENED_NOT_ACCEPTED = 2;
const TIGHTENED_TO_NORMAL_ACCEPTED = 5;
const TIGHTENED_TO_DISCONTINUED_NOT_ACCEPTED = 5;

function resetToNormal(base: SwitchingSnapshot): SwitchingSnapshot {
  return {
    ...base,
    severity: 'normal',
    switching_score: 0,
    recent_original_outcomes: [],
    consecutive_accepted_on_tightened: 0,
    not_accepted_on_tightened: 0,
    reduced_eligible: false,
    inspection_discontinued: false,
  };
}

/**
 * Advances the (plan, site) switching state after ONE original inspection (clause 9.3):
 * - normal to tightened after 2 of at most 5 consecutive lots are not accepted;
 * - tightened to normal after 5 consecutive accepted lots; tightened to discontinued after 5
 *   cumulative not-accepted lots on tightened;
 * - reduced to normal on any not-accepted lot or any count between Ac and Re;
 * - normal to reduced NEVER here: reaching a switching score of 30 only sets reduced_eligible
 *   (Annex requirement 11); the QC Head-level authorize_reduced command performs the switch.
 * The switching score (clause 9.3.3.2) is maintained only on normal inspection and reset to zero on
 * every switch to normal: when Ac >= 2, add 3 if the lot would have been accepted one preferred AQL
 * step tighter at the same code letter (`tighterAqlAcceptable`, false when that cell is an arrow),
 * otherwise reset; when Ac is 0 or 1, add 2 if the lot is accepted, otherwise reset.
 * A full_inspection plan keeps no switching state and returns the input unchanged.
 */
export function advanceSwitchingState(
  state: SwitchingSnapshot,
  outcome: EvaluatedOutcome,
  plan: OutcomePlan,
  tighterAqlAcceptable: boolean,
): SwitchingSnapshot {
  if (plan.sampling_basis === 'full_inspection') return state;
  const accepted = outcome.sampling_outcome === 'accepted';
  const counted = { ...state, lots_counted: state.lots_counted + 1 };
  switch (state.severity) {
    case 'normal': {
      const window = [...state.recent_original_outcomes, accepted].slice(-NORMAL_WINDOW);
      const notAccepted = window.filter((v) => !v).length;
      if (notAccepted >= NORMAL_TO_TIGHTENED_NOT_ACCEPTED) {
        return {
          ...counted,
          severity: 'tightened',
          switching_score: 0,
          recent_original_outcomes: [],
          consecutive_accepted_on_tightened: 0,
          not_accepted_on_tightened: 0,
          reduced_eligible: false,
        };
      }
      const ac = plan.acceptance_number ?? 0;
      let score: number;
      if (ac >= 2) score = tighterAqlAcceptable ? state.switching_score + 3 : 0;
      else score = accepted ? state.switching_score + 2 : 0;
      return {
        ...counted,
        recent_original_outcomes: window,
        switching_score: score,
        reduced_eligible: score >= SWITCHING_SCORE_REDUCED_THRESHOLD,
      };
    }
    case 'tightened': {
      if (accepted) {
        const run = state.consecutive_accepted_on_tightened + 1;
        if (run >= TIGHTENED_TO_NORMAL_ACCEPTED) return resetToNormal(counted);
        return { ...counted, consecutive_accepted_on_tightened: run };
      }
      const notAccepted = state.not_accepted_on_tightened + 1;
      return {
        ...counted,
        consecutive_accepted_on_tightened: 0,
        not_accepted_on_tightened: notAccepted,
        inspection_discontinued: notAccepted >= TIGHTENED_TO_DISCONTINUED_NOT_ACCEPTED,
      };
    }
    case 'reduced': {
      if (!accepted || outcome.between_ac_and_re) return resetToNormal(counted);
      return counted;
    }
    default:
      return counted;
  }
}

/** The QC Head-level authorize_reduced switch: requires normal inspection and reduced_eligible. */
export function applyAuthorizeReduced(state: SwitchingSnapshot): SwitchingSnapshot {
  return {
    ...state,
    severity: 'reduced',
    switching_score: 0,
    recent_original_outcomes: [],
    consecutive_accepted_on_tightened: 0,
    not_accepted_on_tightened: 0,
    reduced_eligible: false,
  };
}

/** The QC Head-level resume_inspection command: resumes on tightened with the counters reset. */
export function applyResumeInspection(state: SwitchingSnapshot): SwitchingSnapshot {
  return {
    ...state,
    severity: 'tightened',
    switching_score: 0,
    recent_original_outcomes: [],
    consecutive_accepted_on_tightened: 0,
    not_accepted_on_tightened: 0,
    reduced_eligible: false,
    inspection_discontinued: false,
  };
}

/**
 * Story 3.15: putaway detail rules kept pure so override, body shape and state transitions are
 * unit tested without a DOM.
 */

export const OVERRIDE_REASONS = [
  'RACK_FULL',
  'DAMAGED_RACK',
  'NEARER_BAY',
  'OPERATOR_CHOICE',
  'OTHER',
] as const;

export type OverrideReason = (typeof OVERRIDE_REASONS)[number];
export type OverrideConfidence = 'certain' | 'uncertain';

export interface Suggestion {
  locationId: string | null;
  locationCode: string | null;
  velocityClass: 'A' | 'B' | 'C' | null;
  reason: string | null;
}

export function toSuggestion(body: unknown): Suggestion {
  const raw = (body ?? {}) as Record<string, unknown>;
  const suggestion = (raw['suggestion'] ?? raw) as Record<string, unknown>;
  const locationId = typeof suggestion['locationId'] === 'string' ? suggestion['locationId'] : null;
  const locationCode =
    typeof suggestion['locationCode'] === 'string' ? suggestion['locationCode'] : null;
  const velocityClass =
    suggestion['velocityClass'] === 'A' ||
    suggestion['velocityClass'] === 'B' ||
    suggestion['velocityClass'] === 'C'
      ? suggestion['velocityClass']
      : null;
  return {
    locationId,
    locationCode,
    velocityClass,
    reason: typeof suggestion['reason'] === 'string' ? suggestion['reason'] : null,
  };
}

/** A reason is needed only when a directed rack exists and the scanned code differs from it. */
export function needsOverride(
  directedCode: string | null | undefined,
  scannedCode: string,
): boolean {
  if (!directedCode) return false;
  return directedCode.trim().toLowerCase() !== scannedCode.trim().toLowerCase();
}

export function completionBody(args: {
  scannedCode: string;
  directedCode: string | null | undefined;
  reason?: OverrideReason | null;
  confidence?: OverrideConfidence | null;
  idempotencyKey: string;
}): Record<string, unknown> {
  const override = needsOverride(args.directedCode, args.scannedCode);
  return {
    actual_location_code: args.scannedCode.trim(),
    ...(override && args.reason ? { override_reason_code: args.reason } : {}),
    ...(override && args.confidence ? { override_confidence: args.confidence } : {}),
    idempotency_key: args.idempotencyKey,
  };
}

export function classHintKey(velocityClass: 'A' | 'B' | 'C' | null): string | null {
  return velocityClass ? `putaway.classHint.${velocityClass}` : null;
}

export type PutawayViewState =
  | 'loading'
  | 'ready'
  | 'read-only'
  | 'reason'
  | 'submitting'
  | 'done'
  | 'failed';

/** Stable state transitions; every terminal state keeps the screen readable. */
export function nextState(
  current: PutawayViewState,
  event: 'loaded' | 'denied' | 'override-needed' | 'submit' | 'done' | 'fail' | 'cancel',
): PutawayViewState {
  if (event === 'denied') return 'read-only';
  if (event === 'override-needed') return 'reason';
  if (event === 'submit') return current === 'reason' || current === 'ready' ? 'submitting' : current;
  if (event === 'done') return 'done';
  if (event === 'fail') return 'ready';
  if (event === 'cancel') return 'ready';
  if (event === 'loaded') return current === 'submitting' ? current : 'ready';
  return current;
}

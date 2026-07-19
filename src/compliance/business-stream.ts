import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { isValidBusinessStream, findActiveTaggingRule } from '../read/projections/business_stream_config.js';
import type { TransactionTaggingRule } from '../read/projections/business_stream_config.js';

/**
 * The set of stream_type values whose events carry inventory movements and therefore require
 * business-stream tagging (FR-AC-01). Events on any other stream type pass through untouched -
 * this is what keeps the DOA registry's `doa_registry_entry`/`doa_vacation_delegation` writes,
 * SCIM's `user` writes, and this story's own `business_stream_config` writes unaffected, since
 * they call persistEvent directly with non-inventory stream types. The gating-by-stream-type
 * approach mirrors how the spine invariants in Stories 1.6 (location) and 1.7 (calibration) are
 * scoped to their own stream types.
 *
 * NOTE for future adapter authors: enforcement lives in persistEvent (the central write path),
 * so ANY code path that writes an inventory-stream event - the public POST /api/v1/events, the
 * Story 1.8 edge sync replication, or a future internal adapter - must satisfy tagging. There is
 * no bypass.
 */
const INVENTORY_MOVEMENT_STREAM_TYPES = new Set(['inventory']);

/**
 * The DB-touching lookups, injectable so unit tests can exercise the validation logic without a
 * database. Production callers use the default (real projection functions).
 */
export interface TaggingDeps {
  isValidBusinessStream: (streamCode: string) => Promise<boolean>;
  findActiveTaggingRule: (transactionType: string, asOfDate?: string) => Promise<TransactionTaggingRule | null>;
}

const defaultDeps: TaggingDeps = {
  isValidBusinessStream: (streamCode) => isValidBusinessStream(streamCode),
  findActiveTaggingRule: (transactionType, asOfDate) => findActiveTaggingRule(transactionType, asOfDate),
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Single enforcement point for FR-AC-01 (business-stream tagging). Called at the top of
 * persistEvent, BEFORE any database write, so an untagged inventory movement is rejected before
 * it can consume an idempotency key or touch domain_events. Throws AppError(400) on violation;
 * resolves on success. Every thrown error carries a `details.missing_tag` (or
 * `details.invalid_value`) so the Spine Acceptance Contract test #5's "rejection message
 * identifies the missing tag" requirement is observable.
 */
export async function assertInventoryTagging(envelope: EventEnvelope, deps: TaggingDeps = defaultDeps): Promise<void> {
  if (!INVENTORY_MOVEMENT_STREAM_TYPES.has(envelope.stream_type)) return;

  const businessStream = envelope.payload['business_stream'];
  if (!isNonEmptyString(businessStream)) {
    throw new AppError(400, 'UNTAGGED_TRANSACTION', 'Inventory movement event is missing the business_stream tag', {
      missing_tag: 'business_stream',
    });
  }

  if (!(await deps.isValidBusinessStream(businessStream))) {
    throw new AppError(400, 'INVALID_BUSINESS_STREAM', 'business_stream is not a recognized active stream', {
      invalid_value: businessStream,
    });
  }

  // The transaction type is the envelope event_type (past-tense dot-separated, e.g. stock.moved).
  // If no tagging rule is effective for it, no cost_centre/project_code is required (the default
  // until an admin configures otherwise - FR-AC-01's "where applicable"). Applicability is based
  // on the event's occurred_at date so edge-synced and backdated events are checked against the
  // transaction date, not the sync date.
  const asOfDate = envelope.metadata.occurred_at.slice(0, 10);
  const rule = await deps.findActiveTaggingRule(envelope.event_type, asOfDate);
  if (!rule) return;

  if (rule.cost_centre_required && !isNonEmptyString(envelope.payload['cost_centre'])) {
    throw new AppError(400, 'UNTAGGED_TRANSACTION', 'Transaction type requires a cost_centre tag', {
      missing_tag: 'cost_centre',
      transaction_type: envelope.event_type,
    });
  }

  if (rule.project_code_required && !isNonEmptyString(envelope.payload['project_code'])) {
    throw new AppError(400, 'UNTAGGED_TRANSACTION', 'Transaction type requires a project_code tag', {
      missing_tag: 'project_code',
      transaction_type: envelope.event_type,
    });
  }
}

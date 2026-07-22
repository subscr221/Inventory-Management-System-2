import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';

/**
 * Central ERP read-only bypass guard (Story 2.9). ERP purchase-order and sales-order projections are
 * REFERENCE DATA (INT-ERP-01): ERP is the master and nothing on this platform mutates them through
 * the event store. They are populated exclusively by the ERP sync adapter via direct SQL upsert.
 *
 * This guard runs BEFORE any DB write, alongside the other pre-transaction asserts in persistEvent,
 * so a direct POST /api/v1/events or an edge upload cannot fabricate ERP reference rows by forging an
 * `erp` stream_type or an `erp.*` event_type - both are rejected SOURCE_SYSTEM_READ_ONLY. Gating is
 * deliberately narrow (mirroring the tagging.enforcement_location central-write-path decision): every
 * existing stream_type and event_type passes through byte-for-byte, so the Story 1.9 spine gate stays
 * green. The adapter never calls persistEvent, so it is unaffected.
 */
export function assertErpReadOnly(envelope: EventEnvelope): void {
  if (envelope.stream_type === 'erp' || envelope.event_type.startsWith('erp.')) {
    throw new AppError(405, 'SOURCE_SYSTEM_READ_ONLY', 'ERP reference data is read-only on this platform; corrections are made in the ERP and arrive on the next sync', {
      stream_type: envelope.stream_type,
      event_type: envelope.event_type,
    });
  }
}

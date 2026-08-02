import type { EdgeEventRecord } from './test-capture';
import { createOutboxEvent } from './outbox-event';

export interface IndentCaptureInput {
  sku: string;
  itemCategory: string;
  requestedQty: number;
  uom: string;
  unitPriceEstimate?: number;
  needByDate: string;
  departmentCode: string;
  businessStream: string;
  urgent: boolean;
  reason?: string;
  userId: string;
  role: string;
  siteId: string;
  deviceId: string;
  indentId?: string;
  eventId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  /** UJ-IND-01 instrumentation: form_opened and local_commit client timestamps. */
  formOpenedAt?: string;
  localCommitAt?: string;
}

export function createIndentRaisedEvent(input: IndentCaptureInput): EdgeEventRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventId = input.eventId ?? globalThis.crypto.randomUUID();
  const indentId = input.indentId ?? globalThis.crypto.randomUUID();
  return createOutboxEvent({
    eventId,
    streamType: 'procurement',
    streamId: indentId,
    eventType: 'indent.raised',
    payload: {
      indent_id: indentId,
      requester_user_id: input.userId,
      department_code: (input.departmentCode ?? '').trim(),
      site_id: input.siteId ?? '',
      business_stream: (input.businessStream ?? '').trim(),
      need_by_date: input.needByDate ?? '',
      urgent: input.urgent,
      reason: input.reason?.trim() ? input.reason.trim() : null,
      lines: [
        {
          sku: (input.sku ?? '').trim(),
          item_category: (input.itemCategory ?? '').trim(),
          requested_qty: input.requestedQty,
          uom: (input.uom ?? '').trim(),
          ...(typeof input.unitPriceEstimate === 'number'
            ? { unit_price_estimate: input.unitPriceEstimate }
            : {}),
        },
      ],
      ...(input.formOpenedAt && input.localCommitAt
        ? {
            capture_metrics: {
              form_opened_at: input.formOpenedAt,
              local_commit_at: input.localCommitAt,
            },
          }
        : {}),
    },
    userId: input.userId,
    role: input.role,
    siteId: input.siteId,
    correlationId: globalThis.crypto.randomUUID(),
    deviceId: input.deviceId,
    idempotencyKey: input.idempotencyKey ?? `edge-indent-${eventId}`,
    occurredAt,
  });
}

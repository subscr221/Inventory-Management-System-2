/**
 * MSME ageing feed contract (Story 4.6, AC4 / FR-P-09).
 *
 * This module defines the ERP adapter boundary for the MSME-classification-tagged ageing feed
 * consumed by the ERP-side s.43B(h) disallowance computation. The adapter records the payload
 * durably in msme_ageing_feed; live transmission to the ERP system is per-deployment
 * configuration and is NOT implemented here (identical philosophy to po-outbound.ts).
 */

import type { MsmeAgeingRow } from '../../read/projections/msme_ageing.js';

export interface MsmeAgeingFeedLinePayload {
  invoice_id: string;
  invoice_number_ext: string;
  supplier_id: string;
  supplier_legal_name: string;
  msme_classification: 'micro' | 'small' | 'medium';
  statutory_due_date: string;
  days_to_due: number;
  days_overdue: number;
  statutory_breach: boolean;
  s43b_exposure: boolean;
  total_value: string;
  s16_interest_exposure: string;
}

export interface MsmeAgeingFeedPayload {
  feed_type: 'msme_ageing';
  generated_at: string;
  row_count: number;
  lines: MsmeAgeingFeedLinePayload[];
  correlation_id: string | null;
}

export function buildMsmeAgeingFeedPayload(
  ageingRows: MsmeAgeingRow[],
  generatedAt: string,
  correlationId: string | null,
): MsmeAgeingFeedPayload {
  return {
    feed_type: 'msme_ageing',
    generated_at: generatedAt,
    row_count: ageingRows.length,
    lines: ageingRows.map((r) => ({
      invoice_id: r.invoice_id,
      invoice_number_ext: r.invoice_number_ext,
      supplier_id: r.supplier_id,
      supplier_legal_name: r.supplier_legal_name,
      msme_classification: r.msme_classification,
      statutory_due_date: r.statutory_due_date,
      days_to_due: r.days_to_due,
      days_overdue: r.days_overdue,
      statutory_breach: r.statutory_breach,
      s43b_exposure: r.s43b_exposure,
      total_value: r.total_value,
      s16_interest_exposure: r.s16_interest_exposure,
    })),
    correlation_id: correlationId,
  };
}

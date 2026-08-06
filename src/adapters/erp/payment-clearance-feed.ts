/**
 * Payment clearance feed contract (Story 4.5, AC3 / FR-P-07).
 *
 * This module defines the ERP adapter boundary for the payment-clearance feed. Payment itself
 * executes in the ERP system - this application never holds payment state - so "blocked from
 * payment" is effected by OMITTING an invoice from this payload while its three-way match is
 * blocked. The adapter records the payload durably in payment_clearance_feed; live transmission is
 * per-deployment configuration and is NOT implemented here (identical philosophy to
 * msme-ageing-feed.ts and po-outbound.ts).
 *
 * This is NOT the MSME ageing feed. That feed reports statutory exposure on every outstanding MSME
 * invoice regardless of match state; this one authorizes payment. They are never interchangeable.
 */

import type { PoolClient } from 'pg';
import type { ClearanceEligibleInvoiceRow } from '../../read/projections/three_way_match.js';

export interface PaymentClearanceFeedLinePayload {
  invoice_id: string;
  invoice_number_ext: string;
  supplier_id: string;
  supplier_legal_name: string;
  po_id: string;
  po_number_ext: string;
  match_id: string;
  match_status: 'passed' | 'lifted';
  total_value: string;
  statutory_due_date: string | null;
  msme_classification: string | null;
}

export interface PaymentClearanceFeedPayload {
  feed_type: 'payment_clearance';
  generated_at: string;
  row_count: number;
  lines: PaymentClearanceFeedLinePayload[];
  correlation_id: string | null;
}

export function buildPaymentClearanceFeedPayload(
  rows: ClearanceEligibleInvoiceRow[],
  generatedAt: string,
  correlationId: string | null,
): PaymentClearanceFeedPayload {
  return {
    feed_type: 'payment_clearance',
    generated_at: generatedAt,
    row_count: rows.length,
    lines: rows.map((r) => ({
      invoice_id: r.invoice_id,
      invoice_number_ext: r.invoice_number_ext,
      supplier_id: r.supplier_id,
      supplier_legal_name: r.supplier_legal_name,
      po_id: r.po_id,
      po_number_ext: r.po_number_ext,
      match_id: r.match_id,
      match_status: r.match_status,
      total_value: r.total_value,
      statutory_due_date: r.statutory_due_date,
      msme_classification: r.msme_classification_at_capture,
    })),
    correlation_id: correlationId,
  };
}

export interface PaymentClearanceFeedRow {
  feed_id: string;
  payload: unknown;
  row_count: number;
  recorded_at: string;
}

export async function insertPaymentClearanceFeed(
  row: Pick<PaymentClearanceFeedRow, 'feed_id' | 'payload' | 'row_count'>,
  client: PoolClient,
): Promise<number> {
  // ON CONFLICT DO NOTHING: a replayed or spoofed payment_clearance_feed.recorded event carrying
  // the same feed_id must not abort the persistEvent transaction with a raw 23505. The rowCount
  // lets the applier tell whether a fresh run actually wrote, vs. a replay of a prior feed.
  const result = await client.query(
    `INSERT INTO payment_clearance_feed (feed_id, payload, row_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (feed_id) DO NOTHING`,
    [row.feed_id, JSON.stringify(row.payload), row.row_count],
  );
  return result.rowCount ?? 0;
}

export async function getPaymentClearanceFeedById(
  feedId: string,
  client: PoolClient,
): Promise<PaymentClearanceFeedRow | null> {
  const result = await client.query(
    `SELECT feed_id, payload, row_count, recorded_at FROM payment_clearance_feed WHERE feed_id = $1`,
    [feedId],
  );
  return (result.rows[0] as PaymentClearanceFeedRow) ?? null;
}

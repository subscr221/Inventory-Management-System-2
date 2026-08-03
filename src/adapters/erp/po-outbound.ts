/**
 * PO outbound message contract (Story 4.4, AC3).
 *
 * This module defines the ERP adapter boundary for purchase order outbound messages.
 * The adapter records the payload durably in po_outbound_message; live transmission
 * to the ERP system is per-deployment configuration and is NOT implemented here.
 *
 * This is distinct from INT-ERP-01 (BOM outbound / cost inbound) and from the
 * Story 2.9 erp_purchase_order inbound reference projections.
 */

import type {
  PurchaseOrderRow,
  PurchaseOrderLineRow,
} from '../../read/projections/purchase_order.js';
import type { SupplierRow } from '../../read/projections/supplier.js';

export interface PoOutboundLinePayload {
  line_no: number;
  sku: string;
  ordered_qty: string;
  uom: string;
  unit_price: string;
  tax_rate_pct: string | null;
  line_value: string;
}

export interface PoOutboundPayload {
  po_number_ext: string;
  po_type: 'standard' | 'blanket' | 'contract';
  supplier: {
    owner_party_code: string;
    gstin: string | null;
  };
  business_stream: string;
  currency: string;
  lines: PoOutboundLinePayload[];
  total_value: string;
  issued_at: string;
  correlation_id: string | null;
}

export function buildPoOutboundPayload(
  po: PurchaseOrderRow,
  lines: PurchaseOrderLineRow[],
  supplier: SupplierRow,
  issuedAt: string,
  correlationId: string | null,
): PoOutboundPayload {
  return {
    po_number_ext: po.po_number_ext,
    po_type: po.po_type,
    supplier: {
      owner_party_code: supplier.owner_party_code,
      gstin: supplier.gstin_ext,
    },
    business_stream: po.business_stream,
    currency: po.currency,
    lines: lines.map((l) => ({
      line_no: l.line_no,
      sku: l.sku,
      ordered_qty: l.ordered_qty,
      uom: l.uom,
      unit_price: l.unit_price,
      tax_rate_pct: l.tax_rate_pct,
      line_value: l.line_value,
    })),
    total_value: po.total_value,
    issued_at: issuedAt,
    correlation_id: correlationId,
  };
}

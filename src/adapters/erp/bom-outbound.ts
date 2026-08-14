/**
 * BOM outbound message contract (Story 5.6, FR-B-17, INT-ERP-01).
 *
 * This module defines the ERP adapter boundary for released production BOM versions. The adapter
 * records the payload durably in bom_outbound_message; live transmission to the ERP system is
 * per-deployment configuration and is NOT implemented here.
 *
 * INT-ERP-01 splits by data domain: BOM structure, revisions and lifecycle state publish OUTBOUND;
 * item cost rates and financial item attributes flow inbound. Nothing structural is ever accepted
 * inbound - an inbound BOM record raises a BOM Administrator exception instead (AD-4).
 */

import type { BomRow, BomRevisionRow, BomLineRow } from '../../read/projections/bom.js';

export interface BomOutboundLinePayload {
  line_no: number;
  component_sku: string | null;
  output_class: 'component' | 'co_product' | 'by_product';
  quantity_per: string;
  line_uom: string;
  uom_conversion_factor: string;
  base_quantity_per: string;
  scrap_percent: string | null;
  expected_yield_percent: string | null;
  is_phantom: boolean;
  supply_method: 'directed_issue' | 'backflush';
  supply_source: 'company' | 'customer' | 'job_worker' | null;
  effective_from: string;
  effective_to: string | null;
}

export interface BomOutboundPayload {
  bom_id: string;
  parent_sku: string;
  parent_uom: string;
  business_stream: string;
  bom_type: 'production' | 'rnd' | 'job_work_kit';
  revision_code: string;
  revision_status: 'draft' | 'released';
  lifecycle_state: 'draft' | 'released' | 'on_hold' | 'obsolete';
  lines: BomOutboundLinePayload[];
  released_at: string;
  correlation_id: string | null;
}

/**
 * Formats a bom_line effectivity DATE as an ISO `YYYY-MM-DD` string. node-pg returns DATE columns
 * as local-midnight JS Date objects, so `String(date)` yields a locale string and `toISOString()`
 * shifts east-of-UTC dates back a day. Local calendar components are the correct, shift-free form.
 */
function isoDate(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

export function buildBomOutboundPayload(
  bom: Pick<
    BomRow,
    'bom_id' | 'parent_sku' | 'parent_uom' | 'business_stream' | 'bom_type' | 'status'
  >,
  revision: Pick<BomRevisionRow, 'revision_code' | 'revision_status'>,
  lines: BomLineRow[],
  occurredAt: string,
  correlationId: string | null,
): BomOutboundPayload {
  return {
    bom_id: bom.bom_id,
    parent_sku: bom.parent_sku,
    parent_uom: bom.parent_uom,
    business_stream: bom.business_stream,
    bom_type: bom.bom_type,
    revision_code: revision.revision_code,
    revision_status: revision.revision_status,
    lifecycle_state: bom.status,
    // Quantities travel as the exact decimal strings the NUMERIC columns hold - never reformatted
    // through a JS float.
    lines: lines.map((line) => ({
      line_no: line.line_no,
      component_sku: line.component_sku,
      output_class: line.output_class,
      quantity_per: line.quantity_per,
      line_uom: line.line_uom,
      uom_conversion_factor: line.uom_conversion_factor,
      base_quantity_per: line.base_quantity_per,
      scrap_percent: line.scrap_percent,
      expected_yield_percent: line.expected_yield_percent,
      is_phantom: line.is_phantom,
      supply_method: line.supply_method,
      supply_source: line.supply_source,
      effective_from: isoDate(line.effective_from),
      effective_to: line.effective_to === null ? null : isoDate(line.effective_to),
    })),
    released_at: occurredAt,
    correlation_id: correlationId,
  };
}

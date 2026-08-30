import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf-8');
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim();
}

function extractCreateTable(sql: string, table: string): string {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(.*?\\);`, 'is').exec(sql);
  assert.ok(match, `missing CREATE TABLE for ${table}`);
  return normalizeSql(match[0]!);
}

function extractDoBlock(sql: string, constraint: string): string {
  const blocks = sql.match(/DO \$\$.*?END \$\$;/gis) ?? [];
  const block = blocks.find((candidate) => candidate.includes(constraint));
  assert.ok(block, `missing guarded constraint block for ${constraint}`);
  return normalizeSql(block);
}

const EXPECTED = [
  {
    canonical: 'read/projections/item_master.sql',
    table: 'item_master',
    constraints: [
      'chk_item_master_valuation_method',
      'chk_item_master_status',
      'chk_item_master_standard_cost_designation',
      'chk_item_master_standard_cost_requires_designation',
      'chk_item_master_standard_cost_amount_non_negative',
      'chk_item_master_variance_tolerance_percent',
      'chk_item_master_count_variance_tolerance_percent',
      'chk_item_master_size_class',
    ],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/location_register.sql',
    table: 'location_register',
    constraints: [
      'chk_location_register_level',
      'chk_location_register_zone_type',
      'chk_location_register_temperature_class',
      'chk_location_register_status',
    ],
    indexes: ['idx_location_register_parent', 'idx_location_register_site'],
  },
  {
    canonical: 'read/projections/stock_balance.sql',
    table: 'stock_balance',
    constraints: [
      'uq_stock_balance_grain',
      'chk_stock_balance_on_hand_non_negative',
      'chk_stock_balance_allocated_non_negative',
      'chk_stock_balance_picked_non_negative',
      'chk_stock_balance_allocated_within_on_hand',
      'chk_stock_balance_in_transit_non_negative',
    ],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/lot_master.sql',
    table: 'lot_master',
    constraints: ['uq_lot_master_lot_number', 'chk_lot_master_quality_hold_status'],
    indexes: ['idx_lot_master_sku_expiry', 'idx_lot_master_lot_id'],
  },
  {
    canonical: 'read/projections/serial_master.sql',
    table: 'serial_master',
    constraints: ['uq_serial_master_sku_serial_number'],
    indexes: ['idx_serial_master_sku_serial'],
  },
  {
    canonical: 'read/projections/lot_trace.sql',
    table: 'lot_trace',
    constraints: [] as string[],
    indexes: ['idx_lot_trace_lot_timestamp', 'idx_lot_trace_event_id'],
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation',
    constraints: [
      'chk_inventory_valuation_quantity_non_negative',
      'chk_inventory_valuation_carrying_value_non_negative',
      'chk_inventory_valuation_recovery_cap',
    ],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_fifo_layer',
    constraints: ['chk_inventory_valuation_fifo_layer_remaining_bounds'],
    indexes: ['idx_inventory_valuation_fifo_layer_sku_sequence'],
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_serial_cost',
    constraints: [] as string[],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_nrv_adjustment',
    constraints: ['chk_inventory_valuation_nrv_adjustment_type'],
    indexes: ['idx_inventory_valuation_nrv_adjustment_sku'],
    // Append-only ledger: app_user gets no UPDATE (or DELETE) grant, unlike every other projection.
    appUserGrant: 'INSERT, SELECT',
  },
  {
    canonical: 'read/projections/inventory_valuation.sql',
    table: 'inventory_valuation_standard_cost_variance',
    constraints: [] as string[],
    indexes: ['idx_inventory_valuation_standard_cost_variance_sku'],
    // Append-only ledger: app_user gets no UPDATE (or DELETE) grant, unlike every other projection.
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 2.5 projections (drift gap closed by Story 2.6).
  {
    canonical: 'read/projections/transfer_request.sql',
    table: 'transfer_request',
    constraints: [] as string[],
    indexes: [
      'idx_transfer_request_status',
      'idx_transfer_request_sku',
      'idx_transfer_request_from_loc',
      'idx_transfer_request_to_loc',
    ],
  },
  {
    canonical: 'read/projections/in_transit.sql',
    table: 'in_transit',
    constraints: ['uq_in_transit_transfer_request'],
    indexes: [
      'idx_in_transit_sku',
      'idx_in_transit_from',
      'idx_in_transit_to',
      'idx_in_transit_lot',
      'idx_in_transit_request',
    ],
    // in_transit rows are cleared on full receipt, so app_user additionally holds DELETE.
    appUserGrant: 'INSERT, SELECT, UPDATE, DELETE',
  },
  // Story 2.6 projections.
  {
    canonical: 'read/projections/cycle_count.sql',
    table: 'cycle_count',
    constraints: [] as string[],
    indexes: ['idx_cycle_count_location', 'idx_cycle_count_status'],
  },
  {
    canonical: 'read/projections/cycle_count.sql',
    table: 'cycle_count_line',
    constraints: ['uq_cycle_count_line_grain', 'chk_cycle_count_line_counted_non_negative'],
    indexes: ['idx_cycle_count_line_count', 'idx_cycle_count_line_adjustment'],
  },
  {
    canonical: 'read/projections/physical_verification.sql',
    table: 'physical_verification',
    constraints: [] as string[],
    indexes: ['idx_physical_verification_location'],
  },
  {
    canonical: 'read/projections/physical_verification.sql',
    table: 'physical_verification_line',
    constraints: [] as string[],
    indexes: ['idx_physical_verification_line_pv'],
    // Append-only evidence: app_user gets no UPDATE/DELETE grant.
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 2.7 projections.
  {
    canonical: 'read/projections/inventory_planning.sql',
    table: 'inventory_planning_params',
    constraints: [
      'uq_inventory_planning_params_grain',
      'chk_inventory_planning_params_service_level',
      'chk_inventory_planning_params_lead_time_non_negative',
      'chk_inventory_planning_params_window_positive',
    ],
    indexes: ['idx_inventory_planning_params_location', 'idx_inventory_planning_params_sku'],
  },
  {
    canonical: 'read/projections/replenishment_recommendation.sql',
    // Story 2.8 extension: signal_type + owner_party_code columns and the per-signal open guard
    // (uq_replenishment_recommendation_open_signal replaced uq_replenishment_recommendation_open).
    table: 'replenishment_recommendation',
    constraints: [
      'chk_replenishment_recommendation_status',
      'chk_replenishment_recommendation_signal_type',
    ],
    indexes: [
      'idx_replenishment_recommendation_sku',
      'idx_replenishment_recommendation_location',
      'uq_replenishment_recommendation_open_signal',
    ],
  },
  {
    canonical: 'read/projections/obsolescence_flag.sql',
    table: 'obsolescence_flag',
    constraints: ['uq_obsolescence_flag_grain', 'chk_obsolescence_flag_status'],
    indexes: ['idx_obsolescence_flag_location', 'idx_obsolescence_flag_status'],
  },
  // Story 2.8 projections.
  {
    canonical: 'read/projections/ownership_agreement.sql',
    table: 'ownership_agreement',
    constraints: [
      'chk_ownership_agreement_stock_class',
      'chk_ownership_agreement_vmi_min_positive',
      'chk_ownership_agreement_vmi_min_required',
      'chk_ownership_agreement_owner_party_code',
    ],
    indexes: [
      'idx_ownership_agreement_location',
      'idx_ownership_agreement_sku',
      'uq_ownership_agreement_active',
    ],
  },
  // Story 2.9 ERP inbound reference projections (NOT event-sourced; direct adapter upsert).
  {
    canonical: 'read/projections/erp_purchase_order.sql',
    table: 'erp_purchase_order',
    constraints: ['chk_erp_purchase_order_status', 'chk_erp_purchase_order_source_system'],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/erp_purchase_order.sql',
    table: 'erp_purchase_order_line',
    constraints: [
      'chk_erp_po_line_ordered_non_negative',
      'chk_erp_po_line_open_within_ordered',
      'chk_erp_po_line_unit_price_non_negative',
      'chk_erp_po_line_tolerance_non_negative',
    ],
    indexes: ['idx_erp_purchase_order_line_sku'],
  },
  {
    canonical: 'read/projections/erp_sales_order.sql',
    table: 'erp_sales_order',
    constraints: [
      'chk_erp_so_quantity_non_negative',
      'chk_erp_sales_order_status',
      'chk_erp_sales_order_source_system',
    ],
    indexes: ['idx_erp_sales_order_site_status', 'idx_erp_sales_order_site_code_status'],
  },
  {
    canonical: 'read/projections/integration_exception.sql',
    table: 'erp_sync_state',
    constraints: ['chk_erp_sync_state_status'],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/integration_exception.sql',
    table: 'integration_exception',
    constraints: ['chk_integration_exception_record_type', 'chk_integration_exception_status'],
    indexes: ['idx_integration_exception_status', 'uq_integration_exception_open'],
  },
  {
    canonical: 'read/projections/gate_event.sql',
    table: 'gate_event',
    constraints: [
      'chk_gate_event_binding_status',
      'chk_gate_event_status',
      'chk_gate_event_vehicle_reg_nonempty',
      'chk_gate_event_challan_photo_nonempty',
      'uq_gate_event_correlation_id',
    ],
    indexes: [
      'idx_gate_event_site_status',
      'idx_gate_event_po_ref',
      'idx_gate_event_binding_status',
      'idx_gate_event_correlation',
    ],
  },
  {
    canonical: 'read/projections/weighbridge_event.sql',
    table: 'weighbridge_event',
    constraints: [
      'chk_weighbridge_event_status',
      'chk_weighbridge_event_tare_non_negative',
      'chk_weighbridge_event_gross_non_negative',
      'chk_weighbridge_event_net_non_negative',
      'chk_weighbridge_event_capture_method',
    ],
    indexes: [
      'idx_weighbridge_event_correlation',
      'idx_weighbridge_event_site_status',
      'idx_weighbridge_event_po_line',
      'idx_weighbridge_event_business_date',
      // Story 3.8: capture-instant column for gate-dwell computation. A bare additive TIMESTAMPTZ
      // adds no named constraint, so only its index needs guarding here.
      'idx_weighbridge_event_occurred_at',
    ],
  },
  {
    canonical: 'read/projections/grn.sql',
    table: 'grn',
    constraints: ['chk_grn_source_document', 'chk_grn_status'],
    indexes: [
      'idx_grn_correlation',
      'idx_grn_po_ref',
      'idx_grn_site_status',
      'idx_grn_business_date',
      // Story 3.8: capture-instant column for the GRN-fallback leg of gate-dwell computation.
      'idx_grn_received_at',
      // Story 4.5: native Story 4.4 purchase-order binding for the three-way match.
      'idx_grn_po_id',
    ],
  },
  {
    canonical: 'read/projections/grn_line.sql',
    table: 'grn_line',
    constraints: [
      'chk_grn_line_received_positive',
      'chk_grn_line_status',
      'chk_grn_line_shortage_non_negative',
    ],
    indexes: [
      'idx_grn_line_grn',
      'idx_grn_line_po_line',
      'idx_grn_line_sku',
      'idx_grn_line_shortage',
    ],
  },
  {
    canonical: 'read/projections/putaway_task.sql',
    table: 'putaway_task',
    constraints: [
      'chk_putaway_task_status',
      'chk_putaway_task_velocity_class_value',
      'chk_putaway_task_override_confidence',
      // Story 3.8: task-board priority vocabulary.
      'chk_putaway_task_priority',
    ],
    indexes: [
      'idx_putaway_task_grn_line',
      'idx_putaway_task_site_status',
      'idx_putaway_task_priority_status',
      'idx_putaway_task_assigned_status',
      'idx_putaway_task_zone_status',
    ],
  },
  // Story 3.5 projections.
  {
    canonical: 'read/projections/velocity_class.sql',
    table: 'velocity_class',
    constraints: ['chk_velocity_class_value'],
    indexes: ['idx_velocity_class_site_class'],
  },
  // Story 3.6 projections.
  {
    canonical: 'read/projections/pick_task.sql',
    table: 'pick_task',
    // Story 3.8 added chk_pick_task_priority; every other value in this entry is unchanged.
    constraints: [
      'chk_pick_task_strategy',
      'chk_pick_task_status',
      'chk_pick_task_priority',
      'chk_pick_task_fulfillment_source',
    ],
    indexes: [
      'idx_pick_task_dispatch_order',
      'idx_pick_task_zone_status',
      'idx_pick_task_assigned_status',
      'idx_pick_task_wave',
      'idx_pick_task_batch',
      'idx_pick_task_priority_status',
    ],
  },
  {
    canonical: 'read/projections/pick_line.sql',
    table: 'pick_line',
    constraints: ['chk_pick_line_status', 'chk_pick_line_capture_method'],
    indexes: ['idx_pick_line_task', 'idx_pick_line_location_status', 'idx_pick_line_directed_lot'],
  },
  {
    canonical: 'read/projections/pick_task.sql',
    table: 'dispatch_order_status',
    constraints: [] as string[],
    indexes: ['idx_dispatch_order_status_picked'],
  },
  {
    canonical: 'read/projections/asn.sql',
    table: 'asn',
    constraints: ['chk_asn_status'],
    indexes: ['idx_asn_po_ref'],
  },
  {
    canonical: 'read/projections/asn_line.sql',
    table: 'asn_line',
    constraints: [] as string[],
    indexes: [] as string[],
  },
  {
    canonical: 'read/projections/packing_record.sql',
    table: 'packing_record',
    constraints: [
      'chk_packing_record_status',
      'chk_packing_record_qty',
      'chk_packing_record_carton',
    ],
    indexes: ['idx_packing_record_dispatch_order', 'idx_packing_record_lot'],
  },
  {
    canonical: 'read/projections/dispatch_document.sql',
    table: 'dispatch_document',
    constraints: ['chk_dispatch_document_type'],
    indexes: ['idx_dispatch_document_order'],
    appUserGrant: 'INSERT, SELECT, UPDATE, DELETE',
  },
  // Story 3.8 projections. NOTE: the dispatch_order_status entry above still carries an empty
  // `constraints` array - that gap is inherited from Story 3.7's deferred follow-up. This story
  // neither fixes nor masks it; the entry is left exactly as Story 3.6/3.7 left it.
  {
    canonical: 'read/projections/task_sla_config.sql',
    table: 'task_sla_config',
    constraints: ['chk_task_sla_config_task_type', 'chk_task_sla_config_threshold_positive'],
    indexes: [
      'uq_task_sla_config_grain',
      'idx_task_sla_config_zone',
      'idx_task_sla_config_site_type',
    ],
  },
  // gate_dwell_metric is a VIEW, so it does not fit the table-shaped EXPECTED entries. A canonical
  // view-body parity check lives below, asserting the SELECT list of the canonical SQL and the
  // init-db.sql mirror match exactly. Any drift that reorders, drops, or renames a column the
  // dashboard contract depends on fails this assertion before it can reach production.
  {
    canonical: 'read/projections/gate_dwell_metric.sql',
    table: 'gate_dwell_metric',
    constraints: [] as string[],
    indexes: [] as string[],
    isView: true,
  },
  // Story 3.9 projections.
  {
    canonical: 'read/projections/forward_pick_config.sql',
    table: 'forward_pick_config',
    constraints: ['chk_forward_pick_config_min_non_negative', 'chk_forward_pick_config_max_gt_min'],
    indexes: ['uq_forward_pick_config_sku_zone'],
  },
  {
    canonical: 'read/projections/replenishment_task.sql',
    table: 'replenishment_task',
    constraints: [
      'chk_replenishment_task_status',
      'chk_replenishment_task_priority',
      'chk_replenishment_task_signal_type',
      'chk_replenishment_task_quantity_positive',
    ],
    indexes: [
      'uq_replenishment_task_open_signal',
      'idx_replenishment_task_site_status',
      'idx_replenishment_task_zone_status',
      'idx_replenishment_task_assigned_status',
    ],
  },
  {
    canonical: 'read/projections/cross_dock_task.sql',
    table: 'cross_dock_task',
    constraints: [
      'uq_cross_dock_task_grn_line',
      'chk_cross_dock_task_status',
      'chk_cross_dock_task_priority',
      'chk_cross_dock_task_quantity_positive',
      'chk_cross_dock_task_completion_fields',
    ],
    indexes: [
      'idx_cross_dock_task_site_status',
      'idx_cross_dock_task_staging_status',
      'idx_cross_dock_task_assigned_status',
      'idx_cross_dock_task_dispatch_status',
      'idx_cross_dock_task_correlation',
    ],
  },
  // Story 4.1: Supplier Registry and Onboarding
  {
    canonical: 'read/projections/supplier.sql',
    table: 'supplier',
    constraints: [
      'chk_supplier_status',
      'chk_supplier_credit_period_non_negative',
      'chk_supplier_deactivation_reason',
      'chk_supplier_owner_party_code',
      'chk_supplier_msme_classification',
      'chk_supplier_msme_status',
    ],
    indexes: [
      'uq_supplier_gstin',
      'uq_supplier_owner_party_code',
      'idx_supplier_legal_name_trgm',
      'idx_supplier_owner_party_code_trgm',
    ],
  },
  // Story 4.3: Purchase Requisition and Indent Loop
  {
    canonical: 'read/projections/indent.sql',
    table: 'indent',
    constraints: [
      'chk_indent_status',
      'chk_indent_rejection_reason',
      'chk_indent_estimated_value_non_negative',
    ],
    indexes: ['uq_indent_number_ext', 'idx_indent_dup_window'],
  },
  {
    canonical: 'read/projections/indent_line.sql',
    table: 'indent_line',
    constraints: ['uq_indent_line_no', 'chk_indent_line_qty_positive'],
    indexes: ['idx_indent_line_sku'],
  },
  // Story 4.4: Purchase Order Management
  {
    canonical: 'read/projections/purchase_order.sql',
    table: 'purchase_order',
    constraints: [
      'chk_po_type',
      'chk_po_status',
      'chk_po_total_value_non_negative',
      'chk_po_released_value_non_negative',
      'chk_po_ceiling_covers_released',
      'chk_po_rejection_reason',
    ],
    indexes: ['uq_po_number_ext', 'idx_po_supplier', 'idx_po_indent', 'idx_po_status'],
  },
  {
    canonical: 'read/projections/purchase_order_line.sql',
    table: 'purchase_order_line',
    constraints: [
      'uq_po_line_no',
      'chk_po_line_qty_positive',
      'chk_po_line_unit_price_non_negative',
    ],
    indexes: ['idx_po_line_sku', 'idx_po_line_po_id'],
  },
  {
    canonical: 'read/projections/po_outbound_message.sql',
    table: 'po_outbound_message',
    constraints: [],
    indexes: ['idx_po_outbound_po_id'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 4.7: Supplier Invoice Capture
  {
    canonical: 'read/projections/supplier_invoice.sql',
    table: 'supplier_invoice',
    constraints: [
      'chk_supplier_invoice_status',
      'chk_supplier_invoice_capture_method',
      'chk_supplier_invoice_status_po_pairing',
      'chk_supplier_invoice_duplicate_pairing',
      'chk_supplier_invoice_subtotal_non_negative',
      'chk_supplier_invoice_cgst_non_negative',
      'chk_supplier_invoice_sgst_non_negative',
      'chk_supplier_invoice_igst_non_negative',
      'chk_supplier_invoice_cess_non_negative',
      'chk_supplier_invoice_total_non_negative',
      'chk_supplier_invoice_msme_classification',
      // Story 4.5: additive match-outcome column, guarded separately from the CREATE TABLE body.
      'chk_supplier_invoice_match_status',
    ],
    indexes: [
      'uq_supplier_invoice_duplicate_grain',
      'idx_supplier_invoice_unmatched',
      'idx_supplier_invoice_supplier_date',
      'idx_supplier_invoice_po',
      'idx_supplier_invoice_site_status',
      'idx_supplier_invoice_gst_recon',
      // Story 4.5: partial index over blocked matches for the payment-clearance filter.
      'idx_supplier_invoice_match_blocked',
    ],
  },
  {
    canonical: 'read/projections/supplier_invoice_line.sql',
    table: 'supplier_invoice_line',
    constraints: [
      'uq_supplier_invoice_line_no',
      'chk_supplier_invoice_line_qty_positive',
      'chk_supplier_invoice_line_amounts_non_negative',
    ],
    indexes: [
      'idx_supplier_invoice_line_sku',
      'idx_supplier_invoice_line_po_line',
      'idx_supplier_invoice_line_invoice_id',
    ],
  },
  {
    canonical: 'read/projections/supplier_invoice_ingestion.sql',
    table: 'supplier_invoice_ingestion',
    constraints: [
      'chk_supplier_invoice_ingestion_format',
      'chk_supplier_invoice_ingestion_review_status',
      'chk_supplier_invoice_ingestion_byte_size_positive',
      'chk_supplier_invoice_ingestion_reviewed_pairing',
    ],
    indexes: [
      'uq_supplier_invoice_ingestion_attachment_ref',
      'idx_supplier_invoice_ingestion_review_status',
      'idx_supplier_invoice_ingestion_resulting_invoice',
    ],
  },
  // Story 4.6: MSME Compliance Tracking
  {
    canonical: 'read/projections/msme_ageing_feed.sql',
    table: 'msme_ageing_feed',
    constraints: [] as string[],
    indexes: [] as string[],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 4.5: Goods Receipt and Three-Way Match
  {
    canonical: 'read/projections/three_way_match.sql',
    table: 'three_way_match',
    constraints: [
      'chk_three_way_match_status',
      'chk_three_way_match_note_type',
      'chk_three_way_match_lift_pairing',
    ],
    indexes: [
      'idx_three_way_match_invoice',
      'idx_three_way_match_po',
      'idx_three_way_match_blocked',
    ],
  },
  {
    canonical: 'read/projections/payment_clearance_feed.sql',
    table: 'payment_clearance_feed',
    constraints: [] as string[],
    indexes: [] as string[],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 4.2: Supplier Performance Scorecards
  {
    canonical: 'read/projections/supplier_scorecard_metric.sql',
    table: 'supplier_scorecard_metric',
    constraints: ['chk_supplier_scorecard_metric_kind'],
    indexes: [
      'idx_supplier_scorecard_supplier_kind',
      'idx_supplier_scorecard_reference',
      'idx_supplier_scorecard_supersedes',
      'uq_supplier_scorecard_reference_kind',
    ],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 5.1: BOM Management
  {
    canonical: 'read/projections/bom.sql',
    table: 'bom',
    constraints: ['chk_bom_type', 'chk_bom_status', 'chk_bom_origin'],
    indexes: [
      'uq_bom_parent_item',
      'idx_bom_status',
      'idx_bom_business_stream',
      'idx_bom_parent_item_id',
      'idx_bom_blocking',
      // Story 5.4 provenance indexes
      'idx_bom_cloned_from',
      'idx_bom_productized_from',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/bom_revision.sql',
    table: 'bom_revision',
    constraints: ['chk_bom_revision_status'],
    indexes: ['uq_bom_revision_code', 'idx_bom_revision_bom_id', 'idx_bom_revision_source_eco'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/bom_line.sql',
    table: 'bom_line',
    constraints: [
      'chk_bom_line_output_class',
      'chk_bom_line_scrap_percent',
      'chk_bom_line_quantity_positive',
      'chk_bom_line_conversion_positive',
      'chk_bom_line_yield_required',
      'chk_bom_line_effectivity_order',
      'chk_bom_line_phantom_pairing',
      'chk_bom_line_blocking_reason',
      // Story 5.4 placeholder pairing (DROP + ADD DO block, mirrored in init-db.sql)
      'chk_bom_line_placeholder_pairing',
      // Story 5.5 supply method (DROP + ADD DO block, mirrored in init-db.sql)
      'chk_bom_line_supply_method',
      // Story 5.6 supply source (DROP + ADD DO block, mirrored in init-db.sql)
      'chk_bom_line_supply_source',
    ],
    indexes: [
      'uq_bom_line_no',
      'idx_bom_line_component_item',
      'idx_bom_line_bom_id',
      'idx_bom_line_blocking',
      'idx_bom_line_effective',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/bom_structure.sql',
    table: 'bom_structure',
    constraints: ['chk_bom_structure_depth'],
    indexes: [
      'uq_bom_structure_path',
      'idx_bom_structure_component',
      'idx_bom_structure_bom_id',
      'idx_bom_structure_revision',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE, DELETE',
  },
  // Story 5.3: ECO Workflow and Where-Used Impact
  {
    canonical: 'read/projections/eco.sql',
    table: 'eco',
    constraints: ['chk_eco_status'],
    indexes: ['uq_eco_number', 'idx_eco_bom_id', 'idx_eco_status', 'idx_eco_approver'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/eco_change_line.sql',
    table: 'eco_change_line',
    constraints: ['chk_eco_change_type', 'chk_eco_change_target'],
    indexes: ['uq_eco_change_no', 'idx_eco_change_eco_id'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/eco_stock_disposition.sql',
    table: 'eco_stock_disposition',
    constraints: ['chk_eco_disposition', 'chk_eco_disposition_rework_ref'],
    indexes: ['uq_eco_disposition_lot', 'idx_eco_disposition_eco_id'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 5.4: R&D Draft BOM Regime
  {
    canonical: 'read/projections/rd_build_record.sql',
    table: 'rd_build_record',
    constraints: ['chk_rd_build_status', 'chk_rd_build_quantity_positive', 'chk_rd_build_outcome'],
    indexes: ['uq_rd_build_ref', 'idx_rd_build_bom_id', 'idx_rd_build_status'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/rd_as_built_line.sql',
    table: 'rd_as_built_line',
    constraints: [
      'chk_rd_as_built_quantity_positive',
      'chk_rd_as_built_identity',
      'chk_rd_as_built_deviation',
      'chk_rd_as_built_deviation_kind',
    ],
    indexes: ['uq_rd_as_built_line_no', 'idx_rd_as_built_build_id'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/rd_productization_signoff.sql',
    table: 'rd_productization_signoff',
    constraints: ['chk_rd_signoff_function'],
    indexes: ['uq_rd_signoff_function', 'idx_rd_signoff_bom_id'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 5.5: Approved Alternates and BOM Explosion
  {
    canonical: 'read/projections/bom_alternate.sql',
    table: 'bom_alternate',
    constraints: [
      'chk_bom_alternate_origin',
      'chk_bom_alternate_priority',
      'chk_bom_alternate_effectivity_order',
      'chk_bom_alternate_not_self',
      'chk_bom_alternate_doa_pairing',
    ],
    indexes: [
      'uq_bom_alternate_entry',
      'idx_bom_alternate_bom_id',
      'idx_bom_alternate_line',
      'idx_bom_alternate_effective',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/bom_explosion.sql',
    table: 'bom_explosion',
    constraints: ['chk_bom_explosion_quantity_positive', 'chk_bom_explosion_requirement_count'],
    indexes: ['uq_bom_explosion_source_event', 'idx_bom_explosion_bom_id'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/bom_explosion_line.sql',
    table: 'bom_explosion_line',
    constraints: [
      'chk_bom_explosion_line_depth',
      'chk_bom_explosion_line_supply_method',
      'chk_bom_explosion_line_quantity_positive',
    ],
    indexes: [
      'uq_bom_explosion_line_no',
      'idx_bom_explosion_line_explosion',
      'idx_bom_explosion_line_component',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 5.6: Cost Rollups, Job-Work Kit Tagging, and ERP Outbound Sync
  {
    canonical: 'read/projections/bom_cost_rollup.sql',
    table: 'bom_cost_rollup',
    constraints: ['chk_bom_cost_rollup_rate_basis', 'chk_bom_cost_rollup_counts'],
    indexes: ['uq_bom_cost_rollup_source_event', 'idx_bom_cost_rollup_bom'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/bom_cost_rollup_line.sql',
    table: 'bom_cost_rollup_line',
    constraints: [
      'chk_bom_cost_rollup_line_depth',
      'chk_bom_cost_rollup_line_quantity_positive',
      'chk_bom_cost_rollup_line_extended_non_negative',
    ],
    indexes: [
      'uq_bom_cost_rollup_line_no',
      'idx_bom_cost_rollup_line_rollup',
      'idx_bom_cost_rollup_line_component',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/bom_outbound_message.sql',
    table: 'bom_outbound_message',
    constraints: [] as string[],
    indexes: ['idx_bom_outbound_bom_id'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 7.1: Asset Register and Criticality Classification
  {
    canonical: 'read/projections/asset.sql',
    table: 'asset',
    constraints: ['chk_asset_criticality_class'],
    indexes: ['uq_asset_tag', 'uq_asset_serial'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 7.2: Preventive Maintenance Plans and Work Order Generation
  {
    canonical: 'read/projections/asset_meter.sql',
    table: 'asset_meter',
    constraints: [
      'chk_asset_meter_unit',
      'chk_asset_meter_silent_after_days',
      'chk_asset_meter_current_reading',
    ],
    indexes: ['uq_asset_meter_code', 'idx_asset_meter_asset'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/asset_meter_reading.sql',
    table: 'asset_meter_reading',
    constraints: [
      'chk_asset_meter_reading_source',
      'chk_asset_meter_reading_capture_method',
      'chk_asset_meter_reading_value',
    ],
    indexes: ['idx_asset_meter_reading_meter'],
    appUserGrant: 'INSERT, SELECT',
  },
  {
    canonical: 'read/projections/maintenance_plan.sql',
    table: 'maintenance_plan',
    constraints: [
      'chk_maintenance_plan_type',
      'chk_maintenance_plan_status',
      'chk_maintenance_plan_grace',
      'chk_maintenance_plan_calendar_fields',
      'chk_maintenance_plan_meter_fields',
    ],
    indexes: ['uq_maintenance_plan_name', 'idx_maintenance_plan_asset', 'idx_maintenance_plan_due'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_work_order.sql',
    table: 'maintenance_work_order',
    constraints: [
      'chk_maintenance_work_order_status',
      'chk_maintenance_work_order_origin',
      'chk_maintenance_work_order_plan_link',
      'chk_maintenance_work_order_grace',
      'chk_maintenance_work_order_priority',
      'chk_maintenance_work_order_breakdown_link',
      // Story 7.6 (FR-M-15): the additive cost columns carry their own non-negative checks.
      'chk_maintenance_work_order_labor_non_negative',
      'chk_maintenance_work_order_parts_non_negative',
      'chk_maintenance_work_order_total_non_negative',
    ],
    indexes: [
      'uq_maintenance_work_order_cycle',
      'uq_maintenance_work_order_fault',
      'idx_maintenance_work_order_priority',
      'idx_maintenance_work_order_asset',
      'idx_maintenance_work_order_sweep',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_sla_policy.sql',
    table: 'maintenance_sla_policy',
    constraints: [
      'chk_maintenance_sla_policy_criticality',
      'chk_maintenance_sla_policy_priority',
      'chk_maintenance_sla_policy_status',
      'chk_maintenance_sla_policy_response',
      'chk_maintenance_sla_policy_resolution',
    ],
    indexes: ['uq_maintenance_sla_policy_key', 'idx_maintenance_sla_policy_status'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_fault_report.sql',
    table: 'maintenance_fault_report',
    constraints: [
      'chk_maintenance_fault_report_status',
      'chk_maintenance_fault_report_accept_link',
      'chk_maintenance_fault_report_reject_reason',
    ],
    indexes: [
      'idx_maintenance_fault_report_asset',
      'idx_maintenance_fault_report_triage',
      'idx_maintenance_fault_report_location',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_downtime.sql',
    table: 'maintenance_downtime',
    constraints: [
      'chk_maintenance_downtime_window',
      'chk_maintenance_downtime_closure',
      'chk_maintenance_downtime_duration',
    ],
    indexes: [
      'uq_maintenance_downtime_work_order',
      'idx_maintenance_downtime_open',
      'idx_maintenance_downtime_period',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_reliability_metric.sql',
    table: 'maintenance_reliability_metric',
    constraints: [
      'chk_maintenance_reliability_metric_scope',
      'chk_maintenance_reliability_metric_period',
      'chk_maintenance_reliability_metric_counts',
      'chk_maintenance_reliability_metric_rates',
    ],
    indexes: [
      'uq_maintenance_reliability_metric_scope',
      'idx_maintenance_reliability_metric_report',
    ],
    appUserGrant: 'INSERT, SELECT',
  },
  {
    canonical: 'read/projections/maintenance_spare_catalogue.sql',
    table: 'maintenance_spare_catalogue',
    constraints: [
      'uq_maintenance_spare_catalogue_grain',
      'chk_maintenance_spare_catalogue_levels',
      'chk_maintenance_spare_catalogue_min_non_negative',
      'chk_maintenance_spare_catalogue_max_non_negative',
      'chk_maintenance_spare_catalogue_critical_needs_min',
    ],
    indexes: [
      'idx_maintenance_spare_catalogue_location',
      'idx_maintenance_spare_catalogue_critical',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/asset_parts_list.sql',
    table: 'asset_parts_list',
    constraints: ['uq_asset_parts_list_grain', 'chk_asset_parts_list_quantity_positive'],
    indexes: ['idx_asset_parts_list_sku', 'idx_asset_parts_list_asset'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_spare_reservation.sql',
    table: 'maintenance_spare_reservation',
    constraints: [
      'chk_maintenance_spare_reservation_status',
      'chk_maintenance_spare_reservation_quantity_positive',
      'chk_maintenance_spare_reservation_returned_non_negative',
      'chk_maintenance_spare_reservation_returned_bound',
      'chk_maintenance_spare_reservation_issue_fields',
    ],
    indexes: [
      'idx_maintenance_spare_reservation_work_order',
      'idx_maintenance_spare_reservation_grain',
      'idx_maintenance_spare_reservation_due',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_spare_alert.sql',
    table: 'maintenance_spare_alert',
    constraints: [
      'chk_maintenance_spare_alert_type',
      'uq_maintenance_spare_alert_day',
      'chk_maintenance_spare_alert_breach_fields',
      'chk_maintenance_spare_alert_overdue_fields',
    ],
    indexes: ['idx_maintenance_spare_alert_business_date', 'idx_maintenance_spare_alert_grain'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 7.5: the calibration register feeding the existing Story 1.7 lockout gate. The status
  // table itself is listed here for the first time because this story adds an index to it; its
  // CREATE body and its one constraint are unchanged and are now pinned against drift as well.
  {
    canonical: 'read/projections/instrument_calibration.sql',
    table: 'instrument_calibration_statuses',
    constraints: ['chk_instrument_calibration_status'],
    indexes: [
      'idx_instrument_calibration_statuses_instrument_id',
      'idx_instrument_calibration_statuses_instrument_id_lower',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/instrument_register.sql',
    table: 'instrument_register',
    constraints: ['uq_instrument_register_asset', 'chk_instrument_register_interval'],
    indexes: [
      'uq_instrument_register_instrument_id',
      'idx_instrument_register_location',
      'idx_instrument_register_asset',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/instrument_calibration_certificate.sql',
    table: 'instrument_calibration_certificate',
    constraints: [
      'chk_instrument_calibration_certificate_type',
      'chk_instrument_calibration_certificate_status',
      'chk_instrument_calibration_certificate_validity',
      'chk_instrument_calibration_certificate_iso_lab',
    ],
    indexes: [
      'uq_instrument_calibration_certificate_active',
      'uq_instrument_calibration_certificate_number',
      'idx_instrument_calibration_certificate_valid_until',
      'idx_instrument_calibration_certificate_instrument',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/instrument_calibration_alert.sql',
    table: 'instrument_calibration_alert',
    constraints: [
      'chk_instrument_calibration_alert_stage',
      'uq_instrument_calibration_alert_stage',
    ],
    indexes: [
      'idx_instrument_calibration_alert_business_date',
      'idx_instrument_calibration_alert_instrument',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/instrument_calibration_escalation.sql',
    table: 'instrument_calibration_escalation',
    constraints: [
      'chk_instrument_calibration_escalation_status',
      'chk_instrument_calibration_escalation_resolution',
    ],
    indexes: [
      'uq_instrument_calibration_escalation_open',
      'idx_instrument_calibration_escalation_approver',
      'idx_instrument_calibration_escalation_instrument',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 7.6: the statutory examination register (FR-M-14), its record history, the
  // machine-status projection (FR-M-16) and the per-asset maintenance cost rollup (FR-M-15).
  {
    canonical: 'read/projections/statutory_examination.sql',
    table: 'statutory_examination',
    constraints: [
      'uq_statutory_examination_asset_type',
      'chk_statutory_examination_type',
      'chk_statutory_examination_status',
      'chk_statutory_examination_interval',
    ],
    indexes: ['uq_statutory_examination_device_key', 'idx_statutory_examination_status_due'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/statutory_examination_record.sql',
    table: 'statutory_examination_record',
    constraints: ['chk_statutory_examination_record_dates'],
    indexes: [
      'uq_statutory_examination_record_number',
      'idx_statutory_examination_record_examination',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/asset_operational_status.sql',
    table: 'asset_operational_status',
    constraints: ['chk_asset_operational_status'],
    indexes: [],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  {
    canonical: 'read/projections/maintenance_asset_cost.sql',
    table: 'maintenance_asset_cost',
    constraints: [
      'chk_maintenance_asset_cost_labor_non_negative',
      'chk_maintenance_asset_cost_parts_non_negative',
      'chk_maintenance_asset_cost_total_non_negative',
    ],
    indexes: [],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 6.1: the production order projection (FR-MO-01/02/03). The expediting-pairing and
  // unreversed-counter constraints carry real semantics (AC6 and AC4 enforced by the database).
  // The production_order_number_seq and its USAGE grant live in the same canonical file (the
  // indent_number_seq pattern) but are NOT pinned here: the harness loop below asserts only CREATE
  // TABLE bodies, named constraint DO blocks, index presence and table grants, never sequences or
  // sequence grants. The sequence is exercised indirectly by the story-6-1 allocation tests.
  {
    canonical: 'read/projections/production_order.sql',
    table: 'production_order',
    constraints: [
      'chk_production_order_status',
      'chk_production_order_quantity_positive',
      'chk_production_order_source_reference_type',
      'chk_production_order_unreversed_non_negative',
      'chk_production_order_expediting_pairing',
      // Story 6.3 column upgrade (FR-MO-07/09/10): completion aggregates, the close-short decision
      // and the rework linkage. NOTE: this list pins the CONSTRAINTS only. The seven columns
      // themselves arrive by ALTER TABLE ... ADD COLUMN, which sits outside the CREATE TABLE body
      // this generic loop compares, so they are pinned by the dedicated Story 6.3 test below
      // (code review 2026-08-31 - the comment here previously claimed the loop covered them).
      'chk_production_order_completed_non_negative',
      'chk_production_order_short_close_pairing',
      'chk_production_order_rework_pairing',
    ],
    indexes: [
      'uq_production_order_number_ext',
      'uq_production_order_source_rework_event',
      'idx_production_order_status',
      'idx_production_order_plant',
      'idx_production_order_output_item',
      'idx_production_order_bom',
      'idx_production_order_business_stream',
    ],
    // Name-only matching would stay green if the partial predicate or the UNIQUE keyword were
    // dropped, and the ENTIRE semantic content of this index is that predicate: it is what makes
    // one rework order per qc.rework_requested event a database fact rather than a check-then-act
    // race (code review 2026-08-31, the uq_asset_coverage_reference precedent).
    indexBodies: [
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_production_order_source_rework_event ON production_order (source_rework_event_id) WHERE source_rework_event_id IS NOT NULL',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 6.2: the production order staging projection (FR-MO-04). The UNIQUE
  // (production_order_id, bom_line_id) grain is a table constraint, not a CREATE UNIQUE INDEX, so
  // it lives in the index list (string-presence check) while the CHECK bodies ride the guarded DO
  // blocks like every sibling. The issue-bound CHECK carries real semantics (AC1's issued_quantity
  // <= required_quantity enforced by the database). app_user carries DELETE for the cancel rollback
  // (recorded deviation, code-review decision 2026-08-28): the production_order.cancelled applier
  // deallocates staged-but-unissued stock and clears the stage rows in the same transaction.
  {
    canonical: 'read/projections/production_order_stage.sql',
    table: 'production_order_stage',
    constraints: [
      'chk_production_order_stage_supply_method',
      'chk_production_order_stage_status',
      'chk_production_order_stage_required_positive',
      'chk_production_order_stage_issued_non_negative',
      'chk_production_order_stage_issue_bound',
    ],
    indexes: [
      'uq_production_order_stage_line',
      'idx_production_order_stage_order',
      'idx_production_order_stage_status',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE, DELETE',
  },
  // Story 6.2: the production WIP ledger (FR-MO-05/06). Posting rows are append-only (never
  // deleted, never rewritten), but app_user carries UPDATE because the Counter Contract decrements
  // open_quantity on the source issue/backflush row inside the return's transaction and the return
  // applier locks that row FOR UPDATE (PostgreSQL refuses FOR UPDATE without UPDATE privilege) -
  // the recorded deviation that resolves the Table 2 "INSERT, SELECT only" line against the
  // Applier Contract (see the canonical file's banner). The pairing CHECK is the structural
  // backbone of AC5/AC6 (returns reference their source posting and carry a reason code).
  {
    canonical: 'read/projections/production_wip_ledger.sql',
    table: 'production_wip_ledger',
    constraints: [
      'chk_production_wip_posting_type',
      'chk_production_wip_quantity_positive',
      'chk_production_wip_open_non_negative',
      'chk_production_wip_posting_pairing',
    ],
    indexes: ['idx_production_wip_ledger_order', 'idx_production_wip_ledger_source_posting'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 6.3: production completions (FR-MO-07/09). One row per OUTPUT LOT, so a completion that
  // yields co-products and by-products writes several rows against one source_event_id - the grain
  // UNIQUE therefore needs NULLS NOT DISTINCT, because the primary output's bom_line_id is null.
  // Append-only: app_user holds no UPDATE and no DELETE (a completion is a posted fact; a
  // correction is a new event).
  {
    canonical: 'read/projections/production_completion.sql',
    table: 'production_completion',
    constraints: [
      'chk_production_completion_output_class',
      'chk_production_completion_quantity_positive',
      'chk_production_completion_line_pairing',
      'chk_production_completion_approval_pairing',
      'uq_production_completion_lot',
      'uq_production_completion_grain',
    ],
    indexes: [
      'idx_production_completion_order',
      'idx_production_completion_task',
      'idx_production_completion_item',
    ],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 6.3: process scrap declarations (FR-MO-08). WIP relief only - the row moves no stock and
  // is the AD-10 source document for the Phase 2 (Epic 16) FR-SC physical intake. Append-only.
  {
    canonical: 'read/projections/production_scrap_declaration.sql',
    table: 'production_scrap_declaration',
    constraints: [
      'chk_production_scrap_quantity_positive',
      'chk_production_scrap_relieved_non_negative',
      'chk_production_scrap_reason_code_present',
      // The replay/rebuild grain: one scrap_declared event, one declaration row.
      'uq_production_scrap_declaration_event',
    ],
    indexes: [
      'idx_production_scrap_declaration_order',
      'idx_production_scrap_declaration_business_date',
    ],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 7.7: the asset coverage register (AMC, warranty, insurance), its staged 90/60/30 expiry
  // alerts and the reason-coded warranty override grain (FR-M-10, FR-M-11). The coverage
  // uniqueness grain is an EXPRESSION index (lower(reference_number_ext)) and therefore lives in
  // the index list, not the constraint list; the override table is append-only, so its app_user
  // grant deliberately omits UPDATE. Review decision D3 removed the UPDATE grant from
  // asset_coverage and asset_coverage_alert too: Binding Decision 5 declares both append-only,
  // neither module exposes an UPDATE accessor, and leaving the privilege granted made the
  // deferred-work claim that a coverage can only be corrected by direct SQL false.
  {
    canonical: 'read/projections/asset_coverage.sql',
    table: 'asset_coverage',
    constraints: [
      'chk_asset_coverage_type',
      'chk_asset_coverage_provider_name',
      'chk_asset_coverage_reference_ext',
      'chk_asset_coverage_dates',
      'chk_asset_coverage_value_non_negative',
    ],
    indexes: [
      'uq_asset_coverage_reference',
      'idx_asset_coverage_asset',
      'idx_asset_coverage_expiry',
    ],
    // Review patch P2: a name-only substring match would stay green if the init-db copy lost the
    // lower() call, and the ENTIRE semantic content of this index is that call. Case-variant
    // duplicate contracts would then be insertable on container-initialised databases while the
    // migrate path kept rejecting them. Expression indexes get their body pinned, not their name.
    indexBodies: [
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_coverage_reference ON asset_coverage (asset_id, coverage_type, lower(reference_number_ext));',
    ],
    appUserGrant: 'INSERT, SELECT',
  },
  {
    canonical: 'read/projections/asset_coverage_alert.sql',
    table: 'asset_coverage_alert',
    constraints: ['chk_asset_coverage_alert_stage', 'uq_asset_coverage_alert_stage'],
    indexes: ['idx_asset_coverage_alert_business_date', 'idx_asset_coverage_alert_asset'],
    appUserGrant: 'INSERT, SELECT',
  },
  {
    canonical: 'read/projections/maintenance_warranty_override.sql',
    table: 'maintenance_warranty_override',
    constraints: [
      'uq_maintenance_warranty_override_work_order',
      'chk_maintenance_warranty_override_reason',
    ],
    indexes: ['idx_maintenance_warranty_override_coverage'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 7.8 (FR-M-18): the append-only closure ledger, keyed on work_order_id (Binding
  // Decision 9). app_user never UPDATEs it (the maintenance_warranty_override precedent).
  {
    canonical: 'read/projections/maintenance_work_order_closure.sql',
    table: 'maintenance_work_order_closure',
    constraints: [
      'chk_maintenance_work_order_closure_origin',
      'chk_maintenance_work_order_closure_codes',
    ],
    indexes: ['idx_maintenance_work_order_closure_asset'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 7.8 (FR-M-17): the supervisor-facing sync-conflict queue (Binding Decision 4).
  // Resolution mutates status, so app_user holds UPDATE (the integration_exception shape).
  {
    canonical: 'read/projections/maintenance_sync_conflict.sql',
    table: 'maintenance_sync_conflict',
    constraints: [
      'uq_maintenance_sync_conflict_event',
      'chk_maintenance_sync_conflict_reason',
      'chk_maintenance_sync_conflict_reason_pairing',
      'chk_maintenance_sync_conflict_status',
      'chk_maintenance_sync_conflict_resolution',
      'chk_maintenance_sync_conflict_resolution_note',
      'chk_maintenance_sync_conflict_resolution_pairing',
    ],
    indexes: [
      'idx_maintenance_sync_conflict_status',
      'idx_maintenance_sync_conflict_stream',
      'idx_maintenance_sync_conflict_location',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 8.1 (FR-Q-01): the inspection-plan scope-grain header. Append-only (INSERT, SELECT).
  {
    canonical: 'read/projections/inspection_plan.sql',
    table: 'inspection_plan',
    constraints: [
      'uq_inspection_plan_grain',
      'chk_inspection_plan_scope',
      'chk_inspection_plan_source_order_type',
      'chk_inspection_plan_scope_pairing',
    ],
    indexes: ['idx_inspection_plan_item_revision'],
    indexBodies: [
      'UNIQUE NULLS NOT DISTINCT (item_id, bom_revision_id, scope, source_order_type, source_order_ref)',
    ],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.1 (FR-Q-01): immutable, effective-dated plan versions carrying the Story 8.2 sampling
  // inputs. Append-only; version allocation is serialized on an advisory lock, never MAX+1.
  {
    canonical: 'read/projections/inspection_plan_version.sql',
    table: 'inspection_plan_version',
    constraints: [
      'uq_inspection_plan_version_no',
      'uq_inspection_plan_version_effective',
      'chk_inspection_plan_version_no_positive',
      'chk_inspection_plan_version_aql',
      'chk_inspection_plan_version_sampling_pairing',
      // Story 8.2 (Annex requirement 3): the Table I level vocabulary.
      'chk_inspection_plan_version_level_vocab',
    ],
    indexes: ['idx_inspection_plan_version_plan_effective'],
    indexBodies: ['ON inspection_plan_version (plan_id, effective_from DESC, version_no DESC)'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.1 (Annex requirement 4): per-line characteristic definitions with the kind/limit pairing.
  {
    canonical: 'read/projections/inspection_plan_characteristic.sql',
    table: 'inspection_plan_characteristic',
    constraints: [
      'uq_inspection_plan_characteristic_line',
      'chk_inspection_plan_characteristic_line_no',
      'chk_inspection_plan_characteristic_class',
      'chk_inspection_plan_characteristic_result_kind',
      'chk_inspection_plan_characteristic_text',
      'chk_inspection_plan_characteristic_kind_pairing',
    ],
    indexes: ['idx_inspection_plan_characteristic_version'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.1 (Binding Scope Decision 10): one append-only approval per plan version (the PK).
  {
    canonical: 'read/projections/inspection_plan_approval.sql',
    table: 'inspection_plan_approval',
    constraints: [
      'chk_inspection_plan_approval_actor_pairing',
      'chk_inspection_plan_approval_role',
    ],
    indexes: ['idx_inspection_plan_approval_plan'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.1 (FR-Q-02, Binding Scope Decision 2): the durable inspection task that IS the QC-gate
  // projection keyed by lot. The gate transition is the only UPDATE.
  {
    canonical: 'read/projections/qc_inspection_task.sql',
    table: 'qc_inspection_task',
    constraints: [
      'uq_qc_inspection_task_lot',
      'uq_qc_inspection_task_source',
      'chk_qc_inspection_task_quantity',
      'chk_qc_inspection_task_source_type',
      'chk_qc_inspection_task_status',
      'chk_qc_inspection_task_gate_status',
      'chk_qc_inspection_task_plan_scope',
      'chk_qc_inspection_task_scope_pairing',
      // Story 8.2 (Binding Scope Decision 6): the stored sampling outcome vocabulary.
      'chk_qc_inspection_task_sampling_outcome',
    ],
    indexes: ['idx_qc_inspection_task_gate', 'idx_qc_inspection_task_lot_number'],
    indexBodies: ['ON qc_inspection_task (gate_status, business_date, task_id)'],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 8.1 (FR-Q-05, AC 4): immutable deviation evidence with a database-enforced future expiry.
  {
    canonical: 'read/projections/qc_deviation.sql',
    table: 'qc_deviation',
    constraints: [
      'uq_qc_deviation_task_type',
      'chk_qc_deviation_type',
      'chk_qc_deviation_scope_kind',
      'chk_qc_deviation_text',
      'chk_qc_deviation_expiry',
    ],
    indexes: ['idx_qc_deviation_lot'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.1 (Binding Scope Decision 4): the shared one-row-per-lot disposition grain.
  {
    canonical: 'read/projections/qc_lot_disposition.sql',
    table: 'qc_lot_disposition',
    constraints: [
      'uq_qc_lot_disposition_lot',
      'chk_qc_lot_disposition_disposition',
      'chk_qc_lot_disposition_quantity',
      'chk_qc_lot_disposition_deviation_pairing',
    ],
    indexes: ['idx_qc_lot_disposition_task'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.2 (FR-Q-03, AC 1): the sampling plan frozen on a task (one per task, append-only).
  {
    canonical: 'read/projections/qc_sampling_plan.sql',
    table: 'qc_sampling_plan',
    constraints: [
      'uq_qc_sampling_plan_task',
      'chk_qc_sampling_plan_severity',
      'chk_qc_sampling_plan_basis',
      'chk_qc_sampling_plan_level',
      'chk_qc_sampling_plan_sizes',
      'chk_qc_sampling_plan_ac_re',
      'chk_qc_sampling_plan_basis_pairing',
    ],
    indexes: ['idx_qc_sampling_plan_plan_site'],
    indexBodies: ['ON qc_sampling_plan (plan_id, site_id, determined_at)'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.2 (FR-Q-03, FR-Q-04): immutable per-unit results; one per (task, characteristic, unit).
  {
    canonical: 'read/projections/qc_inspection_result.sql',
    table: 'qc_inspection_result',
    constraints: [
      'uq_qc_inspection_result_unit',
      'chk_qc_inspection_result_class',
      'chk_qc_inspection_result_unit_no',
      'chk_qc_inspection_result_kind_pairing',
      'chk_qc_inspection_result_instrument_pairing',
    ],
    indexes: [
      'idx_qc_inspection_result_task_characteristic',
      'idx_qc_inspection_result_task_recorder',
    ],
    indexBodies: [
      'ON qc_inspection_result (task_id, characteristic_id)',
      'ON qc_inspection_result (task_id, recorded_by)',
    ],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.2 (FR-Q-03, AC 3): the per-(plan, site) switching state; advanced under lock (UPDATE).
  {
    canonical: 'read/projections/qc_sampling_switching_state.sql',
    table: 'qc_sampling_switching_state',
    constraints: [
      'chk_qc_sampling_switching_state_severity',
      'chk_qc_sampling_switching_state_counters',
      'chk_qc_sampling_switching_state_window',
    ],
    indexes: [] as string[],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
  // Story 8.4 (FR-Q-07, AC 1/3/6/7): the append-only batch release record. No revision concept, so
  // app_user never holds UPDATE.
  {
    canonical: 'read/projections/qc_batch_release.sql',
    table: 'qc_batch_release',
    constraints: [
      'uq_qc_batch_release_lot',
      'uq_qc_batch_release_disposition',
      'chk_qc_batch_release_document_kind',
      'chk_qc_batch_release_retention_years',
      'chk_qc_batch_release_bis_licence_pairing',
    ],
    indexes: ['idx_qc_batch_release_task'],
    indexBodies: ['ON qc_batch_release (task_id)'],
    appUserGrant: 'INSERT, SELECT',
  },
  // Story 8.4 (FR-Q-08, AC 4/5): the retention sample; the disposal sweep is the one UPDATE.
  {
    canonical: 'read/projections/qc_retention_sample.sql',
    table: 'qc_retention_sample',
    constraints: [
      'uq_qc_retention_sample_lot',
      'chk_qc_retention_sample_quantity',
      'chk_qc_retention_sample_uom',
      'chk_qc_retention_sample_status',
      'chk_qc_retention_sample_disposal_pairing',
    ],
    indexes: ['idx_qc_retention_sample_task', 'idx_qc_retention_sample_expiry'],
    indexBodies: [
      'ON qc_retention_sample (task_id)',
      'ON qc_retention_sample (status, expires_on)',
    ],
    appUserGrant: 'INSERT, SELECT, UPDATE',
  },
];

describe('Story 2.1 schema drift guard', () => {
  const migrateSource = read('src/events/migrate.ts');
  const initDb = read('deploy/compose/init-db.sql');

  it('Story 4.6 mirrors every MSME additive column into init-db.sql and registers msme_ageing_feed in MIGRATIONS', () => {
    const supplierSql = read('read/projections/supplier.sql');
    const poSql = read('read/projections/purchase_order.sql');
    const supplierInvoiceSql = read('read/projections/supplier_invoice.sql');
    const msmeAgeingFeedSql = read('read/projections/msme_ageing_feed.sql');
    const msmeAgeingFeedMigration = "'../../read/projections/msme_ageing_feed.sql'";
    const msmeExpected = [
      'udyam_number_ext TEXT',
      'msme_classification TEXT',
      'msme_certificate_reference TEXT',
      'msme_status TEXT',
      'udyam_verified_at TIMESTAMPTZ',
      'udyam_revalidation_due_date DATE',
    ];
    for (const fragment of msmeExpected) {
      assert.ok(
        supplierSql.includes(`ADD COLUMN IF NOT EXISTS ${fragment}`),
        `supplier.sql missing ${fragment}`,
      );
      assert.ok(
        initDb.includes(`ADD COLUMN IF NOT EXISTS ${fragment}`),
        `init-db.sql missing ${fragment}`,
      );
    }
    assert.ok(
      poSql.includes('ADD COLUMN IF NOT EXISTS statutory_due_date DATE'),
      'purchase_order.sql missing statutory_due_date',
    );
    assert.ok(
      initDb.includes('ADD COLUMN IF NOT EXISTS statutory_due_date DATE'),
      'init-db.sql missing statutory_due_date',
    );
    assert.ok(
      poSql.includes('ADD COLUMN IF NOT EXISTS statutory_due_rule_version TEXT'),
      'purchase_order.sql missing statutory_due_rule_version',
    );
    assert.ok(
      initDb.includes('ADD COLUMN IF NOT EXISTS statutory_due_rule_version TEXT'),
      'init-db.sql missing statutory_due_rule_version',
    );
    assert.ok(
      supplierInvoiceSql.includes(
        'ADD COLUMN IF NOT EXISTS statutory_breach BOOLEAN NOT NULL DEFAULT false',
      ),
      'supplier_invoice.sql missing statutory_breach',
    );
    assert.ok(
      initDb.includes('ADD COLUMN IF NOT EXISTS statutory_breach BOOLEAN NOT NULL DEFAULT false'),
      'init-db.sql missing statutory_breach',
    );
    assert.ok(msmeAgeingFeedSql.includes('msme_ageing_feed'), 'msme_ageing_feed.sql missing table');
    assert.ok(
      migrateSource.includes(msmeAgeingFeedMigration),
      'src/events/migrate.ts must register msme_ageing_feed.sql',
    );
    assert.ok(
      migrateSource.indexOf(msmeAgeingFeedMigration) >
        migrateSource.lastIndexOf("'../../read/projections/supplier_invoice.sql'"),
      'msme_ageing_feed must be appended after the supplier_invoice migrations',
    );
  });

  it('Story 4.5 mirrors every match additive column into init-db.sql and registers both new projections in MIGRATIONS', () => {
    const grnSql = read('read/projections/grn.sql');
    const supplierInvoiceSql = read('read/projections/supplier_invoice.sql');
    const threeWayMatchMigration = "'../../read/projections/three_way_match.sql'";
    const clearanceFeedMigration = "'../../read/projections/payment_clearance_feed.sql'";

    assert.ok(
      grnSql.includes('ADD COLUMN IF NOT EXISTS po_id UUID'),
      'grn.sql missing native po_id binding column',
    );
    assert.ok(
      initDb.includes('ADD COLUMN IF NOT EXISTS po_id UUID'),
      'init-db.sql missing grn.po_id',
    );
    assert.ok(
      supplierInvoiceSql.includes('ADD COLUMN IF NOT EXISTS match_status TEXT'),
      'supplier_invoice.sql missing match_status',
    );
    assert.ok(
      initDb.includes('ADD COLUMN IF NOT EXISTS match_status TEXT'),
      'init-db.sql missing match_status',
    );
    // The capture-lifecycle CHECK must never be widened to carry match state (binding decision 5).
    assert.ok(
      supplierInvoiceSql.includes("CHECK (status IN ('unmatched','captured'))"),
      'chk_supplier_invoice_status must stay the two capture values',
    );
    assert.ok(
      migrateSource.includes(threeWayMatchMigration),
      'src/events/migrate.ts must register three_way_match.sql',
    );
    assert.ok(
      migrateSource.includes(clearanceFeedMigration),
      'src/events/migrate.ts must register payment_clearance_feed.sql',
    );
    assert.ok(
      migrateSource.indexOf(threeWayMatchMigration) >
        migrateSource.lastIndexOf("'../../read/projections/supplier_invoice_line.sql'"),
      'three_way_match must be appended after the supplier invoice migrations it reads',
    );
    assert.ok(
      migrateSource.indexOf(clearanceFeedMigration) > migrateSource.indexOf(threeWayMatchMigration),
      'payment_clearance_feed must be appended after three_way_match',
    );
  });

  it('Story 3.10 applies dependency-safe additive cross-dock alterations in final vocabulary order', () => {
    const grnSql = read('read/projections/grn_line.sql');
    const pickTaskSql = read('read/projections/pick_task.sql');
    const pickLineSql = read('read/projections/pick_line.sql');
    const slaSql = read('read/projections/task_sla_config.sql');
    const constraintsSql = read('read/projections/cross_dock_constraints.sql');
    const crossDockMigration = "'../../read/projections/cross_dock_task.sql'";
    const pickLineMigration = "'../../read/projections/pick_line.sql'";

    assert.ok(
      grnSql.includes('ADD COLUMN IF NOT EXISTS cross_dock BOOLEAN NOT NULL DEFAULT false'),
    );
    assert.ok(grnSql.includes('ADD COLUMN IF NOT EXISTS matched_dispatch_order_line_id UUID'));
    assert.ok(grnSql.includes('ADD COLUMN IF NOT EXISTS cross_dock_nonqualification_reason TEXT'));
    assert.ok(
      pickTaskSql.includes(
        "ADD COLUMN IF NOT EXISTS fulfillment_source TEXT NOT NULL DEFAULT 'standard'",
      ),
    );
    assert.ok(pickTaskSql.includes("CHECK (fulfillment_source IN ('standard', 'cross_dock'))"));
    assert.ok(pickLineSql.includes('ADD COLUMN IF NOT EXISTS cross_dock_task_id UUID'));
    const deferredConstraintsSql = read('read/projections/cross_dock_constraints.sql');
    assert.ok(deferredConstraintsSql.includes('ADD CONSTRAINT fk_pick_line_cross_dock_task'));
    assert.ok(deferredConstraintsSql.includes('REFERENCES cross_dock_task(cross_dock_task_id)'));
    assert.ok(
      pickLineSql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_line_cross_dock_task'),
    );
    assert.ok(pickLineSql.includes('WHERE cross_dock_task_id IS NOT NULL'));
    assert.ok(
      migrateSource.indexOf(crossDockMigration) >
        migrateSource.indexOf("'../../read/projections/replenishment_task.sql'"),
    );
    assert.ok(
      migrateSource.lastIndexOf(pickLineMigration) > migrateSource.indexOf(crossDockMigration),
    );
    assert.ok(
      migrateSource.indexOf("'../../read/projections/cross_dock_constraints.sql'") >
        migrateSource.lastIndexOf(pickLineMigration),
    );
    assert.match(
      slaSql,
      /CHECK \(task_type IN \('receiving', 'putaway', 'picking', 'packing', 'replenishment', 'cross_docking'\)\)/,
    );
    assert.match(
      initDb,
      /CHECK \(task_type IN \('receiving', 'putaway', 'picking', 'packing', 'replenishment', 'cross_docking'\)\)/,
    );
    assert.ok(
      normalizeSql(initDb).includes(normalizeSql(constraintsSql)),
      'init-db must mirror the deferred cross-dock FK block',
    );
  });

  it('Story 5.4 mirrors the R&D regime alterations into init-db.sql', () => {
    const bomSql = read('read/projections/bom.sql');
    const bomLineSql = read('read/projections/bom_line.sql');
    const partialIndex =
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_parent_item ON bom (parent_item_id) WHERE bom_type <> 'rnd';";
    // The partial predicate is what makes R&D draft cloning possible; production and
    // job_work_kit BOMs keep one-per-item uniqueness.
    assert.ok(
      bomSql.includes('DROP INDEX IF EXISTS uq_bom_parent_item;'),
      'bom.sql missing index drop',
    );
    assert.ok(bomSql.includes(partialIndex), 'bom.sql missing partial uq_bom_parent_item');
    assert.ok(
      initDb.includes('DROP INDEX IF EXISTS uq_bom_parent_item;'),
      'init-db.sql missing index drop',
    );
    assert.ok(initDb.includes(partialIndex), 'init-db.sql missing partial uq_bom_parent_item');
    for (const fragment of [
      'ADD COLUMN IF NOT EXISTS cloned_from_bom_id UUID',
      'ADD COLUMN IF NOT EXISTS productized_from_bom_id UUID',
    ]) {
      assert.ok(bomSql.includes(fragment), `bom.sql missing ${fragment}`);
      assert.ok(initDb.includes(fragment), `init-db.sql missing ${fragment}`);
    }
    for (const fragment of [
      'ALTER TABLE bom_line ALTER COLUMN component_item_id DROP NOT NULL;',
      'ALTER TABLE bom_line ALTER COLUMN component_sku DROP NOT NULL;',
      'ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT false',
      'ADD COLUMN IF NOT EXISTS free_text TEXT',
    ]) {
      assert.ok(bomLineSql.includes(fragment), `bom_line.sql missing ${fragment}`);
      assert.ok(initDb.includes(fragment), `init-db.sql missing ${fragment}`);
    }
  });

  it('Story 5.5 mirrors the supply_method additive column into init-db.sql', () => {
    const bomLineSql = read('read/projections/bom_line.sql');
    // The column lives in BOTH the CREATE TABLE body (so extractCreateTable equality holds) and an
    // ADD COLUMN IF NOT EXISTS statement (so pre-5.5 databases pick it up on re-migrate).
    for (const fragment of [
      "supply_method            TEXT NOT NULL DEFAULT 'directed_issue'",
      "ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS supply_method TEXT NOT NULL DEFAULT 'directed_issue';",
      'ALTER TABLE bom_line DROP CONSTRAINT IF EXISTS chk_bom_line_supply_method;',
      "ADD CONSTRAINT chk_bom_line_supply_method CHECK (supply_method IN ('directed_issue','backflush'))",
    ]) {
      assert.ok(bomLineSql.includes(fragment), `bom_line.sql missing ${fragment}`);
      assert.ok(initDb.includes(fragment), `init-db.sql missing ${fragment}`);
    }
  });

  it('Story 5.6 mirrors the supply_source column and the widened exception vocabulary into init-db.sql', () => {
    const bomLineSql = read('read/projections/bom_line.sql');
    const exceptionSql = read('read/projections/integration_exception.sql');
    // The column lives in BOTH the CREATE TABLE body (so extractCreateTable equality holds) and an
    // ADD COLUMN IF NOT EXISTS statement (so pre-5.6 databases pick it up on re-migrate).
    for (const fragment of [
      'supply_source            TEXT',
      'ALTER TABLE bom_line ADD COLUMN IF NOT EXISTS supply_source TEXT;',
      'ALTER TABLE bom_line DROP CONSTRAINT IF EXISTS chk_bom_line_supply_source;',
      "ADD CONSTRAINT chk_bom_line_supply_source CHECK (supply_source IS NULL OR supply_source IN ('company','customer','job_worker'))",
    ]) {
      assert.ok(bomLineSql.includes(fragment), `bom_line.sql missing ${fragment}`);
      assert.ok(initDb.includes(fragment), `init-db.sql missing ${fragment}`);
    }
    // FR-B-17: inbound BOM records queue as exceptions, so 'bom' joins the record-type vocabulary.
    // The one-open-row-per-grain index is deliberately untouched.
    for (const fragment of [
      "CHECK (record_type IN ('purchase_order', 'sales_order', 'sync_batch', 'bom'))",
      'ALTER TABLE integration_exception DROP CONSTRAINT IF EXISTS chk_integration_exception_record_type;',
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_exception_open ON integration_exception (source_system, record_type, source_record_ref, error_code) NULLS NOT DISTINCT WHERE status = 'open';",
    ]) {
      assert.ok(exceptionSql.includes(fragment), `integration_exception.sql missing ${fragment}`);
      assert.ok(initDb.includes(fragment), `init-db.sql missing ${fragment}`);
    }
    for (const fileName of [
      'bom_cost_rollup.sql',
      'bom_cost_rollup_line.sql',
      'bom_outbound_message.sql',
    ]) {
      assert.ok(
        migrateSource.includes(`'../../read/projections/${fileName}'`),
        `src/events/migrate.ts must register ${fileName}`,
      );
    }
  });

  it('Story 5.5 review mirrors the is_released_structure sync marker into init-db.sql', () => {
    const bomLineSql = read('read/projections/bom_line.sql');
    const bomAlternateSql = read('read/projections/bom_alternate.sql');
    // CREATE TABLE body fragments use each file's own column alignment.
    assert.ok(
      bomLineSql.includes('is_released_structure    BOOLEAN NOT NULL DEFAULT false'),
      'bom_line.sql CREATE body missing the marker column',
    );
    assert.ok(
      initDb.includes('is_released_structure    BOOLEAN NOT NULL DEFAULT false'),
      'init-db.sql bom_line section missing the marker column',
    );
    assert.ok(
      bomAlternateSql.includes('is_released_structure BOOLEAN NOT NULL DEFAULT false'),
      'bom_alternate.sql CREATE body missing the marker column',
    );
    assert.ok(
      initDb.includes('is_released_structure BOOLEAN NOT NULL DEFAULT false'),
      'init-db.sql bom_alternate section missing the marker column',
    );
    for (const table of ['bom_line', 'bom_alternate']) {
      const canonical = table === 'bom_line' ? bomLineSql : bomAlternateSql;
      for (const fragment of [
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_released_structure BOOLEAN NOT NULL DEFAULT false;`,
        "br.revision_status = 'released' AND b.status = 'released'",
      ]) {
        assert.ok(canonical.includes(fragment), `${table}.sql missing ${fragment}`);
        assert.ok(initDb.includes(fragment), `init-db.sql missing ${fragment} (from ${table}.sql)`);
      }
    }
  });

  // The EXPECTED loop above compares CREATE TABLE bodies, named constraint blocks, indexes and
  // grants. The four Story 7.6 cost columns are none of those: they are added by guarded
  // DO $$ ... ALTER TABLE ... ADD COLUMN blocks on an already-existing table, so drift in a column
  // type, default or guard would ship green. Pin the guard blocks themselves.
  it('Story 7.6 mirrors the additive maintenance_work_order cost columns into init-db.sql', () => {
    const workOrderSql = read('read/projections/maintenance_work_order.sql');
    for (const column of ['labor_cost', 'parts_cost', 'total_cost', 'capitalization_flagged']) {
      const key = `column_name = '${column}'`;
      assert.strictEqual(
        extractDoBlock(initDb, key),
        extractDoBlock(workOrderSql, key),
        `maintenance_work_order.${column} ADD COLUMN guard drifted from init-db.sql`,
      );
      // The guard must be schema-qualified: matching on table_name alone lets a same-named table in
      // another schema on the search path report the column as present, skipping the real ALTER and
      // leaving every cost-carrying completion to fail 42703 at runtime.
      assert.ok(
        extractDoBlock(workOrderSql, key).includes('table_schema = current_schema()'),
        `maintenance_work_order.${column} guard must be schema-qualified`,
      );
    }
    for (const fragment of [
      'ADD COLUMN labor_cost NUMERIC(14,3) NOT NULL DEFAULT 0;',
      'ADD COLUMN parts_cost NUMERIC(14,3) NOT NULL DEFAULT 0;',
      'ADD COLUMN total_cost NUMERIC(14,3) NOT NULL DEFAULT 0;',
      'ADD COLUMN capitalization_flagged BOOLEAN NOT NULL DEFAULT false;',
    ]) {
      assert.ok(workOrderSql.includes(fragment), `maintenance_work_order.sql missing ${fragment}`);
      assert.ok(
        initDb.includes(fragment),
        `init-db.sql missing ${fragment} (from maintenance_work_order.sql)`,
      );
    }
  });

  // Same reasoning as the Story 7.6 test above: the two Story 7.7 warranty columns arrive through
  // guarded ADD COLUMN blocks, so the EXPECTED loop cannot see them. A drifted default on
  // warranty_flagged would silently flag or unflag every work order the gate reads.
  it('Story 7.7 mirrors the additive maintenance_work_order warranty columns into init-db.sql', () => {
    const workOrderSql = read('read/projections/maintenance_work_order.sql');
    for (const column of ['warranty_flagged', 'warranty_coverage_id']) {
      const key = `column_name = '${column}'`;
      assert.strictEqual(
        extractDoBlock(initDb, key),
        extractDoBlock(workOrderSql, key),
        `maintenance_work_order.${column} ADD COLUMN guard drifted from init-db.sql`,
      );
      assert.ok(
        extractDoBlock(workOrderSql, key).includes('table_schema = current_schema()'),
        `maintenance_work_order.${column} guard must be schema-qualified`,
      );
    }
    for (const fragment of [
      'ADD COLUMN warranty_flagged BOOLEAN NOT NULL DEFAULT false;',
      'ADD COLUMN warranty_coverage_id UUID;',
    ]) {
      assert.ok(workOrderSql.includes(fragment), `maintenance_work_order.sql missing ${fragment}`);
      assert.ok(
        initDb.includes(fragment),
        `init-db.sql missing ${fragment} (from maintenance_work_order.sql)`,
      );
    }
    // Review decision D6: the pairing CHECK is what stops a (true, null) row that can never be
    // completed. It is an additive ALTER on an existing table, so the EXPECTED loop cannot see it.
    assert.strictEqual(
      extractDoBlock(initDb, 'chk_maintenance_work_order_warranty_pairing'),
      extractDoBlock(workOrderSql, 'chk_maintenance_work_order_warranty_pairing'),
      'chk_maintenance_work_order_warranty_pairing drifted from init-db.sql',
    );
    assert.ok(
      workOrderSql.includes(
        'CHECK ((warranty_flagged = false AND warranty_coverage_id IS NULL) OR (warranty_flagged = true AND warranty_coverage_id IS NOT NULL))',
      ),
      'the warranty pairing CHECK body must pin both directions of the pair',
    );
  });

  it('Story 8.1 registers the seven QC projections at the migration tail in dependency order', () => {
    const files = [
      'inspection_plan.sql',
      'inspection_plan_version.sql',
      'inspection_plan_characteristic.sql',
      'inspection_plan_approval.sql',
      'qc_inspection_task.sql',
      'qc_deviation.sql',
      'qc_lot_disposition.sql',
    ].map((f) => `'../../read/projections/${f}'`);
    const tail = "'../../read/projections/maintenance_sync_conflict.sql'";
    let previous = migrateSource.lastIndexOf(tail);
    assert.ok(previous >= 0, 'the Story 7.8 tail entry must still be registered');
    for (const file of files) {
      const index = migrateSource.indexOf(file);
      assert.ok(index >= 0, `src/events/migrate.ts must apply ${file}`);
      assert.ok(index > previous, `${file} must be registered after the preceding QC file`);
      previous = index;
    }
    // Grants are pinned: no DELETE anywhere in the family, UPDATE only on the gate projection.
    for (const table of [
      'inspection_plan',
      'inspection_plan_version',
      'inspection_plan_characteristic',
      'inspection_plan_approval',
      'qc_deviation',
      'qc_lot_disposition',
    ]) {
      const sql = read(`read/projections/${table}.sql`);
      assert.ok(!/GRANT[^;]*DELETE/i.test(sql), `${table} must not grant DELETE`);
      assert.ok(!/GRANT[^;]*UPDATE/i.test(sql), `${table} must not grant UPDATE`);
    }
    assert.ok(!/GRANT[^;]*DELETE/i.test(read('read/projections/qc_inspection_task.sql')));
  });

  it('Story 8.2 registers the three sampling projections after qc_lot_disposition.sql, mirrors the task widening into init-db.sql, and pins the grants', () => {
    const files = [
      'qc_sampling_plan.sql',
      'qc_inspection_result.sql',
      'qc_sampling_switching_state.sql',
    ].map((f) => `'../../read/projections/${f}'`);
    const tail = "'../../read/projections/qc_lot_disposition.sql'";
    let previous = migrateSource.lastIndexOf(tail);
    assert.ok(previous >= 0, 'the Story 8.1 tail entry must still be registered');
    for (const file of files) {
      const index = migrateSource.indexOf(file);
      assert.ok(index >= 0, `src/events/migrate.ts must apply ${file}`);
      assert.ok(index > previous, `${file} must be registered after the preceding QC file`);
      previous = index;
    }
    // The widened task-status vocabulary and the six additive columns are guarded blocks the
    // EXPECTED loop cannot see; pin each one against init-db.sql.
    const taskSql = read('read/projections/qc_inspection_task.sql');
    assert.ok(
      taskSql.includes("pg_get_constraintdef(oid) NOT LIKE '%sampling_determined%'"),
      'the task-status widening must be guarded on pg_get_constraintdef',
    );
    for (const column of [
      'sampling_id',
      'sampling_outcome',
      'nonconforming_sample_units',
      'critical_nonconformities',
      'inspected_by',
      'inspected_at',
    ]) {
      const key = `column_name = '${column}'`;
      assert.strictEqual(extractDoBlock(initDb, key), extractDoBlock(taskSql, key));
    }
    const widen = "NOT LIKE '%sampling_determined%'";
    assert.strictEqual(extractDoBlock(initDb, widen), extractDoBlock(taskSql, widen));
    const versionSql = read('read/projections/inspection_plan_version.sql');
    assert.ok(versionSql.includes("IN ('I', 'II', 'III', 'S-1', 'S-2', 'S-3', 'S-4')"));
    // Grants are pinned: no DELETE anywhere; UPDATE only on the task and the switching state.
    for (const table of ['qc_sampling_plan', 'qc_inspection_result']) {
      const sql = read(`read/projections/${table}.sql`);
      assert.ok(!/GRANT[^;]*DELETE/i.test(sql), `${table} must not grant DELETE`);
      assert.ok(!/GRANT[^;]*UPDATE/i.test(sql), `${table} must not grant UPDATE`);
    }
    const stateSql = read('read/projections/qc_sampling_switching_state.sql');
    assert.ok(!/GRANT[^;]*DELETE/i.test(stateSql));
    assert.ok(stateSql.includes('GRANT INSERT, SELECT, UPDATE ON qc_sampling_switching_state'));
  });

  it('Story 7.8 mirrors the additive maintenance_work_order status columns and the widened status CHECK into init-db.sql', () => {
    const workOrderSql = read('read/projections/maintenance_work_order.sql');
    for (const column of ['status_updated_at', 'status_updated_by', 'status_note']) {
      const key = `column_name = '${column}'`;
      assert.strictEqual(
        extractDoBlock(initDb, key),
        extractDoBlock(workOrderSql, key),
        `maintenance_work_order.${column} ADD COLUMN guard drifted from init-db.sql`,
      );
      assert.ok(
        extractDoBlock(workOrderSql, key).includes('table_schema = current_schema()'),
        `maintenance_work_order.${column} guard must be schema-qualified`,
      );
    }
    for (const fragment of [
      'ADD COLUMN status_updated_at TIMESTAMPTZ;',
      'ADD COLUMN status_updated_by UUID;',
      'ADD COLUMN status_note TEXT;',
    ]) {
      assert.ok(workOrderSql.includes(fragment), `maintenance_work_order.sql missing ${fragment}`);
      assert.ok(
        initDb.includes(fragment),
        `init-db.sql missing ${fragment} (from maintenance_work_order.sql)`,
      );
    }
    assert.strictEqual(
      extractDoBlock(initDb, 'chk_maintenance_work_order_status_note'),
      extractDoBlock(workOrderSql, 'chk_maintenance_work_order_status_note'),
      'chk_maintenance_work_order_status_note drifted from init-db.sql',
    );
    // Binding Decision 7: the five-value status vocabulary. The inline CHECK (fresh install), the
    // re-guard block (missing constraint) and the upgrade block (three-value constraint still in
    // place) must all carry the same widened body, in both files.
    const widened = "CHECK (status IN ('open', 'overdue', 'in_progress', 'on_hold', 'completed'))";
    for (const [label, sql] of [
      ['maintenance_work_order.sql', workOrderSql],
      ['init-db.sql', initDb],
    ] as const) {
      assert.ok(
        !sql.includes(
          "chk_maintenance_work_order_status CHECK (status IN ('open', 'overdue', 'completed'))",
        ),
        `${label} still carries the three-value status CHECK`,
      );
      assert.ok(
        sql.includes(`CONSTRAINT chk_maintenance_work_order_status ${widened},`),
        `${label} inline status CHECK is not the widened vocabulary`,
      );
      assert.ok(
        sql.includes("pg_get_constraintdef(oid) NOT LIKE '%in_progress%'"),
        `${label} is missing the status CHECK upgrade guard`,
      );
    }
    const upgradeBlock = (workOrderSql.match(/DO \$\$.*?END \$\$;/gis) ?? []).find((block) =>
      block.includes('pg_get_constraintdef'),
    );
    assert.ok(upgradeBlock, 'maintenance_work_order.sql is missing the status upgrade block');
    assert.ok(
      upgradeBlock.includes('DROP CONSTRAINT chk_maintenance_work_order_status') &&
        upgradeBlock.includes(widened),
      'the upgrade block must drop the narrow CHECK and re-add the widened one',
    );
    assert.ok(
      (initDb.match(/DO \$\$.*?END \$\$;/gis) ?? []).some(
        (block) => normalizeSql(block) === normalizeSql(upgradeBlock),
      ),
      'init-db.sql is missing the status upgrade block',
    );
  });

  // Review decision D2: the one-shot backfill closes AC 2 and AC 3 for breakdown work orders that
  // were already open at migration time. It lives in asset_coverage.sql because the work-order file
  // migrates first, and the column comment is its one-shot marker: without that guard a re-run
  // would retroactively flag work orders against coverages recorded after the backfill.
  it('Story 7.7 mirrors the one-shot warranty_flagged backfill into init-db.sql', () => {
    const coverageSql = read('read/projections/asset_coverage.sql');
    for (const fragment of [
      "col_description('maintenance_work_order'::regclass, marker_attnum) IS NOT NULL",
      'SELECT DISTINCT ON (asset_id) asset_id, coverage_id',
      "AND w.status IN ('open', 'overdue')",
      'COMMENT ON COLUMN maintenance_work_order.warranty_flagged IS',
    ]) {
      assert.ok(coverageSql.includes(fragment), `asset_coverage.sql backfill missing ${fragment}`);
      assert.ok(
        initDb.includes(fragment),
        `init-db.sql missing ${fragment} (from the asset_coverage.sql backfill)`,
      );
    }
  });

  // Story 6.3 (FR-MO-07/08/09/10). Two things in this story are invisible to the generic loop
  // above, and a code review on 2026-08-31 found both unguarded:
  //
  // 1. The seven production_order columns arrive by ALTER TABLE ... ADD COLUMN, which is outside
  //    the CREATE TABLE body extractCreateTable compares. Deleting them from init-db.sql left the
  //    whole suite green. Same failure mode the MSME and statutory-due upgrades above guard against
  //    with explicit fragment assertions, so this uses the same idiom.
  // 2. extractDoBlock takes the FIRST DO block naming a constraint. production_wip_ledger.sql
  //    carries the Story 6.2 add-if-missing block BEFORE the Story 6.3 widening block, so the
  //    generic comparison never read the widened definitions at all: the entire widening could be
  //    deleted from init-db.sql with no test failing. Both texts are asserted here directly.
  it('Story 6.3: the production_order column upgrade and the WIP relief widening are mirrored', () => {
    const orderSql = read('read/projections/production_order.sql');
    const wipSql = read('read/projections/production_wip_ledger.sql');
    const scrapSql = read('read/projections/production_scrap_declaration.sql');

    const columns = [
      'completed_quantity     NUMERIC(18,6) NOT NULL DEFAULT 0',
      'scrapped_quantity      NUMERIC(18,6) NOT NULL DEFAULT 0',
      'short_close_reason     TEXT',
      'short_closed_at        TIMESTAMPTZ',
      'short_closed_by        UUID',
      'source_rework_event_id UUID',
      'source_lot_id          UUID',
    ];
    for (const column of columns) {
      const fragment = `ADD COLUMN IF NOT EXISTS ${column}`;
      assert.ok(orderSql.includes(fragment), `production_order.sql missing ${fragment}`);
      assert.ok(initDb.includes(fragment), `init-db.sql missing ${fragment}`);
    }

    // The widened vocabulary and BOTH relief arms of the pairing CHECK, in every copy that states
    // them: the inline CREATE TABLE definition, the add-if-missing guard and the upgrade block.
    const widenedType =
      "posting_type IN ('directed_issue','backflush','return','completion_relief','scrap_relief')";
    assert.strictEqual(
      wipSql.split(widenedType).length - 1,
      3,
      'production_wip_ledger.sql must state the widened posting_type in all three copies (inline, add-if-missing guard, upgrade block)',
    );
    assert.ok(initDb.includes(widenedType), 'init-db.sql missing the widened posting_type');

    const reliefArms = [
      "(posting_type = 'scrap_relief' AND source_posting_id IS NOT NULL AND reason_code IS NOT NULL AND open_quantity IS NULL)",
      "(posting_type = 'completion_relief' AND source_posting_id IS NOT NULL AND reason_code IS NULL AND open_quantity IS NULL)",
    ];
    for (const arm of reliefArms) {
      assert.ok(wipSql.includes(arm), `production_wip_ledger.sql missing pairing arm: ${arm}`);
      assert.ok(initDb.includes(arm), `init-db.sql missing pairing arm: ${arm}`);
    }
    // The narrow Story 6.2 vocabulary must survive nowhere: leaving it in the add-if-missing guard
    // meant that guard could re-add the narrow constraint and abort the file before the widening.
    const narrowType = "posting_type IN ('directed_issue','backflush','return'))";
    assert.ok(
      !wipSql.includes(narrowType),
      'production_wip_ledger.sql still states the narrow Story 6.2 posting_type vocabulary',
    );

    // The upgrade guard must key on BOTH relief markers, or a half-upgraded constraint is treated
    // as already-upgraded and never repaired.
    for (const marker of ["NOT LIKE '%completion_relief%'", "NOT LIKE '%scrap_relief%'"]) {
      assert.ok(
        wipSql.includes(marker),
        `production_wip_ledger.sql upgrade guard missing ${marker}`,
      );
      assert.ok(initDb.includes(marker), `init-db.sql upgrade guard missing ${marker}`);
    }

    // The scrap replay grain.
    const scrapGrain = 'CONSTRAINT uq_production_scrap_declaration_event UNIQUE (source_event_id)';
    assert.ok(
      scrapSql.includes(scrapGrain),
      'production_scrap_declaration.sql missing the event grain',
    );
    assert.ok(initDb.includes(scrapGrain), 'init-db.sql missing the scrap event grain');
  });

  for (const entry of EXPECTED) {
    if (entry.isView) continue;
    const { canonical, table, constraints = [], indexes = [], appUserGrant } = entry;
    it(`${table}: canonical definition is in the migration list and mirrored in init-db.sql`, () => {
      const canonicalSql = read(canonical);
      const fileName = canonical.split('/').pop()!;
      assert.ok(migrateSource.includes(fileName), `src/events/migrate.ts must apply ${fileName}`);
      assert.strictEqual(
        extractCreateTable(initDb, table),
        extractCreateTable(canonicalSql, table),
      );

      for (const constraint of constraints) {
        assert.strictEqual(
          extractDoBlock(initDb, constraint),
          extractDoBlock(canonicalSql, constraint),
        );
      }
      for (const index of indexes) {
        assert.ok(canonicalSql.includes(index), `canonical SQL missing index ${index}`);
        assert.ok(initDb.includes(index), `init-db.sql missing index ${index}`);
      }
      const indexBodies = (entry as { indexBodies?: string[] }).indexBodies ?? [];
      for (const body of indexBodies) {
        assert.ok(canonicalSql.includes(body), `canonical SQL missing index body: ${body}`);
        assert.ok(initDb.includes(body), `init-db.sql missing index body: ${body}`);
      }
      const grant = appUserGrant ?? 'INSERT, SELECT, UPDATE';
      assert.ok(
        canonicalSql.includes(`GRANT ${grant} ON ${table} TO app_user`),
        `canonical missing app_user grant for ${table}`,
      );
      assert.ok(
        initDb.includes(`GRANT ${grant} ON ${table} TO app_user`),
        `init-db missing app_user grant for ${table}`,
      );
      assert.ok(
        canonicalSql.includes(`GRANT SELECT ON ${table} TO readonly_user`),
        `canonical missing readonly_user grant for ${table}`,
      );
      assert.ok(
        initDb.includes(`GRANT SELECT ON ${table} TO readonly_user`),
        `init-db missing readonly_user grant for ${table}`,
      );
    });
  }

  // View bodies (gate_dwell_metric) cannot be matched by the table-shape check above. The
  // dashboard contract depends on a fixed column list, so a body drift must fail here before it
  // can reach production.
  for (const entry of EXPECTED) {
    if (!entry.isView) continue;
    const { canonical, table } = entry;
    it(`${table}: view body is canonical and mirrored in init-db.sql`, () => {
      const canonicalSql = read(canonical);
      const fileName = canonical.split('/').pop()!;
      assert.ok(migrateSource.includes(fileName), `src/events/migrate.ts must apply ${fileName}`);
      assert.strictEqual(extractViewBody(initDb, table), extractViewBody(canonicalSql, table));
    });
  }
});

/** Extracts the SELECT-list of a CREATE VIEW block for the given view name. */
function extractViewBody(sql: string, viewName: string): string {
  const re = new RegExp(`CREATE\\s+VIEW\\s+${viewName}\\s+AS\\s+([\\s\\S]+?)\\bFROM\\b`, 'i');
  const m = re.exec(sql);
  if (!m) throw new Error(`Could not find CREATE VIEW ${viewName} in canonical SQL`);
  return m[1]!.trim();
}

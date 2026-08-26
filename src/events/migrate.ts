import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdminPool, closeAdminPool } from '../config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  '../../events/domain_events.sql',
  '../../sync/migrations/powersync.sql',
  '../../read/projections/users.sql',
  '../../read/projections/audit_log.sql',
  '../../read/projections/doa_registry.sql',
  '../../read/projections/business_stream_config.sql',
  '../../read/projections/location.sql',
  '../../read/projections/instrument_calibration.sql',
  '../../read/projections/notification.sql',
  '../../read/projections/item_master.sql',
  '../../read/projections/location_register.sql',
  '../../read/projections/stock_balance.sql',
  '../../read/projections/lot_master.sql',
  '../../read/projections/serial_master.sql',
  '../../read/projections/lot_trace.sql',
  '../../read/projections/inventory_valuation.sql',
  '../../read/projections/transfer_request.sql',
  '../../read/projections/in_transit.sql',
  '../../read/projections/cycle_count.sql',
  '../../read/projections/physical_verification.sql',
  '../../read/projections/inventory_planning.sql',
  '../../read/projections/replenishment_recommendation.sql',
  '../../read/projections/obsolescence_flag.sql',
  '../../read/projections/ownership_agreement.sql',
  '../../read/projections/erp_purchase_order.sql',
  '../../read/projections/erp_sales_order.sql',
  '../../read/projections/integration_exception.sql',
  '../../read/projections/gate_event.sql',
  '../../read/projections/weighbridge_event.sql',
  '../../read/projections/grn.sql',
  '../../read/projections/grn_line.sql',
  '../../read/projections/putaway_task.sql',
  '../../read/projections/velocity_class.sql',
  '../../read/projections/pick_task.sql',
  '../../read/projections/pick_line.sql',
  '../../read/projections/asn.sql',
  '../../read/projections/asn_line.sql',
  '../../read/projections/packing_record.sql',
  '../../read/projections/dispatch_document.sql',
  '../../read/projections/task_sla_config.sql',
  '../../read/projections/gate_dwell_metric.sql',
  '../../read/projections/forward_pick_config.sql',
  '../../read/projections/replenishment_task.sql',
  '../../read/projections/grn_line.sql',
  '../../read/projections/pick_task.sql',
  '../../read/projections/cross_dock_task.sql',
  '../../read/projections/pick_line.sql',
  '../../read/projections/cross_dock_constraints.sql',
  '../../read/projections/task_sla_config.sql',
  '../../read/projections/supplier.sql',
  '../../read/projections/indent.sql',
  '../../read/projections/indent_line.sql',
  '../../read/projections/purchase_order.sql',
  '../../read/projections/purchase_order_line.sql',
  '../../read/projections/po_outbound_message.sql',
  '../../read/projections/bom.sql',
  '../../read/projections/bom_revision.sql',
  '../../read/projections/bom_line.sql',
  '../../read/projections/bom_structure.sql',
  '../../read/projections/supplier_invoice.sql',
  '../../read/projections/supplier_invoice_line.sql',
  '../../read/projections/supplier_invoice_ingestion.sql',
  '../../read/projections/msme_ageing_feed.sql',
  '../../read/projections/three_way_match.sql',
  '../../read/projections/payment_clearance_feed.sql',
  '../../read/projections/supplier_scorecard_metric.sql',
  '../../read/projections/eco.sql',
  '../../read/projections/eco_change_line.sql',
  '../../read/projections/eco_stock_disposition.sql',
  '../../read/projections/rd_build_record.sql',
  '../../read/projections/rd_as_built_line.sql',
  '../../read/projections/rd_productization_signoff.sql',
  '../../read/projections/bom_alternate.sql',
  '../../read/projections/bom_explosion.sql',
  '../../read/projections/bom_explosion_line.sql',
  // Must run AFTER bom_alternate.sql: it publishes and grants those tables (Story 5.5, AC 4).
  '../../sync/migrations/powersync-bom.sql',
  // Story 5.6: cost rollup snapshots and the BOM outbound adapter-boundary record. Appended at
  // the tail; bom_line.sql and integration_exception.sql are already registered above and only
  // their contents changed.
  '../../read/projections/bom_cost_rollup.sql',
  '../../read/projections/bom_cost_rollup_line.sql',
  '../../read/projections/bom_outbound_message.sql',
  // Story 7.1: the company-wide maintainable asset register (AD-9), opening the maintenance stream.
  '../../read/projections/asset.sql',
  // Story 7.2: PM plans, work orders, and the usage-meter ingestion register (FR-M-02, FR-M-03).
  // Appended at the tail; no foreign keys exist between projections, so this order is logical
  // rather than dependency-forced.
  '../../read/projections/asset_meter.sql',
  '../../read/projections/asset_meter_reading.sql',
  '../../read/projections/maintenance_plan.sql',
  '../../read/projections/maintenance_work_order.sql',
  // Story 7.3: fault reporting, SLA policy, downtime capture and the monthly reliability
  // snapshot (FR-M-04, FR-M-05, FR-M-06). Appended at the tail after the Story 7.2 files; the
  // edited maintenance_work_order.sql keeps its position above and its new guarded blocks
  // re-apply harmlessly.
  '../../read/projections/maintenance_sla_policy.sql',
  '../../read/projections/maintenance_fault_report.sql',
  '../../read/projections/maintenance_downtime.sql',
  '../../read/projections/maintenance_reliability_metric.sql',
  // Story 7.4: the spare catalogue and the parts list carry no FK to item_master/asset (projections
  // never FK to each other in this codebase), so their order relative to the Epic 2 tables above is
  // free; keep them last so the maintenance block stays chronological by story.
  '../../read/projections/maintenance_spare_catalogue.sql',
  '../../read/projections/asset_parts_list.sql',
  '../../read/projections/maintenance_spare_reservation.sql',
  '../../read/projections/maintenance_spare_alert.sql',
  // Story 7.5: the calibration register that FEEDS the existing Story 1.7 lockout gate. The edited
  // instrument_calibration.sql keeps its position above (its new guarded lower() index block
  // re-applies harmlessly); these four are appended at the tail so the maintenance block stays
  // chronological by story. instrument_register carries asset_id but no FK - projections never FK
  // to each other in this codebase - so its order relative to asset.sql above is free.
  '../../read/projections/instrument_register.sql',
  '../../read/projections/instrument_calibration_certificate.sql',
  '../../read/projections/instrument_calibration_alert.sql',
  '../../read/projections/instrument_calibration_escalation.sql',
  // Story 7.6: the statutory examination register, its record history, the machine-status
  // projection and the per-asset maintenance cost rollup (FR-M-14, FR-M-15, FR-M-16). Appended at
  // the tail after the Story 7.5 files; the edited maintenance_work_order.sql keeps its position
  // above and its new guarded cost-column blocks re-apply harmlessly. No FKs exist between
  // projections, so this order is logical rather than dependency-forced.
  '../../read/projections/statutory_examination.sql',
  '../../read/projections/statutory_examination_record.sql',
  '../../read/projections/asset_operational_status.sql',
  '../../read/projections/maintenance_asset_cost.sql',
  // Story 6.1: the production order projection (FR-MO-01/02/03). Appended at the tail after the
  // Story 7.6 files; the sequence and its USAGE grant live in the same file (the indent_number_seq
  // pattern). The projection is enterprise-scoped (no site column) and no FK ties it to item_master,
  // location_register or bom, so this order is logical rather than dependency-forced.
  '../../read/projections/production_order.sql',
  // Story 7.7: the asset coverage register (AMC, warranty, insurance), its staged 90/60/30 expiry
  // alerts and the reason-coded warranty override grain (FR-M-10, FR-M-11). Appended at the tail
  // after the Story 6.1 file; the edited maintenance_work_order.sql keeps its position above and
  // its new guarded warranty-column blocks re-apply harmlessly. No FKs exist between projections,
  // so this order is logical rather than dependency-forced.
  '../../read/projections/asset_coverage.sql',
  '../../read/projections/asset_coverage_alert.sql',
  '../../read/projections/maintenance_warranty_override.sql',
];

async function migrate(): Promise<void> {
  // DDL requires admin_user - app_user has no CREATE privilege on the public schema.
  const pool = getAdminPool();
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(resolve(__dirname, migration), 'utf-8');
    console.log(`Running migration: ${migration}`);
    await pool.query(sql);
  }
  console.log('Migration complete.');
  await closeAdminPool();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

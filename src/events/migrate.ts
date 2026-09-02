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
  // above and its new guarded cost-column blocks re-apply harmlessly. These four tables carry no
  // FKs, so their order is logical rather than dependency-forced. Note this is a property of THESE
  // files, not of the migration list: cross_dock_task.sql and cross_dock_constraints.sql do carry
  // real FOREIGN KEY clauses, so the list as a whole is not free to reorder.
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
  // its new guarded warranty-column blocks re-apply harmlessly. These three tables carry no FKs, so
  // their order is logical rather than dependency-forced; the list as a whole is not, since the
  // cross-dock files above hold real FOREIGN KEY clauses.
  '../../read/projections/asset_coverage.sql',
  '../../read/projections/asset_coverage_alert.sql',
  '../../read/projections/maintenance_warranty_override.sql',
  // Story 6.2: the production order staging projection (FR-MO-04) and the append-only WIP ledger
  // (FR-MO-05/06). Appended at the tail after the Story 7.7 files. Both tables carry no FKs, so
  // their order is logical rather than dependency-forced; the list as a whole is not, since the
  // cross-dock files above hold real FOREIGN KEY clauses.
  '../../read/projections/production_order_stage.sql',
  '../../read/projections/production_wip_ledger.sql',
  // Story 7.8: the three-part closure coding ledger (FR-M-18) and the maintenance sync-conflict
  // queue (FR-M-17). Appended at the tail after the Story 6.2 files; the edited
  // maintenance_work_order.sql keeps its position above and its new guarded status-widening and
  // status-column blocks re-apply harmlessly. Neither table carries an FK, so their order is
  // logical rather than dependency-forced; the list as a whole is not, since the cross-dock files
  // above hold real FOREIGN KEY clauses.
  '../../read/projections/maintenance_work_order_closure.sql',
  '../../read/projections/maintenance_sync_conflict.sql',
  // Story 8.1: the versioned inspection-plan family (header, immutable versions, characteristic
  // lines, append-only approval evidence) and the QC gate (inspection task and gate projection,
  // immutable deviation evidence, the shared one-row-per-lot disposition) for FR-Q-01, FR-Q-02 and
  // FR-Q-05. Appended at the tail after the Story 7.8 files. None of these seven tables carries an
  // FK (plan versions reference their header, characteristics their version, tasks their lot, and
  // dispositions their deviation by plain UUID, the projection convention), so the order below is
  // logical rather than dependency-forced; the list as a whole is not, since the cross-dock files
  // above hold real FOREIGN KEY clauses.
  '../../read/projections/inspection_plan.sql',
  '../../read/projections/inspection_plan_version.sql',
  '../../read/projections/inspection_plan_characteristic.sql',
  '../../read/projections/inspection_plan_approval.sql',
  '../../read/projections/qc_inspection_task.sql',
  '../../read/projections/qc_deviation.sql',
  '../../read/projections/qc_lot_disposition.sql',
  // Story 8.2: the frozen sampling plan, the append-only inspection results and the per-(plan,
  // site) switching state for FR-Q-03 and FR-Q-04. Appended at the tail after the Story 8.1
  // files; the Story 8.2 widening of qc_inspection_task and inspection_plan_version rides those
  // files' guarded blocks above. None of the three carries an FK, so the order is logical.
  '../../read/projections/qc_sampling_plan.sql',
  '../../read/projections/qc_inspection_result.sql',
  '../../read/projections/qc_sampling_switching_state.sql',
  // Story 8.3: the parent-to-child split linkage and the non-conformance report for FR-Q-05 and
  // FR-Q-06. Appended at the tail after the Story 8.2 files; the Story 8.3 widening of
  // qc_inspection_task (gate vocabulary) and qc_lot_disposition (disposition vocabulary, nullable
  // doa_entry_id, sampling_outcome and ncr_id) rides those files' guarded blocks above, so
  // qc_lot_disposition.sql MUST stay ahead of these two. Neither carries an FK, so the order
  // between them is logical.
  '../../read/projections/qc_lot_split.sql',
  '../../read/projections/qc_ncr.sql',
  // Story 8.4: the batch release record and the retention sample for FR-Q-07 and FR-Q-08. Both
  // read qc_inspection_task and qc_lot_disposition conceptually (release is eligible only on an
  // accept/conditional_release disposition - Binding Scope Decision 1), so they are appended after
  // qc_lot_disposition.sql and the Story 8.3 files. Neither carries an FK - they are derived,
  // rebuildable projections in the same style as qc_lot_split/qc_ncr - so the order between them
  // is logical.
  '../../read/projections/qc_batch_release.sql',
  '../../read/projections/qc_retention_sample.sql',
  // Story 6.3: production completions and the scrap declaration ledger (FR-MO-07/08/09/10). The
  // production_order and production_wip_ledger upgrades ride their existing entries above.
  '../../read/projections/production_completion.sql',
  '../../read/projections/production_scrap_declaration.sql',
  // Story 8.5: the governed quality hold record and the CAPA register (FR-Q-09/FR-Q-10). Both read
  // lot_master and qc_ncr conceptually (the hold applier sets the lot_master flag; a hold-sourced
  // NCR names a hold and a CAPA), so they are appended after every file above. Neither carries an
  // FK - they are derived, rebuildable projections in the same style as qc_ncr - so the order
  // between them is logical. The qc_ncr origin/CAPA widening rides its existing entry above.
  '../../read/projections/qc_quality_hold.sql',
  '../../read/projections/qc_capa.sql',
  // Story 8.6: the minimal enforcement-contract tables for the statutory release blocks
  // (FR-Q-11 BIS licence register, FR-Q-14 Legal Metrology label master). Both are fixture-seeded
  // reference data with NO app write path in this story (Story 8.7 adds governance), carry no FK,
  // and are read by the release applier only, so they are appended at the tail. The
  // item_master.legal_metrology_required widening rides item_master.sql's guarded block above; the
  // qc_ncr defect_code widening rides qc_ncr.sql's entry above.
  '../../read/projections/compliance_bis_licence.sql',
  '../../read/projections/label_master.sql',
  // Story 8.7: expiry-alert idempotency ledger for the BIS licence 90/60/30-day sweep. Appended
  // immediately after label_master.sql per Story 8.7 Binding Scope Decision 2.
  '../../read/projections/compliance_bis_licence_alert.sql',
  // Story 6.4: the consumption variance report written by the closure gate (FR-B-08). It reads
  // production_wip_ledger and production_completion conceptually (actual consumption against the
  // primary output actually produced), so it is appended after both. It carries no FK - a derived,
  // rebuildable projection in the same style as production_scrap_declaration - so its position
  // relative to the Epic 8 files above is logical only.
  '../../read/projections/production_consumption_variance.sql',
  // Story 8.8: witnessed / third-party inspection hold points and their notice ledger (FR-Q-15).
  // The hold-point applier places a normal governed qc_quality_hold row and sets the lot_master
  // flag, so both files are appended after qc_quality_hold.sql and lot_master.sql. Neither carries
  // an FK - they are derived, rebuildable projections in the same style as qc_quality_hold - so
  // the order between them is logical (hold point first, then its notice ledger).
  '../../read/projections/qc_witness_hold_point.sql',
  '../../read/projections/qc_witness_notice.sql',
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

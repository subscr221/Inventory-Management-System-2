import type { EventEnvelope } from './store.js';

/**
 * Event types introduced by Story 2.5: Inter-Location Transfer Requests.
 *
 * `qc.lot_dispositioned` (once reserved here) is registered by Epic 8 Story 8.3 with the QC event
 * block at the tail of SUPPORTED_EVENT_TYPES; Story 4.2's quality-acceptance scorecard applier is
 * active against it.
 */

// ---------------------------------------------------------------------------
// Task 1: TransferRequestCreated
// ---------------------------------------------------------------------------
export interface TransferRequestCreatedPayload {
  transfer_request_id: string;
  sku_id: string;
  quantity: number;
  from_location_id: string;
  to_location_id: string;
  lot_id?: string;
  serial_ids?: string[];
  business_stream: string;
  notes?: string;
  approver_actor_id?: string;
  status: 'pending_approval' | 'approved' | 'rejected' | 'pending_shipment';
}

export interface TransferRequestCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'transfer_request.created';
  payload: TransferRequestCreatedPayload;
}

// ---------------------------------------------------------------------------
// Task 5: TransferShipCreated
// ---------------------------------------------------------------------------
export interface TransferShipCreatedPayload {
  transfer_request_id: string;
  shipped_quantity: number;
  lot_id: string;
  serial_ids?: string[];
  notes?: string;
  correlation_id: string;
}

export interface TransferShipCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'transfer_ship.created';
  payload: TransferShipCreatedPayload;
}

// ---------------------------------------------------------------------------
// Task 6: TransferReceiveCreated
// ---------------------------------------------------------------------------
export interface TransferReceiveCreatedPayload {
  transfer_request_id: string;
  received_quantity: number;
  lot_id: string;
  serial_ids?: string[];
  received_at_location_id: string;
  received_date?: string;
  notes?: string;
  correlation_id: string;
}

export interface TransferReceiveCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'transfer_receive.created';
  payload: TransferReceiveCreatedPayload;
}

// ---------------------------------------------------------------------------
// Task 3/4: Approval events
// ---------------------------------------------------------------------------
export interface ApprovalDecidedPayload {
  transfer_request_id: string;
  approved: boolean;
  reason_code?: string;
  notes?: string;
  approver_actor_id: string;
}

export interface ApprovalDecidedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'transfer_request.approval_decided';
  payload: ApprovalDecidedPayload;
}

// ---------------------------------------------------------------------------
// Story 2.6: Cycle Counting and Physical Inventory
// ---------------------------------------------------------------------------

export interface CycleCountLineInput {
  sku: string;
  lot_id?: string;
  stock_class?: string;
  counted_quantity: number;
  serials?: string[];
  unit_cost?: number;
}

export interface CycleCountTaskCreatedPayload {
  cycle_count_id: string;
  location_id: string;
  zone_id?: string;
  sku_scope: string[];
  stock_class?: string;
  count_type: string;
  business_date: string;
  business_stream: string;
  tolerance_percent?: number;
  created_by_actor_id: string;
  notes?: string;
}

export interface CycleCountSubmittedPayload {
  cycle_count_id: string;
  lines: CycleCountLineInput[];
  submitted_by_actor_id: string;
  submitted_at: string;
  business_date: string;
  business_stream: string;
  /** Approver resolved by the HTTP handler via the DOA registry for tolerance-breaching lines. */
  approver_actor_id?: string;
}

export interface CycleCountAdjustmentApprovedPayload {
  adjustment_id: string;
  cycle_count_id: string;
  approver_actor_id: string;
  reason_code: string;
  approved_at: string;
  business_stream: string;
}

export interface CycleCountAdjustmentRejectedPayload {
  adjustment_id: string;
  cycle_count_id: string;
  approver_actor_id: string;
  reason_code: string;
  rejected_at: string;
  business_stream: string;
}

export interface StockAdjustedPayload {
  adjustment_id: string;
  cycle_count_id: string;
  sku: string;
  target_location_id: string;
  lot_id?: string;
  stock_class?: string;
  delta_quantity: number;
  variance_value?: number;
  reason_code: string;
  approver_actor_id: string;
  business_stream: string;
}

export interface PhysicalVerificationCompletedPayload {
  physical_verification_id: string;
  location_id: string;
  coverage_percentage: number;
  period_start?: string;
  period_end?: string;
  count_refs: string[];
  completed_by_actor_id: string;
  business_date: string;
  business_stream: string;
}

export interface PhysicalVerificationSignedOffPayload {
  physical_verification_id: string;
  management_signoff_actor_id: string;
  signed_off_at: string;
  business_date: string;
  business_stream: string;
}

// ---------------------------------------------------------------------------
// Story 2.7: Safety Stock, Reorder Points, and Obsolescence Flagging
// ---------------------------------------------------------------------------

export interface InventoryPlanningParamsSetPayload {
  planning_params_id: string;
  sku: string;
  location_id: string;
  lead_time_days?: number;
  lead_time_source?: string;
  service_level: number;
  obsolescence_threshold_days?: number;
  standard_order_qty?: number;
  demand_window_days?: number;
  business_stream: string;
  set_by_actor_id: string;
}

export interface InventoryPlanningParamsSetEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'inventory_planning.params_set';
  payload: InventoryPlanningParamsSetPayload;
}

export interface SafetyStockComputationInputs {
  sigma_daily: number;
  avg_daily_demand: number;
  z: number;
  service_level: number;
  lead_time_days: number;
  lead_time_source: string;
  demand_window_days: number;
  sample_day_count: number;
}

export interface SafetyStockComputedPayload {
  computation_id: string;
  planning_params_id: string;
  sku: string;
  location_id: string;
  safety_stock: number;
  reorder_point: number;
  avg_daily_demand: number;
  demand_std_dev: number;
  computation_inputs: SafetyStockComputationInputs;
  computed_at: string;
  business_date: string;
  business_stream: string;
}

export interface SafetyStockComputedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'inventory_planning.safety_stock_computed';
  payload: SafetyStockComputedPayload;
}

export interface ReplenishmentRecommendedPayload {
  recommendation_id: string;
  sku: string;
  location_id: string;
  on_hand_at_check: number;
  reorder_point: number;
  recommended_order_qty: number;
  /** Story 2.8: 'internal' (default, owned-stock reorder) or 'vmi_replenishment'. */
  signal_type?: 'internal' | 'vmi_replenishment';
  /** Story 2.8: owner-party supplier code; required when signal_type is 'vmi_replenishment'. */
  owner_party_code?: string;
  triggered_at: string;
  business_date: string;
  business_stream: string;
}

export interface ReplenishmentRecommendedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'replenishment.recommended';
  payload: ReplenishmentRecommendedPayload;
}

export interface ObsolescenceFlaggedPayload {
  obsolescence_flag_id: string;
  sku: string;
  location_id: string;
  last_issue_at: string | null;
  days_since_issue: number;
  threshold_days: number;
  disposition_status: string;
  nrv_testing_triggered: boolean;
  flagged_at: string;
  business_date: string;
  business_stream: string;
}

export interface ObsolescenceFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'obsolescence.flagged';
  payload: ObsolescenceFlaggedPayload;
}

export interface ObsolescenceClearedPayload {
  obsolescence_flag_id: string;
  sku: string;
  location_id: string;
  cleared_at: string;
  reason: string;
  business_date: string;
  business_stream: string;
}

export interface ObsolescenceClearedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'obsolescence.cleared';
  payload: ObsolescenceClearedPayload;
}

// ---------------------------------------------------------------------------
// Story 2.8: Consignment and VMI Stock Segregation
// ---------------------------------------------------------------------------

export interface OwnershipAgreementSetPayload {
  agreement_id: string;
  sku: string;
  location_id: string;
  stock_class: 'consignment' | 'vmi';
  owner_party_code: string;
  /** VMI agreement minimum (Story 2.8 SKU-location config). null clears; omitted preserves. */
  vmi_min_qty?: number | null;
  active?: boolean;
  business_stream: string;
  set_by_actor_id?: string;
}

export interface OwnershipAgreementSetEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'ownership.agreement_set';
  payload: OwnershipAgreementSetPayload;
}

export interface GateEnteredPayload {
  gate_event_id: string;
  site_code_ext: string;
  po_ref_ext: string;
  vehicle_reg_ext: string;
  challan_number_ext?: string;
  challan_photo_ref: string;
  driver_name?: string;
  gate_id: string;
  gate_officer_id: string;
  entered_at: string;
}

export interface GateEnteredEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'gate.entered';
  payload: GateEnteredPayload;
}

export interface GateReversedPayload {
  gate_event_id: string;
  reversal_reason: string;
  reversed_by: string;
}

export interface GateReversedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'gate.reversed';
  payload: GateReversedPayload;
}

// Story 3.3: weighbridge event capture (net = gross - tare, tolerance enforced against the
// Story 2.9 open-PO line). correlation_id is the Story 3.2 binding token. NUMERIC weights are
// carried as strings or numbers on the wire but never rounded/compared as JS floats downstream.
export interface WeighbridgeRecordedPayload {
  weighbridge_event_id: string;
  correlation_id: string;
  tare_kg: number | string;
  gross_kg: number | string;
  net_kg?: number | string;
  po_ref_ext: string;
  line_no: number;
  site_code_ext?: string;
  device_id: string;
  capture_method: 'AUTO' | 'MANUAL';
  weighed_by: string;
}

export interface WeighbridgeRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'weighbridge.recorded';
  payload: WeighbridgeRecordedPayload;
}

// ---------------------------------------------------------------------------
// Story 3.4: Goods Receiving Against ASN or PO (FR-W-02)
// ---------------------------------------------------------------------------

// The receiving envelope is a superset of a stock receipt plus GRN metadata. correlation_id is the
// Story 3.2 binding token (the accepted-weighment chain, AD-2). received_by is NEVER trusted from the
// client payload - the API and edge paths server-set it from auth. NUMERIC quantities travel as
// strings and are never rounded/compared as JS floats until the synthetic stock-receipt view posts
// stock through the existing Story 2.2/2.3 projection helpers.
export interface GoodsReceivedPayload {
  grn_id: string;
  grn_line_id: string;
  correlation_id: string;
  po_ref_ext: string;
  line_no: number;
  source_document: 'PO' | 'ASN';
  source_ref_ext?: string | null;
  sku: string;
  target_location_id?: string;
  target_location_code?: string;
  received_qty: number | string;
  lot_id?: string;
  expiry_date?: string;
  serials?: Array<{ serial_number: string; initial_quantity?: number }>;
  stock_class?: 'owned' | 'consignment' | 'vmi' | 'job_work';
  owner_party_code?: string;
  unit_cost?: number | string;
  quarantine_approved?: boolean;
  quarantine_reason_code?: string;
  cross_dock?: boolean;
  staging_zone_id?: string;
  staging_zone_code?: string;
  /** Server-generated before persistence; projection identifiers are never generated during replay. */
  cross_dock_task_id?: string;
  /** Server-set from auth on both HTTP and edge paths; never trusted from the client. */
  received_by?: string;
}

export interface GoodsReceivedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'goods.received';
  payload: GoodsReceivedPayload;
}

// Auditable manual release of a held putaway task (AC3). released_by and approver_actor_id are
// server-set from auth; reason_code is carried so the standard persistEvent audit path records it.
export interface GoodsPutawayReleasedPayload {
  putaway_task_id: string;
  grn_line_id: string;
  reason_code: string;
  released_by?: string;
  approver_actor_id?: string;
}

export interface GoodsPutawayReleasedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'goods.putaway_released';
  payload: GoodsPutawayReleasedPayload;
}

// ---------------------------------------------------------------------------
// Story 3.5: Directed Putaway and Location Override Recording (FR-W-03)
// ---------------------------------------------------------------------------

// Location override records when an operator places a lot in a different bin than the
// system's directed suggestion. Asserted and expected locations are both captured per
// AD-15. overridden_by is server-set from auth; never trusted from client payload.
export interface LocationOverridePayload {
  putaway_task_id: string;
  lot_id: string;
  asserted_location_code: string;
  expected_location_code: string;
  reason_code: string;
  confidence: 'certain' | 'uncertain';
  /** Server-set from auth on both HTTP and edge paths; never trusted from the client. */
  overridden_by?: string;
}

export interface LocationOverrideEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'location.override';
  payload: LocationOverridePayload;
}

// Putaway completion marks when an operator finishes placing a lot in a bin, optionally
// recording an override. completed_by is server-set from auth; never trusted from client.
export interface PutawayCompletedPayload {
  putaway_task_id: string;
  actual_location_id?: string;
  actual_location_code?: string;
  correlation_id: string;
  override_reason_code?: string;
  override_confidence?: 'certain' | 'uncertain';
  /** Server-set from auth on both HTTP and edge paths; never trusted from the client. */
  completed_by?: string;
}

export interface PutawayCompletedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'putaway.completed';
  payload: PutawayCompletedPayload;
}

// ---------------------------------------------------------------------------
// Story 3.6: Pick Task Generation and Execution (FR-W-04)
// ---------------------------------------------------------------------------

// One directed pick line inside a pick_task.created envelope. The generator (not the client)
// computes the FEFO lot, bin location and pick sequence; quantities travel as NUMERIC strings.
export interface PickLineInput {
  pick_line_id: string;
  dispatch_order_line_id: string;
  sku: string;
  directed_lot_id: string;
  directed_quantity: number | string;
  location_id: string;
  pick_sequence: number;
}

// Pick task creation carries the full directed picture: the primary dispatch-order line, the
// strategy, and every generated pick line. created_by is server-set from auth; never trusted
// from the client payload.
export interface PickTaskCreatedPayload {
  pick_task_id: string;
  dispatch_order_id: string;
  sku: string;
  quantity: number | string;
  lot_id: string;
  location_id: string;
  pick_sequence: number;
  strategy: 'single' | 'batch' | 'wave' | 'zone';
  wave_id?: string | null;
  batch_id?: string | null;
  zone_id: string;
  pick_lines: PickLineInput[];
  /** Server-set from auth on both HTTP and edge paths; never trusted from the client. */
  created_by?: string;
}

export interface PickTaskCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'pick_task.created';
  payload: PickTaskCreatedPayload;
}

// Pick line confirmation records the lot actually picked. override_reason is required (enforced
// in-transaction) when confirmed_lot_id differs from the directed lot (AC6/AC8). confirmed_by and
// confirmed_at are server-set; never trusted from the client payload.
export interface PickLineConfirmedPayload {
  pick_task_id: string;
  pick_line_id: string;
  confirmed_lot_id: string;
  confirmed_quantity: number | string;
  override_reason?: string | null;
  capture_method: 'PWA' | 'PAPER';
  /** Server-set from auth on both HTTP and edge paths; never trusted from the client. */
  confirmed_by?: string;
  /** Server-set; never trusted from the client. */
  confirmed_at?: string;
}

export interface PickLineConfirmedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'pick_line.confirmed';
  payload: PickLineConfirmedPayload;
}

// Fires when ALL pick lines for a task are confirmed (AC7). completed_by/completed_at are
// server-set; never trusted from the client payload.
export interface PickTaskCompletedPayload {
  pick_task_id: string;
  dispatch_order_id: string;
  /** Server-set from auth on both HTTP and edge paths; never trusted from the client. */
  completed_by?: string;
  /** Server-set; never trusted from the client. */
  completed_at?: string;
}

export interface PickTaskCompletedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'pick_task.completed';
  payload: PickTaskCompletedPayload;
}

// ---------------------------------------------------------------------------
// Story 3.7: packing, documents, dispatch
// ---------------------------------------------------------------------------
export interface DispatchPackedPayload {
  packing_record_id: string;
  dispatch_order_id: string;
  sku: string;
  packed_qty: number | string;
  lot_id: string;
  actual_weight_kg?: number | string | null;
  label_ref?: string | null;
  carton_count: number;
  packed_by?: string;
  packed_at?: string;
}

export interface DispatchPackedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'dispatch.packed';
  payload: DispatchPackedPayload;
}

export interface DispatchShippingDocumentsGeneratedPayload {
  dispatch_order_id: string;
  document_types: string[];
  generated_by?: string;
  generated_at?: string;
}

export interface DispatchShippingDocumentsGeneratedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'dispatch.shipping_documents_generated';
  payload: DispatchShippingDocumentsGeneratedPayload;
}

export interface DispatchDispatchedPayload {
  dispatch_order_id: string;
  dispatched_by?: string;
  dispatched_at?: string;
}

export interface DispatchDispatchedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'dispatch.dispatched';
  payload: DispatchDispatchedPayload;
}

// ---------------------------------------------------------------------------
// Story 3.8: warehouse task management - configurable SLA thresholds
// ---------------------------------------------------------------------------
export type WarehouseTaskType =
  'receiving' | 'putaway' | 'picking' | 'packing' | 'replenishment' | 'cross_docking';

export interface TaskSlaConfigUpdatedPayload {
  /**
   * The site this threshold governs. Part of the grain, not decoration: without it a null-zone row
   * is the single deployment-wide default and one site's supervisor silently changes what counts as
   * a breach everywhere else. Validated against the actor's permitted sites in the compliance seam.
   */
  site_id: string;
  task_type: WarehouseTaskType;
  /** Omitted or null sets the site-wide default threshold for this task type, within site_id. */
  zone_id?: string | null;
  threshold_minutes: number | string;
  /** Server-set from metadata.actor.user_id; a client-supplied value is ignored. */
  updated_by?: string;
}

export interface TaskSlaConfigUpdatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'task_sla_config.updated';
  payload: TaskSlaConfigUpdatedPayload;
}

/**
 * Story 3.8 code review: putaway assignment used to be written straight to the read model by the
 * HTTP handler, with no domain event and no audit entry - the only warehouse state mutation in the
 * codebase without one. A projection rebuild silently discarded every assignment, and the SOD gate
 * lived only in the handler, so a direct POST /api/v1/events could not be checked by it. Assignment
 * is now a first-class event so it replays, audits, and passes through the same seam as every other
 * privileged warehouse write.
 */
/**
 * The priority union is restated inline here rather than imported from
 * src/read/projections/pick_task.ts, which is its canonical home. The events layer must not depend
 * on the read layer; pick_task.ts's isTaskPriority remains the single runtime validator, and
 * test/unit/schema-drift.test.ts pins the CHECK constraint that both must agree with.
 */
export interface PutawayTaskAssignedPayload {
  putaway_task_id: string;
  assigned_to: string;
  /** Optional re-prioritisation applied with the assignment; omitted leaves the priority as-is. */
  priority?: 'low' | 'normal' | 'high' | 'urgent' | null;
  /** Server-set from metadata.actor.user_id; a client-supplied value is ignored. */
  assigned_by?: string;
}

export interface PutawayTaskAssignedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'putaway_task.assigned';
  payload: PutawayTaskAssignedPayload;
}

export interface PickTaskAssignedPayload {
  pick_task_id: string;
  assigned_to: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | null;
  assigned_by?: string;
}

export interface PickTaskAssignedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'pick_task.assigned';
  payload: PickTaskAssignedPayload;
}

// ---------------------------------------------------------------------------
// Story 3.9: Forward-Pick Replenishment (FR-W-08)
// ---------------------------------------------------------------------------

/**
 * Mirrors TaskSlaConfigUpdatedPayload's grain-as-config shape: forward_pick_config is that story's
 * twin projection (a supervisor-configured min/max threshold keyed by a zone). site_id is
 * deliberately NOT a payload field - it is denormalized at write time from the zone's own site_id
 * in the compliance seam, so a client cannot claim a site the zone does not actually belong to.
 */
export interface ForwardPickConfigUpdatedPayload {
  sku: string;
  zone_id: string;
  min_qty: number | string;
  max_qty: number | string;
  /** Server-set from metadata.actor.user_id; a client-supplied value is ignored. */
  updated_by?: string;
}

export interface ForwardPickConfigUpdatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'forward_pick_config.updated';
  payload: ForwardPickConfigUpdatedPayload;
}

export interface ReplenishmentTaskCreatedPayload {
  replenishment_task_id: string;
  sku: string;
  zone_id: string;
  site_id: string;
  from_location_id?: string | null;
  quantity: number | string;
  signal_type: 'min_max' | 'demand_signal';
}

export interface ReplenishmentTaskCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'replenishment_task.created';
  payload: ReplenishmentTaskCreatedPayload;
}

export interface ReplenishmentTaskCompletedPayload {
  replenishment_task_id: string;
  to_location_id?: string;
  to_location_code?: string;
  /** Server-set from metadata.actor.user_id; a client-supplied value is ignored. */
  completed_by?: string;
}

export interface ReplenishmentTaskCompletedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'replenishment_task.completed';
  payload: ReplenishmentTaskCompletedPayload;
}

export interface ReplenishmentTaskAssignedPayload {
  replenishment_task_id: string;
  assigned_to: string;
  /** Server-set from metadata.actor.user_id; a client-supplied value is ignored. */
  assigned_by?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | null;
}

export interface ReplenishmentTaskAssignedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'replenishment_task.assigned';
  payload: ReplenishmentTaskAssignedPayload;
}

export interface CrossDockTaskAssignedPayload {
  cross_dock_task_id: string;
  assigned_to: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent' | null;
  /** Server-set from metadata.actor.user_id; never trusted from the client. */
  assigned_by?: string;
}

export interface CrossDockTaskAssignedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'cross_dock_task.assigned';
  payload: CrossDockTaskAssignedPayload;
}

export interface CrossDockTaskCompletedPayload {
  cross_dock_task_id: string;
  to_location_id?: string;
  to_location_code?: string;
  /** Server-generated deterministic identifiers carried in the stored event for replay. */
  pick_task_id: string;
  pick_line_id: string;
  /** Server-set from metadata.actor.user_id; never trusted from the client. */
  completed_by?: string;
}

export interface CrossDockTaskCompletedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'cross_dock_task.completed';
  payload: CrossDockTaskCompletedPayload;
}

// ---------------------------------------------------------------------------
// Story 4.1: Supplier Registry and Onboarding
// ---------------------------------------------------------------------------

export interface SupplierRegisteredPayload {
  supplier_id: string;
  legal_name: string;
  owner_party_code: string;
  gstin_ext?: string;
  pan_ext?: string;
  contacts: Array<{ name: string; email?: string; phone?: string; designation?: string }>;
  credit_period_days: number;
  commercial_terms?: string;
  freight_terms?: string;
  delivery_terms?: string;
  certification_references: Array<{
    type: string;
    reference_number: string;
    issuer?: string;
    valid_until?: string;
  }>;
}

export interface SupplierRegisteredEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.registered';
  payload: SupplierRegisteredPayload;
}

export interface SupplierOnboardingSubmittedPayload {
  supplier_id: string;
  documents: Array<{ type: string; reference: string; file_hash: string }>;
  submitted_at?: string;
  submitted_by?: string;
}

export interface SupplierOnboardingSubmittedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.onboarding_submitted';
  payload: SupplierOnboardingSubmittedPayload;
}

export interface SupplierOnboardingApprovedPayload {
  supplier_id: string;
  approver_actor_id: string;
  doa_band_id?: string;
  approved_at?: string;
}

export interface SupplierOnboardingApprovedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.onboarding_approved';
  payload: SupplierOnboardingApprovedPayload;
}

export interface SupplierOnboardingRejectedPayload {
  supplier_id: string;
  rejection_reason: string;
  approver_actor_id: string;
  rejected_at?: string;
}

export interface SupplierOnboardingRejectedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.onboarding_rejected';
  payload: SupplierOnboardingRejectedPayload;
}

export interface SupplierUpdatedPayload {
  supplier_id: string;
  contacts?: Array<{ name: string; email?: string; phone?: string; designation?: string }>;
  credit_period_days?: number;
  commercial_terms?: string;
  freight_terms?: string;
  delivery_terms?: string;
  certification_references?: Array<{
    type: string;
    reference_number: string;
    issuer?: string;
    valid_until?: string;
  }>;
}

export interface SupplierUpdatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.updated';
  payload: SupplierUpdatedPayload;
}

export interface SupplierDeactivatedPayload {
  supplier_id: string;
  reason_code: string;
  actor_id: string;
  deactivated_at?: string;
}

export interface SupplierDeactivatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.deactivated';
  payload: SupplierDeactivatedPayload;
}

// ---------------------------------------------------------------------------
// Story 4.3: Purchase Requisition and Indent Loop
// ---------------------------------------------------------------------------

export interface IndentLineInput {
  sku: string;
  item_category: string;
  requested_qty: number;
  uom: string;
  unit_price_estimate?: number;
}

export interface IndentRaisedPayload {
  indent_id: string;
  requester_user_id: string;
  department_code: string;
  site_id: string;
  need_by_date: string;
  urgent?: boolean;
  reason?: string;
  lines: IndentLineInput[];
  estimated_value?: number;
  approver_actor_id?: string;
  doa_entry_id?: string;
  duplicate_window_days?: number;
}

export interface IndentRaisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.raised';
  payload: IndentRaisedPayload;
}

export interface IndentDuplicateFlaggedPayload {
  indent_id: string;
  duplicate_of_indent_id: string;
}

export interface IndentDuplicateFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.duplicate_flagged';
  payload: IndentDuplicateFlaggedPayload;
}

export interface IndentConfirmedPayload {
  indent_id: string;
}

export interface IndentConfirmedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.confirmed';
  payload: IndentConfirmedPayload;
}

export interface IndentWithdrawnPayload {
  indent_id: string;
}

export interface IndentWithdrawnEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.withdrawn';
  payload: IndentWithdrawnPayload;
}

export interface IndentApprovedPayload {
  indent_id: string;
  approver_actor_id: string;
  approved_at?: string;
}

export interface IndentApprovedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.approved';
  payload: IndentApprovedPayload;
}

export interface IndentRejectedPayload {
  indent_id: string;
  rejection_reason: string;
  approver_actor_id: string;
  rejected_at?: string;
}

export interface IndentRejectedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.rejected';
  payload: IndentRejectedPayload;
}

export interface IndentOrderedPayload {
  indent_id: string;
  purchase_order_id: string;
  expected_delivery_date?: string;
}

export interface IndentOrderedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.ordered';
  payload: IndentOrderedPayload;
}

export interface IndentCancelledPayload {
  indent_id: string;
  cancelled_reason?: string;
}

export interface IndentCancelledEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.cancelled';
  payload: IndentCancelledPayload;
}

export interface IndentClosedPayload {
  indent_id: string;
}

export interface IndentClosedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'indent.closed';
  payload: IndentClosedPayload;
}

// ---------------------------------------------------------------------------
// Story 4.4: Purchase Order lifecycle
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineInput {
  sku: string;
  item_category: string;
  ordered_qty: number;
  uom: string;
  unit_price: number;
  tax_rate_pct?: number;
}

export interface PurchaseOrderDraftedPayload {
  po_id: string;
  po_type: 'standard' | 'blanket' | 'contract';
  supplier_id: string;
  indent_id: string;
  site_id: string;
  /** Inherited from the source indent (AC1); required by the FR-AC-01 tagging gate. */
  business_stream: string;
  lines: PurchaseOrderLineInput[];
  ceiling_value?: number;
  currency?: string;
  payment_terms?: string;
  approver_actor_id?: string;
  doa_entry_id?: string;
}

export interface PurchaseOrderDraftedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'purchase_order.drafted';
  payload: PurchaseOrderDraftedPayload;
}

export interface PurchaseOrderApprovedPayload {
  po_id: string;
  approver_actor_id: string;
  approved_at?: string;
}

export interface PurchaseOrderApprovedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'purchase_order.approved';
  payload: PurchaseOrderApprovedPayload;
}

export interface PurchaseOrderRejectedPayload {
  po_id: string;
  rejection_reason: string;
  approver_actor_id: string;
  rejected_at?: string;
}

export interface PurchaseOrderRejectedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'purchase_order.rejected';
  payload: PurchaseOrderRejectedPayload;
}

export interface PurchaseOrderIssuedPayload {
  po_id: string;
  issued_at?: string;
}

export interface PurchaseOrderIssuedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'purchase_order.issued';
  payload: PurchaseOrderIssuedPayload;
}

export interface PurchaseOrderConfirmedPayload {
  po_id: string;
  promised_delivery_date: string;
  line_promised_dates?: Record<string, string>;
}

export interface PurchaseOrderConfirmedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'purchase_order.confirmed';
  payload: PurchaseOrderConfirmedPayload;
}

export interface PurchaseOrderReleaseRecordedPayload {
  po_id: string;
  release_value: number;
  release_reference: string;
}

export interface PurchaseOrderReleaseRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'purchase_order.release_recorded';
  payload: PurchaseOrderReleaseRecordedPayload;
}

export interface PurchaseOrderCeilingRevisedPayload {
  po_id: string;
  new_ceiling_value: number;
}

export interface PurchaseOrderCeilingRevisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'purchase_order.ceiling_revised';
  payload: PurchaseOrderCeilingRevisedPayload;
}

// ---------------------------------------------------------------------------
// Story 4.7: Supplier Invoice Capture
// ---------------------------------------------------------------------------

export interface SupplierInvoiceLineInput {
  /** Present only when the line ties back to a native Story 4.4 PO line. */
  po_line_id?: string;
  sku: string;
  quantity: number;
  uom: string;
  unit_price: number;
  taxable_value: number;
  cgst_amount?: number;
  sgst_amount?: number;
  igst_amount?: number;
  cess_amount?: number;
  line_total: number;
}

export interface InvoiceIngestionStagedPayload {
  ingestion_id: string;
  source_format: 'pdf' | 'csv' | 'xml';
  attachment_ref: string;
  sha256_hash: string;
  detected_mime: string;
  byte_size: number;
  extracted_draft: Record<string, unknown>;
  /** Server-set from auth; never trusted from the client. */
  uploaded_by?: string;
}

export interface InvoiceIngestionStagedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'invoice_ingestion.staged';
  payload: InvoiceIngestionStagedPayload;
}

export interface InvoiceIngestionReviewedPayload {
  ingestion_id: string;
  corrected_header: {
    supplier_id: string;
    invoice_number_ext: string;
    invoice_date: string;
    po_id?: string;
    currency?: string;
    recipient_gstin_ext?: string;
    irn_ext?: string;
    subtotal?: number;
    cgst_total?: number;
    sgst_total?: number;
    igst_total?: number;
    cess_total?: number;
    total_value: number;
    duplicate_override_reason?: string;
  };
  corrected_lines: SupplierInvoiceLineInput[];
  correction_summary?: Record<string, unknown>;
  /** Server-set from auth; never trusted from the client. */
  reviewed_by?: string;
}

export interface InvoiceIngestionReviewedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'invoice_ingestion.reviewed';
  payload: InvoiceIngestionReviewedPayload;
}

export interface SupplierInvoiceCapturedPayload {
  invoice_id: string;
  supplier_id: string;
  invoice_number_ext: string;
  invoice_date: string;
  /** Required for supplier_invoice.captured (AC1) - the no-PO path is supplier_invoice.unmatched_recorded. */
  po_id: string;
  /** Required (AC1/AC6); the handler derives this from the locked source PO before persistEvent. */
  business_stream: string;
  currency?: string;
  recipient_gstin_ext?: string;
  irn_ext?: string;
  lines: SupplierInvoiceLineInput[];
  subtotal?: number;
  cgst_total?: number;
  sgst_total?: number;
  igst_total?: number;
  cess_total?: number;
  total_value: number;
  capture_method: 'manual' | 'file';
  /** Present only when capture_method is 'file'. */
  ingestion_id?: string;
  /** Only the duplicate-override command may carry a non-empty reason (AC3). */
  duplicate_override_reason?: string;
  /** Server-set from auth; never trusted from the client. */
  captured_by?: string;
}

export interface SupplierInvoiceCapturedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier_invoice.captured';
  payload: SupplierInvoiceCapturedPayload;
}

export interface SupplierInvoiceUnmatchedRecordedPayload {
  invoice_id: string;
  supplier_id: string;
  invoice_number_ext: string;
  invoice_date: string;
  currency?: string;
  recipient_gstin_ext?: string;
  irn_ext?: string;
  lines: SupplierInvoiceLineInput[];
  subtotal?: number;
  cgst_total?: number;
  sgst_total?: number;
  igst_total?: number;
  cess_total?: number;
  total_value: number;
  capture_method: 'manual' | 'file';
  ingestion_id?: string;
  duplicate_override_reason?: string;
  /** Server-set from auth; never trusted from the client. */
  captured_by?: string;
}

export interface SupplierInvoiceUnmatchedRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier_invoice.unmatched_recorded';
  payload: SupplierInvoiceUnmatchedRecordedPayload;
}

export interface SupplierInvoicePoLinkedPayload {
  invoice_id: string;
  po_id: string;
  /** Required (AC4/AC6); the handler derives this from the locked target PO before persistEvent. */
  business_stream: string;
  /** Server-set from auth; never trusted from the client. */
  linked_by?: string;
}

export interface SupplierInvoicePoLinkedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier_invoice.po_linked';
  payload: SupplierInvoicePoLinkedPayload;
}

// ---------------------------------------------------------------------------
// Story 4.6: MSME Compliance Tracking
// ---------------------------------------------------------------------------

export interface SupplierMsmeVerifiedPayload {
  supplier_id: string;
  udyam_number_ext: string;
  msme_classification: 'micro' | 'small' | 'medium';
  certificate_reference: string;
  /** ISO timestamp of officer verification against the uploaded Udyam certificate. */
  verified_at: string;
  /** YYYY-MM-DD; re-verification stamps a fresh date and moves msme_status back to active. */
  revalidation_due_date: string;
}

export interface SupplierMsmeVerifiedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.msme_verified';
  payload: SupplierMsmeVerifiedPayload;
}

export interface SupplierMsmeSuspendedPayload {
  supplier_id: string;
  reason: 'revalidation-lapsed';
  /** YYYY-MM-DD the revalidation due date that passed without re-verification. */
  lapsed_on: string;
}

export interface SupplierMsmeSuspendedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier.msme_suspended';
  payload: SupplierMsmeSuspendedPayload;
}

export interface SupplierInvoiceStatutoryBreachFlaggedPayload {
  invoice_id: string;
  supplier_id: string;
  /** YYYY-MM-DD statutory due date that passed unpaid. */
  statutory_due_date: string;
  /** YYYY-MM-DD business date of the compliance check that detected the breach. */
  detected_on: string;
}

export interface SupplierInvoiceStatutoryBreachFlaggedEnvelope extends Omit<
  EventEnvelope,
  'payload'
> {
  event_type: 'supplier_invoice.statutory_breach_flagged';
  payload: SupplierInvoiceStatutoryBreachFlaggedPayload;
}

export interface MsmeAgeingFeedRecordedPayload {
  feed_id: string;
  row_count: number;
  /** ISO timestamp the ageing snapshot was generated. */
  generated_at: string;
}

export interface MsmeAgeingFeedRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'msme_ageing_feed.recorded';
  payload: MsmeAgeingFeedRecordedPayload;
}

// ---------------------------------------------------------------------------
// Story 4.5: Goods Receipt and Three-Way Match
// ---------------------------------------------------------------------------

export interface GrnPoLinkedPayload {
  grn_id: string;
  /** Native Story 4.4 purchase order. First stamp wins - a GRN never re-links to a different PO. */
  po_id: string;
  /** The Story 2.9 ERP reference the GRN was physically received against; carried for traceability. */
  po_number_ext?: string;
  /** Server-set from auth; never trusted from the client. */
  linked_by?: string;
}

export interface GrnPoLinkedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'grn.po_linked';
  payload: GrnPoLinkedPayload;
}

/**
 * One per-PO-line comparison across all three documents. Every quantity and money value is a
 * NUMERIC-as-string: the comparison itself runs in PostgreSQL NUMERIC and the strings are the
 * verbatim results, so no JS float ever touches the audit record (Story 4.4 lesson).
 */
export interface ThreeWayMatchLineVariance {
  line_no: number;
  sku: string;
  po_qty: string;
  received_qty: string;
  invoice_qty: string;
  qty_variance_pct: string;
  po_unit_price: string;
  invoice_unit_price: string;
  price_variance_pct: string;
  /** Present only on a failing line: 'quantity' | 'price' | 'ambiguous_sku'. */
  failure_reason?: string;
}

export interface ThreeWayMatchToleranceSnapshot {
  quantity_pct: string;
  price_pct: string;
  invoice_value_abs: string;
  rule_version: string;
}

export interface ThreeWayMatchVarianceDetail {
  lines: ThreeWayMatchLineVariance[];
  /** Invoice lines that resolve to no PO line at all - a failure, never a crash. */
  unmatched_invoice_lines: Array<{ line_no: number; sku: string; quantity: string }>;
  /** ABS(invoice.total_value - SUM(matched line values)), NUMERIC-as-string. */
  invoice_value_variance_abs: string;
  invoice_total_value: string;
  matched_line_value_total: string;
  /** SQL-computed NUMERIC boolean; the authoritative pass/fail signal, no JS float. */
  invoice_value_within_tolerance: boolean;
  tolerance_snapshot: ThreeWayMatchToleranceSnapshot;
}

export interface ThreeWayMatchRecordedPayload {
  match_id: string;
  invoice_id: string;
  po_id: string;
  /** Every GRN bound to the PO that contributed received quantity to this run. */
  grn_ids: string[];
  result: 'passed' | 'blocked';
  /** 'MATCH_OUT_OF_TOLERANCE' when result is 'blocked'; absent otherwise. */
  error_code?: string;
  variance_detail: ThreeWayMatchVarianceDetail;
  tolerance_snapshot: ThreeWayMatchToleranceSnapshot;
  /** Server-set from auth; never trusted from the client. */
  run_by?: string;
}

export interface ThreeWayMatchRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'three_way_match.recorded';
  payload: ThreeWayMatchRecordedPayload;
}

/**
 * Credit and debit notes are the ONLY way a blocked match is lifted (AC3). They are additive
 * records: no invoice row is deleted and no captured financial snapshot is mutated. The FR-AC-13
 * edit-log requirement is met by the existing statutory audit_log written by the route.
 */
export interface SupplierInvoiceNoteRecordedPayload {
  note_id: string;
  invoice_id: string;
  match_id: string;
  note_number_ext: string;
  /** NUMERIC-as-string, scale 2, strictly positive. */
  amount: string;
  reason: string;
  /** Stamped by the applier from the event_type, present in the stored event. */
  note_type?: 'credit_note' | 'debit_note';
  /** Server-set from auth; never trusted from the client. */
  recorded_by?: string;
}

export type SupplierInvoiceCreditNoteRecordedPayload = SupplierInvoiceNoteRecordedPayload;

export interface SupplierInvoiceCreditNoteRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier_invoice.credit_note_recorded';
  payload: SupplierInvoiceCreditNoteRecordedPayload;
}

export type SupplierInvoiceDebitNoteRecordedPayload = SupplierInvoiceNoteRecordedPayload;

export interface SupplierInvoiceDebitNoteRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier_invoice.debit_note_recorded';
  payload: SupplierInvoiceDebitNoteRecordedPayload;
}

export interface PaymentClearanceFeedRecordedPayload {
  feed_id: string;
  row_count: number;
  /** ISO timestamp the clearance snapshot was generated. */
  generated_at: string;
  correlation_id: string;
}

export interface PaymentClearanceFeedRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'payment_clearance_feed.recorded';
  payload: PaymentClearanceFeedRecordedPayload;
}

// ---------------------------------------------------------------------------
// Story 5.1: Multi-Level BOM Creation
// ---------------------------------------------------------------------------

export interface BomLineInput {
  line_no: number;
  /** Required unless is_placeholder is true (Story 5.4, R&D drafts only). */
  component_item_id?: string;
  /** Story 5.4: placeholder line (R&D drafts only) - no component identity, free_text required. */
  is_placeholder?: boolean;
  free_text?: string;
  output_class: 'component' | 'co_product' | 'by_product';
  quantity_per: string;
  line_uom: string;
  uom_conversion_factor: string;
  scrap_percent?: string;
  expected_yield_percent?: string;
  is_phantom: boolean;
  phantom_source_bom_id?: string;
  effective_from: string;
  effective_to?: string;
  /** Story 5.5: how execution consumes this component (FR-B-07). Defaults to 'directed_issue'. */
  supply_method?: 'directed_issue' | 'backflush';
}

export interface BomDraftedPayload {
  bom_id: string;
  parent_item_id: string;
  /** Server-derived from the parent item master (FR-AC-01); never accepted from a request body. */
  business_stream: string;
  bom_type?: 'production' | 'rnd' | 'job_work_kit';
  revision_code: string;
  lines: BomLineInput[];
  correlation_id?: string;
}

export interface BomDraftedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.drafted';
  payload: BomDraftedPayload;
}

export interface BomLineAddedPayload {
  bom_id: string;
  revision_id: string;
  bom_line_id: string;
  line_no: number;
  /** Required unless is_placeholder is true (Story 5.4, R&D drafts only). */
  component_item_id?: string;
  /** Story 5.4: placeholder line (R&D drafts only) - no component identity, free_text required. */
  is_placeholder?: boolean;
  free_text?: string;
  output_class: 'component' | 'co_product' | 'by_product';
  quantity_per: string;
  line_uom: string;
  uom_conversion_factor: string;
  scrap_percent?: string;
  expected_yield_percent?: string;
  is_phantom: boolean;
  phantom_source_bom_id?: string;
  effective_from: string;
  effective_to?: string;
  /** Story 5.5: how execution consumes this component (FR-B-07). Defaults to 'directed_issue'. */
  supply_method?: 'directed_issue' | 'backflush';
}

export interface BomLineAddedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom_line.added';
  payload: BomLineAddedPayload;
}

export interface BomLineAmendedPayload {
  bom_id: string;
  revision_id: string;
  bom_line_id: string;
  quantity_per?: string;
  line_uom?: string;
  uom_conversion_factor?: string;
  scrap_percent?: string;
  expected_yield_percent?: string;
  effective_from?: string;
  effective_to?: string;
}

export interface BomLineAmendedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom_line.amended';
  payload: BomLineAmendedPayload;
}

// ---------------------------------------------------------------------------
// Story 5.2: BOM Lifecycle and Immutability
// ---------------------------------------------------------------------------

export interface BomReleasedPayload {
  bom_id: string;
  revision_id: string;
  /** Distinguishes reinstatement (on_hold to released) from first release in the audit trail. */
  reason?: string;
  correlation_id?: string;
}

export interface BomReleasedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.released';
  payload: BomReleasedPayload;
}

export interface BomHeldPayload {
  bom_id: string;
  reason?: string;
  correlation_id?: string;
}

export interface BomHeldEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.held';
  payload: BomHeldPayload;
}

export interface BomObsoletedPayload {
  bom_id: string;
  reason?: string;
  correlation_id?: string;
}

export interface BomObsoletedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.obsoleted';
  payload: BomObsoletedPayload;
}

/**
 * Legacy ERP kit migrated as a single-level BOM (FR-B-02). `outcome` is computed at capture
 * time and stored so replay is deterministic - item-master statuses drift after the fact.
 */
export interface LegacyKitMigratedPayload {
  bom_id: string;
  parent_item_id: string;
  /** Server-derived from the parent item master (FR-AC-01); never accepted from a request body. */
  business_stream: string;
  kit_ref: string;
  revision_code: string;
  outcome: 'released' | 'draft_remediation';
  lines: BomLineInput[];
  correlation_id?: string;
}

export interface LegacyKitMigratedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.migrated_from_kit';
  payload: LegacyKitMigratedPayload;
}

/**
 * Story 4.2: Supplier Performance Scorecards. One append-only metric observation per upstream
 * source event. All NUMERIC values are strings; business_date is an IST calendar date string.
 *
 * Quality-acceptance source (Epic 8 Story 8.3): `qc.lot_dispositioned` is now registered in
 * SUPPORTED_EVENT_TYPES and the quality-acceptance applier is live. The metric's
 * reference_entity_id is a qc_lot_disposition.disposition_id; value_num is derived on the server
 * as '1' for an accepted lot and '0' for a rejected one, and a conditional_release or split
 * reference is rejected with SCORECARD_REFERENCE_INVALID.
 */
export interface SupplierScorecardMetricRecordedPayload {
  metric_id: string;
  supplier_id: string;
  metric_kind: 'on_time_delivery' | 'quality_acceptance' | 'price_variance' | 'responsiveness';
  /** The GRN, match, or PO source event that produced this observation. */
  reference_event_id: string;
  /** The GRN, match, or PO entity id the observation is about. */
  reference_entity_id: string;
  /** NUMERIC-as-string, scale <= 6, at most 14 integer digits. */
  value_num: string;
  /** Drill-through facts (received_date, promised_delivery_date, variance_pct, ...). */
  context: Record<string, unknown>;
  /** IST calendar date string YYYY-MM-DD. */
  business_date: string;
  /** A correction points at the metric row it supersedes; never an in-place update. */
  supersedes_metric_id?: string;
  /** Server-set from auth; never trusted from the client. */
  recorded_by?: string;
}

export interface SupplierScorecardMetricRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'supplier_scorecard.metric_recorded';
  payload: SupplierScorecardMetricRecordedPayload;
}

// ---------------------------------------------------------------------------
// Story 5.3: ECO Workflow and Where-Used Impact
// ---------------------------------------------------------------------------

/** One proposed change on an ECO: add a new component, amend, or retire an existing bom_line. */
export interface EcoChangeInput {
  change_type: 'add' | 'amend' | 'retire';
  target_bom_line_id?: string;
  component_item_id?: string;
  output_class?: 'component' | 'co_product' | 'by_product';
  quantity_per?: string;
  line_uom?: string;
  uom_conversion_factor?: string;
  scrap_percent?: string;
  expected_yield_percent?: string;
  is_phantom?: boolean;
  phantom_source_bom_id?: string;
  effective_from?: string;
  effective_to?: string;
}

/**
 * approver_actor_id and doa_entry_id are computed at CAPTURE time (resolveApprover) and stored
 * here so replay is deterministic - DOA registry entries and role holders drift over time.
 */
export interface EcoRaisedPayload {
  eco_id: string;
  eco_number: string;
  bom_id: string;
  target_revision_id: string;
  /** Server-derived from the target BOM; never accepted from a request body. */
  business_stream: string;
  reason: string;
  changes: EcoChangeInput[];
  approver_actor_id: string | null;
  doa_entry_id: string | null;
  correlation_id?: string;
}

export interface EcoRaisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'eco.raised';
  payload: EcoRaisedPayload;
}

export interface EcoReviewStartedPayload {
  eco_id: string;
  correlation_id?: string;
}

export interface EcoReviewStartedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'eco.review_started';
  payload: EcoReviewStartedPayload;
}

export interface EcoApprovedPayload {
  eco_id: string;
  decision_note?: string;
  correlation_id?: string;
}

export interface EcoApprovedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'eco.approved';
  payload: EcoApprovedPayload;
}

/**
 * new_revision_id and new_revision_code are computed at CAPTURE time in the handler and stored
 * here so replay is deterministic - revision counts drift over time (the same rule Story 5.2
 * applied to the legacy-kit migration `outcome` field).
 */
export interface EcoImplementedPayload {
  eco_id: string;
  new_revision_id: string;
  new_revision_code: string;
  correlation_id?: string;
}

export interface EcoImplementedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'eco.implemented';
  payload: EcoImplementedPayload;
}

export interface EcoCancelledPayload {
  eco_id: string;
  cancel_reason: string;
  correlation_id?: string;
}

export interface EcoCancelledEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'eco.cancelled';
  payload: EcoCancelledPayload;
}

export interface EcoStockDispositionInput {
  lot_id: string;
  sku: string;
  location_id: string;
  on_hand_qty: string;
  disposition: 'use_up' | 'scrap' | 'rework';
  rework_reference?: string;
  notes?: string;
}

export interface EcoStockDispositionRecordedPayload {
  eco_id: string;
  dispositions: EcoStockDispositionInput[];
  correlation_id?: string;
}

export interface EcoStockDispositionRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'eco.stock_disposition_recorded';
  payload: EcoStockDispositionRecordedPayload;
}

// ---------------------------------------------------------------------------
// Story 5.4: R&D draft BOM regime events (FR-B-09 to FR-B-11).
//
// There is deliberately NO rd_draft.created event: POST /api/v1/boms with bom_type 'rnd' already
// drafts an R&D BOM through bom.drafted. Likewise the epics' "AsBuiltSnapshotCaptured" is split
// into rd_build.recorded + rd_build.confirmed because AC 4 needs a build record that exists
// BEFORE confirmation and a capture that happens AT confirmation.
//
// All ids (bom_id, revision_id, line_ids, build_id, signoff_id, approver_actor_id) are minted or
// resolved at CAPTURE time in the handler and stored in the payload so replay is deterministic.
// ---------------------------------------------------------------------------

/**
 * Clones a production (or R&D) BOM into a NEW editable R&D draft (FR-B-10). stream_id is the NEW
 * draft's bom_id. business_stream is COPIED from the source BOM, never accepted from a request.
 */
export interface RdDraftClonedPayload {
  source_bom_id: string;
  source_revision_id: string;
  bom_id: string;
  revision_id: string;
  revision_code: string;
  parent_item_id: string;
  parent_sku: string;
  parent_uom: string;
  business_stream: string;
  line_ids: string[];
  correlation_id?: string;
}

export interface RdDraftClonedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'rd_draft.cloned';
  payload: RdDraftClonedPayload;
}

/**
 * One as-built line supplied when recording a draft-BOM build (AC 4). The discriminated union
 * mirrors assertRdBuildRecordedShape (src/compliance/rd-bom.ts): a placeholder line carries
 * free_text and NO component identity; a real line carries component_item_id plus the
 * server-resolved component_sku (required by the shape assert, never supplied by the client).
 */
export type RdAsBuiltLineInput =
  | {
      line_no: number;
      draft_bom_line_id?: string;
      is_placeholder?: false;
      component_item_id: string;
      component_sku: string;
      quantity_used: string;
      line_uom: string;
    }
  | {
      line_no: number;
      draft_bom_line_id?: string;
      is_placeholder: true;
      free_text: string;
      quantity_used: string;
      line_uom: string;
    };

/**
 * Records a draft-BOM build (AC 4). stream_id is build_id. business_stream is derived server-side
 * from the BOM. Deviations are NOT computed here - they are recomputed at confirm time against
 * the draft's then-current lines.
 */
export interface RdBuildRecordedPayload {
  build_id: string;
  bom_id: string;
  revision_id: string;
  build_ref: string;
  business_stream: string;
  built_quantity: string;
  built_uom: string;
  outcome?: string;
  notes?: string;
  as_built_lines: RdAsBuiltLineInput[];
  correlation_id?: string;
}

export interface RdBuildRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'rd_build.recorded';
  payload: RdBuildRecordedPayload;
}

/** Confirms a recorded build, capturing the immutable as-built snapshot (AC 4). */
export interface RdBuildConfirmedPayload {
  build_id: string;
  correlation_id?: string;
}

export interface RdBuildConfirmedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'rd_build.confirmed';
  payload: RdBuildConfirmedPayload;
}

/**
 * One productization gate sign-off (AC 5). approver_actor_id and doa_entry_id are resolved at
 * CAPTURE time (resolveApprover) and stored so replay is deterministic. stream_id is the R&D
 * draft's bom_id.
 */
export interface RdProductizationSignedPayload {
  signoff_id: string;
  bom_id: string;
  gate_function: 'engineering' | 'procurement' | 'qc';
  approver_actor_id: string;
  doa_entry_id: string | null;
  notes?: string;
  correlation_id?: string;
}

export interface RdProductizationSignedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'rd_draft.productization_signed';
  payload: RdProductizationSignedPayload;
}

/**
 * Creates a NEW production BOM (in draft) from a fully signed-off R&D draft (FR-B-11). stream_id
 * is the NEW production BOM's bom_id. The source R&D draft is never modified.
 */
export interface RdProductizedPayload {
  source_bom_id: string;
  bom_id: string;
  revision_id: string;
  revision_code: string;
  parent_item_id: string;
  parent_sku: string;
  parent_uom: string;
  business_stream: string;
  line_ids: string[];
  correlation_id?: string;
}

export interface RdProductizedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'rd_draft.productized';
  payload: RdProductizedPayload;
}

// ---------------------------------------------------------------------------
// Story 5.5: approved alternates and BOM explosion (FR-B-12, FR-B-07).
//
// The epics' PascalCase names (AlternateDefined, SubstitutionApproved, BomExploded) map to the
// dot-separated spine-convention types below. All three act on an ALREADY business-stream-tagged
// BOM aggregate, so requiresBusinessStream is false; business_stream is copied server-side from
// the BOM header where a persisted row needs it, never accepted from a request body.
//
// Every id (bom_alternate_id, explosion_id, doa_entry_id, approver_actor_id) is minted or resolved
// at CAPTURE time in the handler and stored in the payload, and the whole explosion requirement
// set is computed at capture time by src/engineering/bom-explosion.ts and embedded here, so the
// appliers recompute NOTHING and replay is byte-deterministic.
// ---------------------------------------------------------------------------

/**
 * Defines one approved alternate for a Released BOM line (FR-B-12). stream_id is bom_id.
 * component_item_id and line_no are resolved server-side from the bom_line, never trusted from
 * the request body.
 */
export interface BomAlternateDefinedPayload {
  bom_alternate_id: string;
  bom_id: string;
  revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  alternate_item_id: string;
  alternate_sku: string | null;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  origin: 'approved';
  correlation_id?: string;
}

export interface BomAlternateDefinedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.alternate_defined';
  payload: BomAlternateDefinedPayload;
}

/**
 * Records a DOA-approved ad-hoc substitution (FR-B-12, FR-DOA-01). Materializes as a bom_alternate
 * row with origin 'ad_hoc' plus DOA evidence, so the alternates read model serves approved
 * alternates and approved substitutions as ONE priority-ordered stream. doa_entry_id and
 * approver_actor_id are REQUIRED - both are resolved through resolveApprover at capture time.
 */
export interface BomSubstitutionApprovedPayload {
  bom_alternate_id: string;
  bom_id: string;
  revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  alternate_item_id: string;
  alternate_sku: string | null;
  priority: number;
  effective_from: string;
  effective_to: string | null;
  origin: 'ad_hoc';
  doa_entry_id: string;
  approver_actor_id: string;
  correlation_id?: string;
}

export interface BomSubstitutionApprovedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.substitution_approved';
  payload: BomSubstitutionApprovedPayload;
}

/** One open alternate carried on a requirement row, ordered by priority ASC (AC 1). */
export interface BomExplosionAlternate {
  alternate_item_id: string;
  alternate_sku: string | null;
  priority: number;
  origin: 'approved' | 'ad_hoc';
}

/**
 * One generated requirement. Quantities are exact decimal strings - all arithmetic happened in
 * PostgreSQL NUMERIC inside the explosion CTE, never in JS floats. explosion_line_id is minted at
 * CAPTURE time and travels in the payload so replaying bom.exploded events into a fresh projection
 * rebuilds the same bom_explosion_line rows (capture-time-minted-IDs replay rule).
 */
export interface BomExplosionRequirement {
  explosion_line_id: string;
  depth: number;
  path: string;
  source_bom_id: string;
  source_revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string;
  component_sku: string | null;
  supply_method: 'directed_issue' | 'backflush';
  required_quantity: string;
  scrap_percent: string | null;
  base_quantity_per: string;
  has_child_bom: boolean;
  via_phantom: boolean;
  alternates: BomExplosionAlternate[];
}

/**
 * Records one explosion run of a Released BOM to an execution requirement set (FR-B-07).
 * stream_id is bom_id. requirements is the complete capture-time result; the applier persists it
 * verbatim.
 */
export interface BomExplodedPayload {
  explosion_id: string;
  bom_id: string;
  revision_id: string;
  order_quantity: string;
  business_date: string;
  depth_truncated: boolean;
  requirements: BomExplosionRequirement[];
  correlation_id?: string;
}

export interface BomExplodedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.exploded';
  payload: BomExplodedPayload;
}

// ---------------------------------------------------------------------------
// Story 5.6: cost rollups, job-work kit tagging and ERP outbound sync
// (FR-B-15, FR-B-16, FR-B-17, INT-ERP-01).
//
// The epics' PascalCase names (CostRollupSnapshotted, JobWorkKitTagged, BomSyncConflictRaised) map
// to the dot-separated spine-convention types below. All three act on an ALREADY
// business-stream-tagged BOM aggregate, so requiresBusinessStream is false; business_stream is
// derived server-side from the BOM header, never accepted from a request body.
//
// rollup_id and the whole costed line set are computed at CAPTURE time by
// src/engineering/bom-cost-rollup.ts and embedded here, so the applier recomputes NOTHING and
// replay is byte-deterministic (the Story 5.5 bom.exploded rule, verbatim).
// ---------------------------------------------------------------------------

/**
 * One costed line occurrence of a rollup walk. Costs and quantities are exact decimal strings -
 * every multiplication and sum happened in PostgreSQL NUMERIC, never in a JS float.
 *
 * A line with no usable rate carries unit_cost null, extended_cost '0' and rate_missing true. A
 * line whose costed children carry the cost (has_child_bom) contributes zero to the header total:
 * only leaves carry cost, which is what keeps a multi-level rollup from double counting.
 */
export interface BomCostRollupLine {
  rollup_line_id: string;
  depth: number;
  path: string;
  source_bom_id: string;
  source_revision_id: string;
  bom_line_id: string;
  line_no: number;
  component_item_id: string | null;
  component_sku: string | null;
  effective_quantity_per: string;
  scrap_percent: string | null;
  unit_cost: string | null;
  extended_cost: string;
  rate_missing: boolean;
  via_phantom: boolean;
  has_child_bom: boolean;
}

/**
 * Records one dated cost-rollup simulation snapshot for a BOM revision (FR-B-15). stream_id is
 * bom_id. Prior snapshots are never touched; a rollup is a simulation and posts no valuation.
 */
export interface BomCostRollupSnapshottedPayload {
  rollup_id: string;
  bom_id: string;
  revision_id: string;
  rollup_date: string;
  rate_basis: 'item_master_standard_cost';
  total_cost: string;
  line_count: number;
  missing_rate_count: number;
  depth_truncated: boolean;
  lines: BomCostRollupLine[];
  correlation_id?: string;
}

export interface BomCostRollupSnapshottedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.cost_rollup_snapshotted';
  payload: BomCostRollupSnapshottedPayload;
}

/** One supply-source tag on a job-work kit BOM line (FR-B-16). */
export interface BomJobWorkKitTag {
  bom_line_id: string;
  line_no: number;
  supply_source: 'company' | 'customer' | 'job_worker';
}

/**
 * Tags job-work kit BOM lines by who owns the material (FR-B-16). stream_id is bom_id. line_no and
 * revision_id are resolved server-side from the BOM header and its line rows, never trusted from
 * the request body. tags is REQUIRED and non-empty.
 */
export interface BomJobWorkKitTaggedPayload {
  bom_id: string;
  revision_id: string;
  tags: BomJobWorkKitTag[];
  correlation_id?: string;
}

export interface BomJobWorkKitTaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.job_work_kit_tagged';
  payload: BomJobWorkKitTaggedPayload;
}

/**
 * Records that an inbound ERP BOM record was rejected and queued for the BOM Administrator
 * (FR-B-17, INT-ERP-01). stream_id is bom_id when the inbound record names a known BOM.
 *
 * This event is a DERIVED audit fact: the integration_exception row is the source of truth and is
 * raised by src/adapters/erp/sync.ts before this event exists. exception_id is READ BACK from that
 * row, never minted here. bom_id is nullable because the inbound record may name an unknown BOM.
 */
export interface BomSyncConflictRaisedPayload {
  bom_id: string | null;
  source_record_ref: string;
  conflict_reason: string;
  exception_id: string;
  source_snapshot: unknown;
  correlation_id?: string;
}

export interface BomSyncConflictRaisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'bom.sync_conflict_raised';
  payload: BomSyncConflictRaisedPayload;
}

// ---------------------------------------------------------------------------
// Story 7.1: Asset Register and Criticality Classification
// ---------------------------------------------------------------------------

/**
 * Registers a maintainable asset in the company-wide register (FR-M-01, AD-9). stream_id is
 * asset_id. created_by is derived server-side from metadata.actor.user_id, never from the payload
 * (the supplier.registered precedent). fixed_asset_ref is a FREE identifier - no lookup against a
 * fixed-asset module is performed (AC 2). serial_number is the AC 3 duplicate-detection key and
 * applies to serialized assets only.
 */
export interface AssetRegisteredPayload {
  asset_id: string;
  asset_tag: string;
  asset_name: string;
  criticality_class: 'critical' | 'high' | 'medium' | 'low';
  serial_number?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  fixed_asset_ref?: string | null;
}

export interface AssetRegisteredEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'asset.registered';
  payload: AssetRegisteredPayload;
}

// ---------------------------------------------------------------------------
// Story 7.2: Preventive Maintenance Plans and Work Order Generation
// ---------------------------------------------------------------------------

/**
 * Registers a usage meter against an asset (FR-M-03). stream_id is meter_id. created_by is derived
 * server-side from metadata.actor.user_id. alert_role carries the silent-meter notification target
 * as DATA (no role-name branch in code).
 */
export interface MeterRegisteredPayload {
  meter_id: string;
  asset_id: string;
  meter_code: string;
  unit: 'hours' | 'cycles' | 'km' | 'units';
  silent_after_days: number;
  alert_role: string;
}

export interface MeterRegisteredEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.meter_registered';
  payload: MeterRegisteredPayload;
}

/**
 * A meter observation accepted through the generic ingestion API (FR-M-03, AC 4). The reading is
 * applied identically regardless of source; source and capture_method are recorded on every row.
 * recorded_by is derived server-side from metadata.actor.user_id.
 */
export interface MeterReadingRecordedPayload {
  reading_id: string;
  meter_id: string;
  asset_id: string;
  reading_value: number;
  reading_at: string;
  source: 'manual' | 'hub_booking' | 'station_equipment';
  capture_method: 'manual_entry' | 'api' | 'device_feed';
}

export interface MeterReadingRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.meter_reading_recorded';
  payload: MeterReadingRecordedPayload;
}

/** Raised by the reconciliation job for a meter silent past its configured interval (AC 5). */
export interface MeterSilentFlaggedPayload {
  meter_id: string;
  asset_id: string;
  business_date: string;
  last_reading_at: string | null;
  silent_after_days: number;
}

export interface MeterSilentFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.meter_silent_flagged';
  payload: MeterSilentFlaggedPayload;
}

/**
 * Defines a calendar-based or meter-based PM plan against an asset (FR-M-02). stream_id is
 * plan_id. Exactly one of the calendar pair (interval_days plus next_due_date) or the meter triple
 * (meter_id, interval_meter_units plus next_due_meter) is populated; the projection CHECKs enforce
 * it. escalation_role carries the AC 2 notification target as DATA.
 */
export interface MaintenancePlanDefinedPayload {
  plan_id: string;
  asset_id: string;
  plan_name: string;
  plan_type: 'calendar' | 'meter';
  interval_days?: number | null;
  meter_id?: string | null;
  interval_meter_units?: number | null;
  grace_period_days: number;
  escalation_role: string;
  anchor_date: string;
  next_due_date?: string | null;
  next_due_meter?: number | null;
}

export interface MaintenancePlanDefinedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.plan_defined';
  payload: MaintenancePlanDefinedPayload;
}

/**
 * One PM work order generated by the generation job for one due cycle of one plan (AC 1).
 * generated_for_cycle is the anti-double-generation key (uq_maintenance_work_order_cycle): the ISO
 * due date for a calendar plan, the serialized due-meter value for a meter plan.
 */
export interface MaintenanceWorkOrderGeneratedPayload {
  work_order_id: string;
  plan_id: string;
  asset_id: string;
  due_date: string;
  grace_until_date: string;
  generated_for_cycle: string;
  business_date: string;
}

export interface MaintenanceWorkOrderGeneratedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.work_order_generated';
  payload: MaintenanceWorkOrderGeneratedPayload;
}

/** Grace window expired with the work order still open (AC 2); the job escalates after commit. */
export interface MaintenanceWorkOrderOverduePayload {
  work_order_id: string;
  plan_id: string | null;
  asset_id: string;
  grace_until_date: string;
  business_date: string;
}

export interface MaintenanceWorkOrderOverdueEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.work_order_overdue';
  payload: MaintenanceWorkOrderOverduePayload;
}

/**
 * Minimal completion so the grace sweep can tell a done work order from an open one (AC 2).
 * Closure codes, labour, downtime and parts consumption belong to Stories 7.3 and 7.8.
 * completed_by is derived server-side from metadata.actor.user_id.
 *
 * Story 7.6 additive extension (FR-M-15): the payload gains OPTIONAL labor_cost and parts_cost
 * NUMERIC strings. When present, the applier computes total_cost = labor_cost + parts_cost in SQL
 * NUMERIC and capitalization_flagged = (total_cost > config.maintenance.capitalizationThreshold)
 * server-side and writes BOTH derived fields back onto the persisted payload before the
 * domain_events insert. Existing Story 7.2 payloads with no cost fields are unchanged: the cost
 * columns default to 0 and no cost path runs.
 */
export interface MaintenanceWorkOrderCompletedPayload {
  work_order_id: string;
  asset_id: string;
  completed_at: string;
  labor_cost?: string;
  parts_cost?: string;
  /** Derived by the applier in SQL NUMERIC; declared only for the persisted-payload write-back. */
  total_cost?: string;
  /** Derived by the applier (strictly greater than the configured threshold); persisted write-back. */
  capitalization_flagged?: boolean;
  /**
   * Story 7.8 (FR-M-18, Binding Decision 8): three-part closure coding. Client-declared, validated
   * against config.maintenance.closureCodes.{fault,cause,remedy} in the applier. All-or-none at the
   * shape level; mandatory for a breakdown work order (422 CLOSURE_CODES_REQUIRED), optional for a
   * preventive one. Present codes write one maintenance_work_order_closure row keyed on the
   * work_order_id.
   */
  fault_code?: string;
  cause_code?: string;
  remedy_code?: string;
}

export interface MaintenanceWorkOrderCompletedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.work_order_completed';
  payload: MaintenanceWorkOrderCompletedPayload;
}

// ---------------------------------------------------------------------------
// Story 7.3: Fault Reporting and Breakdown Work Orders
// ---------------------------------------------------------------------------

/**
 * Defines one active SLA policy for a (criticality_class, safety_flag) pair (FR-M-05). stream_id
 * is policy_id. created_by is derived server-side from metadata.actor.user_id. The policy is the
 * operator-configurable mapping that derives breakdown priority, response and resolution targets;
 * acceptance with no matching active policy is a hard 422, never a silent default.
 */
export interface SlaPolicyDefinedPayload {
  policy_id: string;
  criticality_class: 'critical' | 'high' | 'medium' | 'low';
  safety_flag: boolean;
  priority: 'p1' | 'p2' | 'p3' | 'p4';
  response_minutes: number;
  resolution_hours: number;
}

export interface SlaPolicyDefinedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.sla_policy_defined';
  payload: SlaPolicyDefinedPayload;
}

/**
 * A fault reported by scanning an asset tag (FR-M-04). stream_id is fault_report_id. reported_by
 * and location_id are derived server-side from metadata.actor (never read from the payload); the
 * reporter's location is the asset's location for notification purposes. The supervisor
 * notification is emitted AFTER commit by the handler, never inside the applier (AD-17).
 *
 * Story 7.8 (Binding Decision 12): on the edge upload path the device carries asset_tag ONLY. The
 * shape assert accepts an absent asset_id when asset_tag is a non-empty string, and the applier
 * resolves the asset by tag (404 ASSET_NOT_FOUND) and writes the derived asset_id back onto the
 * persisted payload, so the stored event always carries both. A declared asset_id keeps the
 * existing ASSET_TAG_MISMATCH check.
 */
export interface FaultReportedPayload {
  fault_report_id: string;
  asset_id: string;
  asset_tag: string;
  description: string;
  safety_flag: boolean;
  reported_at: string;
}

export interface FaultReportedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.fault_reported';
  payload: FaultReportedPayload;
}

/**
 * A triage rejection of a still-'reported' fault. stream_id is fault_report_id. triaged_at and
 * triaged_by are derived server-side from the envelope; rejection_reason is trimmed and asserted
 * non-blank in the shape check.
 */
export interface FaultRejectedPayload {
  fault_report_id: string;
  rejection_reason: string;
  triaged_at: string;
}

export interface FaultRejectedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.fault_rejected';
  payload: FaultRejectedPayload;
}

/**
 * The acceptance of a fault report: creates the breakdown work order, opens the downtime window
 * and flips the report to 'accepted', all in ONE transaction. stream_id is work_order_id. Every
 * derived field (priority, sla_policy_id, both SLA timestamps, due_date, grace_until_date,
 * downtime start) is DECLARED in the payload and CHECKED against the value derived from the locked
 * rows, never trusted (the 7.2 Group 2 cursor-match decision). generated_for_cycle on the
 * work-order row is set to fault_report_id by the applier; business_date is carried for the report
 * joins and is server-validated.
 */
export interface BreakdownWorkOrderCreatedPayload {
  work_order_id: string;
  fault_report_id: string;
  asset_id: string;
  downtime_id: string;
  priority: 'p1' | 'p2' | 'p3' | 'p4';
  sla_policy_id: string;
  due_date: string;
  grace_until_date: string;
  sla_response_due_at: string;
  sla_resolution_due_at: string;
  business_date: string;
  /**
   * Story 7.7 additive extension (FR-M-11): the warranty check result. Both fields are SEAM-DERIVED
   * write-back in applyBreakdownWorkOrderCreated from the active-warranty lookup against
   * business_date - NEVER client-supplied. A declared value in the inbound envelope is rejected
   * 409 WORK_ORDER_DERIVATION_MISMATCH (Binding Decision 3), so they are optional on the way in and
   * always present on the persisted payload.
   */
  warranty_flagged?: boolean;
  warranty_coverage_id?: string | null;
}

export interface BreakdownWorkOrderCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.breakdown_work_order_created';
  payload: BreakdownWorkOrderCreatedPayload;
}

/**
 * Closes the single open downtime window for a breakdown work order. stream_id is downtime_id.
 * closed_by is derived server-side from the envelope; duration_minutes is computed IN SQL from the
 * locked row, never in JS, so the stored number and the reliability report agree exactly.
 */
export interface DowntimeClosedPayload {
  downtime_id: string;
  work_order_id: string;
  ended_at: string;
}

export interface DowntimeClosedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.downtime_closed';
  payload: DowntimeClosedPayload;
}

/**
 * One persisted monthly reliability snapshot (FR-M-06). stream_id is report_id. The payload's
 * metrics array carries one entry per scope row; the applier inserts one maintenance_reliability_
 * metric row per entry inside the SAME transaction, so a report either lands whole or not at all.
 * generated_by is derived server-side from metadata.actor.user_id.
 */
export interface ReliabilityMetricPayload {
  metric_id: string;
  scope_type: 'asset' | 'criticality_class';
  scope_key: string;
  breakdown_count: number;
  downtime_minutes: number;
  mttr_minutes: number | null;
  mtbf_minutes: number | null;
}

export interface ReliabilityReportGeneratedPayload {
  report_id: string;
  period_start: string;
  period_end: string;
  metrics: ReliabilityMetricPayload[];
}

export interface ReliabilityReportGeneratedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.reliability_report_generated';
  payload: ReliabilityReportGeneratedPayload;
}

/**
 * Story 7.4 (FR-M-07, FR-M-09): a spare catalogued for maintenance at one stocking location.
 * stream_id is catalogue_id. created_by is derived server-side from metadata.actor.user_id. The
 * SKU must already exist and be active in item_master (the FR-I "catalogued under the Epic 2 stock
 * ledger" contract); this event records the maintenance-side designation and the operator-set
 * min-max, it does NOT create inventory. min_level is mandatory when is_critical is true so the
 * FR-M-09 breach scan can never silently skip a grain it was configured to watch.
 */
export interface SpareCataloguedPayload {
  catalogue_id: string;
  sku: string;
  location_id: string;
  is_critical: boolean;
  min_level: string | null;
  max_level: string | null;
}

export interface SpareCataloguedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.spare_catalogued';
  payload: SpareCataloguedPayload;
}

/**
 * Story 7.4 (FR-M-07): one line of the maintenance-owned asset parts list, the equipment BOM.
 * stream_id is part_line_id. This is NOT an Epic 5 bom.* event and must never be treated as one
 * (AD-4): there is no revision, no release gate and no ERP outbound. quantity_per is a NUMERIC
 * string to avoid JS float precision loss on the wire.
 */
export interface AssetPartListedPayload {
  part_line_id: string;
  asset_id: string;
  sku: string;
  quantity_per: string;
  position_ref: string | null;
}

export interface AssetPartListedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.asset_part_listed';
  payload: AssetPartListedPayload;
}

/**
 * Story 7.4 (FR-M-07, FR-M-08): a spare reserved against a work order. stream_id is
 * reservation_id. The applier calls applyStockAllocation, so the AUTHORITATIVE reserved quantity
 * is stock_balance.allocated; this row carries the maintenance-side facts only. asset_id is
 * DECLARED and CHECKED against the locked work order's asset_id, never trusted.
 */
export interface SpareReservedPayload {
  reservation_id: string;
  work_order_id: string;
  asset_id: string;
  sku: string;
  location_id: string;
  lot_id: string | null;
  quantity: string;
  reserved_at: string;
}

export interface SpareReservedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.spare_reserved';
  payload: SpareReservedPayload;
}

/**
 * Story 7.4 (FR-M-08): the reserved quantity physically issued to the technician. stream_id is
 * reservation_id. The applier releases the allocation BEFORE drawing stock, because
 * applyStockIssue gates on `available` and `available` is already net of this reservation's own
 * allocation. quantity and return_due_date are DECLARED and CHECKED against the values derived
 * from the locked reservation and the three-working-day clock.
 */
export interface SpareIssuedPayload {
  reservation_id: string;
  quantity: string;
  issued_at: string;
  /**
   * Story 7.8 (Binding Decision 13): optional on input. The device has no holiday calendar, so an
   * edge issue confirmation omits it and the applier derives it from issued_at (deriveReturnDueDate)
   * and writes it back onto the persisted payload. A DECLARED value is still checked against the
   * derivation and rejected SPARE_DERIVATION_MISMATCH on divergence.
   */
  return_due_date?: string;
  business_date: string;
}

export interface SpareIssuedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.spare_issued';
  payload: SpareIssuedPayload;
}

/**
 * Story 7.4 (FR-M-08): an issued spare handed back, in whole or in part. stream_id is
 * reservation_id. The applier calls applyStockReceipt, returning the quantity to owned on-hand at
 * the reservation's location. A cumulative return above the issued quantity is rejected, never
 * clamped.
 */
export interface SpareReturnedPayload {
  reservation_id: string;
  quantity_returned: string;
  returned_at: string;
}

export interface SpareReturnedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.spare_returned';
  payload: SpareReturnedPayload;
}

/**
 * Story 7.4: a reservation abandoned before issue. stream_id is reservation_id. Without this event
 * an abandoned work order would hold stock_balance.allocated forever and the location's
 * `available` would decay permanently, so it exists even though no acceptance criterion names it.
 */
export interface SpareReservationCancelledPayload {
  reservation_id: string;
  cancellation_reason: string;
  cancelled_at: string;
}

export interface SpareReservationCancelledEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.spare_reservation_cancelled';
  payload: SpareReservationCancelledPayload;
}

/**
 * Story 7.4 (FR-M-09): a critical spare whose owned on-hand has fallen to or below its configured
 * minimum, raised by the POST-triggered scan. stream_id is alert_id. on_hand_at_check is computed
 * in SQL NUMERIC by the job and re-derived under the catalogue row's lock, never trusted from the
 * payload. business_date carries the "same day" of FR-M-09; uq_maintenance_spare_alert_day makes a
 * re-run on the same date a no-op rather than a duplicate.
 */
export interface CriticalSpareBreachFlaggedPayload {
  alert_id: string;
  sku: string;
  location_id: string;
  on_hand_at_check: string;
  min_level: string;
  business_date: string;
  flagged_at: string;
}

export interface CriticalSpareBreachFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.critical_spare_breach_flagged';
  payload: CriticalSpareBreachFlaggedPayload;
}

/**
 * Story 7.4 (FR-M-08): an issued spare past its three-working-day return clock, raised by the same
 * POST-triggered scan. stream_id is alert_id. return_due_date is re-derived from the locked
 * reservation, never trusted from the payload.
 */
export interface SpareReturnOverdueFlaggedPayload {
  alert_id: string;
  reservation_id: string;
  sku: string;
  location_id: string;
  return_due_date: string;
  business_date: string;
  flagged_at: string;
}

export interface SpareReturnOverdueFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.spare_return_overdue_flagged';
  payload: SpareReturnOverdueFlaggedPayload;
}

// ---------------------------------------------------------------------------
// Story 7.5: calibration register and non-overridable lockout (FR-M-12, FR-M-13, AD-8)
// ---------------------------------------------------------------------------
//
// The lockout GATE already exists (src/compliance/calibration.ts, called from persistEvent for
// every qc.result_recorded). These six events build the register that FEEDS it. Every payload
// field an applier can derive from a locked row is DECLARED here and CHECKED against the
// derivation in src/compliance/calibration-register.ts, never trusted: a declared-but-unchecked
// field is a silent corruption channel on the direct POST /api/v1/events path, and here that
// channel writes a LOCKOUT status. Divergence rejects 409 CALIBRATION_DERIVATION_MISMATCH.
//
// All calendar fields (calibrated_on, valid_until, business_date) are DATE strings in YYYY-MM-DD.
// All instants (registered_at, recorded_at, flagged_at, expired_at, raised_at, resolved_at)
// require an explicit UTC offset (the Story 7.2 offset lesson).

/**
 * Story 7.5 (FR-M-12): one Story 7.1 asset registered as a measuring instrument. stream_id is
 * instrument_record_id. Registration is FAIL CLOSED: the applier writes
 * instrument_calibration_statuses at 'out_of_calibration', never through
 * ensureInstrumentCalibrationRow, whose 'calibrated' default would silently make every new
 * instrument usable for measurement - the exact defect AD-8 exists to prevent.
 */
export interface InstrumentRegisteredPayload {
  instrument_record_id: string;
  asset_id: string;
  instrument_id: string;
  location_id: string;
  calibration_interval_days: number;
  registered_at: string;
}

export interface InstrumentRegisteredEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.instrument_registered';
  payload: InstrumentRegisteredPayload;
}

/**
 * Story 7.5 (FR-M-12): an in-house or ISO 17025 calibration certificate recorded against a
 * registered instrument. stream_id is certificate_id. Supersedes the previous active certificate
 * in the SAME transaction, writes calibration_status 'calibrated', and auto-resolves any open
 * escalation. instrument_id is DECLARED and CHECKED against the locked register row: a forged
 * certificate event is the one payload in this story that can UNLOCK an instrument.
 * A certificate whose valid_until precedes business_date is rejected 422 CERTIFICATE_EXPIRED
 * rather than silently accepted - accepting it would leave the operator believing the instrument
 * is usable while the gate still blocks every measurement.
 */
export interface CalibrationCertificateRecordedPayload {
  certificate_id: string;
  instrument_record_id: string;
  instrument_id: string;
  calibration_type: 'in_house' | 'iso_17025';
  certificate_number: string;
  issuing_lab: string | null;
  calibrated_on: string;
  valid_until: string;
  business_date: string;
  recorded_at: string;
}

export interface CalibrationCertificateRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.calibration_certificate_recorded';
  payload: CalibrationCertificateRecordedPayload;
}

/**
 * Story 7.5 (FR-M-12, AC 1): a staged 30/14/7-day expiry warning raised by the POST-triggered
 * scan. stream_id is alert_id. The grain is (certificate_id, stage_days) - once per stage per
 * certificate, not once per day - enforced by uq_instrument_calibration_alert_stage. valid_until
 * and the stage arithmetic are re-derived under the certificate row's FOR UPDATE lock: a forged
 * alert occupying a (certificate_id, stage_days) grain would suppress the genuine warning.
 */
export interface CalibrationExpiryFlaggedPayload {
  alert_id: string;
  certificate_id: string;
  instrument_record_id: string;
  stage_days: number;
  valid_until: string;
  business_date: string;
  flagged_at: string;
}

export interface CalibrationExpiryFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.calibration_expiry_flagged';
  payload: CalibrationExpiryFlaggedPayload;
}

/**
 * Story 7.5 (FR-M-13, AC 2): the expiry flip. stream_id is instrument_record_id. Marks the
 * certificate 'expired' and writes calibration_status 'out_of_calibration' through
 * setCalibrationStatusFromRegister, which locks the instrument for measurement. valid_until is
 * re-derived from the locked certificate and the business_date comparison re-evaluated, so a
 * forged event cannot expire a certificate that is still valid.
 */
export interface CalibrationExpiredPayload {
  instrument_record_id: string;
  instrument_id: string;
  certificate_id: string;
  valid_until: string;
  business_date: string;
  expired_at: string;
}

export interface CalibrationExpiredEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.calibration_expired';
  payload: CalibrationExpiredPayload;
}

/**
 * Story 7.5 (FR-M-13, AC 3): a DOA-routed escalation on a locked-out instrument. stream_id is
 * escalation_id. The applier inserts one 'open' escalation row and NOTHING else: it must not
 * touch instrument_calibration_statuses, must not write a certificate, and must not set any
 * expiry field. AC 3 is a NEGATIVE property - the escalation expedites re-calibration but never
 * bypasses the lockout - so the table itself carries no status column and the applier has no
 * status write path at all.
 */
export interface CalibrationEscalationRaisedPayload {
  escalation_id: string;
  instrument_record_id: string;
  instrument_id: string;
  doa_entry_id: string;
  routed_approver_user_id: string;
  reason: string | null;
  raised_at: string;
}

export interface CalibrationEscalationRaisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.calibration_escalation_raised';
  payload: CalibrationEscalationRaisedPayload;
}

/**
 * Story 7.5 (AC 3): an open escalation closed against an ACTIVE certificate. stream_id is
 * escalation_id. Emitted both by the standalone resolve route and from inside the certificate
 * applier's transaction when recording a certificate auto-resolves an open escalation. Resolution
 * requires a certificate that is active for that instrument at resolve time, so an escalation
 * cannot be closed without the re-calibration it exists to expedite. Like the raise, it has NO
 * calibration status effect: the certificate event is what sets 'calibrated'.
 */
export interface CalibrationEscalationResolvedPayload {
  escalation_id: string;
  resolving_certificate_id: string;
  resolved_at: string;
}

export interface CalibrationEscalationResolvedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.calibration_escalation_resolved';
  payload: CalibrationEscalationResolvedPayload;
}

// ---------------------------------------------------------------------------
// Story 7.6: statutory examinations, cost accumulation, and machine status broadcast
// (FR-M-14, FR-M-15, FR-M-16)
// ---------------------------------------------------------------------------
//
// Three new events on the existing 'maintenance' stream, all requiresBusinessStream false (the
// Story 7.2 precedent: maintenance operational state, never a tagged inventory movement). Every
// payload field an applier can derive from a locked row is DECLARED here and CHECKED against the
// derivation in src/compliance/maintenance-statutory.ts / src/compliance/asset-operational-status.ts,
// never trusted: a declared-but-unchecked field is a silent corruption channel on the direct
// POST /api/v1/events path, and here a forged statutory_examination_recorded would suppress the
// genuine lockout while a forged asset_status_changed with a fabricated sign_off_by would bypass
// the return-to-service gate. Divergence rejects 409 STATUTORY_DERIVATION_MISMATCH or 409
// COST_DERIVATION_MISMATCH.
//
// All calendar fields (examined_on, next_due_date, business_date) are DATE strings in YYYY-MM-DD.
// All instants (recorded_at, flagged_at, changed_at, sign_off_at) require an explicit UTC offset
// (the Story 7.2 offset lesson).

/**
 * Story 7.6 (FR-M-14): records a statutory examination event against an asset - either an OSH
 * Code examination or a weighbridge legal-metrology stamp. stream_id is examination_id. Inserts or
 * updates one statutory_examination row (status 'compliant', next_due_date re-derived as
 * examined_on + interval_months in SQL) and inserts one statutory_examination_record row.
 * next_due_date is DECLARED and CHECKED against the derivation under the asset's lock, so a forged
 * event cannot push a due date out. Recording an examination whose next_due_date is already before
 * business_date is rejected 422 EXAMINATION_ALREADY_OVERDUE, never silently accepted.
 */
export interface StatutoryExaminationRecordedPayload {
  examination_id: string;
  asset_id: string;
  examination_type: 'osh_code' | 'weighbridge_legal_metrology';
  interval_months: number;
  examined_on: string;
  /** Derivable: examined_on + interval_months in SQL; declared and checked under lock. */
  next_due_date: string;
  certificate_number_ext: string | null;
  device_key: string | null;
  business_date: string;
  recorded_at: string;
}

export interface StatutoryExaminationRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.statutory_examination_recorded';
  payload: StatutoryExaminationRecordedPayload;
}

/**
 * Story 7.6 (FR-M-14, AC 1 / AC 2): the overdue flip emitted by the POST-triggered scan. stream_id
 * is examination_id. Flips statutory_examination.status to 'overdue', which locks the asset from
 * use (AC1) and blocks trade weighment on the device (AC2). The scan holds the examination row
 * under FOR UPDATE so two concurrent scans serialize into one overdue flip; a lost race to
 * uq_statutory_examination_asset_type is skipped, never failing the whole scan.
 */
export interface StatutoryExaminationOverduePayload {
  examination_id: string;
  asset_id: string;
  examination_type: 'osh_code' | 'weighbridge_legal_metrology';
  next_due_date: string;
  business_date: string;
  flagged_at: string;
}

export interface StatutoryExaminationOverdueEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.statutory_examination_overdue';
  payload: StatutoryExaminationOverduePayload;
}

/**
 * Story 7.6 (FR-M-16): one machine status transition. stream_id is asset_id. The applier validates
 * the state machine (Table 5), re-derives previous_status from the locked row, resolves the DOA
 * approver for return-to-service transitions under lock, writes sign_off_by / sign_off_at back onto
 * the persisted payload, and upserts asset_operational_status. previous_status is null on the
 * first transition (no prior row). A transition to 'running' from 'breakdown' or 'maintenance'
 * requires a supervisor sign-off (AC5); a fabricated sign_off_by is rejected 409
 * COST_DERIVATION_MISMATCH under the applier's re-derivation.
 */
export interface AssetStatusChangedPayload {
  asset_id: string;
  previous_status: 'running' | 'idle' | 'breakdown' | 'maintenance' | null;
  new_status: 'running' | 'idle' | 'breakdown' | 'maintenance';
  changed_by: string;
  changed_at: string;
  /** Derived under lock: resolved DOA approver for a return-to-service transition, else null. */
  sign_off_by: string | null;
  sign_off_at: string | null;
}

export interface AssetStatusChangedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.asset_status_changed';
  payload: AssetStatusChangedPayload;
}

// ---------------------------------------------------------------------------
// Story 6.1: production order creation and release gate (FR-MO-01, FR-MO-02, FR-MO-03)
// ---------------------------------------------------------------------------
//
// Four new events on a new 'production' stream. Only production_order.created carries
// requiresBusinessStream: true - that is what makes AC1's UNTAGGED_TRANSACTION fire inside
// persistEvent with zero handler-side code (the indent.raised precedent). The lifecycle
// transitions do not re-carry a business stream: the order row already holds it, and re-tagging
// every transition would make the tag a mutable field, which AD-14 forbids.
//
// Every payload field an applier can derive from a locked row is DECLARED here and CHECKED against
// the derivation in src/compliance/production-order.ts, never trusted: a declared-but-unchecked
// field is a silent corruption channel on the direct POST /api/v1/events path. Divergence rejects
// 409 PRODUCTION_ORDER_DERIVATION_MISMATCH, except for the order number, which has its own 409
// ORDER_NUMBER_IMMUTABLE. order_quantity is an exact decimal STRING (never a JS number); every
// instant (created_at, released_at, changed_at, cancelled_at) requires an explicit UTC offset (the
// Story 7.2 offset lesson); business_date is a DATE string in YYYY-MM-DD.
//
// production_order.released is the highest-risk applier in this story: a forged release with
// expediting_flag true and a fabricated override_by would defeat AC6 and AC7 in one move, and a
// forged release with no override on a short order would defeat AC5. Both paths are re-derived
// inside the transaction, not merely checked in the handler.

/**
 * Story 6.1 (FR-MO-01): creates a Planned production order. stream_id is production_order_id.
 * order_number_ext is DECLARED but NEVER trusted: the applier allocates it from the sequence and
 * rejects 409 ORDER_NUMBER_IMMUTABLE on any declared value that disagrees. output_sku and order_uom
 * are re-derived from item_master under lock. source_reference_id is recorded but NOT resolved
 * against Story 2.9 / Story 4.3 projections in Phase 1 (Binding Scope Decision 10).
 */
export interface ProductionOrderCreatedPayload {
  production_order_id: string;
  /** Server-allocated from production_order_number_seq in MO-YYYY-NNNN format; declared and rejected on disagreement. */
  order_number_ext: string;
  output_item_id: string;
  /** Derivable: output_item_id -> item_master.sku; declared and checked under lock. */
  output_sku: string;
  order_quantity: string;
  /** Derivable: output_item_id -> item_master.uom; declared and checked under lock. */
  order_uom: string;
  plant_location_id: string;
  bom_id: string;
  business_stream: string;
  source_reference_type: 'erp_sales_order' | 'indent' | 'rd_project' | 'manual';
  source_reference_id: string;
  created_by: string;
  created_at: string;
  /**
   * Story 6.3 (FR-MO-10, Binding Decision 9): the rework linkage. A rework order is an ORDINARY
   * production order, not a new event type, so AC7 linked rework order is these two nullable fields
   * on the existing creation contract. source_rework_event_id must name a persisted
   * qc.rework_requested event (404 REWORK_EVENT_NOT_FOUND otherwise) and source_lot_id must be the
   * lot that event names; the pair is all-or-nothing and one rework order per rework event is a
   * database fact (uq_production_order_source_rework_event). Both default to null on an ordinary
   * order, so every pre-6.3 producer is unaffected.
   */
  source_rework_event_id?: string | null;
  source_lot_id?: string | null;
}

export interface ProductionOrderCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.created';
  payload: ProductionOrderCreatedPayload;
}

/**
 * Story 6.1 (FR-MO-03): releases a Planned order. stream_id is production_order_id. The applier
 * re-runs the release gate under lock: released_revision_id is re-derived from the explosion
 * result, the gate satisfied verdict is recomputed, and override_by is re-resolved through the DOA
 * registry (AD-3) when expediting_flag is true. A forged release with a fabricated override_by is
 * rejected 403 APPROVAL_REQUIRED; a shortfall without an override is rejected 409
 * INSUFFICIENT_STOCK. override_by / override_reason must both be null when expediting_flag is
 * false (the expediting-pairing CHECK backstops the same rule at the database level).
 */
export interface ProductionOrderReleasedPayload {
  production_order_id: string;
  /** Derivable: current released revision of the BOM from the explosion result; declared and checked. */
  released_revision_id: string;
  business_date: string;
  expediting_flag: boolean;
  /** Derivable: resolved DOA approver when expediting_flag is true, else null; declared and checked. */
  override_by: string | null;
  override_reason: string | null;
  released_by: string;
  released_at: string;
}

export interface ProductionOrderReleasedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.released';
  payload: ProductionOrderReleasedPayload;
}

/**
 * Story 6.1 (FR-MO-02): one lifecycle transition on the planned -> released -> in_process ->
 * completed -> closed spine. stream_id is production_order_id. previous_status is re-derived from
 * the locked row and checked; a transition not listed in the Lifecycle Contract (Table 2) rejects
 * 400 INVALID_STATE_TRANSITION.
 */
export interface ProductionOrderStateChangedPayload {
  production_order_id: string;
  /** Derivable: status of the locked order row; declared and checked. */
  previous_status: string;
  new_status: 'in_process' | 'completed' | 'closed';
  changed_by: string;
  changed_at: string;
  /**
   * Story 6.4 (FR-MO-12, AC 3): SERVER-DERIVED, written back onto the payload by the closure gate
   * and present ONLY on the transition into `closed`. A caller that declares it is rejected 409
   * PRODUCTION_ORDER_DERIVATION_MISMATCH - the gate's verdict is not a field a client may assert.
   */
  closure_checks?: {
    wip_net_open_quantity: string;
    wip_net_open_value: string;
    open_stage_count: number;
    output_lot_count: number;
    dispositioned_lot_count: number;
  };
  /**
   * Story 6.4 (FR-B-08, AC 7): SERVER-DERIVED summary of the consumption variance report written
   * to production_consumption_variance in this same transaction; present ONLY on the transition
   * into `closed`, and likewise rejected when declared. `computed: false` with an
   * `unavailable_reason` records the disclosed degradation: the BOM moved under a finished order,
   * so the expectation could not be resolved and closure proceeded without a report rather than
   * trapping the order in `completed`.
   */
  variance?: {
    computed: boolean;
    unavailable_reason: string | null;
    basis_quantity: string;
    revision_id: string | null;
    tolerance_percent: string;
    line_count: number;
    breached_line_count: number;
    breached_lines: Array<{
      bom_line_id: string;
      component_sku: string;
      expected_quantity: string;
      actual_quantity: string;
      variance_percent: string | null;
      implied_scrap_percent: string | null;
    }>;
  };
}

export interface ProductionOrderStateChangedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.state_changed';
  payload: ProductionOrderStateChangedPayload;
}

/**
 * Story 6.1 (FR-MO-02): cancels from planned or released. stream_id is production_order_id.
 * previous_status and unreversed_transaction_count are re-derived from the locked row: a cancel
 * from a state that is not planned or released rejects 400 INVALID_STATE_TRANSITION (AC3), and a
 * cancel from released while unreversed_transaction_count > 0 rejects 409 UNREVERSED_TRANSACTIONS
 * (AC4). The counter is written only by Story 6.2's issue/return paths.
 */
export interface ProductionOrderCancelledPayload {
  production_order_id: string;
  /** Derivable: status of the locked order row; declared and checked. */
  previous_status: string;
  /** Derivable: unreversed_transaction_count of the locked order row; declared and checked. */
  unreversed_transaction_count: number;
  cancelled_by: string;
  cancelled_at: string;
  reason_code: string | null;
}

export interface ProductionOrderCancelledEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.cancelled';
  payload: ProductionOrderCancelledPayload;
}

// ---------------------------------------------------------------------------
// Story 6.2: material staging, issue, and WIP ledger (FR-MO-04, FR-MO-05, FR-MO-06)
// ---------------------------------------------------------------------------
//
// Four new events on the EXISTING 'production' stream; stream_id is production_order_id for all
// four. All four are requiresBusinessStream: false - the order row already holds the tag (created
// with it in 6.1), and re-tagging every material event would make the tag a mutable field, which
// AD-14 forbids. The stream is NOT added to INVENTORY_MOVEMENT_STREAM_TYPES for the same reason
// 6.1 gave: widening that set would force a business_stream onto every production event.
//
// Every payload field an applier can derive from a locked row or the explosion result is DECLARED
// here and CHECKED against the derivation in src/compliance/production-material.ts, never trusted
// (the 6.1 Compliance Seam Contract). Divergence rejects 409
// PRODUCTION_MATERIAL_DERIVATION_MISMATCH. Fields marked "write-back" are stamped by the applier
// onto envelope.payload BEFORE the domain_events insert, so the direct-event and handler paths
// persist byte-identical payloads. Every instant requires an explicit UTC offset bounded to
// +/-15:59; every quantity is an exact decimal STRING (never a JS number) matching the NUMERIC
// (18,6) ceiling; business_date is a valid IST YYYY-MM-DD (the 6.1 validators, copied verbatim).
//
// These four are the highest-risk appliers in the production stream after release: a forged issue
// inflates the order's WIP at a fabricated cost, a forged confirmation backflushes stock that was
// never consumed, a fabricated return posting restores a lot identity no issue ever drained, and a
// forged staging event allocates stock at a bin outside the order's plant. Every one of those is
// re-derived inside the transaction, never merely checked in the handler.

/**
 * One drained balance row's WIP posting (write-back). The issue/confirmation appliers call
 * applyStockIssue / applyStockIssueUnderSite, which RETURN their drained-row detail; the seam
 * writes ONE posting per drained row (Binding Decision 7) so a return can restore the exact
 * (location, lot) grain the drain took. posting_value is computed in SQL NUMERIC, never in JS.
 */
export interface ProductionMaterialPosting {
  posting_id: string;
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  lot_number: string | null;
  source_location_id: string;
  quantity: string;
  unit_cost: string;
  posting_value: string;
}

/**
 * Story 6.2 (FR-MO-04): stages one or more directed-issue requirement lines of a Released order.
 * stream_id is production_order_id. Staging is THIS story's pick-task generation (Binding Decision
 * 3): one production_order_stage row per line, holding stock in `allocated` at the operator-named
 * source bin. revision_id is re-derived from the explosion (must equal the order's
 * released_revision_id - BOM_REVISION_DRIFT otherwise); component_item_id / component_sku /
 * required_quantity are re-derived per line; source_location_id must be a plant descendant;
 * stage_id and business_date are server-written back.
 */
export interface ProductionOrderMaterialStagedPayload {
  production_order_id: string;
  /** Derivable: explosion revision of the order's released BOM; declared and checked (BOM_REVISION_DRIFT on mismatch). */
  revision_id: string;
  /** Write-back: IST calendar date of staged_at. */
  business_date: string;
  lines: {
    /** Write-back: server-minted UUIDv4. */
    stage_id: string;
    bom_line_id: string;
    /** Derivable: the explosion line's component_item_id; declared and checked. */
    component_item_id: string;
    /** Derivable: the explosion line's component_sku; declared and checked. */
    component_sku: string;
    /** Derivable: the explosion line's required_quantity (exact decimal string); declared and checked. */
    required_quantity: string;
    source_location_id: string;
    lot_number: string | null;
    /** Write-back: metadata.actor.user_id. */
    staged_by: string;
    staged_at: string;
  }[];
}

export interface ProductionOrderMaterialStagedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.material_staged';
  payload: ProductionOrderMaterialStagedPayload;
}

/**
 * Story 6.2 (FR-MO-05): issues staged material to the order. stream_id is production_order_id.
 * The applier locks the stage row FOR UPDATE, deallocates BEFORE issuing (the 7.4 binding order),
 * and writes one WIP posting per drained balance row (write-back). quantity is bounded by the
 * stage's remaining quantity; unit_cost is server-derived from the Story 2.4 running average
 * (WIP_COST_UNRESOLVED fail-closed).
 */
export interface ProductionOrderMaterialIssuedPayload {
  production_order_id: string;
  stage_id: string;
  quantity: string;
  /** Write-back: metadata.actor.user_id. */
  issued_by: string;
  issued_at: string;
  /** Write-back: one entry per drained balance row. */
  postings: ProductionMaterialPosting[];
}

export interface ProductionOrderMaterialIssuedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.material_issued';
  payload: ProductionOrderMaterialIssuedPayload;
}

/**
 * Story 6.2 (FR-MO-04): posts a production confirmation; backflush components drain plant-wide in
 * proportion to the confirmed quantity. stream_id is production_order_id. The applier re-explodes
 * at confirmed_quantity (proportionality by construction - AC2), pre-checks EVERY backflush line's
 * availability (AC3 shortfall_lines[] carries every deficient line), then drains through
 * applyStockIssueUnderSite. revision_id is re-derived; backflush_lines[] (with their postings),
 * business_date and confirmed_by are written back.
 */
export interface ProductionOrderConfirmationRecordedPayload {
  production_order_id: string;
  confirmed_quantity: string;
  /** Derivable: explosion revision of the order's released BOM; declared and checked (BOM_REVISION_DRIFT on mismatch). */
  revision_id: string;
  /** Write-back: IST calendar date of confirmed_at. */
  business_date: string;
  /** Write-back: metadata.actor.user_id. */
  confirmed_by: string;
  confirmed_at: string;
  /** Write-back: one entry per backflush requirement line. */
  backflush_lines: {
    bom_line_id: string;
    component_sku: string;
    required_quantity: string;
    postings: ProductionMaterialPosting[];
  }[];
}

export interface ProductionOrderConfirmationRecordedEnvelope extends Omit<
  EventEnvelope,
  'payload'
> {
  event_type: 'production_order.confirmation_recorded';
  payload: ProductionOrderConfirmationRecordedPayload;
}

/**
 * Story 6.2 (FR-MO-06): returns issued material to stock, reversing WIP at the SOURCE posting's
 * unit_cost (the issued cost - AC5) and restoring the original location and lot grain. stream_id
 * is production_order_id. source_posting_id names one issued/backflush posting of THIS order
 * (RETURN_SOURCE_MISMATCH otherwise); quantity is bounded by the posting's open_quantity in SQL
 * NUMERIC (RETURN_EXCEEDS_ISSUE - AC6, rejected never clamped); reason_code must be non-blank
 * (REASON_CODE_REQUIRED - AC5) and a member of config.production.materialReturnReasonCodes
 * (RETURN_REASON_CODE_INVALID 422 with the allowed list). posting_id is server-minted write-back.
 */
export interface ProductionOrderMaterialReturnedPayload {
  production_order_id: string;
  source_posting_id: string;
  quantity: string;
  reason_code: string;
  /** Write-back: metadata.actor.user_id. */
  returned_by: string;
  returned_at: string;
  /** Write-back: server-minted UUIDv4. */
  posting_id: string;
}

export interface ProductionOrderMaterialReturnedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.material_returned';
  payload: ProductionOrderMaterialReturnedPayload;
}

// ---------------------------------------------------------------------------
// Story 6.3: production completions, scrap and the close-short decision
// (FR-MO-07, FR-MO-08, FR-MO-09, FR-MO-10)
// ---------------------------------------------------------------------------
//
// Three new events on the EXISTING 'production' stream; stream_id is production_order_id for all
// three, and all three are requiresBusinessStream false (the order row already holds the tag, and
// re-tagging a downstream event would make the tag mutable - AD-14). All three require order status
// 'in_process' (Binding Decision 12): material may be staged and issued while an order is merely
// released, but nothing is produced, scrapped or short-closed until the order is actually running.
//
// Every field documented as derived is DECLARED by the client and CHECKED against the server
// re-derivation under the order lock (409 PRODUCTION_COMPLETION_DERIVATION_MISMATCH on divergence);
// every field documented as write-back is stamped onto envelope.payload by the applier before the
// domain_events insert, so the direct-event and handler paths persist byte-identical payloads.

/** One drained source posting of a WIP relief pass; write-back only, never client-declared. */
export interface ProductionWipReliefEntry {
  posting_id: string;
  source_posting_id: string;
  bom_line_id: string;
  component_item_id: string;
  component_sku: string;
  lot_number: string | null;
  source_location_id: string;
  quantity: string;
  unit_cost: string;
  posting_value: string;
}

/** One output lot of a completion; write-back only, never client-declared. */
export interface ProductionCompletionOutput {
  completion_id: string;
  output_class: 'primary' | 'co_product' | 'by_product';
  bom_line_id: string | null;
  output_item_id: string;
  output_sku: string;
  lot_id: string;
  lot_number: string;
  quantity: string;
  uom: string;
  qc_task_id: string;
}

/**
 * Story 6.3 (FR-MO-07, FR-MO-09; AC 1, AC 2, AC 3, AC 5): posts a completion. The applier creates
 * the primary output lot AND one lot per co-product and by-product line of the pinned released
 * revision, posts each one finished stock at the order plant, and hands each one to the Story 8.1
 * QC gate through receiveQcCompletion on the SAME transaction - so a lot that cannot enter the gate
 * (no approved inspection plan, mismatched stock, stock already in sellable use) rolls the whole
 * completion back, which is what makes AC2 QC_HOLD_REQUIRED structural rather than a check.
 *
 * primary_quantity is the ONLY quantity the client supplies; every secondary quantity comes from
 * the BOM line expected_yield_percent. The CUMULATIVE primary quantity (not this event quantity) is
 * what the tolerance ceiling bounds, so repeated small over-completions cannot walk past it one at
 * a time. Over the ceiling, over_completion_approved must be true AND approved_by must be the
 * DOA-resolved approver AND the acting user must BE that approver (403 APPROVAL_REQUIRED
 * otherwise, the Story 6.1 release-override chain verbatim).
 */
export interface ProductionOrderCompletionPostedPayload {
  production_order_id: string;
  primary_quantity: string;
  completed_at: string;
  /** Derived: must equal the order released_revision_id (409 BOM_REVISION_DRIFT otherwise). */
  revision_id?: string;
  over_completion_approved?: boolean;
  /** Required exactly when over_completion_approved is true; must be the resolved DOA approver. */
  approved_by?: string | null;
  /** Write-back: IST calendar date of completed_at. */
  business_date?: string;
  /** Write-back: one entry per output lot, primary first. */
  outputs?: ProductionCompletionOutput[];
  /** Write-back: one entry per drained source posting. */
  wip_relief?: ProductionWipReliefEntry[];
  /** Write-back: total WIP value relieved by this completion. */
  relieved_value?: string;
  /** Write-back: metadata.actor.user_id. */
  completed_by?: string;
}

export interface ProductionOrderCompletionPostedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.completion_posted';
  payload: ProductionOrderCompletionPostedPayload;
}

/**
 * Story 6.3 (FR-MO-08, AC 4): declares process scrap. WIP is relieved by the declared scrap VALUE
 * at the source postings issued cost, oldest open posting first; NO stock moves and no lot is
 * created (Binding Decision 10) - the physical scrap intake is Phase 2 (Epic 16, FR-SC) and this
 * row is its AD-10 source document. A declaration whose value would exceed the order open WIP is
 * rejected 409 SCRAP_EXCEEDS_WIP, never clamped. reason_code must be non-blank (400
 * REASON_CODE_REQUIRED) and a member of config.production.scrapReasonCodes (422
 * SCRAP_REASON_CODE_INVALID with the allowed list).
 */
export interface ProductionOrderScrapDeclaredPayload {
  production_order_id: string;
  scrap_quantity: string;
  reason_code: string;
  declared_at: string;
  /** Write-back: server-minted UUIDv4. */
  scrap_id?: string;
  /** Derived: the order order_uom. */
  uom?: string;
  /** Write-back: IST calendar date of declared_at. */
  business_date?: string;
  /** Write-back: total WIP value relieved. */
  relieved_value?: string;
  /** Write-back: one entry per drained source posting. */
  wip_relief?: ProductionWipReliefEntry[];
  /** Write-back: metadata.actor.user_id. */
  declared_by?: string;
}

export interface ProductionOrderScrapDeclaredEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.scrap_declared';
  payload: ProductionOrderScrapDeclaredPayload;
}

/**
 * Story 6.3 (FR-MO-09, AC 6): records the supervisor close-short decision on an order whose
 * cumulative primary output fell below the short floor. It stamps the reason, relieves ALL
 * remaining open WIP so the Story 6.4 zero-WIP closure gate can pass at the reduced quantity, and
 * records how the residual material was dispositioned. It does NOT transition the order: the
 * in_process to completed move stays on the Story 6.1 state_changed route and closure is Story 6.4
 * (Binding Decision 11).
 *
 * residual_disposition is a RECORDED FACT about work already done through the Story 6.2 return
 * route or a scrap declaration, not an instruction this event executes. A second decision on the
 * same order is 409 SHORT_CLOSE_EXISTS; a decision on an order at or above the floor is 409
 * SHORT_CLOSE_NOT_APPLICABLE.
 */
export interface ProductionOrderShortCloseRecordedPayload {
  production_order_id: string;
  reason_code: string;
  residual_disposition: 'returned' | 'scrapped';
  decided_at: string;
  /** Write-back: IST calendar date of decided_at. */
  business_date?: string;
  /** Write-back: cumulative primary completed quantity at decision time. */
  completed_quantity?: string;
  /** Write-back: total WIP value relieved. */
  relieved_value?: string;
  /** Write-back: one entry per drained source posting. */
  wip_relief?: ProductionWipReliefEntry[];
  /** Write-back: metadata.actor.user_id. */
  short_closed_by?: string;
}

export interface ProductionOrderShortCloseRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'production_order.short_close_recorded';
  payload: ProductionOrderShortCloseRecordedPayload;
}

// ---------------------------------------------------------------------------
// Story 7.7: AMC, warranty, and insurance tracking (FR-M-10, FR-M-11)
// ---------------------------------------------------------------------------
//
// Three new events on the existing 'maintenance' stream, all requiresBusinessStream false (the
// Story 7.2 / 7.6 precedent: maintenance operational state, never a tagged inventory movement).
// One coverage model serves AMC, warranty, and insurance (Binding Decision 13); only 'warranty'
// drives the work-order check.
//
// Every payload field an applier can derive from a locked row is DECLARED here and CHECKED against
// the derivation in src/compliance/maintenance-coverage.ts, never trusted: a declared-but-unchecked
// field is a silent corruption channel on the direct POST /api/v1/events path. Here a forged
// overridden_by would hand the warranty override to someone the DOA registry never authorized, and
// a forged coverage_expiry_flagged would burn an alert stage that the genuine scan then skips.
// Divergence rejects 409 COVERAGE_DERIVATION_MISMATCH.
//
// All calendar fields (start_date, expiry_date, business_date) are DATE strings in YYYY-MM-DD;
// every instant (recorded_at, flagged_at, overridden_at) requires an explicit UTC offset (the
// Story 7.2 offset lesson); contract_value is an exact decimal STRING, never a JS number.

/**
 * Story 7.7 (FR-M-10): records one AMC, warranty, or insurance contract against an asset.
 * stream_id is asset_id. Inserts one asset_coverage row. Records are append-only: a renewal is a
 * NEW coverage_id with a fresh set of 90/60/30 alert stages, never an amendment (Binding
 * Decision 5). Recording a coverage that already expired relative to business_date rejects 422
 * COVERAGE_ALREADY_EXPIRED and a future start rejects 422 COVERAGE_FUTURE_START (Binding
 * Decision 6), so neither can corrupt the active-warranty derivation. recorded_by is re-derived
 * from metadata.actor.user_id under the asset's lock and written back onto the persisted payload.
 */
export interface AssetCoverageRecordedPayload {
  coverage_id: string;
  asset_id: string;
  coverage_type: 'amc' | 'warranty' | 'insurance';
  provider_name: string;
  reference_number_ext: string;
  start_date: string;
  expiry_date: string;
  /** Exact decimal string (NUMERIC(14,3)) or null; never a JS number. */
  contract_value: string | null;
  /** Derived under lock from metadata.actor.user_id; declared and checked. */
  recorded_by: string;
  recorded_at: string;
  business_date: string;
}

export interface AssetCoverageRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.coverage_recorded';
  payload: AssetCoverageRecordedPayload;
}

/**
 * Story 7.7 (FR-M-10, AC 1): one staged expiry alert emitted by the POST-triggered coverage scan.
 * stream_id is alert_id. Inserts one asset_coverage_alert row at the (coverage_id, stage_days)
 * grain, which is what makes a same-day re-run a no-op and a skipped day catch up. asset_id,
 * coverage_type and expiry_date are re-derived from the coverage row held FOR UPDATE; a lost race
 * to uq_asset_coverage_alert_stage surfaces 409 DUPLICATE_COVERAGE_ALERT and the scan skips that
 * stage rather than failing.
 */
export interface CoverageExpiryFlaggedPayload {
  alert_id: string;
  coverage_id: string;
  /** Derivable: asset_id of the locked coverage row; declared and checked. */
  asset_id: string;
  /** Derivable: coverage_type of the locked coverage row; declared and checked. */
  coverage_type: 'amc' | 'warranty' | 'insurance';
  stage_days: 90 | 60 | 30;
  /** Derivable: expiry_date of the locked coverage row; declared and checked. */
  expiry_date: string;
  business_date: string;
  flagged_at: string;
}

export interface CoverageExpiryFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.coverage_expiry_flagged';
  payload: CoverageExpiryFlaggedPayload;
}

/**
 * Story 7.7 (FR-M-11, AC 3 and AC 4): the reason-coded override that unblocks chargeable work on a
 * warranty-flagged breakdown work order. stream_id is work_order_id. Inserts one
 * maintenance_warranty_override row, at most one per work order (Binding Decision 11). The applier
 * re-derives the DOA approver for maintenance.warranty_override under the work order's lock and
 * checks overridden_by against it: a forged actor rejects 409 COVERAGE_DERIVATION_MISMATCH, an
 * unauthorized one 403 APPROVAL_REQUIRED, and no governing DOA entry 404 APPROVAL_UNRESOLVED. The
 * event itself IS the durable record of the decision (Binding Decision 15).
 */
export interface WarrantyOverrideRecordedPayload {
  override_id: string;
  work_order_id: string;
  /** Derivable: warranty_coverage_id of the locked work-order row; declared and checked. */
  warranty_coverage_id: string;
  reason_code: string;
  /** Derived under lock: the resolved DOA approver, re-checked against metadata.actor.user_id. */
  overridden_by: string;
  overridden_at: string;
}

export interface WarrantyOverrideRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.warranty_override_recorded';
  payload: WarrantyOverrideRecordedPayload;
}

// ---------------------------------------------------------------------------
// Story 7.8: Offline Technician Workflow and Closure Codes
// ---------------------------------------------------------------------------

/**
 * A technician-facing work-order status transition (FR-M-17, Binding Decision 7). stream_id is
 * work_order_id. Allowed transitions: open or overdue to in_progress, in_progress to on_hold,
 * on_hold to in_progress; anything else rejects 409 INVALID_STATUS_TRANSITION under the work
 * order's lock. previous_status is SEAM-DERIVED from the locked row and written back onto the
 * persisted payload; a declared value rejects WORK_ORDER_DERIVATION_MISMATCH. The updater is
 * metadata.actor.user_id, never read from the payload.
 */
export interface WorkOrderStatusUpdatedPayload {
  work_order_id: string;
  asset_id: string;
  new_status: 'in_progress' | 'on_hold';
  note: string | null;
  updated_at: string;
  /** Derived under lock from the work-order row; persisted write-back only. */
  previous_status?: 'open' | 'overdue' | 'in_progress' | 'on_hold';
}

export interface WorkOrderStatusUpdatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.work_order_status_updated';
  payload: WorkOrderStatusUpdatedPayload;
}

/**
 * A sync conflict raised by the edge upload handler (FR-M-17, Binding Decision 4) AFTER the
 * conflicting persist has rolled back, on a fresh stream whose stream_id is conflict_id. The
 * raise envelope's metadata.actor is the DEVICE actor (the technician), so captured_by is checked
 * against it in the applier (409 SYNC_CONFLICT_DERIVATION_MISMATCH). One row per
 * conflicting_event_id: the raise is idempotent on idempotency_key sync-conflict-<event_id> and
 * uq_maintenance_sync_conflict_event is the race backstop (409 DUPLICATE_SYNC_CONFLICT). reason
 * version_conflict carries expected_version and head_version; safety_fault_rejected carries
 * rejection_code instead.
 */
export interface SyncConflictRaisedPayload {
  conflict_id: string;
  stream_id: string;
  stream_type: 'maintenance';
  conflicting_event_id: string;
  conflicting_event_type: string;
  idempotency_key: string;
  device_id: string;
  captured_by: string;
  location_id: string | null;
  reason: 'version_conflict' | 'safety_fault_rejected';
  expected_version: number | null;
  head_version: number | null;
  rejection_code: string | null;
  conflicting_payload: Record<string, unknown>;
  occurred_at: string;
  raised_at: string;
}

export interface SyncConflictRaisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.sync_conflict_raised';
  payload: SyncConflictRaisedPayload;
}

/**
 * The supervisor's resolution of a sync conflict (Binding Decision 6). stream_id is conflict_id.
 * A decision record only: the platform never re-applies the conflicting payload. Authority is
 * re-derived in the applier through the DOA registry (maintenance.sync_conflict_resolution, value
 * 0) under the conflict row's lock; resolved_by must equal metadata.actor.user_id AND the resolved
 * approver (409 SYNC_CONFLICT_DERIVATION_MISMATCH / 403 APPROVAL_REQUIRED / 404
 * APPROVAL_UNRESOLVED).
 */
export interface SyncConflictResolvedPayload {
  conflict_id: string;
  resolution_code: 'discarded' | 'reapplied_centrally';
  resolution_note: string | null;
  resolved_by: string;
  resolved_at: string;
}

export interface SyncConflictResolvedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'maintenance.sync_conflict_resolved';
  payload: SyncConflictResolvedPayload;
}

// ---------------------------------------------------------------------------
// Story 8.1: Inspection Plans and QC Gate
// ---------------------------------------------------------------------------

/**
 * One characteristic line of an immutable plan version (Annex requirement 4). result_kind pairs
 * with its limits: numeric carries at least one bounded NUMERIC-string limit and no criteria;
 * attribute carries textual criteria and no limits. Every value is a decimal STRING, never a JS
 * float.
 */
export interface InspectionPlanCharacteristicInput {
  characteristic_id: string;
  line_no: number;
  characteristic_name: string;
  characteristic_class: 'critical' | 'major' | 'minor';
  test_method_ref: string;
  instrument_type: string | null;
  result_kind: 'numeric' | 'attribute';
  lower_limit: string | null;
  upper_limit: string | null;
  limit_uom: string | null;
  acceptance_criteria: string | null;
  sample_handling: string;
}

/**
 * Creates one IMMUTABLE inspection-plan version (FR-Q-01, AC 1). stream_id is the plan_id (the
 * scope-grain header, created by the first version's event). plan_id, plan_version_id and every
 * characteristic_id are minted BEFORE persistence so replay creates nothing random. The seam
 * re-derives the item (active), the BOM revision (released, production or job_work_kit, owned by
 * the item) and the header grain under pg_advisory_xact_lock(plan_id); version_no and sku are
 * SEAM-DERIVED and written back (a declared value rejects QC_DERIVATION_MISMATCH). Same-date
 * conflicts reject 409 INSPECTION_PLAN_EFFECTIVITY_CONFLICT; a foreign-grain plan_id rejects
 * 409 INSPECTION_PLAN_SCOPE_MISMATCH.
 */
export interface InspectionPlanCreatedPayload {
  plan_id: string;
  plan_version_id: string;
  scope: 'standard' | 'customer_override';
  item_id: string;
  bom_revision_id: string;
  source_order_type: 'job_work_order' | null;
  source_order_ref: string | null;
  effective_from: string;
  aql: string | null;
  inspection_level: string | null;
  characteristics: InspectionPlanCharacteristicInput[];
  created_at: string;
  /** Derived under lock; persisted write-back only. */
  version_no?: number;
  /** Derived from item_master; persisted write-back only. */
  sku?: string;
}

export interface InspectionPlanCreatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.inspection_plan_created';
  payload: InspectionPlanCreatedPayload;
}

/**
 * Appends exactly one approval record to an unapproved version (FR-Q-01, AC 1, Binding Scope
 * Decision 10). Authority resolves through the DOA registry (qc.inspection_plan_approval, value
 * 0) INSIDE the transaction; the governing role must be QC Head-level (config.quality.qcHeadRoles),
 * an active holder or delegate must exist, and the acting user must BE the resolved approver
 * (404 APPROVAL_UNRESOLVED / 403 APPROVAL_REQUIRED). approved_by, resolved_approver_user_id,
 * doa_entry_id and governing_role are SEAM-DERIVED write-backs; a declared value rejects
 * QC_DERIVATION_MISMATCH. A second approval rejects 409 INSPECTION_PLAN_ALREADY_APPROVED.
 */
export interface InspectionPlanApprovedPayload {
  plan_id: string;
  plan_version_id: string;
  approved_at: string;
  /** Derived under lock; persisted write-back only. */
  approved_by?: string;
  resolved_approver_user_id?: string;
  doa_entry_id?: string;
  governing_role?: string;
}

export interface InspectionPlanApprovedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.inspection_plan_approved';
  payload: InspectionPlanApprovedPayload;
}

/**
 * The producer-neutral completion hand-off (FR-Q-02, AC 3, Binding Scope Decision 7). stream_id is
 * the task_id (a fresh qc stream per finished lot). The producer has ALREADY created the lot and
 * posted its finished stock in the same transaction; this event resolves and freezes the approved
 * plan version, creates the durable task and records the gate as qc_hold. business_stream is the
 * item's tag, server-verified against item_master (requiresBusinessStream true). business_date,
 * sku, plan_id, plan_version_id, plan_scope and gate_status are SEAM-DERIVED write-backs; a
 * declared value rejects QC_DERIVATION_MISMATCH. A missing lot, a lot whose finished stock is
 * absent or already sellable, or a mismatched lot number rejects 409 QC_HOLD_REQUIRED; a missing,
 * draft, future-effective, ambiguous or mismatched plan fails closed (404 INSPECTION_PLAN_NOT_FOUND
 * / 409 INSPECTION_PLAN_NOT_APPROVED / 409 INSPECTION_PLAN_SCOPE_MISMATCH).
 */
export interface QcCompletionReceivedPayload {
  task_id: string;
  source_completion_type: 'synthetic_completion' | 'production_order' | 'job_work_order';
  source_completion_id: string;
  lot_id: string;
  lot_number: string;
  item_id: string;
  quantity: string;
  uom: string;
  site_id: string;
  bom_revision_id: string;
  source_order_type: 'job_work_order' | null;
  source_order_ref: string | null;
  completed_at: string;
  business_stream: string;
  /** Derived under lock; persisted write-back only. */
  business_date?: string;
  sku?: string;
  plan_id?: string;
  plan_version_id?: string;
  plan_scope?: 'standard' | 'customer_override';
  gate_status?: 'qc_hold';
}

export interface QcCompletionReceivedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.completion_received';
  payload: QcCompletionReceivedPayload;
}

/**
 * Records a DOA-gated conditional release (FR-Q-02, FR-Q-05, AC 4 and AC 5). stream_id is the
 * task_id. deviation_id and disposition_id are minted before persistence. The seam locks the lot
 * row, then the task row (the fixed lot, gate, stock lock order), verifies the gate is qc_hold,
 * re-resolves qc.conditional_release under the transaction (404 APPROVAL_UNRESOLVED / 403
 * APPROVAL_REQUIRED), enforces segregation of duties against any known result recorder (409
 * SOD_VIOLATION) and writes one immutable deviation, one shared disposition and the gate
 * transition. requested_by, approved_by, doa_entry_id, inspector_user_id, decided_on,
 * previous_gate_status and gate_status are SEAM-DERIVED write-backs; a declared value rejects
 * QC_DERIVATION_MISMATCH. A second disposition rejects 409 DISPOSITION_EXISTS.
 */
export interface QcConditionalReleaseRecordedPayload {
  task_id: string;
  lot_id: string;
  deviation_id: string;
  disposition_id: string;
  justification: string;
  conditions: string;
  scope_kind: 'internal_movement' | 'order_allocation' | 'dispatch';
  scope_ref: string;
  expires_on: string;
  decided_at: string;
  /** Derived under lock; persisted write-back only. */
  requested_by?: string;
  approved_by?: string;
  doa_entry_id?: string;
  inspector_user_id?: string | null;
  decided_on?: string;
  previous_gate_status?: 'qc_hold';
  gate_status?: 'conditionally_released';
}

export interface QcConditionalReleaseRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.conditional_release_recorded';
  payload: QcConditionalReleaseRecordedPayload;
}

/**
 * Story 8.3 (FR-Q-05, AC 1): the ONE authoritative quality outcome for a lot. stream_id is the
 * task_id. `disposition` is 'accept' or 'reject' only - a conditional release keeps its own Story
 * 8.1 event (qc.conditional_release_recorded) and a split keeps qc.lot_split_recorded; all three
 * write the same shared one-row-per-lot qc_lot_disposition grain, so a second disposition of any
 * kind is 409 DISPOSITION_EXISTS.
 *
 * The seam locks the lot row, then the task row (the fixed lot, gate, stock lock order), requires
 * task_status 'inspected' (409 QC_INSPECTION_REQUIRED), requires the gate to still be qc_hold or
 * conditionally_released, requires the independent manual or recall hold to be clear (400
 * LOT_ON_HOLD), writes one disposition row and the gate transition, and - for a reject - the one
 * open qc_ncr row the outcome command later decides. Accept and reject carry NO DOA gate (Binding
 * Scope Decision 5): doa_entry_id stays null.
 *
 * Every optional field below is SEAM-DERIVED write-back; a client that declares one is rejected
 * with 409 QC_DERIVATION_MISMATCH.
 */
export interface QcLotDispositionedPayload {
  task_id: string;
  lot_id: string;
  disposition_id: string;
  disposition: 'accept' | 'reject';
  justification: string;
  decided_at: string;
  /** Minted by the handler for a reject only; absent or null for an accept. */
  ncr_id?: string | null;
  /**
   * Story 8.6 (Binding Scope Decision 9): optional catalogue defect code, reject only. Carried
   * onto the disposition-origin qc_ncr row for the FR-Q-13 by-defect-code rejection metric; an
   * unknown code is 422 DEFECT_CODE_UNKNOWN.
   */
  defect_code?: string | null;
  /** Derived under lock; persisted write-back only. */
  lot_number?: string;
  sku?: string;
  site_id?: string;
  plan_version_id?: string;
  quantity?: string;
  sampling_outcome?: 'accepted' | 'not_accepted' | null;
  requested_by?: string;
  approved_by?: string;
  inspector_user_id?: string | null;
  previous_gate_status?: 'qc_hold' | 'conditionally_released';
  gate_status?: 'accepted' | 'rejected';
}

export interface QcLotDispositionedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.lot_dispositioned';
  payload: QcLotDispositionedPayload;
}

/**
 * Story 8.3 (FR-Q-05, AC 2): the partial split. stream_id is the parent task_id. The client sends
 * only the split shares (2 to 20 entries, 1-based contiguous `sequence`, positive decimal-string
 * `quantity` summing EXACTLY to the parent lot quantity - 400 QC_SPLIT_QUANTITY_MISMATCH
 * otherwise). Each child lot, lot number, task and source_completion_id is server-minted, the
 * parent's owned stock is relabelled grain by grain onto the children in the same transaction (409
 * INSUFFICIENT_STOCK when the parent's unallocated owned on-hand does not cover the split), and
 * the parent takes the terminal 'split' disposition and gate state.
 *
 * Children inherit the parent's frozen plan_version_id and its whole inspection result set
 * (sampling_id, sampling_outcome, counts, inspector, inspected_at), so each child is immediately
 * dispositionable without re-sampling.
 */
export interface QcLotSplitRecordedPayload {
  task_id: string;
  lot_id: string;
  disposition_id: string;
  justification: string;
  decided_at: string;
  splits: Array<{
    sequence: number;
    quantity: string;
    /** Derived; persisted write-back only. */
    lot_id?: string;
    lot_number?: string;
    task_id?: string;
    source_completion_id?: string;
  }>;
  /** Derived under lock; persisted write-back only. */
  lot_number?: string;
  sku?: string;
  site_id?: string;
  plan_version_id?: string;
  quantity?: string;
  requested_by?: string;
  approved_by?: string;
  inspector_user_id?: string | null;
  previous_gate_status?: 'qc_hold' | 'conditionally_released';
  gate_status?: 'split';
}

export interface QcLotSplitRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.lot_split_recorded';
  payload: QcLotSplitRecordedPayload;
}

/**
 * Story 8.3 (FR-Q-06, AC 3, AC 4 and AC 5): the once-only NCR outcome. stream_id is the ncr_id.
 * 'rework' flags the lot and persists a qc.rework_requested event on the SAME transaction as the
 * integration contract Story 6.3 consumes. 'downgrade' requires a downgrade_sku that exists in
 * item_master and differs from the lot's own SKU (400 DOWNGRADE_SKU_REQUIRED or
 * DOWNGRADE_SKU_INVALID), mints an ungoverned seconds lot and relabels the whole quantity onto it.
 * 'scrap' moves no stock: it sets lot_master.quality_hold_status to 'held' with reason
 * scrap_pending and retains this event as the AD-10 source document for the Phase 2 (Epic 16)
 * FR-SC intake.
 *
 * A second outcome for the same NCR is 409 NCR_OUTCOME_EXISTS (the UPDATE is guarded by
 * `WHERE outcome IS NULL`, so the race and the sequential path return the same code).
 */
export interface QcNcrOutcomeRecordedPayload {
  ncr_id: string;
  lot_id: string;
  outcome: 'rework' | 'downgrade' | 'scrap';
  outcome_reason: string;
  decided_at: string;
  /** Required exactly when outcome is 'downgrade'. */
  downgrade_sku?: string;
  /**
   * Required exactly when outcome is 'rework': the event id the handler mints for the companion
   * qc.rework_requested event it persists on the SAME transaction. The applier writes it into
   * qc_ncr.rework_requested_event_id, and qc.rework_requested is only admissible when its own
   * event_id already sits in that column - that linkage is what makes a direct post of the
   * integration contract impossible to forge.
   */
  rework_event_id?: string;
  /** Derived under lock; persisted write-back only. */
  task_id?: string;
  lot_number?: string;
  sku?: string;
  site_id?: string;
  quantity?: string;
  outcome_by?: string;
  downgrade_lot_id?: string | null;
  downgrade_lot_number?: string | null;
  rework_requested_event_id?: string | null;
  quality_hold_status?: 'none' | 'held';
}

export interface QcNcrOutcomeRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.ncr_outcome_recorded';
  payload: QcNcrOutcomeRecordedPayload;
}

/**
 * Story 8.3 (FR-Q-06, AC 5): the rework integration contract. Persisted by the NCR-outcome command
 * itself, in the same transaction, whenever the outcome is 'rework'. EVERY field is server-derived
 * and the event is only admissible from that owning outcome, so a direct POST is rejected with 409
 * QC_REWORK_NOT_DERIVED. Story 6.3 subscribes to it to create the rework order and the new lot
 * that re-enters the QC gate; until then a synthetic subscriber test proves the shape.
 */
export interface QcReworkRequestedPayload {
  ncr_id: string;
  lot_id: string;
  lot_number: string;
  task_id: string;
  sku: string;
  site_id: string;
  quantity: string;
  plan_version_id: string;
  requested_by: string;
  requested_at: string;
}

export interface QcReworkRequestedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.rework_requested';
  payload: QcReworkRequestedPayload;
}

/**
 * Story 8.4 (FR-Q-07, AC 1, AC 3, AC 6 and AC 7): the batch release record and its CoA/CoC.
 * stream_id is the task_id. Release is a DOWNSTREAM step on top of an already-decided disposition
 * (Binding Scope Decision 1), not a rename of it: the applier refuses 409 QC_RELEASE_NOT_ELIGIBLE
 * unless the lot's qc_lot_disposition row is 'accept' or 'conditional_release', and 409
 * RETENTION_SAMPLE_REQUIRED unless a qc_retention_sample row already exists for the lot. A second
 * release for the same lot is 409 RELEASE_EXISTS (sequentially and under a race, via
 * uq_qc_batch_release_lot / uq_qc_batch_release_disposition).
 *
 * task_id, lot_id and release_id are the ONLY client fields. Every other field is SEAM-DERIVED
 * under the lot lock and written back: disposition_id from the lot's disposition row, document_kind
 * from the released item's item_master.bis_licence_required ('coc' for a BIS-covered product,
 * 'coa' otherwise - Binding Scope Decision 4), retention_years from resolveRetentionYears,
 * retention_expires_on from decided_at + retention_years, bis_licence_number from the
 * register-backed resolveBisLicence over compliance_bis_licence (Story 8.6, reversing Story 8.4's
 * null-never-blocks stub: under QC_STATUTORY_RELEASE_BLOCKS=enforce a BIS-covered product with no
 * valid licence is rejected BIS_LICENCE_INVALID, and a Legal Metrology item with no current
 * approved label_master row is rejected LABEL_VERSION_MISSING; `dormant` preserves the Story 8.4
 * number-if-available behaviour), released_by from the authenticated actor.
 *
 * Server-derived, rejected if declared, in full: disposition_id, retention_sample_id, document_kind,
 * document_ref, retention_years, retention_expires_on, bis_licence_number, released_by, lot_number,
 * sku, site_id, quantity, disposition. Declaring any of them is 409 QC_DERIVATION_MISMATCH.
 */
export interface QcBatchReleaseRecordedPayload {
  task_id: string;
  lot_id: string;
  release_id: string;
  decided_at: string;
  /** Derived under lock; persisted write-back only. */
  disposition_id?: string;
  /** The retention sample this release re-stamped, or null when the scope did not require one. */
  retention_sample_id?: string | null;
  document_kind?: 'coa' | 'coc';
  retention_years?: number;
  retention_expires_on?: string;
  bis_licence_number?: string | null;
  released_by?: string;
  lot_number?: string;
  sku?: string;
  site_id?: string;
  quantity?: string;
  disposition?: 'accept' | 'conditional_release';
}

export interface QcBatchReleaseRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.batch_release_recorded';
  payload: QcBatchReleaseRecordedPayload;
}

/**
 * Story 8.4 (FR-Q-08, AC 4): the retention sample that must exist before a lot can be released
 * (Binding Scope Decision 6 - every released lot, not only BIS-covered products). stream_id is the
 * task_id. Deliberately NOT gated on disposition state: AC 4's ordering ("release attempted before
 * the retention sample is logged") only makes sense if logging can happen any time after the
 * inspection task exists, whether or not release has been attempted.
 *
 * task_id, lot_id, retention_sample_id, quantity, uom, location_id and logged_at are client
 * fields. expires_on is SEAM-DERIVED under lock as logged_at + resolveRetentionYears, and is
 * PROVISIONAL: when the lot is released, applyBatchReleaseRecorded re-stamps it from the release
 * record's retention_expires_on, so exactly one clock governs both rows. (Before that re-stamp
 * existed the two disagreed, and since AC4 forces logged_at <= decided_at the physical sample was
 * always scheduled for disposal before the certificate it backs left retention.) location_id must
 * resolve in location_register; a retention sample is evidentiary and moves no stock (Binding Scope
 * Decision 8).
 *
 * Server-derived, rejected if declared: expires_on, retention_years, logged_by, lot_number, sku,
 * site_id, status.
 */
export interface QcRetentionSampleLoggedPayload {
  task_id: string;
  lot_id: string;
  retention_sample_id: string;
  quantity: string;
  uom: string;
  location_id: string;
  logged_at: string;
  /** Derived under lock; persisted write-back only. */
  expires_on?: string;
  retention_years?: number;
  logged_by?: string;
  lot_number?: string;
  sku?: string;
  site_id?: string;
}

export interface QcRetentionSampleLoggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.retention_sample_logged';
  payload: QcRetentionSampleLoggedPayload;
}

/**
 * Story 8.4 (FR-Q-08, AC 5): the recorded disposal event the 30-day expiry alert raises. Emitted
 * ONLY by the retention-expiry sweep under the fixed SYSTEM_ACTOR identity (no human disposed_by,
 * mirroring notification.expired) - there is no write route for it. It flips the sample from
 * 'retained' to 'disposal_pending' and nothing else: physical disposal is Phase 2 / Epic 16, so
 * qc_retention_sample.disposed_at stays null. The applier emits the AC5 alert notification in the
 * same transaction. The UPDATE is guarded by `WHERE status = 'retained'` so it can never
 * double-transition a row; a zero-row result is refused with 409 RETENTION_SAMPLE_NOT_RETAINED,
 * which only a forged direct post can reach - the sweep's candidate query carries the same
 * predicate.
 *
 * Server-derived, rejected if declared: task_id, lot_id, expires_on, status.
 */
export interface QcRetentionSampleDisposedPayload {
  retention_sample_id: string;
  lot_id: string;
  disposed_at: string;
  /** Derived under lock; persisted write-back only. */
  task_id?: string;
  expires_on?: string;
  status?: 'disposal_pending';
}

export interface QcRetentionSampleDisposedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.retention_sample_disposed';
  payload: QcRetentionSampleDisposedPayload;
}

/**
 * Story 8.5 (FR-Q-09, AC 1): places the governed quality hold. stream_id is the hold_id. The
 * applier locks the lot row FOR UPDATE, inserts the qc_quality_hold row, sets
 * lot_master.quality_hold_status = 'held' in the SAME transaction (Binding Scope Decision 1 - the
 * flag every enforcement site already reads), appends the lot_trace entry and emits the AD-17
 * transactional notification. Placement is deliberately single-actor and never approval-gated
 * (Decision 5): delaying containment is actively harmful. A second open hold for the lot rejects
 * 409 HOLD_EXISTS (uq_qc_quality_hold_open backstops the race). defect_code, when given, must be
 * in the fail-closed QC_DEFECT_CODES catalogue (422 DEFECT_CODE_UNKNOWN with the allowed list).
 *
 * Server-derived, rejected if declared: placed_at, site_id, sku, lot_number, status, placed_by.
 */
export interface QcHoldPlacedPayload {
  hold_id: string;
  lot_id: string;
  hold_reason: string;
  defect_code?: string | null;
  /** Derived under lock; persisted write-back only. */
  placed_at?: string;
  site_id?: string;
  sku?: string;
  lot_number?: string;
  status?: 'open';
  placed_by?: string;
}

export interface QcHoldPlacedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.hold_placed';
  payload: QcHoldPlacedPayload;
}

/**
 * Story 8.5 (FR-Q-09, Binding Scope Decision 4): releases a governed hold. stream_id is the
 * hold_id. Release is a distinct, reason-carrying, SEGREGATED decision: the releasing actor must
 * not be the actor who placed the hold (409 SOD_VIOLATION, no config escape hatch - confirmed
 * 2026-08-31). The applier's guarded UPDATE (`WHERE status = 'open'`) makes a concurrent second
 * release a zero-row update resolved to 409 HOLD_ALREADY_RELEASED, and clears
 * lot_master.quality_hold_status back to 'none' ONLY when no other open hold exists for the lot.
 *
 * Server-derived, rejected if declared: released_at, site_id, sku, lot_number, status, lot_id,
 * released_by.
 */
export interface QcHoldReleasedPayload {
  hold_id: string;
  release_reason: string;
  /** Derived under lock; persisted write-back only. */
  released_at?: string;
  site_id?: string;
  sku?: string;
  lot_number?: string;
  status?: 'released';
  lot_id?: string;
  released_by?: string;
}

export interface QcHoldReleasedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.hold_released';
  payload: QcHoldReleasedPayload;
}

/**
 * Story 8.5 (FR-Q-10, AC 3): raises a HOLD-SOURCED NCR, independent of any disposition (Binding
 * Scope Decision 9 - the Story 8.3 disposition-sourced creation path is untouched). stream_id is
 * the ncr_id. Requires a held or defective lot: an open qc_quality_hold OR
 * lot_master.quality_hold_status = 'held', re-derived under the lot lock. defect_code is
 * mandatory and validated against the catalogue; capa_id, when supplied, must resolve to an OPEN
 * CAPA. The applier computes capa_mandatory (Decision 12/13: the enterprise-wide 90-day IST
 * repeat-defect window, enforced at CLOSE, not at raise) and stamps it on the row.
 *
 * Server-derived, rejected if declared: raised_at, site_id, sku, lot_number, hold_id,
 * capa_mandatory, raised_by.
 */
export interface QcNcrRaisedPayload {
  ncr_id: string;
  lot_id: string;
  defect_code: string;
  justification: string;
  quantity: string;
  capa_id?: string | null;
  /** Derived under lock; persisted write-back only. */
  raised_at?: string;
  site_id?: string;
  sku?: string;
  lot_number?: string;
  hold_id?: string | null;
  capa_mandatory?: boolean;
  raised_by?: string;
}

export interface QcNcrRaisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.ncr_raised';
  payload: QcNcrRaisedPayload;
}

/**
 * Story 8.5 (FR-Q-10, Binding Scope Decision 11): opens a first-class CAPA record. stream_id is
 * the capa_id. capa_number is minted SERVER-side from qc_capa_number_seq (409 CAPA_EXISTS on the
 * uq_qc_capa_number backstop); sku and defect_code name the enterprise-wide grain the repeat rule
 * counts on; due_on is an IST business date.
 *
 * Server-derived, rejected if declared: capa_number, opened_by, opened_at, status.
 */
export interface QcCapaOpenedPayload {
  capa_id: string;
  sku: string;
  defect_code: string;
  title: string;
  root_cause?: string | null;
  corrective_action?: string | null;
  preventive_action?: string | null;
  owner_user_id: string;
  due_on: string;
  /** Derived under lock; persisted write-back only. */
  capa_number?: string;
  opened_by?: string;
  opened_at?: string;
  status?: 'open';
}

export interface QcCapaOpenedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.capa_opened';
  payload: QcCapaOpenedPayload;
}

/**
 * Story 8.5 (FR-Q-10): closes a CAPA with closure evidence. stream_id is the capa_id. The guarded
 * UPDATE (`WHERE status = 'open'`) makes a second close a zero-row update resolved to 409
 * CAPA_NOT_OPEN. Closure is a decision, so the applier emits the AD-17 transactional notification.
 *
 * Server-derived, rejected if declared: closed_by, closed_at, status.
 */
export interface QcCapaClosedPayload {
  capa_id: string;
  closure_evidence: string;
  /** Derived under lock; persisted write-back only. */
  closed_by?: string;
  closed_at?: string;
  status?: 'closed';
}

export interface QcCapaClosedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.capa_closed';
  payload: QcCapaClosedPayload;
}

/**
 * Story 8.5 (FR-Q-10, AC 4): links an existing OPEN CAPA to an open NCR. stream_id is the ncr_id.
 * The guarded UPDATE (`WHERE capa_id IS NULL`) makes a second link a zero-row update resolved to
 * 409 CAPA_ALREADY_LINKED. Linking is what satisfies the mandatory-CAPA close gate
 * (409 APPROVAL_REQUIRED until it happens - Binding Scope Decision 13).
 *
 * Server-derived, rejected if declared: linked_by, linked_at, sku, defect_code.
 */
export interface QcCapaLinkedPayload {
  ncr_id: string;
  capa_id: string;
  /** Derived under lock; persisted write-back only. */
  linked_by?: string;
  linked_at?: string;
  sku?: string;
  defect_code?: string;
}

export interface QcCapaLinkedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.capa_linked';
  payload: QcCapaLinkedPayload;
}

/**
 * Story 8.2 (FR-Q-03, AC 1): freezes the IS 2500 (Part 1) / ISO 2859-1 single-sampling plan on a
 * task. stream_id is the task_id. Only task_id, sampling_id and determined_at are client fields;
 * every other field is SEAM-DERIVED under the lot, task and switching-state locks (lot size from
 * the task quantity, AQL and level from the frozen plan version, severity from the (plan, site)
 * switching state, code letter / sample size / Ac / Re from the tables) and written back. A
 * declared derived value rejects 409 QC_DERIVATION_MISMATCH; a task that is not `open` rejects 409
 * QC_TASK_NOT_OPEN; a second plan for the task rejects 409 QC_SAMPLING_EXISTS; discontinued
 * inspection rejects 409 SAMPLING_INSPECTION_DISCONTINUED.
 */
export interface QcSamplingDeterminedPayload {
  task_id: string;
  sampling_id: string;
  determined_at: string;
  /** Derived under lock; persisted write-back only. */
  lot_id?: string;
  lot_number?: string;
  plan_version_id?: string;
  plan_id?: string;
  site_id?: string;
  lot_size?: number;
  aql?: string | null;
  inspection_level?: string | null;
  severity?: 'normal' | 'tightened' | 'reduced';
  code_letter?: string | null;
  resolved_code_letter?: string | null;
  sample_size?: number;
  acceptance_number?: number | null;
  rejection_number?: number | null;
  sampling_basis?: 'aql_table' | 'full_inspection';
  standard_ref?: string;
  critical_characteristic_ids?: string[];
  determined_by?: string;
  previous_task_status?: 'open';
  task_status?: 'sampling_determined';
}

export interface QcSamplingDeterminedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.sampling_determined';
  payload: QcSamplingDeterminedPayload;
}

export interface QcResultReadingInput {
  result_id: string;
  sample_unit_no: number;
  measured_value?: string;
  measured_uom?: string;
  attribute_conforms?: boolean;
}

/**
 * Story 8.2 (FR-Q-04, AC 4 and AC 5): an instrument-bound result batch for ONE characteristic and
 * ONE instrument, up to 500 unit readings (Binding Scope Decision 4). stream_id is the task_id.
 * Clients send instrument_asset_id (the register asset); the handler resolves instrument_id (the
 * calibration-gate key) before persistEvent so the Story 1.7 assertCalibrationLockout fires
 * pre-transaction (423 CALIBRATION_LOCKOUT), and the seam re-derives the pairing under lock (409
 * QC_DERIVATION_MISMATCH on a mismatch, 423 on a non-calibrated status). characteristic_class,
 * result_kind and conforms_by_result_id are SEAM-DERIVED write-backs; recorded_by is never declared.
 *
 * The Story 1.7 SYNTHETIC shape (instrument_id, lot_id, parameter, value, no task_id) stays valid
 * on this same event type and is not projected (Binding Scope Decision 1).
 */
export interface QcResultRecordedPayload {
  task_id: string;
  lot_id: string;
  characteristic_id: string;
  instrument_asset_id: string;
  instrument_id: string;
  readings: QcResultReadingInput[];
  recorded_at: string;
  /** Derived under lock; persisted write-back only. */
  characteristic_class?: 'critical' | 'major' | 'minor';
  result_kind?: 'numeric' | 'attribute';
  conforms_by_result_id?: Record<string, boolean>;
}

export interface QcResultRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.result_recorded';
  payload: QcResultRecordedPayload;
}

/**
 * Story 8.2 (Binding Scope Decision 2): an instrument-less attribute observation batch for ONE
 * characteristic whose frozen plan line has result_kind attribute and no instrument_type. Any other
 * characteristic rejects 400 INSTRUMENT_REQUIRED. Same reading shape as the result, with
 * attribute_conforms required per reading and no instrument fields.
 */
export interface QcObservationRecordedPayload {
  task_id: string;
  lot_id: string;
  characteristic_id: string;
  readings: Array<
    Omit<QcResultReadingInput, 'measured_value' | 'measured_uom'> & {
      attribute_conforms: boolean;
    }
  >;
  recorded_at: string;
  /** Derived under lock; persisted write-back only. */
  characteristic_class?: 'critical' | 'major' | 'minor';
  result_kind?: 'attribute';
  conforms_by_result_id?: Record<string, boolean>;
}

export interface QcObservationRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.observation_recorded';
  payload: QcObservationRecordedPayload;
}

/**
 * Story 8.2 (FR-Q-03, AC 2 and AC 3): completes inspection of a task. stream_id is the task_id.
 * The seam verifies completeness (every critical characteristic on every lot unit, every other
 * characteristic on every AQL sample unit; 409 QC_INSPECTION_INCOMPLETE listing each gap), derives
 * the sampling outcome and counts, advances the (plan, site) switching state under lock and moves
 * the task to `inspected`. Every field after completed_at is SEAM-DERIVED. The QC gate is untouched
 * (Story 8.3 dispositions the lot).
 */
export interface QcInspectionCompletedPayload {
  task_id: string;
  completed_at: string;
  /** Derived under lock; persisted write-back only. */
  sampling_id?: string;
  sampling_outcome?: 'accepted' | 'not_accepted';
  nonconforming_sample_units?: number;
  critical_nonconformities?: number;
  severity_used?: 'normal' | 'tightened' | 'reduced';
  previous_severity?: 'normal' | 'tightened' | 'reduced';
  new_severity?: 'normal' | 'tightened' | 'reduced';
  switching_score?: number;
  reduced_eligible?: boolean;
  inspection_discontinued?: boolean;
  previous_task_status?: 'sampling_determined';
  task_status?: 'inspected';
}

export interface QcInspectionCompletedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.inspection_completed';
  payload: QcInspectionCompletedPayload;
}

/**
 * Story 8.2 (Annex requirement 11): the QC Head-level switching-state commands. stream_id is the
 * plan_id. authorize_reduced requires normal inspection with reduced_eligible (409
 * REDUCED_INSPECTION_NOT_ELIGIBLE); resume_inspection requires a discontinued state (409
 * SAMPLING_INSPECTION_NOT_DISCONTINUED) and resumes on tightened. The actor's role must be in
 * config.quality.qcHeadRoles (403 APPROVAL_REQUIRED, audited). previous_severity, new_severity,
 * authorized_by and authorizing_role are SEAM-DERIVED.
 */
export interface QcSamplingStateAdjustedPayload {
  plan_id: string;
  site_id: string;
  action: 'authorize_reduced' | 'resume_inspection';
  reason: string;
  adjusted_at: string;
  /** Derived under lock; persisted write-back only. */
  previous_severity?: 'normal' | 'tightened' | 'reduced';
  new_severity?: 'normal' | 'tightened' | 'reduced';
  authorized_by?: string;
  authorizing_role?: string;
}

export interface QcSamplingStateAdjustedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.sampling_state_adjusted';
  payload: QcSamplingStateAdjustedPayload;
}

// ---------------------------------------------------------------------------
// Story 8.7: compliance master data (FR-Q-11 BIS licence register, FR-Q-14 Legal Metrology label
// masters). Five events on the 'compliance' stream.
//
// BSD-1 convention: a field marked SERVER-DERIVED is computed by the applier and must NOT appear on
// an inbound payload - src/compliance/master-data.ts rejects a declared one with
// COMPLIANCE_DERIVATION_MISMATCH. Fields marked SERVER-CAPTURED are resolved by the ROUTE before
// persistEvent and DO travel on the payload, so a projection rebuild is deterministic after the
// source registry has drifted; the applier re-derives and compares them on first apply.
// ---------------------------------------------------------------------------

export interface ComplianceBisLicenceRecordedPayload {
  licence_id: string;
  licence_number: string;
  licence_type: 'cml' | 'r_number';
  sku: string;
  /** NULL means the licence covers ALL sites (BSD-6). */
  site_id: string | null;
  valid_from: string;
  valid_to: string;
  /** SERVER-DERIVED from the window at write time; never declared. */
  status?: never;
}

export interface ComplianceBisLicenceRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'compliance.bis_licence_recorded';
  payload: ComplianceBisLicenceRecordedPayload;
}

export interface ComplianceBisLicenceUpdatedPayload {
  licence_id: string;
  /** In-place renewal: at least one of the two is required, both are optional (BSD-3). */
  valid_from?: string;
  valid_to?: string;
  /** SERVER-DERIVED or immutable register identity; never declared on an update. */
  status?: never;
  licence_number?: never;
  licence_type?: never;
  sku?: never;
  site_id?: never;
}

export interface ComplianceBisLicenceUpdatedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'compliance.bis_licence_updated';
  payload: ComplianceBisLicenceUpdatedPayload;
}

export interface ComplianceBisLicenceExpiryFlaggedPayload {
  licence_id: string;
  /** 90/60/30 are alert stages; 0 records the expiry flip. Re-derived from valid_to on apply. */
  stage_days: 90 | 60 | 30 | 0;
  /** SERVER-DERIVED; the applier reads the register, never the payload. */
  status?: never;
  valid_to?: never;
  flagged_at?: never;
}

export interface ComplianceBisLicenceExpiryFlaggedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'compliance.bis_licence_expiry_flagged';
  payload: ComplianceBisLicenceExpiryFlaggedPayload;
}

export interface ComplianceLabelVersionDraftedPayload {
  label_id: string;
  sku: string;
  label_version: string;
  /** SERVER-DERIVED: a draft carries no approval metadata, and created_by comes from the actor. */
  status?: never;
  approved_by?: never;
  approved_at?: never;
}

export interface ComplianceLabelVersionDraftedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'compliance.label_version_drafted';
  payload: ComplianceLabelVersionDraftedPayload;
}

export interface ComplianceLabelVersionApprovedPayload {
  label_id: string;
  /** SERVER-CAPTURED (BSD-4): resolved by the route, re-derived and compared by the applier. */
  approved_by: string;
  doa_entry_id: string;
  governing_role: string;
  delegation_applied: boolean;
  /** SERVER-DERIVED: stamped from the envelope, or read from the existing row. */
  approved_at?: never;
  status?: never;
  sku?: never;
  label_version?: never;
}

export interface ComplianceLabelVersionApprovedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'compliance.label_version_approved';
  payload: ComplianceLabelVersionApprovedPayload;
}

// ---------------------------------------------------------------------------
// Story 8.8: witnessed and third-party inspection hold points (FR-Q-15)
// ---------------------------------------------------------------------------

export interface QcWitnessHoldPointRaisedPayload {
  hold_point_id: string;
  lot_number: string;
  sku: string;
  inspection_type: 'customer_witnessed' | 'third_party';
  hold_reason: string;
  /** SERVER-DERIVED: the lot identity, the governed hold row and every timestamp are resolved by
   * the applier under the transaction; the status is always 'open' on a raise. */
  lot_id?: never;
  site_id?: never;
  qc_hold_id?: never;
  status?: never;
  raised_by?: never;
  raised_at?: never;
}

export interface QcWitnessHoldPointRaisedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.witness_hold_point_raised';
  payload: QcWitnessHoldPointRaisedPayload;
}

export interface QcWitnessNoticeRecordedPayload {
  notice_id: string;
  hold_point_id: string;
  recipient: string;
  /** IST calendar date the notice was served, YYYY-MM-DD. */
  notice_date: string;
  method: 'email' | 'letter' | 'portal' | 'in_person';
  /** SERVER-DERIVED: the recorder and the recording timestamp come from the envelope. */
  recorded_by?: never;
  recorded_at?: never;
}

export interface QcWitnessNoticeRecordedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.witness_notice_recorded';
  payload: QcWitnessNoticeRecordedPayload;
}

export interface QcWitnessedInspectionSignedOffPayload {
  hold_point_id: string;
  /** Free-text record of who witnessed and what was observed. */
  sign_off_note?: string;
  /** SERVER-DERIVED: closure identity and the resulting status are stamped by the applier. */
  status?: never;
  closed_by?: never;
  closed_at?: never;
  close_event_id?: never;
}

export interface QcWitnessedInspectionSignedOffEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.witnessed_inspection_signed_off';
  payload: QcWitnessedInspectionSignedOffPayload;
}

export interface QcWitnessedInspectionWaivedPayload {
  hold_point_id: string;
  waiver_reason: string;
  /** SERVER-CAPTURED (BSD-7): resolved by the route from the DOA registry, then re-derived and
   * compared by the applier under the transaction. */
  approved_by: string;
  doa_entry_id: string;
  governing_role: string;
  delegation_applied: boolean;
  /** SERVER-DERIVED: closure identity and the resulting status are stamped by the applier. */
  status?: never;
  closed_by?: never;
  closed_at?: never;
  close_event_id?: never;
}

export interface QcWitnessedInspectionWaivedEnvelope extends Omit<EventEnvelope, 'payload'> {
  event_type: 'qc.witnessed_inspection_waived';
  payload: QcWitnessedInspectionWaivedPayload;
}

// ---------------------------------------------------------------------------
// Supported event types registry
// ---------------------------------------------------------------------------
export const SUPPORTED_EVENT_TYPES = {
  // Story 2.5: transfer request events
  'transfer_request.created': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'transfer_request.approval_decided': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'transfer_ship.created': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'transfer_receive.created': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  // Story 2.6: cycle count and physical verification events
  'cycle_count.task_created': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'cycle_count.submitted': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'cycle_count.adjustment_approved': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'cycle_count.adjustment_rejected': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'stock.adjusted': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'physical_verification.completed': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'physical_verification.signed_off': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  // Story 2.7: inventory planning, replenishment, and obsolescence events
  'inventory_planning.params_set': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'inventory_planning.safety_stock_computed': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'replenishment.recommended': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'obsolescence.flagged': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  'obsolescence.cleared': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  // Story 2.8: ownership agreement (consignment/VMI segregation) events
  'ownership.agreement_set': {
    streamType: 'inventory',
    requiresBusinessStream: true,
  },
  // Story 3.2: gate event capture events
  'gate.entered': {
    streamType: 'gate',
    requiresBusinessStream: false,
  },
  'gate.reversed': {
    streamType: 'gate',
    requiresBusinessStream: false,
  },
  // Story 3.3: weighbridge event capture (no valuated inventory movement, so business-stream
  // tagging is not gated on it)
  'weighbridge.recorded': {
    streamType: 'weighbridge',
    requiresBusinessStream: false,
  },
  // Story 3.4: goods receiving on a new 'receiving' stream. The receiving envelope posts no valuated
  // movement of its own - the stock receipt it drives (via the synthetic stock.received view) carries
  // the item business stream - so business-stream tagging is not gated on these events.
  'goods.received': {
    streamType: 'receiving',
    requiresBusinessStream: false,
  },
  'goods.putaway_released': {
    streamType: 'receiving',
    requiresBusinessStream: false,
  },
  // Story 3.5: putaway completion and location override on a new 'putaway' stream. The putaway
  // envelope posts no valuated movement of its own - location override is an auditable correction
  // event, not a stock transaction - so business-stream tagging is not gated on these events.
  'putaway.completed': {
    streamType: 'putaway',
    requiresBusinessStream: false,
  },
  'location.override': {
    streamType: 'putaway',
    requiresBusinessStream: false,
  },
  // Story 3.6: pick task generation and execution on a new 'warehouse' stream. Pick events post no
  // valuated movement of their own - stock allocation changes are driven by the projection apply
  // functions, not by business-stream-tagged events - so tagging is not gated on these events
  // (mirrors the Story 3.5 'putaway' stream rationale).
  'pick_task.created': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'pick_line.confirmed': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'pick_task.completed': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  // Story 3.7: packing, shipping documents, and dispatch on the existing 'warehouse' stream.
  // Dispatch events post no valuated movement of their own - dispatch stock decrement is driven
  // by the projection apply function, not by business-stream-tagged events - so tagging is not
  // gated on these events (mirrors the Story 3.5/3.6 'warehouse' stream rationale).
  'dispatch.packed': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'dispatch.shipping_documents_generated': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'dispatch.dispatched': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  // Story 3.8: configurable task SLA thresholds on the existing 'warehouse' stream. An SLA-threshold
  // change posts no valuated stock or financial movement - it is supervisor configuration governing
  // how the task board highlights age - so business-stream tagging is not gated on it (the same
  // rationale already used for pick_task.* and dispatch.*).
  'task_sla_config.updated': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  // Story 3.8 code review: task assignment is a privileged supervisor action that must replay and
  // audit like every other warehouse write. Assigning work posts no valuated stock movement, so
  // business-stream tagging is not gated on it, matching task_sla_config.updated above.
  'putaway_task.assigned': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'pick_task.assigned': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  // Story 3.9: forward-pick replenishment on the existing 'warehouse' stream. Config threshold
  // changes and replenishment task creation/completion post no valuated stock movement of their
  // own (the completion moves already-owned stock between two locations at the same cost basis via
  // applyStockIssue/applyStockReceipt, called directly - never through the 'inventory'-stream-gated
  // applyStockBalanceProjection) - so business-stream tagging is not gated on any of them, matching
  // the rationale already used for pick_task.*/putaway_task.assigned/task_sla_config.updated.
  'forward_pick_config.updated': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'replenishment_task.created': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'replenishment_task.assigned': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'replenishment_task.completed': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'cross_dock_task.assigned': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  'cross_dock_task.completed': {
    streamType: 'warehouse',
    requiresBusinessStream: false,
  },
  // Story 4.1: supplier lifecycle events on a new 'procurement' stream. Supplier records are
  // master data, not inventory movements, so business-stream tagging is not gated on them.
  'supplier.registered': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier.onboarding_submitted': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier.onboarding_approved': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier.onboarding_rejected': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier.updated': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier.deactivated': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  // Story 4.3: purchase requisition (indent) lifecycle on the 'procurement' stream. Only
  // indent.raised carries requiresBusinessStream: true - the raise is the tagged business
  // transaction (FR-AC-01), which makes AC 1's UNTAGGED_TRANSACTION rejection work through the
  // existing spine with no new validation code. Every other indent event is a lifecycle
  // transition on an already-tagged document.
  'indent.raised': {
    streamType: 'procurement',
    requiresBusinessStream: true,
  },
  'indent.duplicate_flagged': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'indent.confirmed': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'indent.withdrawn': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'indent.approved': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'indent.rejected': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'indent.ordered': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'indent.cancelled': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'indent.closed': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  // Story 4.4: purchase order lifecycle on the 'procurement' stream. Only
  // purchase_order.drafted carries requiresBusinessStream: true - the draft is the tagged
  // business transaction (FR-AC-01), which makes AC 1's UNTAGGED_TRANSACTION rejection work
  // through the existing spine with no new validation code. Every other purchase_order event
  // is a lifecycle transition on an already-tagged document.
  'purchase_order.drafted': {
    streamType: 'procurement',
    requiresBusinessStream: true,
  },
  'purchase_order.approved': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'purchase_order.rejected': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'purchase_order.issued': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'purchase_order.confirmed': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'purchase_order.release_recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'purchase_order.ceiling_revised': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  // Story 4.7: supplier invoice capture on the existing 'procurement' stream. Staging, review,
  // and unmatched recording fabricate no business-stream tag (no PO context exists yet); only
  // supplier_invoice.captured and supplier_invoice.po_linked carry requiresBusinessStream: true -
  // both are the moments a PO's tag is inherited onto the invoice (mirrors the
  // purchase_order.drafted / indent.raised precedent).
  'invoice_ingestion.staged': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'invoice_ingestion.reviewed': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier_invoice.captured': {
    streamType: 'procurement',
    requiresBusinessStream: true,
  },
  'supplier_invoice.unmatched_recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier_invoice.po_linked': {
    streamType: 'procurement',
    requiresBusinessStream: true,
  },
  // Story 4.6: MSME compliance on the existing 'procurement' stream. Supplier-level registration
  // lifecycle, breach flagging, and the ageing feed ledger carry no business-stream tag - MSME
  // status is a supplier-wide statutory attribute, not a stream-scoped commercial fact.
  'supplier.msme_verified': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier.msme_suspended': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier_invoice.statutory_breach_flagged': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'msme_ageing_feed.recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  // Story 4.5: three-way match on the existing 'procurement' stream. None of these carry a
  // business-stream tag on the envelope - site_id and business_stream are stamped into the
  // projections from the already-governed PO and invoice rows (the Story 4.6 pattern), so the
  // match record cannot disagree with the documents it compares.
  'grn.po_linked': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'three_way_match.recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier_invoice.credit_note_recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'supplier_invoice.debit_note_recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  'payment_clearance_feed.recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  // Story 4.2: supplier scorecard metric on the existing 'procurement' stream. The scorecard is
  // an analytic read-side artifact; its business stream is stamped onto the projection from the
  // source PO/GRN documents (the Story 4.6 msme.* precedent).
  'supplier_scorecard.metric_recorded': {
    streamType: 'procurement',
    requiresBusinessStream: false,
  },
  // Story 5.1: BOM lifecycle on a new 'engineering' stream. Only bom.drafted carries
  // requiresBusinessStream: true - the draft is the tagged business transaction (FR-AC-01),
  // mirroring purchase_order.drafted and indent.raised. bom_line.added and bom_line.amended
  // are lifecycle transitions on an already-tagged document and do not require a business_stream.
  'bom.drafted': {
    streamType: 'engineering',
    requiresBusinessStream: true,
  },
  'bom_line.added': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom_line.amended': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  // Story 5.2: lifecycle transitions act on an already-tagged document (bom_line.* precedent);
  // bom.migrated_from_kit creates a header and follows the bom.drafted precedent.
  'bom.released': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom.held': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom.obsoleted': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom.migrated_from_kit': {
    streamType: 'engineering',
    requiresBusinessStream: true,
  },
  // Story 5.3: ECO lifecycle on the existing 'engineering' stream. eco.raised creates the header
  // and follows the bom.drafted precedent (requiresBusinessStream: true); the other five are
  // transitions acting on an already-tagged document, following the bom_line.* / Story 5.2
  // lifecycle precedent (requiresBusinessStream: false). eco.review_started is a deliberate sixth
  // event beyond the five named in the epics dev note: AC 1 requires Under Review to be a
  // reachable state and every state change in this codebase is an event.
  'eco.raised': {
    streamType: 'engineering',
    requiresBusinessStream: true,
  },
  'eco.review_started': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'eco.approved': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'eco.implemented': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'eco.cancelled': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'eco.stock_disposition_recorded': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  // Story 5.4: R&D draft BOM regime on the existing 'engineering' stream. rd_draft.cloned,
  // rd_draft.productized, and rd_build.recorded each create a new tagged document header and
  // follow the bom.drafted / eco.raised precedent (requiresBusinessStream: true); the other two
  // are transitions on an already-tagged document (requiresBusinessStream: false).
  'rd_draft.cloned': {
    streamType: 'engineering',
    requiresBusinessStream: true,
  },
  'rd_build.recorded': {
    streamType: 'engineering',
    requiresBusinessStream: true,
  },
  'rd_build.confirmed': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'rd_draft.productization_signed': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'rd_draft.productized': {
    streamType: 'engineering',
    requiresBusinessStream: true,
  },
  // Story 5.5: approved alternates and BOM explosion on the existing 'engineering' stream. All
  // three are transitions/records on an already business-stream-tagged BOM aggregate, so none
  // requires a business stream on the envelope.
  'bom.alternate_defined': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom.substitution_approved': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom.exploded': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  // Story 5.6: cost rollup snapshots, job-work kit supply-source tagging, and the inbound-BOM
  // rejection audit fact. All three act on an already business-stream-tagged BOM aggregate, so
  // none requires a business stream on the envelope.
  'bom.cost_rollup_snapshotted': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom.job_work_kit_tagged': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  'bom.sync_conflict_raised': {
    streamType: 'engineering',
    requiresBusinessStream: false,
  },
  // Story 7.1: asset register on a NEW 'maintenance' stream (AD-9). An asset is master data, not
  // an inventory movement, so requiresBusinessStream is false (the supplier.registered precedent).
  'asset.registered': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 7.2: PM plans, work orders and the usage-meter register on the same 'maintenance'
  // stream. All maintenance master data and operational state, never a tagged inventory movement,
  // so requiresBusinessStream stays false (the asset.registered precedent).
  'maintenance.meter_registered': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.meter_reading_recorded': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.meter_silent_flagged': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.plan_defined': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.work_order_generated': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.work_order_overdue': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.work_order_completed': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 7.3: fault reporting, SLA policy, breakdown work orders, downtime capture and the
  // monthly reliability snapshot on the same 'maintenance' stream. All operational state, never a
  // tagged inventory movement, so requiresBusinessStream stays false (the asset.registered and
  // Story 7.2 precedent).
  'maintenance.sla_policy_defined': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.fault_reported': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.fault_rejected': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.breakdown_work_order_created': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.downtime_closed': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.reliability_report_generated': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 7.4: spare cataloguing, the maintenance-owned asset parts list, the reserve/issue/return
  // lifecycle and the min-max / overdue-return alerts, all on the same 'maintenance' stream. These
  // MOVE stock through the Epic 2 ledger helpers but are not themselves tagged inventory
  // movements - the movement is applied by the seam inside persistEvent, and the business stream
  // belongs to the stock.* events of Epic 2 - so requiresBusinessStream stays false, matching the
  // rest of the maintenance block.
  'maintenance.spare_catalogued': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.asset_part_listed': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.spare_reserved': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.spare_issued': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.spare_returned': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.spare_reservation_cancelled': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.critical_spare_breach_flagged': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.spare_return_overdue_flagged': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 7.5: the calibration register that FEEDS the existing Story 1.7 lockout gate. All six
  // ride the same 'maintenance' stream as the rest of Epic 7. They move no stock and carry no
  // business stream, so requiresBusinessStream stays false. The QC-side gate they feed
  // (qc.result_recorded) is unchanged and stays on the 'qc' stream.
  'maintenance.instrument_registered': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.calibration_certificate_recorded': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.calibration_expiry_flagged': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.calibration_expired': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.calibration_escalation_raised': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.calibration_escalation_resolved': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 7.6: statutory examinations (FR-M-14), machine status broadcast (FR-M-16), and the cost
  // extension rides on the existing maintenance.work_order_completed entry above. All three ride
  // the same 'maintenance' stream; they move no stock and carry no business stream, so
  // requiresBusinessStream stays false. The weighbridge lockout they feed (weighbridge.recorded on
  // the 'weighbridge' stream) is unchanged.
  'maintenance.statutory_examination_recorded': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.statutory_examination_overdue': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.asset_status_changed': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 7.7: AMC, warranty, and insurance coverage (FR-M-10), its staged 90/60/30 expiry alerts,
  // and the reason-coded warranty override (FR-M-11). All three ride the same 'maintenance' stream;
  // maintenance operational state moves no stock and carries no business stream, so
  // requiresBusinessStream stays false (the asset.registered precedent). The chargeable-work gate
  // they feed rides on the existing maintenance.work_order_completed entry above, unchanged.
  'maintenance.coverage_recorded': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.coverage_expiry_flagged': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.warranty_override_recorded': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 7.8: the technician status transition, and the sync-conflict queue's raise and
  // resolve (FR-M-17). All three ride the same 'maintenance' stream; none moves stock or carries a
  // business stream, so requiresBusinessStream stays false (the 7.7 coverage precedent). The
  // closure codes of FR-M-18 ride the existing maintenance.work_order_completed entry, unchanged.
  'maintenance.work_order_status_updated': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.sync_conflict_raised': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  'maintenance.sync_conflict_resolved': {
    streamType: 'maintenance',
    requiresBusinessStream: false,
  },
  // Story 6.1: the production stream (FR-MO-01/02/03). production_order.created is the ONLY tagged
  // event - requiresBusinessStream true is what makes AC1's UNTAGGED_TRANSACTION fire inside
  // persistEvent with no handler-side code. The lifecycle transitions are untagged: the order row
  // already holds the tag, and re-tagging every transition would make the tag a mutable field
  // (AD-14). The stream is NOT added to INVENTORY_MOVEMENT_STREAM_TYPES: widening that set would
  // force a business_stream onto every lifecycle transition and break the AC2 transition events.
  'production_order.created': {
    streamType: 'production',
    requiresBusinessStream: true,
  },
  'production_order.released': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  'production_order.state_changed': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  'production_order.cancelled': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  // Story 6.2: production material events (FR-MO-04/05/06). All four ride the same 'production'
  // stream and all are requiresBusinessStream false: the order row already holds the tag (created
  // with it in 6.1), and re-tagging material movements would make the tag mutable (AD-14). The
  // stream stays out of INVENTORY_MOVEMENT_STREAM_TYPES exactly as in 6.1.
  'production_order.material_staged': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  'production_order.material_issued': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  'production_order.confirmation_recorded': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  'production_order.material_returned': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  // Story 6.3: production completions, scrap declarations and the close-short decision
  // (FR-MO-07/08/09). Same stream and the same requiresBusinessStream false rule as the 6.2 block
  // above: the order row holds the tag and AD-14 forbids re-tagging a downstream event. The rework
  // order of FR-MO-10 rides the EXISTING production_order.created entry (Binding Decision 9), so no
  // fourth registry entry is added here.
  'production_order.completion_posted': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  'production_order.scrap_declared': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  'production_order.short_close_recorded': {
    streamType: 'production',
    requiresBusinessStream: false,
  },
  // Story 8.1: the inspection-plan family and the QC gate (FR-Q-01, FR-Q-02, FR-Q-05). All four
  // ride the 'qc' stream (the stream the Story 1.7 qc.result_recorded already used before Story
  // 8.2 registered it below; its calibration lockout narrows on that exact event type and is
  // untouched). Plan events
  // carry no business stream: a plan is master data bound to an item and a specification revision.
  // The completion hand-off DOES carry the item's business_stream, server-verified against
  // item_master in the seam, so a finished lot's QC task is traceable to its stream (Task 2).
  // Conditional release is a decision on an already-tagged task and is not re-tagged (AD-14).
  'qc.inspection_plan_created': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.inspection_plan_approved': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.completion_received': {
    streamType: 'qc',
    requiresBusinessStream: true,
  },
  'qc.conditional_release_recorded': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  // Story 8.2: AQL sampling and result capture (FR-Q-03, FR-Q-04). All five ride the 'qc' stream
  // and none carries a business stream: sampling, results, completion and the switching-state
  // commands are decisions on an already-tagged task or on plan master data (AD-14).
  // qc.result_recorded is registered HERE for the first time with the full (task-bound) shape; the
  // Story 1.7 synthetic shape stays valid on the same type and the Story 1.7 assertCalibrationLockout
  // keeps narrowing on it (Binding Scope Decision 1). qc.lot_dispositioned is registered by Story
  // 8.3 in the block below.
  'qc.sampling_determined': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.result_recorded': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.observation_recorded': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.inspection_completed': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.sampling_state_adjusted': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  // Story 8.3: lot disposition, partial split and NCR outcomes (FR-Q-05, FR-Q-06). All four ride
  // the 'qc' stream and none carries a business stream: every one is a decision on an already
  // tagged task whose business stream was fixed by the completion hand-off (AD-14). This is the
  // registration Story 4.2 reserved qc.lot_dispositioned for - the supplier-scorecard
  // quality-acceptance metric now has a real source event.
  'qc.lot_dispositioned': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.lot_split_recorded': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.ncr_outcome_recorded': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.rework_requested': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  // Story 8.4: the batch release record, the retention sample and its recorded disposal (FR-Q-07,
  // FR-Q-08). Same reasoning as the Story 8.3 family - all three ride the 'qc' stream and none
  // carries a business stream, because each acts on a task whose business stream was already fixed
  // by the completion hand-off (AD-14).
  'qc.batch_release_recorded': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.retention_sample_logged': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.retention_sample_disposed': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  // Story 8.5: the governed hold record, its segregated release, the hold-sourced NCR and the CAPA
  // family (FR-Q-09, FR-Q-10). Same reasoning as the Story 8.3/8.4 families - all six ride the
  // 'qc' stream and none carries a business stream: a hold or CAPA is a decision about a lot or a
  // (sku, defect) grain, not an inventory movement, and the lot_trace entries the hold applier
  // writes derive their business stream from the item master (AD-14).
  'qc.hold_placed': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.hold_released': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.ncr_raised': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.capa_opened': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.capa_closed': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.capa_linked': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  // Story 8.8: witnessed / third-party inspection hold points (FR-Q-15). Per-lot operational
  // quality, not enterprise master data, so these ride the 'qc' stream like every other qc.* type
  // (BSD-1) rather than the 'compliance' stream, which is reserved for the non-site-tenanted
  // registers. None carries a business stream: a hold point is a decision about a lot, and the
  // lot_trace entry the raise applier writes derives its business stream from the item master
  // (AD-14).
  'qc.witness_hold_point_raised': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.witness_notice_recorded': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.witnessed_inspection_signed_off': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  'qc.witnessed_inspection_waived': {
    streamType: 'qc',
    requiresBusinessStream: false,
  },
  // Story 8.7: compliance master data (BIS licence register, Legal Metrology label masters) on a
  // NEW 'compliance' stream. Master data, not inventory movements, so business-stream tagging is
  // not gated on them - the supplier.registered/asset.registered precedent (BSD-1). All five are
  // central-only: no edge sync set entries, no requiresBusinessStream.
  'compliance.bis_licence_recorded': {
    streamType: 'compliance',
    requiresBusinessStream: false,
  },
  'compliance.bis_licence_updated': {
    streamType: 'compliance',
    requiresBusinessStream: false,
  },
  'compliance.bis_licence_expiry_flagged': {
    streamType: 'compliance',
    requiresBusinessStream: false,
  },
  'compliance.label_version_drafted': {
    streamType: 'compliance',
    requiresBusinessStream: false,
  },
  'compliance.label_version_approved': {
    streamType: 'compliance',
    requiresBusinessStream: false,
  },
} as const;

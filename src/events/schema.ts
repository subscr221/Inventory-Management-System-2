import type { EventEnvelope } from './store.js';

/**
 * Event types introduced by Story 2.5: Inter-Location Transfer Requests.
 *
 * Reserved event name (not registered): `qc.lot_dispositioned` - Epic 8 Story 8.3 lot
 * disposition. Story 4.2's quality-acceptance scorecard applier activates when Epic 8 lands.
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
 * Future hook (Epic 8 Story 8.3): the `qc.lot_dispositioned` event name is reserved for the
 * quality-acceptance metric source. It is NOT registered in SUPPORTED_EVENT_TYPES here - Epic 8
 * registers it when lot disposition lands; Story 4.2's quality-acceptance applier activates then.
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
 */
export interface MaintenanceWorkOrderCompletedPayload {
  work_order_id: string;
  asset_id: string;
  completed_at: string;
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
  return_due_date: string;
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
} as const;

import type { EventEnvelope } from './store.js';

/**
 * Event types introduced by Story 2.5: Inter-Location Transfer Requests.
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
} as const;

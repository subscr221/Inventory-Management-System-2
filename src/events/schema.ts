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
} as const;
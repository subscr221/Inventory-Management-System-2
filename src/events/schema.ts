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
} as const;
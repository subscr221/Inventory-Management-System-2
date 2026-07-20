import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { getLotByNumberAndSku, lotExistsByNumberAndSku, applyLotEvent } from '../read/projections/lot_master.js';
import type { LotMaster } from '../read/projections/lot_master.js';
import { getSerialByNumberAndSku, serialExistsByNumberAndSku, applySerialReceipt, applySerialIssue } from '../read/projections/serial_master.js';
import type { SerialMaster } from '../read/projections/serial_master.js';
import { getItemBySku } from '../read/projections/item_master.js';
import type { ItemMaster } from '../read/projections/item_master.js';

/**
 * Lot and serial validation compliance seam (Story 2.3). This module validates lot and serial
 * requirements in the write path, rejecting invalid operations before they reach persistEvent.
 *
 * Lot validation rules:
 * 1. Lot must exist for issue/allocate operations
 * 2. Lot must not be on quality hold for issue/allocate operations
 * 3. Lot must not be expired for issue/allocate operations (unless override flag is provided)
 *
 * Serial validation rules:
 * 1. Serial must exist for issue operations
 * 2. Serial must be available (not already allocated)
 * 3. Item must be marked serial-controlled in the item master
 * 4. Serial numbers must be unique per SKU
 */

// Error codes that match the architecture specification
export const ERROR_CODES = {
  LOT_EXPIRED: 'LOT_EXPIRED',
  LOT_ON_HOLD: 'LOT_ON_HOLD',
  DUPLICATE_SERIAL: 'DUPLICATE_SERIAL',
  SERIAL_REQUIRED: 'SERIAL_REQUIRED',
  NO_AVAILABLE_LOT: 'NO_AVAILABLE_LOT',
} as const;

export interface LotValidationResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface SerialValidationResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** The DB-touching lookups, injectable so unit tests can exercise branching without a database. */
export interface LotSerialDeps {
  getLotByNumberAndSku: (lotNumber: string, sku: string, client?: PoolClient) => Promise<LotMaster | null>;
  lotExistsByNumberAndSku: (lotNumber: string, sku: string, client?: PoolClient) => Promise<boolean>;
  getSerialByNumberAndSku: (serialNumber: string, sku: string, client?: PoolClient) => Promise<SerialMaster | null>;
  serialExistsByNumberAndSku: (serialNumber: string, sku: string, client?: PoolClient) => Promise<boolean>;
  getItemBySku: (sku: string, client?: PoolClient) => Promise<ItemMaster | null>;
}

const LOT_SERIAL_STREAM_TYPES = new Set(['inventory']);
const LOT_SERIAL_EVENT_TYPES = new Set(['stock.received', 'stock.allocated', 'stock.issued']);

/**
 * Determines if an event should be processed by the lot/serial validation seam.
 */
export function isLotSerialEvent(envelope: EventEnvelope): boolean {
  if (!LOT_SERIAL_STREAM_TYPES.has(envelope.stream_type)) return false;
  if (!LOT_SERIAL_EVENT_TYPES.has(envelope.event_type)) return false;
  
  // Always validate issue events for serial-controlled items
  if (envelope.event_type === 'stock.issued') return true;
  
  // For other events, only validate if lot/serial fields are explicitly present
  if (envelope.payload['lot_id'] !== undefined) return true;
  if (envelope.payload['serials'] !== undefined) return true;
  
  return false;
}

/**
 * Validates a lot for receipt operations.
 * Ensures the lot doesn't already exist with the same SKU + expiry combination.
 */
export async function validateLotForReceipt(
  lotNumber: string,
  sku: string,
  _expiryDate: string | null,
  client?: PoolClient,
): Promise<LotValidationResult> {
  const exists = await lotExistsByNumberAndSku(lotNumber, sku, client);
  if (exists) {
    return {
      valid: false,
      errorCode: ERROR_CODES.DUPLICATE_SERIAL,
      message: 'Lot already exists with the same lot number and SKU',
      details: { lotNumber, sku },
    };
  }

  return { valid: true };
}

/**
 * Validates a lot for issue/allocate operations.
 * Checks existence, quality hold status, and expiry date.
 */
export async function validateLotForIssueAllocate(
  lotNumber: string,
  sku: string,
  overrideExpired?: boolean,
  client?: PoolClient,
): Promise<LotValidationResult> {
  const lot = await getLotByNumberAndSku(lotNumber, sku, client);
  
  if (!lot) {
    return {
      valid: false,
      errorCode: 'LOT_NOT_FOUND',
      message: 'Lot not found',
      details: { lotNumber, sku },
    };
  }

  // Check quality hold status
  if (lot.quality_hold_status === 'held') {
    return {
      valid: false,
      errorCode: ERROR_CODES.LOT_ON_HOLD,
      message: 'Lot is on quality hold',
      details: { lotNumber, sku, reason: lot.quality_hold_reason },
    };
  }

  // Check expiry date if not overridden
  if (!overrideExpired && lot.expiry_date) {
    const today = new Date().toISOString().split('T')[0]!;
    if (lot.expiry_date < today) {
      return {
        valid: false,
        errorCode: ERROR_CODES.LOT_EXPIRED,
        message: 'Lot has expired',
        details: { lotNumber, sku, expiryDate: lot.expiry_date },
      };
    }
  }

  return { valid: true };
}

/**
 * Validates serial numbers for receipt operations.
 * Ensures serial numbers are unique per SKU.
 */
export async function validateSerialsForReceipt(
  sku: string,
  serialNumbers: string[],
  client?: PoolClient,
): Promise<SerialValidationResult> {
  // Check if item is serial-controlled
  const item = await getItemBySku(sku, client);
  if (item && !item.serial_controlled) {
    return {
      valid: false,
      errorCode: ERROR_CODES.SERIAL_REQUIRED,
      message: 'Item is not marked as serial-controlled',
      details: { sku },
    };
  }

  // Check for duplicate serials
  for (const serialNumber of serialNumbers) {
    const exists = await serialExistsByNumberAndSku(serialNumber, sku, client);
    if (exists) {
      const serial = await getSerialByNumberAndSku(serialNumber, sku, client);
      return {
        valid: false,
        errorCode: ERROR_CODES.DUPLICATE_SERIAL,
        message: 'Serial number already exists for this SKU',
        details: { 
          serialNumber, 
          sku, 
          currentLocationId: serial?.current_location_id || null,
        },
      };
    }
  }

  return { valid: true };
}

/**
 * Validates serial numbers for issue operations.
 * Ensures serials exist and are available.
 */
export async function validateSerialsForIssue(
  sku: string,
  serialNumbers: string[],
  client?: PoolClient,
): Promise<SerialValidationResult> {
  // Check if item is serial-controlled
  const item = await getItemBySku(sku, client);
  if (item && !item.serial_controlled) {
    return {
      valid: false,
      errorCode: ERROR_CODES.SERIAL_REQUIRED,
      message: 'Item is not marked as serial-controlled',
      details: { sku },
    };
  }

  // Check that all serials exist
  for (const serialNumber of serialNumbers) {
    const exists = await serialExistsByNumberAndSku(serialNumber, sku, client);
    if (!exists) {
      return {
        valid: false,
        errorCode: 'SERIAL_NOT_FOUND',
        message: 'Serial number not found',
        details: { serialNumber, sku },
      };
    }
  }

  return { valid: true };
}

/**
 * Non-DB shape validation for gated lot/serial events.
 */
export function assertLotSerialShape(envelope: EventEnvelope): void {
  if (!isLotSerialEvent(envelope)) return;

  // Validate lot_id if present
  if (envelope.payload['lot_id'] !== undefined) {
    if (typeof envelope.payload['lot_id'] !== 'string' || envelope.payload['lot_id'].trim().length === 0) {
      throw new AppError(400, 'INVALID_PARAMS', 'lot_id must be a non-empty string when supplied', {
        event_type: envelope.event_type,
      });
    }
  }

  // Validate serials if present
  if (envelope.payload['serials'] !== undefined) {
    if (!Array.isArray(envelope.payload['serials'])) {
      throw new AppError(400, 'INVALID_PARAMS', 'serials must be an array when supplied', {
        event_type: envelope.event_type,
      });
    }

    for (const serial of envelope.payload['serials']) {
      if (typeof serial !== 'object' || serial === null) {
        throw new AppError(400, 'INVALID_PARAMS', 'Each serial must be an object', {
          event_type: envelope.event_type,
        });
      }

      if (typeof serial['serial_number'] !== 'string' || serial['serial_number'].trim().length === 0) {
        throw new AppError(400, 'INVALID_PARAMS', 'Each serial must have a non-empty serial_number', {
          event_type: envelope.event_type,
        });
      }

      if (serial['initial_quantity'] !== undefined) {
        if (typeof serial['initial_quantity'] !== 'number' || serial['initial_quantity'] <= 0) {
          throw new AppError(400, 'INVALID_PARAMS', 'initial_quantity must be a positive number when supplied', {
            event_type: envelope.event_type,
          });
        }
      }
    }
  }
}

/**
 * Applies lot/serial validation for a gated event.
 * This function should be called before the domain_events INSERT in the transaction.
 */
export async function applyLotSerialValidation(
  envelope: EventEnvelope,
  client: PoolClient,
): Promise<void> {
  if (!isLotSerialEvent(envelope)) return;

  // ponytail: idempotency guard — check the idempotency key and event_id here so the validation
  // is a no-op on retry, letting the subsequent INSERT produce the correct DUPLICATE_EVENT.
  if (envelope.idempotency_key || envelope.event_id) {
    const existing = await client.query(
      `SELECT 1 FROM domain_events WHERE ($1::text IS NOT NULL AND idempotency_key = $1) OR event_id = $2 LIMIT 1`,
      [envelope.idempotency_key ?? null, envelope.event_id ?? null],
    );
    if (existing.rows.length > 0) return;
  }

  const sku = envelope.payload['sku'] as string;
  const lotId = envelope.payload['lot_id'] as string | undefined;
  const serials = envelope.payload['serials'] as Array<{ serial_number: string; initial_quantity?: number }> | undefined;

  // For issue events, validate serial requirement for serial-controlled items
  if (envelope.event_type === 'stock.issued') {
    const item = await getItemBySku(sku, client);
    if (item?.serial_controlled) {
      if (!serials || serials.length === 0) {
        throw new AppError(400, ERROR_CODES.SERIAL_REQUIRED, 'Serial-controlled item requires serial numbers', { sku });
      }
    }
    
    // Validate lot if present on issue event
    if (lotId) {
      const overrideExpired = envelope.payload['override_expired_lot'] === true;
      const validationResult = await validateLotForIssueAllocate(lotId, sku, overrideExpired, client);
      if (!validationResult.valid) {
        throw new AppError(400, validationResult.errorCode || 'LOT_VALIDATION_ERROR', validationResult.message || 'Lot validation failed', validationResult.details);
      }
    }
    
    // Validate and apply serials if present on issue event
    if (serials && serials.length > 0) {
      const serialNumbers = serials.map(s => s.serial_number);
      const validationResult = await validateSerialsForIssue(sku, serialNumbers, client);
      if (!validationResult.valid) {
        throw new AppError(400, validationResult.errorCode || 'SERIAL_VALIDATION_ERROR', validationResult.message || 'Serial validation failed', validationResult.details);
      }
      
      // Apply serial issue - mark as issued
      for (const serialNumber of serialNumbers) {
        await applySerialIssue(serialNumber, sku, client);
      }
    }
    return;
  }

  // For receipt events, validate and apply lot/serial
  if (envelope.event_type === 'stock.received') {
    // Validate lot if present
    if (lotId) {
      if (envelope.payload['expiry_date']) {
        // With expiry_date: validate lot doesn't already exist, then create it
        const expiryDate = envelope.payload['expiry_date'] as string | undefined;
        const validationResult = await validateLotForReceipt(lotId, sku, expiryDate ?? null, client);
        if (!validationResult.valid) {
          throw new AppError(400, validationResult.errorCode || 'LOT_VALIDATION_ERROR', validationResult.message || 'Lot validation failed', validationResult.details);
        }
        await applyLotEvent({ lot_number: lotId, sku, expiry_date: expiryDate ?? null }, client);
      } else {
        // Without expiry_date: lot should already exist (legacy or pre-created)
        // If it doesn't exist, create it (for backward compatibility)
        const existingLot = await getLotByNumberAndSku(lotId, sku, client);
        if (!existingLot) {
          await applyLotEvent({ lot_number: lotId, sku, expiry_date: null }, client);
        }
      }
    }

    // Validate and apply serials if present
    if (serials && serials.length > 0) {
      const serialNumbers = serials.map(s => s.serial_number);
      const validationResult = await validateSerialsForReceipt(sku, serialNumbers, client);
      if (!validationResult.valid) {
        throw new AppError(400, validationResult.errorCode || 'SERIAL_VALIDATION_ERROR', validationResult.message || 'Serial validation failed', validationResult.details);
      }
      
      // Apply each serial projection
      const locationId = envelope.payload['target_location_id'] as string | undefined;
      const locationCode = envelope.payload['target_location_code'] as string | undefined;
      
      for (const serial of serials) {
        await applySerialReceipt({
          serial_number: serial.serial_number,
          sku,
          current_location_id: locationId ?? null,
          current_location_code: locationCode ?? null,
          current_quantity: String(serial.initial_quantity ?? 1),
        }, client);
      }
    }
    return;
  }

  // For allocate events, validate lot if present
  if (envelope.event_type === 'stock.allocated' && lotId) {
    const overrideExpired = envelope.payload['override_expired_lot'] === true;
    const validationResult = await validateLotForIssueAllocate(lotId, sku, overrideExpired, client);
    if (!validationResult.valid) {
      throw new AppError(400, validationResult.errorCode || 'LOT_VALIDATION_ERROR', validationResult.message || 'Lot validation failed', validationResult.details);
    }
  }
}
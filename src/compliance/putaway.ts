import type { PoolClient } from 'pg';
import type { LocationOverrideEnvelope, PutawayCompletedEnvelope } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import { completePutawayTask, getPutawayTaskById } from '../read/projections/putaway_task.js';
import { getLocationByCode, recordAssertedLocation, recordExpectedLocation, updateCurrentLocation } from '../read/projections/location.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';

/** Story 3.5 Task 5: Pre-transaction shape validation for putaway.completed envelope. */
export function assertPutawayCompletedShape(envelope: PutawayCompletedEnvelope): void {
  const { payload } = envelope;

  if (!payload.putaway_task_id) {
    throw new AppError('PUTAWAY_TASK_REQUIRED', 'putaway_task_id is required');
  }

  if (!payload.actual_location_id && !payload.actual_location_code) {
    throw new AppError('PUTAWAY_LOCATION_REQUIRED', 'Either actual_location_id or actual_location_code is required');
  }

  if (payload.override_reason_code && !payload.override_confidence) {
    throw new AppError('PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED', 'override_confidence is required when override_reason_code is present');
  }

  if (payload.override_reason_code && !['certain', 'uncertain'].includes(payload.override_confidence!)) {
    throw new AppError('PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED', 'override_confidence must be "certain" or "uncertain"');
  }
}

/** Story 3.5 Task 5: Pre-transaction shape validation for location.override envelope. */
export function assertLocationOverrideShape(_envelope: LocationOverrideEnvelope): void {
  // No-op pass-through; all validation is done in assertPutawayCompletedShape and applyPutawayCompletedProjection.
}

export interface ApplyPutawayCompletedInput {
  putawayTaskId: string;
  actualLocationId?: string;
  actualLocationCode?: string;
  overrideReasonCode?: string;
  overrideConfidence?: 'certain' | 'uncertain';
  completedBy: string;
  eventId: string;
}

/**
 * Story 3.5 Task 5.3: In-transaction projection apply for putaway.completed + location.override.
 * Handles completion of the putaway task and optionally records an override if the actual location
 * differs from the directed suggestion.
 */
export async function applyPutawayCompletedProjection(
  input: ApplyPutawayCompletedInput,
  client: PoolClient,
): Promise<void> {
  const { putawayTaskId, actualLocationId, actualLocationCode, overrideReasonCode, overrideConfidence, completedBy, eventId } = input;

  // Step 1: Load the putaway task
  const task = await getPutawayTaskById(putawayTaskId, client);
  if (!task) {
    throw new AppError('PUTAWAY_TASK_NOT_FOUND', `Putaway task ${putawayTaskId} not found`);
  }

  if (task.status !== 'ready') {
    // Idempotent check: if already completed with the same location, treat as no-op
    if (task.status === 'completed' && task.actual_location_code === actualLocationCode) {
      return;
    }
    throw new AppError('PUTAWAY_TASK_NOT_READY', `Putaway task ${putawayTaskId} is not in ready state`);
  }

  // Step 2: Resolve actual location ID from code if needed
  let resolvedLocationId: string;
  const resolvedLocationCode: string = actualLocationCode || actualLocationId || '';

  if (actualLocationCode) {
    const location = await getLocationByCode(actualLocationCode, client);
    if (!location) {
      throw new AppError('PUTAWAY_LOCATION_NOT_FOUND', `Location ${actualLocationCode} not found`);
    }
    resolvedLocationId = location.location_id;
  } else if (actualLocationId) {
    resolvedLocationId = actualLocationId;
  } else {
    throw new AppError('PUTAWAY_LOCATION_REQUIRED', 'Either actualLocationId or actualLocationCode must be provided');
  }

  // Step 3: Check if override is needed and reason code is present
  const isOverride = task.directed_location_id && task.directed_location_id !== resolvedLocationId;
  if (isOverride && !overrideReasonCode) {
    throw new AppError('PUTAWAY_OVERRIDE_REASON_REQUIRED', 'override_reason_code is required when actual location differs from directed suggestion');
  }

  // Step 4: Write location facts (AD-15 Story 1.6 integration)
  if (task.lot_id) {
    const lot = await getLotByNumberAndSku(task.lot_id, task.sku, client);
    if (lot) {
      const lotId = lot.lot_id;
      const confidence = overrideConfidence || 'certain';

      // Record expected location (from the directed suggestion)
      if (task.directed_location_code) {
        await recordExpectedLocation(
          {
            lot_id: lotId,
            expected_location: task.directed_location_code,
            source: 'putaway_suggestion',
            source_event_id: eventId,
          },
          client,
        );
      }

      // Record asserted location (the actual scanned location)
      await recordAssertedLocation(
        {
          lot_id: lotId,
          asserted_location: resolvedLocationCode,
          recorded_by: completedBy,
          device_id: undefined,
          confidence,
          source_event_id: eventId,
        },
        client,
      );

      // Update current location
      await updateCurrentLocation(lotId, resolvedLocationCode, confidence, undefined, undefined, client);
    }
  }

  // Step 5: Complete the putaway task
  const completed = await completePutawayTask(
    {
      putawayTaskId,
      actualLocationId: resolvedLocationId,
      actualLocationCode: resolvedLocationCode,
      overrideReasonCode: overrideReasonCode || null,
      overrideConfidence: overrideConfidence || null,
      completedBy,
      completedEventId: eventId,
    },
    client,
  );

  if (!completed) {
    throw new AppError('PUTAWAY_TASK_NOT_READY', `Putaway task ${putawayTaskId} could not be completed (already completed or released)`);
  }
}

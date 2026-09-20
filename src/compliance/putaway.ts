import type { PoolClient } from 'pg';
import type { LocationOverrideEnvelope, PutawayCompletedEnvelope } from '../events/schema.js';
import { AppError } from '../middleware/error.js';
import {
  completePutawayTask,
  getPutawayTaskByIdForUpdate,
} from '../read/projections/putaway_task.js';
import {
  getCurrentLocation,
  recordAssertedLocation,
  recordExpectedLocation,
  updateCurrentLocation,
} from '../read/projections/location.js';
import { getLocationByCode, getLocationById } from '../read/projections/location_register.js';
import type { LocationRegisterEntry } from '../read/projections/location_register.js';
import { getLotByNumberAndSku } from '../read/projections/lot_master.js';
import { applyStockIssue, applyStockReceipt } from '../read/projections/stock_balance.js';
import { binOfSiteFault, isQuarantineLocation, lotRelocationHold } from './stock-relocation.js';

/** Story 3.5 Task 5: Pre-transaction shape validation for putaway.completed envelope. */
export function assertPutawayCompletedShape(envelope: PutawayCompletedEnvelope): void {
  const { payload } = envelope;

  if (!payload.putaway_task_id) {
    throw new AppError(400, 'PUTAWAY_TASK_REQUIRED', 'putaway_task_id is required');
  }

  if (!payload.actual_location_id && !payload.actual_location_code) {
    throw new AppError(
      400,
      'PUTAWAY_LOCATION_REQUIRED',
      'Either actual_location_id or actual_location_code is required',
    );
  }

  if (payload.override_reason_code && !payload.override_confidence) {
    throw new AppError(
      400,
      'PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED',
      'override_confidence is required when override_reason_code is present',
    );
  }

  if (
    payload.override_reason_code &&
    !['certain', 'uncertain'].includes(payload.override_confidence!)
  ) {
    throw new AppError(
      400,
      'PUTAWAY_OVERRIDE_CONFIDENCE_REQUIRED',
      'override_confidence must be "certain" or "uncertain"',
    );
  }
}

/** Story 3.5 Task 5: Pre-transaction shape validation for location.override envelope. */
export function assertLocationOverrideShape(_envelope: LocationOverrideEnvelope): void {
  // No-op pass-through; all validation is done in assertPutawayCompletedShape and applyPutawayCompletedProjection.
}

export interface ApplyPutawayCompletedInput {
  putawayTaskId: string;
  actualLocationId?: string | undefined;
  actualLocationCode?: string | undefined;
  overrideReasonCode?: string | undefined;
  overrideConfidence?: 'certain' | 'uncertain' | undefined;
  completedBy: string;
  eventId: string;
}

/**
 * Story 3.5 Task 5.3: In-transaction projection apply for putaway.completed + location.override.
 * Handles completion of the putaway task and optionally records an override if the actual location
 * differs from the directed suggestion.
 *
 * Pilot B2: completion also MOVES the stock balance from the task's receiving location to the
 * actual bin. Like applyReplenishmentTaskCompletedProjection it calls applyStockIssue /
 * applyStockReceipt directly (applyStockBalanceProjection is gated to the 'inventory' stream and
 * would silently no-op on the 'putaway' stream) inside this same transaction, so the movement, the
 * task completion and the domain_events insert commit or roll back together and a replay of the
 * event log reproduces the same balances. A completed task is refused rather than skipped: the
 * old silent return let persistEvent append a second putaway.completed for a no-op.
 *
 * Pilot B2 review: the destination is validated HERE, not in the REST handler, so a direct
 * POST /events on the putaway stream is refused by the same rule - it must be an active bin of
 * the task's own site (409 PUTAWAY_DESTINATION_INVALID). A lot under a blocking QC gate may be
 * relocated, because a relocation is not a consumption, but only into a quarantine bin
 * (409 PUTAWAY_QC_HOLD_QUARANTINE_REQUIRED otherwise). Both refusals throw before any write.
 */
export async function applyPutawayCompletedProjection(
  input: ApplyPutawayCompletedInput,
  client: PoolClient,
): Promise<void> {
  const {
    putawayTaskId,
    actualLocationId,
    actualLocationCode,
    overrideReasonCode,
    overrideConfidence,
    completedBy,
    eventId,
  } = input;

  // Step 1: Load the putaway task with FOR UPDATE to serialise concurrent completions
  const task = await getPutawayTaskByIdForUpdate(putawayTaskId, client);
  if (!task) {
    throw new AppError(404, 'PUTAWAY_TASK_NOT_FOUND', `Putaway task ${putawayTaskId} not found`);
  }

  if (task.status === 'completed') {
    throw new AppError(
      409,
      'PUTAWAY_TASK_ALREADY_COMPLETED',
      `Putaway task ${putawayTaskId} is already completed`,
      { putaway_task_id: putawayTaskId },
    );
  }

  if (task.status !== 'ready') {
    throw new AppError(
      409,
      'PUTAWAY_TASK_NOT_READY',
      `Putaway task ${putawayTaskId} is not in ready state`,
    );
  }

  // Step 2: Resolve actual location from code or ID
  let resolvedLocationId: string;
  let resolvedLocationCode: string;
  let destination: LocationRegisterEntry;

  if (actualLocationCode) {
    const location = await getLocationByCode(actualLocationCode, client);
    if (!location) {
      throw new AppError(
        404,
        'PUTAWAY_LOCATION_NOT_FOUND',
        `Location ${actualLocationCode} not found`,
      );
    }
    resolvedLocationId = location.location_id;
    resolvedLocationCode = actualLocationCode;
    destination = location;
  } else if (actualLocationId) {
    const location = await getLocationById(actualLocationId, client);
    if (!location) {
      throw new AppError(
        404,
        'PUTAWAY_LOCATION_NOT_FOUND',
        `Location ${actualLocationId} not found`,
      );
    }
    resolvedLocationId = actualLocationId;
    resolvedLocationCode = location.location_code;
    destination = location;
  } else {
    throw new AppError(
      400,
      'PUTAWAY_LOCATION_REQUIRED',
      'Either actualLocationId or actualLocationCode must be provided',
    );
  }

  // Step 2b: The destination must be an active bin of the task's own site. Without this a scanned
  // code from another site, a zone/site row or a retired bin silently took the stock.
  const destinationFault = binOfSiteFault(destination, task.site_id);
  if (destinationFault) {
    throw new AppError(
      409,
      'PUTAWAY_DESTINATION_INVALID',
      `Location ${resolvedLocationCode} cannot take this putaway: the destination must be an active bin of the task's site`,
      {
        putaway_task_id: putawayTaskId,
        location_code: resolvedLocationCode,
        reason: destinationFault,
      },
    );
  }

  // Step 2c: QC policy (shared with the bin-to-bin move, see stock-relocation.ts). A lot under a
  // blocking QC gate OR held by hand on lot_master (Pilot G1) may only go to quarantine. A lot-less
  // task never reaches gated stock (the default drain predicate below still hides it).
  const moves = task.from_location_id !== resolvedLocationId;
  let heldLot = false;
  if (moves && task.lot_id) {
    const hold = await lotRelocationHold(task.sku, task.lot_id, client);
    // Review R6: the drain window now hides a lot held by hand too, so both kinds carry the flag.
    heldLot = hold.qcGated || hold.manuallyHeld;
    if (
      (hold.qcGated || hold.manuallyHeld) &&
      !(await isQuarantineLocation(resolvedLocationId, client))
    ) {
      throw new AppError(
        409,
        'PUTAWAY_QC_HOLD_QUARANTINE_REQUIRED',
        `Lot ${task.lot_id} is under QC hold and must be put away into a quarantine bin, not ${resolvedLocationCode}`,
        {
          putaway_task_id: putawayTaskId,
          sku: task.sku,
          lot_id: task.lot_id,
          location_code: resolvedLocationCode,
        },
      );
    }
  }

  // Step 3: Check if override is needed and reason code is present
  const isOverride = task.directed_location_id && task.directed_location_id !== resolvedLocationId;
  if (isOverride && !overrideReasonCode) {
    throw new AppError(
      400,
      'PUTAWAY_OVERRIDE_REASON_REQUIRED',
      'override_reason_code is required when actual location differs from directed suggestion',
    );
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

      // The asserted-fact/current-location upserts are version-gated (only a strictly newer
      // source_event_version wins), so the putaway assertion is stamped one past the lot's
      // current projection version.
      const current = await getCurrentLocation(lotId, client);
      const nextVersion = (current?.source_event_version ?? 0) + 1;

      const fact = await recordAssertedLocation(
        {
          lot_id: lotId,
          asserted_location: resolvedLocationCode,
          recorded_by: completedBy,
          device_id: null,
          confidence,
          source_event_id: eventId,
          source_event_version: nextVersion,
        },
        client,
      );

      if (fact) {
        await updateCurrentLocation(
          lotId,
          resolvedLocationCode,
          confidence,
          fact.fact_id,
          nextVersion,
          client,
        );
      }
    }
  }

  // Step 5: Move the stock balance from the receiving location to the actual bin (Pilot B2). The
  // stock class is the one the GRN posted (the task's source event); a task with no resolvable
  // source event moves owned stock. The issue is lot-scoped for a lot task (stock_balance.lot_id
  // is the lot NUMBER, the same value the task carries) and fails closed with 409
  // INSUFFICIENT_STOCK - rolling the whole event back - when the source no longer holds the
  // quantity. `relocation` keeps last_issue_at untouched: a move must not reset the obsolescence clock.
  // qc_gate_relocation is set only for the held-lot-into-quarantine case admitted in Step 2c.
  if (moves) {
    const source = await client.query(
      `SELECT payload->>'stock_class' AS stock_class FROM domain_events WHERE event_id = $1`,
      [task.source_event_id],
    );
    const stockClass = (source.rows[0]?.['stock_class'] as string | null | undefined) ?? 'owned';
    await applyStockIssue(
      {
        sku: task.sku,
        location_id: task.from_location_id,
        lot_id: task.lot_id,
        stock_class: stockClass,
        quantity: task.quantity,
        relocation: true,
        ...(heldLot ? { qc_gate_relocation: true } : {}),
      },
      client,
    );
    await applyStockReceipt(
      {
        sku: task.sku,
        location_id: resolvedLocationId,
        location_code: resolvedLocationCode,
        lot_id: task.lot_id,
        stock_class: stockClass,
        quantity: task.quantity,
      },
      client,
    );
  }

  // Step 6: Complete the putaway task
  const completed = await completePutawayTask(
    {
      putawayTaskId,
      actualLocationId: resolvedLocationId,
      actualLocationCode: resolvedLocationCode,
      overrideReasonCode: overrideReasonCode ?? null,
      overrideConfidence: overrideConfidence ?? null,
      completedBy,
      completedEventId: eventId,
    },
    client,
  );

  if (!completed) {
    throw new AppError(
      409,
      'PUTAWAY_TASK_NOT_READY',
      `Putaway task ${putawayTaskId} could not be completed (already completed or released)`,
    );
  }
}

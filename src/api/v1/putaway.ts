import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';
import { listPutawayTasks, getPutawayTaskById, setDirectedSuggestion } from '../../read/projections/putaway_task.js';
import { listVelocityClasses } from '../../read/projections/velocity_class.js';
import { computeDirectedSuggestion } from '../../warehouse/putaway-suggestion.js';
import { runReslottingJob } from '../../warehouse/reslotting-job.js';
import { persistEvent } from '../../events/store.js';
import { sendJson, sendRequestError } from '../../middleware/error.js';
import { requireRole, permittedLocationsForModuleScope } from '../../middleware/rbac.js';
import type { EventEnvelope } from '../../events/store.js';

export async function handleListPutawayTasks(query: Record<string, string>, authContext: any): Promise<void> {
  await requireRole(authContext, 'warehouse', ['store_assistant', 'unloading_supervisor', 'warehouse_manager', 'inventory_controller']);

  const filters = {
    siteId: query.site || null,
    status: (query.status as any) || null,
  };

  const pool = getPool();
  const tasks = await listPutawayTasks(filters, pool);

  // Apply site scoping
  const permittedSites = await permittedLocationsForModuleScope(authContext, 'warehouse');
  const filtered = tasks.filter((t) => permittedSites.includes(t.site_id));

  sendJson({ tasks: filtered });
}

export async function handleGetPutawayTask(putawayTaskId: string, authContext: any): Promise<void> {
  await requireRole(authContext, 'warehouse', ['store_assistant', 'unloading_supervisor', 'warehouse_manager', 'inventory_controller']);

  const pool = getPool();
  const task = await getPutawayTaskById(putawayTaskId, pool);

  if (!task) {
    return sendRequestError(404, 'PUTAWAY_TASK_NOT_FOUND', 'Putaway task not found');
  }

  // Check site scope
  const permittedSites = await permittedLocationsForModuleScope(authContext, 'warehouse');
  if (!permittedSites.includes(task.site_id)) {
    return sendRequestError(403, 'LOCATION_ACCESS_DENIED', 'Access denied to this site');
  }

  sendJson({ task });
}

export async function handleGetPutawaySuggestion(putawayTaskId: string, authContext: any): Promise<void> {
  await requireRole(authContext, 'warehouse', ['store_assistant']);

  const pool = getPool();
  const task = await getPutawayTaskById(putawayTaskId, pool);

  if (!task) {
    return sendRequestError(404, 'PUTAWAY_TASK_NOT_FOUND', 'Putaway task not found');
  }

  // Check site scope
  const permittedSites = await permittedLocationsForModuleScope(authContext, 'warehouse');
  if (!permittedSites.includes(task.site_id)) {
    return sendRequestError(403, 'LOCATION_ACCESS_DENIED', 'Access denied to this site');
  }

  try {
    const suggestion = await computeDirectedSuggestion(putawayTaskId, pool);

    if (suggestion.locationId) {
      // Store the suggestion
      await setDirectedSuggestion(
        putawayTaskId,
        suggestion.locationId,
        suggestion.locationCode,
        suggestion.velocityClass,
        pool,
      );
    }

    sendJson({ suggestion });
  } catch (err) {
    const error = err as any;
    return sendRequestError(400, error.code || 'SUGGESTION_ERROR', error.message);
  }
}

export async function handleCompletePutaway(body: Record<string, unknown>, authContext: any): Promise<void> {
  await requireRole(authContext, 'warehouse', ['store_assistant']);

  const putawayTaskId = body.putaway_task_id as string;
  if (!putawayTaskId) {
    return sendRequestError(400, 'PUTAWAY_TASK_REQUIRED', 'putaway_task_id is required');
  }

  const pool = getPool();
  const task = await getPutawayTaskById(putawayTaskId, pool);

  if (!task) {
    return sendRequestError(404, 'PUTAWAY_TASK_NOT_FOUND', 'Putaway task not found');
  }

  // Check site scope
  const permittedSites = await permittedLocationsForModuleScope(authContext, 'warehouse');
  if (!permittedSites.includes(task.site_id)) {
    return sendRequestError(403, 'LOCATION_ACCESS_DENIED', 'Access denied to this site');
  }

  const envelope: EventEnvelope = {
    stream_type: 'putaway',
    stream_id: putawayTaskId,
    event_type: 'putaway.completed',
    payload: {
      putaway_task_id: putawayTaskId,
      actual_location_id: body.actual_location_id || undefined,
      actual_location_code: body.actual_location_code || undefined,
      correlation_id: task.grn_line_id,
      override_reason_code: body.override_reason_code || undefined,
      override_confidence: body.override_confidence || undefined,
      completed_by: authContext.userId,
    },
    metadata: {
      correlation_id: body.idempotency_key || putawayTaskId,
      actor: {
        user_id: authContext.userId,
        role: authContext.role,
        location_id: authContext.locationId,
      },
      occurred_at: new Date().toISOString(),
    },
    idempotency_key: (body.idempotency_key as string) || null,
  };

  try {
    await persistEvent(envelope);
    sendJson({ success: true });
  } catch (err) {
    const error = err as any;
    return sendRequestError(400, error.code || 'PUTAWAY_ERROR', error.message);
  }
}

export async function handleListVelocityClassification(query: Record<string, string>, authContext: any): Promise<void> {
  await requireRole(authContext, 'warehouse', ['store_assistant', 'unloading_supervisor', 'warehouse_manager', 'inventory_controller']);

  const filters = {
    siteId: query.site || null,
    velocityClass: (query.class as any) || null,
  };

  const pool = getPool();
  const classes = await listVelocityClasses(filters, pool);

  // Apply site scoping
  const permittedSites = await permittedLocationsForModuleScope(authContext, 'warehouse');
  const filtered = classes.filter((c) => permittedSites.includes(c.site_id));

  sendJson({ velocity_classifications: filtered });
}

export async function handleReslottingJob(body: Record<string, unknown>, authContext: any): Promise<void> {
  await requireRole(authContext, 'warehouse', ['warehouse_manager', 'inventory_controller']);

  const siteId = (body.site_id as string) || undefined;

  try {
    const results = await runReslottingJob(siteId);
    sendJson({ results });
  } catch (err) {
    const error = err as any;
    return sendRequestError(500, error.code || 'RESLOTTING_ERROR', error.message);
  }
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAppRouter } from '../../src/server.js';
import { CROSS_DOCK_DURATION_METRIC, SUPPORTED_TASK_TYPES } from '../../src/warehouse/task-metrics.js';
import { AppError } from '../../src/middleware/error.js';
import { classifyUploadFailure } from '../../src/sync/upload.js';

const CROSS_DOCK_PERMANENT_CODES = [
  'INVALID_PARAMS',
  'CROSS_DOCK_TASK_NOT_FOUND',
  'CROSS_DOCK_TASK_NOT_READY',
  'CROSS_DOCK_TASK_ALREADY_COMPLETED',
  'CROSS_DOCK_STAGING_INVALID',
  'CROSS_DOCK_DESTINATION_OUTSIDE_STAGING',
  'CROSS_DOCK_SITE_MISMATCH',
  'CROSS_DOCK_ORDER_NOT_OPEN',
  'CROSS_DOCK_DEMAND_ALREADY_ALLOCATED',
  'CROSS_DOCK_QUANTITY_MISMATCH',
];

describe('Story 3.10 Task 6 task metrics surface', () => {
  it('appends cross_docking to the existing task source vocabulary', () => {
    assert.equal(SUPPORTED_TASK_TYPES.filter((taskType) => taskType === 'cross_docking').length, 1);
  });

  it('labels the honest receipt-confirmation to staging-confirmation interval', () => {
    assert.deepEqual(CROSS_DOCK_DURATION_METRIC, {
      label: 'cross_dock_task_duration',
      starts_at: 'receipt_confirmation',
      ends_at: 'staging_confirmation',
    });
  });

  it('uses one cross-dock completion source and excludes its synthetic pick task from double-counting', () => {
    const source = readFileSync(resolve('src/warehouse/task-metrics.ts'), 'utf-8');
    assert.match(source, /WHERE pt\.fulfillment_source = 'standard'/);
    assert.equal((source.match(/FROM cross_dock_task cdt/g) ?? []).length, 2);
  });
});

describe('Story 3.10 Task 7 REST surface', () => {
  it('registers one detail route and dedicated event-sourced mutation routes without a list route', () => {
    const routes = createAppRouter().listRoutes().map(({ method, path }) => `${method} ${path}`);
    assert.equal(routes.filter((route) => route === 'GET /api/v1/cross-dock-tasks/:crossDockTaskId').length, 1);
    assert.equal(routes.filter((route) => route === 'POST /api/v1/cross-dock-tasks/:crossDockTaskId/assign').length, 1);
    assert.equal(routes.filter((route) => route === 'POST /api/v1/cross-dock-tasks/:crossDockTaskId/confirm').length, 1);
    assert.equal(routes.some((route) => route === 'GET /api/v1/cross-dock-tasks'), false);
  });

  it('classifies every client-correctable cross-dock failure as permanent without changing duplicate, auth, or retry handling', () => {
    for (const code of CROSS_DOCK_PERMANENT_CODES) {
      assert.deepEqual(classifyUploadFailure(new AppError(403, code, 'correct capture')), {
        action: 'complete',
        localStatus: 'needs_attention',
        retryable: false,
        serverErrorCode: code,
      });
    }
    assert.equal(classifyUploadFailure(new AppError(409, 'DUPLICATE_EVENT', 'duplicate')).localStatus, 'synced');
    assert.equal(classifyUploadFailure(new AppError(401, 'UNAUTHORIZED', 'sign in')).localStatus, 'auth_required');
    assert.equal(classifyUploadFailure(new AppError(503, 'INTERNAL_ERROR', 'retry')).retryable, true);
  });
});

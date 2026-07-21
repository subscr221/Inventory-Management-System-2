import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config/index.js';
import { Router } from './api/router.js';
import { healthHandler } from './api/v1/health.js';
import { postEventHandler, getStreamHandler } from './api/v1/events.js';
import { provisionUserHandler, patchUserHandler } from './api/v1/scim.js';
import { devTokenHandler } from './api/v1/auth-dev.js';
import { auditLogHandler } from './api/v1/audit.js';
import { configAuditLogHandler } from './api/v1/config.js';
import {
  createDoaEntryHandler,
  updateDoaEntryHandler,
  createDelegationHandler,
  resolveDoaHandler,
  workflowConfigHandler,
} from './api/v1/doa.js';
import {
  createTaggingRuleHandler,
  getTaggingRuleHandler,
  listBusinessStreamsHandler,
} from './api/v1/business-stream.js';
import { getCurrentLocationHandler, seedExpectedLocationHandler } from './api/v1/location.js';
import { createItemHandler, updateItemHandler, getItemHandler } from './api/v1/items.js';
import { getStockHandler } from './api/v1/stock.js';
import {
  getValuationHandler,
  nrvWriteDownHandler,
  nrvRecoveryHandler,
  standardCostVarianceReviewHandler,
  standardCostVarianceReportHandler,
} from './api/v1/valuation.js';
import { createLocationHandler, updateLocationHandler, getLocationHandler } from './api/v1/location-register.js';
import {
  updateCalibrationStatusHandler,
  createQcResultHandler,
  createCalibrationEscalationHandler,
} from './api/v1/instruments.js';
import {
  edgeBootstrapHandler,
  powerSyncCredentialsHandler,
  edgeEventUploadHandler,
} from './api/v1/edge.js';
import {
  listNotificationsHandler,
  getUnreadCountHandler,
  updateNotificationHandler,
  acknowledgeNotificationHandler,
  getPreferencesHandler,
  putPreferencesHandler,
  createPushSubscriptionHandler,
  deletePushSubscriptionHandler,
} from './api/v1/notification.js';
import {
  getLotTraceHandler,
  selectLotHandler,
  placeQualityHoldHandler,
  clearQualityHoldHandler,
} from './api/v1/lots.js';
import {
  createCycleCountHandler,
  submitCycleCountHandler,
  approveAdjustmentHandler,
  rejectAdjustmentHandler,
  getCycleCountHandler,
  listCycleCountsHandler,
} from './api/v1/cycle-counts.js';
import {
  completePhysicalVerificationHandler,
  signOffPhysicalVerificationHandler,
  physicalVerificationReportHandler,
} from './api/v1/physical-verification.js';
import {
  setPlanningParamsHandler,
  getPlanningParamsHandler,
  computeSafetyStockHandler,
  checkReplenishmentHandler,
  listRecommendationsHandler,
  scanObsolescenceHandler,
  obsolescenceReportHandler,
} from './api/v1/inventory-planning.js';
import {
  createTransferRequestHandler,
  getTransferRequestHandler,
  listTransferRequestsHandler,
  approveTransferRequestHandler,
  rejectTransferRequestHandler,
  shipTransferRequestHandler,
  receiveTransferRequestHandler,
  getInTransitHandler,
} from './api/v1/transfer-requests.js';
import { runDispatchCycle } from './notify/dispatch.js';
import { runEscalationCycle } from './notify/escalate.js';
import { runExpiryCycle } from './notify/expire.js';

export function createAppRouter(): Router {
  const router = new Router();

  router.get('/api/v1/health', healthHandler);
  router.post('/api/v1/events', postEventHandler);
  router.get('/api/v1/events/:streamType/:streamId', getStreamHandler);
  router.post('/api/v1/scim/v2/Users', provisionUserHandler);
  router.patch('/api/v1/scim/v2/Users/:externalId', patchUserHandler);
  router.get('/api/v1/audit/log', auditLogHandler);
  router.put('/api/v1/config/audit-log-enabled', configAuditLogHandler);
  router.post('/api/v1/doa/entries', createDoaEntryHandler);
  router.patch('/api/v1/doa/entries/:entryId', updateDoaEntryHandler);
  router.post('/api/v1/doa/delegations', createDelegationHandler);
  router.post('/api/v1/doa/resolve', resolveDoaHandler);
  router.post('/api/v1/doa/workflow-config', workflowConfigHandler);
  router.post('/api/v1/business-streams/rules', createTaggingRuleHandler);
  router.get('/api/v1/business-streams/rules', getTaggingRuleHandler);
  router.get('/api/v1/business-streams', listBusinessStreamsHandler);
  // Story 2.1: /api/v1/locations/* now belongs to the location register (warehouse topology
  // master). The Story 1.6 current-lot-location API moved to explicit /api/v1/lots/* routes -
  // keeping both under /locations would be ambiguous (router matching ignores parameter names).
  router.get('/api/v1/lots/:lotId/location', getCurrentLocationHandler);
  router.post('/api/v1/lots/:lotId/location/expected', seedExpectedLocationHandler);
  router.post('/api/v1/items', createItemHandler);
  router.patch('/api/v1/items/:sku', updateItemHandler);
  router.get('/api/v1/items/:sku', getItemHandler);
  router.post('/api/v1/locations', createLocationHandler);
  router.patch('/api/v1/locations/:locationId', updateLocationHandler);
  router.get('/api/v1/locations/:locationId', getLocationHandler);
  router.get('/api/v1/stock/:sku', getStockHandler);
  router.get('/api/v1/stock/:sku/valuation', getValuationHandler);
  router.post('/api/v1/stock/:sku/valuation/nrv-write-down', nrvWriteDownHandler);
  router.post('/api/v1/stock/:sku/valuation/nrv-recovery', nrvRecoveryHandler);
  router.post('/api/v1/stock/:sku/valuation/standard-cost-variance-review', standardCostVarianceReviewHandler);
  router.get('/api/v1/valuation/standard-cost-variance-report', standardCostVarianceReportHandler);
  // Story 2.5: Inter-Location Transfer Requests
  router.post('/api/v1/transfer-requests', createTransferRequestHandler);
  router.get('/api/v1/transfer-requests/:transfer_request_id', getTransferRequestHandler);
  router.get('/api/v1/transfer-requests', listTransferRequestsHandler);
  router.patch('/api/v1/transfer-requests/:transfer_request_id/approve', approveTransferRequestHandler);
  router.patch('/api/v1/transfer-requests/:transfer_request_id/reject', rejectTransferRequestHandler);
  router.post('/api/v1/transfer-requests/:transfer_request_id/ship', shipTransferRequestHandler);
  router.post('/api/v1/transfer-requests/:transfer_request_id/receive', receiveTransferRequestHandler);
  router.get('/api/v1/stock/:sku/in-transit', getInTransitHandler);
  // Story 2.6: Cycle Counting and Physical Inventory
  router.post('/api/v1/cycle-counts', createCycleCountHandler);
  router.get('/api/v1/cycle-counts', listCycleCountsHandler);
  router.get('/api/v1/cycle-counts/:cycle_count_id', getCycleCountHandler);
  router.post('/api/v1/cycle-counts/:cycle_count_id/submit', submitCycleCountHandler);
  router.patch('/api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/approve', approveAdjustmentHandler);
  router.patch('/api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/reject', rejectAdjustmentHandler);
  router.post('/api/v1/physical-verifications', completePhysicalVerificationHandler);
  router.post('/api/v1/physical-verifications/:physical_verification_id/sign-off', signOffPhysicalVerificationHandler);
  router.get('/api/v1/physical-verification/report', physicalVerificationReportHandler);
  // Story 2.7: Safety Stock, Reorder Points, and Obsolescence Flagging
  router.post('/api/v1/planning/params', setPlanningParamsHandler);
  router.get('/api/v1/planning/params/:sku', getPlanningParamsHandler);
  router.post('/api/v1/planning/safety-stock/compute', computeSafetyStockHandler);
  router.post('/api/v1/planning/replenishment/check', checkReplenishmentHandler);
  router.get('/api/v1/planning/replenishment/recommendations', listRecommendationsHandler);
  router.post('/api/v1/planning/obsolescence/scan', scanObsolescenceHandler);
  router.get('/api/v1/planning/obsolescence/report', obsolescenceReportHandler);
  router.get('/api/v1/lots/:lot_id/trace', getLotTraceHandler);
  router.post('/api/v1/stock/:sku/select-lot', selectLotHandler);
  router.put('/api/v1/lots/:lot_id/quality-hold', placeQualityHoldHandler);
  router.delete('/api/v1/lots/:lot_id/quality-hold', clearQualityHoldHandler);
  router.put('/api/v1/instruments/:id/calibration-status', updateCalibrationStatusHandler);
  router.post('/api/v1/qc/results', createQcResultHandler);
  router.post('/api/v1/instruments/:id/calibration-escalations', createCalibrationEscalationHandler);
  router.get('/api/v1/edge/bootstrap', edgeBootstrapHandler);
  router.get('/api/v1/edge/powersync-credentials', powerSyncCredentialsHandler);
  router.post('/api/v1/edge/events', edgeEventUploadHandler);
  router.get('/api/v1/notifications', listNotificationsHandler);
  router.get('/api/v1/notifications/unread-count', getUnreadCountHandler);
  router.patch('/api/v1/notifications/:id', updateNotificationHandler);
  router.post('/api/v1/notifications/:id/acknowledge', acknowledgeNotificationHandler);
  router.get('/api/v1/notifications/preferences', getPreferencesHandler);
  router.put('/api/v1/notifications/preferences', putPreferencesHandler);
  router.post('/api/v1/notifications/push-subscription', createPushSubscriptionHandler);
  router.delete('/api/v1/notifications/push-subscription', deletePushSubscriptionHandler);

  if (config.auth.mode === 'local') {
    router.post('/api/v1/auth/dev-token', devTokenHandler);
  }

  return router;
}

export function createAppServer(router: Router = createAppRouter()): Server {
  return createServer((req, res) => {
    router.handle(req, res).catch((err) => {
      console.error('Unhandled server error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error_code: 'INTERNAL_ERROR', message: 'Internal server error', details: {}, trace_id: 'unknown' }));
      }
    });
  });
}

const server = createAppServer();

// Story 1.11: the notification dispatcher, escalation clock, and expiry sweep run as in-process
// intervals rather than a separate `notify` container/CD job - see Dev Notes Task 6.2. They only
// start inside startServer() (the real running process), never when a test builds its own
// Router/Server directly, so tests control cycle timing explicitly via runDispatchCycle()/
// runEscalationCycle()/runExpiryCycle() instead of racing a background timer.
let dispatchTimer: ReturnType<typeof setInterval> | undefined;
let escalationTimer: ReturnType<typeof setInterval> | undefined;
let expiryTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Wraps a poll-cycle in a re-entrancy guard: setInterval does NOT skip a tick while the async
 * callback from the previous tick is still pending, so a cycle slower than its interval would
 * otherwise overlap itself and double-process. The guard drops a tick that fires while the
 * previous run is still in flight. (Cross-process overlap - a second app instance - is separately
 * bounded by the atomic claim in the dispatcher and the claim-then-act in the escalator.)
 */
function guarded(name: string, cycle: () => Promise<unknown>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    cycle()
      .catch((err) => console.error(`Notification ${name} cycle failed:`, err))
      .finally(() => {
        running = false;
      });
  };
}

function startServer(): void {
  server.listen(config.port, config.hostname, () => {
    console.log(`Server listening on http://${config.hostname}:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
  });

  dispatchTimer = setInterval(guarded('dispatch', () => runDispatchCycle()), config.notify.dispatchIntervalMs);
  escalationTimer = setInterval(guarded('escalation', () => runEscalationCycle()), config.notify.escalationIntervalMs);
  expiryTimer = setInterval(guarded('expiry', () => runExpiryCycle()), config.notify.expiryIntervalMs);

  const stopTimers = (): void => {
    clearInterval(dispatchTimer);
    clearInterval(escalationTimer);
    clearInterval(expiryTimer);
  };

  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    stopTimers();
    server.close(async () => {
      const { closePool } = await import('./config/db.js');
      await closePool();
      console.log('Server and database connections closed.');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    stopTimers();
    server.close(async () => {
      const { closePool } = await import('./config/db.js');
      await closePool();
      console.log('Server and database connections closed.');
      process.exit(0);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

export { server };

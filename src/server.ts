import { createServer } from 'node:http';
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
import {
  updateCalibrationStatusHandler,
  createQcResultHandler,
  createCalibrationEscalationHandler,
} from './api/v1/instruments.js';

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
router.get('/api/v1/locations/:lotId', getCurrentLocationHandler);
router.post('/api/v1/locations/:lotId/expected', seedExpectedLocationHandler);
router.put('/api/v1/instruments/:id/calibration-status', updateCalibrationStatusHandler);
router.post('/api/v1/qc/results', createQcResultHandler);
router.post('/api/v1/instruments/:id/calibration-escalations', createCalibrationEscalationHandler);

if (config.auth.mode === 'local') {
  router.post('/api/v1/auth/dev-token', devTokenHandler);
}

const server = createServer((req, res) => {
  router.handle(req, res).catch((err) => {
    console.error('Unhandled server error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error_code: 'INTERNAL_ERROR', message: 'Internal server error', details: {}, trace_id: 'unknown' }));
    }
  });
});

server.listen(config.port, config.hostname, () => {
  console.log(`Server listening on http://${config.hostname}:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(async () => {
    const { closePool } = await import('./config/db.js');
    await closePool();
    console.log('Server and database connections closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(async () => {
    const { closePool } = await import('./config/db.js');
    await closePool();
    console.log('Server and database connections closed.');
    process.exit(0);
  });
});

export { server };

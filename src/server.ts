import { createServer } from 'node:http';
import { config } from './config/index.js';
import { Router } from './api/router.js';
import { healthHandler } from './api/v1/health.js';
import { postEventHandler, getStreamHandler } from './api/v1/events.js';

const router = new Router();

router.get('/api/v1/health', healthHandler);
router.post('/api/v1/events', postEventHandler);
router.get('/api/v1/events/:streamType/:streamId', getStreamHandler);

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

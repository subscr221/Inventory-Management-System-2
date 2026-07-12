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
      res.end(JSON.stringify({ error_code: 'INTERNAL_ERROR', message: 'Internal server error' }));
    }
  });
});

server.listen(config.port, config.hostname, () => {
  console.log(`Server listening on http://${config.hostname}:${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
});

export { server };

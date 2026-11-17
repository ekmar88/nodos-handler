/** Build the Express application around already-created Nodos clients. */
import express from 'express';
import { fileURLToPath } from 'node:url';
import routes from './routes/index.js';
import { requestLogger, jsonParser, cors, apiKeyAuth, errorHandler, notFoundHandler } from './middlewares/index.js';
import * as nodesController from './controllers/nodes.controller.js';
import * as eventsController from './controllers/events.controller.js';

const ENDPOINTS = {
  health: 'GET /health',
  panel: 'GET /panel/',
  status: 'GET /api/status',
  events: 'GET /api/events[?node=]',
  graph: 'GET /api/graph',
  listNodes: 'GET /api/nodes[?name=&class=&path=&pins=false&fresh=true]',
  getNode: 'GET /api/nodes/:nodeId',
  getNodesByClass: 'GET /api/nodes/class/:className',
  getPin: 'GET /api/nodes/:nodeId/pins/:pinId',
  getPinValue: 'GET /api/nodes/:nodeId/pin/:pinId/current-value',
  updatePin: 'POST /api/nodes/:nodeId/pin/:pinId',
  patchPin: 'PATCH /api/nodes/:nodeId/pin/:pinId',
  updatePins: 'POST /api/nodes/:nodeId/pins',
  patchPins: 'PATCH /api/nodes/:nodeId/pins',
  dirtyPin: 'POST /api/nodes/:nodeId/dirty',
};

export function createApp({ appClient = null, graphClient = null, apiKey } = {}) {
  nodesController.initialize(appClient, graphClient);
  eventsController.initialize(appClient, graphClient);

  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(cors);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'nodos-backend',
      graph_ready: graphClient?.isReady() ?? false,
    });
  });
  app.get('/', (_req, res) => {
    res.json({
      service: 'Nodos Backend API',
      version: '1.1.0',
      description: 'Express backend to browse and control Nodos nodes via the EditorService',
      endpoints: ENDPOINTS,
    });
  });
  app.use('/panel', express.static(fileURLToPath(new URL('../public', import.meta.url))));

  app.use('/api', apiKeyAuth(apiKey), jsonParser, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

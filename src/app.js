/**
 * Nodos Backend — Express Application
 * 
 * A REST API backend that communicates with Nodos via gRPC
 * to control node properties in a running Nodos instance.
 * 
 * Supported node types:
 *   - Location (vec3) — 3D vector with x, y, z pins
 *   - Double (double) — floating point value
 *   - String (string) — text value
 *   - Bool (bool) — boolean value
 */

import express from 'express';
import config from '../config/default.js';
import routes from './routes/index.js';
import {
  requestLogger,
  jsonParser,
  errorHandler,
  notFoundHandler,
} from './middlewares/index.js';
import { NodosClient } from './lib/nodos-client.js';
import { NodosGraphClient } from './lib/nodos-graph-client.js';
import * as nodesController from './controllers/nodes.controller.js';

// ============================================================
// Initialize Express app
// ============================================================
const app = express();

// ============================================================
// Middleware
// ============================================================
app.use(requestLogger);
app.use(jsonParser);

// Enable CORS for frontend development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================================
// Routes
// ============================================================

// Health check (BEFORE /api routes)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'nodos-backend',
  });
});

// API routes
app.use('/api', routes);

// Root endpoint
app.get('/', (_req, res) => {
  res.json({
    service: 'Nodos Backend API',
    version: '1.0.0',
    description: 'Express backend to control Nodos node properties via gRPC',
    endpoints: {
      health: 'GET /health',
      status: 'GET /api/nodes/status',
      listNodes: 'GET /api/nodes',
      getNode: 'GET /api/nodes/:nodeId',
      getNodesByClass: 'GET /api/nodes/class/:className',
      updatePin: 'POST /api/nodes/:nodeId/pin/:pinId',
      updatePins: 'POST /api/nodes/:nodeId/pins',
      dirtyPin: 'POST /api/nodes/:nodeId/dirty',
      getPinValue: 'GET /api/nodes/:nodeId/pin/:pinId/current-value',
    },
  });
});

// ============================================================
// Error handling
// ============================================================
app.use(notFoundHandler);
app.use(errorHandler);

// ============================================================
// Start server and connect to Nodos
// ============================================================
async function start() {
  console.log('='.repeat(60));
  console.log('  Nodos Backend API');
  console.log('='.repeat(60));

  // Connect to Nodos
  console.log(`\n[1/2] Connecting to Nodos at ${config.nodos.host}:${config.nodos.port}...`);
  const nodosClient = new NodosClient({
    host: config.nodos.host,
    port: config.nodos.port,
    appKey: config.nodos.appKey,
    appName: config.nodos.appName,
  });

  const graphClient = new NodosGraphClient({
    host: config.nodos.host,
    port: config.nodos.editorPort,
    appName: config.nodos.appName,
  });
  nodesController.initialize(nodosClient, graphClient);
  const connections = await Promise.allSettled([
    nodosClient.connect(),
    graphClient.connect(),
  ]);
  for (const [index, result] of connections.entries()) {
    const service = index === 0 ? 'AppService' : 'EditorService';
    if (result.status === 'rejected') {
      console.warn(`[${service}] ${result.reason.message}`);
    } else {
      console.log(`[${service}] Connected${index === 1 ? `; ${graphClient.getNodes().length} graph nodes` : ''}`);
    }
  }

  // Start Express server
  app.listen(config.server.port, config.server.host, () => {
    console.log('\n' + '='.repeat(60));
    console.log(`  Server running at http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}`);
    console.log(`  API base:     http://localhost:${config.server.port}/api`);
    console.log('='.repeat(60));
    console.log('\n  Quick start:');
    console.log(`    curl http://localhost:${config.server.port}/api/health`);
    console.log(`    curl http://localhost:${config.server.port}/api/nodes`);
    console.log(`    curl -X POST http://localhost:${config.server.port}/api/nodes/YOUR_NODE_ID/pin/YOUR_PIN_ID \\`);
    console.log(`      -H "Content-Type: application/json" \\`);
    console.log(`      -d '{"value": 42.0}'`);
    console.log('='.repeat(60) + '\n');
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

export default app;

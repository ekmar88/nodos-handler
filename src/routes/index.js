/**
 * Routes
 * Mounts all API route handlers
 */

import express from 'express';
import * as nodesController from '../controllers/nodes.controller.js';

const router = express.Router();

// ============================================================
// Node operations (BEFORE /:type catch-all)
// ============================================================

// Update a single pin value
// POST /api/nodes/:nodeId/pin/:pinId
// Body: { "value": ... }
router.post(
  '/nodes/:nodeId/pin/:pinId',
  nodesController.updatePinValue
);

// Update multiple pins at once
// POST /api/nodes/:nodeId/pins
// Body: { "pins": { ... } }
router.post(
  '/nodes/:nodeId/pins',
  nodesController.updateMultiplePins
);

// Mark a pin as dirty
// POST /api/nodes/:nodeId/dirty
// Body: { "pin": "value" }
router.post(
  '/nodes/:nodeId/dirty',
  nodesController.dirtyPin
);

// Get the current value of a pin
// GET /api/nodes/:nodeId/pin/:pinId/current-value
router.get(
  '/nodes/:nodeId/pin/:pinId/current-value',
  nodesController.getPinValue
);

// List all discovered nodes from Nodos
// GET /api/nodes
router.get(
  '/nodes',
  nodesController.listNodes
);

// Check Nodos connection status (MUST come before /:nodeId)
// GET /api/nodes/status
router.get(
  '/nodes/status',
  nodesController.getStatus
);

// Get nodes by class name (e.g., double, string, bool, location) (MUST come before /:nodeId)
// GET /api/nodes/class/:className
router.get(
  '/nodes/class/:className',
  nodesController.getNodesByClassName
);

// Get a node by ID or name
// GET /api/nodes/:nodeId
router.get(
  '/nodes/:nodeId',
  nodesController.getNodeById
);

export default router;

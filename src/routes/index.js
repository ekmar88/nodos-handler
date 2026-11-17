/** API routes (mounted under /api). Static segments are declared before :nodeId. */
import express from 'express';
import * as nodes from '../controllers/nodes.controller.js';
import { streamEvents } from '../controllers/events.controller.js';

const router = express.Router();

// Live updates (Server-Sent Events)
router.get('/events', streamEvents);

// Graph overview
router.get('/status', nodes.getStatus);
router.get('/graph', nodes.getGraphTree);

// Nodes
router.get('/nodes', nodes.listNodes);
router.get('/nodes/status', nodes.getStatus);
router.get('/nodes/class/:className', nodes.getNodesByClassName);
router.get('/nodes/:nodeId', nodes.getNodeById);

// Pins (properties are pins too)
router.get('/nodes/:nodeId/pins/:pinId', nodes.getPin);
router.get('/nodes/:nodeId/pin/:pinId/current-value', nodes.getPinValue);
router.post('/nodes/:nodeId/pin/:pinId', nodes.updatePinValue);
router.patch('/nodes/:nodeId/pin/:pinId', nodes.patchPinValue);
router.post('/nodes/:nodeId/pins', nodes.updateMultiplePins);
router.patch('/nodes/:nodeId/pins', nodes.patchMultiplePins);
router.post('/nodes/:nodeId/dirty', nodes.dirtyPin);

export default router;

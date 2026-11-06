/**
 * Nodes Controller
 * Handles CRUD operations for all Nodos node types
 * Routes: /api/nodes/*
 * 
 * Uses real node/pin IDs and declared Nodos pin types.
 * URL: /api/nodes/:nodeId/pin/:pinId
 * Body: { "value": ... }
 */

// Global Nodos client instance
let nodosClient = null;
let graphClient = null;

/**
 * Initialize the controller with a Nodos client
 */
function initialize(client, graph = null) {
  nodosClient = client;
  graphClient = graph;
}

/**
 * GET /api/nodes/status
 * Check the connection status to Nodos
 */
function getStatus(req, res) {
  res.json({
    success: true,
    api_revision: 'editor-write-diagnostics-v2',
    connected: nodosClient ? nodosClient.isConnected() : false,
    nodos_address: nodosClient
      ? `${nodosClient.host}:${nodosClient.port}`
      : 'not configured',
    app_key: nodosClient ? nodosClient.appKey : 'not configured',
    graph_connected: graphClient ? graphClient.isConnected() : false,
    graph_ready: graphClient?.isReady?.() ?? false,
    editor_address: graphClient ? `${graphClient.host}:${graphClient.port}` : 'not configured',
    graph_error: graphClient?.lastError || null,
    graph_paths: graphClient?.getPathDiagnostics() || null,
  });
}

function sendError(res, error) {
  return res.status(error.status || 500).json({ success: false, error: error.message });
}

/** POST /api/nodes/:nodeId/pin/:pinId — write and confirm a real pin/property update. */
async function updatePinValue(req, res) {
  try {
    if (!graphAvailable(res)) return;
    if (!req.body || req.body.value === undefined || req.body.value === null) {
      return res.status(400).json({ success: false, error: 'Request body must contain a "value" field' });
    }
    const { nodeId, pinId } = req.params;
    const [result] = await graphClient.updatePins(nodeId, { [pinId]: req.body.value });
    res.status(200).json({
      success: true,
      message: 'Pin update confirmed by Nodos',
      ...result,
      pin_uuid: result.pin_id,
      detected_type: result.type,
    });
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /api/nodes/:nodeId/pins — validate all pins before submitting a batch. */
async function updateMultiplePins(req, res) {
  try {
    if (!graphAvailable(res)) return;
    const pins = req.body?.pins;
    if (!pins || typeof pins !== 'object' || Array.isArray(pins) || !Object.keys(pins).length) {
      return res.status(400).json({ success: false, error: 'Request body must contain a non-empty "pins" object' });
    }
    const updated = await graphClient.updatePins(req.params.nodeId, pins);
    res.status(200).json({ success: true, node_id: updated[0].node_id, status: 'confirmed', updated });
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /api/nodes/:nodeId/dirty — resolve the real pin ID for AppService. */
async function dirtyPin(req, res) {
  try {
    if (!graphAvailable(res)) return;
    if (typeof req.body?.pin !== 'string' || !req.body.pin) {
      return res.status(400).json({ success: false, error: 'Request body must contain a "pin" field' });
    }
    const { node, pin } = graphClient.resolvePin(req.params.nodeId, req.body.pin);
    if (!nodosClient?.isConnected()) {
      return res.status(503).json({ success: false, error: 'Nodos AppService is unavailable' });
    }
    await nodosClient.pinDirtied(pin.id);
    res.json({ success: true, node_id: node.id, pin: pin.name, pin_id: pin.id });
  } catch (error) {
    sendError(res, error);
  }
}

/** GET /api/nodes/:nodeId/pin/:pinId/current-value — refresh and read the current engine value. */
async function getPinValue(req, res) {
  try {
    if (!graphAvailable(res)) return;
    await graphClient.refreshFromEngine();
    res.set?.('Cache-Control', 'no-store');
    const { node, pin } = graphClient.resolvePin(req.params.nodeId, req.params.pinId);
    const stored = graphClient.getPinValue(pin.id);
    if (!stored) {
      return res.status(404).json({ success: false, error: 'No decodable value received from Nodos for this pin' });
    }
    res.json({
      success: true, node_id: node.id, pin_id: pin.id, pin_name: pin.name,
      value: stored.value, type: stored.type, source: 'engine',
    });
  } catch (error) {
    sendError(res, error);
  }
}

function graphAvailable(res) {
  if (!graphClient?.isReady()) {
    res.status(503).json({
      success: false,
      error: 'Graph snapshot unavailable from Nodos EditorService',
      details: graphClient?.lastError || 'Waiting for the initial graph snapshot',
      hint: 'Check NODOS_HOST and NODOS_EDITOR_PORT (default 50052); see /api/nodes/status',
    });
    return false;
  }
  return true;
}

/**
 * GET /api/nodes
 * List all discovered nodes from Nodos
 */
async function listNodes(req, res) {
  try {
    if (!graphAvailable(res)) {
      return;
    }
    
    await graphClient.refreshFromEngine();
    res.set?.('Cache-Control', 'no-store');
    const nodes = graphClient.getNodes();
    
    res.json({
      success: true,
      count: nodes.length,
      nodes: nodes,
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * GET /api/nodes/:nodeId
 * Get a node by ID
 */
async function getNodeById(req, res) {
  try {
    const { nodeId } = req.params;
    
    if (!graphAvailable(res)) {
      return;
    }
    
    await graphClient.refreshFromEngine();
    res.set?.('Cache-Control', 'no-store');
    const node = graphClient.resolveNode(nodeId);

    res.json({
      success: true,
      node: node,
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * GET /api/nodes/class/:className
 * Get nodes by class name (e.g., double, string, bool, location)
 */
async function getNodesByClassName(req, res) {
  try {
    const { className } = req.params;
    
    if (!graphAvailable(res)) {
      return;
    }
    
    await graphClient.refreshFromEngine();
    res.set?.('Cache-Control', 'no-store');
    const nodes = graphClient.getNodesByClassName(className);
    
    res.json({
      success: true,
      count: nodes.length,
      class_name: className,
      nodes: nodes,
    });
  } catch (error) {
    sendError(res, error);
  }
}

export {
  initialize,
  getStatus,
  updatePinValue,
  updateMultiplePins,
  dirtyPin,
  getPinValue,
  listNodes,
  getNodeById,
  getNodesByClassName,
};

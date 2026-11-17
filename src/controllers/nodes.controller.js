/**
 * Nodes controller — routes under /api/nodes and /api/graph.
 *
 * Reads are served from the live EditorService stream. Add ?fresh=true (or
 * set NODOS_READ_MODE=fresh) to force a new engine snapshot for a request.
 */
import config from '../../config/default.js';

let nodosClient = null;
let graphClient = null;

function initialize(client, graph = null) {
  nodosClient = client;
  graphClient = graph;
}

function sendError(res, error) {
  return res.status(error.status || 500).json({ success: false, error: error.message });
}

function wantsFresh(req) {
  const fresh = req.query?.fresh;
  return fresh === 'true' || fresh === '1' || config.nodos.readMode === 'fresh';
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

/** Wrap a read handler: availability check, freshness, no-store, errors. */
function reader(handler) {
  return async (req, res) => {
    try {
      if (!graphAvailable(res)) return;
      await graphClient.ensureFresh({ force: wantsFresh(req) });
      res.set?.('Cache-Control', 'no-store');
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

/** GET /api/nodes/status */
function getStatus(req, res) {
  res.json({
    success: true,
    read_mode: config.nodos.readMode,
    connected: nodosClient ? nodosClient.isConnected() : false,
    nodos_address: nodosClient ? `${nodosClient.host}:${nodosClient.port}` : 'not configured',
    app_key: nodosClient ? nodosClient.appKey : 'not configured',
    app_error: nodosClient?.lastError || null,
    graph_connected: graphClient ? graphClient.isConnected() : false,
    graph_ready: graphClient?.isReady?.() ?? false,
    graph_nodes: graphClient ? graphClient.getNodes().length : 0,
    editor_address: graphClient ? `${graphClient.host}:${graphClient.port}` : 'not configured',
    graph_error: graphClient?.lastError || null,
    graph_paths: graphClient?.getPathDiagnostics() || null,
  });
}

/** GET /api/nodes?name=&class=&path=&pins=false */
const listNodes = reader((req, res) => {
  const { name, path } = req.query || {};
  const className = req.query?.class ?? req.query?.className;
  const withPins = req.query?.pins !== 'false';
  const nodes = graphClient.findNodes({ name, className, path }).map(n => graphClient.describeNode(n, { pins: withPins }));
  res.json({ success: true, count: nodes.length, nodes });
});

/** GET /api/graph — nodes as a nested tree (without pins). */
const getGraphTree = reader((req, res) => {
  res.json({ success: true, count: graphClient.getNodes().length, tree: graphClient.getTree() });
});

/** GET /api/nodes/:nodeId — accepts UUID, unique name, or URL-encoded path (%2FGraph.Node). */
const getNodeById = reader((req, res) => {
  res.json({ success: true, node: graphClient.describeNode(graphClient.resolveNode(req.params.nodeId)) });
});

/** GET /api/nodes/class/:className */
const getNodesByClassName = reader((req, res) => {
  const { className } = req.params;
  const nodes = graphClient.getNodesByClassName(className).map(n => graphClient.describeNode(n));
  res.json({ success: true, count: nodes.length, class_name: className, nodes });
});

/** GET /api/nodes/:nodeId/pins/:pinId — pin metadata and current value. */
const getPin = reader((req, res) => {
  const { node, pin } = graphClient.resolvePin(req.params.nodeId, req.params.pinId);
  res.json({ success: true, node_id: node.id, pin: graphClient.describePin(node, pin) });
});

/** GET /api/nodes/:nodeId/pin/:pinId/current-value */
const getPinValue = reader((req, res) => {
  const { node, pin } = graphClient.resolvePin(req.params.nodeId, req.params.pinId);
  const stored = graphClient.getPinValue(pin.id);
  if (!stored) {
    return res.status(404).json({ success: false, error: 'No decodable value received from Nodos for this pin' });
  }
  res.json({
    success: true, node_id: node.id, pin_id: pin.id, pin_name: pin.name,
    value: stored.value, type: stored.type, source: 'engine',
  });
});

/** Shared writer: POST replaces values, PATCH merges partial vectors. */
function pinWriter({ merge, many }) {
  return async (req, res) => {
    try {
      if (!graphAvailable(res)) return;
      if (many) {
        const pins = req.body?.pins;
        if (!pins || typeof pins !== 'object' || Array.isArray(pins) || !Object.keys(pins).length) {
          return res.status(400).json({ success: false, error: 'Request body must contain a non-empty "pins" object' });
        }
        const updated = await graphClient.updatePins(req.params.nodeId, pins, { merge });
        return res.status(200).json({ success: true, node_id: updated[0].node_id, status: 'confirmed', updated });
      }
      if (!req.body || req.body.value === undefined || req.body.value === null) {
        return res.status(400).json({ success: false, error: 'Request body must contain a "value" field' });
      }
      const { nodeId, pinId } = req.params;
      const [result] = await graphClient.updatePins(nodeId, { [pinId]: req.body.value }, { merge });
      res.status(200).json({
        success: true, message: 'Pin update confirmed by Nodos', ...result,
        // Legacy aliases kept for existing clients.
        pin_uuid: result.pin_id, detected_type: result.type,
      });
    } catch (error) {
      sendError(res, error);
    }
  };
}

const updatePinValue = pinWriter({ merge: false, many: false });
const patchPinValue = pinWriter({ merge: true, many: false });
const updateMultiplePins = pinWriter({ merge: false, many: true });
const patchMultiplePins = pinWriter({ merge: true, many: true });

/** POST /api/nodes/:nodeId/dirty — body {"pin": "<uuid or name>"}; uses AppService. */
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

export {
  initialize,
  getStatus,
  listNodes,
  getGraphTree,
  getNodeById,
  getNodesByClassName,
  getPin,
  getPinValue,
  updatePinValue,
  patchPinValue,
  updateMultiplePins,
  patchMultiplePins,
  dirtyPin,
};

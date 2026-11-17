/**
 * GET /api/events — Server-Sent Events stream.
 *
 * Events:
 *   status  {graph_ready, app_connected}       on open and on (dis)connection
 *   graph   {reason}                           graph structure changed (reload nodes)
 *   pin     {node_id, node_name, node_path, pin_id, pin, value, type}
 *
 * Optional filter: ?node=<uuid|name|path> only sends pin events for that node.
 */
import { normalizeUUID } from '../lib/pin-values.js';

const HEARTBEAT_MS = 15000;

let graphClient = null;
let appClient = null;

export function initialize(client, graph) {
  appClient = client;
  graphClient = graph;
}

export function streamEvents(req, res) {
  if (!graphClient) return res.status(503).json({ success: false, error: 'Graph client not configured' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const filter = typeof req.query?.node === 'string' && req.query.node ? req.query.node : null;
  const filterId = filter && normalizeUUID(filter);
  const matchesFilter = (event) => !filter ||
    event.node_id === filterId || event.node_name === filter || event.node_path === filter;

  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const status = () => send('status', {
    graph_ready: graphClient.isReady(),
    app_connected: appClient ? appClient.isConnected() : false,
    graph_error: graphClient.lastError || null,
  });

  const onPin = (event) => { if (matchesFilter(event)) send('pin', event); };
  const onGraph = (event) => send('graph', { reason: event?.reason || 'event' });
  const subscriptions = [
    [graphClient, 'pinValue', onPin],
    [graphClient, 'graphChanged', onGraph],
    [graphClient, 'connected', status],
    [graphClient, 'disconnected', status],
    ...(appClient?.on ? [[appClient, 'connected', status], [appClient, 'disconnected', status]] : []),
  ];
  for (const [emitter, name, listener] of subscriptions) emitter.on(name, listener);

  res.write(`retry: 3000\n\n`);
  status();
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  res.on('close', () => {
    clearInterval(heartbeat);
    for (const [emitter, name, listener] of subscriptions) emitter.off(name, listener);
  });
}

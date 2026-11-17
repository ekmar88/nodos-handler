/**
 * Nodos Backend — entry point.
 *
 * Starts the HTTP API immediately and keeps the Nodos connections alive in
 * the background (automatic reconnection with backoff), so the API reports
 * 503 while Nodos is down and recovers on its own when it comes back.
 */
import config from '../config/default.js';
import logger from './lib/logger.js';
import { NodosClient } from './lib/nodos-client.js';
import { NodosGraphClient } from './lib/nodos-graph-client.js';
import { keepConnected } from './lib/reconnect.js';
import { createApp } from './create-app.js';

const log = logger.child('server');
const { nodos, server } = config;

const graphClient = new NodosGraphClient({ host: nodos.host, port: nodos.editorPort, appName: nodos.appName });
const appClient = nodos.appServiceEnabled
  ? new NodosClient({ host: nodos.host, port: nodos.port, appKey: nodos.appKey, appName: nodos.appName })
  : null;

const reconnect = { minDelay: nodos.reconnectMinMs, maxDelay: nodos.reconnectMaxMs };
const keepers = [keepConnected(graphClient, { name: `EditorService ${nodos.host}:${nodos.editorPort}`, ...reconnect })];
if (appClient) keepers.push(keepConnected(appClient, { name: `AppService ${nodos.host}:${nodos.port}`, ...reconnect }));
graphClient.startResync(nodos.resyncMs);

const app = createApp({ appClient, graphClient });
const httpServer = app.listen(server.port, server.host, () => {
  const base = `http://${server.host === '0.0.0.0' ? 'localhost' : server.host}:${server.port}`;
  log.info(`Listening on ${base} (read mode: ${nodos.readMode}, resync: ${nodos.resyncMs || 'off'} ms)`);
  log.info(`Panel: ${base}/panel/   API: ${base}/api/nodes   Events: ${base}/api/events`);
  if (server.host !== '127.0.0.1' && server.host !== 'localhost' && !server.apiKey) {
    log.warn('API is reachable from other machines without API_KEY; anyone on the network can change pins.');
  }
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  for (const keeper of keepers) keeper.stop();
  graphClient.close();
  appClient?.disconnect();
  httpServer.close(() => process.exit(0));
  // SSE connections stay open; do not wait for them forever.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;

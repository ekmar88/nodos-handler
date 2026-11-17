import { fileURLToPath } from 'node:url';

// Load the optional local file without overriding existing environment variables.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Configuration; every value can be overridden with environment variables (see .env.example). */
export default {
  nodos: {
    host: process.env.NODOS_HOST || '127.0.0.1',
    // AppService (process integration). Override in Nodos with:
    // nosLauncher --override-settings connection_settings/app_service_address="0.0.0.0:PORT"
    port: int(process.env.NODOS_PORT, 50053),
    // EditorService (graph discovery and pin writes).
    editorPort: int(process.env.NODOS_EDITOR_PORT, 50052),
    appKey: process.env.NODOS_APP_KEY || 'nodos-backend-app',
    appName: process.env.NODOS_APP_NAME || 'Nodos Backend Controller',
    // Connect to AppService too (only needed for POST /dirty).
    appServiceEnabled: process.env.NODOS_APP_SERVICE !== 'false',
    // 'cache': serve reads from the live stream; 'fresh': new snapshot per read.
    readMode: process.env.NODOS_READ_MODE === 'fresh' ? 'fresh' : 'cache',
    // Background full resync interval in ms (0 disables).
    resyncMs: int(process.env.NODOS_RESYNC_MS, 10000),
    reconnectMinMs: int(process.env.NODOS_RECONNECT_MIN_MS, 1000),
    reconnectMaxMs: int(process.env.NODOS_RECONNECT_MAX_MS, 30000),
  },

  server: {
    port: int(process.env.PORT, 3000),
    host: process.env.HOST || '127.0.0.1',
    // Optional shared secret: clients send X-API-Key (or ?api_key= for EventSource).
    apiKey: process.env.API_KEY || '',
    corsOrigin: process.env.CORS_ORIGIN || '*',
    bodyLimit: process.env.BODY_LIMIT || '1mb',
  },
};

import { fileURLToPath } from 'node:url';

// Load the optional local file without overriding existing environment variables.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

/**
 * Nodos configuration
 * Adjust these values to match your Nodos installation
 */
export default {
  // Nodos App service gRPC address
  // Default: 0.0.0.0:50053
  // Override with: nosLauncher --override-settings connection_settings/app_service_address="0.0.0.0:YOUR_PORT"
  nodos: {
    host: process.env.NODOS_HOST || '127.0.0.1',
    port: parseInt(process.env.NODOS_PORT, 10) || 50053,
    editorPort: parseInt(process.env.NODOS_EDITOR_PORT, 10) || 50052,
    appKey: process.env.NODOS_APP_KEY || 'nodos-backend-app',
    appName: process.env.NODOS_APP_NAME || 'Nodos Backend Controller',
  },

  // Express server settings
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || '127.0.0.1',
  },
};

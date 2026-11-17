import logger from './logger.js';

/**
 * Keep a stream client connected: retry failed connections with exponential
 * backoff and reconnect after the client emits 'disconnected'.
 * The client must expose connect(): Promise and EventEmitter on/off.
 */
export function keepConnected(client, { name = 'client', minDelay = 1000, maxDelay = 30000, log = logger.child(name) } = {}) {
  let delay = minDelay;
  let timer = null;
  let stopped = false;
  let failures = 0;
  let attempting = false;

  const attempt = async () => {
    timer = null;
    if (stopped || attempting) return;
    attempting = true;
    try {
      await client.connect();
      if (stopped) return;
      if (failures) log.info(`Reconnected after ${failures} failed attempt(s)`);
      else log.info('Connected');
      failures = 0;
      delay = minDelay;
    } catch (error) {
      if (stopped) return;
      failures++;
      // Warn once per outage; repeat attempts are debug-level noise.
      (failures === 1 ? log.warn : log.debug)(`${error.message}; retrying in ${(delay / 1000).toFixed(1)}s`);
      schedule();
    } finally {
      attempting = false;
    }
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(attempt, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, maxDelay);
  };

  const onDisconnected = ({ error } = {}) => {
    if (stopped) return;
    log.warn(`Connection lost${error ? `: ${error}` : ''}; reconnecting`);
    delay = minDelay;
    schedule();
  };

  client.on('disconnected', onDisconnected);
  const ready = attempt();

  return {
    ready,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      client.off('disconnected', onDisconnected);
    },
  };
}

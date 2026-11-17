/** Minimal leveled logger. Set LOG_LEVEL=debug|info|warn|error|silent. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const defaultLevel = process.env.NODE_TEST_CONTEXT ? 'warn' : 'info';
const threshold = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS[defaultLevel];

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}${scope ? ` [${scope}]` : ''}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(prefix, ...args);
}

function create(scope) {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    child: (name) => create(scope ? `${scope}:${name}` : name),
  };
}

export default create('');

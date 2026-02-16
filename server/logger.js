const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) {
      return { level: label };
    }
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

// Redirect console methods to pino so all existing console.log/error/warn
// calls produce structured JSON output without needing individual rewrites.
// Each method formats its arguments into a single message string.
function formatArgs(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
}

console.log = (...args) => logger.info(formatArgs(args));
console.error = (...args) => logger.error(formatArgs(args));
console.warn = (...args) => logger.warn(formatArgs(args));
console.info = (...args) => logger.info(formatArgs(args));
console.debug = (...args) => logger.debug(formatArgs(args));

module.exports = logger;

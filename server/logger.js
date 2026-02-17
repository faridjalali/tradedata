import pino from 'pino';

/** @type {import('pino').Logger} */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Redirect console methods to pino so all existing console.log/error/warn
// calls produce structured JSON output without needing individual rewrites.
// Each method formats its arguments into a single message string.
/** @param {any[]} args */
function formatArgs(args) {
  return args
    .map((/** @type {any} */ a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
}

// @ts-ignore
console.log = (/** @type {any[]} */ ...args) => logger.info(formatArgs(args));
// @ts-ignore
console.error = (/** @type {any[]} */ ...args) => logger.error(formatArgs(args));
// @ts-ignore
console.warn = (/** @type {any[]} */ ...args) => logger.warn(formatArgs(args));
// @ts-ignore
console.info = (/** @type {any[]} */ ...args) => logger.info(formatArgs(args));
// @ts-ignore
console.debug = (/** @type {any[]} */ ...args) => logger.debug(formatArgs(args));

export default logger;

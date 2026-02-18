import pino from 'pino';

const logger: pino.Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Redirect console methods to pino so all existing console.log/error/warn
// calls produce structured JSON output without needing individual rewrites.
// Each method formats its arguments into a single message string.
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
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

console.log = (...args: unknown[]) => logger.info(formatArgs(args));
console.error = (...args: unknown[]) => logger.error(formatArgs(args));
console.warn = (...args: unknown[]) => logger.warn(formatArgs(args));
console.info = (...args: unknown[]) => logger.info(formatArgs(args));
console.debug = (...args: unknown[]) => logger.debug(formatArgs(args));

export default logger;

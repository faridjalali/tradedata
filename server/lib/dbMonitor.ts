/**
 * Database query monitoring — wraps pg Pool.query() with timing
 * and logs slow queries via console.warn (captured by Pino as structured JSON).
 */

const SLOW_QUERY_THRESHOLD_MS = Math.max(0, Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 500);

/**
 * Extract a loggable SQL snippet from pool.query() arguments.
 * @param {any[]} args - Arguments passed to pool.query()
 * @returns {string}
 */
function extractSql(args) {
  const first = args[0];
  const raw = typeof first === 'string' ? first : first?.text || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Instrument a pg Pool's .query() method with timing and slow-query logging.
 * Mutates the pool in place (replaces .query) and returns it for chaining.
 *
 * @param {import('pg').Pool} pool
 * @param {string} poolName - Label for log output (e.g. 'primary', 'divergence')
 * @returns {import('pg').Pool}
 */
export function instrumentPool(pool, poolName = 'primary') {
  if (!pool || typeof pool.query !== 'function') return pool;

  const originalQuery = pool.query.bind(pool);

  /** @param {...any} args */
  pool.query = async function monitoredQuery(...args) {
    const start = performance.now();
    try {
      const result = await /** @type {any} */ (originalQuery)(...args);
      const durationMs = performance.now() - start;
      if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
        /** @type {any} */ (console).warn(
          `[slow-query] pool=${poolName} duration=${Math.round(durationMs)}ms sql=${extractSql(args)}`,
        );
      }
      return result;
    } catch (err) {
      const e = /** @type {any} */ (err);
      const durationMs = performance.now() - start;
      /** @type {any} */ (console).error(
        `[query-error] pool=${poolName} duration=${Math.round(durationMs)}ms sql=${extractSql(args)} error=${e && e.message ? e.message : e}`,
      );
      throw err;
    }
  };

  return pool;
}

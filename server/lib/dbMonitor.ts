/**
 * Database query monitoring — wraps pg Pool.query() with timing
 * and logs slow queries via console.warn (captured by Pino as structured JSON).
 */

import type { Pool } from 'pg';

const SLOW_QUERY_THRESHOLD_MS = Math.max(0, Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 500);

function extractSql(args: unknown[]): string {
  const first = args[0];
  const raw = typeof first === 'string' ? first : (first as Record<string, unknown>)?.text || '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function instrumentPool(pool: Pool, poolName = 'primary'): Pool {
  if (!pool || typeof pool.query !== 'function') return pool;

  const originalQuery = pool.query.bind(pool);

  // pg's Pool.query is not redefinable through the public interface; monkey-patching is the
  // standard approach for transparent query instrumentation without a proxy layer.
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
    async function monitoredQuery(...args: unknown[]) {
    const start = performance.now();
    try {
      const result = await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
      const durationMs = performance.now() - start;
      if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
        console.warn(
          `[slow-query] pool=${poolName} duration=${Math.round(durationMs)}ms sql=${extractSql(args)}`,
        );
      }
      return result;
    } catch (err: unknown) {
      const durationMs = performance.now() - start;
      console.error(
        `[query-error] pool=${poolName} duration=${Math.round(durationMs)}ms sql=${extractSql(args)} error=${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  };

  return pool;
}

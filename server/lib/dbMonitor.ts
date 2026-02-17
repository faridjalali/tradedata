/**
 * Database query monitoring — wraps pg Pool.query() with timing
 * and logs slow queries via console.warn (captured by Pino as structured JSON).
 */

import type { Pool } from 'pg';

const SLOW_QUERY_THRESHOLD_MS = Math.max(0, Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 500);

function extractSql(args: any[]): string {
  const first = args[0];
  const raw = typeof first === 'string' ? first : first?.text || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function instrumentPool(pool: Pool, poolName = 'primary'): Pool {
  if (!pool || typeof pool.query !== 'function') return pool;

  const originalQuery = pool.query.bind(pool);

  (pool as any).query = async function monitoredQuery(...args: any[]) {
    const start = performance.now();
    try {
      const result = await (originalQuery as any)(...args);
      const durationMs = performance.now() - start;
      if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
        console.warn(
          `[slow-query] pool=${poolName} duration=${Math.round(durationMs)}ms sql=${extractSql(args)}`,
        );
      }
      return result;
    } catch (err: any) {
      const durationMs = performance.now() - start;
      console.error(
        `[query-error] pool=${poolName} duration=${Math.round(durationMs)}ms sql=${extractSql(args)} error=${err && err.message ? err.message : err}`,
      );
      throw err;
    }
  };

  return pool;
}

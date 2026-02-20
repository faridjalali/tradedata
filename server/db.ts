import { Pool, PoolClient } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { instrumentPool } from './lib/dbMonitor.js';
import type { Database } from './db/types.js';
import { IS_PRODUCTION } from './config.js';

const dbSslRejectUnauthorized =
  String(process.env.DB_SSL_REJECT_UNAUTHORIZED || (IS_PRODUCTION ? 'true' : 'false')).toLowerCase() !== 'false';

/**
 * Single-DB mode:
 * - The app now uses ONLY DIVERGENCE_DATABASE_URL.
 * - Legacy exports (`pool`, `db`) are retained as aliases to avoid sweeping
 *   import churn while guaranteeing all access goes to the divergence DB.
 */
const divergenceDatabaseUrl = String(process.env.DIVERGENCE_DATABASE_URL || '').trim();
const sharedPool = divergenceDatabaseUrl
  ? new Pool({
      connectionString: divergenceDatabaseUrl,
      ssl: { rejectUnauthorized: dbSslRejectUnauthorized },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      statement_timeout: 30000,
    })
  : null;

if (sharedPool) {
  sharedPool.on('error', (err) => {
    console.error('Unexpected idle divergence pool client error:', err instanceof Error ? err.message : String(err));
  });
  instrumentPool(sharedPool, 'divergence');
}

export const divergencePool = sharedPool;
export const divergenceDb = sharedPool
  ? new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: sharedPool,
      }),
    })
  : null;

// Backward-compatible aliases: these no longer point to a primary DB.
export const pool = sharedPool as unknown as Pool;
export const db = divergenceDb as unknown as Kysely<Database>;

export function isDivergenceConfigured() {
  return Boolean(divergencePool);
}

export async function withDivergenceClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!divergencePool) {
    throw new Error('DIVERGENCE_DATABASE_URL is not configured');
  }
  const client = await divergencePool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

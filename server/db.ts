import { Pool, PoolClient } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { instrumentPool } from './lib/dbMonitor.js';
import type { Database } from './db/types.js';

const dbSslRejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() !== 'false';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: dbSslRejectUnauthorized },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 30000,
});
pool.on('error', (err) => {
  console.error('Unexpected idle pool client error:', err instanceof Error ? err.message : String(err));
});

const divergenceDatabaseUrl = process.env.DIVERGENCE_DATABASE_URL || '';
export const divergencePool = divergenceDatabaseUrl
  ? new Pool({
      connectionString: divergenceDatabaseUrl,
      ssl: { rejectUnauthorized: dbSslRejectUnauthorized },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      statement_timeout: 30000,
    })
  : null;

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool,
  }),
});

export const divergenceDb = divergencePool
  ? new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: divergencePool,
      }),
    })
  : null;
if (divergencePool) {
  divergencePool.on('error', (err) => {
    console.error('Unexpected idle divergence pool client error:', err instanceof Error ? err.message : String(err));
  });
}
instrumentPool(pool, 'primary');
if (divergencePool) instrumentPool(divergencePool, 'divergence');

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

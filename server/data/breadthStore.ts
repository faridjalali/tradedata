/**
 * Database operations for breadth MA metrics.
 * Tables: breadth_daily_closes, breadth_snapshots
 */

import type { Pool } from 'pg';
import type { BreadthMASnapshot, BreadthMAHistory } from '../../shared/api-types.js';

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

export async function initBreadthTables(dbPool: Pool): Promise<void> {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS breadth_daily_closes (
      ticker VARCHAR(20) NOT NULL,
      trade_date DATE NOT NULL,
      close DECIMAL(15, 4) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ticker, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_bdc_trade_date ON breadth_daily_closes (trade_date);

    CREATE TABLE IF NOT EXISTS breadth_snapshots (
      trade_date DATE NOT NULL,
      index_name VARCHAR(10) NOT NULL,
      pct_above_ma21 DECIMAL(5, 2) NOT NULL,
      pct_above_ma50 DECIMAL(5, 2) NOT NULL,
      pct_above_ma100 DECIMAL(5, 2) NOT NULL,
      pct_above_ma200 DECIMAL(5, 2) NOT NULL,
      total_constituents INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (trade_date, index_name)
    );
    CREATE INDEX IF NOT EXISTS idx_bs_index_date ON breadth_snapshots (index_name, trade_date DESC);
  `);
}

// ---------------------------------------------------------------------------
// Daily closes
// ---------------------------------------------------------------------------

/**
 * Bulk upsert daily closes for a single trade date using UNNEST.
 */
export async function upsertDailyCloses(
  dbPool: Pool,
  tradeDate: string,
  closes: Map<string, number>,
): Promise<void> {
  if (closes.size === 0) return;
  const tickers: string[] = [];
  const prices: number[] = [];
  for (const [ticker, close] of closes) {
    tickers.push(ticker);
    prices.push(close);
  }
  await dbPool.query(
    `INSERT INTO breadth_daily_closes (ticker, trade_date, close, updated_at)
     SELECT t, $1::date, c, NOW()
     FROM UNNEST($2::text[], $3::numeric[]) AS x(t, c)
     ON CONFLICT (ticker, trade_date)
     DO UPDATE SET close = EXCLUDED.close, updated_at = NOW()`,
    [tradeDate, tickers, prices],
  );
}

/**
 * Get last N closes per ticker (ordered most recent first → reversed to chronological).
 * Returns Map<ticker, number[]> where array is chronological (oldest first).
 */
export async function getClosesForTickers(
  dbPool: Pool,
  tickers: string[],
  limit: number,
  beforeDate?: string,
): Promise<Map<string, number[]>> {
  if (tickers.length === 0) return new Map();
  let query: string;
  let params: any[];
  if (beforeDate) {
    query = `SELECT ticker, array_agg(close::float ORDER BY trade_date ASC) AS closes
     FROM (
       SELECT ticker, trade_date, close
       FROM breadth_daily_closes
       WHERE ticker = ANY($1) AND trade_date <= $3::date
       ORDER BY trade_date DESC
       LIMIT $2 * array_length($1, 1)
     ) sub
     GROUP BY ticker`;
    params = [tickers, limit, beforeDate];
  } else {
    query = `SELECT ticker, array_agg(close::float ORDER BY trade_date ASC) AS closes
     FROM (
       SELECT ticker, trade_date, close
       FROM breadth_daily_closes
       WHERE ticker = ANY($1)
       ORDER BY trade_date DESC
       LIMIT $2 * array_length($1, 1)
     ) sub
     GROUP BY ticker`;
    params = [tickers, limit];
  }
  const { rows } = await dbPool.query(query, params);
  const result = new Map<string, number[]>();
  for (const row of rows) {
    result.set(row.ticker, row.closes);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function upsertBreadthSnapshot(
  dbPool: Pool,
  tradeDate: string,
  indexName: string,
  ma21: number,
  ma50: number,
  ma100: number,
  ma200: number,
  total: number,
): Promise<void> {
  await dbPool.query(
    `INSERT INTO breadth_snapshots (trade_date, index_name, pct_above_ma21, pct_above_ma50, pct_above_ma100, pct_above_ma200, total_constituents, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (trade_date, index_name)
     DO UPDATE SET pct_above_ma21 = $3, pct_above_ma50 = $4, pct_above_ma100 = $5, pct_above_ma200 = $6, total_constituents = $7, updated_at = NOW()`,
    [tradeDate, indexName, ma21, ma50, ma100, ma200, total],
  );
}

export async function getLatestBreadthSnapshots(dbPool: Pool): Promise<BreadthMASnapshot[]> {
  const { rows } = await dbPool.query(`
    SELECT DISTINCT ON (index_name)
      index_name, trade_date::text AS date,
      pct_above_ma21::float AS ma21, pct_above_ma50::float AS ma50,
      pct_above_ma100::float AS ma100, pct_above_ma200::float AS ma200,
      total_constituents AS total
    FROM breadth_snapshots
    ORDER BY index_name, trade_date DESC
  `);
  return rows.map((r) => ({
    index: r.index_name,
    date: r.date,
    ma21: r.ma21,
    ma50: r.ma50,
    ma100: r.ma100,
    ma200: r.ma200,
    total: r.total,
  }));
}

export async function getBreadthHistory(
  dbPool: Pool,
  indexName: string,
  days: number,
): Promise<BreadthMAHistory[]> {
  const { rows } = await dbPool.query(
    `SELECT date, ma21, ma50, ma100, ma200 FROM (
       SELECT trade_date::text AS date,
              pct_above_ma21::float AS ma21, pct_above_ma50::float AS ma50,
              pct_above_ma100::float AS ma100, pct_above_ma200::float AS ma200
       FROM breadth_snapshots
       WHERE index_name = $1
       ORDER BY trade_date DESC
       LIMIT $2
     ) sub
     ORDER BY date ASC`,
    [indexName, days],
  );
  return rows;
}

/**
 * Check whether the 200-day MA breadth history is valid for `checkDays` recent snapshots.
 * Returns true if all checked rows have pct_above_ma200 > 0 (i.e., the data is usable).
 */
export async function isBreadthMa200Valid(
  dbPool: Pool,
  indexName: string = 'SPY',
  checkDays: number = 30,
): Promise<boolean> {
  const { rows } = await dbPool.query(
    `SELECT COUNT(*) AS zero_count
     FROM (
       SELECT pct_above_ma200
       FROM breadth_snapshots
       WHERE index_name = $1
       ORDER BY trade_date DESC
       LIMIT $2
     ) sub
     WHERE pct_above_ma200 = 0`,
    [indexName, checkDays],
  );
  return Number(rows[0]?.zero_count ?? 1) === 0;
}

/**
 * Delete closes older than `keepDays` trading days.
 */
export async function cleanupOldCloses(dbPool: Pool, keepDays: number): Promise<number> {
  const { rowCount } = await dbPool.query(
    `DELETE FROM breadth_daily_closes
     WHERE trade_date < (
       SELECT trade_date FROM (
         SELECT DISTINCT trade_date FROM breadth_daily_closes
         ORDER BY trade_date DESC
         LIMIT $1
       ) sub
       ORDER BY trade_date ASC
       LIMIT 1
     )`,
    [keepDays],
  );
  return rowCount ?? 0;
}

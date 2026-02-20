/**
 * Database operations for breadth MA metrics.
 * Tables: breadth_daily_closes, breadth_snapshots
 */

import { sql } from 'kysely';
import { db } from '../db.js';
import type { BreadthMASnapshot, BreadthMAHistory } from '../../shared/api-types.js';
import { ALL_BREADTH_INDICES } from './etfConstituents.js';

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

export async function initBreadthTables(): Promise<void> {
  await sql`
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
  `.execute(db);
}

// ---------------------------------------------------------------------------
// Daily closes
// ---------------------------------------------------------------------------

/**
 * Bulk upsert daily closes for a single trade date using UNNEST.
 */
export async function upsertDailyCloses(tradeDate: string, closes: Map<string, number>): Promise<void> {
  if (closes.size === 0) return;
  const values = Array.from(closes.entries()).map(([ticker, close]) => ({
    ticker,
    trade_date: tradeDate,
    close,
  }));

  await db
    .insertInto('breadth_daily_closes')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['ticker', 'trade_date']).doUpdateSet((eb) => ({
        close: eb.ref('excluded.close'),
        updated_at: sql`NOW()`,
      })),
    )
    .execute();
}

/**
 * Get last N closes per ticker (ordered most recent first → reversed to chronological).
 * Returns Map<ticker, number[]> where array is chronological (oldest first).
 */
export async function getClosesForTickers(
  tickers: string[],
  limit: number,
  beforeDate?: string,
): Promise<Map<string, number[]>> {
  if (tickers.length === 0) return new Map();

  let baseQuery = db
    .selectFrom('breadth_daily_closes')
    .select(['ticker', 'trade_date', 'close'])
    .where('ticker', 'in', tickers)
    .orderBy('trade_date', 'desc')
    .limit(limit * tickers.length);

  if (beforeDate) {
    baseQuery = baseQuery.where('trade_date', '<=', beforeDate);
  }

  const { rows } = await sql<{ ticker: string; closes: number[] }>`
    SELECT ticker, array_agg(close::float ORDER BY trade_date ASC) AS closes
    FROM (${baseQuery}) sub
    GROUP BY ticker
  `.execute(db);

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
  tradeDate: string,
  indexName: string,
  ma21: number,
  ma50: number,
  ma100: number,
  ma200: number,
  total: number,
): Promise<void> {
  await db
    .insertInto('breadth_snapshots')
    .values({
      trade_date: tradeDate,
      index_name: indexName,
      pct_above_ma21: ma21,
      pct_above_ma50: ma50,
      pct_above_ma100: ma100,
      pct_above_ma200: ma200,
      total_constituents: total,
    })
    .onConflict((oc) =>
      oc.columns(['trade_date', 'index_name']).doUpdateSet((eb) => ({
        pct_above_ma21: eb.ref('excluded.pct_above_ma21'),
        pct_above_ma50: eb.ref('excluded.pct_above_ma50'),
        pct_above_ma100: eb.ref('excluded.pct_above_ma100'),
        pct_above_ma200: eb.ref('excluded.pct_above_ma200'),
        total_constituents: eb.ref('excluded.total_constituents'),
        updated_at: sql`NOW()`,
      })),
    )
    .execute();
}

export async function getLatestBreadthSnapshots(): Promise<BreadthMASnapshot[]> {
  const indices = ALL_BREADTH_INDICES as string[];
  const { rows } = await sql<{
    index_name: string;
    date: string;
    ma21: number;
    ma50: number;
    ma100: number;
    ma200: number;
    total: number;
  }>`
    SELECT DISTINCT ON (index_name)
      index_name, trade_date::text AS date,
      pct_above_ma21::float AS ma21, pct_above_ma50::float AS ma50,
      pct_above_ma100::float AS ma100, pct_above_ma200::float AS ma200,
      total_constituents AS total
    FROM breadth_snapshots
    WHERE index_name IN (${sql.join(indices)})
    ORDER BY index_name, trade_date DESC
  `.execute(db);

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

export async function getBreadthHistory(indexName: string, days: number): Promise<BreadthMAHistory[]> {
  const innerQuery = db
    .selectFrom('breadth_snapshots')
    .select([
      sql<string>`trade_date::text`.as('date'),
      sql<number>`pct_above_ma21::float`.as('ma21'),
      sql<number>`pct_above_ma50::float`.as('ma50'),
      sql<number>`pct_above_ma100::float`.as('ma100'),
      sql<number>`pct_above_ma200::float`.as('ma200'),
    ])
    .where('index_name', '=', indexName)
    .orderBy('trade_date', 'desc')
    .limit(days);

  const rows = await db.selectFrom(innerQuery.as('sub')).selectAll().orderBy('date', 'asc').execute();

  return rows as BreadthMAHistory[];
}

/**
 * Check whether the 200-day MA breadth history is valid for `checkDays` recent snapshots.
 * Returns true if all checked rows have pct_above_ma200 > 0 (i.e., the data is usable).
 */
export async function isBreadthMa200Valid(indexName: string = 'SPY', checkDays: number = 30): Promise<boolean> {
  const innerQuery = db
    .selectFrom('breadth_snapshots')
    .select('pct_above_ma200')
    .where('index_name', '=', indexName)
    .orderBy('trade_date', 'desc')
    .limit(checkDays);

  const rows = await db
    .selectFrom(innerQuery.as('sub'))
    .select((eb) => eb.fn.countAll().as('zero_count'))
    .where('pct_above_ma200', '=', 0)
    .execute();

  return Number(rows[0]?.zero_count ?? 1) === 0;
}

/**
 * Delete closes older than `keepDays` trading days.
 */
export async function cleanupOldCloses(keepDays: number): Promise<number> {
  const dateSubquery = db
    .selectFrom(
      db
        .selectFrom('breadth_daily_closes')
        .select('trade_date')
        .distinct()
        .orderBy('trade_date', 'desc')
        .limit(keepDays)
        .as('sub'),
    )
    .select('trade_date')
    .orderBy('trade_date', 'asc')
    .limit(1);

  const result = await db.deleteFrom('breadth_daily_closes').where('trade_date', '<', dateSubquery).executeTakeFirst();

  return Number(result.numDeletedRows ?? 0);
}

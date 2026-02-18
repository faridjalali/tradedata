/**
 * Breadth MA computation service.
 * Calculates % of ETF constituents above their 21/50/100/200-day SMAs
 * using Grouped Daily Bars from the data API.
 */

import type { Pool } from 'pg';
import type { BreadthMAResponse } from '../../shared/api-types.js';
import { fetchGroupedDailyBars, dataApiDaily } from './dataApi.js';
import {
  ALL_BREADTH_TICKERS,
  ALL_BREADTH_INDICES,
  getConstituentsForIndex,
  type BreadthIndex,
} from '../data/etfConstituents.js';
import {
  upsertDailyCloses,
  getClosesForTickers,
  upsertBreadthSnapshot,
  getLatestBreadthSnapshots,
  getBreadthHistory,
  isBreadthMa200Valid,
  cleanupOldCloses,
} from '../data/breadthStore.js';
import * as tradingCalendar from './tradingCalendar.js';

// ---------------------------------------------------------------------------
// Index price cache — avoids 3 dataApiDaily calls on every /api/breadth/ma request
// ---------------------------------------------------------------------------

const INDEX_PRICE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface IndexPriceEntry {
  closeMap: Map<string, number>;
  fetchedAt: number;
}
const indexPriceCache = new Map<string, IndexPriceEntry>();

async function getCachedIndexPrices(ticker: string): Promise<Map<string, number>> {
  const cached = indexPriceCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < INDEX_PRICE_CACHE_TTL_MS) {
    return cached.closeMap;
  }
  const bars = await dataApiDaily(ticker);
  const closeMap = new Map<string, number>();
  if (bars) {
    for (const bar of bars) closeMap.set(bar.date, bar.close);
  }
  indexPriceCache.set(ticker, { closeMap, fetchedAt: Date.now() });
  return closeMap;
}

// ---------------------------------------------------------------------------
// SMA helpers
// ---------------------------------------------------------------------------

function computeSMA(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  const slice = closes.slice(closes.length - window);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / window;
}

const MA_WINDOWS = [21, 50, 100, 200] as const;

interface BreadthPcts {
  ma21: number;
  ma50: number;
  ma100: number;
  ma200: number;
  total: number;
}

/**
 * Given a map of ticker→chronological close array and a constituent list,
 * compute % above each SMA window.
 */
function computeBreadthForIndex(
  allCloses: Map<string, number[]>,
  constituents: string[],
): BreadthPcts {
  const counts = { ma21: 0, ma50: 0, ma100: 0, ma200: 0 };
  const totals = { ma21: 0, ma50: 0, ma100: 0, ma200: 0 };

  for (const ticker of constituents) {
    const closes = allCloses.get(ticker);
    if (!closes || closes.length === 0) continue;
    const latestClose = closes[closes.length - 1];

    for (const w of MA_WINDOWS) {
      const sma = computeSMA(closes, w);
      if (sma !== null) {
        const key = `ma${w}` as keyof typeof counts;
        totals[key]++;
        if (latestClose > sma) counts[key]++;
      }
    }
  }

  return {
    ma21: totals.ma21 > 0 ? Math.round((counts.ma21 / totals.ma21) * 10000) / 100 : 0,
    ma50: totals.ma50 > 0 ? Math.round((counts.ma50 / totals.ma50) * 10000) / 100 : 0,
    ma100: totals.ma100 > 0 ? Math.round((counts.ma100 / totals.ma100) * 10000) / 100 : 0,
    ma200: totals.ma200 > 0 ? Math.round((counts.ma200 / totals.ma200) * 10000) / 100 : 0,
    total: totals.ma200, // use 200 as canonical total (most restrictive)
  };
}

// ---------------------------------------------------------------------------
// Daily computation (runs after market close)
// ---------------------------------------------------------------------------

export async function runBreadthComputation(
  dbPool: Pool,
  tradeDate: string,
): Promise<void> {
  console.log(`[breadth] Computing breadth for ${tradeDate}...`);
  const t0 = Date.now();

  // 1. Fetch grouped bars for the date
  const grouped = await fetchGroupedDailyBars(tradeDate, ALL_BREADTH_TICKERS);
  if (grouped.size === 0) {
    console.log(`[breadth] No grouped bars returned for ${tradeDate}, skipping.`);
    return;
  }
  console.log(`[breadth] Got ${grouped.size} tickers from grouped bars.`);

  // 2. Store closes
  await upsertDailyCloses(dbPool, tradeDate, grouped);

  // 3. Load historical closes for all breadth tickers (need up to 200 days)
  const allTickers = [...ALL_BREADTH_TICKERS];
  const allCloses = await getClosesForTickers(dbPool, allTickers, 200);

  // 4. Compute breadth for each index
  for (const index of ALL_BREADTH_INDICES) {
    const constituents = getConstituentsForIndex(index);
    const pcts = computeBreadthForIndex(allCloses, constituents);
    await upsertBreadthSnapshot(
      dbPool, tradeDate, index,
      pcts.ma21, pcts.ma50, pcts.ma100, pcts.ma200, pcts.total,
    );
    console.log(`[breadth] ${index}: 21MA=${pcts.ma21}% 50MA=${pcts.ma50}% 100MA=${pcts.ma100}% 200MA=${pcts.ma200}% (${pcts.total} tickers)`);
  }

  console.log(`[breadth] Computation done in ${Date.now() - t0}ms.`);
}

// ---------------------------------------------------------------------------
// Bootstrap (backfill history)
// ---------------------------------------------------------------------------

export async function bootstrapBreadthHistory(
  dbPool: Pool,
  numDays: number = 220,
): Promise<{ fetchedDays: number; computedDays: number }> {
  console.log(`[breadth] Bootstrapping ${numDays} days of history...`);
  const t0 = Date.now();

  // Generate list of recent trading dates going backwards
  const tradingDates: string[] = [];
  const today = new Date();
  const cursor = new Date(today);
  for (let attempts = 0; tradingDates.length < numDays && attempts < numDays * 2; attempts++) {
    cursor.setDate(cursor.getDate() - 1);
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    if (tradingCalendar.isTradingDay(dateStr)) {
      tradingDates.push(dateStr);
    }
  }
  tradingDates.reverse(); // chronological

  // Fetch and store daily closes
  let fetchedDays = 0;
  for (const date of tradingDates) {
    try {
      const grouped = await fetchGroupedDailyBars(date, ALL_BREADTH_TICKERS);
      if (grouped.size > 0) {
        await upsertDailyCloses(dbPool, date, grouped);
        fetchedDays++;
      }
      if (fetchedDays % 20 === 0) {
        console.log(`[breadth] Fetched ${fetchedDays}/${tradingDates.length} days...`);
      }
    } catch (err: any) {
      console.error(`[breadth] Failed to fetch grouped bars for ${date}: ${err.message}`);
    }
  }

  // Load set of dates that already have complete, non-zero snapshots for all indices.
  let alreadyComputed = new Set<string>();
  try {
    const { rows: doneRows } = await dbPool.query(
      `SELECT trade_date::text AS d FROM breadth_snapshots
       WHERE pct_above_ma200 > 0
       GROUP BY trade_date
       HAVING COUNT(DISTINCT index_name) >= $1`,
      [ALL_BREADTH_INDICES.length],
    );
    alreadyComputed = new Set(doneRows.map((r: { d: string }) => r.d));
    if (alreadyComputed.size > 0) {
      console.log(`[breadth] Skipping ${alreadyComputed.size} already-computed dates.`);
    }
  } catch (err: any) {
    console.warn(`[breadth] Could not load existing snapshot dates — will recompute all: ${err.message}`);
  }

  // Compute snapshots for dates that have enough history (at least 21 days for shortest SMA)
  let computedDays = 0;
  let skippedDays = 0;
  const allTickers = [...ALL_BREADTH_TICKERS];

  const computeDates = tradingDates.slice(Math.max(0, 20));
  for (const date of computeDates) {
    if (alreadyComputed.has(date)) {
      skippedDays++;
      continue;
    }
    try {
      const allCloses = await getClosesForTickers(dbPool, allTickers, 200, date);
      for (const index of ALL_BREADTH_INDICES) {
        const constituents = getConstituentsForIndex(index);
        const pcts = computeBreadthForIndex(allCloses, constituents);
        await upsertBreadthSnapshot(
          dbPool, date, index,
          pcts.ma21, pcts.ma50, pcts.ma100, pcts.ma200, pcts.total,
        );
      }
      computedDays++;
    } catch (err: any) {
      console.error(`[breadth] Failed to compute breadth for ${date}: ${err.message}`);
    }
  }
  if (skippedDays > 0) console.log(`[breadth] Skipped ${skippedDays} already-complete dates.`);

  console.log(`[breadth] Bootstrap done in ${Math.round((Date.now() - t0) / 1000)}s: fetched=${fetchedDays}, computed=${computedDays}`);
  return { fetchedDays, computedDays };
}

// ---------------------------------------------------------------------------
// API query
// ---------------------------------------------------------------------------

export async function getLatestBreadthData(
  dbPool: Pool,
  historyDays: number = 60,
): Promise<BreadthMAResponse> {
  const snapshots = await getLatestBreadthSnapshots(dbPool);

  // Fetch index ETF prices in parallel (cached up to 1 hour) for the normalized comparison chart
  const indexTickers = ALL_BREADTH_INDICES as string[];
  const priceResults = await Promise.allSettled(indexTickers.map((t) => getCachedIndexPrices(t)));
  const priceByIndex: Record<string, Map<string, number>> = {};
  for (let i = 0; i < indexTickers.length; i++) {
    const r = priceResults[i];
    priceByIndex[indexTickers[i]] = r.status === 'fulfilled' ? r.value : new Map();
  }

  const history: Record<string, any[]> = {};
  for (const index of ALL_BREADTH_INDICES) {
    const raw = await getBreadthHistory(dbPool, index, historyDays);
    const closeMap = priceByIndex[index];
    history[index] = raw.map((h) => ({
      ...h,
      close: closeMap.get(h.date),
    }));
  }
  return { snapshots, history };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanupBreadthData(dbPool: Pool): Promise<void> {
  const deleted = await cleanupOldCloses(dbPool, 250);
  if (deleted > 0) {
    console.log(`[breadth] Cleaned up ${deleted} old close rows.`);
  }
}

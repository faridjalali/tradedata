/**
 * Breadth MA computation service.
 * Calculates % of ETF constituents above their 21/50/100/200-day SMAs
 * using Grouped Daily Bars from the data API.
 */

import { db } from '../db.js';
import { sql } from 'kysely';
import type { BreadthMAResponse } from '../../shared/api-types.js';
import { fetchGroupedDailyBars, dataApiDaily } from './dataApi.js';
import { ALL_BREADTH_INDICES, getAllBreadthTickers, getConstituentsForIndex } from '../data/etfConstituents.js';
import {
  upsertDailyCloses,
  getClosesForTickers,
  upsertBreadthSnapshot,
  getLatestBreadthSnapshots,
  getBreadthHistory,
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

export function clearBreadthIndexPriceCache(): number {
  const count = indexPriceCache.size;
  indexPriceCache.clear();
  return count;
}

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
function computeBreadthForIndex(allCloses: Map<string, number[]>, constituents: string[]): BreadthPcts {
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

export async function runBreadthComputation(tradeDate: string): Promise<void> {
  console.log(`[breadth] Computing breadth for ${tradeDate}...`);
  const t0 = Date.now();

  // 1. Fetch grouped bars for the date
  const grouped = await fetchGroupedDailyBars(tradeDate, getAllBreadthTickers());
  if (grouped.size === 0) {
    console.log(`[breadth] No grouped bars returned for ${tradeDate}, skipping.`);
    return;
  }
  console.log(`[breadth] Got ${grouped.size} tickers from grouped bars.`);

  // 2. Store closes
  await upsertDailyCloses(tradeDate, grouped);

  // 3. Load historical closes for all breadth tickers (need up to 200 days)
  const allTickers = [...getAllBreadthTickers()];
  const allCloses = await getClosesForTickers(allTickers, 200);

  // 4. Compute breadth for each index
  for (const index of ALL_BREADTH_INDICES) {
    const constituents = getConstituentsForIndex(index);
    const pcts = computeBreadthForIndex(allCloses, constituents);
    await upsertBreadthSnapshot(tradeDate, index, pcts.ma21, pcts.ma50, pcts.ma100, pcts.ma200, pcts.total);
    console.log(
      `[breadth] ${index}: 21MA=${pcts.ma21}% 50MA=${pcts.ma50}% 100MA=${pcts.ma100}% 200MA=${pcts.ma200}% (${pcts.total} tickers)`,
    );
  }

  console.log(`[breadth] Computation done in ${Date.now() - t0}ms.`);
}

// ---------------------------------------------------------------------------
// Bootstrap (backfill history)
// ---------------------------------------------------------------------------

export async function bootstrapBreadthHistory(
  numDays: number = 220,
  onProgress?: (msg: string) => void,
  shouldStop?: () => boolean,
): Promise<{ fetchedDays: number; computedDays: number }> {
  // Fetch extra history so the 200-day SMA is valid even for the earliest snapshot dates.
  // Without this buffer, early dates would have <200 closes and 200 MA would be 0.
  const MA200_BUFFER = 200;
  const totalFetchDays = numDays + MA200_BUFFER;
  console.log(
    `[breadth] Bootstrapping ${numDays} days of history (fetching ${totalFetchDays} days of closes for 200 MA buffer)...`,
  );
  const t0 = Date.now();

  // Generate list of recent trading dates going backwards
  const tradingDates: string[] = [];
  const today = new Date();
  const cursor = new Date(today);
  for (let attempts = 0; tradingDates.length < totalFetchDays && attempts < totalFetchDays * 2; attempts++) {
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

  // Fetch and store daily closes for the full range (buffer + snapshot dates)
  let fetchedDays = 0;
  for (const date of tradingDates) {
    if (shouldStop?.()) {
      console.log(`[breadth] Stop requested during fetch phase at ${fetchedDays}/${totalFetchDays}`);
      onProgress?.(`Stopped at fetch ${fetchedDays}/${totalFetchDays}`);
      break;
    }
    try {
      const grouped = await fetchGroupedDailyBars(date, getAllBreadthTickers());
      if (grouped.size > 0) {
        await upsertDailyCloses(date, grouped);
        fetchedDays++;
      }
      if (fetchedDays % 20 === 0) {
        const msg = `Fetching closes: ${fetchedDays}/${totalFetchDays}`;
        console.log(`[breadth] ${msg}`);
        onProgress?.(msg);
      }
    } catch (err: unknown) {
      console.error(
        `[breadth] Failed to fetch grouped bars for ${date}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Only compute snapshots for the most recent numDays (the buffer is just for SMA lookback)
  const snapshotDates = tradingDates.slice(MA200_BUFFER);

  // Load set of dates that already have complete, non-zero snapshots for all indices.
  let alreadyComputed = new Set<string>();
  try {
    const rows = await db
      .selectFrom('breadth_snapshots')
      .select((eb) => [
        sql<string>`trade_date::text`.as('d'),
        eb.fn.count<number>('index_name').distinct().as('idx_count'),
      ])
      .where('pct_above_ma200', '>', 0)
      .groupBy('trade_date')
      .having((eb) => eb.fn.count('index_name').distinct(), '>=', ALL_BREADTH_INDICES.length)
      .execute();

    alreadyComputed = new Set(rows.map((r) => r.d));
    if (alreadyComputed.size > 0) {
      console.log(`[breadth] Skipping ${alreadyComputed.size} already-computed dates.`);
    }
  } catch (err: unknown) {
    console.warn(
      `[breadth] Could not load existing snapshot dates — will recompute all: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Compute snapshots — each date now has ≥200 prior closes in the DB for 200 MA
  let computedDays = 0;
  let skippedDays = 0;
  const allTickers = [...getAllBreadthTickers()];

  for (const date of snapshotDates) {
    if (shouldStop?.()) {
      console.log(`[breadth] Stop requested during compute phase at ${computedDays} snapshots`);
      onProgress?.(`Stopped at compute ${computedDays}`);
      break;
    }
    if (alreadyComputed.has(date)) {
      skippedDays++;
      continue;
    }
    try {
      const allCloses = await getClosesForTickers(allTickers, 200, date);
      for (const index of ALL_BREADTH_INDICES) {
        const constituents = getConstituentsForIndex(index);
        const pcts = computeBreadthForIndex(allCloses, constituents);
        await upsertBreadthSnapshot(date, index, pcts.ma21, pcts.ma50, pcts.ma100, pcts.ma200, pcts.total);
      }
      computedDays++;
      if (computedDays % 10 === 0) {
        const msg = `Computing snapshots: ${computedDays}/${snapshotDates.length - skippedDays}`;
        console.log(`[breadth] ${msg}`);
        onProgress?.(msg);
      }
    } catch (err: unknown) {
      console.error(
        `[breadth] Failed to compute breadth for ${date}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (skippedDays > 0) console.log(`[breadth] Skipped ${skippedDays} already-complete dates.`);

  console.log(
    `[breadth] Bootstrap done in ${Math.round((Date.now() - t0) / 1000)}s: fetched=${fetchedDays}, computed=${computedDays}`,
  );
  return { fetchedDays, computedDays };
}

// ---------------------------------------------------------------------------
// API query
// ---------------------------------------------------------------------------

export async function getLatestBreadthData(historyDays: number = 60): Promise<BreadthMAResponse> {
  const snapshots = await getLatestBreadthSnapshots();

  // Fetch index ETF prices in parallel (cached up to 1 hour) for the normalized comparison chart
  const indexTickers = ALL_BREADTH_INDICES as string[];
  const priceResults = await Promise.allSettled(indexTickers.map((t) => getCachedIndexPrices(t)));
  const priceByIndex: Record<string, Map<string, number>> = {};
  for (let i = 0; i < indexTickers.length; i++) {
    const r = priceResults[i];
    priceByIndex[indexTickers[i]] = r.status === 'fulfilled' ? r.value : new Map();
  }

  const history: Record<
    string,
    Array<{ date: string; ma21: number; ma50: number; ma100: number; ma200: number; close: number | undefined }>
  > = {};
  for (const index of ALL_BREADTH_INDICES) {
    const raw = await getBreadthHistory(index, historyDays);
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

export async function cleanupBreadthData(): Promise<void> {
  const deleted = await cleanupOldCloses(250);
  if (deleted > 0) {
    console.log(`[breadth] Cleaned up ${deleted} old close rows.`);
  }
}

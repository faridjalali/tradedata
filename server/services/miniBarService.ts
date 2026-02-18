import { LRUCache } from 'lru-cache';
import { divergencePool } from '../db.js';
import { MINI_BARS_CACHE_MAX_TICKERS } from '../config.js';
import { etDateStringFromUnixSeconds } from '../lib/dateUtils.js';
import { dataApiIntradayChartHistory, convertToLATime } from './chartEngine.js';

export const miniBarsCacheByTicker = new LRUCache({ max: MINI_BARS_CACHE_MAX_TICKERS });

/** Maximum number of daily bars returned for mini-charts (~30 trading days). */
const MINI_CHART_MAX_BARS = 30;
/** Lookback days when fetching from API — enough to guarantee MINI_CHART_MAX_BARS trading days. */
const MINI_CHART_API_LOOKBACK_DAYS = 50;

type MiniBar = { time: number; open: number; high: number; low: number; close: number };

/** Keep only the most recent MINI_CHART_MAX_BARS bars. */
export function trimMiniChartBars<T>(bars: T[]): T[] {
  return bars.length > MINI_CHART_MAX_BARS ? bars.slice(-MINI_CHART_MAX_BARS) : bars;
}
const trimBars = trimMiniChartBars;


export async function persistMiniChartBars(ticker: string, bars: Array<{ time: number; open: number; high: number; low: number; close: number }>) {
  if (!divergencePool || !ticker || !Array.isArray(bars) || bars.length === 0) return;
  try {
    const values: unknown[] = [];
    const placeholders = [];
    let idx = 1;
    for (const b of bars) {
      const tradeDate = etDateStringFromUnixSeconds(Number(b.time));
      if (!tradeDate) continue;
      placeholders.push(`($${idx},$${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6})`);
      values.push(ticker, tradeDate, Number(b.open), Number(b.high), Number(b.low), Number(b.close), Number(b.time));
      idx += 7;
    }
    if (placeholders.length === 0) return;
    await divergencePool.query(
      `
      INSERT INTO mini_chart_bars(ticker, trade_date, open_price, high_price, low_price, close_price, bar_time)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (ticker, trade_date) DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        bar_time = EXCLUDED.bar_time,
        updated_at = NOW()
    `,
      values,
    );
  } catch (err: any) {
    console.error(`persistMiniChartBars(${ticker}): ${err.message}`);
  }
}


export async function loadMiniChartBarsFromDb(ticker: string): Promise<MiniBar[]> {
  if (!divergencePool || !ticker) return [];
  const result = await divergencePool.query(
    `
    SELECT bar_time AS time, open_price AS open, high_price AS high,
           low_price AS low, close_price AS close
    FROM mini_chart_bars
    WHERE ticker = $1
    ORDER BY trade_date DESC
    LIMIT $2
  `,
    [ticker.toUpperCase(), MINI_CHART_MAX_BARS],
  );
  // Query returns DESC order; reverse to ASC for chart rendering.
  return result.rows
    .map((r) => ({
      time: Number(r.time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    }))
    .reverse();
}


export async function loadMiniChartBarsFromDbBatch(tickers: string[]): Promise<Record<string, MiniBar[]>> {
  if (!divergencePool || !Array.isArray(tickers) || tickers.length === 0) return {};
  const upper = tickers.map((t) => t.toUpperCase());
  const placeholders = upper.map((_, i) => `$${i + 1}`).join(',');
  const result = await divergencePool.query(
    `
    SELECT ticker, bar_time AS time, open_price AS open, high_price AS high,
           low_price AS low, close_price AS close
    FROM mini_chart_bars
    WHERE ticker IN (${placeholders})
    ORDER BY ticker, trade_date ASC
  `,
    upper,
  );
  const grouped: Record<string, MiniBar[]> = {};
  for (const r of result.rows) {
    const t = r.ticker;
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push({
      time: Number(r.time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    });
  }
  // Trim each ticker to the most recent bars.
  for (const t of Object.keys(grouped)) {
    grouped[t] = trimBars(grouped[t]);
  }
  return grouped;
}


export async function fetchMiniChartBarsFromApi(ticker: string): Promise<MiniBar[]> {
  if (!ticker) return [];
  try {
    const rows = await dataApiIntradayChartHistory(ticker, '1day', MINI_CHART_API_LOOKBACK_DAYS);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const dailyBars = convertToLATime(rows, '1day').sort((a, b) => Number(a.time) - Number(b.time));
    const bars = trimBars(
      dailyBars.map((b) => ({
        time: Number(b.time),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      })),
    );
    // Persist to DB and memory for future requests.
    if (bars.length > 0) {
      miniBarsCacheByTicker.set(ticker.toUpperCase(), bars);
      if (divergencePool) {
        persistMiniChartBars(ticker.toUpperCase(), bars).catch(() => {});
      }
    }
    return bars;
  } catch (err: any) {
    console.error(`fetchMiniChartBarsFromApi(${ticker}): ${err.message || err}`);
    return [];
  }
}

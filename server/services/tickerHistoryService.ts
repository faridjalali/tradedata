import { pool, divergencePool, isDivergenceConfigured } from '../db.js';
import {
  DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_TABLE_MIN_COVERAGE_DAYS,
  DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS,
} from '../config.js';
import {
  currentEtDateString, maxEtDateString, etDateStringFromUnixSeconds,
  dateKeyDaysAgo, addUtcDays,
} from '../lib/dateUtils.js';
import {
  dataApiIntradayChartHistory, computeVolumeDeltaByParentBars,
  dataApiIntraday, calculateVolumeDeltaRsiSeries,
  DIVERGENCE_LOOKBACK_DAYS, toVolumeDeltaSourceInterval,
  DIVERGENCE_SUMMARY_BUILD_CONCURRENCY, DIVERGENCE_ON_DEMAND_REFRESH_COOLDOWN_MS,
  convertToLATime,
} from './chartEngine.js';
import { classifyDivergenceSignal } from '../chartMath.js';
import { normalizeTickerSymbol, fetchDataApiMovingAverageStatesForTicker, dataApiDailySingle } from './dataApi.js';
import {
  computeDivergenceSummaryStatesFromDailyResult,
  getStoredDivergenceSummariesForTickers,
  buildDivergenceSummaryEntryFromRow,
  buildNeutralDivergenceStates,
  classifyDivergenceStateMapFromDailyRows,
} from './divergenceStateService.js';
import {
  upsertDivergenceSummaryBatch, upsertDivergenceDailyBarsBatch,
  resolveDivergenceAsOfTradeDate,
} from './divergenceDbService.js';
import { miniBarsCacheByTicker, persistMiniChartBars } from './miniBarService.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { DIVERGENCE_SCAN_PARENT_INTERVAL, DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS } from '../config.js';
import { pacificDateStringFromUnixSeconds, parseDateKeyToUtcMs } from '../lib/dateUtils.js';
import { isValidTickerSymbol } from '../middleware.js';
import { getIntradayLookbackDays, nextPacificDivergenceRefreshUtcMs, normalizeIntradayVolumesFromCumulativeIfNeeded } from './chartEngine.js';
import { buildNeutralDivergenceStateMap, setDivergenceSummaryCacheEntry } from './divergenceStateService.js';
import { resolveLastClosedDailyCandleDate } from './scanControlService.js';



export async function buildDailyDivergenceSummaryInput(options: { ticker?: string; vdSourceInterval?: string; lookbackDays?: number } = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const lookbackDays = Math.max(1, Math.floor(Number(options.lookbackDays) || getIntradayLookbackDays('1day')));
  if (!ticker) {
    return { bars: [], volumeDelta: [] };
  }

  const parentFetchInterval = '1day';
  const requiredIntervals = Array.from(new Set([parentFetchInterval, vdSourceInterval]));
  const rowsByInterval = new Map();
  await Promise.all(
    requiredIntervals.map(async (tf) => {
      const rows = await dataApiIntradayChartHistory(ticker, tf, lookbackDays);
      rowsByInterval.set(tf, rows || []);
    }),
  );

  const parentRows = rowsByInterval.get(parentFetchInterval) || [];
  if (!Array.isArray(parentRows) || parentRows.length === 0) {
    return { bars: [], volumeDelta: [] };
  }

  const dailyBars = convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return { bars: [], volumeDelta: [] };
  }

  const sourceRows = rowsByInterval.get(vdSourceInterval) || [];
  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], vdSourceInterval).sort((a, b) => Number(a.time) - Number(b.time)),
  );
  const volumeDelta = computeVolumeDeltaByParentBars(dailyBars, sourceBars, '1day').map((point) => ({
    time: point.time,
    delta: Number.isFinite(Number(point?.delta)) ? Number(point.delta) : 0,
  }));
  return {
    bars: dailyBars,
    volumeDelta,
  };
}


export async function persistOnDemandTickerDivergenceSummary(options: { entry?: Record<string, unknown>; latestDailyBar?: Record<string, unknown> | null } = {}) {
  if (!divergencePool) return;
  const entry = options.entry || null;
  const latestDailyBar = options.latestDailyBar || null;
  if (!entry || !entry.ticker || !entry.sourceInterval) return;

  if (latestDailyBar && latestDailyBar.trade_date) {
    await upsertDivergenceDailyBarsBatch([latestDailyBar], null);
  }
  if (entry.tradeDate) {
    await upsertDivergenceSummaryBatch(
      [
        {
          ticker: entry.ticker,
          source_interval: entry.sourceInterval,
          trade_date: entry.tradeDate,
          states: entry.states,
          ma_states: entry.maStates || null,
        },
      ],
      null,
    );
  }
}


export async function getOrBuildTickerDivergenceSummary(options: { ticker?: string; vdSourceInterval?: string; forceRefresh?: boolean; persistToDatabase?: boolean } = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const forceRefresh = Boolean(options.forceRefresh);
  const persistToDatabase = options.persistToDatabase !== false;
  if (!ticker || !isValidTickerSymbol(ticker)) return null;

  if (!forceRefresh) {
    const storedMap = await getStoredDivergenceSummariesForTickers([ticker], vdSourceInterval);
    const stored = storedMap.get(ticker);
    if (stored) return stored;
  }

  const nowMs = Date.now();
  const lookbackDays = getIntradayLookbackDays('1day');
  const asOfTradeDate = resolveLastClosedDailyCandleDate(new Date(nowMs));
  const dailyRows = await buildDivergenceDailyRowsForTicker({
    ticker,
    sourceInterval: vdSourceInterval,
    lookbackDays,
    asOfTradeDate,
    parentInterval: '1day',
    noCache: true,
  });
  const filteredRows = Array.isArray(dailyRows)
    ? dailyRows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate)
    : [];
  const latestDailyBar = filteredRows.length > 0 ? filteredRows[filteredRows.length - 1] : null;
  const states =
    filteredRows.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filteredRows) : buildNeutralDivergenceStateMap();
  const tradeDate = String(latestDailyBar?.trade_date || asOfTradeDate || '').trim() || null;
  const entry = {
    ticker,
    sourceInterval: vdSourceInterval,
    tradeDate,
    states,
    computedAtMs: nowMs,
    expiresAtMs: nextPacificDivergenceRefreshUtcMs(new Date(nowMs)),
  };
  if (persistToDatabase) {
    try {
      await persistOnDemandTickerDivergenceSummary({
        entry,
        latestDailyBar,
      });

      // Return the value as stored in DB (single source of truth).
      const storedMap = await getStoredDivergenceSummariesForTickers([ticker], vdSourceInterval);
      const stored = storedMap.get(ticker);
      if (stored) return stored;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to persist on-demand divergence summary for ${ticker}: ${message}`);
    }
  }
  return entry;
}


export async function getDivergenceSummaryForTickers(options: { tickers?: string[]; vdSourceInterval?: string; forceRefresh?: boolean } = {}) {
  const tickers = Array.isArray(options.tickers)
    ? options.tickers
        .map((ticker: string) => String(ticker || '').toUpperCase())
        .filter((ticker: string) => ticker && isValidTickerSymbol(ticker))
    : [];
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  if (tickers.length === 0) {
    return {
      sourceInterval: vdSourceInterval,
      refreshedAt: new Date().toISOString(),
      summaries: [],
    };
  }

  const uniqueTickers: string[] = Array.from(new Set(tickers));
  const forceRefresh = Boolean(options.forceRefresh);
  if (forceRefresh) {
    await mapWithConcurrency(
      uniqueTickers,
      8,
      async (ticker: string) => {
        await getOrBuildTickerDivergenceSummary({
          ticker,
          vdSourceInterval,
          forceRefresh: true,
          persistToDatabase: true,
        });
      },
      (result: { error?: unknown } | void, _index: number, ticker: string) => {
        if (result && typeof result === 'object' && 'error' in result && result.error) {
          const message = result.error instanceof Error ? result.error.message : String(result.error);
          console.error(`Failed to force-refresh divergence summary for ${ticker}: ${message}`);
        }
      },
    );
  }

  const summariesByTicker = await getStoredDivergenceSummariesForTickers(uniqueTickers, vdSourceInterval);
  const summaries = [];
  const nowMs = Date.now();
  const fallbackTradeDate = await resolveDivergenceAsOfTradeDate(vdSourceInterval);
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));
  const neutralStates = buildNeutralDivergenceStateMap();
  for (const ticker of uniqueTickers) {
    const entry = summariesByTicker.get(ticker);
    if (entry) {
      summaries.push(entry);
      continue;
    }
    summaries.push({
      ticker,
      sourceInterval: vdSourceInterval,
      tradeDate: fallbackTradeDate,
      states: neutralStates,
      maStates: {
        ema8: false,
        ema21: false,
        sma50: false,
        sma200: false,
      },
      computedAtMs: nowMs,
      expiresAtMs,
    });
  }

  return {
    sourceInterval: vdSourceInterval,
    refreshedAt: new Date().toISOString(),
    summaries: summaries.map((entry) => ({
      ticker: entry.ticker,
      tradeDate: entry.tradeDate,
      states: entry.states,
      maStates: entry.maStates,
      expiresAtMs: entry.expiresAtMs,
    })),
  };
}


export async function rebuildStoredDivergenceSummariesForTickers(options: { sourceInterval?: string; tickers?: string[]; asOfTradeDate?: string; lookbackDays?: number } = {}) {
  if (!divergencePool) return new Map();
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tickers = Array.isArray(options.tickers)
    ? Array.from(
        new Set(
          options.tickers
            .map((ticker: string) => String(ticker || '').toUpperCase())
            .filter((ticker: string) => ticker && isValidTickerSymbol(ticker)),
        ),
      )
    : [];
  if (tickers.length === 0) return new Map();

  const asOfTradeDate = await resolveDivergenceAsOfTradeDate(
    sourceInterval,
    String(options.asOfTradeDate || '').trim(),
  );
  const lookbackDays = Math.max(45, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
  const historyStartDate = dateKeyDaysAgo(asOfTradeDate, lookbackDays + 7) || asOfTradeDate;
  const rowsByTicker = await loadDivergenceDailyHistoryByTicker({
    sourceInterval,
    tickers,
    historyStartDate,
    asOfTradeDate,
  });

  const neutralStates = buildNeutralDivergenceStateMap();
  const summaryRows: Array<{ ticker: string; source_interval: string; trade_date: string; states: Record<string, string> }> = [];
  const summaryByTicker = new Map();
  const nowMs = Date.now();
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));

  for (const ticker of tickers) {
    const rows = rowsByTicker.get(ticker) || [];
    const filtered = rows.filter((row: { trade_date: string; close: number; volume_delta: number }) => row.trade_date && row.trade_date <= asOfTradeDate);
    const latestRowDate = filtered.length ? String(filtered[filtered.length - 1].trade_date || '').trim() : '';
    const tradeDate = latestRowDate || asOfTradeDate;
    const states = filtered.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filtered) : neutralStates;
    summaryRows.push({
      ticker,
      source_interval: sourceInterval,
      trade_date: tradeDate,
      states,
    });
    const entry = {
      ticker,
      sourceInterval,
      tradeDate,
      states,
      computedAtMs: nowMs,
      expiresAtMs,
    };
    summaryByTicker.set(ticker, entry);
  }

  if (summaryRows.length > 0) {
    await upsertDivergenceSummaryBatch(summaryRows, null);
    for (const entry of summaryByTicker.values()) {
      setDivergenceSummaryCacheEntry(entry);
    }
  }
  return summaryByTicker;
}


export function buildLatestDailyBarSnapshotForTicker(options: { ticker?: string; sourceInterval?: string; maxTradeDateKey?: string; dailyInput?: Record<string, unknown> } = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const maxTradeDateKey = String(options.maxTradeDateKey || '').trim();
  const dailyInput = options.dailyInput || {};
  const bars = Array.isArray(dailyInput.bars) ? dailyInput.bars : [];
  const volumeDelta = Array.isArray(dailyInput.volumeDelta) ? dailyInput.volumeDelta : [];
  if (!ticker || bars.length === 0) return null;

  const deltaByTime = new Map();
  for (const point of volumeDelta) {
    const t = Number(point?.time);
    const delta = Number(point?.delta);
    if (!Number.isFinite(t) || !Number.isFinite(delta)) continue;
    deltaByTime.set(t, delta);
  }

  const eligible = [];
  for (const bar of bars) {
    const unix = Number(bar?.time);
    if (!Number.isFinite(unix)) continue;
    const tradeDatePt = pacificDateStringFromUnixSeconds(unix);
    if (maxTradeDateKey && tradeDatePt && tradeDatePt > maxTradeDateKey) continue;
    eligible.push(bar);
  }
  if (eligible.length === 0) return null;

  const latestBar = eligible[eligible.length - 1];
  const prevBar = eligible.length > 1 ? eligible[eligible.length - 2] : latestBar;
  const tradeDateEt = etDateStringFromUnixSeconds(Number(latestBar?.time));
  const close = Number(latestBar?.close);
  const prevClose = Number(prevBar?.close);
  if (!tradeDateEt || !Number.isFinite(close) || !Number.isFinite(prevClose)) return null;

  return {
    ticker,
    trade_date: tradeDateEt,
    source_interval: sourceInterval,
    close,
    prev_close: prevClose,
    volume_delta: Number(deltaByTime.get(Number(latestBar.time)) || 0),
  };
}


export async function buildLatestWeeklyBarSnapshotForTicker(options: { ticker?: string; sourceInterval?: string; lookbackDays?: number; asOfTradeDate?: string; signal?: AbortSignal | null; noCache?: boolean; parentRows?: Array<Record<string, unknown>>; sourceRows?: Array<Record<string, unknown>>; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval = toVolumeDeltaSourceInterval(options.sourceInterval, DIVERGENCE_SOURCE_INTERVAL);
  const lookbackDays = Math.max(35, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const signal = options && options.signal ? options.signal : null;
  const noCache = options && options.noCache === true;
  if (!ticker) return null;
  const suppliedParentRows = Array.isArray(options.parentRows) ? options.parentRows : null;
  const suppliedSourceRows = Array.isArray(options.sourceRows) ? options.sourceRows : null;
  const historyOptions = { signal, noCache, metricsTracker: options.metricsTracker };
  const [parentRows, sourceRows] = await Promise.all([
    suppliedParentRows || dataApiIntradayChartHistory(ticker, '1week', lookbackDays, historyOptions),
    suppliedSourceRows || dataApiIntradayChartHistory(ticker, sourceInterval, lookbackDays, historyOptions),
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) return null;
  const weeklyBars = convertToLATime(parentRows, '1week').sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(weeklyBars) || weeklyBars.length === 0) return null;

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], sourceInterval).sort((a, b) => Number(a.time) - Number(b.time)),
  );
  const weeklyDeltas = computeVolumeDeltaByParentBars(weeklyBars, sourceBars, '1week');
  const deltaByTime = new Map(weeklyDeltas.map((point) => [Number(point.time), Number(point.delta) || 0]));

  const eligible = [];
  for (const bar of weeklyBars) {
    const unix = Number(bar?.time);
    if (!Number.isFinite(unix)) continue;
    const tradeDateEt = etDateStringFromUnixSeconds(unix);
    if (asOfTradeDate && tradeDateEt && tradeDateEt > asOfTradeDate) continue;
    eligible.push(bar);
  }
  if (eligible.length === 0) return null;

  const latestBar = eligible[eligible.length - 1];
  const prevBar = eligible.length > 1 ? eligible[eligible.length - 2] : latestBar;
  const close = Number(latestBar?.close);
  const prevClose = Number(prevBar?.close);
  if (!Number.isFinite(close) || !Number.isFinite(prevClose)) return null;

  return {
    ticker,
    trade_date: asOfTradeDate || etDateStringFromUnixSeconds(Number(latestBar?.time)),
    source_interval: sourceInterval,
    close,
    prev_close: prevClose,
    volume_delta: Number(deltaByTime.get(Number(latestBar.time)) || 0),
  };
}


export async function getDivergenceTableTickerUniverseFromAlerts(): Promise<string[]> {
  const tickers = new Set<string>();

  try {
    const tvResult = await pool.query(`
      SELECT DISTINCT UPPER(TRIM(ticker)) AS ticker
      FROM alerts
      WHERE ticker IS NOT NULL
    `);
    for (const row of tvResult.rows) {
      const ticker = String(row?.ticker || '')
        .trim()
        .toUpperCase();
      if (ticker && isValidTickerSymbol(ticker)) tickers.add(ticker);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load TV ticker universe for table run: ${message}`);
  }

  if (divergencePool) {
    try {
      const dataApiResult = await divergencePool.query(`
        SELECT DISTINCT UPPER(TRIM(ticker)) AS ticker
        FROM divergence_signals
        WHERE ticker IS NOT NULL
      `);
      for (const row of dataApiResult.rows) {
        const ticker = String(row?.ticker || '')
          .trim()
          .toUpperCase();
        if (ticker && isValidTickerSymbol(ticker)) tickers.add(ticker);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to load FML ticker universe for table run: ${message}`);
    }
  }

  return Array.from(tickers).sort((a, b) => a.localeCompare(b));
}


export function groupDivergenceDailyRowsByTicker(rows: Array<Record<string, unknown>>) {
  const out = new Map<string, Array<{ trade_date: string; close: number; volume_delta: number }>>();
  for (const row of rows || []) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!out.has(ticker)) out.set(ticker, []);
    out.get(ticker)!.push({
      trade_date: String(row?.trade_date || '').trim(),
      close: Number(row?.close),
      volume_delta: Number(row?.volume_delta),
    });
  }
  return out;
}


export async function loadDivergenceDailyHistoryByTicker(options: { sourceInterval?: string; tickers?: string[]; historyStartDate?: string; asOfTradeDate?: string } = {}) {
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tickers = Array.isArray(options.tickers) ? options.tickers : [];
  const historyStartDate = String(options.historyStartDate || '').trim();
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  if (!divergencePool || tickers.length === 0 || !historyStartDate || !asOfTradeDate) {
    return new Map();
  }

  const historyResult = await divergencePool.query(
    `
    SELECT
      ticker,
      trade_date::text AS trade_date,
      close::double precision AS close,
      volume_delta::double precision AS volume_delta
    FROM divergence_daily_bars
    WHERE source_interval = $1
      AND ticker = ANY($2::VARCHAR[])
      AND trade_date >= $3::date
      AND trade_date <= $4::date
    ORDER BY ticker ASC, trade_date ASC
  `,
    [sourceInterval, tickers, historyStartDate, asOfTradeDate],
  );

  return groupDivergenceDailyRowsByTicker(historyResult.rows);
}


export function hasDivergenceHistoryCoverage(rows: Array<{ trade_date: string }>, asOfTradeDate: string, minCoverageDays: number) {
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => row.trade_date && row.trade_date <= asOfTradeDate);
  if (safeRows.length < 2) return false;

  const oldestDate = String(safeRows[0].trade_date || '').trim();
  const latestDate = String(safeRows[safeRows.length - 1].trade_date || '').trim();
  const oldestMs = parseDateKeyToUtcMs(oldestDate);
  const latestMs = parseDateKeyToUtcMs(latestDate);
  const asOfMs = parseDateKeyToUtcMs(asOfTradeDate);
  if (!Number.isFinite(oldestMs) || !Number.isFinite(latestMs) || !Number.isFinite(asOfMs)) return false;

  const latestLagDays = Math.floor((asOfMs - latestMs) / (24 * 60 * 60 * 1000));
  if (latestLagDays > 3) return false;

  const coverageDays = Math.floor((asOfMs - oldestMs) / (24 * 60 * 60 * 1000));
  return coverageDays >= Math.max(1, Number(minCoverageDays) || DIVERGENCE_TABLE_MIN_COVERAGE_DAYS);
}


export async function buildDivergenceDailyRowsForTicker(options: { ticker?: string; sourceInterval?: string; lookbackDays?: number; asOfTradeDate?: string; signal?: AbortSignal | null; noCache?: boolean; parentRows?: Array<Record<string, unknown>>; sourceRows?: Array<Record<string, unknown>>; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null; parentInterval?: string } = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval = toVolumeDeltaSourceInterval(options.sourceInterval, DIVERGENCE_SOURCE_INTERVAL);
  const lookbackDays = Math.max(35, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const signal = options && options.signal ? options.signal : null;
  const noCache = options && options.noCache === true;
  if (!ticker) return [];

  const suppliedParentRows = Array.isArray(options.parentRows) ? options.parentRows : null;
  const suppliedSourceRows = Array.isArray(options.sourceRows) ? options.sourceRows : null;
  const historyOptions = { signal, noCache, metricsTracker: options.metricsTracker };
  const [parentRows, sourceRows] = await Promise.all([
    suppliedParentRows || dataApiIntradayChartHistory(ticker, '1day', lookbackDays, historyOptions),
    suppliedSourceRows || dataApiIntradayChartHistory(ticker, sourceInterval, lookbackDays, historyOptions),
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) return [];
  const dailyBars = convertToLATime(parentRows, '1day').sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];

  // Cache daily OHLC bars for the mini-chart hover overlay.
  if (ticker && dailyBars.length > 0) {
    const mappedBars = dailyBars.map((b) => ({
      time: Number(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }));
    miniBarsCacheByTicker.set(ticker, mappedBars);
    // Persist to DB so mini-bars survive server restarts (fire-and-forget).
    if (divergencePool) {
      persistMiniChartBars(ticker, mappedBars).catch(() => {});
    }
  }

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], sourceInterval).sort((a, b) => Number(a.time) - Number(b.time)),
  );
  const dailyDeltas = computeVolumeDeltaByParentBars(dailyBars, sourceBars, DIVERGENCE_SCAN_PARENT_INTERVAL);
  const deltaByTime = new Map(dailyDeltas.map((point) => [Number(point.time), Number(point.delta) || 0]));

  const out = [];
  for (let i = 0; i < dailyBars.length; i++) {
    const bar = dailyBars[i];
    const tradeDate = etDateStringFromUnixSeconds(Number(bar?.time));
    if (!tradeDate) continue;
    if (asOfTradeDate && tradeDate > asOfTradeDate) continue;
    const close = Number(bar?.close);
    const prevClose = Number((dailyBars[i - 1] || bar)?.close);
    if (!Number.isFinite(close) || !Number.isFinite(prevClose)) continue;
    out.push({
      ticker,
      trade_date: tradeDate,
      source_interval: sourceInterval,
      close,
      prev_close: prevClose,
      volume_delta: Number(deltaByTime.get(Number(bar.time)) || 0),
    });
  }

  return out;
}

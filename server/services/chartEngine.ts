/**
 * Chart Engine — LRU caches, intraday data fetching with SWR,
 * RSI / RMA / volume-delta calculations, chart result building,
 * compressed response sending, breadth helpers, and market-hours logic.
 */

import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import { LRUCache } from 'lru-cache';
import * as tradingCalendar from './tradingCalendar.js';
import { formatDateUTC, dayKeyInLA } from '../chartMath.js';
import {
  addUtcDays,
  etDateStringFromUnixSeconds,
  easternLocalToUtcMs,
  pacificLocalToUtcMs,
  dateKeyFromYmdParts,
  pacificDateTimeParts,
} from '../lib/dateUtils.js';
import {
  buildDataApiAggregateRangeUrl,
  fetchDataApiJson,
  fetchDataApiArrayWithFallback,
  sanitizeDataApiUrl,
  normalizeUnixSeconds,
  toNumberOrNull,
  toArrayPayload,
  getDataApiSymbolCandidates,
  normalizeTickerSymbol,
  isAbortError,
  buildRequestAbortError,
  isDataApiRateLimitedError,
  isDataApiPausedError,
  isDataApiSubscriptionRestrictedError,
  dataApiDaily,
} from './dataApi.js';

const gzipAsync = promisify(zlib.gzip);
const brotliCompressAsync = promisify(zlib.brotliCompress);

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

export interface TimedCacheEntry {
  value: unknown;
  freshUntil: number;
  staleUntil: number;
}

interface OHLCVBar {
  [key: string]: unknown;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChartRequestParams {
  ticker: string;
  interval: string;
  vdRsiLength: number;
  vdSourceInterval: string;
  vdRsiSourceInterval: string;
  lookbackDays: number;
  requestKey: string;
  skipFollowUpPrewarm?: boolean;
}

interface ChartBuildOptions {
  ticker?: string;
  interval?: string;
  rowsByInterval?: Map<string, unknown[]>;
  vdRsiLength?: number;
  vdSourceInterval?: string;
  vdRsiSourceInterval?: string;
  timer?: ReturnType<typeof createChartStageTimer> | null;
}

// ---------------------------------------------------------------------------
// Cache configuration (from env)
// ---------------------------------------------------------------------------

const VD_RSI_REGULAR_HOURS_CACHE_MS = 2 * 60 * 60 * 1000;
const CHART_RESULT_CACHE_TTL_SECONDS = Math.max(0, Number(process.env.CHART_RESULT_CACHE_TTL_SECONDS) || 300);
const CHART_RESPONSE_MAX_AGE_SECONDS = Math.max(0, Number(process.env.CHART_RESPONSE_MAX_AGE_SECONDS) || 15);
const CHART_RESPONSE_SWR_SECONDS = Math.max(0, Number(process.env.CHART_RESPONSE_SWR_SECONDS) || 45);
const CHART_RESPONSE_COMPRESS_MIN_BYTES = Math.max(0, Number(process.env.CHART_RESPONSE_COMPRESS_MIN_BYTES) || 1024);
const CHART_TIMING_LOG_ENABLED = String(process.env.CHART_TIMING_LOG || '').toLowerCase() === 'true';
const CHART_QUOTE_CACHE_MS = Math.max(1000, Number(process.env.CHART_QUOTE_CACHE_MS) || 300_000);
const VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES) || 6000);
const VD_RSI_RESULT_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.VD_RSI_RESULT_CACHE_MAX_ENTRIES) || 6000);
const CHART_DATA_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.CHART_DATA_CACHE_MAX_ENTRIES) || 6000);
const CHART_QUOTE_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.CHART_QUOTE_CACHE_MAX_ENTRIES) || 4000);
const CHART_FINAL_RESULT_CACHE_MAX_ENTRIES = Math.max(
  1,
  Number(process.env.CHART_FINAL_RESULT_CACHE_MAX_ENTRIES) || 4000,
);

// ---------------------------------------------------------------------------
// LRU cache instances
// ---------------------------------------------------------------------------

const VD_RSI_LOWER_TF_CACHE = new LRUCache<string, TimedCacheEntry>({ max: VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES });
const VD_RSI_RESULT_CACHE = new LRUCache<string, TimedCacheEntry>({ max: VD_RSI_RESULT_CACHE_MAX_ENTRIES });
const CHART_DATA_CACHE = new LRUCache<string, TimedCacheEntry>({ max: CHART_DATA_CACHE_MAX_ENTRIES });
const CHART_QUOTE_CACHE = new LRUCache<string, TimedCacheEntry>({ max: CHART_QUOTE_CACHE_MAX_ENTRIES });
const CHART_FINAL_RESULT_CACHE = new LRUCache<string, TimedCacheEntry>({ max: CHART_FINAL_RESULT_CACHE_MAX_ENTRIES });
const CHART_IN_FLIGHT_REQUESTS = new Map<string, Promise<unknown>>();
const CHART_IN_FLIGHT_MAX = 500;

// ---------------------------------------------------------------------------
// Chart interval constants
// ---------------------------------------------------------------------------

const VALID_CHART_INTERVALS = ['5min', '15min', '30min', '1hour', '4hour', '1day', '1week'];
const VOLUME_DELTA_SOURCE_INTERVALS = ['1min', '5min', '15min', '30min', '1hour', '4hour'];
const DIVERGENCE_LOOKBACK_DAYS = [1, 3, 7, 14, 28];
const DIVERGENCE_SUMMARY_BUILD_CONCURRENCY = Math.max(
  1,
  Number(process.env.DIVERGENCE_SUMMARY_BUILD_CONCURRENCY) || 64,
);
const DIVERGENCE_ON_DEMAND_REFRESH_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.DIVERGENCE_ON_DEMAND_REFRESH_COOLDOWN_MS) || 5 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Timed cache helpers (SWR-style fresh / stale / miss)
// ---------------------------------------------------------------------------

function getTimedCacheValue(cacheMap: LRUCache<string, TimedCacheEntry>, key: string) {
  const entry = cacheMap.get(key);
  if (!entry) return { status: 'miss', value: null };

  const now = Date.now();
  if (now > entry.staleUntil) {
    cacheMap.delete(key);
    return { status: 'miss', value: null };
  }

  if (now <= entry.freshUntil) {
    return { status: 'fresh', value: entry.value };
  }
  return { status: 'stale', value: entry.value };
}

function setTimedCacheValue(cacheMap: LRUCache<string, TimedCacheEntry>, key: string, value: unknown, freshUntil: number, staleUntil?: number) {
  const now = Date.now();
  const safeFreshUntil = Number.isFinite(freshUntil) ? freshUntil : now + 60000;
  const safeStaleUntil = staleUntil !== undefined && Number.isFinite(staleUntil) ? staleUntil : safeFreshUntil + 300000;

  cacheMap.set(key, {
    value,
    freshUntil: safeFreshUntil,
    staleUntil: safeStaleUntil,
  });
}

function sweepExpiredTimedCache(cacheMap: LRUCache<string, TimedCacheEntry>) {
  const now = Date.now();
  for (const [key, entry] of cacheMap.entries()) {
    if (!entry || !Number.isFinite(entry.staleUntil) || entry.staleUntil <= now) {
      cacheMap.delete(key);
    }
  }
}

// Periodic cache cleanup
const vdRsiCacheCleanupTimer = setInterval(
  () => {
    sweepExpiredTimedCache(VD_RSI_LOWER_TF_CACHE);
    sweepExpiredTimedCache(VD_RSI_RESULT_CACHE);
    sweepExpiredTimedCache(CHART_DATA_CACHE);
    sweepExpiredTimedCache(CHART_QUOTE_CACHE);
    sweepExpiredTimedCache(CHART_FINAL_RESULT_CACHE);
  },
  15 * 60 * 1000,
);
if (typeof vdRsiCacheCleanupTimer.unref === 'function') {
  vdRsiCacheCleanupTimer.unref();
}

// ---------------------------------------------------------------------------
// Market-hours helpers
// ---------------------------------------------------------------------------

function isEtRegularHours(dateEt: Date) {
  const dateStr = `${dateEt.getFullYear()}-${String(dateEt.getMonth() + 1).padStart(2, '0')}-${String(dateEt.getDate()).padStart(2, '0')}`;
  if (!tradingCalendar.isTradingDay(dateStr)) return false;
  const totalMinutes = dateEt.getHours() * 60 + dateEt.getMinutes();
  if (tradingCalendar.isEarlyClose(dateStr)) {
    const closeTime = tradingCalendar.getCloseTimeEt(dateStr) || '13:00';
    const [ch, cm] = closeTime.split(':').map(Number);
    return totalMinutes >= 570 && totalMinutes < ch * 60 + cm;
  }
  return totalMinutes >= 570 && totalMinutes < 960;
}

function nextEtMarketOpenUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  const totalMinutes = candidate.getHours() * 60 + candidate.getMinutes();

  const candidateDateStr = () =>
    `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;

  if (!(tradingCalendar.isTradingDay(candidateDateStr()) && totalMinutes < 570)) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 15 && !tradingCalendar.isTradingDay(candidateDateStr()); i++) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return easternLocalToUtcMs(candidate.getFullYear(), candidate.getMonth() + 1, candidate.getDate(), 9, 30);
}

function todayEtMarketCloseUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return easternLocalToUtcMs(nowEt.getFullYear(), nowEt.getMonth() + 1, nowEt.getDate(), 16, 0);
}

function getVdRsiCacheExpiryMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (isEtRegularHours(nowEt)) {
    const plusTwoHoursMs = nowUtc.getTime() + VD_RSI_REGULAR_HOURS_CACHE_MS;
    const closeTodayMs = todayEtMarketCloseUtcMs(nowUtc);
    if (plusTwoHoursMs <= closeTodayMs) {
      return plusTwoHoursMs;
    }
    return nextEtMarketOpenUtcMs(nowUtc);
  }
  return nextEtMarketOpenUtcMs(nowUtc);
}

function nextPacificDivergenceRefreshUtcMs(nowUtc = new Date()) {
  const nowPacific = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const candidate = new Date(nowPacific);
  candidate.setHours(13, 1, 0, 0);

  const candidateDateStr = () =>
    `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;

  if (!tradingCalendar.isTradingDay(candidateDateStr()) || nowPacific.getTime() >= candidate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 15 && !tradingCalendar.isTradingDay(candidateDateStr()); i++) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return pacificLocalToUtcMs(candidate.getFullYear(), candidate.getMonth() + 1, candidate.getDate(), 13, 1);
}

function latestCompletedPacificTradeDateKey(nowUtc = new Date()) {
  const pt = pacificDateTimeParts(nowUtc);
  if (!Number.isFinite(pt.year) || !Number.isFinite(pt.month) || !Number.isFinite(pt.day)) {
    return '';
  }
  const todayKey = dateKeyFromYmdParts(pt.year, pt.month, pt.day);
  const minutesSinceMidnight = Number(pt.hour) * 60 + Number(pt.minute);
  const refreshMinute = 13 * 60 + 1;
  if (tradingCalendar.isTradingDay(todayKey) && minutesSinceMidnight >= refreshMinute) {
    return todayKey;
  }
  return tradingCalendar.previousTradingDay(todayKey);
}

// ---------------------------------------------------------------------------
// Intraday data fetching with SWR caching
// ---------------------------------------------------------------------------

const CHART_INTRADAY_LOOKBACK_DAYS = 548;
const CHART_INTRADAY_SLICE_DAYS: Record<string, number> = {
  '1min': 30,
  '5min': 150,
  '15min': 150,
  '30min': 45,
  '1hour': 45,
  '4hour': 45,
};

function getIntradayLookbackDays(_interval: string) {
  void _interval;
  return 548;
}

async function dataApiIntraday(
  symbol: string,
  interval: string,
  options: { from?: string; to?: string; signal?: AbortSignal | null; noCache?: boolean; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
) {
  const { from, to, signal, noCache = false, metricsTracker = null } = options;

  const cacheKey = `${symbol}|${interval}|${from || ''}|${to || ''}`;
  let cached: { status: string; value: unknown } = { status: 'miss', value: null };

  if (!noCache) {
    cached = getTimedCacheValue(CHART_DATA_CACHE, cacheKey);
    if (cached.status === 'fresh') {
      return cached.value as OHLCVBar[] | null;
    }
  }

  const executeFetch = async () => {
    const CHUNK_SIZE_DAYS: Record<string, number> = {
      '1min': 30,
      '5min': 150,
      '15min': 150,
    };

    const maxDays = CHUNK_SIZE_DAYS[interval];
    const startDt = options.from ? new Date(options.from) : addUtcDays(new Date(), -30);
    const endDt = options.to ? new Date(options.to) : new Date();

    let urls: string[] = [];
    if (maxDays && !options.from && !options.to) {
      urls = [buildDataApiAggregateRangeUrl(symbol, interval, { from, to })];
    } else if (maxDays) {
      let current = new Date(startDt);
      const ranges: { from: string; to: string }[] = [];
      while (current < endDt) {
        const next = addUtcDays(new Date(current), maxDays);
        const chunkEnd = next < endDt ? next : endDt;
        ranges.push({ from: formatDateUTC(current), to: formatDateUTC(chunkEnd) });
        current = addUtcDays(chunkEnd, 1);
      }
      urls = ranges.map((r) => buildDataApiAggregateRangeUrl(symbol, interval, r));
    } else {
      urls = [buildDataApiAggregateRangeUrl(symbol, interval, { from, to })];
    }

    let rows: Array<unknown> = [];
    if (urls.length > 1) {
      const CHUNK_CONCURRENCY = 3;
      const allRows: Array<unknown> = [];
      for (let i = 0; i < urls.length; i += CHUNK_CONCURRENCY) {
        const batch = urls.slice(i, i + CHUNK_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map((url) =>
            fetchDataApiJson(url, `DataAPI ${interval} chunk`, { signal, metricsTracker })
              .then((payload) => toArrayPayload(payload) || [])
              .catch((err: any) => {
                console.error(`DataAPI chunk fetch failed (${sanitizeDataApiUrl(url)}):`, err.message);
                throw err;
              }),
          ),
        );
        allRows.push(...batchResults.flat());
      }
      rows = allRows;
    } else {
      rows = await fetchDataApiArrayWithFallback(`DataAPI ${interval}`, urls, { signal, metricsTracker });
    }

    const normalized = rows
      .map((item: unknown) => {
        const row = item as Record<string, unknown>;
        const time = normalizeUnixSeconds(row.t ?? row.timestamp ?? row.time);
        const close = toNumberOrNull(row.c ?? row.close ?? row.price);
        const open = toNumberOrNull(row.o ?? row.open) ?? close;
        const high = toNumberOrNull(row.h ?? row.high) ?? close;
        const low = toNumberOrNull(row.l ?? row.low) ?? close;
        const volume = toNumberOrNull(row.v ?? row.volume) ?? 0;

        if (!Number.isFinite(time) || close === null || open === null || high === null || low === null) {
          return null;
        }

        return { time, open, high, low, close, volume };
      })
      .filter((bar): bar is OHLCVBar => bar !== null);

    const result = normalized.length ? normalized : null;

    if (result && !noCache) {
      const freshExpiryMs = getVdRsiCacheExpiryMs(new Date());
      const staleExpiryMs = freshExpiryMs + 10 * 60 * 1000;
      setTimedCacheValue(CHART_DATA_CACHE, cacheKey, result, freshExpiryMs, staleExpiryMs);
    }
    return result;
  };

  if (cached.status === 'stale') {
    executeFetch().catch((err: any) => {
      console.error(`[SWR] Background refresh failed for ${cacheKey}:`, err.message);
    });
    return cached.value as OHLCVBar[] | null;
  }

  return await executeFetch();
}

async function dataApiIntradayChartHistorySingle(
  symbol: string,
  interval: string,
  lookbackDays: number = CHART_INTRADAY_LOOKBACK_DAYS,
  options: { signal?: AbortSignal | null; noCache?: boolean; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
): Promise<OHLCVBar[] | null> {
  const signal = options && options.signal ? options.signal : null;
  const noCache = options && options.noCache === true;
  const metricsTracker = options && options.metricsTracker ? options.metricsTracker : null;
  const sliceDays = CHART_INTRADAY_SLICE_DAYS[interval] || 30;
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  const startDate = addUtcDays(endDate, -Math.max(1, lookbackDays));
  const shouldTrySingleRequest = Math.max(1, lookbackDays) <= sliceDays + 7;

  if (shouldTrySingleRequest) {
    try {
      const rows = await dataApiIntraday(symbol, interval, {
        from: formatDateUTC(startDate),
        to: formatDateUTC(endDate),
        signal,
        noCache,
        metricsTracker,
      });
      if (Array.isArray(rows) && rows.length > 0 && rows.length < 50000) {
        return rows.sort((a, b) => Number(a?.time ?? 0) - Number(b?.time ?? 0));
      }
      if (Array.isArray(rows) && rows.length === 0) {
        return [];
      }
      if (Array.isArray(rows) && rows.length >= 50000) {
        console.warn(`DataAPI ${interval} single-range payload hit cap for ${symbol}; retrying with slices`);
      }
    } catch (err: any) {
      if (
        isAbortError(err) ||
        isDataApiRateLimitedError(err) ||
        isDataApiPausedError(err) ||
        isDataApiSubscriptionRestrictedError(err)
      ) {
        throw err;
      }
      const message = err && err.message ? err.message : String(err);
      console.warn(`DataAPI ${interval} single-range fetch failed for ${symbol}; falling back to slices: ${message}`);
    }
  }

  const byDateTime = new Map();
  let cursor = new Date(startDate);
  let lastSliceError: unknown = null;

  while (cursor <= endDate) {
    if (signal && signal.aborted) {
      throw buildRequestAbortError(`DataAPI ${interval} fetch aborted for ${symbol}`);
    }
    const sliceStart = new Date(cursor);
    let sliceEnd = addUtcDays(sliceStart, sliceDays - 1);
    if (sliceEnd > endDate) sliceEnd = new Date(endDate);

    try {
      const rows = await dataApiIntraday(symbol, interval, {
        from: formatDateUTC(sliceStart),
        to: formatDateUTC(sliceEnd),
        signal,
        noCache,
        metricsTracker,
      });
      if (rows && rows.length > 0) {
        for (const row of rows) {
          if (!row) continue;
          const rowKey = Number.isFinite(Number(row.time))
            ? String(Math.floor(Number(row.time)))
            : String((row as any).datetime || '');
          if (!rowKey) continue;
          byDateTime.set(rowKey, row);
        }
      }
    } catch (err: any) {
      lastSliceError = err;
      if (isAbortError(err)) {
        throw err;
      }
      const message = err && err.message ? err.message : String(err);
      console.error(
        `DataAPI ${interval} slice fetch failed for ${symbol} (${formatDateUTC(sliceStart)} to ${formatDateUTC(sliceEnd)}): ${message}`,
      );
      if (isDataApiSubscriptionRestrictedError(err) || isDataApiRateLimitedError(err) || isDataApiPausedError(err)) {
        throw err;
      }
    }

    cursor = addUtcDays(sliceEnd, 1);
  }

  if (signal && signal.aborted) {
    throw buildRequestAbortError(`DataAPI ${interval} fetch aborted for ${symbol}`);
  }

  if (byDateTime.size === 0) {
    try {
      return await dataApiIntraday(symbol, interval, { signal, noCache, metricsTracker });
    } catch (fallbackErr) {
      if (lastSliceError) throw lastSliceError;
      throw fallbackErr;
    }
  }

  return Array.from(byDateTime.values()).sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
}

async function dataApiIntradayChartHistory(
  symbol: string,
  interval: string,
  lookbackDays: number = CHART_INTRADAY_LOOKBACK_DAYS,
  options: { signal?: AbortSignal | null; noCache?: boolean; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
): Promise<OHLCVBar[]> {
  const requestedInterval = String(interval || '').trim();
  const intervalCandidates = [requestedInterval];
  let lastError: unknown = null;

  for (const intervalCandidate of intervalCandidates) {
    const symbolCandidates = getDataApiSymbolCandidates(symbol);
    for (const candidate of symbolCandidates) {
      try {
        const rows = await dataApiIntradayChartHistorySingle(candidate, intervalCandidate, lookbackDays, options);
        if (rows && rows.length > 0) {
          if (candidate !== normalizeTickerSymbol(symbol)) {
            console.log(`DataAPI symbol fallback (${intervalCandidate}): ${symbol} -> ${candidate}`);
          }
          return rows;
        }
      } catch (err: any) {
        lastError = err;
        if (isAbortError(err)) {
          throw err;
        }
        const message = err && err.message ? err.message : String(err);
        console.error(`DataAPI ${intervalCandidate} history failed for ${candidate} (requested ${symbol}): ${message}`);
        if (isDataApiRateLimitedError(err) || isDataApiPausedError(err)) {
          throw err;
        }
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Technical indicator calculations
// ---------------------------------------------------------------------------

function calculateRSI(closePrices: number[], period: number = 14): number[] {
  if (!Array.isArray(closePrices) || closePrices.length === 0) return [];
  if (closePrices.length === 1) return [50];

  const rsiValues = new Array(closePrices.length).fill(50);
  const gains: number[] = [];
  const losses: number[] = [];

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < closePrices.length; i++) {
    const change = closePrices[i] - closePrices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    gains.push(gain);
    losses.push(loss);

    if (i < period) {
      const window = i;
      let gainSum = 0;
      let lossSum = 0;
      for (let j = 0; j < window; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / window;
      avgLoss = lossSum / window;
    } else if (i === period) {
      let gainSum = 0;
      let lossSum = 0;
      for (let j = i - period; j < i; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / period;
      avgLoss = lossSum / period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    rsiValues[i] = Number.isFinite(rsi) ? rsi : rsiValues[i - 1];
  }

  rsiValues[0] = rsiValues[1] ?? 50;
  return rsiValues;
}

function calculateRMA(values: Array<number | null>, length: number = 14) {
  const period = Math.max(1, Math.floor(length));
  const out = new Array(values.length).fill(null);

  const validValues: { index: number; value: number }[] = [];
  let firstValidIndex = -1;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) {
      if (firstValidIndex === -1) {
        firstValidIndex = i;
      }
      validValues.push({ index: i, value: v });

      if (validValues.length === period) {
        const sum = validValues.reduce((acc, v) => acc + v.value, 0);
        const initialRMA = sum / period;
        out[i] = initialRMA;
        break;
      }
    }
  }

  if (validValues.length < period) {
    return out;
  }

  let rma = out[validValues[period - 1].index];

  for (let i = validValues[period - 1].index + 1; i < values.length; i++) {
    const value = values[i];
    if (value === null || !Number.isFinite(value)) {
      continue;
    }

    rma = (rma * (period - 1) + value) / period;
    out[i] = rma;
  }

  return out;
}

function getIntervalSeconds(interval: string): number {
  const map: Record<string, number> = {
    '1min': 60,
    '5min': 5 * 60,
    '15min': 15 * 60,
    '30min': 30 * 60,
    '1hour': 60 * 60,
    '4hour': 4 * 60 * 60,
    '1day': 24 * 60 * 60,
    '1week': 7 * 24 * 60 * 60,
  };
  return map[interval] || 60;
}

function normalizeIntradayVolumesFromCumulativeIfNeeded(bars: OHLCVBar[]) {
  if (!Array.isArray(bars) || bars.length < 2) return bars || [];

  const normalized = bars.map((bar) => ({ ...bar, volume: Number(bar.volume) || 0 }));

  const maybeNormalizeDayRange = (startIndex: number, endIndex: number) => {
    if (endIndex - startIndex < 3) return;

    let nonDecreasing = 0;
    let steps = 0;
    const positiveDiffs: number[] = [];
    let maxVolume = Number.NEGATIVE_INFINITY;

    for (let i = startIndex; i <= endIndex; i++) {
      maxVolume = Math.max(maxVolume, Number(normalized[i].volume) || 0);
    }

    for (let i = startIndex + 1; i <= endIndex; i++) {
      const prev = Number(normalized[i - 1].volume) || 0;
      const curr = Number(normalized[i].volume) || 0;
      steps += 1;
      if (curr >= prev) nonDecreasing += 1;
      if (curr > prev) positiveDiffs.push(curr - prev);
    }

    if (steps === 0 || positiveDiffs.length === 0) return;
    const monotonicRatio = nonDecreasing / steps;
    if (monotonicRatio < 0.9) return;

    const avgDiff = positiveDiffs.reduce((sum, value) => sum + value, 0) / positiveDiffs.length;
    if (!Number.isFinite(avgDiff) || avgDiff <= 0) return;

    if (maxVolume / avgDiff < 6) return;

    for (let i = startIndex + 1; i <= endIndex; i++) {
      const prev = Number(normalized[i - 1].volume) || 0;
      const curr = Number(normalized[i].volume) || 0;
      normalized[i].volume = Math.max(0, curr - prev);
    }
    normalized[startIndex].volume = Math.max(0, Number(normalized[startIndex].volume) || 0);
  };

  let dayStart = 0;
  let currentDayKey = dayKeyInLA(Number(normalized[0].time));
  for (let i = 1; i < normalized.length; i++) {
    const key = dayKeyInLA(Number(normalized[i].time));
    if (key === currentDayKey) continue;
    maybeNormalizeDayRange(dayStart, i - 1);
    dayStart = i;
    currentDayKey = key;
  }
  maybeNormalizeDayRange(dayStart, normalized.length - 1);

  return normalized;
}

function computeVolumeDeltaByParentBars(parentBars: OHLCVBar[], lowerTimeframeBars: OHLCVBar[], interval: string) {
  if (!Array.isArray(parentBars) || parentBars.length === 0) return [];
  if (!Array.isArray(lowerTimeframeBars) || lowerTimeframeBars.length === 0) {
    return parentBars.map((bar) => ({ time: bar.time, delta: 0 }));
  }

  const intervalSeconds = getIntervalSeconds(interval);
  const parentTimes = parentBars.map((bar) => Number(bar.time));
  const intrabarsPerParent: Array<Array<{ open: number; close: number; volume: number }>> = parentBars.map(() => []);
  let parentIndex = 0;

  for (const bar of lowerTimeframeBars) {
    const t = Number(bar.time);
    if (!Number.isFinite(t)) continue;

    while (parentIndex + 1 < parentTimes.length && t >= parentTimes[parentIndex + 1]) {
      parentIndex += 1;
    }

    const currentParentStart = parentTimes[parentIndex];
    if (!Number.isFinite(currentParentStart)) continue;
    if (t < currentParentStart || t >= currentParentStart + intervalSeconds) continue;

    const open = Number(bar.open);
    const close = Number(bar.close);
    const volume = Number(bar.volume);
    if (!Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(volume)) continue;

    intrabarsPerParent[parentIndex].push({ open, close, volume });
  }

  let lastClose: number | null = null;
  let lastBull: boolean | null = null;
  const deltas: { time: number; delta: number }[] = [];

  for (let i = 0; i < parentBars.length; i++) {
    const stream = intrabarsPerParent[i];
    if (!stream || stream.length === 0) {
      deltas.push({ time: parentBars[i].time, delta: 0 });
      continue;
    }

    let runningDelta = 0;
    let streamLastClose: number | null = lastClose;
    let streamLastBull: boolean | null = lastBull;

    for (let j = 0; j < stream.length; j++) {
      const ib = stream[j];
      let isBull: boolean | null = ib.close > ib.open ? true : ib.close < ib.open ? false : null;
      if (isBull === null) {
        const prevClose = j === 0 ? streamLastClose : stream[j - 1].close;
        if (prevClose !== null && Number.isFinite(prevClose)) {
          if (ib.close > prevClose) {
            isBull = true;
          } else if (ib.close < prevClose) {
            isBull = false;
          } else {
            isBull = streamLastBull;
          }
        } else {
          isBull = streamLastBull;
        }
      }

      if (isBull === null && runningDelta !== 0) {
        isBull = runningDelta > 0;
      }
      if (isBull !== null) streamLastBull = isBull;
      runningDelta += isBull === true ? ib.volume : isBull === false ? -ib.volume : 0;
      if (j === stream.length - 1) {
        streamLastClose = ib.close;
      }
    }

    lastClose = Number.isFinite(streamLastClose) ? streamLastClose : lastClose;
    lastBull = streamLastBull;
    deltas.push({ time: parentBars[i].time, delta: runningDelta });
  }

  return deltas;
}

function calculateVolumeDeltaRsiSeries(
  parentBars: OHLCVBar[],
  lowerTimeframeBars: OHLCVBar[],
  interval: string,
  options: { rsiLength?: number } = {},
) {
  const rsiLength = Math.max(1, Math.floor(Number(options.rsiLength) || 14));

  const deltaByBar = computeVolumeDeltaByParentBars(parentBars, lowerTimeframeBars, interval);
  const gains = deltaByBar.map((point) => {
    if (!Number.isFinite(point.delta)) return null;
    return Math.max(Number(point.delta), 0);
  });
  const losses = deltaByBar.map((point) => {
    if (!Number.isFinite(point.delta)) return null;
    return Math.max(-Number(point.delta), 0);
  });

  const avgGains = calculateRMA(gains, rsiLength);
  const avgLosses = calculateRMA(losses, rsiLength);
  const vdRsiRaw = new Array(deltaByBar.length).fill(null);

  for (let i = 0; i < deltaByBar.length; i++) {
    const avgGain = avgGains[i];
    const avgLoss = avgLosses[i];
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) {
      continue;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const value = 100 - 100 / (1 + rs);
    vdRsiRaw[i] = Number.isFinite(value) ? value : null;
  }

  const rsi: { time: number; value: number }[] = [];
  for (let i = 0; i < deltaByBar.length; i++) {
    const time = deltaByBar[i].time;
    const rsiValue = vdRsiRaw[i];
    if (Number.isFinite(rsiValue)) {
      rsi.push({ time, value: Math.round((rsiValue as number) * 100) / 100 });
    }
  }

  const deltaValues = deltaByBar.map((d) => ({
    time: d.time,
    delta: Number.isFinite(d.delta) ? d.delta : 0,
  }));

  return { rsi, deltaValues };
}

// ---------------------------------------------------------------------------
// Time conversion
// ---------------------------------------------------------------------------

function parseDataApiDateTime(datetimeValue: unknown) {
  if (typeof datetimeValue !== 'string') return null;
  const normalized = datetimeValue.trim().replace('T', ' ').replace('Z', '');
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function parseBarTimeToUnixSeconds(bar: Record<string, unknown>) {
  const numeric = normalizeUnixSeconds(bar?.time ?? bar?.timestamp ?? bar?.t);
  if (Number.isFinite(numeric)) return numeric;
  const parts = parseDataApiDateTime(bar?.datetime || bar?.date);
  if (!parts) return null;
  const { year, month, day, hour, minute } = parts;
  const probeDate = new Date(Date.UTC(year, month - 1, day, Math.max(hour, 0), minute, 0));
  const etOffset = probeDate
    .toLocaleString('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    })
    .includes('EST')
    ? -5
    : -4;
  return Math.floor(Date.UTC(year, month - 1, day, hour - etOffset, minute, 0) / 1000);
}

function convertToLATime(bars: Array<Record<string, unknown>>, interval: string) {
  void interval;
  const converted: OHLCVBar[] = [];

  for (const bar of bars) {
    const timestamp = parseBarTimeToUnixSeconds(bar);
    if (!Number.isFinite(timestamp)) continue;

    converted.push({
      time: timestamp as number,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume),
    });
  }

  return converted;
}

function patchLatestBarCloseWithQuote(result: { bars?: OHLCVBar[]; rsi?: Array<{ time: number; value: number }> } | null, quote: { price?: number } | null) {
  if (!result || !Array.isArray(result.bars) || result.bars.length === 0) return;
  const quotePrice = Number(quote && quote.price);
  if (!Number.isFinite(quotePrice) || quotePrice <= 0) return;

  const bars = result.bars;
  const lastIndex = bars.length - 1;
  const last = bars[lastIndex];
  const open = Number(last && last.open);
  const high = Number(last && last.high);
  const low = Number(last && last.low);

  const boundedHigh = Number.isFinite(high)
    ? Math.max(high, quotePrice, Number.isFinite(open) ? open : quotePrice)
    : quotePrice;
  const boundedLow = Number.isFinite(low)
    ? Math.min(low, quotePrice, Number.isFinite(open) ? open : quotePrice)
    : quotePrice;

  bars[lastIndex] = {
    ...last,
    close: quotePrice,
    high: boundedHigh,
    low: boundedLow,
  };

  const closePrices = bars.map((bar) => Number(bar.close));
  const rsiValues = calculateRSI(closePrices, 14);
  const patchedRsi: { time: number; value: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const raw = rsiValues[i];
    if (!Number.isFinite(raw)) continue;
    patchedRsi.push({
      time: bars[i].time,
      value: Math.round(raw * 100) / 100,
    });
  }
  result.rsi = patchedRsi;
}

// ---------------------------------------------------------------------------
// Chart request / response helpers
// ---------------------------------------------------------------------------

function toVolumeDeltaSourceInterval(value: unknown, fallback: string = '1min'): string {
  const normalized = String(value || '').trim();
  return VOLUME_DELTA_SOURCE_INTERVALS.includes(normalized) ? normalized : fallback;
}

function buildChartRequestKey(params: Omit<ChartRequestParams, 'requestKey' | 'skipFollowUpPrewarm'>): string {
  return [
    'v1',
    params.ticker,
    params.interval,
    params.vdRsiLength,
    params.vdSourceInterval,
    params.vdRsiSourceInterval,
    params.lookbackDays,
  ].join('|');
}

function createChartStageTimer() {
  const startedNs = process.hrtime.bigint();
  const stages: { name: string; ms: number }[] = [];
  let previousNs = startedNs;
  const toMs = (durationNs: bigint) => Number(durationNs) / 1e6;
  const fmt = (ms: number) => Number(ms).toFixed(1);
  return {
    step(name: string) {
      const nowNs = process.hrtime.bigint();
      stages.push({ name, ms: toMs(nowNs - previousNs) });
      previousNs = nowNs;
    },
    serverTiming() {
      const totalMs = toMs(process.hrtime.bigint() - startedNs);
      const parts = stages.map((stage) => `${stage.name};dur=${fmt(stage.ms)}`);
      parts.push(`total;dur=${fmt(totalMs)}`);
      return parts.join(', ');
    },
    summary() {
      const totalMs = toMs(process.hrtime.bigint() - startedNs);
      const stageSummary = stages.map((stage) => `${stage.name}=${fmt(stage.ms)}ms`).join(' ');
      return `${stageSummary}${stageSummary ? ' ' : ''}total=${fmt(totalMs)}ms`;
    },
  };
}

function getChartCacheControlHeaderValue(): string {
  const maxAge = Math.max(0, Math.floor(CHART_RESPONSE_MAX_AGE_SECONDS));
  const swr = Math.max(0, Math.floor(CHART_RESPONSE_SWR_SECONDS));
  return `public, max-age=${maxAge}, stale-while-revalidate=${swr}`;
}

function getChartResultCacheExpiryMs(nowUtc = new Date()): number {
  if (CHART_RESULT_CACHE_TTL_SECONDS > 0) {
    return nowUtc.getTime() + CHART_RESULT_CACHE_TTL_SECONDS * 1000;
  }
  return getVdRsiCacheExpiryMs(nowUtc);
}

function ifNoneMatchMatchesEtag(ifNoneMatchHeader: string | undefined, etag: string | undefined): boolean {
  const raw = String(ifNoneMatchHeader || '').trim();
  if (!raw || !etag) return false;
  if (raw === '*') return true;
  const candidates = raw
    .split(',')
    .map((part: string) => part.trim())
    .filter(Boolean);
  return candidates.includes(etag);
}

async function sendChartJsonResponse(req: { headers: Record<string, string | undefined> }, res: { header: (name: string, value: string) => unknown; code: (status: number) => { send: (body?: unknown) => unknown } }, payload: unknown, serverTimingHeader: string | null) {
  const body = JSON.stringify(payload);
  const bodyBuffer = Buffer.from(body);
  const etagHash = crypto.createHash('sha1').update(bodyBuffer).digest('hex').slice(0, 16);
  const etag = `W/"${bodyBuffer.byteLength.toString(16)}-${etagHash}"`;
  const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();

  res.header('Cache-Control', getChartCacheControlHeaderValue());
  res.header('Vary', 'Accept-Encoding');
  res.header('ETag', etag);
  if (serverTimingHeader) {
    res.header('Server-Timing', serverTimingHeader);
  }

  if (ifNoneMatchMatchesEtag(ifNoneMatch, etag)) {
    return res.code(304).send();
  }

  const accepts = String(req.headers['accept-encoding'] || '').toLowerCase();
  const shouldCompress = bodyBuffer.byteLength >= CHART_RESPONSE_COMPRESS_MIN_BYTES;
  res.header('Content-Type', 'application/json; charset=utf-8');

  if (shouldCompress && accepts.includes('br')) {
    try {
      const compressed = await brotliCompressAsync(bodyBuffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        },
      });
      res.header('Content-Encoding', 'br');
      return res.code(200).send(compressed);
    } catch (err: any) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`Brotli compression failed for /api/chart response: ${message}`);
    }
  }

  if (shouldCompress && accepts.includes('gzip')) {
    try {
      const compressed = await gzipAsync(bodyBuffer, {
        level: zlib.constants.Z_BEST_SPEED,
      });
      res.header('Content-Encoding', 'gzip');
      return res.code(200).send(compressed);
    } catch (err: any) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`Gzip compression failed for /api/chart response: ${message}`);
    }
  }

  return res.code(200).send(bodyBuffer);
}

// ---------------------------------------------------------------------------
// Chart result building
// ---------------------------------------------------------------------------

function buildChartResultFromRows(options: ChartBuildOptions = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const interval = String(options.interval || '4hour');
  const rowsByInterval = options.rowsByInterval instanceof Map ? options.rowsByInterval : new Map();
  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(options.vdRsiLength) || 14)));
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const vdRsiSourceInterval = toVolumeDeltaSourceInterval(options.vdRsiSourceInterval, '1min');
  const timer = options.timer || null;

  const convertBarsForInterval = (rows: Array<Record<string, unknown>>, tf: string) =>
    convertToLATime(rows || [], tf).sort((a, b) => Number(a.time) - Number(b.time));
  const directIntervalRows = (rowsByInterval.get(interval) || []) as Array<Record<string, unknown>>;
  const convertedBars = convertBarsForInterval(directIntervalRows, interval);
  if (timer) timer.step('parent_bars');

  if (convertedBars.length === 0) {
    const err = new Error(`No valid ${interval} chart bars available for this ticker`) as Error & { httpStatus: number };
    err.httpStatus = 404;
    throw err;
  }

  const closePrices = convertedBars.map((bar) => bar.close);
  const rsiValues = calculateRSI(closePrices, 14);

  const rsi: { time: number; value: number }[] = [];
  for (let i = 0; i < convertedBars.length; i++) {
    const raw = rsiValues[i];
    if (!Number.isFinite(raw)) continue;
    rsi.push({
      time: convertedBars[i].time,
      value: Math.round(raw * 100) / 100,
    });
  }
  if (timer) timer.step('rsi');

  const normalizeSourceBars = (rows: Array<Record<string, unknown>>, tf: string) =>
    normalizeIntradayVolumesFromCumulativeIfNeeded(
      convertToLATime(rows || [], tf).sort((a, b) => Number(a.time) - Number(b.time)),
    );
  const vdSourceBars = normalizeSourceBars((rowsByInterval.get(vdSourceInterval) || []) as Array<Record<string, unknown>>, vdSourceInterval);
  const vdRsiSourceBars =
    vdRsiSourceInterval === vdSourceInterval
      ? vdSourceBars
      : normalizeSourceBars((rowsByInterval.get(vdRsiSourceInterval) || []) as Array<Record<string, unknown>>, vdRsiSourceInterval);
  if (timer) timer.step('source_bars');

  let volumeDeltaRsi: { rsi: Array<{ time: number; value: number }>; deltaValues?: Array<{ time: number; delta: number }> } = { rsi: [] };
  const cacheExpiryMs = getVdRsiCacheExpiryMs(new Date());
  const firstBarTime = convertedBars[0]?.time ?? '';
  const lastBarTime = convertedBars[convertedBars.length - 1]?.time ?? '';
  const vdRsiResultCacheKey = `v4|${ticker}|${interval}|${vdRsiSourceInterval}|${vdRsiLength}|${convertedBars.length}|${firstBarTime}|${lastBarTime}`;
  const firstParentTime = Number(firstBarTime);
  const lastParentTime = Number(lastBarTime);
  const warmUpBufferSeconds = getIntervalSeconds(interval) * 20;
  const parentWindowStart = Number.isFinite(firstParentTime)
    ? firstParentTime - warmUpBufferSeconds
    : Number.NEGATIVE_INFINITY;
  const parentWindowEndExclusive = Number.isFinite(lastParentTime)
    ? lastParentTime + getIntervalSeconds(interval)
    : Number.POSITIVE_INFINITY;
  const vdSourceBarsInParentRange = vdSourceBars.filter((bar) => {
    const t = Number(bar.time);
    return Number.isFinite(t) && t >= parentWindowStart && t < parentWindowEndExclusive;
  });
  const vdRsiSourceBarsInParentRange = vdRsiSourceBars.filter((bar) => {
    const t = Number(bar.time);
    return Number.isFinite(t) && t >= parentWindowStart && t < parentWindowEndExclusive;
  });
  const volumeDelta = computeVolumeDeltaByParentBars(convertedBars, vdSourceBarsInParentRange, interval).map(
    (point) => ({
      time: point.time,
      delta: Number.isFinite(Number(point.delta)) ? Number(point.delta) : 0,
    }),
  );
  if (timer) timer.step('volume_delta');

  const cachedVolumeDeltaRsi = getTimedCacheValue(VD_RSI_RESULT_CACHE, vdRsiResultCacheKey);
  const cachedVdRsiValue = cachedVolumeDeltaRsi.value as typeof volumeDeltaRsi | null;
  if (cachedVdRsiValue && cachedVdRsiValue.deltaValues) {
    volumeDeltaRsi = cachedVdRsiValue;
  } else {
    try {
      if (vdRsiSourceBarsInParentRange.length > 0) {
        volumeDeltaRsi = calculateVolumeDeltaRsiSeries(convertedBars, vdRsiSourceBarsInParentRange, interval, {
          rsiLength: vdRsiLength,
        });
      } else {
        volumeDeltaRsi = {
          rsi: [],
          deltaValues: computeVolumeDeltaByParentBars(convertedBars, [], interval),
        };
      }
      setTimedCacheValue(VD_RSI_RESULT_CACHE, vdRsiResultCacheKey, volumeDeltaRsi, cacheExpiryMs);
    } catch (volumeDeltaErr: any) {
      const message = volumeDeltaErr && volumeDeltaErr.message ? volumeDeltaErr.message : String(volumeDeltaErr);
      console.warn(`Volume Delta RSI skipped for ${ticker}/${interval}: ${message}`);
    }
  }
  if (timer) timer.step('vd_rsi');

  const result = {
    interval,
    timezone: 'America/Los_Angeles',
    bars: convertedBars,
    rsi,
    volumeDeltaRsi,
    volumeDelta,
    volumeDeltaConfig: {
      sourceInterval: vdSourceInterval,
    },
    volumeDeltaRsiConfig: {
      sourceInterval: vdRsiSourceInterval,
      length: vdRsiLength,
    },
  };
  if (timer) timer.step('assemble');
  return result;
}

// ---------------------------------------------------------------------------
// getOrBuildChartResult (the main chart entry point)
// ---------------------------------------------------------------------------

async function getOrBuildChartResult(
  params: ChartRequestParams,
  deps: { chartDebugMetrics?: Record<string, any>; schedulePostLoadPrewarmSequence?: (opts: Record<string, unknown>) => void } = {},
) {
  const {
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
    requestKey,
    skipFollowUpPrewarm = false,
  } = params;

  const chartDebugMetrics = deps.chartDebugMetrics || {};
  const schedulePostLoadPrewarmSequence = deps.schedulePostLoadPrewarmSequence || (() => {});

  const cachedFinalResult = getTimedCacheValue(CHART_FINAL_RESULT_CACHE, requestKey);
  if (cachedFinalResult.status === 'fresh') {
    if (chartDebugMetrics.cacheHit !== undefined) chartDebugMetrics.cacheHit += 1;
    if (!skipFollowUpPrewarm) {
      if (interval === '1day') {
        if (chartDebugMetrics.prewarmRequested) chartDebugMetrics.prewarmRequested.fourHourFrom1dayCacheHit += 1;
        schedulePostLoadPrewarmSequence({
          ticker,
          sourceInterval: interval,
          targetInterval: '4hour',
          vdRsiLength,
          vdSourceInterval,
          vdRsiSourceInterval,
          lookbackDays,
        });
      }
      if (interval === '1day') {
        if (chartDebugMetrics.prewarmRequested) chartDebugMetrics.prewarmRequested.weeklyFrom1dayCacheHit += 1;
        schedulePostLoadPrewarmSequence({
          ticker,
          sourceInterval: interval,
          targetInterval: '1week',
          vdRsiLength,
          vdSourceInterval,
          vdRsiSourceInterval,
          lookbackDays,
        });
      }
    }
    return cachedFinalResult.value;
  }
  if (cachedFinalResult.status === 'stale') {
    // Serve stale, background-refresh handled below
  }

  // Deduplication: join an existing in-flight request
  if (CHART_IN_FLIGHT_REQUESTS.has(requestKey)) {
    if (chartDebugMetrics.dedupeJoin !== undefined) chartDebugMetrics.dedupeJoin += 1;
    return CHART_IN_FLIGHT_REQUESTS.get(requestKey);
  }

  if (CHART_IN_FLIGHT_REQUESTS.size >= CHART_IN_FLIGHT_MAX) {
    const err = new Error('Too many concurrent chart requests') as Error & { httpStatus: number };
    err.httpStatus = 429;
    throw err;
  }

  if (chartDebugMetrics.cacheMiss !== undefined) chartDebugMetrics.cacheMiss += 1;
  if (chartDebugMetrics.buildStarted !== undefined) chartDebugMetrics.buildStarted += 1;

  const buildPromise = (async () => {
    const timer = CHART_TIMING_LOG_ENABLED ? createChartStageTimer() : null;

    const intervalsToFetch = new Set([interval, vdSourceInterval, vdRsiSourceInterval]);
    const rowsByInterval = new Map();

    await Promise.all(
      Array.from(intervalsToFetch).map(async (tf) => {
        const rows = await dataApiIntradayChartHistory(ticker, tf, lookbackDays);
        rowsByInterval.set(tf, rows || []);
      }),
    );
    if (timer) timer.step('fetch_all');

    const result = buildChartResultFromRows({
      ticker,
      interval,
      rowsByInterval,
      vdRsiLength,
      vdSourceInterval,
      vdRsiSourceInterval,
      timer,
    });

    const freshExpiryMs = getChartResultCacheExpiryMs(new Date());
    const staleExpiryMs = freshExpiryMs + 10 * 60 * 1000;
    setTimedCacheValue(CHART_FINAL_RESULT_CACHE, requestKey, result, freshExpiryMs, staleExpiryMs);

    if (!skipFollowUpPrewarm && (interval === '4hour' || interval === '1day')) {
      if (interval === '1day') {
        if (chartDebugMetrics.prewarmRequested) chartDebugMetrics.prewarmRequested.fourHourFrom1day += 1;
        schedulePostLoadPrewarmSequence({
          ticker,
          sourceInterval: interval,
          targetInterval: '4hour',
          vdRsiLength,
          vdSourceInterval,
          vdRsiSourceInterval,
          lookbackDays,
        });
      }
      if (interval === '1day') {
        if (chartDebugMetrics.prewarmRequested) chartDebugMetrics.prewarmRequested.weeklyFrom1day += 1;
        schedulePostLoadPrewarmSequence({
          ticker,
          sourceInterval: interval,
          targetInterval: '1week',
          vdRsiLength,
          vdSourceInterval,
          vdRsiSourceInterval,
          lookbackDays,
        });
      }
      if (interval === '4hour') {
        if (chartDebugMetrics.prewarmRequested) chartDebugMetrics.prewarmRequested.dailyFrom4hour += 1;
        schedulePostLoadPrewarmSequence({
          ticker,
          sourceInterval: interval,
          targetInterval: '1day',
          vdRsiLength,
          vdSourceInterval,
          vdRsiSourceInterval,
          lookbackDays,
        });
      }
    }

    if (timer) {
      console.log(`[chart-timing] ${ticker}/${interval} ${timer.summary()}`);
    }

    return result;
  })();

  CHART_IN_FLIGHT_REQUESTS.set(requestKey, buildPromise);
  buildPromise.finally(() => {
    CHART_IN_FLIGHT_REQUESTS.delete(requestKey);
  });

  if (cachedFinalResult.status === 'stale') {
    return cachedFinalResult.value;
  }

  return buildPromise;
}

// ---------------------------------------------------------------------------
// Chart latest payload extraction
// ---------------------------------------------------------------------------

function findPointByTime(points: Array<{ time: number | string; [key: string]: unknown }> | undefined, timeValue: unknown) {
  if (!Array.isArray(points) || points.length === 0 || timeValue == null) return null;
  const targetTime = Number(timeValue);
  for (let i = points.length - 1; i >= 0; i--) {
    if (Number(points[i]?.time) === targetTime) return points[i];
  }
  return null;
}

function extractLatestChartPayload(result: Record<string, any> | null) {
  if (!result || !Array.isArray(result.bars) || result.bars.length === 0) {
    return {
      interval: result?.interval || '',
      timezone: result?.timezone || 'America/Los_Angeles',
      latestBar: null,
      latestRsi: null,
      latestVolumeDeltaRsi: null,
      latestVolumeDelta: null,
    };
  }

  const latestBar = result.bars[result.bars.length - 1] || null;
  const barTime = latestBar?.time ?? null;

  return {
    interval: result.interval,
    timezone: result.timezone || 'America/Los_Angeles',
    latestBar,
    latestRsi: findPointByTime(result.rsi, barTime),
    latestVolumeDeltaRsi: findPointByTime(result.volumeDeltaRsi?.rsi, barTime),
    latestVolumeDelta: findPointByTime(result.volumeDelta, barTime),
  };
}

// ---------------------------------------------------------------------------
// Breadth helpers
// ---------------------------------------------------------------------------

async function getSpyDaily() {
  return dataApiDaily('SPY');
}

async function getSpyIntraday(lookbackDays: number = 30) {
  return dataApiIntradayChartHistory('SPY', '30min', lookbackDays);
}

function isRegularHoursEt(dateTimeStr: unknown): boolean {
  const numeric = normalizeUnixSeconds(dateTimeStr);
  if (Number.isFinite(numeric)) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(Number(numeric) * 1000));
    const partMap: Record<string, string> = {};
    for (const part of parts) partMap[part.type] = part.value;
    const h = Number(partMap.hour || 0);
    const m = Number(partMap.minute || 0);
    const totalMin = h * 60 + m;
    return totalMin >= 570 && totalMin <= 960;
  }
  const dateTimeParts = String(dateTimeStr || '').split(' ');
  if (dateTimeParts.length < 2) return false;
  const [h, m] = dateTimeParts[1].split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const totalMin = h * 60 + m;
  return totalMin >= 570 && totalMin <= 960;
}

function roundEtTo30MinEpochMs(dateTimeStr: unknown): number {
  const unixSeconds = normalizeUnixSeconds(dateTimeStr);
  if (Number.isFinite(unixSeconds)) {
    const d = new Date(Number(unixSeconds) * 1000);
    d.setSeconds(0, 0);
    const minutes = d.getUTCMinutes();
    d.setUTCMinutes(minutes < 30 ? 0 : 30);
    return d.getTime();
  }

  const asUTC = new Date(String(dateTimeStr).replace(' ', 'T') + 'Z');
  const nyStr = asUTC.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const nyAsUTC = new Date(nyStr + ' GMT');
  const diff = asUTC.getTime() - nyAsUTC.getTime();
  const d = new Date(asUTC.getTime() + diff);

  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m < 30 ? 0 : 30);
  return d.getTime();
}

function buildIntradayBreadthPoints(spyBars: Array<Record<string, unknown>>, compBars: Array<Record<string, unknown>>, days: number) {
  const todayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = todayET.getFullYear();
  const mo = String(todayET.getMonth() + 1).padStart(2, '0');
  const da = String(todayET.getDate()).padStart(2, '0');
  const todayStr = `${y}-${mo}-${da}`;

  const spyMap = new Map();
  const spyDayByTs = new Map();
  for (const bar of spyBars || []) {
    const unixSeconds = parseBarTimeToUnixSeconds(bar);
    const day = Number.isFinite(unixSeconds)
      ? etDateStringFromUnixSeconds(unixSeconds as number)
      : String(bar.datetime || '').slice(0, 10);
    if (!day) continue;
    if (!isRegularHoursEt(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime)) continue;
    const ts = roundEtTo30MinEpochMs(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime);
    spyMap.set(ts, bar.close);
    spyDayByTs.set(ts, day);
  }

  const compMap = new Map();
  const compDayByTs = new Map();
  for (const bar of compBars || []) {
    const unixSeconds = parseBarTimeToUnixSeconds(bar);
    const day = Number.isFinite(unixSeconds)
      ? etDateStringFromUnixSeconds(unixSeconds as number)
      : String(bar.datetime || '').slice(0, 10);
    if (!day) continue;
    if (!isRegularHoursEt(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime)) continue;
    const ts = roundEtTo30MinEpochMs(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime);
    compMap.set(ts, bar.close);
    compDayByTs.set(ts, day);
  }

  const commonKeys = [...spyMap.keys()].filter((k) => compMap.has(k)).sort((a, b) => a - b);

  if (commonKeys.length === 0) return [];

  const commonDays = Array.from(
    new Set(commonKeys.map((k) => spyDayByTs.get(k) || compDayByTs.get(k)).filter(Boolean)),
  ).sort();
  let selectedDaySet;
  if (days === 1) {
    selectedDaySet = new Set([todayStr]);
  } else {
    selectedDaySet = new Set(commonDays.slice(-days));
  }

  return commonKeys
    .filter((k) => selectedDaySet.has(spyDayByTs.get(k) || compDayByTs.get(k)))
    .map((k) => ({
      date: new Date(k).toISOString(),
      spy: Math.round(spyMap.get(k) * 100) / 100,
      comparison: Math.round(compMap.get(k) * 100) / 100,
    }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  // Types
  type OHLCVBar,
  type ChartRequestParams,

  // Cache instances (needed by index.js for debug metrics and prewarm deps)
  VD_RSI_LOWER_TF_CACHE,
  VD_RSI_RESULT_CACHE,
  CHART_DATA_CACHE,
  CHART_QUOTE_CACHE,
  CHART_FINAL_RESULT_CACHE,
  CHART_IN_FLIGHT_REQUESTS,
  vdRsiCacheCleanupTimer,

  // Constants
  VALID_CHART_INTERVALS,
  VOLUME_DELTA_SOURCE_INTERVALS,
  DIVERGENCE_LOOKBACK_DAYS,
  DIVERGENCE_SUMMARY_BUILD_CONCURRENCY,
  DIVERGENCE_ON_DEMAND_REFRESH_COOLDOWN_MS,
  CHART_TIMING_LOG_ENABLED,
  CHART_INTRADAY_LOOKBACK_DAYS,
  CHART_IN_FLIGHT_MAX,

  // Cache helpers
  getTimedCacheValue,
  setTimedCacheValue,
  sweepExpiredTimedCache,

  // Market hours
  isEtRegularHours,
  nextEtMarketOpenUtcMs,
  todayEtMarketCloseUtcMs,
  getVdRsiCacheExpiryMs,
  nextPacificDivergenceRefreshUtcMs,
  latestCompletedPacificTradeDateKey,

  // Intraday data
  dataApiIntraday,
  dataApiIntradayChartHistory,
  dataApiIntradayChartHistorySingle,
  getIntradayLookbackDays,

  // Technical indicators
  calculateRSI,
  calculateRMA,
  getIntervalSeconds,
  normalizeIntradayVolumesFromCumulativeIfNeeded,
  computeVolumeDeltaByParentBars,
  calculateVolumeDeltaRsiSeries,

  // Time conversion
  parseDataApiDateTime,
  parseBarTimeToUnixSeconds,
  convertToLATime,
  patchLatestBarCloseWithQuote,

  // Chart building
  toVolumeDeltaSourceInterval,
  buildChartRequestKey,
  createChartStageTimer,
  getChartCacheControlHeaderValue,
  getChartResultCacheExpiryMs,
  sendChartJsonResponse,
  buildChartResultFromRows,
  getOrBuildChartResult,
  extractLatestChartPayload,

  // Breadth
  getSpyDaily,
  getSpyIntraday,
  isRegularHoursEt,
  roundEtTo30MinEpochMs,
  buildIntradayBreadthPoints,
};

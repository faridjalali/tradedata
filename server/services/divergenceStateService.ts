import { divergencePool } from '../db.js';
import { classifyDivergenceSignal } from '../chartMath.js';
import { DIVERGENCE_LOOKBACK_DAYS, buildNeutralDivergenceStates } from '../../shared/constants.js';
export { buildNeutralDivergenceStates };
import { pacificDateStringFromUnixSeconds } from '../lib/dateUtils.js';
import { isValidTickerSymbol } from '../middleware.js';
import { nextPacificDivergenceRefreshUtcMs } from './chartEngine.js';


export function computeDivergenceSummaryStatesFromDailyResult(
  result: { bars?: Array<{ time?: number; close?: number }>; volumeDelta?: Array<{ time?: number; delta?: number }> } | null,
  options: { maxTradeDateKey?: string } = {},
) {
  const bars = Array.isArray(result?.bars) ? result.bars : [];
  const volumeDelta = Array.isArray(result?.volumeDelta) ? result.volumeDelta : [];
  const maxTradeDateKey = String(options.maxTradeDateKey || '').trim();
  const deltaByTime = new Map();
  for (const point of volumeDelta) {
    const time = Number(point?.time);
    const delta = Number(point?.delta);
    if (!Number.isFinite(time) || !Number.isFinite(delta)) continue;
    deltaByTime.set(time, delta);
  }

  const unixTimes = [];
  const closes = [];
  const deltaPrefix = [0];
  let runningDelta = 0;
  for (const bar of bars) {
    const unix = Number(bar?.time);
    const close = Number(bar?.close);
    if (!Number.isFinite(unix) || !Number.isFinite(close)) continue;
    if (maxTradeDateKey) {
      const tradeDate = pacificDateStringFromUnixSeconds(unix);
      if (tradeDate && tradeDate > maxTradeDateKey) {
        continue;
      }
    }
    runningDelta += Number(deltaByTime.get(unix) || 0);
    unixTimes.push(unix);
    closes.push(close);
    deltaPrefix.push(runningDelta);
  }

  const states = buildNeutralDivergenceStates();
  if (unixTimes.length < 2) {
    return {
      states,
      tradeDate: '',
    };
  }

  const lastIndex = unixTimes.length - 1;
  const latestUnix = unixTimes[lastIndex];
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    // `days` = trading days; each entry in unixTimes is one trading day.
    const startIndex = lastIndex - days;
    if (startIndex < 0 || startIndex >= lastIndex) continue;
    const startClose = closes[startIndex];
    const endClose = closes[lastIndex];
    if (!Number.isFinite(startClose) || !Number.isFinite(endClose)) continue;
    // Sum only the bars strictly after the start close and up to the latest close.
    // For 1D, this means "latest daily bar delta", not "latest + previous".
    const sumDelta = (deltaPrefix[lastIndex + 1] || 0) - (deltaPrefix[startIndex + 1] || 0);
    if (endClose < startClose && sumDelta > 0) {
      states[String(days)] = 'bullish';
    } else if (endClose > startClose && sumDelta < 0) {
      states[String(days)] = 'bearish';
    }
  }

  return {
    states,
    tradeDate: pacificDateStringFromUnixSeconds(latestUnix),
  };
}


export function getDivergenceSummaryCacheKey(ticker: string, sourceInterval: string) {
  return `${String(ticker || '').toUpperCase()}|${String(sourceInterval || '1min')}`;
}


export function getCachedDivergenceSummaryEntry(ticker: string, sourceInterval: string) {
  return null;
}


export function setDivergenceSummaryCacheEntry(entry: unknown) {
  return;
}


export function clearDivergenceSummaryCacheForSourceInterval(sourceInterval: string) {
  return;
}


export function normalizeDivergenceState(value: unknown) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'bullish' || normalized === 'bearish') return normalized;
  return 'neutral';
}


export function normalizeSummaryMaState(value: unknown) {
  if (value === true) return true;
  if (value === false) return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric === 1) return true;
    if (numeric === 0) return false;
  }
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return false;
}


export function buildDivergenceSummaryEntryFromRow(row: Record<string, unknown>, sourceInterval: string, nowMs: number, expiresAtMs: number) {
  const ticker = String(row?.ticker || '').toUpperCase();
  if (!ticker) return null;
  const entry = {
    ticker,
    sourceInterval,
    tradeDate: String(row?.trade_date || '').trim() || null,
    states: {
      1: normalizeDivergenceState(row?.state_1d),
      3: normalizeDivergenceState(row?.state_3d),
      7: normalizeDivergenceState(row?.state_7d),
      14: normalizeDivergenceState(row?.state_14d),
      28: normalizeDivergenceState(row?.state_28d),
    },
    maStates: {
      ema8: normalizeSummaryMaState(row?.ma8_above),
      ema21: normalizeSummaryMaState(row?.ma21_above),
      sma50: normalizeSummaryMaState(row?.ma50_above),
      sma200: normalizeSummaryMaState(row?.ma200_above),
    },
    computedAtMs: nowMs,
    expiresAtMs,
  };
  setDivergenceSummaryCacheEntry(entry);
  return entry;
}


export async function getStoredDivergenceSummariesForTickers(tickers: string[], sourceInterval: string, options: { includeLatestFallbackForMissing?: boolean } = {}) {
  const map = new Map();
  if (!divergencePool || !Array.isArray(tickers) || tickers.length === 0) {
    return map;
  }
  const includeLatestFallbackForMissing = options.includeLatestFallbackForMissing !== false;

  const normalizedTickers = Array.from(
    new Set(
      tickers
        .map((ticker) => String(ticker || '').toUpperCase())
        .filter((ticker) => ticker && isValidTickerSymbol(ticker)),
    ),
  );
  if (!normalizedTickers.length) {
    return map;
  }

  const nowMs = Date.now();
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));
  const result = await divergencePool.query(
    `
    SELECT DISTINCT ON (ticker)
      ticker,
      trade_date::text AS trade_date,
      state_1d,
      state_3d,
      state_7d,
      state_14d,
      state_28d,
      ma8_above,
      ma21_above,
      ma50_above,
      ma200_above
    FROM divergence_summaries
    WHERE source_interval = $1
      AND ticker = ANY($2::VARCHAR[])
    ORDER BY ticker ASC, trade_date DESC
  `,
    [sourceInterval, normalizedTickers],
  );

  for (const row of result.rows) {
    const entry = buildDivergenceSummaryEntryFromRow(row, sourceInterval, nowMs, expiresAtMs);
    if (!entry) continue;
    map.set(entry.ticker, entry);
  }

  if (!includeLatestFallbackForMissing) {
    return map;
  }

  // Historical compatibility: option retained to preserve callsite semantics.
  return map;
}


/** @deprecated Use buildNeutralDivergenceStates() — kept as alias for existing callers. */
export const buildNeutralDivergenceStateMap = buildNeutralDivergenceStates;


export function classifyDivergenceStateMapFromDailyRows(rows: Array<{ close: number; volume_delta: number }>) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const states = buildNeutralDivergenceStateMap();
  if (safeRows.length < 2) {
    return states;
  }

  const closes = safeRows.map((row) => Number(row.close));
  const deltaPrefix = [0];
  let runningDelta = 0;
  for (let i = 0; i < safeRows.length; i++) {
    runningDelta += Number(safeRows[i].volume_delta) || 0;
    deltaPrefix.push(runningDelta);
  }

  const endIndex = safeRows.length - 1;
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    // `days` = trading days; each row in safeRows is one trading day.
    const startIndex = endIndex - days;
    if (startIndex < 0 || startIndex >= endIndex) continue;
    const startClose = closes[startIndex];
    const endClose = closes[endIndex];
    if (!Number.isFinite(startClose) || !Number.isFinite(endClose)) continue;
    // Sum only the bars strictly after the start close and up to the latest close.
    const sumDelta = (deltaPrefix[endIndex + 1] || 0) - (deltaPrefix[startIndex + 1] || 0);
    if (endClose < startClose && sumDelta > 0) {
      states[String(days)] = 'bullish';
    } else if (endClose > startClose && sumDelta < 0) {
      states[String(days)] = 'bearish';
    }
  }

  return states;
}

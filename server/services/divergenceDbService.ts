import { divergencePool, withDivergenceClient } from '../db.js';
import {
  DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_MIN_UNIVERSE_SIZE,
  DIVERGENCE_SCAN_LOOKBACK_DAYS, DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE,
} from '../config.js';
import {
  currentEtDateString, maxEtDateString, parseDateKeyToUtcMs, dateKeyDaysAgo,
} from '../lib/dateUtils.js';
import {
  buildDataApiUrl, fetchDataApiJson, normalizeTickerSymbol,
  dataApiDailySingle, isAbortError,
} from './dataApi.js';
import {
  classifyDivergenceSignal,
} from '../chartMath.js';
import {
  dataApiIntradayChartHistory, computeVolumeDeltaByParentBars,
  DIVERGENCE_LOOKBACK_DAYS, toVolumeDeltaSourceInterval,
} from './chartEngine.js';
import {
  classifyDivergenceStateMapFromDailyRows, buildNeutralDivergenceStateMap,
} from './divergenceStateService.js';
import { DIVERGENCE_SCAN_PARENT_INTERVAL } from '../config.js';
import { etDateStringFromUnixSeconds } from '../lib/dateUtils.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { isValidTickerSymbol } from '../middleware.js';
import {
  DIVERGENCE_SUMMARY_BUILD_CONCURRENCY,
  convertToLATime,
  latestCompletedPacificTradeDateKey,
  normalizeIntradayVolumesFromCumulativeIfNeeded,
} from './chartEngine.js';
import { assertDataApiKey } from './dataApi.js';
const SCAN_JOB_ALLOWED_COLUMNS = new Set([
  'status', 'finished_at', 'processed_symbols', 'bullish_count',
  'bearish_count', 'error_count', 'notes', 'scanned_trade_date', 'total_symbols',
]);


export async function getPublishedTradeDateForSourceInterval(sourceInterval: string) {
  if (!divergencePool) return '';
  const normalizedSource = String(sourceInterval || DIVERGENCE_SOURCE_INTERVAL);
  try {
    const result = await divergencePool.query(
      `
      SELECT published_trade_date::text AS published_trade_date
      FROM divergence_publication_state
      WHERE source_interval = $1
      LIMIT 1
    `,
      [normalizedSource],
    );
    const explicit = String(result.rows[0]?.published_trade_date || '').trim();
    if (explicit) return explicit;

    const fallback = await divergencePool.query(`
      SELECT scanned_trade_date::text AS scanned_trade_date
      FROM divergence_scan_jobs
      WHERE status = 'completed'
        AND scanned_trade_date IS NOT NULL
      ORDER BY finished_at DESC NULLS LAST, started_at DESC
      LIMIT 1
    `);
    return String(fallback.rows[0]?.scanned_trade_date || '').trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read divergence publication state: ${message}`);
    return '';
  }
}


export async function resolveDivergenceAsOfTradeDate(sourceInterval: string, explicitTradeDate = '') {
  const explicit = String(explicitTradeDate || '').trim();
  if (explicit) return explicit;

  const publishedTradeDate = await getPublishedTradeDateForSourceInterval(sourceInterval);
  const fallbackTradeDate = latestCompletedPacificTradeDateKey(new Date()) || currentEtDateString();
  return (
    maxEtDateString(publishedTradeDate, fallbackTradeDate) ||
    fallbackTradeDate ||
    publishedTradeDate ||
    currentEtDateString()
  );
}


export async function fetchUsStockUniverseFromDataApi() {
  assertDataApiKey();
  const rows = [];
  let nextUrl = buildDataApiUrl('/v3/reference/tickers', {
    market: 'stocks',
    locale: 'us',
    active: 'true',
    order: 'asc',
    sort: 'ticker',
    limit: 1000,
  });
  let guard = 0;
  while (nextUrl && guard < 1000) {
    guard += 1;
    const rawPayload = await fetchDataApiJson(nextUrl, 'DataAPI stock universe');
    const payload = (rawPayload && typeof rawPayload === 'object' ? rawPayload : {}) as Record<string, unknown>;
    const pageRows = Array.isArray(payload.results) ? payload.results : [];
    rows.push(...pageRows);
    nextUrl = typeof payload.next_url === 'string' && payload.next_url.trim() ? payload.next_url.trim() : '';
  }

  const symbols = [];
  for (const row of rows) {
    const symbol = normalizeTickerSymbol(row?.ticker || row?.symbol);
    if (!symbol || symbol.includes('/')) continue;
    const exchange = String(row?.primary_exchange || row?.exchange || '').toUpperCase();
    const type = String(row?.type || row?.asset_type || '').toLowerCase();
    const active = row?.active;
    if (active === false || String(active).toLowerCase() === 'false') continue;
    if (type.includes('etf') || type.includes('fund') || type.includes('etn')) continue;
    symbols.push({
      ticker: symbol,
      exchange: exchange || null,
      assetType: type || null,
    });
  }

  const unique = new Map();
  for (const row of symbols) {
    if (!unique.has(row.ticker)) unique.set(row.ticker, row);
  }
  return Array.from(unique.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}


export async function refreshDivergenceSymbolUniverse(options: { fullReset?: boolean } = {}) {
  const fullReset = Boolean(options.fullReset);
  const symbols = await fetchUsStockUniverseFromDataApi();
  await withDivergenceClient(async (client) => {
    await client.query('BEGIN');
    try {
      if (fullReset) {
        await client.query('UPDATE divergence_symbols SET is_active = FALSE WHERE is_active = TRUE');
      }
      for (const symbol of symbols) {
        await client.query(
          `
          INSERT INTO divergence_symbols(ticker, exchange, asset_type, is_active, updated_at)
          VALUES($1, $2, $3, TRUE, NOW())
          ON CONFLICT (ticker)
          DO UPDATE SET
            exchange = EXCLUDED.exchange,
            asset_type = EXCLUDED.asset_type,
            is_active = TRUE,
            updated_at = NOW()
        `,
          [symbol.ticker, symbol.exchange, symbol.assetType],
        );
      }
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return symbols.map((s) => s.ticker);
}


export async function getDivergenceUniverseTickers(options: { forceRefresh?: boolean } = {}) {
  if (!divergencePool) return [];
  const forceRefresh = Boolean(options.forceRefresh);
  const existing = await divergencePool.query(`
    SELECT ticker
    FROM divergence_symbols
    WHERE is_active = TRUE
    ORDER BY ticker ASC
  `);
  const storedTickers = existing.rows
    .map((row) =>
      String(row.ticker || '')
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean);

  // Long-term persistence: once we have a populated universe, keep using it.
  if (!forceRefresh && storedTickers.length >= DIVERGENCE_MIN_UNIVERSE_SIZE) {
    return storedTickers;
  }

  try {
    const bootstrapped = await refreshDivergenceSymbolUniverse({ fullReset: forceRefresh });
    if (bootstrapped.length > 0) {
      console.log(`Divergence universe bootstrap updated to ${bootstrapped.length} symbols.`);
      return bootstrapped;
    }
    if (storedTickers.length > 0) return storedTickers;
    return [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`DataAPI universe bootstrap failed, falling back to cached divergence symbols: ${message}`);
    return storedTickers;
  }
}


export async function getStoredDivergenceSymbolTickers() {
  if (!divergencePool) return [];
  const existing = await divergencePool.query(`
    SELECT ticker
    FROM divergence_symbols
    WHERE is_active = TRUE
    ORDER BY ticker ASC
  `);
  return existing.rows
    .map((row) =>
      String(row.ticker || '')
        .trim()
        .toUpperCase(),
    )
    .filter((ticker) => ticker && isValidTickerSymbol(ticker));
}


export async function getLatestWeeklySignalTradeDate(sourceInterval: string) {
  if (!divergencePool) return '';
  const normalizedSource = String(sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const result = await divergencePool.query(
    `
    SELECT MAX(trade_date)::text AS trade_date
    FROM divergence_signals
    WHERE timeframe = '1w'
      AND source_interval = $1
  `,
    [normalizedSource],
  );
  return String(result.rows[0]?.trade_date || '').trim();
}


export async function computeSymbolDivergenceSignals(ticker: string, options: { signal?: AbortSignal | null } = {}) {
  const signal = options && options.signal ? options.signal : null;
  const parentFetchInterval = '1day';
  const [parentRows, sourceRows] = await Promise.all([
    dataApiIntradayChartHistory(ticker, parentFetchInterval, DIVERGENCE_SCAN_LOOKBACK_DAYS, { signal }),
    dataApiIntradayChartHistory(ticker, DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_SCAN_LOOKBACK_DAYS, { signal }),
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) {
    return { signals: [], latestTradeDate: '', dailyBar: null };
  }
  const dailyBars = convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return { signals: [], latestTradeDate: '', dailyBar: null };
  }
  const latestDaily = dailyBars[dailyBars.length - 1];
  const latestTradeDate = etDateStringFromUnixSeconds(Number(latestDaily?.time)) || '';

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], DIVERGENCE_SOURCE_INTERVAL).sort((a, b) => Number(a.time) - Number(b.time)),
  );
  const dailyDeltas = computeVolumeDeltaByParentBars(dailyBars, sourceBars, DIVERGENCE_SCAN_PARENT_INTERVAL);
  const deltaByTime = new Map(dailyDeltas.map((point) => [Number(point.time), Number(point.delta) || 0]));

  const results = [];
  const previousDaily = dailyBars[dailyBars.length - 2];
  const latestDelta = Number(deltaByTime.get(Number(latestDaily?.time))) || 0;
  const dailyBar = latestDaily
    ? {
        ticker,
        trade_date: latestTradeDate,
        source_interval: DIVERGENCE_SOURCE_INTERVAL,
        close: Number(latestDaily.close),
        prev_close: Number(previousDaily?.close ?? latestDaily.close),
        volume_delta: latestDelta,
      }
    : null;

  if (latestDaily && previousDaily) {
    const signal = classifyDivergenceSignal(latestDelta, Number(latestDaily.close), Number(previousDaily.close));
    if (signal) {
      results.push({
        ticker,
        signal_type: signal,
        trade_date: etDateStringFromUnixSeconds(Number(latestDaily.time)),
        timeframe: '1d',
        source_interval: DIVERGENCE_SOURCE_INTERVAL,
        price: Number(latestDaily.close),
        prev_close: Number(previousDaily.close),
        volume_delta: latestDelta,
      });
    }
  }

  return { signals: results, latestTradeDate, dailyBar };
}


export async function startDivergenceScanJob(runForDate: string, totalSymbols: number, trigger: string) {
  if (!divergencePool) return null;
  const result = await divergencePool.query(
    `
    INSERT INTO divergence_scan_jobs(run_for_date, status, total_symbols, notes)
    VALUES($1, 'running', $2, $3)
    RETURNING id
  `,
    [runForDate, totalSymbols, `trigger=${trigger}`],
  );
  return Number(result.rows[0]?.id || 0) || null;
}


export async function updateDivergenceScanJob(jobId: number | null, patch: Record<string, unknown>) {
  if (!divergencePool || !jobId) return;
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!SCAN_JOB_ALLOWED_COLUMNS.has(key)) continue;
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx += 1;
  }
  if (!fields.length) return;
  values.push(jobId);
  await divergencePool.query(`UPDATE divergence_scan_jobs SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}


export async function upsertDivergenceSignalsBatch(
  signals: Array<{ ticker: string; signal_type: string; trade_date: string; price: number; prev_close: number; volume_delta: number; timeframe: string; source_interval: string }>,
  scanJobId: number | null,
) {
  if (!divergencePool || !Array.isArray(signals) || signals.length === 0) return;
  const tickers = [];
  const signalTypes = [];
  const tradeDates = [];
  const prices = [];
  const prevCloses = [];
  const deltas = [];
  const timeframes = [];
  const sourceIntervals = [];
  const scanJobIds = [];

  for (const signal of signals) {
    tickers.push(signal.ticker);
    signalTypes.push(signal.signal_type);
    tradeDates.push(signal.trade_date);
    prices.push(Number(signal.price));
    prevCloses.push(Number(signal.prev_close));
    deltas.push(Number(signal.volume_delta));
    timeframes.push(signal.timeframe);
    sourceIntervals.push(signal.source_interval);
    scanJobIds.push(scanJobId ?? null);
  }

  await divergencePool.query(
    `
    INSERT INTO divergence_signals(
      ticker,
      signal_type,
      trade_date,
      price,
      prev_close,
      volume_delta,
      timeframe,
      source_interval,
      timestamp,
      scan_job_id
    )
    SELECT
      s.ticker,
      s.signal_type,
      s.trade_date,
      s.price,
      s.prev_close,
      s.volume_delta,
      s.timeframe,
      s.source_interval,
      NOW(),
      s.scan_job_id
    FROM UNNEST(
      $1::VARCHAR[],
      $2::VARCHAR[],
      $3::DATE[],
      $4::DOUBLE PRECISION[],
      $5::DOUBLE PRECISION[],
      $6::DOUBLE PRECISION[],
      $7::VARCHAR[],
      $8::VARCHAR[],
      $9::INTEGER[]
    ) AS s(
      ticker,
      signal_type,
      trade_date,
      price,
      prev_close,
      volume_delta,
      timeframe,
      source_interval,
      scan_job_id
    )
    ON CONFLICT (trade_date, ticker, timeframe, source_interval)
    DO UPDATE SET
      signal_type = EXCLUDED.signal_type,
      price = EXCLUDED.price,
      prev_close = EXCLUDED.prev_close,
      volume_delta = EXCLUDED.volume_delta,
      timestamp = NOW(),
      scan_job_id = EXCLUDED.scan_job_id
  `,
    [tickers, signalTypes, tradeDates, prices, prevCloses, deltas, timeframes, sourceIntervals, scanJobIds],
  );
}


export function normalizeOneDaySignalTypeFromState(state: unknown) {
  const normalized = String(state || '')
    .trim()
    .toLowerCase();
  if (normalized === 'bullish' || normalized === 'bearish') return normalized;
  return '';
}


export async function syncOneDaySignalsFromSummaryRows(
  summaryRows: Array<Record<string, unknown>>,
  sourceInterval: string,
  scanJobId: number | null = null,
) {
  if (!divergencePool || !Array.isArray(summaryRows) || summaryRows.length === 0) return;
  const signalRows = [];
  const neutralTickers = [];
  const neutralTradeDates = [];

  for (const row of summaryRows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    const tradeDate = String(row?.trade_date || '').trim();
    const signalType = normalizeOneDaySignalTypeFromState(row?.states?.['1']);
    if (!ticker || !tradeDate) continue;
    if (!signalType) {
      neutralTickers.push(ticker);
      neutralTradeDates.push(tradeDate);
      continue;
    }
    const close = Number(row?.latest_close);
    const prevClose = Number(row?.latest_prev_close);
    const volumeDelta = Number(row?.latest_volume_delta);
    if (!Number.isFinite(close) || !Number.isFinite(prevClose) || !Number.isFinite(volumeDelta)) {
      continue;
    }
    signalRows.push({
      ticker,
      signal_type: signalType,
      trade_date: tradeDate,
      timeframe: '1d',
      source_interval: sourceInterval,
      price: close,
      prev_close: prevClose,
      volume_delta: volumeDelta,
    });
  }

  if (signalRows.length > 0) {
    await upsertDivergenceSignalsBatch(signalRows, scanJobId);
  }

  if (neutralTickers.length > 0) {
    await divergencePool.query(
      `
      DELETE FROM divergence_signals AS ds
      USING (
        SELECT
          s.ticker,
          s.trade_date
        FROM UNNEST(
          $1::VARCHAR[],
          $2::DATE[]
        ) AS s(ticker, trade_date)
      ) AS stale
      WHERE ds.ticker = stale.ticker
        AND ds.trade_date = stale.trade_date
        AND ds.timeframe = '1d'
        AND ds.source_interval = $3
    `,
      [neutralTickers, neutralTradeDates, sourceInterval],
    );
  }
}


export async function upsertDivergenceDailyBarsBatch(
  rows: Array<{ ticker?: string; trade_date?: string; source_interval?: string; close?: number; prev_close?: number; volume_delta?: number }>,
  scanJobId: number | null,
) {
  if (!divergencePool || !Array.isArray(rows) || rows.length === 0) return;
  const tickers = [];
  const tradeDates = [];
  const sourceIntervals = [];
  const closes = [];
  const prevCloses = [];
  const deltas = [];
  const scanJobIds = [];

  for (const row of rows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    const tradeDate = String(row?.trade_date || '').trim();
    const sourceInterval =
      String(row?.source_interval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
    const close = Number(row?.close);
    const prevClose = Number(row?.prev_close);
    const volumeDelta = Number(row?.volume_delta);
    if (!ticker || !tradeDate) continue;
    if (!Number.isFinite(close) || !Number.isFinite(prevClose) || !Number.isFinite(volumeDelta)) continue;
    tickers.push(ticker);
    tradeDates.push(tradeDate);
    sourceIntervals.push(sourceInterval);
    closes.push(close);
    prevCloses.push(prevClose);
    deltas.push(volumeDelta);
    scanJobIds.push(scanJobId ?? null);
  }

  if (!tickers.length) return;

  await divergencePool.query(
    `
    INSERT INTO divergence_daily_bars(
      ticker,
      trade_date,
      source_interval,
      close,
      prev_close,
      volume_delta,
      scan_job_id,
      updated_at
    )
    SELECT
      s.ticker,
      s.trade_date,
      s.source_interval,
      s.close,
      s.prev_close,
      s.volume_delta,
      s.scan_job_id,
      NOW()
    FROM UNNEST(
      $1::VARCHAR[],
      $2::DATE[],
      $3::VARCHAR[],
      $4::DOUBLE PRECISION[],
      $5::DOUBLE PRECISION[],
      $6::DOUBLE PRECISION[],
      $7::INTEGER[]
    ) AS s(
      ticker,
      trade_date,
      source_interval,
      close,
      prev_close,
      volume_delta,
      scan_job_id
    )
    ON CONFLICT (ticker, trade_date, source_interval)
    DO UPDATE SET
      close = EXCLUDED.close,
      prev_close = EXCLUDED.prev_close,
      volume_delta = EXCLUDED.volume_delta,
      scan_job_id = EXCLUDED.scan_job_id,
      updated_at = NOW()
  `,
    [tickers, tradeDates, sourceIntervals, closes, prevCloses, deltas, scanJobIds],
  );
}


export async function upsertDivergenceSummaryBatch(
  rows: Array<{ ticker?: string; source_interval?: string; trade_date?: string; states?: Record<string, string>; ma_states?: Record<string, boolean> | null; maStates?: Record<string, boolean> }>,
  scanJobId: number | null,
) {
  if (!divergencePool || !Array.isArray(rows) || rows.length === 0) return;
  const tickers = [];
  const sourceIntervals = [];
  const tradeDates = [];
  const state1d = [];
  const state3d = [];
  const state7d = [];
  const state14d = [];
  const state28d = [];
  const ma8Above = [];
  const ma21Above = [];
  const ma50Above = [];
  const ma200Above = [];
  const scanJobIds = [];

  for (const row of rows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    const sourceInterval =
      String(row?.source_interval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
    const tradeDate = String(row?.trade_date || '').trim();
    if (!ticker || !tradeDate) continue;
    const states = row?.states || {};
    const maStates = row?.ma_states || row?.maStates || {};
    tickers.push(ticker);
    sourceIntervals.push(sourceInterval);
    tradeDates.push(tradeDate);
    state1d.push(String(states['1'] || 'neutral'));
    state3d.push(String(states['3'] || 'neutral'));
    state7d.push(String(states['7'] || 'neutral'));
    state14d.push(String(states['14'] || 'neutral'));
    state28d.push(String(states['28'] || 'neutral'));
    ma8Above.push(typeof maStates.ema8 === 'boolean' ? maStates.ema8 : null);
    ma21Above.push(typeof maStates.ema21 === 'boolean' ? maStates.ema21 : null);
    ma50Above.push(typeof maStates.sma50 === 'boolean' ? maStates.sma50 : null);
    ma200Above.push(typeof maStates.sma200 === 'boolean' ? maStates.sma200 : null);
    scanJobIds.push(scanJobId ?? null);
  }

  if (!tickers.length) return;

  await divergencePool.query(
    `
    INSERT INTO divergence_summaries(
      ticker,
      source_interval,
      trade_date,
      state_1d,
      state_3d,
      state_7d,
      state_14d,
      state_28d,
      ma8_above,
      ma21_above,
      ma50_above,
      ma200_above,
      scan_job_id,
      updated_at
    )
    SELECT
      s.ticker,
      s.source_interval,
      s.trade_date,
      s.state_1d,
      s.state_3d,
      s.state_7d,
      s.state_14d,
      s.state_28d,
      s.ma8_above,
      s.ma21_above,
      s.ma50_above,
      s.ma200_above,
      s.scan_job_id,
      NOW()
    FROM UNNEST(
      $1::VARCHAR[],
      $2::VARCHAR[],
      $3::DATE[],
      $4::VARCHAR[],
      $5::VARCHAR[],
      $6::VARCHAR[],
      $7::VARCHAR[],
      $8::VARCHAR[],
      $9::BOOLEAN[],
      $10::BOOLEAN[],
      $11::BOOLEAN[],
      $12::BOOLEAN[],
      $13::INTEGER[]
    ) AS s(
      ticker,
      source_interval,
      trade_date,
      state_1d,
      state_3d,
      state_7d,
      state_14d,
      state_28d,
      ma8_above,
      ma21_above,
      ma50_above,
      ma200_above,
      scan_job_id
    )
    ON CONFLICT (ticker, source_interval)
    DO UPDATE SET
      trade_date = EXCLUDED.trade_date,
      state_1d = EXCLUDED.state_1d,
      state_3d = EXCLUDED.state_3d,
      state_7d = EXCLUDED.state_7d,
      state_14d = EXCLUDED.state_14d,
      state_28d = EXCLUDED.state_28d,
      ma8_above = COALESCE(EXCLUDED.ma8_above, divergence_summaries.ma8_above),
      ma21_above = COALESCE(EXCLUDED.ma21_above, divergence_summaries.ma21_above),
      ma50_above = COALESCE(EXCLUDED.ma50_above, divergence_summaries.ma50_above),
      ma200_above = COALESCE(EXCLUDED.ma200_above, divergence_summaries.ma200_above),
      scan_job_id = EXCLUDED.scan_job_id,
      updated_at = NOW()
  `,
    [
      tickers,
      sourceIntervals,
      tradeDates,
      state1d,
      state3d,
      state7d,
      state14d,
      state28d,
      ma8Above,
      ma21Above,
      ma50Above,
      ma200Above,
      scanJobIds,
    ],
  );
}


export async function rebuildDivergenceSummariesForTradeDate(options: { sourceInterval?: string; asOfTradeDate?: string; scanJobId?: number | null } = {}) {
  if (!divergencePool) {
    return { asOfTradeDate: '', processedTickers: 0 };
  }
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const scanJobId = Number(options.scanJobId) || null;
  if (!asOfTradeDate) {
    return { asOfTradeDate: '', processedTickers: 0 };
  }

  const maxLookbackTradingDays = Math.max(...DIVERGENCE_LOOKBACK_DAYS);
  // Convert trading days to calendar days (×7/5) with generous buffer for holidays.
  const calendarDaysNeeded = Math.ceil((maxLookbackTradingDays * 7) / 5) + 10;
  const historyStartDate = dateKeyDaysAgo(asOfTradeDate, calendarDaysNeeded) || asOfTradeDate;
  const result = await divergencePool.query(
    `
    SELECT
      ticker,
      trade_date::text AS trade_date,
      close::double precision AS close,
      volume_delta::double precision AS volume_delta
    FROM divergence_daily_bars
    WHERE source_interval = $1
      AND trade_date >= $2::date
      AND trade_date <= $3::date
    ORDER BY ticker ASC, trade_date ASC
  `,
    [sourceInterval, historyStartDate, asOfTradeDate],
  );

  const rowsByTicker = new Map();
  for (const row of result.rows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!rowsByTicker.has(ticker)) rowsByTicker.set(ticker, []);
    rowsByTicker.get(ticker).push({
      trade_date: String(row.trade_date || '').trim(),
      close: Number(row.close),
      volume_delta: Number(row.volume_delta),
    });
  }

  const summaryRows = [];
  for (const [ticker, rows] of rowsByTicker.entries()) {
    const filtered = rows.filter((row: { trade_date: string; close: number; volume_delta: number }) => row.trade_date && row.trade_date <= asOfTradeDate);
    if (!filtered.length) continue;
    const latestRow = filtered[filtered.length - 1];
    if (!latestRow?.trade_date) continue;
    summaryRows.push({
      ticker,
      source_interval: sourceInterval,
      trade_date: latestRow.trade_date,
      states: classifyDivergenceStateMapFromDailyRows(filtered),
    });
  }

  const summaryBatches = [];
  for (let i = 0; i < summaryRows.length; i += DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE) {
    summaryBatches.push(summaryRows.slice(i, i + DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE));
  }
  await mapWithConcurrency(summaryBatches, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY, async (batch) => {
    await upsertDivergenceSummaryBatch(batch, scanJobId);
    return null;
  });
  return { asOfTradeDate, processedTickers: summaryRows.length };
}


export async function publishDivergenceTradeDate(options: { sourceInterval?: string; tradeDate?: string; scanJobId?: number | null } = {}) {
  if (!divergencePool) return '';
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tradeDate = String(options.tradeDate || '').trim();
  const scanJobId = Number(options.scanJobId) || null;
  if (!tradeDate) return '';
  await divergencePool.query(
    `
    INSERT INTO divergence_publication_state(
      source_interval,
      published_trade_date,
      last_scan_job_id,
      updated_at
    )
    VALUES($1, $2, $3, NOW())
    ON CONFLICT (source_interval)
    DO UPDATE SET
      published_trade_date = EXCLUDED.published_trade_date,
      last_scan_job_id = EXCLUDED.last_scan_job_id,
      updated_at = NOW()
  `,
    [sourceInterval, tradeDate, scanJobId],
  );
  return tradeDate;
}

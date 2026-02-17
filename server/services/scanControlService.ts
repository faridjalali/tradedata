import { ScanState } from '../lib/ScanState.js';
import {
  DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS, DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS,
  DIVERGENCE_SCAN_LOOKBACK_DAYS,
} from '../config.js';
import {
  currentEtDateString, parseDateKeyToUtcMs, dateKeyDaysAgo,
  easternLocalToUtcMs, dateKeyFromYmdParts, pacificDateTimeParts,
} from '../lib/dateUtils.js';
import * as tradingCalendar from './tradingCalendar.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { isValidTickerSymbol } from '../middleware.js';

export interface DivergenceScanResumeState {
  runDateEt: string;
  trigger: string;
  symbols: string[];
  totalSymbols: number;
  nextIndex: number;
  processed: number;
  bullishCount: number;
  bearishCount: number;
  errorCount: number;
  latestScannedTradeDate: string;
  summaryProcessedTickers: number;
  scanJobId: number | null;
}

export interface DivergenceTableBuildResumeState {
  sourceInterval: string;
  asOfTradeDate: string;
  requestedLookbackDays: number;
  tickers: string[];
  totalTickers: number;
  backfillTickers: string[];
  backfillOffset: number;
  summarizeOffset: number;
  errorTickers: number;
  phase: string;
  lastPublishedTradeDate: string;
}

export interface TableBuildStatus {
  running: boolean;
  status: string;
  totalTickers: number;
  processedTickers: number;
  errorTickers: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastPublishedTradeDate: string | null;
}

export let divergenceScanRunning = false;
export let divergenceSchedulerTimer: ReturnType<typeof setTimeout> | null = null;
export let divergenceLastScanDateEt = '';
export let divergenceLastFetchedTradeDateEt = '';
export let divergenceScanPauseRequested = false;
export let divergenceScanStopRequested = false;
export let divergenceScanResumeState: DivergenceScanResumeState | null = null;
export let divergenceScanAbortController: AbortController | null = null;
export let divergenceTableBuildRunning = false;
export let divergenceTableBuildPauseRequested = false;
export let divergenceTableBuildStopRequested = false;
export let divergenceTableBuildResumeState: DivergenceTableBuildResumeState | null = null;
export let divergenceTableBuildAbortController: AbortController | null = null;
export let divergenceTableBuildStatus: TableBuildStatus = {
  running: false,
  status: 'idle',
  totalTickers: 0,
  processedTickers: 0,
  errorTickers: 0,
  startedAt: null,
  finishedAt: null,
  lastPublishedTradeDate: null,
};

export const fetchDailyScan = new ScanState('fetchDaily', { metricsKey: 'fetchDaily' });
export const fetchWeeklyScan = new ScanState('fetchWeekly', { metricsKey: 'fetchWeekly' });


export function getDivergenceTableBuildStatus() {
  return {
    running: Boolean(divergenceTableBuildRunning),
    pause_requested: Boolean(divergenceTableBuildPauseRequested),
    stop_requested: Boolean(divergenceTableBuildStopRequested),
    can_resume: !divergenceTableBuildRunning && Boolean(divergenceTableBuildResumeState),
    status: String(divergenceTableBuildStatus.status || 'idle'),
    total_tickers: Number(divergenceTableBuildStatus.totalTickers || 0),
    processed_tickers: Number(divergenceTableBuildStatus.processedTickers || 0),
    error_tickers: Number(divergenceTableBuildStatus.errorTickers || 0),
    started_at: divergenceTableBuildStatus.startedAt || null,
    finished_at: divergenceTableBuildStatus.finishedAt || null,
    last_published_trade_date: divergenceTableBuildStatus.lastPublishedTradeDate || null,
  };
}


export function getDivergenceScanControlStatus() {
  return {
    running: Boolean(divergenceScanRunning),
    pause_requested: Boolean(divergenceScanPauseRequested),
    stop_requested: Boolean(divergenceScanStopRequested),
    can_resume: !divergenceScanRunning && Boolean(divergenceScanResumeState),
  };
}


export function requestPauseDivergenceScan() {
  if (!divergenceScanRunning) return false;
  divergenceScanPauseRequested = true;
  if (divergenceScanAbortController && !divergenceScanAbortController.signal.aborted) {
    try {
      divergenceScanAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}


export function requestStopDivergenceScan() {
  if (!divergenceScanRunning) return false;
  divergenceScanStopRequested = true;
  divergenceScanPauseRequested = false;
  if (divergenceScanAbortController && !divergenceScanAbortController.signal.aborted) {
    try {
      divergenceScanAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}


export function canResumeDivergenceScan() {
  return !divergenceScanRunning && Boolean(divergenceScanResumeState);
}


export function requestPauseDivergenceTableBuild() {
  if (!divergenceTableBuildRunning) return false;
  divergenceTableBuildPauseRequested = true;
  return true;
}


export function requestStopDivergenceTableBuild() {
  if (!divergenceTableBuildRunning) {
    if (!divergenceTableBuildResumeState) {
      return false;
    }
    divergenceTableBuildPauseRequested = false;
    divergenceTableBuildStopRequested = false;
    divergenceTableBuildResumeState = null;
    divergenceTableBuildStatus = {
      ...divergenceTableBuildStatus,
      running: false,
      status: 'stopped',
      finishedAt: new Date().toISOString(),
    };
    return true;
  }
  divergenceTableBuildStopRequested = true;
  divergenceTableBuildPauseRequested = false;
  divergenceTableBuildStatus.status = 'stopping';
  if (divergenceTableBuildAbortController && !divergenceTableBuildAbortController.signal.aborted) {
    try {
      divergenceTableBuildAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}


export function canResumeDivergenceTableBuild() {
  return !divergenceTableBuildRunning && Boolean(divergenceTableBuildResumeState);
}

export function normalizeFetchDailyDataResumeState(state: Record<string, any> = {}) {
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const sourceInterval = String(state.sourceInterval || '').trim();
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((t: string) =>
          String(t || '')
            .trim()
            .toUpperCase(),
        )
        .filter((t: string) => t && isValidTickerSymbol(t))
    : [];
  const totalTickers = tickers.length;
  const nextIndex = Math.max(0, Math.min(totalTickers, Math.floor(Number(state.nextIndex) || 0)));
  return {
    asOfTradeDate,
    sourceInterval,
    tickers,
    totalTickers,
    nextIndex,
    processedTickers: Math.max(0, Math.floor(Number(state.processedTickers) || 0)),
    errorTickers: Math.max(0, Math.floor(Number(state.errorTickers) || 0)),
    lookbackDays: Math.max(28, Math.floor(Number(state.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS)),
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim(),
  };
}


export function normalizeFetchWeeklyDataResumeState(state: Record<string, any> = {}) {
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const weeklyTradeDate = String(state.weeklyTradeDate || '').trim();
  const sourceInterval = String(state.sourceInterval || '').trim();
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((t: string) =>
          String(t || '')
            .trim()
            .toUpperCase(),
        )
        .filter((t: string) => t && isValidTickerSymbol(t))
    : [];
  const totalTickers = tickers.length;
  const nextIndex = Math.max(0, Math.min(totalTickers, Math.floor(Number(state.nextIndex) || 0)));
  return {
    asOfTradeDate,
    weeklyTradeDate,
    sourceInterval,
    tickers,
    totalTickers,
    nextIndex,
    processedTickers: Math.max(0, Math.floor(Number(state.processedTickers) || 0)),
    errorTickers: Math.max(0, Math.floor(Number(state.errorTickers) || 0)),
    lookbackDays: Math.max(28, Math.floor(Number(state.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS)),
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim(),
  };
}


export function resolveLastClosedDailyCandleDate(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const totalMinutes = nowEt.getHours() * 60 + nowEt.getMinutes();
  const todayStr = currentEtDateString(nowUtc);

  if (tradingCalendar.isTradingDay(todayStr)) {
    // On early-close days candle is available at 1:16 PM ET (796 min);
    // on normal days at 4:16 PM ET (976 min).
    const threshold = tradingCalendar.isEarlyClose(todayStr) ? 796 : 976;
    const candleAvailableMinute = Math.max(threshold, Number(process.env.CANDLE_AVAILABLE_MINUTE_ET) || threshold);
    if (totalMinutes >= candleAvailableMinute) {
      return todayStr;
    }
  }

  // Not a trading day or before threshold — return previous trading day
  return tradingCalendar.previousTradingDay(todayStr);
}


export function resolveLastClosedWeeklyCandleDate(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = nowEt.getDay(); // 0=Sun, 6=Sat
  const totalMinutes = nowEt.getHours() * 60 + nowEt.getMinutes();
  const candleAvailableMinute = 976; // 4:16 PM ET

  // Friday at/after 4:16 PM ET -> this week's close is available
  // (but only if Friday is actually a trading day).
  if (
    dayOfWeek === 5 &&
    totalMinutes >= candleAvailableMinute &&
    tradingCalendar.isTradingDay(currentEtDateString(nowUtc))
  ) {
    return currentEtDateString(nowUtc);
  }

  // Walk back to the last Friday that was a trading day.
  const prev = new Date(nowEt);
  prev.setDate(prev.getDate() - 1);
  for (let i = 0; i < 30; i++) {
    if (prev.getDay() === 5) {
      const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
      if (tradingCalendar.isTradingDay(key)) return key;
    }
    prev.setDate(prev.getDate() - 1);
  }
  // Absolute fallback
  const yyyy = prev.getFullYear();
  const mm = String(prev.getMonth() + 1).padStart(2, '0');
  const dd = String(prev.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}


export function normalizeDivergenceScanResumeState(state: Record<string, any> = {}): DivergenceScanResumeState {
  const runDateEt = String(state.runDateEt || '').trim();
  const trigger = String(state.trigger || 'manual').trim() || 'manual';
  const symbols = Array.isArray(state.symbols)
    ? state.symbols
        .map((symbol: string) =>
          String(symbol || '')
            .trim()
            .toUpperCase(),
        )
        .filter((symbol: string) => symbol && isValidTickerSymbol(symbol))
    : [];
  const totalSymbols = symbols.length;
  const nextIndex = Math.max(0, Math.min(totalSymbols, Math.floor(Number(state.nextIndex) || 0)));
  const scanJobId = Number(state.scanJobId) || null;
  return {
    runDateEt,
    trigger,
    symbols,
    totalSymbols,
    nextIndex,
    processed: Math.max(0, Math.floor(Number(state.processed) || 0)),
    bullishCount: Math.max(0, Math.floor(Number(state.bullishCount) || 0)),
    bearishCount: Math.max(0, Math.floor(Number(state.bearishCount) || 0)),
    errorCount: Math.max(0, Math.floor(Number(state.errorCount) || 0)),
    latestScannedTradeDate: String(state.latestScannedTradeDate || '').trim(),
    summaryProcessedTickers: Math.max(0, Math.floor(Number(state.summaryProcessedTickers) || 0)),
    scanJobId,
  };
}


export function normalizeDivergenceTableResumeState(state: Record<string, any> = {}): DivergenceTableBuildResumeState {
  const sourceInterval =
    String(state.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const requestedLookbackDays = Math.max(
    45,
    Math.floor(Number(state.requestedLookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS),
  );
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((ticker: string) => String(ticker || '').toUpperCase())
        .filter((ticker: string) => ticker && isValidTickerSymbol(ticker))
    : [];
  const tickerSet = new Set(tickers);
  const backfillTickers = Array.isArray(state.backfillTickers)
    ? state.backfillTickers
        .map((ticker: unknown) => String(ticker || '').toUpperCase())
        .filter((ticker: string) => tickerSet.has(ticker))
    : [];
  const totalTickers = Number.isFinite(Number(state.totalTickers))
    ? Math.max(0, Math.floor(Number(state.totalTickers)))
    : tickers.length;
  const backfillOffset = Math.max(0, Math.floor(Number(state.backfillOffset) || 0));
  const summarizeOffset = Math.max(0, Math.floor(Number(state.summarizeOffset) || 0));
  const errorTickers = Math.max(0, Math.floor(Number(state.errorTickers) || 0));
  const phaseRaw = String(state.phase || '')
    .trim()
    .toLowerCase();
  const phase = phaseRaw === 'summarizing' ? 'summarizing' : 'backfilling';
  return {
    sourceInterval,
    asOfTradeDate,
    requestedLookbackDays,
    tickers,
    totalTickers,
    backfillTickers,
    backfillOffset: Math.min(backfillOffset, backfillTickers.length),
    summarizeOffset: Math.min(summarizeOffset, tickers.length),
    errorTickers,
    phase,
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim(),
  };
}

// --- Setter functions for mutable state (required for ES module cross-file assignment) ---
export function setDivergenceScanRunning(v: boolean) { divergenceScanRunning = v; }
export function setDivergenceSchedulerTimer(v: ReturnType<typeof setTimeout> | null) { divergenceSchedulerTimer = v; }
export function setDivergenceLastScanDateEt(v: string) { divergenceLastScanDateEt = v; }
export function setDivergenceLastFetchedTradeDateEt(v: string) { divergenceLastFetchedTradeDateEt = v; }
export function setDivergenceScanPauseRequested(v: boolean) { divergenceScanPauseRequested = v; }
export function setDivergenceScanStopRequested(v: boolean) { divergenceScanStopRequested = v; }
export function setDivergenceScanResumeState(v: DivergenceScanResumeState | null) { divergenceScanResumeState = v; }
export function setDivergenceScanAbortController(v: AbortController | null) { divergenceScanAbortController = v; }
export function setDivergenceTableBuildRunning(v: boolean) { divergenceTableBuildRunning = v; }
export function setDivergenceTableBuildPauseRequested(v: boolean) { divergenceTableBuildPauseRequested = v; }
export function setDivergenceTableBuildStopRequested(v: boolean) { divergenceTableBuildStopRequested = v; }
export function setDivergenceTableBuildResumeState(v: DivergenceTableBuildResumeState | null) { divergenceTableBuildResumeState = v; }
export function setDivergenceTableBuildAbortController(v: AbortController | null) { divergenceTableBuildAbortController = v; }
export function setDivergenceTableBuildStatus(v: TableBuildStatus) { divergenceTableBuildStatus = v; }

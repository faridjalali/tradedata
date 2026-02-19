// Shared API types — single source of truth for frontend ↔ backend contract.
// Frontend imports these directly; backend references them via JSDoc.

import type { VALID_CHART_INTERVALS } from './constants';

// --- Chart types ---

export type ChartInterval = (typeof VALID_CHART_INTERVALS)[number];

export interface CandleBar {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RSIPoint {
  time: string | number;
  value: number;
}

export interface VolumeDeltaPoint {
  time: string | number;
  delta: number;
}

export type CandleBarTuple = [number, number, number, number, number, number];
export type RSIPointTuple = [number, number];

export interface ChartData {
  interval: ChartInterval;
  timezone: string;
  bars: CandleBar[];
  rsi: RSIPoint[];
  volumeDeltaRsi: {
    rsi: RSIPoint[];
  };
  volumeDelta?: VolumeDeltaPoint[];
}

export interface ChartLatestData {
  interval: ChartInterval;
  timezone: string;
  latestBar: CandleBar | null;
  latestRsi: RSIPoint | null;
  latestVolumeDeltaRsi: RSIPoint | null;
  latestVolumeDelta: VolumeDeltaPoint | null;
}

// --- Divergence / Alert types ---

export interface Alert {
  id: number;
  ticker: string;
  signal_type: string;
  price?: number;
  message?: string;
  timestamp?: string;
  signal_trade_date?: string | null;
  timeframe?: string;
  signal_direction?: number;
  signal_volume?: number;
  is_favorite: boolean;
  source?: 'TV' | 'DataAPI';
  divergence_states?: Record<string, string>;
  divergence_trade_date?: string | null;
  ma_states?: {
    ema8?: boolean;
    ema21?: boolean;
    sma50?: boolean;
    sma200?: boolean;
  };
  vdf_detected?: boolean;
  vdf_score?: number;
  vdf_proximity?: string;
  bull_flag_confidence?: number | null;
}

export type DivergenceState = 'bullish' | 'bearish' | 'neutral';

export interface DivergenceSummaryEntry {
  ticker: string;
  tradeDate: string | null;
  states: Record<string, DivergenceState>;
  expiresAtMs: number;
}

export interface DivergenceSummaryApiPayload {
  sourceInterval?: string;
  refreshedAt?: string;
  summaries?: Array<{
    ticker?: string;
    tradeDate?: string | null;
    states?: Record<string, string>;
    expiresAtMs?: number;
  }>;
}

// --- Divergence scan status ---

/** Shared shape for fetch/scan sub-statuses (fetchDailyData, fetchWeeklyData, vdfScan). */
export interface ScanSubStatus {
  running?: boolean;
  stop_requested?: boolean;
  can_resume?: boolean;
  status?: string;
  total_tickers?: number;
  processed_tickers?: number;
  error_tickers?: number;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface DivergenceScanStatus {
  running: boolean;
  lastScanDateEt: string | null;
  scanControl?: {
    running?: boolean;
    pause_requested?: boolean;
    stop_requested?: boolean;
    can_resume?: boolean;
  } | null;
  tableBuild?: (ScanSubStatus & {
    pause_requested?: boolean;
    last_published_trade_date?: string | null;
  }) | null;
  fetchDailyData?: (ScanSubStatus & {
    last_published_trade_date?: string | null;
  }) | null;
  fetchWeeklyData?: (ScanSubStatus & {
    last_published_trade_date?: string | null;
  }) | null;
  vdfScan?: (ScanSubStatus & {
    detected_tickers?: number;
  }) | null;
  latestJob: {
    run_for_date?: string;
    scanned_trade_date?: string;
    status?: string;
    started_at?: string;
    finished_at?: string;
    processed_symbols?: number;
    total_symbols?: number;
    bullish_count?: number;
    bearish_count?: number;
    error_count?: number;
  } | null;
}

// --- Breadth types ---

export interface BreadthDataPoint {
  date: string;
  spy: number;
  comparison: number;
}

export interface BreadthResponse {
  intraday: boolean;
  points: BreadthDataPoint[];
}

// --- Breadth MA (% above moving averages) types ---

export interface BreadthMASnapshot {
  index: string;       // 'SPY' | 'QQQ' | 'SMH'
  date: string;
  ma21: number;        // percentage 0-100
  ma50: number;
  ma100: number;
  ma200: number;
  total: number;       // total constituents evaluated
}

export interface BreadthMAHistory {
  date: string;
  ma21: number;
  ma50: number;
  ma100: number;
  ma200: number;
  /** Index ETF close price for this date (SPY/QQQ/SMH). May be absent if fetch failed. */
  close?: number;
}

export interface BreadthMAResponse {
  snapshots: BreadthMASnapshot[];
  history: Record<string, BreadthMAHistory[]>;
}

// --- Run metrics / logs types ---

export interface RunTickerMetrics {
  total?: number;
  processed?: number;
  errors?: number;
  processedPerSecond?: number;
}

export interface RunApiMetrics {
  calls?: number;
  failures?: number;
  rateLimited?: number;
  timedOut?: number;
  p95LatencyMs?: number;
  avgLatencyMs?: number;
}

export interface RunDbMetrics {
  flushCount?: number;
  summaryRows?: number;
  signalRows?: number;
  avgFlushMs?: number;
}

export interface RunMetricsSnapshot {
  runId?: string;
  runType?: string;
  status?: string;
  phase?: string;
  startedAt?: string;
  finishedAt?: string | null;
  durationSeconds?: number;
  tickers?: RunTickerMetrics;
  api?: RunApiMetrics;
  db?: RunDbMetrics;
  failedTickers?: string[];
  retryRecovered?: string[];
}

export interface RunMetricsPayload {
  generatedAt?: string;
  schedulerEnabled?: boolean;
  config?: {
    divergenceSourceInterval?: string;
    divergenceLookbackDays?: number;
    divergenceConcurrencyConfigured?: number;
    divergenceFlushSize?: number;
    dataApiBase?: string;
    dataApiTimeoutMs?: number;
    dataApiMaxRequestsPerSecond?: number;
    dataApiRateBucketCapacity?: number;
  };
  statuses?: {
    fetchDaily?: { status?: string; running?: boolean; processed_tickers?: number; total_tickers?: number } | null;
    fetchWeekly?: { status?: string; running?: boolean; processed_tickers?: number; total_tickers?: number } | null;
    vdfScan?: {
      status?: string;
      running?: boolean;
      processed_tickers?: number;
      total_tickers?: number;
      detected_tickers?: number;
    } | null;
  };
  runs?: {
    fetchDaily?: RunMetricsSnapshot | null;
    fetchWeekly?: RunMetricsSnapshot | null;
    vdfScan?: RunMetricsSnapshot | null;
  };
  history?: RunMetricsSnapshot[];
}

// --- VDF types ---

export interface VDFZone {
  startDate: string;
  endDate: string;
  score: number;
  windowDays: number;
  absorptionPct?: number;
  netDeltaPct?: number;
  accumWeekRatio?: number;
  overallPriceChange?: number;
  accumWeeks?: number;
  weeks?: number;
  durationMultiplier?: number;
  concordancePenalty?: number;
  concordantFrac?: number;
  components?: {
    s1: number;
    s2: number;
    s3: number;
    s4: number;
    s5: number;
    s6: number;
    s7: number;
    s8?: number;
  };
}

export interface VDFDistribution {
  startDate: string;
  endDate: string;
  spanDays: number;
  priceChangePct?: number;
  netDeltaPct?: number;
}

export interface VDFProximity {
  compositeScore: number;
  level: string;
  signals: Array<{ type: string; points: number; detail: string }>;
}

export interface VDFCacheEntry {
  is_detected: boolean;
  composite_score: number;
  status: string;
  weeks: number;
  bull_flag_confidence?: number | null;
  zones: VDFZone[];
  allZones: VDFZone[];
  distribution: VDFDistribution[];
  proximity: VDFProximity;
  details?: {
    metrics?: {
      totalDays?: number;
      scanStart?: string;
      scanEnd?: string;
      preDays?: number;
      recentCutoff?: string;
    };
    reason?: string;
  };
}

// --- Admin types ---

export interface AdminStatusPayload {
  status: string;
  uptimeSeconds: number;
  timestamp: string;
  shuttingDown: boolean;
  ready: boolean;
  degraded: boolean;
  primaryDb: boolean | null;
  divergenceDb: boolean | null;
  divergenceConfigured: boolean;
  divergenceScanRunning: boolean;
  lastScanDateEt: string | null;
  circuitBreaker: string;
  dbPool?: { total: number; idle: number; waiting: number; max: number } | null;
  warnings?: string[];
}

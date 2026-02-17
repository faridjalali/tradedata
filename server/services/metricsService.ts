import { pool } from '../db.js';
import {
  CHART_TIMING_SAMPLE_MAX, RUN_METRICS_SAMPLE_CAP, RUN_METRICS_HISTORY_LIMIT,
  DIVERGENCE_SOURCE_INTERVAL,
} from '../config.js';
import {
  DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS,
  DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE,
  DIVERGENCE_SCANNER_ENABLED,
  DIVERGENCE_TABLE_BUILD_CONCURRENCY,
} from '../config.js';
import {
  fetchDailyScan,
  fetchWeeklyScan,
  getDivergenceScanControlStatus,
  getDivergenceTableBuildStatus,
} from './scanControlService.js';
import { vdfScan } from './vdfService.js';

const RUN_METRICS_DB_LIMIT = 200;

export interface RunMetricsInternal {
  runId: string;
  runType: string;
  status: string;
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  tickers: { total: number; processed: number; errors: number };
  api: {
    calls: number; successes: number; failures: number;
    rateLimited: number; timedOut: number; aborted: number;
    subscriptionRestricted: number; totalLatencyMs: number;
    latencySamples: number[];
  };
  db: {
    flushCount: number; totalFlushMs: number; maxFlushMs: number;
    dailyRows: number; summaryRows: number; signalRows: number; neutralRows: number;
  };
  stalls: { retries: number; watchdogAborts: number };
  failedTickers: string[];
  retryRecovered: string[];
  meta: Record<string, unknown>;
}

export interface RunMetricsSummary {
  runId: string;
  runType: string;
  status: string;
  phase: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  durationSeconds: number;
  tickers: { total: number; processed: number; errors: number; processedPerSecond: number };
  api: {
    calls: number; successes: number; failures: number;
    rateLimited: number; timedOut: number; aborted: number;
    subscriptionRestricted: number; avgLatencyMs: number;
    p50LatencyMs: number; p95LatencyMs: number;
  };
  db: {
    flushCount: number; dailyRows: number; summaryRows: number;
    signalRows: number; neutralRows: number; avgFlushMs: number; maxFlushMs: number;
  };
  stalls: { retries: number; watchdogAborts: number };
  failedTickers: string[];
  retryRecovered: string[];
  meta: Record<string, unknown>;
}

export interface ChartTimingSummary {
  count: number;
  cacheHitCount: number;
  cacheMissCount: number;
  chartCount: number;
  chartLatestCount: number;
  p95Ms: number;
  cacheHitP95Ms: number;
  cacheMissP95Ms: number;
}

export interface ChartDebugMetrics {
  cacheHit: number;
  cacheMiss: number;
  buildStarted: number;
  dedupeJoin: number;
  prewarmRequested: Record<string, number>;
  prewarmCompleted: number;
  prewarmFailed: number;
  requestTimingByInterval: Record<string, ChartTimingSummary>;
}

export const chartDebugMetrics: ChartDebugMetrics = {
  cacheHit: 0,
  cacheMiss: 0,
  buildStarted: 0,
  dedupeJoin: 0,
  prewarmRequested: {
    dailyFrom4hour: 0,
    fourHourFrom1day: 0,
    weeklyFrom1day: 0,
    weeklyFrom4hour: 0,
    dailyFromWeekly: 0,
    fourHourFromWeekly: 0,
    other: 0,
  },
  prewarmCompleted: 0,
  prewarmFailed: 0,
  requestTimingByInterval: {},
};

export const httpDebugMetrics = {
  totalRequests: 0,
  apiRequests: 0,
};

export const chartTimingSamplesByKey = new Map<string, number[]>();

export const runMetricsByType: Record<string, RunMetricsInternal | null> = {
  fetchDaily: null,
  fetchWeekly: null,
  vdfScan: null,
};

export const runMetricsHistory: RunMetricsSummary[] = [];


export function clampTimingSample(valueMs: number | undefined | null) {
  const numeric = Number(valueMs);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100) / 100;
}


export function pushTimingSample(cacheKey: string, valueMs: number | undefined | null) {
  const value = clampTimingSample(valueMs);
  if (value === null) return;
  let samples = chartTimingSamplesByKey.get(cacheKey);
  if (!samples) {
    samples = [];
    chartTimingSamplesByKey.set(cacheKey, samples);
  }
  samples.push(value);
  if (samples.length > CHART_TIMING_SAMPLE_MAX) {
    samples.shift();
  }
}


export function calculateP95Ms(samples: number[] | undefined) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return Math.round(sorted[index] * 100) / 100;
}


export function getOrCreateChartTimingSummary(interval: string): ChartTimingSummary {
  const key = String(interval || '').trim() || 'unknown';
  if (!chartDebugMetrics.requestTimingByInterval[key]) {
    chartDebugMetrics.requestTimingByInterval[key] = {
      count: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      chartCount: 0,
      chartLatestCount: 0,
      p95Ms: 0,
      cacheHitP95Ms: 0,
      cacheMissP95Ms: 0,
    };
  }
  return chartDebugMetrics.requestTimingByInterval[key];
}


export function recordChartRequestTiming(options: { interval?: string; route?: string; cacheHit?: boolean; durationMs?: number } = {}) {
  const interval = String(options.interval || '').trim() || 'unknown';
  const route = options.route === 'chart_latest' ? 'chart_latest' : 'chart';
  const cacheHit = options.cacheHit === true;
  const durationMs = clampTimingSample(options.durationMs);
  if (durationMs === null) return;

  const summary = getOrCreateChartTimingSummary(interval);
  summary.count += 1;
  if (route === 'chart_latest') {
    summary.chartLatestCount += 1;
  } else {
    summary.chartCount += 1;
  }
  if (cacheHit) {
    summary.cacheHitCount += 1;
  } else {
    summary.cacheMissCount += 1;
  }

  pushTimingSample(`${interval}|all`, durationMs);
  pushTimingSample(`${interval}|${cacheHit ? 'hit' : 'miss'}`, durationMs);
  summary.p95Ms = calculateP95Ms(chartTimingSamplesByKey.get(`${interval}|all`));
  summary.cacheHitP95Ms = calculateP95Ms(chartTimingSamplesByKey.get(`${interval}|hit`));
  summary.cacheMissP95Ms = calculateP95Ms(chartTimingSamplesByKey.get(`${interval}|miss`));
}


export function clampMetricNumber(value: number | undefined | null, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** Math.max(0, Number(digits) || 0);
  return Math.round(numeric * factor) / factor;
}


export function percentileFromSortedSamples(samples: number[] | undefined, percentile: number) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const p = Math.max(0, Math.min(1, Number(percentile) || 0));
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * p) - 1));
  const value = Number(samples[index]);
  return Number.isFinite(value) ? value : 0;
}


export function summarizeRunMetrics(metrics: RunMetricsInternal | null): RunMetricsSummary | null {
  if (!metrics || typeof metrics !== 'object') return null;
  const samples = Array.isArray(metrics.api?.latencySamples)
    ? [...metrics.api.latencySamples].sort((a, b) => a - b)
    : [];
  const calls = Number(metrics.api?.calls || 0);
  const avgLatencyMs = calls > 0 ? clampMetricNumber(Number(metrics.api?.totalLatencyMs || 0) / calls, 2) : 0;
  const startedMs = Date.parse(String(metrics.startedAt || ''));
  const finishedMs = Date.parse(String(metrics.finishedAt || metrics.updatedAt || ''));
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs ? finishedMs - startedMs : 0;
  const durationSeconds = durationMs > 0 ? durationMs / 1000 : 0;
  const processed = Number(metrics.tickers?.processed || 0);
  return {
    runId: metrics.runId,
    runType: metrics.runType,
    status: String(metrics.status || 'unknown'),
    phase: String(metrics.phase || ''),
    startedAt: metrics.startedAt || null,
    finishedAt: metrics.finishedAt || null,
    updatedAt: metrics.updatedAt || null,
    durationSeconds: clampMetricNumber(durationSeconds, 2),
    tickers: {
      total: Number(metrics.tickers?.total || 0),
      processed,
      errors: Number(metrics.tickers?.errors || 0),
      processedPerSecond: durationSeconds > 0 ? clampMetricNumber(processed / durationSeconds, 3) : 0,
    },
    api: {
      calls,
      successes: Number(metrics.api?.successes || 0),
      failures: Number(metrics.api?.failures || 0),
      rateLimited: Number(metrics.api?.rateLimited || 0),
      timedOut: Number(metrics.api?.timedOut || 0),
      aborted: Number(metrics.api?.aborted || 0),
      subscriptionRestricted: Number(metrics.api?.subscriptionRestricted || 0),
      avgLatencyMs,
      p50LatencyMs: clampMetricNumber(percentileFromSortedSamples(samples, 0.5), 2),
      p95LatencyMs: clampMetricNumber(percentileFromSortedSamples(samples, 0.95), 2),
    },
    db: {
      flushCount: Number(metrics.db?.flushCount || 0),
      dailyRows: Number(metrics.db?.dailyRows || 0),
      summaryRows: Number(metrics.db?.summaryRows || 0),
      signalRows: Number(metrics.db?.signalRows || 0),
      neutralRows: Number(metrics.db?.neutralRows || 0),
      avgFlushMs:
        Number(metrics.db?.flushCount || 0) > 0
          ? clampMetricNumber(Number(metrics.db?.totalFlushMs || 0) / Number(metrics.db?.flushCount || 1), 2)
          : 0,
      maxFlushMs: clampMetricNumber(Number(metrics.db?.maxFlushMs || 0), 2),
    },
    stalls: {
      retries: Number(metrics.stalls?.retries || 0),
      watchdogAborts: Number(metrics.stalls?.watchdogAborts || 0),
    },
    failedTickers: Array.isArray(metrics.failedTickers) ? [...metrics.failedTickers] : [],
    retryRecovered: Array.isArray(metrics.retryRecovered) ? [...metrics.retryRecovered] : [],
    meta: metrics.meta || {},
  };
}


export function pushRunMetricsHistory(snapshot: RunMetricsSummary | null) {
  if (!snapshot) return;
  runMetricsHistory.unshift(snapshot);
  if (runMetricsHistory.length > RUN_METRICS_HISTORY_LIMIT) {
    runMetricsHistory.length = RUN_METRICS_HISTORY_LIMIT;
  }
  persistRunSnapshotToDb(snapshot);
}


export function persistRunSnapshotToDb(snapshot: RunMetricsSummary | null) {
  if (!snapshot || !snapshot.runId) return;
  pool
    .query(
      `INSERT INTO run_metrics_history (run_id, run_type, status, snapshot, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id) DO UPDATE SET status = $3, snapshot = $4, finished_at = $6`,
      [
        snapshot.runId,
        snapshot.runType || 'unknown',
        snapshot.status || 'unknown',
        JSON.stringify(snapshot),
        snapshot.startedAt || null,
        snapshot.finishedAt || null,
      ],
    )
    .then(() => {
      // Prune old rows beyond the limit
      return pool.query(
        `DELETE FROM run_metrics_history WHERE id NOT IN (
         SELECT id FROM run_metrics_history ORDER BY created_at DESC LIMIT $1
       )`,
        [RUN_METRICS_DB_LIMIT],
      );
    })
    .catch((err) => {
      console.error('Failed to persist run snapshot:', err.message);
    });
}


export async function loadRunHistoryFromDb() {
  try {
    const result = await pool.query(`SELECT snapshot FROM run_metrics_history ORDER BY created_at DESC LIMIT $1`, [
      RUN_METRICS_DB_LIMIT,
    ]);
    return result.rows.map((r) => r.snapshot);
  } catch (err: any) {
    console.error('Failed to load run history from DB:', err.message);
    return [];
  }
}


export function createRunMetricsTracker(runType: string, meta: Record<string, unknown> = {}) {
  const normalizedType = String(runType || '').trim() || 'unknown';
  const runId = `${normalizedType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const metrics = {
    runId,
    runType: normalizedType,
    status: 'running',
    phase: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null as string | null,
    updatedAt: new Date().toISOString(),
    tickers: {
      total: 0,
      processed: 0,
      errors: 0,
    },
    api: {
      calls: 0,
      successes: 0,
      failures: 0,
      rateLimited: 0,
      timedOut: 0,
      aborted: 0,
      subscriptionRestricted: 0,
      totalLatencyMs: 0,
      latencySamples: [] as number[],
    },
    db: {
      flushCount: 0,
      totalFlushMs: 0,
      maxFlushMs: 0,
      dailyRows: 0,
      summaryRows: 0,
      signalRows: 0,
      neutralRows: 0,
    },
    stalls: {
      retries: 0,
      watchdogAborts: 0,
    },
    failedTickers: [] as string[],
    retryRecovered: [] as string[],
    meta: {
      ...meta,
    },
  };

  runMetricsByType[normalizedType] = metrics;
  let finished = false;

  const touch = () => {
    metrics.updatedAt = new Date().toISOString();
  };

  return {
    get runId() {
      return runId;
    },
    setMeta(patch = {}) {
      if (!patch || typeof patch !== 'object') return;
      metrics.meta = { ...metrics.meta, ...patch };
      touch();
    },
    setPhase(phase: string) {
      metrics.phase = String(phase || '').trim() || metrics.phase;
      touch();
    },
    setTotals(totalTickers: number) {
      metrics.tickers.total = Math.max(0, Number(totalTickers) || 0);
      touch();
    },
    setProgress(processedTickers: number, errorTickers: number) {
      metrics.tickers.processed = Math.max(0, Number(processedTickers) || 0);
      metrics.tickers.errors = Math.max(0, Number(errorTickers) || 0);
      touch();
    },
    recordApiCall(details: { latencyMs?: number; ok?: boolean; rateLimited?: boolean; timedOut?: boolean; aborted?: boolean; subscriptionRestricted?: boolean } = {}) {
      const latencyMs = Math.max(0, Number(details.latencyMs) || 0);
      metrics.api.calls += 1;
      metrics.api.totalLatencyMs += latencyMs;
      if (metrics.api.latencySamples.length >= RUN_METRICS_SAMPLE_CAP) {
        metrics.api.latencySamples.shift();
      }
      metrics.api.latencySamples.push(latencyMs);
      if (details.ok) {
        metrics.api.successes += 1;
      } else {
        metrics.api.failures += 1;
      }
      if (details.rateLimited) metrics.api.rateLimited += 1;
      if (details.timedOut) metrics.api.timedOut += 1;
      if (details.aborted) metrics.api.aborted += 1;
      if (details.subscriptionRestricted) metrics.api.subscriptionRestricted += 1;
      touch();
    },
    recordDbFlush(details: { durationMs?: number; dailyRows?: number; summaryRows?: number; signalRows?: number; neutralRows?: number } = {}) {
      const durationMs = Math.max(0, Number(details.durationMs) || 0);
      metrics.db.flushCount += 1;
      metrics.db.totalFlushMs += durationMs;
      metrics.db.maxFlushMs = Math.max(metrics.db.maxFlushMs, durationMs);
      metrics.db.dailyRows += Math.max(0, Number(details.dailyRows) || 0);
      metrics.db.summaryRows += Math.max(0, Number(details.summaryRows) || 0);
      metrics.db.signalRows += Math.max(0, Number(details.signalRows) || 0);
      metrics.db.neutralRows += Math.max(0, Number(details.neutralRows) || 0);
      touch();
    },
    recordFailedTicker(ticker: string) {
      const name = String(ticker || '')
        .trim()
        .toUpperCase();
      if (name && metrics.failedTickers.length < 500) {
        metrics.failedTickers.push(name);
      }
      touch();
    },
    recordRetryRecovered(ticker: string) {
      const name = String(ticker || '')
        .trim()
        .toUpperCase();
      if (name && metrics.retryRecovered.length < 500) {
        metrics.retryRecovered.push(name);
      }
      // Also remove from failedTickers
      const idx = metrics.failedTickers.indexOf(name);
      if (idx !== -1) metrics.failedTickers.splice(idx, 1);
      touch();
    },
    recordStallRetry() {
      metrics.stalls.retries += 1;
      touch();
    },
    recordWatchdogAbort() {
      metrics.stalls.watchdogAborts += 1;
      touch();
    },
    finish(status: string, patch: { totalTickers?: number; processedTickers?: number; errorTickers?: number; phase?: string; meta?: Record<string, unknown> } = {}) {
      if (finished) return summarizeRunMetrics(metrics);
      finished = true;
      metrics.status = String(status || 'completed').trim() || 'completed';
      if (patch && typeof patch === 'object') {
        if (Number.isFinite(Number(patch.totalTickers))) {
          metrics.tickers.total = Math.max(0, Number(patch.totalTickers));
        }
        if (Number.isFinite(Number(patch.processedTickers))) {
          metrics.tickers.processed = Math.max(0, Number(patch.processedTickers));
        }
        if (Number.isFinite(Number(patch.errorTickers))) {
          metrics.tickers.errors = Math.max(0, Number(patch.errorTickers));
        }
        if (patch.phase) {
          metrics.phase = String(patch.phase);
        }
        if (patch.meta && typeof patch.meta === 'object') {
          metrics.meta = { ...metrics.meta, ...patch.meta };
        }
      }
      metrics.finishedAt = new Date().toISOString();
      touch();
      const snapshot = summarizeRunMetrics(metrics);
      pushRunMetricsHistory(snapshot);
      return snapshot;
    },
    snapshot() {
      return summarizeRunMetrics(metrics);
    },
  };
}


export function getLogsRunMetricsPayload() {
  return {
    generatedAt: new Date().toISOString(),
    schedulerEnabled: Boolean(DIVERGENCE_SCANNER_ENABLED),
    config: {
      divergenceSourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      divergenceLookbackDays: DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS,
      divergenceConcurrencyConfigured: DIVERGENCE_TABLE_BUILD_CONCURRENCY,
      divergenceFlushSize: DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE,
      dataApiBase: String(process.env.DATA_API_BASE || 'https://api.massive.com'),
      dataApiTimeoutMs: Number(process.env.DATA_API_TIMEOUT_MS) || 15000,
      dataApiMaxRequestsPerSecond: Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99,
      dataApiRateBucketCapacity: Number(process.env.DATA_API_RATE_BUCKET_CAPACITY) || Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99,
    },
    statuses: {
      fetchDaily: fetchDailyScan.getStatus(),
      fetchWeekly: fetchWeeklyScan.getStatus(),
      scan: getDivergenceScanControlStatus(),
      table: getDivergenceTableBuildStatus(),
      vdfScan: vdfScan.getStatus(),
    },
    runs: {
      fetchDaily: summarizeRunMetrics(runMetricsByType.fetchDaily),
      fetchWeekly: summarizeRunMetrics(runMetricsByType.fetchWeekly),
      vdfScan: summarizeRunMetrics(runMetricsByType.vdfScan),
    },
    history: runMetricsHistory.slice(0, RUN_METRICS_HISTORY_LIMIT),
  };
}

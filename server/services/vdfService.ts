import { divergencePool } from '../db.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { currentEtDateString } from '../lib/dateUtils.js';
import { detectVDF } from './vdfDetector.js';
import { dataApiIntradayChartHistory } from './chartEngine.js';
import { ScanState } from '../lib/ScanState.js';
import { isAbortError, sleepWithAbort } from './dataApi.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { isDivergenceConfigured } from '../db.js';
import { runRetryPasses } from '../lib/ScanState.js';
import { resolveAdaptiveFetchConcurrency } from '../lib/mapWithConcurrency.js';
import { CHART_DATA_CACHE, sweepExpiredTimedCache } from './chartEngine.js';
import { getStoredDivergenceSymbolTickers } from './divergenceDbService.js';
import { createRunMetricsTracker, runMetricsByType } from './metricsService.js';

const vdfRunningTickers = new Set<string>();
export const vdfScan = new ScanState('vdfScan', { metricsKey: 'vdfScan' });


export async function getStoredVDFResult(ticker: string, tradeDate: string) {
  if (!isDivergenceConfigured()) return null;
  try {
    const { rows } = await divergencePool!.query(
      `SELECT is_detected, composite_score, status, weeks, result_json,
              best_zone_score, proximity_score, proximity_level, num_zones, has_distribution,
              bull_flag_confidence
       FROM vdf_results WHERE ticker = $1 AND trade_date = $2 LIMIT 1`,
      [ticker, tradeDate],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    let parsed: Record<string, any> = {};
    try {
      parsed = row.result_json ? JSON.parse(row.result_json) : {};
    } catch {
      /* ignore */
    }
    return {
      is_detected: row.is_detected,
      composite_score: Number(row.composite_score) || 0,
      status: row.status || '',
      weeks: Number(row.weeks) || 0,
      best_zone_score: Number(row.best_zone_score) || 0,
      proximity_score: Number(row.proximity_score) || 0,
      proximity_level: row.proximity_level || 'none',
      num_zones: Number(row.num_zones) || 0,
      has_distribution: row.has_distribution || false,
      bull_flag_confidence: row.bull_flag_confidence != null ? Number(row.bull_flag_confidence) : null,
      zones: parsed.zones || [],
      distribution: parsed.distribution || [],
      proximity: parsed.proximity || { compositeScore: 0, level: 'none', signals: [] },
      details: parsed,
    };
  } catch (err: any) {
    console.error('getStoredVDFResult error:', err && err.message ? err.message : err);
    return null;
  }
}


export async function upsertVDFResult(ticker: string, tradeDate: string, result: Record<string, any>) {
  if (!isDivergenceConfigured()) return;
  try {
    const bestScore = result.bestScore || result.score || 0;
    const proxScore = result.proximity?.compositeScore || 0;
    const proxLevel = result.proximity?.level || 'none';
    const numZones = result.zones?.length || 0;
    const hasDist = (result.distribution?.length || 0) > 0;
    const resultJson = JSON.stringify({
      zones: result.zones || [],
      distribution: result.distribution || [],
      proximity: result.proximity || { compositeScore: 0, level: 'none', signals: [] },
      metrics: result.metrics || null,
      reason: result.reason || '',
    });
    await divergencePool!.query(
      `INSERT INTO vdf_results (ticker, trade_date, is_detected, composite_score, status, weeks, result_json,
                                best_zone_score, proximity_score, proximity_level, num_zones, has_distribution, bull_flag_confidence, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (ticker, trade_date) DO UPDATE SET
         is_detected = EXCLUDED.is_detected,
         composite_score = EXCLUDED.composite_score,
         status = EXCLUDED.status,
         weeks = EXCLUDED.weeks,
         result_json = EXCLUDED.result_json,
         best_zone_score = EXCLUDED.best_zone_score,
         proximity_score = EXCLUDED.proximity_score,
         proximity_level = EXCLUDED.proximity_level,
         num_zones = EXCLUDED.num_zones,
         has_distribution = EXCLUDED.has_distribution,
         bull_flag_confidence = EXCLUDED.bull_flag_confidence,
         updated_at = NOW()`,
      [
        ticker,
        tradeDate,
        result.detected || false,
        bestScore,
        result.status || '',
        result.bestZoneWeeks || result.weeks || 0,
        resultJson,
        bestScore,
        proxScore,
        proxLevel,
        numZones,
        hasDist,
        result.bull_flag_confidence ?? null,
      ],
    );
  } catch (err: any) {
    console.error('upsertVDFResult error:', err && err.message ? err.message : err);
  }
}


export async function getVDFStatus(ticker: string, options: { force?: boolean; signal?: AbortSignal | null; noCache?: boolean; mode?: string } = {}) {
  const force = options.force === true;
  const signal = options.signal || null;
  const noCache = options.noCache === true;
  const mode = options.mode || 'scan'; // 'chart' = 1yr overlays + 3mo scoring, 'scan' = 3mo only
  const today = currentEtDateString();

  // Check DB cache (same trading day) unless force
  if (!force) {
    const cached = await getStoredVDFResult(ticker, today);
    if (cached) return { ...cached, cached: true };
  }

  // Prevent parallel detection for the same ticker
  if (vdfRunningTickers.has(ticker)) {
    return {
      is_detected: false,
      composite_score: 0,
      status: 'Detection in progress',
      weeks: 0,
      best_zone_score: 0,
      proximity_score: 0,
      proximity_level: 'none',
      num_zones: 0,
      has_distribution: false,
      bull_flag_confidence: null as number | null,
      zones: [],
      distribution: [],
      proximity: { compositeScore: 0, level: 'none', signals: [] },
      cached: false,
    };
  }
  vdfRunningTickers.add(ticker);

  try {
    const fetcher = noCache
      ? (sym: string, intv: string, days: number, opts: Record<string, any> = {}) => dataApiIntradayChartHistory(sym, intv, days, { ...opts, noCache: true })
      : dataApiIntradayChartHistory;
    const result = await detectVDF(ticker, {
      dataApiFetcher: fetcher,
      signal: signal || undefined,
      mode: mode as 'chart' | 'scan',
    });

    // Store in DB
    await upsertVDFResult(ticker, today, result);

    return {
      is_detected: result.detected || false,
      composite_score: result.bestScore || 0,
      status: result.status || '',
      weeks: result.bestZoneWeeks || 0,
      best_zone_score: result.bestScore || 0,
      proximity_score: result.proximity?.compositeScore || 0,
      proximity_level: result.proximity?.level || 'none',
      num_zones: result.zones?.length || 0,
      has_distribution: (result.distribution?.length || 0) > 0,
      bull_flag_confidence: result.bull_flag_confidence ?? null,
      zones: result.zones || [],
      allZones: result.allZones || result.zones || [],
      distribution: result.distribution || [],
      proximity: result.proximity || { compositeScore: 0, level: 'none', signals: [] },
      details: { metrics: result.metrics, reason: result.reason },
      cached: false,
    };
  } finally {
    vdfRunningTickers.delete(ticker);
  }
}


/**
 * Injectable I/O dependencies for runVDFScan.
 * All fields are optional; production code uses the real implementations.
 * Tests inject stubs to avoid database and network calls.
 */
export interface VdfScanDeps {
  /** Whether the divergence DB is reachable. Defaults to isDivergenceConfigured(). */
  isConfigured?: () => boolean;
  /** Fetch the full universe of tickers. Defaults to getStoredDivergenceSymbolTickers(). */
  getTickers?: () => Promise<string[]>;
  /**
   * Run per-ticker VDF detection. May throw on error (worker catches and wraps).
   * Defaults to getVDFStatus(ticker, { force, noCache, signal }).
   */
  detectTicker?: (ticker: string, signal: AbortSignal) => Promise<unknown>;
  /** Sweep the in-memory cache. Defaults to sweepExpiredTimedCache(CHART_DATA_CACHE). */
  sweepCache?: () => void;
  /**
   * Factory for the run-metrics tracker. Pass `() => null` in tests to suppress DB writes.
   * Defaults to createRunMetricsTracker.
   */
  createMetricsTracker?: typeof createRunMetricsTracker;
}

export async function runVDFScan(options: { resume?: boolean; _deps?: VdfScanDeps } = {}) {
  const { _deps = {} } = options;
  const resolveIsConfigured = _deps.isConfigured ?? isDivergenceConfigured;
  const resolveGetTickers = _deps.getTickers ?? getStoredDivergenceSymbolTickers;
  const resolveDetectTicker = _deps.detectTicker ?? ((ticker: string, signal: AbortSignal) =>
    getVDFStatus(ticker, { force: true, noCache: true, signal }));
  const resolveSweepCache = _deps.sweepCache ?? (() => sweepExpiredTimedCache(CHART_DATA_CACHE));
  const resolveCreateMetricsTracker = _deps.createMetricsTracker ?? createRunMetricsTracker;

  if (!resolveIsConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (vdfScan.isRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const rs = resumeRequested ? vdfScan.currentResumeState : null;
  if (
    resumeRequested &&
    (!rs || !Array.isArray(rs.tickers) || rs.tickers.length === 0 || Number(rs.nextIndex) >= rs.tickers.length)
  ) {
    return { status: 'no-resume' };
  }

  const scanAbort = vdfScan.beginRun(resumeRequested);
  runMetricsByType.vdfScan = null;

  let processedTickers = Math.max(0, Number(rs?.processedTickers || 0));
  let errorTickers = Math.max(0, Number(rs?.errorTickers || 0));
  let detectedTickers = Math.max(0, Number(rs?.detectedTickers || 0));
  let totalTickers = Math.max(0, Number(rs?.totalTickers || 0));
  const startedAtIso = new Date().toISOString();
  const failedTickers: string[] = [];
  let tickers: string[] = (rs && Array.isArray(rs.tickers)) ? (rs.tickers as string[]) : [];
  let startIndex = Math.max(0, Number(rs?.nextIndex || 0));

  vdfScan.setStatus({
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
  });
  vdfScan.setExtraStatus({ detected_tickers: detectedTickers });

  // VDF scan: each ticker fetches 220 days of 1-min data (~8 API slices each),
  // creating massive memory pressure. Cap concurrency at 3 to prevent OOM.
  // The adaptive calculator was producing 11+ which caused ~9GB cache buildup.
  const runConcurrency = Math.min(3, resolveAdaptiveFetchConcurrency('vdf-scan'));
  let runMetricsTracker: ReturnType<typeof createRunMetricsTracker> | null = null;

  const syncExtra = () => vdfScan.setExtraStatus({ detected_tickers: detectedTickers });
  const buildStatusFields = (proc?: number) => ({
    totalTickers,
    processedTickers: proc ?? processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
  });

  const vdfWorker = async (ticker: string) => {
    if (vdfScan.shouldStop) return { ticker, skipped: true };
    const apiStart = Date.now();
    try {
      const result = await resolveDetectTicker(ticker, scanAbort.signal);
      const latencyMs = Date.now() - apiStart;
      if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: true });
      return { ticker, result, error: null };
    } catch (err: unknown) {
      const latencyMs = Date.now() - apiStart;
      if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: false });
      return { ticker, result: null, error: err };
    }
  };

  try {
    resolveSweepCache();

    if (!resumeRequested) {
      tickers = await resolveGetTickers();
      startIndex = 0;
      processedTickers = 0;
      errorTickers = 0;
      detectedTickers = 0;
    }

    totalTickers = tickers.length;
    vdfScan.setStatus({ totalTickers });
    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;
    console.log(
      `VDF scan${resumeRequested ? ' (resumed)' : ''}: ${totalTickers} tickers (starting at ${startIndex}), concurrency=${runConcurrency}, noCache=true`,
    );

    runMetricsTracker = resolveCreateMetricsTracker('vdfScan', { totalTickers, concurrency: runConcurrency });
    runMetricsTracker?.setTotals(totalTickers);
    runMetricsTracker?.setPhase('core');

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      vdfWorker,
      (settled) => {
        const s = settled as { ticker: string; skipped?: boolean; error?: unknown; result?: unknown };
        if (s.skipped) return;
        settledCount++;
        processedTickers = startIndex + settledCount;
        if (s.error) {
          errorTickers++;
          failedTickers.push(s.ticker);
          if (!(vdfScan.isStopping && isAbortError(s.error))) {
            const msg = s.error instanceof Error ? s.error.message : String(s.error);
            console.error(`VDF scan error for ${s.ticker}:`, msg);
          }
        } else if (s.result && (s.result as Record<string, unknown>).is_detected) {
          detectedTickers++;
        }
        vdfScan.updateProgress(processedTickers, errorTickers);
        syncExtra();
        if (processedTickers % 100 === 0) resolveSweepCache();
        if (runMetricsTracker) runMetricsTracker.setProgress(processedTickers, errorTickers);
      },
      () => vdfScan.shouldStop,
    );

    if (vdfScan.shouldStop) {
      const safe = vdfScan.saveResumeState(
        { tickers, totalTickers, processedTickers, errorTickers, detectedTickers },
        runConcurrency,
      );
      vdfScan.markStopped(buildStatusFields(safe));
      syncExtra();
      runMetricsTracker?.finish('stopped', { totalTickers, processedTickers: safe, errorTickers, meta: { failedTickers } });
      return { status: 'stopped', processedTickers: safe, errorTickers, detectedTickers };
    }

    // Retry failed tickers (2 passes via shared helper)
    if (failedTickers.length > 0 && !vdfScan.shouldStop) {
      vdfScan.setStatus({ status: 'running-retry' });
      await runRetryPasses({
        failedTickers,
        baseConcurrency: runConcurrency,
        worker: vdfWorker,
        onRecovered: (settled) => {
          errorTickers--;
          if (settled.result && (settled.result as Record<string, unknown>).is_detected) detectedTickers++;
          vdfScan.updateProgress(processedTickers, errorTickers);
          syncExtra();
        },
        shouldStop: () => vdfScan.shouldStop,
        metricsTracker: runMetricsTracker,
        mapWithConcurrency,
      });
    }

    vdfScan.markCompleted(buildStatusFields());
    syncExtra();
    const finalStatus = vdfScan.getStatus().status;
    runMetricsTracker?.finish(finalStatus, { totalTickers, processedTickers, errorTickers, meta: { failedTickers } });
    return { status: finalStatus, processedTickers, errorTickers, detectedTickers };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`VDF scan failed: ${message}`);

    if (vdfScan.isStopping || isAbortError(err)) {
      const safe = vdfScan.saveResumeState(
        { tickers, totalTickers, processedTickers, errorTickers, detectedTickers },
        runConcurrency,
      );
      vdfScan.markStopped(buildStatusFields(safe));
      syncExtra();
      runMetricsTracker?.finish('stopped', { totalTickers, processedTickers: safe, errorTickers, meta: { failedTickers } });
      return { status: 'stopped', processedTickers: safe, errorTickers, detectedTickers };
    }

    vdfScan.markFailed(buildStatusFields());
    syncExtra();
    runMetricsTracker?.finish('failed', { totalTickers, processedTickers, errorTickers, meta: { failedTickers } });
    return { status: 'failed', error: message };
  } finally {
    vdfScan.cleanup(scanAbort);
  }
}

import { divergencePool } from '../db.js';
import {
  DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_SCAN_PARENT_INTERVAL,
  DIVERGENCE_SCAN_LOOKBACK_DAYS, DIVERGENCE_SCAN_CONCURRENCY,
  DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY, DIVERGENCE_SCAN_SPREAD_MINUTES,
  DIVERGENCE_STALL_TIMEOUT_MS, DIVERGENCE_STALL_CHECK_INTERVAL_MS,
  DIVERGENCE_STALL_RETRY_BASE_MS, DIVERGENCE_STALL_MAX_RETRIES,
} from '../config.js';
import { currentEtDateString, maxEtDateString, dateKeyDaysAgo } from '../lib/dateUtils.js';
import {
  isAbortError, sleepWithAbort, createProgressStallWatchdog,
  getStallRetryBackoffMs, runWithAbortAndTimeout,
} from '../services/dataApi.js';
import { runRetryPasses } from '../lib/ScanState.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { isDivergenceConfigured } from '../db.js';
import { ScanState } from '../lib/ScanState.js';
import { linkAbortSignalToController } from '../services/dataApi.js';
import {
  computeSymbolDivergenceSignals,
  getDivergenceUniverseTickers,
  publishDivergenceTradeDate,
  rebuildDivergenceSummariesForTradeDate,
  startDivergenceScanJob,
  updateDivergenceScanJob,
  upsertDivergenceDailyBarsBatch,
  upsertDivergenceSignalsBatch,
} from '../services/divergenceDbService.js';
import { clearDivergenceSummaryCacheForSourceInterval } from '../services/divergenceStateService.js';
import {
  divergenceLastFetchedTradeDateEt,
  divergenceLastScanDateEt,
  divergenceScanAbortController,
  divergenceScanPauseRequested,
  divergenceScanResumeState,
  divergenceScanRunning,
  divergenceScanStopRequested,
  fetchDailyScan,
  fetchWeeklyScan,
  normalizeDivergenceScanResumeState,
  setDivergenceLastFetchedTradeDateEt,
  setDivergenceLastScanDateEt,
  setDivergenceScanAbortController,
  setDivergenceScanPauseRequested,
  setDivergenceScanResumeState,
  setDivergenceScanRunning,
  setDivergenceScanStopRequested,
} from '../services/scanControlService.js';


export async function runDailyDivergenceScan(options: { force?: boolean; refreshUniverse?: boolean; runDateEt?: string; trigger?: string; resume?: boolean } = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || fetchDailyScan.running || fetchWeeklyScan.running) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeDivergenceScanResumeState(divergenceScanResumeState || {}) : null;
  if (resumeRequested && (!resumeState || resumeState.totalSymbols === 0)) {
    return { status: 'no-resume' };
  }

  setDivergenceScanRunning(true);
  setDivergenceScanPauseRequested(false);
  setDivergenceScanStopRequested(false);
  const scanAbortController = new AbortController();
  setDivergenceScanAbortController(scanAbortController);
  if (!resumeRequested) {
    setDivergenceScanResumeState(null);
  }

  const force = Boolean(options.force);
  const refreshUniverse = Boolean(options.refreshUniverse);
  const trigger = String(options.trigger || 'manual').trim() || 'manual';
  const runDate = resumeState?.runDateEt || String(options.runDateEt || currentEtDateString()).trim();
  if (!resumeRequested && !force && divergenceLastScanDateEt === runDate) {
    if (divergenceScanAbortController === scanAbortController) {
      setDivergenceScanAbortController(null);
    }
    setDivergenceScanRunning(false);
    return { status: 'skipped', reason: 'already-scanned', runDate };
  }

  let scanJobId = resumeState?.scanJobId || null;
  let processed = Math.max(0, Number(resumeState?.processed || 0));
  let bullishCount = Math.max(0, Number(resumeState?.bullishCount || 0));
  let bearishCount = Math.max(0, Number(resumeState?.bearishCount || 0));
  let errorCount = Math.max(0, Number(resumeState?.errorCount || 0));
  let latestScannedTradeDate = String(resumeState?.latestScannedTradeDate || '').trim();
  let summaryProcessedTickers = Math.max(0, Number(resumeState?.summaryProcessedTickers || 0));
  let symbols = resumeState?.symbols || [];
  let totalSymbols = Math.max(0, Number(resumeState?.totalSymbols || symbols.length));
  let nextIndex = Math.max(0, Number(resumeState?.nextIndex || 0));

  const buildResumeSnapshot = () => normalizeDivergenceScanResumeState({
    runDateEt: runDate,
    trigger,
    symbols,
    nextIndex,
    processed,
    bullishCount,
    bearishCount,
    errorCount,
    latestScannedTradeDate,
    summaryProcessedTickers,
    scanJobId,
  });

  const persistResumeState = () => {
    setDivergenceScanResumeState(buildResumeSnapshot());
  };

  // Persist resume state to the DB so it survives a server restart.
  const flushResumeStateToDb = async () => {
    if (!scanJobId) return;
    try {
      await updateDivergenceScanJob(scanJobId, { notes: JSON.stringify(buildResumeSnapshot()) });
    } catch {
      // Best-effort — don't fail the scan if we can't write notes.
    }
  };

  try {
    if (!resumeRequested) {
      symbols = await getDivergenceUniverseTickers({ forceRefresh: refreshUniverse });
      totalSymbols = symbols.length;
      nextIndex = 0;
      processed = 0;
      bullishCount = 0;
      bearishCount = 0;
      errorCount = 0;
      latestScannedTradeDate = '';
      summaryProcessedTickers = 0;
      scanJobId = await startDivergenceScanJob(runDate, totalSymbols, trigger);

      const deleteClient = await divergencePool!.connect();
      try {
        await deleteClient.query('BEGIN');
        await deleteClient.query(
          `DELETE FROM divergence_signals WHERE source_interval = $1 AND timeframe <> '1d'`,
          [DIVERGENCE_SOURCE_INTERVAL],
        );
        await deleteClient.query(
          `DELETE FROM divergence_signals WHERE trade_date = $1 AND source_interval = $2 AND timeframe = '1d'`,
          [runDate, DIVERGENCE_SOURCE_INTERVAL],
        );
        await deleteClient.query('COMMIT');
      } catch (deleteErr) {
        await deleteClient.query('ROLLBACK').catch(() => {});
        throw deleteErr;
      } finally {
        deleteClient.release();
      }
    } else if (scanJobId) {
      await updateDivergenceScanJob(scanJobId, {
        status: 'running',
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null,
      });
    }

    if (totalSymbols === 0) {
      await updateDivergenceScanJob(scanJobId, {
        status: 'completed',
        finished_at: new Date(),
        processed_symbols: 0,
        scanned_trade_date: null,
      });
      setDivergenceLastScanDateEt(runDate);
      setDivergenceLastFetchedTradeDateEt(runDate);
      setDivergenceScanResumeState(null);
      return { status: 'completed', runDate, processed: 0 };
    }

    const targetSpacingMs =
      DIVERGENCE_SCAN_SPREAD_MINUTES > 0
        ? Math.max(0, Math.floor((DIVERGENCE_SCAN_SPREAD_MINUTES * 60 * 1000) / totalSymbols))
        : 0;

    persistResumeState();
    for (let i = nextIndex; i < symbols.length; i += DIVERGENCE_SCAN_CONCURRENCY) {
      if (divergenceScanStopRequested) {
        setDivergenceScanPauseRequested(false);
        setDivergenceScanStopRequested(false);
        setDivergenceScanResumeState(null);
        await updateDivergenceScanJob(scanJobId, {
          status: 'stopped',
          finished_at: new Date(),
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'stopped',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
        };
      }
      if (divergenceScanPauseRequested) {
        nextIndex = i;
        setDivergenceScanPauseRequested(false);
        setDivergenceScanStopRequested(false);
        persistResumeState();
        await updateDivergenceScanJob(scanJobId, {
          status: 'paused',
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'paused',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
        };
      }

      nextIndex = i;
      const batch = symbols.slice(i, i + DIVERGENCE_SCAN_CONCURRENCY);
      const attemptController = new AbortController();
      const unlinkAbort = linkAbortSignalToController(scanAbortController.signal, attemptController);
      let batchResults = [];
      try {
        batchResults = await Promise.all(
          batch.map(async (ticker: string) => {
            try {
              const outcome = await computeSymbolDivergenceSignals(ticker, { signal: attemptController.signal });
              return { ticker, ...outcome, error: null };
            } catch (err: any) {
              return { ticker, signals: [], latestTradeDate: '', error: err };
            }
          }),
        );
      } finally {
        unlinkAbort();
      }

      if (divergenceScanStopRequested) {
        setDivergenceScanPauseRequested(false);
        setDivergenceScanStopRequested(false);
        setDivergenceScanResumeState(null);
        await updateDivergenceScanJob(scanJobId, {
          status: 'stopped',
          finished_at: new Date(),
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'stopped',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
        };
      }
      if (divergenceScanPauseRequested) {
        nextIndex = i;
        setDivergenceScanPauseRequested(false);
        setDivergenceScanStopRequested(false);
        persistResumeState();
        await updateDivergenceScanJob(scanJobId, {
          status: 'paused',
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'paused',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
        };
      }

      const batchSignals = [];
      const batchDailyBars = [];
      for (const result of batchResults) {
        processed += 1;
        if (result.error) {
          if (
            isAbortError(result.error) &&
            (scanAbortController.signal.aborted || divergenceScanStopRequested || divergenceScanPauseRequested)
          ) {
            continue;
          }
          errorCount += 1;
          const message = result.error && result.error.message ? result.error.message : String(result.error);
          console.error(`Divergence scan failed for ${result.ticker}: ${message}`);
          continue;
        }
        if (result.latestTradeDate) {
          latestScannedTradeDate = maxEtDateString(latestScannedTradeDate, result.latestTradeDate);
        }
        if ('dailyBar' in result && result.dailyBar) {
          batchDailyBars.push(result.dailyBar);
        }
        for (const signal of result.signals) {
          batchSignals.push(signal);
          if (signal.signal_type === 'bullish') bullishCount += 1;
          if (signal.signal_type === 'bearish') bearishCount += 1;
        }
      }
      await Promise.all([
        upsertDivergenceDailyBarsBatch(batchDailyBars, scanJobId),
        upsertDivergenceSignalsBatch(batchSignals, scanJobId),
      ]);

      nextIndex = Math.min(symbols.length, i + DIVERGENCE_SCAN_CONCURRENCY);
      persistResumeState();

      if (scanJobId && (processed % DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY === 0 || processed === totalSymbols)) {
        await updateDivergenceScanJob(scanJobId, {
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null,
          notes: JSON.stringify(buildResumeSnapshot()),
        });
      } else {
        void flushResumeStateToDb();
      }
      if (targetSpacingMs > 0) {
        try {
          await sleepWithAbort(targetSpacingMs, scanAbortController.signal);
        } catch (sleepErr: any) {
          if (!(isAbortError(sleepErr) && (divergenceScanStopRequested || divergenceScanPauseRequested))) {
            throw sleepErr;
          }
        }
      }
    }

    if (divergenceScanStopRequested) {
      setDivergenceScanPauseRequested(false);
      setDivergenceScanStopRequested(false);
      setDivergenceScanResumeState(null);
      await updateDivergenceScanJob(scanJobId, {
        status: 'stopped',
        finished_at: new Date(),
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'stopped',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
      };
    }
    if (divergenceScanPauseRequested) {
      setDivergenceScanPauseRequested(false);
      setDivergenceScanStopRequested(false);
      persistResumeState();
      await updateDivergenceScanJob(scanJobId, {
        status: 'paused',
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'paused',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
      };
    }

    await updateDivergenceScanJob(scanJobId, {
      status: 'summarizing',
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount,
      scanned_trade_date: latestScannedTradeDate || null,
    });

    const asOfTradeDate = latestScannedTradeDate || runDate;
    const summaryResult = await rebuildDivergenceSummariesForTradeDate({
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      asOfTradeDate,
      scanJobId,
    });
    summaryProcessedTickers = Number(summaryResult?.processedTickers || 0);

    const publishedTradeDate = await publishDivergenceTradeDate({
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      tradeDate: asOfTradeDate,
      scanJobId,
    });
    clearDivergenceSummaryCacheForSourceInterval(DIVERGENCE_SOURCE_INTERVAL);

    await updateDivergenceScanJob(scanJobId, {
      status: 'completed',
      finished_at: new Date(),
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount,
      scanned_trade_date: latestScannedTradeDate || null,
      notes: `summary_tickers=${summaryProcessedTickers}`,
    });
    setDivergenceScanPauseRequested(false);
    setDivergenceScanStopRequested(false);
    setDivergenceScanResumeState(null);
    setDivergenceLastScanDateEt(runDate);
    setDivergenceLastFetchedTradeDateEt(publishedTradeDate || latestScannedTradeDate || runDate);
    return {
      status: 'completed',
      runDate,
      fetchedTradeDate: publishedTradeDate || latestScannedTradeDate || runDate,
      processed,
      bullishCount,
      bearishCount,
      errorCount,
      summaryProcessedTickers,
    };
  } catch (err: any) {
    if (
      divergenceScanStopRequested ||
      (isAbortError(err) && scanAbortController.signal.aborted && !divergenceScanPauseRequested)
    ) {
      setDivergenceScanPauseRequested(false);
      setDivergenceScanStopRequested(false);
      setDivergenceScanResumeState(null);
      await updateDivergenceScanJob(scanJobId, {
        status: 'stopped',
        finished_at: new Date(),
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'stopped',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
      };
    }
    if (divergenceScanPauseRequested || (isAbortError(err) && scanAbortController.signal.aborted)) {
      setDivergenceScanPauseRequested(false);
      setDivergenceScanStopRequested(false);
      persistResumeState();
      await updateDivergenceScanJob(scanJobId, {
        status: 'paused',
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'paused',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
      };
    }
    setDivergenceScanPauseRequested(false);
    setDivergenceScanStopRequested(false);
    if (!divergenceScanResumeState && symbols.length > 0) {
      persistResumeState();
    }
    await updateDivergenceScanJob(scanJobId, {
      status: 'failed',
      finished_at: new Date(),
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount,
      notes: String(err && err.message ? err.message : err || ''),
    });
    throw err;
  } finally {
    if (divergenceScanAbortController === scanAbortController) {
      setDivergenceScanAbortController(null);
    }
    setDivergenceScanRunning(false);
  }
}

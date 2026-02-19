import { divergencePool } from '../db.js';
import {
  DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS,
  DIVERGENCE_TABLE_BUILD_CONCURRENCY, DIVERGENCE_TABLE_MIN_COVERAGE_DAYS,
  DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE, DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE,
  DIVERGENCE_FETCH_TICKER_TIMEOUT_MS, DIVERGENCE_STALL_TIMEOUT_MS,
  DIVERGENCE_STALL_CHECK_INTERVAL_MS, DIVERGENCE_STALL_RETRY_BASE_MS,
  DIVERGENCE_STALL_MAX_RETRIES,
} from '../config.js';
import { currentEtDateString, maxEtDateString, dateKeyDaysAgo } from '../lib/dateUtils.js';
import {
  isAbortError, sleepWithAbort, createProgressStallWatchdog,
  getStallRetryBackoffMs, runWithAbortAndTimeout,
} from '../services/dataApi.js';
import { runRetryPasses } from '../lib/ScanState.js';
import { mapWithConcurrency, resolveAdaptiveFetchConcurrency } from '../lib/mapWithConcurrency.js';
import { isDivergenceConfigured } from '../db.js';
import { ScanState } from '../lib/ScanState.js';
import { latestCompletedPacificTradeDateKey, nextPacificDivergenceRefreshUtcMs } from '../services/chartEngine.js';
import { linkAbortSignalToController } from '../services/dataApi.js';
import {
  publishDivergenceTradeDate,
  resolveDivergenceAsOfTradeDate,
  upsertDivergenceDailyBarsBatch,
  upsertDivergenceSummaryBatch,
} from '../services/divergenceDbService.js';
import {
  buildNeutralDivergenceStateMap,
  classifyDivergenceStateMapFromDailyRows,
  clearDivergenceSummaryCacheForSourceInterval,
  setDivergenceSummaryCacheEntry,
} from '../services/divergenceStateService.js';
import {
  divergenceLastFetchedTradeDateEt,
  divergenceScanRunning,
  divergenceTableBuildAbortController,
  divergenceTableBuildPauseRequested,
  divergenceTableBuildResumeState,
  divergenceTableBuildRunning,
  divergenceTableBuildStatus,
  divergenceTableBuildStopRequested,
  fetchDailyScan,
  fetchWeeklyScan,
  normalizeDivergenceTableResumeState,
  setDivergenceLastFetchedTradeDateEt,
  setDivergenceTableBuildAbortController,
  setDivergenceTableBuildPauseRequested,
  setDivergenceTableBuildResumeState,
  setDivergenceTableBuildRunning,
  setDivergenceTableBuildStatus,
  setDivergenceTableBuildStopRequested,
} from '../services/scanControlService.js';
import {
  buildDivergenceDailyRowsForTicker,
  getDivergenceTableTickerUniverseFromAlerts,
  hasDivergenceHistoryCoverage,
  loadDivergenceDailyHistoryByTicker,
} from '../services/tickerHistoryService.js';
import { createRunMetricsTracker } from '../services/metricsService.js';


interface TableBuildOptions {
  resume?: boolean;
  sourceInterval?: string;
  lookbackDays?: number;
  bootstrapMissing?: boolean;
  force?: boolean;
  trigger?: string;
}

export async function runDivergenceTableBuild(options: TableBuildOptions = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || fetchDailyScan.isRunning || fetchWeeklyScan.isRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested
    ? normalizeDivergenceTableResumeState(divergenceTableBuildResumeState || {})
    : null;
  if (resumeRequested && (!resumeState || resumeState.tickers.length === 0)) {
    return { status: 'no-resume' };
  }

  setDivergenceTableBuildRunning(true);
  setDivergenceTableBuildPauseRequested(false);
  setDivergenceTableBuildStopRequested(false);
  const runMetricsTracker = null as ReturnType<typeof createRunMetricsTracker> | null; // table build doesn't track metrics yet
  if (!resumeRequested) {
    setDivergenceTableBuildResumeState(null);
  }

  let processedTickers = 0;
  let totalTickers = 0;
  let lastPublishedTradeDate = resumeState?.lastPublishedTradeDate || '';
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  const startedAtIso = new Date().toISOString();
  const tableAbortController = new AbortController();
  setDivergenceTableBuildAbortController(tableAbortController);
  setDivergenceTableBuildStatus({
    running: true,
    status: resumeState?.phase || 'running',
    totalTickers: Number(resumeState?.totalTickers || 0),
    processedTickers:
      Number(resumeState?.phase === 'summarizing' ? resumeState?.summarizeOffset : resumeState?.backfillOffset) || 0,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || '',
  });

  try {
    const sourceInterval =
      resumeState?.sourceInterval ||
      String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() ||
      DIVERGENCE_SOURCE_INTERVAL;
    const tickers = resumeState?.tickers?.length
      ? resumeState.tickers
      : await getDivergenceTableTickerUniverseFromAlerts();
    totalTickers = tickers.length;

    divergenceTableBuildStatus.totalTickers = totalTickers;

    if (totalTickers === 0) {
      setDivergenceTableBuildPauseRequested(false);
      setDivergenceTableBuildResumeState(null);
      setDivergenceTableBuildStatus({
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || '',
      });
      return {
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        lastPublishedTradeDate: null,
      };
    }

    const requestedLookbackDays =
      resumeState?.requestedLookbackDays ||
      Math.max(45, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
    const bootstrapMissing = options.bootstrapMissing !== false;
    const forceFullRebuild = Boolean(options.force);
    const asOfTradeDate = await resolveDivergenceAsOfTradeDate(sourceInterval, resumeState?.asOfTradeDate);
    const historyStartDate = dateKeyDaysAgo(asOfTradeDate, requestedLookbackDays + 7) || asOfTradeDate;
    let rowsByTicker = await loadDivergenceDailyHistoryByTicker({
      sourceInterval,
      tickers,
      historyStartDate,
      asOfTradeDate,
    });

    let backfillTickers = resumeState?.backfillTickers?.length ? resumeState.backfillTickers : [];
    if (!resumeRequested || backfillTickers.length === 0) {
      if (forceFullRebuild) {
        backfillTickers = tickers.slice();
      } else if (bootstrapMissing) {
        backfillTickers = tickers.filter((ticker: string) => {
          const rows = rowsByTicker.get(ticker) || [];
          return !hasDivergenceHistoryCoverage(rows, asOfTradeDate, DIVERGENCE_TABLE_MIN_COVERAGE_DAYS);
        });
      } else {
        backfillTickers = [];
      }
    }
    let backfillOffset = Math.max(0, Math.floor(Number(resumeState?.backfillOffset) || 0));
    let summarizeOffset = Math.max(0, Math.floor(Number(resumeState?.summarizeOffset) || 0));
    let phase = resumeState?.phase || (backfillTickers.length > 0 ? 'backfilling' : 'summarizing');

    const persistResumeState = () => {
      setDivergenceTableBuildResumeState(normalizeDivergenceTableResumeState({
        sourceInterval,
        asOfTradeDate,
        requestedLookbackDays,
        tickers,
        totalTickers,
        backfillTickers,
        backfillOffset,
        summarizeOffset,
        errorTickers,
        phase,
        lastPublishedTradeDate,
      }));
    };
    persistResumeState();

    const markPaused = () => {
      processedTickers = phase === 'summarizing' ? summarizeOffset : backfillOffset;
      setDivergenceTableBuildPauseRequested(false);
      setDivergenceTableBuildStopRequested(false);
      persistResumeState();
      setDivergenceTableBuildStatus({
        running: false,
        status: 'paused',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || '',
      });
      return {
        status: 'paused',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
      };
    };

    const markStopped = () => {
      processedTickers = phase === 'summarizing' ? summarizeOffset : backfillOffset;
      setDivergenceTableBuildPauseRequested(false);
      setDivergenceTableBuildStopRequested(false);
      setDivergenceTableBuildResumeState(null);
      setDivergenceTableBuildStatus({
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || '',
      });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
      };
    };

    if (phase === 'backfilling' && backfillTickers.length > 0) {
      divergenceTableBuildStatus.status = 'backfilling';
      backfillOffset = Math.min(backfillOffset, backfillTickers.length);
      processedTickers = backfillOffset;
      divergenceTableBuildStatus.processedTickers = processedTickers;

      while (backfillOffset < backfillTickers.length) {
        if (divergenceTableBuildStopRequested) {
          return markStopped();
        }
        if (divergenceTableBuildPauseRequested) {
          return markPaused();
        }

        const chunk = backfillTickers.slice(backfillOffset, backfillOffset + DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE);
        const chunkStartOffset = backfillOffset;
        let chunkCompleted = false;
        for (let chunkRetryAttempt = 0; !chunkCompleted; chunkRetryAttempt++) {
          const attemptController = new AbortController();
          const unlinkAbort = linkAbortSignalToController(tableAbortController.signal, attemptController);
          const stallWatchdog = createProgressStallWatchdog(() => {
            try {
              attemptController.abort();
            } catch {
              // Ignore duplicate abort calls.
            }
          });
          let chunkProcessed = 0;
          try {
            await mapWithConcurrency(
              chunk,
              DIVERGENCE_TABLE_BUILD_CONCURRENCY,
              async (ticker: string) => {
                const rows = await buildDivergenceDailyRowsForTicker({
                  ticker,
                  sourceInterval,
                  lookbackDays: requestedLookbackDays,
                  asOfTradeDate,
                  signal: attemptController.signal,
                  noCache: true,
                });
                if (rows.length > 0) {
                  await upsertDivergenceDailyBarsBatch(rows, null);
                }
                return { ticker, rowCount: rows.length };
              },
              (settled: unknown, _index: number, ticker: string) => {
                const result = settled as Record<string, unknown>;
                chunkProcessed += 1;
                processedTickers = Math.min(backfillTickers.length, chunkStartOffset + chunkProcessed);
                divergenceTableBuildStatus.processedTickers = processedTickers;
                stallWatchdog.markProgress();
                if (result && result.error) {
                  if (isAbortError(result.error)) {
                    if (
                      divergenceTableBuildStopRequested ||
                      divergenceTableBuildPauseRequested ||
                      stallWatchdog.isStalled()
                    ) {
                      persistResumeState();
                      return;
                    }
                  }
                  errorTickers += 1;
                  divergenceTableBuildStatus.errorTickers = errorTickers;
                  const err = result.error as Record<string, unknown> | undefined;
                  const message = err instanceof Error ? err.message : String(err);
                  console.error(`Divergence table backfill failed for ${ticker}: ${message}`);
                }
                persistResumeState();
              },
            );
          } finally {
            stallWatchdog.stop();
            unlinkAbort();
          }

          if (stallWatchdog.isStalled() && !divergenceTableBuildStopRequested && !divergenceTableBuildPauseRequested) {
            const retryAttempt = chunkRetryAttempt + 1;
            if (retryAttempt <= DIVERGENCE_STALL_MAX_RETRIES) {
              const retryDelayMs = getStallRetryBackoffMs(retryAttempt);
              divergenceTableBuildStatus.processedTickers = chunkStartOffset;
              persistResumeState();
              console.warn(
                `Divergence table backfill stalled at ticker ${chunkStartOffset + 1}/${backfillTickers.length}; retry ${retryAttempt}/${DIVERGENCE_STALL_MAX_RETRIES} in ${retryDelayMs}ms`,
              );
              try {
                await sleepWithAbort(retryDelayMs, tableAbortController.signal);
              } catch (sleepErr: unknown) {
                if (
                  !isAbortError(sleepErr) ||
                  (!divergenceTableBuildStopRequested && !divergenceTableBuildPauseRequested)
                ) {
                  throw sleepErr;
                }
              }
              continue;
            }
            throw new Error(
              `Divergence table backfill stalled at ticker ${chunkStartOffset + 1}/${backfillTickers.length} and exhausted ${DIVERGENCE_STALL_MAX_RETRIES} retries`,
            );
          }

          if (divergenceTableBuildStopRequested) {
            return markStopped();
          }
          if (divergenceTableBuildPauseRequested) {
            return markPaused();
          }
          chunkCompleted = true;
        }

        backfillOffset = Math.min(backfillTickers.length, chunkStartOffset + chunk.length);
        processedTickers = backfillOffset;
        divergenceTableBuildStatus.processedTickers = processedTickers;
        persistResumeState();
      }

      rowsByTicker = await loadDivergenceDailyHistoryByTicker({
        sourceInterval,
        tickers,
        historyStartDate,
        asOfTradeDate,
      });
    }

    phase = 'summarizing';
    persistResumeState();
    divergenceTableBuildStatus.status = 'summarizing';
    summarizeOffset = Math.min(summarizeOffset, tickers.length);
    processedTickers = summarizeOffset;
    divergenceTableBuildStatus.processedTickers = processedTickers;
    divergenceTableBuildStatus.errorTickers = errorTickers;

    const summaryRows: Array<Record<string, unknown>> = [];
    const neutralStates = buildNeutralDivergenceStateMap();
    const flushSummaryRows = async () => {
      if (summaryRows.length === 0) return;
      const batch = summaryRows.splice(0, summaryRows.length);
      await upsertDivergenceSummaryBatch(batch, null);
      const nowMs = Date.now();
      const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));
      for (const row of batch) {
        const ticker = String(row?.ticker || '').toUpperCase();
        const tradeDate = String(row?.trade_date || '').trim() || null;
        if (!ticker || !tradeDate) continue;
        setDivergenceSummaryCacheEntry({
          ticker,
          sourceInterval,
          tradeDate,
          states: row?.states || buildNeutralDivergenceStateMap(),
          computedAtMs: nowMs,
          expiresAtMs,
        });
      }
    };

    for (let idx = summarizeOffset; idx < tickers.length; idx++) {
      if (divergenceTableBuildStopRequested) {
        await flushSummaryRows();
        summarizeOffset = idx;
        return markStopped();
      }
      if (divergenceTableBuildPauseRequested) {
        await flushSummaryRows();
        summarizeOffset = idx;
        return markPaused();
      }
      const ticker = tickers[idx];
      const rows = rowsByTicker.get(ticker) || [];
      const filtered = rows.filter((row: { trade_date: string }) => row.trade_date && row.trade_date <= asOfTradeDate);
      const latestRowDate = filtered.length ? String(filtered[filtered.length - 1].trade_date || '').trim() : '';
      const states = filtered.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filtered) : neutralStates;
      summaryRows.push({
        ticker,
        source_interval: sourceInterval,
        trade_date: latestRowDate || asOfTradeDate,
        states,
      });
      summarizeOffset = idx + 1;
      processedTickers = summarizeOffset;
      divergenceTableBuildStatus.processedTickers = processedTickers;
      if (latestRowDate) {
        lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, latestRowDate);
      }
      if (summaryRows.length >= DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE) {
        await flushSummaryRows();
      }
      persistResumeState();
    }

    await flushSummaryRows();

    runMetricsTracker?.setPhase('publishing');
    if (lastPublishedTradeDate) {
      await publishDivergenceTradeDate({
        sourceInterval,
        tradeDate: lastPublishedTradeDate,
        scanJobId: null,
      });
      setDivergenceLastFetchedTradeDateEt(maxEtDateString(divergenceLastFetchedTradeDateEt, lastPublishedTradeDate));
    }
    setDivergenceTableBuildPauseRequested(false);
    setDivergenceTableBuildStopRequested(false);
    setDivergenceTableBuildResumeState(null);
    clearDivergenceSummaryCacheForSourceInterval(sourceInterval);

    setDivergenceTableBuildStatus({
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || '',
    });
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: lastPublishedTradeDate || null,
    };
  } catch (err: unknown) {
    setDivergenceTableBuildPauseRequested(false);
    setDivergenceTableBuildStopRequested(false);
    setDivergenceTableBuildStatus({
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || '',
    });
    if (!divergenceTableBuildResumeState) {
      setDivergenceTableBuildResumeState(normalizeDivergenceTableResumeState({
        sourceInterval:
          String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL,
        asOfTradeDate: latestCompletedPacificTradeDateKey(new Date()) || currentEtDateString(),
        requestedLookbackDays: Math.max(
          45,
          Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS),
        ),
        tickers: [],
        totalTickers,
        backfillTickers: [],
        backfillOffset: 0,
        summarizeOffset: processedTickers,
        errorTickers,
        phase: 'summarizing',
        lastPublishedTradeDate,
      }));
    }
    throw err;
  } finally {
    if (divergenceTableBuildAbortController === tableAbortController) {
      setDivergenceTableBuildAbortController(null);
    }
    setDivergenceTableBuildRunning(false);
  }
}

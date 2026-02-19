import { divergencePool } from '../db.js';
import {
  DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS,
  DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE, DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
  DIVERGENCE_FETCH_MA_TIMEOUT_MS, DIVERGENCE_STALL_TIMEOUT_MS,
  DIVERGENCE_STALL_CHECK_INTERVAL_MS, DIVERGENCE_STALL_RETRY_BASE_MS,
  DIVERGENCE_STALL_MAX_RETRIES, DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE,
} from '../config.js';
import { currentEtDateString, maxEtDateString, dateKeyDaysAgo } from '../lib/dateUtils.js';
import {
  isAbortError, sleepWithAbort, createProgressStallWatchdog,
  getStallRetryBackoffMs, runWithAbortAndTimeout,
  fetchDataApiMovingAverageStatesForTicker,
} from '../services/dataApi.js';
import { runRetryPasses } from '../lib/ScanState.js';
import { mapWithConcurrency, resolveAdaptiveFetchConcurrency } from '../lib/mapWithConcurrency.js';
import { toVolumeDeltaSourceInterval } from '../services/chartEngine.js';
import { isDivergenceConfigured } from '../db.js';
import { ScanState } from '../lib/ScanState.js';
import { DIVERGENCE_SUMMARY_BUILD_CONCURRENCY } from '../services/chartEngine.js';
import { buildRequestAbortError } from '../services/dataApi.js';
import {
  getStoredDivergenceSymbolTickers,
  publishDivergenceTradeDate,
  syncOneDaySignalsFromSummaryRows,
  upsertDivergenceDailyBarsBatch,
  upsertDivergenceSummaryBatch,
} from '../services/divergenceDbService.js';
import { buildNeutralDivergenceStateMap, classifyDivergenceStateMapFromDailyRows, clearDivergenceSummaryCacheForSourceInterval } from '../services/divergenceStateService.js';
import { createRunMetricsTracker, runMetricsByType } from '../services/metricsService.js';
import {
  divergenceLastFetchedTradeDateEt,
  divergenceScanRunning,
  divergenceTableBuildRunning,
  fetchDailyScan,
  fetchWeeklyScan,
  normalizeFetchDailyDataResumeState,
  resolveLastClosedDailyCandleDate,
  setDivergenceLastFetchedTradeDateEt,
} from '../services/scanControlService.js';
import { buildDivergenceDailyRowsForTicker } from '../services/tickerHistoryService.js';


interface FetchDailyOptions {
  resume?: boolean;
  sourceInterval?: string;
  lookbackDays?: number;
}

interface DivergenceDailyRow {
  ticker: string;
  trade_date: string;
  source_interval: string;
  close: number;
  prev_close: number;
  volume_delta: number;
}

interface DivergenceSummaryRow {
  ticker: string;
  source_interval: string;
  trade_date: string;
  states: Record<string, string>;
  ma_states: Record<string, boolean> | null;
  latest_close: number;
  latest_prev_close: number;
  latest_volume_delta: number;
}

interface MaSeedRow {
  ticker: string;
  source_interval: string;
  trade_date: string;
  states: Record<string, string>;
  latest_close: number;
  latest_prev_close: number;
  latest_volume_delta: number;
}

export async function runDivergenceFetchDailyData(options: FetchDailyOptions = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || fetchDailyScan.isRunning || fetchWeeklyScan.isRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeFetchDailyDataResumeState(fetchDailyScan.currentResumeState || {}) : null;
  if (
    resumeRequested &&
    (!resumeState ||
      !resumeState.asOfTradeDate ||
      resumeState.totalTickers === 0 ||
      resumeState.nextIndex >= resumeState.totalTickers)
  ) {
    return { status: 'no-resume' };
  }
  // Clear previous run metrics immediately so stale data never leaks into
  // the new run's Logs page display (failedTickers, errors, etc.).
  runMetricsByType.fetchDaily = null;
  const fetchDailyAbortController = fetchDailyScan.beginRun(resumeRequested);

  let processedTickers = Math.max(0, Number(resumeState?.processedTickers || 0));
  let totalTickers = Math.max(0, Number(resumeState?.totalTickers || 0));
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  let lastPublishedTradeDate = String(resumeState?.lastPublishedTradeDate || '').trim();
  const startedAtIso = new Date().toISOString();
  fetchDailyScan.replaceStatus({
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan.readStatus().lastPublishedTradeDate || '',
  });
  fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '' });

  let tickers = resumeState?.tickers || [];
  let startIndex = Math.max(0, Number(resumeState?.nextIndex || 0));
  let sourceInterval = '';
  let runLookbackDays = DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS;
  let runConcurrency = resolveAdaptiveFetchConcurrency('fetch-daily');
  const summaryFlushSize = DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE;
  let asOfTradeDate = '';
  let runMetricsTracker: ReturnType<typeof createRunMetricsTracker> | null = null;
  const dailyRowsBuffer: DivergenceDailyRow[] = [];
  const summaryRowsBuffer: DivergenceSummaryRow[] = [];
  const maSummaryRowsBuffer: DivergenceSummaryRow[] = [];
  const maSeedRows: MaSeedRow[] = [];

  try {
    sourceInterval =
      resumeState?.sourceInterval ||
      String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() ||
      DIVERGENCE_SOURCE_INTERVAL;
    runLookbackDays =
      resumeState?.lookbackDays ||
      Math.max(28, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
    asOfTradeDate = resumeState?.asOfTradeDate || resolveLastClosedDailyCandleDate();
    runConcurrency = resolveAdaptiveFetchConcurrency('fetch-daily');
    runMetricsTracker = createRunMetricsTracker('fetchDaily', {
      sourceInterval,
      asOfTradeDate,
      lookbackDays: runLookbackDays,
      concurrency: runConcurrency,
      flushSize: summaryFlushSize,
    });
    runMetricsTracker.setPhase('core');

    if (!resumeRequested) {
      tickers = await getStoredDivergenceSymbolTickers();
      startIndex = 0;
      processedTickers = 0;
      errorTickers = 0;
      lastPublishedTradeDate = '';
    }

    totalTickers = tickers.length;
    fetchDailyScan.setStatus({ totalTickers });
    runMetricsTracker?.setTotals(totalTickers);

    const persistResumeState = (nextIdx: number) => {
      fetchDailyScan.setResumeState(normalizeFetchDailyDataResumeState({
        asOfTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: nextIdx,
        processedTickers,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate,
      }));
    };

    const markStopped = (nextIdx: number, options: { preserveResume?: boolean; rewind?: boolean } = {}) => {
      const preserveResume = options.preserveResume !== false;
      const rewind = options.rewind !== false;
      // Rewind by concurrency level so in-flight workers that got aborted
      // (and never wrote their data) will be re-fetched on resume.
      // Upserts make re-fetching already-completed tickers harmless.
      const safeNextIndex = rewind
        ? Math.max(0, Math.min(totalTickers, nextIdx - runConcurrency))
        : Math.max(0, Math.min(totalTickers, nextIdx));
      if (preserveResume) {
        persistResumeState(safeNextIndex);
      } else {
        fetchDailyScan.setResumeState(null);
      }
      fetchDailyScan.setStopRequested(false);
      fetchDailyScan.replaceStatus({
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan.readStatus().lastPublishedTradeDate || '',
      });
      fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '' });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
      };
    };

    if (totalTickers === 0) {
      fetchDailyScan.setStopRequested(false);
      fetchDailyScan.setResumeState(null);
      fetchDailyScan.replaceStatus({
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: fetchDailyScan.readStatus().lastPublishedTradeDate || '',
      });
      fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '' });
      return {
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        lastPublishedTradeDate: null,
      };
    }

    await publishDivergenceTradeDate({
      sourceInterval,
      tradeDate: asOfTradeDate,
      scanJobId: null,
    });
    lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, asOfTradeDate);
    setDivergenceLastFetchedTradeDateEt(maxEtDateString(divergenceLastFetchedTradeDateEt, asOfTradeDate));
    // --- On-the-fly DB update infrastructure ---
    const neutralStates = buildNeutralDivergenceStateMap();
    let flushChain = Promise.resolve();

    const flushBuffers = async () => {
      const flushStartedAt = Date.now();
      let flushedDailyRows = 0;
      let flushedSummaryRows = 0;
      let flushedSignalRows = 0;
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        flushedDailyRows += batch.length;
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
        await syncOneDaySignalsFromSummaryRows(batch, sourceInterval, null);
        flushedSignalRows += batch.length;
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (flushedDailyRows > 0 || flushedSummaryRows > 0 || flushedSignalRows > 0) {
        runMetricsTracker?.recordDbFlush({
          durationMs: Date.now() - flushStartedAt,
          dailyRows: flushedDailyRows,
          summaryRows: flushedSummaryRows,
          signalRows: flushedSignalRows,
        });
      }
    };

    const enqueueFlush = () => {
      flushChain = flushChain
        .then(() => flushBuffers())
        .catch((err) => {
          console.error('Fetch-all on-the-fly flush error:', err && err.message ? err.message : String(err));
        });
      return flushChain;
    };

    // Slice tickers to only the remaining portion for resume
    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;
    const failedTickers: string[] = [];

    persistResumeState(startIndex);

    // --- Worker function shared by main pass and retry pass ---
    const fetchDailyTickerWorker = async (ticker: string) => {
      return runWithAbortAndTimeout(
        async (tickerSignal) => {
          if (fetchDailyScan.shouldStop) {
            throw buildRequestAbortError('Fetch-all run stopped');
          }
          const rows = await buildDivergenceDailyRowsForTicker({
            ticker,
            sourceInterval,
            lookbackDays: runLookbackDays,
            asOfTradeDate,
            parentInterval: '1day',
            signal: tickerSignal,
            noCache: true,
            metricsTracker: runMetricsTracker,
          });
          const filteredRows = Array.isArray(rows)
            ? rows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate)
            : [];
          const latestRow = filteredRows.length > 0 ? filteredRows[filteredRows.length - 1] : null;
          const latestClose = Number(latestRow?.close);

          // --- On-the-fly: process and buffer this ticker's data immediately ---
          if (rows && Array.isArray(rows) && rows.length > 0) {
            dailyRowsBuffer.push(...rows);
          }
          if (filteredRows.length >= 1 && latestRow?.trade_date) {
            const states =
              filteredRows.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filteredRows) : neutralStates;
            summaryRowsBuffer.push({
              ticker,
              source_interval: sourceInterval,
              trade_date: latestRow.trade_date,
              states,
              ma_states: null,
              latest_close: Number(latestRow.close),
              latest_prev_close: Number(latestRow.prev_close),
              latest_volume_delta: Number(latestRow.volume_delta),
            });
            if (Number.isFinite(latestClose) && latestClose > 0) {
              maSeedRows.push({
                ticker,
                source_interval: sourceInterval,
                trade_date: latestRow.trade_date,
                states,
                latest_close: latestClose,
                latest_prev_close: Number(latestRow.prev_close),
                latest_volume_delta: Number(latestRow.volume_delta),
              });
            }
          }

          // Flush buffers when thresholds are reached
          if (
            summaryRowsBuffer.length >= summaryFlushSize ||
            dailyRowsBuffer.length >= DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE
          ) {
            await enqueueFlush();
          }

          return { ticker, tradeDate: latestRow?.trade_date };
        },
        {
          signal: fetchDailyAbortController.signal,
          timeoutMs: DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
          label: `Fetch-all ticker ${ticker}`,
        },
      );
    };

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      fetchDailyTickerWorker,
      (settled: unknown, sliceIndex: number) => {
        const result = settled as Record<string, unknown>;
        settledCount += 1;
        processedTickers = startIndex + settledCount;
        const ticker = tickerSlice[sliceIndex] || '';
        if (result && result.error && !(fetchDailyScan.isStopping && isAbortError(result.error))) {
          errorTickers += 1;
          if (!isAbortError(result.error)) {
            failedTickers.push(ticker);
            runMetricsTracker?.recordFailedTicker(ticker);
            const err = result.error as Record<string, unknown> | undefined;
            const message = err && err.message ? String(err.message) : String(result.error);
            console.error(`Fetch-all divergence build failed for ${ticker}: ${message}`);
          }
        } else if (result && result.tradeDate) {
          lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, String(result.tradeDate));
        }
        fetchDailyScan.setStatus({
          processedTickers,
          errorTickers,
          lastPublishedTradeDate,
          status: fetchDailyScan.isStopping ? 'stopping' : 'running',
        });
        fetchDailyScan.setExtraStatus({ last_published_trade_date: lastPublishedTradeDate });
        runMetricsTracker?.setProgress(processedTickers, errorTickers);
        // Update resume state as we progress
        persistResumeState(startIndex + settledCount);
      },
      () => fetchDailyScan.shouldStop,
    );

    if (fetchDailyScan.isStopping) {
      // Final flush before reporting stopped — save whatever is buffered
      await enqueueFlush();
      return markStopped(processedTickers);
    }

    // Final flush for any remaining buffered rows
    await enqueueFlush();

    // --- Retry pass for failed tickers ---
    if (failedTickers.length > 0 && !fetchDailyScan.shouldStop) {
      const retryCount = failedTickers.length;
      console.log(`Fetch-all: retrying ${retryCount} failed ticker(s)...`);
      runMetricsTracker?.setPhase('retry');
      fetchDailyScan.setStatus({ status: 'running-retry' });
      let retryRecovered = 0;
      const stillFailedTickers: string[] = [];
      await mapWithConcurrency(
        failedTickers,
        Math.max(1, Math.floor(runConcurrency / 2)),
        fetchDailyTickerWorker,
        (settled: unknown, idx: number) => {
          const result = settled as Record<string, unknown>;
          const ticker = failedTickers[idx] || '';
          if (result && result.error) {
            if (!isAbortError(result.error)) {
              const err = result.error as Record<string, unknown> | undefined;
              const message = err && err.message ? String(err.message) : String(result.error);
              console.error(`Fetch-all retry still failed for ${ticker}: ${message}`);
              stillFailedTickers.push(ticker);
            }
          } else {
            retryRecovered += 1;
            runMetricsTracker?.recordRetryRecovered(ticker);
            errorTickers = Math.max(0, errorTickers - 1);
          }
          fetchDailyScan.setStatus({ errorTickers });
          runMetricsTracker?.setProgress(processedTickers, errorTickers);
        },
        () => fetchDailyScan.shouldStop,
      );
      if (retryRecovered > 0) {
        console.log(`Fetch-all: retry recovered ${retryRecovered}/${retryCount} ticker(s)`);
      }
      await enqueueFlush();
      runMetricsTracker?.recordStallRetry();

      // --- Second retry pass for tickers that failed both attempts ---
      if (stillFailedTickers.length > 0 && !fetchDailyScan.shouldStop) {
        const retry2Count = stillFailedTickers.length;
        console.log(`Fetch-all: second retry for ${retry2Count} ticker(s)...`);
        runMetricsTracker?.setPhase('retry-2');
        fetchDailyScan.setStatus({ status: 'running-retry' });
        let retry2Recovered = 0;
        await mapWithConcurrency(
          stillFailedTickers,
          Math.max(1, Math.floor(runConcurrency / 4)),
          fetchDailyTickerWorker,
          (settled: unknown, idx: number) => {
            const result = settled as Record<string, unknown>;
            const ticker = stillFailedTickers[idx] || '';
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const err = result.error as Record<string, unknown> | undefined;
                const message = err && err.message ? String(err.message) : String(result.error);
                console.error(`Fetch-all retry-2 still failed for ${ticker}: ${message}`);
              }
            } else {
              retry2Recovered += 1;
              runMetricsTracker?.recordRetryRecovered(ticker);
              errorTickers = Math.max(0, errorTickers - 1);
            }
            fetchDailyScan.setStatus({ errorTickers });
            runMetricsTracker?.setProgress(processedTickers, errorTickers);
          },
          () => fetchDailyScan.shouldStop,
        );
        if (retry2Recovered > 0) {
          console.log(`Fetch-all: second retry recovered ${retry2Recovered}/${retry2Count} ticker(s)`);
        }
        await enqueueFlush();
        runMetricsTracker?.recordStallRetry();
      }
    }

    if (maSeedRows.length > 0) {
      runMetricsTracker?.setPhase('ma-enrichment');
      fetchDailyScan.setStatus({ status: 'running-ma' });
      const maConcurrency = Math.max(1, Math.min(runConcurrency, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY));
      const failedMaSeeds: MaSeedRow[] = [];

      const fetchDailyMaWorker = async (seed: MaSeedRow) => {
        return runWithAbortAndTimeout(
          async (tickerSignal) => {
            const maStates = await fetchDataApiMovingAverageStatesForTicker(seed.ticker, Number(seed.latest_close), {
              signal: tickerSignal,
              metricsTracker: runMetricsTracker,
            });
            if (maStates) {
              maSummaryRowsBuffer.push({
                ticker: seed.ticker,
                source_interval: seed.source_interval,
                trade_date: seed.trade_date,
                states: seed.states || buildNeutralDivergenceStateMap(),
                ma_states: maStates,
                latest_close: Number(seed.latest_close),
                latest_prev_close: Number(seed.latest_prev_close),
                latest_volume_delta: Number(seed.latest_volume_delta),
              });
              if (maSummaryRowsBuffer.length >= summaryFlushSize) {
                await enqueueFlush();
              }
            }
            return null;
          },
          {
            signal: fetchDailyAbortController.signal,
            timeoutMs: DIVERGENCE_FETCH_MA_TIMEOUT_MS,
            label: `Fetch-all MA ${seed.ticker}`,
          },
        );
      };

      await mapWithConcurrency(
        maSeedRows,
        maConcurrency,
        fetchDailyMaWorker,
        (settled: unknown, idx: number) => {
          const result = settled as Record<string, unknown>;
          if (result && result.error && !isAbortError(result.error)) {
            failedMaSeeds.push(maSeedRows[idx]);
            const err = result.error as Record<string, unknown> | undefined;
            const message = err && err.message ? String(err.message) : String(result.error);
            console.error(`Fetch-all MA enrichment failed: ${message}`);
          }
        },
        () => fetchDailyScan.shouldStop,
      );

      if (fetchDailyScan.isStopping) {
        await enqueueFlush();
        return markStopped(totalTickers, { preserveResume: false, rewind: false });
      }
      await enqueueFlush();

      // --- Retry pass for failed MA tickers ---
      if (failedMaSeeds.length > 0 && !fetchDailyScan.shouldStop) {
        const maRetryCount = failedMaSeeds.length;
        console.log(`Fetch-all: retrying ${maRetryCount} failed MA ticker(s)...`);
        fetchDailyScan.setStatus({ status: 'running-ma-retry' });
        let maRetryRecovered = 0;
        const stillFailedMaSeeds: MaSeedRow[] = [];
        await mapWithConcurrency(
          failedMaSeeds,
          Math.max(1, Math.floor(maConcurrency / 2)),
          fetchDailyMaWorker,
          (settled: unknown, idx: number) => {
            const result = settled as Record<string, unknown>;
            const seed = failedMaSeeds[idx];
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const err = result.error as Record<string, unknown> | undefined;
                const message = err && err.message ? String(err.message) : String(result.error);
                console.error(`Fetch-all MA retry still failed for ${seed?.ticker}: ${message}`);
                stillFailedMaSeeds.push(seed);
              }
            } else {
              maRetryRecovered += 1;
            }
          },
          () => fetchDailyScan.shouldStop,
        );
        if (maRetryRecovered > 0) {
          console.log(`Fetch-all: MA retry recovered ${maRetryRecovered}/${maRetryCount} ticker(s)`);
        }
        await enqueueFlush();

        // --- Second retry pass for MA tickers ---
        if (stillFailedMaSeeds.length > 0 && !fetchDailyScan.shouldStop) {
          const maRetry2Count = stillFailedMaSeeds.length;
          console.log(`Fetch-all: second MA retry for ${maRetry2Count} ticker(s)...`);
          fetchDailyScan.setStatus({ status: 'running-ma-retry' });
          let maRetry2Recovered = 0;
          await mapWithConcurrency(
            stillFailedMaSeeds,
            Math.max(1, Math.floor(maConcurrency / 4)),
            fetchDailyMaWorker,
            (settled: unknown, idx: number) => {
              const result = settled as Record<string, unknown>;
              const seed = stillFailedMaSeeds[idx];
              if (result && result.error) {
                if (!isAbortError(result.error)) {
                  const err = result.error as Record<string, unknown> | undefined;
                  const message = err && err.message ? String(err.message) : String(result.error);
                  console.error(`Fetch-all MA retry-2 still failed for ${seed?.ticker}: ${message}`);
                }
              } else {
                maRetry2Recovered += 1;
              }
            },
            () => fetchDailyScan.shouldStop,
          );
          if (maRetry2Recovered > 0) {
            console.log(`Fetch-all: second MA retry recovered ${maRetry2Recovered}/${maRetry2Count} ticker(s)`);
          }
          await enqueueFlush();
        }
      }
    }

    if (lastPublishedTradeDate) {
      await publishDivergenceTradeDate({
        sourceInterval,
        tradeDate: lastPublishedTradeDate,
        scanJobId: null,
      });
      setDivergenceLastFetchedTradeDateEt(maxEtDateString(divergenceLastFetchedTradeDateEt, lastPublishedTradeDate));
    }
    clearDivergenceSummaryCacheForSourceInterval(sourceInterval);

    // Completed successfully — clear resume state
    if (!lastPublishedTradeDate && asOfTradeDate) {
      lastPublishedTradeDate = asOfTradeDate;
    }
    fetchDailyScan.setResumeState(null);
    fetchDailyScan.setStopRequested(false);
    fetchDailyScan.replaceStatus({
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan.readStatus().lastPublishedTradeDate || '',
    });
    fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '' });
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: lastPublishedTradeDate || null,
    };
  } catch (err: any) {
    // Flush whatever is buffered even on error/abort
    try {
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
        await syncOneDaySignalsFromSummaryRows(batch, sourceInterval, null);
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
      }
    } catch (flushErr: any) {
      console.error(
        'Fetch-all error-path flush failed:',
        flushErr && flushErr.message ? flushErr.message : String(flushErr),
      );
    }

    if (fetchDailyScan.isStopping || isAbortError(err)) {
      // Persist resume state on stop/abort — rewind by concurrency level
      // so in-flight aborted tickers are re-fetched on resume.
      const safeNextIndex = Math.max(0, processedTickers - runConcurrency);
      fetchDailyScan.setResumeState(normalizeFetchDailyDataResumeState({
        asOfTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: safeNextIndex,
        processedTickers: safeNextIndex,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate,
      }));
      fetchDailyScan.setStopRequested(false);
      fetchDailyScan.replaceStatus({
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan.readStatus().lastPublishedTradeDate || '',
      });
      fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '' });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
      };
    }
    fetchDailyScan.setStopRequested(false);
    fetchDailyScan.replaceStatus({
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: fetchDailyScan.readStatus().lastPublishedTradeDate || '',
    });
    fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '' });
    throw err;
  } finally {
    if (runMetricsTracker) {
      const finalStatus = fetchDailyScan.readStatus();
      runMetricsTracker.finish(finalStatus.status || 'completed', {
        totalTickers,
        processedTickers: Number(finalStatus.processedTickers || processedTickers || 0),
        errorTickers: Number(finalStatus.errorTickers || errorTickers || 0),
        phase: finalStatus.status || 'completed',
        meta: {
          sourceInterval,
          asOfTradeDate,
          lastPublishedTradeDate,
        },
      });
    }
    fetchDailyScan.cleanup(fetchDailyAbortController);
  }
}

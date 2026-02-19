import { divergencePool } from '../db.js';
import {
  DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS,
  DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE, DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
  DIVERGENCE_FETCH_MA_TIMEOUT_MS, DIVERGENCE_STALL_TIMEOUT_MS,
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
import { toVolumeDeltaSourceInterval } from '../services/chartEngine.js';
import { classifyDivergenceSignal } from '../chartMath.js';
import { DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE } from '../config.js';
import { isDivergenceConfigured } from '../db.js';
import { ScanState } from '../lib/ScanState.js';
import { DIVERGENCE_SUMMARY_BUILD_CONCURRENCY, dataApiIntradayChartHistory } from '../services/chartEngine.js';
import { buildRequestAbortError, fetchDataApiMovingAverageStatesForTicker } from '../services/dataApi.js';
import {
  getLatestWeeklySignalTradeDate,
  getStoredDivergenceSymbolTickers,
  publishDivergenceTradeDate,
  upsertDivergenceDailyBarsBatch,
  upsertDivergenceSignalsBatch,
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
  normalizeFetchWeeklyDataResumeState,
  resolveLastClosedDailyCandleDate,
  resolveLastClosedWeeklyCandleDate,
  setDivergenceLastFetchedTradeDateEt,
} from '../services/scanControlService.js';
import { buildDivergenceDailyRowsForTicker, buildLatestWeeklyBarSnapshotForTicker } from '../services/tickerHistoryService.js';


export async function runDivergenceFetchWeeklyData(options: { resume?: boolean; sourceInterval?: string; lookbackDays?: number; force?: boolean; trigger?: string } = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || fetchDailyScan.isRunning || fetchWeeklyScan.isRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeFetchWeeklyDataResumeState(fetchWeeklyScan.currentResumeState || {}) : null;
  if (
    resumeRequested &&
    (!resumeState ||
      !resumeState.asOfTradeDate ||
      !resumeState.weeklyTradeDate ||
      resumeState.totalTickers === 0 ||
      resumeState.nextIndex >= resumeState.totalTickers)
  ) {
    return { status: 'no-resume' };
  }

  // Clear previous run metrics immediately so stale data never leaks into
  // the new run's Logs page display (failedTickers, errors, etc.).
  runMetricsByType.fetchWeekly = null;
  const fetchWeeklyAbortController = fetchWeeklyScan.beginRun(resumeRequested);

  let processedTickers = Math.max(0, Number(resumeState?.processedTickers || 0));
  let totalTickers = Math.max(0, Number(resumeState?.totalTickers || 0));
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  let lastPublishedTradeDate = String(resumeState?.lastPublishedTradeDate || '').trim();
  const startedAtIso = new Date().toISOString();
  fetchWeeklyScan.replaceStatus({
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: lastPublishedTradeDate || fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
  });
  fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '' });

  let tickers = resumeState?.tickers || [];
  let startIndex = Math.max(0, Number(resumeState?.nextIndex || 0));
  let sourceInterval = '';
  let runLookbackDays = DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS;
  let runConcurrency = resolveAdaptiveFetchConcurrency('fetch-weekly');
  const summaryFlushSize = DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE;
  let asOfTradeDate = '';
  let weeklyTradeDate = '';
  let runMetricsTracker: ReturnType<typeof createRunMetricsTracker> | null = null;
  const dailyRowsBuffer: Array<Record<string, unknown>> = [];
  const summaryRowsBuffer: Array<{ ticker: string; source_interval: string; trade_date: string; states: Record<string, string>; ma_states?: Record<string, boolean> | null; latest_close?: number; latest_prev_close?: number; latest_volume_delta?: number }> = [];
  const maSummaryRowsBuffer: Array<{ ticker: string; source_interval: string; trade_date: string; states: Record<string, string>; ma_states?: Record<string, boolean> | null; latest_close?: number; latest_prev_close?: number; latest_volume_delta?: number }> = [];
  const maSeedRows: Array<{ ticker: string; source_interval: string; trade_date: string; states: Record<string, string>; latest_close: number; latest_prev_close: number; latest_volume_delta: number }> = [];
  const weeklySignalRowsBuffer: Array<{ ticker: string; signal_type: string; trade_date: string; price: number; prev_close: number; volume_delta: number; timeframe: string; source_interval: string }> = [];
  const weeklyNeutralTickerBuffer: Array<{ ticker: string; trade_date: string }> = [];
  const failedTickers: string[] = [];

  try {
    sourceInterval =
      resumeState?.sourceInterval ||
      String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() ||
      DIVERGENCE_SOURCE_INTERVAL;
    runLookbackDays =
      resumeState?.lookbackDays ||
      Math.max(28, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
    asOfTradeDate = resumeState?.asOfTradeDate || resolveLastClosedDailyCandleDate();
    weeklyTradeDate = resumeState?.weeklyTradeDate || resolveLastClosedWeeklyCandleDate();
    runConcurrency = resolveAdaptiveFetchConcurrency('fetch-weekly');
    runMetricsTracker = createRunMetricsTracker('fetchWeekly', {
      sourceInterval,
      asOfTradeDate,
      weeklyTradeDate,
      lookbackDays: runLookbackDays,
      concurrency: runConcurrency,
      flushSize: summaryFlushSize,
    });
    runMetricsTracker.setPhase('core');

    if (!resumeRequested && !options.force) {
      const latestStoredWeeklyTradeDate = await getLatestWeeklySignalTradeDate(sourceInterval);
      if (latestStoredWeeklyTradeDate && latestStoredWeeklyTradeDate >= weeklyTradeDate) {
        fetchWeeklyScan.replaceStatus({
          running: false,
          status: 'skipped',
          totalTickers: 0,
          processedTickers: 0,
          errorTickers: 0,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          lastPublishedTradeDate: latestStoredWeeklyTradeDate,
        });
        fetchWeeklyScan.setExtraStatus({ last_published_trade_date: latestStoredWeeklyTradeDate || '' });
        return {
          status: 'skipped',
          reason: 'already-up-to-date',
          lastPublishedTradeDate: latestStoredWeeklyTradeDate,
        };
      }
    }

    if (!resumeRequested) {
      tickers = await getStoredDivergenceSymbolTickers();
      startIndex = 0;
      processedTickers = 0;
      errorTickers = 0;
      lastPublishedTradeDate = '';
    }

    totalTickers = tickers.length;
    fetchWeeklyScan.setStatus({ totalTickers });
    runMetricsTracker?.setTotals(totalTickers);

    const persistResumeState = (nextIdx: number) => {
      fetchWeeklyScan.setResumeState(normalizeFetchWeeklyDataResumeState({
        asOfTradeDate,
        weeklyTradeDate,
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
      const safeNextIndex = rewind
        ? Math.max(0, Math.min(totalTickers, nextIdx - runConcurrency))
        : Math.max(0, Math.min(totalTickers, nextIdx));
      if (preserveResume) {
        persistResumeState(safeNextIndex);
      } else {
        fetchWeeklyScan.setResumeState(null);
      }
      fetchWeeklyScan.setStopRequested(false);
      fetchWeeklyScan.replaceStatus({
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate:
          weeklyTradeDate || lastPublishedTradeDate || fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
      });
      fetchWeeklyScan.setExtraStatus({
        last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
      });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        lastPublishedTradeDate: weeklyTradeDate || null,
      };
    };

    if (totalTickers === 0) {
      fetchWeeklyScan.setStopRequested(false);
      fetchWeeklyScan.setResumeState(null);
      fetchWeeklyScan.replaceStatus({
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
      });
      fetchWeeklyScan.setExtraStatus({
        last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
      });
      return {
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        lastPublishedTradeDate: null,
      };
    }

    // Keep divergence summaries published at the latest daily closed date.
    await publishDivergenceTradeDate({
      sourceInterval,
      tradeDate: asOfTradeDate,
      scanJobId: null,
    });
    setDivergenceLastFetchedTradeDateEt(maxEtDateString(divergenceLastFetchedTradeDateEt, asOfTradeDate));
    const neutralStates = buildNeutralDivergenceStateMap();
    let flushChain = Promise.resolve();

    const flushBuffers = async () => {
      const flushStartedAt = Date.now();
      let flushedDailyRows = 0;
      let flushedSummaryRows = 0;
      let flushedSignalRows = 0;
      let flushedNeutralRows = 0;
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        flushedDailyRows += batch.length;
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (weeklySignalRowsBuffer.length > 0) {
        const batch = weeklySignalRowsBuffer.splice(0, weeklySignalRowsBuffer.length);
        flushedSignalRows += batch.length;
        await upsertDivergenceSignalsBatch(batch, null);
      }
      if (weeklyNeutralTickerBuffer.length > 0) {
        const neutralRows = weeklyNeutralTickerBuffer.splice(0, weeklyNeutralTickerBuffer.length);
        flushedNeutralRows += neutralRows.length;
        const neutralTickers = neutralRows.map((row) => row.ticker);
        const neutralTradeDates = neutralRows.map((row) => row.trade_date);
        await divergencePool!.query(
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
            AND ds.timeframe = '1w'
            AND ds.source_interval = $3
        `,
          [neutralTickers, neutralTradeDates, sourceInterval],
        );
      }
      if (flushedDailyRows > 0 || flushedSummaryRows > 0 || flushedSignalRows > 0 || flushedNeutralRows > 0) {
        runMetricsTracker?.recordDbFlush({
          durationMs: Date.now() - flushStartedAt,
          dailyRows: flushedDailyRows,
          summaryRows: flushedSummaryRows,
          signalRows: flushedSignalRows,
          neutralRows: flushedNeutralRows,
        });
      }
    };

    const enqueueFlush = () => {
      flushChain = flushChain
        .then(() => flushBuffers())
        .catch((err) => {
          console.error('Fetch-weekly on-the-fly flush error:', err instanceof Error ? err.message : String(err));
        });
      return flushChain;
    };

    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;

    persistResumeState(startIndex);

    // --- Worker function shared by main pass and retry pass ---
    const fetchWeeklyTickerWorker = async (ticker: string) => {
      return runWithAbortAndTimeout(
        async (tickerSignal) => {
          if (fetchWeeklyScan.shouldStop) {
            throw buildRequestAbortError('Fetch-weekly run stopped');
          }
          const sourceRows = await dataApiIntradayChartHistory(ticker, sourceInterval, runLookbackDays, {
            signal: tickerSignal,
            noCache: true,
            metricsTracker: runMetricsTracker,
          });
          const rows = await buildDivergenceDailyRowsForTicker({
            ticker,
            sourceInterval,
            lookbackDays: runLookbackDays,
            asOfTradeDate,
            parentInterval: '1day',
            signal: tickerSignal,
            noCache: true,
            sourceRows,
            metricsTracker: runMetricsTracker,
          });
          const weeklySnapshot = await buildLatestWeeklyBarSnapshotForTicker({
            ticker,
            sourceInterval,
            lookbackDays: runLookbackDays,
            asOfTradeDate: weeklyTradeDate,
            signal: tickerSignal,
            noCache: true,
            sourceRows,
            metricsTracker: runMetricsTracker,
          });
          const filteredRows = Array.isArray(rows)
            ? rows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate)
            : [];
          const latestRow = filteredRows.length > 0 ? filteredRows[filteredRows.length - 1] : null;
          const latestClose = Number(latestRow?.close);

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
          if (weeklySnapshot?.trade_date) {
            const signalType = classifyDivergenceSignal(
              Number(weeklySnapshot.volume_delta),
              Number(weeklySnapshot.close),
              Number(weeklySnapshot.prev_close),
            );
            if (signalType === 'bullish' || signalType === 'bearish') {
              weeklySignalRowsBuffer.push({
                ticker,
                signal_type: signalType,
                trade_date: weeklySnapshot.trade_date,
                timeframe: '1w',
                source_interval: sourceInterval,
                price: Number(weeklySnapshot.close),
                prev_close: Number(weeklySnapshot.prev_close),
                volume_delta: Number(weeklySnapshot.volume_delta),
              });
            } else {
              weeklyNeutralTickerBuffer.push({
                ticker,
                trade_date: weeklySnapshot.trade_date,
              });
            }
          }

          if (
            summaryRowsBuffer.length >= summaryFlushSize ||
            dailyRowsBuffer.length >= DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE ||
            weeklySignalRowsBuffer.length >= summaryFlushSize ||
            weeklyNeutralTickerBuffer.length >= summaryFlushSize
          ) {
            await enqueueFlush();
          }

          return { ticker, tradeDate: latestRow?.trade_date };
        },
        {
          signal: fetchWeeklyAbortController.signal,
          timeoutMs: DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
          label: `Fetch-weekly ticker ${ticker}`,
        },
      );
    };

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      fetchWeeklyTickerWorker,
      (settled: unknown, sliceIndex: number) => {
        const result = settled as Record<string, unknown>;
        settledCount += 1;
        processedTickers = startIndex + settledCount;
        const ticker = tickerSlice[sliceIndex] || '';
        if (result && result.error && !(fetchWeeklyScan.isStopping && isAbortError(result.error))) {
          errorTickers += 1;
          if (!isAbortError(result.error)) {
            failedTickers.push(ticker);
            runMetricsTracker?.recordFailedTicker(ticker);
            const err = result.error as Record<string, unknown> | undefined;
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Fetch-weekly divergence build failed for ${ticker}: ${message}`);
          }
        } else if (result && result.tradeDate) {
          lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, String(result.tradeDate));
        }
        fetchWeeklyScan.setStatus({
          processedTickers,
          errorTickers,
          lastPublishedTradeDate,
          status: fetchWeeklyScan.isStopping ? 'stopping' : 'running',
        });
        fetchWeeklyScan.setExtraStatus({ last_published_trade_date: lastPublishedTradeDate });
        runMetricsTracker?.setProgress(processedTickers, errorTickers);
        persistResumeState(startIndex + settledCount);
      },
      () => fetchWeeklyScan.shouldStop,
    );

    if (fetchWeeklyScan.isStopping) {
      await enqueueFlush();
      return markStopped(processedTickers);
    }

    await enqueueFlush();

    // --- Retry pass for failed tickers ---
    if (failedTickers.length > 0 && !fetchWeeklyScan.shouldStop) {
      const retryCount = failedTickers.length;
      console.log(`Fetch-weekly: retrying ${retryCount} failed ticker(s)...`);
      runMetricsTracker?.setPhase('retry');
      fetchWeeklyScan.setStatus({ status: 'running-retry' });
      let retryRecovered = 0;
      const stillFailedTickers: string[] = [];
      await mapWithConcurrency(
        failedTickers,
        Math.max(1, Math.floor(runConcurrency / 2)),
        fetchWeeklyTickerWorker,
        (settled: unknown, idx: number) => {
          const result = settled as Record<string, unknown>;
          const ticker = failedTickers[idx] || '';
          if (result && result.error) {
            if (!isAbortError(result.error)) {
              const err = result.error as Record<string, unknown> | undefined;
              const message = err instanceof Error ? err.message : String(err);
              console.error(`Fetch-weekly retry still failed for ${ticker}: ${message}`);
              stillFailedTickers.push(ticker);
            }
          } else {
            retryRecovered += 1;
            runMetricsTracker?.recordRetryRecovered(ticker);
            errorTickers = Math.max(0, errorTickers - 1);
          }
          fetchWeeklyScan.setStatus({ errorTickers });
          runMetricsTracker?.setProgress(processedTickers, errorTickers);
        },
        () => fetchWeeklyScan.shouldStop,
      );
      if (retryRecovered > 0) {
        console.log(`Fetch-weekly: retry recovered ${retryRecovered}/${retryCount} ticker(s)`);
      }
      await enqueueFlush();
      runMetricsTracker?.recordStallRetry();

      // --- Second retry pass for tickers that failed both attempts ---
      if (stillFailedTickers.length > 0 && !fetchWeeklyScan.shouldStop) {
        const retry2Count = stillFailedTickers.length;
        console.log(`Fetch-weekly: second retry for ${retry2Count} ticker(s)...`);
        runMetricsTracker?.setPhase('retry-2');
        fetchWeeklyScan.setStatus({ status: 'running-retry' });
        let retry2Recovered = 0;
        await mapWithConcurrency(
          stillFailedTickers,
          Math.max(1, Math.floor(runConcurrency / 4)),
          fetchWeeklyTickerWorker,
          (settled: unknown, idx: number) => {
            const result = settled as Record<string, unknown>;
            const ticker = stillFailedTickers[idx] || '';
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const err = result.error as Record<string, unknown> | undefined;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`Fetch-weekly retry-2 still failed for ${ticker}: ${message}`);
              }
            } else {
              retry2Recovered += 1;
              runMetricsTracker?.recordRetryRecovered(ticker);
              errorTickers = Math.max(0, errorTickers - 1);
            }
            fetchWeeklyScan.setStatus({ errorTickers });
            runMetricsTracker?.setProgress(processedTickers, errorTickers);
          },
          () => fetchWeeklyScan.shouldStop,
        );
        if (retry2Recovered > 0) {
          console.log(`Fetch-weekly: second retry recovered ${retry2Recovered}/${retry2Count} ticker(s)`);
        }
        await enqueueFlush();
        runMetricsTracker?.recordStallRetry();
      }
    }

    if (maSeedRows.length > 0) {
      runMetricsTracker?.setPhase('ma-enrichment');
      fetchWeeklyScan.setStatus({ status: 'running-ma' });
      const maConcurrency = Math.max(1, Math.min(runConcurrency, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY));
      const failedMaSeeds: Array<{ ticker: string; source_interval: string; trade_date: string; states: Record<string, string>; latest_close: number; latest_prev_close: number; latest_volume_delta: number }> = [];

      const fetchWeeklyMaWorker = async (seed: { ticker: string; source_interval: string; trade_date: string; states: Record<string, string>; latest_close: number; latest_prev_close: number; latest_volume_delta: number }) => {
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
            signal: fetchWeeklyAbortController.signal,
            timeoutMs: DIVERGENCE_FETCH_MA_TIMEOUT_MS,
            label: `Fetch-weekly MA ${seed.ticker}`,
          },
        );
      };

      await mapWithConcurrency(
        maSeedRows,
        maConcurrency,
        fetchWeeklyMaWorker,
        (settled: unknown, idx: number) => {
          const result = settled as Record<string, unknown>;
          if (result && result.error && !isAbortError(result.error)) {
            failedMaSeeds.push(maSeedRows[idx]);
            const err = result.error as Record<string, unknown> | undefined;
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Fetch-weekly MA enrichment failed: ${message}`);
          }
        },
        () => fetchWeeklyScan.shouldStop,
      );

      if (fetchWeeklyScan.isStopping) {
        await enqueueFlush();
        return markStopped(totalTickers, { preserveResume: false, rewind: false });
      }
      await enqueueFlush();

      // --- Retry pass for failed MA tickers ---
      if (failedMaSeeds.length > 0 && !fetchWeeklyScan.shouldStop) {
        const maRetryCount = failedMaSeeds.length;
        console.log(`Fetch-weekly: retrying ${maRetryCount} failed MA ticker(s)...`);
        fetchWeeklyScan.setStatus({ status: 'running-ma-retry' });
        let maRetryRecovered = 0;
        const stillFailedMaSeeds: Array<{ ticker: string; source_interval: string; trade_date: string; states: Record<string, string>; latest_close: number; latest_prev_close: number; latest_volume_delta: number }> = [];
        await mapWithConcurrency(
          failedMaSeeds,
          Math.max(1, Math.floor(maConcurrency / 2)),
          fetchWeeklyMaWorker,
          (settled: unknown, idx: number) => {
            const result = settled as Record<string, unknown>;
            const seed = failedMaSeeds[idx];
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const err = result.error as Record<string, unknown> | undefined;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`Fetch-weekly MA retry still failed for ${seed?.ticker}: ${message}`);
                stillFailedMaSeeds.push(seed);
              }
            } else {
              maRetryRecovered += 1;
            }
          },
          () => fetchWeeklyScan.shouldStop,
        );
        if (maRetryRecovered > 0) {
          console.log(`Fetch-weekly: MA retry recovered ${maRetryRecovered}/${maRetryCount} ticker(s)`);
        }
        await enqueueFlush();

        // --- Second retry pass for MA tickers ---
        if (stillFailedMaSeeds.length > 0 && !fetchWeeklyScan.shouldStop) {
          const maRetry2Count = stillFailedMaSeeds.length;
          console.log(`Fetch-weekly: second MA retry for ${maRetry2Count} ticker(s)...`);
          fetchWeeklyScan.setStatus({ status: 'running-ma-retry' });
          let maRetry2Recovered = 0;
          await mapWithConcurrency(
            stillFailedMaSeeds,
            Math.max(1, Math.floor(maConcurrency / 4)),
            fetchWeeklyMaWorker,
            (settled: unknown, idx: number) => {
              const result = settled as Record<string, unknown>;
              const seed = stillFailedMaSeeds[idx];
              if (result && result.error) {
                if (!isAbortError(result.error)) {
                  const err = result.error as Record<string, unknown> | undefined;
                  const message = err instanceof Error ? err.message : String(err);
                  console.error(`Fetch-weekly MA retry-2 still failed for ${seed?.ticker}: ${message}`);
                }
              } else {
                maRetry2Recovered += 1;
              }
            },
            () => fetchWeeklyScan.shouldStop,
          );
          if (maRetry2Recovered > 0) {
            console.log(`Fetch-weekly: second MA retry recovered ${maRetry2Recovered}/${maRetry2Count} ticker(s)`);
          }
          await enqueueFlush();
        }
      }
    }

    runMetricsTracker?.setPhase('publishing');
    clearDivergenceSummaryCacheForSourceInterval(sourceInterval);

    fetchWeeklyScan.setResumeState(null);
    fetchWeeklyScan.setStopRequested(false);
    fetchWeeklyScan.replaceStatus({
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: weeklyTradeDate || fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
    });
    fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '' });
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: weeklyTradeDate || null,
    };
  } catch (err: unknown) {
    try {
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (weeklySignalRowsBuffer.length > 0) {
        const batch = weeklySignalRowsBuffer.splice(0, weeklySignalRowsBuffer.length);
        await upsertDivergenceSignalsBatch(batch, null);
      }
      if (weeklyNeutralTickerBuffer.length > 0) {
        const neutralRows = weeklyNeutralTickerBuffer.splice(0, weeklyNeutralTickerBuffer.length);
        const neutralTickers = neutralRows.map((row) => row.ticker);
        const neutralTradeDates = neutralRows.map((row) => row.trade_date);
        await divergencePool!.query(
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
            AND ds.timeframe = '1w'
            AND ds.source_interval = $3
        `,
          [neutralTickers, neutralTradeDates, sourceInterval],
        );
      }
    } catch (flushErr: unknown) {
      console.error(
        'Fetch-weekly error-path flush failed:',
        flushErr instanceof Error ? flushErr.message : String(flushErr),
      );
    }

    if (fetchWeeklyScan.isStopping || isAbortError(err)) {
      const safeNextIndex = Math.max(0, processedTickers - runConcurrency);
      fetchWeeklyScan.setResumeState(normalizeFetchWeeklyDataResumeState({
        asOfTradeDate,
        weeklyTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: safeNextIndex,
        processedTickers: safeNextIndex,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate,
      }));
      fetchWeeklyScan.setStopRequested(false);
      fetchWeeklyScan.replaceStatus({
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: weeklyTradeDate || fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
      });
      fetchWeeklyScan.setExtraStatus({
        last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
      });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: weeklyTradeDate || null,
      };
    }
    fetchWeeklyScan.setStopRequested(false);
    fetchWeeklyScan.replaceStatus({
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
    });
    fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '' });
    throw err;
  } finally {
    if (runMetricsTracker) {
      const finalStatus = fetchWeeklyScan.readStatus();
      runMetricsTracker.finish(finalStatus.status || 'completed', {
        totalTickers,
        processedTickers: Number(finalStatus.processedTickers || processedTickers || 0),
        errorTickers: Number(finalStatus.errorTickers || errorTickers || 0),
        phase: finalStatus.status || 'completed',
        meta: {
          sourceInterval,
          asOfTradeDate,
          weeklyTradeDate,
          lastPublishedTradeDate,
          failedTickers,
        },
      });
    }
    fetchWeeklyScan.cleanup(fetchWeeklyAbortController);
  }
}

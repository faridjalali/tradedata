import { DIVERGENCE_SCANNER_ENABLED } from '../config.js';
import { isDivergenceConfigured } from '../db.js';
import { currentEtDateString, easternLocalToUtcMs } from '../lib/dateUtils.js';
import { runDivergenceFetchDailyData } from '../orchestrators/fetchDailyOrchestrator.js';
import { runDivergenceFetchWeeklyData } from '../orchestrators/fetchWeeklyOrchestrator.js';
import { runBreadthComputation, cleanupBreadthData } from './breadthService.js';
import { divergenceSchedulerTimer, setDivergenceSchedulerTimer } from './scanControlService.js';
import * as tradingCalendar from './tradingCalendar.js';
import { runVDFScan } from './vdfService.js';

const SCHEDULER_ENABLED_BY_CONFIG = Boolean(DIVERGENCE_SCANNER_ENABLED);
const STEP_MAX_ATTEMPTS = 3; // Initial attempt + 2 retries
const STEP_RETRY_DELAY_MS = 20_000;

let schedulerEnabledRuntime = SCHEDULER_ENABLED_BY_CONFIG;
let nextDivergenceRunUtcMs: number | null = null;
let nextWeeklyRunUtcMs: number | null = null;

function etDateStringFor(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFridayEt(dateKey: string): boolean {
  const parts = String(dateKey || '')
    .split('-')
    .map(Number);
  if (parts.length !== 3) return false;
  const [year, month, day] = parts;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 5;
}

function getStatus(result: unknown): string {
  if (!result || typeof result !== 'object') return 'completed';
  const status = (result as { status?: unknown }).status;
  return String(status || 'completed')
    .trim()
    .toLowerCase();
}

function isSuccessfulStatus(status: string): boolean {
  return status === 'completed' || status === 'success' || status === 'ok' || status === 'skipped';
}

interface StepRunOptions {
  ignoreRuntimeEnabled?: boolean;
  retryDelayMs?: number;
}

export interface TradingDayPipelineDeps {
  runFetchDaily?: () => Promise<unknown>;
  runFetchAnalysis?: () => Promise<unknown>;
  runFetchBreadth?: (tradeDate: string) => Promise<void>;
  runBreadthCleanup?: () => Promise<void>;
  runFetchWeekly?: () => Promise<unknown>;
}

export type TradingDayPipelineOptions = StepRunOptions;

async function runStepWithRetries(
  label: string,
  step: () => Promise<unknown>,
  options: StepRunOptions = {},
): Promise<void> {
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? STEP_RETRY_DELAY_MS));
  for (let attempt = 1; attempt <= STEP_MAX_ATTEMPTS; attempt += 1) {
    if (!options.ignoreRuntimeEnabled && !schedulerEnabledRuntime) return;
    try {
      const result = await step();
      const status = getStatus(result);
      if (isSuccessfulStatus(status)) {
        console.log(`[scheduler] ${label} completed (attempt ${attempt}/${STEP_MAX_ATTEMPTS})`);
        return;
      }
      console.warn(`[scheduler] ${label} returned status=${status} (attempt ${attempt}/${STEP_MAX_ATTEMPTS})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] ${label} failed (attempt ${attempt}/${STEP_MAX_ATTEMPTS}): ${message}`);
    }

    if (attempt < STEP_MAX_ATTEMPTS && retryDelayMs > 0) {
      await wait(retryDelayMs);
    }
  }
  console.error(`[scheduler] ${label} exhausted retries; continuing to next step`);
}

export async function runTradingDayPipelineForDate(
  tradeDate: string,
  deps: TradingDayPipelineDeps = {},
  options: TradingDayPipelineOptions = {},
): Promise<void> {
  const runFetchDaily = deps.runFetchDaily ?? (() => runDivergenceFetchDailyData({ trigger: 'scheduler' }));
  const runFetchAnalysis = deps.runFetchAnalysis ?? (() => runVDFScan());
  const runFetchBreadth = deps.runFetchBreadth ?? ((date: string) => runBreadthComputation(date));
  const runBreadthCleanup = deps.runBreadthCleanup ?? (() => cleanupBreadthData());
  const runFetchWeekly = deps.runFetchWeekly ?? (() => runDivergenceFetchWeeklyData({ trigger: 'scheduler-weekly' }));
  console.log(`[scheduler] Trading-day pipeline started for ${tradeDate}`);

  await runStepWithRetries('Fetch Daily', () => runFetchDaily(), options);
  await runStepWithRetries('Fetch Analysis', () => runFetchAnalysis(), options);
  await runStepWithRetries(
    'Fetch Breadth',
    async () => {
      await runFetchBreadth(tradeDate);
      await runBreadthCleanup();
      return { status: 'completed' };
    },
    options,
  );
  if (isFridayEt(tradeDate)) {
    await runStepWithRetries('Fetch Weekly', () => runFetchWeekly(), options);
  }

  console.log(`[scheduler] Trading-day pipeline finished for ${tradeDate}`);
}

async function runScheduledTradingDayPipeline(): Promise<void> {
  if (!schedulerEnabledRuntime) return;
  if (!isDivergenceConfigured()) {
    console.warn('[scheduler] Divergence DB is not configured; skipping trading-day pipeline');
    return;
  }
  const tradeDate = currentEtDateString();
  await runTradingDayPipelineForDate(tradeDate);
}

export function getNextDivergenceScanUtcMs(nowUtc = new Date()): number {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  candidate.setHours(16, 20, 0, 0);

  if (!tradingCalendar.isTradingDay(etDateStringFor(candidate)) || nowEt.getTime() >= candidate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 20 && !tradingCalendar.isTradingDay(etDateStringFor(candidate)); i += 1) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return easternLocalToUtcMs(candidate.getFullYear(), candidate.getMonth() + 1, candidate.getDate(), 16, 20);
}

export function getNextWeeklyFetchUtcMs(nowUtc = new Date()): number {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  candidate.setHours(16, 20, 0, 0);
  const isFriday = candidate.getDay() === 5;
  const isTodayFridayBeforeRun = isFriday && nowEt.getTime() < candidate.getTime();
  if (!isTodayFridayBeforeRun) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 8 && candidate.getDay() !== 5; i += 1) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  // Ensure we land on a Friday trading day.
  for (let i = 0; i < 14 && !tradingCalendar.isTradingDay(etDateStringFor(candidate)); i += 1) {
    candidate.setDate(candidate.getDate() + 7);
  }

  return easternLocalToUtcMs(candidate.getFullYear(), candidate.getMonth() + 1, candidate.getDate(), 16, 20);
}

function clearDivergenceSchedulerTimer(): void {
  if (divergenceSchedulerTimer) clearTimeout(divergenceSchedulerTimer);
  setDivergenceSchedulerTimer(null);
  nextDivergenceRunUtcMs = null;
}

function clearWeeklySchedulerTimer(): void {
  nextWeeklyRunUtcMs = null;
}

export function scheduleNextDivergenceScan(): void {
  if (!schedulerEnabledRuntime || !isDivergenceConfigured()) {
    clearDivergenceSchedulerTimer();
    return;
  }

  if (divergenceSchedulerTimer) clearTimeout(divergenceSchedulerTimer);
  const nextRunMs = getNextDivergenceScanUtcMs(new Date());
  nextDivergenceRunUtcMs = nextRunMs;
  nextWeeklyRunUtcMs = getNextWeeklyFetchUtcMs(new Date());
  const delayMs = Math.max(1000, nextRunMs - Date.now());

  const timer = setTimeout(async () => {
    try {
      await runScheduledTradingDayPipeline();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Trading-day pipeline crashed: ${message}`);
    } finally {
      nextDivergenceRunUtcMs = null;
      if (schedulerEnabledRuntime) {
        scheduleNextDivergenceScan();
      }
    }
  }, delayMs);

  setDivergenceSchedulerTimer(timer);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[scheduler] Next trading-day pipeline scheduled in ${Math.round(delayMs / 1000)}s`);
}

export function scheduleNextBreadthComputation(): void {
  // Backward-compatible no-op entrypoint: weekly fetch now runs after Friday
  // trading-day pipeline completion, not on an independent timer.
  if (!schedulerEnabledRuntime || !isDivergenceConfigured()) {
    clearWeeklySchedulerTimer();
    return;
  }
  nextWeeklyRunUtcMs = getNextWeeklyFetchUtcMs(new Date());
}

export function getSchedulerState(): {
  enabledByConfig: boolean;
  enabled: boolean;
  nextDivergenceRunUtc: string | null;
  nextBreadthRunUtc: string | null;
  nextWeeklyRunUtc: string | null;
} {
  const nextDivergenceRunUtc = nextDivergenceRunUtcMs ? new Date(nextDivergenceRunUtcMs).toISOString() : null;
  const nextWeeklyRunUtc = nextWeeklyRunUtcMs ? new Date(nextWeeklyRunUtcMs).toISOString() : null;
  return {
    enabledByConfig: SCHEDULER_ENABLED_BY_CONFIG,
    enabled: schedulerEnabledRuntime,
    // Backward-compatible field name used by admin payload typing.
    nextDivergenceRunUtc,
    // Backward-compatible alias; now represents Friday weekly fetch.
    nextBreadthRunUtc: nextWeeklyRunUtc,
    nextWeeklyRunUtc,
  };
}

export function setSchedulerEnabled(enabled: boolean): {
  enabledByConfig: boolean;
  enabled: boolean;
  nextDivergenceRunUtc: string | null;
  nextBreadthRunUtc: string | null;
  nextWeeklyRunUtc: string | null;
} {
  schedulerEnabledRuntime = Boolean(enabled);
  if (!schedulerEnabledRuntime) {
    clearDivergenceSchedulerTimer();
    clearWeeklySchedulerTimer();
    return getSchedulerState();
  }

  scheduleNextDivergenceScan();
  scheduleNextBreadthComputation();
  return getSchedulerState();
}

/**
 * Scan control — lifecycle management for divergence scans, table builds,
 * daily/weekly fetches, and VDF scans.  Includes polling loop, button state
 * management, and status text formatting.
 */

import {
  startDivergenceScan,
  pauseDivergenceScan,
  resumeDivergenceScan,
  stopDivergenceScan,
  startDivergenceTableBuild,
  pauseDivergenceTableBuild,
  resumeDivergenceTableBuild,
  stopDivergenceTableBuild,
  startDivergenceFetchDailyData,
  stopDivergenceFetchDailyData,
  startDivergenceFetchWeeklyData,
  stopDivergenceFetchWeeklyData,
  startVDFScan,
  stopVDFScan,
  fetchDivergenceScanStatus,
  DivergenceScanStatus,
} from './divergenceApi';
import { hydrateAlertCardDivergenceTables } from './divergenceTable';
import { refreshActiveTickerDivergenceSummary, isChartActivelyLoading } from './chart';
import type { Alert } from './types';

// ---------------------------------------------------------------------------
// Callback injection — avoids circular dependency with feed-render module.
// The barrel (divergenceFeed.ts) calls initScanControl() at import time.
// ---------------------------------------------------------------------------

interface ScanControlCallbacks {
  renderDivergenceContainer: (timeframe: '1d' | '1w') => void;
  renderDivergenceOverview: () => void;
  fetchDivergenceSignals: (_force?: boolean) => Promise<Alert[]>;
  fetchDivergenceSignalsByTimeframe: (timeframe: '1d' | '1w') => Promise<Alert[]>;
}

let callbacks: ScanControlCallbacks | null = null;

export function initScanControl(cb: ScanControlCallbacks): void {
  callbacks = cb;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOP_ICON_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="10" height="10" rx="1"/></svg>';
const DIVERGENCE_POLL_ERROR_THRESHOLD = 3;
const DIVERGENCE_TABLE_UI_REFRESH_MIN_MS = 8000;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let divergenceScanPollTimer: number | null = null;
let divergenceScanPollInFlight = false;
let divergenceScanPollConsecutiveErrors = 0;

let divergenceFetchDailyLastProcessedTickers = -1;
let divergenceFetchWeeklyLastProcessedTickers = -1;
let divergenceTableLastUiRefreshAtMs = 0;
let vdfScanLastProcessedTickers = -1;

let divergenceTableRunningState = false;
let divergenceFetchDailyRunningState = false;
let divergenceFetchWeeklyRunningState = false;
let allowAutoCardRefreshFromFetchDaily = false;
let allowAutoCardRefreshFromFetchWeekly = false;
let allowAutoCardRefreshFromVDFScan = false;

// ---------------------------------------------------------------------------
// DOM query helpers
// ---------------------------------------------------------------------------

function getRunButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
  return {
    button: document.getElementById('divergence-run-btn') as HTMLButtonElement | null,
    status: document.getElementById('divergence-run-status'),
  };
}

function getTableRunButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
  return {
    button: document.getElementById('divergence-run-table-btn') as HTMLButtonElement | null,
    status: document.getElementById('divergence-table-run-status'),
  };
}

function getFetchDailyButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
  return {
    button: document.getElementById('divergence-fetch-daily-btn') as HTMLButtonElement | null,
    status: document.getElementById('divergence-fetch-daily-status'),
  };
}

function getFetchWeeklyButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
  return {
    button: document.getElementById('divergence-fetch-weekly-btn') as HTMLButtonElement | null,
    status: document.getElementById('divergence-fetch-weekly-status'),
  };
}

function getRunControlButtons(): {
  pauseResumeButton: HTMLButtonElement | null;
  stopButton: HTMLButtonElement | null;
} {
  return {
    pauseResumeButton: document.getElementById('divergence-run-pause-resume-btn') as HTMLButtonElement | null,
    stopButton: document.getElementById('divergence-run-stop-btn') as HTMLButtonElement | null,
  };
}

function getTableControlButtons(): {
  pauseResumeButton: HTMLButtonElement | null;
  stopButton: HTMLButtonElement | null;
  manualUpdateButton: HTMLButtonElement | null;
} {
  return {
    pauseResumeButton: document.getElementById('divergence-table-pause-resume-btn') as HTMLButtonElement | null,
    stopButton: document.getElementById('divergence-table-stop-btn') as HTMLButtonElement | null,
    manualUpdateButton: document.getElementById('divergence-manual-update-btn') as HTMLButtonElement | null,
  };
}

function getFetchDailyControlButtons(): { stopButton: HTMLButtonElement | null } {
  return {
    stopButton: document.getElementById('divergence-fetch-daily-stop-btn') as HTMLButtonElement | null,
  };
}

function getFetchWeeklyControlButtons(): { stopButton: HTMLButtonElement | null } {
  return {
    stopButton: document.getElementById('divergence-fetch-weekly-stop-btn') as HTMLButtonElement | null,
  };
}

function getVDFScanButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
  return {
    button: document.getElementById('divergence-vdf-scan-btn') as HTMLButtonElement | null,
    status: document.getElementById('divergence-vdf-scan-status'),
  };
}

function getVDFScanControlButtons(): { stopButton: HTMLButtonElement | null } {
  return {
    stopButton: document.getElementById('divergence-vdf-scan-stop-btn') as HTMLButtonElement | null,
  };
}

// ---------------------------------------------------------------------------
// Button state setters
// ---------------------------------------------------------------------------

function setRunButtonState(running: boolean, canResume = false): void {
  const { button } = getRunButtonElements();
  if (!button) return;
  button.disabled = running || canResume;
  button.classList.toggle('active', running);
  button.textContent = running ? 'Running' : 'Run Fetch';
}

function setRunStatusText(text: string): void {
  const { status } = getRunButtonElements();
  if (!status) return;
  status.textContent = text;
}

function setTableRunButtonState(running: boolean, canResume = false): void {
  const { button } = getTableRunButtonElements();
  if (!button) return;
  button.disabled = running || canResume;
  button.classList.toggle('active', running);
  button.textContent = running ? 'Running' : 'Run Table';
}

function setTableRunStatusText(text: string): void {
  const { status } = getTableRunButtonElements();
  if (!status) return;
  status.textContent = text;
}

function setFetchDailyButtonState(running: boolean, canResume = false): void {
  const { button } = getFetchDailyButtonElements();
  if (!button) return;
  button.disabled = running;
  button.classList.toggle('active', running);
  if (canResume && !running) {
    button.textContent = 'Resume Fetch';
  } else {
    button.textContent = 'Fetch Daily';
  }
}

function setFetchDailyStatusText(text: string): void {
  const { status } = getFetchDailyButtonElements();
  if (!status) return;
  status.textContent = text;
}

function setFetchWeeklyButtonState(running: boolean, canResume = false): void {
  const { button } = getFetchWeeklyButtonElements();
  if (!button) return;
  button.disabled = running;
  button.classList.toggle('active', running);
  if (canResume && !running) {
    button.textContent = 'Resume Fetch';
  } else {
    button.textContent = 'Fetch Weekly';
  }
}

function setFetchWeeklyStatusText(text: string): void {
  const { status } = getFetchWeeklyButtonElements();
  if (!status) return;
  status.textContent = text;
}

function setVDFScanButtonState(running: boolean): void {
  const { button } = getVDFScanButtonElements();
  if (!button) return;
  button.disabled = running;
  button.classList.toggle('active', running);
  button.textContent = 'Analyze';
}

function setVDFScanStatusText(text: string): void {
  const { status } = getVDFScanButtonElements();
  if (!status) return;
  status.textContent = text;
}

// ---------------------------------------------------------------------------
// Control button state setters
// ---------------------------------------------------------------------------

function setVDFScanControlButtonState(status: DivergenceScanStatus | null): void {
  const { stopButton } = getVDFScanControlButtons();
  const vdfScan = status?.vdfScan || null;
  const running = Boolean(vdfScan?.running);
  const stopRequested = Boolean(vdfScan?.stop_requested);
  if (stopButton) {
    stopButton.innerHTML = STOP_ICON_SVG;
    stopButton.disabled = !running || stopRequested;
    stopButton.classList.toggle('active', running);
    stopButton.setAttribute('aria-label', 'Stop VDF Scan');
  }
}

function setRunControlButtonState(status: DivergenceScanStatus | null): void {
  const { pauseResumeButton, stopButton } = getRunControlButtons();
  const scan = status?.scanControl || null;
  const running = Boolean(scan?.running || status?.running);
  const pauseRequested = Boolean(scan?.pause_requested);
  const canResume = Boolean(scan?.can_resume);
  const stopRequested = Boolean(scan?.stop_requested);
  if (pauseResumeButton) {
    pauseResumeButton.textContent = canResume && !running ? '▶' : '⏸';
    pauseResumeButton.disabled = running ? pauseRequested : !canResume;
    pauseResumeButton.classList.toggle('active', running || canResume);
    pauseResumeButton.setAttribute('aria-label', canResume && !running ? 'Resume Run Fetch' : 'Pause Run Fetch');
    pauseResumeButton.title = canResume && !running ? 'Resume Run Fetch' : 'Pause Run Fetch';
  }
  if (stopButton) {
    stopButton.innerHTML = STOP_ICON_SVG;
    stopButton.disabled = !running || stopRequested;
    stopButton.classList.toggle('active', running);
    stopButton.setAttribute('aria-label', 'Stop Run Fetch');
    stopButton.title = 'Stop Run Fetch';
  }
}

function setTableControlButtonState(status: DivergenceScanStatus | null): void {
  const { pauseResumeButton, stopButton, manualUpdateButton } = getTableControlButtons();
  const table = status?.tableBuild || null;
  const running = Boolean(table?.running);
  const pauseRequested = Boolean(table?.pause_requested);
  const stopRequested = Boolean(table?.stop_requested);
  const canResume = Boolean(table?.can_resume);

  if (pauseResumeButton) {
    pauseResumeButton.textContent = canResume && !running ? '▶' : '⏸';
    pauseResumeButton.disabled = running ? pauseRequested : !canResume;
    pauseResumeButton.classList.toggle('active', running || canResume);
    pauseResumeButton.setAttribute('aria-label', canResume && !running ? 'Resume Run Table' : 'Pause Run Table');
    pauseResumeButton.title = canResume && !running ? 'Resume Run Table' : 'Pause Run Table';
  }
  if (stopButton) {
    stopButton.innerHTML = STOP_ICON_SVG;
    stopButton.disabled = !running || stopRequested;
    stopButton.classList.toggle('active', running);
    stopButton.setAttribute('aria-label', 'Stop Run Table');
    stopButton.title = 'Stop Run Table';
  }
  if (manualUpdateButton) {
    manualUpdateButton.disabled = false;
  }
}

function setFetchDailyControlButtonState(status: DivergenceScanStatus | null): void {
  const { stopButton } = getFetchDailyControlButtons();
  const fetchDaily = status?.fetchDailyData || null;
  const running = Boolean(fetchDaily?.running);
  const stopRequested = Boolean(fetchDaily?.stop_requested);
  if (stopButton) {
    stopButton.innerHTML = STOP_ICON_SVG;
    stopButton.disabled = !running || stopRequested;
    stopButton.classList.toggle('active', running);
    stopButton.setAttribute('aria-label', 'Stop Fetch Daily');
  }
}

function setFetchWeeklyControlButtonState(status: DivergenceScanStatus | null): void {
  const { stopButton } = getFetchWeeklyControlButtons();
  const fetchWeekly = status?.fetchWeeklyData || null;
  const running = Boolean(fetchWeekly?.running);
  const stopRequested = Boolean(fetchWeekly?.stop_requested);
  if (stopButton) {
    stopButton.innerHTML = STOP_ICON_SVG;
    stopButton.disabled = !running || stopRequested;
    stopButton.classList.toggle('active', running);
    stopButton.setAttribute('aria-label', 'Stop Fetch Weekly');
  }
}

// ---------------------------------------------------------------------------
// Status text helpers
// ---------------------------------------------------------------------------

function toStatusTextFromError(error: unknown): string {
  const message = String((error as any)?.message || error || '').trim();
  if (!message) return 'Run failed';
  if (/not configured/i.test(message)) return 'DB issue';
  if (/unauthorized/i.test(message)) return 'Unauthorized';
  if (/already running|running/i.test(message)) return 'Running';
  return message.length > 56 ? `${message.slice(0, 56)}...` : message;
}

function toDateKey(raw?: string | null): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function toDateKeyAsET(raw?: string | null): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const parts = d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [mm, dd, yyyy] = parts.split('/');
  if (!mm || !dd || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function dateKeyToMmDd(dateKey: string): string {
  const parts = dateKey.split('-');
  if (parts.length !== 3) return '';
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(month) || month <= 0 || !Number.isFinite(day) || day <= 0) return '';
  return `${month}/${day}`;
}

function summarizeLastRunDate(status: DivergenceScanStatus): string {
  const latest = status.latestJob as
    | (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string })
    | null;
  const runDateKey =
    toDateKey(status.lastScanDateEt) ||
    toDateKey(latest?.scanned_trade_date) ||
    toDateKey(latest?.run_for_date) ||
    toDateKey(latest?.finished_at) ||
    toDateKey(latest?.started_at);

  if (!runDateKey) return 'Fetched';
  const mmdd = dateKeyToMmDd(runDateKey);
  return mmdd ? `Fetched ${mmdd}` : 'Fetched';
}

// ---------------------------------------------------------------------------
// Status summary formatters
// ---------------------------------------------------------------------------

function summarizeStatus(status: DivergenceScanStatus): string {
  const latest = status.latestJob;
  const scan = status.scanControl || null;
  if (status.running) {
    const processed = Number(latest?.processed_symbols || 0);
    const total = Number(latest?.total_symbols || 0);
    if (scan?.stop_requested) {
      if (total > 0) return `Stopping ${processed}/${total}`;
      return 'Stopping';
    }
    if (scan?.pause_requested) {
      if (total > 0) return `Pausing ${processed}/${total}`;
      return 'Pausing';
    }
    if (total > 0) return `Running ${processed}/${total}`;
    return 'Running';
  }

  if (latest?.status === 'paused') {
    const processed = Number(latest?.processed_symbols || 0);
    const total = Number(latest?.total_symbols || 0);
    if (total > 0) return `Paused ${processed}/${total}`;
    return 'Paused';
  }
  if (latest?.status === 'stopped') {
    return 'Stopped';
  }
  if (latest?.status === 'completed') {
    return summarizeLastRunDate(status);
  }
  if (latest?.status === 'failed') {
    return 'Last run failed';
  }
  if (status.lastScanDateEt || latest?.run_for_date || latest?.finished_at || latest?.started_at) {
    return summarizeLastRunDate(status);
  }
  return 'Idle';
}

function summarizeTableStatus(status: DivergenceScanStatus): string {
  const table = status.tableBuild;
  if (!table) return 'Table idle';
  const tableState = String(table.status || '').toLowerCase();
  const errorTickers = Number(table.error_tickers || 0);
  if (tableState === 'stopped') {
    return 'Table stopped';
  }
  if (tableState === 'paused') {
    const processed = Number(table.processed_tickers || 0);
    const total = Number(table.total_tickers || 0);
    if (total > 0) return `Paused ${processed}/${total}`;
    return 'Table paused';
  }
  if (table.running) {
    const processed = Number(table.processed_tickers || 0);
    const total = Number(table.total_tickers || 0);
    if (table.stop_requested) {
      if (total > 0) return `Stopping ${processed}/${total}`;
      return 'Stopping';
    }
    if (table.pause_requested) {
      if (total > 0) return `Pausing ${processed}/${total}`;
      return 'Pausing';
    }
    if (total > 0) return `Table ${processed}/${total}`;
    return 'Table running';
  }
  if (tableState === 'completed') {
    const dateKey = toDateKey(table.last_published_trade_date || null);
    const mmdd = dateKey ? dateKeyToMmDd(dateKey) : '';
    return mmdd ? `Table ${mmdd}` : 'Table fetched';
  }
  if (tableState === 'completed-with-errors') {
    const dateKey = toDateKey(table.last_published_trade_date || null);
    const mmdd = dateKey ? dateKeyToMmDd(dateKey) : '';
    if (mmdd && errorTickers > 0) return `Table ${mmdd} (${errorTickers} errors)`;
    if (errorTickers > 0) return `Table done (${errorTickers} errors)`;
    return mmdd ? `Table ${mmdd}` : 'Table fetched';
  }
  if (tableState === 'failed') {
    return 'Table failed';
  }
  return 'Table idle';
}

function summarizeFetchDailyStatus(status: DivergenceScanStatus): string {
  const fetchDaily = status.fetchDailyData;
  const latest = status.latestJob as
    | (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string })
    | null;
  const lastRunDateKey =
    toDateKey(fetchDaily?.last_published_trade_date || null) ||
    toDateKey(status.lastScanDateEt) ||
    toDateKey(latest?.scanned_trade_date) ||
    toDateKey(latest?.run_for_date) ||
    toDateKey(latest?.finished_at) ||
    toDateKey(latest?.started_at);
  const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
  if (!fetchDaily) return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
  const fetchDailyState = String(fetchDaily.status || '').toLowerCase();
  if (fetchDailyState === 'stopping') {
    return 'Stopping';
  }
  if (fetchDailyState === 'stopped') {
    if (fetchDaily.can_resume) return 'Resumable Stop';
    return 'Stopped';
  }
  if (fetchDaily.running) {
    const processed = Number(fetchDaily.processed_tickers || 0);
    const total = Number(fetchDaily.total_tickers || 0);
    if (fetchDaily.stop_requested) {
      return 'Stopping';
    }
    if (fetchDailyState === 'running-retry') {
      return 'Retrying';
    }
    if (fetchDailyState === 'running-ma') {
      return `MA ${processed} / ${total}`;
    }
    if (fetchDailyState === 'running-ma-retry') {
      return 'MA - Retrying';
    }
    return `${processed} / ${total}`;
  }
  if (fetchDailyState === 'completed') {
    return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
  }
  if (fetchDailyState === 'completed-with-errors') {
    return lastRunMmDd ? `Fetched (E) ${lastRunMmDd}` : 'Due for Fetch';
  }
  if (fetchDailyState === 'failed') {
    return lastRunMmDd ? `Failed ${lastRunMmDd}` : 'Due for Fetch';
  }
  return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
}

function summarizeFetchWeeklyStatus(status: DivergenceScanStatus): string {
  const fetchWeekly = status.fetchWeeklyData;
  const latest = status.latestJob as
    | (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string })
    | null;
  const lastRunDateKey =
    toDateKey(fetchWeekly?.last_published_trade_date || null) ||
    toDateKey(status.lastScanDateEt) ||
    toDateKey(latest?.scanned_trade_date) ||
    toDateKey(latest?.run_for_date) ||
    toDateKey(latest?.finished_at) ||
    toDateKey(latest?.started_at);
  const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
  if (!fetchWeekly) return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
  const fetchWeeklyState = String(fetchWeekly.status || '').toLowerCase();
  if (fetchWeeklyState === 'stopping') {
    return 'Stopping';
  }
  if (fetchWeeklyState === 'stopped') {
    if (fetchWeekly.can_resume) return 'Resumable Stop';
    return 'Stopped';
  }
  if (fetchWeekly.running) {
    const processed = Number(fetchWeekly.processed_tickers || 0);
    const total = Number(fetchWeekly.total_tickers || 0);
    if (fetchWeekly.stop_requested) {
      return 'Stopping';
    }
    if (fetchWeeklyState === 'running-retry') {
      return 'Retrying';
    }
    if (fetchWeeklyState === 'running-ma') {
      return `MA ${processed} / ${total}`;
    }
    if (fetchWeeklyState === 'running-ma-retry') {
      return 'MA - Retrying';
    }
    return `${processed} / ${total}`;
  }
  if (fetchWeeklyState === 'completed') {
    return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
  }
  if (fetchWeeklyState === 'completed-with-errors') {
    return lastRunMmDd ? `Fetched (E) ${lastRunMmDd}` : 'Due for Fetch';
  }
  if (fetchWeeklyState === 'failed') {
    return lastRunMmDd ? `Failed ${lastRunMmDd}` : 'Due for Fetch';
  }
  return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
}

function summarizeVDFScanStatus(status: DivergenceScanStatus): string {
  const scan = status.vdfScan;
  if (!scan) return 'Due for Fetch';
  const state = String(scan.status || '').toLowerCase();
  const lastRunDateKey = toDateKeyAsET(scan.finished_at || scan.started_at || null);
  const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
  if (state === 'stopping') {
    return 'Stopping';
  }
  if (state === 'stopped') {
    if (scan.can_resume) return 'Resumable Stop';
    return 'Stopped';
  }
  if (scan.running) {
    const processed = Number(scan.processed_tickers || 0);
    const total = Number(scan.total_tickers || 0);
    if (scan.stop_requested) {
      return 'Stopping';
    }
    if (state === 'running-retry') {
      return 'Retrying';
    }
    return `${processed} / ${total}`;
  }
  if (state === 'completed') {
    return lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Due for Fetch';
  }
  if (state === 'completed-with-errors') {
    return lastRunMmDd ? `Ran (E) ${lastRunMmDd}` : 'Due for Fetch';
  }
  if (state === 'failed') {
    return lastRunMmDd ? `Failed ${lastRunMmDd}` : 'Due for Fetch';
  }
  return lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Due for Fetch';
}

// ---------------------------------------------------------------------------
// Polling & auto-refresh
// ---------------------------------------------------------------------------

function clearDivergenceScanPolling(): void {
  if (divergenceScanPollTimer !== null) {
    window.clearInterval(divergenceScanPollTimer);
    divergenceScanPollTimer = null;
  }
}

async function hydrateVisibleDivergenceTables(force = false, noCache = false): Promise<void> {
  const nowMs = Date.now();
  if (!force && nowMs - divergenceTableLastUiRefreshAtMs < DIVERGENCE_TABLE_UI_REFRESH_MIN_MS) {
    return;
  }
  divergenceTableLastUiRefreshAtMs = nowMs;
  const containers: HTMLElement[] = [];
  const ids = ['daily-container', 'weekly-container', 'divergence-daily-container', 'divergence-weekly-container'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || el.childElementCount === 0) continue;
    containers.push(el);
  }
  if (containers.length > 0) {
    const shouldForceRefresh = noCache;
    await Promise.allSettled(
      containers.map((container) =>
        hydrateAlertCardDivergenceTables(container, undefined, { forceRefresh: shouldForceRefresh, noCache }),
      ),
    );
  }
  refreshActiveTickerDivergenceSummary({ noCache });
}

function refreshDivergenceCardsWhileRunning(force = false, timeframe?: '1d' | '1w'): void {
  if (!callbacks) return;
  // P2: Defer card refreshes while an active chart load (P0) is in progress.
  if (isChartActivelyLoading()) return;
  const nowMs = Date.now();
  if (!force && nowMs - divergenceTableLastUiRefreshAtMs < DIVERGENCE_TABLE_UI_REFRESH_MIN_MS) {
    return;
  }
  divergenceTableLastUiRefreshAtMs = nowMs;
  if (timeframe) {
    void callbacks.fetchDivergenceSignalsByTimeframe(timeframe)
      .then(() => callbacks!.renderDivergenceContainer(timeframe))
      .catch(() => {});
  } else {
    void callbacks.fetchDivergenceSignals()
      .then(callbacks.renderDivergenceOverview)
      .catch(() => {});
  }
}

async function pollDivergenceScanStatus(refreshOnComplete: boolean): Promise<void> {
  if (divergenceScanPollInFlight || !callbacks) return;
  divergenceScanPollInFlight = true;
  try {
    const status = await fetchDivergenceScanStatus();
    divergenceScanPollConsecutiveErrors = 0;
    divergenceTableRunningState = Boolean(status.tableBuild?.running);
    divergenceFetchDailyRunningState = Boolean(status.fetchDailyData?.running);
    divergenceFetchWeeklyRunningState = Boolean(status.fetchWeeklyData?.running);
    setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
    setRunStatusText(summarizeStatus(status));
    setRunControlButtonState(status);
    const tableRunning = divergenceTableRunningState;
    setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
    setTableRunStatusText(summarizeTableStatus(status));
    setTableControlButtonState(status);
    const fetchDailyRunning = divergenceFetchDailyRunningState;
    const fetchDailyCanResume = Boolean(status.fetchDailyData?.can_resume);
    setFetchDailyButtonState(fetchDailyRunning, fetchDailyCanResume);
    setFetchDailyStatusText(summarizeFetchDailyStatus(status));
    setFetchDailyControlButtonState(status);
    const fetchWeeklyRunning = divergenceFetchWeeklyRunningState;
    const fetchWeeklyCanResume = Boolean(status.fetchWeeklyData?.can_resume);
    setFetchWeeklyButtonState(fetchWeeklyRunning, fetchWeeklyCanResume);
    setFetchWeeklyStatusText(summarizeFetchWeeklyStatus(status));
    setFetchWeeklyControlButtonState(status);
    const vdfRunning1 = Boolean(status.vdfScan?.running);
    setVDFScanButtonState(vdfRunning1);
    setVDFScanStatusText(summarizeVDFScanStatus(status));
    setVDFScanControlButtonState(status);
    if (fetchDailyRunning) {
      allowAutoCardRefreshFromFetchDaily = true;
      allowAutoCardRefreshFromFetchWeekly = false;
    } else if (fetchWeeklyRunning) {
      allowAutoCardRefreshFromFetchWeekly = true;
      allowAutoCardRefreshFromFetchDaily = false;
    }
    if (fetchDailyRunning && allowAutoCardRefreshFromFetchDaily) {
      const processed = Number(status.fetchDailyData?.processed_tickers || 0);
      const progressed = processed !== divergenceFetchDailyLastProcessedTickers;
      divergenceFetchDailyLastProcessedTickers = processed;
      refreshDivergenceCardsWhileRunning(progressed, '1d');
    } else {
      divergenceFetchDailyLastProcessedTickers = -1;
    }
    if (fetchWeeklyRunning && allowAutoCardRefreshFromFetchWeekly) {
      const processed = Number(status.fetchWeeklyData?.processed_tickers || 0);
      const progressed = processed !== divergenceFetchWeeklyLastProcessedTickers;
      divergenceFetchWeeklyLastProcessedTickers = processed;
      refreshDivergenceCardsWhileRunning(progressed, '1w');
    } else {
      divergenceFetchWeeklyLastProcessedTickers = -1;
    }
    if (vdfRunning1 && allowAutoCardRefreshFromVDFScan) {
      const processed = Number(status.vdfScan?.processed_tickers || 0);
      const progressed = processed !== vdfScanLastProcessedTickers;
      vdfScanLastProcessedTickers = processed;
      if (progressed) {
        refreshDivergenceCardsWhileRunning(true);
      }
    } else {
      vdfScanLastProcessedTickers = -1;
    }
    if (!fetchDailyRunning && !fetchWeeklyRunning && !vdfRunning1) {
      divergenceTableLastUiRefreshAtMs = 0;
    }
    if (!status.running && !tableRunning && !fetchDailyRunning && !fetchWeeklyRunning && !vdfRunning1) {
      clearDivergenceScanPolling();
      if (refreshOnComplete) {
        if (allowAutoCardRefreshFromFetchDaily) {
          await callbacks.fetchDivergenceSignalsByTimeframe('1d');
          callbacks.renderDivergenceContainer('1d');
        }
        if (allowAutoCardRefreshFromFetchWeekly) {
          await callbacks.fetchDivergenceSignalsByTimeframe('1w');
          callbacks.renderDivergenceContainer('1w');
        }
        if (allowAutoCardRefreshFromVDFScan) {
          await callbacks.fetchDivergenceSignals();
          callbacks.renderDivergenceOverview();
        }
      }
      allowAutoCardRefreshFromFetchDaily = false;
      allowAutoCardRefreshFromFetchWeekly = false;
      allowAutoCardRefreshFromVDFScan = false;
    }
  } catch (error) {
    divergenceScanPollConsecutiveErrors += 1;
    if (divergenceScanPollConsecutiveErrors < DIVERGENCE_POLL_ERROR_THRESHOLD) {
      console.warn(
        `Scan status poll failed (${divergenceScanPollConsecutiveErrors}/${DIVERGENCE_POLL_ERROR_THRESHOLD}), retrying next cycle`,
      );
    } else {
      console.error('Failed to poll divergence scan status:', error);
      divergenceTableRunningState = false;
      divergenceFetchDailyRunningState = false;
      divergenceFetchWeeklyRunningState = false;
      setRunStatusText(toStatusTextFromError(error));
      setTableRunStatusText(toStatusTextFromError(error));
      setFetchDailyStatusText(toStatusTextFromError(error));
      setFetchWeeklyStatusText(toStatusTextFromError(error));
      clearDivergenceScanPolling();
      setRunButtonState(false, false);
      setRunControlButtonState(null);
      setTableRunButtonState(false, false);
      setTableControlButtonState(null);
      setFetchDailyButtonState(false, false);
      setFetchDailyControlButtonState(null);
      setFetchWeeklyButtonState(false, false);
      setFetchWeeklyControlButtonState(null);
      setVDFScanButtonState(false);
      setVDFScanControlButtonState(null);
      allowAutoCardRefreshFromFetchDaily = false;
      allowAutoCardRefreshFromFetchWeekly = false;
    }
  } finally {
    divergenceScanPollInFlight = false;
  }
}

function ensureDivergenceScanPolling(refreshOnComplete: boolean): void {
  clearDivergenceScanPolling();
  divergenceScanPollTimer = window.setInterval(() => {
    pollDivergenceScanStatus(refreshOnComplete);
  }, 2500);
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

export function shouldAutoRefreshDivergenceFeed(): boolean {
  return (
    (divergenceFetchDailyRunningState && allowAutoCardRefreshFromFetchDaily) ||
    (divergenceFetchWeeklyRunningState && allowAutoCardRefreshFromFetchWeekly)
  );
}

export async function syncDivergenceScanUiState(): Promise<void> {
  try {
    const status = await fetchDivergenceScanStatus();
    divergenceTableRunningState = Boolean(status.tableBuild?.running);
    divergenceFetchDailyRunningState = Boolean(status.fetchDailyData?.running);
    divergenceFetchWeeklyRunningState = Boolean(status.fetchWeeklyData?.running);
    setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
    setRunStatusText(summarizeStatus(status));
    setRunControlButtonState(status);
    const tableRunning = divergenceTableRunningState;
    setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
    setTableRunStatusText(summarizeTableStatus(status));
    setTableControlButtonState(status);
    const fetchDailyRunning = divergenceFetchDailyRunningState;
    const fetchDailyCanResume = Boolean(status.fetchDailyData?.can_resume);
    setFetchDailyButtonState(fetchDailyRunning, fetchDailyCanResume);
    setFetchDailyStatusText(summarizeFetchDailyStatus(status));
    setFetchDailyControlButtonState(status);
    const fetchWeeklyRunning = divergenceFetchWeeklyRunningState;
    const fetchWeeklyCanResume = Boolean(status.fetchWeeklyData?.can_resume);
    setFetchWeeklyButtonState(fetchWeeklyRunning, fetchWeeklyCanResume);
    setFetchWeeklyStatusText(summarizeFetchWeeklyStatus(status));
    setFetchWeeklyControlButtonState(status);
    const vdfRunning2 = Boolean(status.vdfScan?.running);
    setVDFScanButtonState(vdfRunning2);
    setVDFScanStatusText(summarizeVDFScanStatus(status));
    setVDFScanControlButtonState(status);
    if (fetchDailyRunning) {
      allowAutoCardRefreshFromFetchDaily = true;
      allowAutoCardRefreshFromFetchWeekly = false;
    } else if (fetchWeeklyRunning) {
      allowAutoCardRefreshFromFetchWeekly = true;
      allowAutoCardRefreshFromFetchDaily = false;
    }
    if (fetchDailyRunning && allowAutoCardRefreshFromFetchDaily) {
      const processed = Number(status.fetchDailyData?.processed_tickers || 0);
      const progressed = processed !== divergenceFetchDailyLastProcessedTickers;
      divergenceFetchDailyLastProcessedTickers = processed;
      refreshDivergenceCardsWhileRunning(progressed, '1d');
    } else {
      divergenceFetchDailyLastProcessedTickers = -1;
    }
    if (fetchWeeklyRunning && allowAutoCardRefreshFromFetchWeekly) {
      const processed = Number(status.fetchWeeklyData?.processed_tickers || 0);
      const progressed = processed !== divergenceFetchWeeklyLastProcessedTickers;
      divergenceFetchWeeklyLastProcessedTickers = processed;
      refreshDivergenceCardsWhileRunning(progressed, '1w');
    } else {
      divergenceFetchWeeklyLastProcessedTickers = -1;
    }
    if (!fetchDailyRunning && !fetchWeeklyRunning) {
      divergenceTableLastUiRefreshAtMs = 0;
    }
    if (status.running || tableRunning || fetchDailyRunning || fetchWeeklyRunning || vdfRunning2) {
      ensureDivergenceScanPolling(true);
    } else {
      clearDivergenceScanPolling();
      allowAutoCardRefreshFromFetchDaily = false;
      allowAutoCardRefreshFromFetchWeekly = false;
    }
  } catch (error) {
    console.error('Failed to sync divergence scan UI state:', error);
    divergenceTableRunningState = false;
    divergenceFetchDailyRunningState = false;
    divergenceFetchWeeklyRunningState = false;
    setRunButtonState(false, false);
    setRunControlButtonState(null);
    setRunStatusText(toStatusTextFromError(error));
    setTableRunButtonState(false, false);
    setTableRunStatusText(toStatusTextFromError(error));
    setTableControlButtonState(null);
    setFetchDailyButtonState(false, false);
    setFetchDailyStatusText(toStatusTextFromError(error));
    setFetchDailyControlButtonState(null);
    setFetchWeeklyButtonState(false, false);
    setFetchWeeklyStatusText(toStatusTextFromError(error));
    setFetchWeeklyControlButtonState(null);
    setVDFScanButtonState(false);
    setVDFScanControlButtonState(null);
    allowAutoCardRefreshFromFetchDaily = false;
    allowAutoCardRefreshFromFetchWeekly = false;
  }
}

export async function runManualDivergenceScan(): Promise<void> {
  setRunButtonState(true, false);
  setRunStatusText('Starting...');
  allowAutoCardRefreshFromFetchDaily = false;
  try {
    const started = await startDivergenceScan({
      force: true,
      refreshUniverse: true,
    });
    if (started.status === 'running') {
      setRunStatusText('Already running');
    } else {
      setRunStatusText('Running');
    }
    ensureDivergenceScanPolling(true);
    await pollDivergenceScanStatus(false);
  } catch (error) {
    console.error('Failed to start divergence scan:', error);
    setRunButtonState(false, false);
    setRunStatusText(toStatusTextFromError(error));
  }
}

export async function runManualDivergenceTableBuild(): Promise<void> {
  setTableRunButtonState(true, false);
  setTableRunStatusText('Table starting...');
  allowAutoCardRefreshFromFetchDaily = false;
  try {
    const started = await startDivergenceTableBuild();
    if (started.status === 'running') {
      setTableRunStatusText('Table running');
    } else {
      setTableRunStatusText('Table running');
    }
    ensureDivergenceScanPolling(true);
    await pollDivergenceScanStatus(false);
  } catch (error) {
    console.error('Failed to start divergence table build:', error);
    setTableRunButtonState(false, false);
    setTableRunStatusText(toStatusTextFromError(error));
  }
}

export async function runManualDivergenceFetchDailyData(): Promise<void> {
  setFetchDailyButtonState(true);
  setFetchDailyStatusText('Starting');
  allowAutoCardRefreshFromFetchDaily = true;
  allowAutoCardRefreshFromFetchWeekly = false;
  try {
    const started = await startDivergenceFetchDailyData();
    if (started.status === 'running') setFetchDailyStatusText('Already running');
    else if (started.status === 'resumed') setFetchDailyStatusText('Resuming');
    ensureDivergenceScanPolling(true);
    await pollDivergenceScanStatus(false);
  } catch (error) {
    console.error('Failed to start fetch-daily run:', error);
    setFetchDailyButtonState(false);
    setFetchDailyStatusText(toStatusTextFromError(error));
  }
}

export async function runManualDivergenceFetchWeeklyData(): Promise<void> {
  setFetchWeeklyButtonState(true);
  setFetchWeeklyStatusText('Starting');
  allowAutoCardRefreshFromFetchWeekly = true;
  allowAutoCardRefreshFromFetchDaily = false;
  try {
    const started = await startDivergenceFetchWeeklyData();
    if (started.status === 'running') setFetchWeeklyStatusText('Already running');
    else if (started.status === 'resumed') setFetchWeeklyStatusText('Resuming');
    ensureDivergenceScanPolling(true);
    await pollDivergenceScanStatus(false);
  } catch (error) {
    console.error('Failed to start fetch-weekly run:', error);
    setFetchWeeklyButtonState(false);
    setFetchWeeklyStatusText(toStatusTextFromError(error));
  }
}

export async function togglePauseResumeManualDivergenceScan(): Promise<void> {
  try {
    const status = await fetchDivergenceScanStatus();
    const running = Boolean(status.scanControl?.running || status.running);
    const canResume = Boolean(status.scanControl?.can_resume);
    if (running) {
      const result = await pauseDivergenceScan();
      if (result.status === 'pause-requested') {
        setRunStatusText('Pausing');
      } else if (result.status === 'paused') {
        setRunStatusText('Paused');
      }
    } else if (canResume) {
      const result = await resumeDivergenceScan();
      if (result.status === 'no-resume') {
        setRunStatusText('Nothing to resume');
      } else {
        setRunStatusText('Running');
        ensureDivergenceScanPolling(true);
        await pollDivergenceScanStatus(false);
        return;
      }
    }
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to toggle scan pause/resume:', error);
    setRunStatusText(toStatusTextFromError(error));
  }
}

export async function stopManualDivergenceScan(): Promise<void> {
  try {
    const result = await stopDivergenceScan();
    if (result.status === 'stop-requested') {
      setRunStatusText('Stopping');
    }
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to stop divergence scan:', error);
    setRunStatusText(toStatusTextFromError(error));
  }
}

export async function togglePauseResumeManualDivergenceTableBuild(): Promise<void> {
  try {
    const status = await fetchDivergenceScanStatus();
    const running = Boolean(status.tableBuild?.running);
    const canResume = Boolean(status.tableBuild?.can_resume);
    if (running) {
      const result = await pauseDivergenceTableBuild();
      if (result.status === 'pause-requested') {
        setTableRunStatusText('Pausing');
      } else if (result.status === 'paused') {
        setTableRunStatusText('Table paused');
      }
    } else if (canResume) {
      const result = await resumeDivergenceTableBuild();
      if (result.status === 'no-resume') {
        setTableRunStatusText('Nothing to resume');
      } else {
        setTableRunStatusText('Table running');
        ensureDivergenceScanPolling(true);
        await pollDivergenceScanStatus(false);
        return;
      }
    }
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to toggle divergence table pause/resume:', error);
    setTableRunStatusText(toStatusTextFromError(error));
  }
}

export async function stopManualDivergenceTableBuild(): Promise<void> {
  try {
    const result = await stopDivergenceTableBuild();
    if (result.status === 'stop-requested') {
      setTableRunStatusText('Stopping');
    }
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to stop divergence table build:', error);
    setTableRunStatusText(toStatusTextFromError(error));
  }
}

export async function stopManualDivergenceFetchDailyData(): Promise<void> {
  try {
    const result = await stopDivergenceFetchDailyData();
    if (result.status === 'stop-requested') {
      setFetchDailyStatusText('Stopping');
    }
    allowAutoCardRefreshFromFetchDaily = false;
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to stop fetch-daily run:', error);
    setFetchDailyStatusText(toStatusTextFromError(error));
  }
}

export async function stopManualDivergenceFetchWeeklyData(): Promise<void> {
  try {
    const result = await stopDivergenceFetchWeeklyData();
    if (result.status === 'stop-requested') {
      setFetchWeeklyStatusText('Stopping');
    }
    allowAutoCardRefreshFromFetchWeekly = false;
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to stop fetch-weekly run:', error);
    setFetchWeeklyStatusText(toStatusTextFromError(error));
  }
}

export async function runManualVDFScan(): Promise<void> {
  setVDFScanButtonState(true);
  setVDFScanStatusText('Starting');
  allowAutoCardRefreshFromVDFScan = true;
  allowAutoCardRefreshFromFetchDaily = false;
  allowAutoCardRefreshFromFetchWeekly = false;
  try {
    const started = await startVDFScan();
    if (started.status === 'running') setVDFScanStatusText('Already running');
    else if (started.status === 'resumed') setVDFScanStatusText('Resuming');
    ensureDivergenceScanPolling(true);
    await pollDivergenceScanStatus(false);
  } catch (error) {
    console.error('Failed to start VDF scan:', error);
    setVDFScanButtonState(false);
    setVDFScanStatusText(toStatusTextFromError(error));
  }
}

export async function stopManualVDFScan(): Promise<void> {
  try {
    const result = await stopVDFScan();
    if (result.status === 'stop-requested') {
      setVDFScanStatusText('Stopping');
    }
    allowAutoCardRefreshFromVDFScan = false;
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to stop VDF scan:', error);
    setVDFScanStatusText(toStatusTextFromError(error));
  }
}

export async function hydrateDivergenceTablesNow(): Promise<void> {
  try {
    setTableRunStatusText('Updating...');
    await hydrateVisibleDivergenceTables(true, true);
    await syncDivergenceScanUiState();
  } catch (error) {
    console.error('Failed to hydrate divergence tables:', error);
    setTableRunStatusText(toStatusTextFromError(error));
  }
}

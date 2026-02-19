/**
 * Scan control — lifecycle management for divergence scans, table builds,
 * daily/weekly fetches, VDF scans, and breadth bootstrap.  Includes polling
 * loop, button state management, and status text formatting.
 *
 * The 4 settings-panel "fetch" buttons (Fetch Daily, Fetch Weekly, Analyze,
 * Breadth) are managed by the shared FetchButton abstraction.  Legacy buttons
 * (Run Fetch, Run Table) still use bespoke helpers below.
 */

import {
  toStatusTextFromError,
  summarizeStatus,
  summarizeTableStatus,
  summarizeFetchDailyStatus,
  summarizeFetchWeeklyStatus,
  summarizeVDFScanStatus,
  summarizeBreadthStatus,
} from './divergenceScanStatusFormat';
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
import {
  registerFetchButton,
  getFetchButtons,
  getFetchButton,
  updateAllFetchButtons,
  resetAllFetchButtonsOnError,
  resetAllAutoRefresh,
  wireAllFetchButtons,
} from './fetchButton';
import { hydrateAlertCardDivergenceTables } from './divergenceTable';
import { refreshActiveTickerDivergenceSummary, isChartActivelyLoading } from './chart';
import type { Alert } from './types';
import { STOP_ICON_SVG } from './utils';

// ---------------------------------------------------------------------------
// Register the 4 settings-panel fetch buttons
// ---------------------------------------------------------------------------

registerFetchButton({
  key: 'fetchDaily',
  dom: {
    runButtonId: 'divergence-fetch-daily-btn',
    stopButtonId: 'divergence-fetch-daily-stop-btn',
    statusId: 'divergence-fetch-daily-status',
  },
  label: { idle: 'Fetch Daily', resume: 'Resume Fetch' },
  stopAriaLabel: 'Stop Fetch Daily',
  start: startDivergenceFetchDailyData,
  stop: stopDivergenceFetchDailyData,
  statusSource: {
    kind: 'unified',
    isRunning: (s) => Boolean(s.fetchDailyData?.running),
    isStopRequested: (s) => Boolean(s.fetchDailyData?.stop_requested),
    canResume: (s) => Boolean(s.fetchDailyData?.can_resume),
    formatStatus: summarizeFetchDailyStatus,
  },
  autoRefresh: {
    timeframe: '1d',
    getProcessedTickers: (s) => Number(s.fetchDailyData?.processed_tickers || 0),
  },
});

registerFetchButton({
  key: 'fetchWeekly',
  dom: {
    runButtonId: 'divergence-fetch-weekly-btn',
    stopButtonId: 'divergence-fetch-weekly-stop-btn',
    statusId: 'divergence-fetch-weekly-status',
  },
  label: { idle: 'Fetch Weekly', resume: 'Resume Fetch' },
  stopAriaLabel: 'Stop Fetch Weekly',
  start: startDivergenceFetchWeeklyData,
  stop: stopDivergenceFetchWeeklyData,
  statusSource: {
    kind: 'unified',
    isRunning: (s) => Boolean(s.fetchWeeklyData?.running),
    isStopRequested: (s) => Boolean(s.fetchWeeklyData?.stop_requested),
    canResume: (s) => Boolean(s.fetchWeeklyData?.can_resume),
    formatStatus: summarizeFetchWeeklyStatus,
  },
  autoRefresh: {
    timeframe: '1w',
    getProcessedTickers: (s) => Number(s.fetchWeeklyData?.processed_tickers || 0),
  },
});

registerFetchButton({
  key: 'vdfScan',
  dom: {
    runButtonId: 'divergence-vdf-scan-btn',
    stopButtonId: 'divergence-vdf-scan-stop-btn',
    statusId: 'divergence-vdf-scan-status',
  },
  label: { idle: 'Analyze' },
  stopAriaLabel: 'Stop VDF Scan',
  start: startVDFScan,
  stop: stopVDFScan,
  statusSource: {
    kind: 'unified',
    isRunning: (s) => Boolean(s.vdfScan?.running),
    isStopRequested: (s) => Boolean(s.vdfScan?.stop_requested),
    canResume: () => false,
    formatStatus: summarizeVDFScanStatus,
  },
  autoRefresh: {
    getProcessedTickers: (s) => Number(s.vdfScan?.processed_tickers || 0),
  },
});

registerFetchButton({
  key: 'breadth',
  dom: {
    runButtonId: 'breadth-recompute-btn',
    stopButtonId: 'breadth-recompute-stop-btn',
    statusId: 'breadth-recompute-status',
  },
  label: { idle: 'Breadth' },
  stopAriaLabel: 'Stop Breadth Bootstrap',
  start: async () => {
    const res = await fetch('/api/breadth/ma/recompute', { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
    return { status: String(body.status || 'started') };
  },
  stop: async () => {
    const res = await fetch('/api/breadth/ma/recompute/stop', { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: String(body.status || 'stop-requested') };
  },
  statusSource: {
    kind: 'standalone',
    statusUrl: '/api/breadth/ma/recompute/status',
    isRunning: (d) => Boolean(d.running),
    formatStatus: (d) =>
      summarizeBreadthStatus(d as { running: boolean; status: string; finished_at?: string | null }),
  },
});

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

const DIVERGENCE_POLL_ERROR_THRESHOLD = 3;
const DIVERGENCE_TABLE_UI_REFRESH_MIN_MS = 8000;

// ---------------------------------------------------------------------------
// Module-level state (legacy buttons + polling infrastructure)
// ---------------------------------------------------------------------------

let divergenceScanPollTimer: number | null = null;
let divergenceScanPollInFlight = false;
let divergenceScanPollConsecutiveErrors = 0;

let divergenceTableLastUiRefreshAtMs = 0;
let divergenceTableRunningState = false;

// ---------------------------------------------------------------------------
// Legacy DOM query helpers (Run Fetch / Run Table — not FetchButton-managed)
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

// ---------------------------------------------------------------------------
// Legacy button state setters
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
  if (isChartActivelyLoading()) return;
  const nowMs = Date.now();
  if (!force && nowMs - divergenceTableLastUiRefreshAtMs < DIVERGENCE_TABLE_UI_REFRESH_MIN_MS) {
    return;
  }
  divergenceTableLastUiRefreshAtMs = nowMs;
  if (timeframe) {
    void callbacks.fetchDivergenceSignalsByTimeframe(timeframe)
      .then(() => callbacks!.renderDivergenceContainer(timeframe))
      .catch((err: unknown) => { console.warn(`[scan] Card refresh failed (${timeframe}):`, err); });
  } else {
    void callbacks.fetchDivergenceSignals()
      .then(callbacks.renderDivergenceOverview)
      .catch((err: unknown) => { console.warn('[scan] Overview refresh failed:', err); });
  }
}

async function pollDivergenceScanStatus(refreshOnComplete: boolean): Promise<void> {
  if (divergenceScanPollInFlight || !callbacks) return;
  divergenceScanPollInFlight = true;
  try {
    const status = await fetchDivergenceScanStatus();
    divergenceScanPollConsecutiveErrors = 0;

    // --- Legacy buttons (Run Fetch, Run Table) ---
    divergenceTableRunningState = Boolean(status.tableBuild?.running);
    setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
    setRunStatusText(summarizeStatus(status));
    setRunControlButtonState(status);
    const tableRunning = divergenceTableRunningState;
    setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
    setTableRunStatusText(summarizeTableStatus(status));
    setTableControlButtonState(status);

    // --- FetchButton registry: update all 4 buttons ---
    const anyFetchRunning = await updateAllFetchButtons(status);

    // --- Auto-refresh: iterate registered buttons ---
    const buttons = getFetchButtons();
    for (const btn of buttons) {
      const refresh = btn.checkAutoRefresh(status);
      if (refresh) {
        if (refresh.timeframe) {
          refreshDivergenceCardsWhileRunning(refresh.progressed, refresh.timeframe);
        } else if (refresh.progressed) {
          refreshDivergenceCardsWhileRunning(true);
        }
      }
    }

    if (!anyFetchRunning) {
      divergenceTableLastUiRefreshAtMs = 0;
    }

    // Stop polling when everything is idle
    if (!status.running && !tableRunning && !anyFetchRunning) {
      clearDivergenceScanPolling();
      if (refreshOnComplete) {
        for (const btn of buttons) {
          if (!btn.allowAutoRefresh) continue;
          const ar = btn.config.autoRefresh;
          if (ar?.timeframe) {
            await callbacks.fetchDivergenceSignalsByTimeframe(ar.timeframe);
            callbacks.renderDivergenceContainer(ar.timeframe);
          } else if (ar) {
            await callbacks.fetchDivergenceSignals();
            callbacks.renderDivergenceOverview();
          }
        }
      }
      resetAllAutoRefresh();
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
      const errorText = toStatusTextFromError(error);
      setRunStatusText(errorText);
      setTableRunStatusText(errorText);
      clearDivergenceScanPolling();
      setRunButtonState(false, false);
      setRunControlButtonState(null);
      setTableRunButtonState(false, false);
      setTableControlButtonState(null);
      resetAllFetchButtonsOnError();
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
  const daily = getFetchButton('fetchDaily');
  const weekly = getFetchButton('fetchWeekly');
  return (
    Boolean(daily?.running && daily?.allowAutoRefresh) ||
    Boolean(weekly?.running && weekly?.allowAutoRefresh)
  );
}

/** Wire click handlers for all registered FetchButtons. Call once after DOM is ready. */
export function initFetchButtons(): void {
  wireAllFetchButtons(
    () => ensureDivergenceScanPolling(true),
    () => pollDivergenceScanStatus(false),
  );
}

export async function syncDivergenceScanUiState(): Promise<void> {
  try {
    const status = await fetchDivergenceScanStatus();

    // --- Legacy buttons ---
    divergenceTableRunningState = Boolean(status.tableBuild?.running);
    setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
    setRunStatusText(summarizeStatus(status));
    setRunControlButtonState(status);
    const tableRunning = divergenceTableRunningState;
    setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
    setTableRunStatusText(summarizeTableStatus(status));
    setTableControlButtonState(status);

    // --- FetchButton registry ---
    const anyFetchRunning = await updateAllFetchButtons(status);

    // --- Auto-refresh for running buttons ---
    const buttons = getFetchButtons();
    for (const btn of buttons) {
      const refresh = btn.checkAutoRefresh(status);
      if (refresh) {
        if (refresh.timeframe) {
          refreshDivergenceCardsWhileRunning(refresh.progressed, refresh.timeframe);
        } else if (refresh.progressed) {
          refreshDivergenceCardsWhileRunning(true);
        }
      }
    }

    if (!anyFetchRunning) {
      divergenceTableLastUiRefreshAtMs = 0;
    }

    if (status.running || tableRunning || anyFetchRunning) {
      ensureDivergenceScanPolling(true);
    } else {
      clearDivergenceScanPolling();
      resetAllAutoRefresh();
    }
  } catch (error) {
    console.error('Failed to sync divergence scan UI state:', error);
    divergenceTableRunningState = false;
    const errorText = toStatusTextFromError(error);
    setRunButtonState(false, false);
    setRunControlButtonState(null);
    setRunStatusText(errorText);
    setTableRunButtonState(false, false);
    setTableRunStatusText(errorText);
    setTableControlButtonState(null);
    resetAllFetchButtonsOnError();
  }
}

// ---------------------------------------------------------------------------
// Legacy scan/table handlers (Run Fetch, Run Table — not FetchButton-managed)
// ---------------------------------------------------------------------------

export async function runManualDivergenceScan(): Promise<void> {
  setRunButtonState(true, false);
  setRunStatusText('Starting...');
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

import { getCurrentWeekISO, getCurrentMonthISO, getDateRangeForMode, createAlertSortFn, updateSortButtonUi } from './utils';
import {
    fetchDivergenceSignalsFromApi,
    toggleDivergenceFavorite,
    startDivergenceScan,
    pauseDivergenceScan,
    resumeDivergenceScan,
    stopDivergenceScan,
    startDivergenceTableBuild,
    pauseDivergenceTableBuild,
    resumeDivergenceTableBuild,
    stopDivergenceTableBuild,
    startDivergenceFetchAllData,
    stopDivergenceFetchAllData,
    startDivergenceFetchWeeklyData,
    stopDivergenceFetchWeeklyData,
    fetchDivergenceScanStatus,
    DivergenceScanStatus
} from './divergenceApi';
import { setDivergenceSignals, setDivergenceSignalsByTimeframe, getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { hydrateAlertCardDivergenceTables, primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { refreshActiveTickerDivergenceSummary } from './chart';
import { LiveFeedMode, SortMode, Alert } from './types';

let divergenceFeedMode: LiveFeedMode = 'today';
let dailySortMode: SortMode = 'combo';
let weeklySortMode: SortMode = 'combo';
let dailySortDirection: 'asc' | 'desc' = 'desc';
let weeklySortDirection: 'asc' | 'desc' = 'desc';
let divergenceScanPollTimer: number | null = null;
let divergenceScanPollInFlight = false;
let divergenceScanPollConsecutiveErrors = 0;
const DIVERGENCE_POLL_ERROR_THRESHOLD = 3;
let divergenceFetchAllLastProcessedTickers = -1;
let divergenceFetchWeeklyLastProcessedTickers = -1;
let divergenceTableLastUiRefreshAtMs = 0;
const DIVERGENCE_TABLE_UI_REFRESH_MIN_MS = 8000;
let divergenceTableRunningState = false;
let divergenceFetchAllRunningState = false;
let divergenceFetchWeeklyRunningState = false;
let allowAutoCardRefreshFromFetchAll = false;
let allowAutoCardRefreshFromFetchWeekly = false;

export function getDivergenceFeedMode(): LiveFeedMode {
    return divergenceFeedMode;
}

export function setDivergenceFeedModeState(mode: LiveFeedMode): void {
    divergenceFeedMode = mode;
}

export function shouldAutoRefreshDivergenceFeed(): boolean {
    return (divergenceFetchAllRunningState && allowAutoCardRefreshFromFetchAll)
        || (divergenceFetchWeeklyRunningState && allowAutoCardRefreshFromFetchWeekly);
}

function getRunButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
    return {
        button: document.getElementById('divergence-run-btn') as HTMLButtonElement | null,
        status: document.getElementById('divergence-run-status')
    };
}

function getTableRunButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
    return {
        button: document.getElementById('divergence-run-table-btn') as HTMLButtonElement | null,
        status: document.getElementById('divergence-table-run-status')
    };
}

function getFetchAllButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
    return {
        button: document.getElementById('divergence-fetch-all-btn') as HTMLButtonElement | null,
        status: document.getElementById('divergence-fetch-all-status')
    };
}

function getFetchWeeklyButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
    return {
        button: document.getElementById('divergence-fetch-weekly-btn') as HTMLButtonElement | null,
        status: document.getElementById('divergence-fetch-weekly-status')
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

function getFetchAllControlButtons(): {
    stopButton: HTMLButtonElement | null;
} {
    return {
        stopButton: document.getElementById('divergence-fetch-all-stop-btn') as HTMLButtonElement | null,
    };
}

function getFetchWeeklyControlButtons(): {
    stopButton: HTMLButtonElement | null;
} {
    return {
        stopButton: document.getElementById('divergence-fetch-weekly-stop-btn') as HTMLButtonElement | null,
    };
}

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

function setFetchAllButtonState(running: boolean, canResume = false): void {
    const { button } = getFetchAllButtonElements();
    if (!button) return;
    button.disabled = running;
    button.classList.toggle('active', running);
    if (canResume && !running) {
        button.textContent = 'Resume Fetch';
    } else {
        button.textContent = 'Fetch Daily';
    }
}

function setFetchAllStatusText(text: string): void {
    const { status } = getFetchAllButtonElements();
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
        stopButton.textContent = '⏹';
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
        stopButton.textContent = '⏹';
        stopButton.disabled = !running || stopRequested;
        stopButton.classList.toggle('active', running);
        stopButton.setAttribute('aria-label', 'Stop Run Table');
        stopButton.title = 'Stop Run Table';
    }
    if (manualUpdateButton) {
        manualUpdateButton.disabled = false;
    }
}

function setFetchAllControlButtonState(status: DivergenceScanStatus | null): void {
    const { stopButton } = getFetchAllControlButtons();
    const fetchAll = status?.fetchAllData || null;
    const running = Boolean(fetchAll?.running);
    const stopRequested = Boolean(fetchAll?.stop_requested);
    if (stopButton) {
        stopButton.textContent = '⏹';
        stopButton.disabled = !running || stopRequested;
        stopButton.classList.toggle('active', running);
        stopButton.setAttribute('aria-label', 'Stop Fetch Daily');
        stopButton.title = 'Stop Fetch Daily';
    }
}

function setFetchWeeklyControlButtonState(status: DivergenceScanStatus | null): void {
    const { stopButton } = getFetchWeeklyControlButtons();
    const fetchWeekly = status?.fetchWeeklyData || null;
    const running = Boolean(fetchWeekly?.running);
    const stopRequested = Boolean(fetchWeekly?.stop_requested);
    if (stopButton) {
        stopButton.textContent = '⏹';
        stopButton.disabled = !running || stopRequested;
        stopButton.classList.toggle('active', running);
        stopButton.setAttribute('aria-label', 'Stop Fetch Weekly');
        stopButton.title = 'Stop Fetch Weekly';
    }
}

function toStatusTextFromError(error: unknown): string {
    const message = String((error as any)?.message || error || '').trim();
    if (!message) return 'Run failed';
    if (/not configured/i.test(message)) return 'DB not configured';
    if (/unauthorized/i.test(message)) return 'Unauthorized';
    if (/already running|running/i.test(message)) return 'Already running';
    return message.length > 56 ? `${message.slice(0, 56)}...` : message;
}

function toDateKey(raw?: string | null): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
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
    const latest = status.latestJob as (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string }) | null;
    const runDateKey =
        toDateKey(status.lastScanDateEt)
        || toDateKey(latest?.scanned_trade_date)
        || toDateKey(latest?.run_for_date)
        || toDateKey(latest?.finished_at)
        || toDateKey(latest?.started_at);

    if (!runDateKey) return 'Fetched';
    const mmdd = dateKeyToMmDd(runDateKey);
    return mmdd ? `Fetched ${mmdd}` : 'Fetched';
}

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

function summarizeFetchAllStatus(status: DivergenceScanStatus): string {
    const fetchAll = status.fetchAllData;
    const latest = status.latestJob as (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string }) | null;
    const lastRunDateKey =
        toDateKey(fetchAll?.last_published_trade_date || null)
        || toDateKey(status.lastScanDateEt)
        || toDateKey(latest?.scanned_trade_date)
        || toDateKey(latest?.run_for_date)
        || toDateKey(latest?.finished_at)
        || toDateKey(latest?.started_at);
    const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
    const ranText = lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Ran --';
    if (!fetchAll) return ranText;
    const fetchAllState = String(fetchAll.status || '').toLowerCase();
    if (fetchAllState === 'stopping') {
        return 'Stopping';
    }
    if (fetchAllState === 'stopped') {
        if (fetchAll.can_resume) {
            const processed = Number(fetchAll.processed_tickers || 0);
            const total = Number(fetchAll.total_tickers || 0);
            return total > 0 ? `Stopped ${processed}/${total} (resumable)` : 'Stopped (resumable)';
        }
        return 'Stopped';
    }
    if (fetchAll.running) {
        const processed = Number(fetchAll.processed_tickers || 0);
        const total = Number(fetchAll.total_tickers || 0);
        const errors = Number(fetchAll.error_tickers || 0);
        if (fetchAll.stop_requested) {
            return 'Stopping';
        }
        if (fetchAllState === 'running-retry') {
            return `Retrying ${errors} failed (${processed}/${total})`;
        }
        if (fetchAllState === 'running-ma') {
            return `MA ${processed}/${total}`;
        }
        if (fetchAllState === 'running-ma-retry') {
            return `Retrying failed MA (${processed}/${total})`;
        }
        return `${processed} / ${total}`;
    }
    if (fetchAllState === 'completed') {
        return ranText;
    }
    if (fetchAllState === 'completed-with-errors') {
        return ranText;
    }
    if (fetchAllState === 'failed') {
        return ranText;
    }
    return ranText;
}

function summarizeFetchWeeklyStatus(status: DivergenceScanStatus): string {
    const fetchWeekly = status.fetchWeeklyData;
    const latest = status.latestJob as (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string }) | null;
    const lastRunDateKey =
        toDateKey(fetchWeekly?.last_published_trade_date || null)
        || toDateKey(status.lastScanDateEt)
        || toDateKey(latest?.scanned_trade_date)
        || toDateKey(latest?.run_for_date)
        || toDateKey(latest?.finished_at)
        || toDateKey(latest?.started_at);
    const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
    const ranText = lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Ran --';
    if (!fetchWeekly) return ranText;
    const fetchWeeklyState = String(fetchWeekly.status || '').toLowerCase();
    if (fetchWeeklyState === 'stopping') {
        return 'Stopping';
    }
    if (fetchWeeklyState === 'stopped') {
        if (fetchWeekly.can_resume) {
            const processed = Number(fetchWeekly.processed_tickers || 0);
            const total = Number(fetchWeekly.total_tickers || 0);
            return total > 0 ? `Stopped ${processed}/${total} (resumable)` : 'Stopped (resumable)';
        }
        return 'Stopped';
    }
    if (fetchWeekly.running) {
        const processed = Number(fetchWeekly.processed_tickers || 0);
        const total = Number(fetchWeekly.total_tickers || 0);
        const errors = Number(fetchWeekly.error_tickers || 0);
        if (fetchWeekly.stop_requested) {
            return 'Stopping';
        }
        if (fetchWeeklyState === 'running-retry') {
            return `Retrying ${errors} failed (${processed}/${total})`;
        }
        if (fetchWeeklyState === 'running-ma') {
            return `MA ${processed}/${total}`;
        }
        if (fetchWeeklyState === 'running-ma-retry') {
            return `Retrying failed MA (${processed}/${total})`;
        }
        return `${processed} / ${total}`;
    }
    if (fetchWeeklyState === 'completed') {
        return ranText;
    }
    if (fetchWeeklyState === 'completed-with-errors') {
        return ranText;
    }
    if (fetchWeeklyState === 'failed') {
        return ranText;
    }
    return ranText;
}

function clearDivergenceScanPolling(): void {
  if (divergenceScanPollTimer !== null) {
    window.clearInterval(divergenceScanPollTimer);
    divergenceScanPollTimer = null;
  }
}

async function hydrateVisibleDivergenceTables(force = false, noCache = false): Promise<void> {
    const nowMs = Date.now();
    if (!force && (nowMs - divergenceTableLastUiRefreshAtMs) < DIVERGENCE_TABLE_UI_REFRESH_MIN_MS) {
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
            containers.map((container) => hydrateAlertCardDivergenceTables(
                container,
                undefined,
                { forceRefresh: shouldForceRefresh, noCache }
            ))
        );
    }
    refreshActiveTickerDivergenceSummary({ noCache });
}

function refreshDivergenceCardsWhileRunning(force = false, timeframe?: '1d' | '1w'): void {
    const nowMs = Date.now();
    if (!force && (nowMs - divergenceTableLastUiRefreshAtMs) < DIVERGENCE_TABLE_UI_REFRESH_MIN_MS) {
        return;
    }
    divergenceTableLastUiRefreshAtMs = nowMs;
    if (timeframe) {
        void fetchDivergenceSignalsByTimeframe(timeframe).then(() => renderDivergenceContainer(timeframe)).catch(() => {});
    } else {
        void fetchDivergenceSignals().then(renderDivergenceOverview).catch(() => {});
    }
}

async function pollDivergenceScanStatus(refreshOnComplete: boolean): Promise<void> {
    if (divergenceScanPollInFlight) return;
    divergenceScanPollInFlight = true;
    try {
        const status = await fetchDivergenceScanStatus();
        divergenceScanPollConsecutiveErrors = 0;
        divergenceTableRunningState = Boolean(status.tableBuild?.running);
        divergenceFetchAllRunningState = Boolean(status.fetchAllData?.running);
        divergenceFetchWeeklyRunningState = Boolean(status.fetchWeeklyData?.running);
        setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
        setRunStatusText(summarizeStatus(status));
        setRunControlButtonState(status);
        const tableRunning = divergenceTableRunningState;
        setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
        setTableRunStatusText(summarizeTableStatus(status));
        setTableControlButtonState(status);
        const fetchAllRunning = divergenceFetchAllRunningState;
        const fetchAllCanResume = Boolean(status.fetchAllData?.can_resume);
        setFetchAllButtonState(fetchAllRunning, fetchAllCanResume);
        setFetchAllStatusText(summarizeFetchAllStatus(status));
        setFetchAllControlButtonState(status);
        const fetchWeeklyRunning = divergenceFetchWeeklyRunningState;
        const fetchWeeklyCanResume = Boolean(status.fetchWeeklyData?.can_resume);
        setFetchWeeklyButtonState(fetchWeeklyRunning, fetchWeeklyCanResume);
        setFetchWeeklyStatusText(summarizeFetchWeeklyStatus(status));
        setFetchWeeklyControlButtonState(status);
        if (fetchAllRunning) {
            allowAutoCardRefreshFromFetchAll = true;
            allowAutoCardRefreshFromFetchWeekly = false;
        } else if (fetchWeeklyRunning) {
            allowAutoCardRefreshFromFetchWeekly = true;
            allowAutoCardRefreshFromFetchAll = false;
        }
        if (fetchAllRunning && allowAutoCardRefreshFromFetchAll) {
            const processed = Number(status.fetchAllData?.processed_tickers || 0);
            const progressed = processed !== divergenceFetchAllLastProcessedTickers;
            divergenceFetchAllLastProcessedTickers = processed;
            refreshDivergenceCardsWhileRunning(progressed, '1d');
        } else {
            divergenceFetchAllLastProcessedTickers = -1;
        }
        if (fetchWeeklyRunning && allowAutoCardRefreshFromFetchWeekly) {
            const processed = Number(status.fetchWeeklyData?.processed_tickers || 0);
            const progressed = processed !== divergenceFetchWeeklyLastProcessedTickers;
            divergenceFetchWeeklyLastProcessedTickers = processed;
            refreshDivergenceCardsWhileRunning(progressed, '1w');
        } else {
            divergenceFetchWeeklyLastProcessedTickers = -1;
        }
        if (!fetchAllRunning && !fetchWeeklyRunning) {
            divergenceTableLastUiRefreshAtMs = 0;
        }
        if (!status.running && !tableRunning && !fetchAllRunning && !fetchWeeklyRunning) {
            clearDivergenceScanPolling();
            if (refreshOnComplete) {
                if (allowAutoCardRefreshFromFetchAll) {
                    await fetchDivergenceSignalsByTimeframe('1d');
                    renderDivergenceContainer('1d');
                }
                if (allowAutoCardRefreshFromFetchWeekly) {
                    await fetchDivergenceSignalsByTimeframe('1w');
                    renderDivergenceContainer('1w');
                }
            }
            allowAutoCardRefreshFromFetchAll = false;
            allowAutoCardRefreshFromFetchWeekly = false;
        }
    } catch (error) {
        divergenceScanPollConsecutiveErrors += 1;
        // Transient errors during active fetches are expected (DB pool
        // saturated). Keep polling and only show errors after repeated
        // consecutive failures.
        if (divergenceScanPollConsecutiveErrors < DIVERGENCE_POLL_ERROR_THRESHOLD) {
            console.warn(`Scan status poll failed (${divergenceScanPollConsecutiveErrors}/${DIVERGENCE_POLL_ERROR_THRESHOLD}), retrying next cycle`);
        } else {
            console.error('Failed to poll divergence scan status:', error);
            divergenceTableRunningState = false;
            divergenceFetchAllRunningState = false;
            divergenceFetchWeeklyRunningState = false;
            setRunStatusText(toStatusTextFromError(error));
            setTableRunStatusText(toStatusTextFromError(error));
            setFetchAllStatusText(toStatusTextFromError(error));
            setFetchWeeklyStatusText(toStatusTextFromError(error));
            clearDivergenceScanPolling();
            setRunButtonState(false, false);
            setRunControlButtonState(null);
            setTableRunButtonState(false, false);
            setTableControlButtonState(null);
            setFetchAllButtonState(false, false);
            setFetchAllControlButtonState(null);
            setFetchWeeklyButtonState(false, false);
            setFetchWeeklyControlButtonState(null);
            allowAutoCardRefreshFromFetchAll = false;
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

export async function syncDivergenceScanUiState(): Promise<void> {
    try {
        const status = await fetchDivergenceScanStatus();
        divergenceTableRunningState = Boolean(status.tableBuild?.running);
        divergenceFetchAllRunningState = Boolean(status.fetchAllData?.running);
        divergenceFetchWeeklyRunningState = Boolean(status.fetchWeeklyData?.running);
        setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
        setRunStatusText(summarizeStatus(status));
        setRunControlButtonState(status);
        const tableRunning = divergenceTableRunningState;
        setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
        setTableRunStatusText(summarizeTableStatus(status));
        setTableControlButtonState(status);
        const fetchAllRunning = divergenceFetchAllRunningState;
        const fetchAllCanResume = Boolean(status.fetchAllData?.can_resume);
        setFetchAllButtonState(fetchAllRunning, fetchAllCanResume);
        setFetchAllStatusText(summarizeFetchAllStatus(status));
        setFetchAllControlButtonState(status);
        const fetchWeeklyRunning = divergenceFetchWeeklyRunningState;
        const fetchWeeklyCanResume = Boolean(status.fetchWeeklyData?.can_resume);
        setFetchWeeklyButtonState(fetchWeeklyRunning, fetchWeeklyCanResume);
        setFetchWeeklyStatusText(summarizeFetchWeeklyStatus(status));
        setFetchWeeklyControlButtonState(status);
        if (fetchAllRunning) {
            allowAutoCardRefreshFromFetchAll = true;
            allowAutoCardRefreshFromFetchWeekly = false;
        } else if (fetchWeeklyRunning) {
            allowAutoCardRefreshFromFetchWeekly = true;
            allowAutoCardRefreshFromFetchAll = false;
        }
        if (fetchAllRunning && allowAutoCardRefreshFromFetchAll) {
            const processed = Number(status.fetchAllData?.processed_tickers || 0);
            const progressed = processed !== divergenceFetchAllLastProcessedTickers;
            divergenceFetchAllLastProcessedTickers = processed;
            refreshDivergenceCardsWhileRunning(progressed, '1d');
        } else {
            divergenceFetchAllLastProcessedTickers = -1;
        }
        if (fetchWeeklyRunning && allowAutoCardRefreshFromFetchWeekly) {
            const processed = Number(status.fetchWeeklyData?.processed_tickers || 0);
            const progressed = processed !== divergenceFetchWeeklyLastProcessedTickers;
            divergenceFetchWeeklyLastProcessedTickers = processed;
            refreshDivergenceCardsWhileRunning(progressed, '1w');
        } else {
            divergenceFetchWeeklyLastProcessedTickers = -1;
        }
        if (!fetchAllRunning && !fetchWeeklyRunning) {
            divergenceTableLastUiRefreshAtMs = 0;
        }
        if (status.running || tableRunning || fetchAllRunning || fetchWeeklyRunning) {
            ensureDivergenceScanPolling(true);
        } else {
            clearDivergenceScanPolling();
            allowAutoCardRefreshFromFetchAll = false;
            allowAutoCardRefreshFromFetchWeekly = false;
        }
    } catch (error) {
        console.error('Failed to sync divergence scan UI state:', error);
        divergenceTableRunningState = false;
        divergenceFetchAllRunningState = false;
        divergenceFetchWeeklyRunningState = false;
        setRunButtonState(false, false);
        setRunControlButtonState(null);
        setRunStatusText(toStatusTextFromError(error));
        setTableRunButtonState(false, false);
        setTableRunStatusText(toStatusTextFromError(error));
        setTableControlButtonState(null);
        setFetchAllButtonState(false, false);
        setFetchAllStatusText(toStatusTextFromError(error));
        setFetchAllControlButtonState(null);
        setFetchWeeklyButtonState(false, false);
        setFetchWeeklyStatusText(toStatusTextFromError(error));
        setFetchWeeklyControlButtonState(null);
        allowAutoCardRefreshFromFetchAll = false;
        allowAutoCardRefreshFromFetchWeekly = false;
    }
}

export async function runManualDivergenceScan(): Promise<void> {
    setRunButtonState(true, false);
    setRunStatusText('Starting...');
    allowAutoCardRefreshFromFetchAll = false;
    try {
        const started = await startDivergenceScan({
            force: true,
            refreshUniverse: true
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
    allowAutoCardRefreshFromFetchAll = false;
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

export async function runManualDivergenceFetchAllData(): Promise<void> {
    setFetchAllButtonState(true);
    setFetchAllStatusText('Starting...');
    allowAutoCardRefreshFromFetchAll = true;
    allowAutoCardRefreshFromFetchWeekly = false;
    try {
        const started = await startDivergenceFetchAllData();
        if (started.status === 'running') setFetchAllStatusText('Already running');
        else if (started.status === 'resumed') setFetchAllStatusText('Resuming...');
        ensureDivergenceScanPolling(true);
        await pollDivergenceScanStatus(false);
    } catch (error) {
        console.error('Failed to start fetch-all run:', error);
        setFetchAllButtonState(false);
        setFetchAllStatusText(toStatusTextFromError(error));
    }
}

export async function runManualDivergenceFetchWeeklyData(): Promise<void> {
    setFetchWeeklyButtonState(true);
    setFetchWeeklyStatusText('Starting...');
    allowAutoCardRefreshFromFetchWeekly = true;
    allowAutoCardRefreshFromFetchAll = false;
    try {
        const started = await startDivergenceFetchWeeklyData();
        if (started.status === 'running') setFetchWeeklyStatusText('Already running');
        else if (started.status === 'resumed') setFetchWeeklyStatusText('Resuming...');
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

export async function stopManualDivergenceFetchAllData(): Promise<void> {
    try {
        const result = await stopDivergenceFetchAllData();
        if (result.status === 'stop-requested') {
            setFetchAllStatusText('Stopping');
        }
        allowAutoCardRefreshFromFetchAll = false;
        await syncDivergenceScanUiState();
    } catch (error) {
        console.error('Failed to stop fetch-all run:', error);
        setFetchAllStatusText(toStatusTextFromError(error));
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

export function isCurrentDivergenceTimeframe(): boolean {
    if (divergenceFeedMode === 'today' || divergenceFeedMode === '30' || divergenceFeedMode === '7') return true;
    if (divergenceFeedMode === 'yesterday') return false;
    if (divergenceFeedMode === 'week') {
        const val = (document.getElementById('divergence-history-week') as HTMLInputElement | null)?.value || '';
        return val === getCurrentWeekISO();
    }
    const val = (document.getElementById('divergence-history-month') as HTMLInputElement | null)?.value || '';
    return val === getCurrentMonthISO();
}

export async function fetchDivergenceSignals(_force?: boolean): Promise<Alert[]> {
    try {
        const weekVal = (document.getElementById('divergence-history-week') as HTMLInputElement | null)?.value || '';
        const monthVal = (document.getElementById('divergence-history-month') as HTMLInputElement | null)?.value || '';

        const { startDate, endDate } = getDateRangeForMode(divergenceFeedMode, weekVal, monthVal);
        if (!startDate || !endDate) return [];

        const params = `?start_date=${startDate}&end_date=${endDate}`;
        const data = await fetchDivergenceSignalsFromApi(params);
        primeDivergenceSummaryCacheFromAlerts(data);
        setDivergenceSignals(data);
        return data;
    } catch (error) {
        console.error('Error fetching divergence signals:', error);
        return [];
    }
}

export function renderDivergenceOverview(): void {
    const allSignals = getDivergenceSignals();
    primeDivergenceSummaryCacheFromAlerts(allSignals);
    const dailyContainer = document.getElementById('divergence-daily-container');
    const weeklyContainer = document.getElementById('divergence-weekly-container');
    if (!dailyContainer || !weeklyContainer) return;

    const daily = allSignals.filter((a) => (a.timeframe || '').trim() === '1d');
    const weekly = allSignals.filter((a) => (a.timeframe || '').trim() === '1w');

    daily.sort(createAlertSortFn(dailySortMode, dailySortDirection));
    weekly.sort(createAlertSortFn(weeklySortMode, weeklySortDirection));

    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    renderAlertCardDivergenceTablesFromCache(dailyContainer);
    renderAlertCardDivergenceTablesFromCache(weeklyContainer);
}

/**
 * Fetch signals for a single timeframe and update only that timeframe's state.
 * The other timeframe's signals are left completely untouched.
 */
export async function fetchDivergenceSignalsByTimeframe(timeframe: '1d' | '1w'): Promise<Alert[]> {
    try {
        const weekVal = (document.getElementById('divergence-history-week') as HTMLInputElement | null)?.value || '';
        const monthVal = (document.getElementById('divergence-history-month') as HTMLInputElement | null)?.value || '';

        const { startDate, endDate } = getDateRangeForMode(divergenceFeedMode, weekVal, monthVal);
        if (!startDate || !endDate) return [];

        const params = `?start_date=${startDate}&end_date=${endDate}&timeframe=${timeframe}`;
        const data = await fetchDivergenceSignalsFromApi(params);
        primeDivergenceSummaryCacheFromAlerts(data);
        setDivergenceSignalsByTimeframe(timeframe, data);
        return data;
    } catch (error) {
        console.error(`Error fetching divergence signals for ${timeframe}:`, error);
        return [];
    }
}

/**
 * Re-render only a single timeframe container, leaving the other untouched.
 */
export function renderDivergenceContainer(timeframe: '1d' | '1w'): void {
    const allSignals = getDivergenceSignals();
    const containerId = timeframe === '1d' ? 'divergence-daily-container' : 'divergence-weekly-container';
    const container = document.getElementById(containerId);
    if (!container) return;

    const sortMode = timeframe === '1d' ? dailySortMode : weeklySortMode;
    const sortDirection = timeframe === '1d' ? dailySortDirection : weeklySortDirection;
    const signals = allSignals.filter((a) => (a.timeframe || '').trim() === timeframe);
    signals.sort(createAlertSortFn(sortMode, sortDirection));

    container.innerHTML = signals.map(createAlertCard).join('');
    renderAlertCardDivergenceTablesFromCache(container);
}

export function setupDivergenceFeedDelegation(): void {
    const view = document.getElementById('view-divergence');
    if (!view) return;

    view.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const starBtn = target.closest('.fav-icon');
        if (starBtn) {
            e.stopPropagation();
            const id = (starBtn as HTMLElement).dataset.id;
            const source = (starBtn as HTMLElement).dataset.source === 'TV' ? 'TV' : 'DataAPI';
            if (!id) return;

            const allStars = document.querySelectorAll(`.fav-icon[data-id="${id}"][data-source="${source}"]`);
            const isCurrentlyFilled = starBtn.classList.contains('filled');

            allStars.forEach(star => {
                const checkmark = star.querySelector('.check-mark') as HTMLElement | null;
                if (!isCurrentlyFilled) {
                    star.classList.add('filled');
                    if (checkmark) {
                        checkmark.style.visibility = 'visible';
                        checkmark.style.opacity = '1';
                    }
                } else {
                    star.classList.remove('filled');
                    if (checkmark) {
                        checkmark.style.visibility = 'hidden';
                        checkmark.style.opacity = '0';
                    }
                }
            });
            toggleDivergenceFavorite(Number(id)).then((updatedAlert) => {
                const all = getDivergenceSignals();
                const idx = all.findIndex((a) => a.id === updatedAlert.id);
                if (idx !== -1) {
                    all[idx].is_favorite = updatedAlert.is_favorite;
                    setDivergenceSignals(all);
                }
                allStars.forEach(star => {
                    const checkmark = star.querySelector('.check-mark') as HTMLElement | null;
                    if (updatedAlert.is_favorite) {
                        star.classList.add('filled');
                        if (checkmark) {
                            checkmark.style.visibility = 'visible';
                            checkmark.style.opacity = '1';
                        }
                    } else {
                        star.classList.remove('filled');
                        if (checkmark) {
                            checkmark.style.visibility = 'hidden';
                            checkmark.style.opacity = '0';
                        }
                    }
                });
            }).catch(() => {
                allStars.forEach(star => {
                    const checkmark = star.querySelector('.check-mark') as HTMLElement | null;
                    if (isCurrentlyFilled) {
                        star.classList.add('filled');
                        if (checkmark) {
                            checkmark.style.visibility = 'visible';
                            checkmark.style.opacity = '1';
                        }
                    } else {
                        star.classList.remove('filled');
                        if (checkmark) {
                            checkmark.style.visibility = 'hidden';
                            checkmark.style.opacity = '0';
                        }
                    }
                });
            });
            return;
        }

        const card = target.closest('.alert-card');
        if (card) {
            const ticker = (card as HTMLElement).dataset.ticker;
            if (ticker && window.showTickerView) {
                // Determine context
                let listContext: 'daily' | 'weekly' | null = null;
                if (card.closest('#divergence-daily-container')) {
                    listContext = 'daily';
                } else if (card.closest('#divergence-weekly-container')) {
                    listContext = 'weekly';
                }
                window.showTickerView(ticker, 'divergence', listContext);
            }
        }
    });
}

export function setDivergenceDailySort(mode: SortMode): void {
    if (mode === dailySortMode && mode !== 'favorite') {
        dailySortDirection = dailySortDirection === 'desc' ? 'asc' : 'desc';
    } else {
        dailySortMode = mode;
        dailySortDirection = 'desc';
    }
    updateSortButtonUi('#view-divergence .divergence-daily-sort', dailySortMode, dailySortDirection);
    renderDivergenceContainer('1d');
}

export function setDivergenceWeeklySort(mode: SortMode): void {
    if (mode === weeklySortMode && mode !== 'favorite') {
        weeklySortDirection = weeklySortDirection === 'desc' ? 'asc' : 'desc';
    } else {
        weeklySortMode = mode;
        weeklySortDirection = 'desc';
    }
    updateSortButtonUi('#view-divergence .divergence-weekly-sort', weeklySortMode, weeklySortDirection);
    renderDivergenceContainer('1w');
}

export function initializeDivergenceSortDefaults(): void {
    dailySortMode = 'combo';
    dailySortDirection = 'desc';
    weeklySortMode = 'combo';
    weeklySortDirection = 'desc';
    updateSortButtonUi('#view-divergence .divergence-daily-sort', dailySortMode, dailySortDirection);
    updateSortButtonUi('#view-divergence .divergence-weekly-sort', weeklySortMode, weeklySortDirection);
}

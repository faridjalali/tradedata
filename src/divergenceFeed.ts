import { getDateRangeForMode, createAlertSortFn, updateSortButtonUi } from './utils';
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
    startDivergenceFetchDailyData,
    stopDivergenceFetchDailyData,
    startDivergenceFetchWeeklyData,
    stopDivergenceFetchWeeklyData,
    startVDFScan,
    stopVDFScan,
    fetchDivergenceScanStatus,
    DivergenceScanStatus
} from './divergenceApi';
import { setDivergenceSignals, setDivergenceSignalsByTimeframe, getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { hydrateAlertCardDivergenceTables, primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { refreshActiveTickerDivergenceSummary, isChartActivelyLoading } from './chart';
import { SortMode, Alert } from './types';
import { createChart } from 'lightweight-charts';

export type ColumnFeedMode = '1' | '2' | '5' | 'custom';

let dailyFeedMode: ColumnFeedMode = '1';
let weeklyFeedMode: ColumnFeedMode = '1';
let dailyCustomFrom = '';
let dailyCustomTo = '';
let weeklyCustomFrom = '';
let weeklyCustomTo = '';
let dailySortMode: SortMode = 'score';
let weeklySortMode: SortMode = 'score';
let dailySortDirection: 'asc' | 'desc' = 'desc';
let weeklySortDirection: 'asc' | 'desc' = 'desc';
const ALERTS_PAGE_SIZE = 100;
let dailyVisibleCount = ALERTS_PAGE_SIZE;
let weeklyVisibleCount = ALERTS_PAGE_SIZE;
let divergenceScanPollTimer: number | null = null;
let divergenceScanPollInFlight = false;
let divergenceScanPollConsecutiveErrors = 0;
const DIVERGENCE_POLL_ERROR_THRESHOLD = 3;
let divergenceFetchDailyLastProcessedTickers = -1;
let divergenceFetchWeeklyLastProcessedTickers = -1;
let divergenceTableLastUiRefreshAtMs = 0;
const DIVERGENCE_TABLE_UI_REFRESH_MIN_MS = 8000;
let divergenceTableRunningState = false;
let divergenceFetchDailyRunningState = false;
let divergenceFetchWeeklyRunningState = false;
let allowAutoCardRefreshFromFetchDaily = false;
let allowAutoCardRefreshFromFetchWeekly = false;
let allowAutoCardRefreshFromVDFScan = false;
let vdfScanLastProcessedTickers = -1;

// --- Mini-chart hover overlay state ---
let miniChartOverlayEl: HTMLDivElement | null = null;
let miniChartInstance: ReturnType<typeof createChart> | null = null;
let miniChartHoverTimer: number | null = null;
let miniChartAbortController: AbortController | null = null;
let miniChartCurrentTicker: string | null = null;
let miniChartHoveredCard: HTMLElement | null = null;
const miniChartDataCache = new Map<string, Array<{ time: string | number; open: number; high: number; low: number; close: number }>>();
const MINI_CHART_CACHE_MAX = 400;
let miniChartPrefetchInFlight = false;

function evictMiniChartCache(keepCount: number): void {
    if (miniChartDataCache.size <= keepCount) return;
    const excess = miniChartDataCache.size - keepCount;
    const iter = miniChartDataCache.keys();
    for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key !== undefined) miniChartDataCache.delete(key);
    }
}

async function prefetchMiniChartBars(tickers: string[]): Promise<void> {
    if (miniChartPrefetchInFlight || tickers.length === 0) return;
    const needed = tickers.filter(t => !miniChartDataCache.has(t.toUpperCase()));
    if (needed.length === 0) return;

    miniChartPrefetchInFlight = true;
    try {
        const res = await fetch(`/api/chart/mini-bars/batch?tickers=${encodeURIComponent(needed.join(','))}`);
        if (!res.ok) return;
        const data = await res.json();
        const results: Record<string, Array<{ time: string | number; open: number; high: number; low: number; close: number }>> = data?.results || {};
        for (const [ticker, bars] of Object.entries(results)) {
            if (Array.isArray(bars) && bars.length > 0) {
                miniChartDataCache.set(ticker.toUpperCase(), bars);
            }
        }
        evictMiniChartCache(MINI_CHART_CACHE_MAX);
    } catch {
        // silent — prefetch is best-effort
    } finally {
        miniChartPrefetchInFlight = false;
    }
}

export function getColumnFeedMode(column: 'daily' | 'weekly'): ColumnFeedMode {
    return column === 'daily' ? dailyFeedMode : weeklyFeedMode;
}

export function setColumnCustomDates(column: 'daily' | 'weekly', from: string, to: string): void {
    if (column === 'daily') {
        dailyCustomFrom = from;
        dailyCustomTo = to;
    } else {
        weeklyCustomFrom = from;
        weeklyCustomTo = to;
    }
}

function getColumnCustomDates(column: 'daily' | 'weekly'): { from: string; to: string } {
    return column === 'daily'
        ? { from: dailyCustomFrom, to: dailyCustomTo }
        : { from: weeklyCustomFrom, to: weeklyCustomTo };
}

/** Filter alerts to only the N most recent unique trade dates */
export function filterToLatestNDates(alerts: Alert[], n: number): Alert[] {
    const dates = new Set<string>();
    for (const a of alerts) {
        const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
        if (d) dates.add(d);
    }
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    const topN = new Set(sorted.slice(0, n));
    return alerts.filter(a => {
        const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
        return d ? topN.has(d) : false;
    });
}

/** Apply column feed mode date filter */
function applyColumnDateFilter(alerts: Alert[], mode: ColumnFeedMode): Alert[] {
    if (mode === '1') return filterToLatestNDates(alerts, 1);
    if (mode === '2') return filterToLatestNDates(alerts, 2);
    if (mode === '5') return filterToLatestNDates(alerts, 5);
    return alerts; // 'custom' — server already filtered
}

export function shouldAutoRefreshDivergenceFeed(): boolean {
    return (divergenceFetchDailyRunningState && allowAutoCardRefreshFromFetchDaily)
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

function getFetchDailyButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
    return {
        button: document.getElementById('divergence-fetch-daily-btn') as HTMLButtonElement | null,
        status: document.getElementById('divergence-fetch-daily-status')
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

function getFetchDailyControlButtons(): {
    stopButton: HTMLButtonElement | null;
} {
    return {
        stopButton: document.getElementById('divergence-fetch-daily-stop-btn') as HTMLButtonElement | null,
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

function getVDFScanButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
    return {
        button: document.getElementById('divergence-vdf-scan-btn') as HTMLButtonElement | null,
        status: document.getElementById('divergence-vdf-scan-status')
    };
}

function getVDFScanControlButtons(): { stopButton: HTMLButtonElement | null } {
    return {
        stopButton: document.getElementById('divergence-vdf-scan-stop-btn') as HTMLButtonElement | null,
    };
}

function setVDFScanButtonState(running: boolean): void {
    const { button } = getVDFScanButtonElements();
    if (!button) return;
    button.disabled = running;
    button.classList.toggle('active', running);
    button.textContent = 'VDF Scan';
}

function setVDFScanStatusText(text: string): void {
    const { status } = getVDFScanButtonElements();
    if (!status) return;
    status.textContent = text;
}

function setVDFScanControlButtonState(status: DivergenceScanStatus | null): void {
    const { stopButton } = getVDFScanControlButtons();
    const vdfScan = status?.vdfScan || null;
    const running = Boolean(vdfScan?.running);
    const stopRequested = Boolean(vdfScan?.stop_requested);
    if (stopButton) {
        stopButton.textContent = '\u23F9';
        stopButton.disabled = !running || stopRequested;
        stopButton.classList.toggle('active', running);
        stopButton.setAttribute('aria-label', 'Stop VDF Scan');
        stopButton.title = 'Stop VDF Scan';
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

function setFetchDailyControlButtonState(status: DivergenceScanStatus | null): void {
    const { stopButton } = getFetchDailyControlButtons();
    const fetchDaily = status?.fetchDailyData || null;
    const running = Boolean(fetchDaily?.running);
    const stopRequested = Boolean(fetchDaily?.stop_requested);
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

function toDateKeyAsET(raw?: string | null): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    const parts = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
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

function summarizeFetchDailyStatus(status: DivergenceScanStatus): string {
    const fetchDaily = status.fetchDailyData;
    const latest = status.latestJob as (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string }) | null;
    const lastRunDateKey =
        toDateKey(fetchDaily?.last_published_trade_date || null)
        || toDateKey(status.lastScanDateEt)
        || toDateKey(latest?.scanned_trade_date)
        || toDateKey(latest?.run_for_date)
        || toDateKey(latest?.finished_at)
        || toDateKey(latest?.started_at);
    const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
    const ranText = lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Fetched --';
    if (!fetchDaily) return ranText;
    const fetchDailyState = String(fetchDaily.status || '').toLowerCase();
    if (fetchDailyState === 'stopping') {
        return 'Stopping';
    }
    if (fetchDailyState === 'stopped') {
        if (fetchDaily.can_resume) {
            const processed = Number(fetchDaily.processed_tickers || 0);
            const total = Number(fetchDaily.total_tickers || 0);
            return total > 0 ? `Stopped ${processed}/${total} (resumable)` : 'Stopped (resumable)';
        }
        return 'Stopped';
    }
    if (fetchDaily.running) {
        const processed = Number(fetchDaily.processed_tickers || 0);
        const total = Number(fetchDaily.total_tickers || 0);
        const errors = Number(fetchDaily.error_tickers || 0);
        if (fetchDaily.stop_requested) {
            return 'Stopping';
        }
        if (fetchDailyState === 'running-retry') {
            return `Retrying ${errors} failed (${processed}/${total})`;
        }
        if (fetchDailyState === 'running-ma') {
            return `MA ${processed}/${total}`;
        }
        if (fetchDailyState === 'running-ma-retry') {
            return `Retrying failed MA (${processed}/${total})`;
        }
        return `${processed} / ${total}`;
    }
    if (fetchDailyState === 'completed') {
        return ranText;
    }
    if (fetchDailyState === 'completed-with-errors') {
        return ranText;
    }
    if (fetchDailyState === 'failed') {
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
    const ranText = lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Fetched --';
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

function summarizeVDFScanStatus(status: DivergenceScanStatus): string {
    const scan = status.vdfScan;
    if (!scan) return 'Ran --';
    const state = String(scan.status || '').toLowerCase();
    const lastRunDateKey = toDateKeyAsET(scan.finished_at || scan.started_at || null);
    const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
    const ranText = lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Ran --';
    if (state === 'stopping') {
        return 'Stopping';
    }
    if (state === 'stopped') {
        return 'Stopped';
    }
    if (scan.running) {
        const processed = Number(scan.processed_tickers || 0);
        const total = Number(scan.total_tickers || 0);
        const detected = Number(scan.detected_tickers || 0);
        if (scan.stop_requested) {
            return 'Stopping';
        }
        if (state === 'running-retry') {
            return `Retrying (${processed}/${total})`;
        }
        return `${processed}/${total} (${detected} VDF)`;
    }
    if (state === 'completed' || state === 'completed-with-errors') {
        const detected = Number(scan.detected_tickers || 0);
        return detected > 0 ? `${ranText} (${detected} VDF)` : ranText;
    }
    if (state === 'failed') {
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
    // P2: Defer card refreshes while an active chart load (P0) is in progress.
    if (isChartActivelyLoading()) return;
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
                    await fetchDivergenceSignalsByTimeframe('1d');
                    renderDivergenceContainer('1d');
                }
                if (allowAutoCardRefreshFromFetchWeekly) {
                    await fetchDivergenceSignalsByTimeframe('1w');
                    renderDivergenceContainer('1w');
                }
                if (allowAutoCardRefreshFromVDFScan) {
                    await fetchDivergenceSignals();
                    renderDivergenceOverview();
                }
            }
            allowAutoCardRefreshFromFetchDaily = false;
            allowAutoCardRefreshFromFetchWeekly = false;
            allowAutoCardRefreshFromVDFScan = false;
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
    setFetchDailyStatusText('Starting...');
    allowAutoCardRefreshFromFetchDaily = true;
    allowAutoCardRefreshFromFetchWeekly = false;
    try {
        const started = await startDivergenceFetchDailyData();
        if (started.status === 'running') setFetchDailyStatusText('Already running');
        else if (started.status === 'resumed') setFetchDailyStatusText('Resuming...');
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
    setFetchWeeklyStatusText('Starting...');
    allowAutoCardRefreshFromFetchWeekly = true;
    allowAutoCardRefreshFromFetchDaily = false;
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
    setVDFScanStatusText('Starting...');
    allowAutoCardRefreshFromVDFScan = true;
    allowAutoCardRefreshFromFetchDaily = false;
    allowAutoCardRefreshFromFetchWeekly = false;
    try {
        const started = await startVDFScan();
        if (started.status === 'running') setVDFScanStatusText('Already running');
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

export async function fetchDivergenceSignals(_force?: boolean): Promise<Alert[]> {
    try {
        // Fetch both columns independently using their per-column modes
        const [daily, weekly] = await Promise.all([
            fetchDivergenceSignalsByTimeframe('1d'),
            fetchDivergenceSignalsByTimeframe('1w')
        ]);
        const all = [...daily, ...weekly];
        primeDivergenceSummaryCacheFromAlerts(all);
        return all;
    } catch (error) {
        console.error('Error fetching divergence signals:', error);
        return [];
    }
}

function showMoreButtonHtml(shown: number, total: number, timeframe: '1d' | '1w'): string {
    if (shown >= total) return '';
    const remaining = total - shown;
    const nextBatch = Math.min(remaining, ALERTS_PAGE_SIZE);
    return `<button class="tf-btn show-more-btn" data-timeframe="${timeframe}">▼ Show ${nextBatch} more (${shown}/${total})</button>`;
}

export function renderDivergenceOverview(): void {
    const allSignals = getDivergenceSignals();
    primeDivergenceSummaryCacheFromAlerts(allSignals);
    dailyVisibleCount = ALERTS_PAGE_SIZE;
    weeklyVisibleCount = ALERTS_PAGE_SIZE;
    const dailyContainer = document.getElementById('divergence-daily-container');
    const weeklyContainer = document.getElementById('divergence-weekly-container');
    if (!dailyContainer || !weeklyContainer) return;

    let daily = allSignals.filter((a) => (a.timeframe || '').trim() === '1d');
    let weekly = allSignals.filter((a) => (a.timeframe || '').trim() === '1w');

    // Apply per-column date filter (last N fetch days)
    daily = applyColumnDateFilter(daily, dailyFeedMode);
    weekly = applyColumnDateFilter(weekly, weeklyFeedMode);

    if (dailySortMode === 'favorite') {
        daily = daily.filter(a => a.is_favorite);
    }
    if (weeklySortMode === 'favorite') {
        weekly = weekly.filter(a => a.is_favorite);
    }

    daily.sort(createAlertSortFn(dailySortMode === 'favorite' ? 'time' : dailySortMode, dailySortDirection));
    weekly.sort(createAlertSortFn(weeklySortMode === 'favorite' ? 'time' : weeklySortMode, weeklySortDirection));

    const dailySlice = daily.slice(0, dailyVisibleCount);
    const weeklySlice = weekly.slice(0, weeklyVisibleCount);

    dailyContainer.innerHTML = dailySlice.map(createAlertCard).join('')
        + showMoreButtonHtml(dailySlice.length, daily.length, '1d');
    weeklyContainer.innerHTML = weeklySlice.map(createAlertCard).join('')
        + showMoreButtonHtml(weeklySlice.length, weekly.length, '1w');
    renderAlertCardDivergenceTablesFromCache(dailyContainer);
    renderAlertCardDivergenceTablesFromCache(weeklyContainer);

    // Prefetch mini-chart bars for visible cards (best-effort, non-blocking)
    const prefetchTickers = [
        ...dailySlice.map(a => a.ticker),
        ...weeklySlice.map(a => a.ticker),
    ];
    const unique = Array.from(new Set(prefetchTickers.map(t => t.toUpperCase())));
    prefetchMiniChartBars(unique).catch(() => {});
}

/**
 * Fetch signals for a single timeframe and update only that timeframe's state.
 * Uses per-column feed mode for date range.
 * The other timeframe's signals are left completely untouched.
 */
export async function fetchDivergenceSignalsByTimeframe(timeframe: '1d' | '1w'): Promise<Alert[]> {
    try {
        const column: 'daily' | 'weekly' = timeframe === '1d' ? 'daily' : 'weekly';
        const mode = getColumnFeedMode(column);
        const custom = getColumnCustomDates(column);

        const { startDate, endDate } = getDateRangeForMode(mode, custom.from, custom.to);
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

    const column: 'daily' | 'weekly' = timeframe === '1d' ? 'daily' : 'weekly';
    const mode = getColumnFeedMode(column);
    const sortMode = timeframe === '1d' ? dailySortMode : weeklySortMode;
    const sortDirection = timeframe === '1d' ? dailySortDirection : weeklySortDirection;
    let signals = allSignals.filter((a) => (a.timeframe || '').trim() === timeframe);

    // Apply per-column date filter (last N fetch days)
    signals = applyColumnDateFilter(signals, mode);

    if (sortMode === 'favorite') {
        signals = signals.filter(a => a.is_favorite);
    }

    signals.sort(createAlertSortFn(sortMode === 'favorite' ? 'time' : sortMode, sortDirection));

    const visibleCount = timeframe === '1d' ? dailyVisibleCount : weeklyVisibleCount;
    const slice = signals.slice(0, visibleCount);

    container.innerHTML = slice.map(createAlertCard).join('')
        + showMoreButtonHtml(slice.length, signals.length, timeframe);
    renderAlertCardDivergenceTablesFromCache(container);

    // Prefetch mini-chart bars for visible cards (best-effort, non-blocking)
    const prefetchTickers = Array.from(new Set(slice.map(a => a.ticker.toUpperCase())));
    prefetchMiniChartBars(prefetchTickers).catch(() => {});
}

// --- Mini-chart hover helpers ---

function destroyMiniChartOverlay(): void {
    if (miniChartHoverTimer !== null) {
        window.clearTimeout(miniChartHoverTimer);
        miniChartHoverTimer = null;
    }
    if (miniChartAbortController) {
        try { miniChartAbortController.abort(); } catch { /* ignore */ }
        miniChartAbortController = null;
    }
    if (miniChartInstance) {
        try { miniChartInstance.remove(); } catch { /* ignore */ }
        miniChartInstance = null;
    }
    if (miniChartOverlayEl) {
        miniChartOverlayEl.remove();
        miniChartOverlayEl = null;
    }
    miniChartCurrentTicker = null;
    miniChartHoveredCard = null;
}

async function showMiniChartOverlay(ticker: string, cardRect: DOMRect): Promise<void> {
    if (miniChartCurrentTicker === ticker && miniChartOverlayEl) return;
    destroyMiniChartOverlay();
    miniChartCurrentTicker = ticker;

    // Create overlay element
    const overlay = document.createElement('div');
    overlay.className = 'mini-chart-overlay';
    overlay.style.cssText = `
        position: fixed;
        width: 500px;
        height: 300px;
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 6px;
        z-index: 1000;
        pointer-events: none;
        overflow: hidden;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    `;

    // Position: prefer right of card, fall back to left
    const OVERLAY_W = 500;
    const OVERLAY_H = 300;
    const GAP = 8;
    let left = cardRect.right + GAP;
    let top = cardRect.top;
    if (left + OVERLAY_W > window.innerWidth) {
        left = cardRect.left - OVERLAY_W - GAP;
    }
    if (left < 0) left = GAP;
    if (top + OVERLAY_H > window.innerHeight) {
        top = window.innerHeight - OVERLAY_H - GAP;
    }
    if (top < 0) top = GAP;

    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    document.body.appendChild(overlay);
    miniChartOverlayEl = overlay;

    // Fetch cached daily bars from server (populated during daily/weekly scans)
    let bars: Array<{ time: string | number; open: number; high: number; low: number; close: number }>;
    const cached = miniChartDataCache.get(ticker);
    if (cached) {
        bars = cached;
    } else {
        const controller = new AbortController();
        miniChartAbortController = controller;
        try {
            const res = await fetch(`/api/chart/mini-bars?ticker=${encodeURIComponent(ticker)}`, {
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            bars = Array.isArray(data?.bars) ? data.bars : [];
            if (bars.length > 0) miniChartDataCache.set(ticker, bars);
        } catch {
            if (miniChartCurrentTicker === ticker) destroyMiniChartOverlay();
            return;
        }
        miniChartAbortController = null;
    }

    // Guard: overlay may have been destroyed during await
    if (miniChartCurrentTicker !== ticker || !miniChartOverlayEl) return;

    if (bars.length === 0) {
        destroyMiniChartOverlay();
        return;
    }

    // Create lightweight-charts instance
    const chart = createChart(overlay, {
        width: 500,
        height: 300,
        layout: {
            background: { color: '#0d1117' },
            textColor: '#d1d4dc',
            fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
            attributionLogo: false,
        },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { visible: false },
        timeScale: { visible: false },
        handleScroll: false,
        handleScale: false,
        crosshair: {
            vertLine: { visible: false },
            horzLine: { visible: false },
        },
    });
    miniChartInstance = chart;

    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
        priceLineVisible: false,
        lastValueVisible: false,
    });
    candleSeries.setData(bars as any);
    chart.timeScale().fitContent();
}

function handleFavoriteClick(e: Event): void {
    const target = e.target as HTMLElement;
    const starBtn = target.closest('.fav-icon');
    if (!starBtn) return;

    e.stopPropagation();
    const id = (starBtn as HTMLElement).dataset.id;
    const source = 'DataAPI';
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
}

export function setupDivergenceFeedDelegation(): void {
    const view = document.getElementById('view-divergence');
    if (!view) return;

    // Favorite toggle — attach to both alerts page and ticker page
    view.addEventListener('click', handleFavoriteClick);
    const tickerView = document.getElementById('ticker-view');
    if (tickerView) {
        tickerView.addEventListener('click', handleFavoriteClick);
    }

    view.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.fav-icon')) return; // Already handled above

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

    // Sort Buttons
    document.querySelectorAll('#view-divergence .divergence-daily-sort .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setDivergenceDailySort(mode);
        });
    });

    document.querySelectorAll('#view-divergence .divergence-weekly-sort .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setDivergenceWeeklySort(mode);
        });
    });

    // --- Mini-chart hover overlay on alert cards ---
    // Use capture phase because mouseenter/mouseleave don't bubble.
    // Guard with relatedTarget so moves between children within the same card
    // don't destroy/restart the overlay.
    view.addEventListener('mouseenter', (e: Event) => {
        const me = e as MouseEvent;
        const target = me.target as HTMLElement;
        const card = target.closest('.alert-card') as HTMLElement | null;
        if (!card) return;
        const ticker = card.dataset.ticker;
        if (!ticker) return;

        // If we're already tracking this card (mouse moved between children), skip
        if (miniChartHoveredCard === card) return;
        miniChartHoveredCard = card;

        if (miniChartHoverTimer !== null) {
            window.clearTimeout(miniChartHoverTimer);
        }
        miniChartHoverTimer = window.setTimeout(() => {
            miniChartHoverTimer = null;
            const rect = card.getBoundingClientRect();
            showMiniChartOverlay(ticker, rect);
        }, 1000);
    }, true);

    view.addEventListener('mouseleave', (e: Event) => {
        const me = e as MouseEvent;
        const target = me.target as HTMLElement;
        const card = target.closest('.alert-card') as HTMLElement | null;
        if (!card) return;
        // If the mouse is moving to another element still within this card, ignore
        const relatedTarget = me.relatedTarget as HTMLElement | null;
        if (relatedTarget && card.contains(relatedTarget)) return;
        miniChartHoveredCard = null;
        destroyMiniChartOverlay();
    }, true);

    // --- Touch long-press for minichart overlay (touchscreen devices) ---
    let touchLongPressTimer: number | null = null;
    let touchLongPressFired = false;

    view.addEventListener('touchstart', (e: Event) => {
        const te = e as TouchEvent;
        if (te.touches.length !== 1) return;
        const target = te.target as HTMLElement;
        const card = target.closest('.alert-card') as HTMLElement | null;
        if (!card) return;
        const ticker = card.dataset.ticker;
        if (!ticker) return;
        touchLongPressFired = false;
        if (touchLongPressTimer !== null) window.clearTimeout(touchLongPressTimer);
        touchLongPressTimer = window.setTimeout(() => {
            touchLongPressTimer = null;
            touchLongPressFired = true;
            const rect = card.getBoundingClientRect();
            showMiniChartOverlay(ticker, rect);
        }, 600);
    }, { passive: true });

    view.addEventListener('touchmove', () => {
        if (touchLongPressTimer !== null) {
            window.clearTimeout(touchLongPressTimer);
            touchLongPressTimer = null;
        }
    }, { passive: true });

    view.addEventListener('touchend', () => {
        if (touchLongPressTimer !== null) {
            window.clearTimeout(touchLongPressTimer);
            touchLongPressTimer = null;
        }
        if (touchLongPressFired) {
            destroyMiniChartOverlay();
            touchLongPressFired = false;
        }
        touchLongPressFired = false;
    }, { passive: true });

    view.addEventListener('touchcancel', () => {
        if (touchLongPressTimer !== null) {
            window.clearTimeout(touchLongPressTimer);
            touchLongPressTimer = null;
        }
        if (touchLongPressFired) {
            destroyMiniChartOverlay();
            touchLongPressFired = false;
        }
        touchLongPressFired = false;
    }, { passive: true });

    // "Show more" pagination button
    view.addEventListener('click', (e: Event) => {
        const btn = (e.target as HTMLElement).closest('.show-more-btn') as HTMLElement | null;
        if (!btn) return;
        const tf = btn.dataset.timeframe as '1d' | '1w' | undefined;
        if (!tf) return;
        if (tf === '1d') {
            dailyVisibleCount += ALERTS_PAGE_SIZE;
            renderDivergenceContainer('1d');
        } else {
            weeklyVisibleCount += ALERTS_PAGE_SIZE;
            renderDivergenceContainer('1w');
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
    dailyVisibleCount = ALERTS_PAGE_SIZE;
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
    weeklyVisibleCount = ALERTS_PAGE_SIZE;
    updateSortButtonUi('#view-divergence .divergence-weekly-sort', weeklySortMode, weeklySortDirection);
    renderDivergenceContainer('1w');
}

export function initializeDivergenceSortDefaults(): void {
    dailySortMode = 'score';
    dailySortDirection = 'desc';
    weeklySortMode = 'score';
    weeklySortDirection = 'desc';
    dailyFeedMode = '1';
    weeklyFeedMode = '1';
    updateSortButtonUi('#view-divergence .divergence-daily-sort', dailySortMode, dailySortDirection);
    updateSortButtonUi('#view-divergence .divergence-weekly-sort', weeklySortMode, weeklySortDirection);
}
// ... existing code ...

/**
 * Set the feed mode for a specific column (daily or weekly) independently.
 * Updates the dropdown UI and optionally re-fetches + re-renders that column.
 */
export function setColumnFeedMode(column: 'daily' | 'weekly', mode: ColumnFeedMode, fetchData = true): void {
    if (column === 'daily') {
        dailyFeedMode = mode;
    } else {
        weeklyFeedMode = mode;
    }

    // Update button active state for all instances of this column
    document.querySelectorAll(`.column-tf-controls[data-column="${column}"]`).forEach(controls => {
        controls.querySelectorAll('.tf-btn[data-tf]').forEach(btn => {
            const el = btn as HTMLElement;
            el.classList.toggle('active', el.dataset.tf === mode);
        });
    });

    if (fetchData) {
        const timeframe: '1d' | '1w' = column === 'daily' ? '1d' : '1w';
        fetchDivergenceSignalsByTimeframe(timeframe).then(() => renderDivergenceContainer(timeframe));
    }
}


import { getCurrentWeekISO, getCurrentMonthISO, getDateRangeForMode, createAlertSortFn } from './utils';
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
    fetchDivergenceScanStatus,
    DivergenceScanStatus
} from './divergenceApi';
import { setDivergenceSignals, getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { hydrateAlertCardDivergenceTables } from './divergenceTable';
import { refreshActiveTickerDivergenceSummary } from './chart';
import { LiveFeedMode, SortMode, Alert } from './types';

let divergenceFeedMode: LiveFeedMode = '1';
let dailySortMode: SortMode = 'time';
let weeklySortMode: SortMode = 'time';
let divergenceScanPollTimer: number | null = null;
let divergenceScanPollInFlight = false;
let divergenceTableLastProcessedTickers = -1;
let divergenceTableLastUiRefreshAtMs = 0;
const DIVERGENCE_TABLE_UI_REFRESH_MIN_MS = 8000;
let divergenceScanRunningState = false;
let divergenceTableRunningState = false;

export function getDivergenceFeedMode(): LiveFeedMode {
    return divergenceFeedMode;
}

export function setDivergenceFeedModeState(mode: LiveFeedMode): void {
    divergenceFeedMode = mode;
}

export function shouldAutoRefreshDivergenceFeed(): boolean {
    return divergenceScanRunningState || divergenceTableRunningState;
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
    if (!Number.isFinite(month) || month <= 0) return '';
    return `${month}/${parts[2]}`;
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
    if (tableState === 'failed') {
        return 'Table failed';
    }
    return 'Table idle';
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
        await Promise.allSettled(
            containers.map((container) => hydrateAlertCardDivergenceTables(container, undefined, { forceRefresh: true, noCache }))
        );
    }
    refreshActiveTickerDivergenceSummary({ noCache });
}

function refreshDivergenceTablesWhileRunning(force = false): void {
    void hydrateVisibleDivergenceTables(force);
}

async function pollDivergenceScanStatus(refreshOnComplete: boolean): Promise<void> {
    if (divergenceScanPollInFlight) return;
    divergenceScanPollInFlight = true;
    try {
        const status = await fetchDivergenceScanStatus();
        divergenceScanRunningState = Boolean(status.running);
        divergenceTableRunningState = Boolean(status.tableBuild?.running);
        setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
        setRunStatusText(summarizeStatus(status));
        setRunControlButtonState(status);
        const tableRunning = divergenceTableRunningState;
        setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
        setTableRunStatusText(summarizeTableStatus(status));
        setTableControlButtonState(status);
        if (tableRunning) {
            const processed = Number(status.tableBuild?.processed_tickers || 0);
            const progressed = processed !== divergenceTableLastProcessedTickers;
            divergenceTableLastProcessedTickers = processed;
            refreshDivergenceTablesWhileRunning(progressed);
        } else {
            divergenceTableLastProcessedTickers = -1;
            divergenceTableLastUiRefreshAtMs = 0;
        }
        if (!status.running && !tableRunning) {
            clearDivergenceScanPolling();
            if (refreshOnComplete) {
                await fetchDivergenceSignals(true);
                renderDivergenceOverview();
            }
        }
    } catch (error) {
        console.error('Failed to poll divergence scan status:', error);
        divergenceScanRunningState = false;
        divergenceTableRunningState = false;
        setRunStatusText(toStatusTextFromError(error));
        setTableRunStatusText(toStatusTextFromError(error));
        clearDivergenceScanPolling();
        setRunButtonState(false, false);
        setRunControlButtonState(null);
        setTableRunButtonState(false, false);
        setTableControlButtonState(null);
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
        divergenceScanRunningState = Boolean(status.running);
        divergenceTableRunningState = Boolean(status.tableBuild?.running);
        setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
        setRunStatusText(summarizeStatus(status));
        setRunControlButtonState(status);
        const tableRunning = divergenceTableRunningState;
        setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
        setTableRunStatusText(summarizeTableStatus(status));
        setTableControlButtonState(status);
        if (tableRunning) {
            const processed = Number(status.tableBuild?.processed_tickers || 0);
            const progressed = processed !== divergenceTableLastProcessedTickers;
            divergenceTableLastProcessedTickers = processed;
            refreshDivergenceTablesWhileRunning(progressed);
        } else {
            divergenceTableLastProcessedTickers = -1;
            divergenceTableLastUiRefreshAtMs = 0;
        }
        if (status.running || tableRunning) {
            ensureDivergenceScanPolling(true);
        } else {
            clearDivergenceScanPolling();
        }
    } catch (error) {
        console.error('Failed to sync divergence scan UI state:', error);
        divergenceScanRunningState = false;
        divergenceTableRunningState = false;
        setRunButtonState(false, false);
        setRunControlButtonState(null);
        setRunStatusText(toStatusTextFromError(error));
        setTableRunButtonState(false, false);
        setTableRunStatusText(toStatusTextFromError(error));
        setTableControlButtonState(null);
    }
}

export async function runManualDivergenceScan(): Promise<void> {
    setRunButtonState(true, false);
    setRunStatusText('Starting...');
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

export function isCurrentDivergenceTimeframe(): boolean {
    if (divergenceFeedMode === '30' || divergenceFeedMode === '7' || divergenceFeedMode === '1') return true;
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
        setDivergenceSignals(data);
        return data;
    } catch (error) {
        console.error('Error fetching divergence signals:', error);
        return [];
    }
}

export function renderDivergenceOverview(): void {
    const allSignals = getDivergenceSignals();
    const dailyContainer = document.getElementById('divergence-daily-container');
    const weeklyContainer = document.getElementById('divergence-weekly-container');
    if (!dailyContainer || !weeklyContainer) return;

    const daily = allSignals.filter((a) => (a.timeframe || '').trim() === '1d');
    const weekly = allSignals.filter((a) => (a.timeframe || '').trim() === '1w');

    daily.sort(createAlertSortFn(dailySortMode));
    weekly.sort(createAlertSortFn(weeklySortMode));

    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    hydrateAlertCardDivergenceTables(dailyContainer).catch(() => {});
    hydrateAlertCardDivergenceTables(weeklyContainer).catch(() => {});
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
            const source = (starBtn as HTMLElement).dataset.source === 'TV' ? 'TV' : 'FMP';
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
                window.showTickerView(ticker, 'divergence');
            }
        }
    });
}

export function setDivergenceDailySort(mode: SortMode): void {
    dailySortMode = mode;
    const dailyHeader = document.querySelector('#view-divergence .divergence-daily-sort');
    if (dailyHeader) {
        dailyHeader.querySelectorAll('.tf-btn').forEach(btn => {
            const el = btn as HTMLElement;
            if (el.dataset.sort === mode) el.classList.add('active');
            else el.classList.remove('active');
        });
    }
    renderDivergenceOverview();
}

export function setDivergenceWeeklySort(mode: SortMode): void {
    weeklySortMode = mode;
    const weeklyHeader = document.querySelector('#view-divergence .divergence-weekly-sort');
    if (weeklyHeader) {
        weeklyHeader.querySelectorAll('.tf-btn').forEach(btn => {
            const el = btn as HTMLElement;
            if (el.dataset.sort === mode) el.classList.add('active');
            else el.classList.remove('active');
        });
    }
    renderDivergenceOverview();
}

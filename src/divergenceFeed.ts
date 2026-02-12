import { getCurrentWeekISO, getCurrentMonthISO, getDateRangeForMode, createAlertSortFn } from './utils';
import {
    fetchDivergenceSignalsFromApi,
    toggleDivergenceFavorite,
    startDivergenceScan,
    fetchDivergenceScanStatus,
    DivergenceScanStatus
} from './divergenceApi';
import { setDivergenceSignals, getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { LiveFeedMode, SortMode, Alert } from './types';

let divergenceFeedMode: LiveFeedMode = '1';
let dailySortMode: SortMode = 'time';
let weeklySortMode: SortMode = 'time';
let divergenceScanPollTimer: number | null = null;
let divergenceScanPollInFlight = false;

export function getDivergenceFeedMode(): LiveFeedMode {
    return divergenceFeedMode;
}

export function setDivergenceFeedModeState(mode: LiveFeedMode): void {
    divergenceFeedMode = mode;
}

function getRunButtonElements(): { button: HTMLButtonElement | null; status: HTMLElement | null } {
    return {
        button: document.getElementById('divergence-run-btn') as HTMLButtonElement | null,
        status: document.getElementById('divergence-run-status')
    };
}

function setRunButtonState(running: boolean): void {
    const { button } = getRunButtonElements();
    if (!button) return;
    button.disabled = running;
    button.classList.toggle('active', running);
    button.textContent = running ? 'Running' : 'Run';
}

function setRunStatusText(text: string): void {
    const { status } = getRunButtonElements();
    if (!status) return;
    status.textContent = text;
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
    if (status.running) {
        const processed = Number(latest?.processed_symbols || 0);
        const total = Number(latest?.total_symbols || 0);
        if (total > 0) return `Running ${processed}/${total}`;
        return 'Running';
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

function clearDivergenceScanPolling(): void {
    if (divergenceScanPollTimer !== null) {
        window.clearInterval(divergenceScanPollTimer);
        divergenceScanPollTimer = null;
    }
}

async function pollDivergenceScanStatus(refreshOnComplete: boolean): Promise<void> {
    if (divergenceScanPollInFlight) return;
    divergenceScanPollInFlight = true;
    try {
        const status = await fetchDivergenceScanStatus();
        setRunButtonState(status.running);
        setRunStatusText(summarizeStatus(status));
        if (!status.running) {
            clearDivergenceScanPolling();
            if (refreshOnComplete) {
                await fetchDivergenceSignals(true);
                renderDivergenceOverview();
            }
        }
    } catch (error) {
        console.error('Failed to poll divergence scan status:', error);
        setRunStatusText(toStatusTextFromError(error));
        clearDivergenceScanPolling();
        setRunButtonState(false);
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
        setRunButtonState(status.running);
        setRunStatusText(summarizeStatus(status));
        if (status.running) {
            ensureDivergenceScanPolling(true);
        } else {
            clearDivergenceScanPolling();
        }
    } catch (error) {
        console.error('Failed to sync divergence scan UI state:', error);
        setRunButtonState(false);
        setRunStatusText(toStatusTextFromError(error));
    }
}

export async function runManualDivergenceScan(): Promise<void> {
    setRunButtonState(true);
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
        setRunButtonState(false);
        setRunStatusText(toStatusTextFromError(error));
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

import { getCurrentWeekISO, getCurrentMonthISO, getDateRangeForMode, createAlertSortFn } from './utils';
import { fetchDivergenceSignalsFromApi, toggleDivergenceFavorite } from './divergenceApi';
import { setDivergenceSignals, getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { LiveFeedMode, SortMode, Alert } from './types';

let divergenceFeedMode: LiveFeedMode = '1';
let dailySortMode: SortMode = 'time';
let weeklySortMode: SortMode = 'time';

export function getDivergenceFeedMode(): LiveFeedMode {
    return divergenceFeedMode;
}

export function setDivergenceFeedModeState(mode: LiveFeedMode): void {
    divergenceFeedMode = mode;
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
        if (!starBtn) return;

        e.stopPropagation();
        const id = (starBtn as HTMLElement).dataset.id;
        if (!id) return;

        const allStars = document.querySelectorAll(`.fav-icon[data-id="${id}"]`);
        const isCurrentlyFilled = starBtn.classList.contains('filled');

        allStars.forEach(star => {
            const checkmark = star.querySelector('.check-mark') as HTMLElement | null;
            if (isCurrentlyFilled) {
                star.classList.remove('filled');
                if (checkmark) {
                    checkmark.style.visibility = 'hidden';
                    checkmark.style.opacity = '0';
                }
            } else {
                star.classList.add('filled');
                if (checkmark) {
                    checkmark.style.visibility = 'visible';
                    checkmark.style.opacity = '1';
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


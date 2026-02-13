import { getCurrentWeekISO, getCurrentMonthISO, getDateRangeForMode, createAlertSortFn } from './utils';
import { fetchAlertsFromApi, toggleFavorite } from './api';
import { toggleDivergenceFavorite } from './divergenceApi';
import { setAlerts, getAlerts } from './state';
import { getDivergenceSignals, setDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { LiveFeedMode, SortMode, Alert } from './types';

let liveFeedMode: LiveFeedMode = 'today';
let dailySortMode: SortMode = 'time';
let weeklySortMode: SortMode = 'time';

// We need to declare the window Interface extension to avoid TS errors
declare global {
    interface Window {
        showTickerView: (ticker: string, sourceView?: 'live' | 'divergence') => void;
        showOverview: () => void;
        setDailySort: (mode: SortMode) => void;
        setWeeklySort: (mode: SortMode) => void;
        setTickerDailySort: (mode: SortMode) => void;
        setTickerWeeklySort: (mode: SortMode) => void;
    }
}

export function getLiveFeedMode(): LiveFeedMode {
    return liveFeedMode;
}

export function setLiveFeedModeState(mode: LiveFeedMode): void {
    liveFeedMode = mode;
}

export function isCurrentTimeframe(): boolean {
    if (liveFeedMode === 'today' || liveFeedMode === '30' || liveFeedMode === '7') return true;
    if (liveFeedMode === 'yesterday') return false;
    if (liveFeedMode === 'week') {
        const val = (document.getElementById('history-week') as HTMLInputElement).value;
        return val === getCurrentWeekISO();
    } else {
        const val = (document.getElementById('history-month') as HTMLInputElement).value;
        return val === getCurrentMonthISO();
    }
}

export async function fetchLiveAlerts(_force?: boolean): Promise<Alert[]> {
    try {
        const weekVal = (document.getElementById('history-week') as HTMLInputElement)?.value || '';
        const monthVal = (document.getElementById('history-month') as HTMLInputElement)?.value || '';
        
        const { startDate, endDate } = getDateRangeForMode(liveFeedMode, weekVal, monthVal);
        if (!startDate || !endDate) return [];
        
        const params = `?start_date=${startDate}&end_date=${endDate}`;
        const data = await fetchAlertsFromApi(params);
        primeDivergenceSummaryCacheFromAlerts(data);
        setAlerts(data);
        
        return data; 
    } catch (error) {
        console.error('Error fetching live alerts:', error);
        return [];
    }
}



export function renderOverview(): void {
    const allAlerts = getAlerts();
    primeDivergenceSummaryCacheFromAlerts(allAlerts);
    document.getElementById('ticker-view')!.classList.add('hidden');
    document.getElementById('dashboard-view')!.classList.remove('hidden');
    document.getElementById('reset-filter')!.classList.add('hidden');
    
    const dailyContainer = document.getElementById('daily-container')!;
    const weeklyContainer = document.getElementById('weekly-container')!;
    
    const daily = allAlerts.filter(a => (a.timeframe || '').trim() === '1d');
    const weekly = allAlerts.filter(a => (a.timeframe || '').trim() === '1w');

    daily.sort(createAlertSortFn(dailySortMode));
    weekly.sort(createAlertSortFn(weeklySortMode));
    
    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    renderAlertCardDivergenceTablesFromCache(dailyContainer);
    renderAlertCardDivergenceTablesFromCache(weeklyContainer);
}

export function setupLiveFeedDelegation(): void {
    const mainView = document.getElementById('view-live');
    if (!mainView) return;

    mainView.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const starBtn = target.closest('.fav-icon');
        
        if (starBtn) {
            e.stopPropagation();
            const id = (starBtn as HTMLElement).dataset.id;
            const source = (starBtn as HTMLElement).dataset.source === 'TV' ? 'TV' : 'DataAPI';
            if (id) {
                // Optimistic UI Update: Find ALL instances of this alert's star icon
                const allStars = document.querySelectorAll(`.fav-icon[data-id="${id}"][data-source="${source}"]`);
                const isCurrentlyFilled = starBtn.classList.contains('filled');
                
                allStars.forEach(star => {
                    const checkmark = star.querySelector('.check-mark') as HTMLElement;
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

                const togglePromise = source === 'DataAPI'
                    ? toggleDivergenceFavorite(Number(id))
                    : toggleFavorite(Number(id));

                togglePromise.then(updatedAlert => {
                    if (source === 'DataAPI') {
                        const allSignals = getDivergenceSignals();
                        const idx = allSignals.findIndex(a => a.id === updatedAlert.id);
                        if (idx !== -1) {
                            allSignals[idx].is_favorite = updatedAlert.is_favorite;
                            setDivergenceSignals(allSignals);
                        }
                    } else {
                        const allAlerts = getAlerts();
                        const idx = allAlerts.findIndex(a => a.id === updatedAlert.id);
                        if (idx !== -1) {
                            allAlerts[idx].is_favorite = updatedAlert.is_favorite;
                            setAlerts(allAlerts);
                        }
                    }

                    // Re-enforce visual state from server response
                    allStars.forEach(star => {
                        const checkmark = star.querySelector('.check-mark') as HTMLElement;
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
                    // Revert on failure
                    allStars.forEach(star => {
                        const checkmark = star.querySelector('.check-mark') as HTMLElement;
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
            return;
        }

        const card = target.closest('.alert-card');
        if (card) {
            const ticker = (card as HTMLElement).dataset.ticker;
            if (ticker && window.showTickerView) {
                window.showTickerView(ticker);
            }
        }
    });
}

export function setDailySort(mode: SortMode): void {
    dailySortMode = mode;
    const dailyHeader = document.querySelector('#dashboard-view .column:first-child .header-sort-controls');
    if (dailyHeader) {
        dailyHeader.querySelectorAll('.tf-btn').forEach(btn => {
            const el = btn as HTMLElement;
            if (el.dataset.sort === mode) el.classList.add('active');
            else el.classList.remove('active');
        });
    }
    renderOverview();
}

export function setWeeklySort(mode: SortMode): void {
    weeklySortMode = mode;
    const weeklyHeader = document.querySelector('#dashboard-view .column:last-child .header-sort-controls');
    if (weeklyHeader) {
        weeklyHeader.querySelectorAll('.tf-btn').forEach(btn => {
            const el = btn as HTMLElement;
            if (el.dataset.sort === mode) el.classList.add('active');
            else el.classList.remove('active');
        });
    }
    renderOverview();
}

import { getCurrentWeekISO, getCurrentMonthISO, getDateRangeForMode, createAlertSortFn, updateSortButtonUi } from './utils';
import { fetchAlertsFromApi, toggleFavorite } from './api';
import { toggleDivergenceFavorite } from './divergenceApi';
import { setAlerts, getAlerts } from './state';
import { getDivergenceSignals, setDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { LiveFeedMode, SortMode, Alert } from './types';

let liveFeedMode: LiveFeedMode = 'today';
let dailySortMode: SortMode = 'combo';
let weeklySortMode: SortMode = 'combo';
let dailySortDirection: 'asc' | 'desc' = 'desc';
let weeklySortDirection: 'asc' | 'desc' = 'desc';

// We need to declare the window Interface extension to avoid TS errors
declare global {
    interface Window {
        showTickerView: (ticker: string, sourceView?: 'live' | 'divergence', listContext?: 'daily' | 'weekly' | null) => void;
        showOverview: () => void;
        setDailySort: (mode: SortMode) => void;
        setWeeklySort: (mode: SortMode) => void;
        setTickerDailySort: (mode: SortMode) => void;
        setTickerWeeklySort: (mode: SortMode) => void;
        renderTickerView: (ticker: string, options?: { refreshCharts: boolean }) => void;
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

    daily.sort(createAlertSortFn(dailySortMode, dailySortDirection));
    weekly.sort(createAlertSortFn(weeklySortMode, weeklySortDirection));
    
    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    renderAlertCardDivergenceTablesFromCache(dailyContainer);
    renderAlertCardDivergenceTablesFromCache(weeklyContainer);

    // Sync UI state
    updateSortButtonUi('#dashboard-view .column:first-child .header-sort-controls', dailySortMode, dailySortDirection);
    updateSortButtonUi('#dashboard-view .column:last-child .header-sort-controls', weeklySortMode, weeklySortDirection);
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
                // Determine context
                let listContext: 'daily' | 'weekly' | null = null;
                if (card.closest('#daily-container')) {
                    listContext = 'daily';
                } else if (card.closest('#weekly-container')) {
                    listContext = 'weekly';
                }
                window.showTickerView(ticker, 'live', listContext);
            }
        }
    });

    // Timeframe Buttons
    const btnToday = document.getElementById('btn-t');
    const btnYesterday = document.getElementById('btn-y');
    const btn30 = document.getElementById('btn-30');
    const btn7 = document.getElementById('btn-7');
    const btnWeek = document.getElementById('btn-week');
    const btnMonth = document.getElementById('btn-month');

    btnToday?.addEventListener('click', () => setLiveFeedMode('today'));
    btnYesterday?.addEventListener('click', () => setLiveFeedMode('yesterday'));
    btn30?.addEventListener('click', () => setLiveFeedMode('30'));
    btn7?.addEventListener('click', () => setLiveFeedMode('7'));
    btnWeek?.addEventListener('click', () => setLiveFeedMode('week'));
    btnMonth?.addEventListener('click', () => setLiveFeedMode('month'));

    const inputWeek = document.getElementById('history-week');
    const inputMonth = document.getElementById('history-month');

    inputWeek?.addEventListener('change', () => fetchLiveAlerts(true).then(renderOverview));
    inputMonth?.addEventListener('change', () => fetchLiveAlerts(true).then(renderOverview));

    // Sort Buttons
    document.querySelectorAll('#dashboard-view .column:first-child .header-sort-controls .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setDailySort(mode);
        });
    });

    document.querySelectorAll('#dashboard-view .column:last-child .header-sort-controls .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setWeeklySort(mode);
        });
    });
}



export function setDailySort(mode: SortMode): void {
    if (mode === dailySortMode && mode !== 'favorite') {
        dailySortDirection = dailySortDirection === 'desc' ? 'asc' : 'desc';
    } else {
        dailySortMode = mode;
        dailySortDirection = 'desc';
    }
    updateSortButtonUi('#dashboard-view .column:first-child .header-sort-controls', dailySortMode, dailySortDirection);
    renderOverview();
}

export function setWeeklySort(mode: SortMode): void {
    if (mode === weeklySortMode && mode !== 'favorite') {
        weeklySortDirection = weeklySortDirection === 'desc' ? 'asc' : 'desc';
    } else {
        weeklySortMode = mode;
        weeklySortDirection = 'desc';
    }
    updateSortButtonUi('#dashboard-view .column:last-child .header-sort-controls', weeklySortMode, weeklySortDirection);
    renderOverview();
}

export function initializeSortDefaults(): void {
    dailySortMode = 'combo';
    dailySortDirection = 'desc';
    weeklySortMode = 'combo';
    weeklySortDirection = 'desc';
    updateSortButtonUi('#dashboard-view .column:first-child .header-sort-controls', dailySortMode, dailySortDirection);
    updateSortButtonUi('#dashboard-view .column:last-child .header-sort-controls', weeklySortMode, weeklySortDirection);
}


// ... existing code ...

export function setLiveFeedMode(mode: LiveFeedMode) {
    liveFeedMode = mode;
    
    const btnToday = document.getElementById('btn-t');
    const btnYesterday = document.getElementById('btn-y');
    const btn30 = document.getElementById('btn-30');
    const btn7 = document.getElementById('btn-7');
    const btnWeek = document.getElementById('btn-week');
    const btnMonth = document.getElementById('btn-month');
    
    const inputWeek = document.getElementById('history-week');
    const inputMonth = document.getElementById('history-month');

    // Reset all
    [btnToday, btnYesterday, btn30, btn7, btnWeek, btnMonth].forEach(b => b?.classList.remove('active'));
    inputWeek?.classList.add('hidden');
    inputMonth?.classList.add('hidden');

    if (mode === 'today') {
        btnToday?.classList.add('active');
    } else if (mode === 'yesterday') {
        btnYesterday?.classList.add('active');
    } else if (mode === '30') {
        btn30?.classList.add('active');
    } else if (mode === '7') {
        btn7?.classList.add('active');
    } else if (mode === 'week') {
        btnWeek?.classList.add('active');
        inputWeek?.classList.remove('hidden');
    } else if (mode === 'month') {
        btnMonth?.classList.add('active');
        inputMonth?.classList.remove('hidden');
    }

    fetchLiveAlerts(true).then(() => {
        const tickerView = document.getElementById('ticker-view');
        const ticker = tickerView?.dataset.ticker;
        if (ticker && !tickerView?.classList.contains('hidden') && window.renderTickerView) {
             window.renderTickerView(ticker, { refreshCharts: false });
        } else {
            renderOverview();
        }
    });
}

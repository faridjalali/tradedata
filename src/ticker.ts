import { getAlerts } from './state';
import { getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { SortMode } from './types';
import { createAlertSortFn } from './utils';
import { renderCustomChart } from './chart';

let tickerDailySortMode: SortMode = 'score';
let tickerWeeklySortMode: SortMode = 'score';

interface RenderTickerViewOptions {
    refreshCharts?: boolean;
}

export function setTickerDailySort(mode: SortMode): void {
    tickerDailySortMode = mode;
    updateSortButtons('.ticker-daily-sort', mode);
    const tickerContainer = document.getElementById('ticker-view');
    if (!tickerContainer) return;
    const currentTicker = tickerContainer.dataset.ticker;
    if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
}

export function setTickerWeeklySort(mode: SortMode): void {
    tickerWeeklySortMode = mode;
    updateSortButtons('.ticker-weekly-sort', mode);
    const tickerContainer = document.getElementById('ticker-view');
    if (!tickerContainer) return;
    const currentTicker = tickerContainer.dataset.ticker;
    if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
}

// Helper to update active class on buttons
function updateSortButtons(selector: string, mode: SortMode): void {
    document.querySelectorAll(`${selector} .tf-btn`).forEach(btn => {
        const el = btn as HTMLElement;
        el.classList.toggle('active', el.dataset.sort === mode);
    });
}

export function renderTickerView(ticker: string, options: RenderTickerViewOptions = {}): void {
    const refreshCharts = options.refreshCharts !== false;
    const allAlerts = [...getAlerts(), ...getDivergenceSignals()];
    primeDivergenceSummaryCacheFromAlerts(allAlerts);
    const alerts = allAlerts.filter(a => a.ticker === ticker);
    
    let daily = alerts.filter(a => (a.timeframe || '').trim() === '1d');
    let weekly = alerts.filter(a => (a.timeframe || '').trim() === '1w');

    if (tickerDailySortMode === 'favorite') {
        daily = daily.filter(a => a.is_favorite);
    }
    if (tickerWeeklySortMode === 'favorite') {
        weekly = weekly.filter(a => a.is_favorite);
    }

    daily.sort(createAlertSortFn(tickerDailySortMode === 'favorite' ? 'time' : tickerDailySortMode));
    weekly.sort(createAlertSortFn(tickerWeeklySortMode === 'favorite' ? 'time' : tickerWeeklySortMode));
    
    // renderAvg removed
    
    const dailyContainer = document.getElementById('ticker-daily-container');
    if (dailyContainer) {
        dailyContainer.innerHTML = daily.map(createAlertCard).join('');
        if (daily.length > 0) renderAlertCardDivergenceTablesFromCache(dailyContainer);
    }

    const weeklyContainer = document.getElementById('ticker-weekly-container');
    if (weeklyContainer) {
        weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
        if (weekly.length > 0) renderAlertCardDivergenceTablesFromCache(weeklyContainer);
    }

    if (refreshCharts) {
        renderCustomChart(ticker);
    }
}

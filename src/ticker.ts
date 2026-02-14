import { getAlerts } from './state';
import { getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { SortMode, Alert } from './types';
import { createAlertSortFn } from './utils';
import { renderCustomChart } from './chart';
import { getAppTimeZone } from './timezone';

// Declare TradingView and Chart.js globals
declare const TradingView: any;
declare const Chart: any;

let tickerDailySortMode: SortMode = 'time';
let tickerWeeklySortMode: SortMode = 'time';
let currentChartTicker: string | null = null;
let currentTradingViewTimeZone: string | null = null;

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
    
    const daily = alerts.filter(a => (a.timeframe || '').trim() === '1d');
    const weekly = alerts.filter(a => (a.timeframe || '').trim() === '1w');

    daily.sort(createAlertSortFn(tickerDailySortMode));
    weekly.sort(createAlertSortFn(tickerWeeklySortMode));
    
    // renderAvg removed
    
    const dailyContainer = document.getElementById('ticker-daily-container');
    if (dailyContainer) {
        if (daily.length === 0) {
            dailyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No daily alerts</div>';
        } else {
            dailyContainer.innerHTML = daily.map(createAlertCard).join('');
            renderAlertCardDivergenceTablesFromCache(dailyContainer);
        }
    }

    const weeklyContainer = document.getElementById('ticker-weekly-container');
    if (weeklyContainer) {
        if (weekly.length === 0) {
            weeklyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No weekly alerts</div>';
        } else {
            weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
            renderAlertCardDivergenceTablesFromCache(weeklyContainer);
        }
    }

    if (refreshCharts) {
        renderTradingViewChart(ticker);
        renderCustomChart(ticker);
    }
}


function renderTradingViewChart(ticker: string): void {
    if (typeof TradingView === 'undefined') return;
    const activeTimeZone = getAppTimeZone();
    if (currentChartTicker === ticker && currentTradingViewTimeZone === activeTimeZone) return; 

    currentChartTicker = ticker;
    currentTradingViewTimeZone = activeTimeZone;
    const container = document.getElementById('tradingview_chart');
    if (container) {
        container.innerHTML = '';
    }

    new TradingView.widget({
        "width": "100%",
        "height": 600,
        "symbol": ticker,
        "interval": "D",
        "timezone": activeTimeZone,
        "theme": "dark",
        "style": "1",
        "locale": "en",
        "toolbar_bg": "#f1f3f6",
        "enable_publishing": false,
        "allow_symbol_change": false,
        "studies": ["MASimple@tv-basicstudies"],
        "studies_overrides": {
            "moving average.length": 50,
            "moving average.source": "close",
            "moving average.plot.color": "#ff9800",
            "moving average.plot.linewidth": 2
        },
        "container_id": "tradingview_chart"
    });
}

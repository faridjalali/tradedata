import { getAlerts } from './state';
import { createAlertCard } from './components';
import { SortMode, Alert } from './types';

// Declare TradingView global
declare const TradingView: any;

let tickerDailySortMode: SortMode = 'time';
let tickerWeeklySortMode: SortMode = 'time';
let currentChartTicker: string | null = null;

export function setTickerDailySort(mode: SortMode): void {
    tickerDailySortMode = mode;
    updateSortButtons('.ticker-daily-sort', mode);
    const tickerContainer = document.getElementById('ticker-view');
    if (!tickerContainer) return;
    const currentTicker = tickerContainer.dataset.ticker;
    if (currentTicker) renderTickerView(currentTicker);
}

export function setTickerWeeklySort(mode: SortMode): void {
    tickerWeeklySortMode = mode;
    updateSortButtons('.ticker-weekly-sort', mode);
    const tickerContainer = document.getElementById('ticker-view');
    if (!tickerContainer) return;
    const currentTicker = tickerContainer.dataset.ticker;
    if (currentTicker) renderTickerView(currentTicker);
}

// Helper to update active class on buttons
function updateSortButtons(selector: string, mode: SortMode): void {
    document.querySelectorAll(`${selector} .tf-btn`).forEach(btn => {
        const el = btn as HTMLElement;
        el.classList.toggle('active', el.dataset.sort === mode);
    });
}

export function renderTickerView(ticker: string): void {
    const allAlerts = getAlerts();
    // Filter by ticker
    let alerts = allAlerts.filter(a => a.ticker === ticker);
    
    let daily = alerts.filter(a => (a.timeframe || '').trim() === '1d');
    let weekly = alerts.filter(a => (a.timeframe || '').trim() === '1w');
    
    // Sort Logic
    const getSortValue = (alert: Alert, mode: SortMode): number => {
        if (mode === 'volume') return alert.signal_volume || 0;
        if (mode === 'intensity') return alert.intensity_score || 0;
        if (mode === 'combo') return alert.combo_score || 0;
        // For favorite sort: primary logic is boolean (1 or 0), secondary is time
         if (mode === 'favorite') {
             // We can return 1 for fav, 0 for non-fav. 
             // But the main sort function below needs to handle the secondary sort (time) 
             // so here we just return the boolean value as a number.
             return (alert.is_favorite ? 1 : 0);
         }
        return alert.timestamp ? new Date(alert.timestamp).getTime() : 0;
    };

    const createSortFn = (mode: SortMode) => (a: Alert, b: Alert) => {
         if (mode === 'time') {
               return (b.timestamp || '').localeCompare(a.timestamp || '');
         }
         // Favorite sort needs special handling for secondary sort
         if (mode === 'favorite') {
             if (a.is_favorite === b.is_favorite) {
                  return (b.timestamp || '').localeCompare(a.timestamp || '');
             }
             return (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0);
         }

        const valA = getSortValue(a, mode);
        const valB = getSortValue(b, mode);
        return valB - valA;
    };

    daily.sort(createSortFn(tickerDailySortMode));
    weekly.sort(createSortFn(tickerWeeklySortMode));
    
    renderAvg('ticker-daily-avg', daily);
    renderAvg('ticker-weekly-avg', weekly);
    
    const dailyContainer = document.getElementById('ticker-daily-container');
    if (dailyContainer) {
        if (daily.length === 0) {
            dailyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No daily alerts</div>';
        } else {
            dailyContainer.innerHTML = daily.map(createAlertCard).join('');
        }
    }

    const weeklyContainer = document.getElementById('ticker-weekly-container');
    if (weeklyContainer) {
        if (weekly.length === 0) {
            weeklyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No weekly alerts</div>';
        } else {
            weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
        }
    }
    
    renderTradingViewChart(ticker);
}

function renderAvg(containerId: string, list: Alert[]): void {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    if (list.length === 0) {
        container.innerHTML = '';
        return;
    }

    let signedSum = 0;
    list.forEach(a => {
        const rawScore = a.combo_score || 0;
        const type = (a.signal_type || '').toLowerCase();
        const isBull = type.includes('bull');
        signedSum += isBull ? rawScore : -rawScore;
    });

    const signedAvg = Math.round(signedSum / list.length);
    const absAvg = Math.abs(signedAvg);
    const isPositive = signedAvg >= 0;

    const fillColor = isPositive ? '#3fb950' : '#f85149';
    const emptyColor = '#0d1117';
    
    const style = `background: conic-gradient(${fillColor} ${absAvg}%, ${emptyColor} 0%);`;
    
    container.innerHTML = `
        <div class="metric-item" title="Average Score: ${signedAvg}">
            <div class="score-circle" style="${style}"></div>
        </div>
    `;
}

function renderTradingViewChart(ticker: string): void {
    if (typeof TradingView === 'undefined') return;
    if (currentChartTicker === ticker) return; 

    currentChartTicker = ticker;

    new TradingView.widget({
        "width": "100%",
        "height": 600,
        "symbol": ticker,
        "interval": "D",
        "timezone": "Etc/UTC",
        "theme": "dark",
        "style": "1",
        "locale": "en",
        "toolbar_bg": "#f1f3f6",
        "enable_publishing": false,
        "allow_symbol_change": false,
        "container_id": "tradingview_chart",
        "studies": [
            {
                "id": "MASimple@tv-basicstudies",
                "inputs": {
                    "length": 50
                }
            }
        ]
    });
}

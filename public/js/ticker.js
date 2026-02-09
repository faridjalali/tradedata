// Ticker View Logic
import { getAlerts } from './state.js';
import { createAlertCard } from './components.js';

let tickerSortMode = 'time';
let currentChartTicker = null;

export function setTickerSort(mode) {
    tickerSortMode = mode;
    document.querySelectorAll('.history-controls .tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sort === mode);
    });
    const tickerContainer = document.getElementById('ticker-view');
    const currentTicker = tickerContainer.dataset.ticker;
    if (currentTicker) {
         renderTickerView(currentTicker);
    }
}

export function renderTickerView(ticker) {
    const allAlerts = getAlerts();
    // Filter by ticker
    let alerts = allAlerts.filter(a => a.ticker === ticker);
    
    let daily = alerts.filter(a => (a.timeframe || '').trim() === '1d');
    let weekly = alerts.filter(a => (a.timeframe || '').trim() === '1w');
    
    // Sort Logic
    const getSortValue = (alert, mode) => {
        if (mode === 'volume') return alert.signal_volume || 0;
        if (mode === 'intensity') return alert.intensity_score || 0;
        if (mode === 'combo') return alert.combo_score || 0;
        return new Date(alert.timestamp).getTime();
    };

    const sortFn = (a, b) => {
        const valA = getSortValue(a, tickerSortMode);
        const valB = getSortValue(b, tickerSortMode);
        return valB - valA;
    };

    daily.sort(sortFn);
    weekly.sort(sortFn);
    
    renderAvg('ticker-daily-avg', daily);
    renderAvg('ticker-weekly-avg', weekly);
    
    const dailyContainer = document.getElementById('ticker-daily-container');
    if (daily.length === 0) {
        dailyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No daily alerts</div>';
    } else {
        dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    }

    const weeklyContainer = document.getElementById('ticker-weekly-container');
    if (weekly.length === 0) {
        weeklyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No weekly alerts</div>';
    } else {
        weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    }
    
    renderTradingViewChart(ticker);
}

function renderAvg(containerId, list) {
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

function renderTradingViewChart(ticker) {
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

let allAlerts = [];
let chartInstance = null;
let currentView = 'live'; // 'live' or 'leaderboard'

// Helper to get current ISO week string (YYYY-Www)
function getCurrentWeekISO() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

// Helper to get current ISO month string (YYYY-MM)
function getCurrentMonthISO() {
    const d = new Date();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    return `${d.getFullYear()}-${month}`;
}

function getRelativeTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    
    // Reset hours to compare calendar days
    const d1 = new Date(date); d1.setHours(0,0,0,0);
    const d2 = new Date(now); d2.setHours(0,0,0,0);
    
    const diffTime = d2 - d1;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "1d ago";
    return `${diffDays}d ago`;
}

// Initialization
// Initialization
document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    document.getElementById('nav-live').addEventListener('click', () => switchView('live'));
    document.getElementById('nav-leaderboard').addEventListener('click', () => {
        switchView('leaderboard');
        fetchLeaderboardData(); // Fetch immediately on switch
    });

    // Inputs
    document.getElementById('reset-filter').addEventListener('click', showOverview);
    
    // Ticker View Back Button (local button removed, global reset-filter used)
    
    // Live Feed Controls
    document.getElementById('btn-30').addEventListener('click', () => setLiveFeedMode('30'));
    document.getElementById('btn-7').addEventListener('click', () => setLiveFeedMode('7'));
    document.getElementById('btn-week').addEventListener('click', () => setLiveFeedMode('week'));
    document.getElementById('btn-month').addEventListener('click', () => setLiveFeedMode('month'));
    
    // New Date Inputs
    const weekInput = document.getElementById('history-week');
    const monthInput = document.getElementById('history-month');

    // Ticker View Sort Buttons
    document.querySelectorAll('.history-controls .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => setTickerSort(btn.dataset.sort));
    });

    // Set defaults
    weekInput.value = getCurrentWeekISO();
    monthInput.value = getCurrentMonthISO();

    weekInput.addEventListener('change', () => fetchLiveAlerts(true));
    monthInput.addEventListener('change', () => fetchLiveAlerts(true));

    // Timeframe Buttons
    document.querySelectorAll('#leaderboard-controls .tf-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active from all
            document.querySelectorAll('#leaderboard-controls .tf-btn').forEach(b => b.classList.remove('active'));
            // Add active to clicked
            e.target.classList.add('active');
            // Fetch
            fetchLeaderboardData();
        });
    });

    // Initial Load
    // Initial Load
    setLiveFeedMode('30'); 
    
    setInterval(() => {
        // Only poll if "current" week/month is selected, not historical
        if (currentView === 'live' && isCurrentTimeframe()) fetchLiveAlerts();
    }, 10000); 
});

let liveFeedMode = '30'; // '30', '7', 'week', 'month'

function switchView(view) {
    currentView = view;
    // Update Tabs
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`nav-${view}`).classList.add('active');

    // Toggle Main Views
    if (view === 'live') {
        document.getElementById('view-live').classList.remove('hidden');
        document.getElementById('view-leaderboard').classList.add('hidden');
        document.getElementById('live-controls').classList.remove('hidden');
        document.getElementById('leaderboard-controls').classList.add('hidden');
    } else {
        document.getElementById('view-live').classList.add('hidden');
        document.getElementById('view-leaderboard').classList.remove('hidden');
        document.getElementById('live-controls').classList.add('hidden');
        document.getElementById('leaderboard-controls').classList.remove('hidden');
        // fetchLeaderboardData called in click listener, but good to ensure
    }
}

function setSortMode(mode) {
    // Deprecated global sort
}

function setLiveFeedMode(mode) {
    liveFeedMode = mode;
    
    const btn30 = document.getElementById('btn-30');
    const btn7 = document.getElementById('btn-7');
    const btnWeek = document.getElementById('btn-week');
    const btnMonth = document.getElementById('btn-month');
    
    const inputWeek = document.getElementById('history-week');
    const inputMonth = document.getElementById('history-month');

    // Reset all
    [btn30, btn7, btnWeek, btnMonth].forEach(b => b.classList.remove('active'));
    inputWeek.classList.add('hidden');
    inputMonth.classList.add('hidden');

    if (mode === '30') {
        btn30.classList.add('active');
    } else if (mode === '7') {
        btn7.classList.add('active');
    } else if (mode === 'week') {
        btnWeek.classList.add('active');
        inputWeek.classList.remove('hidden');
    } else if (mode === 'month') {
        btnMonth.classList.add('active');
        inputMonth.classList.remove('hidden');
    }

    fetchLiveAlerts(true);
}

function isCurrentTimeframe() {
    if (liveFeedMode === '30' || liveFeedMode === '7') return true; // Always current for rolling windows
    if (liveFeedMode === 'week') {
        const val = document.getElementById('history-week').value;
        return val === getCurrentWeekISO();
    } else {
        const val = document.getElementById('history-month').value;
        return val === getCurrentMonthISO();
    }
}

// --- LIVE FEED LOGIC ---
async function fetchLiveAlerts(force = false) {
    try {
        let url = '/api/alerts';
        
        if (liveFeedMode === '30') {
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - 30);
            
            endDate = end.toISOString();
            startDate = start.toISOString();
        } else if (liveFeedMode === '7') {
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - 7);
            
            endDate = end.toISOString();
            startDate = start.toISOString();
        } else if (liveFeedMode === 'week') {
            const val = document.getElementById('history-week').value;
            // val is "YYYY-Www"
            if (!val) return; 

            // Calculate start of week (Monday) from ISO string
            // Simple Parse:
            const [yearStr, weekStr] = val.split('-W');
            const year = parseInt(yearStr);
            const week = parseInt(weekStr);

            // 1. Get Jan 4th of year (always in week 1)
            const d = new Date(year, 0, 4);
            // 2. Adjust to Monday of Week 1
            const dayShift = d.getDay() === 0 ? 6 : d.getDay() - 1;
            const week1Monday = new Date(d.setDate(d.getDate() - dayShift));
            
            // 3. Add (week - 1) weeks
            const monday = new Date(week1Monday.setDate(week1Monday.getDate() + (week - 1) * 7));
            monday.setHours(0,0,0,0);
            
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            sunday.setHours(23,59,59,999);

            startDate = monday.toISOString();
            endDate = sunday.toISOString();

        } else {
            // Month
            const val = document.getElementById('history-month').value;
            // val is "YYYY-MM"
            if (!val) return;

            const [year, month] = val.split('-').map(Number);
            // month is 1-12, Date takes 0-11
            const start = new Date(year, month - 1, 1);
            const end = new Date(year, month, 0); // Last day of month
            end.setHours(23,59,59,999);

            startDate = start.toISOString();
            endDate = end.toISOString();
        }
        
        url += `?start_date=${startDate}&end_date=${endDate}`;

        const response = await fetch(url);
        const data = await response.json();
        
        allAlerts = data; // Always replace on filter
        
        const currentTicker = document.getElementById('ticker-view').dataset.ticker;
        if (currentTicker && !document.getElementById('ticker-view').classList.contains('hidden')) {
            renderTickerView(currentTicker);
        } else {
            renderOverview();
        }
    } catch (error) {
        console.error('Error fetching live alerts:', error);
    }
}

// Sort States (Independent)
let dailySortMode = 'time';
let weeklySortMode = 'time';

// Global setters for onclick in HTML
window.setDailySort = function(mode) {
    dailySortMode = mode;
    updateSortIcons('daily', mode);
    renderOverview();
}

window.setWeeklySort = function(mode) {
    weeklySortMode = mode;
    updateSortIcons('weekly', mode);
    renderOverview();
}

let tickerSortMode = 'time';
function setTickerSort(mode) {
    tickerSortMode = mode;
    document.querySelectorAll('.history-controls .tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sort === mode);
    });
    const currentTicker = document.getElementById('ticker-view').dataset.ticker;
    if (currentTicker) {
         renderTickerView(currentTicker);
    }
}


function updateSortIcons(context, mode) {
    // Find buttons in the specific column header context
    // This assumes specific button structure or re-render. 
    // Simplified: Just toggle active classes based on hardcoded knowledge or pass ID logic?
    // Since we used onclick in HTML, lets use selectors.
    
    // Actually, simpler to just re-query all buttons in render or handle explicitly.
    // Let's create a helper that finds the button group in the respective column.
    
    // Hacky but effective for this simple static HTML:
    const colIndex = context === 'daily' ? 0 : 1;
    const container = document.querySelectorAll('.column-header')[colIndex];
    if (!container) return;
    
    const buttons = container.querySelectorAll('.icon-btn');
    // 0 is time, 1 is ticker
    if (mode === 'time') {
        buttons[0].classList.add('active');
        buttons[1].classList.remove('active');
    } else {
        buttons[0].classList.remove('active');
        buttons[1].classList.add('active');
    }
}

function renderOverview() {
    document.getElementById('ticker-view').classList.add('hidden');
    document.getElementById('dashboard-view').classList.remove('hidden');
    document.getElementById('reset-filter').classList.add('hidden');
    
    const dailyContainer = document.getElementById('daily-container');
    const weeklyContainer = document.getElementById('weekly-container');
    
    // Strict 1d/1w filters as requested
    let daily = allAlerts.filter(a => (a.timeframe || '').trim() === '1d');
    let weekly = allAlerts.filter(a => (a.timeframe || '').trim() === '1w');
    
    // Sort Helper
    const applySort = (list, mode) => {
        list.sort((a, b) => {
            if (mode === 'time') {
                return new Date(b.timestamp) - new Date(a.timestamp);
            } else {
                return a.ticker.localeCompare(b.ticker);
            }
        });
    };

    applySort(daily, dailySortMode);
    applySort(weekly, weeklySortMode);
    
    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    
    // IMPORTANT: Re-attach click listeners because we just wiped the HTML
    // The previous implementation had a bug where leaderboard clicks might not work if 'showTickerView' relied on scope.
    // But here for live feed cards:
    attachClickHandlers();
}

function formatVolume(vol) {
    if (!vol) return '0';
    if (vol >= 1000) return (vol / 1000).toFixed(1) + 'K';
    return vol.toString();
}

function createAlertCard(alert) {
    const timeStr = getRelativeTime(alert.timestamp);
    
    // Parse direction from signal_direction property if available
    // Default to strict 'bull' check if legacy
    let isBull = false;
    let isBear = false;

    if (alert.signal_direction !== undefined && alert.signal_direction !== null) {
        const dir = parseInt(alert.signal_direction);
        isBull = dir === 1;
        isBear = dir === -1;
    } else {
        // Fallback to text check
        isBull = alert.signal_type && alert.signal_type.toLowerCase().includes('bull');
        isBear = !isBull;
    }

    const cardClass = isBull ? 'bullish-card' : (isBear ? 'bearish-card' : '');
    
    // Formatting
    const volStr = formatVolume(alert.signal_volume || 0);
    const intScore = alert.intensity_score || 0;
    const cmbScore = alert.combo_score || 0;

    // Color Logic: Bullish = Green (#3fb950), Bearish = Red (#f85149)
    // Unfilled part = Black (#000000) or very dark gray (#0d1117)
    const fillColor = isBull ? '#3fb950' : '#f85149';
    const emptyColor = '#0d1117'; // Matches bg-color var

    // Conic gradient syntax: color percentage, emptyColor 0
    // We treat scores as simple 0-100 percentages.
    const intStyle = `background: conic-gradient(${fillColor} ${intScore}%, ${emptyColor} 0%);`;
    const cmbStyle = `background: conic-gradient(${fillColor} ${cmbScore}%, ${emptyColor} 0%);`;

    // Tooltip Labels
    const intLabel = `Intensity: ${intScore}`;
    const cmbLabel = `Combo: ${cmbScore}`;

    return `
        <div class="alert-card ${cardClass}" data-ticker="${alert.ticker}">
            <h3>${alert.ticker}</h3>
            
            <div class="metrics-container">
                <!-- Intensity Score Circle -->
                <div class="metric-item" title="${intLabel}">
                    <div class="score-circle" style="${intStyle}"></div>
                </div>
                <!-- Combo Score Circle -->
                <div class="metric-item" title="${cmbLabel}">
                    <div class="score-circle" style="${cmbStyle}"></div>
                </div>
                <div class="metric-item" title="Signal Volume">
                    <span class="volume-text">${volStr}</span>
                </div>
            </div>

            <span class="alert-time">${timeStr}</span>
        </div>
    `;
}

function attachClickHandlers() {
    document.querySelectorAll('.alert-card').forEach(card => {
        card.addEventListener('click', () => {
            const ticker = card.dataset.ticker;
            showTickerView(ticker);
        });
    });
}

window.showTickerView = function(ticker) {
    if (currentView !== 'live') {
        switchView('live');
    }
    document.getElementById('ticker-view').dataset.ticker = ticker;
    document.getElementById('reset-filter').classList.remove('hidden');
    document.getElementById('dashboard-view').classList.add('hidden');
    document.getElementById('ticker-view').classList.remove('hidden');
    renderTickerView(ticker);
}

function showOverview() {
    delete document.getElementById('ticker-view').dataset.ticker;
    renderOverview();
}

function renderTickerView(ticker) {
    // Filter by ticker
    let alerts = allAlerts.filter(a => a.ticker === ticker);
    
    // Strict 1d/1w filters
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
        // All sorts are descending
        return valB - valA;
    };

    daily.sort(sortFn);
    weekly.sort(sortFn);
    
    // Helper to render average score circle
    const renderAvg = (containerId, list) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        if (list.length === 0) {
            container.innerHTML = '';
            return;
        }

        const totalScore = list.reduce((sum, a) => sum + (a.combo_score || 0), 0);
        const avgScore = Math.round(totalScore / list.length);
        
        // Determine majority direction for color
        let bulls = 0; 
        let bears = 0;
        list.forEach(a => {
           // Reuse logic from createAlertCard or simpler check
           const type = (a.signal_type || '').toLowerCase();
           if (type.includes('bull')) bulls++;
           else bears++;
        });
        
        const isBull = bulls >= bears; // Tie goes to bull? or neutral. Let's stick to binary for now.
        const fillColor = isBull ? '#3fb950' : '#f85149';
        const emptyColor = '#0d1117';
        const style = `background: conic-gradient(${fillColor} ${avgScore}%, ${emptyColor} 0%);`;
        
        container.innerHTML = `
            <div class="metric-item" title="Average Score: ${avgScore}">
                <div class="score-circle" style="${style}"></div>
            </div>
        `;
    };

    renderAvg('ticker-daily-avg', daily);
    renderAvg('ticker-weekly-avg', weekly);
    
    // Render Daily Column
    const dailyContainer = document.getElementById('ticker-daily-container');
    if (daily.length === 0) {
        dailyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No daily alerts</div>';
    } else {
        dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    }

    // Render Weekly Column
    const weeklyContainer = document.getElementById('ticker-weekly-container');
    if (weekly.length === 0) {
        weeklyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-secondary)">No weekly alerts</div>';
    } else {
        weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    }
    
    // Render TradingView Chart
    renderTradingViewChart(ticker);
}

let currentChartTicker = null;

function renderTradingViewChart(ticker) {
    if (typeof TradingView === 'undefined') return;
    if (currentChartTicker === ticker) return; // Prevent refresh if same ticker

    currentChartTicker = ticker;

    // Clear previous if needed, but TV library usually handles container replacement
    const tvWidget = new TradingView.widget({
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
        "disabled_features": ["use_localstorage_for_settings"],
        "studies": [
            {
                "id": "MASimple@tv-basicstudies",
                "inputs": {
                    "length": 50
                }
            }
        ],
        "overrides": {
            "paneProperties.background": "#161b22",
            "paneProperties.backgroundType": "solid",
            "paneProperties.vertGridProperties.color": "#161b22",
            "paneProperties.horzGridProperties.color": "#161b22",
            "paneProperties.vertGridProperties.style": 0,
            "paneProperties.horzGridProperties.style": 0,
            "scalesProperties.lineColor": "#161b22",
            "scalesProperties.backgroundColor": "#161b22"
        }
    });

    tvWidget.onChartReady(function() {
        tvWidget.applyOverrides({
            "paneProperties.background": "#161b22",
            "paneProperties.backgroundType": "solid",
            "paneProperties.vertGridProperties.color": "#161b22",
            "paneProperties.horzGridProperties.color": "#161b22",
            "scalesProperties.lineColor": "#161b22"
        });
    });
}

// Chart removed as per request

// --- LEADERBOARD LOGIC ---
async function fetchLeaderboardData() {
    const activeBtn = document.querySelector('.tf-btn.active');
    const days = activeBtn ? activeBtn.dataset.days : 30;
    
    try {
        const response = await fetch(`/api/alerts?days=${days}`);
        const data = await response.json();
        calculateAndRenderLeaderboard(data);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
    }
}

function calculateAndRenderLeaderboard(data) {
    // Ticker -> { dailyBull: 0, dailyBear: 0, weeklyBull: 0, weeklyBear: 0 }
    const stats = {};

    data.forEach(a => {
        if (!stats[a.ticker]) stats[a.ticker] = { dailyBull: 0, dailyBear: 0, weeklyBull: 0, weeklyBear: 0 };
        const isBull = a.signal_type.toLowerCase().includes('bull');
        const isWeekly = a.timeframe === '1w';
        
        if (isWeekly) {
            if (isBull) stats[a.ticker].weeklyBull++;
            else stats[a.ticker].weeklyBear++;
        } else {
            if (isBull) stats[a.ticker].dailyBull++;
            else stats[a.ticker].dailyBear++;
        }
    });

    const tickers = Object.keys(stats);

    // Helper to sort and slice
    const getTop = (key) => {
        return tickers
            .map(t => ({ ticker: t, count: stats[t][key] }))
            .filter(x => x.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
    };

    renderTable('lb-daily-bull', getTop('dailyBull'));
    renderTable('lb-daily-bear', getTop('dailyBear'));
    renderTable('lb-weekly-bull', getTop('weeklyBull'));
    renderTable('lb-weekly-bear', getTop('weeklyBear'));
}

function renderTable(elementId, items) {
    const table = document.getElementById(elementId);
    if (items.length === 0) {
        table.innerHTML = '<tr><td colspan="2" style="text-align:center; color:#8b949e">No signals found</td></tr>';
        return;
    }
    table.innerHTML = `
        <tbody>
            ${items.map(item => `
                <tr class="clickable-row" onclick="showTickerView('${item.ticker}')">
                    <td>${item.ticker}</td>
                    <td>${item.count}</td>
                </tr>
            `).join('')}
        </tbody>
    `;
}

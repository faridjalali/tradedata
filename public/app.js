let allAlerts = [];
let chartInstance = null;
let currentView = 'live'; // 'live' or 'leaderboard'

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
    
    // Live Feed Controls
    document.getElementById('btn-week').addEventListener('click', () => setLiveFeedMode('week'));
    document.getElementById('btn-month').addEventListener('click', () => setLiveFeedMode('month'));
    document.getElementById('history-date').addEventListener('change', () => fetchLiveAlerts(true)); // Pass true to indicate custom date

    // Sorting Controls
    document.getElementById('sort-time').addEventListener('click', () => setSortMode('time'));
    document.getElementById('sort-ticker').addEventListener('click', () => setSortMode('ticker'));

    // Timeframe Buttons
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Remove active from all
            document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
            // Add active to clicked
            e.target.classList.add('active');
            // Fetch
            fetchLeaderboardData();
        });
    });

    // Initial Load - Set Today's date in picker but load week default
    document.getElementById('history-date').valueAsDate = new Date();
    setLiveFeedMode('week'); 
    
    setInterval(() => {
        // Only poll if "current" week/month is selected, not historical
        if (currentView === 'live' && isCurrentTimeframe()) fetchLiveAlerts();
    }, 10000); 
});

let liveFeedMode = 'week'; // 'week' or 'month'
let currentSortMode = 'time'; // 'time' or 'ticker'

function setSortMode(mode) {
    currentSortMode = mode;
    document.getElementById('sort-time').classList.toggle('active', mode === 'time');
    document.getElementById('sort-ticker').classList.toggle('active', mode === 'ticker');
    renderOverview(); // Re-render with new sort
}

function setLiveFeedMode(mode) {
    liveFeedMode = mode;
    document.getElementById('btn-week').classList.toggle('active', mode === 'week');
    document.getElementById('btn-month').classList.toggle('active', mode === 'month');
    fetchLiveAlerts(true);
}

function isCurrentTimeframe() {
    const pickerDate = new Date(document.getElementById('history-date').value);
    const today = new Date();
    return pickerDate.toDateString() === today.toDateString();
}

// --- LIVE FEED LOGIC ---
async function fetchLiveAlerts(force = false) {
    try {
        let url = '/api/alerts';
        
        // Calculate Date Range based on Picker + Mode
        const selectedDate = new Date(document.getElementById('history-date').value);
        let startDate, endDate;

        if (liveFeedMode === 'week') {
            // Find Monday of that week
            const day = selectedDate.getDay();
            const diff = selectedDate.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
            const monday = new Date(selectedDate.setDate(diff));
            monday.setHours(0,0,0,0);
            
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            sunday.setHours(23,59,59,999);
            
            startDate = monday.toISOString();
            endDate = sunday.toISOString();
        } else {
            // Month
            startDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1).toISOString();
            endDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0, 23, 59, 59).toISOString();
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

function renderOverview() {
    document.getElementById('ticker-view').classList.add('hidden');
    document.getElementById('dashboard-view').classList.remove('hidden');
    document.getElementById('reset-filter').classList.add('hidden');
    
    const dailyContainer = document.getElementById('daily-container');
    const weeklyContainer = document.getElementById('weekly-container');
    
    let daily = allAlerts.filter(a => !a.timeframe || a.timeframe.toLowerCase() === 'daily');
    let weekly = allAlerts.filter(a => a.timeframe && a.timeframe.toLowerCase() === 'weekly');
    
    // Sort logic
    const sortFn = (a, b) => {
        if (currentSortMode === 'time') {
            return new Date(b.timestamp) - new Date(a.timestamp); // Newest first
        } else {
            return a.ticker.localeCompare(b.ticker); // A-Z
        }
    };

    daily.sort(sortFn);
    weekly.sort(sortFn);
    
    document.getElementById('daily-count').textContent = daily.length;
    document.getElementById('weekly-count').textContent = weekly.length;
    
    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    
    attachClickHandlers();
}

function createAlertCard(alert) {
    const date = new Date(alert.timestamp).toLocaleString();
    const signalClass = alert.signal_type.toLowerCase().includes('bull') ? 'bullish' : 'bearish';
    
    return `
        <div class="alert-card" data-ticker="${alert.ticker}">
            <div class="alert-info">
                <h3>${alert.ticker}</h3>
                <div class="alert-meta">
                    <span class="price">$${alert.price}</span> | <sub>${date}</sub>
                </div>
            </div>
            <div class="signal-pill ${signalClass}">
                ${alert.signal_type}
            </div>
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

function showTickerView(ticker) {
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
    const alerts = allAlerts.filter(a => a.ticker === ticker);
    alerts.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    document.getElementById('stat-ticker').textContent = ticker;
    document.getElementById('stat-bullish').textContent = alerts.filter(a => a.signal_type.toLowerCase().includes('bull')).length;
    document.getElementById('stat-bearish').textContent = alerts.filter(a => a.signal_type.toLowerCase().includes('bear')).length;
    
    renderChart(ticker, alerts);
}

function renderChart(ticker, alerts) {
    const ctx = document.getElementById('priceChart').getContext('2d');
    const labels = alerts.map(a => new Date(a.timestamp).toLocaleDateString());
    const bgColors = alerts.map(a => a.signal_type.includes('bull') ? '#3fb950' : '#f85149');

    if (chartInstance) chartInstance.destroy();

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: `${ticker} Price Alerts`,
                data: alerts.map(a => a.price),
                borderColor: '#58a6ff',
                backgroundColor: 'rgba(88, 166, 255, 0.1)',
                pointBackgroundColor: bgColors,
                pointRadius: 6,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { grid: { color: '#30363d' }, ticks: { color: '#8b949e' } },
                x: { grid: { display: false }, ticks: { color: '#8b949e' } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

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
        const isWeekly = a.timeframe && a.timeframe.toLowerCase() === 'weekly';
        
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

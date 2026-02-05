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

    // Initial Load
    fetchLiveAlerts();
    setInterval(() => {
        if (currentView === 'live') fetchLiveAlerts();
    }, 10000); // Only poll if looking at live feed
});

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
        fetchLeaderboardData(); // Ensure fresh data
    }
}

// --- LIVE FEED LOGIC ---
async function fetchLiveAlerts() {
    try {
        const response = await fetch('/api/alerts'); // Default fetch (limit 100)
        const data = await response.json();
        
        if (JSON.stringify(data) !== JSON.stringify(allAlerts)) {
            allAlerts = data;
            const currentTicker = document.getElementById('ticker-view').dataset.ticker;
            if (currentTicker) {
                renderTickerView(currentTicker);
            } else {
                renderOverview();
            }
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
    
    const daily = allAlerts.filter(a => !a.timeframe || a.timeframe.toLowerCase() === 'daily');
    const weekly = allAlerts.filter(a => a.timeframe && a.timeframe.toLowerCase() === 'weekly');
    
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
        <thead><tr><th>Ticker</th><th>Signals</th></tr></thead>
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

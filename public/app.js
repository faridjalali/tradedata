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
    
    // Live Feed Controls
    document.getElementById('btn-week').addEventListener('click', () => setLiveFeedMode('week'));
    document.getElementById('btn-month').addEventListener('click', () => setLiveFeedMode('month'));
    
    // New Date Inputs
    const weekInput = document.getElementById('history-week');
    const monthInput = document.getElementById('history-month');

    // Set defaults
    weekInput.value = getCurrentWeekISO();
    monthInput.value = getCurrentMonthISO();

    weekInput.addEventListener('change', () => fetchLiveAlerts(true));
    monthInput.addEventListener('change', () => fetchLiveAlerts(true));

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
    setLiveFeedMode('week'); 
    
    setInterval(() => {
        // Only poll if "current" week/month is selected, not historical
        if (currentView === 'live' && isCurrentTimeframe()) fetchLiveAlerts();
    }, 10000); 
});

let liveFeedMode = 'week'; // 'week' or 'month'

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
    
    const btnWeek = document.getElementById('btn-week');
    const btnMonth = document.getElementById('btn-month');
    const inputWeek = document.getElementById('history-week');
    const inputMonth = document.getElementById('history-month');

    if (mode === 'week') {
        btnWeek.classList.add('active');
        btnMonth.classList.remove('active');
        inputWeek.classList.remove('hidden');
        inputMonth.classList.add('hidden');
    } else {
        btnWeek.classList.remove('active');
        btnMonth.classList.add('active');
        inputWeek.classList.add('hidden');
        inputMonth.classList.remove('hidden');
    }

    fetchLiveAlerts(true);
}

function isCurrentTimeframe() {
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
        
        if (liveFeedMode === 'week') {
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
    
    let daily = allAlerts.filter(a => !a.timeframe || a.timeframe.toLowerCase() === 'daily');
    let weekly = allAlerts.filter(a => a.timeframe && a.timeframe.toLowerCase() === 'weekly');
    
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

function createAlertCard(alert) {
    const date = new Date(alert.timestamp).toLocaleString();
    const signalClass = alert.signal_type.toLowerCase().includes('bull') ? 'bullish' : 'bearish';
    
    return `
        <div class="alert-card" data-ticker="${alert.ticker}">
            <div class="alert-info">
                <h3>${alert.ticker}</h3>
                <div class="alert-meta">
                    <span class="price">$${alert.price}</span>
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

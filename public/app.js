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

// ... (rest of the file remains unchanged until fetchLeaderboardData) ...

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
                <tr>
                    <td>${item.ticker}</td>
                    <td>${item.count}</td>
                </tr>
            `).join('')}
        </tbody>
    `;
}

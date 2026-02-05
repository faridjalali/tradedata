let allAlerts = [];
let chartInstance = null;

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    fetchAlerts();
    // Poll every 10 seconds
    setInterval(fetchAlerts, 10000);
    
    document.getElementById('reset-filter').addEventListener('click', () => {
        showOverview();
    });
});

async function fetchAlerts() {
    try {
        const response = await fetch('/api/alerts');
        const data = await response.json();
        
        // Detect if new data arrived by comparing lengths or IDs (simple check)
        if (JSON.stringify(data) !== JSON.stringify(allAlerts)) {
            allAlerts = data;
            
            // If we are in "Ticker View" (filtered), we refresh that view, else Overview
            const currentTicker = document.getElementById('ticker-view').dataset.ticker;
            if (currentTicker) {
                renderTickerView(currentTicker);
            } else {
                renderOverview();
            }
        }
    } catch (error) {
        console.error('Error fetching alerts:', error);
    }
}

function renderOverview() {
    document.getElementById('ticker-view').classList.add('hidden');
    document.getElementById('dashboard-view').classList.remove('hidden');
    document.getElementById('reset-filter').classList.add('hidden');
    
    const dailyContainer = document.getElementById('daily-container');
    const weeklyContainer = document.getElementById('weekly-container');
    
    // Filter buckets
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
    // Filter alerts for this ticker
    const alerts = allAlerts.filter(a => a.ticker === ticker);
    alerts.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // Oldest to newest for chart
    
    // Update Stats
    document.getElementById('stat-ticker').textContent = ticker;
    document.getElementById('stat-bullish').textContent = alerts.filter(a => a.signal_type.toLowerCase().includes('bull')).length;
    document.getElementById('stat-bearish').textContent = alerts.filter(a => a.signal_type.toLowerCase().includes('bear')).length;
    
    // Render Chart
    renderChart(ticker, alerts);
}

function renderChart(ticker, alerts) {
    const ctx = document.getElementById('priceChart').getContext('2d');
    
    // Prepare data
    const labels = alerts.map(a => new Date(a.timestamp).toLocaleDateString());
    const dataPoints = alerts.map(a => ({
        x: a.timestamp, // uses time scale if advanced, but simple index for now
        y: a.price,
        signal: a.signal_type
    }));
    
    const bgColors = alerts.map(a => a.signal_type.includes('bull') ? '#3fb950' : '#f85149');

    if (chartInstance) {
        chartInstance.destroy();
    }

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
                pointHoverRadius: 8,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    grid: { color: '#30363d' },
                    ticks: { color: '#8b949e' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#8b949e' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const idx = context.dataIndex;
                            return `${alerts[idx].signal_type.toUpperCase()} @ $${context.raw}`;
                        }
                    }
                }
            }
        }
    });
}

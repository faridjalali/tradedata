async function fetchAlerts() {
    try {
        const response = await fetch('/api/alerts');
        const alerts = await response.json();
        renderAlerts(alerts);
    } catch (error) {
        console.error('Error fetching alerts:', error);
        document.getElementById('alerts-container').innerHTML = '<div class="loading">Error loading alerts. Please try again later.</div>';
    }
}

function renderAlerts(alerts) {
    const container = document.getElementById('alerts-container');
    
    if (alerts.length === 0) {
        container.innerHTML = '<div class="loading">No alerts received yet. Configure TradingView to send signals!</div>';
        return;
    }

    container.innerHTML = alerts.map(alert => {
        const date = new Date(alert.timestamp).toLocaleString();
        const signalClass = alert.signal_type.toLowerCase().includes('bull') ? 'bullish' : 'bearish';
        
        return `
            <div class="alert-card">
                <div class="alert-info">
                    <h2>${alert.ticker}</h2>
                    <div class="alert-meta">
                        <span class="price">$${alert.price}</span> | <sub>${date}</sub>
                    </div>
                    ${alert.message ? `<div style="margin-top:5px; font-size:0.85em; color:#8b949e">${alert.message}</div>` : ''}
                </div>
                <div class="signal-badge ${signalClass}">
                    ${alert.signal_type}
                </div>
            </div>
        `;
    }).join('');
}

// Fetch immediately
fetchAlerts();

// Poll every 30 seconds
setInterval(fetchAlerts, 30000);

import { getAlerts } from './state';
import { createAlertCard } from './components';
import { SortMode, Alert } from './types';
import { createAlertSortFn } from './utils';

// Declare TradingView and Chart.js globals
declare const TradingView: any;
declare const Chart: any;

let tickerDailySortMode: SortMode = 'time';
let tickerWeeklySortMode: SortMode = 'time';
let currentChartTicker: string | null = null;
let currentGexTicker: string | null = null;
let gexChartInstance: any = null;

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
    const alerts = allAlerts.filter(a => a.ticker === ticker);
    
    const daily = alerts.filter(a => (a.timeframe || '').trim() === '1d');
    const weekly = alerts.filter(a => (a.timeframe || '').trim() === '1w');

    daily.sort(createAlertSortFn(tickerDailySortMode));
    weekly.sort(createAlertSortFn(tickerWeeklySortMode));
    
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
    // renderGexChart(ticker); // Hidden until API upgrade
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

async function renderGexChart(ticker: string): Promise<void> {
    if (currentGexTicker === ticker) return;
    currentGexTicker = ticker;

    const container = document.getElementById('gex-chart-container');
    const loading = document.getElementById('gex-loading');
    const errorEl = document.getElementById('gex-error');
    const totalEl = document.getElementById('gex-total');
    const canvas = document.getElementById('gex-chart') as HTMLCanvasElement;

    if (!container || !canvas) return;

    // Show container and loading state
    container.style.display = 'block';
    if (loading) loading.style.display = 'block';
    if (errorEl) errorEl.style.display = 'none';
    canvas.style.display = 'none';

    // Destroy previous chart
    if (gexChartInstance) {
        gexChartInstance.destroy();
        gexChartInstance = null;
    }

    try {
        const res = await fetch(`/api/gex/${ticker}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Failed to fetch GEX data' }));
            throw new Error(err.error || 'Server error');
        }

        const data = await res.json();
        
        if (loading) loading.style.display = 'none';

        if (!data.strikes || data.strikes.length === 0) {
            if (errorEl) {
                errorEl.textContent = 'No options data available for this ticker';
                errorEl.style.display = 'block';
            }
            return;
        }

        // Show canvas
        canvas.style.display = 'block';

        // Adjust canvas height based on number of strikes
        const chartHeight = Math.max(400, data.strikes.length * 22);
        const wrapper = canvas.parentElement;
        if (wrapper) wrapper.style.height = chartHeight + 'px';

        // Reverse data for display (Highest strike at top)
        data.strikes.reverse();
        data.gex.reverse();

        // Format total net gamma
        if (totalEl) {
            const totalFormatted = formatGamma(data.total_gex);
            const totalColor = data.total_gex >= 0 ? '#00E396' : '#FF4560';
            totalEl.innerHTML = `Net Gamma: <span style="color:${totalColor};font-weight:600">${totalFormatted}</span>`;
        }

        // Find spot price index for annotation
        const spotPrice = data.spot_price;
        let spotIndex = 0;
        let minDiff = Infinity;
        for (let i = 0; i < data.strikes.length; i++) {
            const diff = Math.abs(data.strikes[i] - spotPrice);
            if (diff < minDiff) {
                minDiff = diff;
                spotIndex = i;
            }
        }

        // Pink/magenta bars like Unusual Whales
        const barColors = data.gex.map((v: number) =>
            v >= 0 ? 'rgba(235, 87, 130, 0.85)' : 'rgba(235, 87, 130, 0.55)');

        // Create horizontal bar chart
        const ctx = canvas.getContext('2d');
        gexChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.strikes.map((s: number) => s.toFixed(2)),
                datasets: [{
                    label: 'Net Gamma',
                    data: data.gex,
                    backgroundColor: barColors,
                    borderColor: 'rgba(235, 87, 130, 1)',
                    borderWidth: 0.5,
                    borderRadius: 1,
                    borderSkipped: false,
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items: any[]) => `Strike: $${items[0].label}`,
                            label: (item: any) => `Net Gamma: ${formatGamma(item.raw)}`,
                        },
                        backgroundColor: '#21262d',
                        borderColor: '#30363d',
                        borderWidth: 1,
                        titleColor: '#e6edf3',
                        bodyColor: '#8b949e',
                    },
                    annotation: {
                        annotations: {
                            spotLine: {
                                type: 'line',
                                yMin: spotIndex,
                                yMax: spotIndex,
                                borderColor: '#f0f6fc',
                                borderWidth: 2,
                                borderDash: [5, 3],
                                label: {
                                    display: true,
                                    content: `Spot: $${spotPrice.toFixed(2)}`,
                                    position: 'end',
                                    backgroundColor: '#30363d',
                                    color: '#f0f6fc',
                                    font: { size: 11 },
                                    padding: 4,
                                }
                            }
                        }
                    }
                },

                scales: {
                    x: {
                        position: 'bottom',
                        title: {
                            display: true,
                            text: 'Gamma',
                            color: '#8b949e',
                            font: { size: 12 },
                        },
                        ticks: {
                            color: '#8b949e',
                            font: { size: 10 },
                            callback: (value: number) => formatGamma(value),
                        },
                        grid: { color: 'rgba(48, 54, 61, 0.3)' },
                    },
                    y: {
                        ticks: {
                            color: '#8b949e',
                            font: { size: 10 },
                        },
                        grid: { display: false },
                    }
                }
            }
        });

    } catch (err: any) {
        if (loading) loading.style.display = 'none';
        if (errorEl) {
            errorEl.textContent = err.message || 'Failed to load GEX data';
            errorEl.style.display = 'block';
        }
    }
}

function formatGamma(value: number): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
    return sign + abs.toFixed(0);
}



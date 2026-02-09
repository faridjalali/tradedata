import { getCurrentWeekISO, getCurrentMonthISO } from './utils';
import { 
    fetchLiveAlerts, 
    renderOverview, 
    setLiveFeedModeState, 
    isCurrentTimeframe,
    setDailySort,
    setWeeklySort
} from './liveFeed';
import { fetchLeaderboardData } from './leaderboard';
import { renderTickerView, setTickerSort } from './ticker';
import { SortMode, LiveFeedMode } from './types';

let currentView: 'live' | 'leaderboard' = 'live'; 

// Expose globals for HTML onclick attributes
// Note: We declared the Window interface in liveFeed.ts (or global.d.ts ideally), 
// but we need to assign them here.
window.setDailySort = setDailySort;
window.setWeeklySort = setWeeklySort;
window.setTickerSort = setTickerSort;

window.showTickerView = function(ticker: string) {
    if (currentView !== 'live') {
        switchView('live');
    }
    const tickerView = document.getElementById('ticker-view');
    if (tickerView) {
        tickerView.dataset.ticker = ticker;
        document.getElementById('reset-filter')?.classList.remove('hidden');
        document.getElementById('dashboard-view')?.classList.add('hidden');
        tickerView.classList.remove('hidden');
        renderTickerView(ticker);
    }
}

window.showOverview = function() {
    const tickerView = document.getElementById('ticker-view');
    if (tickerView) delete tickerView.dataset.ticker;
    renderOverview();
}

function switchView(view: 'live' | 'leaderboard') {
    currentView = view;
    // Update Tabs
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`nav-${view}`)?.classList.add('active');

    // Toggle Main Views
    if (view === 'live') {
        document.getElementById('view-live')?.classList.remove('hidden');
        document.getElementById('view-leaderboard')?.classList.add('hidden');
        document.getElementById('live-controls')?.classList.remove('hidden');
        document.getElementById('leaderboard-controls')?.classList.add('hidden');
    } else {
        document.getElementById('view-live')?.classList.add('hidden');
        document.getElementById('view-leaderboard')?.classList.remove('hidden');
        document.getElementById('live-controls')?.classList.add('hidden');
        document.getElementById('leaderboard-controls')?.classList.remove('hidden');
        fetchLeaderboardData(); 
    }
}

function setLiveFeedMode(mode: LiveFeedMode) {
    setLiveFeedModeState(mode);
    
    const btn30 = document.getElementById('btn-30');
    const btn7 = document.getElementById('btn-7');
    const btnWeek = document.getElementById('btn-week');
    const btnMonth = document.getElementById('btn-month');
    
    const inputWeek = document.getElementById('history-week');
    const inputMonth = document.getElementById('history-month');

    // Reset all
    [btn30, btn7, btnWeek, btnMonth].forEach(b => b?.classList.remove('active'));
    inputWeek?.classList.add('hidden');
    inputMonth?.classList.add('hidden');

    if (mode === '30') {
        btn30?.classList.add('active');
    } else if (mode === '7') {
        btn7?.classList.add('active');
    } else if (mode === 'week') {
        btnWeek?.classList.add('active');
        inputWeek?.classList.remove('hidden');
    } else if (mode === 'month') {
        btnMonth?.classList.add('active');
        inputMonth?.classList.remove('hidden');
    }

    fetchLiveAlerts(true).then(() => {
        const tickerView = document.getElementById('ticker-view');
        const ticker = tickerView?.dataset.ticker;
        if (ticker && !tickerView?.classList.contains('hidden')) {
            renderTickerView(ticker);
        } else {
            renderOverview();
        }
    });
}

function initSearch() {
    const toggleBtn = document.getElementById('search-toggle');
    const input = document.getElementById('search-input') as HTMLInputElement;
    
    if (!toggleBtn || !input) return;
    
    toggleBtn.addEventListener('click', () => {
        const isActive = input.classList.contains('active');
        if (isActive) {
            input.classList.remove('active');
            input.blur();
        } else {
            input.classList.add('active');
            input.focus();
        }
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const ticker = input.value.trim().toUpperCase();
            if (ticker) {
                window.showTickerView(ticker);
                input.value = ''; 
                input.blur();
                input.classList.remove('active'); 
            }
        }
    });
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    document.getElementById('nav-live')?.addEventListener('click', () => switchView('live'));
    document.getElementById('nav-leaderboard')?.addEventListener('click', () => {
        switchView('leaderboard');
    });

    // Inputs
    document.getElementById('reset-filter')?.addEventListener('click', window.showOverview);
    
    // Live Feed Controls
    document.getElementById('btn-30')?.addEventListener('click', () => setLiveFeedMode('30'));
    document.getElementById('btn-7')?.addEventListener('click', () => setLiveFeedMode('7'));
    document.getElementById('btn-week')?.addEventListener('click', () => setLiveFeedMode('week'));
    document.getElementById('btn-month')?.addEventListener('click', () => setLiveFeedMode('month'));
    
    // New Date Inputs
    const weekInput = document.getElementById('history-week') as HTMLInputElement;
    const monthInput = document.getElementById('history-month') as HTMLInputElement;

    // Ticker View Sort Buttons
    document.querySelectorAll('.history-controls .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setTickerSort(mode);
        });
    });

    // Set defaults
    if (weekInput) weekInput.value = getCurrentWeekISO();
    if (monthInput) monthInput.value = getCurrentMonthISO();

    weekInput?.addEventListener('change', () => fetchLiveAlerts(true).then(renderOverview));
    monthInput?.addEventListener('change', () => fetchLiveAlerts(true).then(renderOverview));

    // Timeframe Buttons (Leaderboard)
    document.querySelectorAll('#leaderboard-controls .tf-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#leaderboard-controls .tf-btn').forEach(b => b.classList.remove('active'));
            (e.target as HTMLElement).classList.add('active');
            fetchLeaderboardData();
        });
    });

    // Initial Load
    setLiveFeedMode('30'); 
    
    setInterval(() => {
        // Poll if current
        if (currentView === 'live' && isCurrentTimeframe()) {
             fetchLiveAlerts().then(() => {
                const tickerView = document.getElementById('ticker-view');
                const ticker = tickerView?.dataset.ticker;
                if (ticker && !tickerView?.classList.contains('hidden')) {
                    renderTickerView(ticker);
                } else {
                    renderOverview();
                }
             });
        }
    }, 10000); 

    // Setup Search
    initSearch();
});

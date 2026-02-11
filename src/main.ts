import { getCurrentWeekISO, getCurrentMonthISO } from './utils';
import { 
    fetchLiveAlerts, 
    renderOverview, 
    setLiveFeedModeState, 
    isCurrentTimeframe,
    setDailySort,
    setWeeklySort,
    setupLiveFeedDelegation
} from './liveFeed';
import { fetchLeaderboardData, setupLeaderboardDelegation } from './leaderboard';
import { renderTickerView, setTickerDailySort, setTickerWeeklySort } from './ticker';
import { initBreadth, setBreadthTimeframe, setBreadthMetric } from './breadth';
import { initChartControls } from './chart';
import { SortMode, LiveFeedMode } from './types';

let currentView: 'live' | 'leaderboard' | 'breadth' = 'live'; 
let dashboardScrollY = 0;
 

// Expose globals for HTML onclick attributes
// Note: We declared the Window interface in liveFeed.ts (or global.d.ts ideally), 
// but we need to assign them here.
window.setDailySort = setDailySort;
window.setWeeklySort = setWeeklySort;
window.setTickerDailySort = setTickerDailySort;
window.setTickerWeeklySort = setTickerWeeklySort;

window.showTickerView = function(ticker: string) {
    if (currentView !== 'live') {
        switchView('live');
    }
    // Save current scroll position before switching
    dashboardScrollY = window.scrollY;

    const tickerView = document.getElementById('ticker-view');
    if (tickerView) {
        tickerView.dataset.ticker = ticker;
        document.getElementById('reset-filter')?.classList.remove('hidden');
        document.getElementById('dashboard-view')?.classList.add('hidden');
        tickerView.classList.remove('hidden');
        renderTickerView(ticker);
        window.scrollTo(0, 0); // Scroll to top of ticker view
    }
}

window.showOverview = function() {
    const tickerView = document.getElementById('ticker-view');
    if (tickerView) delete tickerView.dataset.ticker;
    renderOverview();
    // Restore scroll position
    window.scrollTo(0, dashboardScrollY);

}

function switchView(view: 'live' | 'leaderboard' | 'breadth') {
    currentView = view;
    // Update Tabs
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`nav-${view}`)?.classList.add('active');

    // Hide all views and controls
    document.getElementById('view-live')?.classList.add('hidden');
    document.getElementById('view-leaderboard')?.classList.add('hidden');
    document.getElementById('view-breadth')?.classList.add('hidden');
    document.getElementById('live-controls')?.classList.add('hidden');
    document.getElementById('leaderboard-controls')?.classList.add('hidden');
    document.getElementById('breadth-controls')?.classList.add('hidden');

    // Show the selected view and controls
    if (view === 'live') {
        document.getElementById('view-live')?.classList.remove('hidden');
        document.getElementById('live-controls')?.classList.remove('hidden');
    } else if (view === 'leaderboard') {
        document.getElementById('view-leaderboard')?.classList.remove('hidden');
        document.getElementById('leaderboard-controls')?.classList.remove('hidden');
        fetchLeaderboardData(); 
    } else if (view === 'breadth') {
        document.getElementById('view-breadth')?.classList.remove('hidden');
        document.getElementById('breadth-controls')?.classList.remove('hidden');
        initBreadth();
    }
}

function setLiveFeedMode(mode: LiveFeedMode) {
    setLiveFeedModeState(mode);
    
    const btn30 = document.getElementById('btn-30');
    const btn7 = document.getElementById('btn-7');
    const btn1 = document.getElementById('btn-1');
    const btnWeek = document.getElementById('btn-week');
    const btnMonth = document.getElementById('btn-month');
    
    const inputWeek = document.getElementById('history-week');
    const inputMonth = document.getElementById('history-month');

    // Reset all
    [btn30, btn7, btn1, btnWeek, btnMonth].forEach(b => b?.classList.remove('active'));
    inputWeek?.classList.add('hidden');
    inputMonth?.classList.add('hidden');

    if (mode === '30') {
        btn30?.classList.add('active');
    } else if (mode === '7') {
        btn7?.classList.add('active');
    } else if (mode === '1') {
        btn1?.classList.add('active');
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
            renderTickerView(ticker, { refreshCharts: false });
        } else {
            renderOverview();
        }
    });
}

function initSearch() {
    const toggleBtn = document.getElementById('search-toggle');
    const input = document.getElementById('search-input') as HTMLInputElement;
    const container = document.getElementById('search-container');
    
    if (!toggleBtn || !input || !container) return;
    
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isActive = input.classList.contains('active');
        if (isActive) {
            input.classList.remove('active');
            input.blur();
        } else {
            input.classList.add('active');
            input.focus();
        }
    });

    container.addEventListener('click', () => {
        if (!input.classList.contains('active')) {
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

    // Type-to-search functionality
    document.addEventListener('keydown', (e) => {
        // Ignore if focus is already on an input or other editable element
        if (document.activeElement instanceof HTMLInputElement || 
            document.activeElement instanceof HTMLTextAreaElement ||
            (document.activeElement as HTMLElement).isContentEditable) {
            return;
        }
        
        // Ignore modifier keys and non-character keys
        if (e.ctrlKey || e.altKey || e.metaKey || e.key.length > 1) return;

        // Check for alphanumeric characters
        if (/^[a-zA-Z0-9]$/.test(e.key)) {
            if (!input.classList.contains('active')) {
                input.classList.add('active');
            }
            input.focus();
            // Note: Focusing during keydown usually allows the keypress to naturally enter the input.
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
    document.getElementById('nav-breadth')?.addEventListener('click', () => switchView('breadth'));

    // Inputs
    document.getElementById('reset-filter')?.addEventListener('click', window.showOverview);
    
    // Live Feed Controls
    document.getElementById('btn-30')?.addEventListener('click', () => setLiveFeedMode('30'));
    document.getElementById('btn-7')?.addEventListener('click', () => setLiveFeedMode('7'));
    document.getElementById('btn-1')?.addEventListener('click', () => setLiveFeedMode('1'));
    document.getElementById('btn-week')?.addEventListener('click', () => setLiveFeedMode('week'));
    document.getElementById('btn-month')?.addEventListener('click', () => setLiveFeedMode('month'));
    
    // New Date Inputs
    const weekInput = document.getElementById('history-week') as HTMLInputElement;
    const monthInput = document.getElementById('history-month') as HTMLInputElement;

    // Ticker View Daily Sort Buttons
    document.querySelectorAll('.ticker-daily-sort .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setTickerDailySort(mode);
        });
    });

    // Ticker View Weekly Sort Buttons
    document.querySelectorAll('.ticker-weekly-sort .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setTickerWeeklySort(mode);
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

    // Breadth Controls
    document.querySelectorAll('#breadth-tf-btns .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const days = Number((btn as HTMLElement).dataset.days);
            setBreadthTimeframe(days);
        });
    });

    document.querySelectorAll('#breadth-metric-btns .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const metric = (btn as HTMLElement).dataset.metric as 'SVIX' | 'RSP' | 'MAGS';
            setBreadthMetric(metric);
            // Update subtitle
            const subtitle = document.getElementById('breadth-subtitle');
            if (subtitle) subtitle.textContent = `SPY vs ${metric} — Normalized`;
        });
    });

    // Initial Load
    setLiveFeedMode('1'); 
    
    setInterval(() => {
        // Poll if current
        if (currentView === 'live' && isCurrentTimeframe()) {
             fetchLiveAlerts().then(() => {
                const tickerView = document.getElementById('ticker-view');
                const ticker = tickerView?.dataset.ticker;
                if (ticker && !tickerView?.classList.contains('hidden')) {
                    renderTickerView(ticker, { refreshCharts: false });
                } else {
                    renderOverview();
                }
             });
        }
    }, 10000); 

    // Setup Search
    initSearch();
    
    // Setup Event Delegation
    setupLiveFeedDelegation();
    setupLeaderboardDelegation();

    // Mobile Collapse Toggle (only on mobile)
    setupMobileCollapse();
    
    // Initialize Chart Controls
    initChartControls();
});

function setupMobileCollapse(): void {
    // Use event delegation on #view-live so it works for both dashboard and ticker views
    const viewLive = document.getElementById('view-live');
    if (!viewLive) return;

    viewLive.addEventListener('click', (e) => {
        // Only activate on mobile
        if (window.innerWidth > 768) return;

        const target = e.target as HTMLElement;
        // Check if click is on an h2 within a column-header or header-title-group
        if (target.tagName !== 'H2') return;
        const isInHeader = target.closest('.column-header') || target.closest('.header-title-group');
        if (!isInHeader) return;

        const column = target.closest('.column');
        if (column) {
            column.classList.toggle('collapsed');
        }
    });
}

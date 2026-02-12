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
import {
    fetchDivergenceSignals,
    renderDivergenceOverview,
    setDivergenceFeedModeState,
    isCurrentDivergenceTimeframe,
    setDivergenceDailySort,
    setDivergenceWeeklySort,
    setupDivergenceFeedDelegation,
    runManualDivergenceScan,
    runManualDivergenceTableBuild,
    syncDivergenceScanUiState
} from './divergenceFeed';
import { SortMode, LiveFeedMode } from './types';

let currentView: 'live' | 'divergence' | 'leaderboard' | 'breadth' = 'live'; 
let liveDashboardScrollY = 0;
let divergenceDashboardScrollY = 0;
let tickerOriginView: 'live' | 'divergence' = 'live';
let appInitialized = false;

const SITE_LOCK_STORAGE_KEY = 'catvue_unlock_v1';
const SITE_LOCK_PASSCODE = '46110603';
const SITE_LOCK_LENGTH = SITE_LOCK_PASSCODE.length;
 

// Expose globals for HTML onclick attributes
// Note: We declared the Window interface in liveFeed.ts (or global.d.ts ideally), 
// but we need to assign them here.
window.setDailySort = setDailySort;
window.setWeeklySort = setWeeklySort;
window.setTickerDailySort = setTickerDailySort;
window.setTickerWeeklySort = setTickerWeeklySort;

window.showTickerView = function(ticker: string, sourceView: 'live' | 'divergence' = 'live') {
    tickerOriginView = sourceView;
    if (sourceView === 'divergence') {
        divergenceDashboardScrollY = window.scrollY;
    } else {
        liveDashboardScrollY = window.scrollY;
    }

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
        window.scrollTo(0, 0); // Scroll to top of ticker view
    }
}

window.showOverview = function() {
    const tickerView = document.getElementById('ticker-view');
    if (tickerView) delete tickerView.dataset.ticker;

    if (tickerOriginView === 'divergence') {
        document.getElementById('reset-filter')?.classList.add('hidden');
        switchView('divergence');
        window.scrollTo(0, divergenceDashboardScrollY);
        return;
    }

    renderOverview();
    window.scrollTo(0, liveDashboardScrollY);

}

function switchView(view: 'live' | 'divergence' | 'leaderboard' | 'breadth') {
    currentView = view;
    // Update Tabs
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`nav-${view}`)?.classList.add('active');

    // Hide all views and controls
    document.getElementById('view-live')?.classList.add('hidden');
    document.getElementById('view-divergence')?.classList.add('hidden');
    document.getElementById('view-leaderboard')?.classList.add('hidden');
    document.getElementById('view-breadth')?.classList.add('hidden');
    document.getElementById('live-controls')?.classList.add('hidden');
    document.getElementById('divergence-controls')?.classList.add('hidden');
    document.getElementById('leaderboard-controls')?.classList.add('hidden');
    document.getElementById('breadth-controls')?.classList.add('hidden');

    // Show the selected view and controls
    if (view === 'live') {
        document.getElementById('view-live')?.classList.remove('hidden');
        document.getElementById('live-controls')?.classList.remove('hidden');
    } else if (view === 'divergence') {
        document.getElementById('view-divergence')?.classList.remove('hidden');
        document.getElementById('divergence-controls')?.classList.remove('hidden');
        fetchDivergenceSignals(true).then(renderDivergenceOverview);
        syncDivergenceScanUiState();
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

function setDivergenceFeedMode(mode: LiveFeedMode, fetchData = true) {
    setDivergenceFeedModeState(mode);

    const btn30 = document.getElementById('divergence-btn-30');
    const btn7 = document.getElementById('divergence-btn-7');
    const btn1 = document.getElementById('divergence-btn-1');
    const btnWeek = document.getElementById('divergence-btn-week');
    const btnMonth = document.getElementById('divergence-btn-month');

    const inputWeek = document.getElementById('divergence-history-week');
    const inputMonth = document.getElementById('divergence-history-month');

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

    if (fetchData) {
        fetchDivergenceSignals(true).then(renderDivergenceOverview);
    }
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

function isSiteLockAlreadyUnlocked(): boolean {
    try {
        return window.localStorage.getItem(SITE_LOCK_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function markSiteLockUnlocked(): void {
    try {
        window.localStorage.setItem(SITE_LOCK_STORAGE_KEY, '1');
    } catch {
        // Ignore storage errors.
    }
}

function initializeSiteLock(onUnlock: () => void): void {
    const overlay = document.getElementById('site-lock-overlay') as HTMLElement | null;
    if (!overlay) {
        onUnlock();
        return;
    }
    if (!overlay.dataset.doubleTapBound) {
        overlay.addEventListener('dblclick', (event) => {
            event.preventDefault();
        });
        overlay.dataset.doubleTapBound = '1';
    }

    const panel = overlay.querySelector('.site-lock-panel') as HTMLElement | null;
    const statusEl = document.getElementById('site-lock-status') as HTMLElement | null;
    const dotEls = Array.from(overlay.querySelectorAll('.site-lock-dot')) as HTMLElement[];
    const digitButtons = Array.from(overlay.querySelectorAll('[data-lock-digit]')) as HTMLButtonElement[];
    const actionButtons = Array.from(overlay.querySelectorAll('[data-lock-action]')) as HTMLButtonElement[];

    if (isSiteLockAlreadyUnlocked()) {
        overlay.classList.add('hidden');
        document.body.classList.remove('site-locked');
        onUnlock();
        return;
    }

    document.body.classList.add('site-locked');
    overlay.classList.remove('hidden');

    let entered = '';

    const updateDots = () => {
        for (let i = 0; i < dotEls.length; i++) {
            dotEls[i].classList.toggle('filled', i < entered.length);
        }
    };

    const setStatus = (message: string) => {
        if (!statusEl) return;
        statusEl.textContent = message;
    };

    const clearEntry = () => {
        entered = '';
        updateDots();
    };

    const handleSuccess = () => {
        markSiteLockUnlocked();
        overlay.classList.add('hidden');
        document.body.classList.remove('site-locked');
        window.removeEventListener('keydown', onKeyDown, true);
        onUnlock();
    };

    const handleFailure = () => {
        setStatus('');
        clearEntry();
        if (panel) {
            panel.classList.remove('shake');
            // Force restart animation on repeated failures.
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            panel.offsetWidth;
            panel.classList.add('shake');
        }
        window.setTimeout(() => {
            if (panel) panel.classList.remove('shake');
        }, 320);
    };

    const verifyIfComplete = () => {
        if (entered.length < SITE_LOCK_LENGTH) return;
        if (entered === SITE_LOCK_PASSCODE) {
            handleSuccess();
            return;
        }
        handleFailure();
    };

    const appendDigit = (digit: string) => {
        if (!/^[0-9]$/.test(digit)) return;
        if (entered.length >= SITE_LOCK_LENGTH) return;
        entered += digit;
        setStatus('');
        updateDots();
        verifyIfComplete();
    };

    const backspace = () => {
        if (!entered.length) return;
        entered = entered.slice(0, -1);
        setStatus('');
        updateDots();
    };

    digitButtons.forEach((button) => {
        button.addEventListener('click', () => {
            appendDigit(String(button.dataset.lockDigit || ''));
        });
    });

    actionButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const action = String(button.dataset.lockAction || '');
            if (action === 'clear') {
                clearEntry();
                setStatus('');
                return;
            }
            if (action === 'back') {
                backspace();
            }
        });
    });

    const onKeyDown = (event: KeyboardEvent) => {
        if (overlay.classList.contains('hidden')) return;
        const key = event.key;
        if (/^[0-9]$/.test(key)) {
            event.preventDefault();
            appendDigit(key);
            return;
        }
        if (key === 'Backspace') {
            event.preventDefault();
            backspace();
            return;
        }
        if (key === 'Escape') {
            event.preventDefault();
            clearEntry();
            setStatus('');
        }
    };
    window.addEventListener('keydown', onKeyDown, true);

    updateDots();
}

function bootstrapApplication(): void {
    if (appInitialized) return;
    appInitialized = true;

    // Initialization
    // Navigation
    document.getElementById('nav-live')?.addEventListener('click', () => switchView('live'));
    document.getElementById('nav-divergence')?.addEventListener('click', () => switchView('divergence'));
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
    document.getElementById('divergence-btn-30')?.addEventListener('click', () => setDivergenceFeedMode('30'));
    document.getElementById('divergence-btn-7')?.addEventListener('click', () => setDivergenceFeedMode('7'));
    document.getElementById('divergence-btn-1')?.addEventListener('click', () => setDivergenceFeedMode('1'));
    document.getElementById('divergence-btn-week')?.addEventListener('click', () => setDivergenceFeedMode('week'));
    document.getElementById('divergence-btn-month')?.addEventListener('click', () => setDivergenceFeedMode('month'));
    document.getElementById('divergence-run-btn')?.addEventListener('click', () => {
        runManualDivergenceScan();
    });
    document.getElementById('divergence-run-table-btn')?.addEventListener('click', () => {
        runManualDivergenceTableBuild();
    });
    
    // New Date Inputs
    const weekInput = document.getElementById('history-week') as HTMLInputElement;
    const monthInput = document.getElementById('history-month') as HTMLInputElement;
    const divergenceWeekInput = document.getElementById('divergence-history-week') as HTMLInputElement;
    const divergenceMonthInput = document.getElementById('divergence-history-month') as HTMLInputElement;

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
    document.querySelectorAll('.divergence-daily-sort .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setDivergenceDailySort(mode);
        });
    });
    document.querySelectorAll('.divergence-weekly-sort .tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = (btn as HTMLElement).dataset.sort as SortMode;
            setDivergenceWeeklySort(mode);
        });
    });

    // Set defaults
    if (weekInput) weekInput.value = getCurrentWeekISO();
    if (monthInput) monthInput.value = getCurrentMonthISO();
    if (divergenceWeekInput) divergenceWeekInput.value = getCurrentWeekISO();
    if (divergenceMonthInput) divergenceMonthInput.value = getCurrentMonthISO();

    weekInput?.addEventListener('change', () => fetchLiveAlerts(true).then(renderOverview));
    monthInput?.addEventListener('change', () => fetchLiveAlerts(true).then(renderOverview));
    divergenceWeekInput?.addEventListener('change', () => fetchDivergenceSignals(true).then(renderDivergenceOverview));
    divergenceMonthInput?.addEventListener('change', () => fetchDivergenceSignals(true).then(renderDivergenceOverview));

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
    setDivergenceFeedMode('1', false);
    
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
        } else if (currentView === 'divergence' && isCurrentDivergenceTimeframe()) {
            fetchDivergenceSignals().then(renderDivergenceOverview);
        }
    }, 10000); 

    // Setup Search
    initSearch();
    
    // Setup Event Delegation
    setupLiveFeedDelegation();
    setupDivergenceFeedDelegation();
    setupLeaderboardDelegation();

    // Mobile Collapse Toggle (only on mobile)
    setupMobileCollapse();
    
    // Initialize Chart Controls
    initChartControls();
}

document.addEventListener('DOMContentLoaded', () => {
    initializeSiteLock(() => {
        bootstrapApplication();
    });
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

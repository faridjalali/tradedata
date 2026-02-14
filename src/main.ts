import { getCurrentWeekISO, getCurrentMonthISO } from './utils';

import { renderTickerView, setTickerDailySort, setTickerWeeklySort } from './ticker';
import { initBreadth, setBreadthTimeframe, setBreadthMetric } from './breadth';
import { initChartControls } from './chart';
import {
    initLogsView,
    refreshLogsView,
    startLogsPolling,
    stopLogsPolling
} from './logs';
import {
    fetchDivergenceSignals,
    renderDivergenceOverview,
    setupDivergenceFeedDelegation,
    runManualDivergenceFetchAllData,
    stopManualDivergenceFetchAllData,
    runManualDivergenceFetchWeeklyData,
    stopManualDivergenceFetchWeeklyData,
    syncDivergenceScanUiState,
    initializeDivergenceSortDefaults,
    setDivergenceFeedMode
} from './divergenceFeed';
import { SortMode, TickerListContext } from './types';
import {
    getAppTimeZone,
    getAppTimeZoneOptions,
    onAppTimeZoneChange,
    setAppTimeZone
} from './timezone';

let currentView: 'logs' | 'divergence' | 'breadth' = 'divergence'; 
let divergenceDashboardScrollY = 0;
let tickerOriginView: 'divergence' = 'divergence';
let tickerListContext: TickerListContext = null;
let appInitialized = false;

const SITE_LOCK_STORAGE_KEY = 'catvue_unlock_v1';
const SITE_LOCK_PASSCODE = '46110603';
const SITE_LOCK_LENGTH = SITE_LOCK_PASSCODE.length;
 

// Expose globals for HTML onclick attributes
// Note: We declared the Window interface in liveFeed.ts (or global.d.ts ideally), 
// but we need to assign them here.
window.setTickerDailySort = setTickerDailySort;
window.setTickerWeeklySort = setTickerWeeklySort;

export function getTickerListContext(): TickerListContext {
    return tickerListContext;
}

export function getTickerOriginView(): 'divergence' {
    return tickerOriginView;
}

window.showTickerView = function(ticker: string, sourceView: 'divergence' = 'divergence', listContext: TickerListContext = null) {
    tickerOriginView = sourceView;
    tickerListContext = listContext;

    divergenceDashboardScrollY = window.scrollY;

    if (currentView !== 'divergence') {
        switchView('divergence');
    }
    // Ticker detail renders inside view-live, assuming we keep the container structure or move it.
    // For now, let's ensure we just set active tab to divergence.
    setActiveNavTab('divergence');

    const tickerView = document.getElementById('ticker-view');
    if (tickerView) {
        tickerView.dataset.ticker = ticker;
        document.getElementById('reset-filter')?.classList.remove('hidden');
        document.getElementById('dashboard-view')?.classList.add('hidden');
        document.getElementById('view-divergence')?.classList.add('hidden'); // Ensure divergence list is hidden if it overlaps
        // Actually, in the old code, tickerView was inside view-live. If we are removing view-live, we might need to change HTML structure.
        // But for this TS file, we just need to remove 'live' references.
        // Let's assume tickerView is a sibling or we will fix HTML next.
        tickerView.classList.remove('hidden');
        renderTickerView(ticker);
        window.scrollTo(0, 0); 
    }
}

window.showOverview = function() {
    const tickerView = document.getElementById('ticker-view');
    if (tickerView) delete tickerView.dataset.ticker;

    // Always return to divergence view as it's the only one left for alerts
    document.getElementById('reset-filter')?.classList.add('hidden');
    switchView('divergence');
    window.scrollTo(0, divergenceDashboardScrollY);
}

function switchView(view: 'logs' | 'divergence' | 'breadth') {
    currentView = view;
    setActiveNavTab(view);

    // Hide all views and controls
    document.getElementById('view-logs')?.classList.add('hidden');
    // document.getElementById('view-live')?.classList.add('hidden'); // Removed
    document.getElementById('view-divergence')?.classList.add('hidden');
    document.getElementById('view-leaderboard')?.classList.add('hidden');
    document.getElementById('view-breadth')?.classList.add('hidden');
    // document.getElementById('live-controls')?.classList.add('hidden'); // Removed
    document.getElementById('divergence-controls')?.classList.add('hidden');
    document.getElementById('leaderboard-controls')?.classList.add('hidden');
    document.getElementById('breadth-controls')?.classList.add('hidden');

    // Also hide ticker view when switching main views
    document.getElementById('ticker-view')?.classList.add('hidden');

    stopLogsPolling();

    // Show the selected view and controls
    if (view === 'logs') {
        document.getElementById('view-logs')?.classList.remove('hidden');
        refreshLogsView().catch(() => {});
        startLogsPolling();
    } else if (view === 'divergence') {
        document.getElementById('view-divergence')?.classList.remove('hidden');
        document.getElementById('divergence-controls')?.classList.remove('hidden');
        fetchDivergenceSignals(true).then(renderDivergenceOverview);
        syncDivergenceScanUiState();
    } else if (view === 'breadth') {
        document.getElementById('view-breadth')?.classList.remove('hidden');
        document.getElementById('breadth-controls')?.classList.remove('hidden');
        initBreadth();
    }
}

function setActiveNavTab(view: 'logs' | 'live' | 'divergence' | 'breadth'): void {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.getElementById(`nav-${view}`)?.classList.add('active');
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

function syncCurrentDateInputsForTimeZoneChange(nextTimeZone: string, previousTimeZone: string): void {
    const previousWeek = getCurrentWeekISO(previousTimeZone);
    const previousMonth = getCurrentMonthISO(previousTimeZone);
    const nextWeek = getCurrentWeekISO(nextTimeZone);
    const nextMonth = getCurrentMonthISO(nextTimeZone);

    const liveWeekInput = document.getElementById('history-week') as HTMLInputElement | null;
    const liveMonthInput = document.getElementById('history-month') as HTMLInputElement | null;
    const divergenceWeekInput = document.getElementById('divergence-history-week') as HTMLInputElement | null;
    const divergenceMonthInput = document.getElementById('divergence-history-month') as HTMLInputElement | null;

    if (liveWeekInput && (!liveWeekInput.value || liveWeekInput.value === previousWeek)) {
        liveWeekInput.value = nextWeek;
    }
    if (divergenceWeekInput && (!divergenceWeekInput.value || divergenceWeekInput.value === previousWeek)) {
        divergenceWeekInput.value = nextWeek;
    }
    if (liveMonthInput && (!liveMonthInput.value || liveMonthInput.value === previousMonth)) {
        liveMonthInput.value = nextMonth;
    }
    if (divergenceMonthInput && (!divergenceMonthInput.value || divergenceMonthInput.value === previousMonth)) {
        divergenceMonthInput.value = nextMonth;
    }
}

declare global {
    interface Window {
        setTickerDailySort: (mode: SortMode) => void;
        setTickerWeeklySort: (mode: SortMode) => void;
        showTickerView: (ticker: string, sourceView?: 'divergence', listContext?: TickerListContext) => void;
        showOverview: () => void;
    }
}

async function refreshViewAfterTimeZoneChange(): Promise<void> {
    if (currentView === 'divergence') {
        await fetchDivergenceSignals(true);
        renderDivergenceOverview();
        return;
    }





    if (currentView === 'breadth') {
        initBreadth();
        return;
    }

    if (currentView === 'logs') {
        await refreshLogsView();
    }
}

function initGlobalSettingsPanel() {
    const container = document.getElementById('global-settings-container');
    const toggleBtn = document.getElementById('global-settings-toggle') as HTMLButtonElement | null;
    const panel = document.getElementById('global-settings-panel');
    let timezoneSelect = document.getElementById('global-timezone-select') as HTMLSelectElement | null;

    if (!container || !toggleBtn || !panel) return;

    const removeLegacyV3Row = () => {
        panel.querySelectorAll<HTMLElement>('.global-settings-toggle-row').forEach((node) => node.remove());
        const legacyById = panel.querySelector('#global-enable-v3-fetch, #enable-v3-fetch');
        if (legacyById) {
            (legacyById.closest('.global-settings-row') || legacyById).remove();
        }
        const allTextNodes = panel.querySelectorAll<HTMLElement>('label, span, div');
        allTextNodes.forEach((node) => {
            const text = String(node.textContent || '').trim().toLowerCase();
            if (text !== 'enable v3 fetch') return;
            (node.closest('.global-settings-row') || node).remove();
        });
    };

    const ensureTimezoneSelect = (): HTMLSelectElement => {
        if (timezoneSelect) return timezoneSelect;
        const row = document.createElement('div');
        row.className = 'global-settings-row global-settings-timezone-row';
        const label = document.createElement('label');
        label.className = 'global-settings-label';
        label.htmlFor = 'global-timezone-select';
        label.textContent = 'Timezone';
        const select = document.createElement('select');
        select.id = 'global-timezone-select';
        select.className = 'glass-input global-settings-select';
        select.setAttribute('aria-label', 'Timezone');
        row.append(label, select);
        panel.append(row);
        timezoneSelect = select;
        return select;
    };

    removeLegacyV3Row();
    timezoneSelect = ensureTimezoneSelect();
    const timezoneSelectEl = timezoneSelect;

    const closePanel = () => {
        panel.classList.add('hidden');
        toggleBtn.classList.remove('active');
    };

    const openPanel = () => {
        panel.classList.remove('hidden');
        toggleBtn.classList.add('active');
        timezoneSelectEl.value = getAppTimeZone();
    };

    const options = getAppTimeZoneOptions();
    timezoneSelectEl.innerHTML = options
        .map((option) => `<option value="${option.value}">${option.label}</option>`)
        .join('');
    timezoneSelectEl.value = getAppTimeZone();
    timezoneSelectEl.addEventListener('change', () => {
        setAppTimeZone(timezoneSelectEl.value);
    });

    onAppTimeZoneChange((nextTimeZone, previousTimeZone) => {
        syncCurrentDateInputsForTimeZoneChange(nextTimeZone, previousTimeZone);
        timezoneSelectEl.value = nextTimeZone;
        refreshViewAfterTimeZoneChange().catch((error) => {
            console.error('Failed to refresh UI after timezone change:', error);
        });
    });

    toggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (panel.classList.contains('hidden')) {
            openPanel();
            syncDivergenceScanUiState().catch(() => {});
        } else {
            closePanel();
        }
    });

    panel.addEventListener('click', (event) => {
        event.stopPropagation();
    });

    document.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (target.closest('#global-settings-container')) return;
        closePanel();
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
    document.getElementById('nav-logs')?.addEventListener('click', () => switchView('logs'));
    document.getElementById('nav-divergence')?.addEventListener('click', () => switchView('divergence'));

    document.getElementById('nav-breadth')?.addEventListener('click', () => switchView('breadth'));

    // Inputs
    document.getElementById('reset-filter')?.addEventListener('click', window.showOverview);
    document.getElementById('ticker-back-btn')?.addEventListener('click', window.showOverview);
    
    // Live Feed Controls

    document.getElementById('divergence-fetch-all-btn')?.addEventListener('click', () => {
        runManualDivergenceFetchAllData();
    });
    document.getElementById('divergence-fetch-all-stop-btn')?.addEventListener('click', () => {
        stopManualDivergenceFetchAllData();
    });
    document.getElementById('divergence-fetch-weekly-btn')?.addEventListener('click', () => {
        runManualDivergenceFetchWeeklyData();
    });
    document.getElementById('divergence-fetch-weekly-stop-btn')?.addEventListener('click', () => {
        stopManualDivergenceFetchWeeklyData();
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


    // Main Dashboard Daily Sort Buttons


    // Set defaults
    if (weekInput) weekInput.value = getCurrentWeekISO();
    if (monthInput) monthInput.value = getCurrentMonthISO();
    if (divergenceWeekInput) divergenceWeekInput.value = getCurrentWeekISO();
    if (divergenceMonthInput) divergenceMonthInput.value = getCurrentMonthISO();





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
    initializeDivergenceSortDefaults();
    setDivergenceFeedMode('today', false);
    syncDivergenceScanUiState().catch(() => {});
    switchView('divergence');
    
    // Setup Search
    initGlobalSettingsPanel();
    initSearch();
    initLogsView();
    
    // Setup Event Delegation
    setupDivergenceFeedDelegation();

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
    const attachCollapseHandler = (root: HTMLElement | null, allowedContainerSelector: string): void => {
        if (!root) return;
        root.addEventListener('click', (e) => {
            // Only activate on mobile-like viewport widths.
            if (window.innerWidth > 768) return;

            const target = e.target as HTMLElement | null;
            if (!target) return;
            const heading = target.closest('h2');
            if (!heading) return;
            const isInHeader = heading.closest('.column-header') || heading.closest('.header-title-group');
            if (!isInHeader) return;

            const column = heading.closest('.column');
            if (!column) return;
            if (!column.closest(allowedContainerSelector)) return;

            column.classList.toggle('collapsed');
        });
    };

    // Alerts page (default) dashboard columns.
    attachCollapseHandler(document.getElementById('view-divergence'), '#divergence-dashboard-view');
}

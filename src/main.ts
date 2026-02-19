import { renderTickerView, setTickerDailySort, setTickerWeeklySort } from './ticker';
import { initChartControls, cancelChartLoading, isMobileTouch } from './chart';
import { setChartNavigationCallbacks } from './chartNavigation';
import { createRefreshSvgIcon, setRefreshButtonLoading } from './chartVDF';

// --- Lazy-loaded view modules (code splitting) ---

let _logsModule: typeof import('./logs') | null = null;
async function loadLogs() {
  if (!_logsModule) _logsModule = await import('./logs');
  return _logsModule;
}

let _breadthModule: typeof import('./breadth') | null = null;
async function loadBreadth() {
  if (!_breadthModule) _breadthModule = await import('./breadth');
  return _breadthModule;
}
import {
  fetchDivergenceSignals,
  renderDivergenceOverview,
  setupDivergenceFeedDelegation,
  initFetchButtons,
  syncDivergenceScanUiState,
  initializeDivergenceSortDefaults,
  setColumnFeedMode,
  setColumnCustomDates,
  ColumnFeedMode,
} from './divergenceFeed';
import { SortMode, TickerListContext } from './types';
import { getAppTimeZone, getAppTimeZoneOptions, onAppTimeZoneChange, setAppTimeZone } from './timezone';
import { initTheme, setTheme, getTheme, ThemeName } from './theme';
import { initializeSiteLock } from './siteLock';

let currentView: 'logs' | 'divergence' | 'breadth' = 'divergence';
let divergenceDashboardScrollY = 0;
let tickerOriginView = 'divergence' as const;
let tickerListContext: TickerListContext = null;
let appInitialized = false;


// ---------------------------------------------------------------------------
// Hash Router — maps URL hash to views so browser back/forward works and
// deep-linking is possible (e.g. #/ticker/AAPL, #/logs).
// ---------------------------------------------------------------------------

type ViewName = 'logs' | 'divergence' | 'breadth';

/** Suppress pushHash when we're already responding to a hashchange. */
let hashNavInProgress = false;

function pushHash(hash: string): void {
  if (hashNavInProgress) return;
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (window.location.hash !== target) {
    history.pushState(null, '', target);
  }
}

function parseHash(hash: string): { view: ViewName } | { ticker: string } | null {
  const raw = (hash || '').replace(/^#\/?/, '').trim();
  if (!raw) return null;
  // #/ticker/AAPL  or  #/ticker/AAPL/
  const tickerMatch = raw.match(/^ticker\/([A-Za-z0-9._-]+)\/?$/);
  if (tickerMatch) return { ticker: tickerMatch[1].toUpperCase() };
  // #/divergence, #/logs, #/breadth
  const viewName = raw.replace(/\/$/, '').toLowerCase();
  if (viewName === 'divergence' || viewName === 'logs' || viewName === 'breadth') {
    return { view: viewName };
  }
  return null;
}

function handleHashRoute(): void {
  if (!appInitialized) return;
  const parsed = parseHash(window.location.hash);
  if (!parsed) return;
  hashNavInProgress = true;
  try {
    if ('ticker' in parsed) {
      window.showTickerView(parsed.ticker);
    } else {
      // If we're in a ticker sub-view, close it first
      const tickerView = document.getElementById('ticker-view');
      if (tickerView && !tickerView.classList.contains('hidden')) {
        cancelChartLoading();
        delete tickerView.dataset.ticker;
        tickerView.classList.add('hidden');
        document.getElementById('view-divergence')?.classList.remove('hidden');
      }
      switchView(parsed.view);
    }
  } finally {
    hashNavInProgress = false;
  }
}

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

window.showTickerView = function (
  ticker: string,
  sourceView: 'divergence' = 'divergence',
  listContext: TickerListContext = null,
) {
  tickerOriginView = sourceView;
  tickerListContext = listContext;

  divergenceDashboardScrollY = window.scrollY;

  if (currentView !== 'divergence') {
    switchView('divergence');
  }
  setActiveNavTab('divergence');

  const tickerView = document.getElementById('ticker-view');
  if (tickerView) {
    cancelChartLoading();
    tickerView.dataset.ticker = ticker;
    document.getElementById('dashboard-view')?.classList.add('hidden');
    document.getElementById('view-divergence')?.classList.add('hidden');
    tickerView.classList.remove('hidden');
    pushHash(`/ticker/${ticker}`);
    renderTickerView(ticker);
    window.scrollTo(0, 0);
  }
};

window.showOverview = function () {
  cancelChartLoading();
  const tickerView = document.getElementById('ticker-view');
  if (tickerView) delete tickerView.dataset.ticker;

  switchView('divergence'); // pushes #/divergence
  window.scrollTo(0, divergenceDashboardScrollY);
};

function switchView(view: 'logs' | 'divergence' | 'breadth') {
  currentView = view;
  pushHash(`/${view}`);
  setActiveNavTab(view);

  // Hide all views
  document.getElementById('view-logs')?.classList.add('hidden');
  document.getElementById('view-divergence')?.classList.add('hidden');
  document.getElementById('view-breadth')?.classList.add('hidden');

  // Also hide ticker view when switching main views
  document.getElementById('ticker-view')?.classList.add('hidden');
  cancelChartLoading();

  loadLogs().then((m) => m.stopLogsPolling()).catch(() => {});

  // Close any open dropdowns
  closeAllHeaderDropdowns();

  // Show the selected view and controls
  if (view === 'logs') {
    document.getElementById('view-logs')?.classList.remove('hidden');
    loadLogs().then((m) => { m.refreshLogsView().catch(() => {}); m.startLogsPolling(); }).catch(() => {});
  } else if (view === 'divergence') {
    document.getElementById('view-divergence')?.classList.remove('hidden');
    fetchDivergenceSignals(true).then(renderDivergenceOverview);
    syncDivergenceScanUiState();
  } else if (view === 'breadth') {
    document.getElementById('view-breadth')?.classList.remove('hidden');
    const refreshBtn = document.getElementById('breadth-refresh-btn');
    if (refreshBtn && refreshBtn.childElementCount === 0) {
      refreshBtn.appendChild(createRefreshSvgIcon());
    }
    loadBreadth().then((m) => { m.initBreadth(); m.initBreadthThemeListener(); }).catch(() => {});
  }
}

function closeAllHeaderDropdowns(): void {
  document.getElementById('header-nav-dropdown')?.classList.add('hidden');
  document.getElementById('header-nav-dropdown')?.classList.remove('open');
}

function setActiveNavTab(view: 'logs' | 'live' | 'divergence' | 'breadth'): void {
  document.querySelectorAll('.header-nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelector(`.header-nav-item[data-view="${view}"]`)?.classList.add('active');
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
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement ||
      (document.activeElement as HTMLElement).isContentEditable
    ) {
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
    const breadth = await loadBreadth();
    breadth.initBreadth();
    breadth.initBreadthThemeListener();
    return;
  }

  if (currentView === 'logs') {
    const logs = await loadLogs();
    await logs.refreshLogsView();
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
      const text = String(node.textContent || '')
        .trim()
        .toLowerCase();
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

  onAppTimeZoneChange((nextTimeZone) => {
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

  // Theme buttons
  const themeBtns = panel.querySelectorAll<HTMLElement>('.theme-swatch-btn');
  const currentThemeName = getTheme();
  themeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === currentThemeName);
    btn.addEventListener('click', () => {
      const name = btn.dataset.theme as ThemeName;
      setTheme(name);
      themeBtns.forEach((b) => b.classList.toggle('active', b.dataset.theme === name));
    });
  });

  // Minichart on Mobile toggle
  const mcBtns = panel.querySelectorAll<HTMLElement>('[data-minichart-mobile]');
  const storedMc = localStorage.getItem('minichart_mobile') || 'off';
  mcBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.minichartMobile === storedMc);
    btn.addEventListener('click', () => {
      const val = btn.dataset.minichartMobile || 'off';
      mcBtns.forEach((b) => b.classList.toggle('active', b.dataset.minichartMobile === val));
      try {
        localStorage.setItem('minichart_mobile', val);
      } catch {
        /* ignore */
      }
      window.dispatchEvent(new CustomEvent('minichartmobilechange', { detail: { value: val } }));
    });
  });
}


function initHeaderNavDropdown(): void {
  const toggle = document.getElementById('header-nav-toggle');
  const dropdown = document.getElementById('header-nav-dropdown');
  if (!toggle || !dropdown) return;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllColumnCustomPanels();

    const isVisible = dropdown.classList.contains('open');
    if (isVisible) {
      dropdown.classList.remove('open');
      setTimeout(() => dropdown.classList.add('hidden'), 150);
    } else {
      dropdown.classList.remove('hidden');
      requestAnimationFrame(() => dropdown.classList.add('open'));
    }
  });

  dropdown.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.header-nav-item') as HTMLElement | null;
    if (!item) return;
    const view = item.dataset.view as 'logs' | 'divergence' | 'breadth';
    if (view) {
      switchView(view);
      dropdown.classList.remove('open');
      setTimeout(() => dropdown.classList.add('hidden'), 150);
    }
  });
}

function initColumnTimeframeButtons(): void {
  // Event delegation for all column tf buttons
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Timeframe button click (1, 2, 5, custom)
    const tfBtn = target.closest('.column-tf-controls .pane-btn[data-tf]') as HTMLElement | null;
    if (tfBtn) {
      const controls = tfBtn.closest('.column-tf-controls') as HTMLElement | null;
      if (!controls) return;
      const column = controls.dataset.column as 'daily' | 'weekly';
      const mode = tfBtn.dataset.tf as ColumnFeedMode;
      if (!column || !mode) return;

      if (mode === 'custom') {
        // Toggle custom panel visibility
        const panel = controls.querySelector('.column-tf-custom-panel') as HTMLElement | null;
        if (panel) {
          const isVisible = !panel.classList.contains('hidden');
          closeAllColumnCustomPanels();
          if (!isVisible) {
            panel.classList.remove('hidden');
            requestAnimationFrame(() => panel.classList.add('open'));
          }
        }
        // Mark C as active without fetching
        setColumnFeedMode(column, mode, false);
        return;
      }

      closeAllColumnCustomPanels();
      setColumnFeedMode(column, mode);
      return;
    }

    // Apply button click inside custom panel
    const applyBtn = target.closest('.column-tf-apply') as HTMLElement | null;
    if (applyBtn) {
      const panel = applyBtn.closest('.column-tf-custom-panel') as HTMLElement | null;
      if (panel) applyCustomDatePanel(panel);
      return;
    }

    // Click on date input inside custom panel — don't close
    if (target.closest('.column-tf-custom-panel')) return;

    // Click outside — close all custom panels
    if (!target.closest('.column-tf-controls')) {
      closeAllColumnCustomPanels();
    }
  });

  // Auto-format date inputs (mm/dd/yyyy) with auto-advance
  document.addEventListener('input', handleDateAutoFormat);
  document.addEventListener('keydown', handleDateKeydown);
}

function parseDateInputValue(value: string): string | null {
  // Native date inputs return yyyy-mm-dd
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return value;
  // Legacy mm/dd/yyyy fallback
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function handleDateAutoFormat(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (!input || !(input.classList.contains('column-tf-from') || input.classList.contains('column-tf-to'))) return;

  const raw = input.value;
  let digits = raw.replace(/\D/g, '');
  if (digits.length > 8) digits = digits.slice(0, 8);

  let formatted = '';
  if (digits.length <= 2) {
    formatted = digits;
  } else if (digits.length <= 4) {
    formatted = digits.slice(0, 2) + '/' + digits.slice(2);
  } else {
    formatted = digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4);
  }

  input.value = formatted;

  if (formatted.length === 10 && input.classList.contains('column-tf-from')) {
    const panel = input.closest('.column-tf-custom-panel');
    const toInput = panel?.querySelector('.column-tf-to') as HTMLInputElement | null;
    if (toInput && !toInput.value) {
      toInput.focus();
    }
  }
}

function handleDateKeydown(e: KeyboardEvent): void {
  const input = e.target as HTMLInputElement;
  if (!input || !(input.classList.contains('column-tf-from') || input.classList.contains('column-tf-to'))) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    const panel = input.closest('.column-tf-custom-panel');
    const applyBtn = panel?.querySelector('.column-tf-apply') as HTMLElement | null;
    applyBtn?.click();
  }
}

function applyCustomDatePanel(panel: HTMLElement): void {
  const controls = panel.closest('.column-tf-controls') as HTMLElement | null;
  if (!controls) return;
  const column = controls.dataset.column as 'daily' | 'weekly';
  const fromInput = panel.querySelector('.column-tf-from') as HTMLInputElement | null;
  const toInput = panel.querySelector('.column-tf-to') as HTMLInputElement | null;
  const fromVal = parseDateInputValue(fromInput?.value || '');
  const toVal = parseDateInputValue(toInput?.value || '');
  if (column && fromVal && toVal) {
    setColumnCustomDates(column, fromVal, toVal);
    setColumnFeedMode(column, 'custom');
  }
  closeAllColumnCustomPanels();
}

function closeAllColumnCustomPanels(): void {
  document.querySelectorAll('.column-tf-custom-panel').forEach((panel) => {
    panel.classList.remove('open');
    panel.classList.add('hidden');
  });
}

function bootstrapApplication(): void {
  if (appInitialized) return;
  appInitialized = true;

  // Prevent long-press text selection / callout on touch devices globally
  if (isMobileTouch) {
    document.documentElement.style.webkitUserSelect = 'none';
    document.documentElement.style.userSelect = 'none';
    (document.documentElement.style as any).webkitTouchCallout = 'none';
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  // Back button (in chart controls bar)
  document.getElementById('ticker-back-btn')?.addEventListener('click', window.showOverview);

  // Settings panel fetch buttons — auto-wired by FetchButton registry
  initFetchButtons();

  // Ticker View Daily Sort Buttons
  document.querySelectorAll('.ticker-daily-sort .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.sort as SortMode;
      setTickerDailySort(mode);
    });
  });

  // Ticker View Weekly Sort Buttons
  document.querySelectorAll('.ticker-weekly-sort .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.sort as SortMode;
      setTickerWeeklySort(mode);
    });
  });

  // Breadth Controls (lazy-loaded)
  document.querySelectorAll('#breadth-tf-btns .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = Number((btn as HTMLElement).dataset.days);
      loadBreadth().then((m) => m.setBreadthTimeframe(days)).catch(() => {});
    });
  });

  document.querySelectorAll('#breadth-metric-btns .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const metric = (btn as HTMLElement).dataset.metric as 'SVIX' | 'RSP' | 'MAGS';
      loadBreadth().then((m) => m.setBreadthMetric(metric)).catch(() => {});
    });
  });

  // Breadth MA + Compare index buttons: wired inside initBreadth()
  // (buttons are now generated from BREADTH_INDEXES, not static HTML)

  // Comparative Breadth: Timeframe buttons
  document.querySelectorAll('#breadth-compare-tf-btns .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const days = Number((btn as HTMLElement).dataset.days);
      loadBreadth().then((m) => m.setBreadthCompareTf(days)).catch(() => {});
    });
  });

  // Comparative Breadth: Compare mode toggle
  document.getElementById('breadth-compare-toggle')?.addEventListener('click', () => {
    loadBreadth().then((m) => m.toggleBreadthCompareMode()).catch(() => {});
  });

  // ETF Bar Rankings: MA window selector
  document.querySelectorAll('#breadth-bars-ma-btns .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ma = (btn as HTMLElement).dataset.ma;
      if (!ma) return;
      document.querySelectorAll('#breadth-bars-ma-btns .pane-btn').forEach((b) =>
        b.classList.toggle('active', b === btn));
      loadBreadth().then((m) => m.setBreadthBarsMA(ma)).catch(() => {});
    });
  });

  // Breadth: Refresh all data
  document.getElementById('breadth-refresh-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('breadth-refresh-btn');
    if (btn) setRefreshButtonLoading(btn, true);
    loadBreadth().then((m) => m.refreshBreadth()).catch(() => {}).finally(() => {
      if (btn) setRefreshButtonLoading(btn, false);
    });
  });

  // Header navigation dropdown & column timeframe dropdowns
  initHeaderNavDropdown();
  initColumnTimeframeButtons();

  // Close header dropdowns on outside click
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('#header-nav-container')) return;
    closeAllHeaderDropdowns();
  });

  // Initial Load
  initializeDivergenceSortDefaults();
  syncDivergenceScanUiState().catch(() => {});

  // Hash router: restore view from URL hash, or default to divergence
  const initialRoute = parseHash(window.location.hash);
  if (initialRoute && 'ticker' in initialRoute) {
    switchView('divergence');
    window.showTickerView(initialRoute.ticker);
  } else if (initialRoute && 'view' in initialRoute) {
    switchView(initialRoute.view);
  } else {
    switchView('divergence');
  }

  // Listen for browser back/forward
  window.addEventListener('hashchange', () => handleHashRoute());

  // Setup Search
  initGlobalSettingsPanel();
  initSearch();
  loadLogs().then((m) => m.initLogsView()).catch(() => {});

  // Setup Event Delegation
  setupDivergenceFeedDelegation();

  // Mobile Collapse Toggle (only on mobile)
  setupMobileCollapse();

  // Wire up chart navigation callbacks (resolves circular dep: chart ↔ main)
  setChartNavigationCallbacks(getTickerListContext, getTickerOriginView);

  // Initialize Chart Controls
  initChartControls();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
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

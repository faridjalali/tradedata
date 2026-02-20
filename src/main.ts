import { renderTickerView, setTickerDailySort, setTickerWeeklySort } from './ticker';
import { initChartControls, cancelChartLoading, isMobileTouch } from './chart';
import { setChartNavigationCallbacks } from './chartNavigation';
import { render, h } from 'preact';
import { AdminView } from './components/AdminView';
import { BreadthView } from './components/BreadthView';
import { TickerView } from './components/TickerView';
import { pushHash, onRouteChange, installHashListener, getInitialRoute } from './router';
import type { ViewName, Route } from './router';
import { appStore } from './store/appStore';
import type { BreadthMetric } from './store/breadthStore';

// --- Lazy-loaded view modules (code splitting) ---
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
import { onAppTimeZoneChange, getAppTimeZone, setAppTimeZone, getAppTimeZoneOptions } from './timezone';
import { initTheme, setTheme, getTheme, ThemeName } from './theme';
import { initializeSiteLock } from './siteLock';
// ---------------------------------------------------------------------------
// Route handler — called by the router on hashchange
// ---------------------------------------------------------------------------

function handleRoute(route: Route): void {
  if (!appStore.getState().appInitialized) return;
  if (route.kind === 'ticker') {
    window.showTickerView(route.ticker);
  } else {
    // If we're in a ticker sub-view, close it first
    const tickerView = document.getElementById('ticker-view');
    if (tickerView && !tickerView.classList.contains('hidden')) {
      cancelChartLoading();
      delete tickerView.dataset.ticker;
      tickerView.classList.add('hidden');
      document.getElementById('view-divergence')?.classList.remove('hidden');
    }
    switchView(route.view);
  }
}

// Expose globals for HTML onclick attributes
// Note: We declared the Window interface in liveFeed.ts (or global.d.ts ideally),
// but we need to assign them here.
window.setTickerDailySort = setTickerDailySort;
window.setTickerWeeklySort = setTickerWeeklySort;

export function getTickerListContext(): TickerListContext {
  return appStore.getState().tickerListContext;
}

export function getTickerOriginView(): 'divergence' {
  return appStore.getState().tickerOriginView;
}

window.showTickerView = function (
  ticker: string,
  sourceView: 'divergence' = 'divergence',
  listContext: TickerListContext = null,
) {
  appStore.getState().setTickerOriginView(sourceView);
  appStore.getState().setTickerListContext(listContext);
  appStore.getState().saveDivergenceScroll();

  if (appStore.getState().currentView !== 'divergence') {
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
  appStore.getState().restoreDivergenceScroll();
};

function mountBreadthView(): void {
  const breadthRoot = document.getElementById('breadth-root');
  if (!breadthRoot || appStore.getState().breadthMounted) return;

  render(
    h(BreadthView, {
      onSelectTimeframe: (days: number) => {
        loadBreadth()
          .then((m) => m.setBreadthTimeframe(days))
          .catch(() => {});
      },
      onSelectMetric: (metric: BreadthMetric) => {
        loadBreadth()
          .then((m) => m.setBreadthMetric(metric))
          .catch(() => {});
      },
      onSelectCompareTf: (days: number) => {
        loadBreadth()
          .then((m) => m.setBreadthCompareTf(days))
          .catch(() => {});
      },
      onToggleCompareMode: () => {
        loadBreadth()
          .then((m) => m.toggleBreadthCompareMode())
          .catch(() => {});
      },
      onSelectBarsMA: (ma: string) => {
        loadBreadth()
          .then((m) => m.setBreadthBarsMA(ma))
          .catch(() => {});
      },
    }),
    breadthRoot,
  );
  appStore.getState().setBreadthMounted(true);
}

function unmountBreadthView(): void {
  if (!appStore.getState().breadthMounted) return;
  const breadthRoot = document.getElementById('breadth-root');
  if (breadthRoot) render(null, breadthRoot);
  appStore.getState().setBreadthMounted(false);
}

function mountTickerView(): void {
  const tickerRoot = document.getElementById('ticker-root');
  if (!tickerRoot) return;
  render(h(TickerView, null), tickerRoot);
}

function switchView(view: ViewName) {
  appStore.getState().setCurrentView(view);
  pushHash(`/${view}`);
  setActiveNavTab(view);

  // Hide all views
  document.getElementById('view-admin')?.classList.add('hidden');
  document.getElementById('view-divergence')?.classList.add('hidden');
  document.getElementById('view-breadth')?.classList.add('hidden');

  // Also hide ticker view when switching main views
  document.getElementById('ticker-view')?.classList.add('hidden');
  cancelChartLoading();

  // Stop admin polling when leaving admin view
  if (appStore.getState().adminMounted) {
    const adminRoot = document.getElementById('admin-root');
    if (adminRoot) render(null, adminRoot);
    appStore.getState().setAdminMounted(false);
  }
  if (view !== 'breadth') {
    unmountBreadthView();
  }

  // Close any open dropdowns
  closeAllHeaderDropdowns();

  // Show the selected view and controls
  if (view === 'admin') {
    document.getElementById('view-admin')?.classList.remove('hidden');
    const adminRoot = document.getElementById('admin-root');
    if (adminRoot && !appStore.getState().adminMounted) {
      render(h(AdminView, null), adminRoot);
      appStore.getState().setAdminMounted(true);
    }
  } else if (view === 'divergence') {
    document.getElementById('view-divergence')?.classList.remove('hidden');
    fetchDivergenceSignals(true).then(renderDivergenceOverview);
    syncDivergenceScanUiState();
  } else if (view === 'breadth') {
    document.getElementById('view-breadth')?.classList.remove('hidden');
    mountBreadthView();
    loadBreadth()
      .then((m) => {
        m.initBreadth();
        m.initBreadthThemeListener();
      })
      .catch(() => {});
  }
}

function closeAllHeaderDropdowns(): void {
  document.getElementById('header-nav-dropdown')?.classList.add('hidden');
  document.getElementById('header-nav-dropdown')?.classList.remove('open');
}

function setActiveNavTab(view: ViewName | 'live'): void {
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
  const view = appStore.getState().currentView;
  if (view === 'divergence') {
    await fetchDivergenceSignals(true);
    renderDivergenceOverview();
    return;
  }

  if (view === 'breadth') {
    const breadth = await loadBreadth();
    breadth.initBreadth();
    breadth.initBreadthThemeListener();
    return;
  }

  // Admin view is Preact-managed and handles its own refresh via useEffect
}

function initGlobalSettingsPanel() {
  const container = document.getElementById('global-settings-container');
  const toggleBtn = document.getElementById('global-settings-toggle') as HTMLButtonElement | null;
  const panel = document.getElementById('global-settings-panel');

  if (!container || !toggleBtn || !panel) return;

  const closePanel = () => {
    panel.classList.add('hidden');
    toggleBtn.classList.remove('active');
  };

  const openPanel = () => {
    panel.classList.remove('hidden');
    toggleBtn.classList.add('active');
  };

  toggleBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (panel.classList.contains('hidden')) {
      openPanel();
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

  // Timezone select
  const tzSelect = document.getElementById('global-timezone-select') as HTMLSelectElement | null;
  if (tzSelect) {
    const tzOptions = getAppTimeZoneOptions();
    tzSelect.innerHTML = tzOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    tzSelect.value = getAppTimeZone();
    tzSelect.addEventListener('change', () => {
      setAppTimeZone(tzSelect.value);
    });
  }

  // Minichart toggle
  const mcBtns = panel.querySelectorAll<HTMLElement>('[data-minichart]');
  const storedMc = localStorage.getItem('minichart_mobile') || 'off';
  mcBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.minichart === storedMc);
    btn.addEventListener('click', () => {
      const val = btn.dataset.minichart || 'off';
      mcBtns.forEach((b) => b.classList.toggle('active', b.dataset.minichart === val));
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
    const view = item.dataset.view as 'admin' | 'divergence' | 'breadth';
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

    // Timeframe button click (1, 5, 30, custom)
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

  // Auto-advance from "from" date to "to" date when a date is selected
  document.addEventListener('change', handleDateAutoAdvance);
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

function handleDateAutoAdvance(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (!input || !input.classList.contains('column-tf-from')) return;
  if (!input.value) return;
  const panel = input.closest('.column-tf-custom-panel');
  const toInput = panel?.querySelector('.column-tf-to') as HTMLInputElement | null;
  if (toInput && !toInput.value) {
    toInput.focus();
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
  if (appStore.getState().appInitialized) return;
  appStore.getState().setAppInitialized();

  // Keep ticker/chart DOM preact-managed while legacy chart logic still binds
  // to existing IDs/classes.
  mountTickerView();

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
  const initialRoute = getInitialRoute();
  if (initialRoute.kind === 'ticker') {
    switchView('divergence');
    window.showTickerView(initialRoute.ticker);
  } else {
    switchView(initialRoute.view);
  }

  // Listen for browser back/forward via router module
  onRouteChange(handleRoute);
  installHashListener();

  // Global timezone change handler (must be registered at bootstrap, not lazily)
  onAppTimeZoneChange(() => {
    refreshViewAfterTimeZoneChange().catch((error) => {
      console.error('Failed to refresh UI after timezone change:', error);
    });
  });

  // Setup Search & Settings
  initGlobalSettingsPanel();
  initSearch();

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

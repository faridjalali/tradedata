/**
 * Feed rendering — sorting, filtering, column configuration, data fetching,
 * and DOM rendering of divergence signal alert cards.
 */

import { getDateRangeForMode, createAlertSortFn, updateSortButtonUi } from './utils';
import { fetchDivergenceSignalsFromApi } from './divergenceApi';
import { setDivergenceSignals, setDivergenceSignalsByTimeframe, getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import {
  prefetchMiniChartBars,
  renderInlineMinicharts,
  detachInlineMinichartWrappers,
  reattachInlineMinichartWrappers,
} from './divergenceMinichart';
import { SortMode, Alert } from './types';
import { divergenceStore } from './store/divergenceStore';
import type { ColumnKey, ColumnFeedMode } from './store/divergenceStore';

// Re-export for backward compatibility (consumers import from here)
export type { ColumnFeedMode, ColumnKey } from './store/divergenceStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALERTS_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Column state accessors (now delegate to Zustand store)
// ---------------------------------------------------------------------------

// Backward-compatible exports for event delegation module
export function getDailyVisibleCount(): number {
  return divergenceStore.getState().getColumn('daily').visibleCount;
}
export function getWeeklyVisibleCount(): number {
  return divergenceStore.getState().getColumn('weekly').visibleCount;
}
export function incrementDailyVisibleCount(): void {
  divergenceStore.getState().incrementColumnVisibleCount('daily');
}
export function incrementWeeklyVisibleCount(): void {
  divergenceStore.getState().incrementColumnVisibleCount('weekly');
}

// ---------------------------------------------------------------------------
// Column feed configuration
// ---------------------------------------------------------------------------

export function getColumnFeedMode(column: ColumnKey): ColumnFeedMode {
  return divergenceStore.getState().getColumn(column).feedMode;
}

export function setColumnCustomDates(column: ColumnKey, from: string, to: string): void {
  divergenceStore.getState().setColumnCustomDates(column, from, to);
}

export function getColumnCustomDates(column: ColumnKey): { from: string; to: string } {
  const c = divergenceStore.getState().getColumn(column);
  return { from: c.customFrom, to: c.customTo };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Filter alerts to only the N most recent unique trade dates */
export function filterToLatestNDates(alerts: Alert[], n: number): Alert[] {
  const dates = new Set<string>();
  for (const a of alerts) {
    const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
    if (d) dates.add(d);
  }
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  const topN = new Set(sorted.slice(0, n));
  return alerts.filter((a) => {
    const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
    return d ? topN.has(d) : false;
  });
}

/** Apply column feed mode date filter */
function applyColumnDateFilter(alerts: Alert[], mode: ColumnFeedMode): Alert[] {
  if (mode === '1') return filterToLatestNDates(alerts, 1);
  if (mode === '5') return filterToLatestNDates(alerts, 5);
  if (mode === '30') return filterToLatestNDates(alerts, 30);
  return alerts; // 'custom' — server already filtered
}

// ---------------------------------------------------------------------------
// Sort defaults
// ---------------------------------------------------------------------------

export function initializeDivergenceSortDefaults(): void {
  divergenceStore.getState().resetColumnDefaults();
  const d = divergenceStore.getState().getColumn('daily');
  const w = divergenceStore.getState().getColumn('weekly');
  updateSortButtonUi('#view-divergence .divergence-daily-sort', d.sortMode, d.sortDirection);
  updateSortButtonUi('#view-divergence .divergence-weekly-sort', w.sortMode, w.sortDirection);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function setDivergenceSort(column: ColumnKey, mode: SortMode): void {
  const store = divergenceStore.getState();
  const s = store.getColumn(column);
  let newSort = s.sortMode;
  let newDir = s.sortDirection;
  let newPreFav = s.preFavSortMode;
  let newPreFavDir = s.preFavSortDirection;

  if (mode === 'favorite' && s.sortMode === 'favorite') {
    newSort = s.preFavSortMode ?? 'score';
    newDir = s.preFavSortDirection;
    newPreFav = null;
  } else if (mode === 'favorite') {
    newPreFav = s.sortMode;
    newPreFavDir = s.sortDirection;
    newSort = 'favorite';
    newDir = 'desc';
  } else if (mode === s.sortMode) {
    newDir = s.sortDirection === 'desc' ? 'asc' : 'desc';
  } else {
    newSort = mode;
    newDir = 'desc';
    newPreFav = null;
  }

  store.setColumnSort(column, newSort, newDir);
  store.setColumnPreFavSort(column, newPreFav, newPreFavDir);
  store.setColumnVisibleCount(column, ALERTS_PAGE_SIZE);

  const uiSelector = column === 'daily' ? '.divergence-daily-sort' : '.divergence-weekly-sort';
  updateSortButtonUi(`#view-divergence ${uiSelector}`, newSort, newDir);
  renderDivergenceContainer(column === 'daily' ? '1d' : '1w');
}

export function setDivergenceDailySort(mode: SortMode): void {
  setDivergenceSort('daily', mode);
}
export function setDivergenceWeeklySort(mode: SortMode): void {
  setDivergenceSort('weekly', mode);
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export async function fetchDivergenceSignals(_force?: boolean): Promise<Alert[]> {
  try {
    const dailyColumn = divergenceStore.getState().getColumn('daily');
    const weeklyColumn = divergenceStore.getState().getColumn('weekly');
    const dailyRange = getDateRangeForMode(dailyColumn.feedMode, dailyColumn.customFrom, dailyColumn.customTo);
    const weeklyRange = getDateRangeForMode(weeklyColumn.feedMode, weeklyColumn.customFrom, weeklyColumn.customTo);
    if (!dailyRange.startDate || !dailyRange.endDate || !weeklyRange.startDate || !weeklyRange.endDate) {
      return [];
    }

    // Fetch both columns in parallel, then commit to store once so both render together.
    const [daily, weekly] = await Promise.all([
      fetchDivergenceSignalsFromApi(`?start_date=${dailyRange.startDate}&end_date=${dailyRange.endDate}&timeframe=1d`),
      fetchDivergenceSignalsFromApi(
        `?start_date=${weeklyRange.startDate}&end_date=${weeklyRange.endDate}&timeframe=1w`,
      ),
    ]);
    const all = [...daily, ...weekly];
    setDivergenceSignals(all);
    primeDivergenceSummaryCacheFromAlerts(all);
    return all;
  } catch (error) {
    console.error('Error fetching divergence signals:', error);
    return [];
  }
}

/**
 * Fetch signals for a single timeframe and update only that timeframe's state.
 * Uses per-column feed mode for date range.
 * The other timeframe's signals are left completely untouched.
 */
export async function fetchDivergenceSignalsByTimeframe(timeframe: '1d' | '1w'): Promise<Alert[]> {
  try {
    const column: 'daily' | 'weekly' = timeframe === '1d' ? 'daily' : 'weekly';
    const mode = getColumnFeedMode(column);
    const custom = getColumnCustomDates(column);

    const { startDate, endDate } = getDateRangeForMode(mode, custom.from, custom.to);
    if (!startDate || !endDate) return [];

    const params = `?start_date=${startDate}&end_date=${endDate}&timeframe=${timeframe}`;
    const data = await fetchDivergenceSignalsFromApi(params);
    primeDivergenceSummaryCacheFromAlerts(data);
    setDivergenceSignalsByTimeframe(timeframe, data);
    return data;
  } catch (error) {
    console.error(`Error fetching divergence signals for ${timeframe}:`, error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function showMoreButtonHtml(shown: number, total: number, timeframe: '1d' | '1w'): string {
  if (shown >= total) return '';
  const remaining = total - shown;
  const nextBatch = Math.min(remaining, ALERTS_PAGE_SIZE);
  return `<button class="pane-btn show-more-btn" data-timeframe="${timeframe}">▼ Show ${nextBatch} more (${shown}/${total})</button>`;
}

export function renderDivergenceOverview(): void {
  const allSignals = getDivergenceSignals();
  primeDivergenceSummaryCacheFromAlerts(allSignals);
  const store = divergenceStore.getState();
  store.setColumnVisibleCount('daily', ALERTS_PAGE_SIZE);
  store.setColumnVisibleCount('weekly', ALERTS_PAGE_SIZE);
  const d = store.getColumn('daily');
  const w = store.getColumn('weekly');
  const dailyContainer = document.getElementById('divergence-daily-container');
  const weeklyContainer = document.getElementById('divergence-weekly-container');
  if (!dailyContainer || !weeklyContainer) return;

  let daily = allSignals.filter((a) => (a.timeframe || '').trim() === '1d');
  let weekly = allSignals.filter((a) => (a.timeframe || '').trim() === '1w');

  // Apply per-column date filter (last N fetch days)
  daily = applyColumnDateFilter(daily, d.feedMode);
  weekly = applyColumnDateFilter(weekly, w.feedMode);

  if (d.sortMode === 'favorite') {
    daily = daily.filter((a) => a.is_favorite);
  }
  if (w.sortMode === 'favorite') {
    weekly = weekly.filter((a) => a.is_favorite);
  }

  daily.sort(createAlertSortFn(d.sortMode === 'favorite' ? 'time' : d.sortMode, d.sortDirection));
  weekly.sort(createAlertSortFn(w.sortMode === 'favorite' ? 'time' : w.sortMode, w.sortDirection));

  const dailySlice = daily.slice(0, d.visibleCount);
  const weeklySlice = weekly.slice(0, w.visibleCount);

  // Detach existing inline minichart wrappers before innerHTML replacement to
  // preserve chart instances — same pattern as renderDivergenceContainer.
  const savedDailyMinicharts = detachInlineMinichartWrappers(dailyContainer);
  const savedWeeklyMinicharts = detachInlineMinichartWrappers(weeklyContainer);

  dailyContainer.innerHTML =
    dailySlice.map(createAlertCard).join('') + showMoreButtonHtml(dailySlice.length, daily.length, '1d');
  weeklyContainer.innerHTML =
    weeklySlice.map(createAlertCard).join('') + showMoreButtonHtml(weeklySlice.length, weekly.length, '1w');
  renderAlertCardDivergenceTablesFromCache(dailyContainer);
  renderAlertCardDivergenceTablesFromCache(weeklyContainer);

  reattachInlineMinichartWrappers(dailyContainer, savedDailyMinicharts);
  reattachInlineMinichartWrappers(weeklyContainer, savedWeeklyMinicharts);

  // Prefetch mini-chart bars for visible cards (best-effort, non-blocking)
  const prefetchTickers = [...dailySlice.map((a) => a.ticker), ...weeklySlice.map((a) => a.ticker)];
  const unique = Array.from(new Set(prefetchTickers.map((t) => t.toUpperCase())));
  prefetchMiniChartBars(unique)
    .then(() => {
      renderInlineMinicharts(dailyContainer);
      renderInlineMinicharts(weeklyContainer);
    })
    .catch(() => {
      // Fall back to per-card fetch path when batch prefetch fails.
      renderInlineMinicharts(dailyContainer);
      renderInlineMinicharts(weeklyContainer);
    });
}

/**
 * Re-render only a single timeframe container, leaving the other untouched.
 */
export function renderDivergenceContainer(timeframe: '1d' | '1w'): void {
  const allSignals = getDivergenceSignals();
  const containerId = timeframe === '1d' ? 'divergence-daily-container' : 'divergence-weekly-container';
  const container = document.getElementById(containerId);
  if (!container) return;

  const column: ColumnKey = timeframe === '1d' ? 'daily' : 'weekly';
  const s = divergenceStore.getState().getColumn(column);
  let signals = allSignals.filter((a) => (a.timeframe || '').trim() === timeframe);

  // Apply per-column date filter (last N fetch days)
  signals = applyColumnDateFilter(signals, s.feedMode);

  if (s.sortMode === 'favorite') {
    signals = signals.filter((a) => a.is_favorite);
  }

  signals.sort(createAlertSortFn(s.sortMode === 'favorite' ? 'time' : s.sortMode, s.sortDirection));

  const visibleCount = s.visibleCount;
  const slice = signals.slice(0, visibleCount);

  // Detach existing inline minichart wrappers before the innerHTML replacement.
  // Unobserving first prevents the IntersectionObserver from tearing down charts
  // during the detach — wrappers for cards still in the slice will be re-inserted
  // with their chart instances intact, eliminating minichart flicker on mobile.
  const savedMinicharts = detachInlineMinichartWrappers(container);

  container.innerHTML =
    slice.map(createAlertCard).join('') + showMoreButtonHtml(slice.length, signals.length, timeframe);
  renderAlertCardDivergenceTablesFromCache(container);

  // Re-insert saved wrappers (no flicker for existing charts), clean up dropped ones
  reattachInlineMinichartWrappers(container, savedMinicharts);

  // Prefetch mini-chart bars for visible cards (best-effort, non-blocking)
  const prefetchTickers = Array.from(new Set(slice.map((a) => a.ticker.toUpperCase())));
  prefetchMiniChartBars(prefetchTickers)
    .then(() => {
      // renderInlineMinicharts skips wrappers that already exist — only creates
      // new ones for cards added in this render (e.g. new tickers or "show more")
      renderInlineMinicharts(container);
    })
    .catch(() => {
      // Fall back to per-card fetch path when batch prefetch fails.
      renderInlineMinicharts(container);
    });
}

/**
 * Set the feed mode for a specific column (daily or weekly) independently.
 * Updates the dropdown UI and optionally re-fetches + re-renders that column.
 */
export function setColumnFeedMode(column: ColumnKey, mode: ColumnFeedMode, fetchData = true): void {
  divergenceStore.getState().setColumnFeedMode(column, mode);

  // Update button active state for all instances of this column
  document.querySelectorAll(`.column-tf-controls[data-column="${column}"]`).forEach((controls) => {
    controls.querySelectorAll('.pane-btn[data-tf]').forEach((btn) => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.tf === mode);
    });
  });

  if (fetchData) {
    const timeframe: '1d' | '1w' = column === 'daily' ? '1d' : '1w';
    fetchDivergenceSignalsByTimeframe(timeframe).then(() => renderDivergenceContainer(timeframe));
  }
}

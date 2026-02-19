/**
 * Feed rendering — sorting, filtering, column configuration, data fetching,
 * and DOM rendering of divergence signal alert cards.
 */

import { getDateRangeForMode, createAlertSortFn, updateSortButtonUi } from './utils';
import {
  fetchDivergenceSignalsFromApi,
} from './divergenceApi';
import {
  setDivergenceSignalsByTimeframe,
  getDivergenceSignals,
} from './divergenceState';
import { createAlertCard } from './components';
import {
  primeDivergenceSummaryCacheFromAlerts,
  renderAlertCardDivergenceTablesFromCache,
} from './divergenceTable';
import {
  prefetchMiniChartBars,
  renderInlineMinicharts,
  detachInlineMinichartWrappers,
  reattachInlineMinichartWrappers,
} from './divergenceMinichart';
import { SortMode, Alert } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ColumnFeedMode = '1' | '2' | '5' | 'custom';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALERTS_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let dailyFeedMode: ColumnFeedMode = '1';
let weeklyFeedMode: ColumnFeedMode = '1';
let dailyCustomFrom = '';
let dailyCustomTo = '';
let weeklyCustomFrom = '';
let weeklyCustomTo = '';
let dailySortMode: SortMode = 'score';
let weeklySortMode: SortMode = 'score';
let dailySortDirection: 'asc' | 'desc' = 'desc';
let weeklySortDirection: 'asc' | 'desc' = 'desc';
export let dailyVisibleCount = ALERTS_PAGE_SIZE;
export let weeklyVisibleCount = ALERTS_PAGE_SIZE;

// Exported mutators for event delegation module
export function incrementDailyVisibleCount(): void {
  dailyVisibleCount += ALERTS_PAGE_SIZE;
}
export function incrementWeeklyVisibleCount(): void {
  weeklyVisibleCount += ALERTS_PAGE_SIZE;
}

// ---------------------------------------------------------------------------
// Column feed configuration
// ---------------------------------------------------------------------------

export function getColumnFeedMode(column: 'daily' | 'weekly'): ColumnFeedMode {
  return column === 'daily' ? dailyFeedMode : weeklyFeedMode;
}

export function setColumnCustomDates(column: 'daily' | 'weekly', from: string, to: string): void {
  if (column === 'daily') {
    dailyCustomFrom = from;
    dailyCustomTo = to;
  } else {
    weeklyCustomFrom = from;
    weeklyCustomTo = to;
  }
}

export function getColumnCustomDates(column: 'daily' | 'weekly'): { from: string; to: string } {
  return column === 'daily'
    ? { from: dailyCustomFrom, to: dailyCustomTo }
    : { from: weeklyCustomFrom, to: weeklyCustomTo };
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
  if (mode === '2') return filterToLatestNDates(alerts, 2);
  if (mode === '5') return filterToLatestNDates(alerts, 5);
  return alerts; // 'custom' — server already filtered
}

// ---------------------------------------------------------------------------
// Sort defaults
// ---------------------------------------------------------------------------

export function initializeDivergenceSortDefaults(): void {
  dailySortMode = 'score';
  dailySortDirection = 'desc';
  weeklySortMode = 'score';
  weeklySortDirection = 'desc';
  dailyFeedMode = '1';
  weeklyFeedMode = '1';
  updateSortButtonUi('#view-divergence .divergence-daily-sort', dailySortMode, dailySortDirection);
  updateSortButtonUi('#view-divergence .divergence-weekly-sort', weeklySortMode, weeklySortDirection);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export function setDivergenceDailySort(mode: SortMode): void {
  if (mode === dailySortMode && mode !== 'favorite') {
    dailySortDirection = dailySortDirection === 'desc' ? 'asc' : 'desc';
  } else {
    dailySortMode = mode;
    dailySortDirection = 'desc';
  }
  dailyVisibleCount = ALERTS_PAGE_SIZE;
  updateSortButtonUi('#view-divergence .divergence-daily-sort', dailySortMode, dailySortDirection);
  renderDivergenceContainer('1d');
}

export function setDivergenceWeeklySort(mode: SortMode): void {
  if (mode === weeklySortMode && mode !== 'favorite') {
    weeklySortDirection = weeklySortDirection === 'desc' ? 'asc' : 'desc';
  } else {
    weeklySortMode = mode;
    weeklySortDirection = 'desc';
  }
  weeklyVisibleCount = ALERTS_PAGE_SIZE;
  updateSortButtonUi('#view-divergence .divergence-weekly-sort', weeklySortMode, weeklySortDirection);
  renderDivergenceContainer('1w');
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export async function fetchDivergenceSignals(_force?: boolean): Promise<Alert[]> {
  try {
    // Fetch both columns independently using their per-column modes
    const [daily, weekly] = await Promise.all([
      fetchDivergenceSignalsByTimeframe('1d'),
      fetchDivergenceSignalsByTimeframe('1w'),
    ]);
    const all = [...daily, ...weekly];
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
  dailyVisibleCount = ALERTS_PAGE_SIZE;
  weeklyVisibleCount = ALERTS_PAGE_SIZE;
  const dailyContainer = document.getElementById('divergence-daily-container');
  const weeklyContainer = document.getElementById('divergence-weekly-container');
  if (!dailyContainer || !weeklyContainer) return;

  let daily = allSignals.filter((a) => (a.timeframe || '').trim() === '1d');
  let weekly = allSignals.filter((a) => (a.timeframe || '').trim() === '1w');

  // Apply per-column date filter (last N fetch days)
  daily = applyColumnDateFilter(daily, dailyFeedMode);
  weekly = applyColumnDateFilter(weekly, weeklyFeedMode);

  if (dailySortMode === 'favorite') {
    daily = daily.filter((a) => a.is_favorite);
  }
  if (weeklySortMode === 'favorite') {
    weekly = weekly.filter((a) => a.is_favorite);
  }

  daily.sort(createAlertSortFn(dailySortMode === 'favorite' ? 'time' : dailySortMode, dailySortDirection));
  weekly.sort(createAlertSortFn(weeklySortMode === 'favorite' ? 'time' : weeklySortMode, weeklySortDirection));

  const dailySlice = daily.slice(0, dailyVisibleCount);
  const weeklySlice = weekly.slice(0, weeklyVisibleCount);

  dailyContainer.innerHTML =
    dailySlice.map(createAlertCard).join('') + showMoreButtonHtml(dailySlice.length, daily.length, '1d');
  weeklyContainer.innerHTML =
    weeklySlice.map(createAlertCard).join('') + showMoreButtonHtml(weeklySlice.length, weekly.length, '1w');
  renderAlertCardDivergenceTablesFromCache(dailyContainer);
  renderAlertCardDivergenceTablesFromCache(weeklyContainer);

  // Prefetch mini-chart bars for visible cards (best-effort, non-blocking)
  const prefetchTickers = [...dailySlice.map((a) => a.ticker), ...weeklySlice.map((a) => a.ticker)];
  const unique = Array.from(new Set(prefetchTickers.map((t) => t.toUpperCase())));
  prefetchMiniChartBars(unique)
    .then(() => {
      renderInlineMinicharts(dailyContainer);
      renderInlineMinicharts(weeklyContainer);
    })
    .catch(() => {});
}

/**
 * Re-render only a single timeframe container, leaving the other untouched.
 */
export function renderDivergenceContainer(timeframe: '1d' | '1w'): void {
  const allSignals = getDivergenceSignals();
  const containerId = timeframe === '1d' ? 'divergence-daily-container' : 'divergence-weekly-container';
  const container = document.getElementById(containerId);
  if (!container) return;

  const column: 'daily' | 'weekly' = timeframe === '1d' ? 'daily' : 'weekly';
  const mode = getColumnFeedMode(column);
  const sortMode = timeframe === '1d' ? dailySortMode : weeklySortMode;
  const sortDirection = timeframe === '1d' ? dailySortDirection : weeklySortDirection;
  let signals = allSignals.filter((a) => (a.timeframe || '').trim() === timeframe);

  // Apply per-column date filter (last N fetch days)
  signals = applyColumnDateFilter(signals, mode);

  if (sortMode === 'favorite') {
    signals = signals.filter((a) => a.is_favorite);
  }

  signals.sort(createAlertSortFn(sortMode === 'favorite' ? 'time' : sortMode, sortDirection));

  const visibleCount = timeframe === '1d' ? dailyVisibleCount : weeklyVisibleCount;
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
    .catch(() => {});
}

/**
 * Set the feed mode for a specific column (daily or weekly) independently.
 * Updates the dropdown UI and optionally re-fetches + re-renders that column.
 */
export function setColumnFeedMode(column: 'daily' | 'weekly', mode: ColumnFeedMode, fetchData = true): void {
  if (column === 'daily') {
    dailyFeedMode = mode;
  } else {
    weeklyFeedMode = mode;
  }

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

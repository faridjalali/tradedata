import { getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { SortMode } from './types';
import { createAlertSortFn, updateSortButtonUi } from './utils';
import { renderCustomChart } from './chart';
import { getColumnFeedMode, filterToLatestNDates, ColumnFeedMode } from './divergenceFeed';
import { appStore } from './store/appStore';

let tickerDailySortMode: SortMode = 'score';
let tickerWeeklySortMode: SortMode = 'score';
let tickerDailySortDirection: 'asc' | 'desc' = 'desc';
let tickerWeeklySortDirection: 'asc' | 'desc' = 'desc';
let tickerDailyPreFavSort: { mode: SortMode; direction: 'asc' | 'desc' } | null = null;
let tickerWeeklyPreFavSort: { mode: SortMode; direction: 'asc' | 'desc' } | null = null;

interface RenderTickerViewOptions {
  refreshCharts?: boolean;
}

export function setTickerDailySort(mode: SortMode): void {
  if (mode === 'favorite' && tickerDailySortMode === 'favorite') {
    tickerDailySortMode = tickerDailyPreFavSort?.mode ?? 'score';
    tickerDailySortDirection = tickerDailyPreFavSort?.direction ?? 'desc';
    tickerDailyPreFavSort = null;
  } else if (mode === 'favorite') {
    tickerDailyPreFavSort = { mode: tickerDailySortMode, direction: tickerDailySortDirection };
    tickerDailySortMode = 'favorite';
    tickerDailySortDirection = 'desc';
  } else if (mode === tickerDailySortMode) {
    tickerDailySortDirection = tickerDailySortDirection === 'desc' ? 'asc' : 'desc';
  } else {
    tickerDailySortMode = mode;
    tickerDailySortDirection = 'desc';
    tickerDailyPreFavSort = null;
  }
  updateSortButtonUi('.ticker-daily-sort', tickerDailySortMode, tickerDailySortDirection);
  const currentTicker = appStore.getState().selectedTicker;
  if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
}

export function setTickerWeeklySort(mode: SortMode): void {
  if (mode === 'favorite' && tickerWeeklySortMode === 'favorite') {
    tickerWeeklySortMode = tickerWeeklyPreFavSort?.mode ?? 'score';
    tickerWeeklySortDirection = tickerWeeklyPreFavSort?.direction ?? 'desc';
    tickerWeeklyPreFavSort = null;
  } else if (mode === 'favorite') {
    tickerWeeklyPreFavSort = { mode: tickerWeeklySortMode, direction: tickerWeeklySortDirection };
    tickerWeeklySortMode = 'favorite';
    tickerWeeklySortDirection = 'desc';
  } else if (mode === tickerWeeklySortMode) {
    tickerWeeklySortDirection = tickerWeeklySortDirection === 'desc' ? 'asc' : 'desc';
  } else {
    tickerWeeklySortMode = mode;
    tickerWeeklySortDirection = 'desc';
    tickerWeeklyPreFavSort = null;
  }
  updateSortButtonUi('.ticker-weekly-sort', tickerWeeklySortMode, tickerWeeklySortDirection);
  const currentTicker = appStore.getState().selectedTicker;
  if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
}

export function renderTickerView(ticker: string, options: RenderTickerViewOptions = {}): void {
  const refreshCharts = options.refreshCharts !== false;
  updateSortButtonUi('#ticker-view .ticker-daily-sort', tickerDailySortMode, tickerDailySortDirection);
  updateSortButtonUi('#ticker-view .ticker-weekly-sort', tickerWeeklySortMode, tickerWeeklySortDirection);
  const allAlerts = getDivergenceSignals();
  primeDivergenceSummaryCacheFromAlerts(allAlerts);
  const alerts = allAlerts.filter((a) => a.ticker === ticker);

  let daily = alerts.filter((a) => (a.timeframe || '').trim() === '1d');
  let weekly = alerts.filter((a) => (a.timeframe || '').trim() === '1w');

  // Apply per-column date filter (last N fetch days)
  const applyTickerDateFilter = (alerts: typeof daily, mode: ColumnFeedMode) => {
    if (mode === '1') return filterToLatestNDates(alerts, 1);
    if (mode === '5') return filterToLatestNDates(alerts, 5);
    if (mode === '30') return filterToLatestNDates(alerts, 30);
    return alerts;
  };
  daily = applyTickerDateFilter(daily, getColumnFeedMode('daily'));
  weekly = applyTickerDateFilter(weekly, getColumnFeedMode('weekly'));

  if (tickerDailySortMode === 'favorite') {
    daily = daily.filter((a) => a.is_favorite);
  }
  if (tickerWeeklySortMode === 'favorite') {
    weekly = weekly.filter((a) => a.is_favorite);
  }

  daily.sort(
    createAlertSortFn(tickerDailySortMode === 'favorite' ? 'time' : tickerDailySortMode, tickerDailySortDirection),
  );
  weekly.sort(
    createAlertSortFn(tickerWeeklySortMode === 'favorite' ? 'time' : tickerWeeklySortMode, tickerWeeklySortDirection),
  );

  // renderAvg removed

  const dailyContainer = document.getElementById('ticker-daily-container');
  if (dailyContainer) {
    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    if (daily.length > 0) renderAlertCardDivergenceTablesFromCache(dailyContainer);
  }

  const weeklyContainer = document.getElementById('ticker-weekly-container');
  if (weeklyContainer) {
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    if (weekly.length > 0) renderAlertCardDivergenceTablesFromCache(weeklyContainer);
  }

  if (refreshCharts) {
    renderCustomChart(ticker);
  }
}

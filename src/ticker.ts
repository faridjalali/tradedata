import { getAlerts } from './state';
import { getDivergenceSignals } from './divergenceState';
import { createAlertCard } from './components';
import { primeDivergenceSummaryCacheFromAlerts, renderAlertCardDivergenceTablesFromCache } from './divergenceTable';
import { SortMode } from './types';
import { createAlertSortFn, updateSortButtonUi } from './utils';
import { renderCustomChart } from './chart';
import { getColumnFeedMode, filterToLatestNDates, ColumnFeedMode } from './divergenceFeed';

let tickerDailySortMode: SortMode = 'score';
let tickerWeeklySortMode: SortMode = 'score';
let tickerDailySortDirection: 'asc' | 'desc' = 'desc';
let tickerWeeklySortDirection: 'asc' | 'desc' = 'desc';

interface RenderTickerViewOptions {
  refreshCharts?: boolean;
}

export function setTickerDailySort(mode: SortMode): void {
  if (mode === tickerDailySortMode && mode !== 'favorite') {
    tickerDailySortDirection = tickerDailySortDirection === 'desc' ? 'asc' : 'desc';
  } else {
    tickerDailySortMode = mode;
    tickerDailySortDirection = 'desc';
  }
  updateSortButtonUi('.ticker-daily-sort', tickerDailySortMode, tickerDailySortDirection);
  const tickerContainer = document.getElementById('ticker-view');
  if (!tickerContainer) return;
  const currentTicker = tickerContainer.dataset.ticker;
  if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
}

export function setTickerWeeklySort(mode: SortMode): void {
  if (mode === tickerWeeklySortMode && mode !== 'favorite') {
    tickerWeeklySortDirection = tickerWeeklySortDirection === 'desc' ? 'asc' : 'desc';
  } else {
    tickerWeeklySortMode = mode;
    tickerWeeklySortDirection = 'desc';
  }
  updateSortButtonUi('.ticker-weekly-sort', tickerWeeklySortMode, tickerWeeklySortDirection);
  const tickerContainer = document.getElementById('ticker-view');
  if (!tickerContainer) return;
  const currentTicker = tickerContainer.dataset.ticker;
  if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
}

export function renderTickerView(ticker: string, options: RenderTickerViewOptions = {}): void {
  const refreshCharts = options.refreshCharts !== false;
  const allAlerts = [...getAlerts(), ...getDivergenceSignals()];
  primeDivergenceSummaryCacheFromAlerts(allAlerts);
  const alerts = allAlerts.filter((a) => a.ticker === ticker);

  let daily = alerts.filter((a) => (a.timeframe || '').trim() === '1d');
  let weekly = alerts.filter((a) => (a.timeframe || '').trim() === '1w');

  // Apply per-column date filter (last N fetch days)
  const applyTickerDateFilter = (alerts: typeof daily, mode: ColumnFeedMode) => {
    if (mode === '1') return filterToLatestNDates(alerts, 1);
    if (mode === '2') return filterToLatestNDates(alerts, 2);
    if (mode === '5') return filterToLatestNDates(alerts, 5);
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

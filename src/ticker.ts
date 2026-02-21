import { getDivergenceSignals } from './divergenceState';
import { primeDivergenceSummaryCacheFromAlerts } from './divergenceTable';
import type { SortMode, Alert } from './types';
import { createAlertSortFn, updateSortButtonUi, escapeHtml } from './utils';
import { renderCustomChart } from './chart';
import { getColumnFeedMode, filterToLatestNDates, ColumnFeedMode } from './divergenceFeed';
import { appStore } from './store/appStore';
import { buildChartDataCacheKey, getCachedChartData } from './chartDataCache';
import { dayKeyInAppTimeZone, unixSecondsFromTimeValue } from './chartTimeUtils';
import type { CandleBar } from '../shared/api-types';

let tickerDailySortMode: SortMode = 'time';
let tickerWeeklySortMode: SortMode = 'time';
let tickerDailySortDirection: 'asc' | 'desc' = 'desc';
let tickerWeeklySortDirection: 'asc' | 'desc' = 'desc';
let tickerDailyPreFavSort: { mode: SortMode; direction: 'asc' | 'desc' } | null = null;
let tickerWeeklyPreFavSort: { mode: SortMode; direction: 'asc' | 'desc' } | null = null;

interface RenderTickerViewOptions {
  refreshCharts?: boolean;
}

interface TickerAlertChartMetrics {
  volumeDelta: number | null;
  priceChangePct: number | null;
}

function formatAlertCardDate(rawDate: string | null | undefined): string {
  const value = String(rawDate || '').trim();
  if (!value) return '';

  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnlyMatch) {
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    if (Number.isFinite(month) && month > 0 && Number.isFinite(day) && day > 0) {
      return `${month}/${day}`;
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
}

function getAlertTradeDateKey(alert: Alert): string | null {
  const direct = String(alert.signal_trade_date || alert.divergence_trade_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;

  const ts = String(alert.timestamp || '').trim();
  const datePart = ts.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;

  if (ts) {
    const parsed = new Date(ts);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

function formatSignedPercent(value: number | null): string {
  if (!Number.isFinite(Number(value))) return '';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatSignedVolumeDelta(value: number | null): string {
  if (!Number.isFinite(Number(value))) return '';
  const numeric = Number(value);
  const abs = Math.abs(numeric);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

function metricToneClass(value: number | null): string {
  if (!Number.isFinite(Number(value))) return 'is-neutral';
  const numeric = Number(value);
  if (numeric > 0) return 'is-positive';
  if (numeric < 0) return 'is-negative';
  return 'is-neutral';
}

function getChartMetricsByDateForTicker(ticker: string): Map<string, TickerAlertChartMetrics> {
  const result = new Map<string, TickerAlertChartMetrics>();
  const cacheKey = buildChartDataCacheKey(ticker, '1day');
  const data = getCachedChartData(cacheKey);
  if (!data) return result;

  const bars = Array.isArray(data.bars) ? (data.bars as CandleBar[]) : [];
  const priceByDate = new Map<string, number>();
  if (bars.length >= 2) {
    for (let i = 1; i < bars.length; i++) {
      const currClose = Number(bars[i]?.close);
      const prevClose = Number(bars[i - 1]?.close);
      if (!Number.isFinite(currClose) || !Number.isFinite(prevClose) || prevClose === 0) continue;
      const unix = unixSecondsFromTimeValue(bars[i].time);
      if (!Number.isFinite(unix)) continue;
      const dateKey = dayKeyInAppTimeZone(Number(unix));
      priceByDate.set(dateKey, ((currClose - prevClose) / prevClose) * 100);
    }
  }

  const volumeByDate = new Map<string, number>();
  const volumeDeltaSeries = Array.isArray(data.volumeDelta) ? data.volumeDelta : [];
  for (const point of volumeDeltaSeries) {
    const delta = Number(point?.delta);
    if (!Number.isFinite(delta)) continue;
    const unix = unixSecondsFromTimeValue(point.time);
    if (!Number.isFinite(unix)) continue;
    const dateKey = dayKeyInAppTimeZone(Number(unix));
    volumeByDate.set(dateKey, delta);
  }

  const dates = new Set<string>([...priceByDate.keys(), ...volumeByDate.keys()]);
  for (const date of dates) {
    result.set(date, {
      volumeDelta: volumeByDate.has(date) ? Number(volumeByDate.get(date)) : null,
      priceChangePct: priceByDate.has(date) ? Number(priceByDate.get(date)) : null,
    });
  }

  return result;
}

function createTickerAlertCard(alert: Alert, metricsByDate: Map<string, TickerAlertChartMetrics>): string {
  const source = 'DataAPI';
  const isFav = alert.is_favorite === true || String(alert.is_favorite).toLowerCase() === 'true';
  const starClass = isFav ? 'filled' : '';
  const checkmarkVisibility = isFav ? 'visible' : 'hidden';
  const checkmarkOpacity = isFav ? '1' : '0';
  const tradeDateKey = getAlertTradeDateKey(alert);
  const metrics = tradeDateKey ? metricsByDate.get(tradeDateKey) : undefined;

  const volumeDelta = metrics?.volumeDelta ?? null;
  const priceChangePct = metrics?.priceChangePct ?? null;
  const volumeTone = metricToneClass(volumeDelta);
  const priceTone = metricToneClass(priceChangePct);
  const dateLabel =
    formatAlertCardDate(alert.signal_trade_date || alert.divergence_trade_date || alert.timestamp) || '--';

  const cardClass =
    Number(alert.signal_direction) === 1
      ? 'bullish-card'
      : Number(alert.signal_direction) === -1
        ? 'bearish-card'
        : String(alert.signal_type || '')
              .toLowerCase()
              .includes('bull')
          ? 'bullish-card'
          : String(alert.signal_type || '').trim()
            ? 'bearish-card'
            : '';

  return `
    <div class="alert-card ticker-alert-card ${cardClass}" data-ticker="${escapeHtml(alert.ticker)}" data-source="${source}">
      <div class="card-group card-group-id">
        <svg class="fav-icon ${starClass}" data-id="${alert.id}" data-source="${source}" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.25" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <polyline class="check-mark" points="7.5 12.5 10.5 15.5 16.5 9.5" style="visibility: ${checkmarkVisibility}; opacity: ${checkmarkOpacity};"></polyline>
        </svg>
        <h3>${escapeHtml(alert.ticker)}</h3>
      </div>
      <span class="ticker-alert-vd ${volumeTone}" title="Volume Delta">${escapeHtml(formatSignedVolumeDelta(volumeDelta))}</span>
      <span class="ticker-alert-price ${priceTone}" title="Price Change">${escapeHtml(formatSignedPercent(priceChangePct))}</span>
      <span class="alert-time">${escapeHtml(dateLabel)}</span>
    </div>
  `;
}

export function setTickerDailySort(mode: SortMode): void {
  if (mode === 'favorite' && tickerDailySortMode === 'favorite') {
    tickerDailySortMode = tickerDailyPreFavSort?.mode ?? 'time';
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
    tickerWeeklySortMode = tickerWeeklyPreFavSort?.mode ?? 'time';
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
  const chartMetricsByDate = getChartMetricsByDateForTicker(ticker);
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
    dailyContainer.innerHTML = daily.map((alert) => createTickerAlertCard(alert, chartMetricsByDate)).join('');
  }

  const weeklyContainer = document.getElementById('ticker-weekly-container');
  if (weeklyContainer) {
    weeklyContainer.innerHTML = weekly.map((alert) => createTickerAlertCard(alert, chartMetricsByDate)).join('');
  }

  if (refreshCharts) {
    renderCustomChart(ticker)
      .then(() => {
        if (appStore.getState().selectedTicker === ticker) {
          renderTickerView(ticker, { refreshCharts: false });
        }
      })
      .catch(() => {});
  }
}

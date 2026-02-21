import { getDivergenceSignals } from './divergenceState';
import { primeDivergenceSummaryCacheFromAlerts } from './divergenceTable';
import type { SortMode, Alert } from './types';
import { createAlertSortFn, updateSortButtonUi, escapeHtml } from './utils';
import { renderCustomChart } from './chart';
import { getColumnFeedMode, filterToLatestNDates, ColumnFeedMode } from './divergenceFeed';
import { appStore } from './store/appStore';
import { buildChartDataCacheKey, getCachedChartData, getCachedChartDataByTickerInterval } from './chartDataCache';
import { timeKey, unixSecondsFromTimeValue } from './chartTimeUtils';
import type { CandleBar } from '../shared/api-types';

let tickerDailySortMode: SortMode = 'time';
let tickerWeeklySortMode: SortMode = 'time';
let tickerDailySortDirection: 'asc' | 'desc' = 'desc';
let tickerWeeklySortDirection: 'asc' | 'desc' = 'desc';
let tickerDailyPreFavSort: { mode: SortMode; direction: 'asc' | 'desc' } | null = null;
let tickerWeeklyPreFavSort: { mode: SortMode; direction: 'asc' | 'desc' } | null = null;
let scheduledTickerChartRenderToken = 0;

interface RenderTickerViewOptions {
  refreshCharts?: boolean;
}

interface TickerAlertChartMetrics {
  volumeDelta: number | null;
  priceChangePct: number | null;
}

interface DailyMetricPoint {
  dateKey: string;
  close: number;
  volumeDelta: number | null;
}

interface ChartDataReadyDetail {
  ticker?: string;
}

let chartDataReadyListenerBound = false;

function ensureTickerChartDataReadyListener(): void {
  if (chartDataReadyListenerBound || typeof window === 'undefined') return;
  chartDataReadyListenerBound = true;
  window.addEventListener('chartdataready', (event: Event) => {
    const detail = (event as CustomEvent<ChartDataReadyDetail>).detail;
    const readyTicker = String(detail?.ticker || '')
      .trim()
      .toUpperCase();
    const selectedTicker = String(appStore.getState().selectedTicker || '')
      .trim()
      .toUpperCase();
    if (!readyTicker || !selectedTicker || readyTicker !== selectedTicker) return;
    renderTickerView(selectedTicker, { refreshCharts: false });
  });
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

function toUtcDateKey(time: string | number): string | null {
  if (typeof time === 'string') {
    const datePart = time.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (datePart) return datePart;
  }
  const unix = unixSecondsFromTimeValue(time);
  if (!Number.isFinite(unix)) return null;
  return new Date(Number(unix) * 1000).toISOString().slice(0, 10);
}

function buildVolumeDeltaLookupKeys(time: string | number): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  push(`raw:${timeKey(time)}`);
  const unix = unixSecondsFromTimeValue(time);
  if (Number.isFinite(unix)) {
    push(`unix:${Number(unix)}`);
    push(`date:${new Date(Number(unix) * 1000).toISOString().slice(0, 10)}`);
  }
  const datePart = typeof time === 'string' ? time.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] : null;
  if (datePart) push(`date:${datePart}`);
  return keys;
}

function buildMetricsFromChartData(data: unknown): {
  byDate: Map<string, TickerAlertChartMetrics>;
  dailyPoints: DailyMetricPoint[];
} {
  const result = new Map<string, TickerAlertChartMetrics>();
  const dailyPoints: DailyMetricPoint[] = [];
  if (!data || typeof data !== 'object') return { byDate: result, dailyPoints };

  const dataLike = data as { bars?: CandleBar[]; volumeDelta?: Array<{ time: string | number; delta: number }> };
  const bars = Array.isArray(dataLike.bars) ? (dataLike.bars as CandleBar[]) : [];
  const priceByDate = new Map<string, number>();
  const volumeByDate = new Map<string, number>();

  const volumeDeltaLookup = new Map<string, number>();
  const volumeDeltaSeries = Array.isArray(dataLike.volumeDelta) ? dataLike.volumeDelta : [];
  for (const point of volumeDeltaSeries) {
    const delta = Number(point?.delta);
    if (!Number.isFinite(delta)) continue;
    for (const key of buildVolumeDeltaLookupKeys(point.time)) {
      volumeDeltaLookup.set(key, delta);
    }
  }

  const resolveVolumeDeltaForBar = (barTime: string | number): number | null => {
    for (const key of buildVolumeDeltaLookupKeys(barTime)) {
      const value = Number(volumeDeltaLookup.get(key));
      if (Number.isFinite(value)) return value;
    }
    return null;
  };

  for (const bar of bars) {
    const dateKey = toUtcDateKey(bar.time);
    if (!dateKey) continue;
    const delta = resolveVolumeDeltaForBar(bar.time);
    if (delta !== null) volumeByDate.set(dateKey, delta);
    const close = Number(bar.close);
    if (Number.isFinite(close)) {
      dailyPoints.push({
        dateKey,
        close: Number(close),
        volumeDelta: delta,
      });
    }
  }

  if (bars.length >= 2) {
    for (let i = 1; i < bars.length; i++) {
      const currClose = Number(bars[i]?.close);
      const prevClose = Number(bars[i - 1]?.close);
      if (!Number.isFinite(currClose) || !Number.isFinite(prevClose) || prevClose === 0) continue;
      const dateKey = toUtcDateKey(bars[i].time);
      if (!dateKey) continue;
      priceByDate.set(dateKey, ((currClose - prevClose) / prevClose) * 100);
    }
  }

  const dates = new Set<string>([...priceByDate.keys(), ...volumeByDate.keys()]);
  for (const date of dates) {
    result.set(date, {
      volumeDelta: volumeByDate.has(date) ? Number(volumeByDate.get(date)) : null,
      priceChangePct: priceByDate.has(date) ? Number(priceByDate.get(date)) : null,
    });
  }

  return { byDate: result, dailyPoints };
}

function weekStartUtcFromDateKey(dateKey: string): string | null {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const dt = new Date(`${dateKey}T12:00:00Z`);
  if (!Number.isFinite(dt.getTime())) return null;
  const dow = dt.getUTCDay();
  const monday = new Date(dt);
  monday.setUTCDate(monday.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return monday.toISOString().slice(0, 10);
}

function buildWeeklyMetricsFromDailyPoints(points: DailyMetricPoint[]): Map<string, TickerAlertChartMetrics> {
  const out = new Map<string, TickerAlertChartMetrics>();
  if (!Array.isArray(points) || points.length === 0) return out;

  const sorted = [...points].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const weeks = new Map<string, DailyMetricPoint[]>();
  for (const point of sorted) {
    const wk = weekStartUtcFromDateKey(point.dateKey);
    if (!wk) continue;
    if (!weeks.has(wk)) weeks.set(wk, []);
    weeks.get(wk)!.push(point);
  }

  const orderedWeeks = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let prevWeekClose: number | null = null;
  for (const [, weekPoints] of orderedWeeks) {
    if (!weekPoints.length) continue;
    const last = weekPoints[weekPoints.length - 1];
    const weekClose = Number(last.close);
    const priceChangePct =
      Number.isFinite(prevWeekClose) && prevWeekClose !== 0 && Number.isFinite(weekClose)
        ? ((weekClose - Number(prevWeekClose)) / Number(prevWeekClose)) * 100
        : null;

    const deltas = weekPoints
      .map((p) => Number(p.volumeDelta))
      .filter((v) => Number.isFinite(v))
      .map((v) => Number(v));
    const volumeDelta = deltas.length ? deltas.reduce((sum, v) => sum + v, 0) : null;

    for (const point of weekPoints) {
      out.set(point.dateKey, {
        volumeDelta,
        priceChangePct,
      });
    }

    prevWeekClose = Number.isFinite(weekClose) ? weekClose : prevWeekClose;
  }
  return out;
}

function getChartMetricsByDateForTicker(ticker: string): {
  dailyByDate: Map<string, TickerAlertChartMetrics>;
  weeklyByDate: Map<string, TickerAlertChartMetrics>;
} {
  const dailyData =
    getCachedChartData(buildChartDataCacheKey(ticker, '1day')) || getCachedChartDataByTickerInterval(ticker, '1day');
  const weeklyData =
    getCachedChartData(buildChartDataCacheKey(ticker, '1week')) || getCachedChartDataByTickerInterval(ticker, '1week');

  const dailyBundle = buildMetricsFromChartData(dailyData);
  const weeklyBundle = buildMetricsFromChartData(weeklyData);
  const weeklyFromDaily = buildWeeklyMetricsFromDailyPoints(dailyBundle.dailyPoints);

  const weeklyByDate = new Map<string, TickerAlertChartMetrics>(weeklyFromDaily);
  for (const [date, metrics] of weeklyBundle.byDate.entries()) {
    weeklyByDate.set(date, metrics);
  }

  return {
    dailyByDate: dailyBundle.byDate,
    weeklyByDate,
  };
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
  ensureTickerChartDataReadyListener();
  const refreshCharts = options.refreshCharts !== false;
  const normalizedTicker = String(ticker || '')
    .trim()
    .toUpperCase();
  if (!normalizedTicker) return;
  updateSortButtonUi('#ticker-view .ticker-daily-sort', tickerDailySortMode, tickerDailySortDirection);
  updateSortButtonUi('#ticker-view .ticker-weekly-sort', tickerWeeklySortMode, tickerWeeklySortDirection);
  const allAlerts = getDivergenceSignals();
  primeDivergenceSummaryCacheFromAlerts(allAlerts);
  const { dailyByDate, weeklyByDate } = getChartMetricsByDateForTicker(normalizedTicker);
  const alerts = allAlerts.filter((a) => a.ticker === normalizedTicker);

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
    dailyContainer.innerHTML = daily.map((alert) => createTickerAlertCard(alert, dailyByDate)).join('');
  }

  const weeklyContainer = document.getElementById('ticker-weekly-container');
  if (weeklyContainer) {
    weeklyContainer.innerHTML = weekly.map((alert) => createTickerAlertCard(alert, weeklyByDate)).join('');
  }

  if (refreshCharts) {
    const renderToken = ++scheduledTickerChartRenderToken;
    const startChartRender = () => {
      if (renderToken !== scheduledTickerChartRenderToken) return;
      const selectedTicker = String(appStore.getState().selectedTicker || '')
        .trim()
        .toUpperCase();
      if (selectedTicker !== normalizedTicker) return;
      renderCustomChart(normalizedTicker)
        .then(() => {
          if (appStore.getState().selectedTicker === normalizedTicker) {
            renderTickerView(normalizedTicker, { refreshCharts: false });
          }
        })
        .catch(() => {});
    };

    // Defer heavy chart startup until after this frame so alert cards paint first.
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        window.setTimeout(startChartRender, 0);
      });
    } else {
      setTimeout(startChartRender, 0);
    }
  }
}

import { createChart, CrosshairMode } from 'lightweight-charts';
import { fetchChartData, fetchChartLatestData, ChartData, ChartLatestData, ChartInterval, CandleBar } from './chartApi';
import type { TickerInfoPayload } from '../shared/api-types';
import { RSIChart } from './rsi';
import { ensureVDFAnalysisPanel, clearVDFAnalysisPanel, renderVDFAnalysisPanel } from './vdfAnalysisPanel';
import { getThemeColors } from './theme';
import {
  unixSecondsFromTimeValue,
  formatTimeScaleTickMark,
  buildMonthBoundaryTimes,
  timeKey,
  toUnixSeconds,
} from './chartTimeUtils';
import {
  buildRSISeriesFromBars,
  normalizeValueSeries,
  computeSMA,
  computeEMA,
  buildDailyMAValuesForBars,
  isRenderableMaValue,
} from './chartIndicators';
import { recordChartFetchPerf, recordChartRenderPerf, exposeChartPerfMetrics } from './chartPerf';
import {
  buildChartDataCacheKey,
  getCachedChartData,
  setCachedChartData,
  evictCachedChartData,
  getLastBarSignature,
  schedulePersistChartDataCacheToSession,
} from './chartDataCache';
import { navigateChart, getNeighborTicker, initPaneAxisNavigation } from './chartNavigation';
import {
  initVDF,
  ensureVDFButton,
  ensureBullFlagButton,
  ensureVDFRefreshButton,
  ensureVDZoneOverlay,
  renderVDFRefreshIcon,
  runVDFDetection,
  refreshVDZones,
  renderVDZones,
  setRefreshButtonLoading,
} from './chartVDF';
import {
  initSettingsUI,
  persistSettingsToStorage,
  ensureSettingsLoadedFromStorage,
  hideSettingsPanels,
  syncPriceSettingsPanelValues,
  syncRSISettingsPanelValues,
  syncVolumeDeltaSettingsPanelValues,
  syncVolumeDeltaRSISettingsPanelValues,
  createPriceSettingsPanel,
  createRSISettingsPanel,
  createVolumeDeltaSettingsPanel,
  createVolumeDeltaRSISettingsPanel,
  getPriceSettingsPanel,
  getRsiSettingsPanel,
  getVolumeDeltaSettingsPanel,
  getVolumeDeltaRsiSettingsPanel,
} from './chartSettingsUI';
import {
  initDivergencePlot,
  isRsiDivergencePlotToolActive,
  isVolumeDeltaRsiDivergencePlotToolActive,
  toggleRsiDivergencePlotTool,
  toggleVolumeDeltaRsiDivergencePlotTool,
  deactivateRsiDivergencePlotTool,
  deactivateVolumeDeltaRsiDivergencePlotTool,
  updateRsiDivergencePlotPoint,
  updateVolumeDeltaRsiDivergencePlotPoint,
  refreshActiveDivergenceOverlays,
  deactivateInteractivePaneToolsFromEscape,
} from './chartDivergencePlot';
import { showLoadingOverlay, showRetryOverlay, hideLoadingOverlay, reapplyInlineThemeStyles } from './chartOverlays';
import {
  initVDTrendlines,
  setVDTrendlineData,
  resetVDTrendlineData,
  updateVDRsiLastPoint,
  isVolumeDeltaDivergenceToolActive,
  isVolumeDeltaSyncSuppressed,
  fixedVolumeDeltaAutoscaleInfoProvider,
  normalizeVolumeDeltaValue,
  refreshVolumeDeltaTrendlineCrossLabels,
  deactivateVolumeDeltaDivergenceTool,
  activateVolumeDeltaDivergenceTool,
  clearVolumeDeltaDivergence,
  detectAndHandleVolumeDeltaDivergenceClick,
  persistTrendlinesForCurrentContext,
  restorePersistedTrendlinesForCurrentContext,
  clearVolumeDeltaDivergenceSummary,
  renderVolumeDeltaDivergenceSummary,
} from './chartVDTrendlines';
import {
  type MidlineStyle,
  type PaneId,
  type TrendToolPane,
  type PaneControlType,
  TREND_ICON,
  ERASE_ICON,
  DIVERGENCE_ICON,
  SETTINGS_ICON,
  INTERVAL_SWITCH_DEBOUNCE_MS,
  CHART_LIVE_REFRESH_MS,
  RIGHT_MARGIN_BARS,
  FUTURE_TIMELINE_TRADING_DAYS,
  SCALE_LABEL_CHARS,
  SCALE_MIN_WIDTH_PX,
  INVALID_SYMBOL_MESSAGE,
  TOP_PANE_TICKER_LABEL_CLASS,
  TOP_PANE_BADGE_CLASS,
  TOP_PANE_BADGE_START_LEFT_PX,
  TOP_PANE_BADGE_GAP_PX,
  PANE_SETTINGS_BUTTON_LEFT_PX,
  PANE_TOOL_BUTTON_TOP_PX,
  PANE_TOOL_BUTTON_SIZE_PX,
  PANE_TOOL_BUTTON_GAP_PX,
  VOLUME_DELTA_MIDLINE,
  VOLUME_DELTA_POSITIVE_COLOR,
  VOLUME_DELTA_NEGATIVE_COLOR,
  PREFETCH_INTERVAL_TARGETS,
  PANE_HEIGHT_MIN,
  PANE_HEIGHT_MAX,
  DEFAULT_PANE_ORDER,
  DEFAULT_PANE_HEIGHTS,
  normalizePaneOrder,
  DEFAULT_VOLUME_DELTA_SETTINGS,
  rsiSettings,
  volumeDeltaRsiSettings,
  volumeDeltaSettings,
  priceChartSettings,
  paneOrder,
  setPaneOrder,
  paneHeights,
} from './chartTypes';
// Re-export isMobileTouch for consumers that import from chart.ts
import { isMobileTouch } from './chartTypes';
export { isMobileTouch } from './chartTypes';

let currentChartTicker: string | null = null;
let currentChartInterval: ChartInterval = '1day';
// LightweightCharts objects — typed any because the CDN version has no bundled declarations.

let priceChart: any = null;

let candleSeries: any = null;

let priceTimelineSeries: any = null;
let rsiChart: RSIChart | null = null;

let volumeDeltaRsiChart: any = null;

let volumeDeltaRsiSeries: any = null;

let volumeDeltaRsiTimelineSeries: any = null;

let volumeDeltaRsiMidlineLine: any = null;

let volumeDeltaChart: any = null;

let volumeDeltaHistogramSeries: any = null;

let volumeDeltaTimelineSeries: any = null;
let rsiDivergenceToolActive = false;
let chartResizeObserver: ResizeObserver | null = null;
let isChartSyncBound = false;
let latestRenderRequestId = 0;
let pricePaneContainerEl: HTMLElement | null = null;
let volumeDeltaPaneContainerEl: HTMLElement | null = null;
let priceByTime = new Map<string, number>();
let priceChangeByTime = new Map<string, number>();
let rsiByTime = new Map<string, number>();
let volumeDeltaRsiByTime = new Map<string, number>();
let volumeDeltaByTime = new Map<string, number>();
let barIndexByTime = new Map<string, number>();
let currentBars: CandleBar[] = [];
let monthBoundaryTimes: number[] = [];
let priceMonthGridOverlayEl: HTMLDivElement | null = null;
let volumeDeltaRsiMonthGridOverlayEl: HTMLDivElement | null = null;
let volumeDeltaMonthGridOverlayEl: HTMLDivElement | null = null;
let rsiMonthGridOverlayEl: HTMLDivElement | null = null;
let chartFetchAbortController: AbortController | null = null;
let prefetchAbortController: AbortController | null = null;
let chartActivelyLoading = false;
let intervalSwitchDebounceTimer: number | null = null;
let chartLiveRefreshTimer: number | null = null;
let chartLiveRefreshInFlight = false;
let chartLayoutRefreshRafId: number | null = null;
const chartPrefetchInFlight = new Map<string, Promise<void>>();
const MARKET_CONTEXT_CACHE_MS = 45 * 1000;

interface TradingCalendarContextPayload {
  isRegularHoursEt?: boolean;
}

let marketContextCachedAtMs = 0;
let marketContextIsRegularHoursEt = false;
function tc() {
  return getThemeColors();
}
function getMonthGridlineColor(): string {
  return tc().monthGridlineColor;
}

let draggedPaneId: PaneId | null = null;
let paneResizeHandlesInstalled = false;
let crosshairHidden = false;

function ensureMonthGridOverlay(
  container: HTMLElement,
  pane: 'price' | 'volumeDeltaRsi' | 'volumeDelta' | 'rsi',
): HTMLDivElement {
  const existing =
    pane === 'price'
      ? priceMonthGridOverlayEl
      : pane === 'volumeDeltaRsi'
        ? volumeDeltaRsiMonthGridOverlayEl
        : pane === 'volumeDelta'
          ? volumeDeltaMonthGridOverlayEl
          : rsiMonthGridOverlayEl;
  if (existing && existing.parentElement === container) return existing;

  const overlay = document.createElement('div');
  const paneClass =
    pane === 'price'
      ? 'month-grid-overlay-price'
      : pane === 'volumeDeltaRsi'
        ? 'month-grid-overlay-volume-delta-rsi'
        : pane === 'volumeDelta'
          ? 'month-grid-overlay-volume-delta'
          : 'month-grid-overlay-rsi';
  overlay.className = `month-grid-overlay ${paneClass}`;
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.left = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '6';
  container.appendChild(overlay);

  if (pane === 'price') {
    priceMonthGridOverlayEl = overlay;
  } else if (pane === 'volumeDeltaRsi') {
    volumeDeltaRsiMonthGridOverlayEl = overlay;
  } else if (pane === 'volumeDelta') {
    volumeDeltaMonthGridOverlayEl = overlay;
  } else {
    rsiMonthGridOverlayEl = overlay;
  }
  return overlay;
}

function buildFutureTimelinePointsFromBars(bars: CandleBar[]): Array<{ time: number }> {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  const lastUnix = unixSecondsFromTimeValue(bars[bars.length - 1]?.time);
  if (!Number.isFinite(lastUnix)) return [];
  const points: Array<{ time: number }> = [{ time: Number(lastUnix) }];
  let cursor = Number(lastUnix);
  let tradingDaysAdded = 0;
  while (tradingDaysAdded < FUTURE_TIMELINE_TRADING_DAYS) {
    cursor += 86400;
    const dayOfWeek = new Date(cursor * 1000).getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    points.push({ time: cursor });
    tradingDaysAdded += 1;
  }
  return points;
}

function applyFutureTimelineSeriesData(bars: CandleBar[]): void {
  const timelinePoints = buildFutureTimelinePointsFromBars(bars);
  if (priceTimelineSeries) {
    priceTimelineSeries.setData(timelinePoints);
  }
  if (volumeDeltaRsiTimelineSeries) {
    volumeDeltaRsiTimelineSeries.setData(timelinePoints);
  }
  if (volumeDeltaTimelineSeries) {
    volumeDeltaTimelineSeries.setData(timelinePoints);
  }
}

async function prefetchRelatedIntervals(ticker: string, interval: ChartInterval): Promise<void> {
  const normalizedTicker = String(ticker || '')
    .trim()
    .toUpperCase();
  if (!normalizedTicker) return;
  const targets = PREFETCH_INTERVAL_TARGETS[interval] || [];

  // P1/P3 prefetches share an AbortController so the active chart load (P0)
  // can cancel them instantly when the user navigates.
  abortPrefetches();
  const controller = new AbortController();
  prefetchAbortController = controller;

  const promises: Promise<void>[] = [];

  for (const target of targets) {
    if (controller.signal.aborted) break;
    const cacheKey = buildChartDataCacheKey(normalizedTicker, target);
    if (getCachedChartData(cacheKey)) continue;
    if (chartPrefetchInFlight.has(cacheKey)) {
      promises.push(chartPrefetchInFlight.get(cacheKey)!);
      continue;
    }

    const prefetchPromise = fetchChartData(normalizedTicker, target, {
      vdRsiLength: volumeDeltaRsiSettings.length,
      vdSourceInterval: volumeDeltaSettings.sourceInterval,
      vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
      signal: controller.signal,
    })
      .then((prefetchedData) => {
        setCachedChartData(cacheKey, prefetchedData);
      })
      .catch(() => {
        // Prefetch is opportunistic; ignore errors (including AbortError).
      })
      .finally(() => {
        chartPrefetchInFlight.delete(cacheKey);
      });

    chartPrefetchInFlight.set(cacheKey, prefetchPromise);
    promises.push(prefetchPromise);
  }

  // P1 (same-ticker intervals) completes before P3 (neighbor tickers).
  await Promise.allSettled(promises);
  if (!controller.signal.aborted) {
    prefetchNeighborTickers(interval, controller.signal).catch(() => {});
  }
}

exposeChartPerfMetrics();
initVDF({
  getPriceChart: () => priceChart,
  getCurrentBars: () => currentBars,
  getCurrentTicker: () => currentChartTicker,
});
initVDTrendlines({
  getVDRsiChart: () => volumeDeltaRsiChart,
  getVDRsiSeries: () => volumeDeltaRsiSeries,
  getCurrentTicker: () => currentChartTicker,
  getCurrentInterval: () => currentChartInterval,
  getPriceByTime: () => priceByTime,
  getRsiChart: () => rsiChart,
  setPaneTrendlineToolActive,
  applyPricePaneDivergentBarColors,
});
initSettingsUI({
  applyMovingAverages,
  applyPriceGridOptions,
  applyRSISettings,
  applyVolumeDeltaRSISettings,
  applyPricePaneDivergentBarColors,
  clearMovingAverageSeries,
  applyPaneOrderAndRefreshLayout,
  renderVolumeDeltaDivergenceSummary,
  scheduleChartLayoutRefresh,
  renderCustomChart,
  getCurrentTicker: () => currentChartTicker,
  getCurrentInterval: () => currentChartInterval,
  getCurrentBars: () => currentBars,
  getVolumeDeltaPaneContainer: () => volumeDeltaPaneContainerEl,
  getRsiChart: () => rsiChart,
});
initDivergencePlot({
  getCurrentInterval: () => currentChartInterval,
  getCurrentBars: () => currentBars,
  getBarIndexByTime: () => barIndexByTime,
  getRsiByTime: () => rsiByTime,
  getVolumeDeltaRsiByTime: () => volumeDeltaRsiByTime,
  getRsiDivergenceToolActive: () => rsiDivergenceToolActive,
  setRsiDivergenceToolActive: (v: boolean) => {
    rsiDivergenceToolActive = v;
  },
  getVolumeDeltaDivergenceToolActive: () => isVolumeDeltaDivergenceToolActive(),
  deactivateVolumeDeltaDivergenceTool,
  getRsiChart: () => rsiChart,
  setPaneTrendlineToolActive,
  setPaneToolButtonActive,
});

function formatVolumeDeltaScaleLabel(value: number): string {
  if (!Number.isFinite(value)) return '';
  const clamped = Math.max(0, Math.min(100, Number(value)));
  let label = '';
  if (Math.abs(clamped) >= 100) {
    label = String(Math.round(clamped));
  } else {
    label = clamped.toFixed(1);
  }
  return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, ' ');
}

function normalizeVolumeDeltaSeries(
  points: Array<{ time: string | number; delta: number }>,
): Array<{ time: string | number; delta: number }> {
  if (!Array.isArray(points)) return [];
  return points
    .filter(
      (point) =>
        point &&
        (typeof point.time === 'string' || typeof point.time === 'number') &&
        Number.isFinite(Number(point.delta)),
    )
    .map((point) => ({
      time: point.time,
      delta: Number(point.delta),
    }));
}

function formatVolumeDeltaHistogramScaleLabel(value: number): string {
  if (!Number.isFinite(value)) return '';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const budget = SCALE_LABEL_CHARS - sign.length;
  if (budget <= 0) return sign.slice(0, SCALE_LABEL_CHARS);

  const truncateTo = (num: number, decimals: number): number => {
    if (decimals <= 0) return Math.trunc(num);
    const factor = 10 ** decimals;
    return Math.trunc(num * factor) / factor;
  };
  const trimZeros = (text: string): string => text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

  const tryUnit = (divisor: number, suffix: string): string | null => {
    const scaled = abs / divisor;
    if (divisor !== 1 && scaled < 1) return null;
    const numericBudget = budget - suffix.length;
    if (numericBudget <= 0) return null;

    let decimals = 0;
    if (suffix) {
      if (scaled < 10) decimals = 1; // e.g. 4.8K
    } else if (scaled >= 10 && scaled < 100) {
      decimals = 1;
    } else if (scaled < 10) {
      decimals = 2;
    }

    while (decimals >= 0) {
      const rendered = trimZeros(truncateTo(scaled, decimals).toFixed(decimals));
      if (rendered.length <= numericBudget) {
        return `${sign}${rendered}${suffix}`;
      }
      decimals -= 1;
    }
    return null;
  };

  const orderedUnits = [
    { divisor: 1_000_000_000, suffix: 'B' },
    { divisor: 1_000_000, suffix: 'M' },
    { divisor: 1_000, suffix: 'K' },
    { divisor: 1, suffix: '' },
  ];
  for (const unit of orderedUnits) {
    const label = tryUnit(unit.divisor, unit.suffix);
    if (label) return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, ' ');
  }

  // Last resort for signed large numbers: promote unit so text stays within the 4-char axis budget.
  const fallbackUnits = [
    { divisor: 1_000, suffix: 'K' },
    { divisor: 1_000_000, suffix: 'M' },
    { divisor: 1_000_000_000, suffix: 'B' },
  ];
  for (const unit of fallbackUnits) {
    const numericBudget = budget - unit.suffix.length;
    if (numericBudget <= 0) continue;
    const scaled = abs / unit.divisor;
    const rendered = String(Math.max(1, Math.trunc(scaled)));
    if (rendered.length > numericBudget) continue;
    const label = `${sign}${rendered}${unit.suffix}`;
    return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, ' ');
  }

  return sign ? `${sign}0`.padEnd(SCALE_LABEL_CHARS, ' ') : '0'.padEnd(SCALE_LABEL_CHARS, ' ');
}

function clearMovingAverageSeries(): void {
  for (const setting of priceChartSettings.ma) {
    if (setting.series && priceChart) {
      priceChart.removeSeries(setting.series);
      setting.series = null;
    }
    if (!priceChart) {
      setting.series = null;
    }
    setting.values = [];
  }
}

function applyMovingAverages(): void {
  if (!priceChart || !currentBars.length) {
    clearMovingAverageSeries();
    return;
  }

  for (const setting of priceChartSettings.ma) {
    const validLength = Math.max(1, Math.floor(Number(setting.length) || 1));
    setting.length = validLength;
    if (!setting.enabled) {
      if (setting.series) {
        priceChart.removeSeries(setting.series);
        setting.series = null;
      }
      setting.values = [];
      continue;
    }

    if (!setting.series) {
      setting.series = priceChart.addLineSeries({
        color: setting.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    } else {
      setting.series.applyOptions({ color: setting.color });
    }

    const values =
      priceChartSettings.maSourceMode === 'daily'
        ? buildDailyMAValuesForBars(currentBars, setting.type, validLength)
        : setting.type === 'EMA'
          ? computeEMA(
              currentBars.map((bar) => Number(bar.close)),
              validLength,
            )
          : computeSMA(
              currentBars.map((bar) => Number(bar.close)),
              validLength,
            );
    setting.values = values;

    const maData = currentBars.map((bar, index) => {
      const value = values[index];
      if (!isRenderableMaValue(value)) {
        return { time: bar.time };
      }
      return {
        time: bar.time,
        value,
      };
    });
    setting.series.setData(maData);
  }
}

function updateMovingAveragesLatestPoint(): void {
  if (!priceChart || !Array.isArray(currentBars) || currentBars.length === 0) return;
  // Daily MA values can span multiple bars in the same day; keep full recompute for correctness.
  if (priceChartSettings.maSourceMode === 'daily') {
    applyMovingAverages();
    return;
  }

  const lastIndex = currentBars.length - 1;
  const lastBar = currentBars[lastIndex];
  const lastClose = Number(lastBar?.close);
  if (!Number.isFinite(lastClose)) {
    applyMovingAverages();
    return;
  }

  for (const setting of priceChartSettings.ma) {
    if (!setting.enabled || !setting.series) continue;
    const period = Math.max(1, Math.floor(Number(setting.length) || 1));
    let nextValue: number | null = null;

    if (setting.type === 'EMA') {
      if (lastIndex === 0) {
        nextValue = lastClose;
      } else {
        const prevValue = Number(setting.values[lastIndex - 1]);
        if (!Number.isFinite(prevValue)) {
          applyMovingAverages();
          return;
        }
        const alpha = 2 / (period + 1);
        nextValue = lastClose * alpha + prevValue * (1 - alpha);
      }
    } else {
      if (lastIndex < period - 1) {
        nextValue = null;
      } else {
        let sum = 0;
        for (let i = lastIndex - period + 1; i <= lastIndex; i++) {
          const close = Number(currentBars[i]?.close);
          if (!Number.isFinite(close)) {
            applyMovingAverages();
            return;
          }
          sum += close;
        }
        nextValue = sum / period;
      }
    }

    if (setting.values.length !== currentBars.length) {
      setting.values = new Array(currentBars.length).fill(null);
    }
    setting.values[lastIndex] = isRenderableMaValue(nextValue) ? nextValue : null;
    if (isRenderableMaValue(nextValue)) {
      setting.series.update({ time: lastBar.time, value: nextValue });
    } else {
      setting.series.update({ time: lastBar.time });
    }
  }
}

function clearMonthGridOverlay(overlayEl: HTMLDivElement | null): void {
  if (!overlayEl) return;
  overlayEl.innerHTML = '';
}

// LightweightCharts CDN — IChartApi type has no bundled declarations

function renderMonthGridLines(chart: any, overlayEl: HTMLDivElement | null): void {
  if (!chart || !overlayEl) return;

  overlayEl.innerHTML = '';
  if (!priceChartSettings.verticalGridlines) return;
  if (!monthBoundaryTimes.length) return;

  const width = overlayEl.clientWidth || overlayEl.offsetWidth;
  if (!Number.isFinite(width) || width <= 0) return;

  for (const time of monthBoundaryTimes) {
    const x = chart.timeScale().timeToCoordinate(time);
    if (!Number.isFinite(x)) continue;
    if (x < 0 || x > width) continue;

    const line = document.createElement('div');
    line.style.position = 'absolute';
    line.style.top = '0';
    line.style.bottom = '0';
    line.style.left = `${Math.round(x)}px`;
    line.style.width = '1px';
    line.style.background = getMonthGridlineColor();
    overlayEl.appendChild(line);
  }
}

function refreshMonthGridLines(): void {
  renderMonthGridLines(priceChart, priceMonthGridOverlayEl);
  renderMonthGridLines(volumeDeltaRsiChart, volumeDeltaRsiMonthGridOverlayEl);
  renderMonthGridLines(volumeDeltaChart, volumeDeltaMonthGridOverlayEl);
  renderMonthGridLines(rsiChart?.getChart(), rsiMonthGridOverlayEl);
  refreshVolumeDeltaTrendlineCrossLabels();
}

function scheduleChartLayoutRefresh(): void {
  if (chartLayoutRefreshRafId !== null) return;
  chartLayoutRefreshRafId = requestAnimationFrame(() => {
    chartLayoutRefreshRafId = null;
    refreshMonthGridLines();
    refreshVDZones();
  });
}

function applyPriceGridOptions(): void {
  if (!priceChart) return;
  priceChart.applyOptions({
    grid: {
      vertLines: { visible: false },
      horzLines: {
        visible: priceChartSettings.horizontalGridlines,
        color: getMonthGridlineColor(),
      },
    },
  });
  scheduleChartLayoutRefresh();
}

function getTopPaneId(): PaneId {
  return normalizePaneOrder(paneOrder)[0];
}

function getTopPaneBadgePriority(badge: HTMLElement): number {
  const role = String(badge.dataset.topPaneBadgeRole || '');
  if (role === 'ticker') return 0;
  if (role === 'price-change') return 1;
  return 100;
}

function getPaneBadgeStartLeft(container: HTMLElement): number {
  const toolButtons = Array.from(container.querySelectorAll<HTMLElement>('.pane-settings-btn, .pane-trendline-btn'));
  if (!toolButtons.length) return TOP_PANE_BADGE_START_LEFT_PX;
  const rightEdge = toolButtons.reduce((maxRight, btn) => {
    const right = btn.offsetLeft + btn.offsetWidth;
    return right > maxRight ? right : maxRight;
  }, 0);
  const computed = rightEdge + TOP_PANE_BADGE_GAP_PX;
  return Math.max(TOP_PANE_BADGE_START_LEFT_PX, computed);
}

function layoutTopPaneBadges(container: HTMLElement): void {
  const badges = Array.from(container.querySelectorAll<HTMLElement>(`.${TOP_PANE_BADGE_CLASS}`)).filter(
    (badge) => badge.style.display !== 'none',
  );
  if (!badges.length) return;

  const ordered = badges
    .map((badge, index) => ({ badge, index, priority: getTopPaneBadgePriority(badge) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.badge);

  let left = getPaneBadgeStartLeft(container);
  for (const badge of ordered) {
    badge.style.left = `${left}px`;
    badge.style.top = '8px';
    badge.style.maxWidth = `calc(100% - ${left + 30}px)`;
    const width = Math.ceil(badge.getBoundingClientRect().width || badge.offsetWidth || 0);
    left += Math.max(0, width) + TOP_PANE_BADGE_GAP_PX;
  }
}

// ---------------------------------------------------------------------------
// Ticker info tooltip (replaces TradingView link)
// ---------------------------------------------------------------------------

const tickerInfoCache = new Map<string, TickerInfoPayload | null>();
let activeTickerTooltip: HTMLElement | null = null;
let activeTooltipTimer: number | null = null;

function formatMarketCap(cap: number | undefined | null): string {
  if (!cap || !Number.isFinite(cap) || cap <= 0) return '';
  if (cap >= 1e12) return `$${(cap / 1e12).toFixed(1)}T`;
  if (cap >= 1e9) return `$${(cap / 1e9).toFixed(1)}B`;
  if (cap >= 1e6) return `$${(cap / 1e6).toFixed(1)}M`;
  return `$${cap.toLocaleString()}`;
}

function dismissTickerTooltip(): void {
  if (activeTooltipTimer !== null) {
    clearTimeout(activeTooltipTimer);
    activeTooltipTimer = null;
  }
  if (activeTickerTooltip) {
    activeTickerTooltip.remove();
    activeTickerTooltip = null;
  }
}

async function showTickerInfoTooltip(ticker: string, anchor: HTMLElement): Promise<void> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return;

  dismissTickerTooltip();

  let info = tickerInfoCache.get(symbol);
  if (info === undefined) {
    try {
      const res = await fetch(`/api/chart/ticker-info?ticker=${encodeURIComponent(symbol)}`);
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        info = (data.results || null) as TickerInfoPayload | null;
      } else {
        info = null;
      }
    } catch {
      info = null;
    }
    tickerInfoCache.set(symbol, info);
  }

  if (!info) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'ticker-info-tooltip';

  // Tooltip structure:
  // Line 1: name
  // Line 2: market cap
  // Line 3: SIC description
  // Line 4: full description (no truncation)
  const appendTooltipLine = (className: string, text: string | undefined | null): void => {
    const value = String(text || '').trim();
    if (!value) return;
    const line = document.createElement('div');
    line.className = className;
    line.textContent = value;
    tooltip.appendChild(line);
  };

  appendTooltipLine('ticker-info-line1', info.name);
  appendTooltipLine('ticker-info-line2', formatMarketCap(info.market_cap));
  appendTooltipLine('ticker-info-line3', info.sic_description);
  appendTooltipLine('ticker-info-line4', info.description);

  if (!tooltip.childElementCount) return;

  // Position below the anchor badge
  const pane = anchor.closest('[id]') as HTMLElement | null;
  tooltip.style.position = 'absolute';
  tooltip.style.left = `${anchor.offsetLeft}px`;
  tooltip.style.top = `${anchor.offsetTop + anchor.offsetHeight + 4}px`;
  tooltip.style.zIndex = '50';

  (pane || anchor.parentElement)?.appendChild(tooltip);
  activeTickerTooltip = tooltip;

  activeTooltipTimer = window.setTimeout(dismissTickerTooltip, 4000);

  const onClickOutside = (e: MouseEvent): void => {
    if (!tooltip.contains(e.target as Node)) {
      dismissTickerTooltip();
      document.removeEventListener('click', onClickOutside, true);
    }
  };
  setTimeout(() => document.addEventListener('click', onClickOutside, true), 0);
}

function openTickerWebsite(symbol: string): void {
  const info = tickerInfoCache.get(symbol);
  const url = info?.homepage_url || `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:NASDAQ`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function handleTickerBadgeClick(ticker: string, anchor: HTMLElement): void {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return;

  // If tooltip is already showing for this ticker, open the website instead
  if (activeTickerTooltip) {
    dismissTickerTooltip();
    openTickerWebsite(symbol);
    return;
  }

  showTickerInfoTooltip(symbol, anchor).catch(() => {});
}

function syncTopPaneTickerLabel(): void {
  const topPaneId = getTopPaneId();

  for (const paneId of DEFAULT_PANE_ORDER) {
    const pane = document.getElementById(paneId);
    if (!pane || !(pane instanceof HTMLElement)) continue;
    const existing = pane.querySelector(`.${TOP_PANE_TICKER_LABEL_CLASS}`) as HTMLDivElement | null;
    if (!existing) continue;
    if (paneId !== topPaneId) {
      existing.remove();
    }
  }

  if (!topPaneId) return;
  const topPane = document.getElementById(topPaneId);
  if (!topPane || !(topPane instanceof HTMLElement)) return;

  const ticker = String(currentChartTicker || '')
    .trim()
    .toUpperCase();
  let label = topPane.querySelector(`.${TOP_PANE_TICKER_LABEL_CLASS}`) as HTMLDivElement | null;
  if (!ticker) {
    if (label) label.remove();
    for (const paneId of DEFAULT_PANE_ORDER) {
      const pane = document.getElementById(paneId);
      if (!pane || !(pane instanceof HTMLElement)) continue;
      layoutTopPaneBadges(pane);
    }
    return;
  }

  if (!label) {
    const startLeft = getPaneBadgeStartLeft(topPane);
    label = document.createElement('div');
    label.className = `${TOP_PANE_TICKER_LABEL_CLASS} ${TOP_PANE_BADGE_CLASS}`;
    label.dataset.topPaneBadgeRole = 'ticker';
    label.style.position = 'absolute';
    label.style.left = `${startLeft}px`;
    label.style.top = '8px';
    label.style.zIndex = '32';
    label.style.minHeight = '24px';
    label.style.maxWidth = `calc(100% - ${startLeft + 30}px)`;
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.padding = '0 8px';
    label.style.borderRadius = '4px';
    label.style.border = `1px solid ${tc().borderColor}`;
    label.style.background = tc().cardBg;
    label.style.color = tc().textPrimary;
    label.style.fontSize = '12px';
    label.style.fontWeight = '600';
    label.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    label.style.whiteSpace = 'nowrap';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.pointerEvents = 'auto';
    label.style.cursor = 'pointer';
    label.removeAttribute('title');
    label.setAttribute('role', 'button');
    label.tabIndex = 0;
    if (!label.dataset.clickBound) {
      label.addEventListener('click', (event) => {
        event.stopPropagation();
        const el = event.currentTarget as HTMLElement;
        handleTickerBadgeClick(String(el.dataset.tickerSymbol || ''), el);
      });
      label.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        const el = event.currentTarget as HTMLElement;
        handleTickerBadgeClick(String(el.dataset.tickerSymbol || ''), el);
      });
      label.dataset.clickBound = '1';
    }
    topPane.appendChild(label);
  }

  label.dataset.tickerSymbol = ticker;
  label.textContent = ticker;
  for (const paneId of DEFAULT_PANE_ORDER) {
    const pane = document.getElementById(paneId);
    if (!pane || !(pane instanceof HTMLElement)) continue;
    layoutTopPaneBadges(pane);
  }
}

function applyPaneOrderToDom(chartContent: HTMLElement): void {
  for (const paneId of paneOrder) {
    const pane = document.getElementById(paneId);
    if (!pane || pane.parentElement !== chartContent) continue;
    chartContent.appendChild(pane);
  }
}

function movePaneInOrder(movingPaneId: PaneId, targetPaneId: PaneId, insertAfter: boolean): void {
  if (movingPaneId === targetPaneId) return;
  const nextOrder = paneOrder.filter((paneId) => paneId !== movingPaneId);
  const targetIndex = nextOrder.indexOf(targetPaneId);
  if (targetIndex < 0) return;
  const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
  nextOrder.splice(insertIndex, 0, movingPaneId);
  setPaneOrder(normalizePaneOrder(nextOrder));
}

function clearPaneDragOverState(): void {
  for (const paneId of DEFAULT_PANE_ORDER) {
    const pane = document.getElementById(paneId);
    if (!pane) continue;
    pane.classList.remove('pane-drag-over');
  }
}

function applyPaneOrderAndRefreshLayout(chartContent: HTMLElement): void {
  applyPaneOrderToDom(chartContent);
  const chartContainer = document.getElementById('price-chart-container');
  const volumeDeltaRsiContainer = document.getElementById('vd-rsi-chart-container');
  const rsiContainer = document.getElementById('rsi-chart-container');
  const volumeDeltaContainer = document.getElementById('vd-chart-container');
  if (chartContainer && volumeDeltaRsiContainer && rsiContainer && volumeDeltaContainer) {
    applyChartSizes(
      chartContainer as HTMLElement,
      volumeDeltaRsiContainer as HTMLElement,
      rsiContainer as HTMLElement,
      volumeDeltaContainer as HTMLElement,
    );
  }
  applyPaneScaleVisibilityByPosition();
  syncTopPaneTickerLabel();
}

function isChartFullscreen(): boolean {
  const container = document.getElementById('custom-chart-container');
  return container?.classList.contains('chart-fullscreen') === true;
}

function shouldShowPaneScale(paneId: PaneId): boolean {
  const order = normalizePaneOrder(paneOrder);
  const index = order.indexOf(paneId);
  // Show only on pane positions 2 and 4.
  // In fullscreen mode, hide the 4th pane's time scale.
  if (index === 3 && isChartFullscreen()) return false;
  return index === 1 || index === 3;
}

function applyChartScaleVisibility(chart: any, show: boolean): void {
  if (!chart) return;
  chart.applyOptions({
    rightPriceScale: {
      // Y-axis should always be visible on every pane.
      visible: true,
    },
    timeScale: {
      visible: show,
      borderVisible: show,
      ticksVisible: show,
    },
  });
}

function applyPaneScaleVisibilityByPosition(): void {
  applyChartScaleVisibility(priceChart, shouldShowPaneScale('price-chart-container'));
  applyChartScaleVisibility(volumeDeltaRsiChart, shouldShowPaneScale('vd-rsi-chart-container'));
  applyChartScaleVisibility(rsiChart?.getChart(), shouldShowPaneScale('rsi-chart-container'));
  applyChartScaleVisibility(volumeDeltaChart, shouldShowPaneScale('vd-chart-container'));
}

function ensurePaneReorderHandle(pane: HTMLElement, paneId: PaneId, chartContent: HTMLElement): void {
  if (!pane.dataset.paneId) {
    pane.dataset.paneId = paneId;
  }

  let handle = pane.querySelector('.pane-order-handle') as HTMLButtonElement | null;
  if (!handle) {
    handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'pane-order-handle';
    handle.removeAttribute('title');
    handle.textContent = '';
    handle.setAttribute('aria-label', 'Reorder pane');
    pane.appendChild(handle);
  }

  if (!handle.dataset.bound) {
    handle.setAttribute('draggable', 'true');
    handle.addEventListener('dragstart', (event: DragEvent) => {
      draggedPaneId = paneId;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', paneId);
      }
      clearPaneDragOverState();
    });
    handle.addEventListener('dragend', () => {
      draggedPaneId = null;
      clearPaneDragOverState();
    });
    handle.dataset.bound = '1';
  }

  if (!pane.dataset.dropBound) {
    pane.addEventListener('dragover', (event: DragEvent) => {
      if (!draggedPaneId) return;
      event.preventDefault();
      pane.classList.add('pane-drag-over');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    pane.addEventListener('dragleave', () => {
      pane.classList.remove('pane-drag-over');
    });
    pane.addEventListener('drop', (event: DragEvent) => {
      event.preventDefault();
      pane.classList.remove('pane-drag-over');
      const source = draggedPaneId;
      draggedPaneId = null;
      if (!source || source === paneId) return;

      const sourceIndex = paneOrder.indexOf(source);
      const targetIndex = paneOrder.indexOf(paneId);
      const insertAfter = sourceIndex >= 0 && targetIndex >= 0 ? sourceIndex < targetIndex : true;
      movePaneInOrder(source, paneId, insertAfter);
      applyPaneOrderAndRefreshLayout(chartContent);
      persistSettingsToStorage();
    });
    pane.dataset.dropBound = '1';
  }
}

function ensurePaneReorderUI(chartContent: HTMLElement): void {
  setPaneOrder(normalizePaneOrder(paneOrder));
  applyPaneOrderToDom(chartContent);
  for (const paneId of DEFAULT_PANE_ORDER) {
    const pane = document.getElementById(paneId);
    if (!pane || !(pane instanceof HTMLElement) || pane.parentElement !== chartContent) continue;
    ensurePaneReorderHandle(pane, paneId, chartContent);
  }
  syncTopPaneTickerLabel();
}

function applyRSISettings(): void {
  if (!rsiChart) return;
  const rsiData = buildRSISeriesFromBars(currentBars, rsiSettings.length);
  rsiByTime = new Map(
    rsiData
      .filter((point) => Number.isFinite(Number(point.value)))
      .map((point) => [timeKey(point.time), Number(point.value)]),
  );
  rsiChart.setData(
    rsiData,
    currentBars.map((b) => ({ time: b.time, close: b.close })),
  );
  rsiChart.setLineColor(rsiSettings.lineColor);
  rsiChart.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
  refreshActiveDivergenceOverlays();
}

function midlineStyleToLineStyle(style: MidlineStyle): number {
  return style === 'solid' ? 0 : 1;
}

function applyVolumeDeltaRSIVisualSettings(): void {
  if (volumeDeltaRsiSeries) {
    volumeDeltaRsiSeries.applyOptions({
      color: volumeDeltaRsiSettings.lineColor,
      lineWidth: 1,
    });
  }
  if (volumeDeltaRsiMidlineLine) {
    volumeDeltaRsiMidlineLine.applyOptions({
      color: volumeDeltaRsiSettings.midlineColor,
      lineStyle: midlineStyleToLineStyle(volumeDeltaRsiSettings.midlineStyle),
    });
  }
  refreshActiveDivergenceOverlays();
}

function applyVolumeDeltaRSISettings(refetch: boolean): void {
  applyVolumeDeltaRSIVisualSettings();
  if (!refetch) return;
  if (!currentChartTicker) return;
  renderCustomChart(currentChartTicker, currentChartInterval);
}

function createSettingsButton(container: HTMLElement, pane: PaneControlType): HTMLButtonElement {
  const existing = container.querySelector(`.pane-settings-btn[data-pane="${pane}"]`) as HTMLButtonElement | null;
  if (existing) return existing;
  const btn = document.createElement('button');
  btn.className = 'pane-btn pane-overlay pane-settings-btn';
  btn.dataset.pane = pane;
  btn.type = 'button';
  btn.innerHTML = SETTINGS_ICON;
  btn.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX}px`;
  btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
  container.appendChild(btn);
  return btn;
}

function getPaneShortLabel(pane: PaneControlType): string {
  if (pane === 'volumeDelta') return 'VD';
  if (pane === 'volumeDeltaRsi') return 'VD-RSI';
  if (pane === 'rsi') return 'RSI';
  return 'Price';
}

function createPaneNameBadge(container: HTMLElement, pane: PaneControlType): HTMLDivElement {
  const existing = container.querySelector(`.pane-name-badge[data-pane="${pane}"]`) as HTMLDivElement | null;
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.className = 'pane-btn pane-overlay label pane-name-badge';
  badge.dataset.pane = pane;
  badge.textContent = getPaneShortLabel(pane);
  badge.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX}px`;
  badge.style.top = `${PANE_TOOL_BUTTON_TOP_PX + PANE_TOOL_BUTTON_SIZE_PX + PANE_TOOL_BUTTON_GAP_PX}px`;
  container.appendChild(badge);
  return badge;
}

function createPaneTrendlineButton(
  container: HTMLElement,
  pane: TrendToolPane,
  action: 'trend' | 'erase' | 'divergence',
  orderFromSettings: number,
): HTMLButtonElement {
  const existing = container.querySelector(
    `.pane-trendline-btn[data-pane="${pane}"][data-action="${action}"]`,
  ) as HTMLButtonElement | null;
  if (existing) return existing;

  const btn = document.createElement('button');
  btn.className = 'pane-btn pane-overlay pane-trendline-btn';
  btn.dataset.pane = pane;
  btn.dataset.action = action;
  btn.type = 'button';
  btn.title = action === 'trend' ? 'Draw Trendline' : action === 'erase' ? 'Erase Trendline' : '';
  btn.innerHTML = action === 'trend' ? TREND_ICON : action === 'erase' ? ERASE_ICON : DIVERGENCE_ICON;
  btn.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX + (orderFromSettings + 1) * (PANE_TOOL_BUTTON_SIZE_PX + PANE_TOOL_BUTTON_GAP_PX)}px`;
  btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
  container.appendChild(btn);
  return btn;
}

function getPaneToolButton(pane: TrendToolPane, action: 'trend' | 'divergence'): HTMLButtonElement | null {
  return document.querySelector(
    `.pane-trendline-btn[data-pane="${pane}"][data-action="${action}"]`,
  ) as HTMLButtonElement | null;
}

function setPaneToolButtonActive(pane: TrendToolPane, action: 'trend' | 'divergence', active: boolean): void {
  const btn = getPaneToolButton(pane, action);
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.innerHTML = action === 'trend' ? TREND_ICON : DIVERGENCE_ICON;
}

function setPaneTrendlineToolActive(pane: TrendToolPane, active: boolean): void {
  setPaneToolButtonActive(pane, 'trend', active);
}

function getTrendlineCrosshairCueTime(): string | number | null {
  if (!Array.isArray(currentBars) || currentBars.length === 0) return null;
  const fallbackTime = currentBars[currentBars.length - 1]?.time;
  if (typeof fallbackTime !== 'string' && typeof fallbackTime !== 'number') return null;
  if (!priceChart) return fallbackTime;

  try {
    const visibleRange = priceChart.timeScale().getVisibleLogicalRange?.();
    const from = Number(visibleRange?.from);
    const to = Number(visibleRange?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return fallbackTime;
    }
    const centerIndex = Math.round((from + to) / 2);
    const clampedIndex = Math.max(0, Math.min(currentBars.length - 1, centerIndex));
    const candidateTime = currentBars[clampedIndex]?.time;
    if (typeof candidateTime === 'string' || typeof candidateTime === 'number') {
      return candidateTime;
    }
  } catch {
    // Fall through to last bar cue.
  }

  return fallbackTime;
}

function primeRsiTrendlineCrosshairCue(): void {
  if (!rsiChart) return;
  const cueTime = getTrendlineCrosshairCueTime();
  if (cueTime === null) return;
  const cueValue = getNearestMappedValueAtOrBefore(cueTime, rsiByTime);
  const chart = rsiChart.getChart?.();
  const series = rsiChart.getSeries?.();
  if (!chart || !series || !Number.isFinite(cueValue)) return;
  try {
    chart.setCrosshairPosition(Number(cueValue), cueTime, series);
  } catch {
    // Ignore transient cue placement errors.
  }
}

function primeVolumeDeltaRsiTrendlineCrosshairCue(): void {
  if (!volumeDeltaRsiChart || !volumeDeltaRsiSeries) return;
  const cueTime = getTrendlineCrosshairCueTime();
  if (cueTime === null) return;
  const cueValue = getNearestMappedValueAtOrBefore(cueTime, volumeDeltaRsiByTime);
  if (!Number.isFinite(cueValue)) return;
  try {
    volumeDeltaRsiChart.setCrosshairPosition(Number(cueValue), cueTime, volumeDeltaRsiSeries);
  } catch {
    // Ignore transient cue placement errors.
  }
}

function toggleRSITrendlineTool(): void {
  if (!rsiChart) return;
  if (rsiDivergenceToolActive) {
    rsiChart.deactivateDivergenceTool();
    rsiDivergenceToolActive = false;
    setPaneTrendlineToolActive('rsi', false);
    return;
  }
  if (isRsiDivergencePlotToolActive()) {
    deactivateRsiDivergencePlotTool();
  }
  rsiChart.activateDivergenceTool();
  rsiDivergenceToolActive = true;
  setPaneTrendlineToolActive('rsi', true);
  primeRsiTrendlineCrosshairCue();
}

function clearRSITrendlines(): void {
  rsiChart?.clearDivergence(true);
  rsiChart?.deactivateDivergenceTool();
  rsiDivergenceToolActive = false;
  setPaneTrendlineToolActive('rsi', false);
  persistTrendlinesForCurrentContext();
}

function toggleVolumeDeltaRSITrendlineTool(): void {
  if (!volumeDeltaRsiChart) return;
  if (isVolumeDeltaDivergenceToolActive()) {
    deactivateVolumeDeltaDivergenceTool();
    setPaneTrendlineToolActive('volumeDeltaRsi', false);
    return;
  }
  if (isVolumeDeltaRsiDivergencePlotToolActive()) {
    deactivateVolumeDeltaRsiDivergencePlotTool();
  }
  activateVolumeDeltaDivergenceTool();
  setPaneTrendlineToolActive('volumeDeltaRsi', true);
  primeVolumeDeltaRsiTrendlineCrosshairCue();
}

function clearVolumeDeltaRSITrendlines(): void {
  clearVolumeDeltaDivergence(true);
  deactivateVolumeDeltaDivergenceTool();
  setPaneTrendlineToolActive('volumeDeltaRsi', false);
  persistTrendlinesForCurrentContext();
}

function ensureSettingsUI(
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement,
): void {
  const priceBtn = createSettingsButton(chartContainer, 'price');
  ensureVDFButton(chartContainer);
  ensureBullFlagButton(chartContainer);
  const vdfRefBtn = ensureVDFRefreshButton(chartContainer);
  const volumeDeltaRsiBtn = createSettingsButton(volumeDeltaRsiContainer, 'volumeDeltaRsi');
  const rsiBtn = createSettingsButton(rsiContainer, 'rsi');
  const volumeDeltaBtn = createSettingsButton(volumeDeltaContainer, 'volumeDelta');
  createPaneNameBadge(chartContainer, 'price');
  createPaneNameBadge(volumeDeltaRsiContainer, 'volumeDeltaRsi');
  createPaneNameBadge(rsiContainer, 'rsi');
  createPaneNameBadge(volumeDeltaContainer, 'volumeDelta');
  const volumeDeltaRsiTrendBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, 'volumeDeltaRsi', 'trend', 0);
  const volumeDeltaRsiEraseBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, 'volumeDeltaRsi', 'erase', 1);
  const volumeDeltaRsiDivergenceBtn = createPaneTrendlineButton(
    volumeDeltaRsiContainer,
    'volumeDeltaRsi',
    'divergence',
    2,
  );
  const rsiTrendBtn = createPaneTrendlineButton(rsiContainer, 'rsi', 'trend', 0);
  const rsiEraseBtn = createPaneTrendlineButton(rsiContainer, 'rsi', 'erase', 1);
  const rsiDivergenceBtn = createPaneTrendlineButton(rsiContainer, 'rsi', 'divergence', 2);

  if (!getPriceSettingsPanel() || getPriceSettingsPanel()!.parentElement !== chartContainer) {
    if (getPriceSettingsPanel()?.parentElement) {
      getPriceSettingsPanel()!.parentElement!.removeChild(getPriceSettingsPanel()!);
    }
    createPriceSettingsPanel(chartContainer);
  }
  if (!getRsiSettingsPanel() || getRsiSettingsPanel()!.parentElement !== rsiContainer) {
    if (getRsiSettingsPanel()?.parentElement) {
      getRsiSettingsPanel()!.parentElement!.removeChild(getRsiSettingsPanel()!);
    }
    createRSISettingsPanel(rsiContainer);
  }
  if (
    !getVolumeDeltaRsiSettingsPanel() ||
    getVolumeDeltaRsiSettingsPanel()!.parentElement !== volumeDeltaRsiContainer
  ) {
    if (getVolumeDeltaRsiSettingsPanel()?.parentElement) {
      getVolumeDeltaRsiSettingsPanel()!.parentElement!.removeChild(getVolumeDeltaRsiSettingsPanel()!);
    }
    createVolumeDeltaRSISettingsPanel(volumeDeltaRsiContainer);
  }
  if (!getVolumeDeltaSettingsPanel() || getVolumeDeltaSettingsPanel()!.parentElement !== volumeDeltaContainer) {
    if (getVolumeDeltaSettingsPanel()?.parentElement) {
      getVolumeDeltaSettingsPanel()!.parentElement!.removeChild(getVolumeDeltaSettingsPanel()!);
    }
    createVolumeDeltaSettingsPanel(volumeDeltaContainer);
  }

  syncPriceSettingsPanelValues();
  syncVolumeDeltaSettingsPanelValues();
  syncVolumeDeltaRSISettingsPanelValues();
  syncRSISettingsPanelValues();

  if (!priceBtn.dataset.bound) {
    priceBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = getPriceSettingsPanel()?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (getPriceSettingsPanel()) getPriceSettingsPanel()!.style.display = nextDisplay;
    });
    priceBtn.dataset.bound = '1';
  }
  if (!volumeDeltaRsiBtn.dataset.bound) {
    volumeDeltaRsiBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = getVolumeDeltaRsiSettingsPanel()?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (getVolumeDeltaRsiSettingsPanel()) getVolumeDeltaRsiSettingsPanel()!.style.display = nextDisplay;
    });
    volumeDeltaRsiBtn.dataset.bound = '1';
  }
  if (!volumeDeltaBtn.dataset.bound) {
    volumeDeltaBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = getVolumeDeltaSettingsPanel()?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (getVolumeDeltaSettingsPanel()) getVolumeDeltaSettingsPanel()!.style.display = nextDisplay;
    });
    volumeDeltaBtn.dataset.bound = '1';
  }
  if (!rsiBtn.dataset.bound) {
    rsiBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = getRsiSettingsPanel()?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (getRsiSettingsPanel()) getRsiSettingsPanel()!.style.display = nextDisplay;
    });
    rsiBtn.dataset.bound = '1';
  }
  if (!volumeDeltaRsiTrendBtn.dataset.bound) {
    volumeDeltaRsiTrendBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleVolumeDeltaRSITrendlineTool();
    });
    volumeDeltaRsiTrendBtn.dataset.bound = '1';
  }
  if (!volumeDeltaRsiEraseBtn.dataset.bound) {
    volumeDeltaRsiEraseBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearVolumeDeltaRSITrendlines();
    });
    volumeDeltaRsiEraseBtn.dataset.bound = '1';
  }
  if (!volumeDeltaRsiDivergenceBtn.dataset.bound) {
    volumeDeltaRsiDivergenceBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleVolumeDeltaRsiDivergencePlotTool();
    });
    volumeDeltaRsiDivergenceBtn.dataset.bound = '1';
  }
  if (!rsiTrendBtn.dataset.bound) {
    rsiTrendBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleRSITrendlineTool();
    });
    rsiTrendBtn.dataset.bound = '1';
  }
  if (!rsiEraseBtn.dataset.bound) {
    rsiEraseBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearRSITrendlines();
    });
    rsiEraseBtn.dataset.bound = '1';
  }
  if (!rsiDivergenceBtn.dataset.bound) {
    rsiDivergenceBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleRsiDivergencePlotTool();
    });
    rsiDivergenceBtn.dataset.bound = '1';
  }

  if (!vdfRefBtn.dataset.bound) {
    vdfRefBtn.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (currentChartTicker) {
        renderVDFRefreshIcon(true);
        runVDFDetection(currentChartTicker, true).finally(() => {
          renderVDFRefreshIcon(false);
        });
      }
    });
    vdfRefBtn.dataset.bound = '1';
  }

  setPaneTrendlineToolActive('rsi', rsiDivergenceToolActive);
  setPaneTrendlineToolActive('volumeDeltaRsi', isVolumeDeltaDivergenceToolActive());
  setPaneToolButtonActive('rsi', 'divergence', isRsiDivergencePlotToolActive());
  setPaneToolButtonActive('volumeDeltaRsi', 'divergence', isVolumeDeltaRsiDivergencePlotToolActive());

  if (!document.body.dataset.chartSettingsBound) {
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.pane-settings-panel') || target.closest('.pane-settings-btn')) return;
      hideSettingsPanels();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      deactivateInteractivePaneToolsFromEscape();
    });
    document.body.dataset.chartSettingsBound = '1';
  }
}

function ensurePricePaneChangeEl(container: HTMLElement): HTMLDivElement {
  let changeEl = container.querySelector('.price-pane-change') as HTMLDivElement | null;
  if (changeEl) return changeEl;

  const startLeft = getPaneBadgeStartLeft(container);
  changeEl = document.createElement('div');
  changeEl.className = `price-pane-change ${TOP_PANE_BADGE_CLASS}`;
  changeEl.dataset.topPaneBadgeRole = 'price-change';
  changeEl.style.position = 'absolute';
  changeEl.style.left = `${startLeft}px`;
  changeEl.style.top = '8px';
  changeEl.style.zIndex = '30';
  changeEl.style.minHeight = '24px';
  changeEl.style.display = 'inline-flex';
  changeEl.style.alignItems = 'center';
  changeEl.style.padding = '0 8px';
  changeEl.style.borderRadius = '4px';
  changeEl.style.border = `1px solid ${tc().borderColor}`;
  changeEl.style.background = tc().cardBg;
  changeEl.style.color = tc().textPrimary;
  changeEl.style.fontSize = '12px';
  changeEl.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
  changeEl.style.pointerEvents = 'none';
  changeEl.style.display = 'none';
  container.appendChild(changeEl);
  return changeEl;
}

function rebuildPricePaneChangeMap(bars: CandleBar[]): void {
  priceChangeByTime = new Map<string, number>();
  if (!Array.isArray(bars) || bars.length < 2) return;
  for (let i = 1; i < bars.length; i++) {
    const currClose = Number(bars[i]?.close);
    const prevClose = Number(bars[i - 1]?.close);
    if (!Number.isFinite(currClose) || !Number.isFinite(prevClose) || prevClose === 0) continue;
    const percentChange = ((currClose - prevClose) / prevClose) * 100;
    priceChangeByTime.set(timeKey(bars[i].time), percentChange);
  }
}

function setPricePaneChange(container: HTMLElement, time?: string | number | null): void {
  const changeEl = ensurePricePaneChangeEl(container);
  if (!currentBars.length || priceChangeByTime.size === 0) {
    changeEl.style.display = 'none';
    changeEl.textContent = '';
    layoutTopPaneBadges(container);
    return;
  }

  const fallbackTime = currentBars[currentBars.length - 1]?.time;
  const targetKey = time !== null && time !== undefined ? timeKey(time) : timeKey(fallbackTime);
  const deltaValue = Number(priceChangeByTime.get(targetKey));
  if (!Number.isFinite(deltaValue)) {
    // If no previous candle exists for this crosshair candle (e.g., very first bar), hide label.
    changeEl.style.display = 'none';
    changeEl.textContent = '';
    layoutTopPaneBadges(container);
    return;
  }

  const sign = deltaValue > 0 ? '+' : '';
  changeEl.textContent = `${sign}${deltaValue.toFixed(2)}%`;
  changeEl.style.color = deltaValue > 0 ? '#26a69a' : deltaValue < 0 ? '#ef5350' : tc().textPrimary;
  changeEl.style.display = 'inline-flex';
  layoutTopPaneBadges(container);
}

function ensurePricePaneMessageEl(container: HTMLElement): HTMLDivElement {
  let messageEl = container.querySelector('.price-pane-message') as HTMLDivElement | null;
  if (messageEl) return messageEl;

  messageEl = document.createElement('div');
  messageEl.className = 'price-pane-message';
  messageEl.style.position = 'absolute';
  messageEl.style.top = '50%';
  messageEl.style.left = '50%';
  messageEl.style.transform = 'translate(-50%, -50%)';
  messageEl.style.color = tc().textSecondary;
  messageEl.style.fontSize = '1rem';
  messageEl.style.fontWeight = '600';
  messageEl.style.pointerEvents = 'none';
  messageEl.style.zIndex = '20';
  messageEl.style.display = 'none';
  container.appendChild(messageEl);
  return messageEl;
}

function setPricePaneMessage(container: HTMLElement, message: string | null): void {
  const messageEl = ensurePricePaneMessageEl(container);
  if (!message) {
    messageEl.style.display = 'none';
    messageEl.textContent = '';
    return;
  }
  messageEl.textContent = message;
  messageEl.style.display = 'block';
}

function isNoDataTickerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err || '');
  return /No .*data available for this ticker|No valid chart bars/i.test(message);
}

function formatPriceScaleLabel(value: number): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  let label = '';
  if (abs >= 100) {
    label = String(Math.round(value));
  } else if (abs >= 10) {
    const rounded = Math.round(value * 10) / 10;
    if (Math.abs(rounded) >= 100) {
      label = String(Math.round(rounded));
    } else {
      label = rounded.toFixed(1);
    }
  } else {
    label = (Math.round(value * 100) / 100).toFixed(2);
  }
  return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, ' ');
}

// LightweightCharts CDN — LogicalRange type has no bundled declarations

function sameLogicalRange(a: any, b: any): boolean {
  if (!a || !b) return false;
  return Math.abs(Number(a.from) - Number(b.from)) < 1e-6 && Math.abs(Number(a.to) - Number(b.to)) < 1e-6;
}

// Create price chart
function createPriceChart(container: HTMLElement) {
  const chart = createChart(container, {
    layout: {
      background: { color: tc().bgColor },
      textColor: tc().textPrimary,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    crosshair: {
      mode: isMobileTouch ? CrosshairMode.Magnet : CrosshairMode.Normal,
    },
    kineticScroll: {
      touch: false,
      mouse: false,
    },
    handleScroll: {
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: isMobileTouch,
      mouseWheel: true,
    },
    handleScale: {
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: true,
      axisDoubleClickReset: true,
    },
    rightPriceScale: {
      borderColor: tc().surfaceElevated,
      minimumWidth: SCALE_MIN_WIDTH_PX,
      entireTextOnly: true,
    },
    timeScale: {
      visible: false,
      timeVisible: true,
      secondsVisible: false,
      borderVisible: false,
      fixRightEdge: false,
      rightBarStaysOnScroll: false,
      rightOffset: RIGHT_MARGIN_BARS,
      tickMarkFormatter: formatTimeScaleTickMark,
    },
  });

  const series = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceFormat: {
      type: 'custom',
      minMove: 0.01,
      formatter: (price: number) => formatPriceScaleLabel(Number(price)),
    },
  });

  const timelineSeries = chart.addLineSeries({
    color: 'rgba(0, 0, 0, 0)',
    lineVisible: false,
    pointMarkersVisible: false,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // No line tools for price chart - divergence tool only on RSI chart

  return { chart, series, timelineSeries };
}

function createVolumeDeltaRsiChart(container: HTMLElement) {
  const chart = createChart(container, {
    layout: {
      background: { color: tc().bgColor },
      textColor: tc().textPrimary,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    crosshair: {
      mode: isMobileTouch ? CrosshairMode.Magnet : CrosshairMode.Normal,
    },
    kineticScroll: {
      touch: false,
      mouse: false,
    },
    handleScroll: {
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: isMobileTouch,
      mouseWheel: true,
    },
    handleScale: {
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: {
        time: true,
        price: false,
      },
      axisDoubleClickReset: {
        time: true,
        price: false,
      },
    },
    rightPriceScale: {
      borderColor: tc().surfaceElevated,
      minimumWidth: SCALE_MIN_WIDTH_PX,
      entireTextOnly: true,
      // Default view: 20-80 range (20% margin top + 20% margin bottom)
      // User can adjust but won't go beyond 0-100 data bounds
      scaleMargins: {
        top: 0.2, // 20% margin = hides 0-20 by default
        bottom: 0.2, // 20% margin = hides 80-100 by default
      },
    },
    timeScale: {
      visible: false,
      timeVisible: true,
      secondsVisible: false,
      borderVisible: false,
      fixRightEdge: false,
      rightBarStaysOnScroll: false,
      rightOffset: RIGHT_MARGIN_BARS,
      tickMarkFormatter: formatTimeScaleTickMark,
    },
  });

  const rsiSeries = chart.addLineSeries({
    color: volumeDeltaRsiSettings.lineColor,
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    priceFormat: {
      type: 'custom',
      minMove: 0.1,
      formatter: (value: number) => formatVolumeDeltaScaleLabel(Number(value)),
    },
    autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider(),
  });

  const timelineSeries = chart.addLineSeries({
    color: 'rgba(0, 0, 0, 0)',
    lineVisible: false,
    pointMarkersVisible: false,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  volumeDeltaRsiMidlineLine = rsiSeries.createPriceLine({
    price: VOLUME_DELTA_MIDLINE,
    color: volumeDeltaRsiSettings.midlineColor,
    lineWidth: 1,
    lineStyle: midlineStyleToLineStyle(volumeDeltaRsiSettings.midlineStyle),
    axisLabelVisible: false,
    title: 'Midline',
  });

  chart.subscribeClick((param: any) => {
    if (!param || !param.time) return;
    if (isVolumeDeltaRsiDivergencePlotToolActive()) {
      updateVolumeDeltaRsiDivergencePlotPoint(param.time, false);
      return;
    }
    if (!isVolumeDeltaDivergenceToolActive()) return;
    detectAndHandleVolumeDeltaDivergenceClick(param.time);
  });

  return { chart, rsiSeries, timelineSeries };
}

function createVolumeDeltaChart(container: HTMLElement) {
  const chart = createChart(container, {
    layout: {
      background: { color: tc().bgColor },
      textColor: tc().textPrimary,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    crosshair: {
      mode: isMobileTouch ? CrosshairMode.Magnet : CrosshairMode.Normal,
    },
    kineticScroll: {
      touch: false,
      mouse: false,
    },
    handleScroll: {
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: isMobileTouch,
      mouseWheel: true,
    },
    handleScale: {
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: {
        time: true,
        price: false,
      },
      axisDoubleClickReset: {
        time: true,
        price: false,
      },
    },
    rightPriceScale: {
      borderColor: tc().surfaceElevated,
      minimumWidth: SCALE_MIN_WIDTH_PX,
      entireTextOnly: true,
    },
    timeScale: {
      visible: false,
      timeVisible: true,
      secondsVisible: false,
      borderVisible: false,
      fixRightEdge: false,
      rightBarStaysOnScroll: false,
      rightOffset: RIGHT_MARGIN_BARS,
      tickMarkFormatter: formatTimeScaleTickMark,
    },
  });

  const histogramSeries = chart.addHistogramSeries({
    base: 0,
    priceLineVisible: false,
    lastValueVisible: false,
    priceFormat: {
      type: 'custom',
      minMove: 1,
      formatter: (value: number) => formatVolumeDeltaHistogramScaleLabel(Number(value)),
    },
  });

  const timelineSeries = chart.addLineSeries({
    color: 'rgba(0, 0, 0, 0)',
    lineVisible: false,
    pointMarkersVisible: false,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  histogramSeries.createPriceLine({
    price: 0,
    color: tc().textSecondary,
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: false,
    title: '',
  });

  // Assign global reference
  volumeDeltaChart = chart;

  return { chart, histogramSeries, timelineSeries };
}

function setVolumeDeltaRsiData(
  bars: CandleBar[],
  volumeDeltaRsi: { rsi: Array<{ time: string | number; value: number }> },
): void {
  if (!volumeDeltaRsiSeries) return;

  clearVolumeDeltaDivergence();
  const normalizedRsi = normalizeValueSeries(volumeDeltaRsi?.rsi || []);
  const vdPoints = normalizedRsi.map((point) => ({
    time: point.time,
    value: normalizeVolumeDeltaValue(Number(point.value)),
  }));
  const vdIndexByTime = new Map<string, number>();
  for (let i = 0; i < vdPoints.length; i++) {
    vdIndexByTime.set(timeKey(vdPoints[i].time), i);
  }
  setVDTrendlineData(vdPoints, vdIndexByTime);

  const rsiByTimeLocal = new Map<string, number>();
  for (const point of vdPoints) {
    rsiByTimeLocal.set(timeKey(point.time), Number(point.value));
  }

  const seriesData = bars.map((bar) => {
    const value = rsiByTimeLocal.get(timeKey(bar.time));
    if (!Number.isFinite(value)) return { time: bar.time };
    return { time: bar.time, value: Number(value) };
  });

  volumeDeltaRsiSeries.setData(seriesData);

  volumeDeltaRsiByTime = new Map<string, number>();
  for (const bar of bars) {
    const key = timeKey(bar.time);
    const rsiValue = rsiByTimeLocal.get(key);
    if (Number.isFinite(rsiValue)) {
      volumeDeltaRsiByTime.set(key, Number(rsiValue));
    }
  }
  refreshActiveDivergenceOverlays();
}

function setVolumeDeltaHistogramData(
  bars: CandleBar[],
  volumeDeltaValues: Array<{ time: string | number; delta: number }>,
): void {
  if (!volumeDeltaHistogramSeries) return;

  const deltaByTime = new Map<string, number>();
  for (const point of volumeDeltaValues) {
    const delta = Number(point.delta);
    if (!Number.isFinite(delta)) continue;
    deltaByTime.set(timeKey(point.time), delta);
  }

  const histogramData = bars.map((bar) => {
    const delta = deltaByTime.get(timeKey(bar.time)) ?? 0;
    const numeric = Number.isFinite(Number(delta)) ? Number(delta) : 0;
    return {
      time: bar.time,
      value: numeric,
      color: numeric >= 0 ? VOLUME_DELTA_POSITIVE_COLOR : VOLUME_DELTA_NEGATIVE_COLOR,
    };
  });

  volumeDeltaHistogramSeries.setData(histogramData);
  volumeDeltaByTime = new Map(histogramData.map((point) => [timeKey(point.time), Number(point.value) || 0]));
  applyPricePaneDivergentBarColors();
}

function applyPricePaneDivergentBarColors(): void {
  if (!candleSeries) return;
  if (!Array.isArray(currentBars) || currentBars.length === 0) {
    candleSeries.setData([]);
    return;
  }

  if (!volumeDeltaSettings.divergentPriceBars) {
    candleSeries.setData(currentBars);
    return;
  }

  const bullishColor = volumeDeltaSettings.bullishDivergentColor || DEFAULT_VOLUME_DELTA_SETTINGS.bullishDivergentColor;
  const bearishColor = volumeDeltaSettings.bearishDivergentColor || DEFAULT_VOLUME_DELTA_SETTINGS.bearishDivergentColor;
  const configuredNeutral = String(volumeDeltaSettings.neutralDivergentColor || '')
    .trim()
    .toLowerCase();
  const convergentColor =
    configuredNeutral === tc().textPrimary
      ? DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor
      : volumeDeltaSettings.neutralDivergentColor || DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor;

  const barsWithBodyColor = currentBars.map((bar, index) => {
    const close = Number(bar?.close);
    const prevClose = Number(currentBars[index - 1]?.close);
    const delta = Number(volumeDeltaByTime.get(timeKey(bar.time)));
    const hasComparableBar = index > 0 && Number.isFinite(close) && Number.isFinite(prevClose);
    const hasDelta = Number.isFinite(delta);

    let bodyColor = convergentColor;
    if (hasComparableBar && hasDelta) {
      const isBullishDivergence = delta > 0 && close < prevClose;
      const isBearishDivergence = delta < 0 && close > prevClose;
      if (isBullishDivergence) {
        bodyColor = bullishColor;
      } else if (isBearishDivergence) {
        bodyColor = bearishColor;
      }
    }

    return {
      ...bar,
      color: bodyColor,
    };
  });

  candleSeries.setData(barsWithBodyColor);
}

function normalizeCandleBars(bars: CandleBar[]): CandleBar[] {
  return bars.filter(
    (bar) =>
      bar &&
      (typeof bar.time === 'string' || typeof bar.time === 'number') &&
      Number.isFinite(Number(bar.open)) &&
      Number.isFinite(Number(bar.high)) &&
      Number.isFinite(Number(bar.low)) &&
      Number.isFinite(Number(bar.close)),
  );
}

function applyChartSizes(
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement,
): void {
  if (!priceChart) return;

  const chartRect = chartContainer.getBoundingClientRect();
  const volumeDeltaRsiRect = volumeDeltaRsiContainer.getBoundingClientRect();
  const rsiRect = rsiContainer.getBoundingClientRect();
  const volumeDeltaRect = volumeDeltaContainer.getBoundingClientRect();
  const priceWidth = Math.max(1, Math.floor(chartRect.width));
  const priceHeight = Math.max(1, Math.floor(chartRect.height));
  const volumeDeltaRsiWidth = Math.max(1, Math.floor(volumeDeltaRsiRect.width));
  const volumeDeltaRsiHeight = Math.max(1, Math.floor(volumeDeltaRsiRect.height));
  const rsiWidth = Math.max(1, Math.floor(rsiRect.width));
  const rsiHeight = Math.max(1, Math.floor(rsiRect.height));
  const volumeDeltaWidth = Math.max(1, Math.floor(volumeDeltaRect.width));
  const volumeDeltaHeight = Math.max(1, Math.floor(volumeDeltaRect.height));

  priceChart.applyOptions({ width: priceWidth, height: priceHeight });
  if (volumeDeltaRsiChart) {
    volumeDeltaRsiChart.applyOptions({ width: volumeDeltaRsiWidth, height: volumeDeltaRsiHeight });
  }
  if (rsiChart) {
    rsiChart.getChart().applyOptions({ width: rsiWidth, height: rsiHeight });
    rsiChart.refreshTrendlineLabels();
  }
  if (volumeDeltaChart) {
    volumeDeltaChart.applyOptions({ width: volumeDeltaWidth, height: volumeDeltaHeight });
  }
  scheduleChartLayoutRefresh();
}

function ensureResizeObserver(
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement,
): void {
  if (chartResizeObserver) return;

  chartResizeObserver = new ResizeObserver(() => {
    applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  });

  chartResizeObserver.observe(chartContainer);
  chartResizeObserver.observe(volumeDeltaRsiContainer);
  chartResizeObserver.observe(rsiContainer);
  chartResizeObserver.observe(volumeDeltaContainer);
}

/** Apply persisted pane heights (if any) to the containers. */
function applyPersistedPaneHeights(
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement,
): void {
  const containers = [chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer];
  for (const c of containers) {
    const h = paneHeights[c.id];
    if (h && h >= PANE_HEIGHT_MIN && h <= PANE_HEIGHT_MAX) {
      c.style.height = `${h}px`;
    }
  }
}

/** Install draggable resize handles on the bottom edge of each pane. */
function ensurePaneResizeHandles(
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement,
): void {
  if (paneResizeHandlesInstalled) return;
  paneResizeHandlesInstalled = true;

  const containers = [chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer];
  for (const container of containers) {
    const handle = document.createElement('div');
    handle.className = 'pane-resize-handle';
    container.appendChild(handle);

    let startY = 0;
    let startHeight = 0;

    const onPointerMove = (e: PointerEvent) => {
      const delta = e.clientY - startY;
      const newHeight = Math.min(PANE_HEIGHT_MAX, Math.max(PANE_HEIGHT_MIN, startHeight + delta));
      container.style.height = `${newHeight}px`;
    };

    const onPointerUp = (e: PointerEvent) => {
      handle.classList.remove('active');
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);

      // Persist the final height.
      const finalHeight = container.getBoundingClientRect().height;
      paneHeights[container.id] = Math.round(finalHeight);
      persistSettingsToStorage();
    };

    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      startY = e.clientY;
      startHeight = container.getBoundingClientRect().height;
      handle.classList.add('active');
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
    });

    // Double-click resets to default height.
    handle.addEventListener('dblclick', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const defaultH = DEFAULT_PANE_HEIGHTS[container.id];
      if (defaultH) {
        container.style.height = `${defaultH}px`;
        delete paneHeights[container.id];
        persistSettingsToStorage();
      }
    });
  }
}

function scheduleIntervalChartRender(interval: ChartInterval): void {
  const scheduledTicker = currentChartTicker;
  if (!scheduledTicker) return;
  if (intervalSwitchDebounceTimer !== null) {
    window.clearTimeout(intervalSwitchDebounceTimer);
    intervalSwitchDebounceTimer = null;
  }
  intervalSwitchDebounceTimer = window.setTimeout(() => {
    intervalSwitchDebounceTimer = null;
    if (!currentChartTicker || currentChartTicker !== scheduledTicker) return;
    renderCustomChart(scheduledTicker, interval);
  }, INTERVAL_SWITCH_DEBOUNCE_MS);
}

function isTickerChartVisible(): boolean {
  if (document.visibilityState !== 'visible') return false;
  const liveView = document.getElementById('view-live');
  if (liveView?.classList.contains('hidden')) return false;
  const tickerView = document.getElementById('ticker-view');
  if (tickerView?.classList.contains('hidden')) return false;
  return true;
}

function isRegularTradingHoursEtNow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((part) => part.type === 'weekday')?.value || '';
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false;

  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;

  const minutesSinceMidnight = hour * 60 + minute;
  const marketOpenMinutes = 9 * 60 + 30;
  const marketCloseMinutes = 16 * 60;
  return minutesSinceMidnight >= marketOpenMinutes && minutesSinceMidnight < marketCloseMinutes;
}

async function isRegularTradingHoursByServerContext(): Promise<boolean> {
  const nowMs = Date.now();
  if (nowMs - marketContextCachedAtMs <= MARKET_CONTEXT_CACHE_MS) {
    return marketContextIsRegularHoursEt;
  }

  const abortController = new AbortController();
  const timeoutId = window.setTimeout(() => {
    abortController.abort();
  }, 4000);
  try {
    const response = await fetch('/api/trading-calendar/context', {
      cache: 'no-store',
      signal: abortController.signal,
    });
    if (!response.ok) {
      const fallback = isRegularTradingHoursEtNow();
      marketContextCachedAtMs = nowMs;
      marketContextIsRegularHoursEt = fallback;
      return fallback;
    }
    const payload = (await response.json().catch(() => null)) as TradingCalendarContextPayload | null;
    const open = Boolean(payload?.isRegularHoursEt);
    marketContextCachedAtMs = nowMs;
    marketContextIsRegularHoursEt = open;
    return open;
  } catch {
    const fallback = isRegularTradingHoursEtNow();
    marketContextCachedAtMs = nowMs;
    marketContextIsRegularHoursEt = fallback;
    return fallback;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function patchLatestBarInPlaceFromPayload(data: ChartLatestData): boolean {
  if (!candleSeries || !rsiChart || !volumeDeltaRsiSeries || !volumeDeltaHistogramSeries) return false;
  if (!Array.isArray(currentBars) || currentBars.length === 0) return false;

  const currentLastIndex = currentBars.length - 1;
  const currentLast = currentBars[currentLastIndex];
  const fetchedLast = data.latestBar;
  if (!fetchedLast) return false;
  if (timeKey(currentLast?.time) !== timeKey(fetchedLast.time)) {
    return false;
  }

  const lastTime = currentLast.time;
  const lastKey = timeKey(lastTime);
  currentBars[currentLastIndex] = {
    ...currentLast,
    ...fetchedLast,
  };

  const latestClose = Number(currentBars[currentLastIndex].close);
  if (Number.isFinite(latestClose)) {
    priceByTime.set(lastKey, latestClose);
  }
  barIndexByTime.set(lastKey, currentLastIndex);

  if (currentLastIndex > 0) {
    const prevClose = Number(currentBars[currentLastIndex - 1]?.close);
    if (Number.isFinite(prevClose) && prevClose !== 0 && Number.isFinite(latestClose)) {
      const percentChange = ((latestClose - prevClose) / prevClose) * 100;
      priceChangeByTime.set(lastKey, percentChange);
    }
  }

  const latestRsi = Number(data.latestRsi?.value);
  if (Number.isFinite(latestRsi)) {
    rsiByTime.set(lastKey, Number(latestRsi));
    const updated = rsiChart.updateLatestPoint(
      { time: lastTime, value: Number(latestRsi) },
      Number.isFinite(latestClose) ? { time: lastTime, close: latestClose } : undefined,
    );
    if (!updated) return false;
  }

  const latestVdRsi = Number(data.latestVolumeDeltaRsi?.value);
  if (Number.isFinite(latestVdRsi)) {
    const normalizedVdRsi = normalizeVolumeDeltaValue(Number(latestVdRsi));
    volumeDeltaRsiByTime.set(lastKey, normalizedVdRsi);
    updateVDRsiLastPoint(lastKey, normalizedVdRsi);
    volumeDeltaRsiSeries.update({
      time: lastTime,
      value: normalizedVdRsi,
    });
  }

  const latestDelta = Number(data.latestVolumeDelta?.delta);
  if (Number.isFinite(latestDelta)) {
    const numericDelta = Number(latestDelta);
    volumeDeltaByTime.set(lastKey, numericDelta);
    volumeDeltaHistogramSeries.update({
      time: lastTime,
      value: numericDelta,
      color: numericDelta >= 0 ? VOLUME_DELTA_POSITIVE_COLOR : VOLUME_DELTA_NEGATIVE_COLOR,
    });
  }

  if (volumeDeltaSettings.divergentPriceBars) {
    applyPricePaneDivergentBarColors();
  } else {
    candleSeries.update(currentBars[currentLastIndex]);
  }

  updateMovingAveragesLatestPoint();
  if (pricePaneContainerEl) {
    setPricePaneChange(pricePaneContainerEl, null);
  }
  if (volumeDeltaPaneContainerEl) {
    renderVolumeDeltaDivergenceSummary(volumeDeltaPaneContainerEl, currentBars);
  }
  refreshActiveDivergenceOverlays();
  return true;
}

async function refreshLatestChartDataInPlace(ticker: string, interval: ChartInterval): Promise<void> {
  const fetchStartedAt = performance.now();
  let responseCacheHeader: string | null = null;
  const data = await fetchChartLatestData(ticker, interval, {
    vdRsiLength: volumeDeltaRsiSettings.length,
    vdSourceInterval: volumeDeltaSettings.sourceInterval,
    vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
    onResponseMeta: (meta) => {
      responseCacheHeader = meta.chartCacheHeader;
    },
  });
  recordChartFetchPerf(interval, performance.now() - fetchStartedAt, responseCacheHeader);

  if (!currentChartTicker || currentChartTicker !== ticker || currentChartInterval !== interval) return;
  if (!Array.isArray(currentBars) || currentBars.length === 0) return;
  const currentLastTime = currentBars[currentBars.length - 1]?.time;
  const fetchedLast = data.latestBar;
  if (currentLastTime === undefined || currentLastTime === null || !fetchedLast) {
    await renderCustomChart(ticker, interval, { silent: true });
    return;
  }
  const currentLastKey = timeKey(currentLastTime);
  const fetchedLastKey = timeKey(fetchedLast.time);
  if (currentLastKey !== fetchedLastKey) {
    await renderCustomChart(ticker, interval, { silent: true });
    return;
  }

  const patched = patchLatestBarInPlaceFromPayload(data);
  if (!patched) {
    await renderCustomChart(ticker, interval, { silent: true });
  }
}

function applyChartDataToUi(
  data: ChartData,
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement,
): void {
  const bars = normalizeCandleBars(data.bars || []);
  if (bars.length === 0) {
    throw new Error('No valid chart bars returned for this ticker/interval');
  }

  monthBoundaryTimes = buildMonthBoundaryTimes(bars);
  applyFutureTimelineSeriesData(bars);
  const rsiData = buildRSISeriesFromBars(bars, rsiSettings.length);
  const volumeDeltaRsiData = {
    rsi: normalizeValueSeries(data.volumeDeltaRsi?.rsi || []),
  };
  const volumeDeltaData = normalizeVolumeDeltaSeries(data.volumeDelta || []);
  currentBars = bars;
  barIndexByTime = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) {
    barIndexByTime.set(timeKey(bars[i].time), i);
  }
  rebuildPricePaneChangeMap(bars);
  priceByTime = new Map(bars.map((bar) => [timeKey(bar.time), Number(bar.close)]));
  rsiByTime = new Map(
    rsiData
      .filter((point) => Number.isFinite(Number(point.value)))
      .map((point) => [timeKey(point.time), Number(point.value)]),
  );

  if (candleSeries) {
    candleSeries.setData(bars);
  }
  setPricePaneChange(chartContainer, null);
  setVolumeDeltaRsiData(bars, volumeDeltaRsiData);
  setVolumeDeltaHistogramData(bars, volumeDeltaData);
  renderVolumeDeltaDivergenceSummary(volumeDeltaContainer, bars);
  applyVolumeDeltaRSIVisualSettings();

  if (!rsiChart && rsiContainer) {
    rsiChart = new RSIChart({
      container: rsiContainer,
      data: rsiData,
      displayMode: 'line',
      lineColor: rsiSettings.lineColor,
      midlineColor: rsiSettings.midlineColor,
      midlineStyle: rsiSettings.midlineStyle,
      priceData: bars.map((b) => ({ time: b.time, close: b.close })),
      onTrendLineDrawn: () => {
        rsiChart?.deactivateDivergenceTool();
        rsiDivergenceToolActive = false;
        setPaneTrendlineToolActive('rsi', false);
        persistTrendlinesForCurrentContext();
      },
    });
    applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    applyPaneScaleVisibilityByPosition();
  } else if (rsiChart) {
    rsiChart.setData(
      rsiData,
      bars.map((b) => ({ time: b.time, close: b.close })),
    );
  }

  applyRSISettings();
  restorePersistedTrendlinesForCurrentContext();
  setupChartSync();

  applyMovingAverages();
  applyRightMargin();
  syncChartsToPriceRange();
  scheduleChartLayoutRefresh();

  // Run VDF detection after divergence table + MAs complete
  if (currentChartTicker) {
    runVDFDetection(currentChartTicker);
  }
}

function ensureChartLiveRefreshTimer(): void {
  if (chartLiveRefreshTimer !== null) return;
  chartLiveRefreshTimer = window.setInterval(() => {
    if (chartLiveRefreshInFlight) return;
    if (chartFetchAbortController) return;
    if (!currentChartTicker) return;
    if (!isTickerChartVisible()) return;

    const scheduledTicker = currentChartTicker;
    const scheduledInterval = currentChartInterval;
    chartLiveRefreshInFlight = true;
    isRegularTradingHoursByServerContext()
      .then((isOpen) => {
        if (!isOpen) return;
        return refreshLatestChartDataInPlace(scheduledTicker, scheduledInterval);
      })
      .catch(() => {})
      .finally(() => {
        chartLiveRefreshInFlight = false;
      });
  }, CHART_LIVE_REFRESH_MS);
}

export function isChartActivelyLoading(): boolean {
  return chartActivelyLoading;
}

function abortPrefetches(): void {
  if (prefetchAbortController) {
    try {
      prefetchAbortController.abort();
    } catch {
      /* ignore */
    }
    prefetchAbortController = null;
  }
}

export function cancelChartLoading(): void {
  if (chartFetchAbortController) {
    try {
      chartFetchAbortController.abort();
    } catch {
      /* ignore */
    }
    chartFetchAbortController = null;
  }
  abortPrefetches();
  if (chartLiveRefreshTimer !== null) {
    window.clearInterval(chartLiveRefreshTimer);
    chartLiveRefreshTimer = null;
  }
  chartLiveRefreshInFlight = false;
  chartActivelyLoading = false;
  latestRenderRequestId++;
}

interface RenderCustomChartOptions {
  silent?: boolean;
}

export async function renderCustomChart(
  ticker: string,
  interval: ChartInterval = currentChartInterval,
  options: RenderCustomChartOptions = {},
) {
  const silent = options.silent === true;
  ensureSettingsLoadedFromStorage();
  const previousTicker = currentChartTicker;
  const previousInterval = currentChartInterval;
  const requestId = ++latestRenderRequestId;
  const contextChanged =
    typeof previousTicker === 'string' && (previousTicker !== ticker || previousInterval !== interval);
  const shouldApplyWeeklyDefaultRange = interval === '1week' && (typeof previousTicker !== 'string' || contextChanged);
  currentChartInterval = interval;
  currentChartTicker = ticker;
  const cacheKey = buildChartDataCacheKey(ticker, interval);

  if (contextChanged) {
    deactivateRsiDivergencePlotTool();
    deactivateVolumeDeltaRsiDivergencePlotTool();
    deactivateVolumeDeltaDivergenceTool();
    rsiDivergenceToolActive = false;
    // Re-bind chart sync on next setupChartSync call since charts may be recreated.
    isChartSyncBound = false;
    crosshairHidden = false;
    clearVDFAnalysisPanel();
  }

  const chartContent = document.getElementById('chart-content');
  if (!chartContent || !(chartContent instanceof HTMLElement)) {
    console.error('Chart content container not found');
    return;
  }
  ensurePaneReorderUI(chartContent);

  const chartContainer = document.getElementById('price-chart-container');
  const volumeDeltaRsiContainer = document.getElementById('vd-rsi-chart-container');
  const rsiContainer = document.getElementById('rsi-chart-container');
  const volumeDeltaContainer = document.getElementById('vd-chart-container');
  const errorContainer = document.getElementById('chart-error');

  if (!chartContainer || !volumeDeltaRsiContainer || !rsiContainer || !volumeDeltaContainer || !errorContainer) {
    console.error('Chart containers not found');
    return;
  }
  pricePaneContainerEl = chartContainer as HTMLElement;
  volumeDeltaPaneContainerEl = volumeDeltaContainer as HTMLElement;

  // Clear error
  errorContainer.style.display = 'none';
  errorContainer.textContent = '';
  setPricePaneMessage(chartContainer, null);
  ensureMonthGridOverlay(chartContainer, 'price');
  ensureMonthGridOverlay(volumeDeltaRsiContainer, 'volumeDeltaRsi');
  ensureMonthGridOverlay(rsiContainer, 'rsi');
  ensureMonthGridOverlay(volumeDeltaContainer, 'volumeDelta');
  ensureVDZoneOverlay(chartContainer);
  ensureVDFAnalysisPanel();
  renderVDFAnalysisPanel(null, currentChartTicker || '');
  ensureSettingsUI(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  syncTopPaneTickerLabel();

  // Initialize charts if needed
  if (!priceChart) {
    const { chart, series, timelineSeries } = createPriceChart(chartContainer);
    priceChart = chart;
    candleSeries = series;
    priceTimelineSeries = timelineSeries;
    applyPriceGridOptions();
  }
  if (!volumeDeltaRsiChart) {
    const { chart, rsiSeries, timelineSeries } = createVolumeDeltaRsiChart(volumeDeltaRsiContainer);
    volumeDeltaRsiChart = chart;
    volumeDeltaRsiSeries = rsiSeries;
    volumeDeltaRsiTimelineSeries = timelineSeries;
    applyVolumeDeltaRSIVisualSettings();
  }
  if (!volumeDeltaChart) {
    const { chart, histogramSeries, timelineSeries } = createVolumeDeltaChart(volumeDeltaContainer);
    volumeDeltaChart = chart;
    volumeDeltaHistogramSeries = histogramSeries;
    volumeDeltaTimelineSeries = timelineSeries;
  }

  applyPersistedPaneHeights(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  ensureResizeObserver(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  ensurePaneResizeHandles(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  applyPaneScaleVisibilityByPosition();

  const cachedData = silent ? null : getCachedChartData(cacheKey);
  const hasCachedData = Boolean(cachedData);
  if (cachedData) {
    const renderStartedAt = performance.now();
    applyChartDataToUi(
      cachedData,
      chartContainer as HTMLElement,
      volumeDeltaRsiContainer as HTMLElement,
      rsiContainer as HTMLElement,
      volumeDeltaContainer as HTMLElement,
    );
    recordChartRenderPerf(interval, performance.now() - renderStartedAt);
    if (shouldApplyWeeklyDefaultRange) {
      applyWeeklyInitialVisibleRange();
    }
    prefetchRelatedIntervals(ticker, interval);
  } else if (!silent) {
    // Show loading indicators only on user-triggered renders.
    showLoadingOverlay(chartContainer);
    showLoadingOverlay(volumeDeltaRsiContainer);
    showLoadingOverlay(rsiContainer);
    showLoadingOverlay(volumeDeltaContainer);
  }

  // P0: Active chart load — abort any in-flight prefetches (P1/P3) and
  // prior active fetches so all resources go to the new request.
  abortPrefetches();
  if (chartFetchAbortController) {
    try {
      chartFetchAbortController.abort();
    } catch {
      // Ignore abort errors from stale controllers.
    }
  }
  const fetchController = new AbortController();
  chartFetchAbortController = fetchController;
  if (!silent) chartActivelyLoading = true;

  try {
    const fetchStartedAt = performance.now();
    let responseCacheHeader: string | null = null;
    // Fetch data from API
    const data = await fetchChartData(ticker, interval, {
      vdRsiLength: volumeDeltaRsiSettings.length,
      vdSourceInterval: volumeDeltaSettings.sourceInterval,
      vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
      signal: fetchController.signal,
      onResponseMeta: (meta) => {
        responseCacheHeader = meta.chartCacheHeader;
      },
    });
    recordChartFetchPerf(interval, performance.now() - fetchStartedAt, responseCacheHeader);
    if (requestId !== latestRenderRequestId) return;
    const shouldApplyFreshData = !hasCachedData || getLastBarSignature(cachedData) !== getLastBarSignature(data);
    if (shouldApplyFreshData) {
      const renderStartedAt = performance.now();
      applyChartDataToUi(
        data,
        chartContainer as HTMLElement,
        volumeDeltaRsiContainer as HTMLElement,
        rsiContainer as HTMLElement,
        volumeDeltaContainer as HTMLElement,
      );
      recordChartRenderPerf(interval, performance.now() - renderStartedAt);
      if (shouldApplyWeeklyDefaultRange) {
        applyWeeklyInitialVisibleRange();
      }
    }
    setCachedChartData(cacheKey, data);
    prefetchRelatedIntervals(ticker, interval);

    if (!silent) {
      // Hide loading indicators after successful load
      hideLoadingOverlay(chartContainer);
      hideLoadingOverlay(volumeDeltaRsiContainer);
      hideLoadingOverlay(rsiContainer);
      hideLoadingOverlay(volumeDeltaContainer);
    }
  } catch (err: unknown) {
    if (requestId !== latestRenderRequestId) return;
    if (err instanceof Error && err.name === 'AbortError') return;

    console.error('Failed to load chart:', err);
    if (silent) {
      return;
    }
    if (hasCachedData) {
      return;
    }
    if (isNoDataTickerError(err)) {
      // Hide loading indicators for no-data state.
      hideLoadingOverlay(chartContainer);
      hideLoadingOverlay(volumeDeltaRsiContainer);
      hideLoadingOverlay(rsiContainer);
      hideLoadingOverlay(volumeDeltaContainer);
      if (candleSeries) {
        candleSeries.setData([]);
      }
      priceChangeByTime = new Map();
      setPricePaneChange(chartContainer, null);
      if (rsiChart) {
        rsiChart.setData([], []);
      }
      if (volumeDeltaRsiChart) {
        volumeDeltaRsiSeries?.setData([]);
      }
      if (volumeDeltaChart) {
        volumeDeltaHistogramSeries?.setData([]);
      }
      applyFutureTimelineSeriesData([]);
      clearVolumeDeltaDivergence();
      resetVDTrendlineData();
      volumeDeltaRsiByTime = new Map();
      volumeDeltaByTime = new Map();
      clearVolumeDeltaDivergenceSummary();
      currentBars = [];
      barIndexByTime = new Map();
      clearMovingAverageSeries();
      monthBoundaryTimes = [];
      clearMonthGridOverlay(priceMonthGridOverlayEl);
      clearMonthGridOverlay(volumeDeltaRsiMonthGridOverlayEl);
      clearMonthGridOverlay(volumeDeltaMonthGridOverlayEl);
      clearMonthGridOverlay(rsiMonthGridOverlayEl);
      renderVDZones(null);
      renderVDFAnalysisPanel(null, '');
      setPricePaneMessage(chartContainer, INVALID_SYMBOL_MESSAGE);
      deactivateRsiDivergencePlotTool();
      deactivateVolumeDeltaRsiDivergencePlotTool();
      errorContainer.style.display = 'none';
      errorContainer.textContent = '';
      return;
    }

    priceChangeByTime = new Map();
    setPricePaneChange(chartContainer, null);
    clearVolumeDeltaDivergenceSummary();
    deactivateRsiDivergencePlotTool();
    deactivateVolumeDeltaRsiDivergencePlotTool();
    errorContainer.style.display = 'none';
    errorContainer.textContent = '';

    const retryRender = () => {
      showLoadingOverlay(chartContainer);
      showLoadingOverlay(volumeDeltaRsiContainer);
      showLoadingOverlay(rsiContainer);
      showLoadingOverlay(volumeDeltaContainer);
      renderCustomChart(ticker, interval);
    };

    showRetryOverlay(chartContainer, retryRender);
    showRetryOverlay(volumeDeltaRsiContainer, retryRender);
    showRetryOverlay(rsiContainer, retryRender);
    showRetryOverlay(volumeDeltaContainer, retryRender);
  } finally {
    if (!silent) chartActivelyLoading = false;
    if (chartFetchAbortController === fetchController) {
      chartFetchAbortController = null;
    }
    // Clear chart refresh button loading state
    const chartRefreshBtn = document.getElementById('chart-refresh-btn');
    if (chartRefreshBtn) setRefreshButtonLoading(chartRefreshBtn, false);
  }
}

function syncChartsToPriceRange(): void {
  if (!priceChart) return;
  const priceRange = priceChart.timeScale().getVisibleLogicalRange();
  if (!priceRange) return;
  try {
    if (volumeDeltaRsiChart) {
      volumeDeltaRsiChart.timeScale().setVisibleLogicalRange(priceRange);
    }
    if (rsiChart) {
      rsiChart.getChart().timeScale().setVisibleLogicalRange(priceRange);
    }
    if (volumeDeltaChart) {
      volumeDeltaChart.timeScale().setVisibleLogicalRange(priceRange);
    }
    scheduleChartLayoutRefresh();
  } catch {
    // Ignore transient range sync errors during live updates.
  }
}

function applyRightMargin(): void {
  if (!priceChart) return;
  const rightOffset = RIGHT_MARGIN_BARS;
  priceChart.timeScale().applyOptions({ rightOffset });
  if (volumeDeltaRsiChart) {
    volumeDeltaRsiChart.timeScale().applyOptions({ rightOffset });
  }
  if (rsiChart) {
    rsiChart.getChart().timeScale().applyOptions({ rightOffset });
  }
  if (volumeDeltaChart) {
    volumeDeltaChart.timeScale().applyOptions({ rightOffset });
  }
  scheduleChartLayoutRefresh();
}

function applyWeeklyInitialVisibleRange(): void {
  if (!priceChart) return;
  if (currentChartInterval !== '1week') return;
  if (!Array.isArray(currentBars) || currentBars.length === 0) return;

  const lastIndex = currentBars.length - 1;
  // One-and-a-half-year weekly window (approx 78 bars).
  const weeklyBarsToShow = Math.min(currentBars.length, 78);
  const from = Math.max(0, lastIndex - weeklyBarsToShow + 1);
  const to = lastIndex + RIGHT_MARGIN_BARS;

  try {
    priceChart.timeScale().setVisibleLogicalRange({ from, to });
    syncChartsToPriceRange();
    scheduleChartLayoutRefresh();
  } catch {
    // Ignore transient logical-range errors during render lifecycle.
  }
}

function getNearestMappedValueAtOrBefore(time: string | number, valuesByTime: Map<string, number>): number | null {
  const result = getNearestMappedEntryAtOrBefore(time, valuesByTime);
  return result ? result.value : null;
}

function getNearestMappedEntryAtOrBefore(
  time: string | number,
  valuesByTime: Map<string, number>,
): { time: string | number; value: number } | null {
  const direct = Number(valuesByTime.get(timeKey(time)));
  if (Number.isFinite(direct)) return { time, value: direct };
  if (!Array.isArray(currentBars) || currentBars.length === 0) return null;

  const targetUnix = toUnixSeconds(time);
  for (let i = currentBars.length - 1; i >= 0; i--) {
    const bar = currentBars[i];
    if (!bar) continue;
    const barTime = bar.time;
    if (targetUnix !== null) {
      const barUnix = toUnixSeconds(barTime);
      if (barUnix !== null && barUnix > targetUnix) continue;
    }
    const candidate = Number(valuesByTime.get(timeKey(barTime)));
    if (Number.isFinite(candidate)) return { time: barTime, value: candidate };
  }
  return null;
}

/** Toggle crosshair visibility on all four chart panes. */
function toggleCrosshairVisibility() {
  crosshairHidden = !crosshairHidden;
  const lineOpts = { visible: !crosshairHidden };
  const opts = { crosshair: { vertLine: lineOpts, horzLine: lineOpts } };
  if (priceChart) priceChart.applyOptions(opts);
  if (volumeDeltaRsiChart) volumeDeltaRsiChart.applyOptions(opts);
  if (volumeDeltaChart) volumeDeltaChart.applyOptions(opts);
  if (rsiChart) rsiChart.getChart()?.applyOptions(opts);
  if (crosshairHidden) {
    priceChart?.clearCrosshairPosition();
    volumeDeltaRsiChart?.clearCrosshairPosition();
    volumeDeltaChart?.clearCrosshairPosition();
    rsiChart?.getChart()?.clearCrosshairPosition();
  }
}

// Setup sync between price, Volume Delta RSI, RSI, and Volume Delta charts.
function setupChartSync() {
  if (isChartSyncBound) return;
  if (!priceChart || !volumeDeltaRsiChart || !rsiChart || !volumeDeltaChart) return;
  if (!candleSeries || !volumeDeltaRsiSeries || !volumeDeltaHistogramSeries) return;

  isChartSyncBound = true;
  const volumeDeltaRsiChartInstance = volumeDeltaRsiChart;
  const rsiChartInstance = rsiChart.getChart();
  const volumeDeltaChartInstance = volumeDeltaChart;

  let syncLock: 'price' | 'volumeDeltaRsi' | 'rsi' | 'volumeDelta' | null = null;
  const unlockAfterFrame = (owner: 'price' | 'volumeDeltaRsi' | 'rsi' | 'volumeDelta') => {
    requestAnimationFrame(() => {
      if (syncLock === owner) syncLock = null;
    });
  };

  const syncRangeFromOwner = (owner: 'price' | 'volumeDeltaRsi' | 'rsi' | 'volumeDelta', timeRange: any) => {
    if (!timeRange) return;

    const targets: Array<{ owner: 'price' | 'volumeDeltaRsi' | 'rsi' | 'volumeDelta'; chart: any }> = [
      { owner: 'price', chart: priceChart },
      { owner: 'volumeDeltaRsi', chart: volumeDeltaRsiChartInstance },
      { owner: 'rsi', chart: rsiChartInstance },
      { owner: 'volumeDelta', chart: volumeDeltaChartInstance },
    ];
    for (const target of targets) {
      if (target.owner === owner) continue;
      const currentRange = target.chart.timeScale().getVisibleLogicalRange();
      if (!sameLogicalRange(currentRange, timeRange)) {
        target.chart.timeScale().setVisibleLogicalRange(timeRange);
      }
    }
    scheduleChartLayoutRefresh();
  };

  priceChart.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (!timeRange || syncLock === 'volumeDeltaRsi' || syncLock === 'rsi' || syncLock === 'volumeDelta') return;
    syncLock = 'price';
    try {
      syncRangeFromOwner('price', timeRange);
    } finally {
      unlockAfterFrame('price');
    }
  });

  volumeDeltaRsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (isVolumeDeltaSyncSuppressed()) return;
    if (!timeRange || syncLock === 'price' || syncLock === 'rsi' || syncLock === 'volumeDelta') return;
    syncLock = 'volumeDeltaRsi';
    try {
      syncRangeFromOwner('volumeDeltaRsi', timeRange);
    } finally {
      unlockAfterFrame('volumeDeltaRsi');
    }
  });

  rsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (rsiChart?.isSyncSuppressed?.()) return;
    if (!timeRange || syncLock === 'price' || syncLock === 'volumeDeltaRsi' || syncLock === 'volumeDelta') return;
    syncLock = 'rsi';
    try {
      syncRangeFromOwner('rsi', timeRange);
    } finally {
      unlockAfterFrame('rsi');
    }
  });

  volumeDeltaChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (!timeRange || syncLock === 'price' || syncLock === 'volumeDeltaRsi' || syncLock === 'rsi') return;
    syncLock = 'volumeDelta';
    try {
      syncRangeFromOwner('volumeDelta', timeRange);
    } finally {
      unlockAfterFrame('volumeDelta');
    }
  });

  const setCrosshairOnPrice = (time: string | number) => {
    const entry = getNearestMappedEntryAtOrBefore(time, priceByTime);
    if (entry && candleSeries) {
      try {
        priceChart.setCrosshairPosition(entry.value, entry.time, candleSeries);
      } catch {
        priceChart.clearCrosshairPosition();
      }
    } else {
      priceChart.clearCrosshairPosition();
    }
  };

  const setCrosshairOnVolumeDeltaRsi = (time: string | number) => {
    const entry = getNearestMappedEntryAtOrBefore(time, volumeDeltaRsiByTime);
    if (entry) {
      try {
        volumeDeltaRsiChartInstance.setCrosshairPosition(entry.value, entry.time, volumeDeltaRsiSeries);
      } catch {
        volumeDeltaRsiChartInstance.clearCrosshairPosition();
      }
    } else {
      volumeDeltaRsiChartInstance.clearCrosshairPosition();
    }
  };

  const setCrosshairOnRsi = (time: string | number) => {
    const entry = getNearestMappedEntryAtOrBefore(time, rsiByTime);
    const rsiSeries = rsiChart?.getSeries();
    if (entry && rsiSeries) {
      try {
        rsiChartInstance.setCrosshairPosition(entry.value, entry.time, rsiSeries);
      } catch {
        rsiChartInstance.clearCrosshairPosition();
      }
    } else {
      rsiChartInstance.clearCrosshairPosition();
    }
  };

  const setCrosshairOnVolumeDelta = (time: string | number) => {
    const entry = getNearestMappedEntryAtOrBefore(time, volumeDeltaByTime);
    if (entry) {
      try {
        volumeDeltaChartInstance.setCrosshairPosition(entry.value, entry.time, volumeDeltaHistogramSeries);
      } catch {
        volumeDeltaChartInstance.clearCrosshairPosition();
      }
    } else {
      volumeDeltaChartInstance.clearCrosshairPosition();
    }
  };

  priceChart.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      volumeDeltaRsiChartInstance.clearCrosshairPosition();
      rsiChartInstance.clearCrosshairPosition();
      volumeDeltaChartInstance.clearCrosshairPosition();
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
      return;
    }
    if (crosshairHidden) return;
    if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
    setCrosshairOnVolumeDeltaRsi(param.time);
    setCrosshairOnRsi(param.time);
    setCrosshairOnVolumeDelta(param.time);
  });

  volumeDeltaRsiChartInstance.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      priceChart.clearCrosshairPosition();
      rsiChartInstance.clearCrosshairPosition();
      volumeDeltaChartInstance.clearCrosshairPosition();
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
      return;
    }
    if (crosshairHidden) return;
    if (isVolumeDeltaRsiDivergencePlotToolActive()) {
      updateVolumeDeltaRsiDivergencePlotPoint(param.time, true);
    }
    if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
    setCrosshairOnPrice(param.time);
    setCrosshairOnRsi(param.time);
    setCrosshairOnVolumeDelta(param.time);
  });

  rsiChartInstance.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      priceChart.clearCrosshairPosition();
      volumeDeltaRsiChartInstance.clearCrosshairPosition();
      volumeDeltaChartInstance.clearCrosshairPosition();
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
      return;
    }
    if (crosshairHidden) return;
    if (isRsiDivergencePlotToolActive()) {
      updateRsiDivergencePlotPoint(param.time, true);
    }
    if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
    setCrosshairOnPrice(param.time);
    setCrosshairOnVolumeDeltaRsi(param.time);
    setCrosshairOnVolumeDelta(param.time);
  });

  volumeDeltaChartInstance.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      priceChart.clearCrosshairPosition();
      volumeDeltaRsiChartInstance.clearCrosshairPosition();
      rsiChartInstance.clearCrosshairPosition();
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
      return;
    }
    if (crosshairHidden) return;
    if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
    setCrosshairOnPrice(param.time);
    setCrosshairOnVolumeDeltaRsi(param.time);
    setCrosshairOnRsi(param.time);
  });

  rsiChartInstance.subscribeClick((param: any) => {
    if (!param || !param.time) return;
    if (!isRsiDivergencePlotToolActive()) return;
    updateRsiDivergencePlotPoint(param.time, false);
  });

  // Double-tap on chart area toggles crosshair visibility (touch only).
  // subscribeClick fires only for the chart area, not axes.
  if (isMobileTouch) {
    let lastTapTime = 0;
    const handleDoubleTap = () => {
      const now = Date.now();
      if (now - lastTapTime < 300) {
        toggleCrosshairVisibility();
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    };
    priceChart.subscribeClick(handleDoubleTap);
    volumeDeltaRsiChartInstance.subscribeClick(handleDoubleTap);
    rsiChartInstance.subscribeClick(handleDoubleTap);
    volumeDeltaChartInstance.subscribeClick(handleDoubleTap);
  }
}

// Export for main.ts usage
export function initChartControls() {
  const controls = document.getElementById('chart-controls');
  if (!controls) return;
  ensureChartLiveRefreshTimer();

  // Interval buttons
  controls.querySelectorAll('button[data-interval]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const interval = target.getAttribute('data-interval') as ChartInterval;
      if (!interval) return;

      // Update active state
      controls.querySelectorAll('button[data-interval]').forEach((b) => b.classList.remove('active'));
      target.classList.add('active');

      if (currentChartTicker) {
        scheduleIntervalChartRender(interval);
      }
    });
  });

  // RSI Display Mode
  controls.querySelectorAll('button[data-mode]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const mode = target.getAttribute('data-mode') as import('./chartApi').RSIDisplayMode | null;
      if (!mode) return;

      controls.querySelectorAll('button[data-mode]').forEach((b) => b.classList.remove('active'));
      target.classList.add('active');

      if (rsiChart) {
        rsiChart.setDisplayMode(mode);
      }
    });
  });

  // Fullscreen toggle
  initChartFullscreen();

  // Double-tap anywhere in the chart container (including axes/gaps) toggles crosshair
  const chartSection = document.getElementById('custom-chart-container');
  if (chartSection && isMobileTouch) {
    let containerLastTapTime = 0;
    chartSection.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - containerLastTapTime < 300) {
        e.preventDefault();
        toggleCrosshairVisibility();
        containerLastTapTime = 0;
      } else {
        containerLastTapTime = now;
      }
    });
  }
}

const FULLSCREEN_ENTER_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="5.5 1 1 1 1 5.5"/>
  <polyline points="10.5 1 15 1 15 5.5"/>
  <polyline points="10.5 15 15 15 15 10.5"/>
  <polyline points="5.5 15 1 15 1 10.5"/>
</svg>`;

const FULLSCREEN_EXIT_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="1 5.5 5.5 5.5 5.5 1"/>
  <polyline points="15 5.5 10.5 5.5 10.5 1"/>
  <polyline points="15 10.5 10.5 10.5 10.5 15"/>
  <polyline points="1 10.5 5.5 10.5 5.5 15"/>
</svg>`;

function initChartFullscreen(): void {
  const btn = document.getElementById('chart-fullscreen-btn');
  const container = document.getElementById('custom-chart-container');
  const navPrevBtn = document.getElementById('chart-nav-prev');
  const navNextBtn = document.getElementById('chart-nav-next');
  const refreshBtn = document.getElementById('chart-refresh-btn');

  if (!btn || !container) return;

  // Initialize Refresh Button
  if (refreshBtn) {
    setRefreshButtonLoading(refreshBtn, false);
    refreshBtn.addEventListener('click', () => {
      if (!currentChartTicker || chartActivelyLoading) return;
      // Evict cached data for current ticker+interval so fetch is forced
      const cacheKey = buildChartDataCacheKey(currentChartTicker, currentChartInterval);
      evictCachedChartData(cacheKey);
      schedulePersistChartDataCacheToSession();
      // Show loading state, re-render with fresh data, then clear loading
      setRefreshButtonLoading(refreshBtn, true);
      renderCustomChart(currentChartTicker, currentChartInterval);
    });
  }

  // Initialize Navigation Buttons
  if (navPrevBtn) {
    navPrevBtn.addEventListener('click', () => navigateChart(-1));
  }
  if (navNextBtn) {
    navNextBtn.addEventListener('click', () => navigateChart(1));
  }

  initPaneAxisNavigation();

  const updateIcon = (): void => {
    const isActive = container.classList.contains('chart-fullscreen');
    btn.innerHTML = isActive ? FULLSCREEN_EXIT_SVG : FULLSCREEN_ENTER_SVG;
    btn.title = 'Fullscreen';
    // Re-apply scale visibility — shouldShowPaneScale already accounts
    // for fullscreen state, so this handles both enter and exit.
    applyPaneScaleVisibilityByPosition();
  };

  const toggleFullscreen = () => {
    container.classList.toggle('chart-fullscreen');
    updateIcon();
  };

  btn.addEventListener('click', toggleFullscreen);

  document.addEventListener('keydown', (e) => {
    // Only handle if chart is visible
    const tickerView = document.getElementById('ticker-view');
    if (!tickerView || tickerView.classList.contains('hidden')) return;

    if (e.key === 'Escape' && container.classList.contains('chart-fullscreen')) {
      container.classList.remove('chart-fullscreen');
      updateIcon();
    }

    // Spacebar to toggle fullscreen
    if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault(); // Prevent scrolling
      toggleFullscreen();
    }

    // Arrow keys for navigation
    if (e.key === 'ArrowLeft') {
      navigateChart(-1);
    } else if (e.key === 'ArrowRight') {
      navigateChart(1);
    }
  });
}

async function prefetchNeighborTickers(interval: ChartInterval, signal?: AbortSignal): Promise<void> {
  const nextTicker = getNeighborTicker(1);
  const prevTicker = getNeighborTicker(-1);

  const fetchForTicker = async (ticker: string) => {
    if (signal?.aborted) return;
    const cacheKey = buildChartDataCacheKey(ticker, interval);
    if (getCachedChartData(cacheKey)) return;
    if (chartPrefetchInFlight.has(cacheKey)) return;

    const promise = fetchChartData(ticker, interval, {
      vdRsiLength: volumeDeltaRsiSettings.length,
      vdSourceInterval: volumeDeltaSettings.sourceInterval,
      vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
      signal,
    })
      .then((data) => setCachedChartData(cacheKey, data))
      .catch(() => {})
      .finally(() => chartPrefetchInFlight.delete(cacheKey));

    chartPrefetchInFlight.set(cacheKey, promise);
    return promise;
  };

  if (nextTicker) await fetchForTicker(nextTicker);
  if (prevTicker) await fetchForTicker(prevTicker);
}

window.addEventListener('themechange', () => {
  const c = tc();
  const chartOpts = {
    layout: { background: { color: c.bgColor }, textColor: c.textPrimary },
    rightPriceScale: { borderColor: c.surfaceElevated },
    timeScale: { borderColor: c.surfaceElevated },
    grid: { horzLines: { color: c.monthGridlineColor } },
  };
  if (priceChart) priceChart.applyOptions(chartOpts);
  if (volumeDeltaChart) volumeDeltaChart.applyOptions(chartOpts);
  if (volumeDeltaRsiChart) volumeDeltaRsiChart.applyOptions(chartOpts);
  if (rsiChart) rsiChart.applyTheme();
  // Update VD RSI midline to match new theme text color
  if (volumeDeltaRsiMidlineLine) {
    volumeDeltaRsiSettings.midlineColor = c.textPrimary;
    volumeDeltaRsiMidlineLine.applyOptions({ color: c.textPrimary });
  }
  // Re-render month gridlines and VD zones
  refreshMonthGridLines();
  refreshVDZones();
  // Update existing DOM elements with new theme colors
  reapplyInlineThemeStyles();
  // Re-render divergence summary badges with new theme colors
  if (volumeDeltaPaneContainerEl && Array.isArray(currentBars) && currentBars.length >= 2) {
    renderVolumeDeltaDivergenceSummary(volumeDeltaPaneContainerEl, currentBars);
  }
});

export function refreshActiveTickerDivergenceSummary(options?: { noCache?: boolean }): void {
  if (!volumeDeltaPaneContainerEl) return;
  if (!Array.isArray(currentBars) || currentBars.length < 2) return;
  renderVolumeDeltaDivergenceSummary(volumeDeltaPaneContainerEl, currentBars, options);
}

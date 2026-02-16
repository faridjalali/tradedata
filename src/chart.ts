import { createChart, CrosshairMode } from 'lightweight-charts';
import { fetchChartData, fetchChartLatestData, ChartData, ChartLatestData, ChartInterval, VolumeDeltaSourceInterval } from './chartApi';
import { RSIChart, RSIPersistedTrendline } from './rsi';
import {
  DIVERGENCE_LOOKBACK_DAYS,
  DivergenceSummaryEntry,
  getTickerDivergenceSummary,
} from './divergenceTable';
import { getAppTimeZone, getAppTimeZoneFormatter } from './timezone';
import { escapeHtml } from './utils';

declare const Chart: any;

let currentChartTicker: string | null = null;
let currentChartInterval: ChartInterval = '1day';
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
let volumeDeltaRsiPoints: Array<{ time: string | number, value: number }> = [];
let volumeDeltaIndexByTime = new Map<string, number>();
let volumeDeltaHighlightSeries: any = null;
let volumeDeltaTrendLineSeriesList: any[] = [];
let volumeDeltaTrendlineCrossLabels: Array<{
  element: HTMLDivElement;
  anchorTime: string | number;
  anchorValue: number;
}> = [];
let volumeDeltaTrendlineDefinitions: RSIPersistedTrendline[] = [];
let volumeDeltaDivergencePointTimeKeys = new Set<string>();
let volumeDeltaFirstPoint: { time: string | number, rsi: number, price: number, index: number } | null = null;
let volumeDeltaDivergenceToolActive = false;
let rsiDivergenceToolActive = false;
let volumeDeltaSuppressSync = false;
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
let currentBars: any[] = [];
let monthBoundaryTimes: number[] = [];
let priceMonthGridOverlayEl: HTMLDivElement | null = null;
let volumeDeltaRsiMonthGridOverlayEl: HTMLDivElement | null = null;
let volumeDeltaMonthGridOverlayEl: HTMLDivElement | null = null;
let rsiMonthGridOverlayEl: HTMLDivElement | null = null;
let priceSettingsPanelEl: HTMLDivElement | null = null;
let volumeDeltaSettingsPanelEl: HTMLDivElement | null = null;
let volumeDeltaRsiSettingsPanelEl: HTMLDivElement | null = null;
let rsiSettingsPanelEl: HTMLDivElement | null = null;
let volumeDeltaDivergenceSummaryEl: HTMLDivElement | null = null;
let rsiDivergencePlotToolActive = false;
let volumeDeltaRsiDivergencePlotToolActive = false;
let rsiDivergencePlotSelected = false;
let volumeDeltaRsiDivergencePlotSelected = false;
let rsiDivergencePlotStartIndex: number | null = null;
let volumeDeltaRsiDivergencePlotStartIndex: number | null = null;
let rsiDivergenceOverlayEl: HTMLDivElement | null = null;
let volumeDeltaRsiDivergenceOverlayEl: HTMLDivElement | null = null;
let rsiDivergenceOverlayChart: any = null;
let volumeDeltaRsiDivergenceOverlayChart: any = null;
let hasLoadedSettingsFromStorage = false;
let chartFetchAbortController: AbortController | null = null;
let prefetchAbortController: AbortController | null = null;
let chartActivelyLoading = false;
let intervalSwitchDebounceTimer: number | null = null;
let chartLiveRefreshTimer: number | null = null;
let chartLiveRefreshInFlight = false;
let chartDataCache = new Map<string, { data: ChartData; updatedAt: number }>();
let chartCacheHydratedFromSession = false;
let chartCachePersistTimer: number | null = null;
let chartLayoutRefreshRafId: number | null = null;
let chartPrefetchInFlight = new Map<string, Promise<void>>();
let vdfButtonEl: HTMLButtonElement | null = null;
let vdfLoadingForTicker: string | null = null;
interface VDFZone {
  startDate: string; endDate: string; score: number; windowDays: number;
  absorptionPct?: number; netDeltaPct?: number; accumWeekRatio?: number;
  overallPriceChange?: number; accumWeeks?: number; weeks?: number;
  durationMultiplier?: number;
  concordancePenalty?: number; concordantFrac?: number;
  components?: { s1: number; s2: number; s3: number; s4: number; s5: number; s6: number; s7: number; s8?: number };
}
interface VDFDistribution { startDate: string; endDate: string; spanDays: number; priceChangePct?: number; netDeltaPct?: number; }
interface VDFProximity { compositeScore: number; level: string; signals: Array<{ type: string; points: number; detail: string }>; }
interface VDFCacheEntry {
  is_detected: boolean; composite_score: number; status: string; weeks: number;
  zones: VDFZone[]; distribution: VDFDistribution[]; proximity: VDFProximity;
  details?: { metrics?: { totalDays?: number; scanStart?: string; scanEnd?: string; preDays?: number }; reason?: string };
}
let vdfResultCache = new Map<string, VDFCacheEntry>();
let vdZoneOverlayEl: HTMLDivElement | null = null;
let vdfAnalysisPanelEl: HTMLDivElement | null = null;
const VDF_CACHE_MAX_SIZE = 200;
const TREND_ICON = '✎';
const ERASE_ICON = '⌫';
const DIVERGENCE_ICON = 'D';
const INTERVAL_SWITCH_DEBOUNCE_MS = 120;
const CHART_LIVE_REFRESH_MS = 15 * 60 * 1000;
const CHART_CLIENT_CACHE_TTL_MS = 15 * 60 * 1000;
const CHART_CLIENT_CACHE_MAX_ENTRIES = 16;
const CHART_SESSION_CACHE_KEY = 'custom_chart_session_cache_v1';
const CHART_SESSION_CACHE_MAX_ENTRIES = 6;
const CHART_SESSION_CACHE_MAX_BYTES = 900_000;
const RIGHT_MARGIN_BARS = 10;
const FUTURE_TIMELINE_TRADING_DAYS = 252;
const SCALE_LABEL_CHARS = 4;
const SCALE_MIN_WIDTH_PX = 56;
const INVALID_SYMBOL_MESSAGE = 'Invalid symbol';
const MONTH_GRIDLINE_COLOR = '#21262d';
const SETTINGS_ICON = '⚙';
const SETTINGS_STORAGE_KEY = 'custom_chart_settings_v1';

/** Detect touch-capable device — shared with rsi.ts */
export const isMobileTouch: boolean =
  typeof window !== 'undefined' &&
  (window.matchMedia('(max-width: 768px)').matches ||
   'ontouchstart' in window ||
   navigator.maxTouchPoints > 0);
const TRENDLINES_STORAGE_KEY = 'custom_chart_trendlines_v1';
const TOP_PANE_TICKER_LABEL_CLASS = 'top-pane-ticker-label';
const TOP_PANE_BADGE_CLASS = 'top-pane-badge';
const TOP_PANE_BADGE_START_LEFT_PX = 38;
const TOP_PANE_BADGE_GAP_PX = 6;
const PANE_SETTINGS_BUTTON_LEFT_PX = 8;
const PANE_TOOL_BUTTON_TOP_PX = 8;
const PANE_TOOL_BUTTON_SIZE_PX = 24;
const PANE_TOOL_BUTTON_GAP_PX = 6;
const VOLUME_DELTA_RSI_COLOR = '#2962FF';
const VOLUME_DELTA_MIDLINE = 50;
const RSI_MIDLINE_VALUE = 50;
const VOLUME_DELTA_AXIS_MIN = 20;
const VOLUME_DELTA_AXIS_MAX = 80;
const VOLUME_DELTA_DATA_MIN = 0;
const VOLUME_DELTA_DATA_MAX = 100;
const VOLUME_DELTA_MAX_HIGHLIGHT_POINTS = 2000;
const DIVERGENCE_HIGHLIGHT_COLOR = '#ff6b6b';
const TRENDLINE_COLOR = '#ffa500';
const VOLUME_DELTA_POSITIVE_COLOR = '#089981';
const VOLUME_DELTA_NEGATIVE_COLOR = '#f23645';
const VOLUME_DELTA_SOURCE_OPTIONS: Array<{ value: VolumeDeltaSourceInterval; label: string }> = [
  { value: '1min', label: '1 min' },
  { value: '5min', label: '5 min' },
  { value: '15min', label: '15 min' },
  { value: '30min', label: '30 min' },
  { value: '1hour', label: '1 hour' },
  { value: '4hour', label: '4 hour' }
];
const CHART_PERF_SAMPLE_MAX = 180;
const PREFETCH_INTERVAL_TARGETS: Record<ChartInterval, ChartInterval[]> = {
  '5min': [],
  '15min': [],
  '30min': [],
  '1hour': [],
  '4hour': ['1day'],
  '1day': ['4hour', '1week'],
  '1week': ['1day']
};

type MAType = 'SMA' | 'EMA';
type MASourceMode = 'daily' | 'timeframe';
type MidlineStyle = 'dotted' | 'solid';
type PaneId = 'price-chart-container' | 'vd-rsi-chart-container' | 'rsi-chart-container' | 'vd-chart-container';
type TrendToolPane = 'rsi' | 'volumeDeltaRsi';
type PaneControlType = 'price' | 'volumeDelta' | 'volumeDeltaRsi' | 'rsi';

interface MASetting {
  enabled: boolean;
  type: MAType;
  length: number;
  color: string;
  series: any | null;
  values: Array<number | null>;
}

interface PriceChartSettings {
  maSourceMode: MASourceMode;
  verticalGridlines: boolean;
  horizontalGridlines: boolean;
  ma: MASetting[];
}

interface RSISettings {
  length: number;
  lineColor: string;
  midlineColor: string;
  midlineStyle: MidlineStyle;
}

interface VolumeDeltaRSISettings {
  length: number;
  lineColor: string;
  midlineColor: string;
  midlineStyle: MidlineStyle;
  sourceInterval: VolumeDeltaSourceInterval;
}

interface VolumeDeltaSettings {
  sourceInterval: VolumeDeltaSourceInterval;
  divergenceTable: boolean;
  divergentPriceBars: boolean;
  bullishDivergentColor: string;
  bearishDivergentColor: string;
  neutralDivergentColor: string;
}

interface PersistedMASetting {
  enabled: boolean;
  type: MAType;
  length: number;
  color: string;
}

interface PersistedChartSettings {
  price: {
    maSourceMode: MASourceMode;
    verticalGridlines: boolean;
    horizontalGridlines: boolean;
    ma: PersistedMASetting[];
  };
  volumeDelta?: VolumeDeltaSettings;
  rsi: RSISettings;
  volumeDeltaRsi?: VolumeDeltaRSISettings;
  paneOrder?: PaneId[];
  paneHeights?: Record<string, number>;
}

interface PersistedTrendlineBundle {
  rsi: RSIPersistedTrendline[];
  volumeDeltaRsi: RSIPersistedTrendline[];
}

const DEFAULT_RSI_SETTINGS: RSISettings = {
  length: 14,
  lineColor: '#58a6ff',
  midlineColor: '#ffffff',
  midlineStyle: 'dotted'
};

const DEFAULT_VOLUME_DELTA_RSI_SETTINGS: VolumeDeltaRSISettings = {
  length: 14,
  lineColor: VOLUME_DELTA_RSI_COLOR,
  midlineColor: '#ffffff',
  midlineStyle: 'dotted',
  sourceInterval: '1min'
};

const DEFAULT_VOLUME_DELTA_SETTINGS: VolumeDeltaSettings = {
  sourceInterval: '1min',
  divergenceTable: true,
  divergentPriceBars: true,
  bullishDivergentColor: '#26a69a',
  bearishDivergentColor: '#ef5350',
  neutralDivergentColor: '#8b949e'
};

const DEFAULT_PRICE_SETTINGS: {
  maSourceMode: MASourceMode;
  verticalGridlines: boolean;
  horizontalGridlines: boolean;
  ma: PersistedMASetting[];
} = {
  maSourceMode: 'daily',
  verticalGridlines: false,
  horizontalGridlines: false,
  ma: [
    { enabled: true, type: 'EMA', length: 8, color: '#ffa500' },
    { enabled: true, type: 'EMA', length: 21, color: '#8a2be2' },
    { enabled: true, type: 'SMA', length: 50, color: '#00bcd4' },
    { enabled: false, type: 'SMA', length: 200, color: '#90ee90' }
  ]
};

const DEFAULT_PANE_ORDER: PaneId[] = [
  'vd-chart-container',
  'price-chart-container',
  'rsi-chart-container',
  'vd-rsi-chart-container'
];

let paneOrder: PaneId[] = [...DEFAULT_PANE_ORDER];
let draggedPaneId: PaneId | null = null;

const PANE_HEIGHT_MIN = 120;
const PANE_HEIGHT_MAX = 600;
const DEFAULT_PANE_HEIGHTS: Record<string, number> = {
  'vd-chart-container': 240,
  'price-chart-container': 400,
  'rsi-chart-container': 400,
  'vd-rsi-chart-container': 400,
};
let paneHeights: Record<string, number> = {};
let paneResizeHandlesInstalled = false;
let crosshairHidden = false;

const rsiSettings: RSISettings = {
  ...DEFAULT_RSI_SETTINGS
};

const volumeDeltaRsiSettings: VolumeDeltaRSISettings = {
  ...DEFAULT_VOLUME_DELTA_RSI_SETTINGS
};

const volumeDeltaSettings: VolumeDeltaSettings = {
  ...DEFAULT_VOLUME_DELTA_SETTINGS
};

const priceChartSettings: PriceChartSettings = {
  maSourceMode: DEFAULT_PRICE_SETTINGS.maSourceMode,
  verticalGridlines: DEFAULT_PRICE_SETTINGS.verticalGridlines,
  horizontalGridlines: DEFAULT_PRICE_SETTINGS.horizontalGridlines,
  ma: DEFAULT_PRICE_SETTINGS.ma.map((ma) => ({ ...ma, series: null, values: [] }))
};

function ensureMonthGridOverlay(container: HTMLElement, pane: 'price' | 'volumeDeltaRsi' | 'volumeDelta' | 'rsi'): HTMLDivElement {
  const existing = pane === 'price'
    ? priceMonthGridOverlayEl
    : pane === 'volumeDeltaRsi'
      ? volumeDeltaRsiMonthGridOverlayEl
      : pane === 'volumeDelta'
        ? volumeDeltaMonthGridOverlayEl
      : rsiMonthGridOverlayEl;
  if (existing && existing.parentElement === container) return existing;

  const overlay = document.createElement('div');
  const paneClass = pane === 'price'
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

function unixSecondsFromTimeValue(time: string | number | null | undefined): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) return time;
  if (typeof time === 'string' && time.trim()) {
    const parsed = Date.parse(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function toDateFromScaleTime(time: any): Date | null {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return new Date(time * 1000);
  }
  if (typeof time === 'string' && time.trim()) {
    const parsed = new Date(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (time && typeof time === 'object' && Number.isFinite(time.year) && Number.isFinite(time.month) && Number.isFinite(time.day)) {
    return new Date(Date.UTC(Number(time.year), Number(time.month) - 1, Number(time.day), 0, 0, 0));
  }
  return null;
}

function formatTimeScaleTickMark(time: any, tickMarkType: number): string {
  const date = toDateFromScaleTime(time);
  if (!date) return '';
  const appTimeZone = getAppTimeZone();

  if (tickMarkType === 0) {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      timeZone: appTimeZone
    });
  }
  if (tickMarkType === 1) {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      timeZone: appTimeZone
    });
  }
  return date.toLocaleDateString('en-US', {
    day: 'numeric',
    timeZone: appTimeZone
  });
}

function monthKeyInAppTimeZone(unixSeconds: number): string {
  const parts = getAppTimeZoneFormatter('en-US', {
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date(unixSeconds * 1000));
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  return `${year}-${month}`;
}

function buildMonthBoundaryTimes(bars: any[]): number[] {
  const result: number[] = [];
  let lastMonthKey = '';
  for (const bar of bars) {
    const unixSeconds = unixSecondsFromTimeValue(bar?.time);
    if (unixSeconds === null) continue;
    const monthKey = monthKeyInAppTimeZone(unixSeconds);
    if (monthKey !== lastMonthKey) {
      result.push(unixSeconds);
      lastMonthKey = monthKey;
    }
  }
  return result;
}

function dayKeyInAppTimeZone(unixSeconds: number): string {
  return getAppTimeZoneFormatter('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(unixSeconds * 1000));
}

function buildFutureTimelinePointsFromBars(bars: any[]): Array<{ time: number }> {
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

function applyFutureTimelineSeriesData(bars: any[]): void {
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

function calculateRSIFromCloses(closePrices: number[], period: number): number[] {
  if (!Array.isArray(closePrices) || closePrices.length === 0) return [];
  if (closePrices.length === 1) return [50];

  const safePeriod = Math.max(1, Math.floor(period || 14));
  const rsiValues = new Array(closePrices.length).fill(50);
  const gains: number[] = [];
  const losses: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < closePrices.length; i++) {
    const change = closePrices[i] - closePrices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    gains.push(gain);
    losses.push(loss);

    if (i < safePeriod) {
      const window = i;
      let gainSum = 0;
      let lossSum = 0;
      for (let j = 0; j < window; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / window;
      avgLoss = lossSum / window;
    } else if (i === safePeriod) {
      let gainSum = 0;
      let lossSum = 0;
      for (let j = i - safePeriod; j < i; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / safePeriod;
      avgLoss = lossSum / safePeriod;
    } else {
      avgGain = ((avgGain * (safePeriod - 1)) + gain) / safePeriod;
      avgLoss = ((avgLoss * (safePeriod - 1)) + loss) / safePeriod;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    rsiValues[i] = Number.isFinite(rsi) ? rsi : rsiValues[i - 1];
  }

  rsiValues[0] = rsiValues[1] ?? 50;
  return rsiValues;
}

function buildRSISeriesFromBars(bars: any[], period: number): Array<{ time: string | number, value: number }> {
  if (!bars || bars.length === 0) return [];
  // Don't filter — keep 1:1 index alignment between bars and closes.
  // Non-finite values are handled inside calculateRSIFromCloses.
  const closes = bars.map((bar) => Number(bar.close));
  const rsiValues = calculateRSIFromCloses(closes, period);
  const out: Array<{ time: string | number, value: number }> = [];
  for (let i = 0; i < bars.length; i++) {
    const raw = rsiValues[i];
    if (!Number.isFinite(raw)) continue;
    out.push({ time: bars[i].time, value: Math.round(raw * 100) / 100 });
  }
  return out;
}

function normalizeValueSeries(points: any[]): Array<{ time: string | number, value: number }> {
  if (!Array.isArray(points)) return [];
  return points.filter((point) => (
    point &&
    (typeof point.time === 'string' || typeof point.time === 'number') &&
    Number.isFinite(Number(point.value))
  )).map((point) => ({
    time: point.time,
    value: Number(point.value)
  }));
}

function buildChartDataCacheKey(ticker: string, interval: ChartInterval): string {
  return [
    String(ticker || '').trim().toUpperCase(),
    interval,
    String(volumeDeltaRsiSettings.length),
    volumeDeltaSettings.sourceInterval,
    volumeDeltaRsiSettings.sourceInterval
  ].join('|');
}

function isValidChartDataPayload(data: unknown): data is ChartData {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Partial<ChartData>;
  if (!Array.isArray(candidate.bars) || candidate.bars.length === 0) return false;
  return true;
}

function enforceChartDataCacheMaxEntries(): void {
  while (chartDataCache.size > CHART_CLIENT_CACHE_MAX_ENTRIES) {
    const oldestKey = chartDataCache.keys().next().value;
    if (!oldestKey) break;
    chartDataCache.delete(oldestKey);
  }
}

function hydrateChartDataCacheFromSessionIfNeeded(): void {
  if (chartCacheHydratedFromSession) return;
  chartCacheHydratedFromSession = true;
  if (typeof window === 'undefined') return;

  try {
    const raw = window.sessionStorage.getItem(CHART_SESSION_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      version?: number;
      entries?: Array<{ key: string; updatedAt: number; data: ChartData }>;
    };
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
    const sortedEntries = [...parsed.entries]
      .filter((entry) => entry && typeof entry.key === 'string' && Number.isFinite(entry.updatedAt) && isValidChartDataPayload(entry.data))
      .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
    for (const entry of sortedEntries) {
      chartDataCache.set(entry.key, {
        data: entry.data,
        updatedAt: Number(entry.updatedAt)
      });
    }
    enforceChartDataCacheMaxEntries();
  } catch {
    // Ignore session cache read/parse errors.
  }
}

function schedulePersistChartDataCacheToSession(): void {
  if (typeof window === 'undefined') return;
  if (chartCachePersistTimer !== null) return;
  chartCachePersistTimer = window.setTimeout(() => {
    chartCachePersistTimer = null;
    try {
      const newestFirst = Array.from(chartDataCache.entries()).reverse();
      const persistedEntries: Array<{ key: string; updatedAt: number; data: ChartData }> = [];
      let totalBytes = 0;
      for (const [key, entry] of newestFirst) {
        if (!entry || !entry.data || !Number.isFinite(entry.updatedAt)) continue;
        const candidate = {
          key,
          updatedAt: entry.updatedAt,
          data: entry.data
        };
        const serializedCandidate = JSON.stringify(candidate);
        if (!serializedCandidate) continue;
        if ((totalBytes + serializedCandidate.length) > CHART_SESSION_CACHE_MAX_BYTES) continue;
        persistedEntries.push(candidate);
        totalBytes += serializedCandidate.length;
        if (persistedEntries.length >= CHART_SESSION_CACHE_MAX_ENTRIES) break;
      }
      const payload = JSON.stringify({
        version: 1,
        entries: persistedEntries
      });
      window.sessionStorage.setItem(CHART_SESSION_CACHE_KEY, payload);
    } catch {
      // Ignore session cache persistence errors (quota, serialization, etc).
    }
  }, 180);
}

function sweepChartDataCache(): void {
  hydrateChartDataCacheFromSessionIfNeeded();
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of chartDataCache.entries()) {
    if (!entry || !entry.updatedAt || (now - entry.updatedAt) > CHART_CLIENT_CACHE_TTL_MS) {
      chartDataCache.delete(key);
      changed = true;
    }
  }
  const sizeBefore = chartDataCache.size;
  enforceChartDataCacheMaxEntries();
  if (chartDataCache.size !== sizeBefore) {
    changed = true;
  }
  if (changed) {
    schedulePersistChartDataCacheToSession();
  }
}

function getCachedChartData(cacheKey: string): ChartData | null {
  sweepChartDataCache();
  const cached = chartDataCache.get(cacheKey);
  if (cached) {
    chartDataCache.delete(cacheKey);
    chartDataCache.set(cacheKey, cached);
  }
  return cached ? cached.data : null;
}

function setCachedChartData(cacheKey: string, data: ChartData): void {
  hydrateChartDataCacheFromSessionIfNeeded();
  chartDataCache.delete(cacheKey);
  chartDataCache.set(cacheKey, {
    data,
    updatedAt: Date.now()
  });
  enforceChartDataCacheMaxEntries();
  schedulePersistChartDataCacheToSession();
}

function getLastBarSignature(data: ChartData | null): string {
  const bars = Array.isArray(data?.bars) ? data.bars : [];
  if (!bars.length) return 'none';
  const last = bars[bars.length - 1];
  return [
    bars.length,
    timeKey(last.time),
    Number(last.open),
    Number(last.high),
    Number(last.low),
    Number(last.close),
    Number(last.volume)
  ].join('|');
}

type ChartPerfSummary = {
  fetchCount: number;
  renderCount: number;
  fetchP95Ms: number;
  renderP95Ms: number;
  responseCacheHit: number;
  responseCacheMiss: number;
  responseCacheUnknown: number;
};

const chartPerfSamples: Record<ChartInterval, { fetchMs: number[]; renderMs: number[] }> = {
  '5min': { fetchMs: [], renderMs: [] },
  '15min': { fetchMs: [], renderMs: [] },
  '30min': { fetchMs: [], renderMs: [] },
  '1hour': { fetchMs: [], renderMs: [] },
  '4hour': { fetchMs: [], renderMs: [] },
  '1day': { fetchMs: [], renderMs: [] },
  '1week': { fetchMs: [], renderMs: [] }
};

const chartPerfSummary: Record<ChartInterval, ChartPerfSummary> = {
  '5min': { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
  '15min': { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
  '30min': { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
  '1hour': { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
  '4hour': { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
  '1day': { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
  '1week': { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 }
};

function computeP95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

function pushPerfSample(values: number[], ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  values.push(Math.round(ms * 100) / 100);
  if (values.length > CHART_PERF_SAMPLE_MAX) {
    values.shift();
  }
}

function recordChartFetchPerf(interval: ChartInterval, durationMs: number, cacheHeader: string | null): void {
  const samples = chartPerfSamples[interval];
  const summary = chartPerfSummary[interval];
  pushPerfSample(samples.fetchMs, durationMs);
  summary.fetchCount += 1;
  summary.fetchP95Ms = computeP95(samples.fetchMs);
  if (cacheHeader === 'hit') {
    summary.responseCacheHit += 1;
  } else if (cacheHeader === 'miss') {
    summary.responseCacheMiss += 1;
  } else {
    summary.responseCacheUnknown += 1;
  }
}

function recordChartRenderPerf(interval: ChartInterval, durationMs: number): void {
  const samples = chartPerfSamples[interval];
  const summary = chartPerfSummary[interval];
  pushPerfSample(samples.renderMs, durationMs);
  summary.renderCount += 1;
  summary.renderP95Ms = computeP95(samples.renderMs);
}

function exposeChartPerfMetrics(): void {
  if (typeof window === 'undefined') return;
  (window as any).__chartPerfMetrics = {
    getSnapshot: () => ({
      byInterval: chartPerfSummary,
      sampleMax: CHART_PERF_SAMPLE_MAX
    })
  };
}

async function prefetchRelatedIntervals(ticker: string, interval: ChartInterval): Promise<void> {
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
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
      signal: controller.signal
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

function normalizePaneOrder(order: unknown): PaneId[] {
  if (!Array.isArray(order)) return [...DEFAULT_PANE_ORDER];
  const allowed = new Set<PaneId>(DEFAULT_PANE_ORDER);
  const normalized: PaneId[] = [];

  for (const candidate of order) {
    if (typeof candidate !== 'string') continue;
    if (!allowed.has(candidate as PaneId)) continue;
    const paneId = candidate as PaneId;
    if (!normalized.includes(paneId)) normalized.push(paneId);
  }

  for (const paneId of DEFAULT_PANE_ORDER) {
    if (!normalized.includes(paneId)) normalized.push(paneId);
  }

  return normalized;
}

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

function normalizeVolumeDeltaSeries(points: any[]): Array<{ time: string | number, delta: number }> {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point) => (
      point &&
      (typeof point.time === 'string' || typeof point.time === 'number') &&
      Number.isFinite(Number(point.delta))
    ))
    .map((point) => ({
      time: point.time,
      delta: Number(point.delta)
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
    { divisor: 1, suffix: '' }
  ];
  for (const unit of orderedUnits) {
    const label = tryUnit(unit.divisor, unit.suffix);
    if (label) return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, ' ');
  }

  // Last resort for signed large numbers: promote unit so text stays within the 4-char axis budget.
  const fallbackUnits = [
    { divisor: 1_000, suffix: 'K' },
    { divisor: 1_000_000, suffix: 'M' },
    { divisor: 1_000_000_000, suffix: 'B' }
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

function normalizePersistedTrendlines(lines: unknown): RSIPersistedTrendline[] {
  if (!Array.isArray(lines)) return [];
  const out: RSIPersistedTrendline[] = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const candidate = line as RSIPersistedTrendline;
    const time1 = candidate.time1;
    const time2 = candidate.time2;
    const value1 = Number(candidate.value1);
    const value2 = Number(candidate.value2);
    if ((typeof time1 !== 'string' && typeof time1 !== 'number') || (typeof time2 !== 'string' && typeof time2 !== 'number')) continue;
    if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
    out.push({ time1, value1, time2, value2 });
  }
  return out;
}

function buildTrendlineContextKey(ticker: string, interval: ChartInterval): string {
  return `${ticker.toUpperCase()}|${interval}`;
}

function loadTrendlineStorage(): Record<string, PersistedTrendlineBundle> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(TRENDLINES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<PersistedTrendlineBundle>>;
    const normalized: Record<string, PersistedTrendlineBundle> = {};
    for (const [key, bundle] of Object.entries(parsed || {})) {
      normalized[key] = {
        rsi: normalizePersistedTrendlines(bundle?.rsi),
        volumeDeltaRsi: normalizePersistedTrendlines(bundle?.volumeDeltaRsi)
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

function saveTrendlineStorage(store: Record<string, PersistedTrendlineBundle>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TRENDLINES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage errors (private mode/quota/etc.)
  }
}

function loadPersistedTrendlinesForContext(ticker: string, interval: ChartInterval): PersistedTrendlineBundle {
  const storage = loadTrendlineStorage();
  const bundle = storage[buildTrendlineContextKey(ticker, interval)];
  return {
    rsi: normalizePersistedTrendlines(bundle?.rsi),
    volumeDeltaRsi: normalizePersistedTrendlines(bundle?.volumeDeltaRsi)
  };
}

function persistTrendlinesForCurrentContext(): void {
  if (!currentChartTicker) return;
  const storage = loadTrendlineStorage();
  const key = buildTrendlineContextKey(currentChartTicker, currentChartInterval);
  storage[key] = {
    rsi: rsiChart?.getPersistedTrendlines() ?? [],
    volumeDeltaRsi: volumeDeltaTrendlineDefinitions.map((line) => ({ ...line }))
  };
  saveTrendlineStorage(storage);
}

function persistSettingsToStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedChartSettings = {
      price: {
        maSourceMode: priceChartSettings.maSourceMode,
        verticalGridlines: priceChartSettings.verticalGridlines,
        horizontalGridlines: priceChartSettings.horizontalGridlines,
        ma: priceChartSettings.ma.map((ma) => ({
          enabled: ma.enabled,
          type: ma.type,
          length: ma.length,
          color: ma.color
        }))
      },
      rsi: {
        length: rsiSettings.length,
        lineColor: rsiSettings.lineColor,
        midlineColor: rsiSettings.midlineColor,
        midlineStyle: rsiSettings.midlineStyle
      },
      volumeDelta: {
        sourceInterval: volumeDeltaSettings.sourceInterval,
        divergenceTable: volumeDeltaSettings.divergenceTable,
        divergentPriceBars: volumeDeltaSettings.divergentPriceBars,
        bullishDivergentColor: volumeDeltaSettings.bullishDivergentColor,
        bearishDivergentColor: volumeDeltaSettings.bearishDivergentColor,
        neutralDivergentColor: volumeDeltaSettings.neutralDivergentColor
      },
      volumeDeltaRsi: {
        length: volumeDeltaRsiSettings.length,
        lineColor: volumeDeltaRsiSettings.lineColor,
        midlineColor: volumeDeltaRsiSettings.midlineColor,
        midlineStyle: volumeDeltaRsiSettings.midlineStyle,
        sourceInterval: volumeDeltaRsiSettings.sourceInterval
      },
      paneOrder: [...paneOrder],
      paneHeights: { ...paneHeights }
    };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors (private mode/quota/etc.)
  }
}

function ensureSettingsLoadedFromStorage(): void {
  if (hasLoadedSettingsFromStorage || typeof window === 'undefined') return;
  hasLoadedSettingsFromStorage = true;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<PersistedChartSettings>;

    const persistedPrice = parsed?.price;
    if (persistedPrice) {
      priceChartSettings.maSourceMode = persistedPrice.maSourceMode === 'timeframe' ? 'timeframe' : 'daily';
      if (typeof persistedPrice.verticalGridlines === 'boolean') {
        priceChartSettings.verticalGridlines = persistedPrice.verticalGridlines;
      }
      if (typeof persistedPrice.horizontalGridlines === 'boolean') {
        priceChartSettings.horizontalGridlines = persistedPrice.horizontalGridlines;
      }
      if (Array.isArray(persistedPrice.ma)) {
        for (let i = 0; i < priceChartSettings.ma.length; i++) {
          const persisted = persistedPrice.ma[i];
          if (!persisted) continue;
          priceChartSettings.ma[i].enabled = Boolean(persisted.enabled);
          priceChartSettings.ma[i].type = persisted.type === 'EMA' ? 'EMA' : 'SMA';
          priceChartSettings.ma[i].length = Math.max(1, Math.floor(Number(persisted.length) || priceChartSettings.ma[i].length));
          if (typeof persisted.color === 'string' && persisted.color.trim()) {
            priceChartSettings.ma[i].color = persisted.color;
          }
        }
      }
    }

    const persistedRSI = parsed?.rsi;
    if (persistedRSI) {
      rsiSettings.length = Math.max(1, Math.floor(Number(persistedRSI.length) || rsiSettings.length));
      if (typeof persistedRSI.lineColor === 'string' && persistedRSI.lineColor.trim()) {
        rsiSettings.lineColor = persistedRSI.lineColor;
      }
      if (typeof persistedRSI.midlineColor === 'string' && persistedRSI.midlineColor.trim()) {
        rsiSettings.midlineColor = persistedRSI.midlineColor;
      }
      rsiSettings.midlineStyle = persistedRSI.midlineStyle === 'solid' ? 'solid' : 'dotted';
    }

    const persistedVolumeDelta = parsed?.volumeDelta;
    if (persistedVolumeDelta) {
      const source = String(persistedVolumeDelta.sourceInterval || '');
      if (source === '1min' || source === '5min' || source === '15min' || source === '30min' || source === '1hour' || source === '4hour') {
        volumeDeltaSettings.sourceInterval = source;
      }
      if (typeof persistedVolumeDelta.divergenceTable === 'boolean') {
        volumeDeltaSettings.divergenceTable = persistedVolumeDelta.divergenceTable;
      }
      if (typeof persistedVolumeDelta.divergentPriceBars === 'boolean') {
        volumeDeltaSettings.divergentPriceBars = persistedVolumeDelta.divergentPriceBars;
      }
      if (typeof persistedVolumeDelta.bullishDivergentColor === 'string' && persistedVolumeDelta.bullishDivergentColor.trim()) {
        volumeDeltaSettings.bullishDivergentColor = persistedVolumeDelta.bullishDivergentColor;
      }
      if (typeof persistedVolumeDelta.bearishDivergentColor === 'string' && persistedVolumeDelta.bearishDivergentColor.trim()) {
        volumeDeltaSettings.bearishDivergentColor = persistedVolumeDelta.bearishDivergentColor;
      }
      if (typeof persistedVolumeDelta.neutralDivergentColor === 'string' && persistedVolumeDelta.neutralDivergentColor.trim()) {
        volumeDeltaSettings.neutralDivergentColor = persistedVolumeDelta.neutralDivergentColor;
      }
    }

    const persistedVolumeDeltaRSI = parsed?.volumeDeltaRsi;
    if (persistedVolumeDeltaRSI) {
      volumeDeltaRsiSettings.length = Math.max(1, Math.floor(Number(persistedVolumeDeltaRSI.length) || volumeDeltaRsiSettings.length));
      if (typeof persistedVolumeDeltaRSI.lineColor === 'string' && persistedVolumeDeltaRSI.lineColor.trim()) {
        volumeDeltaRsiSettings.lineColor = persistedVolumeDeltaRSI.lineColor;
      }
      if (typeof persistedVolumeDeltaRSI.midlineColor === 'string' && persistedVolumeDeltaRSI.midlineColor.trim()) {
        volumeDeltaRsiSettings.midlineColor = persistedVolumeDeltaRSI.midlineColor;
      }
      volumeDeltaRsiSettings.midlineStyle = persistedVolumeDeltaRSI.midlineStyle === 'solid' ? 'solid' : 'dotted';
      const source = String(persistedVolumeDeltaRSI.sourceInterval || '');
      if (source === '1min' || source === '5min' || source === '15min' || source === '30min' || source === '1hour' || source === '4hour') {
        volumeDeltaRsiSettings.sourceInterval = source;
      }
    }

    paneOrder = normalizePaneOrder(parsed?.paneOrder);

    if (parsed?.paneHeights && typeof parsed.paneHeights === 'object') {
      for (const [id, h] of Object.entries(parsed.paneHeights)) {
        if (typeof h === 'number' && h >= PANE_HEIGHT_MIN && h <= PANE_HEIGHT_MAX) {
          paneHeights[id] = h;
        }
      }
    }
  } catch {
    // Ignore malformed storage content.
  }
}

function computeSMA(values: number[], length: number): Array<number | null> {
  const period = Math.max(1, Math.floor(length));
  const out: Array<number | null> = new Array(values.length).fill(null);
  // Forward-fill non-finite values so the sliding window stays consistent.
  const filled = values.slice();
  let lastFinite: number | null = null;
  for (let i = 0; i < filled.length; i++) {
    if (Number.isFinite(filled[i])) {
      lastFinite = filled[i];
    } else if (lastFinite !== null) {
      filled[i] = lastFinite;
    }
  }
  let sum = 0;
  for (let i = 0; i < filled.length; i++) {
    const value = filled[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    if (i >= period) {
      sum -= filled[i - period];
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }
  return out;
}

function buildDailyMAValuesForBars(bars: any[], type: MAType, length: number): Array<number | null> {
  const dayOrder: string[] = [];
  const dayCloseByKey = new Map<string, number>();
  const seen = new Set<string>();

  for (const bar of bars) {
    const unixSeconds = unixSecondsFromTimeValue(bar?.time);
    const close = Number(bar?.close);
    if (unixSeconds === null || !Number.isFinite(close)) continue;
    const key = dayKeyInAppTimeZone(unixSeconds);
    if (!seen.has(key)) {
      seen.add(key);
      dayOrder.push(key);
    }
    // Sorted bars => last assignment is the day close.
    dayCloseByKey.set(key, close);
  }

  const dailyCloses = dayOrder.map((day) => Number(dayCloseByKey.get(day)));
  const dailyMA = type === 'EMA'
    ? computeEMA(dailyCloses, length)
    : computeSMA(dailyCloses, length);

  const dailyMAByKey = new Map<string, number | null>();
  for (let i = 0; i < dayOrder.length; i++) {
    dailyMAByKey.set(dayOrder[i], dailyMA[i] ?? null);
  }

  return bars.map((bar) => {
    const unixSeconds = unixSecondsFromTimeValue(bar?.time);
    if (unixSeconds === null) return null;
    return dailyMAByKey.get(dayKeyInAppTimeZone(unixSeconds)) ?? null;
  });
}

function computeEMA(values: number[], length: number): Array<number | null> {
  const period = Math.max(1, Math.floor(length));
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  // Forward-fill non-finite values so the EMA window stays consistent.
  const filled = values.slice();
  let lastFinite: number | null = null;
  for (let i = 0; i < filled.length; i++) {
    if (Number.isFinite(filled[i])) {
      lastFinite = filled[i];
    } else if (lastFinite !== null) {
      filled[i] = lastFinite;
    }
  }
  const alpha = 2 / (period + 1);
  let ema: number | null = null;

  for (let i = 0; i < filled.length; i++) {
    const value = filled[i];
    if (!Number.isFinite(value)) continue;
    if (ema === null) {
      // Seed with SMA of first `period` finite values.
      let sum = 0;
      let count = 0;
      for (let j = i; j < filled.length && count < period; j++) {
        if (Number.isFinite(filled[j])) { sum += filled[j]; count++; }
      }
      ema = count > 0 ? sum / count : value;
    } else {
      ema = (value * alpha) + (ema * (1 - alpha));
    }
    out[i] = ema;
  }
  return out;
}

function isRenderableMaValue(value: unknown): value is number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0;
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
        crosshairMarkerVisible: false
      });
    } else {
      setting.series.applyOptions({ color: setting.color });
    }

    const values = priceChartSettings.maSourceMode === 'daily'
      ? buildDailyMAValuesForBars(currentBars, setting.type, validLength)
      : (
        setting.type === 'EMA'
          ? computeEMA(currentBars.map((bar) => Number(bar.close)), validLength)
          : computeSMA(currentBars.map((bar) => Number(bar.close)), validLength)
      );
    setting.values = values;

    const maData = currentBars.map((bar, index) => {
      const value = values[index];
      if (!isRenderableMaValue(value)) {
        return { time: bar.time };
      }
      return {
        time: bar.time,
        value
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
        nextValue = (lastClose * alpha) + (prevValue * (1 - alpha));
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
    line.style.background = MONTH_GRIDLINE_COLOR;
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
        color: MONTH_GRIDLINE_COLOR
      }
    }
  });
  scheduleChartLayoutRefresh();
}

function syncPriceSettingsPanelValues(): void {
  if (!priceSettingsPanelEl) return;
  const sourceSelect = priceSettingsPanelEl.querySelector('[data-price-setting="ma-source"]') as HTMLSelectElement | null;
  const vGrid = priceSettingsPanelEl.querySelector('[data-price-setting="v-grid"]') as HTMLInputElement | null;
  const hGrid = priceSettingsPanelEl.querySelector('[data-price-setting="h-grid"]') as HTMLInputElement | null;
  if (sourceSelect) sourceSelect.value = priceChartSettings.maSourceMode;
  if (vGrid) vGrid.checked = priceChartSettings.verticalGridlines;
  if (hGrid) hGrid.checked = priceChartSettings.horizontalGridlines;

  for (let i = 0; i < priceChartSettings.ma.length; i++) {
    const ma = priceChartSettings.ma[i];
    const enabled = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-enabled-${i}"]`) as HTMLInputElement | null;
    const type = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-type-${i}"]`) as HTMLSelectElement | null;
    const length = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-length-${i}"]`) as HTMLInputElement | null;
    const color = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-color-${i}"]`) as HTMLInputElement | null;
    if (enabled) enabled.checked = ma.enabled;
    if (type) type.value = ma.type;
    if (length) length.value = String(ma.length);
    if (color) color.value = ma.color;
  }
  // VDF button doesn't need settings sync
}

function syncRSISettingsPanelValues(): void {
  if (!rsiSettingsPanelEl) return;
  const length = rsiSettingsPanelEl.querySelector('[data-rsi-setting="length"]') as HTMLInputElement | null;
  const color = rsiSettingsPanelEl.querySelector('[data-rsi-setting="line-color"]') as HTMLInputElement | null;
  const midlineColor = rsiSettingsPanelEl.querySelector('[data-rsi-setting="midline-color"]') as HTMLInputElement | null;
  const midlineStyle = rsiSettingsPanelEl.querySelector('[data-rsi-setting="midline-style"]') as HTMLSelectElement | null;
  if (length) length.value = String(rsiSettings.length);
  if (color) color.value = rsiSettings.lineColor;
  if (midlineColor) midlineColor.value = rsiSettings.midlineColor;
  if (midlineStyle) midlineStyle.value = rsiSettings.midlineStyle;
}

function syncVolumeDeltaSettingsPanelValues(): void {
  if (!volumeDeltaSettingsPanelEl) return;
  const source = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="source-interval"]') as HTMLSelectElement | null;
  const divergenceTable = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergence-table"]') as HTMLInputElement | null;
  const divergent = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-price-bars"]') as HTMLInputElement | null;
  const bullish = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-bullish-color"]') as HTMLInputElement | null;
  const bearish = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-bearish-color"]') as HTMLInputElement | null;
  const neutral = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-neutral-color"]') as HTMLInputElement | null;
  if (source) source.value = volumeDeltaSettings.sourceInterval;
  if (divergenceTable) divergenceTable.checked = volumeDeltaSettings.divergenceTable;
  if (divergent) divergent.checked = volumeDeltaSettings.divergentPriceBars;
  if (bullish) bullish.value = volumeDeltaSettings.bullishDivergentColor;
  if (bearish) bearish.value = volumeDeltaSettings.bearishDivergentColor;
  if (neutral) neutral.value = volumeDeltaSettings.neutralDivergentColor;
}

function syncVolumeDeltaRSISettingsPanelValues(): void {
  if (!volumeDeltaRsiSettingsPanelEl) return;
  const length = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="length"]') as HTMLInputElement | null;
  const color = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="line-color"]') as HTMLInputElement | null;
  const midlineColor = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="midline-color"]') as HTMLInputElement | null;
  const midlineStyle = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="midline-style"]') as HTMLSelectElement | null;
  const source = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="source-interval"]') as HTMLSelectElement | null;
  if (length) length.value = String(volumeDeltaRsiSettings.length);
  if (color) color.value = volumeDeltaRsiSettings.lineColor;
  if (midlineColor) midlineColor.value = volumeDeltaRsiSettings.midlineColor;
  if (midlineStyle) midlineStyle.value = volumeDeltaRsiSettings.midlineStyle;
  if (source) source.value = volumeDeltaRsiSettings.sourceInterval;
}

function hideSettingsPanels(): void {
  if (priceSettingsPanelEl) priceSettingsPanelEl.style.display = 'none';
  if (volumeDeltaSettingsPanelEl) volumeDeltaSettingsPanelEl.style.display = 'none';
  if (volumeDeltaRsiSettingsPanelEl) volumeDeltaRsiSettingsPanelEl.style.display = 'none';
  if (rsiSettingsPanelEl) rsiSettingsPanelEl.style.display = 'none';
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
  const badges = Array.from(container.querySelectorAll<HTMLElement>(`.${TOP_PANE_BADGE_CLASS}`))
    .filter((badge) => badge.style.display !== 'none');
  if (!badges.length) return;

  const ordered = badges
    .map((badge, index) => ({ badge, index, priority: getTopPaneBadgePriority(badge) }))
    .sort((a, b) => (a.priority - b.priority) || (a.index - b.index))
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

function openTickerOnTradingView(ticker: string): void {
  const symbol = String(ticker || '').trim().toUpperCase();
  if (!symbol) return;
  const url = `https://www.tradingview.com/symbols/${encodeURIComponent(symbol)}/`;
  window.open(url, '_blank', 'noopener,noreferrer');
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

  const ticker = String(currentChartTicker || '').trim().toUpperCase();
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
    label.style.border = '1px solid #30363d';
    label.style.background = '#161b22';
    label.style.color = '#c9d1d9';
    label.style.fontSize = '12px';
    label.style.fontWeight = '600';
    label.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    label.style.whiteSpace = 'nowrap';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.pointerEvents = 'auto';
    label.style.cursor = 'pointer';
    label.title = 'Open on TradingView';
    label.setAttribute('role', 'link');
    label.tabIndex = 0;
    if (!label.dataset.clickBound) {
      label.addEventListener('click', (event) => {
        event.stopPropagation();
        const el = event.currentTarget as HTMLElement;
        openTickerOnTradingView(String(el.dataset.tickerSymbol || ''));
      });
      label.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        const el = event.currentTarget as HTMLElement;
        openTickerOnTradingView(String(el.dataset.tickerSymbol || ''));
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
  paneOrder = normalizePaneOrder(nextOrder);
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
      volumeDeltaContainer as HTMLElement
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
      visible: true
    },
    timeScale: {
      visible: show,
      borderVisible: show,
      ticksVisible: show
    }
  });
}

function applyPaneScaleVisibilityByPosition(): void {
  applyChartScaleVisibility(priceChart, shouldShowPaneScale('price-chart-container'));
  applyChartScaleVisibility(volumeDeltaRsiChart, shouldShowPaneScale('vd-rsi-chart-container'));
  applyChartScaleVisibility(rsiChart?.getChart(), shouldShowPaneScale('rsi-chart-container'));
  applyChartScaleVisibility(volumeDeltaChart, shouldShowPaneScale('vd-chart-container'));
}

function ensurePaneReorderHandle(
  pane: HTMLElement,
  paneId: PaneId,
  chartContent: HTMLElement
): void {
  if (!pane.dataset.paneId) {
    pane.dataset.paneId = paneId;
  }

  let handle = pane.querySelector('.pane-order-handle') as HTMLButtonElement | null;
  if (!handle) {
    handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'pane-order-handle';
    handle.title = 'Drag to reorder panes';
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
      const insertAfter = sourceIndex >= 0 && targetIndex >= 0
        ? sourceIndex < targetIndex
        : true;
      movePaneInOrder(source, paneId, insertAfter);
      applyPaneOrderAndRefreshLayout(chartContent);
      persistSettingsToStorage();
    });
    pane.dataset.dropBound = '1';
  }
}

function ensurePaneReorderUI(chartContent: HTMLElement): void {
  paneOrder = normalizePaneOrder(paneOrder);
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
      .map((point) => [timeKey(point.time), Number(point.value)])
  );
  rsiChart.setData(rsiData, currentBars.map((b) => ({ time: b.time, close: b.close })));
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
      lineWidth: 1
    });
  }
  if (volumeDeltaRsiMidlineLine) {
    volumeDeltaRsiMidlineLine.applyOptions({
      color: volumeDeltaRsiSettings.midlineColor,
      lineStyle: midlineStyleToLineStyle(volumeDeltaRsiSettings.midlineStyle)
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

function resetPriceSettingsToDefault(): void {
  clearMovingAverageSeries();
  priceChartSettings.maSourceMode = DEFAULT_PRICE_SETTINGS.maSourceMode;
  priceChartSettings.verticalGridlines = DEFAULT_PRICE_SETTINGS.verticalGridlines;
  priceChartSettings.horizontalGridlines = DEFAULT_PRICE_SETTINGS.horizontalGridlines;
  for (let i = 0; i < priceChartSettings.ma.length; i++) {
    const defaults = DEFAULT_PRICE_SETTINGS.ma[i];
    if (!defaults) continue;
    priceChartSettings.ma[i].enabled = defaults.enabled;
    priceChartSettings.ma[i].type = defaults.type;
    priceChartSettings.ma[i].length = defaults.length;
    priceChartSettings.ma[i].color = defaults.color;
    priceChartSettings.ma[i].series = null;
    priceChartSettings.ma[i].values = [];
  }
  paneOrder = [...DEFAULT_PANE_ORDER];
  const chartContent = document.getElementById('chart-content');
  if (chartContent && chartContent instanceof HTMLElement) {
    applyPaneOrderAndRefreshLayout(chartContent);
  }
  applyPriceGridOptions();
  applyMovingAverages();
  syncPriceSettingsPanelValues();
  persistSettingsToStorage();
}

function resetRSISettingsToDefault(): void {
  rsiSettings.length = DEFAULT_RSI_SETTINGS.length;
  rsiSettings.lineColor = DEFAULT_RSI_SETTINGS.lineColor;
  rsiSettings.midlineColor = DEFAULT_RSI_SETTINGS.midlineColor;
  rsiSettings.midlineStyle = DEFAULT_RSI_SETTINGS.midlineStyle;
  applyRSISettings();
  syncRSISettingsPanelValues();
  persistSettingsToStorage();
}

function resetVolumeDeltaSettingsToDefault(): void {
  volumeDeltaSettings.sourceInterval = DEFAULT_VOLUME_DELTA_SETTINGS.sourceInterval;
  volumeDeltaSettings.divergenceTable = DEFAULT_VOLUME_DELTA_SETTINGS.divergenceTable;
  volumeDeltaSettings.divergentPriceBars = DEFAULT_VOLUME_DELTA_SETTINGS.divergentPriceBars;
  volumeDeltaSettings.bullishDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.bullishDivergentColor;
  volumeDeltaSettings.bearishDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.bearishDivergentColor;
  volumeDeltaSettings.neutralDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor;
  if (currentChartTicker) {
    renderCustomChart(currentChartTicker, currentChartInterval);
  }
  applyPricePaneDivergentBarColors();
  syncVolumeDeltaSettingsPanelValues();
  persistSettingsToStorage();
}

function resetVolumeDeltaRSISettingsToDefault(): void {
  volumeDeltaRsiSettings.length = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.length;
  volumeDeltaRsiSettings.lineColor = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.lineColor;
  volumeDeltaRsiSettings.midlineColor = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.midlineColor;
  volumeDeltaRsiSettings.midlineStyle = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.midlineStyle;
  volumeDeltaRsiSettings.sourceInterval = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.sourceInterval;
  applyVolumeDeltaRSISettings(true);
  syncVolumeDeltaRSISettingsPanelValues();
  persistSettingsToStorage();
}

function createSettingsButton(container: HTMLElement, pane: PaneControlType): HTMLButtonElement {
  const existing = container.querySelector(`.pane-settings-btn[data-pane="${pane}"]`) as HTMLButtonElement | null;
  if (existing) return existing;
  const btn = document.createElement('button');
  btn.className = 'pane-settings-btn settings-icon-btn';
  btn.dataset.pane = pane;
  btn.type = 'button';
  btn.title = pane === 'price'
    ? 'Price settings'
    : pane === 'volumeDelta'
      ? 'Volume Delta settings'
      : pane === 'volumeDeltaRsi'
        ? 'Volume Delta RSI settings'
        : 'RSI settings';
  btn.textContent = SETTINGS_ICON;
  btn.style.position = 'absolute';
  btn.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX}px`;
  btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
  btn.style.zIndex = '30';
  btn.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.borderRadius = '4px';
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
  badge.className = 'pane-name-badge';
  badge.dataset.pane = pane;
  badge.textContent = getPaneShortLabel(pane);
  badge.style.position = 'absolute';
  badge.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX}px`;
  badge.style.top = `${PANE_TOOL_BUTTON_TOP_PX + PANE_TOOL_BUTTON_SIZE_PX + PANE_TOOL_BUTTON_GAP_PX}px`;
  badge.style.zIndex = '30';
  badge.style.minWidth = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  badge.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  badge.style.padding = '0 8px';
  badge.style.borderRadius = '4px';
  badge.style.border = '1px solid #30363d';
  badge.style.background = '#161b22';
  badge.style.color = '#c9d1d9';
  badge.style.display = 'inline-flex';
  badge.style.alignItems = 'center';
  badge.style.justifyContent = 'center';
  badge.style.fontSize = '12px';
  badge.style.fontWeight = '600';
  badge.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
  badge.style.pointerEvents = 'none';
  badge.style.userSelect = 'none';
  container.appendChild(badge);
  return badge;
}

function createPaneTrendlineButton(
  container: HTMLElement,
  pane: TrendToolPane,
  action: 'trend' | 'erase' | 'divergence',
  orderFromSettings: number
): HTMLButtonElement {
  const existing = container.querySelector(`.pane-trendline-btn[data-pane="${pane}"][data-action="${action}"]`) as HTMLButtonElement | null;
  if (existing) return existing;

  const btn = document.createElement('button');
  btn.className = 'pane-trendline-btn';
  btn.dataset.pane = pane;
  btn.dataset.action = action;
  btn.type = 'button';
  btn.title = action === 'trend'
    ? 'Draw Trendline'
    : action === 'erase'
      ? 'Erase Trendline'
      : 'Divergence';
  btn.textContent = action === 'trend'
    ? TREND_ICON
    : action === 'erase'
      ? ERASE_ICON
      : DIVERGENCE_ICON;
  btn.style.position = 'absolute';
  btn.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX + ((orderFromSettings + 1) * (PANE_TOOL_BUTTON_SIZE_PX + PANE_TOOL_BUTTON_GAP_PX))}px`;
  btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
  btn.style.zIndex = '30';
  btn.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.borderRadius = '4px';
  btn.style.border = '1px solid #30363d';
  btn.style.background = '#161b22';
  btn.style.color = '#c9d1d9';
  btn.style.cursor = 'pointer';
  btn.style.padding = '0';
  container.appendChild(btn);
  return btn;
}

function getPaneToolButton(pane: TrendToolPane, action: 'trend' | 'divergence'): HTMLButtonElement | null {
  return document.querySelector(`.pane-trendline-btn[data-pane="${pane}"][data-action="${action}"]`) as HTMLButtonElement | null;
}

function setPaneToolButtonActive(pane: TrendToolPane, action: 'trend' | 'divergence', active: boolean): void {
  const btn = getPaneToolButton(pane, action);
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.style.background = active ? '#1f6feb' : '#161b22';
  btn.style.color = '#ffffff';
  btn.textContent = action === 'trend' ? TREND_ICON : DIVERGENCE_ICON;
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
  if (rsiDivergencePlotToolActive) {
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
  if (volumeDeltaDivergenceToolActive) {
    deactivateVolumeDeltaDivergenceTool();
    setPaneTrendlineToolActive('volumeDeltaRsi', false);
    return;
  }
  if (volumeDeltaRsiDivergencePlotToolActive) {
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

function formatDivergenceOverlayTimeLabel(time: string | number): string {
  const unix = unixSecondsFromTimeValue(time);
  if (unix === null) return '';
  const date = new Date(unix * 1000);
  if (currentChartInterval === '1day' || currentChartInterval === '1week') {
    return getAppTimeZoneFormatter('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: '2-digit'
    }).format(date);
  }
  return date.toLocaleString('en-US', {
    timeZone: getAppTimeZone(),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function ensureDivergenceOverlay(container: HTMLElement, pane: TrendToolPane): HTMLDivElement {
  const existing = pane === 'rsi' ? rsiDivergenceOverlayEl : volumeDeltaRsiDivergenceOverlayEl;
  if (existing && existing.parentElement === container) {
    existing.style.top = '0';
    existing.style.right = '0';
    existing.style.maxWidth = '100%';
    return existing;
  }

  const overlay = document.createElement('div');
  overlay.className = `divergence-plot-overlay divergence-plot-overlay-${pane}`;
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.width = '468px';
  overlay.style.maxWidth = '100%';
  overlay.style.height = '286px';
  overlay.style.border = '1px solid #30363d';
  overlay.style.borderRadius = '6px';
  overlay.style.background = 'rgba(13, 17, 23, 0.95)';
  overlay.style.backdropFilter = 'blur(4px)';
  overlay.style.zIndex = '35';
  overlay.style.pointerEvents = 'none';
  overlay.style.display = 'none';
  overlay.style.padding = '8px';
  overlay.style.boxSizing = 'border-box';

  const canvasWrap = document.createElement('div');
  canvasWrap.style.position = 'relative';
  canvasWrap.style.width = '100%';
  canvasWrap.style.height = '100%';
  const canvas = document.createElement('canvas');
  canvas.className = 'divergence-plot-overlay-canvas';
  canvasWrap.appendChild(canvas);
  overlay.appendChild(canvasWrap);
  container.appendChild(overlay);

  if (pane === 'rsi') {
    rsiDivergenceOverlayEl = overlay;
  } else {
    volumeDeltaRsiDivergenceOverlayEl = overlay;
  }
  return overlay;
}

function getDivergenceOverlayChart(pane: TrendToolPane): any {
  return pane === 'rsi' ? rsiDivergenceOverlayChart : volumeDeltaRsiDivergenceOverlayChart;
}

function setDivergenceOverlayChart(pane: TrendToolPane, chart: any | null): void {
  if (pane === 'rsi') {
    rsiDivergenceOverlayChart = chart;
  } else {
    volumeDeltaRsiDivergenceOverlayChart = chart;
  }
}

function hideDivergenceOverlay(pane: TrendToolPane): void {
  const overlay = pane === 'rsi' ? rsiDivergenceOverlayEl : volumeDeltaRsiDivergenceOverlayEl;
  if (overlay) overlay.style.display = 'none';
  const chart = getDivergenceOverlayChart(pane);
  if (chart) {
    try {
      chart.destroy();
    } catch {
      // Ignore stale chart teardown errors.
    }
    setDivergenceOverlayChart(pane, null);
  }
}

function findNearestBarIndex(time: string | number): number | null {
  if (!Array.isArray(currentBars) || currentBars.length === 0) return null;
  const direct = barIndexByTime.get(timeKey(time));
  if (direct !== undefined) return direct;
  const targetUnix = unixSecondsFromTimeValue(time);
  if (targetUnix === null) return null;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < currentBars.length; i++) {
    const unix = unixSecondsFromTimeValue(currentBars[i]?.time);
    if (unix === null) continue;
    const distance = Math.abs(unix - targetUnix);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return Number.isFinite(bestDistance) ? bestIndex : null;
}

function buildDivergenceOverlayData(startIndex: number): { labels: string[]; rsiValues: number[]; volumeDeltaRsiValues: number[] } {
  const labels: string[] = [];
  const rsiValues: number[] = [];
  const volumeDeltaRsiValues: number[] = [];
  for (let i = startIndex; i < currentBars.length; i++) {
    const bar = currentBars[i];
    const key = timeKey(bar.time);
    const rsiValue = Number(rsiByTime.get(key));
    const vdRsiValue = Number(volumeDeltaRsiByTime.get(key));
    if (!Number.isFinite(rsiValue) || !Number.isFinite(vdRsiValue)) continue;
    labels.push(formatDivergenceOverlayTimeLabel(bar.time));
    rsiValues.push(rsiValue);
    volumeDeltaRsiValues.push(vdRsiValue);
  }
  return { labels, rsiValues, volumeDeltaRsiValues };
}

function renderDivergenceOverlayForPane(pane: TrendToolPane, startIndex: number): void {
  const container = pane === 'rsi'
    ? document.getElementById('rsi-chart-container')
    : document.getElementById('vd-rsi-chart-container');
  if (!container || !(container instanceof HTMLElement)) return;
  const overlay = ensureDivergenceOverlay(container, pane);
  const canvas = overlay.querySelector('.divergence-plot-overlay-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  if (!currentBars.length || startIndex < 0 || startIndex >= currentBars.length) {
    hideDivergenceOverlay(pane);
    return;
  }

  const data = buildDivergenceOverlayData(startIndex);
  if (data.rsiValues.length < 2) {
    hideDivergenceOverlay(pane);
    return;
  }

  overlay.style.display = 'block';
  const existingChart = getDivergenceOverlayChart(pane);
  if (existingChart) {
    existingChart.data.labels = data.labels;
    existingChart.data.datasets[0].data = data.rsiValues;
    existingChart.data.datasets[0].borderColor = rsiSettings.lineColor;
    existingChart.data.datasets[1].data = data.volumeDeltaRsiValues;
    existingChart.data.datasets[1].borderColor = volumeDeltaRsiSettings.lineColor;
    existingChart.update('none');
    return;
  }

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: 'RSI',
          data: data.rsiValues,
          borderColor: rsiSettings.lineColor,
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: data.rsiValues.length > 24 ? 0 : 2,
          tension: 0.2
        },
        {
          label: 'VD RSI',
          data: data.volumeDeltaRsiValues,
          borderColor: volumeDeltaRsiSettings.lineColor,
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: data.volumeDeltaRsiValues.length > 24 ? 0 : 2,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(22, 27, 34, 0.95)',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#c9d1d9',
          bodyColor: '#8b949e'
        }
      },
      scales: {
        x: {
          display: false,
          ticks: {
            color: '#8b949e',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            font: { size: 10 }
          },
          grid: { color: 'rgba(48, 54, 61, 0.22)' }
        },
        y: {
          display: false,
          min: 0,
          max: 100,
          ticks: {
            color: '#8b949e',
            font: { size: 10 }
          },
          grid: { color: 'rgba(48, 54, 61, 0.22)' }
        }
      }
    }
  });
  setDivergenceOverlayChart(pane, chart);
}

function deactivateRsiDivergencePlotTool(): void {
  rsiDivergencePlotToolActive = false;
  rsiDivergencePlotSelected = false;
  rsiDivergencePlotStartIndex = null;
  setPaneToolButtonActive('rsi', 'divergence', false);
  hideDivergenceOverlay('rsi');
}

function deactivateVolumeDeltaRsiDivergencePlotTool(): void {
  volumeDeltaRsiDivergencePlotToolActive = false;
  volumeDeltaRsiDivergencePlotSelected = false;
  volumeDeltaRsiDivergencePlotStartIndex = null;
  setPaneToolButtonActive('volumeDeltaRsi', 'divergence', false);
  hideDivergenceOverlay('volumeDeltaRsi');
}

function updateRsiDivergencePlotPoint(time: string | number, fromMove: boolean): void {
  if (!rsiDivergencePlotToolActive) return;
  if (fromMove && !rsiDivergencePlotSelected) return;
  const index = findNearestBarIndex(time);
  if (index === null) return;
  rsiDivergencePlotSelected = true;
  rsiDivergencePlotStartIndex = index;
  renderDivergenceOverlayForPane('rsi', index);
}

function updateVolumeDeltaRsiDivergencePlotPoint(time: string | number, fromMove: boolean): void {
  if (!volumeDeltaRsiDivergencePlotToolActive) return;
  if (fromMove && !volumeDeltaRsiDivergencePlotSelected) return;
  const index = findNearestBarIndex(time);
  if (index === null) return;
  volumeDeltaRsiDivergencePlotSelected = true;
  volumeDeltaRsiDivergencePlotStartIndex = index;
  renderDivergenceOverlayForPane('volumeDeltaRsi', index);
}

function toggleRsiDivergencePlotTool(): void {
  if (rsiDivergencePlotToolActive) {
    deactivateRsiDivergencePlotTool();
    return;
  }
  if (rsiDivergenceToolActive) {
    rsiChart?.deactivateDivergenceTool();
    rsiDivergenceToolActive = false;
    setPaneTrendlineToolActive('rsi', false);
  }
  rsiDivergencePlotToolActive = true;
  rsiDivergencePlotSelected = false;
  rsiDivergencePlotStartIndex = null;
  setPaneToolButtonActive('rsi', 'divergence', true);
}

function toggleVolumeDeltaRsiDivergencePlotTool(): void {
  if (volumeDeltaRsiDivergencePlotToolActive) {
    deactivateVolumeDeltaRsiDivergencePlotTool();
    return;
  }
  if (volumeDeltaDivergenceToolActive) {
    deactivateVolumeDeltaDivergenceTool();
    setPaneTrendlineToolActive('volumeDeltaRsi', false);
  }
  volumeDeltaRsiDivergencePlotToolActive = true;
  volumeDeltaRsiDivergencePlotSelected = false;
  volumeDeltaRsiDivergencePlotStartIndex = null;
  setPaneToolButtonActive('volumeDeltaRsi', 'divergence', true);
}

function refreshActiveDivergenceOverlays(): void {
  if (rsiDivergencePlotToolActive && rsiDivergencePlotSelected && rsiDivergencePlotStartIndex !== null) {
    renderDivergenceOverlayForPane('rsi', rsiDivergencePlotStartIndex);
  }
  if (volumeDeltaRsiDivergencePlotToolActive && volumeDeltaRsiDivergencePlotSelected && volumeDeltaRsiDivergencePlotStartIndex !== null) {
    renderDivergenceOverlayForPane('volumeDeltaRsi', volumeDeltaRsiDivergencePlotStartIndex);
  }
}

function deactivateInteractivePaneToolsFromEscape(): void {
  if (rsiDivergenceToolActive) {
    rsiChart?.deactivateDivergenceTool();
    rsiDivergenceToolActive = false;
    setPaneTrendlineToolActive('rsi', false);
  }
  if (volumeDeltaDivergenceToolActive) {
    deactivateVolumeDeltaDivergenceTool();
    setPaneTrendlineToolActive('volumeDeltaRsi', false);
  }
  if (rsiDivergencePlotToolActive) {
    deactivateRsiDivergencePlotTool();
  }
  if (volumeDeltaRsiDivergencePlotToolActive) {
    deactivateVolumeDeltaRsiDivergencePlotTool();
  }
}

function applyUniformSettingsPanelTypography(panel: HTMLDivElement): void {
  panel.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  panel.style.fontSize = '12px';
  panel.style.fontWeight = '500';
  panel.style.lineHeight = '1.2';
  panel.querySelectorAll<HTMLElement>('div, span, label, input, select, button').forEach((el) => {
    el.style.fontFamily = 'inherit';
    el.style.fontSize = 'inherit';
    el.style.fontWeight = 'inherit';
    el.style.fontStyle = 'normal';
    el.style.letterSpacing = 'normal';
  });
  panel.querySelectorAll<HTMLElement>('label').forEach((label) => {
    label.style.display = 'flex';
    label.style.justifyContent = 'space-between';
    label.style.alignItems = 'center';
    label.style.gap = '8px';
    label.style.minHeight = '26px';
  });
  panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.style.width = '14px';
    checkbox.style.height = '14px';
    checkbox.style.margin = '0';
  });
  panel.querySelectorAll<HTMLElement>('input, select, button').forEach((control) => {
    control.style.boxSizing = 'border-box';
    control.style.lineHeight = '1.2';
  });
}


function createPriceSettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel price-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '280px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = 'rgba(22, 27, 34, 0.95)';
  panel.style.border = '1px solid #30363d';
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = '#c9d1d9';
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Chart</div>
      <button type="button" data-price-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Vertical gridlines</span>
      <input type="checkbox" data-price-setting="v-grid" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Horizontal gridlines</span>
      <input type="checkbox" data-price-setting="h-grid" />
    </label>
    <label style="margin-bottom:4px;">
      <span>MA source</span>
      <select data-price-setting="ma-source" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        <option value="daily">Daily</option>
        <option value="timeframe">Chart</option>
      </select>
    </label>
    ${priceChartSettings.ma.map((_, i) => `
      <div style="display:grid; grid-template-columns: 20px 64px 58px 1fr; gap:6px; align-items:center; min-height:26px; margin-bottom:6px;">
        <input type="checkbox" data-price-setting="ma-enabled-${i}" title="Enable MA ${i + 1}" />
        <select data-price-setting="ma-type-${i}" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
          <option value="SMA">SMA</option>
          <option value="EMA">EMA</option>
        </select>
        <input data-price-setting="ma-length-${i}" type="number" min="1" max="500" step="1" style="width:58px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;" />
        <input data-price-setting="ma-color-${i}" type="color" style="width:100%; height:24px; border:none; background:transparent; padding:0;" />
      </div>
    `).join('')}
  `;
  applyUniformSettingsPanelTypography(panel);

  panel.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    if (!target) return;

    const setting = (target as HTMLInputElement | HTMLSelectElement).dataset.priceSetting || '';
    if (setting === 'ma-source') {
      priceChartSettings.maSourceMode = ((target as HTMLSelectElement).value === 'timeframe') ? 'timeframe' : 'daily';
      applyMovingAverages();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'v-grid') {
      priceChartSettings.verticalGridlines = (target as HTMLInputElement).checked;
      scheduleChartLayoutRefresh();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'h-grid') {
      priceChartSettings.horizontalGridlines = (target as HTMLInputElement).checked;
      applyPriceGridOptions();
      persistSettingsToStorage();
      return;
    }

    const maMatch = setting.match(/^ma-(enabled|type|length|color)-(\d)$/);
    if (!maMatch) return;
    const key = maMatch[1];
    const index = Number(maMatch[2]);
    const ma = priceChartSettings.ma[index];
    if (!ma) return;

    if (key === 'enabled') {
      ma.enabled = (target as HTMLInputElement).checked;
    } else if (key === 'type') {
      ma.type = ((target as HTMLSelectElement).value === 'EMA') ? 'EMA' : 'SMA';
    } else if (key === 'length') {
      ma.length = Math.max(1, Math.floor(Number((target as HTMLInputElement).value) || 14));
    } else if (key === 'color') {
      ma.color = (target as HTMLInputElement).value || ma.color;
    }
    applyMovingAverages();
    persistSettingsToStorage();
  });

  panel.addEventListener('click', (event) => {
    const target = event.target as HTMLButtonElement | null;
    if (!target) return;
    if (target.dataset.priceSetting !== 'reset') return;
    event.preventDefault();
    resetPriceSettingsToDefault();
  });

  container.appendChild(panel);
  return panel;
}

function createRSISettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel rsi-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '230px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = 'rgba(22, 27, 34, 0.95)';
  panel.style.border = '1px solid #30363d';
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = '#c9d1d9';
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">RSI</div>
      <button type="button" data-rsi-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Length</span>
      <input data-rsi-setting="length" type="number" min="1" max="200" step="1" style="width:64px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Line color</span>
      <input data-rsi-setting="line-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline color</span>
      <input data-rsi-setting="midline-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline style</span>
      <select data-rsi-setting="midline-style" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        <option value="dotted">Dotted</option>
        <option value="solid">Solid</option>
      </select>
    </label>
  `;
  applyUniformSettingsPanelTypography(panel);

  panel.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    const setting = target.dataset.rsiSetting || '';
    if (setting === 'length') {
      rsiSettings.length = Math.max(1, Math.floor(Number(target.value) || 14));
      applyRSISettings();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'line-color') {
      rsiSettings.lineColor = target.value || rsiSettings.lineColor;
      rsiChart?.setLineColor(rsiSettings.lineColor);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-color') {
      rsiSettings.midlineColor = target.value || rsiSettings.midlineColor;
      rsiChart?.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-style') {
      rsiSettings.midlineStyle = (target.value === 'solid') ? 'solid' : 'dotted';
      rsiChart?.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
      persistSettingsToStorage();
      return;
    }
  });

  panel.addEventListener('click', (event) => {
    const target = event.target as HTMLButtonElement | null;
    if (!target) return;
    if (target.dataset.rsiSetting !== 'reset') return;
    event.preventDefault();
    resetRSISettingsToDefault();
  });

  container.appendChild(panel);
  return panel;
}

function createVolumeDeltaSettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel volume-delta-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '230px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = 'rgba(22, 27, 34, 0.95)';
  panel.style.border = '1px solid #30363d';
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = '#c9d1d9';
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Volume Delta</div>
      <button type="button" data-vd-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Source</span>
      <select data-vd-setting="source-interval" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        ${VOLUME_DELTA_SOURCE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
      </select>
    </label>
    <label style="margin-bottom:6px;">
      <span>Divergence table</span>
      <input type="checkbox" data-vd-setting="divergence-table" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Divergent price bars</span>
      <input type="checkbox" data-vd-setting="divergent-price-bars" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Bullish</span>
      <input type="color" data-vd-setting="divergent-bullish-color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Bearish</span>
      <input type="color" data-vd-setting="divergent-bearish-color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Neutral</span>
      <input type="color" data-vd-setting="divergent-neutral-color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
  `;
  applyUniformSettingsPanelTypography(panel);

  panel.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    const setting = target.dataset.vdSetting || '';
    if (setting === 'source-interval') {
      const nextValue = String((target as HTMLSelectElement).value || '');
      if (nextValue !== '1min' && nextValue !== '5min' && nextValue !== '15min' && nextValue !== '30min' && nextValue !== '1hour' && nextValue !== '4hour') return;
      volumeDeltaSettings.sourceInterval = nextValue;
      if (currentChartTicker) {
        renderCustomChart(currentChartTicker, currentChartInterval);
      }
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergence-table') {
      volumeDeltaSettings.divergenceTable = (target as HTMLInputElement).checked;
      if (volumeDeltaPaneContainerEl) {
        renderVolumeDeltaDivergenceSummary(volumeDeltaPaneContainerEl, currentBars);
      }
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-price-bars') {
      volumeDeltaSettings.divergentPriceBars = (target as HTMLInputElement).checked;
      applyPricePaneDivergentBarColors();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-bullish-color') {
      volumeDeltaSettings.bullishDivergentColor = (target as HTMLInputElement).value || volumeDeltaSettings.bullishDivergentColor;
      applyPricePaneDivergentBarColors();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-bearish-color') {
      volumeDeltaSettings.bearishDivergentColor = (target as HTMLInputElement).value || volumeDeltaSettings.bearishDivergentColor;
      applyPricePaneDivergentBarColors();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-neutral-color') {
      volumeDeltaSettings.neutralDivergentColor = (target as HTMLInputElement).value || volumeDeltaSettings.neutralDivergentColor;
      applyPricePaneDivergentBarColors();
      persistSettingsToStorage();
      return;
    }
  });

  panel.addEventListener('click', (event) => {
    const target = event.target as HTMLButtonElement | null;
    if (!target) return;
    if (target.dataset.vdSetting !== 'reset') return;
    event.preventDefault();
    resetVolumeDeltaSettingsToDefault();
  });

  container.appendChild(panel);
  return panel;
}

function createVolumeDeltaRSISettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel volume-delta-rsi-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '230px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = 'rgba(22, 27, 34, 0.95)';
  panel.style.border = '1px solid #30363d';
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = '#c9d1d9';
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Volume Delta RSI</div>
      <button type="button" data-vd-rsi-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Length</span>
      <input data-vd-rsi-setting="length" type="number" min="1" max="200" step="1" style="width:64px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Source</span>
      <select data-vd-rsi-setting="source-interval" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        ${VOLUME_DELTA_SOURCE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
      </select>
    </label>
    <label style="margin-bottom:6px;">
      <span>Line color</span>
      <input data-vd-rsi-setting="line-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline color</span>
      <input data-vd-rsi-setting="midline-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline style</span>
      <select data-vd-rsi-setting="midline-style" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        <option value="dotted">Dotted</option>
        <option value="solid">Solid</option>
      </select>
    </label>
  `;
  applyUniformSettingsPanelTypography(panel);

  panel.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    const setting = target.dataset.vdRsiSetting || '';
    if (setting === 'length') {
      volumeDeltaRsiSettings.length = Math.max(1, Math.floor(Number(target.value) || 14));
      applyVolumeDeltaRSISettings(true);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'source-interval') {
      const nextValue = String((target as HTMLSelectElement).value || '');
      if (nextValue !== '1min' && nextValue !== '5min' && nextValue !== '15min' && nextValue !== '30min' && nextValue !== '1hour' && nextValue !== '4hour') return;
      volumeDeltaRsiSettings.sourceInterval = nextValue;
      applyVolumeDeltaRSISettings(true);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'line-color') {
      volumeDeltaRsiSettings.lineColor = target.value || volumeDeltaRsiSettings.lineColor;
      applyVolumeDeltaRSISettings(false);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-color') {
      volumeDeltaRsiSettings.midlineColor = target.value || volumeDeltaRsiSettings.midlineColor;
      applyVolumeDeltaRSISettings(false);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-style') {
      volumeDeltaRsiSettings.midlineStyle = target.value === 'solid' ? 'solid' : 'dotted';
      applyVolumeDeltaRSISettings(false);
      persistSettingsToStorage();
      return;
    }
  });

  panel.addEventListener('click', (event) => {
    const target = event.target as HTMLButtonElement | null;
    if (!target) return;
    if (target.dataset.vdRsiSetting !== 'reset') return;
    event.preventDefault();
    resetVolumeDeltaRSISettingsToDefault();
  });

  container.appendChild(panel);
  return panel;
}

function ensureSettingsUI(
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement
): void {
  const priceBtn = createSettingsButton(chartContainer, 'price');
  const vdfBtn = ensureVDFButton(chartContainer);
  const volumeDeltaRsiBtn = createSettingsButton(volumeDeltaRsiContainer, 'volumeDeltaRsi');
  const rsiBtn = createSettingsButton(rsiContainer, 'rsi');
  const volumeDeltaBtn = createSettingsButton(volumeDeltaContainer, 'volumeDelta');
  createPaneNameBadge(chartContainer, 'price');
  createPaneNameBadge(volumeDeltaRsiContainer, 'volumeDeltaRsi');
  createPaneNameBadge(rsiContainer, 'rsi');
  createPaneNameBadge(volumeDeltaContainer, 'volumeDelta');
  const volumeDeltaRsiTrendBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, 'volumeDeltaRsi', 'trend', 0);
  const volumeDeltaRsiEraseBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, 'volumeDeltaRsi', 'erase', 1);
  const volumeDeltaRsiDivergenceBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, 'volumeDeltaRsi', 'divergence', 2);
  const rsiTrendBtn = createPaneTrendlineButton(rsiContainer, 'rsi', 'trend', 0);
  const rsiEraseBtn = createPaneTrendlineButton(rsiContainer, 'rsi', 'erase', 1);
  const rsiDivergenceBtn = createPaneTrendlineButton(rsiContainer, 'rsi', 'divergence', 2);

  if (!priceSettingsPanelEl || priceSettingsPanelEl.parentElement !== chartContainer) {
    if (priceSettingsPanelEl?.parentElement) {
      priceSettingsPanelEl.parentElement.removeChild(priceSettingsPanelEl);
    }
    priceSettingsPanelEl = createPriceSettingsPanel(chartContainer);
  }
  if (!rsiSettingsPanelEl || rsiSettingsPanelEl.parentElement !== rsiContainer) {
    if (rsiSettingsPanelEl?.parentElement) {
      rsiSettingsPanelEl.parentElement.removeChild(rsiSettingsPanelEl);
    }
    rsiSettingsPanelEl = createRSISettingsPanel(rsiContainer);
  }
  if (!volumeDeltaRsiSettingsPanelEl || volumeDeltaRsiSettingsPanelEl.parentElement !== volumeDeltaRsiContainer) {
    if (volumeDeltaRsiSettingsPanelEl?.parentElement) {
      volumeDeltaRsiSettingsPanelEl.parentElement.removeChild(volumeDeltaRsiSettingsPanelEl);
    }
    volumeDeltaRsiSettingsPanelEl = createVolumeDeltaRSISettingsPanel(volumeDeltaRsiContainer);
  }
  if (!volumeDeltaSettingsPanelEl || volumeDeltaSettingsPanelEl.parentElement !== volumeDeltaContainer) {
    if (volumeDeltaSettingsPanelEl?.parentElement) {
      volumeDeltaSettingsPanelEl.parentElement.removeChild(volumeDeltaSettingsPanelEl);
    }
    volumeDeltaSettingsPanelEl = createVolumeDeltaSettingsPanel(volumeDeltaContainer);
  }

  syncPriceSettingsPanelValues();
  syncVolumeDeltaSettingsPanelValues();
  syncVolumeDeltaRSISettingsPanelValues();
  syncRSISettingsPanelValues();

  if (!priceBtn.dataset.bound) {
    priceBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = priceSettingsPanelEl?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (priceSettingsPanelEl) priceSettingsPanelEl.style.display = nextDisplay;
    });
    priceBtn.dataset.bound = '1';
  }
  if (!volumeDeltaRsiBtn.dataset.bound) {
    volumeDeltaRsiBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = volumeDeltaRsiSettingsPanelEl?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (volumeDeltaRsiSettingsPanelEl) volumeDeltaRsiSettingsPanelEl.style.display = nextDisplay;
    });
    volumeDeltaRsiBtn.dataset.bound = '1';
  }
  if (!volumeDeltaBtn.dataset.bound) {
    volumeDeltaBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = volumeDeltaSettingsPanelEl?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (volumeDeltaSettingsPanelEl) volumeDeltaSettingsPanelEl.style.display = nextDisplay;
    });
    volumeDeltaBtn.dataset.bound = '1';
  }
  if (!rsiBtn.dataset.bound) {
    rsiBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const nextDisplay = rsiSettingsPanelEl?.style.display === 'block' ? 'none' : 'block';
      hideSettingsPanels();
      if (rsiSettingsPanelEl) rsiSettingsPanelEl.style.display = nextDisplay;
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

  if (!vdfBtn.dataset.bound) {
    vdfBtn.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (currentChartTicker) runVDFDetection(currentChartTicker, true);
    });
    vdfBtn.dataset.bound = '1';
  }

  setPaneTrendlineToolActive('rsi', rsiDivergenceToolActive);
  setPaneTrendlineToolActive('volumeDeltaRsi', volumeDeltaDivergenceToolActive);
  setPaneToolButtonActive('rsi', 'divergence', rsiDivergencePlotToolActive);
  setPaneToolButtonActive('volumeDeltaRsi', 'divergence', volumeDeltaRsiDivergencePlotToolActive);

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
  changeEl.style.border = '1px solid #30363d';
  changeEl.style.background = '#161b22';
  changeEl.style.color = '#c9d1d9';
  changeEl.style.fontSize = '12px';
  changeEl.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
  changeEl.style.pointerEvents = 'none';
  changeEl.style.display = 'none';
  container.appendChild(changeEl);
  return changeEl;
}

function rebuildPricePaneChangeMap(bars: any[]): void {
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
  changeEl.style.color = deltaValue > 0 ? '#26a69a' : deltaValue < 0 ? '#ef5350' : '#c9d1d9';
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
  messageEl.style.color = '#8b949e';
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
  const message = String((err as any)?.message || err || '');
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

function timeKey(time: string | number): string {
  return typeof time === 'number' ? String(time) : time;
}

function fixedVolumeDeltaAutoscaleInfoProvider(): any {
  return {
    priceRange: {
      minValue: VOLUME_DELTA_AXIS_MIN,
      maxValue: VOLUME_DELTA_AXIS_MAX
    }
  };
}

function normalizeVolumeDeltaValue(value: number): number {
  return Math.max(VOLUME_DELTA_DATA_MIN, Math.min(VOLUME_DELTA_DATA_MAX, Number(value)));
}

function setVolumeDeltaCursor(isCrosshair: boolean): void {
  const container = document.getElementById('vd-rsi-chart-container');
  if (!container) return;
  container.style.cursor = isCrosshair ? 'crosshair' : 'default';
}

function toUnixSeconds(time: string | number): number | null {
  return unixSecondsFromTimeValue(time);
}

function formatMmDdYyFromUnixSeconds(unixSeconds: number | null): string {
  if (!Number.isFinite(unixSeconds)) return 'N/A';
  return getAppTimeZoneFormatter('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit'
  }).format(new Date(Math.round(Number(unixSeconds)) * 1000));
}

function createTrendlineCrossLabelElement(text: string): HTMLDivElement {
  const label = document.createElement('div');
  label.className = 'trendline-cross-label';
  label.textContent = text;
  label.style.position = 'absolute';
  label.style.zIndex = '29';
  label.style.minHeight = '24px';
  label.style.display = 'inline-flex';
  label.style.alignItems = 'center';
  label.style.padding = '0 8px';
  label.style.borderRadius = '4px';
  label.style.border = '1px solid #30363d';
  label.style.background = '#161b22';
  label.style.color = '#c9d1d9';
  label.style.fontSize = '12px';
  label.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
  label.style.pointerEvents = 'none';
  label.style.whiteSpace = 'nowrap';
  label.style.transform = 'translate(-50%, calc(-100% - 6px))';
  return label;
}

function refreshVolumeDeltaTrendlineCrossLabels(): void {
  const container = document.getElementById('vd-rsi-chart-container');
  if (!container || !volumeDeltaRsiChart || !volumeDeltaRsiSeries) return;
  const width = container.clientWidth;
  const height = container.clientHeight;

  for (const label of volumeDeltaTrendlineCrossLabels) {
    const x = volumeDeltaRsiChart.timeScale().timeToCoordinate(label.anchorTime);
    const y = volumeDeltaRsiSeries.priceToCoordinate(label.anchorValue);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > width || y < 0 || y > height) {
      label.element.style.display = 'none';
      continue;
    }
    label.element.style.display = 'inline-flex';
    label.element.style.left = `${Math.round(x)}px`;
    label.element.style.top = `${Math.round(Math.max(8, y))}px`;
  }
}

function clearVolumeDeltaTrendlineCrossLabels(): void {
  for (const label of volumeDeltaTrendlineCrossLabels) {
    label.element.remove();
  }
  volumeDeltaTrendlineCrossLabels = [];
}

function addVolumeDeltaTrendlineCrossLabel(anchorTime: string | number, anchorValue: number, text: string): void {
  const container = document.getElementById('vd-rsi-chart-container');
  if (!container) return;
  const element = createTrendlineCrossLabelElement(text);
  container.appendChild(element);
  volumeDeltaTrendlineCrossLabels.push({
    element,
    anchorTime,
    anchorValue
  });
  refreshVolumeDeltaTrendlineCrossLabels();
}

function volumeDeltaIndexToUnixSeconds(
  index: number,
  lastHistoricalIndex: number,
  firstHistoricalTimeSeconds: number | null,
  lastHistoricalTimeSeconds: number | null,
  stepSeconds: number
): number | null {
  if (!Number.isFinite(index)) return null;

  if (index > lastHistoricalIndex) {
    if (lastHistoricalTimeSeconds === null) return null;
    return lastHistoricalTimeSeconds + ((index - lastHistoricalIndex) * stepSeconds);
  }

  if (index < 0) {
    if (firstHistoricalTimeSeconds === null) return null;
    return firstHistoricalTimeSeconds + (index * stepSeconds);
  }

  const lowerIndex = Math.max(0, Math.floor(index));
  const upperIndex = Math.min(lastHistoricalIndex, Math.ceil(index));
  const lowerTime = toUnixSeconds(volumeDeltaRsiPoints[lowerIndex]?.time);
  const upperTime = toUnixSeconds(volumeDeltaRsiPoints[upperIndex]?.time);
  if (lowerIndex === upperIndex) return lowerTime;
  if (Number.isFinite(lowerTime) && Number.isFinite(upperTime)) {
    const ratio = index - lowerIndex;
    return Number(lowerTime) + ((Number(upperTime) - Number(lowerTime)) * ratio);
  }
  if (Number.isFinite(lowerTime)) return Number(lowerTime) + ((index - lowerIndex) * stepSeconds);
  if (firstHistoricalTimeSeconds === null) return null;
  return firstHistoricalTimeSeconds + (index * stepSeconds);
}

function computeVolumeDeltaTrendlineMidlineCrossUnixSeconds(
  index1: number,
  value1: number,
  slope: number,
  lastHistoricalIndex: number,
  firstHistoricalTimeSeconds: number | null,
  lastHistoricalTimeSeconds: number | null,
  stepSeconds: number
): number | null {
  if (!Number.isFinite(slope) || Math.abs(slope) < 1e-12) return null;
  const crossIndex = index1 + ((RSI_MIDLINE_VALUE - value1) / slope);
  if (!Number.isFinite(crossIndex)) return null;
  return volumeDeltaIndexToUnixSeconds(
    crossIndex,
    lastHistoricalIndex,
    firstHistoricalTimeSeconds,
    lastHistoricalTimeSeconds,
    stepSeconds
  );
}

function inferVolumeDeltaBarStepSeconds(): number {
  if (volumeDeltaRsiPoints.length < 2) return 1800;
  const diffs: number[] = [];
  for (let i = 1; i < volumeDeltaRsiPoints.length; i++) {
    const prev = toUnixSeconds(volumeDeltaRsiPoints[i - 1].time);
    const curr = toUnixSeconds(volumeDeltaRsiPoints[i].time);
    if (prev === null || curr === null) continue;
    const diff = curr - prev;
    if (Number.isFinite(diff) && diff > 0 && diff <= (8 * 3600)) {
      diffs.push(diff);
    }
  }
  if (diffs.length === 0) return 1800;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function barsPerTradingDayFromStep(stepSeconds: number): number {
  if (stepSeconds <= 5 * 60) return 78;
  if (stepSeconds <= 15 * 60) return 26;
  if (stepSeconds <= 30 * 60) return 13;
  if (stepSeconds <= 60 * 60) return 7;
  return 2;
}

function volumeDeltaFutureBarsForOneYear(): number {
  const stepSeconds = inferVolumeDeltaBarStepSeconds();
  return barsPerTradingDayFromStep(stepSeconds) * 252;
}

function clearVolumeDeltaHighlights(): void {
  if (!volumeDeltaHighlightSeries || !volumeDeltaRsiChart) return;
  try {
    volumeDeltaRsiChart.removeSeries(volumeDeltaHighlightSeries);
  } catch {
    // Ignore stale highlight series remove errors.
  }
  volumeDeltaHighlightSeries = null;
}

function clearVolumeDeltaTrendLines(preserveViewport: boolean = false): void {
  const visibleRangeBeforeClear = preserveViewport && volumeDeltaRsiChart
    ? volumeDeltaRsiChart.timeScale().getVisibleLogicalRange?.()
    : null;
  if (preserveViewport) {
    volumeDeltaSuppressSync = true;
  }

  if (!volumeDeltaRsiChart || volumeDeltaTrendLineSeriesList.length === 0) {
    volumeDeltaTrendLineSeriesList = [];
    volumeDeltaTrendlineDefinitions = [];
    clearVolumeDeltaTrendlineCrossLabels();
    if (preserveViewport) {
      volumeDeltaSuppressSync = false;
    }
    return;
  }

  try {
    for (const series of volumeDeltaTrendLineSeriesList) {
      try {
        volumeDeltaRsiChart.removeSeries(series);
      } catch {
        // Ignore stale trendline series remove errors.
      }
    }
    volumeDeltaTrendLineSeriesList = [];
    volumeDeltaTrendlineDefinitions = [];
    clearVolumeDeltaTrendlineCrossLabels();
  } finally {
    if (preserveViewport && visibleRangeBeforeClear) {
      try {
        volumeDeltaRsiChart.timeScale().setVisibleLogicalRange(visibleRangeBeforeClear);
      } catch {
        // Keep viewport stable after clearing.
      }
    }
    if (preserveViewport) {
      volumeDeltaSuppressSync = false;
    }
  }
}

function clearVolumeDeltaDivergenceState(): void {
  clearVolumeDeltaHighlights();
  volumeDeltaFirstPoint = null;
  volumeDeltaDivergencePointTimeKeys.clear();
}

function deactivateVolumeDeltaDivergenceTool(): void {
  volumeDeltaDivergenceToolActive = false;
  clearVolumeDeltaDivergenceState();
  setVolumeDeltaCursor(false);
}

function activateVolumeDeltaDivergenceTool(): void {
  volumeDeltaDivergenceToolActive = true;
  setVolumeDeltaCursor(true);
}

function clearVolumeDeltaDivergence(preserveViewport: boolean = false): void {
  clearVolumeDeltaDivergenceState();
  clearVolumeDeltaTrendLines(preserveViewport);
}

function highlightVolumeDeltaPoints(points: Array<{ time: string | number, value: number }>): void {
  clearVolumeDeltaHighlights();
  if (!volumeDeltaRsiChart || points.length === 0) return;

  volumeDeltaHighlightSeries = volumeDeltaRsiChart.addLineSeries({
    color: DIVERGENCE_HIGHLIGHT_COLOR,
    lineVisible: false,
    pointMarkersVisible: true,
    pointMarkersRadius: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider()
  });

  const step = Math.max(1, Math.ceil(points.length / VOLUME_DELTA_MAX_HIGHLIGHT_POINTS));
  const displayPoints = step === 1 ? points : points.filter((_, index) => index % step === 0);
  volumeDeltaHighlightSeries.setData(displayPoints);
}

function drawVolumeDeltaTrendLine(
  time1: string | number,
  value1: number,
  time2: string | number,
  value2: number,
  recordDefinition: boolean = true
): void {
  if (!volumeDeltaRsiChart || !volumeDeltaRsiPoints.length) return;

  const index1 = volumeDeltaIndexByTime.get(timeKey(time1));
  const index2 = volumeDeltaIndexByTime.get(timeKey(time2));
  if (index1 === undefined || index2 === undefined || index1 === index2) return;

  const slope = (value2 - value1) / (index2 - index1);
  const lastHistoricalIndex = volumeDeltaRsiPoints.length - 1;
  const futureBars = volumeDeltaFutureBarsForOneYear();
  const maxIndex = lastHistoricalIndex + futureBars;
  const stepSeconds = inferVolumeDeltaBarStepSeconds();
  const firstTimeSeconds = toUnixSeconds(volumeDeltaRsiPoints[0]?.time);
  const lastTimeSeconds = toUnixSeconds(volumeDeltaRsiPoints[lastHistoricalIndex]?.time);
  const visibleRangeBeforeDraw = volumeDeltaRsiChart.timeScale().getVisibleLogicalRange?.();

  const trendLineData: Array<{ time: string | number, value: number }> = [];
  volumeDeltaSuppressSync = true;
  try {
    for (let i = index1; i <= maxIndex; i++) {
      const projectedValue = value1 + (slope * (i - index1));
      if (!Number.isFinite(projectedValue)) break;
      if (projectedValue < VOLUME_DELTA_DATA_MIN || projectedValue > VOLUME_DELTA_DATA_MAX) break;

      let pointTime: string | number | null = null;
      if (i <= lastHistoricalIndex) {
        pointTime = volumeDeltaRsiPoints[i]?.time ?? null;
      } else if (lastTimeSeconds !== null) {
        pointTime = lastTimeSeconds + ((i - lastHistoricalIndex) * stepSeconds);
      }
      if (pointTime === null || pointTime === undefined) continue;
      trendLineData.push({
        time: pointTime,
        value: projectedValue
      });
    }

    if (!trendLineData.length) return;

    const trendLineSeries = volumeDeltaRsiChart.addLineSeries({
      color: TRENDLINE_COLOR,
      lineWidth: 1,
      lineStyle: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider()
    });
    trendLineSeries.setData(trendLineData);
    volumeDeltaTrendLineSeriesList.push(trendLineSeries);

    const crossUnixSeconds = computeVolumeDeltaTrendlineMidlineCrossUnixSeconds(
      index1,
      value1,
      slope,
      lastHistoricalIndex,
      firstTimeSeconds,
      lastTimeSeconds,
      stepSeconds
    );
    addVolumeDeltaTrendlineCrossLabel(time1, value1, formatMmDdYyFromUnixSeconds(crossUnixSeconds));
    if (recordDefinition) {
      volumeDeltaTrendlineDefinitions.push({
        time1,
        value1: Number(value1),
        time2,
        value2: Number(value2)
      });
    }
  } finally {
    if (visibleRangeBeforeDraw) {
      try {
        volumeDeltaRsiChart.timeScale().setVisibleLogicalRange(visibleRangeBeforeDraw);
      } catch {
        // Keep viewport stable even if range restoration fails.
      }
    }
    volumeDeltaSuppressSync = false;
  }
}

function detectAndHandleVolumeDeltaDivergenceClick(clickedTime: string | number): void {
  if (!volumeDeltaDivergenceToolActive) return;

  const clickedKey = timeKey(clickedTime);
  const clickedIndex = volumeDeltaIndexByTime.get(clickedKey);
  if (clickedIndex === undefined) return;

  const clickedPoint = volumeDeltaRsiPoints[clickedIndex];
  if (!clickedPoint) return;
  const clickedRSI = Number(clickedPoint.value);
  const clickedPrice = priceByTime.get(clickedKey);
  if (!Number.isFinite(clickedRSI) || !Number.isFinite(clickedPrice)) return;
  const clickedPriceValue = Number(clickedPrice);

  if (!volumeDeltaFirstPoint) {
    volumeDeltaFirstPoint = {
      time: clickedTime,
      rsi: clickedRSI,
      price: clickedPriceValue,
      index: clickedIndex
    };

    const divergencePoints: Array<{ time: string | number, value: number }> = [];
    volumeDeltaDivergencePointTimeKeys.clear();

    for (let i = clickedIndex + 1; i < volumeDeltaRsiPoints.length; i++) {
      const currentPoint = volumeDeltaRsiPoints[i];
      const currentRSI = Number(currentPoint?.value);
      if (!Number.isFinite(currentRSI)) continue;
      const currentPrice = priceByTime.get(timeKey(currentPoint.time));
      if (!Number.isFinite(currentPrice)) continue;

      const currentPriceValue = Number(currentPrice);
      const bearishDivergence = currentRSI < clickedRSI && currentPriceValue > clickedPriceValue;
      const bullishDivergence = currentRSI > clickedRSI && currentPriceValue < clickedPriceValue;
      if (!bearishDivergence && !bullishDivergence) continue;

      divergencePoints.push({ time: currentPoint.time, value: currentRSI });
      volumeDeltaDivergencePointTimeKeys.add(timeKey(currentPoint.time));
    }

    highlightVolumeDeltaPoints(divergencePoints);
    return;
  }

  if (!volumeDeltaDivergencePointTimeKeys.has(clickedKey)) {
    return;
  }

  drawVolumeDeltaTrendLine(
    volumeDeltaFirstPoint.time,
    volumeDeltaFirstPoint.rsi,
    clickedTime,
    clickedRSI
  );

  deactivateVolumeDeltaDivergenceTool();
  setPaneTrendlineToolActive('volumeDeltaRsi', false);
  persistTrendlinesForCurrentContext();
}

function sameLogicalRange(a: any, b: any): boolean {
  if (!a || !b) return false;
  return Math.abs(Number(a.from) - Number(b.from)) < 1e-6 && Math.abs(Number(a.to) - Number(b.to)) < 1e-6;
}

// Create price chart
function createPriceChart(container: HTMLElement) {
  const chart = createChart(container, {
    layout: {
      background: { color: '#0d1117' },
      textColor: '#d1d4dc',
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
      borderColor: '#2b2b43',
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
      formatter: (price: number) => formatPriceScaleLabel(Number(price))
    }
  });

  const timelineSeries = chart.addLineSeries({
    color: 'rgba(0, 0, 0, 0)',
    lineVisible: false,
    pointMarkersVisible: false,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false
  });

  // No line tools for price chart - divergence tool only on RSI chart

  return { chart, series, timelineSeries };
}

function createVolumeDeltaRsiChart(container: HTMLElement) {
  const chart = createChart(container, {
    layout: {
      background: { color: '#0d1117' },
      textColor: '#c9d1d9',
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
      borderColor: '#21262d',
      minimumWidth: SCALE_MIN_WIDTH_PX,
      entireTextOnly: true,
      // Default view: 20-80 range (20% margin top + 20% margin bottom)
      // User can adjust but won't go beyond 0-100 data bounds
      scaleMargins: {
        top: 0.2,    // 20% margin = hides 0-20 by default
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
    crosshairMarkerVisible: false
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
    if (volumeDeltaRsiDivergencePlotToolActive) {
      updateVolumeDeltaRsiDivergencePlotPoint(param.time, false);
      return;
    }
    if (!volumeDeltaDivergenceToolActive) return;
    detectAndHandleVolumeDeltaDivergenceClick(param.time);
  });

  return { chart, rsiSeries, timelineSeries };
}

function createVolumeDeltaChart(container: HTMLElement) {
  const chart = createChart(container, {
    layout: {
      background: { color: '#0d1117' },
      textColor: '#c9d1d9',
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
        price: true,
      },
      axisDoubleClickReset: {
        time: true,
        price: true,
      },
    },
    rightPriceScale: {
      borderColor: '#21262d',
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
    crosshairMarkerVisible: false
  });

  histogramSeries.createPriceLine({
    price: 0,
    color: '#8b949e',
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
  bars: any[],
  volumeDeltaRsi: { rsi: Array<{ time: string | number, value: number }> }
): void {
  if (!volumeDeltaRsiSeries) return;

  clearVolumeDeltaDivergence();
  const normalizedRsi = normalizeValueSeries(volumeDeltaRsi?.rsi || []);
  volumeDeltaRsiPoints = normalizedRsi.map((point) => ({
    time: point.time,
    value: normalizeVolumeDeltaValue(Number(point.value))
  }));
  volumeDeltaIndexByTime = new Map<string, number>();
  for (let i = 0; i < volumeDeltaRsiPoints.length; i++) {
    volumeDeltaIndexByTime.set(timeKey(volumeDeltaRsiPoints[i].time), i);
  }

  const rsiByTimeLocal = new Map<string, number>();
  for (const point of volumeDeltaRsiPoints) {
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

function restoreVolumeDeltaPersistedTrendlines(trendlines: RSIPersistedTrendline[]): void {
  clearVolumeDeltaTrendLines();
  if (!Array.isArray(trendlines) || trendlines.length === 0) return;
  for (const line of trendlines) {
    const time1 = line?.time1;
    const time2 = line?.time2;
    const value1 = Number(line?.value1);
    const value2 = Number(line?.value2);
    if ((typeof time1 !== 'string' && typeof time1 !== 'number') || (typeof time2 !== 'string' && typeof time2 !== 'number')) continue;
    if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
    drawVolumeDeltaTrendLine(time1, value1, time2, value2, true);
  }
}

function restorePersistedTrendlinesForCurrentContext(): void {
  if (!currentChartTicker) return;
  const persisted = loadPersistedTrendlinesForContext(currentChartTicker, currentChartInterval);
  rsiChart?.restorePersistedTrendlines(persisted.rsi);
  restoreVolumeDeltaPersistedTrendlines(persisted.volumeDeltaRsi);
}

function setVolumeDeltaHistogramData(
  bars: any[],
  volumeDeltaValues: Array<{ time: string | number, delta: number }>
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
      color: numeric >= 0 ? VOLUME_DELTA_POSITIVE_COLOR : VOLUME_DELTA_NEGATIVE_COLOR
    };
  });

  volumeDeltaHistogramSeries.setData(histogramData);
  volumeDeltaByTime = new Map(
    histogramData.map((point: any) => [timeKey(point.time), Number(point.value) || 0])
  );
  applyPricePaneDivergentBarColors();
}

function ensureVolumeDeltaDivergenceSummaryEl(container: HTMLElement): HTMLDivElement {
  if (volumeDeltaDivergenceSummaryEl && volumeDeltaDivergenceSummaryEl.parentElement === container) {
    volumeDeltaDivergenceSummaryEl.style.top = '8px';
    volumeDeltaDivergenceSummaryEl.style.transform = 'none';
    volumeDeltaDivergenceSummaryEl.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
    volumeDeltaDivergenceSummaryEl.style.display = 'flex';
    volumeDeltaDivergenceSummaryEl.style.flexDirection = 'row';
    volumeDeltaDivergenceSummaryEl.style.alignItems = 'center';
    volumeDeltaDivergenceSummaryEl.style.gap = `${PANE_TOOL_BUTTON_GAP_PX}px`;
    volumeDeltaDivergenceSummaryEl.style.background = 'transparent';
    volumeDeltaDivergenceSummaryEl.style.border = 'none';
    volumeDeltaDivergenceSummaryEl.style.borderRadius = '0';
    volumeDeltaDivergenceSummaryEl.style.overflow = 'visible';
    return volumeDeltaDivergenceSummaryEl;
  }

  const el = document.createElement('div');
  el.className = 'volume-delta-divergence-summary';
  el.style.position = 'absolute';
  el.style.top = '8px';
  el.style.transform = 'none';
  el.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
  el.style.zIndex = '34';
  el.style.display = 'flex';
  el.style.flexDirection = 'row';
  el.style.alignItems = 'center';
  el.style.gap = `${PANE_TOOL_BUTTON_GAP_PX}px`;
  el.style.background = 'transparent';
  el.style.border = 'none';
  el.style.borderRadius = '0';
  el.style.overflow = 'visible';
  el.style.pointerEvents = 'auto';
  container.appendChild(el);
  volumeDeltaDivergenceSummaryEl = el;
  return el;
}

function clearVolumeDeltaDivergenceSummary(): void {
  if (!volumeDeltaDivergenceSummaryEl) return;
  volumeDeltaDivergenceSummaryEl.style.display = 'none';
  volumeDeltaDivergenceSummaryEl.innerHTML = '';
}

function renderVolumeDeltaDivergenceSummary(
  container: HTMLElement,
  bars: any[],
  options?: { noCache?: boolean }
): void {
  if (!volumeDeltaSettings.divergenceTable) {
    clearVolumeDeltaDivergenceSummary();
    return;
  }
  const summaryEl = ensureVolumeDeltaDivergenceSummaryEl(container);
  summaryEl.innerHTML = '';
  summaryEl.style.display = 'flex';
  summaryEl.style.flexDirection = 'row';
  summaryEl.style.alignItems = 'center';
  const ticker = String(currentChartTicker || '').trim().toUpperCase();
  const sourceInterval = volumeDeltaSettings.sourceInterval;
  const noCache = options?.noCache === true;
  const requestToken = `${ticker}|${sourceInterval}|${Date.now()}`;
  summaryEl.dataset.requestToken = requestToken;
  let manualRefreshInFlight = false;
  let lastSummary: DivergenceSummaryEntry | null = null;

  const buildBadge = (text: string, color: string, title: string): HTMLDivElement => {
    const badge = document.createElement('div');
    badge.textContent = text;
    badge.title = title;
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
    badge.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    badge.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    badge.style.padding = '0';
    badge.style.borderRadius = '4px';
    badge.style.border = '1px solid #30363d';
    badge.style.background = '#161b22';
    badge.style.fontSize = '12px';
    badge.style.fontWeight = '600';
    badge.style.lineHeight = '1';
    badge.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    badge.style.color = color;
    badge.style.pointerEvents = 'none';
    return badge;
  };

  const runManualRefresh = () => {
    if (manualRefreshInFlight) return;
    manualRefreshInFlight = true;
    renderSummary(lastSummary, true);
    getTickerDivergenceSummary(
      ticker,
      sourceInterval,
      { forceRefresh: true, noCache: true }
    )
      .then((summary) => {
        if (summaryEl.dataset.requestToken !== requestToken) return;
        if (String(currentChartTicker || '').trim().toUpperCase() !== ticker) return;
        lastSummary = summary || null;
        renderSummary(lastSummary, false);
      })
      .catch(() => {
        if (summaryEl.dataset.requestToken !== requestToken) return;
        if (String(currentChartTicker || '').trim().toUpperCase() !== ticker) return;
        renderSummary(lastSummary, false);
      })
      .finally(() => {
        manualRefreshInFlight = false;
      });
  };

  const renderSummary = (summary: DivergenceSummaryEntry | null, loading = false) => {
    if (summaryEl.dataset.requestToken !== requestToken) return;
    if (String(currentChartTicker || '').trim().toUpperCase() !== ticker) return;
    summaryEl.innerHTML = '';

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.title = loading ? 'Refreshing divergence table...' : 'Refresh divergence table';
    refreshButton.style.display = 'inline-flex';
    refreshButton.style.alignItems = 'center';
    refreshButton.style.justifyContent = 'center';
    refreshButton.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    refreshButton.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    refreshButton.style.padding = '0';
    refreshButton.style.borderRadius = '4px';
    refreshButton.style.border = 'none';
    refreshButton.style.background = 'transparent';
    refreshButton.style.color = '#c9d1d9';
    refreshButton.style.cursor = loading ? 'wait' : 'pointer';
    refreshButton.style.pointerEvents = loading ? 'none' : 'auto';
    refreshButton.style.userSelect = 'none';
    refreshButton.style.flex = '0 0 auto';
    refreshButton.style.verticalAlign = 'middle';
    refreshButton.setAttribute('aria-disabled', loading ? 'true' : 'false');
    refreshButton.disabled = false;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.display = 'block';
    // Top arrow: arc from right curving down-left, with arrowhead
    const path1 = document.createElementNS(svgNS, 'path');
    path1.setAttribute('d', 'M21.5 2v6h-6');
    const path2 = document.createElementNS(svgNS, 'path');
    path2.setAttribute('d', 'M21.5 8A10 10 0 0 0 5.6 5.6');
    // Bottom arrow: arc from left curving up-right, with arrowhead
    const path3 = document.createElementNS(svgNS, 'path');
    path3.setAttribute('d', 'M2.5 22v-6h6');
    const path4 = document.createElementNS(svgNS, 'path');
    path4.setAttribute('d', 'M2.5 16A10 10 0 0 0 18.4 18.4');
    svg.appendChild(path1);
    svg.appendChild(path2);
    svg.appendChild(path3);
    svg.appendChild(path4);
    if (loading) {
      svg.animate(
        [
          { transform: 'rotate(0deg)' },
          { transform: 'rotate(360deg)' }
        ],
        {
          duration: 800,
          iterations: Infinity,
          easing: 'linear'
        }
      );
    }
    refreshButton.appendChild(svg);
    refreshButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      runManualRefresh();
    });
    summaryEl.appendChild(refreshButton);

    for (let i = 0; i < DIVERGENCE_LOOKBACK_DAYS.length; i++) {
      const days = DIVERGENCE_LOOKBACK_DAYS[i];
      const state = summary?.states?.[String(days)] || 'neutral';
      const badgeColor = state === 'bullish'
        ? '#26a69a'
        : state === 'bearish'
          ? '#ef5350'
          : '#ffffff';
      const badge = buildBadge(
        String(days),
        badgeColor,
        `Last ${days} day${days === 1 ? '' : 's'}${summary?.tradeDate ? ` (as of ${summary.tradeDate})` : ''}`
      );
      summaryEl.appendChild(badge);
    }
  };

  renderSummary(null, false);
  if (!ticker || (!Array.isArray(bars) || bars.length < 2)) {
    return;
  }

  // Phase 1: Fast path — try cached / stored value (no server recomputation).
  getTickerDivergenceSummary(ticker, sourceInterval)
    .then((summary) => {
      if (summaryEl.dataset.requestToken !== requestToken) return;
      lastSummary = summary || null;
      renderSummary(lastSummary, false);

      // Phase 2: If the cached value is stale or missing, refresh in background.
      const needsRefresh = noCache || !summary || !Number.isFinite(summary.expiresAtMs) || summary.expiresAtMs <= Date.now();
      if (needsRefresh) {
        getTickerDivergenceSummary(
          ticker,
          sourceInterval,
          { forceRefresh: true, noCache: true }
        )
          .then((freshSummary) => {
            if (summaryEl.dataset.requestToken !== requestToken) return;
            lastSummary = freshSummary || null;
            renderSummary(lastSummary, false);
          })
          .catch(() => {});
      }
    })
    .catch(() => {
      // Phase 1 failed — fall back to force refresh.
      getTickerDivergenceSummary(
        ticker,
        sourceInterval,
        { forceRefresh: true, noCache: true }
      )
        .then((summary) => {
          if (summaryEl.dataset.requestToken !== requestToken) return;
          lastSummary = summary || null;
          renderSummary(lastSummary, false);
        })
        .catch(() => {
          renderSummary(lastSummary, false);
        });
    });
}

// =============================================================================
// VDF (Volume Divergence Flag) Detector Button
// =============================================================================

const VDF_COLOR_LOADING = '#c9d1d9';
const VDF_COLOR_NOT_DETECTED = '#484f58';
const VDF_COLOR_ERROR = '#ef5350';

function ensureVDFButton(container: HTMLElement): HTMLButtonElement {
  if (vdfButtonEl && vdfButtonEl.parentElement === container) return vdfButtonEl;
  if (vdfButtonEl && vdfButtonEl.parentElement) {
    vdfButtonEl.parentElement.removeChild(vdfButtonEl);
  }

  const btn = document.createElement('button');
  btn.className = 'vdf-indicator-btn';
  btn.type = 'button';
  btn.title = 'Volume Divergence Flag Detector';
  btn.textContent = 'VDF';
  btn.style.position = 'absolute';
  btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
  btn.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
  btn.style.zIndex = '34';
  btn.style.width = 'auto';
  btn.style.minWidth = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.padding = '0 5px';
  btn.style.borderRadius = '4px';
  btn.style.border = '1px solid #30363d';
  btn.style.background = '#161b22';
  btn.style.color = VDF_COLOR_LOADING;
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '9px';
  btn.style.fontWeight = '700';
  btn.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
  btn.style.letterSpacing = '0.5px';
  btn.style.lineHeight = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.textAlign = 'center';
  btn.style.userSelect = 'none';
  container.appendChild(btn);
  vdfButtonEl = btn;
  return btn;
}

function setVDFButtonColor(color: string, title?: string): void {
  if (!vdfButtonEl) return;
  vdfButtonEl.style.color = color;
  if (title !== undefined) vdfButtonEl.title = title;
}

function buildVDFTooltip(entry: VDFCacheEntry): string {
  if (!entry.is_detected) return `VD Accumulation: Not detected`;
  const score = Math.round(entry.composite_score * 100);
  let tip = `VD Accumulation Score: ${score}`;
  const bestZone = entry.zones?.[0];
  if (bestZone) {
    const startParts = bestZone.startDate.split('-');
    const endParts = bestZone.endDate.split('-');
    const startLabel = startParts.length >= 3 ? `${Number(startParts[1])}/${Number(startParts[2])}` : bestZone.startDate;
    const endLabel = endParts.length >= 3 ? `${Number(endParts[1])}/${Number(endParts[2])}` : bestZone.endDate;
    tip += `\nZone: ${startLabel}→${endLabel} (${bestZone.windowDays}d)`;
    if (bestZone.absorptionPct != null) tip += `\nAbsorption: ${(bestZone.absorptionPct * 100).toFixed(1)}%`;
  }
  if (entry.zones?.length > 1) tip += `\n+${entry.zones.length - 1} more zone(s)`;
  if (entry.distribution?.length > 0) tip += `\nDistribution: ${entry.distribution.length} cluster(s)`;
  const prox = entry.proximity;
  if (prox && prox.level !== 'none') {
    tip += `\nProximity: ${prox.level.charAt(0).toUpperCase() + prox.level.slice(1)} (${prox.compositeScore} pts)`;
    for (const sig of prox.signals) {
      tip += `\n  ✓ ${sig.detail} +${sig.points}`;
    }
  }
  return tip;
}

function updateVDFButton(entry: VDFCacheEntry): void {
  if (!vdfButtonEl) return;
  if (entry.is_detected) {
    const score = Math.round(entry.composite_score * 100);
    vdfButtonEl.textContent = String(score);
    vdfButtonEl.style.color = score >= 80 ? '#26a69a' : score >= 60 ? '#8bc34a' : '#c9d1d9';
    const proxLevel = entry.proximity?.level || 'none';
    if (proxLevel === 'imminent' || proxLevel === 'high') {
      vdfButtonEl.style.borderColor = '#ff9800';
    } else if (proxLevel === 'elevated') {
      vdfButtonEl.style.borderColor = '#ffc107';
    } else {
      vdfButtonEl.style.borderColor = '#30363d';
    }
  } else {
    vdfButtonEl.textContent = 'VDF';
    vdfButtonEl.style.color = VDF_COLOR_NOT_DETECTED;
    vdfButtonEl.style.borderColor = '#30363d';
  }
  vdfButtonEl.title = buildVDFTooltip(entry);
}

function ensureVDZoneOverlay(container: HTMLElement): HTMLDivElement {
  if (vdZoneOverlayEl && vdZoneOverlayEl.parentElement === container) return vdZoneOverlayEl;
  if (vdZoneOverlayEl?.parentElement) vdZoneOverlayEl.parentElement.removeChild(vdZoneOverlayEl);
  const overlay = document.createElement('div');
  overlay.className = 'vd-zone-overlay';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.left = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '5';
  container.appendChild(overlay);
  vdZoneOverlayEl = overlay;
  return overlay;
}

function renderVDZones(entry?: VDFCacheEntry | null): void {
  if (!vdZoneOverlayEl) return;
  vdZoneOverlayEl.innerHTML = '';
  if (!priceChart || !entry) return;

  const overlayWidth = vdZoneOverlayEl.clientWidth || vdZoneOverlayEl.offsetWidth;
  const overlayHeight = vdZoneOverlayEl.clientHeight || vdZoneOverlayEl.offsetHeight;
  if (!Number.isFinite(overlayWidth) || overlayWidth <= 0) return;

  // Build lookup from YYYY-MM-DD (ET) → actual bar time value.
  // Chart bars use midnight ET converted to UTC as their time, so we must
  // map zone date strings to the real bar times the chart knows about.
  const dateToBarTime = new Map<string, number>();
  for (const bar of currentBars) {
    const t = unixSecondsFromTimeValue(bar?.time);
    if (t === null) continue;
    const dateKey = new Date(t * 1000).toLocaleDateString('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    if (!dateToBarTime.has(dateKey)) dateToBarTime.set(dateKey, t);
  }

  const dateToX = (dateStr: string): number | null => {
    const barTime = dateToBarTime.get(dateStr);
    if (barTime === undefined) return null;
    const x = priceChart!.timeScale().timeToCoordinate(barTime as any);
    return Number.isFinite(x) ? x : null;
  };

  // --- Full-height tinted overlays ---
  if (entry.zones) {
    for (const zone of entry.zones) {
      const x1 = dateToX(zone.startDate);
      const x2 = dateToX(zone.endDate);
      if (x1 == null || x2 == null) continue;
      const left = Math.min(x1, x2);
      const width = Math.abs(x2 - x1);
      if (left > overlayWidth || left + width < 0) continue;

      const opacity = 0.04 + zone.score * 0.08;
      const rect = document.createElement('div');
      rect.style.cssText = `position:absolute;left:${Math.round(left)}px;top:0;width:${Math.max(Math.round(width), 2)}px;height:100%;background:rgba(38,166,154,${opacity.toFixed(3)});border-left:1px solid rgba(38,166,154,0.3);border-right:1px solid rgba(38,166,154,0.3);`;

      const badge = document.createElement('div');
      badge.style.cssText = 'position:absolute;top:2px;right:2px;font-size:9px;color:rgba(38,166,154,0.8);font-family:monospace;';
      badge.textContent = (zone.score * 100).toFixed(0);
      rect.appendChild(badge);
      vdZoneOverlayEl.appendChild(rect);
    }
  }

  if (entry.distribution) {
    for (const dist of entry.distribution) {
      const x1 = dateToX(dist.startDate);
      const x2 = dateToX(dist.endDate);
      if (x1 == null || x2 == null) continue;
      const left = Math.min(x1, x2);
      const width = Math.abs(x2 - x1);
      if (left > overlayWidth || left + width < 0) continue;

      const rect = document.createElement('div');
      rect.style.cssText = `position:absolute;left:${Math.round(left)}px;top:0;width:${Math.max(Math.round(width), 2)}px;height:100%;background:rgba(239,83,80,0.06);border-left:1px solid rgba(239,83,80,0.3);border-right:1px solid rgba(239,83,80,0.3);`;
      vdZoneOverlayEl.appendChild(rect);
    }
  }

  // --- Bottom band strip: accumulation / distribution / absorption ---
  const BAND_H = 5;
  const BAND_GAP = 1;
  const STRIP_PAD = 2;
  const hasZones = entry.zones && entry.zones.length > 0;
  const hasDist = entry.distribution && entry.distribution.length > 0;

  if (overlayHeight > 60 && (hasZones || hasDist)) {
    // Row Y positions (from bottom): accumulation (top row), distribution (mid), absorption (bottom)
    const absY = overlayHeight - STRIP_PAD - BAND_H;
    const distY = absY - BAND_GAP - BAND_H;
    const accumY = distY - BAND_GAP - BAND_H;

    // Accumulation zone bands (teal)
    if (entry.zones) {
      for (const zone of entry.zones) {
        const x1 = dateToX(zone.startDate);
        const x2 = dateToX(zone.endDate);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        if (left > overlayWidth || left + width < 0) continue;
        const op = (0.4 + zone.score * 0.5).toFixed(2);
        const band = document.createElement('div');
        band.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${accumY}px;width:${Math.max(Math.round(width), 2)}px;height:${BAND_H}px;background:rgba(38,166,154,${op});border-radius:1px;`;
        vdZoneOverlayEl.appendChild(band);
      }
    }

    // Distribution cluster bands (red)
    if (entry.distribution) {
      for (const dist of entry.distribution) {
        const x1 = dateToX(dist.startDate);
        const x2 = dateToX(dist.endDate);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        if (left > overlayWidth || left + width < 0) continue;
        const band = document.createElement('div');
        band.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${distY}px;width:${Math.max(Math.round(width), 2)}px;height:${BAND_H}px;background:rgba(239,83,80,0.65);border-radius:1px;`;
        vdZoneOverlayEl.appendChild(band);
      }
    }

    // Absorption bands (amber, within accumulation zone date ranges)
    if (entry.zones) {
      for (const zone of entry.zones) {
        const absPct = zone.absorptionPct || 0;
        if (absPct < 5) continue;
        const x1 = dateToX(zone.startDate);
        const x2 = dateToX(zone.endDate);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        if (left > overlayWidth || left + width < 0) continue;
        const op = Math.min(0.3 + (absPct / 100) * 0.6, 0.9).toFixed(2);
        const band = document.createElement('div');
        band.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${absY}px;width:${Math.max(Math.round(width), 2)}px;height:${BAND_H}px;background:rgba(255,167,38,${op});border-radius:1px;`;
        vdZoneOverlayEl.appendChild(band);
      }
    }
  }

  // --- Zone boundary markers (dashed vertical lines at zone edges) ---
  if (entry.zones) {
    for (const zone of entry.zones) {
      const xs = dateToX(zone.startDate);
      const xe = dateToX(zone.endDate);
      if (xs != null && xs >= 0 && xs <= overlayWidth) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${Math.round(xs)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(38,166,154,0.25);`;
        vdZoneOverlayEl.appendChild(line);
      }
      if (xe != null && xe >= 0 && xe <= overlayWidth) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${Math.round(xe)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(38,166,154,0.25);`;
        vdZoneOverlayEl.appendChild(line);
      }
    }
  }
  if (entry.distribution) {
    for (const dist of entry.distribution) {
      const xs = dateToX(dist.startDate);
      const xe = dateToX(dist.endDate);
      if (xs != null && xs >= 0 && xs <= overlayWidth) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${Math.round(xs)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(239,83,80,0.2);`;
        vdZoneOverlayEl.appendChild(line);
      }
      if (xe != null && xe >= 0 && xe <= overlayWidth) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${Math.round(xe)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(239,83,80,0.2);`;
        vdZoneOverlayEl.appendChild(line);
      }
    }
  }

  // --- Proximity glow bar at right edge ---
  const prox = entry.proximity;
  if (prox && prox.level !== 'none' && prox.compositeScore > 0) {
    const proxRgb = prox.level === 'imminent' ? '244,67,54' : (prox.level === 'high' ? '255,152,0' : '255,193,7');
    const proxOp = prox.level === 'imminent' ? 0.4 : (prox.level === 'high' ? 0.3 : 0.2);
    const bar = document.createElement('div');
    bar.style.cssText = `position:absolute;right:0;top:0;width:3px;height:100%;background:rgba(${proxRgb},${proxOp});box-shadow:0 0 8px rgba(${proxRgb},${(proxOp * 1.5).toFixed(2)}),0 0 16px rgba(${proxRgb},${proxOp});`;
    if (prox.level === 'imminent') bar.className = 'vdf-prox-pulse';
    vdZoneOverlayEl.appendChild(bar);
  }
}

function refreshVDZones(): void {
  if (!vdZoneOverlayEl || !currentChartTicker) return;
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const cached = vdfResultCache.get(`${currentChartTicker}|${today}`);
  if (cached) renderVDZones(cached);
  else renderVDZones(null);
}

async function runVDFDetection(ticker: string, force = false): Promise<void> {
  if (!ticker) return;
  if (vdfLoadingForTicker === ticker && !force) return;

  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const cacheKey = `${ticker}|${today}`;
  if (!force && vdfResultCache.has(cacheKey)) {
    const cached = vdfResultCache.get(cacheKey)!;
    updateVDFButton(cached);
    renderVDZones(cached);
    renderVDFAnalysisPanel(cached);
    return;
  }

  vdfLoadingForTicker = ticker;
  setVDFButtonColor(VDF_COLOR_LOADING, 'VDF: Loading...');

  try {
    const params = new URLSearchParams({ ticker });
    if (force) params.set('force', '1');
    const response = await fetch(`/api/chart/vdf-status?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();

    if (currentChartTicker !== ticker) return;

    const entry: VDFCacheEntry = {
      is_detected: result.is_detected || false,
      composite_score: Number(result.composite_score) || 0,
      status: result.status || '',
      weeks: Number(result.weeks) || 0,
      zones: Array.isArray(result.zones) ? result.zones : [],
      distribution: Array.isArray(result.distribution) ? result.distribution : [],
      proximity: result.proximity || { compositeScore: 0, level: 'none', signals: [] },
      details: result.details || undefined,
    };
    vdfResultCache.set(cacheKey, entry);
    if (vdfResultCache.size > VDF_CACHE_MAX_SIZE) {
      const oldest = vdfResultCache.keys().next().value;
      if (oldest !== undefined) vdfResultCache.delete(oldest);
    }
    updateVDFButton(entry);
    renderVDZones(entry);
    renderVDFAnalysisPanel(entry);
  } catch {
    if (currentChartTicker === ticker) {
      setVDFButtonColor(VDF_COLOR_ERROR, 'VDF: Failed to load');
    }
  } finally {
    if (vdfLoadingForTicker === ticker) vdfLoadingForTicker = null;
  }
}

// ─── VDF Analysis Panel ─────────────────────────────────────────────────────

// VDF component metadata: [key, label, defaultWeight, tooltip]
const VDF_COMPONENTS: Array<{ key: string; label: string; defaultWeight: number; tooltip: string }> = [
  { key: 's1', label: 'Net Delta', defaultWeight: 20, tooltip: 'Total net buying as % of total volume. Higher = more buying pressure. Measures raw institutional flow.' },
  { key: 's2', label: 'Delta Slope', defaultWeight: 15, tooltip: 'Trend of cumulative weekly delta. Rising slope = buying is building over time, not a one-off spike.' },
  { key: 's3', label: 'Delta Shift', defaultWeight: 10, tooltip: 'Is buying stronger now than before? Compares avg daily delta in the zone to the pre-context period.' },
  { key: 's4', label: 'Accum Ratio', defaultWeight: 10, tooltip: 'Fraction of weeks with positive delta. High ratio = persistent buying across multiple weeks, not sporadic.' },
  { key: 's5', label: 'Buy vs Sell', defaultWeight: 5, tooltip: 'Ratio of large buy days to large sell days. Detects if big-volume days lean bullish or bearish.' },
  { key: 's6', label: 'Absorption', defaultWeight: 18, tooltip: 'Percentage of days where price fell but delta was positive. Core divergence signal: institutions buying the dip.' },
  { key: 's7', label: 'Vol Decline', defaultWeight: 5, tooltip: 'Volume declining from first-third to last-third of the zone. Supply drying up = fewer sellers remain.' },
  { key: 's8', label: 'Divergence', defaultWeight: 17, tooltip: 'Rewards price-down + delta-up divergence. Score = 0 when price is rising or delta is negative. The thesis signal.' },
];

const VDF_DEFAULT_WEIGHTS: Record<string, number> = {};
VDF_COMPONENTS.forEach(c => { VDF_DEFAULT_WEIGHTS[c.key] = c.defaultWeight; });

let vdfWeights: Record<string, number> = { ...VDF_DEFAULT_WEIGHTS };
let vdfSettingsPanelEl: HTMLDivElement | null = null;

function loadVDFWeightsFromStorage(): void {
  try {
    const raw = localStorage.getItem('chart_vdf_weights');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const c of VDF_COMPONENTS) {
          if (typeof parsed[c.key] === 'number') vdfWeights[c.key] = parsed[c.key];
        }
      }
    }
  } catch { /* */ }
}

function persistVDFWeightsToStorage(): void {
  try { localStorage.setItem('chart_vdf_weights', JSON.stringify(vdfWeights)); } catch { /* */ }
}

function getVDFWeightTotal(): number {
  return VDF_COMPONENTS.reduce((s, c) => s + (vdfWeights[c.key] || 0), 0);
}

function recomputeVDFZoneScore(zone: VDFZone): number {
  if (!zone.components) return zone.score;
  const total = getVDFWeightTotal();
  if (total <= 0) return 0;
  let rawScore = 0;
  for (const c of VDF_COMPONENTS) {
    const val = (zone.components as Record<string, number>)[c.key] || 0;
    rawScore += val * ((vdfWeights[c.key] || 0) / total);
  }
  const concordancePenalty = zone.concordancePenalty ?? 1.0;
  const durationMultiplier = zone.durationMultiplier ?? 1.0;
  return rawScore * concordancePenalty * durationMultiplier;
}

// Backwards-compatible label array for buildComponentBarsHtml
function getVDFComponentLabels(): Array<[string, string, string]> {
  const total = getVDFWeightTotal();
  return VDF_COMPONENTS.map(c => {
    const w = vdfWeights[c.key] || 0;
    const pct = total > 0 ? Math.round((w / total) * 100) : 0;
    return [c.key, c.label, `${pct}%`] as [string, string, string];
  });
}

function createVDFSettingsPanel(): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'vdf-settings-panel';
  panel.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px 14px;margin:0 14px 12px;display:none;';

  function renderPanel(): void {
    const total = getVDFWeightTotal();
    const totalIs100 = total === 100;
    const totalColor = totalIs100 ? '#26a69a' : total > 100 ? '#f44336' : '#ffc107';
    const rows = VDF_COMPONENTS.map(c => {
      const w = vdfWeights[c.key] || 0;
      return `<div style="display:grid;grid-template-columns:110px 48px;gap:8px;align-items:center;margin:3px 0;" title="${escapeHtml(c.tooltip)}">
        <label style="color:#8b949e;font-size:11px;white-space:nowrap;cursor:help;border-bottom:1px dotted #484f58;" title="${escapeHtml(c.tooltip)}">${escapeHtml(c.label)}</label>
        <input type="text" inputmode="numeric" value="${w}" data-vdf-weight="${c.key}"
          style="width:42px;height:22px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:3px;font-size:11px;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;text-align:center;padding:0 2px;outline:none;" />
      </div>`;
    }).join('');

    const isDefault = VDF_COMPONENTS.every(c => vdfWeights[c.key] === c.defaultWeight);
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e;">Scoring Weights</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="vdf-weight-total" style="font-size:10px;color:${totalColor};font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-weight:600;">${total}%</span>
          <button type="button" data-vdf-weight-action="reset" style="background:#0d1117;color:${isDefault ? '#484f58' : '#c9d1d9'};border:1px solid #30363d;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;${isDefault ? 'opacity:0.5;' : ''}" title="Reset to default weights">Reset</button>
          <button type="button" data-vdf-weight-action="run" style="background:${totalIs100 ? '#26a69a' : '#21262d'};color:${totalIs100 ? '#fff' : '#484f58'};border:1px solid ${totalIs100 ? '#26a69a' : '#30363d'};border-radius:4px;padding:2px 8px;font-size:10px;font-weight:600;cursor:${totalIs100 ? 'pointer' : 'default'};${totalIs100 ? '' : 'opacity:0.5;'}" title="${totalIs100 ? 'Re-run VDF with these weights' : 'Weights must total 100% to run'}">Run</button>
        </div>
      </div>
      ${rows}
      <div style="margin-top:8px;font-size:10px;color:#484f58;line-height:1.4;">${totalIs100 ? 'Weights total 100%. Click Run to re-score, or edit values.' : `Weights must total 100% to run (currently ${total}%).`}</div>
    `;
  }

  renderPanel();

  // Handle text input changes
  panel.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    const key = target?.dataset?.vdfWeight;
    if (!key) return;
    const val = Math.max(0, Math.min(100, Math.round(Number(target.value) || 0)));
    vdfWeights[key] = val;
    persistVDFWeightsToStorage();
    renderPanel();
  });

  // Also update on blur for immediate feedback
  panel.addEventListener('blur', (e) => {
    const target = e.target as HTMLInputElement;
    const key = target?.dataset?.vdfWeight;
    if (!key) return;
    const val = Math.max(0, Math.min(100, Math.round(Number(target.value) || 0)));
    if (vdfWeights[key] !== val) {
      vdfWeights[key] = val;
      persistVDFWeightsToStorage();
      renderPanel();
    }
  }, true);

  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target?.dataset?.vdfWeightAction === 'reset') {
      VDF_COMPONENTS.forEach(c => { vdfWeights[c.key] = c.defaultWeight; });
      persistVDFWeightsToStorage();
      renderPanel();
      refreshVDFScoresFromWeights();
    }
    if (target?.dataset?.vdfWeightAction === 'run') {
      const total = getVDFWeightTotal();
      if (total !== 100) return;
      // Re-score locally with the new weights
      refreshVDFScoresFromWeights();
    }
  });

  vdfSettingsPanelEl = panel;
  return panel;
}

function toggleVDFSettingsPanel(): void {
  if (!vdfSettingsPanelEl) return;
  const isHidden = vdfSettingsPanelEl.style.display === 'none';
  vdfSettingsPanelEl.style.display = isHidden ? 'block' : 'none';
}

function refreshVDFScoresFromWeights(): void {
  // Re-render everything with recomputed scores from new weights
  const ticker = currentChartTicker || '';
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = `${ticker}|${today}`;
  const entry = vdfResultCache.get(cacheKey);
  if (!entry) return;
  // Update all VDF UI: analysis panel, button score, and zone overlays
  renderVDFAnalysisPanel(entry);
  updateVDFButton(entry);
  renderVDZones(entry);
}

function formatVDFDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function vdfScoreTier(score: number): string {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Moderate';
  if (score >= 40) return 'Weak';
  return 'Marginal';
}

function vdfScoreColor(score: number): string {
  if (score >= 80) return '#26a69a';
  if (score >= 60) return '#8bc34a';
  return '#c9d1d9';
}

function vdfProximityColor(level: string): string {
  if (level === 'imminent') return '#f44336';
  if (level === 'high') return '#ff9800';
  if (level === 'elevated') return '#ffc107';
  return '#8b949e';
}

function ensureVDFAnalysisPanel(): HTMLDivElement {
  if (vdfAnalysisPanelEl) return vdfAnalysisPanelEl;
  const chartContent = document.getElementById('chart-content');
  if (!chartContent) return document.createElement('div');
  const panel = document.createElement('div');
  panel.id = 'vdf-analysis-panel';
  panel.style.cssText = 'width:100%;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;overflow:hidden;display:none;';
  chartContent.appendChild(panel);
  vdfAnalysisPanelEl = panel;
  return panel;
}

function toggleVDFAnalysisPanel(): void {
  if (!vdfAnalysisPanelEl) return;
  const body = vdfAnalysisPanelEl.querySelector('.vdf-ap-body') as HTMLElement | null;
  if (!body) return;
  const isCollapsed = body.style.display === 'none';
  body.style.display = isCollapsed ? 'block' : 'none';
  const chevron = vdfAnalysisPanelEl.querySelector('.vdf-ap-chevron') as HTMLElement | null;
  if (chevron) chevron.textContent = isCollapsed ? '\u25be' : '\u25b8';
  try { localStorage.setItem('chart_vdf_panel_collapsed', isCollapsed ? '0' : '1'); } catch { /* */ }
}

function buildComponentBarsHtml(components: Record<string, number>): string {
  return getVDFComponentLabels().map(([key, label, weight]: [string, string, string]) => {
    const val = Number(components[key]) || 0;
    const pct = Math.max(0, Math.min(100, Math.round(val * 100)));
    const barColor = val >= 0.7 ? '#26a69a' : val >= 0.4 ? '#8bc34a' : '#484f58';
    return `<div style="display:grid;grid-template-columns:130px 1fr 36px;gap:6px;align-items:center;margin:2px 0;">
      <span style="color:#8b949e;font-size:11px;white-space:nowrap;">${escapeHtml(label)} (${weight})</span>
      <div style="height:4px;background:#21262d;border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;"></div>
      </div>
      <span style="color:#c9d1d9;font-size:11px;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;text-align:right;">${val.toFixed(2)}</span>
    </div>`;
  }).join('');
}

function buildZoneHtml(zone: VDFZone, index: number, isBest: boolean): string {
  const recomputed = recomputeVDFZoneScore(zone);
  const scoreInt = Math.round(recomputed * 100);
  const serverScoreInt = Math.round(zone.score * 100);
  const isCustomWeights = !VDF_COMPONENTS.every(c => vdfWeights[c.key] === c.defaultWeight);
  const label = isBest ? `Zone ${index + 1} (Primary)` : `Zone ${index + 1}`;
  const color = vdfScoreColor(scoreInt);

  let metricsLine = '';
  const parts: string[] = [];
  if (zone.overallPriceChange != null) parts.push(`Price: ${zone.overallPriceChange >= 0 ? '+' : ''}${zone.overallPriceChange.toFixed(1)}%`);
  if (zone.netDeltaPct != null) parts.push(`Net Delta: ${zone.netDeltaPct >= 0 ? '+' : ''}${zone.netDeltaPct.toFixed(1)}%`);
  if (zone.absorptionPct != null) parts.push(`Absorption: ${zone.absorptionPct.toFixed(1)}%`);
  if (parts.length) metricsLine = `<div style="margin:4px 0;color:#8b949e;font-size:12px;">${parts.join(' &nbsp;|&nbsp; ')}</div>`;

  let detailLine = '';
  const dParts: string[] = [];
  if (zone.accumWeeks != null && zone.weeks) dParts.push(`Accum weeks: ${zone.accumWeeks}/${zone.weeks} (${Math.round((zone.accumWeeks / zone.weeks) * 100)}%)`);
  if (zone.durationMultiplier != null) dParts.push(`Duration: ${zone.durationMultiplier.toFixed(3)}x`);
  if (zone.concordancePenalty != null && zone.concordancePenalty < 1.0) dParts.push(`Concordance: ${zone.concordancePenalty.toFixed(3)}x`);
  if (dParts.length) detailLine = `<div style="margin:2px 0;color:#8b949e;font-size:12px;">${dParts.join(' &nbsp;|&nbsp; ')}</div>`;

  let componentsHtml = '';
  if (zone.components) {
    componentsHtml = `<div style="margin-top:8px;"><div style="color:#8b949e;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Components</div>${buildComponentBarsHtml(zone.components as unknown as Record<string, number>)}</div>`;
  }

  // Show server vs local score difference when custom weights are active
  const scoreDiffHtml = isCustomWeights && serverScoreInt !== scoreInt
    ? `<span style="font-size:10px;color:#484f58;margin-left:4px;" title="Server score with default weights">(was ${serverScoreInt})</span>`
    : '';

  return `<div style="background:#161b22;border:1px solid #21262d;border-radius:4px;padding:12px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-weight:600;font-size:13px;color:#c9d1d9;">${escapeHtml(label)}</span>
      <span><span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${color};">${scoreInt}</span>${scoreDiffHtml}</span>
    </div>
    <div style="color:#c9d1d9;font-size:12px;">${formatVDFDate(zone.startDate)} \u2192 ${formatVDFDate(zone.endDate)} (${zone.windowDays} trading days${zone.weeks ? `, ${zone.weeks} wk` : ''})</div>
    ${metricsLine}
    ${detailLine}
    ${componentsHtml}
  </div>`;
}

function buildDistributionHtml(dist: VDFDistribution, index: number): string {
  let detail = '';
  const parts: string[] = [];
  if (dist.priceChangePct != null) parts.push(`Price ${dist.priceChangePct >= 0 ? '+' : ''}${dist.priceChangePct.toFixed(1)}%`);
  if (dist.netDeltaPct != null) parts.push(`Delta ${dist.netDeltaPct >= 0 ? '+' : ''}${dist.netDeltaPct.toFixed(1)}%`);
  if (parts.length) detail = parts.join(' while ') + ' \u2014 selling into strength.';

  return `<div style="background:rgba(239,83,80,0.06);border:1px solid rgba(239,83,80,0.2);border-radius:4px;padding:10px 12px;margin-bottom:8px;">
    <div style="font-weight:600;font-size:12px;color:#ef5350;margin-bottom:2px;">Cluster ${index + 1}: ${formatVDFDate(dist.startDate)} \u2192 ${formatVDFDate(dist.endDate)} (${dist.spanDays} days)</div>
    ${detail ? `<div style="color:#8b949e;font-size:12px;">${escapeHtml(detail)}</div>` : ''}
  </div>`;
}

function buildProximityHtml(prox: VDFProximity): string {
  if (prox.level === 'none' && prox.compositeScore === 0) return '';
  const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
  const levelColor = vdfProximityColor(prox.level);

  const signalRows = prox.signals.map(sig =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:12px;">
      <span style="color:#c9d1d9;">\u2713 ${escapeHtml(sig.detail)}</span>
      <span style="color:${levelColor};font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-weight:600;white-space:nowrap;margin-left:12px;">+${sig.points}</span>
    </div>`
  ).join('');

  return `<div style="margin-top:4px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${levelColor};">${prox.compositeScore} pts</span>
      <span style="font-size:11px;font-weight:600;color:${levelColor};border:1px solid ${levelColor};border-radius:3px;padding:0 5px;line-height:16px;">${levelLabel}</span>
    </div>
    ${signalRows}
  </div>`;
}

function renderVDFAnalysisPanel(entry: VDFCacheEntry | null): void {
  loadVDFWeightsFromStorage();
  const panel = ensureVDFAnalysisPanel();
  if (!entry) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  const ticker = currentChartTicker || '';
  // Use best zone recomputed score for the header
  const bestZone = entry.zones[0];
  const recomputedBestScore = bestZone ? Math.round(recomputeVDFZoneScore(bestZone) * 100) : 0;
  const score = entry.is_detected ? recomputedBestScore : Math.round(entry.composite_score * 100);
  const tier = vdfScoreTier(score);
  const color = vdfScoreColor(score);
  const metrics = entry.details?.metrics;
  const isCustomWeights = !VDF_COMPONENTS.every(c => vdfWeights[c.key] === c.defaultWeight);

  let collapsed = true;
  try { collapsed = localStorage.getItem('chart_vdf_panel_collapsed') !== '0'; } catch { /* */ }
  // Auto-expand when accumulation is detected
  if (entry.is_detected && !localStorage.getItem('chart_vdf_panel_collapsed')) collapsed = false;

  const chevron = collapsed ? '\u25b8' : '\u25be';
  const bodyDisplay = collapsed ? 'none' : 'block';

  // Gear icon for settings
  const gearColor = isCustomWeights ? '#26a69a' : '#484f58';
  const gearHtml = `<span class="vdf-ap-gear" style="font-size:14px;color:${gearColor};cursor:pointer;margin-right:8px;padding:2px 4px;" title="VDF scoring weights">\u2699</span>`;

  // Header
  const headerHtml = `<div class="vdf-ap-header" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none;border-bottom:1px solid #21262d;">
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="vdf-ap-chevron" style="font-size:12px;color:#8b949e;width:12px;">${chevron}</span>
      <span style="font-weight:600;color:#c9d1d9;">VD Analysis</span>
      <span style="color:#8b949e;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:12px;">${escapeHtml(ticker)}</span>
    </div>
    <div style="display:flex;align-items:center;">
      ${gearHtml}
      ${entry.is_detected
        ? `<span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${color};">${score}</span>`
        : `<span style="font-size:11px;color:#484f58;">Not detected</span>`}
    </div>
  </div>`;

  // Body
  let bodyHtml = '';

  if (!entry.is_detected) {
    // Not detected — brief message
    let scanInfo = '';
    if (metrics?.scanStart && metrics?.scanEnd) {
      scanInfo = ` Scan: ${formatVDFDate(metrics.scanStart)} \u2192 ${formatVDFDate(metrics.scanEnd)}`;
      if (metrics.totalDays) scanInfo += ` (${metrics.totalDays} trading days)`;
      scanInfo += '.';
    }
    bodyHtml = `<div style="padding:14px;color:#8b949e;font-size:13px;">No accumulation patterns detected in the scan period.${scanInfo}</div>`;
  } else {
    // Assessment section
    const zoneCount = entry.zones.length;
    let assessParts = `Volume-delta accumulation <span style="color:${color};font-weight:600;">${tier}</span> (score: ${score}).`;
    assessParts += ` ${zoneCount} accumulation zone${zoneCount !== 1 ? 's' : ''} detected`;
    if (entry.weeks) assessParts += ` spanning up to ${entry.weeks} weeks`;
    assessParts += '.';
    if (metrics?.scanStart && metrics?.scanEnd) {
      assessParts += ` Scan: ${formatVDFDate(metrics.scanStart)} \u2192 ${formatVDFDate(metrics.scanEnd)}`;
      if (metrics.totalDays) assessParts += ` (${metrics.totalDays} trading days)`;
      assessParts += '.';
    }
    if (entry.distribution.length > 0) {
      assessParts += ` <span style="color:#ef5350;">${entry.distribution.length} distribution cluster${entry.distribution.length !== 1 ? 's' : ''}</span> also found.`;
    }

    const assessHtml = `<div style="margin-bottom:16px;font-size:13px;color:#c9d1d9;">${assessParts}</div>`;

    // Chart legend
    const swatchStyle = 'display:inline-block;width:14px;height:5px;border-radius:1px;vertical-align:middle;margin-right:5px;';
    const dashStyle = 'display:inline-block;width:14px;height:0;border-top:1px dashed;vertical-align:middle;margin-right:5px;';
    const glowStyle = 'display:inline-block;width:3px;height:12px;border-radius:1px;vertical-align:middle;margin-right:5px;';
    const legendItems: string[] = [];
    legendItems.push(`<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(38,166,154,0.7);"></span>Accumulation</span>`);
    if (entry.distribution.length > 0) {
      legendItems.push(`<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(239,83,80,0.65);"></span>Distribution</span>`);
    }
    const hasAbsorption = entry.zones.some(z => (z.absorptionPct || 0) >= 5);
    if (hasAbsorption) {
      legendItems.push(`<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(255,167,38,0.7);"></span>Absorption</span>`);
    }
    legendItems.push(`<span style="white-space:nowrap;"><span style="${dashStyle}border-color:rgba(38,166,154,0.4);"></span>Zone bounds</span>`);
    const proxLegend = entry.proximity;
    if (proxLegend && proxLegend.level !== 'none' && proxLegend.compositeScore > 0) {
      const plc = vdfProximityColor(proxLegend.level);
      legendItems.push(`<span style="white-space:nowrap;"><span style="${glowStyle}background:${plc};box-shadow:0 0 4px ${plc};"></span>Proximity</span>`);
    }
    const legendHtml = `<div style="display:flex;flex-wrap:wrap;gap:12px 16px;padding:8px 12px;background:#161b22;border:1px solid #21262d;border-radius:4px;margin-bottom:16px;font-size:11px;color:#8b949e;">${legendItems.join('')}</div>`;

    // Zones section
    const sectionStyle = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e;margin:16px 0 8px;border-bottom:1px solid #21262d;padding-bottom:4px;';
    let zonesHtml = '';
    if (entry.zones.length > 0) {
      zonesHtml = `<div style="${sectionStyle}">Accumulation Zones</div>`;
      zonesHtml += entry.zones.map((z, i) => buildZoneHtml(z, i, i === 0)).join('');
    }

    // Distribution section
    let distHtml = '';
    if (entry.distribution.length > 0) {
      distHtml = `<div style="${sectionStyle}">Distribution Clusters</div>`;
      distHtml += entry.distribution.map((d, i) => buildDistributionHtml(d, i)).join('');
    }

    // Proximity section
    let proxHtml = '';
    const prox = entry.proximity;
    if (prox && (prox.level !== 'none' || prox.compositeScore > 0)) {
      const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
      proxHtml = `<div style="${sectionStyle}">Proximity Signals (${prox.compositeScore} pts \u2014 ${levelLabel})</div>`;
      proxHtml += buildProximityHtml(prox);
    }

    bodyHtml = `<div style="padding:14px;">${assessHtml}${legendHtml}${zonesHtml}${distHtml}${proxHtml}</div>`;
  }

  panel.innerHTML = `${headerHtml}<div class="vdf-ap-body" style="display:${bodyDisplay};">${bodyHtml}</div>`;
  panel.style.display = 'block';

  // Insert settings panel into body (right after the header, before content)
  const body = panel.querySelector('.vdf-ap-body') as HTMLElement | null;
  if (body) {
    const settingsPanel = createVDFSettingsPanel();
    body.insertBefore(settingsPanel, body.firstChild);
  }

  // Bind header click for toggle (but not on gear)
  const header = panel.querySelector('.vdf-ap-header');
  if (header) {
    header.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.vdf-ap-gear')) return; // Don't toggle when clicking gear
      toggleVDFAnalysisPanel();
    });
  }

  // Bind gear click for settings toggle
  const gear = panel.querySelector('.vdf-ap-gear');
  if (gear) {
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVDFSettingsPanel();
    });
  }
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
  const configuredNeutral = String(volumeDeltaSettings.neutralDivergentColor || '').trim().toLowerCase();
  const convergentColor = configuredNeutral === '#c9d1d9'
    ? DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor
    : (volumeDeltaSettings.neutralDivergentColor || DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor);

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
      color: bodyColor
    };
  });

  candleSeries.setData(barsWithBodyColor);
}

function normalizeCandleBars(bars: any[]): any[] {
  return bars.filter((bar) => (
    bar &&
    (typeof bar.time === 'string' || typeof bar.time === 'number') &&
    Number.isFinite(Number(bar.open)) &&
    Number.isFinite(Number(bar.high)) &&
    Number.isFinite(Number(bar.low)) &&
    Number.isFinite(Number(bar.close))
  ));
}

function applyChartSizes(
  chartContainer: HTMLElement,
  volumeDeltaRsiContainer: HTMLElement,
  rsiContainer: HTMLElement,
  volumeDeltaContainer: HTMLElement
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
  volumeDeltaContainer: HTMLElement
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
  volumeDeltaContainer: HTMLElement
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
  volumeDeltaContainer: HTMLElement
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

function showLoadingOverlay(container: HTMLElement): void {
  // Remove existing overlay if present
  const existingOverlay = container.querySelector('.chart-loading-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  // Create loading overlay
  const overlay = document.createElement('div');
  overlay.className = 'chart-loading-overlay';
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(13, 17, 23, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: none;
  `;

  // Create loading spinner
  const spinner = document.createElement('div');
  spinner.innerHTML = `
    <svg width="40" height="40" viewBox="0 0 40 40" style="animation: spin 1s linear infinite;">
      <circle cx="20" cy="20" r="16" fill="none" stroke="#58a6ff" stroke-width="3"
              stroke-dasharray="80" stroke-dashoffset="60" stroke-linecap="round" opacity="0.8"/>
    </svg>
    <style>
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  `;

  overlay.appendChild(spinner);
  container.appendChild(overlay);
}

function showRetryOverlay(container: HTMLElement, onRetry: () => void): void {
  const existingOverlay = container.querySelector('.chart-loading-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const overlay = document.createElement('div');
  overlay.className = 'chart-loading-overlay';
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(13, 17, 23, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: auto;
  `;

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.textContent = 'Try Refreshing';
  retryBtn.style.background = '#161b22';
  retryBtn.style.color = '#c9d1d9';
  retryBtn.style.border = '1px solid #30363d';
  retryBtn.style.borderRadius = '6px';
  retryBtn.style.padding = '8px 12px';
  retryBtn.style.fontSize = '12px';
  retryBtn.style.fontWeight = '600';
  retryBtn.style.cursor = 'pointer';
  retryBtn.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
  retryBtn.addEventListener('click', (event) => {
    event.preventDefault();
    onRetry();
  });

  overlay.appendChild(retryBtn);
  container.appendChild(overlay);
}

function hideLoadingOverlay(container: HTMLElement): void {
  const overlay = container.querySelector('.chart-loading-overlay');
  if (overlay) {
    overlay.remove();
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
    ...fetchedLast
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
      Number.isFinite(latestClose) ? { time: lastTime, close: latestClose } : undefined
    );
    if (!updated) return false;
  }

  const latestVdRsi = Number(data.latestVolumeDeltaRsi?.value);
  if (Number.isFinite(latestVdRsi)) {
    const normalizedVdRsi = normalizeVolumeDeltaValue(Number(latestVdRsi));
    volumeDeltaRsiByTime.set(lastKey, normalizedVdRsi);
    if (volumeDeltaRsiPoints.length > 0 && timeKey(volumeDeltaRsiPoints[volumeDeltaRsiPoints.length - 1].time) === lastKey) {
      volumeDeltaRsiPoints[volumeDeltaRsiPoints.length - 1] = {
        ...volumeDeltaRsiPoints[volumeDeltaRsiPoints.length - 1],
        value: normalizedVdRsi
      };
    }
    volumeDeltaRsiSeries.update({
      time: lastTime,
      value: normalizedVdRsi
    });
  }

  const latestDelta = Number(data.latestVolumeDelta?.delta);
  if (Number.isFinite(latestDelta)) {
    const numericDelta = Number(latestDelta);
    volumeDeltaByTime.set(lastKey, numericDelta);
    volumeDeltaHistogramSeries.update({
      time: lastTime,
      value: numericDelta,
      color: numericDelta >= 0 ? VOLUME_DELTA_POSITIVE_COLOR : VOLUME_DELTA_NEGATIVE_COLOR
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
    }
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
  volumeDeltaContainer: HTMLElement
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
  priceByTime = new Map(
    bars.map((bar) => [timeKey(bar.time), Number(bar.close)])
  );
  rsiByTime = new Map(
    rsiData
      .filter((point) => Number.isFinite(Number(point.value)))
      .map((point) => [timeKey(point.time), Number(point.value)])
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
      }
    });
    applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    applyPaneScaleVisibilityByPosition();
  } else if (rsiChart) {
    rsiChart.setData(rsiData, bars.map((b) => ({ time: b.time, close: b.close })));
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
    refreshLatestChartDataInPlace(scheduledTicker, scheduledInterval)
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
    try { prefetchAbortController.abort(); } catch { /* ignore */ }
    prefetchAbortController = null;
  }
}

export function cancelChartLoading(): void {
  if (chartFetchAbortController) {
    try { chartFetchAbortController.abort(); } catch { /* ignore */ }
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
  options: RenderCustomChartOptions = {}
) {
  const silent = options.silent === true;
  ensureSettingsLoadedFromStorage();
  const previousTicker = currentChartTicker;
  const previousInterval = currentChartInterval;
  const requestId = ++latestRenderRequestId;
  const contextChanged = (
    typeof previousTicker === 'string' &&
    (previousTicker !== ticker || previousInterval !== interval)
  );
  const shouldApplyWeeklyDefaultRange = interval === '1week' && (
    typeof previousTicker !== 'string' || contextChanged
  );
  currentChartInterval = interval;
  currentChartTicker = ticker;
  const cacheKey = buildChartDataCacheKey(ticker, interval);

  if (contextChanged) {
    rsiDivergencePlotSelected = false;
    volumeDeltaRsiDivergencePlotSelected = false;
    rsiDivergencePlotStartIndex = null;
    volumeDeltaRsiDivergencePlotStartIndex = null;
    rsiDivergencePlotToolActive = false;
    volumeDeltaRsiDivergencePlotToolActive = false;
    volumeDeltaDivergenceToolActive = false;
    rsiDivergenceToolActive = false;
    hideDivergenceOverlay('rsi');
    hideDivergenceOverlay('volumeDeltaRsi');
    // Re-bind chart sync on next setupChartSync call since charts may be recreated.
    isChartSyncBound = false;
    crosshairHidden = false;
    if (vdfAnalysisPanelEl) { vdfAnalysisPanelEl.style.display = 'none'; vdfAnalysisPanelEl.innerHTML = ''; }
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
      volumeDeltaContainer as HTMLElement
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
      }
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
        volumeDeltaContainer as HTMLElement
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
  } catch (err: any) {
    if (requestId !== latestRenderRequestId) return;
    if (err?.name === 'AbortError') return;

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
      volumeDeltaRsiPoints = [];
      volumeDeltaIndexByTime = new Map();
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
      renderVDFAnalysisPanel(null);
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
  const direct = Number(valuesByTime.get(timeKey(time)));
  if (Number.isFinite(direct)) return direct;
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
    if (Number.isFinite(candidate)) return candidate;
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

  const syncRangeFromOwner = (
    owner: 'price' | 'volumeDeltaRsi' | 'rsi' | 'volumeDelta',
    timeRange: any
  ) => {
    if (!timeRange) return;
    const targets: Array<{ owner: 'price' | 'volumeDeltaRsi' | 'rsi' | 'volumeDelta'; chart: any }> = [
      { owner: 'price', chart: priceChart },
      { owner: 'volumeDeltaRsi', chart: volumeDeltaRsiChartInstance },
      { owner: 'rsi', chart: rsiChartInstance },
      { owner: 'volumeDelta', chart: volumeDeltaChartInstance }
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
    if (volumeDeltaSuppressSync) return;
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
    const mappedPrice = getNearestMappedValueAtOrBefore(time, priceByTime);
    if (Number.isFinite(mappedPrice) && candleSeries) {
      try {
        priceChart.setCrosshairPosition(Number(mappedPrice), time, candleSeries);
      } catch {
        priceChart.clearCrosshairPosition();
      }
    } else {
      priceChart.clearCrosshairPosition();
    }
  };

  const setCrosshairOnVolumeDeltaRsi = (time: string | number) => {
    const mappedVdRsi = getNearestMappedValueAtOrBefore(time, volumeDeltaRsiByTime);
    if (Number.isFinite(mappedVdRsi)) {
      try {
        volumeDeltaRsiChartInstance.setCrosshairPosition(Number(mappedVdRsi), time, volumeDeltaRsiSeries);
      } catch {
        volumeDeltaRsiChartInstance.clearCrosshairPosition();
      }
    } else {
      volumeDeltaRsiChartInstance.clearCrosshairPosition();
    }
  };

  const setCrosshairOnRsi = (time: string | number) => {
    const mappedRsi = getNearestMappedValueAtOrBefore(time, rsiByTime);
    const rsiSeries = rsiChart?.getSeries();
    if (Number.isFinite(mappedRsi) && rsiSeries) {
      try {
        rsiChartInstance.setCrosshairPosition(Number(mappedRsi), time, rsiSeries);
      } catch {
        rsiChartInstance.clearCrosshairPosition();
      }
    } else {
      rsiChartInstance.clearCrosshairPosition();
    }
  };

  const setCrosshairOnVolumeDelta = (time: string | number) => {
    const mappedVd = getNearestMappedValueAtOrBefore(time, volumeDeltaByTime);
    if (Number.isFinite(mappedVd)) {
      try {
        volumeDeltaChartInstance.setCrosshairPosition(Number(mappedVd), time, volumeDeltaHistogramSeries);
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
    if (volumeDeltaRsiDivergencePlotToolActive) {
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
    if (rsiDivergencePlotToolActive) {
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
    if (!rsiDivergencePlotToolActive) return;
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
  controls.querySelectorAll('button[data-interval]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const interval = target.getAttribute('data-interval') as ChartInterval;
      if (!interval) return;

      // Update active state
      controls.querySelectorAll('button[data-interval]').forEach(b => b.classList.remove('active'));
      target.classList.add('active');

      if (currentChartTicker) {
        scheduleIntervalChartRender(interval);
      }
    });
  });

  // RSI Display Mode
  controls.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const mode = target.getAttribute('data-mode') as any;
      if (!mode) return;

      controls.querySelectorAll('button[data-mode]').forEach(b => b.classList.remove('active'));
      target.classList.add('active');

      if (rsiChart) {
        rsiChart.setDisplayMode(mode);
      }
    });
  });

  // Fullscreen toggle
  initChartFullscreen();
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

import { getTickerListContext, getTickerOriginView } from './main';

function initChartFullscreen(): void {
  const btn = document.getElementById('chart-fullscreen-btn');
  const container = document.getElementById('custom-chart-container');
  const navPrevBtn = document.getElementById('chart-nav-prev');
  const navNextBtn = document.getElementById('chart-nav-next');
  
  if (!btn || !container) return;

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
    btn.title = isActive ? 'Exit fullscreen (Space)' : 'Fullscreen (Space)';
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

function navigateChart(direction: -1 | 1): void {
    const context = getTickerListContext();
    const origin = getTickerOriginView();
    const currentTicker = document.getElementById('ticker-view')?.dataset.ticker;

    if (!context || !currentTicker) return;

    let containerId = '';
    if (origin === 'divergence') {
        containerId = context === 'daily' ? 'divergence-daily-container' : 'divergence-weekly-container';
    } else {
        containerId = context === 'daily' ? 'daily-container' : 'weekly-container';
    }

    const container = document.getElementById(containerId);
    if (!container) return;

    const cards = Array.from(container.querySelectorAll('.alert-card')) as HTMLElement[];
    const currentIndex = cards.findIndex(c => c.dataset.ticker === currentTicker);

    if (currentIndex === -1) return;

    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < cards.length) {
        const nextCard = cards[nextIndex];
        const nextTicker = nextCard.dataset.ticker;
        if (nextTicker && window.showTickerView) {
            // Keep the same context
            window.showTickerView(nextTicker, origin, context);
        }
    }
}

function initPaneAxisNavigation(): void {
    const container = document.getElementById('custom-chart-container');
    if (!container) return;

    container.addEventListener('dblclick', (e) => {
        // e.target might be the canvas or a wrapper
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;

        // Check if click is on the right side (Y-axis area)
        // Assume Y-axis width is roughly 60px
        const isRightSide = x > rect.width - 60;
        if (!isRightSide) return;

        // Determine which pane was clicked
        // We need to find the DOM elements for the panes in current order
        const currentOrder = normalizePaneOrder(paneOrder);
        const pane3Id = currentOrder[2]; // 3rd pane
        const pane4Id = currentOrder[3]; // 4th pane

        const getPaneRect = (id: string) => {
            const el = document.getElementById(id);
            if (!el || el.style.display === 'none') return null;
            // The pane element itself might be relative to chart content
            return el.getBoundingClientRect();
        };

        // Check 3rd Pane -> Next (Right)
        const pane3Rect = getPaneRect(pane3Id);
        if (pane3Rect && e.clientY >= pane3Rect.top && e.clientY <= pane3Rect.bottom) {
             navigateChart(1);
             return;
        }

        // Check 4th Pane -> Prev (Left)
        const pane4Rect = getPaneRect(pane4Id);
        if (pane4Rect && e.clientY >= pane4Rect.top && e.clientY <= pane4Rect.bottom) {
             navigateChart(-1);
             return;
        }
    });
}

function getNeighborTicker(direction: -1 | 1): string | null {
    const context = getTickerListContext();
    const origin = getTickerOriginView();
    const currentTicker = document.getElementById('ticker-view')?.dataset.ticker;

    if (!context || !currentTicker) return null;

    let containerId = '';
    if (origin === 'divergence') {
        containerId = context === 'daily' ? 'divergence-daily-container' : 'divergence-weekly-container';
    } else {
        containerId = context === 'daily' ? 'daily-container' : 'weekly-container';
    }

    const container = document.getElementById(containerId);
    if (!container) return null;

    const cards = Array.from(container.querySelectorAll('.alert-card')) as HTMLElement[];
    const currentIndex = cards.findIndex(c => c.dataset.ticker === currentTicker);

    if (currentIndex === -1) return null;

    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < cards.length) {
        return cards[nextIndex].dataset.ticker || null;
    }
    return null;
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
            signal
        })
        .then(data => setCachedChartData(cacheKey, data))
        .catch(() => {})
        .finally(() => chartPrefetchInFlight.delete(cacheKey));

        chartPrefetchInFlight.set(cacheKey, promise);
        return promise;
    };

    if (nextTicker) await fetchForTicker(nextTicker);
    if (prevTicker) await fetchForTicker(prevTicker);
}

export function refreshActiveTickerDivergenceSummary(options?: { noCache?: boolean }): void {
  if (!volumeDeltaPaneContainerEl) return;
  if (!Array.isArray(currentBars) || currentBars.length < 2) return;
  renderVolumeDeltaDivergenceSummary(volumeDeltaPaneContainerEl, currentBars, options);
}

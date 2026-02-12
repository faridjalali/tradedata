import { createChart, CrosshairMode } from 'lightweight-charts';
import { fetchChartData, ChartInterval, VolumeDeltaSourceInterval } from './chartApi';
import { RSIChart } from './rsi';

let currentChartTicker: string | null = null;
let currentChartInterval: ChartInterval = '4hour';
let priceChart: any = null;
let candleSeries: any = null;
let rsiChart: RSIChart | null = null;
let volumeDeltaRsiChart: any = null;
let volumeDeltaRsiSeries: any = null;
let volumeDeltaRsiMidlineLine: any = null;
let volumeDeltaChart: any = null;
let volumeDeltaHistogramSeries: any = null;
let volumeDeltaRsiPoints: Array<{ time: string | number, value: number }> = [];
let volumeDeltaIndexByTime = new Map<string, number>();
let volumeDeltaHighlightSeries: any = null;
let volumeDeltaTrendLineSeriesList: any[] = [];
let volumeDeltaDivergencePointTimeKeys = new Set<string>();
let volumeDeltaFirstPoint: { time: string | number, rsi: number, price: number, index: number } | null = null;
let volumeDeltaDivergenceToolActive = false;
let volumeDeltaSuppressSync = false;
let chartResizeObserver: ResizeObserver | null = null;
let isChartSyncBound = false;
let latestRenderRequestId = 0;
let pricePaneContainerEl: HTMLElement | null = null;
let priceByTime = new Map<string, number>();
let priceChangeByTime = new Map<string, number>();
let rsiByTime = new Map<string, number>();
let volumeDeltaRsiByTime = new Map<string, number>();
let volumeDeltaByTime = new Map<string, number>();
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
let hasLoadedSettingsFromStorage = false;
const TREND_ICON = '✎';
const RIGHT_MARGIN_BARS = 10;
const SCALE_LABEL_CHARS = 4;
const SCALE_MIN_WIDTH_PX = 56;
const INVALID_SYMBOL_MESSAGE = 'Invalid symbol';
const MONTH_GRIDLINE_COLOR = '#21262d';
const SETTINGS_ICON = '⚙';
const SETTINGS_STORAGE_KEY = 'custom_chart_settings_v1';
const TOP_PANE_TICKER_LABEL_CLASS = 'top-pane-ticker-label';
const TOP_PANE_BADGE_CLASS = 'top-pane-badge';
const TOP_PANE_BADGE_START_LEFT_PX = 38;
const TOP_PANE_BADGE_GAP_PX = 6;
const VOLUME_DELTA_RSI_COLOR = '#2962FF';
const VOLUME_DELTA_MIDLINE = 50;
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
  { value: '5min', label: '5 min' },
  { value: '15min', label: '15 min' },
  { value: '30min', label: '30 min' },
  { value: '1hour', label: '1 hour' },
  { value: '4hour', label: '4 hour' }
];

type MAType = 'SMA' | 'EMA';
type MASourceMode = 'daily' | 'timeframe';
type MidlineStyle = 'dotted' | 'solid';
type PaneId = 'price-chart-container' | 'vd-rsi-chart-container' | 'rsi-chart-container' | 'vd-chart-container';

interface MASetting {
  enabled: boolean;
  type: MAType;
  length: number;
  color: string;
  series: any | null;
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
  sourceInterval: '5min'
};

const DEFAULT_VOLUME_DELTA_SETTINGS: VolumeDeltaSettings = {
  sourceInterval: '5min'
};

const DEFAULT_PRICE_SETTINGS: {
  maSourceMode: MASourceMode;
  verticalGridlines: boolean;
  horizontalGridlines: boolean;
  ma: PersistedMASetting[];
} = {
  maSourceMode: 'daily',
  verticalGridlines: true,
  horizontalGridlines: false,
  ma: [
    { enabled: false, type: 'SMA', length: 20, color: '#ffa500' },
    { enabled: false, type: 'SMA', length: 50, color: '#8a2be2' },
    { enabled: false, type: 'SMA', length: 100, color: '#00bcd4' },
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
  ma: DEFAULT_PRICE_SETTINGS.ma.map((ma) => ({ ...ma, series: null }))
};

const MONTH_KEY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit'
});
const LA_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

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

function monthKeyInLA(unixSeconds: number): string {
  const parts = MONTH_KEY_FORMATTER.formatToParts(new Date(unixSeconds * 1000));
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
    const monthKey = monthKeyInLA(unixSeconds);
    if (monthKey !== lastMonthKey) {
      result.push(unixSeconds);
      lastMonthKey = monthKey;
    }
  }
  return result;
}

function dayKeyInLA(unixSeconds: number): string {
  return LA_DAY_FORMATTER.format(new Date(unixSeconds * 1000));
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
  const closes = bars.map((bar) => Number(bar.close)).filter((value) => Number.isFinite(value));
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
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(value));
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
        sourceInterval: volumeDeltaSettings.sourceInterval
      },
      volumeDeltaRsi: {
        length: volumeDeltaRsiSettings.length,
        lineColor: volumeDeltaRsiSettings.lineColor,
        midlineColor: volumeDeltaRsiSettings.midlineColor,
        midlineStyle: volumeDeltaRsiSettings.midlineStyle,
        sourceInterval: volumeDeltaRsiSettings.sourceInterval
      },
      paneOrder: [...paneOrder]
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
      if (source === '5min' || source === '15min' || source === '30min' || source === '1hour' || source === '4hour') {
        volumeDeltaSettings.sourceInterval = source;
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
      if (source === '5min' || source === '15min' || source === '30min' || source === '1hour' || source === '4hour') {
        volumeDeltaRsiSettings.sourceInterval = source;
      }
    }

    paneOrder = normalizePaneOrder(parsed?.paneOrder);
  } catch {
    // Ignore malformed storage content.
  }
}

function computeSMA(values: number[], length: number): Array<number | null> {
  const period = Math.max(1, Math.floor(length));
  const out: Array<number | null> = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    if (i >= period) {
      const drop = values[i - period];
      if (Number.isFinite(drop)) sum -= drop;
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
    const key = dayKeyInLA(unixSeconds);
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
    return dailyMAByKey.get(dayKeyInLA(unixSeconds)) ?? null;
  });
}

function computeEMA(values: number[], length: number): Array<number | null> {
  const period = Math.max(1, Math.floor(length));
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const alpha = 2 / (period + 1);
  let ema: number | null = null;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (ema === null) {
      ema = value;
    } else {
      ema = (value * alpha) + (ema * (1 - alpha));
    }
    out[i] = ema;
  }
  return out;
}

function clearMovingAverageSeries(): void {
  if (!priceChart) return;
  for (const setting of priceChartSettings.ma) {
    if (setting.series) {
      priceChart.removeSeries(setting.series);
      setting.series = null;
    }
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

    const maData = currentBars.map((bar, index) => {
      const value = values[index];
      if (!Number.isFinite(Number(value))) {
        return { time: bar.time };
      }
      return {
        time: bar.time,
        value: Number(value)
      };
    });
    setting.series.setData(maData);
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
  refreshMonthGridLines();
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
  if (source) source.value = volumeDeltaSettings.sourceInterval;
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
  const settingsBtn = container.querySelector('.pane-settings-btn') as HTMLElement | null;
  if (!settingsBtn) return TOP_PANE_BADGE_START_LEFT_PX;
  const computed = settingsBtn.offsetLeft + settingsBtn.offsetWidth + TOP_PANE_BADGE_GAP_PX;
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
    label.style.pointerEvents = 'none';
    topPane.appendChild(label);
  }

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

function shouldShowPaneScale(paneId: PaneId): boolean {
  const order = normalizePaneOrder(paneOrder);
  const index = order.indexOf(paneId);
  // Show only on pane positions 2 and 4.
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
  if (currentChartTicker) {
    renderCustomChart(currentChartTicker, currentChartInterval);
  }
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

function createSettingsButton(container: HTMLElement, pane: 'price' | 'volumeDelta' | 'volumeDeltaRsi' | 'rsi'): HTMLButtonElement {
  const existing = container.querySelector(`.pane-settings-btn[data-pane="${pane}"]`) as HTMLButtonElement | null;
  if (existing) return existing;
  const btn = document.createElement('button');
  btn.className = 'pane-settings-btn';
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
  btn.style.left = '8px';
  btn.style.top = '8px';
  btn.style.zIndex = '30';
  btn.style.width = '24px';
  btn.style.height = '24px';
  btn.style.borderRadius = '4px';
  btn.style.border = '1px solid #30363d';
  btn.style.background = '#161b22';
  btn.style.color = '#c9d1d9';
  btn.style.cursor = 'pointer';
  btn.style.padding = '0';
  container.appendChild(btn);
  return btn;
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
      <span>MA Source</span>
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
      refreshMonthGridLines();
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
      <span>Source TF</span>
      <select data-vd-setting="source-interval" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        ${VOLUME_DELTA_SOURCE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
      </select>
    </label>
  `;
  applyUniformSettingsPanelTypography(panel);

  panel.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;
    const setting = target.dataset.vdSetting || '';
    if (setting !== 'source-interval') return;
    const nextValue = String((target as HTMLSelectElement).value || '');
    if (nextValue !== '5min' && nextValue !== '15min' && nextValue !== '30min' && nextValue !== '1hour' && nextValue !== '4hour') return;
    volumeDeltaSettings.sourceInterval = nextValue;
    if (currentChartTicker) {
      renderCustomChart(currentChartTicker, currentChartInterval);
    }
    persistSettingsToStorage();
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
      <span>Source TF</span>
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
      if (nextValue !== '5min' && nextValue !== '15min' && nextValue !== '30min' && nextValue !== '1hour' && nextValue !== '4hour') return;
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
  const volumeDeltaRsiBtn = createSettingsButton(volumeDeltaRsiContainer, 'volumeDeltaRsi');
  const rsiBtn = createSettingsButton(rsiContainer, 'rsi');
  const volumeDeltaBtn = createSettingsButton(volumeDeltaContainer, 'volumeDelta');

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

  if (!document.body.dataset.chartSettingsBound) {
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.pane-settings-panel') || target.closest('.pane-settings-btn')) return;
      hideSettingsPanels();
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
    if (!Number.isFinite(currClose) || !Number.isFinite(prevClose)) continue;
    priceChangeByTime.set(timeKey(bars[i].time), currClose - prevClose);
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
  const delta = priceChangeByTime.get(targetKey);
  if (!Number.isFinite(delta)) {
    // If no previous candle exists for this crosshair candle (e.g., very first bar), hide label.
    changeEl.style.display = 'none';
    changeEl.textContent = '';
    layoutTopPaneBadges(container);
    return;
  }

  const sign = delta > 0 ? '+' : '';
  changeEl.textContent = `${sign}${delta.toFixed(2)}`;
  changeEl.style.color = delta > 0 ? '#26a69a' : delta < 0 ? '#ef5350' : '#c9d1d9';
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

function clearVolumeDeltaTrendLines(): void {
  if (!volumeDeltaRsiChart || volumeDeltaTrendLineSeriesList.length === 0) {
    volumeDeltaTrendLineSeriesList = [];
    return;
  }

  // Preserve viewport position before clearing
  const visibleRangeBeforeClear = volumeDeltaRsiChart.timeScale().getVisibleLogicalRange?.();

  try {
    for (const series of volumeDeltaTrendLineSeriesList) {
      try {
        volumeDeltaRsiChart.removeSeries(series);
      } catch {
        // Ignore stale trendline series remove errors.
      }
    }
    volumeDeltaTrendLineSeriesList = [];
  } finally {
    // Restore viewport to prevent chart jump
    if (visibleRangeBeforeClear) {
      try {
        volumeDeltaRsiChart.timeScale().setVisibleLogicalRange(visibleRangeBeforeClear);
      } catch {
        // Keep the current viewport stable after clearing
      }
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

function clearVolumeDeltaDivergence(): void {
  clearVolumeDeltaDivergenceState();
  clearVolumeDeltaTrendLines();
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
  value2: number
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

  if (!volumeDeltaFirstPoint) {
    volumeDeltaFirstPoint = {
      time: clickedTime,
      rsi: clickedRSI,
      price: Number(clickedPrice),
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

      const bearishDivergence = currentRSI < clickedRSI && Number(currentPrice) > clickedPrice;
      const bullishDivergence = currentRSI > clickedRSI && Number(currentPrice) < clickedPrice;
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
  rsiChart?.deactivateDivergenceTool();

  const trendBtn = document.querySelector('#drawing-tools button[data-tool="trend"]') as HTMLElement | null;
  if (trendBtn) {
    trendBtn.classList.remove('active');
    trendBtn.innerHTML = TREND_ICON;
  }
}

function sameLogicalRange(a: any, b: any): boolean {
  if (!a || !b) return false;
  return Math.abs(Number(a.from) - Number(b.from)) < 1e-6 && Math.abs(Number(a.to) - Number(b.to)) < 1e-6;
}

// Create price chart
function createPriceChart(container: HTMLElement) {
  const isMobileTouch = (
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) ||
    (typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0))
  );

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
      mode: CrosshairMode.Normal,
    },
    handleScroll: {
      pressedMouseMove: true,
      horzTouchDrag: true,
      // Required for touch-based price-axis drag on mobile.
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
      borderVisible: false,
      fixRightEdge: false,
      rightBarStaysOnScroll: false,
      rightOffset: RIGHT_MARGIN_BARS,
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

  // No line tools for price chart - divergence tool only on RSI chart

  return { chart, series };
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
      mode: CrosshairMode.Normal,
    },
    handleScroll: {
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
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
    if (!volumeDeltaDivergenceToolActive) return;
    detectAndHandleVolumeDeltaDivergenceClick(param.time);
  });

  return { chart, rsiSeries };
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
      mode: CrosshairMode.Normal,
    },
    handleScroll: {
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
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
    },
  });

  const histogramSeries = chart.addHistogramSeries({
    base: 0,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    priceFormat: {
      type: 'custom',
      minMove: 1,
      formatter: (value: number) => formatVolumeDeltaHistogramScaleLabel(Number(value)),
    },
  });

  histogramSeries.createPriceLine({
    price: 0,
    color: '#8b949e',
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: false,
    title: '',
  });

  return { chart, histogramSeries };
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
  }
  if (volumeDeltaChart) {
    volumeDeltaChart.applyOptions({ width: volumeDeltaWidth, height: volumeDeltaHeight });
  }
  refreshMonthGridLines();
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

function hideLoadingOverlay(container: HTMLElement): void {
  const overlay = container.querySelector('.chart-loading-overlay');
  if (overlay) {
    overlay.remove();
  }
}

export async function renderCustomChart(ticker: string, interval: ChartInterval = currentChartInterval) {
  ensureSettingsLoadedFromStorage();
  const requestId = ++latestRenderRequestId;
  currentChartInterval = interval;
  currentChartTicker = ticker;

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

  // Clear error
  errorContainer.style.display = 'none';
  errorContainer.textContent = '';
  setPricePaneMessage(chartContainer, null);
  ensureMonthGridOverlay(chartContainer, 'price');
  ensureMonthGridOverlay(volumeDeltaRsiContainer, 'volumeDeltaRsi');
  ensureMonthGridOverlay(rsiContainer, 'rsi');
  ensureMonthGridOverlay(volumeDeltaContainer, 'volumeDelta');
  ensureSettingsUI(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  syncTopPaneTickerLabel();

  // Initialize charts if needed
  if (!priceChart) {
    const { chart, series } = createPriceChart(chartContainer);
    priceChart = chart;
    candleSeries = series;
    applyPriceGridOptions();
  }
  if (!volumeDeltaRsiChart) {
    const { chart, rsiSeries } = createVolumeDeltaRsiChart(volumeDeltaRsiContainer);
    volumeDeltaRsiChart = chart;
    volumeDeltaRsiSeries = rsiSeries;
    applyVolumeDeltaRSIVisualSettings();
  }
  if (!volumeDeltaChart) {
    const { chart, histogramSeries } = createVolumeDeltaChart(volumeDeltaContainer);
    volumeDeltaChart = chart;
    volumeDeltaHistogramSeries = histogramSeries;
  }

  ensureResizeObserver(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
  applyPaneScaleVisibilityByPosition();

  // Show loading indicators on all chart panes
  showLoadingOverlay(chartContainer);
  showLoadingOverlay(volumeDeltaRsiContainer);
  showLoadingOverlay(rsiContainer);
  showLoadingOverlay(volumeDeltaContainer);

  try {
    // Fetch data from API
    const data = await fetchChartData(ticker, interval, {
      vdRsiLength: volumeDeltaRsiSettings.length,
      vdSourceInterval: volumeDeltaSettings.sourceInterval,
      vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval
    });
    if (requestId !== latestRenderRequestId) return;

    // Retrieve bars and RSI directly (backend handles aggregation)
    const bars = normalizeCandleBars(data.bars || []);
    if (bars.length === 0) {
      throw new Error('No valid chart bars returned for this ticker/interval');
    }
    monthBoundaryTimes = buildMonthBoundaryTimes(bars);
    const rsiData = buildRSISeriesFromBars(bars, rsiSettings.length);
    const volumeDeltaRsiData = {
      rsi: normalizeValueSeries(data.volumeDeltaRsi?.rsi || []),
    };
    const volumeDeltaData = normalizeVolumeDeltaSeries(data.volumeDelta || []);
    currentBars = bars;
    rebuildPricePaneChangeMap(bars);
    priceByTime = new Map(
      bars.map((bar) => [timeKey(bar.time), Number(bar.close)])
    );
    rsiByTime = new Map(
      rsiData
        .filter((point) => Number.isFinite(Number(point.value)))
        .map((point) => [timeKey(point.time), Number(point.value)])
    );

    // Update price chart
    if (candleSeries) {
      candleSeries.setData(bars);
    }
    setPricePaneChange(chartContainer, null);
    setVolumeDeltaRsiData(bars, volumeDeltaRsiData);
    setVolumeDeltaHistogramData(bars, volumeDeltaData);
    applyVolumeDeltaRSIVisualSettings();


    // Initialize or update RSI chart
    if (!rsiChart && rsiContainer) {
      rsiChart = new RSIChart({
        container: rsiContainer,
        data: rsiData,
        displayMode: 'line',
        lineColor: rsiSettings.lineColor,
        midlineColor: rsiSettings.midlineColor,
        midlineStyle: rsiSettings.midlineStyle,
        priceData: bars.map(b => ({ time: b.time, close: b.close })),
        onTrendLineDrawn: () => {
          const trendBtn = document.querySelector('#drawing-tools button[data-tool="trend"]') as HTMLElement | null;
          if (trendBtn) {
            trendBtn.classList.remove('active');
            trendBtn.innerHTML = TREND_ICON;
          }
          rsiChart?.deactivateDivergenceTool();
          deactivateVolumeDeltaDivergenceTool();
        }
      });
      applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
      applyPaneScaleVisibilityByPosition();
    } else if (rsiChart) {
      rsiChart.setData(rsiData, bars.map(b => ({ time: b.time, close: b.close })));
    }

    setupChartSync();

    applyRSISettings();
    applyMovingAverages();
    applyRightMargin();
    syncChartsToPriceRange();
    refreshMonthGridLines();

    // Hide loading indicators after successful load
    hideLoadingOverlay(chartContainer);
    hideLoadingOverlay(volumeDeltaRsiContainer);
    hideLoadingOverlay(rsiContainer);
    hideLoadingOverlay(volumeDeltaContainer);
  } catch (err: any) {
    if (requestId !== latestRenderRequestId) return;

    // Hide loading indicators on error
    hideLoadingOverlay(chartContainer);
    hideLoadingOverlay(volumeDeltaRsiContainer);
    hideLoadingOverlay(rsiContainer);
    hideLoadingOverlay(volumeDeltaContainer);

    console.error('Failed to load chart:', err);
    if (isNoDataTickerError(err)) {
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
      clearVolumeDeltaDivergence();
      volumeDeltaRsiPoints = [];
      volumeDeltaIndexByTime = new Map();
      volumeDeltaRsiByTime = new Map();
      volumeDeltaByTime = new Map();
      currentBars = [];
      clearMovingAverageSeries();
      monthBoundaryTimes = [];
      clearMonthGridOverlay(priceMonthGridOverlayEl);
      clearMonthGridOverlay(volumeDeltaRsiMonthGridOverlayEl);
      clearMonthGridOverlay(volumeDeltaMonthGridOverlayEl);
      clearMonthGridOverlay(rsiMonthGridOverlayEl);
      setPricePaneMessage(chartContainer, INVALID_SYMBOL_MESSAGE);
      errorContainer.style.display = 'none';
      errorContainer.textContent = '';
      return;
    }

    priceChangeByTime = new Map();
    setPricePaneChange(chartContainer, null);
    errorContainer.textContent = `Error loading chart: ${err.message}`;
    errorContainer.style.display = 'block';
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
    refreshMonthGridLines();
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
  refreshMonthGridLines();
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
    refreshMonthGridLines();
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
    const mappedPrice = priceByTime.get(timeKey(time));
    if (Number.isFinite(mappedPrice) && candleSeries) {
      try {
        priceChart.setCrosshairPosition(mappedPrice, time, candleSeries);
      } catch {
        priceChart.clearCrosshairPosition();
      }
    } else {
      priceChart.clearCrosshairPosition();
    }
  };

  const setCrosshairOnVolumeDeltaRsi = (time: string | number) => {
    const mappedVdRsi = volumeDeltaRsiByTime.get(timeKey(time));
    if (Number.isFinite(mappedVdRsi)) {
      try {
        volumeDeltaRsiChartInstance.setCrosshairPosition(mappedVdRsi, time, volumeDeltaRsiSeries);
      } catch {
        volumeDeltaRsiChartInstance.clearCrosshairPosition();
      }
    } else {
      volumeDeltaRsiChartInstance.clearCrosshairPosition();
    }
  };

  const setCrosshairOnRsi = (time: string | number) => {
    const mappedRsi = rsiByTime.get(timeKey(time));
    const rsiSeries = rsiChart?.getSeries();
    if (Number.isFinite(mappedRsi) && rsiSeries) {
      try {
        rsiChartInstance.setCrosshairPosition(mappedRsi, time, rsiSeries);
      } catch {
        rsiChartInstance.clearCrosshairPosition();
      }
    } else {
      rsiChartInstance.clearCrosshairPosition();
    }
  };

  const setCrosshairOnVolumeDelta = (time: string | number) => {
    const mappedVd = volumeDeltaByTime.get(timeKey(time));
    if (Number.isFinite(mappedVd)) {
      try {
        volumeDeltaChartInstance.setCrosshairPosition(mappedVd, time, volumeDeltaHistogramSeries);
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
    if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
    setCrosshairOnPrice(param.time);
    setCrosshairOnVolumeDeltaRsi(param.time);
    setCrosshairOnRsi(param.time);
  });
}

function handleDrawingTool(tool: string): void {
  if (!rsiChart && !volumeDeltaRsiChart) {
    console.warn('RSI/VD RSI chart not available');
    return;
  }

  try {
    if (tool === 'clear') {
      // Clear divergence highlights from both RSI and VD RSI charts.
      rsiChart?.clearDivergence();
      rsiChart?.deactivateDivergenceTool();
      clearVolumeDeltaDivergence();
      deactivateVolumeDeltaDivergenceTool();

      // Remove active state from all tool buttons
      document.querySelectorAll('#drawing-tools .tf-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tool') === 'trend') {
            btn.innerHTML = TREND_ICON;
        }
      });
    } else if (tool === 'trend') {
      const btn = document.querySelector(`button[data-tool="${tool}"]`);
      if (btn?.classList.contains('active')) {
        // Deactivate
        rsiChart?.deactivateDivergenceTool();
        deactivateVolumeDeltaDivergenceTool();
        btn.classList.remove('active');
        btn.innerHTML = TREND_ICON;
      } else {
        // Activate
        rsiChart?.activateDivergenceTool();
        activateVolumeDeltaDivergenceTool();
        btn?.classList.add('active');
        if (btn) btn.innerHTML = TREND_ICON;
      }
    }
  } catch (error) {
    console.error('Error handling drawing tool:', error);
  }
}

// Export for main.ts usage
export function initChartControls() {
  const controls = document.getElementById('chart-controls');
  if (!controls) return;

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
        renderCustomChart(currentChartTicker, interval);
      }
    });
  });

  // Drawing tools
  controls.querySelectorAll('button[data-tool]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement; // Use currentTarget to get the button element
      const tool = target.getAttribute('data-tool');
      if (tool) handleDrawingTool(tool);
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
}

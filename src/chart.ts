import { createChart, CrosshairMode } from 'lightweight-charts';
import { fetchChartData, ChartInterval } from './chartApi';
import { RSIChart } from './rsi';

let currentChartTicker: string | null = null;
let currentChartInterval: ChartInterval = '4hour';
let priceChart: any = null;
let candleSeries: any = null;
let rsiChart: RSIChart | null = null;
let chartResizeObserver: ResizeObserver | null = null;
let latestRenderRequestId = 0;
let priceByTime = new Map<string, number>();
let rsiByTime = new Map<string, number>();
let currentBars: any[] = [];
let monthBoundaryTimes: number[] = [];
let priceMonthGridOverlayEl: HTMLDivElement | null = null;
let rsiMonthGridOverlayEl: HTMLDivElement | null = null;
let priceSettingsPanelEl: HTMLDivElement | null = null;
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

type MAType = 'SMA' | 'EMA';
type MASourceMode = 'daily' | 'timeframe';
type MidlineStyle = 'dotted' | 'solid';

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
  rsi: RSISettings;
}

const DEFAULT_RSI_SETTINGS: RSISettings = {
  length: 14,
  lineColor: '#58a6ff',
  midlineColor: '#ffffff',
  midlineStyle: 'dotted'
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
    { enabled: false, type: 'EMA', length: 100, color: '#00bcd4' },
    { enabled: false, type: 'EMA', length: 200, color: '#90ee90' }
  ]
};

const rsiSettings: RSISettings = {
  ...DEFAULT_RSI_SETTINGS
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

function ensureMonthGridOverlay(container: HTMLElement, isPricePane: boolean): HTMLDivElement {
  const existing = isPricePane ? priceMonthGridOverlayEl : rsiMonthGridOverlayEl;
  if (existing && existing.parentElement === container) return existing;

  const overlay = document.createElement('div');
  overlay.className = isPricePane ? 'month-grid-overlay month-grid-overlay-price' : 'month-grid-overlay month-grid-overlay-rsi';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.left = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '6';
  container.appendChild(overlay);

  if (isPricePane) {
    priceMonthGridOverlayEl = overlay;
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
      }
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

function hideSettingsPanels(): void {
  if (priceSettingsPanelEl) priceSettingsPanelEl.style.display = 'none';
  if (rsiSettingsPanelEl) rsiSettingsPanelEl.style.display = 'none';
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

function createSettingsButton(container: HTMLElement, pane: 'price' | 'rsi'): HTMLButtonElement {
  const existing = container.querySelector(`.pane-settings-btn[data-pane="${pane}"]`) as HTMLButtonElement | null;
  if (existing) return existing;
  const btn = document.createElement('button');
  btn.className = 'pane-settings-btn';
  btn.dataset.pane = pane;
  btn.type = 'button';
  btn.title = `${pane === 'price' ? 'Price' : 'RSI'} settings`;
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
      <div style="font-weight:600;">Chart Settings</div>
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
    <div style="font-weight:600; min-height:18px; margin:0 0 6px;">Moving Averages</div>
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
      <div style="font-weight:600;">RSI Settings</div>
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

function ensureSettingsUI(chartContainer: HTMLElement, rsiContainer: HTMLElement): void {
  const priceBtn = createSettingsButton(chartContainer, 'price');
  const rsiBtn = createSettingsButton(rsiContainer, 'rsi');

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

  syncPriceSettingsPanelValues();
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

function applyChartSizes(chartContainer: HTMLElement, rsiContainer: HTMLElement): void {
  if (!priceChart) return;

  const chartRect = chartContainer.getBoundingClientRect();
  const rsiRect = rsiContainer.getBoundingClientRect();
  const priceWidth = Math.max(1, Math.floor(chartRect.width));
  const priceHeight = Math.max(1, Math.floor(chartRect.height));
  const rsiWidth = Math.max(1, Math.floor(rsiRect.width));
  const rsiHeight = Math.max(1, Math.floor(rsiRect.height));

  priceChart.applyOptions({ width: priceWidth, height: priceHeight });
  if (rsiChart) {
    rsiChart.getChart().applyOptions({ width: rsiWidth, height: rsiHeight });
  }
  refreshMonthGridLines();
}

function ensureResizeObserver(chartContainer: HTMLElement, rsiContainer: HTMLElement): void {
  if (chartResizeObserver) return;

  chartResizeObserver = new ResizeObserver(() => {
    applyChartSizes(chartContainer, rsiContainer);
  });

  chartResizeObserver.observe(chartContainer);
  chartResizeObserver.observe(rsiContainer);
}

export async function renderCustomChart(ticker: string, interval: ChartInterval = currentChartInterval) {
  ensureSettingsLoadedFromStorage();
  const requestId = ++latestRenderRequestId;
  currentChartInterval = interval;

  const chartContainer = document.getElementById('price-chart-container');
  const rsiContainer = document.getElementById('rsi-chart-container');
  const errorContainer = document.getElementById('chart-error');

  if (!chartContainer || !rsiContainer || !errorContainer) {
    console.error('Chart containers not found');
    return;
  }

  // Clear error
  errorContainer.style.display = 'none';
  errorContainer.textContent = '';
  setPricePaneMessage(chartContainer, null);
  ensureMonthGridOverlay(chartContainer, true);
  ensureMonthGridOverlay(rsiContainer, false);
  ensureSettingsUI(chartContainer, rsiContainer);

  // Initialize charts if needed
  if (!priceChart) {
    const { chart, series } = createPriceChart(chartContainer);
    priceChart = chart;
    candleSeries = series;
    setupChartSync();
    applyPriceGridOptions();
  }

  ensureResizeObserver(chartContainer, rsiContainer);
  applyChartSizes(chartContainer, rsiContainer);

  try {
    // Fetch data from API
    const data = await fetchChartData(ticker, interval);
    if (requestId !== latestRenderRequestId) return;

    // Retrieve bars and RSI directly (backend handles aggregation)
    const bars = normalizeCandleBars(data.bars || []);
    if (bars.length === 0) {
      throw new Error('No valid chart bars returned for this ticker/interval');
    }
    monthBoundaryTimes = buildMonthBoundaryTimes(bars);
    const rsiData = buildRSISeriesFromBars(bars, rsiSettings.length);
    currentBars = bars;
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
        }
      });
      setupChartSync();
      applyChartSizes(chartContainer, rsiContainer);
    } else if (rsiChart) {
      rsiChart.setData(rsiData, bars.map(b => ({ time: b.time, close: b.close })));
    }

    applyRSISettings();
    applyMovingAverages();
    applyRightMargin();
    syncChartsToPriceRange();
    refreshMonthGridLines();

    currentChartTicker = ticker;
  } catch (err: any) {
    if (requestId !== latestRenderRequestId) return;
    console.error('Failed to load chart:', err);
    if (isNoDataTickerError(err)) {
      if (candleSeries) {
        candleSeries.setData([]);
      }
      if (rsiChart) {
        rsiChart.setData([], []);
      }
      currentBars = [];
      clearMovingAverageSeries();
      monthBoundaryTimes = [];
      clearMonthGridOverlay(priceMonthGridOverlayEl);
      clearMonthGridOverlay(rsiMonthGridOverlayEl);
      setPricePaneMessage(chartContainer, INVALID_SYMBOL_MESSAGE);
      errorContainer.style.display = 'none';
      errorContainer.textContent = '';
      return;
    }

    errorContainer.textContent = `Error loading chart: ${err.message}`;
    errorContainer.style.display = 'block';
  }
}

function syncChartsToPriceRange(): void {
  if (!priceChart || !rsiChart) return;
  const priceRange = priceChart.timeScale().getVisibleLogicalRange();
  if (!priceRange) return;
  try {
    rsiChart.getChart().timeScale().setVisibleLogicalRange(priceRange);
    refreshMonthGridLines();
  } catch {
    // Ignore transient range sync errors during live updates.
  }
}

function applyRightMargin(): void {
  if (!priceChart) return;
  const rightOffset = RIGHT_MARGIN_BARS;
  priceChart.timeScale().applyOptions({ rightOffset });
  if (rsiChart) {
    rsiChart.getChart().timeScale().applyOptions({ rightOffset });
  }
  refreshMonthGridLines();
}

// Setup sync between price and RSI charts
function setupChartSync() {
  if (!priceChart || !rsiChart) return;

  const rsiChartInstance = rsiChart.getChart();
  let syncLock: 'price' | 'rsi' | null = null;
  const unlockAfterFrame = (owner: 'price' | 'rsi') => {
    requestAnimationFrame(() => {
      if (syncLock === owner) syncLock = null;
    });
  };

  // Sync price chart → RSI chart by logical range.
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (!timeRange || syncLock === 'rsi') return;
    const currentRSIRange = rsiChartInstance.timeScale().getVisibleLogicalRange();
    if (sameLogicalRange(currentRSIRange, timeRange)) return;
    syncLock = 'price';
    try {
      rsiChartInstance.timeScale().setVisibleLogicalRange(timeRange);
      refreshMonthGridLines();
    } finally {
      unlockAfterFrame('price');
    }
  });

  // Sync RSI chart → price chart.
  rsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (rsiChart?.isSyncSuppressed?.()) return;
    if (!timeRange || syncLock === 'price') return;
    const currentPriceRange = priceChart.timeScale().getVisibleLogicalRange();
    if (sameLogicalRange(currentPriceRange, timeRange)) return;
    syncLock = 'rsi';
    try {
      priceChart.timeScale().setVisibleLogicalRange(timeRange);
      refreshMonthGridLines();
    } finally {
      unlockAfterFrame('rsi');
    }
  });

  // Sync crosshair between charts
  priceChart.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      rsiChartInstance.clearCrosshairPosition();
      return;
    }
    const mappedValue = rsiByTime.get(timeKey(param.time));
    if (!Number.isFinite(mappedValue)) {
      rsiChartInstance.clearCrosshairPosition();
      return;
    }
    const rsiSeries = rsiChart?.getSeries();
    if (rsiSeries) {
      try {
        rsiChartInstance.setCrosshairPosition(mappedValue, param.time, rsiSeries);
      } catch {
        rsiChartInstance.clearCrosshairPosition();
      }
    }
  });

  rsiChartInstance.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      priceChart.clearCrosshairPosition();
      return;
    }
    const mappedValue = priceByTime.get(timeKey(param.time));
    if (!Number.isFinite(mappedValue)) {
      priceChart.clearCrosshairPosition();
      return;
    }
    if (candleSeries) {
      try {
        priceChart.setCrosshairPosition(mappedValue, param.time, candleSeries);
      } catch {
        priceChart.clearCrosshairPosition();
      }
    }
  });
}

function handleDrawingTool(tool: string): void {
  if (!rsiChart) {
    console.warn('RSI chart not available');
    return;
  }

  try {
    if (tool === 'clear') {
      // Clear divergence highlights from RSI chart
      rsiChart.clearDivergence();
      rsiChart.deactivateDivergenceTool();

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
        rsiChart.deactivateDivergenceTool();
        btn.classList.remove('active');
        btn.innerHTML = TREND_ICON;
      } else {
        // Activate
        rsiChart.activateDivergenceTool();
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

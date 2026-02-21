import { getThemeColors } from './theme';
import type { CandleBar } from '../shared/api-types';
import type { ChartInterval } from './chartApi';
import {
  type PersistedChartSettings,
  SETTINGS_STORAGE_KEY,
  PANE_HEIGHT_MIN,
  PANE_HEIGHT_MAX,
  VOLUME_DELTA_SOURCE_OPTIONS,
  DEFAULT_PANE_ORDER,
  DEFAULT_PRICE_SETTINGS,
  DEFAULT_RSI_SETTINGS,
  DEFAULT_VOLUME_DELTA_SETTINGS,
  DEFAULT_VOLUME_DELTA_RSI_SETTINGS,
  rsiSettings,
  volumeDeltaRsiSettings,
  volumeDeltaSettings,
  priceChartSettings,
  paneOrder,
  setPaneOrder,
  paneHeights,
  normalizePaneOrder,
} from './chartTypes';

function tc() {
  return getThemeColors();
}

// ---------------------------------------------------------------------------
// Callback interface – chart.ts provides these via initSettingsUI()
// ---------------------------------------------------------------------------

interface SettingsUICallbacks {
  applyMovingAverages: () => void;
  applyPriceGridOptions: () => void;
  applyRSISettings: () => void;
  applyVolumeDeltaRSISettings: (refetch: boolean) => void;
  applyPricePaneDivergentBarColors: () => void;
  clearMovingAverageSeries: () => void;
  applyPaneOrderAndRefreshLayout: (chartContent: HTMLElement) => void;
  renderVolumeDeltaDivergenceSummary: (container: HTMLElement, bars: CandleBar[]) => void;
  scheduleChartLayoutRefresh: () => void;
  renderCustomChart: (ticker: string, interval: ChartInterval) => void;
  getCurrentTicker: () => string | null;
  getCurrentInterval: () => ChartInterval;
  getCurrentBars: () => CandleBar[];
  getVolumeDeltaPaneContainer: () => HTMLElement | null;
  // LightweightCharts CDN — no bundled declarations

  getRsiChart: () => any;
}

// ---------------------------------------------------------------------------
// Module-local state
// ---------------------------------------------------------------------------

let callbacks: SettingsUICallbacks | null = null;
let priceSettingsPanelEl: HTMLDivElement | null = null;
let volumeDeltaSettingsPanelEl: HTMLDivElement | null = null;
let volumeDeltaRsiSettingsPanelEl: HTMLDivElement | null = null;
let rsiSettingsPanelEl: HTMLDivElement | null = null;
let hasLoadedSettingsFromStorage = false;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export function initSettingsUI(cb: SettingsUICallbacks): void {
  callbacks = cb;
}

// ---------------------------------------------------------------------------
// Panel element getters
// ---------------------------------------------------------------------------

export function getPriceSettingsPanel(): HTMLDivElement | null {
  return priceSettingsPanelEl;
}
export function getRsiSettingsPanel(): HTMLDivElement | null {
  return rsiSettingsPanelEl;
}
export function getVolumeDeltaSettingsPanel(): HTMLDivElement | null {
  return volumeDeltaSettingsPanelEl;
}
export function getVolumeDeltaRsiSettingsPanel(): HTMLDivElement | null {
  return volumeDeltaRsiSettingsPanelEl;
}

// ---------------------------------------------------------------------------
// persistSettingsToStorage
// ---------------------------------------------------------------------------

export function persistSettingsToStorage(): void {
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
          color: ma.color,
        })),
      },
      rsi: {
        length: rsiSettings.length,
        lineColor: rsiSettings.lineColor,
        midlineColor: rsiSettings.midlineColor,
        midlineStyle: rsiSettings.midlineStyle,
      },
      volumeDelta: {
        sourceInterval: volumeDeltaSettings.sourceInterval,
        divergenceTable: volumeDeltaSettings.divergenceTable,
        divergentPriceBars: volumeDeltaSettings.divergentPriceBars,
        bullishDivergentColor: volumeDeltaSettings.bullishDivergentColor,
        bearishDivergentColor: volumeDeltaSettings.bearishDivergentColor,
        neutralDivergentColor: volumeDeltaSettings.neutralDivergentColor,
      },
      volumeDeltaRsi: {
        length: volumeDeltaRsiSettings.length,
        lineColor: volumeDeltaRsiSettings.lineColor,
        midlineColor: volumeDeltaRsiSettings.midlineColor,
        midlineStyle: volumeDeltaRsiSettings.midlineStyle,
        sourceInterval: volumeDeltaRsiSettings.sourceInterval,
      },
      paneOrder: [...paneOrder],
      paneHeights: { ...paneHeights },
    };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors (private mode/quota/etc.)
  }
}

// ---------------------------------------------------------------------------
// ensureSettingsLoadedFromStorage
// ---------------------------------------------------------------------------

export function ensureSettingsLoadedFromStorage(): void {
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
          priceChartSettings.ma[i].length = Math.max(
            1,
            Math.floor(Number(persisted.length) || priceChartSettings.ma[i].length),
          );
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
      if (
        source === '1min' ||
        source === '5min' ||
        source === '15min' ||
        source === '30min' ||
        source === '1hour' ||
        source === '4hour'
      ) {
        volumeDeltaSettings.sourceInterval = source;
      }
      if (typeof persistedVolumeDelta.divergenceTable === 'boolean') {
        volumeDeltaSettings.divergenceTable = persistedVolumeDelta.divergenceTable;
      }
      if (typeof persistedVolumeDelta.divergentPriceBars === 'boolean') {
        volumeDeltaSettings.divergentPriceBars = persistedVolumeDelta.divergentPriceBars;
      }
      if (
        typeof persistedVolumeDelta.bullishDivergentColor === 'string' &&
        persistedVolumeDelta.bullishDivergentColor.trim()
      ) {
        volumeDeltaSettings.bullishDivergentColor = persistedVolumeDelta.bullishDivergentColor;
      }
      if (
        typeof persistedVolumeDelta.bearishDivergentColor === 'string' &&
        persistedVolumeDelta.bearishDivergentColor.trim()
      ) {
        volumeDeltaSettings.bearishDivergentColor = persistedVolumeDelta.bearishDivergentColor;
      }
      if (
        typeof persistedVolumeDelta.neutralDivergentColor === 'string' &&
        persistedVolumeDelta.neutralDivergentColor.trim()
      ) {
        volumeDeltaSettings.neutralDivergentColor = persistedVolumeDelta.neutralDivergentColor;
      }
    }

    const persistedVolumeDeltaRSI = parsed?.volumeDeltaRsi;
    if (persistedVolumeDeltaRSI) {
      volumeDeltaRsiSettings.length = Math.max(
        1,
        Math.floor(Number(persistedVolumeDeltaRSI.length) || volumeDeltaRsiSettings.length),
      );
      if (typeof persistedVolumeDeltaRSI.lineColor === 'string' && persistedVolumeDeltaRSI.lineColor.trim()) {
        volumeDeltaRsiSettings.lineColor = persistedVolumeDeltaRSI.lineColor;
      }
      if (typeof persistedVolumeDeltaRSI.midlineColor === 'string' && persistedVolumeDeltaRSI.midlineColor.trim()) {
        volumeDeltaRsiSettings.midlineColor = persistedVolumeDeltaRSI.midlineColor;
      }
      volumeDeltaRsiSettings.midlineStyle = persistedVolumeDeltaRSI.midlineStyle === 'solid' ? 'solid' : 'dotted';
      const source = String(persistedVolumeDeltaRSI.sourceInterval || '');
      if (
        source === '1min' ||
        source === '5min' ||
        source === '15min' ||
        source === '30min' ||
        source === '1hour' ||
        source === '4hour'
      ) {
        volumeDeltaRsiSettings.sourceInterval = source;
      }
    }

    setPaneOrder(normalizePaneOrder(parsed?.paneOrder));

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

// ---------------------------------------------------------------------------
// Sync panel values from settings singletons
// ---------------------------------------------------------------------------

export function syncPriceSettingsPanelValues(): void {
  if (!priceSettingsPanelEl) return;
  const sourceSelect = priceSettingsPanelEl.querySelector(
    '[data-price-setting="ma-source"]',
  ) as HTMLSelectElement | null;
  const vGrid = priceSettingsPanelEl.querySelector('[data-price-setting="v-grid"]') as HTMLInputElement | null;
  const hGrid = priceSettingsPanelEl.querySelector('[data-price-setting="h-grid"]') as HTMLInputElement | null;
  if (sourceSelect) sourceSelect.value = priceChartSettings.maSourceMode;
  if (vGrid) vGrid.checked = priceChartSettings.verticalGridlines;
  if (hGrid) hGrid.checked = priceChartSettings.horizontalGridlines;

  for (let i = 0; i < priceChartSettings.ma.length; i++) {
    const ma = priceChartSettings.ma[i];
    const enabled = priceSettingsPanelEl.querySelector(
      `[data-price-setting="ma-enabled-${i}"]`,
    ) as HTMLInputElement | null;
    const type = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-type-${i}"]`) as HTMLSelectElement | null;
    const length = priceSettingsPanelEl.querySelector(
      `[data-price-setting="ma-length-${i}"]`,
    ) as HTMLInputElement | null;
    const color = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-color-${i}"]`) as HTMLInputElement | null;
    if (enabled) enabled.checked = ma.enabled;
    if (type) type.value = ma.type;
    if (length) length.value = String(ma.length);
    if (color) color.value = ma.color;
  }
  // VDF button doesn't need settings sync
}

export function syncRSISettingsPanelValues(): void {
  if (!rsiSettingsPanelEl) return;
  const length = rsiSettingsPanelEl.querySelector('[data-rsi-setting="length"]') as HTMLInputElement | null;
  const color = rsiSettingsPanelEl.querySelector('[data-rsi-setting="line-color"]') as HTMLInputElement | null;
  const midlineColor = rsiSettingsPanelEl.querySelector(
    '[data-rsi-setting="midline-color"]',
  ) as HTMLInputElement | null;
  const midlineStyle = rsiSettingsPanelEl.querySelector(
    '[data-rsi-setting="midline-style"]',
  ) as HTMLSelectElement | null;
  if (length) length.value = String(rsiSettings.length);
  if (color) color.value = rsiSettings.lineColor;
  if (midlineColor) midlineColor.value = rsiSettings.midlineColor;
  if (midlineStyle) midlineStyle.value = rsiSettings.midlineStyle;
}

export function syncVolumeDeltaSettingsPanelValues(): void {
  if (!volumeDeltaSettingsPanelEl) return;
  const source = volumeDeltaSettingsPanelEl.querySelector(
    '[data-vd-setting="source-interval"]',
  ) as HTMLSelectElement | null;
  const divergenceTable = volumeDeltaSettingsPanelEl.querySelector(
    '[data-vd-setting="divergence-table"]',
  ) as HTMLInputElement | null;
  const divergent = volumeDeltaSettingsPanelEl.querySelector(
    '[data-vd-setting="divergent-price-bars"]',
  ) as HTMLInputElement | null;
  const bullish = volumeDeltaSettingsPanelEl.querySelector(
    '[data-vd-setting="divergent-bullish-color"]',
  ) as HTMLInputElement | null;
  const bearish = volumeDeltaSettingsPanelEl.querySelector(
    '[data-vd-setting="divergent-bearish-color"]',
  ) as HTMLInputElement | null;
  const neutral = volumeDeltaSettingsPanelEl.querySelector(
    '[data-vd-setting="divergent-neutral-color"]',
  ) as HTMLInputElement | null;
  if (source) source.value = volumeDeltaSettings.sourceInterval;
  if (divergenceTable) divergenceTable.checked = volumeDeltaSettings.divergenceTable;
  if (divergent) divergent.checked = volumeDeltaSettings.divergentPriceBars;
  if (bullish) bullish.value = volumeDeltaSettings.bullishDivergentColor;
  if (bearish) bearish.value = volumeDeltaSettings.bearishDivergentColor;
  if (neutral) neutral.value = volumeDeltaSettings.neutralDivergentColor;
}

export function syncVolumeDeltaRSISettingsPanelValues(): void {
  if (!volumeDeltaRsiSettingsPanelEl) return;
  const length = volumeDeltaRsiSettingsPanelEl.querySelector(
    '[data-vd-rsi-setting="length"]',
  ) as HTMLInputElement | null;
  const color = volumeDeltaRsiSettingsPanelEl.querySelector(
    '[data-vd-rsi-setting="line-color"]',
  ) as HTMLInputElement | null;
  const midlineColor = volumeDeltaRsiSettingsPanelEl.querySelector(
    '[data-vd-rsi-setting="midline-color"]',
  ) as HTMLInputElement | null;
  const midlineStyle = volumeDeltaRsiSettingsPanelEl.querySelector(
    '[data-vd-rsi-setting="midline-style"]',
  ) as HTMLSelectElement | null;
  const source = volumeDeltaRsiSettingsPanelEl.querySelector(
    '[data-vd-rsi-setting="source-interval"]',
  ) as HTMLSelectElement | null;
  if (length) length.value = String(volumeDeltaRsiSettings.length);
  if (color) color.value = volumeDeltaRsiSettings.lineColor;
  if (midlineColor) midlineColor.value = volumeDeltaRsiSettings.midlineColor;
  if (midlineStyle) midlineStyle.value = volumeDeltaRsiSettings.midlineStyle;
  if (source) source.value = volumeDeltaRsiSettings.sourceInterval;
}

// ---------------------------------------------------------------------------
// hideSettingsPanels
// ---------------------------------------------------------------------------

export function hideSettingsPanels(): void {
  if (priceSettingsPanelEl) priceSettingsPanelEl.style.display = 'none';
  if (volumeDeltaSettingsPanelEl) volumeDeltaSettingsPanelEl.style.display = 'none';
  if (volumeDeltaRsiSettingsPanelEl) volumeDeltaRsiSettingsPanelEl.style.display = 'none';
  if (rsiSettingsPanelEl) rsiSettingsPanelEl.style.display = 'none';
}

// ---------------------------------------------------------------------------
// applyUniformSettingsPanelTypography
// ---------------------------------------------------------------------------

export function applyUniformSettingsPanelTypography(panel: HTMLDivElement): void {
  panel.style.fontFamily = 'var(--font-sans)';
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

// ---------------------------------------------------------------------------
// Reset functions
// ---------------------------------------------------------------------------

export function resetPriceSettingsToDefault(): void {
  callbacks!.clearMovingAverageSeries();
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
  setPaneOrder([...DEFAULT_PANE_ORDER]);
  const chartContent = document.getElementById('chart-content');
  if (chartContent && chartContent instanceof HTMLElement) {
    callbacks!.applyPaneOrderAndRefreshLayout(chartContent);
  }
  callbacks!.applyPriceGridOptions();
  callbacks!.applyMovingAverages();
  syncPriceSettingsPanelValues();
  persistSettingsToStorage();
}

export function resetRSISettingsToDefault(): void {
  rsiSettings.length = DEFAULT_RSI_SETTINGS.length;
  rsiSettings.lineColor = DEFAULT_RSI_SETTINGS.lineColor;
  rsiSettings.midlineColor = DEFAULT_RSI_SETTINGS.midlineColor;
  rsiSettings.midlineStyle = DEFAULT_RSI_SETTINGS.midlineStyle;
  callbacks!.applyRSISettings();
  syncRSISettingsPanelValues();
  persistSettingsToStorage();
}

export function resetVolumeDeltaSettingsToDefault(): void {
  volumeDeltaSettings.sourceInterval = DEFAULT_VOLUME_DELTA_SETTINGS.sourceInterval;
  volumeDeltaSettings.divergenceTable = DEFAULT_VOLUME_DELTA_SETTINGS.divergenceTable;
  volumeDeltaSettings.divergentPriceBars = DEFAULT_VOLUME_DELTA_SETTINGS.divergentPriceBars;
  volumeDeltaSettings.bullishDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.bullishDivergentColor;
  volumeDeltaSettings.bearishDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.bearishDivergentColor;
  volumeDeltaSettings.neutralDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor;
  const ticker = callbacks!.getCurrentTicker();
  if (ticker) {
    callbacks!.renderCustomChart(ticker, callbacks!.getCurrentInterval());
  }
  callbacks!.applyPricePaneDivergentBarColors();
  syncVolumeDeltaSettingsPanelValues();
  persistSettingsToStorage();
}

export function resetVolumeDeltaRSISettingsToDefault(): void {
  volumeDeltaRsiSettings.length = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.length;
  volumeDeltaRsiSettings.lineColor = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.lineColor;
  volumeDeltaRsiSettings.midlineColor = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.midlineColor;
  volumeDeltaRsiSettings.midlineStyle = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.midlineStyle;
  volumeDeltaRsiSettings.sourceInterval = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.sourceInterval;
  callbacks!.applyVolumeDeltaRSISettings(true);
  syncVolumeDeltaRSISettingsPanelValues();
  persistSettingsToStorage();
}

// ---------------------------------------------------------------------------
// createPriceSettingsPanel
// ---------------------------------------------------------------------------

export function createPriceSettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel price-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '280px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = tc().cardBgOverlay95;
  panel.style.border = `1px solid ${tc().borderColor}`;
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = tc().textPrimary;
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Chart</div>
      <button type="button" data-price-setting="reset" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
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
      <select data-price-setting="ma-source" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;">
        <option value="daily">Daily</option>
        <option value="timeframe">Chart</option>
      </select>
    </label>
    ${priceChartSettings.ma
      .map(
        (_, i) => `
      <div style="display:grid; grid-template-columns: 20px 64px 58px 1fr; gap:6px; align-items:center; min-height:26px; margin-bottom:6px;">
        <input type="checkbox" data-price-setting="ma-enabled-${i}" title="Enable MA ${i + 1}" />
        <select data-price-setting="ma-type-${i}" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;">
          <option value="SMA">SMA</option>
          <option value="EMA">EMA</option>
        </select>
        <input data-price-setting="ma-length-${i}" type="number" min="1" max="500" step="1" style="width:58px; background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;" />
        <input data-price-setting="ma-color-${i}" type="color" style="width:100%; height:24px; border:none; background:transparent; padding:0;" />
      </div>
    `,
      )
      .join('')}
  `;
  applyUniformSettingsPanelTypography(panel);

  panel.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    if (!target) return;

    const setting = (target as HTMLInputElement | HTMLSelectElement).dataset.priceSetting || '';
    if (setting === 'ma-source') {
      priceChartSettings.maSourceMode = (target as HTMLSelectElement).value === 'timeframe' ? 'timeframe' : 'daily';
      callbacks!.applyMovingAverages();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'v-grid') {
      priceChartSettings.verticalGridlines = (target as HTMLInputElement).checked;
      callbacks!.scheduleChartLayoutRefresh();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'h-grid') {
      priceChartSettings.horizontalGridlines = (target as HTMLInputElement).checked;
      callbacks!.applyPriceGridOptions();
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
      ma.type = (target as HTMLSelectElement).value === 'EMA' ? 'EMA' : 'SMA';
    } else if (key === 'length') {
      ma.length = Math.max(1, Math.floor(Number((target as HTMLInputElement).value) || 14));
    } else if (key === 'color') {
      ma.color = (target as HTMLInputElement).value || ma.color;
    }
    callbacks!.applyMovingAverages();
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
  priceSettingsPanelEl = panel;
  return panel;
}

// ---------------------------------------------------------------------------
// createRSISettingsPanel
// ---------------------------------------------------------------------------

export function createRSISettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel rsi-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '230px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = tc().cardBgOverlay95;
  panel.style.border = `1px solid ${tc().borderColor}`;
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = tc().textPrimary;
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">RSI</div>
      <button type="button" data-rsi-setting="reset" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Length</span>
      <input data-rsi-setting="length" type="number" min="1" max="200" step="1" style="width:64px; background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;" />
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
      <select data-rsi-setting="midline-style" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;">
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
      callbacks!.applyRSISettings();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'line-color') {
      rsiSettings.lineColor = target.value || rsiSettings.lineColor;
      callbacks!.getRsiChart()?.setLineColor(rsiSettings.lineColor);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-color') {
      rsiSettings.midlineColor = target.value || rsiSettings.midlineColor;
      callbacks!.getRsiChart()?.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-style') {
      rsiSettings.midlineStyle = target.value === 'solid' ? 'solid' : 'dotted';
      callbacks!.getRsiChart()?.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
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
  rsiSettingsPanelEl = panel;
  return panel;
}

// ---------------------------------------------------------------------------
// createVolumeDeltaSettingsPanel
// ---------------------------------------------------------------------------

export function createVolumeDeltaSettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel volume-delta-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '230px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = tc().cardBgOverlay95;
  panel.style.border = `1px solid ${tc().borderColor}`;
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = tc().textPrimary;
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Volume Delta</div>
      <button type="button" data-vd-setting="reset" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Source</span>
      <select data-vd-setting="source-interval" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;">
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
      if (
        nextValue !== '1min' &&
        nextValue !== '5min' &&
        nextValue !== '15min' &&
        nextValue !== '30min' &&
        nextValue !== '1hour' &&
        nextValue !== '4hour'
      )
        return;
      volumeDeltaSettings.sourceInterval = nextValue;
      const ticker = callbacks!.getCurrentTicker();
      if (ticker) {
        callbacks!.renderCustomChart(ticker, callbacks!.getCurrentInterval());
      }
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergence-table') {
      volumeDeltaSettings.divergenceTable = (target as HTMLInputElement).checked;
      const vdContainer = callbacks!.getVolumeDeltaPaneContainer();
      if (vdContainer) {
        callbacks!.renderVolumeDeltaDivergenceSummary(vdContainer, callbacks!.getCurrentBars());
      }
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-price-bars') {
      volumeDeltaSettings.divergentPriceBars = (target as HTMLInputElement).checked;
      callbacks!.applyPricePaneDivergentBarColors();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-bullish-color') {
      volumeDeltaSettings.bullishDivergentColor =
        (target as HTMLInputElement).value || volumeDeltaSettings.bullishDivergentColor;
      callbacks!.applyPricePaneDivergentBarColors();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-bearish-color') {
      volumeDeltaSettings.bearishDivergentColor =
        (target as HTMLInputElement).value || volumeDeltaSettings.bearishDivergentColor;
      callbacks!.applyPricePaneDivergentBarColors();
      persistSettingsToStorage();
      return;
    }
    if (setting === 'divergent-neutral-color') {
      volumeDeltaSettings.neutralDivergentColor =
        (target as HTMLInputElement).value || volumeDeltaSettings.neutralDivergentColor;
      callbacks!.applyPricePaneDivergentBarColors();
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
  volumeDeltaSettingsPanelEl = panel;
  return panel;
}

// ---------------------------------------------------------------------------
// createVolumeDeltaRSISettingsPanel
// ---------------------------------------------------------------------------

export function createVolumeDeltaRSISettingsPanel(container: HTMLElement): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'pane-settings-panel volume-delta-rsi-settings-panel';
  panel.style.position = 'absolute';
  panel.style.left = '8px';
  panel.style.top = '38px';
  panel.style.zIndex = '31';
  panel.style.width = '230px';
  panel.style.maxWidth = 'calc(100% - 16px)';
  panel.style.background = tc().cardBgOverlay95;
  panel.style.border = `1px solid ${tc().borderColor}`;
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.display = 'none';
  panel.style.color = tc().textPrimary;
  panel.style.backdropFilter = 'blur(6px)';

  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Volume Delta RSI</div>
      <button type="button" data-vd-rsi-setting="reset" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Length</span>
      <input data-vd-rsi-setting="length" type="number" min="1" max="200" step="1" style="width:64px; background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Source</span>
      <select data-vd-rsi-setting="source-interval" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;">
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
      <select data-vd-rsi-setting="midline-style" style="background:${tc().bgColor}; color:${tc().textPrimary}; border:1px solid ${tc().borderColor}; border-radius:4px; padding:2px 4px;">
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
      callbacks!.applyVolumeDeltaRSISettings(true);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'source-interval') {
      const nextValue = String((target as HTMLSelectElement).value || '');
      if (
        nextValue !== '1min' &&
        nextValue !== '5min' &&
        nextValue !== '15min' &&
        nextValue !== '30min' &&
        nextValue !== '1hour' &&
        nextValue !== '4hour'
      )
        return;
      volumeDeltaRsiSettings.sourceInterval = nextValue;
      callbacks!.applyVolumeDeltaRSISettings(true);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'line-color') {
      volumeDeltaRsiSettings.lineColor = target.value || volumeDeltaRsiSettings.lineColor;
      callbacks!.applyVolumeDeltaRSISettings(false);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-color') {
      volumeDeltaRsiSettings.midlineColor = target.value || volumeDeltaRsiSettings.midlineColor;
      callbacks!.applyVolumeDeltaRSISettings(false);
      persistSettingsToStorage();
      return;
    }
    if (setting === 'midline-style') {
      volumeDeltaRsiSettings.midlineStyle = target.value === 'solid' ? 'solid' : 'dotted';
      callbacks!.applyVolumeDeltaRSISettings(false);
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
  volumeDeltaRsiSettingsPanelEl = panel;
  return panel;
}

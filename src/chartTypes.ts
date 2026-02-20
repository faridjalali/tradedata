/**
 * Chart types, interfaces, constants, and shared mutable settings.
 * Extracted from chart.ts for module separation.
 */

import type { ChartInterval, VolumeDeltaSourceInterval } from './chartApi';
import type { RSIPersistedTrendline } from './rsi';

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

export type MAType = 'SMA' | 'EMA';
export type MASourceMode = 'daily' | 'timeframe';
export type MidlineStyle = 'dotted' | 'solid';
export type PaneId = 'price-chart-container' | 'vd-rsi-chart-container' | 'rsi-chart-container' | 'vd-chart-container';
export type TrendToolPane = 'rsi' | 'volumeDeltaRsi';
export type PaneControlType = 'price' | 'volumeDelta' | 'volumeDeltaRsi' | 'rsi';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface MASetting {
  enabled: boolean;
  type: MAType;
  length: number;
  color: string;
  // LightweightCharts CDN — no bundled declarations

  series: any | null;
  values: Array<number | null>;
}

export interface PriceChartSettings {
  maSourceMode: MASourceMode;
  verticalGridlines: boolean;
  horizontalGridlines: boolean;
  ma: MASetting[];
}

export interface RSISettings {
  length: number;
  lineColor: string;
  midlineColor: string;
  midlineStyle: MidlineStyle;
}

export interface VolumeDeltaRSISettings {
  length: number;
  lineColor: string;
  midlineColor: string;
  midlineStyle: MidlineStyle;
  sourceInterval: VolumeDeltaSourceInterval;
}

export interface VolumeDeltaSettings {
  sourceInterval: VolumeDeltaSourceInterval;
  divergenceTable: boolean;
  divergentPriceBars: boolean;
  bullishDivergentColor: string;
  bearishDivergentColor: string;
  neutralDivergentColor: string;
}

export interface PersistedMASetting {
  enabled: boolean;
  type: MAType;
  length: number;
  color: string;
}

export interface PersistedChartSettings {
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

// Re-export for convenience
export type { RSIPersistedTrendline };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TREND_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="20" x2="20" y2="4"/><polyline points="15 4 20 4 20 9"/></svg>`;
export const ERASE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h10"/><path d="M5.5 13.5 9 17l8.5-8.5a2.12 2.12 0 0 0-3-3L6 14"/><path d="m2 22 3-3"/></svg>`;
export const DIVERGENCE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 12 6 20 18"/></svg>`;
export const SETTINGS_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

export const INTERVAL_SWITCH_DEBOUNCE_MS = 120;
export const CHART_LIVE_REFRESH_MS = 15 * 60 * 1000;
export const CHART_CLIENT_CACHE_TTL_MS = 15 * 60 * 1000;
export const CHART_CLIENT_CACHE_MAX_ENTRIES = 16;
export const CHART_SESSION_CACHE_KEY = 'custom_chart_session_cache_v1';
export const CHART_SESSION_CACHE_MAX_ENTRIES = 6;
export const CHART_SESSION_CACHE_MAX_BYTES = 900_000;
export const RIGHT_MARGIN_BARS = 10;
export const FUTURE_TIMELINE_TRADING_DAYS = 252;
export const SCALE_LABEL_CHARS = 4;
export const SCALE_MIN_WIDTH_PX = 56;
export const INVALID_SYMBOL_MESSAGE = 'Invalid symbol';
export const SETTINGS_STORAGE_KEY = 'custom_chart_settings_v1';
export const VDF_CACHE_MAX_SIZE = 200;

export const TOP_PANE_TICKER_LABEL_CLASS = 'top-pane-ticker-label';
export const TOP_PANE_BADGE_CLASS = 'top-pane-badge';
export const TOP_PANE_BADGE_START_LEFT_PX = 38;
export const TOP_PANE_BADGE_GAP_PX = 6;
export const PANE_SETTINGS_BUTTON_LEFT_PX = 8;
export const PANE_TOOL_BUTTON_TOP_PX = 8;
export const PANE_TOOL_BUTTON_SIZE_PX = 24;
export const PANE_TOOL_BUTTON_GAP_PX = 6;

export const VOLUME_DELTA_RSI_COLOR = '#2962FF';
export const VOLUME_DELTA_MIDLINE = 50;
export const RSI_MIDLINE_VALUE = 50;
export const VOLUME_DELTA_AXIS_MIN = 20;
export const VOLUME_DELTA_AXIS_MAX = 80;
export const VOLUME_DELTA_DATA_MIN = 0;
export const VOLUME_DELTA_DATA_MAX = 100;
export const VOLUME_DELTA_MAX_HIGHLIGHT_POINTS = 2000;
export const DIVERGENCE_HIGHLIGHT_COLOR = '#ff6b6b';
export const TRENDLINE_COLOR = '#ffa500';
export const VOLUME_DELTA_POSITIVE_COLOR = '#089981';
export const VOLUME_DELTA_NEGATIVE_COLOR = '#f23645';

export const VOLUME_DELTA_SOURCE_OPTIONS: Array<{ value: VolumeDeltaSourceInterval; label: string }> = [
  { value: '1min', label: '1 min' },
  { value: '5min', label: '5 min' },
  { value: '15min', label: '15 min' },
  { value: '30min', label: '30 min' },
  { value: '1hour', label: '1 hour' },
  { value: '4hour', label: '4 hour' },
];

export const CHART_PERF_SAMPLE_MAX = 180;

export const PREFETCH_INTERVAL_TARGETS: Record<ChartInterval, ChartInterval[]> = {
  '5min': [],
  '15min': [],
  '30min': [],
  '1hour': [],
  '4hour': ['1day'],
  '1day': ['4hour', '1week'],
  '1week': ['1day'],
};

export const PANE_HEIGHT_MIN = 120;
export const PANE_HEIGHT_MAX = 600;

export const DEFAULT_PANE_ORDER: PaneId[] = [
  'vd-chart-container',
  'price-chart-container',
  'rsi-chart-container',
  'vd-rsi-chart-container',
];

export function normalizePaneOrder(order: unknown): PaneId[] {
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

export const DEFAULT_PANE_HEIGHTS: Record<string, number> = {
  'vd-chart-container': 240,
  'price-chart-container': 400,
  'rsi-chart-container': 400,
  'vd-rsi-chart-container': 400,
};

export const DEFAULT_RSI_SETTINGS: RSISettings = {
  length: 14,
  lineColor: '#58a6ff',
  midlineColor: '#c9d1d9',
  midlineStyle: 'dotted',
};

export const DEFAULT_VOLUME_DELTA_RSI_SETTINGS: VolumeDeltaRSISettings = {
  length: 14,
  lineColor: VOLUME_DELTA_RSI_COLOR,
  midlineColor: '#c9d1d9',
  midlineStyle: 'dotted',
  sourceInterval: '1min',
};

export const DEFAULT_VOLUME_DELTA_SETTINGS: VolumeDeltaSettings = {
  sourceInterval: '1min',
  divergenceTable: true,
  divergentPriceBars: true,
  bullishDivergentColor: '#26a69a',
  bearishDivergentColor: '#ef5350',
  neutralDivergentColor: '#8b949e',
};

export const DEFAULT_PRICE_SETTINGS: {
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
    { enabled: false, type: 'SMA', length: 200, color: '#90ee90' },
  ],
};

// ---------------------------------------------------------------------------
// Detect touch-capable device — shared with rsi.ts
// ---------------------------------------------------------------------------

export const isMobileTouch: boolean =
  typeof window !== 'undefined' &&
  (window.matchMedia('(max-width: 768px)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0);

// ---------------------------------------------------------------------------
// Live mutable settings objects (singleton — shared across modules)
// ---------------------------------------------------------------------------

export const rsiSettings: RSISettings = {
  ...DEFAULT_RSI_SETTINGS,
};

export const volumeDeltaRsiSettings: VolumeDeltaRSISettings = {
  ...DEFAULT_VOLUME_DELTA_RSI_SETTINGS,
};

export const volumeDeltaSettings: VolumeDeltaSettings = {
  ...DEFAULT_VOLUME_DELTA_SETTINGS,
};

export const priceChartSettings: PriceChartSettings = {
  maSourceMode: DEFAULT_PRICE_SETTINGS.maSourceMode,
  verticalGridlines: DEFAULT_PRICE_SETTINGS.verticalGridlines,
  horizontalGridlines: DEFAULT_PRICE_SETTINGS.horizontalGridlines,
  ma: DEFAULT_PRICE_SETTINGS.ma.map((ma) => ({ ...ma, series: null, values: [] })),
};

export let paneOrder: PaneId[] = [...DEFAULT_PANE_ORDER];
export function setPaneOrder(order: PaneId[]) {
  paneOrder = order;
}

export let paneHeights: Record<string, number> = {};
export function setPaneHeights(heights: Record<string, number>) {
  paneHeights = heights;
}

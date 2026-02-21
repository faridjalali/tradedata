/**
 * VDF (Volume Divergence Flag) detection UI — button, zone overlay,
 * bull flag indicator, and refresh helpers.
 * Owns its own DOM and cache state; reads chart state through callbacks.
 */

import { getThemeColors } from './theme';
import type { CandleBar } from '../shared/api-types';
import { unixSecondsFromTimeValue } from './chartTimeUtils';
import {
  PANE_TOOL_BUTTON_TOP_PX,
  PANE_TOOL_BUTTON_SIZE_PX,
  PANE_TOOL_BUTTON_GAP_PX,
  SCALE_MIN_WIDTH_PX,
  VDF_CACHE_MAX_SIZE,
} from './chartTypes';
import { VDFCacheEntry, renderVDFAnalysisPanel } from './vdfAnalysisPanel';

// ---------------------------------------------------------------------------
// Shared state callbacks (set by chart.ts at init time)
// ---------------------------------------------------------------------------

// LightweightCharts CDN — no bundled declarations

let getPriceChart: () => any = () => null;
let getCurrentBars: () => CandleBar[] = () => [];
let getCurrentTicker: () => string | null = () => null;

export function initVDF(callbacks: {
  // LightweightCharts CDN — no bundled declarations

  getPriceChart: () => any;
  getCurrentBars: () => CandleBar[];
  getCurrentTicker: () => string | null;
}): void {
  getPriceChart = callbacks.getPriceChart;
  getCurrentBars = callbacks.getCurrentBars;
  getCurrentTicker = callbacks.getCurrentTicker;
}

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

function tc() {
  return getThemeColors();
}

function VDF_COLOR_LOADING() {
  return tc().textPrimary;
}

function VDF_COLOR_NOT_DETECTED() {
  return tc().textMuted;
}

const VDF_COLOR_ERROR = '#ef5350';

// ---------------------------------------------------------------------------
// Refresh button helpers (shared with chart.ts for the chart refresh button)
// ---------------------------------------------------------------------------

const REFRESH_SVG_NS = 'http://www.w3.org/2000/svg';
const REFRESH_SVG_PATHS = [
  'M21.5 2v6h-6',
  'M21.5 8A10 10 0 0 0 5.6 5.6',
  'M2.5 22v-6h6',
  'M2.5 16A10 10 0 0 0 18.4 18.4',
];

export function createRefreshSvgIcon(): SVGSVGElement {
  const svg = document.createElementNS(REFRESH_SVG_NS, 'svg');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.display = 'block';
  for (const d of REFRESH_SVG_PATHS) {
    const p = document.createElementNS(REFRESH_SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/**
 * Set a .refresh-btn's loading state.
 * Replaces inner SVG, toggles .loading CSS class, and sets cursor/pointer-events.
 */
export function setRefreshButtonLoading(btn: HTMLElement, loading: boolean): void {
  btn.innerHTML = '';
  const svg = createRefreshSvgIcon();
  btn.appendChild(svg);
  btn.classList.toggle('loading', loading);
  btn.style.cursor = loading ? 'wait' : 'pointer';
  btn.style.pointerEvents = loading ? 'none' : 'auto';
}

// ---------------------------------------------------------------------------
// VDF own state
// ---------------------------------------------------------------------------

let vdfButtonEl: HTMLButtonElement | null = null;
let vdfRefreshButtonEl: HTMLButtonElement | null = null;
let vdfToolbarEl: HTMLDivElement | null = null;
let bullFlagButtonEl: HTMLButtonElement | null = null;
let vdfLoadingForTicker: string | null = null;
const vdfResultCache = new Map<string, VDFCacheEntry>();
let vdZoneOverlayEl: HTMLDivElement | null = null;

// ---------------------------------------------------------------------------
// Toolbar / button creation
// ---------------------------------------------------------------------------

export function ensureVDFToolbar(container: HTMLElement): HTMLDivElement {
  if (vdfToolbarEl && vdfToolbarEl.parentElement === container) return vdfToolbarEl;
  if (vdfToolbarEl?.parentElement) vdfToolbarEl.parentElement.removeChild(vdfToolbarEl);

  const el = document.createElement('div');
  el.className = 'vdf-toolbar';
  el.style.position = 'absolute';
  el.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
  el.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
  el.style.zIndex = '34';
  el.style.display = 'flex';
  el.style.flexDirection = 'row';
  el.style.alignItems = 'center';
  el.style.gap = `${PANE_TOOL_BUTTON_GAP_PX}px`;
  el.style.pointerEvents = 'auto';
  container.appendChild(el);
  vdfToolbarEl = el;
  return el;
}

export function ensureVDFButton(container: HTMLElement): HTMLButtonElement {
  const toolbar = ensureVDFToolbar(container);
  if (vdfButtonEl && vdfButtonEl.parentElement === toolbar) return vdfButtonEl;
  if (vdfButtonEl && vdfButtonEl.parentElement) {
    vdfButtonEl.parentElement.removeChild(vdfButtonEl);
  }

  const btn = document.createElement('button');
  btn.className = 'pane-btn label vdf-indicator-btn';
  btn.type = 'button';
  btn.textContent = 'VDF';
  btn.style.width = 'auto';
  btn.style.minWidth = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.padding = '0 5px';
  btn.style.color = VDF_COLOR_LOADING();
  btn.style.fontSize = '12px';
  btn.style.fontWeight = '700';
  btn.style.letterSpacing = '0.5px';
  btn.style.lineHeight = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  toolbar.appendChild(btn);
  vdfButtonEl = btn;
  return btn;
}

export function ensureVDFRefreshButton(container: HTMLElement): HTMLButtonElement {
  const toolbar = ensureVDFToolbar(container);
  if (vdfRefreshButtonEl && vdfRefreshButtonEl.parentElement === toolbar) return vdfRefreshButtonEl;
  if (vdfRefreshButtonEl && vdfRefreshButtonEl.parentElement) {
    vdfRefreshButtonEl.parentElement.removeChild(vdfRefreshButtonEl);
  }

  const btn = document.createElement('button');
  btn.className = 'pane-btn refresh-btn vdf-refresh-btn';
  btn.type = 'button';
  btn.style.position = 'relative';
  // Insert before VDF button so refresh appears on the left
  if (vdfButtonEl && vdfButtonEl.parentElement === toolbar) {
    toolbar.insertBefore(btn, vdfButtonEl);
  } else {
    toolbar.appendChild(btn);
  }
  vdfRefreshButtonEl = btn;
  renderVDFRefreshIcon(false);
  return btn;
}

export function renderVDFRefreshIcon(loading: boolean): void {
  if (!vdfRefreshButtonEl) return;
  vdfRefreshButtonEl.removeAttribute('title');
  setRefreshButtonLoading(vdfRefreshButtonEl, loading);
}

function setVDFButtonColor(color: string, title?: string): void {
  if (!vdfButtonEl) return;
  vdfButtonEl.style.color = color;
  if (title !== undefined) vdfButtonEl.title = title;
}

export function updateVDFButton(entry: VDFCacheEntry): void {
  if (!vdfButtonEl) return;
  if (entry.is_detected) {
    const score = Math.round(entry.composite_score * 100);
    vdfButtonEl.textContent = String(score);
    vdfButtonEl.style.color = score >= 80 ? '#26a69a' : score >= 60 ? '#8bc34a' : tc().textPrimary;
    const proxLevel = entry.proximity?.level || 'none';
    if (proxLevel === 'imminent' || proxLevel === 'high') {
      vdfButtonEl.style.borderColor = '#ff9800';
    } else if (proxLevel === 'elevated') {
      vdfButtonEl.style.borderColor = '#ffc107';
    } else {
      vdfButtonEl.style.borderColor = '';
    }
  } else {
    vdfButtonEl.textContent = 'VDF';
    vdfButtonEl.style.color = VDF_COLOR_NOT_DETECTED();
    vdfButtonEl.style.borderColor = '';
  }
  vdfButtonEl.removeAttribute('title');
}

export function ensureBullFlagButton(container: HTMLElement): HTMLButtonElement {
  if (bullFlagButtonEl && bullFlagButtonEl.parentElement === container) return bullFlagButtonEl;
  if (bullFlagButtonEl && bullFlagButtonEl.parentElement) {
    bullFlagButtonEl.parentElement.removeChild(bullFlagButtonEl);
  }

  const btn = document.createElement('button');
  btn.className = 'pane-btn label bull-flag-indicator-btn';
  btn.type = 'button';
  btn.textContent = 'B';
  btn.style.position = 'absolute';
  btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX + PANE_TOOL_BUTTON_SIZE_PX + PANE_TOOL_BUTTON_GAP_PX}px`;
  btn.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
  btn.style.zIndex = '34';
  btn.style.width = 'auto';
  btn.style.minWidth = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.padding = '0 5px';
  btn.style.color = tc().textMuted;
  btn.style.fontSize = '12px';
  btn.style.fontWeight = '700';
  btn.style.letterSpacing = '0.5px';
  btn.style.lineHeight = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
  btn.style.pointerEvents = 'auto';
  container.appendChild(btn);
  bullFlagButtonEl = btn;
  return btn;
}

export function updateBullFlagButton(entry: VDFCacheEntry): void {
  if (!bullFlagButtonEl) return;
  const confidence = entry.bull_flag_confidence;
  if (confidence !== null && confidence !== undefined && confidence >= 50) {
    bullFlagButtonEl.textContent = 'B';
    bullFlagButtonEl.style.color = '#4caf50';
    bullFlagButtonEl.style.borderColor = '#4caf50';
    bullFlagButtonEl.title = `Bull flag (${confidence}%)`;
  } else {
    bullFlagButtonEl.textContent = 'B';
    bullFlagButtonEl.style.color = tc().textMuted;
    bullFlagButtonEl.style.borderColor = '';
    bullFlagButtonEl.title = '';
  }
}

// ---------------------------------------------------------------------------
// VD Zone overlay
// ---------------------------------------------------------------------------

export function ensureVDZoneOverlay(container: HTMLElement): HTMLDivElement {
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

export function renderVDZones(entry?: VDFCacheEntry | null): void {
  if (!vdZoneOverlayEl) return;
  vdZoneOverlayEl.innerHTML = '';
  const priceChart = getPriceChart();
  if (!priceChart || !entry) return;

  const overlayWidth = vdZoneOverlayEl.clientWidth || vdZoneOverlayEl.offsetWidth;
  const overlayHeight = vdZoneOverlayEl.clientHeight || vdZoneOverlayEl.offsetHeight;
  if (!Number.isFinite(overlayWidth) || overlayWidth <= 0) return;

  // Build lookup from YYYY-MM-DD (ET) → actual bar time value.
  const currentBars = getCurrentBars();
  const dateToBarTime = new Map<string, number>();
  for (const bar of currentBars) {
    const t = unixSecondsFromTimeValue(bar?.time);
    if (t === null) continue;
    const dateKey = new Date(t * 1000).toLocaleDateString('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (!dateToBarTime.has(dateKey)) dateToBarTime.set(dateKey, t);
  }

  const dateToX = (dateStr: string): number | null => {
    const barTime = dateToBarTime.get(dateStr);
    if (barTime === undefined) return null;
    const x = priceChart!.timeScale().timeToCoordinate(barTime as any);
    return Number.isFinite(x) ? x : null;
  };

  // --- Full-height tinted overlays (use allZones for 1yr visual coverage) ---
  const overlayZones = entry.allZones && entry.allZones.length > 0 ? entry.allZones : entry.zones;
  if (overlayZones) {
    for (const zone of overlayZones) {
      const x1 = dateToX(zone.startDate);
      const x2 = dateToX(zone.endDate);
      if (x1 === null || x2 === null) continue;
      const left = Math.min(x1, x2);
      const width = Math.abs(x2 - x1);
      if (left > overlayWidth || left + width < 0) continue;

      const opacity = 0.04 + zone.score * 0.08;
      const rect = document.createElement('div');
      rect.style.cssText = `position:absolute;left:${Math.round(left)}px;top:0;width:${Math.max(Math.round(width), 2)}px;height:100%;background:rgba(38,166,154,${opacity.toFixed(3)});border-left:1px solid rgba(38,166,154,0.3);border-right:1px solid rgba(38,166,154,0.3);`;

      const badge = document.createElement('div');
      badge.style.cssText =
        'position:absolute;top:2px;right:2px;font-size:9px;color:rgba(38,166,154,0.8);font-family:monospace;';
      badge.textContent = (zone.score * 100).toFixed(0);
      rect.appendChild(badge);
      vdZoneOverlayEl.appendChild(rect);
    }
  }

  if (entry.distribution) {
    for (const dist of entry.distribution) {
      const x1 = dateToX(dist.startDate);
      const x2 = dateToX(dist.endDate);
      if (x1 === null || x2 === null) continue;
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
  const hasZones = overlayZones && overlayZones.length > 0;
  const hasDist = entry.distribution && entry.distribution.length > 0;

  if (overlayHeight > 60 && (hasZones || hasDist)) {
    const absY = overlayHeight - STRIP_PAD - BAND_H;
    const distY = absY - BAND_GAP - BAND_H;
    const accumY = distY - BAND_GAP - BAND_H;

    // Accumulation zone bands (teal)
    if (overlayZones) {
      for (const zone of overlayZones) {
        const x1 = dateToX(zone.startDate);
        const x2 = dateToX(zone.endDate);
        if (x1 === null || x2 === null) continue;
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
        if (x1 === null || x2 === null) continue;
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        if (left > overlayWidth || left + width < 0) continue;
        const band = document.createElement('div');
        band.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${distY}px;width:${Math.max(Math.round(width), 2)}px;height:${BAND_H}px;background:rgba(239,83,80,0.65);border-radius:1px;`;
        vdZoneOverlayEl.appendChild(band);
      }
    }

    // Absorption bands (amber)
    if (overlayZones) {
      for (const zone of overlayZones) {
        const absPct = zone.absorptionPct || 0;
        if (absPct < 5) continue;
        const x1 = dateToX(zone.startDate);
        const x2 = dateToX(zone.endDate);
        if (x1 === null || x2 === null) continue;
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
  if (overlayZones) {
    for (const zone of overlayZones) {
      const xs = dateToX(zone.startDate);
      const xe = dateToX(zone.endDate);
      if (xs !== null && xs >= 0 && xs <= overlayWidth) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${Math.round(xs)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(38,166,154,0.25);`;
        vdZoneOverlayEl.appendChild(line);
      }
      if (xe !== null && xe >= 0 && xe <= overlayWidth) {
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
      if (xs !== null && xs >= 0 && xs <= overlayWidth) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${Math.round(xs)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(239,83,80,0.2);`;
        vdZoneOverlayEl.appendChild(line);
      }
      if (xe !== null && xe >= 0 && xe <= overlayWidth) {
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:${Math.round(xe)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(239,83,80,0.2);`;
        vdZoneOverlayEl.appendChild(line);
      }
    }
  }
}

export function refreshVDZones(): void {
  if (!vdZoneOverlayEl) return;
  const currentChartTicker = getCurrentTicker();
  if (!currentChartTicker) return;
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const cached = vdfResultCache.get(`${currentChartTicker}|${today}`);
  if (cached) renderVDZones(cached);
  else renderVDZones(null);
}

// ---------------------------------------------------------------------------
// VDF detection
// ---------------------------------------------------------------------------

export async function runVDFDetection(ticker: string, force = false): Promise<void> {
  if (!ticker) return;
  if (vdfLoadingForTicker === ticker && !force) return;

  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const cacheKey = `${ticker}|${today}`;
  if (!force && vdfResultCache.has(cacheKey)) {
    const cached = vdfResultCache.get(cacheKey)!;
    updateVDFButton(cached);
    updateBullFlagButton(cached);
    renderVDZones(cached);
    renderVDFAnalysisPanel(cached, ticker);
    return;
  }

  vdfLoadingForTicker = ticker;
  setVDFButtonColor(VDF_COLOR_LOADING(), 'VDF: Loading...');

  try {
    const params = new URLSearchParams({ ticker, mode: 'chart' });
    if (force) params.set('force', '1');
    const response = await fetch(`/api/chart/vdf-status?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();

    const currentChartTicker = getCurrentTicker();
    if (currentChartTicker !== ticker) return;

    const entry: VDFCacheEntry = {
      is_detected: result.is_detected || false,
      composite_score: Number(result.composite_score) || 0,
      status: result.status || '',
      weeks: Number(result.weeks) || 0,
      bull_flag_confidence:
        result.bull_flag_confidence !== null && result.bull_flag_confidence !== undefined
          ? Number(result.bull_flag_confidence)
          : null,
      zones: Array.isArray(result.zones) ? result.zones : [],
      allZones: Array.isArray(result.allZones) ? result.allZones : Array.isArray(result.zones) ? result.zones : [],
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
    updateBullFlagButton(entry);
    renderVDZones(entry);
    renderVDFAnalysisPanel(entry, ticker);
  } catch {
    const currentChartTicker = getCurrentTicker();
    if (currentChartTicker === ticker) {
      setVDFButtonColor(VDF_COLOR_ERROR, 'VDF: Failed to load');
    }
  } finally {
    if (vdfLoadingForTicker === ticker) vdfLoadingForTicker = null;
  }
}

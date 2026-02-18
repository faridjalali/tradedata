/**
 * Mini-chart management — hover overlay (desktop), inline charts (mobile),
 * bar prefetching, and data cache.
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi } from 'lightweight-charts';
import { getThemeColors } from './theme';
import { detectBullFlag } from '../shared/bullFlagDetector';
import { isMobileTouch } from './chart';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OHLC = { time: string | number; open: number; high: number; low: number; close: number };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINI_CHART_CACHE_MAX = 400;

/** Green flag/pennant icon SVG (24x24). Shown when a bull flag/pennant is detected. */
const BULL_FLAG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#26a69a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="2" x2="4" y2="22"/><path d="M4 2 L20 7 L4 12 Z" fill="#26a69a" fill-opacity="0.35" stroke="#26a69a"/></svg>`;

// ---------------------------------------------------------------------------
// Module-level state — hover overlay
// ---------------------------------------------------------------------------

let miniChartOverlayEl: HTMLDivElement | null = null;
let miniChartInstance: IChartApi | null = null;
let miniChartHoverTimer: number | null = null;
let miniChartAbortController: AbortController | null = null;
let miniChartCurrentTicker: string | null = null;
let miniChartHoveredCard: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Shared cache
// ---------------------------------------------------------------------------

export const miniChartDataCache = new Map<string, OHLC[]>();
let miniChartPrefetchInFlight = false;

// ---------------------------------------------------------------------------
// Module-level state — inline charts (mobile)
// ---------------------------------------------------------------------------

/** Keyed by wrapper element (not ticker) so duplicate tickers each get their own chart. */
const inlineChartInstances = new Map<HTMLElement, IChartApi>();
/** Wrappers with a fetch already in flight — prevents duplicate requests. */
const inlineChartPending = new Set<HTMLElement>();
let inlineChartObserver: IntersectionObserver | null = null;
let inlineChartSweepTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

function evictMiniChartCache(keepCount: number): void {
  if (miniChartDataCache.size <= keepCount) return;
  const excess = miniChartDataCache.size - keepCount;
  const iter = miniChartDataCache.keys();
  for (let i = 0; i < excess; i++) {
    const key = iter.next().value;
    if (key !== undefined) miniChartDataCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Prefetch
// ---------------------------------------------------------------------------

export async function prefetchMiniChartBars(tickers: string[]): Promise<void> {
  if (miniChartPrefetchInFlight || tickers.length === 0) return;
  const needed = tickers.filter((t) => !miniChartDataCache.has(t.toUpperCase()));
  if (needed.length === 0) return;

  miniChartPrefetchInFlight = true;
  try {
    const res = await fetch(`/api/chart/mini-bars/batch?tickers=${encodeURIComponent(needed.join(','))}`);
    if (!res.ok) return;
    const data = await res.json();
    const results: Record<string, OHLC[]> = data?.results || {};
    for (const [ticker, bars] of Object.entries(results)) {
      if (Array.isArray(bars) && bars.length > 0) {
        miniChartDataCache.set(ticker.toUpperCase(), bars);
      }
    }
    evictMiniChartCache(MINI_CHART_CACHE_MAX);
  } catch {
    // silent — prefetch is best-effort
  } finally {
    miniChartPrefetchInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Hover overlay — desktop
// ---------------------------------------------------------------------------

export function destroyMiniChartOverlay(): void {
  if (miniChartHoverTimer !== null) {
    window.clearTimeout(miniChartHoverTimer);
    miniChartHoverTimer = null;
  }
  if (miniChartAbortController) {
    try {
      miniChartAbortController.abort();
    } catch {
      /* ignore */
    }
    miniChartAbortController = null;
  }
  if (miniChartInstance) {
    try {
      miniChartInstance.remove();
    } catch {
      /* ignore */
    }
    miniChartInstance = null;
  }
  if (miniChartOverlayEl) {
    miniChartOverlayEl.remove();
    miniChartOverlayEl = null;
  }
  miniChartCurrentTicker = null;
  miniChartHoveredCard = null;
}

export async function showMiniChartOverlay(ticker: string, cardRect: DOMRect, isTouch = false): Promise<void> {
  if (miniChartCurrentTicker === ticker && miniChartOverlayEl) return;
  destroyMiniChartOverlay();
  miniChartCurrentTicker = ticker;

  // Create overlay element
  const overlay = document.createElement('div');
  overlay.className = 'mini-chart-overlay';

  // On touch/mobile: 50% screen width, right-aligned
  const isMobile = isTouch || window.innerWidth < 768;
  const OVERLAY_W = isMobile ? Math.floor(window.innerWidth * 0.5) : 500;
  const OVERLAY_H = isMobile ? Math.floor(OVERLAY_W * 0.6) : 300;

  const _tc = getThemeColors();
  overlay.style.cssText = `
        position: fixed;
        width: ${OVERLAY_W}px;
        height: ${OVERLAY_H}px;
        background: ${_tc.bgColor};
        border: 1px solid ${_tc.borderColor};
        border-radius: 6px;
        z-index: 1000;
        pointer-events: none;
        overflow: hidden;
        box-shadow: 0 8px 24px ${_tc.shadowColor};
    `;

  // Position
  const GAP = 8;
  let left: number;
  let top: number;
  if (isMobile) {
    // Right-aligned against screen edge
    left = window.innerWidth - OVERLAY_W;
    top = cardRect.bottom + GAP;
    if (top + OVERLAY_H > window.innerHeight) {
      top = cardRect.top - OVERLAY_H - GAP;
    }
  } else {
    // Desktop: prefer right of card, fall back to left
    left = cardRect.right + GAP;
    top = cardRect.top;
    if (left + OVERLAY_W > window.innerWidth) {
      left = cardRect.left - OVERLAY_W - GAP;
    }
  }
  if (left < 0) left = 0;
  if (top + OVERLAY_H > window.innerHeight) {
    top = window.innerHeight - OVERLAY_H - GAP;
  }
  if (top < 0) top = GAP;

  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
  document.body.appendChild(overlay);
  miniChartOverlayEl = overlay;

  // Fetch cached daily bars from server (populated during daily/weekly scans)
  let bars: OHLC[];
  const cached = miniChartDataCache.get(ticker);
  if (cached) {
    bars = cached;
  } else {
    const controller = new AbortController();
    miniChartAbortController = controller;
    try {
      const res = await fetch(`/api/chart/mini-bars?ticker=${encodeURIComponent(ticker)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      bars = Array.isArray(data?.bars) ? data.bars : [];
      if (bars.length > 0) miniChartDataCache.set(ticker, bars);
    } catch {
      if (miniChartCurrentTicker === ticker) destroyMiniChartOverlay();
      return;
    }
    miniChartAbortController = null;
  }

  // Guard: overlay may have been destroyed during await
  if (miniChartCurrentTicker !== ticker || !miniChartOverlayEl) return;

  if (bars.length === 0) {
    destroyMiniChartOverlay();
    return;
  }

  // Create lightweight-charts instance
  const chart = createChart(overlay, {
    width: OVERLAY_W,
    height: OVERLAY_H,
    layout: {
      background: { color: _tc.bgColor },
      textColor: _tc.textPrimary,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      attributionLogo: false,
    },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { visible: false },
    timeScale: { visible: false },
    handleScroll: false,
    handleScale: false,
    crosshair: {
      vertLine: { visible: false },
      horzLine: { visible: false },
    },
  });
  miniChartInstance = chart;

  // Candlestick series
  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceLineVisible: false,
    lastValueVisible: false,
  });
  candleSeries.setData(bars as any);
  chart.timeScale().fitContent();

  // Bull flag / pennant detection — show icon if pattern detected
  const flagDetection = detectBullFlag(bars);
  if (flagDetection) {
    const icon = document.createElement('div');
    icon.className = 'mini-chart-bull-flag-icon';
    icon.innerHTML = BULL_FLAG_ICON_SVG;
    icon.title = `Bull flag/pennant detected (confidence: ${flagDetection.confidence}%)`;
    overlay.appendChild(icon);
  }
}

// ---------------------------------------------------------------------------
// Hover overlay state accessors (for event delegation module)
// ---------------------------------------------------------------------------

export function getMiniChartHoveredCard(): HTMLElement | null {
  return miniChartHoveredCard;
}

export function setMiniChartHoveredCard(card: HTMLElement | null): void {
  miniChartHoveredCard = card;
}

export function getMiniChartHoverTimer(): number | null {
  return miniChartHoverTimer;
}

export function setMiniChartHoverTimer(timer: number | null): void {
  if (miniChartHoverTimer !== null) {
    window.clearTimeout(miniChartHoverTimer);
  }
  miniChartHoverTimer = timer;
}

// ---------------------------------------------------------------------------
// Inline mini-charts — mobile
// ---------------------------------------------------------------------------

function isMobileMinichartEnabled(): boolean {
  return isMobileTouch && localStorage.getItem('minichart_mobile') === 'on';
}

/** Load (or fetch-then-create) the inline chart for a wrapper already in/near the viewport. */
function loadChartForWrapper(wrapper: HTMLElement, ticker: string): void {
  if (inlineChartInstances.has(wrapper) || inlineChartPending.has(wrapper)) return;
  const cached = miniChartDataCache.get(ticker.toUpperCase());
  if (cached && cached.length > 0) {
    createInlineChart(wrapper, ticker, cached);
  } else {
    inlineChartPending.add(wrapper);
    fetch(`/api/chart/mini-bars?ticker=${encodeURIComponent(ticker)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        inlineChartPending.delete(wrapper);
        const bars = Array.isArray(data?.bars) ? data.bars : [];
        if (bars.length > 0) {
          miniChartDataCache.set(ticker.toUpperCase(), bars);
          if (wrapper.isConnected && !inlineChartInstances.has(wrapper)) {
            createInlineChart(wrapper, ticker, bars);
          }
        }
      })
      .catch(() => { inlineChartPending.delete(wrapper); });
  }
}

function getInlineChartObserver(): IntersectionObserver {
  if (inlineChartObserver) return inlineChartObserver;
  inlineChartObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const wrapper = entry.target as HTMLElement;
        const ticker = wrapper.dataset.ticker;
        if (!ticker) continue;

        if (entry.isIntersecting) {
          loadChartForWrapper(wrapper, ticker);
        } else {
          // Left viewport zone — destroy chart to free memory
          const chart = inlineChartInstances.get(wrapper);
          if (chart) {
            try { chart.remove(); } catch { /* ignore */ }
            inlineChartInstances.delete(wrapper);
            wrapper.innerHTML = '';
            delete wrapper.dataset.minichartLoaded;
          }
        }
      }
    },
    {
      // Create charts 300px before they scroll into view, destroy 300px after leaving
      rootMargin: '300px 0px 300px 0px',
      threshold: 0,
    },
  );
  return inlineChartObserver;
}

function createInlineChart(wrapper: HTMLElement, _ticker: string, bars: OHLC[]): void {
  let attempts = 0;
  const tryCreate = () => {
    if (!wrapper.isConnected || inlineChartInstances.has(wrapper)) return;
    const w = wrapper.clientWidth || wrapper.getBoundingClientRect().width || 0;
    const h = wrapper.clientHeight || 120;
    if (w <= 0) {
      // Layout not ready — retry with increasing backoff (up to 4 attempts)
      attempts++;
      if (attempts < 5) {
        setTimeout(tryCreate, attempts * 120);
      }
      return;
    }
    const _tc = getThemeColors();
    const chart = createChart(wrapper, {
      width: w,
      height: h,
      layout: {
        background: { color: _tc.bgColor },
        textColor: _tc.textPrimary,
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    series.setData(bars as any);
    chart.timeScale().fitContent();
    inlineChartInstances.set(wrapper, chart);
    wrapper.dataset.minichartLoaded = '1';
  };
  requestAnimationFrame(tryCreate);
}

function removeInlineMinicharts(container: HTMLElement): void {
  const observer = inlineChartObserver;
  const wrappers = container.querySelectorAll<HTMLElement>('.inline-minichart');
  for (const wrapper of wrappers) {
    if (observer) observer.unobserve(wrapper);
    inlineChartPending.delete(wrapper);
    const chart = inlineChartInstances.get(wrapper);
    if (chart) {
      try { chart.remove(); } catch { /* ignore */ }
      inlineChartInstances.delete(wrapper);
    }
    wrapper.remove();
  }
}

/**
 * Sweep all visible unloaded wrappers and try to create their charts.
 * Called on a delayed schedule after initial render to catch anything that
 * slipped through the IntersectionObserver on iOS.
 */
function sweepUnloadedVisible(): void {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const margin = 400;
  const wrappers = document.querySelectorAll<HTMLElement>('.inline-minichart:not([data-minichart-loaded])');
  for (const wrapper of wrappers) {
    if (!wrapper.isConnected) continue;
    const ticker = wrapper.dataset.ticker;
    if (!ticker) continue;
    const rect = wrapper.getBoundingClientRect();
    if (rect.top < vh + margin && rect.bottom > -margin) {
      loadChartForWrapper(wrapper, ticker);
    }
  }
}

export function renderInlineMinicharts(container: HTMLElement): void {
  if (!isMobileMinichartEnabled()) {
    removeInlineMinicharts(container);
    return;
  }
  // Cancel any pending sweep from a previous render call
  if (inlineChartSweepTimer !== null) {
    clearTimeout(inlineChartSweepTimer);
    inlineChartSweepTimer = null;
  }
  const observer = getInlineChartObserver();
  const cards = container.querySelectorAll<HTMLElement>('.alert-card');
  for (const card of cards) {
    const ticker = card.dataset.ticker;
    if (!ticker) continue;
    // Skip if inline minichart already exists right after this card
    const next = card.nextElementSibling;
    if (next && next.classList.contains('inline-minichart') && (next as HTMLElement).dataset.ticker === ticker)
      continue;

    const wrapper = document.createElement('div');
    wrapper.className = 'inline-minichart';
    wrapper.dataset.ticker = ticker;
    card.after(wrapper);
    observer.observe(wrapper);
  }
  // iOS Safari does not reliably fire IntersectionObserver for elements already in
  // the viewport. Run a sweep at increasing delays to catch anything missed.
  // Delay the first sweep so the DOM/layout has settled after all wrappers are inserted.
  const runSweeps = () => {
    sweepUnloadedVisible();
    inlineChartSweepTimer = setTimeout(() => {
      sweepUnloadedVisible();
      inlineChartSweepTimer = setTimeout(() => {
        sweepUnloadedVisible();
        inlineChartSweepTimer = null;
      }, 1000);
    }, 400);
  };
  inlineChartSweepTimer = setTimeout(runSweeps, 150);
}

/** Update theme colors on all live inline charts when the theme changes. */
function refreshInlineMinichartThemes(): void {
  const _tc = getThemeColors();
  for (const [, chart] of inlineChartInstances) {
    try {
      chart.applyOptions({
        layout: {
          background: { color: _tc.bgColor },
          textColor: _tc.textPrimary,
        },
      });
    } catch { /* ignore */ }
  }
}

window.addEventListener('themechange', refreshInlineMinichartThemes);

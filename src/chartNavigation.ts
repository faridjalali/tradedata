/**
 * Chart ticker navigation — prev/next navigation and pane axis double-click.
 * Resolves the circular dependency between chart.ts and main.ts by using
 * runtime callback injection instead of a direct import.
 */

import { paneOrder, normalizePaneOrder } from './chartTypes';
import { appStore } from './store/appStore';
import { divergenceStore } from './store/divergenceStore';
import { createAlertSortFn } from './utils';
import type { Alert } from './types';

// ---------------------------------------------------------------------------
// Callback injection (set by main.ts at init time)
// ---------------------------------------------------------------------------

type TickerListContext = string | null;

let getTickerListContextCb: () => TickerListContext = () => null;
let getTickerOriginViewCb: () => string = () => 'divergence';

export function setChartNavigationCallbacks(getContext: () => TickerListContext, getOriginView: () => string): void {
  getTickerListContextCb = getContext;
  getTickerOriginViewCb = getOriginView;
}

function inferContextFromContainerId(containerId: string): 'daily' | 'weekly' | null {
  if (containerId.includes('daily')) return 'daily';
  if (containerId.includes('weekly')) return 'weekly';
  return null;
}

function resolveNavigationList(
  currentTicker: string,
  context: TickerListContext,
  origin: string,
): { cards: HTMLElement[]; currentIndex: number; inferredContext: 'daily' | 'weekly' | null } | null {
  const preferredIds: string[] = [];
  const fallbackIds: string[] = [];

  if (origin === 'divergence') {
    if (context === 'daily') preferredIds.push('divergence-daily-container', 'daily-container');
    if (context === 'weekly') preferredIds.push('divergence-weekly-container', 'weekly-container');
    fallbackIds.push(
      'divergence-daily-container',
      'divergence-weekly-container',
      'daily-container',
      'weekly-container',
    );
  } else {
    if (context === 'daily') preferredIds.push('daily-container', 'divergence-daily-container');
    if (context === 'weekly') preferredIds.push('weekly-container', 'divergence-weekly-container');
    fallbackIds.push(
      'daily-container',
      'weekly-container',
      'divergence-daily-container',
      'divergence-weekly-container',
    );
  }

  const orderedContainerIds = Array.from(new Set([...preferredIds, ...fallbackIds]));
  for (const containerId of orderedContainerIds) {
    const container = document.getElementById(containerId);
    if (!container) continue;
    const cards = Array.from(container.querySelectorAll('.alert-card')) as HTMLElement[];
    if (!cards.length) continue;
    const uniqueTickers = new Set(
      cards
        .map((card) =>
          String(card.dataset.ticker || '')
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    );
    // Ignore single-ticker containers (e.g., ticker history panes).
    if (uniqueTickers.size <= 1) continue;
    const currentIndex = cards.findIndex((card) => String(card.dataset.ticker || '').toUpperCase() === currentTicker);
    if (currentIndex === -1) continue;
    return {
      cards,
      currentIndex,
      inferredContext: inferContextFromContainerId(containerId),
    };
  }
  return null;
}

function filterToLatestNDates(alerts: Alert[], n: number): Alert[] {
  const dates = new Set<string>();
  for (const a of alerts) {
    const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
    if (d) dates.add(d);
  }
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  const topN = new Set(sorted.slice(0, n));
  return alerts.filter((a) => {
    const d = a.signal_trade_date || (a.timestamp ? a.timestamp.slice(0, 10) : null);
    return d ? topN.has(d) : false;
  });
}

function getSortedTickerSequenceFromStore(column: 'daily' | 'weekly'): string[] {
  const store = divergenceStore.getState();
  const columnState = store.getColumn(column);
  const timeframe = column === 'daily' ? '1d' : '1w';
  let alerts = store.signals.filter((a) => (a.timeframe || '').trim() === timeframe);

  if (columnState.feedMode === '1') alerts = filterToLatestNDates(alerts, 1);
  if (columnState.feedMode === '5') alerts = filterToLatestNDates(alerts, 5);
  if (columnState.feedMode === '30') alerts = filterToLatestNDates(alerts, 30);
  if (columnState.sortMode === 'favorite') alerts = alerts.filter((a) => a.is_favorite);

  alerts.sort(
    createAlertSortFn(columnState.sortMode === 'favorite' ? 'time' : columnState.sortMode, columnState.sortDirection),
  );

  const tickers: string[] = [];
  const seen = new Set<string>();
  for (const alert of alerts) {
    const ticker = String(alert.ticker || '')
      .trim()
      .toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    tickers.push(ticker);
  }
  return tickers;
}

function resolveNavigationFromStore(
  currentTicker: string,
  context: TickerListContext,
): { tickers: string[]; currentIndex: number; inferredContext: 'daily' | 'weekly' } | null {
  const contextsToTry: Array<'daily' | 'weekly'> =
    context === 'daily' ? ['daily', 'weekly'] : context === 'weekly' ? ['weekly', 'daily'] : ['daily', 'weekly'];

  for (const ctx of contextsToTry) {
    const tickers = getSortedTickerSequenceFromStore(ctx);
    if (!tickers.length) continue;
    const currentIndex = tickers.indexOf(currentTicker);
    if (currentIndex === -1) continue;
    return { tickers, currentIndex, inferredContext: ctx };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export function navigateChart(direction: -1 | 1): void {
  const context = getTickerListContextCb();
  const origin = getTickerOriginViewCb();
  const currentTicker = String(appStore.getState().selectedTicker || '')
    .trim()
    .toUpperCase();

  if (!currentTicker) return;

  const list = resolveNavigationList(currentTicker, context, origin);
  const storeList = list ? null : resolveNavigationFromStore(currentTicker, context);
  if (!list && !storeList) return;

  if (list) {
    const nextIndex = list.currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= list.cards.length) return;
    const nextCard = list.cards[nextIndex];
    const nextTicker = nextCard.dataset.ticker;
    if (!nextTicker || !(window as any).showTickerView) return;
    const nextContext = list.inferredContext || (context === 'daily' || context === 'weekly' ? context : null);
    (window as any).showTickerView(nextTicker, origin, nextContext);
    return;
  }

  const nextIndex = storeList!.currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < storeList!.tickers.length && (window as any).showTickerView) {
    (window as any).showTickerView(storeList!.tickers[nextIndex], origin, storeList!.inferredContext);
  }
}

export function getNeighborTicker(direction: -1 | 1): string | null {
  const context = getTickerListContextCb();
  const origin = getTickerOriginViewCb();
  const currentTicker = String(appStore.getState().selectedTicker || '')
    .trim()
    .toUpperCase();

  if (!currentTicker) return null;
  const list = resolveNavigationList(currentTicker, context, origin);
  if (list) {
    const nextIndex = list.currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < list.cards.length) {
      return list.cards[nextIndex].dataset.ticker || null;
    }
    return null;
  }

  const storeList = resolveNavigationFromStore(currentTicker, context);
  if (!storeList) return null;
  const nextIndex = storeList.currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < storeList.tickers.length) {
    return storeList.tickers[nextIndex] || null;
  }
  return null;
}

export function initPaneAxisNavigation(): void {
  const container = document.getElementById('custom-chart-container');
  if (!container) return;
  if (container.dataset.axisNavBound === '1') return;
  container.dataset.axisNavBound = '1';

  const handleAxisNavigationTap = (clientX: number, clientY: number): boolean => {
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;

    const isRightSide = x > rect.width - 60;
    if (!isRightSide) return false;

    const currentOrder = normalizePaneOrder(paneOrder);
    const pane3Id = currentOrder[2];
    const pane4Id = currentOrder[3];

    const getPaneRect = (id: string) => {
      const el = document.getElementById(id);
      if (!el || el.style.display === 'none') return null;
      return el.getBoundingClientRect();
    };

    const pane3Rect = getPaneRect(pane3Id);
    if (pane3Rect && clientY >= pane3Rect.top && clientY <= pane3Rect.bottom) {
      navigateChart(1);
      return true;
    }

    const pane4Rect = getPaneRect(pane4Id);
    if (pane4Rect && clientY >= pane4Rect.top && clientY <= pane4Rect.bottom) {
      navigateChart(-1);
      return true;
    }

    return false;
  };

  container.addEventListener('dblclick', (e) => {
    const handled = handleAxisNavigationTap(e.clientX, e.clientY);
    if (!handled) return;
    e.preventDefault();
  });

  // Touch equivalent: double-tap on the right y-axis area of pane 3/4.
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  container.addEventListener(
    'touchend',
    (e) => {
      const touch = e.changedTouches?.[0];
      if (!touch) return;

      const now = Date.now();
      const elapsed = now - lastTapTime;
      const distance = Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY);
      const isDoubleTap = elapsed > 0 && elapsed < 350 && distance < 28;

      lastTapTime = now;
      lastTapX = touch.clientX;
      lastTapY = touch.clientY;

      if (!isDoubleTap) return;
      const handled = handleAxisNavigationTap(touch.clientX, touch.clientY);
      if (!handled) return;

      // Stop the chart-wide double-tap handler from toggling crosshair.
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { passive: false },
  );
}

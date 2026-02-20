/**
 * Chart ticker navigation — prev/next navigation and pane axis double-click.
 * Resolves the circular dependency between chart.ts and main.ts by using
 * runtime callback injection instead of a direct import.
 */

import { paneOrder, normalizePaneOrder } from './chartTypes';
import { appStore } from './store/appStore';

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
    if (context === 'daily')
      preferredIds.push('divergence-daily-container', 'ticker-daily-container', 'daily-container');
    if (context === 'weekly')
      preferredIds.push('divergence-weekly-container', 'ticker-weekly-container', 'weekly-container');
    fallbackIds.push(
      'divergence-daily-container',
      'divergence-weekly-container',
      'ticker-daily-container',
      'ticker-weekly-container',
      'daily-container',
      'weekly-container',
    );
  } else {
    if (context === 'daily')
      preferredIds.push('daily-container', 'ticker-daily-container', 'divergence-daily-container');
    if (context === 'weekly')
      preferredIds.push('weekly-container', 'ticker-weekly-container', 'divergence-weekly-container');
    fallbackIds.push(
      'daily-container',
      'weekly-container',
      'ticker-daily-container',
      'ticker-weekly-container',
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
  if (!list) return;

  const nextIndex = list.currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < list.cards.length) {
    const nextCard = list.cards[nextIndex];
    const nextTicker = nextCard.dataset.ticker;
    if (nextTicker && (window as any).showTickerView) {
      const nextContext = list.inferredContext || (context === 'daily' || context === 'weekly' ? context : null);
      (window as any).showTickerView(nextTicker, origin, nextContext);
    }
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
  if (!list) return null;

  const nextIndex = list.currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < list.cards.length) {
    return list.cards[nextIndex].dataset.ticker || null;
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

/**
 * Chart ticker navigation — prev/next navigation and pane axis double-click.
 * Resolves the circular dependency between chart.ts and main.ts by using
 * runtime callback injection instead of a direct import.
 */

import { paneOrder, normalizePaneOrder } from './chartTypes';

// ---------------------------------------------------------------------------
// Callback injection (set by main.ts at init time)
// ---------------------------------------------------------------------------

type TickerListContext = string | null;

let getTickerListContextCb: () => TickerListContext = () => null;
let getTickerOriginViewCb: () => string = () => 'divergence';

export function setChartNavigationCallbacks(
  getContext: () => TickerListContext,
  getOriginView: () => string,
): void {
  getTickerListContextCb = getContext;
  getTickerOriginViewCb = getOriginView;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export function navigateChart(direction: -1 | 1): void {
  const context = getTickerListContextCb();
  const origin = getTickerOriginViewCb();
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
  const currentIndex = cards.findIndex((c) => c.dataset.ticker === currentTicker);

  if (currentIndex === -1) return;

  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < cards.length) {
    const nextCard = cards[nextIndex];
    const nextTicker = nextCard.dataset.ticker;
    if (nextTicker && (window as any).showTickerView) {
      // Keep the same context
      (window as any).showTickerView(nextTicker, origin, context);
    }
  }
}

export function getNeighborTicker(direction: -1 | 1): string | null {
  const context = getTickerListContextCb();
  const origin = getTickerOriginViewCb();
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
  const currentIndex = cards.findIndex((c) => c.dataset.ticker === currentTicker);

  if (currentIndex === -1) return null;

  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < cards.length) {
    return cards[nextIndex].dataset.ticker || null;
  }
  return null;
}

export function initPaneAxisNavigation(): void {
  const container = document.getElementById('custom-chart-container');
  if (!container) return;

  container.addEventListener('dblclick', (e) => {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;

    const isRightSide = x > rect.width - 60;
    if (!isRightSide) return;

    const currentOrder = normalizePaneOrder(paneOrder);
    const pane3Id = currentOrder[2];
    const pane4Id = currentOrder[3];

    const getPaneRect = (id: string) => {
      const el = document.getElementById(id);
      if (!el || el.style.display === 'none') return null;
      return el.getBoundingClientRect();
    };

    const pane3Rect = getPaneRect(pane3Id);
    if (pane3Rect && e.clientY >= pane3Rect.top && e.clientY <= pane3Rect.bottom) {
      navigateChart(1);
      return;
    }

    const pane4Rect = getPaneRect(pane4Id);
    if (pane4Rect && e.clientY >= pane4Rect.top && e.clientY <= pane4Rect.bottom) {
      navigateChart(-1);
      return;
    }
  });
}

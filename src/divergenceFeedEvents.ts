/**
 * Event delegation — click, hover, touch, and custom event handlers for the
 * divergence feed view.
 */

import { isMobileTouch } from './chart';
import {
  toggleDivergenceFavorite,
} from './divergenceApi';
import {
  getDivergenceSignals,
  setDivergenceSignals,
  addPendingFavoriteToggle,
  removePendingFavoriteToggle,
} from './divergenceState';
import {
  showMiniChartOverlay,
  destroyMiniChartOverlay,
  getMiniChartHoveredCard,
  setMiniChartHoveredCard,
  getMiniChartHoverTimer,
  setMiniChartHoverTimer,
  renderInlineMinicharts,
  isMinichartEnabled,
} from './divergenceMinichart';
import {
  setDivergenceDailySort,
  setDivergenceWeeklySort,
  renderDivergenceContainer,
  incrementDailyVisibleCount,
  incrementWeeklyVisibleCount,
} from './divergenceFeedRender';
import { SortMode } from './types';

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

function applyFavIconState(star: Element, isFavorite: boolean): void {
  const checkmark = star.querySelector('.check-mark') as HTMLElement | null;
  if (isFavorite) {
    star.classList.add('filled');
    if (checkmark) {
      checkmark.style.visibility = 'visible';
      checkmark.style.opacity = '1';
    }
  } else {
    star.classList.remove('filled');
    if (checkmark) {
      checkmark.style.visibility = 'hidden';
      checkmark.style.opacity = '0';
    }
  }
}

function handleFavoriteClick(e: Event): void {
  const target = e.target as HTMLElement;
  const starBtn = target.closest('.fav-icon');
  if (!starBtn) return;

  e.stopPropagation();
  const id = (starBtn as HTMLElement).dataset.id;
  const source = 'DataAPI';
  if (!id) return;

  const numericId = Number(id);
  const allStars = document.querySelectorAll(`.fav-icon[data-id="${id}"][data-source="${source}"]`);
  const isCurrentlyFilled = starBtn.classList.contains('filled');
  const optimisticValue = !isCurrentlyFilled;

  // 1. Optimistic DOM update
  allStars.forEach((star) => applyFavIconState(star, optimisticValue));

  // 2. Optimistic in-memory state update — prevents stale re-renders
  const all = getDivergenceSignals();
  const idx = all.findIndex((a) => a.id === numericId);
  if (idx !== -1) {
    all[idx].is_favorite = optimisticValue;
    setDivergenceSignals(all);
  }

  // 3. Track pending toggle so server-refresh doesn't overwrite
  addPendingFavoriteToggle(numericId, optimisticValue);

  toggleDivergenceFavorite(numericId)
    .then((updatedAlert) => {
      // Server confirmed — update in-memory state with authoritative value
      removePendingFavoriteToggle(numericId);
      const current = getDivergenceSignals();
      const curIdx = current.findIndex((a) => a.id === updatedAlert.id);
      if (curIdx !== -1) {
        current[curIdx].is_favorite = updatedAlert.is_favorite;
        setDivergenceSignals(current);
      }
      // Re-apply DOM state (elements may have been replaced by a re-render)
      const freshStars = document.querySelectorAll(`.fav-icon[data-id="${id}"][data-source="${source}"]`);
      freshStars.forEach((star) => applyFavIconState(star, updatedAlert.is_favorite));
    })
    .catch((err) => {
      console.error('Favorite toggle failed:', err);
      // Revert optimistic state on error
      removePendingFavoriteToggle(numericId);
      const current = getDivergenceSignals();
      const curIdx = current.findIndex((a) => a.id === numericId);
      if (curIdx !== -1) {
        current[curIdx].is_favorite = isCurrentlyFilled;
        setDivergenceSignals(current);
      }
      const freshStars = document.querySelectorAll(`.fav-icon[data-id="${id}"][data-source="${source}"]`);
      freshStars.forEach((star) => applyFavIconState(star, isCurrentlyFilled));
    });
}

// ---------------------------------------------------------------------------
// Main event delegation setup
// ---------------------------------------------------------------------------

export function setupDivergenceFeedDelegation(): void {
  const view = document.getElementById('view-divergence');
  if (!view) return;

  // Favorite toggle — attach to both alerts page and ticker page
  view.addEventListener('click', handleFavoriteClick);
  const tickerView = document.getElementById('ticker-view');
  if (tickerView) {
    tickerView.addEventListener('click', handleFavoriteClick);
  }

  // --- Mini-chart overlay state (shared between mouse + touch handlers) ---
  let touchLongPressTimer: number | null = null;
  let touchLongPressFired = false;
  let suppressNextCardClick = false;
  let lastTouchEndMs = 0;

  view.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.fav-icon')) return; // Already handled above

    // After a touch long-press, suppress the subsequent click to prevent navigation
    if (suppressNextCardClick) {
      suppressNextCardClick = false;
      return;
    }

    const card = target.closest('.alert-card') || target.closest('.inline-minichart');
    if (card) {
      const ticker = (card as HTMLElement).dataset.ticker;
      if (ticker && window.showTickerView) {
        // Determine context
        let listContext: 'daily' | 'weekly' | null = null;
        if (card.closest('#divergence-daily-container')) {
          listContext = 'daily';
        } else if (card.closest('#divergence-weekly-container')) {
          listContext = 'weekly';
        }
        window.showTickerView(ticker, 'divergence', listContext);
      }
    }
  });

  // Sort Buttons
  document.querySelectorAll('#view-divergence .divergence-daily-sort .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.sort as SortMode;
      setDivergenceDailySort(mode);
    });
  });

  document.querySelectorAll('#view-divergence .divergence-weekly-sort .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.sort as SortMode;
      setDivergenceWeeklySort(mode);
    });
  });

  // --- Mini-chart hover overlay on alert cards ---
  // Use capture phase because mouseenter/mouseleave don't bubble.
  // Guard with relatedTarget so moves between children within the same card
  // don't destroy/restart the overlay.
  view.addEventListener(
    'mouseenter',
    (e: Event) => {
      // When inline minicharts are enabled, skip hover overlay
      if (isMinichartEnabled()) return;
      // On mobile, never show hover overlay
      if (isMobileTouch) return;
      // Suppress synthetic mouse events generated after touch interactions
      if (Date.now() - lastTouchEndMs < 1000) return;

      const me = e as MouseEvent;
      const target = me.target as HTMLElement;
      const card = target.closest('.alert-card') as HTMLElement | null;
      if (!card) return;
      const ticker = card.dataset.ticker;
      if (!ticker) return;

      // If we're already tracking this card (mouse moved between children), skip
      if (getMiniChartHoveredCard() === card) return;
      setMiniChartHoveredCard(card);

      const currentTimer = getMiniChartHoverTimer();
      if (currentTimer !== null) {
        window.clearTimeout(currentTimer);
      }
      setMiniChartHoverTimer(window.setTimeout(() => {
        setMiniChartHoverTimer(null);
        const rect = card.getBoundingClientRect();
        showMiniChartOverlay(ticker, rect);
      }, 1000));
    },
    true,
  );

  view.addEventListener(
    'mouseleave',
    (e: Event) => {
      const me = e as MouseEvent;
      const target = me.target as HTMLElement;
      const card = target.closest('.alert-card') as HTMLElement | null;
      if (!card) return;
      // If the mouse is moving to another element still within this card, ignore
      const relatedTarget = me.relatedTarget as HTMLElement | null;
      if (relatedTarget && card.contains(relatedTarget)) return;
      setMiniChartHoveredCard(null);
      destroyMiniChartOverlay();
    },
    true,
  );

  // --- Prevent iOS Safari copy/find-selection on long-press ---
  view.addEventListener('contextmenu', (e: Event) => {
    const target = e.target as HTMLElement;
    if (target.closest('.alert-card')) {
      e.preventDefault();
    }
  });
  view.addEventListener('selectstart', (e: Event) => {
    const target = e.target as HTMLElement;
    if (target.closest('.alert-card')) {
      e.preventDefault();
    }
  });

  // --- Touch long-press for minichart overlay (desktop touchscreen only) ---
  if (!isMobileTouch) {
    view.addEventListener(
      'touchstart',
      (e: Event) => {
        if (isMinichartEnabled()) return;
        const te = e as TouchEvent;
        if (te.touches.length !== 1) return;
        const target = te.target as HTMLElement;
        const card = target.closest('.alert-card') as HTMLElement | null;
        if (!card) return;
        const ticker = card.dataset.ticker;
        if (!ticker) return;
        touchLongPressFired = false;
        if (touchLongPressTimer !== null) window.clearTimeout(touchLongPressTimer);
        touchLongPressTimer = window.setTimeout(() => {
          touchLongPressTimer = null;
          touchLongPressFired = true;
          const rect = card.getBoundingClientRect();
          showMiniChartOverlay(ticker, rect, true);
        }, 600);
      },
      { passive: true },
    );

    view.addEventListener(
      'touchmove',
      () => {
        if (touchLongPressTimer !== null) {
          window.clearTimeout(touchLongPressTimer);
          touchLongPressTimer = null;
        }
      },
      { passive: true },
    );

    view.addEventListener(
      'touchend',
      () => {
        if (touchLongPressTimer !== null) {
          window.clearTimeout(touchLongPressTimer);
          touchLongPressTimer = null;
        }
        lastTouchEndMs = Date.now();
        if (touchLongPressFired) {
          destroyMiniChartOverlay();
          suppressNextCardClick = true;
        }
        touchLongPressFired = false;
      },
      { passive: true },
    );

    view.addEventListener(
      'touchcancel',
      () => {
        if (touchLongPressTimer !== null) {
          window.clearTimeout(touchLongPressTimer);
          touchLongPressTimer = null;
        }
        lastTouchEndMs = Date.now();
        if (touchLongPressFired) {
          destroyMiniChartOverlay();
        }
        touchLongPressFired = false;
      },
      { passive: true },
    );
  }

  // --- Minichart setting toggle ---
  window.addEventListener('minichartmobilechange', () => {
    const daily = document.getElementById('divergence-daily-container');
    const weekly = document.getElementById('divergence-weekly-container');
    if (daily) renderInlineMinicharts(daily);
    if (weekly) renderInlineMinicharts(weekly);
  });

  // "Show more" pagination button
  view.addEventListener('click', (e: Event) => {
    const btn = (e.target as HTMLElement).closest('.show-more-btn') as HTMLElement | null;
    if (!btn) return;
    const tf = btn.dataset.timeframe as '1d' | '1w' | undefined;
    if (!tf) return;
    if (tf === '1d') {
      incrementDailyVisibleCount();
      renderDivergenceContainer('1d');
    } else {
      incrementWeeklyVisibleCount();
      renderDivergenceContainer('1w');
    }
  });
}

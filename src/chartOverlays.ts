/**
 * Chart loading/error overlays and theme reapplication.
 * Pure DOM-based functions — no mutable module state.
 */

import { getThemeColors } from './theme';
import { getDivergenceOverlayChart } from './chartDivergencePlot';
import type { TrendToolPane } from './chartTypes';

function tc() {
  return getThemeColors();
}

// ---------------------------------------------------------------------------
// Loading / error overlays
// ---------------------------------------------------------------------------

export function showLoadingOverlay(container: HTMLElement): void {
  // Remove existing overlay if present
  const existingOverlay = container.querySelector('.chart-loading-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  // Create loading overlay
  const overlay = document.createElement('div');
  overlay.className = 'chart-loading-overlay';

  // Create loading spinner
  const spinner = document.createElement('div');
  spinner.className = 'chart-loading-spinner';
  spinner.innerHTML = `<svg class="chart-loading-spinner-svg" viewBox="0 0 40 40" aria-hidden="true">
      <circle class="chart-loading-spinner-circle" cx="20" cy="20" r="16" fill="none" />
    </svg>`;

  overlay.appendChild(spinner);
  container.appendChild(overlay);
}

export function showRetryOverlay(container: HTMLElement, onRetry: () => void): void {
  const existingOverlay = container.querySelector('.chart-loading-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const overlay = document.createElement('div');
  overlay.className = 'chart-loading-overlay is-interactive';

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'chart-retry-btn';
  retryBtn.textContent = 'Try Refreshing';
  retryBtn.addEventListener('click', (event) => {
    event.preventDefault();
    onRetry();
  });

  overlay.appendChild(retryBtn);
  container.appendChild(overlay);
}

export function hideLoadingOverlay(container: HTMLElement): void {
  const overlay = container.querySelector('.chart-loading-overlay');
  if (overlay) {
    overlay.remove();
  }
}

// ---------------------------------------------------------------------------
// Theme reapplication (called on themechange event)
// ---------------------------------------------------------------------------

export function reapplyInlineThemeStyles(): void {
  const c = tc();
  const setBorderBgColor = (el: HTMLElement) => {
    el.style.border = `1px solid ${c.borderColor}`;
    el.style.background = c.cardBg;
    el.style.color = c.textPrimary;
  };

  // Trendline cross labels
  document.querySelectorAll<HTMLElement>('.trendline-cross-label').forEach(setBorderBgColor);

  // Top-pane badges (ticker label, price change)
  document.querySelectorAll<HTMLElement>('.top-pane-badge').forEach((el) => {
    el.style.border = `1px solid ${c.borderColor}`;
    el.style.background = c.cardBg;
    // Price-change badge keeps its semantic green/red color
    if (!el.classList.contains('price-pane-change')) {
      el.style.color = c.textPrimary;
    }
  });

  // Divergence plot overlays
  document.querySelectorAll<HTMLElement>('.divergence-plot-overlay').forEach((el) => {
    el.style.border = `1px solid ${c.borderColor}`;
    el.style.background = c.bgOverlay95;
  });

  // Settings panels (price, rsi, volume-delta, volume-delta-rsi)
  document.querySelectorAll<HTMLElement>('.pane-settings-panel').forEach((panel) => {
    panel.style.background = c.cardBgOverlay95;
    panel.style.border = `1px solid ${c.borderColor}`;
    panel.style.color = c.textPrimary;
    // Inner form elements: buttons, selects, inputs
    panel.querySelectorAll<HTMLElement>('button, select, input[type="number"]').forEach((el) => {
      el.style.background = c.bgColor;
      el.style.color = c.textPrimary;
      el.style.borderColor = c.borderColor;
    });
  });

  // Price pane message
  document.querySelectorAll<HTMLElement>('.price-pane-message').forEach((el) => {
    el.style.color = c.textSecondary;
  });

  // Loading / retry overlays
  document.querySelectorAll<HTMLElement>('.chart-loading-overlay').forEach((el) => {
    const btn = el.querySelector('button') as HTMLElement | null;
    if (btn) {
      btn.style.background = '';
      btn.style.color = '';
      btn.style.borderColor = '';
    }
  });

  // Divergence plot overlay Chart.js instances
  for (const pane of ['rsi', 'volumeDeltaRsi'] as TrendToolPane[]) {
    const chart = getDivergenceOverlayChart(pane);
    if (chart) {
      try {
        chart.options.plugins.tooltip.backgroundColor = c.cardBgOverlay95;
        chart.options.plugins.tooltip.borderColor = c.borderColor;
        chart.options.plugins.tooltip.titleColor = c.textPrimary;
        chart.options.plugins.tooltip.bodyColor = c.textSecondary;
        chart.options.scales.x.ticks.color = c.textSecondary;
        chart.options.scales.x.grid.color = c.borderOverlay22;
        chart.options.scales.y.ticks.color = c.textSecondary;
        chart.options.scales.y.grid.color = c.borderOverlay22;
        chart.update('none');
      } catch {
        /* chart may not be fully initialized */
      }
    }
  }
}

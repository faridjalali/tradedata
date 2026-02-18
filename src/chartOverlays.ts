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
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: ${tc().bgOverlay95};
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: none;
  `;

  // Create loading spinner
  const spinner = document.createElement('div');
  spinner.innerHTML = `
    <svg width="40" height="40" viewBox="0 0 40 40" style="animation: spin 1s linear infinite;">
      <circle cx="20" cy="20" r="16" fill="none" stroke="${tc().spinnerColor}" stroke-width="3"
              stroke-dasharray="80" stroke-dashoffset="60" stroke-linecap="round" opacity="0.8"/>
    </svg>
    <style>
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  `;

  overlay.appendChild(spinner);
  container.appendChild(overlay);
}

export function showRetryOverlay(container: HTMLElement, onRetry: () => void): void {
  const existingOverlay = container.querySelector('.chart-loading-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const overlay = document.createElement('div');
  overlay.className = 'chart-loading-overlay';
  overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: ${tc().bgOverlay95};
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: auto;
  `;

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.textContent = 'Try Refreshing';
  retryBtn.style.background = tc().cardBg;
  retryBtn.style.color = tc().textPrimary;
  retryBtn.style.border = `1px solid ${tc().borderColor}`;
  retryBtn.style.borderRadius = '6px';
  retryBtn.style.padding = '8px 12px';
  retryBtn.style.fontSize = '12px';
  retryBtn.style.fontWeight = '600';
  retryBtn.style.cursor = 'pointer';
  retryBtn.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
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
    el.style.background = c.bgOverlay95;
    const btn = el.querySelector('button') as HTMLElement | null;
    if (btn) {
      btn.style.background = c.cardBg;
      btn.style.color = c.textPrimary;
      btn.style.borderColor = c.borderColor;
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

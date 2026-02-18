/**
 * Divergence plot overlay logic extracted from chart.ts.
 * Manages RSI and Volume-Delta RSI divergence plot overlays using Chart.js.
 */

import { getThemeColors } from './theme';
import { getAppTimeZone, getAppTimeZoneFormatter } from './timezone';
import { unixSecondsFromTimeValue, timeKey } from './chartTimeUtils';
import { rsiSettings, volumeDeltaRsiSettings } from './chartTypes';
import type { ChartInterval } from './chartApi';
import type { TrendToolPane } from './chartTypes';

declare const Chart: any;

// ---------------------------------------------------------------------------
// Callback interface – all chart.ts module-level state is accessed via these
// ---------------------------------------------------------------------------

export interface DivergencePlotCallbacks {
  getCurrentInterval: () => ChartInterval;
  getCurrentBars: () => any[];
  getBarIndexByTime: () => Map<string, number>;
  getRsiByTime: () => Map<string, number>;
  getVolumeDeltaRsiByTime: () => Map<string, number>;
  getRsiDivergenceToolActive: () => boolean;
  setRsiDivergenceToolActive: (v: boolean) => void;
  getVolumeDeltaDivergenceToolActive: () => boolean;
  deactivateVolumeDeltaDivergenceTool: () => void;
  getRsiChart: () => any;
  setPaneTrendlineToolActive: (pane: TrendToolPane, active: boolean) => void;
  setPaneToolButtonActive: (pane: TrendToolPane, action: 'trend' | 'divergence', active: boolean) => void;
}

// ---------------------------------------------------------------------------
// Module-level (own) state
// ---------------------------------------------------------------------------

let rsiDivergenceOverlayEl: HTMLDivElement | null = null;
let volumeDeltaRsiDivergenceOverlayEl: HTMLDivElement | null = null;
let rsiDivergenceOverlayChart: any = null;
let volumeDeltaRsiDivergenceOverlayChart: any = null;
let rsiDivergencePlotToolActive = false;
let volumeDeltaRsiDivergencePlotToolActive = false;
let rsiDivergencePlotSelected = false;
let volumeDeltaRsiDivergencePlotSelected = false;
let rsiDivergencePlotStartIndex: number | null = null;
let volumeDeltaRsiDivergencePlotStartIndex: number | null = null;

// ---------------------------------------------------------------------------
// Callbacks reference – set once via initDivergencePlot
// ---------------------------------------------------------------------------

let cb: DivergencePlotCallbacks;

function tc() {
  return getThemeColors();
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export function initDivergencePlot(callbacks: DivergencePlotCallbacks): void {
  cb = callbacks;
}

// ---------------------------------------------------------------------------
// Active-state getters
// ---------------------------------------------------------------------------

export function isRsiDivergencePlotToolActive(): boolean {
  return rsiDivergencePlotToolActive;
}

export function isVolumeDeltaRsiDivergencePlotToolActive(): boolean {
  return volumeDeltaRsiDivergencePlotToolActive;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function formatDivergenceOverlayTimeLabel(time: string | number): string {
  const unix = unixSecondsFromTimeValue(time);
  if (unix === null) return '';
  const date = new Date(unix * 1000);
  const currentChartInterval = cb.getCurrentInterval();
  if (currentChartInterval === '1day' || currentChartInterval === '1week') {
    return getAppTimeZoneFormatter('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: '2-digit',
    }).format(date);
  }
  return date.toLocaleString('en-US', {
    timeZone: getAppTimeZone(),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function ensureDivergenceOverlay(container: HTMLElement, pane: TrendToolPane): HTMLDivElement {
  const existing = pane === 'rsi' ? rsiDivergenceOverlayEl : volumeDeltaRsiDivergenceOverlayEl;
  if (existing && existing.parentElement === container) {
    existing.style.top = '0';
    existing.style.right = '0';
    existing.style.maxWidth = '100%';
    return existing;
  }

  const overlay = document.createElement('div');
  overlay.className = `divergence-plot-overlay divergence-plot-overlay-${pane}`;
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.width = '468px';
  overlay.style.maxWidth = '100%';
  overlay.style.height = '286px';
  overlay.style.border = `1px solid ${tc().borderColor}`;
  overlay.style.borderRadius = '6px';
  overlay.style.background = tc().bgOverlay95;
  overlay.style.backdropFilter = 'blur(4px)';
  overlay.style.zIndex = '35';
  overlay.style.pointerEvents = 'none';
  overlay.style.display = 'none';
  overlay.style.padding = '8px';
  overlay.style.boxSizing = 'border-box';

  const canvasWrap = document.createElement('div');
  canvasWrap.style.position = 'relative';
  canvasWrap.style.width = '100%';
  canvasWrap.style.height = '100%';
  const canvas = document.createElement('canvas');
  canvas.className = 'divergence-plot-overlay-canvas';
  canvasWrap.appendChild(canvas);
  overlay.appendChild(canvasWrap);
  container.appendChild(overlay);

  if (pane === 'rsi') {
    rsiDivergenceOverlayEl = overlay;
  } else {
    volumeDeltaRsiDivergenceOverlayEl = overlay;
  }
  return overlay;
}

export function getDivergenceOverlayChart(pane: TrendToolPane): any {
  return pane === 'rsi' ? rsiDivergenceOverlayChart : volumeDeltaRsiDivergenceOverlayChart;
}

export function setDivergenceOverlayChart(pane: TrendToolPane, chart: any | null): void {
  if (pane === 'rsi') {
    rsiDivergenceOverlayChart = chart;
  } else {
    volumeDeltaRsiDivergenceOverlayChart = chart;
  }
}

export function hideDivergenceOverlay(pane: TrendToolPane): void {
  const overlay = pane === 'rsi' ? rsiDivergenceOverlayEl : volumeDeltaRsiDivergenceOverlayEl;
  if (overlay) overlay.style.display = 'none';
  const chart = getDivergenceOverlayChart(pane);
  if (chart) {
    try {
      chart.destroy();
    } catch {
      // Ignore stale chart teardown errors.
    }
    setDivergenceOverlayChart(pane, null);
  }
}

export function findNearestBarIndex(time: string | number): number | null {
  const currentBars = cb.getCurrentBars();
  const barIndexByTime = cb.getBarIndexByTime();
  if (!Array.isArray(currentBars) || currentBars.length === 0) return null;
  const direct = barIndexByTime.get(timeKey(time));
  if (direct !== undefined) return direct;
  const targetUnix = unixSecondsFromTimeValue(time);
  if (targetUnix === null) return null;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < currentBars.length; i++) {
    const unix = unixSecondsFromTimeValue(currentBars[i]?.time);
    if (unix === null) continue;
    const distance = Math.abs(unix - targetUnix);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return Number.isFinite(bestDistance) ? bestIndex : null;
}

export function buildDivergenceOverlayData(startIndex: number): {
  labels: string[];
  rsiValues: number[];
  volumeDeltaRsiValues: number[];
} {
  const currentBars = cb.getCurrentBars();
  const rsiByTime = cb.getRsiByTime();
  const volumeDeltaRsiByTime = cb.getVolumeDeltaRsiByTime();
  const labels: string[] = [];
  const rsiValues: number[] = [];
  const volumeDeltaRsiValues: number[] = [];
  for (let i = startIndex; i < currentBars.length; i++) {
    const bar = currentBars[i];
    const key = timeKey(bar.time);
    const rsiValue = Number(rsiByTime.get(key));
    const vdRsiValue = Number(volumeDeltaRsiByTime.get(key));
    if (!Number.isFinite(rsiValue) || !Number.isFinite(vdRsiValue)) continue;
    labels.push(formatDivergenceOverlayTimeLabel(bar.time));
    rsiValues.push(rsiValue);
    volumeDeltaRsiValues.push(vdRsiValue);
  }
  return { labels, rsiValues, volumeDeltaRsiValues };
}

export function renderDivergenceOverlayForPane(pane: TrendToolPane, startIndex: number): void {
  const currentBars = cb.getCurrentBars();
  const container =
    pane === 'rsi' ? document.getElementById('rsi-chart-container') : document.getElementById('vd-rsi-chart-container');
  if (!container || !(container instanceof HTMLElement)) return;
  const overlay = ensureDivergenceOverlay(container, pane);
  const canvas = overlay.querySelector('.divergence-plot-overlay-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  if (!currentBars.length || startIndex < 0 || startIndex >= currentBars.length) {
    hideDivergenceOverlay(pane);
    return;
  }

  const data = buildDivergenceOverlayData(startIndex);
  if (data.rsiValues.length < 2) {
    hideDivergenceOverlay(pane);
    return;
  }

  overlay.style.display = 'block';
  const existingChart = getDivergenceOverlayChart(pane);
  if (existingChart) {
    existingChart.data.labels = data.labels;
    existingChart.data.datasets[0].data = data.rsiValues;
    existingChart.data.datasets[0].borderColor = rsiSettings.lineColor;
    existingChart.data.datasets[1].data = data.volumeDeltaRsiValues;
    existingChart.data.datasets[1].borderColor = volumeDeltaRsiSettings.lineColor;
    existingChart.update('none');
    return;
  }

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: 'RSI',
          data: data.rsiValues,
          borderColor: rsiSettings.lineColor,
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: data.rsiValues.length > 24 ? 0 : 2,
          tension: 0.2,
        },
        {
          label: 'VD RSI',
          data: data.volumeDeltaRsiValues,
          borderColor: volumeDeltaRsiSettings.lineColor,
          backgroundColor: 'transparent',
          borderWidth: 1,
          pointRadius: data.volumeDeltaRsiValues.length > 24 ? 0 : 2,
          tension: 0.2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: tc().cardBgOverlay95,
          borderColor: tc().borderColor,
          borderWidth: 1,
          titleColor: tc().textPrimary,
          bodyColor: tc().textSecondary,
        },
      },
      scales: {
        x: {
          display: false,
          ticks: {
            color: tc().textSecondary,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            font: { size: 10 },
          },
          grid: { color: tc().borderOverlay22 },
        },
        y: {
          display: false,
          min: 0,
          max: 100,
          ticks: {
            color: tc().textSecondary,
            font: { size: 10 },
          },
          grid: { color: tc().borderOverlay22 },
        },
      },
    },
  });
  setDivergenceOverlayChart(pane, chart);
}

export function deactivateRsiDivergencePlotTool(): void {
  rsiDivergencePlotToolActive = false;
  rsiDivergencePlotSelected = false;
  rsiDivergencePlotStartIndex = null;
  cb.setPaneToolButtonActive('rsi', 'divergence', false);
  hideDivergenceOverlay('rsi');
}

export function deactivateVolumeDeltaRsiDivergencePlotTool(): void {
  volumeDeltaRsiDivergencePlotToolActive = false;
  volumeDeltaRsiDivergencePlotSelected = false;
  volumeDeltaRsiDivergencePlotStartIndex = null;
  cb.setPaneToolButtonActive('volumeDeltaRsi', 'divergence', false);
  hideDivergenceOverlay('volumeDeltaRsi');
}

export function updateRsiDivergencePlotPoint(time: string | number, fromMove: boolean): void {
  if (!rsiDivergencePlotToolActive) return;
  if (fromMove && !rsiDivergencePlotSelected) return;
  const index = findNearestBarIndex(time);
  if (index === null) return;
  rsiDivergencePlotSelected = true;
  rsiDivergencePlotStartIndex = index;
  renderDivergenceOverlayForPane('rsi', index);
}

export function updateVolumeDeltaRsiDivergencePlotPoint(time: string | number, fromMove: boolean): void {
  if (!volumeDeltaRsiDivergencePlotToolActive) return;
  if (fromMove && !volumeDeltaRsiDivergencePlotSelected) return;
  const index = findNearestBarIndex(time);
  if (index === null) return;
  volumeDeltaRsiDivergencePlotSelected = true;
  volumeDeltaRsiDivergencePlotStartIndex = index;
  renderDivergenceOverlayForPane('volumeDeltaRsi', index);
}

export function toggleRsiDivergencePlotTool(): void {
  if (rsiDivergencePlotToolActive) {
    deactivateRsiDivergencePlotTool();
    return;
  }
  if (cb.getRsiDivergenceToolActive()) {
    cb.getRsiChart()?.deactivateDivergenceTool();
    cb.setRsiDivergenceToolActive(false);
    cb.setPaneTrendlineToolActive('rsi', false);
  }
  rsiDivergencePlotToolActive = true;
  rsiDivergencePlotSelected = false;
  rsiDivergencePlotStartIndex = null;
  cb.setPaneToolButtonActive('rsi', 'divergence', true);
}

export function toggleVolumeDeltaRsiDivergencePlotTool(): void {
  if (volumeDeltaRsiDivergencePlotToolActive) {
    deactivateVolumeDeltaRsiDivergencePlotTool();
    return;
  }
  if (cb.getVolumeDeltaDivergenceToolActive()) {
    cb.deactivateVolumeDeltaDivergenceTool();
    cb.setPaneTrendlineToolActive('volumeDeltaRsi', false);
  }
  volumeDeltaRsiDivergencePlotToolActive = true;
  volumeDeltaRsiDivergencePlotSelected = false;
  volumeDeltaRsiDivergencePlotStartIndex = null;
  cb.setPaneToolButtonActive('volumeDeltaRsi', 'divergence', true);
}

export function refreshActiveDivergenceOverlays(): void {
  if (rsiDivergencePlotToolActive && rsiDivergencePlotSelected && rsiDivergencePlotStartIndex !== null) {
    renderDivergenceOverlayForPane('rsi', rsiDivergencePlotStartIndex);
  }
  if (
    volumeDeltaRsiDivergencePlotToolActive &&
    volumeDeltaRsiDivergencePlotSelected &&
    volumeDeltaRsiDivergencePlotStartIndex !== null
  ) {
    renderDivergenceOverlayForPane('volumeDeltaRsi', volumeDeltaRsiDivergencePlotStartIndex);
  }
}

export function deactivateInteractivePaneToolsFromEscape(): void {
  if (cb.getRsiDivergenceToolActive()) {
    cb.getRsiChart()?.deactivateDivergenceTool();
    cb.setRsiDivergenceToolActive(false);
    cb.setPaneTrendlineToolActive('rsi', false);
  }
  if (cb.getVolumeDeltaDivergenceToolActive()) {
    cb.deactivateVolumeDeltaDivergenceTool();
    cb.setPaneTrendlineToolActive('volumeDeltaRsi', false);
  }
  if (rsiDivergencePlotToolActive) {
    deactivateRsiDivergencePlotTool();
  }
  if (volumeDeltaRsiDivergencePlotToolActive) {
    deactivateVolumeDeltaRsiDivergencePlotTool();
  }
}

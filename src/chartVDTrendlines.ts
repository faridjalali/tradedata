/**
 * Volume-Delta RSI trendline drawing, divergence detection, cross labels,
 * and divergence summary badges.
 *
 * Encapsulates all VD-RSI trendline/divergence state. Chart.ts accesses
 * functionality through exported functions and wires up via initVDTrendlines().
 */

import { getThemeColors } from './theme';
import { timeKey, toUnixSeconds, formatMmDdYyFromUnixSeconds } from './chartTimeUtils';
import {
  loadTrendlineStorage,
  saveTrendlineStorage,
  buildTrendlineContextKey,
  loadPersistedTrendlinesForContext,
} from './trendlineStorage';
import { DIVERGENCE_LOOKBACK_DAYS, type DivergenceSummaryEntry, getTickerDivergenceSummary } from './divergenceTable';
import { setRefreshButtonLoading } from './chartVDF';
import {
  type RSIPersistedTrendline,
  type TrendToolPane,
  RSI_MIDLINE_VALUE,
  VOLUME_DELTA_AXIS_MIN,
  VOLUME_DELTA_AXIS_MAX,
  VOLUME_DELTA_DATA_MIN,
  VOLUME_DELTA_DATA_MAX,
  VOLUME_DELTA_MAX_HIGHLIGHT_POINTS,
  DIVERGENCE_HIGHLIGHT_COLOR,
  TRENDLINE_COLOR,
  SCALE_MIN_WIDTH_PX,
  PANE_TOOL_BUTTON_SIZE_PX,
  PANE_TOOL_BUTTON_GAP_PX,
  FONT_DATA_STACK,
  FONT_SIZE_CONTROL_PX,
  FONT_WEIGHT_MEDIUM,
  volumeDeltaSettings,
} from './chartTypes';
import type { RSIChart } from './rsi';
import type { ChartInterval } from './chartApi';
import type { CandleBar } from '../shared/api-types';

function tc() {
  return getThemeColors();
}

// ---------------------------------------------------------------------------
// Callback interface — chart.ts state accessed via these
// ---------------------------------------------------------------------------

export interface VDTrendlineCallbacks {
  // LightweightCharts CDN — no bundled declarations

  getVDRsiChart: () => any;

  getVDRsiSeries: () => any;
  getCurrentTicker: () => string | null;
  getCurrentInterval: () => ChartInterval;
  getPriceByTime: () => Map<string, number>;
  getRsiChart: () => RSIChart | null;
  setPaneTrendlineToolActive: (pane: TrendToolPane, active: boolean) => void;
  applyPricePaneDivergentBarColors: () => void;
}

let cb: VDTrendlineCallbacks;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let volumeDeltaRsiPoints: Array<{ time: string | number; value: number }> = [];
let volumeDeltaIndexByTime = new Map<string, number>();
// LightweightCharts CDN — no bundled declarations

let volumeDeltaHighlightSeries: any = null;

let volumeDeltaTrendLineSeriesList: any[] = [];
let volumeDeltaTrendlineCrossLabels: Array<{
  element: HTMLDivElement;
  anchorTime: string | number;
  anchorValue: number;
}> = [];
let volumeDeltaTrendlineDefinitions: RSIPersistedTrendline[] = [];
const volumeDeltaDivergencePointTimeKeys = new Set<string>();
let volumeDeltaFirstPoint: { time: string | number; rsi: number; price: number; index: number } | null = null;
let volumeDeltaDivergenceToolActive = false;
let volumeDeltaSuppressSync = false;
let volumeDeltaDivergenceSummaryEl: HTMLDivElement | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export function initVDTrendlines(callbacks: VDTrendlineCallbacks): void {
  cb = callbacks;
}

// ---------------------------------------------------------------------------
// Data update — called by chart.ts after each VD-RSI render
// ---------------------------------------------------------------------------

export function setVDTrendlineData(
  points: Array<{ time: string | number; value: number }>,
  indexByTime: Map<string, number>,
): void {
  volumeDeltaRsiPoints = points;
  volumeDeltaIndexByTime = indexByTime;
}

export function resetVDTrendlineData(): void {
  volumeDeltaRsiPoints = [];
  volumeDeltaIndexByTime = new Map();
}

export function getVDRsiPoints(): Array<{ time: string | number; value: number }> {
  return volumeDeltaRsiPoints;
}

/**
 * Update the last VD-RSI point in-place (used during live refresh).
 * Returns true if a point was updated.
 */
export function updateVDRsiLastPoint(key: string, value: number): boolean {
  if (volumeDeltaRsiPoints.length === 0) return false;
  const lastIdx = volumeDeltaRsiPoints.length - 1;
  if (timeKey(volumeDeltaRsiPoints[lastIdx].time) !== key) return false;
  volumeDeltaRsiPoints[lastIdx] = {
    ...volumeDeltaRsiPoints[lastIdx],
    value,
  };
  return true;
}

// ---------------------------------------------------------------------------
// State getters
// ---------------------------------------------------------------------------

export function isVolumeDeltaDivergenceToolActive(): boolean {
  return volumeDeltaDivergenceToolActive;
}

export function isVolumeDeltaSyncSuppressed(): boolean {
  return volumeDeltaSuppressSync;
}

export function getVolumeDeltaTrendlineDefinitions(): RSIPersistedTrendline[] {
  return volumeDeltaTrendlineDefinitions;
}

// ---------------------------------------------------------------------------
// Pure helpers (also used by chart.ts for VD-RSI chart creation)
// ---------------------------------------------------------------------------

// LightweightCharts CDN — AutoscaleInfo type from CDN has no bundled declarations

export function fixedVolumeDeltaAutoscaleInfoProvider(): any {
  return {
    priceRange: {
      minValue: VOLUME_DELTA_AXIS_MIN,
      maxValue: VOLUME_DELTA_AXIS_MAX,
    },
  };
}

export function normalizeVolumeDeltaValue(value: number): number {
  return Math.max(VOLUME_DELTA_DATA_MIN, Math.min(VOLUME_DELTA_DATA_MAX, Number(value)));
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function setVolumeDeltaCursor(isCrosshair: boolean): void {
  const container = document.getElementById('vd-rsi-chart-container');
  if (!container) return;
  container.style.cursor = isCrosshair ? 'crosshair' : 'default';
}

// ---------------------------------------------------------------------------
// Trendline cross labels
// ---------------------------------------------------------------------------

function createTrendlineCrossLabelElement(text: string): HTMLDivElement {
  const label = document.createElement('div');
  label.className = 'trendline-cross-label';
  label.textContent = text;
  label.style.position = 'absolute';
  label.style.zIndex = '29';
  label.style.minHeight = '24px';
  label.style.display = 'inline-flex';
  label.style.alignItems = 'center';
  label.style.padding = '0 8px';
  label.style.borderRadius = '4px';
  label.style.border = `1px solid ${tc().borderColor}`;
  label.style.background = tc().cardBg;
  label.style.color = tc().textPrimary;
  label.style.fontSize = `${FONT_SIZE_CONTROL_PX}px`;
  label.style.fontFamily = FONT_DATA_STACK;
  label.style.pointerEvents = 'none';
  label.style.whiteSpace = 'nowrap';
  label.style.transform = 'translate(-50%, calc(-100% - 6px))';
  return label;
}

export function refreshVolumeDeltaTrendlineCrossLabels(): void {
  const container = document.getElementById('vd-rsi-chart-container');
  const vdRsiChart = cb.getVDRsiChart();
  const vdRsiSeries = cb.getVDRsiSeries();
  if (!container || !vdRsiChart || !vdRsiSeries) return;
  const width = container.clientWidth;
  const height = container.clientHeight;

  for (const label of volumeDeltaTrendlineCrossLabels) {
    const x = vdRsiChart.timeScale().timeToCoordinate(label.anchorTime);
    const y = vdRsiSeries.priceToCoordinate(label.anchorValue);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > width || y < 0 || y > height) {
      label.element.style.display = 'none';
      continue;
    }
    label.element.style.display = 'inline-flex';
    label.element.style.left = `${Math.round(x)}px`;
    label.element.style.top = `${Math.round(Math.max(8, y))}px`;
  }
}

function clearVolumeDeltaTrendlineCrossLabels(): void {
  for (const label of volumeDeltaTrendlineCrossLabels) {
    label.element.remove();
  }
  volumeDeltaTrendlineCrossLabels = [];
}

function addVolumeDeltaTrendlineCrossLabel(anchorTime: string | number, anchorValue: number, text: string): void {
  const container = document.getElementById('vd-rsi-chart-container');
  if (!container) return;
  const element = createTrendlineCrossLabelElement(text);
  container.appendChild(element);
  volumeDeltaTrendlineCrossLabels.push({
    element,
    anchorTime,
    anchorValue,
  });
  refreshVolumeDeltaTrendlineCrossLabels();
}

// ---------------------------------------------------------------------------
// Time projection helpers
// ---------------------------------------------------------------------------

export function projectFutureTradingUnixSeconds(
  lastTimeSeconds: number,
  futureBars: number,
  stepSeconds: number,
): number {
  // For daily/weekly intervals, skip weekends when projecting
  if (stepSeconds >= 86400) {
    const wholeBars = Math.floor(futureBars);
    const fraction = futureBars - wholeBars;
    const d = new Date(lastTimeSeconds * 1000);
    let remaining = wholeBars;
    while (remaining > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) remaining--;
    }
    const wholeTime = Math.floor(d.getTime() / 1000);
    if (fraction > 0) {
      // Interpolate toward next trading day
      const nextD = new Date(d);
      do {
        nextD.setUTCDate(nextD.getUTCDate() + 1);
      } while (nextD.getUTCDay() === 0 || nextD.getUTCDay() === 6);
      const nextTime = Math.floor(nextD.getTime() / 1000);
      return wholeTime + fraction * (nextTime - wholeTime);
    }
    return wholeTime;
  }
  // Intraday: spread bars across trading days, skipping weekends.
  const barsPerDay = barsPerTradingDayFromStep(stepSeconds);
  const tradingDaysAhead = Math.floor(futureBars / barsPerDay);
  const intraDayBars = futureBars - tradingDaysAhead * barsPerDay;
  const d = new Date(lastTimeSeconds * 1000);
  let remaining = tradingDaysAhead;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return Math.floor(d.getTime() / 1000) + intraDayBars * stepSeconds;
}

function volumeDeltaIndexToUnixSeconds(
  index: number,
  lastHistoricalIndex: number,
  firstHistoricalTimeSeconds: number | null,
  lastHistoricalTimeSeconds: number | null,
  stepSeconds: number,
): number | null {
  if (!Number.isFinite(index)) return null;

  if (index > lastHistoricalIndex) {
    if (lastHistoricalTimeSeconds === null) return null;
    return projectFutureTradingUnixSeconds(lastHistoricalTimeSeconds, index - lastHistoricalIndex, stepSeconds);
  }

  if (index < 0) {
    if (firstHistoricalTimeSeconds === null) return null;
    return firstHistoricalTimeSeconds + index * stepSeconds;
  }

  const lowerIndex = Math.max(0, Math.floor(index));
  const upperIndex = Math.min(lastHistoricalIndex, Math.ceil(index));
  const lowerTime = toUnixSeconds(volumeDeltaRsiPoints[lowerIndex]?.time);
  const upperTime = toUnixSeconds(volumeDeltaRsiPoints[upperIndex]?.time);
  if (lowerIndex === upperIndex) return lowerTime;
  if (Number.isFinite(lowerTime) && Number.isFinite(upperTime)) {
    const ratio = index - lowerIndex;
    return Number(lowerTime) + (Number(upperTime) - Number(lowerTime)) * ratio;
  }
  if (Number.isFinite(lowerTime)) return Number(lowerTime) + (index - lowerIndex) * stepSeconds;
  if (firstHistoricalTimeSeconds === null) return null;
  return firstHistoricalTimeSeconds + index * stepSeconds;
}

function computeVolumeDeltaTrendlineMidlineCrossUnixSeconds(
  index1: number,
  value1: number,
  slope: number,
  lastHistoricalIndex: number,
  firstHistoricalTimeSeconds: number | null,
  lastHistoricalTimeSeconds: number | null,
  stepSeconds: number,
): number | null {
  if (!Number.isFinite(slope) || Math.abs(slope) < 1e-12) return null;
  const crossIndex = index1 + (RSI_MIDLINE_VALUE - value1) / slope;
  if (!Number.isFinite(crossIndex)) return null;
  return volumeDeltaIndexToUnixSeconds(
    crossIndex,
    lastHistoricalIndex,
    firstHistoricalTimeSeconds,
    lastHistoricalTimeSeconds,
    stepSeconds,
  );
}

function inferVolumeDeltaBarStepSeconds(): number {
  if (volumeDeltaRsiPoints.length < 2) return 1800;
  const diffs: number[] = [];
  for (let i = 1; i < volumeDeltaRsiPoints.length; i++) {
    const prev = toUnixSeconds(volumeDeltaRsiPoints[i - 1].time);
    const curr = toUnixSeconds(volumeDeltaRsiPoints[i].time);
    if (prev === null || curr === null) continue;
    const diff = curr - prev;
    if (Number.isFinite(diff) && diff > 0) {
      diffs.push(diff);
    }
  }
  if (diffs.length === 0) return 1800;
  diffs.sort((a, b) => a - b);
  // Use the 25th-percentile diff to filter out weekend/holiday gaps
  // while still capturing the true bar interval for daily/weekly data.
  return diffs[Math.floor(diffs.length * 0.25)];
}

function barsPerTradingDayFromStep(stepSeconds: number): number {
  if (stepSeconds <= 5 * 60) return 78;
  if (stepSeconds <= 15 * 60) return 26;
  if (stepSeconds <= 30 * 60) return 13;
  if (stepSeconds <= 60 * 60) return 7;
  return 2;
}

function volumeDeltaFutureBarsForOneYear(): number {
  const stepSeconds = inferVolumeDeltaBarStepSeconds();
  return barsPerTradingDayFromStep(stepSeconds) * 252;
}

// ---------------------------------------------------------------------------
// Highlight / trendline management
// ---------------------------------------------------------------------------

export function clearVolumeDeltaHighlights(): void {
  const vdRsiChart = cb.getVDRsiChart();
  if (!volumeDeltaHighlightSeries || !vdRsiChart) return;
  try {
    vdRsiChart.removeSeries(volumeDeltaHighlightSeries);
  } catch {
    // Ignore stale highlight series remove errors.
  }
  volumeDeltaHighlightSeries = null;
}

export function clearVolumeDeltaTrendLines(preserveViewport: boolean = false): void {
  const vdRsiChart = cb.getVDRsiChart();
  const visibleRangeBeforeClear =
    preserveViewport && vdRsiChart ? vdRsiChart.timeScale().getVisibleLogicalRange?.() : null;
  if (preserveViewport) {
    volumeDeltaSuppressSync = true;
  }

  if (!vdRsiChart || volumeDeltaTrendLineSeriesList.length === 0) {
    volumeDeltaTrendLineSeriesList = [];
    volumeDeltaTrendlineDefinitions = [];
    clearVolumeDeltaTrendlineCrossLabels();
    if (preserveViewport) {
      volumeDeltaSuppressSync = false;
    }
    return;
  }

  try {
    for (const series of volumeDeltaTrendLineSeriesList) {
      try {
        vdRsiChart.removeSeries(series);
      } catch {
        // Ignore stale trendline series remove errors.
      }
    }
    volumeDeltaTrendLineSeriesList = [];
    volumeDeltaTrendlineDefinitions = [];
    clearVolumeDeltaTrendlineCrossLabels();
  } finally {
    if (preserveViewport && visibleRangeBeforeClear) {
      try {
        vdRsiChart.timeScale().setVisibleLogicalRange(visibleRangeBeforeClear);
      } catch {
        // Keep viewport stable after clearing.
      }
    }
    if (preserveViewport) {
      volumeDeltaSuppressSync = false;
    }
  }
}

function clearVolumeDeltaDivergenceState(): void {
  clearVolumeDeltaHighlights();
  volumeDeltaFirstPoint = null;
  volumeDeltaDivergencePointTimeKeys.clear();
}

export function deactivateVolumeDeltaDivergenceTool(): void {
  volumeDeltaDivergenceToolActive = false;
  clearVolumeDeltaDivergenceState();
  setVolumeDeltaCursor(false);
}

export function activateVolumeDeltaDivergenceTool(): void {
  volumeDeltaDivergenceToolActive = true;
  setVolumeDeltaCursor(true);
}

export function clearVolumeDeltaDivergence(preserveViewport: boolean = false): void {
  clearVolumeDeltaDivergenceState();
  clearVolumeDeltaTrendLines(preserveViewport);
}

function highlightVolumeDeltaPoints(points: Array<{ time: string | number; value: number }>): void {
  clearVolumeDeltaHighlights();
  const vdRsiChart = cb.getVDRsiChart();
  if (!vdRsiChart || points.length === 0) return;

  volumeDeltaHighlightSeries = vdRsiChart.addLineSeries({
    color: DIVERGENCE_HIGHLIGHT_COLOR,
    lineVisible: false,
    pointMarkersVisible: true,
    pointMarkersRadius: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider(),
  });

  const step = Math.max(1, Math.ceil(points.length / VOLUME_DELTA_MAX_HIGHLIGHT_POINTS));
  const displayPoints = step === 1 ? points : points.filter((_, index) => index % step === 0);
  volumeDeltaHighlightSeries.setData(displayPoints);
}

// ---------------------------------------------------------------------------
// Trendline drawing
// ---------------------------------------------------------------------------

export function drawVolumeDeltaTrendLine(
  time1: string | number,
  value1: number,
  time2: string | number,
  value2: number,
  recordDefinition: boolean = true,
): void {
  const vdRsiChart = cb.getVDRsiChart();
  if (!vdRsiChart || !volumeDeltaRsiPoints.length) return;

  const index1 = volumeDeltaIndexByTime.get(timeKey(time1));
  const index2 = volumeDeltaIndexByTime.get(timeKey(time2));
  if (index1 === undefined || index2 === undefined || index1 === index2) return;

  const slope = (value2 - value1) / (index2 - index1);
  const lastHistoricalIndex = volumeDeltaRsiPoints.length - 1;
  const futureBars = volumeDeltaFutureBarsForOneYear();
  const maxIndex = lastHistoricalIndex + futureBars;
  const stepSeconds = inferVolumeDeltaBarStepSeconds();
  const firstTimeSeconds = toUnixSeconds(volumeDeltaRsiPoints[0]?.time);
  const lastTimeSeconds = toUnixSeconds(volumeDeltaRsiPoints[lastHistoricalIndex]?.time);
  const visibleRangeBeforeDraw = vdRsiChart.timeScale().getVisibleLogicalRange?.();

  const trendLineData: Array<{ time: string | number; value: number }> = [];
  volumeDeltaSuppressSync = true;
  try {
    for (let i = index1; i <= maxIndex; i++) {
      const projectedValue = value1 + slope * (i - index1);
      if (!Number.isFinite(projectedValue)) break;
      if (projectedValue < VOLUME_DELTA_DATA_MIN || projectedValue > VOLUME_DELTA_DATA_MAX) break;

      let pointTime: string | number | null = null;
      if (i <= lastHistoricalIndex) {
        pointTime = volumeDeltaRsiPoints[i]?.time ?? null;
      } else if (lastTimeSeconds !== null) {
        pointTime = projectFutureTradingUnixSeconds(lastTimeSeconds, i - lastHistoricalIndex, stepSeconds);
      }
      if (pointTime === null || pointTime === undefined) continue;
      trendLineData.push({
        time: pointTime,
        value: projectedValue,
      });
    }

    if (!trendLineData.length) return;

    const trendLineSeries = vdRsiChart.addLineSeries({
      color: TRENDLINE_COLOR,
      lineWidth: 1,
      lineStyle: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider(),
    });
    trendLineSeries.setData(trendLineData);
    volumeDeltaTrendLineSeriesList.push(trendLineSeries);

    const crossUnixSeconds = computeVolumeDeltaTrendlineMidlineCrossUnixSeconds(
      index1,
      value1,
      slope,
      lastHistoricalIndex,
      firstTimeSeconds,
      lastTimeSeconds,
      stepSeconds,
    );
    addVolumeDeltaTrendlineCrossLabel(time1, value1, formatMmDdYyFromUnixSeconds(crossUnixSeconds));
    if (recordDefinition) {
      volumeDeltaTrendlineDefinitions.push({
        time1,
        value1: Number(value1),
        time2,
        value2: Number(value2),
      });
    }
  } finally {
    if (visibleRangeBeforeDraw) {
      try {
        vdRsiChart.timeScale().setVisibleLogicalRange(visibleRangeBeforeDraw);
      } catch {
        // Keep viewport stable even if range restoration fails.
      }
    }
    volumeDeltaSuppressSync = false;
  }
}

// ---------------------------------------------------------------------------
// Divergence click detection
// ---------------------------------------------------------------------------

export function detectAndHandleVolumeDeltaDivergenceClick(clickedTime: string | number): void {
  if (!volumeDeltaDivergenceToolActive) return;

  const clickedKey = timeKey(clickedTime);
  const clickedIndex = volumeDeltaIndexByTime.get(clickedKey);
  if (clickedIndex === undefined) return;

  const clickedPoint = volumeDeltaRsiPoints[clickedIndex];
  if (!clickedPoint) return;
  const clickedRSI = Number(clickedPoint.value);
  const priceByTime = cb.getPriceByTime();
  const clickedPrice = priceByTime.get(clickedKey);
  if (!Number.isFinite(clickedRSI) || !Number.isFinite(clickedPrice)) return;
  const clickedPriceValue = Number(clickedPrice);

  if (!volumeDeltaFirstPoint) {
    volumeDeltaFirstPoint = {
      time: clickedTime,
      rsi: clickedRSI,
      price: clickedPriceValue,
      index: clickedIndex,
    };

    const divergencePoints: Array<{ time: string | number; value: number }> = [];
    volumeDeltaDivergencePointTimeKeys.clear();

    for (let i = clickedIndex + 1; i < volumeDeltaRsiPoints.length; i++) {
      const currentPoint = volumeDeltaRsiPoints[i];
      const currentRSI = Number(currentPoint?.value);
      if (!Number.isFinite(currentRSI)) continue;
      const currentPrice = priceByTime.get(timeKey(currentPoint.time));
      if (!Number.isFinite(currentPrice)) continue;

      const currentPriceValue = Number(currentPrice);
      const bearishDivergence = currentRSI < clickedRSI && currentPriceValue > clickedPriceValue;
      const bullishDivergence = currentRSI > clickedRSI && currentPriceValue < clickedPriceValue;
      if (!bearishDivergence && !bullishDivergence) continue;

      divergencePoints.push({ time: currentPoint.time, value: currentRSI });
      volumeDeltaDivergencePointTimeKeys.add(timeKey(currentPoint.time));
    }

    highlightVolumeDeltaPoints(divergencePoints);
    return;
  }

  if (!volumeDeltaDivergencePointTimeKeys.has(clickedKey)) {
    return;
  }

  drawVolumeDeltaTrendLine(volumeDeltaFirstPoint.time, volumeDeltaFirstPoint.rsi, clickedTime, clickedRSI);

  deactivateVolumeDeltaDivergenceTool();
  cb.setPaneTrendlineToolActive('volumeDeltaRsi', false);
  persistTrendlinesForCurrentContext();
}

// ---------------------------------------------------------------------------
// Trendline persistence
// ---------------------------------------------------------------------------

export function persistTrendlinesForCurrentContext(): void {
  const ticker = cb.getCurrentTicker();
  if (!ticker) return;
  const storage = loadTrendlineStorage();
  const key = buildTrendlineContextKey(ticker, cb.getCurrentInterval());
  storage[key] = {
    rsi: cb.getRsiChart()?.getPersistedTrendlines() ?? [],
    volumeDeltaRsi: volumeDeltaTrendlineDefinitions.map((line) => ({ ...line })),
  };
  saveTrendlineStorage(storage);
}

export function restoreVolumeDeltaPersistedTrendlines(trendlines: RSIPersistedTrendline[]): void {
  clearVolumeDeltaTrendLines();
  if (!Array.isArray(trendlines) || trendlines.length === 0) return;
  for (const line of trendlines) {
    const time1 = line?.time1;
    const time2 = line?.time2;
    const value1 = Number(line?.value1);
    const value2 = Number(line?.value2);
    if (
      (typeof time1 !== 'string' && typeof time1 !== 'number') ||
      (typeof time2 !== 'string' && typeof time2 !== 'number')
    )
      continue;
    if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
    drawVolumeDeltaTrendLine(time1, value1, time2, value2, true);
  }
}

export function restorePersistedTrendlinesForCurrentContext(): void {
  const ticker = cb.getCurrentTicker();
  if (!ticker) return;
  const persisted = loadPersistedTrendlinesForContext(ticker, cb.getCurrentInterval());
  cb.getRsiChart()?.restorePersistedTrendlines(persisted.rsi);
  restoreVolumeDeltaPersistedTrendlines(persisted.volumeDeltaRsi);
}

// ---------------------------------------------------------------------------
// Divergence summary badges
// ---------------------------------------------------------------------------

function ensureVolumeDeltaDivergenceSummaryEl(container: HTMLElement): HTMLDivElement {
  if (volumeDeltaDivergenceSummaryEl && volumeDeltaDivergenceSummaryEl.parentElement === container) {
    volumeDeltaDivergenceSummaryEl.style.top = '8px';
    volumeDeltaDivergenceSummaryEl.style.transform = 'none';
    volumeDeltaDivergenceSummaryEl.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
    volumeDeltaDivergenceSummaryEl.style.display = 'flex';
    volumeDeltaDivergenceSummaryEl.style.flexDirection = 'row';
    volumeDeltaDivergenceSummaryEl.style.alignItems = 'center';
    volumeDeltaDivergenceSummaryEl.style.gap = `${PANE_TOOL_BUTTON_GAP_PX}px`;
    volumeDeltaDivergenceSummaryEl.style.background = 'transparent';
    volumeDeltaDivergenceSummaryEl.style.border = 'none';
    volumeDeltaDivergenceSummaryEl.style.borderRadius = '0';
    volumeDeltaDivergenceSummaryEl.style.overflow = 'visible';
    return volumeDeltaDivergenceSummaryEl;
  }

  const el = document.createElement('div');
  el.className = 'volume-delta-divergence-summary';
  el.style.position = 'absolute';
  el.style.top = '8px';
  el.style.transform = 'none';
  el.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
  el.style.zIndex = '34';
  el.style.display = 'flex';
  el.style.flexDirection = 'row';
  el.style.alignItems = 'center';
  el.style.gap = `${PANE_TOOL_BUTTON_GAP_PX}px`;
  el.style.background = 'transparent';
  el.style.border = 'none';
  el.style.borderRadius = '0';
  el.style.overflow = 'visible';
  el.style.pointerEvents = 'auto';
  container.appendChild(el);
  volumeDeltaDivergenceSummaryEl = el;
  return el;
}

export function clearVolumeDeltaDivergenceSummary(): void {
  if (!volumeDeltaDivergenceSummaryEl) return;
  volumeDeltaDivergenceSummaryEl.style.display = 'none';
  volumeDeltaDivergenceSummaryEl.innerHTML = '';
}

export function renderVolumeDeltaDivergenceSummary(
  container: HTMLElement,
  bars: CandleBar[],
  options?: { noCache?: boolean },
): void {
  if (!volumeDeltaSettings.divergenceTable) {
    clearVolumeDeltaDivergenceSummary();
    return;
  }
  const summaryEl = ensureVolumeDeltaDivergenceSummaryEl(container);
  summaryEl.innerHTML = '';
  summaryEl.style.display = 'flex';
  summaryEl.style.flexDirection = 'row';
  summaryEl.style.alignItems = 'center';
  const ticker = String(cb.getCurrentTicker() || '')
    .trim()
    .toUpperCase();
  const sourceInterval = volumeDeltaSettings.sourceInterval;
  const noCache = options?.noCache === true;
  const requestToken = `${ticker}|${sourceInterval}|${Date.now()}`;
  summaryEl.dataset.requestToken = requestToken;
  let manualRefreshInFlight = false;
  let lastSummary: DivergenceSummaryEntry | null = null;

  const buildBadge = (text: string, color: string, title: string): HTMLDivElement => {
    const badge = document.createElement('div');
    badge.textContent = text;
    badge.title = title;
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
    badge.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    badge.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    badge.style.padding = '0';
    badge.style.borderRadius = '4px';
    badge.style.border = `1px solid ${tc().borderColor}`;
    badge.style.background = tc().cardBg;
    badge.style.fontSize = `${FONT_SIZE_CONTROL_PX}px`;
    badge.style.fontWeight = String(FONT_WEIGHT_MEDIUM);
    badge.style.lineHeight = '1';
    badge.style.fontFamily = FONT_DATA_STACK;
    badge.style.color = color;
    badge.style.pointerEvents = 'none';
    return badge;
  };

  const runManualRefresh = () => {
    if (manualRefreshInFlight) return;
    manualRefreshInFlight = true;
    renderSummary(lastSummary, true);
    getTickerDivergenceSummary(ticker, sourceInterval, { forceRefresh: true, noCache: true })
      .then((summary) => {
        if (summaryEl.dataset.requestToken !== requestToken) return;
        if (
          String(cb.getCurrentTicker() || '')
            .trim()
            .toUpperCase() !== ticker
        )
          return;
        lastSummary = summary || null;
        renderSummary(lastSummary, false);
      })
      .catch(() => {
        if (summaryEl.dataset.requestToken !== requestToken) return;
        if (
          String(cb.getCurrentTicker() || '')
            .trim()
            .toUpperCase() !== ticker
        )
          return;
        renderSummary(lastSummary, false);
      })
      .finally(() => {
        manualRefreshInFlight = false;
      });
  };

  const renderSummary = (summary: DivergenceSummaryEntry | null, loading = false) => {
    if (summaryEl.dataset.requestToken !== requestToken) return;
    if (
      String(cb.getCurrentTicker() || '')
        .trim()
        .toUpperCase() !== ticker
    )
      return;
    summaryEl.innerHTML = '';

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'pane-btn refresh-btn';
    refreshButton.style.position = 'relative';
    setRefreshButtonLoading(refreshButton, loading);
    refreshButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      runManualRefresh();
    });
    summaryEl.appendChild(refreshButton);

    for (let i = 0; i < DIVERGENCE_LOOKBACK_DAYS.length; i++) {
      const days = DIVERGENCE_LOOKBACK_DAYS[i];
      const state = summary?.states?.[String(days)] || 'neutral';
      const badgeColor = state === 'bullish' ? '#26a69a' : state === 'bearish' ? '#ef5350' : tc().textPrimary;
      const badge = buildBadge(
        String(days),
        badgeColor,
        `Last ${days} day${days === 1 ? '' : 's'}${summary?.tradeDate ? ` (as of ${summary.tradeDate})` : ''}`,
      );
      summaryEl.appendChild(badge);
    }
  };

  renderSummary(null, false);
  if (!ticker || !Array.isArray(bars) || bars.length < 2) {
    return;
  }

  // Phase 1: Fast path — try cached / stored value (no server recomputation).
  getTickerDivergenceSummary(ticker, sourceInterval)
    .then((summary) => {
      if (summaryEl.dataset.requestToken !== requestToken) return;
      lastSummary = summary || null;
      renderSummary(lastSummary, false);

      // Phase 2: If the cached value is stale or missing, refresh in background.
      const needsRefresh =
        noCache || !summary || !Number.isFinite(summary.expiresAtMs) || summary.expiresAtMs <= Date.now();
      if (needsRefresh) {
        getTickerDivergenceSummary(ticker, sourceInterval, { forceRefresh: true, noCache: true })
          .then((freshSummary) => {
            if (summaryEl.dataset.requestToken !== requestToken) return;
            lastSummary = freshSummary || null;
            renderSummary(lastSummary, false);
          })
          .catch(() => {});
      }
    })
    .catch(() => {
      // Phase 1 failed — fall back to force refresh.
      getTickerDivergenceSummary(ticker, sourceInterval, { forceRefresh: true, noCache: true })
        .then((summary) => {
          if (summaryEl.dataset.requestToken !== requestToken) return;
          lastSummary = summary || null;
          renderSummary(lastSummary, false);
        })
        .catch(() => {
          renderSummary(lastSummary, false);
        });
    });
}

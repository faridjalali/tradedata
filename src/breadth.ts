import { getAppTimeZone } from './timezone';
import { getThemeColors } from './theme';
import { breadthStore } from './store/breadthStore';

/**
 * Minimal interface for Chart.js instances.
 * Chart.js is loaded via CDN (with the chartjs-plugin-annotation extension),
 * so we declare only the methods we actually call rather than importing the
 * full package types, which don't include CDN-only plugin options.
 */
interface ChartInstance {
  destroy(): void;
  update(mode?: string): void;
  data: { datasets: Array<{ label?: string; data: unknown[] }> };
  getDatasetMeta(index: number): { hidden: boolean };
}
/** Chart.js constructor as available on the global `window.Chart` CDN export. */
declare const Chart: new (canvas: HTMLCanvasElement, config: unknown) => ChartInstance;

/** Tooltip callback context passed by Chart.js for each dataset at a hovered data point. */
interface ChartTooltipContext {
  dataset: { label?: string; [key: string]: unknown };
  parsed: { y: number | null };
  dataIndex: number;
}

/**
 * Extended dataset shape for the comparative chart.
 * Chart.js datasets are plain objects; custom properties are added alongside
 * the standard label/data fields.
 */
interface CompareChartDataset {
  label?: string;
  rawValues?: number[];
  rawDecimals?: number;
  rawSuffix?: string;
  [key: string]: unknown;
}

/** Legend item passed to the legend onClick callback. */
interface ChartLegendItem {
  datasetIndex: number;
}

/** Legend handle passed to the legend onClick callback. */
interface ChartLegendHandle {
  chart: {
    getDatasetMeta: (idx: number) => { hidden: boolean };
    update: () => void;
  };
}

import type {
  BreadthDataPoint,
  BreadthResponse,
  BreadthMASnapshot,
  BreadthMAHistory,
  BreadthMAResponse,
} from '../shared/api-types';

/** Set the active button in a group by matching a data attribute. */
function setActiveInGroup(containerSelector: string, dataAttr: string, value: string): void {
  document.querySelectorAll(`${containerSelector} .pane-btn`).forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset[dataAttr] === value);
  });
}

// ---------------------------------------------------------------------------
// Single source of truth for breadth ETF indexes
// ---------------------------------------------------------------------------

const BREADTH_INDEXES = [
  'SPY',
  'QQQ',
  'DIA',
  'MDY',
  'IWM',
  'XLK',
  'XLF',
  'XLV',
  'XLY',
  'XLC',
  'XLI',
  'XLP',
  'XLE',
  'XLU',
  'XLB',
  'SMH',
  'XBI',
  'XHB',
  'XRT',
  'XAR',
  'KRE',
  'XLRE',
];

/** Populate both MA and Compare index button containers from the shared list. */
export function populateBreadthIndexButtons(): void {
  for (const id of ['breadth-ma-index-btns', 'breadth-compare-index-btns']) {
    const container = document.getElementById(id);
    if (!container) continue;
    container.innerHTML = '';
    for (const idx of BREADTH_INDEXES) {
      const btn = document.createElement('button');
      btn.className = 'pane-btn';
      if (idx === 'SPY') btn.classList.add('active');
      btn.dataset.index = idx;
      btn.textContent = idx;
      container.appendChild(btn);
    }
  }
}

/** Number of calendar days of MA history to request from the server. */
const BREADTH_MA_HISTORY_DAYS = 60;

// ---------------------------------------------------------------------------
// MA line visibility persistence via localStorage
// Stores which MA windows (by number: '21','50','100','200') are hidden.
// ---------------------------------------------------------------------------
const BREADTH_MA_HIDDEN_KEY = 'breadth-ma-hidden';

function getHiddenMAs(): Set<string> {
  try {
    const raw = localStorage.getItem(BREADTH_MA_HIDDEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveHiddenMAs(hidden: Set<string>): void {
  localStorage.setItem(BREADTH_MA_HIDDEN_KEY, JSON.stringify([...hidden]));
}

// ---------------------------------------------------------------------------
// Chart.js shared config factory — avoids repeating identical options blocks
// ---------------------------------------------------------------------------

interface BreadthChartOverrides {
  yTickCallback?: (value: number | string) => string;
  yStepSize?: number;
  tooltipCallback?: (ctx: ChartTooltipContext) => string | undefined;
  legendOnClick?: (_e: unknown, legendItem: ChartLegendItem, legend: ChartLegendHandle) => void;
  annotation50?: boolean;
  legendFontSize?: number;
  tooltipPadding?: number;
  extraPlugins?: Record<string, unknown>;
  layoutPadding?: Record<string, number>;
}

function makeBreadthChartOptions(
  c: ReturnType<typeof getThemeColors>,
  ov: BreadthChartOverrides = {},
): Record<string, unknown> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    ...(ov.layoutPadding ? { layout: { padding: ov.layoutPadding } } : {}),
    plugins: {
      legend: {
        ...(ov.legendOnClick ? { onClick: ov.legendOnClick } : {}),
        labels: {
          color: c.textPrimary,
          font: { size: ov.legendFontSize ?? 12 },
          usePointStyle: true,
          pointStyle: 'line',
        },
      },
      tooltip: {
        backgroundColor: c.cardBgOverlay95,
        borderColor: c.borderColor,
        borderWidth: 1,
        titleColor: c.textPrimary,
        bodyColor: c.textSecondary,
        padding: ov.tooltipPadding ?? 12,
        ...(ov.tooltipCallback ? { callbacks: { label: ov.tooltipCallback } } : {}),
      },
      ...(ov.annotation50
        ? {
            annotation: {
              annotations: {
                line50: {
                  type: 'line',
                  yMin: 50,
                  yMax: 50,
                  borderColor: c.textMuted || 'rgba(255,255,255,0.2)',
                  borderWidth: 1,
                  borderDash: [4, 4],
                },
              },
            },
          }
        : {}),
      ...(ov.extraPlugins ?? {}),
    },
    scales: {
      x: {
        ticks: { color: c.textSecondary, maxRotation: 0, autoSkip: true, maxTicksLimit: 10, font: { size: 11 } },
        grid: { color: c.borderOverlay30 },
      },
      y: {
        ticks: {
          color: c.textSecondary,
          font: { size: 11 },
          ...(ov.yTickCallback ? { callback: ov.yTickCallback } : {}),
          ...(ov.yStepSize ? { stepSize: ov.yStepSize } : {}),
        },
        grid: { color: c.borderOverlay30 },
      },
    },
  };
}

/** Extract the MA number (21/50/100/200) from a dataset label like "21 MA", "% > 50d", "SPY 100d". */
function maNumberFromLabel(label: string | undefined): string | null {
  const m = label?.match(/(21|50|100|200)/);
  return m ? m[1] : null;
}

/** After rendering a chart, apply persisted hidden state to MA datasets. */
function applyHiddenMAs(chart: ChartInstance): void {
  const hidden = getHiddenMAs();
  if (hidden.size === 0) return;
  chart.data.datasets.forEach((_ds, i) => {
    const num = maNumberFromLabel(chart.data.datasets[i].label);
    if (num && hidden.has(num)) {
      chart.getDatasetMeta(i).hidden = true;
    }
  });
  chart.update('none');
}

/** Read current visibility from a chart and persist to localStorage. */
function syncHiddenMAs(chart: ChartInstance): void {
  const hidden = new Set<string>();
  chart.data.datasets.forEach((_ds, i) => {
    if (chart.getDatasetMeta(i).hidden) {
      const num = maNumberFromLabel(chart.data.datasets[i].label);
      if (num) hidden.add(num);
    }
  });
  saveHiddenMAs(hidden);
}

// Chart.js instances — heavy objects, stay module-level (not in Zustand).
let breadthChart: ChartInstance | null = null;
let breadthMAChart: ChartInstance | null = null;
let breadthCompareChart: ChartInstance | null = null;
let breadthBarsChart: ChartInstance | null = null;
let breadthThemeListenerBound = false;

// Cached API response for MA data (not config state, just data cache).
let breadthMAData: BreadthMAResponse | null = null;

export function getCurrentBreadthTimeframe(): number {
  return breadthStore.getState().timeframeDays;
}

export function getCurrentBreadthMetric(): string {
  return breadthStore.getState().metric;
}

async function fetchBreadthData(ticker: string, days: number): Promise<BreadthResponse> {
  const response = await fetch(`/api/breadth?ticker=${ticker}&days=${days}`);
  if (!response.ok) {
    throw new Error('Failed to fetch breadth data');
  }
  return response.json();
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const base = values[0];
  if (base === 0) return values.map(() => 100);
  return values.map((v) => (v / base) * 100);
}

function renderBreadthChart(data: BreadthDataPoint[], compLabel: string, intraday: boolean): void {
  const canvas = document.getElementById('breadth-chart') as HTMLCanvasElement;
  if (!canvas) return;
  const c = getThemeColors();
  const appTimeZone = getAppTimeZone();

  // Destroy previous chart
  if (breadthChart) {
    breadthChart.destroy();
    breadthChart = null;
  }

  const intradayDayCount = intraday
    ? new Set(
        data.map((d) =>
          new Date(d.date).toLocaleDateString('en-US', {
            timeZone: appTimeZone,
          }),
        ),
      ).size
    : 0;

  const labels = data.map((d) => {
    if (intraday) {
      const date = new Date(d.date);
      if (intradayDayCount > 1) {
        return date.toLocaleDateString('en-US', {
          month: 'numeric',
          day: 'numeric',
          timeZone: appTimeZone,
        });
      }
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: appTimeZone,
      });
    }
    const date = new Date(d.date + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: appTimeZone,
    });
  });

  const spyRaw = data.map((d) => d.spy);
  const compRaw = data.map((d) => d.comparison);

  const spyNorm = normalize(spyRaw);
  const compNorm = normalize(compRaw);

  // Fill colors: green when SPY < comparison (healthy breadth), red otherwise

  breadthChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'SPY',
          data: spyNorm,
          borderColor: '#58a6ff',
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          pointRadius: spyNorm.length > 15 ? 0 : 3,
          pointHoverRadius: 5,
          tension: 0.3,
          order: 1,
          fill: false,
        },
        {
          label: compLabel,
          data: compNorm,
          borderColor: '#d2a8ff',
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          pointRadius: compNorm.length > 15 ? 0 : 3,
          pointHoverRadius: 5,
          tension: 0.3,
          order: 2,
          // Fill to the SPY dataset (index 0)
          fill: {
            target: 0,
            above: 'rgba(63, 185, 80, 0.18)', // comparison above SPY → SPY < comparison → green
            below: 'rgba(248, 81, 73, 0.18)', // comparison below SPY → SPY > comparison → red
          },
        },
      ],
    },
    options: makeBreadthChartOptions(c, {
      yTickCallback: (value) => (value as number).toFixed(1),
      tooltipCallback: (context) => {
        const val = (context.parsed.y ?? 0).toFixed(2);
        return `${context.dataset.label ?? ''}: ${val}`;
      },
      extraPlugins: { filler: { propagate: true } },
    }),
  });
}

async function loadBreadth(): Promise<void> {
  const error = document.getElementById('breadth-error');

  if (error) error.style.display = 'none';

  try {
    const response = await fetchBreadthData(breadthStore.getState().metric, breadthStore.getState().timeframeDays);

    if (response.points.length === 0) {
      if (error) {
        error.textContent = 'No data available for this timeframe';
        error.style.display = 'block';
      }
      return;
    }

    renderBreadthChart(response.points, breadthStore.getState().metric, response.intraday);
  } catch (err) {
    console.error('Breadth load error:', err);

    if (error) {
      error.textContent = 'Failed to load breadth data';
      error.style.display = 'block';
    }
  }
}

export function setBreadthTimeframe(days: number): void {
  breadthStore.getState().setTimeframeDays(days);
  setActiveInGroup('#breadth-tf-btns', 'days', String(days));
  loadBreadth();
}

export function setBreadthMetric(metric: 'SVIX' | 'RSP' | 'MAGS'): void {
  breadthStore.getState().setMetric(metric);
  setActiveInGroup('#breadth-metric-btns', 'metric', metric);
  loadBreadth();
}

// ---------------------------------------------------------------------------
// Breadth MA: % Above Moving Averages
// ---------------------------------------------------------------------------

async function fetchBreadthMA(days: number): Promise<BreadthMAResponse> {
  const response = await fetch(`/api/breadth/ma?days=${days}`);
  if (!response.ok) throw new Error('Failed to fetch breadth MA data');
  return response.json();
}

function gaugeColor(pct: number): string {
  if (pct < 30) return '#f85149'; // red
  if (pct < 60) return '#d29922'; // yellow
  return '#3fb950'; // green
}

function renderBreadthGauges(snapshot: BreadthMASnapshot | undefined): void {
  const container = document.getElementById('breadth-ma-gauges');
  if (!container) return;
  container.textContent = '';

  if (!snapshot) {
    const msg = document.createElement('div');
    msg.style.cssText = 'color:var(--text-secondary);font-size:0.85rem;grid-column:1/-1;text-align:center';
    msg.textContent = 'No snapshot data available';
    container.appendChild(msg);
    return;
  }

  const gauges = [
    { label: '21 MA', value: snapshot.ma21 },
    { label: '50 MA', value: snapshot.ma50 },
    { label: '100 MA', value: snapshot.ma100 },
    { label: '200 MA', value: snapshot.ma200 },
  ];

  for (const g of gauges) {
    const color = gaugeColor(g.value);

    const card = document.createElement('div');
    card.className = 'breadth-gauge-card';

    const labelEl = document.createElement('div');
    labelEl.className = 'breadth-gauge-label';
    labelEl.textContent = g.label;

    const valueEl = document.createElement('div');
    valueEl.className = 'breadth-gauge-value';
    valueEl.style.color = color;
    valueEl.textContent = `${g.value.toFixed(1)}%`;

    const barEl = document.createElement('div');
    barEl.className = 'breadth-gauge-bar';

    const fillEl = document.createElement('div');
    fillEl.className = 'breadth-gauge-fill';
    fillEl.style.width = `${g.value}%`;
    fillEl.style.background = color;

    barEl.appendChild(fillEl);
    card.appendChild(labelEl);
    card.appendChild(valueEl);
    card.appendChild(barEl);
    container.appendChild(card);
  }
}

function renderBreadthMAChart(history: BreadthMAHistory[]): void {
  const canvas = document.getElementById('breadth-ma-chart') as HTMLCanvasElement;
  if (!canvas) return;
  const c = getThemeColors();

  if (breadthMAChart) {
    breadthMAChart.destroy();
    breadthMAChart = null;
  }

  if (!history || history.length === 0) return;

  const labels = history.map((h) => {
    const date = new Date(h.date + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  breadthMAChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '21 MA',
          data: history.map((h) => h.ma21),
          borderColor: '#00d4ff',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
        {
          label: '50 MA',
          data: history.map((h) => h.ma50),
          borderColor: '#58a6ff',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
        {
          label: '100 MA',
          data: history.map((h) => h.ma100),
          borderColor: '#bc8cff',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
        {
          label: '200 MA',
          data: history.map((h) => h.ma200),
          borderColor: '#f0883e',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: makeBreadthChartOptions(c, {
      legendOnClick: (_e: unknown, legendItem: ChartLegendItem, legend: ChartLegendHandle) => {
        const meta = legend.chart.getDatasetMeta(legendItem.datasetIndex);
        meta.hidden = !meta.hidden;
        legend.chart.update();
        if (breadthMAChart) syncHiddenMAs(breadthMAChart);
      },
      tooltipCallback: (ctx) => `${ctx.dataset.label ?? ''}: ${(ctx.parsed.y ?? 0).toFixed(1)}%`,
      annotation50: true,
      yTickCallback: (value) => `${value}%`,
      yStepSize: 10,
    }),
  });

  applyHiddenMAs(breadthMAChart);
}

function renderBreadthMAForIndex(index: string): void {
  if (!breadthMAData) return;
  const snapshot = breadthMAData.snapshots.find((s) => s.index === index);
  renderBreadthGauges(snapshot);
  renderBreadthMAChart(breadthMAData.history[index] || []);
}

export function setBreadthMAIndex(index: string): void {
  breadthStore.getState().setMAIndex(index);
  setActiveInGroup('#breadth-ma-index-btns', 'index', index);
  renderBreadthMAForIndex(index);
}

async function loadBreadthMA(): Promise<void> {
  const errorEl = document.getElementById('breadth-ma-error');
  if (errorEl) errorEl.style.display = 'none';

  try {
    breadthMAData = await fetchBreadthMA(BREADTH_MA_HISTORY_DAYS);
    renderBreadthMAForIndex(breadthStore.getState().maIndex);
    renderBreadthCompareChart();
    renderBreadthBarsChart();
  } catch (err) {
    console.error('Breadth MA load error:', err);
    if (errorEl) {
      errorEl.textContent = 'Failed to load breadth MA data';
      errorEl.style.display = 'block';
    }
  }
}

// ---------------------------------------------------------------------------
// Comparative Breadth: index price vs breadth MA lines, all normalized to 100
// ---------------------------------------------------------------------------

/** Normalize a series so the first non-null value = 100. Null/missing values stay null. */
function normalizeToBase100(values: (number | null)[]): (number | null)[] {
  const first = values.find((v) => v !== null && v !== undefined && !isNaN(v as number)) as number | undefined;
  if (first === null || first === undefined || first === 0) return values.map(() => null);
  return values.map((v) =>
    v === null || v === undefined || isNaN(v as number) ? null : ((v as number) / first) * 100,
  );
}

function renderBreadthCompareChart(): void {
  const canvas = document.getElementById('breadth-compare-chart') as HTMLCanvasElement;
  if (!canvas || !breadthMAData) return;
  const c = getThemeColors();

  if (breadthCompareChart) {
    breadthCompareChart.destroy();
    breadthCompareChart = null;
  }

  const history = (breadthMAData.history[breadthStore.getState().compareIndex] || []).slice(
    -breadthStore.getState().compareTfDays,
  );
  if (history.length === 0) return;

  const labels = history.map((h) => {
    const date = new Date(h.date + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const ptRadius = history.length > 20 ? 0 : 3;

  // Raw value arrays
  const rawClose = history.map((h) => (h.close !== null && h.close !== undefined ? h.close : null));
  const rawMa21 = history.map((h) => h.ma21);
  const rawMa50 = history.map((h) => h.ma50);
  const rawMa100 = history.map((h) => h.ma100);
  const rawMa200 = history.map((h) => (h.ma200 > 0 ? h.ma200 : null));

  // Normalized to 100 at start
  const normClose = normalizeToBase100(rawClose);
  const normMa21 = normalizeToBase100(rawMa21);
  const normMa50 = normalizeToBase100(rawMa50);
  const normMa100 = normalizeToBase100(rawMa100);
  const normMa200 = normalizeToBase100(rawMa200);

  const datasets = [
    {
      label: breadthStore.getState().compareIndex,
      data: normClose,
      rawValues: rawClose,
      rawSuffix: '',
      rawDecimals: 2,
      borderColor: c.textPrimary,
      backgroundColor: 'transparent',
      borderWidth: 2.5,
      pointRadius: ptRadius,
      pointHoverRadius: 5,
      tension: 0.2,
      fill: false,
    },
    {
      label: '21 MA',
      data: normMa21,
      rawValues: rawMa21,
      rawSuffix: '%',
      rawDecimals: 1,
      borderColor: '#00d4ff',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [],
      pointRadius: ptRadius,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: false,
    },
    {
      label: '50 MA',
      data: normMa50,
      rawValues: rawMa50,
      rawSuffix: '%',
      rawDecimals: 1,
      borderColor: '#58a6ff',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: ptRadius,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: false,
    },
    {
      label: '100 MA',
      data: normMa100,
      rawValues: rawMa100,
      rawSuffix: '%',
      rawDecimals: 1,
      borderColor: '#bc8cff',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: ptRadius,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: false,
    },
    {
      label: '200 MA',
      data: normMa200,
      rawValues: rawMa200,
      rawSuffix: '%',
      rawDecimals: 1,
      borderColor: '#f0883e',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: ptRadius,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: false,
    },
  ];

  breadthCompareChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: makeBreadthChartOptions(c, {
      legendOnClick: (_e: unknown, legendItem: ChartLegendItem, legend: ChartLegendHandle) => {
        const meta = legend.chart.getDatasetMeta(legendItem.datasetIndex);
        meta.hidden = !meta.hidden;
        legend.chart.update();
        if (breadthCompareChart) syncHiddenMAs(breadthCompareChart);
      },
      tooltipCallback: (ctx: ChartTooltipContext & { dataset: CompareChartDataset }) => {
        const ds = ctx.dataset;
        const norm = ctx.parsed.y;
        if (norm === null || norm === undefined) return;
        const pct = norm - 100;
        const sign = pct >= 0 ? '+' : '';
        const raw = ds.rawValues?.[ctx.dataIndex];
        const rawStr =
          raw !== null && raw !== undefined ? ` (${Number(raw).toFixed(ds.rawDecimals)}${ds.rawSuffix})` : '';
        return `${ds.label}: ${sign}${pct.toFixed(1)}%${rawStr}`;
      },
      yTickCallback: (value) => `${Number(value).toFixed(0)}`,
    }),
  });

  applyHiddenMAs(breadthCompareChart);
}

export function setBreadthCompareIndex(index: string): void {
  const st = breadthStore.getState();
  if (st.compareModeActive && st.lockedCompareIndex) {
    // In compare mode — this click picks the 2nd ticker
    if (index === st.lockedCompareIndex) return; // can't compare to self
    st.setCompareIndex2(index);
    const locked = st.lockedCompareIndex;
    document.querySelectorAll('#breadth-compare-index-btns .pane-btn').forEach((btn) => {
      const btnIndex = (btn as HTMLElement).dataset.index;
      btn.classList.toggle('active', btnIndex === index || btnIndex === locked);
      btn.classList.toggle('locked', btnIndex === locked);
    });
    const gaugesEl = document.getElementById('breadth-compare-gauges');
    if (gaugesEl) gaugesEl.style.display = '';
    renderBreadthCompareDual();
    return;
  }
  // Normal mode — just switch the single ticker
  st.setCompareIndex(index);
  setActiveInGroup('#breadth-compare-index-btns', 'index', index);
  renderBreadthCompareChart();
}

export function setBreadthCompareTf(days: number): void {
  breadthStore.getState().setCompareTfDays(days);
  setActiveInGroup('#breadth-compare-tf-btns', 'days', String(days));
  const st = breadthStore.getState();
  if (st.compareModeActive && st.compareIndex2) renderBreadthCompareDual();
  else renderBreadthCompareChart();
}

export function toggleBreadthCompareMode(): void {
  const st = breadthStore.getState();
  const newActive = !st.compareModeActive;
  st.setCompareModeActive(newActive);

  document.getElementById('breadth-compare-toggle')?.classList.toggle('active', newActive);

  if (newActive) {
    // Lock the current ticker — user must now pick a 2nd
    st.setLockedCompareIndex(st.compareIndex);
    st.setCompareIndex2(null);
    const locked = st.compareIndex;
    document.querySelectorAll('#breadth-compare-index-btns .pane-btn').forEach((btn) => {
      btn.classList.toggle('locked', (btn as HTMLElement).dataset.index === locked);
    });
    // Don't render dual chart yet — wait for 2nd pick
  } else {
    // Exit compare mode — restore single chart for the locked ticker
    const restoreIndex = st.lockedCompareIndex ?? st.compareIndex;
    st.setCompareIndex(restoreIndex);
    st.setLockedCompareIndex(null);
    st.setCompareIndex2(null);
    const gaugesEl = document.getElementById('breadth-compare-gauges');
    if (gaugesEl) gaugesEl.style.display = 'none';
    document.querySelectorAll('#breadth-compare-index-btns .pane-btn').forEach((btn) => btn.classList.remove('locked'));
    setActiveInGroup('#breadth-compare-index-btns', 'index', restoreIndex);
    renderBreadthCompareChart();
  }
}

function renderBreadthCompareDualSnapshot(
  snap1: BreadthMASnapshot | undefined,
  snap2: BreadthMASnapshot | undefined,
): void {
  const container = document.getElementById('breadth-compare-gauges');
  if (!container) return;
  container.textContent = '';

  const maFields: Array<{ key: keyof BreadthMASnapshot; label: string }> = [
    { key: 'ma21', label: '21d' },
    { key: 'ma50', label: '50d' },
    { key: 'ma100', label: '100d' },
    { key: 'ma200', label: '200d' },
  ];

  const _st = breadthStore.getState();
  for (const [snap, label] of [
    [snap1, _st.lockedCompareIndex ?? _st.compareIndex],
    [snap2, _st.compareIndex2 ?? ''],
  ] as const) {
    const row = document.createElement('div');
    row.className = 'breadth-compare-snap-row';

    const etfLabel = document.createElement('span');
    etfLabel.className = 'breadth-compare-snap-etf';
    etfLabel.textContent = label as string;
    row.appendChild(etfLabel);

    const valuesWrap = document.createElement('div');
    valuesWrap.className = 'breadth-compare-snap-values';

    for (const { key, label: maLabel } of maFields) {
      const val = snap ? Number((snap as BreadthMASnapshot)[key]) : null;
      const chip = document.createElement('div');
      chip.className = 'breadth-compare-snap-chip';

      const chipLabel = document.createElement('span');
      chipLabel.className = 'breadth-compare-snap-chip-label';
      chipLabel.textContent = maLabel;

      const chipVal = document.createElement('span');
      chipVal.className = 'breadth-compare-snap-chip-value';
      chipVal.style.color = val !== null && val !== undefined ? gaugeColor(val) : 'var(--text-secondary)';
      chipVal.textContent = val !== null && val !== undefined ? `${val.toFixed(1)}%` : '—';

      chip.appendChild(chipLabel);
      chip.appendChild(chipVal);
      valuesWrap.appendChild(chip);
    }

    row.appendChild(valuesWrap);
    container.appendChild(row);
  }
}

function renderBreadthCompareDual(): void {
  const canvas = document.getElementById('breadth-compare-chart') as HTMLCanvasElement;
  const _cst = breadthStore.getState();
  if (!canvas || !breadthMAData || !_cst.compareIndex2) return;
  const c = getThemeColors();
  const idx1 = _cst.lockedCompareIndex ?? _cst.compareIndex;
  const idx2 = _cst.compareIndex2;

  if (breadthCompareChart) {
    breadthCompareChart.destroy();
    breadthCompareChart = null;
  }

  const h1 = (breadthMAData.history[idx1] || []).slice(-_cst.compareTfDays);
  const h2 = (breadthMAData.history[idx2] || []).slice(-_cst.compareTfDays);
  if (h1.length === 0 && h2.length === 0) return;

  const labels = h1.map((h) =>
    new Date(h.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  );
  const ptRadius = h1.length > 20 ? 0 : 3;

  const MA_COLORS = ['#00d4ff', '#58a6ff', '#bc8cff', '#f0883e'];
  const MA_KEYS: Array<keyof BreadthMAHistory> = ['ma21', 'ma50', 'ma100', 'ma200'];
  const MA_LABELS = ['21d', '50d', '100d', '200d'];

  const datasets: any[] = []; // loaded from CDN Chart.js — no full type import
  MA_KEYS.forEach((key, i) => {
    datasets.push({
      label: `${idx1} ${MA_LABELS[i]}`,
      data: h1.map((h) => h[key]),
      borderColor: MA_COLORS[i],
      borderWidth: 2,
      borderDash: [],
      pointRadius: ptRadius,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: false,
    });
    datasets.push({
      label: `${idx2} ${MA_LABELS[i]}`,
      data: h2.map((h) => h[key]),
      borderColor: MA_COLORS[i],
      borderWidth: 2,
      borderDash: [5, 4],
      pointRadius: ptRadius,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: false,
    });
  });

  const snap1 = breadthMAData.snapshots.find((s) => s.index === idx1);
  const snap2 = breadthMAData.snapshots.find((s) => s.index === idx2);
  renderBreadthCompareDualSnapshot(snap1, snap2);

  const Chart_: any = Chart; // loaded from CDN — need raw constructor for plugin array

  breadthCompareChart = new Chart_(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: makeBreadthChartOptions(c, {
      layoutPadding: { right: 40 },
      legendOnClick: (_e: unknown, legendItem: ChartLegendItem, legend: ChartLegendHandle) => {
        const meta = legend.chart.getDatasetMeta(legendItem.datasetIndex);
        meta.hidden = !meta.hidden;
        legend.chart.update();
        if (breadthCompareChart) syncHiddenMAs(breadthCompareChart);
      },
      legendFontSize: 11,
      tooltipPadding: 10,
      tooltipCallback: (ctx) => {
        const v = ctx.parsed.y;
        return `${ctx.dataset.label ?? ''}: ${v !== null && v !== undefined ? v.toFixed(1) + '%' : '—'}`;
      },
      annotation50: true,
      yTickCallback: (value) => `${value}%`,
      yStepSize: 10,
    }),
    plugins: [
      {
        id: 'dualLineLabels',

        afterDatasetsDraw(chart: any) {
          // CDN chart instance with canvas ctx
          const ctx = chart.ctx as CanvasRenderingContext2D;
          ctx.font = 'bold 10px sans-serif';
          ctx.textBaseline = 'middle';
          // Draw ticker label at the right end of each visible dataset's last point.
          // Datasets come in pairs: [idx1 21d, idx2 21d, idx1 50d, idx2 50d, ...].
          // Only label the first visible dataset per ticker to avoid clutter.
          const labeled = new Set<string>();
          for (let i = 0; i < chart.data.datasets.length; i++) {
            const meta = chart.getDatasetMeta(i);
            if (meta.hidden) continue;
            const ds = chart.data.datasets[i];
            const label = (ds.label as string) ?? '';
            const ticker = label.split(' ')[0]; // "SPY 21d" → "SPY"
            if (labeled.has(ticker)) continue;
            const pts = meta.data;
            if (pts.length === 0) continue;
            const last = pts[pts.length - 1];
            if (last.x === null || last.x === undefined || last.y === null || last.y === undefined) continue;
            ctx.fillStyle = ds.borderColor as string;
            ctx.textAlign = 'left';
            ctx.fillText(ticker, (last.x as number) + 6, last.y as number);
            labeled.add(ticker);
          }
        },
      },
    ],
  }) as ChartInstance;

  applyHiddenMAs(breadthCompareChart);
}

// ---------------------------------------------------------------------------
// ETF Bar Rankings: horizontal bar chart of all ETFs' % > MA, sorted descending
// ---------------------------------------------------------------------------

/** Switch which MA window the bar chart ranks by. */
export function setBreadthBarsMA(ma: string): void {
  breadthStore.getState().setBarsMA(ma);
  setActiveInGroup('#breadth-bars-ma-btns', 'ma', ma);
  renderBreadthBarsChart();
}

/** Render horizontal bar chart showing all ETFs ranked by % above selected MA. */
function renderBreadthBarsChart(): void {
  const canvas = document.getElementById('breadth-bars-chart') as HTMLCanvasElement;
  if (!canvas || !breadthMAData) return;
  const c = getThemeColors();

  if (breadthBarsChart) {
    breadthBarsChart.destroy();
    breadthBarsChart = null;
  }

  const maKey = `ma${breadthStore.getState().barsMA}` as keyof BreadthMASnapshot;
  const sorted = [...breadthMAData.snapshots]
    .filter((s) => typeof s[maKey] === 'number')
    .sort((a, b) => (b[maKey] as number) - (a[maKey] as number));

  if (sorted.length === 0) return;

  const labels = sorted.map((s) => s.index);
  const values = sorted.map((s) => s[maKey] as number);
  const colors = values.map((v) => gaugeColor(v));

  const Chart_: any = Chart; // loaded from CDN — need raw constructor for plugin array

  breadthBarsChart = new Chart_(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
          barPercentage: 0.75,
          categoryPercentage: 0.85,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 50 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: any) => `${(ctx.parsed.x as number).toFixed(1)}%`, // CDN callback
          },
        },
      },
      scales: {
        x: {
          min: 0,
          max: 100,
          ticks: { color: c.textSecondary, font: { size: 11 }, callback: (v: number | string) => `${v}%` },
          grid: { color: c.borderOverlay30 },
        },
        y: {
          ticks: { color: c.textPrimary, font: { size: 12, weight: 'bold' } },
          grid: { display: false },
        },
      },
    },
    plugins: [
      {
        id: 'barValueLabels',

        afterDatasetsDraw(chart: any) {
          // CDN chart instance with canvas ctx
          const ctx = chart.ctx as CanvasRenderingContext2D;
          const meta = chart.getDatasetMeta(0);
          ctx.font = '11px sans-serif';
          ctx.fillStyle = c.textSecondary;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';

          meta.data.forEach((bar: any, i: number) => {
            const val = chart.data.datasets[0].data[i] as number;
            ctx.fillText(`${val.toFixed(1)}%`, (bar.x as number) + 6, bar.y as number);
          });
        },
      },
    ],
  }) as ChartInstance;
}

/** Initialize breadth data loading and wire ETF index button handlers. */
export function initBreadth(): void {
  populateBreadthIndexButtons();

  // Wire MA index buttons (module is already loaded, call directly)
  document.querySelectorAll('#breadth-ma-index-btns .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setBreadthMAIndex((btn as HTMLElement).dataset.index ?? '');
    });
  });

  // Wire Compare index buttons
  document.querySelectorAll('#breadth-compare-index-btns .pane-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setBreadthCompareIndex((btn as HTMLElement).dataset.index ?? '');
    });
  });

  loadBreadth();
  loadBreadthMA();
}

/**
 * Trigger server-side re-fetch from data API + recompute, then reload all charts.
 * The POST /api/breadth/ma/recompute endpoint fetches fresh grouped bars,
 * stores new closes, and recomputes all breadth snapshots for today.
 */
export async function refreshBreadth(): Promise<void> {
  try {
    const res = await fetch('/api/breadth/ma/recompute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      console.error('[breadth] Recompute failed:', res.status);
    }
  } catch (err: unknown) {
    console.error('[breadth] Recompute error:', err instanceof Error ? err.message : String(err));
  }
  await Promise.all([loadBreadth(), loadBreadthMA()]);
}

/**
 * Register the theme-change listener for breadth charts.
 * Call this once from the app entry point after the page is ready.
 * Keeping this out of module scope prevents side effects during testing.
 */
export function initBreadthThemeListener(): void {
  if (breadthThemeListenerBound) return;
  breadthThemeListenerBound = true;
  window.addEventListener('themechange', () => {
    if (breadthChart) {
      loadBreadth();
    }
    if (breadthMAData) {
      renderBreadthMAForIndex(breadthStore.getState().maIndex);
    }
    if (breadthCompareChart) {
      const _tst = breadthStore.getState();
      if (_tst.compareModeActive && _tst.compareIndex2) renderBreadthCompareDual();
      else renderBreadthCompareChart();
    }
    if (breadthBarsChart) {
      renderBreadthBarsChart();
    }
  });
}

import { getAppTimeZone } from './timezone';
import { getThemeColors } from './theme';

// Chart.js is loaded globally via CDN in index.html
declare const Chart: any;

import type { BreadthDataPoint, BreadthResponse, BreadthMASnapshot, BreadthMAHistory, BreadthMAResponse } from '../shared/api-types';

let breadthChart: any = null;
let currentTimeframeDays = 5;
let currentMetric: 'SVIX' | 'RSP' | 'MAGS' = 'SVIX';

// Breadth MA state
let breadthMAChart: any = null;
let currentMAIndex: 'SPY' | 'QQQ' | 'SMH' = 'SPY';
let breadthMAData: BreadthMAResponse | null = null;

// Comparative Breadth state
let breadthCompareChart: any = null;
let currentCompareIndex: 'SPY' | 'QQQ' | 'SMH' = 'SPY';
let currentCompareTfDays: number = 20;

export function getCurrentBreadthTimeframe(): number {
  return currentTimeframeDays;
}

export function getCurrentBreadthMetric(): string {
  return currentMetric;
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
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          labels: {
            color: c.textPrimary,
            font: { size: 12 },
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
          padding: 12,
          callbacks: {
            label: function (context: any) {
              const val = context.parsed.y.toFixed(2);
              return `${context.dataset.label}: ${val}`;
            },
          },
        },
        filler: {
          propagate: true,
        },
      },
      scales: {
        x: {
          ticks: {
            color: c.textSecondary,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
            font: { size: 11 },
          },
          grid: {
            color: c.borderOverlay30,
          },
        },
        y: {
          ticks: {
            color: c.textSecondary,
            font: { size: 11 },
            callback: function (value: number | string) {
              return (value as number).toFixed(1);
            },
          },
          grid: {
            color: c.borderOverlay30,
          },
        },
      },
    },
  });
}

async function loadBreadth(): Promise<void> {
  const error = document.getElementById('breadth-error');

  if (error) error.style.display = 'none';

  try {
    const response = await fetchBreadthData(currentMetric, currentTimeframeDays);

    if (response.points.length === 0) {
      if (error) {
        error.textContent = 'No data available for this timeframe';
        error.style.display = 'block';
      }
      return;
    }

    renderBreadthChart(response.points, currentMetric, response.intraday);
  } catch (err) {
    console.error('Breadth load error:', err);

    if (error) {
      error.textContent = 'Failed to load breadth data';
      error.style.display = 'block';
    }
  }
}

export function setBreadthTimeframe(days: number): void {
  currentTimeframeDays = days;

  // Update active button
  document.querySelectorAll('#breadth-tf-btns .pane-btn').forEach((btn) => {
    btn.classList.toggle('active', Number((btn as HTMLElement).dataset.days) === days);
  });

  loadBreadth();
}

export function setBreadthMetric(metric: 'SVIX' | 'RSP' | 'MAGS'): void {
  currentMetric = metric;

  // Update active button
  document.querySelectorAll('#breadth-metric-btns .pane-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.metric === metric);
  });

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
  if (pct < 30) return '#f85149';   // red
  if (pct < 60) return '#d29922';   // yellow
  return '#3fb950';                  // green
}

function renderBreadthGauges(snapshot: BreadthMASnapshot | undefined): void {
  const container = document.getElementById('breadth-ma-gauges');
  if (!container) return;

  if (!snapshot) {
    container.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85rem;grid-column:1/-1;text-align:center">No snapshot data available</div>';
    return;
  }

  const gauges = [
    { label: '21 MA', value: snapshot.ma21 },
    { label: '50 MA', value: snapshot.ma50 },
    { label: '100 MA', value: snapshot.ma100 },
    { label: '200 MA', value: snapshot.ma200 },
  ];

  container.innerHTML = gauges.map(g => `
    <div class="breadth-gauge-card">
      <div class="breadth-gauge-label">${g.label}</div>
      <div class="breadth-gauge-value" style="color:${gaugeColor(g.value)}">${g.value.toFixed(1)}%</div>
      <div class="breadth-gauge-bar">
        <div class="breadth-gauge-fill" style="width:${g.value}%;background:${gaugeColor(g.value)}"></div>
      </div>
    </div>
  `).join('');
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

  const labels = history.map(h => {
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
          data: history.map(h => h.ma21),
          borderColor: '#00d4ff',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
        {
          label: '50 MA',
          data: history.map(h => h.ma50),
          borderColor: '#58a6ff',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
        {
          label: '100 MA',
          data: history.map(h => h.ma100),
          borderColor: '#bc8cff',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
        {
          label: '200 MA',
          data: history.map(h => h.ma200),
          borderColor: '#f0883e',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: c.textPrimary,
            font: { size: 12 },
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
          padding: 12,
          callbacks: {
            label: (ctx: any) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          },
        },
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
      },
      scales: {
        x: {
          ticks: {
            color: c.textSecondary,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
            font: { size: 11 },
          },
          grid: { color: c.borderOverlay30 },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: c.textSecondary,
            font: { size: 11 },
            callback: (value: number | string) => `${value}%`,
          },
          grid: { color: c.borderOverlay30 },
        },
      },
    },
  });
}

function renderBreadthMAForIndex(index: 'SPY' | 'QQQ' | 'SMH'): void {
  if (!breadthMAData) return;
  const snapshot = breadthMAData.snapshots.find(s => s.index === index);
  renderBreadthGauges(snapshot);
  renderBreadthMAChart(breadthMAData.history[index] || []);

  const subtitle = document.getElementById('breadth-ma-subtitle');
  if (subtitle) subtitle.textContent = `${index} — % Above Moving Averages`;
}

export function setBreadthMAIndex(index: 'SPY' | 'QQQ' | 'SMH'): void {
  currentMAIndex = index;
  document.querySelectorAll('#breadth-ma-index-btns .pane-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.index === index);
  });
  renderBreadthMAForIndex(index);
}

async function loadBreadthMA(): Promise<void> {
  const errorEl = document.getElementById('breadth-ma-error');
  if (errorEl) errorEl.style.display = 'none';

  try {
    breadthMAData = await fetchBreadthMA(60);
    renderBreadthMAForIndex(currentMAIndex);
    renderBreadthCompareChart();
  } catch (err) {
    console.error('Breadth MA load error:', err);
    if (errorEl) {
      errorEl.textContent = 'Failed to load breadth MA data';
      errorEl.style.display = 'block';
    }
  }
}

// ---------------------------------------------------------------------------
// Comparative Breadth: all 4 MA lines for one index over a timeframe
// ---------------------------------------------------------------------------

function renderBreadthCompareChart(): void {
  const canvas = document.getElementById('breadth-compare-chart') as HTMLCanvasElement;
  if (!canvas || !breadthMAData) return;
  const c = getThemeColors();

  if (breadthCompareChart) {
    breadthCompareChart.destroy();
    breadthCompareChart = null;
  }

  const history = (breadthMAData.history[currentCompareIndex] || []).slice(-currentCompareTfDays);

  const labels = history.map(h => {
    const date = new Date(h.date + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const maConfigs: Array<{ key: keyof BreadthMAHistory; label: string; color: string }> = [
    { key: 'ma21',  label: '21 MA',  color: '#00d4ff' },
    { key: 'ma50',  label: '50 MA',  color: '#58a6ff' },
    { key: 'ma100', label: '100 MA', color: '#bc8cff' },
    { key: 'ma200', label: '200 MA', color: '#f0883e' },
  ];

  const datasets = maConfigs.map(({ key, label, color }) => ({
    label,
    data: history.map(h => h[key] as number),
    borderColor: color,
    backgroundColor: 'transparent',
    borderWidth: 2,
    pointRadius: history.length > 25 ? 0 : 3,
    pointHoverRadius: 5,
    tension: 0.3,
    fill: false,
  }));

  breadthCompareChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          onClick: (_e: any, legendItem: any, legend: any) => {
            // Default Chart.js toggle behaviour
            const index = legendItem.datasetIndex;
            const meta = legend.chart.getDatasetMeta(index);
            meta.hidden = !meta.hidden;
            legend.chart.update();
          },
          labels: {
            color: c.textPrimary,
            font: { size: 12 },
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
          padding: 12,
          callbacks: {
            label: (ctx: any) => `${ctx.dataset.label}: ${(ctx.parsed.y as number).toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: c.textSecondary,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
            font: { size: 11 },
          },
          grid: { color: c.borderOverlay30 },
        },
        y: {
          min: 0,
          max: 100,
          ticks: {
            color: c.textSecondary,
            font: { size: 11 },
            callback: (value: number | string) => `${value}%`,
          },
          grid: { color: c.borderOverlay30 },
        },
      },
    },
  });
}

function updateBreadthCompareSubtitle(): void {
  const subtitle = document.getElementById('breadth-compare-subtitle');
  if (subtitle) {
    subtitle.textContent = `${currentCompareIndex} — % Above Moving Averages (${currentCompareTfDays}d)`;
  }
}

export function setBreadthCompareIndex(index: 'SPY' | 'QQQ' | 'SMH'): void {
  currentCompareIndex = index;
  document.querySelectorAll('#breadth-compare-index-btns .pane-btn').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.index === index);
  });
  updateBreadthCompareSubtitle();
  renderBreadthCompareChart();
}

export function setBreadthCompareTf(days: number): void {
  currentCompareTfDays = days;
  document.querySelectorAll('#breadth-compare-tf-btns .pane-btn').forEach(btn => {
    btn.classList.toggle('active', Number((btn as HTMLElement).dataset.days) === days);
  });
  updateBreadthCompareSubtitle();
  renderBreadthCompareChart();
}

export function initBreadth(): void {
  loadBreadth();
  loadBreadthMA();
}

window.addEventListener('themechange', () => {
  if (breadthChart) {
    loadBreadth();
  }
  if (breadthMAData) {
    renderBreadthMAForIndex(currentMAIndex);
  }
  if (breadthCompareChart) {
    renderBreadthCompareChart();
  }
});

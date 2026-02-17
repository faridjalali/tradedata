import { getAppTimeZone } from './timezone';
import { getThemeColors } from './theme';

// Chart.js is loaded globally via CDN in index.html
declare const Chart: any;

import type { BreadthDataPoint, BreadthResponse } from '../shared/api-types';

let breadthChart: any = null;
let currentTimeframeDays = 5;
let currentMetric: 'SVIX' | 'RSP' | 'MAGS' = 'SVIX';

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

export function initBreadth(): void {
  loadBreadth();
}

window.addEventListener('themechange', () => {
  if (breadthChart) {
    loadBreadth();
  }
});

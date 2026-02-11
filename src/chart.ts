// Main chart rendering and management

import { fetchChartData, aggregate2HourBars, ChartInterval, RSIDisplayMode, CandleBar } from './chartApi';
import { RSIChart } from './rsi';

// Declare Lightweight Charts global
declare const LightweightCharts: any;

// Chart state
let currentTicker: string | null = null;
let currentInterval: ChartInterval = '1day';
let priceChart: any = null;
let candleSeries: any = null;
let rsiChart: RSIChart | null = null;
let isLoading = false;

// DOM elements
let priceContainer: HTMLElement | null = null;
let rsiContainer: HTMLElement | null = null;
let loadingEl: HTMLElement | null = null;
let errorEl: HTMLElement | null = null;
let chartContent: HTMLElement | null = null;

export function renderCustomChart(ticker: string): void {
  currentTicker = ticker;

  // Get DOM elements
  priceContainer = document.getElementById('price-chart-container');
  rsiContainer = document.getElementById('rsi-chart-container');
  loadingEl = document.getElementById('chart-loading');
  errorEl = document.getElementById('chart-error');
  chartContent = document.getElementById('chart-content');

  if (!priceContainer || !rsiContainer) {
    console.error('Chart containers not found');
    return;
  }

  // Initialize charts
  initializeCharts();

  // Set up event listeners
  setupEventListeners();

  // Load initial data (daily timeframe)
  loadChartData(ticker, currentInterval);
}

function initializeCharts(): void {
  if (!priceContainer || !rsiContainer) return;

  // Create price chart
  if (!priceChart) {
    priceChart = LightweightCharts.createChart(priceContainer, {
      height: 400,
      layout: {
        background: { color: '#0d1117' },
        textColor: '#c9d1d9'
      },
      grid: {
        vertLines: { color: '#21262d' },
        horzLines: { color: '#21262d' }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#21262d'
      },
      rightPriceScale: {
        borderColor: '#21262d'
      },
      crosshair: {
        mode: 1 // CrosshairMode.Normal
      }
    });

    // Add candlestick series
    candleSeries = priceChart.addCandlestickSeries({
      upColor: '#3fb950',
      downColor: '#f85149',
      borderVisible: false,
      wickUpColor: '#3fb950',
      wickDownColor: '#f85149'
    });
  }
}

function setupEventListeners(): void {
  // Timeframe selector
  const timeframeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:first-child .tf-btn');
  timeframeButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const interval = target.dataset.interval as ChartInterval;
      if (interval && currentTicker) {
        setTimeframe(interval);
      }
    });
  });

  // RSI display mode toggle
  const modeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:last-child .tf-btn');
  modeButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const mode = target.dataset.mode as RSIDisplayMode;
      if (mode && rsiChart) {
        setRSIDisplayMode(mode);
      }
    });
  });
}

function setTimeframe(interval: ChartInterval): void {
  if (isLoading || !currentTicker || interval === currentInterval) return;

  currentInterval = interval;

  // Update active button
  const timeframeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:first-child .tf-btn');
  timeframeButtons.forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.interval === interval);
  });

  // Load new data
  loadChartData(currentTicker, interval);
}

function setRSIDisplayMode(mode: RSIDisplayMode): void {
  if (!rsiChart) return;

  // Update active button
  const modeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:last-child .tf-btn');
  modeButtons.forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
  });

  // Update RSI chart display mode
  rsiChart.setDisplayMode(mode);
}

async function loadChartData(ticker: string, interval: ChartInterval): Promise<void> {
  if (isLoading) return;
  isLoading = true;

  // Show loading state
  showLoading();

  try {
    // Fetch data from API
    const data = await fetchChartData(ticker, interval);

    // Handle 2-hour aggregation
    let bars = data.bars;
    if (interval === '2hour') {
      bars = aggregate2HourBars(bars);
    }

    // Update price chart
    if (candleSeries) {
      candleSeries.setData(bars);
      priceChart.timeScale().fitContent();
    }

    // Initialize or update RSI chart
    if (!rsiChart && rsiContainer) {
      rsiChart = new RSIChart({
        container: rsiContainer,
        data: data.rsi,
        displayMode: 'line'
      });

      // Synchronize time scales
      synchronizeCharts();
    } else if (rsiChart) {
      rsiChart.setData(data.rsi);
    }

    // Hide loading, show content
    hideLoading();
  } catch (error) {
    console.error('Failed to load chart data:', error);
    showError(error instanceof Error ? error.message : 'Failed to load chart data');
  } finally {
    isLoading = false;
  }
}

function synchronizeCharts(): void {
  if (!priceChart || !rsiChart) return;

  const rsiChartInstance = rsiChart.getChart();

  // Sync price chart → RSI chart
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (timeRange) {
      rsiChartInstance.timeScale().setVisibleLogicalRange(timeRange);
    }
  });

  // Sync RSI chart → price chart
  rsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (timeRange) {
      priceChart.timeScale().setVisibleLogicalRange(timeRange);
    }
  });

  // Sync crosshair
  priceChart.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      rsiChartInstance.clearCrosshairPosition();
      return;
    }
    rsiChartInstance.setCrosshairPosition(param.logical, param.time);
  });

  rsiChartInstance.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      priceChart.clearCrosshairPosition();
      return;
    }
    priceChart.setCrosshairPosition(param.logical, param.time);
  });
}

function showLoading(): void {
  if (loadingEl) loadingEl.style.display = 'block';
  if (errorEl) errorEl.style.display = 'none';
  if (chartContent) chartContent.style.opacity = '0.5';
}

function hideLoading(): void {
  if (loadingEl) loadingEl.style.display = 'none';
  if (chartContent) chartContent.style.opacity = '1';
}

function showError(message: string): void {
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }
  if (loadingEl) loadingEl.style.display = 'none';
  if (chartContent) chartContent.style.opacity = '0.5';
}

// Window resize handler
window.addEventListener('resize', () => {
  if (priceChart) {
    priceChart.resize(priceContainer?.clientWidth || 0, 400);
  }
  if (rsiChart) {
    rsiChart.resize();
  }
});

// Export for use in ticker.ts
export { currentTicker, currentInterval };

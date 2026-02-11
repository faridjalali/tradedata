// Main chart rendering and management

import { fetchChartData, aggregate2HourBars, ChartInterval, RSIDisplayMode, CandleBar, RSIPoint } from './chartApi';
import { RSIChart } from './rsi';

// Declare Lightweight Charts global
declare const LightweightCharts: any;
declare const LightweightChartsLineTools: any;

// Chart state
let currentTicker: string | null = null;
let currentInterval: ChartInterval = '1day';
let priceChart: any = null;
let candleSeries: any = null;
let rsiChart: RSIChart | null = null;
let priceLineTools: any = null;
let isLoading = false;

// DOM elements
let priceContainer: HTMLElement | null = null;
let rsiContainer: HTMLElement | null = null;
let loadingEl: HTMLElement | null = null;
let errorEl: HTMLElement | null = null;
let chartContent: HTMLElement | null = null;

export function renderCustomChart(ticker: string): void {
  // Prevent redundant initialization if already rendered for this ticker
  if (currentTicker === ticker && priceChart && rsiChart) {
    return; // Already initialized for this ticker
  }

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

  // Initialize charts only if not already created
  if (!priceChart) {
    initializeCharts();
    setupEventListeners();
  }

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
        vertLines: { visible: false },
        horzLines: { visible: false }
      },
      timeScale: {
        visible: false  // Hide price chart time scale
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

    // No line tools for price chart - divergence tool only on RSI chart
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

  // Drawing tools
  const drawingButtons = document.querySelectorAll('#drawing-tools .tf-btn');
  drawingButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tool = target.dataset.tool;
      if (tool) {
        handleDrawingTool(tool);
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

    // Handle 2-hour aggregation for bars, then filter RSI to match
    let bars = data.bars;
    let rsiData: RSIPoint[] = data.rsi;

    if (interval === '2hour') {
      bars = aggregate2HourBars(bars);

      // Filter RSI data to only include points that have matching times in aggregated bars
      const barTimes = new Set(bars.map(b => b.time));
      rsiData = data.rsi.filter(r => barTimes.has(r.time));
    }

    // Update price chart
    if (candleSeries) {
      candleSeries.setData(bars);
    }

    // Initialize or update RSI chart
    if (!rsiChart && rsiContainer) {
      rsiChart = new RSIChart({
        container: rsiContainer,
        data: rsiData,
        displayMode: 'line',
        priceData: bars.map(b => ({ time: b.time, close: b.close }))
      });

      // Synchronize time scales
      synchronizeCharts();
    } else if (rsiChart) {
      rsiChart.setData(rsiData, bars.map(b => ({ time: b.time, close: b.close })));
    }

    // After both charts have data, fit content and scroll to show most recent data on right
    if (priceChart && rsiChart) {
      priceChart.timeScale().fitContent();
      // Small delay to ensure fitContent completes, then scroll to show rightmost data
      setTimeout(() => {
        priceChart.timeScale().scrollToRealTime();
      }, 50);
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

  let isPriceChartChanging = false;
  let isRSIChartChanging = false;

  // Sync price chart → RSI chart (bidirectional with guards to prevent loops)
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (timeRange && !isRSIChartChanging) {
      isPriceChartChanging = true;
      rsiChartInstance.timeScale().setVisibleLogicalRange(timeRange);
      isPriceChartChanging = false;
    }
  });

  // Sync RSI chart → price chart
  rsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (timeRange && !isPriceChartChanging) {
      isRSIChartChanging = true;
      priceChart.timeScale().setVisibleLogicalRange(timeRange);
      isRSIChartChanging = false;
    }
  });

  // Sync crosshair between charts
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

function handleDrawingTool(tool: string): void {
  if (!rsiChart) {
    console.warn('RSI chart not available');
    return;
  }

  try {
    if (tool === 'clear') {
      // Clear divergence highlights from RSI chart
      rsiChart.clearDivergence();
      rsiChart.deactivateDivergenceTool();

      // Remove active state from all tool buttons
      const drawingButtons = document.querySelectorAll('#drawing-tools .tf-btn');
      drawingButtons.forEach(btn => btn.classList.remove('active'));

      return;
    }

    // Activate/deactivate divergence tool
    const drawingButtons = document.querySelectorAll('#drawing-tools .tf-btn');
    const trendBtn = Array.from(drawingButtons).find(
      btn => (btn as HTMLElement).dataset.tool === 'trend'
    ) as HTMLElement;

    if (tool === 'trend') {
      const isActive = trendBtn.classList.contains('active');

      if (isActive) {
        // Deactivate
        trendBtn.classList.remove('active');
        rsiChart.deactivateDivergenceTool();
      } else {
        // Activate
        drawingButtons.forEach(btn => btn.classList.remove('active'));
        trendBtn.classList.add('active');
        rsiChart.activateDivergenceTool();
      }
    }
  } catch (error) {
    console.error('Error activating divergence tool:', error);
  }
}

// Removed drawing save/load functions - using divergence detection instead

function showLoading(): void {
  // Don't show loading text, just dim the charts slightly
  if (errorEl) errorEl.style.display = 'none';
  if (chartContent) chartContent.style.opacity = '0.8';
}

function hideLoading(): void {
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

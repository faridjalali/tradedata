// Main chart rendering and management

import { fetchChartData, aggregate2HourBars, ChartInterval, RSIDisplayMode, CandleBar } from './chartApi';
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

    // Initialize line tools for price chart
    try {
      if (typeof LightweightChartsLineTools !== 'undefined' && LightweightChartsLineTools.LineTools) {
        priceLineTools = new LightweightChartsLineTools.LineTools(priceChart);
      }
    } catch (error) {
      console.warn('Line tools plugin not available or failed to initialize:', error);
    }
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

    // Handle 2-hour aggregation
    let bars = data.bars;
    if (interval === '2hour') {
      bars = aggregate2HourBars(bars);
    }

    // Update price chart
    if (candleSeries) {
      candleSeries.setData(bars);
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

    // Load saved drawings after a short delay to ensure charts are fully rendered
    setTimeout(() => loadDrawings(), 100);
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
  if (!priceLineTools) {
    console.warn('Line tools not available');
    return;
  }

  try {
    if (tool === 'clear') {
      // Clear all drawings from both price and RSI charts
      if (priceLineTools.clearDrawings) {
        priceLineTools.clearDrawings();
      }
      if (rsiChart) {
        const rsiLineTools = rsiChart.getLineTools();
        if (rsiLineTools && rsiLineTools.clearDrawings) {
          rsiLineTools.clearDrawings();
        }
      }

      // Clear from localStorage
      if (currentTicker && currentInterval) {
        localStorage.removeItem(`drawings_price_${currentTicker}_${currentInterval}`);
        localStorage.removeItem(`drawings_rsi_${currentTicker}_${currentInterval}`);
      }

      // Remove active state from all tool buttons
      const drawingButtons = document.querySelectorAll('#drawing-tools .tf-btn');
      drawingButtons.forEach(btn => btn.classList.remove('active'));

      return;
    }

    // Activate drawing tool
    const drawingButtons = document.querySelectorAll('#drawing-tools .tf-btn');
    drawingButtons.forEach(btn => {
      if ((btn as HTMLElement).dataset.tool === tool) {
        btn.classList.toggle('active');
      } else if ((btn as HTMLElement).dataset.tool !== 'clear') {
        btn.classList.remove('active');
      }
    });

    // Activate the appropriate tool
    if (priceLineTools.startDrawing && LightweightChartsLineTools.DrawingType) {
      switch (tool) {
        case 'trend':
          priceLineTools.startDrawing(LightweightChartsLineTools.DrawingType.TREND_LINE);
          break;
        case 'horizontal':
          priceLineTools.startDrawing(LightweightChartsLineTools.DrawingType.HORIZONTAL_LINE);
          break;
        case 'ray':
          priceLineTools.startDrawing(LightweightChartsLineTools.DrawingType.RAY);
          break;
      }

      // Set up auto-save on drawing complete
      setupDrawingSaveHandler();
    }
  } catch (error) {
    console.error('Error activating drawing tool:', error);
  }
}

function setupDrawingSaveHandler(): void {
  if (!priceLineTools) return;

  // Save drawings when a drawing is added or modified
  priceLineTools.onDrawingAdded(() => saveDrawings());
  priceLineTools.onDrawingModified(() => saveDrawings());
  priceLineTools.onDrawingRemoved(() => saveDrawings());
}

function saveDrawings(): void {
  if (!currentTicker || !currentInterval || !priceLineTools) return;

  try {
    const priceDrawings = priceLineTools.exportDrawings();
    localStorage.setItem(`drawings_price_${currentTicker}_${currentInterval}`, priceDrawings);

    if (rsiChart) {
      const rsiLineTools = rsiChart.getLineTools();
      if (rsiLineTools) {
        const rsiDrawings = rsiLineTools.exportDrawings();
        localStorage.setItem(`drawings_rsi_${currentTicker}_${currentInterval}`, rsiDrawings);
      }
    }
  } catch (error) {
    console.error('Failed to save drawings:', error);
  }
}

function loadDrawings(): void {
  if (!currentTicker || !currentInterval || !priceLineTools) return;

  try {
    // Load price chart drawings
    const priceDrawingsStr = localStorage.getItem(`drawings_price_${currentTicker}_${currentInterval}`);
    if (priceDrawingsStr) {
      priceLineTools.importDrawings(priceDrawingsStr);
    }

    // Load RSI chart drawings
    if (rsiChart) {
      const rsiLineTools = rsiChart.getLineTools();
      if (rsiLineTools) {
        const rsiDrawingsStr = localStorage.getItem(`drawings_rsi_${currentTicker}_${currentInterval}`);
        if (rsiDrawingsStr) {
          rsiLineTools.importDrawings(rsiDrawingsStr);
        }
      }
    }
  } catch (error) {
    console.error('Failed to load drawings:', error);
  }
}

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

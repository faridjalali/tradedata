import { createChart, CrosshairMode } from 'lightweight-charts';
import { fetchChartData, ChartInterval } from './chartApi';
import { RSIChart } from './rsi';

let currentChartTicker: string | null = null;
let currentChartInterval: ChartInterval = '1day';
let priceChart: any = null;
let candleSeries: any = null;
let rsiChart: RSIChart | null = null;
let chartResizeObserver: ResizeObserver | null = null;
let latestRenderRequestId = 0;

// Create price chart
function createPriceChart(container: HTMLElement) {
  const chart = createChart(container, {
    layout: {
      background: { color: '#1e222d' },
      textColor: '#d1d4dc',
    },
    grid: {
      vertLines: { color: '#2b2b43' },
      horzLines: { color: '#2b2b43' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
    },
    rightPriceScale: {
      borderColor: '#2b2b43',
    },
    timeScale: {
      visible: false,
      borderVisible: false,
    },
  });

  const series = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350'
  });

  // No line tools for price chart - divergence tool only on RSI chart

  return { chart, series };
}

function normalizeCandleBars(bars: any[]): any[] {
  return bars.filter((bar) => (
    bar &&
    (typeof bar.time === 'string' || typeof bar.time === 'number') &&
    Number.isFinite(Number(bar.open)) &&
    Number.isFinite(Number(bar.high)) &&
    Number.isFinite(Number(bar.low)) &&
    Number.isFinite(Number(bar.close))
  ));
}

function ensureResizeObserver(chartContainer: HTMLElement, rsiContainer: HTMLElement): void {
  if (chartResizeObserver) return;

  chartResizeObserver = new ResizeObserver(() => {
    if (!priceChart) return;

    const chartRect = chartContainer.getBoundingClientRect();
    const rsiRect = rsiContainer.getBoundingClientRect();
    const priceWidth = Math.max(1, Math.floor(chartRect.width));
    const priceHeight = Math.max(1, Math.floor(chartRect.height));
    const rsiWidth = Math.max(1, Math.floor(rsiRect.width));
    const rsiHeight = Math.max(1, Math.floor(rsiRect.height));

    priceChart.applyOptions({ width: priceWidth, height: priceHeight });
    if (rsiChart) {
      rsiChart.getChart().applyOptions({ width: rsiWidth, height: rsiHeight });
    }
  });

  chartResizeObserver.observe(chartContainer);
  chartResizeObserver.observe(rsiContainer);
}

export async function renderCustomChart(ticker: string, interval: ChartInterval = currentChartInterval) {
  const requestId = ++latestRenderRequestId;
  currentChartInterval = interval;

  const chartContainer = document.getElementById('price-chart-container');
  const rsiContainer = document.getElementById('rsi-chart-container');
  const errorContainer = document.getElementById('chart-error');

  if (!chartContainer || !rsiContainer || !errorContainer) {
    console.error('Chart containers not found');
    return;
  }

  // Clear error
  errorContainer.style.display = 'none';
  errorContainer.textContent = '';

  // Initialize charts if needed
  if (!priceChart) {
    const { chart, series } = createPriceChart(chartContainer);
    priceChart = chart;
    candleSeries = series;
    setupChartSync();
  }

  ensureResizeObserver(chartContainer, rsiContainer);

  try {
    // Fetch data from API
    const data = await fetchChartData(ticker, interval);
    if (requestId !== latestRenderRequestId) return;

    // Retrieve bars and RSI directly (backend handles aggregation)
    const bars = normalizeCandleBars(data.bars || []);
    if (bars.length === 0) {
      throw new Error('No valid chart bars returned for this ticker/interval');
    }
    const rsiData = data.rsi;

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
      setupChartSync();
    } else if (rsiChart) {
      rsiChart.setData(rsiData, bars.map(b => ({ time: b.time, close: b.close })));
    }

    syncChartsToPriceRange();

    currentChartTicker = ticker;
  } catch (err: any) {
    if (requestId !== latestRenderRequestId) return;
    console.error('Failed to load chart:', err);
    errorContainer.textContent = `Error loading chart: ${err.message}`;
    errorContainer.style.display = 'block';
  }
}

function syncChartsToPriceRange(): void {
  if (!priceChart || !rsiChart) return;
  const priceRange = priceChart.timeScale().getVisibleRange();
  if (!priceRange) return;
  rsiChart.getChart().timeScale().setVisibleRange(priceRange);
}

// Setup sync between price and RSI charts
function setupChartSync() {
  if (!priceChart || !rsiChart) return;

  const rsiChartInstance = rsiChart.getChart();
  let isSyncingFromPrice = false;
  let isSyncingFromRSI = false;

  // Sync price chart → RSI chart by visible time range to avoid drift when datasets differ.
  priceChart.timeScale().subscribeVisibleTimeRangeChange((timeRange: any) => {
    if (timeRange && !isSyncingFromRSI) {
      isSyncingFromPrice = true;
      rsiChartInstance.timeScale().setVisibleRange(timeRange);
      isSyncingFromPrice = false;
    }
  });

  // Sync RSI chart → price chart.
  rsiChartInstance.timeScale().subscribeVisibleTimeRangeChange((timeRange: any) => {
    if (timeRange && !isSyncingFromPrice) {
      isSyncingFromRSI = true;
      priceChart.timeScale().setVisibleRange(timeRange);
      isSyncingFromRSI = false;
    }
  });

  // Sync crosshair between charts
  priceChart.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      rsiChartInstance.clearCrosshairPosition();
      return;
    }
    // Sync vertical line only (price=NaN)
    const rsiSeries = rsiChart?.getSeries();
    if (rsiSeries) {
      rsiChartInstance.setCrosshairPosition(NaN, param.time, rsiSeries);
    }
  });

  rsiChartInstance.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      priceChart.clearCrosshairPosition();
      return;
    }
    // Sync vertical line only (price=NaN)
    if (candleSeries) {
      priceChart.setCrosshairPosition(NaN, param.time, candleSeries);
    }
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
      document.querySelectorAll('#drawing-tools .tf-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tool') === 'trend') {
            btn.innerHTML = '🔍';
        }
      });
    } else if (tool === 'trend') {
      const btn = document.querySelector(`button[data-tool="${tool}"]`);
      if (btn?.classList.contains('active')) {
        // Deactivate
        rsiChart.deactivateDivergenceTool();
        btn.classList.remove('active');
        btn.innerHTML = '🔍';
      } else {
        // Activate
        rsiChart.activateDivergenceTool();
        btn?.classList.add('active');
        if (btn) btn.innerHTML = '✨Scanner Active';
      }
    }
  } catch (error) {
    console.error('Error handling drawing tool:', error);
  }
}

// Export for main.ts usage
export function initChartControls() {
  const controls = document.getElementById('chart-controls');
  if (!controls) return;

  // Interval buttons
  controls.querySelectorAll('button[data-interval]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const interval = target.getAttribute('data-interval') as ChartInterval;
      if (!interval) return;

      // Update active state
      controls.querySelectorAll('button[data-interval]').forEach(b => b.classList.remove('active'));
      target.classList.add('active');

      if (currentChartTicker) {
        renderCustomChart(currentChartTicker, interval);
      }
    });
  });

  // Drawing tools
  controls.querySelectorAll('button[data-tool]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement; // Use currentTarget to get the button element
      const tool = target.getAttribute('data-tool');
      if (tool) handleDrawingTool(tool);
    });
  });

  // RSI Display Mode
  controls.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLElement;
      const mode = target.getAttribute('data-mode') as any;
      if (!mode) return;

      controls.querySelectorAll('button[data-mode]').forEach(b => b.classList.remove('active'));
      target.classList.add('active');

      if (rsiChart) {
        rsiChart.setDisplayMode(mode);
      }
    });
  });
}

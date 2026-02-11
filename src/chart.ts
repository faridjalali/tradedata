import { createChart, CrosshairMode } from 'lightweight-charts';
import { fetchChartData, ChartInterval, RSIPoint } from './chartApi';
import { RSIChart } from './rsi';

let currentChartTicker: string | null = null;
let priceChart: any = null;
let candleSeries: any = null;
let rsiChart: RSIChart | null = null;
let isLoading = false;

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
      borderColor: '#2b2b43',
      timeVisible: true,
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

export async function renderCustomChart(ticker: string, interval: ChartInterval = '1day') {
  if (isLoading) return;
  isLoading = true;

  const chartContainer = document.getElementById('price-chart-container');
  const rsiContainer = document.getElementById('rsi-chart-container');
  const errorContainer = document.getElementById('chart-error');

  if (!chartContainer || !rsiContainer || !errorContainer) {
    console.error('Chart containers not found');
    isLoading = false;
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

  try {
    // Fetch data from API
    const data = await fetchChartData(ticker, interval);

    // Retrieve bars and RSI directly (backend handles aggregation)
    const bars = data.bars;
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

    currentChartTicker = ticker;

    // Handle resize
    const resizeObserver = new ResizeObserver(entries => {
      if (entries.length === 0 || !entries[0].contentRect) return;
      const { width, height } = entries[0].contentRect;
      priceChart.applyOptions({ width, height });
      if (rsiChart) {
        rsiChart.getChart().applyOptions({ width, height });
      }
    });
    resizeObserver.observe(chartContainer);
    resizeObserver.observe(rsiContainer);

  } catch (err: any) {
    console.error('Failed to load chart:', err);
    errorContainer.textContent = `Error loading chart: ${err.message}`;
    errorContainer.style.display = 'block';
  } finally {
    isLoading = false;
  }
}

// Setup sync between price and RSI charts
function setupChartSync() {
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
      const target = e.target as HTMLElement;
      const interval = target.getAttribute('data-interval') as ChartInterval;

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
      const target = e.target as HTMLElement;
      const mode = target.getAttribute('data-mode') as any;

      controls.querySelectorAll('button[data-mode]').forEach(b => b.classList.remove('active'));
      target.classList.add('active');

      if (rsiChart) {
        rsiChart.setDisplayMode(mode);
      }
    });
  });
}

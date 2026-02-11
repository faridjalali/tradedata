import { createChart, CrosshairMode } from 'lightweight-charts';
import { fetchChartData, ChartInterval } from './chartApi';
import { RSIChart } from './rsi';

let currentChartTicker: string | null = null;
let currentChartInterval: ChartInterval = '4hour';
let priceChart: any = null;
let candleSeries: any = null;
let rsiChart: RSIChart | null = null;
let chartResizeObserver: ResizeObserver | null = null;
let latestRenderRequestId = 0;
let priceByTime = new Map<string, number>();
let rsiByTime = new Map<string, number>();
let monthBoundaryTimes: number[] = [];
let priceMonthGridOverlayEl: HTMLDivElement | null = null;
let rsiMonthGridOverlayEl: HTMLDivElement | null = null;
const TREND_ICON = '✎';
const RIGHT_MARGIN_BARS = 10;
const SCALE_LABEL_CHARS = 5;
const SCALE_MIN_WIDTH_PX = 80;
const INVALID_SYMBOL_MESSAGE = 'Invalid symbol';
const MONTH_GRIDLINE_COLOR = '#21262d';

const MONTH_KEY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit'
});

function ensureMonthGridOverlay(container: HTMLElement, isPricePane: boolean): HTMLDivElement {
  const existing = isPricePane ? priceMonthGridOverlayEl : rsiMonthGridOverlayEl;
  if (existing && existing.parentElement === container) return existing;

  const overlay = document.createElement('div');
  overlay.className = isPricePane ? 'month-grid-overlay month-grid-overlay-price' : 'month-grid-overlay month-grid-overlay-rsi';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.left = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '6';
  container.appendChild(overlay);

  if (isPricePane) {
    priceMonthGridOverlayEl = overlay;
  } else {
    rsiMonthGridOverlayEl = overlay;
  }
  return overlay;
}

function unixSecondsFromTimeValue(time: string | number | null | undefined): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) return time;
  if (typeof time === 'string' && time.trim()) {
    const parsed = Date.parse(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function monthKeyInLA(unixSeconds: number): string {
  const parts = MONTH_KEY_FORMATTER.formatToParts(new Date(unixSeconds * 1000));
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  return `${year}-${month}`;
}

function buildMonthBoundaryTimes(bars: any[]): number[] {
  const result: number[] = [];
  let lastMonthKey = '';
  for (const bar of bars) {
    const unixSeconds = unixSecondsFromTimeValue(bar?.time);
    if (unixSeconds === null) continue;
    const monthKey = monthKeyInLA(unixSeconds);
    if (monthKey !== lastMonthKey) {
      result.push(unixSeconds);
      lastMonthKey = monthKey;
    }
  }
  return result;
}

function clearMonthGridOverlay(overlayEl: HTMLDivElement | null): void {
  if (!overlayEl) return;
  overlayEl.innerHTML = '';
}

function renderMonthGridLines(chart: any, overlayEl: HTMLDivElement | null): void {
  if (!chart || !overlayEl) return;

  overlayEl.innerHTML = '';
  if (!monthBoundaryTimes.length) return;

  const width = overlayEl.clientWidth || overlayEl.offsetWidth;
  if (!Number.isFinite(width) || width <= 0) return;

  for (const time of monthBoundaryTimes) {
    const x = chart.timeScale().timeToCoordinate(time);
    if (!Number.isFinite(x)) continue;
    if (x < 0 || x > width) continue;

    const line = document.createElement('div');
    line.style.position = 'absolute';
    line.style.top = '0';
    line.style.bottom = '0';
    line.style.left = `${Math.round(x)}px`;
    line.style.width = '1px';
    line.style.background = MONTH_GRIDLINE_COLOR;
    overlayEl.appendChild(line);
  }
}

function refreshMonthGridLines(): void {
  renderMonthGridLines(priceChart, priceMonthGridOverlayEl);
  renderMonthGridLines(rsiChart?.getChart(), rsiMonthGridOverlayEl);
}

function ensurePricePaneMessageEl(container: HTMLElement): HTMLDivElement {
  let messageEl = container.querySelector('.price-pane-message') as HTMLDivElement | null;
  if (messageEl) return messageEl;

  messageEl = document.createElement('div');
  messageEl.className = 'price-pane-message';
  messageEl.style.position = 'absolute';
  messageEl.style.top = '50%';
  messageEl.style.left = '50%';
  messageEl.style.transform = 'translate(-50%, -50%)';
  messageEl.style.color = '#8b949e';
  messageEl.style.fontSize = '1rem';
  messageEl.style.fontWeight = '600';
  messageEl.style.pointerEvents = 'none';
  messageEl.style.zIndex = '20';
  messageEl.style.display = 'none';
  container.appendChild(messageEl);
  return messageEl;
}

function setPricePaneMessage(container: HTMLElement, message: string | null): void {
  const messageEl = ensurePricePaneMessageEl(container);
  if (!message) {
    messageEl.style.display = 'none';
    messageEl.textContent = '';
    return;
  }
  messageEl.textContent = message;
  messageEl.style.display = 'block';
}

function isNoDataTickerError(err: unknown): boolean {
  const message = String((err as any)?.message || err || '');
  return /No .*data available for this ticker|No valid chart bars/i.test(message);
}

function formatPriceScaleLabel(value: number): string {
  if (!Number.isFinite(value)) return '';
  const label = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, ' ');
}

function timeKey(time: string | number): string {
  return typeof time === 'number' ? String(time) : time;
}

function sameLogicalRange(a: any, b: any): boolean {
  if (!a || !b) return false;
  return Math.abs(Number(a.from) - Number(b.from)) < 1e-6 && Math.abs(Number(a.to) - Number(b.to)) < 1e-6;
}

// Create price chart
function createPriceChart(container: HTMLElement) {
  const isMobileTouch = (
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) ||
    (typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0))
  );

  const chart = createChart(container, {
    layout: {
      background: { color: '#0d1117' },
      textColor: '#d1d4dc',
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
    },
    handleScroll: {
      pressedMouseMove: true,
      horzTouchDrag: true,
      // Required for touch-based price-axis drag on mobile.
      vertTouchDrag: isMobileTouch,
      mouseWheel: true,
    },
    handleScale: {
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: true,
      axisDoubleClickReset: true,
    },
    rightPriceScale: {
      borderColor: '#2b2b43',
      minimumWidth: SCALE_MIN_WIDTH_PX,
      entireTextOnly: true,
    },
    timeScale: {
      visible: false,
      borderVisible: false,
      fixRightEdge: false,
      rightBarStaysOnScroll: false,
      rightOffset: RIGHT_MARGIN_BARS,
    },
  });

  const series = chart.addCandlestickSeries({
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
    priceFormat: {
      type: 'custom',
      minMove: 0.01,
      formatter: (price: number) => formatPriceScaleLabel(Number(price))
    }
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

function applyChartSizes(chartContainer: HTMLElement, rsiContainer: HTMLElement): void {
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
  refreshMonthGridLines();
}

function ensureResizeObserver(chartContainer: HTMLElement, rsiContainer: HTMLElement): void {
  if (chartResizeObserver) return;

  chartResizeObserver = new ResizeObserver(() => {
    applyChartSizes(chartContainer, rsiContainer);
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
  setPricePaneMessage(chartContainer, null);
  ensureMonthGridOverlay(chartContainer, true);
  ensureMonthGridOverlay(rsiContainer, false);

  // Initialize charts if needed
  if (!priceChart) {
    const { chart, series } = createPriceChart(chartContainer);
    priceChart = chart;
    candleSeries = series;
    setupChartSync();
  }

  ensureResizeObserver(chartContainer, rsiContainer);
  applyChartSizes(chartContainer, rsiContainer);

  try {
    // Fetch data from API
    const data = await fetchChartData(ticker, interval);
    if (requestId !== latestRenderRequestId) return;

    // Retrieve bars and RSI directly (backend handles aggregation)
    const bars = normalizeCandleBars(data.bars || []);
    if (bars.length === 0) {
      throw new Error('No valid chart bars returned for this ticker/interval');
    }
    monthBoundaryTimes = buildMonthBoundaryTimes(bars);
    const rsiData = data.rsi;
    priceByTime = new Map(
      bars.map((bar) => [timeKey(bar.time), Number(bar.close)])
    );
    rsiByTime = new Map(
      (rsiData || [])
        .filter((point) => Number.isFinite(Number(point.value)))
        .map((point) => [timeKey(point.time), Number(point.value)])
    );

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
        priceData: bars.map(b => ({ time: b.time, close: b.close })),
        onTrendLineDrawn: () => {
          const trendBtn = document.querySelector('#drawing-tools button[data-tool="trend"]') as HTMLElement | null;
          if (trendBtn) {
            trendBtn.classList.remove('active');
            trendBtn.innerHTML = TREND_ICON;
          }
        }
      });
      setupChartSync();
      applyChartSizes(chartContainer, rsiContainer);
    } else if (rsiChart) {
      rsiChart.setData(rsiData, bars.map(b => ({ time: b.time, close: b.close })));
    }

    applyRightMargin();
    syncChartsToPriceRange();
    refreshMonthGridLines();

    currentChartTicker = ticker;
  } catch (err: any) {
    if (requestId !== latestRenderRequestId) return;
    console.error('Failed to load chart:', err);
    if (isNoDataTickerError(err)) {
      if (candleSeries) {
        candleSeries.setData([]);
      }
      if (rsiChart) {
        rsiChart.setData([], []);
      }
      monthBoundaryTimes = [];
      clearMonthGridOverlay(priceMonthGridOverlayEl);
      clearMonthGridOverlay(rsiMonthGridOverlayEl);
      setPricePaneMessage(chartContainer, INVALID_SYMBOL_MESSAGE);
      errorContainer.style.display = 'none';
      errorContainer.textContent = '';
      return;
    }

    errorContainer.textContent = `Error loading chart: ${err.message}`;
    errorContainer.style.display = 'block';
  }
}

function syncChartsToPriceRange(): void {
  if (!priceChart || !rsiChart) return;
  const priceRange = priceChart.timeScale().getVisibleLogicalRange();
  if (!priceRange) return;
  try {
    rsiChart.getChart().timeScale().setVisibleLogicalRange(priceRange);
    refreshMonthGridLines();
  } catch {
    // Ignore transient range sync errors during live updates.
  }
}

function applyRightMargin(): void {
  if (!priceChart) return;
  const rightOffset = RIGHT_MARGIN_BARS;
  priceChart.timeScale().applyOptions({ rightOffset });
  if (rsiChart) {
    rsiChart.getChart().timeScale().applyOptions({ rightOffset });
  }
  refreshMonthGridLines();
}

// Setup sync between price and RSI charts
function setupChartSync() {
  if (!priceChart || !rsiChart) return;

  const rsiChartInstance = rsiChart.getChart();
  let syncLock: 'price' | 'rsi' | null = null;
  const unlockAfterFrame = (owner: 'price' | 'rsi') => {
    requestAnimationFrame(() => {
      if (syncLock === owner) syncLock = null;
    });
  };

  // Sync price chart → RSI chart by logical range.
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (!timeRange || syncLock === 'rsi') return;
    const currentRSIRange = rsiChartInstance.timeScale().getVisibleLogicalRange();
    if (sameLogicalRange(currentRSIRange, timeRange)) return;
    syncLock = 'price';
    try {
      rsiChartInstance.timeScale().setVisibleLogicalRange(timeRange);
      refreshMonthGridLines();
    } finally {
      unlockAfterFrame('price');
    }
  });

  // Sync RSI chart → price chart.
  rsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
    if (!timeRange || syncLock === 'price') return;
    const currentPriceRange = priceChart.timeScale().getVisibleLogicalRange();
    if (sameLogicalRange(currentPriceRange, timeRange)) return;
    syncLock = 'rsi';
    try {
      priceChart.timeScale().setVisibleLogicalRange(timeRange);
      refreshMonthGridLines();
    } finally {
      unlockAfterFrame('rsi');
    }
  });

  // Sync crosshair between charts
  priceChart.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      rsiChartInstance.clearCrosshairPosition();
      return;
    }
    const mappedValue = rsiByTime.get(timeKey(param.time));
    if (!Number.isFinite(mappedValue)) {
      rsiChartInstance.clearCrosshairPosition();
      return;
    }
    const rsiSeries = rsiChart?.getSeries();
    if (rsiSeries) {
      try {
        rsiChartInstance.setCrosshairPosition(mappedValue, param.time, rsiSeries);
      } catch {
        rsiChartInstance.clearCrosshairPosition();
      }
    }
  });

  rsiChartInstance.subscribeCrosshairMove((param: any) => {
    if (!param || !param.time) {
      priceChart.clearCrosshairPosition();
      return;
    }
    const mappedValue = priceByTime.get(timeKey(param.time));
    if (!Number.isFinite(mappedValue)) {
      priceChart.clearCrosshairPosition();
      return;
    }
    if (candleSeries) {
      try {
        priceChart.setCrosshairPosition(mappedValue, param.time, candleSeries);
      } catch {
        priceChart.clearCrosshairPosition();
      }
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
            btn.innerHTML = TREND_ICON;
        }
      });
    } else if (tool === 'trend') {
      const btn = document.querySelector(`button[data-tool="${tool}"]`);
      if (btn?.classList.contains('active')) {
        // Deactivate
        rsiChart.deactivateDivergenceTool();
        btn.classList.remove('active');
        btn.innerHTML = TREND_ICON;
      } else {
        // Activate
        rsiChart.activateDivergenceTool();
        btn?.classList.add('active');
        if (btn) btn.innerHTML = TREND_ICON;
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

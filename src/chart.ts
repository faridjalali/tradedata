 // Main chart rendering and management

import { createChart, IChartApi, ISeriesApi, CrosshairMode, DeepPartial, ChartOptions } from 'lightweight-charts';
import { fetchChartData, aggregate2HourBars, ChartInterval, RSIDisplayMode, RSIPoint } from './chartApi';
import { RSIChart } from './rsi';

// Chart state manager
export class ChartManager {
  private currentTicker: string | null = null;
  private currentInterval: ChartInterval = '1day';
  private priceChart: IChartApi | null = null;
  private candleSeries: ISeriesApi<"Candlestick"> | null = null;
  private rsiChart: RSIChart | null = null;
  private isLoading = false;
  private resizeObserver: ResizeObserver | null = null;

  // DOM elements
  private container: HTMLElement | null = null;
  private priceContainer: HTMLElement | null = null;
  private rsiContainer: HTMLElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private chartContent: HTMLElement | null = null;

  private static instance: ChartManager | null = null;

  public static getInstance(): ChartManager {
    if (!ChartManager.instance) {
      ChartManager.instance = new ChartManager();
    }
    return ChartManager.instance;
  }

  private constructor() {
    // Private constructor for singleton
  }

  public render(ticker: string): void {
    // Prevent redundant initialization if already rendered for this ticker
    if (this.currentTicker === ticker && this.priceChart && this.rsiChart) {
      return;
    }

    this.currentTicker = ticker;
    this.initializeDOMElements();

    if (!this.priceContainer || !this.rsiContainer) {
      console.error('Chart containers not found');
      return;
    }

    // Initialize charts only if not already created
    if (!this.priceChart) {
      this.initializeCharts();
      this.setupEventListeners();
      this.setupResizeObserver();
    }

    // Load initial data
    this.loadChartData(ticker, this.currentInterval);
  }

  private initializeDOMElements(): void {
    this.priceContainer = document.getElementById('price-chart-container');
    this.rsiContainer = document.getElementById('rsi-chart-container');
    this.loadingEl = document.getElementById('chart-loading');
    this.errorEl = document.getElementById('chart-error');
    this.chartContent = document.getElementById('chart-content');
    this.container = document.querySelector('.custom-chart-section');
  }

  private initializeCharts(): void {
    if (!this.priceContainer || !this.rsiContainer) return;

    // Create price chart
    if (!this.priceChart) {
      const chartOptions: DeepPartial<ChartOptions> = {
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
          mode: CrosshairMode.Normal
        }
      };

      this.priceChart = createChart(this.priceContainer, chartOptions);

      // Add candlestick series
      this.candleSeries = this.priceChart.addCandlestickSeries({
        upColor: '#3fb950',
        downColor: '#f85149',
        borderVisible: false,
        wickUpColor: '#3fb950',
        wickDownColor: '#f85149'
      });
    }
  }

  private setupResizeObserver(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }

    this.resizeObserver = new ResizeObserver(entries => {
        // Use requestAnimationFrame to debounce and avoid "ResizeObserver loop limit exceeded"
        requestAnimationFrame(() => {
            if (!this.priceContainer || !this.priceChart) return;
            
            for (const entry of entries) {
                if (entry.target === this.container || entry.target === this.priceContainer.parentElement) {
                     const newWidth = entry.contentRect.width;
                     // Ensure we don't resize to 0 which crashes charts
                     if (newWidth > 0) {
                         this.priceChart.resize(newWidth, 400);
                         if (this.rsiChart) {
                            this.rsiChart.resize();
                         }
                     }
                }
            }
        });
    });

    if (this.container) {
        this.resizeObserver.observe(this.container);
    } else if (this.priceContainer && this.priceContainer.parentElement) {
        this.resizeObserver.observe(this.priceContainer.parentElement);
    }
  }

  private setupEventListeners(): void {
    // Timeframe selector
    const timeframeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:first-child .tf-btn');
    timeframeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const interval = target.dataset.interval as ChartInterval;
        if (interval && this.currentTicker) {
          this.setTimeframe(interval);
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
          this.handleDrawingTool(tool);
        }
      });
    });

    // RSI display mode toggle
    const modeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:last-child .tf-btn');
    modeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const mode = target.dataset.mode as RSIDisplayMode;
        if (mode && this.rsiChart) {
          this.setRSIDisplayMode(mode);
        }
      });
    });
  }

  private setTimeframe(interval: ChartInterval): void {
    if (this.isLoading || !this.currentTicker || interval === this.currentInterval) return;

    this.currentInterval = interval;

    // Update active button
    const timeframeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:first-child .tf-btn');
    timeframeButtons.forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.interval === interval);
    });

    // Load new data
    this.loadChartData(this.currentTicker, interval);
  }

  private setRSIDisplayMode(mode: RSIDisplayMode): void {
    if (!this.rsiChart) return;

    // Update active button
    const modeButtons = document.querySelectorAll('#chart-controls .feed-controls-group:last-child .tf-btn');
    modeButtons.forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
    });

    // Update RSI chart display mode
    this.rsiChart.setDisplayMode(mode);
  }

  private async loadChartData(ticker: string, interval: ChartInterval): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    this.showLoading();

    try {
      const data = await fetchChartData(ticker, interval);

      let bars = data.bars;
      let rsiData: RSIPoint[] = data.rsi;

      if (interval === '2hour') {
        bars = aggregate2HourBars(bars);
        const barTimes = new Set(bars.map(b => b.time));
        rsiData = data.rsi.filter(r => barTimes.has(r.time));
      }

      if (this.candleSeries) {
        // Cast to any to avoid strict type mismatch with custom bar objects vs library expectation for now,
        // or ensure CandleBar matches exactly. Library uses Time, Open, High, Low, Close.
        this.candleSeries.setData(bars as any);
      }

      // Initialize or update RSI chart
      if (!this.rsiChart && this.rsiContainer) {
        this.rsiChart = new RSIChart({
          container: this.rsiContainer,
          data: rsiData,
          displayMode: 'line',
          priceData: bars.map(b => ({ time: b.time, close: b.close }))
        });

        this.synchronizeCharts();
      } else if (this.rsiChart) {
        this.rsiChart.setData(rsiData, bars.map(b => ({ time: b.time, close: b.close })));
      }

      // Fit content
      if (this.priceChart && this.rsiChart) {
        const rsiChartInstance = this.rsiChart.getChart();
        this.priceChart.timeScale().fitContent();
        rsiChartInstance.timeScale().fitContent();

        setTimeout(() => {
          this.priceChart?.timeScale().scrollToRealTime();
          this.rsiChart?.getChart().timeScale().scrollToRealTime();
        }, 50);
      }

      this.hideLoading();
    } catch (error) {
      console.error('Failed to load chart data:', error);
      this.showError(error instanceof Error ? error.message : 'Failed to load chart data');
    } finally {
      this.isLoading = false;
    }
  }

  private synchronizeCharts(): void {
    if (!this.priceChart || !this.rsiChart) return;

    const rsiChartInstance = this.rsiChart.getChart();
    let isPriceChartChanging = false;
    let isRSIChartChanging = false;

    // Sync price chart → RSI chart
    this.priceChart.timeScale().subscribeVisibleLogicalRangeChange((timeRange: any) => {
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
        this.priceChart?.timeScale().setVisibleLogicalRange(timeRange);
        isRSIChartChanging = false;
      }
    });

    // Sync crosshair
    this.priceChart.subscribeCrosshairMove((param: any) => {
      if (!param || !param.time) {
        rsiChartInstance.clearCrosshairPosition();
        return;
      }
      const rsiSeries = this.rsiChart?.getSeries();
      if (rsiSeries) {
        rsiChartInstance.setCrosshairPosition(NaN, param.time, rsiSeries);
      }
    });

    rsiChartInstance.subscribeCrosshairMove((param: any) => {
      if (!param || !param.time) {
        this.priceChart?.clearCrosshairPosition();
        return;
      }
      if (this.candleSeries) {
        this.priceChart?.setCrosshairPosition(NaN, param.time, this.candleSeries);
      }
    });
  }

  private handleDrawingTool(tool: string): void {
    if (!this.rsiChart) return;

    try {
      if (tool === 'clear') {
        this.rsiChart.clearDivergence();
        this.rsiChart.deactivateDivergenceTool();
        document.querySelectorAll('#drawing-tools .tf-btn').forEach(btn => btn.classList.remove('active'));
        return;
      }

      const trendBtn = Array.from(document.querySelectorAll('#drawing-tools .tf-btn')).find(
        btn => (btn as HTMLElement).dataset.tool === 'trend'
      ) as HTMLElement;

      if (tool === 'trend' && trendBtn) {
        const isActive = trendBtn.classList.contains('active');
        if (isActive) {
          trendBtn.classList.remove('active');
          this.rsiChart.deactivateDivergenceTool();
        } else {
          document.querySelectorAll('#drawing-tools .tf-btn').forEach(btn => btn.classList.remove('active'));
          trendBtn.classList.add('active');
          this.rsiChart.activateDivergenceTool();
        }
      }
    } catch (error) {
      console.error('Error activating divergence tool:', error);
    }
  }

  private showLoading(): void {
    if (this.errorEl) this.errorEl.style.display = 'none';
    if (this.chartContent) this.chartContent.style.opacity = '0.8';
  }

  private hideLoading(): void {
    if (this.chartContent) this.chartContent.style.opacity = '1';
  }

  private showError(message: string): void {
    if (this.errorEl) {
      this.errorEl.textContent = message;
      this.errorEl.style.display = 'block';
    }
    if (this.loadingEl) this.loadingEl.style.display = 'none';
    if (this.chartContent) this.chartContent.style.opacity = '0.5';
  }

  public destroy(): void {
      this.currentTicker = null;
      if (this.resizeObserver) {
          this.resizeObserver.disconnect();
          this.resizeObserver = null;
      }
      if (this.rsiChart) {
          this.rsiChart.destroy();
          this.rsiChart = null;
      }
      if (this.priceChart) {
          this.priceChart.remove();
          this.priceChart = null;
          this.candleSeries = null;
      }
      // Note: we don't clear the instance to allow re-use, but if we wanted full reset we could.
      // But typically we reuse the singleton.
  }
}

// Export a legacy-style adapter for backward compatibility if needed,
// but we will update ticker.ts to use the class directly.
// For now, adhering to the plan to update usage.
export function renderCustomChart(ticker: string): void {
    ChartManager.getInstance().render(ticker);
}

// Re-export constants

// But consumers might rely on it? ticker.ts doesn't.
// Let's check usages of currentInterval after.

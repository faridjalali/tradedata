// RSI Chart configuration and management

import { RSIPoint, RSIDisplayMode } from './chartApi';

// Declare Lightweight Charts global
declare const LightweightCharts: any;
declare const LightweightChartsLineTools: any;

export interface RSIChartOptions {
  container: HTMLElement;
  data: RSIPoint[];
  displayMode: RSIDisplayMode;
  priceData?: Array<{time: string | number, close: number}>; // For divergence detection
  onTrendLineDrawn?: () => void;
}

export class RSIChart {
  private container: HTMLElement;
  private chart: any;
  private series: any;
  private lineTools: any;
  private displayMode: RSIDisplayMode;
  private data: RSIPoint[];
  private seriesData: any[] = [];
  private referenceLines: Array<{value: number, label: string, color: string}> = [];
  private priceData: Array<{time: string | number, close: number}> = [];
  private priceByTime = new Map<string, number>();
  private indexByTime = new Map<string, number>();
  private divergencePointTimeKeys = new Set<string>();
  private divergenceToolActive: boolean = false;
  private highlightSeries: any = null;
  private firstPoint: {time: string | number, rsi: number, price: number, index: number} | null = null;
  private divergencePoints: RSIPoint[] = [];
  private static readonly MAX_HIGHLIGHT_POINTS = 2000;
  private trendLineSeriesList: any[] = [];
  private midlineCrossIndex: number | null = null;
  private midlineCrossMarkerEl: HTMLDivElement | null = null;
  private markerResizeObserver: ResizeObserver | null = null;
  private onTrendLineDrawn?: () => void;

  constructor(options: RSIChartOptions) {
    this.container = options.container;
    this.displayMode = options.displayMode;
    this.data = this.normalizeRSIData(options.data);
    this.priceData = options.priceData || [];
    this.rebuildLookupMaps();
    this.seriesData = this.buildSeriesData(this.data, this.priceData);
    this.onTrendLineDrawn = options.onTrendLineDrawn;

    // Create RSI chart
    this.chart = LightweightCharts.createChart(options.container, {
      height: 400,
      layout: {
        background: { color: '#0d1117' },
        textColor: '#c9d1d9',
        attributionLogo: false
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false }
      },
      timeScale: {
        visible: true,
        timeVisible: true,
        secondsVisible: false,
        borderVisible: true,
        ticksVisible: true,
        fixRightEdge: false,
        rightBarStaysOnScroll: false,
        rightOffset: 10,
        borderColor: '#21262d'  // Show time scale at bottom of RSI chart
      },
      rightPriceScale: {
        borderColor: '#21262d',
        scaleMargins: {
          top: 0.1,
          bottom: 0.1
        }
      },
      crosshair: {
        mode: 1 // CrosshairMode.Normal
      },
      handleScroll: {
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
        mouseWheel: true
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
        axisDoubleClickReset: true
      }
    });

    // Add midline at 50
    this.addReferenceLine(50, 'Midline', '#ffffff');
    this.initMidlineCrossMarker();
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.updateMidlineCrossMarkerPosition());

    // Add RSI series based on display mode
    this.updateSeries();

    // Set up click handler for divergence detection
    this.chart.subscribeCrosshairMove((param: any) => {
      if (this.divergenceToolActive && param && param.time) {
        // We'll handle the actual click in a separate event
      }
    });

    this.chart.subscribeClick((param: any) => {
      if (this.divergenceToolActive && param && param.time) {
        this.detectAndHighlightDivergence(param.time);
      }
    });
  }

  private normalizeRSIData(data: RSIPoint[]): RSIPoint[] {
    return data.filter((point) => (
      point &&
      (typeof point.time === 'string' || typeof point.time === 'number') &&
      Number.isFinite(Number(point.value))
    ));
  }

  private timeKey(time: string | number): string {
    return typeof time === 'number' ? String(time) : time;
  }

  private rebuildLookupMaps(): void {
    this.priceByTime.clear();
    this.indexByTime.clear();

    for (let i = 0; i < this.data.length; i++) {
      const point = this.data[i];
      this.indexByTime.set(this.timeKey(point.time), i);
    }

    for (const point of this.priceData) {
      const price = Number(point.close);
      if (Number.isFinite(price)) {
        this.priceByTime.set(this.timeKey(point.time), price);
      }
    }
  }

  private initMidlineCrossMarker(): void {
    if (!this.container) return;
    const position = window.getComputedStyle(this.container).position;
    if (!position || position === 'static') {
      this.container.style.position = 'relative';
    }

    this.midlineCrossMarkerEl = document.createElement('div');
    this.midlineCrossMarkerEl.style.position = 'absolute';
    this.midlineCrossMarkerEl.style.top = '0';
    this.midlineCrossMarkerEl.style.bottom = '0';
    this.midlineCrossMarkerEl.style.width = '0';
    this.midlineCrossMarkerEl.style.borderLeft = '1px dotted #ffa500';
    this.midlineCrossMarkerEl.style.pointerEvents = 'none';
    this.midlineCrossMarkerEl.style.display = 'none';
    this.midlineCrossMarkerEl.style.zIndex = '8';
    this.container.appendChild(this.midlineCrossMarkerEl);

    this.markerResizeObserver = new ResizeObserver(() => {
      this.updateMidlineCrossMarkerPosition();
    });
    this.markerResizeObserver.observe(this.container);
  }

  private setMidlineCrossIndex(index: number | null): void {
    this.midlineCrossIndex = index;
    this.updateMidlineCrossMarkerPosition();
  }

  private updateMidlineCrossMarkerPosition(): void {
    if (!this.midlineCrossMarkerEl) return;
    if (this.midlineCrossIndex === null || this.midlineCrossIndex === undefined) {
      this.midlineCrossMarkerEl.style.display = 'none';
      return;
    }

    const lowerIndex = Math.floor(this.midlineCrossIndex);
    const upperIndex = Math.ceil(this.midlineCrossIndex);
    if (lowerIndex < 0 || upperIndex >= this.data.length) {
      this.midlineCrossMarkerEl.style.display = 'none';
      return;
    }

    const lowerTime = this.data[lowerIndex]?.time;
    const upperTime = this.data[upperIndex]?.time;
    if (lowerTime === undefined || lowerTime === null || upperTime === undefined || upperTime === null) {
      this.midlineCrossMarkerEl.style.display = 'none';
      return;
    }

    const x0 = this.chart.timeScale().timeToCoordinate(lowerTime);
    const x1 = this.chart.timeScale().timeToCoordinate(upperTime);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) {
      this.midlineCrossMarkerEl.style.display = 'none';
      return;
    }

    const weight = upperIndex === lowerIndex ? 0 : (this.midlineCrossIndex - lowerIndex) / (upperIndex - lowerIndex);
    const x = x0 + ((x1 - x0) * weight);

    const width = this.container.clientWidth;
    if (x < 0 || x > width) {
      this.midlineCrossMarkerEl.style.display = 'none';
      return;
    }

    this.midlineCrossMarkerEl.style.left = `${x}px`;
    this.midlineCrossMarkerEl.style.display = 'block';
  }

  private buildSeriesData(
    data: RSIPoint[],
    priceData: Array<{time: string | number, close: number}>
  ): any[] {
    if (!priceData || priceData.length === 0) return data;

    const rsiByTime = new Map<string, number>();
    for (const point of data) {
      rsiByTime.set(String(point.time), Number(point.value));
    }

    return priceData.map((pricePoint) => {
      const value = rsiByTime.get(String(pricePoint.time));
      if (Number.isFinite(value)) {
        return { time: pricePoint.time, value };
      }
      // Whitespace data keeps timeline aligned without drawing a value.
      return { time: pricePoint.time };
    });
  }

  private addReferenceLine(value: number, label: string, color: string): void {
    // Store config for later series recreations
    this.referenceLines.push({ value, label, color });

    // If series exists, add the line immediately
    if (this.series) {
      this.series.createPriceLine({
        price: value,
        color,
        lineWidth: 1,
        lineStyle: 2, // LineStyle.Dashed
        axisLabelVisible: false,
        title: label
      });
    }
  }

  private updateSeries(): void {
    // Remove old series if exists
    if (this.series) {
      this.chart.removeSeries(this.series);
    }

    // Add new series based on display mode
    if (this.displayMode === 'line') {
      this.series = this.chart.addLineSeries({
        color: '#58a6ff',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false
      });
    } else {
      // Points mode - using histogram with very thin bars to simulate points
      this.series = this.chart.addHistogramSeries({
        color: '#58a6ff',
        priceFormat: {
          type: 'price',
          precision: 2,
          minMove: 0.01
        },
        priceLineVisible: false,
        lastValueVisible: false
      });
    }

    // Set data
    if (this.displayMode === 'line') {
      this.series.setData(this.seriesData);
    } else {
      // For histogram (points mode), convert to histogram format
      this.series.setData(this.seriesData.map(d => {
        if (Number.isFinite(Number(d.value))) {
          return {
            time: d.time,
            value: d.value,
            color: '#58a6ff'
          };
        }
        return { time: d.time };
      }));
    }

    // Add reference lines (midline) to the new series
    this.referenceLines.forEach(config => {
      this.series.createPriceLine({
        price: config.value,
        color: config.color,
        lineWidth: 1,
        lineStyle: 2, // LineStyle.Dashed
        axisLabelVisible: false,
        title: config.label
      });
    });
  }

  setDisplayMode(mode: RSIDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.updateSeries();
  }

  setData(data: RSIPoint[], priceData?: Array<{time: string | number, close: number}>): void {
    this.clearDivergence();
    this.data = this.normalizeRSIData(data);
    if (priceData) {
      this.priceData = priceData;
    }
    this.rebuildLookupMaps();
    this.seriesData = this.buildSeriesData(this.data, this.priceData);

    if (this.series) {
      if (this.displayMode === 'line') {
        this.series.setData(this.seriesData);
      } else {
        this.series.setData(this.seriesData.map(d => {
          if (Number.isFinite(Number(d.value))) {
            return {
              time: d.time,
              value: d.value,
              color: '#58a6ff'
            };
          }
          return { time: d.time };
        }));
      }
    }


  }

  getChart(): any {
    return this.chart;
  }

  getSeries(): any {
    return this.series;
  }



  getLineTools(): any {
    return this.lineTools;
  }

  activateDivergenceTool(): void {
    this.divergenceToolActive = true;
    // Change cursor to indicate tool is active
    const container = this.chart.chartElement();
    if (container) {
      container.style.cursor = 'crosshair';
    }
  }

  deactivateDivergenceTool(): void {
    this.divergenceToolActive = false;
    const container = this.chart.chartElement();
    if (container) {
      container.style.cursor = 'default';
    }
    // Clear any highlights and reset state
    this.clearHighlights();
    this.firstPoint = null;
    this.divergencePoints = [];
    this.divergencePointTimeKeys.clear();
  }

  private detectAndHighlightDivergence(clickedTime: string | number): void {
    // Find the clicked point in RSI data
    const clickedKey = this.timeKey(clickedTime);
    const clickedIndex = this.indexByTime.get(clickedKey);
    if (clickedIndex === undefined) {
      console.log('Clicked point not found in RSI data');
      return;
    }

    const clickedRSI = this.data[clickedIndex].value;

    // Find corresponding price
    const clickedPrice = this.priceByTime.get(clickedKey);
    if (!Number.isFinite(clickedPrice)) {
      console.log('Corresponding price data not found');
      return;
    }

    // Check if this is the first or second click
    if (!this.firstPoint) {
      // First click: store point and find divergence
      this.firstPoint = {
        time: clickedTime,
        rsi: clickedRSI,
        price: clickedPrice,
        index: clickedIndex
      };

      // Find all future points with divergence in either direction:
      // 1) lower RSI + higher price (bearish)
      // 2) higher RSI + lower price (bullish)
      this.divergencePoints = [];
      this.divergencePointTimeKeys.clear();

      for (let i = clickedIndex + 1; i < this.data.length; i++) {
        const currentRSI = this.data[i].value;
        const currentTime = this.data[i].time;
        const currentPrice = this.priceByTime.get(this.timeKey(currentTime));

        if (Number.isFinite(currentPrice)) {

          const bearishDivergence = currentRSI < clickedRSI && currentPrice > clickedPrice;
          const bullishDivergence = currentRSI > clickedRSI && currentPrice < clickedPrice;
          if (bearishDivergence || bullishDivergence) {
            this.divergencePoints.push({ time: currentTime, value: currentRSI });
            this.divergencePointTimeKeys.add(this.timeKey(currentTime));
          }
        }
      }

      console.log(`Found ${this.divergencePoints.length} divergence points from origin (RSI: ${clickedRSI.toFixed(2)}, Price: ${clickedPrice.toFixed(2)})`);

      // Highlight the divergence points
      this.highlightPoints(this.divergencePoints);
    } else {
      // Second click: check if it's a divergence point and draw trend line
      const isValidSecondPoint = this.divergencePointTimeKeys.has(clickedKey);

      if (!isValidSecondPoint) {
        console.log('Second point must be one of the highlighted divergence points');
        return;
      }

      console.log(`Drawing trend line from (RSI: ${this.firstPoint.rsi.toFixed(2)}) to (RSI: ${clickedRSI.toFixed(2)})`);

      // Draw trend line from first point through second point, extending to the right
      this.drawTrendLine(this.firstPoint.time, this.firstPoint.rsi, clickedTime, clickedRSI);

      // Clear highlights after drawing the line
      this.clearHighlights();

      // Auto-toggle tool off after drawing one line.
      this.deactivateDivergenceTool();
      this.onTrendLineDrawn?.();
    }
  }

  private highlightPoints(points: RSIPoint[]): void {
    // Clear previous highlights
    this.clearHighlights();

    if (points.length === 0) {
      return;
    }

    // Add a marker series to highlight divergence points
    this.highlightSeries = this.chart.addLineSeries({
      color: '#ff6b6b',  // Red color for bearish divergence
      lineWidth: 0,
      pointMarkersVisible: true,
      pointMarkersRadius: 5
    });

    const step = Math.max(1, Math.ceil(points.length / RSIChart.MAX_HIGHLIGHT_POINTS));
    const displayPoints = step === 1 ? points : points.filter((_, index) => index % step === 0);
    this.highlightSeries.setData(displayPoints);
  }

  private clearHighlights(): void {
    if (this.highlightSeries) {
      this.chart.removeSeries(this.highlightSeries);
      this.highlightSeries = null;
    }
  }

  private drawTrendLine(time1: string | number, value1: number, time2: string | number, value2: number): void {
    // Find the indices of the two points
    const index1 = this.indexByTime.get(this.timeKey(time1));
    const index2 = this.indexByTime.get(this.timeKey(time2));

    if (index1 === undefined || index2 === undefined) {
      console.error('Could not find indices for trend line points');
      return;
    }

    // Calculate slope: (y2 - y1) / (x2 - x1)
    if (index2 === index1) {
      this.setMidlineCrossIndex(null);
      return;
    }
    const slope = (value2 - value1) / (index2 - index1);

    // Create trend line data points extending to the right edge
    const trendLineData: RSIPoint[] = [];
    let maxTrendIndex = index1;

    // Start from first point and extend to the last data point
    for (let i = index1; i < this.data.length; i++) {
      const projectedValue = value1 + slope * (i - index1);
      // Prevent this helper line from blowing out RSI autoscale.
      if (projectedValue < 0 || projectedValue > 100) {
        break;
      }
      maxTrendIndex = i;
      trendLineData.push({
        time: this.data[i].time,
        value: projectedValue
      });
    }

    // Create new trend line series (keep existing lines on chart)
    const trendLineSeries = this.chart.addLineSeries({
      color: '#ffa500',  // Orange color for trend line
      lineWidth: 1,
      lineStyle: 0, // Solid line
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    this.trendLineSeriesList.push(trendLineSeries);

    trendLineSeries.setData(trendLineData);

    // Mark where this trendline crosses RSI midline (50) on the time axis.
    const midlineValue = 50;
    if (Math.abs(slope) < 1e-10) {
      this.setMidlineCrossIndex(null);
      return;
    }

    const crossIndex = index1 + (midlineValue - value1) / slope;
    if (!Number.isFinite(crossIndex) || crossIndex < index1 || crossIndex > maxTrendIndex) {
      this.setMidlineCrossIndex(null);
      return;
    }
    this.setMidlineCrossIndex(crossIndex);
  }

  clearDivergence(): void {
    this.clearHighlights();

    // Clear all trend lines
    for (const trendLineSeries of this.trendLineSeriesList) {
      this.chart.removeSeries(trendLineSeries);
    }
    this.trendLineSeriesList = [];

    // Reset state
    this.firstPoint = null;
    this.divergencePoints = [];
    this.divergencePointTimeKeys.clear();
    this.setMidlineCrossIndex(null);
  }

  resize(): void {
    if (this.chart) {
      this.chart.resize(this.chart.options().width, 400);
    }
  }

  destroy(): void {
    this.markerResizeObserver?.disconnect();
    this.markerResizeObserver = null;
    if (this.midlineCrossMarkerEl?.parentElement) {
      this.midlineCrossMarkerEl.parentElement.removeChild(this.midlineCrossMarkerEl);
    }
    this.midlineCrossMarkerEl = null;
    if (this.chart) {
      this.chart.remove();
    }
  }
}

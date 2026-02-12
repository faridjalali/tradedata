// RSI Chart configuration and management

import { RSIPoint, RSIDisplayMode } from './chartApi';

// Declare Lightweight Charts global
declare const LightweightCharts: any;
declare const LightweightChartsLineTools: any;

const MM_DD_YY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: '2-digit',
  day: '2-digit',
  year: '2-digit'
});

export interface RSIChartOptions {
  container: HTMLElement;
  data: RSIPoint[];
  displayMode: RSIDisplayMode;
  priceData?: Array<{time: string | number, close: number}>; // For divergence detection
  lineColor?: string;
  midlineColor?: string;
  midlineStyle?: 'dotted' | 'solid';
  onTrendLineDrawn?: () => void;
}

export interface RSIPersistedTrendline {
  time1: string | number;
  value1: number;
  time2: string | number;
  value2: number;
}

export class RSIChart {
  private static readonly SCALE_LABEL_CHARS = 4;
  private static readonly SCALE_MIN_WIDTH_PX = 56;
  private static readonly RSI_DATA_MIN = 0;
  private static readonly RSI_DATA_MAX = 100;
  private static readonly RSI_AXIS_MIN = 20;
  private static readonly RSI_AXIS_MAX = 80;
  private static readonly MIDLINE_VALUE = 50;
  private container: HTMLElement;
  private chart: any;
  private series: any;
  private lineTools: any;
  private displayMode: RSIDisplayMode;
  private lineColor: string = '#58a6ff';
  private midlineColor: string = '#ffffff';
  private midlineStyle: 'dotted' | 'solid' = 'dotted';
  private data: RSIPoint[];
  private seriesData: any[] = [];
  private referenceLines: Array<{value: number, label: string, color: string, lineStyle: number}> = [];
  private midlinePriceLine: any = null;
  private priceData: Array<{time: string | number, close: number}> = [];
  private priceByTime = new Map<string, number>();
  private indexByTime = new Map<string, number>();
  private divergencePointTimeKeys = new Set<string>();
  private divergenceToolActive: boolean = false;
  private highlightSeries: any = null;
  private firstPoint: {time: string | number, rsi: number, price: number, index: number} | null = null;
  private divergencePoints: RSIPoint[] = [];
  private static readonly MAX_HIGHLIGHT_POINTS = 2000;
  private static readonly FUTURE_TIMELINE_DAYS = 370;
  private trendLineSeriesList: any[] = [];
  private trendlineCrossLabels: Array<{ element: HTMLDivElement, anchorTime: string | number, anchorValue: number }> = [];
  private trendlineDefinitions: RSIPersistedTrendline[] = [];
  private timelineSeries: any = null;
  private suppressExternalSync: boolean = false;
  private onTrendLineDrawn?: () => void;

  constructor(options: RSIChartOptions) {
    this.container = options.container;
    this.displayMode = options.displayMode;
    this.lineColor = options.lineColor || this.lineColor;
    this.midlineColor = options.midlineColor || this.midlineColor;
    this.midlineStyle = options.midlineStyle || this.midlineStyle;
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
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
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
        tickMarkFormatter: (time: any, tickMarkType: number) => this.formatTickMark(time, tickMarkType),
        borderColor: '#21262d'  // Show time scale at bottom of RSI chart
      },
      rightPriceScale: {
        borderColor: '#21262d',
        minimumWidth: RSIChart.SCALE_MIN_WIDTH_PX,
        entireTextOnly: true,
        // Default view: 20-80 range (20% margin top + 20% margin bottom)
        // User can adjust but won't go beyond 0-100 data bounds
        scaleMargins: {
          top: 0.2,    // 20% margin = hides 0-20 by default
          bottom: 0.2  // 20% margin = hides 80-100 by default
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
        axisPressedMouseMove: {
          time: true,
          price: false
        },
        axisDoubleClickReset: {
          time: true,
          price: false
        }
      }
    });

    // Add midline at 50
    this.addReferenceLine(50, 'Midline', this.midlineColor, this.midlineStyleToLineStyle(this.midlineStyle));

    // Add RSI series based on display mode
    this.updateSeries();
    this.updateTimelineSeriesData();

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

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      this.refreshTrendlineCrossLabels();
    });
  }

  private normalizeRSIData(data: RSIPoint[]): RSIPoint[] {
    return data
      .filter((point) => (
        point &&
        (typeof point.time === 'string' || typeof point.time === 'number') &&
        Number.isFinite(Number(point.value))
      ))
      .map((point) => ({
        ...point,
        value: Math.max(
          RSIChart.RSI_DATA_MIN,
          Math.min(RSIChart.RSI_DATA_MAX, Number(point.value))
        )
      }));
  }

  private formatRSIScaleLabel(value: number): string {
    if (!Number.isFinite(value)) return '';
    const label = Number(value).toFixed(1);
    return label.length >= RSIChart.SCALE_LABEL_CHARS
      ? label
      : label.padEnd(RSIChart.SCALE_LABEL_CHARS, ' ');
  }

  private fixedRSIAutoscaleInfoProvider(): any {
    // Return the default axis range (20-80) to match VD-RSI behavior
    // Combined with scaleMargins, this creates the proper Y-axis bounds
    return {
      priceRange: {
        minValue: RSIChart.RSI_AXIS_MIN,  // 20
        maxValue: RSIChart.RSI_AXIS_MAX   // 80
      }
    };
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

  private toDateFromScaleTime(time: any): Date | null {
    if (typeof time === 'number' && Number.isFinite(time)) {
      return new Date(time * 1000);
    }

    if (typeof time === 'string' && time.trim()) {
      const normalized = time.includes('T') ? time : `${time.replace(' ', 'T')}Z`;
      const parsed = new Date(normalized);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }

    if (time && typeof time === 'object' && Number.isFinite(time.year) && Number.isFinite(time.month) && Number.isFinite(time.day)) {
      // BusinessDay-like object
      return new Date(Date.UTC(Number(time.year), Number(time.month) - 1, Number(time.day), 0, 0, 0));
    }

    return null;
  }

  private toUnixSeconds(time: string | number | null | undefined): number | null {
    if (typeof time === 'number' && Number.isFinite(time)) {
      return time;
    }
    if (typeof time !== 'string' || !time.trim()) {
      return null;
    }
    const normalized = time.includes('T') ? time : `${time.replace(' ', 'T')}Z`;
    const parsed = new Date(normalized);
    const ms = parsed.getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
  }

  private formatTickMark(time: any, tickMarkType: number): string {
    const date = this.toDateFromScaleTime(time);
    if (!date) return '';

    // TickMarkType enum in lightweight-charts:
    // 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds
    if (tickMarkType === 0) {
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        timeZone: 'America/Los_Angeles'
      });
    }

    if (tickMarkType === 1) {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        timeZone: 'America/Los_Angeles'
      });
    }

    // Zoomed in (day/time): show day-of-month only.
    return date.toLocaleDateString('en-US', {
      day: 'numeric',
      timeZone: 'America/Los_Angeles'
    });
  }

  private midlineStyleToLineStyle(style: 'dotted' | 'solid'): number {
    return style === 'solid' ? 0 : 1;
  }

  isSyncSuppressed(): boolean {
    return this.suppressExternalSync;
  }

  private inferBarStepSeconds(): number {
    if (this.data.length < 2) return 1800;

    const diffs: number[] = [];
    for (let i = 1; i < this.data.length; i++) {
      const prev = this.data[i - 1]?.time;
      const curr = this.data[i]?.time;
      if (typeof prev !== 'number' || typeof curr !== 'number') continue;
      const diff = curr - prev;
      if (Number.isFinite(diff) && diff > 0 && diff <= (8 * 3600)) {
        diffs.push(diff);
      }
    }

    if (diffs.length === 0) return 1800;
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)];
  }

  private barsPerTradingDayFromStep(stepSeconds: number): number {
    if (stepSeconds <= 5 * 60) return 78;
    if (stepSeconds <= 15 * 60) return 26;
    if (stepSeconds <= 30 * 60) return 13;
    if (stepSeconds <= 60 * 60) return 7;
    return 2;
  }

  private futureBarsForOneYear(): number {
    const stepSeconds = this.inferBarStepSeconds();
    return this.barsPerTradingDayFromStep(stepSeconds) * 252;
  }

  private ensureTimelineSeries(): void {
    if (this.timelineSeries) return;
    this.timelineSeries = this.chart.addLineSeries({
      color: 'rgba(0, 0, 0, 0)',
      lineVisible: false,
      pointMarkersVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
  }

  private updateTimelineSeriesData(): void {
    this.ensureTimelineSeries();
    if (!this.timelineSeries || this.data.length === 0) return;

    const lastTimeSeconds = this.toUnixSeconds(this.data[this.data.length - 1]?.time);
    if (lastTimeSeconds === null) return;

    const timelinePoints: Array<{ time: number }> = [{ time: lastTimeSeconds }];
    for (let day = 1; day <= RSIChart.FUTURE_TIMELINE_DAYS; day++) {
      timelinePoints.push({ time: lastTimeSeconds + (day * 86400) });
    }

    this.timelineSeries.setData(timelinePoints);
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

  private addReferenceLine(value: number, label: string, color: string, lineStyle: number = 2): void {
    // Store config for later series recreations
    this.referenceLines.push({ value, label, color, lineStyle });

    // If series exists, add the line immediately
    if (this.series) {
      const priceLine = this.series.createPriceLine({
        price: value,
        color,
        lineWidth: 1,
        lineStyle,
        axisLabelVisible: false,
        title: label
      });
      if (label === 'Midline') {
        this.midlinePriceLine = priceLine;
      }
    }
  }

  private updateSeries(): void {
    // Remove old series if exists
    if (this.series) {
      this.chart.removeSeries(this.series);
    }
    this.midlinePriceLine = null;

    // Add new series based on display mode
    if (this.displayMode === 'line') {
      this.series = this.chart.addLineSeries({
        color: this.lineColor,
        lineWidth: 1,
        priceFormat: {
          type: 'custom',
          minMove: 1,
          formatter: (value: number) => this.formatRSIScaleLabel(Number(value))
        },
        autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider(),
        priceLineVisible: false,
        lastValueVisible: false
      });
    } else {
      // Points mode - using histogram with very thin bars to simulate points
      this.series = this.chart.addHistogramSeries({
        color: this.lineColor,
        priceFormat: {
          type: 'custom',
          minMove: 1,
          formatter: (value: number) => this.formatRSIScaleLabel(Number(value))
        },
        autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider(),
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
            color: this.lineColor
          };
        }
        return { time: d.time };
      }));
    }

    // Add reference lines (midline) to the new series
    this.referenceLines.forEach(config => {
      const priceLine = this.series.createPriceLine({
        price: config.value,
        color: config.color,
        lineWidth: 1,
        lineStyle: config.lineStyle,
        axisLabelVisible: false,
        title: config.label
      });
      if (config.label === 'Midline') {
        this.midlinePriceLine = priceLine;
      }
    });
  }

  setDisplayMode(mode: RSIDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.updateSeries();
    this.refreshTrendlineCrossLabels();
  }

  setLineColor(color: string): void {
    if (!color) return;
    this.lineColor = color;
    if (this.displayMode === 'line' && this.series) {
      this.series.applyOptions({ color });
    } else if (this.displayMode !== 'line' && this.series) {
      this.series.applyOptions({ color });
      this.series.setData(this.seriesData.map(d => {
        if (Number.isFinite(Number(d.value))) {
          return {
            time: d.time,
            value: d.value,
            color: this.lineColor
          };
        }
        return { time: d.time };
      }));
    }
  }

  setMidlineOptions(color: string, style: 'dotted' | 'solid'): void {
    if (color) this.midlineColor = color;
    if (style) this.midlineStyle = style;
    const lineStyle = this.midlineStyleToLineStyle(this.midlineStyle);
    this.referenceLines = this.referenceLines.map((line) => {
      if (line.label !== 'Midline') return line;
      return { ...line, color: this.midlineColor, lineStyle };
    });
    if (this.midlinePriceLine) {
      this.midlinePriceLine.applyOptions({
        color: this.midlineColor,
        lineStyle
      });
    }
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
              color: this.lineColor
            };
          }
          return { time: d.time };
        }));
      }
    }

    this.updateTimelineSeriesData();
    this.refreshTrendlineCrossLabels();
  }

  updateLatestPoint(
    point: RSIPoint,
    latestPricePoint?: { time: string | number, close: number }
  ): boolean {
    if (!point || (typeof point.time !== 'string' && typeof point.time !== 'number')) return false;
    const nextValueRaw = Number(point.value);
    if (!Number.isFinite(nextValueRaw)) return false;
    if (this.data.length === 0) return false;

    const lastIndex = this.data.length - 1;
    const lastTime = this.data[lastIndex]?.time;
    const lastKey = this.timeKey(lastTime);
    const nextKey = this.timeKey(point.time);
    if (lastKey !== nextKey) return false;

    const nextValue = Math.max(
      RSIChart.RSI_DATA_MIN,
      Math.min(RSIChart.RSI_DATA_MAX, nextValueRaw)
    );
    this.data[lastIndex] = {
      ...this.data[lastIndex],
      value: nextValue
    };

    if (latestPricePoint && this.timeKey(latestPricePoint.time) === lastKey) {
      const nextClose = Number(latestPricePoint.close);
      if (Number.isFinite(nextClose)) {
        if (this.priceData.length > 0 && this.timeKey(this.priceData[this.priceData.length - 1].time) === lastKey) {
          this.priceData[this.priceData.length - 1] = {
            ...this.priceData[this.priceData.length - 1],
            close: nextClose
          };
        }
        this.priceByTime.set(lastKey, nextClose);
      }
    }

    if (this.seriesData.length > 0 && this.timeKey(this.seriesData[this.seriesData.length - 1].time) === lastKey) {
      this.seriesData[this.seriesData.length - 1] = {
        time: lastTime,
        value: nextValue
      };
    } else {
      this.seriesData = this.buildSeriesData(this.data, this.priceData);
    }

    if (this.series) {
      if (this.displayMode === 'line') {
        this.series.update({ time: lastTime, value: nextValue });
      } else {
        this.series.update({ time: lastTime, value: nextValue, color: this.lineColor });
      }
    }
    this.refreshTrendlineCrossLabels();
    return true;
  }

  getChart(): any {
    return this.chart;
  }

  getSeries(): any {
    return this.series;
  }

  getPersistedTrendlines(): RSIPersistedTrendline[] {
    return this.trendlineDefinitions.map((line) => ({ ...line }));
  }

  restorePersistedTrendlines(trendlines: RSIPersistedTrendline[]): void {
    this.clearDivergence();
    if (!Array.isArray(trendlines) || trendlines.length === 0) return;
    for (const line of trendlines) {
      if (!line) continue;
      const time1 = line.time1;
      const time2 = line.time2;
      const value1 = Number(line.value1);
      const value2 = Number(line.value2);
      if ((typeof time1 !== 'string' && typeof time1 !== 'number') || (typeof time2 !== 'string' && typeof time2 !== 'number')) continue;
      if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
      this.drawTrendLine(time1, value1, time2, value2, true);
    }
  }

  refreshTrendlineLabels(): void {
    this.refreshTrendlineCrossLabels();
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
    const clickedPriceValue = Number(clickedPrice);

    // Check if this is the first or second click
    if (!this.firstPoint) {
      // First click: store point and find divergence
      this.firstPoint = {
        time: clickedTime,
        rsi: clickedRSI,
        price: clickedPriceValue,
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
          const currentPriceValue = Number(currentPrice);

          const bearishDivergence = currentRSI < clickedRSI && currentPriceValue > clickedPriceValue;
          const bullishDivergence = currentRSI > clickedRSI && currentPriceValue < clickedPriceValue;
          if (bearishDivergence || bullishDivergence) {
            this.divergencePoints.push({ time: currentTime, value: currentRSI });
            this.divergencePointTimeKeys.add(this.timeKey(currentTime));
          }
        }
      }

      console.log(`Found ${this.divergencePoints.length} divergence points from origin (RSI: ${clickedRSI.toFixed(2)}, Price: ${clickedPriceValue.toFixed(2)})`);

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
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider()
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

  private formatMmDdYyFromUnixSeconds(unixSeconds: number | null): string {
    if (!Number.isFinite(unixSeconds)) return 'N/A';
    return MM_DD_YY_FORMATTER.format(new Date(Math.round(Number(unixSeconds)) * 1000));
  }

  private createTrendlineCrossLabelElement(text: string): HTMLDivElement {
    const label = document.createElement('div');
    label.className = 'trendline-cross-label';
    label.textContent = text;
    label.style.position = 'absolute';
    label.style.zIndex = '29';
    label.style.minHeight = '24px';
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.padding = '0 8px';
    label.style.borderRadius = '4px';
    label.style.border = '1px solid #30363d';
    label.style.background = '#161b22';
    label.style.color = '#c9d1d9';
    label.style.fontSize = '12px';
    label.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    label.style.pointerEvents = 'none';
    label.style.whiteSpace = 'nowrap';
    label.style.transform = 'translate(-50%, calc(-100% - 6px))';
    return label;
  }

  private refreshTrendlineCrossLabels(): void {
    if (!this.chart || !this.series || !this.container) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    for (const label of this.trendlineCrossLabels) {
      const x = this.chart.timeScale().timeToCoordinate(label.anchorTime);
      const y = this.series.priceToCoordinate(label.anchorValue);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > width || y < 0 || y > height) {
        label.element.style.display = 'none';
        continue;
      }
      label.element.style.display = 'inline-flex';
      label.element.style.left = `${Math.round(x)}px`;
      label.element.style.top = `${Math.round(Math.max(8, y))}px`;
    }
  }

  private clearTrendlineCrossLabels(): void {
    for (const label of this.trendlineCrossLabels) {
      label.element.remove();
    }
    this.trendlineCrossLabels = [];
  }

  private addTrendlineCrossLabel(anchorTime: string | number, anchorValue: number, text: string): void {
    const element = this.createTrendlineCrossLabelElement(text);
    this.container.appendChild(element);
    this.trendlineCrossLabels.push({ element, anchorTime, anchorValue });
    this.refreshTrendlineCrossLabels();
  }

  private indexToUnixSeconds(
    index: number,
    lastHistoricalIndex: number,
    firstHistoricalTimeSeconds: number | null,
    lastHistoricalTimeSeconds: number | null,
    stepSeconds: number
  ): number | null {
    if (!Number.isFinite(index)) return null;

    if (index > lastHistoricalIndex) {
      if (lastHistoricalTimeSeconds === null) return null;
      return lastHistoricalTimeSeconds + ((index - lastHistoricalIndex) * stepSeconds);
    }

    if (index < 0) {
      if (firstHistoricalTimeSeconds === null) return null;
      return firstHistoricalTimeSeconds + (index * stepSeconds);
    }

    const lowerIndex = Math.max(0, Math.floor(index));
    const upperIndex = Math.min(lastHistoricalIndex, Math.ceil(index));
    const lowerTime = this.toUnixSeconds(this.data[lowerIndex]?.time);
    const upperTime = this.toUnixSeconds(this.data[upperIndex]?.time);
    if (lowerIndex === upperIndex) return lowerTime;
    if (Number.isFinite(lowerTime) && Number.isFinite(upperTime)) {
      const ratio = index - lowerIndex;
      return Number(lowerTime) + ((Number(upperTime) - Number(lowerTime)) * ratio);
    }
    if (Number.isFinite(lowerTime)) return Number(lowerTime) + ((index - lowerIndex) * stepSeconds);
    if (firstHistoricalTimeSeconds === null) return null;
    return firstHistoricalTimeSeconds + (index * stepSeconds);
  }

  private computeTrendlineMidlineCrossUnixSeconds(
    index1: number,
    value1: number,
    slope: number,
    lastHistoricalIndex: number,
    firstHistoricalTimeSeconds: number | null,
    lastHistoricalTimeSeconds: number | null,
    stepSeconds: number
  ): number | null {
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-12) return null;
    const crossIndex = index1 + ((RSIChart.MIDLINE_VALUE - value1) / slope);
    if (!Number.isFinite(crossIndex)) return null;
    return this.indexToUnixSeconds(
      crossIndex,
      lastHistoricalIndex,
      firstHistoricalTimeSeconds,
      lastHistoricalTimeSeconds,
      stepSeconds
    );
  }

  private drawTrendLine(
    time1: string | number,
    value1: number,
    time2: string | number,
    value2: number,
    recordDefinition: boolean = true
  ): void {
    const visibleRangeBeforeDraw = this.chart.timeScale().getVisibleLogicalRange?.();
    this.suppressExternalSync = true;
    try {
    // Find the indices of the two points
    const index1 = this.indexByTime.get(this.timeKey(time1));
    const index2 = this.indexByTime.get(this.timeKey(time2));

    if (index1 === undefined || index2 === undefined) {
      console.error('Could not find indices for trend line points');
      return;
    }

    // Calculate slope: (y2 - y1) / (x2 - x1)
    if (index2 === index1) {
      return;
    }
    const slope = (value2 - value1) / (index2 - index1);

    // Create trend line data points extending one year into future bars
    const trendLineData: RSIPoint[] = [];
    const futureBars = this.futureBarsForOneYear();
    const lastHistoricalIndex = this.data.length - 1;
    const maxIndex = lastHistoricalIndex + futureBars;
    const stepSeconds = this.inferBarStepSeconds();
    const firstHistoricalTimeSeconds = this.toUnixSeconds(this.data[0]?.time);
    const lastHistoricalTime = this.data[lastHistoricalIndex]?.time;
    const lastHistoricalTimeSeconds = this.toUnixSeconds(lastHistoricalTime);

    // Start from first point and extend to historical + future points.
    for (let i = index1; i <= maxIndex; i++) {
      const projectedValue = value1 + slope * (i - index1);
      // Prevent this helper line from blowing out RSI autoscale.
      if (projectedValue < RSIChart.RSI_DATA_MIN || projectedValue > RSIChart.RSI_DATA_MAX) {
        break;
      }
      let pointTime: string | number | null = null;
      if (i <= lastHistoricalIndex) {
        pointTime = this.data[i]?.time ?? null;
      } else if (lastHistoricalTimeSeconds !== null) {
        pointTime = lastHistoricalTimeSeconds + ((i - lastHistoricalIndex) * stepSeconds);
      }
      if (pointTime === null || pointTime === undefined) continue;
      trendLineData.push({
        time: pointTime,
        value: projectedValue
      });
    }

    if (!trendLineData.length) return;

    // Create new trend line series (keep existing lines on chart)
    const trendLineSeries = this.chart.addLineSeries({
      color: '#ffa500',  // Orange color for trend line
      lineWidth: 1,
      lineStyle: 0, // Solid line
      autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider(),
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    this.trendLineSeriesList.push(trendLineSeries);

    trendLineSeries.setData(trendLineData);
    const crossUnixSeconds = this.computeTrendlineMidlineCrossUnixSeconds(
      index1,
      value1,
      slope,
      lastHistoricalIndex,
      firstHistoricalTimeSeconds,
      lastHistoricalTimeSeconds,
      stepSeconds
    );
    this.addTrendlineCrossLabel(time1, value1, this.formatMmDdYyFromUnixSeconds(crossUnixSeconds));
    if (recordDefinition) {
      this.trendlineDefinitions.push({
        time1,
        value1: Number(value1),
        time2,
        value2: Number(value2)
      });
    }
    } finally {
      if (visibleRangeBeforeDraw) {
        try {
          this.chart.timeScale().setVisibleLogicalRange(visibleRangeBeforeDraw);
        } catch {
          // Keep the current viewport stable after drawing.
        }
      }
      this.suppressExternalSync = false;
    }
  }

  clearDivergence(preserveViewport: boolean = false): void {
    const visibleRangeBeforeClear = preserveViewport
      ? this.chart.timeScale().getVisibleLogicalRange?.()
      : null;

    if (preserveViewport) {
      this.suppressExternalSync = true;
    }

    try {
      this.clearHighlights();
      this.clearTrendlineCrossLabels();

      // Clear all trend lines
      for (const trendLineSeries of this.trendLineSeriesList) {
        try {
          this.chart.removeSeries(trendLineSeries);
        } catch {
          // Ignore stale trendline series remove errors.
        }
      }
      this.trendLineSeriesList = [];
      this.trendlineDefinitions = [];

      // Reset state
      this.firstPoint = null;
      this.divergencePoints = [];
      this.divergencePointTimeKeys.clear();
    } finally {
      if (preserveViewport && visibleRangeBeforeClear) {
        try {
          this.chart.timeScale().setVisibleLogicalRange(visibleRangeBeforeClear);
        } catch {
          // Keep viewport stable after clearing.
        }
      }
      if (preserveViewport) {
        this.suppressExternalSync = false;
      }
    }
  }

  resize(): void {
    if (this.chart) {
      this.chart.resize(this.chart.options().width, 400);
      this.refreshTrendlineCrossLabels();
    }
  }

  destroy(): void {
    if (this.chart) {
      this.clearTrendlineCrossLabels();
      this.chart.remove();
    }
  }
}

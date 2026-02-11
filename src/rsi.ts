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
}

export class RSIChart {
  private chart: any;
  private series: any;
  private lineTools: any;
  private displayMode: RSIDisplayMode;
  private data: RSIPoint[];
  private referenceLines: Array<{line: any, value: number}> = [];
  private priceData: Array<{time: string | number, close: number}> = [];
  private divergenceToolActive: boolean = false;
  private highlightSeries: any = null;

  constructor(options: RSIChartOptions) {
    this.displayMode = options.displayMode;
    this.data = options.data;
    this.priceData = options.priceData || [];

    // Create RSI chart
    this.chart = LightweightCharts.createChart(options.container, {
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
      }
    });

    // Add overbought/oversold reference lines
    this.addReferenceLine(70, 'Overbought', '#f85149');
    this.addReferenceLine(30, 'Oversold', '#3fb950');

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

  private addReferenceLine(value: number, label: string, color: string): void {
    const line = this.chart.addLineSeries({
      color,
      lineWidth: 1,
      lineStyle: 2, // LineStyle.Dashed
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    // Store reference to update later with actual data range
    this.referenceLines = this.referenceLines || [];
    this.referenceLines.push({ line, value });
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
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true
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
        priceLineVisible: true,
        lastValueVisible: true
      });
    }

    // Set data
    if (this.displayMode === 'line') {
      this.series.setData(this.data);
    } else {
      // For histogram (points mode), convert to histogram format
      this.series.setData(this.data.map(d => ({
        time: d.time,
        value: d.value,
        color: '#58a6ff'
      })));
    }

    // Update reference lines to match data range
    if (this.data.length > 0 && this.referenceLines.length > 0) {
      const firstTime = this.data[0].time;
      const lastTime = this.data[this.data.length - 1].time;

      this.referenceLines.forEach(({line, value}) => {
        line.setData([
          { time: firstTime, value },
          { time: lastTime, value }
        ]);
      });
    }
  }

  setDisplayMode(mode: RSIDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.updateSeries();
  }

  setData(data: RSIPoint[], priceData?: Array<{time: string | number, close: number}>): void {
    this.data = data;
    if (priceData) {
      this.priceData = priceData;
    }

    if (this.series) {
      if (this.displayMode === 'line') {
        this.series.setData(data);
      } else {
        this.series.setData(data.map(d => ({
          time: d.time,
          value: d.value,
          color: '#58a6ff'
        })));
      }
    }

    // Update reference lines to match actual data range
    if (data.length > 0 && this.referenceLines.length > 0) {
      const firstTime = data[0].time;
      const lastTime = data[data.length - 1].time;

      this.referenceLines.forEach(({line, value}) => {
        line.setData([
          { time: firstTime, value },
          { time: lastTime, value }
        ]);
      });
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
    // Clear any highlights
    this.clearHighlights();
  }

  private detectAndHighlightDivergence(clickedTime: string | number): void {
    // Find the clicked point in RSI data
    const clickedIndex = this.data.findIndex(d => d.time === clickedTime);
    if (clickedIndex === -1) {
      console.log('Clicked point not found in RSI data');
      return;
    }

    const originRSI = this.data[clickedIndex].value;

    // Find corresponding price
    const originPricePoint = this.priceData.find(p => p.time === clickedTime);
    if (!originPricePoint) {
      console.log('Corresponding price data not found');
      return;
    }

    const originPrice = originPricePoint.close;

    // Find all future points with divergence (lower RSI, higher price)
    const divergencePoints: RSIPoint[] = [];

    for (let i = clickedIndex + 1; i < this.data.length; i++) {
      const currentRSI = this.data[i].value;
      const currentPricePoint = this.priceData.find(p => p.time === this.data[i].time);

      if (currentPricePoint) {
        const currentPrice = currentPricePoint.close;

        // Check divergence conditions: RSI lower AND price higher
        if (currentRSI < originRSI && currentPrice > originPrice) {
          divergencePoints.push(this.data[i]);
        }
      }
    }

    console.log(`Found ${divergencePoints.length} divergence points from origin (RSI: ${originRSI.toFixed(2)}, Price: ${originPrice.toFixed(2)})`);

    // Highlight the divergence points
    this.highlightPoints(divergencePoints);
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

    this.highlightSeries.setData(points);
  }

  private clearHighlights(): void {
    if (this.highlightSeries) {
      this.chart.removeSeries(this.highlightSeries);
      this.highlightSeries = null;
    }
  }

  clearDivergence(): void {
    this.clearHighlights();
  }

  resize(): void {
    if (this.chart) {
      this.chart.resize(this.chart.options().width, 400);
    }
  }

  destroy(): void {
    if (this.chart) {
      this.chart.remove();
    }
  }
}

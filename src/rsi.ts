// RSI Chart configuration and management

import { RSIPoint, RSIDisplayMode } from './chartApi';

// Declare Lightweight Charts global
declare const LightweightCharts: any;
declare const LightweightChartsLineTools: any;

export interface RSIChartOptions {
  container: HTMLElement;
  data: RSIPoint[];
  displayMode: RSIDisplayMode;
}

export class RSIChart {
  private chart: any;
  private series: any;
  private lineTools: any;
  private displayMode: RSIDisplayMode;
  private data: RSIPoint[];
  private referenceLines: Array<{line: any, value: number}> = [];

  constructor(options: RSIChartOptions) {
    this.displayMode = options.displayMode;
    this.data = options.data;

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
        visible: false  // Hide RSI time scale - only show price chart's time axis
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

    // Initialize line tools for RSI chart
    try {
      if (typeof LightweightChartsLineTools !== 'undefined' && LightweightChartsLineTools.LineTools) {
        this.lineTools = new LightweightChartsLineTools.LineTools(this.chart);
      }
    } catch (error) {
      console.warn('Line tools plugin not available for RSI chart:', error);
    }
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

  setData(data: RSIPoint[]): void {
    this.data = data;
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

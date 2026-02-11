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

  constructor(options: RSIChartOptions) {
    this.displayMode = options.displayMode;
    this.data = options.data;

    // Create RSI chart
    this.chart = LightweightCharts.createChart(options.container, {
      height: 150,
      layout: {
        background: { color: '#0d1117' },
        textColor: '#c9d1d9'
      },
      grid: {
        vertLines: { color: '#21262d' },
        horzLines: { color: '#21262d' }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#21262d'
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
    if (typeof LightweightChartsLineTools !== 'undefined') {
      this.lineTools = new LightweightChartsLineTools.LineTools(this.chart);
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

    // Create a single point at extreme past and future to draw horizontal line
    line.setData([
      { time: '2020-01-01', value },
      { time: '2030-01-01', value }
    ]);
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
      this.chart.resize(this.chart.options().width, 150);
    }
  }

  destroy(): void {
    if (this.chart) {
      this.chart.remove();
    }
  }
}

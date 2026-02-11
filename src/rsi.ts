// RSI Chart configuration and management

import { RSIPoint, RSIDisplayMode } from './chartApi';
import { IChartApi, ISeriesApi, createChart, LineStyle, CrosshairMode, MouseEventHandler, Time } from 'lightweight-charts';



export interface RSIChartOptions {
  container: HTMLElement;
  data: RSIPoint[];
  displayMode: RSIDisplayMode;
  priceData?: Array<{time: string | number, close: number}>; // For divergence detection
}

interface ReferenceLineConfig {
  value: number;
  label: string;
  color: string;
}

interface PriceDataPoint {
  time: string | number;
  close: number;
}

export class RSIChart {
  private chart: IChartApi;
  private series: ISeriesApi<"Line" | "Histogram"> | null = null;
  private displayMode: RSIDisplayMode;
  private data: RSIPoint[];
  private referenceLines: ReferenceLineConfig[] = [];
  private priceData: PriceDataPoint[] = [];
  private divergenceToolActive: boolean = false;
  private highlightSeries: ISeriesApi<"Line"> | null = null;
  private firstPoint: {time: string | number, rsi: number, price: number, index: number} | null = null;
  private divergencePoints: RSIPoint[] = [];
  private trendLineSeries: ISeriesApi<"Line"> | null = null;

  constructor(options: RSIChartOptions) {
    this.displayMode = options.displayMode;
    this.data = options.data;
    this.priceData = options.priceData || [];

    // Create RSI chart
    this.chart = createChart(options.container, {
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
        borderColor: '#21262d',
        scaleMargins: {
          top: 0.1,
          bottom: 0.1
        }
      },
      crosshair: {
        mode: CrosshairMode.Normal
      }
    });

    // Add midline at 50
    this.addReferenceLine(50, 'Midline', '#ffffff');

    // Add RSI series based on display mode
    this.updateSeries();

    // Subscribe to events
    this.chart.subscribeClick(this.handleChartClick.bind(this));
  }

  private handleChartClick(param: MouseEventHandler<Time>): void {
    if (this.divergenceToolActive && param && param.time) {
      this.detectAndHighlightDivergence(param.time as string | number);
    }
  }

  private addReferenceLine(value: number, label: string, color: string): void {
    const config: ReferenceLineConfig = { value, label, color };
    this.referenceLines.push(config);

    if (this.series) {
      this.createPriceLine(this.series, config);
    }
  }

  private createPriceLine(series: ISeriesApi<any>, config: ReferenceLineConfig): void {
    series.createPriceLine({
      price: config.value,
      color: config.color,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: config.label
    });
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
      this.series.setData(this.data as any);
    } else {
      this.series.setData(this.data.map(d => ({
        time: d.time,
        value: d.value,
        color: '#58a6ff'
      })) as any);
    }

    // Add reference lines
    this.referenceLines.forEach(config => {
        if (this.series) this.createPriceLine(this.series, config);
    });
  }

  setDisplayMode(mode: RSIDisplayMode): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    this.updateSeries();
  }

  setData(data: RSIPoint[], priceData?: PriceDataPoint[]): void {
    this.data = data;
    if (priceData) {
      this.priceData = priceData;
    }

    if (this.series) {
        if (this.displayMode === 'line') {
            this.series.setData(data as any);
        } else {
            this.series.setData(data.map(d => ({
                time: d.time,
                value: d.value,
                color: '#58a6ff'
            })) as any);
        }
    }
  }

  getChart(): IChartApi {
    return this.chart;
  }

  getSeries(): ISeriesApi<"Line" | "Histogram"> | null {
    return this.series;
  }

  activateDivergenceTool(): void {
    this.divergenceToolActive = true;
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
    this.clearDivergence();
  }

  private detectAndHighlightDivergence(clickedTime: string | number): void {
    const clickedIndex = this.data.findIndex(d => d.time === clickedTime);
    if (clickedIndex === -1) return;

    const clickedRSI = this.data[clickedIndex].value;
    const clickedPricePoint = this.priceData.find(p => p.time === clickedTime);
    
    if (!clickedPricePoint) return;
    const clickedPrice = clickedPricePoint.close;

    if (!this.firstPoint) {
      // First click
      this.firstPoint = {
        time: clickedTime,
        rsi: clickedRSI,
        price: clickedPrice,
        index: clickedIndex
      };

      this.divergencePoints = [];
      for (let i = clickedIndex + 1; i < this.data.length; i++) {
        const currentRSI = this.data[i].value;
        const currentPricePoint = this.priceData.find(p => p.time === this.data[i].time);

        if (currentPricePoint) {
          const currentPrice = currentPricePoint.close;
          if (currentRSI < clickedRSI && currentPrice > clickedPrice) {
            this.divergencePoints.push(this.data[i]);
          }
        }
      }
      this.highlightPoints(this.divergencePoints);
    } else {
      // Second click
      const isValidSecondPoint = this.divergencePoints.some(p => p.time === clickedTime);
      if (!isValidSecondPoint) return;

      this.drawTrendLine(this.firstPoint.time, this.firstPoint.rsi, clickedTime, clickedRSI);
      this.clearHighlights();
      this.firstPoint = null;
      this.divergencePoints = [];
    }
  }

  private highlightPoints(points: RSIPoint[]): void {
    this.clearHighlights();
    if (points.length === 0) return;

    this.highlightSeries = this.chart.addLineSeries({
      color: '#ff6b6b',
      lineWidth: 0,
      pointMarkersVisible: true,
      pointMarkersRadius: 5
    });

    this.highlightSeries.setData(points as any);
  }

  private clearHighlights(): void {
    if (this.highlightSeries) {
      this.chart.removeSeries(this.highlightSeries);
      this.highlightSeries = null;
    }
  }

  private drawTrendLine(time1: string | number, value1: number, time2: string | number, value2: number): void {
    const index1 = this.data.findIndex(d => d.time === time1);
    const index2 = this.data.findIndex(d => d.time === time2);

    if (index1 === -1 || index2 === -1) return;

    const slope = (value2 - value1) / (index2 - index1);
    const trendLineData: RSIPoint[] = [];

    for (let i = index1; i < this.data.length; i++) {
      const projectedValue = value1 + slope * (i - index1);
      trendLineData.push({
        time: this.data[i].time,
        value: projectedValue
      });
    }

    if (this.trendLineSeries) {
      this.chart.removeSeries(this.trendLineSeries);
    }

    this.trendLineSeries = this.chart.addLineSeries({
      color: '#ffa500',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    this.trendLineSeries.setData(trendLineData as any);
  }

  clearDivergence(): void {
    this.clearHighlights();
    if (this.trendLineSeries) {
      this.chart.removeSeries(this.trendLineSeries);
      this.trendLineSeries = null;
    }
    this.firstPoint = null;
    this.divergencePoints = [];
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

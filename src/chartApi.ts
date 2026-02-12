// Chart API types and client

export type ChartInterval = '5min' | '15min' | '30min' | '1hour' | '4hour' | '1day';
export type RSIDisplayMode = 'line' | 'points';

export interface CandleBar {
  time: string | number; // LA timezone: "YYYY-MM-DD" or Unix timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RSIPoint {
  time: string | number;
  value: number;
}

export interface ChartData {
  interval: ChartInterval;
  timezone: 'America/Los_Angeles';
  bars: CandleBar[];
  rsi: RSIPoint[];
  volumeDeltaRsi: {
    rsi: RSIPoint[];
  };
  volumeDelta?: Array<{
    time: string | number;
    delta: number;
  }>;
}

export interface ChartFetchOptions {
  vdRsiLength?: number;
}

export async function fetchChartData(ticker: string, interval: ChartInterval, options: ChartFetchOptions = {}): Promise<ChartData> {
  const params = new URLSearchParams();
  if (Number.isFinite(options.vdRsiLength)) {
    params.set('vdRsiLength', String(Math.max(1, Math.floor(Number(options.vdRsiLength)))));
  }
  const vdRsiLengthParam = params.get('vdRsiLength');
  const url = `/api/chart?ticker=${encodeURIComponent(ticker)}&interval=${interval}${vdRsiLengthParam ? `&vdRsiLength=${vdRsiLengthParam}` : ''}`;
  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to fetch chart data' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

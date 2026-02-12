// Chart API types and client

export type ChartInterval = '5min' | '15min' | '30min' | '1hour' | '4hour' | '1day' | '1week';
export type RSIDisplayMode = 'line' | 'points';
export type VolumeDeltaSourceInterval = '5min' | '15min' | '30min' | '1hour' | '4hour';

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

export interface ChartLatestData {
  interval: ChartInterval;
  timezone: 'America/Los_Angeles';
  latestBar: CandleBar | null;
  latestRsi: RSIPoint | null;
  latestVolumeDeltaRsi: RSIPoint | null;
  latestVolumeDelta: {
    time: string | number;
    delta: number;
  } | null;
}

export interface ChartFetchOptions {
  vdRsiLength?: number;
  vdSourceInterval?: VolumeDeltaSourceInterval;
  vdRsiSourceInterval?: VolumeDeltaSourceInterval;
  signal?: AbortSignal;
  onResponseMeta?: (meta: { status: number; chartCacheHeader: string | null }) => void;
}

export async function fetchChartData(ticker: string, interval: ChartInterval, options: ChartFetchOptions = {}): Promise<ChartData> {
  const params = new URLSearchParams();
  if (Number.isFinite(options.vdRsiLength)) {
    params.set('vdRsiLength', String(Math.max(1, Math.floor(Number(options.vdRsiLength)))));
  }
  if (typeof options.vdSourceInterval === 'string' && options.vdSourceInterval) {
    params.set('vdSourceInterval', options.vdSourceInterval);
  }
  if (typeof options.vdRsiSourceInterval === 'string' && options.vdRsiSourceInterval) {
    params.set('vdRsiSourceInterval', options.vdRsiSourceInterval);
  }
  const query = params.toString();
  const url = `/api/chart?ticker=${encodeURIComponent(ticker)}&interval=${interval}${query ? `&${query}` : ''}`;
  const response = await fetch(url, { signal: options.signal });
  if (typeof options.onResponseMeta === 'function') {
    options.onResponseMeta({
      status: response.status,
      chartCacheHeader: response.headers.get('x-chart-cache')
    });
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to fetch chart data' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export async function fetchChartLatestData(
  ticker: string,
  interval: ChartInterval,
  options: ChartFetchOptions = {}
): Promise<ChartLatestData> {
  const params = new URLSearchParams();
  if (Number.isFinite(options.vdRsiLength)) {
    params.set('vdRsiLength', String(Math.max(1, Math.floor(Number(options.vdRsiLength)))));
  }
  if (typeof options.vdSourceInterval === 'string' && options.vdSourceInterval) {
    params.set('vdSourceInterval', options.vdSourceInterval);
  }
  if (typeof options.vdRsiSourceInterval === 'string' && options.vdRsiSourceInterval) {
    params.set('vdRsiSourceInterval', options.vdRsiSourceInterval);
  }
  const query = params.toString();
  const url = `/api/chart/latest?ticker=${encodeURIComponent(ticker)}&interval=${interval}${query ? `&${query}` : ''}`;
  const response = await fetch(url, { signal: options.signal });
  if (typeof options.onResponseMeta === 'function') {
    options.onResponseMeta({
      status: response.status,
      chartCacheHeader: response.headers.get('x-chart-cache')
    });
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to fetch latest chart data' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

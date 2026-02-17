// Chart API types and client

export type { ChartInterval, CandleBar, RSIPoint, CandleBarTuple, RSIPointTuple, ChartData, ChartLatestData } from '../shared/api-types';
import type { ChartInterval, CandleBar, RSIPoint, CandleBarTuple, RSIPointTuple, ChartData, ChartLatestData } from '../shared/api-types';
export type RSIDisplayMode = 'line' | 'points';
export type VolumeDeltaSourceInterval = '1min' | '5min' | '15min' | '30min' | '1hour' | '4hour';

// Internal interfaces (Network response)
interface ChartDataRaw extends Omit<ChartData, 'bars' | 'rsi' | 'volumeDeltaRsi' | 'volumeDelta'> {
  bars: CandleBar[] | CandleBarTuple[];
  rsi: RSIPoint[] | RSIPointTuple[];
  volumeDeltaRsi: {
    rsi: RSIPoint[] | RSIPointTuple[];
  };
  volumeDelta?: Array<{ time: string | number; delta: number }> | RSIPointTuple[];
}

interface ChartLatestDataRaw extends Omit<ChartLatestData, 'latestBar' | 'latestRsi' | 'latestVolumeDeltaRsi' | 'latestVolumeDelta'> {
  latestBar: CandleBar | CandleBarTuple | null;
  latestRsi: RSIPoint | RSIPointTuple | null;
  latestVolumeDeltaRsi: RSIPoint | RSIPointTuple | null;
  latestVolumeDelta: { time: string | number; delta: number } | RSIPointTuple | null;
}

export interface ChartFetchOptions {
  vdRsiLength?: number;
  vdSourceInterval?: VolumeDeltaSourceInterval;
  vdRsiSourceInterval?: VolumeDeltaSourceInterval;
  signal?: AbortSignal;
  onResponseMeta?: (meta: { status: number; chartCacheHeader: string | null }) => void;
}

function normalizeTupleData(data: ChartDataRaw): ChartData {
  if (!data) return data as any;
  
  const barFromTuple = (t: CandleBarTuple): CandleBar => ({
    time: t[0], open: t[1], high: t[2], low: t[3], close: t[4], volume: t[5]
  });
  
  const pointFromTuple = (t: RSIPointTuple, valueKey = 'value'): RSIPoint | any => ({
    time: t[0], [valueKey]: t[1]
  });

  const bars = (Array.isArray(data.bars) && data.bars.length > 0 && Array.isArray(data.bars[0]))
    ? (data.bars as CandleBarTuple[]).map(barFromTuple)
    : (data.bars as CandleBar[]);

  const rsi = (Array.isArray(data.rsi) && data.rsi.length > 0 && Array.isArray(data.rsi[0]))
    ? (data.rsi as RSIPointTuple[]).map((p) => pointFromTuple(p))
    : (data.rsi as RSIPoint[]);

  const vdRsiPoints = (data.volumeDeltaRsi && Array.isArray(data.volumeDeltaRsi.rsi) && data.volumeDeltaRsi.rsi.length > 0 && Array.isArray(data.volumeDeltaRsi.rsi[0]))
    ? (data.volumeDeltaRsi.rsi as RSIPointTuple[]).map((p) => pointFromTuple(p))
    : (data.volumeDeltaRsi?.rsi as RSIPoint[] || []);

  const volumeDelta = (Array.isArray(data.volumeDelta) && data.volumeDelta.length > 0 && Array.isArray(data.volumeDelta[0]))
    ? (data.volumeDelta as RSIPointTuple[]).map((p) => pointFromTuple(p, 'delta'))
    : (data.volumeDelta as Array<{ time: string | number; delta: number }>);

  return {
    ...data,
    bars,
    rsi,
    volumeDeltaRsi: { rsi: vdRsiPoints },
    volumeDelta
  };
}

function normalizeLatestTupleData(data: ChartLatestDataRaw): ChartLatestData {
  if (!data) return data as any;
  
  const barFromTuple = (t: CandleBarTuple): CandleBar => ({
    time: t[0], open: t[1], high: t[2], low: t[3], close: t[4], volume: t[5]
  });
  
  const pointFromTuple = (t: RSIPointTuple, valueKey = 'value'): RSIPoint | any => ({
    time: t[0], [valueKey]: t[1]
  });

  const latestBar = Array.isArray(data.latestBar) ? barFromTuple(data.latestBar as CandleBarTuple) : (data.latestBar as CandleBar);
  const latestRsi = Array.isArray(data.latestRsi) ? pointFromTuple(data.latestRsi as RSIPointTuple) : (data.latestRsi as RSIPoint);
  const latestVolumeDeltaRsi = Array.isArray(data.latestVolumeDeltaRsi) ? pointFromTuple(data.latestVolumeDeltaRsi as RSIPointTuple) : (data.latestVolumeDeltaRsi as RSIPoint);
  const latestVolumeDelta = Array.isArray(data.latestVolumeDelta) ? pointFromTuple(data.latestVolumeDelta as RSIPointTuple, 'delta') : (data.latestVolumeDelta as any);

  return {
    ...data,
    latestBar,
    latestRsi,
    latestVolumeDeltaRsi,
    latestVolumeDelta
  };
}

export async function fetchChartData(ticker: string, interval: ChartInterval, options: ChartFetchOptions = {}): Promise<ChartData> {
  const params = new URLSearchParams();
  params.set('format', 'tuple');
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

  const json = await response.json();
  return normalizeTupleData(json as ChartDataRaw);
}

export async function fetchChartLatestData(
  ticker: string,
  interval: ChartInterval,
  options: ChartFetchOptions = {}
): Promise<ChartLatestData> {
  const params = new URLSearchParams();
  params.set('format', 'tuple');
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

  const json = await response.json();
  return normalizeLatestTupleData(json as ChartLatestDataRaw);
}

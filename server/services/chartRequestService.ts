import { toVolumeDeltaSourceInterval, buildChartRequestKey, getIntradayLookbackDays } from './chartEngine.js';
import { isValidTickerSymbol } from '../middleware.js';

interface HttpError extends Error {
  httpStatus: number;
}

export function parseChartRequestParams(req: { query: Record<string, unknown> }) {
  const ticker = (req.query.ticker || 'SPY').toString().toUpperCase();
  if (!isValidTickerSymbol(ticker)) {
    const err = Object.assign(new Error('Invalid ticker format'), { httpStatus: 400 }) as HttpError;
    throw err;
  }
  const interval = (req.query.interval || '4hour').toString();
  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(req.query.vdRsiLength) || 14)));
  const vdSourceInterval = toVolumeDeltaSourceInterval(req.query.vdSourceInterval, '1min');
  const vdRsiSourceInterval = toVolumeDeltaSourceInterval(req.query.vdRsiSourceInterval, '1min');
  const lookbackDays = getIntradayLookbackDays(interval);
  const requestKey = buildChartRequestKey({
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
  });
  return {
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
    requestKey,
  };
}

export function findPointByTime(
  points: Array<{ time: number | string; [key: string]: unknown }> | unknown,
  timeValue: unknown,
) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const key = String(timeValue);
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (!point || String(point.time) !== key) continue;
    return point;
  }
  return null;
}

export function extractLatestChartPayload(result: Record<string, unknown>) {
  const bars = Array.isArray(result?.bars) ? result.bars : [];
  const latestBar = bars.length ? bars[bars.length - 1] : null;
  const latestTime = latestBar ? latestBar.time : null;
  const latestRsi = latestTime === null ? null : findPointByTime(result?.rsi, latestTime);
  const latestVolumeDeltaRsi =
    latestTime === null
      ? null
      : findPointByTime(
          (result?.volumeDeltaRsi as { rsi?: Array<{ time: number | string; [k: string]: unknown }> })?.rsi,
          latestTime,
        );
  const latestVolumeDelta = latestTime === null ? null : findPointByTime(result?.volumeDelta, latestTime);

  return {
    interval: result.interval,
    timezone: result?.timezone || 'America/Los_Angeles',
    latestBar,
    latestRsi,
    latestVolumeDeltaRsi,
    latestVolumeDelta,
  };
}

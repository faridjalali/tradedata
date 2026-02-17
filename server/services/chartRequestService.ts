import * as schemas from '../schemas.js';
import {
  VALID_CHART_INTERVALS,
  CHART_FINAL_RESULT_CACHE,
  CHART_IN_FLIGHT_REQUESTS,
  CHART_IN_FLIGHT_MAX,
  toVolumeDeltaSourceInterval,
  buildChartRequestKey,
  getTimedCacheValue,
  setTimedCacheValue,
  getChartResultCacheExpiryMs,
  getIntradayLookbackDays,
  dataApiIntradayChartHistory,
  buildChartResultFromRows,
  patchLatestBarCloseWithQuote,
  createChartStageTimer,
  CHART_TIMING_LOG_ENABLED,
} from './chartEngine.js';
import { dataApiLatestQuote } from './dataApi.js';
import * as chartPrewarm from './chartPrewarm.js';
import { isValidTickerSymbol } from '../middleware.js';


export function parseChartRequestParams(req: { query: Record<string, unknown> }) {
  const ticker = (req.query.ticker || 'SPY').toString().toUpperCase();
  if (!isValidTickerSymbol(ticker)) {
    const err = new Error('Invalid ticker format');
    (err as any).httpStatus = 400;
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


export function findPointByTime(points: Array<{ time: number | string; [key: string]: unknown }> | undefined, timeValue: unknown) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const key = String(timeValue);
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (!point || String(point.time) !== key) continue;
    return point;
  }
  return null;
}


export function extractLatestChartPayload(result: Record<string, any>) {
  const bars = Array.isArray(result?.bars) ? result.bars : [];
  const latestBar = bars.length ? bars[bars.length - 1] : null;
  const latestTime = latestBar ? latestBar.time : null;
  const latestRsi = latestTime === null ? null : findPointByTime(result?.rsi, latestTime);
  const latestVolumeDeltaRsi = latestTime === null ? null : findPointByTime(result?.volumeDeltaRsi?.rsi, latestTime);
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

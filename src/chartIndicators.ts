/**
 * Pure indicator calculation functions for the chart module.
 * Zero state access — all functions are pure.
 */

import { unixSecondsFromTimeValue, dayKeyInAppTimeZone } from './chartTimeUtils';
import type { MAType } from './chartTypes';

export function calculateRSIFromCloses(closePrices: number[], period: number): number[] {
  if (!Array.isArray(closePrices) || closePrices.length === 0) return [];
  if (closePrices.length === 1) return [50];

  const safePeriod = Math.max(1, Math.floor(period || 14));
  const rsiValues = new Array(closePrices.length).fill(50);
  const gains: number[] = [];
  const losses: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < closePrices.length; i++) {
    const change = closePrices[i] - closePrices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    gains.push(gain);
    losses.push(loss);

    if (i < safePeriod) {
      const window = i;
      let gainSum = 0;
      let lossSum = 0;
      for (let j = 0; j < window; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / window;
      avgLoss = lossSum / window;
    } else if (i === safePeriod) {
      let gainSum = 0;
      let lossSum = 0;
      for (let j = i - safePeriod; j < i; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / safePeriod;
      avgLoss = lossSum / safePeriod;
    } else {
      avgGain = (avgGain * (safePeriod - 1) + gain) / safePeriod;
      avgLoss = (avgLoss * (safePeriod - 1) + loss) / safePeriod;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    rsiValues[i] = Number.isFinite(rsi) ? rsi : rsiValues[i - 1];
  }

  rsiValues[0] = rsiValues[1] ?? 50;
  return rsiValues;
}

export function buildRSISeriesFromBars(bars: any[], period: number): Array<{ time: string | number; value: number }> {
  if (!bars || bars.length === 0) return [];
  const closes = bars.map((bar) => Number(bar.close));
  const rsiValues = calculateRSIFromCloses(closes, period);
  const out: Array<{ time: string | number; value: number }> = [];
  for (let i = 0; i < bars.length; i++) {
    const raw = rsiValues[i];
    if (!Number.isFinite(raw)) continue;
    out.push({ time: bars[i].time, value: Math.round(raw * 100) / 100 });
  }
  return out;
}

export function normalizeValueSeries(points: any[]): Array<{ time: string | number; value: number }> {
  if (!Array.isArray(points)) return [];
  return points
    .filter(
      (point) =>
        point &&
        (typeof point.time === 'string' || typeof point.time === 'number') &&
        Number.isFinite(Number(point.value)),
    )
    .map((point) => ({
      time: point.time,
      value: Number(point.value),
    }));
}

export function computeSMA(values: number[], length: number): Array<number | null> {
  const period = Math.max(1, Math.floor(length));
  const out: Array<number | null> = new Array(values.length).fill(null);
  const filled = values.slice();
  let lastFinite: number | null = null;
  for (let i = 0; i < filled.length; i++) {
    if (Number.isFinite(filled[i])) {
      lastFinite = filled[i];
    } else if (lastFinite !== null) {
      filled[i] = lastFinite;
    }
  }
  let sum = 0;
  for (let i = 0; i < filled.length; i++) {
    const value = filled[i];
    if (!Number.isFinite(value)) continue;
    sum += value;
    if (i >= period) {
      sum -= filled[i - period];
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }
  return out;
}

export function computeEMA(values: number[], length: number): Array<number | null> {
  const period = Math.max(1, Math.floor(length));
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const filled = values.slice();
  let lastFinite: number | null = null;
  for (let i = 0; i < filled.length; i++) {
    if (Number.isFinite(filled[i])) {
      lastFinite = filled[i];
    } else if (lastFinite !== null) {
      filled[i] = lastFinite;
    }
  }
  const alpha = 2 / (period + 1);
  let ema: number | null = null;

  for (let i = 0; i < filled.length; i++) {
    const value = filled[i];
    if (!Number.isFinite(value)) continue;
    if (ema === null) {
      let sum = 0;
      let count = 0;
      for (let j = i; j < filled.length && count < period; j++) {
        if (Number.isFinite(filled[j])) {
          sum += filled[j];
          count++;
        }
      }
      ema = count > 0 ? sum / count : value;
    } else {
      ema = value * alpha + ema * (1 - alpha);
    }
    out[i] = ema;
  }
  return out;
}

export function buildDailyMAValuesForBars(bars: any[], type: MAType, length: number): Array<number | null> {
  const dayOrder: string[] = [];
  const dayCloseByKey = new Map<string, number>();
  const seen = new Set<string>();

  for (const bar of bars) {
    const unixSeconds = unixSecondsFromTimeValue(bar?.time);
    const close = Number(bar?.close);
    if (unixSeconds === null || !Number.isFinite(close)) continue;
    const key = dayKeyInAppTimeZone(unixSeconds);
    if (!seen.has(key)) {
      seen.add(key);
      dayOrder.push(key);
    }
    dayCloseByKey.set(key, close);
  }

  const dailyCloses = dayOrder.map((day) => Number(dayCloseByKey.get(day)));
  const dailyMA = type === 'EMA' ? computeEMA(dailyCloses, length) : computeSMA(dailyCloses, length);

  const dailyMAByKey = new Map<string, number | null>();
  for (let i = 0; i < dayOrder.length; i++) {
    dailyMAByKey.set(dayOrder[i], dailyMA[i] ?? null);
  }

  return bars.map((bar) => {
    const unixSeconds = unixSecondsFromTimeValue(bar?.time);
    if (unixSeconds === null) return null;
    return dailyMAByKey.get(dayKeyInAppTimeZone(unixSeconds)) ?? null;
  });
}

export function isRenderableMaValue(value: unknown): value is number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0;
}

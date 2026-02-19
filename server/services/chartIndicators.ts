/**
 * Chart technical indicator calculations:
 * RSI, RMA, Volume Delta, Volume Delta RSI series,
 * and cumulative volume normalization.
 */

import { dayKeyInLA } from '../chartMath.js';

export interface OHLCVBar {
  [key: string]: unknown;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function calculateRSI(closePrices: number[], period: number = 14): number[] {
  if (!Array.isArray(closePrices) || closePrices.length === 0) return [];
  if (closePrices.length === 1) return [50];

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

    if (i < period) {
      const window = i;
      let gainSum = 0;
      let lossSum = 0;
      for (let j = 0; j < window; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / window;
      avgLoss = lossSum / window;
    } else if (i === period) {
      let gainSum = 0;
      let lossSum = 0;
      for (let j = i - period; j < i; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / period;
      avgLoss = lossSum / period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    rsiValues[i] = Number.isFinite(rsi) ? rsi : rsiValues[i - 1];
  }

  rsiValues[0] = rsiValues[1] ?? 50;
  return rsiValues;
}

export function calculateRMA(values: Array<number | null>, length: number = 14) {
  const period = Math.max(1, Math.floor(length));
  const out = new Array(values.length).fill(null);

  const validValues: { index: number; value: number }[] = [];
  let firstValidIndex = -1;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) {
      if (firstValidIndex === -1) {
        firstValidIndex = i;
      }
      validValues.push({ index: i, value: v });

      if (validValues.length === period) {
        const sum = validValues.reduce((acc, v) => acc + v.value, 0);
        out[i] = sum / period;
        break;
      }
    }
  }

  if (validValues.length < period) return out;

  let rma = out[validValues[period - 1].index];

  for (let i = validValues[period - 1].index + 1; i < values.length; i++) {
    const value = values[i];
    if (value === null || !Number.isFinite(value)) continue;
    rma = (rma * (period - 1) + value) / period;
    out[i] = rma;
  }

  return out;
}

export function getIntervalSeconds(interval: string): number {
  const map: Record<string, number> = {
    '1min': 60,
    '5min': 5 * 60,
    '15min': 15 * 60,
    '30min': 30 * 60,
    '1hour': 60 * 60,
    '4hour': 4 * 60 * 60,
    '1day': 24 * 60 * 60,
    '1week': 7 * 24 * 60 * 60,
  };
  return map[interval] || 60;
}

export function normalizeIntradayVolumesFromCumulativeIfNeeded(bars: OHLCVBar[]) {
  if (!Array.isArray(bars) || bars.length < 2) return bars || [];

  const normalized = bars.map((bar) => ({ ...bar, volume: Number(bar.volume) || 0 }));

  const maybeNormalizeDayRange = (startIndex: number, endIndex: number) => {
    if (endIndex - startIndex < 3) return;

    let nonDecreasing = 0;
    let steps = 0;
    const positiveDiffs: number[] = [];
    let maxVolume = Number.NEGATIVE_INFINITY;

    for (let i = startIndex; i <= endIndex; i++) {
      maxVolume = Math.max(maxVolume, Number(normalized[i].volume) || 0);
    }

    for (let i = startIndex + 1; i <= endIndex; i++) {
      const prev = Number(normalized[i - 1].volume) || 0;
      const curr = Number(normalized[i].volume) || 0;
      steps += 1;
      if (curr >= prev) nonDecreasing += 1;
      if (curr > prev) positiveDiffs.push(curr - prev);
    }

    if (steps === 0 || positiveDiffs.length === 0) return;
    const monotonicRatio = nonDecreasing / steps;
    if (monotonicRatio < 0.9) return;

    const avgDiff = positiveDiffs.reduce((sum, value) => sum + value, 0) / positiveDiffs.length;
    if (!Number.isFinite(avgDiff) || avgDiff <= 0) return;
    if (maxVolume / avgDiff < 6) return;

    for (let i = startIndex + 1; i <= endIndex; i++) {
      const prev = Number(normalized[i - 1].volume) || 0;
      const curr = Number(normalized[i].volume) || 0;
      normalized[i].volume = Math.max(0, curr - prev);
    }
    normalized[startIndex].volume = Math.max(0, Number(normalized[startIndex].volume) || 0);
  };

  let dayStart = 0;
  let currentDayKey = dayKeyInLA(Number(normalized[0].time));
  for (let i = 1; i < normalized.length; i++) {
    const key = dayKeyInLA(Number(normalized[i].time));
    if (key === currentDayKey) continue;
    maybeNormalizeDayRange(dayStart, i - 1);
    dayStart = i;
    currentDayKey = key;
  }
  maybeNormalizeDayRange(dayStart, normalized.length - 1);

  return normalized;
}

export function computeVolumeDeltaByParentBars(parentBars: OHLCVBar[], lowerTimeframeBars: OHLCVBar[], interval: string) {
  if (!Array.isArray(parentBars) || parentBars.length === 0) return [];
  if (!Array.isArray(lowerTimeframeBars) || lowerTimeframeBars.length === 0) {
    return parentBars.map((bar) => ({ time: bar.time, delta: 0 }));
  }

  const intervalSeconds = getIntervalSeconds(interval);
  const parentTimes = parentBars.map((bar) => Number(bar.time));
  const intrabarsPerParent: Array<Array<{ open: number; close: number; volume: number }>> = parentBars.map(() => []);
  let parentIndex = 0;

  for (const bar of lowerTimeframeBars) {
    const t = Number(bar.time);
    if (!Number.isFinite(t)) continue;

    while (parentIndex + 1 < parentTimes.length && t >= parentTimes[parentIndex + 1]) {
      parentIndex += 1;
    }

    const currentParentStart = parentTimes[parentIndex];
    if (!Number.isFinite(currentParentStart)) continue;
    if (t < currentParentStart || t >= currentParentStart + intervalSeconds) continue;

    const open = Number(bar.open);
    const close = Number(bar.close);
    const volume = Number(bar.volume);
    if (!Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(volume)) continue;

    intrabarsPerParent[parentIndex].push({ open, close, volume });
  }

  let lastClose: number | null = null;
  let lastBull: boolean | null = null;
  const deltas: { time: number; delta: number }[] = [];

  for (let i = 0; i < parentBars.length; i++) {
    const stream = intrabarsPerParent[i];
    if (!stream || stream.length === 0) {
      deltas.push({ time: parentBars[i].time, delta: 0 });
      continue;
    }

    let runningDelta = 0;
    let streamLastClose: number | null = lastClose;
    let streamLastBull: boolean | null = lastBull;

    for (let j = 0; j < stream.length; j++) {
      const ib = stream[j];
      let isBull: boolean | null = ib.close > ib.open ? true : ib.close < ib.open ? false : null;
      if (isBull === null) {
        const prevClose = j === 0 ? streamLastClose : stream[j - 1].close;
        if (prevClose !== null && Number.isFinite(prevClose)) {
          if (ib.close > prevClose) isBull = true;
          else if (ib.close < prevClose) isBull = false;
          else isBull = streamLastBull;
        } else {
          isBull = streamLastBull;
        }
      }

      if (isBull === null && runningDelta !== 0) isBull = runningDelta > 0;
      if (isBull !== null) streamLastBull = isBull;
      runningDelta += isBull === true ? ib.volume : isBull === false ? -ib.volume : 0;
      if (j === stream.length - 1) streamLastClose = ib.close;
    }

    lastClose = Number.isFinite(streamLastClose) ? streamLastClose : lastClose;
    lastBull = streamLastBull;
    deltas.push({ time: parentBars[i].time, delta: runningDelta });
  }

  return deltas;
}

export function calculateVolumeDeltaRsiSeries(
  parentBars: OHLCVBar[],
  lowerTimeframeBars: OHLCVBar[],
  interval: string,
  options: { rsiLength?: number } = {},
) {
  const rsiLength = Math.max(1, Math.floor(Number(options.rsiLength) || 14));

  const deltaByBar = computeVolumeDeltaByParentBars(parentBars, lowerTimeframeBars, interval);
  const gains = deltaByBar.map((point) => {
    if (!Number.isFinite(point.delta)) return null;
    return Math.max(Number(point.delta), 0);
  });
  const losses = deltaByBar.map((point) => {
    if (!Number.isFinite(point.delta)) return null;
    return Math.max(-Number(point.delta), 0);
  });

  const avgGains = calculateRMA(gains, rsiLength);
  const avgLosses = calculateRMA(losses, rsiLength);
  const vdRsiRaw = new Array(deltaByBar.length).fill(null);

  for (let i = 0; i < deltaByBar.length; i++) {
    const avgGain = avgGains[i];
    const avgLoss = avgLosses[i];
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) continue;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const value = 100 - 100 / (1 + rs);
    vdRsiRaw[i] = Number.isFinite(value) ? value : null;
  }

  const rsi: { time: number; value: number }[] = [];
  for (let i = 0; i < deltaByBar.length; i++) {
    const time = deltaByBar[i].time;
    const rsiValue = vdRsiRaw[i];
    if (Number.isFinite(rsiValue)) {
      rsi.push({ time, value: Math.round((rsiValue as number) * 100) / 100 });
    }
  }

  const deltaValues = deltaByBar.map((d) => ({
    time: d.time,
    delta: Number.isFinite(d.delta) ? d.delta : 0,
  }));

  return { rsi, deltaValues };
}

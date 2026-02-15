#!/usr/bin/env node
/**
 * HTF Pattern Analysis for RKLB and ASTS
 *
 * Fetches 2 years of daily, 15m, and 1m data from Massive API.
 * Identifies all bull-run + consolidation episodes.
 * Runs the HTF algorithm on each episode to understand what's detected vs missed.
 * Outputs detailed metric breakdowns for each episode.
 */

require('dotenv').config();

const DATA_API_KEY = process.env.DATA_API_KEY;
const DATA_API_BASE = 'https://api.massive.com';

if (!DATA_API_KEY) {
  console.error('DATA_API_KEY not set in .env');
  process.exit(1);
}

// =========================================================================
// API FETCHING
// =========================================================================

async function fetchBars(symbol, multiplier, timespan, from, to) {
  const url = `${DATA_API_BASE}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${symbol} ${multiplier}${timespan} ${from}-${to}`);
  const json = await resp.json();
  const results = json.results || [];
  return results.map(r => ({
    time: Math.floor((r.t || 0) / 1000),
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: r.v || 0
  })).filter(b => Number.isFinite(b.time) && Number.isFinite(b.close));
}

async function fetchDailyBars(symbol, fromDate, toDate) {
  console.log(`  Fetching daily bars for ${symbol} ${fromDate} to ${toDate}...`);
  return fetchBars(symbol, 1, 'day', fromDate, toDate);
}

async function fetch15mBars(symbol, fromDate, toDate) {
  // 15m data needs chunking — max 50k bars per request
  // 15m = ~26 bars/day, 150 days = ~3900 bars
  const chunks = [];
  const start = new Date(fromDate);
  const end = new Date(toDate);
  const chunkDays = 150;

  let cursor = new Date(start);
  while (cursor < end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    const f = cursor.toISOString().split('T')[0];
    const t = chunkEnd.toISOString().split('T')[0];
    console.log(`  Fetching 15m bars for ${symbol} ${f} to ${t}...`);
    const bars = await fetchBars(symbol, 15, 'minute', f, t);
    chunks.push(...bars);
    await sleep(200);

    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  // Deduplicate by time
  const map = new Map();
  for (const bar of chunks) map.set(bar.time, bar);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

async function fetch1mBars(symbol, fromDate, toDate) {
  // 1m data — 30-day chunks
  const chunks = [];
  const start = new Date(fromDate);
  const end = new Date(toDate);
  const chunkDays = 30;

  let cursor = new Date(start);
  while (cursor < end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    const f = cursor.toISOString().split('T')[0];
    const t = chunkEnd.toISOString().split('T')[0];
    console.log(`  Fetching 1m bars for ${symbol} ${f} to ${t}...`);
    const bars = await fetchBars(symbol, 1, 'minute', f, t);
    chunks.push(...bars);
    await sleep(300);

    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  const map = new Map();
  for (const bar of chunks) map.set(bar.time, bar);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =========================================================================
// MATH HELPERS (copied from htfDetector.js for standalone use)
// =========================================================================

function rollingMean(arr, window) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= window) sum -= arr[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function rollingStd(arr, window) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = window - 1; i < arr.length; i++) {
    let sum = 0, sum2 = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += arr[j];
      sum2 += arr[j] * arr[j];
    }
    const mean = sum / window;
    const variance = (sum2 / window) - (mean * mean);
    out[i] = Math.sqrt(Math.max(0, variance));
  }
  return out;
}

function percentileRank(value, sortedArr) {
  if (sortedArr.length === 0) return 50;
  let count = 0;
  for (const v of sortedArr) {
    if (v < value) count++;
  }
  return (count / sortedArr.length) * 100;
}

function linearRegression(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: 0, rSquared: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const yPred = intercept + slope * xs[i];
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - yPred) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, rSquared };
}

// =========================================================================
// HTF METRIC CALCULATORS
// =========================================================================

function yangZhangVolatility(bars, window) {
  const n = bars.length;
  const yz = new Array(n).fill(NaN);
  for (let end = window; end < n; end++) {
    const start = end - window;
    let sumLogOC2 = 0, sumLogCO2 = 0, sumRS = 0;
    let count = 0;
    for (let i = start + 1; i <= end; i++) {
      const prevClose = bars[i - 1].close;
      const o = bars[i].open, h = bars[i].high, l = bars[i].low, c = bars[i].close;
      if (prevClose <= 0 || o <= 0 || c <= 0) continue;
      const logCO = Math.log(o / prevClose);
      const logOC = Math.log(c / o);
      const logHO = Math.log(h / o);
      const logLO = Math.log(l / o);
      const logHC = Math.log(h / c);
      const logLC = Math.log(l / c);
      sumLogCO2 += logCO * logCO;
      sumLogOC2 += logOC * logOC;
      sumRS += (logHO * logHC) + (logLO * logLC);
      count++;
    }
    if (count < 2) continue;
    const overnightVar = sumLogCO2 / count;
    const ocVar = sumLogOC2 / count;
    const rsVar = sumRS / count;
    const k = 0.34 / (1.34 + (count + 1) / (count - 1));
    const total = overnightVar + k * ocVar + (1 - k) * rsVar;
    yz[end] = Math.sqrt(Math.max(0, total));
  }
  return yz;
}

function yzPercentileRank(yzSeries, lookback) {
  const n = yzSeries.length;
  const pctRanks = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(yzSeries[i])) continue;
    const start = Math.max(0, i - lookback);
    const hist = [];
    for (let j = start; j <= i; j++) {
      if (Number.isFinite(yzSeries[j])) hist.push(yzSeries[j]);
    }
    if (hist.length < 10) continue;
    hist.sort((a, b) => a - b);
    pctRanks[i] = percentileRank(yzSeries[i], hist);
  }
  return pctRanks;
}

function computeDeltaSeries1m(bars1m) {
  return bars1m.map(b => {
    if (b.close > b.open) return b.volume;
    if (b.close < b.open) return -b.volume;
    return 0;
  });
}

function computeDeltaCompression(bars1m, consolStartTime, config) {
  const deltas = computeDeltaSeries1m(bars1m);
  const window = config.delta_hourly_window || 60;

  // Find bars from consolidation start
  let startIdx = 0;
  for (let i = 0; i < bars1m.length; i++) {
    if (bars1m[i].time >= consolStartTime) { startIdx = i; break; }
  }

  // Need enough context before consolidation
  const contextStart = Math.max(0, startIdx - 7800);
  const absMeans = rollingMean(deltas.map(Math.abs), window);
  const stds = rollingStd(deltas, window);

  // Get recent context values
  const recentAbsMeans = [];
  const recentStds = [];
  for (let i = contextStart; i < startIdx; i++) {
    if (Number.isFinite(absMeans[i])) recentAbsMeans.push(absMeans[i]);
    if (Number.isFinite(stds[i])) recentStds.push(stds[i]);
  }
  recentAbsMeans.sort((a, b) => a - b);
  recentStds.sort((a, b) => a - b);

  // Get consolidation period values
  const consolAbsMeans = [];
  const consolStds = [];
  for (let i = startIdx; i < bars1m.length; i++) {
    if (Number.isFinite(absMeans[i])) consolAbsMeans.push(absMeans[i]);
    if (Number.isFinite(stds[i])) consolStds.push(stds[i]);
  }

  if (consolAbsMeans.length === 0 || recentAbsMeans.length === 0) {
    return { score: 0, meanPctRank: 50, stdPctRank: 50 };
  }

  // Use median of consolidation period
  const medianAbsMean = consolAbsMeans.sort((a, b) => a - b)[Math.floor(consolAbsMeans.length / 2)];
  const medianStd = consolStds.sort((a, b) => a - b)[Math.floor(consolStds.length / 2)];

  const meanPctRank = percentileRank(medianAbsMean, recentAbsMeans);
  const stdPctRank = percentileRank(medianStd, recentStds);

  const score = (1 - meanPctRank / 100) * (1 - stdPctRank / 100);
  return { score, meanPctRank, stdPctRank };
}

function computeRangeDecay(bars15m, consolIdx, config) {
  const flagBars = bars15m.slice(consolIdx);
  if (flagBars.length < (config.range_decay_min_bars || 50)) {
    return { score: 0, coefficient: 0, rSquared: 0, isDecaying: false };
  }

  const pctRanges = flagBars.map(b => (b.high - b.low) / b.close);
  const smoothWindow = Math.min(26, Math.max(3, Math.floor(pctRanges.length / 3)));
  const smoothed = rollingMean(pctRanges, smoothWindow);

  const xs = [], ys = [];
  for (let i = 0; i < smoothed.length; i++) {
    if (Number.isFinite(smoothed[i]) && smoothed[i] > 0) {
      xs.push(i);
      ys.push(Math.log(smoothed[i]));
    }
  }

  if (xs.length < 20) {
    return { score: 0, coefficient: 0, rSquared: 0, isDecaying: false };
  }

  const { slope, rSquared } = linearRegression(xs, ys);
  const isDecaying = slope < (config.range_decay_coeff_threshold || -0.02);

  let score = 0;
  if (isDecaying && rSquared > 0.3) {
    const magnitude = Math.abs(slope);
    const threshold = Math.abs(config.range_decay_coeff_threshold || -0.02);
    score = Math.min(1.0, magnitude / threshold) * Math.min(1.0, rSquared / 0.7);
  }

  return { score, coefficient: slope, rSquared, isDecaying };
}

function computeVwapDeviation(bars15m, consolIdx, config) {
  const flagBars = bars15m.slice(consolIdx);
  if (flagBars.length < 10) {
    return { score: 0, pctRank: 50 };
  }

  // Anchored VWAP from consolidation start
  let cumVP = 0, cumV = 0;
  const vwap = [];
  const deviations = [];
  for (let i = 0; i < flagBars.length; i++) {
    const b = flagBars[i];
    const typicalPrice = (b.high + b.low + b.close) / 3;
    cumVP += typicalPrice * b.volume;
    cumV += b.volume;
    const v = cumV > 0 ? cumVP / cumV : b.close;
    vwap.push(v);
    deviations.push(Math.abs(b.close - v));
  }

  const window = config.vwap_deviation_window || 52;
  const devStd = rollingStd(deviations, window);

  const validDevStds = devStd.filter(Number.isFinite);
  if (validDevStds.length < 10) {
    return { score: 0, pctRank: 50 };
  }

  const sorted = [...validDevStds].sort((a, b) => a - b);
  const current = validDevStds[validDevStds.length - 1];
  const pctRank = percentileRank(current, sorted);

  const score = Math.max(0, 1 - pctRank / 100);
  return { score, pctRank };
}

// =========================================================================
// EPISODE IDENTIFICATION
// =========================================================================

function findBullRunEpisodes(dailyBars, minGainPct = 40) {
  /**
   * Find all episodes where price rises significantly, then consolidates.
   * Returns array of { impulseStart, impulseEnd, consolStart, consolEnd, gainPct }
   */
  const episodes = [];
  const n = dailyBars.length;

  // Sliding window approach: find all significant rises
  for (let windowLen = 5; windowLen <= 60; windowLen += 1) {
    for (let i = 0; i <= n - windowLen; i++) {
      const end = i + windowLen - 1;
      // Find lowest low in window
      let lowIdx = i, lowPrice = dailyBars[i].low;
      for (let j = i; j <= end; j++) {
        if (dailyBars[j].low < lowPrice) {
          lowPrice = dailyBars[j].low;
          lowIdx = j;
        }
      }
      // Find highest high AFTER the low
      let highIdx = lowIdx, highPrice = dailyBars[lowIdx].high;
      for (let j = lowIdx; j <= end; j++) {
        if (dailyBars[j].high > highPrice) {
          highPrice = dailyBars[j].high;
          highIdx = j;
        }
      }

      if (highIdx <= lowIdx) continue;
      const gainPct = ((highPrice - lowPrice) / lowPrice) * 100;
      if (gainPct < minGainPct) continue;

      // Check for consolidation after the impulse
      // Look at the 5-30 trading days after the high
      const consolStart = highIdx + 1;
      if (consolStart >= n) continue;

      // Find consolidation end: where price breaks above impulse high or drops > 35%
      let consolEnd = Math.min(n - 1, consolStart + 60);
      let maxRetrace = 0;
      let consolValid = true;
      for (let j = consolStart; j <= Math.min(consolEnd, n - 1); j++) {
        const retrace = ((highPrice - dailyBars[j].low) / highPrice) * 100;
        maxRetrace = Math.max(maxRetrace, retrace);
        if (retrace > 50) { // Too deep
          consolEnd = j;
          consolValid = false;
          break;
        }
        if (dailyBars[j].close > highPrice * 1.05) { // Breakout
          consolEnd = j;
          break;
        }
      }

      const consolDays = consolEnd - consolStart;
      if (consolDays < 3) continue; // Too short

      episodes.push({
        lowIdx, highIdx, consolStart, consolEnd,
        lowPrice, highPrice, gainPct,
        consolDays, maxRetrace,
        lowDate: toDateStr(dailyBars[lowIdx].time),
        highDate: toDateStr(dailyBars[highIdx].time),
        consolStartDate: toDateStr(dailyBars[consolStart].time),
        consolEndDate: toDateStr(dailyBars[consolEnd].time),
      });
    }
  }

  // Deduplicate overlapping episodes — keep the best gain for each approximate period
  episodes.sort((a, b) => b.gainPct - a.gainPct);
  const used = new Set();
  const deduped = [];
  for (const ep of episodes) {
    // Check if this overlaps with an already-selected episode
    let overlaps = false;
    for (let d = ep.lowIdx; d <= ep.highIdx; d++) {
      if (used.has(d)) { overlaps = true; break; }
    }
    if (overlaps) continue;
    for (let d = ep.lowIdx; d <= ep.highIdx; d++) used.add(d);
    deduped.push(ep);
  }

  deduped.sort((a, b) => a.lowIdx - b.lowIdx);
  return deduped;
}

function toDateStr(unixSec) {
  return new Date(unixSec * 1000).toISOString().split('T')[0];
}

// =========================================================================
// HTF ANALYSIS PER EPISODE
// =========================================================================

function analyzeEpisode(episode, dailyBars, bars15m, bars1m, config) {
  const { lowIdx, highIdx, consolStart: consolStartDailyIdx } = episode;

  // Find impulse time range
  const impulseStartTime = dailyBars[lowIdx].time;
  const impulseEndTime = dailyBars[highIdx].time;
  const impulseHigh = episode.highPrice;

  // Find consolidation start in 15m bars
  const consolStartDailyTime = dailyBars[consolStartDailyIdx].time;
  let consolIdx15m = -1;
  for (let i = 0; i < bars15m.length; i++) {
    if (bars15m[i].time >= consolStartDailyTime) {
      consolIdx15m = i;
      break;
    }
  }
  if (consolIdx15m < 0) {
    return { error: 'Could not find consolidation start in 15m data' };
  }

  // Find consolidation end in 15m bars
  const consolEndDailyTime = dailyBars[Math.min(episode.consolEnd, dailyBars.length - 1)].time;
  let consolEndIdx15m = bars15m.length - 1;
  for (let i = consolIdx15m; i < bars15m.length; i++) {
    if (bars15m[i].time > consolEndDailyTime + 86400) {
      consolEndIdx15m = i;
      break;
    }
  }

  const flagBars15m = bars15m.slice(consolIdx15m, consolEndIdx15m);
  const flagBarsCount = flagBars15m.length;

  // 1. Yang-Zhang Volatility
  const yzWindow = config.yz_rolling_window || 104;
  const yzLookback = config.yz_percentile_lookback || 6552;
  const yzSeries = yangZhangVolatility(bars15m, yzWindow);
  const yzPctRanks = yzPercentileRank(yzSeries, yzLookback);

  // Get YZ percentile at end of consolidation
  const yzPctAtConsolEnd = yzPctRanks[consolEndIdx15m] || yzPctRanks[consolIdx15m + flagBarsCount - 1];
  const yzScore = Number.isFinite(yzPctAtConsolEnd) ? Math.max(0, 1 - yzPctAtConsolEnd / 100) : 0;

  // Also get YZ profile during entire consolidation
  const yzConsolValues = [];
  for (let i = consolIdx15m; i < consolEndIdx15m && i < yzPctRanks.length; i++) {
    if (Number.isFinite(yzPctRanks[i])) yzConsolValues.push(yzPctRanks[i]);
  }
  const yzMedian = yzConsolValues.length > 0
    ? yzConsolValues.sort((a, b) => a - b)[Math.floor(yzConsolValues.length / 2)]
    : NaN;

  // 2. Delta Compression
  const deltaResult = computeDeltaCompression(bars1m, consolStartDailyTime, config);

  // 3. Range Decay
  const rangeDecayResult = computeRangeDecay(bars15m, consolIdx15m, config);

  // 4. VWAP Deviation
  const vwapResult = computeVwapDeviation(bars15m, consolIdx15m, config);

  // 5. Composite Score
  const composite = (config.weight_yz || 0.30) * yzScore
    + (config.weight_delta || 0.25) * deltaResult.score
    + (config.weight_range_decay || 0.25) * rangeDecayResult.score
    + (config.weight_vwap || 0.20) * vwapResult.score;

  // 6. Additional metrics for research
  // Volume profile during consolidation
  const consolVolumes1m = bars1m.filter(b => b.time >= consolStartDailyTime && b.time <= consolEndDailyTime + 86400);
  const totalConsolVol = consolVolumes1m.reduce((s, b) => s + b.volume, 0);
  const avgConsolVol = consolVolumes1m.length > 0 ? totalConsolVol / consolVolumes1m.length : 0;

  // Pre-impulse volume for comparison
  const preImpulseStart = Math.max(0, impulseStartTime - 30 * 86400);
  const preImpulseVols = bars1m.filter(b => b.time >= preImpulseStart && b.time < impulseStartTime);
  const avgPreImpulseVol = preImpulseVols.length > 0
    ? preImpulseVols.reduce((s, b) => s + b.volume, 0) / preImpulseVols.length
    : 0;

  const volRatio = avgPreImpulseVol > 0 ? avgConsolVol / avgPreImpulseVol : NaN;

  // Price tightness: how tight is the consolidation range relative to impulse?
  let consolHighPrice = -Infinity, consolLowPrice = Infinity;
  for (const b of flagBars15m) {
    if (b.high > consolHighPrice) consolHighPrice = b.high;
    if (b.low < consolLowPrice) consolLowPrice = b.low;
  }
  const consolRangePct = ((consolHighPrice - consolLowPrice) / impulseHigh) * 100;

  // Retrace from high
  const actualRetrace = ((impulseHigh - consolLowPrice) / impulseHigh) * 100;

  // Range contraction: compare first half vs second half of consolidation
  const halfIdx = Math.floor(flagBars15m.length / 2);
  const firstHalf = flagBars15m.slice(0, halfIdx);
  const secondHalf = flagBars15m.slice(halfIdx);
  const firstHalfRange = firstHalf.length > 0
    ? firstHalf.reduce((s, b) => s + (b.high - b.low), 0) / firstHalf.length
    : 0;
  const secondHalfRange = secondHalf.length > 0
    ? secondHalf.reduce((s, b) => s + (b.high - b.low), 0) / secondHalf.length
    : 0;
  const rangeContractionRatio = firstHalfRange > 0 ? secondHalfRange / firstHalfRange : NaN;

  return {
    flagBarsCount,
    yz: {
      score: yzScore,
      pctRankAtEnd: yzPctAtConsolEnd,
      medianPctRank: yzMedian,
    },
    delta: {
      score: deltaResult.score,
      meanPctRank: deltaResult.meanPctRank,
      stdPctRank: deltaResult.stdPctRank,
    },
    rangeDecay: {
      score: rangeDecayResult.score,
      coefficient: rangeDecayResult.coefficient,
      rSquared: rangeDecayResult.rSquared,
      isDecaying: rangeDecayResult.isDecaying,
    },
    vwap: {
      score: vwapResult.score,
      pctRank: vwapResult.pctRank,
    },
    composite,
    detectedStrict: composite >= 0.70,
    detectedModerate: composite >= 0.55,
    volumeAnalysis: {
      avgConsolVol1m: Math.round(avgConsolVol),
      avgPreImpulseVol1m: Math.round(avgPreImpulseVol),
      volRatio: Number.isFinite(volRatio) ? volRatio.toFixed(3) : 'N/A',
    },
    priceAnalysis: {
      consolRangePct: consolRangePct.toFixed(2),
      actualRetracePct: actualRetrace.toFixed(2),
      rangeContractionRatio: Number.isFinite(rangeContractionRatio) ? rangeContractionRatio.toFixed(3) : 'N/A',
    }
  };
}

// =========================================================================
// MAIN
// =========================================================================

const HTF_CONFIG = {
  impulse_min_gain_pct: 80.0,
  impulse_lookback_days: 60,
  impulse_min_days: 3,
  impulse_max_days: 45,
  consolidation_range_shrink: 0.50,
  consolidation_min_bars_15m: 130,
  consolidation_max_bars_15m: 780,
  consolidation_max_retrace_pct: 25.0,
  yz_rolling_window: 104,
  yz_percentile_lookback: 6552,
  yz_contraction_threshold: 10.0,
  delta_hourly_window: 60,
  delta_compression_threshold: 0.80,
  range_decay_min_bars: 50,
  range_decay_coeff_threshold: -0.02,
  vwap_deviation_window: 52,
  vwap_deviation_percentile: 20.0,
  weight_yz: 0.30,
  weight_delta: 0.25,
  weight_range_decay: 0.25,
  weight_vwap: 0.20,
  composite_threshold: 0.70,
  breakout_range_multiple: 2.0,
  breakout_delta_surge_percentile: 90.0,
};

const HTF_CONFIG_MODERATE = {
  ...HTF_CONFIG,
  impulse_min_gain_pct: 50.0,
  impulse_lookback_days: 90,
  consolidation_range_shrink: 0.60,
  consolidation_min_bars_15m: 78,
  consolidation_max_retrace_pct: 35.0,
  range_decay_coeff_threshold: -0.01,
  vwap_deviation_percentile: 30.0,
  composite_threshold: 0.55,
};

async function analyzeSymbol(symbol) {
  const fromDate = '2024-03-01';
  const toDate = '2026-02-14';

  console.log(`\n${'='.repeat(80)}`);
  console.log(`ANALYZING ${symbol}: ${fromDate} to ${toDate}`);
  console.log(`${'='.repeat(80)}`);

  // Fetch data
  const daily = await fetchDailyBars(symbol, fromDate, toDate);
  console.log(`  Got ${daily.length} daily bars`);

  const bars15m = await fetch15mBars(symbol, fromDate, toDate);
  console.log(`  Got ${bars15m.length} 15m bars`);

  const bars1m = await fetch1mBars(symbol, fromDate, toDate);
  console.log(`  Got ${bars1m.length} 1m bars`);

  if (daily.length === 0) {
    console.log(`  No daily data available — skipping`);
    return;
  }

  // Print daily price summary
  console.log(`\n  Daily price range: $${daily[0].close.toFixed(2)} (${toDateStr(daily[0].time)}) → $${daily[daily.length - 1].close.toFixed(2)} (${toDateStr(daily[daily.length - 1].time)})`);
  let allTimeHigh = 0, allTimeLow = Infinity;
  for (const b of daily) {
    if (b.high > allTimeHigh) allTimeHigh = b.high;
    if (b.low < allTimeLow) allTimeLow = b.low;
  }
  console.log(`  Range: $${allTimeLow.toFixed(2)} — $${allTimeHigh.toFixed(2)}`);

  // Find episodes
  console.log(`\n  Finding bull-run + consolidation episodes (min 40% gain)...`);
  const episodes = findBullRunEpisodes(daily, 40);
  console.log(`  Found ${episodes.length} episodes\n`);

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  EPISODE ${i + 1}: ${ep.lowDate} → ${ep.highDate} (impulse) → ${ep.consolEndDate} (consol end)`);
    console.log(`    Impulse: $${ep.lowPrice.toFixed(2)} → $${ep.highPrice.toFixed(2)} (+${ep.gainPct.toFixed(1)}%)`);
    console.log(`    Consolidation: ${ep.consolDays} trading days, max retrace ${ep.maxRetrace.toFixed(1)}%`);

    // Run analysis with STRICT config
    const strictResult = analyzeEpisode(ep, daily, bars15m, bars1m, HTF_CONFIG);
    // Run analysis with MODERATE config
    const modResult = analyzeEpisode(ep, daily, bars15m, bars1m, HTF_CONFIG_MODERATE);

    if (strictResult.error) {
      console.log(`    ⚠ ${strictResult.error}`);
      continue;
    }

    console.log(`\n    STRICT MODE (composite threshold: 0.70):`);
    console.log(`      YZ Score:       ${strictResult.yz.score.toFixed(4)}  (pctRank: ${strictResult.yz.pctRankAtEnd?.toFixed(1) || 'N/A'}, median: ${strictResult.yz.medianPctRank?.toFixed(1) || 'N/A'})`);
    console.log(`      Delta Score:    ${strictResult.delta.score.toFixed(4)}  (meanPctRank: ${strictResult.delta.meanPctRank.toFixed(1)}, stdPctRank: ${strictResult.delta.stdPctRank.toFixed(1)})`);
    console.log(`      RangeDecay:     ${strictResult.rangeDecay.score.toFixed(4)}  (coeff: ${strictResult.rangeDecay.coefficient.toFixed(6)}, R²: ${strictResult.rangeDecay.rSquared.toFixed(4)}, decaying: ${strictResult.rangeDecay.isDecaying})`);
    console.log(`      VWAP Score:     ${strictResult.vwap.score.toFixed(4)}  (pctRank: ${strictResult.vwap.pctRank.toFixed(1)})`);
    console.log(`      COMPOSITE:      ${strictResult.composite.toFixed(4)}  → ${strictResult.detectedStrict ? '✅ DETECTED' : '❌ NOT DETECTED'}`);

    console.log(`\n    MODERATE MODE (composite threshold: 0.55):`);
    console.log(`      YZ Score:       ${modResult.yz.score.toFixed(4)}  (pctRank: ${modResult.yz.pctRankAtEnd?.toFixed(1) || 'N/A'}, median: ${modResult.yz.medianPctRank?.toFixed(1) || 'N/A'})`);
    console.log(`      Delta Score:    ${modResult.delta.score.toFixed(4)}  (meanPctRank: ${modResult.delta.meanPctRank.toFixed(1)}, stdPctRank: ${modResult.delta.stdPctRank.toFixed(1)})`);
    console.log(`      RangeDecay:     ${modResult.rangeDecay.score.toFixed(4)}  (coeff: ${modResult.rangeDecay.coefficient.toFixed(6)}, R²: ${modResult.rangeDecay.rSquared.toFixed(4)}, decaying: ${modResult.rangeDecay.isDecaying})`);
    console.log(`      VWAP Score:     ${modResult.vwap.score.toFixed(4)}  (pctRank: ${modResult.vwap.pctRank.toFixed(1)})`);
    console.log(`      COMPOSITE:      ${modResult.composite.toFixed(4)}  → ${modResult.detectedModerate ? '✅ DETECTED' : '❌ NOT DETECTED'}`);

    console.log(`\n    ADDITIONAL METRICS:`);
    console.log(`      Flag bars (15m): ${strictResult.flagBarsCount}`);
    console.log(`      Consol avg 1m vol:     ${strictResult.volumeAnalysis.avgConsolVol1m.toLocaleString()}`);
    console.log(`      Pre-impulse avg 1m vol: ${strictResult.volumeAnalysis.avgPreImpulseVol1m.toLocaleString()}`);
    console.log(`      Volume ratio (consol/pre): ${strictResult.volumeAnalysis.volRatio}`);
    console.log(`      Consol range pct:      ${strictResult.priceAnalysis.consolRangePct}%`);
    console.log(`      Actual retrace pct:    ${strictResult.priceAnalysis.actualRetracePct}%`);
    console.log(`      Range contraction (2nd/1st half): ${strictResult.priceAnalysis.rangeContractionRatio}`);
  }

  return { symbol, daily, bars15m, bars1m, episodes };
}

async function main() {
  console.log('HTF Pattern Analysis for RKLB and ASTS');
  console.log(`Date range: 2024-03-01 to 2026-02-14`);
  console.log(`Using Massive API with chunked fetching\n`);

  const results = {};
  for (const symbol of ['RKLB', 'ASTS']) {
    try {
      results[symbol] = await analyzeSymbol(symbol);
    } catch (err) {
      console.error(`\nFailed to analyze ${symbol}: ${err.message}`);
      console.error(err.stack);
    }
  }

  // Cross-ticker summary
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('CROSS-TICKER SUMMARY');
  console.log(`${'='.repeat(80)}`);

  for (const [sym, data] of Object.entries(results)) {
    if (!data?.episodes) continue;
    const total = data.episodes.length;
    // Re-analyze to count detections
    let strictDetected = 0, modDetected = 0;
    for (const ep of data.episodes) {
      const strict = analyzeEpisode(ep, data.daily, data.bars15m, data.bars1m, HTF_CONFIG);
      const mod = analyzeEpisode(ep, data.daily, data.bars15m, data.bars1m, HTF_CONFIG_MODERATE);
      if (!strict.error && strict.detectedStrict) strictDetected++;
      if (!mod.error && mod.detectedModerate) modDetected++;
    }
    console.log(`\n  ${sym}: ${total} episodes found`);
    console.log(`    Strict detection: ${strictDetected}/${total} (${((strictDetected/total)*100).toFixed(0)}%)`);
    console.log(`    Moderate detection: ${modDetected}/${total} (${((modDetected/total)*100).toFixed(0)}%)`);
  }

  // Aggregate metric analysis: what scores are most commonly failing?
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('METRIC FAILURE ANALYSIS (Which metrics block detection?)');
  console.log(`${'='.repeat(80)}`);

  for (const [sym, data] of Object.entries(results)) {
    if (!data?.episodes) continue;
    console.log(`\n  ${sym}:`);
    const allStrict = [], allMod = [];
    for (const ep of data.episodes) {
      const strict = analyzeEpisode(ep, data.daily, data.bars15m, data.bars1m, HTF_CONFIG);
      const mod = analyzeEpisode(ep, data.daily, data.bars15m, data.bars1m, HTF_CONFIG_MODERATE);
      if (!strict.error) allStrict.push(strict);
      if (!mod.error) allMod.push(mod);
    }

    if (allMod.length > 0) {
      const avgYZ = allMod.reduce((s, r) => s + r.yz.score, 0) / allMod.length;
      const avgDelta = allMod.reduce((s, r) => s + r.delta.score, 0) / allMod.length;
      const avgDecay = allMod.reduce((s, r) => s + r.rangeDecay.score, 0) / allMod.length;
      const avgVwap = allMod.reduce((s, r) => s + r.vwap.score, 0) / allMod.length;

      console.log(`    Average scores across ${allMod.length} episodes (moderate config):`);
      console.log(`      YZ:         ${avgYZ.toFixed(4)}  (weight: 0.30, contribution: ${(avgYZ * 0.30).toFixed(4)})`);
      console.log(`      Delta:      ${avgDelta.toFixed(4)}  (weight: 0.25, contribution: ${(avgDelta * 0.25).toFixed(4)})`);
      console.log(`      RangeDecay: ${avgDecay.toFixed(4)}  (weight: 0.25, contribution: ${(avgDecay * 0.25).toFixed(4)})`);
      console.log(`      VWAP:       ${avgVwap.toFixed(4)}  (weight: 0.20, contribution: ${(avgVwap * 0.20).toFixed(4)})`);
      console.log(`      Avg Composite: ${(avgYZ * 0.30 + avgDelta * 0.25 + avgDecay * 0.25 + avgVwap * 0.20).toFixed(4)}`);

      // Find which metrics are < 0.5 most often
      const lowYZ = allMod.filter(r => r.yz.score < 0.5).length;
      const lowDelta = allMod.filter(r => r.delta.score < 0.5).length;
      const lowDecay = allMod.filter(r => r.rangeDecay.score < 0.5).length;
      const lowVwap = allMod.filter(r => r.vwap.score < 0.5).length;
      console.log(`\n    Metrics scoring < 0.5 (blocking detection):`);
      console.log(`      YZ < 0.5:         ${lowYZ}/${allMod.length} episodes`);
      console.log(`      Delta < 0.5:      ${lowDelta}/${allMod.length} episodes`);
      console.log(`      RangeDecay < 0.5: ${lowDecay}/${allMod.length} episodes`);
      console.log(`      VWAP < 0.5:       ${lowVwap}/${allMod.length} episodes`);

      // Range decay deep-dive
      const decayCoeffs = allMod.map(r => r.rangeDecay.coefficient);
      const decayR2s = allMod.map(r => r.rangeDecay.rSquared);
      console.log(`\n    Range Decay deep-dive:`);
      console.log(`      Coefficients: ${decayCoeffs.map(c => c.toFixed(6)).join(', ')}`);
      console.log(`      R² values:    ${decayR2s.map(r => r.toFixed(4)).join(', ')}`);

      // Volume ratio analysis
      const volRatios = allMod.map(r => r.volumeAnalysis.volRatio);
      console.log(`\n    Volume ratios (consol/pre-impulse): ${volRatios.join(', ')}`);

      // Range contraction analysis
      const rangeContractions = allMod.map(r => r.priceAnalysis.rangeContractionRatio);
      console.log(`    Range contraction (2nd/1st half): ${rangeContractions.join(', ')}`);
    }
  }

  console.log(`\n\nAnalysis complete.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

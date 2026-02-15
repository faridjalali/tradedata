/**
 * High Tight Flag (HTF) Detector
 * ===============================
 * Ported from htf_detector.py — fully automated detection using:
 * 1. Yang-Zhang Volatility Percentile Rank (15-min bars)
 * 2. Volume Delta Compression (1-min bars)
 * 3. Range Decay Rate (15-min bars, log-linear fit)
 * 4. Anchored VWAP Deviation Collapse (15-min bars)
 *
 * Data strategy: fetch daily, 15-min, and 1-min bars at native intervals
 * (avoids resampling huge 1-min datasets).
 */

"use strict";

// =============================================================================
// CONFIGURATION
// =============================================================================

const HTF_CONFIG = {
  // Impulse Qualification (Daily)
  impulse_min_gain_pct: 80.0,
  impulse_lookback_days: 60,
  impulse_min_days: 3,
  impulse_max_days: 45,

  // Consolidation Detection
  consolidation_range_shrink: 0.50,
  consolidation_min_bars_15m: 130,   // ~5 trading days
  consolidation_max_bars_15m: 780,   // ~30 trading days
  consolidation_max_retrace_pct: 25.0,

  // Yang-Zhang Volatility
  yz_rolling_window: 104,            // ~4 trading days of 15m bars
  yz_percentile_lookback: 6552,      // ~252 trading days of 15m bars
  yz_contraction_threshold: 10.0,

  // Volume Delta Compression
  delta_hourly_window: 60,
  delta_compression_threshold: 0.80,

  // Range Decay
  range_decay_min_bars: 50,
  range_decay_coeff_threshold: -0.02,

  // VWAP Deviation
  vwap_deviation_window: 52,         // ~2 trading days
  vwap_deviation_percentile: 20.0,

  // Composite Score
  weight_yz: 0.30,
  weight_delta: 0.25,
  weight_range_decay: 0.25,
  weight_vwap: 0.20,
  composite_threshold: 0.70,

  // Breakout Detection
  breakout_range_multiple: 2.0,
  breakout_delta_surge_percentile: 90.0,
};

// =============================================================================
// MATH HELPERS
// =============================================================================

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

function rollingVariance(arr, window) {
  const out = new Array(arr.length).fill(NaN);
  if (window < 2) return out;
  for (let i = window - 1; i < arr.length; i++) {
    let sum = 0, sumSq = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += arr[j];
      sumSq += arr[j] * arr[j];
    }
    const mean = sum / window;
    out[i] = (sumSq / window) - (mean * mean);
    // Bessel's correction for sample variance
    out[i] = out[i] * window / (window - 1);
  }
  return out;
}

function rollingStd(arr, window) {
  return rollingVariance(arr, window).map(v => isNaN(v) ? NaN : Math.sqrt(Math.max(0, v)));
}

function rollingSkew(arr, window) {
  const out = new Array(arr.length).fill(NaN);
  if (window < 3) return out;
  for (let i = window - 1; i < arr.length; i++) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += arr[j];
    const mean = sum / window;
    let m2 = 0, m3 = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const d = arr[j] - mean;
      m2 += d * d;
      m3 += d * d * d;
    }
    m2 /= window;
    m3 /= window;
    const std = Math.sqrt(m2);
    if (std < 1e-15) { out[i] = 0; continue; }
    // Adjusted Fisher-Pearson skewness
    out[i] = (m3 / (std * std * std)) * (window * window) / ((window - 1) * (window - 2) || 1);
  }
  return out;
}

function rollingMeanForSeries(arr, window, minPeriods) {
  minPeriods = minPeriods || window;
  const out = new Array(arr.length).fill(NaN);
  let sum = 0, count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (isFinite(arr[i])) { sum += arr[i]; count++; }
    if (i >= window) {
      if (isFinite(arr[i - window])) { sum -= arr[i - window]; count--; }
    }
    if (count >= minPeriods) out[i] = sum / count;
  }
  return out;
}

function linearRegression(x, y) {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i]; sumXY += x[i] * y[i]; sumX2 += x[i] * x[i];
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-15) return { slope: 0, intercept: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function rSquared(actual, predicted) {
  const n = actual.length;
  let sumActual = 0;
  for (let i = 0; i < n; i++) sumActual += actual[i];
  const mean = sumActual / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (actual[i] - mean) * (actual[i] - mean);
    ssRes += (actual[i] - predicted[i]) * (actual[i] - predicted[i]);
  }
  return ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
}

// =============================================================================
// DATA PREPARATION
// =============================================================================

/**
 * Compute per-bar delta proxy from OHLCV: delta = volume * sign(close - open)
 */
function addDeltaToBar(bar) {
  const o = Number(bar.open), c = Number(bar.close), v = Number(bar.volume);
  if (!isFinite(o) || !isFinite(c) || !isFinite(v)) return 0;
  if (c > o) return v;
  if (c < o) return -v;
  return 0;
}

/**
 * Bars are expected as [{time, open, high, low, close, volume}, ...] sorted by time ascending.
 * Daily bars have time as unix seconds (start of day).
 * 15-min bars have time as unix seconds (start of 15-min window).
 * 1-min bars have time as unix seconds (start of 1-min window).
 */

// =============================================================================
// STEP 1: IMPULSE MOVE DETECTION (Daily)
// =============================================================================

function findImpulseMove(dailyBars, config) {
  if (dailyBars.length < config.impulse_lookback_days) return null;

  const minFlagDays = Math.max(5, Math.floor(config.consolidation_min_bars_15m / 26));
  const recent = dailyBars.slice(-config.impulse_lookback_days);
  const maxEndIdx = recent.length - minFlagDays;

  if (maxEndIdx <= config.impulse_min_days) return null;

  let bestImpulse = null;
  let bestGain = 0;

  const loopStart = Math.max(0, maxEndIdx - config.impulse_max_days);
  for (let startIdx = loopStart; startIdx < maxEndIdx; startIdx++) {
    const startPrice = Number(recent[startIdx].low);
    const startTime = Number(recent[startIdx].time);

    const endLimit = Math.min(startIdx + config.impulse_max_days + 1, maxEndIdx);
    for (let endIdx = startIdx + config.impulse_min_days; endIdx < endLimit; endIdx++) {
      const endPrice = Number(recent[endIdx].high);
      const endTime = Number(recent[endIdx].time);
      const gainPct = ((endPrice - startPrice) / startPrice) * 100;

      if (gainPct >= config.impulse_min_gain_pct && gainPct > bestGain) {
        bestGain = gainPct;
        bestImpulse = {
          start_time: startTime,
          end_time: endTime,
          start_price: startPrice,
          end_price: endPrice,
          gain_pct: gainPct,
        };
      }
    }
  }
  return bestImpulse;
}

// =============================================================================
// STEP 2: CONSOLIDATION ANCHOR DETECTION (15-min)
// =============================================================================

function findConsolidationStart(bars15m, impulse, config) {
  // Find impulse bars in 15m data
  const impulseBarIndices = [];
  for (let i = 0; i < bars15m.length; i++) {
    const t = Number(bars15m[i].time);
    if (t >= impulse.start_time && t <= impulse.end_time) {
      impulseBarIndices.push(i);
    }
  }
  if (impulseBarIndices.length < 10) return null;

  // Compute median percentage range of impulse bars
  const impulsePctRanges = impulseBarIndices.map(i => {
    const b = bars15m[i];
    const c = Number(b.close);
    return c > 0 ? (Number(b.high) - Number(b.low)) / c : 0;
  });
  impulsePctRanges.sort((a, b) => a - b);
  const medianImpulsePct = impulsePctRanges[Math.floor(impulsePctRanges.length / 2)];
  const threshold = medianImpulsePct * config.consolidation_range_shrink;

  // Post-impulse bars
  let postStart = -1;
  for (let i = 0; i < bars15m.length; i++) {
    if (Number(bars15m[i].time) > impulse.end_time) { postStart = i; break; }
  }
  if (postStart < 0 || bars15m.length - postStart < 26) return null;

  // Compute percentage ranges of post-impulse bars
  const postPctRanges = [];
  for (let i = postStart; i < bars15m.length; i++) {
    const b = bars15m[i];
    const c = Number(b.close);
    postPctRanges.push(c > 0 ? (Number(b.high) - Number(b.low)) / c : 0);
  }

  // Rolling 26-bar mean of percentage ranges
  const rollingPct = rollingMean(postPctRanges, 26);

  // Find first bar where rolling pct < threshold
  let consolOffset = -1;
  for (let i = 0; i < rollingPct.length; i++) {
    if (isFinite(rollingPct[i]) && rollingPct[i] < threshold) {
      consolOffset = i;
      break;
    }
  }
  if (consolOffset < 0) return null;

  const consolStartIdx = postStart + consolOffset;
  const consolStartTime = Number(bars15m[consolStartIdx].time);

  // Validate retrace
  const impulseHigh = impulse.end_price;
  let postLow = Infinity;
  for (let i = postStart; i <= consolStartIdx; i++) {
    const low = Number(bars15m[i].low);
    if (low < postLow) postLow = low;
  }
  const retracePct = ((impulseHigh - postLow) / impulseHigh) * 100;
  if (retracePct > config.consolidation_max_retrace_pct) return null;

  return consolStartIdx;
}

// =============================================================================
// METRIC 1: YANG-ZHANG VOLATILITY
// =============================================================================

function yangZhangVolatility(bars15m, window) {
  const n = bars15m.length;
  const logOC = new Array(n).fill(NaN);
  const logCO = new Array(n).fill(NaN);
  const rs = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const o = Number(bars15m[i].open);
    const h = Number(bars15m[i].high);
    const l = Number(bars15m[i].low);
    const c = Number(bars15m[i].close);
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;

    logOC[i] = Math.log(c / o);

    if (i > 0) {
      const prevC = Number(bars15m[i - 1].close);
      if (prevC > 0) logCO[i] = Math.log(o / prevC);
    }

    const logHO = Math.log(h / o);
    const logLO = Math.log(l / o);
    const logHC = Math.log(h / c);
    const logLC = Math.log(l / c);
    rs[i] = logHO * logHC + logLO * logLC;
  }

  const overnightVar = rollingVariance(logCO, window);
  const ocVar = rollingVariance(logOC, window);
  const rsMean = rollingMean(rs, window);

  const k = 0.34 / (1.34 + (window + 1) / (window - 1));
  const yzVol = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (isNaN(overnightVar[i]) || isNaN(ocVar[i]) || isNaN(rsMean[i])) continue;
    const variance = overnightVar[i] + k * ocVar[i] + (1 - k) * rsMean[i];
    yzVol[i] = Math.sqrt(Math.max(0, variance));
  }
  return yzVol;
}

function yzPercentileRank(yzSeries, lookback) {
  const out = new Array(yzSeries.length).fill(NaN);
  const minPeriods = 100;
  for (let i = 0; i < yzSeries.length; i++) {
    const current = yzSeries[i];
    if (isNaN(current)) continue;
    const windowStart = Math.max(0, i - lookback);
    let count = 0, below = 0;
    for (let j = windowStart; j < i; j++) {
      if (!isNaN(yzSeries[j])) {
        count++;
        if (yzSeries[j] < current) below++;
      }
    }
    if (count >= minPeriods) {
      out[i] = (below / count) * 100;
    }
  }
  return out;
}

// =============================================================================
// METRIC 2: VOLUME DELTA COMPRESSION
// =============================================================================

function computeDeltaCompression(bars1m, consolidationStartTime, config) {
  const result = {
    delta_mean_pctrank: NaN,
    delta_std_pctrank: NaN,
    delta_skew: NaN,
    compression_score: 0,
  };

  // Find bars from consolidation start onwards
  let flagStart = -1;
  for (let i = 0; i < bars1m.length; i++) {
    if (Number(bars1m[i].time) >= consolidationStartTime) { flagStart = i; break; }
  }
  if (flagStart < 0) return result;
  if (bars1m.length - flagStart < config.delta_hourly_window * 2) return result;

  // Compute delta for all 1-min bars
  const fullDelta = bars1m.map(b => addDeltaToBar(b));
  const w = config.delta_hourly_window;

  const rollMean = rollingMean(fullDelta, w);
  const rollStd = rollingStd(fullDelta, w);
  const rollSkew = rollingSkew(fullDelta, w);

  // Absolute mean
  const absMean = rollMean.map(v => Math.abs(v));

  // Context window: ~20 trading days of 1-min bars
  const contextLen = 7800;
  const startCtx = Math.max(0, absMean.length - contextLen);
  const recentAbsMean = absMean.slice(startCtx);
  const recentStd = rollStd.slice(startCtx);

  const currentAbsMean = absMean[absMean.length - 1];
  const currentStd = rollStd[rollStd.length - 1];
  const currentSkew = rollSkew[rollSkew.length - 1];

  if (!isFinite(currentAbsMean) || !isFinite(currentStd)) return result;

  // Percentile rank of current values against recent context
  let meanBelow = 0, meanTotal = 0;
  for (let i = 0; i < recentAbsMean.length; i++) {
    if (isFinite(recentAbsMean[i])) {
      meanTotal++;
      if (recentAbsMean[i] < currentAbsMean) meanBelow++;
    }
  }
  const meanPctRank = meanTotal > 0 ? (meanBelow / meanTotal) * 100 : 50;

  let stdBelow = 0, stdTotal = 0;
  for (let i = 0; i < recentStd.length; i++) {
    if (isFinite(recentStd[i])) {
      stdTotal++;
      if (recentStd[i] < currentStd) stdBelow++;
    }
  }
  const stdPctRank = stdTotal > 0 ? (stdBelow / stdTotal) * 100 : 50;

  const compressionScore = (1 - meanPctRank / 100) * (1 - stdPctRank / 100);

  result.delta_mean_pctrank = meanPctRank;
  result.delta_std_pctrank = stdPctRank;
  result.delta_skew = isFinite(currentSkew) ? currentSkew : 0;
  result.compression_score = Math.max(0, Math.min(1, compressionScore));
  return result;
}

// =============================================================================
// METRIC 3: RANGE DECAY RATE
// =============================================================================

function computeRangeDecay(bars15m, consolIdx, config) {
  const result = { decay_coefficient: 0, r_squared: 0, is_decaying: false };

  const flagBars = bars15m.slice(consolIdx);
  if (flagBars.length < config.range_decay_min_bars) return result;

  // Percentage ranges for price-level independence
  const barRanges = flagBars.map(b => {
    const c = Number(b.close);
    return c > 0 ? (Number(b.high) - Number(b.low)) / c : 0;
  });

  let smoothWindow = Math.min(26, Math.floor(barRanges.length / 3));
  if (smoothWindow < 5) smoothWindow = 5;

  const smoothed = rollingMean(barRanges, smoothWindow);

  // Filter to only valid (non-NaN) values
  const validSmoothed = [];
  for (let i = 0; i < smoothed.length; i++) {
    if (isFinite(smoothed[i]) && smoothed[i] > 0) {
      validSmoothed.push(smoothed[i]);
    }
  }

  if (validSmoothed.length < 20) return result;

  // Log-linear regression (equivalent to fitting y = A * exp(B * x))
  const x = [];
  const logY = [];
  for (let i = 0; i < validSmoothed.length; i++) {
    x.push(i);
    logY.push(Math.log(validSmoothed[i] + 1e-10));
  }

  const fit = linearRegression(x, logY);
  const decayCoeff = fit.slope;

  // Compute R-squared on the original (non-log) scale
  const predicted = x.map(xi => Math.exp(fit.intercept + fit.slope * xi));
  const rSq = rSquared(validSmoothed, predicted);

  result.decay_coefficient = decayCoeff;
  result.r_squared = rSq;
  result.is_decaying = decayCoeff < config.range_decay_coeff_threshold;
  return result;
}

// =============================================================================
// METRIC 4: ANCHORED VWAP DEVIATION
// =============================================================================

function computeVwapDeviation(bars15m, consolIdx, config) {
  const result = { current_deviation_pctrank: 50, vwap_price: NaN, is_collapsed: false };

  const flagBars = bars15m.slice(consolIdx);
  if (flagBars.length < config.vwap_deviation_window) return result;

  // Cumulative volume and volume*price
  let cumVol = 0, cumVP = 0;
  const vwap = new Array(flagBars.length).fill(NaN);
  const deviation = new Array(flagBars.length).fill(NaN);

  for (let i = 0; i < flagBars.length; i++) {
    const c = Number(flagBars[i].close);
    const v = Number(flagBars[i].volume);
    if (!isFinite(c) || !isFinite(v)) continue;
    cumVol += v;
    cumVP += c * v;
    vwap[i] = cumVol > 0 ? cumVP / cumVol : NaN;
    deviation[i] = isFinite(vwap[i]) ? Math.abs(c - vwap[i]) : NaN;
  }

  // Rolling std of deviation
  const rollingDevStd = rollingStd(deviation, config.vwap_deviation_window);

  // Get valid values
  const validDevStd = [];
  for (let i = 0; i < rollingDevStd.length; i++) {
    if (isFinite(rollingDevStd[i])) validDevStd.push(rollingDevStd[i]);
  }
  if (validDevStd.length === 0) return result;

  const currentDev = rollingDevStd[rollingDevStd.length - 1];
  // Walk backwards to find last valid
  let lastValidDev = NaN;
  for (let i = rollingDevStd.length - 1; i >= 0; i--) {
    if (isFinite(rollingDevStd[i])) { lastValidDev = rollingDevStd[i]; break; }
  }
  if (!isFinite(lastValidDev)) return result;

  let below = 0;
  for (let i = 0; i < validDevStd.length; i++) {
    if (validDevStd[i] < lastValidDev) below++;
  }
  const pctRank = (below / validDevStd.length) * 100;

  // Last valid VWAP
  let lastVwap = NaN;
  for (let i = vwap.length - 1; i >= 0; i--) {
    if (isFinite(vwap[i])) { lastVwap = vwap[i]; break; }
  }

  result.current_deviation_pctrank = pctRank;
  result.vwap_price = lastVwap;
  result.is_collapsed = pctRank < config.vwap_deviation_percentile;
  return result;
}

// =============================================================================
// COMPOSITE SCORING
// =============================================================================

function computeCompositeScore(yzPctRank, deltaCompression, rangeDecay, vwapDeviation, config) {
  const yzScore = Math.max(0, 1 - (yzPctRank / 100));
  const deltaScore = deltaCompression;

  let decayScore = 0;
  if (rangeDecay.is_decaying && rangeDecay.r_squared > 0.3) {
    const decayMagnitude = Math.abs(rangeDecay.decay_coefficient);
    decayScore = Math.min(1.0, decayMagnitude / Math.abs(config.range_decay_coeff_threshold));
    decayScore *= Math.min(1.0, rangeDecay.r_squared / 0.7);
  }

  const vwapScore = Math.max(0, 1 - (vwapDeviation.current_deviation_pctrank / 100));

  const composite =
    config.weight_yz * yzScore +
    config.weight_delta * deltaScore +
    config.weight_range_decay * decayScore +
    config.weight_vwap * vwapScore;

  return {
    composite_score: Math.max(0, Math.min(1, composite)),
    yz_score: yzScore,
    delta_score: deltaScore,
    decay_score: decayScore,
    vwap_score: vwapScore,
    is_htf_detected: composite >= config.composite_threshold,
  };
}

// =============================================================================
// BREAKOUT DETECTION
// =============================================================================

function detectBreakout(bars15m, bars1m, consolIdx, impulseHigh, config) {
  const result = { breakout_detected: false, reason: 'Insufficient flag data' };

  const flag15m = bars15m.slice(consolIdx);
  if (flag15m.length < 20) return result;

  // Average compressed range from recent 130 bars (or whatever is available)
  const recentLen = Math.min(130, flag15m.length);
  let rangeSum = 0;
  for (let i = flag15m.length - recentLen; i < flag15m.length; i++) {
    rangeSum += Number(flag15m[i].high) - Number(flag15m[i].low);
  }
  const avgCompressedRange = rangeSum / recentLen;

  const latest = flag15m[flag15m.length - 1];
  const latestRange = Number(latest.high) - Number(latest.low);
  const rangeExpanded = latestRange > (config.breakout_range_multiple * avgCompressedRange);

  const flagHigh = Math.max(...flag15m.map(b => Number(b.high)));
  const priceClearing = Number(latest.close) > flagHigh;

  // Check delta surge in last 15 minutes from 1-min bars
  const latestTime = Number(latest.time);
  const windowStart = latestTime - 15 * 60;
  let currentDeltaSum = 0;
  for (const bar of bars1m) {
    const t = Number(bar.time);
    if (t >= windowStart && t <= latestTime) {
      currentDeltaSum += addDeltaToBar(bar);
    }
  }

  // Historical 15-bar rolling delta sums from 1-min data
  const fullDeltas = bars1m.map(b => addDeltaToBar(b));
  const rollingDeltaSum = rollingMean(fullDeltas, 15).map(v => v * 15); // sum = mean * window
  const validRolling = rollingDeltaSum.filter(v => isFinite(v));
  let deltaBelow = 0;
  for (const v of validRolling) {
    if (v < currentDeltaSum) deltaBelow++;
  }
  const deltaPercentile = validRolling.length > 0 ? (deltaBelow / validRolling.length) * 100 : 0;
  const deltaSurging = deltaPercentile > config.breakout_delta_surge_percentile;

  return {
    breakout_detected: rangeExpanded && deltaSurging,
    price_clearing_flag_high: priceClearing,
    price_clearing_impulse_high: Number(latest.close) > impulseHigh,
    range_expansion_ratio: avgCompressedRange > 0 ? latestRange / avgCompressedRange : 0,
    delta_percentile: deltaPercentile,
    flag_high: flagHigh,
    impulse_high: impulseHigh,
  };
}

// =============================================================================
// MAIN DETECTOR
// =============================================================================

/**
 * Run HTF detection on a ticker.
 *
 * @param {string} ticker
 * @param {object} options
 * @param {function} options.dataApiFetcher - async (symbol, interval, lookbackDays, opts) => bars[]
 * @param {AbortSignal|null} options.signal
 * @returns {Promise<object>} HTF result
 */
async function detectHTF(ticker, options) {
  const { dataApiFetcher, signal } = options;
  const config = HTF_CONFIG;
  const result = {
    ticker,
    is_detected: false,
    is_candidate: false,
    composite_score: 0,
    status: '',
    impulse_gain_pct: null,
    impulse: null,
    consolidation_bars: 0,
    flag_retrace_pct: null,
    yz_percentile: null,
    delta_metrics: null,
    range_decay: null,
    vwap_deviation: null,
    composite: null,
    breakout: null,
  };

  try {
    // Fetch data at native intervals (parallel)
    const fetchOpts = signal ? { signal } : {};
    const [dailyBars, bars15m, bars1m] = await Promise.all([
      dataApiFetcher(ticker, '1day', 365, fetchOpts),
      dataApiFetcher(ticker, '15min', 365, fetchOpts),
      dataApiFetcher(ticker, '1min', 30, fetchOpts),
    ]);

    if (!Array.isArray(dailyBars) || dailyBars.length < config.impulse_lookback_days) {
      result.status = `Insufficient daily data: ${dailyBars ? dailyBars.length : 0} bars (need ${config.impulse_lookback_days})`;
      return result;
    }
    if (!Array.isArray(bars15m) || bars15m.length < 100) {
      result.status = `Insufficient 15m data: ${bars15m ? bars15m.length : 0} bars`;
      return result;
    }

    // Step 1: Impulse move
    const impulse = findImpulseMove(dailyBars, config);
    if (!impulse) {
      result.status = `No impulse >= ${config.impulse_min_gain_pct}% in last ${config.impulse_lookback_days} days`;
      return result;
    }
    result.impulse = impulse;
    result.impulse_gain_pct = impulse.gain_pct;

    // Step 2: Consolidation anchor
    const consolIdx = findConsolidationStart(bars15m, impulse, config);
    if (consolIdx === null) {
      result.status = 'No valid consolidation detected after impulse';
      return result;
    }

    const consolBars = bars15m.length - consolIdx;
    result.consolidation_bars = consolBars;

    if (consolBars < config.consolidation_min_bars_15m) {
      result.status = `Consolidation too short: ${consolBars} bars (need ${config.consolidation_min_bars_15m})`;
      return result;
    }
    if (consolBars > config.consolidation_max_bars_15m) {
      result.status = `Consolidation too long: ${consolBars} bars (max ${config.consolidation_max_bars_15m})`;
      return result;
    }

    // Validate retrace
    const flagBars = bars15m.slice(consolIdx);
    let flagLow = Infinity;
    for (const b of flagBars) {
      const low = Number(b.low);
      if (low < flagLow) flagLow = low;
    }
    const retracePct = ((impulse.end_price - flagLow) / impulse.end_price) * 100;
    result.flag_retrace_pct = retracePct;
    if (retracePct > config.consolidation_max_retrace_pct) {
      result.status = `Flag retraced ${retracePct.toFixed(1)}% (max ${config.consolidation_max_retrace_pct}%)`;
      return result;
    }

    result.is_candidate = true;

    // Step 3: Yang-Zhang Volatility
    const yzVol = yangZhangVolatility(bars15m, config.yz_rolling_window);
    const yzPctRank = yzPercentileRank(yzVol, config.yz_percentile_lookback);
    let currentYz = yzPctRank[yzPctRank.length - 1];
    if (!isFinite(currentYz)) {
      // Fallback: simple percentile of the volatility values
      const validVol = yzVol.filter(v => isFinite(v));
      const lastVol = yzVol[yzVol.length - 1];
      if (validVol.length > 50 && isFinite(lastVol)) {
        let below = 0;
        for (const v of validVol) if (v < lastVol) below++;
        currentYz = (below / validVol.length) * 100;
      } else {
        currentYz = 50;
      }
    }
    result.yz_percentile = currentYz;

    // Step 4: Delta Compression
    const consolStartTime = Number(bars15m[consolIdx].time);
    result.delta_metrics = computeDeltaCompression(bars1m || [], consolStartTime, config);

    // Step 5: Range Decay
    result.range_decay = computeRangeDecay(bars15m, consolIdx, config);

    // Step 6: VWAP Deviation
    result.vwap_deviation = computeVwapDeviation(bars15m, consolIdx, config);

    // Step 7: Composite
    result.composite = computeCompositeScore(
      currentYz,
      result.delta_metrics.compression_score || 0,
      result.range_decay,
      result.vwap_deviation,
      config
    );
    result.composite_score = result.composite.composite_score;
    result.is_detected = result.composite.is_htf_detected;

    // Step 8: Breakout
    result.breakout = detectBreakout(bars15m, bars1m || [], consolIdx, impulse.end_price, config);

    result.status = result.is_detected ? 'HTF DETECTED' : 'Candidate — below composite threshold';
    return result;

  } catch (err) {
    result.status = `Error: ${err && err.message ? err.message : String(err)}`;
    return result;
  }
}

module.exports = { detectHTF, HTF_CONFIG };

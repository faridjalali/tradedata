/**
 * Volume Divergence Flag (VDF) Detector
 * ======================================
 * Detects hidden institutional accumulation during multi-week price declines
 * using 1-minute volume delta to reveal net buying that diverges from price.
 *
 * Weekly-smoothed, duration-scaling, aberration-resistant.
 * See ALGORITHM-VD-ACCUMULATION.md for full documentation.
 *
 * Data strategy: fetch 1-min bars at native interval via Massive API.
 */

"use strict";

// =============================================================================
// VD ACCUMULATION DIVERGENCE DETECTOR
// =============================================================================

/**
 * Aggregate 1-minute bars into daily + ISO-week buckets.
 */
function vdAggregateWeekly(bars1m) {
  const dailyMap = new Map();
  for (const b of bars1m) {
    const d = new Date(b.time * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(d)) dailyMap.set(d, { buyVol: 0, sellVol: 0, totalVol: 0, close: 0, open: 0, first: true });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : (b.close < b.open ? -b.volume : 0);
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.close = b.close;
    if (day.first) { day.open = b.open; day.first = false; }
  }

  const dates = [...dailyMap.keys()].sort();
  const daily = dates.map(d => {
    const day = dailyMap.get(d);
    return { date: d, delta: day.buyVol - day.sellVol, totalVol: day.totalVol,
             buyVol: day.buyVol, sellVol: day.sellVol, close: day.close, open: day.open };
  });

  // Group into ISO weeks (Mon-Sun)
  const weekMap = new Map();
  for (const d of daily) {
    const dt = new Date(d.date + 'T12:00:00Z');
    const dow = dt.getUTCDay();
    const monday = new Date(dt);
    monday.setUTCDate(monday.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    const wk = monday.toISOString().split('T')[0];
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk).push(d);
  }

  const weeks = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, days]) => {
    const buyVol = days.reduce((s, d) => s + d.buyVol, 0);
    const sellVol = days.reduce((s, d) => s + d.sellVol, 0);
    const totalVol = days.reduce((s, d) => s + d.totalVol, 0);
    return { weekStart, delta: buyVol - sellVol, totalVol, deltaPct: totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0, nDays: days.length };
  });

  return { daily, weeks };
}

/**
 * Simple linear regression: returns { slope, r2 }.
 */
function vdLinReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] ** 2; sxy += xs[i] * ys[i]; }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const yMean = sy / n;
  const intercept = (sy - slope * sx) / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) { ssTot += (ys[i] - yMean) ** 2; ssRes += (ys[i] - intercept - slope * xs[i]) ** 2; }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

/**
 * Score accumulation divergence from 1-minute bars.
 *
 * @param {Array} consolBars1m — 1m bars for the candidate consolidation window
 * @param {Array} preBars1m   — 1m bars for the pre-context window (~30 days before)
 * @returns {{ score: number, detected: boolean, reason: string, weeks: number, metrics: object }}
 */
function scoreAccumulationDivergence(consolBars1m, preBars1m) {
  const { daily, weeks } = vdAggregateWeekly(consolBars1m);

  if (weeks.length < 2) return { score: 0, detected: false, reason: 'need_2_weeks', weeks: 0, metrics: {} };

  const totalVol = daily.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / daily.length;
  const closes = daily.map(d => d.close);
  const avgPrice = closes.reduce((s, v) => s + v, 0) / closes.length;

  // Price check: must be declining or flat, not rallying or crashing
  const overallPriceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  if (overallPriceChange > 10) return { score: 0, detected: false, reason: 'price_rising', weeks: weeks.length, metrics: { overallPriceChange } };
  if (overallPriceChange < -45) return { score: 0, detected: false, reason: 'crash', weeks: weeks.length, metrics: { overallPriceChange } };

  // Pre-context baseline
  const preAgg = vdAggregateWeekly(preBars1m);
  const preAvgDelta = preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.delta, 0) / preAgg.daily.length : 0;
  const preAvgVol = preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.totalVol, 0) / preAgg.daily.length : avgDailyVol;

  // Net delta
  const netDelta = daily.reduce((s, d) => s + d.delta, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

  // Gate: net delta must not be deeply negative
  if (netDeltaPct < -1.5) return { score: 0, detected: false, reason: 'concordant_selling', weeks: weeks.length, metrics: { netDeltaPct, overallPriceChange } };

  // Cumulative weekly delta slope
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const w of weeks) { cwd += w.delta; cumWeeklyDelta.push(cwd); }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (vdLinReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  // Delta shift vs pre-context
  const consolAvgDailyDelta = netDelta / daily.length;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  // Strong absorption days (price down, delta > 5% avg vol)
  let strongAbsorptionDays = 0;
  for (let i = 1; i < daily.length; i++) {
    if (daily[i].close < daily[i - 1].close && daily[i].delta > avgDailyVol * 0.05) strongAbsorptionDays++;
  }
  const strongAbsorptionPct = daily.length > 1 ? (strongAbsorptionDays / (daily.length - 1)) * 100 : 0;

  // Large buy vs sell days
  const largeBuyDays = daily.filter(d => d.delta > avgDailyVol * 0.10).length;
  const largeSellDays = daily.filter(d => d.delta < -avgDailyVol * 0.10).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / daily.length) * 100;

  // Price-cumDelta correlation
  const cumDeltas = [];
  let cd = 0;
  for (const d of daily) { cd += d.delta; cumDeltas.push(cd); }
  let priceDeltaCorr = 0;
  {
    const n = daily.length;
    const meanP = closes.reduce((s, v) => s + v, 0) / n;
    const meanD = cumDeltas.reduce((s, v) => s + v, 0) / n;
    let cov = 0, varP = 0, varD = 0;
    for (let i = 0; i < n; i++) {
      cov += (closes[i] - meanP) * (cumDeltas[i] - meanD);
      varP += (closes[i] - meanP) ** 2;
      varD += (cumDeltas[i] - meanD) ** 2;
    }
    priceDeltaCorr = (varP > 0 && varD > 0) ? cov / Math.sqrt(varP * varD) : 0;
  }

  // Accumulation week ratio
  const accumWeeks = weeks.filter(w => w.deltaPct > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;

  // Volatility contraction in the last third (range shrinkage -> breakout imminent)
  let volContractionScore = 0;
  if (daily.length >= 9) {
    const dThird = Math.floor(daily.length / 3);
    const t1Ranges = daily.slice(0, dThird).map(d => ((d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0)) * 100);
    const t3Ranges = daily.slice(2 * dThird).map(d => ((d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0)) * 100);
    const avgT1 = t1Ranges.reduce((s, v) => s + v, 0) / t1Ranges.length;
    const avgT3 = t3Ranges.reduce((s, v) => s + v, 0) / t3Ranges.length;
    if (avgT1 > 0) {
      const contraction = (avgT3 - avgT1) / avgT1; // negative = contracting
      volContractionScore = Math.max(0, Math.min(1, -contraction / 0.4)); // 40% contraction = full score
    }
  }

  // Score components (0-1 each)
  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5));          // Net Delta (22%)
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4));       // Delta Slope (18%)
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8));             // Delta Shift (15%)
  const s4 = Math.max(0, Math.min(1, strongAbsorptionPct / 18));          // Absorption (13%)
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12));        // Buy vs Sell (8%)
  const s6 = Math.max(0, Math.min(1, (-priceDeltaCorr + 0.3) / 1.5));    // Anti-corr (9%)
  const s7 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6));     // Week ratio (5%)
  const s8 = volContractionScore;                                          // Vol contraction (10%)

  const rawScore = s1 * 0.22 + s2 * 0.18 + s3 * 0.15 + s4 * 0.13 + s5 * 0.08 + s6 * 0.09 + s7 * 0.05 + s8 * 0.10;

  // Duration scaling: longer accumulation = more bullish
  // 70% at 2 weeks, 100% at 6 weeks, continues growing to 115% at 8+ weeks
  const durationMultiplier = Math.min(1.15, 0.70 + (weeks.length - 2) * 0.075);
  const score = weeks.length >= 2 ? rawScore * durationMultiplier : 0;
  const detected = score >= 0.30;

  return {
    score,
    detected,
    reason: detected ? 'accumulation_divergence' : 'below_threshold',
    weeks: weeks.length,
    accumWeeks,
    durationMultiplier,
    metrics: { netDeltaPct, deltaSlopeNorm, deltaShift, strongAbsorptionPct, largeBuyVsSell, priceDeltaCorr, accumWeekRatio, overallPriceChange, volContractionScore, s1, s2, s3, s4, s5, s6, s7, s8 },
  };
}

/**
 * Run VDF (VD Accumulation Divergence) detection for a ticker.
 * Fetches ~75 days of 1m data (42-day consolidation window + 30-day pre-context).
 *
 * @param {string} ticker
 * @param {object} options
 * @param {function} options.dataApiFetcher — async (symbol, interval, lookbackDays, opts) => bars[]
 * @param {AbortSignal|null} options.signal
 * @returns {Promise<object>} VDF detection result
 */
async function detectVDF(ticker, options) {
  const { dataApiFetcher, signal } = options;

  try {
    // Fetch ~75 days of 1m data (45 calendar days consol + 30 pre-context)
    const bars1m = await dataApiFetcher(ticker, '1min', 75, { signal });
    if (!bars1m || bars1m.length < 500) {
      return { score: 0, detected: false, reason: 'insufficient_1m_data', weeks: 0, metrics: {} };
    }

    // Split into consolidation window (last ~42 calendar days) and pre-context (before that)
    const sorted = bars1m.sort((a, b) => a.time - b.time);
    const latestTime = sorted[sorted.length - 1].time;
    const consolCutoff = latestTime - 42 * 86400; // ~6 weeks back
    const preCutoff = consolCutoff - 30 * 86400;  // 30 more days for pre-context

    const consolBars = sorted.filter(b => b.time >= consolCutoff);
    const preBars = sorted.filter(b => b.time >= preCutoff && b.time < consolCutoff);

    if (consolBars.length < 200) {
      return { score: 0, detected: false, reason: 'insufficient_consol_data', weeks: 0, metrics: {} };
    }

    return scoreAccumulationDivergence(consolBars, preBars);
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.message === 'This operation was aborted')) throw err;
    return { score: 0, detected: false, reason: `error: ${err.message || err}`, weeks: 0, metrics: {} };
  }
}

module.exports = { detectVDF, scoreAccumulationDivergence };

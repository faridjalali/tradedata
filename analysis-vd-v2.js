#!/usr/bin/env node
/**
 * VD Accumulation Algorithm v2 — Feature Engineering
 *
 * Primary positive examples (user-confirmed):
 *   - RKLB 2/26/25 → 4/7/25 (~6 weeks) — price declined, hidden VD accumulation
 *   - IREN 3/13/25 → 4/21/25 (~5.5 weeks) — same pattern
 *
 * These are multi-week (4-8+ week) accumulation periods where price declines
 * but 1m volume delta reveals hidden institutional buying.
 *
 * This script:
 *   1. Fetches 1m data for both positive cases + negative controls
 *   2. Computes 25+ candidate features
 *   3. Identifies which features discriminate positive from negative
 *   4. Proposes and tests a v2 scoring algorithm
 */

require('dotenv').config();

const DATA_API_KEY = process.env.DATA_API_KEY;
const BASE = 'https://api.massive.com';

async function fetchBars(symbol, mult, ts, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${mult}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.results || [])
    .map((r) => ({
      time: Math.floor((r.t || 0) / 1000),
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v || 0,
    }))
    .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close));
}

async function fetch1mChunked(symbol, from, to) {
  const all = [];
  let cursor = new Date(from);
  const end = new Date(to);
  while (cursor < end) {
    const cEnd = new Date(cursor);
    cEnd.setDate(cEnd.getDate() + 25);
    if (cEnd > end) cEnd.setTime(end.getTime());
    const f = cursor.toISOString().split('T')[0];
    const t = cEnd.toISOString().split('T')[0];
    process.stdout.write(`  1m ${symbol} ${f}→${t}...`);
    const bars = await fetchBars(symbol, 1, 'minute', f, t);
    process.stdout.write(` ${bars.length}\n`);
    all.push(...bars);
    await new Promise((r) => setTimeout(r, 250));
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function toDate(ts) {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0, intercept: 0 };
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] ** 2;
    sxy += xs[i] * ys[i];
  }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: 0, r2: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - intercept - slope * xs[i]) ** 2;
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, intercept };
}

function computeRSI(values, period = 14) {
  const rsi = new Array(values.length).fill(NaN);
  if (values.length < period + 1) return rsi;
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// =========================================================================
// FEATURE EXTRACTION — 25+ metrics per episode
// =========================================================================

function extractFeatures(consolBars1m, preContextBars1m) {
  if (consolBars1m.length < 200) return null;

  // --- Aggregate to daily ---
  const dailyMap = new Map();
  for (const b of consolBars1m) {
    const d = toDate(b.time);
    if (!dailyMap.has(d))
      dailyMap.set(d, { buyVol: 0, sellVol: 0, totalVol: 0, closes: [], opens: [], highs: [], lows: [] });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0;
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.closes.push(b.close);
    day.opens.push(b.open);
    day.highs.push(b.high);
    day.lows.push(b.low);
  }

  const dates = [...dailyMap.keys()].sort();
  const daily = dates.map((d) => {
    const day = dailyMap.get(d);
    return {
      date: d,
      delta: day.buyVol - day.sellVol,
      totalVol: day.totalVol,
      buyVol: day.buyVol,
      sellVol: day.sellVol,
      close: day.closes[day.closes.length - 1],
      open: day.opens[0],
      high: Math.max(...day.highs),
      low: Math.min(...day.lows),
    };
  });

  if (daily.length < 5) return null;

  // Pre-context daily
  const preDailyMap = new Map();
  for (const b of preContextBars1m) {
    const d = toDate(b.time);
    if (!preDailyMap.has(d)) preDailyMap.set(d, { buyVol: 0, sellVol: 0, totalVol: 0 });
    const day = preDailyMap.get(d);
    const delta = b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0;
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
  }
  const preDates = [...preDailyMap.keys()].sort();

  // Basic series
  const closes = daily.map((d) => d.close);
  const deltas = daily.map((d) => d.delta);
  const cumDeltas = [];
  let cd = 0;
  for (const d of deltas) {
    cd += d;
    cumDeltas.push(cd);
  }
  const xs = daily.map((_, i) => i);
  const totalVol = daily.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / daily.length;
  const avgPrice = closes.reduce((s, v) => s + v, 0) / closes.length;

  const features = {};

  // === F1: Overall price change ===
  features.priceChangePct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;

  // === F2: Overall price slope (normalized %/day) ===
  const priceReg = linReg(xs, closes);
  features.priceSlopeNorm = (priceReg.slope / avgPrice) * 100;

  // === F3: Overall cumulative delta slope (normalized) ===
  const deltaReg = linReg(xs, cumDeltas);
  features.deltaSlopeNorm = avgDailyVol > 0 ? (deltaReg.slope / avgDailyVol) * 100 : 0;

  // === F4: Net delta as % of total volume ===
  const netDelta = daily.reduce((s, d) => s + d.delta, 0);
  features.netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

  // === F5: Delta vs Expected concordance ===
  // If price drops X%, "concordant" delta would be proportionally negative
  // Positive values mean MORE buying than price action implies
  const expectedDelta = (features.priceChangePct / 100) * totalVol;
  features.deltaVsExpected = totalVol > 0 ? ((netDelta - expectedDelta) / totalVol) * 100 : 0;

  // === F6: Price-Delta divergence ratio ===
  features.priceDeltaDivRatio =
    features.priceSlopeNorm !== 0 ? features.deltaSlopeNorm / Math.abs(features.priceSlopeNorm) : 0;

  // === F7-F10: Thirds analysis ===
  const third = Math.floor(daily.length / 3);
  if (third >= 2) {
    const slices = [daily.slice(0, third), daily.slice(third, 2 * third), daily.slice(2 * third)];
    const tDeltaPcts = slices.map((s) => {
      const vol = s.reduce((a, d) => a + d.totalVol, 0);
      const del = s.reduce((a, d) => a + d.delta, 0);
      return vol > 0 ? (del / vol) * 100 : 0;
    });
    features.t1DeltaPct = tDeltaPcts[0];
    features.t2DeltaPct = tDeltaPcts[1];
    features.t3DeltaPct = tDeltaPcts[2];
    features.deltaImprovement = tDeltaPcts[2] - tDeltaPcts[0];
    features.progressiveAccum = (tDeltaPcts[1] > tDeltaPcts[0] ? 0.5 : 0) + (tDeltaPcts[2] > tDeltaPcts[1] ? 0.5 : 0);
  } else {
    features.t1DeltaPct = features.t2DeltaPct = features.t3DeltaPct = 0;
    features.deltaImprovement = 0;
    features.progressiveAccum = 0;
  }

  // === F11-F12: Halves analysis ===
  const half = Math.floor(daily.length / 2);
  const h1 = daily.slice(0, half);
  const h2 = daily.slice(half);
  const h1Vol = h1.reduce((s, d) => s + d.totalVol, 0);
  const h2Vol = h2.reduce((s, d) => s + d.totalVol, 0);
  const h1Delta = h1.reduce((s, d) => s + d.delta, 0);
  const h2Delta = h2.reduce((s, d) => s + d.delta, 0);
  features.h1DeltaPct = h1Vol > 0 ? (h1Delta / h1Vol) * 100 : 0;
  features.h2DeltaPct = h2Vol > 0 ? (h2Delta / h2Vol) * 100 : 0;
  features.halvesImprovement = features.h2DeltaPct - features.h1DeltaPct;

  // === F13-F15: Support-level accumulation ===
  const priceHigh = Math.max(...closes);
  const priceLow = Math.min(...closes);
  const priceRange = priceHigh - priceLow;
  const supportLevel = priceLow + priceRange * 0.3;
  const resistanceLevel = priceLow + priceRange * 0.7;

  let supportDelta = 0,
    supportVol = 0,
    supportDays = 0;
  let resistanceDelta = 0,
    resistanceVol = 0,
    resistanceDays = 0;
  for (const d of daily) {
    if (d.close <= supportLevel) {
      supportDelta += d.delta;
      supportVol += d.totalVol;
      supportDays++;
    }
    if (d.close >= resistanceLevel) {
      resistanceDelta += d.delta;
      resistanceVol += d.totalVol;
      resistanceDays++;
    }
  }
  features.supportDeltaPct = supportVol > 0 ? (supportDelta / supportVol) * 100 : 0;
  features.resistanceDeltaPct = resistanceVol > 0 ? (resistanceDelta / resistanceVol) * 100 : 0;
  features.supportVsResistance = features.supportDeltaPct - features.resistanceDeltaPct;
  features.supportDays = supportDays;

  // === F16-F18: Absorption & Distribution ===
  let absorptionDays = 0,
    strongAbsorptionDays = 0,
    distributionDays = 0;
  for (let i = 1; i < daily.length; i++) {
    const priceDown = daily[i].close < daily[i - 1].close;
    const priceUp = daily[i].close > daily[i - 1].close;
    const deltaPos = daily[i].delta > 0;
    const deltaNeg = daily[i].delta < 0;
    const strongDelta = daily[i].delta > avgDailyVol * 0.05;
    if (priceDown && deltaPos) absorptionDays++;
    if (priceDown && strongDelta) strongAbsorptionDays++;
    if (priceUp && deltaNeg) distributionDays++;
  }
  features.absorptionPct = (absorptionDays / (daily.length - 1)) * 100;
  features.strongAbsorptionPct = (strongAbsorptionDays / (daily.length - 1)) * 100;
  features.distributionPct = (distributionDays / (daily.length - 1)) * 100;
  features.absMinusDist = features.absorptionPct - features.distributionPct;

  // === F19-F24: VD RSI analysis ===
  const vdRsi = computeRSI(cumDeltas, 14);
  const validRsiIdx = [];
  for (let i = 0; i < vdRsi.length; i++) {
    if (Number.isFinite(vdRsi[i])) validRsiIdx.push(i);
  }

  if (validRsiIdx.length >= 10) {
    const vr = validRsiIdx.map((i) => vdRsi[i]);
    const vp = validRsiIdx.map((i) => closes[i]);
    const vrXs = vr.map((_, i) => i);

    features.vdRsiSlope = linReg(vrXs, vr).slope;
    features.vdRsiPriceSlope = (linReg(vrXs, vp).slope / avgPrice) * 100;
    features.vdRsiDivergence = features.vdRsiPriceSlope < 0 && features.vdRsiSlope > 0 ? 1 : 0;

    // Quarter lows
    const q = Math.floor(vr.length / 4);
    if (q >= 2) {
      features.rsiHigherLow = Math.min(...vr.slice(3 * q)) > Math.min(...vr.slice(0, q)) ? 1 : 0;
      features.priceLowerLow = Math.min(...vp.slice(3 * q)) < Math.min(...vp.slice(0, q)) ? 1 : 0;
      features.rsiLowShift = Math.min(...vr.slice(3 * q)) - Math.min(...vr.slice(0, q));
    } else {
      features.rsiHigherLow = 0;
      features.priceLowerLow = 0;
      features.rsiLowShift = 0;
    }

    const startRsi = vr.slice(0, Math.min(5, vr.length));
    const endRsi = vr.slice(-Math.min(5, vr.length));
    features.vdRsiStart = startRsi.reduce((s, v) => s + v, 0) / startRsi.length;
    features.vdRsiEnd = endRsi.reduce((s, v) => s + v, 0) / endRsi.length;
    features.vdRsiChange = features.vdRsiEnd - features.vdRsiStart;
  } else {
    features.vdRsiSlope = 0;
    features.vdRsiPriceSlope = 0;
    features.vdRsiDivergence = 0;
    features.rsiHigherLow = 0;
    features.priceLowerLow = 0;
    features.rsiLowShift = 0;
    features.vdRsiStart = 50;
    features.vdRsiEnd = 50;
    features.vdRsiChange = 0;
  }

  // === F25: Volume slope (log-linear) ===
  features.volSlope = linReg(
    xs,
    daily.map((d) => Math.log(Math.max(1, d.totalVol))),
  ).slope;

  // === F26: Price-cumDelta correlation ===
  {
    const n = daily.length;
    const meanP = closes.reduce((s, v) => s + v, 0) / n;
    const meanD = cumDeltas.reduce((s, v) => s + v, 0) / n;
    let cov = 0,
      varP = 0,
      varD = 0;
    for (let i = 0; i < n; i++) {
      cov += (closes[i] - meanP) * (cumDeltas[i] - meanD);
      varP += (closes[i] - meanP) ** 2;
      varD += (cumDeltas[i] - meanD) ** 2;
    }
    features.priceDeltaCorr = varP > 0 && varD > 0 ? cov / Math.sqrt(varP * varD) : 0;
  }

  // === F27: Delta shift vs pre-context ===
  if (preDates.length > 0) {
    const preAvgDelta =
      preDates.reduce((s, d) => {
        const day = preDailyMap.get(d);
        return s + (day.buyVol - day.sellVol);
      }, 0) / preDates.length;
    const preAvgVol = preDates.reduce((s, d) => s + preDailyMap.get(d).totalVol, 0) / preDates.length;
    features.deltaShiftVsPre = preAvgVol > 0 ? ((netDelta / daily.length - preAvgDelta) / preAvgVol) * 100 : 0;
  } else {
    features.deltaShiftVsPre = 0;
  }

  // === F28: Positive delta day ratio ===
  features.posDeltaDayRatio = (daily.filter((d) => d.delta > 0).length / daily.length) * 100;

  // === F29-F30: Large buy vs sell days ===
  features.largeBuyDayRatio = (daily.filter((d) => d.delta > avgDailyVol * 0.1).length / daily.length) * 100;
  features.largeSellDayRatio = (daily.filter((d) => d.delta < -avgDailyVol * 0.1).length / daily.length) * 100;
  features.largeBuyVsSell = features.largeBuyDayRatio - features.largeSellDayRatio;

  // === F31: Rolling 5-day delta trend ===
  if (daily.length >= 10) {
    const rolling5 = [];
    for (let i = 4; i < daily.length; i++) {
      let s = 0;
      for (let j = i - 4; j <= i; j++) s += daily[j].delta;
      rolling5.push(s);
    }
    features.rolling5DeltaSlope =
      avgDailyVol > 0
        ? (linReg(
            rolling5.map((_, i) => i),
            rolling5,
          ).slope /
            avgDailyVol) *
          100
        : 0;
  } else {
    features.rolling5DeltaSlope = 0;
  }

  // === F32: "Stealth accumulation" — buy volume as % of total, compared to price direction ===
  // If buy volume ratio is high (>50%) but price is declining, that's stealth accumulation
  const buyRatio = totalVol > 0 ? (daily.reduce((s, d) => s + d.buyVol, 0) / totalVol) * 100 : 50;
  features.buyVolumeRatio = buyRatio;
  features.stealthAccum = features.priceChangePct < 0 ? buyRatio - 50 : 0; // positive = more buying than expected

  // === Metadata ===
  features.priceStart = closes[0];
  features.priceEnd = closes[closes.length - 1];
  features.nDays = daily.length;

  return features;
}

// =========================================================================
// TEST CASES
// =========================================================================

const TEST_CASES = [
  // PRIMARY POSITIVE — user-confirmed accumulation → breakout
  {
    symbol: 'RKLB',
    from: '2025-02-26',
    to: '2025-04-07',
    preFrom: '2025-01-26',
    expected: true,
    label: 'RKLB Feb 26 - Apr 7 2025 (confirmed)',
  },
  {
    symbol: 'IREN',
    from: '2025-03-13',
    to: '2025-04-21',
    preFrom: '2025-02-13',
    expected: true,
    label: 'IREN Mar 13 - Apr 21 2025 (confirmed)',
  },

  // NEGATIVE CONTROLS — need periods where price declined WITHOUT subsequent breakout
  // or a "normal" concordant decline (selling matches price drop)
  {
    symbol: 'RKLB',
    from: '2026-01-06',
    to: '2026-02-14',
    preFrom: '2025-12-06',
    expected: false,
    label: 'RKLB Jan-Feb 2026 (current, no breakout yet)',
  },
  {
    symbol: 'IREN',
    from: '2026-01-06',
    to: '2026-02-14',
    preFrom: '2025-12-06',
    expected: false,
    label: 'IREN Jan-Feb 2026 (current, no breakout yet)',
  },

  // Additional potential negatives — tickers that declined and didn't recover
  {
    symbol: 'SMCI',
    from: '2024-10-01',
    to: '2024-11-15',
    preFrom: '2024-09-01',
    expected: false,
    label: 'SMCI Oct-Nov 2024 (continued decline)',
  },
  {
    symbol: 'RIVN',
    from: '2024-10-01',
    to: '2024-11-15',
    preFrom: '2024-09-01',
    expected: false,
    label: 'RIVN Oct-Nov 2024 (no breakout)',
  },
];

// =========================================================================
// MAIN
// =========================================================================

async function main() {
  console.log('=== VD Accumulation Algorithm v2 — IREN + RKLB Focus ===');
  console.log('Multi-week (4-8+ weeks) hidden accumulation during price decline\n');

  const allResults = [];

  for (const tc of TEST_CASES) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  ${tc.label}`);
    console.log(`  ${tc.symbol} ${tc.from} → ${tc.to} | expected: ${tc.expected ? 'POSITIVE' : 'NEGATIVE'}`);
    console.log(`${'═'.repeat(80)}`);

    try {
      const bars1m = await fetch1mChunked(tc.symbol, tc.preFrom, tc.to);

      const consolStart = new Date(tc.from + 'T00:00:00Z').getTime() / 1000;
      const consolEnd = new Date(tc.to + 'T23:59:59Z').getTime() / 1000;

      const preBars = bars1m.filter((b) => b.time < consolStart);
      const consolBars = bars1m.filter((b) => b.time >= consolStart && b.time <= consolEnd);

      console.log(`  Pre-context: ${preBars.length} bars | Consolidation: ${consolBars.length} bars`);

      const features = extractFeatures(consolBars, preBars);
      if (!features) {
        console.log('  SKIPPED: insufficient data');
        continue;
      }

      console.log(
        `  Price: $${features.priceStart.toFixed(2)} → $${features.priceEnd.toFixed(2)} (${features.priceChangePct.toFixed(1)}%)`,
      );
      console.log(`  Days: ${features.nDays}`);

      allResults.push({ ...tc, features });

      // Print ALL features grouped by category
      console.log(`\n  ── OVERALL DELTA ──`);
      console.log(`    Net delta %:        ${features.netDeltaPct.toFixed(3)}%`);
      console.log(`    Delta slope (norm): ${features.deltaSlopeNorm.toFixed(4)}`);
      console.log(`    Price slope (norm): ${features.priceSlopeNorm.toFixed(4)}%/day`);
      console.log(`    Delta vs expected:  ${features.deltaVsExpected.toFixed(3)}%`);
      console.log(`    Divergence ratio:   ${features.priceDeltaDivRatio.toFixed(4)}`);
      console.log(`    Price-delta corr:   ${features.priceDeltaCorr.toFixed(4)}`);
      console.log(`    Buy volume ratio:   ${features.buyVolumeRatio.toFixed(1)}%`);
      console.log(`    Stealth accum:      ${features.stealthAccum.toFixed(2)}`);

      console.log(`  ── SUB-PERIOD (THIRDS) ──`);
      console.log(
        `    T1: ${features.t1DeltaPct.toFixed(3)}% | T2: ${features.t2DeltaPct.toFixed(3)}% | T3: ${features.t3DeltaPct.toFixed(3)}%`,
      );
      console.log(`    Improvement (T3-T1):  ${features.deltaImprovement.toFixed(3)}`);
      console.log(`    Progressive score:    ${features.progressiveAccum.toFixed(1)}`);

      console.log(`  ── SUB-PERIOD (HALVES) ──`);
      console.log(`    H1: ${features.h1DeltaPct.toFixed(3)}% | H2: ${features.h2DeltaPct.toFixed(3)}%`);
      console.log(`    Halves improvement:   ${features.halvesImprovement.toFixed(3)}`);

      console.log(`  ── SUPPORT/RESISTANCE ──`);
      console.log(`    Support delta:        ${features.supportDeltaPct.toFixed(3)}% (${features.supportDays} days)`);
      console.log(`    Resistance delta:     ${features.resistanceDeltaPct.toFixed(3)}%`);
      console.log(`    Support vs Resist:    ${features.supportVsResistance.toFixed(3)}`);

      console.log(`  ── ABSORPTION / DISTRIBUTION ──`);
      console.log(`    Absorption days:      ${features.absorptionPct.toFixed(1)}%`);
      console.log(`    Strong absorption:    ${features.strongAbsorptionPct.toFixed(1)}%`);
      console.log(`    Distribution days:    ${features.distributionPct.toFixed(1)}%`);
      console.log(`    Abs - Dist:           ${features.absMinusDist.toFixed(1)}`);

      console.log(`  ── VD RSI ──`);
      console.log(`    VD RSI slope:         ${features.vdRsiSlope.toFixed(4)}`);
      console.log(`    Divergence:           ${features.vdRsiDivergence ? 'YES' : 'NO'}`);
      console.log(
        `    Start → End:          ${features.vdRsiStart.toFixed(1)} → ${features.vdRsiEnd.toFixed(1)} (Δ${features.vdRsiChange.toFixed(1)})`,
      );
      console.log(`    RSI higher low:       ${features.rsiHigherLow ? 'YES' : 'NO'}`);
      console.log(`    RSI low shift:        ${features.rsiLowShift.toFixed(2)}`);

      console.log(`  ── OTHER ──`);
      console.log(`    Vol slope:            ${features.volSlope.toFixed(6)}`);
      console.log(`    Pos delta day ratio:  ${features.posDeltaDayRatio.toFixed(1)}%`);
      console.log(`    Large buy vs sell:    ${features.largeBuyVsSell.toFixed(1)}`);
      console.log(`    Rolling 5d slope:     ${features.rolling5DeltaSlope.toFixed(4)}`);
      console.log(`    Delta shift vs pre:   ${features.deltaShiftVsPre.toFixed(4)}`);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  // =========================================================================
  // FEATURE DISCRIMINATION
  // =========================================================================
  console.log(`\n\n${'═'.repeat(100)}`);
  console.log(`FEATURE DISCRIMINATION: Positives vs Negatives`);
  console.log(`${'═'.repeat(100)}\n`);

  const positives = allResults.filter((r) => r.expected);
  const negatives = allResults.filter((r) => !r.expected);

  console.log(`Positives: ${positives.length} | Negatives: ${negatives.length}\n`);

  if (positives.length === 0 || negatives.length === 0) {
    console.log('Need both positive and negative examples');
    return;
  }

  const featureNames = Object.keys(positives[0].features).filter(
    (k) =>
      typeof positives[0].features[k] === 'number' && !['priceStart', 'priceEnd', 'nDays', 'supportDays'].includes(k),
  );

  console.log(
    `${'Feature'.padEnd(28)} ${'Pos Mean'.padStart(10)} ${'Neg Mean'.padStart(10)} ${'Diff'.padStart(10)} ${'Sep?'.padStart(8)} ${'Rating'.padStart(15)}`,
  );
  console.log(`${'─'.repeat(83)}`);

  const ranked = [];

  for (const fname of featureNames) {
    const posVals = positives.map((r) => r.features[fname]).filter(Number.isFinite);
    const negVals = negatives.map((r) => r.features[fname]).filter(Number.isFinite);
    if (posVals.length === 0 || negVals.length === 0) continue;

    const posMean = posVals.reduce((s, v) => s + v, 0) / posVals.length;
    const negMean = negVals.reduce((s, v) => s + v, 0) / negVals.length;
    const diff = posMean - negMean;

    const posMin = Math.min(...posVals);
    const posMax = Math.max(...posVals);
    const negMin = Math.min(...negVals);
    const negMax = Math.max(...negVals);

    // Check separation quality
    let rating = '';
    let ratingScore = 0;
    if (posMin > negMax || negMin > posMax) {
      rating = '★★★ PERFECT';
      ratingScore = 3;
    } else if ((posMean > 0 && negMean <= 0) || (posMean <= 0 && negMean > 0)) {
      rating = '★★ SIGN-FLIP';
      ratingScore = 2;
    } else if (Math.abs(diff) > 0.3 * Math.max(Math.abs(posMean), Math.abs(negMean), 0.01)) {
      rating = '★ USEFUL';
      ratingScore = 1;
    }

    ranked.push({ fname, posMean, negMean, diff, rating, ratingScore });

    const sep = posMin > negMax ? 'FULL' : negMin > posMax ? 'FULL-R' : 'OVER';
    console.log(
      `${fname.padEnd(28)} ${posMean.toFixed(4).padStart(10)} ${negMean.toFixed(4).padStart(10)} ${diff.toFixed(4).padStart(10)} ${sep.padStart(8)} ${rating.padStart(15)}`,
    );
  }

  // Sort by rating
  ranked.sort((a, b) => b.ratingScore - a.ratingScore || Math.abs(b.diff) - Math.abs(a.diff));

  console.log(`\n  TOP DISCRIMINATING FEATURES:`);
  for (const r of ranked.filter((r) => r.ratingScore > 0)) {
    console.log(
      `    ${r.rating.padEnd(18)} ${r.fname.padEnd(28)} pos=${r.posMean.toFixed(4)}, neg=${r.negMean.toFixed(4)}`,
    );
  }

  // =========================================================================
  // v2 SCORING — apply to all cases
  // =========================================================================
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`v2 ALGORITHM SCORING`);
  console.log(`${'═'.repeat(80)}\n`);

  // The v2 algorithm uses the best-discriminating features
  // We'll try multiple scoring formulas and see which works best
  for (const r of allResults) {
    const f = r.features;

    // --- Scoring Formula A: Absorption-focused ---
    let scoreA = 0;
    // 1. Delta vs Expected (how much buying was absorbed beyond concordance)
    scoreA += Math.max(0, Math.min(1, (f.deltaVsExpected + 3) / 10)) * 0.2;
    // 2. Delta improvement over time (later > earlier)
    scoreA += Math.max(0, Math.min(1, (f.deltaImprovement + 2) / 6)) * 0.15;
    // 3. Halves improvement
    scoreA += Math.max(0, Math.min(1, (f.halvesImprovement + 2) / 6)) * 0.1;
    // 4. Support-level buying
    scoreA += Math.max(0, Math.min(1, (f.supportDeltaPct + 3) / 8)) * 0.1;
    // 5. Absorption vs distribution
    scoreA += Math.max(0, Math.min(1, (f.absMinusDist + 10) / 25)) * 0.15;
    // 6. Buy volume ratio (stealth)
    scoreA += Math.max(0, Math.min(1, f.stealthAccum / 5)) * 0.1;
    // 7. VD RSI (slope or divergence)
    let rsiS = 0;
    if (f.vdRsiDivergence) rsiS = 0.9;
    else if (f.rsiHigherLow) rsiS = 0.7;
    else if (f.vdRsiChange > 0) rsiS = Math.min(0.6, f.vdRsiChange / 15);
    else if (f.halvesImprovement > 0) rsiS = 0.25;
    scoreA += rsiS * 0.1;
    // 8. Price structure (must be declining, but not crash)
    let psA = 0;
    if (f.priceChangePct > -45 && f.priceChangePct < 5) {
      if (f.priceChangePct < 0) psA = Math.min(1, Math.abs(f.priceChangePct) / 30);
      else psA = 0.15;
    }
    scoreA += psA * 0.1;

    // --- Scoring Formula B: Divergence-focused ---
    let scoreB = 0;
    // 1. Price-delta divergence ratio (delta going opposite of price)
    scoreB += Math.max(0, Math.min(1, (f.priceDeltaDivRatio + 1) / 3)) * 0.25;
    // 2. Negative price-delta correlation (price down, cumDelta up)
    scoreB += Math.max(0, Math.min(1, (-f.priceDeltaCorr + 1) / 2)) * 0.2;
    // 3. Net delta pct (positive = net accumulation)
    scoreB += Math.max(0, Math.min(1, (f.netDeltaPct + 2) / 5)) * 0.15;
    // 4. Absorption days
    scoreB += Math.max(0, Math.min(1, f.absorptionPct / 40)) * 0.15;
    // 5. VD RSI
    scoreB += rsiS * 0.15;
    // 6. Price structure
    scoreB += psA * 0.1;

    // --- Combined score: best of A and B ---
    const scoreFinal = Math.max(scoreA, scoreB);
    const detected = scoreFinal >= 0.35;
    const correct = detected === r.expected;

    console.log(`  ${r.label}`);
    console.log(
      `    Formula A: ${scoreA.toFixed(4)} | Formula B: ${scoreB.toFixed(4)} | Final: ${scoreFinal.toFixed(4)}`,
    );
    console.log(
      `    Detected: ${detected ? 'YES' : 'NO'} | Expected: ${r.expected ? 'YES' : 'NO'} | ${correct ? '✅' : '⚠️ MISS'}`,
    );
    console.log();
  }

  const accuracy = allResults.filter(
    (r) =>
      Math.max(
        (() => {
          const f = r.features;
          let s = 0;
          s += Math.max(0, Math.min(1, (f.deltaVsExpected + 3) / 10)) * 0.2;
          s += Math.max(0, Math.min(1, (f.deltaImprovement + 2) / 6)) * 0.15;
          s += Math.max(0, Math.min(1, (f.halvesImprovement + 2) / 6)) * 0.1;
          s += Math.max(0, Math.min(1, (f.supportDeltaPct + 3) / 8)) * 0.1;
          s += Math.max(0, Math.min(1, (f.absMinusDist + 10) / 25)) * 0.15;
          s += Math.max(0, Math.min(1, f.stealthAccum / 5)) * 0.1;
          let rs = 0;
          if (f.vdRsiDivergence) rs = 0.9;
          else if (f.rsiHigherLow) rs = 0.7;
          else if (f.vdRsiChange > 0) rs = Math.min(0.6, f.vdRsiChange / 15);
          else if (f.halvesImprovement > 0) rs = 0.25;
          s += rs * 0.1;
          let ps = 0;
          if (f.priceChangePct > -45 && f.priceChangePct < 5) {
            if (f.priceChangePct < 0) ps = Math.min(1, Math.abs(f.priceChangePct) / 30);
            else ps = 0.15;
          }
          s += ps * 0.1;
          return s;
        })(),
        (() => {
          const f = r.features;
          let s = 0;
          s += Math.max(0, Math.min(1, (f.priceDeltaDivRatio + 1) / 3)) * 0.25;
          s += Math.max(0, Math.min(1, (-f.priceDeltaCorr + 1) / 2)) * 0.2;
          s += Math.max(0, Math.min(1, (f.netDeltaPct + 2) / 5)) * 0.15;
          s += Math.max(0, Math.min(1, f.absorptionPct / 40)) * 0.15;
          let rs = 0;
          if (f.vdRsiDivergence) rs = 0.9;
          else if (f.rsiHigherLow) rs = 0.7;
          else if (f.vdRsiChange > 0) rs = Math.min(0.6, f.vdRsiChange / 15);
          else if (f.halvesImprovement > 0) rs = 0.25;
          s += rs * 0.15;
          let ps = 0;
          if (f.priceChangePct > -45 && f.priceChangePct < 5) {
            if (f.priceChangePct < 0) ps = Math.min(1, Math.abs(f.priceChangePct) / 30);
            else ps = 0.15;
          }
          s += ps * 0.1;
          return s;
        })(),
      ) >=
        0.35 ===
      r.expected,
  ).length;

  console.log(
    `\nOverall accuracy: ${accuracy}/${allResults.length} (${((accuracy / allResults.length) * 100).toFixed(0)}%)`,
  );
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Volume Delta Divergence Algorithm Development
 *
 * Study known accumulation periods to build a detection algorithm:
 *   - ASTS 11/7/24-1/31/25 (price declined, preceded breakout)
 *   - RKLB 2/26/25-4/7/25 (price declined, preceded breakout)
 *   - ASTS 9/20-11/7/24 (consolidation → breakout)
 *
 * Also study NEGATIVE examples (consolidation that did NOT lead to breakout,
 * or where VD confirmed the decline) to build discrimination.
 *
 * Goal: produce a scoring function that can be scanned across tickers.
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
    await new Promise((r) => setTimeout(r, 300));
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =========================================================================
// CORE ALGORITHM: Volume Delta Accumulation Score
// =========================================================================

/**
 * Given 1m bars for a consolidation window AND a pre-consolidation context window,
 * compute a comprehensive "accumulation divergence" score.
 *
 * Returns a score object with individual metrics and a composite score.
 */
function computeAccumulationDivergence(consolBars1m, preContextBars1m) {
  if (consolBars1m.length < 200) {
    return { score: 0, reason: 'insufficient_data', details: {} };
  }

  // --- Aggregate to daily ---
  const dailyMap = new Map();
  for (const b of consolBars1m) {
    const d = toDate(b.time);
    if (!dailyMap.has(d)) dailyMap.set(d, { buyVol: 0, sellVol: 0, totalVol: 0, closes: [], highs: [], lows: [] });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0;
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.closes.push(b.close);
    day.highs.push(b.high);
    day.lows.push(b.low);
  }

  const dates = [...dailyMap.keys()].sort();
  const dailyData = dates.map((d) => {
    const day = dailyMap.get(d);
    return {
      date: d,
      delta: day.buyVol - day.sellVol,
      totalVol: day.totalVol,
      buyVol: day.buyVol,
      sellVol: day.sellVol,
      close: day.closes[day.closes.length - 1],
      high: Math.max(...day.highs),
      low: Math.min(...day.lows),
    };
  });

  if (dailyData.length < 5) {
    return { score: 0, reason: 'too_few_days', details: {} };
  }

  // --- Pre-context daily aggregation (for normalization) ---
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
  const preAvgDailyDelta =
    preDates.length > 0
      ? preDates.reduce((s, d) => s + (preDailyMap.get(d).buyVol - preDailyMap.get(d).sellVol), 0) / preDates.length
      : 0;
  const preAvgDailyVol =
    preDates.length > 0 ? preDates.reduce((s, d) => s + preDailyMap.get(d).totalVol, 0) / preDates.length : 1;

  // === METRIC 1: Price-Delta Divergence (core metric) ===
  // Measure: price slope vs cumulative delta slope over the consolidation
  const closes = dailyData.map((d) => d.close);
  const cumDeltas = [];
  let cumD = 0;
  for (const d of dailyData) {
    cumD += d.delta;
    cumDeltas.push(cumD);
  }

  const xs = closes.map((_, i) => i);
  const priceReg = linReg(xs, closes);
  const deltaReg = linReg(xs, cumDeltas);

  // Normalize slopes to % per day
  const avgPrice = closes.reduce((s, v) => s + v, 0) / closes.length;
  const priceSlopeNorm = (priceReg.slope / avgPrice) * 100; // % per day
  const totalVol = dailyData.reduce((s, d) => s + d.totalVol, 0);
  const deltaSlopeNorm = totalVol > 0 ? (deltaReg.slope / (totalVol / dailyData.length)) * 100 : 0; // relative

  // Divergence: price declining but delta rising (or at least not declining as fast)
  // Score: higher when price slope is negative and delta slope is positive
  let divergenceScore = 0;
  if (priceSlopeNorm < 0) {
    // Price is declining — good setup
    if (deltaSlopeNorm > 0) {
      // Delta is rising while price falls — classic accumulation divergence
      divergenceScore = Math.min(1.0, Math.abs(deltaSlopeNorm) / 2 + 0.3);
    } else {
      // Delta also declining but less steeply than price
      const ratio = Math.abs(priceSlopeNorm) > 0 ? Math.abs(deltaSlopeNorm) / Math.abs(priceSlopeNorm) : 1;
      if (ratio < 0.5) {
        // Delta declining at less than half the rate of price — still accumulation
        divergenceScore = Math.min(0.6, (1 - ratio) * 0.6);
      }
    }
  } else if (priceSlopeNorm > -0.1 && priceSlopeNorm < 0.3) {
    // Price roughly flat — look for positive delta accumulation
    if (deltaSlopeNorm > 0) {
      divergenceScore = Math.min(0.5, deltaSlopeNorm / 3);
    }
  }

  // === METRIC 2: Net Accumulation Ratio ===
  // What fraction of total volume was "hidden" buying?
  const totalBuyVol = dailyData.reduce((s, d) => s + d.buyVol, 0);
  const totalSellVol = dailyData.reduce((s, d) => s + d.sellVol, 0);
  const netDelta = totalBuyVol - totalSellVol;
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

  // Compare net delta to pre-context: is buying stronger than before the consolidation?
  const avgConsolDailyDelta = dailyData.reduce((s, d) => s + d.delta, 0) / dailyData.length;
  const deltaShift = preAvgDailyVol > 0 ? (avgConsolDailyDelta - preAvgDailyDelta) / preAvgDailyVol : 0;

  // Score: positive net delta when price is declining = accumulation
  let accumulationScore = 0;
  if (priceSlopeNorm < 0 && netDeltaPct > 0) {
    accumulationScore = Math.min(1.0, netDeltaPct / 3); // 3% net delta = full score
  } else if (priceSlopeNorm < 0 && netDeltaPct > -1) {
    // Slight net selling but mostly absorbed — still somewhat bullish
    accumulationScore = Math.max(0, (1 + netDeltaPct) * 0.3);
  }
  // If delta shifted positive relative to pre-context, bonus
  if (deltaShift > 0) {
    accumulationScore = Math.min(1.0, accumulationScore + deltaShift * 0.2);
  }

  // === METRIC 3: VD RSI Divergence ===
  // Compute RSI(14) on cumulative daily delta, check for rising RSI vs declining price
  const vdRsi = computeRSI(cumDeltas, 14);
  const validRsi = [];
  const validRsiPrices = [];
  for (let i = 0; i < vdRsi.length; i++) {
    if (Number.isFinite(vdRsi[i])) {
      validRsi.push(vdRsi[i]);
      validRsiPrices.push(closes[i]);
    }
  }

  let vdRsiDivScore = 0;
  if (validRsi.length >= 10) {
    const rsiXs = validRsi.map((_, i) => i);
    const rsiSlope = linReg(rsiXs, validRsi).slope;
    const rsiPriceSlope = linReg(rsiXs, validRsiPrices).slope;
    const rsiPriceSlopeNorm = (rsiPriceSlope / avgPrice) * 100;

    // Classic divergence: price declining, VD RSI rising
    if (rsiPriceSlopeNorm < 0 && rsiSlope > 0) {
      vdRsiDivScore = Math.min(1.0, rsiSlope / 0.5);
    }
    // Weaker: both declining but RSI declining less
    if (rsiPriceSlopeNorm < 0 && rsiSlope < 0 && Math.abs(rsiSlope) < Math.abs(rsiPriceSlopeNorm) * 10) {
      vdRsiDivScore = Math.max(vdRsiDivScore, 0.2);
    }

    // Quarter-lows check (more robust to noise)
    const q = Math.floor(validRsi.length / 4);
    if (q >= 2) {
      const q1RsiLow = Math.min(...validRsi.slice(0, q));
      const q4RsiLow = Math.min(...validRsi.slice(3 * q));
      const q1PriceLow = Math.min(...validRsiPrices.slice(0, q));
      const q4PriceLow = Math.min(...validRsiPrices.slice(3 * q));
      if (q4PriceLow < q1PriceLow && q4RsiLow > q1RsiLow) {
        // Price lower low but RSI higher low — classic bullish divergence
        vdRsiDivScore = Math.max(vdRsiDivScore, 0.7);
      }
    }
  }

  // === METRIC 4: Accumulation Spike Pattern ===
  // Count days where daily delta is strongly positive while price closes down
  // These are "hidden accumulation" days — institutions buying into weakness
  let accumSpikeDays = 0;
  const avgDailyVol = totalVol / dailyData.length;
  for (let i = 1; i < dailyData.length; i++) {
    const priceDown = dailyData[i].close < dailyData[i - 1].close;
    const strongBuying = dailyData[i].delta > avgDailyVol * 0.05; // >5% of avg vol as net buy
    if (priceDown && strongBuying) accumSpikeDays++;
  }
  const spikePct = (accumSpikeDays / (dailyData.length - 1)) * 100;
  const spikeScore = Math.min(1.0, spikePct / 15); // 15% of days with spikes = full score

  // === METRIC 5: Volume Decline ===
  // Declining volume during consolidation is bullish (selling pressure exhausting)
  const volSlope = linReg(
    xs,
    dailyData.map((d) => Math.log(Math.max(1, d.totalVol))),
  ).slope;
  const volDeclineScore = volSlope < 0 ? Math.min(1.0, Math.abs(volSlope) / 0.03) : 0;

  // === METRIC 6: Price Structure ===
  // How much has price declined? (Must be a consolidation/pullback, not a crash)
  const priceChangePct = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  let priceStructureScore = 0;
  if (priceChangePct > -40 && priceChangePct < 5) {
    // Moderate decline or flat — good consolidation territory
    if (priceChangePct < 0) {
      priceStructureScore = Math.min(1.0, Math.abs(priceChangePct) / 20); // 20% decline = full
    } else {
      priceStructureScore = 0.3; // Flat is OK but not as strong a signal
    }
  }

  // === COMPOSITE SCORE ===
  // Weights reflect importance: divergence is king, accumulation confirms,
  // VD RSI provides additional confirmation, spikes and volume are supporting
  const weights = {
    divergence: 0.3,
    accumulation: 0.2,
    vdRsiDiv: 0.2,
    spikes: 0.1,
    volDecline: 0.1,
    priceStructure: 0.1,
  };

  const composite =
    weights.divergence * divergenceScore +
    weights.accumulation * accumulationScore +
    weights.vdRsiDiv * vdRsiDivScore +
    weights.spikes * spikeScore +
    weights.volDecline * volDeclineScore +
    weights.priceStructure * priceStructureScore;

  return {
    score: composite,
    detected: composite >= 0.35, // Threshold for "accumulation detected"
    reason: composite >= 0.35 ? 'accumulation_divergence' : 'below_threshold',
    details: {
      divergence: { score: divergenceScore, priceSlopeNorm, deltaSlopeNorm },
      accumulation: { score: accumulationScore, netDeltaPct, deltaShift },
      vdRsiDiv: { score: vdRsiDivScore },
      spikes: { score: spikeScore, days: accumSpikeDays, pct: spikePct },
      volDecline: { score: volDeclineScore, slope: volSlope },
      priceStructure: { score: priceStructureScore, changePct: priceChangePct },
      composite,
      nDays: dailyData.length,
      priceStart: closes[0],
      priceEnd: closes[closes.length - 1],
    },
  };
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

function linReg(xs, ys) {
  const n = xs.length;
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
  if (d === 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const yMean = sy / n;
  const intercept = (sy - slope * sx) / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - intercept - slope * xs[i]) ** 2;
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

// =========================================================================
// TEST CASES
// =========================================================================

const TEST_CASES = [
  // POSITIVE: Known accumulation periods that preceded breakouts
  {
    symbol: 'RKLB',
    from: '2025-02-26',
    to: '2025-04-07',
    preFrom: '2025-01-26',
    expected: true,
    label: 'RKLB Feb-Apr 2025 (user-identified accumulation)',
  },
  {
    symbol: 'ASTS',
    from: '2024-09-20',
    to: '2024-11-07',
    preFrom: '2024-08-20',
    expected: true,
    label: 'ASTS Sep-Nov 2024 (VD RSI divergence confirmed earlier)',
  },
  {
    symbol: 'ASTS',
    from: '2024-11-07',
    to: '2025-01-31',
    preFrom: '2024-10-07',
    expected: true,
    label: 'ASTS Nov 2024-Jan 2025 (key episode)',
  },
  {
    symbol: 'RKLB',
    from: '2024-12-01',
    to: '2025-01-21',
    preFrom: '2024-11-01',
    expected: true,
    label: 'RKLB Dec 2024-Jan 2025 consolidation',
  },

  // NEGATIVE examples: price declines where no breakout followed (or decline continued)
  // We'll also test some "random" consolidation that didn't work
  {
    symbol: 'RKLB',
    from: '2026-01-16',
    to: '2026-02-14',
    preFrom: '2025-12-16',
    expected: false,
    label: 'RKLB Jan-Feb 2026 (current — unknown outcome, declining)',
  },
];

// =========================================================================
// MAIN
// =========================================================================

async function main() {
  console.log('=== Volume Delta Accumulation Divergence Algorithm ===\n');

  const results = [];

  for (const tc of TEST_CASES) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  ${tc.label}`);
    console.log(`  ${tc.symbol} ${tc.from} → ${tc.to} (expected: ${tc.expected ? 'POSITIVE' : 'NEGATIVE/UNKNOWN'})`);
    console.log(`${'═'.repeat(80)}`);

    try {
      // Fetch 1m data: pre-context + consolidation
      const bars1m = await fetch1mChunked(tc.symbol, tc.preFrom, tc.to);

      const consolStart = new Date(tc.from + 'T00:00:00Z').getTime() / 1000;
      const consolEnd = new Date(tc.to + 'T23:59:59Z').getTime() / 1000;
      const preEnd = consolStart - 1;

      const preContextBars = bars1m.filter((b) => b.time < consolStart);
      const consolBars = bars1m.filter((b) => b.time >= consolStart && b.time <= consolEnd);

      console.log(`\n  Pre-context: ${preContextBars.length} 1m bars`);
      console.log(`  Consolidation: ${consolBars.length} 1m bars`);

      if (consolBars.length > 0) {
        console.log(
          `  Price: $${consolBars[0].close.toFixed(2)} → $${consolBars[consolBars.length - 1].close.toFixed(2)}`,
        );
      }

      const result = computeAccumulationDivergence(consolBars, preContextBars);

      console.log(`\n  ALGORITHM RESULT:`);
      console.log(`    COMPOSITE SCORE: ${result.score.toFixed(4)}`);
      console.log(`    DETECTED: ${result.detected ? '✅ YES' : '❌ NO'} (threshold: 0.35)`);
      console.log(`    Reason: ${result.reason}`);

      if (result.details.divergence) {
        const d = result.details;
        console.log(`\n    METRIC BREAKDOWN:`);
        console.log(`      1. Price-Delta Divergence:  ${d.divergence.score.toFixed(4)} (weight 0.30)`);
        console.log(`         Price slope: ${d.divergence.priceSlopeNorm.toFixed(4)}%/day`);
        console.log(`         Delta slope: ${d.divergence.deltaSlopeNorm.toFixed(4)} (normalized)`);
        console.log(`      2. Net Accumulation:        ${d.accumulation.score.toFixed(4)} (weight 0.20)`);
        console.log(`         Net delta: ${d.accumulation.netDeltaPct.toFixed(3)}% of volume`);
        console.log(`         Delta shift vs pre: ${d.accumulation.deltaShift.toFixed(4)}`);
        console.log(`      3. VD RSI Divergence:       ${d.vdRsiDiv.score.toFixed(4)} (weight 0.20)`);
        console.log(`      4. Accumulation Spikes:     ${d.spikes.score.toFixed(4)} (weight 0.10)`);
        console.log(`         Spike days: ${d.spikes.days} (${d.spikes.pct.toFixed(1)}% of trading days)`);
        console.log(`      5. Volume Decline:          ${d.volDecline.score.toFixed(4)} (weight 0.10)`);
        console.log(`         Vol slope: ${d.volDecline.slope.toFixed(6)}`);
        console.log(`      6. Price Structure:         ${d.priceStructure.score.toFixed(4)} (weight 0.10)`);
        console.log(`         Price change: ${d.priceStructure.changePct.toFixed(2)}%`);
        console.log(`\n      WEIGHTED COMPOSITE: ${d.composite.toFixed(4)}`);
      }

      const correct = result.detected === tc.expected || tc.label.includes('unknown');
      console.log(`\n    Match expected: ${correct ? '✅' : '⚠️ MISMATCH'}`);

      results.push({
        label: tc.label,
        expected: tc.expected,
        detected: result.detected,
        score: result.score,
        correct,
        details: result.details,
      });
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  // === SUMMARY ===
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`ALGORITHM VALIDATION SUMMARY`);
  console.log(`${'═'.repeat(80)}\n`);

  console.log(`${'Label'.padEnd(55)} ${'Expected'.padEnd(10)} ${'Detected'.padEnd(10)} ${'Score'.padEnd(8)} Match`);
  console.log(`${'─'.repeat(95)}`);
  for (const r of results) {
    console.log(
      `${r.label.slice(0, 54).padEnd(55)} ${(r.expected ? 'YES' : 'NO').padEnd(10)} ${(r.detected ? 'YES' : 'NO').padEnd(10)} ${r.score.toFixed(4).padEnd(8)} ${r.correct ? '✅' : '⚠️'}`,
    );
  }

  const accuracy = results.filter((r) => r.correct).length / results.length;
  console.log(
    `\nAccuracy: ${results.filter((r) => r.correct).length}/${results.length} (${(accuracy * 100).toFixed(0)}%)`,
  );

  // === ALGORITHM SPECIFICATION ===
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`PROPOSED ALGORITHM SPECIFICATION`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`
The "Accumulation Divergence" detection algorithm measures hidden buying pressure
during price consolidation/decline periods, using 1-minute volume delta data.

INPUT: 1m bars for a consolidation window + 30-day pre-context
OUTPUT: Score 0.0-1.0 and boolean detection (threshold 0.35)

6 METRICS (weighted composite):

1. PRICE-DELTA DIVERGENCE (30%)
   - Linear regression slope of daily price vs cumulative daily delta
   - Core signal: price declining while delta accumulating
   - Full score when delta slope is positive while price slope is negative

2. NET ACCUMULATION (20%)
   - Net volume delta as % of total volume
   - Positive net delta during price decline = institutional buying
   - Compared to pre-consolidation context for shift detection

3. VD RSI DIVERGENCE (20%)
   - RSI(14) applied to cumulative daily delta series
   - Classic divergence: VD RSI rising while price declining
   - Quarter-low comparison for robustness against noise

4. ACCUMULATION SPIKES (10%)
   - Count of days where daily delta is strongly positive but price closed down
   - "Hidden buying" - institutions absorbing selling pressure
   - Normalized as % of trading days

5. VOLUME DECLINE (10%)
   - Log-linear slope of daily volume over consolidation
   - Declining volume = selling exhaustion
   - Bullish sign during consolidation

6. PRICE STRUCTURE (10%)
   - Consolidation depth: moderate decline (5-20%) scores highest
   - Too deep (>40%) suggests breakdown, not consolidation
   - Flat/slight rise scores lower (less setup quality)

THRESHOLD: composite >= 0.35 → detected
`);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

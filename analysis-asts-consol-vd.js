#!/usr/bin/env node
/**
 * Deep analysis of ASTS 11/7/24 - 1/31/25 consolidation
 *
 * Focus: Cumulative Volume Delta, VD RSI, VD RSI divergence with price
 * Using 1-min data stream.
 *
 * Also do the same for RKLB's consolidation episodes for comparison.
 */

require('dotenv').config();

const DATA_API_KEY = process.env.DATA_API_KEY;
const BASE = 'https://api.massive.com';

async function fetchBars(symbol, multiplier, timespan, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
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

// =========================================================================
// VOLUME DELTA COMPUTATION
// =========================================================================

/**
 * Per-bar delta: positive volume if bullish candle, negative if bearish
 */
function barDelta(b) {
  if (b.close > b.open) return b.volume;
  if (b.close < b.open) return -b.volume;
  return 0;
}

/**
 * RSI calculation (Wilder smoothing)
 */
function computeRSI(values, period = 14) {
  const rsi = new Array(values.length).fill(NaN);
  if (values.length < period + 1) return rsi;

  // Initial average gain/loss
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

/**
 * Compute rolling cumulative delta in chunks:
 * - Per-bar delta (1m)
 * - Cumulative delta over the period
 * - Daily delta (sum of 1m deltas per day)
 * - Weekly delta (sum of daily deltas per week)
 * - VD RSI (RSI applied to cumulative delta series)
 */
function analyzeVolumeStructure(bars1m) {
  // Per-bar delta
  const deltas = bars1m.map(barDelta);

  // Cumulative delta
  const cumDelta = [];
  let running = 0;
  for (const d of deltas) {
    running += d;
    cumDelta.push(running);
  }

  // Daily delta aggregation
  const dailyMap = new Map();
  const dailyCloseMap = new Map();
  const dailyHighMap = new Map();
  const dailyLowMap = new Map();
  for (let i = 0; i < bars1m.length; i++) {
    const d = toDate(bars1m[i].time);
    const prev = dailyMap.get(d) || 0;
    dailyMap.set(d, prev + deltas[i]);
    // Track daily OHLC
    const prevClose = dailyCloseMap.get(d);
    dailyCloseMap.set(d, bars1m[i].close); // last bar's close
    const prevHigh = dailyHighMap.get(d) || -Infinity;
    dailyHighMap.set(d, Math.max(prevHigh, bars1m[i].high));
    const prevLow = dailyLowMap.get(d) || Infinity;
    dailyLowMap.set(d, Math.min(prevLow, bars1m[i].low));
  }

  const dailyDates = [...dailyMap.keys()].sort();
  const dailyDeltas = dailyDates.map((d) => dailyMap.get(d));
  const dailyCloses = dailyDates.map((d) => dailyCloseMap.get(d));

  // Cumulative daily delta
  const cumDailyDelta = [];
  let dailyRunning = 0;
  for (const d of dailyDeltas) {
    dailyRunning += d;
    cumDailyDelta.push(dailyRunning);
  }

  // Weekly aggregation
  const weeklyMap = new Map();
  for (const [date, delta] of dailyMap.entries()) {
    const weekStart = getWeekStart(date);
    const prev = weeklyMap.get(weekStart) || 0;
    weeklyMap.set(weekStart, prev + delta);
  }
  const weeklyDates = [...weeklyMap.keys()].sort();
  const weeklyDeltas = weeklyDates.map((d) => weeklyMap.get(d));

  // Cumulative weekly delta
  const cumWeeklyDelta = [];
  let weeklyRunning = 0;
  for (const d of weeklyDeltas) {
    weeklyRunning += d;
    cumWeeklyDelta.push(weeklyRunning);
  }

  // VD RSI (RSI on cumulative daily delta)
  const vdRsi14 = computeRSI(cumDailyDelta, 14);

  // Also compute VD RSI on rolling hourly delta (60-bar rolling sum)
  const hourlyDelta = [];
  for (let i = 59; i < deltas.length; i++) {
    let sum = 0;
    for (let j = i - 59; j <= i; j++) sum += deltas[j];
    hourlyDelta.push(sum);
  }
  const vdRsiHourly = computeRSI(hourlyDelta, 14);

  return {
    dailyDates,
    dailyDeltas,
    dailyCloses,
    cumDailyDelta,
    weeklyDates,
    weeklyDeltas,
    cumWeeklyDelta,
    vdRsi14,
    totalBars: bars1m.length,
    totalCumDelta: running,
    hourlyDeltaSeries: hourlyDelta,
    vdRsiHourly,
  };
}

function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().split('T')[0];
}

// =========================================================================
// DIVERGENCE DETECTION: VD RSI rising while price falling
// =========================================================================

function detectVDRSIDivergence(dailyCloses, vdRsi14, dailyDates) {
  /**
   * Classic bullish divergence:
   * - Price makes lower lows (or downtrend)
   * - VD RSI makes higher lows (or uptrend)
   *
   * Check thirds, halves, and overall slope
   */

  const validIndices = [];
  for (let i = 0; i < vdRsi14.length; i++) {
    if (Number.isFinite(vdRsi14[i]) && Number.isFinite(dailyCloses[i])) {
      validIndices.push(i);
    }
  }
  if (validIndices.length < 10) return { divergence: false, reason: 'Not enough valid data' };

  const validCloses = validIndices.map((i) => dailyCloses[i]);
  const validRsi = validIndices.map((i) => vdRsi14[i]);
  const validDates = validIndices.map((i) => dailyDates[i]);

  // Overall slope (linear regression)
  const n = validCloses.length;
  const xs = validCloses.map((_, i) => i);

  const priceSlope = linReg(xs, validCloses).slope;
  const rsiSlope = linReg(xs, validRsi).slope;
  const priceTrend = priceSlope < 0 ? 'declining' : 'rising';
  const rsiTrend = rsiSlope > 0 ? 'rising' : 'declining';

  // Halves comparison
  const half = Math.floor(n / 2);
  const firstHalfPriceAvg = validCloses.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const secondHalfPriceAvg = validCloses.slice(half).reduce((s, v) => s + v, 0) / (n - half);
  const firstHalfRsiAvg = validRsi.slice(0, half).reduce((s, v) => s + v, 0) / half;
  const secondHalfRsiAvg = validRsi.slice(half).reduce((s, v) => s + v, 0) / (n - half);

  // Quarters comparison — look at low points
  const q = Math.floor(n / 4);
  const q1PriceLow = Math.min(...validCloses.slice(0, q));
  const q4PriceLow = Math.min(...validCloses.slice(3 * q));
  const q1RsiLow = Math.min(...validRsi.slice(0, q));
  const q4RsiLow = Math.min(...validRsi.slice(3 * q));

  const priceLowerLow = q4PriceLow < q1PriceLow;
  const rsiHigherLow = q4RsiLow > q1RsiLow;

  // Start/end VD RSI values
  const startRsi = validRsi.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
  const endRsi = validRsi.slice(-5).reduce((s, v) => s + v, 0) / 5;

  const isBullishDivergence = (priceSlope < 0 && rsiSlope > 0) || (priceLowerLow && rsiHigherLow);

  return {
    divergence: isBullishDivergence,
    priceSlope: priceSlope,
    rsiSlope: rsiSlope,
    priceTrend,
    rsiTrend,
    halfComparison: {
      firstHalfPriceAvg: firstHalfPriceAvg.toFixed(2),
      secondHalfPriceAvg: secondHalfPriceAvg.toFixed(2),
      firstHalfRsiAvg: firstHalfRsiAvg.toFixed(1),
      secondHalfRsiAvg: secondHalfRsiAvg.toFixed(1),
    },
    quarterLows: {
      q1PriceLow: q1PriceLow.toFixed(2),
      q4PriceLow: q4PriceLow.toFixed(2),
      priceLowerLow,
      q1RsiLow: q1RsiLow.toFixed(1),
      q4RsiLow: q4RsiLow.toFixed(1),
      rsiHigherLow,
    },
    startEndRsi: {
      start: startRsi.toFixed(1),
      end: endRsi.toFixed(1),
    },
    validDays: n,
    dateRange: `${validDates[0]} → ${validDates[n - 1]}`,
  };
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
  if (d === 0) return { slope: 0 };
  return { slope: (n * sxy - sx * sy) / d };
}

// =========================================================================
// CONSOLIDATION PERIODS TO ANALYZE
// =========================================================================

const EPISODES = [
  { symbol: 'ASTS', label: 'ASTS Nov 2024 → Jan 2025 (KEY EPISODE)', from: '2024-11-07', to: '2025-01-31' },
  { symbol: 'ASTS', label: 'ASTS Jun → Aug 2025 consolidation', from: '2025-06-15', to: '2025-08-30' },
  { symbol: 'ASTS', label: 'ASTS Sep-Oct 2024 post-run consolidation', from: '2024-09-20', to: '2024-11-15' },
  { symbol: 'RKLB', label: 'RKLB Dec 2024 → Jan 2025 consolidation', from: '2024-12-01', to: '2025-01-21' },
  { symbol: 'RKLB', label: 'RKLB Jul → Sep 2025 consolidation', from: '2025-07-17', to: '2025-10-03' },
  { symbol: 'RKLB', label: 'RKLB Jan → Feb 2026 consolidation (current)', from: '2026-01-16', to: '2026-02-14' },
];

// =========================================================================
// MAIN
// =========================================================================

async function main() {
  console.log('=== VOLUME DELTA + VD RSI ANALYSIS ===\n');
  console.log('Hypothesis: During bullish consolidation, price declines but cumulative');
  console.log('volume delta (1m) is positive/accumulating, and VD RSI rises while price falls.\n');

  for (const ep of EPISODES) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  ${ep.label}`);
    console.log(`  ${ep.from} → ${ep.to}`);
    console.log(`${'═'.repeat(80)}`);

    // Fetch 1m data — need context before consolidation too
    const contextStart = new Date(ep.from);
    contextStart.setDate(contextStart.getDate() - 30);
    const contextFrom = contextStart.toISOString().split('T')[0];

    let bars1m;
    try {
      bars1m = await fetch1mChunked(ep.symbol, contextFrom, ep.to);
    } catch (err) {
      console.log(`  FETCH FAILED: ${err.message}`);
      continue;
    }

    // Filter to just the consolidation period
    const fromTs = new Date(ep.from + 'T00:00:00Z').getTime() / 1000;
    const toTs = new Date(ep.to + 'T23:59:59Z').getTime() / 1000;
    const consolBars = bars1m.filter((b) => b.time >= fromTs && b.time <= toTs);

    if (consolBars.length < 100) {
      console.log(`  Only ${consolBars.length} 1m bars — insufficient`);
      continue;
    }

    console.log(`\n  Data: ${consolBars.length} 1m bars`);
    console.log(
      `  Price: $${consolBars[0].close.toFixed(2)} → $${consolBars[consolBars.length - 1].close.toFixed(2)} (${((consolBars[consolBars.length - 1].close / consolBars[0].close - 1) * 100).toFixed(1)}%)`,
    );

    // Analyze volume structure
    const vs = analyzeVolumeStructure(consolBars);

    // === CUMULATIVE DELTA ===
    console.log(`\n  CUMULATIVE VOLUME DELTA:`);
    console.log(
      `    Total cumulative delta: ${(vs.totalCumDelta / 1e6).toFixed(2)}M ${vs.totalCumDelta > 0 ? '(NET BUYING)' : '(NET SELLING)'}`,
    );
    console.log(`    Total volume: ${(consolBars.reduce((s, b) => s + b.volume, 0) / 1e6).toFixed(2)}M`);
    console.log(
      `    Delta as % of volume: ${((vs.totalCumDelta / consolBars.reduce((s, b) => s + b.volume, 0)) * 100).toFixed(2)}%`,
    );

    // Daily delta table
    console.log(`\n    DAILY DELTA BREAKDOWN:`);
    console.log(
      `    ${'Date'.padEnd(12)} ${'Delta'.padStart(14)} ${'Cum Delta'.padStart(14)} ${'Close'.padStart(8)} ${'VD RSI'.padStart(8)}`,
    );
    console.log(`    ${'─'.repeat(60)}`);

    for (let i = 0; i < vs.dailyDates.length; i++) {
      const delta = vs.dailyDeltas[i];
      const cumD = vs.cumDailyDelta[i];
      const close = vs.dailyCloses[i];
      const rsi = vs.vdRsi14[i];
      console.log(
        `    ${vs.dailyDates[i].padEnd(12)} ${(delta >= 0 ? '+' : '') + (delta / 1e6).toFixed(3) + 'M'}${' '.repeat(Math.max(0, 9 - ((delta / 1e6).toFixed(3).length + 1)))} ${(cumD >= 0 ? '+' : '') + (cumD / 1e6).toFixed(3) + 'M'}${' '.repeat(Math.max(0, 9 - ((cumD / 1e6).toFixed(3).length + 1)))} $${close?.toFixed(2) || 'N/A'} ${Number.isFinite(rsi) ? rsi.toFixed(1) : '--'}`,
      );
    }

    // Weekly summary
    console.log(`\n    WEEKLY DELTA SUMMARY:`);
    for (let i = 0; i < vs.weeklyDates.length; i++) {
      const wd = vs.weeklyDeltas[i];
      const cwd = vs.cumWeeklyDelta[i];
      console.log(
        `    Week of ${vs.weeklyDates[i]}: ${wd >= 0 ? '+' : ''}${(wd / 1e6).toFixed(3)}M  (cum: ${cwd >= 0 ? '+' : ''}${(cwd / 1e6).toFixed(3)}M)`,
      );
    }

    // === CHUNKS: split consolidation into 3 equal parts ===
    console.log(`\n    THIRDS ANALYSIS (consolidation split into 3 equal chunks):`);
    const thirdSize = Math.floor(vs.dailyDates.length / 3);
    if (thirdSize >= 2) {
      for (let t = 0; t < 3; t++) {
        const start = t * thirdSize;
        const end = t === 2 ? vs.dailyDates.length : (t + 1) * thirdSize;
        const chunk = vs.dailyDeltas.slice(start, end);
        const chunkSum = chunk.reduce((s, v) => s + v, 0);
        const chunkCloses = vs.dailyCloses.slice(start, end);
        const chunkStartPrice = chunkCloses[0];
        const chunkEndPrice = chunkCloses[chunkCloses.length - 1];
        const chunkRsi = vs.vdRsi14.slice(start, end).filter(Number.isFinite);
        const avgRsi = chunkRsi.length > 0 ? chunkRsi.reduce((s, v) => s + v, 0) / chunkRsi.length : NaN;
        console.log(
          `    Part ${t + 1} (${vs.dailyDates[start]}→${vs.dailyDates[end - 1]}): delta ${chunkSum >= 0 ? '+' : ''}${(chunkSum / 1e6).toFixed(3)}M, price $${chunkStartPrice?.toFixed(2)}→$${chunkEndPrice?.toFixed(2)}, avg VD RSI ${Number.isFinite(avgRsi) ? avgRsi.toFixed(1) : 'N/A'}`,
        );
      }
    }

    // === VD RSI DIVERGENCE ===
    const divResult = detectVDRSIDivergence(vs.dailyCloses, vs.vdRsi14, vs.dailyDates);
    console.log(`\n  VD RSI DIVERGENCE ANALYSIS:`);
    console.log(`    Bullish divergence detected: ${divResult.divergence ? '✅ YES' : '❌ NO'}`);
    console.log(`    Price trend: ${divResult.priceTrend} (slope: ${divResult.priceSlope?.toFixed(4) || 'N/A'})`);
    console.log(`    VD RSI trend: ${divResult.rsiTrend} (slope: ${divResult.rsiSlope?.toFixed(4) || 'N/A'})`);
    console.log(
      `    Half comparison: price ${divResult.halfComparison.firstHalfPriceAvg}→${divResult.halfComparison.secondHalfPriceAvg}, VD RSI ${divResult.halfComparison.firstHalfRsiAvg}→${divResult.halfComparison.secondHalfRsiAvg}`,
    );
    console.log(
      `    Quarter lows: price Q1 $${divResult.quarterLows.q1PriceLow} vs Q4 $${divResult.quarterLows.q4PriceLow} (${divResult.quarterLows.priceLowerLow ? 'lower low' : 'higher low'})`,
    );
    console.log(
      `    Quarter lows: VD RSI Q1 ${divResult.quarterLows.q1RsiLow} vs Q4 ${divResult.quarterLows.q4RsiLow} (${divResult.quarterLows.rsiHigherLow ? 'higher low ✅' : 'lower low'})`,
    );
    console.log(`    VD RSI start/end: ${divResult.startEndRsi.start} → ${divResult.startEndRsi.end}`);

    // === PRICE vs CUMULATIVE DELTA CORRELATION ===
    // Key question: while price goes down, does cumulative delta go up?
    const validPairs = [];
    for (let i = 0; i < vs.dailyDates.length; i++) {
      if (Number.isFinite(vs.dailyCloses[i]) && Number.isFinite(vs.cumDailyDelta[i])) {
        validPairs.push({ price: vs.dailyCloses[i], cumDelta: vs.cumDailyDelta[i] });
      }
    }
    if (validPairs.length >= 5) {
      const prices = validPairs.map((p) => p.price);
      const cumDeltas = validPairs.map((p) => p.cumDelta);
      // Correlation
      const n = prices.length;
      const meanP = prices.reduce((s, v) => s + v, 0) / n;
      const meanD = cumDeltas.reduce((s, v) => s + v, 0) / n;
      let cov = 0,
        varP = 0,
        varD = 0;
      for (let i = 0; i < n; i++) {
        cov += (prices[i] - meanP) * (cumDeltas[i] - meanD);
        varP += (prices[i] - meanP) ** 2;
        varD += (cumDeltas[i] - meanD) ** 2;
      }
      const corr = varP > 0 && varD > 0 ? cov / Math.sqrt(varP * varD) : 0;
      console.log(
        `\n  PRICE vs CUMULATIVE DELTA CORRELATION: ${corr.toFixed(4)} ${corr < -0.3 ? '(NEGATIVE = bullish accumulation ✅)' : corr > 0.3 ? '(POSITIVE = price-following)' : '(WEAK)'}`,
      );
    }
  }

  // === SUMMARY ===
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log(`SUMMARY: WHAT CHARACTERIZES BULLISH CONSOLIDATION?`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`
If the hypothesis holds across episodes, we should see:
1. Cumulative Volume Delta positive or accumulating (net buying) during price decline
2. VD RSI rising while price declines (bullish divergence)
3. Negative correlation between price and cumulative delta
4. Higher VD RSI lows even as price makes lower lows

These patterns would indicate "smart money accumulation" during consolidation,
predicting the next bullish leg.

POTENTIAL ALGORITHM ADDITIONS for moderate HTF:
- Compute cumulative 1m volume delta during consolidation → net delta as % of total volume
- Compute VD RSI (14-period on cumulative daily delta) → check for rising trend
- Detect VD RSI / price divergence (price slope negative, VD RSI slope positive)
- Score based on strength of divergence (slope ratio, correlation coefficient)
`);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * VD Accumulation Algorithm v3 — Production-Ready Design
 *
 * Key design principles from user:
 *   1. Detectable after 2+ weeks of accumulation
 *   2. Score grows as pattern persists for more weeks
 *   3. Individual aberration days (1-2) should NOT nuke the signal
 *   4. Uses weekly-level smoothing to be robust against daily noise
 *
 * Core features (from v2 discrimination analysis):
 *   - netDeltaPct > 0 (positive net buying during price decline)
 *   - deltaSlopeNorm > 0 (cumulative delta trend rising)
 *   - deltaShiftVsPre > 0 (buying stronger than pre-context)
 *   - largeBuyVsSell > 0 (more large buy days than sell days)
 *   - strongAbsorptionPct > 5% (buying into price weakness)
 *   - priceDeltaCorr < 0 (price & delta diverging)
 */

require('dotenv').config();

const DATA_API_KEY = process.env.DATA_API_KEY;
const BASE = 'https://api.massive.com';

async function fetchBars(symbol, mult, ts, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${mult}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.results || []).map(r => ({
    time: Math.floor((r.t || 0) / 1000),
    open: r.o, high: r.h, low: r.l, close: r.c,
    volume: r.v || 0
  })).filter(b => Number.isFinite(b.time) && Number.isFinite(b.close));
}

async function fetch1mChunked(symbol, from, to) {
  const all = [];
  let cursor = new Date(from);
  const end = new Date(to);
  while (cursor < end) {
    const cEnd = new Date(cursor); cEnd.setDate(cEnd.getDate() + 25);
    if (cEnd > end) cEnd.setTime(end.getTime());
    const f = cursor.toISOString().split('T')[0];
    const t = cEnd.toISOString().split('T')[0];
    process.stdout.write(`  1m ${symbol} ${f}→${t}...`);
    const bars = await fetchBars(symbol, 1, 'minute', f, t);
    process.stdout.write(` ${bars.length}\n`);
    all.push(...bars);
    await new Promise(r => setTimeout(r, 250));
    cursor = new Date(cEnd); cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function toDate(ts) { return new Date(ts * 1000).toISOString().split('T')[0]; }

function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] ** 2; sxy += xs[i] * ys[i]; }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  const intercept = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) { ssTot += (ys[i] - yMean) ** 2; ssRes += (ys[i] - intercept - slope * xs[i]) ** 2; }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

// =========================================================================
// v3 ALGORITHM: Weekly-smoothed, duration-scaling accumulation detector
// =========================================================================

/**
 * Aggregate 1m bars into WEEKLY buckets (Mon-Fri).
 * Each week: { buyVol, sellVol, totalVol, delta, priceStart, priceEnd, priceHigh, priceLow, nDays }
 */
function aggregateWeekly(bars1m) {
  // First aggregate to daily
  const dailyMap = new Map();
  for (const b of bars1m) {
    const d = toDate(b.time);
    if (!dailyMap.has(d)) dailyMap.set(d, { buyVol: 0, sellVol: 0, totalVol: 0, close: 0, open: 0, high: -Infinity, low: Infinity, first: true });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : (b.close < b.open ? -b.volume : 0);
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.close = b.close;
    if (day.first) { day.open = b.open; day.first = false; }
    day.high = Math.max(day.high, b.high);
    day.low = Math.min(day.low, b.low);
  }

  const dates = [...dailyMap.keys()].sort();
  const daily = dates.map(d => {
    const day = dailyMap.get(d);
    return { date: d, delta: day.buyVol - day.sellVol, totalVol: day.totalVol, buyVol: day.buyVol, sellVol: day.sellVol,
             close: day.close, open: day.open, high: day.high, low: day.low };
  });

  // Group into weeks (ISO week: Mon-Sun)
  const weekMap = new Map();
  for (const d of daily) {
    const dt = new Date(d.date + 'T12:00:00Z');
    const dayOfWeek = dt.getUTCDay();
    const monday = new Date(dt);
    monday.setUTCDate(monday.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const weekKey = monday.toISOString().split('T')[0];

    if (!weekMap.has(weekKey)) weekMap.set(weekKey, { days: [] });
    weekMap.get(weekKey).days.push(d);
  }

  const weeks = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, { days }]) => {
    const buyVol = days.reduce((s, d) => s + d.buyVol, 0);
    const sellVol = days.reduce((s, d) => s + d.sellVol, 0);
    const totalVol = days.reduce((s, d) => s + d.totalVol, 0);
    return {
      weekStart,
      delta: buyVol - sellVol,
      totalVol,
      buyVol,
      sellVol,
      deltaPct: totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0,
      priceStart: days[0].open,
      priceEnd: days[days.length - 1].close,
      priceHigh: Math.max(...days.map(d => d.high)),
      priceLow: Math.min(...days.map(d => d.low)),
      nDays: days.length,
      priceChangePct: ((days[days.length - 1].close - days[0].open) / days[0].open) * 100,
    };
  });

  return { daily, weeks };
}

/**
 * Core accumulation divergence scoring — v3 production algorithm.
 *
 * INPUT:  consolBars1m (1m bars for candidate window), preBars1m (1m bars for pre-context)
 * OUTPUT: { score, detected, weeks, metrics }
 *
 * Uses weekly smoothing: each metric computed at weekly level to resist daily noise.
 * Score scales with number of qualifying weeks.
 */
function scoreAccumulationDivergence(consolBars1m, preBars1m) {
  const { daily, weeks } = aggregateWeekly(consolBars1m);

  if (weeks.length < 2) return { score: 0, detected: false, reason: 'need_2_weeks', weeks: 0, metrics: {} };

  const totalVol = daily.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / daily.length;
  const closes = daily.map(d => d.close);
  const avgPrice = closes.reduce((s, v) => s + v, 0) / closes.length;

  // ── PRICE CHECK: must be declining or flat (not rallying) ──
  const overallPriceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  if (overallPriceChange > 10) {
    return { score: 0, detected: false, reason: 'price_rising', weeks: weeks.length, metrics: { priceChangePct: overallPriceChange } };
  }
  // Reject crashes (>45% decline — not consolidation)
  if (overallPriceChange < -45) {
    return { score: 0, detected: false, reason: 'crash', weeks: weeks.length, metrics: { priceChangePct: overallPriceChange } };
  }

  // ── PRE-CONTEXT BASELINE ──
  const preAgg = aggregateWeekly(preBars1m);
  const preAvgDelta = preAgg.daily.length > 0
    ? preAgg.daily.reduce((s, d) => s + d.delta, 0) / preAgg.daily.length : 0;
  const preAvgVol = preAgg.daily.length > 0
    ? preAgg.daily.reduce((s, d) => s + d.totalVol, 0) / preAgg.daily.length : avgDailyVol;

  // =========================================================================
  // WEEKLY-LEVEL METRICS (robust to daily noise)
  // =========================================================================

  // Count "accumulation weeks" — weeks where delta is positive despite price decline
  let accumWeeks = 0;
  let totalWeeks = weeks.length;
  for (const w of weeks) {
    if (w.deltaPct > 0) accumWeeks++;
  }
  const accumWeekRatio = accumWeeks / totalWeeks;

  // Weekly delta %s — for trend analysis
  const weeklyDeltaPcts = weeks.map(w => w.deltaPct);
  const weeklyXs = weeks.map((_, i) => i);

  // ── METRIC 1: Net Delta % (whole period) ──
  // Positive = net accumulation during price decline
  const netDelta = daily.reduce((s, d) => s + d.delta, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

  // ── METRIC 2: Delta slope (weekly-smoothed) ──
  // Cumulative weekly delta trend — is accumulation building?
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const w of weeks) { cwd += w.delta; cumWeeklyDelta.push(cwd); }
  const weeklyDeltaSlope = linReg(weeklyXs, cumWeeklyDelta);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / totalWeeks;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (weeklyDeltaSlope.slope / avgWeeklyVol) * 100 : 0;

  // ── METRIC 3: Delta shift vs pre-context ──
  // Is buying stronger now than before the consolidation started?
  const consolAvgDailyDelta = netDelta / daily.length;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  // ── METRIC 4: Absorption ratio (weekly-smoothed) ──
  // Days where price closed down but daily delta was positive
  let absorptionDays = 0;
  let strongAbsorptionDays = 0;
  for (let i = 1; i < daily.length; i++) {
    const priceDown = daily[i].close < daily[i - 1].close;
    if (priceDown && daily[i].delta > 0) absorptionDays++;
    if (priceDown && daily[i].delta > avgDailyVol * 0.05) strongAbsorptionDays++;
  }
  const absorptionPct = daily.length > 1 ? (absorptionDays / (daily.length - 1)) * 100 : 0;
  const strongAbsorptionPct = daily.length > 1 ? (strongAbsorptionDays / (daily.length - 1)) * 100 : 0;

  // ── METRIC 5: Large buy vs sell day ratio ──
  const largeBuyDays = daily.filter(d => d.delta > avgDailyVol * 0.10).length;
  const largeSellDays = daily.filter(d => d.delta < -avgDailyVol * 0.10).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / daily.length) * 100;

  // ── METRIC 6: Price-cumDelta correlation ──
  // Negative correlation = price down while delta up (divergence)
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

  // =========================================================================
  // COMPOSITE SCORING (with weekly smoothing and duration scaling)
  // =========================================================================

  // Each metric maps to a 0-1 score. Use sigmoid-like clamping.
  // Key insight: use MULTIPLICATIVE gates for critical metrics + ADDITIVE for supporting.

  // GATE 1: Net delta must not be deeply negative (allow slight negative for robustness)
  // If net delta is very negative, it's concordant selling, not accumulation.
  const gateNetDelta = netDeltaPct > -1.5; // Allow up to -1.5% (daily noise tolerance)

  // GATE 2: Price must be declining or flat
  const gatePriceDecline = overallPriceChange < 5 && overallPriceChange > -45;

  if (!gateNetDelta || !gatePriceDecline) {
    return {
      score: 0, detected: false,
      reason: !gateNetDelta ? 'concordant_selling' : 'invalid_price_structure',
      weeks: totalWeeks,
      metrics: { netDeltaPct, overallPriceChange }
    };
  }

  // ── Score components ──

  // S1: Net Delta Score (25%) — how positive is net delta?
  // Range: -1.5% to +5% maps to 0 → 1
  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5));

  // S2: Delta Slope Score (20%) — is cumulative delta trending up?
  // Normalized slope > 0 is good, > 2 is great
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4));

  // S3: Delta Shift vs Pre-Context (15%) — buying stronger than pre-period?
  // > 0 = positive shift, > 5 = strong shift
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8));

  // S4: Strong Absorption Days (15%) — buying into weakness
  // > 5% is good, > 15% is strong
  const s4 = Math.max(0, Math.min(1, strongAbsorptionPct / 18));

  // S5: Large Buy vs Sell Ratio (10%)
  // Positive = more large buy days. > 5 is strong
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12));

  // S6: Price-Delta Anti-Correlation (10%)
  // Negative correlation is the divergence signal. -0.5 to -1 is strong
  const s6 = Math.max(0, Math.min(1, (-priceDeltaCorr + 0.3) / 1.5));

  // S7: Accumulation Week Ratio (5%)
  // What fraction of weeks showed positive delta?
  const s7 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6));

  // ── Weighted composite ──
  const rawScore =
    s1 * 0.25 +
    s2 * 0.20 +
    s3 * 0.15 +
    s4 * 0.15 +
    s5 * 0.10 +
    s6 * 0.10 +
    s7 * 0.05;

  // ── Duration scaling ──
  // Score grows from 70% at 2 weeks to 100% at 6+ weeks
  // This implements "higher score with longer accumulation"
  const durationMultiplier = Math.min(1.0, 0.70 + (totalWeeks - 2) * 0.075);

  // But also: minimum 2 weeks to trigger at all
  const score = totalWeeks >= 2 ? rawScore * durationMultiplier : 0;

  // Detection threshold
  const detected = score >= 0.30;

  return {
    score,
    detected,
    reason: detected ? 'accumulation_divergence' : 'below_threshold',
    weeks: totalWeeks,
    accumWeeks,
    durationMultiplier,
    rawScore,
    metrics: {
      netDeltaPct,
      deltaSlopeNorm,
      deltaShift,
      strongAbsorptionPct,
      largeBuyVsSell,
      priceDeltaCorr,
      accumWeekRatio,
      overallPriceChange,
      s1, s2, s3, s4, s5, s6, s7,
    },
  };
}

// =========================================================================
// TEST: Fixed-window validation
// =========================================================================

const TEST_CASES = [
  // POSITIVE — confirmed accumulation → breakout
  { symbol: 'RKLB', from: '2025-02-26', to: '2025-04-07', preFrom: '2025-01-26', expected: true, label: 'RKLB Feb 26 - Apr 7 2025 (confirmed)' },
  { symbol: 'IREN', from: '2025-03-13', to: '2025-04-21', preFrom: '2025-02-13', expected: true, label: 'IREN Mar 13 - Apr 21 2025 (confirmed)' },

  // NEGATIVE controls
  { symbol: 'RKLB', from: '2026-01-06', to: '2026-02-14', preFrom: '2025-12-06', expected: false, label: 'RKLB Jan-Feb 2026 (no breakout)' },
  { symbol: 'IREN', from: '2026-01-06', to: '2026-02-14', preFrom: '2025-12-06', expected: false, label: 'IREN Jan-Feb 2026 (no breakout)' },
  { symbol: 'SMCI', from: '2024-10-01', to: '2024-11-15', preFrom: '2024-09-01', expected: false, label: 'SMCI Oct-Nov 2024 (crash)' },
  { symbol: 'RIVN', from: '2024-10-01', to: '2024-11-15', preFrom: '2024-09-01', expected: false, label: 'RIVN Oct-Nov 2024 (no breakout)' },
];

// =========================================================================
// TEST: Sliding-window — does it detect at 2, 3, 4, 5, 6 weeks?
// =========================================================================

const SLIDING_TESTS = [
  // Test RKLB at different durations from the start of accumulation
  { symbol: 'RKLB', accumStart: '2025-02-26', preFrom: '2025-01-26', label: 'RKLB accumulation buildup',
    windows: [
      { weeks: 2, to: '2025-03-12' },
      { weeks: 3, to: '2025-03-19' },
      { weeks: 4, to: '2025-03-26' },
      { weeks: 5, to: '2025-04-02' },
      { weeks: 6, to: '2025-04-07' },
    ]
  },
  // Test IREN at different durations
  { symbol: 'IREN', accumStart: '2025-03-13', preFrom: '2025-02-13', label: 'IREN accumulation buildup',
    windows: [
      { weeks: 2, to: '2025-03-27' },
      { weeks: 3, to: '2025-04-03' },
      { weeks: 4, to: '2025-04-10' },
      { weeks: 5, to: '2025-04-17' },
      { weeks: 6, to: '2025-04-21' },
    ]
  },
];

async function main() {
  console.log('=== VD Accumulation Algorithm v3 — Production Design ===');
  console.log('Weekly-smoothed, duration-scaling, aberration-resistant\n');

  // ── Part 1: Fixed-window validation ──
  console.log(`${'═'.repeat(80)}`);
  console.log('PART 1: FIXED-WINDOW VALIDATION');
  console.log(`${'═'.repeat(80)}\n`);

  const results = [];

  for (const tc of TEST_CASES) {
    console.log(`── ${tc.label} ──`);

    try {
      const bars1m = await fetch1mChunked(tc.symbol, tc.preFrom, tc.to);
      const consolStart = new Date(tc.from + 'T00:00:00Z').getTime() / 1000;
      const consolEnd = new Date(tc.to + 'T23:59:59Z').getTime() / 1000;

      const preBars = bars1m.filter(b => b.time < consolStart);
      const consolBars = bars1m.filter(b => b.time >= consolStart && b.time <= consolEnd);

      const result = scoreAccumulationDivergence(consolBars, preBars);
      const correct = result.detected === tc.expected;
      results.push({ ...tc, result, correct });

      const m = result.metrics;
      console.log(`  Score: ${result.score.toFixed(4)} (raw: ${result.rawScore?.toFixed(4) || 'N/A'}) | Weeks: ${result.weeks} | Duration mult: ${result.durationMultiplier?.toFixed(2) || 'N/A'}`);
      console.log(`  Detected: ${result.detected ? 'YES' : 'NO'} | Expected: ${tc.expected ? 'YES' : 'NO'} | ${correct ? '✅' : '⚠️ MISS'}`);
      if (m.s1 !== undefined) {
        console.log(`  Components: s1=${m.s1.toFixed(3)} s2=${m.s2.toFixed(3)} s3=${m.s3.toFixed(3)} s4=${m.s4.toFixed(3)} s5=${m.s5.toFixed(3)} s6=${m.s6.toFixed(3)} s7=${m.s7.toFixed(3)}`);
        console.log(`  Key metrics: netΔ=${m.netDeltaPct.toFixed(2)}% slope=${m.deltaSlopeNorm.toFixed(2)} shift=${m.deltaShift.toFixed(2)} abs=${m.strongAbsorptionPct.toFixed(1)}% corr=${m.priceDeltaCorr.toFixed(3)} price=${m.overallPriceChange.toFixed(1)}%`);
      }
      if (result.reason && result.reason !== 'accumulation_divergence' && result.reason !== 'below_threshold') {
        console.log(`  Reason: ${result.reason}`);
      }
      console.log();
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
    }
  }

  const accuracy = results.filter(r => r.correct).length;
  console.log(`Fixed-window accuracy: ${accuracy}/${results.length} (${((accuracy / results.length) * 100).toFixed(0)}%)\n`);

  // ── Part 2: Sliding-window — duration scaling ──
  console.log(`\n${'═'.repeat(80)}`);
  console.log('PART 2: SLIDING-WINDOW — SCORE GROWTH OVER TIME');
  console.log(`${'═'.repeat(80)}\n`);

  for (const st of SLIDING_TESTS) {
    console.log(`── ${st.label} ──`);

    try {
      // Fetch full range (pre-context to max window)
      const maxTo = st.windows[st.windows.length - 1].to;
      const bars1m = await fetch1mChunked(st.symbol, st.preFrom, maxTo);
      const consolStart = new Date(st.accumStart + 'T00:00:00Z').getTime() / 1000;
      const preBars = bars1m.filter(b => b.time < consolStart);

      for (const w of st.windows) {
        const windowEnd = new Date(w.to + 'T23:59:59Z').getTime() / 1000;
        const consolBars = bars1m.filter(b => b.time >= consolStart && b.time <= windowEnd);

        const result = scoreAccumulationDivergence(consolBars, preBars);
        const m = result.metrics;

        const bar = '█'.repeat(Math.round(result.score * 40));
        console.log(`  ${w.weeks}wk (→${w.to}): score=${result.score.toFixed(4)} ${result.detected ? '✅' : '  '} ${bar}`);
        if (m.s1 !== undefined) {
          console.log(`        netΔ=${m.netDeltaPct.toFixed(2)}% slope=${m.deltaSlopeNorm.toFixed(2)} shift=${m.deltaShift.toFixed(2)} abs=${m.strongAbsorptionPct.toFixed(1)}% corr=${m.priceDeltaCorr.toFixed(3)}`);
        }
      }
      console.log();
    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

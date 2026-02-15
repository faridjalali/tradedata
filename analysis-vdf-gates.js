/**
 * VDF Gate Testing — Test proposed gates against known positives (RKLB, IREN)
 * and known false positive (TRON) to find the right combination.
 *
 * Gates under test:
 *   Gate 2: Delta slope must not be strongly negative (cum delta trending down = reject)
 *   Gate 3: Cap outlier days (clip single-day deltas at 3σ so one spike can't dominate)
 *   Gate 4: Price-delta correlation must be negative (real divergence)
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
    const cEnd = new Date(cursor);
    cEnd.setDate(cEnd.getDate() + 25);
    if (cEnd > end) cEnd.setTime(end.getTime());
    const f = cursor.toISOString().split('T')[0];
    const t = cEnd.toISOString().split('T')[0];
    process.stdout.write(`  1m ${symbol} ${f} -> ${t}...`);
    const bars = await fetchBars(symbol, 1, 'minute', f, t);
    process.stdout.write(` ${bars.length}\n`);
    all.push(...bars);
    await new Promise(r => setTimeout(r, 300));
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// ---- VDF scoring (from vdfDetector.js) ----

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
 * Full scoring with all metrics + proposed gates output.
 * Does NOT apply gates — just reports what each gate would do.
 */
function scoreWithGateAnalysis(consolBars1m, preBars1m, label) {
  const { daily, weeks } = vdAggregateWeekly(consolBars1m);
  if (weeks.length < 2) return null;

  const totalVol = daily.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / daily.length;
  const closes = daily.map(d => d.close);
  const overallPriceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;

  // Pre-context
  const preAgg = vdAggregateWeekly(preBars1m);
  const preAvgDelta = preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.delta, 0) / preAgg.daily.length : 0;
  const preAvgVol = preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.totalVol, 0) / preAgg.daily.length : avgDailyVol;

  // === GATE 3 ANALYSIS: Outlier capping ===
  // Compute mean and std of daily deltas
  const dailyDeltas = daily.map(d => d.delta);
  const deltaMean = dailyDeltas.reduce((s, v) => s + v, 0) / dailyDeltas.length;
  const deltaVariance = dailyDeltas.reduce((s, v) => s + (v - deltaMean) ** 2, 0) / dailyDeltas.length;
  const deltaStd = Math.sqrt(deltaVariance);
  const cap3sigma = deltaMean + 3 * deltaStd;
  const capNeg3sigma = deltaMean - 3 * deltaStd;

  // Find outlier days
  const outlierDays = daily.filter(d => d.delta > cap3sigma || d.delta < capNeg3sigma);

  // Create capped daily deltas
  const cappedDailyDeltas = dailyDeltas.map(d => Math.max(capNeg3sigma, Math.min(cap3sigma, d)));
  const cappedNetDelta = cappedDailyDeltas.reduce((s, v) => s + v, 0);
  const cappedNetDeltaPct = totalVol > 0 ? (cappedNetDelta / totalVol) * 100 : 0;

  // Original net delta
  const netDelta = daily.reduce((s, d) => s + d.delta, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

  // === GATE 2 ANALYSIS: Delta slope ===
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const w of weeks) { cwd += w.delta; cumWeeklyDelta.push(cwd); }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeReg = vdLinReg(weeklyXs, cumWeeklyDelta);
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (deltaSlopeReg.slope / avgWeeklyVol) * 100 : 0;

  // Also compute daily cum delta slope
  const cumDailyDelta = [];
  let cdd = 0;
  for (const d of daily) { cdd += d.delta; cumDailyDelta.push(cdd); }
  const dailyXs = daily.map((_, i) => i);
  const dailySlopeReg = vdLinReg(dailyXs, cumDailyDelta);
  const dailySlopeNorm = avgDailyVol > 0 ? (dailySlopeReg.slope / avgDailyVol) * 100 : 0;

  // Capped cum delta slope (gate 3 + gate 2 combo)
  const cappedCumDaily = [];
  let ccdd = 0;
  for (const cd of cappedDailyDeltas) { ccdd += cd; cappedCumDaily.push(ccdd); }
  const cappedDailySlopeReg = vdLinReg(dailyXs, cappedCumDaily);
  const cappedDailySlopeNorm = avgDailyVol > 0 ? (cappedDailySlopeReg.slope / avgDailyVol) * 100 : 0;

  // === GATE 4 ANALYSIS: Price-delta correlation ===
  // Original
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

  // Capped correlation
  let cappedPriceDeltaCorr = 0;
  {
    const n = daily.length;
    const meanP = closes.reduce((s, v) => s + v, 0) / n;
    const meanD = cappedCumDaily.reduce((s, v) => s + v, 0) / n;
    let cov = 0, varP = 0, varD = 0;
    for (let i = 0; i < n; i++) {
      cov += (closes[i] - meanP) * (cappedCumDaily[i] - meanD);
      varP += (closes[i] - meanP) ** 2;
      varD += (cappedCumDaily[i] - meanD) ** 2;
    }
    cappedPriceDeltaCorr = (varP > 0 && varD > 0) ? cov / Math.sqrt(varP * varD) : 0;
  }

  // === Compute remaining metrics for full score ===
  const consolAvgDailyDelta = netDelta / daily.length;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  // Capped delta shift
  const cappedConsolAvgDailyDelta = cappedNetDelta / daily.length;
  const cappedDeltaShift = preAvgVol > 0 ? ((cappedConsolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  let strongAbsorptionDays = 0;
  for (let i = 1; i < daily.length; i++) {
    if (daily[i].close < daily[i - 1].close && daily[i].delta > avgDailyVol * 0.05) strongAbsorptionDays++;
  }
  const strongAbsorptionPct = daily.length > 1 ? (strongAbsorptionDays / (daily.length - 1)) * 100 : 0;

  const largeBuyDays = daily.filter(d => d.delta > avgDailyVol * 0.10).length;
  const largeSellDays = daily.filter(d => d.delta < -avgDailyVol * 0.10).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / daily.length) * 100;

  const accumWeeks = weeks.filter(w => w.deltaPct > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;

  let volContractionScore = 0;
  if (daily.length >= 9) {
    const dThird = Math.floor(daily.length / 3);
    const t1Ranges = daily.slice(0, dThird).map(d => ((d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0)) * 100);
    const t3Ranges = daily.slice(2 * dThird).map(d => ((d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0)) * 100);
    const avgT1 = t1Ranges.reduce((s, v) => s + v, 0) / t1Ranges.length;
    const avgT3 = t3Ranges.reduce((s, v) => s + v, 0) / t3Ranges.length;
    if (avgT1 > 0) {
      const contraction = (avgT3 - avgT1) / avgT1;
      volContractionScore = Math.max(0, Math.min(1, -contraction / 0.4));
    }
  }

  // Current algorithm score
  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5));
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4));
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8));
  const s4 = Math.max(0, Math.min(1, strongAbsorptionPct / 18));
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12));
  const s6 = Math.max(0, Math.min(1, (-priceDeltaCorr + 0.3) / 1.5));
  const s7 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6));
  const s8 = volContractionScore;
  const rawScore = s1 * 0.22 + s2 * 0.18 + s3 * 0.15 + s4 * 0.13 + s5 * 0.08 + s6 * 0.09 + s7 * 0.05 + s8 * 0.10;
  const durationMultiplier = Math.min(1.15, 0.70 + (weeks.length - 2) * 0.075);
  const currentScore = rawScore * durationMultiplier;

  // Score with Gate 3 applied (capped deltas affect s1, s3)
  const s1_capped = Math.max(0, Math.min(1, (cappedNetDeltaPct + 1.5) / 5));
  const s3_capped = Math.max(0, Math.min(1, (cappedDeltaShift + 1) / 8));
  const s2_capped = Math.max(0, Math.min(1, (cappedDailySlopeNorm + 0.5) / 4));
  const s6_capped = Math.max(0, Math.min(1, (-cappedPriceDeltaCorr + 0.3) / 1.5));
  const rawScore_capped = s1_capped * 0.22 + s2_capped * 0.18 + s3_capped * 0.15 + s4 * 0.13 + s5 * 0.08 + s6_capped * 0.09 + s7 * 0.05 + s8 * 0.10;
  const cappedScore = rawScore_capped * durationMultiplier;

  return {
    label,
    weeks: weeks.length,
    accumWeeks,
    accumWeekRatio,
    overallPriceChange,
    // Current algorithm
    currentScore,
    currentDetected: currentScore >= 0.30,
    // Gate 2: Delta slope
    deltaSlopeNorm,
    dailySlopeNorm,
    cappedDailySlopeNorm,
    deltaSlopeR2: deltaSlopeReg.r2,
    // Gate 3: Outlier capping
    outlierDays: outlierDays.map(d => ({ date: d.date, delta: d.delta, pct: d.totalVol > 0 ? (d.delta / d.totalVol * 100).toFixed(1) : 0 })),
    deltaMean, deltaStd, cap3sigma, capNeg3sigma,
    netDeltaPct,
    cappedNetDeltaPct,
    deltaShift,
    cappedDeltaShift,
    cappedScore,
    cappedDetected: cappedScore >= 0.30,
    // Gate 4: Price-delta correlation
    priceDeltaCorr,
    cappedPriceDeltaCorr,
    // Detailed score components
    components: { s1, s2, s3, s4, s5, s6, s7, s8 },
    componentsCapped: { s1: s1_capped, s2: s2_capped, s3: s3_capped, s4, s5, s6: s6_capped, s7, s8 },
    durationMultiplier,
    // Weekly data
    weeksData: weeks,
  };
}

// ---- Main ----

(async () => {
  // Define test cases
  const cases = [
    {
      symbol: 'RKLB', label: 'RKLB (positive — accumulation 2/26-4/7/2025)',
      consolFrom: '2025-02-26', consolTo: '2025-04-07',
      preFrom: '2025-01-27', preTo: '2025-02-26',
      expected: true
    },
    {
      symbol: 'IREN', label: 'IREN (positive — accumulation 3/13-4/21/2025)',
      consolFrom: '2025-03-13', consolTo: '2025-04-21',
      preFrom: '2025-02-11', preTo: '2025-03-13',
      expected: true
    },
    {
      symbol: 'TRON', label: 'TRON (FALSE POSITIVE — should be rejected)',
      // Use same window as production: last 42 days for consol, 30 before for pre
      consolFrom: '2026-01-03', consolTo: '2026-02-14',
      preFrom: '2025-12-04', preTo: '2026-01-03',
      expected: false
    },
  ];

  console.log('=== VDF Gate Testing ===\n');
  console.log('Testing proposed gates against known positives and false positive.\n');

  const results = [];

  for (const tc of cases) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Fetching data for ${tc.symbol}...`);

    // Fetch consol bars
    const consolBars = await fetch1mChunked(tc.symbol, tc.consolFrom, tc.consolTo);
    // Fetch pre-context bars
    const preBars = await fetch1mChunked(tc.symbol, tc.preFrom, tc.preTo);
    console.log(`  Consol: ${consolBars.length} bars, Pre: ${preBars.length} bars`);

    const result = scoreWithGateAnalysis(consolBars, preBars, tc.label);
    if (!result) { console.log('  SKIP - insufficient data'); continue; }
    result.expected = tc.expected;
    result.symbol = tc.symbol;
    results.push(result);
  }

  // ---- Print results ----
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('GATE ANALYSIS RESULTS');
  console.log('='.repeat(70));

  for (const r of results) {
    console.log(`\n--- ${r.label} ---`);
    console.log(`  Expected: ${r.expected ? 'DETECTED' : 'REJECTED'}   |   Current algorithm: ${r.currentDetected ? 'DETECTED' : 'REJECTED'} (score ${r.currentScore.toFixed(4)})`);
    console.log(`  Price change: ${r.overallPriceChange.toFixed(1)}%   Weeks: ${r.weeks}   Accum weeks: ${r.accumWeeks}/${r.weeks} (${(r.accumWeekRatio*100).toFixed(0)}%)`);
    console.log();

    console.log('  GATE 2 — Delta Slope (reject if cum delta trending down):');
    console.log(`    Weekly cum delta slope (norm):  ${r.deltaSlopeNorm.toFixed(4)}`);
    console.log(`    Daily cum delta slope (norm):   ${r.dailySlopeNorm.toFixed(4)}`);
    console.log(`    Capped daily slope (norm):      ${r.cappedDailySlopeNorm.toFixed(4)}`);
    console.log(`    R² of weekly fit:               ${r.deltaSlopeR2.toFixed(4)}`);
    // Test various thresholds
    for (const thresh of [-2.0, -1.5, -1.0, -0.5, 0]) {
      const wouldReject = r.deltaSlopeNorm < thresh;
      console.log(`    Gate at slope < ${thresh.toFixed(1)}: ${wouldReject ? 'REJECT ✗' : 'PASS ✓'}${wouldReject !== !r.expected ? ' ← WRONG' : ''}`);
    }
    console.log();

    console.log('  GATE 3 — Outlier Capping (clip daily deltas at ±3σ):');
    console.log(`    Daily delta mean: ${(r.deltaMean/1000).toFixed(0)}K   std: ${(r.deltaStd/1000).toFixed(0)}K`);
    console.log(`    3σ cap: ${(r.cap3sigma/1000).toFixed(0)}K   floor: ${(r.capNeg3sigma/1000).toFixed(0)}K`);
    if (r.outlierDays.length > 0) {
      console.log(`    Outlier days clipped:`);
      for (const o of r.outlierDays) {
        console.log(`      ${o.date}: delta ${(o.delta/1000).toFixed(0)}K (${o.pct}%)`);
      }
    } else {
      console.log(`    No outlier days (nothing clipped)`);
    }
    console.log(`    Original net delta %:  ${r.netDeltaPct.toFixed(4)}%`);
    console.log(`    Capped net delta %:    ${r.cappedNetDeltaPct.toFixed(4)}%`);
    console.log(`    Original delta shift:  ${r.deltaShift.toFixed(4)}`);
    console.log(`    Capped delta shift:    ${r.cappedDeltaShift.toFixed(4)}`);
    console.log(`    Original score:        ${r.currentScore.toFixed(4)} → ${r.currentDetected ? 'DETECTED' : 'REJECTED'}`);
    console.log(`    Capped score:          ${r.cappedScore.toFixed(4)} → ${r.cappedDetected ? 'DETECTED' : 'REJECTED'}${r.cappedDetected !== r.expected ? ' ← WRONG' : ''}`);
    console.log();

    console.log('  GATE 4 — Price-Delta Correlation (reject if positive = concordant):');
    console.log(`    Original correlation:  ${r.priceDeltaCorr.toFixed(4)}`);
    console.log(`    Capped correlation:    ${r.cappedPriceDeltaCorr.toFixed(4)}`);
    for (const thresh of [0.5, 0.3, 0.0, -0.1, -0.2]) {
      const wouldReject = r.priceDeltaCorr > thresh;
      const cappedWouldReject = r.cappedPriceDeltaCorr > thresh;
      console.log(`    Gate at corr > ${thresh >= 0 ? '+' : ''}${thresh.toFixed(1)} (original):  ${wouldReject ? 'REJECT ✗' : 'PASS ✓'}${wouldReject !== !r.expected ? ' ← WRONG' : ''}`);
      console.log(`    Gate at corr > ${thresh >= 0 ? '+' : ''}${thresh.toFixed(1)} (capped):    ${cappedWouldReject ? 'REJECT ✗' : 'PASS ✓'}${cappedWouldReject !== r.expected ? ' ← WRONG' : ''}`);
    }
    console.log();

    console.log('  Weekly breakdown:');
    for (const w of r.weeksData) {
      const dir = w.delta >= 0 ? '+' : '';
      console.log(`    ${w.weekStart}: ${dir}${w.deltaPct.toFixed(2)}%  (${dir}${(w.delta/1000).toFixed(0)}K)`);
    }
  }

  // ---- Summary table ----
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('SUMMARY: GATE EFFECTIVENESS');
  console.log('='.repeat(70));
  console.log();

  const header = 'Ticker'.padEnd(8) + 'Expected'.padEnd(10) + 'Current'.padEnd(10) +
    'G2(slope<-1)'.padEnd(14) + 'G3(capped)'.padEnd(14) +
    'G4(corr>0.3)'.padEnd(14) + 'G3+G4'.padEnd(10);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    const g2 = r.deltaSlopeNorm < -1.0 ? 'REJECT' : 'PASS';
    const g3_det = r.cappedScore >= 0.30 ? 'DETECT' : 'REJECT';
    const g4 = r.priceDeltaCorr > 0.3 ? 'REJECT' : 'PASS';
    const g4_capped = r.cappedPriceDeltaCorr > 0.3 ? 'REJECT' : 'PASS';
    // G3+G4: Apply capping first, then check capped correlation
    const g3g4 = r.cappedScore >= 0.30 && r.cappedPriceDeltaCorr <= 0.3 ? 'DETECT' : 'REJECT';

    console.log(
      r.symbol.padEnd(8) +
      (r.expected ? 'DETECT' : 'REJECT').padEnd(10) +
      (r.currentDetected ? 'DETECT' : 'REJECT').padEnd(10) +
      g2.padEnd(14) +
      g3_det.padEnd(14) +
      g4.padEnd(14) +
      g3g4.padEnd(10)
    );
  }

  console.log();
  console.log('Legend:');
  console.log('  G2: Hard gate — reject if weekly cum delta slope < -1.0');
  console.log('  G3: Score after capping daily deltas at ±3σ (still needs score ≥ 0.30)');
  console.log('  G4: Hard gate — reject if price-delta correlation > +0.3');
  console.log('  G3+G4: Apply 3σ capping THEN check capped correlation > +0.3');
  console.log();

  // Additional combo testing
  console.log('COMBO TESTING — Various threshold combinations:');
  console.log();

  const combos = [
    { name: 'G2(slope<-2) + G4(corr>0.5)', g2: -2.0, g4: 0.5, useCap: false },
    { name: 'G2(slope<-1) + G4(corr>0.3)', g2: -1.0, g4: 0.3, useCap: false },
    { name: 'G3(cap) + G4(corr>0.3 capped)', g2: null, g4: 0.3, useCap: true },
    { name: 'G3(cap) + G2(capped slope<-1)', g2capped: -1.0, g4: null, useCap: true },
    { name: 'G3(cap) + G2(capped slope<-1) + G4(corr>0.3 capped)', g2capped: -1.0, g4: 0.3, useCap: true },
    { name: 'G3(cap) + G4(corr>0.5 capped)', g2: null, g4: 0.5, useCap: true },
    { name: 'G2(slope<-1.5) only', g2: -1.5, g4: null, useCap: false },
    { name: 'G4(corr>0.3 original) only', g2: null, g4: 0.3, useCap: false },
    { name: 'G4(corr>0.5 original) only', g2: null, g4: 0.5, useCap: false },
  ];

  for (const combo of combos) {
    const outcomes = results.map(r => {
      let detected = combo.useCap ? r.cappedScore >= 0.30 : r.currentScore >= 0.30;
      if (combo.g2 != null && r.deltaSlopeNorm < combo.g2) detected = false;
      if (combo.g2capped != null && r.cappedDailySlopeNorm < combo.g2capped) detected = false;
      if (combo.g4 != null) {
        const corr = combo.useCap ? r.cappedPriceDeltaCorr : r.priceDeltaCorr;
        if (corr > combo.g4) detected = false;
      }
      const correct = detected === r.expected;
      return { symbol: r.symbol, detected, expected: r.expected, correct };
    });
    const allCorrect = outcomes.every(o => o.correct);
    const line = outcomes.map(o => `${o.symbol}:${o.detected ? 'DET' : 'REJ'}${o.correct ? '✓' : '✗'}`).join('  ');
    console.log(`  ${combo.name.padEnd(52)} ${line}  ${allCorrect ? '✅ ALL CORRECT' : '❌'}`);
  }

})().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

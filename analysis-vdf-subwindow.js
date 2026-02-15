/**
 * VDF Subwindow Analysis
 * Slides accumulation windows of various sizes across the full period
 * to find where divergent accumulation actually lives.
 *
 * Usage: node analysis-vdf-subwindow.js
 * Configure tickers/periods in the `cases` array at bottom.
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
 * Score a subwindow of daily data against pre-context.
 * Returns full metrics object or null if insufficient data.
 */
function scoreSubwindow(dailySlice, preBars1m, allDailyAvgVol) {
  if (dailySlice.length < 7) return null; // need at least ~1.5 weeks of trading days

  // Rebuild weekly aggregation from daily slice
  const weekMap = new Map();
  for (const d of dailySlice) {
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

  if (weeks.length < 2) return null;

  const totalVol = dailySlice.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / dailySlice.length;
  const closes = dailySlice.map(d => d.close);
  const overallPriceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;

  // Price gates
  if (overallPriceChange > 10) return { score: 0, detected: false, reason: 'price_rising', weeks: weeks.length, overallPriceChange };
  if (overallPriceChange < -45) return { score: 0, detected: false, reason: 'crash', weeks: weeks.length, overallPriceChange };

  // Pre-context
  const preAgg = vdAggregateWeekly(preBars1m);
  const preAvgDelta = preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.delta, 0) / preAgg.daily.length : 0;
  const preAvgVol = preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.totalVol, 0) / preAgg.daily.length : avgDailyVol;

  // Net delta
  const netDelta = dailySlice.reduce((s, d) => s + d.delta, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

  // Concordant selling gate
  if (netDeltaPct < -1.5) return { score: 0, detected: false, reason: 'concordant_selling', weeks: weeks.length, overallPriceChange, netDeltaPct };

  // Delta slope
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const w of weeks) { cwd += w.delta; cumWeeklyDelta.push(cwd); }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (vdLinReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  // Delta shift
  const consolAvgDailyDelta = netDelta / dailySlice.length;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  // Strong absorption
  let strongAbsorptionDays = 0;
  for (let i = 1; i < dailySlice.length; i++) {
    if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > avgDailyVol * 0.05) strongAbsorptionDays++;
  }
  const strongAbsorptionPct = dailySlice.length > 1 ? (strongAbsorptionDays / (dailySlice.length - 1)) * 100 : 0;

  // Large buy vs sell
  const largeBuyDays = dailySlice.filter(d => d.delta > avgDailyVol * 0.10).length;
  const largeSellDays = dailySlice.filter(d => d.delta < -avgDailyVol * 0.10).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / dailySlice.length) * 100;

  // Price-cumDelta correlation
  const cumDeltas = [];
  let cd = 0;
  for (const d of dailySlice) { cd += d.delta; cumDeltas.push(cd); }
  let priceDeltaCorr = 0;
  {
    const n = dailySlice.length;
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

  // Accum week ratio
  const accumWeeks = weeks.filter(w => w.deltaPct > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;

  // Vol contraction
  let volContractionScore = 0;
  if (dailySlice.length >= 9) {
    const dThird = Math.floor(dailySlice.length / 3);
    const t1Ranges = dailySlice.slice(0, dThird).map(d => ((d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0)) * 100);
    const t3Ranges = dailySlice.slice(2 * dThird).map(d => ((d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0)) * 100);
    const avgT1 = t1Ranges.reduce((s, v) => s + v, 0) / t1Ranges.length;
    const avgT3 = t3Ranges.reduce((s, v) => s + v, 0) / t3Ranges.length;
    if (avgT1 > 0) {
      const contraction = (avgT3 - avgT1) / avgT1;
      volContractionScore = Math.max(0, Math.min(1, -contraction / 0.4));
    }
  }

  // Score
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
  const score = rawScore * durationMultiplier;
  const detected = score >= 0.30;

  return {
    score, detected, rawScore, durationMultiplier,
    reason: detected ? 'accumulation_divergence' : 'below_threshold',
    weeks: weeks.length, accumWeeks, accumWeekRatio,
    overallPriceChange, netDeltaPct, deltaSlopeNorm, deltaShift,
    strongAbsorptionPct, largeBuyVsSell, priceDeltaCorr, volContractionScore,
    components: { s1, s2, s3, s4, s5, s6, s7, s8 },
    weeksData: weeks,
    dateRange: `${dailySlice[0].date} → ${dailySlice[dailySlice.length - 1].date}`,
    nDays: dailySlice.length,
  };
}

async function analyzeTickerSubwindows(symbol, consolFrom, consolTo, preFrom, preTo) {
  console.log(`\nFetching consolidation data (${consolFrom} → ${consolTo})...`);
  const consolBars = await fetch1mChunked(symbol, consolFrom, consolTo);
  console.log(`Fetching pre-context data (${preFrom} → ${preTo})...`);
  const preBars = await fetch1mChunked(symbol, preFrom, preTo);
  console.log(`Consol: ${consolBars.length} bars, Pre: ${preBars.length} bars\n`);

  // Build daily from consol bars
  const { daily: allDaily, weeks: allWeeks } = vdAggregateWeekly(consolBars);
  const allTotalVol = allDaily.reduce((s, d) => s + d.totalVol, 0);
  const allAvgDailyVol = allTotalVol / allDaily.length;

  // Print full-window overview
  console.log('='.repeat(70));
  console.log(`${symbol} — FULL WINDOW OVERVIEW`);
  console.log('='.repeat(70));
  console.log(`  Period: ${allDaily[0].date} → ${allDaily[allDaily.length - 1].date} (${allDaily.length} trading days)`);
  console.log();

  // Print daily price + delta for context
  console.log('  Daily data:');
  for (const d of allDaily) {
    const dir = d.delta >= 0 ? '+' : '';
    const pctOfVol = d.totalVol > 0 ? (d.delta / d.totalVol * 100).toFixed(1) : '0.0';
    console.log(`    ${d.date}: $${d.close.toFixed(2).padStart(7)}  delta=${dir}${(d.delta/1000).toFixed(0).padStart(6)}K  (${pctOfVol.padStart(6)}%)  vol=${(d.totalVol/1e6).toFixed(2)}M`);
  }
  console.log();

  // Print weekly summary
  console.log('  Weekly summary:');
  for (const w of allWeeks) {
    const dir = w.delta >= 0 ? '+' : '';
    console.log(`    ${w.weekStart}: ${dir}${w.deltaPct.toFixed(2).padStart(7)}%  (${dir}${(w.delta/1000).toFixed(0).padStart(7)}K)  vol=${(w.totalVol/1e6).toFixed(1)}M  [${w.nDays}d]`);
  }
  console.log();

  // Full window score
  const fullResult = scoreSubwindow(allDaily, preBars, allAvgDailyVol);
  console.log(`  Full window score: ${fullResult ? fullResult.score.toFixed(4) : 'N/A'} ${fullResult?.detected ? '✅ DETECTED' : '❌ NOT DETECTED'} ${fullResult?.reason ? `(${fullResult.reason})` : ''}`);
  if (fullResult && fullResult.netDeltaPct !== undefined) {
    console.log(`    Net delta: ${fullResult.netDeltaPct.toFixed(2)}%  Price: ${fullResult.overallPriceChange.toFixed(1)}%  Corr: ${fullResult.priceDeltaCorr?.toFixed(2) || 'N/A'}  Slope: ${fullResult.deltaSlopeNorm?.toFixed(2) || 'N/A'}`);
  }
  console.log();

  // ---- Sliding window analysis ----
  console.log('='.repeat(70));
  console.log(`${symbol} — SLIDING SUBWINDOW ANALYSIS`);
  console.log('='.repeat(70));
  console.log();

  const windowSizes = [10, 14, 17, 20, 24, 28]; // trading days (~2wk, ~3wk, ~3.5wk, ~4wk, ~5wk, ~6wk)
  const allResults = [];

  for (const winSize of windowSizes) {
    if (allDaily.length < winSize) continue;
    const weekLabel = (winSize / 5).toFixed(1);
    console.log(`  --- Window size: ${winSize} days (~${weekLabel} weeks) ---`);

    const windowResults = [];
    for (let start = 0; start <= allDaily.length - winSize; start += 1) {
      const slice = allDaily.slice(start, start + winSize);
      const result = scoreSubwindow(slice, preBars, allAvgDailyVol);
      if (result) {
        windowResults.push({ start, end: start + winSize - 1, ...result });
      }
    }

    // Sort by score descending
    windowResults.sort((a, b) => b.score - a.score);

    // Show top 5 scoring windows
    const top = windowResults.slice(0, 5);
    if (top.length === 0) {
      console.log('    No valid windows (all rejected by hard gates or insufficient data)');
    } else {
      for (const w of top) {
        const det = w.detected ? '✅' : '  ';
        const gated = w.reason === 'concordant_selling' ? ' [GATED: concordant]' :
                      w.reason === 'crash' ? ' [GATED: crash]' :
                      w.reason === 'price_rising' ? ' [GATED: rising]' : '';
        console.log(`    ${det} ${w.dateRange}  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || 'N/A'}%  price=${w.overallPriceChange.toFixed(1)}%  corr=${w.priceDeltaCorr?.toFixed(2) || 'N/A'}  slope=${w.deltaSlopeNorm?.toFixed(2) || 'N/A'}  wks=${w.weeks}${gated}`);
      }
    }

    // Count detected windows
    const detectedCount = windowResults.filter(w => w.detected).length;
    const totalCount = windowResults.length;
    const gatedCount = windowResults.filter(w => w.reason === 'concordant_selling' || w.reason === 'crash').length;
    console.log(`    Summary: ${detectedCount}/${totalCount} detected, ${gatedCount} gated out`);
    console.log();

    allResults.push(...windowResults.filter(w => w.detected));
  }

  // ---- Best subwindow detail ----
  if (allResults.length > 0) {
    allResults.sort((a, b) => b.score - a.score);
    const best = allResults[0];

    console.log('='.repeat(70));
    console.log(`${symbol} — BEST SUBWINDOW DETAIL`);
    console.log('='.repeat(70));
    console.log(`  Window: ${best.dateRange} (${best.nDays} days, ${best.weeks} weeks)`);
    console.log(`  Score: ${best.score.toFixed(4)} ${best.detected ? '✅ DETECTED' : '❌'}`);
    console.log(`  Price change: ${best.overallPriceChange.toFixed(1)}%`);
    console.log(`  Duration mult: ${best.durationMultiplier.toFixed(3)}`);
    console.log();
    console.log('  Score Components:');
    console.log(`    s1 Net Delta (22%):       ${best.components.s1.toFixed(4)}  (netDeltaPct=${best.netDeltaPct.toFixed(2)}%)`);
    console.log(`    s2 Delta Slope (18%):     ${best.components.s2.toFixed(4)}  (slope=${best.deltaSlopeNorm.toFixed(2)})`);
    console.log(`    s3 Delta Shift (15%):     ${best.components.s3.toFixed(4)}  (shift=${best.deltaShift.toFixed(2)})`);
    console.log(`    s4 Absorption (13%):      ${best.components.s4.toFixed(4)}  (${best.strongAbsorptionPct.toFixed(1)}%)`);
    console.log(`    s5 Buy vs Sell (8%):      ${best.components.s5.toFixed(4)}  (${best.largeBuyVsSell.toFixed(1)})`);
    console.log(`    s6 Anti-corr (9%):        ${best.components.s6.toFixed(4)}  (corr=${best.priceDeltaCorr.toFixed(2)})`);
    console.log(`    s7 Week ratio (5%):       ${best.components.s7.toFixed(4)}  (${best.accumWeeks}/${best.weeks})`);
    console.log(`    s8 Vol contraction (10%): ${best.components.s8.toFixed(4)}`);
    console.log();
    console.log('  Weekly breakdown:');
    for (const w of best.weeksData) {
      const dir = w.delta >= 0 ? '+' : '';
      console.log(`    ${w.weekStart}: ${dir}${w.deltaPct.toFixed(2)}%  (${dir}${(w.delta/1000).toFixed(0)}K)`);
    }

    // Gate analysis on best window
    console.log();
    console.log('  Gate analysis (proposed gates on best window):');
    console.log(`    G2 slope < -1.5:     ${best.deltaSlopeNorm < -1.5 ? 'REJECT' : 'PASS'} (slope=${best.deltaSlopeNorm.toFixed(2)})`);
    console.log(`    G4 corr > +0.5:      ${best.priceDeltaCorr > 0.5 ? 'REJECT' : 'PASS'} (corr=${best.priceDeltaCorr.toFixed(2)})`);
    console.log(`    G2(-2)+G4(0.5):      ${best.deltaSlopeNorm < -2 || best.priceDeltaCorr > 0.5 ? 'REJECT' : 'PASS'}`);
  } else {
    console.log('='.repeat(70));
    console.log(`${symbol} — NO SUBWINDOW DETECTED ACCUMULATION`);
    console.log('='.repeat(70));
    console.log();

    // Show what the best-scoring non-detected windows look like
    const allNonDetected = [];
    for (const winSize of windowSizes) {
      if (allDaily.length < winSize) continue;
      for (let start = 0; start <= allDaily.length - winSize; start += 1) {
        const slice = allDaily.slice(start, start + winSize);
        const result = scoreSubwindow(slice, preBars, allAvgDailyVol);
        if (result) allNonDetected.push({ start, end: start + winSize - 1, winSize, ...result });
      }
    }
    allNonDetected.sort((a, b) => b.score - a.score);

    console.log('  Top 10 highest-scoring subwindows (none reached 0.30):');
    for (const w of allNonDetected.slice(0, 10)) {
      const gated = w.reason === 'concordant_selling' ? ' [concordant]' :
                    w.reason === 'crash' ? ' [crash]' : '';
      console.log(`    ${w.dateRange} (${w.winSize}d)  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || '?'}%  price=${w.overallPriceChange.toFixed(1)}%  corr=${w.priceDeltaCorr?.toFixed(2) || '?'}  slope=${w.deltaSlopeNorm?.toFixed(2) || '?'}${gated}`);
    }

    // Show gated-out windows that WOULD have scored above 0.30 if not gated
    console.log();
    console.log('  Windows gated by concordant selling (net delta < -1.5%):');
    const gatedWindows = allNonDetected.filter(w => w.reason === 'concordant_selling');
    // For gated windows, score is 0 — we need to compute what it would be
    // Actually the score IS 0 for gated windows, so let's just show the raw metrics
    gatedWindows.sort((a, b) => (b.netDeltaPct || -99) - (a.netDeltaPct || -99));
    const nearMiss = gatedWindows.filter(w => w.netDeltaPct > -3.0).slice(0, 5);
    if (nearMiss.length > 0) {
      for (const w of nearMiss) {
        console.log(`    ${w.dateRange} (${w.winSize}d)  net∂=${w.netDeltaPct.toFixed(2)}%  price=${w.overallPriceChange.toFixed(1)}%`);
      }
    } else {
      console.log('    (none near the -1.5% threshold)');
    }
  }

  console.log();
}

// ---- Main ----

(async () => {
  const cases = [
    {
      symbol: 'HUT',
      consolFrom: '2025-02-24', consolTo: '2025-04-21',
      preFrom: '2025-01-25', preTo: '2025-02-24',
    },
  ];

  for (const c of cases) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`ANALYZING ${c.symbol}`);
    console.log('='.repeat(70));
    await analyzeTickerSubwindows(c.symbol, c.consolFrom, c.consolTo, c.preFrom, c.preTo);
  }

  console.log('\nDone.');
})().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

/**
 * VDF Deep Analysis — WULF
 * Full period: 1/1/25 - 5/15/25
 * Likely accumulation: 2/27/25 - 4/21/25
 * Breakout: ~4/21/25
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
    process.stdout.write(`  1m ${symbol} ${f} -> ${t}...`);
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

function mean(arr) {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
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
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - intercept - slope * xs[i]) ** 2;
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

function buildDaily(bars1m) {
  const dailyMap = new Map();
  for (const b of bars1m) {
    const d = new Date(b.time * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(d))
      dailyMap.set(d, {
        buyVol: 0,
        sellVol: 0,
        totalVol: 0,
        high: -Infinity,
        low: Infinity,
        close: 0,
        open: 0,
        first: true,
      });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0;
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.close = b.close;
    day.high = Math.max(day.high, b.high);
    day.low = Math.min(day.low, b.low);
    if (day.first) {
      day.open = b.open;
      day.first = false;
    }
  }
  const dates = [...dailyMap.keys()].sort();
  return dates.map((d) => {
    const day = dailyMap.get(d);
    return {
      date: d,
      delta: day.buyVol - day.sellVol,
      totalVol: day.totalVol,
      buyVol: day.buyVol,
      sellVol: day.sellVol,
      close: day.close,
      open: day.open,
      high: day.high,
      low: day.low,
      rangePct: day.close > 0 ? ((day.high - day.low) / day.close) * 100 : 0,
      deltaPct: day.totalVol > 0 ? ((day.buyVol - day.sellVol) / day.totalVol) * 100 : 0,
    };
  });
}

function buildWeeks(daily) {
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
  return [...weekMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, days]) => {
      const buyVol = days.reduce((s, d) => s + d.buyVol, 0);
      const sellVol = days.reduce((s, d) => s + d.sellVol, 0);
      const totalVol = days.reduce((s, d) => s + d.totalVol, 0);
      return {
        weekStart,
        delta: buyVol - sellVol,
        totalVol,
        deltaPct: totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0,
        nDays: days.length,
        open: days[0].open,
        close: days[days.length - 1].close,
        high: Math.max(...days.map((d) => d.high)),
        low: Math.min(...days.map((d) => d.low)),
        avgRange: mean(days.map((d) => d.rangePct)),
        avgVol: totalVol / days.length,
      };
    });
}

function scoreSubwindow(dailySlice, preDaily, opts = {}) {
  const useCapping = opts.cap3sigma !== false;
  const weeks = buildWeeks(dailySlice);
  if (weeks.length < 2) return null;

  const n = dailySlice.length;
  const totalVol = dailySlice.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / n;
  const closes = dailySlice.map((d) => d.close);
  const overallPriceChange = ((closes[n - 1] - closes[0]) / closes[0]) * 100;

  if (overallPriceChange > 10 || overallPriceChange < -45) return null;

  const preAvgDelta = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.delta, 0) / preDaily.length : 0;
  const preAvgVol = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.totalVol, 0) / preDaily.length : avgDailyVol;

  // 3σ capping
  let effectiveDeltas = dailySlice.map((d) => d.delta);
  let cappedDays = [];
  if (useCapping) {
    const dm = mean(effectiveDeltas);
    const ds = std(effectiveDeltas);
    const cap = dm + 3 * ds;
    const floor = dm - 3 * ds;
    effectiveDeltas = effectiveDeltas.map((d, i) => {
      if (d > cap || d < floor) {
        cappedDays.push({ date: dailySlice[i].date, original: d, capped: Math.max(floor, Math.min(cap, d)) });
        return Math.max(floor, Math.min(cap, d));
      }
      return d;
    });
  }

  const netDelta = effectiveDeltas.reduce((s, v) => s + v, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
  if (netDeltaPct < -1.5) return { score: 0, reason: 'concordant', netDeltaPct, overallPriceChange };

  // Weekly cum delta slope (using capped values grouped by week)
  const weeklyDeltas = [];
  let dayIdx = 0;
  for (const w of weeks) {
    let wd = 0;
    for (let j = 0; j < w.nDays && dayIdx < effectiveDeltas.length; j++, dayIdx++) {
      wd += effectiveDeltas[dayIdx];
    }
    weeklyDeltas.push(wd);
  }
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const wd of weeklyDeltas) {
    cwd += wd;
    cumWeeklyDelta.push(cwd);
  }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (linReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  // Gate: delta slope
  if (deltaSlopeNorm < -0.5) return { score: 0, reason: 'slope_gate', netDeltaPct, overallPriceChange, deltaSlopeNorm };

  const consolAvgDailyDelta = netDelta / n;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  let strongAbsorptionDays = 0;
  let absorptionDays = 0;
  for (let i = 1; i < n; i++) {
    if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > 0) absorptionDays++;
    if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > avgDailyVol * 0.05)
      strongAbsorptionDays++;
  }
  const absorptionPct = n > 1 ? (absorptionDays / (n - 1)) * 100 : 0;

  const largeBuyDays = dailySlice.filter((d) => d.delta > avgDailyVol * 0.1).length;
  const largeSellDays = dailySlice.filter((d) => d.delta < -avgDailyVol * 0.1).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / n) * 100;

  const cumDeltas = [];
  let cd = 0;
  for (const ed of effectiveDeltas) {
    cd += ed;
    cumDeltas.push(cd);
  }
  const meanP = mean(closes);
  const meanD = mean(cumDeltas);
  let cov = 0,
    varP = 0,
    varD = 0;
  for (let i = 0; i < n; i++) {
    cov += (closes[i] - meanP) * (cumDeltas[i] - meanD);
    varP += (closes[i] - meanP) ** 2;
    varD += (cumDeltas[i] - meanD) ** 2;
  }
  const priceDeltaCorr = varP > 0 && varD > 0 ? cov / Math.sqrt(varP * varD) : 0;

  const accumWeeks = weeklyDeltas.filter((wd) => wd > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;

  // Volume decline in last third
  const third = Math.floor(n / 3);
  const t1Vols = dailySlice.slice(0, third).map((d) => d.totalVol);
  const t3Vols = dailySlice.slice(2 * third).map((d) => d.totalVol);
  const volDeclineScore =
    mean(t1Vols) > 0 && mean(t3Vols) < mean(t1Vols)
      ? Math.min(1, (mean(t1Vols) - mean(t3Vols)) / mean(t1Vols) / 0.3)
      : 0;

  // PROPOSED scoring (from analysis)
  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5)); // Net Delta (25%)
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4)); // Delta Slope (22%)
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8)); // Delta Shift (15%)
  const s4 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6)); // Accum Week Ratio (15%)
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12)); // Buy vs Sell (10%)
  const s6 = Math.max(0, Math.min(1, absorptionPct / 20)); // Absorption (8%)
  const s7 = volDeclineScore; // Vol Decline (5%)

  const rawScore = s1 * 0.25 + s2 * 0.22 + s3 * 0.15 + s4 * 0.15 + s5 * 0.1 + s6 * 0.08 + s7 * 0.05;
  const durationMultiplier = Math.min(1.15, 0.7 + (weeks.length - 2) * 0.075);
  const score = rawScore * durationMultiplier;

  return {
    score,
    detected: score >= 0.3,
    netDeltaPct,
    overallPriceChange,
    deltaSlopeNorm,
    priceDeltaCorr,
    accumWeekRatio,
    deltaShift,
    weeks: weeks.length,
    accumWeeks,
    absorptionPct,
    largeBuyVsSell,
    volDeclineScore,
    components: { s1, s2, s3, s4, s5, s6, s7 },
    durationMultiplier,
    cappedDays,
    weeksData: weeks.map((w, i) => ({ ...w, effectiveDelta: weeklyDeltas[i] })),
  };
}

(async () => {
  console.log('=== VDF Deep Analysis — WULF ===\n');

  // Fetch full period + pre-context
  console.log('Fetching consolidation data (1/1/25 → 5/15/25)...');
  const allBars = await fetch1mChunked('WULF', '2025-01-01', '2025-05-15');
  console.log('Fetching pre-context data (12/1/24 → 1/1/25)...');
  const preBars = await fetch1mChunked('WULF', '2024-12-01', '2025-01-01');
  console.log(`Total: Full=${allBars.length} bars, Pre=${preBars.length} bars\n`);

  const allDaily = buildDaily(allBars);
  const preDaily = buildDaily(preBars);
  const allWeeks = buildWeeks(allDaily);

  // ---- Full period overview ----
  console.log('='.repeat(80));
  console.log('  WULF — FULL PERIOD OVERVIEW (1/1/25 → 5/15/25)');
  console.log('='.repeat(80));

  console.log('\n  Daily data:');
  for (const d of allDaily) {
    const dir = d.delta >= 0 ? '+' : '';
    console.log(
      `    ${d.date}: $${d.close.toFixed(2).padStart(6)}  ∂=${dir}${(d.delta / 1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  range=${d.rangePct.toFixed(2).padStart(6)}%  vol=${(d.totalVol / 1e6).toFixed(2)}M`,
    );
  }

  console.log('\n  Weekly summary:');
  for (const w of allWeeks) {
    const dir = w.delta >= 0 ? '+' : '';
    const priceDir = w.close >= w.open ? '▲' : '▼';
    console.log(
      `    ${w.weekStart}: ${priceDir} $${w.open.toFixed(2)}→$${w.close.toFixed(2)}  ∂=${dir}${w.deltaPct.toFixed(2).padStart(7)}%  (${dir}${(w.delta / 1000).toFixed(0).padStart(7)}K)  rng=${w.avgRange.toFixed(2).padStart(6)}%  vol=${(w.avgVol / 1e6).toFixed(2)}M  [${w.nDays}d]`,
    );
  }

  // ---- User-specified accumulation window ----
  console.log(`\n${'='.repeat(80)}`);
  console.log('  WULF — USER-SPECIFIED ACCUMULATION WINDOW (2/27 → 4/21)');
  console.log('='.repeat(80));

  const accumDaily = allDaily.filter((d) => d.date >= '2025-02-27' && d.date <= '2025-04-21');
  const accumWeeks = buildWeeks(accumDaily);
  const accumTotalVol = accumDaily.reduce((s, d) => s + d.totalVol, 0);
  const accumNetDelta = accumDaily.reduce((s, d) => s + d.delta, 0);
  const accumCloses = accumDaily.map((d) => d.close);

  console.log(
    `  Period: ${accumDaily[0]?.date} → ${accumDaily[accumDaily.length - 1]?.date} (${accumDaily.length} days)`,
  );
  console.log(
    `  Price: $${accumCloses[0]?.toFixed(2)} → $${accumCloses[accumCloses.length - 1]?.toFixed(2)} (${(((accumCloses[accumCloses.length - 1] - accumCloses[0]) / accumCloses[0]) * 100).toFixed(1)}%)`,
  );
  console.log(`  Net delta: ${((accumNetDelta / accumTotalVol) * 100).toFixed(2)}%`);
  console.log(`  Accum weeks: ${accumWeeks.filter((w) => w.deltaPct > 0).length}/${accumWeeks.length}`);

  // Score this window directly
  const directResult = scoreSubwindow(accumDaily, preDaily);
  if (directResult) {
    console.log(
      `\n  Direct score (with 3σ cap + slope gate): ${directResult.score.toFixed(4)} ${directResult.detected ? '✅ DETECTED' : '❌ NOT DETECTED'}`,
    );
    if (directResult.reason) console.log(`    Reason: ${directResult.reason}`);
    if (directResult.deltaSlopeNorm !== undefined)
      console.log(
        `    Slope: ${directResult.deltaSlopeNorm.toFixed(2)}  Net∂: ${directResult.netDeltaPct.toFixed(2)}%  Corr: ${directResult.priceDeltaCorr?.toFixed(2)}  AccWk: ${directResult.accumWeeks}/${directResult.weeks}`,
      );
    if (directResult.cappedDays?.length > 0) {
      console.log('    Capped days:');
      for (const c of directResult.cappedDays)
        console.log(`      ${c.date}: ${(c.original / 1000).toFixed(0)}K → ${(c.capped / 1000).toFixed(0)}K`);
    }
    if (directResult.components) {
      const c = directResult.components;
      console.log(
        `    Components: s1=${c.s1.toFixed(2)} s2=${c.s2.toFixed(2)} s3=${c.s3.toFixed(2)} s4=${c.s4.toFixed(2)} s5=${c.s5.toFixed(2)} s6=${c.s6.toFixed(2)} s7=${c.s7.toFixed(2)}`,
      );
    }
    if (directResult.weeksData) {
      console.log('    Weekly breakdown:');
      for (const w of directResult.weeksData) {
        const dir = w.effectiveDelta >= 0 ? '+' : '';
        console.log(
          `      ${w.weekStart}: ${dir}${w.deltaPct.toFixed(2)}% (${dir}${(w.delta / 1000).toFixed(0)}K) [${w.nDays}d]`,
        );
      }
    }
  } else {
    console.log('  Direct score: insufficient data');
  }

  // Without capping for comparison
  const noCap = scoreSubwindow(accumDaily, preDaily, { cap3sigma: false });
  if (noCap) {
    console.log(
      `\n  Score WITHOUT capping: ${noCap.score.toFixed(4)} ${noCap.detected ? '✅' : '❌'} ${noCap.reason || ''}`,
    );
    if (noCap.deltaSlopeNorm !== undefined)
      console.log(`    Slope: ${noCap.deltaSlopeNorm.toFixed(2)}  Net∂: ${noCap.netDeltaPct.toFixed(2)}%`);
  }

  // ---- Subwindow scanning ----
  console.log(`\n${'='.repeat(80)}`);
  console.log('  WULF — SUBWINDOW SCANNING (across full 1/1 → 5/15 period)');
  console.log('='.repeat(80));

  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  const allResults = [];

  for (const winSize of windowSizes) {
    if (allDaily.length < winSize) continue;
    const weekLabel = (winSize / 5).toFixed(1);
    console.log(`\n  --- Window size: ${winSize} days (~${weekLabel} weeks) ---`);

    const windowResults = [];
    for (let start = 0; start <= allDaily.length - winSize; start++) {
      const slice = allDaily.slice(start, start + winSize);
      const result = scoreSubwindow(slice, preDaily);
      if (result)
        windowResults.push({
          start,
          winSize,
          ...result,
          startDate: slice[0].date,
          endDate: slice[slice.length - 1].date,
        });
    }

    windowResults.sort((a, b) => b.score - a.score);
    const top = windowResults.slice(0, 5);
    for (const w of top) {
      const det = w.detected ? '✅' : '  ';
      const gated = w.reason === 'concordant' ? ' [concordant]' : w.reason === 'slope_gate' ? ' [slope gate]' : '';
      console.log(
        `    ${det} ${w.startDate}→${w.endDate}  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || '?'}%  price=${w.overallPriceChange.toFixed(1)}%  corr=${w.priceDeltaCorr?.toFixed(2) || '?'}  slope=${w.deltaSlopeNorm?.toFixed(2) || '?'}  accWk=${w.accumWeeks || '?'}/${w.weeks || '?'}${gated}`,
      );
    }

    const detectedCount = windowResults.filter((w) => w.detected).length;
    const gatedCount = windowResults.filter((w) => w.score === 0).length;
    console.log(`    → ${detectedCount}/${windowResults.length} detected, ${gatedCount} gated`);

    allResults.push(...windowResults.filter((w) => w.detected));
  }

  // ---- Best subwindow detail ----
  if (allResults.length > 0) {
    allResults.sort((a, b) => b.score - a.score);
    const best = allResults[0];

    console.log(`\n${'='.repeat(80)}`);
    console.log('  WULF — BEST SUBWINDOW DETAIL');
    console.log('='.repeat(80));
    console.log(`  Window: ${best.startDate} → ${best.endDate} (${best.winSize}d, ${best.weeks}wk)`);
    console.log(`  Score: ${best.score.toFixed(4)} ${best.detected ? '✅ DETECTED' : '❌'}`);
    console.log(
      `  Price: ${best.overallPriceChange.toFixed(1)}%  Net∂: ${best.netDeltaPct.toFixed(2)}%  Corr: ${best.priceDeltaCorr.toFixed(2)}  Slope: ${best.deltaSlopeNorm.toFixed(2)}`,
    );
    console.log(`  Duration mult: ${best.durationMultiplier.toFixed(3)}`);
    console.log(`  Accum weeks: ${best.accumWeeks}/${best.weeks} (${(best.accumWeekRatio * 100).toFixed(0)}%)`);
    console.log(
      `  Absorption: ${best.absorptionPct.toFixed(1)}%  Buy vs Sell: ${best.largeBuyVsSell.toFixed(1)}  Vol decline: ${best.volDeclineScore.toFixed(2)}`,
    );

    const c = best.components;
    console.log(`\n  Score Components (proposed weights):`);
    console.log(`    s1 Net Delta (25%):       ${c.s1.toFixed(4)}  → contributes ${(c.s1 * 0.25).toFixed(4)}`);
    console.log(`    s2 Delta Slope (22%):     ${c.s2.toFixed(4)}  → contributes ${(c.s2 * 0.22).toFixed(4)}`);
    console.log(`    s3 Delta Shift (15%):     ${c.s3.toFixed(4)}  → contributes ${(c.s3 * 0.15).toFixed(4)}`);
    console.log(`    s4 Accum Week Ratio (15%):${c.s4.toFixed(4)}  → contributes ${(c.s4 * 0.15).toFixed(4)}`);
    console.log(`    s5 Buy vs Sell (10%):     ${c.s5.toFixed(4)}  → contributes ${(c.s5 * 0.1).toFixed(4)}`);
    console.log(`    s6 Absorption (8%):       ${c.s6.toFixed(4)}  → contributes ${(c.s6 * 0.08).toFixed(4)}`);
    console.log(`    s7 Vol Decline (5%):      ${c.s7.toFixed(4)}  → contributes ${(c.s7 * 0.05).toFixed(4)}`);

    if (best.cappedDays?.length > 0) {
      console.log('\n  Outlier days capped:');
      for (const cd of best.cappedDays)
        console.log(`    ${cd.date}: ${(cd.original / 1000).toFixed(0)}K → ${(cd.capped / 1000).toFixed(0)}K`);
    }

    console.log('\n  Weekly breakdown:');
    for (const w of best.weeksData) {
      const dir = w.effectiveDelta >= 0 ? '+' : '';
      const origDir = w.delta >= 0 ? '+' : '';
      const diff = Math.abs(w.effectiveDelta - w.delta) > 1 ? ` (orig: ${origDir}${(w.delta / 1000).toFixed(0)}K)` : '';
      console.log(
        `    ${w.weekStart}: ${dir}${(w.effectiveDelta / 1000).toFixed(0)}K  ∂%=${dir}${w.deltaPct.toFixed(2)}%  [${w.nDays}d]${diff}`,
      );
    }

    // Show the daily data within best window
    const bestSlice = allDaily.slice(best.start, best.start + best.winSize);
    console.log('\n  Daily detail (best window):');
    for (let i = 0; i < bestSlice.length; i++) {
      const d = bestSlice[i];
      const prev = i > 0 ? bestSlice[i - 1] : null;
      const priceChg = prev ? (((d.close - prev.close) / prev.close) * 100).toFixed(1) : '—';
      const dir = d.delta >= 0 ? '+' : '';
      const absorb = prev && d.close < prev.close && d.delta > 0 ? ' ★ABSORB' : '';
      console.log(
        `    ${d.date}: $${d.close.toFixed(2).padStart(6)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta / 1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  rng=${d.rangePct.toFixed(2).padStart(6)}%  vol=${(d.totalVol / 1e6).toFixed(2)}M${absorb}`,
      );
    }
  } else {
    console.log(`\n${'='.repeat(80)}`);
    console.log('  WULF — NO SUBWINDOW DETECTED');
    console.log('='.repeat(80));

    // Show top non-detected
    const allNon = [];
    for (const winSize of windowSizes) {
      if (allDaily.length < winSize) continue;
      for (let start = 0; start <= allDaily.length - winSize; start++) {
        const slice = allDaily.slice(start, start + winSize);
        const result = scoreSubwindow(slice, preDaily);
        if (result)
          allNon.push({ start, winSize, ...result, startDate: slice[0].date, endDate: slice[slice.length - 1].date });
      }
    }
    allNon.sort((a, b) => b.score - a.score);
    console.log('\n  Top 15 highest-scoring windows:');
    for (const w of allNon.slice(0, 15)) {
      const gated = w.reason === 'concordant' ? ' [concordant]' : w.reason === 'slope_gate' ? ' [slope]' : '';
      console.log(
        `    ${w.startDate}→${w.endDate} (${w.winSize}d)  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || '?'}%  price=${w.overallPriceChange.toFixed(1)}%  slope=${w.deltaSlopeNorm?.toFixed(2) || '?'}${gated}`,
      );
    }
  }

  // ---- Pre-breakout analysis (last 10 days before 4/21) ----
  console.log(`\n${'='.repeat(80)}`);
  console.log('  WULF — PRE-BREAKOUT (10 days ending 4/21)');
  console.log('='.repeat(80));

  const preBreakout = allDaily.filter((d) => d.date <= '2025-04-21').slice(-10);
  const avgRange = mean(allDaily.map((d) => d.rangePct));
  const avgVol = mean(allDaily.map((d) => d.totalVol));
  const last5 = preBreakout.slice(-5);
  const last5Range = mean(last5.map((d) => d.rangePct));
  const last5Vol = mean(last5.map((d) => d.totalVol));
  const last5Delta = last5.reduce((s, d) => s + d.delta, 0);
  const last5TotalVol = last5.reduce((s, d) => s + d.totalVol, 0);

  console.log(
    `  Last 5d avg range: ${last5Range.toFixed(2)}% (overall avg: ${avgRange.toFixed(2)}%, change: ${((last5Range / avgRange - 1) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  Last 5d avg vol: ${(last5Vol / 1e6).toFixed(2)}M (overall avg: ${(avgVol / 1e6).toFixed(2)}M, change: ${((last5Vol / avgVol - 1) * 100).toFixed(0)}%)`,
  );
  console.log(`  Last 5d net delta: ${(last5TotalVol > 0 ? (last5Delta / last5TotalVol) * 100 : 0).toFixed(2)}%`);

  for (let i = 0; i < preBreakout.length; i++) {
    const d = preBreakout[i];
    const prev = i > 0 ? preBreakout[i - 1] : null;
    const priceChg = prev ? (((d.close - prev.close) / prev.close) * 100).toFixed(1) : '—';
    const dir = d.delta >= 0 ? '+' : '';
    const absorb = prev && d.close < prev.close && d.delta > 0 ? ' ★ABSORB' : '';
    console.log(
      `    ${d.date}: $${d.close.toFixed(2).padStart(6)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta / 1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  rng=${d.rangePct.toFixed(2).padStart(6)}%  vol=${(d.totalVol / 1e6).toFixed(2)}M${absorb}`,
    );
  }

  // Post-breakout check
  console.log(`\n  POST-BREAKOUT (after 4/21):`);
  const postBreakout = allDaily.filter((d) => d.date > '2025-04-21').slice(0, 15);
  for (const d of postBreakout) {
    const dir = d.delta >= 0 ? '+' : '';
    console.log(
      `    ${d.date}: $${d.close.toFixed(2).padStart(6)}  ∂=${dir}${(d.delta / 1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  vol=${(d.totalVol / 1e6).toFixed(2)}M`,
    );
  }

  console.log('\nDone.');
})().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

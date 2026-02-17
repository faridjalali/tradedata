/**
 * TRON VDF Analysis — Re-run VD Accumulation scoring + divergence data
 * Fetches 1m bars for VDF scoring, daily bars for divergence table context.
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
    process.stdout.write(` ${bars.length} bars\n`);
    all.push(...bars);
    await new Promise((r) => setTimeout(r, 300));
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// ---- VDF scoring (copied from vdfDetector.js for standalone use) ----

function vdAggregateWeekly(bars1m) {
  const dailyMap = new Map();
  for (const b of bars1m) {
    const d = new Date(b.time * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(d)) dailyMap.set(d, { buyVol: 0, sellVol: 0, totalVol: 0, close: 0, open: 0, first: true });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0;
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.close = b.close;
    if (day.first) {
      day.open = b.open;
      day.first = false;
    }
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
      close: day.close,
      open: day.open,
    };
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
  const weeks = [...weekMap.entries()]
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
      };
    });
  return { daily, weeks };
}

function vdLinReg(xs, ys) {
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

function scoreAccumulationDivergence(consolBars1m, preBars1m) {
  const { daily, weeks } = vdAggregateWeekly(consolBars1m);
  if (weeks.length < 2)
    return { score: 0, detected: false, reason: 'need_2_weeks', weeks: 0, metrics: {}, daily, weeksData: weeks };
  const totalVol = daily.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / daily.length;
  const closes = daily.map((d) => d.close);
  const overallPriceChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  if (overallPriceChange > 10)
    return {
      score: 0,
      detected: false,
      reason: 'price_rising',
      weeks: weeks.length,
      metrics: { overallPriceChange },
      daily,
      weeksData: weeks,
    };
  if (overallPriceChange < -45)
    return {
      score: 0,
      detected: false,
      reason: 'crash',
      weeks: weeks.length,
      metrics: { overallPriceChange },
      daily,
      weeksData: weeks,
    };
  const preAgg = vdAggregateWeekly(preBars1m);
  const preAvgDelta = preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.delta, 0) / preAgg.daily.length : 0;
  const preAvgVol =
    preAgg.daily.length > 0 ? preAgg.daily.reduce((s, d) => s + d.totalVol, 0) / preAgg.daily.length : avgDailyVol;
  const netDelta = daily.reduce((s, d) => s + d.delta, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
  if (netDeltaPct < -1.5)
    return {
      score: 0,
      detected: false,
      reason: 'concordant_selling',
      weeks: weeks.length,
      metrics: { netDeltaPct, overallPriceChange },
      daily,
      weeksData: weeks,
    };
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const w of weeks) {
    cwd += w.delta;
    cumWeeklyDelta.push(cwd);
  }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (vdLinReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;
  const consolAvgDailyDelta = netDelta / daily.length;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;
  let strongAbsorptionDays = 0;
  for (let i = 1; i < daily.length; i++) {
    if (daily[i].close < daily[i - 1].close && daily[i].delta > avgDailyVol * 0.05) strongAbsorptionDays++;
  }
  const strongAbsorptionPct = daily.length > 1 ? (strongAbsorptionDays / (daily.length - 1)) * 100 : 0;
  const largeBuyDays = daily.filter((d) => d.delta > avgDailyVol * 0.1).length;
  const largeSellDays = daily.filter((d) => d.delta < -avgDailyVol * 0.1).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / daily.length) * 100;
  const cumDeltas = [];
  let cd = 0;
  for (const d of daily) {
    cd += d.delta;
    cumDeltas.push(cd);
  }
  let priceDeltaCorr = 0;
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
    priceDeltaCorr = varP > 0 && varD > 0 ? cov / Math.sqrt(varP * varD) : 0;
  }
  const accumWeeks = weeks.filter((w) => w.deltaPct > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;
  let volContractionScore = 0;
  if (daily.length >= 9) {
    const dThird = Math.floor(daily.length / 3);
    const t1Ranges = daily
      .slice(0, dThird)
      .map((d) => (d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0) * 100);
    const t3Ranges = daily
      .slice(2 * dThird)
      .map((d) => (d.close !== 0 ? Math.abs(d.close - d.open) / d.close : 0) * 100);
    const avgT1 = t1Ranges.reduce((s, v) => s + v, 0) / t1Ranges.length;
    const avgT3 = t3Ranges.reduce((s, v) => s + v, 0) / t3Ranges.length;
    if (avgT1 > 0) {
      const contraction = (avgT3 - avgT1) / avgT1;
      volContractionScore = Math.max(0, Math.min(1, -contraction / 0.4));
    }
  }
  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5));
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4));
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8));
  const s4 = Math.max(0, Math.min(1, strongAbsorptionPct / 18));
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12));
  const s6 = Math.max(0, Math.min(1, (-priceDeltaCorr + 0.3) / 1.5));
  const s7 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6));
  const s8 = volContractionScore;
  const rawScore = s1 * 0.22 + s2 * 0.18 + s3 * 0.15 + s4 * 0.13 + s5 * 0.08 + s6 * 0.09 + s7 * 0.05 + s8 * 0.1;
  const durationMultiplier = Math.min(1.15, 0.7 + (weeks.length - 2) * 0.075);
  const score = weeks.length >= 2 ? rawScore * durationMultiplier : 0;
  const detected = score >= 0.3;
  return {
    score,
    detected,
    reason: detected ? 'accumulation_divergence' : 'below_threshold',
    weeks: weeks.length,
    accumWeeks,
    durationMultiplier,
    metrics: {
      netDeltaPct,
      deltaSlopeNorm,
      deltaShift,
      strongAbsorptionPct,
      largeBuyVsSell,
      priceDeltaCorr,
      accumWeekRatio,
      overallPriceChange,
      volContractionScore,
      s1,
      s2,
      s3,
      s4,
      s5,
      s6,
      s7,
      s8,
      rawScore,
    },
    daily,
    weeksData: weeks,
  };
}

// ---- Main ----

(async () => {
  const symbol = 'TRON';
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]; // 2026-02-14

  console.log(`\n=== VDF Analysis for ${symbol} — ${todayStr} ===\n`);

  // 1. Fetch daily bars for price context (last 90 days)
  const dailyFrom = new Date(today);
  dailyFrom.setDate(dailyFrom.getDate() - 90);
  const dailyFromStr = dailyFrom.toISOString().split('T')[0];
  console.log(`Fetching daily bars ${dailyFromStr} -> ${todayStr}...`);
  const dailyBars = await fetchBars(symbol, 1, 'day', dailyFromStr, todayStr);
  console.log(`  Got ${dailyBars.length} daily bars\n`);

  // Print daily price action (last 30 days)
  console.log('--- Daily Price Action (last 45 days) ---');
  const recent45 = dailyBars.slice(-45);
  for (const b of recent45) {
    const d = new Date(b.time * 1000).toISOString().split('T')[0];
    const change = (((b.close - b.open) / b.open) * 100).toFixed(2);
    const dir = b.close >= b.open ? '▲' : '▼';
    console.log(
      `  ${d}  O:${b.open.toFixed(2)}  H:${b.high.toFixed(2)}  L:${b.low.toFixed(2)}  C:${b.close.toFixed(2)}  ${dir}${change}%  Vol:${(b.volume / 1000).toFixed(0)}K`,
    );
  }
  console.log();

  // 2. Fetch 1m bars for VDF scoring (75 days = 42 consol + 30 pre)
  const oneMinFrom = new Date(today);
  oneMinFrom.setDate(oneMinFrom.getDate() - 75);
  const oneMinFromStr = oneMinFrom.toISOString().split('T')[0];
  console.log(`Fetching 1m bars ${oneMinFromStr} -> ${todayStr}...`);
  const bars1m = await fetch1mChunked(symbol, oneMinFromStr, todayStr);
  console.log(`  Total: ${bars1m.length} 1m bars\n`);

  // 3. Split into consolidation and pre-context (same logic as detectVDF)
  const sorted = bars1m.sort((a, b) => a.time - b.time);
  const latestTime = sorted[sorted.length - 1].time;
  const consolCutoff = latestTime - 42 * 86400; // 42 days back
  const preCutoff = consolCutoff - 30 * 86400;
  const consolBars = sorted.filter((b) => b.time >= consolCutoff);
  const preBars = sorted.filter((b) => b.time >= preCutoff && b.time < consolCutoff);

  console.log(
    `Consolidation window: ${consolBars.length} bars (${new Date(consolCutoff * 1000).toISOString().split('T')[0]} to ${new Date(latestTime * 1000).toISOString().split('T')[0]})`,
  );
  console.log(`Pre-context window: ${preBars.length} bars\n`);

  // 4. Run scoring
  const result = scoreAccumulationDivergence(consolBars, preBars);

  console.log('=== VDF SCORING RESULT ===');
  console.log(`  Detected:            ${result.detected}`);
  console.log(`  Score:               ${result.score.toFixed(4)}`);
  console.log(`  Reason:              ${result.reason}`);
  console.log(`  Weeks analyzed:      ${result.weeks}`);
  console.log(`  Accumulation weeks:  ${result.accumWeeks}`);
  console.log(`  Duration multiplier: ${result.durationMultiplier.toFixed(3)}`);
  console.log();
  console.log('--- Raw Metrics ---');
  const m = result.metrics;
  console.log(`  Overall price change:  ${m.overallPriceChange?.toFixed(2)}%`);
  console.log(`  Net delta %:           ${m.netDeltaPct?.toFixed(4)}%`);
  console.log(`  Delta slope (norm):    ${m.deltaSlopeNorm?.toFixed(4)}`);
  console.log(`  Delta shift vs pre:    ${m.deltaShift?.toFixed(4)}`);
  console.log(`  Strong absorption %:   ${m.strongAbsorptionPct?.toFixed(2)}%`);
  console.log(`  Large buy vs sell %:   ${m.largeBuyVsSell?.toFixed(2)}%`);
  console.log(`  Price-delta corr:      ${m.priceDeltaCorr?.toFixed(4)}`);
  console.log(`  Accum week ratio:      ${m.accumWeekRatio?.toFixed(4)}`);
  console.log(`  Vol contraction score: ${m.volContractionScore?.toFixed(4)}`);
  console.log();
  console.log('--- Score Components (0-1 each) ---');
  console.log(`  s1 (Net Delta, 22%):      ${m.s1?.toFixed(4)}  weighted: ${(m.s1 * 0.22).toFixed(4)}`);
  console.log(`  s2 (Delta Slope, 18%):    ${m.s2?.toFixed(4)}  weighted: ${(m.s2 * 0.18).toFixed(4)}`);
  console.log(`  s3 (Delta Shift, 15%):    ${m.s3?.toFixed(4)}  weighted: ${(m.s3 * 0.15).toFixed(4)}`);
  console.log(`  s4 (Absorption, 13%):     ${m.s4?.toFixed(4)}  weighted: ${(m.s4 * 0.13).toFixed(4)}`);
  console.log(`  s5 (Buy vs Sell, 8%):     ${m.s5?.toFixed(4)}  weighted: ${(m.s5 * 0.08).toFixed(4)}`);
  console.log(`  s6 (Anti-corr, 9%):       ${m.s6?.toFixed(4)}  weighted: ${(m.s6 * 0.09).toFixed(4)}`);
  console.log(`  s7 (Week ratio, 5%):      ${m.s7?.toFixed(4)}  weighted: ${(m.s7 * 0.05).toFixed(4)}`);
  console.log(`  s8 (Vol contraction, 10%):${m.s8?.toFixed(4)}  weighted: ${(m.s8 * 0.1).toFixed(4)}`);
  console.log(`  Raw score (pre-duration): ${m.rawScore?.toFixed(4)}`);
  console.log(`  Final score:              ${result.score.toFixed(4)} (raw × ${result.durationMultiplier.toFixed(3)})`);
  console.log(`  Threshold:                0.30`);
  console.log(`  ${result.score >= 0.3 ? 'ABOVE THRESHOLD → DETECTED' : 'BELOW THRESHOLD → NOT DETECTED'}`);
  console.log();

  // 5. Daily breakdown
  if (result.daily) {
    console.log('--- Daily Volume Delta Breakdown (consolidation window) ---');
    for (const d of result.daily) {
      const pct = d.totalVol > 0 ? ((d.delta / d.totalVol) * 100).toFixed(2) : '0.00';
      const dir = d.delta >= 0 ? '+' : '';
      const priceDir = d.close >= d.open ? '▲' : '▼';
      const priceChg = (((d.close - d.open) / d.open) * 100).toFixed(2);
      console.log(
        `  ${d.date}  Price:${d.close.toFixed(2)} ${priceDir}${priceChg}%  Delta:${dir}${(d.delta / 1000).toFixed(0)}K (${dir}${pct}%)  Vol:${(d.totalVol / 1000).toFixed(0)}K`,
      );
    }
    console.log();
  }

  // 6. Weekly breakdown
  if (result.weeksData) {
    console.log('--- Weekly Volume Delta Breakdown ---');
    for (const w of result.weeksData) {
      const dir = w.delta >= 0 ? '+' : '';
      console.log(
        `  Week of ${w.weekStart}: Delta ${dir}${(w.delta / 1000).toFixed(0)}K (${dir}${w.deltaPct.toFixed(2)}%)  Vol:${(w.totalVol / 1000).toFixed(0)}K  Days:${w.nDays}`,
      );
    }
    console.log();
  }

  // 7. Cumulative delta trajectory
  if (result.daily) {
    console.log('--- Cumulative Delta Trajectory ---');
    let cumDelta = 0;
    for (const d of result.daily) {
      cumDelta += d.delta;
      const bar =
        d.delta >= 0
          ? '█'.repeat(
              Math.min(
                40,
                Math.round(Math.abs(d.delta) / (result.daily.reduce((s, x) => Math.max(s, Math.abs(x.delta)), 1) / 20)),
              ),
            )
          : '';
      const barNeg =
        d.delta < 0
          ? '░'.repeat(
              Math.min(
                40,
                Math.round(Math.abs(d.delta) / (result.daily.reduce((s, x) => Math.max(s, Math.abs(x.delta)), 1) / 20)),
              ),
            )
          : '';
      console.log(
        `  ${d.date}  cumΔ:${(cumDelta / 1e6).toFixed(2)}M  ${d.delta >= 0 ? '+' : ''}${(d.delta / 1000).toFixed(0)}K ${bar}${barNeg}`,
      );
    }
    console.log();
  }
})().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

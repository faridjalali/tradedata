/**
 * VDF Deep Analysis — STX (Seagate)
 * Full period: 1/22/25 - 4/29/25
 * Possible slow accumulation pattern
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
    await new Promise(r => setTimeout(r, 250));
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function mean(arr) { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function std(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }

function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] ** 2; sxy += xs[i] * ys[i]; }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) { ssTot += (ys[i] - yMean) ** 2; ssRes += (ys[i] - intercept - slope * xs[i]) ** 2; }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

function buildDaily(bars1m) {
  const dailyMap = new Map();
  for (const b of bars1m) {
    const d = new Date(b.time * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(d)) dailyMap.set(d, { buyVol: 0, sellVol: 0, totalVol: 0, high: -Infinity, low: Infinity, close: 0, open: 0, first: true });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : (b.close < b.open ? -b.volume : 0);
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.close = b.close;
    day.high = Math.max(day.high, b.high);
    day.low = Math.min(day.low, b.low);
    if (day.first) { day.open = b.open; day.first = false; }
  }
  const dates = [...dailyMap.keys()].sort();
  return dates.map(d => {
    const day = dailyMap.get(d);
    return {
      date: d, delta: day.buyVol - day.sellVol, totalVol: day.totalVol,
      buyVol: day.buyVol, sellVol: day.sellVol,
      close: day.close, open: day.open, high: day.high, low: day.low,
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
  return [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, days]) => {
    const buyVol = days.reduce((s, d) => s + d.buyVol, 0);
    const sellVol = days.reduce((s, d) => s + d.sellVol, 0);
    const totalVol = days.reduce((s, d) => s + d.totalVol, 0);
    return {
      weekStart, delta: buyVol - sellVol, totalVol,
      deltaPct: totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0,
      nDays: days.length,
      open: days[0].open, close: days[days.length - 1].close,
      high: Math.max(...days.map(d => d.high)),
      low: Math.min(...days.map(d => d.low)),
      avgRange: mean(days.map(d => d.rangePct)),
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
  const closes = dailySlice.map(d => d.close);
  const overallPriceChange = ((closes[n - 1] - closes[0]) / closes[0]) * 100;

  if (overallPriceChange > 10 || overallPriceChange < -45) return null;

  const preAvgDelta = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.delta, 0) / preDaily.length : 0;
  const preAvgVol = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.totalVol, 0) / preDaily.length : avgDailyVol;

  let effectiveDeltas = dailySlice.map(d => d.delta);
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
  for (const wd of weeklyDeltas) { cwd += wd; cumWeeklyDelta.push(cwd); }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (linReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  if (deltaSlopeNorm < -0.5) return { score: 0, reason: 'slope_gate', netDeltaPct, overallPriceChange, deltaSlopeNorm };

  const consolAvgDailyDelta = netDelta / n;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  let absorptionDays = 0;
  for (let i = 1; i < n; i++) {
    if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > 0) absorptionDays++;
  }
  const absorptionPct = n > 1 ? (absorptionDays / (n - 1)) * 100 : 0;

  const largeBuyDays = dailySlice.filter(d => d.delta > avgDailyVol * 0.10).length;
  const largeSellDays = dailySlice.filter(d => d.delta < -avgDailyVol * 0.10).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / n) * 100;

  const cumDeltas = [];
  let cd = 0;
  for (const ed of effectiveDeltas) { cd += ed; cumDeltas.push(cd); }
  const meanP = mean(closes);
  const meanD = mean(cumDeltas);
  let cov = 0, varP = 0, varD = 0;
  for (let i = 0; i < n; i++) {
    cov += (closes[i] - meanP) * (cumDeltas[i] - meanD);
    varP += (closes[i] - meanP) ** 2;
    varD += (cumDeltas[i] - meanD) ** 2;
  }
  const priceDeltaCorr = (varP > 0 && varD > 0) ? cov / Math.sqrt(varP * varD) : 0;

  const accumWeeks = weeklyDeltas.filter(wd => wd > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;

  const third = Math.floor(n / 3);
  const t1Vols = dailySlice.slice(0, third).map(d => d.totalVol);
  const t3Vols = dailySlice.slice(2 * third).map(d => d.totalVol);
  const volDeclineScore = (mean(t1Vols) > 0 && mean(t3Vols) < mean(t1Vols))
    ? Math.min(1, (mean(t1Vols) - mean(t3Vols)) / mean(t1Vols) / 0.3)
    : 0;

  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5));
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4));
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8));
  const s4 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6));
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12));
  const s6 = Math.max(0, Math.min(1, absorptionPct / 20));
  const s7 = volDeclineScore;

  const rawScore = s1 * 0.25 + s2 * 0.22 + s3 * 0.15 + s4 * 0.15 + s5 * 0.10 + s6 * 0.08 + s7 * 0.05;
  const durationMultiplier = Math.min(1.15, 0.70 + (weeks.length - 2) * 0.075);
  const score = rawScore * durationMultiplier;

  return {
    score, detected: score >= 0.30, netDeltaPct, overallPriceChange,
    deltaSlopeNorm, priceDeltaCorr, accumWeekRatio, deltaShift,
    weeks: weeks.length, accumWeeks, absorptionPct,
    largeBuyVsSell, volDeclineScore,
    components: { s1, s2, s3, s4, s5, s6, s7 },
    durationMultiplier, cappedDays,
    weeksData: weeks.map((w, i) => ({ ...w, effectiveDelta: weeklyDeltas[i] })),
  };
}

function findAccumulationZones(allDaily, preDaily) {
  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  const detected = [];

  for (const winSize of windowSizes) {
    if (allDaily.length < winSize) continue;
    for (let start = 0; start <= allDaily.length - winSize; start++) {
      const slice = allDaily.slice(start, start + winSize);
      const result = scoreSubwindow(slice, preDaily);
      if (result && result.detected) {
        detected.push({
          start, end: start + winSize - 1, winSize,
          startDate: slice[0].date, endDate: slice[slice.length - 1].date,
          ...result
        });
      }
    }
  }

  detected.sort((a, b) => b.score - a.score);

  const zones = [];
  for (const w of detected) {
    let overlaps = false;
    for (const z of zones) {
      const overlapStart = Math.max(w.start, z.start);
      const overlapEnd = Math.min(w.end, z.end);
      const overlapDays = Math.max(0, overlapEnd - overlapStart + 1);
      const thisSize = w.end - w.start + 1;
      const gap = w.start > z.end ? w.start - z.end : z.start > w.end ? z.start - w.end : 0;
      if (overlapDays / thisSize > 0.30 || gap < 10) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps && zones.length < 3) {
      zones.push(w);
    }
  }

  return zones;
}

(async () => {
  console.log('=== VDF Deep Analysis — STX ===\n');

  console.log('Fetching full period (1/22/25 → 4/29/25)...');
  const allBars = await fetch1mChunked('STX', '2025-01-22', '2025-04-29');
  console.log('Fetching pre-context (12/22/24 → 1/22/25)...');
  const preBars = await fetch1mChunked('STX', '2024-12-22', '2025-01-22');
  console.log(`Total: Full=${allBars.length} bars, Pre=${preBars.length} bars\n`);

  const allDaily = buildDaily(allBars);
  const preDaily = buildDaily(preBars);
  const allWeeks = buildWeeks(allDaily);

  console.log('='.repeat(80));
  console.log('  STX — FULL PERIOD OVERVIEW (1/22/25 → 4/29/25)');
  console.log('='.repeat(80));

  console.log('\n  Daily data:');
  for (const d of allDaily) {
    const dir = d.delta >= 0 ? '+' : '';
    console.log(`    ${d.date}: $${d.close.toFixed(2).padStart(7)}  ∂=${dir}${(d.delta/1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  rng=${d.rangePct.toFixed(2).padStart(6)}%  vol=${(d.totalVol/1e6).toFixed(2)}M`);
  }

  console.log('\n  Weekly summary:');
  for (const w of allWeeks) {
    const dir = w.delta >= 0 ? '+' : '';
    const priceDir = w.close >= w.open ? '▲' : '▼';
    console.log(`    ${w.weekStart}: ${priceDir} $${w.open.toFixed(2)}→$${w.close.toFixed(2)}  ∂=${dir}${w.deltaPct.toFixed(2).padStart(7)}%  (${dir}${(w.delta/1000).toFixed(0).padStart(7)}K)  rng=${w.avgRange.toFixed(2).padStart(6)}%  vol=${(w.avgVol/1e6).toFixed(2)}M  [${w.nDays}d]`);
  }

  console.log(`\n  Cumulative delta vs price:`);
  let cumDelta = 0;
  for (const w of allWeeks) {
    cumDelta += w.delta;
    const priceDir = w.close >= w.open ? '▲' : '▼';
    const dDir = cumDelta >= 0 ? '+' : '';
    console.log(`    ${w.weekStart}: price $${w.close.toFixed(2)} ${priceDir}  cum∂=${dDir}${(cumDelta/1000).toFixed(0)}K`);
  }

  // Also show a "slow accumulation" metric: rolling 5-day net delta %
  console.log(`\n  Rolling 5-day net delta % (to spot gradual accumulation):`);
  for (let i = 4; i < allDaily.length; i++) {
    const slice = allDaily.slice(i - 4, i + 1);
    const totalVol = slice.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = slice.reduce((s, d) => s + d.delta, 0);
    const pct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    const bar = pct > 0 ? '+'.repeat(Math.min(20, Math.round(pct))) : '-'.repeat(Math.min(20, Math.round(-pct)));
    console.log(`    ${allDaily[i].date}: ${pct >= 0 ? '+' : ''}${pct.toFixed(1).padStart(6)}%  ${bar}`);
  }

  // Subwindow scanning
  console.log(`\n${'='.repeat(80)}`);
  console.log('  STX — SUBWINDOW SCANNING');
  console.log('='.repeat(80));

  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  for (const winSize of windowSizes) {
    if (allDaily.length < winSize) continue;
    const weekLabel = (winSize / 5).toFixed(1);
    console.log(`\n  --- Window size: ${winSize} days (~${weekLabel} weeks) ---`);

    const windowResults = [];
    for (let start = 0; start <= allDaily.length - winSize; start++) {
      const slice = allDaily.slice(start, start + winSize);
      const result = scoreSubwindow(slice, preDaily);
      if (result) windowResults.push({ start, winSize, ...result, startDate: slice[0].date, endDate: slice[slice.length - 1].date });
    }

    windowResults.sort((a, b) => b.score - a.score);
    for (const w of windowResults.slice(0, 5)) {
      const det = w.detected ? '✅' : '  ';
      const gated = w.reason === 'concordant' ? ' [concordant]' : w.reason === 'slope_gate' ? ' [slope]' : '';
      console.log(`    ${det} ${w.startDate}→${w.endDate}  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || '?'}%  price=${w.overallPriceChange.toFixed(1)}%  corr=${w.priceDeltaCorr?.toFixed(2) || '?'}  slope=${w.deltaSlopeNorm?.toFixed(2) || '?'}  accWk=${w.accumWeeks || '?'}/${w.weeks || '?'}${gated}`);
    }

    const detectedCount = windowResults.filter(w => w.detected).length;
    const gatedCount = windowResults.filter(w => w.score === 0).length;
    console.log(`    → ${detectedCount}/${windowResults.length} detected, ${gatedCount} gated`);
  }

  // Multi-zone detection
  const zones = findAccumulationZones(allDaily, preDaily);

  if (zones.length > 0) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  STX — ${zones.length} ACCUMULATION ZONE(S) DETECTED`);
    console.log('='.repeat(80));

    for (let zi = 0; zi < zones.length; zi++) {
      const z = zones[zi];
      const c = z.components;
      console.log(`\n  Zone ${zi + 1}: ${z.startDate} → ${z.endDate} (${z.winSize}d, ${z.weeks}wk)`);
      console.log(`    Score: ${z.score.toFixed(4)}  |  Price: ${z.overallPriceChange.toFixed(1)}%  |  Net∂: ${z.netDeltaPct.toFixed(2)}%  |  Slope: ${z.deltaSlopeNorm.toFixed(2)}  |  Corr: ${z.priceDeltaCorr.toFixed(2)}`);
      console.log(`    AccWk: ${z.accumWeeks}/${z.weeks} (${(z.accumWeekRatio*100).toFixed(0)}%)  |  Absorption: ${z.absorptionPct.toFixed(1)}%  |  BuySell: ${z.largeBuyVsSell.toFixed(1)}  |  VolDecl: ${z.volDeclineScore.toFixed(2)}`);
      console.log(`    Components: s1=${c.s1.toFixed(2)} s2=${c.s2.toFixed(2)} s3=${c.s3.toFixed(2)} s4=${c.s4.toFixed(2)} s5=${c.s5.toFixed(2)} s6=${c.s6.toFixed(2)} s7=${c.s7.toFixed(2)}  durMult=${z.durationMultiplier.toFixed(3)}`);
      if (z.cappedDays?.length > 0) {
        console.log(`    Capped: ${z.cappedDays.map(cd => `${cd.date} (${(cd.original/1000).toFixed(0)}K→${(cd.capped/1000).toFixed(0)}K)`).join(', ')}`);
      }
      console.log(`    Weeks:`);
      for (const w of z.weeksData) {
        const dir = w.effectiveDelta >= 0 ? '+' : '';
        const priceDir = w.close >= w.open ? '▲' : '▼';
        console.log(`      ${w.weekStart}: ${priceDir} $${w.close.toFixed(2)}  ${dir}${(w.effectiveDelta/1000).toFixed(0)}K  (${dir}${w.deltaPct.toFixed(2)}%)  [${w.nDays}d]`);
      }

      const zoneSlice = allDaily.slice(z.start, z.start + z.winSize);
      console.log(`    Daily detail:`);
      for (let i = 0; i < zoneSlice.length; i++) {
        const d = zoneSlice[i];
        const prev = i > 0 ? zoneSlice[i-1] : null;
        const priceChg = prev ? ((d.close - prev.close) / prev.close * 100).toFixed(1) : '—';
        const dir = d.delta >= 0 ? '+' : '';
        const absorb = (prev && d.close < prev.close && d.delta > 0) ? ' ★ABSORB' : '';
        console.log(`      ${d.date}: $${d.close.toFixed(2).padStart(7)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta/1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  vol=${(d.totalVol/1e6).toFixed(2)}M${absorb}`);
      }
    }
  } else {
    console.log('\n  ❌ NO ACCUMULATION ZONES DETECTED');
    const allWindows = [];
    for (const winSize of windowSizes) {
      if (allDaily.length < winSize) continue;
      for (let start = 0; start <= allDaily.length - winSize; start++) {
        const slice = allDaily.slice(start, start + winSize);
        const result = scoreSubwindow(slice, preDaily);
        if (result) allWindows.push({ start, winSize, ...result, startDate: slice[0].date, endDate: slice[slice.length-1].date });
      }
    }
    allWindows.sort((a, b) => b.score - a.score);
    console.log('\n  Top 15 highest-scoring windows (including gated):');
    for (const w of allWindows.slice(0, 15)) {
      const gated = w.reason === 'concordant' ? ' [concordant]' : w.reason === 'slope_gate' ? ` [slope=${w.deltaSlopeNorm?.toFixed(2)}]` : '';
      console.log(`    ${w.startDate}→${w.endDate} (${w.winSize}d)  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || '?'}%  price=${w.overallPriceChange.toFixed(1)}%  slope=${w.deltaSlopeNorm?.toFixed(2) || '?'}  corr=${w.priceDeltaCorr?.toFixed(2) || '?'}${gated}`);
    }
  }

  // End-of-period analysis
  console.log(`\n${'='.repeat(80)}`);
  console.log('  STX — LAST 10 DAYS OF PERIOD');
  console.log('='.repeat(80));

  const lastDays = allDaily.slice(-10);
  const avgRange = mean(allDaily.map(d => d.rangePct));
  const avgVol = mean(allDaily.map(d => d.totalVol));
  const last5 = lastDays.slice(-5);
  const last5Range = mean(last5.map(d => d.rangePct));
  const last5Vol = mean(last5.map(d => d.totalVol));

  console.log(`  Last 5d avg range: ${last5Range.toFixed(2)}% (overall avg: ${avgRange.toFixed(2)}%)`);
  console.log(`  Last 5d avg vol: ${(last5Vol/1e6).toFixed(2)}M (overall avg: ${(avgVol/1e6).toFixed(2)}M)`);

  for (let i = 0; i < lastDays.length; i++) {
    const d = lastDays[i];
    const prev = i > 0 ? lastDays[i-1] : null;
    const priceChg = prev ? ((d.close - prev.close) / prev.close * 100).toFixed(1) : '—';
    const dir = d.delta >= 0 ? '+' : '';
    const absorb = (prev && d.close < prev.close && d.delta > 0) ? ' ★ABSORB' : '';
    console.log(`    ${d.date}: $${d.close.toFixed(2).padStart(7)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta/1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  vol=${(d.totalVol/1e6).toFixed(2)}M${absorb}`);
  }

  console.log('\nDone.');
})().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

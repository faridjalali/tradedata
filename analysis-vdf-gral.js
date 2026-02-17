/**
 * VDF Deep Analysis — GRAL (GRAIL, Inc.)
 * Full period: 6/30/25 - 11/26/25
 * True Breakout: ~9/2/25
 * Purpose: Test algorithm outside typical tariff/exogenous event window
 * ~5 months, breakout midway through period
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

function scoreSubwindow(dailySlice, preDaily) {
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
  let effectiveDeltas = dailySlice.map((d) => d.delta);
  const dm = mean(effectiveDeltas);
  const ds = std(effectiveDeltas);
  const cap = dm + 3 * ds;
  const floor = dm - 3 * ds;
  let cappedDays = [];
  effectiveDeltas = effectiveDeltas.map((d, i) => {
    if (d > cap || d < floor) {
      cappedDays.push({ date: dailySlice[i].date, original: d, capped: Math.max(floor, Math.min(cap, d)) });
      return Math.max(floor, Math.min(cap, d));
    }
    return d;
  });
  const netDelta = effectiveDeltas.reduce((s, v) => s + v, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
  if (netDeltaPct < -1.5) return { score: 0, reason: 'concordant', netDeltaPct, overallPriceChange };
  const weeklyDeltas = [];
  let dayIdx = 0;
  for (const w of weeks) {
    let wd = 0;
    for (let j = 0; j < w.nDays && dayIdx < effectiveDeltas.length; j++, dayIdx++) wd += effectiveDeltas[dayIdx];
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
  if (deltaSlopeNorm < -0.5) return { score: 0, reason: 'slope_gate', netDeltaPct, overallPriceChange, deltaSlopeNorm };
  const consolAvgDailyDelta = netDelta / n;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;
  let absorptionDays = 0;
  for (let i = 1; i < n; i++) {
    if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > 0) absorptionDays++;
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
  const third = Math.floor(n / 3);
  const t1Vols = dailySlice.slice(0, third).map((d) => d.totalVol);
  const t3Vols = dailySlice.slice(2 * third).map((d) => d.totalVol);
  const volDeclineScore =
    mean(t1Vols) > 0 && mean(t3Vols) < mean(t1Vols)
      ? Math.min(1, (mean(t1Vols) - mean(t3Vols)) / mean(t1Vols) / 0.3)
      : 0;
  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5));
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4));
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8));
  const s4 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6));
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12));
  const s6 = Math.max(0, Math.min(1, absorptionPct / 20));
  const s7 = volDeclineScore;
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
          start,
          end: start + winSize - 1,
          winSize,
          startDate: slice[0].date,
          endDate: slice[slice.length - 1].date,
          ...result,
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
      if (overlapDays / thisSize > 0.3 || gap < 10) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps && zones.length < 3) zones.push(w);
  }
  return zones;
}

function analyzeBreakoutProximity(allDaily, breakoutDate) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  BREAKOUT PROXIMITY ANALYSIS (breakout: ${breakoutDate})`);
  console.log('='.repeat(80));
  const breakoutIdx = allDaily.findIndex((d) => d.date >= breakoutDate);
  if (breakoutIdx < 15) {
    console.log('  Insufficient pre-breakout data');
    return;
  }
  const preBreakout = allDaily.slice(0, breakoutIdx);
  const n = preBreakout.length;
  const avgVol = mean(preBreakout.map((d) => d.totalVol));

  // Day-by-day last 25 days
  console.log(`\n  LAST 25 DAYS BEFORE BREAKOUT:`);
  const last25 = preBreakout.slice(-25);
  let cumD = 0;
  for (let i = 0; i < last25.length; i++) {
    const d = last25[i];
    const prev = i > 0 ? last25[i - 1] : null;
    const priceChg = prev ? (((d.close - prev.close) / prev.close) * 100).toFixed(1) : '—';
    const dir = d.delta >= 0 ? '+' : '';
    cumD += d.delta;
    const absorb = prev && d.close < prev.close && d.delta > 0 ? ' ★ABSORB' : '';
    const daysLeft = last25.length - i;
    console.log(
      `    [${String(daysLeft).padStart(2)}d] ${d.date}: $${d.close.toFixed(2).padStart(7)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta / 1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  vol=${(d.totalVol / 1e6).toFixed(2)}M  cum∂=${(cumD / 1000).toFixed(0)}K${absorb}`,
    );
  }

  // Seller exhaustion
  console.log(`\n  SELLER EXHAUSTION (consecutive red delta streaks, last 40d):`);
  const last40 = preBreakout.slice(-40);
  let streak = 0,
    streakStart = '',
    streakDeltas = [];
  for (let i = 0; i < last40.length; i++) {
    if (last40[i].delta < 0) {
      if (streak === 0) {
        streakStart = last40[i].date;
        streakDeltas = [];
      }
      streak++;
      streakDeltas.push(last40[i].delta);
    } else {
      if (streak >= 2) {
        const fading =
          streakDeltas.length >= 2 && Math.abs(streakDeltas[streakDeltas.length - 1]) < Math.abs(streakDeltas[0]);
        const intensifying =
          streakDeltas.length >= 2 && Math.abs(streakDeltas[streakDeltas.length - 1]) > Math.abs(streakDeltas[0]);
        const label = fading ? ' [FADING]' : intensifying ? ' [INTENSIFYING]' : '';
        console.log(
          `    ${streakStart}→${last40[i - 1].date}: ${streak} red days, deltas: ${streakDeltas.map((d) => (d / 1000).toFixed(0) + 'K').join(', ')}${label}`,
        );
      }
      streak = 0;
    }
  }
  if (streak >= 2) {
    const fading =
      streakDeltas.length >= 2 && Math.abs(streakDeltas[streakDeltas.length - 1]) < Math.abs(streakDeltas[0]);
    const intensifying =
      streakDeltas.length >= 2 && Math.abs(streakDeltas[streakDeltas.length - 1]) > Math.abs(streakDeltas[0]);
    const label = fading ? ' [FADING]' : intensifying ? ' [INTENSIFYING]' : '';
    console.log(
      `    ${streakStart}→${last40[last40.length - 1].date}: ${streak} red days, deltas: ${streakDeltas.map((d) => (d / 1000).toFixed(0) + 'K').join(', ')}${label}`,
    );
  }

  // Volume surges
  console.log(`\n  VOLUME SURGES (>1.5x avg) in last 30 days:`);
  const last30 = preBreakout.slice(-30);
  for (const d of last30) {
    if (d.totalVol > avgVol * 1.5) {
      const dir = d.delta >= 0 ? '+' : '';
      console.log(
        `    ${d.date}: vol=${(d.totalVol / 1e6).toFixed(2)}M (${(d.totalVol / avgVol).toFixed(1)}x avg)  ∂=${dir}${(d.delta / 1000).toFixed(0)}K  price=$${d.close.toFixed(2)}`,
      );
    }
  }

  // Cum delta acceleration
  console.log(`\n  CUM DELTA ACCELERATION (5-day rolling, last 35d):`);
  let runCumDelta = 0;
  const cumDeltas = [];
  for (const d of preBreakout) {
    runCumDelta += d.delta;
    cumDeltas.push(runCumDelta);
  }
  for (let i = Math.max(5, n - 35); i < n; i++) {
    const delta5d = cumDeltas[i] - cumDeltas[i - 5];
    const daysLeft = n - i;
    const bar =
      delta5d > 0
        ? '+'.repeat(Math.min(25, Math.round(Math.abs(delta5d) / 1000 / 20)))
        : '-'.repeat(Math.min(25, Math.round(Math.abs(delta5d) / 1000 / 20)));
    console.log(
      `    [${String(daysLeft).padStart(2)}d] ${preBreakout[i].date}: 5d∂=${(delta5d / 1000).toFixed(0).padStart(7)}K  |${bar}|`,
    );
  }

  // Green streaks
  console.log(`\n  GREEN DELTA STREAKS (last 30d):`);
  streak = 0;
  streakStart = '';
  for (let i = 0; i < last30.length; i++) {
    if (last30[i].delta > 0) {
      if (streak === 0) streakStart = last30[i].date;
      streak++;
    } else {
      if (streak >= 2) console.log(`    ${streakStart}→${last30[i - 1].date}: ${streak} consecutive green days`);
      streak = 0;
    }
  }
  if (streak >= 2)
    console.log(`    ${streakStart}→${last30[last30.length - 1].date}: ${streak} consecutive green days`);

  // Delta anomaly detection
  console.log(`\n  DELTA ANOMALY DETECTION (single day |delta| > 4x 20d rolling avg):`);
  for (let i = 20; i < n; i++) {
    const prev20 = preBreakout.slice(i - 20, i);
    const avg20Delta = mean(prev20.map((d) => Math.abs(d.delta)));
    if (avg20Delta > 0 && Math.abs(preBreakout[i].delta) > 4 * avg20Delta) {
      const d = preBreakout[i];
      const dir = d.delta >= 0 ? '+' : '';
      const daysLeft = n - i;
      const mult = (Math.abs(d.delta) / avg20Delta).toFixed(1);
      console.log(
        `    [${String(daysLeft).padStart(2)}d] ${d.date}: ∂=${dir}${(d.delta / 1000).toFixed(0)}K (${mult}x avg)  vol=${(d.totalVol / 1e6).toFixed(2)}M  price=$${d.close.toFixed(2)}  ${d.delta > 0 && d.close < (preBreakout[i - 1]?.close || d.close) ? '★ABSORB' : ''}`,
      );
    }
  }
}

function analyzeRedDeltaAndVolatility(allDaily, breakoutDate) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('  RED DELTA & DELTA VOLATILITY CONTRACTION');
  console.log('='.repeat(80));
  const breakoutIdx = allDaily.findIndex((d) => d.date >= breakoutDate);
  const preBreakout = breakoutIdx > 0 ? allDaily.slice(0, breakoutIdx) : allDaily;
  const n = preBreakout.length;
  const avgVol = mean(preBreakout.map((d) => d.totalVol));

  // Thirds for this period (~45 pre-breakout trading days)
  const tSize = Math.floor(n / 3);
  const thirds = [preBreakout.slice(0, tSize), preBreakout.slice(tSize, 2 * tSize), preBreakout.slice(2 * tSize)];
  const labels = ['T1', 'T2', 'T3'];

  console.log(`\n  By thirds (~${tSize}d each):`);
  console.log(
    `  ${''.padEnd(5)} ${'RedDays'.padStart(7)} ${'AvgRedMag'.padStart(10)} ${'RedNorm'.padStart(8)} ${'DeltaStd'.padStart(9)} ${'PriceRng'.padStart(9)} ${'NetDelta%'.padStart(10)} ${'Absorption'.padStart(10)}`,
  );
  console.log(`  ${'─'.repeat(76)}`);

  for (let t = 0; t < 3; t++) {
    const th = thirds[t];
    const redD = th.filter((d) => d.delta < 0);
    const redMags = redD.map((d) => Math.abs(d.delta));
    const thAvgVol = mean(th.map((d) => d.totalVol));
    const redNorm = thAvgVol > 0 && redMags.length > 0 ? (mean(redMags) / thAvgVol) * 100 : 0;
    const deltaStd = std(th.map((d) => d.deltaPct));
    const priceRng = mean(th.map((d) => d.rangePct));
    const netDeltaPct =
      th.reduce((s, d) => s + d.totalVol, 0) > 0
        ? (th.reduce((s, d) => s + d.delta, 0) / th.reduce((s, d) => s + d.totalVol, 0)) * 100
        : 0;
    let absrp = 0;
    for (let i = 1; i < th.length; i++) {
      if (th[i].close < th[i - 1].close && th[i].delta > 0) absrp++;
    }
    const absrpPct = th.length > 1 ? (absrp / (th.length - 1)) * 100 : 0;
    console.log(
      `  ${labels[t].padEnd(5)} ${(redD.length + '/' + th.length).padStart(7)} ${((mean(redMags) / 1000).toFixed(0) + 'K').padStart(10)} ${(redNorm.toFixed(1) + '%').padStart(8)} ${deltaStd.toFixed(1).padStart(9)} ${priceRng.toFixed(2).padStart(9)} ${(netDeltaPct.toFixed(1) + '%').padStart(10)} ${(absrpPct.toFixed(0) + '%').padStart(10)}`,
    );
  }

  const redDays = preBreakout.filter((d) => d.delta < 0);
  if (redDays.length >= 5) {
    const redYs = redDays.map((d) => (avgVol > 0 ? (Math.abs(d.delta) / avgVol) * 100 : 0));
    const redXs = redDays.map((_, i) => i);
    const reg = linReg(redXs, redYs);
    const normSlope = mean(redYs) > 0 ? (reg.slope / mean(redYs)) * 100 : 0;
    console.log(
      `\n  RED delta linear trend: slope=${normSlope.toFixed(2)}% per red day, R²=${reg.r2.toFixed(3)}, ${reg.slope < 0 ? 'CONTRACTING' : 'EXPANDING'}`,
    );
  }

  const deltaPcts = preBreakout.map((d) => d.deltaPct);
  const halfIdx = Math.floor(n / 2);
  const firstDeltaStd = std(deltaPcts.slice(0, halfIdx));
  const secondDeltaStd = std(deltaPcts.slice(halfIdx));
  const dvChange = firstDeltaStd > 0 ? ((secondDeltaStd - firstDeltaStd) / firstDeltaStd) * 100 : 0;
  console.log(
    `  Delta volatility: 1st half std=${firstDeltaStd.toFixed(1)}, 2nd half std=${secondDeltaStd.toFixed(1)}, change=${dvChange > 0 ? '+' : ''}${dvChange.toFixed(0)}%`,
  );
}

// Distribution zone scanning (from BW analysis)
function analyzeDistributionPhases(allDaily, breakoutDate) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('  DISTRIBUTION / ACCUMULATION PHASE SCANNING');
  console.log('='.repeat(80));

  const breakoutIdx = allDaily.findIndex((d) => d.date >= breakoutDate);
  const preBreakout = breakoutIdx > 0 ? allDaily.slice(0, breakoutIdx) : allDaily;

  // 10-day rolling window distribution detection: price UP but delta NEGATIVE
  console.log(`\n  DISTRIBUTION WINDOWS (10d rolling: price >+3% but cum delta < -5%):`);
  for (let i = 10; i < preBreakout.length; i++) {
    const window = preBreakout.slice(i - 10, i);
    const priceChange = ((window[9].close - window[0].close) / window[0].close) * 100;
    const totalVol = window.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = window.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    if (priceChange > 3 && netDeltaPct < -5) {
      console.log(
        `    ${window[0].date}→${window[9].date}: price ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(1)}%, delta ${netDeltaPct.toFixed(1)}% — DISTRIBUTION`,
      );
    }
  }

  // 10-day rolling window accumulation detection: price DOWN but delta POSITIVE
  console.log(`\n  ACCUMULATION WINDOWS (10d rolling: price <-3% but cum delta > +5%):`);
  for (let i = 10; i < preBreakout.length; i++) {
    const window = preBreakout.slice(i - 10, i);
    const priceChange = ((window[9].close - window[0].close) / window[0].close) * 100;
    const totalVol = window.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = window.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    if (priceChange < -3 && netDeltaPct > 5) {
      console.log(
        `    ${window[0].date}→${window[9].date}: price ${priceChange.toFixed(1)}%, delta +${netDeltaPct.toFixed(1)}% — ACCUMULATION IN DECLINE`,
      );
    }
  }
}

(async () => {
  console.log('=== VDF Deep Analysis — GRAL ===\n');
  console.log('Context: Non-tariff breakout. Testing algorithm outside April 2025 exogenous event window.\n');

  console.log('Fetching full period (6/30/25 → 11/26/25)...');
  const allBars = await fetch1mChunked('GRAL', '2025-06-30', '2025-11-26');
  console.log('Fetching pre-context (5/30/25 → 6/30/25)...');
  const preBars = await fetch1mChunked('GRAL', '2025-05-30', '2025-06-30');
  console.log(`Total: Full=${allBars.length} bars, Pre=${preBars.length} bars\n`);

  const allDaily = buildDaily(allBars);
  const preDaily = buildDaily(preBars);
  const allWeeks = buildWeeks(allDaily);

  console.log('='.repeat(80));
  console.log('  GRAL — FULL PERIOD OVERVIEW (6/30/25 → 11/26/25)');
  console.log('='.repeat(80));

  // Price range summary
  const closes = allDaily.map((d) => d.close);
  const minPrice = Math.min(...closes);
  const maxPrice = Math.max(...closes);
  const startPrice = closes[0];
  const endPrice = closes[closes.length - 1];
  console.log(
    `\n  Start: $${startPrice.toFixed(2)}  End: $${endPrice.toFixed(2)}  Low: $${minPrice.toFixed(2)}  High: $${maxPrice.toFixed(2)}`,
  );
  console.log(`  Total return: ${(((endPrice - startPrice) / startPrice) * 100).toFixed(1)}%`);
  console.log(`  Trading days: ${allDaily.length}`);

  // Weekly summary
  console.log('\n  Weekly summary:');
  for (const w of allWeeks) {
    const dir = w.delta >= 0 ? '+' : '';
    const priceDir = w.close >= w.open ? '▲' : '▼';
    console.log(
      `    ${w.weekStart}: ${priceDir} $${w.open.toFixed(2)}→$${w.close.toFixed(2)}  ∂=${dir}${w.deltaPct.toFixed(2).padStart(7)}%  (${dir}${(w.delta / 1000).toFixed(0).padStart(7)}K)  rng=${w.avgRange.toFixed(2).padStart(6)}%  vol=${(w.avgVol / 1e6).toFixed(2)}M  [${w.nDays}d]`,
    );
  }

  console.log(`\n  Cumulative delta vs price:`);
  let cumDelta = 0;
  for (const w of allWeeks) {
    cumDelta += w.delta;
    const priceDir = w.close >= w.open ? '▲' : '▼';
    const dDir = cumDelta >= 0 ? '+' : '';
    console.log(
      `    ${w.weekStart}: price $${w.close.toFixed(2)} ${priceDir}  cum∂=${dDir}${(cumDelta / 1000).toFixed(0)}K`,
    );
  }

  // Rolling 5-day delta
  console.log(`\n  Rolling 5-day net delta % (every 2nd day):`);
  for (let i = 4; i < allDaily.length; i += 2) {
    const slice = allDaily.slice(i - 4, i + 1);
    const totalVol = slice.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = slice.reduce((s, d) => s + d.delta, 0);
    const pct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    const bar = pct > 0 ? '+'.repeat(Math.min(20, Math.round(pct))) : '-'.repeat(Math.min(20, Math.round(-pct)));
    console.log(`    ${allDaily[i].date}: ${pct >= 0 ? '+' : ''}${pct.toFixed(1).padStart(6)}%  ${bar}`);
  }

  // Subwindow scanning
  console.log(`\n${'='.repeat(80)}`);
  console.log('  GRAL — SUBWINDOW SCANNING');
  console.log('='.repeat(80));

  // Only scan pre-breakout data for accumulation zones
  const breakoutIdx = allDaily.findIndex((d) => d.date >= '2025-09-02');
  const preBreakoutDaily = breakoutIdx > 0 ? allDaily.slice(0, breakoutIdx) : allDaily;
  console.log(`\n  Pre-breakout trading days: ${preBreakoutDaily.length}`);

  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  for (const winSize of windowSizes) {
    if (preBreakoutDaily.length < winSize) continue;
    const weekLabel = (winSize / 5).toFixed(1);
    console.log(`\n  --- Window size: ${winSize} days (~${weekLabel} weeks) ---`);
    const windowResults = [];
    for (let start = 0; start <= preBreakoutDaily.length - winSize; start++) {
      const slice = preBreakoutDaily.slice(start, start + winSize);
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
    for (const w of windowResults.slice(0, 5)) {
      const det = w.detected ? '✅' : '  ';
      const gated = w.reason === 'concordant' ? ' [concordant]' : w.reason === 'slope_gate' ? ' [slope]' : '';
      console.log(
        `    ${det} ${w.startDate}→${w.endDate}  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || '?'}%  price=${w.overallPriceChange.toFixed(1)}%  corr=${w.priceDeltaCorr?.toFixed(2) || '?'}  slope=${w.deltaSlopeNorm?.toFixed(2) || '?'}  accWk=${w.accumWeeks || '?'}/${w.weeks || '?'}${gated}`,
      );
    }
    const detectedCount = windowResults.filter((w) => w.detected).length;
    const gatedCount = windowResults.filter((w) => w.score === 0).length;
    console.log(`    → ${detectedCount}/${windowResults.length} detected, ${gatedCount} gated`);
  }

  // Multi-zone detection on pre-breakout data
  const zones = findAccumulationZones(preBreakoutDaily, preDaily);

  if (zones.length > 0) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  GRAL — ${zones.length} ACCUMULATION ZONE(S) DETECTED`);
    console.log('='.repeat(80));
    for (let zi = 0; zi < zones.length; zi++) {
      const z = zones[zi];
      const c = z.components;
      console.log(`\n  Zone ${zi + 1}: ${z.startDate} → ${z.endDate} (${z.winSize}d, ${z.weeks}wk)`);
      console.log(
        `    Score: ${z.score.toFixed(4)}  |  Price: ${z.overallPriceChange.toFixed(1)}%  |  Net∂: ${z.netDeltaPct.toFixed(2)}%  |  Slope: ${z.deltaSlopeNorm.toFixed(2)}  |  Corr: ${z.priceDeltaCorr.toFixed(2)}`,
      );
      console.log(
        `    AccWk: ${z.accumWeeks}/${z.weeks} (${(z.accumWeekRatio * 100).toFixed(0)}%)  |  Absorption: ${z.absorptionPct.toFixed(1)}%  |  BuySell: ${z.largeBuyVsSell.toFixed(1)}  |  VolDecl: ${z.volDeclineScore.toFixed(2)}`,
      );
      console.log(
        `    Components: s1=${c.s1.toFixed(2)} s2=${c.s2.toFixed(2)} s3=${c.s3.toFixed(2)} s4=${c.s4.toFixed(2)} s5=${c.s5.toFixed(2)} s6=${c.s6.toFixed(2)} s7=${c.s7.toFixed(2)}  durMult=${z.durationMultiplier.toFixed(3)}`,
      );
      if (z.cappedDays?.length > 0)
        console.log(
          `    Capped: ${z.cappedDays.map((cd) => `${cd.date} (${(cd.original / 1000).toFixed(0)}K→${(cd.capped / 1000).toFixed(0)}K)`).join(', ')}`,
        );
      console.log(`    Weeks:`);
      for (const w of z.weeksData) {
        const dir = w.effectiveDelta >= 0 ? '+' : '';
        const priceDir = w.close >= w.open ? '▲' : '▼';
        console.log(
          `      ${w.weekStart}: ${priceDir} $${w.close.toFixed(2)}  ${dir}${(w.effectiveDelta / 1000).toFixed(0)}K  (${dir}${w.deltaPct.toFixed(2)}%)  [${w.nDays}d]`,
        );
      }
      const zoneSlice = preBreakoutDaily.slice(z.start, z.start + z.winSize);
      console.log(`    Daily detail:`);
      for (let i = 0; i < zoneSlice.length; i++) {
        const d = zoneSlice[i];
        const prev = i > 0 ? zoneSlice[i - 1] : null;
        const priceChg = prev ? (((d.close - prev.close) / prev.close) * 100).toFixed(1) : '—';
        const dir = d.delta >= 0 ? '+' : '';
        const absorb = prev && d.close < prev.close && d.delta > 0 ? ' ★ABSORB' : '';
        console.log(
          `      ${d.date}: $${d.close.toFixed(2).padStart(7)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta / 1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  vol=${(d.totalVol / 1e6).toFixed(2)}M${absorb}`,
        );
      }
    }
  } else {
    console.log('\n  ❌ NO ACCUMULATION ZONES DETECTED');
    const allWindows = [];
    for (const winSize of windowSizes) {
      if (preBreakoutDaily.length < winSize) continue;
      for (let start = 0; start <= preBreakoutDaily.length - winSize; start++) {
        const slice = preBreakoutDaily.slice(start, start + winSize);
        const result = scoreSubwindow(slice, preDaily);
        if (result)
          allWindows.push({
            start,
            winSize,
            ...result,
            startDate: slice[0].date,
            endDate: slice[slice.length - 1].date,
          });
      }
    }
    allWindows.sort((a, b) => b.score - a.score);
    console.log('\n  Top 15 highest-scoring windows (including gated):');
    for (const w of allWindows.slice(0, 15)) {
      const gated =
        w.reason === 'concordant'
          ? ' [concordant]'
          : w.reason === 'slope_gate'
            ? ` [slope=${w.deltaSlopeNorm?.toFixed(2)}]`
            : '';
      console.log(
        `    ${w.startDate}→${w.endDate} (${w.winSize}d)  score=${w.score.toFixed(4)}  net∂=${w.netDeltaPct?.toFixed(2) || '?'}%  price=${w.overallPriceChange.toFixed(1)}%  slope=${w.deltaSlopeNorm?.toFixed(2) || '?'}  corr=${w.priceDeltaCorr?.toFixed(2) || '?'}${gated}`,
      );
    }
  }

  // Also scan full period for post-breakout zones
  console.log(`\n${'='.repeat(80)}`);
  console.log('  GRAL — POST-BREAKOUT ZONE SCANNING');
  console.log('='.repeat(80));
  if (breakoutIdx > 0 && breakoutIdx < allDaily.length - 10) {
    const postDaily = allDaily.slice(breakoutIdx);
    const postZones = findAccumulationZones(postDaily, preBreakoutDaily.slice(-30));
    if (postZones.length > 0) {
      for (let zi = 0; zi < postZones.length; zi++) {
        const z = postZones[zi];
        console.log(
          `\n  Post-Zone ${zi + 1}: ${z.startDate} → ${z.endDate} (${z.winSize}d, score=${z.score.toFixed(4)})`,
        );
        console.log(
          `    Net∂: ${z.netDeltaPct.toFixed(2)}%  Price: ${z.overallPriceChange.toFixed(1)}%  Absorption: ${z.absorptionPct.toFixed(1)}%`,
        );
      }
    } else {
      console.log('\n  No post-breakout accumulation zones detected.');
    }
  }

  // Distribution/accumulation phase scanning
  analyzeDistributionPhases(allDaily, '2025-09-02');

  // RED DELTA & VOL
  analyzeRedDeltaAndVolatility(allDaily, '2025-09-02');

  // BREAKOUT PROXIMITY
  analyzeBreakoutProximity(allDaily, '2025-09-02');

  // Breakout and post-breakout
  if (breakoutIdx > 0 && breakoutIdx < allDaily.length) {
    console.log(`\n${'='.repeat(80)}`);
    console.log('  GRAL — BREAKOUT & POST-BREAKOUT');
    console.log('='.repeat(80));

    // Show 25 days post-breakout
    const postSlice = allDaily.slice(breakoutIdx, Math.min(breakoutIdx + 25, allDaily.length));
    const preB = allDaily.slice(0, breakoutIdx);
    console.log(`\n  Post-breakout daily (first 25 days):`);
    for (let i = 0; i < postSlice.length; i++) {
      const d = postSlice[i];
      const prev = i > 0 ? postSlice[i - 1] : preB[preB.length - 1];
      const priceChg = prev ? (((d.close - prev.close) / prev.close) * 100).toFixed(1) : '—';
      const dir = d.delta >= 0 ? '+' : '';
      console.log(
        `    ${d.date}: $${d.close.toFixed(2).padStart(7)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta / 1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)  vol=${(d.totalVol / 1e6).toFixed(2)}M`,
      );
    }

    // Post-breakout weekly summary
    console.log(`\n  Post-breakout weekly summary:`);
    const postWeeks = buildWeeks(allDaily.slice(breakoutIdx));
    for (const w of postWeeks) {
      const dir = w.delta >= 0 ? '+' : '';
      const priceDir = w.close >= w.open ? '▲' : '▼';
      console.log(
        `    ${w.weekStart}: ${priceDir} $${w.open.toFixed(2)}→$${w.close.toFixed(2)}  ∂=${dir}${w.deltaPct.toFixed(2).padStart(7)}%  (${dir}${(w.delta / 1000).toFixed(0).padStart(7)}K)  vol=${(w.avgVol / 1e6).toFixed(2)}M`,
      );
    }

    // Post-breakout delta polarity check (BW insight)
    const postFirst4Weeks = postWeeks.slice(0, 4);
    const posWeeks = postFirst4Weeks.filter((w) => w.delta > 0).length;
    console.log(
      `\n  Post-breakout delta polarity (first 4 weeks): ${posWeeks}/${postFirst4Weeks.length} positive → ${posWeeks >= 3 ? 'DURABLE breakout' : posWeeks <= 1 ? 'FRAGILE breakout' : 'MIXED'}`,
    );
  }

  console.log('\nDone.');
})().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

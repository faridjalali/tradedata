/**
 * VDF Cross-Ticker Analysis
 * Analyzes RED delta volatility contraction + additional pre-breakout metrics
 * across all 12 confirmed accumulation examples.
 */

require('dotenv').config();

const DATA_API_KEY = process.env.DATA_API_KEY;
const BASE = 'https://api.massive.com';

const TICKERS = [
  { symbol: 'BE',   from: '2024-08-15', to: '2024-11-26', preFr: '2024-07-15', breakout: '2024-11-08', type: 'Strong conviction' },
  { symbol: 'IREN', from: '2025-02-25', to: '2025-05-30', preFr: '2025-01-25', breakout: '2025-05-15', type: 'Concentrated bursts' },
  { symbol: 'CRDO', from: '2025-02-25', to: '2025-05-15', preFr: '2025-01-25', breakout: '2025-05-06', type: 'Strong conviction' },
  { symbol: 'WULF', from: '2025-02-01', to: '2025-05-15', preFr: '2025-01-01', breakout: '2025-05-08', type: 'Strong conviction' },
  { symbol: 'AFRM', from: '2025-04-20', to: '2025-07-15', preFr: '2025-03-20', breakout: '2025-07-03', type: 'Concentrated bursts' },
  { symbol: 'EOSE', from: '2025-01-21', to: '2025-05-15', preFr: '2024-12-21', breakout: '2025-04-15', type: 'Multi-phase' },
  { symbol: 'STX',  from: '2025-01-22', to: '2025-04-29', preFr: '2024-12-22', breakout: '2025-04-14', type: 'Slow drip' },
  { symbol: 'ALAB', from: '2025-02-25', to: '2025-05-01', preFr: '2025-01-25', breakout: '2025-04-15', type: 'Concentrated' },
  { symbol: 'RKLB', from: '2025-02-25', to: '2025-05-20', preFr: '2025-01-25', breakout: '2025-05-15', type: 'Episodic' },
  { symbol: 'UUUU', from: '2025-10-14', to: '2026-01-29', preFr: '2025-09-14', breakout: '2026-01-02', type: 'Bottoming' },
  { symbol: 'HUT',  from: '2025-02-25', to: '2025-05-15', preFr: '2025-01-25', breakout: '2025-05-08', type: 'Hidden in decline' },
  { symbol: 'SATS', from: '2025-03-03', to: '2025-07-31', preFr: '2025-02-01', breakout: '2025-06-16', type: 'Multi-phase' },
];

async function fetchBars(symbol, mult, ts, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${mult}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${symbol}`);
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
    await new Promise(r => setTimeout(r, 200));
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function mean(arr) { return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function std(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function median(arr) { const s = [...arr].sort((a,b) => a-b); return s.length % 2 === 0 ? (s[s.length/2-1]+s[s.length/2])/2 : s[Math.floor(s.length/2)]; }

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

function scoreSubwindow(dailySlice, preDaily) {
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
  const dm = mean(effectiveDeltas);
  const ds = std(effectiveDeltas);
  const cap = dm + 3 * ds;
  const floor = dm - 3 * ds;
  effectiveDeltas = effectiveDeltas.map(d => Math.max(floor, Math.min(cap, d)));

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
    deltaSlopeNorm, accumWeekRatio, deltaShift,
    weeks: weeks.length, accumWeeks, absorptionPct,
    largeBuyVsSell, volDeclineScore,
    components: { s1, s2, s3, s4, s5, s6, s7 },
    durationMultiplier,
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

/**
 * Compute comprehensive pre-breakout metrics for a single ticker
 */
function computePreBreakoutMetrics(allDaily, breakoutDate) {
  const breakoutIdx = allDaily.findIndex(d => d.date >= breakoutDate);
  const preBreakout = breakoutIdx > 0 ? allDaily.slice(0, breakoutIdx) : allDaily;
  const n = preBreakout.length;
  if (n < 10) return null;

  const avgVol = mean(preBreakout.map(d => d.totalVol));

  // ─── RED DELTA CONTRACTION ───
  const redDays = preBreakout.filter(d => d.delta < 0);
  const greenDays = preBreakout.filter(d => d.delta > 0);
  const redMags = redDays.map(d => Math.abs(d.delta));
  const greenMags = greenDays.map(d => Math.abs(d.delta));

  // Halves comparison
  const halfIdx = Math.floor(n / 2);
  const firstHalf = preBreakout.slice(0, halfIdx);
  const secondHalf = preBreakout.slice(halfIdx);
  const firstRedDays = firstHalf.filter(d => d.delta < 0);
  const secondRedDays = secondHalf.filter(d => d.delta < 0);
  const firstRedMags = firstRedDays.map(d => Math.abs(d.delta));
  const secondRedMags = secondRedDays.map(d => Math.abs(d.delta));
  const firstAvgVol = mean(firstHalf.map(d => d.totalVol));
  const secondAvgVol = mean(secondHalf.map(d => d.totalVol));
  const firstRedNorm = firstAvgVol > 0 && firstRedMags.length > 0 ? mean(firstRedMags) / firstAvgVol * 100 : 0;
  const secondRedNorm = secondAvgVol > 0 && secondRedMags.length > 0 ? mean(secondRedMags) / secondAvgVol * 100 : 0;
  const redNormChange = firstRedNorm > 0 ? ((secondRedNorm - firstRedNorm) / firstRedNorm * 100) : 0;

  // Thirds
  const thirdSize = Math.floor(n / 3);
  const thirds = [preBreakout.slice(0, thirdSize), preBreakout.slice(thirdSize, 2*thirdSize), preBreakout.slice(2*thirdSize)];
  const thirdRedNorms = thirds.map(th => {
    const rd = th.filter(d => d.delta < 0);
    const rm = rd.map(d => Math.abs(d.delta));
    const tv = mean(th.map(d => d.totalVol));
    return tv > 0 && rm.length > 0 ? mean(rm) / tv * 100 : 0;
  });

  // Linear regression of |red delta| over time (normalized)
  let redSlopeNorm = 0;
  let redR2 = 0;
  let redSlopeDir = 'N/A';
  if (redDays.length >= 5) {
    const redYsNorm = redDays.map(d => {
      // Normalize by rolling average volume around that date
      return avgVol > 0 ? Math.abs(d.delta) / avgVol * 100 : 0;
    });
    const redXs = redDays.map((_, i) => i);
    const reg = linReg(redXs, redYsNorm);
    redSlopeNorm = mean(redYsNorm) > 0 ? reg.slope / mean(redYsNorm) * 100 : 0;
    redR2 = reg.r2;
    redSlopeDir = reg.slope < 0 ? 'CONTRACT' : 'EXPAND';
  }

  // Last 10 days vs overall RED comparison
  const last10 = preBreakout.slice(-10);
  const last10Red = last10.filter(d => d.delta < 0);
  const last10RedAvg = last10Red.length > 0 ? mean(last10Red.map(d => Math.abs(d.delta))) : 0;
  const overallRedAvg = redMags.length > 0 ? mean(redMags) : 0;
  const last10AvgVol = mean(last10.map(d => d.totalVol));
  const last10RedNorm = last10AvgVol > 0 && last10RedAvg > 0 ? last10RedAvg / last10AvgVol * 100 : 0;
  const overallRedNorm = avgVol > 0 && overallRedAvg > 0 ? overallRedAvg / avgVol * 100 : 0;
  const last10VsOverall = overallRedAvg > 0 ? ((last10RedAvg - overallRedAvg) / overallRedAvg * 100) : 0;

  // ─── RED DELTA STD CONTRACTION (volatility of RED deltas) ───
  const firstRedStd = firstRedMags.length > 1 ? std(firstRedMags) : 0;
  const secondRedStd = secondRedMags.length > 1 ? std(secondRedMags) : 0;
  const firstRedStdNorm = firstAvgVol > 0 ? firstRedStd / firstAvgVol * 100 : 0;
  const secondRedStdNorm = secondAvgVol > 0 ? secondRedStd / secondAvgVol * 100 : 0;

  // ─── GREEN vs RED ratio evolution ───
  const firstGreenDays = firstHalf.filter(d => d.delta > 0);
  const secondGreenDays = secondHalf.filter(d => d.delta > 0);
  const firstGreenRatio = firstHalf.length > 0 ? firstGreenDays.length / firstHalf.length : 0;
  const secondGreenRatio = secondHalf.length > 0 ? secondGreenDays.length / secondHalf.length : 0;

  // ─── DELTA RANGE CONTRACTION ───
  // Range of daily deltas (max - min) in each third, normalized
  const thirdDeltaRanges = thirds.map(th => {
    const deltas = th.map(d => d.deltaPct);
    return deltas.length > 1 ? Math.max(...deltas) - Math.min(...deltas) : 0;
  });

  // ─── CONSECUTIVE RED DAYS ANALYSIS ───
  // Max consecutive red days in each half
  function maxConsecutiveRed(daily) {
    let max = 0, cur = 0;
    for (const d of daily) {
      if (d.delta < 0) { cur++; max = Math.max(max, cur); }
      else cur = 0;
    }
    return max;
  }
  const firstMaxConsecRed = maxConsecutiveRed(firstHalf);
  const secondMaxConsecRed = maxConsecutiveRed(secondHalf);

  // ─── ABSORPTION RATE EVOLUTION ───
  function absorptionRate(daily) {
    let abs = 0;
    for (let i = 1; i < daily.length; i++) {
      if (daily[i].close < daily[i-1].close && daily[i].delta > 0) abs++;
    }
    return daily.length > 1 ? abs / (daily.length - 1) * 100 : 0;
  }
  const firstAbsorption = absorptionRate(firstHalf);
  const secondAbsorption = absorptionRate(secondHalf);

  // ─── PRICE VOLATILITY CONTRACTION (for comparison with delta vol) ───
  const firstPriceRanges = firstHalf.map(d => d.rangePct);
  const secondPriceRanges = secondHalf.map(d => d.rangePct);
  const firstAvgPriceRange = mean(firstPriceRanges);
  const secondAvgPriceRange = mean(secondPriceRanges);
  const priceRangeChange = firstAvgPriceRange > 0 ? ((secondAvgPriceRange - firstAvgPriceRange) / firstAvgPriceRange * 100) : 0;

  // ─── DELTA VOLATILITY (std of daily deltaPct) ───
  const firstDeltaPcts = firstHalf.map(d => d.deltaPct);
  const secondDeltaPcts = secondHalf.map(d => d.deltaPct);
  const firstDeltaVolatility = std(firstDeltaPcts);
  const secondDeltaVolatility = std(secondDeltaPcts);
  const deltaVolChange = firstDeltaVolatility > 0 ? ((secondDeltaVolatility - firstDeltaVolatility) / firstDeltaVolatility * 100) : 0;

  // ─── VOLUME DECLINE last 5 vs first 5 ───
  const first5Vol = mean(preBreakout.slice(0, 5).map(d => d.totalVol));
  const last5Vol = mean(preBreakout.slice(-5).map(d => d.totalVol));
  const volChangeFirstLast = first5Vol > 0 ? ((last5Vol - first5Vol) / first5Vol * 100) : 0;

  return {
    totalDays: n,
    redDayCount: redDays.length,
    greenDayCount: greenDays.length,
    redPct: redDays.length / n * 100,
    // RED delta contraction
    firstRedNorm, secondRedNorm, redNormChange,
    thirdRedNorms,
    redSlopeNorm, redR2, redSlopeDir,
    last10RedCount: last10Red.length,
    last10RedNorm, overallRedNorm,
    last10VsOverall,
    // RED std contraction
    firstRedStdNorm, secondRedStdNorm,
    // Green ratio evolution
    firstGreenRatio, secondGreenRatio,
    // Delta range contraction
    thirdDeltaRanges,
    // Consecutive red
    firstMaxConsecRed, secondMaxConsecRed,
    // Absorption evolution
    firstAbsorption, secondAbsorption,
    // Price volatility
    firstAvgPriceRange, secondAvgPriceRange, priceRangeChange,
    // Delta volatility
    firstDeltaVolatility, secondDeltaVolatility, deltaVolChange,
    // Volume change
    volChangeFirstLast,
  };
}

(async () => {
  console.log('=== VDF CROSS-TICKER ANALYSIS ===\n');
  console.log('Analyzing RED delta volatility contraction + pre-breakout metrics\n');

  const results = [];

  for (const t of TICKERS) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  Fetching ${t.symbol} (${t.from} → ${t.to})`);
    console.log('─'.repeat(60));

    try {
      const allBars = await fetch1mChunked(t.symbol, t.from, t.to);
      const preBars = await fetch1mChunked(t.symbol, t.preFr, t.from);

      if (allBars.length === 0) {
        console.log(`  ⚠ No data for ${t.symbol}, skipping`);
        continue;
      }

      const allDaily = buildDaily(allBars);
      const preDaily = buildDaily(preBars);

      // Find best zone
      const zones = findAccumulationZones(allDaily, preDaily);
      const bestZone = zones.length > 0 ? zones[0] : null;

      // Pre-breakout metrics
      const metrics = computePreBreakoutMetrics(allDaily, t.breakout);

      if (!metrics) {
        console.log(`  ⚠ Insufficient data for ${t.symbol}, skipping`);
        continue;
      }

      results.push({
        symbol: t.symbol,
        type: t.type,
        breakout: t.breakout,
        bestScore: bestZone ? bestZone.score : 0,
        bestZone: bestZone ? `${bestZone.startDate}→${bestZone.endDate}` : 'none',
        bestWinSize: bestZone ? bestZone.winSize : 0,
        zoneCount: zones.length,
        ...metrics,
      });

      console.log(`  ✓ ${t.symbol}: ${zones.length} zones, best=${bestZone ? bestZone.score.toFixed(4) : 'N/A'}, breakout=${t.breakout}`);
      console.log(`    RED contraction: ${metrics.redSlopeDir} (slope=${metrics.redSlopeNorm.toFixed(2)}%, R²=${metrics.redR2.toFixed(3)})`);
      console.log(`    RED norm 1st→2nd half: ${metrics.firstRedNorm.toFixed(1)}%→${metrics.secondRedNorm.toFixed(1)}% (${metrics.redNormChange > 0 ? '+' : ''}${metrics.redNormChange.toFixed(0)}%)`);
      console.log(`    Delta vol 1st→2nd half: ${metrics.firstDeltaVolatility.toFixed(1)}→${metrics.secondDeltaVolatility.toFixed(1)} (${metrics.deltaVolChange > 0 ? '+' : ''}${metrics.deltaVolChange.toFixed(0)}%)`);

    } catch (err) {
      console.error(`  ✗ ${t.symbol} error: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════
  // COMPREHENSIVE COMPARISON TABLES
  // ═══════════════════════════════════════════════════

  console.log(`\n\n${'═'.repeat(100)}`);
  console.log('  CROSS-TICKER COMPARISON TABLES');
  console.log('═'.repeat(100));

  // Sort by best score descending
  results.sort((a, b) => b.bestScore - a.bestScore);

  // Table 1: Zone scores + type
  console.log(`\n  TABLE 1: ACCUMULATION ZONES`);
  console.log(`  ${'─'.repeat(90)}`);
  console.log(`  ${'Ticker'.padEnd(7)} ${'Score'.padStart(6)} ${'Zones'.padStart(5)} ${'WinSize'.padStart(7)} ${'Best Window'.padEnd(25)} ${'Type'.padEnd(20)}`);
  console.log(`  ${'─'.repeat(90)}`);
  for (const r of results) {
    console.log(`  ${r.symbol.padEnd(7)} ${r.bestScore.toFixed(4).padStart(6)} ${r.zoneCount.toString().padStart(5)} ${(r.bestWinSize+'d').padStart(7)} ${r.bestZone.padEnd(25)} ${r.type.padEnd(20)}`);
  }

  // Table 2: RED delta contraction
  console.log(`\n  TABLE 2: RED DELTA VOLATILITY CONTRACTION (1st half → 2nd half, volume-normalized)`);
  console.log(`  ${'─'.repeat(100)}`);
  console.log(`  ${'Ticker'.padEnd(7)} ${'1stNorm'.padStart(7)} ${'2ndNorm'.padStart(7)} ${'Change'.padStart(7)} ${'Direction'.padEnd(10)} ${'Slope%'.padStart(7)} ${'R²'.padStart(6)} ${'Last10vs'.padStart(8)} ${'E→M→L (thirds)'.padEnd(22)}`);
  console.log(`  ${'─'.repeat(100)}`);
  for (const r of results) {
    const thirdsStr = r.thirdRedNorms.map(v => v.toFixed(1)).join('→');
    console.log(`  ${r.symbol.padEnd(7)} ${(r.firstRedNorm.toFixed(1)+'%').padStart(7)} ${(r.secondRedNorm.toFixed(1)+'%').padStart(7)} ${(r.redNormChange > 0 ? '+' : '')+r.redNormChange.toFixed(0)+'%'.padStart(0)} ${r.redSlopeDir.padEnd(10)} ${r.redSlopeNorm.toFixed(2).padStart(7)} ${r.redR2.toFixed(3).padStart(6)} ${(r.last10VsOverall > 0 ? '+' : '')+r.last10VsOverall.toFixed(0)+'%'} ${thirdsStr}`);
  }

  // Table 3: Delta volatility contraction (std of deltaPct)
  console.log(`\n  TABLE 3: DELTA VOLATILITY CONTRACTION (std of daily delta%, 1st → 2nd half)`);
  console.log(`  ${'─'.repeat(80)}`);
  console.log(`  ${'Ticker'.padEnd(7)} ${'1stStd'.padStart(7)} ${'2ndStd'.padStart(7)} ${'Change'.padStart(7)} ${'Delta Rng: E→M→L'.padEnd(25)} ${'PriceRange'.padStart(10)}`);
  console.log(`  ${'─'.repeat(80)}`);
  for (const r of results) {
    const drStr = r.thirdDeltaRanges.map(v => v.toFixed(1)).join('→');
    console.log(`  ${r.symbol.padEnd(7)} ${r.firstDeltaVolatility.toFixed(1).padStart(7)} ${r.secondDeltaVolatility.toFixed(1).padStart(7)} ${((r.deltaVolChange > 0 ? '+' : '')+r.deltaVolChange.toFixed(0)+'%').padStart(7)} ${drStr.padEnd(25)} ${((r.priceRangeChange > 0 ? '+' : '')+r.priceRangeChange.toFixed(0)+'%').padStart(10)}`);
  }

  // Table 4: Absorption evolution + green ratio
  console.log(`\n  TABLE 4: ABSORPTION & GREEN/RED EVOLUTION (1st → 2nd half)`);
  console.log(`  ${'─'.repeat(80)}`);
  console.log(`  ${'Ticker'.padEnd(7)} ${'1stAbsrp'.padStart(8)} ${'2ndAbsrp'.padStart(8)} ${'1stGreen'.padStart(8)} ${'2ndGreen'.padStart(8)} ${'MaxConsecRed 1→2'.padEnd(20)} ${'Red%'.padStart(5)}`);
  console.log(`  ${'─'.repeat(80)}`);
  for (const r of results) {
    console.log(`  ${r.symbol.padEnd(7)} ${(r.firstAbsorption.toFixed(0)+'%').padStart(8)} ${(r.secondAbsorption.toFixed(0)+'%').padStart(8)} ${(r.firstGreenRatio*100).toFixed(0).padStart(7)+'%'} ${(r.secondGreenRatio*100).toFixed(0).padStart(7)+'%'} ${(r.firstMaxConsecRed+'→'+r.secondMaxConsecRed).padEnd(20)} ${r.redPct.toFixed(0).padStart(4)+'%'}`);
  }

  // Table 5: Volume dynamics
  console.log(`\n  TABLE 5: VOLUME DYNAMICS`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  ${'Ticker'.padEnd(7)} ${'Vol1st5d→Last5d'.padStart(15)} ${'Red Std 1→2 (norm)'.padEnd(22)}`);
  console.log(`  ${'─'.repeat(60)}`);
  for (const r of results) {
    console.log(`  ${r.symbol.padEnd(7)} ${((r.volChangeFirstLast > 0 ? '+' : '')+r.volChangeFirstLast.toFixed(0)+'%').padStart(15)} ${r.firstRedStdNorm.toFixed(1)+'%→'+r.secondRedStdNorm.toFixed(1)+'%'}`);
  }

  // ═══════════════════════════════════════════════════
  // SUMMARY ANALYSIS
  // ═══════════════════════════════════════════════════

  console.log(`\n\n${'═'.repeat(100)}`);
  console.log('  STATISTICAL SUMMARY');
  console.log('═'.repeat(100));

  // RED contraction stats
  const contracting = results.filter(r => r.redSlopeDir === 'CONTRACT');
  const expanding = results.filter(r => r.redSlopeDir === 'EXPAND');
  console.log(`\n  RED delta slope direction:`);
  console.log(`    Contracting: ${contracting.length}/${results.length} (${contracting.map(r => r.symbol).join(', ')})`);
  console.log(`    Expanding:   ${expanding.length}/${results.length} (${expanding.map(r => r.symbol).join(', ')})`);

  const redNormChanges = results.map(r => r.redNormChange);
  console.log(`\n  RED norm change (1st→2nd half):`);
  console.log(`    Mean: ${mean(redNormChanges).toFixed(1)}%`);
  console.log(`    Median: ${median(redNormChanges).toFixed(1)}%`);
  console.log(`    Range: ${Math.min(...redNormChanges).toFixed(0)}% to ${Math.max(...redNormChanges).toFixed(0)}%`);

  // Delta vol contraction stats
  const deltaVolChanges = results.map(r => r.deltaVolChange);
  const dVolContracting = results.filter(r => r.deltaVolChange < 0);
  const dVolExpanding = results.filter(r => r.deltaVolChange >= 0);
  console.log(`\n  Delta volatility (std of deltaPct) change:`);
  console.log(`    Contracting: ${dVolContracting.length}/${results.length} (${dVolContracting.map(r => r.symbol).join(', ')})`);
  console.log(`    Expanding:   ${dVolExpanding.length}/${results.length} (${dVolExpanding.map(r => r.symbol).join(', ')})`);
  console.log(`    Mean: ${mean(deltaVolChanges).toFixed(1)}%`);
  console.log(`    Median: ${median(deltaVolChanges).toFixed(1)}%`);

  // Price volatility comparison
  const priceVolChanges = results.map(r => r.priceRangeChange);
  const pVolContracting = results.filter(r => r.priceRangeChange < 0);
  console.log(`\n  Price range (volatility) change:`);
  console.log(`    Contracting: ${pVolContracting.length}/${results.length} (${pVolContracting.map(r => r.symbol).join(', ')})`);
  console.log(`    Mean: ${mean(priceVolChanges).toFixed(1)}%`);

  // Absorption evolution
  const absIncreasing = results.filter(r => r.secondAbsorption > r.firstAbsorption);
  console.log(`\n  Absorption rate increasing in 2nd half:`);
  console.log(`    Yes: ${absIncreasing.length}/${results.length} (${absIncreasing.map(r => r.symbol).join(', ')})`);
  console.log(`    Avg 1st half: ${mean(results.map(r => r.firstAbsorption)).toFixed(1)}%`);
  console.log(`    Avg 2nd half: ${mean(results.map(r => r.secondAbsorption)).toFixed(1)}%`);

  // Green ratio evolution
  const greenIncreasing = results.filter(r => r.secondGreenRatio > r.firstGreenRatio);
  console.log(`\n  Green day ratio increasing in 2nd half:`);
  console.log(`    Yes: ${greenIncreasing.length}/${results.length} (${greenIncreasing.map(r => r.symbol).join(', ')})`);
  console.log(`    Avg 1st: ${(mean(results.map(r => r.firstGreenRatio))*100).toFixed(0)}%  Avg 2nd: ${(mean(results.map(r => r.secondGreenRatio))*100).toFixed(0)}%`);

  // Correlation: RED contraction vs score
  console.log(`\n  Correlation: RED norm change vs best score:`);
  const scores = results.map(r => r.bestScore);
  const redChanges = results.map(r => r.redNormChange);
  const corrReg = linReg(redChanges, scores);
  console.log(`    Slope: ${corrReg.slope.toFixed(4)}, R²: ${corrReg.r2.toFixed(4)}`);
  console.log(`    ${corrReg.r2 < 0.1 ? 'WEAK/NO correlation — RED contraction not predictive of score' : corrReg.r2 < 0.3 ? 'MODERATE correlation' : 'STRONG correlation'}`);

  console.log(`\n  Correlation: Delta vol change vs best score:`);
  const corrReg2 = linReg(deltaVolChanges, scores);
  console.log(`    Slope: ${corrReg2.slope.toFixed(4)}, R²: ${corrReg2.r2.toFixed(4)}`);
  console.log(`    ${corrReg2.r2 < 0.1 ? 'WEAK/NO correlation — Delta vol contraction not predictive of score' : corrReg2.r2 < 0.3 ? 'MODERATE correlation' : 'STRONG correlation'}`);

  console.log('\n\nDone.');
})().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

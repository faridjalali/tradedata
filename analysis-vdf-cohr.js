/**
 * VDF Deep Analysis — COHR (Coherent Corp)
 * Full period: 10/11/24 - 2/9/26
 * Purpose: Full lifecycle analysis — accumulation entry, breakout detection, distribution exit
 * Long period (~16 months) — discover breakout(s) from data, no assumed date
 * Optimize for long-term swing position trading
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
  const dm = mean(effectiveDeltas); const ds = std(effectiveDeltas);
  const cap = dm + 3 * ds; const floor = dm - 3 * ds;
  let cappedDays = [];
  effectiveDeltas = effectiveDeltas.map((d, i) => {
    if (d > cap || d < floor) { cappedDays.push({ date: dailySlice[i].date, original: d, capped: Math.max(floor, Math.min(cap, d)) }); return Math.max(floor, Math.min(cap, d)); }
    return d;
  });
  const netDelta = effectiveDeltas.reduce((s, v) => s + v, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
  if (netDeltaPct < -1.5) return { score: 0, reason: 'concordant', netDeltaPct, overallPriceChange };
  const weeklyDeltas = []; let dayIdx = 0;
  for (const w of weeks) { let wd = 0; for (let j = 0; j < w.nDays && dayIdx < effectiveDeltas.length; j++, dayIdx++) wd += effectiveDeltas[dayIdx]; weeklyDeltas.push(wd); }
  const cumWeeklyDelta = []; let cwd = 0;
  for (const wd of weeklyDeltas) { cwd += wd; cumWeeklyDelta.push(cwd); }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (linReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;
  if (deltaSlopeNorm < -0.5) return { score: 0, reason: 'slope_gate', netDeltaPct, overallPriceChange, deltaSlopeNorm };
  const consolAvgDailyDelta = netDelta / n;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;
  let absorptionDays = 0;
  for (let i = 1; i < n; i++) { if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > 0) absorptionDays++; }
  const absorptionPct = n > 1 ? (absorptionDays / (n - 1)) * 100 : 0;
  const largeBuyDays = dailySlice.filter(d => d.delta > avgDailyVol * 0.10).length;
  const largeSellDays = dailySlice.filter(d => d.delta < -avgDailyVol * 0.10).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / n) * 100;
  const cumDeltas = []; let cd = 0;
  for (const ed of effectiveDeltas) { cd += ed; cumDeltas.push(cd); }
  const meanP = mean(closes); const meanD = mean(cumDeltas);
  let cov = 0, varP = 0, varD = 0;
  for (let i = 0; i < n; i++) { cov += (closes[i] - meanP) * (cumDeltas[i] - meanD); varP += (closes[i] - meanP) ** 2; varD += (cumDeltas[i] - meanD) ** 2; }
  const priceDeltaCorr = (varP > 0 && varD > 0) ? cov / Math.sqrt(varP * varD) : 0;
  const accumWeeks = weeklyDeltas.filter(wd => wd > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;
  const third = Math.floor(n / 3);
  const t1Vols = dailySlice.slice(0, third).map(d => d.totalVol);
  const t3Vols = dailySlice.slice(2 * third).map(d => d.totalVol);
  const volDeclineScore = (mean(t1Vols) > 0 && mean(t3Vols) < mean(t1Vols)) ? Math.min(1, (mean(t1Vols) - mean(t3Vols)) / mean(t1Vols) / 0.3) : 0;
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

function findAccumulationZones(allDaily, preDaily, maxZones = 3) {
  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  const detected = [];
  for (const winSize of windowSizes) {
    if (allDaily.length < winSize) continue;
    for (let start = 0; start <= allDaily.length - winSize; start++) {
      const slice = allDaily.slice(start, start + winSize);
      const result = scoreSubwindow(slice, preDaily);
      if (result && result.detected) {
        detected.push({ start, end: start + winSize - 1, winSize, startDate: slice[0].date, endDate: slice[slice.length - 1].date, ...result });
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
      if (overlapDays / thisSize > 0.30 || gap < 10) { overlaps = true; break; }
    }
    if (!overlaps && zones.length < maxZones) zones.push(w);
  }
  return zones;
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE ANALYSIS: 1-month rolling window to track institutional flow over time
// ────────────────────────────────────────────────────────────────────────────
function analyzeMonthlyPhases(allDaily) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('  MONTHLY PHASE ANALYSIS (20-day rolling institutional flow)');
  console.log('='.repeat(80));
  console.log(`  ${'Month'.padEnd(22)} ${'PriceChg'.padStart(9)} ${'NetDelta%'.padStart(10)} ${'CumDelta'.padStart(10)} ${'AbsorbPct'.padStart(10)} ${'AvgVol'.padStart(8)} ${'Signal'.padStart(12)}`);
  console.log(`  ${'─'.repeat(78)}`);

  for (let i = 20; i < allDaily.length; i += 20) {
    const end = Math.min(i, allDaily.length);
    const start = Math.max(0, end - 20);
    const chunk = allDaily.slice(start, end);
    if (chunk.length < 10) continue;

    const priceChg = ((chunk[chunk.length-1].close - chunk[0].close) / chunk[0].close) * 100;
    const totalVol = chunk.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = chunk.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

    let absorb = 0;
    for (let j = 1; j < chunk.length; j++) {
      if (chunk[j].close < chunk[j-1].close && chunk[j].delta > 0) absorb++;
    }
    const absorbPct = chunk.length > 1 ? (absorb / (chunk.length - 1)) * 100 : 0;
    const avgVol = totalVol / chunk.length;

    // Classify signal
    let signal = '';
    if (priceChg < -3 && netDeltaPct > 3) signal = '★ ACCUM';
    else if (priceChg > 3 && netDeltaPct < -3) signal = '⚠ DISTRIB';
    else if (priceChg < -3 && netDeltaPct < -3) signal = '↓ concordant';
    else if (priceChg > 3 && netDeltaPct > 3) signal = '↑ confirmed';
    else if (absorbPct > 30) signal = '◆ absorbing';
    else signal = '— neutral';

    console.log(`  ${chunk[0].date}→${chunk[chunk.length-1].date} ${(priceChg >= 0 ? '+' : '') + priceChg.toFixed(1) + '%'} ${(netDeltaPct >= 0 ? '+' : '') + netDeltaPct.toFixed(1) + '%'}  ${(netDelta/1000 >= 0 ? '+' : '') + (netDelta/1000).toFixed(0) + 'K'}  ${absorbPct.toFixed(0) + '%'}  ${(avgVol/1e6).toFixed(1) + 'M'}  ${signal}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DISTRIBUTION ZONE SCANNER: Inverse of accumulation
// ────────────────────────────────────────────────────────────────────────────
function findDistributionWindows(allDaily) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('  DISTRIBUTION ZONE DETECTION');
  console.log('='.repeat(80));

  // 10-day rolling windows: price UP but delta NEGATIVE
  const distWindows = [];
  for (let i = 10; i < allDaily.length; i++) {
    const window = allDaily.slice(i - 10, i);
    const priceChange = ((window[9].close - window[0].close) / window[0].close) * 100;
    const totalVol = window.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = window.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    if (priceChange > 3 && netDeltaPct < -3) {
      distWindows.push({ start: i - 10, end: i - 1, startDate: window[0].date, endDate: window[9].date, priceChange, netDeltaPct, netDelta });
    }
  }

  // Cluster overlapping distribution windows
  const clusters = [];
  for (const w of distWindows) {
    let merged = false;
    for (const c of clusters) {
      if (w.start <= c.end + 5) { // within 5 days
        c.end = Math.max(c.end, w.end);
        c.endDate = allDaily[c.end].date;
        c.count++;
        c.maxPriceChg = Math.max(c.maxPriceChg, w.priceChange);
        c.minDeltaPct = Math.min(c.minDeltaPct, w.netDeltaPct);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ start: w.start, end: w.end, startDate: w.startDate, endDate: w.endDate, count: 1, maxPriceChg: w.priceChange, minDeltaPct: w.netDeltaPct });
    }
  }

  if (clusters.length > 0) {
    console.log(`\n  Found ${clusters.length} distribution cluster(s):`);
    for (const c of clusters) {
      const span = c.end - c.start + 1;
      const chunk = allDaily.slice(c.start, c.end + 1);
      const fullPriceChg = ((chunk[chunk.length-1].close - chunk[0].close) / chunk[0].close) * 100;
      const fullDelta = chunk.reduce((s, d) => s + d.delta, 0);
      const fullVol = chunk.reduce((s, d) => s + d.totalVol, 0);
      const fullDeltaPct = fullVol > 0 ? (fullDelta / fullVol) * 100 : 0;
      console.log(`    ${c.startDate}→${c.endDate} (${span}d): price ${fullPriceChg >= 0 ? '+' : ''}${fullPriceChg.toFixed(1)}%, delta ${fullDeltaPct >= 0 ? '+' : ''}${fullDeltaPct.toFixed(1)}% (${(fullDelta/1000).toFixed(0)}K) — ${c.count} overlapping windows`);
      console.log(`      ⚠ EXIT SIGNAL: Institutions selling into rally`);
    }
  } else {
    console.log('\n  No distribution clusters found.');
  }

  // Also find accumulation-in-decline windows
  console.log(`\n  ACCUMULATION IN DECLINE (10d: price <-3%, delta >+3%):`);
  const accumWindows = [];
  for (let i = 10; i < allDaily.length; i++) {
    const window = allDaily.slice(i - 10, i);
    const priceChange = ((window[9].close - window[0].close) / window[0].close) * 100;
    const totalVol = window.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = window.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    if (priceChange < -3 && netDeltaPct > 3) {
      accumWindows.push({ startDate: window[0].date, endDate: window[9].date, priceChange, netDeltaPct });
    }
  }
  // Cluster
  const accumClusters = [];
  for (const w of accumWindows) {
    const wStart = allDaily.findIndex(d => d.date === w.startDate);
    let merged = false;
    for (const c of accumClusters) {
      if (wStart <= c.endIdx + 5) {
        c.endIdx = Math.max(c.endIdx, wStart + 9);
        c.endDate = allDaily[c.endIdx].date;
        c.count++;
        merged = true; break;
      }
    }
    if (!merged) {
      accumClusters.push({ startDate: w.startDate, endDate: w.endDate, startIdx: wStart, endIdx: wStart + 9, count: 1 });
    }
  }
  if (accumClusters.length > 0) {
    for (const c of accumClusters) {
      const span = c.endIdx - c.startIdx + 1;
      const chunk = allDaily.slice(c.startIdx, c.endIdx + 1);
      const fullPriceChg = ((chunk[chunk.length-1].close - chunk[0].close) / chunk[0].close) * 100;
      const fullDelta = chunk.reduce((s, d) => s + d.delta, 0);
      const fullVol = chunk.reduce((s, d) => s + d.totalVol, 0);
      const fullDeltaPct = fullVol > 0 ? (fullDelta / fullVol) * 100 : 0;
      console.log(`    ${c.startDate}→${c.endDate} (${span}d): price ${fullPriceChg.toFixed(1)}%, delta +${fullDeltaPct.toFixed(1)}% — ★ ENTRY SIGNAL`);
    }
  } else {
    console.log('    None found.');
  }

  return { distClusters: clusters, accumClusters };
}

// ────────────────────────────────────────────────────────────────────────────
// BREAKOUT DETECTION: Find significant price moves after accumulation
// ────────────────────────────────────────────────────────────────────────────
function detectBreakouts(allDaily) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('  BREAKOUT DETECTION (price >8% in 5 days on volume)');
  console.log('='.repeat(80));

  const breakouts = [];
  for (let i = 5; i < allDaily.length; i++) {
    const window = allDaily.slice(i - 5, i);
    const priceChange = ((window[4].close - window[0].close) / window[0].close) * 100;
    const avgVol = mean(allDaily.slice(Math.max(0, i - 25), i - 5).map(d => d.totalVol));
    const windowVol = mean(window.map(d => d.totalVol));
    const volRatio = avgVol > 0 ? windowVol / avgVol : 1;

    if (priceChange > 8 && volRatio > 1.2) {
      // Check if this is near another already-found breakout
      const tooClose = breakouts.some(b => Math.abs(b.idx - i) < 15);
      if (!tooClose) {
        breakouts.push({
          idx: i, date: window[4].date, startDate: window[0].date,
          priceChange, volRatio,
          priceAtBreakout: window[4].close, priceAtStart: window[0].close
        });
      }
    }
  }

  for (const b of breakouts) {
    console.log(`\n  ${b.startDate}→${b.date}: +${b.priceChange.toFixed(1)}% ($${b.priceAtStart.toFixed(2)}→$${b.priceAtBreakout.toFixed(2)}), vol=${b.volRatio.toFixed(1)}x avg`);

    // Check delta polarity during breakout
    const bWindow = allDaily.slice(b.idx - 5, b.idx);
    const netDelta = bWindow.reduce((s, d) => s + d.delta, 0);
    const totalVol = bWindow.reduce((s, d) => s + d.totalVol, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    console.log(`    Breakout delta: ${netDeltaPct >= 0 ? '+' : ''}${netDeltaPct.toFixed(1)}% (${netDelta >= 0 ? '+' : ''}${(netDelta/1000).toFixed(0)}K) — ${netDeltaPct > 2 ? '✓ confirmed by delta' : netDeltaPct < -2 ? '⚠ distribution into rally' : '— neutral delta'}`);

    // Post-breakout 4-week delta check
    const postStart = b.idx;
    const postEnd = Math.min(b.idx + 20, allDaily.length);
    if (postEnd - postStart >= 10) {
      const postWeeks = buildWeeks(allDaily.slice(postStart, postEnd));
      const posWeeks = postWeeks.filter(w => w.delta > 0).length;
      console.log(`    Post-breakout (4wk): ${posWeeks}/${postWeeks.length} positive delta weeks → ${posWeeks >= 3 ? 'DURABLE' : posWeeks <= 1 ? 'FRAGILE' : 'MIXED'}`);
    }
  }

  return breakouts;
}

// ────────────────────────────────────────────────────────────────────────────
// PROXIMITY SIGNALS: Check before each breakout
// ────────────────────────────────────────────────────────────────────────────
function analyzeProximityBeforeBreakout(allDaily, breakoutIdx) {
  if (breakoutIdx < 25) return;
  const pre = allDaily.slice(0, breakoutIdx);
  const n = pre.length;
  const avgVol = mean(pre.map(d => d.totalVol));
  const breakoutDate = allDaily[breakoutIdx].date;

  console.log(`\n    PROXIMITY SIGNALS before ${breakoutDate}:`);
  let points = 0;
  const signals = [];

  // Last 25 days before breakout
  const last25 = pre.slice(-25);
  let cumD = 0;
  console.log(`    Last 15 days:`);
  const last15 = pre.slice(-15);
  for (let i = 0; i < last15.length; i++) {
    const d = last15[i];
    const prev = i > 0 ? last15[i-1] : pre[n - 16] || null;
    const priceChg = prev ? ((d.close - prev.close) / prev.close * 100).toFixed(1) : '—';
    const dir = d.delta >= 0 ? '+' : '';
    cumD += d.delta;
    const absorb = (prev && d.close < prev.close && d.delta > 0) ? ' ★ABSORB' : '';
    const daysLeft = last15.length - i;
    console.log(`      [${String(daysLeft).padStart(2)}d] ${d.date}: $${d.close.toFixed(2).padStart(7)} (${priceChg.padStart(6)}%)  ∂=${dir}${(d.delta/1000).toFixed(0).padStart(6)}K  (${d.deltaPct.toFixed(1).padStart(6)}%)${absorb}`);
  }

  // Signal 1: Seller exhaustion (fading red streaks)
  const last40 = pre.slice(-40);
  let streak = 0, streakDeltas = [], lastStreakEnd = '';
  for (let i = 0; i < last40.length; i++) {
    if (last40[i].delta < 0) {
      streak++; streakDeltas.push(last40[i].delta);
    } else {
      if (streak >= 3) {
        const fading = Math.abs(streakDeltas[streakDeltas.length-1]) < Math.abs(streakDeltas[0]);
        if (fading) {
          signals.push(`Seller exhaustion: ${streak} fading red days`);
          points += 15;
        }
      }
      streak = 0; streakDeltas = [];
    }
  }

  // Signal 2: Delta anomaly
  for (let i = 20; i < n; i++) {
    const prev20 = pre.slice(i - 20, i);
    const avg20 = mean(prev20.map(d => Math.abs(d.delta)));
    if (avg20 > 0 && Math.abs(pre[i].delta) > 4 * avg20) {
      const daysLeft = n - i;
      if (daysLeft <= 30) {
        signals.push(`Delta anomaly: ${pre[i].date} (${(Math.abs(pre[i].delta)/avg20).toFixed(1)}x), ${daysLeft}d before`);
        points += 25;
      }
    }
  }

  // Signal 3: Green streak (4+ days in last 20)
  const last20 = pre.slice(-20);
  streak = 0;
  for (let i = 0; i < last20.length; i++) {
    if (last20[i].delta > 0) streak++;
    else {
      if (streak >= 4) { signals.push(`Green streak: ${streak} days`); points += 20; }
      streak = 0;
    }
  }
  if (streak >= 4) { signals.push(`Green streak: ${streak} days`); points += 20; }

  // Signal 4: Absorption cluster (3/5 in last 15)
  const absLast15 = pre.slice(-15);
  let absCount = 0;
  for (let i = 1; i < absLast15.length; i++) {
    if (absLast15[i].close < absLast15[i-1].close && absLast15[i].delta > 0) absCount++;
  }
  if (absCount >= 3) { signals.push(`Absorption cluster: ${absCount} in 15 days`); points += 15; }

  // Signal 5: Final dump (last 2 days)
  const lastDay = pre[n-1];
  if (lastDay.delta < 0 && Math.abs(lastDay.delta) > avgVol * 0.15) {
    signals.push(`Final dump: ${lastDay.date} (${(lastDay.delta/1000).toFixed(0)}K)`);
    points += 10;
  }

  // Signal: Volume collapse
  const vol10 = mean(pre.slice(-10).map(d => d.totalVol));
  const vol30 = mean(pre.slice(-30).map(d => d.totalVol));
  if (vol10 < vol30 * 0.7) {
    signals.push(`Volume collapse: last 10d vol = ${(vol10/vol30*100).toFixed(0)}% of 30d avg`);
  }

  if (signals.length > 0) {
    for (const s of signals) console.log(`      ✓ ${s}`);
    const level = points >= 70 ? 'IMMINENT' : points >= 50 ? 'HIGH' : points >= 30 ? 'ELEVATED' : 'LOW';
    console.log(`      → Composite: ${points} pts (${level})`);
  } else {
    console.log(`      No proximity signals detected`);
  }

  return { points, signals };
}

// ────────────────────────────────────────────────────────────────────────────
// SWING TRADE TIMELINE: The full entry/exit recommendation log
// ────────────────────────────────────────────────────────────────────────────
function buildSwingTimeline(allDaily, zones, breakouts, distClusters) {
  console.log(`\n${'='.repeat(80)}`);
  console.log('  SWING TRADE TIMELINE — ENTRY / HOLD / EXIT SIGNALS');
  console.log('='.repeat(80));

  // Build event list
  const events = [];

  for (const z of zones) {
    events.push({ date: z.startDate, type: 'ACCUM_START', detail: `Zone score ${z.score.toFixed(2)} (${z.winSize}d), net∂=${z.netDeltaPct.toFixed(1)}%, absorb=${z.absorptionPct.toFixed(0)}%`, score: z.score });
    events.push({ date: z.endDate, type: 'ACCUM_END', detail: `Zone complete — ${z.accumWeeks}/${z.weeks} weeks positive`, score: z.score });
  }

  for (const b of breakouts) {
    events.push({ date: b.date, type: 'BREAKOUT', detail: `+${b.priceChange.toFixed(1)}% in 5d, vol=${b.volRatio.toFixed(1)}x`, score: 0 });
  }

  for (const d of distClusters) {
    events.push({ date: d.startDate, type: 'DISTRIB_START', detail: `Price up but delta negative — institutions selling`, score: 0 });
    events.push({ date: d.endDate, type: 'DISTRIB_END', detail: `Distribution cluster ends`, score: 0 });
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  console.log();
  for (const e of events) {
    const icon = e.type.startsWith('ACCUM') ? '🟢' : e.type.startsWith('DISTRIB') ? '🔴' : '🟡';
    const action = e.type === 'ACCUM_START' ? '→ START ACCUMULATING' :
                   e.type === 'ACCUM_END' ? '→ HOLD / ADD ON DIPS' :
                   e.type === 'BREAKOUT' ? '→ BREAKOUT — ride momentum' :
                   e.type === 'DISTRIB_START' ? '→ ⚠ START TAKING PROFITS' :
                   e.type === 'DISTRIB_END' ? '→ Distribution phase over' : '';
    console.log(`  ${e.date}  ${icon} ${e.type.padEnd(14)} ${action}`);
    console.log(`                        ${e.detail}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('=== VDF Deep Analysis — COHR (Coherent Corp) ===\n');
  console.log('Full lifecycle analysis: accumulation → breakout → distribution → exit\n');

  console.log('Fetching full period (10/11/24 → 2/9/26)...');
  const allBars = await fetch1mChunked('COHR', '2024-10-11', '2026-02-09');
  console.log('Fetching pre-context (9/11/24 → 10/11/24)...');
  const preBars = await fetch1mChunked('COHR', '2024-09-11', '2024-10-11');
  console.log(`Total: Full=${allBars.length} bars, Pre=${preBars.length} bars\n`);

  const allDaily = buildDaily(allBars);
  const preDaily = buildDaily(preBars);
  const allWeeks = buildWeeks(allDaily);

  // ── OVERVIEW ──
  console.log('='.repeat(80));
  console.log('  COHR — FULL PERIOD OVERVIEW (10/11/24 → 2/9/26)');
  console.log('='.repeat(80));

  const closes = allDaily.map(d => d.close);
  const minPrice = Math.min(...closes);
  const maxPrice = Math.max(...closes);
  const startPrice = closes[0];
  const endPrice = closes[closes.length - 1];
  const minDate = allDaily[closes.indexOf(minPrice)].date;
  const maxDate = allDaily[closes.indexOf(maxPrice)].date;
  console.log(`\n  Start: $${startPrice.toFixed(2)} (${allDaily[0].date})  End: $${endPrice.toFixed(2)} (${allDaily[allDaily.length-1].date})`);
  console.log(`  Low: $${minPrice.toFixed(2)} (${minDate})  High: $${maxPrice.toFixed(2)} (${maxDate})`);
  console.log(`  Total return: ${((endPrice - startPrice) / startPrice * 100).toFixed(1)}%`);
  console.log(`  Trading days: ${allDaily.length}`);

  // Weekly summary
  console.log('\n  Weekly summary:');
  let cumDelta = 0;
  for (const w of allWeeks) {
    const dir = w.delta >= 0 ? '+' : '';
    const priceDir = w.close >= w.open ? '▲' : '▼';
    cumDelta += w.delta;
    console.log(`    ${w.weekStart}: ${priceDir} $${w.open.toFixed(2).padStart(7)}→$${w.close.toFixed(2).padStart(7)}  ∂=${dir}${w.deltaPct.toFixed(2).padStart(7)}%  (${dir}${(w.delta/1000).toFixed(0).padStart(7)}K)  cum∂=${(cumDelta/1000 >= 0 ? '+' : '') + (cumDelta/1000).toFixed(0).padStart(7)}K  vol=${(w.avgVol/1e6).toFixed(1)}M  [${w.nDays}d]`);
  }

  // ── MONTHLY PHASES ──
  analyzeMonthlyPhases(allDaily);

  // ── BREAKOUT DETECTION ──
  const breakouts = detectBreakouts(allDaily);

  // ── DISTRIBUTION DETECTION ──
  const { distClusters, accumClusters } = findDistributionWindows(allDaily);

  // ── ACCUMULATION ZONE SCANNING ──
  // Scan the full period — we want to find ALL accumulation zones, not just pre-breakout
  console.log(`\n${'='.repeat(80)}`);
  console.log('  COHR — FULL-PERIOD ACCUMULATION ZONE SCANNING');
  console.log('='.repeat(80));

  // Allow up to 5 zones for the full 16-month period
  const zones = findAccumulationZones(allDaily, preDaily, 5);

  if (zones.length > 0) {
    console.log(`\n  Found ${zones.length} accumulation zone(s):\n`);
    for (let zi = 0; zi < zones.length; zi++) {
      const z = zones[zi];
      const c = z.components;
      console.log(`  Zone ${zi + 1}: ${z.startDate} → ${z.endDate} (${z.winSize}d, ${z.weeks}wk)`);
      console.log(`    Score: ${z.score.toFixed(4)}  |  Price: ${z.overallPriceChange.toFixed(1)}%  |  Net∂: ${z.netDeltaPct.toFixed(2)}%  |  Slope: ${z.deltaSlopeNorm.toFixed(2)}  |  Corr: ${z.priceDeltaCorr.toFixed(2)}`);
      console.log(`    AccWk: ${z.accumWeeks}/${z.weeks} (${(z.accumWeekRatio*100).toFixed(0)}%)  |  Absorption: ${z.absorptionPct.toFixed(1)}%  |  BuySell: ${z.largeBuyVsSell.toFixed(1)}  |  VolDecl: ${z.volDeclineScore.toFixed(2)}`);
      console.log(`    Components: s1=${c.s1.toFixed(2)} s2=${c.s2.toFixed(2)} s3=${c.s3.toFixed(2)} s4=${c.s4.toFixed(2)} s5=${c.s5.toFixed(2)} s6=${c.s6.toFixed(2)} s7=${c.s7.toFixed(2)}  durMult=${z.durationMultiplier.toFixed(3)}`);
      if (z.cappedDays?.length > 0) console.log(`    Capped: ${z.cappedDays.map(cd => `${cd.date} (${(cd.original/1000).toFixed(0)}K→${(cd.capped/1000).toFixed(0)}K)`).join(', ')}`);
      console.log(`    Weeks:`);
      for (const w of z.weeksData) {
        const dir = w.effectiveDelta >= 0 ? '+' : '';
        const priceDir = w.close >= w.open ? '▲' : '▼';
        console.log(`      ${w.weekStart}: ${priceDir} $${w.close.toFixed(2).padStart(7)}  ${dir}${(w.effectiveDelta/1000).toFixed(0).padStart(6)}K  (${dir}${w.deltaPct.toFixed(2).padStart(7)}%)  [${w.nDays}d]`);
      }
      // Daily detail for top zones only
      if (zi < 3) {
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
      console.log();
    }
  } else {
    console.log('\n  ❌ NO ACCUMULATION ZONES DETECTED');
  }

  // ── PROXIMITY ANALYSIS before each breakout ──
  if (breakouts.length > 0 && zones.length > 0) {
    console.log(`\n${'='.repeat(80)}`);
    console.log('  BREAKOUT PROXIMITY ANALYSIS');
    console.log('='.repeat(80));
    for (const b of breakouts) {
      analyzeProximityBeforeBreakout(allDaily, b.idx);
    }
  }

  // ── DELTA ANOMALY DETECTION (full period) ──
  console.log(`\n${'='.repeat(80)}`);
  console.log('  DELTA ANOMALY DETECTION (full period, |delta| > 4x 20d rolling avg)');
  console.log('='.repeat(80));
  const avgVolFull = mean(allDaily.map(d => d.totalVol));
  for (let i = 20; i < allDaily.length; i++) {
    const prev20 = allDaily.slice(i - 20, i);
    const avg20 = mean(prev20.map(d => Math.abs(d.delta)));
    if (avg20 > 0 && Math.abs(allDaily[i].delta) > 4 * avg20) {
      const d = allDaily[i];
      const dir = d.delta >= 0 ? '+' : '';
      const mult = (Math.abs(d.delta) / avg20).toFixed(1);
      const prevD = allDaily[i-1];
      const absorb = d.delta > 0 && d.close < prevD.close ? ' ★ABSORB' : '';
      console.log(`    ${d.date}: ∂=${dir}${(d.delta/1000).toFixed(0)}K (${mult}x avg)  vol=${(d.totalVol/1e6).toFixed(2)}M  price=$${d.close.toFixed(2)}${absorb}`);
    }
  }

  // ── SELLER EXHAUSTION (full period) ──
  console.log(`\n${'='.repeat(80)}`);
  console.log('  SELLER EXHAUSTION STREAKS (3+ consecutive red, full period)');
  console.log('='.repeat(80));
  let exStreak = 0, exStart = '', exDeltas = [];
  for (let i = 0; i < allDaily.length; i++) {
    if (allDaily[i].delta < 0) {
      if (exStreak === 0) { exStart = allDaily[i].date; exDeltas = []; }
      exStreak++; exDeltas.push(allDaily[i].delta);
    } else {
      if (exStreak >= 3) {
        const fading = Math.abs(exDeltas[exDeltas.length-1]) < Math.abs(exDeltas[0]);
        const intensifying = Math.abs(exDeltas[exDeltas.length-1]) > Math.abs(exDeltas[0]);
        const label = fading ? ' [FADING]' : intensifying ? ' [INTENSIFYING]' : '';
        console.log(`    ${exStart}→${allDaily[i-1].date}: ${exStreak} red days${label}`);
      }
      exStreak = 0;
    }
  }
  if (exStreak >= 3) {
    const fading = Math.abs(exDeltas[exDeltas.length-1]) < Math.abs(exDeltas[0]);
    const label = fading ? ' [FADING]' : ' [INTENSIFYING]';
    console.log(`    ${exStart}→${allDaily[allDaily.length-1].date}: ${exStreak} red days${label}`);
  }

  // ── GREEN STREAKS (full period) ──
  console.log(`\n${'='.repeat(80)}`);
  console.log('  GREEN DELTA STREAKS (4+ consecutive, full period)');
  console.log('='.repeat(80));
  let gStreak = 0, gStart = '';
  for (let i = 0; i < allDaily.length; i++) {
    if (allDaily[i].delta > 0) { if (gStreak === 0) gStart = allDaily[i].date; gStreak++; }
    else {
      if (gStreak >= 4) console.log(`    ${gStart}→${allDaily[i-1].date}: ${gStreak} consecutive green days`);
      gStreak = 0;
    }
  }
  if (gStreak >= 4) console.log(`    ${gStart}→${allDaily[allDaily.length-1].date}: ${gStreak} consecutive green days`);

  // ── SWING TRADE TIMELINE ──
  buildSwingTimeline(allDaily, zones, breakouts, distClusters);

  console.log('\nDone.');
})().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

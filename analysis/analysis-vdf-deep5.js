/**
 * Deep VDF Analysis — 5 Confirmed Positives
 *
 * Analyzes accumulation patterns, pre-breakout characteristics,
 * volatility contraction, outliers, and scoring nuances across
 * all confirmed positive examples.
 *
 * Tickers: RKLB, IREN, HUT, AFRM, ALAB
 */

require('dotenv').config();

const DATA_API_KEY = process.env.DATA_API_KEY;
const BASE = 'https://api.massive.com';

async function fetchBars(symbol, mult, ts, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${mult}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${symbol}`);
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

// ---- Helpers ----

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
      range: day.high - day.low,
      rangePct: day.close > 0 ? ((day.high - day.low) / day.close) * 100 : 0,
      deltaPct: day.totalVol > 0 ? (day.delta / day.totalVol) * 100 : 0,
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
      const closes = days.map((d) => d.close);
      const opens = days.map((d) => d.open);
      return {
        weekStart,
        delta: buyVol - sellVol,
        totalVol,
        deltaPct: totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0,
        nDays: days.length,
        open: opens[0],
        close: closes[closes.length - 1],
        high: Math.max(...days.map((d) => d.high)),
        low: Math.min(...days.map((d) => d.low)),
        avgRange: days.reduce((s, d) => s + d.rangePct, 0) / days.length,
        avgVol: totalVol / days.length,
      };
    });
}

function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0, intercept: 0 };
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
  if (d === 0) return { slope: 0, r2: 0, intercept: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - intercept - slope * xs[i]) ** 2;
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, intercept };
}

function mean(arr) {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ---- Deep Analysis ----

function deepAnalysis(daily, preBars1m, label) {
  const weeks = buildWeeks(daily);
  const preDaily = buildDaily(preBars1m);
  const preWeeks = buildWeeks(preDaily);

  const n = daily.length;
  const closes = daily.map((d) => d.close);
  const totalVol = daily.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / n;
  const netDelta = daily.reduce((s, d) => s + d.delta, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
  const overallPriceChange = ((closes[n - 1] - closes[0]) / closes[0]) * 100;

  // Pre-context baselines
  const preAvgDelta = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.delta, 0) / preDaily.length : 0;
  const preAvgVol = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.totalVol, 0) / preDaily.length : avgDailyVol;
  const preAvgRange = preDaily.length > 0 ? mean(preDaily.map((d) => d.rangePct)) : 0;

  // ---- 1. CUMULATIVE DELTA ANALYSIS ----
  const cumDeltas = [];
  let cd = 0;
  for (const d of daily) {
    cd += d.delta;
    cumDeltas.push(cd);
  }
  const deltaXs = daily.map((_, i) => i);
  const deltaSlopeReg = linReg(deltaXs, cumDeltas);
  const deltaSlopeNorm = avgDailyVol > 0 ? (deltaSlopeReg.slope / avgDailyVol) * 100 : 0;

  // Weekly cum delta slope
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const w of weeks) {
    cwd += w.delta;
    cumWeeklyDelta.push(cwd);
  }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const weeklySlopeNorm = avgWeeklyVol > 0 ? (linReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  // Correlation price vs cum delta
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

  // ---- 2. VOLATILITY CONTRACTION ----
  const ranges = daily.map((d) => d.rangePct);
  const vols = daily.map((d) => d.totalVol);

  // Thirds analysis
  const third = Math.floor(n / 3);
  const t1Ranges = ranges.slice(0, third);
  const t2Ranges = ranges.slice(third, 2 * third);
  const t3Ranges = ranges.slice(2 * third);
  const t1Vols = vols.slice(0, third);
  const t2Vols = vols.slice(third, 2 * third);
  const t3Vols = vols.slice(2 * third);

  const avgT1Range = mean(t1Ranges);
  const avgT2Range = mean(t2Ranges);
  const avgT3Range = mean(t3Ranges);
  const avgT1Vol = mean(t1Vols);
  const avgT2Vol = mean(t2Vols);
  const avgT3Vol = mean(t3Vols);

  const rangeContractionT3vsT1 = avgT1Range > 0 ? ((avgT3Range - avgT1Range) / avgT1Range) * 100 : 0;
  const volContractionT3vsT1 = avgT1Vol > 0 ? ((avgT3Vol - avgT1Vol) / avgT1Vol) * 100 : 0;

  // Range slope (linear regression of daily range % over time)
  const rangeSlopeReg = linReg(deltaXs, ranges);

  // Bollinger Band width (20-period)
  const bbWidths = [];
  for (let i = 19; i < n; i++) {
    const slice = closes.slice(i - 19, i + 1);
    const m = mean(slice);
    const s = std(slice);
    bbWidths.push(m > 0 ? (s / m) * 100 : 0);
  }
  const bbFirst5 = bbWidths.length >= 10 ? mean(bbWidths.slice(0, 5)) : 0;
  const bbLast5 = bbWidths.length >= 10 ? mean(bbWidths.slice(-5)) : 0;
  const bbContraction = bbFirst5 > 0 ? ((bbLast5 - bbFirst5) / bbFirst5) * 100 : 0;

  // ---- 3. LAST 5 AND 10 DAYS BEFORE BREAKOUT ----
  const last5 = daily.slice(-5);
  const last10 = daily.slice(-10);
  const last5Delta = last5.reduce((s, d) => s + d.delta, 0);
  const last5Vol = last5.reduce((s, d) => s + d.totalVol, 0);
  const last5DeltaPct = last5Vol > 0 ? (last5Delta / last5Vol) * 100 : 0;
  const last5AvgRange = mean(last5.map((d) => d.rangePct));
  const last5AvgVol = mean(last5.map((d) => d.totalVol));
  const last10Delta = last10.reduce((s, d) => s + d.delta, 0);
  const last10Vol = last10.reduce((s, d) => s + d.totalVol, 0);
  const last10DeltaPct = last10Vol > 0 ? (last10Delta / last10Vol) * 100 : 0;
  const last10AvgRange = mean(last10.map((d) => d.rangePct));
  const last10AvgVol = mean(last10.map((d) => d.totalVol));

  // First 5/10 for comparison
  const first5AvgRange = mean(daily.slice(0, 5).map((d) => d.rangePct));
  const first5AvgVol = mean(daily.slice(0, 5).map((d) => d.totalVol));
  const first10AvgRange = mean(daily.slice(0, 10).map((d) => d.rangePct));
  const first10AvgVol = mean(daily.slice(0, 10).map((d) => d.totalVol));

  // Volume dryup: last 5 days vol vs overall avg
  const volDryup = avgDailyVol > 0 ? ((last5AvgVol - avgDailyVol) / avgDailyVol) * 100 : 0;

  // Range compression: last 5 days range vs overall avg
  const avgRange = mean(ranges);
  const rangeCompression = avgRange > 0 ? ((last5AvgRange - avgRange) / avgRange) * 100 : 0;

  // ---- 4. OUTLIER ANALYSIS ----
  const dailyDeltas = daily.map((d) => d.delta);
  const deltaMean = mean(dailyDeltas);
  const deltaStd = std(dailyDeltas);
  const cap2sigma = deltaMean + 2 * deltaStd;
  const capNeg2sigma = deltaMean - 2 * deltaStd;
  const cap3sigma = deltaMean + 3 * deltaStd;
  const capNeg3sigma = deltaMean - 3 * deltaStd;

  const outliers2sigma = daily.filter((d) => d.delta > cap2sigma || d.delta < capNeg2sigma);
  const outliers3sigma = daily.filter((d) => d.delta > cap3sigma || d.delta < capNeg3sigma);

  // Volume outliers
  const volMean = mean(vols);
  const volStd = std(vols);
  const volOutliers = daily.filter((d) => d.totalVol > volMean + 2 * volStd);

  // ---- 5. ABSORPTION PATTERN ----
  // Days where price down but delta positive (absorption)
  let absorptionDays = 0;
  let strongAbsorptionDays = 0;
  let distributionDays = 0; // price up but delta negative
  for (let i = 1; i < n; i++) {
    const priceDown = daily[i].close < daily[i - 1].close;
    const priceUp = daily[i].close > daily[i - 1].close;
    if (priceDown && daily[i].delta > 0) absorptionDays++;
    if (priceDown && daily[i].delta > avgDailyVol * 0.05) strongAbsorptionDays++;
    if (priceUp && daily[i].delta < 0) distributionDays++;
  }

  // ---- 6. PRICE STRUCTURE ----
  // How close is the last price to the period high and low?
  const periodHigh = Math.max(...closes);
  const periodLow = Math.min(...closes);
  const priceRange = periodHigh - periodLow;
  const lastClose = closes[n - 1];
  const pricePositionInRange = priceRange > 0 ? ((lastClose - periodLow) / priceRange) * 100 : 50;

  // How many days were spent near the low (bottom 20% of range)?
  const bottom20 = periodLow + priceRange * 0.2;
  const top20 = periodHigh - priceRange * 0.2;
  const daysNearLow = closes.filter((c) => c <= bottom20).length;
  const daysNearHigh = closes.filter((c) => c >= top20).length;

  // ---- 7. DELTA SHIFT vs PRE-CONTEXT ----
  const consolAvgDailyDelta = netDelta / n;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  // Accumulation week ratio
  const accumWeeks = weeks.filter((w) => w.deltaPct > 0).length;

  // ---- 8. SUBWINDOW SCAN ----
  // Find best scoring subwindow
  let bestSubwindow = null;
  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  for (const winSize of windowSizes) {
    if (n < winSize) continue;
    for (let start = 0; start <= n - winSize; start++) {
      const slice = daily.slice(start, start + winSize);
      const result = scoreSubwindow(slice, preDaily);
      if (result && result.score > (bestSubwindow?.score || 0)) {
        bestSubwindow = { ...result, winSize, startDate: slice[0].date, endDate: slice[slice.length - 1].date };
      }
    }
  }

  return {
    label,
    nDays: n,
    nWeeks: weeks.length,
    overallPriceChange,
    netDeltaPct,
    // Delta
    deltaSlopeNorm,
    weeklySlopeNorm,
    priceDeltaCorr,
    deltaShift,
    accumWeeks,
    accumWeekRatio: accumWeeks / weeks.length,
    // Volatility
    avgT1Range,
    avgT2Range,
    avgT3Range,
    rangeContractionT3vsT1,
    rangeSlopeR2: rangeSlopeReg.r2,
    rangeSlopeDir: rangeSlopeReg.slope < 0 ? 'contracting' : 'expanding',
    avgT1Vol,
    avgT2Vol,
    avgT3Vol,
    volContractionT3vsT1,
    bbContraction,
    bbFirst5,
    bbLast5,
    // Pre-breakout
    last5DeltaPct,
    last10DeltaPct,
    last5AvgRange,
    last10AvgRange,
    first5AvgRange,
    first10AvgRange,
    last5AvgVol,
    last10AvgVol,
    first5AvgVol,
    first10AvgVol,
    volDryup,
    rangeCompression,
    // Outliers
    outliers2sigma: outliers2sigma.map((d) => ({
      date: d.date,
      delta: d.delta,
      deltaPct: d.deltaPct,
      vol: d.totalVol,
    })),
    outliers3sigma: outliers3sigma.map((d) => ({
      date: d.date,
      delta: d.delta,
      deltaPct: d.deltaPct,
      vol: d.totalVol,
    })),
    volOutliers: volOutliers.map((d) => ({ date: d.date, vol: d.totalVol, delta: d.delta })),
    // Absorption
    absorptionDays,
    strongAbsorptionDays,
    distributionDays,
    absorptionPct: n > 1 ? (absorptionDays / (n - 1)) * 100 : 0,
    distributionPct: n > 1 ? (distributionDays / (n - 1)) * 100 : 0,
    // Price structure
    pricePositionInRange,
    daysNearLow,
    daysNearHigh,
    periodHigh,
    periodLow,
    lastClose,
    // Best subwindow
    bestSubwindow,
    // Raw data for printing
    daily,
    weeks,
    preDaily,
  };
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

  const netDelta = dailySlice.reduce((s, d) => s + d.delta, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
  if (netDeltaPct < -1.5) return { score: 0, reason: 'concordant', netDeltaPct, overallPriceChange };

  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const w of weeks) {
    cwd += w.delta;
    cumWeeklyDelta.push(cwd);
  }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (linReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  const consolAvgDailyDelta = netDelta / n;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  let strongAbsorptionDays = 0;
  for (let i = 1; i < n; i++) {
    if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > avgDailyVol * 0.05)
      strongAbsorptionDays++;
  }
  const strongAbsorptionPct = n > 1 ? (strongAbsorptionDays / (n - 1)) * 100 : 0;

  const largeBuyDays = dailySlice.filter((d) => d.delta > avgDailyVol * 0.1).length;
  const largeSellDays = dailySlice.filter((d) => d.delta < -avgDailyVol * 0.1).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / n) * 100;

  const cumDeltas = [];
  let cd = 0;
  for (const d of dailySlice) {
    cd += d.delta;
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

  const accumWeeks = weeks.filter((w) => w.deltaPct > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;

  let volContractionScore = 0;
  if (n >= 9) {
    const dThird = Math.floor(n / 3);
    const t1R = dailySlice.slice(0, dThird).map((d) => d.rangePct);
    const t3R = dailySlice.slice(2 * dThird).map((d) => d.rangePct);
    const a1 = mean(t1R),
      a3 = mean(t3R);
    if (a1 > 0) volContractionScore = Math.max(0, Math.min(1, -(a3 - a1) / a1 / 0.4));
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
  const score = rawScore * durationMultiplier;

  return {
    score,
    detected: score >= 0.3,
    netDeltaPct,
    overallPriceChange,
    deltaSlopeNorm,
    priceDeltaCorr,
    accumWeekRatio,
    weeks: weeks.length,
    accumWeeks,
    components: { s1, s2, s3, s4, s5, s6, s7, s8 },
  };
}

// ---- Printing ----

function printDeepAnalysis(r) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${r.label}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  Period: ${r.daily[0].date} → ${r.daily[r.nDays - 1].date} (${r.nDays} days, ${r.nWeeks} weeks)`);
  console.log(
    `  Price: $${r.daily[0].close.toFixed(2)} → $${r.lastClose.toFixed(2)} (${r.overallPriceChange.toFixed(1)}%)`,
  );
  console.log(
    `  Price range: $${r.periodLow.toFixed(2)} – $${r.periodHigh.toFixed(2)}, last close at ${r.pricePositionInRange.toFixed(0)}% of range`,
  );
  console.log(
    `  Days near low (bottom 20%): ${r.daysNearLow}/${r.nDays}   Days near high (top 20%): ${r.daysNearHigh}/${r.nDays}`,
  );

  console.log(`\n  ── VOLUME DELTA ──`);
  console.log(`  Net delta %:       ${r.netDeltaPct.toFixed(2)}%`);
  console.log(`  Delta shift vs pre: ${r.deltaShift.toFixed(2)}`);
  console.log(`  Daily cum ∂ slope:  ${r.deltaSlopeNorm.toFixed(2)}`);
  console.log(`  Weekly cum ∂ slope: ${r.weeklySlopeNorm.toFixed(2)}`);
  console.log(`  Price-∂ correlation: ${r.priceDeltaCorr.toFixed(3)}`);
  console.log(`  Accum weeks:        ${r.accumWeeks}/${r.nWeeks} (${(r.accumWeekRatio * 100).toFixed(0)}%)`);

  console.log(`\n  ── ABSORPTION / DISTRIBUTION ──`);
  console.log(`  Absorption days (price↓, delta>0): ${r.absorptionDays} (${r.absorptionPct.toFixed(1)}%)`);
  console.log(`  Strong absorption (>5% avg vol):   ${r.strongAbsorptionDays}`);
  console.log(`  Distribution days (price↑, delta<0): ${r.distributionDays} (${r.distributionPct.toFixed(1)}%)`);

  console.log(`\n  ── VOLATILITY CONTRACTION ──`);
  console.log(`  Daily range (avg by third):`);
  console.log(`    First third:  ${r.avgT1Range.toFixed(3)}%`);
  console.log(`    Middle third: ${r.avgT2Range.toFixed(3)}%`);
  console.log(`    Last third:   ${r.avgT3Range.toFixed(3)}%`);
  console.log(
    `    Contraction:  ${r.rangeContractionT3vsT1.toFixed(1)}% ${r.rangeContractionT3vsT1 < -15 ? '✅ CONTRACTING' : r.rangeContractionT3vsT1 > 15 ? '⬆ EXPANDING' : '~ FLAT'}`,
  );
  console.log(`    Range slope:  ${r.rangeSlopeDir} (R²=${r.rangeSlopeR2.toFixed(3)})`);
  console.log(`  Volume (avg by third):`);
  console.log(`    First third:  ${(r.avgT1Vol / 1e6).toFixed(2)}M`);
  console.log(`    Middle third: ${(r.avgT2Vol / 1e6).toFixed(2)}M`);
  console.log(`    Last third:   ${(r.avgT3Vol / 1e6).toFixed(2)}M`);
  console.log(
    `    Change:       ${r.volContractionT3vsT1.toFixed(1)}% ${r.volContractionT3vsT1 < -15 ? '✅ DECLINING' : '~ FLAT/RISING'}`,
  );
  console.log(`  Bollinger Band width:`);
  console.log(`    First 5 periods: ${r.bbFirst5.toFixed(3)}%`);
  console.log(`    Last 5 periods:  ${r.bbLast5.toFixed(3)}%`);
  console.log(
    `    Change: ${r.bbContraction.toFixed(1)}% ${r.bbContraction < -15 ? '✅ NARROWING' : r.bbContraction > 15 ? '⬆ WIDENING' : '~ FLAT'}`,
  );

  console.log(`\n  ── PRE-BREAKOUT (last 5 / 10 days vs first 5 / 10) ──`);
  console.log(`  Delta %:  last5=${r.last5DeltaPct.toFixed(2)}%  last10=${r.last10DeltaPct.toFixed(2)}%`);
  console.log(
    `  Range:    first5=${r.first5AvgRange.toFixed(3)}%  last5=${r.last5AvgRange.toFixed(3)}%  (${r.rangeCompression.toFixed(1)}% vs avg)`,
  );
  console.log(
    `  Volume:   first5=${(r.first5AvgVol / 1e6).toFixed(2)}M  last5=${(r.last5AvgVol / 1e6).toFixed(2)}M  (${r.volDryup.toFixed(1)}% vs avg)`,
  );

  console.log(`\n  ── OUTLIERS ──`);
  if (r.outliers3sigma.length > 0) {
    console.log(`  3σ delta outliers:`);
    for (const o of r.outliers3sigma) {
      console.log(
        `    ${o.date}: delta=${(o.delta / 1000).toFixed(0)}K (${o.deltaPct.toFixed(1)}%) vol=${(o.vol / 1e6).toFixed(2)}M`,
      );
    }
  } else {
    console.log(`  No 3σ delta outliers`);
  }
  if (r.outliers2sigma.length > 0) {
    console.log(`  2σ delta outliers (${r.outliers2sigma.length} days):`);
    for (const o of r.outliers2sigma.slice(0, 8)) {
      console.log(
        `    ${o.date}: delta=${(o.delta / 1000).toFixed(0)}K (${o.deltaPct.toFixed(1)}%) vol=${(o.vol / 1e6).toFixed(2)}M`,
      );
    }
    if (r.outliers2sigma.length > 8) console.log(`    ... and ${r.outliers2sigma.length - 8} more`);
  }
  if (r.volOutliers.length > 0) {
    console.log(`  Volume outliers (>2σ): ${r.volOutliers.length} days`);
    for (const o of r.volOutliers.slice(0, 5)) {
      console.log(`    ${o.date}: vol=${(o.vol / 1e6).toFixed(2)}M delta=${(o.delta / 1000).toFixed(0)}K`);
    }
  }

  console.log(`\n  ── WEEKLY BREAKDOWN ──`);
  for (const w of r.weeks) {
    const dir = w.delta >= 0 ? '+' : '';
    const priceDir = w.close >= w.open ? '▲' : '▼';
    console.log(
      `  ${w.weekStart}: ${priceDir} $${w.open.toFixed(2)}→$${w.close.toFixed(2)}  ∂=${dir}${w.deltaPct.toFixed(2)}%  (${dir}${(w.delta / 1000).toFixed(0)}K)  range=${w.avgRange.toFixed(3)}%  vol=${(w.avgVol / 1e6).toFixed(2)}M  [${w.nDays}d]`,
    );
  }

  console.log(`\n  ── LAST 10 DAYS (pre-breakout detail) ──`);
  const last10 = r.daily.slice(-10);
  for (let i = 0; i < last10.length; i++) {
    const d = last10[i];
    const prev = i > 0 ? last10[i - 1] : r.daily.length > 10 ? r.daily[r.daily.length - 11] : null;
    const priceChg = prev ? (((d.close - prev.close) / prev.close) * 100).toFixed(1) : '—';
    const dir = d.delta >= 0 ? '+' : '';
    const absorb = prev && d.close < prev.close && d.delta > 0 ? ' ★ABSORB' : '';
    console.log(
      `  ${d.date}: $${d.close.toFixed(2)} (${priceChg}%)  ∂=${dir}${(d.delta / 1000).toFixed(0)}K (${d.deltaPct.toFixed(1)}%)  range=${d.rangePct.toFixed(3)}%  vol=${(d.totalVol / 1e6).toFixed(2)}M${absorb}`,
    );
  }

  if (r.bestSubwindow) {
    console.log(`\n  ── BEST SUBWINDOW ──`);
    const b = r.bestSubwindow;
    console.log(`  Window: ${b.startDate} → ${b.endDate} (${b.winSize}d, ${b.weeks}wk)`);
    console.log(`  Score: ${b.score.toFixed(4)} ${b.detected ? '✅ DETECTED' : '❌'}`);
    console.log(
      `  Price: ${b.overallPriceChange.toFixed(1)}%  Net∂: ${b.netDeltaPct.toFixed(2)}%  Corr: ${b.priceDeltaCorr.toFixed(2)}  Slope: ${b.deltaSlopeNorm.toFixed(2)}`,
    );
    console.log(`  Accum weeks: ${b.accumWeeks}/${b.weeks}`);
    console.log(
      `  Components: s1=${b.components.s1.toFixed(2)} s2=${b.components.s2.toFixed(2)} s3=${b.components.s3.toFixed(2)} s4=${b.components.s4.toFixed(2)} s5=${b.components.s5.toFixed(2)} s6=${b.components.s6.toFixed(2)} s7=${b.components.s7.toFixed(2)} s8=${b.components.s8.toFixed(2)}`,
    );
  }
}

// ---- Main ----

(async () => {
  const cases = [
    {
      symbol: 'RKLB',
      label: 'RKLB — Accumulation Feb-Apr 2025 (breakout ~Apr 7)',
      consolFrom: '2025-02-26',
      consolTo: '2025-04-07',
      preFrom: '2025-01-27',
      preTo: '2025-02-26',
    },
    {
      symbol: 'IREN',
      label: 'IREN — Accumulation Mar-Apr 2025 (breakout ~Apr 21)',
      consolFrom: '2025-03-13',
      consolTo: '2025-04-21',
      preFrom: '2025-02-11',
      preTo: '2025-03-13',
    },
    {
      symbol: 'HUT',
      label: 'HUT — Accumulation Feb-Apr 2025 (breakout ~Apr 21)',
      consolFrom: '2025-02-24',
      consolTo: '2025-04-21',
      preFrom: '2025-01-25',
      preTo: '2025-02-24',
    },
    {
      symbol: 'AFRM',
      label: 'AFRM — Accumulation Feb-Aug 2024 (breakout ~Aug 6)',
      consolFrom: '2024-02-09',
      consolTo: '2024-08-06',
      preFrom: '2024-01-10',
      preTo: '2024-02-09',
    },
    {
      symbol: 'ALAB',
      label: 'ALAB — Accumulation Feb-Apr 2025 (breakout ~Apr 22)',
      consolFrom: '2025-02-06',
      consolTo: '2025-04-22',
      preFrom: '2025-01-07',
      preTo: '2025-02-06',
    },
  ];

  // Also include TRON as false positive comparison
  cases.push({
    symbol: 'TRON',
    label: 'TRON — FALSE POSITIVE (concordant decline Jan-Feb 2026)',
    consolFrom: '2026-01-03',
    consolTo: '2026-02-14',
    preFrom: '2025-12-04',
    preTo: '2026-01-03',
  });

  const allResults = [];

  for (const c of cases) {
    console.log(`\n${'#'.repeat(80)}`);
    console.log(`  FETCHING ${c.symbol}`);
    console.log(`${'#'.repeat(80)}`);

    const consolBars = await fetch1mChunked(c.symbol, c.consolFrom, c.consolTo);
    const preBars = await fetch1mChunked(c.symbol, c.preFrom, c.preTo);
    console.log(`  Total: Consol=${consolBars.length} bars, Pre=${preBars.length} bars`);

    const daily = buildDaily(consolBars);
    const result = deepAnalysis(daily, preBars, c.label);
    allResults.push({ symbol: c.symbol, ...result });
    printDeepAnalysis(result);
  }

  // ---- Cross-ticker comparison ----
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('  CROSS-TICKER COMPARISON');
  console.log('='.repeat(80));

  console.log('\n  ── Key Metrics ──');
  const hdr =
    '  ' +
    'Ticker'.padEnd(8) +
    'Price∆'.padStart(8) +
    'Net∂%'.padStart(8) +
    'Slope'.padStart(8) +
    'Corr'.padStart(7) +
    'Shift'.padStart(8) +
    'AccWk%'.padStart(8) +
    'Best'.padStart(7) +
    'BestWin'.padStart(22);
  console.log(hdr);
  console.log('  ' + '-'.repeat(hdr.length - 2));
  for (const r of allResults) {
    const bw = r.bestSubwindow;
    console.log(
      '  ' +
        r.symbol.padEnd(8) +
        `${r.overallPriceChange.toFixed(1)}%`.padStart(8) +
        `${r.netDeltaPct.toFixed(2)}%`.padStart(8) +
        `${r.weeklySlopeNorm.toFixed(2)}`.padStart(8) +
        `${r.priceDeltaCorr.toFixed(2)}`.padStart(7) +
        `${r.deltaShift.toFixed(1)}`.padStart(8) +
        `${(r.accumWeekRatio * 100).toFixed(0)}%`.padStart(8) +
        `${bw ? bw.score.toFixed(2) : 'N/A'}`.padStart(7) +
        `${bw ? `${bw.startDate}→${bw.endDate}` : ''}`.padStart(22),
    );
  }

  console.log('\n  ── Volatility Contraction ──');
  const hdr2 =
    '  ' +
    'Ticker'.padEnd(8) +
    'RngT1'.padStart(8) +
    'RngT3'.padStart(8) +
    'Rng∆'.padStart(8) +
    'VolT1'.padStart(9) +
    'VolT3'.padStart(9) +
    'Vol∆'.padStart(8) +
    'BB∆'.padStart(8);
  console.log(hdr2);
  console.log('  ' + '-'.repeat(hdr2.length - 2));
  for (const r of allResults) {
    console.log(
      '  ' +
        r.symbol.padEnd(8) +
        `${r.avgT1Range.toFixed(3)}`.padStart(8) +
        `${r.avgT3Range.toFixed(3)}`.padStart(8) +
        `${r.rangeContractionT3vsT1.toFixed(0)}%`.padStart(8) +
        `${(r.avgT1Vol / 1e6).toFixed(1)}M`.padStart(9) +
        `${(r.avgT3Vol / 1e6).toFixed(1)}M`.padStart(9) +
        `${r.volContractionT3vsT1.toFixed(0)}%`.padStart(8) +
        `${r.bbContraction.toFixed(0)}%`.padStart(8),
    );
  }

  console.log('\n  ── Pre-Breakout (last 5 days) ──');
  const hdr3 =
    '  ' +
    'Ticker'.padEnd(8) +
    'L5 ∂%'.padStart(8) +
    'L5 Rng'.padStart(8) +
    'Avg Rng'.padStart(8) +
    'L5 Vol'.padStart(9) +
    'Avg Vol'.padStart(9) +
    'VolDry'.padStart(8) +
    'RngComp'.padStart(8);
  console.log(hdr3);
  console.log('  ' + '-'.repeat(hdr3.length - 2));
  for (const r of allResults) {
    console.log(
      '  ' +
        r.symbol.padEnd(8) +
        `${r.last5DeltaPct.toFixed(2)}`.padStart(8) +
        `${r.last5AvgRange.toFixed(3)}`.padStart(8) +
        `${mean(r.daily.map((d) => d.rangePct)).toFixed(3)}`.padStart(8) +
        `${(r.last5AvgVol / 1e6).toFixed(1)}M`.padStart(9) +
        `${(r.daily.reduce((s, d) => s + d.totalVol, 0) / r.nDays / 1e6).toFixed(1)}M`.padStart(9) +
        `${r.volDryup.toFixed(0)}%`.padStart(8) +
        `${r.rangeCompression.toFixed(0)}%`.padStart(8),
    );
  }

  console.log('\n  ── Absorption Pattern ──');
  const hdr4 =
    '  ' +
    'Ticker'.padEnd(8) +
    'Absorb%'.padStart(9) +
    'StrongAbs'.padStart(10) +
    'Distrib%'.padStart(10) +
    'PricePos'.padStart(9);
  console.log(hdr4);
  console.log('  ' + '-'.repeat(hdr4.length - 2));
  for (const r of allResults) {
    console.log(
      '  ' +
        r.symbol.padEnd(8) +
        `${r.absorptionPct.toFixed(1)}%`.padStart(9) +
        `${r.strongAbsorptionDays}`.padStart(10) +
        `${r.distributionPct.toFixed(1)}%`.padStart(10) +
        `${r.pricePositionInRange.toFixed(0)}%`.padStart(9),
    );
  }

  console.log('\n  ── Outlier Summary ──');
  for (const r of allResults) {
    const o3 = r.outliers3sigma.length;
    const o2 = r.outliers2sigma.length;
    console.log(
      `  ${r.symbol.padEnd(8)} 3σ outliers: ${o3}   2σ outliers: ${o2}   vol outliers: ${r.volOutliers.length}`,
    );
  }

  console.log('\nDone.');
})().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Deep HTF Pattern Analysis — Daily-timeframe consolidation metrics
 *
 * Goal: understand what characterizes RKLB and ASTS consolidations that
 * precede huge bullish breakouts, and what new/modified metrics could
 * improve detection for the "moderate" HTF mode.
 */

require('dotenv').config();

const DATA_API_KEY = process.env.DATA_API_KEY;
const BASE = 'https://api.massive.com';

// =========================================================================
// DATA FETCHING
// =========================================================================

async function fetchBars(symbol, multiplier, timespan, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
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

async function fetchDailyBars(symbol, from, to) {
  return fetchBars(symbol, 1, 'day', from, to);
}

async function fetch15mChunked(symbol, from, to) {
  const all = [];
  let cursor = new Date(from);
  const end = new Date(to);
  while (cursor < end) {
    const cEnd = new Date(cursor);
    cEnd.setDate(cEnd.getDate() + 120);
    if (cEnd > end) cEnd.setTime(end.getTime());
    const f = cursor.toISOString().split('T')[0];
    const t = cEnd.toISOString().split('T')[0];
    process.stdout.write(`  15m ${symbol} ${f}→${t}...`);
    const bars = await fetchBars(symbol, 15, 'minute', f, t);
    process.stdout.write(` ${bars.length}\n`);
    all.push(...bars);
    await sleep(250);
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
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
    process.stdout.write(`  1m ${symbol} ${f}→${t}...`);
    const bars = await fetchBars(symbol, 1, 'minute', f, t);
    process.stdout.write(` ${bars.length}\n`);
    all.push(...bars);
    await sleep(350);
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function toDate(ts) {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

// =========================================================================
// MATH HELPERS
// =========================================================================

function rollingMean(arr, w) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= w) sum -= arr[i - w];
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

function rollingStd(arr, w) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = w - 1; i < arr.length; i++) {
    let s = 0,
      s2 = 0;
    for (let j = i - w + 1; j <= i; j++) {
      s += arr[j];
      s2 += arr[j] ** 2;
    }
    const m = s / w;
    out[i] = Math.sqrt(Math.max(0, s2 / w - m * m));
  }
  return out;
}

function linReg(xs, ys) {
  const n = xs.length;
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
  let ssTot = 0,
    ssRes = 0;
  const intercept = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - intercept - slope * xs[i]) ** 2;
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

function pctRank(val, sorted) {
  if (sorted.length === 0) return 50;
  let c = 0;
  for (const v of sorted) {
    if (v < val) c++;
  }
  return (c / sorted.length) * 100;
}

// =========================================================================
// KNOWN EPISODES (manually refined from RKLB daily chart knowledge)
// These are the bull-run consolidation episodes we KNOW preceded breakouts
// =========================================================================

const KNOWN_EPISODES = {
  RKLB: [
    // Episode: late 2024 massive run → consolidation → second leg
    {
      label: 'Sep-Nov 2024 run → Dec consol',
      impulseFrom: '2024-09-06',
      impulseTo: '2024-11-29',
      consolTo: '2025-01-21',
    },
    // Episode: Jan 2025 rally → Feb-Mar pullback → Apr breakout
    {
      label: 'Dec 2024 dip-buy → Jan high → Feb consol',
      impulseFrom: '2024-12-09',
      impulseTo: '2025-01-24',
      consolTo: '2025-03-10',
    },
    // Episode: Apr-Jul 2025 rally → Jul-Sep consolidation → Oct breakout
    {
      label: 'Apr-Jul 2025 rally → Jul-Sep consol',
      impulseFrom: '2025-04-22',
      impulseTo: '2025-07-17',
      consolTo: '2025-10-03',
    },
    // Episode: Oct-Jan 2026 rally → Jan-Feb consolidation (current)
    {
      label: 'Nov-Jan 2026 rally → Jan-Feb consol',
      impulseFrom: '2025-11-21',
      impulseTo: '2026-01-16',
      consolTo: '2026-02-14',
    },
  ],
  ASTS: [
    // ASTS similar pattern — massive run then consolidation
    {
      label: 'May-Sep 2024 run → Oct consol',
      impulseFrom: '2024-05-01',
      impulseTo: '2024-09-20',
      consolTo: '2024-11-15',
    },
    { label: 'Nov 2024 run → Dec consol', impulseFrom: '2024-11-01', impulseTo: '2024-12-13', consolTo: '2025-01-15' },
    {
      label: 'Mar-Jun 2025 run → Jun-Aug consol',
      impulseFrom: '2025-03-01',
      impulseTo: '2025-06-15',
      consolTo: '2025-08-30',
    },
    {
      label: 'Sep-Nov 2025 run → Dec consol',
      impulseFrom: '2025-09-01',
      impulseTo: '2025-11-15',
      consolTo: '2026-01-15',
    },
  ],
};

// =========================================================================
// DAILY-LEVEL METRICS
// =========================================================================

function analyzeDailyConsolidation(daily, impulseFromDate, impulseToDate, consolToDate) {
  // Find indices
  const ifIdx = daily.findIndex((b) => toDate(b.time) >= impulseFromDate);
  const itIdx = daily.findIndex((b) => toDate(b.time) >= impulseToDate);
  const ctIdx = daily.findIndex((b) => toDate(b.time) >= consolToDate);
  if (ifIdx < 0 || itIdx < 0 || ctIdx < 0 || itIdx <= ifIdx) return null;

  const impulseBars = daily.slice(ifIdx, itIdx + 1);
  const consolBars = daily.slice(itIdx + 1, ctIdx + 1);
  if (impulseBars.length < 2 || consolBars.length < 2) return null;

  // Impulse metrics
  let impulseLow = Infinity,
    impulseHigh = -Infinity;
  for (const b of impulseBars) {
    if (b.low < impulseLow) impulseLow = b.low;
    if (b.high > impulseHigh) impulseHigh = b.high;
  }
  const impulseGainPct = ((impulseHigh - impulseLow) / impulseLow) * 100;

  // Daily volume during impulse
  const impulseVolumes = impulseBars.map((b) => b.volume);
  const avgImpulseVol = impulseVolumes.reduce((s, v) => s + v, 0) / impulseVolumes.length;

  // === CONSOLIDATION METRICS ===

  // 1. Daily volume trend during consolidation
  const consolVolumes = consolBars.map((b) => b.volume);
  const avgConsolVol = consolVolumes.reduce((s, v) => s + v, 0) / consolVolumes.length;
  const volDeclineRatio = avgConsolVol / avgImpulseVol;

  // Volume slope: is daily volume declining?
  const volXs = consolVolumes.map((_, i) => i);
  const volReg = linReg(volXs, consolVolumes.map(Math.log));
  const volSlopeDecay = volReg.slope; // negative = declining
  const volSlopeR2 = volReg.r2;

  // 2. Retrace from impulse high
  let consolLow = Infinity,
    consolHigh = -Infinity;
  for (const b of consolBars) {
    if (b.low < consolLow) consolLow = b.low;
    if (b.high > consolHigh) consolHigh = b.high;
  }
  const retracePct = ((impulseHigh - consolLow) / impulseHigh) * 100;
  const consolRangePct = ((consolHigh - consolLow) / impulseHigh) * 100;

  // 3. Higher-low test: does the consolidation show higher lows?
  // Split into thirds and check if lowest low rises
  const third = Math.floor(consolBars.length / 3);
  if (third >= 1) {
    var firstThirdLow = Math.min(...consolBars.slice(0, third).map((b) => b.low));
    var midThirdLow = Math.min(...consolBars.slice(third, 2 * third).map((b) => b.low));
    var lastThirdLow = Math.min(...consolBars.slice(2 * third).map((b) => b.low));
    var higherLows = midThirdLow >= firstThirdLow * 0.99 && lastThirdLow >= midThirdLow * 0.99;
  } else {
    var firstThirdLow = NaN,
      midThirdLow = NaN,
      lastThirdLow = NaN,
      higherLows = false;
  }

  // 4. Daily range contraction — ATR declining?
  const dailyRanges = consolBars.map((b) => b.high - b.low);
  const rangeXs = dailyRanges.map((_, i) => i);
  const rangeRegLogSafe = dailyRanges.filter((r) => r > 0);
  let rangeSlope = 0,
    rangeR2 = 0;
  if (rangeRegLogSafe.length >= 5) {
    const rr = linReg(
      rangeRegLogSafe.map((_, i) => i),
      rangeRegLogSafe.map(Math.log),
    );
    rangeSlope = rr.slope;
    rangeR2 = rr.r2;
  }

  // First half vs second half range
  const halfIdx = Math.floor(consolBars.length / 2);
  const firstHalfAvgRange = dailyRanges.slice(0, halfIdx).reduce((s, v) => s + v, 0) / halfIdx;
  const secondHalfAvgRange = dailyRanges.slice(halfIdx).reduce((s, v) => s + v, 0) / (dailyRanges.length - halfIdx);
  const rangeContractionRatio = firstHalfAvgRange > 0 ? secondHalfAvgRange / firstHalfAvgRange : NaN;

  // 5. Price holding near impulse high — what % of consolidation time is within 15% of high?
  const nearHighThreshold = impulseHigh * 0.85;
  const barsNearHigh = consolBars.filter((b) => b.close >= nearHighThreshold).length;
  const nearHighPct = (barsNearHigh / consolBars.length) * 100;

  // 6. Close-to-close volatility during consolidation
  const dailyReturns = [];
  for (let i = 1; i < consolBars.length; i++) {
    dailyReturns.push(Math.log(consolBars[i].close / consolBars[i - 1].close));
  }
  const avgReturn = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
  const dailyVol = Math.sqrt(dailyReturns.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / dailyReturns.length);

  // Compare to impulse volatility
  const impulseReturns = [];
  for (let i = 1; i < impulseBars.length; i++) {
    impulseReturns.push(Math.log(impulseBars[i].close / impulseBars[i - 1].close));
  }
  const impulseAvgRet = impulseReturns.reduce((s, v) => s + v, 0) / impulseReturns.length;
  const impulseVol = Math.sqrt(
    impulseReturns.reduce((s, v) => s + (v - impulseAvgRet) ** 2, 0) / impulseReturns.length,
  );
  const volContractionRatio = impulseVol > 0 ? dailyVol / impulseVol : NaN;

  // 7. Bollinger Band Width contraction
  const closes = consolBars.map((b) => b.close);
  const sma20 = rollingMean(closes, Math.min(20, Math.floor(closes.length / 2)));
  const std20 = rollingStd(closes, Math.min(20, Math.floor(closes.length / 2)));
  const bbWidths = [];
  for (let i = 0; i < closes.length; i++) {
    if (Number.isFinite(sma20[i]) && Number.isFinite(std20[i]) && sma20[i] > 0) {
      bbWidths.push((2 * std20[i]) / sma20[i]);
    }
  }
  const bbWidthStart =
    bbWidths.length >= 4
      ? bbWidths.slice(0, Math.floor(bbWidths.length / 4)).reduce((s, v) => s + v, 0) / Math.floor(bbWidths.length / 4)
      : NaN;
  const bbWidthEnd =
    bbWidths.length >= 4
      ? bbWidths.slice(-Math.floor(bbWidths.length / 4)).reduce((s, v) => s + v, 0) / Math.floor(bbWidths.length / 4)
      : NaN;
  const bbContraction = Number.isFinite(bbWidthStart) && bbWidthStart > 0 ? bbWidthEnd / bbWidthStart : NaN;

  return {
    impulseDays: impulseBars.length,
    impulseGainPct,
    impulseHigh,
    impulseLow,
    consolDays: consolBars.length,
    retracePct,
    consolRangePct,
    volume: {
      avgImpulseVol: Math.round(avgImpulseVol),
      avgConsolVol: Math.round(avgConsolVol),
      declineRatio: volDeclineRatio,
      slopeDecay: volSlopeDecay,
      slopeR2: volSlopeR2,
    },
    higherLows: {
      firstThirdLow,
      midThirdLow,
      lastThirdLow,
      higherLows,
    },
    dailyRange: {
      slope: rangeSlope,
      r2: rangeR2,
      contractionRatio: rangeContractionRatio,
    },
    nearHighPct,
    volatility: {
      dailyVol,
      impulseVol,
      contractionRatio: volContractionRatio,
    },
    bollingerBand: {
      widthStart: bbWidthStart,
      widthEnd: bbWidthEnd,
      contraction: bbContraction,
    },
  };
}

// =========================================================================
// INTRADAY METRICS — focus on what the existing algo measures
// =========================================================================

function analyzeIntraday(bars15m, bars1m, daily, impulseToDate, consolToDate) {
  const itIdx = daily.findIndex((b) => toDate(b.time) >= impulseToDate);
  if (itIdx < 0) return null;
  const consolStartTime = daily[itIdx].time;
  const ctIdx = daily.findIndex((b) => toDate(b.time) >= consolToDate);
  const consolEndTime = ctIdx >= 0 ? daily[ctIdx].time : daily[daily.length - 1].time;

  // Slice 15m bars for consolidation
  const consol15m = bars15m.filter((b) => b.time >= consolStartTime && b.time <= consolEndTime + 86400);
  const consol1m = bars1m.filter((b) => b.time >= consolStartTime && b.time <= consolEndTime + 86400);
  // Pre-impulse 15m for context (30 days before impulse end)
  const preContext15m = bars15m.filter((b) => b.time >= consolStartTime - 90 * 86400 && b.time < consolStartTime);

  if (consol15m.length < 10) return { error: `Only ${consol15m.length} 15m bars in consolidation` };

  // 1. 15m bar range during consolidation — absolute values
  const consolBarRanges = consol15m.map((b) => ((b.high - b.low) / b.close) * 100);
  const avgConsolBarRange = consolBarRanges.reduce((s, v) => s + v, 0) / consolBarRanges.length;
  const preBarRanges = preContext15m.map((b) => ((b.high - b.low) / b.close) * 100);
  const avgPreBarRange = preBarRanges.length > 0 ? preBarRanges.reduce((s, v) => s + v, 0) / preBarRanges.length : NaN;
  const barRangeRatio = avgPreBarRange > 0 ? avgConsolBarRange / avgPreBarRange : NaN;

  // 2. Intraday volume pattern — morning vs afternoon
  // In consolidation: is volume front-loaded (typical of active trading)
  // or spread throughout (institutional accumulation)?
  const morningBars = consol1m.filter((b) => {
    const h = new Date(b.time * 1000).getUTCHours();
    return h >= 13 && h < 17; // ~9:30 AM - 12 PM ET in UTC
  });
  const afternoonBars = consol1m.filter((b) => {
    const h = new Date(b.time * 1000).getUTCHours();
    return h >= 17 && h < 21; // ~12 PM - 4 PM ET in UTC
  });
  const morningVol = morningBars.reduce((s, b) => s + b.volume, 0);
  const afternoonVol = afternoonBars.reduce((s, b) => s + b.volume, 0);
  const morningToAfternoonRatio = afternoonVol > 0 ? morningVol / afternoonVol : NaN;

  // 3. Net delta accumulation during consolidation (1m)
  let totalBuyVol = 0,
    totalSellVol = 0;
  for (const b of consol1m) {
    if (b.close > b.open) totalBuyVol += b.volume;
    else if (b.close < b.open) totalSellVol += b.volume;
  }
  const netDeltaPct =
    totalBuyVol + totalSellVol > 0 ? ((totalBuyVol - totalSellVol) / (totalBuyVol + totalSellVol)) * 100 : 0;

  // 4. Delta trend: is buying pressure increasing toward end of consolidation?
  const dailyDeltas = [];
  let dayStart = consol1m.length > 0 ? toDate(consol1m[0].time) : '';
  let dayBuyVol = 0,
    daySellVol = 0;
  for (const b of consol1m) {
    const d = toDate(b.time);
    if (d !== dayStart) {
      if (dayStart) dailyDeltas.push(dayBuyVol - daySellVol);
      dayStart = d;
      dayBuyVol = 0;
      daySellVol = 0;
    }
    if (b.close > b.open) dayBuyVol += b.volume;
    else if (b.close < b.open) daySellVol += b.volume;
  }
  if (dayStart) dailyDeltas.push(dayBuyVol - daySellVol);

  let deltaTrendSlope = 0,
    deltaTrendR2 = 0;
  if (dailyDeltas.length >= 5) {
    const dr = linReg(
      dailyDeltas.map((_, i) => i),
      dailyDeltas,
    );
    deltaTrendSlope = dr.slope;
    deltaTrendR2 = dr.r2;
  }

  // 5. VWAP: how close does price stay to VWAP during consolidation?
  let cumVP = 0,
    cumV = 0;
  const vwapDeviations = [];
  for (const b of consol15m) {
    const tp = (b.high + b.low + b.close) / 3;
    cumVP += tp * b.volume;
    cumV += b.volume;
    const vwap = cumV > 0 ? cumVP / cumV : b.close;
    vwapDeviations.push((Math.abs(b.close - vwap) / vwap) * 100);
  }
  const avgVwapDevPct = vwapDeviations.reduce((s, v) => s + v, 0) / vwapDeviations.length;
  // Is deviation decreasing?
  const firstHalfDevs = vwapDeviations.slice(0, Math.floor(vwapDeviations.length / 2));
  const secondHalfDevs = vwapDeviations.slice(Math.floor(vwapDeviations.length / 2));
  const firstHalfAvgDev = firstHalfDevs.reduce((s, v) => s + v, 0) / firstHalfDevs.length;
  const secondHalfAvgDev = secondHalfDevs.reduce((s, v) => s + v, 0) / secondHalfDevs.length;
  const vwapConvergence = firstHalfAvgDev > 0 ? secondHalfAvgDev / firstHalfAvgDev : NaN;

  return {
    consol15mBars: consol15m.length,
    consol1mBars: consol1m.length,
    barRangeRatio,
    avgConsolBarRangePct: avgConsolBarRange,
    morningToAfternoonRatio,
    netDeltaPct,
    deltaTrend: { slope: deltaTrendSlope, r2: deltaTrendR2, nDays: dailyDeltas.length },
    vwap: { avgDevPct: avgVwapDevPct, convergence: vwapConvergence },
  };
}

// =========================================================================
// MAIN
// =========================================================================

async function main() {
  console.log('=== Deep HTF Pattern Analysis ===\n');

  for (const symbol of ['RKLB', 'ASTS']) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  ${symbol}`);
    console.log(`${'═'.repeat(80)}\n`);

    const fromDate = '2024-01-01';
    const toDate = '2026-02-14';

    let daily, bars15m, bars1m;
    try {
      console.log(`Fetching daily...`);
      daily = await fetchDailyBars(symbol, fromDate, toDate);
      console.log(`  ${daily.length} daily bars\n`);

      console.log(`Fetching 15m...`);
      bars15m = await fetch15mChunked(symbol, fromDate, toDate);
      console.log(`  ${bars15m.length} total 15m bars\n`);

      console.log(`Fetching 1m...`);
      bars1m = await fetch1mChunked(symbol, fromDate, toDate);
      console.log(`  ${bars1m.length} total 1m bars\n`);
    } catch (err) {
      console.error(`  FETCH FAILED for ${symbol}: ${err.message}`);
      continue;
    }

    const episodes = KNOWN_EPISODES[symbol] || [];
    for (const ep of episodes) {
      console.log(`\n  ${'─'.repeat(70)}`);
      console.log(`  ${ep.label}`);
      console.log(`  Impulse: ${ep.impulseFrom} → ${ep.impulseTo}  |  Consol: → ${ep.consolTo}`);

      const dailyMetrics = analyzeDailyConsolidation(daily, ep.impulseFrom, ep.impulseTo, ep.consolTo);
      if (!dailyMetrics) {
        console.log(`  ⚠ Could not compute daily metrics`);
        continue;
      }

      console.log(`\n  DAILY METRICS:`);
      console.log(
        `    Impulse: ${dailyMetrics.impulseDays} days, +${dailyMetrics.impulseGainPct.toFixed(1)}%, $${dailyMetrics.impulseLow.toFixed(2)}→$${dailyMetrics.impulseHigh.toFixed(2)}`,
      );
      console.log(
        `    Consol: ${dailyMetrics.consolDays} days, retrace ${dailyMetrics.retracePct.toFixed(1)}%, range ${dailyMetrics.consolRangePct.toFixed(1)}%`,
      );
      console.log(
        `    Volume: impulse avg ${dailyMetrics.volume.avgImpulseVol.toLocaleString()}, consol avg ${dailyMetrics.volume.avgConsolVol.toLocaleString()}, ratio ${dailyMetrics.volume.declineRatio.toFixed(3)}`,
      );
      console.log(
        `    Volume slope: ${dailyMetrics.volume.slopeDecay.toFixed(6)} (R²=${dailyMetrics.volume.slopeR2.toFixed(3)}) ${dailyMetrics.volume.slopeDecay < 0 ? '↓ declining' : '↑ increasing'}`,
      );
      console.log(
        `    Higher lows: ${dailyMetrics.higherLows.higherLows ? 'YES' : 'NO'} (thirds: $${dailyMetrics.higherLows.firstThirdLow?.toFixed(2)}, $${dailyMetrics.higherLows.midThirdLow?.toFixed(2)}, $${dailyMetrics.higherLows.lastThirdLow?.toFixed(2)})`,
      );
      console.log(
        `    Daily range decay: slope=${dailyMetrics.dailyRange.slope.toFixed(6)}, R²=${dailyMetrics.dailyRange.r2.toFixed(3)}, contraction=${dailyMetrics.dailyRange.contractionRatio?.toFixed(3) || 'N/A'}`,
      );
      console.log(`    Price near high (within 15%): ${dailyMetrics.nearHighPct.toFixed(1)}% of consol days`);
      console.log(
        `    Volatility: daily=${(dailyMetrics.volatility.dailyVol * 100).toFixed(2)}%, impulse=${(dailyMetrics.volatility.impulseVol * 100).toFixed(2)}%, ratio=${dailyMetrics.volatility.contractionRatio?.toFixed(3) || 'N/A'}`,
      );
      console.log(
        `    Bollinger Width: start=${dailyMetrics.bollingerBand.widthStart?.toFixed(4) || 'N/A'}, end=${dailyMetrics.bollingerBand.widthEnd?.toFixed(4) || 'N/A'}, contraction=${dailyMetrics.bollingerBand.contraction?.toFixed(3) || 'N/A'}`,
      );

      const intradayMetrics = analyzeIntraday(bars15m, bars1m, daily, ep.impulseTo, ep.consolTo);
      if (intradayMetrics && !intradayMetrics.error) {
        console.log(`\n  INTRADAY METRICS (consolidation period):`);
        console.log(`    15m bars: ${intradayMetrics.consol15mBars}, 1m bars: ${intradayMetrics.consol1mBars}`);
        console.log(
          `    15m bar range ratio (consol/pre): ${intradayMetrics.barRangeRatio?.toFixed(3) || 'N/A'} (avg consol bar range: ${intradayMetrics.avgConsolBarRangePct.toFixed(3)}%)`,
        );
        console.log(`    Morning/afternoon vol ratio: ${intradayMetrics.morningToAfternoonRatio?.toFixed(3) || 'N/A'}`);
        console.log(
          `    Net delta (buy-sell): ${intradayMetrics.netDeltaPct.toFixed(2)}% ${intradayMetrics.netDeltaPct > 0 ? '(net buying)' : '(net selling)'}`,
        );
        console.log(
          `    Delta trend: slope=${intradayMetrics.deltaTrend.slope.toFixed(0)}, R²=${intradayMetrics.deltaTrend.r2.toFixed(3)} (${intradayMetrics.deltaTrend.nDays} days)`,
        );
        console.log(
          `    VWAP: avg dev ${intradayMetrics.vwap.avgDevPct.toFixed(3)}%, convergence ${intradayMetrics.vwap.convergence?.toFixed(3) || 'N/A'}`,
        );
      } else if (intradayMetrics?.error) {
        console.log(`\n  INTRADAY: ⚠ ${intradayMetrics.error}`);
      }
    }

    // === AGGREGATE PATTERN SUMMARY ===
    console.log(`\n\n  ${'═'.repeat(60)}`);
    console.log(`  AGGREGATE PATTERN SUMMARY for ${symbol}`);
    console.log(`  ${'═'.repeat(60)}`);

    const allMetrics = episodes
      .map((ep) => analyzeDailyConsolidation(daily, ep.impulseFrom, ep.impulseTo, ep.consolTo))
      .filter(Boolean);
    if (allMetrics.length > 0) {
      const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
      const validVals = (arr) => arr.filter((v) => Number.isFinite(v));

      console.log(`\n  Across ${allMetrics.length} episodes:`);
      console.log(`    Avg impulse gain: ${avg(allMetrics.map((m) => m.impulseGainPct)).toFixed(1)}%`);
      console.log(`    Avg consol days: ${avg(allMetrics.map((m) => m.consolDays)).toFixed(0)}`);
      console.log(`    Avg retrace: ${avg(allMetrics.map((m) => m.retracePct)).toFixed(1)}%`);
      console.log(`    Avg vol decline ratio: ${avg(allMetrics.map((m) => m.volume.declineRatio)).toFixed(3)}`);
      console.log(
        `    Vol declining in: ${allMetrics.filter((m) => m.volume.slopeDecay < 0).length}/${allMetrics.length} episodes`,
      );
      console.log(
        `    Higher lows in: ${allMetrics.filter((m) => m.higherLows.higherLows).length}/${allMetrics.length} episodes`,
      );
      console.log(`    Avg near-high%: ${avg(allMetrics.map((m) => m.nearHighPct)).toFixed(1)}%`);
      console.log(
        `    Avg vol contraction: ${avg(validVals(allMetrics.map((m) => m.volatility.contractionRatio))).toFixed(3)}`,
      );
      console.log(
        `    Avg BB contraction: ${avg(validVals(allMetrics.map((m) => m.bollingerBand.contraction))).toFixed(3)}`,
      );
      console.log(
        `    Avg daily range contraction: ${avg(validVals(allMetrics.map((m) => m.dailyRange.contractionRatio))).toFixed(3)}`,
      );
    }
  }

  console.log(`\n\nDone.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

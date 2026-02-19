#!/usr/bin/env node
/**
 * VDF Full-Year Analysis — 18 tickers, 1 year of 1-minute data
 * Runs the JS algorithm AND outputs comprehensive data for LLM expert analysis.
 *
 * Usage: node analysis-vdf-full-year.js
 * Output: analysis-vdf-full-year-results.json
 */

'use strict';

const {
  vdAggregateDaily,
  buildWeeks,
  findAccumulationZones,
  findDistributionClusters,
  evaluateProximitySignals,
  scoreSubwindow,
} = require('../server/services/vdfDetector');

const fs = require('fs');

// --- Config ---
const DATA_API_KEY = 'pig0ix6gPImcxdqhUmvTCUnjVPKVmkC0';
const BASE = 'https://api.massive.com';
const FROM_DATE = '2025-02-15';
const TO_DATE = '2026-02-14';

const TICKERS = [
  'ASTS',
  'RKLB',
  'BE',
  'BW',
  'COHR',
  'CRDO',
  'EOSE',
  'GRAL',
  'HUT',
  'IMNM',
  'INSM',
  'MOD',
  'PL',
  'SATS',
  'STX',
  'UUUU',
  'WULF',
  'META',
];

// --- Fetch helpers ---
async function fetchBars(symbol, mult, ts, from, to) {
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${mult}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${DATA_API_KEY}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${symbol} ${from}→${to}`);
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
    process.stdout.write(`  1m ${symbol} ${f}→${t}...`);
    const bars = await fetchBars(symbol, 1, 'minute', f, t);
    process.stdout.write(` ${bars.length}\n`);
    all.push(...bars);
    await new Promise((r) => setTimeout(r, 200));
    cursor = new Date(cEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  const map = new Map();
  for (const b of all) map.set(b.time, b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

// --- Analysis helpers ---
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function computeWeeklySummary(daily) {
  const weeks = buildWeeks(daily);
  let cumDelta = 0;
  return weeks.map((w) => {
    // Find daily data for this week
    const weekDays = daily.filter((d) => {
      const dt = new Date(d.date + 'T12:00:00Z');
      const dow = dt.getUTCDay();
      const monday = new Date(dt);
      monday.setUTCDate(monday.getUTCDate() - (dow === 0 ? 6 : dow - 1));
      return monday.toISOString().split('T')[0] === w.weekStart;
    });
    const closeStart = weekDays.length > 0 ? weekDays[0].open : 0;
    const closeEnd = weekDays.length > 0 ? weekDays[weekDays.length - 1].close : 0;
    const priceChgPct = closeStart > 0 ? ((closeEnd - closeStart) / closeStart) * 100 : 0;
    const absorptionDays = weekDays.filter((d, i) => {
      if (i === 0) {
        const prevIdx = daily.indexOf(d);
        return prevIdx > 0 && d.close < daily[prevIdx - 1].close && d.delta > 0;
      }
      return d.close < weekDays[i - 1].close && d.delta > 0;
    }).length;
    cumDelta += w.delta;
    return {
      weekStart: w.weekStart,
      days: w.nDays,
      priceChgPct: +priceChgPct.toFixed(2),
      delta: Math.round(w.delta),
      deltaPct: +w.deltaPct.toFixed(3),
      cumDelta: Math.round(cumDelta),
      absorptionDays,
      avgVol: Math.round(w.totalVol / w.nDays),
      closeEnd: +closeEnd.toFixed(2),
    };
  });
}

function computeMonthlyPhases(daily) {
  // 20-day rolling window analysis for institutional flow classification
  const phases = [];
  for (let i = 19; i < daily.length; i += 10) {
    // step by 10 for bi-weekly granularity
    const window = daily.slice(Math.max(0, i - 19), i + 1);
    if (window.length < 10) continue;
    const priceChg = ((window[window.length - 1].close - window[0].close) / window[0].close) * 100;
    const totalVol = window.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = window.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

    // Classify phase
    let phase;
    if (priceChg > 3 && netDeltaPct < -3) phase = 'DISTRIBUTION';
    else if (priceChg < -3 && netDeltaPct > 3) phase = 'ACCUMULATION_IN_DECLINE';
    else if (priceChg > 3 && netDeltaPct > 3) phase = 'CONFIRMED_RALLY';
    else if (priceChg < -3 && netDeltaPct < -3) phase = 'CONCORDANT_DECLINE';
    else if (Math.abs(priceChg) <= 3 && netDeltaPct > 3) phase = 'ABSORBING';
    else phase = 'NEUTRAL';

    // Count absorption days in window
    let absorptionDays = 0;
    for (let j = 1; j < window.length; j++) {
      if (window[j].close < window[j - 1].close && window[j].delta > 0) absorptionDays++;
    }

    phases.push({
      startDate: window[0].date,
      endDate: window[window.length - 1].date,
      phase,
      priceChgPct: +priceChg.toFixed(2),
      netDeltaPct: +netDeltaPct.toFixed(3),
      absorptionDays,
      days: window.length,
    });
  }
  return phases;
}

function findDeltaAnomalies(daily) {
  const anomalies = [];
  for (let i = 20; i < daily.length; i++) {
    const rolling20 = daily.slice(i - 20, i).map((d) => Math.abs(d.delta));
    const rollingAvg = mean(rolling20);
    const rollingStd = std(rolling20);
    const ratio = rollingAvg > 0 ? Math.abs(daily[i].delta) / rollingAvg : 0;
    if (ratio > 3.5) {
      const priceChg = i > 0 ? ((daily[i].close - daily[i - 1].close) / daily[i - 1].close) * 100 : 0;
      anomalies.push({
        date: daily[i].date,
        delta: Math.round(daily[i].delta),
        ratio: +ratio.toFixed(1),
        priceChgPct: +priceChg.toFixed(2),
        close: +daily[i].close.toFixed(2),
        type: daily[i].delta > 0 ? (priceChg < 0 ? 'ABSORPTION_ANOMALY' : 'CONCORDANT_ANOMALY') : 'SELL_ANOMALY',
      });
    }
  }
  return anomalies;
}

function findStreaks(daily) {
  const streaks = [];
  let currentStreak = { type: null, start: 0, len: 0 };

  for (let i = 0; i < daily.length; i++) {
    const type = daily[i].delta > 0 ? 'green' : 'red';
    if (type === currentStreak.type) {
      currentStreak.len++;
    } else {
      if (currentStreak.len >= 4) {
        const streakDays = daily.slice(currentStreak.start, currentStreak.start + currentStreak.len);
        const totalDelta = streakDays.reduce((s, d) => s + d.delta, 0);
        // Check if intensifying for red streaks
        let intensifying = false;
        if (currentStreak.type === 'red' && streakDays.length >= 3) {
          intensifying = Math.abs(streakDays[streakDays.length - 1].delta) > Math.abs(streakDays[0].delta);
        }
        streaks.push({
          type: currentStreak.type,
          startDate: streakDays[0].date,
          endDate: streakDays[streakDays.length - 1].date,
          days: currentStreak.len,
          totalDelta: Math.round(totalDelta),
          intensifying,
        });
      }
      currentStreak = { type, start: i, len: 1 };
    }
  }
  // Capture last streak
  if (currentStreak.len >= 4) {
    const streakDays = daily.slice(currentStreak.start, currentStreak.start + currentStreak.len);
    const totalDelta = streakDays.reduce((s, d) => s + d.delta, 0);
    streaks.push({
      type: currentStreak.type,
      startDate: streakDays[0].date,
      endDate: streakDays[streakDays.length - 1].date,
      days: currentStreak.len,
      totalDelta: Math.round(totalDelta),
      intensifying:
        currentStreak.type === 'red' &&
        streakDays.length >= 3 &&
        Math.abs(streakDays[streakDays.length - 1].delta) > Math.abs(streakDays[0].delta),
    });
  }
  return streaks;
}

function computeSubPeriodDivergence(daily) {
  // Compute rolling 20-day correlation between price change and cumDelta
  // Negative correlation = divergence (accumulation or distribution)
  const divergenceWindows = [];
  for (let i = 19; i < daily.length; i++) {
    const window = daily.slice(i - 19, i + 1);
    const prices = window.map((d) => d.close);
    let cumD = 0;
    const cumDeltas = window.map((d) => {
      cumD += d.delta;
      return cumD;
    });

    // Pearson correlation
    const n = prices.length;
    const meanP = mean(prices),
      meanD = mean(cumDeltas);
    let num = 0,
      denP = 0,
      denD = 0;
    for (let j = 0; j < n; j++) {
      const dp = prices[j] - meanP,
        dd = cumDeltas[j] - meanD;
      num += dp * dd;
      denP += dp * dp;
      denD += dd * dd;
    }
    const corr = denP > 0 && denD > 0 ? num / Math.sqrt(denP * denD) : 0;

    if (i % 5 === 0 || Math.abs(corr) > 0.7) {
      // Sample every 5 days + notable divergences
      divergenceWindows.push({
        endDate: daily[i].date,
        correlation: +corr.toFixed(3),
        priceChg: +(((prices[n - 1] - prices[0]) / prices[0]) * 100).toFixed(2),
        netDelta: Math.round(cumDeltas[n - 1]),
      });
    }
  }
  return divergenceWindows;
}

// Run the full JS algorithm with extended lookback
function runJSAlgorithm(allDaily) {
  // Use first 30 trading days as pre-context, rest as scan period
  const preContextDays = Math.min(30, Math.floor(allDaily.length * 0.12));
  const preDaily = allDaily.slice(0, preContextDays);
  const scanDaily = allDaily.slice(preContextDays);

  if (scanDaily.length < 10) {
    return { zones: [], distribution: [], proximity: { compositeScore: 0, level: 'none', signals: [] } };
  }

  // Run accumulation zone detection
  const zones = findAccumulationZones(scanDaily, preDaily, 5); // up to 5 zones for full year

  // Run distribution cluster detection
  const { distClusters } = findDistributionClusters(scanDaily);

  // Run proximity signal evaluation
  const proximity = evaluateProximitySignals(scanDaily, zones);

  // Format zones
  const formattedZones = zones.map((z) => ({
    rank: z.rank,
    startDate: z.startDate,
    endDate: z.endDate,
    windowDays: z.winSize,
    score: +z.score.toFixed(4),
    weeks: z.weeks,
    accumWeeks: z.accumWeeks,
    netDeltaPct: +z.netDeltaPct.toFixed(3),
    absorptionPct: +z.absorptionPct.toFixed(1),
    accumWeekRatio: +z.accumWeekRatio.toFixed(3),
    overallPriceChange: +z.overallPriceChange.toFixed(2),
    concordantFrac: +(z.concordantFrac || 0).toFixed(3),
    concordancePenalty: +(z.concordancePenalty || 1).toFixed(3),
    durationMultiplier: +z.durationMultiplier.toFixed(3),
    components: z.components
      ? {
          s1_netDelta: +z.components.s1.toFixed(3),
          s2_deltaSlope: +z.components.s2.toFixed(3),
          s3_deltaShift: +z.components.s3.toFixed(3),
          s4_accumRatio: +z.components.s4.toFixed(3),
          s5_buyVsSell: +z.components.s5.toFixed(3),
          s6_absorption: +z.components.s6.toFixed(3),
          s7_volDecline: +z.components.s7.toFixed(3),
          s8_divergence: +z.components.s8.toFixed(3),
        }
      : null,
    intraRally: +(z.intraRally || 0).toFixed(2),
  }));

  // Format distribution
  const formattedDist = distClusters.map((c) => ({
    startDate: c.startDate,
    endDate: c.endDate,
    spanDays: c.spanDays || c.end - c.start + 1,
    priceChangePct: +(c.priceChangePct || c.maxPriceChg || 0).toFixed(2),
    netDeltaPct: +(c.netDeltaPct || c.minDeltaPct || 0).toFixed(3),
  }));

  return {
    zones: formattedZones,
    distribution: formattedDist,
    proximity,
  };
}

// --- Main ---
async function main() {
  const results = {};
  const startTime = Date.now();

  for (const ticker of TICKERS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Fetching ${ticker} (${FROM_DATE} → ${TO_DATE})`);
    console.log('='.repeat(60));

    try {
      const bars1m = await fetch1mChunked(ticker, FROM_DATE, TO_DATE);
      console.log(`  Total 1m bars: ${bars1m.length}`);

      if (bars1m.length < 1000) {
        console.log(`  SKIP: insufficient data`);
        results[ticker] = { error: 'insufficient_data', bars: bars1m.length };
        continue;
      }

      // Aggregate to daily
      const allDaily = vdAggregateDaily(bars1m);
      console.log(`  Trading days: ${allDaily.length}`);
      console.log(`  Date range: ${allDaily[0].date} → ${allDaily[allDaily.length - 1].date}`);

      // Price summary
      const startPrice = allDaily[0].close;
      const endPrice = allDaily[allDaily.length - 1].close;
      const highPrice = Math.max(...allDaily.map((d) => d.high));
      const lowPrice = Math.min(...allDaily.map((d) => d.low));
      console.log(
        `  Price: ${startPrice.toFixed(2)} → ${endPrice.toFixed(2)} (${(((endPrice - startPrice) / startPrice) * 100).toFixed(1)}%)`,
      );
      console.log(`  High: ${highPrice.toFixed(2)}, Low: ${lowPrice.toFixed(2)}`);

      // Total delta
      const totalNetDelta = allDaily.reduce((s, d) => s + d.delta, 0);
      const totalVol = allDaily.reduce((s, d) => s + d.totalVol, 0);
      console.log(
        `  Net Delta: ${(totalNetDelta / 1000).toFixed(0)}K (${((totalNetDelta / totalVol) * 100).toFixed(3)}%)`,
      );

      // Run JS algorithm
      console.log(`  Running JS algorithm...`);
      const jsResult = runJSAlgorithm(allDaily);
      console.log(`  JS Zones: ${jsResult.zones.length}`);
      for (const z of jsResult.zones) {
        console.log(
          `    Z${z.rank}: ${z.startDate}→${z.endDate} score=${z.score} netΔ=${z.netDeltaPct}% price=${z.overallPriceChange}% conc=${z.concordantFrac}`,
        );
      }
      console.log(`  JS Distribution: ${jsResult.distribution.length}`);
      for (const d of jsResult.distribution) {
        console.log(`    D: ${d.startDate}→${d.endDate} price=${d.priceChangePct}% netΔ=${d.netDeltaPct}%`);
      }
      console.log(`  JS Proximity: ${jsResult.proximity.compositeScore}pts (${jsResult.proximity.level})`);

      // Compute LLM analysis data
      const weeklySummary = computeWeeklySummary(allDaily);
      const monthlyPhases = computeMonthlyPhases(allDaily);
      const deltaAnomalies = findDeltaAnomalies(allDaily);
      const streaks = findStreaks(allDaily);
      const divergenceWindows = computeSubPeriodDivergence(allDaily);

      console.log(`  Delta anomalies: ${deltaAnomalies.length}`);
      console.log(`  Notable streaks: ${streaks.length}`);

      // Build compact daily data for LLM analysis (key columns only)
      const dailyCompact = allDaily.map((d, i) => ({
        date: d.date,
        close: +d.close.toFixed(2),
        priceChg: i > 0 ? +(((d.close - allDaily[i - 1].close) / allDaily[i - 1].close) * 100).toFixed(2) : 0,
        delta: Math.round(d.delta),
        deltaPct: d.totalVol > 0 ? +((d.delta / d.totalVol) * 100).toFixed(3) : 0,
        vol: Math.round(d.totalVol),
        isAbsorption: i > 0 && d.close < allDaily[i - 1].close && d.delta > 0,
      }));

      results[ticker] = {
        summary: {
          tradingDays: allDaily.length,
          dateRange: `${allDaily[0].date} → ${allDaily[allDaily.length - 1].date}`,
          startPrice: +startPrice.toFixed(2),
          endPrice: +endPrice.toFixed(2),
          priceChangePct: +(((endPrice - startPrice) / startPrice) * 100).toFixed(2),
          highPrice: +highPrice.toFixed(2),
          lowPrice: +lowPrice.toFixed(2),
          totalNetDeltaK: Math.round(totalNetDelta / 1000),
          totalNetDeltaPct: +((totalNetDelta / totalVol) * 100).toFixed(3),
          avgDailyVol: Math.round(totalVol / allDaily.length),
        },
        jsAlgorithm: jsResult,
        weeklySummary,
        monthlyPhases,
        deltaAnomalies,
        streaks,
        divergenceWindows,
        dailyData: dailyCompact,
      };
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results[ticker] = { error: err.message };
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done! ${TICKERS.length} tickers processed in ${elapsed}s`);

  // Save results
  const outputPath = '/Users/home/Antigravity/tradedata/analysis-vdf-full-year-results.json';
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`Results saved to ${outputPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Extract condensed analysis data from full-year results for LLM review.
 * Outputs weekly summary + key events per ticker in a readable format.
 */
"use strict";
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/Users/home/Antigravity/tradedata/analysis-vdf-full-year-results.json', 'utf8'));

const tickers = Object.keys(data);

for (const ticker of tickers) {
  const d = data[ticker];
  if (d.error) { console.log(`\n=== ${ticker}: ERROR — ${d.error} ===\n`); continue; }

  console.log(`\n${'#'.repeat(80)}`);
  console.log(`# ${ticker} — ${d.summary.dateRange}`);
  console.log(`# Price: $${d.summary.startPrice} → $${d.summary.endPrice} (${d.summary.priceChangePct}%)`);
  console.log(`# High: $${d.summary.highPrice}, Low: $${d.summary.lowPrice}`);
  console.log(`# Net Delta: ${d.summary.totalNetDeltaK}K (${d.summary.totalNetDeltaPct}%)`);
  console.log(`# Avg Daily Vol: ${(d.summary.avgDailyVol / 1e6).toFixed(1)}M`);
  console.log(`${'#'.repeat(80)}`);

  // JS Algorithm Results
  console.log(`\n--- JS ALGORITHM RESULTS ---`);
  console.log(`Zones: ${d.jsAlgorithm.zones.length}`);
  for (const z of d.jsAlgorithm.zones) {
    console.log(`  Z${z.rank}: ${z.startDate} → ${z.endDate} | ${z.windowDays}d | score=${z.score} | netΔ=${z.netDeltaPct}% | price=${z.overallPriceChange}% | absorption=${z.absorptionPct}% | concordant=${z.concordantFrac} | penalty=${z.concordancePenalty} | durMult=${z.durationMultiplier}`);
    if (z.components) {
      console.log(`    Components: s1=${z.components.s1_netDelta} s2=${z.components.s2_deltaSlope} s3=${z.components.s3_deltaShift} s4=${z.components.s4_accumRatio} s5=${z.components.s5_buyVsSell} s6=${z.components.s6_absorption} s7=${z.components.s7_volDecline} s8=${z.components.s8_divergence}`);
    }
  }
  console.log(`Distribution: ${d.jsAlgorithm.distribution.length}`);
  for (const dist of d.jsAlgorithm.distribution) {
    console.log(`  D: ${dist.startDate} → ${dist.endDate} | ${dist.spanDays}d | price=${dist.priceChangePct}% | netΔ=${dist.netDeltaPct}%`);
  }
  console.log(`Proximity: ${d.jsAlgorithm.proximity.compositeScore}pts (${d.jsAlgorithm.proximity.level})`);
  for (const sig of d.jsAlgorithm.proximity.signals) {
    console.log(`  ${sig.type}: +${sig.points}pts — ${sig.detail}`);
  }

  // Weekly Summary (compact)
  console.log(`\n--- WEEKLY SUMMARY ---`);
  console.log(`Week       | Days | Price%  | Delta     | Δ%     | CumΔ      | Abs | AvgVol    | Close`);
  for (const w of d.weeklySummary) {
    const dir = w.deltaPct > 0 ? '+' : '';
    console.log(`${w.weekStart} | ${w.days}    | ${w.priceChgPct >= 0 ? '+' : ''}${w.priceChgPct.toFixed(1).padStart(5)}% | ${(w.delta/1000).toFixed(0).padStart(7)}K | ${dir}${w.deltaPct.toFixed(2).padStart(5)}% | ${(w.cumDelta/1000).toFixed(0).padStart(7)}K | ${w.absorptionDays}   | ${(w.avgVol/1e6).toFixed(1).padStart(5)}M | $${w.closeEnd}`);
  }

  // Monthly Phases
  console.log(`\n--- PHASE ANALYSIS (20-day rolling) ---`);
  for (const p of d.monthlyPhases) {
    const marker = p.phase === 'DISTRIBUTION' ? '!!! ' :
                   p.phase === 'ACCUMULATION_IN_DECLINE' ? '*** ' :
                   p.phase === 'CONCORDANT_DECLINE' ? '--- ' :
                   p.phase === 'CONFIRMED_RALLY' ? '+++ ' :
                   p.phase === 'ABSORBING' ? '~~~ ' : '    ';
    console.log(`${marker}${p.startDate} → ${p.endDate} | ${p.phase.padEnd(24)} | price=${p.priceChgPct >= 0 ? '+' : ''}${p.priceChgPct}% | netΔ=${p.netDeltaPct >= 0 ? '+' : ''}${p.netDeltaPct}% | abs=${p.absorptionDays}`);
  }

  // Delta Anomalies
  if (d.deltaAnomalies.length > 0) {
    console.log(`\n--- DELTA ANOMALIES ---`);
    for (const a of d.deltaAnomalies) {
      console.log(`  ${a.date}: ${(a.delta/1000).toFixed(0)}K (${a.ratio}x avg) | price=${a.priceChgPct}% | $${a.close} | ${a.type}`);
    }
  }

  // Notable Streaks
  if (d.streaks.length > 0) {
    console.log(`\n--- NOTABLE STREAKS (4+ days) ---`);
    for (const s of d.streaks) {
      console.log(`  ${s.type.toUpperCase()} ${s.days}d: ${s.startDate} → ${s.endDate} | totalΔ=${(s.totalDelta/1000).toFixed(0)}K${s.intensifying ? ' (INTENSIFYING)' : ''}`);
    }
  }
}

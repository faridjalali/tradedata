#!/usr/bin/env node
/**
 * Re-run VDF algorithm on cached daily data (no API calls needed).
 * Uses daily data from the BEFORE results file, re-runs findAccumulationZones,
 * findDistributionClusters, and evaluateProximitySignals with updated algorithm.
 * Saves results in same format as analysis-vdf-full-year-results.json.
 */
'use strict';

const {
  findAccumulationZones,
  findDistributionClusters,
  evaluateProximitySignals,
  buildWeeks,
} = require('./server/services/vdfDetector');

const fs = require('fs');

const before = JSON.parse(fs.readFileSync('./analysis-vdf-full-year-results-BEFORE.json', 'utf8'));
const tickers = Object.keys(before);

const results = {};

for (const ticker of tickers) {
  const b = before[ticker];
  if (b.error) {
    results[ticker] = { error: b.error };
    continue;
  }

  // Reconstruct daily data in the format the algorithm expects
  const rawDaily = b.dailyData;
  const allDaily = rawDaily.map((d) => {
    const totalVol = d.vol || 0;
    const delta = d.delta || 0;
    // Reconstruct buyVol and sellVol from delta and totalVol
    // delta = buyVol - sellVol, totalVol = buyVol + sellVol
    // => buyVol = (totalVol + delta) / 2, sellVol = (totalVol - delta) / 2
    const buyVol = Math.max(0, (totalVol + delta) / 2);
    const sellVol = Math.max(0, (totalVol - delta) / 2);
    return {
      date: d.date,
      delta,
      totalVol,
      buyVol,
      sellVol,
      close: d.close,
      open: d.close * (1 - (d.priceChg || 0) / 100), // approximate open from priceChg
      high: d.close, // approximate (not used in scoring)
      low: d.close, // approximate (not used in scoring)
    };
  });

  if (allDaily.length < 40) {
    results[ticker] = { error: `Only ${allDaily.length} daily bars` };
    continue;
  }

  // Split: first 30 as pre-context, rest as scan period (same as original script)
  const PRE_DAYS = 30;
  const preDaily = allDaily.slice(0, PRE_DAYS);
  const scanDaily = allDaily.slice(PRE_DAYS);

  console.log(`${ticker}: ${allDaily.length} days, scan=${scanDaily.length}, pre=${preDaily.length}`);

  // Run algorithm
  const zones = findAccumulationZones(scanDaily, preDaily, 5);
  const distResult = findDistributionClusters(scanDaily);
  const distribution = distResult.distClusters || distResult || [];
  const proximity = zones.some((z) => z.score >= 0.5)
    ? evaluateProximitySignals(scanDaily, zones)
    : { compositeScore: 0, level: 'none', signals: [] };

  // Build output matching original format
  results[ticker] = {
    summary: b.summary,
    jsAlgorithm: {
      zones: zones.map((z, i) => ({
        rank: i + 1,
        startDate: z.startDate,
        endDate: z.endDate,
        windowDays: z.winSize,
        score: z.score,
        netDeltaPct: +(z.netDeltaPct || 0).toFixed(2),
        overallPriceChange: +(z.overallPriceChange || 0).toFixed(2),
        absorptionPct: +(z.absorptionPct || 0).toFixed(1),
        concordantFrac: +(z.concordantFrac || 0).toFixed(3),
        concordancePenalty: +(z.concordancePenalty || 1).toFixed(3),
        durationMultiplier: +(z.durationMultiplier || 1).toFixed(3),
        accumWeeks: z.accumWeeks || 'n/a',
        components: z.components
          ? {
              s1_netDelta: +(z.components.s1 || 0).toFixed(3),
              s2_deltaSlope: +(z.components.s2 || 0).toFixed(3),
              s3_deltaShift: +(z.components.s3 || 0).toFixed(3),
              s4_accumRatio: +(z.components.s4 || 0).toFixed(3),
              s5_buyVsSell: +(z.components.s5 || 0).toFixed(3),
              s6_absorption: +(z.components.s6 || 0).toFixed(3),
              s7_volDecline: +(z.components.s7 || 0).toFixed(3),
              s8_divergence: +(z.components.s8 || 0).toFixed(3),
            }
          : null,
      })),
      distribution: distribution.map((d) => ({
        startDate: d.startDate,
        endDate: d.endDate,
        spanDays: d.spanDays,
        priceChangePct: +(d.priceChangePct || 0).toFixed(2),
        netDeltaPct: +(d.netDeltaPct || 0).toFixed(2),
      })),
      proximity,
    },
    weeklySummary: b.weeklySummary,
    monthlyPhases: b.monthlyPhases,
    deltaAnomalies: b.deltaAnomalies,
    streaks: b.streaks,
    divergenceWindows: b.divergenceWindows,
    dailyData: rawDaily,
  };

  console.log(
    `  → ${zones.length} zones, best=${zones.length > 0 ? zones[0].score.toFixed(3) : 'none'}, prox=${proximity.compositeScore}(${proximity.level}), dist=${distribution.length}`,
  );
}

fs.writeFileSync('./analysis-vdf-full-year-results.json', JSON.stringify(results, null, 2));
console.log(`\nDone. Results saved to analysis-vdf-full-year-results.json`);

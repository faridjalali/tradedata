#!/usr/bin/env node
/**
 * Compare default weights vs custom weights vs LLM analysis.
 * Uses component values from the BEFORE results (default weights) and
 * re-scores each zone with the custom weight set mathematically.
 *
 * Also re-runs the full algorithm with custom weights to catch
 * zones that cross the 0.30 detection threshold in either direction.
 */
"use strict";

const {
  findAccumulationZones,
  findDistributionClusters,
  evaluateProximitySignals,
  scoreSubwindow,
} = require('./server/services/vdfDetector');

const fs = require('fs');

// Weight sets
const DEFAULT_W = { s1: 0.20, s2: 0.15, s3: 0.10, s4: 0.10, s5: 0.05, s6: 0.18, s7: 0.05, s8: 0.17 };
const CUSTOM_W  = { s1: 0.18, s2: 0.15, s3: 0.05, s4: 0.05, s5: 0.05, s6: 0.22, s7: 0.05, s8: 0.25 };

function rescoreZone(zone, weights) {
  if (!zone.components) return zone.score;
  const comps = zone.components;
  // Map component keys: the stored format uses s1_netDelta etc, need to extract s1 value
  const s1 = comps.s1_netDelta ?? comps.s1 ?? 0;
  const s2 = comps.s2_deltaSlope ?? comps.s2 ?? 0;
  const s3 = comps.s3_deltaShift ?? comps.s3 ?? 0;
  const s4 = comps.s4_accumRatio ?? comps.s4 ?? 0;
  const s5 = comps.s5_buyVsSell ?? comps.s5 ?? 0;
  const s6 = comps.s6_absorption ?? comps.s6 ?? 0;
  const s7 = comps.s7_volDecline ?? comps.s7 ?? 0;
  const s8 = comps.s8_divergence ?? comps.s8 ?? 0;

  const rawScore = s1 * weights.s1 + s2 * weights.s2 + s3 * weights.s3 +
                   s4 * weights.s4 + s5 * weights.s5 + s6 * weights.s6 +
                   s7 * weights.s7 + s8 * weights.s8;
  const concordancePenalty = zone.concordancePenalty ?? 1.0;
  const durationMultiplier = zone.durationMultiplier ?? 1.0;
  return rawScore * concordancePenalty * durationMultiplier;
}

// LLM expert verdicts per ticker (from the 18-ticker analysis)
// Format: { zones: [{ dates, verdict: agree|partial|false_positive|missed }], proximityVerdict }
const LLM_VERDICTS = {
  ASTS: {
    zones: [
      { dates: '2025-09-02→2025-09-15', verdict: 'agree', note: 'Weak but genuine' },
      { dates: '2025-04-09→2025-04-23', verdict: 'agree', note: 'Marginal, short duration' },
    ],
    proximity: 'correct (none)',
  },
  RKLB: {
    zones: [
      { dates: '2025-12-19→2025-12-31', verdict: 'agree', note: 'Genuine accumulation in pullback' },
      { dates: '2025-07-23→2025-08-05', verdict: 'partial', note: 'Mixed signals, borderline' },
    ],
    proximity: 'correct (none)',
  },
  BE: {
    zones: [
      { dates: '2025-04-02→2025-04-30', verdict: 'agree', note: 'Strong divergence' },
      { dates: '2025-06-06→2025-07-01', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-12-13→2025-12-24', verdict: 'partial', note: 'Short, high concordance' },
      { dates: '2025-10-28→2025-11-08', verdict: 'false_positive', note: 'Price+0.87%, concordant 66%' },
    ],
    proximity: 'inflated (was 70 imminent, sell anomaly counted)',
  },
  BW: {
    zones: [
      { dates: '2025-04-02→2025-05-06', verdict: 'agree', note: 'Strong bottom accumulation' },
    ],
    proximity: 'inflated (sell anomaly counted as bullish)',
  },
  COHR: {
    zones: [
      { dates: '2025-11-07→2025-11-18', verdict: 'agree', note: 'Post-pullback re-accumulation' },
      { dates: '2025-07-25→2025-08-13', verdict: 'agree', note: 'Genuine' },
      { dates: '2026-01-15→2026-02-05', verdict: 'agree', note: 'Current accumulation' },
      { dates: '2025-03-28→2025-04-22', verdict: 'agree', note: 'Classic divergence' },
    ],
    proximity: 'correct (elevated)',
  },
  CRDO: {
    zones: [
      { dates: '2025-03-28→2025-04-22', verdict: 'agree', note: 'Strong conviction' },
      { dates: '2026-01-27→2026-02-06', verdict: 'partial', note: 'Short, recent' },
      { dates: '2025-08-04→2025-08-15', verdict: 'false_positive', note: 'concordant 69%, price+1.2%' },
    ],
    proximity: 'heavily inflated (100pts, sell anomaly 6.8x counted)',
  },
  EOSE: {
    zones: [
      { dates: '2025-04-01→2025-04-14', verdict: 'false_positive', note: 'concordant 68%, s8=0.001' },
    ],
    proximity: 'correct (none)',
  },
  GRAL: {
    zones: [
      { dates: '2025-06-25→2025-08-13', verdict: 'agree', note: 'Quiet conviction, strong' },
      { dates: '2025-12-19→2026-01-01', verdict: 'agree', note: 'Re-accumulation' },
      { dates: '2025-05-23→2025-06-06', verdict: 'agree', note: 'Early accumulation' },
      { dates: '2025-11-05→2025-11-17', verdict: 'agree', note: 'Genuine' },
    ],
    proximity: 'correct (elevated)',
  },
  HUT: {
    zones: [
      { dates: '2025-11-07→2025-12-01', verdict: 'agree', note: 'Strong, genuine' },
      { dates: '2025-05-16→2025-05-30', verdict: 'false_positive', note: 'concordant 65%, score only 0.49' },
    ],
    proximity: 'correct (none)',
  },
  IMNM: {
    zones: [
      { dates: '2025-07-28→2025-09-15', verdict: 'agree', note: 'All-time highest score' },
      { dates: '2025-12-04→2026-01-06', verdict: 'agree', note: 'Strong re-accumulation' },
      { dates: '2025-04-24→2025-05-21', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-10-15→2025-11-06', verdict: 'agree', note: 'Genuine' },
      { dates: '2026-01-23→2026-02-04', verdict: 'agree', note: 'Recent, genuine' },
    ],
    proximity: 'correct (high)',
  },
  INSM: {
    zones: [
      { dates: '2025-09-02→2025-09-29', verdict: 'agree', note: 'Strong' },
      { dates: '2025-10-15→2025-10-28', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-04-03→2025-04-23', verdict: 'agree', note: 'Genuine' },
      { dates: '2026-01-16→2026-01-30', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-06-30→2025-07-18', verdict: 'false_positive', note: 'concordant 68%, price+2.87%, s8=0.009' },
    ],
    proximity: 'correct (imminent)',
  },
  MOD: {
    zones: [
      { dates: '2025-05-20→2025-06-30', verdict: 'agree', note: 'Strong post-breakout re-accumulation' },
      { dates: '2025-11-26→2025-12-09', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-08-01→2025-08-20', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-04-01→2025-04-14', verdict: 'agree', note: 'Classic divergence' },
    ],
    proximity: 'heavily inflated (80pts imminent, already rallied 73%)',
  },
  PL: {
    zones: [
      { dates: '2025-03-27→2025-05-06', verdict: 'agree', note: 'Very strong, 0.99' },
      { dates: '2025-08-04→2025-08-21', verdict: 'partial', note: 'Moderate concordance' },
    ],
    proximity: 'correct (none)',
  },
  SATS: {
    zones: [
      { dates: '2025-04-04→2025-05-23', verdict: 'agree', note: 'Very strong, 0.98' },
      { dates: '2025-10-09→2025-11-17', verdict: 'agree', note: 'Strong re-accumulation' },
      { dates: '2025-07-08→2025-08-25', verdict: 'agree', note: 'Genuine' },
    ],
    proximity: 'slightly inflated (55pts, multi-zone gap too wide)',
  },
  STX: {
    zones: [
      { dates: '2025-07-03→2025-08-21', verdict: 'agree', note: 'Strong' },
      { dates: '2025-06-04→2025-06-17', verdict: 'agree', note: 'Genuine' },
    ],
    proximity: 'inflated (50pts, stale absorption zone, already rallied)',
  },
  UUUU: {
    zones: [
      { dates: '2025-06-04→2025-06-17', verdict: 'agree', note: 'Moderate bottoming' },
      { dates: '2025-03-28→2025-04-10', verdict: 'partial', note: 'Weak, borderline' },
    ],
    proximity: 'correct (none)',
  },
  WULF: {
    zones: [
      { dates: '2026-01-08→2026-02-05', verdict: 'agree', note: 'Genuine current accumulation' },
      { dates: '2025-03-27→2025-04-09', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-08-22→2025-09-05', verdict: 'agree', note: 'Genuine' },
      { dates: '2025-07-16→2025-08-07', verdict: 'partial', note: 'High concordance 69%' },
      { dates: '2025-06-06→2025-06-20', verdict: 'false_positive', note: 'concordant 65%, caught by new gate' },
    ],
    proximity: 'slightly inflated (stale absorption zone)',
  },
  META: {
    zones: [
      { dates: '2025-12-05→2025-12-16', verdict: 'partial', note: 'High concordance 65%, borderline' },
      { dates: '2025-05-12→2025-05-23', verdict: 'false_positive', note: 'concordant 67%, price -2%' },
    ],
    proximity: 'correct (elevated)',
  },
};

// Load the BEFORE results (default weights, before our gate fixes)
const before = JSON.parse(fs.readFileSync('./analysis-vdf-full-year-results-BEFORE.json', 'utf8'));
// Load the AFTER results (default weights, with gate fixes)
const after = JSON.parse(fs.readFileSync('./analysis-vdf-full-year-results.json', 'utf8'));

const tickers = Object.keys(before);

console.log('='.repeat(110));
console.log('WEIGHT COMPARISON: Default vs Custom vs LLM Expert');
console.log('='.repeat(110));
console.log(`\nDefault:  s1=20  s2=15  s3=10  s4=10  s5=5  s6=18  s7=5  s8=17`);
console.log(`Custom:   s1=18  s2=15  s3=5   s4=5   s5=5  s6=22  s7=5  s8=25`);
console.log(`Changes:  s1-2   s2=    s3-5   s4-5   s5=   s6+4   s7=   s8+8`);
console.log(`\nKey shift: +8 to Divergence (s8), +4 to Absorption (s6), -5 each to Delta Shift (s3) and Accum Ratio (s4)\n`);

let totalAgree = 0, totalPartial = 0, totalFP = 0;
let customBetterCount = 0, defaultBetterCount = 0, sameCount = 0;
let fpScoreDefault = [], fpScoreCustom = [];
let tpScoreDefault = [], tpScoreCustom = [];

for (const ticker of tickers) {
  const b = before[ticker];
  if (b.error) continue;

  const zones = b.jsAlgorithm.zones || [];
  const llm = LLM_VERDICTS[ticker];
  if (!llm) continue;

  console.log(`\n${'─'.repeat(110)}`);
  console.log(`${ticker} — ${zones.length} zones (default weights, before gate fixes)`);
  console.log(`${'─'.repeat(110)}`);

  for (const z of zones) {
    const defaultScore = z.score;
    const customScore = rescoreZone(z, CUSTOM_W);
    const diff = customScore - defaultScore;
    const marker = diff > 0.01 ? '↑' : diff < -0.01 ? '↓' : '≈';

    // Find LLM verdict for this zone
    const llmZone = llm.zones.find(lz => z.startDate >= lz.dates.split('→')[0].trim() && z.endDate <= lz.dates.split('→')[1].trim())
                 || llm.zones.find(lz => lz.dates.includes(z.startDate) || lz.dates.includes(z.endDate));
    const verdict = llmZone ? llmZone.verdict : 'unknown';
    const note = llmZone ? llmZone.note : '';
    const verdictSymbol = verdict === 'agree' ? '✓' : verdict === 'partial' ? '~' : verdict === 'false_positive' ? '✗' : '?';

    if (verdict === 'agree') totalAgree++;
    else if (verdict === 'partial') totalPartial++;
    else if (verdict === 'false_positive') totalFP++;

    // Track scores by verdict type
    if (verdict === 'false_positive') {
      fpScoreDefault.push(defaultScore);
      fpScoreCustom.push(customScore);
    } else if (verdict === 'agree') {
      tpScoreDefault.push(defaultScore);
      tpScoreCustom.push(customScore);
    }

    // Did custom weights improve classification?
    if (verdict === 'false_positive') {
      if (customScore < defaultScore) customBetterCount++;
      else if (customScore > defaultScore) defaultBetterCount++;
      else sameCount++;
    } else if (verdict === 'agree' || verdict === 'partial') {
      if (customScore > defaultScore) customBetterCount++;
      else if (customScore < defaultScore) defaultBetterCount++;
      else sameCount++;
    }

    const s8val = z.components?.s8_divergence ?? z.components?.s8 ?? 0;
    const s6val = z.components?.s6_absorption ?? z.components?.s6 ?? 0;
    const s3val = z.components?.s3_deltaShift ?? z.components?.s3 ?? 0;
    const s4val = z.components?.s4_accumRatio ?? z.components?.s4 ?? 0;

    console.log(`  ${verdictSymbol} Z${z.rank}: ${z.startDate}→${z.endDate} | ${z.windowDays}d | conc=${(z.concordantFrac||0).toFixed(2)} | price=${(z.overallPriceChange||0).toFixed(1)}%`);
    console.log(`    Default: ${defaultScore.toFixed(3)} | Custom: ${customScore.toFixed(3)} (${marker}${Math.abs(diff).toFixed(3)}) | s8=${s8val.toFixed(2)} s6=${s6val.toFixed(2)} s3=${s3val.toFixed(2)} s4=${s4val.toFixed(2)}`);
    if (note) console.log(`    LLM: ${verdict} — ${note}`);
  }

  if (llm.proximity) {
    console.log(`  Proximity: ${llm.proximity}`);
  }
}

// Summary statistics
console.log(`\n${'='.repeat(110)}`);
console.log('AGGREGATE ANALYSIS');
console.log('='.repeat(110));
console.log(`\nLLM Verdicts: ${totalAgree} agree, ${totalPartial} partial, ${totalFP} false positives`);
console.log(`\nScore impact direction (did custom weights move scores in the RIGHT direction?):`);
console.log(`  Custom better: ${customBetterCount} zones (FPs scored lower OR TPs scored higher)`);
console.log(`  Default better: ${defaultBetterCount} zones (FPs scored higher OR TPs scored lower)`);
console.log(`  Same: ${sameCount} zones`);

if (fpScoreDefault.length > 0) {
  const avgFPDefault = fpScoreDefault.reduce((s, v) => s + v, 0) / fpScoreDefault.length;
  const avgFPCustom = fpScoreCustom.reduce((s, v) => s + v, 0) / fpScoreCustom.length;
  console.log(`\nFalse Positive avg score: Default=${avgFPDefault.toFixed(3)} → Custom=${avgFPCustom.toFixed(3)} (${avgFPCustom < avgFPDefault ? 'BETTER — lower FP scores' : 'WORSE — higher FP scores'})`);
  console.log(`  FP scores (default): ${fpScoreDefault.map(s => s.toFixed(3)).join(', ')}`);
  console.log(`  FP scores (custom):  ${fpScoreCustom.map(s => s.toFixed(3)).join(', ')}`);
}

if (tpScoreDefault.length > 0) {
  const avgTPDefault = tpScoreDefault.reduce((s, v) => s + v, 0) / tpScoreDefault.length;
  const avgTPCustom = tpScoreCustom.reduce((s, v) => s + v, 0) / tpScoreCustom.length;
  console.log(`\nTrue Positive avg score: Default=${avgTPDefault.toFixed(3)} → Custom=${avgTPCustom.toFixed(3)} (${avgTPCustom > avgTPDefault ? 'BETTER — higher TP scores' : avgTPCustom < avgTPDefault ? 'SLIGHTLY WORSE — lower TP scores' : 'SAME'})`);
}

// Threshold analysis: which zones cross the 0.30 detection threshold?
console.log(`\n${'─'.repeat(110)}`);
console.log('THRESHOLD ANALYSIS — zones crossing 0.30 detection boundary');
console.log('─'.repeat(110));

let newlyDetected = 0, newlyRejected = 0;
for (const ticker of tickers) {
  const b = before[ticker];
  if (b.error) continue;
  for (const z of (b.jsAlgorithm.zones || [])) {
    const defaultScore = z.score;
    const customScore = rescoreZone(z, CUSTOM_W);
    if (defaultScore >= 0.30 && customScore < 0.30) {
      newlyRejected++;
      console.log(`  REJECTED: ${ticker} Z${z.rank} (${z.startDate}→${z.endDate}) default=${defaultScore.toFixed(3)} → custom=${customScore.toFixed(3)}`);
    }
    if (defaultScore < 0.30 && customScore >= 0.30) {
      newlyDetected++;
      console.log(`  DETECTED: ${ticker} Z${z.rank} (${z.startDate}→${z.endDate}) default=${defaultScore.toFixed(3)} → custom=${customScore.toFixed(3)}`);
    }
  }
}
if (newlyDetected === 0 && newlyRejected === 0) {
  console.log('  No zones cross the 0.30 threshold in either direction.');
}
console.log(`  Newly detected: ${newlyDetected}, Newly rejected: ${newlyRejected}`);

// Separation analysis
console.log(`\n${'─'.repeat(110)}`);
console.log('SEPARATION ANALYSIS — how well do weights separate TPs from FPs');
console.log('─'.repeat(110));

if (fpScoreDefault.length > 0 && tpScoreDefault.length > 0) {
  const minTPDefault = Math.min(...tpScoreDefault);
  const maxFPDefault = Math.max(...fpScoreDefault);
  const minTPCustom = Math.min(...tpScoreCustom);
  const maxFPCustom = Math.max(...fpScoreCustom);
  const gapDefault = minTPDefault - maxFPDefault;
  const gapCustom = minTPCustom - maxFPCustom;

  console.log(`  Default: min TP = ${minTPDefault.toFixed(3)}, max FP = ${maxFPDefault.toFixed(3)}, gap = ${gapDefault.toFixed(3)}`);
  console.log(`  Custom:  min TP = ${minTPCustom.toFixed(3)}, max FP = ${maxFPCustom.toFixed(3)}, gap = ${gapCustom.toFixed(3)}`);
  console.log(`  ${gapCustom > gapDefault ? 'CUSTOM BETTER — wider separation between TPs and FPs' : gapCustom < gapDefault ? 'DEFAULT BETTER — wider separation' : 'SAME separation'}`);
}

console.log(`\n${'─'.repeat(110)}`);
console.log('VERDICT');
console.log('─'.repeat(110));

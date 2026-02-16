#!/usr/bin/env node
/**
 * Compare BEFORE and AFTER algorithm improvements.
 * Reads the old results (pre-fix) and new results (post-fix) and shows:
 * - Zones added/removed per ticker
 * - Proximity score changes
 * - False positives eliminated
 * - True positives preserved
 */
"use strict";
const fs = require('fs');

const before = JSON.parse(fs.readFileSync('/Users/home/Antigravity/tradedata/analysis-vdf-full-year-results-BEFORE.json', 'utf8'));
const after = JSON.parse(fs.readFileSync('/Users/home/Antigravity/tradedata/analysis-vdf-full-year-results.json', 'utf8'));

const tickers = Object.keys(before);

console.log('='.repeat(100));
console.log('VDF ALGORITHM IMPROVEMENT COMPARISON — BEFORE vs AFTER');
console.log('='.repeat(100));
console.log(`\nFixes applied:`);
console.log(`  1. Concordant hard gate: 0.70 → 0.65`);
console.log(`  2. Combined gate: price > 0% AND concordantFrac > 0.60 → reject`);
console.log(`  3. Divergence floor: s8 < 0.05 AND concordantFrac > 0.55 → reject`);
console.log(`  4. Delta anomaly: only POSITIVE anomalies count for proximity`);
console.log(`  5. Extreme absorption: 90-day recency gate`);
console.log(`  6. Rally suppression: cap proximity at 40pts if stock rallied >20% in 20d`);
console.log('');

let totalZonesBefore = 0, totalZonesAfter = 0;
let zonesRemoved = 0, zonesAdded = 0;
let proxChanges = [];
let removedZones = [];
let preservedZones = [];
let newZones = [];

for (const ticker of tickers) {
  const b = before[ticker];
  const a = after[ticker];
  if (b.error || a.error) continue;

  const bZones = b.jsAlgorithm.zones || [];
  const aZones = a.jsAlgorithm.zones || [];
  totalZonesBefore += bZones.length;
  totalZonesAfter += aZones.length;

  const bProx = b.jsAlgorithm.proximity;
  const aProx = a.jsAlgorithm.proximity;

  // Track zone changes
  // Match zones by overlapping date ranges
  const bZoneSet = new Set();
  const aZoneSet = new Set();

  for (const bz of bZones) {
    let matched = false;
    for (const az of aZones) {
      // Check overlap
      if (bz.startDate <= az.endDate && az.startDate <= bz.endDate) {
        matched = true;
        bZoneSet.add(bz.startDate + '|' + bz.endDate);
        aZoneSet.add(az.startDate + '|' + az.endDate);
        preservedZones.push({
          ticker,
          before: bz,
          after: az,
        });
        break;
      }
    }
    if (!matched) {
      zonesRemoved++;
      removedZones.push({ ticker, zone: bz });
    }
  }

  for (const az of aZones) {
    let matched = false;
    for (const bz of bZones) {
      if (bz.startDate <= az.endDate && az.startDate <= bz.endDate) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      zonesAdded++;
      newZones.push({ ticker, zone: az });
    }
  }

  // Track proximity changes
  if (bProx.compositeScore !== aProx.compositeScore || bProx.level !== aProx.level) {
    proxChanges.push({
      ticker,
      before: bProx,
      after: aProx,
    });
  }
}

// Summary
console.log('─'.repeat(100));
console.log('SUMMARY');
console.log('─'.repeat(100));
console.log(`Total zones BEFORE: ${totalZonesBefore}`);
console.log(`Total zones AFTER:  ${totalZonesAfter}`);
console.log(`Zones REMOVED (false positives eliminated): ${zonesRemoved}`);
console.log(`Zones ADDED (new detections): ${zonesAdded}`);
console.log(`Zones PRESERVED (matched by date overlap): ${preservedZones.length}`);
console.log(`Proximity score changes: ${proxChanges.length} tickers affected`);

// Removed zones detail
if (removedZones.length > 0) {
  console.log(`\n${'─'.repeat(100)}`);
  console.log('ZONES REMOVED (False Positives Eliminated)');
  console.log('─'.repeat(100));
  for (const r of removedZones) {
    const z = r.zone;
    console.log(`  ${r.ticker} Z${z.rank}: ${z.startDate} → ${z.endDate} | ${z.windowDays}d | score=${z.score} | concordant=${z.concordantFrac} | price=${z.overallPriceChange}% | s8=${z.components?.s8_divergence || 'n/a'}`);
  }
}

// New zones detail
if (newZones.length > 0) {
  console.log(`\n${'─'.repeat(100)}`);
  console.log('ZONES ADDED (New Detections)');
  console.log('─'.repeat(100));
  for (const n of newZones) {
    const z = n.zone;
    console.log(`  ${n.ticker} Z${z.rank}: ${z.startDate} → ${z.endDate} | ${z.windowDays}d | score=${z.score} | concordant=${z.concordantFrac} | price=${z.overallPriceChange}% | s8=${z.components?.s8_divergence || 'n/a'}`);
  }
}

// Preserved zones with score changes
console.log(`\n${'─'.repeat(100)}`);
console.log('PRESERVED ZONES — Score Changes');
console.log('─'.repeat(100));
for (const p of preservedZones) {
  const b = p.before;
  const a = p.after;
  const scoreDiff = (a.score - b.score).toFixed(3);
  const marker = scoreDiff > 0 ? '↑' : scoreDiff < 0 ? '↓' : '=';
  console.log(`  ${p.ticker} Z${b.rank}→Z${a.rank}: ${b.startDate}→${b.endDate} | score ${b.score} → ${a.score} (${marker}${scoreDiff}) | concordant=${b.concordantFrac}→${a.concordantFrac}`);
}

// Proximity changes
if (proxChanges.length > 0) {
  console.log(`\n${'─'.repeat(100)}`);
  console.log('PROXIMITY SCORE CHANGES');
  console.log('─'.repeat(100));
  for (const p of proxChanges) {
    const diff = p.after.compositeScore - p.before.compositeScore;
    const marker = diff > 0 ? '↑' : diff < 0 ? '↓' : '=';
    console.log(`  ${p.ticker}: ${p.before.compositeScore}pts (${p.before.level}) → ${p.after.compositeScore}pts (${p.after.level}) [${marker}${diff}pts]`);

    // Show signal differences
    const bSignals = new Set(p.before.signals.map(s => s.type));
    const aSignals = new Set(p.after.signals.map(s => s.type));
    for (const s of p.before.signals) {
      if (!aSignals.has(s.type)) {
        console.log(`    REMOVED: ${s.type} (${s.points}pts) — ${s.detail}`);
      }
    }
    for (const s of p.after.signals) {
      if (!bSignals.has(s.type)) {
        console.log(`    ADDED: ${s.type} (${s.points}pts) — ${s.detail}`);
      }
    }
    // Show signals with different point values
    for (const bs of p.before.signals) {
      const as = p.after.signals.find(s => s.type === bs.type);
      if (as && as.points !== bs.points) {
        console.log(`    CHANGED: ${bs.type} ${bs.points}pts → ${as.points}pts`);
      }
    }
  }
}

// Per-ticker summary table
console.log(`\n${'─'.repeat(100)}`);
console.log('PER-TICKER SUMMARY');
console.log('─'.repeat(100));
console.log('Ticker  | Zones B→A | Best Score B→A   | Prox B→A         | Dist B→A');
console.log('--------|-----------|------------------|------------------|----------');
for (const ticker of tickers) {
  const b = before[ticker];
  const a = after[ticker];
  if (b.error || a.error) { console.log(`${ticker.padEnd(8)}| ERROR`); continue; }

  const bz = b.jsAlgorithm.zones.length;
  const az = a.jsAlgorithm.zones.length;
  const bBest = bz > 0 ? Math.max(...b.jsAlgorithm.zones.map(z => z.score)).toFixed(2) : '—';
  const aBest = az > 0 ? Math.max(...a.jsAlgorithm.zones.map(z => z.score)).toFixed(2) : '—';
  const bProx = `${b.jsAlgorithm.proximity.compositeScore}(${b.jsAlgorithm.proximity.level.slice(0,4)})`;
  const aProx = `${a.jsAlgorithm.proximity.compositeScore}(${a.jsAlgorithm.proximity.level.slice(0,4)})`;
  const bDist = b.jsAlgorithm.distribution.length;
  const aDist = a.jsAlgorithm.distribution.length;

  console.log(`${ticker.padEnd(8)}| ${bz} → ${az}`.padEnd(20) + `| ${bBest} → ${aBest}`.padEnd(19) + `| ${bProx} → ${aProx}`.padEnd(19) + `| ${bDist} → ${aDist}`);
}

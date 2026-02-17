#!/usr/bin/env node
/**
 * Synthetic HTF Detector Test
 * ===========================
 * Generates fake bar data that mimics a textbook High-Tight Flag pattern:
 *   Phase 1 (170 days): Quiet base at $10 with moderate volatility
 *   Phase 2 (20 days):  Impulse run from $10 → $20 (100% gain)
 *   Phase 3 (10 days):  Tight consolidation near $19.50, ranges decaying aggressively
 *
 * Feeds the data through detectHTF() with a mock fetcher and verifies
 * that is_detected === true with composite_score >= 0.70.
 */

'use strict';

const { detectHTF, HTF_CONFIG } = require('./server/services/htfDetector');

// ─── Constants ──────────────────────────────────────────────────────────────
const BASE_TIME = 1704067200; // 2024-01-01 00:00 UTC
const DAY_S = 86400;
const BARS_15M_PER_DAY = 26;
const BARS_1M_PER_DAY = 390;

// Timeline (trading-day indices)
const TOTAL_DAYS = 200;
const IMPULSE_START = 170;
const IMPULSE_END = 189; // 20-day impulse
const CONSOL_START = 190;
const CONSOL_END = 199; // 10-day consolidation

const START_PRICE = 10.0;
const END_PRICE = 20.0;
const CONSOL_CENTER = 19.5;

// ─── Helpers ────────────────────────────────────────────────────────────────

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ─── Bar Generators ─────────────────────────────────────────────────────────

function generateDailyBars() {
  const rand = seededRandom(42);
  const bars = [];

  for (let d = 0; d < TOTAL_DAYS; d++) {
    const time = BASE_TIME + d * DAY_S;

    if (d < IMPULSE_START) {
      // Phase 1: base at $10 with moderate noise
      const noise = (rand() - 0.5) * 0.4;
      bars.push({
        time,
        open: START_PRICE + noise * 0.3,
        high: START_PRICE + Math.abs(noise) + 0.15,
        low: START_PRICE - Math.abs(noise) - 0.15,
        close: START_PRICE + noise * 0.2,
        volume: 400000 + Math.floor(rand() * 200000),
      });
    } else if (d <= IMPULSE_END) {
      // Phase 2: linear ramp, wide ranges, high volume
      const progress = (d - IMPULSE_START) / (IMPULSE_END - IMPULSE_START);
      const base = START_PRICE + (END_PRICE - START_PRICE) * progress;
      const step = (END_PRICE - START_PRICE) / (IMPULSE_END - IMPULSE_START);
      bars.push({
        time,
        open: base - step * 0.15,
        high: base + step * 0.6,
        low: base - step * 0.3,
        close: base + step * 0.25,
        volume: 2000000 + Math.floor(rand() * 1000000),
      });
    } else {
      // Phase 3: tight consolidation with decaying range
      const daysSinceConsol = d - CONSOL_START;
      const decay = Math.exp(-daysSinceConsol * 0.25);
      const halfRange = CONSOL_CENTER * 0.004 * (1 + decay * 4);
      const tinyDrift = (rand() - 0.5) * halfRange * 0.2;
      const bullish = d % 2 === 0;
      bars.push({
        time,
        open: CONSOL_CENTER + (bullish ? -halfRange * 0.1 : halfRange * 0.1) + tinyDrift,
        high: CONSOL_CENTER + halfRange * 0.5 + Math.abs(tinyDrift),
        low: CONSOL_CENTER - halfRange * 0.5 - Math.abs(tinyDrift),
        close: CONSOL_CENTER + (bullish ? halfRange * 0.1 : -halfRange * 0.1) + tinyDrift * 0.5,
        volume: Math.max(3000, Math.floor(80000 * decay + 3000)),
      });
    }
  }
  return bars;
}

function generate15mBars() {
  const rand = seededRandom(123);
  const bars = [];

  for (let d = 0; d < TOTAL_DAYS; d++) {
    const dayBase = BASE_TIME + d * DAY_S;

    for (let b = 0; b < BARS_15M_PER_DAY; b++) {
      const time = dayBase + b * 900;

      if (d < IMPULSE_START) {
        // Phase 1: moderate vol bars at $10
        const noise = (rand() - 0.5) * 0.3;
        const mid = START_PRICE + noise * 0.5;
        const range = 0.08 + rand() * 0.12; // ~1–2% range
        bars.push({
          time,
          open: mid - range * 0.2,
          high: mid + range * 0.5,
          low: mid - range * 0.5,
          close: mid + range * 0.15,
          volume: 15000 + Math.floor(rand() * 10000),
        });
      } else if (d <= IMPULSE_END) {
        // Phase 2: wide ranges, trending up, high volume
        const dayProgress = (d - IMPULSE_START) / (IMPULSE_END - IMPULSE_START);
        const barProgress = b / BARS_15M_PER_DAY;
        const overallProgress = dayProgress + barProgress / (IMPULSE_END - IMPULSE_START);
        const base = START_PRICE + (END_PRICE - START_PRICE) * Math.min(1, overallProgress);
        const range = 0.25 + rand() * 0.35;
        bars.push({
          time,
          open: base - range * 0.3,
          high: base + range * 0.7,
          low: base - range * 0.5,
          close: base + range * 0.4, // close > open for bullish delta
          volume: 60000 + Math.floor(rand() * 40000),
        });
      } else {
        // Phase 3: aggressively decaying ranges + price convergence
        const daysSinceConsol = d - CONSOL_START;
        const barIdx = daysSinceConsol * BARS_15M_PER_DAY + b;
        const totalConsolBars = (CONSOL_END - CONSOL_START + 1) * BARS_15M_PER_DAY;
        const progress = barIdx / totalConsolBars; // 0→1

        // Range: steep exponential decay (target slope ≈ -0.025 in log space)
        const pctRange = 0.025 * Math.exp(-0.025 * barIdx);
        const range = Math.max(0.003, CONSOL_CENTER * pctRange);

        // Price oscillation: large early, converging to center late
        // Sine wave with amplitude that decays from ±$0.35 to ±$0.01
        const oscillationAmp = 0.35 * Math.exp(-barIdx * 0.015);
        const oscillation = oscillationAmp * Math.sin(barIdx * 0.25);
        const mid = CONSOL_CENTER + oscillation;

        const tinyNoise = (rand() - 0.5) * range * 0.15;
        const bullish = barIdx % 2 === 0;
        const openShift = bullish ? -range * 0.15 : range * 0.15;
        const closeShift = bullish ? range * 0.15 : -range * 0.15;

        bars.push({
          time,
          open: mid + openShift + tinyNoise,
          high: mid + range * 0.5 + Math.abs(tinyNoise),
          low: mid - range * 0.5 - Math.abs(tinyNoise),
          close: mid + closeShift + tinyNoise * 0.5,
          volume: Math.max(300, Math.floor(10000 * Math.exp(-barIdx * 0.012) + 300)),
        });
      }
    }
  }
  return bars;
}

function generate1mBars() {
  const rand = seededRandom(456);
  const bars = [];

  // Return 30 days: last 20 days of impulse + 10 days consolidation
  const startDay = IMPULSE_START; // day 170
  const endDay = CONSOL_END; // day 199

  for (let d = startDay; d <= endDay; d++) {
    const dayBase = BASE_TIME + d * DAY_S;

    for (let b = 0; b < BARS_1M_PER_DAY; b++) {
      const time = dayBase + b * 60;

      if (d <= IMPULSE_END) {
        // Impulse: high vol, directional (close > open for positive delta)
        const dayProgress = (d - IMPULSE_START) / (IMPULSE_END - IMPULSE_START);
        const barProgress = b / BARS_1M_PER_DAY;
        const overallProgress = dayProgress + barProgress / (IMPULSE_END - IMPULSE_START);
        const base = START_PRICE + (END_PRICE - START_PRICE) * Math.min(1, overallProgress);
        const move = 0.02 + rand() * 0.04;
        bars.push({
          time,
          open: base,
          high: base + move * 1.2,
          low: base - move * 0.3,
          close: base + move * 0.8, // always bullish
          volume: 4000 + Math.floor(rand() * 3000),
        });
      } else {
        // Consolidation: ultra-low vol, alternating direction, tiny moves
        const daysSinceConsol = d - CONSOL_START;
        const barIdxConsol = daysSinceConsol * BARS_1M_PER_DAY + b;
        const decay = Math.exp(-daysSinceConsol * 0.15);
        const vol = Math.max(20, Math.floor(800 * decay + 20));
        const move = 0.001 + rand() * 0.002;
        const bullish = b % 2 === 0;
        bars.push({
          time,
          open: CONSOL_CENTER,
          high: CONSOL_CENTER + move,
          low: CONSOL_CENTER - move,
          close: CONSOL_CENTER + (bullish ? move * 0.3 : -move * 0.3),
          volume: vol,
        });
      }
    }
  }
  return bars;
}

// ─── Mock Data Fetcher ──────────────────────────────────────────────────────

const cachedDaily = generateDailyBars();
const cached15m = generate15mBars();
const cached1m = generate1mBars();

async function mockDataApiFetcher(ticker, interval /*, lookbackDays, opts */) {
  if (interval === '1day') return cachedDaily;
  if (interval === '15min') return cached15m;
  if (interval === '1min') return cached1m;
  return [];
}

// ─── Run Test ───────────────────────────────────────────────────────────────

(async function main() {
  console.log('=== HTF Detector Synthetic Data Test ===\n');
  console.log(`Config composite_threshold: ${HTF_CONFIG.composite_threshold}`);
  console.log(`Timeline: ${TOTAL_DAYS} trading days`);
  console.log(`  Pre-impulse:   days 0–${IMPULSE_START - 1} ($${START_PRICE})`);
  console.log(
    `  Impulse:       days ${IMPULSE_START}–${IMPULSE_END} ($${START_PRICE}→$${END_PRICE}, ${(((END_PRICE - START_PRICE) / START_PRICE) * 100).toFixed(0)}% gain)`,
  );
  console.log(`  Consolidation: days ${CONSOL_START}–${CONSOL_END} (~$${CONSOL_CENTER})\n`);
  console.log(`Bar counts: daily=${cachedDaily.length}, 15m=${cached15m.length}, 1m=${cached1m.length}\n`);

  const result = await detectHTF('SYNTH', {
    dataApiFetcher: mockDataApiFetcher,
    signal: null,
  });

  console.log('─── RESULT ───');
  console.log(`  is_detected:     ${result.is_detected}`);
  console.log(`  is_candidate:    ${result.is_candidate}`);
  console.log(`  composite_score: ${result.composite_score?.toFixed(4) ?? 'null'}`);
  console.log(`  status:          ${result.status}`);
  console.log(`  impulse_gain_pct: ${result.impulse_gain_pct?.toFixed(2) ?? 'null'}%`);

  if (result.impulse) {
    console.log(
      `  impulse:         $${result.impulse.start_price?.toFixed(2)} → $${result.impulse.end_price?.toFixed(2)}`,
    );
  }

  console.log(`  consolidation_bars: ${result.consolidation_bars}`);
  console.log(`  flag_retrace_pct:   ${result.flag_retrace_pct?.toFixed(2) ?? 'null'}%`);
  console.log(`  yz_percentile:      ${result.yz_percentile?.toFixed(2) ?? 'null'}`);

  if (result.delta_metrics) {
    console.log(`  delta_compression:  ${result.delta_metrics.compression_score?.toFixed(4)}`);
    console.log(`    mean_pctrank: ${result.delta_metrics.delta_mean_pctrank?.toFixed(2)}`);
    console.log(`    std_pctrank:  ${result.delta_metrics.delta_std_pctrank?.toFixed(2)}`);
  }

  if (result.range_decay) {
    console.log(`  range_decay:`);
    console.log(`    decay_coefficient: ${result.range_decay.decay_coefficient?.toFixed(6)}`);
    console.log(`    r_squared:         ${result.range_decay.r_squared?.toFixed(4)}`);
    console.log(`    is_decaying:       ${result.range_decay.is_decaying}`);
  }

  if (result.vwap_deviation) {
    console.log(`  vwap_deviation:`);
    console.log(`    pctrank:      ${result.vwap_deviation.current_deviation_pctrank?.toFixed(2)}`);
    console.log(`    is_collapsed: ${result.vwap_deviation.is_collapsed}`);
  }

  if (result.composite) {
    console.log(`  component scores:`);
    console.log(`    yz_score:    ${result.composite.yz_score?.toFixed(4)} (weight ${HTF_CONFIG.weight_yz})`);
    console.log(`    delta_score: ${result.composite.delta_score?.toFixed(4)} (weight ${HTF_CONFIG.weight_delta})`);
    console.log(
      `    decay_score: ${result.composite.decay_score?.toFixed(4)} (weight ${HTF_CONFIG.weight_range_decay})`,
    );
    console.log(`    vwap_score:  ${result.composite.vwap_score?.toFixed(4)} (weight ${HTF_CONFIG.weight_vwap})`);
    console.log(
      `    → composite: ${result.composite.composite_score?.toFixed(4)} (threshold ${HTF_CONFIG.composite_threshold})`,
    );
  }

  if (result.breakout) {
    console.log(`  breakout:`);
    console.log(`    detected: ${result.breakout.breakout_detected}`);
  }

  console.log('\n─── VERDICT ───');
  if (result.is_detected) {
    console.log('PASS — HTF pattern detected as expected');
  } else {
    console.log('FAIL — HTF pattern NOT detected');
    console.log(`   Status: ${result.status}`);
    if (result.composite) {
      console.log(
        `   Composite ${result.composite.composite_score?.toFixed(4)} < threshold ${HTF_CONFIG.composite_threshold}`,
      );
      const scores = [
        { name: 'yz', score: result.composite.yz_score, weight: HTF_CONFIG.weight_yz },
        { name: 'delta', score: result.composite.delta_score, weight: HTF_CONFIG.weight_delta },
        { name: 'decay', score: result.composite.decay_score, weight: HTF_CONFIG.weight_range_decay },
        { name: 'vwap', score: result.composite.vwap_score, weight: HTF_CONFIG.weight_vwap },
      ];
      const sorted = scores.sort((a, b) => a.score - b.score);
      console.log('   Weakest metrics:');
      for (const s of sorted) {
        console.log(`     ${s.name}: ${s.score?.toFixed(4)} × ${s.weight} = ${(s.score * s.weight)?.toFixed(4)}`);
      }
    }
  }

  process.exit(result.is_detected ? 0 : 1);
})();

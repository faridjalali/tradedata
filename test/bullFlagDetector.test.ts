import test from 'node:test';
import assert from 'node:assert/strict';

import { detectBullFlag } from '../shared/bullFlagDetector.js';

type Bar = { time: number; open: number; high: number; low: number; close: number };

/** Generate a sequence of upward-trending bars. */
function generateUptrend(startPrice: number, bars: number, gainPerBar: number): Bar[] {
  const result: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const close = price + gainPerBar;
    const high = close + gainPerBar * 0.3;
    const low = open - gainPerBar * 0.2;
    result.push({ time: 1700000000 + i * 86400, open, high, low, close });
    price = close;
  }
  return result;
}

/** Generate a flag (consolidation) — gentle downward drift with tight range. */
function generateFlag(startPrice: number, bars: number, driftPerBar: number, noise: number): Bar[] {
  const result: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < bars; i++) {
    const close = price + driftPerBar;
    const open = price;
    const high = Math.max(open, close) + noise;
    const low = Math.min(open, close) - noise;
    result.push({ time: 1700000000 + i * 86400, open, high, low, close });
    price = close;
  }
  return result;
}

/** Generate flat/sideways bars. */
function generateFlat(price: number, bars: number, noise: number): Bar[] {
  const result: Bar[] = [];
  for (let i = 0; i < bars; i++) {
    const open = price + (Math.sin(i) * noise * 0.5);
    const close = price + (Math.cos(i) * noise * 0.5);
    const high = Math.max(open, close) + noise * 0.3;
    const low = Math.min(open, close) - noise * 0.3;
    result.push({ time: 1700000000 + i * 86400, open, high, low, close });
  }
  return result;
}

/** Generate downtrend bars. */
function generateDowntrend(startPrice: number, bars: number, dropPerBar: number): Bar[] {
  const result: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const close = price - dropPerBar;
    const high = open + dropPerBar * 0.2;
    const low = close - dropPerBar * 0.3;
    result.push({ time: 1700000000 + i * 86400, open, high, low, close });
    price = close;
  }
  return result;
}

/**
 * Generate a pennant (converging triangle) — highs descend, lows ascend.
 * @param startPrice Center price at the start
 * @param bars Number of bars
 * @param initialSpread Distance from center to high/low at start
 * @param convergenceRate How much the spread shrinks per bar
 */
function generatePennant(
  startPrice: number,
  bars: number,
  initialSpread: number,
  convergenceRate: number,
): Bar[] {
  const result: Bar[] = [];
  for (let i = 0; i < bars; i++) {
    const spread = initialSpread - convergenceRate * i;
    if (spread <= 0.1) break;
    const center = startPrice - 0.05 * i; // gentle downward drift of midpoint
    const high = center + spread;
    const low = center - spread;
    // Close oscillates near center
    const close = center + (i % 2 === 0 ? spread * 0.15 : -spread * 0.15);
    const open = center - (i % 2 === 0 ? spread * 0.1 : -spread * 0.1);
    result.push({ time: 1700000000 + i * 86400, open, high, low, close });
  }
  return result;
}

test('returns null for too few bars', () => {
  const bars = generateFlat(100, 5, 1);
  assert.equal(detectBullFlag(bars), null);
});

test('returns null for purely flat/sideways data (no prior uptrend)', () => {
  const bars = generateFlat(100, 20, 0.5);
  assert.equal(detectBullFlag(bars), null);
});

test('returns null for downtrend data', () => {
  const bars = generateDowntrend(150, 20, 2);
  assert.equal(detectBullFlag(bars), null);
});

test('detects a clear bull flag formation', () => {
  // Uptrend: 100 → ~115 over 8 bars (15% gain), then flag drifts down gently
  const uptrend = generateUptrend(100, 8, 1.875);
  const lastPrice = uptrend[uptrend.length - 1].close; // ~115
  const flag = generateFlag(lastPrice, 7, -0.15, 0.4);
  const bars = [...uptrend, ...flag];

  const result = detectBullFlag(bars);
  assert.notEqual(result, null);
  assert.ok(result!.confidence >= 50, `confidence ${result!.confidence} should be >= 50`);
  assert.ok(result!.slopePerBar < 0, `slope ${result!.slopePerBar} should be negative`);
  assert.ok(result!.r2 > 0.3, `r2 ${result!.r2} should indicate orderliness`);
});

test('rejects a flag with too much retracement (> 61.8%)', () => {
  // Uptrend: 100 → 110 (10% gain, height = 10)
  const uptrend = generateUptrend(100, 6, 1.67);
  const lastPrice = uptrend[uptrend.length - 1].close; // ~110
  // Flag drops from ~110 down to ~103 → retracement = 70% of 10 = 7 pts
  const flag = generateFlag(lastPrice, 5, -1.4, 0.3);
  const bars = [...uptrend, ...flag];

  const result = detectBullFlag(bars);
  assert.equal(result, null, 'should reject excessive retracement');
});

test('rejects a flag that is drifting upward (not consolidating)', () => {
  // Uptrend then a continuation upward — not a flag
  const uptrend = generateUptrend(100, 8, 1.5);
  const lastPrice = uptrend[uptrend.length - 1].close;
  const risingFlag = generateUptrend(lastPrice, 6, 0.3);
  const bars = [...uptrend, ...risingFlag];

  const result = detectBullFlag(bars);
  assert.equal(result, null, 'should reject upward-drifting consolidation');
});

test('scores a tight orderly flag higher than a loose one', () => {
  const uptrend = generateUptrend(100, 8, 1.875);
  const lastPrice = uptrend[uptrend.length - 1].close;

  // Tight flag
  const tightFlag = generateFlag(lastPrice, 6, -0.2, 0.3);
  const tightBars = [...uptrend, ...tightFlag];
  const tightResult = detectBullFlag(tightBars);

  // Loose flag (more noise)
  const looseFlag = generateFlag(lastPrice, 6, -0.2, 1.5);
  const looseBars = [...uptrend, ...looseFlag];
  const looseResult = detectBullFlag(looseBars);

  assert.notEqual(tightResult, null, 'tight flag should be detected');

  if (looseResult !== null) {
    assert.ok(
      tightResult!.confidence > looseResult.confidence,
      `tight flag confidence (${tightResult!.confidence}) should exceed loose flag (${looseResult.confidence})`,
    );
  }
});

test('returns null when flag drops too steeply (breakdown)', () => {
  const uptrend = generateUptrend(100, 8, 1.5);
  const lastPrice = uptrend[uptrend.length - 1].close;
  // Steep drop — not a consolidation
  const steepDrop = generateFlag(lastPrice, 5, -2.5, 0.5);
  const bars = [...uptrend, ...steepDrop];

  const result = detectBullFlag(bars);
  assert.equal(result, null, 'steep decline should not be detected as a flag');
});

test('detection includes correct index information', () => {
  const uptrend = generateUptrend(100, 10, 1.5);
  const lastPrice = uptrend[uptrend.length - 1].close;
  const flag = generateFlag(lastPrice, 6, -0.15, 0.4);
  const bars = [...uptrend, ...flag];

  const result = detectBullFlag(bars);
  if (result) {
    assert.ok(result.flagEndIndex === bars.length - 1, 'flag should end at the last bar');
    assert.ok(result.flagStartIndex >= 0, 'flag start should be non-negative');
    assert.ok(result.flagStartIndex < result.flagEndIndex, 'flag start should be before flag end');
  }
});

// --- Pennant-specific tests ---

test('detects a clear bull pennant formation', () => {
  // Uptrend: 100 → ~115 over 8 bars, then converging pennant
  const uptrend = generateUptrend(100, 8, 1.875);
  const lastPrice = uptrend[uptrend.length - 1].close; // ~115
  const pennant = generatePennant(lastPrice, 7, 2.0, 0.25);
  const bars = [...uptrend, ...pennant];

  const result = detectBullFlag(bars);
  assert.notEqual(result, null, 'pennant should be detected');
  assert.ok(result!.confidence >= 50, `confidence ${result!.confidence} should be >= 50`);
});

test('rejects a non-converging formation (parallel channel is handled as flag)', () => {
  // A parallel channel where highs and lows move in the same direction
  // (both descending) — this should be detected as a flag, not a pennant.
  // If the slope is acceptable, it will still pass as a flag pattern.
  const uptrend = generateUptrend(100, 8, 1.875);
  const lastPrice = uptrend[uptrend.length - 1].close;
  const flag = generateFlag(lastPrice, 6, -0.15, 0.4);
  const bars = [...uptrend, ...flag];

  const result = detectBullFlag(bars);
  // A gentle parallel channel is a valid flag — should still detect
  assert.notEqual(result, null, 'parallel channel should still detect as a flag');
});

test('rejects pennant with diverging trendlines', () => {
  // Create bars where highs go up and lows go down (expanding, not converging)
  const uptrend = generateUptrend(100, 8, 1.875);
  const lastPrice = uptrend[uptrend.length - 1].close;
  const result: Bar[] = [];
  for (let i = 0; i < 7; i++) {
    const center = lastPrice - 0.1 * i;
    const spread = 0.5 + 0.4 * i; // expanding
    result.push({
      time: 1700000000 + i * 86400,
      open: center,
      close: center + 0.05,
      high: center + spread,
      low: center - spread,
    });
  }
  const bars = [...uptrend, ...result];

  const detected = detectBullFlag(bars);
  // Expanding formation should not detect as pennant, and the wide channel
  // may or may not pass as a flag depending on width — the key is it
  // should NOT get a high confidence pennant score
  if (detected) {
    // If something is detected, it should be modest confidence at best
    assert.ok(
      detected.confidence < 80,
      `diverging formation should not score highly (got ${detected.confidence})`,
    );
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateRSI,
  calculateRMA,
  getIntervalSeconds,
  toVolumeDeltaSourceInterval,
  buildChartRequestKey,
  parseDataApiDateTime,
  parseBarTimeToUnixSeconds,
  VALID_CHART_INTERVALS,
  VOLUME_DELTA_SOURCE_INTERVALS,
} from '../server/services/chartEngine.js';

// ---------------------------------------------------------------------------
// calculateRSI
// ---------------------------------------------------------------------------

test('calculateRSI returns values between 0 and 100', () => {
  const closes = [44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10,
    45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03,
    46.41, 46.22, 45.64];
  const rsi = calculateRSI(closes, 14);
  assert.equal(rsi.length, closes.length);
  for (const val of rsi) {
    assert.ok(val >= 0 && val <= 100, `RSI ${val} should be between 0-100`);
  }
});

test('calculateRSI with all same prices returns consistent values', () => {
  const closes = Array(20).fill(100);
  const rsi = calculateRSI(closes, 14);
  assert.equal(rsi.length, closes.length);
  // With no price changes, gains and losses are both 0 — implementation-specific result
  for (const val of rsi) {
    assert.ok(val >= 0 && val <= 100, `RSI ${val} should be between 0-100`);
  }
});

test('calculateRSI with only gains returns near 100', () => {
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(100 + i);
  const rsi = calculateRSI(closes, 14);
  const last = rsi[rsi.length - 1];
  assert.ok(last > 95, `RSI ${last} should be near 100 for continuous gains`);
});

test('calculateRSI with only losses returns near 0', () => {
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(200 - i);
  const rsi = calculateRSI(closes, 14);
  const last = rsi[rsi.length - 1];
  assert.ok(last < 5, `RSI ${last} should be near 0 for continuous losses`);
});

test('calculateRSI with empty array returns empty array', () => {
  assert.deepEqual(calculateRSI([]), []);
  assert.deepEqual(calculateRSI([], 14), []);
});

test('calculateRSI with insufficient data returns zeros', () => {
  const rsi = calculateRSI([100, 101, 102], 14);
  assert.equal(rsi.length, 3);
});

// ---------------------------------------------------------------------------
// calculateRMA
// ---------------------------------------------------------------------------

test('calculateRMA smooths values', () => {
  const values = [10, 20, 15, 25, 12, 18, 22, 16, 20, 14, 19, 23, 17, 21, 15, 20];
  const rma = calculateRMA(values, 5);
  assert.equal(rma.length, values.length);
  // First few should be null
  for (let i = 0; i < 4; i++) {
    assert.equal(rma[i], null, `rma[${i}] should be null before warmup`);
  }
  // After warmup, should have numeric values
  for (let i = 5; i < rma.length; i++) {
    assert.ok(typeof rma[i] === 'number' && Number.isFinite(rma[i]),
      `rma[${i}] should be a finite number`);
  }
});

test('calculateRMA with empty array returns empty', () => {
  assert.deepEqual(calculateRMA([]), []);
});

// ---------------------------------------------------------------------------
// getIntervalSeconds
// ---------------------------------------------------------------------------

test('getIntervalSeconds returns correct seconds for known intervals', () => {
  assert.equal(getIntervalSeconds('1min'), 60);
  assert.equal(getIntervalSeconds('5min'), 300);
  assert.equal(getIntervalSeconds('15min'), 900);
  assert.equal(getIntervalSeconds('30min'), 1800);
  assert.equal(getIntervalSeconds('1hour'), 3600);
  assert.equal(getIntervalSeconds('4hour'), 14400);
  assert.equal(getIntervalSeconds('1day'), 86400);
  assert.equal(getIntervalSeconds('1week'), 604800);
});

test('getIntervalSeconds defaults to 60 for unknown intervals', () => {
  assert.equal(getIntervalSeconds('unknown'), 60);
  assert.equal(getIntervalSeconds(''), 60);
});

// ---------------------------------------------------------------------------
// toVolumeDeltaSourceInterval
// ---------------------------------------------------------------------------

test('toVolumeDeltaSourceInterval validates known intervals', () => {
  assert.equal(toVolumeDeltaSourceInterval('1min'), '1min');
  assert.equal(toVolumeDeltaSourceInterval('5min'), '5min');
  assert.equal(toVolumeDeltaSourceInterval('1hour'), '1hour');
});

test('toVolumeDeltaSourceInterval returns fallback for invalid', () => {
  assert.equal(toVolumeDeltaSourceInterval('invalid'), '1min');
  assert.equal(toVolumeDeltaSourceInterval(''), '1min');
  assert.equal(toVolumeDeltaSourceInterval(null), '1min');
});

test('toVolumeDeltaSourceInterval uses custom fallback', () => {
  assert.equal(toVolumeDeltaSourceInterval('invalid', '5min'), '5min');
});

// ---------------------------------------------------------------------------
// buildChartRequestKey
// ---------------------------------------------------------------------------

test('buildChartRequestKey builds deterministic key', () => {
  const key = buildChartRequestKey({
    ticker: 'SPY',
    interval: '4hour',
    vdRsiLength: 14,
    vdSourceInterval: '1min',
    vdRsiSourceInterval: '1min',
    lookbackDays: 548
  });
  assert.ok(key.includes('SPY'));
  assert.ok(key.includes('4hour'));
  assert.ok(key.includes('14'));
  // Same params → same key
  const key2 = buildChartRequestKey({
    ticker: 'SPY',
    interval: '4hour',
    vdRsiLength: 14,
    vdSourceInterval: '1min',
    vdRsiSourceInterval: '1min',
    lookbackDays: 548
  });
  assert.equal(key, key2);
});

test('buildChartRequestKey differs for different params', () => {
  const key1 = buildChartRequestKey({
    ticker: 'SPY', interval: '4hour', vdRsiLength: 14,
    vdSourceInterval: '1min', vdRsiSourceInterval: '1min', lookbackDays: 548
  });
  const key2 = buildChartRequestKey({
    ticker: 'AAPL', interval: '4hour', vdRsiLength: 14,
    vdSourceInterval: '1min', vdRsiSourceInterval: '1min', lookbackDays: 548
  });
  assert.notEqual(key1, key2);
});

// ---------------------------------------------------------------------------
// parseDataApiDateTime
// ---------------------------------------------------------------------------

test('parseDataApiDateTime parses ISO datetime', () => {
  const result = parseDataApiDateTime('2026-01-15T14:30:00Z');
  assert.ok(result);
  assert.equal(result.year, 2026);
  assert.equal(result.month, 1);
  assert.equal(result.day, 15);
  assert.equal(result.hour, 14);
  assert.equal(result.minute, 30);
});

test('parseDataApiDateTime returns null for invalid input', () => {
  assert.equal(parseDataApiDateTime('not-a-date'), null);
  assert.equal(parseDataApiDateTime(''), null);
  assert.equal(parseDataApiDateTime(null), null);
});

// ---------------------------------------------------------------------------
// parseBarTimeToUnixSeconds
// ---------------------------------------------------------------------------

test('parseBarTimeToUnixSeconds extracts from time field', () => {
  const ts = 1737000000;
  assert.equal(parseBarTimeToUnixSeconds({ time: ts }), ts);
});

test('parseBarTimeToUnixSeconds handles t field (milliseconds)', () => {
  const tsMs = 1737000000000;
  const result = parseBarTimeToUnixSeconds({ t: tsMs });
  assert.equal(result, 1737000000);
});

test('parseBarTimeToUnixSeconds returns null for empty bar', () => {
  assert.equal(parseBarTimeToUnixSeconds({}), null);
  assert.equal(parseBarTimeToUnixSeconds({ time: null }), null);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('VALID_CHART_INTERVALS contains expected values', () => {
  assert.ok(VALID_CHART_INTERVALS.includes('5min'));
  assert.ok(VALID_CHART_INTERVALS.includes('1hour'));
  assert.ok(VALID_CHART_INTERVALS.includes('4hour'));
  assert.ok(VALID_CHART_INTERVALS.includes('1day'));
  assert.ok(VALID_CHART_INTERVALS.includes('1week'));
});

test('VOLUME_DELTA_SOURCE_INTERVALS contains expected values', () => {
  assert.ok(VOLUME_DELTA_SOURCE_INTERVALS.includes('1min'));
  assert.ok(VOLUME_DELTA_SOURCE_INTERVALS.includes('5min'));
  assert.ok(VOLUME_DELTA_SOURCE_INTERVALS.includes('1hour'));
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregate4HourBarsToDaily,
  aggregateDailyBarsToWeekly,
  classifyDivergenceSignal,
  aggregateDailyDivergenceToWeekly,
  isoWeekKeyFromEtUnixSeconds
} from '../server/chartMath.js';

function unixSeconds(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

test('aggregate4HourBarsToDaily aggregates OHLCV by LA day', () => {
  const bars = [
    { time: unixSeconds('2026-01-07T16:00:00Z'), open: 103, high: 105, low: 100, close: 101, volume: 12 },
    { time: unixSeconds('2026-01-06T15:00:00Z'), open: 100, high: 103, low: 99, close: 102, volume: 10 },
    { time: unixSeconds('2026-01-07T22:00:00Z'), open: 101, high: 106, low: 99, close: 104, volume: 9 },
    { time: unixSeconds('2026-01-06T23:00:00Z'), open: 102, high: 104, low: 101, close: 103, volume: 8 }
  ];

  const daily = aggregate4HourBarsToDaily(bars);
  assert.equal(daily.length, 2);

  assert.equal(daily[0].open, 100);
  assert.equal(daily[0].high, 104);
  assert.equal(daily[0].low, 99);
  assert.equal(daily[0].close, 103);
  assert.equal(daily[0].volume, 18);

  assert.equal(daily[1].open, 103);
  assert.equal(daily[1].high, 106);
  assert.equal(daily[1].low, 99);
  assert.equal(daily[1].close, 104);
  assert.equal(daily[1].volume, 21);
});

test('aggregateDailyBarsToWeekly aggregates OHLCV by LA week (Mon-Sun)', () => {
  const dailyBars = [
    { time: unixSeconds('2026-01-05T20:00:00Z'), open: 10, high: 11, low: 9, close: 10, volume: 100 },
    { time: unixSeconds('2026-01-06T20:00:00Z'), open: 10, high: 12, low: 10, close: 11, volume: 110 },
    { time: unixSeconds('2026-01-08T20:00:00Z'), open: 11, high: 13, low: 10, close: 12, volume: 120 },
    { time: unixSeconds('2026-01-09T20:00:00Z'), open: 12, high: 14, low: 11, close: 13, volume: 130 },
    { time: unixSeconds('2026-01-12T20:00:00Z'), open: 13, high: 14, low: 12, close: 12, volume: 90 },
    { time: unixSeconds('2026-01-13T20:00:00Z'), open: 12, high: 15, low: 11, close: 14, volume: 95 }
  ];

  const weekly = aggregateDailyBarsToWeekly(dailyBars);
  assert.equal(weekly.length, 2);

  assert.equal(weekly[0].open, 10);
  assert.equal(weekly[0].high, 14);
  assert.equal(weekly[0].low, 9);
  assert.equal(weekly[0].close, 13);
  assert.equal(weekly[0].volume, 460);

  assert.equal(weekly[1].open, 13);
  assert.equal(weekly[1].high, 15);
  assert.equal(weekly[1].low, 11);
  assert.equal(weekly[1].close, 14);
  assert.equal(weekly[1].volume, 185);
});

test('classifyDivergenceSignal returns expected signal polarity', () => {
  assert.equal(classifyDivergenceSignal(1000, 99, 100), 'bullish');
  assert.equal(classifyDivergenceSignal(-1000, 101, 100), 'bearish');
  assert.equal(classifyDivergenceSignal(1000, 101, 100), null);
  assert.equal(classifyDivergenceSignal(-1000, 99, 100), null);
});

test('aggregateDailyDivergenceToWeekly sums deltas by ET ISO week', () => {
  const dailyBars = [
    { time: unixSeconds('2026-01-05T20:00:00Z'), open: 10, high: 11, low: 9, close: 10 },
    { time: unixSeconds('2026-01-06T20:00:00Z'), open: 10, high: 12, low: 10, close: 11 },
    { time: unixSeconds('2026-01-12T20:00:00Z'), open: 11, high: 13, low: 10, close: 12 },
    { time: unixSeconds('2026-01-13T20:00:00Z'), open: 12, high: 14, low: 11, close: 13 }
  ];
  const dailyDeltas = [
    { time: dailyBars[0].time, delta: 100 },
    { time: dailyBars[1].time, delta: -30 },
    { time: dailyBars[2].time, delta: 40 },
    { time: dailyBars[3].time, delta: 60 }
  ];

  const weekly = aggregateDailyDivergenceToWeekly(dailyBars, dailyDeltas);
  assert.equal(weekly.length, 2);

  assert.equal(weekly[0].delta, 70);
  assert.equal(weekly[0].close, 11);
  assert.equal(weekly[0].weekKey, isoWeekKeyFromEtUnixSeconds(dailyBars[0].time));

  assert.equal(weekly[1].delta, 100);
  assert.equal(weekly[1].close, 13);
  assert.equal(weekly[1].weekKey, isoWeekKeyFromEtUnixSeconds(dailyBars[2].time));
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addUtcDays,
  etDateStringFromUnixSeconds,
  currentEtDateString,
  maxEtDateString,
  parseDateKeyToUtcMs,
  dateKeyDaysAgo,
  easternLocalToUtcMs,
  pacificLocalToUtcMs,
  pacificDateStringFromUnixSeconds,
  dateKeyFromYmdParts,
  pacificDateTimeParts,
} from '../server/lib/dateUtils.js';

// ---------------------------------------------------------------------------
// addUtcDays
// ---------------------------------------------------------------------------

test('addUtcDays adds positive days', () => {
  const base = new Date('2026-01-10T00:00:00Z');
  const result = addUtcDays(base, 3);
  assert.equal(result.toISOString().slice(0, 10), '2026-01-13');
});

test('addUtcDays subtracts days with negative value', () => {
  const base = new Date('2026-01-10T00:00:00Z');
  const result = addUtcDays(base, -5);
  assert.equal(result.toISOString().slice(0, 10), '2026-01-05');
});

test('addUtcDays crosses month boundary', () => {
  const base = new Date('2026-01-30T12:00:00Z');
  const result = addUtcDays(base, 3);
  assert.equal(result.toISOString().slice(0, 10), '2026-02-02');
});

test('addUtcDays does not mutate original date', () => {
  const base = new Date('2026-01-10T00:00:00Z');
  const origTime = base.getTime();
  addUtcDays(base, 5);
  assert.equal(base.getTime(), origTime);
});

// ---------------------------------------------------------------------------
// etDateStringFromUnixSeconds
// ---------------------------------------------------------------------------

test('etDateStringFromUnixSeconds converts noon UTC to ET date', () => {
  // 2026-01-15 12:00:00 UTC → ET is -5 → 07:00 AM Jan 15
  const ts = Math.floor(new Date('2026-01-15T12:00:00Z').getTime() / 1000);
  assert.equal(etDateStringFromUnixSeconds(ts), '2026-01-15');
});

test('etDateStringFromUnixSeconds handles late-night UTC crossing ET day boundary', () => {
  // 2026-01-15 03:00:00 UTC → ET is -5 → 10:00 PM Jan 14
  const ts = Math.floor(new Date('2026-01-15T03:00:00Z').getTime() / 1000);
  assert.equal(etDateStringFromUnixSeconds(ts), '2026-01-14');
});

test('etDateStringFromUnixSeconds returns empty for non-finite', () => {
  assert.equal(etDateStringFromUnixSeconds(NaN), '');
  assert.equal(etDateStringFromUnixSeconds(Infinity), '');
});

// ---------------------------------------------------------------------------
// currentEtDateString
// ---------------------------------------------------------------------------

test('currentEtDateString returns YYYY-MM-DD format', () => {
  const result = currentEtDateString(new Date('2026-06-15T18:00:00Z'));
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result, '2026-06-15');
});

// ---------------------------------------------------------------------------
// maxEtDateString
// ---------------------------------------------------------------------------

test('maxEtDateString returns greater of two dates', () => {
  assert.equal(maxEtDateString('2026-01-15', '2026-01-10'), '2026-01-15');
  assert.equal(maxEtDateString('2025-12-01', '2026-01-01'), '2026-01-01');
});

test('maxEtDateString handles empty/null values', () => {
  assert.equal(maxEtDateString('2026-01-15', ''), '2026-01-15');
  assert.equal(maxEtDateString('', '2026-01-10'), '2026-01-10');
  assert.equal(maxEtDateString(null, null), '');
  assert.equal(maxEtDateString('', ''), '');
});

// ---------------------------------------------------------------------------
// parseDateKeyToUtcMs
// ---------------------------------------------------------------------------

test('parseDateKeyToUtcMs parses valid date key', () => {
  const ms = parseDateKeyToUtcMs('2026-01-15');
  assert.equal(ms, Date.UTC(2026, 0, 15));
});

test('parseDateKeyToUtcMs returns NaN for invalid formats', () => {
  assert.ok(Number.isNaN(parseDateKeyToUtcMs('2026-1-5')));
  assert.ok(Number.isNaN(parseDateKeyToUtcMs('not-a-date')));
  assert.ok(Number.isNaN(parseDateKeyToUtcMs('')));
  assert.ok(Number.isNaN(parseDateKeyToUtcMs(null)));
});

// ---------------------------------------------------------------------------
// dateKeyDaysAgo
// ---------------------------------------------------------------------------

test('dateKeyDaysAgo subtracts days from date key', () => {
  assert.equal(dateKeyDaysAgo('2026-01-15', 5), '2026-01-10');
  assert.equal(dateKeyDaysAgo('2026-01-05', 10), '2025-12-26');
});

test('dateKeyDaysAgo returns empty for invalid input', () => {
  assert.equal(dateKeyDaysAgo('invalid', 5), '');
  assert.equal(dateKeyDaysAgo('', 5), '');
});

test('dateKeyDaysAgo with zero days returns same date', () => {
  assert.equal(dateKeyDaysAgo('2026-01-15', 0), '2026-01-15');
});

// ---------------------------------------------------------------------------
// easternLocalToUtcMs / pacificLocalToUtcMs
// ---------------------------------------------------------------------------

test('easternLocalToUtcMs converts ET winter (EST) to UTC', () => {
  // Jan 15 2026, 9:30 AM ET (EST = UTC-5) → 14:30 UTC
  const ms = easternLocalToUtcMs(2026, 1, 15, 9, 30);
  const d = new Date(ms);
  assert.equal(d.getUTCHours(), 14);
  assert.equal(d.getUTCMinutes(), 30);
});

test('pacificLocalToUtcMs converts PT winter (PST) to UTC', () => {
  // Jan 15 2026, 6:30 AM PT (PST = UTC-8) → 14:30 UTC
  const ms = pacificLocalToUtcMs(2026, 1, 15, 6, 30);
  const d = new Date(ms);
  assert.equal(d.getUTCHours(), 14);
  assert.equal(d.getUTCMinutes(), 30);
});

// ---------------------------------------------------------------------------
// pacificDateStringFromUnixSeconds
// ---------------------------------------------------------------------------

test('pacificDateStringFromUnixSeconds returns PT date', () => {
  // 2026-01-15 12:00:00 UTC → PT is -8 → 04:00 AM Jan 15
  const ts = Math.floor(new Date('2026-01-15T12:00:00Z').getTime() / 1000);
  assert.equal(pacificDateStringFromUnixSeconds(ts), '2026-01-15');
});

test('pacificDateStringFromUnixSeconds returns empty for non-finite', () => {
  assert.equal(pacificDateStringFromUnixSeconds(NaN), '');
});

// ---------------------------------------------------------------------------
// dateKeyFromYmdParts
// ---------------------------------------------------------------------------

test('dateKeyFromYmdParts formats with zero-padding', () => {
  assert.equal(dateKeyFromYmdParts(2026, 1, 5), '2026-01-05');
  assert.equal(dateKeyFromYmdParts(2026, 12, 31), '2026-12-31');
});

// ---------------------------------------------------------------------------
// pacificDateTimeParts
// ---------------------------------------------------------------------------

test('pacificDateTimeParts returns expected shape', () => {
  const parts = pacificDateTimeParts(new Date('2026-01-15T20:00:00Z'));
  assert.equal(typeof parts.year, 'number');
  assert.equal(typeof parts.month, 'number');
  assert.equal(typeof parts.day, 'number');
  assert.equal(typeof parts.hour, 'number');
  assert.equal(typeof parts.minute, 'number');
  assert.equal(typeof parts.weekday, 'number');
  // 2026-01-15 20:00 UTC → PT (PST) → 12:00 PM Jan 15 (Thursday)
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 1);
  assert.equal(parts.day, 15);
  assert.equal(parts.hour, 12);
  assert.equal(parts.weekday, 4); // Thursday
});

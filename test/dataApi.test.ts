import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDataApiUrl,
  sanitizeDataApiUrl,
  normalizeTickerSymbol,
  getDataApiSymbolCandidates,
  toNumberOrNull,
  toArrayPayload,
  normalizeUnixSeconds,
  normalizeQuoteTimestamp,
  isAbortError,
  buildRequestAbortError,
  buildTaskTimeoutError,
  isDataApiRateLimitedError,
  buildDataApiRateLimitedError,
  isDataApiPausedError,
  buildDataApiPausedError,
  isDataApiSubscriptionRestrictedError,
  getDataApiAggConfig,
  getStallRetryBackoffMs,
  DATA_API_AGG_INTERVAL_MAP,
} from '../server/services/dataApi.js';

// ---------------------------------------------------------------------------
// buildDataApiUrl
// ---------------------------------------------------------------------------

test('buildDataApiUrl builds URL with path and params', () => {
  const url = buildDataApiUrl('/v2/aggs/ticker/SPY/range/1/day/2026-01-01/2026-01-15', {
    adjusted: 'true',
    sort: 'asc',
    limit: '50000',
  });
  assert.ok(url.includes('/v2/aggs/ticker/SPY/range/1/day/'));
  assert.ok(url.includes('adjusted=true'));
  assert.ok(url.includes('sort=asc'));
  assert.ok(url.includes('limit=50000'));
});

test('buildDataApiUrl filters out empty/null params', () => {
  const url = buildDataApiUrl('/v1/test', { a: 'val', b: '', c: null, d: undefined });
  assert.ok(url.includes('a=val'));
  assert.ok(!url.includes('b='));
  assert.ok(!url.includes('c='));
  assert.ok(!url.includes('d='));
});

test('buildDataApiUrl normalizes leading slashes', () => {
  const url1 = buildDataApiUrl('/v1/test');
  const url2 = buildDataApiUrl('v1/test');
  // Both should produce the same result
  assert.ok(url1.includes('/v1/test'));
  assert.ok(url2.includes('/v1/test'));
});

// ---------------------------------------------------------------------------
// sanitizeDataApiUrl
// ---------------------------------------------------------------------------

test('sanitizeDataApiUrl redacts apiKey', () => {
  const result = sanitizeDataApiUrl('https://api.example.com/v1/test?apiKey=secret123&other=val');
  assert.ok(result.includes('apiKey=***'));
  assert.ok(!result.includes('secret123'));
  assert.ok(result.includes('other=val'));
});

test('sanitizeDataApiUrl handles URL without apiKey', () => {
  const url = 'https://api.example.com/v1/test?foo=bar';
  const result = sanitizeDataApiUrl(url);
  assert.ok(result.includes('foo=bar'));
});

// ---------------------------------------------------------------------------
// normalizeTickerSymbol / getDataApiSymbolCandidates
// ---------------------------------------------------------------------------

test('normalizeTickerSymbol uppercases and trims', () => {
  assert.equal(normalizeTickerSymbol('  spy  '), 'SPY');
  assert.equal(normalizeTickerSymbol('aapl'), 'AAPL');
});

test('normalizeTickerSymbol handles null/undefined', () => {
  assert.equal(normalizeTickerSymbol(null), '');
  assert.equal(normalizeTickerSymbol(undefined), '');
});

test('getDataApiSymbolCandidates generates dot/dash variants', () => {
  const candidates = getDataApiSymbolCandidates('BRK.B');
  assert.ok(candidates.includes('BRK.B'));
  assert.ok(candidates.includes('BRK-B'));
});

test('getDataApiSymbolCandidates returns unique array for simple symbol', () => {
  const candidates = getDataApiSymbolCandidates('SPY');
  assert.ok(candidates.includes('SPY'));
  assert.ok(candidates.length >= 1);
});

// ---------------------------------------------------------------------------
// toNumberOrNull
// ---------------------------------------------------------------------------

test('toNumberOrNull converts valid numbers', () => {
  assert.equal(toNumberOrNull(42), 42);
  assert.equal(toNumberOrNull('3.14'), 3.14);
  assert.equal(toNumberOrNull(0), 0);
});

test('toNumberOrNull returns null for non-finite', () => {
  assert.equal(toNumberOrNull(NaN), null);
  assert.equal(toNumberOrNull(Infinity), null);
  assert.equal(toNumberOrNull('abc'), null);
});

test('toNumberOrNull handles null/undefined as 0', () => {
  // Number(null) = 0, Number(undefined) = NaN
  assert.equal(toNumberOrNull(null), 0);
  assert.equal(toNumberOrNull(undefined), null);
});

// ---------------------------------------------------------------------------
// toArrayPayload
// ---------------------------------------------------------------------------

test('toArrayPayload extracts from various shapes', () => {
  assert.deepEqual(toArrayPayload([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(toArrayPayload({ results: [4, 5] }), [4, 5]);
});

test('toArrayPayload returns null for non-array payloads', () => {
  assert.equal(toArrayPayload(null), null);
  assert.equal(toArrayPayload({}), null);
  assert.equal(toArrayPayload('string'), null);
});

// ---------------------------------------------------------------------------
// normalizeUnixSeconds
// ---------------------------------------------------------------------------

test('normalizeUnixSeconds keeps seconds-range values', () => {
  const ts = 1737000000; // ~2025
  assert.equal(normalizeUnixSeconds(ts), ts);
});

test('normalizeUnixSeconds converts milliseconds to seconds', () => {
  const tsMs = 1737000000000;
  assert.equal(normalizeUnixSeconds(tsMs), 1737000000);
});

test('normalizeUnixSeconds returns null for NaN', () => {
  assert.equal(normalizeUnixSeconds(NaN), null);
});

test('normalizeUnixSeconds treats null as 0', () => {
  // Number(null) = 0 which is finite
  assert.equal(normalizeUnixSeconds(null), 0);
});

// ---------------------------------------------------------------------------
// normalizeQuoteTimestamp
// ---------------------------------------------------------------------------

test('normalizeQuoteTimestamp handles numeric seconds', () => {
  const ts = 1737000000;
  assert.equal(normalizeQuoteTimestamp(ts), ts);
});

test('normalizeQuoteTimestamp handles ISO strings', () => {
  const result = normalizeQuoteTimestamp('2026-01-15T12:00:00Z');
  assert.ok(Number.isFinite(result));
  assert.ok(result! > 0);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test('isAbortError detects abort errors', () => {
  const err1: any = new Error('AbortError');
  err1.name = 'AbortError';
  assert.ok(isAbortError(err1));

  const err2: any = new Error('Request aborted');
  err2.httpStatus = 499;
  assert.ok(isAbortError(err2));

  assert.ok(!isAbortError(new Error('normal error')));
});

test('buildRequestAbortError creates abort error', () => {
  const err = buildRequestAbortError('test abort');
  assert.equal(err.name, 'AbortError');
  assert.equal((err as any).httpStatus, 499);
  assert.ok(err.message.includes('test abort'));
});

test('buildTaskTimeoutError creates timeout error', () => {
  const err = buildTaskTimeoutError('fetch', 5000);
  assert.equal((err as any).httpStatus, 504);
  assert.ok(err.message.includes('5000'));
});

test('isDataApiRateLimitedError detects rate limit', () => {
  const err = buildDataApiRateLimitedError();
  assert.ok(isDataApiRateLimitedError(err));
  assert.ok(!isDataApiRateLimitedError(new Error('other')));
});

test('isDataApiPausedError detects paused errors', () => {
  const err = buildDataApiPausedError();
  assert.ok(isDataApiPausedError(err));
  assert.ok(!isDataApiPausedError(new Error('other')));
});

test('isDataApiSubscriptionRestrictedError detects subscription errors', () => {
  const err = new Error('Restricted Endpoint: this feature requires a premium plan');
  assert.ok(isDataApiSubscriptionRestrictedError(err));

  const err2 = new Error("plan doesn't include this data timeframe");
  assert.ok(isDataApiSubscriptionRestrictedError(err2));

  assert.ok(!isDataApiSubscriptionRestrictedError(new Error('normal error')));
});

// ---------------------------------------------------------------------------
// getDataApiAggConfig / DATA_API_AGG_INTERVAL_MAP
// ---------------------------------------------------------------------------

test('getDataApiAggConfig returns config for known intervals', () => {
  const daily = getDataApiAggConfig('1day');
  assert.ok(daily);
  assert.equal(daily.multiplier, 1);
  assert.equal(daily.timespan, 'day');

  const hourly = getDataApiAggConfig('1hour');
  assert.ok(hourly);
  assert.equal(hourly.multiplier, 1);
  assert.equal(hourly.timespan, 'hour');
});

test('getDataApiAggConfig returns null for unknown intervals', () => {
  assert.equal(getDataApiAggConfig('3min'), null);
  assert.equal(getDataApiAggConfig(''), null);
});

test('DATA_API_AGG_INTERVAL_MAP has all expected intervals', () => {
  const expected = ['1min', '5min', '15min', '30min', '1hour', '4hour', '1day', '1week'];
  for (const key of expected) {
    assert.ok((DATA_API_AGG_INTERVAL_MAP as any)[key], `Missing interval: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// getStallRetryBackoffMs
// ---------------------------------------------------------------------------

test('getStallRetryBackoffMs returns exponential backoff', () => {
  const b1 = getStallRetryBackoffMs(1);
  const b2 = getStallRetryBackoffMs(2);
  const b3 = getStallRetryBackoffMs(3);
  assert.ok(b2 > b1, 'backoff should increase');
  assert.ok(b3 > b2, 'backoff should increase');
});

test('getStallRetryBackoffMs is capped at 60000ms', () => {
  const result = getStallRetryBackoffMs(100);
  assert.ok(result <= 60000);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildManualScanRequest,
  fetchLatestDivergenceScanStatus
} from '../server/services/divergenceService.js';

function defaultBooleanParser(value, fallback = false) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

test('buildManualScanRequest returns parsed booleans and optional date', () => {
  const result = buildManualScanRequest({
    req: {
      query: { force: 'true', refreshUniverse: 'false' },
      body: { refreshUniverse: true, runDateEt: '2026-02-11' }
    },
    parseBooleanInput: defaultBooleanParser,
    parseEtDateInput: (value) => value
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    force: true,
    refreshUniverse: true,
    runDateEt: '2026-02-11'
  });
});

test('buildManualScanRequest returns validation error for invalid runDateEt', () => {
  const result = buildManualScanRequest({
    req: {
      query: {},
      body: { runDateEt: 'bad-date' }
    },
    parseBooleanInput: defaultBooleanParser,
    parseEtDateInput: () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'runDateEt must be YYYY-MM-DD');
});

test('fetchLatestDivergenceScanStatus returns fallback scanned trade date and running state', async () => {
  const status = await fetchLatestDivergenceScanStatus({
    divergencePool: {
      query: async (sql) => {
        if (sql.includes('FROM divergence_scan_jobs')) {
          return { rows: [{ id: 5, scanned_trade_date: null }] };
        }
        if (sql.includes('FROM divergence_signals')) {
          return { rows: [{ scanned_trade_date: '2026-02-11' }] };
        }
        throw new Error('unexpected query');
      }
    },
    divergenceSourceInterval: '5min',
    getIsScanRunning: () => true,
    getLastFetchedTradeDateEt: () => '',
    getLastScanDateEt: () => '2026-02-10'
  });

  assert.equal(status.running, true);
  assert.equal(status.lastScanDateEt, '2026-02-11');
  assert.equal(status.latestJob.id, 5);
  assert.equal(status.latestJob.scanned_trade_date, '2026-02-11');
});

test('fetchLatestDivergenceScanStatus prefers in-memory last fetched date when available', async () => {
  const status = await fetchLatestDivergenceScanStatus({
    divergencePool: {
      query: async () => ({ rows: [{ id: 6, scanned_trade_date: '2026-02-09' }] })
    },
    divergenceSourceInterval: '5min',
    getIsScanRunning: () => false,
    getLastFetchedTradeDateEt: () => '2026-02-12',
    getLastScanDateEt: () => '2026-02-10'
  });

  assert.equal(status.running, false);
  assert.equal(status.lastScanDateEt, '2026-02-12');
  assert.equal(status.latestJob.id, 6);
});

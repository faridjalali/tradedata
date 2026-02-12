const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkDatabaseReady,
  buildDebugMetricsPayload,
  buildHealthPayload,
  buildReadyPayload
} = require('../server/services/healthService');

test('checkDatabaseReady returns null readiness when pool missing', async () => {
  const result = await checkDatabaseReady(null);
  assert.deepEqual(result, { ok: null });
});

test('checkDatabaseReady returns true when query succeeds', async () => {
  const result = await checkDatabaseReady({
    query: async () => ({ rows: [{ '?column?': 1 }] })
  });
  assert.deepEqual(result, { ok: true });
});

test('checkDatabaseReady returns error details when query fails', async () => {
  const result = await checkDatabaseReady({
    query: async () => {
      throw new Error('primary db unavailable');
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'primary db unavailable');
});

test('buildDebugMetricsPayload maps runtime metrics to response payload', () => {
  const payload = buildDebugMetricsPayload({
    startedAtMs: Date.now() - 5000,
    isShuttingDown: false,
    httpDebugMetrics: { totalRequests: 10, apiRequests: 7 },
    chartCacheSizes: { lowerTf: 1, vdRsiResults: 2, chartData: 3, quotes: 4, finalResults: 5, inFlight: 0 },
    chartDebugMetrics: { cacheHit: 9, cacheMiss: 1 },
    divergence: { configured: true, running: false, lastScanDateEt: '2026-02-12' },
    memoryUsage: { rss: 100, heapTotal: 200, heapUsed: 150, external: 10 }
  });

  assert.equal(payload.shuttingDown, false);
  assert.equal(payload.http.totalRequests, 10);
  assert.equal(payload.chart.cacheSizes.chartData, 3);
  assert.equal(payload.divergence.lastScanDateEt, '2026-02-12');
  assert.equal(payload.process.heapUsed, 150);
  assert.equal(typeof payload.uptimeSeconds, 'number');
});

test('buildHealthPayload returns expected shape', () => {
  const payload = buildHealthPayload({
    isShuttingDown: true,
    nowIso: '2026-02-12T18:00:00.000Z',
    uptimeSeconds: 123
  });
  assert.deepEqual(payload, {
    status: 'ok',
    timestamp: '2026-02-12T18:00:00.000Z',
    uptimeSeconds: 123,
    shuttingDown: true
  });
});

test('buildReadyPayload returns ready=true when primary DB is healthy', async () => {
  const payload = await buildReadyPayload({
    pool: { query: async () => ({ rows: [{ '?column?': 1 }] }) },
    divergencePool: { query: async () => ({ rows: [{ '?column?': 1 }] }) },
    isDivergenceConfigured: () => true,
    isShuttingDown: false,
    divergenceScanRunning: true,
    lastScanDateEt: '2026-02-12'
  });
  assert.equal(payload.statusCode, 200);
  assert.equal(payload.body.ready, true);
  assert.equal(payload.body.primaryDb, true);
  assert.equal(payload.body.divergenceDb, true);
  assert.equal(payload.body.divergenceConfigured, true);
  assert.equal(payload.body.divergenceScanRunning, true);
  assert.equal(payload.body.lastScanDateEt, '2026-02-12');
});

test('buildReadyPayload returns 503 when primary DB is down', async () => {
  const payload = await buildReadyPayload({
    pool: {
      query: async () => {
        throw new Error('db down');
      }
    },
    divergencePool: null,
    isDivergenceConfigured: () => false,
    isShuttingDown: false,
    divergenceScanRunning: false,
    lastScanDateEt: null
  });
  assert.equal(payload.statusCode, 503);
  assert.equal(payload.body.ready, false);
  assert.equal(payload.body.primaryDb, false);
  assert.equal(payload.body.divergenceDb, null);
  assert.equal(payload.body.errors.primaryDb, 'db down');
});

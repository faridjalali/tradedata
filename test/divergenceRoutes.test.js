import test from 'node:test';
import assert from 'node:assert/strict';

import { registerDivergenceRoutes } from '../server/routes/divergenceRoutes.js';

function createMockApp() {
  const routes = {
    get: new Map(),
    post: new Map()
  };
  return {
    routes,
    get(path, handler) {
      routes.get.set(path, handler);
    },
    post(path, handler) {
      routes.post.set(path, handler);
    }
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function defaultBooleanParser(value, defaultValue) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return defaultValue;
}

function buildOptions(overrides = {}) {
  return {
    app: createMockApp(),
    isDivergenceConfigured: () => true,
    divergenceScanSecret: '',
    getIsScanRunning: () => false,
    parseBooleanInput: defaultBooleanParser,
    parseEtDateInput: (value) => value,
    runDailyDivergenceScan: async () => ({}),
    divergencePool: { query: async () => ({ rows: [] }) },
    divergenceSourceInterval: '5min',
    getLastFetchedTradeDateEt: () => '',
    getLastScanDateEt: () => '',
    ...overrides
  };
}

test('registerDivergenceRoutes requires app', () => {
  assert.throws(
    () => registerDivergenceRoutes({}),
    /registerDivergenceRoutes requires app/
  );
});

test('POST /api/divergence/scan returns 503 when divergence DB is not configured', async () => {
  const options = buildOptions({
    isDivergenceConfigured: () => false
  });
  registerDivergenceRoutes(options);
  const handler = options.app.routes.post.get('/api/divergence/scan');
  const res = createMockRes();
  await handler({ query: {}, headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Divergence database is not configured' });
});

test('POST /api/divergence/scan enforces secret when configured', async () => {
  const options = buildOptions({
    divergenceScanSecret: 'top-secret'
  });
  registerDivergenceRoutes(options);
  const handler = options.app.routes.post.get('/api/divergence/scan');
  const res = createMockRes();
  await handler({ query: {}, headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
});

test('POST /api/divergence/scan validates runDateEt', async () => {
  const options = buildOptions({
    parseEtDateInput: () => null
  });
  registerDivergenceRoutes(options);
  const handler = options.app.routes.post.get('/api/divergence/scan');
  const res = createMockRes();
  await handler({ query: {}, headers: {}, body: { runDateEt: 'bad-date' } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'runDateEt must be YYYY-MM-DD' });
});

test('POST /api/divergence/scan starts manual scan with parsed options', async () => {
  let receivedArgs = null;
  const options = buildOptions({
    runDailyDivergenceScan: async (args) => {
      receivedArgs = args;
      return {};
    },
    parseEtDateInput: (value) => String(value),
    parseBooleanInput: defaultBooleanParser
  });
  registerDivergenceRoutes(options);
  const handler = options.app.routes.post.get('/api/divergence/scan');
  const res = createMockRes();
  await handler(
    {
      query: { force: 'true' },
      headers: {},
      body: { refreshUniverse: true, runDateEt: '2026-02-11' }
    },
    res
  );
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { status: 'started' });
  assert.deepEqual(receivedArgs, {
    force: true,
    refreshUniverse: true,
    runDateEt: '2026-02-11',
    trigger: 'manual-api'
  });
});

test('GET /api/divergence/scan/status returns running state and fallback trade date', async () => {
  const options = buildOptions({
    divergencePool: {
      query: async (sql) => {
        if (sql.includes('FROM divergence_scan_jobs')) {
          return { rows: [{ id: 9, scanned_trade_date: null }] };
        }
        if (sql.includes('FROM divergence_signals')) {
          return { rows: [{ scanned_trade_date: '2026-02-11' }] };
        }
        throw new Error('unexpected query');
      }
    },
    getIsScanRunning: () => true,
    getLastFetchedTradeDateEt: () => '',
    getLastScanDateEt: () => '2026-02-10'
  });
  registerDivergenceRoutes(options);
  const handler = options.app.routes.get.get('/api/divergence/scan/status');
  const res = createMockRes();
  await handler({ query: {}, headers: {}, body: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.running, true);
  assert.equal(res.body.lastScanDateEt, '2026-02-11');
  assert.equal(res.body.latestJob.id, 9);
  assert.equal(res.body.latestJob.scanned_trade_date, '2026-02-11');
});

test('GET /api/divergence/scan/status falls back to in-memory status on query error', async () => {
  const options = buildOptions({
    divergencePool: {
      query: async () => {
        throw new Error('db down');
      }
    }
  });
  registerDivergenceRoutes(options);
  const handler = options.app.routes.get.get('/api/divergence/scan/status');
  const res = createMockRes();
  await handler({ query: {}, headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.latestJob, null);
});

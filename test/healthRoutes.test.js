import test from 'node:test';
import assert from 'node:assert/strict';

import { registerHealthRoutes } from '../server/routes/healthRoutes.js';

function createMockApp() {
  const routes = {
    get: new Map()
  };
  return {
    routes,
    get(path, handler) {
      routes.get.set(path, handler);
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

function buildOptions(overrides = {}) {
  return {
    app: createMockApp(),
    debugMetricsSecret: '',
    getDebugMetricsPayload: () => ({ debug: true }),
    getHealthPayload: () => ({ status: 'ok' }),
    getReadyPayload: async () => ({ statusCode: 200, body: { ready: true } }),
    ...overrides
  };
}

test('registerHealthRoutes requires app', () => {
  assert.throws(
    () => registerHealthRoutes({}),
    /registerHealthRoutes requires app/
  );
});

test('GET /api/debug/metrics requires secret when configured', () => {
  const options = buildOptions({
    debugMetricsSecret: 'debug-secret'
  });
  registerHealthRoutes(options);
  const handler = options.app.routes.get.get('/api/debug/metrics');
  const res = createMockRes();
  handler({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Unauthorized' });
});

test('GET /api/debug/metrics returns payload when authorized', () => {
  const options = buildOptions({
    debugMetricsSecret: 'debug-secret',
    getDebugMetricsPayload: () => ({ uptimeSeconds: 10 })
  });
  registerHealthRoutes(options);
  const handler = options.app.routes.get.get('/api/debug/metrics');
  const res = createMockRes();
  handler({ query: { secret: 'debug-secret' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { uptimeSeconds: 10 });
});

test('GET /healthz returns health payload', () => {
  const options = buildOptions({
    getHealthPayload: () => ({ status: 'ok', shuttingDown: false })
  });
  registerHealthRoutes(options);
  const handler = options.app.routes.get.get('/healthz');
  const res = createMockRes();
  handler({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: 'ok', shuttingDown: false });
});

test('GET /readyz returns provided status and payload', async () => {
  const options = buildOptions({
    getReadyPayload: async () => ({ statusCode: 503, body: { ready: false } })
  });
  registerHealthRoutes(options);
  const handler = options.app.routes.get.get('/readyz');
  const res = createMockRes();
  await handler({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ready: false });
});

test('GET /readyz returns 503 when ready provider throws', async () => {
  const options = buildOptions({
    getReadyPayload: async () => {
      throw new Error('boom');
    }
  });
  registerHealthRoutes(options);
  const handler = options.app.routes.get.get('/readyz');
  const res = createMockRes();
  await handler({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    ready: false,
    error: 'Ready check failed'
  });
});

#!/usr/bin/env node

const baseUrl = String(process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const requireReady200 = String(process.env.REQUIRE_READY_200 || 'true').toLowerCase() !== 'false';
const timeoutMs = Math.max(1000, Number(process.env.SMOKE_TIMEOUT_MS || 8000));

async function request(path) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => null);
  return { url, status: res.status, json };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logOk(label, details = '') {
  const suffix = details ? ` ${details}` : '';
  console.log(`ok - ${label}${suffix}`);
}

async function main() {
  console.log(`Running release smoke checks against ${baseUrl}`);

  const health = await request('/healthz');
  assert(health.status === 200, `/healthz returned ${health.status}`);
  assert(health.json && health.json.status === 'ok', '/healthz payload missing status=ok');
  logOk('healthz', `(${health.status})`);

  const ready = await request('/readyz');
  if (requireReady200) {
    assert(ready.status === 200, `/readyz returned ${ready.status} (expected 200)`);
    assert(ready.json && ready.json.ready === true, '/readyz payload missing ready=true');
  } else {
    assert([200, 503].includes(ready.status), `/readyz returned ${ready.status} (expected 200/503)`);
  }
  logOk('readyz', `(${ready.status})`);

  const tradingContext = await request('/api/trading-calendar/context');
  assert(tradingContext.status === 200, `/api/trading-calendar/context returned ${tradingContext.status}`);
  assert(
    tradingContext.json && typeof tradingContext.json.today === 'string' && tradingContext.json.today.length > 0,
    '/api/trading-calendar/context payload missing today',
  );
  logOk('trading-calendar/context', `(${tradingContext.status})`);

  const alerts = await request('/api/alerts');
  assert(alerts.status === 200, `/api/alerts returned ${alerts.status}`);
  assert(Array.isArray(alerts.json), '/api/alerts payload is not an array');
  logOk('alerts', `(${alerts.status})`);

  console.log('Release smoke checks passed');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Release smoke checks failed: ${message}`);
  process.exit(1);
});

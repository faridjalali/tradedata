#!/usr/bin/env node
require('dotenv').config();

const mode = String(process.argv[2] || 'baseline').trim().toLowerCase();
const tickerLimit = Math.max(1, Number(process.argv[3]) || 80);
const workerCount = Math.max(1, Number(process.argv[4]) || 16);
const sourceInterval = String(process.argv[5] || process.env.BENCH_SOURCE_INTERVAL || '1min').trim();
const lookbackDays = Math.max(28, Number(process.argv[6]) || 35);

const { setGlobalDispatcher, Agent } = require('undici');

if (mode === 'undici') {
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 10000,
    keepAliveMaxTimeout: 10000,
    pipelining: 0,
    connect: { timeout: 10000 }
  }));
} else if (mode === 'undici-app') {
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 10000,
    keepAliveMaxTimeout: 10000,
    connect: { timeout: 10000 }
  }));
} else if (mode === 'undici-previous') {
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 15000,
    keepAliveMaxTimeout: 30000,
    connect: { timeout: 15000 }
  }));
} else if (mode !== 'baseline') {
  console.error(`Unknown mode: ${mode}`);
  process.exit(2);
}

const API_KEY = String(process.env.DATA_API_KEY || '').trim();
if (!API_KEY) {
  console.error('DATA_API_KEY is required');
  process.exit(2);
}

const BASE_URL = String(process.env.BENCH_BASE_URL || 'https://api.massive.com').replace(/\/+$/, '');
const DATA_API_TIMEOUT_MS = Math.max(1000, Number(process.env.BENCH_TIMEOUT_MS) || 15000);
const MAX_RPS = Math.max(1, Number(process.env.BENCH_MAX_RPS) || 95);

const TICKERS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK.B','JPM','V',
  'LLY','WMT','XOM','UNH','MA','PG','HD','COST','ABBV','MRK',
  'AVGO','PEP','KO','ADBE','BAC','NFLX','ORCL','CSCO','TMO','CRM',
  'ACN','MCD','DIS','ABT','LIN','DHR','CMCSA','INTC','VZ','WFC',
  'AMD','TXN','QCOM','AMGN','PFE','PM','LOW','RTX','INTU','CAT',
  'UPS','HON','NKE','SPGI','UNP','MS','GS','BLK','SBUX','SCHW',
  'PLD','AXP','DE','GE','ISRG','SYK','BKNG','LMT','NOW','GILD',
  'MU','MDT','ADP','CB','MMM','CI','SO','CVX','BA','T'
].slice(0, tickerLimit);

let rateTokens = MAX_RPS;
let rateLastRefillMs = Date.now();

function refillTokens(nowMs) {
  if (nowMs <= rateLastRefillMs) return;
  const elapsedMs = nowMs - rateLastRefillMs;
  const refill = (elapsedMs * MAX_RPS) / 1000;
  if (refill > 0) {
    rateTokens = Math.min(MAX_RPS, rateTokens + refill);
    rateLastRefillMs = nowMs;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRateSlot() {
  while (true) {
    const now = Date.now();
    refillTokens(now);
    if (rateTokens >= 1) {
      rateTokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - rateTokens) * (1000 / MAX_RPS));
    await sleep(Math.max(1, waitMs));
  }
}

function toDateOnlyUTC(dt) {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function addUtcDays(dateObj, days) {
  const copy = new Date(dateObj.getTime());
  copy.setUTCDate(copy.getUTCDate() + Number(days || 0));
  return copy;
}

function buildUrl(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  url.searchParams.set('apiKey', API_KEY);
  return url.toString();
}

function normalizeInterval(interval) {
  const key = String(interval || '').trim().toLowerCase();
  const map = {
    '1min': { multiplier: 1, timespan: 'minute' },
    '5min': { multiplier: 5, timespan: 'minute' },
    '15min': { multiplier: 15, timespan: 'minute' },
    '30min': { multiplier: 30, timespan: 'minute' },
    '1hour': { multiplier: 1, timespan: 'hour' },
    '4hour': { multiplier: 4, timespan: 'hour' },
    '1day': { multiplier: 1, timespan: 'day' },
    '1week': { multiplier: 1, timespan: 'week' }
  };
  return map[key] || map['1day'];
}

function buildAggregateRangeUrl(symbol, interval, from, to) {
  const norm = normalizeInterval(interval);
  const path = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${norm.multiplier}/${norm.timespan}/${from}/${to}`;
  return buildUrl(path, {
    adjusted: 'true',
    sort: 'asc',
    limit: '50000'
  });
}

const latenciesMs = [];
const tickerDurationsMs = [];
const statusCounts = new Map();
let apiCalls = 0;
let apiErrors = 0;
let tickerErrors = 0;
let rateLimited = 0;

function recordStatus(status) {
  const key = String(status);
  statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function toRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray(payload.results) ? payload.results : [];
}

function latestCloseFromDailyRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1] || null;
  const close = Number(last?.c ?? last?.close);
  return Number.isFinite(close) && close > 0 ? close : null;
}

async function fetchJson(url) {
  await acquireRateSlot();
  const started = process.hrtime.bigint();
  apiCalls += 1;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DATA_API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    latenciesMs.push(elapsedMs);
    recordStatus(res.status);

    if (!res.ok) {
      apiErrors += 1;
      if (res.status === 429) rateLimited += 1;
      throw new Error(`HTTP_${res.status}`);
    }

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      apiErrors += 1;
      recordStatus('PARSE_ERR');
      throw new Error('PARSE_ERR');
    }

    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      apiErrors += 1;
      if (/limit|too many|429/i.test(payload.error)) {
        rateLimited += 1;
        recordStatus('API_429');
      } else {
        recordStatus('API_ERR');
      }
      throw new Error('API_ERR');
    }

    return payload;
  } catch (err) {
    if (String(err?.name || '') === 'AbortError') {
      apiErrors += 1;
      recordStatus('ABORT');
    } else if (!/^HTTP_/.test(String(err?.message || '')) && String(err?.message || '') !== 'PARSE_ERR' && String(err?.message || '') !== 'API_ERR') {
      apiErrors += 1;
      recordStatus('FETCH_ERR');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHistoryRows(ticker, interval, days) {
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  const startDate = addUtcDays(endDate, -Math.max(1, days));

  const from = toDateOnlyUTC(startDate);
  const to = toDateOnlyUTC(endDate);

  const chunkDaysByInterval = {
    '1min': 30,
    '5min': 150,
    '15min': 150
  };
  const chunkDays = chunkDaysByInterval[String(interval || '').trim()] || 0;

  if (!chunkDays) {
    const payload = await fetchJson(buildAggregateRangeUrl(ticker, interval, from, to));
    return toRows(payload);
  }

  const ranges = [];
  let cursor = new Date(startDate);
  while (cursor < endDate) {
    const next = addUtcDays(cursor, chunkDays);
    const chunkEnd = next < endDate ? next : endDate;
    ranges.push([toDateOnlyUTC(cursor), toDateOnlyUTC(chunkEnd)]);
    cursor = addUtcDays(chunkEnd, 1);
  }

  const payloads = await Promise.all(
    ranges.map(([rFrom, rTo]) => fetchJson(buildAggregateRangeUrl(ticker, interval, rFrom, rTo)))
  );

  const out = [];
  for (const payload of payloads) {
    out.push(...toRows(payload));
  }
  return out;
}

function buildIndicatorUrl(ticker, type, windowLength) {
  return buildUrl(`/v1/indicators/${encodeURIComponent(type)}/${encodeURIComponent(ticker)}`, {
    timespan: 'day',
    window: String(windowLength),
    series_type: 'close',
    order: 'desc',
    limit: '1'
  });
}

async function processTicker(ticker) {
  const started = process.hrtime.bigint();
  try {
    const [sourceRows, dailyRows, weeklyRows] = await Promise.all([
      fetchHistoryRows(ticker, sourceInterval, lookbackDays),
      fetchHistoryRows(ticker, '1day', lookbackDays),
      fetchHistoryRows(ticker, '1week', lookbackDays)
    ]);

    if (sourceRows.length === 0 || dailyRows.length === 0 || weeklyRows.length === 0) {
      throw new Error('EMPTY_ROWS');
    }

    const latestClose = latestCloseFromDailyRows(dailyRows);
    if (latestClose !== null) {
      await Promise.all([
        fetchJson(buildIndicatorUrl(ticker, 'ema', 8)),
        fetchJson(buildIndicatorUrl(ticker, 'ema', 21)),
        fetchJson(buildIndicatorUrl(ticker, 'sma', 50)),
        fetchJson(buildIndicatorUrl(ticker, 'sma', 200))
      ]);
    }
  } catch {
    tickerErrors += 1;
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    tickerDurationsMs.push(elapsedMs);
  }
}

async function main() {
  const startedAll = process.hrtime.bigint();
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= TICKERS.length) return;
      await processTicker(TICKERS[idx]);
    }
  });

  await Promise.all(workers);

  const elapsedMs = Number(process.hrtime.bigint() - startedAll) / 1e6;
  const avgCall = latenciesMs.length ? latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length : 0;
  const avgTicker = tickerDurationsMs.length ? tickerDurationsMs.reduce((a, b) => a + b, 0) / tickerDurationsMs.length : 0;

  const result = {
    mode,
    baseUrl: BASE_URL,
    tickers: TICKERS.length,
    workerCount,
    sourceInterval,
    lookbackDays,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    tickersPerSec: Number(((TICKERS.length / elapsedMs) * 1000).toFixed(3)),
    apiCalls,
    apiErrors,
    rateLimited,
    tickerErrors,
    callAvgMs: Number(avgCall.toFixed(2)),
    callP50Ms: Number(percentile(latenciesMs, 0.5).toFixed(2)),
    callP95Ms: Number(percentile(latenciesMs, 0.95).toFixed(2)),
    callP99Ms: Number(percentile(latenciesMs, 0.99).toFixed(2)),
    tickerAvgMs: Number(avgTicker.toFixed(2)),
    tickerP50Ms: Number(percentile(tickerDurationsMs, 0.5).toFixed(2)),
    tickerP95Ms: Number(percentile(tickerDurationsMs, 0.95).toFixed(2)),
    tickerP99Ms: Number(percentile(tickerDurationsMs, 0.99).toFixed(2)),
    statusCounts: Object.fromEntries([...statusCounts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  };

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});

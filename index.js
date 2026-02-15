const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const compression = require("compression");
const { setGlobalDispatcher, Agent } = require("undici");

// setGlobalDispatcher(new Agent({
//   keepAliveTimeout: 10000,
//   keepAliveMaxTimeout: 10000,
//   connect: {
//     timeout: 10000
//   }
// }));

const { registerChartRoutes } = require("./server/routes/chartRoutes");
const { registerDivergenceRoutes } = require("./server/routes/divergenceRoutes");
const { registerHealthRoutes } = require("./server/routes/healthRoutes");
const sessionAuth = require("./server/services/sessionAuth");
const tradingCalendar = require("./server/services/tradingCalendar");
const {
  buildDebugMetricsPayload,
  buildHealthPayload,
  buildReadyPayload
} = require("./server/services/healthService");
const { detectVDF } = require("./server/services/vdfDetector");
const {
  aggregate4HourBarsToDaily,
  aggregateDailyBarsToWeekly,
  classifyDivergenceSignal,
  barsToTuples,
  pointsToTuples,
  formatDateUTC,
  dayKeyInLA,
} = require("./server/chartMath");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const gzipAsync = promisify(zlib.gzip);
const brotliCompressAsync = promisify(zlib.brotliCompress);

// NOTE: cors() allows all origins. Restrict in production if needed:
// app.use(cors({ origin: 'https://yourdomain.com' }));
app.use(cors());
app.use(compression());
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const BASIC_AUTH_ENABLED = String(process.env.BASIC_AUTH_ENABLED || 'false').toLowerCase() !== 'false';
const BASIC_AUTH_USERNAME = String(process.env.BASIC_AUTH_USERNAME || 'shared');
const BASIC_AUTH_PASSWORD = String(process.env.BASIC_AUTH_PASSWORD || '');
const BASIC_AUTH_REALM = String(process.env.BASIC_AUTH_REALM || 'Catvue');
const SITE_LOCK_PASSCODE = String(process.env.SITE_LOCK_PASSCODE || '46110603').trim();
const SITE_LOCK_ENABLED = SITE_LOCK_PASSCODE.length > 0;
const REQUEST_LOG_ENABLED = String(process.env.REQUEST_LOG_ENABLED || 'false').toLowerCase() === 'true';
const DEBUG_METRICS_SECRET = String(process.env.DEBUG_METRICS_SECRET || '').trim();
let isShuttingDown = false;
const startedAtMs = Date.now();
const chartDebugMetrics = {
  cacheHit: 0,
  cacheMiss: 0,
  buildStarted: 0,
  dedupeJoin: 0,
  prewarmRequested: {
    dailyFrom4hour: 0,
    fourHourFrom1day: 0,
    weeklyFrom1day: 0,
    fourHourFrom1dayCacheHit: 0,
    weeklyFrom1dayCacheHit: 0
  },
  prewarmCompleted: 0,
  prewarmFailed: 0,
  requestTimingByInterval: {}
};
const httpDebugMetrics = {
  totalRequests: 0,
  apiRequests: 0
};
const CHART_TIMING_SAMPLE_MAX = Math.max(50, Number(process.env.CHART_TIMING_SAMPLE_MAX) || 240);
const chartTimingSamplesByKey = new Map();

function clampTimingSample(valueMs) {
  const numeric = Number(valueMs);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100) / 100;
}

function pushTimingSample(cacheKey, valueMs) {
  const value = clampTimingSample(valueMs);
  if (value === null) return;
  let samples = chartTimingSamplesByKey.get(cacheKey);
  if (!samples) {
    samples = [];
    chartTimingSamplesByKey.set(cacheKey, samples);
  }
  samples.push(value);
  if (samples.length > CHART_TIMING_SAMPLE_MAX) {
    samples.shift();
  }
}

function calculateP95Ms(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

function getOrCreateChartTimingSummary(interval) {
  const key = String(interval || '').trim() || 'unknown';
  if (!chartDebugMetrics.requestTimingByInterval[key]) {
    chartDebugMetrics.requestTimingByInterval[key] = {
      count: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      chartCount: 0,
      chartLatestCount: 0,
      p95Ms: 0,
      cacheHitP95Ms: 0,
      cacheMissP95Ms: 0
    };
  }
  return chartDebugMetrics.requestTimingByInterval[key];
}

function recordChartRequestTiming(options = {}) {
  const interval = String(options.interval || '').trim() || 'unknown';
  const route = options.route === 'chart_latest' ? 'chart_latest' : 'chart';
  const cacheHit = options.cacheHit === true;
  const durationMs = clampTimingSample(options.durationMs);
  if (durationMs === null) return;

  const summary = getOrCreateChartTimingSummary(interval);
  summary.count += 1;
  if (route === 'chart_latest') {
    summary.chartLatestCount += 1;
  } else {
    summary.chartCount += 1;
  }
  if (cacheHit) {
    summary.cacheHitCount += 1;
  } else {
    summary.cacheMissCount += 1;
  }

  pushTimingSample(`${interval}|all`, durationMs);
  pushTimingSample(`${interval}|${cacheHit ? 'hit' : 'miss'}`, durationMs);
  summary.p95Ms = calculateP95Ms(chartTimingSamplesByKey.get(`${interval}|all`));
  summary.cacheHitP95Ms = calculateP95Ms(chartTimingSamplesByKey.get(`${interval}|hit`));
  summary.cacheMissP95Ms = calculateP95Ms(chartTimingSamplesByKey.get(`${interval}|miss`));
}

function validateStartupEnvironment() {
  const errors = [];
  const warnings = [];
  const requireNonEmpty = (name) => {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      errors.push(`${name} is required`);
    }
  };
  const warnIfMissing = (name) => {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      warnings.push(`${name} is not set`);
    }
  };
  const warnIfInvalidPositiveNumber = (name) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      warnings.push(`${name} should be a positive number (received: ${String(raw)})`);
    }
  };
  const warnIfInvalidNonNegativeNumber = (name) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      warnings.push(`${name} should be a non-negative number (received: ${String(raw)})`);
    }
  };

  requireNonEmpty('DATABASE_URL');
  if (BASIC_AUTH_ENABLED && !String(BASIC_AUTH_PASSWORD || '').trim()) {
    errors.push('BASIC_AUTH_PASSWORD must be set when BASIC_AUTH_ENABLED is true');
  }
  if (!String(process.env.DATA_API_KEY || '').trim()) {
    warnings.push('DATA_API_KEY is not set');
  }
  if (String(process.env.DATA_API_REQUESTS_PAUSED || 'false').toLowerCase() === 'true') {
    warnings.push('DATA_API_REQUESTS_PAUSED is enabled (outbound market-data calls are blocked)');
  }

  const positiveNumericEnvNames = [
    'DIVERGENCE_SCAN_SPREAD_MINUTES',
    'DIVERGENCE_MIN_UNIVERSE_SIZE',
    'DIVERGENCE_STALL_TIMEOUT_MS',
    'DIVERGENCE_STALL_CHECK_INTERVAL_MS',
    'DIVERGENCE_STALL_RETRY_BASE_MS',
    'DIVERGENCE_FETCH_TICKER_TIMEOUT_MS',
    'DIVERGENCE_FETCH_MA_TIMEOUT_MS',
    'CHART_QUOTE_CACHE_MS',
    'CHART_TIMING_SAMPLE_MAX',
    'VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES',
    'VD_RSI_RESULT_CACHE_MAX_ENTRIES',
    'CHART_DATA_CACHE_MAX_ENTRIES',
    'CHART_QUOTE_CACHE_MAX_ENTRIES',
    'CHART_FINAL_RESULT_CACHE_MAX_ENTRIES'
  ];
  positiveNumericEnvNames.forEach(warnIfInvalidPositiveNumber);
  const nonNegativeNumericEnvNames = [
    'DIVERGENCE_STALL_MAX_RETRIES',
    'CHART_RESULT_CACHE_TTL_SECONDS',
    'CHART_RESPONSE_MAX_AGE_SECONDS',
    'CHART_RESPONSE_SWR_SECONDS',
    'CHART_RESPONSE_COMPRESS_MIN_BYTES'
  ];
  nonNegativeNumericEnvNames.forEach(warnIfInvalidNonNegativeNumber);

  if (warnings.length > 0) {
    for (const warning of warnings) {
      console.warn(`[startup-env] ${warning}`);
    }
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[startup-env] ${error}`);
    }
    throw new Error('Startup environment validation failed');
  }
}

validateStartupEnvironment();

function logStructured(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(8).toString('hex');
}

function shouldLogRequestPath(pathname) {
  const path = String(pathname || '');
  if (path.startsWith('/api/')) return true;
  return path === '/healthz' || path === '/readyz';
}

function extractSafeRequestMeta(req) {
  const path = String(req.path || '');
  const queryKeys = Object.keys(req.query || {});
  const meta = {
    method: req.method,
    path,
    queryKeys
  };
  if (path.startsWith('/api/chart')) {
    const ticker = typeof req.query?.ticker === 'string' ? req.query.ticker : null;
    const interval = typeof req.query?.interval === 'string' ? req.query.interval : null;
    return { ...meta, ticker, interval };
  }
  return meta;
}

function isValidTickerSymbol(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (!ticker) return false;
  return /^[A-Z][A-Z0-9.\-]{0,19}$/.test(ticker);
}

function parseEtDateInput(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const dt = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const normalized = dt.toISOString().slice(0, 10);
  return normalized === text ? text : null;
}

function parseBooleanInput(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

function isValidScaleTime(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidCandleLike(value) {
  if (!value || typeof value !== 'object') return false;
  return isValidScaleTime(value.time)
    && Number.isFinite(Number(value.open))
    && Number.isFinite(Number(value.high))
    && Number.isFinite(Number(value.low))
    && Number.isFinite(Number(value.close))
    && Number.isFinite(Number(value.volume));
}

function isValidPointLike(value, field = 'value') {
  if (!value || typeof value !== 'object') return false;
  return isValidScaleTime(value.time) && Number.isFinite(Number(value[field]));
}

function validateChartPayloadShape(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Chart payload is not an object' };
  if (!Array.isArray(payload.bars) || payload.bars.length === 0) {
    return { ok: false, error: 'Chart payload bars are missing' };
  }
  const firstBar = payload.bars[0];
  const lastBar = payload.bars[payload.bars.length - 1];
  if (!isValidCandleLike(firstBar) || !isValidCandleLike(lastBar)) {
    return { ok: false, error: 'Chart payload bars are invalid' };
  }
  const rsi = Array.isArray(payload.rsi) ? payload.rsi : [];
  if (rsi.length > 0) {
    const firstRsi = rsi[0];
    const lastRsi = rsi[rsi.length - 1];
    if (!isValidPointLike(firstRsi) || !isValidPointLike(lastRsi)) {
      return { ok: false, error: 'Chart payload RSI points are invalid' };
    }
  }
  const vdRsi = Array.isArray(payload?.volumeDeltaRsi?.rsi) ? payload.volumeDeltaRsi.rsi : [];
  if (vdRsi.length > 0) {
    const firstVdRsi = vdRsi[0];
    const lastVdRsi = vdRsi[vdRsi.length - 1];
    if (!isValidPointLike(firstVdRsi) || !isValidPointLike(lastVdRsi)) {
      return { ok: false, error: 'Chart payload Volume Delta RSI points are invalid' };
    }
  }
  const volumeDelta = Array.isArray(payload.volumeDelta) ? payload.volumeDelta : [];
  if (volumeDelta.length > 0) {
    const firstDelta = volumeDelta[0];
    const lastDelta = volumeDelta[volumeDelta.length - 1];
    if (!isValidPointLike(firstDelta, 'delta') || !isValidPointLike(lastDelta, 'delta')) {
      return { ok: false, error: 'Chart payload Volume Delta points are invalid' };
    }
  }
  return { ok: true };
}

function validateChartLatestPayloadShape(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Latest payload is not an object' };
  if (payload.latestBar !== null && !isValidCandleLike(payload.latestBar)) {
    return { ok: false, error: 'Latest payload latestBar is invalid' };
  }
  if (payload.latestRsi !== null && payload.latestRsi !== undefined && !isValidPointLike(payload.latestRsi)) {
    return { ok: false, error: 'Latest payload latestRsi is invalid' };
  }
  if (payload.latestVolumeDeltaRsi !== null && payload.latestVolumeDeltaRsi !== undefined && !isValidPointLike(payload.latestVolumeDeltaRsi)) {
    return { ok: false, error: 'Latest payload latestVolumeDeltaRsi is invalid' };
  }
  if (payload.latestVolumeDelta !== null && payload.latestVolumeDelta !== undefined && !isValidPointLike(payload.latestVolumeDelta, 'delta')) {
    return { ok: false, error: 'Latest payload latestVolumeDelta is invalid' };
  }
  return { ok: true };
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function basicAuthMiddleware(req, res, next) {
  if (!BASIC_AUTH_ENABLED || req.method === 'OPTIONS') {
    return next();
  }

  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', `Basic realm="${BASIC_AUTH_REALM}"`);
    return res.status(401).send('Authentication required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';

  const validUsername = timingSafeStringEqual(username, BASIC_AUTH_USERNAME);
  const validPassword = timingSafeStringEqual(password, BASIC_AUTH_PASSWORD);
  if (!validUsername || !validPassword) {
    res.setHeader('WWW-Authenticate', `Basic realm="${BASIC_AUTH_REALM}"`);
    return res.status(401).send('Invalid credentials');
  }

  return next();
}

app.use(basicAuthMiddleware);

// --- Session-based site lock auth ---
app.post('/api/auth/verify', (req, res) => {
  const passcode = String((req.body && req.body.passcode) || '').trim();
  if (!SITE_LOCK_ENABLED || !passcode) {
    return res.status(401).json({ error: 'Invalid passcode' });
  }
  if (!timingSafeStringEqual(passcode, SITE_LOCK_PASSCODE)) {
    return res.status(401).json({ error: 'Invalid passcode' });
  }
  const token = sessionAuth.createSession();
  sessionAuth.setSessionCookie(res, token);
  return res.status(200).json({ status: 'ok' });
});

app.get('/api/auth/check', (req, res) => {
  if (!SITE_LOCK_ENABLED) return res.status(200).json({ status: 'ok' });
  const token = sessionAuth.parseCookieValue(req);
  if (sessionAuth.validateSession(token)) {
    return res.status(200).json({ status: 'ok' });
  }
  return res.status(401).json({ error: 'Not authenticated' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = sessionAuth.parseCookieValue(req);
  sessionAuth.destroySession(token);
  sessionAuth.clearSessionCookie(res);
  return res.status(200).json({ status: 'ok' });
});

// Session auth middleware — gate all /api/* except auth & health endpoints
const SESSION_AUTH_EXEMPT = ['/api/auth/', '/api/health', '/api/ready'];
app.use((req, res, next) => {
  if (!SITE_LOCK_ENABLED) return next();
  const path = String(req.path || '');
  if (!path.startsWith('/api/')) return next();
  if (SESSION_AUTH_EXEMPT.some((prefix) => path.startsWith(prefix))) return next();
  const token = sessionAuth.parseCookieValue(req);
  if (sessionAuth.validateSession(token)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
});

app.use(express.static('dist', {
  maxAge: '1y',
  immutable: true
}));
app.use((req, res, next) => {
  if (!isShuttingDown) return next();
  res.setHeader('Connection', 'close');
  return res.status(503).json({ error: 'Server is shutting down' });
});
app.use((req, res, next) => {
  const requestId = String(req.headers['x-request-id'] || '').trim() || createRequestId();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  httpDebugMetrics.totalRequests += 1;
  if (String(req.path || '').startsWith('/api/')) {    httpDebugMetrics.apiRequests += 1;
  }

  if (!REQUEST_LOG_ENABLED || !shouldLogRequestPath(req.path)) {
    return next();
  }

  const startedNs = process.hrtime.bigint();
  logStructured('info', 'request_start', {
    requestId,
    ...extractSafeRequestMeta(req)
  });
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    logStructured('info', 'request_end', {
      requestId,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      ...extractSafeRequestMeta(req)
    });
  });
  return next();
});

const dbSslRejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'false').toLowerCase() !== 'false';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: dbSslRejectUnauthorized },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 30000,
});
pool.on('error', (err) => {
  console.error('Unexpected idle pool client error:', err.message);
});

const divergenceDatabaseUrl = process.env.DIVERGENCE_DATABASE_URL || '';
const divergencePool = divergenceDatabaseUrl
  ? new Pool({
      connectionString: divergenceDatabaseUrl,
      ssl: { rejectUnauthorized: dbSslRejectUnauthorized },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      statement_timeout: 30000,
    })
  : null;
if (divergencePool) {
  divergencePool.on('error', (err) => {
    console.error('Unexpected idle divergence pool client error:', err.message);
  });
}

const DIVERGENCE_SOURCE_INTERVAL = '1min';
const DIVERGENCE_SCAN_PARENT_INTERVAL = '1day';
const DIVERGENCE_SCAN_LOOKBACK_DAYS = 45;
const DIVERGENCE_SCAN_SPREAD_MINUTES = Math.max(0, Number(process.env.DIVERGENCE_SCAN_SPREAD_MINUTES) || 0);
const DIVERGENCE_SCAN_CONCURRENCY = Math.max(1, Number(process.env.DIVERGENCE_SCAN_CONCURRENCY) || 128);
const DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY = Math.max(25, Number(process.env.DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY) || 500);
const DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS = Math.max(45, Number(process.env.DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS) || 60);
const DIVERGENCE_TABLE_BUILD_CONCURRENCY = Math.max(1, Number(process.env.DIVERGENCE_TABLE_BUILD_CONCURRENCY) || 24);
const DIVERGENCE_TABLE_MIN_COVERAGE_DAYS = Math.max(29, Number(process.env.DIVERGENCE_TABLE_MIN_COVERAGE_DAYS) || 29);
// Scheduler is intentionally hard-disabled for now; runs are manual-only.
const DIVERGENCE_SCANNER_ENABLED = false;
const DIVERGENCE_MIN_UNIVERSE_SIZE = Math.max(1, Number(process.env.DIVERGENCE_MIN_UNIVERSE_SIZE) || 500);
const DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE = Math.max(100, Number(process.env.DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE) || 2000);
const DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE = Math.max(
  1,
  Math.min(
    DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE,
    Number(process.env.DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE) || 100
  )
);
const DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE = Math.max(
  DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE,
  Number(process.env.DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE) || 500
);
const DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE = Math.max(1, Number(process.env.DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE) || 25);
const DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS = Math.max(28, Number(process.env.DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS) || 50);
const DIVERGENCE_FETCH_TICKER_TIMEOUT_MS = Math.max(5_000, Number(process.env.DIVERGENCE_FETCH_TICKER_TIMEOUT_MS) || 60_000);
const DIVERGENCE_FETCH_MA_TIMEOUT_MS = Math.max(5_000, Number(process.env.DIVERGENCE_FETCH_MA_TIMEOUT_MS) || 30_000);
const DIVERGENCE_STALL_TIMEOUT_MS = Math.max(30_000, Number(process.env.DIVERGENCE_STALL_TIMEOUT_MS) || 90_000);
const DIVERGENCE_STALL_CHECK_INTERVAL_MS = Math.max(1_000, Number(process.env.DIVERGENCE_STALL_CHECK_INTERVAL_MS) || 2_000);
const DIVERGENCE_STALL_RETRY_BASE_MS = Math.max(1_000, Number(process.env.DIVERGENCE_STALL_RETRY_BASE_MS) || 5_000);
const DIVERGENCE_STALL_MAX_RETRIES = Math.max(0, Math.floor(Number(process.env.DIVERGENCE_STALL_MAX_RETRIES) || 3));

// In-memory cache of daily OHLC bars populated during daily/weekly scans.
// Key: uppercase ticker, Value: array of { time, open, high, low, close }.
const miniBarsCacheByTicker = new Map();
const MINI_BARS_CACHE_MAX_TICKERS = 2000;

let divergenceScanRunning = false;
let divergenceSchedulerTimer = null;
let divergenceLastScanDateEt = '';
let divergenceLastFetchedTradeDateEt = '';
let divergenceScanPauseRequested = false;
let divergenceScanStopRequested = false;
let divergenceScanResumeState = null;
let divergenceScanAbortController = null;
let divergenceTableBuildRunning = false;
let divergenceTableBuildPauseRequested = false;
let divergenceTableBuildStopRequested = false;
let divergenceTableBuildResumeState = null;
let divergenceTableBuildAbortController = null;
let divergenceTableBuildStatus = {
  running: false,
  status: 'idle',
  totalTickers: 0,
  processedTickers: 0,
  errorTickers: 0,
  startedAt: null,
  finishedAt: null,
  lastPublishedTradeDate: ''
};
let divergenceFetchDailyDataRunning = false;
let divergenceFetchDailyDataStopRequested = false;
let divergenceFetchDailyDataAbortController = null;
let divergenceFetchDailyDataResumeState = null;
let divergenceFetchDailyDataStatus = {
  running: false,
  status: 'idle',
  totalTickers: 0,
  processedTickers: 0,
  errorTickers: 0,
  startedAt: null,
  finishedAt: null,
  lastPublishedTradeDate: ''
};
let divergenceFetchWeeklyDataRunning = false;
let divergenceFetchWeeklyDataStopRequested = false;
let divergenceFetchWeeklyDataAbortController = null;
let divergenceFetchWeeklyDataResumeState = null;
let divergenceFetchWeeklyDataStatus = {
  running: false,
  status: 'idle',
  totalTickers: 0,
  processedTickers: 0,
  errorTickers: 0,
  startedAt: null,
  finishedAt: null,
  lastPublishedTradeDate: ''
};

const RUN_METRICS_SAMPLE_CAP = Math.max(100, Number(process.env.RUN_METRICS_SAMPLE_CAP) || 1200);
const RUN_METRICS_HISTORY_LIMIT = Math.max(10, Number(process.env.RUN_METRICS_HISTORY_LIMIT) || 40);
const runMetricsByType = {
  fetchDaily: null,
  fetchWeekly: null,
  vdfScan: null
};
const runMetricsHistory = [];

function clampMetricNumber(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** Math.max(0, Number(digits) || 0);
  return Math.round(numeric * factor) / factor;
}

function percentileFromSortedSamples(samples, percentile) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const p = Math.max(0, Math.min(1, Number(percentile) || 0));
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * p) - 1));
  const value = Number(samples[index]);
  return Number.isFinite(value) ? value : 0;
}

function summarizeRunMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const samples = Array.isArray(metrics.api?.latencySamples)
    ? [...metrics.api.latencySamples].sort((a, b) => a - b)
    : [];
  const calls = Number(metrics.api?.calls || 0);
  const avgLatencyMs = calls > 0
    ? clampMetricNumber((Number(metrics.api?.totalLatencyMs || 0) / calls), 2)
    : 0;
  const startedMs = Date.parse(String(metrics.startedAt || ''));
  const finishedMs = Date.parse(String(metrics.finishedAt || metrics.updatedAt || ''));
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
    ? finishedMs - startedMs
    : 0;
  const durationSeconds = durationMs > 0 ? durationMs / 1000 : 0;
  const processed = Number(metrics.tickers?.processed || 0);
  return {
    runId: metrics.runId,
    runType: metrics.runType,
    status: String(metrics.status || 'unknown'),
    phase: String(metrics.phase || ''),
    startedAt: metrics.startedAt || null,
    finishedAt: metrics.finishedAt || null,
    updatedAt: metrics.updatedAt || null,
    durationSeconds: clampMetricNumber(durationSeconds, 2),
    tickers: {
      total: Number(metrics.tickers?.total || 0),
      processed,
      errors: Number(metrics.tickers?.errors || 0),
      processedPerSecond: durationSeconds > 0 ? clampMetricNumber(processed / durationSeconds, 3) : 0
    },
    api: {
      calls,
      successes: Number(metrics.api?.successes || 0),
      failures: Number(metrics.api?.failures || 0),
      rateLimited: Number(metrics.api?.rateLimited || 0),
      timedOut: Number(metrics.api?.timedOut || 0),
      aborted: Number(metrics.api?.aborted || 0),
      subscriptionRestricted: Number(metrics.api?.subscriptionRestricted || 0),
      avgLatencyMs,
      p50LatencyMs: clampMetricNumber(percentileFromSortedSamples(samples, 0.50), 2),
      p95LatencyMs: clampMetricNumber(percentileFromSortedSamples(samples, 0.95), 2)
    },
    db: {
      flushCount: Number(metrics.db?.flushCount || 0),
      dailyRows: Number(metrics.db?.dailyRows || 0),
      summaryRows: Number(metrics.db?.summaryRows || 0),
      signalRows: Number(metrics.db?.signalRows || 0),
      neutralRows: Number(metrics.db?.neutralRows || 0),
      avgFlushMs: Number(metrics.db?.flushCount || 0) > 0
        ? clampMetricNumber(Number(metrics.db?.totalFlushMs || 0) / Number(metrics.db?.flushCount || 1), 2)
        : 0,
      maxFlushMs: clampMetricNumber(Number(metrics.db?.maxFlushMs || 0), 2)
    },
    stalls: {
      retries: Number(metrics.stalls?.retries || 0),
      watchdogAborts: Number(metrics.stalls?.watchdogAborts || 0)
    },
    failedTickers: Array.isArray(metrics.failedTickers) ? [...metrics.failedTickers] : [],
    retryRecovered: Array.isArray(metrics.retryRecovered) ? [...metrics.retryRecovered] : [],
    meta: metrics.meta || {}
  };
}

function pushRunMetricsHistory(snapshot) {
  if (!snapshot) return;
  runMetricsHistory.unshift(snapshot);
  if (runMetricsHistory.length > RUN_METRICS_HISTORY_LIMIT) {
    runMetricsHistory.length = RUN_METRICS_HISTORY_LIMIT;
  }
  persistRunSnapshotToDb(snapshot);
}

const RUN_METRICS_DB_LIMIT = 15;

function persistRunSnapshotToDb(snapshot) {
  if (!snapshot || !snapshot.runId) return;
  pool.query(
    `INSERT INTO run_metrics_history (run_id, run_type, status, snapshot, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id) DO UPDATE SET status = $3, snapshot = $4, finished_at = $6`,
    [
      snapshot.runId,
      snapshot.runType || 'unknown',
      snapshot.status || 'unknown',
      JSON.stringify(snapshot),
      snapshot.startedAt || null,
      snapshot.finishedAt || null
    ]
  ).then(() => {
    // Prune old rows beyond the limit
    return pool.query(
      `DELETE FROM run_metrics_history WHERE id NOT IN (
         SELECT id FROM run_metrics_history ORDER BY created_at DESC LIMIT $1
       )`,
      [RUN_METRICS_DB_LIMIT]
    );
  }).catch(err => {
    console.error('Failed to persist run snapshot:', err.message);
  });
}

async function loadRunHistoryFromDb() {
  try {
    const result = await pool.query(
      `SELECT snapshot FROM run_metrics_history ORDER BY created_at DESC LIMIT $1`,
      [RUN_METRICS_DB_LIMIT]
    );
    return result.rows.map(r => r.snapshot);
  } catch (err) {
    console.error('Failed to load run history from DB:', err.message);
    return [];
  }
}

function createRunMetricsTracker(runType, meta = {}) {
  const normalizedType = String(runType || '').trim() || 'unknown';
  const runId = `${normalizedType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const metrics = {
    runId,
    runType: normalizedType,
    status: 'running',
    phase: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    updatedAt: new Date().toISOString(),
    tickers: {
      total: 0,
      processed: 0,
      errors: 0
    },
    api: {
      calls: 0,
      successes: 0,
      failures: 0,
      rateLimited: 0,
      timedOut: 0,
      aborted: 0,
      subscriptionRestricted: 0,
      totalLatencyMs: 0,
      latencySamples: []
    },
    db: {
      flushCount: 0,
      totalFlushMs: 0,
      maxFlushMs: 0,
      dailyRows: 0,
      summaryRows: 0,
      signalRows: 0,
      neutralRows: 0
    },
    stalls: {
      retries: 0,
      watchdogAborts: 0
    },
    failedTickers: [],
    retryRecovered: [],
    meta: {
      ...meta
    }
  };

  runMetricsByType[normalizedType] = metrics;
  let finished = false;

  const touch = () => {
    metrics.updatedAt = new Date().toISOString();
  };

  return {
    get runId() {
      return runId;
    },
    setMeta(patch = {}) {
      if (!patch || typeof patch !== 'object') return;
      metrics.meta = { ...metrics.meta, ...patch };
      touch();
    },
    setPhase(phase) {
      metrics.phase = String(phase || '').trim() || metrics.phase;
      touch();
    },
    setTotals(totalTickers) {
      metrics.tickers.total = Math.max(0, Number(totalTickers) || 0);
      touch();
    },
    setProgress(processedTickers, errorTickers) {
      metrics.tickers.processed = Math.max(0, Number(processedTickers) || 0);
      metrics.tickers.errors = Math.max(0, Number(errorTickers) || 0);
      touch();
    },
    recordApiCall(details = {}) {
      const latencyMs = Math.max(0, Number(details.latencyMs) || 0);
      metrics.api.calls += 1;
      metrics.api.totalLatencyMs += latencyMs;
      if (metrics.api.latencySamples.length >= RUN_METRICS_SAMPLE_CAP) {
        metrics.api.latencySamples.shift();
      }
      metrics.api.latencySamples.push(latencyMs);
      if (details.ok) {
        metrics.api.successes += 1;
      } else {
        metrics.api.failures += 1;
      }
      if (details.rateLimited) metrics.api.rateLimited += 1;
      if (details.timedOut) metrics.api.timedOut += 1;
      if (details.aborted) metrics.api.aborted += 1;
      if (details.subscriptionRestricted) metrics.api.subscriptionRestricted += 1;
      touch();
    },
    recordDbFlush(details = {}) {
      const durationMs = Math.max(0, Number(details.durationMs) || 0);
      metrics.db.flushCount += 1;
      metrics.db.totalFlushMs += durationMs;
      metrics.db.maxFlushMs = Math.max(metrics.db.maxFlushMs, durationMs);
      metrics.db.dailyRows += Math.max(0, Number(details.dailyRows) || 0);
      metrics.db.summaryRows += Math.max(0, Number(details.summaryRows) || 0);
      metrics.db.signalRows += Math.max(0, Number(details.signalRows) || 0);
      metrics.db.neutralRows += Math.max(0, Number(details.neutralRows) || 0);
      touch();
    },
    recordFailedTicker(ticker) {
      const name = String(ticker || '').trim().toUpperCase();
      if (name && metrics.failedTickers.length < 500) {
        metrics.failedTickers.push(name);
      }
      touch();
    },
    recordRetryRecovered(ticker) {
      const name = String(ticker || '').trim().toUpperCase();
      if (name && metrics.retryRecovered.length < 500) {
        metrics.retryRecovered.push(name);
      }
      // Also remove from failedTickers
      const idx = metrics.failedTickers.indexOf(name);
      if (idx !== -1) metrics.failedTickers.splice(idx, 1);
      touch();
    },
    recordStallRetry() {
      metrics.stalls.retries += 1;
      touch();
    },
    recordWatchdogAbort() {
      metrics.stalls.watchdogAborts += 1;
      touch();
    },
    finish(status, patch = {}) {
      if (finished) return summarizeRunMetrics(metrics);
      finished = true;
      metrics.status = String(status || 'completed').trim() || 'completed';
      if (patch && typeof patch === 'object') {
        if (Number.isFinite(Number(patch.totalTickers))) {
          metrics.tickers.total = Math.max(0, Number(patch.totalTickers));
        }
        if (Number.isFinite(Number(patch.processedTickers))) {
          metrics.tickers.processed = Math.max(0, Number(patch.processedTickers));
        }
        if (Number.isFinite(Number(patch.errorTickers))) {
          metrics.tickers.errors = Math.max(0, Number(patch.errorTickers));
        }
        if (patch.phase) {
          metrics.phase = String(patch.phase);
        }
        if (patch.meta && typeof patch.meta === 'object') {
          metrics.meta = { ...metrics.meta, ...patch.meta };
        }
      }
      metrics.finishedAt = new Date().toISOString();
      touch();
      const snapshot = summarizeRunMetrics(metrics);
      pushRunMetricsHistory(snapshot);
      return snapshot;
    },
    snapshot() {
      return summarizeRunMetrics(metrics);
    }
  };
}

function getLogsRunMetricsPayload() {
  return {
    generatedAt: new Date().toISOString(),
    schedulerEnabled: Boolean(DIVERGENCE_SCANNER_ENABLED),
    config: {
      divergenceSourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      divergenceLookbackDays: DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS,
      divergenceConcurrencyConfigured: DIVERGENCE_TABLE_BUILD_CONCURRENCY,
      divergenceFlushSize: DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE,
      dataApiBase: DATA_API_BASE,
      dataApiTimeoutMs: DATA_API_TIMEOUT_MS,
      dataApiMaxRequestsPerSecond: DATA_API_MAX_REQUESTS_PER_SECOND,
      dataApiRateBucketCapacity: DATA_API_RATE_BUCKET_CAPACITY
    },
    statuses: {
      fetchDaily: getDivergenceFetchDailyDataStatus(),
      fetchWeekly: getDivergenceFetchWeeklyDataStatus(),
      scan: getDivergenceScanControlStatus(),
      table: getDivergenceTableBuildStatus(),
      vdfScan: getVDFScanStatus()
    },
    runs: {
      fetchDaily: summarizeRunMetrics(runMetricsByType.fetchDaily),
      fetchWeekly: summarizeRunMetrics(runMetricsByType.fetchWeekly),
      vdfScan: summarizeRunMetrics(runMetricsByType.vdfScan)
    },
    history: runMetricsHistory.slice(0, RUN_METRICS_HISTORY_LIMIT)
  };
}

function isDivergenceConfigured() {
  return Boolean(divergencePool);
}

async function withDivergenceClient(fn) {
  if (!divergencePool) {
    throw new Error('DIVERGENCE_DATABASE_URL is not configured');
  }
  const client = await divergencePool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const initDB = async () => {
  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(20) NOT NULL,
        signal_type VARCHAR(10) NOT NULL,
        price DECIMAL(15, 2) NOT NULL,
        message TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        is_favorite BOOLEAN DEFAULT FALSE
      );
    `);

    // Create index concurrently to avoid locking table on startup
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_timestamp ON alerts (timestamp DESC)`);
    
    // Attempt to add new columns if they don't exist
    const columns = [
      "timeframe VARCHAR(10)",
      "signal_direction INTEGER",
      "signal_volume INTEGER",
      "intensity_score INTEGER",
      "combo_score INTEGER",
      "is_favorite BOOLEAN DEFAULT FALSE"
    ];

    await Promise.allSettled(columns.map(col =>
      pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ${col}`)
        .catch(e => console.log(`Migration note for ${col}:`, e.message))
    ));
    await pool.query(`
      CREATE TABLE IF NOT EXISTS run_metrics_history (
        id SERIAL PRIMARY KEY,
        run_id VARCHAR(120) NOT NULL UNIQUE,
        run_type VARCHAR(40) NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'unknown',
        snapshot JSONB NOT NULL,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_metrics_history_created ON run_metrics_history (created_at DESC)`);

    // Seed in-memory run history from persisted records
    const persisted = await loadRunHistoryFromDb();
    if (persisted.length > 0) {
      runMetricsHistory.push(...persisted);
      console.log(`Loaded ${persisted.length} persisted run history entries`);
    }

    console.log("Database initialized successfully");
  } catch (err) {
    console.error("Failed to initialize database:", err);
  }
};


const initDivergenceDB = async () => {
  if (!divergencePool) {
    console.log('Divergence DB not configured (set DIVERGENCE_DATABASE_URL to enable Divergence tab data).');
    return;
  }
  try {
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_signals (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(20) NOT NULL,
        signal_type VARCHAR(10) NOT NULL,
        trade_date DATE NOT NULL,
        price DECIMAL(15, 4) NOT NULL,
        prev_close DECIMAL(15, 4) NOT NULL,
        volume_delta DECIMAL(20, 4) NOT NULL,
        timeframe VARCHAR(10) NOT NULL DEFAULT '1d',
        source_interval VARCHAR(10) NOT NULL DEFAULT '1min',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
        scan_job_id INTEGER
      );
    `);
    await divergencePool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS divergence_signals_unique_key
      ON divergence_signals(trade_date, ticker, timeframe, source_interval);
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_scan_jobs (
        id SERIAL PRIMARY KEY,
        run_for_date DATE NOT NULL,
        scanned_trade_date DATE,
        status VARCHAR(20) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        total_symbols INTEGER NOT NULL DEFAULT 0,
        processed_symbols INTEGER NOT NULL DEFAULT 0,
        bullish_count INTEGER NOT NULL DEFAULT 0,
        bearish_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      );
    `);
    await divergencePool.query(`
      ALTER TABLE divergence_scan_jobs
      ADD COLUMN IF NOT EXISTS scanned_trade_date DATE
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_symbols (
        ticker VARCHAR(20) PRIMARY KEY,
        exchange VARCHAR(40),
        asset_type VARCHAR(40),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_daily_bars (
        ticker VARCHAR(20) NOT NULL,
        trade_date DATE NOT NULL,
        source_interval VARCHAR(10) NOT NULL DEFAULT '1min',
        close DECIMAL(15, 4) NOT NULL,
        prev_close DECIMAL(15, 4) NOT NULL,
        volume_delta DECIMAL(20, 4) NOT NULL,
        scan_job_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (ticker, trade_date, source_interval)
      );
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_daily_bars_trade_date_idx
      ON divergence_daily_bars(source_interval, trade_date DESC, ticker ASC);
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_summaries (
        ticker VARCHAR(20) NOT NULL,
        source_interval VARCHAR(10) NOT NULL DEFAULT '1min',
        trade_date DATE NOT NULL,
        state_1d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_3d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_7d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_14d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_28d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        ma8_above BOOLEAN,
        ma21_above BOOLEAN,
        ma50_above BOOLEAN,
        ma200_above BOOLEAN,
        scan_job_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (ticker, source_interval)
      );
    `);
    await divergencePool.query(`
      ALTER TABLE divergence_summaries
      ADD COLUMN IF NOT EXISTS ma8_above BOOLEAN
    `);
    await divergencePool.query(`
      ALTER TABLE divergence_summaries
      ADD COLUMN IF NOT EXISTS ma21_above BOOLEAN
    `);
    await divergencePool.query(`
      ALTER TABLE divergence_summaries
      ADD COLUMN IF NOT EXISTS ma50_above BOOLEAN
    `);
    await divergencePool.query(`
      ALTER TABLE divergence_summaries
      ADD COLUMN IF NOT EXISTS ma200_above BOOLEAN
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_summaries_trade_date_idx
      ON divergence_summaries(source_interval, trade_date DESC, ticker ASC);
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_signals_timeframe_tradedate_idx
      ON divergence_signals(source_interval, timeframe, trade_date DESC);
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_summaries_source_ticker_idx
      ON divergence_summaries(source_interval, ticker);
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_publication_state (
        source_interval VARCHAR(10) PRIMARY KEY,
        published_trade_date DATE,
        last_scan_job_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS vdf_results (
        ticker VARCHAR(20) NOT NULL,
        trade_date VARCHAR(10) NOT NULL,
        is_detected BOOLEAN NOT NULL DEFAULT FALSE,
        composite_score REAL DEFAULT 0,
        status TEXT DEFAULT '',
        weeks INTEGER DEFAULT 0,
        result_json TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (ticker, trade_date)
      );
    `);
    // Migration: rename htf_results -> vdf_results if old table exists
    await divergencePool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'htf_results') THEN
          DROP TABLE IF EXISTS htf_results;
        END IF;
      END $$;
    `);
    // Migration: add new columns for multi-zone detection, proximity signals
    await divergencePool.query(`
      DO $$ BEGIN
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS best_zone_score REAL DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS proximity_score REAL DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS proximity_level VARCHAR(10) DEFAULT 'none';
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS num_zones INTEGER DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS has_distribution BOOLEAN DEFAULT FALSE;
      END $$;
    `);
    // Restore in-memory status from persisted data so the UI shows correct
    // "Ran M/D" dates even after a server restart.
    try {
      const pubResult = await divergencePool.query(`
        SELECT published_trade_date::text AS trade_date
        FROM divergence_publication_state
        WHERE source_interval = $1
        LIMIT 1
      `, [DIVERGENCE_SOURCE_INTERVAL]);
      const restoredTradeDate = String(pubResult.rows[0]?.trade_date || '').trim();
      if (restoredTradeDate) {
        divergenceLastFetchedTradeDateEt = maxEtDateString(divergenceLastFetchedTradeDateEt, restoredTradeDate);
        divergenceFetchDailyDataStatus.lastPublishedTradeDate = maxEtDateString(
          divergenceFetchDailyDataStatus.lastPublishedTradeDate, restoredTradeDate
        );
      }

      const weeklyResult = await divergencePool.query(`
        SELECT MAX(trade_date)::text AS trade_date
        FROM divergence_signals
        WHERE timeframe = '1w'
          AND source_interval = $1
      `, [DIVERGENCE_SOURCE_INTERVAL]);
      const restoredWeeklyDate = String(weeklyResult.rows[0]?.trade_date || '').trim();
      if (restoredWeeklyDate) {
        divergenceFetchWeeklyDataStatus.lastPublishedTradeDate = maxEtDateString(
          divergenceFetchWeeklyDataStatus.lastPublishedTradeDate, restoredWeeklyDate
        );
      }
      if (restoredTradeDate || restoredWeeklyDate) {
        console.log(`Restored trade dates from DB — daily: ${restoredTradeDate || '(none)'}, weekly: ${restoredWeeklyDate || '(none)'}`);
      }
    } catch (restoreErr) {
      console.error('Failed to restore trade dates from DB:', restoreErr.message);
    }

    console.log('Divergence database initialized successfully');
  } catch (err) {
    console.error('Failed to initialize divergence database:', err);
  }
};

app.get('/api/alerts', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 0;
    const startDate = String(req.query.start_date || '').trim();
    const endDate = String(req.query.end_date || '').trim();
    const hasDateKeyRange = /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate);
    
    let query = 'SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100';
    let values = [];

    if (hasDateKeyRange) {
        // Optimized sargable query using timestamp range
        query = `
          SELECT *
          FROM alerts
          WHERE timestamp >= ($1 || ' 00:00:00 America/New_York')::timestamptz
            AND timestamp < ($2 || ' 00:00:00 America/New_York')::timestamptz + INTERVAL '1 day'
          ORDER BY timestamp DESC
          LIMIT 500
        `;
        values = [startDate, endDate];
    } else if (startDate && endDate) {
        query = `SELECT * FROM alerts WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 500`;
        values = [startDate, endDate];
    } else if (days > 0) {
        query = `SELECT * FROM alerts WHERE timestamp >= NOW() - $1::interval ORDER BY timestamp DESC LIMIT 500`;
        values = [`${days} days`];
    }
    
    const result = await pool.query(query, values);
    const sourceInterval = toVolumeDeltaSourceInterval(req.query.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
    const tickers = Array.from(new Set(
      result.rows
        .map((row) => String(row?.ticker || '').trim().toUpperCase())
        .filter(Boolean)
    ));
    let summariesByTicker = new Map();
    try {
      summariesByTicker = await getStoredDivergenceSummariesForTickers(
        tickers,
        sourceInterval,
        { includeLatestFallbackForMissing: true }
      );
    } catch (summaryErr) {
      const message = summaryErr && summaryErr.message ? summaryErr.message : String(summaryErr);
      console.error(`Failed to enrich TV alerts with divergence summaries: ${message}`);
    }
    const neutralStates = buildNeutralDivergenceStateMap();
    let vdfDataMapTv = new Map();
    try {
      if (tickers.length > 0 && isDivergenceConfigured()) {
        const vdfTradeDate = currentEtDateString();
        const vdfRes = await divergencePool.query(
          `SELECT ticker, best_zone_score, proximity_level, num_zones FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
          [vdfTradeDate, tickers]
        );
        for (const row of vdfRes.rows) {
          vdfDataMapTv.set(String(row.ticker).toUpperCase(), {
            score: Math.min(100, Math.round((Number(row.best_zone_score) || 0) * 100)),
            proximityLevel: row.proximity_level || 'none',
            numZones: Number(row.num_zones) || 0,
          });
        }
      }
    } catch {
      // Non-critical
    }
    const enrichedRows = result.rows.map((row) => {
      const ticker = String(row?.ticker || '').trim().toUpperCase();
      const summary = summariesByTicker.get(ticker) || null;
      const states = summary?.states || neutralStates;
      const vdfData = vdfDataMapTv.get(ticker);
      return {
        ...row,
        divergence_trade_date: summary?.tradeDate || null,
        ma_states: {
          ema8: Boolean(summary?.maStates?.ema8),
          ema21: Boolean(summary?.maStates?.ema21),
          sma50: Boolean(summary?.maStates?.sma50),
          sma200: Boolean(summary?.maStates?.sma200)
        },
        divergence_states: {
          '1': String(states['1'] || 'neutral'),
          '3': String(states['3'] || 'neutral'),
          '7': String(states['7'] || 'neutral'),
          '14': String(states['14'] || 'neutral'),
          '28': String(states['28'] || 'neutral')
        },
        vdf_detected: !!vdfData,
        vdf_score: vdfData?.score || 0,
        vdf_proximity: vdfData?.proximityLevel || 'none',
      };
    });
    res.json(enrichedRows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/api/alerts/:id/favorite', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid alert ID' });
    }
    const { is_favorite } = req.body;

    try {
        let query;
        let values;
        
        if (typeof is_favorite === 'boolean') {
            query = 'UPDATE alerts SET is_favorite = $1 WHERE id = $2 RETURNING *';
            values = [is_favorite, id];
        } else {
            // Toggle
             query = 'UPDATE alerts SET is_favorite = NOT is_favorite WHERE id = $1 RETURNING *';
             values = [id];
        }
        
        const result = await pool.query(query, values);
        if (result.rows.length === 0) {
            return res.status(404).send('Alert not found');
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error toggling favorite:', err);
        res.status(500).send('Server Error');
    }
});

app.get('/api/divergence/signals', async (req, res) => {
  if (!isDivergenceConfigured()) {
    return res.status(503).json({ error: 'Divergence database is not configured' });
  }
  try {
    const days = parseInt(req.query.days) || 0;
    const startDate = String(req.query.start_date || '').trim();
    const endDate = String(req.query.end_date || '').trim();
    const hasDateKeyRange = /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate);
    const timeframeParam = req.query.timeframe; // optional: '1d' or '1w'
    const allowedTimeframes = timeframeParam === '1d' ? ['1d'] : timeframeParam === '1w' ? ['1w'] : ['1d', '1w'];
    const publishedTradeDate = await getPublishedTradeDateForSourceInterval(DIVERGENCE_SOURCE_INTERVAL);
    if (!publishedTradeDate && divergenceScanRunning) {
      return res.json([]);
    }

    const PER_TIMEFRAME_SIGNAL_LIMIT = 3029;
    let query = 'SELECT * FROM divergence_signals ORDER BY timestamp DESC LIMIT 100';
    let values = [];

    if (hasDateKeyRange) {
      query = `
        WITH filtered AS (
          SELECT
            id,
            ticker,
            signal_type,
            price,
            trade_date,
            timestamp,
            timeframe,
            volume_delta,
            is_favorite,
            ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
          FROM divergence_signals
          WHERE trade_date >= $1::date
            AND trade_date <= $2::date
            AND timeframe = ANY($5::text[])
            AND ($3::date IS NULL OR trade_date <= $3::date)
        )
        SELECT
          id,
          ticker,
          signal_type,
          price,
          trade_date::text AS signal_trade_date,
          timestamp,
          timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume,
          0 AS intensity_score,
          0 AS combo_score,
          is_favorite
        FROM filtered
        WHERE timeframe_rank <= $4
        ORDER BY trade_date DESC, timestamp DESC
      `;
      values = [startDate, endDate, publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
    } else if (days > 0) {
      const lookbackDays = Math.max(1, Math.floor(Number(days) || 1));
      const endTradeDate = currentEtDateString();
      const startTradeDate = dateKeyDaysAgo(endTradeDate, lookbackDays - 1) || endTradeDate;
      query = `
        WITH filtered AS (
          SELECT
            id,
            ticker,
            signal_type,
            price,
            trade_date,
            timestamp,
            timeframe,
            volume_delta,
            is_favorite,
            ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
          FROM divergence_signals
          WHERE trade_date >= $1::date
            AND trade_date <= $2::date
            AND timeframe = ANY($5::text[])
            AND ($3::date IS NULL OR trade_date <= $3::date)
        )
        SELECT
          id,
          ticker,
          signal_type,
          price,
          trade_date::text AS signal_trade_date,
          timestamp,
          timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume,
          0 AS intensity_score,
          0 AS combo_score,
          is_favorite
        FROM filtered
        WHERE timeframe_rank <= $4
        ORDER BY trade_date DESC, timestamp DESC
      `;
      values = [startTradeDate, endTradeDate, publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
    } else {
      query = `
        WITH filtered AS (
          SELECT
            id,
            ticker,
            signal_type,
            price,
            trade_date,
            timestamp,
            timeframe,
            volume_delta,
            is_favorite,
            ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
          FROM divergence_signals
          WHERE timeframe = ANY($3::text[])
            AND ($1::date IS NULL OR trade_date <= $1::date)
        )
        SELECT
          id,
          ticker,
          signal_type,
          price,
          trade_date::text AS signal_trade_date,
          timestamp,
          timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume,
          0 AS intensity_score,
          0 AS combo_score,
          is_favorite
        FROM filtered
        WHERE timeframe_rank <= $2
        ORDER BY trade_date DESC, timestamp DESC
      `;
      values = [publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
    }

    const result = await divergencePool.query(query, values);
    const sourceInterval = toVolumeDeltaSourceInterval(req.query.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
    const tickers = Array.from(new Set(
      result.rows
        .map((row) => String(row?.ticker || '').trim().toUpperCase())
        .filter(Boolean)
    ));
    let summariesByTicker = new Map();
    try {
      summariesByTicker = await getStoredDivergenceSummariesForTickers(
        tickers,
        sourceInterval,
        { includeLatestFallbackForMissing: true }
      );
    } catch (summaryErr) {
      const message = summaryErr && summaryErr.message ? summaryErr.message : String(summaryErr);
      console.error(`Failed to enrich divergence signals with divergence summaries: ${message}`);
    }
    const neutralStates = buildNeutralDivergenceStateMap();
    // Enrich with VDF detection results
    let vdfDataMap = new Map();
    try {
      if (tickers.length > 0) {
        const vdfTradeDate = currentEtDateString();
        const vdfRes = await divergencePool.query(
          `SELECT ticker, best_zone_score, proximity_level, num_zones FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
          [vdfTradeDate, tickers]
        );
        for (const row of vdfRes.rows) {
          vdfDataMap.set(String(row.ticker).toUpperCase(), {
            score: Math.min(100, Math.round((Number(row.best_zone_score) || 0) * 100)),
            proximityLevel: row.proximity_level || 'none',
            numZones: Number(row.num_zones) || 0,
          });
        }
      }
    } catch {
      // Non-critical: if vdf_results table doesn't exist yet or query fails, skip silently
    }
    const enrichedRows = result.rows.map((row) => {
      const ticker = String(row?.ticker || '').trim().toUpperCase();
      const summary = summariesByTicker.get(ticker) || null;
      const states = summary?.states || neutralStates;
      const vdfData = vdfDataMap.get(ticker);
      return {
        ...row,
        divergence_trade_date: summary?.tradeDate || null,
        ma_states: {
          ema8: Boolean(summary?.maStates?.ema8),
          ema21: Boolean(summary?.maStates?.ema21),
          sma50: Boolean(summary?.maStates?.sma50),
          sma200: Boolean(summary?.maStates?.sma200)
        },
        divergence_states: {
          '1': String(states['1'] || 'neutral'),
          '3': String(states['3'] || 'neutral'),
          '7': String(states['7'] || 'neutral'),
          '14': String(states['14'] || 'neutral'),
          '28': String(states['28'] || 'neutral')
        },
        vdf_detected: !!vdfData,
        vdf_score: vdfData?.score || 0,
        vdf_proximity: vdfData?.proximityLevel || 'none',
      };
    });
    res.json(enrichedRows);
  } catch (err) {
    console.error('Divergence API error:', err);
    res.status(500).json({ error: 'Failed to fetch divergence signals' });
  }
});

app.post('/api/divergence/signals/:id/favorite', async (req, res) => {
  if (!isDivergenceConfigured()) {
    return res.status(503).json({ error: 'Divergence database is not configured' });
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid signal ID' });
  }
  const { is_favorite } = req.body;
  try {
    let query;
    let values;
    if (typeof is_favorite === 'boolean') {
      query = `
        UPDATE divergence_signals
        SET is_favorite = $1
        WHERE id = $2
        RETURNING
          id,
          ticker,
          signal_type,
          price,
          timestamp,
          timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume,
          0 AS intensity_score,
          0 AS combo_score,
          is_favorite
      `;
      values = [is_favorite, id];
    } else {
      query = `
        UPDATE divergence_signals
        SET is_favorite = NOT is_favorite
        WHERE id = $1
        RETURNING
          id,
          ticker,
          signal_type,
          price,
          timestamp,
          timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume,
          0 AS intensity_score,
          0 AS combo_score,
          is_favorite
      `;
      values = [id];
    }
    const result = await divergencePool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Signal not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error toggling divergence favorite:', err);
    res.status(500).json({ error: 'Server Error' });
  }
});

// --- DataAPI (market data provider) helpers ---
const DATA_API_KEY = process.env.DATA_API_KEY || '';
const DATA_API_BASE = 'https://api.massive.com';
const DATA_API_TIMEOUT_MS = 15000;
const DATA_API_REQUESTS_PAUSED = String(process.env.DATA_API_REQUESTS_PAUSED || 'false').toLowerCase() === 'true';
const DATA_API_MAX_REQUESTS_PER_SECOND = Math.max(
  1,
  Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 95
);
const DATA_API_RATE_BUCKET_CAPACITY = Math.max(
  1,
  Number(process.env.DATA_API_RATE_BUCKET_CAPACITY) || DATA_API_MAX_REQUESTS_PER_SECOND
);
let dataApiRateTokens = DATA_API_RATE_BUCKET_CAPACITY;
let dataApiRateLastRefillMs = Date.now();

function buildDataApiUrl(path, params = {}) {
  const normalizedBase = DATA_API_BASE.replace(/\/+$/, '');
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(`${normalizedBase}/${normalizedPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function sanitizeDataApiUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('apiKey')) parsed.searchParams.set('apiKey', '***');
    if (parsed.searchParams.has('apikey')) parsed.searchParams.set('apikey', '***');
    return parsed.toString();
  } catch {
    return url;
  }
}

function parseJsonSafe(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractDataApiError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (String(payload.status || '').toUpperCase() === 'ERROR') {
    return String(payload.error || payload.message || 'DataAPI returned ERROR status').trim();
  }
  const candidates = [
    payload.error,
    payload.message,
    payload['Error Message'],
    payload['Error message'],
    payload.Note
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.results)) return payload.results;
  if (payload && Array.isArray(payload.historical)) return payload.historical;
  return null;
}

function normalizeTickerSymbol(rawSymbol) {
  return String(rawSymbol || '').trim().toUpperCase();
}

function getDataApiSymbolCandidates(rawSymbol) {
  const symbol = normalizeTickerSymbol(rawSymbol);
  const candidates = [];
  const pushUnique = (value) => {
    const next = normalizeTickerSymbol(value);
    if (!next || candidates.includes(next)) return;
    candidates.push(next);
  };

  pushUnique(symbol);
  if (symbol.includes('.')) pushUnique(symbol.replace(/\./g, '-'));
  if (symbol.includes('-')) pushUnique(symbol.replace(/-/g, '.'));
  if (symbol.includes('/')) {
    pushUnique(symbol.replace(/\//g, '.'));
    pushUnique(symbol.replace(/\//g, '-'));
  }

  return candidates;
}

function assertDataApiKey() {
  if (!DATA_API_KEY) {
    throw new Error('DATA_API_KEY is not configured on the server');
  }
}

function isDataApiRequestsPaused() {
  return DATA_API_REQUESTS_PAUSED;
}

function buildDataApiPausedError(message) {
  const err = new Error(message || 'Market-data requests are paused by server configuration');
  err.httpStatus = 503;
  err.isDataApiPaused = true;
  return err;
}

function isDataApiPausedError(err) {
  return Boolean(err && err.isDataApiPaused);
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const message = String(err.message || err || '');
  return name === 'AbortError'
    || Number(err.httpStatus) === 499
    || /aborted|aborterror/i.test(message);
}

function buildRequestAbortError(message) {
  const err = new Error(message || 'Request aborted');
  err.name = 'AbortError';
  err.httpStatus = 499;
  return err;
}

function buildTaskTimeoutError(message, timeoutMs) {
  const err = new Error(`${message || 'Task'} timed out after ${timeoutMs}ms`);
  err.httpStatus = 504;
  err.isTaskTimeout = true;
  return err;
}

function refillDataApiRateTokens(nowMs) {
  const now = Number(nowMs) || Date.now();
  const elapsedMs = Math.max(0, now - dataApiRateLastRefillMs);
  if (elapsedMs <= 0) return;
  const refillPerMs = DATA_API_MAX_REQUESTS_PER_SECOND / 1000;
  dataApiRateTokens = Math.min(
    DATA_API_RATE_BUCKET_CAPACITY,
    dataApiRateTokens + (elapsedMs * refillPerMs)
  );
  dataApiRateLastRefillMs = now;
}

function sleepWithAbort(ms, signal) {
  const waitMs = Math.max(1, Math.ceil(Number(ms) || 0));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      fn();
    };
    const onAbort = () => done(() => reject(buildRequestAbortError('Request aborted while waiting for DataAPI rate-limit slot')));
    const timer = setTimeout(() => done(resolve), waitMs);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function linkAbortSignalToController(parentSignal, controller) {
  if (!parentSignal || !controller) return () => {};
  const forwardAbort = () => {
    try {
      controller.abort();
    } catch {
      // Ignore duplicate abort errors.
    }
  };
  if (parentSignal.aborted) {
    forwardAbort();
    return () => {};
  }
  parentSignal.addEventListener('abort', forwardAbort);
  return () => {
    parentSignal.removeEventListener('abort', forwardAbort);
  };
}

async function runWithAbortAndTimeout(task, options = {}) {
  const label = String(options.label || 'Task').trim() || 'Task';
  const parentSignal = options.signal || null;
  const timeoutMs = Math.max(0, Math.floor(Number(options.timeoutMs) || 0));
  if (timeoutMs <= 0) {
    return task(parentSignal);
  }
  if (parentSignal && parentSignal.aborted) {
    throw buildRequestAbortError(`${label} aborted`);
  }

  const controller = new AbortController();
  const unlinkAbort = linkAbortSignalToController(parentSignal, controller);
  
  let timeoutTimer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // Ignore duplicate abort calls.
      }
      reject(buildTaskTimeoutError(label, timeoutMs));
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }
  });

  try {
    return await Promise.race([
      task(controller.signal),
      timeoutPromise
    ]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    unlinkAbort();
  }
}

function createProgressStallWatchdog(onStall) {
  let lastProgressMs = Date.now();
  let stalled = false;
  const timer = setInterval(() => {
    if (stalled) return;
    if ((Date.now() - lastProgressMs) < DIVERGENCE_STALL_TIMEOUT_MS) return;
    stalled = true;
    try {
      onStall();
    } catch {
      // Ignore stall callback errors.
    }
  }, DIVERGENCE_STALL_CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return {
    markProgress() {
      lastProgressMs = Date.now();
    },
    stop() {
      clearInterval(timer);
    },
    isStalled() {
      return stalled;
    }
  };
}

function getStallRetryBackoffMs(retryAttempt) {
  const attempt = Math.max(1, Math.floor(Number(retryAttempt) || 1));
  const delay = DIVERGENCE_STALL_RETRY_BASE_MS * (2 ** (attempt - 1));
  return Math.min(60_000, delay);
}

async function acquireDataApiRateLimitSlot(signal) {
  while (true) {
    if (signal && signal.aborted) {
      throw buildRequestAbortError('Request aborted while waiting for DataAPI rate-limit slot');
    }
    const now = Date.now();
    refillDataApiRateTokens(now);
    if (dataApiRateTokens >= 1) {
      dataApiRateTokens -= 1;
      return;
    }
    const missingTokens = Math.max(0, 1 - dataApiRateTokens);
    const waitMs = Math.ceil((missingTokens * 1000) / DATA_API_MAX_REQUESTS_PER_SECOND);
    await sleepWithAbort(Math.max(1, waitMs), signal);
  }
}

function isDataApiRateLimitedError(err) {
  const message = String(err && err.message ? err.message : err || '');
  return /(?:^|[^0-9])429(?:[^0-9]|$)|Limit Reach|Too Many Requests|rate limit/i.test(message)
    || (err && (err.isDataApiRateLimited === true || Number(err.httpStatus) === 429));
}

function buildDataApiRateLimitedError(message) {
  const err = new Error(message || 'Market-data provider rate limit reached');
  err.httpStatus = 429;
  err.isDataApiRateLimited = true;
  return err;
}

function withDataApiKey(url) {
  const parsed = new URL(url, DATA_API_BASE);
  if (!parsed.searchParams.has('apiKey')) {
    parsed.searchParams.set('apiKey', DATA_API_KEY);
  }
  return parsed.toString();
}

async function fetchDataApiJson(url, label, options = {}) {
  assertDataApiKey();
  if (isDataApiRequestsPaused()) {
    throw buildDataApiPausedError(`${label} requests are paused by server configuration`);
  }

  const externalSignal = options && options.signal ? options.signal : null;
  const metricsTracker = options && options.metricsTracker ? options.metricsTracker : null;
  const requestStartedMs = Date.now();
  await acquireDataApiRateLimitSlot(externalSignal);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DATA_API_TIMEOUT_MS);
  const forwardAbort = () => {
    try {
      controller.abort();
    } catch {
      // Ignore duplicate abort errors.
    }
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }
  try {
    const requestUrl = withDataApiKey(url);
    const resp = await fetch(requestUrl, { signal: controller.signal });
    const text = await resp.text();
    const payload = parseJsonSafe(text);
    const apiError = extractDataApiError(payload);
    const bodyText = apiError || (typeof text === 'string' ? text.trim().slice(0, 180) : '');

    if (!resp.ok) {
      if (resp.status === 429) {
        throw buildDataApiRateLimitedError(`${label} request failed (429): ${bodyText || 'Too Many Requests'}`);
      }
      const details = bodyText || `HTTP ${resp.status}`;
      const error = new Error(`${label} request failed (${resp.status}): ${details}`);
      error.httpStatus = resp.status;
      if (resp.status === 403 && /plan\s+doesn'?t\s+include\s+this\s+data\s+timeframe|subscription|restricted endpoint/i.test(details)) {
        error.isDataApiSubscriptionRestricted = true;
      }
      throw error;
    }

    if (apiError) {
      if (/Limit Reach|Too Many Requests|rate limit/i.test(apiError)) {
        throw buildDataApiRateLimitedError(`${label} request failed (429): ${apiError}`);
      }
      const error = new Error(`${label} API error: ${apiError}`);
      if (/plan\s+doesn'?t\s+include\s+this\s+data\s+timeframe|subscription|restricted endpoint/i.test(apiError)) {
        error.isDataApiSubscriptionRestricted = true;
      }
      throw error;
    }

    if (metricsTracker && typeof metricsTracker.recordApiCall === 'function') {
      metricsTracker.recordApiCall({
        latencyMs: Date.now() - requestStartedMs,
        ok: true
      });
    }
    return payload;
  } catch (err) {
    if (metricsTracker && typeof metricsTracker.recordApiCall === 'function') {
      metricsTracker.recordApiCall({
        latencyMs: Date.now() - requestStartedMs,
        ok: false,
        rateLimited: isDataApiRateLimitedError(err),
        timedOut: timedOut === true,
        aborted: isAbortError(err),
        subscriptionRestricted: isDataApiSubscriptionRestrictedError(err)
      });
    }
    if (isAbortError(err)) {
      if (externalSignal && externalSignal.aborted) {
        const abortError = new Error(`${label} request aborted`);
        abortError.name = 'AbortError';
        abortError.httpStatus = 499;
        throw abortError;
      }
      if (timedOut) {
        const timeoutError = new Error(`${label} request timed out after ${DATA_API_TIMEOUT_MS}ms`);
        timeoutError.httpStatus = 504;
        throw timeoutError;
      }
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', forwardAbort);
    }
  }
}

async function fetchDataApiArrayWithFallback(label, urls, options = {}) {
  assertDataApiKey();
  let lastError = null;
  let sawEmptyResult = false;

  for (const url of urls) {
    try {
      const payload = await fetchDataApiJson(url, label, options);
      const rows = toArrayPayload(payload);
      if (!rows) {
        throw new Error(`${label} returned unexpected payload shape`);
      }
      if (rows.length === 0) {
        sawEmptyResult = true;
        continue;
      }
      return rows;
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      console.error(`${label} fetch failed (${sanitizeDataApiUrl(url)}): ${message}`);
      if (isDataApiRateLimitedError(err) || isDataApiPausedError(err)) {
        break;
      }
    }
  }

  if (sawEmptyResult) return [];
  throw lastError || new Error(`${label} request failed`);
}

const DATA_API_AGG_INTERVAL_MAP = {
  '1min': { multiplier: 1, timespan: 'minute' },
  '5min': { multiplier: 5, timespan: 'minute' },
  '15min': { multiplier: 15, timespan: 'minute' },
  '30min': { multiplier: 30, timespan: 'minute' },
  '1hour': { multiplier: 1, timespan: 'hour' },
  '4hour': { multiplier: 4, timespan: 'hour' },
  '1day': { multiplier: 1, timespan: 'day' },
  '1week': { multiplier: 1, timespan: 'week' }
};

function getDataApiAggConfig(interval) {
  return DATA_API_AGG_INTERVAL_MAP[String(interval || '').trim()] || null;
}

function buildDataApiAggregateRangeUrl(symbol, interval, options = {}) {
  const config = getDataApiAggConfig(interval);
  if (!config) {
    throw new Error(`Unsupported interval for DataAPI aggregates: ${interval}`);
  }
  const endDate = String(options.to || formatDateUTC(new Date())).trim();
  const startDate = String(options.from || formatDateUTC(addUtcDays(new Date(), -30))).trim();
  return buildDataApiUrl(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${config.multiplier}/${config.timespan}/${startDate}/${endDate}`,
    {
      adjusted: 'true',
      sort: 'asc',
      limit: 50000
    }
  );
}

function normalizeUnixSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 1e12) return Math.floor(numeric / 1000);
  if (numeric > 1e10) return Math.floor(numeric / 1000);
  return Math.floor(numeric);
}

async function dataApiDailySingle(symbol) {
  const end = new Date();
  const start = addUtcDays(end, -400);
  const url = buildDataApiAggregateRangeUrl(symbol, '1day', {
    from: formatDateUTC(start),
    to: formatDateUTC(end)
  });
  const rows = await fetchDataApiArrayWithFallback('DataAPI daily', [url]);
  const normalized = rows.map((row) => {
    const time = normalizeUnixSeconds(row.t ?? row.timestamp ?? row.time);
    const close = toNumberOrNull(row.c ?? row.close ?? row.price);
    const open = toNumberOrNull(row.o ?? row.open) ?? close;
    const high = toNumberOrNull(row.h ?? row.high) ?? close;
    const low = toNumberOrNull(row.l ?? row.low) ?? close;
    const volume = toNumberOrNull(row.v ?? row.volume) ?? 0;
    const date = Number.isFinite(time) ? etDateStringFromUnixSeconds(time) : '';

    if (!date || close === null || open === null || high === null || low === null) {
      return null;
    }

    const boundedHigh = Math.max(high, open, close);
    const boundedLow = Math.min(low, open, close);
    return { date, open, high: boundedHigh, low: boundedLow, close, volume };
  }).filter(Boolean);
  return normalized.length ? normalized : null;
}

async function dataApiDaily(symbol) {
  const candidates = getDataApiSymbolCandidates(symbol);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const rows = await dataApiDailySingle(candidate);
      if (rows && rows.length > 0) {
        if (candidate !== normalizeTickerSymbol(symbol)) {
          console.log(`DataAPI symbol fallback (daily): ${symbol} -> ${candidate}`);
        }
        return rows;
      }
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      console.error(`DataAPI daily failed for ${candidate} (requested ${symbol}): ${message}`);
    }
  }

  if (lastError) throw lastError;
  return null;
}

function extractLatestIndicatorValue(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const directResults = Array.isArray(payload.results) ? payload.results : [];
  if (directResults.length > 0) {
    const first = directResults[0] || {};
    const directValue = toNumberOrNull(first.value ?? first.v ?? first.close ?? first.c);
    if (directValue !== null) return directValue;
    if (Array.isArray(first.values) && first.values.length > 0) {
      const nested = first.values[0] || {};
      const nestedValue = toNumberOrNull(nested.value ?? nested.v ?? nested.close ?? nested.c);
      if (nestedValue !== null) return nestedValue;
    }
  }
  const values = payload.results && Array.isArray(payload.results.values)
    ? payload.results.values
    : (Array.isArray(payload.values) ? payload.values : []);
  if (values.length > 0) {
    const first = values[0] || {};
    const nestedValue = toNumberOrNull(first.value ?? first.v ?? first.close ?? first.c);
    if (nestedValue !== null) return nestedValue;
  }
  return null;
}

async function fetchDataApiIndicatorLatestValue(symbol, indicatorType, windowLength, options = {}) {
  const ticker = normalizeTickerSymbol(symbol);
  const type = String(indicatorType || '').trim().toLowerCase();
  const window = Math.max(1, Math.floor(Number(windowLength) || 1));
  if (!ticker || !type) throw new Error('Invalid indicator request');

  const candidates = getDataApiSymbolCandidates(ticker);
  let lastError = null;

  for (const candidate of candidates) {
    const url = buildDataApiUrl(`/v1/indicators/${encodeURIComponent(type)}/${encodeURIComponent(candidate)}`, {
      timespan: 'day',
      window: String(window),
      series_type: 'close',
      order: 'desc',
      limit: '1'
    });
    try {
      const payload = await fetchDataApiJson(url, `DataAPI ${type}${window} ${candidate}`, options);
      const value = extractLatestIndicatorValue(payload);
      if (value !== null) {
        if (candidate !== ticker) {
          console.log(`DataAPI symbol fallback (${type}${window}): ${ticker} -> ${candidate}`);
        }
        return value;
      }
      lastError = new Error(`DataAPI ${type}${window} returned no value for ${candidate}`);
    } catch (err) {
      lastError = err;
      if (isDataApiRateLimitedError(err) || isDataApiPausedError(err) || isAbortError(err)) {
        throw err;
      }
    }
  }

  throw lastError || new Error(`DataAPI ${type}${window} request failed for ${ticker}`);
}

async function fetchDataApiMovingAverageStatesForTicker(ticker, latestClose, options = {}) {
  const close = Number(latestClose);
  if (!Number.isFinite(close) || close <= 0) {
    return null;
  }
  const signal = options && options.signal ? options.signal : null;
  const metricsTracker = options && options.metricsTracker ? options.metricsTracker : null;
  const [ema8, ema21, sma50, sma200] = await Promise.all([
    fetchDataApiIndicatorLatestValue(ticker, 'ema', 8, { signal, metricsTracker }),
    fetchDataApiIndicatorLatestValue(ticker, 'ema', 21, { signal, metricsTracker }),
    fetchDataApiIndicatorLatestValue(ticker, 'sma', 50, { signal, metricsTracker }),
    fetchDataApiIndicatorLatestValue(ticker, 'sma', 200, { signal, metricsTracker })
  ]);
  return {
    ema8: close > ema8,
    ema21: close > ema21,
    sma50: close > sma50,
    sma200: close > sma200
  };
}

function normalizeQuoteTimestamp(value) {
  if (Number.isFinite(Number(value))) {
    const numeric = Number(value);
    if (numeric > 1e12) return Math.floor(numeric / 1000);
    if (numeric > 1e10) return Math.floor(numeric / 1000);
    return Math.floor(numeric);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsedMs = Date.parse(value.trim());
    if (Number.isFinite(parsedMs)) {
      return Math.floor(parsedMs / 1000);
    }
  }
  return null;
}

function toQuoteRow(payload) {
  if (Array.isArray(payload)) return payload[0] || null;
  if (payload && Array.isArray(payload.data)) return payload.data[0] || null;
  if (payload && Array.isArray(payload.quote)) return payload.quote[0] || null;
  if (payload && typeof payload === 'object') return payload;
  return null;
}

async function dataApiQuoteSingle(symbol) {
  void symbol;
  return null;
}

async function dataApiLatestQuote(symbol) {
  void symbol;
  return null;
}

function patchLatestBarCloseWithQuote(result, quote) {
  if (!result || !Array.isArray(result.bars) || result.bars.length === 0) return;
  const quotePrice = Number(quote && quote.price);
  if (!Number.isFinite(quotePrice) || quotePrice <= 0) return;

  const bars = result.bars;
  const lastIndex = bars.length - 1;
  const last = bars[lastIndex];
  const open = Number(last && last.open);
  const high = Number(last && last.high);
  const low = Number(last && last.low);

  const boundedHigh = Number.isFinite(high)
    ? Math.max(high, quotePrice, Number.isFinite(open) ? open : quotePrice)
    : quotePrice;
  const boundedLow = Number.isFinite(low)
    ? Math.min(low, quotePrice, Number.isFinite(open) ? open : quotePrice)
    : quotePrice;

  bars[lastIndex] = {
    ...last,
    close: quotePrice,
    high: boundedHigh,
    low: boundedLow
  };

  // Keep RSI aligned with the patched latest close.
  const closePrices = bars.map((bar) => Number(bar.close));
  const rsiValues = calculateRSI(closePrices, 14);
  const patchedRsi = [];
  for (let i = 0; i < bars.length; i++) {
    const raw = rsiValues[i];
    if (!Number.isFinite(raw)) continue;
    patchedRsi.push({
      time: bars[i].time,
      value: Math.round(raw * 100) / 100
    });
  }
  result.rsi = patchedRsi;
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isDataApiSubscriptionRestrictedError(err) {
  const message = String(err && err.message ? err.message : err || '');
  return Boolean(err && err.isDataApiSubscriptionRestricted)
    || /Restricted Endpoint|Legacy Endpoint|current subscription|plan\s+doesn'?t\s+include\s+this\s+data\s+timeframe|data timeframe/i.test(message);
}

const VD_RSI_REGULAR_HOURS_CACHE_MS = 2 * 60 * 60 * 1000;
const VD_RSI_LOWER_TF_CACHE = new Map();
const VD_RSI_RESULT_CACHE = new Map();
const CHART_DATA_CACHE = new Map(); // Cache for provider intraday chart data
const CHART_QUOTE_CACHE = new Map();
const CHART_IN_FLIGHT_REQUESTS = new Map();
const CHART_FINAL_RESULT_CACHE = new Map();
const CHART_RESULT_CACHE_TTL_SECONDS = Math.max(0, Number(process.env.CHART_RESULT_CACHE_TTL_SECONDS) || 300);
const CHART_RESPONSE_MAX_AGE_SECONDS = Math.max(0, Number(process.env.CHART_RESPONSE_MAX_AGE_SECONDS) || 15);
const CHART_RESPONSE_SWR_SECONDS = Math.max(0, Number(process.env.CHART_RESPONSE_SWR_SECONDS) || 45);
const CHART_RESPONSE_COMPRESS_MIN_BYTES = Math.max(0, Number(process.env.CHART_RESPONSE_COMPRESS_MIN_BYTES) || 1024);
const CHART_TIMING_LOG_ENABLED = String(process.env.CHART_TIMING_LOG || '').toLowerCase() === 'true';
const CHART_QUOTE_CACHE_MS = Math.max(1000, Number(process.env.CHART_QUOTE_CACHE_MS) || 300_000);
const VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES) || 6000);
const VD_RSI_RESULT_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.VD_RSI_RESULT_CACHE_MAX_ENTRIES) || 6000);
const CHART_DATA_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.CHART_DATA_CACHE_MAX_ENTRIES) || 6000);
const CHART_QUOTE_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.CHART_QUOTE_CACHE_MAX_ENTRIES) || 4000);
const CHART_FINAL_RESULT_CACHE_MAX_ENTRIES = Math.max(1, Number(process.env.CHART_FINAL_RESULT_CACHE_MAX_ENTRIES) || 4000);
const VALID_CHART_INTERVALS = ['5min', '15min', '30min', '1hour', '4hour', '1day', '1week'];
const VOLUME_DELTA_SOURCE_INTERVALS = ['1min', '5min', '15min', '30min', '1hour', '4hour'];
const DIVERGENCE_LOOKBACK_DAYS = [1, 3, 7, 14, 28];
const DIVERGENCE_SUMMARY_BUILD_CONCURRENCY = Math.max(1, Number(process.env.DIVERGENCE_SUMMARY_BUILD_CONCURRENCY) || 64);
const DIVERGENCE_ON_DEMAND_REFRESH_COOLDOWN_MS = Math.max(0, Number(process.env.DIVERGENCE_ON_DEMAND_REFRESH_COOLDOWN_MS) || (5 * 60 * 1000));

function easternLocalToUtcMs(year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const etOffset = probe.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short'
  }).includes('EST') ? -5 : -4;
  return Date.UTC(year, month - 1, day, hour - etOffset, minute, 0);
}

function pacificLocalToUtcMs(year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const ptOffset = probe.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  }).includes('PST') ? -8 : -7;
  return Date.UTC(year, month - 1, day, hour - ptOffset, minute, 0);
}

function nextPacificDivergenceRefreshUtcMs(nowUtc = new Date()) {
  const nowPacific = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const candidate = new Date(nowPacific);
  candidate.setHours(13, 1, 0, 0);

  const candidateDateStr = () => `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;

  if (!tradingCalendar.isTradingDay(candidateDateStr()) || nowPacific.getTime() >= candidate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 15 && !tradingCalendar.isTradingDay(candidateDateStr()); i++) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return pacificLocalToUtcMs(
    candidate.getFullYear(),
    candidate.getMonth() + 1,
    candidate.getDate(),
    13,
    1
  );
}

function pacificDateStringFromUnixSeconds(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function dateKeyFromYmdParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function pacificDateTimeParts(nowUtc = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  }).formatToParts(nowUtc);
  const map = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return {
    year: Number(map.year || 0),
    month: Number(map.month || 0),
    day: Number(map.day || 0),
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
    weekday: Number(weekdayMap[map.weekday] ?? NaN)
  };
}

function latestCompletedPacificTradeDateKey(nowUtc = new Date()) {
  const pt = pacificDateTimeParts(nowUtc);
  if (!Number.isFinite(pt.year) || !Number.isFinite(pt.month) || !Number.isFinite(pt.day)) {
    return '';
  }
  const todayKey = dateKeyFromYmdParts(pt.year, pt.month, pt.day);
  const minutesSinceMidnight = (Number(pt.hour) * 60) + Number(pt.minute);
  const refreshMinute = (13 * 60) + 1;
  if (tradingCalendar.isTradingDay(todayKey) && minutesSinceMidnight >= refreshMinute) {
    return todayKey;
  }
  return tradingCalendar.previousTradingDay(todayKey);
}

function isEtRegularHours(dateEt) {
  const dateStr = `${dateEt.getFullYear()}-${String(dateEt.getMonth() + 1).padStart(2, '0')}-${String(dateEt.getDate()).padStart(2, '0')}`;
  if (!tradingCalendar.isTradingDay(dateStr)) return false;
  const totalMinutes = dateEt.getHours() * 60 + dateEt.getMinutes();
  if (tradingCalendar.isEarlyClose(dateStr)) {
    const closeTime = tradingCalendar.getCloseTimeEt(dateStr) || '13:00';
    const [ch, cm] = closeTime.split(':').map(Number);
    return totalMinutes >= 570 && totalMinutes < (ch * 60 + cm); // 09:30 to early close
  }
  return totalMinutes >= 570 && totalMinutes < 960; // 09:30-15:59 ET
}

function nextEtMarketOpenUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  const totalMinutes = candidate.getHours() * 60 + candidate.getMinutes();

  const candidateDateStr = () => `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;

  if (!(tradingCalendar.isTradingDay(candidateDateStr()) && totalMinutes < 570)) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 15 && !tradingCalendar.isTradingDay(candidateDateStr()); i++) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return easternLocalToUtcMs(
    candidate.getFullYear(),
    candidate.getMonth() + 1,
    candidate.getDate(),
    9,
    30
  );
}

function todayEtMarketCloseUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return easternLocalToUtcMs(
    nowEt.getFullYear(),
    nowEt.getMonth() + 1,
    nowEt.getDate(),
    16,
    0
  );
}

function getVdRsiCacheExpiryMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (isEtRegularHours(nowEt)) {
    const plusTwoHoursMs = nowUtc.getTime() + VD_RSI_REGULAR_HOURS_CACHE_MS;
    const closeTodayMs = todayEtMarketCloseUtcMs(nowUtc);
    if (plusTwoHoursMs <= closeTodayMs) {
      return plusTwoHoursMs;
    }
    return nextEtMarketOpenUtcMs(nowUtc);
  }
  return nextEtMarketOpenUtcMs(nowUtc);
}

function getTimedCacheValue(cacheMap, key) {
  const entry = cacheMap.get(key);
  if (!entry) return { status: 'miss', value: null };

  const now = Date.now();
  if (now > entry.staleUntil) {
    cacheMap.delete(key);
    return { status: 'miss', value: null };
  }

  // Refresh insertion order so capped caches behave as LRU.
  cacheMap.delete(key);
  cacheMap.set(key, entry);

  if (now <= entry.freshUntil) {
    return { status: 'fresh', value: entry.value };
  }
  return { status: 'stale', value: entry.value };
}

function getTimedCacheMaxEntries(cacheMap) {
  if (cacheMap === VD_RSI_LOWER_TF_CACHE) return VD_RSI_LOWER_TF_CACHE_MAX_ENTRIES;
  if (cacheMap === VD_RSI_RESULT_CACHE) return VD_RSI_RESULT_CACHE_MAX_ENTRIES;
  if (cacheMap === CHART_DATA_CACHE) return CHART_DATA_CACHE_MAX_ENTRIES;
  if (cacheMap === CHART_QUOTE_CACHE) return CHART_QUOTE_CACHE_MAX_ENTRIES;
  if (cacheMap === CHART_FINAL_RESULT_CACHE) return CHART_FINAL_RESULT_CACHE_MAX_ENTRIES;
  return 0;
}

function enforceTimedCacheMaxEntries(cacheMap) {
  const maxEntries = getTimedCacheMaxEntries(cacheMap);
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
  while (cacheMap.size > maxEntries) {
    const oldestKey = cacheMap.keys().next().value;
    if (typeof oldestKey === 'undefined') break;
    cacheMap.delete(oldestKey);
  }
}

function setTimedCacheValue(cacheMap, key, value, freshUntil, staleUntil) {
  if (cacheMap.has(key)) {
    cacheMap.delete(key);
  }
  
  // Default fallback if not provided
  const now = Date.now();
  const safeFreshUntil = Number.isFinite(freshUntil) ? freshUntil : (now + 60000); // 1 min default
  const safeStaleUntil = Number.isFinite(staleUntil) ? staleUntil : (safeFreshUntil + 300000); // +5 min default

  cacheMap.set(key, {
    value,
    freshUntil: safeFreshUntil,
    staleUntil: safeStaleUntil
  });
  enforceTimedCacheMaxEntries(cacheMap);
}

function sweepExpiredTimedCache(cacheMap) {
  const now = Date.now();
  for (const [key, entry] of cacheMap.entries()) {
    if (!entry || !Number.isFinite(entry.staleUntil) || entry.staleUntil <= now) {
      cacheMap.delete(key);
    }
  }
}

const vdRsiCacheCleanupTimer = setInterval(() => {
  sweepExpiredTimedCache(VD_RSI_LOWER_TF_CACHE);
  sweepExpiredTimedCache(VD_RSI_RESULT_CACHE);
  sweepExpiredTimedCache(CHART_DATA_CACHE);
  sweepExpiredTimedCache(CHART_QUOTE_CACHE);
  sweepExpiredTimedCache(CHART_FINAL_RESULT_CACHE);
}, 15 * 60 * 1000);
if (typeof vdRsiCacheCleanupTimer.unref === 'function') {
  vdRsiCacheCleanupTimer.unref();
}

async function dataApiIntraday(symbol, interval, options = {}) {
  const {
    from,
    to,
    signal,
    noCache = false,
    metricsTracker = null
  } = options;

  // Check cache first to avoid redundant API calls
  const cacheKey = `${symbol}|${interval}|${from || ''}|${to || ''}`;
  let cached = { status: 'miss', value: null };
  
  if (!noCache) {
    cached = getTimedCacheValue(CHART_DATA_CACHE, cacheKey);
    if (cached.status === 'fresh') {
      return cached.value;
    }
  }

  // The actual fetching logic wrapped as a standalone function
    const executeFetch = async () => {
      // Parallel Chunking for 1min and 5min to bypass 50k bar limit
      const CHUNK_SIZE_DAYS = {
        '1min': 30,
        '5min': 150,
        '15min': 150
      };
      
      const maxDays = CHUNK_SIZE_DAYS[interval];
      const startDt = options.from ? new Date(options.from) : addUtcDays(new Date(), -30); // Default if missing
      const endDt = options.to ? new Date(options.to) : new Date();

      let urls = [];
      if (maxDays && !options.from && !options.to) {
         // Special case: Default lookback handled by helper defaults if not specified? 
         // Actually options.from/to are usually passed by dataApiIntradayChartHistory.
         // If not, we fall back to single URL (let helper handle defaults).
         urls = [buildDataApiAggregateRangeUrl(symbol, interval, { from, to })];
      } else if (maxDays) {
        // Chunk it
        let current = new Date(startDt);
        const ranges = [];
        while (current < endDt) {
          const next = addUtcDays(new Date(current), maxDays);
          const chunkEnd = next < endDt ? next : endDt;
          ranges.push({ from: formatDateUTC(current), to: formatDateUTC(chunkEnd) });
          current = addUtcDays(chunkEnd, 1); // Advance by 1 day to avoid overlap
        }
        urls = ranges.map(r => buildDataApiAggregateRangeUrl(symbol, interval, r));
      } else {
        urls = [buildDataApiAggregateRangeUrl(symbol, interval, { from, to })];
      }


      
      let rows = [];
      if (urls.length > 1) {
        // Parallel fetch for chunks
        const results = await Promise.all(urls.map(url => 
          fetchDataApiJson(url, `DataAPI ${interval} chunk`, { signal, metricsTracker })
            .then(payload => toArrayPayload(payload) || [])
            .catch(err => {
              console.error(`DataAPI chunk fetch failed (${sanitizeDataApiUrl(url)}):`, err.message);
              throw err;
            })
        ));
        // Flatten results
        rows = results.flat();
      } else {
        // Single URL (fallback to standard behavior)
        rows = await fetchDataApiArrayWithFallback(`DataAPI ${interval}`, urls, { signal, metricsTracker });
      }

    const normalized = rows.map((row) => {
      const time = normalizeUnixSeconds(row.t ?? row.timestamp ?? row.time);
      const close = toNumberOrNull(row.c ?? row.close ?? row.price);
      const open = toNumberOrNull(row.o ?? row.open) ?? close;
      const high = toNumberOrNull(row.h ?? row.high) ?? close;
      const low = toNumberOrNull(row.l ?? row.low) ?? close;
      const volume = toNumberOrNull(row.v ?? row.volume) ?? 0;

      if (!Number.isFinite(time) || close === null || open === null || high === null || low === null) {
        return null;
      }

      return { time, open, high, low, close, volume };
    }).filter(Boolean);

    const result = normalized.length ? normalized : null;

    // Cache the result with SWR logic
    if (result && !noCache) {
      const now = Date.now();
      const freshExpiryMs = getVdRsiCacheExpiryMs(new Date());
      // SWR window: allow serving stale data for another 10 minutes after expiry
      const staleExpiryMs = freshExpiryMs + (10 * 60 * 1000); 
      setTimedCacheValue(CHART_DATA_CACHE, cacheKey, result, freshExpiryMs, staleExpiryMs);
    }
    return result;
  };

  // If stale, return immediately but trigger background refresh
  if (cached.status === 'stale') {
    // console.log(`[SWR] Serving stale data for ${cacheKey} while refreshing in background`);
    
    // Trigger background fetch without awaiting. 
    // We catch errors to prevent unhandled rejections from crashing the process.
    executeFetch().catch((err) => {
      console.error(`[SWR] Background refresh failed for ${cacheKey}:`, err.message);
    });
    
    return cached.value;
  }

  // If miss (or noCache), await the fetch properly
  return await executeFetch();
}

function getIntradayLookbackDays(interval) {
  // Fetch 1.5 years so all panes share the same parent history window.
  // RSI / VD-RSI warm-up is naturally covered by this window.
  return 548;
}

const CHART_INTRADAY_LOOKBACK_DAYS = 548; // Legacy fallback
const CHART_INTRADAY_SLICE_DAYS = {
  '1min': 30,
  '5min': 45,
  '15min': 45,
  '30min': 45,
  '1hour': 45,
  '4hour': 45
};

async function dataApiIntradayChartHistorySingle(symbol, interval, lookbackDays = CHART_INTRADAY_LOOKBACK_DAYS, options = {}) {
  const signal = options && options.signal ? options.signal : null;
  const noCache = options && options.noCache === true;
  const metricsTracker = options && options.metricsTracker ? options.metricsTracker : null;
  const sliceDays = CHART_INTRADAY_SLICE_DAYS[interval] || 30;
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  const startDate = addUtcDays(endDate, -Math.max(1, lookbackDays));
  const shouldTrySingleRequest = Math.max(1, lookbackDays) <= (sliceDays + 7);

  if (shouldTrySingleRequest) {
    try {
      const rows = await dataApiIntraday(symbol, interval, {
        from: formatDateUTC(startDate),
        to: formatDateUTC(endDate),
        signal,
        noCache,
        metricsTracker
      });
      if (Array.isArray(rows) && rows.length > 0 && rows.length < 50000) {
        return rows.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
      }
      if (Array.isArray(rows) && rows.length === 0) {
        return [];
      }
      // Defensive fallback when the provider returns the request cap.
      // A capped payload can be incomplete depending on the symbol/session.
      if (Array.isArray(rows) && rows.length >= 50000) {
        console.warn(`DataAPI ${interval} single-range payload hit cap for ${symbol}; retrying with slices`);
      }
    } catch (err) {
      if (isAbortError(err) || isDataApiRateLimitedError(err) || isDataApiPausedError(err) || isDataApiSubscriptionRestrictedError(err)) {
        throw err;
      }
      const message = err && err.message ? err.message : String(err);
      console.warn(`DataAPI ${interval} single-range fetch failed for ${symbol}; falling back to slices: ${message}`);
    }
  }

  const byDateTime = new Map();
  let cursor = new Date(startDate);
  let lastSliceError = null;

  while (cursor <= endDate) {
    if (signal && signal.aborted) {
      throw buildRequestAbortError(`DataAPI ${interval} fetch aborted for ${symbol}`);
    }
    const sliceStart = new Date(cursor);
    let sliceEnd = addUtcDays(sliceStart, sliceDays - 1);
    if (sliceEnd > endDate) sliceEnd = new Date(endDate);

    try {
      const rows = await dataApiIntraday(symbol, interval, {
        from: formatDateUTC(sliceStart),
        to: formatDateUTC(sliceEnd),
        signal,
        noCache,
        metricsTracker
      });
      if (rows && rows.length > 0) {
        for (const row of rows) {
          const rowKey = Number.isFinite(Number(row?.time))
            ? String(Math.floor(Number(row.time)))
            : String(row?.datetime || '');
          if (!rowKey) continue;
          byDateTime.set(rowKey, row);
        }
      }
    } catch (err) {
      lastSliceError = err;
      if (isAbortError(err)) {
        throw err;
      }
      const message = err && err.message ? err.message : String(err);
      console.error(`DataAPI ${interval} slice fetch failed for ${symbol} (${formatDateUTC(sliceStart)} to ${formatDateUTC(sliceEnd)}): ${message}`);
      if (isDataApiSubscriptionRestrictedError(err) || isDataApiRateLimitedError(err) || isDataApiPausedError(err)) {
        throw err;
      }
    }

    cursor = addUtcDays(sliceEnd, 1);
  }

  if (signal && signal.aborted) {
    throw buildRequestAbortError(`DataAPI ${interval} fetch aborted for ${symbol}`);
  }

  if (byDateTime.size === 0) {
    // Fallback to a single request without date filters if slicing returned nothing.
    try {
      return await dataApiIntraday(symbol, interval, { signal, noCache, metricsTracker });
    } catch (fallbackErr) {
      if (lastSliceError) throw lastSliceError;
      throw fallbackErr;
    }
  }

  return Array.from(byDateTime.values()).sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
}

async function dataApiIntradayChartHistory(symbol, interval, lookbackDays = CHART_INTRADAY_LOOKBACK_DAYS, options = {}) {
  const requestedInterval = String(interval || '').trim();
  const intervalCandidates = [requestedInterval];
  let lastError = null;

  for (const intervalCandidate of intervalCandidates) {
    const symbolCandidates = getDataApiSymbolCandidates(symbol);
    for (const candidate of symbolCandidates) {
      try {
        const rows = await dataApiIntradayChartHistorySingle(candidate, intervalCandidate, lookbackDays, options);
        if (rows && rows.length > 0) {
          if (candidate !== normalizeTickerSymbol(symbol)) {
            console.log(`DataAPI symbol fallback (${intervalCandidate}): ${symbol} -> ${candidate}`);
          }
          return rows;
        }
      } catch (err) {
        lastError = err;
        if (isAbortError(err)) {
          throw err;
        }
        const message = err && err.message ? err.message : String(err);
        console.error(`DataAPI ${intervalCandidate} history failed for ${candidate} (requested ${symbol}): ${message}`);
        if (isDataApiRateLimitedError(err) || isDataApiPausedError(err)) {
          throw err;
        }
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
}

async function dataApiIntraday30(symbol) {
  return dataApiIntraday(symbol, '30min');
}

async function dataApiIntraday1Hour(symbol) {
  return dataApiIntraday(symbol, '1hour');
}

async function dataApiIntraday4Hour(symbol) {
  return dataApiIntraday(symbol, '4hour');
}



// Calculate RSI (Relative Strength Index) with smoothed averages
function calculateRSI(closePrices, period = 14) {
  if (!Array.isArray(closePrices) || closePrices.length === 0) return [];
  if (closePrices.length === 1) return [50];

  const rsiValues = new Array(closePrices.length).fill(50);
  const gains = [];
  const losses = [];

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < closePrices.length; i++) {
    const change = closePrices[i] - closePrices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    gains.push(gain);
    losses.push(loss);

    if (i < period) {
      // Use the available history so RSI can be drawn from the beginning.
      const window = i;
      let gainSum = 0;
      let lossSum = 0;
      for (let j = 0; j < window; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / window;
      avgLoss = lossSum / window;
    } else if (i === period) {
      let gainSum = 0;
      let lossSum = 0;
      for (let j = i - period; j < i; j++) {
        gainSum += gains[j];
        lossSum += losses[j];
      }
      avgGain = gainSum / period;
      avgLoss = lossSum / period;
    } else {
      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    rsiValues[i] = Number.isFinite(rsi) ? rsi : rsiValues[i - 1];
  }

  rsiValues[0] = rsiValues[1] ?? 50;
  return rsiValues;
}

function calculateRMA(values, length = 14) {
  const period = Math.max(1, Math.floor(length));
  const out = new Array(values.length).fill(null);

  // First, we need to find the first 'period' valid values to calculate initial SMA
  const validValues = [];
  let firstValidIndex = -1;

  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) {
      if (firstValidIndex === -1) {
        firstValidIndex = i;
      }
      validValues.push({ index: i, value: values[i] });

      // Once we have 'period' valid values, calculate initial SMA
      if (validValues.length === period) {
        const sum = validValues.reduce((acc, v) => acc + v.value, 0);
        const initialRMA = sum / period;
        out[i] = initialRMA;
        break;
      }
    }
  }

  // If we don't have enough values for initial SMA, return all nulls
  if (validValues.length < period) {
    return out;
  }

  // Now apply Wilder's smoothing for subsequent values
  let rma = out[validValues[period - 1].index];

  for (let i = validValues[period - 1].index + 1; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      continue;
    }

    // Wilder's smoothing: RMA = ((previous RMA * (period - 1)) + current value) / period
    rma = ((rma * (period - 1)) + value) / period;
    out[i] = rma;
  }

  return out;
}

function getIntervalSeconds(interval) {
  const map = {
    '1min': 60,
    '5min': 5 * 60,
    '15min': 15 * 60,
    '30min': 30 * 60,
    '1hour': 60 * 60,
    '4hour': 4 * 60 * 60,
    '1day': 24 * 60 * 60,
    '1week': 7 * 24 * 60 * 60
  };
  return map[interval] || 60;
}


function normalizeIntradayVolumesFromCumulativeIfNeeded(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return bars || [];

  const normalized = bars.map((bar) => ({ ...bar, volume: Number(bar.volume) || 0 }));

  const maybeNormalizeDayRange = (startIndex, endIndex) => {
    if (endIndex - startIndex < 3) return;

    let nonDecreasing = 0;
    let steps = 0;
    const positiveDiffs = [];
    let maxVolume = Number.NEGATIVE_INFINITY;

    for (let i = startIndex; i <= endIndex; i++) {
      maxVolume = Math.max(maxVolume, Number(normalized[i].volume) || 0);
    }

    for (let i = startIndex + 1; i <= endIndex; i++) {
      const prev = Number(normalized[i - 1].volume) || 0;
      const curr = Number(normalized[i].volume) || 0;
      steps += 1;
      if (curr >= prev) nonDecreasing += 1;
      if (curr > prev) positiveDiffs.push(curr - prev);
    }

    if (steps === 0 || positiveDiffs.length === 0) return;
    const monotonicRatio = nonDecreasing / steps;
    if (monotonicRatio < 0.9) return;

    const avgDiff = positiveDiffs.reduce((sum, value) => sum + value, 0) / positiveDiffs.length;
    if (!Number.isFinite(avgDiff) || avgDiff <= 0) return;

    // Cumulative series: absolute values are much larger than per-bar increments.
    // Require ratio ≥ 6 (conservative) to avoid false positives from volume spikes.
    if ((maxVolume / avgDiff) < 6) return;

    for (let i = startIndex + 1; i <= endIndex; i++) {
      const prev = Number(normalized[i - 1].volume) || 0;
      const curr = Number(normalized[i].volume) || 0;
      normalized[i].volume = Math.max(0, curr - prev);
    }
    normalized[startIndex].volume = Math.max(0, Number(normalized[startIndex].volume) || 0);
  };

  let dayStart = 0;
  let currentDayKey = dayKeyInLA(Number(normalized[0].time));
  for (let i = 1; i < normalized.length; i++) {
    const key = dayKeyInLA(Number(normalized[i].time));
    if (key === currentDayKey) continue;
    maybeNormalizeDayRange(dayStart, i - 1);
    dayStart = i;
    currentDayKey = key;
  }
  maybeNormalizeDayRange(dayStart, normalized.length - 1);

  return normalized;
}

function computeVolumeDeltaByParentBars(parentBars, lowerTimeframeBars, interval) {
  if (!Array.isArray(parentBars) || parentBars.length === 0) return [];
  if (!Array.isArray(lowerTimeframeBars) || lowerTimeframeBars.length === 0) {
    // No lower TF data = delta of 0 for all bars (matches TradingView behavior)
    return parentBars.map((bar) => ({ time: bar.time, delta: 0 }));
  }

  const intervalSeconds = getIntervalSeconds(interval);
  const parentTimes = parentBars.map((bar) => Number(bar.time));
  const intrabarsPerParent = parentBars.map(() => []);
  let parentIndex = 0;

  for (const bar of lowerTimeframeBars) {
    const t = Number(bar.time);
    if (!Number.isFinite(t)) continue;

    while (parentIndex + 1 < parentTimes.length && t >= parentTimes[parentIndex + 1]) {
      parentIndex += 1;
    }

    const currentParentStart = parentTimes[parentIndex];
    if (!Number.isFinite(currentParentStart)) continue;
    if (t < currentParentStart || t >= (currentParentStart + intervalSeconds)) continue;

    const open = Number(bar.open);
    const close = Number(bar.close);
    const volume = Number(bar.volume);
    if (!Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(volume)) continue;

    intrabarsPerParent[parentIndex].push({ open, close, volume });
  }

  let lastClose = null;
  let lastBull = null;  // null = unknown; don't assume direction
  const deltas = [];

  for (let i = 0; i < parentBars.length; i++) {
    const stream = intrabarsPerParent[i];
    if (!stream || stream.length === 0) {
      deltas.push({ time: parentBars[i].time, delta: 0 });
      continue;
    }

    let runningDelta = 0;
    let streamLastClose = lastClose;
    let streamLastBull = lastBull;

    for (let j = 0; j < stream.length; j++) {
      const ib = stream[j];
      let isBull = ib.close > ib.open ? true : (ib.close < ib.open ? false : null);
      if (isBull === null) {
        const prevClose = (j === 0) ? streamLastClose : stream[j - 1].close;
        if (Number.isFinite(prevClose)) {
          if (ib.close > prevClose) {
            isBull = true;
          } else if (ib.close < prevClose) {
            isBull = false;
          } else {
            isBull = streamLastBull;  // may still be null
          }
        } else {
          isBull = streamLastBull;  // may still be null
        }
      }

      // Pure doji with no prior reference: use running delta direction.
      // Positive delta → bullish, negative → bearish, zero → skip.
      if (isBull === null && runningDelta !== 0) {
        isBull = runningDelta > 0;
      }
      if (isBull !== null) streamLastBull = isBull;
      runningDelta += isBull === true ? ib.volume : (isBull === false ? -ib.volume : 0);
      if (j === stream.length - 1) {
        streamLastClose = ib.close;
      }
    }

    lastClose = Number.isFinite(streamLastClose) ? streamLastClose : lastClose;
    lastBull = streamLastBull;
    deltas.push({ time: parentBars[i].time, delta: runningDelta });
  }

  return deltas;
}

function calculateVolumeDeltaRsiSeries(parentBars, lowerTimeframeBars, interval, options = {}) {
  const rsiLength = Math.max(1, Math.floor(Number(options.rsiLength) || 14));

  const deltaByBar = computeVolumeDeltaByParentBars(parentBars, lowerTimeframeBars, interval);
  const gains = deltaByBar.map((point) => {
    if (!Number.isFinite(point.delta)) return null;
    return Math.max(Number(point.delta), 0);
  });
  const losses = deltaByBar.map((point) => {
    if (!Number.isFinite(point.delta)) return null;
    return Math.max(-Number(point.delta), 0);
  });

  const avgGains = calculateRMA(gains, rsiLength);
  const avgLosses = calculateRMA(losses, rsiLength);
  const vdRsiRaw = new Array(deltaByBar.length).fill(null);

  for (let i = 0; i < deltaByBar.length; i++) {
    const avgGain = avgGains[i];
    const avgLoss = avgLosses[i];
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) {
      continue;
    }
    const rs = avgLoss === 0 ? 100 : (avgGain / avgLoss);
    const value = 100 - (100 / (1 + rs));
    vdRsiRaw[i] = Number.isFinite(value) ? value : null;
  }

  const rsi = [];
  for (let i = 0; i < deltaByBar.length; i++) {
    const time = deltaByBar[i].time;
    const rsiValue = vdRsiRaw[i];
    if (Number.isFinite(rsiValue)) {
      rsi.push({ time, value: Math.round(rsiValue * 100) / 100 });
    }
  }

  // Also return raw volume delta values for verification
  const deltaValues = deltaByBar.map(d => ({
    time: d.time,
    delta: Number.isFinite(d.delta) ? d.delta : 0
  }));

  return { rsi, deltaValues };
}

// Convert provider bars to epoch seconds for chart rendering
function parseDataApiDateTime(datetimeValue) {
  if (typeof datetimeValue !== 'string') return null;
  const normalized = datetimeValue.trim().replace('T', ' ').replace('Z', '');
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  };
}

function parseBarTimeToUnixSeconds(bar) {
  const numeric = normalizeUnixSeconds(bar?.time ?? bar?.timestamp ?? bar?.t);
  if (Number.isFinite(numeric)) return numeric;
  const parts = parseDataApiDateTime(bar?.datetime || bar?.date);
  if (!parts) return null;
  const { year, month, day, hour, minute } = parts;
  // Determine EST (-5) vs EDT (-4) for the actual hour being converted.
  // Use the bar's own hour (not noon) so that if a bar were near a DST
  // boundary it gets the correct offset.  In practice US DST transitions
  // happen at 2 AM ET on Sundays (markets closed), so this is defensive.
  const probeDate = new Date(Date.UTC(year, month - 1, day, Math.max(hour, 0), minute, 0));
  const etOffset = probeDate.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short'
  }).includes('EST') ? -5 : -4;
  return Math.floor(Date.UTC(year, month - 1, day, hour - etOffset, minute, 0) / 1000);
}

function convertToLATime(bars, interval) {
  void interval;
  const converted = [];

  for (const bar of bars) {
    const timestamp = parseBarTimeToUnixSeconds(bar);
    if (!Number.isFinite(timestamp)) continue;

    converted.push({
      time: timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume
    });
  }

  return converted;
}

// --- Breadth API ---

async function getSpyDaily() {
  return dataApiDaily('SPY');
}

async function getSpyIntraday(lookbackDays = 30) {
  return dataApiIntradayChartHistory('SPY', '30min', lookbackDays);
}

function isRegularHoursEt(dateTimeStr) {
  const numeric = normalizeUnixSeconds(dateTimeStr);
  if (Number.isFinite(numeric)) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(Number(numeric) * 1000));
    const partMap = {};
    for (const part of parts) partMap[part.type] = part.value;
    const h = Number(partMap.hour || 0);
    const m = Number(partMap.minute || 0);
    const totalMin = h * 60 + m;
    return totalMin >= 570 && totalMin <= 960;
  }
  const dateTimeParts = String(dateTimeStr || '').split(' ');
  if (dateTimeParts.length < 2) return false;
  const [h, m] = dateTimeParts[1].split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const totalMin = h * 60 + m;
  return totalMin >= 570 && totalMin <= 960;
}

function roundEtTo30MinEpochMs(dateTimeStr) {
  const unixSeconds = normalizeUnixSeconds(dateTimeStr);
  if (Number.isFinite(unixSeconds)) {
    const d = new Date(Number(unixSeconds) * 1000);
    d.setSeconds(0, 0);
    const minutes = d.getUTCMinutes();
    d.setUTCMinutes(minutes < 30 ? 0 : 30);
    return d.getTime();
  }

  const asUTC = new Date(String(dateTimeStr).replace(' ', 'T') + 'Z');
  const nyStr = asUTC.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const nyAsUTC = new Date(nyStr + ' GMT');
  const diff = asUTC.getTime() - nyAsUTC.getTime();
  const d = new Date(asUTC.getTime() + diff);

  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m < 30 ? 0 : 30);
  return d.getTime();
}

function buildIntradayBreadthPoints(spyBars, compBars, days) {
  const todayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = todayET.getFullYear();
  const mo = String(todayET.getMonth() + 1).padStart(2, '0');
  const da = String(todayET.getDate()).padStart(2, '0');
  const todayStr = `${y}-${mo}-${da}`;

  const spyMap = new Map();
  const spyDayByTs = new Map();
  for (const bar of spyBars || []) {
    const unixSeconds = parseBarTimeToUnixSeconds(bar);
    const day = Number.isFinite(unixSeconds) ? etDateStringFromUnixSeconds(unixSeconds) : String(bar.datetime || '').slice(0, 10);
    if (!day) continue;
    if (!isRegularHoursEt(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime)) continue;
    const ts = roundEtTo30MinEpochMs(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime);
    spyMap.set(ts, bar.close);
    spyDayByTs.set(ts, day);
  }

  const compMap = new Map();
  const compDayByTs = new Map();
  for (const bar of compBars || []) {
    const unixSeconds = parseBarTimeToUnixSeconds(bar);
    const day = Number.isFinite(unixSeconds) ? etDateStringFromUnixSeconds(unixSeconds) : String(bar.datetime || '').slice(0, 10);
    if (!day) continue;
    if (!isRegularHoursEt(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime)) continue;
    const ts = roundEtTo30MinEpochMs(Number.isFinite(unixSeconds) ? unixSeconds : bar.datetime);
    compMap.set(ts, bar.close);
    compDayByTs.set(ts, day);
  }

  const commonKeys = [...spyMap.keys()]
    .filter((k) => compMap.has(k))
    .sort((a, b) => a - b);

  if (commonKeys.length === 0) return [];

  const commonDays = Array.from(new Set(commonKeys.map((k) => spyDayByTs.get(k) || compDayByTs.get(k)).filter(Boolean))).sort();
  let selectedDaySet;
  if (days === 1) {
    selectedDaySet = new Set([todayStr]);
  } else {
    selectedDaySet = new Set(commonDays.slice(-days));
  }

  return commonKeys
    .filter((k) => selectedDaySet.has(spyDayByTs.get(k) || compDayByTs.get(k)))
    .map((k) => ({
      date: new Date(k).toISOString(),
      spy: Math.round(spyMap.get(k) * 100) / 100,
      comparison: Math.round(compMap.get(k) * 100) / 100
    }));
}

app.get('/api/breadth', async (req, res) => {
  const compTicker = (req.query.ticker || 'SVIX').toString().toUpperCase();
  const days = Math.min(Math.max(parseInt(req.query.days) || 5, 1), 60);
  const isIntraday = days <= 30;

  try {
    if (isIntraday) {
      // --- Intraday path (30-min bars) ---
      const lookbackDays = Math.max(14, days * 3);
      const [spyBars, compBars] = await Promise.all([
        getSpyIntraday(lookbackDays),
        dataApiIntradayChartHistory(compTicker, '30min', lookbackDays)
      ]);

      if (!spyBars || !compBars) {
        return res.status(404).json({ error: 'No intraday data available (market may be closed)' });
      }

      const points = buildIntradayBreadthPoints(spyBars, compBars, days);
      const result = {
        intraday: true,
        points
      };

      return res.json(result);
    }

    // --- Daily path ---
    const [spyBars, compBars] = await Promise.all([
      getSpyDaily(),
      dataApiDaily(compTicker)
    ]);

    if (!spyBars || !compBars) {
      return res.status(404).json({ error: 'No price data available' });
    }

    const spyMap = new Map();
    for (const bar of spyBars) spyMap.set(bar.date, bar.close);

    const compMap = new Map();
    for (const bar of compBars) compMap.set(bar.date, bar.close);

    const commonDates = [...spyMap.keys()]
      .filter(d => compMap.has(d))
      .sort();

    const allPoints = commonDates.slice(-30).map(d => ({
      date: d,
      spy: Math.round(spyMap.get(d) * 100) / 100,
      comparison: Math.round(compMap.get(d) * 100) / 100
    }));

    const points = allPoints.slice(-days);
    res.json({ intraday: false, points });
  } catch (err) {
    console.error('Breadth API Error:', err);
    res.status(500).json({ error: 'Failed to fetch breadth data' });
  }
});

function toVolumeDeltaSourceInterval(value, fallback = '1min') {
  const normalized = String(value || '').trim();
  return VOLUME_DELTA_SOURCE_INTERVALS.includes(normalized) ? normalized : fallback;
}

function buildChartRequestKey(params) {
  return [
    'v1',
    params.ticker,
    params.interval,
    params.vdRsiLength,
    params.vdSourceInterval,
    params.vdRsiSourceInterval,
    params.lookbackDays
  ].join('|');
}

function createChartStageTimer() {
  const startedNs = process.hrtime.bigint();
  const stages = [];
  let previousNs = startedNs;
  const toMs = (durationNs) => Number(durationNs) / 1e6;
  const fmt = (ms) => Number(ms).toFixed(1);
  return {
    step(name) {
      const nowNs = process.hrtime.bigint();
      stages.push({ name, ms: toMs(nowNs - previousNs) });
      previousNs = nowNs;
    },
    serverTiming() {
      const totalMs = toMs(process.hrtime.bigint() - startedNs);
      const parts = stages.map((stage) => `${stage.name};dur=${fmt(stage.ms)}`);
      parts.push(`total;dur=${fmt(totalMs)}`);
      return parts.join(', ');
    },
    summary() {
      const totalMs = toMs(process.hrtime.bigint() - startedNs);
      const stageSummary = stages.map((stage) => `${stage.name}=${fmt(stage.ms)}ms`).join(' ');
      return `${stageSummary}${stageSummary ? ' ' : ''}total=${fmt(totalMs)}ms`;
    }
  };
}

function getChartCacheControlHeaderValue() {
  const maxAge = Math.max(0, Math.floor(CHART_RESPONSE_MAX_AGE_SECONDS));
  const swr = Math.max(0, Math.floor(CHART_RESPONSE_SWR_SECONDS));
  return `public, max-age=${maxAge}, stale-while-revalidate=${swr}`;
}

function getChartResultCacheExpiryMs(nowUtc = new Date()) {
  if (CHART_RESULT_CACHE_TTL_SECONDS > 0) {
    return nowUtc.getTime() + (CHART_RESULT_CACHE_TTL_SECONDS * 1000);
  }
  return getVdRsiCacheExpiryMs(nowUtc);
}

function ifNoneMatchMatchesEtag(ifNoneMatchHeader, etag) {
  const raw = String(ifNoneMatchHeader || '').trim();
  if (!raw || !etag) return false;
  if (raw === '*') return true;
  const candidates = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return candidates.includes(etag);
}

async function sendChartJsonResponse(req, res, payload, serverTimingHeader) {
  const body = JSON.stringify(payload);
  const bodyBuffer = Buffer.from(body);
  const etagHash = crypto.createHash('sha1').update(bodyBuffer).digest('hex').slice(0, 16);
  const etag = `W/"${bodyBuffer.byteLength.toString(16)}-${etagHash}"`;
  const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();

  res.setHeader('Cache-Control', getChartCacheControlHeaderValue());
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  if (serverTimingHeader) {
    res.setHeader('Server-Timing', serverTimingHeader);
  }

  if (ifNoneMatchMatchesEtag(ifNoneMatch, etag)) {
    return res.status(304).end();
  }

  const accepts = String(req.headers['accept-encoding'] || '').toLowerCase();
  const shouldCompress = bodyBuffer.byteLength >= CHART_RESPONSE_COMPRESS_MIN_BYTES;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (shouldCompress && accepts.includes('br')) {
    try {
      const compressed = await brotliCompressAsync(bodyBuffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4
        }
      });
      res.setHeader('Content-Encoding', 'br');
      return res.status(200).send(compressed);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`Brotli compression failed for /api/chart response: ${message}`);
    }
  }

  if (shouldCompress && accepts.includes('gzip')) {
    try {
      const compressed = await gzipAsync(bodyBuffer, {
        level: zlib.constants.Z_BEST_SPEED
      });
      res.setHeader('Content-Encoding', 'gzip');
      return res.status(200).send(compressed);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`Gzip compression failed for /api/chart response: ${message}`);
    }
  }

  return res.status(200).send(bodyBuffer);
}

function buildChartResultFromRows(options = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const interval = String(options.interval || '4hour');
  const rowsByInterval = options.rowsByInterval instanceof Map ? options.rowsByInterval : new Map();
  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(options.vdRsiLength) || 14)));
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const vdRsiSourceInterval = toVolumeDeltaSourceInterval(options.vdRsiSourceInterval, '1min');
  const timer = options.timer || null;

  const convertBarsForInterval = (rows, tf) => convertToLATime(rows || [], tf).sort((a, b) => Number(a.time) - Number(b.time));
  const directIntervalRows = rowsByInterval.get(interval) || [];
  const directIntervalBars = convertBarsForInterval(directIntervalRows, interval);
  const fallback4HourRows = rowsByInterval.get('4hour') || [];
  const fallback4HourBars = convertBarsForInterval(fallback4HourRows, '4hour');
  const fallbackDailyRows = rowsByInterval.get('1day') || [];
  const fallbackDailyBars = convertBarsForInterval(fallbackDailyRows, '1day');

  let convertedBars = [];
  if (interval === '1day') {
    if (directIntervalBars.length > 0) {
      convertedBars = directIntervalBars;
    } else if (fallback4HourBars.length > 0) {
      convertedBars = aggregate4HourBarsToDaily(fallback4HourBars);
    }
  } else if (interval === '1week') {
    if (directIntervalBars.length > 0) {
      convertedBars = directIntervalBars;
    } else if (fallbackDailyBars.length > 0) {
      convertedBars = aggregateDailyBarsToWeekly(fallbackDailyBars);
    } else if (fallback4HourBars.length > 0) {
      convertedBars = aggregateDailyBarsToWeekly(aggregate4HourBarsToDaily(fallback4HourBars));
    }
  } else {
    convertedBars = directIntervalBars;
  }
  if (timer) timer.step('parent_bars');

  if (convertedBars.length === 0) {
    const err = new Error(`No valid ${interval} chart bars available for this ticker`);
    err.httpStatus = 404;
    throw err;
  }

  // Calculate RSI
  const closePrices = convertedBars.map((bar) => bar.close);
  const rsiValues = calculateRSI(closePrices, 14);

  // Emit RSI for the full loaded history.
  const rsi = [];
  for (let i = 0; i < convertedBars.length; i++) {
    const raw = rsiValues[i];
    if (!Number.isFinite(raw)) continue;
    rsi.push({
      time: convertedBars[i].time,
      value: Math.round(raw * 100) / 100
    });
  }
  if (timer) timer.step('rsi');

  const normalizeSourceBars = (rows, tf) => normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(rows || [], tf).sort((a, b) => Number(a.time) - Number(b.time))
  );
  const vdSourceBars = normalizeSourceBars(rowsByInterval.get(vdSourceInterval) || [], vdSourceInterval);
  const vdRsiSourceBars = vdRsiSourceInterval === vdSourceInterval
    ? vdSourceBars
    : normalizeSourceBars(rowsByInterval.get(vdRsiSourceInterval) || [], vdRsiSourceInterval);
  if (timer) timer.step('source_bars');

  let volumeDeltaRsi = { rsi: [] };
  const cacheExpiryMs = getVdRsiCacheExpiryMs(new Date());
  const firstBarTime = convertedBars[0]?.time ?? '';
  const lastBarTime = convertedBars[convertedBars.length - 1]?.time ?? '';
  const vdRsiResultCacheKey = `v4|${ticker}|${interval}|${vdRsiSourceInterval}|${vdRsiLength}|${convertedBars.length}|${firstBarTime}|${lastBarTime}`;
  const firstParentTime = Number(firstBarTime);
  const lastParentTime = Number(lastBarTime);
  const warmUpBufferSeconds = getIntervalSeconds(interval) * 20; // 20 parent bars worth
  const parentWindowStart = Number.isFinite(firstParentTime)
    ? (firstParentTime - warmUpBufferSeconds)
    : Number.NEGATIVE_INFINITY;
  const parentWindowEndExclusive = Number.isFinite(lastParentTime)
    ? (lastParentTime + getIntervalSeconds(interval))
    : Number.POSITIVE_INFINITY;
  const vdSourceBarsInParentRange = vdSourceBars.filter((bar) => {
    const t = Number(bar.time);
    return Number.isFinite(t) && t >= parentWindowStart && t < parentWindowEndExclusive;
  });
  const vdRsiSourceBarsInParentRange = vdRsiSourceBars.filter((bar) => {
    const t = Number(bar.time);
    return Number.isFinite(t) && t >= parentWindowStart && t < parentWindowEndExclusive;
  });
  const volumeDelta = computeVolumeDeltaByParentBars(
    convertedBars,
    vdSourceBarsInParentRange,
    interval
  ).map((point) => ({
    time: point.time,
    delta: Number.isFinite(Number(point.delta)) ? Number(point.delta) : 0
  }));
  if (timer) timer.step('volume_delta');

  const cachedVolumeDeltaRsi = getTimedCacheValue(VD_RSI_RESULT_CACHE, vdRsiResultCacheKey);
  if (cachedVolumeDeltaRsi && cachedVolumeDeltaRsi.deltaValues) {
    volumeDeltaRsi = cachedVolumeDeltaRsi;
  } else {
    try {
      if (vdRsiSourceBarsInParentRange.length > 0) {
        volumeDeltaRsi = calculateVolumeDeltaRsiSeries(
          convertedBars,
          vdRsiSourceBarsInParentRange,
          interval,
          { rsiLength: vdRsiLength }
        );
      } else {
        volumeDeltaRsi = {
          rsi: [],
          deltaValues: computeVolumeDeltaByParentBars(convertedBars, [], interval)
        };
      }
      setTimedCacheValue(VD_RSI_RESULT_CACHE, vdRsiResultCacheKey, volumeDeltaRsi, cacheExpiryMs);
    } catch (volumeDeltaErr) {
      const message = volumeDeltaErr && volumeDeltaErr.message ? volumeDeltaErr.message : String(volumeDeltaErr);
      console.warn(`Volume Delta RSI skipped for ${ticker}/${interval}: ${message}`);
    }
  }
  if (timer) timer.step('vd_rsi');

  const result = {
    interval,
    timezone: 'America/Los_Angeles',
    bars: convertedBars,
    rsi,
    volumeDeltaRsi,
    volumeDelta,
    volumeDeltaConfig: {
      sourceInterval: vdSourceInterval
    },
    volumeDeltaRsiConfig: {
      sourceInterval: vdRsiSourceInterval,
      length: vdRsiLength
    }
  };
  if (timer) timer.step('assemble');
  return result;
}

// --- Chart pre-warming (extracted to server/services/chartPrewarm.js) ---
const chartPrewarm = require('./server/services/chartPrewarm');
const prewarmDeps = {
  getOrBuildChartResult: (...args) => getOrBuildChartResult(...args),
  toVolumeDeltaSourceInterval,
  getIntradayLookbackDays,
  buildChartRequestKey,
  CHART_FINAL_RESULT_CACHE,
  CHART_IN_FLIGHT_REQUESTS,
  getTimedCacheValue,
  VALID_CHART_INTERVALS,
  CHART_TIMING_LOG_ENABLED,
};

function schedulePostLoadPrewarmSequence(options = {}) {
  chartPrewarm.schedulePostLoadPrewarmSequence(options, prewarmDeps);
}

function parseChartRequestParams(req) {
  const ticker = (req.query.ticker || 'SPY').toString().toUpperCase();
  if (!isValidTickerSymbol(ticker)) {
    const err = new Error('Invalid ticker format');
    err.httpStatus = 400;
    throw err;
  }
  const interval = (req.query.interval || '4hour').toString();
  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(req.query.vdRsiLength) || 14)));
  const vdSourceInterval = toVolumeDeltaSourceInterval(req.query.vdSourceInterval, '1min');
  const vdRsiSourceInterval = toVolumeDeltaSourceInterval(req.query.vdRsiSourceInterval, '1min');
  const lookbackDays = getIntradayLookbackDays(interval);
  const requestKey = buildChartRequestKey({
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays
  });
  return {
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
    requestKey
  };
}

async function getOrBuildChartResult(params) {
  const {
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
    requestKey,
    skipFollowUpPrewarm = false
  } = params;

  const cachedFinalResult = getTimedCacheValue(CHART_FINAL_RESULT_CACHE, requestKey);
  if (cachedFinalResult.status === 'fresh') {
    chartDebugMetrics.cacheHit += 1;
    if (!skipFollowUpPrewarm) {
      if (interval === '1day') {
        chartDebugMetrics.prewarmRequested.fourHourFrom1dayCacheHit += 1;
        chartDebugMetrics.prewarmRequested.weeklyFrom1dayCacheHit += 1;
      } else if (interval === '4hour') {
        chartDebugMetrics.prewarmRequested.dailyFrom4hour += 1;
      }
      schedulePostLoadPrewarmSequence({
        ticker,
        interval,
        vdRsiLength,
        vdSourceInterval,
        vdRsiSourceInterval,
        lookbackDays
      });
    }
    if (CHART_TIMING_LOG_ENABLED) {
      console.log(`[chart-cache] ${ticker} ${interval} hit key=${requestKey}`);
    }
    return {
      result: cachedFinalResult.value,
      serverTiming: 'cache_hit;dur=0.1,total;dur=0.1',
      cacheHit: true
    };
  }

  let buildPromise = CHART_IN_FLIGHT_REQUESTS.get(requestKey);
  const isDedupedWait = Boolean(buildPromise);
  chartDebugMetrics.cacheMiss += 1;
  if (isDedupedWait) {
    chartDebugMetrics.dedupeJoin += 1;
  } else {
    chartDebugMetrics.buildStarted += 1;
  }
  if (!buildPromise) {
    buildPromise = (async () => {
      const timer = createChartStageTimer();
      const requiredIntervals = Array.from(new Set([
        interval,
        vdSourceInterval,
        vdRsiSourceInterval
      ]));
      const rowsByInterval = new Map();
      const quotePromise = dataApiLatestQuote(ticker).catch((err) => {
        const message = err && err.message ? err.message : String(err);
        if (CHART_TIMING_LOG_ENABLED) {
          console.warn(`[chart-quote] ${ticker} ${interval} skipped: ${message}`);
        }
        return null;
      });
      await Promise.all(requiredIntervals.map(async (tf) => {
        const rows = await dataApiIntradayChartHistory(ticker, tf, lookbackDays);
        rowsByInterval.set(tf, rows || []);
      }));
      timer.step('fetch_rows');

      const result = buildChartResultFromRows({
        ticker,
        interval,
        rowsByInterval,
        vdRsiLength,
        vdSourceInterval,
        vdRsiSourceInterval,
        timer
      });
      const quote = await quotePromise;
      patchLatestBarCloseWithQuote(result, quote);
      if (quote) {
        timer.step('quote_patch');
      }
      setTimedCacheValue(
        CHART_FINAL_RESULT_CACHE,
        requestKey,
        result,
        getChartResultCacheExpiryMs(new Date())
      );
      if (!skipFollowUpPrewarm) {
        if (interval === '4hour') {
          chartDebugMetrics.prewarmRequested.dailyFrom4hour += 1;
        } else if (interval === '1day') {
          chartDebugMetrics.prewarmRequested.fourHourFrom1day += 1;
          chartDebugMetrics.prewarmRequested.weeklyFrom1day += 1;
        }
        schedulePostLoadPrewarmSequence({
          ticker,
          interval,
          vdRsiLength,
          vdSourceInterval,
          vdRsiSourceInterval,
          lookbackDays
        });
      }
      const serverTiming = timer.serverTiming();
      if (CHART_TIMING_LOG_ENABLED) {
        console.log(`[chart-timing] ${ticker} ${interval} ${isDedupedWait ? 'dedupe-wait' : 'build'} ${timer.summary()}`);
      }
      return { result, serverTiming };
    })();
    CHART_IN_FLIGHT_REQUESTS.set(requestKey, buildPromise);
    buildPromise.finally(() => {
      if (CHART_IN_FLIGHT_REQUESTS.get(requestKey) === buildPromise) {
        CHART_IN_FLIGHT_REQUESTS.delete(requestKey);
      }
    }).catch(() => {});
  }

  const { result, serverTiming } = await buildPromise;
  if (isDedupedWait && CHART_TIMING_LOG_ENABLED) {
    console.log(`[chart-dedupe] ${ticker} ${interval} request joined in-flight key=${requestKey}`);
  }
  return { result, serverTiming, cacheHit: false };
}

function findPointByTime(points, timeValue) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const key = String(timeValue);
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (!point || String(point.time) !== key) continue;
    return point;
  }
  return null;
}

function extractLatestChartPayload(result) {
  const bars = Array.isArray(result?.bars) ? result.bars : [];
  const latestBar = bars.length ? bars[bars.length - 1] : null;
  const latestTime = latestBar ? latestBar.time : null;
  const latestRsi = latestTime === null ? null : findPointByTime(result?.rsi, latestTime);
  const latestVolumeDeltaRsi = latestTime === null
    ? null
    : findPointByTime(result?.volumeDeltaRsi?.rsi, latestTime);
  const latestVolumeDelta = latestTime === null
    ? null
    : findPointByTime(result?.volumeDelta, latestTime);

  return {
    interval: result.interval,
    timezone: result?.timezone || 'America/Los_Angeles',
    latestBar,
    latestRsi,
    latestVolumeDeltaRsi,
    latestVolumeDelta
  };
}

function buildNeutralDivergenceStates() {
  const states = {};
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    states[String(days)] = 'neutral';
  }
  return states;
}

function computeDivergenceSummaryStatesFromDailyResult(result, options = {}) {
  const bars = Array.isArray(result?.bars) ? result.bars : [];
  const volumeDelta = Array.isArray(result?.volumeDelta) ? result.volumeDelta : [];
  const maxTradeDateKey = String(options.maxTradeDateKey || '').trim();
  const deltaByTime = new Map();
  for (const point of volumeDelta) {
    const time = Number(point?.time);
    const delta = Number(point?.delta);
    if (!Number.isFinite(time) || !Number.isFinite(delta)) continue;
    deltaByTime.set(time, delta);
  }

  const unixTimes = [];
  const closes = [];
  const deltaPrefix = [0];
  let runningDelta = 0;
  for (const bar of bars) {
    const unix = Number(bar?.time);
    const close = Number(bar?.close);
    if (!Number.isFinite(unix) || !Number.isFinite(close)) continue;
    if (maxTradeDateKey) {
      const tradeDate = pacificDateStringFromUnixSeconds(unix);
      if (tradeDate && tradeDate > maxTradeDateKey) {
        continue;
      }
    }
    runningDelta += Number(deltaByTime.get(unix) || 0);
    unixTimes.push(unix);
    closes.push(close);
    deltaPrefix.push(runningDelta);
  }

  const states = buildNeutralDivergenceStates();
  if (unixTimes.length < 2) {
    return {
      states,
      tradeDate: ''
    };
  }

  const lastIndex = unixTimes.length - 1;
  const latestUnix = unixTimes[lastIndex];
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    // `days` = trading days; each entry in unixTimes is one trading day.
    const startIndex = lastIndex - days;
    if (startIndex < 0 || startIndex >= lastIndex) continue;
    const startClose = closes[startIndex];
    const endClose = closes[lastIndex];
    if (!Number.isFinite(startClose) || !Number.isFinite(endClose)) continue;
    // Sum only the bars strictly after the start close and up to the latest close.
    // For 1D, this means "latest daily bar delta", not "latest + previous".
    const sumDelta = (deltaPrefix[lastIndex + 1] || 0) - (deltaPrefix[startIndex + 1] || 0);
    if (endClose < startClose && sumDelta > 0) {
      states[String(days)] = 'bullish';
    } else if (endClose > startClose && sumDelta < 0) {
      states[String(days)] = 'bearish';
    }
  }

  return {
    states,
    tradeDate: pacificDateStringFromUnixSeconds(latestUnix)
  };
}

function getDivergenceSummaryCacheKey(ticker, sourceInterval) {
  return `${String(ticker || '').toUpperCase()}|${String(sourceInterval || '1min')}`;
}

function getCachedDivergenceSummaryEntry(ticker, sourceInterval) {
  return null;
}

function setDivergenceSummaryCacheEntry(entry) {
  return;
}

function clearDivergenceSummaryCacheForSourceInterval(sourceInterval) {
  return;
}

function normalizeDivergenceState(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'bullish' || normalized === 'bearish') return normalized;
  return 'neutral';
}

function normalizeSummaryMaState(value) {
  if (value === true) return true;
  if (value === false) return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric === 1) return true;
    if (numeric === 0) return false;
  }
  const text = String(value || '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return false;
}

function buildDivergenceSummaryEntryFromRow(row, sourceInterval, nowMs, expiresAtMs) {
  const ticker = String(row?.ticker || '').toUpperCase();
  if (!ticker) return null;
  const entry = {
    ticker,
    sourceInterval,
    tradeDate: String(row?.trade_date || '').trim() || null,
    states: {
      '1': normalizeDivergenceState(row?.state_1d),
      '3': normalizeDivergenceState(row?.state_3d),
      '7': normalizeDivergenceState(row?.state_7d),
      '14': normalizeDivergenceState(row?.state_14d),
      '28': normalizeDivergenceState(row?.state_28d)
    },
    maStates: {
      ema8: normalizeSummaryMaState(row?.ma8_above),
      ema21: normalizeSummaryMaState(row?.ma21_above),
      sma50: normalizeSummaryMaState(row?.ma50_above),
      sma200: normalizeSummaryMaState(row?.ma200_above)
    },
    computedAtMs: nowMs,
    expiresAtMs
  };
  setDivergenceSummaryCacheEntry(entry);
  return entry;
}

async function getStoredDivergenceSummariesForTickers(tickers, sourceInterval, options = {}) {
  const map = new Map();
  if (!divergencePool || !Array.isArray(tickers) || tickers.length === 0) {
    return map;
  }
  const includeLatestFallbackForMissing = options.includeLatestFallbackForMissing !== false;

  const normalizedTickers = Array.from(new Set(
    tickers
      .map((ticker) => String(ticker || '').toUpperCase())
      .filter((ticker) => ticker && isValidTickerSymbol(ticker))
  ));
  if (!normalizedTickers.length) {
    return map;
  }

  const nowMs = Date.now();
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));
  const result = await divergencePool.query(`
    SELECT DISTINCT ON (ticker)
      ticker,
      trade_date::text AS trade_date,
      state_1d,
      state_3d,
      state_7d,
      state_14d,
      state_28d,
      ma8_above,
      ma21_above,
      ma50_above,
      ma200_above
    FROM divergence_summaries
    WHERE source_interval = $1
      AND ticker = ANY($2::VARCHAR[])
    ORDER BY ticker ASC, trade_date DESC
  `, [sourceInterval, normalizedTickers]);

  for (const row of result.rows) {
    const entry = buildDivergenceSummaryEntryFromRow(row, sourceInterval, nowMs, expiresAtMs);
    if (!entry) continue;
    map.set(entry.ticker, entry);
  }

  if (!includeLatestFallbackForMissing) {
    return map;
  }

  // Historical compatibility: option retained to preserve callsite semantics.
  return map;
}

async function mapWithConcurrency(items, concurrency, worker, onSettled, shouldStop) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const maxConcurrency = Math.max(1, Math.min(list.length, Number(concurrency) || 1));
  const results = new Array(list.length);
  let cursor = 0;
  let cancelled = false;
  let cancelResolve = null;
  const cancelPromise = new Promise((resolve) => { cancelResolve = resolve; });

  async function runOneWorker() {
    while (cursor < list.length) {
      if (cancelled) break;
      if (typeof shouldStop === 'function') {
        try {
          if (shouldStop()) {
            if (!cancelled) {
              cancelled = true;
              cursor = list.length;
              cancelResolve();
            }
            break;
          }
        } catch {
          // Ignore stop-check callback errors and continue processing.
        }
      }
      const currentIndex = cursor;
      cursor += 1;
      try {
        results[currentIndex] = await worker(list[currentIndex], currentIndex);
      } catch (err) {
        results[currentIndex] = { error: err };
        if (isAbortError(err) && typeof shouldStop === 'function') {
          try {
            if (shouldStop()) {
              if (!cancelled) {
                cancelled = true;
                cursor = list.length;
                cancelResolve();
              }
              break;
            }
          } catch {
            // Ignore stop-check callback errors.
          }
        }
      } finally {
        if (typeof onSettled === 'function') {
          try {
            onSettled(results[currentIndex], currentIndex, list[currentIndex]);
          } catch {
            // Best-effort callback for progress reporting.
          }
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < maxConcurrency; i++) {
    workers.push(runOneWorker());
  }
  await Promise.race([Promise.all(workers), cancelPromise]);
  // After cancel, wait for all in-flight workers to finish their current item
  // so callers can safely access shared state (buffers, counters) without races.
  if (cancelled) {
    await Promise.allSettled(workers);
  }
  return results;
}

function resolveAdaptiveFetchConcurrency(runType = 'fetch-daily') {
  const configured = Math.max(1, Number(DIVERGENCE_TABLE_BUILD_CONCURRENCY) || 1);
  const maxRps = Math.max(1, Number(DATA_API_MAX_REQUESTS_PER_SECOND) || 1);
  const estimatedApiCallsPerTicker = runType === 'fetch-weekly' ? 10 : 8;
  const targetTickersPerSecond = Math.max(1, Math.floor(maxRps / estimatedApiCallsPerTicker));
  const adaptive = Math.max(4, targetTickersPerSecond * 4);
  return Math.max(1, Math.min(configured, adaptive));
}

async function buildDailyDivergenceSummaryInput(options = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const lookbackDays = Math.max(1, Math.floor(Number(options.lookbackDays) || getIntradayLookbackDays('1day')));
  if (!ticker) {
    return { bars: [], volumeDelta: [] };
  }

  const parentFetchInterval = '4hour';
  const requiredIntervals = Array.from(new Set([parentFetchInterval, vdSourceInterval]));
  const rowsByInterval = new Map();
  await Promise.all(requiredIntervals.map(async (tf) => {
    const rows = await dataApiIntradayChartHistory(ticker, tf, lookbackDays);
    rowsByInterval.set(tf, rows || []);
  }));

  const parentRows = rowsByInterval.get(parentFetchInterval) || [];
  if (!Array.isArray(parentRows) || parentRows.length === 0) {
    return { bars: [], volumeDelta: [] };
  }

  const dailyBars = aggregate4HourBarsToDaily(
    convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time))
  );
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return { bars: [], volumeDelta: [] };
  }

  const sourceRows = rowsByInterval.get(vdSourceInterval) || [];
  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], vdSourceInterval).sort((a, b) => Number(a.time) - Number(b.time))
  );
  const volumeDelta = computeVolumeDeltaByParentBars(dailyBars, sourceBars, '1day').map((point) => ({
    time: point.time,
    delta: Number.isFinite(Number(point?.delta)) ? Number(point.delta) : 0
  }));
  return {
    bars: dailyBars,
    volumeDelta
  };
}

async function persistOnDemandTickerDivergenceSummary(options = {}) {
  if (!divergencePool) return;
  const entry = options.entry || null;
  const latestDailyBar = options.latestDailyBar || null;
  if (!entry || !entry.ticker || !entry.sourceInterval) return;

  if (latestDailyBar && latestDailyBar.trade_date) {
    await upsertDivergenceDailyBarsBatch([latestDailyBar], null);
  }
  if (entry.tradeDate) {
    await upsertDivergenceSummaryBatch([{
      ticker: entry.ticker,
      source_interval: entry.sourceInterval,
      trade_date: entry.tradeDate,
      states: entry.states,
      ma_states: entry.maStates || null
    }], null);
  }
}

async function getOrBuildTickerDivergenceSummary(options = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const forceRefresh = Boolean(options.forceRefresh);
  const persistToDatabase = options.persistToDatabase !== false;
  if (!ticker || !isValidTickerSymbol(ticker)) return null;

  if (!forceRefresh) {
    const storedMap = await getStoredDivergenceSummariesForTickers([ticker], vdSourceInterval);
    const stored = storedMap.get(ticker);
    if (stored) return stored;
  }

  const nowMs = Date.now();
  const lookbackDays = getIntradayLookbackDays('1day');
  const asOfTradeDate = resolveLastClosedDailyCandleDate(new Date(nowMs));
  const dailyRows = await buildDivergenceDailyRowsForTicker({
    ticker,
    sourceInterval: vdSourceInterval,
    lookbackDays,
    asOfTradeDate,
    parentInterval: '1day',
    noCache: true
  });
  const filteredRows = Array.isArray(dailyRows)
    ? dailyRows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate)
    : [];
  const latestDailyBar = filteredRows.length > 0 ? filteredRows[filteredRows.length - 1] : null;
  const states = filteredRows.length >= 2
    ? classifyDivergenceStateMapFromDailyRows(filteredRows)
    : buildNeutralDivergenceStateMap();
  const tradeDate = String(latestDailyBar?.trade_date || asOfTradeDate || '').trim() || null;
  const entry = {
    ticker,
    sourceInterval: vdSourceInterval,
    tradeDate,
    states,
    computedAtMs: nowMs,
    expiresAtMs: nextPacificDivergenceRefreshUtcMs(new Date(nowMs))
  };
  if (persistToDatabase) {
    try {
      await persistOnDemandTickerDivergenceSummary({
        entry,
        latestDailyBar
      });

      // Return the value as stored in DB (single source of truth).
      const storedMap = await getStoredDivergenceSummariesForTickers([ticker], vdSourceInterval);
      const stored = storedMap.get(ticker);
      if (stored) return stored;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Failed to persist on-demand divergence summary for ${ticker}: ${message}`);
    }
  }
  return entry;
}

async function getDivergenceSummaryForTickers(options = {}) {
  const tickers = Array.isArray(options.tickers)
    ? options.tickers.map((ticker) => String(ticker || '').toUpperCase()).filter((ticker) => ticker && isValidTickerSymbol(ticker))
    : [];
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  if (tickers.length === 0) {
    return {
      sourceInterval: vdSourceInterval,
      refreshedAt: new Date().toISOString(),
      summaries: []
    };
  }

  const uniqueTickers = Array.from(new Set(tickers));
  const forceRefresh = Boolean(options.forceRefresh);
  if (forceRefresh) {
    await mapWithConcurrency(
      uniqueTickers,
      8,
      async (ticker) => {
        await getOrBuildTickerDivergenceSummary({
          ticker,
          vdSourceInterval,
          forceRefresh: true,
          persistToDatabase: true
        });
      },
      (result, _index, ticker) => {
        if (result && result.error) {
          const message = result.error && result.error.message ? result.error.message : String(result.error);
          console.error(`Failed to force-refresh divergence summary for ${ticker}: ${message}`);
        }
      }
    );
  }

  const summariesByTicker = await getStoredDivergenceSummariesForTickers(uniqueTickers, vdSourceInterval);
  const summaries = [];
  const nowMs = Date.now();
  const fallbackTradeDate = await resolveDivergenceAsOfTradeDate(vdSourceInterval);
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));
  const neutralStates = buildNeutralDivergenceStateMap();
  for (const ticker of uniqueTickers) {
    const entry = summariesByTicker.get(ticker);
    if (entry) {
      summaries.push(entry);
      continue;
    }
    summaries.push({
      ticker,
      sourceInterval: vdSourceInterval,
      tradeDate: fallbackTradeDate,
      states: neutralStates,
      maStates: {
        ema8: false,
        ema21: false,
        sma50: false,
        sma200: false
      },
      computedAtMs: nowMs,
      expiresAtMs
    });
  }

  return {
    sourceInterval: vdSourceInterval,
    refreshedAt: new Date().toISOString(),
    summaries: summaries.map((entry) => ({
      ticker: entry.ticker,
      tradeDate: entry.tradeDate,
      states: entry.states,
      maStates: entry.maStates,
      expiresAtMs: entry.expiresAtMs
    }))
  };
}

// --- VDF (Volume Divergence Flag) Detector helpers ---
let vdfRunningTickers = new Set();

async function getStoredVDFResult(ticker, tradeDate) {
  if (!isDivergenceConfigured()) return null;
  try {
    const { rows } = await divergencePool.query(
      `SELECT is_detected, composite_score, status, weeks, result_json,
              best_zone_score, proximity_score, proximity_level, num_zones, has_distribution
       FROM vdf_results WHERE ticker = $1 AND trade_date = $2 LIMIT 1`,
      [ticker, tradeDate]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    let parsed = {};
    try { parsed = row.result_json ? JSON.parse(row.result_json) : {}; } catch { /* ignore */ }
    return {
      is_detected: row.is_detected,
      composite_score: Number(row.composite_score) || 0,
      status: row.status || '',
      weeks: Number(row.weeks) || 0,
      best_zone_score: Number(row.best_zone_score) || 0,
      proximity_score: Number(row.proximity_score) || 0,
      proximity_level: row.proximity_level || 'none',
      num_zones: Number(row.num_zones) || 0,
      has_distribution: row.has_distribution || false,
      zones: parsed.zones || [],
      distribution: parsed.distribution || [],
      proximity: parsed.proximity || { compositeScore: 0, level: 'none', signals: [] },
      details: parsed
    };
  } catch (err) {
    console.error('getStoredVDFResult error:', err && err.message ? err.message : err);
    return null;
  }
}

async function upsertVDFResult(ticker, tradeDate, result) {
  if (!isDivergenceConfigured()) return;
  try {
    const bestScore = result.bestScore || result.score || 0;
    const proxScore = result.proximity?.compositeScore || 0;
    const proxLevel = result.proximity?.level || 'none';
    const numZones = result.zones?.length || 0;
    const hasDist = (result.distribution?.length || 0) > 0;
    const resultJson = JSON.stringify({
      zones: result.zones || [],
      distribution: result.distribution || [],
      proximity: result.proximity || { compositeScore: 0, level: 'none', signals: [] },
      metrics: result.metrics || null,
      reason: result.reason || '',
    });
    await divergencePool.query(
      `INSERT INTO vdf_results (ticker, trade_date, is_detected, composite_score, status, weeks, result_json,
                                best_zone_score, proximity_score, proximity_level, num_zones, has_distribution, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (ticker, trade_date) DO UPDATE SET
         is_detected = EXCLUDED.is_detected,
         composite_score = EXCLUDED.composite_score,
         status = EXCLUDED.status,
         weeks = EXCLUDED.weeks,
         result_json = EXCLUDED.result_json,
         best_zone_score = EXCLUDED.best_zone_score,
         proximity_score = EXCLUDED.proximity_score,
         proximity_level = EXCLUDED.proximity_level,
         num_zones = EXCLUDED.num_zones,
         has_distribution = EXCLUDED.has_distribution,
         updated_at = NOW()`,
      [
        ticker, tradeDate,
        result.detected || false,
        bestScore,
        result.status || '',
        result.bestZoneWeeks || result.weeks || 0,
        resultJson,
        bestScore,
        proxScore,
        proxLevel,
        numZones,
        hasDist
      ]
    );
  } catch (err) {
    console.error('upsertVDFResult error:', err && err.message ? err.message : err);
  }
}

async function getVDFStatus(ticker, options = {}) {
  const force = options.force === true;
  const signal = options.signal || null;
  const today = currentEtDateString();

  // Check DB cache (same trading day) unless force
  if (!force) {
    const cached = await getStoredVDFResult(ticker, today);
    if (cached) return { ...cached, cached: true };
  }

  // Prevent parallel detection for the same ticker
  if (vdfRunningTickers.has(ticker)) {
    return {
      is_detected: false, composite_score: 0, status: 'Detection in progress', weeks: 0,
      best_zone_score: 0, proximity_score: 0, proximity_level: 'none', num_zones: 0, has_distribution: false,
      zones: [], distribution: [], proximity: { compositeScore: 0, level: 'none', signals: [] },
      cached: false
    };
  }
  vdfRunningTickers.add(ticker);

  try {
    const result = await detectVDF(ticker, {
      dataApiFetcher: dataApiIntradayChartHistory,
      signal,
      lookbackDays: 130,
    });

    // Store in DB
    await upsertVDFResult(ticker, today, result);

    return {
      is_detected: result.detected || false,
      composite_score: result.bestScore || 0,
      status: result.status || '',
      weeks: result.bestZoneWeeks || 0,
      best_zone_score: result.bestScore || 0,
      proximity_score: result.proximity?.compositeScore || 0,
      proximity_level: result.proximity?.level || 'none',
      num_zones: result.zones?.length || 0,
      has_distribution: (result.distribution?.length || 0) > 0,
      zones: result.zones || [],
      distribution: result.distribution || [],
      proximity: result.proximity || { compositeScore: 0, level: 'none', signals: [] },
      details: { metrics: result.metrics, reason: result.reason },
      cached: false
    };
  } finally {
    vdfRunningTickers.delete(ticker);
  }
}

// --- VDF Scan (bulk) state ---
let vdfScanRunning = false;
let vdfScanStopRequested = false;
let vdfScanAbortController = null;
let vdfScanStatus = {
  running: false,
  status: 'idle',
  totalTickers: 0,
  processedTickers: 0,
  errorTickers: 0,
  detectedTickers: 0,
  startedAt: null,
  finishedAt: null
};

function getVDFScanStatus() {
  return {
    running: Boolean(vdfScanRunning),
    stop_requested: Boolean(vdfScanStopRequested),
    status: String(vdfScanStatus.status || 'idle'),
    total_tickers: Number(vdfScanStatus.totalTickers || 0),
    processed_tickers: Number(vdfScanStatus.processedTickers || 0),
    error_tickers: Number(vdfScanStatus.errorTickers || 0),
    detected_tickers: Number(vdfScanStatus.detectedTickers || 0),
    started_at: vdfScanStatus.startedAt || null,
    finished_at: vdfScanStatus.finishedAt || null
  };
}

function requestStopVDFScan() {
  if (!vdfScanRunning) return false;
  vdfScanStopRequested = true;
  vdfScanStatus = {
    ...vdfScanStatus,
    status: 'stopping',
    finishedAt: null
  };
  if (vdfScanAbortController && !vdfScanAbortController.signal.aborted) {
    try {
      vdfScanAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}

async function runVDFScan(options = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (vdfScanRunning) {
    return { status: 'running' };
  }

  vdfScanRunning = true;
  vdfScanStopRequested = false;
  runMetricsByType.vdfScan = null;

  let processedTickers = 0;
  let errorTickers = 0;
  let detectedTickers = 0;
  const startedAtIso = new Date().toISOString();
  const scanAbort = new AbortController();
  vdfScanAbortController = scanAbort;
  vdfScanStatus = {
    running: true,
    status: 'running',
    totalTickers: 0,
    processedTickers: 0,
    errorTickers: 0,
    detectedTickers: 0,
    startedAt: startedAtIso,
    finishedAt: null
  };

  const runConcurrency = resolveAdaptiveFetchConcurrency('vdf-scan');
  let runMetricsTracker = null;
  const today = currentEtDateString();
  const failedTickers = [];

  try {
    const tickers = await getStoredDivergenceSymbolTickers();
    const totalTickers = tickers.length;
    vdfScanStatus.totalTickers = totalTickers;

    runMetricsTracker = createRunMetricsTracker('vdfScan', {
      totalTickers,
      concurrency: runConcurrency
    });
    runMetricsTracker.setTotals(totalTickers);
    runMetricsTracker.setPhase('core');

    await mapWithConcurrency(
      tickers,
      runConcurrency,
      async (ticker) => {
        if (vdfScanStopRequested || scanAbort.signal.aborted) {
          return { ticker, skipped: true };
        }
        const apiStart = Date.now();
        try {
          const result = await getVDFStatus(ticker, { force: true, signal: scanAbort.signal });
          const latencyMs = Date.now() - apiStart;
          if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: true });
          return { ticker, result, error: null };
        } catch (err) {
          const latencyMs = Date.now() - apiStart;
          if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: false });
          return { ticker, result: null, error: err };
        }
      },
      (settled) => {
        if (settled.skipped) return;
        processedTickers++;
        if (settled.error) {
          errorTickers++;
          failedTickers.push(settled.ticker);
          if (!(vdfScanStopRequested && isAbortError(settled.error))) {
            console.error(`VDF scan error for ${settled.ticker}:`, settled.error?.message || settled.error);
          }
        } else if (settled.result && settled.result.is_detected) {
          detectedTickers++;
        }
        vdfScanStatus.processedTickers = processedTickers;
        vdfScanStatus.errorTickers = errorTickers;
        vdfScanStatus.detectedTickers = detectedTickers;
        vdfScanStatus.status = vdfScanStopRequested ? 'stopping' : 'running';
        if (runMetricsTracker) {
          runMetricsTracker.setProgress(processedTickers, errorTickers);
        }
      },
      () => vdfScanStopRequested || scanAbort.signal.aborted
    );

    if (vdfScanStopRequested) {
      vdfScanStopRequested = false;
      vdfScanStatus = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        detectedTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString()
      };
      if (runMetricsTracker) {
        runMetricsTracker.finish('stopped', {
          totalTickers,
          processedTickers,
          errorTickers,
          failedTickers
        });
      }
      return { status: 'stopped', processedTickers, errorTickers, detectedTickers };
    }

    // Retry failed tickers once
    if (failedTickers.length > 0 && !vdfScanStopRequested && !scanAbort.signal.aborted) {
      const retryTickers = [...failedTickers];
      failedTickers.length = 0;
      vdfScanStatus.status = 'running-retry';
      if (runMetricsTracker) runMetricsTracker.setPhase('retry');

      await mapWithConcurrency(
        retryTickers,
        Math.max(1, Math.floor(runConcurrency / 2)),
        async (ticker) => {
          if (vdfScanStopRequested || scanAbort.signal.aborted) {
            return { ticker, skipped: true };
          }
          const apiStart = Date.now();
          try {
            const result = await getVDFStatus(ticker, { force: true, signal: scanAbort.signal });
            const latencyMs = Date.now() - apiStart;
            if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: true });
            return { ticker, result, error: null };
          } catch (err) {
            const latencyMs = Date.now() - apiStart;
            if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: false });
            return { ticker, result: null, error: err };
          }
        },
        (settled) => {
          if (settled.skipped) return;
          if (settled.error) {
            failedTickers.push(settled.ticker);
          } else {
            errorTickers--;
            if (settled.result && settled.result.is_detected) {
              detectedTickers++;
            }
          }
          vdfScanStatus.errorTickers = errorTickers;
          vdfScanStatus.detectedTickers = detectedTickers;
        },
        () => vdfScanStopRequested || scanAbort.signal.aborted
      );
    }

    const finalStatus = errorTickers > 0 ? 'completed-with-errors' : 'completed';
    vdfScanStopRequested = false;
    vdfScanStatus = {
      running: false,
      status: finalStatus,
      totalTickers,
      processedTickers,
      errorTickers,
      detectedTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString()
    };
    if (runMetricsTracker) {
      runMetricsTracker.finish(finalStatus, {
        totalTickers,
        processedTickers,
        errorTickers,
        failedTickers
      });
    }
    return { status: finalStatus, processedTickers, errorTickers, detectedTickers };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`VDF scan failed: ${message}`);
    vdfScanStopRequested = false;
    vdfScanStatus = {
      running: false,
      status: 'failed',
      totalTickers: vdfScanStatus.totalTickers,
      processedTickers,
      errorTickers,
      detectedTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString()
    };
    if (runMetricsTracker) {
      runMetricsTracker.finish('failed', {
        totalTickers: vdfScanStatus.totalTickers,
        processedTickers,
        errorTickers,
        failedTickers
      });
    }
    return { status: 'failed', error: message };
  } finally {
    if (vdfScanAbortController === scanAbort) {
      vdfScanAbortController = null;
    }
    vdfScanRunning = false;
  }
}

registerChartRoutes({
  app,
  parseChartRequestParams,
  validChartIntervals: VALID_CHART_INTERVALS,
  getOrBuildChartResult,
  extractLatestChartPayload,
  sendChartJsonResponse,
  validateChartPayload: validateChartPayloadShape,
  validateChartLatestPayload: validateChartLatestPayloadShape,
  onChartRequestMeasured: recordChartRequestTiming,
  isValidTickerSymbol,
  getDivergenceSummaryForTickers,
  barsToTuples,
  pointsToTuples,
  getMiniBarsCacheByTicker: () => miniBarsCacheByTicker,
  getVDFStatus
});

function etDateStringFromUnixSeconds(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function currentEtDateString(nowUtc = new Date()) {
  return nowUtc.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function maxEtDateString(a, b) {
  const aVal = String(a || '').trim();
  const bVal = String(b || '').trim();
  if (!aVal) return bVal || '';
  if (!bVal) return aVal;
  return aVal >= bVal ? aVal : bVal;
}

function parseDateKeyToUtcMs(dateKey) {
  const value = String(dateKey || '').trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

function dateKeyDaysAgo(dateKey, days) {
  const baseMs = parseDateKeyToUtcMs(dateKey);
  if (!Number.isFinite(baseMs)) return '';
  const shifted = new Date(baseMs - (Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000));
  return shifted.toISOString().slice(0, 10);
}

async function getPublishedTradeDateForSourceInterval(sourceInterval) {
  if (!divergencePool) return '';
  const normalizedSource = String(sourceInterval || DIVERGENCE_SOURCE_INTERVAL);
  try {
    const result = await divergencePool.query(`
      SELECT published_trade_date::text AS published_trade_date
      FROM divergence_publication_state
      WHERE source_interval = $1
      LIMIT 1
    `, [normalizedSource]);
    const explicit = String(result.rows[0]?.published_trade_date || '').trim();
    if (explicit) return explicit;

    const fallback = await divergencePool.query(`
      SELECT scanned_trade_date::text AS scanned_trade_date
      FROM divergence_scan_jobs
      WHERE status = 'completed'
        AND scanned_trade_date IS NOT NULL
      ORDER BY finished_at DESC NULLS LAST, started_at DESC
      LIMIT 1
    `);
    return String(fallback.rows[0]?.scanned_trade_date || '').trim();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`Failed to read divergence publication state: ${message}`);
    return '';
  }
}

async function resolveDivergenceAsOfTradeDate(sourceInterval, explicitTradeDate = '') {
  const explicit = String(explicitTradeDate || '').trim();
  if (explicit) return explicit;

  const publishedTradeDate = await getPublishedTradeDateForSourceInterval(sourceInterval);
  const fallbackTradeDate = latestCompletedPacificTradeDateKey(new Date()) || currentEtDateString();
  return maxEtDateString(publishedTradeDate, fallbackTradeDate)
    || fallbackTradeDate
    || publishedTradeDate
    || currentEtDateString();
}

async function fetchUsStockUniverseFromDataApi() {
  assertDataApiKey();
  const rows = [];
  let nextUrl = buildDataApiUrl('/v3/reference/tickers', {
    market: 'stocks',
    locale: 'us',
    active: 'true',
    order: 'asc',
    sort: 'ticker',
    limit: 1000
  });
  let guard = 0;
  while (nextUrl && guard < 1000) {
    guard += 1;
    const payload = await fetchDataApiJson(nextUrl, 'DataAPI stock universe');
    const pageRows = Array.isArray(payload?.results) ? payload.results : [];
    rows.push(...pageRows);
    nextUrl = typeof payload?.next_url === 'string' && payload.next_url.trim()
      ? payload.next_url.trim()
      : '';
  }

  const symbols = [];
  for (const row of rows) {
    const symbol = normalizeTickerSymbol(row?.ticker || row?.symbol);
    if (!symbol || symbol.includes('/')) continue;
    const exchange = String(row?.primary_exchange || row?.exchange || '').toUpperCase();
    const type = String(row?.type || row?.asset_type || '').toLowerCase();
    const active = row?.active;
    if (active === false || String(active).toLowerCase() === 'false') continue;
    if (type.includes('etf') || type.includes('fund') || type.includes('etn')) continue;
    symbols.push({
      ticker: symbol,
      exchange: exchange || null,
      assetType: type || null
    });
  }

  const unique = new Map();
  for (const row of symbols) {
    if (!unique.has(row.ticker)) unique.set(row.ticker, row);
  }
  return Array.from(unique.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function refreshDivergenceSymbolUniverse(options = {}) {
  const fullReset = Boolean(options.fullReset);
  const symbols = await fetchUsStockUniverseFromDataApi();
  await withDivergenceClient(async (client) => {
    await client.query('BEGIN');
    try {
      if (fullReset) {
        await client.query('UPDATE divergence_symbols SET is_active = FALSE WHERE is_active = TRUE');
      }
      for (const symbol of symbols) {
        await client.query(`
          INSERT INTO divergence_symbols(ticker, exchange, asset_type, is_active, updated_at)
          VALUES($1, $2, $3, TRUE, NOW())
          ON CONFLICT (ticker)
          DO UPDATE SET
            exchange = EXCLUDED.exchange,
            asset_type = EXCLUDED.asset_type,
            is_active = TRUE,
            updated_at = NOW()
        `, [symbol.ticker, symbol.exchange, symbol.assetType]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return symbols.map((s) => s.ticker);
}

async function getDivergenceUniverseTickers(options = {}) {
  if (!divergencePool) return [];
  const forceRefresh = Boolean(options.forceRefresh);
  const existing = await divergencePool.query(`
    SELECT ticker
    FROM divergence_symbols
    WHERE is_active = TRUE
    ORDER BY ticker ASC
  `);
  const storedTickers = existing.rows
    .map((row) => String(row.ticker || '').trim().toUpperCase())
    .filter(Boolean);

  // Long-term persistence: once we have a populated universe, keep using it.
  if (!forceRefresh && storedTickers.length >= DIVERGENCE_MIN_UNIVERSE_SIZE) {
    return storedTickers;
  }

  try {
    const bootstrapped = await refreshDivergenceSymbolUniverse({ fullReset: forceRefresh });
    if (bootstrapped.length > 0) {
      console.log(`Divergence universe bootstrap updated to ${bootstrapped.length} symbols.`);
      return bootstrapped;
    }
    if (storedTickers.length > 0) return storedTickers;
    return [];
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`DataAPI universe bootstrap failed, falling back to cached divergence symbols: ${message}`);
    return storedTickers;
  }
}

async function getStoredDivergenceSymbolTickers() {
  if (!divergencePool) return [];
  const existing = await divergencePool.query(`
    SELECT ticker
    FROM divergence_symbols
    WHERE is_active = TRUE
    ORDER BY ticker ASC
  `);
  return existing.rows
    .map((row) => String(row.ticker || '').trim().toUpperCase())
    .filter((ticker) => ticker && isValidTickerSymbol(ticker));
}

async function getLatestWeeklySignalTradeDate(sourceInterval) {
  if (!divergencePool) return '';
  const normalizedSource = String(sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const result = await divergencePool.query(`
    SELECT MAX(trade_date)::text AS trade_date
    FROM divergence_signals
    WHERE timeframe = '1w'
      AND source_interval = $1
  `, [normalizedSource]);
  return String(result.rows[0]?.trade_date || '').trim();
}

async function computeSymbolDivergenceSignals(ticker, options = {}) {
  const signal = options && options.signal ? options.signal : null;
  const parentFetchInterval = '4hour';
  const [parentRows, sourceRows] = await Promise.all([
    dataApiIntradayChartHistory(ticker, parentFetchInterval, DIVERGENCE_SCAN_LOOKBACK_DAYS, { signal }),
    dataApiIntradayChartHistory(ticker, DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_SCAN_LOOKBACK_DAYS, { signal })
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) {
    return { signals: [], latestTradeDate: '', dailyBar: null };
  }
  const dailyBars = aggregate4HourBarsToDaily(
    convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time))
  );
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return { signals: [], latestTradeDate: '', dailyBar: null };
  }
  const latestDaily = dailyBars[dailyBars.length - 1];
  const latestTradeDate = etDateStringFromUnixSeconds(Number(latestDaily?.time)) || '';

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], DIVERGENCE_SOURCE_INTERVAL).sort((a, b) => Number(a.time) - Number(b.time))
  );
  const dailyDeltas = computeVolumeDeltaByParentBars(dailyBars, sourceBars, DIVERGENCE_SCAN_PARENT_INTERVAL);
  const deltaByTime = new Map(dailyDeltas.map((point) => [Number(point.time), Number(point.delta) || 0]));

  const results = [];
  const previousDaily = dailyBars[dailyBars.length - 2];
  const latestDelta = Number(deltaByTime.get(Number(latestDaily?.time))) || 0;
  const dailyBar = latestDaily
    ? {
      ticker,
      trade_date: latestTradeDate,
      source_interval: DIVERGENCE_SOURCE_INTERVAL,
      close: Number(latestDaily.close),
      prev_close: Number(previousDaily?.close ?? latestDaily.close),
      volume_delta: latestDelta
    }
    : null;

  if (latestDaily && previousDaily) {
    const signal = classifyDivergenceSignal(latestDelta, Number(latestDaily.close), Number(previousDaily.close));
    if (signal) {
      results.push({
        ticker,
        signal_type: signal,
        trade_date: etDateStringFromUnixSeconds(Number(latestDaily.time)),
        timeframe: '1d',
        source_interval: DIVERGENCE_SOURCE_INTERVAL,
        price: Number(latestDaily.close),
        prev_close: Number(previousDaily.close),
        volume_delta: latestDelta
      });
    }
  }

  return { signals: results, latestTradeDate, dailyBar };
}

async function startDivergenceScanJob(runForDate, totalSymbols, trigger) {
  if (!divergencePool) return null;
  const result = await divergencePool.query(`
    INSERT INTO divergence_scan_jobs(run_for_date, status, total_symbols, notes)
    VALUES($1, 'running', $2, $3)
    RETURNING id
  `, [runForDate, totalSymbols, `trigger=${trigger}`]);
  return Number(result.rows[0]?.id || 0) || null;
}

const SCAN_JOB_ALLOWED_COLUMNS = new Set([
  'status', 'finished_at', 'processed_symbols', 'bullish_count',
  'bearish_count', 'error_count', 'notes', 'scanned_trade_date', 'total_symbols'
]);

async function updateDivergenceScanJob(jobId, patch) {
  if (!divergencePool || !jobId) return;
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!SCAN_JOB_ALLOWED_COLUMNS.has(key)) continue;
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx += 1;
  }
  if (!fields.length) return;
  values.push(jobId);
  await divergencePool.query(`UPDATE divergence_scan_jobs SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

async function upsertDivergenceSignalsBatch(signals, scanJobId) {
  if (!divergencePool || !Array.isArray(signals) || signals.length === 0) return;
  const tickers = [];
  const signalTypes = [];
  const tradeDates = [];
  const prices = [];
  const prevCloses = [];
  const deltas = [];
  const timeframes = [];
  const sourceIntervals = [];
  const scanJobIds = [];

  for (const signal of signals) {
    tickers.push(signal.ticker);
    signalTypes.push(signal.signal_type);
    tradeDates.push(signal.trade_date);
    prices.push(Number(signal.price));
    prevCloses.push(Number(signal.prev_close));
    deltas.push(Number(signal.volume_delta));
    timeframes.push(signal.timeframe);
    sourceIntervals.push(signal.source_interval);
    scanJobIds.push(scanJobId ?? null);
  }

  await divergencePool.query(`
    INSERT INTO divergence_signals(
      ticker,
      signal_type,
      trade_date,
      price,
      prev_close,
      volume_delta,
      timeframe,
      source_interval,
      timestamp,
      scan_job_id
    )
    SELECT
      s.ticker,
      s.signal_type,
      s.trade_date,
      s.price,
      s.prev_close,
      s.volume_delta,
      s.timeframe,
      s.source_interval,
      NOW(),
      s.scan_job_id
    FROM UNNEST(
      $1::VARCHAR[],
      $2::VARCHAR[],
      $3::DATE[],
      $4::DOUBLE PRECISION[],
      $5::DOUBLE PRECISION[],
      $6::DOUBLE PRECISION[],
      $7::VARCHAR[],
      $8::VARCHAR[],
      $9::INTEGER[]
    ) AS s(
      ticker,
      signal_type,
      trade_date,
      price,
      prev_close,
      volume_delta,
      timeframe,
      source_interval,
      scan_job_id
    )
    ON CONFLICT (trade_date, ticker, timeframe, source_interval)
    DO UPDATE SET
      signal_type = EXCLUDED.signal_type,
      price = EXCLUDED.price,
      prev_close = EXCLUDED.prev_close,
      volume_delta = EXCLUDED.volume_delta,
      timestamp = NOW(),
      scan_job_id = EXCLUDED.scan_job_id
  `, [
    tickers,
    signalTypes,
    tradeDates,
    prices,
    prevCloses,
    deltas,
    timeframes,
    sourceIntervals,
    scanJobIds
  ]);
}

function normalizeOneDaySignalTypeFromState(state) {
  const normalized = String(state || '').trim().toLowerCase();
  if (normalized === 'bullish' || normalized === 'bearish') return normalized;
  return '';
}

async function syncOneDaySignalsFromSummaryRows(summaryRows, sourceInterval, scanJobId = null) {
  if (!divergencePool || !Array.isArray(summaryRows) || summaryRows.length === 0) return;
  const signalRows = [];
  const neutralTickers = [];
  const neutralTradeDates = [];

  for (const row of summaryRows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    const tradeDate = String(row?.trade_date || '').trim();
    const signalType = normalizeOneDaySignalTypeFromState(row?.states?.['1']);
    if (!ticker || !tradeDate) continue;
    if (!signalType) {
      neutralTickers.push(ticker);
      neutralTradeDates.push(tradeDate);
      continue;
    }
    const close = Number(row?.latest_close);
    const prevClose = Number(row?.latest_prev_close);
    const volumeDelta = Number(row?.latest_volume_delta);
    if (!Number.isFinite(close) || !Number.isFinite(prevClose) || !Number.isFinite(volumeDelta)) {
      continue;
    }
    signalRows.push({
      ticker,
      signal_type: signalType,
      trade_date: tradeDate,
      timeframe: '1d',
      source_interval: sourceInterval,
      price: close,
      prev_close: prevClose,
      volume_delta: volumeDelta
    });
  }

  if (signalRows.length > 0) {
    await upsertDivergenceSignalsBatch(signalRows, scanJobId);
  }

  if (neutralTickers.length > 0) {
    await divergencePool.query(`
      DELETE FROM divergence_signals AS ds
      USING (
        SELECT
          s.ticker,
          s.trade_date
        FROM UNNEST(
          $1::VARCHAR[],
          $2::DATE[]
        ) AS s(ticker, trade_date)
      ) AS stale
      WHERE ds.ticker = stale.ticker
        AND ds.trade_date = stale.trade_date
        AND ds.timeframe = '1d'
        AND ds.source_interval = $3
    `, [
      neutralTickers,
      neutralTradeDates,
      sourceInterval
    ]);
  }
}

async function upsertDivergenceDailyBarsBatch(rows, scanJobId) {
  if (!divergencePool || !Array.isArray(rows) || rows.length === 0) return;
  const tickers = [];
  const tradeDates = [];
  const sourceIntervals = [];
  const closes = [];
  const prevCloses = [];
  const deltas = [];
  const scanJobIds = [];

  for (const row of rows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    const tradeDate = String(row?.trade_date || '').trim();
    const sourceInterval = String(row?.source_interval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
    const close = Number(row?.close);
    const prevClose = Number(row?.prev_close);
    const volumeDelta = Number(row?.volume_delta);
    if (!ticker || !tradeDate) continue;
    if (!Number.isFinite(close) || !Number.isFinite(prevClose) || !Number.isFinite(volumeDelta)) continue;
    tickers.push(ticker);
    tradeDates.push(tradeDate);
    sourceIntervals.push(sourceInterval);
    closes.push(close);
    prevCloses.push(prevClose);
    deltas.push(volumeDelta);
    scanJobIds.push(scanJobId ?? null);
  }

  if (!tickers.length) return;

  await divergencePool.query(`
    INSERT INTO divergence_daily_bars(
      ticker,
      trade_date,
      source_interval,
      close,
      prev_close,
      volume_delta,
      scan_job_id,
      updated_at
    )
    SELECT
      s.ticker,
      s.trade_date,
      s.source_interval,
      s.close,
      s.prev_close,
      s.volume_delta,
      s.scan_job_id,
      NOW()
    FROM UNNEST(
      $1::VARCHAR[],
      $2::DATE[],
      $3::VARCHAR[],
      $4::DOUBLE PRECISION[],
      $5::DOUBLE PRECISION[],
      $6::DOUBLE PRECISION[],
      $7::INTEGER[]
    ) AS s(
      ticker,
      trade_date,
      source_interval,
      close,
      prev_close,
      volume_delta,
      scan_job_id
    )
    ON CONFLICT (ticker, trade_date, source_interval)
    DO UPDATE SET
      close = EXCLUDED.close,
      prev_close = EXCLUDED.prev_close,
      volume_delta = EXCLUDED.volume_delta,
      scan_job_id = EXCLUDED.scan_job_id,
      updated_at = NOW()
  `, [
    tickers,
    tradeDates,
    sourceIntervals,
    closes,
    prevCloses,
    deltas,
    scanJobIds
  ]);
}

function buildNeutralDivergenceStateMap() {
  const out = {};
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    out[String(days)] = 'neutral';
  }
  return out;
}

function classifyDivergenceStateMapFromDailyRows(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const states = buildNeutralDivergenceStateMap();
  if (safeRows.length < 2) {
    return states;
  }

  const closes = safeRows.map((row) => Number(row.close));
  const deltaPrefix = [0];
  let runningDelta = 0;
  for (let i = 0; i < safeRows.length; i++) {
    runningDelta += Number(safeRows[i].volume_delta) || 0;
    deltaPrefix.push(runningDelta);
  }

  const endIndex = safeRows.length - 1;
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    // `days` = trading days; each row in safeRows is one trading day.
    const startIndex = endIndex - days;
    if (startIndex < 0 || startIndex >= endIndex) continue;
    const startClose = closes[startIndex];
    const endClose = closes[endIndex];
    if (!Number.isFinite(startClose) || !Number.isFinite(endClose)) continue;
    // Sum only the bars strictly after the start close and up to the latest close.
    const sumDelta = (deltaPrefix[endIndex + 1] || 0) - (deltaPrefix[startIndex + 1] || 0);
    if (endClose < startClose && sumDelta > 0) {
      states[String(days)] = 'bullish';
    } else if (endClose > startClose && sumDelta < 0) {
      states[String(days)] = 'bearish';
    }
  }

  return states;
}

async function upsertDivergenceSummaryBatch(rows, scanJobId) {
  if (!divergencePool || !Array.isArray(rows) || rows.length === 0) return;
  const tickers = [];
  const sourceIntervals = [];
  const tradeDates = [];
  const state1d = [];
  const state3d = [];
  const state7d = [];
  const state14d = [];
  const state28d = [];
  const ma8Above = [];
  const ma21Above = [];
  const ma50Above = [];
  const ma200Above = [];
  const scanJobIds = [];

  for (const row of rows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    const sourceInterval = String(row?.source_interval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
    const tradeDate = String(row?.trade_date || '').trim();
    if (!ticker || !tradeDate) continue;
    const states = row?.states || {};
    const maStates = row?.ma_states || row?.maStates || {};
    tickers.push(ticker);
    sourceIntervals.push(sourceInterval);
    tradeDates.push(tradeDate);
    state1d.push(String(states['1'] || 'neutral'));
    state3d.push(String(states['3'] || 'neutral'));
    state7d.push(String(states['7'] || 'neutral'));
    state14d.push(String(states['14'] || 'neutral'));
    state28d.push(String(states['28'] || 'neutral'));
    ma8Above.push(
      typeof maStates.ema8 === 'boolean'
        ? maStates.ema8
        : null
    );
    ma21Above.push(
      typeof maStates.ema21 === 'boolean'
        ? maStates.ema21
        : null
    );
    ma50Above.push(
      typeof maStates.sma50 === 'boolean'
        ? maStates.sma50
        : null
    );
    ma200Above.push(
      typeof maStates.sma200 === 'boolean'
        ? maStates.sma200
        : null
    );
    scanJobIds.push(scanJobId ?? null);
  }

  if (!tickers.length) return;

  await divergencePool.query(`
    INSERT INTO divergence_summaries(
      ticker,
      source_interval,
      trade_date,
      state_1d,
      state_3d,
      state_7d,
      state_14d,
      state_28d,
      ma8_above,
      ma21_above,
      ma50_above,
      ma200_above,
      scan_job_id,
      updated_at
    )
    SELECT
      s.ticker,
      s.source_interval,
      s.trade_date,
      s.state_1d,
      s.state_3d,
      s.state_7d,
      s.state_14d,
      s.state_28d,
      s.ma8_above,
      s.ma21_above,
      s.ma50_above,
      s.ma200_above,
      s.scan_job_id,
      NOW()
    FROM UNNEST(
      $1::VARCHAR[],
      $2::VARCHAR[],
      $3::DATE[],
      $4::VARCHAR[],
      $5::VARCHAR[],
      $6::VARCHAR[],
      $7::VARCHAR[],
      $8::VARCHAR[],
      $9::BOOLEAN[],
      $10::BOOLEAN[],
      $11::BOOLEAN[],
      $12::BOOLEAN[],
      $13::INTEGER[]
    ) AS s(
      ticker,
      source_interval,
      trade_date,
      state_1d,
      state_3d,
      state_7d,
      state_14d,
      state_28d,
      ma8_above,
      ma21_above,
      ma50_above,
      ma200_above,
      scan_job_id
    )
    ON CONFLICT (ticker, source_interval)
    DO UPDATE SET
      trade_date = EXCLUDED.trade_date,
      state_1d = EXCLUDED.state_1d,
      state_3d = EXCLUDED.state_3d,
      state_7d = EXCLUDED.state_7d,
      state_14d = EXCLUDED.state_14d,
      state_28d = EXCLUDED.state_28d,
      ma8_above = COALESCE(EXCLUDED.ma8_above, divergence_summaries.ma8_above),
      ma21_above = COALESCE(EXCLUDED.ma21_above, divergence_summaries.ma21_above),
      ma50_above = COALESCE(EXCLUDED.ma50_above, divergence_summaries.ma50_above),
      ma200_above = COALESCE(EXCLUDED.ma200_above, divergence_summaries.ma200_above),
      scan_job_id = EXCLUDED.scan_job_id,
      updated_at = NOW()
  `, [
    tickers,
    sourceIntervals,
    tradeDates,
    state1d,
    state3d,
    state7d,
    state14d,
    state28d,
    ma8Above,
    ma21Above,
    ma50Above,
    ma200Above,
    scanJobIds
  ]);
}

async function rebuildDivergenceSummariesForTradeDate(options = {}) {
  if (!divergencePool) {
    return { asOfTradeDate: '', processedTickers: 0 };
  }
  const sourceInterval = String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const scanJobId = Number(options.scanJobId) || null;
  if (!asOfTradeDate) {
    return { asOfTradeDate: '', processedTickers: 0 };
  }

  const maxLookbackTradingDays = Math.max(...DIVERGENCE_LOOKBACK_DAYS);
  // Convert trading days to calendar days (×7/5) with generous buffer for holidays.
  const calendarDaysNeeded = Math.ceil(maxLookbackTradingDays * 7 / 5) + 10;
  const historyStartDate = dateKeyDaysAgo(asOfTradeDate, calendarDaysNeeded) || asOfTradeDate;
  const result = await divergencePool.query(`
    SELECT
      ticker,
      trade_date::text AS trade_date,
      close::double precision AS close,
      volume_delta::double precision AS volume_delta
    FROM divergence_daily_bars
    WHERE source_interval = $1
      AND trade_date >= $2::date
      AND trade_date <= $3::date
    ORDER BY ticker ASC, trade_date ASC
  `, [sourceInterval, historyStartDate, asOfTradeDate]);

  const rowsByTicker = new Map();
  for (const row of result.rows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!rowsByTicker.has(ticker)) rowsByTicker.set(ticker, []);
    rowsByTicker.get(ticker).push({
      trade_date: String(row.trade_date || '').trim(),
      close: Number(row.close),
      volume_delta: Number(row.volume_delta)
    });
  }

  const summaryRows = [];
  for (const [ticker, rows] of rowsByTicker.entries()) {
    const filtered = rows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate);
    if (!filtered.length) continue;
    const latestRow = filtered[filtered.length - 1];
    if (!latestRow?.trade_date) continue;
    summaryRows.push({
      ticker,
      source_interval: sourceInterval,
      trade_date: latestRow.trade_date,
      states: classifyDivergenceStateMapFromDailyRows(filtered)
    });
  }

  const summaryBatches = [];
  for (let i = 0; i < summaryRows.length; i += DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE) {
    summaryBatches.push(summaryRows.slice(i, i + DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE));
  }
  await mapWithConcurrency(
    summaryBatches,
    DIVERGENCE_SUMMARY_BUILD_CONCURRENCY,
    async (batch) => {
      await upsertDivergenceSummaryBatch(batch, scanJobId);
      return null;
    }
  );
  return { asOfTradeDate, processedTickers: summaryRows.length };
}

async function publishDivergenceTradeDate(options = {}) {
  if (!divergencePool) return '';
  const sourceInterval = String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tradeDate = String(options.tradeDate || '').trim();
  const scanJobId = Number(options.scanJobId) || null;
  if (!tradeDate) return '';
  await divergencePool.query(`
    INSERT INTO divergence_publication_state(
      source_interval,
      published_trade_date,
      last_scan_job_id,
      updated_at
    )
    VALUES($1, $2, $3, NOW())
    ON CONFLICT (source_interval)
    DO UPDATE SET
      published_trade_date = EXCLUDED.published_trade_date,
      last_scan_job_id = EXCLUDED.last_scan_job_id,
      updated_at = NOW()
  `, [sourceInterval, tradeDate, scanJobId]);
  return tradeDate;
}

function getDivergenceTableBuildStatus() {
  return {
    running: Boolean(divergenceTableBuildRunning),
    pause_requested: Boolean(divergenceTableBuildPauseRequested),
    stop_requested: Boolean(divergenceTableBuildStopRequested),
    can_resume: !divergenceTableBuildRunning && Boolean(divergenceTableBuildResumeState),
    status: String(divergenceTableBuildStatus.status || 'idle'),
    total_tickers: Number(divergenceTableBuildStatus.totalTickers || 0),
    processed_tickers: Number(divergenceTableBuildStatus.processedTickers || 0),
    error_tickers: Number(divergenceTableBuildStatus.errorTickers || 0),
    started_at: divergenceTableBuildStatus.startedAt || null,
    finished_at: divergenceTableBuildStatus.finishedAt || null,
    last_published_trade_date: divergenceTableBuildStatus.lastPublishedTradeDate || null
  };
}

function getDivergenceScanControlStatus() {
  return {
    running: Boolean(divergenceScanRunning),
    pause_requested: Boolean(divergenceScanPauseRequested),
    stop_requested: Boolean(divergenceScanStopRequested),
    can_resume: !divergenceScanRunning && Boolean(divergenceScanResumeState)
  };
}

function requestPauseDivergenceScan() {
  if (!divergenceScanRunning) return false;
  divergenceScanPauseRequested = true;
  if (divergenceScanAbortController && !divergenceScanAbortController.signal.aborted) {
    try {
      divergenceScanAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}

function requestStopDivergenceScan() {
  if (!divergenceScanRunning) return false;
  divergenceScanStopRequested = true;
  divergenceScanPauseRequested = false;
  if (divergenceScanAbortController && !divergenceScanAbortController.signal.aborted) {
    try {
      divergenceScanAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}

function canResumeDivergenceScan() {
  return !divergenceScanRunning && Boolean(divergenceScanResumeState);
}

function requestPauseDivergenceTableBuild() {
  if (!divergenceTableBuildRunning) return false;
  divergenceTableBuildPauseRequested = true;
  return true;
}

function requestStopDivergenceTableBuild() {
  if (!divergenceTableBuildRunning) {
    if (!divergenceTableBuildResumeState) {
      return false;
    }
    divergenceTableBuildPauseRequested = false;
    divergenceTableBuildStopRequested = false;
    divergenceTableBuildResumeState = null;
    divergenceTableBuildStatus = {
      ...divergenceTableBuildStatus,
      running: false,
      status: 'stopped',
      finishedAt: new Date().toISOString()
    };
    return true;
  }
  divergenceTableBuildStopRequested = true;
  divergenceTableBuildPauseRequested = false;
  divergenceTableBuildStatus.status = 'stopping';
  if (divergenceTableBuildAbortController && !divergenceTableBuildAbortController.signal.aborted) {
    try {
      divergenceTableBuildAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}

function canResumeDivergenceTableBuild() {
  return !divergenceTableBuildRunning && Boolean(divergenceTableBuildResumeState);
}

function getDivergenceFetchDailyDataStatus() {
  const displayRunning = Boolean(divergenceFetchDailyDataRunning);
  return {
    running: displayRunning,
    stop_requested: Boolean(divergenceFetchDailyDataStopRequested),
    pause_requested: false,
    can_resume: canResumeDivergenceFetchDailyData(),
    status: String(divergenceFetchDailyDataStatus.status || 'idle'),
    total_tickers: Number(divergenceFetchDailyDataStatus.totalTickers || 0),
    processed_tickers: Number(divergenceFetchDailyDataStatus.processedTickers || 0),
    error_tickers: Number(divergenceFetchDailyDataStatus.errorTickers || 0),
    started_at: divergenceFetchDailyDataStatus.startedAt || null,
    finished_at: divergenceFetchDailyDataStatus.finishedAt || null,
    last_published_trade_date: divergenceFetchDailyDataStatus.lastPublishedTradeDate || null
  };
}

function getDivergenceFetchWeeklyDataStatus() {
  const displayRunning = Boolean(divergenceFetchWeeklyDataRunning);
  return {
    running: displayRunning,
    stop_requested: Boolean(divergenceFetchWeeklyDataStopRequested),
    pause_requested: false,
    can_resume: canResumeDivergenceFetchWeeklyData(),
    status: String(divergenceFetchWeeklyDataStatus.status || 'idle'),
    total_tickers: Number(divergenceFetchWeeklyDataStatus.totalTickers || 0),
    processed_tickers: Number(divergenceFetchWeeklyDataStatus.processedTickers || 0),
    error_tickers: Number(divergenceFetchWeeklyDataStatus.errorTickers || 0),
    started_at: divergenceFetchWeeklyDataStatus.startedAt || null,
    finished_at: divergenceFetchWeeklyDataStatus.finishedAt || null,
    last_published_trade_date: divergenceFetchWeeklyDataStatus.lastPublishedTradeDate || null
  };
}

function requestStopDivergenceFetchDailyData() {
  if (!divergenceFetchDailyDataRunning) return false;
  divergenceFetchDailyDataStopRequested = true;
  divergenceFetchDailyDataStatus = {
    ...divergenceFetchDailyDataStatus,
    status: 'stopping',
    finishedAt: null
  };
  if (divergenceFetchDailyDataAbortController && !divergenceFetchDailyDataAbortController.signal.aborted) {
    try {
      divergenceFetchDailyDataAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}

function requestStopDivergenceFetchWeeklyData() {
  if (!divergenceFetchWeeklyDataRunning) return false;
  divergenceFetchWeeklyDataStopRequested = true;
  divergenceFetchWeeklyDataStatus = {
    ...divergenceFetchWeeklyDataStatus,
    status: 'stopping',
    finishedAt: null
  };
  if (divergenceFetchWeeklyDataAbortController && !divergenceFetchWeeklyDataAbortController.signal.aborted) {
    try {
      divergenceFetchWeeklyDataAbortController.abort();
    } catch {
      // Ignore duplicate aborts.
    }
  }
  return true;
}

function normalizeFetchDailyDataResumeState(state = {}) {
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const sourceInterval = String(state.sourceInterval || '').trim();
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((t) => String(t || '').trim().toUpperCase())
        .filter((t) => t && isValidTickerSymbol(t))
    : [];
  const totalTickers = tickers.length;
  const nextIndex = Math.max(0, Math.min(totalTickers, Math.floor(Number(state.nextIndex) || 0)));
  return {
    asOfTradeDate,
    sourceInterval,
    tickers,
    totalTickers,
    nextIndex,
    processedTickers: Math.max(0, Math.floor(Number(state.processedTickers) || 0)),
    errorTickers: Math.max(0, Math.floor(Number(state.errorTickers) || 0)),
    lookbackDays: Math.max(28, Math.floor(Number(state.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS)),
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim()
  };
}

function normalizeFetchWeeklyDataResumeState(state = {}) {
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const weeklyTradeDate = String(state.weeklyTradeDate || '').trim();
  const sourceInterval = String(state.sourceInterval || '').trim();
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((t) => String(t || '').trim().toUpperCase())
        .filter((t) => t && isValidTickerSymbol(t))
    : [];
  const totalTickers = tickers.length;
  const nextIndex = Math.max(0, Math.min(totalTickers, Math.floor(Number(state.nextIndex) || 0)));
  return {
    asOfTradeDate,
    weeklyTradeDate,
    sourceInterval,
    tickers,
    totalTickers,
    nextIndex,
    processedTickers: Math.max(0, Math.floor(Number(state.processedTickers) || 0)),
    errorTickers: Math.max(0, Math.floor(Number(state.errorTickers) || 0)),
    lookbackDays: Math.max(28, Math.floor(Number(state.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS)),
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim()
  };
}

function resolveLastClosedDailyCandleDate(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const totalMinutes = nowEt.getHours() * 60 + nowEt.getMinutes();
  const todayStr = currentEtDateString(nowUtc);

  if (tradingCalendar.isTradingDay(todayStr)) {
    // On early-close days candle is available at 1:16 PM ET (796 min);
    // on normal days at 4:16 PM ET (976 min).
    const threshold = tradingCalendar.isEarlyClose(todayStr) ? 796 : 976;
    const candleAvailableMinute = Math.max(threshold, Number(process.env.CANDLE_AVAILABLE_MINUTE_ET) || threshold);
    if (totalMinutes >= candleAvailableMinute) {
      return todayStr;
    }
  }

  // Not a trading day or before threshold — return previous trading day
  return tradingCalendar.previousTradingDay(todayStr);
}

function resolveLastClosedWeeklyCandleDate(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = nowEt.getDay(); // 0=Sun, 6=Sat
  const totalMinutes = nowEt.getHours() * 60 + nowEt.getMinutes();
  const candleAvailableMinute = 976; // 4:16 PM ET

  // Friday at/after 4:16 PM ET -> this week's close is available
  // (but only if Friday is actually a trading day).
  if (dayOfWeek === 5 && totalMinutes >= candleAvailableMinute && tradingCalendar.isTradingDay(currentEtDateString(nowUtc))) {
    return currentEtDateString(nowUtc);
  }

  // Walk back to the last Friday that was a trading day.
  const prev = new Date(nowEt);
  prev.setDate(prev.getDate() - 1);
  for (let i = 0; i < 30; i++) {
    if (prev.getDay() === 5) {
      const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
      if (tradingCalendar.isTradingDay(key)) return key;
    }
    prev.setDate(prev.getDate() - 1);
  }
  // Absolute fallback
  const yyyy = prev.getFullYear();
  const mm = String(prev.getMonth() + 1).padStart(2, '0');
  const dd = String(prev.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function canResumeDivergenceFetchDailyData() {
  if (divergenceFetchDailyDataRunning) return false;
  if (!divergenceFetchDailyDataResumeState) return false;
  const rs = normalizeFetchDailyDataResumeState(divergenceFetchDailyDataResumeState);
  if (!rs.asOfTradeDate || rs.totalTickers === 0 || rs.nextIndex >= rs.totalTickers) return false;
  return true;
}

function canResumeDivergenceFetchWeeklyData() {
  if (divergenceFetchWeeklyDataRunning) return false;
  if (!divergenceFetchWeeklyDataResumeState) return false;
  const rs = normalizeFetchWeeklyDataResumeState(divergenceFetchWeeklyDataResumeState);
  if (!rs.asOfTradeDate || !rs.weeklyTradeDate || rs.totalTickers === 0 || rs.nextIndex >= rs.totalTickers) return false;
  return true;
}

function normalizeDivergenceScanResumeState(state = {}) {
  const runDateEt = String(state.runDateEt || '').trim();
  const trigger = String(state.trigger || 'manual').trim() || 'manual';
  const symbols = Array.isArray(state.symbols)
    ? state.symbols
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter((symbol) => symbol && isValidTickerSymbol(symbol))
    : [];
  const totalSymbols = symbols.length;
  const nextIndex = Math.max(0, Math.min(totalSymbols, Math.floor(Number(state.nextIndex) || 0)));
  const scanJobId = Number(state.scanJobId) || null;
  return {
    runDateEt,
    trigger,
    symbols,
    totalSymbols,
    nextIndex,
    processed: Math.max(0, Math.floor(Number(state.processed) || 0)),
    bullishCount: Math.max(0, Math.floor(Number(state.bullishCount) || 0)),
    bearishCount: Math.max(0, Math.floor(Number(state.bearishCount) || 0)),
    errorCount: Math.max(0, Math.floor(Number(state.errorCount) || 0)),
    latestScannedTradeDate: String(state.latestScannedTradeDate || '').trim(),
    summaryProcessedTickers: Math.max(0, Math.floor(Number(state.summaryProcessedTickers) || 0)),
    scanJobId
  };
}

function normalizeDivergenceTableResumeState(state = {}) {
  const sourceInterval = String(state.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const requestedLookbackDays = Math.max(
    45,
    Math.floor(Number(state.requestedLookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS)
  );
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
      .map((ticker) => String(ticker || '').toUpperCase())
      .filter((ticker) => ticker && isValidTickerSymbol(ticker))
    : [];
  const tickerSet = new Set(tickers);
  const backfillTickers = Array.isArray(state.backfillTickers)
    ? state.backfillTickers
      .map((ticker) => String(ticker || '').toUpperCase())
      .filter((ticker) => tickerSet.has(ticker))
    : [];
  const totalTickers = Number.isFinite(Number(state.totalTickers))
    ? Math.max(0, Math.floor(Number(state.totalTickers)))
    : tickers.length;
  const backfillOffset = Math.max(0, Math.floor(Number(state.backfillOffset) || 0));
  const summarizeOffset = Math.max(0, Math.floor(Number(state.summarizeOffset) || 0));
  const errorTickers = Math.max(0, Math.floor(Number(state.errorTickers) || 0));
  const phaseRaw = String(state.phase || '').trim().toLowerCase();
  const phase = phaseRaw === 'summarizing' ? 'summarizing' : 'backfilling';
  return {
    sourceInterval,
    asOfTradeDate,
    requestedLookbackDays,
    tickers,
    totalTickers,
    backfillTickers,
    backfillOffset: Math.min(backfillOffset, backfillTickers.length),
    summarizeOffset: Math.min(summarizeOffset, tickers.length),
    errorTickers,
    phase,
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim()
  };
}

async function rebuildStoredDivergenceSummariesForTickers(options = {}) {
  if (!divergencePool) return new Map();
  const sourceInterval = String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tickers = Array.isArray(options.tickers)
    ? Array.from(new Set(
      options.tickers
        .map((ticker) => String(ticker || '').toUpperCase())
        .filter((ticker) => ticker && isValidTickerSymbol(ticker))
    ))
    : [];
  if (tickers.length === 0) return new Map();

  const asOfTradeDate = await resolveDivergenceAsOfTradeDate(
    sourceInterval,
    String(options.asOfTradeDate || '').trim()
  );
  const lookbackDays = Math.max(45, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
  const historyStartDate = dateKeyDaysAgo(asOfTradeDate, lookbackDays + 7) || asOfTradeDate;
  const rowsByTicker = await loadDivergenceDailyHistoryByTicker({
    sourceInterval,
    tickers,
    historyStartDate,
    asOfTradeDate
  });

  const neutralStates = buildNeutralDivergenceStateMap();
  const summaryRows = [];
  const summaryByTicker = new Map();
  const nowMs = Date.now();
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));

  for (const ticker of tickers) {
    const rows = rowsByTicker.get(ticker) || [];
    const filtered = rows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate);
    const latestRowDate = filtered.length ? String(filtered[filtered.length - 1].trade_date || '').trim() : '';
    const tradeDate = latestRowDate || asOfTradeDate;
    const states = filtered.length >= 2
      ? classifyDivergenceStateMapFromDailyRows(filtered)
      : neutralStates;
    summaryRows.push({
      ticker,
      source_interval: sourceInterval,
      trade_date: tradeDate,
      states
    });
    const entry = {
      ticker,
      sourceInterval,
      tradeDate,
      states,
      computedAtMs: nowMs,
      expiresAtMs
    };
    summaryByTicker.set(ticker, entry);
  }

  if (summaryRows.length > 0) {
    await upsertDivergenceSummaryBatch(summaryRows, null);
    for (const entry of summaryByTicker.values()) {
      setDivergenceSummaryCacheEntry(entry);
    }
  }
  return summaryByTicker;
}

function buildLatestDailyBarSnapshotForTicker(options = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval = String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const maxTradeDateKey = String(options.maxTradeDateKey || '').trim();
  const dailyInput = options.dailyInput || {};
  const bars = Array.isArray(dailyInput.bars) ? dailyInput.bars : [];
  const volumeDelta = Array.isArray(dailyInput.volumeDelta) ? dailyInput.volumeDelta : [];
  if (!ticker || bars.length === 0) return null;

  const deltaByTime = new Map();
  for (const point of volumeDelta) {
    const t = Number(point?.time);
    const delta = Number(point?.delta);
    if (!Number.isFinite(t) || !Number.isFinite(delta)) continue;
    deltaByTime.set(t, delta);
  }

  const eligible = [];
  for (const bar of bars) {
    const unix = Number(bar?.time);
    if (!Number.isFinite(unix)) continue;
    const tradeDatePt = pacificDateStringFromUnixSeconds(unix);
    if (maxTradeDateKey && tradeDatePt && tradeDatePt > maxTradeDateKey) continue;
    eligible.push(bar);
  }
  if (eligible.length === 0) return null;

  const latestBar = eligible[eligible.length - 1];
  const prevBar = eligible.length > 1 ? eligible[eligible.length - 2] : latestBar;
  const tradeDateEt = etDateStringFromUnixSeconds(Number(latestBar?.time));
  const close = Number(latestBar?.close);
  const prevClose = Number(prevBar?.close);
  if (!tradeDateEt || !Number.isFinite(close) || !Number.isFinite(prevClose)) return null;

  return {
    ticker,
    trade_date: tradeDateEt,
    source_interval: sourceInterval,
    close,
    prev_close: prevClose,
    volume_delta: Number(deltaByTime.get(Number(latestBar.time)) || 0)
  };
}

async function buildLatestWeeklyBarSnapshotForTicker(options = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval = toVolumeDeltaSourceInterval(options.sourceInterval, DIVERGENCE_SOURCE_INTERVAL);
  const lookbackDays = Math.max(35, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const signal = options && options.signal ? options.signal : null;
  const noCache = options && options.noCache === true;
  if (!ticker) return null;
  const suppliedParentRows = Array.isArray(options.parentRows) ? options.parentRows : null;
  const suppliedSourceRows = Array.isArray(options.sourceRows) ? options.sourceRows : null;
  const historyOptions = { signal, noCache, metricsTracker: options.metricsTracker };
  const [parentRows, sourceRows] = await Promise.all([
    suppliedParentRows || dataApiIntradayChartHistory(ticker, '1week', lookbackDays, historyOptions),
    suppliedSourceRows || dataApiIntradayChartHistory(ticker, sourceInterval, lookbackDays, historyOptions)
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) return null;
  const weeklyBars = convertToLATime(parentRows, '1week').sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(weeklyBars) || weeklyBars.length === 0) return null;

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], sourceInterval).sort((a, b) => Number(a.time) - Number(b.time))
  );
  const weeklyDeltas = computeVolumeDeltaByParentBars(weeklyBars, sourceBars, '1week');
  const deltaByTime = new Map(weeklyDeltas.map((point) => [Number(point.time), Number(point.delta) || 0]));

  const eligible = [];
  for (const bar of weeklyBars) {
    const unix = Number(bar?.time);
    if (!Number.isFinite(unix)) continue;
    const tradeDateEt = etDateStringFromUnixSeconds(unix);
    if (asOfTradeDate && tradeDateEt && tradeDateEt > asOfTradeDate) continue;
    eligible.push(bar);
  }
  if (eligible.length === 0) return null;

  const latestBar = eligible[eligible.length - 1];
  const prevBar = eligible.length > 1 ? eligible[eligible.length - 2] : latestBar;
  const close = Number(latestBar?.close);
  const prevClose = Number(prevBar?.close);
  if (!Number.isFinite(close) || !Number.isFinite(prevClose)) return null;

  return {
    ticker,
    trade_date: asOfTradeDate || etDateStringFromUnixSeconds(Number(latestBar?.time)),
    source_interval: sourceInterval,
    close,
    prev_close: prevClose,
    volume_delta: Number(deltaByTime.get(Number(latestBar.time)) || 0)
  };
}

async function getDivergenceTableTickerUniverseFromAlerts() {
  const tickers = new Set();

  try {
    const tvResult = await pool.query(`
      SELECT DISTINCT UPPER(TRIM(ticker)) AS ticker
      FROM alerts
      WHERE ticker IS NOT NULL
    `);
    for (const row of tvResult.rows) {
      const ticker = String(row?.ticker || '').trim().toUpperCase();
      if (ticker && isValidTickerSymbol(ticker)) tickers.add(ticker);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`Failed to load TV ticker universe for table run: ${message}`);
  }

  if (divergencePool) {
    try {
      const dataApiResult = await divergencePool.query(`
        SELECT DISTINCT UPPER(TRIM(ticker)) AS ticker
        FROM divergence_signals
        WHERE ticker IS NOT NULL
      `);
      for (const row of dataApiResult.rows) {
        const ticker = String(row?.ticker || '').trim().toUpperCase();
        if (ticker && isValidTickerSymbol(ticker)) tickers.add(ticker);
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Failed to load FML ticker universe for table run: ${message}`);
    }
  }

  return Array.from(tickers).sort((a, b) => a.localeCompare(b));
}

function groupDivergenceDailyRowsByTicker(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!out.has(ticker)) out.set(ticker, []);
    out.get(ticker).push({
      trade_date: String(row?.trade_date || '').trim(),
      close: Number(row?.close),
      volume_delta: Number(row?.volume_delta)
    });
  }
  return out;
}

async function loadDivergenceDailyHistoryByTicker(options = {}) {
  const sourceInterval = String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tickers = Array.isArray(options.tickers) ? options.tickers : [];
  const historyStartDate = String(options.historyStartDate || '').trim();
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  if (!divergencePool || tickers.length === 0 || !historyStartDate || !asOfTradeDate) {
    return new Map();
  }

  const historyResult = await divergencePool.query(`
    SELECT
      ticker,
      trade_date::text AS trade_date,
      close::double precision AS close,
      volume_delta::double precision AS volume_delta
    FROM divergence_daily_bars
    WHERE source_interval = $1
      AND ticker = ANY($2::VARCHAR[])
      AND trade_date >= $3::date
      AND trade_date <= $4::date
    ORDER BY ticker ASC, trade_date ASC
  `, [sourceInterval, tickers, historyStartDate, asOfTradeDate]);

  return groupDivergenceDailyRowsByTicker(historyResult.rows);
}

function hasDivergenceHistoryCoverage(rows, asOfTradeDate, minCoverageDays) {
  const safeRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row.trade_date && row.trade_date <= asOfTradeDate);
  if (safeRows.length < 2) return false;

  const oldestDate = String(safeRows[0].trade_date || '').trim();
  const latestDate = String(safeRows[safeRows.length - 1].trade_date || '').trim();
  const oldestMs = parseDateKeyToUtcMs(oldestDate);
  const latestMs = parseDateKeyToUtcMs(latestDate);
  const asOfMs = parseDateKeyToUtcMs(asOfTradeDate);
  if (!Number.isFinite(oldestMs) || !Number.isFinite(latestMs) || !Number.isFinite(asOfMs)) return false;

  const latestLagDays = Math.floor((asOfMs - latestMs) / (24 * 60 * 60 * 1000));
  if (latestLagDays > 3) return false;

  const coverageDays = Math.floor((asOfMs - oldestMs) / (24 * 60 * 60 * 1000));
  return coverageDays >= Math.max(1, Number(minCoverageDays) || DIVERGENCE_TABLE_MIN_COVERAGE_DAYS);
}

async function buildDivergenceDailyRowsForTicker(options = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval = toVolumeDeltaSourceInterval(options.sourceInterval, DIVERGENCE_SOURCE_INTERVAL);
  const lookbackDays = Math.max(35, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const signal = options && options.signal ? options.signal : null;
  const noCache = options && options.noCache === true;
  if (!ticker) return [];

  const parentFetchInterval = options.parentInterval || '1day';
  const suppliedParentRows = Array.isArray(options.parentRows) ? options.parentRows : null;
  const suppliedSourceRows = Array.isArray(options.sourceRows) ? options.sourceRows : null;
  const historyOptions = { signal, noCache, metricsTracker: options.metricsTracker };
  const [parentRows, sourceRows] = await Promise.all([
    suppliedParentRows || dataApiIntradayChartHistory(ticker, parentFetchInterval, lookbackDays, historyOptions),
    suppliedSourceRows || dataApiIntradayChartHistory(ticker, sourceInterval, lookbackDays, historyOptions)
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) return [];
  const sortedParent = convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time));
  const dailyBars = parentFetchInterval === '1day'
    ? sortedParent
    : aggregate4HourBarsToDaily(sortedParent);
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];

  // Cache daily OHLC bars for the mini-chart hover overlay.
  if (ticker && dailyBars.length > 0) {
    miniBarsCacheByTicker.set(ticker, dailyBars.map(b => ({
      time: Number(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    })));
    // Evict oldest entries when cache exceeds limit.
    if (miniBarsCacheByTicker.size > MINI_BARS_CACHE_MAX_TICKERS) {
      const excess = miniBarsCacheByTicker.size - MINI_BARS_CACHE_MAX_TICKERS;
      const iter = miniBarsCacheByTicker.keys();
      for (let n = 0; n < excess; n++) {
        const key = iter.next().value;
        if (key !== undefined) miniBarsCacheByTicker.delete(key);
      }
    }
  }

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], sourceInterval).sort((a, b) => Number(a.time) - Number(b.time))
  );
  const dailyDeltas = computeVolumeDeltaByParentBars(dailyBars, sourceBars, DIVERGENCE_SCAN_PARENT_INTERVAL);
  const deltaByTime = new Map(dailyDeltas.map((point) => [Number(point.time), Number(point.delta) || 0]));

  const out = [];
  for (let i = 0; i < dailyBars.length; i++) {
    const bar = dailyBars[i];
    const tradeDate = etDateStringFromUnixSeconds(Number(bar?.time));
    if (!tradeDate) continue;
    if (asOfTradeDate && tradeDate > asOfTradeDate) continue;
    const close = Number(bar?.close);
    const prevClose = Number((dailyBars[i - 1] || bar)?.close);
    if (!Number.isFinite(close) || !Number.isFinite(prevClose)) continue;
    out.push({
      ticker,
      trade_date: tradeDate,
      source_interval: sourceInterval,
      close,
      prev_close: prevClose,
      volume_delta: Number(deltaByTime.get(Number(bar.time)) || 0)
    });
  }

  return out;
}

async function runDivergenceTableBuild(options = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || divergenceFetchDailyDataRunning || divergenceFetchWeeklyDataRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeDivergenceTableResumeState(divergenceTableBuildResumeState || {}) : null;
  if (resumeRequested && (!resumeState || resumeState.tickers.length === 0)) {
    return { status: 'no-resume' };
  }

  divergenceTableBuildRunning = true;
  divergenceTableBuildPauseRequested = false;
  divergenceTableBuildStopRequested = false;
  if (!resumeRequested) {
    divergenceTableBuildResumeState = null;
  }

  let processedTickers = 0;
  let totalTickers = 0;
  let lastPublishedTradeDate = resumeState?.lastPublishedTradeDate || '';
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  const startedAtIso = new Date().toISOString();
  const tableAbortController = new AbortController();
  divergenceTableBuildAbortController = tableAbortController;
  divergenceTableBuildStatus = {
    running: true,
    status: resumeState?.phase || 'running',
    totalTickers: Number(resumeState?.totalTickers || 0),
    processedTickers: Number(resumeState?.phase === 'summarizing'
      ? resumeState?.summarizeOffset
      : resumeState?.backfillOffset) || 0,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || ''
  };

  try {
    const sourceInterval = resumeState?.sourceInterval
      || (String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL);
    const tickers = resumeState?.tickers?.length
      ? resumeState.tickers
      : await getDivergenceTableTickerUniverseFromAlerts();
    totalTickers = tickers.length;

    divergenceTableBuildStatus.totalTickers = totalTickers;

    if (totalTickers === 0) {
      divergenceTableBuildPauseRequested = false;
      divergenceTableBuildResumeState = null;
      divergenceTableBuildStatus = {
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || ''
      };
      return { status: 'completed', totalTickers: 0, processedTickers: 0, errorTickers: 0, lastPublishedTradeDate: null };
    }

    const requestedLookbackDays = resumeState?.requestedLookbackDays
      || Math.max(45, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
    const bootstrapMissing = options.bootstrapMissing !== false;
    const forceFullRebuild = Boolean(options.force);
    const asOfTradeDate = await resolveDivergenceAsOfTradeDate(
      sourceInterval,
      resumeState?.asOfTradeDate
    );
    const historyStartDate = dateKeyDaysAgo(asOfTradeDate, requestedLookbackDays + 7) || asOfTradeDate;
    let rowsByTicker = await loadDivergenceDailyHistoryByTicker({
      sourceInterval,
      tickers,
      historyStartDate,
      asOfTradeDate
    });

    let backfillTickers = resumeState?.backfillTickers?.length
      ? resumeState.backfillTickers
      : [];
    if (!resumeRequested || backfillTickers.length === 0) {
      if (forceFullRebuild) {
        backfillTickers = tickers.slice();
      } else if (bootstrapMissing) {
        backfillTickers = tickers.filter((ticker) => {
          const rows = rowsByTicker.get(ticker) || [];
          return !hasDivergenceHistoryCoverage(rows, asOfTradeDate, DIVERGENCE_TABLE_MIN_COVERAGE_DAYS);
        });
      } else {
        backfillTickers = [];
      }
    }
    let backfillOffset = Math.max(0, Math.floor(Number(resumeState?.backfillOffset) || 0));
    let summarizeOffset = Math.max(0, Math.floor(Number(resumeState?.summarizeOffset) || 0));
    let phase = resumeState?.phase || (backfillTickers.length > 0 ? 'backfilling' : 'summarizing');

    const persistResumeState = () => {
      divergenceTableBuildResumeState = normalizeDivergenceTableResumeState({
        sourceInterval,
        asOfTradeDate,
        requestedLookbackDays,
        tickers,
        totalTickers,
        backfillTickers,
        backfillOffset,
        summarizeOffset,
        errorTickers,
        phase,
        lastPublishedTradeDate
      });
    };
    persistResumeState();

    const markPaused = () => {
      processedTickers = phase === 'summarizing' ? summarizeOffset : backfillOffset;
      divergenceTableBuildPauseRequested = false;
      divergenceTableBuildStopRequested = false;
      persistResumeState();
      divergenceTableBuildStatus = {
        running: false,
        status: 'paused',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || ''
      };
      return {
        status: 'paused',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null
      };
    };

    const markStopped = () => {
      processedTickers = phase === 'summarizing' ? summarizeOffset : backfillOffset;
      divergenceTableBuildPauseRequested = false;
      divergenceTableBuildStopRequested = false;
      divergenceTableBuildResumeState = null;
      divergenceTableBuildStatus = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || ''
      };
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null
      };
    };

    if (phase === 'backfilling' && backfillTickers.length > 0) {
      divergenceTableBuildStatus.status = 'backfilling';
      backfillOffset = Math.min(backfillOffset, backfillTickers.length);
      processedTickers = backfillOffset;
      divergenceTableBuildStatus.processedTickers = processedTickers;

      while (backfillOffset < backfillTickers.length) {
        if (divergenceTableBuildStopRequested) {
          return markStopped();
        }
        if (divergenceTableBuildPauseRequested) {
          return markPaused();
        }

        const chunk = backfillTickers.slice(backfillOffset, backfillOffset + DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE);
        const chunkStartOffset = backfillOffset;
        let chunkCompleted = false;
        for (let chunkRetryAttempt = 0; !chunkCompleted; chunkRetryAttempt++) {
          const attemptController = new AbortController();
          const unlinkAbort = linkAbortSignalToController(tableAbortController.signal, attemptController);
          const stallWatchdog = createProgressStallWatchdog(() => {
            try {
              attemptController.abort();
            } catch {
              // Ignore duplicate abort calls.
            }
          });
          let chunkProcessed = 0;
          try {
            await mapWithConcurrency(
              chunk,
              DIVERGENCE_TABLE_BUILD_CONCURRENCY,
              async (ticker) => {
                const rows = await buildDivergenceDailyRowsForTicker({
                  ticker,
                  sourceInterval,
                  lookbackDays: requestedLookbackDays,
                  asOfTradeDate,
                  signal: attemptController.signal,
                  noCache: true
                });
                if (rows.length > 0) {
                  await upsertDivergenceDailyBarsBatch(rows, null);
                }
                return { ticker, rowCount: rows.length };
              },
              (result, _index, ticker) => {
                chunkProcessed += 1;
                processedTickers = Math.min(backfillTickers.length, chunkStartOffset + chunkProcessed);
                divergenceTableBuildStatus.processedTickers = processedTickers;
                stallWatchdog.markProgress();
                if (result && result.error) {
                  if (isAbortError(result.error)) {
                    if (divergenceTableBuildStopRequested || divergenceTableBuildPauseRequested || stallWatchdog.isStalled()) {
                      persistResumeState();
                      return;
                    }
                  }
                  errorTickers += 1;
                  divergenceTableBuildStatus.errorTickers = errorTickers;
                  const message = result.error && result.error.message ? result.error.message : String(result.error);
                  console.error(`Divergence table backfill failed for ${ticker}: ${message}`);
                }
                persistResumeState();
              }
            );
          } finally {
            stallWatchdog.stop();
            unlinkAbort();
          }

          if (stallWatchdog.isStalled() && !divergenceTableBuildStopRequested && !divergenceTableBuildPauseRequested) {
            const retryAttempt = chunkRetryAttempt + 1;
            if (retryAttempt <= DIVERGENCE_STALL_MAX_RETRIES) {
              const retryDelayMs = getStallRetryBackoffMs(retryAttempt);
              divergenceTableBuildStatus.processedTickers = chunkStartOffset;
              persistResumeState();
              console.warn(
                `Divergence table backfill stalled at ticker ${chunkStartOffset + 1}/${backfillTickers.length}; retry ${retryAttempt}/${DIVERGENCE_STALL_MAX_RETRIES} in ${retryDelayMs}ms`
              );
              try {
                await sleepWithAbort(retryDelayMs, tableAbortController.signal);
              } catch (sleepErr) {
                if (!isAbortError(sleepErr) || (!divergenceTableBuildStopRequested && !divergenceTableBuildPauseRequested)) {
                  throw sleepErr;
                }
              }
              continue;
            }
            throw new Error(
              `Divergence table backfill stalled at ticker ${chunkStartOffset + 1}/${backfillTickers.length} and exhausted ${DIVERGENCE_STALL_MAX_RETRIES} retries`
            );
          }

          if (divergenceTableBuildStopRequested) {
            return markStopped();
          }
          if (divergenceTableBuildPauseRequested) {
            return markPaused();
          }
          chunkCompleted = true;
        }

        backfillOffset = Math.min(backfillTickers.length, chunkStartOffset + chunk.length);
        processedTickers = backfillOffset;
        divergenceTableBuildStatus.processedTickers = processedTickers;
        persistResumeState();
      }

      rowsByTicker = await loadDivergenceDailyHistoryByTicker({
        sourceInterval,
        tickers,
        historyStartDate,
        asOfTradeDate
      });
    }

    phase = 'summarizing';
    persistResumeState();
    divergenceTableBuildStatus.status = 'summarizing';
    summarizeOffset = Math.min(summarizeOffset, tickers.length);
    processedTickers = summarizeOffset;
    divergenceTableBuildStatus.processedTickers = processedTickers;
    divergenceTableBuildStatus.errorTickers = errorTickers;

    const summaryRows = [];
    const neutralStates = buildNeutralDivergenceStateMap();
    const flushSummaryRows = async () => {
      if (summaryRows.length === 0) return;
      const batch = summaryRows.splice(0, summaryRows.length);
      await upsertDivergenceSummaryBatch(batch, null);
      const nowMs = Date.now();
      const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));
      for (const row of batch) {
        const ticker = String(row?.ticker || '').toUpperCase();
        const tradeDate = String(row?.trade_date || '').trim() || null;
        if (!ticker || !tradeDate) continue;
        setDivergenceSummaryCacheEntry({
          ticker,
          sourceInterval,
          tradeDate,
          states: row?.states || buildNeutralDivergenceStateMap(),
          computedAtMs: nowMs,
          expiresAtMs
        });
      }
    };

    for (let idx = summarizeOffset; idx < tickers.length; idx++) {
      if (divergenceTableBuildStopRequested) {
        await flushSummaryRows();
        summarizeOffset = idx;
        return markStopped();
      }
      if (divergenceTableBuildPauseRequested) {
        await flushSummaryRows();
        summarizeOffset = idx;
        return markPaused();
      }
      const ticker = tickers[idx];
      const rows = rowsByTicker.get(ticker) || [];
      const filtered = rows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate);
      const latestRowDate = filtered.length ? String(filtered[filtered.length - 1].trade_date || '').trim() : '';
      const states = filtered.length >= 2
        ? classifyDivergenceStateMapFromDailyRows(filtered)
        : neutralStates;
      summaryRows.push({
        ticker,
        source_interval: sourceInterval,
        trade_date: latestRowDate || asOfTradeDate,
        states
      });
      summarizeOffset = idx + 1;
      processedTickers = summarizeOffset;
      divergenceTableBuildStatus.processedTickers = processedTickers;
      if (latestRowDate) {
        lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, latestRowDate);
      }
      if (summaryRows.length >= DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE) {
        await flushSummaryRows();
      }
      persistResumeState();
    }

    await flushSummaryRows();

    runMetricsTracker?.setPhase('publishing');
    if (lastPublishedTradeDate) {
      await publishDivergenceTradeDate({
        sourceInterval,
        tradeDate: lastPublishedTradeDate,
        scanJobId: null
      });
      divergenceLastFetchedTradeDateEt = maxEtDateString(divergenceLastFetchedTradeDateEt, lastPublishedTradeDate);
    }
    divergenceTableBuildPauseRequested = false;
    divergenceTableBuildStopRequested = false;
    divergenceTableBuildResumeState = null;
    clearDivergenceSummaryCacheForSourceInterval(sourceInterval);

    divergenceTableBuildStatus = {
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || ''
    };
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: lastPublishedTradeDate || null
    };
  } catch (err) {
    divergenceTableBuildPauseRequested = false;
    divergenceTableBuildStopRequested = false;
    divergenceTableBuildStatus = {
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || ''
    };
    if (!divergenceTableBuildResumeState) {
      divergenceTableBuildResumeState = normalizeDivergenceTableResumeState({
        sourceInterval: String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL,
        asOfTradeDate: latestCompletedPacificTradeDateKey(new Date()) || currentEtDateString(),
        requestedLookbackDays: Math.max(45, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS)),
        tickers: [],
        totalTickers,
        backfillTickers: [],
        backfillOffset: 0,
        summarizeOffset: processedTickers,
        errorTickers,
        phase: 'summarizing',
        lastPublishedTradeDate
      });
    }
    throw err;
  } finally {
    if (divergenceTableBuildAbortController === tableAbortController) {
      divergenceTableBuildAbortController = null;
    }
    divergenceTableBuildRunning = false;
  }
}

async function runDivergenceFetchDailyData(options = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || divergenceFetchDailyDataRunning || divergenceFetchWeeklyDataRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeFetchDailyDataResumeState(divergenceFetchDailyDataResumeState || {}) : null;
  if (resumeRequested && (!resumeState || !resumeState.asOfTradeDate || resumeState.totalTickers === 0 || resumeState.nextIndex >= resumeState.totalTickers)) {
    return { status: 'no-resume' };
  }
  divergenceFetchDailyDataRunning = true;
  divergenceFetchDailyDataStopRequested = false;
  // Clear previous run metrics immediately so stale data never leaks into
  // the new run's Logs page display (failedTickers, errors, etc.).
  runMetricsByType.fetchDaily = null;
  if (!resumeRequested) {
    divergenceFetchDailyDataResumeState = null;
  }

  let processedTickers = Math.max(0, Number(resumeState?.processedTickers || 0));
  let totalTickers = Math.max(0, Number(resumeState?.totalTickers || 0));
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  let lastPublishedTradeDate = String(resumeState?.lastPublishedTradeDate || '').trim();
  const startedAtIso = new Date().toISOString();
  const fetchDailyAbortController = new AbortController();
  divergenceFetchDailyDataAbortController = fetchDailyAbortController;
  divergenceFetchDailyDataStatus = {
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: lastPublishedTradeDate || divergenceFetchDailyDataStatus.lastPublishedTradeDate || ''
  };

  let tickers = resumeState?.tickers || [];
  let startIndex = Math.max(0, Number(resumeState?.nextIndex || 0));
  let sourceInterval = '';
  let runLookbackDays = DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS;
  let runConcurrency = resolveAdaptiveFetchConcurrency('fetch-daily');
  const summaryFlushSize = DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE;
  let asOfTradeDate = '';
  let runMetricsTracker = null;
  const dailyRowsBuffer = [];
  const summaryRowsBuffer = [];
  const maSummaryRowsBuffer = [];
  const maSeedRows = [];

  try {
    sourceInterval = resumeState?.sourceInterval
      || String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim()
      || DIVERGENCE_SOURCE_INTERVAL;
    runLookbackDays = resumeState?.lookbackDays
      || Math.max(28, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
    asOfTradeDate = resumeState?.asOfTradeDate
      || resolveLastClosedDailyCandleDate();
    runConcurrency = resolveAdaptiveFetchConcurrency('fetch-daily');
    runMetricsTracker = createRunMetricsTracker('fetchDaily', {
      sourceInterval,
      asOfTradeDate,
      lookbackDays: runLookbackDays,
      concurrency: runConcurrency,
      flushSize: summaryFlushSize
    });
    runMetricsTracker.setPhase('core');

    if (!resumeRequested) {
      tickers = await getStoredDivergenceSymbolTickers();
      startIndex = 0;
      processedTickers = 0;
      errorTickers = 0;
      lastPublishedTradeDate = '';
    }

    totalTickers = tickers.length;
    divergenceFetchDailyDataStatus.totalTickers = totalTickers;
    runMetricsTracker?.setTotals(totalTickers);

    const persistResumeState = (nextIdx) => {
      divergenceFetchDailyDataResumeState = normalizeFetchDailyDataResumeState({
        asOfTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: nextIdx,
        processedTickers,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate
      });
    };

    const markStopped = (nextIdx, options = {}) => {
      const preserveResume = options.preserveResume !== false;
      const rewind = options.rewind !== false;
      // Rewind by concurrency level so in-flight workers that got aborted
      // (and never wrote their data) will be re-fetched on resume.
      // Upserts make re-fetching already-completed tickers harmless.
      const safeNextIndex = rewind
        ? Math.max(0, Math.min(totalTickers, nextIdx - runConcurrency))
        : Math.max(0, Math.min(totalTickers, nextIdx));
      if (preserveResume) {
        persistResumeState(safeNextIndex);
      } else {
        divergenceFetchDailyDataResumeState = null;
      }
      divergenceFetchDailyDataStopRequested = false;
      divergenceFetchDailyDataStatus = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceFetchDailyDataStatus.lastPublishedTradeDate || ''
      };
      return {
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null
      };
    };

    if (totalTickers === 0) {
      divergenceFetchDailyDataStopRequested = false;
      divergenceFetchDailyDataResumeState = null;
      divergenceFetchDailyDataStatus = {
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: divergenceFetchDailyDataStatus.lastPublishedTradeDate || ''
      };
      return { status: 'completed', totalTickers: 0, processedTickers: 0, errorTickers: 0, lastPublishedTradeDate: null };
    }

    await publishDivergenceTradeDate({
      sourceInterval,
      tradeDate: asOfTradeDate,
      scanJobId: null
    });
    lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, asOfTradeDate);
    divergenceLastFetchedTradeDateEt = maxEtDateString(divergenceLastFetchedTradeDateEt, asOfTradeDate);

    // --- On-the-fly DB update infrastructure ---
    const neutralStates = buildNeutralDivergenceStateMap();
    let flushChain = Promise.resolve();

    const flushBuffers = async () => {
      const flushStartedAt = Date.now();
      let flushedDailyRows = 0;
      let flushedSummaryRows = 0;
      let flushedSignalRows = 0;
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        flushedDailyRows += batch.length;
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
        await syncOneDaySignalsFromSummaryRows(batch, sourceInterval, null);
        flushedSignalRows += batch.length;
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (flushedDailyRows > 0 || flushedSummaryRows > 0 || flushedSignalRows > 0) {
        runMetricsTracker?.recordDbFlush({
          durationMs: Date.now() - flushStartedAt,
          dailyRows: flushedDailyRows,
          summaryRows: flushedSummaryRows,
          signalRows: flushedSignalRows
        });
      }
    };

    const enqueueFlush = () => {
      flushChain = flushChain.then(() => flushBuffers()).catch((err) => {
        console.error('Fetch-all on-the-fly flush error:', err && err.message ? err.message : String(err));
      });
      return flushChain;
    };

    // Slice tickers to only the remaining portion for resume
    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;
    const failedTickers = [];

    persistResumeState(startIndex);

    // --- Worker function shared by main pass and retry pass ---
    const fetchDailyTickerWorker = async (ticker) => {
      return runWithAbortAndTimeout(async (tickerSignal) => {
        if (divergenceFetchDailyDataStopRequested || fetchDailyAbortController.signal.aborted) {
          throw buildRequestAbortError('Fetch-all run stopped');
        }
        const rows = await buildDivergenceDailyRowsForTicker({
          ticker,
          sourceInterval,
          lookbackDays: runLookbackDays,
          asOfTradeDate,
          parentInterval: '1day',
          signal: tickerSignal,
          noCache: true,
          metricsTracker: runMetricsTracker
        });
        const filteredRows = Array.isArray(rows)
          ? rows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate)
          : [];
        const latestRow = filteredRows.length > 0 ? filteredRows[filteredRows.length - 1] : null;
        const latestClose = Number(latestRow?.close);

        // --- On-the-fly: process and buffer this ticker's data immediately ---
        if (rows && Array.isArray(rows) && rows.length > 0) {
          dailyRowsBuffer.push(...rows);
        }
        if (filteredRows.length >= 1 && latestRow?.trade_date) {
          const states = filteredRows.length >= 2
            ? classifyDivergenceStateMapFromDailyRows(filteredRows)
            : neutralStates;
          summaryRowsBuffer.push({
            ticker,
            source_interval: sourceInterval,
            trade_date: latestRow.trade_date,
            states,
            ma_states: null,
            latest_close: Number(latestRow.close),
            latest_prev_close: Number(latestRow.prev_close),
            latest_volume_delta: Number(latestRow.volume_delta)
          });
          if (Number.isFinite(latestClose) && latestClose > 0) {
            maSeedRows.push({
              ticker,
              source_interval: sourceInterval,
              trade_date: latestRow.trade_date,
              states,
              latest_close: latestClose,
              latest_prev_close: Number(latestRow.prev_close),
              latest_volume_delta: Number(latestRow.volume_delta)
            });
          }
        }

        // Flush buffers when thresholds are reached
        if (
          summaryRowsBuffer.length >= summaryFlushSize
          || dailyRowsBuffer.length >= DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE
        ) {
          await enqueueFlush();
        }

        return { ticker, tradeDate: latestRow?.trade_date };
      }, {
        signal: fetchDailyAbortController.signal,
        timeoutMs: DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
        label: `Fetch-all ticker ${ticker}`
      });
    };

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      fetchDailyTickerWorker,
      (result, sliceIndex) => {
        settledCount += 1;
        processedTickers = startIndex + settledCount;
        const ticker = tickerSlice[sliceIndex] || '';
        if (result && result.error && !(divergenceFetchDailyDataStopRequested && isAbortError(result.error))) {
          errorTickers += 1;
          if (!isAbortError(result.error)) {
            failedTickers.push(ticker);
            runMetricsTracker?.recordFailedTicker(ticker);
            const message = result.error && result.error.message ? result.error.message : String(result.error);
            console.error(`Fetch-all divergence build failed for ${ticker}: ${message}`);
          }
        } else if (result && result.tradeDate) {
           lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, result.tradeDate);
        }
        divergenceFetchDailyDataStatus.processedTickers = processedTickers;
        divergenceFetchDailyDataStatus.errorTickers = errorTickers;
        divergenceFetchDailyDataStatus.lastPublishedTradeDate = lastPublishedTradeDate;
        divergenceFetchDailyDataStatus.status = divergenceFetchDailyDataStopRequested ? 'stopping' : 'running';
        runMetricsTracker?.setProgress(processedTickers, errorTickers);
        // Update resume state as we progress
        persistResumeState(startIndex + settledCount);
      },
      () => divergenceFetchDailyDataStopRequested || fetchDailyAbortController.signal.aborted
    );

    if (divergenceFetchDailyDataStopRequested) {
      // Final flush before reporting stopped — save whatever is buffered
      await enqueueFlush();
      return markStopped(processedTickers);
    }

    // Final flush for any remaining buffered rows
    await enqueueFlush();

    // --- Retry pass for failed tickers ---
    if (failedTickers.length > 0 && !divergenceFetchDailyDataStopRequested && !fetchDailyAbortController.signal.aborted) {
      const retryCount = failedTickers.length;
      console.log(`Fetch-all: retrying ${retryCount} failed ticker(s)...`);
      runMetricsTracker?.setPhase('retry');
      divergenceFetchDailyDataStatus.status = 'running-retry';
      let retryRecovered = 0;
      const stillFailedTickers = [];
      await mapWithConcurrency(
        failedTickers,
        Math.max(1, Math.floor(runConcurrency / 2)),
        fetchDailyTickerWorker,
        (result, idx) => {
          const ticker = failedTickers[idx] || '';
          if (result && result.error) {
            if (!isAbortError(result.error)) {
              const message = result.error && result.error.message ? result.error.message : String(result.error);
              console.error(`Fetch-all retry still failed for ${ticker}: ${message}`);
              stillFailedTickers.push(ticker);
            }
          } else {
            retryRecovered += 1;
            runMetricsTracker?.recordRetryRecovered(ticker);
            errorTickers = Math.max(0, errorTickers - 1);
          }
          divergenceFetchDailyDataStatus.errorTickers = errorTickers;
          runMetricsTracker?.setProgress(processedTickers, errorTickers);
        },
        () => divergenceFetchDailyDataStopRequested || fetchDailyAbortController.signal.aborted
      );
      if (retryRecovered > 0) {
        console.log(`Fetch-all: retry recovered ${retryRecovered}/${retryCount} ticker(s)`);
      }
      await enqueueFlush();
      runMetricsTracker?.recordStallRetry();

      // --- Second retry pass for tickers that failed both attempts ---
      if (stillFailedTickers.length > 0 && !divergenceFetchDailyDataStopRequested && !fetchDailyAbortController.signal.aborted) {
        const retry2Count = stillFailedTickers.length;
        console.log(`Fetch-all: second retry for ${retry2Count} ticker(s)...`);
        runMetricsTracker?.setPhase('retry-2');
        divergenceFetchDailyDataStatus.status = 'running-retry';
        let retry2Recovered = 0;
        await mapWithConcurrency(
          stillFailedTickers,
          Math.max(1, Math.floor(runConcurrency / 4)),
          fetchDailyTickerWorker,
          (result, idx) => {
            const ticker = stillFailedTickers[idx] || '';
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const message = result.error && result.error.message ? result.error.message : String(result.error);
                console.error(`Fetch-all retry-2 still failed for ${ticker}: ${message}`);
              }
            } else {
              retry2Recovered += 1;
              runMetricsTracker?.recordRetryRecovered(ticker);
              errorTickers = Math.max(0, errorTickers - 1);
            }
            divergenceFetchDailyDataStatus.errorTickers = errorTickers;
            runMetricsTracker?.setProgress(processedTickers, errorTickers);
          },
          () => divergenceFetchDailyDataStopRequested || fetchDailyAbortController.signal.aborted
        );
        if (retry2Recovered > 0) {
          console.log(`Fetch-all: second retry recovered ${retry2Recovered}/${retry2Count} ticker(s)`);
        }
        await enqueueFlush();
        runMetricsTracker?.recordStallRetry();
      }
    }

    if (maSeedRows.length > 0) {
      runMetricsTracker?.setPhase('ma-enrichment');
      divergenceFetchDailyDataStatus.status = 'running-ma';
      const maConcurrency = Math.max(1, Math.min(runConcurrency, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY));
      const failedMaSeeds = [];

      const fetchDailyMaWorker = async (seed) => {
        return runWithAbortAndTimeout(async (tickerSignal) => {
          const maStates = await fetchDataApiMovingAverageStatesForTicker(seed.ticker, Number(seed.latest_close), {
            signal: tickerSignal,
            metricsTracker: runMetricsTracker
          });
          if (maStates) {
            maSummaryRowsBuffer.push({
              ticker: seed.ticker,
              source_interval: seed.source_interval,
              trade_date: seed.trade_date,
              states: seed.states || buildNeutralDivergenceStateMap(),
              ma_states: maStates,
              latest_close: Number(seed.latest_close),
              latest_prev_close: Number(seed.latest_prev_close),
              latest_volume_delta: Number(seed.latest_volume_delta)
            });
            if (maSummaryRowsBuffer.length >= summaryFlushSize) {
              await enqueueFlush();
            }
          }
          return null;
        }, {
          signal: fetchDailyAbortController.signal,
          timeoutMs: DIVERGENCE_FETCH_MA_TIMEOUT_MS,
          label: `Fetch-all MA ${seed.ticker}`
        });
      };

      await mapWithConcurrency(
        maSeedRows,
        maConcurrency,
        fetchDailyMaWorker,
        (result, idx) => {
          if (result && result.error && !isAbortError(result.error)) {
            failedMaSeeds.push(maSeedRows[idx]);
            const message = result.error && result.error.message ? result.error.message : String(result.error);
            console.error(`Fetch-all MA enrichment failed: ${message}`);
          }
        },
        () => divergenceFetchDailyDataStopRequested || fetchDailyAbortController.signal.aborted
      );

      if (divergenceFetchDailyDataStopRequested) {
        await enqueueFlush();
        return markStopped(totalTickers, { preserveResume: false, rewind: false });
      }
      await enqueueFlush();

      // --- Retry pass for failed MA tickers ---
      if (failedMaSeeds.length > 0 && !divergenceFetchDailyDataStopRequested && !fetchDailyAbortController.signal.aborted) {
        const maRetryCount = failedMaSeeds.length;
        console.log(`Fetch-all: retrying ${maRetryCount} failed MA ticker(s)...`);
        divergenceFetchDailyDataStatus.status = 'running-ma-retry';
        let maRetryRecovered = 0;
        const stillFailedMaSeeds = [];
        await mapWithConcurrency(
          failedMaSeeds,
          Math.max(1, Math.floor(maConcurrency / 2)),
          fetchDailyMaWorker,
          (result, idx) => {
            const seed = failedMaSeeds[idx];
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const message = result.error && result.error.message ? result.error.message : String(result.error);
                console.error(`Fetch-all MA retry still failed for ${seed?.ticker}: ${message}`);
                stillFailedMaSeeds.push(seed);
              }
            } else {
              maRetryRecovered += 1;
            }
          },
          () => divergenceFetchDailyDataStopRequested || fetchDailyAbortController.signal.aborted
        );
        if (maRetryRecovered > 0) {
          console.log(`Fetch-all: MA retry recovered ${maRetryRecovered}/${maRetryCount} ticker(s)`);
        }
        await enqueueFlush();

        // --- Second retry pass for MA tickers ---
        if (stillFailedMaSeeds.length > 0 && !divergenceFetchDailyDataStopRequested && !fetchDailyAbortController.signal.aborted) {
          const maRetry2Count = stillFailedMaSeeds.length;
          console.log(`Fetch-all: second MA retry for ${maRetry2Count} ticker(s)...`);
          divergenceFetchDailyDataStatus.status = 'running-ma-retry';
          let maRetry2Recovered = 0;
          await mapWithConcurrency(
            stillFailedMaSeeds,
            Math.max(1, Math.floor(maConcurrency / 4)),
            fetchDailyMaWorker,
            (result, idx) => {
              const seed = stillFailedMaSeeds[idx];
              if (result && result.error) {
                if (!isAbortError(result.error)) {
                  const message = result.error && result.error.message ? result.error.message : String(result.error);
                  console.error(`Fetch-all MA retry-2 still failed for ${seed?.ticker}: ${message}`);
                }
              } else {
                maRetry2Recovered += 1;
              }
            },
            () => divergenceFetchDailyDataStopRequested || fetchDailyAbortController.signal.aborted
          );
          if (maRetry2Recovered > 0) {
            console.log(`Fetch-all: second MA retry recovered ${maRetry2Recovered}/${maRetry2Count} ticker(s)`);
          }
          await enqueueFlush();
        }
      }
    }

    if (lastPublishedTradeDate) {
      await publishDivergenceTradeDate({
        sourceInterval,
        tradeDate: lastPublishedTradeDate,
        scanJobId: null
      });
      divergenceLastFetchedTradeDateEt = maxEtDateString(divergenceLastFetchedTradeDateEt, lastPublishedTradeDate);
    }
    clearDivergenceSummaryCacheForSourceInterval(sourceInterval);

    // Completed successfully — clear resume state
    if (!lastPublishedTradeDate && asOfTradeDate) {
      lastPublishedTradeDate = asOfTradeDate;
    }
    divergenceFetchDailyDataResumeState = null;
    divergenceFetchDailyDataStopRequested = false;
    divergenceFetchDailyDataStatus = {
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: lastPublishedTradeDate || divergenceFetchDailyDataStatus.lastPublishedTradeDate || ''
    };
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: lastPublishedTradeDate || null
    };
  } catch (err) {
    // Flush whatever is buffered even on error/abort
    try {
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
        await syncOneDaySignalsFromSummaryRows(batch, sourceInterval, null);
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
      }
    } catch (flushErr) {
      console.error('Fetch-all error-path flush failed:', flushErr && flushErr.message ? flushErr.message : String(flushErr));
    }

    if (divergenceFetchDailyDataStopRequested || isAbortError(err)) {
      // Persist resume state on stop/abort — rewind by concurrency level
      // so in-flight aborted tickers are re-fetched on resume.
      const safeNextIndex = Math.max(0, processedTickers - runConcurrency);
      divergenceFetchDailyDataResumeState = normalizeFetchDailyDataResumeState({
        asOfTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: safeNextIndex,
        processedTickers: safeNextIndex,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate
      });
      divergenceFetchDailyDataStopRequested = false;
      divergenceFetchDailyDataStatus = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceFetchDailyDataStatus.lastPublishedTradeDate || ''
      };
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null
      };
    }
    divergenceFetchDailyDataStopRequested = false;
    divergenceFetchDailyDataStatus = {
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: divergenceFetchDailyDataStatus.lastPublishedTradeDate || ''
    };
    throw err;
  } finally {
    if (runMetricsTracker) {
      runMetricsTracker.finish(divergenceFetchDailyDataStatus.status || 'completed', {
        totalTickers,
        processedTickers: Number(divergenceFetchDailyDataStatus.processedTickers || processedTickers || 0),
        errorTickers: Number(divergenceFetchDailyDataStatus.errorTickers || errorTickers || 0),
        phase: divergenceFetchDailyDataStatus.status || 'completed',
        meta: {
          sourceInterval,
          asOfTradeDate,
          lastPublishedTradeDate
        }
      });
    }
    if (divergenceFetchDailyDataAbortController === fetchDailyAbortController) {
      divergenceFetchDailyDataAbortController = null;
    }
    divergenceFetchDailyDataRunning = false;
  }
}

async function runDivergenceFetchWeeklyData(options = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || divergenceFetchDailyDataRunning || divergenceFetchWeeklyDataRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeFetchWeeklyDataResumeState(divergenceFetchWeeklyDataResumeState || {}) : null;
  if (
    resumeRequested
    && (!resumeState
      || !resumeState.asOfTradeDate
      || !resumeState.weeklyTradeDate
      || resumeState.totalTickers === 0
      || resumeState.nextIndex >= resumeState.totalTickers)
  ) {
    return { status: 'no-resume' };
  }

  divergenceFetchWeeklyDataRunning = true;
  divergenceFetchWeeklyDataStopRequested = false;
  // Clear previous run metrics immediately so stale data never leaks into
  // the new run's Logs page display (failedTickers, errors, etc.).
  runMetricsByType.fetchWeekly = null;
  if (!resumeRequested) {
    divergenceFetchWeeklyDataResumeState = null;
  }

  let processedTickers = Math.max(0, Number(resumeState?.processedTickers || 0));
  let totalTickers = Math.max(0, Number(resumeState?.totalTickers || 0));
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  let lastPublishedTradeDate = String(resumeState?.lastPublishedTradeDate || '').trim();
  const startedAtIso = new Date().toISOString();
  const fetchWeeklyAbortController = new AbortController();
  divergenceFetchWeeklyDataAbortController = fetchWeeklyAbortController;
  divergenceFetchWeeklyDataStatus = {
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: lastPublishedTradeDate || divergenceFetchWeeklyDataStatus.lastPublishedTradeDate || ''
  };

  let tickers = resumeState?.tickers || [];
  let startIndex = Math.max(0, Number(resumeState?.nextIndex || 0));
  let sourceInterval = '';
  let runLookbackDays = DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS;
  let runConcurrency = resolveAdaptiveFetchConcurrency('fetch-weekly');
  const summaryFlushSize = DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE;
  let asOfTradeDate = '';
  let weeklyTradeDate = '';
  let runMetricsTracker = null;
  const dailyRowsBuffer = [];
  const summaryRowsBuffer = [];
  const maSummaryRowsBuffer = [];
  const maSeedRows = [];
  const weeklySignalRowsBuffer = [];
  const weeklyNeutralTickerBuffer = [];

  try {
    sourceInterval = resumeState?.sourceInterval
      || String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim()
      || DIVERGENCE_SOURCE_INTERVAL;
    runLookbackDays = resumeState?.lookbackDays
      || Math.max(28, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
    asOfTradeDate = resumeState?.asOfTradeDate || resolveLastClosedDailyCandleDate();
    weeklyTradeDate = resumeState?.weeklyTradeDate || resolveLastClosedWeeklyCandleDate();
    runConcurrency = resolveAdaptiveFetchConcurrency('fetch-weekly');
    runMetricsTracker = createRunMetricsTracker('fetchWeekly', {
      sourceInterval,
      asOfTradeDate,
      weeklyTradeDate,
      lookbackDays: runLookbackDays,
      concurrency: runConcurrency,
      flushSize: summaryFlushSize
    });
    runMetricsTracker.setPhase('core');

    if (!resumeRequested && !options.force) {
      const latestStoredWeeklyTradeDate = await getLatestWeeklySignalTradeDate(sourceInterval);
      if (latestStoredWeeklyTradeDate && latestStoredWeeklyTradeDate >= weeklyTradeDate) {
        divergenceFetchWeeklyDataStatus = {
          running: false,
          status: 'skipped',
          totalTickers: 0,
          processedTickers: 0,
          errorTickers: 0,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          lastPublishedTradeDate: latestStoredWeeklyTradeDate
        };
        return {
          status: 'skipped',
          reason: 'already-up-to-date',
          lastPublishedTradeDate: latestStoredWeeklyTradeDate
        };
      }
    }

    if (!resumeRequested) {
      tickers = await getStoredDivergenceSymbolTickers();
      startIndex = 0;
      processedTickers = 0;
      errorTickers = 0;
      lastPublishedTradeDate = '';
    }

    totalTickers = tickers.length;
    divergenceFetchWeeklyDataStatus.totalTickers = totalTickers;
    runMetricsTracker?.setTotals(totalTickers);

    const persistResumeState = (nextIdx) => {
      divergenceFetchWeeklyDataResumeState = normalizeFetchWeeklyDataResumeState({
        asOfTradeDate,
        weeklyTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: nextIdx,
        processedTickers,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate
      });
    };

    const markStopped = (nextIdx, options = {}) => {
      const preserveResume = options.preserveResume !== false;
      const rewind = options.rewind !== false;
      const safeNextIndex = rewind
        ? Math.max(0, Math.min(totalTickers, nextIdx - runConcurrency))
        : Math.max(0, Math.min(totalTickers, nextIdx));
      if (preserveResume) {
        persistResumeState(safeNextIndex);
      } else {
        divergenceFetchWeeklyDataResumeState = null;
      }
      divergenceFetchWeeklyDataStopRequested = false;
      divergenceFetchWeeklyDataStatus = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: weeklyTradeDate || lastPublishedTradeDate || divergenceFetchWeeklyDataStatus.lastPublishedTradeDate || ''
      };
      return {
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        lastPublishedTradeDate: weeklyTradeDate || null
      };
    };

    if (totalTickers === 0) {
      divergenceFetchWeeklyDataStopRequested = false;
      divergenceFetchWeeklyDataResumeState = null;
      divergenceFetchWeeklyDataStatus = {
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: divergenceFetchWeeklyDataStatus.lastPublishedTradeDate || ''
      };
      return { status: 'completed', totalTickers: 0, processedTickers: 0, errorTickers: 0, lastPublishedTradeDate: null };
    }

    // Keep divergence summaries published at the latest daily closed date.
    await publishDivergenceTradeDate({
      sourceInterval,
      tradeDate: asOfTradeDate,
      scanJobId: null
    });
    divergenceLastFetchedTradeDateEt = maxEtDateString(divergenceLastFetchedTradeDateEt, asOfTradeDate);

    const neutralStates = buildNeutralDivergenceStateMap();
    let flushChain = Promise.resolve();

    const flushBuffers = async () => {
      const flushStartedAt = Date.now();
      let flushedDailyRows = 0;
      let flushedSummaryRows = 0;
      let flushedSignalRows = 0;
      let flushedNeutralRows = 0;
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        flushedDailyRows += batch.length;
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        flushedSummaryRows += batch.length;
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (weeklySignalRowsBuffer.length > 0) {
        const batch = weeklySignalRowsBuffer.splice(0, weeklySignalRowsBuffer.length);
        flushedSignalRows += batch.length;
        await upsertDivergenceSignalsBatch(batch, null);
      }
      if (weeklyNeutralTickerBuffer.length > 0) {
        const neutralRows = weeklyNeutralTickerBuffer.splice(0, weeklyNeutralTickerBuffer.length);
        flushedNeutralRows += neutralRows.length;
        const neutralTickers = neutralRows.map((row) => row.ticker);
        const neutralTradeDates = neutralRows.map((row) => row.trade_date);
        await divergencePool.query(`
          DELETE FROM divergence_signals AS ds
          USING (
            SELECT
              s.ticker,
              s.trade_date
            FROM UNNEST(
              $1::VARCHAR[],
              $2::DATE[]
            ) AS s(ticker, trade_date)
          ) AS stale
          WHERE ds.ticker = stale.ticker
            AND ds.trade_date = stale.trade_date
            AND ds.timeframe = '1w'
            AND ds.source_interval = $3
        `, [neutralTickers, neutralTradeDates, sourceInterval]);
      }
      if (flushedDailyRows > 0 || flushedSummaryRows > 0 || flushedSignalRows > 0 || flushedNeutralRows > 0) {
        runMetricsTracker?.recordDbFlush({
          durationMs: Date.now() - flushStartedAt,
          dailyRows: flushedDailyRows,
          summaryRows: flushedSummaryRows,
          signalRows: flushedSignalRows,
          neutralRows: flushedNeutralRows
        });
      }
    };

    const enqueueFlush = () => {
      flushChain = flushChain.then(() => flushBuffers()).catch((err) => {
        console.error('Fetch-weekly on-the-fly flush error:', err && err.message ? err.message : String(err));
      });
      return flushChain;
    };

    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;
    const failedTickers = [];

    persistResumeState(startIndex);

    // --- Worker function shared by main pass and retry pass ---
    const fetchWeeklyTickerWorker = async (ticker) => {
      return runWithAbortAndTimeout(async (tickerSignal) => {
        if (divergenceFetchWeeklyDataStopRequested || fetchWeeklyAbortController.signal.aborted) {
          throw buildRequestAbortError('Fetch-weekly run stopped');
        }
        const sourceRows = await dataApiIntradayChartHistory(ticker, sourceInterval, runLookbackDays, {
          signal: tickerSignal,
          noCache: true,
          metricsTracker: runMetricsTracker
        });
        const rows = await buildDivergenceDailyRowsForTicker({
          ticker,
          sourceInterval,
          lookbackDays: runLookbackDays,
          asOfTradeDate,
          parentInterval: '1day',
          signal: tickerSignal,
          noCache: true,
          sourceRows,
          metricsTracker: runMetricsTracker
        });
        const weeklySnapshot = await buildLatestWeeklyBarSnapshotForTicker({
          ticker,
          sourceInterval,
          lookbackDays: runLookbackDays,
          asOfTradeDate: weeklyTradeDate,
          signal: tickerSignal,
          noCache: true,
          sourceRows,
          metricsTracker: runMetricsTracker
        });
        const filteredRows = Array.isArray(rows)
          ? rows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate)
          : [];
        const latestRow = filteredRows.length > 0 ? filteredRows[filteredRows.length - 1] : null;
        const latestClose = Number(latestRow?.close);

        if (rows && Array.isArray(rows) && rows.length > 0) {
          dailyRowsBuffer.push(...rows);
        }
        if (filteredRows.length >= 1 && latestRow?.trade_date) {
          const states = filteredRows.length >= 2
            ? classifyDivergenceStateMapFromDailyRows(filteredRows)
            : neutralStates;
          summaryRowsBuffer.push({
            ticker,
            source_interval: sourceInterval,
            trade_date: latestRow.trade_date,
            states,
            ma_states: null,
            latest_close: Number(latestRow.close),
            latest_prev_close: Number(latestRow.prev_close),
            latest_volume_delta: Number(latestRow.volume_delta)
          });
          if (Number.isFinite(latestClose) && latestClose > 0) {
            maSeedRows.push({
              ticker,
              source_interval: sourceInterval,
              trade_date: latestRow.trade_date,
              states,
              latest_close: latestClose,
              latest_prev_close: Number(latestRow.prev_close),
              latest_volume_delta: Number(latestRow.volume_delta)
            });
          }
        }
        if (weeklySnapshot?.trade_date) {
          const signalType = classifyDivergenceSignal(
            Number(weeklySnapshot.volume_delta),
            Number(weeklySnapshot.close),
            Number(weeklySnapshot.prev_close)
          );
          if (signalType === 'bullish' || signalType === 'bearish') {
            weeklySignalRowsBuffer.push({
              ticker,
              signal_type: signalType,
              trade_date: weeklySnapshot.trade_date,
              timeframe: '1w',
              source_interval: sourceInterval,
              price: Number(weeklySnapshot.close),
              prev_close: Number(weeklySnapshot.prev_close),
              volume_delta: Number(weeklySnapshot.volume_delta)
            });
          } else {
            weeklyNeutralTickerBuffer.push({
              ticker,
              trade_date: weeklySnapshot.trade_date
            });
          }
        }

        if (
          summaryRowsBuffer.length >= summaryFlushSize
          || dailyRowsBuffer.length >= DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE
          || weeklySignalRowsBuffer.length >= summaryFlushSize
          || weeklyNeutralTickerBuffer.length >= summaryFlushSize
        ) {
          await enqueueFlush();
        }

        return { ticker, tradeDate: latestRow?.trade_date };
      }, {
        signal: fetchWeeklyAbortController.signal,
        timeoutMs: DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
        label: `Fetch-weekly ticker ${ticker}`
      });
    };

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      fetchWeeklyTickerWorker,
      (result, sliceIndex) => {
        settledCount += 1;
        processedTickers = startIndex + settledCount;
        const ticker = tickerSlice[sliceIndex] || '';
        if (result && result.error && !(divergenceFetchWeeklyDataStopRequested && isAbortError(result.error))) {
          errorTickers += 1;
          if (!isAbortError(result.error)) {
            failedTickers.push(ticker);
            runMetricsTracker?.recordFailedTicker(ticker);
            const message = result.error && result.error.message ? result.error.message : String(result.error);
            console.error(`Fetch-weekly divergence build failed for ${ticker}: ${message}`);
          }
        } else if (result && result.tradeDate) {
          lastPublishedTradeDate = maxEtDateString(lastPublishedTradeDate, result.tradeDate);
        }
        divergenceFetchWeeklyDataStatus.processedTickers = processedTickers;
        divergenceFetchWeeklyDataStatus.errorTickers = errorTickers;
        divergenceFetchWeeklyDataStatus.lastPublishedTradeDate = lastPublishedTradeDate;
        divergenceFetchWeeklyDataStatus.status = divergenceFetchWeeklyDataStopRequested ? 'stopping' : 'running';
        runMetricsTracker?.setProgress(processedTickers, errorTickers);
        persistResumeState(startIndex + settledCount);
      },
      () => divergenceFetchWeeklyDataStopRequested || fetchWeeklyAbortController.signal.aborted
    );

    if (divergenceFetchWeeklyDataStopRequested) {
      await enqueueFlush();
      return markStopped(processedTickers);
    }

    await enqueueFlush();

    // --- Retry pass for failed tickers ---
    if (failedTickers.length > 0 && !divergenceFetchWeeklyDataStopRequested && !fetchWeeklyAbortController.signal.aborted) {
      const retryCount = failedTickers.length;
      console.log(`Fetch-weekly: retrying ${retryCount} failed ticker(s)...`);
      runMetricsTracker?.setPhase('retry');
      divergenceFetchWeeklyDataStatus.status = 'running-retry';
      let retryRecovered = 0;
      const stillFailedTickers = [];
      await mapWithConcurrency(
        failedTickers,
        Math.max(1, Math.floor(runConcurrency / 2)),
        fetchWeeklyTickerWorker,
        (result, idx) => {
          const ticker = failedTickers[idx] || '';
          if (result && result.error) {
            if (!isAbortError(result.error)) {
              const message = result.error && result.error.message ? result.error.message : String(result.error);
              console.error(`Fetch-weekly retry still failed for ${ticker}: ${message}`);
              stillFailedTickers.push(ticker);
            }
          } else {
            retryRecovered += 1;
            runMetricsTracker?.recordRetryRecovered(ticker);
            errorTickers = Math.max(0, errorTickers - 1);
          }
          divergenceFetchWeeklyDataStatus.errorTickers = errorTickers;
          runMetricsTracker?.setProgress(processedTickers, errorTickers);
        },
        () => divergenceFetchWeeklyDataStopRequested || fetchWeeklyAbortController.signal.aborted
      );
      if (retryRecovered > 0) {
        console.log(`Fetch-weekly: retry recovered ${retryRecovered}/${retryCount} ticker(s)`);
      }
      await enqueueFlush();
      runMetricsTracker?.recordStallRetry();

      // --- Second retry pass for tickers that failed both attempts ---
      if (stillFailedTickers.length > 0 && !divergenceFetchWeeklyDataStopRequested && !fetchWeeklyAbortController.signal.aborted) {
        const retry2Count = stillFailedTickers.length;
        console.log(`Fetch-weekly: second retry for ${retry2Count} ticker(s)...`);
        runMetricsTracker?.setPhase('retry-2');
        divergenceFetchWeeklyDataStatus.status = 'running-retry';
        let retry2Recovered = 0;
        await mapWithConcurrency(
          stillFailedTickers,
          Math.max(1, Math.floor(runConcurrency / 4)),
          fetchWeeklyTickerWorker,
          (result, idx) => {
            const ticker = stillFailedTickers[idx] || '';
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const message = result.error && result.error.message ? result.error.message : String(result.error);
                console.error(`Fetch-weekly retry-2 still failed for ${ticker}: ${message}`);
              }
            } else {
              retry2Recovered += 1;
              runMetricsTracker?.recordRetryRecovered(ticker);
              errorTickers = Math.max(0, errorTickers - 1);
            }
            divergenceFetchWeeklyDataStatus.errorTickers = errorTickers;
            runMetricsTracker?.setProgress(processedTickers, errorTickers);
          },
          () => divergenceFetchWeeklyDataStopRequested || fetchWeeklyAbortController.signal.aborted
        );
        if (retry2Recovered > 0) {
          console.log(`Fetch-weekly: second retry recovered ${retry2Recovered}/${retry2Count} ticker(s)`);
        }
        await enqueueFlush();
        runMetricsTracker?.recordStallRetry();
      }
    }

    if (maSeedRows.length > 0) {
      runMetricsTracker?.setPhase('ma-enrichment');
      divergenceFetchWeeklyDataStatus.status = 'running-ma';
      const maConcurrency = Math.max(1, Math.min(runConcurrency, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY));
      const failedMaSeeds = [];

      const fetchWeeklyMaWorker = async (seed) => {
        return runWithAbortAndTimeout(async (tickerSignal) => {
          const maStates = await fetchDataApiMovingAverageStatesForTicker(seed.ticker, Number(seed.latest_close), {
            signal: tickerSignal,
            metricsTracker: runMetricsTracker
          });
          if (maStates) {
            maSummaryRowsBuffer.push({
              ticker: seed.ticker,
              source_interval: seed.source_interval,
              trade_date: seed.trade_date,
              states: seed.states || buildNeutralDivergenceStateMap(),
              ma_states: maStates,
              latest_close: Number(seed.latest_close),
              latest_prev_close: Number(seed.latest_prev_close),
              latest_volume_delta: Number(seed.latest_volume_delta)
            });
            if (maSummaryRowsBuffer.length >= summaryFlushSize) {
              await enqueueFlush();
            }
          }
          return null;
        }, {
          signal: fetchWeeklyAbortController.signal,
          timeoutMs: DIVERGENCE_FETCH_MA_TIMEOUT_MS,
          label: `Fetch-weekly MA ${seed.ticker}`
        });
      };

      await mapWithConcurrency(
        maSeedRows,
        maConcurrency,
        fetchWeeklyMaWorker,
        (result, idx) => {
          if (result && result.error && !isAbortError(result.error)) {
            failedMaSeeds.push(maSeedRows[idx]);
            const message = result.error && result.error.message ? result.error.message : String(result.error);
            console.error(`Fetch-weekly MA enrichment failed: ${message}`);
          }
        },
        () => divergenceFetchWeeklyDataStopRequested || fetchWeeklyAbortController.signal.aborted
      );

      if (divergenceFetchWeeklyDataStopRequested) {
        await enqueueFlush();
        return markStopped(totalTickers, { preserveResume: false, rewind: false });
      }
      await enqueueFlush();

      // --- Retry pass for failed MA tickers ---
      if (failedMaSeeds.length > 0 && !divergenceFetchWeeklyDataStopRequested && !fetchWeeklyAbortController.signal.aborted) {
        const maRetryCount = failedMaSeeds.length;
        console.log(`Fetch-weekly: retrying ${maRetryCount} failed MA ticker(s)...`);
        divergenceFetchWeeklyDataStatus.status = 'running-ma-retry';
        let maRetryRecovered = 0;
        const stillFailedMaSeeds = [];
        await mapWithConcurrency(
          failedMaSeeds,
          Math.max(1, Math.floor(maConcurrency / 2)),
          fetchWeeklyMaWorker,
          (result, idx) => {
            const seed = failedMaSeeds[idx];
            if (result && result.error) {
              if (!isAbortError(result.error)) {
                const message = result.error && result.error.message ? result.error.message : String(result.error);
                console.error(`Fetch-weekly MA retry still failed for ${seed?.ticker}: ${message}`);
                stillFailedMaSeeds.push(seed);
              }
            } else {
              maRetryRecovered += 1;
            }
          },
          () => divergenceFetchWeeklyDataStopRequested || fetchWeeklyAbortController.signal.aborted
        );
        if (maRetryRecovered > 0) {
          console.log(`Fetch-weekly: MA retry recovered ${maRetryRecovered}/${maRetryCount} ticker(s)`);
        }
        await enqueueFlush();

        // --- Second retry pass for MA tickers ---
        if (stillFailedMaSeeds.length > 0 && !divergenceFetchWeeklyDataStopRequested && !fetchWeeklyAbortController.signal.aborted) {
          const maRetry2Count = stillFailedMaSeeds.length;
          console.log(`Fetch-weekly: second MA retry for ${maRetry2Count} ticker(s)...`);
          divergenceFetchWeeklyDataStatus.status = 'running-ma-retry';
          let maRetry2Recovered = 0;
          await mapWithConcurrency(
            stillFailedMaSeeds,
            Math.max(1, Math.floor(maConcurrency / 4)),
            fetchWeeklyMaWorker,
            (result, idx) => {
              const seed = stillFailedMaSeeds[idx];
              if (result && result.error) {
                if (!isAbortError(result.error)) {
                  const message = result.error && result.error.message ? result.error.message : String(result.error);
                  console.error(`Fetch-weekly MA retry-2 still failed for ${seed?.ticker}: ${message}`);
                }
              } else {
                maRetry2Recovered += 1;
              }
            },
            () => divergenceFetchWeeklyDataStopRequested || fetchWeeklyAbortController.signal.aborted
          );
          if (maRetry2Recovered > 0) {
            console.log(`Fetch-weekly: second MA retry recovered ${maRetry2Recovered}/${maRetry2Count} ticker(s)`);
          }
          await enqueueFlush();
        }
      }
    }

    runMetricsTracker?.setPhase('publishing');
    clearDivergenceSummaryCacheForSourceInterval(sourceInterval);

    divergenceFetchWeeklyDataResumeState = null;
    divergenceFetchWeeklyDataStopRequested = false;
    divergenceFetchWeeklyDataStatus = {
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: weeklyTradeDate || divergenceFetchWeeklyDataStatus.lastPublishedTradeDate || ''
    };
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: weeklyTradeDate || null
    };
  } catch (err) {
    try {
      if (dailyRowsBuffer.length > 0) {
        const batch = dailyRowsBuffer.splice(0, dailyRowsBuffer.length);
        await upsertDivergenceDailyBarsBatch(batch, null);
      }
      if (summaryRowsBuffer.length > 0) {
        const batch = summaryRowsBuffer.splice(0, summaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (maSummaryRowsBuffer.length > 0) {
        const batch = maSummaryRowsBuffer.splice(0, maSummaryRowsBuffer.length);
        await upsertDivergenceSummaryBatch(batch, null);
      }
      if (weeklySignalRowsBuffer.length > 0) {
        const batch = weeklySignalRowsBuffer.splice(0, weeklySignalRowsBuffer.length);
        await upsertDivergenceSignalsBatch(batch, null);
      }
      if (weeklyNeutralTickerBuffer.length > 0) {
        const neutralRows = weeklyNeutralTickerBuffer.splice(0, weeklyNeutralTickerBuffer.length);
        const neutralTickers = neutralRows.map((row) => row.ticker);
        const neutralTradeDates = neutralRows.map((row) => row.trade_date);
        await divergencePool.query(`
          DELETE FROM divergence_signals AS ds
          USING (
            SELECT
              s.ticker,
              s.trade_date
            FROM UNNEST(
              $1::VARCHAR[],
              $2::DATE[]
            ) AS s(ticker, trade_date)
          ) AS stale
          WHERE ds.ticker = stale.ticker
            AND ds.trade_date = stale.trade_date
            AND ds.timeframe = '1w'
            AND ds.source_interval = $3
        `, [neutralTickers, neutralTradeDates, sourceInterval]);
      }
    } catch (flushErr) {
      console.error('Fetch-weekly error-path flush failed:', flushErr && flushErr.message ? flushErr.message : String(flushErr));
    }

    if (divergenceFetchWeeklyDataStopRequested || isAbortError(err)) {
      const safeNextIndex = Math.max(0, processedTickers - runConcurrency);
      divergenceFetchWeeklyDataResumeState = normalizeFetchWeeklyDataResumeState({
        asOfTradeDate,
        weeklyTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: safeNextIndex,
        processedTickers: safeNextIndex,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate
      });
      divergenceFetchWeeklyDataStopRequested = false;
      divergenceFetchWeeklyDataStatus = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: weeklyTradeDate || divergenceFetchWeeklyDataStatus.lastPublishedTradeDate || ''
      };
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: weeklyTradeDate || null
      };
    }
    divergenceFetchWeeklyDataStopRequested = false;
    divergenceFetchWeeklyDataStatus = {
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: divergenceFetchWeeklyDataStatus.lastPublishedTradeDate || ''
    };
    throw err;
  } finally {
    if (runMetricsTracker) {
      runMetricsTracker.finish(divergenceFetchWeeklyDataStatus.status || 'completed', {
        totalTickers,
        processedTickers: Number(divergenceFetchWeeklyDataStatus.processedTickers || processedTickers || 0),
        errorTickers: Number(divergenceFetchWeeklyDataStatus.errorTickers || errorTickers || 0),
        phase: divergenceFetchWeeklyDataStatus.status || 'completed',
        meta: {
          sourceInterval,
          asOfTradeDate,
          weeklyTradeDate,
          lastPublishedTradeDate
        }
      });
    }
    if (divergenceFetchWeeklyDataAbortController === fetchWeeklyAbortController) {
      divergenceFetchWeeklyDataAbortController = null;
    }
    divergenceFetchWeeklyDataRunning = false;
  }
}

async function runDailyDivergenceScan(options = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceFetchDailyDataRunning || divergenceFetchWeeklyDataRunning) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeDivergenceScanResumeState(divergenceScanResumeState || {}) : null;
  if (resumeRequested && (!resumeState || resumeState.totalSymbols === 0)) {
    return { status: 'no-resume' };
  }

  divergenceScanRunning = true;
  divergenceScanPauseRequested = false;
  divergenceScanStopRequested = false;
  const scanAbortController = new AbortController();
  divergenceScanAbortController = scanAbortController;
  if (!resumeRequested) {
    divergenceScanResumeState = null;
  }

  const force = Boolean(options.force);
  const refreshUniverse = Boolean(options.refreshUniverse);
  const trigger = String(options.trigger || 'manual').trim() || 'manual';
  const runDate = resumeState?.runDateEt || String(options.runDateEt || currentEtDateString()).trim();
  if (!resumeRequested && !force && divergenceLastScanDateEt === runDate) {
    if (divergenceScanAbortController === scanAbortController) {
      divergenceScanAbortController = null;
    }
    divergenceScanRunning = false;
    return { status: 'skipped', reason: 'already-scanned', runDate };
  }

  let scanJobId = resumeState?.scanJobId || null;
  let processed = Math.max(0, Number(resumeState?.processed || 0));
  let bullishCount = Math.max(0, Number(resumeState?.bullishCount || 0));
  let bearishCount = Math.max(0, Number(resumeState?.bearishCount || 0));
  let errorCount = Math.max(0, Number(resumeState?.errorCount || 0));
  let latestScannedTradeDate = String(resumeState?.latestScannedTradeDate || '').trim();
  let summaryProcessedTickers = Math.max(0, Number(resumeState?.summaryProcessedTickers || 0));
  let symbols = resumeState?.symbols || [];
  let totalSymbols = Math.max(0, Number(resumeState?.totalSymbols || symbols.length));
  let nextIndex = Math.max(0, Number(resumeState?.nextIndex || 0));

  const persistResumeState = () => {
    divergenceScanResumeState = normalizeDivergenceScanResumeState({
      runDateEt: runDate,
      trigger,
      symbols,
      nextIndex,
      processed,
      bullishCount,
      bearishCount,
      errorCount,
      latestScannedTradeDate,
      summaryProcessedTickers,
      scanJobId
    });
  };

  try {
    if (!resumeRequested) {
      symbols = await getDivergenceUniverseTickers({ forceRefresh: refreshUniverse });
      totalSymbols = symbols.length;
      nextIndex = 0;
      processed = 0;
      bullishCount = 0;
      bearishCount = 0;
      errorCount = 0;
      latestScannedTradeDate = '';
      summaryProcessedTickers = 0;
      scanJobId = await startDivergenceScanJob(runDate, totalSymbols, trigger);

      await divergencePool.query(`
        DELETE FROM divergence_signals
        WHERE source_interval = $1
          AND timeframe <> '1d'
      `, [DIVERGENCE_SOURCE_INTERVAL]);
      await divergencePool.query(`
        DELETE FROM divergence_signals
        WHERE trade_date = $1
          AND source_interval = $2
          AND timeframe = '1d'
      `, [runDate, DIVERGENCE_SOURCE_INTERVAL]);
    } else if (scanJobId) {
      await updateDivergenceScanJob(scanJobId, {
        status: 'running',
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null
      });
    }

    if (totalSymbols === 0) {
      await updateDivergenceScanJob(scanJobId, {
        status: 'completed',
        finished_at: new Date(),
        processed_symbols: 0,
        scanned_trade_date: null
      });
      divergenceLastScanDateEt = runDate;
      divergenceLastFetchedTradeDateEt = runDate;
      divergenceScanResumeState = null;
      return { status: 'completed', runDate, processed: 0 };
    }

    const targetSpacingMs = DIVERGENCE_SCAN_SPREAD_MINUTES > 0
      ? Math.max(0, Math.floor((DIVERGENCE_SCAN_SPREAD_MINUTES * 60 * 1000) / totalSymbols))
      : 0;

    persistResumeState();
    for (let i = nextIndex; i < symbols.length; i += DIVERGENCE_SCAN_CONCURRENCY) {
      if (divergenceScanStopRequested) {
        divergenceScanPauseRequested = false;
        divergenceScanStopRequested = false;
        divergenceScanResumeState = null;
        await updateDivergenceScanJob(scanJobId, {
          status: 'stopped',
          finished_at: new Date(),
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null
        });
        return {
          status: 'stopped',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount
        };
      }
      if (divergenceScanPauseRequested) {
        nextIndex = i;
        divergenceScanPauseRequested = false;
        divergenceScanStopRequested = false;
        persistResumeState();
        await updateDivergenceScanJob(scanJobId, {
          status: 'paused',
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null
        });
        return {
          status: 'paused',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount
        };
      }

      nextIndex = i;
      const batch = symbols.slice(i, i + DIVERGENCE_SCAN_CONCURRENCY);
      const attemptController = new AbortController();
      const unlinkAbort = linkAbortSignalToController(scanAbortController.signal, attemptController);
      let batchResults = [];
      try {
        batchResults = await Promise.all(batch.map(async (ticker) => {
          try {
            const outcome = await computeSymbolDivergenceSignals(ticker, { signal: attemptController.signal });
            return { ticker, ...outcome, error: null };
          } catch (err) {
            return { ticker, signals: [], latestTradeDate: '', error: err };
          }
        }));
      } finally {
        unlinkAbort();
      }

      if (divergenceScanStopRequested) {
        divergenceScanPauseRequested = false;
        divergenceScanStopRequested = false;
        divergenceScanResumeState = null;
        await updateDivergenceScanJob(scanJobId, {
          status: 'stopped',
          finished_at: new Date(),
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null
        });
        return {
          status: 'stopped',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount
        };
      }
      if (divergenceScanPauseRequested) {
        nextIndex = i;
        divergenceScanPauseRequested = false;
        divergenceScanStopRequested = false;
        persistResumeState();
        await updateDivergenceScanJob(scanJobId, {
          status: 'paused',
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null
        });
        return {
          status: 'paused',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount
        };
      }

      const batchSignals = [];
      const batchDailyBars = [];
      for (const result of batchResults) {
        processed += 1;
        if (result.error) {
          if (isAbortError(result.error) && (scanAbortController.signal.aborted || divergenceScanStopRequested || divergenceScanPauseRequested)) {
            continue;
          }
          errorCount += 1;
          const message = result.error && result.error.message ? result.error.message : String(result.error);
          console.error(`Divergence scan failed for ${result.ticker}: ${message}`);
          continue;
        }
        if (result.latestTradeDate) {
          latestScannedTradeDate = maxEtDateString(latestScannedTradeDate, result.latestTradeDate);
        }
        if (result.dailyBar) {
          batchDailyBars.push(result.dailyBar);
        }
        for (const signal of result.signals) {
          batchSignals.push(signal);
          if (signal.signal_type === 'bullish') bullishCount += 1;
          if (signal.signal_type === 'bearish') bearishCount += 1;
        }
      }
      await Promise.all([
        upsertDivergenceDailyBarsBatch(batchDailyBars, scanJobId),
        upsertDivergenceSignalsBatch(batchSignals, scanJobId)
      ]);

      if (scanJobId && (processed % DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY === 0 || processed === totalSymbols)) {
        await updateDivergenceScanJob(scanJobId, {
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null
        });
      }

      nextIndex = Math.min(symbols.length, i + DIVERGENCE_SCAN_CONCURRENCY);
      persistResumeState();
      if (targetSpacingMs > 0) {
        try {
          await sleepWithAbort(targetSpacingMs, scanAbortController.signal);
        } catch (sleepErr) {
          if (!(isAbortError(sleepErr) && (divergenceScanStopRequested || divergenceScanPauseRequested))) {
            throw sleepErr;
          }
        }
      }
    }

    if (divergenceScanStopRequested) {
      divergenceScanPauseRequested = false;
      divergenceScanStopRequested = false;
      divergenceScanResumeState = null;
      await updateDivergenceScanJob(scanJobId, {
        status: 'stopped',
        finished_at: new Date(),
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null
      });
      return {
        status: 'stopped',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount
      };
    }
    if (divergenceScanPauseRequested) {
      divergenceScanPauseRequested = false;
      divergenceScanStopRequested = false;
      persistResumeState();
      await updateDivergenceScanJob(scanJobId, {
        status: 'paused',
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null
      });
      return {
        status: 'paused',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount
      };
    }

    await updateDivergenceScanJob(scanJobId, {
      status: 'summarizing',
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount,
      scanned_trade_date: latestScannedTradeDate || null
    });

    const asOfTradeDate = latestScannedTradeDate || runDate;
    const summaryResult = await rebuildDivergenceSummariesForTradeDate({
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      asOfTradeDate,
      scanJobId
    });
    summaryProcessedTickers = Number(summaryResult?.processedTickers || 0);

    const publishedTradeDate = await publishDivergenceTradeDate({
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      tradeDate: asOfTradeDate,
      scanJobId
    });
    clearDivergenceSummaryCacheForSourceInterval(DIVERGENCE_SOURCE_INTERVAL);

    await updateDivergenceScanJob(scanJobId, {
      status: 'completed',
      finished_at: new Date(),
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount,
      scanned_trade_date: latestScannedTradeDate || null,
      notes: `summary_tickers=${summaryProcessedTickers}`
    });
    divergenceScanPauseRequested = false;
    divergenceScanStopRequested = false;
    divergenceScanResumeState = null;
    divergenceLastScanDateEt = runDate;
    divergenceLastFetchedTradeDateEt = publishedTradeDate || latestScannedTradeDate || runDate;
    return {
      status: 'completed',
      runDate,
      fetchedTradeDate: publishedTradeDate || latestScannedTradeDate || runDate,
      processed,
      bullishCount,
      bearishCount,
      errorCount,
      summaryProcessedTickers
    };
  } catch (err) {
    if (divergenceScanStopRequested || (isAbortError(err) && scanAbortController.signal.aborted && !divergenceScanPauseRequested)) {
      divergenceScanPauseRequested = false;
      divergenceScanStopRequested = false;
      divergenceScanResumeState = null;
      await updateDivergenceScanJob(scanJobId, {
        status: 'stopped',
        finished_at: new Date(),
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null
      });
      return {
        status: 'stopped',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount
      };
    }
    if (divergenceScanPauseRequested || (isAbortError(err) && scanAbortController.signal.aborted)) {
      divergenceScanPauseRequested = false;
      divergenceScanStopRequested = false;
      persistResumeState();
      await updateDivergenceScanJob(scanJobId, {
        status: 'paused',
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null
      });
      return {
        status: 'paused',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount
      };
    }
    divergenceScanPauseRequested = false;
    divergenceScanStopRequested = false;
    if (!divergenceScanResumeState && symbols.length > 0) {
      persistResumeState();
    }
    await updateDivergenceScanJob(scanJobId, {
      status: 'failed',
      finished_at: new Date(),
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount,
      notes: String(err && err.message ? err.message : err || '')
    });
    throw err;
  } finally {
    if (divergenceScanAbortController === scanAbortController) {
      divergenceScanAbortController = null;
    }
    divergenceScanRunning = false;
  }
}

function getNextDivergenceScanUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  candidate.setHours(16, 20, 0, 0);

  const candidateDateStr = () => `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;

  if (!tradingCalendar.isTradingDay(candidateDateStr()) || nowEt.getTime() >= candidate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 15 && !tradingCalendar.isTradingDay(candidateDateStr()); i++) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return easternLocalToUtcMs(
    candidate.getFullYear(),
    candidate.getMonth() + 1,
    candidate.getDate(),
    16,
    20
  );
}

async function runScheduledDivergencePipeline() {
  const scanSummary = await runDailyDivergenceScan({ trigger: 'scheduler' });
  const scanStatus = String(scanSummary?.status || 'unknown');
  if (scanStatus !== 'completed') {
    console.log(`Scheduled divergence scan status=${scanStatus}; skipping scheduled table build.`);
    return scanSummary;
  }

  try {
    const tableSummary = await runDivergenceTableBuild({
      trigger: 'scheduler-post-scan',
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL
    });
    console.log('Scheduled divergence table build completed after scan:', tableSummary);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`Scheduled divergence table build failed after scan: ${message}`);
  }

  return scanSummary;
}

function scheduleNextDivergenceScan() {
  if (!isDivergenceConfigured() || !DIVERGENCE_SCANNER_ENABLED) return;
  if (divergenceSchedulerTimer) clearTimeout(divergenceSchedulerTimer);
  const nextRunMs = getNextDivergenceScanUtcMs(new Date());
  const delayMs = Math.max(1000, nextRunMs - Date.now());
  divergenceSchedulerTimer = setTimeout(async () => {
    try {
      await runScheduledDivergencePipeline();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Scheduled divergence scan failed: ${message}`);
    } finally {
      scheduleNextDivergenceScan();
    }
  }, delayMs);
  if (typeof divergenceSchedulerTimer.unref === 'function') {
    divergenceSchedulerTimer.unref();
  }
  console.log(`Next divergence scan scheduled in ${Math.round(delayMs / 1000)}s`);
}

registerDivergenceRoutes({
  app,
  isDivergenceConfigured,
  divergenceScanSecret: process.env.DIVERGENCE_SCAN_SECRET,
  getIsScanRunning: () => divergenceScanRunning,
  getIsFetchDailyDataRunning: () => divergenceFetchDailyDataRunning,
  getIsFetchWeeklyDataRunning: () => divergenceFetchWeeklyDataRunning,
  parseBooleanInput,
  parseEtDateInput,
  runDailyDivergenceScan,
  runDivergenceTableBuild,
  runDivergenceFetchDailyData,
  runDivergenceFetchWeeklyData,
  divergencePool,
  divergenceSourceInterval: DIVERGENCE_SOURCE_INTERVAL,
  getLastFetchedTradeDateEt: () => divergenceLastFetchedTradeDateEt,
  getLastScanDateEt: () => divergenceLastScanDateEt,
  getIsTableBuildRunning: () => divergenceTableBuildRunning,
  getScanControlStatus: () => getDivergenceScanControlStatus(),
  requestPauseScan: () => requestPauseDivergenceScan(),
  requestStopScan: () => requestStopDivergenceScan(),
  canResumeScan: () => canResumeDivergenceScan(),
  getTableBuildStatus: () => getDivergenceTableBuildStatus(),
  requestPauseTableBuild: () => requestPauseDivergenceTableBuild(),
  requestStopTableBuild: () => requestStopDivergenceTableBuild(),
  canResumeTableBuild: () => canResumeDivergenceTableBuild(),
  getFetchDailyDataStatus: () => getDivergenceFetchDailyDataStatus(),
  requestStopFetchDailyData: () => requestStopDivergenceFetchDailyData(),
  canResumeFetchDailyData: () => canResumeDivergenceFetchDailyData(),
  getFetchWeeklyDataStatus: () => getDivergenceFetchWeeklyDataStatus(),
  requestStopFetchWeeklyData: () => requestStopDivergenceFetchWeeklyData(),
  canResumeFetchWeeklyData: () => canResumeDivergenceFetchWeeklyData(),
  getVDFScanStatus: () => getVDFScanStatus(),
  requestStopVDFScan: () => requestStopVDFScan(),
  runVDFScan,
  getIsVDFScanRunning: () => vdfScanRunning
});

app.get('/api/logs/run-metrics', (req, res) => {
  return res.status(200).json(getLogsRunMetricsPayload());
});

app.get('/api/trading-calendar/context', (req, res) => {
  const today = currentEtDateString();
  const isTodayTradingDay = tradingCalendar.isTradingDay(today);
  const lastTradingDay = isTodayTradingDay ? today : tradingCalendar.previousTradingDay(today);
  // Walk back 5 trading days from today
  let cursor = today;
  for (let i = 0; i < 5; i++) {
    cursor = tradingCalendar.previousTradingDay(cursor);
  }
  return res.status(200).json({
    today,
    lastTradingDay,
    tradingDay5Back: cursor,
    isTodayTradingDay,
    calendarInitialized: tradingCalendar.getStatus().initialized
  });
});

function getDebugMetricsPayload() {
  return buildDebugMetricsPayload({
    startedAtMs,
    isShuttingDown,
    httpDebugMetrics,
    chartCacheSizes: {
      lowerTf: VD_RSI_LOWER_TF_CACHE.size,
      vdRsiResults: VD_RSI_RESULT_CACHE.size,
      chartData: CHART_DATA_CACHE.size,
      quotes: CHART_QUOTE_CACHE.size,
      finalResults: CHART_FINAL_RESULT_CACHE.size,
      inFlight: CHART_IN_FLIGHT_REQUESTS.size
    },
    chartDebugMetrics,
    divergence: {
      configured: isDivergenceConfigured(),
      running: divergenceScanRunning,
      lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || null
    },
    memoryUsage: process.memoryUsage()
  });
}

function getHealthPayload() {
  return buildHealthPayload({
    isShuttingDown,
    nowIso: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
}

async function getReadyPayload() {
  return buildReadyPayload({
    pool,
    divergencePool,
    isDivergenceConfigured,
    isShuttingDown,
    divergenceScanRunning,
    lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || null
  });
}

registerHealthRoutes({
  app,
  debugMetricsSecret: DEBUG_METRICS_SECRET,
  getDebugMetricsPayload,
  getHealthPayload,
  getReadyPayload
});

const ALERT_RETENTION_DAYS = 30;
const PRUNE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function pruneOldAlerts() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - ALERT_RETENTION_DAYS);
    const result = await pool.query('DELETE FROM alerts WHERE created_at < $1', [cutoffDate]);
    if (result.rowCount > 0) {
      console.log(`Pruned ${result.rowCount} old alerts created before ${cutoffDate.toISOString()}`);
    }
  } catch (err) {
    console.error('Failed to prune old alerts:', err.message);
  }
}

let server;
let pruneOldAlertsInitialTimer = null;
let pruneOldAlertsIntervalTimer = null;

(async function startServer() {
  try {
    await initDB();
    await initDivergenceDB();
  } catch (err) {
    console.error('Fatal: database initialization failed, exiting.', err);
    process.exit(1);
  }

  // Build trading calendar (non-fatal — falls back to weekday-only if API unreachable)
  await tradingCalendar.init({
    fetchDataApiJson,
    buildDataApiUrl,
    formatDateUTC,
    log: (msg) => console.log(`[TradingCalendar] ${msg}`)
  }).catch(err => {
    console.warn('[TradingCalendar] Init failed (non-fatal, using weekday fallback):', err && err.message ? err.message : err);
  });

  server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    scheduleNextDivergenceScan();

    // Schedule initial prune and recurring interval
    pruneOldAlertsInitialTimer = setTimeout(pruneOldAlerts, 60 * 1000); // Run 1 minute after startup
    pruneOldAlertsIntervalTimer = setInterval(pruneOldAlerts, PRUNE_CHECK_INTERVAL_MS);
  });
})();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdownServer('uncaughtException');
});

async function shutdownServer(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully...`);

  if (divergenceSchedulerTimer) {
    clearTimeout(divergenceSchedulerTimer);
    divergenceSchedulerTimer = null;
  }
  if (pruneOldAlertsInitialTimer) {
    clearTimeout(pruneOldAlertsInitialTimer);
    pruneOldAlertsInitialTimer = null;
  }
  if (pruneOldAlertsIntervalTimer) {
    clearInterval(pruneOldAlertsIntervalTimer);
    pruneOldAlertsIntervalTimer = null;
  }
  tradingCalendar.destroy();
  clearInterval(vdRsiCacheCleanupTimer);

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15000);
  if (typeof forceExitTimer.unref === 'function') {
    forceExitTimer.unref();
  }

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await Promise.allSettled([
      pool.end(),
      divergencePool ? divergencePool.end() : Promise.resolve()
    ]);
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`Graceful shutdown failed: ${message}`);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  shutdownServer('SIGINT');
});
process.on('SIGTERM', () => {
  shutdownServer('SIGTERM');
});

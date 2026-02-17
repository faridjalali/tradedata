import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';
import compression from 'compression';
import { setGlobalDispatcher, Agent } from 'undici';
import { LRUCache } from 'lru-cache';
import logger from './server/logger.js';

// setGlobalDispatcher(new Agent({
//   keepAliveTimeout: 10000,
//   keepAliveMaxTimeout: 10000,
//   connect: {
//     timeout: 10000
//   }
// }));

import { registerChartRoutes } from './server/routes/chartRoutes.js';
import { registerDivergenceRoutes } from './server/routes/divergenceRoutes.js';
import { registerHealthRoutes } from './server/routes/healthRoutes.js';
import { ScanState, runRetryPasses } from './server/lib/ScanState.js';
import * as sessionAuth from './server/services/sessionAuth.js';
import * as tradingCalendar from './server/services/tradingCalendar.js';
import { buildDebugMetricsPayload, buildHealthPayload, buildReadyPayload } from './server/services/healthService.js';
import { detectVDF } from './server/services/vdfDetector.js';
import {
  classifyDivergenceSignal,
  barsToTuples,
  pointsToTuples,
  formatDateUTC,
  dayKeyInLA,
} from './server/chartMath.js';
import * as schemas from './server/schemas.js';
import * as chartPrewarm from './server/services/chartPrewarm.js';
import 'dotenv/config';

import { instrumentPool } from './server/lib/dbMonitor.js';

// --- Extracted modules ---
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
} from './server/lib/dateUtils.js';

import {
  buildDataApiUrl,
  sanitizeDataApiUrl,
  DATA_API_AGG_INTERVAL_MAP,
  getDataApiAggConfig,
  buildDataApiAggregateRangeUrl,
  fetchDataApiJson,
  fetchDataApiArrayWithFallback,
  assertDataApiKey,
  isDataApiRequestsPaused,
  buildDataApiPausedError,
  isDataApiPausedError,
  isAbortError,
  buildRequestAbortError,
  buildTaskTimeoutError,
  isDataApiRateLimitedError,
  buildDataApiRateLimitedError,
  isDataApiSubscriptionRestrictedError,
  sleepWithAbort,
  linkAbortSignalToController,
  runWithAbortAndTimeout,
  createProgressStallWatchdog,
  getStallRetryBackoffMs,
  normalizeTickerSymbol,
  getDataApiSymbolCandidates,
  toNumberOrNull,
  toArrayPayload,
  normalizeUnixSeconds,
  normalizeQuoteTimestamp,
  toQuoteRow,
  dataApiDaily,
  dataApiDailySingle,
  fetchDataApiIndicatorLatestValue,
  fetchDataApiMovingAverageStatesForTicker,
  dataApiQuoteSingle,
  dataApiLatestQuote,
} from './server/services/dataApi.js';

import {
  VD_RSI_LOWER_TF_CACHE,
  VD_RSI_RESULT_CACHE,
  CHART_DATA_CACHE,
  CHART_QUOTE_CACHE,
  CHART_FINAL_RESULT_CACHE,
  CHART_IN_FLIGHT_REQUESTS,
  vdRsiCacheCleanupTimer,
  VALID_CHART_INTERVALS,
  VOLUME_DELTA_SOURCE_INTERVALS,
  DIVERGENCE_LOOKBACK_DAYS,
  DIVERGENCE_SUMMARY_BUILD_CONCURRENCY,
  DIVERGENCE_ON_DEMAND_REFRESH_COOLDOWN_MS,
  CHART_TIMING_LOG_ENABLED,
  CHART_INTRADAY_LOOKBACK_DAYS,
  CHART_IN_FLIGHT_MAX,
  getTimedCacheValue,
  setTimedCacheValue,
  sweepExpiredTimedCache,
  isEtRegularHours,
  nextEtMarketOpenUtcMs,
  todayEtMarketCloseUtcMs,
  getVdRsiCacheExpiryMs,
  nextPacificDivergenceRefreshUtcMs,
  latestCompletedPacificTradeDateKey,
  dataApiIntraday,
  dataApiIntradayChartHistory,
  dataApiIntradayChartHistorySingle,
  getIntradayLookbackDays,
  calculateRSI,
  calculateRMA,
  getIntervalSeconds,
  normalizeIntradayVolumesFromCumulativeIfNeeded,
  computeVolumeDeltaByParentBars,
  calculateVolumeDeltaRsiSeries,
  parseDataApiDateTime,
  parseBarTimeToUnixSeconds,
  convertToLATime,
  patchLatestBarCloseWithQuote,
  toVolumeDeltaSourceInterval,
  buildChartRequestKey,
  createChartStageTimer,
  getChartCacheControlHeaderValue,
  getChartResultCacheExpiryMs,
  sendChartJsonResponse,
  buildChartResultFromRows,
  getSpyDaily,
  getSpyIntraday,
  isRegularHoursEt,
  roundEtTo30MinEpochMs,
  buildIntradayBreadthPoints,
} from './server/services/chartEngine.js';

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Railway, Heroku, etc.) for accurate IP in rate limiter
const port = process.env.PORT || 3000;
const gzipAsync = promisify(zlib.gzip);
const brotliCompressAsync = promisify(zlib.brotliCompress);

// CORS: restrict to configured origin(s), or allow all in dev.
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || '').trim();
app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN.split(',').map((o) => o.trim()), credentials: true } : undefined));

// Security headers via helmet (CSP, HSTS, X-Content-Type-Options, etc.)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'sameorigin' },
  }),
);

// Rate limiting on API endpoints: 300 requests per 15 minutes per IP.
const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.max(1, Number(process.env.API_RATE_LIMIT_MAX) || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: (req) => !String(req.path || '').startsWith('/api/'),
});
app.use(apiRateLimiter);

app.use(compression());
app.use(express.json());

const BASIC_AUTH_ENABLED = String(process.env.BASIC_AUTH_ENABLED || 'false').toLowerCase() !== 'false';
const BASIC_AUTH_USERNAME = String(process.env.BASIC_AUTH_USERNAME || 'shared');
const BASIC_AUTH_PASSWORD = String(process.env.BASIC_AUTH_PASSWORD || '');
const BASIC_AUTH_REALM = String(process.env.BASIC_AUTH_REALM || 'Catvue');
const SITE_LOCK_PASSCODE = String(process.env.SITE_LOCK_PASSCODE || '').trim();
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
    weeklyFrom1dayCacheHit: 0,
  },
  prewarmCompleted: 0,
  prewarmFailed: 0,
  requestTimingByInterval: {} as Record<string, any>,
};
const httpDebugMetrics = {
  totalRequests: 0,
  apiRequests: 0,
};
const CHART_TIMING_SAMPLE_MAX = Math.max(50, Number(process.env.CHART_TIMING_SAMPLE_MAX) || 240);
const chartTimingSamplesByKey = new Map();

function clampTimingSample(valueMs: any) {
  const numeric = Number(valueMs);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100) / 100;
}

function pushTimingSample(cacheKey: any, valueMs: any) {
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

function calculateP95Ms(samples: any) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

function getOrCreateChartTimingSummary(interval: any) {
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
      cacheMissP95Ms: 0,
    };
  }
  return chartDebugMetrics.requestTimingByInterval[key];
}

function recordChartRequestTiming(options: any = {}) {
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
  const requireNonEmpty = (name: any) => {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      errors.push(`${name} is required`);
    }
  };
  const warnIfMissing = (name: any) => {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      warnings.push(`${name} is not set`);
    }
  };
  const warnIfInvalidPositiveNumber = (name: any) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      warnings.push(`${name} should be a positive number (received: ${String(raw)})`);
    }
  };
  const warnIfInvalidNonNegativeNumber = (name: any) => {
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
    'CHART_FINAL_RESULT_CACHE_MAX_ENTRIES',
  ];
  positiveNumericEnvNames.forEach(warnIfInvalidPositiveNumber);
  const nonNegativeNumericEnvNames = [
    'DIVERGENCE_STALL_MAX_RETRIES',
    'CHART_RESULT_CACHE_TTL_SECONDS',
    'CHART_RESPONSE_MAX_AGE_SECONDS',
    'CHART_RESPONSE_SWR_SECONDS',
    'CHART_RESPONSE_COMPRESS_MIN_BYTES',
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

function logStructured(level: any, event: any, fields = {}) {
  const pinoLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  logger[pinoLevel]({ event, ...fields });
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(8).toString('hex');
}

function shouldLogRequestPath(pathname: any) {
  const path = String(pathname || '');
  if (path.startsWith('/api/')) return true;
  return path === '/healthz' || path === '/readyz';
}

function extractSafeRequestMeta(req: any) {
  const path = String(req.path || '');
  const queryKeys = Object.keys(req.query || {});
  const meta = {
    method: req.method,
    path,
    queryKeys,
  };
  if (path.startsWith('/api/chart')) {
    const ticker = typeof req.query?.ticker === 'string' ? req.query.ticker : null;
    const interval = typeof req.query?.interval === 'string' ? req.query.interval : null;
    return { ...meta, ticker, interval };
  }
  return meta;
}

function isValidTickerSymbol(value: any) {
  return schemas.tickerSymbol.safeParse(value).success;
}

function parseEtDateInput(value: any) {
  if (value === undefined || value === null || value === '') return null;
  const result = schemas.etDate.safeParse(value);
  return result.success ? result.data : null;
}

function parseBooleanInput(value: any, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const result = schemas.booleanInput.safeParse(value);
  return result.success ? result.data : fallback;
}

function validateChartPayloadShape(payload: any) {
  const result = schemas.chartPayload.safeParse(payload);
  if (result.success) return { ok: true };
  const firstIssue = result.error.issues[0];
  return { ok: false, error: firstIssue ? firstIssue.message : 'Invalid chart payload shape' };
}

function validateChartLatestPayloadShape(payload: any) {
  const result = schemas.chartLatestPayload.safeParse(payload);
  if (result.success) return { ok: true };
  const firstIssue = result.error.issues[0];
  return { ok: false, error: firstIssue ? firstIssue.message : 'Invalid latest payload shape' };
}

function timingSafeStringEqual(left: any, right: any) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function basicAuthMiddleware(req: any, res: any, next: any) {
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

app.use(
  express.static('dist', {
    maxAge: '1y',
    immutable: true,
  }),
);
app.use((req, res, next) => {
  if (!isShuttingDown) return next();
  res.setHeader('Connection', 'close');
  return res.status(503).json({ error: 'Server is shutting down' });
});
app.use((req, res, next) => {
  const requestId = String(req.headers['x-request-id'] || '').trim() || createRequestId();
  (req as any).requestId = requestId;
  res.setHeader('x-request-id', requestId);

  httpDebugMetrics.totalRequests += 1;
  if (String(req.path || '').startsWith('/api/')) {
    httpDebugMetrics.apiRequests += 1;
  }

  if (!REQUEST_LOG_ENABLED || !shouldLogRequestPath(req.path)) {
    return next();
  }

  const startedNs = process.hrtime.bigint();
  logStructured('info', 'request_start', {
    requestId,
    ...extractSafeRequestMeta(req),
  });
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    logStructured('info', 'request_end', {
      requestId,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      ...extractSafeRequestMeta(req),
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
instrumentPool(pool, 'primary');
if (divergencePool) instrumentPool(divergencePool, 'divergence');

const DIVERGENCE_SOURCE_INTERVAL = '1min';
const DIVERGENCE_SCAN_PARENT_INTERVAL = '1day';
const DIVERGENCE_SCAN_LOOKBACK_DAYS = 45;
const DIVERGENCE_SCAN_SPREAD_MINUTES = Math.max(0, Number(process.env.DIVERGENCE_SCAN_SPREAD_MINUTES) || 0);
const DIVERGENCE_SCAN_CONCURRENCY = Math.max(1, Number(process.env.DIVERGENCE_SCAN_CONCURRENCY) || 128);
const DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY = Math.max(
  25,
  Number(process.env.DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY) || 500,
);
const DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS = Math.max(45, Number(process.env.DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS) || 60);
const DIVERGENCE_TABLE_BUILD_CONCURRENCY = Math.max(1, Number(process.env.DIVERGENCE_TABLE_BUILD_CONCURRENCY) || 24);
const DIVERGENCE_TABLE_MIN_COVERAGE_DAYS = Math.max(29, Number(process.env.DIVERGENCE_TABLE_MIN_COVERAGE_DAYS) || 29);
// Scheduler is intentionally hard-disabled for now; runs are manual-only.
const DIVERGENCE_SCANNER_ENABLED = false;
const DIVERGENCE_MIN_UNIVERSE_SIZE = Math.max(1, Number(process.env.DIVERGENCE_MIN_UNIVERSE_SIZE) || 500);
const DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE = Math.max(
  100,
  Number(process.env.DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE) || 2000,
);
const DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE = Math.max(
  1,
  Math.min(DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE, Number(process.env.DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE) || 100),
);
const DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE = Math.max(
  DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE,
  Number(process.env.DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE) || 500,
);
const DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE = Math.max(
  1,
  Number(process.env.DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE) || 25,
);
const DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS = Math.max(28, Number(process.env.DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS) || 50);
const DIVERGENCE_FETCH_TICKER_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.DIVERGENCE_FETCH_TICKER_TIMEOUT_MS) || 60_000,
);
const DIVERGENCE_FETCH_MA_TIMEOUT_MS = Math.max(5_000, Number(process.env.DIVERGENCE_FETCH_MA_TIMEOUT_MS) || 30_000);
const DIVERGENCE_STALL_TIMEOUT_MS = Math.max(30_000, Number(process.env.DIVERGENCE_STALL_TIMEOUT_MS) || 90_000);
const DIVERGENCE_STALL_CHECK_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.DIVERGENCE_STALL_CHECK_INTERVAL_MS) || 2_000,
);
const DIVERGENCE_STALL_RETRY_BASE_MS = Math.max(1_000, Number(process.env.DIVERGENCE_STALL_RETRY_BASE_MS) || 5_000);
const DIVERGENCE_STALL_MAX_RETRIES = Math.max(0, Math.floor(Number(process.env.DIVERGENCE_STALL_MAX_RETRIES) || 3));

// In-memory cache of daily OHLC bars populated during daily/weekly scans.
// Key: uppercase ticker, Value: array of { time, open, high, low, close }.
const MINI_BARS_CACHE_MAX_TICKERS = 2000;
const miniBarsCacheByTicker = new LRUCache({ max: MINI_BARS_CACHE_MAX_TICKERS });

async function persistMiniChartBars(ticker: any, bars: any) {
  if (!divergencePool || !ticker || !Array.isArray(bars) || bars.length === 0) return;
  try {
    const values: any[] = [];
    const placeholders = [];
    let idx = 1;
    for (const b of bars) {
      const tradeDate = etDateStringFromUnixSeconds(Number(b.time));
      if (!tradeDate) continue;
      placeholders.push(`($${idx},$${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5},$${idx + 6})`);
      values.push(ticker, tradeDate, Number(b.open), Number(b.high), Number(b.low), Number(b.close), Number(b.time));
      idx += 7;
    }
    if (placeholders.length === 0) return;
    await divergencePool.query(
      `
      INSERT INTO mini_chart_bars(ticker, trade_date, open_price, high_price, low_price, close_price, bar_time)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (ticker, trade_date) DO UPDATE SET
        open_price = EXCLUDED.open_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        close_price = EXCLUDED.close_price,
        bar_time = EXCLUDED.bar_time,
        updated_at = NOW()
    `,
      values,
    );
  } catch (err: any) {
    console.error(`persistMiniChartBars(${ticker}): ${err.message}`);
  }
}

async function loadMiniChartBarsFromDb(ticker: any) {
  if (!divergencePool || !ticker) return [];
  const result = await divergencePool.query(
    `
    SELECT bar_time AS time, open_price AS open, high_price AS high,
           low_price AS low, close_price AS close
    FROM mini_chart_bars
    WHERE ticker = $1
    ORDER BY trade_date ASC
  `,
    [ticker.toUpperCase()],
  );
  return result.rows.map((r) => ({
    time: Number(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

async function loadMiniChartBarsFromDbBatch(tickers: any) {
  if (!divergencePool || !Array.isArray(tickers) || tickers.length === 0) return {};
  const upper = tickers.map((t) => t.toUpperCase());
  const placeholders = upper.map((_, i) => `$${i + 1}`).join(',');
  const result = await divergencePool.query(
    `
    SELECT ticker, bar_time AS time, open_price AS open, high_price AS high,
           low_price AS low, close_price AS close
    FROM mini_chart_bars
    WHERE ticker IN (${placeholders})
    ORDER BY ticker, trade_date ASC
  `,
    upper,
  );
  const grouped: Record<string, any> = {};
  for (const r of result.rows) {
    const t = r.ticker;
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push({
      time: Number(r.time),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    });
  }
  return grouped;
}

async function fetchMiniChartBarsFromApi(ticker: any) {
  if (!ticker) return [];
  try {
    const rows = await dataApiIntradayChartHistory(ticker, '1day', CHART_INTRADAY_LOOKBACK_DAYS);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const dailyBars = convertToLATime(rows, '1day').sort((a, b) => Number(a.time) - Number(b.time));
    const bars = dailyBars.map((b) => ({
      time: Number(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }));
    // Persist to DB and memory for future requests.
    if (bars.length > 0) {
      miniBarsCacheByTicker.set(ticker.toUpperCase(), bars);
      if (divergencePool) {
        persistMiniChartBars(ticker.toUpperCase(), bars).catch(() => {});
      }
    }
    return bars;
  } catch (err: any) {
    console.error(`fetchMiniChartBarsFromApi(${ticker}): ${err.message || err}`);
    return [];
  }
}

let divergenceScanRunning = false;
let divergenceSchedulerTimer: any = null;
let divergenceLastScanDateEt = '';
let divergenceLastFetchedTradeDateEt = '';
let divergenceScanPauseRequested = false;
let divergenceScanStopRequested = false;
let divergenceScanResumeState: any = null;
let divergenceScanAbortController: any = null;
let divergenceTableBuildRunning = false;
let divergenceTableBuildPauseRequested = false;
let divergenceTableBuildStopRequested = false;
let divergenceTableBuildResumeState: any = null;
let divergenceTableBuildAbortController: any = null;
let divergenceTableBuildStatus = {
  running: false,
  status: 'idle',
  totalTickers: 0,
  processedTickers: 0,
  errorTickers: 0,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  lastPublishedTradeDate: '',
};
// Fetch Daily and Weekly use ScanState with resume normalizers (set after function definitions below)
const fetchDailyScan = new ScanState('fetchDaily', { metricsKey: 'fetchDaily' });
const fetchWeeklyScan = new ScanState('fetchWeekly', { metricsKey: 'fetchWeekly' });

const RUN_METRICS_SAMPLE_CAP = Math.max(100, Number(process.env.RUN_METRICS_SAMPLE_CAP) || 1200);
const RUN_METRICS_HISTORY_LIMIT = Math.max(10, Number(process.env.RUN_METRICS_HISTORY_LIMIT) || 40);
const runMetricsByType: Record<string, any> = {
  fetchDaily: null,
  fetchWeekly: null,
  vdfScan: null,
};
const runMetricsHistory: any[] = [];

function clampMetricNumber(value: any, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** Math.max(0, Number(digits) || 0);
  return Math.round(numeric * factor) / factor;
}

function percentileFromSortedSamples(samples: any, percentile: any) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const p = Math.max(0, Math.min(1, Number(percentile) || 0));
  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * p) - 1));
  const value = Number(samples[index]);
  return Number.isFinite(value) ? value : 0;
}

function summarizeRunMetrics(metrics: any) {
  if (!metrics || typeof metrics !== 'object') return null;
  const samples = Array.isArray(metrics.api?.latencySamples)
    ? [...metrics.api.latencySamples].sort((a, b) => a - b)
    : [];
  const calls = Number(metrics.api?.calls || 0);
  const avgLatencyMs = calls > 0 ? clampMetricNumber(Number(metrics.api?.totalLatencyMs || 0) / calls, 2) : 0;
  const startedMs = Date.parse(String(metrics.startedAt || ''));
  const finishedMs = Date.parse(String(metrics.finishedAt || metrics.updatedAt || ''));
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs ? finishedMs - startedMs : 0;
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
      processedPerSecond: durationSeconds > 0 ? clampMetricNumber(processed / durationSeconds, 3) : 0,
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
      p50LatencyMs: clampMetricNumber(percentileFromSortedSamples(samples, 0.5), 2),
      p95LatencyMs: clampMetricNumber(percentileFromSortedSamples(samples, 0.95), 2),
    },
    db: {
      flushCount: Number(metrics.db?.flushCount || 0),
      dailyRows: Number(metrics.db?.dailyRows || 0),
      summaryRows: Number(metrics.db?.summaryRows || 0),
      signalRows: Number(metrics.db?.signalRows || 0),
      neutralRows: Number(metrics.db?.neutralRows || 0),
      avgFlushMs:
        Number(metrics.db?.flushCount || 0) > 0
          ? clampMetricNumber(Number(metrics.db?.totalFlushMs || 0) / Number(metrics.db?.flushCount || 1), 2)
          : 0,
      maxFlushMs: clampMetricNumber(Number(metrics.db?.maxFlushMs || 0), 2),
    },
    stalls: {
      retries: Number(metrics.stalls?.retries || 0),
      watchdogAborts: Number(metrics.stalls?.watchdogAborts || 0),
    },
    failedTickers: Array.isArray(metrics.failedTickers) ? [...metrics.failedTickers] : [],
    retryRecovered: Array.isArray(metrics.retryRecovered) ? [...metrics.retryRecovered] : [],
    meta: metrics.meta || {},
  };
}

function pushRunMetricsHistory(snapshot: any) {
  if (!snapshot) return;
  runMetricsHistory.unshift(snapshot);
  if (runMetricsHistory.length > RUN_METRICS_HISTORY_LIMIT) {
    runMetricsHistory.length = RUN_METRICS_HISTORY_LIMIT;
  }
  persistRunSnapshotToDb(snapshot);
}

const RUN_METRICS_DB_LIMIT = 15;

function persistRunSnapshotToDb(snapshot: any) {
  if (!snapshot || !snapshot.runId) return;
  pool
    .query(
      `INSERT INTO run_metrics_history (run_id, run_type, status, snapshot, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id) DO UPDATE SET status = $3, snapshot = $4, finished_at = $6`,
      [
        snapshot.runId,
        snapshot.runType || 'unknown',
        snapshot.status || 'unknown',
        JSON.stringify(snapshot),
        snapshot.startedAt || null,
        snapshot.finishedAt || null,
      ],
    )
    .then(() => {
      // Prune old rows beyond the limit
      return pool.query(
        `DELETE FROM run_metrics_history WHERE id NOT IN (
         SELECT id FROM run_metrics_history ORDER BY created_at DESC LIMIT $1
       )`,
        [RUN_METRICS_DB_LIMIT],
      );
    })
    .catch((err) => {
      console.error('Failed to persist run snapshot:', err.message);
    });
}

async function loadRunHistoryFromDb() {
  try {
    const result = await pool.query(`SELECT snapshot FROM run_metrics_history ORDER BY created_at DESC LIMIT $1`, [
      RUN_METRICS_DB_LIMIT,
    ]);
    return result.rows.map((r) => r.snapshot);
  } catch (err: any) {
    console.error('Failed to load run history from DB:', err.message);
    return [];
  }
}

function createRunMetricsTracker(runType: any, meta = {}) {
  const normalizedType = String(runType || '').trim() || 'unknown';
  const runId = `${normalizedType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const metrics = {
    runId,
    runType: normalizedType,
    status: 'running',
    phase: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: null as string | null,
    updatedAt: new Date().toISOString(),
    tickers: {
      total: 0,
      processed: 0,
      errors: 0,
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
      latencySamples: [] as number[],
    },
    db: {
      flushCount: 0,
      totalFlushMs: 0,
      maxFlushMs: 0,
      dailyRows: 0,
      summaryRows: 0,
      signalRows: 0,
      neutralRows: 0,
    },
    stalls: {
      retries: 0,
      watchdogAborts: 0,
    },
    failedTickers: [] as string[],
    retryRecovered: [] as string[],
    meta: {
      ...meta,
    },
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
    setPhase(phase: any) {
      metrics.phase = String(phase || '').trim() || metrics.phase;
      touch();
    },
    setTotals(totalTickers: any) {
      metrics.tickers.total = Math.max(0, Number(totalTickers) || 0);
      touch();
    },
    setProgress(processedTickers: any, errorTickers: any) {
      metrics.tickers.processed = Math.max(0, Number(processedTickers) || 0);
      metrics.tickers.errors = Math.max(0, Number(errorTickers) || 0);
      touch();
    },
    recordApiCall(details: any = {}) {
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
    recordDbFlush(details: any = {}) {
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
    recordFailedTicker(ticker: any) {
      const name = String(ticker || '')
        .trim()
        .toUpperCase();
      if (name && metrics.failedTickers.length < 500) {
        metrics.failedTickers.push(name);
      }
      touch();
    },
    recordRetryRecovered(ticker: any) {
      const name = String(ticker || '')
        .trim()
        .toUpperCase();
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
    finish(status: any, patch: any = {}) {
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
    },
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
      dataApiBase: String(process.env.DATA_API_BASE || 'https://api.massive.com'),
      dataApiTimeoutMs: Number(process.env.DATA_API_TIMEOUT_MS) || 15000,
      dataApiMaxRequestsPerSecond: Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99,
      dataApiRateBucketCapacity: Number(process.env.DATA_API_RATE_BUCKET_CAPACITY) || Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99,
    },
    statuses: {
      fetchDaily: fetchDailyScan.getStatus(),
      fetchWeekly: fetchWeeklyScan.getStatus(),
      scan: getDivergenceScanControlStatus(),
      table: getDivergenceTableBuildStatus(),
      vdfScan: vdfScan.getStatus(),
    },
    runs: {
      fetchDaily: summarizeRunMetrics(runMetricsByType.fetchDaily),
      fetchWeekly: summarizeRunMetrics(runMetricsByType.fetchWeekly),
      vdfScan: summarizeRunMetrics(runMetricsByType.vdfScan),
    },
    history: runMetricsHistory.slice(0, RUN_METRICS_HISTORY_LIMIT),
  };
}

function isDivergenceConfigured() {
  return Boolean(divergencePool);
}

async function withDivergenceClient(fn: any) {
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

    // Attempt to add new columns if they don't exist.
    // Column definitions are a hardcoded allowlist — never derived from user input.
    const columnMigrations = [
      { name: 'timeframe', definition: 'VARCHAR(10)' },
      { name: 'signal_direction', definition: 'INTEGER' },
      { name: 'signal_volume', definition: 'INTEGER' },
      { name: 'intensity_score', definition: 'INTEGER' },
      { name: 'combo_score', definition: 'INTEGER' },
      { name: 'is_favorite', definition: 'BOOLEAN DEFAULT FALSE' },
    ];
    const safeIdentifier = /^[a-z_][a-z0-9_]{0,62}$/;
    await Promise.allSettled(
      columnMigrations.map(({ name, definition }) => {
        if (!safeIdentifier.test(name)) {
          console.error(`Migration skipped: invalid column name "${name}"`);
          return Promise.resolve();
        }
        const sql = `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "${name}" ${definition}`;
        return pool.query(sql).catch((e) => console.log(`Migration note for ${name}:`, e.message));
      }),
    );
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
    await pool.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_metrics_history_created ON run_metrics_history (created_at DESC)`,
    );

    // Seed in-memory run history from persisted records
    const persisted = await loadRunHistoryFromDb();
    if (persisted.length > 0) {
      runMetricsHistory.push(...persisted);
      console.log(`Loaded ${persisted.length} persisted run history entries`);
    }

    console.log('Database initialized successfully');
  } catch (err: any) {
    console.error('Failed to initialize database:', err);
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
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS mini_chart_bars (
        ticker VARCHAR(20) NOT NULL,
        trade_date DATE NOT NULL,
        open_price DOUBLE PRECISION NOT NULL,
        high_price DOUBLE PRECISION NOT NULL,
        low_price DOUBLE PRECISION NOT NULL,
        close_price DOUBLE PRECISION NOT NULL,
        bar_time BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
      const pubResult = await divergencePool.query(
        `
        SELECT published_trade_date::text AS trade_date
        FROM divergence_publication_state
        WHERE source_interval = $1
        LIMIT 1
      `,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      const restoredTradeDate = String(pubResult.rows[0]?.trade_date || '').trim();
      if (restoredTradeDate) {
        divergenceLastFetchedTradeDateEt = maxEtDateString(divergenceLastFetchedTradeDateEt, restoredTradeDate);
        fetchDailyScan._status.lastPublishedTradeDate = maxEtDateString(
          fetchDailyScan._status.lastPublishedTradeDate,
          restoredTradeDate,
        );
        fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate });
      }

      const weeklyResult = await divergencePool.query(
        `
        SELECT MAX(trade_date)::text AS trade_date
        FROM divergence_signals
        WHERE timeframe = '1w'
          AND source_interval = $1
      `,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      const restoredWeeklyDate = String(weeklyResult.rows[0]?.trade_date || '').trim();
      if (restoredWeeklyDate) {
        fetchWeeklyScan._status.lastPublishedTradeDate = maxEtDateString(
          fetchWeeklyScan._status.lastPublishedTradeDate,
          restoredWeeklyDate,
        );
        fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan._status.lastPublishedTradeDate });
      }
      if (restoredTradeDate || restoredWeeklyDate) {
        console.log(
          `Restored trade dates from DB — daily: ${restoredTradeDate || '(none)'}, weekly: ${restoredWeeklyDate || '(none)'}`,
        );
      }
    } catch (restoreErr: any) {
      console.error('Failed to restore trade dates from DB:', restoreErr.message);
    }

    console.log('Divergence database initialized successfully');
  } catch (err: any) {
    console.error('Failed to initialize divergence database:', err);
  }
};

app.get('/api/alerts', async (req, res) => {
  try {
    const days = parseInt(String(req.query.days)) || 0;
    const startDate = String(req.query.start_date || '').trim();
    const endDate = String(req.query.end_date || '').trim();
    const hasDateKeyRange = /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate);

    let query = 'SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100';
    let values: any[] = [];

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
    const tickers = Array.from(
      new Set(
        result.rows
          .map((row) =>
            String(row?.ticker || '')
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      ),
    );
    let summariesByTicker = new Map();
    try {
      summariesByTicker = await getStoredDivergenceSummariesForTickers(tickers, sourceInterval, {
        includeLatestFallbackForMissing: true,
      });
    } catch (summaryErr: any) {
      const message = summaryErr && summaryErr.message ? summaryErr.message : String(summaryErr);
      console.error(`Failed to enrich TV alerts with divergence summaries: ${message}`);
    }
    const neutralStates = buildNeutralDivergenceStateMap();
    let vdfDataMapTv = new Map();
    try {
      if (tickers.length > 0 && isDivergenceConfigured()) {
        const vdfTradeDate = currentEtDateString();
        const vdfRes = await divergencePool!.query(
          `SELECT ticker, best_zone_score, proximity_level, num_zones FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
          [vdfTradeDate, tickers],
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
      const ticker = String(row?.ticker || '')
        .trim()
        .toUpperCase();
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
          sma200: Boolean(summary?.maStates?.sma200),
        },
        divergence_states: {
          1: String(states['1'] || 'neutral'),
          3: String(states['3'] || 'neutral'),
          7: String(states['7'] || 'neutral'),
          14: String(states['14'] || 'neutral'),
          28: String(states['28'] || 'neutral'),
        },
        vdf_detected: !!vdfData,
        vdf_score: vdfData?.score || 0,
        vdf_proximity: vdfData?.proximityLevel || 'none',
      };
    });
    res.json(enrichedRows);
  } catch (err: any) {
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
  } catch (err: any) {
    console.error('Error toggling favorite:', err);
    res.status(500).send('Server Error');
  }
});

app.get('/api/divergence/signals', async (req, res) => {
  if (!isDivergenceConfigured()) {
    return res.status(503).json({ error: 'Divergence database is not configured' });
  }
  try {
    const days = parseInt(String(req.query.days)) || 0;
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
      values = [
        startTradeDate,
        endTradeDate,
        publishedTradeDate || null,
        PER_TIMEFRAME_SIGNAL_LIMIT,
        allowedTimeframes,
      ];
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

    const result = await divergencePool!.query(query, values);
    const sourceInterval = toVolumeDeltaSourceInterval(req.query.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
    const tickers = Array.from(
      new Set(
        result.rows
          .map((row) =>
            String(row?.ticker || '')
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      ),
    );
    let summariesByTicker = new Map();
    try {
      summariesByTicker = await getStoredDivergenceSummariesForTickers(tickers, sourceInterval, {
        includeLatestFallbackForMissing: true,
      });
    } catch (summaryErr: any) {
      const message = summaryErr && summaryErr.message ? summaryErr.message : String(summaryErr);
      console.error(`Failed to enrich divergence signals with divergence summaries: ${message}`);
    }
    const neutralStates = buildNeutralDivergenceStateMap();
    // Enrich with VDF detection results
    let vdfDataMap = new Map();
    try {
      if (tickers.length > 0) {
        const vdfTradeDate = currentEtDateString();
        const vdfRes = await divergencePool!.query(
          `SELECT ticker, best_zone_score, proximity_level, num_zones FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
          [vdfTradeDate, tickers],
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
      const ticker = String(row?.ticker || '')
        .trim()
        .toUpperCase();
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
          sma200: Boolean(summary?.maStates?.sma200),
        },
        divergence_states: {
          1: String(states['1'] || 'neutral'),
          3: String(states['3'] || 'neutral'),
          7: String(states['7'] || 'neutral'),
          14: String(states['14'] || 'neutral'),
          28: String(states['28'] || 'neutral'),
        },
        vdf_detected: !!vdfData,
        vdf_score: vdfData?.score || 0,
        vdf_proximity: vdfData?.proximityLevel || 'none',
      };
    });
    res.json(enrichedRows);
  } catch (err: any) {
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
    const result = await divergencePool!.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Signal not found' });
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('Error toggling divergence favorite:', err);
    res.status(500).json({ error: 'Server Error' });
  }
});

app.get('/api/breadth', async (req, res) => {
  const compTicker = (req.query.ticker || 'SVIX').toString().toUpperCase();
  const days = Math.min(Math.max(parseInt(String(req.query.days)) || 5, 1), 60);
  const isIntraday = days <= 30;

  try {
    if (isIntraday) {
      // --- Intraday path (30-min bars) ---
      const lookbackDays = Math.max(14, days * 3);
      const [spyBars, compBars] = await Promise.all([
        getSpyIntraday(lookbackDays),
        dataApiIntradayChartHistory(compTicker, '30min', lookbackDays),
      ]);

      if (!spyBars || !compBars) {
        return res.status(404).json({ error: 'No intraday data available (market may be closed)' });
      }

      const points = buildIntradayBreadthPoints(spyBars, compBars, days);
      const result = {
        intraday: true,
        points,
      };

      return res.json(result);
    }

    // --- Daily path ---
    const [spyBars, compBars] = await Promise.all([getSpyDaily(), dataApiDaily(compTicker)]);

    if (!spyBars || !compBars) {
      return res.status(404).json({ error: 'No price data available' });
    }

    const spyMap = new Map();
    for (const bar of spyBars) spyMap.set(bar.date, bar.close);

    const compMap = new Map();
    for (const bar of compBars) compMap.set(bar.date, bar.close);

    const commonDates = [...spyMap.keys()].filter((d) => compMap.has(d)).sort();

    const allPoints = commonDates.slice(-30).map((d) => ({
      date: d,
      spy: Math.round(spyMap.get(d) * 100) / 100,
      comparison: Math.round(compMap.get(d) * 100) / 100,
    }));

    const points = allPoints.slice(-days);
    res.json({ intraday: false, points });
  } catch (err: any) {
    console.error('Breadth API Error:', err);
    res.status(500).json({ error: 'Failed to fetch breadth data' });
  }
});

// --- Chart pre-warming (extracted to server/services/chartPrewarm.js) ---
const prewarmDeps = {
  getOrBuildChartResult: (params: any) => getOrBuildChartResult(params),
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

function parseChartRequestParams(req: any) {
  const ticker = (req.query.ticker || 'SPY').toString().toUpperCase();
  if (!isValidTickerSymbol(ticker)) {
    const err = new Error('Invalid ticker format');
    (err as any).httpStatus = 400;
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
    lookbackDays,
  });
  return {
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
    requestKey,
  };
}

async function getOrBuildChartResult(params: any) {
  const {
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
    requestKey,
    skipFollowUpPrewarm = false,
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
        lookbackDays,
      });
    }
    if (CHART_TIMING_LOG_ENABLED) {
      console.log(`[chart-cache] ${ticker} ${interval} hit key=${requestKey}`);
    }
    return {
      result: cachedFinalResult.value,
      serverTiming: 'cache_hit;dur=0.1,total;dur=0.1',
      cacheHit: true,
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
    if (CHART_IN_FLIGHT_REQUESTS.size >= CHART_IN_FLIGHT_MAX) {
      const err = new Error('Server is busy processing chart requests, please retry shortly');
      (err as any).httpStatus = 503;
      throw err;
    }
    buildPromise = (async () => {
      const timer = createChartStageTimer();
      const requiredIntervals = Array.from(new Set([interval, vdSourceInterval, vdRsiSourceInterval]));
      const rowsByInterval = new Map();
      const quotePromise = dataApiLatestQuote(ticker).catch((err) => {
        const message = err && err.message ? err.message : String(err);
        if (CHART_TIMING_LOG_ENABLED) {
          console.warn(`[chart-quote] ${ticker} ${interval} skipped: ${message}`);
        }
        return null;
      });
      await Promise.all(
        requiredIntervals.map(async (tf) => {
          const rows = await dataApiIntradayChartHistory(ticker, tf, lookbackDays);
          rowsByInterval.set(tf, rows || []);
        }),
      );
      timer.step('fetch_rows');

      const result = buildChartResultFromRows({
        ticker,
        interval,
        rowsByInterval,
        vdRsiLength,
        vdSourceInterval,
        vdRsiSourceInterval,
        timer,
      });
      const quote = await quotePromise;
      patchLatestBarCloseWithQuote(result, quote);
      if (quote) {
        timer.step('quote_patch');
      }
      setTimedCacheValue(CHART_FINAL_RESULT_CACHE, requestKey, result, getChartResultCacheExpiryMs(new Date()));
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
          lookbackDays,
        });
      }
      const serverTiming = timer.serverTiming();
      if (CHART_TIMING_LOG_ENABLED) {
        console.log(
          `[chart-timing] ${ticker} ${interval} ${isDedupedWait ? 'dedupe-wait' : 'build'} ${timer.summary()}`,
        );
      }
      return { result, serverTiming };
    })();
    CHART_IN_FLIGHT_REQUESTS.set(requestKey, buildPromise);
    buildPromise
      .finally(() => {
        if (CHART_IN_FLIGHT_REQUESTS.get(requestKey) === buildPromise) {
          CHART_IN_FLIGHT_REQUESTS.delete(requestKey);
        }
      })
      .catch(() => {});
  }

  const { result, serverTiming } = await buildPromise;
  if (isDedupedWait && CHART_TIMING_LOG_ENABLED) {
    console.log(`[chart-dedupe] ${ticker} ${interval} request joined in-flight key=${requestKey}`);
  }
  return { result, serverTiming, cacheHit: false };
}

function findPointByTime(points: any, timeValue: any) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const key = String(timeValue);
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    if (!point || String(point.time) !== key) continue;
    return point;
  }
  return null;
}

function extractLatestChartPayload(result: any) {
  const bars = Array.isArray(result?.bars) ? result.bars : [];
  const latestBar = bars.length ? bars[bars.length - 1] : null;
  const latestTime = latestBar ? latestBar.time : null;
  const latestRsi = latestTime === null ? null : findPointByTime(result?.rsi, latestTime);
  const latestVolumeDeltaRsi = latestTime === null ? null : findPointByTime(result?.volumeDeltaRsi?.rsi, latestTime);
  const latestVolumeDelta = latestTime === null ? null : findPointByTime(result?.volumeDelta, latestTime);

  return {
    interval: result.interval,
    timezone: result?.timezone || 'America/Los_Angeles',
    latestBar,
    latestRsi,
    latestVolumeDeltaRsi,
    latestVolumeDelta,
  };
}

function buildNeutralDivergenceStates() {
  const states: Record<string, any> = {};
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    states[String(days)] = 'neutral';
  }
  return states;
}

function computeDivergenceSummaryStatesFromDailyResult(result: any, options: any = {}) {
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
      tradeDate: '',
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
    tradeDate: pacificDateStringFromUnixSeconds(latestUnix),
  };
}

function getDivergenceSummaryCacheKey(ticker: any, sourceInterval: any) {
  return `${String(ticker || '').toUpperCase()}|${String(sourceInterval || '1min')}`;
}

function getCachedDivergenceSummaryEntry(ticker: any, sourceInterval: any) {
  return null;
}

function setDivergenceSummaryCacheEntry(entry: any) {
  return;
}

function clearDivergenceSummaryCacheForSourceInterval(sourceInterval: any) {
  return;
}

function normalizeDivergenceState(value: any) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'bullish' || normalized === 'bearish') return normalized;
  return 'neutral';
}

function normalizeSummaryMaState(value: any) {
  if (value === true) return true;
  if (value === false) return false;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric === 1) return true;
    if (numeric === 0) return false;
  }
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return false;
}

function buildDivergenceSummaryEntryFromRow(row: any, sourceInterval: any, nowMs: any, expiresAtMs: any) {
  const ticker = String(row?.ticker || '').toUpperCase();
  if (!ticker) return null;
  const entry = {
    ticker,
    sourceInterval,
    tradeDate: String(row?.trade_date || '').trim() || null,
    states: {
      1: normalizeDivergenceState(row?.state_1d),
      3: normalizeDivergenceState(row?.state_3d),
      7: normalizeDivergenceState(row?.state_7d),
      14: normalizeDivergenceState(row?.state_14d),
      28: normalizeDivergenceState(row?.state_28d),
    },
    maStates: {
      ema8: normalizeSummaryMaState(row?.ma8_above),
      ema21: normalizeSummaryMaState(row?.ma21_above),
      sma50: normalizeSummaryMaState(row?.ma50_above),
      sma200: normalizeSummaryMaState(row?.ma200_above),
    },
    computedAtMs: nowMs,
    expiresAtMs,
  };
  setDivergenceSummaryCacheEntry(entry);
  return entry;
}

async function getStoredDivergenceSummariesForTickers(tickers: any, sourceInterval: any, options: any = {}) {
  const map = new Map();
  if (!divergencePool || !Array.isArray(tickers) || tickers.length === 0) {
    return map;
  }
  const includeLatestFallbackForMissing = options.includeLatestFallbackForMissing !== false;

  const normalizedTickers = Array.from(
    new Set(
      tickers
        .map((ticker) => String(ticker || '').toUpperCase())
        .filter((ticker) => ticker && isValidTickerSymbol(ticker)),
    ),
  );
  if (!normalizedTickers.length) {
    return map;
  }

  const nowMs = Date.now();
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));
  const result = await divergencePool.query(
    `
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
  `,
    [sourceInterval, normalizedTickers],
  );

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

async function mapWithConcurrency(items: any, concurrency: any, worker: any, onSettled?: any, shouldStop?: any) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const maxConcurrency = Math.max(1, Math.min(list.length, Number(concurrency) || 1));
  const results = new Array(list.length);
  let cursor = 0;
  let cancelled = false;
  let cancelResolve: any = null;
  const cancelPromise = new Promise((resolve) => {
    cancelResolve = resolve;
  });

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
      } catch (err: any) {
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
  const maxRps = Math.max(1, Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99);
  const estimatedApiCallsPerTicker = runType === 'fetch-weekly' ? 10 : 8;
  const targetTickersPerSecond = Math.max(1, Math.floor(maxRps / estimatedApiCallsPerTicker));
  const adaptive = Math.max(4, targetTickersPerSecond * 4);
  return Math.max(1, Math.min(configured, adaptive));
}

async function buildDailyDivergenceSummaryInput(options: any = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const lookbackDays = Math.max(1, Math.floor(Number(options.lookbackDays) || getIntradayLookbackDays('1day')));
  if (!ticker) {
    return { bars: [], volumeDelta: [] };
  }

  const parentFetchInterval = '1day';
  const requiredIntervals = Array.from(new Set([parentFetchInterval, vdSourceInterval]));
  const rowsByInterval = new Map();
  await Promise.all(
    requiredIntervals.map(async (tf) => {
      const rows = await dataApiIntradayChartHistory(ticker, tf, lookbackDays);
      rowsByInterval.set(tf, rows || []);
    }),
  );

  const parentRows = rowsByInterval.get(parentFetchInterval) || [];
  if (!Array.isArray(parentRows) || parentRows.length === 0) {
    return { bars: [], volumeDelta: [] };
  }

  const dailyBars = convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return { bars: [], volumeDelta: [] };
  }

  const sourceRows = rowsByInterval.get(vdSourceInterval) || [];
  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], vdSourceInterval).sort((a, b) => Number(a.time) - Number(b.time)),
  );
  const volumeDelta = computeVolumeDeltaByParentBars(dailyBars, sourceBars, '1day').map((point) => ({
    time: point.time,
    delta: Number.isFinite(Number(point?.delta)) ? Number(point.delta) : 0,
  }));
  return {
    bars: dailyBars,
    volumeDelta,
  };
}

async function persistOnDemandTickerDivergenceSummary(options: any = {}) {
  if (!divergencePool) return;
  const entry = options.entry || null;
  const latestDailyBar = options.latestDailyBar || null;
  if (!entry || !entry.ticker || !entry.sourceInterval) return;

  if (latestDailyBar && latestDailyBar.trade_date) {
    await upsertDivergenceDailyBarsBatch([latestDailyBar], null);
  }
  if (entry.tradeDate) {
    await upsertDivergenceSummaryBatch(
      [
        {
          ticker: entry.ticker,
          source_interval: entry.sourceInterval,
          trade_date: entry.tradeDate,
          states: entry.states,
          ma_states: entry.maStates || null,
        },
      ],
      null,
    );
  }
}

async function getOrBuildTickerDivergenceSummary(options: any = {}) {
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
    noCache: true,
  });
  const filteredRows = Array.isArray(dailyRows)
    ? dailyRows.filter((row) => row.trade_date && row.trade_date <= asOfTradeDate)
    : [];
  const latestDailyBar = filteredRows.length > 0 ? filteredRows[filteredRows.length - 1] : null;
  const states =
    filteredRows.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filteredRows) : buildNeutralDivergenceStateMap();
  const tradeDate = String(latestDailyBar?.trade_date || asOfTradeDate || '').trim() || null;
  const entry = {
    ticker,
    sourceInterval: vdSourceInterval,
    tradeDate,
    states,
    computedAtMs: nowMs,
    expiresAtMs: nextPacificDivergenceRefreshUtcMs(new Date(nowMs)),
  };
  if (persistToDatabase) {
    try {
      await persistOnDemandTickerDivergenceSummary({
        entry,
        latestDailyBar,
      });

      // Return the value as stored in DB (single source of truth).
      const storedMap = await getStoredDivergenceSummariesForTickers([ticker], vdSourceInterval);
      const stored = storedMap.get(ticker);
      if (stored) return stored;
    } catch (err: any) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Failed to persist on-demand divergence summary for ${ticker}: ${message}`);
    }
  }
  return entry;
}

async function getDivergenceSummaryForTickers(options: any = {}) {
  const tickers = Array.isArray(options.tickers)
    ? options.tickers
        .map((ticker: any) => String(ticker || '').toUpperCase())
        .filter((ticker: any) => ticker && isValidTickerSymbol(ticker))
    : [];
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  if (tickers.length === 0) {
    return {
      sourceInterval: vdSourceInterval,
      refreshedAt: new Date().toISOString(),
      summaries: [],
    };
  }

  const uniqueTickers = Array.from(new Set(tickers));
  const forceRefresh = Boolean(options.forceRefresh);
  if (forceRefresh) {
    await mapWithConcurrency(
      uniqueTickers,
      8,
      async (ticker: any) => {
        await getOrBuildTickerDivergenceSummary({
          ticker,
          vdSourceInterval,
          forceRefresh: true,
          persistToDatabase: true,
        });
      },
      (result: any, _index: any, ticker: any) => {
        if (result && result.error) {
          const message = result.error && result.error.message ? result.error.message : String(result.error);
          console.error(`Failed to force-refresh divergence summary for ${ticker}: ${message}`);
        }
      },
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
        sma200: false,
      },
      computedAtMs: nowMs,
      expiresAtMs,
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
      expiresAtMs: entry.expiresAtMs,
    })),
  };
}

// --- VDF (Volume Divergence Flag) Detector helpers ---
let vdfRunningTickers = new Set();

async function getStoredVDFResult(ticker: any, tradeDate: any) {
  if (!isDivergenceConfigured()) return null;
  try {
    const { rows } = await divergencePool!.query(
      `SELECT is_detected, composite_score, status, weeks, result_json,
              best_zone_score, proximity_score, proximity_level, num_zones, has_distribution
       FROM vdf_results WHERE ticker = $1 AND trade_date = $2 LIMIT 1`,
      [ticker, tradeDate],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    let parsed: any = {};
    try {
      parsed = row.result_json ? JSON.parse(row.result_json) : {};
    } catch {
      /* ignore */
    }
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
      details: parsed,
    };
  } catch (err: any) {
    console.error('getStoredVDFResult error:', err && err.message ? err.message : err);
    return null;
  }
}

async function upsertVDFResult(ticker: any, tradeDate: any, result: any) {
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
    await divergencePool!.query(
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
        ticker,
        tradeDate,
        result.detected || false,
        bestScore,
        result.status || '',
        result.bestZoneWeeks || result.weeks || 0,
        resultJson,
        bestScore,
        proxScore,
        proxLevel,
        numZones,
        hasDist,
      ],
    );
  } catch (err: any) {
    console.error('upsertVDFResult error:', err && err.message ? err.message : err);
  }
}

async function getVDFStatus(ticker: any, options: any = {}) {
  const force = options.force === true;
  const signal = options.signal || null;
  const noCache = options.noCache === true;
  const mode = options.mode || 'scan'; // 'chart' = 1yr overlays + 3mo scoring, 'scan' = 3mo only
  const today = currentEtDateString();

  // Check DB cache (same trading day) unless force
  if (!force) {
    const cached = await getStoredVDFResult(ticker, today);
    if (cached) return { ...cached, cached: true };
  }

  // Prevent parallel detection for the same ticker
  if (vdfRunningTickers.has(ticker)) {
    return {
      is_detected: false,
      composite_score: 0,
      status: 'Detection in progress',
      weeks: 0,
      best_zone_score: 0,
      proximity_score: 0,
      proximity_level: 'none',
      num_zones: 0,
      has_distribution: false,
      zones: [],
      distribution: [],
      proximity: { compositeScore: 0, level: 'none', signals: [] },
      cached: false,
    };
  }
  vdfRunningTickers.add(ticker);

  try {
    const fetcher = noCache
      ? (sym: any, intv: any, days: any, opts: any) => dataApiIntradayChartHistory(sym, intv, days, { ...opts, noCache: true })
      : dataApiIntradayChartHistory;
    const result = await detectVDF(ticker, {
      dataApiFetcher: fetcher,
      signal,
      mode,
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
      allZones: result.allZones || result.zones || [],
      distribution: result.distribution || [],
      proximity: result.proximity || { compositeScore: 0, level: 'none', signals: [] },
      details: { metrics: result.metrics, reason: result.reason },
      cached: false,
    };
  } finally {
    vdfRunningTickers.delete(ticker);
  }
}

// --- VDF Scan (bulk) state ---
const vdfScan = new ScanState('vdfScan', { metricsKey: 'vdfScan' });

async function runVDFScan(options: any = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (vdfScan.running) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const rs = resumeRequested ? vdfScan.resumeState : null;
  if (
    resumeRequested &&
    (!rs || !Array.isArray(rs.tickers) || rs.tickers.length === 0 || rs.nextIndex >= rs.tickers.length)
  ) {
    return { status: 'no-resume' };
  }

  const scanAbort = vdfScan.beginRun(resumeRequested);
  runMetricsByType.vdfScan = null;

  let processedTickers = Math.max(0, Number(rs?.processedTickers || 0));
  let errorTickers = Math.max(0, Number(rs?.errorTickers || 0));
  let detectedTickers = Math.max(0, Number(rs?.detectedTickers || 0));
  let totalTickers = Math.max(0, Number(rs?.totalTickers || 0));
  const startedAtIso = new Date().toISOString();
  const failedTickers: any[] = [];
  let tickers = rs?.tickers || [];
  let startIndex = Math.max(0, Number(rs?.nextIndex || 0));

  vdfScan.setStatus({
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
  });
  vdfScan.setExtraStatus({ detected_tickers: detectedTickers });

  // VDF scan: each ticker fetches 220 days of 1-min data (~8 API slices each),
  // creating massive memory pressure. Cap concurrency at 3 to prevent OOM.
  // The adaptive calculator was producing 11+ which caused ~9GB cache buildup.
  const runConcurrency = Math.min(3, resolveAdaptiveFetchConcurrency('vdf-scan'));
  let runMetricsTracker: any = null;

  const syncExtra = () => vdfScan.setExtraStatus({ detected_tickers: detectedTickers });
  const buildStatusFields = (proc?: any) => ({
    totalTickers,
    processedTickers: proc ?? processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
  });

  const vdfWorker = async (ticker: any) => {
    if (vdfScan.shouldStop) return { ticker, skipped: true };
    const apiStart = Date.now();
    try {
      const result = await getVDFStatus(ticker, { force: true, noCache: true, signal: scanAbort.signal });
      const latencyMs = Date.now() - apiStart;
      if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: true });
      return { ticker, result, error: null };
    } catch (err: any) {
      const latencyMs = Date.now() - apiStart;
      if (runMetricsTracker) runMetricsTracker.recordApiCall({ latencyMs, ok: false });
      return { ticker, result: null, error: err };
    }
  };

  try {
    sweepExpiredTimedCache(CHART_DATA_CACHE);

    if (!resumeRequested) {
      tickers = await getStoredDivergenceSymbolTickers();
      startIndex = 0;
      processedTickers = 0;
      errorTickers = 0;
      detectedTickers = 0;
    }

    totalTickers = tickers.length;
    vdfScan.setStatus({ totalTickers });
    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;
    console.log(
      `VDF scan${resumeRequested ? ' (resumed)' : ''}: ${totalTickers} tickers (starting at ${startIndex}), concurrency=${runConcurrency}, noCache=true`,
    );

    runMetricsTracker = createRunMetricsTracker('vdfScan', { totalTickers, concurrency: runConcurrency });
    runMetricsTracker.setTotals(totalTickers);
    runMetricsTracker.setPhase('core');

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      vdfWorker,
      (settled: any) => {
        if (settled.skipped) return;
        settledCount++;
        processedTickers = startIndex + settledCount;
        if (settled.error) {
          errorTickers++;
          failedTickers.push(settled.ticker);
          if (!(vdfScan.stopRequested && isAbortError(settled.error))) {
            console.error(`VDF scan error for ${settled.ticker}:`, settled.error?.message || settled.error);
          }
        } else if (settled.result && settled.result.is_detected) {
          detectedTickers++;
        }
        vdfScan.updateProgress(processedTickers, errorTickers);
        syncExtra();
        if (processedTickers % 100 === 0) sweepExpiredTimedCache(CHART_DATA_CACHE);
        if (runMetricsTracker) runMetricsTracker.setProgress(processedTickers, errorTickers);
      },
      () => vdfScan.shouldStop,
    );

    if (vdfScan.shouldStop) {
      const safe = vdfScan.saveResumeState(
        { tickers, totalTickers, processedTickers, errorTickers, detectedTickers },
        runConcurrency,
      );
      vdfScan.markStopped(buildStatusFields(safe));
      syncExtra();
      runMetricsTracker?.finish('stopped', { totalTickers, processedTickers: safe, errorTickers, failedTickers });
      return { status: 'stopped', processedTickers: safe, errorTickers, detectedTickers };
    }

    // Retry failed tickers (2 passes via shared helper)
    if (failedTickers.length > 0 && !vdfScan.shouldStop) {
      vdfScan.setStatus({ status: 'running-retry' });
      await runRetryPasses({
        failedTickers,
        baseConcurrency: runConcurrency,
        worker: vdfWorker,
        onRecovered: (settled) => {
          errorTickers--;
          if (settled.result && settled.result.is_detected) detectedTickers++;
          vdfScan.updateProgress(processedTickers, errorTickers);
          syncExtra();
        },
        shouldStop: () => vdfScan.shouldStop,
        metricsTracker: runMetricsTracker,
        mapWithConcurrency,
      });
    }

    vdfScan.markCompleted(buildStatusFields());
    syncExtra();
    const finalStatus = vdfScan.getStatus().status;
    runMetricsTracker?.finish(finalStatus, { totalTickers, processedTickers, errorTickers, failedTickers });
    return { status: finalStatus, processedTickers, errorTickers, detectedTickers };
  } catch (err: any) {
    const message = err && err.message ? err.message : String(err);
    console.error(`VDF scan failed: ${message}`);

    if (vdfScan.stopRequested || isAbortError(err)) {
      const safe = vdfScan.saveResumeState(
        { tickers, totalTickers, processedTickers, errorTickers, detectedTickers },
        runConcurrency,
      );
      vdfScan.markStopped(buildStatusFields(safe));
      syncExtra();
      runMetricsTracker?.finish('stopped', { totalTickers, processedTickers: safe, errorTickers, failedTickers });
      return { status: 'stopped', processedTickers: safe, errorTickers, detectedTickers };
    }

    vdfScan.markFailed(buildStatusFields());
    syncExtra();
    runMetricsTracker?.finish('failed', { totalTickers, processedTickers, errorTickers, failedTickers });
    return { status: 'failed', error: message };
  } finally {
    vdfScan.cleanup(scanAbort);
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
  loadMiniChartBarsFromDb,
  loadMiniChartBarsFromDbBatch,
  fetchMiniChartBarsFromApi,
  getVDFStatus,
});

async function getPublishedTradeDateForSourceInterval(sourceInterval: any) {
  if (!divergencePool) return '';
  const normalizedSource = String(sourceInterval || DIVERGENCE_SOURCE_INTERVAL);
  try {
    const result = await divergencePool.query(
      `
      SELECT published_trade_date::text AS published_trade_date
      FROM divergence_publication_state
      WHERE source_interval = $1
      LIMIT 1
    `,
      [normalizedSource],
    );
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
  } catch (err: any) {
    const message = err && err.message ? err.message : String(err);
    console.error(`Failed to read divergence publication state: ${message}`);
    return '';
  }
}

async function resolveDivergenceAsOfTradeDate(sourceInterval: any, explicitTradeDate = '') {
  const explicit = String(explicitTradeDate || '').trim();
  if (explicit) return explicit;

  const publishedTradeDate = await getPublishedTradeDateForSourceInterval(sourceInterval);
  const fallbackTradeDate = latestCompletedPacificTradeDateKey(new Date()) || currentEtDateString();
  return (
    maxEtDateString(publishedTradeDate, fallbackTradeDate) ||
    fallbackTradeDate ||
    publishedTradeDate ||
    currentEtDateString()
  );
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
    limit: 1000,
  });
  let guard = 0;
  while (nextUrl && guard < 1000) {
    guard += 1;
    const payload = await fetchDataApiJson(nextUrl, 'DataAPI stock universe');
    const pageRows = Array.isArray(payload?.results) ? payload.results : [];
    rows.push(...pageRows);
    nextUrl = typeof payload?.next_url === 'string' && payload.next_url.trim() ? payload.next_url.trim() : '';
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
      assetType: type || null,
    });
  }

  const unique = new Map();
  for (const row of symbols) {
    if (!unique.has(row.ticker)) unique.set(row.ticker, row);
  }
  return Array.from(unique.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function refreshDivergenceSymbolUniverse(options: any = {}) {
  const fullReset = Boolean(options.fullReset);
  const symbols = await fetchUsStockUniverseFromDataApi();
  await withDivergenceClient(async (client: any) => {
    await client.query('BEGIN');
    try {
      if (fullReset) {
        await client.query('UPDATE divergence_symbols SET is_active = FALSE WHERE is_active = TRUE');
      }
      for (const symbol of symbols) {
        await client.query(
          `
          INSERT INTO divergence_symbols(ticker, exchange, asset_type, is_active, updated_at)
          VALUES($1, $2, $3, TRUE, NOW())
          ON CONFLICT (ticker)
          DO UPDATE SET
            exchange = EXCLUDED.exchange,
            asset_type = EXCLUDED.asset_type,
            is_active = TRUE,
            updated_at = NOW()
        `,
          [symbol.ticker, symbol.exchange, symbol.assetType],
        );
      }
      await client.query('COMMIT');
    } catch (err: any) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return symbols.map((s) => s.ticker);
}

async function getDivergenceUniverseTickers(options: any = {}) {
  if (!divergencePool) return [];
  const forceRefresh = Boolean(options.forceRefresh);
  const existing = await divergencePool.query(`
    SELECT ticker
    FROM divergence_symbols
    WHERE is_active = TRUE
    ORDER BY ticker ASC
  `);
  const storedTickers = existing.rows
    .map((row) =>
      String(row.ticker || '')
        .trim()
        .toUpperCase(),
    )
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
  } catch (err: any) {
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
    .map((row) =>
      String(row.ticker || '')
        .trim()
        .toUpperCase(),
    )
    .filter((ticker) => ticker && isValidTickerSymbol(ticker));
}

async function getLatestWeeklySignalTradeDate(sourceInterval: any) {
  if (!divergencePool) return '';
  const normalizedSource = String(sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const result = await divergencePool.query(
    `
    SELECT MAX(trade_date)::text AS trade_date
    FROM divergence_signals
    WHERE timeframe = '1w'
      AND source_interval = $1
  `,
    [normalizedSource],
  );
  return String(result.rows[0]?.trade_date || '').trim();
}

async function computeSymbolDivergenceSignals(ticker: any, options: any = {}) {
  const signal = options && options.signal ? options.signal : null;
  const parentFetchInterval = '1day';
  const [parentRows, sourceRows] = await Promise.all([
    dataApiIntradayChartHistory(ticker, parentFetchInterval, DIVERGENCE_SCAN_LOOKBACK_DAYS, { signal }),
    dataApiIntradayChartHistory(ticker, DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_SCAN_LOOKBACK_DAYS, { signal }),
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) {
    return { signals: [], latestTradeDate: '', dailyBar: null };
  }
  const dailyBars = convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return { signals: [], latestTradeDate: '', dailyBar: null };
  }
  const latestDaily = dailyBars[dailyBars.length - 1];
  const latestTradeDate = etDateStringFromUnixSeconds(Number(latestDaily?.time)) || '';

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], DIVERGENCE_SOURCE_INTERVAL).sort((a, b) => Number(a.time) - Number(b.time)),
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
        volume_delta: latestDelta,
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
        volume_delta: latestDelta,
      });
    }
  }

  return { signals: results, latestTradeDate, dailyBar };
}

async function startDivergenceScanJob(runForDate: any, totalSymbols: any, trigger: any) {
  if (!divergencePool) return null;
  const result = await divergencePool.query(
    `
    INSERT INTO divergence_scan_jobs(run_for_date, status, total_symbols, notes)
    VALUES($1, 'running', $2, $3)
    RETURNING id
  `,
    [runForDate, totalSymbols, `trigger=${trigger}`],
  );
  return Number(result.rows[0]?.id || 0) || null;
}

const SCAN_JOB_ALLOWED_COLUMNS = new Set([
  'status',
  'finished_at',
  'processed_symbols',
  'bullish_count',
  'bearish_count',
  'error_count',
  'notes',
  'scanned_trade_date',
  'total_symbols',
]);

async function updateDivergenceScanJob(jobId: any, patch: any) {
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

async function upsertDivergenceSignalsBatch(signals: any, scanJobId: any) {
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

  await divergencePool.query(
    `
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
  `,
    [tickers, signalTypes, tradeDates, prices, prevCloses, deltas, timeframes, sourceIntervals, scanJobIds],
  );
}

function normalizeOneDaySignalTypeFromState(state: any) {
  const normalized = String(state || '')
    .trim()
    .toLowerCase();
  if (normalized === 'bullish' || normalized === 'bearish') return normalized;
  return '';
}

async function syncOneDaySignalsFromSummaryRows(summaryRows: any, sourceInterval: any, scanJobId = null) {
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
      volume_delta: volumeDelta,
    });
  }

  if (signalRows.length > 0) {
    await upsertDivergenceSignalsBatch(signalRows, scanJobId);
  }

  if (neutralTickers.length > 0) {
    await divergencePool.query(
      `
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
    `,
      [neutralTickers, neutralTradeDates, sourceInterval],
    );
  }
}

async function upsertDivergenceDailyBarsBatch(rows: any, scanJobId: any) {
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
    const sourceInterval =
      String(row?.source_interval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
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

  await divergencePool.query(
    `
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
  `,
    [tickers, tradeDates, sourceIntervals, closes, prevCloses, deltas, scanJobIds],
  );
}

function buildNeutralDivergenceStateMap() {
  const out: Record<string, any> = {};
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    out[String(days)] = 'neutral';
  }
  return out;
}

function classifyDivergenceStateMapFromDailyRows(rows: any) {
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

async function upsertDivergenceSummaryBatch(rows: any, scanJobId: any) {
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
    const sourceInterval =
      String(row?.source_interval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
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
    ma8Above.push(typeof maStates.ema8 === 'boolean' ? maStates.ema8 : null);
    ma21Above.push(typeof maStates.ema21 === 'boolean' ? maStates.ema21 : null);
    ma50Above.push(typeof maStates.sma50 === 'boolean' ? maStates.sma50 : null);
    ma200Above.push(typeof maStates.sma200 === 'boolean' ? maStates.sma200 : null);
    scanJobIds.push(scanJobId ?? null);
  }

  if (!tickers.length) return;

  await divergencePool.query(
    `
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
  `,
    [
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
      scanJobIds,
    ],
  );
}

async function rebuildDivergenceSummariesForTradeDate(options: any = {}) {
  if (!divergencePool) {
    return { asOfTradeDate: '', processedTickers: 0 };
  }
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const scanJobId = Number(options.scanJobId) || null;
  if (!asOfTradeDate) {
    return { asOfTradeDate: '', processedTickers: 0 };
  }

  const maxLookbackTradingDays = Math.max(...DIVERGENCE_LOOKBACK_DAYS);
  // Convert trading days to calendar days (×7/5) with generous buffer for holidays.
  const calendarDaysNeeded = Math.ceil((maxLookbackTradingDays * 7) / 5) + 10;
  const historyStartDate = dateKeyDaysAgo(asOfTradeDate, calendarDaysNeeded) || asOfTradeDate;
  const result = await divergencePool.query(
    `
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
  `,
    [sourceInterval, historyStartDate, asOfTradeDate],
  );

  const rowsByTicker = new Map();
  for (const row of result.rows) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!rowsByTicker.has(ticker)) rowsByTicker.set(ticker, []);
    rowsByTicker.get(ticker).push({
      trade_date: String(row.trade_date || '').trim(),
      close: Number(row.close),
      volume_delta: Number(row.volume_delta),
    });
  }

  const summaryRows = [];
  for (const [ticker, rows] of rowsByTicker.entries()) {
    const filtered = rows.filter((row: any) => row.trade_date && row.trade_date <= asOfTradeDate);
    if (!filtered.length) continue;
    const latestRow = filtered[filtered.length - 1];
    if (!latestRow?.trade_date) continue;
    summaryRows.push({
      ticker,
      source_interval: sourceInterval,
      trade_date: latestRow.trade_date,
      states: classifyDivergenceStateMapFromDailyRows(filtered),
    });
  }

  const summaryBatches = [];
  for (let i = 0; i < summaryRows.length; i += DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE) {
    summaryBatches.push(summaryRows.slice(i, i + DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE));
  }
  await mapWithConcurrency(summaryBatches, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY, async (batch: any) => {
    await upsertDivergenceSummaryBatch(batch, scanJobId);
    return null;
  });
  return { asOfTradeDate, processedTickers: summaryRows.length };
}

async function publishDivergenceTradeDate(options: any = {}) {
  if (!divergencePool) return '';
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tradeDate = String(options.tradeDate || '').trim();
  const scanJobId = Number(options.scanJobId) || null;
  if (!tradeDate) return '';
  await divergencePool.query(
    `
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
  `,
    [sourceInterval, tradeDate, scanJobId],
  );
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
    last_published_trade_date: divergenceTableBuildStatus.lastPublishedTradeDate || null,
  };
}

function getDivergenceScanControlStatus() {
  return {
    running: Boolean(divergenceScanRunning),
    pause_requested: Boolean(divergenceScanPauseRequested),
    stop_requested: Boolean(divergenceScanStopRequested),
    can_resume: !divergenceScanRunning && Boolean(divergenceScanResumeState),
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
      finishedAt: new Date().toISOString(),
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

// getDivergenceFetchDailyDataStatus, getDivergenceFetchWeeklyDataStatus,
// requestStopDivergenceFetchDailyData, requestStopDivergenceFetchWeeklyData
// are now provided by fetchDailyScan.getStatus(), fetchWeeklyScan.getStatus(),
// fetchDailyScan.requestStop(), fetchWeeklyScan.requestStop()

function normalizeFetchDailyDataResumeState(state: any = {}) {
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const sourceInterval = String(state.sourceInterval || '').trim();
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((t: any) =>
          String(t || '')
            .trim()
            .toUpperCase(),
        )
        .filter((t: any) => t && isValidTickerSymbol(t))
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
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim(),
  };
}

function normalizeFetchWeeklyDataResumeState(state: any = {}) {
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const weeklyTradeDate = String(state.weeklyTradeDate || '').trim();
  const sourceInterval = String(state.sourceInterval || '').trim();
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((t: any) =>
          String(t || '')
            .trim()
            .toUpperCase(),
        )
        .filter((t: any) => t && isValidTickerSymbol(t))
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
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim(),
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
  if (
    dayOfWeek === 5 &&
    totalMinutes >= candleAvailableMinute &&
    tradingCalendar.isTradingDay(currentEtDateString(nowUtc))
  ) {
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

// Wire up ScanState normalizeResume and canResumeValidator for fetch daily/weekly
fetchDailyScan.normalizeResume = normalizeFetchDailyDataResumeState;
fetchDailyScan.canResumeValidator = (rs) => {
  const n = normalizeFetchDailyDataResumeState(rs);
  return Boolean(n.asOfTradeDate) && n.totalTickers > 0 && n.nextIndex < n.totalTickers;
};
fetchWeeklyScan.normalizeResume = normalizeFetchWeeklyDataResumeState;
fetchWeeklyScan.canResumeValidator = (rs) => {
  const n = normalizeFetchWeeklyDataResumeState(rs);
  return Boolean(n.asOfTradeDate) && Boolean(n.weeklyTradeDate) && n.totalTickers > 0 && n.nextIndex < n.totalTickers;
};

function normalizeDivergenceScanResumeState(state: any = {}) {
  const runDateEt = String(state.runDateEt || '').trim();
  const trigger = String(state.trigger || 'manual').trim() || 'manual';
  const symbols = Array.isArray(state.symbols)
    ? state.symbols
        .map((symbol: any) =>
          String(symbol || '')
            .trim()
            .toUpperCase(),
        )
        .filter((symbol: any) => symbol && isValidTickerSymbol(symbol))
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
    scanJobId,
  };
}

function normalizeDivergenceTableResumeState(state: any = {}) {
  const sourceInterval =
    String(state.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const asOfTradeDate = String(state.asOfTradeDate || '').trim();
  const requestedLookbackDays = Math.max(
    45,
    Math.floor(Number(state.requestedLookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS),
  );
  const tickers = Array.isArray(state.tickers)
    ? state.tickers
        .map((ticker: any) => String(ticker || '').toUpperCase())
        .filter((ticker: any) => ticker && isValidTickerSymbol(ticker))
    : [];
  const tickerSet = new Set(tickers);
  const backfillTickers = Array.isArray(state.backfillTickers)
    ? state.backfillTickers
        .map((ticker: any) => String(ticker || '').toUpperCase())
        .filter((ticker: any) => tickerSet.has(ticker))
    : [];
  const totalTickers = Number.isFinite(Number(state.totalTickers))
    ? Math.max(0, Math.floor(Number(state.totalTickers)))
    : tickers.length;
  const backfillOffset = Math.max(0, Math.floor(Number(state.backfillOffset) || 0));
  const summarizeOffset = Math.max(0, Math.floor(Number(state.summarizeOffset) || 0));
  const errorTickers = Math.max(0, Math.floor(Number(state.errorTickers) || 0));
  const phaseRaw = String(state.phase || '')
    .trim()
    .toLowerCase();
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
    lastPublishedTradeDate: String(state.lastPublishedTradeDate || '').trim(),
  };
}

async function rebuildStoredDivergenceSummariesForTickers(options: any = {}) {
  if (!divergencePool) return new Map();
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tickers = Array.isArray(options.tickers)
    ? Array.from(
        new Set(
          options.tickers
            .map((ticker: any) => String(ticker || '').toUpperCase())
            .filter((ticker: any) => ticker && isValidTickerSymbol(ticker)),
        ),
      )
    : [];
  if (tickers.length === 0) return new Map();

  const asOfTradeDate = await resolveDivergenceAsOfTradeDate(
    sourceInterval,
    String(options.asOfTradeDate || '').trim(),
  );
  const lookbackDays = Math.max(45, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
  const historyStartDate = dateKeyDaysAgo(asOfTradeDate, lookbackDays + 7) || asOfTradeDate;
  const rowsByTicker = await loadDivergenceDailyHistoryByTicker({
    sourceInterval,
    tickers,
    historyStartDate,
    asOfTradeDate,
  });

  const neutralStates = buildNeutralDivergenceStateMap();
  const summaryRows: any[] = [];
  const summaryByTicker = new Map();
  const nowMs = Date.now();
  const expiresAtMs = nextPacificDivergenceRefreshUtcMs(new Date(nowMs));

  for (const ticker of tickers) {
    const rows = rowsByTicker.get(ticker) || [];
    const filtered = rows.filter((row: any) => row.trade_date && row.trade_date <= asOfTradeDate);
    const latestRowDate = filtered.length ? String(filtered[filtered.length - 1].trade_date || '').trim() : '';
    const tradeDate = latestRowDate || asOfTradeDate;
    const states = filtered.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filtered) : neutralStates;
    summaryRows.push({
      ticker,
      source_interval: sourceInterval,
      trade_date: tradeDate,
      states,
    });
    const entry = {
      ticker,
      sourceInterval,
      tradeDate,
      states,
      computedAtMs: nowMs,
      expiresAtMs,
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

function buildLatestDailyBarSnapshotForTicker(options: any = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
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
    volume_delta: Number(deltaByTime.get(Number(latestBar.time)) || 0),
  };
}

async function buildLatestWeeklyBarSnapshotForTicker(options: any = {}) {
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
    suppliedSourceRows || dataApiIntradayChartHistory(ticker, sourceInterval, lookbackDays, historyOptions),
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) return null;
  const weeklyBars = convertToLATime(parentRows, '1week').sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(weeklyBars) || weeklyBars.length === 0) return null;

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], sourceInterval).sort((a, b) => Number(a.time) - Number(b.time)),
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
    volume_delta: Number(deltaByTime.get(Number(latestBar.time)) || 0),
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
      const ticker = String(row?.ticker || '')
        .trim()
        .toUpperCase();
      if (ticker && isValidTickerSymbol(ticker)) tickers.add(ticker);
    }
  } catch (err: any) {
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
        const ticker = String(row?.ticker || '')
          .trim()
          .toUpperCase();
        if (ticker && isValidTickerSymbol(ticker)) tickers.add(ticker);
      }
    } catch (err: any) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Failed to load FML ticker universe for table run: ${message}`);
    }
  }

  return Array.from(tickers).sort((a: any, b: any) => a.localeCompare(b));
}

function groupDivergenceDailyRowsByTicker(rows: any) {
  const out = new Map();
  for (const row of rows || []) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (!out.has(ticker)) out.set(ticker, []);
    out.get(ticker).push({
      trade_date: String(row?.trade_date || '').trim(),
      close: Number(row?.close),
      volume_delta: Number(row?.volume_delta),
    });
  }
  return out;
}

async function loadDivergenceDailyHistoryByTicker(options: any = {}) {
  const sourceInterval =
    String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL;
  const tickers = Array.isArray(options.tickers) ? options.tickers : [];
  const historyStartDate = String(options.historyStartDate || '').trim();
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  if (!divergencePool || tickers.length === 0 || !historyStartDate || !asOfTradeDate) {
    return new Map();
  }

  const historyResult = await divergencePool.query(
    `
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
  `,
    [sourceInterval, tickers, historyStartDate, asOfTradeDate],
  );

  return groupDivergenceDailyRowsByTicker(historyResult.rows);
}

function hasDivergenceHistoryCoverage(rows: any, asOfTradeDate: any, minCoverageDays: any) {
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => row.trade_date && row.trade_date <= asOfTradeDate);
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

async function buildDivergenceDailyRowsForTicker(options: any = {}) {
  const ticker = String(options.ticker || '').toUpperCase();
  const sourceInterval = toVolumeDeltaSourceInterval(options.sourceInterval, DIVERGENCE_SOURCE_INTERVAL);
  const lookbackDays = Math.max(35, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
  const asOfTradeDate = String(options.asOfTradeDate || '').trim();
  const signal = options && options.signal ? options.signal : null;
  const noCache = options && options.noCache === true;
  if (!ticker) return [];

  const suppliedParentRows = Array.isArray(options.parentRows) ? options.parentRows : null;
  const suppliedSourceRows = Array.isArray(options.sourceRows) ? options.sourceRows : null;
  const historyOptions = { signal, noCache, metricsTracker: options.metricsTracker };
  const [parentRows, sourceRows] = await Promise.all([
    suppliedParentRows || dataApiIntradayChartHistory(ticker, '1day', lookbackDays, historyOptions),
    suppliedSourceRows || dataApiIntradayChartHistory(ticker, sourceInterval, lookbackDays, historyOptions),
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) return [];
  const dailyBars = convertToLATime(parentRows, '1day').sort((a, b) => Number(a.time) - Number(b.time));
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];

  // Cache daily OHLC bars for the mini-chart hover overlay.
  if (ticker && dailyBars.length > 0) {
    const mappedBars = dailyBars.map((b) => ({
      time: Number(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }));
    miniBarsCacheByTicker.set(ticker, mappedBars);
    // Persist to DB so mini-bars survive server restarts (fire-and-forget).
    if (divergencePool) {
      persistMiniChartBars(ticker, mappedBars).catch(() => {});
    }
  }

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], sourceInterval).sort((a, b) => Number(a.time) - Number(b.time)),
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
      volume_delta: Number(deltaByTime.get(Number(bar.time)) || 0),
    });
  }

  return out;
}

async function runDivergenceTableBuild(options: any = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || fetchDailyScan.running || fetchWeeklyScan.running) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested
    ? normalizeDivergenceTableResumeState(divergenceTableBuildResumeState || {})
    : null;
  if (resumeRequested && (!resumeState || resumeState.tickers.length === 0)) {
    return { status: 'no-resume' };
  }

  divergenceTableBuildRunning = true;
  divergenceTableBuildPauseRequested = false;
  divergenceTableBuildStopRequested = false;
  const runMetricsTracker: any = null; // table build doesn't track metrics yet
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
    processedTickers:
      Number(resumeState?.phase === 'summarizing' ? resumeState?.summarizeOffset : resumeState?.backfillOffset) || 0,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || '',
  };

  try {
    const sourceInterval =
      resumeState?.sourceInterval ||
      String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() ||
      DIVERGENCE_SOURCE_INTERVAL;
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
        lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || '',
      };
      return {
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        lastPublishedTradeDate: null,
      };
    }

    const requestedLookbackDays =
      resumeState?.requestedLookbackDays ||
      Math.max(45, Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS));
    const bootstrapMissing = options.bootstrapMissing !== false;
    const forceFullRebuild = Boolean(options.force);
    const asOfTradeDate = await resolveDivergenceAsOfTradeDate(sourceInterval, resumeState?.asOfTradeDate);
    const historyStartDate = dateKeyDaysAgo(asOfTradeDate, requestedLookbackDays + 7) || asOfTradeDate;
    let rowsByTicker = await loadDivergenceDailyHistoryByTicker({
      sourceInterval,
      tickers,
      historyStartDate,
      asOfTradeDate,
    });

    let backfillTickers = resumeState?.backfillTickers?.length ? resumeState.backfillTickers : [];
    if (!resumeRequested || backfillTickers.length === 0) {
      if (forceFullRebuild) {
        backfillTickers = tickers.slice();
      } else if (bootstrapMissing) {
        backfillTickers = tickers.filter((ticker: any) => {
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
        lastPublishedTradeDate,
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
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || '',
      };
      return {
        status: 'paused',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
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
        lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || '',
      };
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
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
              async (ticker: any) => {
                const rows = await buildDivergenceDailyRowsForTicker({
                  ticker,
                  sourceInterval,
                  lookbackDays: requestedLookbackDays,
                  asOfTradeDate,
                  signal: attemptController.signal,
                  noCache: true,
                });
                if (rows.length > 0) {
                  await upsertDivergenceDailyBarsBatch(rows, null);
                }
                return { ticker, rowCount: rows.length };
              },
              (result: any, _index: any, ticker: any) => {
                chunkProcessed += 1;
                processedTickers = Math.min(backfillTickers.length, chunkStartOffset + chunkProcessed);
                divergenceTableBuildStatus.processedTickers = processedTickers;
                stallWatchdog.markProgress();
                if (result && result.error) {
                  if (isAbortError(result.error)) {
                    if (
                      divergenceTableBuildStopRequested ||
                      divergenceTableBuildPauseRequested ||
                      stallWatchdog.isStalled()
                    ) {
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
              },
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
                `Divergence table backfill stalled at ticker ${chunkStartOffset + 1}/${backfillTickers.length}; retry ${retryAttempt}/${DIVERGENCE_STALL_MAX_RETRIES} in ${retryDelayMs}ms`,
              );
              try {
                await sleepWithAbort(retryDelayMs, tableAbortController.signal);
              } catch (sleepErr: any) {
                if (
                  !isAbortError(sleepErr) ||
                  (!divergenceTableBuildStopRequested && !divergenceTableBuildPauseRequested)
                ) {
                  throw sleepErr;
                }
              }
              continue;
            }
            throw new Error(
              `Divergence table backfill stalled at ticker ${chunkStartOffset + 1}/${backfillTickers.length} and exhausted ${DIVERGENCE_STALL_MAX_RETRIES} retries`,
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
        asOfTradeDate,
      });
    }

    phase = 'summarizing';
    persistResumeState();
    divergenceTableBuildStatus.status = 'summarizing';
    summarizeOffset = Math.min(summarizeOffset, tickers.length);
    processedTickers = summarizeOffset;
    divergenceTableBuildStatus.processedTickers = processedTickers;
    divergenceTableBuildStatus.errorTickers = errorTickers;

    const summaryRows: any[] = [];
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
          expiresAtMs,
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
      const filtered = rows.filter((row: any) => row.trade_date && row.trade_date <= asOfTradeDate);
      const latestRowDate = filtered.length ? String(filtered[filtered.length - 1].trade_date || '').trim() : '';
      const states = filtered.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filtered) : neutralStates;
      summaryRows.push({
        ticker,
        source_interval: sourceInterval,
        trade_date: latestRowDate || asOfTradeDate,
        states,
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
        scanJobId: null,
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
      lastPublishedTradeDate: lastPublishedTradeDate || divergenceTableBuildStatus.lastPublishedTradeDate || '',
    };
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: lastPublishedTradeDate || null,
    };
  } catch (err: any) {
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
      lastPublishedTradeDate: divergenceTableBuildStatus.lastPublishedTradeDate || '',
    };
    if (!divergenceTableBuildResumeState) {
      divergenceTableBuildResumeState = normalizeDivergenceTableResumeState({
        sourceInterval:
          String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() || DIVERGENCE_SOURCE_INTERVAL,
        asOfTradeDate: latestCompletedPacificTradeDateKey(new Date()) || currentEtDateString(),
        requestedLookbackDays: Math.max(
          45,
          Math.floor(Number(options.lookbackDays) || DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS),
        ),
        tickers: [],
        totalTickers,
        backfillTickers: [],
        backfillOffset: 0,
        summarizeOffset: processedTickers,
        errorTickers,
        phase: 'summarizing',
        lastPublishedTradeDate,
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

async function runDivergenceFetchDailyData(options: any = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || fetchDailyScan.running || fetchWeeklyScan.running) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeFetchDailyDataResumeState(fetchDailyScan.resumeState || {}) : null;
  if (
    resumeRequested &&
    (!resumeState ||
      !resumeState.asOfTradeDate ||
      resumeState.totalTickers === 0 ||
      resumeState.nextIndex >= resumeState.totalTickers)
  ) {
    return { status: 'no-resume' };
  }
  fetchDailyScan.running = true;
  fetchDailyScan.stopRequested = false;
  // Clear previous run metrics immediately so stale data never leaks into
  // the new run's Logs page display (failedTickers, errors, etc.).
  runMetricsByType.fetchDaily = null;
  if (!resumeRequested) {
    fetchDailyScan.resumeState = null;
  }

  let processedTickers = Math.max(0, Number(resumeState?.processedTickers || 0));
  let totalTickers = Math.max(0, Number(resumeState?.totalTickers || 0));
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  let lastPublishedTradeDate = String(resumeState?.lastPublishedTradeDate || '').trim();
  const startedAtIso = new Date().toISOString();
  const fetchDailyAbortController = new AbortController();
  fetchDailyScan.abortController = fetchDailyAbortController;
  fetchDailyScan._status = {
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan._status.lastPublishedTradeDate || '',
  };
  fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate || '' });

  let tickers = resumeState?.tickers || [];
  let startIndex = Math.max(0, Number(resumeState?.nextIndex || 0));
  let sourceInterval = '';
  let runLookbackDays = DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS;
  let runConcurrency = resolveAdaptiveFetchConcurrency('fetch-daily');
  const summaryFlushSize = DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE;
  let asOfTradeDate = '';
  let runMetricsTracker: any = null;
  const dailyRowsBuffer: any[] = [];
  const summaryRowsBuffer: any[] = [];
  const maSummaryRowsBuffer: any[] = [];
  const maSeedRows: any[] = [];

  try {
    sourceInterval =
      resumeState?.sourceInterval ||
      String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() ||
      DIVERGENCE_SOURCE_INTERVAL;
    runLookbackDays =
      resumeState?.lookbackDays ||
      Math.max(28, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
    asOfTradeDate = resumeState?.asOfTradeDate || resolveLastClosedDailyCandleDate();
    runConcurrency = resolveAdaptiveFetchConcurrency('fetch-daily');
    runMetricsTracker = createRunMetricsTracker('fetchDaily', {
      sourceInterval,
      asOfTradeDate,
      lookbackDays: runLookbackDays,
      concurrency: runConcurrency,
      flushSize: summaryFlushSize,
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
    fetchDailyScan._status.totalTickers = totalTickers;
    runMetricsTracker?.setTotals(totalTickers);

    const persistResumeState = (nextIdx: any) => {
      fetchDailyScan.resumeState = normalizeFetchDailyDataResumeState({
        asOfTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: nextIdx,
        processedTickers,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate,
      });
    };

    const markStopped = (nextIdx: any, options: any = {}) => {
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
        fetchDailyScan.resumeState = null;
      }
      fetchDailyScan.stopRequested = false;
      fetchDailyScan._status = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan._status.lastPublishedTradeDate || '',
      };
      fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate || '' });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
      };
    };

    if (totalTickers === 0) {
      fetchDailyScan.stopRequested = false;
      fetchDailyScan.resumeState = null;
      fetchDailyScan._status = {
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: fetchDailyScan._status.lastPublishedTradeDate || '',
      };
      fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate || '' });
      return {
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        lastPublishedTradeDate: null,
      };
    }

    await publishDivergenceTradeDate({
      sourceInterval,
      tradeDate: asOfTradeDate,
      scanJobId: null,
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
          signalRows: flushedSignalRows,
        });
      }
    };

    const enqueueFlush = () => {
      flushChain = flushChain
        .then(() => flushBuffers())
        .catch((err) => {
          console.error('Fetch-all on-the-fly flush error:', err && err.message ? err.message : String(err));
        });
      return flushChain;
    };

    // Slice tickers to only the remaining portion for resume
    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;
    const failedTickers: any[] = [];

    persistResumeState(startIndex);

    // --- Worker function shared by main pass and retry pass ---
    const fetchDailyTickerWorker = async (ticker: any) => {
      return runWithAbortAndTimeout(
        async (tickerSignal) => {
          if (fetchDailyScan.stopRequested || fetchDailyAbortController.signal.aborted) {
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
            metricsTracker: runMetricsTracker,
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
            const states =
              filteredRows.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filteredRows) : neutralStates;
            summaryRowsBuffer.push({
              ticker,
              source_interval: sourceInterval,
              trade_date: latestRow.trade_date,
              states,
              ma_states: null,
              latest_close: Number(latestRow.close),
              latest_prev_close: Number(latestRow.prev_close),
              latest_volume_delta: Number(latestRow.volume_delta),
            });
            if (Number.isFinite(latestClose) && latestClose > 0) {
              maSeedRows.push({
                ticker,
                source_interval: sourceInterval,
                trade_date: latestRow.trade_date,
                states,
                latest_close: latestClose,
                latest_prev_close: Number(latestRow.prev_close),
                latest_volume_delta: Number(latestRow.volume_delta),
              });
            }
          }

          // Flush buffers when thresholds are reached
          if (
            summaryRowsBuffer.length >= summaryFlushSize ||
            dailyRowsBuffer.length >= DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE
          ) {
            await enqueueFlush();
          }

          return { ticker, tradeDate: latestRow?.trade_date };
        },
        {
          signal: fetchDailyAbortController.signal,
          timeoutMs: DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
          label: `Fetch-all ticker ${ticker}`,
        },
      );
    };

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      fetchDailyTickerWorker,
      (result: any, sliceIndex: any) => {
        settledCount += 1;
        processedTickers = startIndex + settledCount;
        const ticker = tickerSlice[sliceIndex] || '';
        if (result && result.error && !(fetchDailyScan.stopRequested && isAbortError(result.error))) {
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
        fetchDailyScan._status.processedTickers = processedTickers;
        fetchDailyScan._status.errorTickers = errorTickers;
        fetchDailyScan._status.lastPublishedTradeDate = lastPublishedTradeDate;
        fetchDailyScan._status.status = fetchDailyScan.stopRequested ? 'stopping' : 'running';
        fetchDailyScan.setExtraStatus({ last_published_trade_date: lastPublishedTradeDate });
        runMetricsTracker?.setProgress(processedTickers, errorTickers);
        // Update resume state as we progress
        persistResumeState(startIndex + settledCount);
      },
      () => fetchDailyScan.stopRequested || fetchDailyAbortController.signal.aborted,
    );

    if (fetchDailyScan.stopRequested) {
      // Final flush before reporting stopped — save whatever is buffered
      await enqueueFlush();
      return markStopped(processedTickers);
    }

    // Final flush for any remaining buffered rows
    await enqueueFlush();

    // --- Retry pass for failed tickers ---
    if (failedTickers.length > 0 && !fetchDailyScan.stopRequested && !fetchDailyAbortController.signal.aborted) {
      const retryCount = failedTickers.length;
      console.log(`Fetch-all: retrying ${retryCount} failed ticker(s)...`);
      runMetricsTracker?.setPhase('retry');
      fetchDailyScan._status.status = 'running-retry';
      let retryRecovered = 0;
      const stillFailedTickers: any[] = [];
      await mapWithConcurrency(
        failedTickers,
        Math.max(1, Math.floor(runConcurrency / 2)),
        fetchDailyTickerWorker,
        (result: any, idx: any) => {
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
          fetchDailyScan._status.errorTickers = errorTickers;
          runMetricsTracker?.setProgress(processedTickers, errorTickers);
        },
        () => fetchDailyScan.stopRequested || fetchDailyAbortController.signal.aborted,
      );
      if (retryRecovered > 0) {
        console.log(`Fetch-all: retry recovered ${retryRecovered}/${retryCount} ticker(s)`);
      }
      await enqueueFlush();
      runMetricsTracker?.recordStallRetry();

      // --- Second retry pass for tickers that failed both attempts ---
      if (stillFailedTickers.length > 0 && !fetchDailyScan.stopRequested && !fetchDailyAbortController.signal.aborted) {
        const retry2Count = stillFailedTickers.length;
        console.log(`Fetch-all: second retry for ${retry2Count} ticker(s)...`);
        runMetricsTracker?.setPhase('retry-2');
        fetchDailyScan._status.status = 'running-retry';
        let retry2Recovered = 0;
        await mapWithConcurrency(
          stillFailedTickers,
          Math.max(1, Math.floor(runConcurrency / 4)),
          fetchDailyTickerWorker,
          (result: any, idx: any) => {
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
            fetchDailyScan._status.errorTickers = errorTickers;
            runMetricsTracker?.setProgress(processedTickers, errorTickers);
          },
          () => fetchDailyScan.stopRequested || fetchDailyAbortController.signal.aborted,
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
      fetchDailyScan._status.status = 'running-ma';
      const maConcurrency = Math.max(1, Math.min(runConcurrency, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY));
      const failedMaSeeds: any[] = [];

      const fetchDailyMaWorker = async (seed: any) => {
        return runWithAbortAndTimeout(
          async (tickerSignal) => {
            const maStates = await fetchDataApiMovingAverageStatesForTicker(seed.ticker, Number(seed.latest_close), {
              signal: tickerSignal,
              metricsTracker: runMetricsTracker,
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
                latest_volume_delta: Number(seed.latest_volume_delta),
              });
              if (maSummaryRowsBuffer.length >= summaryFlushSize) {
                await enqueueFlush();
              }
            }
            return null;
          },
          {
            signal: fetchDailyAbortController.signal,
            timeoutMs: DIVERGENCE_FETCH_MA_TIMEOUT_MS,
            label: `Fetch-all MA ${seed.ticker}`,
          },
        );
      };

      await mapWithConcurrency(
        maSeedRows,
        maConcurrency,
        fetchDailyMaWorker,
        (result: any, idx: any) => {
          if (result && result.error && !isAbortError(result.error)) {
            failedMaSeeds.push(maSeedRows[idx]);
            const message = result.error && result.error.message ? result.error.message : String(result.error);
            console.error(`Fetch-all MA enrichment failed: ${message}`);
          }
        },
        () => fetchDailyScan.stopRequested || fetchDailyAbortController.signal.aborted,
      );

      if (fetchDailyScan.stopRequested) {
        await enqueueFlush();
        return markStopped(totalTickers, { preserveResume: false, rewind: false });
      }
      await enqueueFlush();

      // --- Retry pass for failed MA tickers ---
      if (failedMaSeeds.length > 0 && !fetchDailyScan.stopRequested && !fetchDailyAbortController.signal.aborted) {
        const maRetryCount = failedMaSeeds.length;
        console.log(`Fetch-all: retrying ${maRetryCount} failed MA ticker(s)...`);
        fetchDailyScan._status.status = 'running-ma-retry';
        let maRetryRecovered = 0;
        const stillFailedMaSeeds: any[] = [];
        await mapWithConcurrency(
          failedMaSeeds,
          Math.max(1, Math.floor(maConcurrency / 2)),
          fetchDailyMaWorker,
          (result: any, idx: any) => {
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
          () => fetchDailyScan.stopRequested || fetchDailyAbortController.signal.aborted,
        );
        if (maRetryRecovered > 0) {
          console.log(`Fetch-all: MA retry recovered ${maRetryRecovered}/${maRetryCount} ticker(s)`);
        }
        await enqueueFlush();

        // --- Second retry pass for MA tickers ---
        if (
          stillFailedMaSeeds.length > 0 &&
          !fetchDailyScan.stopRequested &&
          !fetchDailyAbortController.signal.aborted
        ) {
          const maRetry2Count = stillFailedMaSeeds.length;
          console.log(`Fetch-all: second MA retry for ${maRetry2Count} ticker(s)...`);
          fetchDailyScan._status.status = 'running-ma-retry';
          let maRetry2Recovered = 0;
          await mapWithConcurrency(
            stillFailedMaSeeds,
            Math.max(1, Math.floor(maConcurrency / 4)),
            fetchDailyMaWorker,
            (result: any, idx: any) => {
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
            () => fetchDailyScan.stopRequested || fetchDailyAbortController.signal.aborted,
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
        scanJobId: null,
      });
      divergenceLastFetchedTradeDateEt = maxEtDateString(divergenceLastFetchedTradeDateEt, lastPublishedTradeDate);
    }
    clearDivergenceSummaryCacheForSourceInterval(sourceInterval);

    // Completed successfully — clear resume state
    if (!lastPublishedTradeDate && asOfTradeDate) {
      lastPublishedTradeDate = asOfTradeDate;
    }
    fetchDailyScan.resumeState = null;
    fetchDailyScan.stopRequested = false;
    fetchDailyScan._status = {
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan._status.lastPublishedTradeDate || '',
    };
    fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate || '' });
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: lastPublishedTradeDate || null,
    };
  } catch (err: any) {
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
    } catch (flushErr: any) {
      console.error(
        'Fetch-all error-path flush failed:',
        flushErr && flushErr.message ? flushErr.message : String(flushErr),
      );
    }

    if (fetchDailyScan.stopRequested || isAbortError(err)) {
      // Persist resume state on stop/abort — rewind by concurrency level
      // so in-flight aborted tickers are re-fetched on resume.
      const safeNextIndex = Math.max(0, processedTickers - runConcurrency);
      fetchDailyScan.resumeState = normalizeFetchDailyDataResumeState({
        asOfTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: safeNextIndex,
        processedTickers: safeNextIndex,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate,
      });
      fetchDailyScan.stopRequested = false;
      fetchDailyScan._status = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: lastPublishedTradeDate || fetchDailyScan._status.lastPublishedTradeDate || '',
      };
      fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate || '' });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: lastPublishedTradeDate || null,
      };
    }
    fetchDailyScan.stopRequested = false;
    fetchDailyScan._status = {
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: fetchDailyScan._status.lastPublishedTradeDate || '',
    };
    fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate || '' });
    throw err;
  } finally {
    if (runMetricsTracker) {
      runMetricsTracker.finish(fetchDailyScan._status.status || 'completed', {
        totalTickers,
        processedTickers: Number(fetchDailyScan._status.processedTickers || processedTickers || 0),
        errorTickers: Number(fetchDailyScan._status.errorTickers || errorTickers || 0),
        phase: fetchDailyScan._status.status || 'completed',
        meta: {
          sourceInterval,
          asOfTradeDate,
          lastPublishedTradeDate,
        },
      });
    }
    if (fetchDailyScan.abortController === fetchDailyAbortController) {
      fetchDailyScan.abortController = null;
    }
    fetchDailyScan.running = false;
  }
}

async function runDivergenceFetchWeeklyData(options: any = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || divergenceTableBuildRunning || fetchDailyScan.running || fetchWeeklyScan.running) {
    return { status: 'running' };
  }

  const resumeRequested = options.resume === true;
  const resumeState = resumeRequested ? normalizeFetchWeeklyDataResumeState(fetchWeeklyScan.resumeState || {}) : null;
  if (
    resumeRequested &&
    (!resumeState ||
      !resumeState.asOfTradeDate ||
      !resumeState.weeklyTradeDate ||
      resumeState.totalTickers === 0 ||
      resumeState.nextIndex >= resumeState.totalTickers)
  ) {
    return { status: 'no-resume' };
  }

  fetchWeeklyScan.running = true;
  fetchWeeklyScan.stopRequested = false;
  // Clear previous run metrics immediately so stale data never leaks into
  // the new run's Logs page display (failedTickers, errors, etc.).
  runMetricsByType.fetchWeekly = null;
  if (!resumeRequested) {
    fetchWeeklyScan.resumeState = null;
  }

  let processedTickers = Math.max(0, Number(resumeState?.processedTickers || 0));
  let totalTickers = Math.max(0, Number(resumeState?.totalTickers || 0));
  let errorTickers = Math.max(0, Number(resumeState?.errorTickers || 0));
  let lastPublishedTradeDate = String(resumeState?.lastPublishedTradeDate || '').trim();
  const startedAtIso = new Date().toISOString();
  const fetchWeeklyAbortController = new AbortController();
  fetchWeeklyScan.abortController = fetchWeeklyAbortController;
  fetchWeeklyScan._status = {
    running: true,
    status: 'running',
    totalTickers,
    processedTickers,
    errorTickers,
    startedAt: startedAtIso,
    finishedAt: null,
    lastPublishedTradeDate: lastPublishedTradeDate || fetchWeeklyScan._status.lastPublishedTradeDate || '',
  };
  fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan._status.lastPublishedTradeDate || '' });

  let tickers = resumeState?.tickers || [];
  let startIndex = Math.max(0, Number(resumeState?.nextIndex || 0));
  let sourceInterval = '';
  let runLookbackDays = DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS;
  let runConcurrency = resolveAdaptiveFetchConcurrency('fetch-weekly');
  const summaryFlushSize = DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE;
  let asOfTradeDate = '';
  let weeklyTradeDate = '';
  let runMetricsTracker: any = null;
  const dailyRowsBuffer: any[] = [];
  const summaryRowsBuffer: any[] = [];
  const maSummaryRowsBuffer: any[] = [];
  const maSeedRows: any[] = [];
  const weeklySignalRowsBuffer: any[] = [];
  const weeklyNeutralTickerBuffer: any[] = [];

  try {
    sourceInterval =
      resumeState?.sourceInterval ||
      String(options.sourceInterval || DIVERGENCE_SOURCE_INTERVAL).trim() ||
      DIVERGENCE_SOURCE_INTERVAL;
    runLookbackDays =
      resumeState?.lookbackDays ||
      Math.max(28, Math.floor(Number(options.lookbackDays) || DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS));
    asOfTradeDate = resumeState?.asOfTradeDate || resolveLastClosedDailyCandleDate();
    weeklyTradeDate = resumeState?.weeklyTradeDate || resolveLastClosedWeeklyCandleDate();
    runConcurrency = resolveAdaptiveFetchConcurrency('fetch-weekly');
    runMetricsTracker = createRunMetricsTracker('fetchWeekly', {
      sourceInterval,
      asOfTradeDate,
      weeklyTradeDate,
      lookbackDays: runLookbackDays,
      concurrency: runConcurrency,
      flushSize: summaryFlushSize,
    });
    runMetricsTracker.setPhase('core');

    if (!resumeRequested && !options.force) {
      const latestStoredWeeklyTradeDate = await getLatestWeeklySignalTradeDate(sourceInterval);
      if (latestStoredWeeklyTradeDate && latestStoredWeeklyTradeDate >= weeklyTradeDate) {
        fetchWeeklyScan._status = {
          running: false,
          status: 'skipped',
          totalTickers: 0,
          processedTickers: 0,
          errorTickers: 0,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          lastPublishedTradeDate: latestStoredWeeklyTradeDate,
        };
        fetchWeeklyScan.setExtraStatus({ last_published_trade_date: latestStoredWeeklyTradeDate || '' });
        return {
          status: 'skipped',
          reason: 'already-up-to-date',
          lastPublishedTradeDate: latestStoredWeeklyTradeDate,
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
    fetchWeeklyScan._status.totalTickers = totalTickers;
    runMetricsTracker?.setTotals(totalTickers);

    const persistResumeState = (nextIdx: any) => {
      fetchWeeklyScan.resumeState = normalizeFetchWeeklyDataResumeState({
        asOfTradeDate,
        weeklyTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: nextIdx,
        processedTickers,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate,
      });
    };

    const markStopped = (nextIdx: any, options: any = {}) => {
      const preserveResume = options.preserveResume !== false;
      const rewind = options.rewind !== false;
      const safeNextIndex = rewind
        ? Math.max(0, Math.min(totalTickers, nextIdx - runConcurrency))
        : Math.max(0, Math.min(totalTickers, nextIdx));
      if (preserveResume) {
        persistResumeState(safeNextIndex);
      } else {
        fetchWeeklyScan.resumeState = null;
      }
      fetchWeeklyScan.stopRequested = false;
      fetchWeeklyScan._status = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate:
          weeklyTradeDate || lastPublishedTradeDate || fetchWeeklyScan._status.lastPublishedTradeDate || '',
      };
      fetchWeeklyScan.setExtraStatus({
        last_published_trade_date: fetchWeeklyScan._status.lastPublishedTradeDate || '',
      });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers: safeNextIndex,
        errorTickers,
        lastPublishedTradeDate: weeklyTradeDate || null,
      };
    };

    if (totalTickers === 0) {
      fetchWeeklyScan.stopRequested = false;
      fetchWeeklyScan.resumeState = null;
      fetchWeeklyScan._status = {
        running: false,
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: fetchWeeklyScan._status.lastPublishedTradeDate || '',
      };
      fetchWeeklyScan.setExtraStatus({
        last_published_trade_date: fetchWeeklyScan._status.lastPublishedTradeDate || '',
      });
      return {
        status: 'completed',
        totalTickers: 0,
        processedTickers: 0,
        errorTickers: 0,
        lastPublishedTradeDate: null,
      };
    }

    // Keep divergence summaries published at the latest daily closed date.
    await publishDivergenceTradeDate({
      sourceInterval,
      tradeDate: asOfTradeDate,
      scanJobId: null,
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
        await divergencePool!.query(
          `
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
        `,
          [neutralTickers, neutralTradeDates, sourceInterval],
        );
      }
      if (flushedDailyRows > 0 || flushedSummaryRows > 0 || flushedSignalRows > 0 || flushedNeutralRows > 0) {
        runMetricsTracker?.recordDbFlush({
          durationMs: Date.now() - flushStartedAt,
          dailyRows: flushedDailyRows,
          summaryRows: flushedSummaryRows,
          signalRows: flushedSignalRows,
          neutralRows: flushedNeutralRows,
        });
      }
    };

    const enqueueFlush = () => {
      flushChain = flushChain
        .then(() => flushBuffers())
        .catch((err) => {
          console.error('Fetch-weekly on-the-fly flush error:', err && err.message ? err.message : String(err));
        });
      return flushChain;
    };

    const tickerSlice = tickers.slice(startIndex);
    let settledCount = 0;
    const failedTickers: any[] = [];

    persistResumeState(startIndex);

    // --- Worker function shared by main pass and retry pass ---
    const fetchWeeklyTickerWorker = async (ticker: any) => {
      return runWithAbortAndTimeout(
        async (tickerSignal) => {
          if (fetchWeeklyScan.stopRequested || fetchWeeklyAbortController.signal.aborted) {
            throw buildRequestAbortError('Fetch-weekly run stopped');
          }
          const sourceRows = await dataApiIntradayChartHistory(ticker, sourceInterval, runLookbackDays, {
            signal: tickerSignal,
            noCache: true,
            metricsTracker: runMetricsTracker,
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
            metricsTracker: runMetricsTracker,
          });
          const weeklySnapshot = await buildLatestWeeklyBarSnapshotForTicker({
            ticker,
            sourceInterval,
            lookbackDays: runLookbackDays,
            asOfTradeDate: weeklyTradeDate,
            signal: tickerSignal,
            noCache: true,
            sourceRows,
            metricsTracker: runMetricsTracker,
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
            const states =
              filteredRows.length >= 2 ? classifyDivergenceStateMapFromDailyRows(filteredRows) : neutralStates;
            summaryRowsBuffer.push({
              ticker,
              source_interval: sourceInterval,
              trade_date: latestRow.trade_date,
              states,
              ma_states: null,
              latest_close: Number(latestRow.close),
              latest_prev_close: Number(latestRow.prev_close),
              latest_volume_delta: Number(latestRow.volume_delta),
            });
            if (Number.isFinite(latestClose) && latestClose > 0) {
              maSeedRows.push({
                ticker,
                source_interval: sourceInterval,
                trade_date: latestRow.trade_date,
                states,
                latest_close: latestClose,
                latest_prev_close: Number(latestRow.prev_close),
                latest_volume_delta: Number(latestRow.volume_delta),
              });
            }
          }
          if (weeklySnapshot?.trade_date) {
            const signalType = classifyDivergenceSignal(
              Number(weeklySnapshot.volume_delta),
              Number(weeklySnapshot.close),
              Number(weeklySnapshot.prev_close),
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
                volume_delta: Number(weeklySnapshot.volume_delta),
              });
            } else {
              weeklyNeutralTickerBuffer.push({
                ticker,
                trade_date: weeklySnapshot.trade_date,
              });
            }
          }

          if (
            summaryRowsBuffer.length >= summaryFlushSize ||
            dailyRowsBuffer.length >= DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE ||
            weeklySignalRowsBuffer.length >= summaryFlushSize ||
            weeklyNeutralTickerBuffer.length >= summaryFlushSize
          ) {
            await enqueueFlush();
          }

          return { ticker, tradeDate: latestRow?.trade_date };
        },
        {
          signal: fetchWeeklyAbortController.signal,
          timeoutMs: DIVERGENCE_FETCH_TICKER_TIMEOUT_MS,
          label: `Fetch-weekly ticker ${ticker}`,
        },
      );
    };

    await mapWithConcurrency(
      tickerSlice,
      runConcurrency,
      fetchWeeklyTickerWorker,
      (result: any, sliceIndex: any) => {
        settledCount += 1;
        processedTickers = startIndex + settledCount;
        const ticker = tickerSlice[sliceIndex] || '';
        if (result && result.error && !(fetchWeeklyScan.stopRequested && isAbortError(result.error))) {
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
        fetchWeeklyScan._status.processedTickers = processedTickers;
        fetchWeeklyScan._status.errorTickers = errorTickers;
        fetchWeeklyScan._status.lastPublishedTradeDate = lastPublishedTradeDate;
        fetchWeeklyScan._status.status = fetchWeeklyScan.stopRequested ? 'stopping' : 'running';
        fetchWeeklyScan.setExtraStatus({ last_published_trade_date: lastPublishedTradeDate });
        runMetricsTracker?.setProgress(processedTickers, errorTickers);
        persistResumeState(startIndex + settledCount);
      },
      () => fetchWeeklyScan.stopRequested || fetchWeeklyAbortController.signal.aborted,
    );

    if (fetchWeeklyScan.stopRequested) {
      await enqueueFlush();
      return markStopped(processedTickers);
    }

    await enqueueFlush();

    // --- Retry pass for failed tickers ---
    if (failedTickers.length > 0 && !fetchWeeklyScan.stopRequested && !fetchWeeklyAbortController.signal.aborted) {
      const retryCount = failedTickers.length;
      console.log(`Fetch-weekly: retrying ${retryCount} failed ticker(s)...`);
      runMetricsTracker?.setPhase('retry');
      fetchWeeklyScan._status.status = 'running-retry';
      let retryRecovered = 0;
      const stillFailedTickers: any[] = [];
      await mapWithConcurrency(
        failedTickers,
        Math.max(1, Math.floor(runConcurrency / 2)),
        fetchWeeklyTickerWorker,
        (result: any, idx: any) => {
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
          fetchWeeklyScan._status.errorTickers = errorTickers;
          runMetricsTracker?.setProgress(processedTickers, errorTickers);
        },
        () => fetchWeeklyScan.stopRequested || fetchWeeklyAbortController.signal.aborted,
      );
      if (retryRecovered > 0) {
        console.log(`Fetch-weekly: retry recovered ${retryRecovered}/${retryCount} ticker(s)`);
      }
      await enqueueFlush();
      runMetricsTracker?.recordStallRetry();

      // --- Second retry pass for tickers that failed both attempts ---
      if (
        stillFailedTickers.length > 0 &&
        !fetchWeeklyScan.stopRequested &&
        !fetchWeeklyAbortController.signal.aborted
      ) {
        const retry2Count = stillFailedTickers.length;
        console.log(`Fetch-weekly: second retry for ${retry2Count} ticker(s)...`);
        runMetricsTracker?.setPhase('retry-2');
        fetchWeeklyScan._status.status = 'running-retry';
        let retry2Recovered = 0;
        await mapWithConcurrency(
          stillFailedTickers,
          Math.max(1, Math.floor(runConcurrency / 4)),
          fetchWeeklyTickerWorker,
          (result: any, idx: any) => {
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
            fetchWeeklyScan._status.errorTickers = errorTickers;
            runMetricsTracker?.setProgress(processedTickers, errorTickers);
          },
          () => fetchWeeklyScan.stopRequested || fetchWeeklyAbortController.signal.aborted,
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
      fetchWeeklyScan._status.status = 'running-ma';
      const maConcurrency = Math.max(1, Math.min(runConcurrency, DIVERGENCE_SUMMARY_BUILD_CONCURRENCY));
      const failedMaSeeds: any[] = [];

      const fetchWeeklyMaWorker = async (seed: any) => {
        return runWithAbortAndTimeout(
          async (tickerSignal) => {
            const maStates = await fetchDataApiMovingAverageStatesForTicker(seed.ticker, Number(seed.latest_close), {
              signal: tickerSignal,
              metricsTracker: runMetricsTracker,
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
                latest_volume_delta: Number(seed.latest_volume_delta),
              });
              if (maSummaryRowsBuffer.length >= summaryFlushSize) {
                await enqueueFlush();
              }
            }
            return null;
          },
          {
            signal: fetchWeeklyAbortController.signal,
            timeoutMs: DIVERGENCE_FETCH_MA_TIMEOUT_MS,
            label: `Fetch-weekly MA ${seed.ticker}`,
          },
        );
      };

      await mapWithConcurrency(
        maSeedRows,
        maConcurrency,
        fetchWeeklyMaWorker,
        (result: any, idx: any) => {
          if (result && result.error && !isAbortError(result.error)) {
            failedMaSeeds.push(maSeedRows[idx]);
            const message = result.error && result.error.message ? result.error.message : String(result.error);
            console.error(`Fetch-weekly MA enrichment failed: ${message}`);
          }
        },
        () => fetchWeeklyScan.stopRequested || fetchWeeklyAbortController.signal.aborted,
      );

      if (fetchWeeklyScan.stopRequested) {
        await enqueueFlush();
        return markStopped(totalTickers, { preserveResume: false, rewind: false });
      }
      await enqueueFlush();

      // --- Retry pass for failed MA tickers ---
      if (failedMaSeeds.length > 0 && !fetchWeeklyScan.stopRequested && !fetchWeeklyAbortController.signal.aborted) {
        const maRetryCount = failedMaSeeds.length;
        console.log(`Fetch-weekly: retrying ${maRetryCount} failed MA ticker(s)...`);
        fetchWeeklyScan._status.status = 'running-ma-retry';
        let maRetryRecovered = 0;
        const stillFailedMaSeeds: any[] = [];
        await mapWithConcurrency(
          failedMaSeeds,
          Math.max(1, Math.floor(maConcurrency / 2)),
          fetchWeeklyMaWorker,
          (result: any, idx: any) => {
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
          () => fetchWeeklyScan.stopRequested || fetchWeeklyAbortController.signal.aborted,
        );
        if (maRetryRecovered > 0) {
          console.log(`Fetch-weekly: MA retry recovered ${maRetryRecovered}/${maRetryCount} ticker(s)`);
        }
        await enqueueFlush();

        // --- Second retry pass for MA tickers ---
        if (
          stillFailedMaSeeds.length > 0 &&
          !fetchWeeklyScan.stopRequested &&
          !fetchWeeklyAbortController.signal.aborted
        ) {
          const maRetry2Count = stillFailedMaSeeds.length;
          console.log(`Fetch-weekly: second MA retry for ${maRetry2Count} ticker(s)...`);
          fetchWeeklyScan._status.status = 'running-ma-retry';
          let maRetry2Recovered = 0;
          await mapWithConcurrency(
            stillFailedMaSeeds,
            Math.max(1, Math.floor(maConcurrency / 4)),
            fetchWeeklyMaWorker,
            (result: any, idx: any) => {
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
            () => fetchWeeklyScan.stopRequested || fetchWeeklyAbortController.signal.aborted,
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

    fetchWeeklyScan.resumeState = null;
    fetchWeeklyScan.stopRequested = false;
    fetchWeeklyScan._status = {
      running: false,
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: weeklyTradeDate || fetchWeeklyScan._status.lastPublishedTradeDate || '',
    };
    fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan._status.lastPublishedTradeDate || '' });
    return {
      status: errorTickers > 0 ? 'completed-with-errors' : 'completed',
      totalTickers,
      processedTickers,
      errorTickers,
      lastPublishedTradeDate: weeklyTradeDate || null,
    };
  } catch (err: any) {
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
        await divergencePool!.query(
          `
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
        `,
          [neutralTickers, neutralTradeDates, sourceInterval],
        );
      }
    } catch (flushErr: any) {
      console.error(
        'Fetch-weekly error-path flush failed:',
        flushErr && flushErr.message ? flushErr.message : String(flushErr),
      );
    }

    if (fetchWeeklyScan.stopRequested || isAbortError(err)) {
      const safeNextIndex = Math.max(0, processedTickers - runConcurrency);
      fetchWeeklyScan.resumeState = normalizeFetchWeeklyDataResumeState({
        asOfTradeDate,
        weeklyTradeDate,
        sourceInterval,
        tickers,
        totalTickers,
        nextIndex: safeNextIndex,
        processedTickers: safeNextIndex,
        errorTickers,
        lookbackDays: runLookbackDays,
        lastPublishedTradeDate,
      });
      fetchWeeklyScan.stopRequested = false;
      fetchWeeklyScan._status = {
        running: false,
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        lastPublishedTradeDate: weeklyTradeDate || fetchWeeklyScan._status.lastPublishedTradeDate || '',
      };
      fetchWeeklyScan.setExtraStatus({
        last_published_trade_date: fetchWeeklyScan._status.lastPublishedTradeDate || '',
      });
      return {
        status: 'stopped',
        totalTickers,
        processedTickers,
        errorTickers,
        lastPublishedTradeDate: weeklyTradeDate || null,
      };
    }
    fetchWeeklyScan.stopRequested = false;
    fetchWeeklyScan._status = {
      running: false,
      status: 'failed',
      totalTickers,
      processedTickers,
      errorTickers,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      lastPublishedTradeDate: fetchWeeklyScan._status.lastPublishedTradeDate || '',
    };
    fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan._status.lastPublishedTradeDate || '' });
    throw err;
  } finally {
    if (runMetricsTracker) {
      runMetricsTracker.finish(fetchWeeklyScan._status.status || 'completed', {
        totalTickers,
        processedTickers: Number(fetchWeeklyScan._status.processedTickers || processedTickers || 0),
        errorTickers: Number(fetchWeeklyScan._status.errorTickers || errorTickers || 0),
        phase: fetchWeeklyScan._status.status || 'completed',
        meta: {
          sourceInterval,
          asOfTradeDate,
          weeklyTradeDate,
          lastPublishedTradeDate,
        },
      });
    }
    if (fetchWeeklyScan.abortController === fetchWeeklyAbortController) {
      fetchWeeklyScan.abortController = null;
    }
    fetchWeeklyScan.running = false;
  }
}

async function runDailyDivergenceScan(options: any = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning || fetchDailyScan.running || fetchWeeklyScan.running) {
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
      scanJobId,
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

      await divergencePool!.query(
        `
        DELETE FROM divergence_signals
        WHERE source_interval = $1
          AND timeframe <> '1d'
      `,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      await divergencePool!.query(
        `
        DELETE FROM divergence_signals
        WHERE trade_date = $1
          AND source_interval = $2
          AND timeframe = '1d'
      `,
        [runDate, DIVERGENCE_SOURCE_INTERVAL],
      );
    } else if (scanJobId) {
      await updateDivergenceScanJob(scanJobId, {
        status: 'running',
        processed_symbols: processed,
        bullish_count: bullishCount,
        bearish_count: bearishCount,
        error_count: errorCount,
        scanned_trade_date: latestScannedTradeDate || null,
      });
    }

    if (totalSymbols === 0) {
      await updateDivergenceScanJob(scanJobId, {
        status: 'completed',
        finished_at: new Date(),
        processed_symbols: 0,
        scanned_trade_date: null,
      });
      divergenceLastScanDateEt = runDate;
      divergenceLastFetchedTradeDateEt = runDate;
      divergenceScanResumeState = null;
      return { status: 'completed', runDate, processed: 0 };
    }

    const targetSpacingMs =
      DIVERGENCE_SCAN_SPREAD_MINUTES > 0
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
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'stopped',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
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
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'paused',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
        };
      }

      nextIndex = i;
      const batch = symbols.slice(i, i + DIVERGENCE_SCAN_CONCURRENCY);
      const attemptController = new AbortController();
      const unlinkAbort = linkAbortSignalToController(scanAbortController.signal, attemptController);
      let batchResults = [];
      try {
        batchResults = await Promise.all(
          batch.map(async (ticker: any) => {
            try {
              const outcome = await computeSymbolDivergenceSignals(ticker, { signal: attemptController.signal });
              return { ticker, ...outcome, error: null };
            } catch (err: any) {
              return { ticker, signals: [], latestTradeDate: '', error: err };
            }
          }),
        );
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
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'stopped',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
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
          scanned_trade_date: latestScannedTradeDate || null,
        });
        return {
          status: 'paused',
          runDate,
          processed,
          bullishCount,
          bearishCount,
          errorCount,
        };
      }

      const batchSignals = [];
      const batchDailyBars = [];
      for (const result of batchResults) {
        processed += 1;
        if (result.error) {
          if (
            isAbortError(result.error) &&
            (scanAbortController.signal.aborted || divergenceScanStopRequested || divergenceScanPauseRequested)
          ) {
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
        upsertDivergenceSignalsBatch(batchSignals, scanJobId),
      ]);

      if (scanJobId && (processed % DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY === 0 || processed === totalSymbols)) {
        await updateDivergenceScanJob(scanJobId, {
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount,
          scanned_trade_date: latestScannedTradeDate || null,
        });
      }

      nextIndex = Math.min(symbols.length, i + DIVERGENCE_SCAN_CONCURRENCY);
      persistResumeState();
      if (targetSpacingMs > 0) {
        try {
          await sleepWithAbort(targetSpacingMs, scanAbortController.signal);
        } catch (sleepErr: any) {
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
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'stopped',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
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
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'paused',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
      };
    }

    await updateDivergenceScanJob(scanJobId, {
      status: 'summarizing',
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount,
      scanned_trade_date: latestScannedTradeDate || null,
    });

    const asOfTradeDate = latestScannedTradeDate || runDate;
    const summaryResult = await rebuildDivergenceSummariesForTradeDate({
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      asOfTradeDate,
      scanJobId,
    });
    summaryProcessedTickers = Number(summaryResult?.processedTickers || 0);

    const publishedTradeDate = await publishDivergenceTradeDate({
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
      tradeDate: asOfTradeDate,
      scanJobId,
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
      notes: `summary_tickers=${summaryProcessedTickers}`,
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
      summaryProcessedTickers,
    };
  } catch (err: any) {
    if (
      divergenceScanStopRequested ||
      (isAbortError(err) && scanAbortController.signal.aborted && !divergenceScanPauseRequested)
    ) {
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
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'stopped',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
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
        scanned_trade_date: latestScannedTradeDate || null,
      });
      return {
        status: 'paused',
        runDate,
        processed,
        bullishCount,
        bearishCount,
        errorCount,
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
      notes: String(err && err.message ? err.message : err || ''),
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

  const candidateDateStr = () =>
    `${candidate.getFullYear()}-${String(candidate.getMonth() + 1).padStart(2, '0')}-${String(candidate.getDate()).padStart(2, '0')}`;

  if (!tradingCalendar.isTradingDay(candidateDateStr()) || nowEt.getTime() >= candidate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    for (let i = 0; i < 15 && !tradingCalendar.isTradingDay(candidateDateStr()); i++) {
      candidate.setDate(candidate.getDate() + 1);
    }
  }

  return easternLocalToUtcMs(candidate.getFullYear(), candidate.getMonth() + 1, candidate.getDate(), 16, 20);
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
      sourceInterval: DIVERGENCE_SOURCE_INTERVAL,
    });
    console.log('Scheduled divergence table build completed after scan:', tableSummary);
  } catch (err: any) {
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
    } catch (err: any) {
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
  getIsFetchDailyDataRunning: () => fetchDailyScan.running,
  getIsFetchWeeklyDataRunning: () => fetchWeeklyScan.running,
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
  getFetchDailyDataStatus: () => fetchDailyScan.getStatus(),
  requestStopFetchDailyData: () => fetchDailyScan.requestStop(),
  canResumeFetchDailyData: () => fetchDailyScan.canResume(),
  getFetchWeeklyDataStatus: () => fetchWeeklyScan.getStatus(),
  requestStopFetchWeeklyData: () => fetchWeeklyScan.requestStop(),
  canResumeFetchWeeklyData: () => fetchWeeklyScan.canResume(),
  getVDFScanStatus: () => vdfScan.getStatus(),
  requestStopVDFScan: () => vdfScan.requestStop(),
  canResumeVDFScan: () => vdfScan.canResume(),
  runVDFScan,
  getIsVDFScanRunning: () => vdfScan.running,
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
    calendarInitialized: tradingCalendar.getStatus().initialized,
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
      inFlight: CHART_IN_FLIGHT_REQUESTS.size,
    },
    chartDebugMetrics,
    divergence: {
      configured: isDivergenceConfigured(),
      running: divergenceScanRunning,
      lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || '',
    },
    memoryUsage: process.memoryUsage(),
  });
}

function getHealthPayload() {
  return buildHealthPayload({
    isShuttingDown,
    nowIso: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
}

async function getReadyPayload() {
  return buildReadyPayload({
    pool,
    divergencePool: divergencePool as any,
    isDivergenceConfigured,
    isShuttingDown,
    divergenceScanRunning,
    lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || null,
  });
}

registerHealthRoutes({
  app,
  debugMetricsSecret: DEBUG_METRICS_SECRET,
  getDebugMetricsPayload,
  getHealthPayload,
  getReadyPayload,
});

const ALERT_RETENTION_DAYS = 30;
const PRUNE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function pruneOldAlerts() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - ALERT_RETENTION_DAYS);
    const result = await pool.query('DELETE FROM alerts WHERE created_at < $1', [cutoffDate]);
    if (result.rowCount && result.rowCount > 0) {
      console.log(`Pruned ${result.rowCount} old alerts created before ${cutoffDate.toISOString()}`);
    }
  } catch (err: any) {
    console.error('Failed to prune old alerts:', err.message);
  }
}

let server: any;
let pruneOldAlertsInitialTimer: any = null;
let pruneOldAlertsIntervalTimer: any = null;

(async function startServer() {
  try {
    await initDB();
    await initDivergenceDB();
  } catch (err: any) {
    console.error('Fatal: database initialization failed, exiting.', err);
    process.exit(1);
  }

  // Build trading calendar (non-fatal — falls back to weekday-only if API unreachable)
  await tradingCalendar
    .init({
      fetchDataApiJson,
      buildDataApiUrl,
      formatDateUTC,
      log: (msg: any) => console.log(`[TradingCalendar] ${msg}`),
    })
    .catch((err) => {
      console.warn(
        '[TradingCalendar] Init failed (non-fatal, using weekday fallback):',
        err && err.message ? err.message : err,
      );
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

async function shutdownServer(signal: any) {
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

  // Stop in-flight scans so they don't block shutdown
  fetchDailyScan.requestStop();
  fetchWeeklyScan.requestStop();
  vdfScan.requestStop();
  requestStopDivergenceScan();
  requestStopDivergenceTableBuild();

  const inFlightCount = CHART_IN_FLIGHT_REQUESTS.size;
  if (inFlightCount > 0) {
    console.log(`Shutdown: ${inFlightCount} in-flight chart requests will drain`);
  }

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15000);
  if (typeof forceExitTimer.unref === 'function') {
    forceExitTimer.unref();
  }

  try {
    await new Promise((resolve, reject) => {
      server.close((err: any) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
    console.log('HTTP server closed; draining database pools...');
    await Promise.allSettled([pool.end(), divergencePool ? divergencePool.end() : Promise.resolve()]);
    console.log('Shutdown complete');
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (err: any) {
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

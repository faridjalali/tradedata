import './server/telemetry.js';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyCompress from '@fastify/compress';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, ZodTypeProvider } from 'fastify-type-provider-zod';
import path from 'path';
import { registerChartRoutes } from './server/routes/chartRoutes.js';
import { registerDivergenceRoutes } from './server/routes/divergenceRoutes.js';
import { registerHealthRoutes } from './server/routes/healthRoutes.js';
import { registerAlertRoutes } from './server/routes/alertRoutes.js';
import { registerBreadthRoutes } from './server/routes/breadthRoutes.js';
import { registerAuthRoutes } from './server/routes/authRoutes.js';
import { initDB, initDivergenceDB } from './server/db/initDb.js';
import * as sessionAuth from './server/services/sessionAuth.js';
import * as tradingCalendar from './server/services/tradingCalendar.js';
import { metricsRegistry, httpRequestsTotal, httpRequestDurationMicroseconds } from './server/metrics.js';
import { buildDebugMetricsPayload, buildHealthPayload, buildReadyPayload } from './server/services/healthService.js';
import { barsToTuples, pointsToTuples, formatDateUTC } from './server/chartMath.js';
import * as chartPrewarm from './server/services/chartPrewarm.js';
import 'dotenv/config';
import {
  PORT,
  CORS_ORIGIN,
  SITE_LOCK_PASSCODE,
  SITE_LOCK_ENABLED,
  REQUEST_LOG_ENABLED,
  DEBUG_METRICS_SECRET,
  API_RATE_LIMIT_MAX,
  DIVERGENCE_SOURCE_INTERVAL,
  ALERT_RETENTION_DAYS,
  PRUNE_CHECK_INTERVAL_MS,
  validateStartupEnvironment,
  TRUST_PROXY,
  IS_PRODUCTION,
} from './server/config.js';
import { pool, divergencePool, isDivergenceConfigured } from './server/db.js';
import {
  logStructured,
  createRequestId,
  shouldLogRequestPath,
  extractSafeRequestMeta,
  isValidTickerSymbol,
  parseEtDateInput,
  parseBooleanInput,
  validateChartPayloadShape,
  validateChartLatestPayloadShape,
  basicAuthMiddleware,
} from './server/middleware.js';
import { rejectUnauthorized } from './server/routeGuards.js';
import {
  chartDebugMetrics,
  httpDebugMetrics,
  recordChartRequestTiming,
  getLogsRunMetricsPayload,
} from './server/services/metricsService.js';
import {
  miniBarsCacheByTicker,
  loadMiniChartBarsFromDb,
  loadMiniChartBarsFromDbBatch,
  fetchMiniChartBarsFromApi,
} from './server/services/miniBarService.js';
import { parseChartRequestParams, extractLatestChartPayload } from './server/services/chartRequestService.js';
import {
  divergenceLastFetchedTradeDateEt,
  canResumeDivergenceScan,
  canResumeDivergenceTableBuild,
  divergenceLastScanDateEt,
  divergenceScanRunning,
  divergenceSchedulerTimer,
  divergenceTableBuildRunning,
  fetchDailyScan,
  fetchWeeklyScan,
  getDivergenceScanControlStatus,
  getDivergenceTableBuildStatus,
  requestPauseDivergenceScan,
  requestPauseDivergenceTableBuild,
  requestStopDivergenceScan,
  requestStopDivergenceTableBuild,
  setDivergenceSchedulerTimer,
} from './server/services/scanControlService.js';
import { vdfScan, getVDFStatus, runVDFScan } from './server/services/vdfService.js';
import { getDivergenceSummaryForTickers } from './server/services/tickerHistoryService.js';
import { runDivergenceTableBuild } from './server/orchestrators/tableBuildOrchestrator.js';
import { runDivergenceFetchDailyData } from './server/orchestrators/fetchDailyOrchestrator.js';
import { runDivergenceFetchWeeklyData } from './server/orchestrators/fetchWeeklyOrchestrator.js';
import { runDailyDivergenceScan } from './server/orchestrators/dailyScanOrchestrator.js';
import { scheduleNextDivergenceScan, scheduleNextBreadthComputation } from './server/services/schedulerService.js';
import { initBreadthTables, getLatestBreadthSnapshots, isBreadthMa200Valid } from './server/data/breadthStore.js';
import { bootstrapBreadthHistory } from './server/services/breadthService.js';
import { startAlertRetentionScheduler } from './server/services/alertRetentionService.js';
import { scheduleBreadthAutoBootstrap } from './server/services/breadthBootstrapService.js';
import { ALL_BREADTH_INDICES } from './server/data/etfConstituents.js';

import { currentEtDateString } from './server/lib/dateUtils.js';
import {
  buildDataApiUrl,
  fetchDataApiJson,
  dataApiLatestQuote,
  getDataApiCircuitBreakerInfo,
  resetDataApiCircuitBreaker,
  fetchTickerReference,
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
  CHART_TIMING_LOG_ENABLED,
  CHART_IN_FLIGHT_MAX,
  getTimedCacheValue,
  setTimedCacheValue,
  getChartResultCacheExpiryMs,
  dataApiIntradayChartHistory,
  getIntradayLookbackDays,
  patchLatestBarCloseWithQuote,
  toVolumeDeltaSourceInterval,
  buildChartRequestKey,
  createChartStageTimer,
  sendChartJsonResponse,
  buildChartResultFromRows,
} from './server/services/chartEngine.js';

// Extend FastifyRequest with per-request tracing fields.
declare module 'fastify' {
  interface FastifyRequest {
    requestId?: string;
    _logStartNs?: bigint;
  }
}

interface HttpError extends Error {
  httpStatus: number;
}

const app = Fastify({
  trustProxy: TRUST_PROXY,
  bodyLimit: 1048576,
}).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// Allow empty bodies with Content-Type: application/json (Fastify rejects by default)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  const text = ((body as string) || '').trim();
  if (!text) return done(null, {});
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    done(err as Error, undefined);
  }
});
const port = Number(PORT) || 3000;

let isShuttingDown = false;
const startedAtMs = Date.now();
let stopAlertRetentionScheduler: (() => void) | null = null;
let cancelBreadthBootstrap: (() => void) | null = null;

validateStartupEnvironment();

// --- Plugin registration ---
await app.register(fastifySwagger, {
  openapi: {
    info: {
      title: 'TradeData Internal API',
      description: 'Internal backend services and REST endpoints for TradeData.',
      version: '1.0.0',
    },
    components: {},
  },
  transform: jsonSchemaTransform,
});

await app.register(fastifySwaggerUi, {
  routePrefix: '/docs',
});

await app.register(
  fastifyCors,
  CORS_ORIGIN ? { origin: CORS_ORIGIN.split(',').map((o: string) => o.trim()), credentials: true } : { origin: false },
);

import crypto from 'crypto';

// Fastify reply decorator for nonces
declare module 'fastify' {
  interface FastifyReply {
    cspNonce: { script: string; style: string };
  }
}

app.addHook('onRequest', async (request, reply) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  reply.cspNonce = { script: nonce, style: nonce };
});

await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        (req: any, res: any) => {
          const nonce = res.cspNonce?.script;
          return nonce ? `'nonce-${nonce}'` : '';
        },
        'https://cdn.jsdelivr.net',
        'https://unpkg.com',
      ].filter(Boolean) as string[],
      styleSrc: [
        "'self'",
        (req: any, res: any) => {
          const nonce = res.cspNonce?.style;
          return nonce ? `'nonce-${nonce}'` : '';
        },
        'https://fonts.googleapis.com',
      ].filter(Boolean) as string[],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'sameorigin' },
});

// Inject nonce into the statically served index.html
app.addHook('onSend', async (request, reply, payload) => {
  // fastify-static serves files as streams
  if (reply.getHeader('content-type')?.toString().includes('text/html') && typeof payload === 'string') {
    const nonce = reply.cspNonce?.script;
    if (!nonce) return payload;
    let modified = payload.replace(/<script /g, `<script nonce="${nonce}" `);
    modified = modified.replace(/<style /g, `<style nonce="${nonce}" `);
    return modified;
  }
  return payload;
});

await app.register(fastifyRateLimit, {
  max: API_RATE_LIMIT_MAX,
  timeWindow: 15 * 60 * 1000,
  allowList: (req: { url?: string }) => {
    const path = String(req.url || '').split('?')[0];
    // Exempt non-API paths, health checks, and scan status polling
    return (
      !path.startsWith('/api/') ||
      path.startsWith('/api/health') ||
      path.startsWith('/api/ready') ||
      path === '/api/divergence/scan/status'
    );
  },
});

await app.register(fastifyCompress);
await app.register(fastifyCookie);
await app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'dist'),
  maxAge: '1y',
  immutable: true,
});

// --- Hooks (middleware replacements) ---

// Basic auth
app.addHook('onRequest', async (request, reply) => {
  basicAuthMiddleware(request, reply);
});

// Protect non-API operational routes with debug secret in production.
app.addHook('onRequest', async (request, reply) => {
  const urlPath = request.url.split('?')[0];
  const isOperationalPath = urlPath === '/metrics' || urlPath.startsWith('/docs');
  if (!isOperationalPath) return;
  if (!DEBUG_METRICS_SECRET && IS_PRODUCTION) {
    return reply.code(503).send({ error: 'Operational route secret is not configured' });
  }
  if (rejectUnauthorized(request, reply, DEBUG_METRICS_SECRET)) return;
});

// Session-based site lock auth (auth routes are exempt)
const SESSION_AUTH_EXEMPT = ['/api/auth/', '/api/health', '/api/ready'];
app.addHook('onRequest', async (request, reply) => {
  if (!SITE_LOCK_ENABLED) return;
  const urlPath = request.url.split('?')[0];
  if (!urlPath.startsWith('/api/')) return;
  if (SESSION_AUTH_EXEMPT.some((prefix) => urlPath.startsWith(prefix))) return;
  const token = sessionAuth.parseCookieValue(request);
  const isValid = await sessionAuth.validateSession(token);
  if (isValid) return;
  return reply.code(401).send({ error: 'Not authenticated' });
});

// Shutdown guard
app.addHook('onRequest', async (request, reply) => {
  if (!isShuttingDown) return;
  reply.header('Connection', 'close');
  return reply.code(503).send({ error: 'Server is shutting down' });
});

// Request ID + logging
app.addHook('onRequest', async (request, reply) => {
  const requestId = String(request.headers['x-request-id'] || '').trim() || createRequestId();
  request.requestId = requestId;
  reply.header('x-request-id', requestId);

  httpDebugMetrics.totalRequests += 1;
  const urlPath = request.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    httpDebugMetrics.apiRequests += 1;
  }

  if (REQUEST_LOG_ENABLED && shouldLogRequestPath(urlPath)) {
    request._logStartNs = process.hrtime.bigint();
    logStructured('info', 'request_start', {
      requestId,
      ...extractSafeRequestMeta(request),
    });
  }
});

app.addHook('onResponse', async (request, reply) => {
  const startedNs = request._logStartNs;
  if (!startedNs) return;
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  const urlPath = request.url.split('?')[0];

  httpRequestsTotal.inc({ method: request.method, route: urlPath, status_code: reply.statusCode });
  httpRequestDurationMicroseconds.observe(
    { method: request.method, route: urlPath, status_code: reply.statusCode },
    durationMs / 1000,
  );

  logStructured('info', 'request_end', {
    requestId: request.requestId,
    statusCode: reply.statusCode,
    durationMs: Number(durationMs.toFixed(1)),
    ...extractSafeRequestMeta(request),
  });
});

// --- Auth routes ---
registerAuthRoutes({
  app,
  siteLockEnabled: SITE_LOCK_ENABLED,
  siteLockPasscode: SITE_LOCK_PASSCODE,
  sessionAuth,
});

registerAlertRoutes(app);

registerBreadthRoutes(app);

app.get('/metrics', async (_request, reply) => {
  reply.header('Content-Type', metricsRegistry.contentType);
  return reply.send(await metricsRegistry.metrics());
});

const prewarmDeps = {
  getOrBuildChartResult: (params: Record<string, unknown>) => getOrBuildChartResult(params),
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

const CHART_BUILD_TIMEOUT_MS = 45_000;

function withChartTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        const err = Object.assign(new Error(`Chart build timed out after ${CHART_BUILD_TIMEOUT_MS}ms (${label})`), {
          httpStatus: 503,
        }) as HttpError;
        reject(err);
      }, CHART_BUILD_TIMEOUT_MS),
    ),
  ]);
}

async function getOrBuildChartResult(params: Record<string, unknown>) {
  const ticker = String(params.ticker || '');
  if (!isValidTickerSymbol(ticker)) {
    throw Object.assign(new Error('Invalid ticker format'), { httpStatus: 400 }) as HttpError;
  }
  const interval = String(params.interval || '');
  const vdRsiLength = Number(params.vdRsiLength) || 14;
  const vdSourceInterval = String(params.vdSourceInterval || '');
  const vdRsiSourceInterval = String(params.vdRsiSourceInterval || '');
  const lookbackDays = Number(params.lookbackDays) || 0;
  const requestKey = String(params.requestKey || '');
  const skipFollowUpPrewarm = Boolean(params.skipFollowUpPrewarm);
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
    if (CHART_TIMING_LOG_ENABLED) console.log(`[chart-cache] ${ticker} ${interval} hit key=${requestKey}`);
    return { result: cachedFinalResult.value, serverTiming: 'cache_hit;dur=0.1,total;dur=0.1', cacheHit: true };
  }
  let buildPromise = CHART_IN_FLIGHT_REQUESTS.get(requestKey);
  const isDedupedWait = Boolean(buildPromise);
  chartDebugMetrics.cacheMiss += 1;
  if (isDedupedWait) chartDebugMetrics.dedupeJoin += 1;
  else chartDebugMetrics.buildStarted += 1;
  if (!buildPromise) {
    if (CHART_IN_FLIGHT_REQUESTS.size >= CHART_IN_FLIGHT_MAX) {
      throw Object.assign(new Error('Server is busy processing chart requests, please retry shortly'), {
        httpStatus: 503,
      }) as HttpError;
    }
    buildPromise = (async () => {
      const timer = createChartStageTimer();
      const requiredIntervals = Array.from(new Set([interval, vdSourceInterval, vdRsiSourceInterval]));
      const rowsByInterval = new Map();
      const quotePromise = dataApiLatestQuote(ticker).catch((err) => {
        if (CHART_TIMING_LOG_ENABLED)
          console.warn(
            `[chart-quote] ${ticker} ${interval} skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        return null;
      });
      await Promise.all(
        requiredIntervals.map(async (tf) => {
          rowsByInterval.set(tf, (await dataApiIntradayChartHistory(ticker, tf, lookbackDays)) || []);
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
      patchLatestBarCloseWithQuote(result, quote as { price?: number } | null);
      if (quote) timer.step('quote_patch');
      setTimedCacheValue(CHART_FINAL_RESULT_CACHE, requestKey, result, getChartResultCacheExpiryMs(new Date()));
      if (!skipFollowUpPrewarm) {
        if (interval === '4hour') chartDebugMetrics.prewarmRequested.dailyFrom4hour += 1;
        else if (interval === '1day') {
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
      if (CHART_TIMING_LOG_ENABLED)
        console.log(
          `[chart-timing] ${ticker} ${interval} ${isDedupedWait ? 'dedupe-wait' : 'build'} ${timer.summary()}`,
        );
      return { result, serverTiming };
    })();
    CHART_IN_FLIGHT_REQUESTS.set(requestKey, buildPromise);
    buildPromise
      .finally(() => {
        if (CHART_IN_FLIGHT_REQUESTS.get(requestKey) === buildPromise) CHART_IN_FLIGHT_REQUESTS.delete(requestKey);
      })
      .catch(() => {});
  }
  const { result, serverTiming } = (await withChartTimeout(buildPromise, `${ticker}/${interval}`)) as {
    result: unknown;
    serverTiming: string;
  };
  if (isDedupedWait && CHART_TIMING_LOG_ENABLED)
    console.log(`[chart-dedupe] ${ticker} ${interval} request joined in-flight key=${requestKey}`);
  return { result, serverTiming, cacheHit: false };
}

// --- Route registrations ---
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
  fetchTickerReference,
});

registerDivergenceRoutes({
  app,
  isDivergenceConfigured,
  divergenceScanSecret: process.env.DIVERGENCE_SCAN_SECRET,
  getIsScanRunning: () => divergenceScanRunning,
  getIsFetchDailyDataRunning: () => fetchDailyScan.isRunning,
  getIsFetchWeeklyDataRunning: () => fetchWeeklyScan.isRunning,
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
  getIsVDFScanRunning: () => vdfScan.isRunning,
});

app.get('/api/logs/run-metrics', async (request, reply) => {
  return reply.send(getLogsRunMetricsPayload());
});

app.get('/api/trading-calendar/context', async (request, reply) => {
  const today = currentEtDateString();
  const isTodayTradingDay = tradingCalendar.isTradingDay(today);
  const lastTradingDay = isTodayTradingDay ? today : tradingCalendar.previousTradingDay(today);
  let cursor = today;
  for (let i = 0; i < 5; i++) cursor = tradingCalendar.previousTradingDay(cursor);
  return reply.send({
    today,
    lastTradingDay,
    tradingDay5Back: cursor,
    isTodayTradingDay,
    calendarInitialized: tradingCalendar.getStatus().initialized,
  });
});

function getDebugMetricsPayload() {
  const base = buildDebugMetricsPayload({
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
    chartDebugMetrics: chartDebugMetrics as unknown as Record<string, unknown>,
    divergence: {
      configured: isDivergenceConfigured(),
      running: divergenceScanRunning,
      lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || '',
    },
    memoryUsage: process.memoryUsage(),
  });
  return { ...base, circuitBreaker: getDataApiCircuitBreakerInfo() };
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
    divergencePool: divergencePool ?? undefined,
    isDivergenceConfigured,
    isShuttingDown,
    divergenceScanRunning,
    lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || null,
    circuitBreakerInfo: getDataApiCircuitBreakerInfo(),
    getPoolStats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: 20 }),
  });
}

registerHealthRoutes({
  app,
  debugMetricsSecret: DEBUG_METRICS_SECRET,
  getDebugMetricsPayload,
  getHealthPayload,
  getReadyPayload,
});

// Circuit breaker manual reset (admin only — requires debug secret)
app.post('/api/admin/circuit-breaker/reset', (request, reply) => {
  if (rejectUnauthorized(request, reply, DEBUG_METRICS_SECRET)) return;
  resetDataApiCircuitBreaker();
  return reply.code(200).send({ ok: true, circuitBreaker: getDataApiCircuitBreakerInfo() });
});

// SPA fallback — serve index.html for non-API, non-file routes
app.setNotFoundHandler(async (request, reply) => {
  const urlPath = request.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    return reply.code(404).send({ error: 'Not found' });
  }
  return reply.sendFile('index.html');
});

// --- Startup ---

try {
  await initDB();
  await initDivergenceDB();
  if (divergencePool) await initBreadthTables();
} catch (err: unknown) {
  console.error('Fatal: database initialization failed, exiting.', err);
  process.exit(1);
}

await tradingCalendar
  .init({
    fetchDataApiJson,
    buildDataApiUrl,
    formatDateUTC,
    log: (msg: string) => console.log(`[TradingCalendar] ${msg}`),
  })
  .catch((err) => {
    console.warn(
      '[TradingCalendar] Init failed (non-fatal, using weekday fallback):',
      err instanceof Error ? err.message : String(err),
    );
  });

await app.listen({ port, host: '0.0.0.0' });
console.log(`Server running on port ${port}`);
if (SITE_LOCK_ENABLED) {
  console.log('[siteLock] Passcode lock ENABLED');
} else {
  console.warn('[siteLock] WARNING: SITE_LOCK_PASSCODE is not set — site is publicly accessible without a passcode');
}
scheduleNextDivergenceScan();
scheduleNextBreadthComputation();
const alertRetention = startAlertRetentionScheduler({
  pool,
  retentionDays: ALERT_RETENTION_DAYS,
  checkIntervalMs: PRUNE_CHECK_INTERVAL_MS,
});
stopAlertRetentionScheduler = alertRetention.stop;

// Auto-bootstrap breadth — delayed 15 s after startup so the server is fully
// warm before the heavy data-fetch begins. Runs only when data is absent or
// the 200d MA history contains zeros (stale bootstrap with insufficient history).
if (divergencePool) {
  const breadthBootstrap = scheduleBreadthAutoBootstrap({
    allIndices: ALL_BREADTH_INDICES,
    getLatestBreadthSnapshots,
    isBreadthMa200Valid,
    bootstrapBreadthHistory,
  });
  cancelBreadthBootstrap = breadthBootstrap.cancel;
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdownServer('uncaughtException');
});

async function shutdownServer(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully...`);

  if (divergenceSchedulerTimer) {
    clearTimeout(divergenceSchedulerTimer);
    setDivergenceSchedulerTimer(null);
  }
  if (stopAlertRetentionScheduler) {
    stopAlertRetentionScheduler();
    stopAlertRetentionScheduler = null;
  }
  if (cancelBreadthBootstrap) {
    cancelBreadthBootstrap();
    cancelBreadthBootstrap = null;
  }
  tradingCalendar.destroy();
  clearInterval(vdRsiCacheCleanupTimer);

  fetchDailyScan.requestStop();
  fetchWeeklyScan.requestStop();
  vdfScan.requestStop();
  requestStopDivergenceScan();
  requestStopDivergenceTableBuild();

  const inFlightCount = CHART_IN_FLIGHT_REQUESTS.size;
  if (inFlightCount > 0) console.log(`Shutdown: ${inFlightCount} in-flight chart requests will drain`);

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15000);
  if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

  try {
    await app.close();
    console.log('HTTP server closed; draining database pools...');
    const poolsToClose = Array.from(
      new Set(
        [pool, divergencePool].filter((candidate): candidate is NonNullable<typeof divergencePool> =>
          Boolean(candidate),
        ),
      ),
    );
    await Promise.allSettled(poolsToClose.map((p) => p.end()));
    console.log('Shutdown complete');
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (err: unknown) {
    console.error(`Graceful shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
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

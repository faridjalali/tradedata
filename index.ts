import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyCompress from '@fastify/compress';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import path from 'path';
import { registerChartRoutes } from './server/routes/chartRoutes.js';
import { registerDivergenceRoutes } from './server/routes/divergenceRoutes.js';
import { registerHealthRoutes } from './server/routes/healthRoutes.js';
import * as sessionAuth from './server/services/sessionAuth.js';
import * as tradingCalendar from './server/services/tradingCalendar.js';
import { buildDebugMetricsPayload, buildHealthPayload, buildReadyPayload } from './server/services/healthService.js';
import {
  barsToTuples,
  pointsToTuples,
  formatDateUTC,
} from './server/chartMath.js';
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
  timingSafeStringEqual,
  basicAuthMiddleware,
} from './server/middleware.js';
import {
  chartDebugMetrics,
  httpDebugMetrics,
  recordChartRequestTiming,
  loadRunHistoryFromDb,
  runMetricsHistory,
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
  getStoredDivergenceSummariesForTickers,
  buildNeutralDivergenceStateMap,
} from './server/services/divergenceStateService.js';
import { getPublishedTradeDateForSourceInterval } from './server/services/divergenceDbService.js';
import {
  canResumeDivergenceScan,
  canResumeDivergenceTableBuild,
  divergenceLastFetchedTradeDateEt,
  divergenceLastScanDateEt,
  divergenceScanRunning,
  divergenceSchedulerTimer,
  divergenceTableBuildRunning,
  fetchDailyScan,
  fetchWeeklyScan,
  getDivergenceScanControlStatus,
  getDivergenceTableBuildStatus,
  normalizeFetchDailyDataResumeState,
  normalizeFetchWeeklyDataResumeState,
  requestPauseDivergenceScan,
  requestPauseDivergenceTableBuild,
  requestStopDivergenceScan,
  requestStopDivergenceTableBuild,
  setDivergenceLastFetchedTradeDateEt,
  setDivergenceSchedulerTimer,
} from './server/services/scanControlService.js';
import { vdfRunningTickers, vdfScan, getVDFStatus, runVDFScan } from './server/services/vdfService.js';
import { getDivergenceSummaryForTickers } from './server/services/tickerHistoryService.js';
import { runDivergenceTableBuild } from './server/orchestrators/tableBuildOrchestrator.js';
import { runDivergenceFetchDailyData } from './server/orchestrators/fetchDailyOrchestrator.js';
import { runDivergenceFetchWeeklyData } from './server/orchestrators/fetchWeeklyOrchestrator.js';
import { runDailyDivergenceScan } from './server/orchestrators/dailyScanOrchestrator.js';
import { scheduleNextDivergenceScan, scheduleNextBreadthComputation } from './server/services/schedulerService.js';
import { initBreadthTables, getLatestBreadthSnapshots, isBreadthMa200Valid } from './server/data/breadthStore.js';
import { runBreadthComputation, bootstrapBreadthHistory, getLatestBreadthData, cleanupBreadthData } from './server/services/breadthService.js';

import { currentEtDateString, maxEtDateString, dateKeyDaysAgo } from './server/lib/dateUtils.js';
import { buildDataApiUrl, fetchDataApiJson, dataApiDaily, dataApiLatestQuote, getDataApiCircuitBreakerInfo, resetDataApiCircuitBreaker } from './server/services/dataApi.js';
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
  getSpyDaily,
  getSpyIntraday,
  buildIntradayBreadthPoints,
} from './server/services/chartEngine.js';

const app = Fastify({
  trustProxy: true,
  bodyLimit: 1048576,
});

// Allow empty bodies with Content-Type: application/json (Fastify rejects by default)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  const text = (body as string || '').trim();
  if (!text) return done(null, {});
  try { done(null, JSON.parse(text)); }
  catch (err) { done(err as Error, undefined); }
});
const port = Number(PORT) || 3000;

let isShuttingDown = false;
const startedAtMs = Date.now();

validateStartupEnvironment();

// --- Plugin registration ---
await app.register(fastifyCors, CORS_ORIGIN
  ? { origin: CORS_ORIGIN.split(',').map((o: string) => o.trim()), credentials: true }
  : { origin: false },
);

await app.register(fastifyHelmet, {
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
});

await app.register(fastifyRateLimit, {
  max: API_RATE_LIMIT_MAX,
  timeWindow: 15 * 60 * 1000,
  allowList: (req: { url?: string }) => {
    const path = String(req.url || '').split('?')[0];
    // Exempt non-API paths, auth endpoints, health checks, and scan status polling
    return !path.startsWith('/api/')
      || path.startsWith('/api/auth/')
      || path.startsWith('/api/health')
      || path.startsWith('/api/ready')
      || path === '/api/divergence/scan/status';
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

// Session-based site lock auth (auth routes are exempt)
const SESSION_AUTH_EXEMPT = ['/api/auth/', '/api/health', '/api/ready'];
app.addHook('onRequest', async (request, reply) => {
  if (!SITE_LOCK_ENABLED) return;
  const urlPath = request.url.split('?')[0];
  if (!urlPath.startsWith('/api/')) return;
  if (SESSION_AUTH_EXEMPT.some((prefix) => urlPath.startsWith(prefix))) return;
  const token = sessionAuth.parseCookieValue(request);
  if (sessionAuth.validateSession(token)) return;
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
  (request as any).requestId = requestId;
  reply.header('x-request-id', requestId);

  httpDebugMetrics.totalRequests += 1;
  const urlPath = request.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    httpDebugMetrics.apiRequests += 1;
  }

  if (REQUEST_LOG_ENABLED && shouldLogRequestPath(urlPath)) {
    (request as any)._logStartNs = process.hrtime.bigint();
    logStructured('info', 'request_start', {
      requestId,
      ...extractSafeRequestMeta(request),
    });
  }
});

app.addHook('onResponse', async (request, reply) => {
  const startedNs = (request as any)._logStartNs;
  if (!startedNs) return;
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  logStructured('info', 'request_end', {
    requestId: (request as any).requestId,
    statusCode: reply.statusCode,
    durationMs: Number(durationMs.toFixed(1)),
    ...extractSafeRequestMeta(request),
  });
});

// --- Auth routes ---
app.post('/api/auth/verify', async (request, reply) => {
  const passcode = String(((request.body as any)?.passcode) || '').trim();
  if (!SITE_LOCK_ENABLED || !passcode) {
    return reply.code(401).send({ error: 'Invalid passcode' });
  }
  if (!timingSafeStringEqual(passcode, SITE_LOCK_PASSCODE)) {
    return reply.code(401).send({ error: 'Invalid passcode' });
  }
  const token = sessionAuth.createSession();
  sessionAuth.setSessionCookie(reply, token);
  return reply.code(200).send({ status: 'ok' });
});

app.get('/api/auth/check', async (request, reply) => {
  if (!SITE_LOCK_ENABLED) return reply.code(200).send({ status: 'ok' });
  const token = sessionAuth.parseCookieValue(request);
  if (sessionAuth.validateSession(token)) {
    return reply.code(200).send({ status: 'ok' });
  }
  return reply.code(401).send({ error: 'Not authenticated' });
});

app.post('/api/auth/logout', async (request, reply) => {
  const token = sessionAuth.parseCookieValue(request);
  sessionAuth.destroySession(token);
  sessionAuth.clearSessionCookie(reply);
  return reply.code(200).send({ status: 'ok' });
});

// --- DB init ---
const initDB = async () => {
  try {
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

    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_timestamp ON alerts (timestamp DESC)`);

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
    await divergencePool.query(`ALTER TABLE divergence_scan_jobs ADD COLUMN IF NOT EXISTS scanned_trade_date DATE`);
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
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma8_above BOOLEAN`);
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma21_above BOOLEAN`);
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma50_above BOOLEAN`);
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma200_above BOOLEAN`);
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
    await divergencePool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'htf_results') THEN
          DROP TABLE IF EXISTS htf_results;
        END IF;
      END $$;
    `);
    await divergencePool.query(`
      DO $$ BEGIN
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS best_zone_score REAL DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS proximity_score REAL DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS proximity_level VARCHAR(10) DEFAULT 'none';
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS num_zones INTEGER DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS has_distribution BOOLEAN DEFAULT FALSE;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS bull_flag_confidence SMALLINT;
      END $$;
    `);

    // --- Performance indexes (idempotent, safe to re-run) ---

    // vdf_results: alert enrichment queries filter by (trade_date, is_detected) + ticker IN (...)
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS vdf_results_detected_idx
      ON vdf_results(trade_date, is_detected) WHERE is_detected = TRUE;
    `);

    // divergence_signals: CTE queries filter by (trade_date range, timeframe) with ORDER BY trade_date DESC
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_signals_trade_date_timeframe_idx
      ON divergence_signals(trade_date DESC, timeframe, source_interval);
    `);

    // divergence_signals: favorite toggle and id lookups
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_signals_is_favorite_idx
      ON divergence_signals(is_favorite) WHERE is_favorite = TRUE;
    `);

    // divergence_symbols: universe queries always filter is_active = TRUE
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_symbols_active_idx
      ON divergence_symbols(ticker) WHERE is_active = TRUE;
    `);

    // divergence_scan_jobs: status polling queries ORDER BY finished_at DESC
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_scan_jobs_finished_idx
      ON divergence_scan_jobs(finished_at DESC NULLS LAST);
    `);

    // mini_chart_bars: batch lookups by ticker with ORDER BY trade_date
    // (Primary key is (ticker, trade_date) which already covers single-ticker lookups,
    //  but batch IN queries benefit from this ordering.)
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS mini_chart_bars_ticker_idx
      ON mini_chart_bars(ticker);
    `);

    try {
      const pubResult = await divergencePool.query(
        `SELECT published_trade_date::text AS trade_date FROM divergence_publication_state WHERE source_interval = $1 LIMIT 1`,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      const restoredTradeDate = String(pubResult.rows[0]?.trade_date || '').trim();
      if (restoredTradeDate) {
        setDivergenceLastFetchedTradeDateEt(maxEtDateString(divergenceLastFetchedTradeDateEt, restoredTradeDate));
        fetchDailyScan._status.lastPublishedTradeDate = maxEtDateString(
          fetchDailyScan._status.lastPublishedTradeDate,
          restoredTradeDate,
        );
        fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan._status.lastPublishedTradeDate });
      }
      const weeklyResult = await divergencePool.query(
        `SELECT MAX(trade_date)::text AS trade_date FROM divergence_signals WHERE timeframe = '1w' AND source_interval = $1`,
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

// --- Alert & signal routes ---
app.get('/api/alerts', async (request, reply) => {
  try {
    const q = request.query as Record<string, unknown>;
    const days = parseInt(String(q.days)) || 0;
    const startDate = String(q.start_date || '').trim();
    const endDate = String(q.end_date || '').trim();
    const isValidCalendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
    const hasDateKeyRange = isValidCalendarDate(startDate) && isValidCalendarDate(endDate);

    let query = 'SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100';
    let values: unknown[] = [];

    if (hasDateKeyRange) {
      query = `
          SELECT * FROM alerts
          WHERE timestamp >= ($1 || ' 00:00:00 America/New_York')::timestamptz
            AND timestamp < ($2 || ' 00:00:00 America/New_York')::timestamptz + INTERVAL '1 day'
          ORDER BY timestamp DESC LIMIT 500`;
      values = [startDate, endDate];
    } else if (startDate && endDate) {
      query = `SELECT * FROM alerts WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 500`;
      values = [startDate, endDate];
    } else if (days > 0) {
      query = `SELECT * FROM alerts WHERE timestamp >= NOW() - $1::interval ORDER BY timestamp DESC LIMIT 500`;
      values = [`${days} days`];
    }

    const result = await pool.query(query, values);
    const sourceInterval = toVolumeDeltaSourceInterval(q.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
    const tickers = Array.from(
      new Set(result.rows.map((row) => String(row?.ticker || '').trim().toUpperCase()).filter(Boolean)),
    );
    let summariesByTicker = new Map();
    try {
      summariesByTicker = await getStoredDivergenceSummariesForTickers(tickers, sourceInterval, {
        includeLatestFallbackForMissing: true,
      });
    } catch (summaryErr: any) {
      const message = summaryErr?.message || String(summaryErr);
      console.error(`Failed to enrich TV alerts with divergence summaries: ${message}`);
    }
    const neutralStates = buildNeutralDivergenceStateMap();
    let vdfDataMapTv = new Map();
    try {
      if (tickers.length > 0 && isDivergenceConfigured()) {
        const vdfTradeDate = currentEtDateString();
        const vdfRes = await divergencePool!.query(
          `SELECT ticker, best_zone_score, proximity_level, num_zones, bull_flag_confidence FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
          [vdfTradeDate, tickers],
        );
        for (const row of vdfRes.rows) {
          vdfDataMapTv.set(String(row.ticker).toUpperCase(), {
            score: Math.min(100, Math.round((Number(row.best_zone_score) || 0) * 100)),
            proximityLevel: row.proximity_level || 'none',
            numZones: Number(row.num_zones) || 0,
            bullFlagConfidence: row.bull_flag_confidence != null ? Number(row.bull_flag_confidence) : null,
          });
        }
      }
    } catch { /* Non-critical */ }
    const enrichedRows = result.rows.map((row) => {
      const ticker = String(row?.ticker || '').trim().toUpperCase();
      const summary = summariesByTicker.get(ticker) || null;
      const states = summary?.states || neutralStates;
      const vdfData = vdfDataMapTv.get(ticker);
      return {
        ...row,
        divergence_trade_date: summary?.tradeDate || null,
        ma_states: { ema8: Boolean(summary?.maStates?.ema8), ema21: Boolean(summary?.maStates?.ema21), sma50: Boolean(summary?.maStates?.sma50), sma200: Boolean(summary?.maStates?.sma200) },
        divergence_states: { 1: String(states['1'] || 'neutral'), 3: String(states['3'] || 'neutral'), 7: String(states['7'] || 'neutral'), 14: String(states['14'] || 'neutral'), 28: String(states['28'] || 'neutral') },
        vdf_detected: !!vdfData, vdf_score: vdfData?.score || 0, vdf_proximity: vdfData?.proximityLevel || 'none',
        bull_flag_confidence: vdfData?.bullFlagConfidence ?? null,
      };
    });
    return reply.send(enrichedRows);
  } catch (err: any) {
    console.error(err);
    return reply.code(500).send('Server Error');
  }
});

app.post('/api/alerts/:id/favorite', async (request, reply) => {
  const id = parseInt((request.params as any).id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid alert ID' });
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  const is_favorite = body.is_favorite;
  try {
    let query; let values;
    if (typeof is_favorite === 'boolean') {
      query = 'UPDATE alerts SET is_favorite = $1 WHERE id = $2 RETURNING *';
      values = [is_favorite, id];
    } else {
      query = 'UPDATE alerts SET is_favorite = NOT is_favorite WHERE id = $1 RETURNING *';
      values = [id];
    }
    const result = await pool.query(query, values);
    if (result.rows.length === 0) return reply.code(404).send('Alert not found');
    return reply.send(result.rows[0]);
  } catch (err: any) {
    console.error('Error toggling favorite:', err);
    return reply.code(500).send('Server Error');
  }
});

app.get('/api/divergence/signals', async (request, reply) => {
  if (!isDivergenceConfigured()) return reply.code(503).send({ error: 'Divergence database is not configured' });
  try {
    const q = request.query as Record<string, unknown>;
    const days = parseInt(String(q.days)) || 0;
    const startDate = String(q.start_date || '').trim();
    const endDate = String(q.end_date || '').trim();
    const isValidCalendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
    const hasDateKeyRange = isValidCalendarDate(startDate) && isValidCalendarDate(endDate);
    const timeframeParam = q.timeframe;
    const allowedTimeframes = timeframeParam === '1d' ? ['1d'] : timeframeParam === '1w' ? ['1w'] : ['1d', '1w'];
    const publishedTradeDate = await getPublishedTradeDateForSourceInterval(DIVERGENCE_SOURCE_INTERVAL);
    if (!publishedTradeDate && divergenceScanRunning) return reply.send([]);

    const PER_TIMEFRAME_SIGNAL_LIMIT = 3029;
    let query = 'SELECT * FROM divergence_signals ORDER BY timestamp DESC LIMIT 100';
    let values: unknown[] = [];

    if (hasDateKeyRange) {
      query = `
        WITH filtered AS (
          SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
            ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
          FROM divergence_signals
          WHERE trade_date >= $1::date AND trade_date <= $2::date AND timeframe = ANY($5::text[])
            AND ($3::date IS NULL OR trade_date <= $3::date)
        )
        SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
        FROM filtered WHERE timeframe_rank <= $4 ORDER BY trade_date DESC, timestamp DESC`;
      values = [startDate, endDate, publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
    } else if (days > 0) {
      const lookbackDays = Math.max(1, Math.floor(Number(days) || 1));
      const endTradeDate = currentEtDateString();
      const startTradeDate = dateKeyDaysAgo(endTradeDate, lookbackDays - 1) || endTradeDate;
      query = `
        WITH filtered AS (
          SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
            ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
          FROM divergence_signals
          WHERE trade_date >= $1::date AND trade_date <= $2::date AND timeframe = ANY($5::text[])
            AND ($3::date IS NULL OR trade_date <= $3::date)
        )
        SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
        FROM filtered WHERE timeframe_rank <= $4 ORDER BY trade_date DESC, timestamp DESC`;
      values = [startTradeDate, endTradeDate, publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
    } else {
      query = `
        WITH filtered AS (
          SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
            ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
          FROM divergence_signals
          WHERE timeframe = ANY($3::text[]) AND ($1::date IS NULL OR trade_date <= $1::date)
        )
        SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
        FROM filtered WHERE timeframe_rank <= $2 ORDER BY trade_date DESC, timestamp DESC`;
      values = [publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
    }

    const result = await divergencePool!.query(query, values);
    const sourceInterval = toVolumeDeltaSourceInterval(q.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
    const tickers = Array.from(
      new Set(result.rows.map((row) => String(row?.ticker || '').trim().toUpperCase()).filter(Boolean)),
    );
    let summariesByTicker = new Map();
    try {
      summariesByTicker = await getStoredDivergenceSummariesForTickers(tickers, sourceInterval, {
        includeLatestFallbackForMissing: true,
      });
    } catch (summaryErr: any) {
      console.error(`Failed to enrich divergence signals with divergence summaries: ${summaryErr?.message || summaryErr}`);
    }
    const neutralStates = buildNeutralDivergenceStateMap();
    let vdfDataMap = new Map();
    try {
      if (tickers.length > 0) {
        const vdfTradeDate = currentEtDateString();
        const vdfRes = await divergencePool!.query(
          `SELECT ticker, best_zone_score, proximity_level, num_zones, bull_flag_confidence FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
          [vdfTradeDate, tickers],
        );
        for (const row of vdfRes.rows) {
          vdfDataMap.set(String(row.ticker).toUpperCase(), {
            score: Math.min(100, Math.round((Number(row.best_zone_score) || 0) * 100)),
            proximityLevel: row.proximity_level || 'none',
            numZones: Number(row.num_zones) || 0,
            bullFlagConfidence: row.bull_flag_confidence != null ? Number(row.bull_flag_confidence) : null,
          });
        }
      }
    } catch { /* Non-critical */ }
    const enrichedRows = result.rows.map((row) => {
      const ticker = String(row?.ticker || '').trim().toUpperCase();
      const summary = summariesByTicker.get(ticker) || null;
      const states = summary?.states || neutralStates;
      const vdfData = vdfDataMap.get(ticker);
      return {
        ...row,
        divergence_trade_date: summary?.tradeDate || null,
        ma_states: { ema8: Boolean(summary?.maStates?.ema8), ema21: Boolean(summary?.maStates?.ema21), sma50: Boolean(summary?.maStates?.sma50), sma200: Boolean(summary?.maStates?.sma200) },
        divergence_states: { 1: String(states['1'] || 'neutral'), 3: String(states['3'] || 'neutral'), 7: String(states['7'] || 'neutral'), 14: String(states['14'] || 'neutral'), 28: String(states['28'] || 'neutral') },
        vdf_detected: !!vdfData, vdf_score: vdfData?.score || 0, vdf_proximity: vdfData?.proximityLevel || 'none',
        bull_flag_confidence: vdfData?.bullFlagConfidence ?? null,
      };
    });
    return reply.send(enrichedRows);
  } catch (err: any) {
    console.error('Divergence API error:', err);
    return reply.code(500).send({ error: 'Failed to fetch divergence signals' });
  }
});

app.post('/api/divergence/signals/:id/favorite', async (request, reply) => {
  if (!isDivergenceConfigured()) return reply.code(503).send({ error: 'Divergence database is not configured' });
  const id = parseInt((request.params as any).id, 10);
  if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'Invalid signal ID' });
  const body = (request.body ?? {}) as Record<string, unknown>;
  const is_favorite = body.is_favorite;
  try {
    let query; let values;
    if (typeof is_favorite === 'boolean') {
      query = `UPDATE divergence_signals SET is_favorite = $1 WHERE id = $2
        RETURNING id, ticker, signal_type, price, timestamp, timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`;
      values = [is_favorite, id];
    } else {
      query = `UPDATE divergence_signals SET is_favorite = NOT is_favorite WHERE id = $1
        RETURNING id, ticker, signal_type, price, timestamp, timeframe,
          CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
          ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`;
      values = [id];
    }
    const result = await divergencePool!.query(query, values);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Signal not found' });
    return reply.send(result.rows[0]);
  } catch (err: any) {
    console.error('Error toggling divergence favorite:', err);
    return reply.code(500).send({ error: 'Server Error' });
  }
});

app.get('/api/breadth', async (request, reply) => {
  const q = request.query as any;
  const compTicker = (q.ticker || 'SVIX').toString().toUpperCase();
  const days = Math.min(Math.max(parseInt(String(q.days)) || 5, 1), 60);
  const isIntraday = days <= 30;
  try {
    if (isIntraday) {
      const lookbackDays = Math.max(14, days * 3);
      const [spyBars, compBars] = await Promise.all([
        getSpyIntraday(lookbackDays),
        dataApiIntradayChartHistory(compTicker, '30min', lookbackDays),
      ]);
      // When intraday data is available (market hours), use it
      if (spyBars && compBars) {
        const points = buildIntradayBreadthPoints(spyBars, compBars, days);
        return reply.send({ intraday: true, points });
      }
      // After hours / pre-market: fall through to daily data below
    }
    // Daily fallback (also used when isIntraday=false or intraday data unavailable)
    const [spyBars, compBars] = await Promise.all([getSpyDaily(), dataApiDaily(compTicker)]);
    if (!spyBars || !compBars) return reply.code(404).send({ error: 'No price data available' });
    const spyMap = new Map();
    for (const bar of spyBars) spyMap.set(bar.date, bar.close);
    const compMap = new Map();
    for (const bar of compBars) compMap.set(bar.date, bar.close);
    const commonDates = [...spyMap.keys()].filter((d) => compMap.has(d)).sort();
    const allPoints = commonDates.slice(-30).map((d) => ({
      date: d, spy: Math.round(spyMap.get(d) * 100) / 100, comparison: Math.round(compMap.get(d) * 100) / 100,
    }));
    // For "T" (days=1) show just last 2 daily closes so there's a visible line segment
    const sliceDays = days === 1 ? 2 : days;
    return reply.send({ intraday: false, points: allPoints.slice(-sliceDays) });
  } catch (err: any) {
    console.error('Breadth API Error:', err);
    return reply.code(500).send({ error: 'Failed to fetch breadth data' });
  }
});

// --- Breadth MA (% above moving averages) ---
app.get('/api/breadth/ma', async (request, reply) => {
  if (!divergencePool) return reply.code(503).send({ error: 'Breadth not configured' });
  const q = request.query as any;
  const days = Math.min(Math.max(parseInt(String(q.days)) || 60, 1), 365);
  try {
    const data = await getLatestBreadthData(divergencePool, days);
    return reply.send(data);
  } catch (err: any) {
    console.error('Breadth MA API Error:', err);
    return reply.code(500).send({ error: 'Failed to fetch breadth MA data' });
  }
});

app.post('/api/breadth/ma/bootstrap', async (request, reply) => {
  if (!divergencePool) return reply.code(503).send({ error: 'Breadth not configured' });
  const q = request.query as any;
  const secret = String(q.secret || '');
  if (!DEBUG_METRICS_SECRET || !timingSafeStringEqual(secret, DEBUG_METRICS_SECRET)) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const numDays = Math.min(Math.max(parseInt(String(q.days)) || 300, 10), 500);
  // Run in background
  bootstrapBreadthHistory(divergencePool, numDays)
    .then((r) => console.log(`[breadth] Bootstrap complete: fetched=${r.fetchedDays}, computed=${r.computedDays}`))
    .catch((err) => console.error('[breadth] Bootstrap failed:', err));
  return reply.send({ status: 'started', days: numDays });
});

app.post('/api/breadth/ma/refresh', async (request, reply) => {
  if (!divergencePool) return reply.code(503).send({ error: 'Breadth not configured' });
  const q = request.query as any;
  const secret = String(q.secret || '');
  if (!DEBUG_METRICS_SECRET || !timingSafeStringEqual(secret, DEBUG_METRICS_SECRET)) {
    return reply.code(403).send({ error: 'Forbidden' });
  }
  const today = new Date();
  const tradeDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  try {
    await runBreadthComputation(divergencePool, tradeDate);
    await cleanupBreadthData(divergencePool);
    return reply.send({ status: 'done', date: tradeDate });
  } catch (err: any) {
    console.error('Breadth refresh error:', err);
    return reply.code(500).send({ error: err.message });
  }
});

// --- Chart pre-warming ---
const prewarmDeps = {
  getOrBuildChartResult: (params: Record<string, unknown>) => getOrBuildChartResult(params),
  toVolumeDeltaSourceInterval, getIntradayLookbackDays, buildChartRequestKey,
  CHART_FINAL_RESULT_CACHE, CHART_IN_FLIGHT_REQUESTS, getTimedCacheValue,
  VALID_CHART_INTERVALS, CHART_TIMING_LOG_ENABLED,
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
        const err = new Error(`Chart build timed out after ${CHART_BUILD_TIMEOUT_MS}ms (${label})`);
        (err as any).httpStatus = 503;
        reject(err);
      }, CHART_BUILD_TIMEOUT_MS),
    ),
  ]);
}

async function getOrBuildChartResult(params: Record<string, unknown>) {
  const ticker = String(params.ticker || '');
  if (!isValidTickerSymbol(ticker)) {
    const err = new Error('Invalid ticker format');
    (err as any).httpStatus = 400;
    throw err;
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
      if (interval === '1day') { chartDebugMetrics.prewarmRequested.fourHourFrom1dayCacheHit += 1; chartDebugMetrics.prewarmRequested.weeklyFrom1dayCacheHit += 1; }
      else if (interval === '4hour') { chartDebugMetrics.prewarmRequested.dailyFrom4hour += 1; }
      schedulePostLoadPrewarmSequence({ ticker, interval, vdRsiLength, vdSourceInterval, vdRsiSourceInterval, lookbackDays });
    }
    if (CHART_TIMING_LOG_ENABLED) console.log(`[chart-cache] ${ticker} ${interval} hit key=${requestKey}`);
    return { result: cachedFinalResult.value, serverTiming: 'cache_hit;dur=0.1,total;dur=0.1', cacheHit: true };
  }
  let buildPromise = CHART_IN_FLIGHT_REQUESTS.get(requestKey);
  const isDedupedWait = Boolean(buildPromise);
  chartDebugMetrics.cacheMiss += 1;
  if (isDedupedWait) chartDebugMetrics.dedupeJoin += 1; else chartDebugMetrics.buildStarted += 1;
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
        if (CHART_TIMING_LOG_ENABLED) console.warn(`[chart-quote] ${ticker} ${interval} skipped: ${err?.message || err}`);
        return null;
      });
      await Promise.all(requiredIntervals.map(async (tf) => { rowsByInterval.set(tf, (await dataApiIntradayChartHistory(ticker, tf, lookbackDays)) || []); }));
      timer.step('fetch_rows');
      const result = buildChartResultFromRows({ ticker, interval, rowsByInterval, vdRsiLength, vdSourceInterval, vdRsiSourceInterval, timer });
      const quote = await quotePromise;
      patchLatestBarCloseWithQuote(result, quote as { price?: number } | null);
      if (quote) timer.step('quote_patch');
      setTimedCacheValue(CHART_FINAL_RESULT_CACHE, requestKey, result, getChartResultCacheExpiryMs(new Date()));
      if (!skipFollowUpPrewarm) {
        if (interval === '4hour') chartDebugMetrics.prewarmRequested.dailyFrom4hour += 1;
        else if (interval === '1day') { chartDebugMetrics.prewarmRequested.fourHourFrom1day += 1; chartDebugMetrics.prewarmRequested.weeklyFrom1day += 1; }
        schedulePostLoadPrewarmSequence({ ticker, interval, vdRsiLength, vdSourceInterval, vdRsiSourceInterval, lookbackDays });
      }
      const serverTiming = timer.serverTiming();
      if (CHART_TIMING_LOG_ENABLED) console.log(`[chart-timing] ${ticker} ${interval} ${isDedupedWait ? 'dedupe-wait' : 'build'} ${timer.summary()}`);
      return { result, serverTiming };
    })();
    CHART_IN_FLIGHT_REQUESTS.set(requestKey, buildPromise);
    buildPromise.finally(() => { if (CHART_IN_FLIGHT_REQUESTS.get(requestKey) === buildPromise) CHART_IN_FLIGHT_REQUESTS.delete(requestKey); }).catch(() => {});
  }
  const { result, serverTiming } = await withChartTimeout(buildPromise, `${ticker}/${interval}`) as { result: unknown; serverTiming: string };
  if (isDedupedWait && CHART_TIMING_LOG_ENABLED) console.log(`[chart-dedupe] ${ticker} ${interval} request joined in-flight key=${requestKey}`);
  return { result, serverTiming, cacheHit: false };
}

// --- Route registrations ---
registerChartRoutes({
  app, parseChartRequestParams, validChartIntervals: VALID_CHART_INTERVALS,
  getOrBuildChartResult, extractLatestChartPayload, sendChartJsonResponse,
  validateChartPayload: validateChartPayloadShape, validateChartLatestPayload: validateChartLatestPayloadShape,
  onChartRequestMeasured: recordChartRequestTiming, isValidTickerSymbol, getDivergenceSummaryForTickers,
  barsToTuples, pointsToTuples, getMiniBarsCacheByTicker: () => miniBarsCacheByTicker,
  loadMiniChartBarsFromDb, loadMiniChartBarsFromDbBatch, fetchMiniChartBarsFromApi, getVDFStatus,
});

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

registerDivergenceRoutes({
  app, isDivergenceConfigured, divergenceScanSecret: process.env.DIVERGENCE_SCAN_SECRET,
  getIsScanRunning: () => divergenceScanRunning, getIsFetchDailyDataRunning: () => fetchDailyScan.running,
  getIsFetchWeeklyDataRunning: () => fetchWeeklyScan.running,
  parseBooleanInput, parseEtDateInput, runDailyDivergenceScan, runDivergenceTableBuild,
  runDivergenceFetchDailyData, runDivergenceFetchWeeklyData, divergencePool,
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
  runVDFScan, getIsVDFScanRunning: () => vdfScan.running,
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
    today, lastTradingDay, tradingDay5Back: cursor, isTodayTradingDay,
    calendarInitialized: tradingCalendar.getStatus().initialized,
  });
});

function getDebugMetricsPayload() {
  const base = buildDebugMetricsPayload({
    startedAtMs, isShuttingDown, httpDebugMetrics,
    chartCacheSizes: {
      lowerTf: VD_RSI_LOWER_TF_CACHE.size, vdRsiResults: VD_RSI_RESULT_CACHE.size,
      chartData: CHART_DATA_CACHE.size, quotes: CHART_QUOTE_CACHE.size,
      finalResults: CHART_FINAL_RESULT_CACHE.size, inFlight: CHART_IN_FLIGHT_REQUESTS.size,
    },
    chartDebugMetrics,
    divergence: {
      configured: isDivergenceConfigured(), running: divergenceScanRunning,
      lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || '',
    },
    memoryUsage: process.memoryUsage(),
  });
  return { ...base, circuitBreaker: getDataApiCircuitBreakerInfo() };
}

function getHealthPayload() {
  return buildHealthPayload({ isShuttingDown, nowIso: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()) });
}

async function getReadyPayload() {
  return buildReadyPayload({
    pool, divergencePool: divergencePool as any, isDivergenceConfigured,
    isShuttingDown, divergenceScanRunning,
    lastScanDateEt: divergenceLastFetchedTradeDateEt || divergenceLastScanDateEt || null,
    circuitBreakerInfo: getDataApiCircuitBreakerInfo(),
    getPoolStats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: 20 }),
  });
}

registerHealthRoutes({ app, debugMetricsSecret: DEBUG_METRICS_SECRET, getDebugMetricsPayload, getHealthPayload, getReadyPayload });

// Circuit breaker manual reset (admin only — requires debug secret)
app.post('/api/admin/circuit-breaker/reset', (request, reply) => {
  const secret = String((request.query as any).secret || request.headers['x-debug-secret'] || '').trim();
  if (DEBUG_METRICS_SECRET && !timingSafeStringEqual(secret, DEBUG_METRICS_SECRET)) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
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
async function pruneOldAlerts() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - ALERT_RETENTION_DAYS);
    const result = await pool.query('DELETE FROM alerts WHERE timestamp < $1', [cutoffDate]);
    if (result.rowCount && result.rowCount > 0) {
      console.log(`Pruned ${result.rowCount} old alerts created before ${cutoffDate.toISOString()}`);
    }
  } catch (err: any) {
    console.error('Failed to prune old alerts:', err.message);
  }
}

let pruneOldAlertsInitialTimer: ReturnType<typeof setTimeout> | null = null;
let pruneOldAlertsIntervalTimer: ReturnType<typeof setInterval> | null = null;

try {
  await initDB();
  await initDivergenceDB();
  if (divergencePool) await initBreadthTables(divergencePool);
} catch (err: any) {
  console.error('Fatal: database initialization failed, exiting.', err);
  process.exit(1);
}

await tradingCalendar
  .init({ fetchDataApiJson, buildDataApiUrl, formatDateUTC, log: (msg: string) => console.log(`[TradingCalendar] ${msg}`) })
  .catch((err) => {
    console.warn('[TradingCalendar] Init failed (non-fatal, using weekday fallback):', err?.message || err);
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

// Auto-bootstrap breadth — delayed 15 s after startup so the server is fully
// warm before the heavy data-fetch begins. Runs only when data is absent or
// the 200d MA history contains zeros (stale bootstrap with insufficient history).
if (divergencePool) {
  setTimeout(() => {
    const BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
    const timeoutGuard = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Breadth bootstrap timed out after 15 minutes')), BOOTSTRAP_TIMEOUT_MS),
    );
    (async () => {
      try {
        const snapshots = await getLatestBreadthSnapshots(divergencePool!);
        const ma200Valid = snapshots.length > 0 ? await isBreadthMa200Valid(divergencePool!) : false;
        if (snapshots.length === 0) {
          console.log('[breadth] No snapshots — auto-bootstrapping 300d in background...');
          await Promise.race([bootstrapBreadthHistory(divergencePool!, 300), timeoutGuard]);
        } else if (!ma200Valid) {
          console.log('[breadth] 200d MA zeros detected — re-bootstrapping 300d to fix...');
          await Promise.race([bootstrapBreadthHistory(divergencePool!, 300), timeoutGuard]);
        }
      } catch (err: any) {
        console.error('[breadth] Auto-bootstrap failed:', err.message);
      }
    })();
  }, 15_000);
}

pruneOldAlertsInitialTimer = setTimeout(pruneOldAlerts, 60 * 1000);
pruneOldAlertsIntervalTimer = setInterval(pruneOldAlerts, PRUNE_CHECK_INTERVAL_MS);

process.on('unhandledRejection', (reason) => { console.error('Unhandled promise rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); shutdownServer('uncaughtException'); });

async function shutdownServer(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully...`);

  if (divergenceSchedulerTimer) { clearTimeout(divergenceSchedulerTimer); setDivergenceSchedulerTimer(null); }
  if (pruneOldAlertsInitialTimer) { clearTimeout(pruneOldAlertsInitialTimer); pruneOldAlertsInitialTimer = null; }
  if (pruneOldAlertsIntervalTimer) { clearInterval(pruneOldAlertsIntervalTimer); pruneOldAlertsIntervalTimer = null; }
  tradingCalendar.destroy();
  clearInterval(vdRsiCacheCleanupTimer);

  fetchDailyScan.requestStop();
  fetchWeeklyScan.requestStop();
  vdfScan.requestStop();
  requestStopDivergenceScan();
  requestStopDivergenceTableBuild();

  const inFlightCount = CHART_IN_FLIGHT_REQUESTS.size;
  if (inFlightCount > 0) console.log(`Shutdown: ${inFlightCount} in-flight chart requests will drain`);

  const forceExitTimer = setTimeout(() => { console.error('Graceful shutdown timed out; forcing exit'); process.exit(1); }, 15000);
  if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

  try {
    await app.close();
    console.log('HTTP server closed; draining database pools...');
    await Promise.allSettled([pool.end(), divergencePool ? divergencePool.end() : Promise.resolve()]);
    console.log('Shutdown complete');
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (err: any) {
    console.error(`Graceful shutdown failed: ${err?.message || err}`);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

process.on('SIGINT', () => { shutdownServer('SIGINT'); });
process.on('SIGTERM', () => { shutdownServer('SIGTERM'); });

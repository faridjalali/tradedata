/**
 * Data API HTTP client — rate limiting, URL construction, JSON fetching,
 * error classification, abort/timeout utilities, and core data-fetching
 * functions (daily bars, indicator values, moving averages, quotes).
 *
 * This module owns the token-bucket rate limiter and all outbound HTTP
 * calls to the market-data provider.
 */

import { formatDateUTC } from '../chartMath.js';
import { addUtcDays, etDateStringFromUnixSeconds } from '../lib/dateUtils.js';
import { CircuitBreaker, CircuitOpenError } from '../lib/circuitBreaker.js';
import { AggregateResponseSchema, IndicatorResponseSchema, validateApiResponse } from '../lib/apiSchemas.js';
import { isAbortError } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// DataApiError interface
// ---------------------------------------------------------------------------

interface DataApiError extends Error {
  httpStatus?: number;
  isDataApiPaused?: boolean;
  isDataApiRateLimited?: boolean;
  isDataApiSubscriptionRestricted?: boolean;
  isTaskTimeout?: boolean;
}

// ---------------------------------------------------------------------------
// Config (read once from env)
// ---------------------------------------------------------------------------

const DATA_API_KEY = process.env.DATA_API_KEY || '';
const DATA_API_BASE = 'https://api.massive.com';
const DATA_API_TIMEOUT_MS = 15000;
const DATA_API_REQUESTS_PAUSED = String(process.env.DATA_API_REQUESTS_PAUSED || 'false').toLowerCase() === 'true';
const DATA_API_MAX_REQUESTS_PER_SECOND = Math.max(1, Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99);
const DATA_API_RATE_BUCKET_CAPACITY = Math.max(
  1,
  Number(process.env.DATA_API_RATE_BUCKET_CAPACITY) || DATA_API_MAX_REQUESTS_PER_SECOND,
);

// ---------------------------------------------------------------------------
// Token-bucket rate limiter (mutable state, module-scoped)
// ---------------------------------------------------------------------------

let dataApiRateTokens = DATA_API_RATE_BUCKET_CAPACITY;
let dataApiRateLastRefillMs = Date.now();

function refillDataApiRateTokens(nowMs?: number): void {
  const now = Number(nowMs) || Date.now();
  const elapsedMs = Math.max(0, now - dataApiRateLastRefillMs);
  if (elapsedMs <= 0) return;
  const refillPerMs = DATA_API_MAX_REQUESTS_PER_SECOND / 1000;
  dataApiRateTokens = Math.min(DATA_API_RATE_BUCKET_CAPACITY, dataApiRateTokens + elapsedMs * refillPerMs);
  dataApiRateLastRefillMs = now;
}

// ---------------------------------------------------------------------------
// Circuit breaker — trips on infrastructure failures (timeouts, 5xx),
// transparent to rate-limit / abort / paused / subscription errors.
// ---------------------------------------------------------------------------

function isInfrastructureError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;
  // These are business-level, not outage signals:
  if (isDataApiRateLimitedError(err)) return false;
  if (isDataApiPausedError(err)) return false;
  if (isAbortError(err)) return false;
  if (isDataApiSubscriptionRestrictedError(err)) return false;
  // Timeouts and 5xx are infrastructure failures:
  const status = (err as Record<string, unknown>).httpStatus;
  if (Number(status) >= 500 || (err as Record<string, unknown>).isTaskTimeout) return true;
  // Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
  const code = (err as Record<string, unknown>).code;
  if (typeof code === 'string' && /^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)$/i.test(code)) return true;
  // Timeout in message
  const msg = String((err as Record<string, unknown>).message || '');
  if (/timed?\s*out/i.test(msg)) return true;
  return false;
}

const dataApiCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 30_000,
  isInfraError: isInfrastructureError,
  onStateChange: (from, to) => {
    if (to === 'OPEN') {
      console.error(`[circuit-breaker] data-api: ${from} → OPEN — external market-data calls blocked`);
    } else if (to === 'HALF_OPEN') {
      console.warn(`[circuit-breaker] data-api: OPEN → HALF_OPEN — probing recovery`);
    } else {
      console.log(`[circuit-breaker] data-api: ${from} → CLOSED — market-data calls resumed`);
    }
  },
});

/** Expose circuit breaker info for health/status endpoints. */
function getDataApiCircuitBreakerInfo() {
  return dataApiCircuitBreaker.getInfo();
}

/** Manually reset the circuit breaker (e.g. from admin endpoint). */
function resetDataApiCircuitBreaker() {
  dataApiCircuitBreaker.reset();
}

// ---------------------------------------------------------------------------
// Stall-detection config (read from env, consumed by watchdog)
// ---------------------------------------------------------------------------

const DIVERGENCE_STALL_TIMEOUT_MS = Math.max(30_000, Number(process.env.DIVERGENCE_STALL_TIMEOUT_MS) || 90_000);
const DIVERGENCE_STALL_CHECK_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.DIVERGENCE_STALL_CHECK_INTERVAL_MS) || 2_000,
);
const DIVERGENCE_STALL_RETRY_BASE_MS = Math.max(1_000, Number(process.env.DIVERGENCE_STALL_RETRY_BASE_MS) || 5_000);

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

function buildDataApiUrl(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): string {
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

function sanitizeDataApiUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('apiKey')) parsed.searchParams.set('apiKey', '***');
    if (parsed.searchParams.has('apikey')) parsed.searchParams.set('apikey', '***');
    return parsed.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// JSON / payload helpers
// ---------------------------------------------------------------------------

function parseJsonSafe(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractDataApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (String(obj.status || '').toUpperCase() === 'ERROR') {
    return String(obj.error || obj.message || 'DataAPI returned ERROR status').trim();
  }
  const candidates = [obj.error, obj.message, obj['Error Message'], obj['Error message'], obj.Note];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toArrayPayload(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.results)) return obj.results;
  if (Array.isArray(obj.historical)) return obj.historical;
  return null;
}

// ---------------------------------------------------------------------------
// Symbol normalization
// ---------------------------------------------------------------------------

function normalizeTickerSymbol(rawSymbol: unknown): string {
  return String(rawSymbol || '')
    .trim()
    .toUpperCase();
}

function getDataApiSymbolCandidates(rawSymbol: unknown): string[] {
  const symbol = normalizeTickerSymbol(rawSymbol);
  const candidates: string[] = [];
  const pushUnique = (value: string): void => {
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

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

function assertDataApiKey(): void {
  if (!DATA_API_KEY) {
    throw new Error('DATA_API_KEY is not configured on the server');
  }
}

function isDataApiRequestsPaused(): boolean {
  return DATA_API_REQUESTS_PAUSED;
}

function buildDataApiPausedError(message?: string): DataApiError {
  const err = new Error(message || 'Market-data requests are paused by server configuration') as DataApiError;
  err.httpStatus = 503;
  err.isDataApiPaused = true;
  return err;
}

function isDataApiPausedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return Boolean((err as Record<string, unknown>).isDataApiPaused);
}

function buildRequestAbortError(message?: string): DataApiError {
  const err = new Error(message || 'Request aborted') as DataApiError;
  err.name = 'AbortError';
  err.httpStatus = 499;
  return err;
}

function buildTaskTimeoutError(message: string, timeoutMs: number): DataApiError {
  const err = new Error(`${message || 'Task'} timed out after ${timeoutMs}ms`) as DataApiError;
  err.httpStatus = 504;
  err.isTaskTimeout = true;
  return err;
}

function isDataApiRateLimitedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const message = String(e.message || err || '');
  return (
    /(?:^|[^0-9])429(?:[^0-9]|$)|Limit Reach|Too Many Requests|rate limit/i.test(message) ||
    (e.isDataApiRateLimited === true || Number(e.httpStatus) === 429)
  );
}

function buildDataApiRateLimitedError(message?: string): DataApiError {
  const err = new Error(message || 'Market-data provider rate limit reached') as DataApiError;
  err.httpStatus = 429;
  err.isDataApiRateLimited = true;
  return err;
}

function isDataApiSubscriptionRestrictedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const message = String(e.message || err || '');
  return (
    Boolean(e.isDataApiSubscriptionRestricted) ||
    /Restricted Endpoint|Legacy Endpoint|current subscription|plan\s+doesn'?t\s+include\s+this\s+data\s+timeframe|data timeframe/i.test(
      message,
    )
  );
}

// ---------------------------------------------------------------------------
// Abort / timeout helpers
// ---------------------------------------------------------------------------

function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  const waitMs = Math.max(1, Math.ceil(Number(ms) || 0));
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      fn();
    };
    const onAbort = () =>
      done(() => reject(buildRequestAbortError('Request aborted while waiting for DataAPI rate-limit slot')));
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

function linkAbortSignalToController(parentSignal: AbortSignal | null, controller: AbortController): () => void {
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

async function runWithAbortAndTimeout(
  task: (signal: AbortSignal | null) => Promise<unknown>,
  options: { label?: string; signal?: AbortSignal | null; timeoutMs?: number } = {},
): Promise<unknown> {
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

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
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
    return await Promise.race([task(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    unlinkAbort();
  }
}

// ---------------------------------------------------------------------------
// Stall watchdog
// ---------------------------------------------------------------------------

function createProgressStallWatchdog(onStall: () => void) {
  let lastProgressMs = Date.now();
  let stalled = false;
  const timer = setInterval(() => {
    if (stalled) return;
    if (Date.now() - lastProgressMs < DIVERGENCE_STALL_TIMEOUT_MS) return;
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
    },
  };
}

function getStallRetryBackoffMs(retryAttempt: number): number {
  const attempt = Math.max(1, Math.floor(Number(retryAttempt) || 1));
  const delay = DIVERGENCE_STALL_RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.min(60_000, delay);
}

// ---------------------------------------------------------------------------
// Rate-limit slot acquisition
// ---------------------------------------------------------------------------

async function acquireDataApiRateLimitSlot(signal?: AbortSignal | null): Promise<void> {
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

// ---------------------------------------------------------------------------
// Core HTTP fetch
// ---------------------------------------------------------------------------

function withDataApiKey(url: string): string {
  const parsed = new URL(url, DATA_API_BASE);
  if (!parsed.searchParams.has('apiKey')) {
    parsed.searchParams.set('apiKey', DATA_API_KEY);
  }
  return parsed.toString();
}

const FETCH_RATE_LIMIT_MAX_RETRIES = 3;
const FETCH_RATE_LIMIT_BASE_BACKOFF_MS = 1_500;

async function fetchDataApiJson(
  url: string,
  label: string,
  options: { signal?: AbortSignal | null; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
): Promise<unknown> {
  assertDataApiKey();
  if (isDataApiRequestsPaused()) {
    throw buildDataApiPausedError(`${label} requests are paused by server configuration`);
  }
  let attempt = 0;
  while (true) {
    try {
      return await fetchDataApiJsonOnce(url, label, options);
    } catch (err) {
      attempt++;
      const signal = options && options.signal ? options.signal : null;
      if (
        isDataApiRateLimitedError(err) &&
        attempt <= FETCH_RATE_LIMIT_MAX_RETRIES &&
        !(signal && signal.aborted)
      ) {
        const backoffMs = Math.min(30_000, FETCH_RATE_LIMIT_BASE_BACKOFF_MS * 2 ** (attempt - 1));
        console.warn(`[dataApi] ${label} rate-limited (attempt ${attempt}/${FETCH_RATE_LIMIT_MAX_RETRIES}), retrying in ${backoffMs}ms`);
        await sleepWithAbort(backoffMs, signal);
        continue;
      }
      throw err;
    }
  }
}

async function fetchDataApiJsonOnce(
  url: string,
  label: string,
  options: { signal?: AbortSignal | null; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
): Promise<unknown> {

  // Circuit breaker — reject immediately when API is confirmed down.
  return dataApiCircuitBreaker.call(async () => {
    const externalSignal = options && options.signal ? options.signal : null;
    const metricsTracker = options && options.metricsTracker ? options.metricsTracker : null;
    const requestStartedMs = Date.now();
    await acquireDataApiRateLimitSlot(externalSignal);
    const controller = new AbortController();
    let timedOut: boolean = false;
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
        const error = new Error(`${label} request failed (${resp.status}): ${details}`) as DataApiError;
        error.httpStatus = resp.status;
        if (
          resp.status === 403 &&
          /plan\s+doesn'?t\s+include\s+this\s+data\s+timeframe|subscription|restricted endpoint/i.test(details)
        ) {
          error.isDataApiSubscriptionRestricted = true;
        }
        throw error;
      }

      if (apiError) {
        if (/Limit Reach|Too Many Requests|rate limit/i.test(apiError)) {
          throw buildDataApiRateLimitedError(`${label} request failed (429): ${apiError}`);
        }
        const error = new Error(`${label} API error: ${apiError}`) as DataApiError;
        if (/plan\s+doesn'?t\s+include\s+this\s+data\s+timeframe|subscription|restricted endpoint/i.test(apiError)) {
          error.isDataApiSubscriptionRestricted = true;
        }
        throw error;
      }

      if (metricsTracker && typeof metricsTracker.recordApiCall === 'function') {
        metricsTracker.recordApiCall({
          latencyMs: Date.now() - requestStartedMs,
          ok: true,
        });
      }
      return payload;
    } catch (err: unknown) {
      if (metricsTracker && typeof metricsTracker.recordApiCall === 'function') {
        metricsTracker.recordApiCall({
          latencyMs: Date.now() - requestStartedMs,
          ok: false,
          rateLimited: isDataApiRateLimitedError(err),
          timedOut,
          aborted: isAbortError(err),
          subscriptionRestricted: isDataApiSubscriptionRestrictedError(err),
        });
      }
    if (isAbortError(err)) {
      if (externalSignal && externalSignal.aborted) {
        const abortError = new Error(`${label} request aborted`) as DataApiError;
        abortError.name = 'AbortError';
        abortError.httpStatus = 499;
        throw abortError;
      }
      if (timedOut) {
        const timeoutError = new Error(`${label} request timed out after ${DATA_API_TIMEOUT_MS}ms`) as DataApiError;
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
  }); // end circuit breaker call
}

async function fetchDataApiArrayWithFallback(
  label: string,
  urls: string[],
  options: { signal?: AbortSignal | null; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
): Promise<unknown[]> {
  assertDataApiKey();
  let lastError: unknown = null;
  let sawEmptyResult = false;

  for (const url of urls) {
    try {
      const payload = await fetchDataApiJson(url, label, options);
      // Zod validation — log warning on shape mismatch but don't hard-fail
      validateApiResponse(AggregateResponseSchema, payload, label);
      const rows = toArrayPayload(payload);
      if (!rows) {
        throw new Error(`${label} returned unexpected payload shape`);
      }
      if (rows.length === 0) {
        sawEmptyResult = true;
        continue;
      }
      return rows;
    } catch (err: unknown) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${label} fetch failed (${sanitizeDataApiUrl(url)}): ${message}`);
      if (isDataApiRateLimitedError(err) || isDataApiPausedError(err)) {
        break;
      }
    }
  }

  if (sawEmptyResult) return [];
  throw lastError || new Error(`${label} request failed`);
}

// ---------------------------------------------------------------------------
// Aggregate / interval config
// ---------------------------------------------------------------------------

const DATA_API_AGG_INTERVAL_MAP: Record<string, { multiplier: number; timespan: string }> = {
  '1min': { multiplier: 1, timespan: 'minute' },
  '5min': { multiplier: 5, timespan: 'minute' },
  '15min': { multiplier: 15, timespan: 'minute' },
  '30min': { multiplier: 30, timespan: 'minute' },
  '1hour': { multiplier: 1, timespan: 'hour' },
  '4hour': { multiplier: 4, timespan: 'hour' },
  '1day': { multiplier: 1, timespan: 'day' },
  '1week': { multiplier: 1, timespan: 'week' },
};

function getDataApiAggConfig(interval: string): { multiplier: number; timespan: string } | null {
  return DATA_API_AGG_INTERVAL_MAP[String(interval || '').trim()] || null;
}

function buildDataApiAggregateRangeUrl(
  symbol: string,
  interval: string,
  options: { from?: string; to?: string } = {},
): string {
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
      limit: 50000,
    },
  );
}

// ---------------------------------------------------------------------------
// Timestamp normalization
// ---------------------------------------------------------------------------

function normalizeUnixSeconds(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 1e12) return Math.floor(numeric / 1000);
  if (numeric > 1e10) return Math.floor(numeric / 1000);
  return Math.floor(numeric);
}

function normalizeQuoteTimestamp(value: unknown): number | null {
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

// ---------------------------------------------------------------------------
// Daily bars
// ---------------------------------------------------------------------------

async function dataApiDailySingle(symbol: string): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> | null> {
  const end = new Date();
  const start = addUtcDays(end, -400);
  const url = buildDataApiAggregateRangeUrl(symbol, '1day', {
    from: formatDateUTC(start),
    to: formatDateUTC(end),
  });
  const rows = await fetchDataApiArrayWithFallback('DataAPI daily', [url]);
  const normalized = rows
    .map((item: unknown) => {
      const row = item as Record<string, unknown>;
      const time = normalizeUnixSeconds(row.t ?? row.timestamp ?? row.time);
      const close = toNumberOrNull(row.c ?? row.close ?? row.price);
      const open = toNumberOrNull(row.o ?? row.open) ?? close;
      const high = toNumberOrNull(row.h ?? row.high) ?? close;
      const low = toNumberOrNull(row.l ?? row.low) ?? close;
      const volume = toNumberOrNull(row.v ?? row.volume) ?? 0;
      const date = Number.isFinite(time) ? etDateStringFromUnixSeconds(time as number) : '';

      if (!date || close === null || open === null || high === null || low === null) {
        return null;
      }

      const boundedHigh = Math.max(high, open, close);
      const boundedLow = Math.min(low, open, close);
      return { date, open, high: boundedHigh, low: boundedLow, close, volume };
    })
    .filter((r): r is { date: string; open: number; high: number; low: number; close: number; volume: number } => r !== null);
  return normalized.length ? normalized : null;
}

async function dataApiDaily(symbol: string): Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> | null> {
  const candidates = getDataApiSymbolCandidates(symbol);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const rows = await dataApiDailySingle(candidate);
      if (rows && rows.length > 0) {
        if (candidate !== normalizeTickerSymbol(symbol)) {
          console.log(`DataAPI symbol fallback (daily): ${symbol} -> ${candidate}`);
        }
        return rows;
      }
    } catch (err: unknown) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`DataAPI daily failed for ${candidate} (requested ${symbol}): ${message}`);
    }
  }

  if (lastError) throw lastError;
  return null;
}

// ---------------------------------------------------------------------------
// Indicator / MA values
// ---------------------------------------------------------------------------

function extractLatestIndicatorValue(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const directResults = Array.isArray(obj.results) ? obj.results : [];
  if (directResults.length > 0) {
    const first = (directResults[0] || {}) as Record<string, unknown>;
    const directValue = toNumberOrNull(first.value ?? first.v ?? first.close ?? first.c);
    if (directValue !== null) return directValue;
    if (Array.isArray(first.values) && first.values.length > 0) {
      const nested = (first.values[0] || {}) as Record<string, unknown>;
      const nestedValue = toNumberOrNull(nested.value ?? nested.v ?? nested.close ?? nested.c);
      if (nestedValue !== null) return nestedValue;
    }
  }
  const resultsObj = obj.results as Record<string, unknown> | undefined;
  const values =
    resultsObj && Array.isArray(resultsObj.values)
      ? resultsObj.values
      : Array.isArray(obj.values)
        ? obj.values
        : [];
  if (values.length > 0) {
    const first = (values[0] || {}) as Record<string, unknown>;
    const nestedValue = toNumberOrNull(first.value ?? first.v ?? first.close ?? first.c);
    if (nestedValue !== null) return nestedValue;
  }
  return null;
}

async function fetchDataApiIndicatorLatestValue(
  symbol: string,
  indicatorType: string,
  windowLength: number,
  options: { signal?: AbortSignal | null; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
): Promise<number> {
  const ticker = normalizeTickerSymbol(symbol);
  const type = String(indicatorType || '')
    .trim()
    .toLowerCase();
  const window = Math.max(1, Math.floor(Number(windowLength) || 1));
  if (!ticker || !type) throw new Error('Invalid indicator request');

  const candidates = getDataApiSymbolCandidates(ticker);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    const url = buildDataApiUrl(`/v1/indicators/${encodeURIComponent(type)}/${encodeURIComponent(candidate)}`, {
      timespan: 'day',
      window: String(window),
      series_type: 'close',
      order: 'desc',
      limit: '1',
    });
    try {
      const payload = await fetchDataApiJson(url, `DataAPI ${type}${window} ${candidate}`, options);
      // Zod validation — log warning on shape mismatch but don't hard-fail
      validateApiResponse(IndicatorResponseSchema, payload, `DataAPI ${type}${window}`);
      const value = extractLatestIndicatorValue(payload);
      if (value !== null) {
        if (candidate !== ticker) {
          console.log(`DataAPI symbol fallback (${type}${window}): ${ticker} -> ${candidate}`);
        }
        return value;
      }
      lastError = new Error(`DataAPI ${type}${window} returned no value for ${candidate}`);
    } catch (err: unknown) {
      lastError = err;
      if (isDataApiRateLimitedError(err) || isDataApiPausedError(err) || isAbortError(err)) {
        throw err;
      }
    }
  }

  throw lastError || new Error(`DataAPI ${type}${window} request failed for ${ticker}`);
}

async function fetchDataApiMovingAverageStatesForTicker(
  ticker: string,
  latestClose: number,
  options: { signal?: AbortSignal | null; metricsTracker?: { recordApiCall: (details: Record<string, unknown>) => void } | null } = {},
): Promise<{ ema8: boolean; ema21: boolean; sma50: boolean; sma200: boolean } | null> {
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
    fetchDataApiIndicatorLatestValue(ticker, 'sma', 200, { signal, metricsTracker }),
  ]);
  return {
    ema8: close > ema8,
    ema21: close > ema21,
    sma50: close > sma50,
    sma200: close > sma200,
  };
}

// ---------------------------------------------------------------------------
// Quote (currently stubbed)
// ---------------------------------------------------------------------------

function toQuoteRow(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload[0] || null;
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data[0] || null;
  if (Array.isArray(obj.quote)) return obj.quote[0] || null;
  return payload;
}

async function dataApiQuoteSingle(symbol: string): Promise<unknown> {
  void symbol;
  return null;
}

async function dataApiLatestQuote(symbol: string): Promise<unknown> {
  void symbol;
  return null;
}

// ---------------------------------------------------------------------------
// Grouped Daily Bars (all US stocks for a single date)
// ---------------------------------------------------------------------------

async function fetchGroupedDailyBars(
  date: string,
  tickerFilter?: Set<string>,
): Promise<Map<string, number>> {
  const url = buildDataApiUrl(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, {
    adjusted: 'true',
  });
  const payload = await fetchDataApiJson(url, `DataAPI grouped-daily ${date}`);
  const results = new Map<string, number>();
  if (!payload || typeof payload !== 'object') return results;
  const arr = (payload as Record<string, unknown>).results;
  if (!Array.isArray(arr)) return results;
  for (const bar of arr) {
    if (!bar || typeof bar !== 'object') continue;
    const b = bar as Record<string, unknown>;
    const ticker = String(b.T || '').toUpperCase();
    const close = Number(b.c);
    if (!ticker || !Number.isFinite(close) || close <= 0) continue;
    if (tickerFilter && !tickerFilter.has(ticker)) continue;
    results.set(ticker, close);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  // Types
  type DataApiError,

  // URL / config
  buildDataApiUrl,
  sanitizeDataApiUrl,
  DATA_API_AGG_INTERVAL_MAP,
  getDataApiAggConfig,
  buildDataApiAggregateRangeUrl,

  // HTTP fetch
  fetchDataApiJson,
  fetchDataApiArrayWithFallback,

  // Error helpers
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

  // Abort / timeout
  sleepWithAbort,
  linkAbortSignalToController,
  runWithAbortAndTimeout,

  // Stall watchdog
  createProgressStallWatchdog,
  getStallRetryBackoffMs,

  // Symbol normalization
  normalizeTickerSymbol,
  getDataApiSymbolCandidates,

  // Payload helpers
  toNumberOrNull,
  toArrayPayload,
  normalizeUnixSeconds,
  normalizeQuoteTimestamp,
  toQuoteRow,

  // Data fetching
  dataApiDaily,
  dataApiDailySingle,
  fetchDataApiIndicatorLatestValue,
  fetchDataApiMovingAverageStatesForTicker,
  dataApiQuoteSingle,
  dataApiLatestQuote,

  // Grouped daily
  fetchGroupedDailyBars,

  // Circuit breaker
  CircuitOpenError,
  getDataApiCircuitBreakerInfo,
  resetDataApiCircuitBreaker,
};

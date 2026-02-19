import 'dotenv/config';

// --- Server ---
export const PORT = process.env.PORT || 3000;
export const CORS_ORIGIN = String(process.env.CORS_ORIGIN || '').trim();

// --- Auth ---
export const BASIC_AUTH_ENABLED = String(process.env.BASIC_AUTH_ENABLED || 'false').toLowerCase() !== 'false';
export const BASIC_AUTH_USERNAME = String(process.env.BASIC_AUTH_USERNAME || 'shared');
export const BASIC_AUTH_PASSWORD = String(process.env.BASIC_AUTH_PASSWORD || '');
export const BASIC_AUTH_REALM = String(process.env.BASIC_AUTH_REALM || 'Catvue');
export const SITE_LOCK_PASSCODE = String(process.env.SITE_LOCK_PASSCODE || '').trim();
export const SITE_LOCK_ENABLED = SITE_LOCK_PASSCODE.length > 0;
/** Secret for signing session tokens. Falls back to passcode if not explicitly set. */
export const SESSION_SECRET = String(process.env.SESSION_SECRET || SITE_LOCK_PASSCODE).trim();
export const REQUEST_LOG_ENABLED = String(process.env.REQUEST_LOG_ENABLED || 'false').toLowerCase() === 'true';
export const DEBUG_METRICS_SECRET = String(process.env.DEBUG_METRICS_SECRET || '').trim();

// --- Rate limiting ---
export const API_RATE_LIMIT_MAX = Math.max(1, Number(process.env.API_RATE_LIMIT_MAX) || 300);
/** Maximum upstream API requests per second; used to compute adaptive fetch concurrency. */
export const DATA_API_MAX_REQUESTS_PER_SECOND = Math.max(1, Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99);

// --- Chart timing ---
export const CHART_TIMING_SAMPLE_MAX = Math.max(50, Number(process.env.CHART_TIMING_SAMPLE_MAX) || 240);

// --- Divergence scan ---
export const DIVERGENCE_SOURCE_INTERVAL = '1min';
export const DIVERGENCE_SCAN_PARENT_INTERVAL = '1day';
export const DIVERGENCE_SCAN_LOOKBACK_DAYS = 45;
export const DIVERGENCE_SCAN_SPREAD_MINUTES = Math.max(0, Number(process.env.DIVERGENCE_SCAN_SPREAD_MINUTES) || 0);
export const DIVERGENCE_SCAN_CONCURRENCY = Math.max(1, Number(process.env.DIVERGENCE_SCAN_CONCURRENCY) || 128);
export const DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY = Math.max(
  25,
  Number(process.env.DIVERGENCE_SCAN_PROGRESS_WRITE_EVERY) || 500,
);
export const DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS = Math.max(45, Number(process.env.DIVERGENCE_TABLE_RUN_LOOKBACK_DAYS) || 60);
export const DIVERGENCE_TABLE_BUILD_CONCURRENCY = Math.max(1, Number(process.env.DIVERGENCE_TABLE_BUILD_CONCURRENCY) || 24);
export const DIVERGENCE_TABLE_MIN_COVERAGE_DAYS = Math.max(29, Number(process.env.DIVERGENCE_TABLE_MIN_COVERAGE_DAYS) || 29);
export const DIVERGENCE_SCANNER_ENABLED = false;
export const DIVERGENCE_MIN_UNIVERSE_SIZE = Math.max(1, Number(process.env.DIVERGENCE_MIN_UNIVERSE_SIZE) || 500);
export const DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE = Math.max(
  100,
  Number(process.env.DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE) || 2000,
);
export const DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE = Math.max(
  1,
  Math.min(DIVERGENCE_SUMMARY_UPSERT_BATCH_SIZE, Number(process.env.DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE) || 100),
);
export const DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE = Math.max(
  DIVERGENCE_TABLE_SUMMARY_FLUSH_SIZE,
  Number(process.env.DIVERGENCE_FETCH_RUN_SUMMARY_FLUSH_SIZE) || 500,
);
export const DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE = Math.max(
  1,
  Number(process.env.DIVERGENCE_TABLE_BACKFILL_CHUNK_SIZE) || 25,
);
export const DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS = Math.max(28, Number(process.env.DIVERGENCE_FETCH_ALL_LOOKBACK_DAYS) || 50);
export const DIVERGENCE_FETCH_TICKER_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.DIVERGENCE_FETCH_TICKER_TIMEOUT_MS) || 60_000,
);
export const DIVERGENCE_FETCH_MA_TIMEOUT_MS = Math.max(5_000, Number(process.env.DIVERGENCE_FETCH_MA_TIMEOUT_MS) || 30_000);
export const DIVERGENCE_STALL_TIMEOUT_MS = Math.max(30_000, Number(process.env.DIVERGENCE_STALL_TIMEOUT_MS) || 90_000);
export const DIVERGENCE_STALL_CHECK_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.DIVERGENCE_STALL_CHECK_INTERVAL_MS) || 2_000,
);
export const DIVERGENCE_STALL_RETRY_BASE_MS = Math.max(1_000, Number(process.env.DIVERGENCE_STALL_RETRY_BASE_MS) || 5_000);
export const DIVERGENCE_STALL_MAX_RETRIES = Math.max(0, Math.floor(Number(process.env.DIVERGENCE_STALL_MAX_RETRIES) || 3));

// --- Mini-bars cache ---
export const MINI_BARS_CACHE_MAX_TICKERS = 2000;

// --- Run metrics ---
export const RUN_METRICS_SAMPLE_CAP = Math.max(100, Number(process.env.RUN_METRICS_SAMPLE_CAP) || 1200);
export const RUN_METRICS_HISTORY_LIMIT = Math.max(10, Number(process.env.RUN_METRICS_HISTORY_LIMIT) || 40);

// --- Alert pruning ---
export const ALERT_RETENTION_DAYS = 30;
export const PRUNE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// --- Startup validation ---
export function validateStartupEnvironment() {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requireNonEmpty = (name: string) => {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      errors.push(`${name} is required`);
    }
  };
  const warnIfMissing = (name: string) => {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      warnings.push(`${name} is not set`);
    }
  };
  const warnIfInvalidPositiveNumber = (name: string) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      warnings.push(`${name} should be a positive number (received: ${String(raw)})`);
    }
  };
  const warnIfInvalidNonNegativeNumber = (name: string) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      warnings.push(`${name} should be a non-negative number (received: ${String(raw)})`);
    }
  };

  requireNonEmpty('DATABASE_URL');
  warnIfMissing('SITE_LOCK_PASSCODE');
  if (!SESSION_SECRET) {
    errors.push('SESSION_SECRET (or SITE_LOCK_PASSCODE) must be set — session tokens cannot be signed securely');
  }
  if (BASIC_AUTH_ENABLED && !String(BASIC_AUTH_PASSWORD || '').trim()) {
    errors.push('BASIC_AUTH_PASSWORD must be set when BASIC_AUTH_ENABLED is true');
  }
  if (!String(process.env.DATA_API_KEY || '').trim()) {
    warnings.push('DATA_API_KEY is not set');
  }
  if (!String(process.env.DIVERGENCE_SCAN_SECRET || '').trim()) {
    warnings.push('DIVERGENCE_SCAN_SECRET is not set — divergence admin endpoints are unprotected');
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

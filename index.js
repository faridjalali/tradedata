const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// NOTE: cors() allows all origins. Restrict in production if needed:
// app.use(cors({ origin: 'https://yourdomain.com' }));
app.use(cors());
app.use(express.json());
app.use(express.static('dist'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const divergenceDatabaseUrl = process.env.DIVERGENCE_DATABASE_URL || '';
const divergencePool = divergenceDatabaseUrl
  ? new Pool({ connectionString: divergenceDatabaseUrl })
  : null;

const DIVERGENCE_SOURCE_INTERVAL = '5min';
const DIVERGENCE_SCAN_PARENT_INTERVAL = '1day';
const DIVERGENCE_SCAN_LOOKBACK_DAYS = 45;
const DIVERGENCE_SCAN_SPREAD_MINUTES = Math.max(1, Number(process.env.DIVERGENCE_SCAN_SPREAD_MINUTES) || 15);
const DIVERGENCE_SCAN_CONCURRENCY = 1; // keep sequential to respect API limits
const DIVERGENCE_SCANNER_ENABLED = String(process.env.DIVERGENCE_SCANNER_ENABLED || 'true').toLowerCase() !== 'false';
const DIVERGENCE_MIN_UNIVERSE_SIZE = Math.max(1, Number(process.env.DIVERGENCE_MIN_UNIVERSE_SIZE) || 500);

let divergenceScanRunning = false;
let divergenceSchedulerTimer = null;
let divergenceLastScanDateEt = '';

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

// Simple in-memory rate limiter for webhook endpoint
const webhookRateLimit = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX = 60; // max requests per window per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = webhookRateLimit.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    webhookRateLimit.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of webhookRateLimit) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS) webhookRateLimit.delete(ip);
  }
}, 300000);

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
    
    // Attempt to add new columns if they don't exist
    const columns = [
      "timeframe VARCHAR(10)",
      "signal_direction INTEGER",
      "signal_volume INTEGER",
      "intensity_score INTEGER",
      "combo_score INTEGER",
      "is_favorite BOOLEAN DEFAULT FALSE"
    ];

    for (const col of columns) {
      try {
        await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ${col}`);
      } catch (e) {
        // Ignore errors if column already exists (or other migration issues that shouldn't stop startup)
        console.log(`Migration note for ${col}:`, e.message);
      }
    }
    console.log("Database initialized successfully");
  } catch (err) {
    console.error("Failed to initialize database:", err);
  }
};

initDB();

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
        source_interval VARCHAR(10) NOT NULL DEFAULT '5min',
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
      CREATE TABLE IF NOT EXISTS divergence_symbols (
        ticker VARCHAR(20) PRIMARY KEY,
        exchange VARCHAR(40),
        asset_type VARCHAR(40),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('Divergence database initialized successfully');
  } catch (err) {
    console.error('Failed to initialize divergence database:', err);
  }
};

initDivergenceDB();

// Endpoint for TradingView Webhook
app.post("/webhook", async (req, res) => {
  // Rate limiting
  if (!checkRateLimit(req.ip)) {
    return res.status(429).send("Too many requests");
  }

  const secret = req.query.secret;
  // Simple security check
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    console.log("Unauthorized access attempt");
    return res.status(401).send("Unauthorized");
  }

  try {
    // Validate and sanitize inputs
    const ticker = typeof req.body.ticker === 'string' ? req.body.ticker.trim().substring(0, 20) : '';
    if (!ticker) {
        return res.status(400).send("Missing or invalid ticker");
    }

    const signalDir = Number(req.body.signalDir) || 0;
    if (![1, -1, 0].includes(signalDir)) {
        return res.status(400).send("Invalid signalDir (must be -1, 0, or 1)");
    }
    
    // Infer signal_type from direction
    let signal = 'neutral';
    if (signalDir === 1) signal = 'bullish';
    if (signalDir === -1) signal = 'bearish';

    const price = Math.max(0, Number(req.body.price) || 0);
    const message = typeof req.body.message === 'string' ? req.body.message.substring(0, 500) : '';
    
    // Strict 1d/1w logic
    const rawTf = (req.body.timeframe || '').toString().toLowerCase();
    const timeframe = rawTf.includes('w') ? '1w' : '1d'; 

    const signalVolume = Math.max(0, Math.min(999999, Math.round(Number(req.body.signalVol) || 0)));
    const intensityScore = Math.max(0, Math.min(100, Math.round(Number(req.body.finalIntensityScore) || 0)));
    const comboScore = Math.max(0, Math.min(100, Math.round(Number(req.body.comboScore) || 0)));
    
    const query = `
      INSERT INTO alerts(ticker, signal_type, price, message, timeframe, signal_direction, signal_volume, intensity_score, combo_score) 
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) 
      RETURNING *
    `;
    const values = [ticker, signal, price, message, timeframe, signalDir, signalVolume, intensityScore, comboScore];
    const result = await pool.query(query, values);
    console.log('Alert received:', result.rows[0]);
    res.status(200).send('Alert Received');
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).send("Server Error");
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 0;
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;
    
    let query = 'SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100';
    let values = [];

    if (startDate && endDate) {
        query = `SELECT * FROM alerts WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 500`;
        values = [startDate, endDate];
    } else if (days > 0) {
        query = `SELECT * FROM alerts WHERE timestamp >= NOW() - $1::interval ORDER BY timestamp DESC LIMIT 500`;
        values = [`${days} days`];
    }
    
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.post('/api/alerts/:id/favorite', async (req, res) => {
    const { id } = req.params;
    const { is_favorite } = req.body; // Expect boolean, or toggle if undefined? Let's be explicit or query first.
    
    // Simple toggle logic if is_favorite is not provided would require a read first.
    // For efficiency, let's assume the frontend sends the DESIRED state.
    // Or, simpler: update alerts set is_favorite = NOT is_favorite where id = $1 returning *;
    
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
    const startDate = req.query.start_date;
    const endDate = req.query.end_date;

    let query = 'SELECT * FROM divergence_signals ORDER BY timestamp DESC LIMIT 100';
    let values = [];

    if (startDate && endDate) {
      query = `
        SELECT
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
        FROM divergence_signals
        WHERE timestamp >= $1 AND timestamp <= $2
          AND timeframe = '1d'
        ORDER BY timestamp DESC
        LIMIT 1000
      `;
      values = [startDate, endDate];
    } else if (days > 0) {
      query = `
        SELECT
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
        FROM divergence_signals
        WHERE timestamp >= NOW() - $1::interval
          AND timeframe = '1d'
        ORDER BY timestamp DESC
        LIMIT 1000
      `;
      values = [`${days} days`];
    } else {
      query = `
        SELECT
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
        FROM divergence_signals
        WHERE timeframe = '1d'
        ORDER BY timestamp DESC
        LIMIT 1000
      `;
    }

    const result = await divergencePool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error('Divergence API error:', err);
    res.status(500).json({ error: 'Failed to fetch divergence signals' });
  }
});

app.post('/api/divergence/signals/:id/favorite', async (req, res) => {
  if (!isDivergenceConfigured()) {
    return res.status(503).json({ error: 'Divergence database is not configured' });
  }
  const { id } = req.params;
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

// --- FMP (Financial Modeling Prep) helpers ---
const FMP_KEY = process.env.FMP_API_KEY || '';
const FMP_STABLE_BASE = 'https://financialmodelingprep.com/stable';
const FMP_LEGACY_BASE = 'https://financialmodelingprep.com/api/v3';
const FMP_TIMEOUT_MS = 15000;

function buildFmpUrl(base, path, params = {}) {
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(`${normalizedBase}/${normalizedPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function sanitizeFmpUrl(url) {
  try {
    const parsed = new URL(url);
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

function extractFmpError(payload) {
  if (!payload || typeof payload !== 'object') return null;
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
  if (payload && Array.isArray(payload.historical)) return payload.historical;
  return null;
}

function normalizeTickerSymbol(rawSymbol) {
  return String(rawSymbol || '').trim().toUpperCase();
}

function getFmpSymbolCandidates(rawSymbol) {
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

function assertFmpKey() {
  if (!FMP_KEY) {
    throw new Error('FMP_API_KEY is not configured on the server');
  }
}

async function fetchFmpJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FMP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const text = await resp.text();
    const payload = parseJsonSafe(text);
    const apiError = extractFmpError(payload);
    const bodyText = apiError || (typeof text === 'string' ? text.trim().slice(0, 180) : '');

    if (!resp.ok) {
      const details = bodyText || `HTTP ${resp.status}`;
      throw new Error(`${label} request failed (${resp.status}): ${details}`);
    }

    if (apiError) {
      throw new Error(`${label} API error: ${apiError}`);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFmpArrayWithFallback(label, urls) {
  assertFmpKey();
  let lastError = null;
  let sawEmptyResult = false;

  for (const url of urls) {
    try {
      const payload = await fetchFmpJson(url, label);
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
      console.error(`${label} fetch failed (${sanitizeFmpUrl(url)}): ${message}`);
    }
  }

  if (sawEmptyResult) return [];
  throw lastError || new Error(`${label} request failed`);
}

async function fmpDailySingle(symbol) {
  const symbolEncoded = encodeURIComponent(symbol);
  const urls = [
    // Prefer non-split-adjusted/full endpoints so daily candlesticks match raw OHLC.
    buildFmpUrl(FMP_STABLE_BASE, '/historical-price-eod/non-split-adjusted', { symbol, apikey: FMP_KEY, timeseries: 250 }),
    buildFmpUrl(FMP_STABLE_BASE, '/historical-price-eod/full', { symbol, apikey: FMP_KEY, timeseries: 250 }),
    buildFmpUrl(FMP_LEGACY_BASE, `/historical-price-full/${symbolEncoded}`, { apikey: FMP_KEY, timeseries: 250 }),
    buildFmpUrl(FMP_LEGACY_BASE, '/historical-price-full', { symbol, apikey: FMP_KEY, timeseries: 250 }),
    // Fall back to light only if full is unavailable for the account/endpoint.
    buildFmpUrl(FMP_STABLE_BASE, '/historical-price-eod/light', { symbol, apikey: FMP_KEY }),
    buildFmpUrl(FMP_LEGACY_BASE, '/historical-price-eod/light', { symbol, apikey: FMP_KEY })
  ];

  const rows = await fetchFmpArrayWithFallback('FMP daily', urls);
  let hasExplicitOHLC = false;
  const normalized = rows.map((row) => {
    const dateRaw = typeof row.date === 'string' ? row.date.trim() : '';
    const date = dateRaw ? dateRaw.slice(0, 10) : null;
    // Prefer explicit OHLC values from full endpoints.
    const close = toNumberOrNull(row.close ?? row.price);
    const openRaw = toNumberOrNull(row.open);
    const highRaw = toNumberOrNull(row.high);
    const lowRaw = toNumberOrNull(row.low);
    const open = openRaw ?? close;
    const high = highRaw ?? close;
    const low = lowRaw ?? close;
    const volume = toNumberOrNull(row.volume) ?? 0;

    if (!date || close === null || open === null || high === null || low === null) {
      return null;
    }

    if (openRaw !== null && highRaw !== null && lowRaw !== null) {
      hasExplicitOHLC = true;
    }

    const boundedHigh = Math.max(high, open, close);
    const boundedLow = Math.min(low, open, close);
    return { date, open, high: boundedHigh, low: boundedLow, close, volume };
  }).filter(Boolean);

  // Close-only "light" data renders misleading daily candlesticks. Force real OHLC for daily candles.
  if (normalized.length > 0 && !hasExplicitOHLC) {
    throw new Error(`FMP daily for ${symbol} returned close-only data; OHLC endpoint unavailable`);
  }

  return normalized.length ? normalized : null;
}

async function fmpDaily(symbol) {
  const candidates = getFmpSymbolCandidates(symbol);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const rows = await fmpDailySingle(candidate);
      if (rows && rows.length > 0) {
        if (candidate !== normalizeTickerSymbol(symbol)) {
          console.log(`FMP symbol fallback (daily): ${symbol} -> ${candidate}`);
        }
        return rows;
      }
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      console.error(`FMP daily failed for ${candidate} (requested ${symbol}): ${message}`);
    }
  }

  if (lastError) throw lastError;
  return null;
}

function formatDateUTC(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isFmpSubscriptionRestrictedError(err) {
  const message = String(err && err.message ? err.message : err || '');
  return /Restricted Endpoint|Legacy Endpoint|current subscription/i.test(message);
}

const VD_RSI_REGULAR_HOURS_CACHE_MS = 2 * 60 * 60 * 1000;
const VD_RSI_LOWER_TF_CACHE = new Map();
const VD_RSI_RESULT_CACHE = new Map();
const CHART_DATA_CACHE = new Map(); // Cache for FMP intraday chart data

function easternLocalToUtcMs(year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const etOffset = probe.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short'
  }).includes('EST') ? -5 : -4;
  return Date.UTC(year, month - 1, day, hour - etOffset, minute, 0);
}

function isEtWeekday(dateEt) {
  const day = dateEt.getDay();
  return day >= 1 && day <= 5;
}

function isEtRegularHours(dateEt) {
  if (!isEtWeekday(dateEt)) return false;
  const totalMinutes = dateEt.getHours() * 60 + dateEt.getMinutes();
  return totalMinutes >= 570 && totalMinutes < 960; // 09:30-15:59 ET
}

function nextEtMarketOpenUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  const totalMinutes = candidate.getHours() * 60 + candidate.getMinutes();

  if (!(isEtWeekday(candidate) && totalMinutes < 570)) {
    candidate.setDate(candidate.getDate() + 1);
    while (!isEtWeekday(candidate)) {
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
  if (!entry) return null;
  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
    cacheMap.delete(key);
    return null;
  }
  return entry.value;
}

function setTimedCacheValue(cacheMap, key, value, expiresAt) {
  cacheMap.set(key, {
    value,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : getVdRsiCacheExpiryMs(new Date())
  });
}

function sweepExpiredTimedCache(cacheMap) {
  const now = Date.now();
  for (const [key, entry] of cacheMap.entries()) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      cacheMap.delete(key);
    }
  }
}

const vdRsiCacheCleanupTimer = setInterval(() => {
  sweepExpiredTimedCache(VD_RSI_LOWER_TF_CACHE);
  sweepExpiredTimedCache(VD_RSI_RESULT_CACHE);
  sweepExpiredTimedCache(CHART_DATA_CACHE);
}, 15 * 60 * 1000);
if (typeof vdRsiCacheCleanupTimer.unref === 'function') {
  vdRsiCacheCleanupTimer.unref();
}

async function fmpIntraday(symbol, interval, options = {}) {
  const { from, to } = options;

  // Check cache first to avoid redundant API calls
  const cacheKey = `${symbol}|${interval}|${from || ''}|${to || ''}`;
  const cached = getTimedCacheValue(CHART_DATA_CACHE, cacheKey);
  if (cached) {
    return cached;
  }

  const symbolEncoded = encodeURIComponent(symbol);
  const params = { symbol, apikey: FMP_KEY };
  if (from) params.from = from;
  if (to) params.to = to;

  const urls = [
    buildFmpUrl(FMP_STABLE_BASE, `/historical-chart/${interval}`, params),
    buildFmpUrl(FMP_LEGACY_BASE, `/historical-chart/${interval}/${symbolEncoded}`, { apikey: FMP_KEY, from, to }),
    buildFmpUrl(FMP_LEGACY_BASE, `/historical-chart/${interval}`, params)
  ];

  const rows = await fetchFmpArrayWithFallback(`FMP ${interval}`, urls);
  const normalized = rows.map((row) => {
    const datetimeRaw = row.date ?? row.datetime;
    const datetime = typeof datetimeRaw === 'string'
      ? datetimeRaw.replace('T', ' ').replace('Z', '').trim()
      : '';
    const close = toNumberOrNull(row.close ?? row.price);
    const open = toNumberOrNull(row.open) ?? close;
    const high = toNumberOrNull(row.high) ?? close;
    const low = toNumberOrNull(row.low) ?? close;
    const volume = toNumberOrNull(row.volume) ?? 0;

    if (!datetime || close === null || open === null || high === null || low === null) {
      return null;
    }

    return { datetime, open, high, low, close, volume };
  }).filter(Boolean);

  const result = normalized.length ? normalized : null;

  // Cache the result with smart expiry
  if (result) {
    const expiryMs = getVdRsiCacheExpiryMs(new Date());
    setTimedCacheValue(CHART_DATA_CACHE, cacheKey, result, expiryMs);
  }

  return result;
}

// Fetch 9 months of data to ensure 6 months of valid indicator data
// (need buffer for RSI/VD-RSI warm-up period)
function getIntradayLookbackDays(interval) {
  // All intervals get 270 days (9 months) to ensure:
  // - 6 months (180 days) of visible data
  // - 90 days buffer for indicator warm-up (RSI needs 14+ periods)
  return 270;
}

const CHART_INTRADAY_LOOKBACK_DAYS = 365; // Legacy fallback
const CHART_INTRADAY_SLICE_DAYS = {
  '1min': 3,
  '5min': 7,
  '15min': 30,
  '30min': 30,
  '1hour': 60,
  '4hour': 120
};

async function fmpIntradayChartHistorySingle(symbol, interval, lookbackDays = CHART_INTRADAY_LOOKBACK_DAYS) {
  const sliceDays = CHART_INTRADAY_SLICE_DAYS[interval] || 30;
  const endDate = new Date();
  endDate.setUTCHours(0, 0, 0, 0);
  const startDate = addUtcDays(endDate, -Math.max(1, lookbackDays));

  const byDateTime = new Map();
  let cursor = new Date(startDate);
  let lastSliceError = null;

  while (cursor <= endDate) {
    const sliceStart = new Date(cursor);
    let sliceEnd = addUtcDays(sliceStart, sliceDays - 1);
    if (sliceEnd > endDate) sliceEnd = new Date(endDate);

    try {
      const rows = await fmpIntraday(symbol, interval, {
        from: formatDateUTC(sliceStart),
        to: formatDateUTC(sliceEnd)
      });
      if (rows && rows.length > 0) {
        for (const row of rows) {
          byDateTime.set(row.datetime, row);
        }
      }
    } catch (err) {
      lastSliceError = err;
      const message = err && err.message ? err.message : String(err);
      console.error(`FMP ${interval} slice fetch failed for ${symbol} (${formatDateUTC(sliceStart)} to ${formatDateUTC(sliceEnd)}): ${message}`);
      if (isFmpSubscriptionRestrictedError(err)) {
        throw err;
      }
    }

    cursor = addUtcDays(sliceEnd, 1);
  }

  if (byDateTime.size === 0) {
    // Fallback to a single request without date filters if slicing returned nothing.
    try {
      return await fmpIntraday(symbol, interval);
    } catch (fallbackErr) {
      if (lastSliceError) throw lastSliceError;
      throw fallbackErr;
    }
  }

  return Array.from(byDateTime.values()).sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
}

async function fmpIntradayChartHistory(symbol, interval, lookbackDays = CHART_INTRADAY_LOOKBACK_DAYS) {
  const candidates = getFmpSymbolCandidates(symbol);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const rows = await fmpIntradayChartHistorySingle(candidate, interval, lookbackDays);
      if (rows && rows.length > 0) {
        if (candidate !== normalizeTickerSymbol(symbol)) {
          console.log(`FMP symbol fallback (${interval}): ${symbol} -> ${candidate}`);
        }
        return rows;
      }
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      console.error(`FMP ${interval} history failed for ${candidate} (requested ${symbol}): ${message}`);
    }
  }

  if (lastError) throw lastError;
  return [];
}

async function fmpIntraday30(symbol) {
  return fmpIntraday(symbol, '30min');
}

async function fmpIntraday1Hour(symbol) {
  return fmpIntraday(symbol, '1hour');
}

async function fmpIntraday4Hour(symbol) {
  return fmpIntraday(symbol, '4hour');
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
    '1day': 24 * 60 * 60
  };
  return map[interval] || 60;
}

function dayKeyInLA(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function aggregate4HourBarsToDaily(fourHourBars) {
  if (!Array.isArray(fourHourBars) || fourHourBars.length === 0) return [];

  const sorted = fourHourBars
    .filter((bar) => (
      bar &&
      Number.isFinite(Number(bar.time)) &&
      Number.isFinite(Number(bar.open)) &&
      Number.isFinite(Number(bar.high)) &&
      Number.isFinite(Number(bar.low)) &&
      Number.isFinite(Number(bar.close))
    ))
    .sort((a, b) => Number(a.time) - Number(b.time));

  const byDay = new Map();

  for (const bar of sorted) {
    const time = Number(bar.time);
    const key = dayKeyInLA(time);
    if (!key) continue;

    const open = Number(bar.open);
    const high = Number(bar.high);
    const low = Number(bar.low);
    const close = Number(bar.close);
    const volume = Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : 0;

    const existing = byDay.get(key);
    if (!existing) {
      byDay.set(key, {
        time,
        open,
        high,
        low,
        close,
        volume,
        _lastTime: time
      });
      continue;
    }

    existing.high = Math.max(existing.high, high);
    existing.low = Math.min(existing.low, low);
    existing.volume += volume;
    if (time >= existing._lastTime) {
      existing.close = close;
      existing._lastTime = time;
    }
  }

  return Array.from(byDay.values())
    .sort((a, b) => Number(a.time) - Number(b.time))
    .map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume
    }));
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

    // Cumulative series tends to have absolute values much larger than per-bar differences.
    if ((maxVolume / avgDiff) < 4) return;

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
  let lastBull = true;
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
            isBull = streamLastBull;
          }
        } else {
          isBull = streamLastBull;
        }
      }

      streamLastBull = Boolean(isBull);
      runningDelta += streamLastBull ? ib.volume : -ib.volume;
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

function computeVolumeDeltaCandlesByParentBars(parentBars, lowerTimeframeBars, interval) {
  if (!Array.isArray(parentBars) || parentBars.length === 0) return [];
  if (!Array.isArray(lowerTimeframeBars) || lowerTimeframeBars.length === 0) {
    return parentBars.map((bar) => ({
      time: bar.time,
      open: 0,
      high: 0,
      low: 0,
      close: 0
    }));
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
  let lastBull = true;
  const candles = [];

  for (let i = 0; i < parentBars.length; i++) {
    const stream = intrabarsPerParent[i];
    if (!stream || stream.length === 0) {
      candles.push({
        time: parentBars[i].time,
        open: 0,
        high: 0,
        low: 0,
        close: 0
      });
      continue;
    }

    let runningDelta = 0;
    let maxDelta = 0;
    let minDelta = 0;
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
            isBull = streamLastBull;
          }
        } else {
          isBull = streamLastBull;
        }
      }

      streamLastBull = Boolean(isBull);
      runningDelta += streamLastBull ? ib.volume : -ib.volume;
      maxDelta = Math.max(maxDelta, runningDelta);
      minDelta = Math.min(minDelta, runningDelta);
      if (j === stream.length - 1) {
        streamLastClose = ib.close;
      }
    }

    lastClose = Number.isFinite(streamLastClose) ? streamLastClose : lastClose;
    lastBull = streamLastBull;
    candles.push({
      time: parentBars[i].time,
      open: 0,
      high: maxDelta,
      low: minDelta,
      close: runningDelta
    });
  }

  return candles;
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

// Convert ET timezone bars to LA timezone
function parseFmpDateTime(datetimeValue) {
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

function convertToLATime(bars, interval) {
  const converted = [];

  for (const bar of bars) {
    // Intraday: Convert ET to Unix timestamp
    // FMP returns datetime like "2025-08-10 09:30:00" in ET (America/New_York)
    const parts = parseFmpDateTime(bar.datetime || bar.date);
    if (!parts) continue;

    const { year, month, day, hour, minute } = parts;

    // Create a date string that will be interpreted in ET timezone
    // by using toLocaleString to get the UTC offset
    const testDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const etOffset = testDate.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'short'
    }).includes('EST') ? -5 : -4; // -5 for EST, -4 for EDT

    // Create UTC timestamp accounting for ET offset
    const utcTimestamp = Date.UTC(year, month - 1, day, hour - etOffset, minute, 0);
    const timestamp = Math.floor(utcTimestamp / 1000);

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
  return fmpDaily('SPY');
}

async function getSpyIntraday(lookbackDays = 30) {
  return fmpIntradayChartHistory('SPY', '30min', lookbackDays);
}

function isRegularHoursEt(dateTimeStr) {
  const parts = String(dateTimeStr || '').split(' ');
  if (parts.length < 2) return false;
  const [h, m] = parts[1].split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const totalMin = h * 60 + m;
  return totalMin >= 570 && totalMin <= 960;
}

function roundEtTo30MinEpochMs(dateTimeStr) {
  // Parse FMP string (ET) as proper UTC timestamp
  // 1. Treat input as UTC
  const asUTC = new Date(String(dateTimeStr).replace(' ', 'T') + 'Z');
  // 2. Get what time that represents in NY
  const nyStr = asUTC.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  // 3. Parse that NY time as if it were UTC
  const nyAsUTC = new Date(nyStr + ' GMT');
  // 4. Diff is the offset we need to add to convert "ET interpreted as UTC" to "Real UTC"
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
    const day = String(bar.datetime || '').slice(0, 10);
    if (!day) continue;
    if (!isRegularHoursEt(bar.datetime)) continue;
    const ts = roundEtTo30MinEpochMs(bar.datetime);
    spyMap.set(ts, bar.close);
    spyDayByTs.set(ts, day);
  }

  const compMap = new Map();
  const compDayByTs = new Map();
  for (const bar of compBars || []) {
    const day = String(bar.datetime || '').slice(0, 10);
    if (!day) continue;
    if (!isRegularHoursEt(bar.datetime)) continue;
    const ts = roundEtTo30MinEpochMs(bar.datetime);
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
        fmpIntradayChartHistory(compTicker, '30min', lookbackDays)
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
      fmpDaily(compTicker)
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

// --- Chart API ---
app.get('/api/chart', async (req, res) => {
  const ticker = (req.query.ticker || 'SPY').toString().toUpperCase();
  const interval = (req.query.interval || '4hour').toString();

  const VOLUME_DELTA_SOURCE_INTERVALS = ['5min', '15min', '30min', '1hour', '4hour'];
  const toVolumeDeltaSourceInterval = (value, fallback = '5min') => {
    const normalized = String(value || '').trim();
    return VOLUME_DELTA_SOURCE_INTERVALS.includes(normalized) ? normalized : fallback;
  };

  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(req.query.vdRsiLength) || 14)));
  const vdSourceInterval = toVolumeDeltaSourceInterval(req.query.vdSourceInterval, '5min');
  const vdRsiSourceInterval = toVolumeDeltaSourceInterval(req.query.vdRsiSourceInterval, '5min');

  // Validate interval
  const validIntervals = ['5min', '15min', '30min', '1hour', '4hour', '1day'];
  if (!validIntervals.includes(interval)) {
    return res.status(400).json({ error: 'Invalid interval. Use: 5min, 15min, 30min, 1hour, 4hour, or 1day' });
  }

  // Use smart lookback based on interval (much faster!)
  const lookbackDays = getIntradayLookbackDays(interval);

  try {
    const parentFetchInterval = interval === '1day' ? '4hour' : interval;
    const requiredIntervals = Array.from(new Set([
      parentFetchInterval,
      vdSourceInterval,
      vdRsiSourceInterval
    ]));
    const rowsByInterval = new Map();
    await Promise.all(requiredIntervals.map(async (tf) => {
      const rows = await fmpIntradayChartHistory(ticker, tf, lookbackDays);
      rowsByInterval.set(tf, rows || []);
    }));

    const parentRows = rowsByInterval.get(parentFetchInterval) || [];
    if (!parentRows || parentRows.length === 0) {
      return res.status(404).json({ error: `No ${parentFetchInterval} data available for this ticker` });
    }

    // Convert parent stream to LA timezone and sort chronologically.
    const convertedParentBars = convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time));
    const convertedBars = interval === '1day'
      ? aggregate4HourBarsToDaily(convertedParentBars)
      : convertedParentBars;

    if (convertedBars.length === 0) {
      return res.status(404).json({ error: 'No valid chart bars available for this ticker' });
    }

    // Calculate RSI
    const closePrices = convertedBars.map(b => b.close);
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

    const normalizeSourceBars = (rows, tf) => normalizeIntradayVolumesFromCumulativeIfNeeded(
      convertToLATime(rows || [], tf).sort((a, b) => Number(a.time) - Number(b.time))
    );
    const vdSourceBars = normalizeSourceBars(rowsByInterval.get(vdSourceInterval) || [], vdSourceInterval);
    const vdRsiSourceBars = vdRsiSourceInterval === vdSourceInterval
      ? vdSourceBars
      : normalizeSourceBars(rowsByInterval.get(vdRsiSourceInterval) || [], vdRsiSourceInterval);

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

    res.json(result);

  } catch (err) {
    const message = err && err.message ? err.message : 'Failed to fetch chart data';
    console.error('Chart API Error:', message);
    res.status(502).json({ error: message });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

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

function isoWeekKeyFromEtUnixSeconds(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(new Date(Number(unixSeconds) * 1000));
  const year = Number(parts.find((p) => p.type === 'year')?.value || 0);
  const month = Number(parts.find((p) => p.type === 'month')?.value || 0);
  const day = Number(parts.find((p) => p.type === 'day')?.value || 0);
  if (!year || !month || !day) return '';

  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const weekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${weekYear}-W${String(weekNo).padStart(2, '0')}`;
}

function classifyDivergenceSignal(volumeDelta, close, prevClose) {
  if (!Number.isFinite(volumeDelta) || !Number.isFinite(close) || !Number.isFinite(prevClose)) return null;
  if (volumeDelta > 0 && close < prevClose) return 'bullish';
  if (volumeDelta < 0 && close > prevClose) return 'bearish';
  return null;
}

function aggregateDailyDivergenceToWeekly(dailyBars, dailyDeltas) {
  if (!Array.isArray(dailyBars) || dailyBars.length === 0) return [];
  const deltaByTime = new Map((dailyDeltas || []).map((point) => [Number(point.time), Number(point.delta) || 0]));
  const weekly = [];
  const byKey = new Map();

  for (const bar of dailyBars) {
    const time = Number(bar.time);
    if (!Number.isFinite(time)) continue;
    const weekKey = isoWeekKeyFromEtUnixSeconds(time);
    if (!weekKey) continue;
    const delta = Number(deltaByTime.get(time)) || 0;
    const existing = byKey.get(weekKey);
    if (!existing) {
      const seed = {
        weekKey,
        time,
        _lastTime: time,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        delta
      };
      byKey.set(weekKey, seed);
      weekly.push(seed);
      continue;
    }
    existing.high = Math.max(existing.high, Number(bar.high));
    existing.low = Math.min(existing.low, Number(bar.low));
    existing.delta += delta;
    if (time >= existing._lastTime) {
      existing._lastTime = time;
      existing.time = time;
      existing.close = Number(bar.close);
    }
  }

  return weekly.sort((a, b) => Number(a.time) - Number(b.time));
}

async function fetchUsStockUniverseFromFmp() {
  assertFmpKey();
  const urls = [
    buildFmpUrl(FMP_STABLE_BASE, '/stock/list', { apikey: FMP_KEY }),
    buildFmpUrl(FMP_LEGACY_BASE, '/stock/list', { apikey: FMP_KEY })
  ];

  let rows = null;
  let lastError = null;
  for (const url of urls) {
    try {
      const payload = await fetchFmpJson(url, 'FMP stock universe');
      if (Array.isArray(payload) && payload.length > 0) {
        rows = payload;
        break;
      }
    } catch (err) {
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      console.error(`FMP stock universe fetch failed (${sanitizeFmpUrl(url)}): ${message}`);
    }
  }

  if (!rows) {
    throw lastError || new Error('Unable to fetch stock universe from FMP');
  }

  const allowedExchangeFragments = ['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS', 'NEW YORK'];
  const symbols = [];
  for (const row of rows) {
    const symbol = normalizeTickerSymbol(row?.symbol);
    if (!symbol || symbol.includes('.') || symbol.includes('/')) continue;
    const exchange = String(row?.exchangeShortName || row?.exchange || row?.exchangeName || '').toUpperCase();
    const type = String(row?.type || row?.assetType || '').toLowerCase();
    const isEtf = String(row?.isEtf || '').toLowerCase() === 'true';
    const isFund = String(row?.isFund || '').toLowerCase() === 'true';
    const active = row?.isActivelyTrading;
    if (!allowedExchangeFragments.some((fragment) => exchange.includes(fragment))) continue;
    if (type && !type.includes('stock') && !type.includes('common')) continue;
    if (isEtf || isFund) continue;
    if (active === false || String(active).toLowerCase() === 'false') continue;
    symbols.push({ ticker: symbol, exchange: exchange || null, assetType: type || null });
  }

  const unique = new Map();
  for (const row of symbols) {
    if (!unique.has(row.ticker)) unique.set(row.ticker, row);
  }
  return Array.from(unique.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function refreshDivergenceSymbolUniverse(options = {}) {
  const fullReset = Boolean(options.fullReset);
  const symbols = await fetchUsStockUniverseFromFmp();
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

async function getDivergenceUniverseTickers() {
  if (!divergencePool) return [];
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
  if (storedTickers.length >= DIVERGENCE_MIN_UNIVERSE_SIZE) {
    return storedTickers;
  }

  try {
    const bootstrapped = await refreshDivergenceSymbolUniverse({ fullReset: false });
    if (bootstrapped.length > 0) {
      console.log(`Divergence universe bootstrap updated to ${bootstrapped.length} symbols.`);
      return bootstrapped;
    }
    if (storedTickers.length > 0) return storedTickers;
    return [];
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`FMP universe bootstrap failed, falling back to cached divergence symbols: ${message}`);
    return storedTickers;
  }
}

async function computeSymbolDivergenceSignals(ticker) {
  const parentFetchInterval = '4hour';
  const [parentRows, sourceRows] = await Promise.all([
    fmpIntradayChartHistory(ticker, parentFetchInterval, DIVERGENCE_SCAN_LOOKBACK_DAYS),
    fmpIntradayChartHistory(ticker, DIVERGENCE_SOURCE_INTERVAL, DIVERGENCE_SCAN_LOOKBACK_DAYS)
  ]);

  if (!Array.isArray(parentRows) || parentRows.length === 0) return [];
  const dailyBars = aggregate4HourBarsToDaily(
    convertToLATime(parentRows, parentFetchInterval).sort((a, b) => Number(a.time) - Number(b.time))
  );
  if (!Array.isArray(dailyBars) || dailyBars.length < 2) return [];

  const sourceBars = normalizeIntradayVolumesFromCumulativeIfNeeded(
    convertToLATime(sourceRows || [], DIVERGENCE_SOURCE_INTERVAL).sort((a, b) => Number(a.time) - Number(b.time))
  );
  const dailyDeltas = computeVolumeDeltaByParentBars(dailyBars, sourceBars, DIVERGENCE_SCAN_PARENT_INTERVAL);
  const deltaByTime = new Map(dailyDeltas.map((point) => [Number(point.time), Number(point.delta) || 0]));

  const results = [];

  const latestDaily = dailyBars[dailyBars.length - 1];
  const previousDaily = dailyBars[dailyBars.length - 2];
  if (latestDaily && previousDaily) {
    const latestDelta = Number(deltaByTime.get(Number(latestDaily.time))) || 0;
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

  return results;
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

async function updateDivergenceScanJob(jobId, patch) {
  if (!divergencePool || !jobId) return;
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(patch || {})) {
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx += 1;
  }
  if (!fields.length) return;
  values.push(jobId);
  await divergencePool.query(`UPDATE divergence_scan_jobs SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

async function upsertDivergenceSignal(signal, scanJobId) {
  if (!divergencePool) return;
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
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
    ON CONFLICT (trade_date, ticker, timeframe, source_interval)
    DO UPDATE SET
      signal_type = EXCLUDED.signal_type,
      price = EXCLUDED.price,
      prev_close = EXCLUDED.prev_close,
      volume_delta = EXCLUDED.volume_delta,
      timestamp = NOW(),
      scan_job_id = EXCLUDED.scan_job_id
  `, [
    signal.ticker,
    signal.signal_type,
    signal.trade_date,
    signal.price,
    signal.prev_close,
    signal.volume_delta,
    signal.timeframe,
    signal.source_interval,
    scanJobId
  ]);
}

async function runDailyDivergenceScan(options = {}) {
  if (!isDivergenceConfigured()) {
    return { status: 'disabled', reason: 'Divergence database is not configured' };
  }
  if (divergenceScanRunning) {
    return { status: 'running' };
  }

  const force = Boolean(options.force);
  const runDate = String(options.runDateEt || currentEtDateString()).trim();
  const trigger = String(options.trigger || 'manual');
  if (!force && divergenceLastScanDateEt === runDate) {
    return { status: 'skipped', reason: 'already-scanned', runDate };
  }

  divergenceScanRunning = true;
  let scanJobId = null;
  let processed = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  let errorCount = 0;

  try {
    const symbols = await getDivergenceUniverseTickers();
    const totalSymbols = symbols.length;
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

    if (totalSymbols === 0) {
      await updateDivergenceScanJob(scanJobId, {
        status: 'completed',
        finished_at: new Date(),
        processed_symbols: 0
      });
      divergenceLastScanDateEt = runDate;
      return { status: 'completed', runDate, processed: 0 };
    }

    const targetSpacingMs = Math.max(0, Math.floor((DIVERGENCE_SCAN_SPREAD_MINUTES * 60 * 1000) / totalSymbols));

    for (let i = 0; i < symbols.length; i += DIVERGENCE_SCAN_CONCURRENCY) {
      const batch = symbols.slice(i, i + DIVERGENCE_SCAN_CONCURRENCY);
      const startedAt = Date.now();
      await Promise.all(batch.map(async (ticker) => {
        try {
          const signals = await computeSymbolDivergenceSignals(ticker);
          for (const signal of signals) {
            await upsertDivergenceSignal(signal, scanJobId);
            if (signal.signal_type === 'bullish') bullishCount += 1;
            if (signal.signal_type === 'bearish') bearishCount += 1;
          }
        } catch (err) {
          errorCount += 1;
          const message = err && err.message ? err.message : String(err);
          console.error(`Divergence scan failed for ${ticker}: ${message}`);
        } finally {
          processed += 1;
        }
      }));

      if (scanJobId && (processed % 50 === 0 || processed === totalSymbols)) {
        await updateDivergenceScanJob(scanJobId, {
          processed_symbols: processed,
          bullish_count: bullishCount,
          bearish_count: bearishCount,
          error_count: errorCount
        });
      }

      const elapsed = Date.now() - startedAt;
      if (targetSpacingMs > elapsed) {
        await sleep(targetSpacingMs - elapsed);
      }
    }

    await updateDivergenceScanJob(scanJobId, {
      status: 'completed',
      finished_at: new Date(),
      processed_symbols: processed,
      bullish_count: bullishCount,
      bearish_count: bearishCount,
      error_count: errorCount
    });
    divergenceLastScanDateEt = runDate;
    return {
      status: 'completed',
      runDate,
      processed,
      bullishCount,
      bearishCount,
      errorCount
    };
  } catch (err) {
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
    divergenceScanRunning = false;
  }
}

function getNextDivergenceScanUtcMs(nowUtc = new Date()) {
  const nowEt = new Date(nowUtc.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const candidate = new Date(nowEt);
  candidate.setHours(16, 20, 0, 0);

  if (!isEtWeekday(candidate) || nowEt.getTime() >= candidate.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    while (!isEtWeekday(candidate)) {
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

function scheduleNextDivergenceScan() {
  if (!isDivergenceConfigured() || !DIVERGENCE_SCANNER_ENABLED) return;
  if (divergenceSchedulerTimer) clearTimeout(divergenceSchedulerTimer);
  const nextRunMs = getNextDivergenceScanUtcMs(new Date());
  const delayMs = Math.max(1000, nextRunMs - Date.now());
  divergenceSchedulerTimer = setTimeout(async () => {
    try {
      await runDailyDivergenceScan({ trigger: 'scheduler' });
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

app.post('/api/divergence/scan', async (req, res) => {
  if (!isDivergenceConfigured()) {
    return res.status(503).json({ error: 'Divergence database is not configured' });
  }
  const configuredSecret = String(process.env.DIVERGENCE_SCAN_SECRET || '').trim();
  const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
  if (configuredSecret && configuredSecret !== providedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (divergenceScanRunning) {
    return res.status(409).json({ status: 'running' });
  }

  const force = String(req.query.force || '').toLowerCase() === 'true' || req.body?.force === true;
  const runDateEt = req.body?.runDateEt ? String(req.body.runDateEt).trim() : undefined;
  runDailyDivergenceScan({ force, runDateEt, trigger: 'manual-api' })
    .then((summary) => {
      console.log('Manual divergence scan completed:', summary);
    })
    .catch((err) => {
      const message = err && err.message ? err.message : String(err);
      console.error(`Manual divergence scan failed: ${message}`);
    });

  return res.status(202).json({ status: 'started' });
});

app.get('/api/divergence/scan/status', async (req, res) => {
  if (!isDivergenceConfigured()) {
    return res.status(503).json({ error: 'Divergence database is not configured' });
  }
  try {
    const latest = await divergencePool.query(`
      SELECT *
      FROM divergence_scan_jobs
      ORDER BY started_at DESC
      LIMIT 1
    `);
    res.json({
      running: divergenceScanRunning,
      lastScanDateEt: divergenceLastScanDateEt || null,
      latestJob: latest.rows[0] || null
    });
  } catch (err) {
    console.error('Failed to fetch divergence scan status:', err);
    res.status(500).json({ error: 'Failed to fetch scan status' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  scheduleNextDivergenceScan();
});

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
}, 15 * 60 * 1000);
if (typeof vdRsiCacheCleanupTimer.unref === 'function') {
  vdRsiCacheCleanupTimer.unref();
}

async function fmpIntraday(symbol, interval, options = {}) {
  const { from, to } = options;
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

  return normalized.length ? normalized : null;
}

const CHART_INTRADAY_LOOKBACK_DAYS = 365;
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
  let rma = null;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      continue;
    }
    if (rma === null) {
      rma = value;
    } else {
      rma = ((rma * (period - 1)) + value) / period;
    }
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
    '4hour': 4 * 60 * 60
  };
  return map[interval] || 60;
}

function computeVolumeDeltaByParentBars(parentBars, lowerTimeframeBars, interval) {
  if (!Array.isArray(parentBars) || parentBars.length === 0) return [];
  if (!Array.isArray(lowerTimeframeBars) || lowerTimeframeBars.length === 0) {
    return parentBars.map((bar) => ({ time: bar.time, delta: null }));
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
      deltas.push({ time: parentBars[i].time, delta: null });
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

  return { rsi };
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
  const VOLUME_DELTA_RSI_LOWER_TF = '5min';
  // Force VD-RSI to always be derived from 5-minute volume-delta bars
  // across the full chart history window.
  const VOLUME_DELTA_RSI_LOOKBACK_DAYS = CHART_INTRADAY_LOOKBACK_DAYS;
  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(req.query.vdRsiLength) || 14)));

  // Validate interval
  const validIntervals = ['5min', '15min', '30min', '1hour', '4hour'];
  if (!validIntervals.includes(interval)) {
    return res.status(400).json({ error: 'Invalid interval. Use: 5min, 15min, 30min, 1hour, or 4hour' });
  }

  try {
    const bars = await fmpIntradayChartHistory(ticker, interval, CHART_INTRADAY_LOOKBACK_DAYS);
    if (!bars || bars.length === 0) {
      return res.status(404).json({ error: `No ${interval} data available for this ticker` });
    }

    // Convert to LA timezone and sort chronologically.
    const convertedBars = convertToLATime(bars, interval).sort((a, b) => Number(a.time) - Number(b.time));

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

    let volumeDeltaRsi = { rsi: [] };
    const cacheExpiryMs = getVdRsiCacheExpiryMs(new Date());
    const firstBarTime = convertedBars[0]?.time ?? '';
    const lastBarTime = convertedBars[convertedBars.length - 1]?.time ?? '';
    const vdRsiResultCacheKey = `${ticker}|${interval}|${vdRsiLength}|${convertedBars.length}|${firstBarTime}|${lastBarTime}`;
    const cachedVolumeDeltaRsi = getTimedCacheValue(VD_RSI_RESULT_CACHE, vdRsiResultCacheKey);
    if (cachedVolumeDeltaRsi) {
      volumeDeltaRsi = cachedVolumeDeltaRsi;
    } else {
    try {
      let lowerTfBars = [];
      const lowerTfCacheKey = `${ticker}|${VOLUME_DELTA_RSI_LOWER_TF}|${VOLUME_DELTA_RSI_LOOKBACK_DAYS}`;
      const cachedLowerTfBars = getTimedCacheValue(VD_RSI_LOWER_TF_CACHE, lowerTfCacheKey);
      if (cachedLowerTfBars) {
        lowerTfBars = cachedLowerTfBars;
      } else {
        const lowerTfRows = await fmpIntradayChartHistory(
          ticker,
          VOLUME_DELTA_RSI_LOWER_TF,
          VOLUME_DELTA_RSI_LOOKBACK_DAYS
        );
        lowerTfBars = convertToLATime(lowerTfRows || [], VOLUME_DELTA_RSI_LOWER_TF)
          .sort((a, b) => Number(a.time) - Number(b.time));
        if (lowerTfBars.length > 0) {
          setTimedCacheValue(VD_RSI_LOWER_TF_CACHE, lowerTfCacheKey, lowerTfBars, cacheExpiryMs);
        }
      }
      if (lowerTfBars.length > 0) {
        const firstParentTime = Number(firstBarTime);
        const lastParentTime = Number(lastBarTime);
        const parentWindowStart = Number.isFinite(firstParentTime) ? firstParentTime : Number.NEGATIVE_INFINITY;
        const parentWindowEndExclusive = Number.isFinite(lastParentTime)
          ? (lastParentTime + getIntervalSeconds(interval))
          : Number.POSITIVE_INFINITY;
        const lowerTfBarsInParentRange = lowerTfBars.filter((bar) => {
          const t = Number(bar.time);
          return Number.isFinite(t) && t >= parentWindowStart && t < parentWindowEndExclusive;
        });

        volumeDeltaRsi = calculateVolumeDeltaRsiSeries(
          convertedBars,
          lowerTfBarsInParentRange,
          interval,
          { rsiLength: vdRsiLength }
        );
        setTimedCacheValue(VD_RSI_RESULT_CACHE, vdRsiResultCacheKey, volumeDeltaRsi, cacheExpiryMs);
      }
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
      volumeDeltaRsi
    };

    res.json(result);

  } catch (err) {
    const message = err && err.message ? err.message : 'Failed to fetch chart data';
    console.error('Chart API Error:', message);
    res.status(502).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

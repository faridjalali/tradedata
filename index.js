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

async function fmpDaily(symbol) {
  const symbolEncoded = encodeURIComponent(symbol);
  const urls = [
    // Prefer full endpoints so daily candlesticks have true OHLC bars.
    buildFmpUrl(FMP_STABLE_BASE, '/historical-price-eod/full', { symbol, apikey: FMP_KEY, timeseries: 250 }),
    buildFmpUrl(FMP_LEGACY_BASE, `/historical-price-full/${symbolEncoded}`, { apikey: FMP_KEY, timeseries: 250 }),
    // Fall back to light only if full is unavailable for the account/endpoint.
    buildFmpUrl(FMP_STABLE_BASE, '/historical-price-eod/light', { symbol, apikey: FMP_KEY }),
    buildFmpUrl(FMP_LEGACY_BASE, '/historical-price-eod/light', { symbol, apikey: FMP_KEY })
  ];

  const rows = await fetchFmpArrayWithFallback('FMP daily', urls);
  const normalized = rows.map((row) => {
    const dateRaw = typeof row.date === 'string' ? row.date.trim() : '';
    const date = dateRaw ? dateRaw.slice(0, 10) : null;
    // Prefer explicit OHLC values from full endpoints.
    const close = toNumberOrNull(row.close ?? row.price);
    const open = toNumberOrNull(row.open) ?? close;
    const high = toNumberOrNull(row.high) ?? close;
    const low = toNumberOrNull(row.low) ?? close;
    const volume = toNumberOrNull(row.volume) ?? 0;

    if (!date || close === null || open === null || high === null || low === null) {
      return null;
    }

    const boundedHigh = Math.max(high, open, close);
    const boundedLow = Math.min(low, open, close);
    return { date, open, high: boundedHigh, low: boundedLow, close, volume };
  }).filter(Boolean);

  return normalized.length ? normalized : null;
}

async function fmpIntraday(symbol, interval) {
  const symbolEncoded = encodeURIComponent(symbol);
  const urls = [
    buildFmpUrl(FMP_STABLE_BASE, `/historical-chart/${interval}`, { symbol, apikey: FMP_KEY }),
    buildFmpUrl(FMP_LEGACY_BASE, `/historical-chart/${interval}/${symbolEncoded}`, { apikey: FMP_KEY }),
    buildFmpUrl(FMP_LEGACY_BASE, `/historical-chart/${interval}`, { symbol, apikey: FMP_KEY })
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
  if (closePrices.length < period + 1) return [];

  // Calculate price changes
  const changes = [];
  for (let i = 1; i < closePrices.length; i++) {
    changes.push(closePrices[i] - closePrices[i - 1]);
  }

  // Calculate initial averages for first 'period' changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiValues = [];

  // First RSI value
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiValues.push(100 - (100 / (1 + rs0)));

  // Subsequent RSI values using smoothed averages
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - (100 / (1 + rs)));
  }

  return rsiValues;
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
    // Daily data: Already in YYYY-MM-DD format
    if (interval === '1day') {
      converted.push({
        time: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0
      });
      continue;
    }

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

// --- Cache expiry helpers ---
function getNextCacheExpiry() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etNow = new Date(etStr);
  const target = new Date(etNow);
  target.setHours(16, 1, 0, 0);
  if (etNow >= target) target.setDate(target.getDate() + 1);
  const diffMs = target.getTime() - etNow.getTime();
  return now.getTime() + diffMs;
}

function isCacheValid(entry) {
  if (!entry) return false;
  return Date.now() < entry.expiresAt;
}

// --- Breadth API ---
// SPY cached separately (daily + intraday), shared across all metrics.
let spyDailyCache = { expiresAt: 0, bars: null };
let spyIntradayCache = { expiresAt: 0, bars: null };
const breadthDailyCache = new Map();
const breadthIntradayCache = new Map();

// --- Chart API Cache ---
const chartCache = new Map();

async function getSpyDaily() {
  if (spyDailyCache.bars && Date.now() < spyDailyCache.expiresAt) return spyDailyCache.bars;
  const bars = await fmpDaily('SPY');
  if (bars) spyDailyCache = { expiresAt: getNextCacheExpiry(), bars };
  return bars;
}

async function getSpyIntraday() {
  if (spyIntradayCache.bars && Date.now() < spyIntradayCache.expiresAt) return spyIntradayCache.bars;
  const bars = await fmpIntraday30('SPY');
  if (bars) spyIntradayCache = { expiresAt: Date.now() + 5 * 60 * 1000, bars };
  return bars;
}

app.get('/api/breadth', async (req, res) => {
  const compTicker = (req.query.ticker || 'SVIX').toString().toUpperCase();
  const days = Math.min(Math.max(parseInt(req.query.days) || 5, 1), 60);
  const isIntraday = days === 1;

  try {
    if (isIntraday) {
      // --- Intraday path (30-min bars, today only) ---
      const cached = breadthIntradayCache.get(compTicker);
      if (isCacheValid(cached)) return res.json(cached.data);

      const [spyBars, compBars] = await Promise.all([
        getSpyIntraday(),
        fmpIntraday30(compTicker)
      ]);

      if (!spyBars || !compBars) {
        return res.status(404).json({ error: 'No intraday data available (market may be closed)' });
      }

      // Today's date in ET
      const todayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const y = todayET.getFullYear();
      const mo = String(todayET.getMonth() + 1).padStart(2, '0');
      const da = String(todayET.getDate()).padStart(2, '0');
      const todayStr = `${y}-${mo}-${da}`;

      const isRegularHours = (dtStr) => {
        const parts = dtStr.split(' ');
        if (parts.length < 2) return false;
        const [h, m] = parts[1].split(':').map(Number);
        const totalMin = h * 60 + m;
        return totalMin >= 570 && totalMin <= 960;
      };

      const roundTo30Min = (dtStr) => {
        // Parse FMP string (ET) as proper UTC timestamp
        // 1. Treat input as UTC
        const asUTC = new Date(dtStr.replace(' ', 'T') + 'Z');
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
      };

      const spyMap = new Map();
      for (const bar of spyBars) {
        if (bar.datetime.startsWith(todayStr) && isRegularHours(bar.datetime)) {
          spyMap.set(roundTo30Min(bar.datetime), bar.close);
        }
      }

      const compMap = new Map();
      for (const bar of compBars) {
        if (bar.datetime.startsWith(todayStr) && isRegularHours(bar.datetime)) {
          compMap.set(roundTo30Min(bar.datetime), bar.close);
        }
      }

      const commonKeys = [...spyMap.keys()].filter(k => compMap.has(k)).sort((a, b) => a - b);

      const result = {
        intraday: true,
        points: commonKeys.map(k => ({
          date: new Date(k).toISOString(),
          spy: Math.round(spyMap.get(k) * 100) / 100,
          comparison: Math.round(compMap.get(k) * 100) / 100
        }))
      };

      breadthIntradayCache.set(compTicker, { expiresAt: Date.now() + 5 * 60 * 1000, data: result });
      return res.json(result);
    }

    // --- Daily path ---
    const cached = breadthDailyCache.get(compTicker);
    if (isCacheValid(cached)) {
      const points = cached.allPoints.slice(-days);
      return res.json({ intraday: false, points });
    }

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

    breadthDailyCache.set(compTicker, { expiresAt: getNextCacheExpiry(), allPoints });

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
  const interval = (req.query.interval || '1day').toString();

  // Validate interval
  const validIntervals = ['1hour', '4hour', '1day'];
  if (!validIntervals.includes(interval)) {
    return res.status(400).json({ error: 'Invalid interval. Use: 1hour, 4hour, or 1day' });
  }

  const cacheKey = `${ticker}_${interval}`;

  try {
    // Check cache first
    const cached = chartCache.get(cacheKey);
    if (isCacheValid(cached)) {
      return res.json(cached.data);
    }

    let bars = [];

    // Fetch data based on interval
    if (interval === '1day') {
      const allBars = await fmpDaily(ticker);
      if (!allBars || allBars.length === 0) {
        return res.status(404).json({ error: 'No daily data available for this ticker' });
      }
      bars = allBars.slice(-180);
    } else if (interval === '1hour') {
      const intradayBars = await fmpIntraday1Hour(ticker);
      if (!intradayBars || intradayBars.length === 0) {
        return res.status(404).json({ error: 'No 1-hour data available for this ticker' });
      }
      bars = intradayBars;
    } else if (interval === '4hour') {
      const intradayBars = await fmpIntraday4Hour(ticker);
      if (!intradayBars || intradayBars.length === 0) {
        return res.status(404).json({ error: 'No 4-hour data available for this ticker' });
      }
      bars = intradayBars;
    }

    // Convert to LA timezone and sort chronologically.
    const convertedBars = convertToLATime(bars, interval).sort((a, b) => {
      if (interval === '1day') {
        return String(a.time).localeCompare(String(b.time));
      }
      return Number(a.time) - Number(b.time);
    });

    if (convertedBars.length === 0) {
      return res.status(404).json({ error: 'No valid chart bars available for this ticker' });
    }

    // Calculate RSI
    const closePrices = convertedBars.map(b => b.close);
    const rsiValues = calculateRSI(closePrices, 14);

    // RSI values begin after the warmup period. Keep only finite points.
    const rsi = [];
    for (let i = 14; i < convertedBars.length; i++) {
      const raw = rsiValues[i - 14];
      if (!Number.isFinite(raw)) continue;
      rsi.push({
        time: convertedBars[i].time,
        value: Math.round(raw * 100) / 100
      });
    }

    const result = {
      interval,
      timezone: 'America/Los_Angeles',
      bars: convertedBars,
      rsi
    };

    // Cache
    const expiresAt = interval === '1day' 
      ? getNextCacheExpiry() 
      : Date.now() + 5 * 60 * 1000;

    chartCache.set(cacheKey, { expiresAt, data: result });
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

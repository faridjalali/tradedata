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
const FMP_BASE = 'https://financialmodelingprep.com/stable';

async function fmpDaily(symbol) {
  const url = `${FMP_BASE}/historical-price-eod/light?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FMP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.map(d => ({ date: d.date, close: d.price }));
}

async function fmpIntraday30(symbol) {
  const url = `${FMP_BASE}/historical-chart/30min?symbol=${encodeURIComponent(symbol)}&apikey=${FMP_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`FMP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.map(d => ({ datetime: d.date, close: d.close }));
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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});



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

// --- GEX (Gamma Exposure) API ---
const YahooFinance = require("yahoo-finance2").default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// In-memory GEX cache (5 min TTL)
const gexCache = new Map();
const GEX_CACHE_TTL = 5 * 60 * 1000;

// --- Black-Scholes helpers ---
function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsGamma(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normalPdf(d1) / (S * sigma * Math.sqrt(T));
}

app.get('/api/gex/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();

  // Check cache
  const cached = gexCache.get(ticker);
  if (cached && Date.now() - cached.ts < GEX_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    // 1. Fetch first expiration to get spot price and expiration list
    const firstChain = await yf.options(ticker);
    const spotPrice = firstChain.quote.regularMarketPrice;

    if (!spotPrice) {
      return res.status(404).json({ error: `No price data for ${ticker}` });
    }

    // 2. Collect all expirations (up to 6 nearest)
    const expirationDates = (firstChain.expirationDates || []).slice(0, 6);
    const now = new Date();
    const riskFreeRate = 0.045;

    // Net gamma per strike: gamma * OI * 100  (calls positive, puts negative)
    const gexByStrike = {};

    // Process first expiration
    function processChain(options, expiryDate) {
      const T = Math.max((expiryDate - now) / (365.25 * 24 * 60 * 60 * 1000), 1 / 365);

      for (const opt of (options.calls || [])) {
        if (!opt.openInterest || opt.openInterest === 0) continue;
        const iv = opt.impliedVolatility || 0.3;
        const gamma = bsGamma(spotPrice, opt.strike, T, riskFreeRate, iv);
        if (!gamma || isNaN(gamma)) continue;
        const gex = gamma * opt.openInterest * 100;
        gexByStrike[opt.strike] = (gexByStrike[opt.strike] || 0) + gex;
      }

      for (const opt of (options.puts || [])) {
        if (!opt.openInterest || opt.openInterest === 0) continue;
        const iv = opt.impliedVolatility || 0.3;
        const gamma = bsGamma(spotPrice, opt.strike, T, riskFreeRate, iv);
        if (!gamma || isNaN(gamma)) continue;
        const gex = gamma * opt.openInterest * 100;
        gexByStrike[opt.strike] = (gexByStrike[opt.strike] || 0) - gex; // puts negative
      }
    }

    // Process first expiration (already fetched)
    if (firstChain.options && firstChain.options[0]) {
      const expDate = expirationDates[0] instanceof Date
        ? expirationDates[0]
        : new Date(expirationDates[0] * 1000);
      processChain(firstChain.options[0], expDate);
    }

    // Fetch remaining expirations
    for (let i = 1; i < expirationDates.length; i++) {
      try {
        const expEpoch = expirationDates[i] instanceof Date
          ? Math.floor(expirationDates[i].getTime() / 1000)
          : expirationDates[i];
        const chain = await yf.options(ticker, { date: new Date(expEpoch * 1000) });
        if (chain.options && chain.options[0]) {
          processChain(chain.options[0], new Date(expEpoch * 1000));
        }
      } catch (e) {
        // Skip failed expirations
        console.error(`GEX: failed to fetch expiration ${i} for ${ticker}:`, e.message);
      }
    }

    // 3. Sort strikes and build response
    const allStrikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);

    if (allStrikes.length === 0) {
      return res.json({ spot_price: spotPrice, strikes: [], gex: [], total_gex: 0, message: 'No options data available' });
    }

    const gex = allStrikes.map(s => Math.round(gexByStrike[s]));
    const totalGex = gex.reduce((sum, v) => sum + v, 0);

    const result = {
      spot_price: spotPrice,
      strikes: allStrikes,
      gex,
      total_gex: totalGex
    };

    // Cache result
    gexCache.set(ticker, { ts: Date.now(), data: result });

    res.json(result);
  } catch (err) {
    console.error('GEX API Error:', err);
    res.status(500).json({ error: 'Failed to fetch GEX data: ' + err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

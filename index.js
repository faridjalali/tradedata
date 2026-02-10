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
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || "pig0ix6gPImcxdqhUmvTCUnjVPKVmkC0";
const POLYGON_BASE = "https://api.polygon.io";

// In-memory GEX cache (5 min TTL)
const gexCache = new Map();
const GEX_CACHE_TTL = 5 * 60 * 1000;

// --- Black-Scholes helpers ---
function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function bsGamma(S, K, T, r, sigma) {
  // S=spot, K=strike, T=time to expiry in years, r=risk-free rate, sigma=IV
  if (T <= 0 || sigma <= 0) return 0;
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
    // 1. Get spot price via previous-day close (free plan)
    const prevRes = await fetch(`${POLYGON_BASE}/v2/aggs/ticker/${ticker}/prev?apiKey=${POLYGON_API_KEY}`);
    const prevData = await prevRes.json();
    
    if (!prevData.results || prevData.results.length === 0) {
      return res.status(404).json({ error: `No price data for ${ticker}` });
    }
    const spotPrice = prevData.results[0].c; // closing price

    // 2. Get options contracts (paginated, free plan)
    // Filter to expirations within 60 days
    const now = new Date();
    const maxExpiry = new Date(now);
    maxExpiry.setDate(maxExpiry.getDate() + 60);
    const nowStr = now.toISOString().split('T')[0];
    const maxStr = maxExpiry.toISOString().split('T')[0];

    let allContracts = [];
    let nextUrl = `${POLYGON_BASE}/v3/reference/options/contracts?underlying_ticker=${ticker}&expiration_date.gte=${nowStr}&expiration_date.lte=${maxStr}&limit=250&apiKey=${POLYGON_API_KEY}`;

    while (nextUrl) {
      const chainRes = await fetch(nextUrl);
      const chainData = await chainRes.json();

      if (chainData.results) {
        allContracts = allContracts.concat(chainData.results);
      }

      nextUrl = chainData.next_url
        ? `${chainData.next_url}&apiKey=${POLYGON_API_KEY}`
        : null;
    }

    if (allContracts.length === 0) {
      return res.json({ spot_price: spotPrice, strikes: [], gex: [], total_gex: 0, message: 'No options data available' });
    }

    // 3. Calculate GEX per strike using Black-Scholes gamma
    // Since OI isn't available on the free plan, we use a uniform OI estimate
    // weighted by proximity to the money (ATM options have higher OI)
    const riskFreeRate = 0.05;  // approximate
    const impliedVol = 0.30;    // approximate average IV
    const baseOI = 1000;        // uniform OI estimate
    const gexByStrike = {};

    for (const c of allContracts) {
      const strike = c.strike_price;
      const contractType = c.contract_type;
      const expiryDate = new Date(c.expiration_date);
      const T = Math.max((expiryDate - now) / (365.25 * 24 * 60 * 60 * 1000), 1/365); // years

      // Filter to spot ±15%
      if (strike < spotPrice * 0.85 || strike > spotPrice * 1.15) continue;

      // Compute Black-Scholes gamma
      const gamma = bsGamma(spotPrice, strike, T, riskFreeRate, impliedVol);
      if (gamma === 0 || isNaN(gamma)) continue;

      // Weight OI by moneyness (ATM gets 3x, deep OTM gets ~0.3x)
      const moneyness = Math.abs(spotPrice - strike) / spotPrice;
      const oiWeight = Math.max(0.3, 1 - moneyness * 5) * (moneyness < 0.05 ? 3 : 1);
      const estimatedOI = baseOI * oiWeight;

      // GEX = gamma * OI * 100 * spot * (spot * 0.01)
      let gexNotional = gamma * estimatedOI * 100 * spotPrice * (spotPrice * 0.01);

      // Flip sign for puts
      if (contractType === 'put') gexNotional *= -1;

      gexByStrike[strike] = (gexByStrike[strike] || 0) + gexNotional;
    }

    // 4. Filter to spot ±10% and sort
    const lower = spotPrice * 0.90;
    const upper = spotPrice * 1.10;

    const strikes = Object.keys(gexByStrike)
      .map(Number)
      .filter(s => s >= lower && s <= upper)
      .sort((a, b) => a - b);

    const gex = strikes.map(s => gexByStrike[s]);
    const totalGex = gex.reduce((sum, v) => sum + v, 0);

    const result = {
      spot_price: spotPrice,
      strikes,
      gex,
      total_gex: totalGex
    };

    // Cache result
    gexCache.set(ticker, { ts: Date.now(), data: result });

    res.json(result);
  } catch (err) {
    console.error('GEX API Error:', err);
    res.status(500).json({ error: 'Failed to fetch GEX data' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

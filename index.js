const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.get("/", (req, res) => {
  res.send("TradingView Alerts API is running");
});

// Endpoint for TradingView Webhook
app.post("/webhook", async (req, res) => {
  const secret = req.query.secret;
  // Simple security check
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    // Log for debugging but reject
    console.log("Unauthorized access attempt");
    return res.status(401).send("Unauthorized");
  }



  try {
    // Ensure table exists (Auto-migration for simplicity)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        ticker VARCHAR(20) NOT NULL,
        signal_type VARCHAR(10) NOT NULL,
        price DECIMAL(15, 2) NOT NULL,
        message TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    // Attempt to add new columns if they don't exist (Migration)
    try {
        await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS timeframe VARCHAR(10)`);
        await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS signal_direction INTEGER`);
        await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS signal_volume INTEGER`);
        await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS intensity_score INTEGER`);
        await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS combo_score INTEGER`);
    } catch (e) {
        console.log('Migration note:', e.message);
    }

    // Map Pine Script inputs to DB columns
    // Accepted JSON keys: ticker, time (opt), signalDir, signalVol, finalIntensityScore, comboScore
    const ticker = req.body.ticker;
    const signalDir = req.body.signalDir || 0;
    
    // Infer signal_type from direction for backward compatibility
    let signal = 'neutral';
    if (signalDir == 1) signal = 'bullish';
    if (signalDir == -1) signal = 'bearish';

    // Optional fields with defaults
    const price = req.body.price || 0;
    const message = req.body.message || '';
    
    // Strict 1d/1w Logic
    // If input contains 'w' (case-insensitive), it's 1w. Otherwise 1d.
    const rawTf = (req.body.timeframe || '').toString().toLowerCase();
    const timeframe = rawTf.includes('w') ? '1w' : '1d'; 

    const signalDirection = signalDir;
    const signalVolume = req.body.signalVol || 0;
    const intensityScore = req.body.finalIntensityScore || 0;
    const comboScore = req.body.comboScore || 0;

    if (!ticker) {
        return res.status(400).send("Missing ticker");
    }
    
    const query = `
      INSERT INTO alerts(ticker, signal_type, price, message, timeframe, signal_direction, signal_volume, intensity_score, combo_score) 
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) 
      RETURNING *
    `;
    const values = [ticker, signal, price, message, timeframe, signalDirection, signalVolume, intensityScore, comboScore];
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
    
    let query = 'SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100'; // Default limit
    let values = [];

    if (startDate && endDate) {
        query = `SELECT * FROM alerts WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp DESC`;
        values = [startDate, endDate];
    } else if (days > 0) {
        query = `SELECT * FROM alerts WHERE timestamp >= NOW() - INTERVAL '${days} days' ORDER BY timestamp DESC`;
    }
    
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

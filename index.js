const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('dist'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

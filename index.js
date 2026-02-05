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

  const { ticker, signal, price, message } = req.body;

  if (!ticker || !signal) {
    return res.status(400).send("Missing ticker or signal fields");
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
    
    // Attempt to add timeframe column if it doesn't exist (Migration)
    try {
        await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS timeframe VARCHAR(10)`);
    } catch (e) {
        // Ignore error if column exists or other minor issue
        console.log('Migration note:', e.message);
    }

    const timeframe = req.body.timeframe || 'daily'; // Default to daily if missing
    
    const query = 'INSERT INTO alerts(ticker, signal_type, price, message, timeframe) VALUES($1, $2, $3, $4, $5) RETURNING *';
    const values = [ticker, signal, price, message || '', timeframe];
    const result = await pool.query(query, values);
    console.log('Alert received:', result.rows[0]);
    res.status(200).send('Alert Received');
  } catch (err) {
    console.error("Database error:", err);
    res.status(500).send("Server Error");
  }
});

app.get("/api/alerts", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 50",
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

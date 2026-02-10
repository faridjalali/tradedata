CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  ticker VARCHAR(20) NOT NULL,
  signal_type VARCHAR(10) NOT NULL,
  price DECIMAL(15, 2) NOT NULL,
  message TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  timeframe VARCHAR(10),
  signal_direction INTEGER,
  signal_volume INTEGER,
  intensity_score INTEGER,
  combo_score INTEGER,
  is_favorite BOOLEAN DEFAULT FALSE
);

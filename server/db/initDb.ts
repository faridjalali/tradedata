import { pool, divergencePool } from '../db.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { loadRunHistoryFromDb, runMetricsHistory } from '../services/metricsService.js';
import {
  fetchDailyScan,
  fetchWeeklyScan,
  setDivergenceLastFetchedTradeDateEt,
  divergenceLastFetchedTradeDateEt,
} from '../services/scanControlService.js';
import { maxEtDateString } from '../lib/dateUtils.js';

export async function initDB(): Promise<void> {
  try {
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

    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_timestamp ON alerts (timestamp DESC)`);

    const columnMigrations = [
      { name: 'timeframe', definition: 'VARCHAR(10)' },
      { name: 'signal_direction', definition: 'INTEGER' },
      { name: 'signal_volume', definition: 'INTEGER' },
      { name: 'intensity_score', definition: 'INTEGER' },
      { name: 'combo_score', definition: 'INTEGER' },
      { name: 'is_favorite', definition: 'BOOLEAN DEFAULT FALSE' },
    ];
    const safeIdentifier = /^[a-z_][a-z0-9_]{0,62}$/;
    await Promise.allSettled(
      columnMigrations.map(({ name, definition }) => {
        if (!safeIdentifier.test(name)) {
          console.error(`Migration skipped: invalid column name "${name}"`);
          return Promise.resolve();
        }
        const sql = `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "${name}" ${definition}`;
        return pool.query(sql).catch((e) => console.log(`Migration note for ${name}:`, e.message));
      }),
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS run_metrics_history (
        id SERIAL PRIMARY KEY,
        run_id VARCHAR(120) NOT NULL UNIQUE,
        run_type VARCHAR(40) NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'unknown',
        snapshot JSONB NOT NULL,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_metrics_history_created ON run_metrics_history (created_at DESC)`,
    );

    const persisted = await loadRunHistoryFromDb();
    if (persisted.length > 0) {
      runMetricsHistory.push(...persisted);
      console.log(`Loaded ${persisted.length} persisted run history entries`);
    }

    console.log('Database initialized successfully');
  } catch (err: unknown) {
    console.error('Failed to initialize database:', err);
  }
}

export async function initDivergenceDB(): Promise<void> {
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
        source_interval VARCHAR(10) NOT NULL DEFAULT '1min',
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
        scanned_trade_date DATE,
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
    await divergencePool.query(`ALTER TABLE divergence_scan_jobs ADD COLUMN IF NOT EXISTS scanned_trade_date DATE`);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_symbols (
        ticker VARCHAR(20) PRIMARY KEY,
        exchange VARCHAR(40),
        asset_type VARCHAR(40),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_daily_bars (
        ticker VARCHAR(20) NOT NULL,
        trade_date DATE NOT NULL,
        source_interval VARCHAR(10) NOT NULL DEFAULT '1min',
        close DECIMAL(15, 4) NOT NULL,
        prev_close DECIMAL(15, 4) NOT NULL,
        volume_delta DECIMAL(20, 4) NOT NULL,
        scan_job_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (ticker, trade_date, source_interval)
      );
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_daily_bars_trade_date_idx
      ON divergence_daily_bars(source_interval, trade_date DESC, ticker ASC);
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_summaries (
        ticker VARCHAR(20) NOT NULL,
        source_interval VARCHAR(10) NOT NULL DEFAULT '1min',
        trade_date DATE NOT NULL,
        state_1d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_3d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_7d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_14d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        state_28d VARCHAR(10) NOT NULL DEFAULT 'neutral',
        ma8_above BOOLEAN,
        ma21_above BOOLEAN,
        ma50_above BOOLEAN,
        ma200_above BOOLEAN,
        scan_job_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (ticker, source_interval)
      );
    `);
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma8_above BOOLEAN`);
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma21_above BOOLEAN`);
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma50_above BOOLEAN`);
    await divergencePool.query(`ALTER TABLE divergence_summaries ADD COLUMN IF NOT EXISTS ma200_above BOOLEAN`);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_summaries_trade_date_idx
      ON divergence_summaries(source_interval, trade_date DESC, ticker ASC);
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_signals_timeframe_tradedate_idx
      ON divergence_signals(source_interval, timeframe, trade_date DESC);
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_summaries_source_ticker_idx
      ON divergence_summaries(source_interval, ticker);
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS divergence_publication_state (
        source_interval VARCHAR(10) PRIMARY KEY,
        published_trade_date DATE,
        last_scan_job_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS vdf_results (
        ticker VARCHAR(20) NOT NULL,
        trade_date VARCHAR(10) NOT NULL,
        is_detected BOOLEAN NOT NULL DEFAULT FALSE,
        composite_score REAL DEFAULT 0,
        status TEXT DEFAULT '',
        weeks INTEGER DEFAULT 0,
        result_json TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (ticker, trade_date)
      );
    `);
    await divergencePool.query(`
      CREATE TABLE IF NOT EXISTS mini_chart_bars (
        ticker VARCHAR(20) NOT NULL,
        trade_date DATE NOT NULL,
        open_price DOUBLE PRECISION NOT NULL,
        high_price DOUBLE PRECISION NOT NULL,
        low_price DOUBLE PRECISION NOT NULL,
        close_price DOUBLE PRECISION NOT NULL,
        bar_time BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (ticker, trade_date)
      );
    `);
    await divergencePool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'htf_results') THEN
          DROP TABLE IF EXISTS htf_results;
        END IF;
      END $$;
    `);
    await divergencePool.query(`
      DO $$ BEGIN
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS best_zone_score REAL DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS proximity_score REAL DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS proximity_level VARCHAR(10) DEFAULT 'none';
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS num_zones INTEGER DEFAULT 0;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS has_distribution BOOLEAN DEFAULT FALSE;
        ALTER TABLE vdf_results ADD COLUMN IF NOT EXISTS bull_flag_confidence SMALLINT;
      END $$;
    `);

    // --- Performance indexes (idempotent, safe to re-run) ---

    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS vdf_results_detected_idx
      ON vdf_results(trade_date, is_detected) WHERE is_detected = TRUE;
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_signals_trade_date_timeframe_idx
      ON divergence_signals(trade_date DESC, timeframe, source_interval);
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_signals_is_favorite_idx
      ON divergence_signals(is_favorite) WHERE is_favorite = TRUE;
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_symbols_active_idx
      ON divergence_symbols(ticker) WHERE is_active = TRUE;
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS divergence_scan_jobs_finished_idx
      ON divergence_scan_jobs(finished_at DESC NULLS LAST);
    `);
    await divergencePool.query(`
      CREATE INDEX IF NOT EXISTS mini_chart_bars_ticker_idx
      ON mini_chart_bars(ticker);
    `);

    try {
      const pubResult = await divergencePool.query(
        `SELECT published_trade_date::text AS trade_date FROM divergence_publication_state WHERE source_interval = $1 LIMIT 1`,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      const restoredTradeDate = String(pubResult.rows[0]?.trade_date || '').trim();
      if (restoredTradeDate) {
        setDivergenceLastFetchedTradeDateEt(maxEtDateString(divergenceLastFetchedTradeDateEt, restoredTradeDate));
        fetchDailyScan.setStatus({
          lastPublishedTradeDate: maxEtDateString(fetchDailyScan.readStatus().lastPublishedTradeDate || '', restoredTradeDate),
        });
        fetchDailyScan.setExtraStatus({ last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '' });
      }
      const weeklyResult = await divergencePool.query(
        `SELECT MAX(trade_date)::text AS trade_date FROM divergence_signals WHERE timeframe = '1w' AND source_interval = $1`,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      const restoredWeeklyDate = String(weeklyResult.rows[0]?.trade_date || '').trim();
      if (restoredWeeklyDate) {
        fetchWeeklyScan.setStatus({
          lastPublishedTradeDate: maxEtDateString(fetchWeeklyScan.readStatus().lastPublishedTradeDate || '', restoredWeeklyDate),
        });
        fetchWeeklyScan.setExtraStatus({ last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '' });
      }
      if (restoredTradeDate || restoredWeeklyDate) {
        console.log(
          `Restored trade dates from DB — daily: ${restoredTradeDate || '(none)'}, weekly: ${restoredWeeklyDate || '(none)'}`,
        );
      }
    } catch (restoreErr: unknown) {
      console.error('Failed to restore trade dates from DB:', restoreErr instanceof Error ? restoreErr.message : String(restoreErr));
    }
    console.log('Divergence database initialized successfully');
  } catch (err: unknown) {
    console.error('Failed to initialize divergence database:', err);
  }
}

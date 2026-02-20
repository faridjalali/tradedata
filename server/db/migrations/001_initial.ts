import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // alerts
  await db.schema
    .createTable('alerts')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('ticker', 'varchar(20)', (col) => col.notNull())
    .addColumn('signal_type', 'varchar(10)', (col) => col.notNull())
    .addColumn('price', 'numeric(15, 2)', (col) => col.notNull())
    .addColumn('message', 'text')
    .addColumn('timestamp', 'timestamptz', (col) => col.defaultTo(sql`NOW()`))
    .addColumn('is_favorite', 'boolean', (col) => col.defaultTo(false))
    .addColumn('timeframe', 'varchar(10)')
    .addColumn('signal_direction', 'integer')
    .addColumn('signal_volume', 'integer')
    .addColumn('intensity_score', 'integer')
    .addColumn('combo_score', 'integer')
    .execute();

  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_timestamp ON alerts (timestamp DESC)`.execute(db);

  // run_metrics_history
  await db.schema
    .createTable('run_metrics_history')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('run_id', 'varchar(120)', (col) => col.notNull().unique())
    .addColumn('run_type', 'varchar(40)', (col) => col.notNull())
    .addColumn('status', 'varchar(40)', (col) => col.notNull().defaultTo('unknown'))
    .addColumn('snapshot', 'jsonb', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.defaultTo(sql`NOW()`))
    .execute();

  await sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_run_metrics_history_created ON run_metrics_history (created_at DESC)`.execute(
    db,
  );

  // divergence_signals
  await db.schema
    .createTable('divergence_signals')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('ticker', 'varchar(20)', (col) => col.notNull())
    .addColumn('signal_type', 'varchar(10)', (col) => col.notNull())
    .addColumn('trade_date', 'date', (col) => col.notNull())
    .addColumn('price', 'numeric(15, 4)', (col) => col.notNull())
    .addColumn('prev_close', 'numeric(15, 4)', (col) => col.notNull())
    .addColumn('volume_delta', 'numeric(20, 4)', (col) => col.notNull())
    .addColumn('timeframe', 'varchar(10)', (col) => col.notNull().defaultTo('1d'))
    .addColumn('source_interval', 'varchar(10)', (col) => col.notNull().defaultTo('1min'))
    .addColumn('timestamp', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('is_favorite', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('scan_job_id', 'integer')
    .execute();

  await db.schema
    .createIndex('divergence_signals_unique_key')
    .ifNotExists()
    .on('divergence_signals')
    .columns(['trade_date', 'ticker', 'timeframe', 'source_interval'])
    .unique()
    .execute();

  // divergence_scan_jobs
  await db.schema
    .createTable('divergence_scan_jobs')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('run_for_date', 'date', (col) => col.notNull())
    .addColumn('scanned_trade_date', 'date')
    .addColumn('status', 'varchar(20)', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('finished_at', 'timestamptz')
    .addColumn('total_symbols', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('processed_symbols', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('bullish_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('bearish_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('error_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('notes', 'text')
    .execute();

  // divergence_symbols
  await db.schema
    .createTable('divergence_symbols')
    .ifNotExists()
    .addColumn('ticker', 'varchar(20)', (col) => col.primaryKey())
    .addColumn('exchange', 'varchar(40)')
    .addColumn('asset_type', 'varchar(40)')
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // divergence_daily_bars
  await db.schema
    .createTable('divergence_daily_bars')
    .ifNotExists()
    .addColumn('ticker', 'varchar(20)', (col) => col.notNull())
    .addColumn('trade_date', 'date', (col) => col.notNull())
    .addColumn('source_interval', 'varchar(10)', (col) => col.notNull().defaultTo('1min'))
    .addColumn('close', 'numeric(15, 4)', (col) => col.notNull())
    .addColumn('prev_close', 'numeric(15, 4)', (col) => col.notNull())
    .addColumn('volume_delta', 'numeric(20, 4)', (col) => col.notNull())
    .addColumn('scan_job_id', 'integer')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('divergence_daily_bars_pk', ['ticker', 'trade_date', 'source_interval'])
    .execute();

  await db.schema
    .createIndex('divergence_daily_bars_trade_date_idx')
    .ifNotExists()
    .on('divergence_daily_bars')
    .columns(['source_interval', 'trade_date desc', 'ticker asc'])
    .execute();

  // divergence_summaries
  await db.schema
    .createTable('divergence_summaries')
    .ifNotExists()
    .addColumn('ticker', 'varchar(20)', (col) => col.notNull())
    .addColumn('source_interval', 'varchar(10)', (col) => col.notNull().defaultTo('1min'))
    .addColumn('trade_date', 'date', (col) => col.notNull())
    .addColumn('state_1d', 'varchar(10)', (col) => col.notNull().defaultTo('neutral'))
    .addColumn('state_3d', 'varchar(10)', (col) => col.notNull().defaultTo('neutral'))
    .addColumn('state_7d', 'varchar(10)', (col) => col.notNull().defaultTo('neutral'))
    .addColumn('state_14d', 'varchar(10)', (col) => col.notNull().defaultTo('neutral'))
    .addColumn('state_28d', 'varchar(10)', (col) => col.notNull().defaultTo('neutral'))
    .addColumn('ma8_above', 'boolean')
    .addColumn('ma21_above', 'boolean')
    .addColumn('ma50_above', 'boolean')
    .addColumn('ma200_above', 'boolean')
    .addColumn('scan_job_id', 'integer')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('divergence_summaries_pk', ['ticker', 'source_interval'])
    .execute();

  await db.schema
    .createIndex('divergence_summaries_trade_date_idx')
    .ifNotExists()
    .on('divergence_summaries')
    .columns(['source_interval', 'trade_date desc', 'ticker asc'])
    .execute();

  await db.schema
    .createIndex('divergence_summaries_source_ticker_idx')
    .ifNotExists()
    .on('divergence_summaries')
    .columns(['source_interval', 'ticker'])
    .execute();

  // publication state
  await db.schema
    .createTable('divergence_publication_state')
    .ifNotExists()
    .addColumn('source_interval', 'varchar(10)', (col) => col.primaryKey())
    .addColumn('published_trade_date', 'date')
    .addColumn('last_scan_job_id', 'integer')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // vdf_results
  await db.schema
    .createTable('vdf_results')
    .ifNotExists()
    .addColumn('ticker', 'varchar(20)', (col) => col.notNull())
    .addColumn('trade_date', 'varchar(10)', (col) => col.notNull())
    .addColumn('is_detected', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('composite_score', 'real', (col) => col.defaultTo(0))
    .addColumn('status', 'text', (col) => col.defaultTo(''))
    .addColumn('weeks', 'integer', (col) => col.defaultTo(0))
    .addColumn('result_json', 'text')
    .addColumn('updated_at', 'timestamptz', (col) => col.defaultTo(sql`NOW()`))
    .addColumn('best_zone_score', 'real', (col) => col.defaultTo(0))
    .addColumn('proximity_score', 'real', (col) => col.defaultTo(0))
    .addColumn('proximity_level', 'varchar(10)', (col) => col.defaultTo('none'))
    .addColumn('num_zones', 'integer', (col) => col.defaultTo(0))
    .addColumn('has_distribution', 'boolean', (col) => col.defaultTo(false))
    .addColumn('bull_flag_confidence', 'smallint')
    .addPrimaryKeyConstraint('vdf_results_pk', ['ticker', 'trade_date'])
    .execute();

  // mini_chart_bars
  await db.schema
    .createTable('mini_chart_bars')
    .ifNotExists()
    .addColumn('ticker', 'varchar(20)', (col) => col.notNull())
    .addColumn('trade_date', 'date', (col) => col.notNull())
    .addColumn('open_price', 'double precision', (col) => col.notNull())
    .addColumn('high_price', 'double precision', (col) => col.notNull())
    .addColumn('low_price', 'double precision', (col) => col.notNull())
    .addColumn('close_price', 'double precision', (col) => col.notNull())
    .addColumn('bar_time', 'bigint', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addPrimaryKeyConstraint('mini_chart_bars_pk', ['ticker', 'trade_date'])
    .execute();

  // Add more indexes that existed in initDb
  await sql`
    CREATE INDEX IF NOT EXISTS vdf_results_detected_idx
    ON vdf_results(trade_date, is_detected) WHERE is_detected = TRUE;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS divergence_signals_trade_date_timeframe_idx
    ON divergence_signals(trade_date DESC, timeframe, source_interval);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS divergence_signals_is_favorite_idx
    ON divergence_signals(is_favorite) WHERE is_favorite = TRUE;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS divergence_symbols_active_idx
    ON divergence_symbols(ticker) WHERE is_active = TRUE;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS divergence_scan_jobs_finished_idx
    ON divergence_scan_jobs(finished_at DESC NULLS LAST);
  `.execute(db);

  await db.schema
    .createIndex('mini_chart_bars_ticker_idx')
    .ifNotExists()
    .on('mini_chart_bars')
    .column('ticker')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Ideally, all tables would be dropped in reverse order.
  // Since this is an initial migration, we assume destruction is intentional if run.
  const tables = [
    'mini_chart_bars',
    'vdf_results',
    'divergence_publication_state',
    'divergence_summaries',
    'divergence_daily_bars',
    'divergence_symbols',
    'divergence_scan_jobs',
    'divergence_signals',
    'run_metrics_history',
    'alerts',
  ];
  for (const table of tables) {
    await db.schema.dropTable(table).ifExists().execute();
  }
}

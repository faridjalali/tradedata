import { pool, divergencePool, db as kyselyDb } from '../db.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { loadRunHistoryFromDb, runMetricsHistory, type RunMetricsSummary } from '../services/metricsService.js';
import {
  fetchDailyScan,
  fetchWeeklyScan,
  setDivergenceLastFetchedTradeDateEt,
  divergenceLastFetchedTradeDateEt,
} from '../services/scanControlService.js';
import { vdfScan } from '../services/vdfService.js';
import { maxEtDateString } from '../lib/dateUtils.js';
import { runMigrations } from './migrate.js';

export async function initDB(): Promise<void> {
  try {
    if (kyselyDb) {
      console.log('Running database migrations...');
      await runMigrations(kyselyDb);
      console.log('Database migrations completed successfully');
    }

    const persisted = await loadRunHistoryFromDb();
    if (persisted.length > 0) {
      runMetricsHistory.push(...(persisted as unknown as RunMetricsSummary[]));
      console.log(`Loaded ${persisted.length} persisted run history entries`);
    }

    // Seed VDF scan state from the latest completed run in DB so the status
    // survives server restarts (parity with fetchDaily/fetchWeekly date seeding).
    try {
      const vdfRow = await pool.query(
        `SELECT finished_at, status FROM run_metrics_history
         WHERE run_type = 'vdfScan' AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 1`,
      );
      const row = vdfRow.rows[0] as { finished_at: string; status: string } | undefined;
      if (row?.finished_at) {
        vdfScan.setStatus({
          status: String(row.status || 'completed'),
          finishedAt: String(row.finished_at),
        });
        console.log(`Restored VDF scan last-run date from DB: ${row.finished_at}`);
      }
    } catch (vdfErr: unknown) {
      console.error(
        'Failed to restore VDF scan date from DB:',
        vdfErr instanceof Error ? vdfErr.message : String(vdfErr),
      );
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
    try {
      const pubResult = await divergencePool.query(
        `SELECT published_trade_date::text AS trade_date FROM divergence_publication_state WHERE source_interval = $1 LIMIT 1`,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      const restoredTradeDate = String(pubResult.rows[0]?.trade_date || '').trim();
      if (restoredTradeDate) {
        setDivergenceLastFetchedTradeDateEt(maxEtDateString(divergenceLastFetchedTradeDateEt, restoredTradeDate));
        fetchDailyScan.setStatus({
          lastPublishedTradeDate: maxEtDateString(
            fetchDailyScan.readStatus().lastPublishedTradeDate || '',
            restoredTradeDate,
          ),
        });
        fetchDailyScan.setExtraStatus({
          last_published_trade_date: fetchDailyScan.readStatus().lastPublishedTradeDate || '',
        });
      }
      const weeklyResult = await divergencePool.query(
        `SELECT MAX(trade_date)::text AS trade_date FROM divergence_signals WHERE timeframe = '1w' AND source_interval = $1`,
        [DIVERGENCE_SOURCE_INTERVAL],
      );
      const restoredWeeklyDate = String(weeklyResult.rows[0]?.trade_date || '').trim();
      if (restoredWeeklyDate) {
        fetchWeeklyScan.setStatus({
          lastPublishedTradeDate: maxEtDateString(
            fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
            restoredWeeklyDate,
          ),
        });
        fetchWeeklyScan.setExtraStatus({
          last_published_trade_date: fetchWeeklyScan.readStatus().lastPublishedTradeDate || '',
        });
      }
      if (restoredTradeDate || restoredWeeklyDate) {
        console.log(
          `Restored trade dates from DB — daily: ${restoredTradeDate || '(none)'}, weekly: ${restoredWeeklyDate || '(none)'}`,
        );
      }
    } catch (restoreErr: unknown) {
      console.error(
        'Failed to restore trade dates from DB:',
        restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      );
    }
    console.log('Divergence database initialized successfully');
  } catch (err: unknown) {
    console.error('Failed to initialize divergence database:', err);
  }
}

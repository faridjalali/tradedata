import type { FastifyInstance } from 'fastify';
import { pool, divergencePool, isDivergenceConfigured } from '../db.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { divergenceScanRunning } from '../services/scanControlService.js';
import { toVolumeDeltaSourceInterval } from '../services/chartEngine.js';
import { getPublishedTradeDateForSourceInterval } from '../services/divergenceDbService.js';
import { currentEtDateString, dateKeyDaysAgo } from '../lib/dateUtils.js';
import { enrichRowsWithDivergenceData } from '../services/alertEnrichment.js';

const isValidCalendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());

export function registerAlertRoutes(app: FastifyInstance): void {
  app.get('/api/alerts', async (request, reply) => {
    try {
      const q = request.query as Record<string, unknown>;
      const daysRaw = parseInt(String(q.days), 10);
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : 0;
      const startDate = String(q.start_date || '').trim();
      const endDate = String(q.end_date || '').trim();
      const hasDateKeyRange = isValidCalendarDate(startDate) && isValidCalendarDate(endDate);

      let query = 'SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100';
      let values: unknown[] = [];

      if (hasDateKeyRange) {
        query = `
            SELECT * FROM alerts
            WHERE timestamp >= ($1 || ' 00:00:00 America/New_York')::timestamptz
              AND timestamp < ($2 || ' 00:00:00 America/New_York')::timestamptz + INTERVAL '1 day'
            ORDER BY timestamp DESC LIMIT 500`;
        values = [startDate, endDate];
      } else if (startDate && endDate) {
        query = `SELECT * FROM alerts WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 500`;
        values = [startDate, endDate];
      } else if (days > 0) {
        query = `SELECT * FROM alerts WHERE timestamp >= NOW() - $1::interval ORDER BY timestamp DESC LIMIT 500`;
        values = [`${days} days`];
      }

      const result = await pool.query(query, values);
      const sourceInterval = toVolumeDeltaSourceInterval(q.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
      const tickers = Array.from(
        new Set(result.rows.map((row) => String(row?.ticker || '').trim().toUpperCase()).filter(Boolean)),
      );
      const enrichedRows = await enrichRowsWithDivergenceData({
        rows: result.rows,
        tickers,
        sourceInterval,
        pool: isDivergenceConfigured() ? divergencePool : null,
        contextLabel: 'TV alerts',
      });
      return reply.send(enrichedRows);
    } catch (err: unknown) {
      console.error(err);
      return reply.code(500).send({ error: 'Server Error' });
    }
  });

  app.post('/api/alerts/:id/favorite', async (request, reply) => {
    const id = parseInt((request.params as Record<string, string>).id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: 'Invalid alert ID' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const is_favorite = body.is_favorite;
    try {
      let query; let values;
      if (typeof is_favorite === 'boolean') {
        query = 'UPDATE alerts SET is_favorite = $1 WHERE id = $2 RETURNING *';
        values = [is_favorite, id];
      } else {
        query = 'UPDATE alerts SET is_favorite = NOT is_favorite WHERE id = $1 RETURNING *';
        values = [id];
      }
      const result = await pool.query(query, values);
      if (result.rows.length === 0) return reply.code(404).send({ error: 'Alert not found' });
      return reply.send(result.rows[0]);
    } catch (err: unknown) {
      console.error('Error toggling favorite:', err);
      return reply.code(500).send({ error: 'Server Error' });
    }
  });

  app.get('/api/divergence/signals', async (request, reply) => {
    if (!isDivergenceConfigured()) return reply.code(503).send({ error: 'Divergence database is not configured' });
    try {
      const q = request.query as Record<string, unknown>;
      const daysRaw = parseInt(String(q.days), 10);
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : 0;
      const startDate = String(q.start_date || '').trim();
      const endDate = String(q.end_date || '').trim();
      const hasDateKeyRange = isValidCalendarDate(startDate) && isValidCalendarDate(endDate);
      const timeframeParam = q.timeframe;
      const allowedTimeframes = timeframeParam === '1d' ? ['1d'] : timeframeParam === '1w' ? ['1w'] : ['1d', '1w'];
      const publishedTradeDate = await getPublishedTradeDateForSourceInterval(DIVERGENCE_SOURCE_INTERVAL);
      if (!publishedTradeDate && divergenceScanRunning) return reply.send([]);

      const PER_TIMEFRAME_SIGNAL_LIMIT = 3029;
      let query = 'SELECT * FROM divergence_signals ORDER BY timestamp DESC LIMIT 100';
      let values: unknown[] = [];

      if (hasDateKeyRange) {
        query = `
          WITH filtered AS (
            SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
              ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
            FROM divergence_signals
            WHERE trade_date >= $1::date AND trade_date <= $2::date AND timeframe = ANY($5::text[])
              AND ($3::date IS NULL OR trade_date <= $3::date)
          )
          SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
          FROM filtered WHERE timeframe_rank <= $4 ORDER BY trade_date DESC, timestamp DESC`;
        values = [startDate, endDate, publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
      } else if (days > 0) {
        const lookbackDays = Math.max(1, Math.floor(Number(days) || 1));
        const endTradeDate = currentEtDateString();
        const startTradeDate = dateKeyDaysAgo(endTradeDate, lookbackDays - 1) || endTradeDate;
        query = `
          WITH filtered AS (
            SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
              ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
            FROM divergence_signals
            WHERE trade_date >= $1::date AND trade_date <= $2::date AND timeframe = ANY($5::text[])
              AND ($3::date IS NULL OR trade_date <= $3::date)
          )
          SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
          FROM filtered WHERE timeframe_rank <= $4 ORDER BY trade_date DESC, timestamp DESC`;
        values = [startTradeDate, endTradeDate, publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
      } else {
        query = `
          WITH filtered AS (
            SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
              ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
            FROM divergence_signals
            WHERE timeframe = ANY($3::text[]) AND ($1::date IS NULL OR trade_date <= $1::date)
          )
          SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
          FROM filtered WHERE timeframe_rank <= $2 ORDER BY trade_date DESC, timestamp DESC`;
        values = [publishedTradeDate || null, PER_TIMEFRAME_SIGNAL_LIMIT, allowedTimeframes];
      }

      const result = await divergencePool!.query(query, values);
      const sourceInterval = toVolumeDeltaSourceInterval(q.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
      const tickers = Array.from(
        new Set(result.rows.map((row) => String(row?.ticker || '').trim().toUpperCase()).filter(Boolean)),
      );
      const enrichedRows = await enrichRowsWithDivergenceData({
        rows: result.rows,
        tickers,
        sourceInterval,
        pool: divergencePool,
        contextLabel: 'divergence signals',
      });
      return reply.send(enrichedRows);
    } catch (err: unknown) {
      console.error('Divergence API error:', err);
      return reply.code(500).send({ error: 'Failed to fetch divergence signals' });
    }
  });

  app.post('/api/divergence/signals/:id/favorite', async (request, reply) => {
    if (!isDivergenceConfigured()) return reply.code(503).send({ error: 'Divergence database is not configured' });
    const id = parseInt((request.params as Record<string, string>).id, 10);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'Invalid signal ID' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const is_favorite = body.is_favorite;
    try {
      let query; let values;
      if (typeof is_favorite === 'boolean') {
        query = `UPDATE divergence_signals SET is_favorite = $1 WHERE id = $2
          RETURNING id, ticker, signal_type, price, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`;
        values = [is_favorite, id];
      } else {
        query = `UPDATE divergence_signals SET is_favorite = NOT is_favorite WHERE id = $1
          RETURNING id, ticker, signal_type, price, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`;
        values = [id];
      }
      const result = await divergencePool!.query(query, values);
      if (result.rows.length === 0) return reply.code(404).send({ error: 'Signal not found' });
      return reply.send(result.rows[0]);
    } catch (err: unknown) {
      console.error('Error toggling divergence favorite:', err);
      return reply.code(500).send({ error: 'Server Error' });
    }
  });
}

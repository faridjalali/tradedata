import type { FastifyInstance } from 'fastify';
import { pool, divergencePool, isDivergenceConfigured } from '../db.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { divergenceScanRunning } from '../services/scanControlService.js';
import { toVolumeDeltaSourceInterval } from '../services/chartEngine.js';
import { getStoredDivergenceSummariesForTickers, buildNeutralDivergenceStateMap } from '../services/divergenceStateService.js';
import { getPublishedTradeDateForSourceInterval } from '../services/divergenceDbService.js';
import { currentEtDateString, dateKeyDaysAgo } from '../lib/dateUtils.js';

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
      let summariesByTicker = new Map();
      try {
        summariesByTicker = await getStoredDivergenceSummariesForTickers(tickers, sourceInterval, {
          includeLatestFallbackForMissing: true,
        });
      } catch (summaryErr: unknown) {
        const message = summaryErr instanceof Error ? summaryErr.message : String(summaryErr);
        console.error(`Failed to enrich TV alerts with divergence summaries: ${message}`);
      }
      const neutralStates = buildNeutralDivergenceStateMap();
      let vdfDataMapTv = new Map();
      try {
        if (tickers.length > 0 && isDivergenceConfigured()) {
          const vdfTradeDate = currentEtDateString();
          const vdfRes = await divergencePool!.query(
            `SELECT ticker, best_zone_score, proximity_level, num_zones, bull_flag_confidence FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
            [vdfTradeDate, tickers],
          );
          for (const row of vdfRes.rows) {
            vdfDataMapTv.set(String(row.ticker).toUpperCase(), {
              score: Math.min(100, Math.round((Number(row.best_zone_score) || 0) * 100)),
              proximityLevel: row.proximity_level || 'none',
              numZones: Number(row.num_zones) || 0,
              bullFlagConfidence: row.bull_flag_confidence != null ? Number(row.bull_flag_confidence) : null,
            });
          }
        }
      } catch { /* Non-critical */ }
      const enrichedRows = result.rows.map((row) => {
        const ticker = String(row?.ticker || '').trim().toUpperCase();
        const summary = summariesByTicker.get(ticker) || null;
        const states = summary?.states || neutralStates;
        const vdfData = vdfDataMapTv.get(ticker);
        return {
          ...row,
          divergence_trade_date: summary?.tradeDate || null,
          ma_states: { ema8: Boolean(summary?.maStates?.ema8), ema21: Boolean(summary?.maStates?.ema21), sma50: Boolean(summary?.maStates?.sma50), sma200: Boolean(summary?.maStates?.sma200) },
          divergence_states: { 1: String(states['1'] || 'neutral'), 3: String(states['3'] || 'neutral'), 7: String(states['7'] || 'neutral'), 14: String(states['14'] || 'neutral'), 28: String(states['28'] || 'neutral') },
          vdf_detected: !!vdfData, vdf_score: vdfData?.score || 0, vdf_proximity: vdfData?.proximityLevel || 'none',
          bull_flag_confidence: vdfData?.bullFlagConfidence ?? null,
        };
      });
      return reply.send(enrichedRows);
    } catch (err: unknown) {
      console.error(err);
      return reply.code(500).send('Server Error');
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
      if (result.rows.length === 0) return reply.code(404).send('Alert not found');
      return reply.send(result.rows[0]);
    } catch (err: unknown) {
      console.error('Error toggling favorite:', err);
      return reply.code(500).send('Server Error');
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
      let summariesByTicker = new Map();
      try {
        summariesByTicker = await getStoredDivergenceSummariesForTickers(tickers, sourceInterval, {
          includeLatestFallbackForMissing: true,
        });
      } catch (summaryErr: unknown) {
        console.error(`Failed to enrich divergence signals with divergence summaries: ${summaryErr instanceof Error ? summaryErr.message : String(summaryErr)}`);
      }
      const neutralStates = buildNeutralDivergenceStateMap();
      let vdfDataMap = new Map();
      try {
        if (tickers.length > 0) {
          const vdfTradeDate = currentEtDateString();
          const vdfRes = await divergencePool!.query(
            `SELECT ticker, best_zone_score, proximity_level, num_zones, bull_flag_confidence FROM vdf_results WHERE trade_date = $1 AND is_detected = TRUE AND ticker = ANY($2::text[])`,
            [vdfTradeDate, tickers],
          );
          for (const row of vdfRes.rows) {
            vdfDataMap.set(String(row.ticker).toUpperCase(), {
              score: Math.min(100, Math.round((Number(row.best_zone_score) || 0) * 100)),
              proximityLevel: row.proximity_level || 'none',
              numZones: Number(row.num_zones) || 0,
              bullFlagConfidence: row.bull_flag_confidence != null ? Number(row.bull_flag_confidence) : null,
            });
          }
        }
      } catch { /* Non-critical */ }
      const enrichedRows = result.rows.map((row) => {
        const ticker = String(row?.ticker || '').trim().toUpperCase();
        const summary = summariesByTicker.get(ticker) || null;
        const states = summary?.states || neutralStates;
        const vdfData = vdfDataMap.get(ticker);
        return {
          ...row,
          divergence_trade_date: summary?.tradeDate || null,
          ma_states: { ema8: Boolean(summary?.maStates?.ema8), ema21: Boolean(summary?.maStates?.ema21), sma50: Boolean(summary?.maStates?.sma50), sma200: Boolean(summary?.maStates?.sma200) },
          divergence_states: { 1: String(states['1'] || 'neutral'), 3: String(states['3'] || 'neutral'), 7: String(states['7'] || 'neutral'), 14: String(states['14'] || 'neutral'), 28: String(states['28'] || 'neutral') },
          vdf_detected: !!vdfData, vdf_score: vdfData?.score || 0, vdf_proximity: vdfData?.proximityLevel || 'none',
          bull_flag_confidence: vdfData?.bullFlagConfidence ?? null,
        };
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

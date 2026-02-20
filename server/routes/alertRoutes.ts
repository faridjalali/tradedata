import type { FastifyInstance } from 'fastify';
import { db, divergenceDb, isDivergenceConfigured } from '../db.js';
import { z } from 'zod';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { divergenceScanRunning } from '../services/scanControlService.js';
import { toVolumeDeltaSourceInterval } from '../services/chartEngine.js';
import { getPublishedTradeDateForSourceInterval } from '../services/divergenceDbService.js';
import { currentEtDateString, dateKeyDaysAgo } from '../lib/dateUtils.js';
import { enrichRowsWithDivergenceData } from '../services/alertEnrichment.js';

import { sql } from 'kysely';

import { ZodTypeProvider } from 'fastify-type-provider-zod';

const isValidCalendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());

export function registerAlertRoutes(app: FastifyInstance): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  type SqlRowsResult = { rows: unknown[] };

  const querySchema = z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    vd_source_interval: z.string().optional(),
  });

  typedApp.get(
    '/api/alerts',
    {
      schema: {
        tags: ['Alerts'],
        summary: 'Get Alerts',
        description: 'Fetch recent trade alerts with optional date filtering',
        querystring: querySchema,
        response: {
          200: z.array(z.any()),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      try {
        const safeQ = request.query;
        const limitValue = 500; // Default limit

        // Execute queries
        try {
          let rows: Array<Record<string, unknown>>;

          if (safeQ.from || safeQ.to) {
            let baseQuery = db.selectFrom('alerts').selectAll();

            if (safeQ.from) {
              const fromDate = new Date(safeQ.from);
              baseQuery = baseQuery.where('timestamp', '>=', fromDate);
            }
            if (safeQ.to) {
              const toDate = new Date(safeQ.to);
              baseQuery = baseQuery.where('timestamp', '<=', toDate);
            }

            // Add limit and sort to the query
            baseQuery = baseQuery.orderBy('timestamp', 'desc').limit(limitValue);
            rows = await baseQuery.execute();
          } else {
            rows = await db.selectFrom('alerts').selectAll().orderBy('timestamp', 'desc').limit(limitValue).execute();
          }

          if (rows.length === 0) return reply.send([]);

          // Batch enrich rows with divergence data (which includes VDF data)
          const uniqueTickers = Array.from(
            new Set(
              rows.map((r) =>
                String(r?.ticker || '')
                  .trim()
                  .toUpperCase(),
              ),
            ),
          ).filter(Boolean);

          const sourceInterval = toVolumeDeltaSourceInterval(safeQ.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
          const enrichedRows = await enrichRowsWithDivergenceData({
            rows,
            tickers: uniqueTickers,
            sourceInterval,
            contextLabel: 'GET /api/alerts',
          });
          return reply.send(enrichedRows);
          // Catch for the inner try block handling database queries
        } catch (err: unknown) {
          console.error(err);
          return reply.code(500).send({ error: 'Database Error' });
        }

        // Catch for the outer try block handling the entire request
      } catch (err: unknown) {
        console.error(err);
        return reply.code(500).send({ error: 'Server Error' });
      }
    },
  );

  // New route: Toggle favorite status for an alert (used by specific alert card views)
  typedApp.post(
    '/api/alerts/:id/favorite',
    {
      schema: {
        tags: ['Alerts'],
        summary: 'Toggle Alert Favorite',
        description: 'Toggle the favorite status of a specific alert',
        params: z.object({ id: z.coerce.number().positive() }),
        body: z.object({ isFavorite: z.boolean() }),
        response: {
          200: z.object({ success: z.boolean(), is_favorite: z.boolean() }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const { isFavorite } = request.body;

        const result = await db
          .updateTable('alerts')
          .set({ is_favorite: isFavorite })
          .where('id', '=', id)
          .executeTakeFirst();

        if (Number(result.numUpdatedRows) === 0) {
          return reply.code(404).send({ error: 'Alert not found' });
        }

        return reply.send({ success: true, is_favorite: isFavorite });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to update alert favorite status: ${message}`);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    },
  );

  typedApp.get(
    '/api/divergence/signals',
    {
      schema: {
        tags: ['Divergence'],
        summary: 'Get Divergence Signals',
        description: 'Fetch divergence signals globally',
        querystring: z.object({
          days: z.coerce.number().optional().default(0),
          start_date: z.string().optional(),
          end_date: z.string().optional(),
          timeframe: z.string().optional(),
          vd_source_interval: z.string().optional(),
        }),
        response: {
          200: z.array(z.any()),
          503: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!isDivergenceConfigured()) return reply.code(503).send({ error: 'Divergence database is not configured' });
      try {
        const q = request.query;
        const daysRaw = q.days;
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : 0;
        const startDate = String(q.start_date || '').trim();
        const endDate = String(q.end_date || '').trim();
        const hasDateKeyRange = isValidCalendarDate(startDate) && isValidCalendarDate(endDate);
        const timeframeParam = q.timeframe;
        const allowedTimeframes = timeframeParam === '1d' ? ['1d'] : timeframeParam === '1w' ? ['1w'] : ['1d', '1w'];
        const publishedTradeDate = await getPublishedTradeDateForSourceInterval(DIVERGENCE_SOURCE_INTERVAL);
        if (!publishedTradeDate && divergenceScanRunning) return reply.send([]);

        const PER_TIMEFRAME_SIGNAL_LIMIT = 3029;
        let queryResult: SqlRowsResult;

        if (!divergenceDb) return reply.code(503).send({ error: 'Divergence database is not configured' });

        if (hasDateKeyRange) {
          queryResult = await sql`
          WITH filtered AS (
            SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
              ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
            FROM divergence_signals
            WHERE trade_date >= ${startDate}::date AND trade_date <= ${endDate}::date AND timeframe = ANY(${allowedTimeframes}::text[])
              AND (${publishedTradeDate || null}::date IS NULL OR trade_date <= ${publishedTradeDate || null}::date)
          )
          SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
          FROM filtered WHERE timeframe_rank <= ${PER_TIMEFRAME_SIGNAL_LIMIT} ORDER BY trade_date DESC, timestamp DESC`.execute(
            divergenceDb,
          );
        } else if (days > 0) {
          const lookbackDays = Math.max(1, Math.floor(Number(days) || 1));
          const endTradeDate = currentEtDateString();
          const startTradeDate = dateKeyDaysAgo(endTradeDate, lookbackDays - 1) || endTradeDate;
          queryResult = await sql`
          WITH filtered AS (
            SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
              ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
            FROM divergence_signals
            WHERE trade_date >= ${startTradeDate}::date AND trade_date <= ${endTradeDate}::date AND timeframe = ANY(${allowedTimeframes}::text[])
              AND (${publishedTradeDate || null}::date IS NULL OR trade_date <= ${publishedTradeDate || null}::date)
          )
          SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
          FROM filtered WHERE timeframe_rank <= ${PER_TIMEFRAME_SIGNAL_LIMIT} ORDER BY trade_date DESC, timestamp DESC`.execute(
            divergenceDb,
          );
        } else {
          queryResult = await sql`
          WITH filtered AS (
            SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
              ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
            FROM divergence_signals
            WHERE timeframe = ANY(${allowedTimeframes}::text[]) AND (${publishedTradeDate || null}::date IS NULL OR trade_date <= ${publishedTradeDate || null}::date)
          )
          SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
          FROM filtered WHERE timeframe_rank <= ${PER_TIMEFRAME_SIGNAL_LIMIT} ORDER BY trade_date DESC, timestamp DESC`.execute(
            divergenceDb,
          );
        }

        const rows = queryResult.rows as Array<Record<string, unknown>>;
        const sourceInterval = toVolumeDeltaSourceInterval(q.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
        const tickers = Array.from(
          new Set(
            rows
              .map((row) =>
                String(row?.ticker || '')
                  .trim()
                  .toUpperCase(),
              )
              .filter(Boolean),
          ),
        ) as string[];
        const enrichedRows = await enrichRowsWithDivergenceData({
          rows: rows,
          tickers,
          sourceInterval,
          contextLabel: 'divergence signals',
        });
        return reply.send(enrichedRows);
      } catch (err: unknown) {
        console.error('Divergence API error:', err);
        return reply.code(500).send({ error: 'Failed to fetch divergence signals' });
      }
    },
  );

  typedApp.post(
    '/api/divergence/signals/:id/favorite',
    {
      schema: {
        tags: ['Divergence'],
        summary: 'Favorite Divergence Signal',
        description: 'Toggle favorite status for a Divergence Signal',
        params: z.object({ id: z.coerce.number().positive() }),
        body: z.object({ is_favorite: z.boolean().optional() }).optional(),
        response: {
          200: z.any(),
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          503: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!isDivergenceConfigured()) return reply.code(503).send({ error: 'Divergence database is not configured' });
      const { id } = request.params;
      const is_favorite = request.body?.is_favorite;
      try {
        if (!divergenceDb) return reply.code(503).send({ error: 'Divergence database is not configured' });
        let queryResult: SqlRowsResult;
        if (typeof is_favorite === 'boolean') {
          queryResult = await sql`UPDATE divergence_signals SET is_favorite = ${is_favorite} WHERE id = ${id}
          RETURNING id, ticker, signal_type, price, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`.execute(
            divergenceDb,
          );
        } else {
          queryResult = await sql`UPDATE divergence_signals SET is_favorite = NOT is_favorite WHERE id = ${id}
          RETURNING id, ticker, signal_type, price, timestamp, timeframe,
            CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
            ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`.execute(
            divergenceDb,
          );
        }
        const rows = queryResult.rows;
        if (rows.length === 0) return reply.code(404).send({ error: 'Signal not found' });
        return reply.send(rows[0]);
      } catch (err: unknown) {
        console.error('Error toggling divergence favorite:', err);
        return reply.code(500).send({ error: 'Server Error' });
      }
    },
  );
}

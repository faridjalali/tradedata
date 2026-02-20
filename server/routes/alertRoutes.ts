import type { FastifyInstance } from 'fastify';
import { db, divergenceDb } from '../db.js';
import { z } from 'zod';
import { divergenceScanRunning } from '../services/scanControlService.js';
import { AlertRouteService } from '../services/AlertRouteService.js';

import { ZodTypeProvider } from 'fastify-type-provider-zod';

const isValidCalendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());

export function registerAlertRoutes(app: FastifyInstance): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // DI: Instantiate the service injecting the DB dependencies
  const alertService = new AlertRouteService(db, divergenceDb, divergenceScanRunning);

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
        const enrichedRows = await alertService.getAlerts(request.query, 500);
        return reply.send(enrichedRows);
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
        body: z.object({ isFavorite: z.boolean().optional() }).optional(),
        response: {
          200: z.object({ success: z.boolean(), is_favorite: z.boolean() }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await alertService.toggleAlertFavorite(request.params.id, request.body?.isFavorite);
        if (result === null) return reply.code(404).send({ error: 'Alert not found' });

        return reply.send({ success: true, is_favorite: result });
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
      if (!alertService.isDivergenceConfigured())
        return reply.code(503).send({ error: 'Divergence database is not configured' });

      try {
        const q = request.query;
        const daysRaw = q.days;
        const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : 0;
        const startDate = String(q.start_date || '').trim();
        const endDate = String(q.end_date || '').trim();
        const hasDateKeyRange = isValidCalendarDate(startDate) && isValidCalendarDate(endDate);

        const enrichedRows = await alertService.getDivergenceSignals({
          days,
          startDate,
          endDate,
          hasDateKeyRange,
          timeframeParam: q.timeframe,
          vd_source_interval: q.vd_source_interval,
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
      if (!alertService.isDivergenceConfigured())
        return reply.code(503).send({ error: 'Divergence database is not configured' });

      try {
        const result = await alertService.toggleDivergenceFavorite(request.params.id, request.body?.is_favorite);
        if (result === null) return reply.code(404).send({ error: 'Signal not found' });

        return reply.send(result);
      } catch (err: unknown) {
        console.error('Error toggling divergence favorite:', err);
        return reply.code(500).send({ error: 'Server Error' });
      }
    },
  );
}

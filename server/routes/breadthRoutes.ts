import type { FastifyInstance } from 'fastify';
import { divergenceDb } from '../db.js';
import { DEBUG_METRICS_SECRET } from '../config.js';
import { rejectUnauthorized } from '../routeGuards.js';
import { z } from 'zod';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BreadthRouteService } from '../services/BreadthRouteService.js';

export function registerBreadthRoutes(app: FastifyInstance): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  // DI: Instantiate the service using the database dependency
  const breadthService = new BreadthRouteService(divergenceDb);

  typedApp.get(
    '/api/breadth',
    {
      schema: {
        tags: ['Breadth'],
        summary: 'Get Breadth Chart Data',
        description: 'Fetch breadth data for charting (intraday or daily)',
        querystring: z.object({
          ticker: z.string().optional().default('SVIX'),
          days: z.coerce.number().optional().default(5),
        }),
        response: {
          200: z.object({ intraday: z.boolean(), points: z.array(z.any()) }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const compTicker = (q.ticker || 'SVIX').toString();
      const days = Math.min(Math.max(parseInt(String(q.days)) || 5, 1), 60);

      try {
        const result = await breadthService.getChartData(compTicker, days);
        if (!result) return reply.code(404).send({ error: 'No price data available' });
        return reply.send(result);
      } catch (err: unknown) {
        console.error('Breadth API Error:', err);
        return reply.code(500).send({ error: 'Failed to fetch breadth data' });
      }
    },
  );

  typedApp.get(
    '/api/breadth/ma',
    {
      schema: {
        tags: ['Breadth'],
        summary: 'Get Breadth Moving Averages',
        description: 'Fetch latest breadth moving average data',
        querystring: z.object({ days: z.coerce.number().optional().default(60) }),
        response: {
          200: z.any(),
          503: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!breadthService.isConfigured()) return reply.code(503).send({ error: 'Breadth not configured' });
      const q = request.query;
      const days = Math.min(Math.max(parseInt(String(q.days)) || 60, 1), 365);

      try {
        const data = await breadthService.getMovingAverages(days);
        return reply.send(data);
      } catch (err: unknown) {
        console.error('Breadth MA API Error:', err);
        return reply.code(500).send({ error: 'Failed to fetch breadth MA data' });
      }
    },
  );

  typedApp.post(
    '/api/breadth/ma/bootstrap',
    {
      schema: {
        tags: ['Breadth'],
        summary: 'Bootstrap Breadth Data',
        description: 'Start breadth history bootstrap process (protected)',
        querystring: z.object({ days: z.coerce.number().optional().default(300) }),
        response: {
          200: z.object({ status: z.string(), days: z.number() }),
          403: z.object({ error: z.string() }),
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!breadthService.isConfigured()) return reply.code(503).send({ error: 'Breadth not configured' });
      if (rejectUnauthorized(request, reply, DEBUG_METRICS_SECRET, { statusCode: 403 })) return;

      const q = request.query;
      const numDays = Math.min(Math.max(parseInt(String(q.days)) || 300, 10), 500);

      breadthService.startBootstrap(numDays).catch(console.error);
      return reply.send({ status: 'started', days: numDays });
    },
  );

  typedApp.post(
    '/api/breadth/ma/recompute',
    {
      schema: {
        tags: ['Breadth'],
        summary: 'Recompute Breadth History',
        description: 'Start full breadth history recompute process',
        response: {
          200: z.object({ status: z.string(), message: z.string().optional(), days: z.number().optional() }),
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      if (!breadthService.isConfigured()) return reply.code(503).send({ error: 'Breadth not configured' });
      const { status, message } = await breadthService.startRecompute(220);
      return reply.send({ status, message, days: 220 });
    },
  );

  typedApp.get(
    '/api/breadth/ma/recompute/status',
    {
      schema: {
        tags: ['Breadth'],
        summary: 'Recompute Status',
        description: 'Get status of running recompute process',
        response: {
          200: z.object({ running: z.boolean(), status: z.string(), finished_at: z.string().nullable() }),
        },
      },
    },
    async (_request, reply) => {
      return reply.send(breadthService.getBootstrapState());
    },
  );

  typedApp.post(
    '/api/breadth/ma/recompute/stop',
    {
      schema: {
        tags: ['Breadth'],
        summary: 'Stop Recompute',
        description: 'Stop a running recompute process',
        response: {
          200: z.object({ status: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const stopped = breadthService.requestBootstrapStop();
      if (!stopped) return reply.send({ status: 'not_running' });
      return reply.send({ status: 'stop-requested' });
    },
  );

  typedApp.post(
    '/api/breadth/ma/refresh',
    {
      schema: {
        tags: ['Breadth'],
        summary: 'Refresh Breadth MA',
        description: "Force a refresh of today's breadth MA data (protected)",
        response: {
          200: z.object({ status: z.string(), date: z.string() }),
          403: z.object({ error: z.string() }),
          503: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!breadthService.isConfigured()) return reply.code(503).send({ error: 'Breadth not configured' });
      if (rejectUnauthorized(request, reply, DEBUG_METRICS_SECRET, { statusCode: 403 })) return;

      const today = new Date();
      const tradeDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      try {
        await breadthService.refreshDailyBreadth(tradeDate);
        return reply.send({ status: 'done', date: tradeDate });
      } catch (err: unknown) {
        console.error('Breadth refresh error:', err);
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}

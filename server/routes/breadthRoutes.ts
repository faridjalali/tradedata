import type { FastifyInstance } from 'fastify';
import { divergencePool } from '../db.js';
import { DEBUG_METRICS_SECRET } from '../config.js';
import { rejectUnauthorized } from '../routeGuards.js';
import {
  bootstrapBreadthHistory,
  runBreadthComputation,
  cleanupBreadthData,
  getLatestBreadthData,
} from '../services/breadthService.js';
import {
  getSpyDaily,
  getSpyIntraday,
  dataApiIntradayChartHistory,
  buildIntradayBreadthPoints,
} from '../services/chartEngine.js';
import { dataApiDaily } from '../services/dataApi.js';

// ---------------------------------------------------------------------------
// Breadth bootstrap run state (simple flags — no ScanState needed)
// ---------------------------------------------------------------------------
let breadthBootstrapRunning = false;
let breadthBootstrapStopRequested = false;
let breadthBootstrapStatus = '';
let breadthBootstrapFinishedAt: string | null = null;

export function registerBreadthRoutes(app: FastifyInstance): void {
  app.get('/api/breadth', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const compTicker = (q.ticker || 'SVIX').toString().toUpperCase();
    const days = Math.min(Math.max(parseInt(String(q.days)) || 5, 1), 60);
    const isIntraday = days <= 30;
    try {
      if (isIntraday) {
        const lookbackDays = Math.max(14, days * 3);
        const [spyBars, compBars] = await Promise.all([
          getSpyIntraday(lookbackDays),
          dataApiIntradayChartHistory(compTicker, '30min', lookbackDays),
        ]);
        // When intraday data is available (market hours), use it
        if (spyBars && compBars) {
          const points = buildIntradayBreadthPoints(spyBars, compBars, days);
          return reply.send({ intraday: true, points });
        }
        // After hours / pre-market: fall through to daily data below
      }
      // Daily fallback (also used when isIntraday=false or intraday data unavailable)
      const [spyBars, compBars] = await Promise.all([getSpyDaily(), dataApiDaily(compTicker)]);
      if (!spyBars || !compBars) return reply.code(404).send({ error: 'No price data available' });
      const spyMap = new Map();
      for (const bar of spyBars) spyMap.set(bar.date, bar.close);
      const compMap = new Map();
      for (const bar of compBars) compMap.set(bar.date, bar.close);
      const commonDates = [...spyMap.keys()].filter((d) => compMap.has(d)).sort();
      const allPoints = commonDates.slice(-30).map((d) => ({
        date: d, spy: Math.round(spyMap.get(d) * 100) / 100, comparison: Math.round(compMap.get(d) * 100) / 100,
      }));
      // For "T" (days=1) show just last 2 daily closes so there's a visible line segment
      const sliceDays = days === 1 ? 2 : days;
      return reply.send({ intraday: false, points: allPoints.slice(-sliceDays) });
    } catch (err: unknown) {
      console.error('Breadth API Error:', err);
      return reply.code(500).send({ error: 'Failed to fetch breadth data' });
    }
  });

  app.get('/api/breadth/ma', async (request, reply) => {
    if (!divergencePool) return reply.code(503).send({ error: 'Breadth not configured' });
    const q = request.query as Record<string, string | undefined>;
    const days = Math.min(Math.max(parseInt(String(q.days)) || 60, 1), 365);
    try {
      const data = await getLatestBreadthData(divergencePool, days);
      return reply.send(data);
    } catch (err: unknown) {
      console.error('Breadth MA API Error:', err);
      return reply.code(500).send({ error: 'Failed to fetch breadth MA data' });
    }
  });

  app.post('/api/breadth/ma/bootstrap', async (request, reply) => {
    if (!divergencePool) return reply.code(503).send({ error: 'Breadth not configured' });
    if (rejectUnauthorized(request, reply, DEBUG_METRICS_SECRET, { statusCode: 403 })) return;
    const q = request.query as Record<string, string | undefined>;
    const numDays = Math.min(Math.max(parseInt(String(q.days)) || 300, 10), 500);
    bootstrapBreadthHistory(divergencePool, numDays)
      .then((r) => console.log(`[breadth] Bootstrap complete: fetched=${r.fetchedDays}, computed=${r.computedDays}`))
      .catch((err) => console.error('[breadth] Bootstrap failed:', err));
    return reply.send({ status: 'started', days: numDays });
  });

  // Session-protected: full breadth bootstrap — re-fetches ALL history from the data API.
  // Long-running (5-10 min). Fire-and-forget; poll GET /api/breadth/ma/recompute/status.
  app.post('/api/breadth/ma/recompute', async (_request, reply) => {
    if (!divergencePool) return reply.code(503).send({ error: 'Breadth not configured' });
    if (breadthBootstrapRunning) {
      return reply.send({ status: 'already_running', message: breadthBootstrapStatus });
    }
    breadthBootstrapRunning = true;
    breadthBootstrapStopRequested = false;
    breadthBootstrapStatus = 'Starting...';
    const numDays = 220;
    bootstrapBreadthHistory(
      divergencePool, numDays,
      (msg) => { breadthBootstrapStatus = msg; },
      () => breadthBootstrapStopRequested,
    )
      .then((r) => {
        const verb = breadthBootstrapStopRequested ? 'Stopped' : 'Done';
        breadthBootstrapStatus = `${verb} — fetched ${r.fetchedDays} days, computed ${r.computedDays} snapshots`;
        breadthBootstrapFinishedAt = new Date().toISOString();
        console.log(`[breadth] Recompute ${verb.toLowerCase()}: fetched=${r.fetchedDays}, computed=${r.computedDays}`);
      })
      .catch((err: unknown) => {
        breadthBootstrapStatus = `Error: ${err instanceof Error ? err.message : String(err)}`;
        breadthBootstrapFinishedAt = new Date().toISOString();
        console.error('[breadth] Recompute failed:', err);
      })
      .finally(() => { breadthBootstrapRunning = false; breadthBootstrapStopRequested = false; });
    return reply.send({ status: 'started', days: numDays });
  });

  // Poll bootstrap progress.
  app.get('/api/breadth/ma/recompute/status', async (_request, reply) => {
    return reply.send({
      running: breadthBootstrapRunning,
      status: breadthBootstrapStatus,
      finished_at: breadthBootstrapFinishedAt,
    });
  });

  // Stop a running bootstrap.
  app.post('/api/breadth/ma/recompute/stop', async (_request, reply) => {
    if (!breadthBootstrapRunning) {
      return reply.send({ status: 'not_running' });
    }
    breadthBootstrapStopRequested = true;
    breadthBootstrapStatus = 'Stopping...';
    return reply.send({ status: 'stop-requested' });
  });

  app.post('/api/breadth/ma/refresh', async (request, reply) => {
    if (!divergencePool) return reply.code(503).send({ error: 'Breadth not configured' });
    if (rejectUnauthorized(request, reply, DEBUG_METRICS_SECRET, { statusCode: 403 })) return;
    const today = new Date();
    const tradeDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    try {
      await runBreadthComputation(divergencePool, tradeDate);
      await cleanupBreadthData(divergencePool);
      return reply.send({ status: 'done', date: tradeDate });
    } catch (err: unknown) {
      console.error('Breadth refresh error:', err);
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

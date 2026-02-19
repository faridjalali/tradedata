import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { rejectUnauthorized } from '../routeGuards.js';

interface HealthRoutesOptions {
  app: FastifyInstance;
  debugMetricsSecret?: string;
  getDebugMetricsPayload: () => Record<string, unknown>;
  getHealthPayload: () => Record<string, unknown>;
  getReadyPayload: () => Promise<{ statusCode: number; body: Record<string, unknown> }>;
}

function registerHealthRoutes(options: HealthRoutesOptions): void {
  const { app, debugMetricsSecret, getDebugMetricsPayload, getHealthPayload, getReadyPayload } = options;

  if (!app) {
    throw new Error('registerHealthRoutes requires app');
  }

  app.get('/api/debug/metrics', (req: FastifyRequest, res: FastifyReply) => {
    if (rejectUnauthorized(req, res, debugMetricsSecret)) return;
    return res.code(200).send(getDebugMetricsPayload());
  });

  app.get('/healthz', (_req: FastifyRequest, res: FastifyReply) => {
    return res.code(200).send(getHealthPayload());
  });

  app.get('/readyz', async (_req: FastifyRequest, res: FastifyReply) => {
    try {
      const readyPayload = await getReadyPayload();
      return res.code(readyPayload.statusCode).send(readyPayload.body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Ready check failed: ${message}`);
      return res.code(503).send({
        ready: false,
        error: 'Ready check failed',
      });
    }
  });
}

export { registerHealthRoutes };

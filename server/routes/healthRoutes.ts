import type { Express, Request, Response } from 'express';

interface HealthRoutesOptions {
  app: Express;
  debugMetricsSecret?: string;
  getDebugMetricsPayload: () => any;
  getHealthPayload: () => any;
  getReadyPayload: () => Promise<{ statusCode: number; body: any }>;
}

function registerHealthRoutes(options: HealthRoutesOptions): void {
  const { app, debugMetricsSecret, getDebugMetricsPayload, getHealthPayload, getReadyPayload } = options;

  if (!app) {
    throw new Error('registerHealthRoutes requires app');
  }

  app.get('/api/debug/metrics', (req: Request, res: Response) => {
    const providedSecret = String(req.query.secret || req.headers['x-debug-secret'] || '').trim();
    const configuredSecret = String(debugMetricsSecret || '').trim();
    if (configuredSecret && providedSecret !== configuredSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.status(200).json(getDebugMetricsPayload());
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    return res.status(200).json(getHealthPayload());
  });

  app.get('/readyz', async (_req: Request, res: Response) => {
    try {
      const readyPayload = await getReadyPayload();
      return res.status(readyPayload.statusCode).json(readyPayload.body);
    } catch (err: any) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Ready check failed: ${message}`);
      return res.status(503).json({
        ready: false,
        error: 'Ready check failed',
      });
    }
  });
}

export { registerHealthRoutes };

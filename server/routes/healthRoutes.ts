/**
 * Register health, readiness, and debug metrics HTTP routes.
 * @param {object} options
 * @param {import('express').Express} options.app - Express application instance
 * @param {string} [options.debugMetricsSecret] - Secret required for /api/debug/metrics
 * @param {Function} options.getDebugMetricsPayload - Returns debug metrics object
 * @param {Function} options.getHealthPayload - Returns health check object
 * @param {Function} options.getReadyPayload - Returns readiness check (async)
 */
function registerHealthRoutes(options) {
  const { app, debugMetricsSecret, getDebugMetricsPayload, getHealthPayload, getReadyPayload } = options;

  if (!app) {
    throw new Error('registerHealthRoutes requires app');
  }

  app.get('/api/debug/metrics', (req, res) => {
    const providedSecret = String(req.query.secret || req.headers['x-debug-secret'] || '').trim();
    const configuredSecret = String(debugMetricsSecret || '').trim();
    if (configuredSecret && providedSecret !== configuredSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.status(200).json(getDebugMetricsPayload());
  });

  app.get('/healthz', (req, res) => {
    return res.status(200).json(getHealthPayload());
  });

  app.get('/readyz', async (req, res) => {
    try {
      const readyPayload = await getReadyPayload();
      return res.status(readyPayload.statusCode).json(readyPayload.body);
    } catch (/** @type {any} */ err) {
      const message = err && err.message ? err.message : String(err);
      /** @type {any} */ (console).error(`Ready check failed: ${message}`);
      return res.status(503).json({
        ready: false,
        error: 'Ready check failed',
      });
    }
  });
}

export { registerHealthRoutes };

function registerHealthRoutes(options = {}) {
  const {
    app,
    debugMetricsSecret,
    getDebugMetricsPayload,
    getHealthPayload,
    getReadyPayload
  } = options;

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
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`Ready check failed: ${message}`);
      return res.status(503).json({
        ready: false,
        error: 'Ready check failed'
      });
    }
  });
}

module.exports = {
  registerHealthRoutes
};

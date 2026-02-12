const {
  buildManualScanRequest,
  fetchLatestDivergenceScanStatus
} = require('../services/divergenceService');

function registerDivergenceRoutes(options = {}) {
  const {
    app,
    isDivergenceConfigured,
    divergenceScanSecret,
    getIsScanRunning,
    parseBooleanInput,
    parseEtDateInput,
    runDailyDivergenceScan,
    runDivergenceTableBuild,
    divergencePool,
    divergenceSourceInterval,
    getLastFetchedTradeDateEt,
    getLastScanDateEt,
    getIsTableBuildRunning,
    getTableBuildStatus
  } = options;

  if (!app) {
    throw new Error('registerDivergenceRoutes requires app');
  }

  app.post('/api/divergence/scan', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (getIsScanRunning()) {
      return res.status(409).json({ status: 'running' });
    }

    const scanRequest = buildManualScanRequest({
      req,
      parseBooleanInput,
      parseEtDateInput
    });
    if (!scanRequest.ok) {
      return res.status(400).json({ error: scanRequest.error });
    }
    const { force, refreshUniverse, runDateEt } = scanRequest.value;

    runDailyDivergenceScan({
      force,
      refreshUniverse,
      runDateEt,
      trigger: 'manual-api'
    })
      .then((summary) => {
        console.log('Manual divergence scan completed:', summary);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence scan failed: ${message}`);
      });

    return res.status(202).json({ status: 'started' });
  });

  app.post('/api/divergence/table/run', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if ((typeof getIsScanRunning === 'function' && getIsScanRunning())
      || (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning())) {
      return res.status(409).json({ status: 'running' });
    }

    if (typeof runDivergenceTableBuild !== 'function') {
      return res.status(501).json({ error: 'Table run endpoint is not enabled' });
    }

    runDivergenceTableBuild({
      trigger: 'manual-api'
    })
      .then((summary) => {
        console.log('Manual divergence table run completed:', summary);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence table run failed: ${message}`);
      });

    return res.status(202).json({ status: 'started' });
  });

  app.get('/api/divergence/scan/status', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    try {
      const statusPayload = await fetchLatestDivergenceScanStatus({
        divergencePool,
        divergenceSourceInterval,
        getIsScanRunning,
        getLastFetchedTradeDateEt,
        getLastScanDateEt
      });
      const tableBuild = typeof getTableBuildStatus === 'function'
        ? getTableBuildStatus()
        : null;
      return res.json({
        ...statusPayload,
        tableBuild
      });
    } catch (err) {
      console.error('Failed to fetch divergence scan status:', err);
      return res.status(500).json({ error: 'Failed to fetch scan status' });
    }
  });
}

module.exports = {
  registerDivergenceRoutes
};

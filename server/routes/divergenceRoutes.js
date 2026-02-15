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
    getIsFetchDailyDataRunning,
    getIsFetchWeeklyDataRunning,
    parseBooleanInput,
    parseEtDateInput,
    runDailyDivergenceScan,
    runDivergenceTableBuild,
    runDivergenceFetchDailyData,
    runDivergenceFetchWeeklyData,
    divergencePool,
    divergenceSourceInterval,
    getLastFetchedTradeDateEt,
    getLastScanDateEt,
    getIsTableBuildRunning,
    getTableBuildStatus,
    getScanControlStatus,
    requestPauseScan,
    requestStopScan,
    canResumeScan,
    requestPauseTableBuild,
    requestStopTableBuild,
    canResumeTableBuild,
    getFetchDailyDataStatus,
    requestStopFetchDailyData,
    canResumeFetchDailyData,
    getFetchWeeklyDataStatus,
    requestStopFetchWeeklyData,
    canResumeFetchWeeklyData,
    getVDFScanStatus,
    requestStopVDFScan,
    runVDFScan,
    getIsVDFScanRunning
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
    if (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning()) {
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

  app.post('/api/divergence/scan/pause', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (typeof requestPauseScan !== 'function') {
      return res.status(501).json({ error: 'Scan pause endpoint is not enabled' });
    }
    const accepted = requestPauseScan();
    if (accepted) return res.status(202).json({ status: 'pause-requested' });
    if (typeof canResumeScan === 'function' && canResumeScan()) return res.status(200).json({ status: 'paused' });
    return res.status(409).json({ status: 'idle' });
  });

  app.post('/api/divergence/scan/resume', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (typeof runDailyDivergenceScan !== 'function') {
      return res.status(501).json({ error: 'Scan resume endpoint is not enabled' });
    }
    if (typeof getIsScanRunning === 'function' && getIsScanRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof canResumeScan === 'function' && !canResumeScan()) {
      return res.status(409).json({ status: 'no-resume' });
    }

    runDailyDivergenceScan({
      trigger: 'manual-api-resume',
      resume: true
    })
      .then((summary) => {
        console.log('Manual divergence scan resume completed:', summary);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence scan resume failed: ${message}`);
      });

    return res.status(202).json({ status: 'started' });
  });

  app.post('/api/divergence/scan/stop', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (typeof requestStopScan !== 'function') {
      return res.status(501).json({ error: 'Scan stop endpoint is not enabled' });
    }
    const accepted = requestStopScan();
    if (accepted) return res.status(202).json({ status: 'stop-requested' });
    return res.status(409).json({ status: 'idle' });
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
      || (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning())
      || (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning())
      || (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning())) {
      return res.status(409).json({ status: 'running' });
    }

    if (typeof runDivergenceTableBuild !== 'function') {
      return res.status(501).json({ error: 'Table run endpoint is not enabled' });
    }

    const force = typeof parseBooleanInput === 'function'
      ? parseBooleanInput(req.body?.force, true)
      : true;

    runDivergenceTableBuild({
      trigger: 'manual-api',
      force
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

  app.post('/api/divergence/table/pause', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (typeof requestPauseTableBuild !== 'function') {
      return res.status(501).json({ error: 'Pause endpoint is not enabled' });
    }

    const accepted = requestPauseTableBuild();
    if (accepted) {
      return res.status(202).json({ status: 'pause-requested' });
    }
    if (typeof canResumeTableBuild === 'function' && canResumeTableBuild()) {
      return res.status(200).json({ status: 'paused' });
    }
    return res.status(409).json({ status: 'idle' });
  });

  app.post('/api/divergence/table/resume', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (typeof runDivergenceTableBuild !== 'function') {
      return res.status(501).json({ error: 'Table resume endpoint is not enabled' });
    }

    if (typeof getIsScanRunning === 'function' && getIsScanRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning()) {
      return res.status(409).json({ status: 'running' });
    }
    if (typeof canResumeTableBuild === 'function' && !canResumeTableBuild()) {
      return res.status(409).json({ status: 'no-resume' });
    }

    runDivergenceTableBuild({
      trigger: 'manual-api-resume',
      resume: true
    })
      .then((summary) => {
        console.log('Manual divergence table resume completed:', summary);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence table resume failed: ${message}`);
      });

    return res.status(202).json({ status: 'started' });
  });

  app.post('/api/divergence/table/stop', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (typeof requestStopTableBuild !== 'function') {
      return res.status(501).json({ error: 'Table stop endpoint is not enabled' });
    }
    const accepted = requestStopTableBuild();
    if (accepted) {
      return res.status(202).json({ status: 'stop-requested' });
    }
    return res.status(409).json({ status: 'idle' });
  });

  app.post('/api/divergence/fetch-daily/run', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if ((typeof getIsScanRunning === 'function' && getIsScanRunning())
      || (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning())
      || (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning())
      || (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning())) {
      return res.status(409).json({ status: 'running' });
    }

    if (typeof runDivergenceFetchDailyData !== 'function') {
      return res.status(501).json({ error: 'Fetch-all endpoint is not enabled' });
    }

    const shouldResume = typeof canResumeFetchDailyData === 'function' && canResumeFetchDailyData();

    runDivergenceFetchDailyData({
      trigger: 'manual-api',
      resume: shouldResume,
      force: true
    })
      .then((summary) => {
        console.log(`Manual divergence fetch-daily ${shouldResume ? 'resumed' : 'started'}:`, summary);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence fetch-daily failed: ${message}`);
      });

    return res.status(202).json({ status: shouldResume ? 'resumed' : 'started' });
  });

  app.post('/api/divergence/fetch-daily/stop', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (typeof requestStopFetchDailyData !== 'function') {
      return res.status(501).json({ error: 'Fetch-all stop endpoint is not enabled' });
    }
    const accepted = requestStopFetchDailyData();
    if (accepted) return res.status(202).json({ status: 'stop-requested' });
    return res.status(409).json({ status: 'idle' });
  });

  app.post('/api/divergence/fetch-weekly/run', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if ((typeof getIsScanRunning === 'function' && getIsScanRunning())
      || (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning())
      || (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning())
      || (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning())) {
      return res.status(409).json({ status: 'running' });
    }

    if (typeof runDivergenceFetchWeeklyData !== 'function') {
      return res.status(501).json({ error: 'Fetch-weekly endpoint is not enabled' });
    }

    const shouldResume = typeof canResumeFetchWeeklyData === 'function' && canResumeFetchWeeklyData();

    runDivergenceFetchWeeklyData({
      trigger: 'manual-api',
      resume: shouldResume,
      force: true
    })
      .then((summary) => {
        console.log(`Manual divergence fetch-weekly ${shouldResume ? 'resumed' : 'started'}:`, summary);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence fetch-weekly failed: ${message}`);
      });

    return res.status(202).json({ status: shouldResume ? 'resumed' : 'started' });
  });

  app.post('/api/divergence/fetch-weekly/stop', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (typeof requestStopFetchWeeklyData !== 'function') {
      return res.status(501).json({ error: 'Fetch-weekly stop endpoint is not enabled' });
    }
    const accepted = requestStopFetchWeeklyData();
    if (accepted) return res.status(202).json({ status: 'stop-requested' });
    return res.status(409).json({ status: 'idle' });
  });

  app.get('/api/divergence/scan/status', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    // In-memory statuses are always available and never fail.
    const tableBuild = typeof getTableBuildStatus === 'function'
      ? getTableBuildStatus()
      : null;
    const scanControl = typeof getScanControlStatus === 'function'
      ? getScanControlStatus()
      : null;
    const fetchDailyData = typeof getFetchDailyDataStatus === 'function'
      ? getFetchDailyDataStatus()
      : null;
    const fetchWeeklyData = typeof getFetchWeeklyDataStatus === 'function'
      ? getFetchWeeklyDataStatus()
      : null;

    // The DB query for latestJob can fail under heavy write load
    // (pool connections saturated during fetches). Fall back gracefully.
    let statusPayload;
    try {
      statusPayload = await fetchLatestDivergenceScanStatus({
        divergencePool,
        divergenceSourceInterval,
        getIsScanRunning,
        getLastFetchedTradeDateEt,
        getLastScanDateEt
      });
    } catch (err) {
      console.error('Scan status DB query failed (returning in-memory status):', err.message);
      statusPayload = {
        running: getIsScanRunning(),
        lastScanDateEt: getLastFetchedTradeDateEt() || getLastScanDateEt() || null,
        latestJob: null
      };
    }

    const vdfScan = typeof getVDFScanStatus === 'function'
      ? getVDFScanStatus()
      : null;

    return res.json({
      ...statusPayload,
      scanControl,
      tableBuild,
      fetchDailyData,
      fetchWeeklyData,
      vdfScan
    });
  });

  app.post('/api/divergence/vdf-scan/run', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (typeof getIsVDFScanRunning === 'function' && getIsVDFScanRunning()) {
      return res.status(409).json({ status: 'running' });
    }

    if (typeof runVDFScan !== 'function') {
      return res.status(501).json({ error: 'VDF scan endpoint is not enabled' });
    }

    runVDFScan({ trigger: 'manual-api' })
      .then((summary) => {
        console.log('Manual VDF scan completed:', summary);
      })
      .catch((err) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual VDF scan failed: ${message}`);
      });

    return res.status(202).json({ status: 'started' });
  });

  app.post('/api/divergence/vdf-scan/stop', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String(req.query.secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (typeof requestStopVDFScan !== 'function') {
      return res.status(501).json({ error: 'VDF scan stop endpoint is not enabled' });
    }
    const accepted = requestStopVDFScan();
    if (accepted) return res.status(202).json({ status: 'stop-requested' });
    return res.status(409).json({ status: 'idle' });
  });
}

module.exports = {
  registerDivergenceRoutes
};

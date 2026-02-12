function registerDivergenceRoutes(options = {}) {
  const {
    app,
    isDivergenceConfigured,
    divergenceScanSecret,
    getIsScanRunning,
    parseBooleanInput,
    parseEtDateInput,
    runDailyDivergenceScan,
    divergencePool,
    divergenceSourceInterval,
    getLastFetchedTradeDateEt,
    getLastScanDateEt
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

    const force = parseBooleanInput(req.query.force, false) || parseBooleanInput(req.body?.force, false);
    const refreshUniverse = parseBooleanInput(req.query.refreshUniverse, false)
      || parseBooleanInput(req.body?.refreshUniverse, false);

    let runDateEt;
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'runDateEt')) {
      const parsedRunDate = parseEtDateInput(req.body.runDateEt);
      if (!parsedRunDate) {
        return res.status(400).json({ error: 'runDateEt must be YYYY-MM-DD' });
      }
      runDateEt = parsedRunDate;
    }

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

  app.get('/api/divergence/scan/status', async (req, res) => {
    if (!isDivergenceConfigured()) {
      return res.status(503).json({ error: 'Divergence database is not configured' });
    }

    try {
      const latest = await divergencePool.query(`
        SELECT *
        FROM divergence_scan_jobs
        ORDER BY started_at DESC
        LIMIT 1
      `);
      const latestJob = latest.rows[0] || null;

      if (latestJob && !latestJob.scanned_trade_date) {
        const tradeDateResult = await divergencePool.query(`
          SELECT MAX(trade_date)::text AS scanned_trade_date
          FROM divergence_signals
          WHERE scan_job_id = $1
            AND timeframe = '1d'
            AND source_interval = $2
        `, [latestJob.id, divergenceSourceInterval]);
        const fallbackTradeDate = String(tradeDateResult.rows[0]?.scanned_trade_date || '').trim();
        if (fallbackTradeDate) {
          latestJob.scanned_trade_date = fallbackTradeDate;
        }
      }

      const lastScanDateEt = getLastFetchedTradeDateEt()
        || String(latestJob?.scanned_trade_date || '').trim()
        || getLastScanDateEt()
        || null;

      return res.json({
        running: getIsScanRunning(),
        lastScanDateEt,
        latestJob
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

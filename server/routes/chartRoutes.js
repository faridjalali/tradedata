function invalidIntervalErrorMessage() {
  return 'Invalid interval. Use: 5min, 15min, 30min, 1hour, 4hour, 1day, or 1week';
}

function registerChartRoutes(options = {}) {
  const {
    app,
    parseChartRequestParams,
    validChartIntervals,
    getOrBuildChartResult,
    extractLatestChartPayload,
    sendChartJsonResponse
  } = options;

  if (!app) {
    throw new Error('registerChartRoutes requires app');
  }

  app.get('/api/chart', async (req, res) => {
    const params = parseChartRequestParams(req);
    const { interval } = params;

    if (!validChartIntervals.includes(interval)) {
      return res.status(400).json({ error: invalidIntervalErrorMessage() });
    }

    try {
      const { result, serverTiming } = await getOrBuildChartResult(params);
      await sendChartJsonResponse(req, res, result, serverTiming);
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to fetch chart data';
      console.error('Chart API Error:', message);
      const statusCode = Number(err && err.httpStatus);
      res.status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502).json({ error: message });
    }
  });

  app.get('/api/chart/latest', async (req, res) => {
    const params = parseChartRequestParams(req);
    const { interval } = params;

    if (!validChartIntervals.includes(interval)) {
      return res.status(400).json({ error: invalidIntervalErrorMessage() });
    }

    try {
      const { result, serverTiming } = await getOrBuildChartResult(params);
      const latestPayload = extractLatestChartPayload(result);
      await sendChartJsonResponse(req, res, latestPayload, serverTiming);
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to fetch latest chart data';
      console.error('Chart Latest API Error:', message);
      const statusCode = Number(err && err.httpStatus);
      res.status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502).json({ error: message });
    }
  });
}

module.exports = {
  registerChartRoutes
};

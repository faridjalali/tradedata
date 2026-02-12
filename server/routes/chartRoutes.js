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
    sendChartJsonResponse,
    validateChartPayload,
    validateChartLatestPayload
  } = options;

  if (!app) {
    throw new Error('registerChartRoutes requires app');
  }

  app.get('/api/chart', async (req, res) => {
    try {
      const params = parseChartRequestParams(req);
      const { interval } = params;
      if (!validChartIntervals.includes(interval)) {
        return res.status(400).json({ error: invalidIntervalErrorMessage() });
      }

      const { result, serverTiming } = await getOrBuildChartResult(params);
      if (typeof validateChartPayload === 'function') {
        const validation = validateChartPayload(result);
        if (!validation || validation.ok !== true) {
          const reason = validation && validation.error ? validation.error : 'Invalid chart payload shape';
          return res.status(500).json({ error: reason });
        }
      }
      await sendChartJsonResponse(req, res, result, serverTiming);
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to fetch chart data';
      console.error('Chart API Error:', message);
      const statusCode = Number(err && err.httpStatus);
      res.status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502).json({ error: message });
    }
  });

  app.get('/api/chart/latest', async (req, res) => {
    try {
      const params = parseChartRequestParams(req);
      const { interval } = params;
      if (!validChartIntervals.includes(interval)) {
        return res.status(400).json({ error: invalidIntervalErrorMessage() });
      }

      const { result, serverTiming } = await getOrBuildChartResult(params);
      const latestPayload = extractLatestChartPayload(result);
      if (typeof validateChartLatestPayload === 'function') {
        const validation = validateChartLatestPayload(latestPayload);
        if (!validation || validation.ok !== true) {
          const reason = validation && validation.error ? validation.error : 'Invalid latest payload shape';
          return res.status(500).json({ error: reason });
        }
      }
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

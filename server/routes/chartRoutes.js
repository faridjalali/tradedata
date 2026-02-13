function invalidIntervalErrorMessage() {
  return 'Invalid interval. Use: 5min, 15min, 30min, 1hour, 4hour, 1day, or 1week';
}

function parseTickerListFromQuery(req) {
  const singleTicker = String(req.query.ticker || '').trim();
  const multiTickersRaw = String(req.query.tickers || '').trim();
  const merged = [singleTicker, multiTickersRaw]
    .filter(Boolean)
    .join(',');
  const tickers = merged
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(tickers));
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
    validateChartLatestPayload,
    onChartRequestMeasured,
    isValidTickerSymbol,
    getDivergenceSummaryForTickers
  } = options;

  if (!app) {
    throw new Error('registerChartRoutes requires app');
  }

  app.get('/api/chart', async (req, res) => {
    const startedAtMs = Date.now();
    try {
      const params = parseChartRequestParams(req);
      const { interval } = params;
      if (!validChartIntervals.includes(interval)) {
        return res.status(400).json({ error: invalidIntervalErrorMessage() });
      }

      const { result, serverTiming, cacheHit } = await getOrBuildChartResult(params);
      if (typeof validateChartPayload === 'function') {
        const validation = validateChartPayload(result);
        if (!validation || validation.ok !== true) {
          const reason = validation && validation.error ? validation.error : 'Invalid chart payload shape';
          return res.status(500).json({ error: reason });
        }
      }
      res.setHeader('X-Chart-Cache', cacheHit ? 'hit' : 'miss');
      if (typeof onChartRequestMeasured === 'function') {
        onChartRequestMeasured({
          route: 'chart',
          interval,
          cacheHit,
          durationMs: Date.now() - startedAtMs
        });
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
    const startedAtMs = Date.now();
    try {
      const params = parseChartRequestParams(req);
      const { interval } = params;
      if (!validChartIntervals.includes(interval)) {
        return res.status(400).json({ error: invalidIntervalErrorMessage() });
      }

      const { result, serverTiming, cacheHit } = await getOrBuildChartResult(params);
      const latestPayload = extractLatestChartPayload(result);
      if (typeof validateChartLatestPayload === 'function') {
        const validation = validateChartLatestPayload(latestPayload);
        if (!validation || validation.ok !== true) {
          const reason = validation && validation.error ? validation.error : 'Invalid latest payload shape';
          return res.status(500).json({ error: reason });
        }
      }
      res.setHeader('X-Chart-Cache', cacheHit ? 'hit' : 'miss');
      if (typeof onChartRequestMeasured === 'function') {
        onChartRequestMeasured({
          route: 'chart_latest',
          interval,
          cacheHit,
          durationMs: Date.now() - startedAtMs
        });
      }
      await sendChartJsonResponse(req, res, latestPayload, serverTiming);
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to fetch latest chart data';
      console.error('Chart Latest API Error:', message);
      const statusCode = Number(err && err.httpStatus);
      res.status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502).json({ error: message });
    }
  });

  app.get('/api/chart/divergence-summary', async (req, res) => {
    try {
      if (typeof getDivergenceSummaryForTickers !== 'function') {
        return res.status(501).json({ error: 'Divergence summary endpoint is not enabled' });
      }
      const tickers = parseTickerListFromQuery(req);
      if (tickers.length === 0) {
        return res.status(400).json({ error: 'Provide ticker or tickers query parameter' });
      }
      const maxTickers = 200;
      if (tickers.length > maxTickers) {
        return res.status(400).json({ error: `Too many tickers (max ${maxTickers})` });
      }
      if (typeof isValidTickerSymbol === 'function') {
        for (const ticker of tickers) {
          if (!isValidTickerSymbol(ticker)) {
            return res.status(400).json({ error: `Invalid ticker format: ${ticker}` });
          }
        }
      }

      const vdSourceInterval = String(req.query.vdSourceInterval || '1min').trim();
      const payload = await getDivergenceSummaryForTickers({
        tickers,
        vdSourceInterval
      });
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      return res.status(200).json(payload);
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to fetch divergence summary';
      console.error('Chart Divergence Summary API Error:', message);
      return res.status(502).json({ error: message });
    }
  });
}

module.exports = {
  registerChartRoutes
};

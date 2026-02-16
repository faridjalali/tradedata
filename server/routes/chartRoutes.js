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

function parseBooleanQueryFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
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
    getDivergenceSummaryForTickers,
    barsToTuples,
    pointsToTuples,
    getMiniBarsCacheByTicker,
    loadMiniChartBarsFromDb
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
      
      // Validation skipped for tuple format as shape differs
      const useTupleFormat = req.query.format === 'tuple';
      let payload = result;

      // console.log(`[ChartAPI] Request for ${params.ticker} ${interval} (tuple=${useTupleFormat})`);

      if (useTupleFormat && typeof barsToTuples === 'function') {
        payload = {
          ...result,
          bars: barsToTuples(result.bars),
          rsi: pointsToTuples(result.rsi),
          volumeDelta: pointsToTuples(result.volumeDelta, 'delta'),
          volumeDeltaRsi: {
            ...result.volumeDeltaRsi,
            rsi: pointsToTuples(result.volumeDeltaRsi?.rsi)
          }
        };
      } else if (useTupleFormat) {
          console.warn('[ChartAPI] Tuple format requested but helpers missing!');
      } else if (typeof validateChartPayload === 'function') {
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
      await sendChartJsonResponse(req, res, payload, serverTiming);
    } catch (err) {
      console.error('Chart API Error:', err && err.message ? err.message : err);
      const statusCode = Number(err && err.httpStatus);
      res.status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502).json({ error: 'Failed to fetch chart data' });
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

      const useTupleFormat = req.query.format === 'tuple';
      let payload = latestPayload;

      if (useTupleFormat && typeof barsToTuples === 'function') {
        // For latest, we convert single objects to single tuples (1-element arrays or just the tuple)
        // Since barsToTuples expects array, we wrap and unwrap
        const barTuple = latestPayload.latestBar ? barsToTuples([latestPayload.latestBar])[0] : null;
        const rsiTuple = latestPayload.latestRsi ? pointsToTuples([latestPayload.latestRsi])[0] : null;
        const vdTuple = latestPayload.latestVolumeDelta ? pointsToTuples([latestPayload.latestVolumeDelta], 'delta')[0] : null;
        const vdRsiTuple = latestPayload.latestVolumeDeltaRsi ? pointsToTuples([latestPayload.latestVolumeDeltaRsi])[0] : null;

        payload = {
          ...latestPayload,
          latestBar: barTuple,
          latestRsi: rsiTuple,
          latestVolumeDelta: vdTuple,
          latestVolumeDeltaRsi: vdRsiTuple
        };
      } else if (typeof validateChartLatestPayload === 'function') {
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
      await sendChartJsonResponse(req, res, payload, serverTiming);
    } catch (err) {
      console.error('Chart Latest API Error:', err && err.message ? err.message : err);
      const statusCode = Number(err && err.httpStatus);
      res.status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502).json({ error: 'Failed to fetch latest chart data' });
    }
  });

  // Lightweight endpoint: returns cached daily OHLC bars from the last scan.
  app.get('/api/chart/mini-bars', async (req, res) => {
    try {
      const ticker = String(req.query.ticker || '').trim().toUpperCase();
      if (!ticker) {
        return res.status(400).json({ error: 'Provide a ticker query parameter' });
      }
      if (typeof isValidTickerSymbol === 'function' && !isValidTickerSymbol(ticker)) {
        return res.status(400).json({ error: `Invalid ticker format: ${ticker}` });
      }
      const cache = typeof getMiniBarsCacheByTicker === 'function' ? getMiniBarsCacheByTicker() : null;
      let bars = cache ? (cache.get(ticker) || []) : [];
      // Fall back to DB if in-memory cache is empty (e.g. after server restart).
      if (bars.length === 0 && typeof loadMiniChartBarsFromDb === 'function') {
        bars = await loadMiniChartBarsFromDb(ticker);
        // Repopulate in-memory cache so subsequent requests are instant.
        if (bars.length > 0 && cache) {
          cache.set(ticker, bars);
        }
      }
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(200).json({ ticker, bars });
    } catch (err) {
      console.error('Mini Bars API Error:', err && err.message ? err.message : err);
      return res.status(500).json({ error: 'Failed to fetch mini bars' });
    }
  });

  app.get('/api/chart/vdf-status', async (req, res) => {
    try {
      if (typeof options.getVDFStatus !== 'function') {
        return res.status(501).json({ error: 'VDF endpoint is not enabled' });
      }
      const ticker = String(req.query.ticker || '').trim().toUpperCase();
      if (!ticker) {
        return res.status(400).json({ error: 'Provide a ticker query parameter' });
      }
      if (typeof isValidTickerSymbol === 'function' && !isValidTickerSymbol(ticker)) {
        return res.status(400).json({ error: `Invalid ticker format: ${ticker}` });
      }
      const force = parseBooleanQueryFlag(req.query.force);
      const mode = req.query.mode === 'chart' ? 'chart' : 'scan';
      const result = await options.getVDFStatus(ticker, { force, mode });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(result);
    } catch (err) {
      console.error('VDF Status API Error:', err && err.message ? err.message : err);
      return res.status(502).json({ error: 'Failed to fetch VDF status' });
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
      const refresh = parseBooleanQueryFlag(req.query.refresh);
      const noCache = parseBooleanQueryFlag(req.query.nocache) || parseBooleanQueryFlag(req.query.noCache);
      const payload = await getDivergenceSummaryForTickers({
        tickers,
        vdSourceInterval,
        forceRefresh: refresh,
        noCache
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(payload);
    } catch (err) {
      console.error('Chart Divergence Summary API Error:', err && err.message ? err.message : err);
      return res.status(502).json({ error: 'Failed to fetch divergence summary' });
    }
  });
}

module.exports = {
  registerChartRoutes
};

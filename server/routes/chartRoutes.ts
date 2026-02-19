import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// In-flight dedup for mini-bar live API fetches — prevents duplicate upstream calls
// when multiple requests arrive simultaneously for the same ticker with empty cache.
const miniBarApiFetchInFlight = new Map<string, Promise<unknown[]>>();

function invalidIntervalErrorMessage(): string {
  return 'Invalid interval. Use: 5min, 15min, 30min, 1hour, 4hour, 1day, or 1week';
}

function classifyChartError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'INTERNAL_ERROR';
  const e = err as Record<string, unknown>;
  if (e.isDataApiRateLimited) return 'RATE_LIMITED';
  if (e.isDataApiPaused) return 'API_PAUSED';
  if (e.isTaskTimeout) return 'BUILD_TIMEOUT';
  if (e.name === 'CircuitOpenError') return 'CIRCUIT_OPEN';
  if (e.isDataApiSubscriptionRestricted) return 'SUBSCRIPTION_RESTRICTED';
  if (Number(e.httpStatus) === 400) return 'BAD_REQUEST';
  if (Number(e.httpStatus) === 503) return 'SERVICE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

/**
 * Extract a deduplicated, uppercased ticker list from query params.
 */
function parseTickerListFromQuery(req: FastifyRequest): string[] {
  const singleTicker = String((req.query as Record<string, unknown>).ticker || '').trim();
  const multiTickersRaw = String((req.query as Record<string, unknown>).tickers || '').trim();
  const merged = [singleTicker, multiTickersRaw].filter(Boolean).join(',');
  const tickers = merged
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(tickers));
}

/**
 * Parse a query string value as a boolean flag.
 */
function parseBooleanQueryFlag(value: string | undefined): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

// ---------------------------------------------------------------------------
// Types for dependency-injected chart helpers
// ---------------------------------------------------------------------------

interface ChartRequestParams {
  ticker: string;
  interval: string;
  [key: string]: unknown;
}

interface PayloadValidation {
  ok: boolean;
  error?: string;
}

// DI boundary: function signatures use wide parameter types so that concrete
// implementations in index.ts are assignable without casts.  Route handlers
// narrow with targeted casts where needed.
interface ChartRoutesOptions {
  app: FastifyInstance;
  parseChartRequestParams: (req: { query: Record<string, unknown> }) => ChartRequestParams;
  validChartIntervals: readonly string[];
  getOrBuildChartResult: (params: Record<string, unknown>) => Promise<{ result: unknown; serverTiming: string | null; cacheHit: boolean }>;
  extractLatestChartPayload: (result: Record<string, unknown>) => Record<string, unknown>;
  sendChartJsonResponse: (req: { headers: Record<string, string | undefined> }, res: FastifyReply, payload: unknown, serverTiming: string | null) => Promise<unknown>;
  validateChartPayload?: (payload: unknown) => PayloadValidation;
  validateChartLatestPayload?: (payload: unknown) => PayloadValidation;
  onChartRequestMeasured?: (info: { route: string; interval: string; cacheHit: boolean; durationMs: number }) => void;
  isValidTickerSymbol?: (value: unknown) => boolean;
  getDivergenceSummaryForTickers?: (options: Record<string, unknown>) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DI boundary: callers pass heterogeneous arrays
  barsToTuples?: (bars: any[]) => unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DI boundary: callers pass heterogeneous arrays
  pointsToTuples?: (points: any[], valueKey?: string) => unknown[];
  getMiniBarsCacheByTicker?: () => unknown;
  loadMiniChartBarsFromDb?: (ticker: string) => Promise<unknown[]>;
  loadMiniChartBarsFromDbBatch?: (tickers: string[]) => Promise<Record<string, unknown[]>>;
  fetchMiniChartBarsFromApi?: (ticker: string) => Promise<unknown[]>;
  getVDFStatus?: (ticker: string, options: { force: boolean; mode: string }) => Promise<unknown>;
}

/**
 * Register all chart-related HTTP routes on the Fastify app.
 */
function registerChartRoutes(options: ChartRoutesOptions): void {
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
    loadMiniChartBarsFromDb,
    loadMiniChartBarsFromDbBatch,
    fetchMiniChartBarsFromApi,
  } = options;

  if (!app) {
    throw new Error('registerChartRoutes requires app');
  }

  app.get('/api/chart', async (req: FastifyRequest, res: FastifyReply) => {
    const startedAtMs = Date.now();
    try {
      const params = parseChartRequestParams(req as unknown as { query: Record<string, unknown> });
      const { interval } = params;
      if (!validChartIntervals.includes(interval)) {
        return res.code(400).send({ error: invalidIntervalErrorMessage() });
      }

      const { result: rawResult, serverTiming, cacheHit } = await getOrBuildChartResult(params);
      const result = rawResult as Record<string, unknown>;

      // Validation skipped for tuple format as shape differs
      const useTupleFormat = (req.query as Record<string, unknown>).format === 'tuple';
      let payload: unknown = result;

      if (useTupleFormat && typeof barsToTuples === 'function' && typeof pointsToTuples === 'function') {
        const vdRsi = result.volumeDeltaRsi as Record<string, unknown> | undefined;
        payload = {
          ...result,
          bars: barsToTuples(result.bars as unknown[]),
          rsi: pointsToTuples(result.rsi as unknown[]),
          volumeDelta: pointsToTuples(result.volumeDelta as unknown[], 'delta'),
          volumeDeltaRsi: {
            ...vdRsi,
            rsi: pointsToTuples((vdRsi?.rsi ?? []) as unknown[]),
          },
        };
      } else if (useTupleFormat) {
        console.warn('[ChartAPI] Tuple format requested but helpers missing!');
      } else if (typeof validateChartPayload === 'function') {
        const validation = validateChartPayload(result);
        if (!validation || validation.ok !== true) {
          const reason = validation && validation.error ? validation.error : 'Invalid chart payload shape';
          return res.code(500).send({ error: reason });
        }
      }

      res.header('X-Chart-Cache', cacheHit ? 'hit' : 'miss');
      if (typeof onChartRequestMeasured === 'function') {
        onChartRequestMeasured({
          route: 'chart',
          interval,
          cacheHit,
          durationMs: Date.now() - startedAtMs,
        });
      }
      await sendChartJsonResponse(req as unknown as { headers: Record<string, string | undefined> }, res, payload, serverTiming);
    } catch (err: unknown) {
      console.error('Chart API Error:', err instanceof Error ? err.message : String(err));
      const errObj = err as Record<string, unknown>;
      const statusCode = Number(errObj?.httpStatus);
      res
        .status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502)
        .send({ error: 'Failed to fetch chart data', code: classifyChartError(err) });
    }
  });

  app.get('/api/chart/latest', async (req: FastifyRequest, res: FastifyReply) => {
    const startedAtMs = Date.now();
    try {
      const params = parseChartRequestParams(req as unknown as { query: Record<string, unknown> });
      const { interval } = params;
      if (!validChartIntervals.includes(interval)) {
        return res.code(400).send({ error: invalidIntervalErrorMessage() });
      }

      const { result: rawResult2, serverTiming, cacheHit } = await getOrBuildChartResult(params);
      const latestPayload = extractLatestChartPayload(rawResult2 as Record<string, unknown>);

      const useTupleFormat = (req.query as Record<string, unknown>).format === 'tuple';
      let payload: unknown = latestPayload;

      if (useTupleFormat && typeof barsToTuples === 'function' && typeof pointsToTuples === 'function') {
        // For latest, we convert single objects to single tuples (1-element arrays or just the tuple)
        // Since barsToTuples expects array, we wrap and unwrap
        const barTuple = latestPayload.latestBar ? barsToTuples([latestPayload.latestBar])[0] : null;
        const rsiTuple = latestPayload.latestRsi ? pointsToTuples([latestPayload.latestRsi])[0] : null;
        const vdTuple = latestPayload.latestVolumeDelta
          ? pointsToTuples([latestPayload.latestVolumeDelta], 'delta')[0]
          : null;
        const vdRsiTuple = latestPayload.latestVolumeDeltaRsi
          ? pointsToTuples([latestPayload.latestVolumeDeltaRsi])[0]
          : null;

        payload = {
          ...latestPayload,
          latestBar: barTuple,
          latestRsi: rsiTuple,
          latestVolumeDelta: vdTuple,
          latestVolumeDeltaRsi: vdRsiTuple,
        };
      } else if (typeof validateChartLatestPayload === 'function') {
        const validation = validateChartLatestPayload(latestPayload);
        if (!validation || validation.ok !== true) {
          const reason = validation && validation.error ? validation.error : 'Invalid latest payload shape';
          return res.code(500).send({ error: reason });
        }
      }

      res.header('X-Chart-Cache', cacheHit ? 'hit' : 'miss');
      if (typeof onChartRequestMeasured === 'function') {
        onChartRequestMeasured({
          route: 'chart_latest',
          interval,
          cacheHit,
          durationMs: Date.now() - startedAtMs,
        });
      }
      await sendChartJsonResponse(req as unknown as { headers: Record<string, string | undefined> }, res, payload, serverTiming);
    } catch (err: unknown) {
      console.error('Chart Latest API Error:', err instanceof Error ? err.message : String(err));
      const errObj = err as Record<string, unknown>;
      const statusCode = Number(errObj?.httpStatus);
      res
        .status(Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 502)
        .send({ error: 'Failed to fetch latest chart data', code: classifyChartError(err) });
    }
  });

  // Lightweight endpoint: returns cached daily OHLC bars from the last scan.
  app.get('/api/chart/mini-bars', async (req: FastifyRequest, res: FastifyReply) => {
    try {
      const ticker = String((req.query as Record<string, unknown>).ticker || '')
        .trim()
        .toUpperCase();
      if (!ticker) {
        return res.code(400).send({ error: 'Provide a ticker query parameter' });
      }
      if (typeof isValidTickerSymbol === 'function' && !isValidTickerSymbol(ticker)) {
        return res.code(400).send({ error: `Invalid ticker format: ${ticker}` });
      }
      const cache = (typeof getMiniBarsCacheByTicker === 'function' ? getMiniBarsCacheByTicker() : null) as Map<string, unknown[]> | null;
      let bars: unknown[] = cache ? cache.get(ticker) || [] : [];
      // Fall back to DB if in-memory cache is empty (e.g. after server restart).
      if (bars.length === 0 && typeof loadMiniChartBarsFromDb === 'function') {
        bars = await loadMiniChartBarsFromDb(ticker);
        if (bars.length > 0 && cache) {
          cache.set(ticker, bars);
        }
      }
      // Fall back to live API fetch if DB is also empty — deduplicated per ticker.
      if (bars.length === 0 && typeof fetchMiniChartBarsFromApi === 'function') {
        let inFlight = miniBarApiFetchInFlight.get(ticker);
        if (!inFlight) {
          inFlight = (fetchMiniChartBarsFromApi(ticker) as Promise<unknown[]>).finally(() => {
            miniBarApiFetchInFlight.delete(ticker);
          });
          miniBarApiFetchInFlight.set(ticker, inFlight);
        }
        bars = await inFlight;
      }
      // Trim to most recent ~30 bars (in-memory cache may contain older untrimmed data).
      if (bars.length > 30) bars = bars.slice(-30);
      res.header('Cache-Control', 'public, max-age=300');
      return res.code(200).send({ ticker, bars });
    } catch (err: unknown) {
      console.error('Mini Bars API Error:', err instanceof Error ? err.message : String(err));
      return res.code(500).send({ error: 'Failed to fetch mini bars' });
    }
  });

  // Batch endpoint: returns cached daily OHLC bars for multiple tickers (memory + DB only, no API fallback).
  app.get('/api/chart/mini-bars/batch', async (req: FastifyRequest, res: FastifyReply) => {
    try {
      const tickers = parseTickerListFromQuery(req);
      if (tickers.length === 0) {
        return res.code(400).send({ error: 'Provide ticker or tickers query parameter' });
      }
      const maxTickers = 200;
      if (tickers.length > maxTickers) {
        return res.code(400).send({ error: `Too many tickers (max ${maxTickers})` });
      }
      if (typeof isValidTickerSymbol === 'function') {
        for (const t of tickers) {
          if (!isValidTickerSymbol(t)) {
            return res.code(400).send({ error: `Invalid ticker format: ${t}` });
          }
        }
      }

      const results: Record<string, unknown[]> = {};
      const cache = (typeof getMiniBarsCacheByTicker === 'function' ? getMiniBarsCacheByTicker() : null) as Map<string, unknown[]> | null;
      const dbNeeded = [];

      // 1. Check in-memory cache first (trim to ~30 bars in case of stale data)
      for (const t of tickers) {
        let cached: unknown[] = cache ? cache.get(t) || [] : [];
        if (cached.length > 30) cached = cached.slice(-30);
        if (cached.length > 0) {
          results[t] = cached;
        } else {
          dbNeeded.push(t);
        }
      }

      // 2. Batch-load from DB for cache misses
      const apiNeeded = [];
      if (dbNeeded.length > 0 && typeof loadMiniChartBarsFromDbBatch === 'function') {
        const dbResults = await loadMiniChartBarsFromDbBatch(dbNeeded);
        for (const t of dbNeeded) {
          const bars = dbResults[t] || [];
          if (bars.length > 0) {
            results[t] = bars;
            if (cache) cache.set(t, bars);
          } else {
            apiNeeded.push(t);
          }
        }
      } else {
        apiNeeded.push(...dbNeeded);
      }

      // 3. Fall back to live API fetch for tickers missing from both cache and DB.
      //    fetchMiniChartBarsFromApi persists to DB + memory automatically.
      if (apiNeeded.length > 0 && typeof fetchMiniChartBarsFromApi === 'function') {
        const API_CONCURRENCY = 5;
        for (let i = 0; i < apiNeeded.length; i += API_CONCURRENCY) {
          const chunk = apiNeeded.slice(i, i + API_CONCURRENCY);
          const fetched = await Promise.all(
            chunk.map((t) => fetchMiniChartBarsFromApi(t).then((bars: unknown[]) => ({ t, bars }))),
          );
          for (const { t, bars } of fetched) {
            if (Array.isArray(bars) && bars.length > 0) {
              results[t] = bars;
            }
          }
        }
      }

      res.header('Cache-Control', 'public, max-age=300');
      return res.code(200).send({ results });
    } catch (err: unknown) {
      console.error('Mini Bars Batch API Error:', err instanceof Error ? err.message : String(err));
      return res.code(500).send({ error: 'Failed to fetch mini bars batch' });
    }
  });

  app.get('/api/chart/vdf-status', async (req: FastifyRequest, res: FastifyReply) => {
    try {
      if (typeof options.getVDFStatus !== 'function') {
        return res.code(501).send({ error: 'VDF endpoint is not enabled' });
      }
      const ticker = String((req.query as Record<string, unknown>).ticker || '')
        .trim()
        .toUpperCase();
      if (!ticker) {
        return res.code(400).send({ error: 'Provide a ticker query parameter' });
      }
      if (typeof isValidTickerSymbol === 'function' && !isValidTickerSymbol(ticker)) {
        return res.code(400).send({ error: `Invalid ticker format: ${ticker}` });
      }
      const force = parseBooleanQueryFlag((req.query as Record<string, unknown>).force as string);
      const mode = (req.query as Record<string, unknown>).mode === 'chart' ? 'chart' : 'scan';
      const result = await options.getVDFStatus(ticker, { force, mode });
      res.header('Cache-Control', 'no-store');
      return res.code(200).send(result);
    } catch (err: unknown) {
      console.error('VDF Status API Error:', err instanceof Error ? err.message : String(err));
      return res.code(502).send({ error: 'Failed to fetch VDF status' });
    }
  });

  app.get('/api/chart/divergence-summary', async (req: FastifyRequest, res: FastifyReply) => {
    try {
      if (typeof getDivergenceSummaryForTickers !== 'function') {
        return res.code(501).send({ error: 'Divergence summary endpoint is not enabled' });
      }
      const tickers = parseTickerListFromQuery(req);
      if (tickers.length === 0) {
        return res.code(400).send({ error: 'Provide ticker or tickers query parameter' });
      }
      const maxTickers = 200;
      if (tickers.length > maxTickers) {
        return res.code(400).send({ error: `Too many tickers (max ${maxTickers})` });
      }
      if (typeof isValidTickerSymbol === 'function') {
        for (const ticker of tickers) {
          if (!isValidTickerSymbol(ticker)) {
            return res.code(400).send({ error: `Invalid ticker format: ${ticker}` });
          }
        }
      }

      const vdSourceInterval = String((req.query as Record<string, unknown>).vdSourceInterval || '1min').trim();
      const refresh = parseBooleanQueryFlag((req.query as Record<string, unknown>).refresh as string);
      const noCache = parseBooleanQueryFlag((req.query as Record<string, unknown>).nocache as string) || parseBooleanQueryFlag((req.query as Record<string, unknown>).noCache as string);
      const payload = await getDivergenceSummaryForTickers({
        tickers,
        vdSourceInterval,
        forceRefresh: refresh,
        noCache,
      });
      res.header('Cache-Control', 'no-store');
      return res.code(200).send(payload);
    } catch (err: unknown) {
      console.error('Chart Divergence Summary API Error:', err instanceof Error ? err.message : String(err));
      return res.code(502).send({ error: 'Failed to fetch divergence summary' });
    }
  });
}

export { registerChartRoutes };

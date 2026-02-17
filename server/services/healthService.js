/**
 * Check if a PostgreSQL pool is responsive.
 * @param {{ query: Function }|null} poolInstance - pg Pool instance, or null
 * @returns {Promise<{ ok: boolean|null, error?: string }>}
 */
async function checkDatabaseReady(poolInstance) {
  if (!poolInstance) return { ok: null };
  try {
    await poolInstance.query('SELECT 1');
    return { ok: true };
  } catch (/** @type {any} */ err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Build the debug metrics response payload.
 * @param {object} options
 * @param {number} options.startedAtMs - Server start timestamp
 * @param {boolean} options.isShuttingDown - Whether server is shutting down
 * @param {{ totalRequests: number, apiRequests: number }} options.httpDebugMetrics
 * @param {object} options.chartCacheSizes - Chart cache size breakdown
 * @param {object} options.chartDebugMetrics - Chart cache hit/miss metrics
 * @param {{ configured: boolean, running: boolean, lastScanDateEt: string }} options.divergence
 * @param {NodeJS.MemoryUsage} [options.memoryUsage]
 * @returns {object}
 */
function buildDebugMetricsPayload(options) {
  const { startedAtMs, isShuttingDown, httpDebugMetrics, chartCacheSizes, chartDebugMetrics, divergence, memoryUsage } =
    options;
  const memory = /** @type {any} */ (memoryUsage || {});
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
    shuttingDown: isShuttingDown,
    http: {
      totalRequests: httpDebugMetrics.totalRequests,
      apiRequests: httpDebugMetrics.apiRequests,
    },
    chart: {
      cacheSizes: chartCacheSizes,
      metrics: chartDebugMetrics,
    },
    divergence: {
      configured: divergence.configured,
      running: divergence.running,
      lastScanDateEt: divergence.lastScanDateEt,
    },
    process: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
    },
  };
}

/**
 * Build the /healthz response payload.
 * @param {object} options
 * @param {boolean} options.isShuttingDown
 * @param {string} options.nowIso - Current ISO timestamp
 * @param {number} options.uptimeSeconds
 * @returns {{ status: string, timestamp: string, uptimeSeconds: number, shuttingDown: boolean }}
 */
function buildHealthPayload(options) {
  const { isShuttingDown, nowIso, uptimeSeconds } = options;
  return {
    status: 'ok',
    timestamp: nowIso,
    uptimeSeconds,
    shuttingDown: isShuttingDown,
  };
}

/**
 * Build the /readyz response payload with database connectivity checks.
 * @param {object} options
 * @param {{ query: Function }} options.pool - Primary pg Pool
 * @param {{ query: Function }} [options.divergencePool] - Divergence pg Pool
 * @param {Function} options.isDivergenceConfigured
 * @param {boolean} options.isShuttingDown
 * @param {boolean} options.divergenceScanRunning
 * @param {string|null} options.lastScanDateEt
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
async function buildReadyPayload(options) {
  const { pool, divergencePool, isDivergenceConfigured, isShuttingDown, divergenceScanRunning, lastScanDateEt } =
    options;

  const primaryDb = await checkDatabaseReady(pool);
  const divergenceConfigured = isDivergenceConfigured();
  const divergenceDb = divergenceConfigured ? await checkDatabaseReady(divergencePool || null) : { ok: null };
  const ready = !isShuttingDown && primaryDb.ok === true;
  const statusCode = ready ? 200 : 503;

  return {
    statusCode,
    body: {
      ready,
      shuttingDown: isShuttingDown,
      primaryDb: primaryDb.ok,
      divergenceDb: divergenceDb.ok,
      divergenceConfigured,
      divergenceScanRunning,
      lastScanDateEt,
      errors: {
        primaryDb: primaryDb.error || null,
        divergenceDb: divergenceDb.error || null,
      },
    },
  };
}

export { checkDatabaseReady, buildDebugMetricsPayload, buildHealthPayload, buildReadyPayload };

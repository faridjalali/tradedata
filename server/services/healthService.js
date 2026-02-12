async function checkDatabaseReady(poolInstance) {
  if (!poolInstance) return { ok: null };
  try {
    await poolInstance.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: message };
  }
}

function buildDebugMetricsPayload(options = {}) {
  const {
    startedAtMs,
    isShuttingDown,
    httpDebugMetrics,
    chartCacheSizes,
    chartDebugMetrics,
    divergence,
    memoryUsage
  } = options;
  const memory = memoryUsage || {};
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
    shuttingDown: isShuttingDown,
    http: {
      totalRequests: httpDebugMetrics.totalRequests,
      apiRequests: httpDebugMetrics.apiRequests
    },
    chart: {
      cacheSizes: chartCacheSizes,
      metrics: chartDebugMetrics
    },
    divergence: {
      configured: divergence.configured,
      running: divergence.running,
      lastScanDateEt: divergence.lastScanDateEt
    },
    process: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external
    }
  };
}

function buildHealthPayload(options = {}) {
  const {
    isShuttingDown,
    nowIso,
    uptimeSeconds
  } = options;
  return {
    status: 'ok',
    timestamp: nowIso,
    uptimeSeconds,
    shuttingDown: isShuttingDown
  };
}

async function buildReadyPayload(options = {}) {
  const {
    pool,
    divergencePool,
    isDivergenceConfigured,
    isShuttingDown,
    divergenceScanRunning,
    lastScanDateEt
  } = options;

  const primaryDb = await checkDatabaseReady(pool);
  const divergenceConfigured = isDivergenceConfigured();
  const divergenceDb = divergenceConfigured
    ? await checkDatabaseReady(divergencePool)
    : { ok: null };
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
        divergenceDb: divergenceDb.error || null
      }
    }
  };
}

module.exports = {
  checkDatabaseReady,
  buildDebugMetricsPayload,
  buildHealthPayload,
  buildReadyPayload
};

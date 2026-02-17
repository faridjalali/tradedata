async function checkDatabaseReady(poolInstance: { query: Function } | null): Promise<{ ok: boolean | null; error?: string }> {
  if (!poolInstance) return { ok: null };
  try {
    await poolInstance.query('SELECT 1');
    return { ok: true };
  } catch (err: any) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: message };
  }
}

interface DebugMetricsOptions {
  startedAtMs: number;
  isShuttingDown: boolean;
  httpDebugMetrics: { totalRequests: number; apiRequests: number };
  chartCacheSizes: Record<string, any>;
  chartDebugMetrics: Record<string, any>;
  divergence: { configured: boolean; running: boolean; lastScanDateEt: string };
  memoryUsage?: NodeJS.MemoryUsage;
}

function buildDebugMetricsPayload(options: DebugMetricsOptions) {
  const { startedAtMs, isShuttingDown, httpDebugMetrics, chartCacheSizes, chartDebugMetrics, divergence, memoryUsage } =
    options;
  const memory = (memoryUsage || {}) as any;
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

interface HealthPayloadOptions {
  isShuttingDown: boolean;
  nowIso: string;
  uptimeSeconds: number;
}

function buildHealthPayload(options: HealthPayloadOptions) {
  const { isShuttingDown, nowIso, uptimeSeconds } = options;
  return {
    status: 'ok',
    timestamp: nowIso,
    uptimeSeconds,
    shuttingDown: isShuttingDown,
  };
}

interface ReadyPayloadOptions {
  pool: { query: Function };
  divergencePool?: { query: Function };
  isDivergenceConfigured: () => boolean;
  isShuttingDown: boolean;
  divergenceScanRunning: boolean;
  lastScanDateEt: string | null;
}

async function buildReadyPayload(options: ReadyPayloadOptions) {
  const { pool, divergencePool, isDivergenceConfigured, isShuttingDown, divergenceScanRunning, lastScanDateEt } =
    options;

  const primaryDb = await checkDatabaseReady(pool);
  const divergenceConfigured = isDivergenceConfigured();
  const divergenceDb = divergenceConfigured ? await checkDatabaseReady(divergencePool || null) : { ok: null as boolean | null };
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

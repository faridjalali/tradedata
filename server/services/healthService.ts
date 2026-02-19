async function checkDatabaseReady(poolInstance: { query: (...args: unknown[]) => Promise<unknown> } | null): Promise<{ ok: boolean | null; error?: string }> {
  if (!poolInstance) return { ok: null };
  try {
    await poolInstance.query('SELECT 1');
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

interface DebugMetricsOptions {
  startedAtMs: number;
  isShuttingDown: boolean;
  httpDebugMetrics: { totalRequests: number; apiRequests: number };
  chartCacheSizes: Record<string, unknown>;
  chartDebugMetrics: Record<string, unknown>;
  divergence: { configured: boolean; running: boolean; lastScanDateEt: string };
  memoryUsage?: NodeJS.MemoryUsage;
}

function buildDebugMetricsPayload(options: DebugMetricsOptions) {
  const { startedAtMs, isShuttingDown, httpDebugMetrics, chartCacheSizes, chartDebugMetrics, divergence, memoryUsage } =
    options;
  const memory = memoryUsage ?? { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
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
  pool: { query: (...args: unknown[]) => Promise<unknown> };
  divergencePool?: { query: (...args: unknown[]) => Promise<unknown> };
  isDivergenceConfigured: () => boolean;
  isShuttingDown: boolean;
  divergenceScanRunning: boolean;
  lastScanDateEt: string | null;
  circuitBreakerInfo?: { state: string; consecutiveFailures?: number; failures?: number } | null;
  getPoolStats?: () => { total: number; idle: number; waiting: number; max: number } | null;
}

const DATA_STALENESS_WARN_HOURS = 25;

async function buildReadyPayload(options: ReadyPayloadOptions) {
  const { pool, divergencePool, isDivergenceConfigured, isShuttingDown, divergenceScanRunning, lastScanDateEt, circuitBreakerInfo, getPoolStats } =
    options;

  const primaryDb = await checkDatabaseReady(pool);
  const divergenceConfigured = isDivergenceConfigured();
  const divergenceDb = divergenceConfigured ? await checkDatabaseReady(divergencePool || null) : { ok: null as boolean | null };
  const ready = !isShuttingDown && primaryDb.ok === true;

  // Degraded checks — app is up but operating in a reduced-capacity state.
  const warnings: string[] = [];
  const cbState = circuitBreakerInfo?.state ?? 'CLOSED';
  if (cbState === 'OPEN') warnings.push('data-api circuit breaker is OPEN — external market-data calls are failing');
  if (cbState === 'HALF_OPEN') warnings.push('data-api circuit breaker is HALF_OPEN — external market-data calls are recovering');
  if (lastScanDateEt) {
    const scanDate = new Date(lastScanDateEt + 'T00:00:00-05:00');
    const hoursSinceScan = (Date.now() - scanDate.getTime()) / (60 * 60 * 1000);
    if (hoursSinceScan > DATA_STALENESS_WARN_HOURS) {
      warnings.push(`divergence scan data is stale — last scan: ${lastScanDateEt} (${Math.floor(hoursSinceScan)}h ago)`);
    }
  }
  const poolStats = typeof getPoolStats === 'function' ? getPoolStats() : null;
  if (poolStats && poolStats.max > 0) {
    const utilization = poolStats.total / poolStats.max;
    if (poolStats.waiting > 0) warnings.push(`DB pool has ${poolStats.waiting} waiting connection(s)`);
    else if (utilization >= 0.9) warnings.push(`DB pool near capacity (${poolStats.total}/${poolStats.max} connections)`);
  }

  const degraded = warnings.length > 0;
  const statusCode = !ready ? 503 : 200;

  return {
    statusCode,
    body: {
      ready,
      degraded,
      shuttingDown: isShuttingDown,
      primaryDb: primaryDb.ok,
      divergenceDb: divergenceDb.ok,
      divergenceConfigured,
      divergenceScanRunning,
      lastScanDateEt,
      circuitBreaker: cbState,
      dbPool: poolStats ?? undefined,
      warnings: degraded ? warnings : undefined,
      errors: {
        primaryDb: primaryDb.error || null,
        divergenceDb: divergenceDb.error || null,
      },
    },
  };
}

export { checkDatabaseReady, buildDebugMetricsPayload, buildHealthPayload, buildReadyPayload };

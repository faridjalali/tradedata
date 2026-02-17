import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { buildManualScanRequest, fetchLatestDivergenceScanStatus } from '../services/divergenceService.js';

interface DivergenceRoutesOptions {
  app: FastifyInstance;
  isDivergenceConfigured: () => boolean;
  divergenceScanSecret?: string;
  getIsScanRunning: () => boolean;
  getIsFetchDailyDataRunning?: () => boolean;
  getIsFetchWeeklyDataRunning?: () => boolean;
  parseBooleanInput?: (value: unknown, defaultValue: boolean) => boolean;
  parseEtDateInput: (value: unknown) => string | null;
  runDailyDivergenceScan: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  runDivergenceTableBuild?: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  runDivergenceFetchDailyData?: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  runDivergenceFetchWeeklyData?: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  divergencePool: { query: (...args: any[]) => Promise<{ rows: Record<string, any>[] }> } | null;
  divergenceSourceInterval: string;
  getLastFetchedTradeDateEt: () => string;
  getLastScanDateEt: () => string;
  getIsTableBuildRunning?: () => boolean;
  getTableBuildStatus?: () => Record<string, unknown>;
  getScanControlStatus?: () => Record<string, unknown>;
  requestPauseScan?: () => boolean;
  requestStopScan?: () => boolean;
  canResumeScan?: () => boolean;
  requestPauseTableBuild?: () => boolean;
  requestStopTableBuild?: () => boolean;
  canResumeTableBuild?: () => boolean;
  getFetchDailyDataStatus?: () => Record<string, unknown>;
  requestStopFetchDailyData?: () => boolean;
  canResumeFetchDailyData?: () => boolean;
  getFetchWeeklyDataStatus?: () => Record<string, unknown>;
  requestStopFetchWeeklyData?: () => boolean;
  canResumeFetchWeeklyData?: () => boolean;
  getVDFScanStatus?: () => Record<string, unknown>;
  requestStopVDFScan?: () => boolean;
  canResumeVDFScan?: () => boolean;
  runVDFScan?: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getIsVDFScanRunning?: () => boolean;
}

/**
 * Register all divergence scan and control HTTP routes on the Fastify app.
 */
function registerDivergenceRoutes(options: DivergenceRoutesOptions): void {
  const {
    app,
    isDivergenceConfigured,
    divergenceScanSecret,
    getIsScanRunning,
    getIsFetchDailyDataRunning,
    getIsFetchWeeklyDataRunning,
    parseBooleanInput,
    parseEtDateInput,
    runDailyDivergenceScan,
    runDivergenceTableBuild,
    runDivergenceFetchDailyData,
    runDivergenceFetchWeeklyData,
    divergencePool,
    divergenceSourceInterval,
    getLastFetchedTradeDateEt,
    getLastScanDateEt,
    getIsTableBuildRunning,
    getTableBuildStatus,
    getScanControlStatus,
    requestPauseScan,
    requestStopScan,
    canResumeScan,
    requestPauseTableBuild,
    requestStopTableBuild,
    canResumeTableBuild,
    getFetchDailyDataStatus,
    requestStopFetchDailyData,
    canResumeFetchDailyData,
    getFetchWeeklyDataStatus,
    requestStopFetchWeeklyData,
    canResumeFetchWeeklyData,
    getVDFScanStatus,
    requestStopVDFScan,
    canResumeVDFScan,
    runVDFScan,
    getIsVDFScanRunning,
  } = options;

  if (!app) {
    throw new Error('registerDivergenceRoutes requires app');
  }

  app.post('/api/divergence/scan', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (getIsScanRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning()) {
      return res.code(409).send({ status: 'running' });
    }

    const scanRequest = buildManualScanRequest({
      req: { query: (req.query || {}) as Record<string, unknown>, body: (req.body || {}) as Record<string, unknown> },
      parseBooleanInput: parseBooleanInput!,
      parseEtDateInput,
    });
    if (!scanRequest.ok) {
      return res.code(400).send({ error: scanRequest.error });
    }
    const { force, refreshUniverse, runDateEt } = scanRequest.value;

    runDailyDivergenceScan({
      force,
      refreshUniverse,
      runDateEt,
      trigger: 'manual-api',
    })
      .then((summary: Record<string, unknown>) => {
        console.log('Manual divergence scan completed:', summary);
      })
      .catch((err: any) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence scan failed: ${message}`);
      });

    return res.code(202).send({ status: 'started' });
  });

  app.post('/api/divergence/scan/pause', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }
    if (typeof requestPauseScan !== 'function') {
      return res.code(501).send({ error: 'Scan pause endpoint is not enabled' });
    }
    const accepted = requestPauseScan();
    if (accepted) return res.code(202).send({ status: 'pause-requested' });
    if (typeof canResumeScan === 'function' && canResumeScan()) return res.code(200).send({ status: 'paused' });
    return res.code(409).send({ status: 'idle' });
  });

  app.post('/api/divergence/scan/resume', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }
    if (typeof runDailyDivergenceScan !== 'function') {
      return res.code(501).send({ error: 'Scan resume endpoint is not enabled' });
    }
    if (typeof getIsScanRunning === 'function' && getIsScanRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof canResumeScan === 'function' && !canResumeScan()) {
      return res.code(409).send({ status: 'no-resume' });
    }

    runDailyDivergenceScan({
      trigger: 'manual-api-resume',
      resume: true,
    })
      .then((summary: Record<string, unknown>) => {
        console.log('Manual divergence scan resume completed:', summary);
      })
      .catch((err: any) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence scan resume failed: ${message}`);
      });

    return res.code(202).send({ status: 'started' });
  });

  app.post('/api/divergence/scan/stop', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }
    if (typeof requestStopScan !== 'function') {
      return res.code(501).send({ error: 'Scan stop endpoint is not enabled' });
    }
    const accepted = requestStopScan();
    if (accepted) return res.code(202).send({ status: 'stop-requested' });
    return res.code(409).send({ status: 'idle' });
  });

  app.post('/api/divergence/table/run', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (
      (typeof getIsScanRunning === 'function' && getIsScanRunning()) ||
      (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) ||
      (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) ||
      (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning())
    ) {
      return res.code(409).send({ status: 'running' });
    }

    if (typeof runDivergenceTableBuild !== 'function') {
      return res.code(501).send({ error: 'Table run endpoint is not enabled' });
    }

    const force = typeof parseBooleanInput === 'function' ? parseBooleanInput((req.body as Record<string, unknown> | undefined)?.force, true) : true;

    runDivergenceTableBuild({
      trigger: 'manual-api',
      force,
    })
      .then((summary: Record<string, unknown>) => {
        console.log('Manual divergence table run completed:', summary);
      })
      .catch((err: any) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence table run failed: ${message}`);
      });

    return res.code(202).send({ status: 'started' });
  });

  app.post('/api/divergence/table/pause', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (typeof requestPauseTableBuild !== 'function') {
      return res.code(501).send({ error: 'Pause endpoint is not enabled' });
    }

    const accepted = requestPauseTableBuild();
    if (accepted) {
      return res.code(202).send({ status: 'pause-requested' });
    }
    if (typeof canResumeTableBuild === 'function' && canResumeTableBuild()) {
      return res.code(200).send({ status: 'paused' });
    }
    return res.code(409).send({ status: 'idle' });
  });

  app.post('/api/divergence/table/resume', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (typeof runDivergenceTableBuild !== 'function') {
      return res.code(501).send({ error: 'Table resume endpoint is not enabled' });
    }

    if (typeof getIsScanRunning === 'function' && getIsScanRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning()) {
      return res.code(409).send({ status: 'running' });
    }
    if (typeof canResumeTableBuild === 'function' && !canResumeTableBuild()) {
      return res.code(409).send({ status: 'no-resume' });
    }

    runDivergenceTableBuild({
      trigger: 'manual-api-resume',
      resume: true,
    })
      .then((summary: Record<string, unknown>) => {
        console.log('Manual divergence table resume completed:', summary);
      })
      .catch((err: any) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence table resume failed: ${message}`);
      });

    return res.code(202).send({ status: 'started' });
  });

  app.post('/api/divergence/table/stop', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (typeof requestStopTableBuild !== 'function') {
      return res.code(501).send({ error: 'Table stop endpoint is not enabled' });
    }
    const accepted = requestStopTableBuild();
    if (accepted) {
      return res.code(202).send({ status: 'stop-requested' });
    }
    return res.code(409).send({ status: 'idle' });
  });

  app.post('/api/divergence/fetch-daily/run', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (
      (typeof getIsScanRunning === 'function' && getIsScanRunning()) ||
      (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) ||
      (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) ||
      (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning())
    ) {
      return res.code(409).send({ status: 'running' });
    }

    if (typeof runDivergenceFetchDailyData !== 'function') {
      return res.code(501).send({ error: 'Fetch-all endpoint is not enabled' });
    }

    const shouldResume = typeof canResumeFetchDailyData === 'function' && canResumeFetchDailyData();

    runDivergenceFetchDailyData({
      trigger: 'manual-api',
      resume: shouldResume,
      force: true,
    })
      .then((summary: Record<string, unknown>) => {
        console.log(`Manual divergence fetch-daily ${shouldResume ? 'resumed' : 'started'}:`, summary);
      })
      .catch((err: any) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence fetch-daily failed: ${message}`);
      });

    return res.code(202).send({ status: shouldResume ? 'resumed' : 'started' });
  });

  app.post('/api/divergence/fetch-daily/stop', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }
    if (typeof requestStopFetchDailyData !== 'function') {
      return res.code(501).send({ error: 'Fetch-all stop endpoint is not enabled' });
    }
    const accepted = requestStopFetchDailyData();
    if (accepted) return res.code(202).send({ status: 'stop-requested' });
    return res.code(409).send({ status: 'idle' });
  });

  app.post('/api/divergence/fetch-weekly/run', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (
      (typeof getIsScanRunning === 'function' && getIsScanRunning()) ||
      (typeof getIsTableBuildRunning === 'function' && getIsTableBuildRunning()) ||
      (typeof getIsFetchDailyDataRunning === 'function' && getIsFetchDailyDataRunning()) ||
      (typeof getIsFetchWeeklyDataRunning === 'function' && getIsFetchWeeklyDataRunning())
    ) {
      return res.code(409).send({ status: 'running' });
    }

    if (typeof runDivergenceFetchWeeklyData !== 'function') {
      return res.code(501).send({ error: 'Fetch-weekly endpoint is not enabled' });
    }

    const shouldResume = typeof canResumeFetchWeeklyData === 'function' && canResumeFetchWeeklyData();

    runDivergenceFetchWeeklyData({
      trigger: 'manual-api',
      resume: shouldResume,
      force: true,
    })
      .then((summary: Record<string, unknown>) => {
        console.log(`Manual divergence fetch-weekly ${shouldResume ? 'resumed' : 'started'}:`, summary);
      })
      .catch((err: any) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual divergence fetch-weekly failed: ${message}`);
      });

    return res.code(202).send({ status: shouldResume ? 'resumed' : 'started' });
  });

  app.post('/api/divergence/fetch-weekly/stop', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }
    if (typeof requestStopFetchWeeklyData !== 'function') {
      return res.code(501).send({ error: 'Fetch-weekly stop endpoint is not enabled' });
    }
    const accepted = requestStopFetchWeeklyData();
    if (accepted) return res.code(202).send({ status: 'stop-requested' });
    return res.code(409).send({ status: 'idle' });
  });

  app.get('/api/divergence/scan/status', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    // In-memory statuses are always available and never fail.
    const tableBuild = typeof getTableBuildStatus === 'function' ? getTableBuildStatus() : null;
    const scanControl = typeof getScanControlStatus === 'function' ? getScanControlStatus() : null;
    const fetchDailyData = typeof getFetchDailyDataStatus === 'function' ? getFetchDailyDataStatus() : null;
    const fetchWeeklyData = typeof getFetchWeeklyDataStatus === 'function' ? getFetchWeeklyDataStatus() : null;

    // The DB query for latestJob can fail under heavy write load
    // (pool connections saturated during fetches). Fall back gracefully.
    let statusPayload;
    try {
      statusPayload = await fetchLatestDivergenceScanStatus({
        divergencePool: divergencePool!,
        divergenceSourceInterval,
        getIsScanRunning,
        getLastFetchedTradeDateEt,
        getLastScanDateEt,
      });
    } catch (err: any) {
      console.error('Scan status DB query failed (returning in-memory status):', err.message);
      statusPayload = {
        running: getIsScanRunning(),
        lastScanDateEt: getLastFetchedTradeDateEt() || getLastScanDateEt() || null,
        latestJob: null,
      };
    }

    const vdfScan = typeof getVDFScanStatus === 'function' ? getVDFScanStatus() : null;

    return res.send({
      ...statusPayload,
      scanControl,
      tableBuild,
      fetchDailyData,
      fetchWeeklyData,
      vdfScan,
    });
  });

  app.post('/api/divergence/vdf-scan/run', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }

    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }

    if (typeof getIsVDFScanRunning === 'function' && getIsVDFScanRunning()) {
      return res.code(409).send({ status: 'running' });
    }

    if (typeof runVDFScan !== 'function') {
      return res.code(501).send({ error: 'VDF scan endpoint is not enabled' });
    }

    const shouldResume = typeof canResumeVDFScan === 'function' && canResumeVDFScan();

    runVDFScan({ trigger: 'manual-api', resume: shouldResume })
      .then((summary: Record<string, unknown>) => {
        console.log(`Manual VDF scan ${shouldResume ? 'resumed' : 'started'}:`, summary);
      })
      .catch((err: any) => {
        const message = err && err.message ? err.message : String(err);
        console.error(`Manual VDF scan failed: ${message}`);
      });

    return res.code(202).send({ status: shouldResume ? 'resumed' : 'started' });
  });

  app.post('/api/divergence/vdf-scan/stop', async (req: FastifyRequest, res: FastifyReply) => {
    if (!isDivergenceConfigured()) {
      return res.code(503).send({ error: 'Divergence database is not configured' });
    }
    const configuredSecret = String(divergenceScanSecret || '').trim();
    const providedSecret = String((req.query as Record<string, unknown>).secret || req.headers['x-divergence-secret'] || '').trim();
    if (configuredSecret && configuredSecret !== providedSecret) {
      return res.code(401).send({ error: 'Unauthorized' });
    }
    if (typeof requestStopVDFScan !== 'function') {
      return res.code(501).send({ error: 'VDF scan stop endpoint is not enabled' });
    }
    const accepted = requestStopVDFScan();
    if (accepted) return res.code(202).send({ status: 'stop-requested' });
    return res.code(409).send({ status: 'idle' });
  });
}

export { registerDivergenceRoutes };

interface ManualScanResult {
  ok: true;
  value: { force: boolean; refreshUniverse: boolean; runDateEt?: string };
}

interface ManualScanError {
  ok: false;
  error: string;
}

function buildManualScanRequest(options: {
  req: { query: Record<string, unknown>; body?: Record<string, unknown> };
  parseBooleanInput: (value: unknown, defaultValue: boolean) => boolean;
  parseEtDateInput: (value: unknown) => string | null;
}): ManualScanResult | ManualScanError {
  const { req, parseBooleanInput, parseEtDateInput } = options;

  const force = parseBooleanInput(req.query.force, false) || parseBooleanInput(req.body?.force, false);
  const refreshUniverse =
    parseBooleanInput(req.query.refreshUniverse, false) || parseBooleanInput(req.body?.refreshUniverse, false);

  let runDateEt: string | undefined;
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'runDateEt')) {
    const parsedRunDate = parseEtDateInput(req.body.runDateEt);
    if (!parsedRunDate) {
      return {
        ok: false,
        error: 'runDateEt must be YYYY-MM-DD',
      };
    }
    runDateEt = parsedRunDate;
  }

  return {
    ok: true,
    value: {
      force,
      refreshUniverse,
      runDateEt,
    },
  };
}

async function fetchLatestDivergenceScanStatus(options: {
  divergencePool: { query: (...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  divergenceSourceInterval: string;
  getIsScanRunning: () => boolean;
  getLastFetchedTradeDateEt: () => string;
  getLastScanDateEt: () => string;
}) {
  const { divergencePool, divergenceSourceInterval, getIsScanRunning, getLastFetchedTradeDateEt, getLastScanDateEt } =
    options;

  const latest = await divergencePool.query(`
    SELECT *
    FROM divergence_scan_jobs
    ORDER BY started_at DESC
    LIMIT 1
  `);
  const latestJob = latest.rows[0] || null;

  if (latestJob && !latestJob.scanned_trade_date) {
    const tradeDateResult = await divergencePool.query(
      `
      SELECT MAX(trade_date)::text AS scanned_trade_date
      FROM divergence_signals
      WHERE scan_job_id = $1
        AND timeframe = '1d'
        AND source_interval = $2
    `,
      [latestJob.id, divergenceSourceInterval],
    );
    const fallbackTradeDate = String(tradeDateResult.rows[0]?.scanned_trade_date || '').trim();
    if (fallbackTradeDate) {
      latestJob.scanned_trade_date = fallbackTradeDate;
    }
  }

  const lastScanDateEt =
    getLastFetchedTradeDateEt() || String(latestJob?.scanned_trade_date || '').trim() || getLastScanDateEt() || null;

  return {
    running: getIsScanRunning(),
    lastScanDateEt,
    latestJob,
  };
}

export { buildManualScanRequest, fetchLatestDivergenceScanStatus };

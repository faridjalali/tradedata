/**
 * Parse and validate a manual scan request from the HTTP layer.
 * @param {object} options
 * @param {import('express').Request} options.req - Express request object
 * @param {Function} options.parseBooleanInput - Boolean parser
 * @param {Function} options.parseEtDateInput - ET date parser
 * @returns {{ ok: true, value: { force: boolean, refreshUniverse: boolean, runDateEt?: string } } | { ok: false, error: string }}
 */
function buildManualScanRequest(options) {
  const { req, parseBooleanInput, parseEtDateInput } = options;

  const force = parseBooleanInput(req.query.force, false) || parseBooleanInput(req.body?.force, false);
  const refreshUniverse =
    parseBooleanInput(req.query.refreshUniverse, false) || parseBooleanInput(req.body?.refreshUniverse, false);

  let runDateEt;
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

/**
 * Query the database for the most recent divergence scan job and build a status payload.
 * @param {object} options
 * @param {{ query: Function }} options.divergencePool - PostgreSQL pool
 * @param {string} options.divergenceSourceInterval - Source interval for signal lookup
 * @param {Function} options.getIsScanRunning - Returns current running state
 * @param {Function} options.getLastFetchedTradeDateEt - Returns last fetched trade date
 * @param {Function} options.getLastScanDateEt - Returns last scan date fallback
 * @returns {Promise<{ running: boolean, lastScanDateEt: string|null, latestJob: object|null }>}
 */
async function fetchLatestDivergenceScanStatus(options) {
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

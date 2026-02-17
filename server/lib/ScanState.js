/**
 * ScanState — shared state management for scan-type background jobs.
 *
 * Encapsulates the 5 state variables every scan type needs (running, stopRequested,
 * abortController, resumeState, status) plus lifecycle methods (requestStop, canResume,
 * getStatus, beginRun, markStopped, markCompleted, markFailed, cleanup).
 *
 * Usage:
 *   const scan = new ScanState('vdfScan');
 *   const abort = scan.beginRun(resumeRequested);
 *   // ... process tickers ...
 *   scan.markCompleted({ totalTickers, processedTickers, errorTickers, ... });
 *   scan.cleanup(abort);
 */
class ScanState {
  /**
   * @param {string} name - Unique identifier for this scan type (e.g. 'vdfScan', 'fetchDaily')
   * @param {object} [options]
   * @param {string} [options.metricsKey] - Key for runMetricsByType (defaults to name)
   * @param {function} [options.normalizeResume] - Optional function to normalize resume state
   * @param {function} [options.canResumeValidator] - Optional (resumeState) => boolean validator
   */
  constructor(name, options = {}) {
    this.name = name;
    this.metricsKey = options.metricsKey || name;
    this.running = false;
    this.stopRequested = false;
    this.abortController = null;
    this.resumeState = null;
    this.normalizeResume = options.normalizeResume || null;
    this.canResumeValidator = options.canResumeValidator || null;
    this._status = {
      running: false,
      status: 'idle',
      totalTickers: 0,
      processedTickers: 0,
      errorTickers: 0,
      startedAt: null,
      finishedAt: null
    };
    this._extraStatus = {};
  }

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  /** Whether the scan should stop (stop requested or abort signal fired). */
  get shouldStop() {
    return this.stopRequested || Boolean(this.abortController?.signal?.aborted);
  }

  /** Convenience accessor for the abort signal (or null). */
  get signal() {
    return this.abortController?.signal || null;
  }

  /**
   * Request the scan to stop. Sets stopRequested, updates status to 'stopping',
   * and fires the abort controller.
   * @returns {boolean} true if the stop was accepted (scan was running)
   */
  requestStop() {
    if (!this.running) return false;
    this.stopRequested = true;
    this._status = { ...this._status, status: 'stopping', finishedAt: null };
    if (this.abortController && !this.abortController.signal.aborted) {
      try { this.abortController.abort(); } catch { /* ignore duplicate aborts */ }
    }
    return true;
  }

  /**
   * Check whether the scan can be resumed from a previous stop.
   * Uses canResumeValidator if provided, otherwise does a default check on
   * resumeState.tickers and resumeState.nextIndex.
   * @returns {boolean}
   */
  canResume() {
    if (this.running) return false;
    if (!this.resumeState) return false;
    if (this.canResumeValidator) return this.canResumeValidator(this.resumeState);
    const rs = this.normalizeResume ? this.normalizeResume(this.resumeState) : this.resumeState;
    return Array.isArray(rs.tickers) && rs.tickers.length > 0 && rs.nextIndex < rs.tickers.length;
  }

  /**
   * Return a status object matching the API response shape expected by the client.
   * Extra fields (e.g. detected_tickers, last_published_trade_date) are merged
   * from _extraStatus.
   * @returns {object}
   */
  getStatus() {
    return {
      running: Boolean(this.running),
      stop_requested: Boolean(this.stopRequested),
      can_resume: this.canResume(),
      status: String(this._status.status || 'idle'),
      total_tickers: Number(this._status.totalTickers || 0),
      processed_tickers: Number(this._status.processedTickers || 0),
      error_tickers: Number(this._status.errorTickers || 0),
      started_at: this._status.startedAt || null,
      finished_at: this._status.finishedAt || null,
      ...this._extraStatus
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle methods
  // ---------------------------------------------------------------------------

  /**
   * Begin a new run. Sets running=true, resets stop flag, creates abort controller.
   * If not resuming, clears the resume state.
   * @param {boolean} [resumeRequested=false]
   * @returns {AbortController} the newly created abort controller
   */
  beginRun(resumeRequested = false) {
    this.running = true;
    this.stopRequested = false;
    if (!resumeRequested) this.resumeState = null;
    this.abortController = new AbortController();
    return this.abortController;
  }

  /**
   * Merge fields into the internal status object.
   * @param {object} fields
   */
  setStatus(fields) {
    this._status = { ...this._status, ...fields };
  }

  /**
   * Set scan-type-specific extra status fields that get merged into getStatus().
   * @param {object} fields
   */
  setExtraStatus(fields) {
    this._extraStatus = { ...this._extraStatus, ...fields };
  }

  /**
   * Quick update for processedTickers and errorTickers during a run.
   * Also flips status to 'stopping' if stop was requested.
   * @param {number} processedTickers
   * @param {number} errorTickers
   */
  updateProgress(processedTickers, errorTickers) {
    this._status.processedTickers = processedTickers;
    this._status.errorTickers = errorTickers;
    if (this.stopRequested) this._status.status = 'stopping';
  }

  /**
   * Save resume state with a rewind-by-concurrency safety margin.
   * In-flight workers that got aborted will be re-processed on resume.
   * @param {object} data - Resume data (must include tickers/totalTickers/processedTickers)
   * @param {number} concurrency - Current run concurrency (rewind amount)
   * @returns {number} the safe next index after rewind
   */
  saveResumeState(data, concurrency) {
    const total = data.totalTickers || (Array.isArray(data.tickers) ? data.tickers.length : 0);
    const safeNext = Math.max(0, Math.min(total, (data.processedTickers || 0) - (concurrency || 0)));
    const normalized = { ...data, nextIndex: safeNext, processedTickers: safeNext };
    this.resumeState = this.normalizeResume ? this.normalizeResume(normalized) : normalized;
    return safeNext;
  }

  /**
   * Mark the scan as stopped.
   * @param {object} statusFields - Fields for the status object
   */
  markStopped(statusFields) {
    this.stopRequested = false;
    this._status = { running: false, status: 'stopped', ...statusFields };
  }

  /**
   * Mark the scan as completed. Clears resume state.
   * Auto-detects 'completed-with-errors' if errorTickers > 0.
   * @param {object} statusFields - Fields for the status object
   */
  markCompleted(statusFields) {
    this.resumeState = null;
    this.stopRequested = false;
    const hasErrors = Number(statusFields?.errorTickers || 0) > 0;
    this._status = {
      running: false,
      status: hasErrors ? 'completed-with-errors' : 'completed',
      ...statusFields
    };
  }

  /**
   * Mark the scan as failed. Clears resume state.
   * @param {object} statusFields - Fields for the status object
   */
  markFailed(statusFields) {
    this.resumeState = null;
    this.stopRequested = false;
    this._status = { running: false, status: 'failed', ...statusFields };
  }

  /**
   * Cleanup after a run completes (success, stop, or failure).
   * Clears the abort controller (if it matches the provided ref) and sets running=false.
   * @param {AbortController} [abortRef] - The abort controller from beginRun()
   */
  cleanup(abortRef) {
    if (abortRef && this.abortController === abortRef) {
      this.abortController = null;
    } else if (!abortRef) {
      this.abortController = null;
    }
    this.running = false;
  }

  /**
   * Build the options object expected by registerDivergenceRoutes for this scan type.
   * @param {function} runFn - The async run function
   * @returns {object} { getStatus, requestStop, canResume, run, getIsRunning }
   */
  buildRouteOptions(runFn) {
    return {
      getStatus: () => this.getStatus(),
      requestStop: () => this.requestStop(),
      canResume: () => this.canResume(),
      run: runFn,
      getIsRunning: () => this.running
    };
  }
}

/**
 * Run up to 2 retry passes over failed tickers with progressively reduced concurrency.
 * Pass 1: baseConcurrency / 2, Pass 2: baseConcurrency / 4.
 *
 * @param {object} opts
 * @param {string[]} opts.failedTickers - Tickers that failed in the main pass
 * @param {number} opts.baseConcurrency - Original run concurrency
 * @param {function} opts.worker - async (ticker) => { ticker, result?, error?, skipped? }
 * @param {function} [opts.onRecovered] - Called when a retry succeeds
 * @param {function} [opts.onStillFailed] - Called when a retry still fails
 * @param {function} [opts.shouldStop] - () => boolean, checked before each pass
 * @param {object} [opts.metricsTracker] - Run metrics tracker with setPhase/recordRetryRecovered
 * @param {function} opts.mapWithConcurrency - The mapWithConcurrency function
 * @returns {Promise<string[]>} Tickers that still failed after all retries
 */
async function runRetryPasses({
  failedTickers,
  baseConcurrency,
  worker,
  onRecovered,
  onStillFailed,
  shouldStop,
  metricsTracker,
  mapWithConcurrency
}) {
  if (!failedTickers || failedTickers.length === 0) return [];

  let stillFailed = [...failedTickers];

  for (let pass = 1; pass <= 2; pass++) {
    if (stillFailed.length === 0) break;
    if (typeof shouldStop === 'function' && shouldStop()) break;

    const retryBatch = [...stillFailed];
    stillFailed = [];
    const divisor = pass === 1 ? 2 : 4;
    const retryConcurrency = Math.max(1, Math.floor(baseConcurrency / divisor));
    const phase = pass === 1 ? 'retry' : 'retry-2';

    if (metricsTracker) metricsTracker.setPhase(phase);

    await mapWithConcurrency(
      retryBatch,
      retryConcurrency,
      worker,
      (settled) => {
        if (settled.skipped) return;
        if (settled.error) {
          stillFailed.push(settled.ticker);
          if (onStillFailed) onStillFailed(settled);
        } else {
          if (onRecovered) onRecovered(settled);
          if (metricsTracker) metricsTracker.recordRetryRecovered(settled.ticker);
        }
      },
      shouldStop
    );
  }

  return stillFailed;
}

export { ScanState, runRetryPasses };

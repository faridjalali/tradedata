/**
 * ScanState — shared state management for scan-type background jobs.
 *
 * All mutable fields are private. Orchestrators interact through the
 * public API methods (beginRun, setStatus, replaceStatus, cleanup, …).
 */

/** Options for constructing a ScanState instance. */
interface ScanStateOptions {
  metricsKey?: string;
  normalizeResume?: (data: Record<string, unknown>) => Record<string, unknown>;
  canResumeValidator?: (resumeState: Record<string, unknown>) => boolean;
}

/** Status fields maintained by a ScanState instance. */
interface ScanStatusFields {
  running?: boolean;
  status?: string;
  totalTickers?: number;
  processedTickers?: number;
  errorTickers?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** Domain-specific field used by fetch-daily/weekly orchestrators. */
  lastPublishedTradeDate?: string;
  [key: string]: unknown;
}

/**
 * Common shape returned by every scan worker function used with runRetryPasses.
 *
 * Workers must handle their own exceptions and return the error in the `error`
 * field rather than throwing, so that the ticker can be tracked for retry.
 * Callers that need to access the `result` field should narrow with a type
 * assertion at the call site.
 */
interface TickerWorkerSettled {
  ticker: string;
  result?: unknown;
  error?: unknown;
  skipped?: boolean;
}

/** Concurrency divisors applied on each retry pass (pass 1 = /2, pass 2 = /4). */
const RETRY_PASS_DIVISORS = [2, 4] as const;

class ScanState {
  readonly name: string;
  readonly metricsKey: string;

  private _running: boolean;
  private _stopRequested: boolean;
  private _abortController: AbortController | null;
  private _resumeState: Record<string, unknown> | null;
  private _normalizeResume: ((data: Record<string, unknown>) => Record<string, unknown>) | null;
  private _canResumeValidator: ((resumeState: Record<string, unknown>) => boolean) | null;
  private _status: ScanStatusFields;
  private _extraStatus: Record<string, unknown>;

  constructor(name: string, options: ScanStateOptions = {}) {
    this.name = name;
    this.metricsKey = options.metricsKey || name;
    this._running = false;
    this._stopRequested = false;
    this._abortController = null;
    this._resumeState = null;
    this._normalizeResume = options.normalizeResume || null;
    this._canResumeValidator = options.canResumeValidator || null;
    this._status = {
      running: false,
      status: 'idle',
      totalTickers: 0,
      processedTickers: 0,
      errorTickers: 0,
      startedAt: null,
      finishedAt: null,
    };
    this._extraStatus = {};
  }

  // ---------------------------------------------------------------------------
  // Read-only accessors
  // ---------------------------------------------------------------------------

  /** True while a scan job owns this state object. */
  get isRunning(): boolean {
    return this._running;
  }

  /** True if requestStop() was called and the job has not yet acknowledged it. */
  get isStopping(): boolean {
    return this._stopRequested;
  }

  /** True if stop was requested OR the AbortController signal was aborted. */
  get shouldStop(): boolean {
    return this._stopRequested || Boolean(this._abortController?.signal?.aborted);
  }

  /** The AbortSignal for the current run, or null if not running. */
  get signal(): AbortSignal | null {
    return this._abortController?.signal || null;
  }

  /** The resume state persisted between runs, or null. */
  get currentResumeState(): Record<string, unknown> | null {
    return this._resumeState;
  }

  /** Returns a shallow-copy snapshot of the current status fields. */
  readStatus(): Readonly<ScanStatusFields> {
    return { ...this._status };
  }

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  /**
   * Signal the running job to stop. Aborts the AbortController and sets the
   * isStopping flag. Returns false if not currently running.
   */
  requestStop(): boolean {
    if (!this._running) return false;
    this._stopRequested = true;
    this._status = { ...this._status, status: 'stopping', finishedAt: null };
    if (this._abortController && !this._abortController.signal.aborted) {
      try {
        this._abortController.abort();
      } catch {
        /* ignore duplicate aborts */
      }
    }
    return true;
  }

  /**
   * Returns true if a resume is possible: not currently running, resume state
   * exists, and either the custom validator passes or the default tickers-array
   * check succeeds.
   */
  canResume(): boolean {
    if (this._running) return false;
    if (!this._resumeState) return false;
    if (this._canResumeValidator) return this._canResumeValidator(this._resumeState);
    const rs = this._normalizeResume ? this._normalizeResume(this._resumeState) : this._resumeState;
    return Array.isArray(rs.tickers) && rs.tickers.length > 0 && Number(rs.nextIndex) < rs.tickers.length;
  }

  /** Returns the combined status object used by route handlers for polling. */
  getStatus(): {
    running: boolean;
    stop_requested: boolean;
    can_resume: boolean;
    status: string;
    total_tickers: number;
    processed_tickers: number;
    error_tickers: number;
    started_at: string | null;
    finished_at: string | null;
    [key: string]: unknown;
  } {
    return {
      running: Boolean(this._running),
      stop_requested: Boolean(this._stopRequested),
      can_resume: this.canResume(),
      status: String(this._status.status || 'idle'),
      total_tickers: Number(this._status.totalTickers || 0),
      processed_tickers: Number(this._status.processedTickers || 0),
      error_tickers: Number(this._status.errorTickers || 0),
      started_at: this._status.startedAt || null,
      finished_at: this._status.finishedAt || null,
      ...this._extraStatus,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle methods
  // ---------------------------------------------------------------------------

  /**
   * Begin a new run. Creates a fresh AbortController, resets transient flags,
   * and clears resume state unless resumeRequested is true.
   * Returns the AbortController so the orchestrator can pass its signal to workers.
   */
  beginRun(resumeRequested = false): AbortController {
    this._running = true;
    this._stopRequested = false;
    if (!resumeRequested) this._resumeState = null;
    this._abortController = new AbortController();
    return this._abortController;
  }

  /** Merge fields into the current status (non-destructive). */
  setStatus(fields: ScanStatusFields): void {
    this._status = { ...this._status, ...fields };
  }

  /**
   * Completely replace the status object (not a merge).
   * Use only for terminal state transitions (stopped, completed, failed).
   */
  replaceStatus(fields: ScanStatusFields): void {
    this._status = { ...fields };
  }

  /** Merge extra domain-specific fields into the status returned by getStatus(). */
  setExtraStatus(fields: Record<string, unknown>): void {
    this._extraStatus = { ...this._extraStatus, ...fields };
  }

  /** Update processedTickers and errorTickers; marks status as 'stopping' if stop was requested. */
  updateProgress(processedTickers: number, errorTickers: number): void {
    this._status.processedTickers = processedTickers;
    this._status.errorTickers = errorTickers;
    if (this._stopRequested) this._status.status = 'stopping';
  }

  /**
   * Compute a safe resume nextIndex (adjusted for in-flight workers) and persist
   * the resume state. Returns the safe nextIndex value.
   */
  saveResumeState(data: Record<string, unknown>, concurrency: number): number {
    const total = Number(data.totalTickers) || (Array.isArray(data.tickers) ? data.tickers.length : 0);
    const safeNext = Math.max(0, Math.min(total, Number(data.processedTickers || 0) - concurrency));
    const normalized: Record<string, unknown> = { ...data, nextIndex: safeNext, processedTickers: safeNext };
    this._resumeState = this._normalizeResume ? this._normalizeResume(normalized) : normalized;
    return safeNext;
  }

  /** Directly set (or clear) the resume state for mid-run persistence. */
  setResumeState(data: Record<string, unknown> | null): void {
    this._resumeState = data;
  }

  /** Late-bind the resume-state normalizer (call during app startup after imports settle). */
  setNormalizeResume(fn: (data: Record<string, unknown>) => Record<string, unknown>): void {
    this._normalizeResume = fn;
  }

  /** Late-bind the resume-state validator (call during app startup after imports settle). */
  setCanResumeValidator(fn: (resumeState: Record<string, unknown>) => boolean): void {
    this._canResumeValidator = fn;
  }

  /** Manually set the stop-requested flag. Prefer requestStop() for external stop signals. */
  setStopRequested(val: boolean): void {
    this._stopRequested = val;
  }

  /**
   * Replace the AbortController reference.
   * Prefer beginRun() which creates a fresh one automatically.
   */
  setAbortControllerRef(c: AbortController | null): void {
    this._abortController = c;
  }

  /** Returns true if the stored AbortController is the same object reference as `c`. */
  hasAbortController(c: AbortController): boolean {
    return this._abortController === c;
  }

  /** Transition to the 'stopped' terminal state and clear the stop-requested flag. */
  markStopped(statusFields: ScanStatusFields): void {
    this._stopRequested = false;
    this._status = { running: false, status: 'stopped', ...statusFields };
  }

  /**
   * Transition to the 'completed' (or 'completed-with-errors') terminal state.
   * Clears resume state and the stop-requested flag.
   */
  markCompleted(statusFields: ScanStatusFields): void {
    this._resumeState = null;
    this._stopRequested = false;
    const hasErrors = Number(statusFields?.errorTickers || 0) > 0;
    this._status = {
      running: false,
      status: hasErrors ? 'completed-with-errors' : 'completed',
      ...statusFields,
    };
  }

  /** Transition to the 'failed' terminal state. Clears resume state and stop-requested flag. */
  markFailed(statusFields: ScanStatusFields): void {
    this._resumeState = null;
    this._stopRequested = false;
    this._status = { running: false, status: 'failed', ...statusFields };
  }

  /**
   * Clear the running flag and, if the provided AbortController reference matches
   * the stored one, clear it too. Always call this in a finally block.
   */
  cleanup(abortRef?: AbortController): void {
    if (abortRef && this._abortController === abortRef) {
      this._abortController = null;
    } else if (!abortRef) {
      this._abortController = null;
    }
    this._running = false;
  }

  /**
   * Build the options object consumed by route handlers for a given background job.
   * Binds getStatus, requestStop, canResume, and the run function to this instance.
   */
  buildRouteOptions(runFn: (options?: Record<string, unknown>) => Promise<unknown>) {
    return {
      getStatus: () => this.getStatus(),
      requestStop: () => this.requestStop(),
      canResume: () => this.canResume(),
      run: runFn,
      getIsRunning: () => this.isRunning,
    };
  }
}

interface RunRetryPassesOptions<TSettled extends TickerWorkerSettled> {
  failedTickers: string[];
  baseConcurrency: number;
  /**
   * The same worker function used in the main scan pass.
   * Workers MUST catch their own exceptions and return the error in the `error`
   * field — never throw — so that the ticker can be tracked for retry.
   */
  worker: (ticker: string) => Promise<TSettled>;
  /** Called for each ticker that succeeds on a retry pass. */
  onRecovered?: (settled: TSettled) => void;
  /** Called for each ticker that still fails after a retry pass. */
  onStillFailed?: (settled: TSettled) => void;
  shouldStop?: () => boolean;
  metricsTracker?: { setPhase: (phase: string) => void; recordRetryRecovered: (ticker: string) => void };
  mapWithConcurrency: <T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
    onSettled?: (result: R | { error: unknown }, index: number, item: T) => void,
    shouldStop?: () => boolean,
  ) => Promise<Array<R | { error: unknown }>>;
}

/**
 * Run up to two retry passes over a list of failed tickers with progressively
 * reduced concurrency (pass 1 = baseConcurrency / 2, pass 2 = / 4).
 * Returns the list of tickers that still failed after all retry passes.
 */
async function runRetryPasses<TSettled extends TickerWorkerSettled>({
  failedTickers,
  baseConcurrency,
  worker,
  onRecovered,
  onStillFailed,
  shouldStop,
  metricsTracker,
  mapWithConcurrency,
}: RunRetryPassesOptions<TSettled>): Promise<string[]> {
  if (!failedTickers || failedTickers.length === 0) return [];

  let stillFailed = [...failedTickers];

  for (let pass = 0; pass < RETRY_PASS_DIVISORS.length; pass++) {
    if (stillFailed.length === 0) break;
    if (typeof shouldStop === 'function' && shouldStop()) break;

    const retryBatch = [...stillFailed];
    stillFailed = [];
    const retryConcurrency = Math.max(1, Math.floor(baseConcurrency / RETRY_PASS_DIVISORS[pass]));
    const phase = pass === 0 ? 'retry' : 'retry-2';

    if (metricsTracker) metricsTracker.setPhase(phase);

    await mapWithConcurrency(
      retryBatch,
      retryConcurrency,
      worker,
      (settled) => {
        // Workers must handle their own exceptions. If one unexpectedly throws,
        // mapWithConcurrency returns { error } with no ticker — skip it.
        if (!settled || !('ticker' in settled)) return;
        const s = settled as TSettled;
        if (s.skipped) return;
        if (s.error) {
          stillFailed.push(s.ticker);
          if (onStillFailed) onStillFailed(s);
        } else {
          if (onRecovered) onRecovered(s);
          if (metricsTracker) metricsTracker.recordRetryRecovered(s.ticker);
        }
      },
      shouldStop,
    );
  }

  return stillFailed;
}

export { ScanState, runRetryPasses };
export type { ScanStateOptions, ScanStatusFields, TickerWorkerSettled };

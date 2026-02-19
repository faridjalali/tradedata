/**
 * ScanState — shared state management for scan-type background jobs.
 *
 * All mutable fields are private. Orchestrators interact through the
 * public API methods (beginRun, setStatus, replaceStatus, cleanup, …).
 */

interface ScanStateOptions {
  metricsKey?: string;
  normalizeResume?: (data: Record<string, any>) => Record<string, any>;
  canResumeValidator?: (resumeState: Record<string, any>) => boolean;
}

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
  [key: string]: any;
}

class ScanState {
  readonly name: string;
  readonly metricsKey: string;

  private _running: boolean;
  private _stopRequested: boolean;
  private _abortController: AbortController | null;
  private _resumeState: Record<string, any> | null;
  private _normalizeResume: ((data: Record<string, any>) => Record<string, any>) | null;
  private _canResumeValidator: ((resumeState: Record<string, any>) => boolean) | null;
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
  get currentResumeState(): Record<string, any> | null {
    return this._resumeState;
  }

  /** Read-only snapshot of the current status fields (shallow copy). */
  readStatus(): Readonly<ScanStatusFields> {
    return { ...this._status };
  }

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

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

  canResume(): boolean {
    if (this._running) return false;
    if (!this._resumeState) return false;
    if (this._canResumeValidator) return this._canResumeValidator(this._resumeState);
    const rs = this._normalizeResume ? this._normalizeResume(this._resumeState) : this._resumeState;
    return Array.isArray(rs.tickers) && rs.tickers.length > 0 && rs.nextIndex < rs.tickers.length;
  }

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
   * Begin a new run. Creates a fresh AbortController and resets transient
   * flags. Returns the AbortController so the orchestrator can pass its
   * signal to workers.
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
   * Use for terminal state transitions (stopped, completed, failed).
   */
  replaceStatus(fields: ScanStatusFields): void {
    this._status = { ...fields };
  }

  setExtraStatus(fields: Record<string, unknown>): void {
    this._extraStatus = { ...this._extraStatus, ...fields };
  }

  updateProgress(processedTickers: number, errorTickers: number): void {
    this._status.processedTickers = processedTickers;
    this._status.errorTickers = errorTickers;
    if (this._stopRequested) this._status.status = 'stopping';
  }

  saveResumeState(data: Record<string, any>, concurrency: number): number {
    const total = data.totalTickers || (Array.isArray(data.tickers) ? data.tickers.length : 0);
    const safeNext = Math.max(0, Math.min(total, (data.processedTickers || 0) - (concurrency || 0)));
    const normalized = { ...data, nextIndex: safeNext, processedTickers: safeNext };
    this._resumeState = this._normalizeResume ? this._normalizeResume(normalized) : normalized;
    return safeNext;
  }

  /** Directly set (or clear) the resume state for mid-run persistence. */
  setResumeState(data: Record<string, any> | null): void {
    this._resumeState = data;
  }

  /** Set the running flag. Prefer cleanup() at the end of a run. */
  setRunning(val: boolean): void {
    this._running = val;
  }

  /** Late-bind the resume-state normalizer (call during app startup). */
  setNormalizeResume(fn: (data: Record<string, any>) => Record<string, any>): void {
    this._normalizeResume = fn;
  }

  /** Late-bind the resume-state validator (call during app startup). */
  setCanResumeValidator(fn: (resumeState: Record<string, any>) => boolean): void {
    this._canResumeValidator = fn;
  }

  /** Clear or set the stop-requested flag. */
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

  /** Returns true if the stored controller is the same object reference as `c`. */
  hasAbortController(c: AbortController): boolean {
    return this._abortController === c;
  }

  markStopped(statusFields: ScanStatusFields): void {
    this._stopRequested = false;
    this._status = { running: false, status: 'stopped', ...statusFields };
  }

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

  markFailed(statusFields: ScanStatusFields): void {
    this._resumeState = null;
    this._stopRequested = false;
    this._status = { running: false, status: 'failed', ...statusFields };
  }

  cleanup(abortRef?: AbortController): void {
    if (abortRef && this._abortController === abortRef) {
      this._abortController = null;
    } else if (!abortRef) {
      this._abortController = null;
    }
    this._running = false;
  }

  buildRouteOptions(runFn: (options?: Record<string, unknown>) => Promise<unknown>) {
    return {
      getStatus: () => this.getStatus(),
      requestStop: () => this.requestStop(),
      canResume: () => this.canResume(),
      run: runFn,
      getIsRunning: () => this._running,
    };
  }
}

interface RunRetryPassesOptions {
  failedTickers: string[];
  baseConcurrency: number;
  worker: (ticker: string) => Promise<Record<string, any>>;
  onRecovered?: (settled: Record<string, any>) => void;
  onStillFailed?: (settled: Record<string, any>) => void;
  shouldStop?: () => boolean;
  metricsTracker?: { setPhase: (phase: string) => void; recordRetryRecovered: (ticker: string) => void };
  mapWithConcurrency: <T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>, onSettled?: (result: R | { error: unknown }, index: number, item: T) => void, shouldStop?: () => boolean) => Promise<Array<R | { error: unknown }>>;
}

async function runRetryPasses({
  failedTickers,
  baseConcurrency,
  worker,
  onRecovered,
  onStillFailed,
  shouldStop,
  metricsTracker,
  mapWithConcurrency,
}: RunRetryPassesOptions): Promise<string[]> {
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
        const s = settled as Record<string, any>;
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
export type { ScanStateOptions, ScanStatusFields };

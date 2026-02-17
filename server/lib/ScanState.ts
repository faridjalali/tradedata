/**
 * ScanState — shared state management for scan-type background jobs.
 */

interface ScanStateOptions {
  metricsKey?: string;
  normalizeResume?: (data: any) => any;
  canResumeValidator?: (resumeState: any) => boolean;
}

interface ScanStatusFields {
  running?: boolean;
  status?: string;
  totalTickers?: number;
  processedTickers?: number;
  errorTickers?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  [key: string]: any;
}

class ScanState {
  name: string;
  metricsKey: string;
  running: boolean;
  stopRequested: boolean;
  abortController: AbortController | null;
  resumeState: any;
  normalizeResume: ((data: any) => any) | null;
  canResumeValidator: ((resumeState: any) => boolean) | null;
  _status: ScanStatusFields;
  _extraStatus: Record<string, any>;

  constructor(name: string, options: ScanStateOptions = {}) {
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
      finishedAt: null,
    };
    this._extraStatus = {};
  }

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  get shouldStop(): boolean {
    return this.stopRequested || Boolean(this.abortController?.signal?.aborted);
  }

  get signal(): AbortSignal | null {
    return this.abortController?.signal || null;
  }

  requestStop(): boolean {
    if (!this.running) return false;
    this.stopRequested = true;
    this._status = { ...this._status, status: 'stopping', finishedAt: null };
    if (this.abortController && !this.abortController.signal.aborted) {
      try {
        this.abortController.abort();
      } catch {
        /* ignore duplicate aborts */
      }
    }
    return true;
  }

  canResume(): boolean {
    if (this.running) return false;
    if (!this.resumeState) return false;
    if (this.canResumeValidator) return this.canResumeValidator(this.resumeState);
    const rs = this.normalizeResume ? this.normalizeResume(this.resumeState) : this.resumeState;
    return Array.isArray(rs.tickers) && rs.tickers.length > 0 && rs.nextIndex < rs.tickers.length;
  }

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
      ...this._extraStatus,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle methods
  // ---------------------------------------------------------------------------

  beginRun(resumeRequested = false): AbortController {
    this.running = true;
    this.stopRequested = false;
    if (!resumeRequested) this.resumeState = null;
    this.abortController = new AbortController();
    return this.abortController;
  }

  setStatus(fields: ScanStatusFields): void {
    this._status = { ...this._status, ...fields };
  }

  setExtraStatus(fields: Record<string, any>): void {
    this._extraStatus = { ...this._extraStatus, ...fields };
  }

  updateProgress(processedTickers: number, errorTickers: number): void {
    this._status.processedTickers = processedTickers;
    this._status.errorTickers = errorTickers;
    if (this.stopRequested) this._status.status = 'stopping';
  }

  saveResumeState(data: any, concurrency: number): number {
    const total = data.totalTickers || (Array.isArray(data.tickers) ? data.tickers.length : 0);
    const safeNext = Math.max(0, Math.min(total, (data.processedTickers || 0) - (concurrency || 0)));
    const normalized = { ...data, nextIndex: safeNext, processedTickers: safeNext };
    this.resumeState = this.normalizeResume ? this.normalizeResume(normalized) : normalized;
    return safeNext;
  }

  markStopped(statusFields: any): void {
    this.stopRequested = false;
    this._status = { running: false, status: 'stopped', ...statusFields };
  }

  markCompleted(statusFields: any): void {
    this.resumeState = null;
    this.stopRequested = false;
    const hasErrors = Number(statusFields?.errorTickers || 0) > 0;
    this._status = {
      running: false,
      status: hasErrors ? 'completed-with-errors' : 'completed',
      ...statusFields,
    };
  }

  markFailed(statusFields: any): void {
    this.resumeState = null;
    this.stopRequested = false;
    this._status = { running: false, status: 'failed', ...statusFields };
  }

  cleanup(abortRef?: AbortController): void {
    if (abortRef && this.abortController === abortRef) {
      this.abortController = null;
    } else if (!abortRef) {
      this.abortController = null;
    }
    this.running = false;
  }

  buildRouteOptions(runFn: Function) {
    return {
      getStatus: () => this.getStatus(),
      requestStop: () => this.requestStop(),
      canResume: () => this.canResume(),
      run: runFn,
      getIsRunning: () => this.running,
    };
  }
}

interface RunRetryPassesOptions {
  failedTickers: string[];
  baseConcurrency: number;
  worker: (ticker: string) => Promise<any>;
  onRecovered?: (settled: any) => void;
  onStillFailed?: (settled: any) => void;
  shouldStop?: () => boolean;
  metricsTracker?: { setPhase: Function; recordRetryRecovered: Function };
  mapWithConcurrency: Function;
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
      (settled: any) => {
        if (settled.skipped) return;
        if (settled.error) {
          stillFailed.push(settled.ticker);
          if (onStillFailed) onStillFailed(settled);
        } else {
          if (onRecovered) onRecovered(settled);
          if (metricsTracker) metricsTracker.recordRetryRecovered(settled.ticker);
        }
      },
      shouldStop,
    );
  }

  return stillFailed;
}

export { ScanState, runRetryPasses };

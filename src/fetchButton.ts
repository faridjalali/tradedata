/**
 * FetchButton — reusable lifecycle abstraction for settings panel "fetch"
 * buttons.  Each button has a run button, a stop icon button, and a status
 * span.  This module handles DOM wiring, click handlers, status updates,
 * and integration with the shared polling loop.
 *
 * Adding a new button requires only a FetchButtonConfig object.
 */

import type { DivergenceScanStatus } from './divergenceApi';
import { toStatusTextFromError } from './divergenceScanStatusFormat';
import { STOP_ICON_SVG } from './utils';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

interface UnifiedStatusSource {
  kind: 'unified';
  isRunning: (s: DivergenceScanStatus) => boolean;
  isStopRequested: (s: DivergenceScanStatus) => boolean;
  canResume: (s: DivergenceScanStatus) => boolean;
  formatStatus: (s: DivergenceScanStatus) => string;
}

interface StandaloneStatusSource {
  kind: 'standalone';
  statusUrl: string;
  isRunning: (d: Record<string, unknown>) => boolean;
  formatStatus: (d: Record<string, unknown>) => string;
}

type StatusSource = UnifiedStatusSource | StandaloneStatusSource;

interface AutoRefreshConfig {
  /** Refresh specific timeframe ('1d'/'1w'). Omit for full overview. */
  timeframe?: '1d' | '1w';
  /** Extract processed count from unified status for incremental refresh. */
  getProcessedTickers?: (s: DivergenceScanStatus) => number;
}

interface LabelConfig {
  idle: string;
  resume?: string;
}

export interface FetchButtonConfig {
  key: string;
  dom: {
    runButtonId: string;
    stopButtonId: string;
    statusId: string;
  };
  label: LabelConfig;
  stopAriaLabel: string;
  start: () => Promise<{ status: string }>;
  stop: () => Promise<{ status: string }>;
  statusSource: StatusSource;
  autoRefresh?: AutoRefreshConfig;
}

// ---------------------------------------------------------------------------
// FetchButton class
// ---------------------------------------------------------------------------

export class FetchButton {
  readonly key: string;
  readonly config: FetchButtonConfig;

  // Cached DOM references (resolved lazily)
  private _runBtn: HTMLButtonElement | null | undefined;
  private _stopBtn: HTMLButtonElement | null | undefined;
  private _statusEl: HTMLElement | null | undefined;

  // Per-button state
  private _running = false;
  private _allowAutoRefresh = false;
  private _lastProcessedTickers = -1;

  constructor(config: FetchButtonConfig) {
    this.key = config.key;
    this.config = config;
  }

  // --- DOM accessors (lazy, cached) ---

  private get runBtn(): HTMLButtonElement | null {
    if (this._runBtn === undefined) {
      this._runBtn = document.getElementById(this.config.dom.runButtonId) as HTMLButtonElement | null;
    }
    return this._runBtn;
  }

  private get stopBtn(): HTMLButtonElement | null {
    if (this._stopBtn === undefined) {
      this._stopBtn = document.getElementById(this.config.dom.stopButtonId) as HTMLButtonElement | null;
    }
    return this._stopBtn;
  }

  private get statusEl(): HTMLElement | null {
    if (this._statusEl === undefined) {
      this._statusEl = document.getElementById(this.config.dom.statusId);
    }
    return this._statusEl;
  }

  // --- Public getters ---

  get running(): boolean {
    return this._running;
  }

  get allowAutoRefresh(): boolean {
    return this._allowAutoRefresh;
  }

  // --- DOM state setters ---

  setButtonState(running: boolean, canResume = false): void {
    const btn = this.runBtn;
    if (!btn) return;
    btn.disabled = running;
    btn.classList.toggle('active', running);
    if (canResume && !running && this.config.label.resume) {
      btn.textContent = this.config.label.resume;
    } else {
      btn.textContent = this.config.label.idle;
    }
  }

  setStatusText(text: string): void {
    const el = this.statusEl;
    if (!el) return;
    el.textContent = text;
  }

  setStopButtonState(running: boolean, stopRequested = false): void {
    const btn = this.stopBtn;
    if (!btn) return;
    btn.innerHTML = STOP_ICON_SVG;
    btn.disabled = !running || stopRequested;
    btn.classList.toggle('active', running);
    btn.setAttribute('aria-label', this.config.stopAriaLabel);
  }

  // --- Click handler wiring ---

  wireClickHandlers(
    onBeforeStart: () => void,
    onAfterStart: () => void,
  ): void {
    this.runBtn?.addEventListener('click', () => {
      void this.handleRun(onBeforeStart, onAfterStart);
    });
    this.stopBtn?.addEventListener('click', () => {
      void this.handleStop();
    });
  }

  private async handleRun(
    onBeforeStart: () => void,
    onAfterStart: () => void,
  ): Promise<void> {
    this.setButtonState(true);
    this.setStatusText('Starting...');
    this.setStopButtonState(false);
    this._allowAutoRefresh = Boolean(this.config.autoRefresh);
    onBeforeStart();
    try {
      const result = await this.config.start();
      if (result.status === 'running' || result.status === 'already_running') {
        this.setStatusText('Already running');
      } else if (result.status === 'resumed') {
        this.setStatusText('Resuming');
      }
      this.setStopButtonState(true);
      onAfterStart();
    } catch (error: unknown) {
      console.error(`Failed to start ${this.key}:`, error);
      this.setButtonState(false);
      this.setStatusText(toStatusTextFromError(error));
    }
  }

  private async handleStop(): Promise<void> {
    try {
      const result = await this.config.stop();
      if (result.status === 'stop-requested') {
        this.setStatusText('Stopping...');
      }
      this._allowAutoRefresh = false;
      // For standalone buttons, re-fetch status immediately so UI updates
      if (this.config.statusSource.kind === 'standalone') {
        await this.updateFromStandaloneStatus();
      }
    } catch (error: unknown) {
      console.error(`Failed to stop ${this.key}:`, error);
      this.setStatusText(toStatusTextFromError(error));
    }
  }

  // --- Status updates (called from polling loop) ---

  updateFromUnifiedStatus(status: DivergenceScanStatus): boolean {
    const src = this.config.statusSource;
    if (src.kind !== 'unified') return this._running;
    const running = src.isRunning(status);
    const canResume = src.canResume(status);
    const stopRequested = src.isStopRequested(status);
    this._running = running;
    this.setButtonState(running, canResume);
    this.setStatusText(src.formatStatus(status));
    this.setStopButtonState(running, stopRequested);
    return running;
  }

  async updateFromStandaloneStatus(): Promise<boolean> {
    const src = this.config.statusSource;
    if (src.kind !== 'standalone') return this._running;
    try {
      const res = await fetch(src.statusUrl);
      const data = (await res.json()) as Record<string, unknown>;
      const running = src.isRunning(data);
      this._running = running;
      this.setButtonState(running);
      this.setStatusText(src.formatStatus(data));
      this.setStopButtonState(running);
      return running;
    } catch {
      /* silent — standalone status is non-critical */
      return this._running;
    }
  }

  // --- Auto-refresh helpers ---

  checkAutoRefresh(status: DivergenceScanStatus): {
    timeframe?: '1d' | '1w';
    progressed: boolean;
  } | null {
    if (!this._running || !this._allowAutoRefresh || !this.config.autoRefresh) {
      this._lastProcessedTickers = -1;
      return null;
    }
    const ar = this.config.autoRefresh;
    let progressed = false;
    if (ar.getProcessedTickers) {
      const processed = ar.getProcessedTickers(status);
      progressed = processed !== this._lastProcessedTickers;
      this._lastProcessedTickers = processed;
    }
    return { timeframe: ar.timeframe, progressed };
  }

  resetAutoRefresh(): void {
    this._allowAutoRefresh = false;
    this._lastProcessedTickers = -1;
  }

  suppressAutoRefresh(): void {
    this._allowAutoRefresh = false;
  }

  resetOnError(): void {
    this._running = false;
    this.setButtonState(false, false);
    this.setStopButtonState(false);
    this._allowAutoRefresh = false;
    this._lastProcessedTickers = -1;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const fetchButtonRegistry: FetchButton[] = [];

export function registerFetchButton(config: FetchButtonConfig): FetchButton {
  const button = new FetchButton(config);
  fetchButtonRegistry.push(button);
  return button;
}

export function getFetchButtons(): readonly FetchButton[] {
  return fetchButtonRegistry;
}

export function getFetchButton(key: string): FetchButton | undefined {
  return fetchButtonRegistry.find((b) => b.key === key);
}

// ---------------------------------------------------------------------------
// Bulk operations (called by the polling loop in divergenceScanControl.ts)
// ---------------------------------------------------------------------------

export async function updateAllFetchButtons(
  unifiedStatus: DivergenceScanStatus,
): Promise<boolean> {
  let anyRunning = false;
  const standalonePromises: Promise<boolean>[] = [];
  for (const btn of fetchButtonRegistry) {
    if (btn.config.statusSource.kind === 'unified') {
      if (btn.updateFromUnifiedStatus(unifiedStatus)) anyRunning = true;
    } else {
      standalonePromises.push(btn.updateFromStandaloneStatus());
    }
  }
  const results = await Promise.all(standalonePromises);
  if (results.some(Boolean)) anyRunning = true;
  return anyRunning;
}

export function resetAllFetchButtonsOnError(): void {
  for (const btn of fetchButtonRegistry) {
    btn.resetOnError();
  }
}

export function resetAllAutoRefresh(): void {
  for (const btn of fetchButtonRegistry) {
    btn.resetAutoRefresh();
  }
}

export function wireAllFetchButtons(
  ensurePolling: () => void,
  pollNow: () => Promise<void>,
): void {
  for (const btn of fetchButtonRegistry) {
    btn.wireClickHandlers(
      () => {
        for (const other of fetchButtonRegistry) {
          if (other !== btn) other.suppressAutoRefresh();
        }
      },
      () => {
        ensurePolling();
        void pollNow();
      },
    );
  }
}

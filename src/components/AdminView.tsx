import { useEffect, useState, useCallback } from 'preact/hooks';
import type { AdminStatusPayload, RunMetricsPayload, RunMetricsSnapshot } from '../../shared/api-types';
import { initFetchButtons, syncDivergenceScanUiState } from '../divergenceScanControl';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN_POLL_INTERVAL_MS = 10_000;
const HISTORY_PAGE_SIZE = 8;

// ---------------------------------------------------------------------------
// Helpers (ported from admin.ts / logs.ts)
// ---------------------------------------------------------------------------
function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtNumber(value: unknown, digits = 0): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

function fmtStatus(value: unknown): string {
  const s = String(value || 'idle');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtIsoToLocal(value: unknown): string {
  if (!value) return '--';
  try {
    return new Date(String(value)).toLocaleString();
  } catch {
    return '--';
  }
}

function statusClass(ok: boolean | null | undefined): string {
  if (ok === true) return 'admin-status-ok';
  if (ok === false) return 'admin-status-error';
  return 'admin-status-warn';
}

function statusLabel(ok: boolean | null | undefined): string {
  if (ok === true) return 'OK';
  if (ok === false) return 'Error';
  return 'N/A';
}

// ---------------------------------------------------------------------------
// Refresh SVG Icon (reusable)
// ---------------------------------------------------------------------------
function RefreshIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Health Card Sub-Components
// ---------------------------------------------------------------------------
function MetricRow({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <>
      <span class="log-metric-key">{label}</span>
      <span class={`log-metric-val${cls ? ` ${cls}` : ''}`}>{value}</span>
    </>
  );
}

function ServerCard({ data }: { data: AdminStatusPayload }) {
  const uptime = formatUptime(data.uptimeSeconds);
  const statusCls = data.shuttingDown ? 'admin-status-error' : 'admin-status-ok';
  const statusText = data.shuttingDown ? 'Shutting Down' : 'Running';
  return (
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Server</span>
        <span class={`log-run-card-status ${statusCls}`}>{statusText}</span>
      </div>
      <div class="log-run-metrics">
        <MetricRow label="Uptime" value={uptime} />
        <MetricRow label="Ready" value={statusLabel(data.ready)} cls={statusClass(data.ready)} />
        <MetricRow
          label="Degraded"
          value={data.degraded ? 'Yes' : 'No'}
          cls={data.degraded ? 'admin-status-warn' : undefined}
        />
      </div>
    </article>
  );
}

function DatabaseCard({ data }: { data: AdminStatusPayload }) {
  const pool = data.dbPool;
  return (
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Database</span>
        <span class={`log-run-card-status ${statusClass(data.primaryDb)}`}>{statusLabel(data.primaryDb)}</span>
      </div>
      <div class="log-run-metrics">
        <MetricRow label="Primary" value={statusLabel(data.primaryDb)} cls={statusClass(data.primaryDb)} />
        <MetricRow label="Divergence" value={statusLabel(data.divergenceDb)} cls={statusClass(data.divergenceDb)} />
        <MetricRow label="Pool total" value={fmtNumber(pool?.total, 0)} />
        <MetricRow label="Pool idle" value={fmtNumber(pool?.idle, 0)} />
        <MetricRow label="Pool waiting" value={fmtNumber(pool?.waiting, 0)} />
      </div>
    </article>
  );
}

function CircuitBreakerCard({ data }: { data: AdminStatusPayload }) {
  const state = String(data.circuitBreaker || 'CLOSED');
  const isClosed = state === 'CLOSED';
  const cls = isClosed ? 'admin-status-ok' : 'admin-status-error';
  return (
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Circuit Breaker</span>
        <span class={`log-run-card-status ${cls}`}>{state}</span>
      </div>
      <div class="log-run-metrics">
        <MetricRow label="State" value={state} cls={cls} />
      </div>
    </article>
  );
}

function ScanDataCard({ data }: { data: AdminStatusPayload }) {
  const configured = data.divergenceConfigured;
  const lastScan = data.lastScanDateEt || '--';
  const running = data.divergenceScanRunning;
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  return (
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Scan Data</span>
        <span class={`log-run-card-status${running ? ' admin-status-warn' : ''}`}>{running ? 'Running' : 'Idle'}</span>
      </div>
      <div class="log-run-metrics">
        <MetricRow
          label="Configured"
          value={configured ? 'Yes' : 'No'}
          cls={configured ? 'admin-status-ok' : 'admin-status-error'}
        />
        <MetricRow label="Last scan" value={lastScan} />
        <MetricRow
          label="Warnings"
          value={String(warnings.length || 0)}
          cls={warnings.length > 0 ? 'admin-status-warn' : undefined}
        />
      </div>
      {warnings.length > 0 && (
        <div class="admin-warnings">
          {warnings.map((w, i) => (
            <div key={i} class="admin-warning-item">
              {w}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Run Metric Cards
// ---------------------------------------------------------------------------
function FailedTickersSection({ failed, recovered }: { failed: string[]; recovered: string[] }) {
  if (failed.length === 0 && recovered.length === 0) return null;
  const summary = [
    failed.length > 0 ? `${failed.length} failed` : '',
    recovered.length > 0 ? `${recovered.length} recovered via retry` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <details class="log-failed-details">
      <summary class="log-failed-summary">{summary}</summary>
      <div class="log-failed-body">
        {failed.length > 0 && (
          <>
            <div class="log-failed-label">Failed:</div>
            <div class="log-failed-list">
              {failed.map((t) => (
                <span key={t} class="log-failed-ticker">
                  {t}
                </span>
              ))}
            </div>
          </>
        )}
        {recovered.length > 0 && (
          <>
            <div class="log-recovered-label">Recovered:</div>
            <div class="log-failed-list">
              {recovered.map((t) => (
                <span key={t} class="log-recovered-ticker">
                  {t}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function RunCard({
  title,
  run,
  statusFallback,
}: {
  title: string;
  run?: RunMetricsSnapshot | null;
  statusFallback?: { status?: string; running?: boolean; processed_tickers?: number; total_tickers?: number } | null;
}) {
  const statusText = fmtStatus(run?.status || statusFallback?.status || (statusFallback?.running ? 'running' : 'idle'));
  const processed = Number(run?.tickers?.processed ?? statusFallback?.processed_tickers ?? 0);
  const total = Number(run?.tickers?.total ?? statusFallback?.total_tickers ?? 0);
  const errors = Number(run?.tickers?.errors ?? 0);
  const failed = Array.isArray(run?.failedTickers) ? run.failedTickers : [];
  const recovered = Array.isArray(run?.retryRecovered) ? run.retryRecovered : [];

  return (
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>{title}</span>
        <span class="log-run-card-status">{statusText}</span>
      </div>
      <div class="log-run-metrics">
        <MetricRow label="Tickers" value={`${processed}/${total || 0}`} />
        <MetricRow label="Errors" value={String(errors)} />
        <MetricRow label="API calls" value={fmtNumber(run?.api?.calls, 0)} />
        <MetricRow label="API fail" value={fmtNumber(run?.api?.failures, 0)} />
        <MetricRow label="429 count" value={fmtNumber(run?.api?.rateLimited, 0)} />
        <MetricRow label="API p95 ms" value={fmtNumber(run?.api?.p95LatencyMs, 1)} />
        <MetricRow label="API avg ms" value={fmtNumber(run?.api?.avgLatencyMs, 1)} />
        <MetricRow label="DB flushes" value={fmtNumber(run?.db?.flushCount, 0)} />
        <MetricRow label="Summary rows" value={fmtNumber(run?.db?.summaryRows, 0)} />
        <MetricRow label="Signal rows" value={fmtNumber(run?.db?.signalRows, 0)} />
        <MetricRow label="Duration s" value={fmtNumber(run?.durationSeconds, 1)} />
        <MetricRow label="Phase" value={run?.phase || '--'} />
      </div>
      <FailedTickersSection failed={failed} recovered={recovered} />
    </article>
  );
}

function ConfigCard({ payload }: { payload: RunMetricsPayload }) {
  const config = payload.config || {};
  const scheduler = payload.schedulerEnabled ? 'on' : 'off';
  return (
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Runtime Config</span>
        <span class="log-run-card-status">{scheduler}</span>
      </div>
      <div class="log-run-metrics">
        <MetricRow label="Source" value={config.divergenceSourceInterval || '--'} />
        <MetricRow label="Lookback d" value={fmtNumber(config.divergenceLookbackDays, 0)} />
        <MetricRow label="Concurrency" value={fmtNumber(config.divergenceConcurrencyConfigured, 0)} />
        <MetricRow label="Flush size" value={fmtNumber(config.divergenceFlushSize, 0)} />
        <MetricRow label="API max rps" value={fmtNumber(config.dataApiMaxRequestsPerSecond, 0)} />
        <MetricRow label="Bucket cap" value={fmtNumber(config.dataApiRateBucketCapacity, 0)} />
        <MetricRow label="Timeout ms" value={fmtNumber(config.dataApiTimeoutMs, 0)} />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// History Entry
// ---------------------------------------------------------------------------
function HistoryEntry({ run }: { run: RunMetricsSnapshot }) {
  const processed = Number(run?.tickers?.processed || 0);
  const total = Number(run?.tickers?.total || 0);
  const errors = Number(run?.tickers?.errors || 0);
  const calls = Number(run?.api?.calls || 0);
  const p95 = fmtNumber(run?.api?.p95LatencyMs, 1);
  const failed = Array.isArray(run?.failedTickers) ? run.failedTickers : [];
  const recovered = Array.isArray(run?.retryRecovered) ? run.retryRecovered : [];

  return (
    <article class="log-history-entry">
      <div class="log-history-header">
        <span>{String(run?.runType || 'run')}</span>
        <span>{fmtStatus(run?.status)}</span>
      </div>
      <div class="log-history-sub">
        {fmtIsoToLocal(run?.startedAt)} | tickers {processed}/{total}
        {errors > 0 ? ` (${errors} err)` : ''} | api {calls} | p95 {p95}ms
      </div>
      <FailedTickersSection failed={failed} recovered={recovered} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// Pagination SVGs
// ---------------------------------------------------------------------------
function PrevIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main Admin View Component
// ---------------------------------------------------------------------------
interface AdminOperationsStatusPayload {
  scheduler?: {
    enabledByConfig?: boolean;
    enabled?: boolean;
    nextDivergenceRunUtc?: string | null;
    nextBreadthRunUtc?: string | null;
  };
  warmup?: {
    running?: boolean;
    completed?: number;
    total?: number;
    errors?: number;
    finishedAt?: string | null;
  };
  breadthConstituents?: {
    sourceUrlConfigured?: boolean;
    totalTickers?: number;
  };
}

async function requestJson(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error || `HTTP ${response.status}`));
  }
  return payload;
}

function opErrorText(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return `Error: ${msg || 'unknown'}`;
}

function normalizeTickerInputList(raw: string): string[] {
  return Array.from(
    new Set(
      String(raw || '')
        .split(/[\s,]+/)
        .map((token) => token.trim().toUpperCase())
        .filter((ticker) => /^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker)),
    ),
  );
}

function OperationActionRow(props: { label: string; onClick: () => void; status: string; busy?: boolean }) {
  return (
    <div class="admin-operation-row">
      <button class="pane-btn divergence-run-btn" disabled={Boolean(props.busy)} onClick={props.onClick}>
        {props.label}
      </button>
      <span class="divergence-run-status">{props.status}</span>
    </div>
  );
}

export function AdminView() {
  const [statusData, setStatusData] = useState<AdminStatusPayload | null>(null);
  const [metricsData, setMetricsData] = useState<RunMetricsPayload | null>(null);
  const [opsData, setOpsData] = useState<AdminOperationsStatusPayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [opsBusy, setOpsBusy] = useState<Record<string, boolean>>({});
  const [opsStatus, setOpsStatus] = useState<Record<string, string>>({});
  const [addTickersOpen, setAddTickersOpen] = useState(false);
  const [addTickersInput, setAddTickersInput] = useState('');

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const [status, metrics, ops] = await Promise.all([
        fetch('/api/admin/status', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch('/api/logs/run-metrics', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch('/api/admin/operations/status', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (status) setStatusData(status);
      if (metrics) setMetricsData(metrics);
      if (ops) setOpsData(ops);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  useEffect(() => {
    initFetchButtons();
    syncDivergenceScanUiState().catch(() => {});
  }, []);

  // Initial load + polling
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, ADMIN_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runOp = useCallback(
    async (key: string, action: () => Promise<void>) => {
      if (opsBusy[key]) return;
      setOpsBusy((prev) => ({ ...prev, [key]: true }));
      try {
        await action();
      } catch (err: unknown) {
        setOpsStatus((prev) => ({ ...prev, [key]: opErrorText(err) }));
      } finally {
        setOpsBusy((prev) => ({ ...prev, [key]: false }));
        refresh().catch(() => {});
      }
    },
    [opsBusy, refresh],
  );

  const submitAddTickers = useCallback(() => {
    void runOp('addTickers', async () => {
      const tickers = normalizeTickerInputList(addTickersInput);
      if (tickers.length === 0) {
        throw new Error('Enter at least one valid ticker');
      }
      const out = await requestJson('/api/admin/operations/divergence-symbols/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      const addedCount = Number(out.addedCount || 0);
      const invalidCount = Array.isArray(out.invalidTickers) ? out.invalidTickers.length : 0;
      setOpsStatus((prev) => ({
        ...prev,
        addTickers: invalidCount > 0 ? `Added ${addedCount} (${invalidCount} invalid)` : `Added ${addedCount}`,
      }));
      setAddTickersInput('');
    });
  }, [addTickersInput, runOp]);

  const schedulerEnabled = Boolean(opsData?.scheduler?.enabled);
  const schedulerRuntimeText = schedulerEnabled ? 'On' : 'Off';
  const warmupRuntimeText = opsData?.warmup?.running
    ? `Running ${Number(opsData?.warmup?.completed || 0)}/${Number(opsData?.warmup?.total || 0)}`
    : Number(opsData?.warmup?.total || 0) > 0
      ? `Last ${Number(opsData?.warmup?.completed || 0)}/${Number(opsData?.warmup?.total || 0)}`
      : 'Idle';
  const constituentsRuntimeText =
    typeof opsData?.breadthConstituents?.totalTickers === 'number'
      ? `${opsData.breadthConstituents.totalTickers} tickers`
      : '--';

  // History pagination
  const history = Array.isArray(metricsData?.history) ? metricsData!.history : [];
  const totalPages = Math.ceil(history.length / HISTORY_PAGE_SIZE);
  const page = Math.min(historyPage, Math.max(totalPages - 1, 0));
  const pageItems = history.slice(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE);

  return (
    <>
      {/* Section 1: Operations */}
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Operations</h2>
        </div>
        <div class="admin-operations-layout">
          <div class="admin-operations-column">
            <div class="admin-operation-row">
              <button class="pane-btn divergence-run-btn" id="divergence-fetch-daily-btn">
                Fetch Daily
              </button>
              <button
                class="pane-btn divergence-run-btn divergence-control-icon-btn"
                id="divergence-fetch-daily-stop-btn"
                aria-label="Stop Fetch Daily"
                disabled
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect width="10" height="10" rx="1" />
                </svg>
              </button>
              <span id="divergence-fetch-daily-status" class="divergence-run-status">
                Ran --
              </span>
            </div>
            <div class="admin-operation-row">
              <button class="pane-btn divergence-run-btn" id="divergence-fetch-weekly-btn">
                Fetch Weekly
              </button>
              <button
                class="pane-btn divergence-run-btn divergence-control-icon-btn"
                id="divergence-fetch-weekly-stop-btn"
                aria-label="Stop Fetch Weekly"
                disabled
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect width="10" height="10" rx="1" />
                </svg>
              </button>
              <span id="divergence-fetch-weekly-status" class="divergence-run-status">
                Ran --
              </span>
            </div>
            <div class="admin-operation-row">
              <button class="pane-btn divergence-run-btn" id="divergence-vdf-scan-btn">
                Fetch Analysis
              </button>
              <button
                class="pane-btn divergence-run-btn divergence-control-icon-btn"
                id="divergence-vdf-scan-stop-btn"
                aria-label="Stop Fetch Analysis"
                disabled
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect width="10" height="10" rx="1" />
                </svg>
              </button>
              <span id="divergence-vdf-scan-status" class="divergence-run-status">
                Ran --
              </span>
            </div>
            <div class="admin-operation-row">
              <button class="pane-btn divergence-run-btn" id="breadth-recompute-btn">
                Fetch Breadth
              </button>
              <button
                class="pane-btn divergence-run-btn divergence-control-icon-btn"
                id="breadth-recompute-stop-btn"
                aria-label="Stop Fetch Breadth"
                disabled
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                  <rect width="10" height="10" rx="1" />
                </svg>
              </button>
              <span id="breadth-recompute-status" class="divergence-run-status">
                Ran --
              </span>
            </div>

            <OperationActionRow
              label="Fetch ETF Holdings"
              busy={opsBusy.constituents}
              status={opsStatus.constituents || constituentsRuntimeText}
              onClick={() =>
                runOp('constituents', async () => {
                  const out = await requestJson('/api/breadth/constituents/rebuild', { method: 'POST' });
                  setOpsStatus((prev) => ({
                    ...prev,
                    constituents: `${fmtNumber(out.indexCount, 0)} ETFs / ${fmtNumber(out.tickerCount, 0)} tickers`,
                  }));
                })
              }
            />
          </div>

          <div class="admin-operations-separator" aria-hidden="true" />

          <div class="admin-operations-column">
            <OperationActionRow
              label="Retry Failed Daily"
              busy={opsBusy.retryDaily}
              status={opsStatus.retryDaily || '--'}
              onClick={() =>
                runOp('retryDaily', async () => {
                  const out = await requestJson('/api/admin/operations/retry-failed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ runType: 'fetchDaily' }),
                  });
                  setOpsStatus((prev) => ({
                    ...prev,
                    retryDaily: `${String(out.status || 'started')} (${fmtNumber(out.failedTickers, 0)} tickers)`,
                  }));
                  syncDivergenceScanUiState().catch(() => {});
                })
              }
            />

            <OperationActionRow
              label="Retry Failed Weekly"
              busy={opsBusy.retryWeekly}
              status={opsStatus.retryWeekly || '--'}
              onClick={() =>
                runOp('retryWeekly', async () => {
                  const out = await requestJson('/api/admin/operations/retry-failed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ runType: 'fetchWeekly' }),
                  });
                  setOpsStatus((prev) => ({
                    ...prev,
                    retryWeekly: `${String(out.status || 'started')} (${fmtNumber(out.failedTickers, 0)} tickers)`,
                  }));
                  syncDivergenceScanUiState().catch(() => {});
                })
              }
            />

            <OperationActionRow
              label="Stop All Jobs"
              busy={opsBusy.stopAll}
              status={opsStatus.stopAll || '--'}
              onClick={() =>
                runOp('stopAll', async () => {
                  const out = await requestJson('/api/admin/operations/stop-all', { method: 'POST' });
                  setOpsStatus((prev) => ({ ...prev, stopAll: String(out.message || 'Stop requested') }));
                  syncDivergenceScanUiState().catch(() => {});
                })
              }
            />

            <OperationActionRow
              label="Enable Scheduler"
              busy={opsBusy.scheduler}
              status={opsStatus.scheduler || schedulerRuntimeText}
              onClick={() =>
                runOp('scheduler', async () => {
                  const out = await requestJson('/api/admin/operations/scheduler', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: true }),
                  });
                  const scheduler = (out.scheduler || {}) as { enabled?: boolean };
                  setOpsStatus((prev) => ({
                    ...prev,
                    scheduler: scheduler.enabled ? 'On' : 'Off',
                  }));
                })
              }
            />

            <OperationActionRow
              label="Rebuild Calendar"
              busy={opsBusy.calendar}
              status={opsStatus.calendar || '--'}
              onClick={() =>
                runOp('calendar', async () => {
                  const out = await requestJson('/api/admin/operations/trading-calendar/rebuild', { method: 'POST' });
                  setOpsStatus((prev) => ({
                    ...prev,
                    calendar: Boolean((out.calendar as Record<string, unknown> | undefined)?.initialized)
                      ? 'Rebuilt'
                      : 'Updated',
                  }));
                })
              }
            />
          </div>

          <div class="admin-operations-separator" aria-hidden="true" />

          <div class="admin-operations-column">
            <OperationActionRow
              label="Clear Caches"
              busy={opsBusy.clearCaches}
              status={opsStatus.clearCaches || '--'}
              onClick={() =>
                runOp('clearCaches', async () => {
                  const out = await requestJson('/api/admin/operations/cache/clear', { method: 'POST' });
                  setOpsStatus((prev) => ({ ...prev, clearCaches: String(out.message || 'Done') }));
                })
              }
            />

            <OperationActionRow
              label="Warm Chart Cache"
              busy={opsBusy.warmCache}
              status={opsStatus.warmCache || warmupRuntimeText}
              onClick={() =>
                runOp('warmCache', async () => {
                  const out = await requestJson('/api/admin/operations/chart/warm', { method: 'POST' });
                  const status = String(out.status || 'started');
                  const job = (out.job || {}) as { total?: number };
                  setOpsStatus((prev) => ({
                    ...prev,
                    warmCache: `${status} (${fmtNumber(job.total, 0)} jobs)`,
                  }));
                })
              }
            />

            <OperationActionRow
              label="Health Check"
              busy={opsBusy.healthcheck}
              status={opsStatus.healthcheck || '--'}
              onClick={() =>
                runOp('healthcheck', async () => {
                  const out = await requestJson('/api/admin/operations/healthcheck', { method: 'POST' });
                  setOpsStatus((prev) => ({
                    ...prev,
                    healthcheck: `${String(out.status || 'ok')} (${fmtNumber(out.durationMs, 0)}ms)`,
                  }));
                })
              }
            />

            <OperationActionRow
              label="Export Diagnostics"
              busy={opsBusy.diagnostics}
              status={opsStatus.diagnostics || '--'}
              onClick={() =>
                runOp('diagnostics', async () => {
                  const out = await requestJson('/api/admin/operations/diagnostics', { method: 'GET' });
                  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
                  const fileUrl = window.URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = fileUrl;
                  anchor.download = `tradedata-diagnostics-${Date.now()}.json`;
                  document.body.appendChild(anchor);
                  anchor.click();
                  anchor.remove();
                  window.URL.revokeObjectURL(fileUrl);
                  setOpsStatus((prev) => ({ ...prev, diagnostics: 'Downloaded' }));
                })
              }
            />

            <div class="admin-operation-row admin-operation-row--stack">
              <button
                class="pane-btn divergence-run-btn"
                disabled={Boolean(opsBusy.addTickers)}
                onClick={() => setAddTickersOpen((prev) => !prev)}
              >
                Add Tickers
              </button>
              {addTickersOpen && (
                <div class="admin-add-ticker-controls">
                  <input
                    type="text"
                    class="glass-input admin-add-ticker-input"
                    value={addTickersInput}
                    onInput={(event) => setAddTickersInput((event.target as HTMLInputElement).value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        submitAddTickers();
                      }
                    }}
                  />
                  <button
                    class="pane-btn divergence-run-btn"
                    disabled={Boolean(opsBusy.addTickers)}
                    onClick={submitAddTickers}
                  >
                    Add
                  </button>
                  <span class="divergence-run-status">{opsStatus.addTickers || '--'}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Section 2: System Health */}
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>System</h2>
          <button class={`pane-btn refresh-btn${refreshing ? ' loading' : ''}`} onClick={refresh}>
            <RefreshIcon />
          </button>
        </div>
        <div id="admin-health-cards" class="admin-health-grid">
          {statusData ? (
            <>
              <ServerCard data={statusData} />
              <DatabaseCard data={statusData} />
              <CircuitBreakerCard data={statusData} />
              <ScanDataCard data={statusData} />
            </>
          ) : (
            <div class="loading">Loading...</div>
          )}
        </div>
      </div>

      {/* Section 3: Run Metrics */}
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Run Metrics</h2>
          <button class={`pane-btn refresh-btn${refreshing ? ' loading' : ''}`} onClick={refresh}>
            <RefreshIcon />
          </button>
        </div>
        <div id="admin-run-cards" class="logs-grid">
          {metricsData ? (
            <>
              <RunCard
                title="Fetch Daily"
                run={metricsData.runs?.fetchDaily}
                statusFallback={metricsData.statuses?.fetchDaily}
              />
              <RunCard
                title="Fetch Weekly"
                run={metricsData.runs?.fetchWeekly}
                statusFallback={metricsData.statuses?.fetchWeekly}
              />
              <RunCard
                title="VDF Scan"
                run={metricsData.runs?.vdfScan}
                statusFallback={metricsData.statuses?.vdfScan}
              />
              <ConfigCard payload={metricsData} />
            </>
          ) : (
            <div class="loading">Loading...</div>
          )}
        </div>
      </div>

      {/* Section 4: Run History */}
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Run History</h2>
          {totalPages > 1 && (
            <div class="log-history-pagination">
              <button
                class={`pane-btn admin-history-prev${page === 0 ? ' disabled' : ''}`}
                disabled={page === 0}
                onClick={() => setHistoryPage(Math.max(0, page - 1))}
              >
                <PrevIcon />
              </button>
              <button
                class={`pane-btn admin-history-next${page >= totalPages - 1 ? ' disabled' : ''}`}
                disabled={page >= totalPages - 1}
                onClick={() => setHistoryPage(page + 1)}
              >
                <NextIcon />
              </button>
            </div>
          )}
        </div>
        <div id="admin-history-container" class="alerts-list">
          {pageItems.length > 0 ? (
            pageItems.map((run, i) => <HistoryEntry key={i} run={run} />)
          ) : (
            <div class="log-history-placeholder" aria-hidden="true"></div>
          )}
        </div>
      </div>
    </>
  );
}

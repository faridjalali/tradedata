import { useEffect, useState, useCallback } from 'preact/hooks';
import type { AdminStatusPayload, RunMetricsPayload, RunMetricsSnapshot } from '../../shared/api-types';

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
  try { return new Date(String(value)).toLocaleString(); } catch { return '--'; }
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
        <MetricRow label="Degraded" value={data.degraded ? 'Yes' : 'No'}
          cls={data.degraded ? 'admin-status-warn' : undefined} />
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
        <span class={`log-run-card-status${running ? ' admin-status-warn' : ''}`}>
          {running ? 'Running' : 'Idle'}
        </span>
      </div>
      <div class="log-run-metrics">
        <MetricRow label="Configured" value={configured ? 'Yes' : 'No'}
          cls={configured ? 'admin-status-ok' : 'admin-status-error'} />
        <MetricRow label="Last scan" value={lastScan} />
        <MetricRow label="Warnings" value={String(warnings.length || 0)}
          cls={warnings.length > 0 ? 'admin-status-warn' : undefined} />
      </div>
      {warnings.length > 0 && (
        <div class="admin-warnings">
          {warnings.map((w, i) => <div key={i} class="admin-warning-item">{w}</div>)}
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
  ].filter(Boolean).join(', ');
  return (
    <details class="log-failed-details">
      <summary class="log-failed-summary">{summary}</summary>
      <div class="log-failed-body">
        {failed.length > 0 && (
          <>
            <div class="log-failed-label">Failed:</div>
            <div class="log-failed-list">
              {failed.map((t) => <span key={t} class="log-failed-ticker">{t}</span>)}
            </div>
          </>
        )}
        {recovered.length > 0 && (
          <>
            <div class="log-recovered-label">Recovered:</div>
            <div class="log-failed-list">
              {recovered.map((t) => <span key={t} class="log-recovered-ticker">{t}</span>)}
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function RunCard({ title, run, statusFallback }: {
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
        {fmtIsoToLocal(run?.startedAt)} |
        tickers {processed}/{total}{errors > 0 ? ` (${errors} err)` : ''} |
        api {calls} |
        p95 {p95}ms
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main Admin View Component
// ---------------------------------------------------------------------------
export function AdminView() {
  const [statusData, setStatusData] = useState<AdminStatusPayload | null>(null);
  const [metricsData, setMetricsData] = useState<RunMetricsPayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const [status, metrics] = await Promise.all([
        fetch('/api/admin/status', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/logs/run-metrics', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (status) setStatusData(status);
      if (metrics) setMetricsData(metrics);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  // Initial load + polling
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, ADMIN_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // History pagination
  const history = Array.isArray(metricsData?.history) ? metricsData!.history : [];
  const totalPages = Math.ceil(history.length / HISTORY_PAGE_SIZE);
  const page = Math.min(historyPage, Math.max(totalPages - 1, 0));
  const pageItems = history.slice(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE);

  return (
    <>
      {/* Section 1: System Health */}
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

      {/* Section 2: Run Metrics */}
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
              <RunCard title="Fetch Daily" run={metricsData.runs?.fetchDaily} statusFallback={metricsData.statuses?.fetchDaily} />
              <RunCard title="Fetch Weekly" run={metricsData.runs?.fetchWeekly} statusFallback={metricsData.statuses?.fetchWeekly} />
              <RunCard title="VDF Scan" run={metricsData.runs?.vdfScan} statusFallback={metricsData.statuses?.vdfScan} />
              <ConfigCard payload={metricsData} />
            </>
          ) : (
            <div class="loading">Loading...</div>
          )}
        </div>
      </div>

      {/* Section 3: Recent Runs */}
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Recent Runs</h2>
          {totalPages > 1 && (
            <div class="log-history-pagination">
              <button class={`pane-btn admin-history-prev${page === 0 ? ' disabled' : ''}`}
                disabled={page === 0} onClick={() => setHistoryPage(Math.max(0, page - 1))}>
                <PrevIcon />
              </button>
              <button class={`pane-btn admin-history-next${page >= totalPages - 1 ? ' disabled' : ''}`}
                disabled={page >= totalPages - 1} onClick={() => setHistoryPage(page + 1)}>
                <NextIcon />
              </button>
            </div>
          )}
        </div>
        <div id="admin-history-container" class="alerts-list">
          {pageItems.length > 0
            ? pageItems.map((run, i) => <HistoryEntry key={i} run={run} />)
            : <div class="loading">No run history yet</div>
          }
        </div>
      </div>
    </>
  );
}

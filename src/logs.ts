interface RunTickerMetrics {
    total?: number;
    processed?: number;
    errors?: number;
    processedPerSecond?: number;
}

interface RunApiMetrics {
    calls?: number;
    failures?: number;
    rateLimited?: number;
    timedOut?: number;
    p95LatencyMs?: number;
    avgLatencyMs?: number;
}

interface RunDbMetrics {
    flushCount?: number;
    summaryRows?: number;
    signalRows?: number;
    avgFlushMs?: number;
}

interface RunMetricsSnapshot {
    runId?: string;
    runType?: string;
    status?: string;
    phase?: string;
    startedAt?: string;
    finishedAt?: string | null;
    durationSeconds?: number;
    tickers?: RunTickerMetrics;
    api?: RunApiMetrics;
    db?: RunDbMetrics;
    failedTickers?: string[];
    retryRecovered?: string[];
}

interface RunMetricsPayload {
    generatedAt?: string;
    schedulerEnabled?: boolean;
    config?: {
        divergenceSourceInterval?: string;
        divergenceLookbackDays?: number;
        divergenceConcurrencyConfigured?: number;
        divergenceFlushSize?: number;
        dataApiBase?: string;
        dataApiTimeoutMs?: number;
        dataApiMaxRequestsPerSecond?: number;
        dataApiRateBucketCapacity?: number;
    };
    statuses?: {
        fetchDaily?: { status?: string; running?: boolean; processed_tickers?: number; total_tickers?: number } | null;
        fetchWeekly?: { status?: string; running?: boolean; processed_tickers?: number; total_tickers?: number } | null;
    };
    runs?: {
        fetchDaily?: RunMetricsSnapshot | null;
        fetchWeekly?: RunMetricsSnapshot | null;
    };
    history?: RunMetricsSnapshot[];
}

let logsPollTimer: number | null = null;
let logsRefreshInFlight = false;

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtNumber(value: unknown, digits = 0): string {
    const num = Number(value);
    if (!Number.isFinite(num)) return '--';
    return num.toFixed(Math.max(0, digits));
}

function fmtStatus(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return 'idle';
    return raw;
}

function fmtIsoToLocal(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '--';
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return '--';
    return parsed.toLocaleString();
}

function buildRunCardHtml(
    title: string,
    run: RunMetricsSnapshot | null | undefined,
    statusFallback: { status?: string; running?: boolean; processed_tickers?: number; total_tickers?: number } | null | undefined
): string {
    const statusText = fmtStatus(run?.status || statusFallback?.status || (statusFallback?.running ? 'running' : 'idle'));
    const processed = Number(run?.tickers?.processed ?? statusFallback?.processed_tickers ?? 0);
    const total = Number(run?.tickers?.total ?? statusFallback?.total_tickers ?? 0);
    const errors = Number(run?.tickers?.errors ?? 0);
    const p95 = fmtNumber(run?.api?.p95LatencyMs, 1);
    const avg = fmtNumber(run?.api?.avgLatencyMs, 1);
    const calls = fmtNumber(run?.api?.calls, 0);
    const failures = fmtNumber(run?.api?.failures, 0);
    const rateLimited = fmtNumber(run?.api?.rateLimited, 0);
    const flushes = fmtNumber(run?.db?.flushCount, 0);
    const summaryRows = fmtNumber(run?.db?.summaryRows, 0);
    const signalRows = fmtNumber(run?.db?.signalRows, 0);
    const duration = fmtNumber(run?.durationSeconds, 1);
    const phase = escapeHtml(run?.phase || '--');

    const failedList = Array.isArray(run?.failedTickers) ? run.failedTickers : [];
    const recoveredList = Array.isArray(run?.retryRecovered) ? run.retryRecovered : [];
    const failedCount = failedList.length;
    const recoveredCount = recoveredList.length;

    let failedSection = '';
    if (failedCount > 0 || recoveredCount > 0) {
        const failedItems = failedList.map(t => `<span class="log-failed-ticker">${escapeHtml(t)}</span>`).join('');
        const recoveredItems = recoveredList.map(t => `<span class="log-recovered-ticker">${escapeHtml(t)}</span>`).join('');
        failedSection = `
          <details class="log-failed-details">
            <summary class="log-failed-summary">
              ${failedCount > 0 ? `${failedCount} failed` : ''}${failedCount > 0 && recoveredCount > 0 ? ', ' : ''}${recoveredCount > 0 ? `${recoveredCount} recovered via retry` : ''}
            </summary>
            <div class="log-failed-body">
              ${failedCount > 0 ? `<div class="log-failed-label">Failed:</div><div class="log-failed-list">${failedItems}</div>` : ''}
              ${recoveredCount > 0 ? `<div class="log-recovered-label">Recovered:</div><div class="log-failed-list">${recoveredItems}</div>` : ''}
            </div>
          </details>
        `;
    }

    return `
      <article class="log-run-card">
        <div class="log-run-card-title">
          <span>${escapeHtml(title)}</span>
          <span class="log-run-card-status">${escapeHtml(statusText)}</span>
        </div>
        <div class="log-run-metrics">
          <span class="log-metric-key">Tickers</span><span class="log-metric-val">${processed}/${total || 0}</span>
          <span class="log-metric-key">Errors</span><span class="log-metric-val">${errors}</span>
          <span class="log-metric-key">API calls</span><span class="log-metric-val">${calls}</span>
          <span class="log-metric-key">API fail</span><span class="log-metric-val">${failures}</span>
          <span class="log-metric-key">429 count</span><span class="log-metric-val">${rateLimited}</span>
          <span class="log-metric-key">API p95 ms</span><span class="log-metric-val">${p95}</span>
          <span class="log-metric-key">API avg ms</span><span class="log-metric-val">${avg}</span>
          <span class="log-metric-key">DB flushes</span><span class="log-metric-val">${flushes}</span>
          <span class="log-metric-key">Summary rows</span><span class="log-metric-val">${summaryRows}</span>
          <span class="log-metric-key">Signal rows</span><span class="log-metric-val">${signalRows}</span>
          <span class="log-metric-key">Duration s</span><span class="log-metric-val">${duration}</span>
          <span class="log-metric-key">Phase</span><span class="log-metric-val">${phase}</span>
        </div>
        ${failedSection}
      </article>
    `;
}

function buildConfigCardHtml(payload: RunMetricsPayload): string {
    const config = payload.config || {};
    const source = escapeHtml(config.divergenceSourceInterval || '--');
    const lookback = fmtNumber(config.divergenceLookbackDays, 0);
    const concurrency = fmtNumber(config.divergenceConcurrencyConfigured, 0);
    const flushSize = fmtNumber(config.divergenceFlushSize, 0);
    const rps = fmtNumber(config.dataApiMaxRequestsPerSecond, 0);
    const bucket = fmtNumber(config.dataApiRateBucketCapacity, 0);
    const timeout = fmtNumber(config.dataApiTimeoutMs, 0);
    const scheduler = payload.schedulerEnabled ? 'on' : 'off';

    return `
      <article class="log-run-card">
        <div class="log-run-card-title">
          <span>Runtime Config</span>
          <span class="log-run-card-status">${escapeHtml(scheduler)}</span>
        </div>
        <div class="log-run-metrics">
          <span class="log-metric-key">Source</span><span class="log-metric-val">${source}</span>
          <span class="log-metric-key">Lookback d</span><span class="log-metric-val">${lookback}</span>
          <span class="log-metric-key">Concurrency</span><span class="log-metric-val">${concurrency}</span>
          <span class="log-metric-key">Flush size</span><span class="log-metric-val">${flushSize}</span>
          <span class="log-metric-key">API max rps</span><span class="log-metric-val">${rps}</span>
          <span class="log-metric-key">Bucket cap</span><span class="log-metric-val">${bucket}</span>
          <span class="log-metric-key">Timeout ms</span><span class="log-metric-val">${timeout}</span>
        </div>
      </article>
    `;
}

function renderRunCards(payload: RunMetricsPayload): void {
    const host = document.getElementById('logs-run-cards');
    if (!host) return;
    const cards = [
        buildRunCardHtml('Fetch Daily', payload.runs?.fetchDaily, payload.statuses?.fetchDaily),
        buildRunCardHtml('Fetch Weekly', payload.runs?.fetchWeekly, payload.statuses?.fetchWeekly),
        buildConfigCardHtml(payload)
    ];
    host.innerHTML = cards.join('');
}

function renderHistory(payload: RunMetricsPayload): void {
    const host = document.getElementById('logs-history-container');
    if (!host) return;
    const history = Array.isArray(payload.history) ? payload.history : [];
    if (history.length === 0) {
        host.innerHTML = '<div class="loading">No run history yet</div>';
        return;
    }
    host.innerHTML = history.slice(0, 24).map((run) => {
        const processed = Number(run?.tickers?.processed || 0);
        const total = Number(run?.tickers?.total || 0);
        const errors = Number(run?.tickers?.errors || 0);
        const calls = Number(run?.api?.calls || 0);
        const p95 = fmtNumber(run?.api?.p95LatencyMs, 1);
        const failedList = Array.isArray(run?.failedTickers) ? run.failedTickers : [];
        const recoveredList = Array.isArray(run?.retryRecovered) ? run.retryRecovered : [];
        const failedCount = failedList.length;
        const recoveredCount = recoveredList.length;

        let failedSection = '';
        if (failedCount > 0 || recoveredCount > 0) {
            const failedItems = failedList.map(t => `<span class="log-failed-ticker">${escapeHtml(t)}</span>`).join('');
            const recoveredItems = recoveredList.map(t => `<span class="log-recovered-ticker">${escapeHtml(t)}</span>`).join('');
            failedSection = `
              <details class="log-failed-details">
                <summary class="log-failed-summary">
                  ${failedCount > 0 ? `${failedCount} failed` : ''}${failedCount > 0 && recoveredCount > 0 ? ', ' : ''}${recoveredCount > 0 ? `${recoveredCount} recovered` : ''}
                </summary>
                <div class="log-failed-body">
                  ${failedCount > 0 ? `<div class="log-failed-label">Failed:</div><div class="log-failed-list">${failedItems}</div>` : ''}
                  ${recoveredCount > 0 ? `<div class="log-recovered-label">Recovered:</div><div class="log-failed-list">${recoveredItems}</div>` : ''}
                </div>
              </details>
            `;
        }

        return `
          <article class="log-history-entry">
            <div class="log-history-header">
              <span>${escapeHtml(String(run?.runType || 'run'))}</span>
              <span>${escapeHtml(fmtStatus(run?.status))}</span>
            </div>
            <div class="log-history-sub">
              ${escapeHtml(fmtIsoToLocal(run?.startedAt))} |
              tickers ${processed}/${total}${errors > 0 ? ` (${errors} err)` : ''} |
              api ${calls} |
              p95 ${p95}ms
            </div>
            ${failedSection}
          </article>
        `;
    }).join('');
}

async function fetchRunMetricsPayload(): Promise<RunMetricsPayload> {
    const response = await fetch('/api/logs/run-metrics', { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Failed to fetch run metrics (HTTP ${response.status})`);
    }
    return response.json() as Promise<RunMetricsPayload>;
}

export async function refreshLogsView(): Promise<void> {
    if (logsRefreshInFlight) return;
    logsRefreshInFlight = true;
    try {
        const payload = await fetchRunMetricsPayload();
        renderRunCards(payload);
        renderHistory(payload);
    } catch (error) {
        const host = document.getElementById('logs-history-container');
        if (host) host.innerHTML = '<div class="loading">Failed to load logs</div>';
        console.error('Failed to refresh logs view:', error);
    } finally {
        logsRefreshInFlight = false;
    }
}

export function startLogsPolling(): void {
    if (logsPollTimer !== null) return;
    logsPollTimer = window.setInterval(() => {
        refreshLogsView().catch(() => {});
    }, 5000);
}

export function stopLogsPolling(): void {
    if (logsPollTimer === null) return;
    window.clearInterval(logsPollTimer);
    logsPollTimer = null;
}

export function initLogsView(): void {
    const refreshBtn = document.getElementById('logs-refresh-btn');
    refreshBtn?.addEventListener('click', () => {
        refreshLogsView().catch(() => {});
    });
}

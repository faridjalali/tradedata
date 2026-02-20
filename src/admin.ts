import type { AdminStatusPayload, RunMetricsPayload, RunMetricsSnapshot } from '../shared/api-types';
import { escapeHtml } from './utils';
import { createRefreshSvgIcon } from './chartVDF';
import {
  buildRunCardHtml,
  buildConfigCardHtml,
  buildHistoryEntryHtml,
  fetchRunMetricsPayload,
  fmtNumber,
  HISTORY_PAGE_SIZE,
} from './logs';
import { getTheme, setTheme, type ThemeName } from './theme';
import { getAppTimeZone, setAppTimeZone, getAppTimeZoneOptions } from './timezone';

let adminInitialized = false;
let adminPollTimer: number | null = null;
let adminRefreshInFlight = false;

// History pagination state (independent from logs module)
let historyPage = 0;
let historyEntries: RunMetricsSnapshot[] = [];

// ---------------------------------------------------------------------------
// Health Cards
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

function buildServerCard(data: AdminStatusPayload): string {
  const uptime = formatUptime(data.uptimeSeconds);
  const statusCls = data.shuttingDown ? 'admin-status-error' : 'admin-status-ok';
  const statusText = data.shuttingDown ? 'Shutting Down' : 'Running';
  return `
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Server</span>
        <span class="log-run-card-status ${statusCls}">${escapeHtml(statusText)}</span>
      </div>
      <div class="log-run-metrics">
        <span class="log-metric-key">Uptime</span><span class="log-metric-val">${escapeHtml(uptime)}</span>
        <span class="log-metric-key">Ready</span><span class="log-metric-val ${statusClass(data.ready)}">${statusLabel(data.ready)}</span>
        <span class="log-metric-key">Degraded</span><span class="log-metric-val${data.degraded ? ' admin-status-warn' : ''}">${data.degraded ? 'Yes' : 'No'}</span>
      </div>
    </article>`;
}

function buildDatabaseCard(data: AdminStatusPayload): string {
  const pool = data.dbPool;
  return `
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Database</span>
        <span class="log-run-card-status ${statusClass(data.primaryDb)}">${statusLabel(data.primaryDb)}</span>
      </div>
      <div class="log-run-metrics">
        <span class="log-metric-key">Primary</span><span class="log-metric-val ${statusClass(data.primaryDb)}">${statusLabel(data.primaryDb)}</span>
        <span class="log-metric-key">Divergence</span><span class="log-metric-val ${statusClass(data.divergenceDb)}">${statusLabel(data.divergenceDb)}</span>
        <span class="log-metric-key">Pool total</span><span class="log-metric-val">${fmtNumber(pool?.total, 0)}</span>
        <span class="log-metric-key">Pool idle</span><span class="log-metric-val">${fmtNumber(pool?.idle, 0)}</span>
        <span class="log-metric-key">Pool waiting</span><span class="log-metric-val">${fmtNumber(pool?.waiting, 0)}</span>
      </div>
    </article>`;
}

function buildCircuitBreakerCard(data: AdminStatusPayload): string {
  const state = String(data.circuitBreaker || 'CLOSED');
  const isClosed = state === 'CLOSED';
  const cls = isClosed ? 'admin-status-ok' : 'admin-status-error';
  return `
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Circuit Breaker</span>
        <span class="log-run-card-status ${cls}">${escapeHtml(state)}</span>
      </div>
      <div class="log-run-metrics">
        <span class="log-metric-key">State</span><span class="log-metric-val ${cls}">${escapeHtml(state)}</span>
      </div>
    </article>`;
}

function buildScanDataCard(data: AdminStatusPayload): string {
  const configured = data.divergenceConfigured;
  const lastScan = data.lastScanDateEt || '--';
  const running = data.divergenceScanRunning;
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  return `
    <article class="log-run-card">
      <div class="log-run-card-title">
        <span>Scan Data</span>
        <span class="log-run-card-status${running ? ' admin-status-warn' : ''}">${running ? 'Running' : 'Idle'}</span>
      </div>
      <div class="log-run-metrics">
        <span class="log-metric-key">Configured</span><span class="log-metric-val ${configured ? 'admin-status-ok' : 'admin-status-error'}">${configured ? 'Yes' : 'No'}</span>
        <span class="log-metric-key">Last scan</span><span class="log-metric-val">${escapeHtml(lastScan)}</span>
        <span class="log-metric-key">Warnings</span><span class="log-metric-val${warnings.length > 0 ? ' admin-status-warn' : ''}">${warnings.length || 0}</span>
      </div>
      ${warnings.length > 0 ? `<div class="admin-warnings">${warnings.map((w) => `<div class="admin-warning-item">${escapeHtml(w)}</div>`).join('')}</div>` : ''}
    </article>`;
}

function renderHealthCards(data: AdminStatusPayload): void {
  const host = document.getElementById('admin-health-cards');
  if (!host) return;
  host.innerHTML = [
    buildServerCard(data),
    buildDatabaseCard(data),
    buildCircuitBreakerCard(data),
    buildScanDataCard(data),
  ].join('');
}

// ---------------------------------------------------------------------------
// Run Metrics + History (reuses logs.ts builders)
// ---------------------------------------------------------------------------

function renderRunCards(payload: RunMetricsPayload): void {
  const host = document.getElementById('admin-run-cards');
  if (!host) return;
  host.innerHTML = [
    buildRunCardHtml('Fetch Daily', payload.runs?.fetchDaily, payload.statuses?.fetchDaily),
    buildRunCardHtml('Fetch Weekly', payload.runs?.fetchWeekly, payload.statuses?.fetchWeekly),
    buildRunCardHtml('VDF Scan', payload.runs?.vdfScan, payload.statuses?.vdfScan),
    buildConfigCardHtml(payload),
  ].join('');
}

function renderHistoryPage(): void {
  const host = document.getElementById('admin-history-container');
  const paginationHost = document.getElementById('admin-history-pagination');
  if (!host) return;
  if (historyEntries.length === 0) {
    host.innerHTML = '<div class="loading">No run history yet</div>';
    if (paginationHost) paginationHost.innerHTML = '';
    return;
  }

  const totalPages = Math.ceil(historyEntries.length / HISTORY_PAGE_SIZE);
  if (historyPage >= totalPages) historyPage = totalPages - 1;
  if (historyPage < 0) historyPage = 0;

  const start = historyPage * HISTORY_PAGE_SIZE;
  const pageItems = historyEntries.slice(start, start + HISTORY_PAGE_SIZE);

  const prevDisabled = historyPage === 0;
  const nextDisabled = historyPage >= totalPages - 1;

  host.innerHTML = pageItems.map(buildHistoryEntryHtml).join('');
  const prevSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
  const nextSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  if (paginationHost) {
    paginationHost.innerHTML =
      totalPages > 1
        ? `<button class="pane-btn admin-history-prev${prevDisabled ? ' disabled' : ''}"${prevDisabled ? ' disabled' : ''}>${prevSvg}</button>` +
          `<button class="pane-btn admin-history-next${nextDisabled ? ' disabled' : ''}"${nextDisabled ? ' disabled' : ''}>${nextSvg}</button>`
        : '';
  }
}

// ---------------------------------------------------------------------------
// Preferences Wiring
// ---------------------------------------------------------------------------

function initAdminPreferences(): void {
  // Theme buttons
  const themeContainer = document.getElementById('admin-theme-btns');
  if (themeContainer) {
    const themeBtns = themeContainer.querySelectorAll<HTMLElement>('.theme-swatch-btn');
    const currentThemeName = getTheme();
    themeBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === currentThemeName);
      btn.addEventListener('click', () => {
        const name = btn.dataset.theme as ThemeName;
        setTheme(name);
        themeBtns.forEach((b) => b.classList.toggle('active', b.dataset.theme === name));
        // Also sync the gear panel theme buttons
        document.querySelectorAll('#global-theme-btns .theme-swatch-btn').forEach((b) => {
          (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.theme === name);
        });
      });
    });
  }

  // Timezone select
  const tzSelect = document.getElementById('admin-timezone-select') as HTMLSelectElement | null;
  if (tzSelect) {
    const options = getAppTimeZoneOptions();
    tzSelect.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    tzSelect.value = getAppTimeZone();
    tzSelect.addEventListener('change', () => {
      setAppTimeZone(tzSelect.value);
      // Sync gear panel timezone select
      const gearTz = document.getElementById('global-timezone-select') as HTMLSelectElement | null;
      if (gearTz) gearTz.value = tzSelect.value;
    });
  }

  // Minichart toggle
  const mcContainer = document.getElementById('admin-minichart-btns');
  if (mcContainer) {
    const mcBtns = mcContainer.querySelectorAll<HTMLElement>('[data-minichart]');
    const storedMc = localStorage.getItem('minichart_mobile') || 'off';
    mcBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.minichart === storedMc);
      btn.addEventListener('click', () => {
        const val = btn.dataset.minichart || 'off';
        mcBtns.forEach((b) => b.classList.toggle('active', b.dataset.minichart === val));
        // Sync gear panel minichart buttons
        document.querySelectorAll('#global-minichart-btns [data-minichart]').forEach((b) => {
          (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.minichart === val);
        });
        try {
          localStorage.setItem('minichart_mobile', val);
        } catch {
          /* ignore */
        }
        window.dispatchEvent(new CustomEvent('minichartmobilechange', { detail: { value: val } }));
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Data Fetching
// ---------------------------------------------------------------------------

async function fetchAdminStatus(): Promise<AdminStatusPayload> {
  const res = await fetch('/api/admin/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Admin status fetch failed (HTTP ${res.status})`);
  return res.json() as Promise<AdminStatusPayload>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function refreshAdminView(): Promise<void> {
  if (adminRefreshInFlight) return;
  adminRefreshInFlight = true;

  const healthRefreshBtn = document.getElementById('admin-health-refresh-btn');
  const metricsRefreshBtn = document.getElementById('admin-metrics-refresh-btn');
  healthRefreshBtn?.classList.add('loading');
  metricsRefreshBtn?.classList.add('loading');

  try {
    const [statusData, metricsData] = await Promise.all([
      fetchAdminStatus().catch(() => null),
      fetchRunMetricsPayload().catch(() => null),
    ]);

    if (statusData) renderHealthCards(statusData);
    if (metricsData) {
      renderRunCards(metricsData);
      historyEntries = Array.isArray(metricsData.history) ? metricsData.history : [];
      renderHistoryPage();
    }
  } catch (err: unknown) {
    console.error('Failed to refresh admin view:', err);
  } finally {
    adminRefreshInFlight = false;
    healthRefreshBtn?.classList.remove('loading');
    metricsRefreshBtn?.classList.remove('loading');
  }
}

export function initAdminView(): void {
  if (adminInitialized) return;
  adminInitialized = true;

  // Inject refresh SVG icons
  const healthRefreshBtn = document.getElementById('admin-health-refresh-btn');
  const metricsRefreshBtn = document.getElementById('admin-metrics-refresh-btn');
  if (healthRefreshBtn && healthRefreshBtn.childElementCount === 0) {
    healthRefreshBtn.appendChild(createRefreshSvgIcon());
  }
  if (metricsRefreshBtn && metricsRefreshBtn.childElementCount === 0) {
    metricsRefreshBtn.appendChild(createRefreshSvgIcon());
  }

  // Refresh button click handlers
  healthRefreshBtn?.addEventListener('click', () => {
    refreshAdminView().catch(() => {});
  });
  metricsRefreshBtn?.addEventListener('click', () => {
    refreshAdminView().catch(() => {});
  });

  // History pagination (event delegation)
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.admin-history-prev')) {
      if (historyPage > 0) {
        historyPage--;
        renderHistoryPage();
      }
    } else if (target.closest('.admin-history-next')) {
      const totalPages = Math.ceil(historyEntries.length / HISTORY_PAGE_SIZE);
      if (historyPage < totalPages - 1) {
        historyPage++;
        renderHistoryPage();
      }
    }
  });

  // Wire preferences
  initAdminPreferences();

  // Initial data load
  refreshAdminView().catch(() => {});
}

const ADMIN_POLL_INTERVAL_MS = 10000;

export function startAdminPolling(): void {
  if (adminPollTimer !== null) return;
  adminPollTimer = window.setInterval(() => {
    refreshAdminView().catch(() => {});
  }, ADMIN_POLL_INTERVAL_MS);
}

export function stopAdminPolling(): void {
  if (adminPollTimer === null) return;
  window.clearInterval(adminPollTimer);
  adminPollTimer = null;
}

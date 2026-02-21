/**
 * Pure status text formatters for divergence scan control UI.
 * All functions take DivergenceScanStatus data and return display strings.
 * No DOM access, no side effects.
 */

import type { DivergenceScanStatus } from './divergenceApi';

export function toStatusTextFromError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error || '')).trim();
  if (!message) return 'Run failed';
  if (/not configured/i.test(message)) return 'DB issue';
  if (/unauthorized/i.test(message)) return 'Unauthorized';
  if (/already running|running/i.test(message)) return 'Running';
  return message.length > 56 ? `${message.slice(0, 56)}...` : message;
}

export function toDateKey(raw?: string | null): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function toDateKeyAsET(raw?: string | null): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const parts = d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [mm, dd, yyyy] = parts.split('/');
  if (!mm || !dd || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

export function dateKeyToMmDd(dateKey: string): string {
  const parts = dateKey.split('-');
  if (parts.length !== 3) return '';
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(month) || month <= 0 || !Number.isFinite(day) || day <= 0) return '';
  return `${month}/${day}`;
}

export function summarizeLastRunDate(status: DivergenceScanStatus): string {
  const latest = status.latestJob as
    | (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string })
    | null;
  const runDateKey =
    toDateKey(status.lastScanDateEt) ||
    toDateKey(latest?.scanned_trade_date) ||
    toDateKey(latest?.run_for_date) ||
    toDateKey(latest?.finished_at) ||
    toDateKey(latest?.started_at);

  if (!runDateKey) return 'Fetched';
  const mmdd = dateKeyToMmDd(runDateKey);
  return mmdd ? `Fetched ${mmdd}` : 'Fetched';
}

export function summarizeStatus(status: DivergenceScanStatus): string {
  const latest = status.latestJob;
  const scan = status.scanControl || null;
  if (status.running) {
    const processed = Number(latest?.processed_symbols || 0);
    const total = Number(latest?.total_symbols || 0);
    if (scan?.stop_requested) {
      if (total > 0) return `Stopping ${processed}/${total}`;
      return 'Stopping';
    }
    if (scan?.pause_requested) {
      if (total > 0) return `Pausing ${processed}/${total}`;
      return 'Pausing';
    }
    if (total > 0) return `Running ${processed}/${total}`;
    return 'Running';
  }

  if (latest?.status === 'paused') {
    const processed = Number(latest?.processed_symbols || 0);
    const total = Number(latest?.total_symbols || 0);
    if (total > 0) return `Paused ${processed}/${total}`;
    return 'Paused';
  }
  if (latest?.status === 'stopped') return 'Stopped';
  if (latest?.status === 'completed') return summarizeLastRunDate(status);
  if (latest?.status === 'failed') return 'Last run failed';
  if (status.lastScanDateEt || latest?.run_for_date || latest?.finished_at || latest?.started_at) {
    return summarizeLastRunDate(status);
  }
  return 'Idle';
}

export function summarizeTableStatus(status: DivergenceScanStatus): string {
  const table = status.tableBuild;
  if (!table) return 'Table idle';
  const tableState = String(table.status || '').toLowerCase();
  const errorTickers = Number(table.error_tickers || 0);
  if (tableState === 'stopped') return 'Table stopped';
  if (tableState === 'paused') {
    const processed = Number(table.processed_tickers || 0);
    const total = Number(table.total_tickers || 0);
    if (total > 0) return `Paused ${processed}/${total}`;
    return 'Table paused';
  }
  if (table.running) {
    const processed = Number(table.processed_tickers || 0);
    const total = Number(table.total_tickers || 0);
    if (table.stop_requested) {
      if (total > 0) return `Stopping ${processed}/${total}`;
      return 'Stopping';
    }
    if (table.pause_requested) {
      if (total > 0) return `Pausing ${processed}/${total}`;
      return 'Pausing';
    }
    if (total > 0) return `Table ${processed}/${total}`;
    return 'Table running';
  }
  if (tableState === 'completed') {
    const dateKey = toDateKey(table.last_published_trade_date || null);
    const mmdd = dateKey ? dateKeyToMmDd(dateKey) : '';
    return mmdd ? `Table ${mmdd}` : 'Table fetched';
  }
  if (tableState === 'completed-with-errors') {
    const dateKey = toDateKey(table.last_published_trade_date || null);
    const mmdd = dateKey ? dateKeyToMmDd(dateKey) : '';
    if (mmdd && errorTickers > 0) return `Table ${mmdd} (${errorTickers} errors)`;
    if (errorTickers > 0) return `Table done (${errorTickers} errors)`;
    return mmdd ? `Table ${mmdd}` : 'Table fetched';
  }
  if (tableState === 'failed') return 'Table failed';
  return 'Table idle';
}

function summarizeFetchDataStatus(
  fetchData: DivergenceScanStatus['fetchDailyData'],
  status: DivergenceScanStatus,
): string {
  const latest = status.latestJob as
    | (DivergenceScanStatus['latestJob'] & { run_for_date?: string; scanned_trade_date?: string })
    | null;
  const lastRunDateKey =
    toDateKey(fetchData?.last_published_trade_date || null) ||
    toDateKey(status.lastScanDateEt) ||
    toDateKey(latest?.scanned_trade_date) ||
    toDateKey(latest?.run_for_date) ||
    toDateKey(latest?.finished_at) ||
    toDateKey(latest?.started_at);
  const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
  if (!fetchData) return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
  const state = String(fetchData.status || '').toLowerCase();
  if (state === 'stopping') return 'Stopping';
  if (state === 'stopped') {
    if (fetchData.can_resume) return 'Resumable Stop';
    return 'Stopped';
  }
  if (fetchData.running) {
    const processed = Number(fetchData.processed_tickers || 0);
    const total = Number(fetchData.total_tickers || 0);
    if (fetchData.stop_requested) return 'Stopping';
    if (state === 'running-retry') return 'Retrying';
    if (state === 'running-ma') return `MA ${processed} / ${total}`;
    if (state === 'running-ma-retry') return 'MA - Retrying';
    return `${processed} / ${total}`;
  }
  if (state === 'completed') return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
  if (state === 'completed-with-errors') return lastRunMmDd ? `Fetched (E) ${lastRunMmDd}` : 'Due for Fetch';
  if (state === 'failed') return lastRunMmDd ? `Failed ${lastRunMmDd}` : 'Due for Fetch';
  return lastRunMmDd ? `Fetched ${lastRunMmDd}` : 'Due for Fetch';
}

export function summarizeFetchDailyStatus(status: DivergenceScanStatus): string {
  return summarizeFetchDataStatus(status.fetchDailyData, status);
}

export function summarizeFetchWeeklyStatus(status: DivergenceScanStatus): string {
  return summarizeFetchDataStatus(status.fetchWeeklyData, status);
}

export function summarizeVDFScanStatus(status: DivergenceScanStatus): string {
  const scan = status.vdfScan;
  if (!scan) return 'Due for Fetch';
  const state = String(scan.status || '').toLowerCase();
  const lastRunDateKey = toDateKeyAsET(scan.finished_at || scan.started_at || null);
  const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : '';
  if (state === 'stopping') return 'Stopping';
  if (state === 'stopped') {
    if (scan.can_resume) return 'Resumable Stop';
    return 'Stopped';
  }
  if (scan.running) {
    const processed = Number(scan.processed_tickers || 0);
    const total = Number(scan.total_tickers || 0);
    if (scan.stop_requested) return 'Stopping';
    if (state === 'running-retry') return 'Retrying';
    return `${processed} / ${total}`;
  }
  if (state === 'completed') return lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Due for Fetch';
  if (state === 'completed-with-errors') return lastRunMmDd ? `Ran (E) ${lastRunMmDd}` : 'Due for Fetch';
  if (state === 'failed') return lastRunMmDd ? `Failed ${lastRunMmDd}` : 'Due for Fetch';
  return lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Due for Fetch';
}

export function summarizeBreadthStatus(
  breadth: { running: boolean; status: string; finished_at?: string | null } | null,
): string {
  if (!breadth) return 'Ran --';
  const statusText = String(breadth.status || '').trim();
  if (breadth.running) {
    return statusText || 'Running...';
  }
  const lastRunMmDd = breadth.finished_at
    ? (() => {
        const key = toDateKeyAsET(breadth.finished_at);
        return key ? dateKeyToMmDd(key) : '';
      })()
    : '';
  if (statusText.startsWith('Done')) return lastRunMmDd ? `Ran ${lastRunMmDd}` : 'Ran --';
  if (statusText.startsWith('Stopped')) return lastRunMmDd ? `Stopped ${lastRunMmDd}` : 'Stopped';
  if (statusText.startsWith('Error')) return lastRunMmDd ? `Failed ${lastRunMmDd}` : 'Failed';
  if (lastRunMmDd) return `Ran ${lastRunMmDd}`;
  return 'Ran --';
}

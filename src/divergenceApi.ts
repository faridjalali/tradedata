import { Alert } from './types';
import { getPreferredDivergenceSourceInterval } from './divergenceTable';

function toFavoriteBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value === 1;
  return false;
}

function normalizeAlert(raw: unknown): Alert {
  const item = raw as Partial<Alert> & { id?: unknown; is_favorite?: unknown };
  const id = Number(item.id);

  if (!Number.isFinite(id)) {
    throw new Error('Invalid divergence payload: missing/invalid id');
  }

  return {
    ...item,
    id,
    is_favorite: toFavoriteBoolean(item.is_favorite),
    source: 'DataAPI',
  } as Alert;
}

export async function fetchDivergenceSignalsFromApi(
  params: string = '',
  options: { signal?: AbortSignal } = {},
): Promise<Alert[]> {
  try {
    const query = new URLSearchParams(String(params || '').replace(/^\?/, ''));
    query.set('vd_source_interval', getPreferredDivergenceSourceInterval());
    const response = await fetch(`/api/divergence/signals?${query.toString()}`, { signal: options.signal });
    if (!response.ok) throw new Error('Network response was not ok');
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('Invalid divergence payload: expected array');
    }
    return payload.map(normalizeAlert);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw error;
    }
    console.error('Error fetching divergence signals:', error);
    throw error;
  }
}

export async function toggleDivergenceFavorite(id: number): Promise<Alert> {
  const response = await fetch(`/api/divergence/signals/${id}/favorite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as { error?: string });
    const reason =
      typeof payload?.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `Favorite toggle failed (HTTP ${response.status})`;
    throw new Error(reason);
  }
  return normalizeAlert(await response.json());
}

export type { DivergenceScanStatus } from '../shared/api-types';
import type { DivergenceScanStatus } from '../shared/api-types';

export async function startDivergenceScan(options?: {
  force?: boolean;
  refreshUniverse?: boolean;
  runDateEt?: string;
}): Promise<{ status: string }> {
  const response = await fetch('/api/divergence/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      force: options?.force ?? true,
      refreshUniverse: options?.refreshUniverse ?? true,
      runDateEt: options?.runDateEt,
    }),
  });
  const payload = await response.json().catch(() => ({}) as { status?: string; error?: string });
  if (!response.ok) {
    if (response.status === 409 && String(payload?.status || '') === 'running') {
      return { status: 'running' };
    }
    const reason =
      typeof payload?.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `Failed to start divergence scan (HTTP ${response.status})`;
    throw new Error(reason);
  }
  return { status: String(payload?.status || 'started') };
}

// ---------------------------------------------------------------------------
// Shared POST helper — all divergence action endpoints follow the same pattern
// ---------------------------------------------------------------------------

async function postDivergenceAction(
  url: string,
  opts: {
    body?: Record<string, unknown>;
    label: string;
    defaultStatus: string;
    on409?: 'return-status' | 'return-running';
  },
): Promise<{ status: string }> {
  const bodyPayload = opts.body ?? {};
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload),
  });
  const payload = await response.json().catch(() => ({}) as { status?: string; error?: string });
  if (!response.ok) {
    if (response.status === 409) {
      if (opts.on409 === 'return-running' && String(payload?.status || '') === 'running') {
        return { status: 'running' };
      }
      if (opts.on409 === 'return-status' && typeof payload?.status === 'string') {
        return { status: payload.status };
      }
    }
    const reason =
      typeof payload?.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `Failed to ${opts.label} (HTTP ${response.status})`;
    throw new Error(reason);
  }
  return { status: String(payload?.status || opts.defaultStatus) };
}

// ---------------------------------------------------------------------------
// Scan control actions
// ---------------------------------------------------------------------------

export const pauseDivergenceScan = () =>
  postDivergenceAction('/api/divergence/scan/pause', {
    label: 'pause divergence scan',
    defaultStatus: 'pause-requested',
    on409: 'return-status',
  });

export const resumeDivergenceScan = () =>
  postDivergenceAction('/api/divergence/scan/resume', {
    label: 'resume divergence scan',
    defaultStatus: 'started',
    on409: 'return-status',
  });

export const stopDivergenceScan = () =>
  postDivergenceAction('/api/divergence/scan/stop', {
    label: 'stop divergence scan',
    defaultStatus: 'stop-requested',
    on409: 'return-status',
  });

// ---------------------------------------------------------------------------
// Table build actions
// ---------------------------------------------------------------------------

export const startDivergenceTableBuild = () =>
  postDivergenceAction('/api/divergence/table/run', {
    body: { force: true },
    label: 'start table build',
    defaultStatus: 'started',
    on409: 'return-running',
  });

export const pauseDivergenceTableBuild = () =>
  postDivergenceAction('/api/divergence/table/pause', {
    label: 'pause table build',
    defaultStatus: 'pause-requested',
    on409: 'return-status',
  });

export const resumeDivergenceTableBuild = () =>
  postDivergenceAction('/api/divergence/table/resume', {
    label: 'resume table build',
    defaultStatus: 'started',
    on409: 'return-status',
  });

export const stopDivergenceTableBuild = () =>
  postDivergenceAction('/api/divergence/table/stop', {
    label: 'stop table build',
    defaultStatus: 'stop-requested',
    on409: 'return-status',
  });

// ---------------------------------------------------------------------------
// Fetch daily / weekly data actions
// ---------------------------------------------------------------------------

export const startDivergenceFetchDailyData = () =>
  postDivergenceAction('/api/divergence/fetch-daily/run', {
    label: 'start fetch-daily run',
    defaultStatus: 'started',
    on409: 'return-running',
  });

export const stopDivergenceFetchDailyData = () =>
  postDivergenceAction('/api/divergence/fetch-daily/stop', {
    label: 'stop fetch-daily run',
    defaultStatus: 'stop-requested',
    on409: 'return-status',
  });

export const startDivergenceFetchWeeklyData = () =>
  postDivergenceAction('/api/divergence/fetch-weekly/run', {
    label: 'start fetch-weekly run',
    defaultStatus: 'started',
    on409: 'return-running',
  });

export const stopDivergenceFetchWeeklyData = () =>
  postDivergenceAction('/api/divergence/fetch-weekly/stop', {
    label: 'stop fetch-weekly run',
    defaultStatus: 'stop-requested',
    on409: 'return-status',
  });

// ---------------------------------------------------------------------------
// VDF scan actions
// ---------------------------------------------------------------------------

export const startVDFScan = () =>
  postDivergenceAction('/api/divergence/vdf-scan/run', {
    label: 'start VDF scan',
    defaultStatus: 'started',
    on409: 'return-running',
  });

export const stopVDFScan = () =>
  postDivergenceAction('/api/divergence/vdf-scan/stop', {
    label: 'stop VDF scan',
    defaultStatus: 'stop-requested',
    on409: 'return-status',
  });

export async function fetchDivergenceScanStatus(): Promise<DivergenceScanStatus> {
  const response = await fetch('/api/divergence/scan/status');
  const payload = (await response.json().catch(() => null)) as (DivergenceScanStatus & { error?: string }) | null;
  if (!response.ok || !payload) {
    const reason =
      typeof payload?.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : 'Failed to fetch divergence scan status';
    throw new Error(reason);
  }
  return payload;
}

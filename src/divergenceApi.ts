import { Alert } from './types';

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
        source: 'FMP',
    } as Alert;
}

export async function fetchDivergenceSignalsFromApi(params: string = ''): Promise<Alert[]> {
    try {
        const response = await fetch(`/api/divergence/signals${params}`);
        if (!response.ok) throw new Error('Network response was not ok');
        const payload = await response.json();
        if (!Array.isArray(payload)) {
            throw new Error('Invalid divergence payload: expected array');
        }
        return payload.map(normalizeAlert);
    } catch (error) {
        console.error('Error fetching divergence signals:', error);
        throw error;
    }
}

export async function toggleDivergenceFavorite(id: number): Promise<Alert> {
    const response = await fetch(`/api/divergence/signals/${id}/favorite`, {
        method: 'POST'
    });
    if (!response.ok) {
        throw new Error('Network response was not ok');
    }
    return normalizeAlert(await response.json());
}

export interface DivergenceScanStatus {
    running: boolean;
    lastScanDateEt: string | null;
    scanControl?: {
        running?: boolean;
        pause_requested?: boolean;
        stop_requested?: boolean;
        can_resume?: boolean;
    } | null;
    tableBuild?: {
        running?: boolean;
        pause_requested?: boolean;
        stop_requested?: boolean;
        can_resume?: boolean;
        status?: string;
        total_tickers?: number;
        processed_tickers?: number;
        error_tickers?: number;
        started_at?: string | null;
        finished_at?: string | null;
        last_published_trade_date?: string | null;
    } | null;
    latestJob: {
        run_for_date?: string;
        scanned_trade_date?: string;
        status?: string;
        started_at?: string;
        finished_at?: string;
        processed_symbols?: number;
        total_symbols?: number;
        bullish_count?: number;
        bearish_count?: number;
        error_count?: number;
    } | null;
}

export async function startDivergenceScan(options?: { force?: boolean; refreshUniverse?: boolean; runDateEt?: string }): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/scan', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            force: options?.force ?? true,
            refreshUniverse: options?.refreshUniverse ?? true,
            runDateEt: options?.runDateEt
        })
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && String(payload?.status || '') === 'running') {
            return { status: 'running' };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to start divergence scan (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'started') };
}

export async function pauseDivergenceScan(): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/scan/pause', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && typeof payload?.status === 'string') {
            return { status: payload.status };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to pause divergence scan (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'pause-requested') };
}

export async function resumeDivergenceScan(): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/scan/resume', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && typeof payload?.status === 'string') {
            return { status: payload.status };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to resume divergence scan (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'started') };
}

export async function stopDivergenceScan(): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/scan/stop', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && typeof payload?.status === 'string') {
            return { status: payload.status };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to stop divergence scan (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'stop-requested') };
}

export async function startDivergenceTableBuild(): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/table/run', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            force: true
        })
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && String(payload?.status || '') === 'running') {
            return { status: 'running' };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to start table build (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'started') };
}

export async function pauseDivergenceTableBuild(): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/table/pause', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && typeof payload?.status === 'string') {
            return { status: payload.status };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to pause table build (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'pause-requested') };
}

export async function resumeDivergenceTableBuild(): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/table/resume', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && typeof payload?.status === 'string') {
            return { status: payload.status };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to resume table build (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'started') };
}

export async function stopDivergenceTableBuild(): Promise<{ status: string }> {
    const response = await fetch('/api/divergence/table/stop', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    });
    const payload = await response.json().catch(() => ({} as { status?: string; error?: string }));
    if (!response.ok) {
        if (response.status === 409 && typeof payload?.status === 'string') {
            return { status: payload.status };
        }
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : `Failed to stop table build (HTTP ${response.status})`;
        throw new Error(reason);
    }
    return { status: String(payload?.status || 'stop-requested') };
}

export async function fetchDivergenceScanStatus(): Promise<DivergenceScanStatus> {
    const response = await fetch('/api/divergence/scan/status');
    const payload = await response.json().catch(() => null as any);
    if (!response.ok || !payload) {
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : 'Failed to fetch divergence scan status';
        throw new Error(reason);
    }
    return {
        running: Boolean((payload as any).running),
        lastScanDateEt: (payload as any).lastScanDateEt ?? null,
        scanControl: (payload as any).scanControl ?? null,
        tableBuild: (payload as any).tableBuild ?? null,
        latestJob: (payload as any).latestJob ?? null
    };
}

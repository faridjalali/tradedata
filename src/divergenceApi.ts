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
    latestJob: {
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
        latestJob: (payload as any).latestJob ?? null
    };
}

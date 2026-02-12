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


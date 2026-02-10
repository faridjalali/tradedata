import { Alert } from './types';

export async function fetchAlertsFromApi(params: string = ''): Promise<Alert[]> {
    try {
        const response = await fetch(`/api/alerts${params}`);
        if (!response.ok) throw new Error('Network response was not ok');
        return await response.json();
    } catch (error) {
        console.error('Error fetching alerts:', error);
        return [];
    }
}

export async function toggleFavorite(id: number): Promise<Alert> {
    const response = await fetch(`/api/alerts/${id}/favorite`, {
        method: 'POST'
    });
    if (!response.ok) {
        throw new Error('Network response was not ok');
    }
    return await response.json();
}

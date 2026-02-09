// API interaction

export async function fetchAlertsFromApi(params = '') {
    try {
        const response = await fetch(`/api/alerts${params}`);
        if (!response.ok) throw new Error('Network response was not ok');
        return await response.json();
    } catch (error) {
        console.error('Error fetching alerts:', error);
        return [];
    }
}

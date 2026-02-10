import { fetchAlertsFromApi } from './api';
import { Alert } from './types';
import { escapeHtml } from './utils';

interface Stats {
    dailyBull: number;
    dailyBear: number;
    weeklyBull: number;
    weeklyBear: number;
}

interface LeaderboardItem {
    ticker: string;
    count: number;
}

export async function fetchLeaderboardData(): Promise<void> {
    const activeBtn = document.querySelector('#leaderboard-controls .tf-btn.active') as HTMLElement;
    const days = activeBtn ? activeBtn.dataset.days : '30';
    
    try {
        const data = await fetchAlertsFromApi(`?days=${days}`);
        calculateAndRenderLeaderboard(data);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
    }
}

function calculateAndRenderLeaderboard(data: Alert[]): void {
    const stats: Record<string, Stats> = {};

    data.forEach(a => {
        if (!stats[a.ticker]) stats[a.ticker] = { dailyBull: 0, dailyBear: 0, weeklyBull: 0, weeklyBear: 0 };
        const isBull = a.signal_type && a.signal_type.toLowerCase().includes('bull');
        const isWeekly = a.timeframe === '1w';
        
        if (isWeekly) {
            if (isBull) stats[a.ticker].weeklyBull++;
            else stats[a.ticker].weeklyBear++;
        } else {
            if (isBull) stats[a.ticker].dailyBull++;
            else stats[a.ticker].dailyBear++;
        }
    });

    const tickers = Object.keys(stats);

    const getTop = (key: keyof Stats): LeaderboardItem[] => {
        return tickers
            .map(t => ({ ticker: t, count: stats[t][key] }))
            .filter(x => x.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
    };

    renderTable('lb-daily-bull', getTop('dailyBull'));
    renderTable('lb-daily-bear', getTop('dailyBear'));
    renderTable('lb-weekly-bull', getTop('weeklyBull'));
    renderTable('lb-weekly-bear', getTop('weeklyBear'));
}

function renderTable(elementId: string, items: LeaderboardItem[]): void {
    const table = document.getElementById(elementId);
    if (!table) return;

    if (items.length === 0) {
        table.innerHTML = '<tr><td colspan="2" style="text-align:center; color:#8b949e">No signals found</td></tr>';
        return;
    }
    table.innerHTML = `
        <tbody>
            ${items.map(item => `
                <tr class="clickable-row" data-ticker="${escapeHtml(item.ticker)}">
                    <td>${escapeHtml(item.ticker)}</td>
                    <td>${item.count}</td>
                </tr>
            `).join('')}
        </tbody>
    `;
}

// Event delegation for leaderboard — set up once
export function setupLeaderboardDelegation(): void {
    const leaderboardView = document.getElementById('view-leaderboard');
    if (!leaderboardView) return;

    leaderboardView.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const row = target.closest('.clickable-row') as HTMLElement;
        if (row && row.dataset.ticker && window.showTickerView) {
            window.showTickerView(row.dataset.ticker);
        }
    });
}

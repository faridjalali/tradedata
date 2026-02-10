import { fetchAlertsFromApi } from './api';
import { Alert } from './types';
import { escapeHtml } from './utils';

interface TickerStats {
    dailyBullSum: number;
    dailyBullCount: number;
    dailyBearSum: number;
    dailyBearCount: number;
    weeklyBullSum: number;
    weeklyBullCount: number;
    weeklyBearSum: number;
    weeklyBearCount: number;
}

interface LeaderboardItem {
    ticker: string;
    avgScore: number;
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
    const stats: Record<string, TickerStats> = {};

    data.forEach(a => {
        if (!stats[a.ticker]) stats[a.ticker] = {
            dailyBullSum: 0, dailyBullCount: 0,
            dailyBearSum: 0, dailyBearCount: 0,
            weeklyBullSum: 0, weeklyBullCount: 0,
            weeklyBearSum: 0, weeklyBearCount: 0,
        };
        const score = a.combo_score || 0;
        const isBull = a.signal_type && a.signal_type.toLowerCase().includes('bull');
        const isWeekly = a.timeframe === '1w';
        
        if (isWeekly) {
            if (isBull) { stats[a.ticker].weeklyBullSum += score; stats[a.ticker].weeklyBullCount++; }
            else { stats[a.ticker].weeklyBearSum += score; stats[a.ticker].weeklyBearCount++; }
        } else {
            if (isBull) { stats[a.ticker].dailyBullSum += score; stats[a.ticker].dailyBullCount++; }
            else { stats[a.ticker].dailyBearSum += score; stats[a.ticker].dailyBearCount++; }
        }
    });

    const tickers = Object.keys(stats);

    const getTop = (sumKey: keyof TickerStats, countKey: keyof TickerStats): LeaderboardItem[] => {
        return tickers
            .filter(t => (stats[t][countKey] as number) > 0)
            .map(t => ({
                ticker: t,
                avgScore: Math.round((stats[t][sumKey] as number) / (stats[t][countKey] as number)),
            }))
            .sort((a, b) => b.avgScore - a.avgScore)
            .slice(0, 10);
    };

    renderTable('lb-daily-bull', getTop('dailyBullSum', 'dailyBullCount'));
    renderTable('lb-daily-bear', getTop('dailyBearSum', 'dailyBearCount'));
    renderTable('lb-weekly-bull', getTop('weeklyBullSum', 'weeklyBullCount'));
    renderTable('lb-weekly-bear', getTop('weeklyBearSum', 'weeklyBearCount'));
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
                    <td>${item.avgScore}</td>
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

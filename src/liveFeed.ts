import { getCurrentWeekISO, getCurrentMonthISO } from './utils';
import { fetchAlertsFromApi } from './api';
import { setAlerts, getAlerts } from './state';
import { createAlertCard } from './components';
import { LiveFeedMode, SortMode, Alert } from './types';

let liveFeedMode: LiveFeedMode = '1'; 
let dailySortMode: SortMode = 'time';
let weeklySortMode: SortMode = 'time';

// We need to declare the window Interface extension to avoid TS errors
declare global {
    interface Window {
        showTickerView: (ticker: string) => void;
        showOverview: () => void;
        setDailySort: (mode: SortMode) => void;
        setWeeklySort: (mode: SortMode) => void;
        setTickerSort: (mode: SortMode) => void;
    }
}

export function getLiveFeedMode(): LiveFeedMode {
    return liveFeedMode;
}

export function setLiveFeedModeState(mode: LiveFeedMode): void {
    liveFeedMode = mode;
}

export function isCurrentTimeframe(): boolean {
    if (liveFeedMode === '30' || liveFeedMode === '7' || liveFeedMode === '1') return true; 
    if (liveFeedMode === 'week') {
        const val = (document.getElementById('history-week') as HTMLInputElement).value;
        return val === getCurrentWeekISO();
    } else {
        const val = (document.getElementById('history-month') as HTMLInputElement).value;
        return val === getCurrentMonthISO();
    }
}

export async function fetchLiveAlerts(_force?: boolean): Promise<Alert[]> {
    try {
        let params = '';
        let startDate = '', endDate = '';
        
        if (liveFeedMode === '30') {
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - 30);
            endDate = end.toISOString();
            startDate = start.toISOString();
        } else if (liveFeedMode === '7') {
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - 7);
            endDate = end.toISOString();
            startDate = start.toISOString();
        } else if (liveFeedMode === '1') {
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - 1);
            endDate = end.toISOString();
            startDate = start.toISOString();
        } else if (liveFeedMode === 'week') {
            const val = (document.getElementById('history-week') as HTMLInputElement).value;
            if (!val) return []; 
            const parts = val.split('-W');
            const yearStr = parts[0];
            const weekStr = parts[1];
            
            const year = parseInt(yearStr);
            const week = parseInt(weekStr);
            const d = new Date(year, 0, 4);
            const dayShift = d.getDay() === 0 ? 6 : d.getDay() - 1;
            const week1Monday = new Date(d.setDate(d.getDate() - dayShift));
            const monday = new Date(week1Monday.setDate(week1Monday.getDate() + (week - 1) * 7));
            monday.setHours(0,0,0,0);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            sunday.setHours(23,59,59,999);
            startDate = monday.toISOString();
            endDate = sunday.toISOString();
        } else {
            const val = (document.getElementById('history-month') as HTMLInputElement).value;
            if (!val) return [];
            const parts = val.split('-');
            const year = Number(parts[0]);
            const month = Number(parts[1]);
            
            const start = new Date(year, month - 1, 1);
            const end = new Date(year, month, 0); 
            end.setHours(23,59,59,999);
            startDate = start.toISOString();
            endDate = end.toISOString();
        }
        
        params = `?start_date=${startDate}&end_date=${endDate}`;

        const data = await fetchAlertsFromApi(params);
        setAlerts(data);
        
        return data; 
    } catch (error) {
        console.error('Error fetching live alerts:', error);
        return [];
    }
}



export function renderOverview(): void {
    const allAlerts = getAlerts();
    document.getElementById('ticker-view')!.classList.add('hidden');
    document.getElementById('dashboard-view')!.classList.remove('hidden');
    document.getElementById('reset-filter')!.classList.add('hidden');
    
    const dailyContainer = document.getElementById('daily-container')!;
    const weeklyContainer = document.getElementById('weekly-container')!;
    
    let daily = allAlerts.filter(a => (a.timeframe || '').trim() === '1d');
    let weekly = allAlerts.filter(a => (a.timeframe || '').trim() === '1w');
    
    const applySort = (list: Alert[], mode: SortMode) => {
        list.sort((a, b) => {
            if (mode === 'volume') {
                return (b.signal_volume || 0) - (a.signal_volume || 0);
            } else if (mode === 'intensity') {
                return (b.intensity_score || 0) - (a.intensity_score || 0);
            } else if (mode === 'combo') {
                return (b.combo_score || 0) - (a.combo_score || 0);
            } else if (mode === 'time') {
                return (b.timestamp || '').localeCompare(a.timestamp || '');
            } else {
                return (a.ticker || '').localeCompare(b.ticker || '');
            }
        });
    };

    applySort(daily, dailySortMode);
    applySort(weekly, weeklySortMode);
    
    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    
    // The previous `attachClickHandlers` function is replaced by event delegation
    // set up in `setupLiveFeedDelegation` which should be called once.
}

export function setupLiveFeedDelegation(): void {
    const dashboard = document.getElementById('dashboard-view');
    if (!dashboard) return;

    dashboard.addEventListener('click', (e) => {
        const card = (e.target as HTMLElement).closest('.alert-card');
        if (card) {
            const ticker = (card as HTMLElement).dataset.ticker;
            if (ticker && window.showTickerView) {
                window.showTickerView(ticker);
            }
        }
    });
}

export function setDailySort(mode: SortMode): void {
    dailySortMode = mode;
    // Update active button state in daily column
    const dailyHeader = document.querySelector('#dashboard-view .column:first-child .header-sort-controls');
    if (dailyHeader) {
        dailyHeader.querySelectorAll('.tf-btn').forEach(btn => {
            const el = btn as HTMLElement;
            if (el.dataset.sort === mode) el.classList.add('active');
            else el.classList.remove('active');
        });
    }
    renderOverview();
}

export function setWeeklySort(mode: SortMode): void {
    weeklySortMode = mode;
    // Update active button state in weekly column
    const weeklyHeader = document.querySelector('#dashboard-view .column:last-child .header-sort-controls');
    if (weeklyHeader) {
        weeklyHeader.querySelectorAll('.tf-btn').forEach(btn => {
            const el = btn as HTMLElement;
            if (el.dataset.sort === mode) el.classList.add('active');
            else el.classList.remove('active');
        });
    }
    renderOverview();
}

// Live Feed Logic
import { getCurrentWeekISO, getCurrentMonthISO } from './utils.js';
import { fetchAlertsFromApi } from './api.js';
import { setAlerts, getAlerts } from './state.js';
import { createAlertCard } from './components.js';

let liveFeedMode = '30'; // '30', '7', 'week', 'month'
let dailySortMode = 'time';
let weeklySortMode = 'time';

export function getLiveFeedMode() {
    return liveFeedMode;
}

export function setLiveFeedModeState(mode) {
    liveFeedMode = mode;
}

export function isCurrentTimeframe() {
    if (liveFeedMode === '30' || liveFeedMode === '7') return true; 
    if (liveFeedMode === 'week') {
        const val = document.getElementById('history-week').value;
        return val === getCurrentWeekISO();
    } else {
        const val = document.getElementById('history-month').value;
        return val === getCurrentMonthISO();
    }
}

export async function fetchLiveAlerts(force = false) {
    try {
        let params = '';
        let startDate, endDate;
        
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
        } else if (liveFeedMode === 'week') {
            const val = document.getElementById('history-week').value;
            if (!val) return; 
            const [yearStr, weekStr] = val.split('-W');
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
            const val = document.getElementById('history-month').value;
            if (!val) return;
            const [year, month] = val.split('-').map(Number);
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
        // Note: The caller (main.js) should decide whether to renderOverview or renderTickerView
    } catch (error) {
        console.error('Error fetching live alerts:', error);
    }
}

export function setDailySort(mode) {
    dailySortMode = mode;
    updateSortIcons('daily', mode);
    renderOverview();
}

export function setWeeklySort(mode) {
    weeklySortMode = mode;
    updateSortIcons('weekly', mode);
    renderOverview();
}

function updateSortIcons(context, mode) {
    const colIndex = context === 'daily' ? 0 : 1;
    const container = document.querySelectorAll('#dashboard-view .column-header')[colIndex];
    if (!container) return;
    
    const buttons = container.querySelectorAll('.icon-btn');
    if (mode === 'time') {
        buttons[0].classList.add('active');
        buttons[1].classList.remove('active');
    } else {
        buttons[0].classList.remove('active');
        buttons[1].classList.add('active');
    }
}

export function renderOverview() {
    const allAlerts = getAlerts();
    document.getElementById('ticker-view').classList.add('hidden');
    document.getElementById('dashboard-view').classList.remove('hidden');
    document.getElementById('reset-filter').classList.add('hidden');
    
    const dailyContainer = document.getElementById('daily-container');
    const weeklyContainer = document.getElementById('weekly-container');
    
    let daily = allAlerts.filter(a => (a.timeframe || '').trim() === '1d');
    let weekly = allAlerts.filter(a => (a.timeframe || '').trim() === '1w');
    
    const applySort = (list, mode) => {
        list.sort((a, b) => {
            if (mode === 'time') {
                return new Date(b.timestamp) - new Date(a.timestamp);
            } else {
                return a.ticker.localeCompare(b.ticker);
            }
        });
    };

    applySort(daily, dailySortMode);
    applySort(weekly, weeklySortMode);
    
    dailyContainer.innerHTML = daily.map(createAlertCard).join('');
    weeklyContainer.innerHTML = weekly.map(createAlertCard).join('');
    
    attachClickHandlers();
}

function attachClickHandlers() {
    // Add click handlers for alerts
    document.querySelectorAll('.alert-card').forEach(card => {
        card.addEventListener('click', () => {
            const ticker = card.dataset.ticker;
            // Calls global function attached in main.js
            if (window.showTickerView) {
                window.showTickerView(ticker);
            }
        });
    });
}

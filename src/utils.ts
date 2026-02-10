export function getCurrentWeekISO(): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

export function getCurrentMonthISO(): string {
    const d = new Date();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    return `${d.getFullYear()}-${month}`;
}

export function getRelativeTime(timestamp?: string): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    
    const d1 = new Date(date); d1.setHours(0,0,0,0);
    const d2 = new Date(now); d2.setHours(0,0,0,0);
    
    const diffTime = d2.getTime() - d1.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "1d ago";
    return `${diffDays}d ago`;
}

export function formatVolume(vol?: number): string {
    if (!vol) return '0'.padEnd(7);
    let str: string;
    if (vol >= 1000) str = (vol / 1000).toFixed(1) + 'K';
    else str = vol.toString();
    return str.padEnd(7);
}

export function getDateRangeForMode(mode: string, weekVal: string, monthVal: string): { startDate: string, endDate: string } {
    let startDate = '', endDate = '';
    
    if (mode === '30' || mode === '7' || mode === '1') {
        const days = parseInt(mode);
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - days);
        endDate = end.toISOString();
        startDate = start.toISOString();
    } else if (mode === 'week') {
        if (!weekVal) return { startDate: '', endDate: '' };
        const parts = weekVal.split('-W');
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
        if (!monthVal) return { startDate: '', endDate: '' };
        const parts = monthVal.split('-');
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        
        const start = new Date(year, month - 1, 1);
        const end = new Date(year, month, 0); 
        end.setHours(23,59,59,999);
        startDate = start.toISOString();
        endDate = end.toISOString();
    }
    return { startDate, endDate };
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

import { SortMode, Alert } from './types';

export function createAlertSortFn(mode: SortMode): (a: Alert, b: Alert) => number {
    return (a: Alert, b: Alert): number => {
        if (mode === 'time') {
            return (b.timestamp || '').localeCompare(a.timestamp || '');
        }
        if (mode === 'favorite') {
            if (a.is_favorite === b.is_favorite) {
                return (b.timestamp || '').localeCompare(a.timestamp || '');
            }
            return (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0);
        }
        if (mode === 'volume') {
            return (b.signal_volume || 0) - (a.signal_volume || 0);
        }
        if (mode === 'intensity') {
            return (b.intensity_score || 0) - (a.intensity_score || 0);
        }
        if (mode === 'combo') {
            return (b.combo_score || 0) - (a.combo_score || 0);
        }
        return (b.timestamp || '').localeCompare(a.timestamp || '');
    };
}


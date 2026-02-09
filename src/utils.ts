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
    if (!vol) return '0';
    if (vol >= 1000) return (vol / 1000).toFixed(1) + 'K';
    return vol.toString();
}

export function getDateRangeForMode(mode: string, weekVal: string, monthVal: string): { startDate: string, endDate: string } {
    let startDate = '', endDate = '';
    
    if (mode === '30') {
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 30);
        endDate = end.toISOString();
        startDate = start.toISOString();
    } else if (mode === '7') {
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 7);
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

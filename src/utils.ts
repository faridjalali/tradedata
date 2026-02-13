import { SortMode, Alert } from './types';
import { getAppTimeZone } from './timezone';
import { computeDivergenceScoreFromStates, getTickerDivergenceScoreFromCache } from './divergenceTable';

interface DateParts {
    year: number;
    month: number;
    day: number;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const DAY_MS = 24 * 60 * 60 * 1000;

function getDateFormatterForTimeZone(timeZone: string): Intl.DateTimeFormat {
    const key = `${timeZone}|date`;
    const cached = dateFormatterCache.get(key);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    dateFormatterCache.set(key, formatter);
    return formatter;
}

function toNumberPart(parts: Intl.DateTimeFormatPart[], type: string): number {
    const value = Number(parts.find((part) => part.type === type)?.value);
    return Number.isFinite(value) ? value : 0;
}

function getDatePartsForTimeZone(date: Date, timeZone: string): DateParts {
    const parts = getDateFormatterForTimeZone(timeZone).formatToParts(date);
    return {
        year: toNumberPart(parts, 'year'),
        month: toNumberPart(parts, 'month'),
        day: toNumberPart(parts, 'day')
    };
}

function formatDateKey(year: number, month: number, day: number): string {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDateKey(dateKey: string, dayDelta: number): string {
    const baseMs = dayKeyToUtcMs(dateKey);
    if (!Number.isFinite(baseMs)) return '';
    const shifted = new Date((baseMs as number) + (dayDelta * DAY_MS));
    return formatDateKey(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth() + 1,
        shifted.getUTCDate()
    );
}

function dayKeyToUtcMs(dayKey: string): number | null {
    const match = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return Date.UTC(year, month - 1, day);
}

function getIsoWeekStartUtc(year: number, week: number): Date {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);

    const monday = new Date(week1Monday);
    monday.setUTCDate(week1Monday.getUTCDate() + ((week - 1) * 7));
    return monday;
}

export function getCurrentWeekISO(timeZone: string = getAppTimeZone()): string {
    const now = new Date();
    const parts = getDatePartsForTimeZone(now, timeZone);
    const dateUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));

    const dayNumber = dateUtc.getUTCDay() || 7;
    dateUtc.setUTCDate(dateUtc.getUTCDate() + 4 - dayNumber);

    const yearStart = new Date(Date.UTC(dateUtc.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((dateUtc.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7);
    return `${dateUtc.getUTCFullYear()}-W${weekNo.toString().padStart(2, '0')}`;
}

export function getCurrentDateISO(timeZone: string = getAppTimeZone()): string {
    const now = new Date();
    const parts = getDatePartsForTimeZone(now, timeZone);
    return formatDateKey(parts.year, parts.month, parts.day);
}

export function getCurrentMonthISO(timeZone: string = getAppTimeZone()): string {
    const now = new Date();
    const parts = getDatePartsForTimeZone(now, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

export function getRelativeTime(timestamp?: string, timeZone: string = getAppTimeZone()): string {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';

    const dayFormatter = getDateFormatterForTimeZone(timeZone);
    const alertDayKey = dayFormatter.format(date);
    const nowDayKey = dayFormatter.format(new Date());

    const alertDayMs = dayKeyToUtcMs(alertDayKey);
    const nowDayMs = dayKeyToUtcMs(nowDayKey);
    if (!Number.isFinite(alertDayMs) || !Number.isFinite(nowDayMs)) return '';

    const diffDays = Math.floor(((nowDayMs as number) - (alertDayMs as number)) / DAY_MS);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return '1d ago';
    if (diffDays < 0) return 'Today';
    return `${diffDays}d ago`;
}

export function formatVolume(vol?: number): string {
    if (!vol) return '0'.padEnd(7);
    if (vol < 1000) return vol.toFixed(0).padEnd(7);
    const str = Math.round(vol / 1000) + 'K';
    return str.padEnd(7);
}

export function getDateRangeForMode(
    mode: string,
    weekVal: string,
    monthVal: string,
    timeZone: string = getAppTimeZone()
): { startDate: string, endDate: string } {
    const today = getCurrentDateISO(timeZone);
    if (!today) return { startDate: '', endDate: '' };

    if (mode === 'today') {
        return { startDate: today, endDate: today };
    }

    if (mode === 'yesterday') {
        const yesterday = shiftDateKey(today, -1);
        if (!yesterday) return { startDate: '', endDate: '' };
        return { startDate: yesterday, endDate: yesterday };
    }

    if (mode === '30' || mode === '7') {
        const days = Math.max(1, Math.floor(Number(mode)));
        const startDate = shiftDateKey(today, -(days - 1));
        if (!startDate) return { startDate: '', endDate: '' };
        return { startDate, endDate: today };
    }

    if (mode === 'week') {
        const match = String(weekVal || '').trim().match(/^(\d{4})-W(\d{2})$/);
        if (!match) return { startDate: '', endDate: '' };
        const year = Number(match[1]);
        const week = Number(match[2]);
        if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) {
            return { startDate: '', endDate: '' };
        }

        const mondayUtc = getIsoWeekStartUtc(year, week);
        const sundayUtc = new Date(mondayUtc);
        sundayUtc.setUTCDate(mondayUtc.getUTCDate() + 6);
        const startDate = formatDateKey(
            mondayUtc.getUTCFullYear(),
            mondayUtc.getUTCMonth() + 1,
            mondayUtc.getUTCDate()
        );
        const endDate = formatDateKey(
            sundayUtc.getUTCFullYear(),
            sundayUtc.getUTCMonth() + 1,
            sundayUtc.getUTCDate()
        );
        return { startDate, endDate };
    }

    if (mode === 'month') {
        const match = String(monthVal || '').trim().match(/^(\d{4})-(\d{2})$/);
        if (!match) return { startDate: '', endDate: '' };
        const year = Number(match[1]);
        const month = Number(match[2]);
        if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
            return { startDate: '', endDate: '' };
        }

        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return {
            startDate: formatDateKey(year, month, 1),
            endDate: formatDateKey(year, month, lastDay)
        };
    }

    return { startDate: '', endDate: '' };
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
        if (mode === 'combo') {
            const bScore = b.divergence_states
                ? computeDivergenceScoreFromStates(b.divergence_states, b.ma_states)
                : getTickerDivergenceScoreFromCache(b.ticker);
            const aScore = a.divergence_states
                ? computeDivergenceScoreFromStates(a.divergence_states, a.ma_states)
                : getTickerDivergenceScoreFromCache(a.ticker);
            if (bScore !== aScore) {
                return bScore - aScore;
            }
            const volumeDiff = (b.signal_volume || 0) - (a.signal_volume || 0);
            if (volumeDiff !== 0) {
                return volumeDiff;
            }
            return (b.timestamp || '').localeCompare(a.timestamp || '');
        }
        return (b.timestamp || '').localeCompare(a.timestamp || '');
    };
}

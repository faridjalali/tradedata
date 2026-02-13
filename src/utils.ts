import { SortMode, Alert } from './types';
import { getAppTimeZone } from './timezone';

interface DateParts {
    year: number;
    month: number;
    day: number;
}

interface DateTimeParts extends DateParts {
    hour: number;
    minute: number;
    second: number;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
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

function getDateTimeFormatterForTimeZone(timeZone: string): Intl.DateTimeFormat {
    const key = `${timeZone}|datetime`;
    const cached = dateTimeFormatterCache.get(key);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    dateTimeFormatterCache.set(key, formatter);
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

function getDateTimePartsForTimeZone(date: Date, timeZone: string): DateTimeParts {
    const parts = getDateTimeFormatterForTimeZone(timeZone).formatToParts(date);
    return {
        year: toNumberPart(parts, 'year'),
        month: toNumberPart(parts, 'month'),
        day: toNumberPart(parts, 'day'),
        hour: toNumberPart(parts, 'hour'),
        minute: toNumberPart(parts, 'minute'),
        second: toNumberPart(parts, 'second')
    };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
    const parts = getDateTimePartsForTimeZone(date, timeZone);
    const asUtcMs = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        0
    );
    return asUtcMs - date.getTime();
}

function zonedDateTimeToUtc(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number,
    timeZone: string
): Date {
    const baseUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    let utcMs = baseUtcMs;

    for (let i = 0; i < 3; i++) {
        const offsetMs = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
        const candidate = baseUtcMs - offsetMs;
        if (candidate === utcMs) break;
        utcMs = candidate;
    }

    return new Date(utcMs);
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
    let str: string;
    if (vol >= 1000) str = (vol / 1000).toFixed(1) + 'K';
    else str = vol.toString();
    return str.padEnd(7);
}

export function getDateRangeForMode(
    mode: string,
    weekVal: string,
    monthVal: string,
    timeZone: string = getAppTimeZone()
): { startDate: string, endDate: string } {
    let startDate = '';
    let endDate = '';

    if (mode === '30' || mode === '7' || mode === '1') {
        const days = Math.max(1, Math.floor(Number(mode)));
        const end = new Date();
        const start = new Date(end.getTime() - (days * DAY_MS));
        endDate = end.toISOString();
        startDate = start.toISOString();
    } else if (mode === 'week') {
        const match = String(weekVal || '').trim().match(/^(\d{4})-W(\d{2})$/);
        if (!match) return { startDate: '', endDate: '' };
        const year = Number(match[1]);
        const week = Number(match[2]);
        if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) {
            return { startDate: '', endDate: '' };
        }

        const mondayUtc = getIsoWeekStartUtc(year, week);
        const mondayYear = mondayUtc.getUTCFullYear();
        const mondayMonth = mondayUtc.getUTCMonth() + 1;
        const mondayDay = mondayUtc.getUTCDate();

        const sundayUtc = new Date(mondayUtc);
        sundayUtc.setUTCDate(mondayUtc.getUTCDate() + 6);
        const sundayYear = sundayUtc.getUTCFullYear();
        const sundayMonth = sundayUtc.getUTCMonth() + 1;
        const sundayDay = sundayUtc.getUTCDate();

        startDate = zonedDateTimeToUtc(
            mondayYear,
            mondayMonth,
            mondayDay,
            0,
            0,
            0,
            0,
            timeZone
        ).toISOString();

        endDate = zonedDateTimeToUtc(
            sundayYear,
            sundayMonth,
            sundayDay,
            23,
            59,
            59,
            999,
            timeZone
        ).toISOString();
    } else {
        const match = String(monthVal || '').trim().match(/^(\d{4})-(\d{2})$/);
        if (!match) return { startDate: '', endDate: '' };
        const year = Number(match[1]);
        const month = Number(match[2]);
        if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
            return { startDate: '', endDate: '' };
        }

        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        startDate = zonedDateTimeToUtc(year, month, 1, 0, 0, 0, 0, timeZone).toISOString();
        endDate = zonedDateTimeToUtc(year, month, lastDay, 23, 59, 59, 999, timeZone).toISOString();
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

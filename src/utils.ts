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

export function getCurrentDateISO(timeZone: string = getAppTimeZone()): string {
    const now = new Date();
    const parts = getDatePartsForTimeZone(now, timeZone);
    return formatDateKey(parts.year, parts.month, parts.day);
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
    customFrom: string = '',
    customTo: string = '',
    timeZone: string = getAppTimeZone()
): { startDate: string, endDate: string } {
    const today = getCurrentDateISO(timeZone);
    if (!today) return { startDate: '', endDate: '' };

    // Numeric modes: fetch a generous 30-day window; client-side filters to N most recent dates
    if (mode === '1' || mode === '2' || mode === '5') {
        const startDate = shiftDateKey(today, -29);
        return startDate ? { startDate, endDate: today } : { startDate: '', endDate: '' };
    }

    if (mode === 'custom') {
        const from = String(customFrom || '').trim();
        const to = String(customTo || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return { startDate: from, endDate: to };
        }
        return { startDate: '', endDate: '' };
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

export function createAlertSortFn(mode: SortMode, direction: 'asc' | 'desc' = 'desc'): (a: Alert, b: Alert) => number {
    return (a: Alert, b: Alert): number => {
        let result = 0;
        if (mode === 'time') {
            result = (b.timestamp || '').localeCompare(a.timestamp || '');
        } else if (mode === 'favorite') {
            if (a.is_favorite === b.is_favorite) {
                return (b.timestamp || '').localeCompare(a.timestamp || '');
            }
            return (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0);
        } else if (mode === 'volume') {
            result = (b.signal_volume || 0) - (a.signal_volume || 0);
        } else if (mode === 'score') {
            let bScore = b.divergence_states
                ? computeDivergenceScoreFromStates(b.divergence_states, b.ma_states)
                : getTickerDivergenceScoreFromCache(b.ticker);
            let aScore = a.divergence_states
                ? computeDivergenceScoreFromStates(a.divergence_states, a.ma_states)
                : getTickerDivergenceScoreFromCache(a.ticker);
            if (b.vdf_score) bScore += Math.round(b.vdf_score / 10);
            if (a.vdf_score) aScore += Math.round(a.vdf_score / 10);
            if (bScore !== aScore) {
                result = bScore - aScore;
            } else {
                const volumeDiff = (b.signal_volume || 0) - (a.signal_volume || 0);
                if (volumeDiff !== 0) {
                    result = volumeDiff;
                } else {
                    result = (b.timestamp || '').localeCompare(a.timestamp || '');
                }
            }
        } else {
            result = (b.timestamp || '').localeCompare(a.timestamp || '');
        }

        if ((mode as string) !== 'favorite' && direction === 'asc') {
            return -result;
        }
        return result;
    };
}

export function updateSortButtonUi(
    containerSelector: string,
    currentMode: SortMode,
    direction: 'asc' | 'desc'
): void {
    const header = document.querySelector(containerSelector);
    if (!header) return;
    header.querySelectorAll('.pane-btn').forEach(btn => {
        const el = btn as HTMLElement;
        const mode = el.dataset.sort as SortMode;
        if (mode === currentMode) {
            el.classList.add('active');
            // Set arrow indicator via CSS pseudo-element (positioned top-right by CSS)
            if (mode !== 'favorite') {
                el.setAttribute('data-sort-dir', direction === 'asc' ? '↑' : '↓');
            }
        } else {
            el.classList.remove('active');
            el.removeAttribute('data-sort-dir');
        }
    });
}

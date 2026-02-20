/**
 * Pure time conversion and formatting utilities for the chart module.
 * Zero state access — all functions are pure.
 */

import { getAppTimeZone, getAppTimeZoneFormatter } from './timezone';
import type { CandleBar } from '../shared/api-types';

export function unixSecondsFromTimeValue(time: string | number | null | undefined): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) return time;
  if (typeof time === 'string' && time.trim()) {
    const parsed = Date.parse(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

// LightweightCharts CDN — no bundled declarations; Time type varies by series config

export function toDateFromScaleTime(time: any): Date | null {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return new Date(time * 1000);
  }
  if (typeof time === 'string' && time.trim()) {
    const parsed = new Date(time.includes('T') ? time : `${time.replace(' ', 'T')}Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (
    time &&
    typeof time === 'object' &&
    Number.isFinite(time.year) &&
    Number.isFinite(time.month) &&
    Number.isFinite(time.day)
  ) {
    return new Date(Date.UTC(Number(time.year), Number(time.month) - 1, Number(time.day), 0, 0, 0));
  }
  return null;
}

export function formatTimeScaleTickMark(time: any, tickMarkType: number): string {
  const date = toDateFromScaleTime(time);
  if (!date) return '';
  const appTimeZone = getAppTimeZone();

  if (tickMarkType === 0) {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      timeZone: appTimeZone,
    });
  }
  if (tickMarkType === 1) {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      timeZone: appTimeZone,
    });
  }
  return date.toLocaleDateString('en-US', {
    day: 'numeric',
    timeZone: appTimeZone,
  });
}

export function monthKeyInAppTimeZone(unixSeconds: number): string {
  const parts = getAppTimeZoneFormatter('en-US', {
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(unixSeconds * 1000));
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  return `${year}-${month}`;
}

export function buildMonthBoundaryTimes(bars: CandleBar[]): number[] {
  const result: number[] = [];
  let lastMonthKey = '';
  for (const bar of bars) {
    const unixSeconds = unixSecondsFromTimeValue(bar?.time);
    if (unixSeconds === null) continue;
    const monthKey = monthKeyInAppTimeZone(unixSeconds);
    if (monthKey !== lastMonthKey) {
      result.push(unixSeconds);
      lastMonthKey = monthKey;
    }
  }
  return result;
}

export function dayKeyInAppTimeZone(unixSeconds: number): string {
  return getAppTimeZoneFormatter('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

export function timeKey(time: string | number): string {
  return typeof time === 'number' ? String(time) : time;
}

export function toUnixSeconds(time: string | number): number | null {
  return unixSecondsFromTimeValue(time);
}

export function formatMmDdYyFromUnixSeconds(unixSeconds: number | null): string {
  if (!Number.isFinite(unixSeconds)) return 'N/A';
  return getAppTimeZoneFormatter('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  }).format(new Date(Math.round(Number(unixSeconds)) * 1000));
}

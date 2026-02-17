/**
 * Shared date/time utility functions used across backend modules.
 * All functions are pure — no external dependencies or mutable state.
 */

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function etDateStringFromUnixSeconds(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function currentEtDateString(nowUtc: Date = new Date()): string {
  return nowUtc.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function maxEtDateString(a: string, b: string): string {
  const aVal = String(a || '').trim();
  const bVal = String(b || '').trim();
  if (!aVal) return bVal || '';
  if (!bVal) return aVal;
  return aVal >= bVal ? aVal : bVal;
}

function parseDateKeyToUtcMs(dateKey: string): number {
  const value = String(dateKey || '').trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

function dateKeyDaysAgo(dateKey: string, days: number): string {
  const baseMs = parseDateKeyToUtcMs(dateKey);
  if (!Number.isFinite(baseMs)) return '';
  const shifted = new Date(baseMs - Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function easternLocalToUtcMs(year: number, month: number, day: number, hour: number, minute: number): number {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const etOffset = probe
    .toLocaleString('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    })
    .includes('EST')
    ? -5
    : -4;
  return Date.UTC(year, month - 1, day, hour - etOffset, minute, 0);
}

function pacificLocalToUtcMs(year: number, month: number, day: number, hour: number, minute: number): number {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const ptOffset = probe
    .toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short',
    })
    .includes('PST')
    ? -8
    : -7;
  return Date.UTC(year, month - 1, day, hour - ptOffset, minute, 0);
}

function pacificDateStringFromUnixSeconds(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function dateKeyFromYmdParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function pacificDateTimeParts(nowUtc: Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(nowUtc);
  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(map.year || 0),
    month: Number(map.month || 0),
    day: Number(map.day || 0),
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
    weekday: Number(weekdayMap[map.weekday] ?? NaN),
  };
}

export {
  addUtcDays,
  etDateStringFromUnixSeconds,
  currentEtDateString,
  maxEtDateString,
  parseDateKeyToUtcMs,
  dateKeyDaysAgo,
  easternLocalToUtcMs,
  pacificLocalToUtcMs,
  pacificDateStringFromUnixSeconds,
  dateKeyFromYmdParts,
  pacificDateTimeParts,
};

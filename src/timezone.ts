export interface AppTimeZoneOption {
  value: string;
  label: string;
}

const APP_TIMEZONE_STORAGE_KEY = 'catvue_app_timezone_v1';
export const DEFAULT_APP_TIME_ZONE = 'America/Los_Angeles';

const APP_TIMEZONE_OPTIONS: AppTimeZoneOption[] = [
  { value: 'America/Los_Angeles', label: 'Los Angeles (US Pacific time)' },
  { value: 'America/Denver', label: 'Denver (US Mountain time)' },
  { value: 'America/Chicago', label: 'Chicago (US Central time)' },
  { value: 'America/New_York', label: 'New York (US Eastern time)' },
  { value: 'UTC', label: 'UTC' }
];

const APP_TIMEZONE_VALUES = new Set(APP_TIMEZONE_OPTIONS.map((option) => option.value));
const listeners = new Set<(nextTimeZone: string, previousTimeZone: string) => void>();

let currentAppTimeZone = resolveInitialTimeZone();
let formatterCacheTimeZone = currentAppTimeZone;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function isSupportedTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    // Throws when the runtime does not support the given time zone.
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function normalizeAppTimeZone(value: unknown): string {
  const candidate = String(value || '').trim();
  if (!candidate) return DEFAULT_APP_TIME_ZONE;
  if (!APP_TIMEZONE_VALUES.has(candidate)) return DEFAULT_APP_TIME_ZONE;
  if (!isSupportedTimeZone(candidate)) return DEFAULT_APP_TIME_ZONE;
  return candidate;
}

function resolveInitialTimeZone(): string {
  let stored = '';
  try {
    stored = typeof window !== 'undefined'
      ? String(window.localStorage.getItem(APP_TIMEZONE_STORAGE_KEY) || '')
      : '';
  } catch {
    stored = '';
  }
  return normalizeAppTimeZone(stored);
}

function persistTimeZone(value: string): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(APP_TIMEZONE_STORAGE_KEY, value);
  } catch {
    // Ignore storage write failures.
  }
}

function buildFormatterCacheKey(
  locale: string | string[],
  options: Intl.DateTimeFormatOptions
): string {
  const localeKey = Array.isArray(locale) ? locale.join('|') : locale;
  const entries = Object.entries(options)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`);
  return `${localeKey}|${entries.join(',')}`;
}

export function getAppTimeZoneOptions(): AppTimeZoneOption[] {
  return APP_TIMEZONE_OPTIONS.map((option) => ({ ...option }));
}

export function getAppTimeZone(): string {
  return currentAppTimeZone;
}

export function getAppTimeZoneLabel(timeZone: string = currentAppTimeZone): string {
  const match = APP_TIMEZONE_OPTIONS.find((option) => option.value === timeZone);
  return match?.label || APP_TIMEZONE_OPTIONS[0].label;
}

export function getAppTimeZoneFormatter(
  locale: string | string[] = 'en-US',
  options: Intl.DateTimeFormatOptions = {}
): Intl.DateTimeFormat {
  const activeTimeZone = getAppTimeZone();
  if (formatterCacheTimeZone !== activeTimeZone) {
    formatterCache.clear();
    formatterCacheTimeZone = activeTimeZone;
  }
  const cacheKey = buildFormatterCacheKey(locale, options);
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: activeTimeZone
  });
  formatterCache.set(cacheKey, formatter);
  return formatter;
}

export function setAppTimeZone(value: string): string {
  const nextTimeZone = normalizeAppTimeZone(value);
  const previousTimeZone = currentAppTimeZone;
  if (nextTimeZone === previousTimeZone) return nextTimeZone;

  currentAppTimeZone = nextTimeZone;
  persistTimeZone(nextTimeZone);
  formatterCache.clear();
  formatterCacheTimeZone = nextTimeZone;

  listeners.forEach((listener) => {
    try {
      listener(nextTimeZone, previousTimeZone);
    } catch {
      // Keep listener failures isolated.
    }
  });

  return nextTimeZone;
}

export function onAppTimeZoneChange(
  listener: (nextTimeZone: string, previousTimeZone: string) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

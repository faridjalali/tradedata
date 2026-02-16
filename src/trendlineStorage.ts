import type { RSIPersistedTrendline } from './rsi';
import type { ChartInterval } from './chartApi';

export interface PersistedTrendlineBundle {
  rsi: RSIPersistedTrendline[];
  volumeDeltaRsi: RSIPersistedTrendline[];
}

const TRENDLINES_STORAGE_KEY = 'custom_chart_trendlines_v1';

export function normalizePersistedTrendlines(lines: unknown): RSIPersistedTrendline[] {
  if (!Array.isArray(lines)) return [];
  const out: RSIPersistedTrendline[] = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const candidate = line as RSIPersistedTrendline;
    const time1 = candidate.time1;
    const time2 = candidate.time2;
    const value1 = Number(candidate.value1);
    const value2 = Number(candidate.value2);
    if ((typeof time1 !== 'string' && typeof time1 !== 'number') || (typeof time2 !== 'string' && typeof time2 !== 'number')) continue;
    if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
    out.push({ time1, value1, time2, value2 });
  }
  return out;
}

export function buildTrendlineContextKey(ticker: string, interval: ChartInterval): string {
  return `${ticker.toUpperCase()}|${interval}`;
}

export function loadTrendlineStorage(): Record<string, PersistedTrendlineBundle> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(TRENDLINES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<PersistedTrendlineBundle>>;
    const normalized: Record<string, PersistedTrendlineBundle> = {};
    for (const [key, bundle] of Object.entries(parsed || {})) {
      normalized[key] = {
        rsi: normalizePersistedTrendlines(bundle?.rsi),
        volumeDeltaRsi: normalizePersistedTrendlines(bundle?.volumeDeltaRsi)
      };
    }
    return normalized;
  } catch {
    return {};
  }
}

export function saveTrendlineStorage(store: Record<string, PersistedTrendlineBundle>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TRENDLINES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage errors (private mode/quota/etc.)
  }
}

export function loadPersistedTrendlinesForContext(ticker: string, interval: ChartInterval): PersistedTrendlineBundle {
  const storage = loadTrendlineStorage();
  const bundle = storage[buildTrendlineContextKey(ticker, interval)];
  return {
    rsi: normalizePersistedTrendlines(bundle?.rsi),
    volumeDeltaRsi: normalizePersistedTrendlines(bundle?.volumeDeltaRsi)
  };
}

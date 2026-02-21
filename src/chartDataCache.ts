/**
 * Chart data cache — client-side caching with session storage persistence.
 * Encapsulates its own state; no external mutable refs needed.
 */

import type { ChartData, ChartInterval } from './chartApi';
import {
  CHART_CLIENT_CACHE_TTL_MS,
  CHART_CLIENT_CACHE_MAX_ENTRIES,
  CHART_SESSION_CACHE_KEY,
  CHART_SESSION_CACHE_MAX_ENTRIES,
  CHART_SESSION_CACHE_MAX_BYTES,
  volumeDeltaRsiSettings,
  volumeDeltaSettings,
} from './chartTypes';
import { timeKey } from './chartTimeUtils';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const chartDataCache = new Map<string, { data: ChartData; updatedAt: number }>();
let chartCacheHydratedFromSession = false;
let chartCachePersistTimer: number | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildChartDataCacheKey(ticker: string, interval: ChartInterval): string {
  return [
    String(ticker || '')
      .trim()
      .toUpperCase(),
    interval,
    String(volumeDeltaRsiSettings.length),
    volumeDeltaSettings.sourceInterval,
    volumeDeltaRsiSettings.sourceInterval,
  ].join('|');
}

function isValidChartDataPayload(data: unknown): data is ChartData {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Partial<ChartData>;
  if (!Array.isArray(candidate.bars) || candidate.bars.length === 0) return false;
  return true;
}

function enforceChartDataCacheMaxEntries(): void {
  while (chartDataCache.size > CHART_CLIENT_CACHE_MAX_ENTRIES) {
    const oldestKey = chartDataCache.keys().next().value;
    if (!oldestKey) break;
    chartDataCache.delete(oldestKey);
  }
}

function hydrateChartDataCacheFromSessionIfNeeded(): void {
  if (chartCacheHydratedFromSession) return;
  chartCacheHydratedFromSession = true;
  if (typeof window === 'undefined') return;

  try {
    const raw = window.sessionStorage.getItem(CHART_SESSION_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      version?: number;
      entries?: Array<{ key: string; updatedAt: number; data: ChartData }>;
    };
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
    const sortedEntries = [...parsed.entries]
      .filter(
        (entry) =>
          entry &&
          typeof entry.key === 'string' &&
          Number.isFinite(entry.updatedAt) &&
          isValidChartDataPayload(entry.data),
      )
      .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
    for (const entry of sortedEntries) {
      chartDataCache.set(entry.key, {
        data: entry.data,
        updatedAt: Number(entry.updatedAt),
      });
    }
    enforceChartDataCacheMaxEntries();
  } catch {
    // Ignore session cache read/parse errors.
  }
}

export function schedulePersistChartDataCacheToSession(): void {
  if (typeof window === 'undefined') return;
  if (chartCachePersistTimer !== null) return;
  chartCachePersistTimer = window.setTimeout(() => {
    chartCachePersistTimer = null;
    try {
      const newestFirst = Array.from(chartDataCache.entries()).reverse();
      const persistedEntries: Array<{ key: string; updatedAt: number; data: ChartData }> = [];
      let totalBytes = 0;
      for (const [key, entry] of newestFirst) {
        if (!entry || !entry.data || !Number.isFinite(entry.updatedAt)) continue;
        const candidate = {
          key,
          updatedAt: entry.updatedAt,
          data: entry.data,
        };
        const serializedCandidate = JSON.stringify(candidate);
        if (!serializedCandidate) continue;
        if (totalBytes + serializedCandidate.length > CHART_SESSION_CACHE_MAX_BYTES) continue;
        persistedEntries.push(candidate);
        totalBytes += serializedCandidate.length;
        if (persistedEntries.length >= CHART_SESSION_CACHE_MAX_ENTRIES) break;
      }
      const payload = JSON.stringify({
        version: 1,
        entries: persistedEntries,
      });
      window.sessionStorage.setItem(CHART_SESSION_CACHE_KEY, payload);
    } catch {
      // Ignore session cache persistence errors (quota, serialization, etc).
    }
  }, 180);
}

function sweepChartDataCache(): void {
  hydrateChartDataCacheFromSessionIfNeeded();
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of chartDataCache.entries()) {
    if (!entry || !entry.updatedAt || now - entry.updatedAt > CHART_CLIENT_CACHE_TTL_MS) {
      chartDataCache.delete(key);
      changed = true;
    }
  }
  const sizeBefore = chartDataCache.size;
  enforceChartDataCacheMaxEntries();
  if (chartDataCache.size !== sizeBefore) {
    changed = true;
  }
  if (changed) {
    schedulePersistChartDataCacheToSession();
  }
}

export function getCachedChartData(cacheKey: string): ChartData | null {
  sweepChartDataCache();
  const cached = chartDataCache.get(cacheKey);
  if (cached) {
    chartDataCache.delete(cacheKey);
    chartDataCache.set(cacheKey, cached);
  }
  return cached ? cached.data : null;
}

export function getCachedChartDataByTickerInterval(ticker: string, interval: ChartInterval): ChartData | null {
  sweepChartDataCache();
  const normalizedTicker = String(ticker || '')
    .trim()
    .toUpperCase();
  if (!normalizedTicker) return null;
  const prefix = `${normalizedTicker}|${interval}|`;
  const entries = Array.from(chartDataCache.entries()).reverse();
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix) || !entry?.data) continue;
    chartDataCache.delete(key);
    chartDataCache.set(key, entry);
    return entry.data;
  }
  return null;
}

export function setCachedChartData(cacheKey: string, data: ChartData): void {
  hydrateChartDataCacheFromSessionIfNeeded();
  chartDataCache.delete(cacheKey);
  chartDataCache.set(cacheKey, {
    data,
    updatedAt: Date.now(),
  });
  enforceChartDataCacheMaxEntries();
  schedulePersistChartDataCacheToSession();
}

export function evictCachedChartData(cacheKey: string): void {
  chartDataCache.delete(cacheKey);
}

export function getLastBarSignature(data: ChartData | null): string {
  const bars = Array.isArray(data?.bars) ? data.bars : [];
  if (!bars.length) return 'none';
  const last = bars[bars.length - 1];
  return [
    bars.length,
    timeKey(last.time),
    Number(last.open),
    Number(last.high),
    Number(last.low),
    Number(last.close),
    Number(last.volume),
  ].join('|');
}

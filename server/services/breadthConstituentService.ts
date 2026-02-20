import {
  ALL_BREADTH_INDICES,
  clearBreadthConstituentOverrides,
  getBreadthConstituentCounts,
  setBreadthConstituentOverrides,
  type BreadthIndex,
} from '../data/etfConstituents.js';
import { loadBreadthConstituentOverrides, replaceBreadthConstituentOverrides } from '../data/breadthStore.js';
import { isValidTickerSymbol } from '../middleware.js';

interface ParsedRemotePayload {
  overrides: Partial<Record<BreadthIndex, string[]>>;
  indexCount: number;
  tickerCount: number;
}

function normalizeTicker(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toUpperCase();
}

function parseRemoteOverrides(payload: unknown): ParsedRemotePayload {
  const root = (payload && typeof payload === 'object' ? payload : null) as
    | { indices?: Record<string, unknown> }
    | Record<string, unknown>
    | null;
  const candidate = (
    root && 'indices' in root && root.indices && typeof root.indices === 'object' ? root.indices : root
  ) as Record<string, unknown> | null;
  if (!candidate || Array.isArray(candidate)) {
    throw new Error('Invalid constituents payload: expected object map');
  }

  const overrides: Partial<Record<BreadthIndex, string[]>> = {};
  let tickerCount = 0;

  for (const index of ALL_BREADTH_INDICES) {
    const row = candidate[index];
    if (!Array.isArray(row)) continue;
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const entry of row) {
      const ticker = normalizeTicker(entry);
      if (!ticker || seen.has(ticker) || !isValidTickerSymbol(ticker)) continue;
      seen.add(ticker);
      normalized.push(ticker);
    }
    if (normalized.length === 0) continue;
    overrides[index] = normalized;
    tickerCount += normalized.length;
  }

  const indexCount = Object.keys(overrides).length;
  if (indexCount === 0 || tickerCount === 0) {
    throw new Error('Remote constituents payload did not include valid index holdings');
  }

  return { overrides, indexCount, tickerCount };
}

export async function initializeBreadthConstituentsFromDb(): Promise<void> {
  const stored = await loadBreadthConstituentOverrides();
  if (Object.keys(stored).length > 0) {
    setBreadthConstituentOverrides(stored);
    return;
  }
  clearBreadthConstituentOverrides();
}

export async function rebuildBreadthConstituents(options: { sourceUrl?: string } = {}): Promise<{
  status: 'reloaded' | 'updated';
  source: string;
  indexCount: number;
  tickerCount: number;
  counts: Record<BreadthIndex, number>;
  updatedAt: string;
}> {
  const sourceUrl = String(options.sourceUrl || process.env.BREADTH_CONSTITUENTS_URL || '').trim();

  if (!sourceUrl) {
    const stored = await loadBreadthConstituentOverrides();
    if (Object.keys(stored).length > 0) {
      setBreadthConstituentOverrides(stored);
    } else {
      clearBreadthConstituentOverrides();
    }
    const counts = getBreadthConstituentCounts();
    return {
      status: 'reloaded',
      source: Object.keys(stored).length > 0 ? 'db-overrides' : 'static',
      indexCount: Object.keys(counts).length,
      tickerCount: Object.values(counts).reduce((sum, v) => sum + Number(v || 0), 0),
      counts,
      updatedAt: new Date().toISOString(),
    };
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 15000);
  try {
    const response = await fetch(sourceUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: abortController.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Remote source returned HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => null);
    const parsed = parseRemoteOverrides(payload);
    await replaceBreadthConstituentOverrides(parsed.overrides, sourceUrl);
    setBreadthConstituentOverrides(parsed.overrides);

    return {
      status: 'updated',
      source: sourceUrl,
      indexCount: parsed.indexCount,
      tickerCount: parsed.tickerCount,
      counts: getBreadthConstituentCounts(),
      updatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getBreadthConstituentRuntimeSummary(): {
  sourceUrlConfigured: boolean;
  counts: Record<BreadthIndex, number>;
  totalTickers: number;
} {
  const counts = getBreadthConstituentCounts();
  return {
    sourceUrlConfigured: Boolean(String(process.env.BREADTH_CONSTITUENTS_URL || '').trim()),
    counts,
    totalTickers: Object.values(counts).reduce((sum, v) => sum + Number(v || 0), 0),
  };
}

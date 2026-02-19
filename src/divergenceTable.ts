export type { DivergenceState, DivergenceSummaryEntry } from '../shared/api-types';
import type { DivergenceState, DivergenceSummaryEntry, DivergenceSummaryApiPayload } from '../shared/api-types';
import { DIVERGENCE_LOOKBACK_DAYS, VOLUME_DELTA_SOURCE_INTERVALS, buildNeutralDivergenceStates } from '../shared/constants';
export { DIVERGENCE_LOOKBACK_DAYS };

type DivergenceSummaryApiItem = NonNullable<DivergenceSummaryApiPayload['summaries']>[number];

const divergenceSummaryCache = new Map<string, DivergenceSummaryEntry>();
/** Cap prevents unbounded growth when browsing many tickers across sessions. */
const DIVERGENCE_SUMMARY_CACHE_MAX = 600;
const divergenceSummaryBatchInFlight = new Map<string, Promise<Map<string, DivergenceSummaryEntry>>>();
const CHART_SETTINGS_STORAGE_KEY = 'custom_chart_settings_v1';
const DEFAULT_DIVERGENCE_SOURCE_INTERVAL = '1min';
const VALID_DIVERGENCE_SOURCE_INTERVALS = new Set<string>(VOLUME_DELTA_SOURCE_INTERVALS);

interface PersistedDivergenceSourceSettings {
  volumeDelta?: {
    sourceInterval?: string;
  };
}

function normalizeState(raw: unknown): DivergenceState {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'bullish' || value === 'bearish') return value;
  return 'neutral';
}

function normalizeTicker(value: unknown): string {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function normalizeSourceInterval(raw: unknown): string {
  const value = String(raw || '').trim();
  return VALID_DIVERGENCE_SOURCE_INTERVALS.has(value) ? value : DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
}

export function getPreferredDivergenceSourceInterval(): string {
  try {
    if (typeof window === 'undefined') return DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
    const raw = window.localStorage.getItem(CHART_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
    const parsed = JSON.parse(raw) as PersistedDivergenceSourceSettings;
    return normalizeSourceInterval(parsed?.volumeDelta?.sourceInterval);
  } catch {
    return DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
  }
}

function cacheKeyFor(ticker: string, sourceInterval: string): string {
  return `${normalizeTicker(ticker)}|${normalizeSourceInterval(sourceInterval)}`;
}

function getCachedSummary(ticker: string, sourceInterval: string): DivergenceSummaryEntry | null {
  const key = cacheKeyFor(ticker, sourceInterval);
  const cached = divergenceSummaryCache.get(key);
  if (!cached) return null;
  if (!Number.isFinite(cached.expiresAtMs) || cached.expiresAtMs <= Date.now()) {
    divergenceSummaryCache.delete(key);
    return null;
  }
  return cached;
}

function setCachedSummary(sourceInterval: string, entry: DivergenceSummaryEntry): void {
  const key = cacheKeyFor(entry.ticker, sourceInterval);
  divergenceSummaryCache.set(key, entry);
  if (divergenceSummaryCache.size > DIVERGENCE_SUMMARY_CACHE_MAX) {
    const oldest = divergenceSummaryCache.keys().next().value;
    if (oldest !== undefined) divergenceSummaryCache.delete(oldest);
  }
}

function buildNeutralStates(): Record<string, DivergenceState> {
  return buildNeutralDivergenceStates() as Record<string, DivergenceState>;
}

function normalizeApiSummary(item: DivergenceSummaryApiItem): DivergenceSummaryEntry | null {
  const ticker = normalizeTicker(item?.ticker);
  if (!ticker) return null;
  const states = buildNeutralStates();
  const rawStates = item?.states || {};
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    states[String(days)] = normalizeState(rawStates[String(days)]);
  }
  const expiresAtMs = Number(item?.expiresAtMs);
  const safeExpiresAt =
    Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() ? expiresAtMs : Date.now() + 60 * 60 * 1000;
  return {
    ticker,
    tradeDate: typeof item?.tradeDate === 'string' ? item.tradeDate : null,
    states,
    expiresAtMs: safeExpiresAt,
  };
}

async function fetchDivergenceSummariesBatch(
  tickers: string[],
  sourceInterval: string,
  options?: { forceRefresh?: boolean; noCache?: boolean },
): Promise<Map<string, DivergenceSummaryEntry>> {
  const normalizedSourceInterval = normalizeSourceInterval(sourceInterval);
  const forceRefresh = options?.forceRefresh === true;
  const noCache = options?.noCache === true;
  const uniqueTickers = Array.from(new Set(tickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean)));
  if (uniqueTickers.length === 0) return new Map();

  const requestKey = `${normalizedSourceInterval}|${forceRefresh ? 'refresh' : 'cached'}|${noCache ? 'nocache' : 'cache'}|${uniqueTickers.join(',')}`;
  if (divergenceSummaryBatchInFlight.has(requestKey)) {
    return await divergenceSummaryBatchInFlight.get(requestKey)!;
  }

  const batchPromise = (async (): Promise<Map<string, DivergenceSummaryEntry>> => {
    const resolved = new Map<string, DivergenceSummaryEntry>();
    const params = new URLSearchParams();
    params.set('tickers', uniqueTickers.join(','));
    params.set('vdSourceInterval', normalizedSourceInterval);
    if (forceRefresh) {
      params.set('refresh', '1');
    }
    if (noCache) {
      params.set('nocache', '1');
    }
    const response = await fetch(`/api/chart/divergence-summary?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch divergence summary (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as DivergenceSummaryApiPayload;
    const rows = Array.isArray(payload?.summaries) ? payload.summaries : [];
    for (const row of rows) {
      const normalized = normalizeApiSummary(row);
      if (!normalized) continue;
      resolved.set(normalized.ticker, normalized);
      setCachedSummary(normalizedSourceInterval, normalized);
    }
    return resolved;
  })()
    .catch(() => {
      // Keep summary fetching best-effort.
      return new Map<string, DivergenceSummaryEntry>();
    })
    .finally(() => {
      divergenceSummaryBatchInFlight.delete(requestKey);
    });

  divergenceSummaryBatchInFlight.set(requestKey, batchPromise);
  return await batchPromise;
}

export async function getTickerDivergenceSummary(
  ticker: string,
  sourceInterval?: string,
  options?: { forceRefresh?: boolean; noCache?: boolean },
): Promise<DivergenceSummaryEntry | null> {
  const normalizedTicker = normalizeTicker(ticker);
  const normalizedSource = sourceInterval
    ? normalizeSourceInterval(sourceInterval)
    : getPreferredDivergenceSourceInterval();
  const forceRefresh = options?.forceRefresh === true;
  const noCache = options?.noCache === true;
  if (!normalizedTicker) return null;

  // When not forcing refresh, try the in-memory cache first.
  if (!forceRefresh && !noCache) {
    const cached = getCachedSummary(normalizedTicker, normalizedSource);
    if (cached) return cached;
  }

  const resultMap = await fetchDivergenceSummariesBatch([normalizedTicker], normalizedSource, {
    forceRefresh,
    noCache,
  });
  return resultMap.get(normalizedTicker) || null;
}

export function renderMiniDivergenceRow(root: ParentNode, summary: DivergenceSummaryEntry | null): void {
  const nodes = root.querySelectorAll<HTMLElement>('.div-dot, .divergence-mini-cell');
  nodes.forEach((node) => {
    const dayKey = String(node.dataset.days || '').trim();
    const state = summary?.states?.[dayKey] || 'neutral';
    node.classList.remove('is-bullish', 'is-bearish', 'is-neutral');
    if (state === 'bullish') {
      node.classList.add('is-bullish');
    } else if (state === 'bearish') {
      node.classList.add('is-bearish');
    } else {
      node.classList.add('is-neutral');
    }
  });
  const parent = root instanceof HTMLElement ? root : (root as Element | null);
  if (parent instanceof HTMLElement) {
    if (summary?.tradeDate) {
      parent.dataset.tradeDate = summary.tradeDate;
      parent.title = `Divergence (${DIVERGENCE_LOOKBACK_DAYS.join(', ')}d)`;
    } else {
      parent.removeAttribute('data-trade-date');
      parent.title = `Divergence (${DIVERGENCE_LOOKBACK_DAYS.join(', ')}d)`;
    }
  }
}

export function renderMiniDivergencePlaceholders(root: ParentNode): void {
  const nodes = root.querySelectorAll<HTMLElement>('.div-dot, .divergence-mini-cell');
  nodes.forEach((node) => {
    node.classList.remove('is-bullish', 'is-bearish');
    node.classList.add('is-neutral');
  });
}

const DIVERGENCE_SCORE_WEIGHTS: Record<string, number> = {
  '1': 3,
  '3': 3,
  '7': 2,
  '14': 2,
  '28': 1,
};

export function computeDivergenceScoreFromStates(
  states?: Record<string, string | DivergenceState | null | undefined>,
  maStates?: { ema8?: boolean; ema21?: boolean; sma50?: boolean; sma200?: boolean } | null,
): number {
  let total = 0;
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    const key = String(days);
    const raw = String(states?.[key] || '')
      .trim()
      .toLowerCase();
    const weight = Number(DIVERGENCE_SCORE_WEIGHTS[key] || 0);
    if (raw === 'bullish') {
      total += weight;
    } else if (raw === 'bearish') {
      total -= weight;
    }
  }
  if (maStates) {
    total += maStates.ema8 === true ? 1 : maStates.ema8 === false ? -1 : 0;
    total += maStates.ema21 === true ? 1 : maStates.ema21 === false ? -1 : 0;
    total += maStates.sma50 === true ? 1 : maStates.sma50 === false ? -1 : 0;
    total += maStates.sma200 === true ? 1 : maStates.sma200 === false ? -1 : 0;
  }
  return total;
}

export function getTickerDivergenceScoreFromCache(ticker: string, sourceInterval?: string): number {
  const normalizedTicker = normalizeTicker(ticker);
  if (!normalizedTicker) return 0;
  const normalizedSource = sourceInterval
    ? normalizeSourceInterval(sourceInterval)
    : getPreferredDivergenceSourceInterval();
  const summary = getCachedSummary(normalizedTicker, normalizedSource);
  if (!summary) return 0;
  return computeDivergenceScoreFromStates(summary.states);
}

export function renderAlertCardDivergenceTablesFromCache(container: ParentNode): void {
  const normalizedSource = getPreferredDivergenceSourceInterval();
  const cells = Array.from(
    container.querySelectorAll<HTMLElement>('.div-dot-row[data-ticker], .divergence-mini[data-ticker]'),
  );
  for (const cell of cells) {
    const ticker = normalizeTicker(cell.dataset.ticker);
    if (!ticker) continue;
    const cached = getCachedSummary(ticker, normalizedSource);
    if (cached) {
      renderMiniDivergenceRow(cell, cached);
    }
  }
}

export function primeDivergenceSummaryCacheFromAlerts(
  alerts: Array<{
    ticker?: string;
    divergence_states?: Record<string, string | null | undefined>;
    divergence_trade_date?: string | null;
  }>,
  sourceInterval?: string,
): void {
  const normalizedSource = sourceInterval
    ? normalizeSourceInterval(sourceInterval)
    : getPreferredDivergenceSourceInterval();
  const nowMs = Date.now();
  const expiresAtMs = nowMs + 60 * 60 * 1000;
  for (const alert of alerts || []) {
    const ticker = normalizeTicker(alert?.ticker);
    if (!ticker) continue;
    const states = buildNeutralStates();
    const rawStates = alert?.divergence_states || {};
    for (const days of DIVERGENCE_LOOKBACK_DAYS) {
      states[String(days)] = normalizeState(rawStates[String(days)]);
    }
    setCachedSummary(normalizedSource, {
      ticker,
      tradeDate: typeof alert?.divergence_trade_date === 'string' ? alert.divergence_trade_date : null,
      states,
      expiresAtMs,
    });
  }
}

export async function hydrateAlertCardDivergenceTables(
  container: ParentNode,
  sourceInterval?: string,
  options?: { forceRefresh?: boolean; noCache?: boolean; resetPlaceholders?: boolean },
): Promise<void> {
  const forceRefresh = options?.forceRefresh === true;
  const noCache = options?.noCache === true;
  const resetPlaceholders = options?.resetPlaceholders === true;
  const normalizedSource = sourceInterval
    ? normalizeSourceInterval(sourceInterval)
    : getPreferredDivergenceSourceInterval();
  const cells = Array.from(
    container.querySelectorAll<HTMLElement>('.div-dot-row[data-ticker], .divergence-mini[data-ticker]'),
  );
  if (!cells.length) return;

  if (resetPlaceholders) {
    renderMiniDivergencePlaceholders(container);
  }
  const tickers = Array.from(new Set(cells.map((cell) => normalizeTicker(cell.dataset.ticker)).filter(Boolean)));
  if (!tickers.length) return;

  const batchSize = 60;
  const fetchedByTicker = new Map<string, DivergenceSummaryEntry>();
  for (let i = 0; i < tickers.length; i += batchSize) {
    const chunk = tickers.slice(i, i + batchSize);
    const shouldForceRefreshChunk = (forceRefresh || noCache) && (noCache || chunk.length > 1);
    const fetched = await fetchDivergenceSummariesBatch(
      chunk,
      normalizedSource,
      shouldForceRefreshChunk ? { forceRefresh: true, noCache } : undefined,
    );
    for (const [ticker, summary] of fetched.entries()) {
      fetchedByTicker.set(ticker, summary);
    }
  }

  for (const cell of cells) {
    const ticker = normalizeTicker(cell.dataset.ticker);
    if (!ticker) continue;
    const summary = fetchedByTicker.get(ticker) || null;
    renderMiniDivergenceRow(cell, summary);
  }
}

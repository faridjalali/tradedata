export type DivergenceState = 'bullish' | 'bearish' | 'neutral';

export const DIVERGENCE_LOOKBACK_DAYS = [1, 3, 7, 14, 28] as const;

export interface DivergenceSummaryEntry {
  ticker: string;
  tradeDate: string | null;
  states: Record<string, DivergenceState>;
  expiresAtMs: number;
}

interface DivergenceSummaryApiPayload {
  sourceInterval?: string;
  refreshedAt?: string;
  summaries?: Array<{
    ticker?: string;
    tradeDate?: string | null;
    states?: Record<string, string>;
    expiresAtMs?: number;
  }>;
}

type DivergenceSummaryApiItem = NonNullable<DivergenceSummaryApiPayload['summaries']>[number];

const divergenceSummaryCache = new Map<string, DivergenceSummaryEntry>();
const divergenceSummaryBatchInFlight = new Map<string, Promise<void>>();

function normalizeState(raw: unknown): DivergenceState {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'bullish' || value === 'bearish') return value;
  return 'neutral';
}

function normalizeTicker(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function cacheKeyFor(ticker: string, sourceInterval: string): string {
  return `${normalizeTicker(ticker)}|${String(sourceInterval || '5min').trim() || '5min'}`;
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
}

function buildNeutralStates(): Record<string, DivergenceState> {
  const out: Record<string, DivergenceState> = {};
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    out[String(days)] = 'neutral';
  }
  return out;
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
  const safeExpiresAt = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
    ? expiresAtMs
    : (Date.now() + (60 * 60 * 1000));
  return {
    ticker,
    tradeDate: typeof item?.tradeDate === 'string' ? item.tradeDate : null,
    states,
    expiresAtMs: safeExpiresAt
  };
}

async function fetchDivergenceSummariesBatch(tickers: string[], sourceInterval: string): Promise<void> {
  const uniqueTickers = Array.from(new Set(
    tickers
      .map((ticker) => normalizeTicker(ticker))
      .filter(Boolean)
  ));
  if (uniqueTickers.length === 0) return;

  const requestKey = `${sourceInterval}|${uniqueTickers.join(',')}`;
  if (divergenceSummaryBatchInFlight.has(requestKey)) {
    await divergenceSummaryBatchInFlight.get(requestKey);
    return;
  }

  const batchPromise = (async () => {
    const params = new URLSearchParams();
    params.set('tickers', uniqueTickers.join(','));
    params.set('vdSourceInterval', sourceInterval);
    const response = await fetch(`/api/chart/divergence-summary?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch divergence summary (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as DivergenceSummaryApiPayload;
    const rows = Array.isArray(payload?.summaries) ? payload.summaries : [];
    for (const row of rows) {
      const normalized = normalizeApiSummary(row);
      if (!normalized) continue;
      setCachedSummary(sourceInterval, normalized);
    }
  })()
    .catch(() => {
      // Keep summary fetching best-effort.
    })
    .finally(() => {
      divergenceSummaryBatchInFlight.delete(requestKey);
    });

  divergenceSummaryBatchInFlight.set(requestKey, batchPromise);
  await batchPromise;
}

export async function getTickerDivergenceSummary(
  ticker: string,
  sourceInterval: string = '5min'
): Promise<DivergenceSummaryEntry | null> {
  const normalizedTicker = normalizeTicker(ticker);
  const normalizedSource = String(sourceInterval || '5min').trim() || '5min';
  if (!normalizedTicker) return null;

  const cached = getCachedSummary(normalizedTicker, normalizedSource);
  if (cached) return cached;
  await fetchDivergenceSummariesBatch([normalizedTicker], normalizedSource);
  return getCachedSummary(normalizedTicker, normalizedSource);
}

export function renderMiniDivergenceRow(
  root: ParentNode,
  summary: DivergenceSummaryEntry | null
): void {
  const nodes = root.querySelectorAll<HTMLElement>('.divergence-mini-cell');
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
  const parent = root instanceof HTMLElement
    ? root
    : (root as Element | null);
  if (parent instanceof HTMLElement) {
    if (summary?.tradeDate) {
      parent.dataset.tradeDate = summary.tradeDate;
      parent.title = `Daily divergence as of ${summary.tradeDate}`;
    } else {
      parent.removeAttribute('data-trade-date');
      parent.title = 'Daily divergence';
    }
  }
}

export function renderMiniDivergencePlaceholders(root: ParentNode): void {
  const nodes = root.querySelectorAll<HTMLElement>('.divergence-mini-cell');
  nodes.forEach((node) => {
    node.classList.remove('is-bullish', 'is-bearish');
    node.classList.add('is-neutral');
  });
}

export async function hydrateAlertCardDivergenceTables(
  container: ParentNode,
  sourceInterval: string = '5min'
): Promise<void> {
  const cells = Array.from(container.querySelectorAll<HTMLElement>('.divergence-mini[data-ticker]'));
  if (!cells.length) return;

  renderMiniDivergencePlaceholders(container);
  const tickers = Array.from(new Set(
    cells
      .map((cell) => normalizeTicker(cell.dataset.ticker))
      .filter(Boolean)
  ));
  if (!tickers.length) return;

  const batchSize = 60;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const chunk = tickers.slice(i, i + batchSize);
    await fetchDivergenceSummariesBatch(chunk, sourceInterval);
  }

  for (const cell of cells) {
    const ticker = normalizeTicker(cell.dataset.ticker);
    if (!ticker) continue;
    const summary = getCachedSummary(ticker, sourceInterval);
    renderMiniDivergenceRow(cell, summary);
  }
}

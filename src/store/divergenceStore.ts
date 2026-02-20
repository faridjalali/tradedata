/**
 * divergenceStore — Zustand store for divergence signal + column state.
 *
 * Replaces the mutable module-level variables in `divergenceState.ts`,
 * `state.ts`, and `divergenceFeedRender.ts` with a centralised,
 * observable store.
 */

import { createStore } from 'zustand/vanilla';
import type { Alert, SortMode } from '../types';

// ---------------------------------------------------------------------------
// Column state types (migrated from divergenceFeedRender.ts)
// ---------------------------------------------------------------------------

export type ColumnFeedMode = '1' | '5' | '30' | 'custom';
export type ColumnKey = 'daily' | 'weekly';

export interface ColumnState {
  feedMode: ColumnFeedMode;
  customFrom: string;
  customTo: string;
  sortMode: SortMode;
  sortDirection: 'asc' | 'desc';
  preFavSortMode: SortMode | null;
  preFavSortDirection: 'asc' | 'desc';
  visibleCount: number;
}

const ALERTS_PAGE_SIZE = 100;

const COLUMN_DEFAULTS: ColumnState = {
  feedMode: '1',
  customFrom: '',
  customTo: '',
  sortMode: 'score',
  sortDirection: 'desc',
  preFavSortMode: null,
  preFavSortDirection: 'desc',
  visibleCount: ALERTS_PAGE_SIZE,
};

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface DivergenceState {
  /** All divergence signals (daily + weekly merged). */
  signals: Alert[];
  /** All live-feed alerts (legacy `state.ts`). */
  alerts: Alert[];
  /** In-flight optimistic favorite toggles. */
  pendingFavorites: Map<number, boolean>;
  /** Per-column state for daily/weekly. */
  columns: Record<ColumnKey, ColumnState>;
}

export interface DivergenceActions {
  // --- Signals ---
  getSignals: () => Alert[];
  setSignals: (signals: Alert[]) => void;
  setSignalsByTimeframe: (timeframe: '1d' | '1w', signals: Alert[]) => void;

  // --- Alerts (legacy) ---
  getAlerts: () => Alert[];
  setAlerts: (alerts: Alert[]) => void;

  // --- Optimistic favorites ---
  addPendingFavorite: (id: number, isFavorite: boolean) => void;
  removePendingFavorite: (id: number) => void;

  // --- Column state ---
  getColumn: (key: ColumnKey) => ColumnState;
  setColumnFeedMode: (key: ColumnKey, mode: ColumnFeedMode) => void;
  setColumnCustomDates: (key: ColumnKey, from: string, to: string) => void;
  setColumnSort: (key: ColumnKey, mode: SortMode, direction: 'asc' | 'desc') => void;
  setColumnPreFavSort: (key: ColumnKey, mode: SortMode | null, direction: 'asc' | 'desc') => void;
  setColumnVisibleCount: (key: ColumnKey, count: number) => void;
  incrementColumnVisibleCount: (key: ColumnKey) => void;
  resetColumnDefaults: () => void;
}

function applyPendingFavorites(signals: Alert[], pending: Map<number, boolean>): void {
  if (pending.size === 0) return;
  for (const signal of signals) {
    const val = pending.get(signal.id);
    if (val !== undefined) signal.is_favorite = val;
  }
}

export const divergenceStore = createStore<DivergenceState & DivergenceActions>()((set, get) => ({
  signals: [],
  alerts: [],
  pendingFavorites: new Map(),
  columns: {
    daily: { ...COLUMN_DEFAULTS },
    weekly: { ...COLUMN_DEFAULTS },
  },

  // --- Signals ---
  getSignals: () => get().signals,
  setSignals: (signals) => set({ signals }),
  setSignalsByTimeframe: (timeframe, signals) => {
    applyPendingFavorites(signals, get().pendingFavorites);
    const kept = get().signals.filter((a) => (a.timeframe || '').trim() !== timeframe);
    set({ signals: [...kept, ...signals] });
  },

  // --- Alerts ---
  getAlerts: () => get().alerts,
  setAlerts: (alerts) => set({ alerts }),

  // --- Favorites ---
  addPendingFavorite: (id, isFavorite) => {
    const next = new Map(get().pendingFavorites);
    next.set(id, isFavorite);
    set({ pendingFavorites: next });
  },
  removePendingFavorite: (id) => {
    const next = new Map(get().pendingFavorites);
    next.delete(id);
    set({ pendingFavorites: next });
  },

  // --- Column state ---
  getColumn: (key) => get().columns[key],
  setColumnFeedMode: (key, mode) => {
    const cols = { ...get().columns };
    cols[key] = { ...cols[key], feedMode: mode };
    set({ columns: cols });
  },
  setColumnCustomDates: (key, from, to) => {
    const cols = { ...get().columns };
    cols[key] = { ...cols[key], customFrom: from, customTo: to };
    set({ columns: cols });
  },
  setColumnSort: (key, mode, direction) => {
    const cols = { ...get().columns };
    cols[key] = { ...cols[key], sortMode: mode, sortDirection: direction };
    set({ columns: cols });
  },
  setColumnPreFavSort: (key, mode, direction) => {
    const cols = { ...get().columns };
    cols[key] = { ...cols[key], preFavSortMode: mode, preFavSortDirection: direction };
    set({ columns: cols });
  },
  setColumnVisibleCount: (key, count) => {
    const cols = { ...get().columns };
    cols[key] = { ...cols[key], visibleCount: count };
    set({ columns: cols });
  },
  incrementColumnVisibleCount: (key) => {
    const cols = { ...get().columns };
    cols[key] = { ...cols[key], visibleCount: cols[key].visibleCount + ALERTS_PAGE_SIZE };
    set({ columns: cols });
  },
  resetColumnDefaults: () => {
    set({
      columns: {
        daily: { ...COLUMN_DEFAULTS },
        weekly: { ...COLUMN_DEFAULTS },
      },
    });
  },
}));

/**
 * divergenceStore — Zustand store for divergence signal state.
 *
 * Replaces the mutable module-level variables in `divergenceState.ts` and
 * `state.ts` with a centralised, observable store.
 */

import { createStore } from 'zustand/vanilla';
import type { Alert } from '../types';

export interface DivergenceState {
  /** All divergence signals (daily + weekly merged). */
  signals: Alert[];
  /** All live-feed alerts (legacy `state.ts`). */
  alerts: Alert[];
  /** In-flight optimistic favorite toggles. */
  pendingFavorites: Map<number, boolean>;
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
}));

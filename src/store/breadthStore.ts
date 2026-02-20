/**
 * breadthStore — Zustand store for breadth view configuration state.
 *
 * Centralises the mutable module-level config variables from `breadth.ts`.
 * Chart.js instances remain as module-level refs since they are not
 * serialisable and don't benefit from store observability.
 */

import { createStore } from 'zustand/vanilla';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BreadthMetric = 'SVIX' | 'RSP' | 'MAGS';

export interface BreadthState {
  /** Main breadth chart timeframe in days. */
  timeframeDays: number;
  /** Main breadth chart comparison metric. */
  metric: BreadthMetric;
  /** Currently selected MA index ticker. */
  maIndex: string;
  /** Comparative chart: selected index. */
  compareIndex: string;
  /** Comparative chart: timeframe in days. */
  compareTfDays: number;
  /** Whether dual-compare mode is active. */
  compareModeActive: boolean;
  /** In compare mode: the locked (first) ticker. */
  lockedCompareIndex: string | null;
  /** In compare mode: the second selected ticker. */
  compareIndex2: string | null;
  /** ETF bar rankings: selected MA window. */
  barsMA: string;
}

export interface BreadthActions {
  setTimeframeDays: (days: number) => void;
  setMetric: (metric: BreadthMetric) => void;
  setMAIndex: (index: string) => void;
  setCompareIndex: (index: string) => void;
  setCompareTfDays: (days: number) => void;
  setCompareModeActive: (active: boolean) => void;
  setLockedCompareIndex: (index: string | null) => void;
  setCompareIndex2: (index: string | null) => void;
  setBarsMA: (ma: string) => void;
}

export const breadthStore = createStore<BreadthState & BreadthActions>()((set) => ({
  timeframeDays: 5,
  metric: 'SVIX',
  maIndex: 'SPY',
  compareIndex: 'SPY',
  compareTfDays: 20,
  compareModeActive: false,
  lockedCompareIndex: null,
  compareIndex2: null,
  barsMA: '21',

  setTimeframeDays: (days) => set({ timeframeDays: days }),
  setMetric: (metric) => set({ metric }),
  setMAIndex: (index) => set({ maIndex: index }),
  setCompareIndex: (index) => set({ compareIndex: index }),
  setCompareTfDays: (days) => set({ compareTfDays: days }),
  setCompareModeActive: (active) => set({ compareModeActive: active }),
  setLockedCompareIndex: (index) => set({ lockedCompareIndex: index }),
  setCompareIndex2: (index) => set({ compareIndex2: index }),
  setBarsMA: (ma) => set({ barsMA: ma }),
}));

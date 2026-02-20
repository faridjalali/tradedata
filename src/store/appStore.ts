/**
 * appStore — Zustand store for application-level navigation state.
 *
 * Centralises the mutable variables that were previously scattered as
 * module-level `let` declarations in `main.ts`.
 */

import { createStore } from 'zustand/vanilla';
import type { ViewName } from '../router';
import type { TickerListContext } from '../types';

export interface AppState {
  currentView: ViewName;
  adminMounted: boolean;
  breadthMounted: boolean;
  appInitialized: boolean;
  divergenceDashboardScrollY: number;
  tickerOriginView: 'divergence';
  tickerListContext: TickerListContext;
}

export interface AppActions {
  setCurrentView: (view: ViewName) => void;
  setAdminMounted: (v: boolean) => void;
  setBreadthMounted: (v: boolean) => void;
  setAppInitialized: () => void;
  saveDivergenceScroll: () => void;
  restoreDivergenceScroll: () => void;
  setTickerOriginView: (view: 'divergence') => void;
  setTickerListContext: (ctx: TickerListContext) => void;
}

export const appStore = createStore<AppState & AppActions>()((set, get) => ({
  currentView: 'divergence',
  adminMounted: false,
  breadthMounted: false,
  appInitialized: false,
  divergenceDashboardScrollY: 0,
  tickerOriginView: 'divergence',
  tickerListContext: null,

  setCurrentView: (view) => set({ currentView: view }),
  setAdminMounted: (v) => set({ adminMounted: v }),
  setBreadthMounted: (v) => set({ breadthMounted: v }),
  setAppInitialized: () => set({ appInitialized: true }),
  saveDivergenceScroll: () => set({ divergenceDashboardScrollY: window.scrollY }),
  restoreDivergenceScroll: () => {
    const y = get().divergenceDashboardScrollY;
    window.scrollTo(0, y);
  },
  setTickerOriginView: (view) => set({ tickerOriginView: view }),
  setTickerListContext: (ctx) => set({ tickerListContext: ctx }),
}));

/**
 * divergenceState.ts — Legacy compatibility wrapper.
 * Delegates to the Zustand divergenceStore so all existing consumers
 * (divergenceFeedRender.ts, divergenceFeedEvents.ts, ticker.ts) continue
 * working without import changes.
 */

import { divergenceStore } from './store/divergenceStore';
import type { Alert } from './types';

export function addPendingFavoriteToggle(id: number, isFavorite: boolean): void {
  divergenceStore.getState().addPendingFavorite(id, isFavorite);
}

export function removePendingFavoriteToggle(id: number): void {
  divergenceStore.getState().removePendingFavorite(id);
}

export function getDivergenceSignals(): Alert[] {
  return divergenceStore.getState().getSignals();
}

export function setDivergenceSignals(signals: Alert[]): void {
  divergenceStore.getState().setSignals(signals);
}

/** Replace only signals matching `timeframe`, keeping the other timeframe untouched. */
export function setDivergenceSignalsByTimeframe(timeframe: '1d' | '1w', signals: Alert[]): void {
  divergenceStore.getState().setSignalsByTimeframe(timeframe, signals);
}

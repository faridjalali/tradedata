import { Alert } from './types';

let allDivergenceSignals: Alert[] = [];

/**
 * Tracks in-flight favorite toggles so that auto-refresh re-renders don't
 * overwrite an optimistic UI update with stale server data.
 * Key = signal ID, value = optimistic is_favorite value.
 */
const pendingFavoriteToggles = new Map<number, boolean>();

export function addPendingFavoriteToggle(id: number, isFavorite: boolean): void {
  pendingFavoriteToggles.set(id, isFavorite);
}

export function removePendingFavoriteToggle(id: number): void {
  pendingFavoriteToggles.delete(id);
}

/** Apply pending favorite overrides onto a signal array (mutates in place). */
function applyPendingFavorites(signals: Alert[]): void {
  if (pendingFavoriteToggles.size === 0) return;
  for (const signal of signals) {
    const pending = pendingFavoriteToggles.get(signal.id);
    if (pending !== undefined) {
      signal.is_favorite = pending;
    }
  }
}

export function getDivergenceSignals(): Alert[] {
  return allDivergenceSignals;
}

export function setDivergenceSignals(signals: Alert[]): void {
  allDivergenceSignals = signals;
}

/** Replace only signals matching `timeframe`, keeping the other timeframe untouched. */
export function setDivergenceSignalsByTimeframe(timeframe: '1d' | '1w', signals: Alert[]): void {
  applyPendingFavorites(signals);
  const kept = allDivergenceSignals.filter((a) => (a.timeframe || '').trim() !== timeframe);
  allDivergenceSignals = [...kept, ...signals];
}

/**
 * state.ts — Legacy compatibility wrapper.
 * Delegates to the Zustand divergenceStore for all live-feed alert state.
 */

import { divergenceStore } from './store/divergenceStore';
import type { Alert } from './types';

export function getAlerts(): Alert[] {
  return divergenceStore.getState().getAlerts();
}

export function setAlerts(alerts: Alert[]): void {
  divergenceStore.getState().setAlerts(alerts);
}

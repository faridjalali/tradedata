export type { Alert } from '../shared/api-types';
import type { Alert } from '../shared/api-types';

export interface AppState {
  alerts: Alert[];
}

export type SortMode = 'time' | 'volume' | 'favorite' | 'score';
export type TickerListContext = 'daily' | 'weekly' | null;

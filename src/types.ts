export interface Alert {
    id?: number;
    ticker: string;
    signal_type: string;
    price?: number;
    message?: string;
    timestamp?: string;
    timeframe?: string;
    signal_direction?: number;
    signal_volume?: number;
    intensity_score?: number;
    combo_score?: number;
    is_favorite?: boolean;
}

export interface AppState {
    alerts: Alert[];
}

export type LiveFeedMode = '30' | '7' | '1' | 'week' | 'month';
export type SortMode = 'time' | 'volume' | 'intensity' | 'combo' | 'favorite';

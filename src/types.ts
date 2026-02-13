export interface Alert {
    id: number;
    ticker: string;
    signal_type: string;
    price?: number;
    message?: string;
    timestamp?: string;
    signal_trade_date?: string | null;
    timeframe?: string;
    signal_direction?: number;
    signal_volume?: number;
    intensity_score?: number;
    combo_score?: number;
    is_favorite: boolean;
    source?: 'TV' | 'DataAPI';
    divergence_states?: Record<string, string>;
    divergence_trade_date?: string | null;
    ma_states?: {
        ema8?: boolean;
        ema21?: boolean;
        sma50?: boolean;
        sma200?: boolean;
    };
}

export interface AppState {
    alerts: Alert[];
}

export type LiveFeedMode = 'today' | 'yesterday' | '30' | '7' | 'week' | 'month';
export type SortMode = 'time' | 'volume' | 'combo' | 'favorite';

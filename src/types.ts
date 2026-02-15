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
    vdf_detected?: boolean;
}

export interface AppState {
    alerts: Alert[];
}


export type SortMode = 'time' | 'volume' | 'favorite' | 'score';
export type TickerListContext = 'daily' | 'weekly' | null;

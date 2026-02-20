import type { ColumnType } from 'kysely';

export type Json = ColumnType<string, string, string>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface Alerts {
  id: Generated<number>;
  ticker: string;
  signal_type: string | null;
  trade_date: string | null;
  price: string | null;
  prev_close: string | null;
  volume: number | null;
  avg_volume: number | null;
  rsi: string | null;
  vdf_score: string | null;
  vdf_proximity: string | null;
  vdf_detected: boolean | null;
  bull_flag_confidence: number | null;
  divergence_states: Json | null;
  ma_states: Json | null;
  is_favorite: Generated<boolean>;
  timestamp: Generated<Timestamp>;
}

export interface DivergenceSignals {
  id: Generated<number>;
  ticker: string;
  signal_type: string;
  price: string | null;
  trade_date: string;
  timeframe: string;
  volume_delta: string | null;
  vdf_detected: boolean | null;
  vd_history: Json | null;
  vdf_details: Json | null;
  is_favorite: Generated<boolean>;
  timestamp: Generated<Timestamp>;
}

export interface RunMetricsHistory {
  id: Generated<number>;
  run_id: string;
  run_type: string;
  status: string;
  snapshot: Json;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface TickerHistory {
  ticker: string;
  data_source: string;
  history_data: Json;
  last_updated: Generated<Timestamp>;
}

export interface BreadthDailyCloses {
  ticker: string;
  trade_date: string;
  close: string | number;
  updated_at: Generated<Timestamp>;
}

export interface VdfResults {
  ticker: string;
  trade_date: string;
  best_zone_score: string | number;
  proximity_level: string;
  num_zones: number;
  bull_flag_confidence: string | number | null;
  is_detected: boolean;
  raw_vdf_score: string | number;
  updated_at: Generated<Timestamp>;
}

export interface BreadthSnapshots {
  trade_date: string;
  index_name: string;
  pct_above_ma21: string | number;
  pct_above_ma50: string | number;
  pct_above_ma100: string | number;
  pct_above_ma200: string | number;
  total_constituents: number;
  updated_at: Generated<Timestamp>;
}

export interface BreadthHistory {
  id: Generated<number>;
  snapshot: Json;
  created_at: Generated<Timestamp>;
}

export interface BreadthConstituentOverrides {
  index_name: string;
  ticker: string;
  source: string;
  updated_at: Generated<Timestamp>;
}

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

export interface Database {
  alerts: Alerts;
  divergence_signals: DivergenceSignals;
  run_metrics_history: RunMetricsHistory;
  ticker_history: TickerHistory;
  breadth_daily_closes: BreadthDailyCloses;
  breadth_snapshots: BreadthSnapshots;
  breadth_history: BreadthHistory;
  breadth_constituent_overrides: BreadthConstituentOverrides;
  vdf_results: VdfResults;
}

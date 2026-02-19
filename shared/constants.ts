// Shared constants — single source of truth for values used by both server and frontend.

export const VALID_CHART_INTERVALS = ['5min', '15min', '30min', '1hour', '4hour', '1day', '1week'] as const;

export const VOLUME_DELTA_SOURCE_INTERVALS = ['1min', '5min', '15min', '30min', '1hour', '4hour'] as const;

export const DIVERGENCE_LOOKBACK_DAYS = [1, 3, 7, 14, 28] as const;

/** Build a Record mapping each lookback day to 'neutral'. */
export function buildNeutralDivergenceStates(): Record<string, string> {
  const states: Record<string, string> = {};
  for (const days of DIVERGENCE_LOOKBACK_DAYS) {
    states[String(days)] = 'neutral';
  }
  return states;
}

import { db } from '../db.js';
import { getStoredDivergenceSummariesForTickers, buildNeutralDivergenceStateMap } from './divergenceStateService.js';

interface VdfEnrichment {
  score: number;
  proximityLevel: string;
  numZones: number;
  bullFlagConfidence: number | null;
}

/**
 * Enrich alert/signal rows with divergence summaries and VDF data.
 * Shared by GET /api/alerts and GET /api/divergence/signals.
 */
export async function enrichRowsWithDivergenceData(opts: {
  rows: Record<string, unknown>[];
  tickers: string[];
  sourceInterval: string;
  contextLabel: string;
}): Promise<Record<string, unknown>[]> {
  const { rows, tickers, sourceInterval, contextLabel } = opts;

  // 1. Fetch divergence summaries
  let summariesByTicker = new Map<string, Record<string, unknown>>();
  try {
    summariesByTicker = await getStoredDivergenceSummariesForTickers(tickers, sourceInterval, {
      includeLatestFallbackForMissing: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to enrich ${contextLabel} with divergence summaries: ${message}`);
  }

  const neutralStates = buildNeutralDivergenceStateMap();

  // 2. Fetch VDF results (latest detected row per ticker).
  // Do not pin to "today" because alert feeds can span earlier trade dates and
  // scans may not have run yet for the current ET date.
  const vdfDataMap = new Map<string, VdfEnrichment>();
  try {
    if (tickers.length > 0) {
      const vdfRes = await db
        .selectFrom('vdf_results')
        .select(['ticker', 'best_zone_score', 'proximity_level', 'num_zones', 'bull_flag_confidence'])
        .distinctOn(['ticker'])
        .where('is_detected', '=', true)
        .where('ticker', 'in', tickers)
        .orderBy('ticker', 'asc')
        .orderBy('trade_date', 'desc')
        .execute();

      for (const row of vdfRes) {
        vdfDataMap.set(String(row.ticker).toUpperCase(), {
          score: Math.min(100, Math.round((Number(row.best_zone_score) || 0) * 100)),
          proximityLevel: row.proximity_level || 'none',
          numZones: Number(row.num_zones) || 0,
          bullFlagConfidence: row.bull_flag_confidence != null ? Number(row.bull_flag_confidence) : null,
        });
      }
    }
  } catch {
    /* VDF enrichment is non-critical */
  }

  // 3. Map enriched rows
  return rows.map((row) => {
    const ticker = String(row?.ticker || '')
      .trim()
      .toUpperCase();
    const summary = (summariesByTicker.get(ticker) || null) as Record<string, unknown> | null;
    const states = (summary?.states || neutralStates) as Record<string, string>;
    const vdfData = vdfDataMap.get(ticker);
    return {
      ...row,
      divergence_trade_date: summary?.tradeDate || null,
      ma_states: {
        ema8: Boolean((summary?.maStates as Record<string, unknown>)?.ema8),
        ema21: Boolean((summary?.maStates as Record<string, unknown>)?.ema21),
        sma50: Boolean((summary?.maStates as Record<string, unknown>)?.sma50),
        sma200: Boolean((summary?.maStates as Record<string, unknown>)?.sma200),
      },
      divergence_states: {
        1: String(states['1'] || 'neutral'),
        3: String(states['3'] || 'neutral'),
        7: String(states['7'] || 'neutral'),
        14: String(states['14'] || 'neutral'),
        28: String(states['28'] || 'neutral'),
      },
      vdf_detected: !!vdfData,
      vdf_score: vdfData?.score || 0,
      vdf_proximity: vdfData?.proximityLevel || 'none',
      bull_flag_confidence: vdfData?.bullFlagConfidence ?? null,
    };
  });
}

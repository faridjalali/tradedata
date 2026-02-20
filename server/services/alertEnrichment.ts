import { divergenceDb } from '../db.js';
import { getStoredDivergenceSummariesForTickers, buildNeutralDivergenceStateMap } from './divergenceStateService.js';

interface VdfEnrichment {
  detected: boolean;
  score: number;
  proximityLevel: string;
  numZones: number;
  bullFlagConfidence: number | null;
}

function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 't' || normalized === 'yes';
  }
  return false;
}

function normalizeVdfScore(score: number | null): number {
  if (score === null || score === undefined) return 0;
  if (score >= 0 && score <= 1) return Math.min(100, Math.round(score * 100));
  return Math.min(100, Math.max(0, Math.round(score)));
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
    if (tickers.length > 0 && divergenceDb) {
      const vdfRes = await divergenceDb
        .selectFrom('vdf_results')
        .select(['ticker', 'is_detected', 'best_zone_score', 'proximity_level', 'num_zones', 'bull_flag_confidence'])
        .distinctOn(['ticker'])
        .where('ticker', 'in', tickers)
        .orderBy('ticker', 'asc')
        .orderBy('trade_date', 'desc')
        .execute();

      for (const row of vdfRes) {
        const bestZoneScore = toOptionalNumber((row as unknown as { best_zone_score?: unknown }).best_zone_score);
        const rawScore = bestZoneScore ?? 0;
        const normalizedScore = rawScore <= 1 ? rawScore * 100 : rawScore;
        const detected = toBoolean((row as unknown as { is_detected?: unknown }).is_detected);

        vdfDataMap.set(String(row.ticker).toUpperCase(), {
          detected,
          score: normalizeVdfScore(normalizedScore),
          proximityLevel: row.proximity_level || 'none',
          numZones: Number(row.num_zones) || 0,
          bullFlagConfidence:
            row.bull_flag_confidence === null || row.bull_flag_confidence === undefined
              ? null
              : Number(row.bull_flag_confidence),
        });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to enrich ${contextLabel} with VDF data: ${message}`);
  }

  // 3. Map enriched rows
  return rows.map((row) => {
    const ticker = String(row?.ticker || '')
      .trim()
      .toUpperCase();
    const summary = (summariesByTicker.get(ticker) || null) as Record<string, unknown> | null;
    const states = (summary?.states || neutralStates) as Record<string, string>;
    const vdfData = vdfDataMap.get(ticker);
    const rowVdfDetected = toBoolean(row?.vdf_detected);
    const rowVdfScore = normalizeVdfScore(toOptionalNumber(row?.vdf_score));
    const rowBullFlagConfidence = toOptionalNumber(row?.bull_flag_confidence);
    const rowVdfProximity =
      typeof row?.vdf_proximity === 'string' && row.vdf_proximity.trim() ? String(row.vdf_proximity).trim() : 'none';

    const mergedVdfDetected = Boolean(vdfData?.detected) || rowVdfDetected || rowVdfScore > 0;

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
      vdf_detected: mergedVdfDetected,
      vdf_score: normalizeVdfScore(vdfData?.score ?? rowVdfScore),
      vdf_proximity: vdfData?.proximityLevel || rowVdfProximity,
      bull_flag_confidence: vdfData?.bullFlagConfidence ?? rowBullFlagConfidence,
    };
  });
}

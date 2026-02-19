/**
 * Volume Divergence Flag (VDF) Detector — Orchestrator
 * =====================================================
 * Detects hidden institutional accumulation during multi-week price declines
 * using 1-minute volume delta to reveal net buying that diverges from price.
 *
 * Algorithm modules:
 *   vdfTypes.ts           — shared interfaces
 *   vdfMath.ts            — mean / std / linReg
 *   vdfAggregation.ts     — 1m bars → daily → weekly aggregation
 *   vdfScoring.ts         — 8-component subwindow scoring
 *   vdfZoneDetection.ts   — accumulation zone clustering + distribution detection
 *   vdfProximitySignals.ts — 7 proximity signals → composite score
 *
 * See ALGORITHM-VD-ACCUMULATION.md for full documentation.
 */

import { detectBullFlag } from '../../shared/bullFlagDetector.js';
import type { ScoredZone, FormattedZone, ProximitySignal, DetectVDFOptions } from './vdfTypes.js';
import { vdAggregateDaily } from './vdfAggregation.js';
import { scoreSubwindow } from './vdfScoring.js';
import { findAccumulationZones, findDistributionClusters } from './vdfZoneDetection.js';
import { evaluateProximitySignals } from './vdfProximitySignals.js';
import { buildWeeks } from './vdfAggregation.js';

async function detectVDF(ticker: string, options: DetectVDFOptions) {
  const { dataApiFetcher, signal, mode = 'scan' } = options;
  const RECENT_DAYS = 90;

  const emptyResult = (reason: string, status: string) => ({
    detected: false,
    bestScore: 0,
    bestZoneWeeks: 0,
    reason,
    status,
    zones: [] as FormattedZone[],
    allZones: [] as FormattedZone[],
    distribution: [] as { startDate: string; endDate: string; spanDays: number; priceChangePct: number; netDeltaPct: number }[],
    proximity: { compositeScore: 0, level: 'none', signals: [] as ProximitySignal[] },
    metrics: {} as Record<string, unknown>,
    bull_flag_confidence: null as number | null,
  });

  try {
    const fetchDays = mode === 'chart' ? 365 : 150;
    const bars1m = await dataApiFetcher(ticker, '1min', fetchDays, { signal });
    if (!bars1m || bars1m.length < 500) {
      return emptyResult('insufficient_1m_data', 'Insufficient 1m data');
    }

    const sorted = bars1m.sort((a, b) => a.time - b.time);
    const latestTime = sorted[sorted.length - 1].time;

    const scanCutoff = mode === 'chart' ? sorted[0].time : latestTime - RECENT_DAYS * 86400;
    const preCutoff = (mode === 'chart' ? sorted[0].time : scanCutoff) - 30 * 86400;

    const scanBars = sorted.filter((b) => b.time >= scanCutoff);
    const preBars = sorted.filter((b) => b.time >= preCutoff && b.time < scanCutoff);

    if (scanBars.length < 200) {
      return emptyResult('insufficient_scan_data', 'Insufficient scan data');
    }

    const allDaily = vdAggregateDaily(scanBars);
    const preDaily = vdAggregateDaily(preBars);

    const bfBars = allDaily.map((d) => ({ time: d.date, open: d.open, high: d.high, low: d.low, close: d.close }));
    const bfResult = detectBullFlag(bfBars);

    if (allDaily.length < 10) {
      return emptyResult('insufficient_daily_data', 'Insufficient daily data');
    }

    const zones = findAccumulationZones(allDaily, preDaily, 5);
    const { distClusters } = findDistributionClusters(allDaily);

    const recentCutoffDate = new Date(latestTime * 1000);
    recentCutoffDate.setDate(recentCutoffDate.getDate() - RECENT_DAYS);
    const recentCutoffStr = recentCutoffDate.toISOString().split('T')[0];

    const recentZones = zones.filter((z: ScoredZone) => z.endDate >= recentCutoffStr);
    const scoringZones = recentZones;

    const proximity = evaluateProximitySignals(allDaily, scoringZones);

    const bestZone =
      scoringZones.length > 0
        ? scoringZones.reduce((best: ScoredZone, z: ScoredZone) => (z.score > best.score ? z : best), scoringZones[0])
        : null;
    const bestScore = bestZone ? bestZone.score : 0;
    const bestZoneWeeks = bestZone ? bestZone.weeks : 0;
    const detected = scoringZones.length > 0;

    let status;
    if (detected) {
      status = `VD Accumulation detected: ${scoringZones.length} zone${scoringZones.length > 1 ? 's' : ''}, best ${bestScore.toFixed(2)} (${bestZoneWeeks}wk)`;
      if (proximity.level !== 'none') status += ` | Proximity: ${proximity.level} (${proximity.compositeScore}pts)`;
      if (distClusters.length > 0) status += ` | ${distClusters.length} distribution cluster${distClusters.length > 1 ? 's' : ''}`;
    } else {
      status = 'No accumulation zones detected';
    }

    const formatZone = (z: ScoredZone): FormattedZone => ({
      rank: z.rank,
      startDate: z.startDate,
      endDate: z.endDate,
      windowDays: z.winSize,
      score: z.score,
      weeks: z.weeks,
      accumWeeks: z.accumWeeks,
      netDeltaPct: z.netDeltaPct,
      absorptionPct: z.absorptionPct,
      accumWeekRatio: z.accumWeekRatio,
      overallPriceChange: z.overallPriceChange,
      components: z.components,
      durationMultiplier: z.durationMultiplier,
      concordancePenalty: z.concordancePenalty,
      intraRally: z.intraRally,
      concordantFrac: z.concordantFrac,
    });

    return {
      detected,
      bestScore,
      bestZoneWeeks,
      status,
      reason: detected ? 'accumulation_divergence' : 'below_threshold',
      zones: scoringZones.map(formatZone),
      allZones: zones.map(formatZone),
      distribution: distClusters.map((c) => ({
        startDate: c.startDate,
        endDate: c.endDate,
        spanDays: c.spanDays ?? (c.end - c.start + 1),
        priceChangePct: c.priceChangePct ?? c.maxPriceChg,
        netDeltaPct: c.netDeltaPct ?? c.minDeltaPct,
      })),
      proximity,
      metrics: {
        totalDays: allDaily.length,
        scanStart: allDaily[0]?.date,
        scanEnd: allDaily[allDaily.length - 1]?.date,
        preDays: preDaily.length,
        recentCutoff: recentCutoffStr,
      },
      bull_flag_confidence: bfResult?.confidence ?? null,
    };
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || err.message === 'This operation was aborted')) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      detected: false,
      bestScore: 0,
      bestZoneWeeks: 0,
      reason: `error: ${message}`,
      status: `Error: ${message}`,
      zones: [],
      allZones: [],
      distribution: [],
      proximity: { compositeScore: 0, level: 'none', signals: [] as ProximitySignal[] },
      metrics: {},
      bull_flag_confidence: null,
    };
  }
}

export {
  detectVDF,
  scoreSubwindow,
  findAccumulationZones,
  findDistributionClusters,
  evaluateProximitySignals,
  vdAggregateDaily,
  buildWeeks,
};

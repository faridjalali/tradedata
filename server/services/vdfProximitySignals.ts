import type { DailyAggregate, ScoredZone, ProximitySignal } from './vdfTypes.js';
import { mean } from './vdfMath.js';

/**
 * Evaluate proximity signals for breakout prediction.
 * Only fires when at least one zone has score >= 0.50.
 * Returns 7 signals → composite score + level (none/elevated/high/imminent).
 */
export function evaluateProximitySignals(
  allDaily: DailyAggregate[],
  zones: ScoredZone[],
): { compositeScore: number; level: string; signals: ProximitySignal[] } {
  const noResult = { compositeScore: 0, level: 'none', signals: [] as ProximitySignal[] };

  if (!zones || zones.length === 0) return noResult;
  const bestZone = zones.reduce((best: ScoredZone, z: ScoredZone) => (z.score > best.score ? z : best), zones[0]);
  if (bestZone.score < 0.5) return noResult;

  const signals: ProximitySignal[] = [];
  const n = allDaily.length;
  if (n < 15) return noResult;

  const lookback = Math.min(25, n);
  const recent = allDaily.slice(n - lookback);
  const avgDelta = mean(allDaily.map((d) => Math.abs(d.delta)));

  // Signal 1: Seller Exhaustion (3+ red, intensifying) — +15 pts
  {
    let maxStreakLen = 0;
    let intensifying = false;
    let streakLen = 0;
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].delta < 0) {
        streakLen++;
        if (streakLen >= 3) {
          if (streakLen > maxStreakLen) maxStreakLen = streakLen;
          const streakStart = i - streakLen + 1;
          if (Math.abs(recent[i].delta) > Math.abs(recent[streakStart].delta)) intensifying = true;
        }
      } else {
        streakLen = 0;
      }
    }
    if (maxStreakLen >= 3) {
      signals.push({
        type: 'seller_exhaustion',
        points: 15,
        detail: `${maxStreakLen}-day red streak${intensifying ? ' (intensifying)' : ' (fading)'}`,
      });
    }
  }

  // Signal 2: Delta Anomaly (>4x rolling avg, POSITIVE only) — +25 pts
  {
    for (let i = Math.max(0, recent.length - 15); i < recent.length; i++) {
      const d = recent[i];
      if (d.delta <= 0) continue;
      const globalIdx = n - lookback + i;
      const startIdx = Math.max(0, globalIdx - 20);
      const rollingAvg = mean(allDaily.slice(startIdx, globalIdx).map((x) => Math.abs(x.delta)));
      if (rollingAvg > 0 && d.delta > 4 * rollingAvg) {
        signals.push({
          type: 'delta_anomaly',
          points: 25,
          detail: `${d.date}: ${(d.delta / rollingAvg).toFixed(1)}x avg (+${(d.delta / 1000).toFixed(0)}K)`,
        });
        break;
      }
    }
  }

  // Signal 3: Green Delta Streak (4+ consecutive positive) — +20 pts
  {
    let maxGreenStreak = 0;
    let greenStreak = 0;
    for (const d of recent) {
      if (d.delta > 0) {
        greenStreak++;
        if (greenStreak > maxGreenStreak) maxGreenStreak = greenStreak;
      } else {
        greenStreak = 0;
      }
    }
    if (maxGreenStreak >= 4) {
      signals.push({ type: 'green_streak', points: 20, detail: `${maxGreenStreak} consecutive green delta days` });
    }
  }

  // Signal 4: Absorption Cluster (3/5 days absorption) — +15 pts
  {
    let found = false;
    for (let i = 4; i < recent.length && !found; i++) {
      let absorb = 0;
      for (let j = i - 4; j <= i; j++) {
        if (j > 0 && recent[j].close < recent[j - 1].close && recent[j].delta > 0) absorb++;
      }
      if (absorb >= 3) {
        signals.push({ type: 'absorption_cluster', points: 15, detail: `${absorb}/5 absorption days in window` });
        found = true;
      }
    }
  }

  // Signal 5: Final Capitulation Dump — +10 pts
  {
    const last5 = recent.slice(-5);
    for (const d of last5) {
      if (d.delta < 0 && Math.abs(d.delta) > 2 * avgDelta) {
        const idx = allDaily.findIndex((x) => x.date === d.date);
        if (idx > 0) {
          const priceChg = ((d.close - allDaily[idx - 1].close) / allDaily[idx - 1].close) * 100;
          if (priceChg < -2) {
            signals.push({
              type: 'final_capitulation',
              points: 10,
              detail: `${d.date}: ${(d.delta / 1000).toFixed(0)}K (${priceChg.toFixed(1)}%)`,
            });
            break;
          }
        }
      }
    }
  }

  // Signal 6: Multi-Zone Sequence — +20 pts
  {
    if (zones.length >= 2) {
      const sortedByDate = [...zones].sort((a: ScoredZone, b: ScoredZone) => a.startDate.localeCompare(b.startDate));
      for (let i = 1; i < sortedByDate.length; i++) {
        const gap = sortedByDate[i].start - sortedByDate[i - 1].end;
        if (gap > 0 && gap < 30) {
          signals.push({
            type: 'multi_zone_sequence',
            points: 20,
            detail: `${sortedByDate.length} zones with ${gap}-day gap`,
          });
          break;
        }
      }
    }
  }

  // Signal 7: Extreme Absorption Rate (>40%, recency-gated to last 90 days) — +15 pts
  {
    const recentCutoffIdx = Math.max(0, n - 90);
    for (const z of zones) {
      if (z.absorptionPct > 40 && z.end >= recentCutoffIdx) {
        signals.push({
          type: 'extreme_absorption',
          points: 15,
          detail: `Zone ${z.rank}: ${z.absorptionPct.toFixed(1)}% absorption`,
        });
        break;
      }
    }
  }

  let compositeScore = signals.reduce((s, sig) => s + sig.points, 0);

  // Rally context suppression: cap at 40pts if stock already rallied 20%+ recently
  {
    const last20 = allDaily.slice(Math.max(0, n - 20));
    if (last20.length >= 10) {
      const recentPriceChg = ((last20[last20.length - 1].close - last20[0].close) / last20[0].close) * 100;
      if (recentPriceChg > 20) compositeScore = Math.min(compositeScore, 40);
    }
  }

  let level = 'none';
  if (compositeScore >= 70) level = 'imminent';
  else if (compositeScore >= 50) level = 'high';
  else if (compositeScore >= 30) level = 'elevated';

  return { compositeScore, level, signals };
}

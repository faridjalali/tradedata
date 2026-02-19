import type { DailyAggregate, ScoredZone, DistributionCluster } from './vdfTypes.js';
import { scoreSubwindow } from './vdfScoring.js';

/**
 * Scan all possible subwindows and cluster into non-overlapping accumulation zones.
 */
export function findAccumulationZones(allDaily: DailyAggregate[], preDaily: DailyAggregate[], maxZones = 3): ScoredZone[] {
  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  const detected: ScoredZone[] = [];

  for (const winSize of windowSizes) {
    if (allDaily.length < winSize) continue;
    for (let start = 0; start <= allDaily.length - winSize; start++) {
      const slice = allDaily.slice(start, start + winSize);
      const result = scoreSubwindow(slice, preDaily);
      if (result && result.detected) {
        detected.push({
          start,
          end: start + winSize - 1,
          winSize,
          startDate: slice[0].date,
          endDate: slice[slice.length - 1].date,
          ...result,
        } as ScoredZone);
      }
    }
  }

  // Greedy clustering: highest score first, reject overlap >30% or gap <10 days
  detected.sort((a, b) => b.score - a.score);
  const zones: ScoredZone[] = [];
  for (const w of detected) {
    let overlaps = false;
    for (const z of zones) {
      const overlapStart = Math.max(w.start, z.start);
      const overlapEnd = Math.min(w.end, z.end);
      const overlapDays = Math.max(0, overlapEnd - overlapStart + 1);
      const thisSize = w.end - w.start + 1;
      const gap = w.start > z.end ? w.start - z.end : z.start > w.end ? z.start - w.end : 0;
      if (overlapDays / thisSize > 0.3 || gap < 10) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps && zones.length < maxZones) {
      zones.push({ ...w, rank: zones.length + 1 });
    }
  }

  return zones;
}

/**
 * Find distribution clusters: 10-day rolling windows where price rises
 * but cumulative delta is negative (institutions selling into rally).
 */
export function findDistributionClusters(allDaily: DailyAggregate[]): { distClusters: DistributionCluster[] } {
  const distWindows: Array<{ start: number; end: number; startDate: string; endDate: string; priceChange: number; netDeltaPct: number; netDelta: number }> = [];
  for (let i = 10; i <= allDaily.length; i++) {
    const window = allDaily.slice(i - 10, i);
    const priceChange = ((window[9].close - window[0].close) / window[0].close) * 100;
    const totalVol = window.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = window.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    if (priceChange > 3 && netDeltaPct < -3) {
      distWindows.push({ start: i - 10, end: i - 1, startDate: window[0].date, endDate: window[9].date, priceChange, netDeltaPct, netDelta });
    }
  }

  const distClusters: DistributionCluster[] = [];
  for (const w of distWindows) {
    let merged = false;
    for (const c of distClusters) {
      if (w.start <= c.end + 5) {
        c.end = Math.max(c.end, w.end);
        c.endDate = allDaily[Math.min(c.end, allDaily.length - 1)].date;
        c.count++;
        c.maxPriceChg = Math.max(c.maxPriceChg, w.priceChange);
        c.minDeltaPct = Math.min(c.minDeltaPct, w.netDeltaPct);
        merged = true;
        break;
      }
    }
    if (!merged) {
      distClusters.push({ start: w.start, end: w.end, startDate: w.startDate, endDate: w.endDate, count: 1, maxPriceChg: w.priceChange, minDeltaPct: w.netDeltaPct });
    }
  }

  for (const c of distClusters) {
    const chunk = allDaily.slice(c.start, Math.min(c.end + 1, allDaily.length));
    if (chunk.length > 0) {
      c.spanDays = c.end - c.start + 1;
      c.priceChangePct = ((chunk[chunk.length - 1].close - chunk[0].close) / chunk[0].close) * 100;
      c.netDelta = chunk.reduce((s, d) => s + d.delta, 0);
      const fullVol = chunk.reduce((s, d) => s + d.totalVol, 0);
      c.netDeltaPct = fullVol > 0 ? (c.netDelta / fullVol) * 100 : 0;
    }
  }

  return { distClusters };
}

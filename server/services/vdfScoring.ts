import type { DailyAggregate } from './vdfTypes.js';
import { mean, std, linReg } from './vdfMath.js';
import { buildWeeks } from './vdfAggregation.js';

/**
 * Score a single subwindow of daily data for accumulation divergence.
 * 8-component scoring with divergence enforcement + 3σ outlier capping.
 */
export function scoreSubwindow(dailySlice: DailyAggregate[], preDaily: DailyAggregate[]) {
  const weeks = buildWeeks(dailySlice);
  if (weeks.length < 2) return null;

  const n = dailySlice.length;
  const totalVol = dailySlice.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / n;
  const closes = dailySlice.map((d) => d.close);
  const overallPriceChange = ((closes[n - 1] - closes[0]) / closes[0]) * 100;

  // === HARD GATES ===
  if (overallPriceChange > 3 || overallPriceChange < -45) return null;

  // Pre-context baseline
  const preAvgDelta = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.delta, 0) / preDaily.length : 0;
  const preAvgVol = preDaily.length > 0 ? preDaily.reduce((s, d) => s + d.totalVol, 0) / preDaily.length : avgDailyVol;

  // 3σ outlier capping
  let effectiveDeltas = dailySlice.map((d) => d.delta);
  const dm = mean(effectiveDeltas);
  const ds = std(effectiveDeltas);
  const capHigh = dm + 3 * ds;
  const capLow = dm - 3 * ds;
  const cappedDays: Array<{ date: string; original: number; capped: number }> = [];
  effectiveDeltas = effectiveDeltas.map((d, i) => {
    if (d > capHigh || d < capLow) {
      const capped = Math.max(capLow, Math.min(capHigh, d));
      cappedDays.push({ date: dailySlice[i].date, original: d, capped });
      return capped;
    }
    return d;
  });

  // Net delta
  const netDelta = effectiveDeltas.reduce((s, v) => s + v, 0);
  const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;

  if (netDeltaPct <= 0) {
    return { score: 0, detected: false, reason: 'no_net_buying', netDeltaPct, overallPriceChange };
  }

  // === CONCORDANT RALLY ANALYSIS ===
  const maxClose = Math.max(...closes);
  const intraRally = ((maxClose - closes[0]) / closes[0]) * 100;
  let concordantFrac = 0;
  let concordantUpDelta = 0;
  let absorptionDelta = 0;

  if (netDeltaPct > 0) {
    for (let i = 1; i < n; i++) {
      const dayPriceChg = dailySlice[i].close - dailySlice[i - 1].close;
      const dayDelta = effectiveDeltas[i];
      if (dayPriceChg > 0 && dayDelta > 0) concordantUpDelta += dayDelta;
      else if (dayPriceChg < 0 && dayDelta > 0) absorptionDelta += dayDelta;
    }
    const totalPosDelta = concordantUpDelta + absorptionDelta;
    concordantFrac = totalPosDelta > 0 ? concordantUpDelta / totalPosDelta : 0;

    if (concordantFrac > 0.65) {
      return { score: 0, detected: false, reason: 'concordant_dominated', netDeltaPct, overallPriceChange, intraRally, concordantFrac };
    }

    if (overallPriceChange > 0 && concordantFrac > 0.6) {
      return { score: 0, detected: false, reason: 'concordant_flat_market', netDeltaPct, overallPriceChange, intraRally, concordantFrac };
    }
  }

  // Cumulative weekly delta slope (using capped deltas)
  const weeklyDeltas: number[] = [];
  let dayIdx = 0;
  for (const w of weeks) {
    let wd = 0;
    for (let j = 0; j < w.nDays && dayIdx < effectiveDeltas.length; j++, dayIdx++) {
      wd += effectiveDeltas[dayIdx];
    }
    weeklyDeltas.push(wd);
  }
  const cumWeeklyDelta: number[] = [];
  let cwd = 0;
  for (const wd of weeklyDeltas) {
    cwd += wd;
    cumWeeklyDelta.push(cwd);
  }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (linReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  if (deltaSlopeNorm < -0.5) {
    return { score: 0, detected: false, reason: 'slope_gate', netDeltaPct, overallPriceChange, deltaSlopeNorm };
  }

  // Delta shift vs pre-context
  const consolAvgDailyDelta = netDelta / n;
  const deltaShift = preAvgVol > 0 ? ((consolAvgDailyDelta - preAvgDelta) / preAvgVol) * 100 : 0;

  // Absorption: days where price down but delta positive
  let absorptionDays = 0;
  for (let i = 1; i < n; i++) {
    if (dailySlice[i].close < dailySlice[i - 1].close && dailySlice[i].delta > 0) absorptionDays++;
  }
  const absorptionPct = n > 1 ? (absorptionDays / (n - 1)) * 100 : 0;

  // Large buy vs sell days
  const largeBuyDays = dailySlice.filter((d) => d.delta > avgDailyVol * 0.1).length;
  const largeSellDays = dailySlice.filter((d) => d.delta < -avgDailyVol * 0.1).length;
  const largeBuyVsSell = ((largeBuyDays - largeSellDays) / n) * 100;

  // Accumulation week ratio (using capped weekly deltas)
  const accumWeeks = weeklyDeltas.filter((wd) => wd > 0).length;
  const accumWeekRatio = accumWeeks / weeks.length;

  // Volume decline: first-third vs last-third
  const third = Math.floor(n / 3);
  let volDeclineScore = 0;
  if (third >= 3) {
    const t1Vols = dailySlice.slice(0, third).map((d) => d.totalVol);
    const t3Vols = dailySlice.slice(2 * third).map((d) => d.totalVol);
    const avgT1 = mean(t1Vols);
    const avgT3 = mean(t3Vols);
    if (avgT1 > 0 && avgT3 < avgT1) {
      volDeclineScore = Math.min(1, (avgT1 - avgT3) / avgT1 / 0.3);
    }
  }

  // === 8 SCORING COMPONENTS ===
  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5));
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4));
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8));
  const s4 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6));
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12));
  const s6 = Math.max(0, Math.min(1, absorptionPct / 15));
  const s7 = volDeclineScore;

  let s8 = 0;
  if (netDeltaPct > 0) {
    const priceFactor = Math.max(0, Math.min(1, (3 - overallPriceChange) / 8));
    const deltaFactor = Math.max(0, Math.min(1, netDeltaPct / 3));
    s8 = priceFactor * deltaFactor;
  }

  const rawScore = s1 * 0.15 + s2 * 0.1 + s3 * 0.05 + s4 * 0.05 + s5 * 0.03 + s6 * 0.25 + s7 * 0.02 + s8 * 0.35;

  if (s8 < 0.05 && concordantFrac > 0.55) {
    return { score: 0, detected: false, reason: 'no_divergence', netDeltaPct, overallPriceChange, concordantFrac, s8, components: { s1, s2, s3, s4, s5, s6, s7, s8 } };
  }

  let concordancePenalty = 1.0;
  if (concordantFrac > 0.55) {
    concordancePenalty = Math.max(0.4, 1.0 - (concordantFrac - 0.55) * 1.5);
  }

  const durationMultiplier = Math.min(1.15, 0.7 + (weeks.length - 2) * 0.075);
  const score = rawScore * concordancePenalty * durationMultiplier;
  const detected = score >= 0.3;

  return {
    score,
    detected,
    reason: detected ? 'accumulation_divergence' : 'below_threshold',
    netDeltaPct,
    overallPriceChange,
    deltaSlopeNorm,
    accumWeekRatio,
    deltaShift,
    weeks: weeks.length,
    accumWeeks,
    absorptionPct,
    largeBuyVsSell,
    volDeclineScore,
    components: { s1, s2, s3, s4, s5, s6, s7, s8 },
    durationMultiplier,
    concordancePenalty,
    intraRally,
    concordantFrac,
    cappedDays,
  };
}

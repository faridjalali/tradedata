/**
 * Volume Divergence Flag (VDF) Detector — Full Algorithm
 * ======================================================
 * Detects hidden institutional accumulation during multi-week price declines
 * using 1-minute volume delta to reveal net buying that diverges from price.
 *
 * Features:
 *   - 8-component scoring with divergence enforcement + 3σ outlier capping
 *   - Subwindow scanner (10–35 day sliding windows)
 *   - Multi-zone greedy clustering (up to 3 zones)
 *   - Distribution cluster detection (inverse: price up, delta negative)
 *   - Proximity signal evaluation (7 signals → composite score)
 *
 * See ALGORITHM-VD-ACCUMULATION.md for full documentation.
 */

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/** @param {number[]} arr */
function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** @param {number[]} arr */
function std(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/**
 * @param {number[]} xs
 * @param {number[]} ys
 */
function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] ** 2;
    sxy += xs[i] * ys[i];
  }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const yMean = sy / n;
  const intercept = (sy - slope * sx) / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - intercept - slope * xs[i]) ** 2;
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

// =============================================================================
// DAILY AGGREGATION — 1-minute bars → daily buckets
// =============================================================================

/** @param {any[]} bars1m */
function vdAggregateDaily(bars1m) {
  const dailyMap = new Map();
  for (const b of bars1m) {
    const d = new Date(b.time * 1000).toISOString().split('T')[0];
    if (!dailyMap.has(d))
      dailyMap.set(d, {
        buyVol: 0,
        sellVol: 0,
        totalVol: 0,
        close: 0,
        open: 0,
        high: -Infinity,
        low: Infinity,
        first: true,
      });
    const day = dailyMap.get(d);
    const delta = b.close > b.open ? b.volume : b.close < b.open ? -b.volume : 0;
    if (delta > 0) day.buyVol += b.volume;
    else if (delta < 0) day.sellVol += b.volume;
    day.totalVol += b.volume;
    day.close = b.close;
    if (b.high > day.high) day.high = b.high;
    if (b.low < day.low) day.low = b.low;
    if (day.first) {
      day.open = b.open;
      day.first = false;
    }
  }

  const dates = [...dailyMap.keys()].sort();
  return dates.map((d) => {
    const day = dailyMap.get(d);
    return {
      date: d,
      delta: day.buyVol - day.sellVol,
      totalVol: day.totalVol,
      buyVol: day.buyVol,
      sellVol: day.sellVol,
      close: day.close,
      open: day.open,
      high: day.high === -Infinity ? day.close : day.high,
      low: day.low === Infinity ? day.close : day.low,
    };
  });
}

// =============================================================================
// WEEKLY GROUPING — daily buckets → ISO weeks
// =============================================================================

/** @param {any[]} daily */
function buildWeeks(daily) {
  const weekMap = new Map();
  for (const d of daily) {
    const dt = new Date(d.date + 'T12:00:00Z');
    const dow = dt.getUTCDay();
    const monday = new Date(dt);
    monday.setUTCDate(monday.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    const wk = monday.toISOString().split('T')[0];
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk).push(d);
  }
  return [...weekMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, days]) => {
      const buyVol = days.reduce((/** @type {number} */ s, /** @type {any} */ d) => s + d.buyVol, 0);
      const sellVol = days.reduce((/** @type {number} */ s, /** @type {any} */ d) => s + d.sellVol, 0);
      const totalVol = days.reduce((/** @type {number} */ s, /** @type {any} */ d) => s + d.totalVol, 0);
      return {
        weekStart,
        delta: buyVol - sellVol,
        totalVol,
        deltaPct: totalVol > 0 ? ((buyVol - sellVol) / totalVol) * 100 : 0,
        nDays: days.length,
      };
    });
}

// =============================================================================
// SINGLE SUBWINDOW SCORING — 7-component system with 3σ capping
// =============================================================================

/**
 * Score a single subwindow of daily data for accumulation divergence.
 *
 * @param {any[]} dailySlice — daily aggregates for the candidate window
 * @param {any[]} preDaily — daily aggregates for 30-day pre-context window
 * @returns {any} — scoring result or null if gated out
 */
function scoreSubwindow(dailySlice, preDaily) {
  const weeks = buildWeeks(dailySlice);
  if (weeks.length < 2) return null;

  const n = dailySlice.length;
  const totalVol = dailySlice.reduce((s, d) => s + d.totalVol, 0);
  const avgDailyVol = totalVol / n;
  const closes = dailySlice.map((d) => d.close);
  const overallPriceChange = ((closes[n - 1] - closes[0]) / closes[0]) * 100;

  // === HARD GATES ===
  // Tightened: true accumulation happens during declines or flat periods, not rallies.
  // Allow up to +3% for choppy/flat periods; reject clear rallies.
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
  /** @type {any[]} */
  const cappedDays = [];
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

  // Gate: net delta must be positive — accumulation requires net buying
  // Previously allowed down to -1.5%, but negative net delta means no hidden buying.
  // META 1/9→2/11 was a false positive at -0.1%: zero buying signal, yet secondary
  // metrics (absorption, accum ratio) carried the score to 0.33.
  if (netDeltaPct <= 0) {
    return { score: 0, detected: false, reason: 'no_net_buying', netDeltaPct, overallPriceChange };
  }

  // === CONCORDANT RALLY ANALYSIS ===
  // Detect windows spanning a rally-then-crash where positive net delta is actually
  // CONCORDANT (from the rally) not DIVERGENT (from hidden accumulation during decline).
  //
  // The problem: a window starting during a rally and ending after a crash will show
  // negative overall price + positive delta = apparent "divergence." But the delta
  // positivity came from the rally days (concordant: price up + delta positive),
  // not from absorption days (divergent: price down + delta positive).
  //
  // Fix: classify each day's delta and check what fraction of positive delta comes
  // from concordant-up days vs absorption days.
  const maxClose = Math.max(...closes);
  const intraRally = ((maxClose - closes[0]) / closes[0]) * 100;
  let concordantFrac = 0;
  let concordantUpDelta = 0;
  let absorptionDelta = 0;

  if (netDeltaPct > 0) {
    // Classify each day: concordant-up (price↑ + delta↑) vs absorption (price↓ + delta↑)
    for (let i = 1; i < n; i++) {
      const dayPriceChg = dailySlice[i].close - dailySlice[i - 1].close;
      const dayDelta = effectiveDeltas[i];
      if (dayPriceChg > 0 && dayDelta > 0) concordantUpDelta += dayDelta;
      else if (dayPriceChg < 0 && dayDelta > 0) absorptionDelta += dayDelta;
    }
    const totalPosDelta = concordantUpDelta + absorptionDelta;
    concordantFrac = totalPosDelta > 0 ? concordantUpDelta / totalPosDelta : 0;

    // HARD GATE 1: Concordant-dominated zone (standalone)
    // If >65% of positive delta comes from concordant-up days (price↑ + delta↑),
    // this is NOT accumulation — it's normal buying during a rally.
    // Lowered from 70% to 65% based on LLM cross-ticker analysis: zones at 0.65-0.69
    // concordantFrac (CRDO Z3=0.691, INSM Z5=0.680, EOSE Z1=0.682, WULF Z3=0.694)
    // had near-zero divergence scores and were flagged as false positives by expert review.
    if (concordantFrac > 0.65) {
      return {
        score: 0,
        detected: false,
        reason: 'concordant_dominated',
        netDeltaPct,
        overallPriceChange,
        intraRally,
        concordantFrac,
      };
    }

    // HARD GATE 2: Combined price + concordance gate
    // If price is flat/rising (>0%) AND concordantFrac > 0.60, reject.
    // True accumulation during price declines can tolerate moderate concordance from
    // bounce days. But when price is flat/rising AND most buying is concordant,
    // there is no divergence — just normal market behavior.
    // Catches: BE Z4 (+0.87%, 0.663), INSM Z5 (+2.87%, 0.68 — already caught by gate 1)
    if (overallPriceChange > 0 && concordantFrac > 0.6) {
      return {
        score: 0,
        detected: false,
        reason: 'concordant_flat_market',
        netDeltaPct,
        overallPriceChange,
        intraRally,
        concordantFrac,
      };
    }
  }

  // Cumulative weekly delta slope (using capped deltas)
  const weeklyDeltas = [];
  let dayIdx = 0;
  for (const w of weeks) {
    let wd = 0;
    for (let j = 0; j < w.nDays && dayIdx < effectiveDeltas.length; j++, dayIdx++) {
      wd += effectiveDeltas[dayIdx];
    }
    weeklyDeltas.push(wd);
  }
  const cumWeeklyDelta = [];
  let cwd = 0;
  for (const wd of weeklyDeltas) {
    cwd += wd;
    cumWeeklyDelta.push(cwd);
  }
  const weeklyXs = weeks.map((_, i) => i);
  const avgWeeklyVol = weeks.reduce((s, w) => s + w.totalVol, 0) / weeks.length;
  const deltaSlopeNorm = avgWeeklyVol > 0 ? (linReg(weeklyXs, cumWeeklyDelta).slope / avgWeeklyVol) * 100 : 0;

  // Gate: delta slope must not be falling steeply
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

  // === 8 SCORING COMPONENTS (divergence-dominant weighting) ===
  //
  // The core thesis: true accumulation shows DIVERGENCE — price declining while
  // delta (from 1-min data) is positive. This is the PRIMARY signal. Supporting
  // metrics (net buying, slope, persistence) are secondary confirmation.
  //
  // Weights sum to 1.00 — divergence signals (s6+s8) = 60%:
  //   s8  Divergence      35%  — overall price-down + delta-up divergence (PRIMARY)
  //   s6  Absorption      25%  — day-by-day price↓ + delta↑ (PRIMARY confirmation)
  //   s1  Net Delta       15%  — is there net buying? (supporting)
  //   s2  Delta Slope     10%  — is cumulative buying building? (supporting)
  //   s3  Delta Shift      5%  — did buying shift vs pre-context? (minor)
  //   s4  Accum Ratio      5%  — what % of weeks had positive delta? (minor)
  //   s5  Buy vs Sell      3%  — ratio of large buy vs sell days (minor)
  //   s7  Vol Decline       2%  — volume declining (minor)

  const s1 = Math.max(0, Math.min(1, (netDeltaPct + 1.5) / 5)); // Net Delta
  const s2 = Math.max(0, Math.min(1, (deltaSlopeNorm + 0.5) / 4)); // Delta Slope
  const s3 = Math.max(0, Math.min(1, (deltaShift + 1) / 8)); // Delta Shift
  const s4 = Math.max(0, Math.min(1, (accumWeekRatio - 0.2) / 0.6)); // Accum Week Ratio
  const s5 = Math.max(0, Math.min(1, (largeBuyVsSell + 3) / 12)); // Large Buy vs Sell
  const s6 = Math.max(0, Math.min(1, absorptionPct / 15)); // Absorption (scaled tighter: 15% = max)
  const s7 = volDeclineScore; // Vol Decline

  // s8: Divergence component — the heart of the algorithm
  // Rewards zones where price declines while net delta is positive.
  // Score = 1.0 when price <= -5% and netDelta >= +3% (ideal divergence)
  // Score = 0.0 when price >= +3% or netDelta <= 0%
  // Penalizes concordant movement (price and delta both positive)
  let s8 = 0;
  if (netDeltaPct > 0) {
    // Price component: -5% or worse → 1.0, 0% → 0.5, +3% → 0.0
    const priceFactor = Math.max(0, Math.min(1, (3 - overallPriceChange) / 8));
    // Delta component: +3% → 1.0, 0% → 0.0
    const deltaFactor = Math.max(0, Math.min(1, netDeltaPct / 3));
    s8 = priceFactor * deltaFactor;
  }

  const rawScore = s1 * 0.15 + s2 * 0.1 + s3 * 0.05 + s4 * 0.05 + s5 * 0.03 + s6 * 0.25 + s7 * 0.02 + s8 * 0.35;

  // Divergence floor gate: if divergence component is near-zero AND concordance is
  // elevated, reject. This catches zones where non-divergence metrics (s1, s4, s6)
  // carry the score above 0.30 despite zero actual price-delta divergence.
  // Cross-ticker analysis found 8 false positives with this pattern: all had s8 < 0.05
  // and concordantFrac > 0.55, meaning the "accumulation" signal had zero divergence
  // and was just normal buying. True accumulation zones have s8 >> 0.10.
  if (s8 < 0.05 && concordantFrac > 0.55) {
    return {
      score: 0,
      detected: false,
      reason: 'no_divergence',
      netDeltaPct,
      overallPriceChange,
      concordantFrac,
      s8,
      components: { s1, s2, s3, s4, s5, s6, s7, s8 },
    };
  }

  // Concordance penalty (soft) — standalone quality gate
  // When >55% of positive delta comes from concordant-up days, the "accumulation" signal
  // is diluted by normal rally behavior. Scale score down proportionally.
  // Formula: linear ramp from 1.0 at 55% to 0.40 at 95%, floored at 0.40.
  //   penalty = 1.0 - (concordantFrac - 0.55) * 1.5
  // Examples: 55% → 1.0 (no penalty), 60% → 0.925, 65% → 0.85, 70% → hard gate fires
  let concordancePenalty = 1.0;
  if (concordantFrac > 0.55) {
    concordancePenalty = Math.max(0.4, 1.0 - (concordantFrac - 0.55) * 1.5);
  }

  // Duration scaling
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

// =============================================================================
// SUBWINDOW SCANNER + MULTI-ZONE CLUSTERING
// =============================================================================

/**
 * Scan all possible subwindows and cluster into non-overlapping zones.
 *
 * @param {any[]} allDaily — daily aggregates for the full scan period
 * @param {any[]} preDaily — daily aggregates for 30-day pre-context
 * @param {number} maxZones — max zones to return (default 3)
 * @returns {any[]} — sorted zones, highest score first
 */
function findAccumulationZones(allDaily, preDaily, maxZones = 3) {
  const windowSizes = [10, 14, 17, 20, 24, 28, 35];
  const detected = [];

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
        });
      }
    }
  }

  // Greedy clustering: highest score first, reject overlap >30% or gap <10 days
  detected.sort((a, b) => b.score - a.score);
  const zones = [];
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

// =============================================================================
// DISTRIBUTION CLUSTER DETECTION
// =============================================================================

/**
 * Find distribution clusters: 10-day rolling windows where price rises
 * but cumulative delta is negative (institutions selling into rally).
 *
 * @param {any[]} allDaily — daily aggregates
 * @returns {{ distClusters: any[] }}
 */
function findDistributionClusters(allDaily) {
  // 10-day rolling: price >+3% but delta <-3% → distribution
  const distWindows = [];
  for (let i = 10; i <= allDaily.length; i++) {
    const window = allDaily.slice(i - 10, i);
    const priceChange = ((window[9].close - window[0].close) / window[0].close) * 100;
    const totalVol = window.reduce((s, d) => s + d.totalVol, 0);
    const netDelta = window.reduce((s, d) => s + d.delta, 0);
    const netDeltaPct = totalVol > 0 ? (netDelta / totalVol) * 100 : 0;
    if (priceChange > 3 && netDeltaPct < -3) {
      distWindows.push({
        start: i - 10,
        end: i - 1,
        startDate: window[0].date,
        endDate: window[9].date,
        priceChange,
        netDeltaPct,
        netDelta,
      });
    }
  }

  // Cluster overlapping distribution windows (within 5 days)
  /** @type {any[]} */
  const distClusters = [];
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
      distClusters.push({
        start: w.start,
        end: w.end,
        startDate: w.startDate,
        endDate: w.endDate,
        count: 1,
        maxPriceChg: w.priceChange,
        minDeltaPct: w.netDeltaPct,
      });
    }
  }

  // Enrich distribution clusters with full-period stats
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

// =============================================================================
// PROXIMITY SIGNAL EVALUATION
// =============================================================================

/**
 * Evaluate proximity signals for breakout prediction.
 * Only fires when at least one zone has score >= 0.50.
 *
 * @param {any[]} allDaily — daily aggregates (full scan period)
 * @param {any[]} zones — detected accumulation zones
 * @returns {{ compositeScore: number, level: string, signals: any[] }}
 */
function evaluateProximitySignals(allDaily, zones) {
  const noResult = { compositeScore: 0, level: 'none', signals: [] };

  if (!zones || zones.length === 0) return noResult;
  const bestZone = zones.reduce((best, z) => (z.score > best.score ? z : best), zones[0]);
  if (bestZone.score < 0.5) return noResult;

  const signals = [];
  const n = allDaily.length;
  if (n < 15) return noResult;

  // Use last 25 days for proximity evaluation
  const lookback = Math.min(25, n);
  const recent = allDaily.slice(n - lookback);
  const avgDelta = mean(allDaily.map((d) => Math.abs(d.delta)));

  // --- Signal 1: Seller Exhaustion (3+ red, intensifying) — +15 pts ---
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
          if (Math.abs(recent[i].delta) > Math.abs(recent[streakStart].delta)) {
            intensifying = true;
          }
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

  // --- Signal 2: Delta Anomaly (>4x rolling avg, POSITIVE only) — +25 pts ---
  // Only count POSITIVE delta anomalies (buy anomalies / absorption anomalies).
  // Sell anomalies (large negative delta) are BEARISH signals that should NOT
  // contribute to breakout proximity. CRDO's 6.8x sell anomaly on Feb 4 was
  // incorrectly adding 25pts toward "imminent breakout" before this fix.
  {
    for (let i = Math.max(0, recent.length - 15); i < recent.length; i++) {
      const d = recent[i];
      if (d.delta <= 0) continue; // Skip sell anomalies — they are bearish
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

  // --- Signal 3: Green Delta Streak (4+ consecutive positive) — +20 pts ---
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
      signals.push({
        type: 'green_streak',
        points: 20,
        detail: `${maxGreenStreak} consecutive green delta days`,
      });
    }
  }

  // --- Signal 4: Absorption Cluster (3/5 days absorption) — +15 pts ---
  {
    let found = false;
    for (let i = 4; i < recent.length && !found; i++) {
      let absorb = 0;
      for (let j = i - 4; j <= i; j++) {
        if (j > 0 && recent[j].close < recent[j - 1].close && recent[j].delta > 0) absorb++;
      }
      if (absorb >= 3) {
        signals.push({
          type: 'absorption_cluster',
          points: 15,
          detail: `${absorb}/5 absorption days in window`,
        });
        found = true;
      }
    }
  }

  // --- Signal 5: Final Capitulation Dump — +10 pts ---
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

  // --- Signal 6: Multi-Zone Sequence — +20 pts ---
  {
    if (zones.length >= 2) {
      const sortedByDate = [...zones].sort((a, b) => a.startDate.localeCompare(b.startDate));
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

  // --- Signal 7: Extreme Absorption Rate (>40%) — +15 pts ---
  // Only count zones from the last 90 trading days (recency gate).
  // CRDO's Z1 from April 2025 (10 months ago) was incorrectly contributing 15pts
  // to Feb 2026 proximity. Historical absorption doesn't predict current breakout.
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

  // Compute composite score
  let compositeScore = signals.reduce((s, sig) => s + sig.points, 0);

  // Rally context suppression: if the stock has already rallied significantly
  // in the recent period, suppress proximity scoring. A stock that has already
  // broken out and rallied 20%+ is NOT approaching a breakout — it IS the breakout.
  // MOD at 80pts "imminent" while already up 73% in a month was actively misleading.
  // STX at 50pts "high" while at +310% YTD was similarly overstated.
  {
    const last20 = allDaily.slice(Math.max(0, n - 20));
    if (last20.length >= 10) {
      const recentPriceChg = ((last20[last20.length - 1].close - last20[0].close) / last20[0].close) * 100;
      if (recentPriceChg > 20) {
        // Already in an active rally — cap proximity at "elevated" (max 40pts)
        compositeScore = Math.min(compositeScore, 40);
      }
    }
  }

  let level = 'none';
  if (compositeScore >= 70) level = 'imminent';
  else if (compositeScore >= 50) level = 'high';
  else if (compositeScore >= 30) level = 'elevated';

  return { compositeScore, level, signals };
}

// =============================================================================
// MAIN DETECTOR — orchestrates all detection phases
// =============================================================================

/**
 * Run full VDF detection for a ticker.
 *
 * @param {string} ticker
 * @param {any} options
 * @returns {Promise<any>} — full detection result
 */
async function detectVDF(ticker, options) {
  const { dataApiFetcher, signal, mode = 'scan' } = options;
  // mode = 'chart': fetch 1yr, return allZones (for overlays) + recentZones (3mo for scoring)
  // mode = 'scan':  fetch ~4mo, analyze last 3mo only (lighter for bulk scans)
  const RECENT_DAYS = 90; // 90 calendar days ≈ 3 months for scoring

  const emptyResult = (/** @type {string} */ reason, /** @type {string} */ status) => ({
    detected: false,
    bestScore: 0,
    bestZoneWeeks: 0,
    reason,
    status,
    zones: [],
    allZones: [],
    distribution: [],
    proximity: { compositeScore: 0, level: 'none', signals: [] },
    metrics: {},
  });

  try {
    const fetchDays = mode === 'chart' ? 365 : 150; // chart: 1yr, scan: ~5mo (3mo scan + pre-context buffer)
    const bars1m = await dataApiFetcher(ticker, '1min', fetchDays, { signal });
    if (!bars1m || bars1m.length < 500) {
      return emptyResult('insufficient_1m_data', 'Insufficient 1m data');
    }

    const sorted = bars1m.sort((/** @type {any} */ a, /** @type {any} */ b) => a.time - b.time);
    const latestTime = sorted[sorted.length - 1].time;

    // For chart mode: scan full available data for overlays
    // For scan mode: scan last ~90 calendar days only
    const scanCutoff =
      mode === 'chart'
        ? sorted[0].time // use all available bars
        : latestTime - RECENT_DAYS * 86400;
    const preCutoff = (mode === 'chart' ? sorted[0].time : scanCutoff) - 30 * 86400;

    const scanBars = sorted.filter((/** @type {any} */ b) => b.time >= scanCutoff);
    const preBars = sorted.filter((/** @type {any} */ b) => b.time >= preCutoff && b.time < scanCutoff);

    if (scanBars.length < 200) {
      return emptyResult('insufficient_scan_data', 'Insufficient scan data');
    }

    // Build daily aggregates
    const allDaily = vdAggregateDaily(scanBars);
    const preDaily = vdAggregateDaily(preBars);

    if (allDaily.length < 10) {
      return emptyResult('insufficient_daily_data', 'Insufficient daily data');
    }

    // Phase 1: Find accumulation zones across full scan period
    const zones = findAccumulationZones(allDaily, preDaily, 5);

    // Phase 2: Find distribution clusters across full scan period
    const { distClusters } = findDistributionClusters(allDaily);

    // For chart mode: separate zones into allZones (overlays) and recentZones (scoring)
    // The recent cutoff is the last RECENT_DAYS calendar days
    const recentCutoffDate = new Date(latestTime * 1000);
    recentCutoffDate.setDate(recentCutoffDate.getDate() - RECENT_DAYS);
    const recentCutoffStr = recentCutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD

    // recentZones: zones whose endDate falls within the last 3 months
    const recentZones = zones.filter((z) => z.endDate >= recentCutoffStr);
    // For scoring, use recentZones only
    const scoringZones = recentZones;

    // Phase 3: Evaluate proximity signals (always based on recent data + recent zones)
    const proximity = evaluateProximitySignals(allDaily, scoringZones);

    // Determine best zone from scoring zones (recent 3 months)
    const bestZone =
      scoringZones.length > 0
        ? scoringZones.reduce((best, z) => (z.score > best.score ? z : best), scoringZones[0])
        : null;
    const bestScore = bestZone ? bestZone.score : 0;
    const bestZoneWeeks = bestZone ? bestZone.weeks : 0;
    const detected = scoringZones.length > 0;

    // Build status string
    let status;
    if (detected) {
      status = `VD Accumulation detected: ${scoringZones.length} zone${scoringZones.length > 1 ? 's' : ''}, best ${bestScore.toFixed(2)} (${bestZoneWeeks}wk)`;
      if (proximity.level !== 'none') {
        status += ` | Proximity: ${proximity.level} (${proximity.compositeScore}pts)`;
      }
      if (distClusters.length > 0) {
        status += ` | ${distClusters.length} distribution cluster${distClusters.length > 1 ? 's' : ''}`;
      }
    } else {
      status = 'No accumulation zones detected';
    }

    // Format zone helper
    const formatZone = (/** @type {any} */ z) => ({
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

    // Format zones: "zones" = recent (for scoring/panel), "allZones" = full period (for overlays)
    const formattedZones = scoringZones.map(formatZone);
    const formattedAllZones = zones.map(formatZone);

    // Format distribution clusters for output
    const formattedDist = distClusters.map((c) => ({
      startDate: c.startDate,
      endDate: c.endDate,
      spanDays: c.spanDays || c.end - c.start + 1,
      priceChangePct: c.priceChangePct || c.maxPriceChg,
      netDeltaPct: c.netDeltaPct || c.minDeltaPct,
    }));

    return {
      detected,
      bestScore,
      bestZoneWeeks,
      status,
      reason: detected ? 'accumulation_divergence' : 'below_threshold',
      zones: formattedZones,
      allZones: formattedAllZones,
      distribution: formattedDist,
      proximity,
      metrics: {
        totalDays: allDaily.length,
        scanStart: allDaily[0]?.date,
        scanEnd: allDaily[allDaily.length - 1]?.date,
        preDays: preDaily.length,
        recentCutoff: recentCutoffStr,
      },
    };
  } catch (/** @type {any} */ err) {
    if (err && (err.name === 'AbortError' || err.message === 'This operation was aborted')) throw err;
    return {
      detected: false,
      bestScore: 0,
      bestZoneWeeks: 0,
      reason: `error: ${err.message || err}`,
      status: `Error: ${err.message || err}`,
      zones: [],
      allZones: [],
      distribution: [],
      proximity: { compositeScore: 0, level: 'none', signals: [] },
      metrics: {},
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

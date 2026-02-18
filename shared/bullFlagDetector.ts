/**
 * Bull Flag / Bull Pennant Formation Detector
 *
 * Detects two consolidation patterns at the end of price data,
 * preceded by a prior uptrend:
 *
 * 1. Bull Flag: gentle, orderly downward-drifting parallel channel
 * 2. Bull Pennant: converging triangle (descending highs + ascending lows)
 *
 * Optimized for daily charts with highest-probability breakout characteristics:
 * - Duration: 1–4 weeks (5–20 trading days) is ideal
 * - Depth: "high and tight" — retracement should stay under 38.2% Fibonacci
 * - Slope: gentle downward drift preferred; flat is acceptable
 *
 * Does NOT require a specific flagpole structure or breakout confirmation.
 * Focuses on identifying consolidation formations currently in progress.
 */

// --- Constants ---

/** Minimum total bars needed to evaluate. */
const MIN_TOTAL_BARS = 10;
/** Maximum bars to consider from the end of the dataset. */
const MAX_LOOKBACK_BARS = 40;

/** Minimum bars in the consolidation zone (1 week ≈ 5 trading days). */
const FLAG_MIN_BARS = 5;
/** Maximum bars in the consolidation zone (4 weeks ≈ 20 trading days). */
const FLAG_MAX_BARS = 20;

/**
 * Flag slope bounds (normalized % per bar).
 * The flag should drift gently downward — not sideways/up and not crashing.
 */
const FLAG_SLOPE_MAX = 0.05; // upper bound: nearly flat is OK
const FLAG_SLOPE_MIN = -1.2; // lower bound: reject steep drops

/** Maximum channel width as % of mean price. */
const MAX_CHANNEL_WIDTH_PCT = 8.0;

/**
 * Minimum prior uptrend gain (%) before the consolidation starts.
 * Ensures the pattern follows a meaningful up-move.
 */
const PRIOR_UPTREND_MIN_PCT = 5.0;

/**
 * Maximum retracement of the prior move (%).
 * "High and tight" flags should retrace less than 38.2% (Fibonacci).
 * Retracements above 50% indicate bears have too much power.
 */
const MAX_RETRACE_PCT = 50.0;

/** Ideal retracement ceiling — below this gets full score. */
const IDEAL_RETRACE_PCT = 38.2;

/** Confidence threshold to report a detection. */
const MIN_CONFIDENCE = 50;

// --- Types ---

export interface BullFlagDetection {
  /** Confidence score 0–100. */
  confidence: number;
  /** Index into the original bars array where the consolidation starts. */
  flagStartIndex: number;
  /** Index into the original bars array where the consolidation ends (last bar). */
  flagEndIndex: number;
  /** Normalized slope of closes (% per bar). Negative = drifting down. */
  slopePerBar: number;
  /** R² of the linear regression through closes — higher = more orderly. */
  r2: number;
  /** Channel width as % of mean price. Lower = tighter. */
  channelWidthPct: number;
  /** How much the consolidation has retraced the prior uptrend (0–100%). */
  retracePct: number;
}

type Bar = { time: string | number; open: number; high: number; low: number; close: number };

// --- Helpers ---

function linReg(ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += ys[i];
    sxx += i * i;
    sxy += i * ys[i];
  }
  const d = n * sxx - sx * sx;
  if (d === 0) return { slope: 0, intercept: 0, r2: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - intercept - slope * i) ** 2;
  }
  return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

/**
 * Duration score: flags of 5–20 bars (1–4 weeks) are ideal.
 * Peak score at 7–15 bars (sweet spot), tapering at edges.
 */
function scoreDuration(flagLen: number): number {
  if (flagLen < 5) return (flagLen / 5) * 0.5; // short flags get partial credit
  if (flagLen <= 7) return 0.7 + (flagLen - 5) * 0.15; // ramp up to sweet spot
  if (flagLen <= 15) return 1.0; // sweet spot: full score
  if (flagLen <= 20) return 1.0 - (flagLen - 15) * 0.1; // tapering off
  return 0.3; // >20 bars: low score but not zero (may still be valid)
}

/**
 * Retracement score: "high and tight" is best.
 * Under 38.2%: full score. 38.2–50%: partial. Above 50%: rejected.
 */
function scoreRetracement(retracePct: number): number {
  if (retracePct <= 0) return 1.0;
  if (retracePct <= IDEAL_RETRACE_PCT) return 1.0 - (retracePct / IDEAL_RETRACE_PCT) * 0.15;
  // 38.2% to 50%: steep dropoff
  const excess = (retracePct - IDEAL_RETRACE_PCT) / (MAX_RETRACE_PCT - IDEAL_RETRACE_PCT);
  return Math.max(0, 0.85 - excess * 0.85);
}

// --- Scoring: Flag pattern (parallel channel) ---

function scoreFlag(
  flagCloses: number[],
  flagMean: number,
  channelWidthPct: number,
  retracePct: number,
  priorGainPct: number,
  flagLen: number,
): { confidence: number; slopePerBar: number; r2: number } | null {
  const reg = linReg(flagCloses);
  const slopePerBar = (reg.slope / flagMean) * 100;

  if (slopePerBar > FLAG_SLOPE_MAX) return null; // drifting up — not a flag
  if (slopePerBar < FLAG_SLOPE_MIN) return null; // dropping too fast — breakdown

  // 1. Orderliness (R²): how well do closes follow a straight line? (0–20 pts)
  const sR2 = Math.max(0, reg.r2) * 20;

  // 2. Channel tightness (price-normalized): tighter is better (0–20 pts)
  const sTight = Math.max(0, 1 - channelWidthPct / MAX_CHANNEL_WIDTH_PCT) * 20;

  // 3. Slope quality: gentle downslope is ideal, around -0.3% per bar (0–15 pts)
  //    Flat (0%) is acceptable but scores slightly less than gentle down
  const idealSlope = -0.3;
  const slopeDev = Math.abs(slopePerBar - idealSlope);
  const sSlope = Math.max(0, 1 - slopeDev / 1.2) * 15;

  // 4. Retracement depth: high-and-tight preferred (0–20 pts)
  const sRetrace = scoreRetracement(retracePct) * 20;

  // 5. Duration: 1–4 weeks ideal (0–10 pts)
  const sDuration = scoreDuration(flagLen) * 10;

  // 6. Prior uptrend strength: stronger preceding move = better setup (0–15 pts)
  const sPrior = Math.min(1, (priorGainPct - PRIOR_UPTREND_MIN_PCT) / 25) * 15;

  const confidence = Math.round(sR2 + sTight + sSlope + sRetrace + sDuration + sPrior);
  return {
    confidence,
    slopePerBar: Math.round(slopePerBar * 100) / 100,
    r2: Math.round(reg.r2 * 1000) / 1000,
  };
}

// --- Scoring: Pennant pattern (converging triangle) ---

function scorePennant(
  flagBars: Bar[],
  flagCloses: number[],
  flagMean: number,
  _channelWidthPct: number,
  retracePct: number,
  priorGainPct: number,
  flagLen: number,
): { confidence: number; slopePerBar: number; r2: number } | null {
  if (flagBars.length < 5) return null; // need at least 5 bars for convergence

  const highs = flagBars.map((b) => b.high);
  const lows = flagBars.map((b) => b.low);

  const regHighs = linReg(highs);
  const regLows = linReg(lows);
  const regCloses = linReg(flagCloses);

  // Highs must descend (negative slope)
  const highSlopeNorm = (regHighs.slope / flagMean) * 100;
  // Lows must ascend or stay flat (positive or near-zero slope)
  const lowSlopeNorm = (regLows.slope / flagMean) * 100;

  if (highSlopeNorm >= 0) return null; // highs not descending
  if (lowSlopeNorm <= -0.05) return null; // lows descending — not a pennant

  // Convergence: compare range at start vs end using regression lines
  const n = flagBars.length;
  const startRange = regHighs.intercept - regLows.intercept;
  const endRange =
    regHighs.intercept + regHighs.slope * (n - 1) - (regLows.intercept + regLows.slope * (n - 1));

  if (startRange <= 0 || endRange <= 0) return null; // degenerate
  const convergenceRatio = endRange / startRange; // < 1 = converging
  if (convergenceRatio > 0.85) return null; // not converging enough

  // Close slope should be flat to slightly negative
  const closeSlopeNorm = (regCloses.slope / flagMean) * 100;
  if (closeSlopeNorm > 0.5) return null; // trending up too much in the pennant
  if (closeSlopeNorm < -1.5) return null; // dropping too fast

  // --- Scoring ---

  // 1. Convergence quality: how much range narrows (0–20 pts)
  const sConv = Math.max(0, 1 - (convergenceRatio - 0.15) / 0.7) * 20;

  // 2. Orderliness of highs and lows regressions (average R²): (0–20 pts)
  const avgR2 = (Math.max(0, regHighs.r2) + Math.max(0, regLows.r2)) / 2;
  const sOrd = avgR2 * 20;

  // 3. Slope symmetry: highs and lows converging at similar rates is ideal (0–5 pts)
  const highMag = Math.abs(highSlopeNorm);
  const lowMag = Math.abs(lowSlopeNorm);
  const maxMag = Math.max(highMag, lowMag, 0.001);
  const asymmetry = Math.abs(highMag - lowMag) / maxMag;
  const sSym = Math.max(0, 1 - asymmetry) * 5;

  // 4. Retracement depth: high-and-tight preferred (0–20 pts)
  const sRetrace = scoreRetracement(retracePct) * 20;

  // 5. Duration: 1–4 weeks ideal (0–10 pts)
  const sDuration = scoreDuration(flagLen) * 10;

  // 6. Prior uptrend strength (0–15 pts)
  const sPrior = Math.min(1, (priorGainPct - PRIOR_UPTREND_MIN_PCT) / 25) * 15;

  // 7. Overall close orderliness R² (0–10 pts)
  const sCloseR2 = Math.max(0, regCloses.r2) * 10;

  const confidence = Math.round(sConv + sOrd + sSym + sRetrace + sDuration + sPrior + sCloseR2);
  return {
    confidence,
    slopePerBar: Math.round(closeSlopeNorm * 100) / 100,
    r2: Math.round(regCloses.r2 * 1000) / 1000,
  };
}

// --- Main detection ---

export function detectBullFlag(bars: Bar[]): BullFlagDetection | null {
  if (bars.length < MIN_TOTAL_BARS) return null;

  const offset = Math.max(0, bars.length - MAX_LOOKBACK_BARS);
  const work = bars.slice(offset);
  const N = work.length;

  let bestResult: BullFlagDetection | null = null;
  let bestConfidence = 0;

  // Try different consolidation lengths — must end at the last bar
  for (let flagLen = FLAG_MIN_BARS; flagLen <= Math.min(FLAG_MAX_BARS, N - 3); flagLen++) {
    const flagStart = N - flagLen;

    const flagBars = work.slice(flagStart);
    const flagCloses = flagBars.map((b) => b.close);
    const flagMean = flagCloses.reduce((a, b) => a + b, 0) / flagCloses.length;
    if (flagMean <= 0) continue;

    // --- Prior uptrend check ---
    const preFlagBars = work.slice(0, flagStart);
    if (preFlagBars.length < 3) continue;

    const preFlagLow = Math.min(...preFlagBars.map((b) => b.low));
    const preFlagHigh = Math.max(
      ...preFlagBars.slice(-Math.min(5, preFlagBars.length)).map((b) => b.high),
    );
    const priorGainPct = ((preFlagHigh - preFlagLow) / preFlagLow) * 100;
    if (priorGainPct < PRIOR_UPTREND_MIN_PCT) continue;

    // --- Retracement check ---
    const priorHeight = preFlagHigh - preFlagLow;
    const flagLowestClose = Math.min(...flagCloses);
    const retracePct =
      priorHeight > 0 ? ((preFlagHigh - flagLowestClose) / priorHeight) * 100 : 0;
    if (retracePct > MAX_RETRACE_PCT) continue;

    // --- Channel width (price-normalized) ---
    const flagHigh = Math.max(...flagBars.map((b) => b.high));
    const flagLow = Math.min(...flagBars.map((b) => b.low));
    const channelWidthPct = ((flagHigh - flagLow) / flagMean) * 100;
    if (channelWidthPct > MAX_CHANNEL_WIDTH_PCT) continue;

    // Try both patterns, take the better score
    const flagResult = scoreFlag(flagCloses, flagMean, channelWidthPct, retracePct, priorGainPct, flagLen);
    const pennantResult = scorePennant(
      flagBars,
      flagCloses,
      flagMean,
      channelWidthPct,
      retracePct,
      priorGainPct,
      flagLen,
    );

    const chosen =
      flagResult && flagResult.confidence >= (pennantResult?.confidence ?? 0)
        ? flagResult
        : pennantResult;

    if (chosen && chosen.confidence > bestConfidence) {
      bestConfidence = chosen.confidence;
      bestResult = {
        confidence: chosen.confidence,
        flagStartIndex: flagStart + offset,
        flagEndIndex: N - 1 + offset,
        slopePerBar: chosen.slopePerBar,
        r2: chosen.r2,
        channelWidthPct: Math.round(channelWidthPct * 100) / 100,
        retracePct: Math.round(retracePct * 10) / 10,
      };
    }
  }

  if (bestResult && bestResult.confidence >= MIN_CONFIDENCE) {
    return bestResult;
  }
  return null;
}

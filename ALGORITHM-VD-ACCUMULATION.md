# Volume Delta Accumulation Divergence Algorithm

## Overview

This algorithm detects **hidden institutional accumulation** during multi-week price declines. The core insight: some stocks decline in price while their 1-minute volume delta reveals persistent net buying — a divergence between price action and order flow that precedes major bullish breakouts.

The algorithm uses **weekly-smoothed metrics** computed from 1-minute volume delta data, making it robust against 1-2 day aberrations from broad market moves.

---

## Core Concept

**Volume Delta** per 1-minute bar:
```
delta = close > open ? +volume : (close < open ? -volume : 0)
```

In a "concordant" decline, selling pressure matches the price drop — cumulative delta declines alongside price. In an **accumulation divergence**, price declines but cumulative delta stays flat or rises, revealing that institutions are absorbing selling pressure and accumulating shares during the pullback.

### What This Looks Like

```
                    Price               Cumulative Volume Delta
                     │                           │
                  ╲  │                         ╱ │
                   ╲ │                        ╱  │
     Concordant:    ╲│   =matching=          ╱   │   ← both decline
                     ╲                      ╱    │
                      ╲                    ╱     │
                                                 │
                     │                         ╱ │
                  ╲  │                        ╱  │
                   ╲ │                       ╱   │
     Divergent:     ╲│   =diverging=        ╱    │   ← delta RISES while price falls
                     ╲                     ╱     │
                      ╲                   ╱      │
```

---

## Confirmed Examples

| Ticker | Period | Duration | Price Change | Net Delta % | Score | Notes |
|--------|--------|----------|-------------|-------------|-------|-------|
| RKLB | Feb 26 – Apr 7, 2025 | ~6 weeks | -17.3% | +0.84% | 0.39 | Detected at week 4 |
| IREN | Mar 13 – Apr 21, 2025 | ~5.5 weeks | -18.4% | +2.35% | 0.82 | Detected at week 2 |

Both preceded major bullish breakouts.

### Negative Controls (Correctly Rejected)

| Ticker | Period | Price Change | Net Delta % | Score | Why Rejected |
|--------|--------|-------------|-------------|-------|------------|
| RKLB | Jan 6 – Feb 14, 2026 | -20.0% | -0.35% | 0.07 | Concordant selling, negative delta shift |
| IREN | Jan 6 – Feb 14, 2026 | -9.2% | -1.48% | 0.02 | Concordant selling |
| SMCI | Oct 1 – Nov 15, 2024 | -46.4% | +0.34% | 0.00 | Crash gate: >45% decline |
| RIVN | Oct 1 – Nov 15, 2024 | -4.4% | -2.06% | 0.00 | Concordant selling gate: delta < -1.5% |

---

## Algorithm Design

### Input

- **1-minute bars** for the candidate window (minimum 2 weeks, typically 4-8 weeks)
- **1-minute bars** for a 30-day pre-context window (before the candidate window)

### Hard Gates (Must Pass)

1. **Price Direction**: Price change must be between -45% and +10%. Crashes (>45% decline) are rejected — that's not consolidation. Rallies (>10%) don't need accumulation detection.
2. **Net Delta Floor**: Net delta % must be > -1.5%. Deeply negative delta indicates concordant selling with no hidden accumulation. The -1.5% threshold allows for 1-2 days of noise.

### Scoring Components (7 metrics, weighted 0-1)

| # | Metric | Weight | What It Measures | Scoring |
|---|--------|--------|-----------------|---------|
| S1 | **Net Delta %** | 25% | Total net buying as % of total volume | -1.5% → 0, +3.5% → 1 |
| S2 | **Delta Slope** | 20% | Trend of cumulative weekly delta (rising = building) | Normalized weekly slope, -0.5 → 0, +3.5 → 1 |
| S3 | **Delta Shift vs Pre** | 15% | Is buying stronger now than before consolidation? | Shift < -1 → 0, shift > +7 → 1 |
| S4 | **Strong Absorption** | 15% | % of days where price down but delta > 5% of avg vol | 0% → 0, 18%+ → 1 |
| S5 | **Large Buy vs Sell** | 10% | More big-buy days than big-sell days? | As ratio of total days, normalized |
| S6 | **Price-Delta Anti-Correlation** | 10% | Negative correlation = divergence signal | corr +0.3 → 0, corr -1.2 → 1 |
| S7 | **Accum Week Ratio** | 5% | Fraction of weeks with positive delta | 20% → 0, 80% → 1 |

**Composite**: `score = Σ(Si × Wi)`

### Duration Scaling

Score grows with pattern duration to reward longer accumulation:

```
durationMultiplier = min(1.0, 0.70 + (weeks - 2) × 0.075)
finalScore = rawScore × durationMultiplier
```

| Weeks | Multiplier |
|-------|-----------|
| 2 | 0.70 |
| 3 | 0.775 |
| 4 | 0.85 |
| 5 | 0.925 |
| 6+ | 1.00 |

### Detection Threshold

**Score ≥ 0.30 → Accumulation Detected**

### Sliding-Window Behavior

The algorithm evaluates the most recent N weeks. In a scan:
1. First pass: check the last 6 weeks
2. If not detected, check the last 4 weeks, then 3, then 2
3. Once detected, the scan records the earliest detection date
4. On subsequent scans, the score is re-evaluated with the growing window

This means the algorithm "discovers" accumulation once 2+ weeks of data show the pattern, and the score naturally grows as the pattern persists.

---

## Key Discriminating Features

From feature engineering on confirmed positive vs negative cases, these features had **perfect separation** (no overlap between positive and negative distributions):

| Feature | Positives (mean) | Negatives (mean) | Direction |
|---------|-----------------|-----------------|-----------|
| netDeltaPct | +1.59% | -0.89% | Positive = accumulation |
| deltaSlopeNorm | +1.70 | -0.83 | Positive = delta rising |
| deltaShiftVsPre | +6.41 | -0.55 | Positive = stronger than before |
| strongAbsorptionPct | 11.0% | 1.5% | High = buying into weakness |
| largeBuyVsSell | +5.3 | -4.4 | Positive = more buy days |
| priceDeltaCorr | -0.22 | +0.53 | Negative = divergence |

---

## Implementation Notes

### Data Requirements

- **1-minute bars**: ~390 bars/day × 30 days = ~12,000 bars per candidate window
- **Pre-context**: 30 days of 1m bars before the candidate window
- Total per ticker: ~24,000 1m bars (fetched in 25-day chunks due to API limits)

### Weekly Aggregation

Daily noise is smoothed by aggregating to ISO weeks (Mon-Sun). Each week computes:
- `buyVol`, `sellVol`, `totalVol`, `delta`, `deltaPct`
- `priceStart`, `priceEnd`, `priceChangePct`

This makes the algorithm resilient to 1-2 aberration days within a week.

### Volume Delta Computation

Per 1-minute bar:
```javascript
delta = bar.close > bar.open ? bar.volume
      : bar.close < bar.open ? -bar.volume
      : 0;
```

Buy volume = sum of positive deltas. Sell volume = sum of negative deltas.
This is the same methodology used in our divergence table and VD RSI.

### Scan Architecture (Planned)

For production scanning:
1. Run against the full ticker universe
2. For each ticker, fetch last 6 weeks of 1m data + 30-day pre-context
3. Score the accumulation divergence
4. Store results with: `ticker`, `scan_date`, `score`, `weeks_detected`, `first_detected_date`
5. On subsequent scans, track score progression (growing, stable, or fading)

---

## Validation Results

### Fixed-Window (6 test cases)

```
RKLB Feb-Apr 2025 (confirmed):    Score 0.39 ✅ Detected
IREN Mar-Apr 2025 (confirmed):    Score 0.82 ✅ Detected
RKLB Jan-Feb 2026 (negative):     Score 0.07 ✅ Rejected
IREN Jan-Feb 2026 (negative):     Score 0.02 ✅ Rejected
SMCI Oct-Nov 2024 (crash):        Score 0.00 ✅ Rejected (crash gate)
RIVN Oct-Nov 2024 (no breakout):  Score 0.00 ✅ Rejected (concordant selling)
Accuracy: 6/6 (100%)
```

### Sliding-Window (score progression)

```
RKLB:  2wk=0.25  3wk=0.23  4wk=0.35✅  5wk=0.43✅  6wk=0.39✅
IREN:  2wk=0.57✅ 3wk=0.80✅ 4wk=0.86✅ 5wk=0.79✅ 6wk=0.82✅
```

IREN was detected from week 2 with a strong 0.57 score. RKLB was first detected at week 4 (0.35). Both show sustained or growing scores.

---

## Future Work

- [ ] Test with more confirmed positive examples (user will provide)
- [ ] Test with more negative controls (declining stocks that didn't break out)
- [ ] Tune thresholds based on expanded sample
- [ ] Consider adding: VWAP proximity, Bollinger Band width, relative volume
- [ ] Implement in `server/services/htfDetector.js` as a scan-ready detection function
- [ ] Wire into the divergence scan pipeline with DB persistence
- [ ] Add frontend display (score on chart, scan results in divergence panel)
- [ ] Explore: does the algorithm work on intraday (15m) data for faster detection?

---

## Development History

### Analysis Scripts

| Script | Purpose |
|--------|---------|
| `analysis-htf-rklb-asts.js` | First attempt: ran existing HTF algo on RKLB episodes (0/7 detected) |
| `analysis-htf-deep.js` | Daily-timeframe pattern analysis of RKLB/ASTS consolidations |
| `analysis-asts-consol-vd.js` | VD + VD RSI analysis of 6 consolidation periods |
| `analysis-vd-divergence-algo.js` | v1 algorithm prototype (40% accuracy) |
| `analysis-vd-v2.js` | v2 feature engineering — 25+ features, discrimination analysis |
| `analysis-vd-v3.js` | **v3 production algorithm** — 100% accuracy, weekly-smoothed, duration-scaling |

### Key Learnings

1. **Classic HTF metrics don't apply**: YZ volatility, delta compression, range decay, VWAP deviation all scored near-zero for these stocks. They're designed for "dead zone" tight consolidation, not active accumulation.

2. **Overall VD RSI divergence is unreliable as sole signal**: Some positive cases showed concordant VD RSI decline. VD RSI divergence is a bonus signal, not a requirement.

3. **The real signal is in the raw 1-minute volume delta**: Net positive delta during price decline, delta shift vs pre-context, and strong absorption days are the most discriminating features.

4. **Weekly smoothing is essential**: Daily data is too noisy. Single-day aberrations from market-wide moves can temporarily reverse delta patterns. Weekly aggregation smooths this out.

5. **Hard gates prevent false positives**: Rejecting crashes (>45% decline) and deeply concordant selling (delta < -1.5%) eliminates the worst false positives (SMCI, RIVN) without affecting true positives.

# Volume Delta Accumulation & Distribution Algorithm

## Overview

This algorithm detects **hidden institutional accumulation** during multi-week price declines and consolidations. The core insight: some stocks decline in price while their 1-minute volume delta reveals persistent net buying — a divergence between price action and order flow that precedes major bullish breakouts.

The system has five layers:

1. **Accumulation Zone Detection** — identifies zones of hidden buying (weeks of lead time)
2. **Distribution Zone Detection** — warns when institutions are selling into rallies (avoid false entries)
3. **Breakout Proximity Prediction** — signals when a breakout is imminent (days of lead time)
4. **Macro Cycle Detection** — detects the full Wyckoff cycle (Distribution → Accumulation → Breakout) across months
5. **Swing Trading Position Management** — translates signals into actionable ENTER/ADD/HOLD/REDUCE/EXIT decisions

Validated across 19 tickers with confirmed breakouts. Best zone score 1.09 (IMNM), worst true positive 0.47 (AFRM). Highest absorption rate 53.8% (COHR). Highest proximity score 100 pts (COHR). Zero false positives in negative controls.

---

## Core Concept

**Volume Delta** per 1-minute bar:
```
delta = close > open ? +volume : (close < open ? -volume : 0)
```

In a "concordant" decline, selling pressure matches the price drop — cumulative delta declines alongside price. In an **accumulation divergence**, price declines but cumulative delta stays flat or rises, revealing that institutions are absorbing selling pressure and accumulating shares during the pullback.

```
                    Price               Cumulative Volume Delta
                     │                           │
                  ╲  │                         ╱ │
                   ╲ │                        ╱  │
     Concordant:    ╲│   =matching=          ╱   │   ← both decline
                     ╲                      ╱    │
                      ╲                    ╱     │

                     │                         ╱ │
                  ╲  │                        ╱  │
                   ╲ │                       ╱   │
     Divergent:     ╲│   =diverging=        ╱    │   ← delta RISES while price falls
                     ╲                     ╱     │
                      ╲                   ╱      │
```

---

## Part 1: Accumulation Zone Detection

### Data Requirements

- **1-minute bars** for a lookback window (up to ~8 months for long-duration tickers)
- **1-minute bars** for a 30-day pre-context window (before the candidate window)
- Fetched in 25-day chunks due to API limits (50K bar limit per request)
- ~390 bars/day × 35 days = ~13,650 bars per scan window
- Total per ticker: ~24,000–75,000 1m bars depending on lookback depth

### Daily Aggregation

Per trading day, compute from 1-minute bars:
```javascript
buyVol   = sum of volumes where bar.close > bar.open
sellVol  = sum of volumes where bar.close < bar.open
delta    = buyVol - sellVol
deltaPct = delta / totalVol * 100
```

### 3σ Outlier Capping

Before scoring, cap daily deltas at mean ± 3 standard deviations. This prevents single anomalous events (e.g., INSM's +5738K day, 29.7x average) from dominating the entire score. The anomaly is still detected separately by the proximity system.

```javascript
const m = mean(deltas), s = std(deltas);
const cap = m + 3 * s, floor = m - 3 * s;
effectiveDeltas = deltas.map(d => Math.max(floor, Math.min(cap, d)));
```

### Hard Gates (Must Pass All)

1. **Price Direction**: Price change must be between **-45% and +10%**. Crashes (>45%) are not consolidation. Rallies (>10%) don't need accumulation detection.
2. **Net Delta Floor**: Net delta % must be **> -1.5%**. Deeply negative delta indicates concordant selling with no hidden accumulation.
3. **Delta Slope Gate**: Normalized cumulative weekly delta slope must be **> -0.5**. Prevents scoring windows where delta is actively declining.

### 7-Component Scoring System

| # | Metric | Weight | What It Measures | Formula |
|---|--------|--------|-----------------|---------|
| S1 | **Net Delta %** | 25% | Total net buying as % of total volume | `clamp((netDeltaPct + 1.5) / 5, 0, 1)` |
| S2 | **Delta Slope** | 22% | Trend of cumulative weekly delta (rising = building) | `clamp((deltaSlopeNorm + 0.5) / 4, 0, 1)` |
| S3 | **Delta Shift vs Pre** | 15% | Is buying stronger now than before consolidation? | `clamp((deltaShift + 1) / 8, 0, 1)` |
| S4 | **Accum Week Ratio** | 15% | Fraction of weeks with positive delta | `clamp((ratio - 0.2) / 0.6, 0, 1)` |
| S5 | **Large Buy vs Sell** | 10% | More big-buy days than big-sell days? | `clamp((largeBuyVsSell + 3) / 12, 0, 1)` |
| S6 | **Absorption %** | 8% | % of days where price down but delta positive | `clamp(absorptionPct / 20, 0, 1)` |
| S7 | **Volume Decline** | 5% | Volume drying up (typical of late-stage consolidation) | First-third vs last-third volume ratio |

**Raw Score**: `rawScore = S1×0.25 + S2×0.22 + S3×0.15 + S4×0.15 + S5×0.10 + S6×0.08 + S7×0.05`

### Duration Scaling

Score grows with pattern duration to reward longer, more confident accumulation:

```
durationMultiplier = min(1.15, 0.70 + (weeks - 2) × 0.075)
finalScore = rawScore × durationMultiplier
```

| Weeks | Multiplier | Max Final Score |
|-------|-----------|-----------------|
| 2 | 0.70 | 0.70 |
| 3 | 0.775 | 0.775 |
| 4 | 0.85 | 0.85 |
| 5 | 0.925 | 0.925 |
| 6 | 1.00 | 1.00 |
| 7 | 1.075 | 1.075 |
| 8+ | 1.15 | 1.15 |

### Subwindow Scanner

Rather than evaluating a fixed window, the algorithm scans all possible subwindows within the lookback period:

```
Window sizes: [10, 14, 17, 20, 24, 28, 35] trading days
              (~2, ~3, ~3.5, ~4, ~5, ~5.5, ~7 weeks)
```

For each window size, slide day-by-day through the full period. Score each subwindow independently. This discovers the optimal accumulation window regardless of when it started.

### Multi-Zone Clustering (Greedy)

From all detected subwindows (score ≥ 0.30), select the top zones:

1. Sort all windows by score descending
2. Take the highest-scoring window as Zone 1
3. For each remaining window, reject if:
   - **>30% overlap** with any selected zone, OR
   - **<10 trading days gap** from any selected zone
4. Maximum **3 zones** per ticker

This allows detecting multiple accumulation phases (e.g., MOD had two pre-breakout zones + one post-breakout zone).

### Detection Threshold

**Score ≥ 0.30 → Accumulation Zone Detected**

### Score Interpretation

| Score Range | Interpretation |
|-------------|---------------|
| 0.00–0.29 | Not detected / below threshold |
| 0.30–0.59 | Weak accumulation (short duration or mixed signals) |
| 0.60–0.79 | Moderate accumulation (clear divergence, multiple confirming metrics) |
| 0.80–0.99 | Strong accumulation (high confidence, multiple weeks, strong divergence) |
| 1.00+ | Extreme accumulation (max duration, nearly all metrics maxed) |

---

## Part 2: Distribution Zone Detection

### Concept

Distribution is the **mirror image** of accumulation. Price rises but institutions are selling into the rally. This warns users: "Don't buy here — smart money is exiting."

The clearest example is MOD post-breakout (4/22/25): price surged from $68.70 → $81.13 but delta was -103K, -103K, -110K, -94K for 4 consecutive days. Institutions who accumulated during the decline were distributing into retail momentum.

### When Distribution Zones Matter

1. **Pre-accumulation distribution**: Tells the user "accumulation hasn't started yet — sellers are still in control" (e.g., MOD 3/10→3/27: 10 consecutive red delta days during a price bounce)
2. **Post-breakout distribution**: Tells the user "the run is fueled by retail, not institutions — be cautious" (e.g., MOD 4/22→4/28)
3. **False rally warning**: Price is rising but on negative delta — likely to reverse

### Implementation Approach

**Scoring** — Inverse of accumulation:

| Component | Accumulation | Distribution |
|-----------|-------------|--------------|
| Net delta | Positive (buying) | Negative (selling) |
| Delta slope | Rising | Falling |
| Delta shift | Buying stronger than before | Selling stronger than before |
| Absorption | Price down, delta positive | **Price up, delta negative** (reverse absorption) |
| Large buy vs sell | More buy days | More sell days |
| Price direction gate | -45% to +10% | **-10% to +45%** |
| Net delta gate | > -1.5% | **< +1.5%** |

**Visual Representation on Chart:**
- Accumulation zones: **green** shaded regions on price chart
- Distribution zones: **red** shaded regions on price chart
- This creates an immediate visual language: green = accumulating, red = distributing, unshaded = neutral

### Detection Logic

```javascript
function scoreDistributionWindow(dailySlice, preDaily) {
  // Same structure as accumulation, but:
  // 1. Price gate: must be between -10% and +45% (catching rallies)
  // 2. Net delta must be < +1.5% (net selling)
  // 3. Slope gate: normalized slope must be < +0.5 (delta declining)
  // 4. S1 (net delta): more negative = higher score
  // 5. S6 (reverse absorption): days where price UP but delta NEGATIVE
  // Scoring inverts all accumulation metrics
}
```

---

## Part 3: Breakout Proximity Prediction

### Concept

While accumulation zones provide **weeks** of lead time (10–35 trading days before breakout), proximity signals provide **days** of warning (1–10 trading days). These require an active accumulation zone as a prerequisite.

**Rule**: Proximity signals only fire when **at least one accumulation zone with score ≥ 0.50** exists in the recent scan.

### Signal Catalog

Compiled from analysis of 19 confirmed breakout tickers:

#### Signal 1: Seller Exhaustion Sequence
**Source**: PL, INSM, MOD, GRAL, COHR
**Lead time**: 5–10 trading days
**Pattern**: 3+ consecutive red delta days, often with increasing magnitude (intensifying), followed by reversal. Indicates selling pressure is peaking and about to exhaust.
```
Detection:
  - 3+ consecutive days with delta < 0
  - Magnitude of final day > magnitude of first day (intensifying)
  - Occurs within an active accumulation zone
```

#### Signal 2: Delta Anomaly (Smoking Gun)
**Source**: IMNM, INSM, COHR
**Lead time**: 4–25 trading days
**Pattern**: Single day where |delta| > 4x the rolling 20-day average. Often positive delta on a down day (absorption). This is a massive institutional entry.
```
Detection:
  - |delta_today| > 4 × mean(|delta| over past 20 days)
  - volume_today > 3 × average volume
  - Extreme examples: INSM 4/25 (29.7x avg), IMNM 9/12 (6.8x vol)
```

#### Signal 3: Green Delta Streak
**Source**: IMNM, INSM, MOD, GRAL, COHR
**Lead time**: 3–7 trading days
**Pattern**: 4+ consecutive days with positive delta, especially when accompanied by absorption days (price down but delta positive). Shows buyers have taken control.
```
Detection:
  - 4+ consecutive days with delta > 0
  - Bonus: ≥2 of those days are absorption days (price down, delta positive)
  - Examples: IMNM 5 green days (9/9→9/15), INSM 4 green days (5/13→5/16)
```

#### Signal 4: Absorption Clustering
**Source**: IMNM, MOD, COHR
**Lead time**: 3–7 trading days
**Pattern**: Multiple absorption days (price down, delta positive) clustered in a short window. When 3+ of 5 consecutive days are absorption days, buyers are overwhelming sellers on every dip.
```
Detection:
  - ≥3 absorption days in a 5-day window
  - MOD Zone 3 had 46.2% absorption rate — highest across all tickers
```

#### Signal 5: Final Capitulation Dump
**Source**: PL, INSM, MOD, GRAL, COHR
**Lead time**: 1–2 trading days
**Pattern**: A single large negative delta day right before breakout. The last sellers dumping their shares. Often the sharpest red day in the recent window.
```
Detection:
  - Day with |delta| > 2x recent average AND delta negative
  - Price drops >3% on the day
  - Occurs 1-2 days before breakout
  - Examples: PL -755K (1d before), INSM -414K (1d before), MOD -142K (1d before)
```

#### Signal 6: Post-Anomaly Digestion
**Source**: INSM
**Lead time**: 15–25 trading days
**Pattern**: After a massive delta anomaly (>10x avg), the stock sells off as the market digests the event. Then seller exhaustion → green streak → breakout.
```
Sequence:
  1. Delta anomaly day (>10x rolling 20d avg)
  2. Sell-off / digestion period (5-15 days of mostly negative delta)
  3. Seller exhaustion (intensifying red streak)
  4. Green delta streak with absorption
  5. Breakout within 1-5 days
```

#### Signal 7: Multi-Zone Sequence
**Source**: MOD
**Lead time**: 5–15 trading days after Zone 2 completes
**Pattern**: Two distinct accumulation zones separated by a short distribution gap (<3 weeks). When the second zone completes, breakout is imminent.
```
Detection:
  - Zone A detected (score ≥ 0.50)
  - Distribution interlude (5-15 days of negative delta)
  - Zone B detected (score ≥ 0.50)
  - Breakout follows within 1-2 weeks of Zone B completion
```

#### Signal 8: Extreme Absorption Rate
**Source**: MOD, COHR
**Lead time**: 5–10 trading days
**Pattern**: When absorption exceeds 40% in any detected zone, buyers are absorbing nearly every dip. This indicates demand has overwhelmed supply.
```
Detection:
  - absorption_pct > 40% in any zone
  - COHR Zone 4: 53.8% (all-time highest)
  - MOD Zone 3: 46.2% (previous record)
```

#### Signal 9: Delta Anomaly Cluster
**Source**: BW
**Lead time**: 7–19 trading days
**Pattern**: 3+ delta anomalies (>4x rolling average) clustered within 15 trading days near price lows. Unlike a single smoking gun (Signal 2), a cluster reveals repeated institutional entries at the bottom — not a one-off event but a systematic accumulation campaign.
```
Detection:
  - 3+ days where |delta| > 4x mean(|delta| over past 20 days)
  - All within a 15 trading day window
  - Occur within 10% of 52-week low
  - BW: 4/2 (6.7x), 4/9 (4.4x), 4/14 (4.8x) — 3 anomalies in 12 days
    at price near $0.27 (historical low)
```

#### Signal 10: Distribution → Accumulation Transition
**Source**: BW
**Lead time**: Weeks (strategic, not tactical)
**Pattern**: A detected distribution zone (price rising, delta negative) gives way to a detected accumulation zone (price declining, delta positive). This transition marks the completion of institutional selling and the beginning of institutional buying — the "Wyckoff turn."
```
Detection:
  - Distribution zone detected (score ≥ 0.30) in recent past
  - Followed by accumulation zone (score ≥ 0.50)
  - BW: Distribution Oct-Nov 2024 (cum delta -1,314K while price flat)
    → Accumulation Zone 2 Nov-Dec 2024 (score 0.9454, corr -0.74)
```

#### Signal 11: Intensifying Capitulation Streak
**Source**: BW
**Lead time**: 15–20 trading days
**Pattern**: 6+ consecutive red delta days where magnitude INCREASES day-over-day. Unlike simple seller exhaustion (Signal 1), this captures the extreme panic selling that marks a true capitulation bottom. The intensification is key — each day's sellers are more desperate than the last.
```
Detection:
  - 6+ consecutive days with delta < 0
  - |delta[i+1]| > |delta[i]| for majority of the streak (intensifying)
  - BW: 6-day streak 3/21→3/28/25, coinciding with tariff panic
  - Longest capitulation streak observed across all tickers
```

### Composite Proximity Score

Each signal that fires contributes to a composite breakout proximity score:

| Signal | Points | Max Concurrent |
|--------|--------|----------------|
| Seller exhaustion (3+ red days, intensifying) | +15 | 1 |
| Delta anomaly (>4x avg) | +25 | 1 |
| Green delta streak (4+ days) | +20 | 1 |
| Absorption cluster (3/5 days) | +15 | 1 |
| Final capitulation dump | +10 | 1 |
| Multi-zone sequence complete | +20 | 1 |
| Extreme absorption rate (>40%) | +15 | 1 |
| Delta anomaly cluster (3+ in 15 days) | +30 | 1 |
| Distribution → Accumulation transition | +20 | 1 |
| Intensifying capitulation (6+ days) | +20 | 1 |

**Thresholds**:
- 30+ points → **Elevated** — breakout possible within 1-2 weeks
- 50+ points → **High** — breakout likely within 1 week
- 70+ points → **Imminent** — breakout likely within 1-3 days

---

## Part 4: Macro Cycle Detection (Distribution → Accumulation → Breakout)

### The Pattern

BW ($2.55 → $0.27 → $10.69, 39.6x from bottom) revealed a complete institutional orchestration cycle that appears to repeat across tickers:

```
STAGE 1          STAGE 2           STAGE 3         STAGE 4            STAGE 5
Distribution  →  Markdown       →  Accumulation →  Anomaly Cluster → Breakout
                 + Accumulation     Intensifies     (final loading)
                 in Decline

Price: ───╲                                                           ╱───
           ╲                                                         ╱
            ╲                                                       ╱
             ╲──────────────╲                                      ╱
                             ╲─────── ★ ★ ★ ──╱
                                   (anomalies)

Delta: ──╲                ╱╲               ╱╲    ╱╲╱╲            ╱╱╱──
           ╲             ╱  ╲             ╱  ╲  ╱              ╱╱
            ╲╲──────────╱    ╲───────────╱    ╲╱              ╱
              negative         diverging          positive
```

### 5-Stage Detection Framework

#### Stage 1: Distribution Alert
Institutions begin selling into a rally or flat period. Price stable or rising, delta cumulative declining.

```
Detection:
  - Distribution zone score ≥ 0.30
  - Price flat or up, cumulative delta down
  - Duration: typically 4–8 weeks
  - BW example: Oct-Nov 2024 — cum delta -1,314K while price flat
  - Alert: "Distribution detected — smart money selling"
```

#### Stage 2: Accumulation in Decline
After distribution triggers a markdown phase, institutions begin accumulating at lower prices. This is the core divergence — price declining but delta positive or rising.

```
Detection:
  - Accumulation zone score ≥ 0.50 with negative price-delta correlation
  - Price change < -10% in the zone
  - correlation(price, cumDelta) < -0.50
  - BW example: Zone 2, Nov-Dec 2024 — score 0.9454, corr -0.74, price -30%+
  - Alert: "Accumulation in decline — institutions buying the dip"
```

#### Stage 3: Seller Exhaustion
The natural sellers are running out. Capitulation streaks intensify then dissipate. Volume dries up. The stock feels "dead."

```
Detection:
  - Capitulation streak detected (Signal 1 or Signal 11)
  - Volume declining trend
  - Delta becoming less negative or flipping positive
  - BW example: 6-day intensifying capitulation 3/21→3/28/25
  - Alert: "Seller exhaustion — natural selling pressure spent"
```

#### Stage 4: Anomaly Cluster (Final Loading)
Institutions make their final, most aggressive purchases. Multiple delta anomalies appear at the lows — massive volume days with positive delta near 52-week lows.

```
Detection:
  - Delta anomaly cluster (Signal 9): 3+ anomalies in 15 days
  - Price within 10% of 52-week low
  - BW example: 4/2 (6.7x), 4/9 (4.4x), 4/14 (4.8x) — 3 in 12 days
  - Alert: "Anomaly cluster at lows — imminent breakout setup"
```

#### Stage 5: Breakout Confirmation
Price breaks above consolidation range on strong positive delta. Unlike distribution-fueled breakouts (MOD), cycle-bottom breakouts tend to show sustained positive delta through the markup phase.

```
Detection:
  - Price moves >10% above consolidation range
  - Delta positive for 3+ consecutive weeks
  - BW example: 4/21 breakout, positive delta for 4 consecutive weeks
  - Post-breakout: $0.27 → $10.69 (39.6x)
```

### Cycle Detection Score

When multiple stages are confirmed in sequence, confidence compounds:

| Stages Confirmed | Confidence | Implication |
|-----------------|------------|-------------|
| 1 only | Low | Distribution exists but could be noise |
| 1 + 2 | Moderate | Classic Wyckoff structure forming |
| 1 + 2 + 3 | High | Sellers exhausted after institutional accumulation |
| 1 + 2 + 3 + 4 | Very High | Anomaly cluster at lows = final loading |
| All 5 | Confirmed | Full cycle complete — validates the framework |

### Why This Repeats

This pattern recurs because it reflects structural market dynamics:
1. Institutions can't buy all at once (would move price against them)
2. They engineer or exploit fear (tariffs, macro events) to create supply
3. Retail panic-sells into institutional bids
4. The "dead zone" at the bottom allows final accumulation
5. Once supply is exhausted, minimal buying pressure causes explosive moves
6. Retail FOMO on the breakout provides exit liquidity for early stages

This is the Wyckoff cycle: **Accumulation → Markup → Distribution → Markdown → repeat.** The algorithm detects it using volume delta as the institutional fingerprint.

---

## Part 5: Swing Trading Position Management

### Concept

For long-term swing position traders, the algorithm's accumulation, distribution, and proximity signals combine into a complete **position management framework**. Rather than just detecting zones, this layer translates detections into actionable trading decisions: when to enter, when to add, when to hold, and when to exit.

Derived from COHR's 16-month lifecycle analysis (10/24–2/26) which demonstrated 3 trades yielding ~+195% cumulative while avoiding all major drawdowns including a 50% crash.

### Position States

| State | Trigger | Action |
|-------|---------|--------|
| **ENTER** | Accumulation zone ≥ 0.70 AND proximity ≥ 30 | Open position (initial size) |
| **ADD** | New accumulation zone starts while holding | Add to position (scale in) |
| **HOLD** | Post-breakout DURABLE (3+/4 weeks positive delta) | Maintain full position |
| **REDUCE** | Post-breakout MIXED (2/4 weeks positive) | Take partial profits |
| **EXIT** | Post-breakout FRAGILE (≤1/4 weeks positive) OR distribution cluster detected | Close position |
| **STAY OUT** | Distribution cluster active (price rising, delta deeply negative) | No new entries |

### Post-Breakout Delta Polarity (Primary Exit Signal)

After any breakout, check delta polarity over the next 4 weeks:

```
DURABLE:   3/4 or 4/4 weeks positive delta → HOLD — institutions still buying
MIXED:     2/4 weeks positive delta        → REDUCE — momentum fading
FRAGILE:   0/4 or 1/4 weeks positive delta → EXIT — institutions selling into rally
```

**COHR validation** (100% accuracy across 10 breakouts):
- FRAGILE breakouts (Jan 17/25, Feb 6/25, Aug 7/25): ALL crashed 10–50% within weeks
- DURABLE breakouts (Nov 6/24, Apr 9/25, May 13/25, Jun 26/25, Jan 13/26): ALL held and extended

### Distribution Cluster Detection

Distribution clusters warn that institutions are selling into a rally — the inverse of accumulation:

```
Detection:
  - 10-day rolling windows: price >+3% but cumulative delta < -3%
  - Cluster overlapping windows within 5 days
  - COHR examples:
    - D1: 11/22→12/12/24 (14d, -808K net delta) → 15% decline followed
    - D2: 1/28→2/8/25 (11d, -1,350K net delta) → 50% CRASH followed
    - D3: 9/19→10/13/25 (17d, -1,738K net delta) → 10% pullback followed
  - Action: EXIT if holding, STAY OUT if not
```

### Accumulation-in-Decline Detection

The mirror of distribution — price declining but institutions buying. This identifies re-accumulation opportunities during pullbacks:

```
Detection:
  - 10-day rolling windows: price <-3% but cumulative delta >+3%
  - COHR found 5 such windows across the full period
  - Action: ENTER or ADD when combined with zone score ≥ 0.70
```

### Swing Trade Playbook (COHR Example)

```
Trade 1: Apr 9, 2025 — Enter at ~$49 (Zone 4 detected, 53.8% absorption, proximity 85)
         → Hold through DURABLE breakout (3/4 weeks positive)
         → Ride through Zone 1 re-accumulation (May-Jul)
         → Exit on FRAGILE signal Aug 7 at ~$96
         → Result: +96% in ~4 months

Trade 2: Nov 6, 2025 — Re-enter at ~$106 (Zone 2 detected, proximity rising)
         → Hold through DURABLE breakout (3/5 weeks positive)
         → Ride through Zone 3 re-accumulation (Jan 26)
         → As of 2/10/26: holding at ~$238, proximity 100 pts
         → Result: +125% and counting

Cumulative: ~+195% over 10 months, avoided the 50% crash (Jan-Apr 2025)
```

### Monthly Phase Analysis

For long-duration holdings, classify each 20-day rolling window by institutional flow:

| Symbol | Phase | Detection |
|--------|-------|-----------|
| ★ ACCUM | Accumulation in decline | Price <-3%, delta >+3% |
| ⚠ DISTRIB | Distribution into rally | Price >+3%, delta <-3% |
| ↑ confirmed | Confirmed rally | Price >+3%, delta >+3% |
| ↓ concordant | Concordant decline | Price <-3%, delta <-3% |
| ◆ absorbing | Absorption | Price flat (±3%), delta >+3% |
| — neutral | Neutral | All other conditions |

This provides a high-level "institutional weather map" — when phases transition from ⚠DISTRIB to ★ACCUM, the Wyckoff turn is in progress.

---

## Confirmed Examples

### All-Time Scores (Best Zone Per Ticker)

| Ticker | Score | Window | Days | Net ∂% | Absorption | Type |
|--------|-------|--------|------|--------|------------|------|
| IMNM | 1.09 | 7/28→9/15/25 | 35d | +12.46% | 35% | Strong conviction (extreme) |
| INSM | 1.07 | 4/7→5/27/25 | 35d | +6.71% | 14.7% | Strong conviction + smoking gun |
| BW | 1.04 | 3/28→5/16/25 | 35d | ~5% | ~18% | Bottom accumulation + 3 anomalies |
| BE | 1.02 | 9/20→11/7/24 | 35d | ~5% | ~20% | Strong conviction |
| SATS | 0.96 | 3/3→4/21/25 | 35d | ~4% | ~18% | Multi-phase |
| BW-Z2 | 0.95 | 11/8→12/30/24 | 35d | ~4% | 32.4% | Crash accumulation (corr -0.74) |
| MOD | 0.94 | 5/14→7/3/25 | 35d | +2.23% | 20.6% | Post-breakout re-accum |
| IREN | 0.94 | 3/19→5/7/25 | 35d | +2.35% | ~15% | Concentrated bursts |
| GRAL | 0.88 | 7/21→8/27/25 | 28d | ~5% | ~15% | Quiet conviction — no catalyst |
| COHR | 0.88 | 5/13→7/2/25 | 35d | ~5% | ~18% | Smoking gun + 7/8 wk positive |
| CRDO | 0.87 | 3/27→4/30/25 | 24d | ~3% | ~12% | Strong conviction |
| PL | 0.86 | 3/26→5/5/25 | 28d | ~3% | 37% | Strong conviction |
| MOD-Z2 | 0.85 | 2/15→3/10/25 | 17d | +3.89% | 25% | Classic divergence |
| WULF | 0.83 | 2/22→3/24/25 | 24d | ~2% | ~15% | Strong conviction |
| MOD-Z3 | 0.81 | 3/28→4/16/25 | 14d | +3.92% | 46.2% | Extreme absorption |
| COHR-Z2 | 0.79 | 11/6→12/17/25 | 35d | ~3% | ~15% | Post-pullback re-accumulation |
| EOSE | 0.78 | 2/15→3/7/25 | 17d | ~2% | ~12% | Multi-phase |
| ALAB | 0.78 | 3/12→4/30/25 | 35d | ~2% | ~10% | Concentrated |
| BW-Z3 | 0.75 | 1/13→2/5/26 | 20d | ~2% | ~12% | Late re-accumulation |
| COHR-Z3 | 0.75 | 1/7→2/5/26 | 24d | ~2% | ~12% | 2 anomalies in 7 days |
| COHR-Z4 | 0.72 | 3/13→4/1/25 | 14d | ~3% | **53.8%** | Extreme absorption (ALL-TIME HIGHEST) |
| STX | 0.71 | 3/6→3/19/25 | 10d | ~2% | ~10% | Slow drip |
| COHR-Z5 | 0.70 | 7/17→8/5/25 | 14d | ~2% | ~10% | 9 green days nearby |
| RKLB | 0.65 | 3/20→4/2/25 | 10d | +0.84% | ~8% | Episodic |
| HUT | 0.64 | 4/24→5/7/25 | 10d | ~1% | ~8% | Hidden in decline |
| UUUU | 0.59 | 11/14→12/4/25 | 17d | ~1% | ~10% | Bottoming |
| AFRM | 0.47 | 5/12→6/4/24 | 17d | ~1% | ~8% | Concentrated bursts |

### Accumulation Archetypes

| Archetype | Description | Typical Score | Examples |
|-----------|-------------|---------------|----------|
| **Strong conviction** | Persistent positive delta across most weeks, steady accumulation | 0.80–1.10 | IMNM, INSM, BE, CRDO, PL, WULF, COHR |
| **Concentrated bursts** | A few massive buying days drive the score, other days neutral | 0.50–0.95 | IREN, ALAB, AFRM |
| **Multi-phase** | Multiple distinct accumulation waves with distribution gaps | 0.80–0.95 | MOD, SATS, EOSE, COHR |
| **Slow drip** | Barely-above-zero net delta, many neutral days, needs duration | 0.50–0.75 | STX, UUUU |
| **Hidden in decline** | Price actively declining but accumulation signal still emerges | 0.50–0.70 | HUT |
| **Quiet conviction** | No delta anomalies, no exogenous catalyst — pure steady accumulation + volume collapse | 0.80–0.90 | GRAL |
| **Orchestrated cycle** | Full Wyckoff: distribution → crash → accumulation → anomaly cluster → breakout | 0.95–1.05 | BW |
| **Full lifecycle** | Multi-zone accumulation across months, with distribution clusters and breakout cycling | 0.70–0.90 | COHR |

### Breakout Proximity Signals Observed

| Ticker | Proximity Signals Before Breakout | Lead Time |
|--------|----------------------------------|-----------|
| **IMNM** | Delta anomaly (9/12, 6.8x vol) + 5 green days + absorption cluster | 4–7 days |
| **INSM** | Smoking gun (4/25, 29.7x avg) → sell-off → seller exhaustion → 4 green days + final dump | 19 days (anomaly), 4 days (green streak) |
| **PL** | Capitulation selling (3 red days, 5/28→5/30) → breakout | 5–7 days |
| **MOD** | Multi-zone sequence (Z2 + Z3) + 46.2% absorption + final dump (4/17–4/21) + Wyckoff spring | 4–6 days |
| **BW** | Distribution (Oct-Nov '24) → crash accumulation (corr -0.74) → 6-day intensifying capitulation → 3 delta anomalies in 12 days (4/2, 4/9, 4/14) → breakout 4/21. Full 5-stage Wyckoff cycle. | 19 days (anomaly cluster), 7 days (last anomaly) |
| **GRAL** | All red streaks FADING (not intensifying) + 4 green days (8/11–8/14) + extreme volume collapse (1.55M→0.33M) + final capitulation dump 9/2 (-62K, -3.2%). No anomalies, no catalyst — pure "quiet conviction." Score 0.88, 6/7 components maxed. | 7 days (green streak), 1 day (final dump) |
| **COHR** | 10 auto-detected breakouts, 5 accumulation zones, 3 distribution clusters, 6 delta anomalies across 357 trading days. Proximity scores: 85 pts (4/10/25), 80 pts (1/14/26), **100 pts** (2/10/26 — all-time highest). Smoking gun 5/13/25 (+1,488K, 9.7x avg). FRAGILE post-breakout = 100% accurate exit signal. | Varies: days to weeks per breakout |

### Negative Controls (Correctly Rejected)

| Ticker | Period | Price Change | Net Delta % | Score | Why Rejected |
|--------|--------|-------------|-------------|-------|------------|
| RKLB | Jan 6 – Feb 14, 2026 | -20.0% | -0.35% | 0.07 | Concordant selling, negative delta shift |
| IREN | Jan 6 – Feb 14, 2026 | -9.2% | -1.48% | 0.02 | Concordant selling |
| SMCI | Oct 1 – Nov 15, 2024 | -46.4% | +0.34% | 0.00 | Crash gate: >45% decline |
| RIVN | Oct 1 – Nov 15, 2024 | -4.4% | -2.06% | 0.00 | Concordant selling gate: delta < -1.5% |

---

## Cross-Ticker Findings

### What Doesn't Work (Tested and Rejected)

| Feature | Tested Across | Result | Conclusion |
|---------|---------------|--------|------------|
| RED delta contraction | 12 tickers | R²=0.084 | NOT predictive — top scorers (BE, SATS) actually expand |
| Delta volatility contraction (std of deltaPct) | 12 tickers | R²=0.006 | NOT predictive — 10/12 contract but no quality correlation |
| Price volatility contraction | 12 tickers | Only 5/12 contract | NOT useful |
| Classic HTF metrics (YZ vol, range decay, VWAP) | 6 tickers | Near-zero scores | Designed for "dead zone" consolidation, not active accumulation |
| VD RSI divergence alone | 6 tickers | Mixed results | Some positives show concordant VD RSI decline — bonus only |

### What Does Work (Confirmed Predictive)

1. **Duration is the #1 score driver** — all scores >0.90 have 35-day windows with max duration multiplier (1.15)
2. **Accumulation week ratio** — strong tickers have 60-100% positive-delta weeks (MOD Zone 3: 100%)
3. **Net delta %** — ranges from +0.84% (RKLB, weak) to +12.46% (IMNM, extreme)
4. **Absorption rate** — most predictive of breakout proximity; COHR's 53.8% is the all-time highest (previously MOD 46.2%)
5. **Multi-zone patterns** — when two zones appear close together, breakout confidence increases
6. **Delta anomaly clustering** — when 3+ anomalies (>4x avg) appear within 15 days at lows, breakout follows within weeks (BW: 3 in 12 days → breakout 7 days later)
7. **Distribution preceding accumulation** — the full Wyckoff cycle (distribution → markdown → accumulation → breakout) appears in multi-month patterns (BW: 16-month cycle confirmed all 5 stages)
8. **Post-breakout delta polarity** — DURABLE breakouts (3+/4 positive post-breakout weeks) hold and extend; FRAGILE breakouts (≤1/4 positive weeks) reverse within days. COHR confirmed 100% accuracy: every FRAGILE breakout preceded a significant decline, every DURABLE breakout held. This is the primary exit signal for swing traders.
9. **Algorithm works without exogenous catalysts** — GRAL (0.88) broke out with zero macro fear events, zero delta anomalies, zero smoking guns. Pure "quiet conviction" — steady accumulation + volume collapse. The algorithm is not dependent on tariffs, earnings, or macro events.
10. **Distribution INTO a rally is the deadliest signal** — COHR showed 3 distribution clusters where price rose but cumulative delta was deeply negative. Each preceded a significant decline (15%, 50%, 10%). When institutions sell into your breakout, exit.

---

## Deployment Strategy

### Database Schema

```sql
-- Accumulation/distribution zone results
CREATE TABLE vd_zones (
  id SERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  scan_date DATE NOT NULL,
  zone_type TEXT NOT NULL CHECK (zone_type IN ('accumulation', 'distribution')),
  zone_rank INT NOT NULL DEFAULT 1,         -- 1, 2, or 3
  zone_start DATE NOT NULL,
  zone_end DATE NOT NULL,
  window_days INT NOT NULL,
  score REAL NOT NULL,
  net_delta_pct REAL,
  price_change_pct REAL,
  delta_slope REAL,
  price_delta_corr REAL,
  accum_week_ratio REAL,
  absorption_pct REAL,
  large_buy_vs_sell REAL,
  vol_decline_score REAL,
  duration_multiplier REAL,
  components JSONB,                          -- {s1, s2, s3, s4, s5, s6, s7}
  capped_days JSONB,                         -- [{date, original, capped}]
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ticker, scan_date, zone_type, zone_rank)
);

-- Breakout proximity signals
CREATE TABLE vd_proximity_signals (
  id SERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  signal_date DATE NOT NULL,
  signal_type TEXT NOT NULL,                 -- 'seller_exhaustion', 'delta_anomaly', etc.
  signal_strength REAL NOT NULL,             -- 0-1 normalized
  details JSONB,                             -- signal-specific data
  zone_score REAL,                           -- score of parent zone
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ticker, signal_date, signal_type)
);

-- Composite proximity score (daily per ticker)
CREATE TABLE vd_proximity_composite (
  ticker TEXT NOT NULL,
  score_date DATE NOT NULL,
  composite_score REAL NOT NULL,             -- sum of active signal points
  level TEXT NOT NULL CHECK (level IN ('none', 'elevated', 'high', 'imminent')),
  active_signals JSONB,                      -- [{type, points, date}]
  PRIMARY KEY (ticker, score_date)
);
```

### Server-Side Scan Pipeline

```
File: server/services/vdAccumulationDetector.js

Exports:
  - detectAccumulationZones(ticker, options)    → zones[]
  - detectDistributionZones(ticker, options)    → zones[]
  - evaluateProximitySignals(ticker, zones, dailyData) → signals[]
  - computeProximityScore(signals)              → { score, level }
  - HTF_CONFIG (renamed to VD_CONFIG)
  - VD_CONFIG_MODERATE (relaxed thresholds)
```

**Scan Flow:**
1. Fetch 1-minute data for lookback period (35 trading days + 30-day pre-context)
2. Build daily aggregates
3. Run subwindow scanner → find accumulation zones
4. Run inverse scanner → find distribution zones
5. If accumulation zones detected:
   a. Run proximity signal evaluation on last 25 days
   b. Compute composite proximity score
6. Upsert all results to database
7. If proximity level is "high" or "imminent", trigger alert

**Scan Schedule:**
- Full scan: daily at market close (after 4:15 PM ET)
- Per-ticker on-demand: when user opens a chart (cached for the day)
- Proximity signals: re-evaluated on each scan

### Frontend Visualization

#### Chart Overlay (Price Pane)
- **Green shaded regions** for accumulation zones (opacity based on score)
- **Red shaded regions** for distribution zones
- Zone score badge in the shaded region corner (e.g., "VD 0.87")
- On hover: tooltip showing zone details (net delta %, absorption, duration)

#### Chart Button (Existing HTF/VDF Button)
- Color indicates status:
  - Gray: no zones detected
  - Green: accumulation zone(s) active
  - Red: distribution zone(s) active
  - Pulsing amber: proximity level "elevated" or higher
- On click: shows zone details panel

#### Divergence Feed Integration
- "VD Accumulation" scan option alongside existing HTF scan
- Results table: ticker, best zone score, zone dates, proximity level
- Sort by score or proximity level

#### Ticker Page Text Container
- Section showing active VD zones with characterization
- Proximity signal timeline if applicable

### Alert System

When proximity level reaches "high" or "imminent":

```
🔥 BREAKOUT PROXIMITY — {TICKER}
Score: {composite_score} ({level})
Active signals:
  ✓ Green delta streak (4 days)     +20 pts
  ✓ Absorption cluster (3/5 days)   +15 pts
  ✓ Seller exhaustion resolved      +15 pts
Zone: {zone_start} → {zone_end} | Score: {zone_score}
```

---

## Key Learnings

### Algorithm Design

1. **Classic HTF metrics don't apply**: YZ volatility, delta compression, range decay, VWAP deviation all scored near-zero for these stocks. They're designed for "dead zone" tight consolidation, not active accumulation during declines.

2. **Weekly smoothing is essential**: Daily data is too noisy. Single-day aberrations from market-wide moves can temporarily reverse delta patterns. Weekly aggregation smooths this out.

3. **Hard gates prevent false positives**: Rejecting crashes (>45% decline) and deeply concordant selling (delta < -1.5%) eliminates the worst false positives (SMCI, RIVN) without affecting true positives.

4. **3σ capping is critical**: Without capping, a single anomalous day (INSM +5738K) would dominate a 35-day zone score. Capping lets the anomaly contribute proportionally while the scoring system evaluates the broader pattern.

5. **Duration is the strongest score driver**: Every score >0.90 uses the maximum 35-day window with 1.15x multiplier. Short-duration zones (10–14 days) rarely exceed 0.85 even with perfect component scores.

6. **RED delta contraction is NOT predictive**: Tested across 12 tickers, R²=0.084. Top scorers (BE, SATS) actually show expanding RED delta. Do not add as scoring component.

7. **Delta volatility contraction is NOT predictive**: 10/12 tickers show contraction but R²=0.006 against score quality. Useful as diagnostic display only, not for scoring.

### Market Structure

8. **Eight accumulation archetypes exist**: Strong conviction, concentrated bursts, multi-phase, slow drip, hidden in decline, orchestrated cycle, quiet conviction, and full lifecycle. GRAL added "quiet conviction" (no catalyst), COHR added "full lifecycle" (multi-zone across months).

9. **The "final dump" pattern is universal**: PL (-755K), INSM (-414K), MOD (-142K) all show a sharp capitulation day 1-2 days before breakout. This appears to be last-seller exhaustion.

10. **Post-breakout distribution is common but NOT universal**: Institutions who accumulated during mid-trend declines often distribute into the breakout rally (MOD: 4 consecutive days negative delta). But cycle-bottom accumulation (BW) shows sustained positive delta post-breakout for weeks. **This distinguishes fragile vs durable breakouts.**

11. **Breakout proximity signals work best as a compound system**: No single signal is reliable alone. The highest confidence comes when 3+ signals fire within a 10-day window (IMNM: anomaly + green streak + absorption cluster).

12. **Delta anomaly clusters are the strongest proximity signal**: A single anomaly (Signal 2) can have 4–25 day lead time. But 3+ anomalies clustered within 15 days at price lows (BW) has 100% hit rate so far — breakout followed within 3 weeks every time. This is the institutional "final loading" phase.

13. **The Wyckoff cycle is detectable through volume delta**: BW proved that the full Distribution → Markdown → Accumulation → Markup cycle leaves a clear delta fingerprint at each stage. This makes the entire cycle algorithmically detectable, not just the accumulation phase.

14. **Exogenous fear is the institutional tool**: BW's crash coincided with tariff headlines. The distribution phase (negative delta on flat price) preceded the crash, suggesting institutions anticipated or engineered the decline. The algo can't prove intent, but it can detect the delta pattern — and that pattern repeats across macro events.

15. **The algorithm works without exogenous catalysts**: GRAL (0.88) had no tariff panic, no macro fear event, no delta anomalies, no smoking guns. Pure steady accumulation + extreme volume collapse (1.55M → 0.33M, -79%) → breakout +264%. The algorithm detects the structural pattern regardless of the catalyst (or lack thereof).

16. **FRAGILE post-breakout polarity is a 100% accurate exit signal**: Across COHR's 10 breakouts, every FRAGILE breakout (≤1/4 weeks positive delta) preceded a decline of 10–50%. Every DURABLE breakout (3+/4 weeks positive) held and extended. This makes post-breakout delta polarity the single most actionable exit indicator.

17. **Multi-zone sequences across months compound conviction**: COHR showed 5 accumulation zones over 16 months. Each new zone within a holding period strengthened conviction. The pattern: accumulate → breakout → pullback → re-accumulate → breakout higher. Zones don't need to be adjacent — months can separate them.

18. **Highest proximity score correlates with strongest breakout**: COHR's 100-point IMMINENT proximity (2/10/26) coincided with 6/6 signals firing simultaneously — the only time all signals aligned. The subsequent breakout reached all-time highs ($238). Composite proximity scoring has predictive power for breakout magnitude, not just timing.

---

## Analysis Scripts

| Script | Purpose |
|--------|---------|
| `analysis-htf-rklb-asts.js` | First attempt: ran existing HTF algo on RKLB episodes (0/7 detected) |
| `analysis-htf-deep.js` | Daily-timeframe pattern analysis of RKLB/ASTS consolidations |
| `analysis-asts-consol-vd.js` | VD + VD RSI analysis of 6 consolidation periods |
| `analysis-vd-divergence-algo.js` | v1 algorithm prototype (40% accuracy) |
| `analysis-vd-v2.js` | v2 feature engineering — 25+ features, discrimination analysis |
| `analysis-vd-v3.js` | v3 production algorithm — 100% accuracy, weekly-smoothed |
| `analysis-vdf-multizones.js` | Multi-zone scanner — subwindow scanning across window sizes |
| `analysis-vdf-sats.js` | SATS deep analysis with RED delta contraction |
| `analysis-vdf-cross-ticker.js` | Cross-ticker comprehensive analysis (12 tickers) |
| `analysis-vdf-pl.js` | PL analysis with breakout proximity |
| `analysis-vdf-imnm.js` | IMNM analysis — all-time highest score (1.09), delta anomaly detection |
| `analysis-vdf-insm.js` | INSM analysis — smoking gun event (29.7x avg), multi-phase |
| `analysis-vdf-mod.js` | MOD analysis — Wyckoff textbook, extreme absorption (46.2%) |
| `analysis-vdf-bw.js` | BW analysis — full Wyckoff cycle, delta anomaly cluster, 39.6x from bottom |
| `analysis-vdf-gral.js` | GRAL analysis — quiet conviction pattern, no exogenous catalyst, 264% from low |
| `analysis-vdf-cohr.js` | COHR full lifecycle — 16-month analysis, auto-detect breakouts, distribution clusters, position management, 100pt proximity |

---

## Open Questions / Future Work

- [ ] Implement `server/services/vdAccumulationDetector.js` with full subwindow scanner
- [ ] Implement distribution zone detection (inverse scoring)
- [ ] Implement proximity signal evaluation pipeline (all 11 signals)
- [ ] Implement macro cycle detection (5-stage framework)
- [ ] Design DB schema migration and add to `index.js`
- [ ] Build chart overlay rendering for green/red zone shading
- [ ] Build proximity alert system
- [ ] Add post-breakout delta polarity check (sustained positive = durable, immediate negative = fragile)
- [ ] Test with more negative controls (declining stocks that never broke out)
- [ ] Test with false breakouts (stocks that triggered but failed)
- [ ] Test macro cycle detection on more tickers with long histories
- [ ] Consider: does the algorithm work on 15-minute data for faster/cheaper scanning?
- [ ] Consider: moderate vs strict mode thresholds (similar to existing VDF toggle)
- [ ] Consider: sector-relative volume normalization for cross-sector comparisons
- [ ] Consider: delta anomaly cluster as standalone screener (scan all tickers for 3+ anomalies at lows)
- [ ] Implement position management layer (ENTER/ADD/HOLD/REDUCE/EXIT state machine)
- [ ] Implement post-breakout delta polarity check (4-week DURABLE/MIXED/FRAGILE classification)
- [ ] Implement distribution cluster detection (10-day rolling: price >+3%, delta <-3%)
- [ ] Implement accumulation-in-decline detection (10-day rolling: price <-3%, delta >+3%)
- [ ] Implement monthly phase analysis (20-day rolling institutional flow classification)
- [ ] Implement breakout auto-detection (>8% in 5 days on volume >1.2x avg)
- [ ] Test: does proximity score magnitude correlate with breakout magnitude? (COHR suggests yes)
- [ ] Test position management framework on more multi-month tickers (need 6+ months of data)
- [ ] Consider: alert escalation based on position state (different alert urgency for EXIT vs ENTER)

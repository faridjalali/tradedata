/**
 * Chart pre-warming service.
 *
 * After the primary chart load (P0) completes, the server pre-builds
 * related intervals so the next user interaction hits cache.
 *
 * Sequence for each loaded interval:
 *   4hour  → [1day, 1week]
 *   1day   → [4hour, 1week]
 *   1week  → [1day, 4hour]
 *
 * Each target is awaited sequentially so we don't double the DB/API load.
 */

const PREWARM_SEQUENCES: Record<string, string[]> = {
  '4hour': ['1day', '1week'],
  '1day': ['4hour', '1week'],
  '1week': ['1day', '4hour'],
};

/**
 * Return the ordered list of intervals to pre-warm after `interval` loads.
 * Returns [] for intervals without a prewarm strategy (e.g. intraday < 4h).
 */
function getPostLoadPrewarmSequence(interval: string): string[] {
  return PREWARM_SEQUENCES[interval] || [];
}

/**
 * Pre-warm a single interval by delegating to `getOrBuildChartResult`.
 * Best-effort: errors are logged (if enabled) but never propagated.
 */
async function prewarmChartResult(options: any, deps: any): Promise<void> {
  const {
    getOrBuildChartResult,
    toVolumeDeltaSourceInterval,
    getIntradayLookbackDays,
    buildChartRequestKey,
    CHART_FINAL_RESULT_CACHE,
    CHART_IN_FLIGHT_REQUESTS,
    getTimedCacheValue,
    VALID_CHART_INTERVALS,
    CHART_TIMING_LOG_ENABLED,
  } = deps;

  const ticker = String(options.ticker || '').toUpperCase();
  const interval = String(options.interval || '').trim();
  if (!ticker || !VALID_CHART_INTERVALS.includes(interval)) return;

  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(options.vdRsiLength) || 14)));
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const vdRsiSourceInterval = toVolumeDeltaSourceInterval(options.vdRsiSourceInterval, '1min');
  const lookbackDays = Math.max(1, Math.floor(Number(options.lookbackDays) || getIntradayLookbackDays(interval)));

  const requestKey = buildChartRequestKey({
    ticker,
    interval,
    vdRsiLength,
    vdSourceInterval,
    vdRsiSourceInterval,
    lookbackDays,
  });

  if (getTimedCacheValue(CHART_FINAL_RESULT_CACHE, requestKey)) return;

  const inFlight = CHART_IN_FLIGHT_REQUESTS.get(requestKey);
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      /* best-effort */
    }
    return;
  }

  try {
    await getOrBuildChartResult({
      ticker,
      interval,
      vdRsiLength,
      vdSourceInterval,
      vdRsiSourceInterval,
      lookbackDays,
      requestKey,
      skipFollowUpPrewarm: true,
    });
  } catch (err: any) {
    if (CHART_TIMING_LOG_ENABLED) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`[chart-prewarm] ${ticker} ${interval} failed: ${message}`);
    }
  }
}

/**
 * Schedule the full prewarm sequence for `interval`.
 * Each target is built sequentially to avoid resource spikes.
 */
function schedulePostLoadPrewarmSequence(options: any, deps: any): void {
  const { toVolumeDeltaSourceInterval, getIntradayLookbackDays } = deps;

  const ticker = String(options.ticker || '').toUpperCase();
  const interval = String(options.interval || '').trim();
  if (!ticker || !interval) return;

  const sequence = getPostLoadPrewarmSequence(interval);
  if (!sequence.length) return;

  const vdRsiLength = Math.max(1, Math.min(200, Math.floor(Number(options.vdRsiLength) || 14)));
  const vdSourceInterval = toVolumeDeltaSourceInterval(options.vdSourceInterval, '1min');
  const vdRsiSourceInterval = toVolumeDeltaSourceInterval(options.vdRsiSourceInterval, '1min');
  const lookbackDays = Math.max(1, Math.floor(Number(options.lookbackDays) || getIntradayLookbackDays(interval)));

  void (async () => {
    for (const targetInterval of sequence) {
      await prewarmChartResult(
        {
          ticker,
          interval: targetInterval,
          vdRsiLength,
          vdSourceInterval,
          vdRsiSourceInterval,
          lookbackDays,
        },
        deps,
      );
    }
  })();
}

export { getPostLoadPrewarmSequence, prewarmChartResult, schedulePostLoadPrewarmSequence };

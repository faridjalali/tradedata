import { isAbortError } from '../services/dataApi.js';
import { DIVERGENCE_TABLE_BUILD_CONCURRENCY } from '../config.js';

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (result: R | { error: unknown }, index: number, item: T) => void,
  shouldStop?: () => boolean,
): Promise<Array<R | { error: unknown }>> {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const maxConcurrency = Math.max(1, Math.min(list.length, Number(concurrency) || 1));
  const results = new Array<R | { error: unknown }>(list.length);
  let cursor = 0;
  let cancelled = false;
  let cancelResolve: (() => void) | null = null;
  const cancelPromise = new Promise<void>((resolve) => {
    cancelResolve = resolve;
  });

  async function runOneWorker() {
    while (cursor < list.length) {
      if (cancelled) break;
      if (typeof shouldStop === 'function') {
        try {
          if (shouldStop()) {
            if (!cancelled) {
              cancelled = true;
              cursor = list.length;
              cancelResolve!();
            }
            break;
          }
        } catch {
          // Ignore stop-check callback errors and continue processing.
        }
      }
      const currentIndex = cursor;
      cursor += 1;
      try {
        results[currentIndex] = await worker(list[currentIndex], currentIndex);
      } catch (err: unknown) {
        results[currentIndex] = { error: err };
        if (isAbortError(err) && typeof shouldStop === 'function') {
          try {
            if (shouldStop()) {
              if (!cancelled) {
                cancelled = true;
                cursor = list.length;
                cancelResolve!();
              }
              break;
            }
          } catch {
            // Ignore stop-check callback errors.
          }
        }
      } finally {
        if (typeof onSettled === 'function') {
          try {
            onSettled(results[currentIndex], currentIndex, list[currentIndex]);
          } catch {
            // Best-effort callback for progress reporting.
          }
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < maxConcurrency; i++) {
    workers.push(runOneWorker());
  }
  await Promise.race([Promise.all(workers), cancelPromise]);
  // After cancel, wait for all in-flight workers to finish their current item
  // so callers can safely access shared state (buffers, counters) without races.
  if (cancelled) {
    await Promise.allSettled(workers);
  }
  return results;
}

export function resolveAdaptiveFetchConcurrency(runType = 'fetch-daily') {
  const configured = Math.max(1, Number(DIVERGENCE_TABLE_BUILD_CONCURRENCY) || 1);
  const maxRps = Math.max(1, Number(process.env.DATA_API_MAX_REQUESTS_PER_SECOND) || 99);
  const estimatedApiCallsPerTicker = runType === 'fetch-weekly' ? 10 : 8;
  const targetTickersPerSecond = Math.max(1, Math.floor(maxRps / estimatedApiCallsPerTicker));
  const adaptive = Math.max(4, targetTickersPerSecond * 4);
  return Math.max(1, Math.min(configured, adaptive));
}

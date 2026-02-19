import test from 'node:test';
import assert from 'node:assert/strict';

import { ScanState, runRetryPasses } from '../server/lib/ScanState.js';

// ---------------------------------------------------------------------------
// ScanState — initial state
// ---------------------------------------------------------------------------

test('ScanState initial state has expected defaults', () => {
  const s = new ScanState('testScan');
  assert.equal(s.name, 'testScan');
  assert.equal(s.metricsKey, 'testScan');
  assert.equal(s.isRunning, false);
  assert.equal(s.isStopping, false);
  assert.equal(s.shouldStop, false);
  assert.equal(s.signal, null);
  assert.equal(s.currentResumeState, null);
  const status = s.readStatus();
  assert.equal(status.running, false);
  assert.equal(status.status, 'idle');
  assert.equal(status.totalTickers, 0);
  assert.equal(status.processedTickers, 0);
  assert.equal(status.errorTickers, 0);
  assert.equal(status.startedAt, null);
  assert.equal(status.finishedAt, null);
});

test('ScanState metricsKey falls back to name', () => {
  const s = new ScanState('myScan', {});
  assert.equal(s.metricsKey, 'myScan');
});

test('ScanState metricsKey uses provided option', () => {
  const s = new ScanState('myScan', { metricsKey: 'custom' });
  assert.equal(s.metricsKey, 'custom');
});

// ---------------------------------------------------------------------------
// beginRun
// ---------------------------------------------------------------------------

test('beginRun returns an AbortController and sets isRunning', () => {
  const s = new ScanState('s');
  const ac = s.beginRun();
  assert.ok(ac instanceof AbortController);
  assert.equal(s.isRunning, true);
  assert.equal(s.isStopping, false);
  assert.equal(s.signal, ac.signal);
});

test('beginRun clears resumeState when not resuming', () => {
  const s = new ScanState('s');
  s.setResumeState({ tickers: ['AAPL'], nextIndex: 0, totalTickers: 1 });
  s.beginRun(false);
  assert.equal(s.currentResumeState, null);
});

test('beginRun preserves resumeState when resuming', () => {
  const s = new ScanState('s');
  const rs = { tickers: ['AAPL'], nextIndex: 0, totalTickers: 1 };
  s.setResumeState(rs);
  s.beginRun(true);
  assert.deepEqual(s.currentResumeState, rs);
});

test('beginRun resets stop flag', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.requestStop();
  assert.equal(s.isStopping, true);
  // start a new run
  s.cleanup();
  s.beginRun();
  assert.equal(s.isStopping, false);
});

// ---------------------------------------------------------------------------
// setStatus / replaceStatus / readStatus
// ---------------------------------------------------------------------------

test('setStatus merges into existing status', () => {
  const s = new ScanState('s');
  s.setStatus({ totalTickers: 100, status: 'running' });
  const st = s.readStatus();
  assert.equal(st.totalTickers, 100);
  assert.equal(st.status, 'running');
  assert.equal(st.running, false); // preserved from initial
});

test('setStatus is non-destructive for unspecified fields', () => {
  const s = new ScanState('s');
  s.setStatus({ totalTickers: 50 });
  s.setStatus({ processedTickers: 10 });
  const st = s.readStatus();
  assert.equal(st.totalTickers, 50);
  assert.equal(st.processedTickers, 10);
});

test('replaceStatus fully replaces the status object', () => {
  const s = new ScanState('s');
  s.setStatus({ totalTickers: 100 });
  s.replaceStatus({ running: false, status: 'stopped' });
  const st = s.readStatus();
  assert.equal(st.status, 'stopped');
  assert.equal(st.running, false);
  assert.equal(st.totalTickers, undefined); // was replaced, not merged
});

test('readStatus returns a snapshot (mutation does not affect internal state)', () => {
  const s = new ScanState('s');
  const snap = s.readStatus() as Record<string, any>;
  snap['hacked'] = true;
  assert.equal((s.readStatus() as any)['hacked'], undefined);
});

// ---------------------------------------------------------------------------
// shouldStop
// ---------------------------------------------------------------------------

test('shouldStop is true after requestStop', () => {
  const s = new ScanState('s');
  s.beginRun();
  assert.equal(s.shouldStop, false);
  s.requestStop();
  assert.equal(s.shouldStop, true);
});

test('shouldStop is true if AbortController is externally aborted', () => {
  const s = new ScanState('s');
  const ac = s.beginRun();
  ac.abort();
  assert.equal(s.shouldStop, true);
});

test('shouldStop is false before beginRun', () => {
  const s = new ScanState('s');
  assert.equal(s.shouldStop, false);
});

// ---------------------------------------------------------------------------
// requestStop
// ---------------------------------------------------------------------------

test('requestStop returns false if not running', () => {
  const s = new ScanState('s');
  const result = s.requestStop();
  assert.equal(result, false);
  assert.equal(s.isStopping, false);
});

test('requestStop returns true if running and aborts the controller', () => {
  const s = new ScanState('s');
  const ac = s.beginRun();
  const result = s.requestStop();
  assert.equal(result, true);
  assert.equal(s.isStopping, true);
  assert.equal(ac.signal.aborted, true);
});

test('requestStop sets status to stopping', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.setStatus({ status: 'running' });
  s.requestStop();
  assert.equal(s.readStatus().status, 'stopping');
});

// ---------------------------------------------------------------------------
// updateProgress
// ---------------------------------------------------------------------------

test('updateProgress sets processed and error counts', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.updateProgress(42, 3);
  const st = s.readStatus();
  assert.equal(st.processedTickers, 42);
  assert.equal(st.errorTickers, 3);
});

test('updateProgress sets status to stopping when stop is requested', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.setStatus({ status: 'running' });
  s.requestStop();
  s.updateProgress(10, 0);
  assert.equal(s.readStatus().status, 'stopping');
});

// ---------------------------------------------------------------------------
// markStopped / markCompleted / markFailed
// ---------------------------------------------------------------------------

test('markStopped sets status to stopped and clears stop flag', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.requestStop();
  s.markStopped({ processedTickers: 5 });
  assert.equal(s.isStopping, false);
  assert.equal(s.readStatus().status, 'stopped');
  assert.equal(s.readStatus().running, false);
  assert.equal(s.readStatus().processedTickers, 5);
});

test('markCompleted clears resumeState and sets completed status', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.setResumeState({ tickers: ['X'], nextIndex: 0, totalTickers: 1 });
  s.markCompleted({ processedTickers: 10, errorTickers: 0 });
  assert.equal(s.currentResumeState, null);
  assert.equal(s.readStatus().status, 'completed');
  assert.equal(s.readStatus().running, false);
});

test('markCompleted sets completed-with-errors when errorTickers > 0', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.markCompleted({ processedTickers: 10, errorTickers: 2 });
  assert.equal(s.readStatus().status, 'completed-with-errors');
});

test('markFailed clears resumeState and sets failed status', () => {
  const s = new ScanState('s');
  s.beginRun();
  s.setResumeState({ tickers: ['X'], nextIndex: 0, totalTickers: 1 });
  s.markFailed({ processedTickers: 3 });
  assert.equal(s.currentResumeState, null);
  assert.equal(s.readStatus().status, 'failed');
  assert.equal(s.readStatus().running, false);
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

test('cleanup clears isRunning', () => {
  const s = new ScanState('s');
  s.beginRun();
  assert.equal(s.isRunning, true);
  s.cleanup();
  assert.equal(s.isRunning, false);
});

test('cleanup with matching ref clears the AbortController', () => {
  const s = new ScanState('s');
  const ac = s.beginRun();
  s.cleanup(ac);
  assert.equal(s.signal, null);
  assert.equal(s.isRunning, false);
});

test('cleanup with non-matching ref does not clear AbortController', () => {
  const s = new ScanState('s');
  s.beginRun();
  const otherAc = new AbortController();
  s.cleanup(otherAc);
  // signal should still be set (different ref)
  assert.notEqual(s.signal, null);
  assert.equal(s.isRunning, false);
});

// ---------------------------------------------------------------------------
// saveResumeState
// ---------------------------------------------------------------------------

test('saveResumeState computes safe nextIndex', () => {
  const s = new ScanState('s');
  const tickers = ['A', 'B', 'C', 'D', 'E'];
  const safe = s.saveResumeState({ tickers, totalTickers: 5, processedTickers: 4 }, 2);
  // safeNext = max(0, min(5, 4 - 2)) = max(0, 2) = 2
  assert.equal(safe, 2);
  const rs = s.currentResumeState!;
  assert.equal(rs.nextIndex, 2);
  assert.equal(rs.processedTickers, 2);
});

test('saveResumeState applies normalizeResume if provided', () => {
  const s = new ScanState('s', {
    normalizeResume: (data) => ({ ...data, normalized: true }),
  });
  s.saveResumeState({ tickers: ['X'], totalTickers: 1, processedTickers: 0 }, 0);
  assert.equal(s.currentResumeState?.normalized, true);
});

test('saveResumeState clamps nextIndex to 0 when processedTickers < concurrency', () => {
  const s = new ScanState('s');
  const safe = s.saveResumeState({ tickers: ['A'], totalTickers: 1, processedTickers: 1 }, 5);
  // max(0, min(1, 1 - 5)) = max(0, -4) = 0
  assert.equal(safe, 0);
});

// ---------------------------------------------------------------------------
// canResume
// ---------------------------------------------------------------------------

test('canResume returns false when running', () => {
  const s = new ScanState('s');
  s.beginRun();
  assert.equal(s.canResume(), false);
});

test('canResume returns false with no resumeState', () => {
  const s = new ScanState('s');
  assert.equal(s.canResume(), false);
});

test('canResume uses default logic (tickers array with remaining items)', () => {
  const s = new ScanState('s');
  s.setResumeState({ tickers: ['A', 'B'], nextIndex: 1, totalTickers: 2 });
  assert.equal(s.canResume(), true);
  s.setResumeState({ tickers: ['A', 'B'], nextIndex: 2, totalTickers: 2 });
  assert.equal(s.canResume(), false); // nextIndex >= length
});

test('canResume uses canResumeValidator when provided', () => {
  const s = new ScanState('s', {
    canResumeValidator: (rs) => rs.custom === true,
  });
  s.setResumeState({ custom: false });
  assert.equal(s.canResume(), false);
  s.setResumeState({ custom: true });
  assert.equal(s.canResume(), true);
});

test('setCanResumeValidator wires validator after construction', () => {
  const s = new ScanState('s');
  s.setResumeState({ magic: 42 });
  s.setCanResumeValidator((rs) => rs.magic === 42);
  assert.equal(s.canResume(), true);
});

test('setNormalizeResume is used by canResume default path', () => {
  const s = new ScanState('s');
  s.setNormalizeResume((data) => ({
    tickers: data.items || [],
    nextIndex: data.cursor || 0,
  }));
  s.setResumeState({ items: ['A', 'B'], cursor: 1 });
  assert.equal(s.canResume(), true);
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('getStatus returns expected shape', () => {
  const s = new ScanState('s');
  const st = s.getStatus();
  assert.equal(typeof st.running, 'boolean');
  assert.equal(typeof st.stop_requested, 'boolean');
  assert.equal(typeof st.can_resume, 'boolean');
  assert.equal(typeof st.status, 'string');
  assert.equal(typeof st.total_tickers, 'number');
  assert.equal(typeof st.processed_tickers, 'number');
  assert.equal(typeof st.error_tickers, 'number');
});

test('getStatus includes extra status fields', () => {
  const s = new ScanState('s');
  s.setExtraStatus({ detected_tickers: 7, last_published_trade_date: '2026-01-15' });
  const st = s.getStatus();
  assert.equal(st.detected_tickers, 7);
  assert.equal(st.last_published_trade_date, '2026-01-15');
});

// ---------------------------------------------------------------------------
// buildRouteOptions
// ---------------------------------------------------------------------------

test('buildRouteOptions returns object with correct methods', () => {
  const s = new ScanState('s');
  const runFn = async () => ({ status: 'done' });
  const opts = s.buildRouteOptions(runFn);
  assert.equal(typeof opts.getStatus, 'function');
  assert.equal(typeof opts.requestStop, 'function');
  assert.equal(typeof opts.canResume, 'function');
  assert.equal(typeof opts.run, 'function');
  assert.equal(typeof opts.getIsRunning, 'function');
  assert.equal(opts.getIsRunning(), false);
});

// ---------------------------------------------------------------------------
// runRetryPasses
// ---------------------------------------------------------------------------

/** Simple synchronous mapWithConcurrency shim for tests. */
async function fakeMapWithConcurrency<T, R>(
  items: T[],
  _concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (result: R | { error: unknown }, index: number, item: T) => void,
  shouldStop?: () => boolean,
): Promise<Array<R | { error: unknown }>> {
  const results: Array<R | { error: unknown }> = [];
  for (let i = 0; i < items.length; i++) {
    if (shouldStop?.()) break;
    let result: R | { error: unknown };
    try {
      result = await worker(items[i], i);
    } catch (err) {
      result = { error: err };
    }
    results.push(result);
    onSettled?.(result, i, items[i]);
  }
  return results;
}

test('runRetryPasses returns empty array for empty input', async () => {
  const result = await runRetryPasses({
    failedTickers: [],
    baseConcurrency: 4,
    worker: async () => ({ ticker: 'X' }),
    mapWithConcurrency: fakeMapWithConcurrency,
  });
  assert.deepEqual(result, []);
});

test('runRetryPasses recovers tickers that succeed on retry', async () => {
  const recovered: string[] = [];
  const callCounts: Record<string, number> = {};

  const result = await runRetryPasses({
    failedTickers: ['AAPL', 'MSFT'],
    baseConcurrency: 4,
    worker: async (ticker) => {
      callCounts[ticker] = (callCounts[ticker] || 0) + 1;
      return { ticker, result: { is_detected: false }, error: null };
    },
    onRecovered: (s) => recovered.push(s.ticker),
    mapWithConcurrency: fakeMapWithConcurrency,
  });

  assert.deepEqual(recovered.sort(), ['AAPL', 'MSFT']);
  assert.deepEqual(result, []); // none still failed
});

test('runRetryPasses runs pass 2 for still-failing tickers', async () => {
  const failOnFirstRetry = new Set(['FAIL']);
  let pass1Called = false;

  const result = await runRetryPasses({
    failedTickers: ['FAIL'],
    baseConcurrency: 4,
    worker: async (ticker) => {
      if (failOnFirstRetry.has(ticker) && !pass1Called) {
        pass1Called = true;
        return { ticker, result: null, error: new Error('retry 1 fail') };
      }
      return { ticker, result: {}, error: null };
    },
    mapWithConcurrency: fakeMapWithConcurrency,
  });

  assert.deepEqual(result, []); // recovered on pass 2
});

test('runRetryPasses passes correct reduced concurrency', async () => {
  const concurrencies: number[] = [];

  await runRetryPasses({
    failedTickers: ['A', 'B'],
    baseConcurrency: 8,
    worker: async (ticker) => ({ ticker, result: null, error: new Error('fail') }),
    mapWithConcurrency: async (items, concurrency, worker, onSettled, shouldStop) => {
      concurrencies.push(concurrency);
      return fakeMapWithConcurrency(items, concurrency, worker, onSettled, shouldStop);
    },
  });

  // pass 1: floor(8/2) = 4, pass 2: floor(8/4) = 2
  assert.equal(concurrencies[0], 4);
  assert.equal(concurrencies[1], 2);
});

test('runRetryPasses stops early when shouldStop returns true', async () => {
  let workerCalls = 0;

  await runRetryPasses({
    failedTickers: ['A', 'B', 'C'],
    baseConcurrency: 2,
    worker: async (ticker) => {
      workerCalls++;
      return { ticker, result: null, error: new Error('fail') };
    },
    shouldStop: () => true, // stop immediately
    mapWithConcurrency: fakeMapWithConcurrency,
  });

  assert.equal(workerCalls, 0);
});

test('runRetryPasses calls onRecovered for each recovered ticker', async () => {
  const recoveredTickers: string[] = [];

  await runRetryPasses({
    failedTickers: ['X', 'Y'],
    baseConcurrency: 2,
    worker: async (ticker) => ({ ticker, result: {}, error: null }),
    onRecovered: (s) => recoveredTickers.push(s.ticker),
    mapWithConcurrency: fakeMapWithConcurrency,
  });

  assert.deepEqual(recoveredTickers.sort(), ['X', 'Y']);
});

test('runRetryPasses sets metricsTracker phase and records recovered tickers', async () => {
  const phases: string[] = [];
  const recorded: string[] = [];
  const mockTracker = {
    setPhase: (p: string) => phases.push(p),
    recordRetryRecovered: (t: string) => recorded.push(t),
  };

  await runRetryPasses({
    failedTickers: ['A'],
    baseConcurrency: 4,
    worker: async (ticker) => ({ ticker, result: {}, error: null }),
    metricsTracker: mockTracker,
    mapWithConcurrency: fakeMapWithConcurrency,
  });

  assert.ok(phases.includes('retry'));
  assert.deepEqual(recorded, ['A']);
});

test('runRetryPasses returns still-failed tickers after both passes', async () => {
  const result = await runRetryPasses({
    failedTickers: ['ALWAYS_FAIL'],
    baseConcurrency: 4,
    worker: async (ticker) => ({ ticker, result: null, error: new Error('permanent') }),
    mapWithConcurrency: fakeMapWithConcurrency,
  });

  assert.deepEqual(result, ['ALWAYS_FAIL']);
});

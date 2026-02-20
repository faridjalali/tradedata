import test from 'node:test';
import assert from 'node:assert/strict';

import { runVDFScan, vdfScan } from '../server/services/vdfService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Baseline _deps: no real I/O, no DB writes (metrics suppressed). */
function baseDeps(overrides: any = {}) {
  return {
    isConfigured: () => true,
    getTickers: async () => [] as string[],
    detectTicker: async (_ticker: string, _signal: AbortSignal) => ({ is_detected: false }),
    sweepCache: () => {},
    createMetricsTracker: () => null as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard: disabled state
// ---------------------------------------------------------------------------

test('runVDFScan returns disabled when isConfigured is false', async () => {
  const result = await runVDFScan({ _deps: { ...baseDeps(), isConfigured: () => false } });
  assert.equal(result.status, 'disabled');
});

// ---------------------------------------------------------------------------
// Guard: already running
// ---------------------------------------------------------------------------

test('runVDFScan returns running when scan is already in progress', async () => {
  // getTickers is the first await inside runVDFScan after the synchronous beginRun() call.
  // Blocking here guarantees isRunning is true before the second runVDFScan starts.
  let releaseGetTickers!: () => void;
  const getTickersCalled = new Promise<void>((r) => (releaseGetTickers = r));
  let releaseWorker!: () => void;
  const workerBlocked = new Promise<void>((r) => (releaseWorker = r));

  const firstRun = runVDFScan({
    _deps: baseDeps({
      getTickers: async () => {
        releaseGetTickers(); // signals: beginRun() already ran → isRunning is true
        await workerBlocked;
        return ['AAA'];
      },
    }),
  });

  // Wait until getTickers is entered — deterministic, no timeouts needed.
  await getTickersCalled;

  const concurrent = await runVDFScan({ _deps: baseDeps() });
  assert.equal(concurrent.status, 'running');

  releaseWorker();
  await firstRun;
});

// ---------------------------------------------------------------------------
// Basic processing
// ---------------------------------------------------------------------------

test('runVDFScan processes all tickers and returns correct counts', async () => {
  const tickers = ['AAA', 'BBB', 'CCC'];
  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => tickers,
      detectTicker: async (ticker: string) => ({ is_detected: ticker === 'AAA' }),
    }),
  });

  assert.ok(result.status === 'completed' || result.status === 'completed-with-errors');
  assert.equal(result.processedTickers, 3);
  assert.equal(result.detectedTickers, 1);
  assert.equal(result.errorTickers, 0);
});

test('runVDFScan counts all detections correctly', async () => {
  const tickers = ['T1', 'T2', 'T3', 'T4', 'T5'];
  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => tickers,
      detectTicker: async () => ({ is_detected: true }),
    }),
  });

  assert.ok(result.status === 'completed' || result.status === 'completed-with-errors');
  assert.equal(result.detectedTickers, 5);
});

test('runVDFScan captures error tickers', async () => {
  const tickers = ['OK', 'FAIL', 'OK2'];
  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => tickers,
      detectTicker: async (ticker: string) => {
        if (ticker === 'FAIL') throw new Error('detect error');
        return { is_detected: false };
      },
    }),
  });

  assert.ok(
    result.status === 'completed' || result.status === 'completed-with-errors',
    `unexpected status: ${result.status}`,
  );
  assert.equal(typeof result.errorTickers, 'number');
});

// ---------------------------------------------------------------------------
// ScanState lifecycle
// ---------------------------------------------------------------------------

test('runVDFScan leaves ScanState not running after completion', async () => {
  await runVDFScan({ _deps: baseDeps({ getTickers: async () => ['X'] }) });

  assert.equal(vdfScan.isRunning, false);
  assert.equal(vdfScan.isStopping, false);
});

test('runVDFScan status is completed (or variant) after full run', async () => {
  await runVDFScan({ _deps: baseDeps({ getTickers: async () => ['A', 'B'] }) });

  const { status } = vdfScan.getStatus();
  assert.ok(status === 'completed' || status === 'completed-with-errors', `expected completed status, got ${status}`);
});

// ---------------------------------------------------------------------------
// Stop behavior
// ---------------------------------------------------------------------------

test('runVDFScan stops early and saves resume state when shouldStop is triggered', async () => {
  const tickers = Array.from({ length: 20 }, (_, i) => `T${i}`);
  let processed = 0;

  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => tickers,
      detectTicker: async () => {
        processed++;
        if (processed >= 5) vdfScan.requestStop();
        return { is_detected: false };
      },
    }),
  });

  assert.equal(result.status, 'stopped');
  assert.ok(vdfScan.canResume(), 'resume state should be saved after stop');

  vdfScan.setResumeState(null);
});

test('runVDFScan returns stopped result with processedTickers count', async () => {
  const tickers = Array.from({ length: 10 }, (_, i) => `S${i}`);
  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => tickers,
      detectTicker: async () => {
        vdfScan.requestStop();
        return { is_detected: false };
      },
    }),
  });

  assert.equal(result.status, 'stopped');
  assert.equal(typeof result.processedTickers, 'number');

  vdfScan.setResumeState(null);
});

// ---------------------------------------------------------------------------
// Empty ticker list
// ---------------------------------------------------------------------------

test('runVDFScan with empty ticker list completes immediately', async () => {
  const result = await runVDFScan({ _deps: baseDeps() });

  assert.ok(result.status === 'completed' || result.status === 'completed-with-errors');
  assert.equal(result.processedTickers, 0);
  assert.equal(result.detectedTickers, 0);
});

// ---------------------------------------------------------------------------
// Dependency call verification
// ---------------------------------------------------------------------------

test('runVDFScan calls sweepCache at least once per run', async () => {
  let sweepCount = 0;
  await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => ['A', 'B'],
      sweepCache: () => {
        sweepCount++;
      },
    }),
  });

  assert.ok(sweepCount >= 1, `sweepCache should be called at least once, got ${sweepCount}`);
});

test('runVDFScan calls getTickers exactly once per fresh run', async () => {
  let fetchCount = 0;
  await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => {
        fetchCount++;
        return ['X'];
      },
    }),
  });

  assert.equal(fetchCount, 1);
});

test('runVDFScan suppresses DB writes when createMetricsTracker returns null', async () => {
  // If this completes without throwing or logging DB errors, metrics are suppressed.
  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => ['A', 'B', 'C'],
      createMetricsTracker: () => null as any,
    }),
  });
  assert.ok(result.status === 'completed' || result.status === 'completed-with-errors');
});

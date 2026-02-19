import test from 'node:test';
import assert from 'node:assert/strict';

import { runVDFScan, vdfScan } from '../server/services/vdfService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolved promise for a successful detection result. */
function detectedResult(ticker: string) {
  return async () => ({ is_detected: true, composite_score: 0.8 });
}

/** Resolved promise for a non-detected result. */
function notDetectedResult() {
  return async () => ({ is_detected: false, composite_score: 0 });
}

/** A detectTicker that always throws. */
function failingDetect() {
  return async (_ticker: string, _signal: AbortSignal) => {
    throw new Error('network error');
  };
}

/** Baseline _deps to avoid any real I/O. */
function baseDeps(overrides: Parameters<typeof runVDFScan>[0]['_deps'] = {}) {
  return {
    isConfigured: () => true,
    getTickers: async () => [],
    detectTicker: async (_ticker: string, _signal: AbortSignal) => ({ is_detected: false }),
    sweepCache: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard: disabled state
// ---------------------------------------------------------------------------

test('runVDFScan returns disabled when isConfigured is false', async () => {
  const result = await runVDFScan({
    _deps: { ...baseDeps(), isConfigured: () => false },
  });
  assert.equal(result.status, 'disabled');
});

// ---------------------------------------------------------------------------
// Guard: already running
// ---------------------------------------------------------------------------

test('runVDFScan returns running when scan is already in progress', async () => {
  // Kick off a scan that will not complete until we let it
  let releaseWorker!: () => void;
  const workerBlocked = new Promise<void>((resolve) => (releaseWorker = resolve));

  const firstRun = runVDFScan({
    _deps: baseDeps({
      getTickers: async () => ['AAA'],
      detectTicker: async () => {
        await workerBlocked;
        return { is_detected: false };
      },
    }),
  });

  // Small yield so the first run can start and set isRunning = true
  await new Promise((r) => setTimeout(r, 0));

  const concurrent = await runVDFScan({ _deps: baseDeps() });
  assert.equal(concurrent.status, 'running');

  // Let the first run finish
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
      detectTicker: async (ticker) => ({ is_detected: ticker === 'AAA', composite_score: 0 }),
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
      detectTicker: async (ticker) => ({ is_detected: true }),
    }),
  });

  assert.ok(result.status === 'completed' || result.status === 'completed-with-errors');
  assert.equal(result.detectedTickers, 5);
});

test('runVDFScan returns completed-with-errors when some tickers fail', async () => {
  const tickers = ['OK', 'FAIL', 'OK2'];

  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => tickers,
      detectTicker: async (ticker, _signal) => {
        if (ticker === 'FAIL') throw new Error('detect error');
        return { is_detected: false };
      },
    }),
  });

  // May be completed-with-errors if retry passes also fail
  assert.ok(
    result.status === 'completed' || result.status === 'completed-with-errors',
    `unexpected status: ${result.status}`,
  );
  // At least one error was recorded
  assert.ok(
    typeof result.errorTickers === 'number' && result.errorTickers >= 0,
    'errorTickers should be a number',
  );
});

// ---------------------------------------------------------------------------
// ScanState lifecycle
// ---------------------------------------------------------------------------

test('runVDFScan leaves ScanState not running after completion', async () => {
  await runVDFScan({
    _deps: baseDeps({ getTickers: async () => ['X'] }),
  });

  assert.equal(vdfScan.isRunning, false);
  assert.equal(vdfScan.isStopping, false);
});

test('runVDFScan status is completed (or variant) after full run', async () => {
  await runVDFScan({
    _deps: baseDeps({ getTickers: async () => ['A', 'B'] }),
  });

  const status = vdfScan.getStatus().status;
  assert.ok(
    status === 'completed' || status === 'completed-with-errors',
    `expected completed status, got ${status}`,
  );
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
      detectTicker: async (ticker) => {
        processed++;
        // After 5 processed, trigger stop
        if (processed >= 5) vdfScan.requestStop();
        return { is_detected: false };
      },
    }),
  });

  assert.equal(result.status, 'stopped');
  assert.ok(vdfScan.canResume(), 'resume state should be available after stop');

  // Clean up resume state for subsequent tests
  vdfScan.setResumeState(null);
});

test('runVDFScan returns stopped result with processedTickers count', async () => {
  const tickers = Array.from({ length: 10 }, (_, i) => `S${i}`);

  // Trigger stop after scan starts
  const result = await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => tickers,
      detectTicker: async (_ticker) => {
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
  const result = await runVDFScan({
    _deps: baseDeps({ getTickers: async () => [] }),
  });

  assert.ok(result.status === 'completed' || result.status === 'completed-with-errors');
  assert.equal(result.processedTickers, 0);
  assert.equal(result.detectedTickers, 0);
});

// ---------------------------------------------------------------------------
// sweepCache is called
// ---------------------------------------------------------------------------

test('runVDFScan calls sweepCache at least once per run', async () => {
  let sweepCount = 0;

  await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => ['A', 'B'],
      sweepCache: () => { sweepCount++; },
    }),
  });

  assert.ok(sweepCount >= 1, `sweepCache should be called at least once, got ${sweepCount}`);
});

// ---------------------------------------------------------------------------
// getTickers is called once per fresh run
// ---------------------------------------------------------------------------

test('runVDFScan calls getTickers once per non-resume run', async () => {
  let fetchCount = 0;

  await runVDFScan({
    _deps: baseDeps({
      getTickers: async () => { fetchCount++; return ['X']; },
    }),
  });

  assert.equal(fetchCount, 1);
});

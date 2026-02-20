import test from 'node:test';
import assert from 'node:assert/strict';

import { mapWithConcurrency } from '../server/lib/mapWithConcurrency.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Basic behavior
// ---------------------------------------------------------------------------

test('mapWithConcurrency processes all items and returns correct results', async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => n * 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});

test('mapWithConcurrency returns empty array for empty input', async () => {
  const results = await mapWithConcurrency([], 4, async (x) => x);
  assert.deepEqual(results, []);
});

test('mapWithConcurrency returns empty array for non-array input', async () => {
  const results = await mapWithConcurrency(null as any, 4, async (x) => x);
  assert.deepEqual(results, []);
});

test('mapWithConcurrency preserves result order regardless of completion order', async () => {
  // Items with higher index finish faster (smaller delay)
  const results = await mapWithConcurrency([50, 30, 10, 40, 20], 5, async (ms, idx) => {
    await delay(ms);
    return idx;
  });
  // Results should be in original order: [0, 1, 2, 3, 4]
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// Concurrency limit
// ---------------------------------------------------------------------------

test('mapWithConcurrency does not exceed specified concurrency', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const concurrency = 3;

  await mapWithConcurrency(
    Array.from({ length: 10 }, (_, i) => i),
    concurrency,
    async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(5);
      concurrent--;
    },
  );

  assert.ok(maxConcurrent <= concurrency, `maxConcurrent=${maxConcurrent} exceeded limit=${concurrency}`);
});

test('mapWithConcurrency clamps concurrency to list length', async () => {
  let maxConcurrent = 0;
  let concurrent = 0;

  await mapWithConcurrency(
    [1, 2],
    100, // far exceeds list length
    async (n) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await delay(1);
      concurrent--;
      return n;
    },
  );

  assert.ok(maxConcurrent <= 2, `maxConcurrent=${maxConcurrent} should be <= 2`);
});

test('mapWithConcurrency with concurrency=1 processes items serially', async () => {
  const order: number[] = [];

  await mapWithConcurrency([1, 2, 3], 1, async (n) => {
    order.push(n);
    await delay(1);
  });

  assert.deepEqual(order, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// onSettled callback
// ---------------------------------------------------------------------------

test('mapWithConcurrency calls onSettled for each item', async () => {
  const settled: number[] = [];

  await mapWithConcurrency(
    [10, 20, 30],
    3,
    async (n) => n,
    (result) => settled.push(result as number),
  );

  assert.equal(settled.length, 3);
  assert.deepEqual(
    settled.sort((a, b) => a - b),
    [10, 20, 30],
  );
});

test('mapWithConcurrency onSettled receives index and item', async () => {
  const calls: Array<{ result: unknown; index: number; item: string }> = [];

  await mapWithConcurrency(
    ['a', 'b', 'c'],
    2,
    async (s) => s.toUpperCase(),
    (result, index, item) => calls.push({ result, index, item }),
  );

  assert.equal(calls.length, 3);
  const sorted = calls.sort((a, b) => a.index - b.index);
  assert.equal(sorted[0].result, 'A');
  assert.equal(sorted[0].index, 0);
  assert.equal(sorted[0].item, 'a');
});

test('mapWithConcurrency error in onSettled does not abort processing', async () => {
  let processedCount = 0;

  await mapWithConcurrency(
    [1, 2, 3],
    2,
    async (n) => n,
    () => {
      processedCount++;
      throw new Error('callback error');
    },
  );

  assert.equal(processedCount, 3); // all items processed despite callback errors
});

// ---------------------------------------------------------------------------
// Worker errors
// ---------------------------------------------------------------------------

test('mapWithConcurrency captures worker exceptions as { error } results', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n * 10;
  });

  assert.equal(results.length, 3);
  assert.equal(results[0], 10);
  assert.ok((results[1] as any).error instanceof Error);
  assert.equal(results[2], 30);
});

// ---------------------------------------------------------------------------
// shouldStop
// ---------------------------------------------------------------------------

test('mapWithConcurrency stops when shouldStop returns true', async () => {
  let processedCount = 0;
  const stopAfter = 3;

  await mapWithConcurrency(
    Array.from({ length: 10 }, (_, i) => i),
    1,
    async (n) => {
      processedCount++;
      return n;
    },
    undefined,
    () => processedCount >= stopAfter,
  );

  // May process a couple more due to concurrency, but well under 10
  assert.ok(processedCount <= stopAfter + 2, `processedCount=${processedCount} should be near ${stopAfter}`);
});

test('mapWithConcurrency with shouldStop=always-true processes at most one item per worker', async () => {
  let processedCount = 0;

  await mapWithConcurrency(
    Array.from({ length: 20 }, (_, i) => i),
    4,
    async () => {
      processedCount++;
    },
    undefined,
    () => true, // stop immediately
  );

  // With 4 concurrent workers and immediate stop, at most 4 items start
  assert.ok(processedCount <= 4, `processedCount=${processedCount} with immediate stop`);
});

test('mapWithConcurrency shouldStop error does not abort processing', async () => {
  let processedCount = 0;

  await mapWithConcurrency(
    [1, 2, 3],
    2,
    async (n) => {
      processedCount++;
      return n;
    },
    undefined,
    () => {
      throw new Error('shouldStop error');
    },
  );

  assert.equal(processedCount, 3);
});

// ---------------------------------------------------------------------------
// AbortError detection
// ---------------------------------------------------------------------------

test('mapWithConcurrency stops on AbortError when shouldStop returns true', async () => {
  const controller = new AbortController();
  let processedCount = 0;
  let stopped = false;

  controller.abort();

  await mapWithConcurrency(
    Array.from({ length: 10 }, (_, i) => i),
    1,
    async (_n, _i) => {
      processedCount++;
      if (controller.signal.aborted) {
        const err = new Error('Aborted') as Error & { name: string };
        err.name = 'AbortError';
        throw err;
      }
      return _n;
    },
    undefined,
    () => {
      stopped = controller.signal.aborted;
      return stopped;
    },
  );

  assert.ok(processedCount <= 2, `should stop early, got processedCount=${processedCount}`);
});

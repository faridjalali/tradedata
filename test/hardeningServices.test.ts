import test from 'node:test';
import assert from 'node:assert/strict';

import { startAlertRetentionScheduler } from '../server/services/alertRetentionService.js';
import { scheduleBreadthAutoBootstrap } from '../server/services/breadthBootstrapService.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('alert retention scheduler prunes and stops cleanly', async () => {
  let calls = 0;
  const pool = {
    async query() {
      calls += 1;
      return { rowCount: 0 };
    },
  };

  const scheduler = startAlertRetentionScheduler({
    pool,
    retentionDays: 30,
    checkIntervalMs: 20,
    initialDelayMs: 5,
  });

  await delay(35);
  assert.ok(calls >= 1, `expected at least one prune call, got ${calls}`);

  scheduler.stop();
  const callsAfterStop = calls;
  await delay(35);
  assert.equal(calls, callsAfterStop, 'scheduler should not run after stop');
});

test('breadth bootstrap schedules work and can be canceled', async () => {
  let bootstrapCalls = 0;
  const handle = scheduleBreadthAutoBootstrap({
    allIndices: ['SPX'],
    delayMs: 5,
    timeoutMs: 1000,
    getLatestBreadthSnapshots: async () => [],
    isBreadthMa200Valid: async () => false,
    bootstrapBreadthHistory: async () => {
      bootstrapCalls += 1;
    },
  });

  await delay(25);
  assert.equal(bootstrapCalls, 1);
  handle.cancel();
});

test('breadth bootstrap cancel prevents delayed execution', async () => {
  let bootstrapCalls = 0;
  const handle = scheduleBreadthAutoBootstrap({
    allIndices: ['SPX'],
    delayMs: 40,
    timeoutMs: 1000,
    getLatestBreadthSnapshots: async () => [],
    isBreadthMa200Valid: async () => false,
    bootstrapBreadthHistory: async () => {
      bootstrapCalls += 1;
    },
  });

  handle.cancel();
  await delay(60);
  assert.equal(bootstrapCalls, 0);
});

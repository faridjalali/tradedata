import test from 'node:test';
import assert from 'node:assert/strict';

import { runTradingDayPipelineForDate } from '../server/services/schedulerService.js';

test('Friday pipeline runs weekly only after daily -> analysis -> breadth -> cleanup', async () => {
  const calls: string[] = [];
  await runTradingDayPipelineForDate(
    '2026-02-20', // Friday
    {
      runFetchDaily: async () => {
        calls.push('daily');
        return { status: 'completed' };
      },
      runFetchAnalysis: async () => {
        calls.push('analysis');
        return { status: 'completed' };
      },
      runFetchBreadth: async () => {
        calls.push('breadth');
      },
      runBreadthCleanup: async () => {
        calls.push('cleanup');
      },
      runFetchWeekly: async () => {
        calls.push('weekly');
        return { status: 'completed' };
      },
    },
    { ignoreRuntimeEnabled: true, retryDelayMs: 0 },
  );

  assert.deepEqual(calls, ['daily', 'analysis', 'breadth', 'cleanup', 'weekly']);
});

test('Non-Friday pipeline skips weekly fetch', async () => {
  const calls: string[] = [];
  await runTradingDayPipelineForDate(
    '2026-02-19', // Thursday
    {
      runFetchDaily: async () => {
        calls.push('daily');
        return { status: 'completed' };
      },
      runFetchAnalysis: async () => {
        calls.push('analysis');
        return { status: 'completed' };
      },
      runFetchBreadth: async () => {
        calls.push('breadth');
      },
      runBreadthCleanup: async () => {
        calls.push('cleanup');
      },
      runFetchWeekly: async () => {
        calls.push('weekly');
        return { status: 'completed' };
      },
    },
    { ignoreRuntimeEnabled: true, retryDelayMs: 0 },
  );

  assert.deepEqual(calls, ['daily', 'analysis', 'breadth', 'cleanup']);
});

test('Pipeline retries failed step up to 2 times before continuing', async () => {
  let dailyAttempts = 0;
  const calls: string[] = [];
  await runTradingDayPipelineForDate(
    '2026-02-19', // Thursday
    {
      runFetchDaily: async () => {
        dailyAttempts += 1;
        calls.push(`daily-${dailyAttempts}`);
        if (dailyAttempts < 3) return { status: 'failed' };
        return { status: 'completed' };
      },
      runFetchAnalysis: async () => {
        calls.push('analysis');
        return { status: 'completed' };
      },
      runFetchBreadth: async () => {
        calls.push('breadth');
      },
      runBreadthCleanup: async () => {
        calls.push('cleanup');
      },
    },
    { ignoreRuntimeEnabled: true, retryDelayMs: 0 },
  );

  assert.equal(dailyAttempts, 3);
  assert.deepEqual(calls, ['daily-1', 'daily-2', 'daily-3', 'analysis', 'breadth', 'cleanup']);
});

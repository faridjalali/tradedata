import test from 'node:test';
import assert from 'node:assert/strict';

import { instrumentPool } from '../server/lib/dbMonitor.js';

test('instrumentPool wraps query with timing', async () => {
  let queryCalled = false;
  const fakePool: any = {
    query: async (_sql: any) => {
      queryCalled = true;
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };

  instrumentPool(fakePool, 'test');
  const result = await fakePool.query('SELECT 1');
  assert.ok(queryCalled);
  assert.equal(result.rowCount, 1);
});

test('instrumentPool preserves error behavior', async () => {
  const fakePool: any = {
    query: async () => {
      throw new Error('connection refused');
    },
  };

  instrumentPool(fakePool, 'test');
  await assert.rejects(() => fakePool.query('SELECT 1'), {
    message: 'connection refused',
  });
});

test('instrumentPool is a no-op for null/undefined pool', () => {
  assert.equal(instrumentPool(null as any), null);
  assert.equal(instrumentPool(undefined as any), undefined);
});

test('instrumentPool handles config object query form', async () => {
  let receivedArgs: any;
  const fakePool: any = {
    query: async (...args: any[]) => {
      receivedArgs = args;
      return { rows: [], rowCount: 0 };
    },
  };

  instrumentPool(fakePool, 'test');
  const config = { text: 'SELECT $1', values: [42] };
  await fakePool.query(config);
  assert.deepEqual(receivedArgs, [config]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worker = require('../feature-packages/create-associate/source/middle/worker.cjs') as {
  createFifoOperationLimiter: (limit: number) => <T>(operation: () => Promise<T>) => Promise<T>;
};

test('Create Return remote Operation budget is FIFO, bounded, and releases permits after failure', async () => {
  const limit = worker.createFifoOperationLimiter(3);
  let active = 0;
  let maximumActive = 0;
  const started: number[] = [];
  const releases = Array.from({length: 9}, () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return {promise, release};
  });
  const tasks = releases.map((entry, index) => limit(async () => {
    started.push(index);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await entry.promise;
    active -= 1;
    if (index === 4) throw new Error('fixture failure');
    return index;
  }));
  const settledPromise = Promise.allSettled(tasks);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  for (let index = 0; index < releases.length; index += 1) {
    releases[index]!.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const settled = await settledPromise;
  assert.equal(maximumActive, 3);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(active, 0);

  assert.equal(await limit(async () => 10), 10);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimit } from '../src/pool.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('results keep the order of the items, whatever order the calls finish in', async () => {
  const delays = [40, 5, 30, 1, 20, 10, 2, 25];
  assert.deepEqual(await mapLimit(delays, 3, async (ms) => { await sleep(ms); return ms; }), delays);
});

test('never more than limit calls at once, and the limit is used', async () => {
  for (const limit of [1, 2, 4]) {
    let running = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), limit, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
    });
    assert.equal(peak, limit, `limit ${limit}`);
  }
});

test('edge cases', async () => {
  assert.deepEqual(await mapLimit([], 3, async (n) => n), []);
  assert.deepEqual(await mapLimit([1, 2], 10, async (n) => n + 1), [2, 3]);
  await assert.rejects(mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }), /boom/);
});

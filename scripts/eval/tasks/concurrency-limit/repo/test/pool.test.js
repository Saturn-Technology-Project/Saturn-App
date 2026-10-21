import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimit } from '../src/pool.js';

test('doubles numbers', async () => {
  assert.deepEqual(await mapLimit([1, 2, 3], 2, async (n) => n * 2), [2, 4, 6]);
});

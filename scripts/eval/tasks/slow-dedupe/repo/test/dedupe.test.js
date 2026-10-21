import assert from 'node:assert/strict';
import test from 'node:test';
import { uniqueBy } from '../src/dedupe.js';

test('keeps the first of each key', () => {
  const rows = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 1, v: 'c' }];
  assert.deepEqual(uniqueBy(rows, (row) => row.id), [{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
});

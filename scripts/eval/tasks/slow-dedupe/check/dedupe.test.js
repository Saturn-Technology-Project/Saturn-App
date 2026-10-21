import assert from 'node:assert/strict';
import test from 'node:test';
import { uniqueBy } from '../src/dedupe.js';

test('same results as before', () => {
  const rows = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 1, v: 'c' }, { id: '1', v: 'd' }, { id: 3, v: 'e' }, { id: 2, v: 'f' }];
  assert.deepEqual(uniqueBy(rows, (row) => row.id).map((row) => row.v), ['a', 'b', 'd', 'e'], 'keys compare strictly: 1 and "1" differ');
  assert.deepEqual(uniqueBy([], (x) => x), []);
  const words = ['b', 'a', 'B', 'c', 'A'];
  assert.deepEqual(uniqueBy(words, (w) => w.toLowerCase()), ['b', 'a', 'c']);
});

test('200,000 rows in well under two seconds', () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => ({ id: `u${i % 100_000}`, i }));
  const started = performance.now();
  const out = uniqueBy(rows, (row) => row.id);
  const took = performance.now() - started;
  assert.equal(out.length, 100_000);
  assert.equal(out[99_999].i, 99_999);
  assert.ok(took < 2000, `took ${Math.round(took)} ms`);
});

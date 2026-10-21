import assert from 'node:assert/strict';
import test from 'node:test';
import { pages } from '../src/pages.js';

test('a partial last page counts', () => {
  assert.deepEqual(pages(10, 3), [1, 2, 3, 4]);
  assert.deepEqual(pages(9, 3), [1, 2, 3]);
  assert.deepEqual(pages(0, 3), []);
});

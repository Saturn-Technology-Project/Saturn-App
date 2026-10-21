import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from '../src/cli.js';

test('plain output', () => {
  assert.equal(run([], 'a b\nc'), 'lines 2\nwords 3\nchars 5');
});

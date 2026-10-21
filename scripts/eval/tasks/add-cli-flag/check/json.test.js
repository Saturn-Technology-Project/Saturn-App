import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from '../src/cli.js';

test('--json prints one object', () => {
  assert.deepEqual(JSON.parse(run(['--json'], 'a b\nc')), { lines: 2, words: 3, chars: 5 });
  assert.equal(run([], 'x'), 'lines 1\nwords 1\nchars 1');
});

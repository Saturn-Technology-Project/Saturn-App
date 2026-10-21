import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, parseConfig } from '../src/config.js';

test('config parsing', () => {
  assert.deepEqual(parseConfig('{"port": 8080}'), { port: 8080, verbose: false });
  assert.deepEqual(parseConfig('not json'), DEFAULTS);
  assert.deepEqual(parseConfig('[1, 2]'), DEFAULTS);
  assert.deepEqual(parseConfig('null'), DEFAULTS);
  assert.deepEqual(parseConfig(''), DEFAULTS);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('cache.js is unchanged', () => {
  const text = readFileSync(new URL('../src/cache.js', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex').slice(0, 12), '87d904ef1708');
});

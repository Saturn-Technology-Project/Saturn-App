import assert from 'node:assert/strict';
import test from 'node:test';
import { slugify } from '../src/slug.js';

test('slugs', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Many   spaces  '), 'many-spaces');
  assert.equal(slugify('Crème brûlée'), 'creme-brulee');
  assert.equal(slugify('---'), '');
});

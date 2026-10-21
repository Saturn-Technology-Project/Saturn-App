import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { profile } from '../src/profile.js';
import * as users from '../src/users.js';

test('loadUser replaces fetchUser', () => {
  assert.equal(typeof users.loadUser, 'function');
  assert.equal(users.fetchUser, undefined);
  assert.equal(profile(7), 'user 7 (#7)');
  for (const file of ['src/users.js', 'src/profile.js']) assert.ok(!readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes('fetchUser'), file);
});

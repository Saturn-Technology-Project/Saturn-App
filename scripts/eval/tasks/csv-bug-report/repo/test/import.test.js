import assert from 'node:assert/strict';
import test from 'node:test';
import { importContacts } from '../src/import.js';

test('simple rows', () => {
  assert.deepEqual(importContacts('name,email,note\nAmy,amy@example.com,friend\n'), [{ name: 'Amy', email: 'amy@example.com', note: 'friend' }]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { header } from '../src/report.js';

test('early morning and late evening stay on the local date', () => {
  assert.equal(header(new Date(2026, 9, 21, 7, 30)), 'Daily report: 2026-10-21 (Wednesday)');
  assert.equal(header(new Date(2026, 9, 21, 23, 45)), 'Daily report: 2026-10-21 (Wednesday)');
  assert.equal(header(new Date(2026, 0, 1, 0, 5)), 'Daily report: 2026-01-01 (Thursday)');
  assert.equal(header(new Date(2026, 11, 31, 23, 55)), 'Daily report: 2026-12-31 (Thursday)');
});

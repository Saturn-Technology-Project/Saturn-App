import assert from 'node:assert/strict';
import test from 'node:test';
import { header } from '../src/report.js';

test('a midday header', () => {
  assert.match(header(new Date(2026, 9, 21, 12, 0)), /^Daily report: 2026-10-21 \(Wednesday\)$/);
});

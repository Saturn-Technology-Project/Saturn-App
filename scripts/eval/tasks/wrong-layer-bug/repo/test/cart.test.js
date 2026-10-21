import assert from 'node:assert/strict';
import test from 'node:test';
import { summary, total } from '../src/cart.js';

test('three items at $0.29', () => {
  assert.equal(total([{ price: 0.29, qty: 3 }]), 87);
});

test('summary', () => {
  assert.equal(summary([{ price: 1.5, qty: 2 }]), '1 item(s), $3.00');
});

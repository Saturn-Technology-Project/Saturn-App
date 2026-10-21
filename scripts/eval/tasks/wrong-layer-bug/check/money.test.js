import assert from 'node:assert/strict';
import test from 'node:test';
import { total } from '../src/cart.js';
import { lines, render } from '../src/invoice.js';
import { formatCents, toCents } from '../src/money.js';

test('dollars become the nearest whole cents', () => {
  assert.equal(toCents(0.29), 29);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(4.35), 435);
  assert.equal(toCents(2), 200);
});

test('the cart and the invoice both get it right', () => {
  assert.equal(total([{ price: 0.29, qty: 3 }]), 87);
  assert.equal(lines([{ name: 'Book', price: 19.99, qty: 1 }])[0].cents, 1999);
  assert.equal(render([{ name: 'Pen', price: 0.57, qty: 2 }]), 'Pen x2  $1.14');
});

test('formatting is unchanged', () => {
  assert.equal(formatCents(1999), '$19.99');
  assert.equal(formatCents(-5), '-$0.05');
});

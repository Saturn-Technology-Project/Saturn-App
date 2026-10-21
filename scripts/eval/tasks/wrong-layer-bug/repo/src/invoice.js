import { formatCents, toCents } from './money.js';

/** Invoice lines: description, quantity and the line total in cents. */
export function lines(items) {
  return items.map((item) => ({ description: item.name, qty: item.qty, cents: toCents(item.price) * item.qty }));
}

export function render(items) {
  return lines(items).map((line) => `${line.description} x${line.qty}  ${formatCents(line.cents)}`).join('\n');
}

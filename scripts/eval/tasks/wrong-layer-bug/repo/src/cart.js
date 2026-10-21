import { formatCents, toCents } from './money.js';

/** The cart's total in cents: each item's price (dollars) times its quantity. */
export function total(items) {
  return items.reduce((sum, item) => sum + toCents(item.price) * item.qty, 0);
}

export function summary(items) {
  return `${items.length} item(s), ${formatCents(total(items))}`;
}

/** Dollars (a number like 19.99) to whole cents. */
export function toCents(amount) {
  return Math.floor(amount * 100);
}

/** Whole cents to a display string: 1999 → "$19.99". */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

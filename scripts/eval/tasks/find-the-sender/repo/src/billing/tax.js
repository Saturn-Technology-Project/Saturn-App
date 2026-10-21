export function withTax(cents, rate) {
  return Math.round(cents * (1 + rate));
}

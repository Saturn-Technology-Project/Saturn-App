export const PLANS = { free: 0, pro: 1200, team: 4800 };

export function priceOf(plan) {
  return PLANS[plan] ?? null;
}

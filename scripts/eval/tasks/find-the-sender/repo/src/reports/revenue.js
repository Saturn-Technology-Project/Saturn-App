import { PLANS } from '../billing/plans.js';

export function monthly(subscriptions) {
  return subscriptions.reduce((sum, sub) => sum + (PLANS[sub.plan] ?? 0), 0);
}

import { auditEntries } from '../audit/log.js';

export function removedThisWeek(now = Date.now()) {
  return auditEntries().filter((entry) => entry.action === 'user removed' && now - entry.at < 7 * 86_400_000).length;
}

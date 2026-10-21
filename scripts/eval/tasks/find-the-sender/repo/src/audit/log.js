const entries = [];

export function audit(action, subject) {
  entries.push({ at: Date.now(), action, subject });
}

export function auditEntries() {
  return entries.slice();
}

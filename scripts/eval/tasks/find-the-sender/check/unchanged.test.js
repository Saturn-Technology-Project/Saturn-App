import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FILES = ["docs/notifications.md", "src/api/routes.js", "src/api/server.js", "src/audit/log.js", "src/billing/invoices.js", "src/billing/plans.js", "src/billing/tax.js", "src/events/bus.js", "src/events/names.js", "src/legacy/README.md", "src/legacy/mail.js", "src/mail/mailer.js", "src/mail/templates.js", "src/main.js", "src/notifications/handlers/farewell.js", "src/notifications/handlers/overdue.js", "src/notifications/handlers/removed.js", "src/notifications/handlers/welcome.js", "src/notifications/index.js", "src/reports/revenue.js", "src/reports/users.js", "src/users/create.js", "src/users/delete.js", "src/users/store.js", "src/users/update.js", "src/util/ids.js", "src/util/strings.js", "src/util/time.js"];

test('no file was changed', () => {
  const digest = createHash('sha256');
  for (const rel of FILES) digest.update(rel + '\0' + readFileSync(new URL('../' + rel, import.meta.url), 'utf8') + '\0');
  assert.equal(digest.digest('hex'), '52d3fda31ae0a04eeafedfe8ec080f16c2ac14f35501abc4055c85256b422503');
});

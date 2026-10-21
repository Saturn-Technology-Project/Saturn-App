// Deprecated: the old notification module, kept for reference while v1 clients migrate. Nothing imports it.
import { mailer } from '../mail/mailer.js';

export function sendGoodbye(user) {
  return mailer.send({ to: user.email, template: 'account-closed', data: { name: user.name } });
}

export function sendHello(user) {
  return mailer.send({ to: user.email, template: 'welcome', data: user });
}

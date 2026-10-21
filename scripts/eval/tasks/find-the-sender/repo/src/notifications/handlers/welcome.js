import { mailer } from '../../mail/mailer.js';

export function sendWelcome(user) {
  return mailer.send({ to: user.email, template: 'welcome', data: { name: user.name } });
}

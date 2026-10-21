import { mailer } from '../../mail/mailer.js';

export function sendFarewell(user) {
  return mailer.send({ to: user.email, template: 'account-closed', data: { name: user.name } });
}

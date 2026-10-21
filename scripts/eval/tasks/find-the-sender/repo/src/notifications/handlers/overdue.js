import { mailer } from '../../mail/mailer.js';

export function remindOverdue(invoice) {
  return mailer.send({ to: invoice.email, template: 'invoice-overdue', data: invoice });
}

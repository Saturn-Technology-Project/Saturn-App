import { bus } from '../events/bus.js';
import { onUserRemoved } from './handlers/removed.js';
import { sendWelcome } from './handlers/welcome.js';
import { remindOverdue } from './handlers/overdue.js';

/** Wires notification handlers to app events. */
export function startNotifications() {
  bus.on('user.created', ({ user }) => sendWelcome(user));
  bus.on('user.removed', onUserRemoved);
  bus.on('invoice.overdue', ({ invoice }) => remindOverdue(invoice));
}

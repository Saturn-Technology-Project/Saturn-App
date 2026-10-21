import { bus } from '../events/bus.js';

export function markOverdue(invoice) {
  invoice.status = 'overdue';
  bus.emit('invoice.overdue', { invoice });
}

export function markPaid(invoice) {
  invoice.status = 'paid';
  bus.emit('invoice.paid', { invoice });
}

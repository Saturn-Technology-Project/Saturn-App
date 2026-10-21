import { bus } from '../events/bus.js';
import { users } from './store.js';

export function createUser(input) {
  const user = users.add({ id: input.id, email: input.email, name: input.name });
  bus.emit('user.created', { user });
  return user;
}

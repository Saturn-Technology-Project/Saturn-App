import { bus } from '../events/bus.js';
import { users } from './store.js';

/** Deletes a user and tells the rest of the app. */
export function deleteUser(id) {
  const user = users.remove(id);
  if (user) bus.emit('user.removed', { user });
  return Boolean(user);
}

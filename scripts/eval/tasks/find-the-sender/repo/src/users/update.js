import { users } from './store.js';

export function renameUser(id, name) {
  const user = users.get(id);
  if (user) user.name = name;
  return user;
}

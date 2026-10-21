import { fetchUser } from './users.js';

export function profile(id) {
  const user = fetchUser(id);
  return `${user.name} (#${user.id})`;
}

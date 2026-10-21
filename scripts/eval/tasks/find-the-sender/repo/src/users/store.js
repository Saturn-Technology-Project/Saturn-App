const rows = new Map();

export const users = {
  add(user) { rows.set(user.id, user); return user; },
  get(id) { return rows.get(id); },
  remove(id) { const user = rows.get(id); rows.delete(id); return user; },
};

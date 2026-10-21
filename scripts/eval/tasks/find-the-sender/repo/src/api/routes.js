import { createUser } from '../users/create.js';
import { deleteUser } from '../users/delete.js';
import { renameUser } from '../users/update.js';

export const routes = {
  'POST /users': (body) => createUser(body),
  'DELETE /users/:id': (params) => deleteUser(params.id),
  'PATCH /users/:id': (params, body) => renameUser(params.id, body.name),
};

import { audit } from '../../audit/log.js';
import { sendFarewell } from './farewell.js';

export function onUserRemoved({ user }) {
  audit('user removed', user.id);
  if (user.email) sendFarewell(user);
}

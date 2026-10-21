import { render } from './templates.js';

const outbox = [];

export const mailer = {
  send(message) { outbox.push({ ...message, body: render(message.template, message.data) }); return outbox.length; },
  outbox,
};

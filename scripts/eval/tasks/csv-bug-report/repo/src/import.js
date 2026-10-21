import { parse } from './csv.js';

function toContact(row) {
  return { name: row[0].trim(), email: row[1].trim(), note: (row[2] ?? '').trim() };
}

/** Contacts from CSV text with a header row (name,email,note). */
export function importContacts(text) {
  return parse(text).slice(1).map(toContact);
}

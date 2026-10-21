import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** The todo file: { version: 1, todos: [{ title, done }] }. A missing file is an empty list. */
export function load(file) {
  if (!existsSync(file)) return { version: 1, todos: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function save(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

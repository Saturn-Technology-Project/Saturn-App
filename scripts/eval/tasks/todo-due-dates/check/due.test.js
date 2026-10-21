import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/cli.js';
import { load } from '../src/store.js';

const fresh = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'todo-check-')), 'todos.json');

test('a file from the current version still loads and lists', () => {
  const file = fresh();
  writeFileSync(file, JSON.stringify({ version: 1, todos: [{ title: 'Old one', done: true }, { title: 'Other', done: false }] }));
  assert.equal(run(['list'], file), '1. [x] Old one\n2. [ ] Other');
  run(['add', 'New', '--due', '2026-11-01'], file);
  assert.equal(run(['list'], file), '3. [ ] New (due 2026-11-01)\n1. [x] Old one\n2. [ ] Other');
});

test('dated todos first, earliest first; undated keep their order; numbers are file positions', () => {
  const file = fresh();
  run(['add', 'A'], file);
  run(['add', 'B', 'later', '--due', '2026-12-01'], file);
  run(['add', 'C', '--due', '2026-11-01'], file);
  run(['add', 'D'], file);
  assert.equal(run(['list'], file), '3. [ ] C (due 2026-11-01)\n2. [ ] B later (due 2026-12-01)\n1. [ ] A\n4. [ ] D');
  run(['done', '2'], file);
  assert.match(run(['list'], file), /2\. \[x\] B later \(due 2026-12-01\)/);
  assert.equal(load(file).todos[1].title, 'B later', 'the title has no --due in it');
});

test('an invalid date is refused and nothing is added', () => {
  const file = fresh();
  for (const bad of ['2026-13-01', '2026-02-30', 'tomorrow', '2026-1-5']) {
    assert.throws(() => run(['add', 'X', '--due', bad], file), /date/i, bad);
  }
  assert.equal(run(['list'], file), '');
});

test('the old commands still work', () => {
  const file = fresh();
  run(['add', 'Buy', 'milk'], file);
  run(['done', '1'], file);
  assert.equal(run(['list'], file), '1. [x] Buy milk');
  assert.throws(() => run(['add'], file), /title/);
});

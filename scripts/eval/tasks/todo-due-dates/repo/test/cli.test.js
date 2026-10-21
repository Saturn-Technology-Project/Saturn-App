import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/cli.js';

test('add, done and list', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json');
  run(['add', 'Buy', 'milk'], file);
  run(['add', 'Call', 'Sam'], file);
  run(['done', '1'], file);
  assert.equal(run(['list'], file), '1. [x] Buy milk\n2. [ ] Call Sam');
});

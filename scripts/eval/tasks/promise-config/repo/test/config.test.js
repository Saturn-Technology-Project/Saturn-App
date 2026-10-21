import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.js';

test('callback with defaults', (_, done) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'c.json');
  writeFileSync(file, '{"port": 9000}');
  readConfig(file, (error, config) => {
    assert.equal(error, null);
    assert.deepEqual(config, { host: 'localhost', port: 9000, debug: false });
    done();
  });
});

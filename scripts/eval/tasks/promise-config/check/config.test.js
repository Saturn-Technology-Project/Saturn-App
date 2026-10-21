import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cfg-check-'));
const good = path.join(dir, 'good.json');
const broken = path.join(dir, 'broken.json');
writeFileSync(good, '{"host": "example.com", "debug": true}');
writeFileSync(broken, '{"host": ');

test('without a callback: a promise of the config', async () => {
  const pending = readConfig(good);
  assert.equal(typeof pending?.then, 'function');
  assert.deepEqual(await pending, { host: 'example.com', port: 8080, debug: true });
  await assert.rejects(readConfig(path.join(dir, 'missing.json')), (error) => error.code === 'ENOENT');
  await assert.rejects(readConfig(broken), SyntaxError);
});

test('with a callback: as before, once and asynchronously, errors passed not thrown', async () => {
  const calls = [];
  let sync = true;
  const result = readConfig(path.join(dir, 'missing.json'), (...args) => calls.push({ args, sync }));
  sync = false;
  assert.equal(result, undefined, 'the callback form returns nothing');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sync, false);
  assert.equal(calls[0].args[0].code, 'ENOENT');

  const parsed = await new Promise((resolve) => readConfig(broken, (error) => resolve(error)));
  assert.ok(parsed instanceof SyntaxError);
  const config = await new Promise((resolve, reject) => readConfig(good, (error, value) => (error ? reject(error) : resolve(value))));
  assert.deepEqual(config, { host: 'example.com', port: 8080, debug: true });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from '../src/csv.js';
import { importContacts } from '../src/import.js';

test('the file from the report', () => {
  const text = 'name,email,note\n"Smith, Jane",jane@example.com,"Said ""hi"""\nBob,bob@example.com,"Line one\nline two"\n';
  assert.deepEqual(importContacts(text), [
    { name: 'Smith, Jane', email: 'jane@example.com', note: 'Said "hi"' },
    { name: 'Bob', email: 'bob@example.com', note: 'Line one\nline two' },
  ]);
});

test('CSV details', () => {
  assert.deepEqual(parse('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']], 'CRLF line ends');
  assert.deepEqual(parse('a,,c\n'), [['a', '', 'c']], 'empty field');
  assert.deepEqual(parse('x,"",y'), [['x', '', 'y']], 'empty quoted field, no final newline');
  assert.deepEqual(parse('"a""b",c\n'), [['a"b', 'c']]);
  assert.deepEqual(parse('one\n\ntwo\n'), [['one'], ['two']], 'blank lines skipped');
});

test('a row without a note still imports', () => {
  assert.deepEqual(importContacts('name,email\nAmy,amy@example.com\n'), [{ name: 'Amy', email: 'amy@example.com', note: '' }]);
});

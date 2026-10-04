'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionManager } = require('../src/core/sessions');

function mgr() {
  return new SessionManager(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-sess-')));
}

test('unique ids, summaries and hidden empty sessions', () => {
  const m = mgr();
  const a = m.create('a');
  const b = m.create('b');
  assert.notStrictEqual(a.id, b.id);
  m.addEntry('user', '  hello   world  ');
  m.addEntry('assistant', 'hi');
  const all = m.list();
  assert.strictEqual(all.length, 2);
  const nonEmpty = m.list({ includeEmpty: false });
  assert.strictEqual(nonEmpty.length, 1);
  assert.strictEqual(nonEmpty[0].title, 'hello world');
  assert.strictEqual(nonEmpty[0].count, 2);
});

test('path traversal ids are rejected and corrupted files skipped', () => {
  const m = mgr();
  assert.strictEqual(m.load('../../etc/passwd'), null);
  assert.strictEqual(m.delete('../x'), false);
  fs.writeFileSync(path.join(m.basePath, 'broken.json'), '{nope');
  assert.doesNotThrow(() => m.list());
  assert.strictEqual(m.load('broken'), null);
});

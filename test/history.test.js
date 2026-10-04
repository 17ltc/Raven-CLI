'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileHistory } = require('../src/file_history');
const { FileTools } = require('../src/file_tools');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rv-hist-'));
}

test('tracks create/edit, undoes and redoes a whole turn', () => {
  const dir = tmp();
  const h = new FileHistory();
  const f = path.join(dir, 'a.txt');
  h.beginTurn();

  h.begin();
  h.capture(f);
  fs.writeFileSync(f, 'one\n');
  const c1 = h.end();
  assert.strictEqual(c1.length, 1);
  assert.strictEqual(c1[0].before, null);

  h.begin();
  h.capture(f);
  fs.writeFileSync(f, 'two\n');
  h.end();
  const g = path.join(dir, 'sub', 'b.txt');
  h.begin();
  h.capture(g);
  fs.mkdirSync(path.dirname(g));
  fs.writeFileSync(g, 'bee');
  h.end();

  const entry = h.commitTurn('test');
  assert.strictEqual(entry.changes.length, 2);

  assert.strictEqual(h.undo().status, 'ok');
  assert.ok(!fs.existsSync(f) && !fs.existsSync(g));
  assert.strictEqual(h.redo().status, 'ok');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'two\n'); // merged: first before, last after
  assert.strictEqual(fs.readFileSync(g, 'utf8'), 'bee');
});

test('undo refuses (atomically) when a file changed afterwards, force overrides', () => {
  const dir = tmp();
  const h = new FileHistory();
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'orig');
  h.beginTurn();
  h.begin();
  h.capture(f);
  fs.writeFileSync(f, 'ai edit');
  h.end();
  h.commitTurn('edit');
  fs.writeFileSync(f, 'user edit');
  const r = h.undo();
  assert.strictEqual(r.status, 'conflict');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'user edit');
  assert.strictEqual(h.undo(true).status, 'ok');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'orig');
});

test('FileTools.writeFile is captured through the global history', () => {
  const { fileHistory } = require('../src/file_history');
  const dir = tmp();
  const ft = new FileTools(dir);
  fileHistory.beginTurn();
  fileHistory.begin();
  ft.writeFile('x.txt', 'hello');
  const changes = fileHistory.end();
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(fileHistory.commitTurn('w').changes[0].before, null);
  assert.strictEqual(fileHistory.undo().status, 'ok');
  assert.ok(!fs.existsSync(path.join(dir, 'x.txt')));
});
